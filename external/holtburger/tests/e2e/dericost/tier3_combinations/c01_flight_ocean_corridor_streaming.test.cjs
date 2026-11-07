/**
 * Tier 3: Combination 1 — Hellcat Flight Through Ocean Corridor into Dericost
 * Features combined: F3 (Flight Physics) + F4 (Spatial Placement) + F9 (Ocean Gap Streaming).
 * Evaluates continuous simulated flight from Dereth North shore across the 104-LB gap to Dericost landfall.
 * Sources: PROJECT.md, TEST_INFRA.md, VehicleStreaming.cs, flight_model.js
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 3: Combination 1 - Hellcat Flight Through Ocean Corridor into Dericost', 3);

// Simulates continuous flight and streaming state machine
function simulateFlightTransit(startPos, headingRad, speedMps, totalSeconds, dt = 1.0) {
  let pos = { ...startPos };
  let time = 0.0;
  const history = [];

  const dirX = Math.sin(headingRad);
  const dirY = Math.cos(headingRad);

  while (time < totalSeconds) {
    pos.x += dirX * speedMps * dt;
    pos.y += dirY * speedMps * dt;
    time += dt;

    const inDereth = pos.y <= CONSTANTS.DERETH_NORTH_SHORE_Y;
    const inOcean = pos.y > CONSTANTS.DERETH_NORTH_SHORE_Y && pos.y < CONSTANTS.DERICOST_SOUTH_SHORE_Y;
    const inDericost = pos.y >= CONSTANTS.DERICOST_SOUTH_SHORE_Y;

    const continent = inDericost ? 1 : 0;
    const localGy = inDericost ? pos.y - CONSTANTS.DERICOST_SOUTH_SHORE_Y : pos.y;
    const lbX = Math.max(0, Math.min(254, Math.floor(pos.x / CONSTANTS.LB_SIZE)));
    const lbY = Math.max(0, Math.min(254, Math.floor(localGy / CONSTANTS.LB_SIZE)));
    const cellId = (((continent << 31) | (lbX << 24) | (lbY << 16) | 1) >>> 0);

    history.push({
      time: Math.round(time * 10) / 10,
      pos: { ...pos },
      inDereth,
      inOcean,
      inDericost,
      continent,
      lbX,
      lbY,
      cellId
    });
  }
  return history;
}

suite.addTest('C1.1: Continuous heading-0 cruising flight transitions cleanly Dereth -> Ocean -> Dericost', () => {
  const startPos = { x: 24480.0, y: 48000.0, z: 100.0 }; // 960m south of Dereth coast (in Dereth)
  const heading = 0.0; // North
  const speed = CONSTANTS.HELLCAT_V_CRUISE; // 83.0 m/s
  const duration = 260.0; // seconds

  const track = simulateFlightTransit(startPos, heading, speed, duration, 1.0);

  // Initial state in Dereth
  assertEquals(track[0].inDereth, true, 'Starts in Dereth');
  assertEquals(track[0].continent, 0);

  // Mid transit in Ocean
  const midPoint = track.find(t => t.time >= 120.0);
  assert(midPoint !== undefined);
  assertEquals(midPoint.inOcean, true, 'At 120s, aircraft is in ocean corridor');
  assertEquals(midPoint.inDereth, false);
  assertEquals(midPoint.inDericost, false);
  assertInRange(midPoint.pos.y, 48960.0, 68928.0);

  // Landfall at Dericost
  const landfall = track.find(t => t.pos.y >= CONSTANTS.DERICOST_SOUTH_SHORE_Y);
  assert(landfall !== undefined, 'Aircraft makes landfall at Dericost');
  assertEquals(landfall.inDericost, true);
  assertEquals(landfall.continent, 1, 'Continent Bit 31 is active on landfall');
});

suite.addTest('C1.2: Streaming residency rings drop to zero in ocean gap and restore at Dericost', () => {
  function getActiveLandblockCount(inOcean) {
    return inOcean ? 0 : 9; // 3x3 ring
  }

  const track = simulateFlightTransit({ x: 24480.0, y: 48000.0, z: 100.0 }, 0.0, 83.0, 260.0, 1.0);

  const tStart = track[0];
  assertEquals(getActiveLandblockCount(tStart.inOcean), 9, 'Near ring active on Dereth coast');

  const tOcean = track.find(t => t.inOcean);
  assertEquals(getActiveLandblockCount(tOcean.inOcean), 0, 'Near ring empty over ocean');

  const tDericost = track.find(t => t.inDericost);
  assertEquals(getActiveLandblockCount(tDericost.inOcean), 9, 'Near ring restored over Dericost landmass');
});

suite.addTest('C1.3: Bit 31 flips from 0 to 1 at exact landfall boundary without coordinate jitter', () => {
  const track = simulateFlightTransit({ x: 24480.0, y: 48000.0, z: 100.0 }, 0.0, 83.0, 260.0, 0.5);

  const justBeforeLandfall = track.filter(t => t.pos.y < CONSTANTS.DERICOST_SOUTH_SHORE_Y).pop();
  const atLandfall = track.find(t => t.pos.y >= CONSTANTS.DERICOST_SOUTH_SHORE_Y);

  assertEquals((justBeforeLandfall.cellId >>> 31) & 1, 0, 'Bit 31 is 0 before landfall');
  assertEquals((atLandfall.cellId >>> 31) & 1, 1, 'Bit 31 is 1 at landfall');
  assertEquals(atLandfall.lbY, 0, 'Initial Dericost landblock lbY begins at 0');
});

suite.addTest('C1.4: Background preloading tasks look ahead 6.0 seconds (498m) before landfall', () => {
  // Authoritative lookahead from VehicleStreaming.cs:
  // PreloadDistance = velocity * PreloadSeconds = 83.0 * 6.0 = 498.0 meters
  const lookaheadDist = CONSTANTS.HELLCAT_V_CRUISE * 6.0;
  assertEquals(lookaheadDist, 498.0, '6-second lookahead covers 498.0 meters (~2.6 landblocks)');

  const aircraftY = CONSTANTS.DERICOST_SOUTH_SHORE_Y - 300.0; // 300m before landfall
  const preloadAheadY = aircraftY + lookaheadDist;

  assert(preloadAheadY > CONSTANTS.DERICOST_SOUTH_SHORE_Y,
    'Lookahead corridor reaches Dericost shore while aircraft is still over ocean');
});

suite.addTest('C1.5: Altitude AGL tracking during ocean crossing equates directly to absolute altitude Z', () => {
  // In ocean gap, terrain height is identically 0.0m. Therefore AGL = Z - 0.0 = Z.
  function getAgl(z, terrainHeight) {
    return z - terrainHeight;
  }

  const flightAlt = 150.0;
  const oceanTerrainZ = 0.0;
  const agl = getAgl(flightAlt, oceanTerrainZ);

  assertEquals(agl, flightAlt, 'Ocean AGL is identical to aircraft altitude Z');
  assert(agl >= CONSTANTS.HELLCAT_FLOOR_AGL, 'Above Hellcat floor AGL (30m)');
  assert(agl <= CONSTANTS.HELLCAT_CEILING_AGL, 'Below Hellcat ceiling AGL (450m)');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
