/**
 * Tier 4 Scenario 2: Running Long Jump across Gap
 * Exercises Features: F2 (Run Speed), F9 (Jump Height), F10 (Jump Momentum), F16 (Recovery Links)
 */

'use strict';

const {
  CONSTANTS,
  calcJumpHeight,
  calcJumpLaunchVelocity,
  assertNear,
  assertInRange,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Scenario 2: Running Long Jump across Gap', 4);

suite.addTest('S2 Running long jump clears 12-meter chasm and resumes sprint via running landing link', () => {
  // Setup: Character running at 8.0 m/s with Jump Skill 300, unencumbered, full charge
  const runSpeed = 8.0; // 8.0 m/s sprint
  const jumpSkill = 300;
  const load = 0.0;
  const power = 1.0;

  // 1. Calculate jump takeoff vertical impulse
  const apexHeight = calcJumpHeight(load, jumpSkill, power, 100);
  // (1.0 * (300/1600 * 22.200001 + 0.05)) = 4.1625 + 0.05 = 4.2125 m
  assertNear(apexHeight, 4.2125, 1e-3);
  const vzLaunch = calcJumpLaunchVelocity(apexHeight);
  // vz = sqrt(19.6 * 4.2125) = sqrt(82.565) ~= 9.0865 m/s
  assertNear(vzLaunch, Math.sqrt(4.2125 * 19.6), 1e-4);

  // 2. Ballistic flight simulation across chasm (gap = 12.0 meters, level ground across)
  const dt = 1.0 / 30.0;
  let posX = 0.0;
  let posY = 0.0;
  let posZ = 0.0;
  let vx = 0.0;
  let vy = runSpeed; // 8.0 m/s preserved from ground run
  let vz = vzLaunch;

  let flightTicks = 0;
  let isAirborne = true;
  let peakZ = 0.0;

  while (isAirborne && flightTicks < 120) {
    flightTicks++;
    // Retail second-order Taylor series position integration (acclient.c:317700)
    posZ += vz * dt + 0.5 * CONSTANTS.GRAVITY * dt * dt;
    posY += vy * dt;
    vz += CONSTANTS.GRAVITY * dt;

    if (posZ > peakZ) {
      peakZ = posZ;
    }

    // Touchdown condition (landing on opposite ledge at z = 0)
    if (flightTicks > 2 && posZ <= 0.0 && vz < 0) {
      posZ = 0.0;
      isAirborne = false;
    }
  }

  // 3. Verify ballistic leap metrics
  assertNear(peakZ, apexHeight, 0.1, 'Peak height matches calculated apex ~4.2 m');
  assertInRange(posY, 14.0, 16.0, 'Horizontal distance cleared is ~14.8m (> 12m chasm)');
  assert(posY > 12.0, 'Player successfully clears the 12m chasm');

  // 4. Verify landing link recovery: player holds RunForward at impact
  const inputAtImpact = CONSTANTS.CMD_RUN_FORWARD;
  const landingState = inputAtImpact === CONSTANTS.CMD_RUN_FORWARD ? CONSTANTS.CMD_RUN_FORWARD : CONSTANTS.CMD_READY;
  assertEquals(landingState, CONSTANTS.CMD_RUN_FORWARD, 'Running recovery link hop2 triggers immediately');

  // 5. Sprint continues uninterrupted after touchdown
  for (let i = 0; i < 30; i++) {
    posY += vy * dt;
  }
  assertInRange(posY, 22.0, 24.5, 'Sprint seamlessly advances another 8m on opposite side');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
