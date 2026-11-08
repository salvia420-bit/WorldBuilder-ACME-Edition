/**
 * Tier 2 Boundary: Jump Height & Vertical Impulse
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

const suite = require('../harness.cjs').createSuite('Boundary 9: Jump Height & Vertical Impulse', 2);

// Test B9.1: Zero power tap floors to 0.35 m
suite.addTest('B9.1 Zero power tap (power = 0.0) guarantees minimum 0.35 m apex height', () => {
  const h = calcJumpHeight(0.0, 500, 0.0, 100);
  assertEquals(h, CONSTANTS.JUMP_MIN_HEIGHT, 'Tap floors to 0.35 m');
  const vz = calcJumpLaunchVelocity(h);
  assertNear(vz, CONSTANTS.JUMP_MIN_IMPULSE, 1e-4);
});

// Test B9.2: Stamina 0 collapses jumpSkill to 0, producing minimum 0.35 m hop
suite.addTest('B9.2 Zero stamina forces jumpSkill to 0 producing minimum 0.35 m hop', () => {
  const h = calcJumpHeight(0.0, 800, 1.0, 0); // stamina = 0
  assertEquals(h, CONSTANTS.JUMP_MIN_HEIGHT, 'Floored at 0.35 m');
});

// Test B9.3: Overburden load >= 2.0 floors to 0.35 m
suite.addTest('B9.3 Overburden (load >= 2.0) sets loadMod to 0, flooring height to 0.35 m', () => {
  const h = calcJumpHeight(2.5, 500, 1.0, 100);
  assertEquals(h, CONSTANTS.JUMP_MIN_HEIGHT);
});

// Test B9.4: Theoretical infinite skill ceiling: h -> 22.25 m, vz -> ~20.88 m/s
suite.addTest('B9.4 Theoretical infinite skill ceiling approaches 22.25 m apex and 20.88 m/s vz', () => {
  // As skill -> infinity, skill / (skill + 1300) -> 1.0, so h -> 22.200001 + 0.05 = 22.25 m
  const hHuge = calcJumpHeight(0.0, 1e9, 1.0, 100);
  assertNear(hHuge, 22.25, 1e-3, 'Height approaches 22.25 m');
  const vzHuge = calcJumpLaunchVelocity(hHuge);
  assertNear(vzHuge, Math.sqrt(22.25 * 19.6), 1e-3, 'vz approaches ~20.88 m/s');
});

// Test B9.5: Negative power or NaN clamped safely to 0.0
suite.addTest('B9.5 Negative power clamped to 0.0 yielding floor 0.35 m', () => {
  const h = calcJumpHeight(0.0, 300, -0.5, 100);
  assertEquals(h, CONSTANTS.JUMP_MIN_HEIGHT);
});

module.exports = suite;
