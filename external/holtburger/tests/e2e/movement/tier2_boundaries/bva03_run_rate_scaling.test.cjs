/**
 * Tier 2 Boundary: Run Rate Scaling Formula & Stamina 0
 * Authoritative baseline: acclient.c:713789, acclient.c:296777
 */

'use strict';

const {
  calcRunRate,
  calcLoadMod,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 3: Run Rate Scaling Formula & Stamina 0', 2);

// Test B3.1: Exactly at retail cap skill = 800 returns 4.5
suite.addTest('B3.1 Run skill = 800 exact equality check returns 4.5000', () => {
  const rate = calcRunRate(0.0, 800, 100);
  assertEquals(rate, 4.5);
});

// Test B3.2: Full overburden load = 2.0 (200% capacity) collapses loadMod to 0.0 -> run_rate = 1.0
suite.addTest('B3.2 Overburden load = 2.0 sets loadMod = 0.0 and collapses run_rate to 1.0', () => {
  const loadMod = calcLoadMod(2.0);
  assertEquals(loadMod, 0.0);
  const rate = calcRunRate(2.0, 500, 100);
  assertEquals(rate, 1.0);
});

// Test B3.3: Excessive overburden load > 2.0 (e.g. load = 3.5) clamps loadMod to 0.0 without negative values
suite.addTest('B3.3 Extreme burden load = 3.5 clamps loadMod at 0.0 without going negative', () => {
  const loadMod = calcLoadMod(3.5);
  assertEquals(loadMod, 0.0);
  const rate = calcRunRate(3.5, 500, 100);
  assertEquals(rate, 1.0);
});

// Test B3.4: Fractional load transitions across threshold (0.999 vs 1.001)
suite.addTest('B3.4 LoadMod continuous boundary transition across 1.0 threshold', () => {
  const modBelow = calcLoadMod(0.999);
  assertEquals(modBelow, 1.0, 'Under 100% capacity has no penalty');

  const modAbove = calcLoadMod(1.001);
  assertNear(modAbove, 0.999, 1e-4, 'Over 100% capacity begins linear penalty (2.0 - load)');

  const modHalf = calcLoadMod(1.5);
  assertEquals(modHalf, 0.5, '150% capacity yields 0.5 modifier');
});

// Test B3.5: Negative skill or NaN inputs safely clamped to zero
suite.addTest('B3.5 Invalid negative skill input clamps to 0 yielding base run_rate = 1.0', () => {
  const rate = calcRunRate(0.0, -50, 100);
  assertEquals(rate, 1.0);
});

module.exports = suite;
