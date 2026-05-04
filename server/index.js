const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createDmxEngine } = require("./dmx");
const { createProgramService } = require("./programs");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const ARTNET_HOST_INPUT = process.env.ARTNET_HOST || "192.168.88.150";
const ARTNET_PORT = Number(process.env.ARTNET_PORT || 6454);
const ARTNET_IFACE = process.env.ARTNET_IFACE || "";
const FPS = Number(process.env.DMX_FPS || 40);

function normalizeIpv4(input) {
  if (typeof input !== "string") return input;
  const parts = input.split(".");
  if (parts.length !== 4) return input;

  const normalized = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return input;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return input;
    normalized.push(String(value));
  }
  return normalized.join(".");
}

const ARTNET_HOST = normalizeIpv4(ARTNET_HOST_INPUT);

function loadFixtures() {
  const filePath = path.join(__dirname, "..", "config", "fixtures.json");
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

const fixtures = loadFixtures();
const programsFilePath = path.join(__dirname, "..", "config", "programs.json");
const dmx = createDmxEngine({
  artnetHost: ARTNET_HOST,
  artnetPort: ARTNET_PORT,
  artnetIface: ARTNET_IFACE || undefined,
  frameRate: FPS,
  fixtures
});
let programs = null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

function emitState() {
  io.emit("state:update", {
    ...dmx.getState(),
    programs: programs ? programs.getState() : undefined
  });
}

programs = createProgramService({
  filePath: programsFilePath,
  fixtures,
  dmx,
  onStateChange: emitState
});

app.use("/public", express.static(path.join(__dirname, "..", "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/view", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

io.use((socket, next) => {
  const mode = socket.handshake.auth && socket.handshake.auth.mode;
  socket.data.readOnly = mode === "view";
  return next();
});

io.on("connection", (socket) => {
  socket.emit("state:init", {
    ...dmx.getState(),
    programs: programs.getState(),
    readOnly: socket.data.readOnly
  });

  socket.on("channel:set", (payload) => {
    if (socket.data.readOnly) return;
    if (!payload || typeof payload.fixtureId !== "string") return;
    programs.stopChase();
    programs.stopPulse();

    const ok = dmx.setChannel({
      fixtureId: payload.fixtureId,
      channelIndex: Number(payload.channelIndex),
      value: Number(payload.value)
    });
    if (!ok) return;
    emitState();
  });

  socket.on("master:set", (value) => {
    if (socket.data.readOnly) return;
    programs.stopChase();
    programs.stopPulse();
    dmx.setMaster(Number(value));
    emitState();
  });

  socket.on("scene:blackout", () => {
    if (socket.data.readOnly) return;
    programs.stopChase();
    programs.stopPulse();
    dmx.blackout();
    emitState();
  });

  socket.on("scene:reset", () => {
    if (socket.data.readOnly) return;
    programs.stopChase();
    programs.stopPulse();
    dmx.resetAll();
    emitState();
  });

  socket.on("program:sceneSave", (payload) => {
    if (socket.data.readOnly) return;
    programs.saveScene({ name: payload && payload.name });
    emitState();
  });

  socket.on("program:sceneApply", (payload) => {
    if (socket.data.readOnly) return;
    if (!payload || typeof payload.sceneId !== "string") return;
    const ok = programs.applyScene({ sceneId: payload.sceneId });
    if (!ok) return;
    emitState();
  });

  socket.on("program:sceneDelete", (payload) => {
    if (socket.data.readOnly) return;
    if (!payload || typeof payload.sceneId !== "string") return;
    const ok = programs.deleteScene({ sceneId: payload.sceneId });
    if (!ok) return;
    emitState();
  });

  socket.on("program:chaseSave", (payload) => {
    if (socket.data.readOnly) return;
    if (!payload || !Array.isArray(payload.sceneIds)) return;
    programs.saveChase({
      name: payload.name,
      sceneIds: payload.sceneIds,
      durationMs: payload.durationMs
    });
    emitState();
  });

  socket.on("program:chaseStart", (payload) => {
    if (socket.data.readOnly) return;
    if (!payload || typeof payload.chaseId !== "string") return;
    const ok = programs.startChase({ chaseId: payload.chaseId });
    if (!ok) return;
    emitState();
  });

  socket.on("program:chaseStop", () => {
    if (socket.data.readOnly) return;
    programs.stopChase();
    emitState();
  });

  socket.on("program:chaseDelete", (payload) => {
    if (socket.data.readOnly) return;
    if (!payload || typeof payload.chaseId !== "string") return;
    const ok = programs.deleteChase({ chaseId: payload.chaseId });
    if (!ok) return;
    emitState();
  });

  socket.on("program:macroApply", (payload) => {
    if (socket.data.readOnly) return;
    if (!payload || typeof payload.macroId !== "string") return;
    const ok = programs.applyMacro({ macroId: payload.macroId });
    if (!ok) return;
    emitState();
  });

  socket.on("program:washColorSet", (payload) => {
    if (socket.data.readOnly) return;
    if (!payload || typeof payload !== "object") return;
    programs.stopChase();
    programs.setWashColor(payload);
    emitState();
  });

  socket.on("program:pulseSpeedSet", (payload) => {
    if (socket.data.readOnly) return;
    if (!payload || typeof payload.speedMs !== "number") return;
    programs.stopChase();
    programs.setPulseSpeed(payload.speedMs);
    emitState();
  });

  socket.on("program:pulseStart", () => {
    if (socket.data.readOnly) return;
    programs.stopChase();
    programs.startPulse({});
    emitState();
  });

  socket.on("program:pulseStop", () => {
    if (socket.data.readOnly) return;
    programs.stopPulse();
    emitState();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`WebDMX running on http://${HOST}:${PORT}`);
  console.log(`Art-Net target ${ARTNET_HOST}:${ARTNET_PORT}`);
  if (ARTNET_IFACE) {
    console.log(`Art-Net iface ${ARTNET_IFACE}`);
  }
  if (ARTNET_HOST_INPUT !== ARTNET_HOST) {
    console.log(`Art-Net host normalized from ${ARTNET_HOST_INPUT} to ${ARTNET_HOST}`);
  }
});

process.on("SIGINT", () => {
  dmx.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  dmx.close();
  process.exit(0);
});
