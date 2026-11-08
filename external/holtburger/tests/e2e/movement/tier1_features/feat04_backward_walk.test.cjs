/**
 * Feature 4: Backward Walk Speed (-0.65x, non-promoted)
 * Authoritative baseline: acclient.c:343769, acclient.c:343455
 */

'use strict';

const {
  CONSTANTS,
  adjustMotion,
  applyRunToCommand,
  getStateVelocity,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 4: Backward Walk Speed', 1);

// Test 4.1: Canonicalization of WalkBackward maps to WalkForward at -0.65x
suite.addTest('4.1 WalkBackward canonicalizes to WalkForward with -0.65x speed', () => {
  const res = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  assertEquals(res.command, CONSTANTS.CMD_WALK_FORWARD, 'Command becomes WalkForward');
  assertNear(res.speed, CONSTANTS.BACKWARDS_FACTOR, 1e-4, 'Speed scaled by -0.65');
});

// Test 4.2: Local velocity for backward walk equals -0.65 * 3.12 = -2.028 m/s
suite.addTest('4.2 Backward walk yields local velocity -2.028 m/s', () => {
  const adj = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  const vel = getStateVelocity(adj.command, adj.speed, 0, 0.0, 1.0);
  assertNear(vel.vy, -2.028, 1e-3, 'Vy should be -2.028 m/s');
  assertEquals(vel.vx, 0.0, 'Vx should be 0');
});

// Test 4.3: Holding Run key does NOT promote backward walk to RunForward
suite.addTest('4.3 Holding Run modifier NEVER promotes backward walk to RunForward', () => {
  const adj = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  // applyRunToCommand checks if speed > 0.0 before promoting
  const runRes = applyRunToCommand(adj.command, adj.speed, 2.5);
  assertEquals(runRes.command, CONSTANTS.CMD_WALK_FORWARD, 'Must NOT promote to RunForward');
  assertNear(runRes.speed, CONSTANTS.BACKWARDS_FACTOR, 1e-4, 'Backward speed remains unboosted by run_rate');
});

// Test 4.4: Backward velocity magnitude is strictly less than forward walk speed
suite.addTest('4.4 Backward velocity magnitude is exactly 65% of forward walk speed', () => {
  const adj = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  const velBack = getStateVelocity(adj.command, adj.speed, 0, 0.0, 1.0);
  const velFwd = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 1.0, 0, 0.0, 1.0);
  const ratio = Math.abs(velBack.vy) / velFwd.vy;
  assertNear(ratio, 0.65, 1e-4, 'Ratio of backward to forward speed is 0.65');
});

// Test 4.5: Negative direction in world coordinates moves opposite to heading
suite.addTest('4.5 Backward walk displacement moves strictly opposite to player facing', () => {
  const headingRad = 0.0; // Facing North (+Y)
  const adj = adjustMotion(CONSTANTS.CMD_WALK_BACKWARD, 1.0);
  const vel = getStateVelocity(adj.command, adj.speed, 0, 0.0, 1.0);
  // World Vy = cos(heading) * local Vy = 1.0 * (-2.028) = -2.028 (South)
  const worldVy = Math.cos(headingRad) * vel.vy;
  assertNear(worldVy, -2.028, 1e-3, 'Player moves South when facing North');
});

module.exports = suite;
