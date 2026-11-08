/**
 * Tier 2 Boundary: Backward Walk Speed
 * Authoritative baseline: acclient.c:343769, acclient.c:343455
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

const suite = require('../harness.cjs').createSuite('Boundary 4: Backward Walk Speed', 2);

// Test B4.1: Backward movement with Run skill = 800 and Run held remains -2.028 m/s
suite.addTest('B4.1 God-mode Run skill 800 with Run active cannot boost backward walk speed', () => {
  const adj = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  const runRes = applyRunToCommand(adj.command, adj.speed, 4.5); // run_rate 4.5
  assertEquals(runRes.command, CONSTANTS.CMD_WALK_FORWARD, 'Never promoted to RunForward');
  assertNear(runRes.speed, CONSTANTS.BACKWARDS_FACTOR, 1e-4, 'Speed unscaled by 4.5');

  const vel = getStateVelocity(runRes.command, runRes.speed, 0, 0.0, 4.5);
  assertNear(vel.vy, -2.028, 1e-3, 'Vy remains -2.028 m/s');
});

// Test B4.2: Backward walk with zero stamina retains -2.028 m/s
suite.addTest('B4.2 Stamina exhaustion (stamina=0) does not penalize backward walk', () => {
  const adj = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  const vel = getStateVelocity(adj.command, adj.speed, 0, 0.0, 1.0);
  assertNear(vel.vy, -2.028, 1e-3, 'Vy remains -2.028 m/s at 0 stamina');
});

// Test B4.3: Backward walk under max load = 2.0 does not invert or amplify speed
suite.addTest('B4.3 Max burden load = 2.0 preserves negative velocity sign without inversion', () => {
  const adj = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  const vel = getStateVelocity(adj.command, adj.speed, 0, 0.0, 1.0);
  assert(vel.vy < 0.0, 'Vy remains strictly negative');
});

// Test B4.4: Immediate transition from Forward Run to Backward Walk flips sign cleanly
suite.addTest('B4.4 Forward Run to Backward Walk instant toggle flips velocity sign without overshoot', () => {
  const fwd = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, 1.0, 0, 0.0, 1.0);
  assertEquals(fwd.vy, 4.0);

  const adjBack = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  const back = getStateVelocity(adjBack.command, adjBack.speed, 0, 0.0, 1.0);
  assertNear(back.vy, -2.028, 1e-3);
});

// Test B4.5: Zero backward input releases to 0.0 m/s
suite.addTest('B4.5 Zero backward speed input produces exactly 0.0 m/s', () => {
  const adj = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 0.0);
  const vel = getStateVelocity(adj.command, adj.speed, 0, 0.0, 1.0);
  assertEquals(vel.vy, 0.0);
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
