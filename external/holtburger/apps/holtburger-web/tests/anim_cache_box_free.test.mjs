// tests/anim_cache_box_free.test.mjs — ENTITIES-5 (2026-10-18 systematic review):
// AnimationCache.get / getLink free the wasm EntityAnimationData box once its
// fields are copied out, instead of leaving the Rust payload to a later GC.
//
// The fake box behaves like the wasm-bindgen one: every getter clones (as the
// generated `.slice()` getters do) and THROWS after free(), so a read after the
// free would fail the bake; the cached entry must still be complete and usable.
//
//   F1  getLink frees the box once, and the entry carries its frames + hooks
//   F2  get frees the box once (after the meshes and rest pose are drained)
//   F3  a cache hit does not touch a box again
//
// Run from apps/holtburger-web/:  node tests/anim_cache_box_free.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { AnimationCache } from "../scene3d/animation.js";

const PART_COUNT = 2;
const NUM_FRAMES = 3;

function fakeBox() {
  const box = { frees: 0, live: true };
  const f32 = (n, fill) => { const a = new Float32Array(n); a.fill(fill); return a; };
  const fields = {
    partCount: PART_COUNT,
    numFrames: NUM_FRAMES,
    framerate: 30,
    duration: NUM_FRAMES / 30,
    resolvedStance: 0x8000003d,
    isLink: true,
    partFrames: () => f32(NUM_FRAMES * PART_COUNT * 7, 0.5),
    frameTimes: () => Float32Array.from([0, 1 / 30, 2 / 30]),
    posFrames: () => new Float32Array(0),
    segmentStarts: () => Uint32Array.from([0]),
    segmentCounts: () => Uint32Array.from([NUM_FRAMES]),
    segmentFramerates: () => Float32Array.from([30]),
    segmentAnimIds: () => Uint32Array.from([0x03000001]),
    rootMotionNet: () => Float32Array.from([0, 1, 0, 1, 0, 0, 0]),
    restOrigins: () => f32(PART_COUNT * 3, 0),
    restOrientations: () => f32(PART_COUNT * 4, 1),
  };
  for (const [name, v] of Object.entries(fields)) {
    Object.defineProperty(box, name, {
      get() {
        if (!box.live) throw new Error(`null pointer passed to rust (${name} after free)`);
        return typeof v === "function" ? v() : v;
      },
    });
  }
  box.takeHooks = () => {
    if (!box.live) throw new Error("takeHooks after free");
    return [{ timeInClipS: 1 / 30, hookType: 1, soundWaveId: 0x0a000001, free() {} }];
  };
  box.takePartMeshes = () => {
    if (!box.live) throw new Error("takePartMeshes after free");
    return [];
  };
  box.free = () => { box.frees += 1; box.live = false; };
  return box;
}

test("F1 getLink frees the EntityAnimationData box once; the entry is complete", async () => {
  const cache = new AnimationCache();
  const boxes = [];
  const fetchLink = async () => { const b = fakeBox(); boxes.push(b); return b; };
  const entry = await cache.getLink(0x02000001, 0x09000001, 0x41000003, 0x8000003d, 0x45000005, fetchLink);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].frees, 1, "freed after the copy");
  assert.equal(entry.linkOnly, true);
  assert.equal(entry.sequenceDescriptor.numFrames, NUM_FRAMES);
  assert.equal(entry.sequenceDescriptor.partFrames.length, NUM_FRAMES * PART_COUNT * 7);
  assert.equal(entry.sequenceDescriptor.partFrames[0], 0.5, "frames are a JS copy, readable after the free");
  assert.deepEqual([...entry.sequenceDescriptor.segmentCounts], [NUM_FRAMES]);
  assert.equal(entry.hooks.length, 1);
  assert.equal(entry.hooks[0].soundWaveId, 0x0a000001);
  assert.deepEqual([...entry.rootMotionNet], [0, 1, 0, 1, 0, 0, 0]);
  assert.ok(entry.clip, "the clip was built before the free");
});

test("F2 get frees the box once, after the meshes and rest pose are drained", async () => {
  const cache = new AnimationCache();
  const boxes = [];
  const fetchKeyframes = async () => { const b = fakeBox(); boxes.push(b); return b; };
  const entry = await cache.get(0x02000001, 0x09000001, 0x41000003, 0x8000003d, fetchKeyframes);
  assert.equal(boxes[0].frees, 1);
  assert.equal(entry.restOrigins.length, PART_COUNT * 3);
  assert.equal(entry.restOrientations[0], 1);
  assert.equal(entry.sequenceDescriptor.frameTimes.length, NUM_FRAMES);
  assert.equal(entry.hooks.length, 1);
});

test("F3 a cache hit reuses the entry without touching a box again", async () => {
  const cache = new AnimationCache();
  const boxes = [];
  const fetchLink = async () => { const b = fakeBox(); boxes.push(b); return b; };
  const a = await cache.getLink(0x02000001, 0x09000001, 0x41000003, 0x8000003d, 0x45000005, fetchLink);
  const b = await cache.getLink(0x02000001, 0x09000001, 0x41000003, 0x8000003d, 0x45000005, fetchLink);
  assert.equal(a, b);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].frees, 1);
  // A box without free() (an older pkg/, a plain mock) still bakes.
  const plain = await cache.getLink(0x02000002, 0x09000001, 0x41000003, 0x8000003d, 0x45000005,
    async () => { const x = fakeBox(); delete x.free; return x; });
  assert.equal(plain.sequenceDescriptor.numFrames, NUM_FRAMES);
});
