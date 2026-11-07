/**
 * Challenger Stress & Adversarial Verification Harness for Milestone 1
 * Empirical verification of flight physics, ocean gap transit, boundary clamping,
 * and coordinate transformations across Holtburger-web and ACE.Server.
 */

import * as flightModel from '../apps/holtburger-web/scene3d/vehicle/flight_model.js';
import * as worldTerrain from '../apps/holtburger-web/scene3d/world_terrain.js';
import * as worldStream from '../apps/holtburger-web/scene3d/world_stream.js';

const {
  MODE,
  DT,
  WORLD_X_MIN,
  WORLD_X_MAX,
  WORLD_Y_MIN,
  WORLD_Y_MAX,
  WORLD_MIN,
  WORLD_MAX,
  DERICOST_Y_OFFSET,
  step,
  toCellLocal,
  toGlobal,
  paramsFromProfile,
  quantizeInput,
  inputFromFrame,
  BUTTON
} = flightModel;

// Canonical Hellcat parameters (30 Hz fixed step)
const hellcatProfile = {
  vMin: 30.0,
  vCruise: 83.0,
  vMax: 111.0,
  speedCap: 111.0,
  accel: 8.0,
  decel: 12.0,
  maxBank: 1.05,
  rollRate: 2.1,
  maxPitch: 0.65,
  pitchRate: 1.2,
  yawRate: 0.8,
  climbMax: 35.0,
  sinkMax: 45.0,
  floorAgl: 15.0,
  ceilingAgl: 1200.0,
  takeoffClimb: 12.0,
  landingSpeed: 35.0
};
const p = paramsFromProfile(hellcatProfile);
const vCap = hellcatProfile.speedCap;

// Synthetic flat ground with sea level
const seaLevelGround = (x, y) => {
  return worldTerrain.worldGroundHeight(x, y) ?? 0.0;
};

let passedCount = 0;
let failedCount = 0;
const findings = [];

function check(desc, condition, detail = '') {
  if (condition) {
    passedCount++;
    console.log(`  [PASS] ${desc}`);
  } else {
    failedCount++;
    console.error(`  [FAIL] ${desc} — ${detail}`);
    findings.push({ desc, detail });
  }
}

console.log('======================================================================');
console.log('       CHALLENGER ADVERSARIAL STRESS SUITE — MILESTONE 1');
console.log('======================================================================\n');

// --------------------------------------------------------------------
// SUITE 1: Ocean Gap Flight Trajectory Simulation (Cruise & Boost)
// --------------------------------------------------------------------
console.log('>>> TEST SUITE 1: Ocean Gap Flight Trajectory (Cruise 83 m/s & Max Boost 111 m/s) <<<');

// 1.1 Cruise Flight: Dereth coast -> Ocean -> Dericost
{
  let s = {
    x: 24480.0,
    y: 48000.0, // 960m south of ocean corridor
    z: 150.0,
    heading: 0.0, // North (+Y)
    pitch: 0.0,
    bank: 0.0,
    speed: 83.0,
    mode: MODE.FLIGHT
  };

  const u = {
    throttle: 1.0, // Cruise throttle in flight_model: target = vMin + throttle * (vCruise - vMin) = 83 m/s
    pitch: 0.0,
    roll: 0.0,
    yaw: 0.0,
    boost: false,
    fire: false,
    land: false,
    missile: false,
    bomb: false
  };

  let steps = 0;
  let enteredOceanStep = -1;
  let enteredDericostStep = -1;
  let hasNaN = false;
  let minSpeed = 999.0;
  let maxSpeed = 0.0;
  let modeBroken = false;

  // Run 8000 steps (266.6 seconds)
  for (let i = 0; i < 8000; i++) {
    step(s, u, p, vCap, seaLevelGround, DT);
    steps++;

    if (
      !Number.isFinite(s.x) ||
      !Number.isFinite(s.y) ||
      !Number.isFinite(s.z) ||
      !Number.isFinite(s.heading) ||
      !Number.isFinite(s.pitch) ||
      !Number.isFinite(s.bank) ||
      !Number.isFinite(s.speed)
    ) {
      hasNaN = true;
      break;
    }

    if (s.speed < minSpeed) minSpeed = s.speed;
    if (s.speed > maxSpeed) maxSpeed = s.speed;
    if (s.mode !== MODE.FLIGHT) modeBroken = true;

    if (s.y >= 48960.0 && enteredOceanStep === -1) {
      enteredOceanStep = steps;
    }
    if (s.y >= 68928.0 && enteredDericostStep === -1) {
      enteredDericostStep = steps;
    }
  }

  const oceanTransitSteps = enteredDericostStep - enteredOceanStep;
  const oceanTransitSeconds = oceanTransitSteps * DT;

  check('1.1.1: Cruise simulation contains no NaN or Infinite values', !hasNaN, `NaN encountered at step ${steps}`);
  check('1.1.2: Aircraft remains in FLIGHT mode across entire ocean transit', !modeBroken, `Mode changed to ${s.mode}`);
  check('1.1.3: Speed remains stable at cruise (no stalling below 30 m/s)', minSpeed >= 30.0 && minSpeed <= 83.01, `Min speed was ${minSpeed}`);
  check('1.1.4: Aircraft reaches Dericost landfall (Y >= 68928m)', enteredDericostStep > 0, `Final Y was ${s.y}`);
  console.log(`       Ocean transit steps: ${oceanTransitSteps}, time: ${oceanTransitSeconds.toFixed(2)}s (${(oceanTransitSeconds / 60).toFixed(2)} min)`);
}

