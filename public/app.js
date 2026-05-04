(() => {
  const isViewMode = window.location.pathname === "/view";
  const socket = io({
    auth: {
      mode: isViewMode ? "view" : "control"
    }
  });

  const state = {
    fixtures: [],
    values: {},
    master: 255,
    dmx: {},
    programs: {
      scenes: [],
      chases: [],
      macros: [],
      activeChaseId: null,
      washColor: { dimmer: 255, red: 255, green: 255, blue: 255, lime: 0, amber: 0, uv: 0 },
      pulse: { active: false, speedMs: 900 }
    },
    selectedUniverse: "0",
    readOnly: isViewMode,
    gobo: {
      selectedFixtureId: "",
      dragging: false
    }
  };

  const ui = {
    fixtureSignature: "",
    fixtureCards: new Map(),
    absoluteRows: new Map(),
    universeOptionsSignature: "",
    programsSignature: "",
    goboOptionsSignature: ""
  };

  const interaction = {
    active: new Set(),
    pendingWrites: new Map()
  };

  const fixturesEl = document.getElementById("fixtures");
  const masterSlider = document.getElementById("masterSlider");
  const masterValue = document.getElementById("masterValue");
  const blackoutBtn = document.getElementById("blackoutBtn");
  const resetBtn = document.getElementById("resetBtn");
  const readOnlyBadge = document.getElementById("readOnlyBadge");
  const connectionBadge = document.getElementById("connectionBadge");
  const programsRoot = document.getElementById("programsRoot");
  const absoluteChannels = document.getElementById("absoluteChannels");
  const universeSelect = document.getElementById("universeSelect");
  const goboFixtureSelect = document.getElementById("goboFixtureSelect");
  const goboJoystick = document.getElementById("goboJoystick");
  const goboKnob = document.getElementById("goboKnob");
  const goboCenterBtn = document.getElementById("goboCenterBtn");
  const goboValue = document.getElementById("goboValue");
  const goboColorSwatches = document.getElementById("goboColorSwatches");
  const goboColorValue = document.getElementById("goboColorValue");
  const goboColorButtons = new Map();
  const goboColors = [
    { label: "Open", value: 16, css: "#ffffff" },
    { label: "Red", value: 48, css: "#ff3b3b" },
    { label: "Green", value: 80, css: "#00d84a" },
    { label: "Blue", value: 112, css: "#1d4dff" },
    { label: "Yellow", value: 144, css: "#ffe95a" },
    { label: "Magenta", value: 176, css: "#ff48c9" },
    { label: "Amber", value: 208, css: "#ff9a00" },
    { label: "Cyan", value: 240, css: "#45d4ff" }
  ];

  function clampByte(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    if (num < 0) return 0;
    if (num > 255) return 255;
    return Math.round(num);
  }

  function keyForFixtureChannel(fixtureId, channelIndex) {
    return `fixture:${fixtureId}:${channelIndex}`;
  }

  function keyForAbsoluteChannel(universe, channelIndex) {
    return `abs:${universe}:${channelIndex}`;
  }

  function keyForMaster() {
    return "master";
  }

  function markActive(controlKey) {
    interaction.active.add(controlKey);
  }

  function unmarkActive(controlKey) {
    interaction.active.delete(controlKey);
  }

  function normalizeState(nextState) {
    if ("fixtures" in nextState) state.fixtures = nextState.fixtures || [];
    if ("values" in nextState) state.values = nextState.values || {};
    if ("master" in nextState) state.master = clampByte(nextState.master);
    if ("dmx" in nextState) state.dmx = nextState.dmx || {};
    if ("programs" in nextState) state.programs = nextState.programs || state.programs;
    if ("readOnly" in nextState) setReadOnly(Boolean(nextState.readOnly));
  }

  function fixtureSignature(fixtures) {
    return fixtures
      .map((fixture) => `${fixture.id}|${fixture.universe}|${fixture.startChannel}|${fixture.channelCount}`)
      .join(",");
  }

  function universeOptionsSignature() {
    return Object.keys(state.dmx)
      .sort((a, b) => Number(a) - Number(b))
      .join(",");
  }

  function programsSignature(programs) {
    const sceneIds = (programs.scenes || []).map((scene) => scene.id).join(",");
    const chaseIds = (programs.chases || []).map((chase) => chase.id).join(",");
    const macroIds = (programs.macros || []).map((macro) => macro.id).join(",");
    const wash = programs.washColor || {};
    const pulse = programs.pulse || {};
    return `${sceneIds}|${chaseIds}|${macroIds}|${programs.activeChaseId || ""}|${wash.red || 0}|${wash.green || 0}|${wash.blue || 0}|${wash.lime || 0}|${wash.amber || 0}|${wash.uv || 0}|${wash.dimmer || 0}|${pulse.active ? 1 : 0}|${pulse.speedMs || 0}`;
  }

  function incomingValue(controlKey, nextValue) {
    const incoming = clampByte(nextValue);
    if (interaction.active.has(controlKey)) return null;
    if (!interaction.pendingWrites.has(controlKey)) return incoming;

    const pending = interaction.pendingWrites.get(controlKey);
    if (pending === incoming) {
      interaction.pendingWrites.delete(controlKey);
      return incoming;
    }
    return pending;
  }

  function setReadOnly(readOnly) {
    state.readOnly = Boolean(readOnly);
    readOnlyBadge.classList.toggle("hidden", !state.readOnly);
    blackoutBtn.disabled = state.readOnly;
    resetBtn.disabled = state.readOnly;
    masterSlider.disabled = state.readOnly;
    goboFixtureSelect.disabled = state.readOnly;
    goboCenterBtn.disabled = state.readOnly;
  }

  function setConnectionStatus(status) {
    if (!connectionBadge) return;
    connectionBadge.classList.remove("neutral", "success", "error");
    connectionBadge.classList.add(status.tone);
    connectionBadge.textContent = status.text;
  }

  function fixtureChannels(fixture) {
    const channels = Array.isArray(fixture.channels) ? fixture.channels : [];
    const out = [];
    for (let i = 0; i < fixture.channelCount; i += 1) {
      const fromChannels = channels[i] && typeof channels[i] === "object" ? channels[i] : {};
      const fallbackLabel =
        (Array.isArray(fixture.channelLabels) && fixture.channelLabels[i]) || `Ch ${i + 1}`;
      out.push({
        name: fromChannels.name || fallbackLabel,
        ranges: Array.isArray(fromChannels.ranges) ? fromChannels.ranges : []
      });
    }
    return out;
  }

  function activeRange(ranges, value) {
    if (!Array.isArray(ranges)) return "";
    const match = ranges.find((item) => value >= Number(item.min) && value <= Number(item.max));
    if (!match) return "";
    return `${match.min}-${match.max}: ${match.label}`;
  }

  function findChannelIndexByName(fixture, keyword) {
    const channels = fixtureChannels(fixture);
    const needle = String(keyword).toLowerCase();
    return channels.findIndex((channel) => String(channel.name || "").toLowerCase().includes(needle));
  }

  function goboFixtures() {
    return state.fixtures.filter((fixture) => {
      const panIndex = findChannelIndexByName(fixture, "pan");
      const tiltIndex = findChannelIndexByName(fixture, "tilt");
      return panIndex !== -1 && tiltIndex !== -1;
    });
  }

  function goboOptionsSignature() {
    return goboFixtures()
      .map((fixture) => fixture.id)
      .join(",");
  }

  function currentGoboFixture() {
    if (!state.gobo.selectedFixtureId) return null;
    return state.fixtures.find((fixture) => fixture.id === state.gobo.selectedFixtureId) || null;
  }

  function panTiltValuesFromFixture(fixture) {
    const panIndex = findChannelIndexByName(fixture, "pan");
    const tiltIndex = findChannelIndexByName(fixture, "tilt");
    if (panIndex === -1 || tiltIndex === -1) return null;

    const values = state.values[fixture.id] || [];
    return {
      panIndex,
      tiltIndex,
      pan: clampByte(values[panIndex] ?? 128),
      tilt: clampByte(values[tiltIndex] ?? 128)
    };
  }

  function goboColorMetaFromFixture(fixture) {
    const colorIndex = findChannelIndexByName(fixture, "color");
    if (colorIndex === -1) return null;
    const channels = fixtureChannels(fixture);
    const values = state.values[fixture.id] || [];
    return {
      colorIndex,
      value: clampByte(values[colorIndex] ?? 0),
      ranges: channels[colorIndex]?.ranges || []
    };
  }

  function joystickPointFromPanTilt(pan, tilt) {
    return {
      x: pan / 127.5 - 1,
      y: 1 - tilt / 127.5
    };
  }

  function panTiltFromJoystickPoint(x, y) {
    return {
      pan: clampByte((x + 1) * 127.5),
      tilt: clampByte((1 - y) * 127.5)
    };
  }

  function moveGoboKnob(x, y) {
    const r = 68;
    const tx = Math.round(x * r);
    const ty = Math.round(y * r);
    goboKnob.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`;
  }

  function writeFixtureChannel(fixture, channelIndex, nextValue) {
    const controlKey = keyForFixtureChannel(fixture.id, channelIndex);
    if (!Array.isArray(state.values[fixture.id])) {
      state.values[fixture.id] = new Array(fixture.channelCount).fill(0);
    }
    state.values[fixture.id][channelIndex] = clampByte(nextValue);
    interaction.pendingWrites.set(controlKey, clampByte(nextValue));
    if (state.readOnly) return;
    socket.emit("channel:set", {
      fixtureId: fixture.id,
      channelIndex,
      value: nextValue
    });
  }

  function applyJoystickPoint(x, y) {
    const fixture = currentGoboFixture();
    if (!fixture) return;
    const panTilt = panTiltValuesFromFixture(fixture);
    if (!panTilt) return;
    const { pan, tilt } = panTiltFromJoystickPoint(x, y);
    moveGoboKnob(x, y);
    goboValue.textContent = `Pan ${pan} | Tilt ${tilt}`;
    writeFixtureChannel(fixture, panTilt.panIndex, pan);
    writeFixtureChannel(fixture, panTilt.tiltIndex, tilt);
  }

  function applyGoboColor(value) {
    const fixture = currentGoboFixture();
    if (!fixture) return;
    const meta = goboColorMetaFromFixture(fixture);
    if (!meta) return;
    writeFixtureChannel(fixture, meta.colorIndex, clampByte(value));
    const dimmerIndex = findChannelIndexByName(fixture, "dimmer");
    if (dimmerIndex !== -1) {
      writeFixtureChannel(fixture, dimmerIndex, 255);
    }
  }

  function updateGoboColorState() {
    const fixture = currentGoboFixture();
    if (!fixture) {
      goboColorValue.textContent = "Color: -";
      for (const btn of goboColorButtons.values()) btn.classList.remove("active");
      return;
    }
    const meta = goboColorMetaFromFixture(fixture);
    if (!meta) {
      goboColorValue.textContent = "Color: (no color channel)";
      for (const btn of goboColorButtons.values()) btn.classList.remove("active");
      return;
    }

    const rangeText = activeRange(meta.ranges, meta.value);
    goboColorValue.textContent = rangeText ? `Color: ${rangeText}` : `Color DMX: ${meta.value}`;

    let nearest = goboColors[0];
    let bestDistance = Math.abs(meta.value - nearest.value);
    for (const color of goboColors) {
      const distance = Math.abs(meta.value - color.value);
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = color;
      }
    }
    for (const [value, btn] of goboColorButtons.entries()) {
      btn.classList.toggle("active", Number(value) === nearest.value);
    }
  }

  function mountGoboColorSwatches() {
    goboColorSwatches.innerHTML = "";
    goboColorButtons.clear();
    for (const color of goboColors) {
      const btn = document.createElement("button");
      btn.className = "color-dot";
      btn.title = color.label;
      btn.style.background = color.css;
      btn.disabled = state.readOnly;
      btn.addEventListener("click", () => {
        if (state.readOnly) return;
        applyGoboColor(color.value);
      });
      goboColorButtons.set(color.value, btn);
      goboColorSwatches.appendChild(btn);
    }
  }

  function updateGoboFromState() {
    const fixture = currentGoboFixture();
    if (!fixture) {
      goboValue.textContent = "No gobo fixture";
      moveGoboKnob(0, 0);
      updateGoboColorState();
      return;
    }
    const panTilt = panTiltValuesFromFixture(fixture);
    if (!panTilt) {
      goboValue.textContent = "Missing pan/tilt channels";
      moveGoboKnob(0, 0);
      updateGoboColorState();
      return;
    }
    const point = joystickPointFromPanTilt(panTilt.pan, panTilt.tilt);
    goboValue.textContent = `Pan ${panTilt.pan} | Tilt ${panTilt.tilt}`;
    if (!state.gobo.dragging) {
      moveGoboKnob(point.x, point.y);
    }
    updateGoboColorState();
  }

  function renderGoboFixtureOptions(force = false) {
    const signature = goboOptionsSignature();
    if (!force && signature === ui.goboOptionsSignature) return;
    ui.goboOptionsSignature = signature;

    const fixtures = goboFixtures();
    goboFixtureSelect.innerHTML = "";

    if (fixtures.length === 0) {
      const option = document.createElement("option");
      option.textContent = "No gobo fixtures";
      option.value = "";
      goboFixtureSelect.appendChild(option);
      state.gobo.selectedFixtureId = "";
      goboFixtureSelect.disabled = true;
      goboCenterBtn.disabled = true;
      return;
    }

    goboFixtureSelect.disabled = state.readOnly;
    goboCenterBtn.disabled = state.readOnly;

    if (!fixtures.some((fixture) => fixture.id === state.gobo.selectedFixtureId)) {
      state.gobo.selectedFixtureId = fixtures[0].id;
    }

    for (const fixture of fixtures) {
      const option = document.createElement("option");
      option.value = fixture.id;
      option.textContent = fixture.name || fixture.id;
      if (fixture.id === state.gobo.selectedFixtureId) option.selected = true;
      goboFixtureSelect.appendChild(option);
    }
  }

  function buildNumberInput(initialValue, onChange) {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "value-input";
    input.min = "0";
    input.max = "255";
    input.step = "1";
    input.value = String(clampByte(initialValue));
    input.addEventListener("change", () => {
      onChange(clampByte(input.value));
      input.value = String(clampByte(input.value));
    });
    return input;
  }

  function clampDurationMs(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 1200;
    if (num < 100) return 100;
    if (num > 60000) return 60000;
    return Math.round(num);
  }

  function toHex2(value) {
    return clampByte(value).toString(16).padStart(2, "0");
  }

  function rgbToHex({ red, green, blue }) {
    return `#${toHex2(red)}${toHex2(green)}${toHex2(blue)}`;
  }

  function hexToRgb(hex) {
    if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
    return {
      red: parseInt(hex.slice(1, 3), 16),
      green: parseInt(hex.slice(3, 5), 16),
      blue: parseInt(hex.slice(5, 7), 16)
    };
  }

  function createFixtureCard(fixture) {
    const fixtureCard = document.createElement("article");
    fixtureCard.className = "fixture";

    const title = document.createElement("h3");
    title.textContent = fixture.name || fixture.id;
    fixtureCard.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `Type ${fixture.type || "generic"} | Universe ${fixture.universe}, Start ${
      fixture.startChannel
    }`;
    fixtureCard.appendChild(meta);

    const channelRows = [];
    const channels = fixtureChannels(fixture);
    for (let i = 0; i < fixture.channelCount; i += 1) {
      const controlKey = keyForFixtureChannel(fixture.id, i);
      const absoluteChannel = fixture.startChannel + i;
      const row = document.createElement("div");
      row.className = "slider-row";

      const label = document.createElement("label");
      label.textContent = `Ch ${i + 1} (DMX ${absoluteChannel}) ${channels[i].name}`;
      row.appendChild(label);

      const slider = document.createElement("input");
      const inputId = `${fixture.id}-channel-${i + 1}`;
      slider.id = inputId;
      slider.type = "range";
      slider.min = "0";
      slider.max = "255";
      slider.value = "0";
      if (state.readOnly) slider.setAttribute("disabled", "true");
      slider.addEventListener("pointerdown", () => markActive(controlKey));
      slider.addEventListener("pointerup", () => unmarkActive(controlKey));
      slider.addEventListener("blur", () => unmarkActive(controlKey));
      label.htmlFor = inputId;
      row.appendChild(slider);

      const valueText = document.createElement("span");
      valueText.className = "value";
      valueText.textContent = slider.value;
      row.appendChild(valueText);

      const valueInput = buildNumberInput(slider.value, (nextValue) => {
        slider.value = String(nextValue);
        valueText.textContent = String(nextValue);
        if (hint) hint.textContent = activeRange(channels[i].ranges, nextValue);
        if (!Array.isArray(state.values[fixture.id])) {
          state.values[fixture.id] = new Array(fixture.channelCount).fill(0);
        }
        state.values[fixture.id][i] = nextValue;
        interaction.pendingWrites.set(controlKey, nextValue);
        if (state.readOnly) return;
        socket.emit("channel:set", {
          fixtureId: fixture.id,
          channelIndex: i,
          value: nextValue
        });
      });
      if (state.readOnly) valueInput.setAttribute("disabled", "true");
      row.appendChild(valueInput);

      const hint = document.createElement("div");
      hint.className = "range-hint";
      hint.textContent = activeRange(channels[i].ranges, Number(slider.value));

      slider.addEventListener("input", () => {
        valueText.textContent = slider.value;
        valueInput.value = slider.value;
        hint.textContent = activeRange(channels[i].ranges, Number(slider.value));
      });

      slider.addEventListener("change", () => {
        const nextValue = Number(slider.value);
        if (!Array.isArray(state.values[fixture.id])) {
          state.values[fixture.id] = new Array(fixture.channelCount).fill(0);
        }
        state.values[fixture.id][i] = clampByte(nextValue);
        interaction.pendingWrites.set(controlKey, clampByte(nextValue));
        if (state.readOnly) return;
        socket.emit("channel:set", {
          fixtureId: fixture.id,
          channelIndex: i,
          value: nextValue
        });
      });

      fixtureCard.appendChild(row);
      if (hint.textContent) {
        fixtureCard.appendChild(hint);
      }
      channelRows.push({ slider, valueText, valueInput, hint, ranges: channels[i].ranges, controlKey });
    }

    ui.fixtureCards.set(fixture.id, { fixture, card: fixtureCard, channelRows });
    return fixtureCard;
  }

  function mountFixtures() {
    fixturesEl.innerHTML = "";
    ui.fixtureCards.clear();
    for (const fixture of state.fixtures) {
      fixturesEl.appendChild(createFixtureCard(fixture));
    }
  }

  function patchFixtureValues() {
    for (const fixture of state.fixtures) {
      const fixtureUi = ui.fixtureCards.get(fixture.id);
      if (!fixtureUi) continue;
      const values = state.values[fixture.id] || new Array(fixture.channelCount).fill(0);
      for (let i = 0; i < fixtureUi.channelRows.length; i += 1) {
        const row = fixtureUi.channelRows[i];
        const patched = incomingValue(row.controlKey, values[i]);
        if (patched === null) continue;
        row.slider.value = String(patched);
        row.valueText.textContent = String(patched);
        row.valueInput.value = String(patched);
        row.hint.textContent = activeRange(row.ranges, patched);
      }
    }
  }

  function renderPrograms() {
    const { scenes, chases, macros, activeChaseId, washColor, pulse } = state.programs;
    programsRoot.innerHTML = "";

    const sceneBlock = document.createElement("section");
    sceneBlock.className = "program-block";
    sceneBlock.innerHTML = '<h3>Scenes</h3>';
    const sceneControls = document.createElement("div");
    sceneControls.className = "program-controls";
    const sceneName = document.createElement("input");
    sceneName.type = "text";
    sceneName.maxLength = 60;
    sceneName.placeholder = "Scene name";
    const sceneSave = document.createElement("button");
    sceneSave.className = "btn";
    sceneSave.textContent = "Save Current Scene";
    sceneSave.disabled = state.readOnly;
    sceneSave.addEventListener("click", () => {
      socket.emit("program:sceneSave", { name: sceneName.value });
      sceneName.value = "";
    });
    sceneControls.appendChild(sceneName);
    sceneControls.appendChild(sceneSave);
    sceneBlock.appendChild(sceneControls);

    const scenesList = document.createElement("div");
    scenesList.className = "list-stack";
    for (const scene of scenes) {
      const row = document.createElement("div");
      row.className = "list-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.sceneId = scene.id;
      checkbox.className = "chase-scene-select";
      checkbox.disabled = state.readOnly;
      row.appendChild(checkbox);

      const name = document.createElement("span");
      name.className = "list-label";
      name.textContent = scene.name;
      row.appendChild(name);

      const applyBtn = document.createElement("button");
      applyBtn.className = "btn secondary";
      applyBtn.textContent = "Apply";
      applyBtn.disabled = state.readOnly;
      applyBtn.addEventListener("click", () => {
        socket.emit("program:sceneApply", { sceneId: scene.id });
      });
      row.appendChild(applyBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn danger";
      deleteBtn.textContent = "Delete";
      deleteBtn.disabled = state.readOnly;
      deleteBtn.addEventListener("click", () => {
        socket.emit("program:sceneDelete", { sceneId: scene.id });
      });
      row.appendChild(deleteBtn);
      scenesList.appendChild(row);
    }
    sceneBlock.appendChild(scenesList);

    const chaseBlock = document.createElement("section");
    chaseBlock.className = "program-block";
    chaseBlock.innerHTML = '<h3>Chases</h3>';
    const chaseControls = document.createElement("div");
    chaseControls.className = "program-controls";
    const chaseName = document.createElement("input");
    chaseName.type = "text";
    chaseName.maxLength = 60;
    chaseName.placeholder = "Chase name";
    const chaseDuration = document.createElement("input");
    chaseDuration.type = "number";
    chaseDuration.min = "100";
    chaseDuration.step = "100";
    chaseDuration.value = "1200";
    chaseDuration.title = "Step duration ms";
    const chaseSave = document.createElement("button");
    chaseSave.className = "btn";
    chaseSave.textContent = "Create Chase from Checked Scenes";
    chaseSave.disabled = state.readOnly;
    chaseSave.addEventListener("click", () => {
      const checked = Array.from(programsRoot.querySelectorAll(".chase-scene-select:checked"));
      const sceneIds = checked.map((node) => node.dataset.sceneId).filter(Boolean);
      if (sceneIds.length === 0) return;
      socket.emit("program:chaseSave", {
        name: chaseName.value,
        sceneIds,
        durationMs: clampDurationMs(chaseDuration.value)
      });
      chaseName.value = "";
    });
    chaseControls.appendChild(chaseName);
    chaseControls.appendChild(chaseDuration);
    chaseControls.appendChild(chaseSave);
    chaseBlock.appendChild(chaseControls);

    const chaseList = document.createElement("div");
    chaseList.className = "list-stack";
    for (const chase of chases) {
      const row = document.createElement("div");
      row.className = "list-row";
      const name = document.createElement("span");
      name.className = "list-label";
      name.textContent = `${chase.name} (${chase.steps.length} steps)`;
      row.appendChild(name);

      const runBtn = document.createElement("button");
      runBtn.className = "btn secondary";
      runBtn.textContent = activeChaseId === chase.id ? "Running" : "Run";
      runBtn.disabled = state.readOnly || activeChaseId === chase.id;
      runBtn.addEventListener("click", () => {
        socket.emit("program:chaseStart", { chaseId: chase.id });
      });
      row.appendChild(runBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn danger";
      deleteBtn.textContent = "Delete";
      deleteBtn.disabled = state.readOnly;
      deleteBtn.addEventListener("click", () => {
        socket.emit("program:chaseDelete", { chaseId: chase.id });
      });
      row.appendChild(deleteBtn);
      chaseList.appendChild(row);
    }
    chaseBlock.appendChild(chaseList);

    const stopChaseBtn = document.createElement("button");
    stopChaseBtn.className = "btn danger";
    stopChaseBtn.textContent = "Stop Chase";
    stopChaseBtn.disabled = state.readOnly || !activeChaseId;
    stopChaseBtn.addEventListener("click", () => socket.emit("program:chaseStop"));
    chaseBlock.appendChild(stopChaseBtn);

    const macroBlock = document.createElement("section");
    macroBlock.className = "program-block";
    macroBlock.innerHTML = "<h3>Macros</h3>";
    const macroList = document.createElement("div");
    macroList.className = "macro-grid";
    for (const macro of macros) {
      const btn = document.createElement("button");
      btn.className = "btn secondary";
      btn.textContent = macro.name;
      btn.disabled = state.readOnly;
      btn.addEventListener("click", () => {
        socket.emit("program:macroApply", { macroId: macro.id });
      });
      macroList.appendChild(btn);
    }
    macroBlock.appendChild(macroList);

    const colorBlock = document.createElement("section");
    colorBlock.className = "program-block";
    colorBlock.innerHTML = "<h3>Color Panel (All Wash Lights)</h3>";

    const swatchRow = document.createElement("div");
    swatchRow.className = "color-swatches";
    const swatches = [
      { name: "Red", color: "#ff0000", payload: { dimmer: 255, red: 255, green: 0, blue: 0, lime: 0, amber: 0, uv: 0 } },
      { name: "Yellow", color: "#fff000", payload: { dimmer: 255, red: 255, green: 255, blue: 0, lime: 0, amber: 40, uv: 0 } },
      { name: "Blue", color: "#1d4dff", payload: { dimmer: 255, red: 0, green: 0, blue: 255, lime: 0, amber: 0, uv: 0 } },
      { name: "Green", color: "#00d84a", payload: { dimmer: 255, red: 0, green: 255, blue: 0, lime: 40, amber: 0, uv: 0 } },
      { name: "Amber", color: "#ff9a00", payload: { dimmer: 255, red: 255, green: 80, blue: 0, lime: 0, amber: 255, uv: 0 } },
      { name: "UV", color: "#8e44ff", payload: { dimmer: 255, red: 20, green: 0, blue: 60, lime: 0, amber: 0, uv: 255 } },
      { name: "White", color: "#ffffff", payload: { dimmer: 255, red: 255, green: 255, blue: 255, lime: 180, amber: 180, uv: 0 } }
    ];

    for (const swatch of swatches) {
      const btn = document.createElement("button");
      btn.className = "color-dot";
      btn.title = swatch.name;
      btn.style.background = swatch.color;
      btn.disabled = state.readOnly;
      btn.addEventListener("click", () => {
        socket.emit("program:washColorSet", swatch.payload);
      });
      swatchRow.appendChild(btn);
    }
    colorBlock.appendChild(swatchRow);

    const pickerRow = document.createElement("div");
    pickerRow.className = "program-controls";
    const picker = document.createElement("input");
    picker.type = "color";
    picker.value = rgbToHex(washColor || { red: 255, green: 255, blue: 255 });
    picker.disabled = state.readOnly;
    picker.addEventListener("focus", () => markActive("program:color-picker"));
    picker.addEventListener("blur", () => {
      unmarkActive("program:color-picker");
      renderProgramsIfNeeded(true);
    });
    picker.addEventListener("input", () => {
      const rgb = hexToRgb(picker.value);
      if (!rgb) return;
      socket.emit("program:washColorSet", {
        dimmer: 255,
        red: rgb.red,
        green: rgb.green,
        blue: rgb.blue,
        lime: 0,
        amber: 0,
        uv: 0
      });
    });
    picker.addEventListener("change", () => {
      unmarkActive("program:color-picker");
      renderProgramsIfNeeded(true);
    });
    pickerRow.appendChild(picker);
    colorBlock.appendChild(pickerRow);

    const pulseControls = document.createElement("div");
    pulseControls.className = "program-controls";
    const speed = document.createElement("input");
    speed.type = "range";
    speed.min = "120";
    speed.max = "2400";
    speed.step = "20";
    speed.value = String(Math.max(120, Number(pulse?.speedMs) || 900));
    speed.disabled = state.readOnly;

    const speedLabel = document.createElement("span");
    speedLabel.className = "list-label";
    speedLabel.textContent = `Pulse Speed: ${speed.value} ms`;

    speed.addEventListener("input", () => {
      speedLabel.textContent = `Pulse Speed: ${speed.value} ms`;
    });

    speed.addEventListener("change", () => {
      socket.emit("program:pulseSpeedSet", { speedMs: Number(speed.value) });
    });

    const pulseBtn = document.createElement("button");
    pulseBtn.className = "btn secondary";
    pulseBtn.textContent = pulse && pulse.active ? "Pulse Running" : "Start Pulse";
    pulseBtn.disabled = state.readOnly || Boolean(pulse && pulse.active);
    pulseBtn.addEventListener("click", () => {
      socket.emit("program:pulseStart");
    });

    const pulseStopBtn = document.createElement("button");
    pulseStopBtn.className = "btn danger";
    pulseStopBtn.textContent = "Stop Pulse";
    pulseStopBtn.disabled = state.readOnly || !(pulse && pulse.active);
    pulseStopBtn.addEventListener("click", () => {
      socket.emit("program:pulseStop");
    });

    pulseControls.appendChild(speedLabel);
    pulseControls.appendChild(speed);
    pulseControls.appendChild(pulseBtn);
    pulseControls.appendChild(pulseStopBtn);
    colorBlock.appendChild(pulseControls);

    programsRoot.appendChild(sceneBlock);
    programsRoot.appendChild(chaseBlock);
    programsRoot.appendChild(macroBlock);
    programsRoot.appendChild(colorBlock);
  }

  function sortedUniverseKeys() {
    const fromDmx = Object.keys(state.dmx);
    const fromFixtures = state.fixtures.map((fixture) => String(fixture.universe));
    const merged = new Set([...fromDmx, ...fromFixtures]);
    return Array.from(merged).sort((a, b) => Number(a) - Number(b));
  }

  function renderUniverseOptions(force = false) {
    const signature = universeOptionsSignature();
    if (!force && ui.universeOptionsSignature === signature) return;
    ui.universeOptionsSignature = signature;

    const universeKeys = sortedUniverseKeys();
    if (universeKeys.length === 0) {
      universeSelect.innerHTML = "";
      const fallback = document.createElement("option");
      fallback.value = "0";
      fallback.textContent = "Universe 0";
      universeSelect.appendChild(fallback);
      state.selectedUniverse = "0";
      return;
    }
    if (!universeKeys.includes(state.selectedUniverse)) {
      state.selectedUniverse = universeKeys[0];
    }
    universeSelect.innerHTML = "";
    for (const universe of universeKeys) {
      const opt = document.createElement("option");
      opt.value = universe;
      opt.textContent = `Universe ${universe}`;
      if (universe === state.selectedUniverse) opt.selected = true;
      universeSelect.appendChild(opt);
    }
  }

  function renderAbsoluteChannels(force = false) {
    const shouldRebuild = force || ui.absoluteRows.size !== 512;
    if (!shouldRebuild) return;

    absoluteChannels.innerHTML = "";
    ui.absoluteRows.clear();
    for (let i = 0; i < 512; i += 1) {
      const controlKey = keyForAbsoluteChannel(state.selectedUniverse, i);
      const row = document.createElement("div");
      row.className = "absolute-row";

      const label = document.createElement("label");
      label.textContent = `DMX ${i + 1}`;
      row.appendChild(label);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "255";
      slider.value = "0";
      if (state.readOnly) slider.setAttribute("disabled", "true");
      slider.addEventListener("pointerdown", () => markActive(controlKey));
      slider.addEventListener("pointerup", () => unmarkActive(controlKey));
      slider.addEventListener("blur", () => unmarkActive(controlKey));
      row.appendChild(slider);

      const valueText = document.createElement("span");
      valueText.className = "value";
      valueText.textContent = slider.value;
      row.appendChild(valueText);

      const fixtureBinding = state.fixtures.find((fixture) => {
        if (Number(fixture.universe) !== Number(state.selectedUniverse)) return false;
        return i + 1 >= fixture.startChannel && i + 1 < fixture.startChannel + fixture.channelCount;
      });
      let patchable = false;
      if (fixtureBinding) {
        patchable = true;
        const channelIndex = i + 1 - fixtureBinding.startChannel;
        slider.addEventListener("input", () => {
          valueText.textContent = slider.value;
        });

        slider.addEventListener("change", () => {
          const nextValue = Number(slider.value);
          if (!Array.isArray(state.dmx[state.selectedUniverse])) {
            state.dmx[state.selectedUniverse] = new Array(512).fill(0);
          }
          state.dmx[state.selectedUniverse][i] = clampByte(nextValue);
          if (!Array.isArray(state.values[fixtureBinding.id])) {
            state.values[fixtureBinding.id] = new Array(fixtureBinding.channelCount).fill(0);
          }
          state.values[fixtureBinding.id][channelIndex] = clampByte(nextValue);
          interaction.pendingWrites.set(controlKey, clampByte(nextValue));
          interaction.pendingWrites.set(
            keyForFixtureChannel(fixtureBinding.id, channelIndex),
            clampByte(nextValue)
          );
          if (state.readOnly) return;
          socket.emit("channel:set", {
            fixtureId: fixtureBinding.id,
            channelIndex,
            value: nextValue
          });
        });
      } else {
        slider.setAttribute("disabled", "true");
      }
      ui.absoluteRows.set(i, { slider, valueText, controlKey, patchable });
      absoluteChannels.appendChild(row);
    }
  }

  function patchAbsoluteValues() {
    const values = state.dmx[state.selectedUniverse] || new Array(512).fill(0);
    for (let i = 0; i < 512; i += 1) {
      const row = ui.absoluteRows.get(i);
      if (!row) continue;
      const patched = incomingValue(row.controlKey, values[i]);
      if (patched === null) continue;
      row.slider.value = String(patched);
      row.valueText.textContent = String(patched);
    }
  }

  function patchMaster() {
    const patched = incomingValue(keyForMaster(), state.master);
    if (patched === null) return;
    masterSlider.value = String(patched);
    masterValue.textContent = String(patched);
  }

  function syncReadOnlyState() {
    for (const fixtureUi of ui.fixtureCards.values()) {
      for (const row of fixtureUi.channelRows) {
        row.slider.disabled = state.readOnly;
        row.valueInput.disabled = state.readOnly;
      }
    }
    for (const row of ui.absoluteRows.values()) {
      row.slider.disabled = state.readOnly || !row.patchable;
    }
    const hasGobo = goboFixtures().length > 0;
    goboFixtureSelect.disabled = state.readOnly || !hasGobo;
    goboCenterBtn.disabled = state.readOnly || !hasGobo;
    const fixture = currentGoboFixture();
    const hasColor = fixture ? Boolean(goboColorMetaFromFixture(fixture)) : false;
    for (const btn of goboColorButtons.values()) {
      btn.disabled = state.readOnly || !hasColor;
    }
  }

  function ensureStructure() {
    const nextFixtureSignature = fixtureSignature(state.fixtures);
    if (ui.fixtureSignature !== nextFixtureSignature) {
      ui.fixtureSignature = nextFixtureSignature;
      mountFixtures();
      renderAbsoluteChannels(true);
      renderGoboFixtureOptions(true);
    }
    renderUniverseOptions();
    renderGoboFixtureOptions();
  }

  function renderProgramsIfNeeded(force = false) {
    if (!force && interaction.active.has("program:color-picker")) return;
    const signature = programsSignature(state.programs);
    if (!force && ui.programsSignature === signature) return;
    ui.programsSignature = signature;
    renderPrograms();
  }

  function renderAll(forcePrograms = false) {
    ensureStructure();
    renderAbsoluteChannels();
    patchMaster();
    patchFixtureValues();
    patchAbsoluteValues();
    updateGoboFromState();
    renderProgramsIfNeeded(forcePrograms);
    syncReadOnlyState();
  }

  masterSlider.addEventListener("input", () => {
    const value = clampByte(masterSlider.value);
    masterValue.textContent = String(value);
  });

  masterSlider.addEventListener("pointerdown", () => markActive(keyForMaster()));
  masterSlider.addEventListener("pointerup", () => unmarkActive(keyForMaster()));
  masterSlider.addEventListener("blur", () => unmarkActive(keyForMaster()));
  masterSlider.addEventListener("change", () => {
    const value = clampByte(masterSlider.value);
    state.master = value;
    interaction.pendingWrites.set(keyForMaster(), value);
    if (state.readOnly) return;
    socket.emit("master:set", value);
  });

  blackoutBtn.addEventListener("click", () => {
    if (state.readOnly) return;
    socket.emit("scene:blackout");
  });

  resetBtn.addEventListener("click", () => {
    if (state.readOnly) return;
    socket.emit("scene:reset");
  });

  goboFixtureSelect.addEventListener("change", () => {
    state.gobo.selectedFixtureId = goboFixtureSelect.value;
    updateGoboFromState();
  });

  goboCenterBtn.addEventListener("click", () => {
    if (state.readOnly) return;
    applyJoystickPoint(0, 0);
  });

  function joystickPointFromEvent(event) {
    const rect = goboJoystick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let x = (event.clientX - cx) / (rect.width / 2);
    let y = (event.clientY - cy) / (rect.height / 2);
    const mag = Math.hypot(x, y);
    if (mag > 1) {
      x /= mag;
      y /= mag;
    }
    return { x, y };
  }

  goboJoystick.addEventListener("pointerdown", (event) => {
    if (state.readOnly) return;
    state.gobo.dragging = true;
    goboJoystick.setPointerCapture(event.pointerId);
    const point = joystickPointFromEvent(event);
    applyJoystickPoint(point.x, point.y);
  });

  goboJoystick.addEventListener("pointermove", (event) => {
    if (state.readOnly || !state.gobo.dragging) return;
    const point = joystickPointFromEvent(event);
    applyJoystickPoint(point.x, point.y);
  });

  goboJoystick.addEventListener("pointerup", () => {
    state.gobo.dragging = false;
  });

  goboJoystick.addEventListener("pointercancel", () => {
    state.gobo.dragging = false;
  });

  mountGoboColorSwatches();

  socket.on("state:init", (nextState) => {
    normalizeState(nextState);
    renderAll(true);
  });

  socket.on("state:update", (nextState) => {
    normalizeState(nextState);
    renderAll();
  });

  universeSelect.addEventListener("change", () => {
    state.selectedUniverse = universeSelect.value;
    renderAbsoluteChannels(true);
    patchAbsoluteValues();
  });

  socket.on("connect", () => {
    setConnectionStatus({ tone: "success", text: "Connected" });
  });

  socket.on("disconnect", () => {
    setConnectionStatus({ tone: "error", text: "Disconnected" });
  });

  socket.on("reconnect_attempt", () => {
    setConnectionStatus({ tone: "neutral", text: "Reconnecting..." });
  });

  socket.on("connect_error", () => {
    setConnectionStatus({ tone: "error", text: "Connection error" });
  });
})();
