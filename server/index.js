const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createDmxEngine } = require("./dmx");
const { createProgramService } = require("./programs");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PASSCODE = process.env.WEBDMX_PASSCODE || "webdmx";
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

function parseCookieHeader(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(";").forEach((pair) => {
    const index = pair.indexOf("=");
    if (index === -1) return;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    out[key] = decodeURIComponent(value);
  });
  return out;
}

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

const sessions = new Set();
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

app.use(express.urlencoded({ extended: false }));
app.use("/public", express.static(path.join(__dirname, "..", "public")));

function requireLogin(req, res, next) {
  const cookies = parseCookieHeader(req.headers.cookie || "");
  if (cookies.webdmx_session && sessions.has(cookies.webdmx_session)) {
    return next();
  }
  return res.redirect("/login");
}

app.get("/", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/view", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/login", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CuteLight Login</title>
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap");
      body { font-family: Arial, sans-serif; background: #111; color: #f5f5f5; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0; }
      .card { width: min(92vw, 420px); background:#1d1d1d; border:1px solid #333; border-radius:12px; padding:20px; }
      h2 { font-family: "Press Start 2P", cursive; font-size: 16px; line-height: 1.35; margin: 0 0 16px; }
      input, button { width:100%; padding:12px; font-size:16px; border-radius:10px; border:1px solid #444; margin-top:10px; box-sizing:border-box; }
      button { background:#5b7fff; color:white; border:none; font-weight:600; }
      .hint { font-size:13px; color:#bdbdbd; margin-top:12px; }
    </style>
  </head>
  <body>
    <form class="card" method="post" action="/login">
      <h2>CuteLight Control</h2>
      <label for="code">Passcode</label>
      <input id="code" name="code" type="password" required autofocus />
      <button type="submit">Enter</button>
      <div class="hint">Anyone on venue Wi-Fi with this passcode can control lights.</div>
    </form>
  </body>
</html>`);
});

app.post("/login", (req, res) => {
  if (req.body.code !== PASSCODE) {
    return res.status(401).send("Wrong passcode. <a href=\"/login\">Try again</a>");
  }

  const token = crypto.randomBytes(24).toString("hex");
  sessions.add(token);
  res.setHeader("Set-Cookie", `webdmx_session=${token}; HttpOnly; SameSite=Lax; Path=/`);
  return res.redirect("/");
});

app.get("/logout", (req, res) => {
  const cookies = parseCookieHeader(req.headers.cookie || "");
  if (cookies.webdmx_session) sessions.delete(cookies.webdmx_session);
  res.setHeader("Set-Cookie", "webdmx_session=; Max-Age=0; Path=/");
  res.redirect("/login");
});

io.use((socket, next) => {
  const mode = socket.handshake.auth && socket.handshake.auth.mode;
  if (mode === "view") {
    socket.data.readOnly = true;
    return next();
  }

  const cookies = parseCookieHeader(socket.handshake.headers.cookie || "");
  if (!cookies.webdmx_session || !sessions.has(cookies.webdmx_session)) {
    return next(new Error("unauthorized"));
  }

  socket.data.readOnly = false;
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
    dmx.setMaster(Number(value));
    emitState();
  });

  socket.on("scene:blackout", () => {
    if (socket.data.readOnly) return;
    programs.stopChase();
    dmx.blackout();
    emitState();
  });

  socket.on("scene:reset", () => {
    if (socket.data.readOnly) return;
    programs.stopChase();
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