// 1.2 Max Boost Flight: 111 m/s across ocean gap
{
  let s = {
    x: 24480.0,
    y: 48960.0, // Starting at ocean boundary
    z: 200.0,
    heading: 0.0,
    pitch: 0.0,
    bank: 0.0,
    speed: 111.0,
    mode: MODE.FLIGHT
  };

  const u = {
    throttle: 1.0,
    pitch: 0.0,
    roll: 0.0,
    yaw: 0.0,
    boost: true,
    fire: false,
    land: false,
    missile: false,
    bomb: false
  };

  let steps = 0;
  let reachedDericostStep = -1;
  let hasNaN = false;
  let minSpeed = 999.0;
  let maxSpeed = 0.0;

  for (let i = 0; i < 6000; i++) {
    step(s, u, p, vCap, seaLevelGround, DT);
    steps++;

    if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z) || !Number.isFinite(s.speed)) {
      hasNaN = true;
      break;
    }
    if (s.speed < minSpeed) minSpeed = s.speed;
    if (s.speed > maxSpeed) maxSpeed = s.speed;

    if (s.y >= 68928.0 && reachedDericostStep === -1) {
      reachedDericostStep = steps;
    }
  }

  const boostTransitSeconds = reachedDericostStep * DT;

  check('1.2.1: Max boost simulation contains no NaN or Infinite values', !hasNaN, `NaN encountered`);
  check('1.2.2: Speed sustains max boost (111.0 m/s)', minSpeed >= 110.9 && maxSpeed <= 111.01, `Speed range: [${minSpeed}, ${maxSpeed}]`);
  check('1.2.3: Reaches Dericost at max boost', reachedDericostStep > 0, `Final Y: ${s.y}`);
  console.log(`       Max boost ocean transit time: ${boostTransitSeconds.toFixed(2)}s (${(boostTransitSeconds / 60).toFixed(2)} min)`);
}

// --------------------------------------------------------------------
// SUITE 2: Hellcat Flight Duration Verification Across 104 Landblocks
// --------------------------------------------------------------------
console.log('\n>>> TEST SUITE 2: Hellcat Flight Duration Math & Simulation Across 104 Landblocks <<<');

