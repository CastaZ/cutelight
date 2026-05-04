const fs = require("fs");

function clampByte(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num < 0) return 0;
  if (num > 255) return 255;
  return Math.round(num);
}

function sanitizeName(name, fallback) {
  const text = typeof name === "string" ? name.trim() : "";
  if (!text) return fallback;
  return text.slice(0, 60);
}

function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
}

function createDefaultPrograms() {
  return {
    scenes: [],
    chases: [],
    washColor: {
      dimmer: 255,
      red: 255,
      green: 255,
      blue: 255,
      lime: 0,
      amber: 0,
      uv: 0
    },
    pulse: {
      active: false,
      speedMs: 900
    },
    macros: [
      {
        id: "macro_warm_wash",
        name: "Warm Wash",
        type: "washColor",
        targetType: "rgbaluv11",
        params: { dimmer: 255, red: 200, green: 120, blue: 30, lime: 0, amber: 180, uv: 0 }
      },
      {
        id: "macro_uv_pulse",
        name: "UV Pulse",
        type: "washColor",
        targetType: "rgbaluv11",
        params: { dimmer: 255, red: 0, green: 0, blue: 40, lime: 0, amber: 0, uv: 220, strobe: 170 }
      },
      {
        id: "macro_red_blue",
        name: "Red/Blue",
        type: "washSplit",
        targetType: "rgbaluv11",
        params: {
          first: { dimmer: 255, red: 255, green: 0, blue: 0, lime: 0, amber: 0, uv: 0 },
          second: { dimmer: 255, red: 0, green: 0, blue: 255, lime: 0, amber: 0, uv: 0 }
        }
      },
      {
        id: "macro_pulse",
        name: "Pulse",
        type: "washPulse",
        targetType: "rgbaluv11"
      },
      {
        id: "macro_gobo_sweep",
        name: "Gobo Sweep",
        type: "goboMovement",
        targetType: "gobo12",
        params: { dimmer: 255, color: 96, gobo: 128, movementMacro: 96, movementSpeed: 90 }
      }
    ]
  };
}

function normalizePrograms(raw) {
  const base = createDefaultPrograms();
  const src = raw && typeof raw === "object" ? raw : {};
  const scenes = Array.isArray(src.scenes) ? src.scenes : [];
  const chases = Array.isArray(src.chases) ? src.chases : [];
  const srcMacros = Array.isArray(src.macros) && src.macros.length > 0 ? src.macros : [];
  const macroById = new Map(srcMacros.map((macro) => [macro.id, macro]));
  for (const defaultMacro of base.macros) {
    if (!macroById.has(defaultMacro.id)) {
      srcMacros.push(defaultMacro);
    }
  }
  const washColor = {
    ...base.washColor,
    ...(src.washColor && typeof src.washColor === "object" ? src.washColor : {})
  };
  const pulse = {
    active: false,
    speedMs: Math.max(120, Number(src?.pulse?.speedMs) || base.pulse.speedMs)
  };
  return { scenes, chases, macros: srcMacros, washColor, pulse };
}

