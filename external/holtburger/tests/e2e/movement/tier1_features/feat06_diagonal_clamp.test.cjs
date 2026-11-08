/**
 * Feature 6: Diagonal Movement Magnitude Clamp (4.0 * run_rate)
 * Authoritative baseline: acclient.c:343586-343592
 */

'use strict';

const {
  CONSTANTS,
  getStateVelocity,
  assertNear,
  assert
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 6: Diagonal Movement Magnitude Clamp', 1);

// Test 6.1: Diagonal Run (W + D) unclamped magnitude exceeds 4.0 * run_rate and is clamped
suite.addTest('6.1 Diagonal Run (W + D) is clamped to exactly 4.0 * run_rate', () => {
  const runRate = 1.0;
  // Vy = 4.0 * 1.0 = 4.0, Vx = 1.25 * 1.248 = 1.56
  // Unclamped magnitude = sqrt(4.0^2 + 1.56^2) = sqrt(18.4336) = 4.2934 m/s
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, 1.0, CONSTANTS.CMD_SIDESTEP_RIGHT, CONSTANTS.SIDESTEP_ADJUST_FACTOR, runRate);

  const maxSpeed = 4.0 * runRate;
  assertNear(vel.mag, maxSpeed, 1e-4, 'Clamped magnitude matches 4.0 * run_rate');
  assert(vel.vy < 4.0, 'Forward velocity is scaled down under clamp');
  assert(vel.vx < 1.56, 'Lateral velocity is scaled down under clamp');
});

// Test 6.2: Diagonal Run symmetry for Left Strafe (W + A)
suite.addTest('6.2 Diagonal Run (W + A) preserves symmetry with negative Vx', () => {
  const runRate = 1.0;
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, 1.0, CONSTANTS.CMD_SIDESTEP_RIGHT, -CONSTANTS.SIDESTEP_ADJUST_FACTOR, runRate);

  assertNear(vel.mag, 4.0, 1e-4, 'Clamped magnitude is 4.0 m/s');
  assert(vel.vx < 0.0, 'Vx is negative for Left Strafe');
  assert(vel.vy > 0.0, 'Vy is positive for Forward Run');
});

// Test 6.3: Direction angle is preserved through clamping
suite.addTest('6.3 Clamping scales vector proportionally preserving travel direction angle', () => {
  const runRate = 1.5;
  const unscaledVx = 1.25 * (CONSTANTS.SIDESTEP_ADJUST_FACTOR * runRate);
  const unscaledVy = 4.0 * runRate;
  const originalAngle = Math.atan2(unscaledVy, unscaledVx);

  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, runRate, CONSTANTS.CMD_SIDESTEP_RIGHT, CONSTANTS.SIDESTEP_ADJUST_FACTOR * runRate, runRate);
  const clampedAngle = Math.atan2(vel.vy, vel.vx);

  assertNear(clampedAngle, originalAngle, 1e-4, 'Direction angle must remain identical after clamping');
});

// Test 6.4: Diagonal Walk (W + D in walk mode) is NOT clamped if mag < max_speed
suite.addTest('6.4 Diagonal Walk does not clamp when total magnitude is below 4.0 m/s', () => {
  const runRate = 1.0;
  // Walk Vy = 3.12, Vx = 1.56 -> mag = sqrt(3.12^2 + 1.56^2) = 3.488 m/s < 4.0 m/s
  const vel = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 1.0, CONSTANTS.CMD_SIDESTEP_RIGHT, CONSTANTS.SIDESTEP_ADJUST_FACTOR, runRate);

  assertNear(vel.vy, CONSTANTS.WALK_ANIM_SPEED, 1e-4, 'Vy retains full walk speed 3.12');
  assertNear(vel.vx, 1.56, 1e-3, 'Vx retains full strafe speed 1.56');
  assertNear(vel.mag, Math.sqrt(3.12 * 3.12 + 1.56 * 1.56), 1e-3, 'Magnitude unscaled');
});

// Test 6.5: High run_rate diagonal clamping scales with run_rate
suite.addTest('6.5 High run_rate=2.5 clamps diagonal sprint to 10.0 m/s (4.0 * 2.5)', () => {
  const runRate = 2.5;
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, runRate, CONSTANTS.CMD_SIDESTEP_RIGHT, CONSTANTS.MAX_SIDESTEP_ANIM_RATE, runRate);
  assertNear(vel.mag, 10.0, 1e-4, 'Magnitude matches 4.0 * 2.5 = 10.0 m/s');
});

module.exports = suite;