{
  const oceanLandblocks = 104;
  const landblockSize = 192.0;
  const oceanDistance = oceanLandblocks * landblockSize; // 19,968.0 m
  const vCruise = 83.0; // m/s
  const expectedCruiseDuration = oceanDistance / vCruise; // 240.578313... s

  check('2.1: Ocean corridor distance is exactly 19,968.0 metres (104 landblocks * 192 m)', oceanDistance === 19968.0, `Got ${oceanDistance}`);
  check('2.2: Mathematical cruise duration is 240.58 s (approx 4.01 min)', Math.abs(expectedCruiseDuration - 240.5783) < 0.001, `Got ${expectedCruiseDuration}`);

  // Precise discrete simulation of transit at constant 83 m/s
  let s = {
    x: 24480.0,
    y: 48960.0,
    z: 100.0,
    heading: 0.0,
    pitch: 0.0,
    bank: 0.0,
    speed: 83.0,
    mode: MODE.FLIGHT
  };
  const u = { throttle: 1.0, pitch: 0, roll: 0, yaw: 0, boost: false, fire: false, land: false };

  let simTime = 0.0;
  while (s.y < 68928.0 && simTime < 300.0) {
    step(s, u, p, vCap, seaLevelGround, DT);
    simTime += DT;
  }

  check('2.3: Simulated 30 Hz flight duration matches 240.58 s within 1 step (±0.033 s)', Math.abs(simTime - 240.58) <= DT + 0.02, `Simulated time: ${simTime.toFixed(4)}s`);
}

// --------------------------------------------------------------------
// SUITE 3: Boundary Clamping Verification
// --------------------------------------------------------------------
console.log('\n>>> TEST SUITE 3: Boundary Clamping (X in [0.5, 48959.5], Y in [0.5, 117887.5]) <<<');

{
  check('3.1: WORLD_X_MIN is 0.5 m', WORLD_X_MIN === 0.5, `Got ${WORLD_X_MIN}`);
  check('3.2: WORLD_X_MAX is 48,959.5 m', WORLD_X_MAX === 48959.5, `Got ${WORLD_X_MAX}`);
  check('3.3: WORLD_Y_MIN is 0.5 m', WORLD_Y_MIN === 0.5, `Got ${WORLD_Y_MIN}`);
  check('3.4: WORLD_Y_MAX is 117,887.5 m', WORLD_Y_MAX === 117887.5, `Got ${WORLD_Y_MAX}`);
  check('3.5: Backward-compatible WORLD_MAX alias matches WORLD_X_MAX', WORLD_MAX === WORLD_X_MAX, `Got ${WORLD_MAX}`);

  // Test West boundary clamp (X -> 0)
  {
    let s = { x: 5.0, y: 10000.0, z: 100.0, heading: 1.5 * Math.PI, pitch: 0, bank: 0, speed: 83.0, mode: MODE.FLIGHT };
    const u = { throttle: 1, pitch: 0, roll: 0, yaw: 0, boost: false, fire: false, land: false };
    for (let i = 0; i < 60; i++) step(s, u, p, vCap, seaLevelGround, DT);
    check('3.6: West edge clamps precisely to WORLD_X_MIN (0.5 m)', s.x === WORLD_X_MIN, `s.x = ${s.x}`);
  }

  // Test East boundary clamp (X -> 48960)
  {
    let s = { x: 48950.0, y: 10000.0, z: 100.0, heading: 0.5 * Math.PI, pitch: 0, bank: 0, speed: 83.0, mode: MODE.FLIGHT };
    const u = { throttle: 1, pitch: 0, roll: 0, yaw: 0, boost: false, fire: false, land: false };
    for (let i = 0; i < 60; i++) step(s, u, p, vCap, seaLevelGround, DT);
    check('3.7: East edge clamps precisely to WORLD_X_MAX (48959.5 m)', s.x === WORLD_X_MAX, `s.x = ${s.x}`);
  }

  // Test South boundary clamp (Y -> 0)
  {
    let s = { x: 10000.0, y: 5.0, z: 100.0, heading: Math.PI, pitch: 0, bank: 0, speed: 83.0, mode: MODE.FLIGHT };
    const u = { throttle: 1, pitch: 0, roll: 0, yaw: 0, boost: false, fire: false, land: false };
    for (let i = 0; i < 60; i++) step(s, u, p, vCap, seaLevelGround, DT);
    check('3.8: South edge clamps precisely to WORLD_Y_MIN (0.5 m)', s.y === WORLD_Y_MIN, `s.y = ${s.y}`);
  }

  // Test North boundary clamp (Y -> 117888)
  {
    let s = { x: 10000.0, y: 117880.0, z: 100.0, heading: 0.0, pitch: 0, bank: 0, speed: 83.0, mode: MODE.FLIGHT };
    const u = { throttle: 1, pitch: 0, roll: 0, yaw: 0, boost: false, fire: false, land: false };
    for (let i = 0; i < 60; i++) step(s, u, p, vCap, seaLevelGround, DT);
    check('3.9: North edge clamps precisely to WORLD_Y_MAX (117887.5 m)', s.y === WORLD_Y_MAX, `s.y = ${s.y}`);
  }

  // Test DERELICT mode clamping
  {
    let s = { x: 48950.0, y: 117880.0, z: 500.0, heading: 0.25 * Math.PI, pitch: -0.2, bank: 0, speed: 50.0, mode: MODE.DERELICT };
    for (let i = 0; i < 120; i++) step(s, flightModel.DERELICT_INPUT, p, vCap, seaLevelGround, DT);
    check('3.10: DERELICT mode respects WORLD_X_MAX and WORLD_Y_MAX', s.x <= WORLD_X_MAX && s.y <= WORLD_Y_MAX, `s.x=${s.x}, s.y=${s.y}`);
  }
}

