/**
 * Feature 3: Run Rate Scaling Formula & Stamina 0
 * Authoritative baseline: acclient.c:713789, acclient.c:443695
 */

'use strict';

const {
  calcRunRate,
  calcLoadMod,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 3: Run Rate Scaling Formula & Stamina 0', 1);

// Test 3.1: Run rate at runSkill = 0, unencumbered (load = 0): exactly 1.0
suite.addTest('3.1 Base run rate at runSkill=0 with zero burden is exactly 1.0', () => {
  const rate = calcRunRate(0.0, 0, 100);
  assertNear(rate, 1.0000, 1e-4, 'run_rate should be 1.0');
});

// Test 3.2: Run rate at runSkill = 100, unencumbered: (1.0 * (100/300 * 11) + 4) / 4 = 1.91666...
suite.addTest('3.2 Run rate curve at runSkill=100 matches formula (1.9167)', () => {
  const expected = (1.0 * (100.0 / 300.0 * 11.0) + 4.0) / 4.0;
  const rate = calcRunRate(0.0, 100, 100);
  assertNear(rate, expected, 1e-4, 'run_rate for skill 100');
  assertNear(rate, 1.916666, 1e-4, 'Numeric value ~ 1.9167');
});

// Test 3.3: Run rate at runSkill = 200, unencumbered: (1.0 * (200/400 * 11) + 4) / 4 = 2.375
suite.addTest('3.3 Run rate curve at runSkill=200 matches formula (2.3750)', () => {
  const expected = (1.0 * (200.0 / 400.0 * 11.0) + 4.0) / 4.0;
  const rate = calcRunRate(0.0, 200, 100);
  assertNear(rate, expected, 1e-4, 'run_rate for skill 200');
  assertEquals(rate, 2.375, 'Exact match at 2.375');
});

// Test 3.4: Run rate at runSkill = 400, unencumbered: (1.0 * (400/600 * 11) + 4) / 4 = 2.8333...
suite.addTest('3.4 Run rate curve at runSkill=400 matches formula (2.8333)', () => {
  const expected = (1.0 * (400.0 / 600.0 * 11.0) + 4.0) / 4.0;
  const rate = calcRunRate(0.0, 400, 100);
  assertNear(rate, expected, 1e-4, 'run_rate for skill 400');
});

// Test 3.5: Stamina exhaustion (stamina = 0) forces runSkill to 0, yielding run_rate = 1.0
suite.addTest('3.5 Stamina exhaustion (stamina=0) collapses run_rate to 1.0 regardless of base skill', () => {
  const rateHighSkillExhausted = calcRunRate(0.0, 500, 0);
  assertNear(rateHighSkillExhausted, 1.0, 1e-4, 'Skill 500 at stamina 0 yields 1.0');

  const rateMaxSkillExhausted = calcRunRate(0.0, 800, 0);
  assertNear(rateMaxSkillExhausted, 1.0, 1e-4, 'Skill 800 at stamina 0 yields 1.0');
});

module.exports = suite;
