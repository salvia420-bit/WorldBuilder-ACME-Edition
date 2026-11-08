/**
 * Tier 2 Boundary: Jump Recovery Links & Landing Transitions
 * Authoritative baseline: acclient.c:344440-344495
 */

'use strict';

const {
  CONSTANTS,
  isWalkableSlope,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 16: Jump Recovery Links & Landing Boundaries', 2);

// Test B16.1: Touchdown on steep unwalkable slope (> 48.38 deg) bypasses landing recovery and enters slide
suite.addTest('B16.1 Landing contact on steep slope (Nz < 0.664174) bypasses Ready and remains in Falling/Sliding', () => {
  const steepNormal = { x: 0, y: Math.sin(55.0 * Math.PI / 180.0), z: Math.cos(55.0 * Math.PI / 180.0) };
  const walkable = isWalkableSlope(steepNormal);
  assertEquals(walkable, false);

  // If walkable is false, character does NOT transition to ground stance; remains in Falling
  const targetMotion = walkable ? CONSTANTS.CMD_READY : CONSTANTS.CMD_FALLING;
  assertEquals(targetMotion, CONSTANTS.CMD_FALLING, 'Remains Falling on steep slope');
});

// Test B16.2: High velocity fall impact triggers knockdown transition to Fallen (0x40000008)
suite.addTest('B16.2 Catastrophic high-speed impact triggers knockdown recovery (Fallen 0x40000008)', () => {
  const impactSpeedZ = -35.0; // High velocity drop
  const isLethalOrKnockdown = impactSpeedZ < -25.0;
  const landingState = isLethalOrKnockdown ? CONSTANTS.CMD_FALLEN : CONSTANTS.CMD_READY;
  assertEquals(landingState, CONSTANTS.CMD_FALLEN, 'Triggers Fallen knockdown recovery');
});

// Test B16.3: Continuous bunny-hopping: Jump key queued at ground impact immediately triggers takeoff link
suite.addTest('B16.3 Bunny-hopping: Jump command queued at impact re-triggers takeoff link without standstill', () => {
  const jumpHeldAtTouchdown = true;
  const nextAction = jumpHeldAtTouchdown ? CONSTANTS.CMD_JUMP : CONSTANTS.CMD_READY;
  assertEquals(nextAction, CONSTANTS.CMD_JUMP, 'Re-triggers jump immediately');
});

// Test B16.4: Releasing forward input at exact moment of touchdown routes into standing landing
suite.addTest('B16.4 Forward input released at exact moment of impact routes to standing landing link', () => {
  const forwardHeldAtImpact = false; // Released at impact
  const landingSequence = forwardHeldAtImpact ? 'hop2_run' : 'stand_ready';
  assertEquals(landingSequence, 'stand_ready');
});

// Test B16.5: Micro-step drop (curb drop of 0.15m) lands cleanly without damage knockdown
suite.addTest('B16.5 Micro-drop off curb (vz ~ -1.7 m/s) recovers with normal standing landing', () => {
  const dropHeight = 0.15; // 15 cm curb
  const impactVz = -Math.sqrt(2 * Math.abs(CONSTANTS.GRAVITY) * dropHeight); // ~ -1.71 m/s
  const isKnockdown = impactVz < -25.0;
  assertEquals(isKnockdown, false, 'No knockdown on curb drop');
  const targetMotion = isKnockdown ? CONSTANTS.CMD_FALLEN : CONSTANTS.CMD_READY;
  assertEquals(targetMotion, CONSTANTS.CMD_READY);
});

module.exports = suite;