// --------------------------------------------------------------------
// SUITE 4: Coordinate Mapping: toCellLocal & toGlobal Round-Trip Stress
// --------------------------------------------------------------------
console.log('\n>>> TEST SUITE 4: Coordinate Mapping (toCellLocal, Continent Bit 31 & toGlobal Inversion) <<<');

{
  // Test points across different geographic zones
  const testCoords = [
    { name: 'Western Dereth (SW Corner)', gx: 100.0, gy: 100.0, gz: 50.0, continentWanted: 0 },
    { name: 'Western Dereth (Mid-West)', gx: 12000.0, gy: 24000.0, gz: 75.0, continentWanted: 0 },
    { name: 'Western Dereth (Sub-128 LB boundary)', gx: 24575.5, gy: 48000.0, gz: 100.0, continentWanted: 0 },
    { name: 'Eastern Dereth (Holtburg 0xA9=169)', gx: 32448.0, gy: 28800.0, gz: 177.0, continentWanted: 0 },
    { name: 'Eastern Dereth (East edge)', gx: 48950.0, gy: 24000.0, gz: 60.0, continentWanted: 0 },
    { name: 'Ocean Corridor (Mid-Ocean)', gx: 24480.0, gy: 58944.0, gz: 200.0, continentWanted: 0 },
    { name: 'Ocean Corridor (Near Dericost Shore)', gx: 24480.0, gy: 68927.9, gz: 150.0, continentWanted: 0 },
    { name: 'Dericost South Shore Landfall', gx: 24480.0, gy: 68928.0, gz: 10.0, continentWanted: 1 },
    { name: 'Western Dericost (West Shore)', gx: 100.0, gy: 75000.0, gz: 25.0, continentWanted: 1 },
    { name: 'Western Dericost (Vasmora Capital)', gx: 24480.0, gy: 105000.0, gz: 350.0, continentWanted: 1 },
    { name: 'Eastern Dericost (lbX = 156, e.g. Shakrassekor)', gx: 30000.0, gy: 82000.0, gz: 180.0, continentWanted: 1 },
    { name: 'Eastern Dericost (East Boundary)', gx: 48950.0, gy: 110000.0, gz: 500.0, continentWanted: 1 },
  ];

  for (const tc of testCoords) {
    const local = toCellLocal(tc.gx, tc.gy, tc.gz);
    const continentBit = (local.cell >>> 15) & 1;
    const isOcean = tc.gy >= 48960.0 && tc.gy < 68928.0;
    const expectedY = isOcean ? 48960.0 : tc.gy;
    const expectedX = tc.gx;

    // Check continent detection
    const continentCorrect = local.continent === tc.continentWanted;
    check(
      `4.1 [${tc.name}]: toCellLocal continent property matches expected (${tc.continentWanted})`,
      continentCorrect,
      `Got continent=${local.continent}, wanted=${tc.continentWanted}`
    );

    // Check Continent Bit 15
    const continentBitMatches = continentBit === tc.continentWanted;
    check(
      `4.2 [${tc.name}]: Continent Bit 15 of cell matches continent flag (${tc.continentWanted})`,
      continentBitMatches,
      `Bit 15 is ${continentBit}, but wanted continent is ${tc.continentWanted} (Cell = 0x${local.cell.toString(16)})`
    );

    // Check toGlobal reconstruction with explicit continent parameter
    const reconstructedWithCont = toGlobal(local.cell, local.x, local.y, local.z, local.continent);
    const xDiffCont = Math.abs(reconstructedWithCont[0] - expectedX);
    const yDiffCont = Math.abs(reconstructedWithCont[1] - expectedY);
    const roundtripWithContMatches = xDiffCont < 0.05 && yDiffCont < 0.05;
    check(
      `4.3 [${tc.name}]: toGlobal(cell, x, y, z, continent) round-trip matches global coords`,
      roundtripWithContMatches,
      `Reconstructed: [${reconstructedWithCont[0].toFixed(2)}, ${reconstructedWithCont[1].toFixed(2)}], expected: [${expectedX}, ${expectedY}], dx=${xDiffCont.toFixed(2)}, dy=${yDiffCont.toFixed(2)}`
    );

    // Check toGlobal reconstruction WITHOUT explicit continent parameter (legacy 4-arg signature)
    const reconstructedLegacy = toGlobal(local.cell, local.x, local.y, local.z);
    const xDiffLeg = Math.abs(reconstructedLegacy[0] - expectedX);
    const yDiffLeg = Math.abs(reconstructedLegacy[1] - expectedY);
    const legacyMatches = xDiffLeg < 0.05 && yDiffLeg < 0.05;
    check(
      `4.4 [${tc.name}]: toGlobal(cell, x, y, z) 4-arg default round-trip matches global coords`,
      legacyMatches,
      `Reconstructed: [${reconstructedLegacy[0].toFixed(2)}, ${reconstructedLegacy[1].toFixed(2)}], expected: [${expectedX}, ${expectedY}], dx=${xDiffLeg.toFixed(2)}, dy=${yDiffLeg.toFixed(2)}`
    );
  }
}

