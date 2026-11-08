/**
 * Feature 2: Forward Run Speed (4.0 * run_rate m/s)
 * Authoritative baseline: acclient.c:343565, MovementSystem.cs:13
 */

'use strict';

const {
  CONSTANTS,
  getStateVelocity,
  applyRunToCommand,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 2: Forward Run Speed', 1);

// Test 2.1: Nominal forward run speed at run_rate = 1.0 is exactly 4.0 m/s
suite.addTest('2.1 Base forward run velocity at run_rate=1.0 is exactly 4.0 m/s', () => {
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, 1.0, 0, 0.0, 1.0);
  assertNear(vel.vy, CONSTANTS.RUN_ANIM_SPEED, 1e-4, 'Run speed Vy matches 4.0 m/s');
  assertEquals(vel.vx, 0.0, 'Lateral velocity is 0');
  assertEquals(vel.vz, 0.0, 'Vertical velocity is 0');
  assertNear(vel.mag, 4.0, 1e-4, 'Magnitude matches 4.0 m/s');
});

// Test 2.2: Forward run speed scales linearly with run_rate
suite.addTest('2.2 Forward run speed scales linearly with run_rate multiplier (1.5x, 2.0x)', () => {
  const vel15 = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, 1.5, 0, 0.0, 1.5);
  assertNear(vel15.vy, 6.0, 1e-4, 'Run speed at run_rate=1.5 is 6.0 m/s');

  const vel20 = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, 2.0, 0, 0.0, 2.0);
  assertNear(vel20.vy, 8.0, 1e-4, 'Run speed at run_rate=2.0 is 8.0 m/s');
});

// Test 2.3: WalkForward is promoted to RunForward when Run mode is active and speed > 0
suite.addTest('2.3 WalkForward promotes to RunForward under run modifier', () => {
  const res = applyRunToCommand(CONSTANTS.CMD_WALK_FORWARD, 1.0, 1.75);
  assertEquals(res.command, CONSTANTS.CMD_RUN_FORWARD, 'Command promoted to RunForward');
  assertNear(res.speed, 1.75, 1e-4, 'Speed multiplied by run_rate');
});

// Test 2.4: Authored run clip velocity in DAT 0x09000001 (3.2m / 24 frames @ 30 fps)
suite.addTest('2.4 Authored run clip displacement matches 4.0 m/s exactly', () => {
  const duration = CONSTANTS.RUN_AUTHORED_FRAMES / CONSTANTS.RUN_AUTHORED_FPS;
  const clipVel = CONSTANTS.RUN_AUTHORED_METERS / duration;
  assertNear(clipVel, 4.0000, 1e-4, 'Authored clip velocity matches 4.0 m/s');
});

// Test 2.5: Zero vertical component during flat forward running
suite.addTest('2.5 Grounded forward run maintains zero vertical velocity', () => {
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, 2.5, 0, 0.0, 2.5);
  assertEquals(vel.vz, 0.0, 'Vz remains 0 on level ground');
});

module.exports = suite;
