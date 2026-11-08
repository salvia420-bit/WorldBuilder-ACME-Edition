/**
 * Feature 15: Locomotion & Combat Stance Transitions (10 styles, 2-hop routing)
 * Authoritative baseline: acclient.c:337640-337780, acclient.c:332528
 */

'use strict';

const {
  CONSTANTS,
  getStanceTransitionRoute,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 15: Locomotion & Combat Stance Transitions', 1);

// Test 15.1: Direct stance switch from NonCombat to SwordCombat succeeds
suite.addTest('15.1 Direct 1-hop transition from NonCombat to SwordCombat', () => {
  const route = getStanceTransitionRoute(CONSTANTS.STANCE_NON_COMBAT, CONSTANTS.STANCE_SWORD_COMBAT);
  assertEquals(route.length, 1, 'Single hop route');
  assertEquals(route[0], CONSTANTS.STANCE_SWORD_COMBAT, 'Target is SwordCombat');
});

// Test 15.2: Direct stance switch from BowCombat to NonCombat succeeds
suite.addTest('15.2 Direct 1-hop transition from BowCombat to NonCombat', () => {
  const route = getStanceTransitionRoute(CONSTANTS.STANCE_BOW_COMBAT, CONSTANTS.STANCE_NON_COMBAT);
  assertEquals(route.length, 1, 'Single hop route');
  assertEquals(route[0], CONSTANTS.STANCE_NON_COMBAT, 'Target is NonCombat');
});

// Test 15.3: Cross-combat stance swap (SwordCombat -> BowCombat) routes 2-hop via NonCombat
suite.addTest('15.3 Cross-combat stance swap (SwordCombat to BowCombat) routes 2-hop via NonCombat', () => {
  const route = getStanceTransitionRoute(CONSTANTS.STANCE_SWORD_COMBAT, CONSTANTS.STANCE_BOW_COMBAT);
  assertEquals(route.length, 2, '2-hop route required');
  assertEquals(route[0], CONSTANTS.STANCE_NON_COMBAT, 'Hop 1 routes to NonCombat');
  assertEquals(route[1], CONSTANTS.STANCE_BOW_COMBAT, 'Hop 2 routes to BowCombat');
});

// Test 15.4: Stance swap crossfade standard duration is 150 ms
suite.addTest('15.4 Standard crossfade duration for combat stance transition is 150 ms', () => {
  const crossfadeDuration = CONSTANTS.CROSSFADE_STANCE_MS;
  assertEquals(crossfadeDuration, 150, 'Stance swap crossfade is 150 ms');
});

// Test 15.5: All 10 combat styles support identical routing invariants
suite.addTest('15.5 All 10 combat styles correctly route to/from NonCombat', () => {
  const combatStances = [
    CONSTANTS.STANCE_HAND_COMBAT,
    CONSTANTS.STANCE_SWORD_COMBAT,
    CONSTANTS.STANCE_BOW_COMBAT,
    CONSTANTS.STANCE_SWORD_SHIELD_COMBAT,
    CONSTANTS.STANCE_CROSSBOW_COMBAT,
    CONSTANTS.STANCE_TWO_HANDED_SWORD_COMBAT,
    CONSTANTS.STANCE_TWO_HANDED_STAFF_COMBAT,
    CONSTANTS.STANCE_DUAL_WIELD_COMBAT,
    CONSTANTS.STANCE_THROWN_WEAPON_COMBAT,
    CONSTANTS.STANCE_MAGIC_COMBAT
  ];

  for (const stance of combatStances) {
    const toNonCombat = getStanceTransitionRoute(stance, CONSTANTS.STANCE_NON_COMBAT);
    assertEquals(toNonCombat.length, 1, `Stance 0x${stance.toString(16)} to NonCombat is 1 hop`);

    const fromNonCombat = getStanceTransitionRoute(CONSTANTS.STANCE_NON_COMBAT, stance);
    assertEquals(fromNonCombat.length, 1, `NonCombat to Stance 0x${stance.toString(16)} is 1 hop`);
  }
});

module.exports = suite;
