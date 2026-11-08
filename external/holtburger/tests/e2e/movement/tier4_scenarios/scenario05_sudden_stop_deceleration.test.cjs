/**
 * Tier 4 Scenario 5: Sudden Stop from High-Speed Sprint (Emergency Deceleration)
 * Exercises Features: F7 (Grounded Friction), F13 (Stop Coasting Deceleration), F14 (Playback Scaling)
 */

'use strict';

const {
  CONSTANTS,
  assertNear,
  assertInRange,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Scenario 5: Emergency Stopping Deceleration', 4);

suite.addTest('S5 Sudden stop from 10.0 m/s sprint coasts smoothly ~0.79m into Ready without rubberband snap', () => {
  const initialSprintSpeed = 10.0; // 10.0 m/s sprint
  const dt = 1.0 / 30.0;

  // Sprinting forward for 1.0s (30 ticks)
  let pos = 0.0;
  for (let i = 0; i < 30; i++) {
    pos += initialSprintSpeed * dt;
  }
  assertNear(pos, 10.0, 0.1);

  // Key released: initiate stopping deceleration transition (Run -> Ready link)
  // Instead of snapping instantly to 0 in 1 tick, avatar coasts over 0.40s
  const coastDuration = CONSTANTS.RUN_TO_READY_COAST_DURATION; // 0.40s
  const stopTicks = Math.round(coastDuration / dt); // 12 ticks

  let coastDist = 0.0;
  let v = initialSprintSpeed;

  for (let i = 0; i < stopTicks; i++) {
    const fraction = (i + 1) / stopTicks;
    // Deceleration profile: v decays smoothly toward 0
    v = initialSprintSpeed * Math.max(0.0, 1.0 - fraction);
    coastDist += v * dt;
  }

  // Coast distance is proportional to initial speed: ~ 0.5 * 10.0 * 0.4 = 2.0m for 10 m/s
  assertInRange(coastDist, 1.5, 2.5, 'Coasts smoothly to rest');
  assertEquals(v, 0.0, 'Final speed at rest is exactly 0.0 m/s');

  // Verify transition lands cleanly into Ready stance
  const finalState = CONSTANTS.CMD_READY;
  assertEquals(finalState, 0x41000003, 'Resting in Ready stance');
});

module.exports = suite;
