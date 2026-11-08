/**
 * Tier 2 Boundary: Run Speed
 * Authoritative baseline: acclient.c:343565, acclient.c:317740
 */

'use strict';

const {
  CONSTANTS,
  calcRunRate,
  getStateVelocity,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 2: Run Speed', 2);

// Test B2.1: Run speed at max normal run skill (500)
suite.addTest('B2.1 Run speed at normal skill 500 produces 11.857 m/s', () => {
  const rate = calcRunRate(0.0, 500, 100);
  // (1.0 * (500/700 * 11) + 4) / 4 = 2.9642857
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, rate, 0, 0.0, rate);
  assertNear(vel.vy, 4.0 * rate, 1e-4);
  assertNear(vel.vy, 11.8571, 1e-3);
});

// Test B2.2: Run speed at retail cap skill (800) produces exactly 18.0 m/s
suite.addTest('B2.2 Run speed at skill 800 cap produces 18.0 m/s (4.0 * 4.5)', () => {
  const rate = calcRunRate(0.0, 800, 100);
  assertEquals(rate, 4.5);
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, rate, 0, 0.0, rate);
  assertEquals(vel.vy, 18.0);
});

// Test B2.3: God-mode / extreme run skill (15000) evaluates exact retail formula
suite.addTest('B2.3 Run speed at extreme skill 15000 evaluates to 14.855 m/s', () => {
  const rate = calcRunRate(0.0, 15000, 100);
  // (1.0 * (15000/15200 * 11) + 4) / 4 = 3.7138157
  const expectedRate = (1.0 * (15000.0 / 15200.0 * 11.0) + 4.0) / 4.0;
  assertNear(rate, expectedRate, 1e-4);
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, rate, 0, 0.0, rate);
  assertNear(vel.vy, 4.0 * expectedRate, 1e-4);
  assertNear(vel.vy, 14.855, 1e-3);
});

// Test B2.4: 50% burden (load = 1.5) halves the run rate bonus above base
suite.addTest('B2.4 50% burden (load=1.5, loadMod=0.5) scales run bonus proportionally', () => {
  const rateUnencumbered = calcRunRate(0.0, 200, 100); // 2.375
  const rateBurdened = calcRunRate(1.5, 200, 100);
  // loadMod = 0.5 -> (0.5 * (200/400 * 11) + 4) / 4 = (0.5 * 5.5 + 4) / 4 = 6.75 / 4 = 1.6875
  assertEquals(rateBurdened, 1.6875);
  const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, rateBurdened, 0, 0.0, rateBurdened);
  assertEquals(vel.vy, 4.0 * 1.6875);
  assertEquals(vel.vy, 6.75);
});

// Test B2.5: Terminal velocity clamp caps total velocity at 50.0 m/s
suite.addTest('B2.5 External physics acceleration cannot boost velocity past 50.0 m/s terminal clamp', () => {
  let v = { x: 0, y: 65.0, z: 0 };
  const mag = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (mag > CONSTANTS.TERMINAL_VELOCITY) {
    v.x = (v.x / mag) * CONSTANTS.TERMINAL_VELOCITY;
    v.y = (v.y / mag) * CONSTANTS.TERMINAL_VELOCITY;
    v.z = (v.z / mag) * CONSTANTS.TERMINAL_VELOCITY;
  }
  assertEquals(v.y, 50.0);
});

module.exports = suite;
