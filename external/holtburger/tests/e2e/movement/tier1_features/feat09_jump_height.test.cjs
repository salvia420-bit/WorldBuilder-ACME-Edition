/**
 * Feature 9: Jump Height, Vertical Impulse (vz = sqrt(19.6 h)), Min 0.35 m
 * Authoritative baseline: acclient.c:713808, acclient.c:443780
 */

'use strict';

const {
  CONSTANTS,
  calcJumpHeight,
  calcJumpLaunchVelocity,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 9: Jump Height & Vertical Impulse', 1);

// Test 9.1: Jump height with jumpSkill=0 clamps to minimum floor 0.35 m
suite.addTest('9.1 Jump height with jumpSkill=0 floors to minimum 0.35 m', () => {
  const h = calcJumpHeight(0.0, 0, 1.0, 100);
  assertEquals(h, CONSTANTS.JUMP_MIN_HEIGHT, 'Height floored at 0.35 m');
});

// Test 9.2: Minimum vertical launch impulse for h = 0.35 m equals sqrt(19.6 * 0.35) ~= 2.61916 m/s
suite.addTest('9.2 Minimum launch vertical impulse is sqrt(19.6 * 0.35) = 2.61916 m/s', () => {
  const vz = calcJumpLaunchVelocity(CONSTANTS.JUMP_MIN_HEIGHT);
  assertNear(vz, CONSTANTS.JUMP_MIN_IMPULSE, 1e-4, 'vz matches 2.61916 m/s');
  assertNear(vz, Math.sqrt(6.86), 1e-5, 'Exact sqrt(6.86)');
});

// Test 9.3: Moderate jump height at jumpSkill = 200 matches formula
suite.addTest('9.3 Moderate jump height at jumpSkill=200 matches curve', () => {
  // h = 1.0 * (200 / 1500 * 22.200001 + 0.05) * 1.0 = 2.96 + 0.05 = 3.01 m
  const h = calcJumpHeight(0.0, 200, 1.0, 100);
  assertNear(h, 3.01, 1e-3, 'Jump height ~ 3.01 m');
  const vz = calcJumpLaunchVelocity(h);
  assertNear(vz, Math.sqrt(3.01 * 19.6), 1e-4, 'vz matches sqrt(19.6 * 3.01)');
});

// Test 9.4: High jump height at jumpSkill = 500 matches formula
suite.addTest('9.4 High jump height at jumpSkill=500 produces ~6.217 m apex and ~11.038 m/s vz', () => {
  // h = 1.0 * (500 / 1800 * 22.200001 + 0.05) = 6.16667 + 0.05 = 6.21667 m
  const h = calcJumpHeight(0.0, 500, 1.0, 100);
  assertNear(h, 6.21667, 1e-4, 'Jump height ~ 6.217 m');
  const vz = calcJumpLaunchVelocity(h);
  assertNear(vz, Math.sqrt(6.21667 * 19.6), 1e-3, 'vz ~ 11.038 m/s');
});

// Test 9.5: Power scaling proportionally modulates calculated jump height
suite.addTest('9.5 Jump charge power (0.5) scales jump height proportionally before min floor', () => {
  const hFull = calcJumpHeight(0.0, 300, 1.0, 100);
  const hHalf = calcJumpHeight(0.0, 300, 0.5, 100);
  assertNear(hHalf, hFull * 0.5, 1e-3, 'Half power produces half height');
});

module.exports = suite;
