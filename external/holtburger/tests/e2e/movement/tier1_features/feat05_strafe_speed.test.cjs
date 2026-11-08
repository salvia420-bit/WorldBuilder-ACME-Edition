/**
 * Feature 5: Sidestep / Strafe Speed (1.56 / 3.75 m/s)
 * Authoritative baseline: acclient.c:343475, acclient.c:343786
 */

'use strict';

const {
  CONSTANTS,
  adjustMotion,
  applyRunToCommand,
  getStateVelocity,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 5: Sidestep / Strafe Speed', 1);

// Test 5.1: Walk Right Strafe local velocity is exactly +1.56 m/s
suite.addTest('5.1 Walk Right Strafe yields local velocity Vx = +1.56 m/s', () => {
  const adj = adjustMotion(CONSTANTS.CMD_SIDESTEP_RIGHT, 1.0);
  assertNear(adj.speed, CONSTANTS.SIDESTEP_ADJUST_FACTOR, 1e-4, 'Adjusted speed ~ 1.248');

  const vel = getStateVelocity(0, 0.0, adj.command, adj.speed, 1.0);
  // Vx = 1.25 * 1.24799996 = 1.55999995 m/s
  assertNear(vel.vx, 1.56, 1e-3, 'Vx matches 1.56 m/s');
  assertEquals(vel.vy, 0.0, 'Vy is 0');
});

// Test 5.2: Walk Left Strafe canonicalizes to SideStepRight with inverted speed Vx = -1.56 m/s
suite.addTest('5.2 Walk Left Strafe canonicalizes to SideStepRight with Vx = -1.56 m/s', () => {
  const adj = adjustMotion(CONSTANTS.CMD_SIDESTEP_LEFT, 1.0);
  assertEquals(adj.command, CONSTANTS.CMD_SIDESTEP_RIGHT, 'Command canonicalized to Right');
  assertNear(adj.speed, -CONSTANTS.SIDESTEP_ADJUST_FACTOR, 1e-4, 'Speed negated');

  const vel = getStateVelocity(0, 0.0, adj.command, adj.speed, 1.0);
  assertNear(vel.vx, -1.56, 1e-3, 'Vx matches -1.56 m/s');
  assertEquals(vel.vy, 0.0, 'Vy is 0');
});

// Test 5.3: Run Strafe with run_rate = 1.0 yields 1.56 m/s
suite.addTest('5.3 Run Strafe at run_rate=1.0 scales by 1.0', () => {
  const adj = adjustMotion(CONSTANTS.CMD_SIDESTEP_RIGHT, 1.0);
  const runRes = applyRunToCommand(adj.command, adj.speed, 1.0);
  const vel = getStateVelocity(0, 0.0, runRes.command, runRes.speed, 1.0);
  assertNear(vel.vx, 1.56, 1e-3, 'Vx at run_rate 1.0 is 1.56 m/s');
});

// Test 5.4: Run Strafe with high run_rate clamps at 3.0 rate modifier -> max 3.75 m/s
suite.addTest('5.4 High-speed Run Strafe clamps to maximum 3.75 m/s (1.25 * 3.0)', () => {
  const adj = adjustMotion(CONSTANTS.CMD_SIDESTEP_RIGHT, 1.0);
  // run_rate = 3.5 -> speed * 3.5 = 1.248 * 3.5 = 4.368 > 3.0 (clamps to 3.0)
  const runRes = applyRunToCommand(adj.command, adj.speed, 3.5);
  assertEquals(runRes.speed, CONSTANTS.MAX_SIDESTEP_ANIM_RATE, 'Clamped to 3.0');

  const vel = getStateVelocity(0, 0.0, runRes.command, runRes.speed, 3.5);
  assertNear(vel.vx, 3.75, 1e-4, 'Vx clamped to 3.75 m/s (1.25 * 3.0)');
});

// Test 5.5: Pure strafe maintains zero forward (Vy) and zero vertical (Vz) velocity
suite.addTest('5.5 Pure strafe preserves zero forward and vertical velocity', () => {
  const adj = adjustMotion(CONSTANTS.CMD_SIDESTEP_RIGHT, 1.0);
  const vel = getStateVelocity(0, 0.0, adj.command, adj.speed, 1.0);
  assertEquals(vel.vy, 0.0, 'Vy must remain 0.0');
  assertEquals(vel.vz, 0.0, 'Vz must remain 0.0');
});

module.exports = suite;
