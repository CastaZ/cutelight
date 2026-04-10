const artnetFactory = require("artnet");

const DMX_CHANNELS_PER_UNIVERSE = 512;

function clampByte(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num < 0) return 0;
  if (num > 255) return 255;
  return Math.round(num);
}

function validateFixtures(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error("fixtures.json must contain at least one fixture");
  }

  const seenIds = new Set();
  const byUniverse = new Map();

  for (const fixture of fixtures) {
    const { id, universe, startChannel, channelCount } = fixture;

    if (!id || typeof id !== "string") {
      throw new Error("Every fixture requires a string id");
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate fixture id: ${id}`);
    }
    seenIds.add(id);

    if (!Number.isInteger(universe) || universe < 0) {
      throw new Error(`Fixture ${id} has invalid universe`);
    }
    if (!Number.isInteger(startChannel) || startChannel < 1 || startChannel > 512) {
      throw new Error(`Fixture ${id} has invalid startChannel`);
    }
    if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 512) {
      throw new Error(`Fixture ${id} has invalid channelCount`);
    }
    if (startChannel + channelCount - 1 > 512) {
      throw new Error(`Fixture ${id} exceeds universe channel limit`);
    }

    if (!byUniverse.has(universe)) byUniverse.set(universe, []);
    byUniverse.get(universe).push(fixture);
  }

  for (const [universe, universeFixtures] of byUniverse.entries()) {
    const taken = new Array(DMX_CHANNELS_PER_UNIVERSE).fill(null);
    for (const fixture of universeFixtures) {
      for (let i = 0; i < fixture.channelCount; i += 1) {
        const idx = fixture.startChannel - 1 + i;
        if (taken[idx] !== null) {
          throw new Error(
            `Channel overlap in universe ${universe}: ${fixture.id} conflicts with ${taken[idx]} on channel ${idx + 1}`
          );
        }
        taken[idx] = fixture.id;
      }
    }
  }
}

function createDmxEngine({ artnetHost, artnetPort, artnetIface, frameRate, fixtures }) {
  validateFixtures(fixtures);

  const artnetOptions = {
    host: artnetHost,
    port: artnetPort,
    sendAll: true,
    refresh: 2000
  };
  if (artnetIface) {
    artnetOptions.iface = artnetIface;
  }
  const artnet = artnetFactory(artnetOptions);

  const fixturesById = new Map(fixtures.map((f) => [f.id, f]));
  const baseValues = {};
  const universeSet = new Set(fixtures.map((f) => f.universe));

  for (const fixture of fixtures) {
    baseValues[fixture.id] = new Array(fixture.channelCount).fill(0);
  }

  const master = { value: 255 };
  const universeBuffers = new Map();
  for (const universe of universeSet) {
    universeBuffers.set(universe, new Array(DMX_CHANNELS_PER_UNIVERSE).fill(0));
  }

  function rebuildUniverseBuffers() {
    for (const universe of universeSet) {
      const buf = universeBuffers.get(universe);
      buf.fill(0);
    }

    const scale = master.value / 255;
    for (const fixture of fixtures) {
      const buf = universeBuffers.get(fixture.universe);
      const values = baseValues[fixture.id];

      for (let i = 0; i < fixture.channelCount; i += 1) {
        const out = clampByte(values[i] * scale);
        const channelIndex = fixture.startChannel - 1 + i;
        buf[channelIndex] = out;
      }
    }
  }

  function setChannel({ fixtureId, channelIndex, value }) {
    const fixture = fixturesById.get(fixtureId);
    if (!fixture) return false;
    if (!Number.isInteger(channelIndex) || channelIndex < 0 || channelIndex >= fixture.channelCount) {
      return false;
    }
    baseValues[fixtureId][channelIndex] = clampByte(value);
    rebuildUniverseBuffers();
    return true;
  }

  function setFixtureValues(fixtureId, values) {
    const fixture = fixturesById.get(fixtureId);
    if (!fixture || !Array.isArray(values)) return false;
    const target = baseValues[fixtureId];
    for (let i = 0; i < fixture.channelCount; i += 1) {
      target[i] = clampByte(values[i] || 0);
    }
    rebuildUniverseBuffers();
    return true;
  }

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return false;
    const { values, master } = snapshot;
    if (!values || typeof values !== "object") return false;

    for (const fixture of fixtures) {
      const incoming = values[fixture.id];
      const target = baseValues[fixture.id];
      if (!Array.isArray(incoming)) {
        target.fill(0);
        continue;
      }
      for (let i = 0; i < fixture.channelCount; i += 1) {
        target[i] = clampByte(incoming[i] || 0);
      }
    }

    if (master !== undefined) {
      setMaster(master);
    } else {
      rebuildUniverseBuffers();
    }
    return true;
  }

  function setMaster(value) {
    master.value = clampByte(value);
    rebuildUniverseBuffers();
  }

  function resetAll() {
    for (const fixture of fixtures) {
      baseValues[fixture.id].fill(0);
    }
    master.value = 255;
    rebuildUniverseBuffers();
  }

  function blackout() {
    master.value = 0;
    rebuildUniverseBuffers();
  }

  function getState() {
    const valuesCopy = {};
    for (const fixture of fixtures) {
      valuesCopy[fixture.id] = [...baseValues[fixture.id]];
    }

    const dmxByUniverse = {};
    for (const [universe, values] of universeBuffers.entries()) {
      dmxByUniverse[universe] = [...values];
    }

    return {
      fixtures,
      values: valuesCopy,
      master: master.value,
      dmx: dmxByUniverse
    };
  }

  rebuildUniverseBuffers();

  const safeFps = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 40;
  const intervalMs = Math.max(25, Math.round(1000 / safeFps));
  const timer = setInterval(() => {
    for (const [universe, values] of universeBuffers.entries()) {
      artnet.set(universe, 1, values);
    }
  }, intervalMs);

  function close() {
    clearInterval(timer);
    artnet.close();
  }

  return {
    setChannel,
    setFixtureValues,
    applySnapshot,
    setMaster,
    resetAll,
    blackout,
    getState,
    close
  };
}

module.exports = {
  createDmxEngine
};
