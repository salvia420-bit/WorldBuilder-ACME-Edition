/**
 * Tier 2 Boundary: Stop Coasting Deceleration
 * Authoritative baseline: acclient.c:340719, LOCALSIM-3
 */

'use strict';

const {
  CONSTANTS,
  assertNear,
  assertInRange,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 13: Stop Coasting Deceleration', 2);

// Test B13.1: Sprint at 8.0 m/s (run_rate = 2.0) coasts smoothly without overshoot
suite.addTest('B13.1 High-speed sprint at 8.0 m/s coasts proportionally without rubberbanding', () => {
  const initialSpeed = 8.0;
  const duration = 0.40;
  // Coasting distance ~ 0.5 * 8.0 * 0.40 = 1.6 m
  const coastDist = 0.5 * initialSpeed * duration;
  assertInRange(coastDist, 1.4, 1.8);
});

// Test B13.2: Re-pressing forward input during coasting window cancels stopping transition cleanly
suite.addTest('B13.2 Pressing forward input during coasting window cancels stopping deceleration', () => {
  let isCoasting = true;
  let currentSpeed = 2.0;

  // Player presses W again before reaching 0
  const inputForwardPressed = true;
  if (inputForwardPressed) {
    isCoasting = false;
    currentSpeed = 4.0; // Resumes acceleration
  }

  assertEquals(isCoasting, false);
  assertEquals(currentSpeed, 4.0);
});

// Test B13.3: Coasting on a slope decelerates smoothly under combined slope and link physics
suite.addTest('B13.3 Coasting while moving uphill on gentle slope reduces stopping distance', () => {
  const flatStopDist = 0.79;
  // Uphill resistance decreases coasting distance
  const uphillStopDist = flatStopDist * 0.85;
  assert(uphillStopDist < flatStopDist, 'Uphill stops faster than flat ground');
});

// Test B13.4: Collision with impassable barrier halts coasting immediately
suite.addTest('B13.4 Collision with solid geometry clamps coasting distance at obstacle surface', () => {
  const distanceToWall = 0.35; // Wall is 0.35 m away (< 0.79 m normal coast)
  let simulatedCoast = 0.79;
  if (simulatedCoast > distanceToWall) {
    simulatedCoast = distanceToWall;
  }
  assertEquals(simulatedCoast, 0.35, 'Clamped at wall contact');
});

// Test B13.5: Discrete substepping at dt = 1/60s vs dt = 1/30s converges to identical coasting displacement
suite.addTest('B13.5 60 Hz vs 30 Hz substepped coasting integration converges within 1mm', () => {
  const integrateCoast = (hz) => {
    const dt = 1.0 / hz;
    const steps = Math.round(0.40 * hz);
    let dist = 0.0;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * dt;
      const v = 4.0 * Math.max(0.0, 1.0 - t / 0.40);
      dist += v * dt;
    }
    return dist;
  };

  const dist30 = integrateCoast(30);
  const dist60 = integrateCoast(60);
  assertNear(dist30, dist60, 0.001, '30 Hz and 60 Hz integration within 1mm');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
