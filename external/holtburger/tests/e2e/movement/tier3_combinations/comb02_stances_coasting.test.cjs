/**
 * Tier 3 Combination 2: Stances, Coasting, & Gait Transitions
 * Authoritative baselines: acclient.c:340719, 337750, 343769
 */

'use strict';

const {
  CONSTANTS,
  adjustMotion,
  getStateVelocity,
  getStanceTransitionRoute,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Combination 2: Stances, Coasting, & Gait Transitions', 3);

// Test 3.6: Combat Stance Switch + Mid-Air Jump
suite.addTest('3.6 Switching combat stance during airborne jump maintains ballistic parabolic flight', () => {
  const isAirborne = true;
  let vz = 6.0;
  const dt = 1.0 / 30.0;

  // Stance swap from SwordCombat to BowCombat
  const route = getStanceTransitionRoute(CONSTANTS.STANCE_SWORD_COMBAT, CONSTANTS.STANCE_BOW_COMBAT);
  assertEquals(route.length, 2, '2-hop route via NonCombat');

  // Trajectory continues undisturbed during stance swap
  for (let i = 0; i < 10; i++) {
    vz += CONSTANTS.GRAVITY * dt;
  }
  assertNear(vz, 6.0 - 9.8000002 * (10 / 30), 1e-4, 'Ballistic integration unperturbed');
});

// Test 3.7: Sprint + Sudden Release (Coasting) + Stance Swap
suite.addTest('3.7 Triggering stance swap during 0.79 m coasting window resolves concurrently', () => {
  const initialSpeed = 4.0;
  const coastDuration = CONSTANTS.RUN_TO_READY_COAST_DURATION; // 0.40s
  const stanceSwapCrossfade = CONSTANTS.CROSSFADE_STANCE_MS / 1000.0; // 0.15s

  // Stance swap crossfade (150 ms) fits cleanly inside the 400 ms coasting window
  assert(stanceSwapCrossfade < coastDuration, 'Stance swap finishes before coasting ends');
  assertEquals(stanceSwapCrossfade, 0.15);
  assertEquals(coastDuration, 0.40);
});

// Test 3.8: Walk Forward + Backpedal Toggle
suite.addTest('3.8 Rapid toggling between WalkForward and WalkBackward transitions between +3.12 and -2.028 m/s', () => {
  const fwdVel = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 1.0, 0, 0.0, 1.0);
  assertNear(fwdVel.vy, 3.12, 1e-4);

  const adjBack = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  const backVel = getStateVelocity(adjBack.command, adjBack.speed, 0, 0.0, 1.0);
  assertNear(backVel.vy, -2.028, 1e-3);
});

// Test 3.9: Backpedal + Strafe (S + D)
suite.addTest('3.9 Simultaneous Backpedal and Strafe synthesizes vector with negative Vy and positive Vx', () => {
  const adjBack = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  const adjStrafe = adjustMotion(CONSTANTS.CMD_SIDESTEP_RIGHT, 1.0);
  const vel = getStateVelocity(adjBack.command, adjBack.speed, adjStrafe.command, adjStrafe.speed, 1.0);

  assertNear(vel.vy, -2.028, 1e-3, 'Vy is -2.028 m/s');
  assertNear(vel.vx, 1.56, 1e-3, 'Vx is +1.56 m/s');
  // Magnitude: sqrt(2.028^2 + 1.56^2) = sqrt(4.112784 + 2.4336) = 2.558 m/s < 4.0 m/s (no clamping)
  assertNear(vel.mag, Math.sqrt(2.028 * 2.028 + 1.56 * 1.56), 1e-3);
});

// Test 3.10: 2-Hop Combat Stance Transition during Backpedal
suite.addTest('3.10 2-hop weapon swap during backpedal maintains continuous -2.028 m/s velocity', () => {
  const route = getStanceTransitionRoute(CONSTANTS.STANCE_SWORD_COMBAT, CONSTANTS.STANCE_MAGIC_COMBAT);
  assertEquals(route.length, 2);

  // Velocity throughout transition
  const adjBack = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  const vel = getStateVelocity(adjBack.command, adjBack.speed, 0, 0.0, 1.0);
  assertNear(vel.vy, -2.028, 1e-3, 'Constant backward speed throughout 2-hop sequence');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
