// tests/anim_cache_single_getter_lazy_clip.test.mjs — Area 7 (2026-11):
// AnimationCache single-read WASM getters & lazy AnimationClip creation.
//
// 1. WASM getters (partFrames, posFrames, rootMotionNet, frameTimes, duration,
//    segmentStarts, segmentCounts, segmentFramerates, segmentAnimIds, etc.)
//    are accessed at most ONCE per bake rather than 3-5x repeatedly.
// 2. entry.clip is lazy: THREE.AnimationClip is NOT constructed eagerly
//    during bake; accessing entry.clip computes and memoizes it on demand.
// 3. getLink also enforces single-read WASM getters and lazy clip evaluation.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { AnimationCache } from "../scene3d/animation.js";

const PART_COUNT = 3;
const NUM_FRAMES = 4;

function createTrackedBox(opts = {}) {
  const getterCounts = {};
  const box = { frees: 0, live: true, getterCounts };
  const f32 = (n, fill) => {
    const a = new Float32Array(n);
    a.fill(fill);
    return a;
  };

  const fields = {
    partCount: PART_COUNT,
    numFrames: NUM_FRAMES,
    framerate: 30,
    duration: NUM_FRAMES / 30,
    resolvedStance: 0x8000003d,
    isLink: opts.isLink ?? false,
    partFrames: () => f32(NUM_FRAMES * PART_COUNT * 7, 0.25),
    frameTimes: () => Float32Array.from([0, 1 / 30, 2 / 30, 3 / 30]),
    posFrames: () => new Float32Array(0),
    segmentStarts: () => Uint32Array.from([0]),
    segmentCounts: () => Uint32Array.from([NUM_FRAMES]),
    segmentFramerates: () => Float32Array.from([30]),
    segmentAnimIds: () => Uint32Array.from([0x03000001]),
    rootMotionNet: () => Float32Array.from([0, 1, 0, 1, 0, 0, 0]),
    rootFrames: () => new Float32Array(0),
    restOrigins: () => f32(PART_COUNT * 3, 0),
    restOrientations: () => f32(PART_COUNT * 4, 1),
  };

  for (const [name, v] of Object.entries(fields)) {
    Object.defineProperty(box, name, {
      get() {
        if (!box.live) throw new Error(`null pointer passed to rust (${name} after free)`);
        getterCounts[name] = (getterCounts[name] || 0) + 1;
        return typeof v === "function" ? v() : v;
      },
    });
  }

  box.takeHooks = () => {
    if (!box.live) throw new Error("takeHooks after free");
    getterCounts.takeHooks = (getterCounts.takeHooks || 0) + 1;
    return [{ timeInClipS: 1 / 30, hookType: 1, soundWaveId: 0x0a000001, free() {} }];
  };

  box.takePartMeshes = () => {
    if (!box.live) throw new Error("takePartMeshes after free");
    getterCounts.takePartMeshes = (getterCounts.takePartMeshes || 0) + 1;
    return [];
  };

  box.free = () => {
    box.frees += 1;
    box.live = false;
  };

  return box;
}

test("1. AnimationCache.get reads #[wasm_bindgen(getter)] properties at most ONCE", async () => {
  const cache = new AnimationCache();
  const trackedBox = createTrackedBox();
  const fetchKeyframes = async () => trackedBox;

  const entry = await cache.get(0x02000001, 0x09000001, 0x41000003, 0x8000003d, fetchKeyframes);

  assert.equal(trackedBox.frees, 1, "wasm box freed once");
  const heavyGetters = [
    "partFrames",
    "posFrames",
    "rootMotionNet",
    "frameTimes",
    "duration",
    "segmentStarts",
    "segmentCounts",
    "segmentFramerates",
    "segmentAnimIds",
    "restOrigins",
    "restOrientations",
  ];

  for (const getter of heavyGetters) {
    const count = trackedBox.getterCounts[getter] || 0;
    assert.ok(
      count <= 1,
      `Getter '${getter}' was accessed ${count} times; expected at most 1 read to avoid cloning Vec<f32>`
    );
  }

  assert.equal(entry.sequenceDescriptor.numFrames, NUM_FRAMES);
  assert.equal(entry.sequenceDescriptor.partFrames.length, NUM_FRAMES * PART_COUNT * 7);
});

test("2. AnimationCache creates THREE.AnimationClip lazily on demand and memoizes it", async () => {
  const cache = new AnimationCache();
  const trackedBox = createTrackedBox();
  const fetchKeyframes = async () => trackedBox;

  const entry = await cache.get(0x02000002, 0x09000001, 0x41000003, 0x8000003d, fetchKeyframes);

  assert.equal(entry.hasClip, true, "hasClip indicates clip availability without building");

  // Read descriptor of property 'clip' on entry
  const propDesc = Object.getOwnPropertyDescriptor(entry, "clip");
  assert.ok(propDesc && typeof propDesc.get === "function", "entry.clip should have a getter function");

  // Access entry.clip to trigger lazy creation
  const clip1 = entry.clip;
  assert.ok(clip1 instanceof THREE.AnimationClip, "entry.clip produces a valid THREE.AnimationClip");
  assert.equal(clip1.duration, NUM_FRAMES / 30);

  // Subsequent accesses return the memoized instance
  const clip2 = entry.clip;
  assert.strictEqual(clip1, clip2, "entry.clip is memoized and returns the identical instance");
});

test("3. AnimationCache.getLink single-read WASM getters and lazy clip", async () => {
  const cache = new AnimationCache();
  const trackedBox = createTrackedBox({ isLink: true });
  const fetchLink = async () => trackedBox;

  const entry = await cache.getLink(0x02000003, 0x09000001, 0x41000003, 0x8000003d, 0x45000005, fetchLink);

  assert.equal(trackedBox.frees, 1);
  const count = trackedBox.getterCounts.partFrames || 0;
  assert.ok(count <= 1, `partFrames accessed ${count} times, expected <= 1`);
  assert.equal(entry.hasClip, true);

  const clip = entry.clip;
  assert.ok(clip instanceof THREE.AnimationClip);
  assert.strictEqual(entry.clip, clip);
});
