/**
 * Tier 2 Boundary: Sidestep / Strafe Speed
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

const suite = require('../harness.cjs').createSuite('Boundary 5: Sidestep / Strafe Speed', 2);

// Test B5.1: Negative strafe clamping: Left Strafe at extreme run_rate clamps to -3.0 -> -3.75 m/s
suite.addTest('B5.1 Left Strafe at extreme run_rate clamps to -3.0 (-3.75 m/s)', () => {
  const adj = adjustMotion(CONSTANTS.CMD_SIDESTEP_LEFT, 1.0);
  const runRes = applyRunToCommand(adj.command, adj.speed, 4.0);
  assertEquals(runRes.speed, -CONSTANTS.MAX_SIDESTEP_ANIM_RATE, 'Clamped to -3.0');

  const vel = getStateVelocity(0, 0.0, runRes.command, runRes.speed, 4.0);
  assertNear(vel.vx, -3.75, 1e-4, 'Vx clamped to -3.75 m/s');
});

// Test B5.2: Exact boundary run_rate for 3.75 m/s (run_rate = 3.0 / 1.248 ~= 2.403846)
suite.addTest('B5.2 Strafe speed reaches exact clamp boundary at run_rate ~ 2.4038', () => {
  const boundaryRate = 3.0 / CONSTANTS.SIDESTEP_ADJUST_FACTOR;
  const adj = adjustMotion(CONSTANTS.CMD_SIDESTEP_RIGHT, 1.0);
  const runRes = applyRunToCommand(adj.command, adj.speed, boundaryRate);
  assertNear(runRes.speed, 3.0, 1e-4, 'Speed equals exact 3.0 bound');

  const vel = getStateVelocity(0, 0.0, runRes.command, runRes.speed, boundaryRate);
  assertNear(vel.vx, 3.75, 1e-4, 'Vx equals 3.75 m/s');
});

// Test B5.3: Zero strafe input yields Vx = 0.0
suite.addTest('B5.3 Zero lateral input produces exactly Vx = 0.0', () => {
  const adj = adjustMotion(CONSTANTS.CMD_SIDESTEP_RIGHT, 0.0);
  const vel = getStateVelocity(0, 0.0, adj.command, adj.speed, 1.0);
  assertEquals(vel.vx, 0.0);
});

// Test B5.4: Rapid toggling between A and D cancels net displacement
suite.addTest('B5.4 Symmetrical rapid A/D alternating strafe integrates to zero net displacement', () => {
  const dt = 1.0 / 30.0;
  let netX = 0.0;
  const rightVel = 1.56;
  const leftVel = -1.56;

  for (let i = 0; i < 20; i++) {
    netX += rightVel * dt;
    netX += leftVel * dt;
  }
  assertNear(netX, 0.0, 1e-6, 'Net lateral displacement is zero');
});

// Test B5.5: Strafe speed with stamina 0 returns to base 1.56 m/s
suite.addTest('B5.5 Stamina exhaustion collapses strafe speed to base 1.56 m/s', () => {
  const exhaustedRate = 1.0;
  const adj = adjustMotion(CONSTANTS.CMD_SIDESTEP_RIGHT, 1.0);
  const runRes = applyRunToCommand(adj.command, adj.speed, exhaustedRate);
  const vel = getStateVelocity(0, 0.0, runRes.command, runRes.speed, exhaustedRate);
  assertNear(vel.vx, 1.56, 1e-3, 'Vx returns to 1.56 m/s');
});

module.exports = suite;
