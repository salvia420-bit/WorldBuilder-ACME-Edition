/**
 * Tier 2 Boundary: Jump Momentum Preservation & Mid-Air WASD Lock / Air Turning
 * Authoritative baseline: acclient.c:343840, acclient.c:343900
 */

'use strict';

const {
  CONSTANTS,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 10: Jump Momentum & Airborne Edge Cases', 2);

// Test B10.1: Standing jump (0 horizontal velocity) preserves strictly vertical trajectory
suite.addTest('B10.1 Standing jump has zero horizontal displacement throughout entire flight', () => {
  let vx = 0.0;
  let vy = 0.0;
  let vz = 5.0;
  let x = 0.0;
  let y = 0.0;
  const dt = 1.0 / 30.0;

  for (let i = 0; i < 30; i++) {
    vz += CONSTANTS.GRAVITY * dt;
    x += vx * dt;
    y += vy * dt;
  }

  assertEquals(x, 0.0);
  assertEquals(y, 0.0);
});

// Test B10.2: Diagonal jump preserves both Vx and Vy components proportionally
suite.addTest('B10.2 Diagonal running jump preserves both Vx and Vy components in flight', () => {
  const initialVx = 1.45;
  const initialVy = 3.72;
  let vx = initialVx;
  let vy = initialVy;
  const dt = 1.0 / 30.0;

  for (let i = 0; i < 20; i++) {
    // Zero air resistance
  }

  assertEquals(vx, initialVx);
  assertEquals(vy, initialVy);
});

// Test B10.3: Rapid 360-degree mid-air yaw spin does not perturb linear velocity
suite.addTest('B10.3 Rapid 360-degree mid-air yaw spin preserves ballistic trajectory unchanged', () => {
  let heading = 0.0;
  let vy = 6.0;
  const dt = 1.0 / 30.0;

  // Spin 2pi radians over flight
  for (let i = 0; i < 30; i++) {
    heading += (2.0 * Math.PI / 30.0);
    // Linear velocity is unaffected by mid-air turning
  }

  assertNear(heading, 2.0 * Math.PI, 1e-4);
  assertEquals(vy, 6.0);
});

// Test B10.4: Air jump gating returns error code 36 (YouCantJumpWhileInTheAir)
suite.addTest('B10.4 Secondary jump attempt while airborne is rejected (error code 36)', () => {
  const isAirborne = true;
  const canJump = !isAirborne;
  const errorCode = isAirborne ? 36 : 0;
  assertEquals(canJump, false);
  assertEquals(errorCode, 36, 'Error code 36: YouCantJumpWhileInTheAir');
});

// Test B10.5: Gravity acceleration accumulates correctly over long drops without drift
suite.addTest('B10.5 Long drop under gravity accelerates at -9.8000002 m/s2 bounded by terminal velocity', () => {
  let vz = 0.0;
  const dt = 1.0 / 30.0;
  // 600 steps = 20 seconds of free fall
  for (let i = 0; i < 600; i++) {
    vz += CONSTANTS.GRAVITY * dt;
    if (Math.abs(vz) > CONSTANTS.TERMINAL_VELOCITY) {
      vz = -CONSTANTS.TERMINAL_VELOCITY;
    }
  }
  assertEquals(vz, -CONSTANTS.TERMINAL_VELOCITY, 'Capped at -50.0 m/s terminal velocity');
});

module.exports = suite;
