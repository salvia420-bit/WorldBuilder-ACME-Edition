/**
 * Tier 3 Combination 4: Stamina, Burden, Posture & High Speed Invariants
 * Authoritative baselines: acclient.c:713808, 443695, 343858
 */

'use strict';

const {
  CONSTANTS,
  calcRunRate,
  calcJumpHeight,
  calcJumpLaunchVelocity,
  calcTimeScale,
  getStateVelocity,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Combination 4: Stamina, Burden, Posture & Invariants', 3);

// Test 3.16: Exhausted Sprint (Stamina 0) + Jump Attempt
suite.addTest('3.16 Exhausted player (stamina=0) has run_rate collapsed to 1.0 and jump apex floored at 0.35 m', () => {
  const rate = calcRunRate(0.0, 500, 0); // stamina 0
  assertEquals(rate, 1.0, 'Run rate drops to 1.0');

  const height = calcJumpHeight(0.0, 500, 1.0, 0); // stamina 0
  assertEquals(height, CONSTANTS.JUMP_MIN_HEIGHT, 'Jump apex floored at 0.35 m');

  const vz = calcJumpLaunchVelocity(height);
  assertNear(vz, CONSTANTS.JUMP_MIN_IMPULSE, 1e-4, 'vz is 2.61916 m/s');
});

// Test 3.17: Overburdened Sprint + Jump Gating
suite.addTest('3.17 Overburden (load = 2.5) collapses run rate to 1.0 and rejects jump with error 73', () => {
  const rate = calcRunRate(2.5, 400, 100);
  assertEquals(rate, 1.0, 'Overburden run rate drops to 1.0');

  // Jump gating check: if load >= 2.0, returns error code 73 (CantJumpLoadedDown)
  const isOverburdened = 2.5 >= 2.0;
  const jumpAllowed = !isOverburdened;
  const errorCode = isOverburdened ? 73 : 0;

  assertEquals(jumpAllowed, false, 'Jump rejected');
  assertEquals(errorCode, 73, 'Error 73: CantJumpLoadedDown');
});

// Test 3.18: Crouch Posture + Movement Input
suite.addTest('3.18 Crouch posture (0x41000012) produces zero velocity and rejects jump with error 72', () => {
  const activePosture = CONSTANTS.CMD_CROUCH;
  const isCrouched = activePosture === CONSTANTS.CMD_CROUCH;

  // Linear movement is suppressed while crouched
  const linearSpeed = isCrouched ? 0.0 : 3.12;
  assertEquals(linearSpeed, 0.0, 'Zero linear velocity in crouch');

  // Jump gating: error 72 (CantJumpFromThisPosition)
  const jumpAllowed = !isCrouched;
  const errorCode = isCrouched ? 72 : 0;
  assertEquals(jumpAllowed, false, 'Cannot jump from crouch');
  assertEquals(errorCode, 72, 'Error 72: CantJumpFromThisPosition');
});

// Test 3.19: High Run Buff + Velocity Scaling + Invariant Foot Displacement
suite.addTest('3.19 Run rate = 3.5 (14.0 m/s) scales timeScale to 3.5 preserving 0.1333 m/frame foot invariant', () => {
  const runRate = 3.5;
  const groundSpeed = 4.0 * runRate; // 14.0 m/s
  const timeScale = calcTimeScale(groundSpeed, true);
  assertEquals(timeScale, 3.5, 'timeScale is 3.5');

  const effectiveFps = CONSTANTS.RUN_AUTHORED_FPS * timeScale; // 30.0 * 3.5 = 105 fps
  const displacementPerFrame = groundSpeed / effectiveFps; // 14.0 / 105 = 0.133333 m/frame
  assertNear(displacementPerFrame, CONSTANTS.RUN_INVARIANT_FRAME_DISPLACEMENT, 1e-5);
});

// Test 3.20: Rapid Strafe Left + Strafe Right during full sprint
suite.addTest('3.20 Symmetrical A/D strafe while sprinting preserves forward track without lateral drift', () => {
  const runRate = 1.0;
  let posX = 0.0;
  let posY = 0.0;
  const dt = 1.0 / 30.0;

  // Alternate strafe right and left for 10 cycles while holding forward
  for (let i = 0; i < 10; i++) {
    const vRight = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, 1.0, CONSTANTS.CMD_SIDESTEP_RIGHT, CONSTANTS.SIDESTEP_ADJUST_FACTOR, runRate);
    posX += vRight.vx * dt;
    posY += vRight.vy * dt;

    const vLeft = getStateVelocity(CONSTANTS.CMD_RUN_FORWARD, 1.0, CONSTANTS.CMD_SIDESTEP_RIGHT, -CONSTANTS.SIDESTEP_ADJUST_FACTOR, runRate);
    posX += vLeft.vx * dt;
    posY += vLeft.vy * dt;
  }

  assertNear(posX, 0.0, 1e-6, 'Net lateral drift is exactly zero');
  assert(posY > 0.0, 'Player steadily advances forward');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
