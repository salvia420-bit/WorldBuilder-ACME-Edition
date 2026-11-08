/**
 * Feature 14: Velocity-to-Playback Scaling & Invariant Synchrony (0.1333 m/frame)
 * Authoritative baseline: acclient.c:337445, MotionTable 0x09000001
 */

'use strict';

const {
  CONSTANTS,
  calcTimeScale,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 14: Velocity Playback Scaling & Invariant Synchrony', 1);

// Test 14.1: Run playback timeScale at 4.0 m/s equals exactly 1.0000
suite.addTest('14.1 Run playback timeScale at baseline 4.0 m/s equals 1.0000', () => {
  const ts = calcTimeScale(4.0, true);
  assertEquals(ts, 1.0000, 'timeScale at 4.0 m/s is 1.0');
});

// Test 14.2: Run playback timeScale at 6.0 m/s equals 1.5000
suite.addTest('14.2 Run playback timeScale at 6.0 m/s equals 1.5000', () => {
  const ts = calcTimeScale(6.0, true);
  assertEquals(ts, 1.5000, 'timeScale at 6.0 m/s is 1.5');
});

// Test 14.3: Displacement per animation frame is an absolute mathematical invariant (0.1333 m/frame)
suite.addTest('14.3 Physical displacement per frame is an absolute invariant across all run speeds', () => {
  const testSpeeds = [2.0, 4.0, 6.0, 8.0, 10.0, 12.0];
  const authoredFps = CONSTANTS.RUN_AUTHORED_FPS; // 30.0

  for (const v of testSpeeds) {
    const timeScale = calcTimeScale(v, true);
    const effectiveFps = authoredFps * timeScale;
    const displacementPerFrame = v / effectiveFps;

    assertNear(
      displacementPerFrame,
      CONSTANTS.RUN_INVARIANT_FRAME_DISPLACEMENT,
      1e-5,
      `Displacement per frame at speed ${v} m/s matches 0.13333 m/frame`
    );
  }
});

// Test 14.4: Walk playback timeScale at authored base 2.6017 m/s equals 1.0000
suite.addTest('14.4 Walk playback timeScale at cycle base 2.6017 m/s equals 1.0000', () => {
  const ts = calcTimeScale(CONSTANTS.CYCLE_BASE_WALK_SPEED, false);
  assertNear(ts, 1.0000, 1e-4, 'timeScale at 2.6017 m/s is 1.0');
});

// Test 14.5: Walk playback timeScale at closed-form 3.12 m/s equals 3.12 / 2.6017 = 1.1992
suite.addTest('14.5 Walk playback timeScale at 3.12 m/s equals ~1.1992', () => {
  const ts = calcTimeScale(CONSTANTS.WALK_ANIM_SPEED, false);
  const expected = 3.1199999 / 2.6017;
  assertNear(ts, expected, 1e-4, 'timeScale at 3.12 m/s matches ratio ~ 1.1992');
});

module.exports = suite;
