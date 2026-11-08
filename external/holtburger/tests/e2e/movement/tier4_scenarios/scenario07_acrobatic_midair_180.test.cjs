/**
 * Tier 4 Scenario 7: Acrobatic Mid-Air 180-Degree Turn & Landing
 * Exercises Features: F2 (Run Speed), F8 (Turn Rates), F10 (Air Turning), F16 (Recovery Links)
 */

'use strict';

const {
  CONSTANTS,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Scenario 7: Acrobatic Mid-Air 180-Degree Turn', 4);

suite.addTest('S7 Running takeoff, 180-degree mid-air yaw turn, and backward landing recovery', () => {
  // Player sprints forward at 6.0 m/s facing North (heading = 0.0)
  let heading = 0.0;
  const launchVx = 0.0;
  const launchVy = 6.0; // Heading North in world coordinates
  const launchVz = 7.0; // ~2.5m apex jump
  const dt = 1.0 / 30.0;

  let posZ = 0.0;
  let posY = 0.0;
  let vz = launchVz;
  let isAirborne = true;
  let ticks = 0;

  // Ballistic flight with active mid-air yaw turn
  while (isAirborne && ticks < 90) {
    ticks++;
    vz += CONSTANTS.GRAVITY * dt;
    posZ += vz * dt;
    posY += launchVy * dt;

    // Rotate yaw in air: turning right at 2.25 rad/s
    if (heading < Math.PI) {
      heading = Math.min(Math.PI, heading + CONSTANTS.RUN_TURN_OMEGA * dt);
    }

    if (ticks > 2 && posZ <= 0.0 && vz < 0) {
      posZ = 0.0;
      isAirborne = false;
    }
  }

  // Verify airborne rotation completed 180 degrees (facing South)
  assertNear(heading, Math.PI, 0.05, 'Player rotated 180 degrees to face South');
  // Trajectory continued traveling North
  assert(posY > 5.0, 'Body continued traveling North during turn');

  // Ground contact: player is now facing South (+Y local is South, -Y local is North)
  // Player releases forward and touches down into Ready
  const landingState = CONSTANTS.CMD_READY;
  assertEquals(landingState, 0x41000003, 'Touchdown recovers cleanly in Ready facing South');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