// --------------------------------------------------------------------
// SUITE 5: Server-Side Vehicle.cs Inversion Parity Stress
// --------------------------------------------------------------------
console.log('\n>>> TEST SUITE 5: Server-Side Vehicle.cs / LandblockManager.cs Math Emulation <<<');

{
  // Replicating Server Vehicle.cs ToPosition and ToGlobal verbatim
  function serverToPosition(gx, gy, gz) {
    const DericostYOffset = 68928.0;
    const continent = gy >= DericostYOffset ? 1 : 0;
    const localGy = continent === 1 ? gy - DericostYOffset : gy;
    let lbX = Math.floor(gx / 192.0);
    let lbY = Math.floor(localGy / 192.0);
    lbX = Math.max(0, Math.min(254, lbX));
    lbY = Math.max(0, Math.min(254, lbY));
    const lx = Math.max(0.0, Math.min(191.999, gx - lbX * 192.0));
    const ly = Math.max(0.0, Math.min(191.999, localGy - lbY * 192.0));
    const cellX = Math.floor(lx / 24.0);
    const cellY = Math.floor(ly / 24.0);
    const cell = (((lbX << 24) | (lbY << 16) | ((continent & 1) << 15) | (cellX * 8 + cellY + 1)) >>> 0);
    return { cell, x: lx, y: ly, z: gz };
  }

  function serverToGlobal1(p) {
    const DericostYOffset = 68928.0;
    const continent = (p.cell >>> 15) & 1;
    const x = ((p.cell >>> 24) & 0xFF) * 192.0 + p.x;
    const y = (continent === 1 ? DericostYOffset : 0.0) + ((p.cell >>> 16) & 0xFF) * 192.0 + p.y;
    return { x, y, z: p.z, continent };
  }

  function serverToGlobal2(p, continent) {
    const DericostYOffset = 68928.0;
    const isDericost = continent === 1;
    const x = ((p.cell >>> 24) & 0xFF) * 192.0 + p.x;
    const y = (isDericost ? DericostYOffset : 0.0) + ((p.cell >>> 16) & 0xFF) * 192.0 + p.y;
    return { x, y, z: p.z };
  }

  // Test 1: Eastern Dereth location (Holtburg, gx = 32448.0, gy = 28800.0)
  const holtburg = { gx: 32448.0, gy: 28800.0, gz: 177.0 };
  const holtburgPos = serverToPosition(holtburg.gx, holtburg.gy, holtburg.gz);
  const holtburgGlobal1 = serverToGlobal1(holtburgPos);

  check(
    '5.1: Server Vehicle.ToGlobal(p) on Eastern Dereth (gx=32448) does not teleport to Dericost',
    holtburgGlobal1.continent === 0 && Math.abs(holtburgGlobal1.y - holtburg.gy) < 0.1,
    `Teleported! continent=${holtburgGlobal1.continent}, y=${holtburgGlobal1.y} (expected ${holtburg.gy}, error=${holtburgGlobal1.y - holtburg.gy}m)`
  );

  check(
    '5.2: Server Vehicle.ToGlobal(p) on Eastern Dereth (gx=32448) preserves X coordinate',
    Math.abs(holtburgGlobal1.x - holtburg.gx) < 0.1,
    `X truncated! x=${holtburgGlobal1.x} (expected ${holtburg.gx}, error=${holtburgGlobal1.x - holtburg.gx}m)`
  );

  // Test 2: Eastern Dericost location (Shakrassekor, gx = 30000.0, gy = 82000.0)
  const dericostEast = { gx: 30000.0, gy: 82000.0, gz: 180.0 };
  const dericostPos = serverToPosition(dericostEast.gx, dericostEast.gy, dericostEast.gz);
  const dericostGlobal1 = serverToGlobal1(dericostPos);
  const dericostGlobal2 = serverToGlobal2(dericostPos, 1);

  check(
    '5.3: Server Vehicle.ToGlobal(p) on Eastern Dericost (gx=30000) preserves X coordinate',
    Math.abs(dericostGlobal1.x - dericostEast.gx) < 0.1,
    `X truncated! x=${dericostGlobal1.x} (expected ${dericostEast.gx}, error=${dericostGlobal1.x - dericostEast.gx}m)`
  );

  check(
    '5.4: Server Vehicle.ToGlobal(p, continent=1) on Eastern Dericost preserves X coordinate',
    Math.abs(dericostGlobal2.x - dericostEast.gx) < 0.1,
    `X truncated! x=${dericostGlobal2.x} (expected ${dericostEast.gx}, error=${dericostGlobal2.x - dericostEast.gx}m)`
  );
}

