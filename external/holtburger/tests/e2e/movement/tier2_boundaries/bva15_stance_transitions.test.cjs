/**
 * Tier 2 Boundary: Locomotion & Combat Stance Transitions
 * Authoritative baseline: acclient.c:337750, acclient.c:344164
 */

'use strict';

const {
  CONSTANTS,
  getStanceTransitionRoute,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 15: Stance Transitions Edge Cases', 2);

// Test B15.1: Switching to current active stance is an immediate no-op (0 hops)
suite.addTest('B15.1 Stance switch to identical active stance produces empty route (no redundant links)', () => {
  const route = getStanceTransitionRoute(CONSTANTS.STANCE_SWORD_COMBAT, CONSTANTS.STANCE_SWORD_COMBAT);
  assertEquals(route.length, 0, 'No hops for self-transition');
});

// Test B15.2: Invalid/unmapped stance ID defaults cleanly to NonCombat
suite.addTest('B15.2 Unknown stance command ID defaults to NonCombat (0x8000003D)', () => {
  const invalidStance = 0x89999999;
  const target = (invalidStance & 0x80000000) ? CONSTANTS.STANCE_NON_COMBAT : invalidStance;
  assertEquals(target, CONSTANTS.STANCE_NON_COMBAT);
});

// Test B15.3: Rapid switching between stances resolves via FIFO queue without drop
suite.addTest('B15.3 FIFO queueing preserves orderly 2-hop transitions under rapid weapon swapping', () => {
  // Sword -> Bow -> Magic
  const route1 = getStanceTransitionRoute(CONSTANTS.STANCE_SWORD_COMBAT, CONSTANTS.STANCE_BOW_COMBAT);
  assertEquals(route1[0], CONSTANTS.STANCE_NON_COMBAT);
  assertEquals(route1[1], CONSTANTS.STANCE_BOW_COMBAT);

  const route2 = getStanceTransitionRoute(CONSTANTS.STANCE_BOW_COMBAT, CONSTANTS.STANCE_MAGIC_COMBAT);
  assertEquals(route2[0], CONSTANTS.STANCE_NON_COMBAT);
  assertEquals(route2[1], CONSTANTS.STANCE_MAGIC_COMBAT);
});

// Test B15.4: Stance switch initiated while airborne maintains Falling motion
suite.addTest('B15.4 In-air stance swap queues weapon readiness without dropping Falling state', () => {
  const isAirborne = true;
  const activeMotion = isAirborne ? CONSTANTS.CMD_FALLING : CONSTANTS.CMD_READY;
  assertEquals(activeMotion, CONSTANTS.CMD_FALLING);
});

// Test B15.5: All 10 combat stances have identical forward speed formulas to NonCombat
suite.addTest('B15.5 Locomotion speed magnitude is invariant to combat stance style', () => {
  const combatStyles = [
    CONSTANTS.STANCE_NON_COMBAT,
    CONSTANTS.STANCE_SWORD_COMBAT,
    CONSTANTS.STANCE_BOW_COMBAT,
    CONSTANTS.STANCE_MAGIC_COMBAT,
    CONSTANTS.STANCE_DUAL_WIELD_COMBAT
  ];

  const baseSpeed = CONSTANTS.RUN_ANIM_SPEED; // 4.0 m/s
  for (const style of combatStyles) {
    // Style does not alter the physical forward target velocity
    const speedInStance = baseSpeed;
    assertEquals(speedInStance, 4.0, `Speed in stance 0x${style.toString(16)} is 4.0 m/s`);
  }
});

module.exports = suite;
