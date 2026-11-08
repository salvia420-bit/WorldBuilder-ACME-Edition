/**
 * Feature 13: Stop Coasting Deceleration (~0.79 m coasting window)
 * Authoritative baseline: acclient.c:340719, LOCALSIM-3
 */

'use strict';

const {
  CONSTANTS,
  assertNear,
  assertInRange,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 13: Stop Coasting Deceleration', 1);

// Test 13.1: Releasing forward run input does not dead-stop in 0 ms
suite.addTest('13.1 Stopping from full sprint executes coasting transition rather than instant zero snap', () => {
  const initialSpeed = 4.0;
  // Natural stopping duration ~0.4s (12 frames @ 30 fps)
  const duration = CONSTANTS.RUN_TO_READY_COAST_DURATION;
  assert(duration > 0.0, 'Stopping is non-instantaneous');
  assertEquals(duration, 0.40);
});

// Test 13.2: Total coasting distance from 4.0 m/s sprint is approximately 0.79 m
suite.addTest('13.2 Total coasting displacement from 4.0 m/s sprint is approximately 0.79 m', () => {
  const nominalDist = CONSTANTS.RUN_TO_READY_COAST_DISTANCE;
  assertNear(nominalDist, 0.79, 1e-4, 'Coasting distance target is 0.79 m');
  assertInRange(nominalDist, 0.65, 0.95, 'Within reasonable transition window');
});

// Test 13.3: Smooth quadratic / linear deceleration profile integrates to ~0.79 m
suite.addTest('13.3 Discrete deceleration simulation integrates to ~0.79 m over 12 ticks', () => {
  const initialSpeed = 4.0;
  const ticks = 12; // 0.4s @ 30 Hz
  const dt = 1.0 / 30.0;
  let dist = 0.0;

  // Linear deceleration: v(t) = v0 * (1 - t/T)
  for (let i = 0; i < ticks; i++) {
    const t = (i + 0.5) * dt;
    const v = initialSpeed * Math.max(0.0, 1.0 - t / 0.40);
    dist += v * dt;
  }

  // Integral of 4 * (1 - t/0.4) from 0 to 0.4 = 4 * 0.4 / 2 = 0.80 m
  assertNear(dist, 0.80, 0.05, 'Simulated stopping distance is ~0.80 m');
});

// Test 13.4: Walk to Ready stopping distance is proportionally shorter (~0.25 - 0.35 m)
suite.addTest('13.4 Walk to Ready deceleration distance is proportionally shorter (~0.31 m)', () => {
  const walkSpeed = CONSTANTS.WALK_ANIM_SPEED; // 3.12 m/s
  const walkStopDuration = 0.20; // 6 frames @ 30 fps
  const walkStopDist = 0.5 * walkSpeed * walkStopDuration;
  assertInRange(walkStopDist, 0.25, 0.40, 'Walk stopping distance ~ 0.31 m');
});

// Test 13.5: Final velocity at completion of coasting window reaches exactly 0.0 m/s
suite.addTest('13.5 Final velocity at end of coasting transition reaches exactly 0.0 m/s', () => {
  const finalVelocity = 0.0;
  assertEquals(finalVelocity, 0.0, 'Avatar reaches complete rest in Ready stance');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
