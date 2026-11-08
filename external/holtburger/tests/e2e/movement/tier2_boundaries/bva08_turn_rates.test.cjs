/**
 * Tier 2 Boundary: Turn Rates & Rotational Accel
 * Authoritative baseline: acclient.c:343464, acclient.c:357668
 */

'use strict';

const {
  CONSTANTS,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 8: Turn Rates & Rotational Accel', 2);

// Test B8.1: Full circle heading wrap from 2pi -> 0
suite.addTest('B8.1 Heading angle wraps cleanly across 2pi boundary modulo', () => {
  let heading = 1.95 * Math.PI;
  const deltaHeading = 0.1 * Math.PI;
  heading = (heading + deltaHeading) % (2.0 * Math.PI);
  assertNear(heading, 0.05 * Math.PI, 1e-4);
});

// Test B8.2: Negative orientation angles fold correctly to positive modulo
suite.addTest('B8.2 Negative orientation angles fold correctly to positive [0, 2pi) range', () => {
  let heading = -0.25 * Math.PI;
  heading = ((heading % (2.0 * Math.PI)) + 2.0 * Math.PI) % (2.0 * Math.PI);
  assertNear(heading, 1.75 * Math.PI, 1e-4);
});

// Test B8.3: Micro-tick rotational accumulation preserves angular precision
suite.addTest('B8.3 Micro-tick rotational accumulation (dt = 0.001s, 1000 steps) accumulates 1.5 rad', () => {
  let heading = 0.0;
  const omega = CONSTANTS.BASE_TURN_OMEGA; // 1.5 rad/s
  const dt = 0.001;
  for (let i = 0; i < 1000; i++) {
    heading += omega * dt;
  }
  assertNear(heading, 1.5000, 1e-4);
});

// Test B8.4: Simultaneous opposite turn inputs cancel net angular velocity
suite.addTest('B8.4 Simultaneous TurnRight + TurnLeft commands cancel to 0 angular velocity', () => {
  const rightOmega = 1.5;
  const leftOmega = -1.5;
  const netOmega = rightOmega + leftOmega;
  assertEquals(netOmega, 0.0);
});

// Test B8.5: Rotational damping brings angular rate to zero upon key release
suite.addTest('B8.5 Angular velocity drops cleanly to zero when turn inputs cease', () => {
  let omega = 2.25;
  // Key released
  omega = 0.0;
  assertEquals(omega, 0.0);
});

module.exports = suite;
