/**
 * Tier 4 Scenario 6: Exhausted Survival Retreat (Stamina Depleted)
 * Exercises Features: F3 (Run Rate Scaling), F4 (Backward Walk Speed), F8 (Turn Rates)
 */

'use strict';

const {
  CONSTANTS,
  calcRunRate,
  calcJumpHeight,
  adjustMotion,
  getStateVelocity,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Scenario 6: Exhausted Survival Retreat', 4);

suite.addTest('S6 Stamina drops to 0 under enemy fire: run collapses to walk, backpedals defensively at -2.028 m/s', () => {
  // Setup: Character running away from combat with Run Skill 400
  let stamina = 100;
  let runRate = calcRunRate(0.0, 400, stamina);
  assertNear(runRate, 2.8333, 1e-4);

  // Stamina completely exhausted by enemy spell/drain
  stamina = 0;
  runRate = calcRunRate(0.0, 400, stamina);
  assertEquals(runRate, 1.0, 'Run rate instantly collapses to 1.0');

  // Attempting to jump while exhausted
  const jumpHeight = calcJumpHeight(0.0, 400, 1.0, stamina);
  assertEquals(jumpHeight, CONSTANTS.JUMP_MIN_HEIGHT, 'Jump apex collapses to minimum 0.35m hop');

  // Player shifts to defensive retreat: backpedaling away while facing the attacking enemy
  const adjBack = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  const backVel = getStateVelocity(adjBack.command, adjBack.speed, 0, 0.0, runRate);

  assertNear(backVel.vy, -2.028, 1e-3, 'Avatar backpedals at -2.028 m/s');

  // Defensive yaw turn while backpedaling
  const walkTurnOmega = CONSTANTS.BASE_TURN_OMEGA; // 1.5 rad/s
  assertEquals(walkTurnOmega, 1.5, 'Turn rate is 1.5 rad/s in walk/exhausted mode');

  // Simulate 3 seconds of retreat
  const dt = 1.0 / 30.0;
  let retreatDistance = 0.0;
  for (let i = 0; i < 90; i++) {
    retreatDistance += Math.abs(backVel.vy) * dt;
  }
  assertNear(retreatDistance, 2.028 * 3.0, 0.1, 'Covers ~6.08 meters in retreat');
});

module.exports = suite;
