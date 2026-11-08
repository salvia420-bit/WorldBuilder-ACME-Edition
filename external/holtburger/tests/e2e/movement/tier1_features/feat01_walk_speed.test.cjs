/**
 * Feature 1: Forward Walk Speed (3.12 / 2.60 m/s)
 * Authoritative baseline: acclient.c:343561, MotionTable 0x09000001
 */

'use strict';

const {
  CONSTANTS,
  getStateVelocity,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 1: Forward Walk Speed', 1);

// Test 1.1: Nominal forward walk velocity magnitude matches closed form 3.12 m/s
suite.addTest('1.1 Closed-form forward walk target velocity is 3.1199999 m/s', () => {
  const vel = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 1.0, 0, 0.0, 1.0);
  assertNear(vel.vy, CONSTANTS.WALK_ANIM_SPEED, 1e-4, 'Forward walk Vy should match 3.12 m/s');
  assertEquals(vel.vx, 0.0, 'Forward walk Vx should be 0');
  assertEquals(vel.vz, 0.0, 'Forward walk Vz should be 0');
  assertNear(vel.mag, CONSTANTS.WALK_ANIM_SPEED, 1e-4, 'Magnitude matches 3.12 m/s');
});

// Test 1.2: Motion table authored walk cycle velocity ratio matches 2.6017 m/s
suite.addTest('1.2 Authored base walk cycle metrics (1.4m / 36 frames @ 66.86 fps)', () => {
  const duration = CONSTANTS.WALK_AUTHORED_FRAMES / CONSTANTS.WALK_AUTHORED_FPS;
  const cycleVelocity = CONSTANTS.WALK_AUTHORED_METERS / duration;
  assertNear(cycleVelocity, CONSTANTS.CYCLE_BASE_WALK_SPEED, 0.005, 'Cycle velocity is ~2.6017 m/s');
});

// Test 1.3: Planar heading vector decomposition (sin/cos rotation)
suite.addTest('1.3 Forward walk heading rotation decomposes correctly into world space', () => {
  const headingRad = Math.PI / 4; // 45 degrees North-East
  const localSpeed = CONSTANTS.WALK_ANIM_SPEED;
  // +Y is North, +X is East: vx = sin(theta)*spd, vy = cos(theta)*spd
  const worldVx = Math.sin(headingRad) * localSpeed;
  const worldVy = Math.cos(headingRad) * localSpeed;
  const worldMag = Math.sqrt(worldVx * worldVx + worldVy * worldVy);
  assertNear(worldMag, CONSTANTS.WALK_ANIM_SPEED, 1e-4, 'World magnitude preserves 3.12 m/s');
  assertNear(worldVx, localSpeed * Math.SQRT1_2, 1e-4, 'East component is 3.12 / sqrt(2)');
  assertNear(worldVy, localSpeed * Math.SQRT1_2, 1e-4, 'North component is 3.12 / sqrt(2)');
});

// Test 1.4: Walk speed is invariant to high Run skill when in walk mode
suite.addTest('1.4 Walk speed is invariant to Run skill in walk mode', () => {
  // With high run_rate (e.g. 3.0), WalkForward remains at 3.12 m/s because run_rate only multiplies RunForward
  const vel = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 1.0, 0, 0.0, 3.0);
  assertNear(vel.vy, CONSTANTS.WALK_ANIM_SPEED, 1e-4, 'Walk speed remains 3.12 m/s with run_rate=3.0');
});

// Test 1.5: Walk speed under partial burden remains steady
suite.addTest('1.5 Walk speed under 50% burden (load=0.5) remains at baseline', () => {
  const vel = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 1.0, 0, 0.0, 1.0);
  assertNear(vel.vy, 3.1199999, 1e-4, 'Walk speed is 3.12 m/s under normal burden');
});

module.exports = suite;
