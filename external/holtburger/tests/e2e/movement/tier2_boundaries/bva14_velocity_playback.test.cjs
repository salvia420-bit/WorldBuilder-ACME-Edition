/**
 * Tier 2 Boundary: Velocity-to-Playback Scaling & Invariant Synchrony
 * Authoritative baseline: acclient.c:337445, entities.js
 */

'use strict';

const {
  calcTimeScale,
  assertEquals,
  assertNear
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 14: Velocity Playback Scaling Clamping', 2);

// Test B14.1: Lower bound clamp: speeds below 1.0 m/s clamp timeScale at 0.25
suite.addTest('B14.1 Run playback timeScale floors at lower bound 0.25', () => {
  const tsTiny = calcTimeScale(0.5, true); // 0.5 / 4.0 = 0.125 < 0.25
  assertEquals(tsTiny, 0.25, 'Floored at 0.25');

  const tsMicro = calcTimeScale(0.1, true);
  assertEquals(tsMicro, 0.25, 'Floored at 0.25');
});

// Test B14.2: Upper bound clamp: speeds above 16.0 m/s clamp timeScale at 4.0
suite.addTest('B14.2 Run playback timeScale caps at upper bound 4.0', () => {
  const tsHigh = calcTimeScale(18.0, true); // 18.0 / 4.0 = 4.5 > 4.0
  assertEquals(tsHigh, 4.0, 'Capped at 4.0');

  const tsExtreme = calcTimeScale(50.0, true);
  assertEquals(tsExtreme, 4.0, 'Capped at 4.0');
});

// Test B14.3: Zero speed produces lower clamp bound without division by zero
suite.addTest('B14.3 Zero ground speed evaluates safely without NaN or Infinity', () => {
  const tsZero = calcTimeScale(0.0, true);
  assertEquals(tsZero, 0.25);
});

// Test B14.4: Negative speed (backward walk) evaluates absolute magnitude
suite.addTest('B14.4 Negative speed input evaluates absolute magnitude for playback scaling', () => {
  const tsBack = calcTimeScale(-2.028, false); // 2.028 / 2.6017 = 0.7795
  assertNear(tsBack, 2.028 / 2.6017, 1e-4);
});

// Test B14.5: Smooth linear scaling across intermediate velocities (2.0 to 8.0 m/s)
suite.addTest('B14.5 Continuous linear scaling across normal gameplay range [2.0, 8.0] m/s', () => {
  for (let s = 2.0; s <= 8.0; s += 1.0) {
    const ts = calcTimeScale(s, true);
    assertEquals(ts, s / 4.0);
  }
});

module.exports = suite;
