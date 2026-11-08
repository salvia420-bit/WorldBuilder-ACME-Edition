/**
 * Tier 4 Scenario 1: Full Sprint with Evasive Strafing (PvP Kiting)
 * Exercises Features: F2 (Run Speed), F3 (Run Rate), F5 (Strafe Speed), F6 (Diagonal Clamp), F14 (Playback Scaling)
 */

'use strict';

const {
  CONSTANTS,
  calcRunRate,
  adjustMotion,
  applyRunToCommand,
  getStateVelocity,
  calcTimeScale,
  assertNear,
  assertInRange,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Scenario 1: Full Sprint with Evasive Strafing', 4);

suite.addTest('S1 Full Sprint with Evasive Strafing over 10-second PvP engagement', () => {
  // Setup: Character with Run Skill = 250, zero burden
  const runSkill = 250;
  const load = 0.0;
  const stamina = 100;
  const runRate = calcRunRate(load, runSkill, stamina);
  // (1.0 * (250/450 * 11) + 4) / 4 = (6.111 + 4) / 4 = 2.52777
  assertNear(runRate, 2.5278, 1e-3);

  const maxSpeed = 4.0 * runRate; // ~10.11 m/s
  const dt = 1.0 / 30.0; // 30 Hz substepped simulation
  const totalTicks = 300; // 10 seconds

  let posX = 0.0;
  let posY = 0.0;
  let currentStrafeDirection = 1; // +1 = Right, -1 = Left
  let maxObservedSpeed = 0.0;

  for (let tick = 0; tick < totalTicks; tick++) {
    // Alternate strafe direction every 30 ticks (1.0 second)
    if (tick > 0 && tick % 30 === 0) {
      currentStrafeDirection *= -1;
    }

    const strafeCmd = currentStrafeDirection === 1 ? CONSTANTS.CMD_SIDESTEP_RIGHT : CONSTANTS.CMD_SIDESTEP_LEFT;
    const adjStrafe = adjustMotion(strafeCmd, 1.0);
    const runStrafe = applyRunToCommand(adjStrafe.command, adjStrafe.speed, runRate);

    const runFwd = applyRunToCommand(CONSTANTS.CMD_WALK_FORWARD, 1.0, runRate);

    const vel = getStateVelocity(
      runFwd.command,
      runFwd.speed,
      runStrafe.command,
      runStrafe.speed,
      runRate
    );

    // Assert speed never violates the diagonal speed clamp
    if (vel.mag > maxObservedSpeed) {
      maxObservedSpeed = vel.mag;
    }
    assert(vel.mag <= maxSpeed + 1e-5, `Planar speed ${vel.mag} must not exceed clamp ${maxSpeed}`);

    // Verify animation playback timeScale scales with actual speed
    const timeScale = calcTimeScale(vel.mag, true);
    assertNear(timeScale, vel.mag / 4.0, 1e-4, 'Playback timeScale perfectly tracks ground speed');

    // Foot displacement invariant
    const effectiveFps = CONSTANTS.RUN_AUTHORED_FPS * timeScale;
    const displacementPerFrame = vel.mag / effectiveFps;
    assertNear(displacementPerFrame, CONSTANTS.RUN_INVARIANT_FRAME_DISPLACEMENT, 1e-5, 'Zero foot-sliding invariant maintained');

    // Integrate position
    posX += vel.vx * dt;
    posY += vel.vy * dt;
  }

  // Verification of trajectory outcomes
  assertNear(maxObservedSpeed, maxSpeed, 1e-3, 'Player reached full clamped sprint speed');
  assertInRange(posY, 80.0, 105.0, 'Forward progress ~90-100 meters over 10 seconds');
  assertNear(posX, 0.0, 2.0, 'Symmetrical zig-zag strafing kept lateral drift near zero');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
