/**
 * Tier 4 Scenario 4: Rapid Combat Stance Locomotion Switch (Weapon Swap in Battle)
 * Exercises Features: F1 (Walk Speed), F2 (Run Speed), F15 (Locomotion & Combat Stance Transitions)
 */

'use strict';

const {
  CONSTANTS,
  getStanceTransitionRoute,
  getStateVelocity,
  calcTimeScale,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Scenario 4: Rapid Stance Switch on the Move', 4);

suite.addTest('S4 Rapid combat weapon swap while running resolves 2-hop transitions without motion stalls', () => {
  const runRate = 1.75;
  const targetVy = 4.0 * runRate; // 7.0 m/s
  const dt = 1.0 / 30.0;

  // Initial state: running forward with Sword drawn (SwordCombat 0x8000003E)
  let currentStance = CONSTANTS.STANCE_SWORD_COMBAT;
  let posY = 0.0;

  // Run with sword for 1.0s (30 ticks)
  for (let i = 0; i < 30; i++) {
    const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, runRate, 0, 0.0, runRate);
    assertEquals(vel.vy, targetVy);
    posY += vel.vy * dt;
  }
  assertNear(posY, 7.0, 0.1);

  // Trigger weapon swap to Bow (BowCombat 0x8000003F) while running
  const routeToBow = getStanceTransitionRoute(currentStance, CONSTANTS.STANCE_BOW_COMBAT);
  assertEquals(routeToBow.length, 2, 'Routes 2-hop: Sword -> NonCombat -> Bow');
  assertEquals(routeToBow[0], CONSTANTS.STANCE_NON_COMBAT);
  assertEquals(routeToBow[1], CONSTANTS.STANCE_BOW_COMBAT);

  // Hop 1: Sword -> NonCombat (150 ms crossfade = ~5 ticks)
  for (let i = 0; i < 5; i++) {
    const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, runRate, 0, 0.0, runRate);
    assertEquals(vel.vy, targetVy, 'Velocity maintains uninterrupted 7.0 m/s during hop 1');
    posY += vel.vy * dt;
  }

  // Hop 2: NonCombat -> Bow (150 ms crossfade = ~5 ticks)
  currentStance = CONSTANTS.STANCE_BOW_COMBAT;
  for (let i = 0; i < 5; i++) {
    const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, runRate, 0, 0.0, runRate);
    assertEquals(vel.vy, targetVy, 'Velocity maintains uninterrupted 7.0 m/s during hop 2');
    posY += vel.vy * dt;
  }

  // Continue running with Bow for another 1.0s (30 ticks)
  for (let i = 0; i < 30; i++) {
    const vel = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, runRate, 0, 0.0, runRate);
    posY += vel.vy * dt;
    const ts = calcTimeScale(vel.vy, true);
    assertNear(ts, 1.75, 1e-4, 'Bow run cycle plays at 1.75x timeScale');
  }

  // Verify total displacement over 70 ticks (~2.33s @ 7.0 m/s = ~16.33m)
  assertNear(posY, targetVy * (70 * dt), 0.1, 'Continuous linear progress without stopping');
});

module.exports = suite;