// --------------------------------------------------------------------
// SUITE 6: Streaming Gates & Ocean Gaps
// --------------------------------------------------------------------
console.log('\n>>> TEST SUITE 6: Client Streaming Gates (world_stream.js) <<<');

{
  check('6.1: isOceanCorridor returns false at Dereth north coast (48959.9m)', !worldStream.isOceanCorridor({ gy: 48959.9 }));
  check('6.2: isOceanCorridor returns true at exact ocean start (48960.0m)', worldStream.isOceanCorridor({ gy: 48960.0 }));
  check('6.3: isOceanCorridor returns true mid-ocean (58944.0m)', worldStream.isOceanCorridor({ gy: 58944.0 }));
  check('6.4: isOceanCorridor returns true south of landfall (68927.9m)', worldStream.isOceanCorridor({ gy: 68927.9 }));
  check('6.5: isOceanCorridor returns false at Dericost landfall (68928.0m)', !worldStream.isOceanCorridor({ gy: 68928.0 }));
}

// --------------------------------------------------------------------
// SUMMARY
// --------------------------------------------------------------------
console.log('\n======================================================================');
console.log(`TOTAL TESTS: ${passedCount + failedCount}`);
console.log(`PASSED:      ${passedCount}`);
console.log(`FAILED:      ${failedCount}`);
console.log('======================================================================');

if (failedCount > 0) {
  console.log('\n--- FINDINGS SUMMARY ---');
  for (const f of findings) {
    console.log(`- ${f.desc}`);
    console.log(`  Details: ${f.detail}`);
  }
}
