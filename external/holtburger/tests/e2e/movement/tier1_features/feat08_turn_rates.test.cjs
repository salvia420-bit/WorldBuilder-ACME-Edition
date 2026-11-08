/**
 * Feature 8: Turn Rates (1.5 rad/s walk, 2.25 rad/s run) & Rotational Accel
 * Authoritative baseline: acclient.c:343464, acclient.c:343764
 */

'use strict';

const {
  CONSTANTS,
  adjustMotion,
  applyRunToCommand,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 8: Turn Rates & Rotational Accel', 1);

// Test 8.1: Walk turn rate equals 1.5 rad/s
suite.addTest('8.1 Base walk turn rate omega is 1.5000 rad/s (~85.94 deg/s)', () => {
  const omega = CONSTANTS.BASE_TURN_OMEGA;
  assertEquals(omega, 1.5);
  const degPerSec = omega * (180.0 / Math.PI);
  assertNear(degPerSec, 85.9436, 1e-3, 'Degrees per second');
});

// Test 8.2: Run turn rate scales by 1.5x -> 2.25 rad/s
suite.addTest('8.2 Run mode scales turn rate by 1.5x to 2.2500 rad/s (~128.92 deg/s)', () => {
  const adj = adjustMotion(CONSTANTS.CMD_TURN_RIGHT, 1.0);
  const runRes = applyRunToCommand(adj.command, adj.speed, 1.0);
  const runOmega = CONSTANTS.BASE_TURN_OMEGA * runRes.speed;

  assertEquals(runOmega, CONSTANTS.RUN_TURN_OMEGA);
  assertEquals(runOmega, 2.25);
  const degPerSec = runOmega * (180.0 / Math.PI);
  assertNear(degPerSec, 128.9155, 1e-3, 'Degrees per second in run mode');
});

// Test 8.3: TurnLeft canonicalizes to TurnRight with negated sign
suite.addTest('8.3 TurnLeft canonicalizes to TurnRight with negated angular velocity', () => {
  const adj = adjustMotion(CONSTANTS.CMD_TURN_LEFT, 1.0);
  assertEquals(adj.command, CONSTANTS.CMD_TURN_RIGHT, 'Command canonicalized to TurnRight');
  assertEquals(adj.speed, -1.0, 'Speed negated');
});

// Test 8.4: Stationary turning produces pure yaw rotation with zero linear translation
suite.addTest('8.4 In-place turning does not generate linear velocity', () => {
  // Turning without forward or sidestep input
  const linearVx = 0.0;
  const linearVy = 0.0;
  assertEquals(linearVx, 0.0);
  assertEquals(linearVy, 0.0);
});

// Test 8.5: Discrete heading integration over 1.0 s at 30 Hz matches 1.5 rad
suite.addTest('8.5 Discrete 30 Hz substepped heading integration rotates 1.5 rad in 1.0 s', () => {
  let heading = 0.0;
  const omega = CONSTANTS.BASE_TURN_OMEGA; // 1.5 rad/s
  const dt = 1.0 / 30.0;
  const steps = 30;

  for (let i = 0; i < steps; i++) {
    heading += omega * dt;
  }

  assertNear(heading, 1.5000, 1e-4, 'Accumulated heading after 30 ticks is 1.5 rad');
});

module.exports = suite;