function createProgramService({ filePath, fixtures, dmx, onStateChange }) {
  let store = createDefaultPrograms();
  let chaseTimer = null;
  let activeChaseId = null;
  let pulseTimer = null;
  let pulseOn = false;
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));

  function saveStore() {
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
  }

  function loadStore() {
    if (!fs.existsSync(filePath)) {
      saveStore();
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      store = normalizePrograms(parsed);
    } catch (error) {
      store = createDefaultPrograms();
      saveStore();
    }
  }

  function sceneById(sceneId) {
    return store.scenes.find((scene) => scene.id === sceneId);
  }

  function stopChase() {
    const hadActiveChase = Boolean(chaseTimer || activeChaseId);
    if (chaseTimer) clearTimeout(chaseTimer);
    chaseTimer = null;
    activeChaseId = null;
    if (hadActiveChase) {
      onStateChange();
    }
  }

  function washFixtures() {
    return fixtures.filter((fixture) => fixture.type === "rgbaluv11");
  }

  function applyWashColor(color) {
    for (const fixture of washFixtures()) {
      const values = dmx.getState().values[fixture.id] || new Array(fixture.channelCount).fill(0);
      values[0] = clampByte(color.dimmer);
      values[1] = clampByte(color.red);
      values[2] = clampByte(color.green);
      values[3] = clampByte(color.blue);
      values[4] = clampByte(color.lime);
      values[5] = clampByte(color.amber);
      values[6] = clampByte(color.uv);
      if (values.length > 7) values[7] = 0;
      if (values.length > 8) values[8] = 0;
      dmx.setFixtureValues(fixture.id, values);
    }
  }

  function stopPulse() {
    if (pulseTimer) clearInterval(pulseTimer);
    pulseTimer = null;
    if (store.pulse.active) {
      store.pulse.active = false;
      pulseOn = false;
      onStateChange();
    }
  }

  function pulseStep() {
    pulseOn = !pulseOn;
    if (pulseOn) {
      applyWashColor(store.washColor);
    } else {
      applyWashColor({
        dimmer: 0,
        red: 0,
        green: 0,
        blue: 0,
        lime: 0,
        amber: 0,
        uv: 0
      });
    }
    onStateChange();
  }

  function startPulse({ speedMs }) {
    const nextSpeed = Math.max(120, Number(speedMs) || store.pulse.speedMs || 900);
    store.pulse.speedMs = nextSpeed;
    if (pulseTimer) clearInterval(pulseTimer);
    store.pulse.active = true;
    pulseOn = false;
    pulseStep();
    pulseTimer = setInterval(pulseStep, nextSpeed);
    saveStore();
  }

  function setWashColor(color) {
    const merged = {
      dimmer: clampByte(color.dimmer ?? store.washColor.dimmer),
      red: clampByte(color.red ?? store.washColor.red),
      green: clampByte(color.green ?? store.washColor.green),
      blue: clampByte(color.blue ?? store.washColor.blue),
      lime: clampByte(color.lime ?? store.washColor.lime),
      amber: clampByte(color.amber ?? store.washColor.amber),
      uv: clampByte(color.uv ?? store.washColor.uv)
    };
    store.washColor = merged;
    if (!store.pulse.active) {
      applyWashColor(store.washColor);
      onStateChange();
    } else {
      if (pulseOn) {
        applyWashColor(store.washColor);
      }
      onStateChange();
    }
    saveStore();
    return true;
  }

  function setPulseSpeed(speedMs) {
    store.pulse.speedMs = Math.max(120, Number(speedMs) || store.pulse.speedMs || 900);
    if (store.pulse.active) {
      startPulse({ speedMs: store.pulse.speedMs });
    } else {
      saveStore();
      onStateChange();
    }
    return true;
  }

  function runChaseStep(chase, stepIndex) {
    if (!activeChaseId || activeChaseId !== chase.id) return;
    const step = chase.steps[stepIndex];
    const scene = sceneById(step.sceneId);
    if (scene) {
      dmx.applySnapshot(scene.snapshot);
      onStateChange();
    }
    const nextIndex = (stepIndex + 1) % chase.steps.length;
    const duration = Math.max(100, Number(step.durationMs) || chase.defaultDurationMs || 1000);
    chaseTimer = setTimeout(() => runChaseStep(chase, nextIndex), duration);
  }

  function getState() {
    return {
      scenes: store.scenes,
      chases: store.chases,
      macros: store.macros,
      activeChaseId,
      washColor: store.washColor,
      pulse: store.pulse
    };
  }

  function saveScene({ name }) {
    const scene = {
      id: genId("scene"),
      name: sanitizeName(name, `Scene ${store.scenes.length + 1}`),
      snapshot: dmx.getState(),
      createdAt: Date.now()
    };
    store.scenes.push(scene);
    saveStore();
    return scene;
  }

  function applyScene({ sceneId }) {
    const scene = sceneById(sceneId);
    if (!scene) return false;
    stopChase();
    stopPulse();
    return dmx.applySnapshot(scene.snapshot);
  }

  function deleteScene({ sceneId }) {
    const next = store.scenes.filter((scene) => scene.id !== sceneId);
    if (next.length === store.scenes.length) return false;
    store.scenes = next;
    for (const chase of store.chases) {
      chase.steps = chase.steps.filter((step) => step.sceneId !== sceneId);
    }
    store.chases = store.chases.filter((chase) => chase.steps.length > 0);
    if (activeChaseId) {
      const running = store.chases.find((chase) => chase.id === activeChaseId);
      if (!running) stopChase();
    }
    saveStore();
    return true;
  }

  function saveChase({ name, sceneIds, durationMs }) {
    if (!Array.isArray(sceneIds) || sceneIds.length === 0) return null;
    const steps = sceneIds
      .map((sceneId) => sceneById(sceneId))
      .filter(Boolean)
      .map((scene) => ({
        sceneId: scene.id,
        durationMs: Math.max(100, Number(durationMs) || 1200)
      }));
    if (steps.length === 0) return null;

    const chase = {
      id: genId("chase"),
      name: sanitizeName(name, `Chase ${store.chases.length + 1}`),
      steps,
      defaultDurationMs: Math.max(100, Number(durationMs) || 1200),
      createdAt: Date.now()
    };
    store.chases.push(chase);
    saveStore();
    return chase;
  }

  function startChase({ chaseId }) {
    const chase = store.chases.find((item) => item.id === chaseId);
    if (!chase || !Array.isArray(chase.steps) || chase.steps.length === 0) return false;
    stopPulse();
    if (chaseTimer) clearTimeout(chaseTimer);
    activeChaseId = chase.id;
    onStateChange();
    runChaseStep(chase, 0);
    return true;
  }

  function deleteChase({ chaseId }) {
    const next = store.chases.filter((chase) => chase.id !== chaseId);
    if (next.length === store.chases.length) return false;
    store.chases = next;
    if (activeChaseId === chaseId) stopChase();
    saveStore();
    return true;
  }

  function applyMacro({ macroId }) {
    const macro = store.macros.find((item) => item.id === macroId);
    if (!macro) return false;
    stopChase();

    if (macro.type === "washColor") {
      stopPulse();
      for (const fixture of fixtures) {
        if (fixture.type !== macro.targetType) continue;
        const values = dmx.getState().values[fixture.id] || new Array(fixture.channelCount).fill(0);
        values[0] = clampByte(macro.params.dimmer);
        values[1] = clampByte(macro.params.red);
        values[2] = clampByte(macro.params.green);
        values[3] = clampByte(macro.params.blue);
        values[4] = clampByte(macro.params.lime);
        values[5] = clampByte(macro.params.amber);
        values[6] = clampByte(macro.params.uv);
        if (values.length > 7 && macro.params.strobe !== undefined) {
          values[7] = clampByte(macro.params.strobe);
        }
        dmx.setFixtureValues(fixture.id, values);
      }
      onStateChange();
      return true;
    }

    if (macro.type === "washSplit") {
      stopPulse();
      const targets = fixtures.filter((fixture) => fixture.type === macro.targetType);
      for (let i = 0; i < targets.length; i += 1) {
        const fixture = targets[i];
        const values = dmx.getState().values[fixture.id] || new Array(fixture.channelCount).fill(0);
        const palette = i % 2 === 0 ? macro.params.first : macro.params.second;
        values[0] = clampByte(palette.dimmer);
        values[1] = clampByte(palette.red);
        values[2] = clampByte(palette.green);
        values[3] = clampByte(palette.blue);
        values[4] = clampByte(palette.lime);
        values[5] = clampByte(palette.amber);
        values[6] = clampByte(palette.uv);
        if (values.length > 7) values[7] = 0;
        if (values.length > 8) values[8] = 0;
        dmx.setFixtureValues(fixture.id, values);
      }
      onStateChange();
      return true;
    }

    if (macro.type === "washPulse") {
      startPulse({ speedMs: store.pulse.speedMs });
      onStateChange();
      return true;
    }

    if (macro.type === "goboMovement") {
      stopPulse();
      for (const fixture of fixtures) {
        if (fixture.type !== macro.targetType) continue;
        const values = dmx.getState().values[fixture.id] || new Array(fixture.channelCount).fill(0);
        values[7] = clampByte(macro.params.dimmer);
        values[5] = clampByte(macro.params.color);
        values[8] = clampByte(macro.params.gobo);
        values[10] = clampByte(macro.params.movementMacro);
        values[11] = clampByte(macro.params.movementSpeed);
        dmx.setFixtureValues(fixture.id, values);
      }
      onStateChange();
      return true;
    }

    if (macro.type === "fixtureSnapshot") {
      const fixture = fixtureById.get(macro.fixtureId);
      if (!fixture) return false;
      dmx.setFixtureValues(fixture.id, macro.values || []);
      onStateChange();
      return true;
    }

    return false;
  }

  loadStore();

  return {
    getState,
    saveScene,
    applyScene,
    deleteScene,
    saveChase,
    startChase,
    stopChase,
    startPulse,
    stopPulse,
    setPulseSpeed,
    setWashColor,
    deleteChase,
    applyMacro
  };
}

module.exports = {
  createProgramService
};
