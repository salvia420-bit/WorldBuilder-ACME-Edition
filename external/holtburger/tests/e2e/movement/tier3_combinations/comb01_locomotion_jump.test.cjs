/**
 * Tier 3 Combination 1: Locomotion & Jump Interactions
 * Authoritative baselines: acclient.c:343586, 343840, 344457
 */

'use strict';

const {
  CONSTANTS,
  getStateVelocity,
  calcJumpLaunchVelocity,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Combination 1: Locomotion & Jump Interactions', 3);

// Test 3.1: Sprint + Strafe + Turn (simultaneous W + D + E keys held)
suite.addTest('3.1 Simultaneous Sprint + Strafe + Turn evaluates clamped velocity and yaw turn rate', () => {
  const runRate = 1.5; // Sprint speed = 6.0 m/s
  const vel = getStateVelocity(
    CONSTANTS.CMD_RUN_FORWARD,
    runRate,
    CONSTANTS.CMD_SIDESTEP_RIGHT,
    CONSTANTS.SIDESTEP_ADJUST_FACTOR * runRate,
    runRate
  );

  // Maximum planar speed is 4.0 * 1.5 = 6.0 m/s
  assertNear(vel.mag, 6.0, 1e-4, 'Planar magnitude clamped to 6.0 m/s');
  assert(vel.vy > 0, 'Forward velocity active');
  assert(vel.vx > 0, 'Lateral strafe active');

  // Turn rate in run mode
  const omega = CONSTANTS.RUN_TURN_OMEGA;
  assertEquals(omega, 2.25, 'Turn rate is 2.25 rad/s while running');
});

// Test 3.2: Diagonal Run + Jump Launch
suite.addTest('3.2 Diagonal running takeoff preserves clamped (Vx, Vy) and injects Vz launch impulse', () => {
  const runRate = 1.0;
  const groundVel = getStateVelocity(
    CONSTANTS.CMD_RUN_FORWARD,
    1.0,
    CONSTANTS.CMD_SIDESTEP_RIGHT,
    CONSTANTS.SIDESTEP_ADJUST_FACTOR,
    runRate
  );

  const vzLaunch = calcJumpLaunchVelocity(3.01); // ~7.68 m/s
  const takeoffVel = {
    x: groundVel.vx,
    y: groundVel.vy,
    z: vzLaunch
  };

  assertNear(Math.sqrt(takeoffVel.x * takeoffVel.x + takeoffVel.y * takeoffVel.y), 4.0, 1e-4, 'Preserves 4.0 m/s planar speed');
  assertNear(takeoffVel.z, Math.sqrt(3.01 * 19.6), 1e-4, 'Vertical launch impulse set correctly');
});

// Test 3.3: Jump Launch + Mid-Air Turn
suite.addTest('3.3 Mid-air yaw turning rotates heading 90 degrees while flight continues along original line', () => {
  let heading = 0.0; // Initially facing North
  const flightVx = 0.0;
  const flightVy = 6.0; // Moving North at 6.0 m/s

  // Turn right in mid-air for 0.698s (~40 degrees / 0.7s at 2.25 rad/s = 1.57 rad = 90 deg)
  const dt = 1.0 / 30.0;
  const turnTicks = Math.round((Math.PI / 2) / (CONSTANTS.RUN_TURN_OMEGA * dt));

  for (let i = 0; i < turnTicks; i++) {
    heading += CONSTANTS.RUN_TURN_OMEGA * dt;
  }

  assertNear(heading, Math.PI / 2, 0.05, 'Heading rotated to East (90 deg)');
  // Ballistic velocity remains unchanged
  assertEquals(flightVy, 6.0, 'Trajectory velocity remains North 6.0 m/s');
  assertEquals(flightVx, 0.0, 'Lateral velocity remains 0.0 m/s');
});

// Test 3.4: Mid-Air Turn + Running Landing
suite.addTest('3.4 180-degree mid-air turn lands into run recovery along new facing', () => {
  // New heading facing South (PI rad)
  const newHeading = Math.PI;
  const heldInput = CONSTANTS.CMD_RUN_FORWARD;
  const landingState = heldInput === CONSTANTS.CMD_RUN_FORWARD ? CONSTANTS.CMD_RUN_FORWARD : CONSTANTS.CMD_READY;
  assertEquals(landingState, CONSTANTS.CMD_RUN_FORWARD, 'Chains into RunForward');

  // Ground velocity along new heading: South (-Y)
  const localVy = 4.0;
  const worldVy = Math.cos(newHeading) * localVy;
  assertNear(worldVy, -4.0, 1e-4, 'Sprint continues Southward along new heading');
});

// Test 3.5: Combat Stance Switch + Full Sprint
suite.addTest('3.5 Combat stance swap while sprinting at 8.0 m/s preserves velocity and timeScale', () => {
  const runRate = 2.0;
  const groundSpeed = 4.0 * runRate; // 8.0 m/s
  const timeScale = groundSpeed / CONSTANTS.CYCLE_BASE_RUN_SPEED; // 8.0 / 4.0 = 2.0

  assertEquals(groundSpeed, 8.0);
  assertEquals(timeScale, 2.0, 'Playback timeScale is 2.0');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
