// tests/jump_animation_lifecycle.test.mjs
// Milestone 3 Jump Animation Lifecycle & Crossfade Standards Unit Tests
// Features 33-37: Jump takeoff, airborne loop in-place, landing recovery, and crossfade standards

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

import {
  CROSSFADE_LOCO_MS,
  CROSSFADE_STANCE_MS,
  CROSSFADE_TAKEOFF_MS,
  CROSSFADE_LANDING_MS,
  CROSSFADE_STANDARDS,
  cycleTimeScale,
} from '../scene3d/animation.js';

import { isLocomotionLink, canonicalCycleBaseSpeed } from '../scene3d/entities.js';

// Feature 37: Crossfade Duration Standards
test('Feature 37: Animation crossfade standards are properly exported and match decomp specs', () => {
  assert.equal(CROSSFADE_LOCO_MS, 120, 'Locomotion crossfade is 120 ms');
  assert.equal(CROSSFADE_STANCE_MS, 150, 'Stance crossfade is 150 ms');
  assert.equal(CROSSFADE_TAKEOFF_MS, 80, 'Takeoff crossfade is 80 ms');
  assert.equal(CROSSFADE_LANDING_MS, 60, 'Landing crossfade is 60 ms');
  assert.deepEqual(CROSSFADE_STANDARDS, {
    locomotion: 120,
    stance: 150,
    takeoff: 80,
    landing: 60,
  });
});

// Feature 33: Jump Takeoff Link Recognition
test('Feature 33: Takeoff transitions (Run->Falling, Ready->Falling, Walk->Falling) are classified as locomotion links', () => {
  const CMD_READY = 0x41000003;
  const CMD_RUN_FORWARD = 0x44000007;
  const CMD_WALK_FORWARD = 0x45000005;
  const CMD_FALLING = 0x40000015;

  assert.equal(isLocomotionLink(CMD_RUN_FORWARD, CMD_FALLING), true, 'Run -> Falling is loco link (in-place)');
  assert.equal(isLocomotionLink(CMD_READY, CMD_FALLING), true, 'Ready -> Falling is loco link (in-place)');
  assert.equal(isLocomotionLink(CMD_WALK_FORWARD, CMD_FALLING), true, 'Walk -> Falling is loco link (in-place)');
});

// Feature 34: Airborne Falling Loop In-Place Posing
test('Feature 34: Airborne Falling loop maintains inPlace posing without root translation drift', async () => {
  const { poseRigAt, _setInPlaceExactForTest } = await import('../scene3d/motion/motion_sequence.js');
  if (typeof _setInPlaceExactForTest === 'function') {
    _setInPlaceExactForTest(true);
  }

  const group = () => ({
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } },
  });

  // Synthesize falling cycle with folded forward translation drift
  const numFrames = 4;
  const partCount = 2;
  const partFrames = new Float32Array(numFrames * partCount * 7);
  const rootFrames = new Float32Array(numFrames * 7);
  for (let f = 0; f < numFrames; f++) {
    rootFrames.set([0, 0.2 * (f + 1), 0, 1, 0, 0, 0], f * 7); // Root translated forward
    for (let p = 0; p < partCount; p++) {
      partFrames.set([p * 0.5, 0.2 * (f + 1), 1.0, 0, 0, 0, 1], (f * partCount + p) * 7);
    }
  }

  const desc = { partFrames, partCount, numFrames, posFrames: new Float32Array(numFrames * 3), rootFrames };
  const parts = [group(), group()];

  // Pose with inPlace = true (lo.hold !== true for Falling cycle)
  poseRigAt(2, desc, parts, true);

  // Position Y must have root translation undone (0.2 * 3 = 0.6 undone -> 0)
  assert.ok(Math.abs(parts[0].position.y) < 1e-5, 'In-place posing strips root forward translation drift');
  assert.ok(Math.abs(parts[1].position.y) < 1e-5, 'Part 1 also stripped of drift');
});

// Feature 35 & 36: Landing Recovery Links
test('Feature 35 & 36: Landing recovery links (Falling->Run, Falling->Ready) are locomotion links', () => {
  const CMD_READY = 0x41000003;
  const CMD_RUN_FORWARD = 0x44000007;
  const CMD_FALLING = 0x40000015;

  assert.equal(isLocomotionLink(CMD_FALLING, CMD_RUN_FORWARD), true, 'Falling -> Run is loco link (hop2 link)');
  assert.equal(isLocomotionLink(CMD_FALLING, CMD_READY), true, 'Falling -> Ready is loco link (standing snap)');
});

// Feature 28 & 29: Invariant Foot Synchrony across Run Skill Levels
test('Feature 28 & 29: Constant 0.1333 m/frame displacement across all run skill levels', () => {
  const AUTHORED_BASE_SPEED = 4.0000; // m/s
  const AUTHORED_FPS = 30.0;          // frames/s
  const EXPECTED_DISPLACEMENT = AUTHORED_BASE_SPEED / AUTHORED_FPS; // 0.13333333333333333 m/frame

  // Test across multiple run skill levels / burden multipliers (run rates)
  const testRunRates = [1.0, 1.25, 1.5, 2.0, 2.25, 2.5, 3.0, 3.5, 4.0];

  for (const rate of testRunRates) {
    const groundSpeed = 4.0000 * rate;
    const timeScale = cycleTimeScale(groundSpeed, AUTHORED_BASE_SPEED);
    assert.ok(Math.abs(timeScale - rate) < 1e-4, `Time scale matches run rate ${rate}`);

    const effectiveFps = AUTHORED_FPS * timeScale;
    const frameDisplacement = groundSpeed / effectiveFps;

    assert.ok(
      Math.abs(frameDisplacement - EXPECTED_DISPLACEMENT) < 1e-6,
      `Frame displacement strictly invariant at rate ${rate}: got ${frameDisplacement}`
    );
  }
});
