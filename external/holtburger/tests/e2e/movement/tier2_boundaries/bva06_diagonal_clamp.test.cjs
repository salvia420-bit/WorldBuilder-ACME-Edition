/**
 * Tier 2 Boundary: Diagonal Movement Magnitude Clamp
 * Authoritative baseline: acclient.c:343586-343592
 */

'use strict';

const {
  CONSTANTS,
  getStateVelocity,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 6: Diagonal Movement Magnitude Clamp', 2);

// Test B6.1: Exactly at clamp threshold (unclamped magnitude == max_speed), vector is unperturbed
suite.addTest('B6.1 When vector magnitude equals max_speed exactly, no scaling occurs', () => {
  const runRate = 1.0;
  // If Vx = 0 and Vy = 4.0, mag = 4.0 == max_speed
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, 1.0, 0, 0.0, runRate);
  assertEquals(vel.vy, 4.0);
  assertEquals(vel.vx, 0.0);
  assertEquals(vel.mag, 4.0);
});

// Test B6.2: Extreme high run_rate (4.5) clamps diagonal magnitude to 18.0 m/s
suite.addTest('B6.2 Extreme run_rate = 4.5 clamps diagonal magnitude to exactly 18.0 m/s', () => {
  const runRate = 4.5;
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, runRate, CONSTANTS.CMD_SIDESTEP_RIGHT, CONSTANTS.MAX_SIDESTEP_ANIM_RATE, runRate);
  const maxSpeed = 4.0 * runRate; // 18.0
  assertNear(vel.mag, maxSpeed, 1e-4, 'Clamped magnitude equals 18.0 m/s');
});

// Test B6.3: Near-zero forward speed with max strafe preserves direction under clamp
suite.addTest('B6.3 Near-zero forward speed with max strafe preserves aspect under clamp', () => {
  const runRate = 1.0;
  const tinyFwd = 0.01;
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, tinyFwd, CONSTANTS.CMD_SIDESTEP_RIGHT, CONSTANTS.SIDESTEP_ADJUST_FACTOR, runRate);
  assert(vel.vy > 0.0, 'Vy remains positive');
  assert(vel.vx > 0.0, 'Vx remains positive');
  assert(vel.mag <= 4.0 * runRate, 'Magnitude within cap');
});

// Test B6.4: Near-zero strafe with max forward preserves aspect under clamp
suite.addTest('B6.4 Near-zero strafe with max forward preserves aspect under clamp', () => {
  const runRate = 1.0;
  const tinyStrafe = 0.01;
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, 1.0, CONSTANTS.CMD_SIDESTEP_RIGHT, tinyStrafe, runRate);
  assert(vel.mag <= 4.0 * runRate, 'Magnitude within cap');
  assertNear(vel.vy, 4.0, 1e-3, 'Vy dominates');
});

// Test B6.5: Floating-point precision check: ||V|| - max_speed <= 1e-6
suite.addTest('B6.5 Clamped vector magnitude strictly satisfies ||V|| <= max_speed + 1e-6', () => {
  const rates = [1.0, 1.333, 2.0, 2.718, 3.1415, 4.5];
  for (const r of rates) {
    const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, r, CONSTANTS.CMD_SIDESTEP_RIGHT, CONSTANTS.MAX_SIDESTEP_ANIM_RATE, r);
    const maxSpeed = 4.0 * r;
    assert(vel.mag <= maxSpeed + 1e-6, `Magnitude ${vel.mag} within cap ${maxSpeed}`);
  }
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
