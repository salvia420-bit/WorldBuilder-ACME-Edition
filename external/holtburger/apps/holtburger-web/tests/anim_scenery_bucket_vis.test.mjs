// tests/anim_scenery_bucket_vis.test.mjs — ?animSceneryBucketVis (2026-10-17, default ON).
//
// THE BUG. Animated-scenery InstancedMesh buckets are direct staticsGroup
// children, so statics.js cullStaticsGroup frustum-tested them with a cull
// sphere it caches on FIRST SIGHT. A bucket keeps growing as the player visits
// landblocks; the cached sphere covered only its first placements. Live on the
// 1070 (2026-10-17) all 27 critter buckets were visible:false with spheres
// ~35 km away — every butterfly / seagull / bird invisible. Locks:
//   1. the bug, reproduced with the flag off, and fixed with it on;
//   2. a bucket hides while ALL its instances are collapsed (parked / hidden
//      anchor — degenerate slots, so pixel-identical) and shows again on
//      restore; a GPU-posed slot is restored to its static placement;
//   3. (2026-10-30, re-show fix) three uploads an instance attribute only
//      when the bucket is DRAWN; the matrices written while it was not drawn
//      (the last collapse before it hid; a tick with no render) must reach
//      the GPU when it draws again. Against a fake WebGL2 that keeps every
//      ARRAY_BUFFER's bytes, the GPU copy of every slot equals the CPU array
//      after each drawn frame (before the fix the slot collapsed in the
//      hiding frame kept its live matrix on the GPU: a ghost critter);
//   4. while the bucket is drawn every frame the upload is exactly as before:
//      one bufferSubData per frame over that frame's dirty slots only.
//
// Run from apps/holtburger-web/:  node tests/anim_scenery_bucket_vis.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

let pendingRaf = null;
globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame = (cb) => { pendingRaf = cb; return 1; };
globalThis.window.cancelAnimationFrame = () => {};

const THREE = await import("three");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const AS = await import("../scene3d/animated_scenery.js");
const S = await import("../scene3d/statics.js");
const { FrustumCuller } = await import("../scene3d/culling.js");

function wasm() {
  const tri = () => ({
    triCount: 1,
    positions: new Float32Array([0, 0, 0, 0.4, 0, 0, 0, 0.2, 0]),
    uvs: new Float32Array(6),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([0x08000010]),
  });
  const frames = [];
  for (let f = 0; f < 4; f++) frames.push(0, 0, 2 + f * 0.1, 1, 0, 0, 0);
  return {
    async fetchAnimation() { return { numParts: 1, numFrames: 4, flags: 2, frames: new Float32Array(frames), free() {} }; },
    async fetchBuildingPlacement() {
      return { partCount: 1, takePartMeshes: () => [tri()], takePartHingeFrames: () => [], free() {} };
    },
    fetch_surfaces_pixels: async () => [],
  };
}

function world() {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const staticsGroup = new THREE.Group();
  worldRoot.add(staticsGroup);
  const camera = new THREE.PerspectiveCamera(60, 1.5, 0.5, 3000);
  scene.add(camera);
  const scene3d = { scene, worldRoot, staticsGroup, camera, activeLights: [],
    materialCache: { get: async () => new THREE.MeshStandardMaterial() } };
  const culler = new FrustumCuller();
  const cull = () => {
    scene.updateMatrixWorld(true);
    culler.update(camera, worldRoot);
    S.cullStaticsGroup(scene3d, culler);
  };
  return { scene3d, cull };
}

// AC → three: (x, y, z) → (x, z, -y) under worldRoot's −π/2 X rotation.
function lookAtAc(cam, x, y, z) {
  cam.position.set(x - 30, z + 10, -(y - 30));
  cam.lookAt(x, z, -y);
  cam.updateMatrixWorld(true);
}

const place = (lb, idx, x, y) => ({ objId: 0x02000493, defaultAnimationId: 0x030006cb, landblockId: lb,
  sourceObjIdx: idx, x, y, z: 40, qw: 1, qx: 0, qy: 0, qz: 0 });
const LB_A = 0x10100000, LB_B = 0x40400000;
const acX = (lb, x) => ((lb >>> 24) & 0xff) * 192 + x;
const acY = (lb, y) => ((lb >>> 16) & 0xff) * 192 + y;

async function scenario(flag) {
  AS.__setAnimSceneryBucketVisForTest(flag);
  S.__setStaticsCullGateForTest(false);
  const w = world();
  await AS.attachAnimatedScenery(w.scene3d, [place(LB_A, 1, 50, 50)], wasm(), {});
  lookAtAc(w.scene3d.camera, acX(LB_A, 50), acY(LB_A, 50), 40);
  w.cull(); // the statics cull sees the bucket for the first time, near LB A
  await AS.attachAnimatedScenery(w.scene3d, [place(LB_B, 2, 80, 80)], wasm(), {});
  lookAtAc(w.scene3d.camera, acX(LB_B, 80), acY(LB_B, 80), 40); // ~8 km away, LB A behind
  if (pendingRaf) pendingRaf();
  w.cull();
  const bucket = w.scene3d.staticsGroup.children.find((o) => o.isInstancedMesh);
  return { w, bucket };
}

test("1. a grown bucket is no longer hidden by the stale cull sphere", async () => {
  const off = await scenario(false);
  assert.equal(off.bucket.count, 2, "setup: both placements in one bucket");
  assert.equal(off.bucket.visible, false, "flag off: the cached LB-A sphere hides the LB-B critter (the bug)");
  AS.disposeAnimatedScenery();
  const on = await scenario(true);
  assert.equal(on.bucket.visible, true, "flag on: the bucket draws");
  AS.disposeAnimatedScenery();
  AS.__setAnimSceneryBucketVisForTest(undefined);
  S.__setStaticsCullGateForTest(undefined);
});

test("2. hidden while every instance is collapsed; restore re-shows (GPU slot = placement)", async () => {
  AS.__setAnimSceneryBucketVisForTest(true);
  const { w, bucket } = await scenario(true);
  const anchors = w.scene3d.staticsGroup.children.filter((o) => o.userData?.isAnimatedScenery);
  assert.equal(anchors.length, 2);
  anchors[0].visible = false;
  pendingRaf();
  assert.equal(bucket.visible, true, "one live instance left → still drawn");
  anchors[1].visible = false;
  pendingRaf();
  assert.equal(bucket.visible, false, "all collapsed → hidden (degenerate slots only)");
  assert.equal(AS.animatedSceneryDiag().bucketsActive, 0);
  anchors[0].visible = true;
  pendingRaf();
  assert.equal(bucket.visible, true, "restored → drawn again");
  if (bucket.userData.animGpuRow >= 0) {
    const m = new THREE.Matrix4();
    const i = 0;
    bucket.getMatrixAt(i, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    const near = [anchors[0], anchors[1]].some((a) => a.position.distanceTo(p) < 1e-3);
    assert.ok(near || p.lengthSq() === 0, "GPU slot holds a static placement (or the collapsed zero)");
  }
  AS.disposeAnimatedScenery();
  AS.__setAnimSceneryBucketVisForTest(undefined);
});

// A world drawn by three r184 into a fake WebGL2 that mirrors every
// ARRAY_BUFFER's bytes (bufferData / bufferSubData as three issues them), so
// a test can read what the GPU holds for the bucket's instance matrices.
async function glWorld(n) {
  AS.disposeAnimatedScenery();
  AS.__setAnimSceneryBucketVisForTest(true);
  const ARRAY_BUFFER = 0x8892;
  const gpu = new Map(); // GL buffer -> { bytes, src }
  const subs = [];       // instance-buffer bufferSubData calls of the current frame
  let bound = null;
  let instanceArray = null;
  const gl = createFakeWebGL2({
    onCall(name, a) {
      if (name === "bindBuffer" && a[0] === ARRAY_BUFFER) bound = a[1];
      else if (name === "bufferData" && a[0] === ARRAY_BUFFER && ArrayBuffer.isView(a[1])) {
        const d = a[1];
        gpu.set(bound, { bytes: new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)), src: d });
      } else if (name === "bufferSubData" && a[0] === ARRAY_BUFFER) {
        const e = gpu.get(bound);
        const src = a[2];
        const bpe = src.BYTES_PER_ELEMENT;
        const off = a[3] || 0;
        const cnt = a[4] || (src.length - off);
        e.bytes.set(new Uint8Array(src.buffer, src.byteOffset + off * bpe, cnt * bpe), a[1]);
        if (src === instanceArray) subs.push([a[1], off, cnt]);
      }
    },
  });
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  const { scene3d } = world();
  const placements = [];
  for (let i = 0; i < n; i++) placements.push(place(LB_A, 10 + i, 40 + 6 * i, 50));
  await AS.attachAnimatedScenery(scene3d, placements, wasm(), {});
  const bucket = scene3d.staticsGroup.children.find((o) => o.isInstancedMesh);
  instanceArray = bucket.instanceMatrix.array;
  // anchors[k] draws in slot k (a GPU-posed slot holds its anchor's placement).
  const all = scene3d.staticsGroup.children.filter((o) => o.userData?.isAnimatedScenery);
  const m = new THREE.Matrix4();
  const anchors = [];
  for (let i = 0; i < bucket.count; i++) {
    bucket.getMatrixAt(i, m);
    anchors.push(all.find((a) => a.matrix.equals(m)));
  }
  assert.ok(anchors.every(Boolean) && new Set(anchors).size === n, "premise: one slot per anchor");
  const frame = (opts = {}) => {
    pendingRaf();
    if (opts.render !== false) renderer.render(scene3d.scene, scene3d.camera);
  };
  // The GPU copy of the bucket's instance matrices.
  const gpuMatrices = () => {
    for (const e of gpu.values()) if (e.src === bucket.instanceMatrix.array) return new Float32Array(e.bytes.buffer.slice(0));
    return null;
  };
  return { bucket, anchors, frame, gpuMatrices, subs };
}

function assertGpuMatchesCpu(w, label) {
  const g = w.gpuMatrices();
  assert.ok(g, `${label}: the instance buffer is on the GPU`);
  const cpu = w.bucket.instanceMatrix.array;
  for (let i = 0; i < w.bucket.count; i++) {
    assert.deepEqual(Array.from(g.subarray(i * 16, i * 16 + 16)), Array.from(cpu.subarray(i * 16, i * 16 + 16)),
      `${label}: slot ${i}'s GPU matrix is the CPU one`);
  }
}

test("3. a re-shown bucket uploads every write it missed while not drawn (no ghost from a stale GPU matrix)", async () => {
  const w = await glWorld(3);
  const zero = Array.from(new THREE.Matrix4().makeScale(0, 0, 0).elements); // the collapse matrix
  w.frame();
  assert.equal(w.bucket.visible, true);
  assertGpuMatchesCpu(w, "all live");
  // Hidden by ?animSceneryBucketVis: the frame that collapses the last live
  // instances hides the bucket, so their zeroed slots are not uploaded then.
  w.anchors[0].visible = false;
  w.frame();
  assertGpuMatchesCpu(w, "one collapsed, still drawn");
  w.anchors[1].visible = false;
  w.anchors[2].visible = false;
  w.frame();
  assert.equal(w.bucket.visible, false, "all collapsed -> hidden");
  const placed2 = Array.from(w.gpuMatrices().subarray(32, 48));
  assert.notDeepEqual(placed2, zero, "premise: while hidden the GPU still holds slot 2's placement (nothing drawn, nothing uploaded)");
  assert.deepEqual(placed2, Array.from(w.anchors[2].matrix.elements), "premise: ... its live placement");
  // Another instance comes back: the bucket draws again.
  w.anchors[0].visible = true;
  w.frame();
  assert.equal(w.bucket.visible, true, "re-shown");
  assert.deepEqual(Array.from(w.bucket.instanceMatrix.array.subarray(32, 48)), zero, "premise: slot 2 is collapsed on the CPU");
  assert.deepEqual(Array.from(w.gpuMatrices().subarray(32, 48)), zero,
    "slot 2's GPU matrix is the collapse, not its old placement (before the fix: a ghost critter at the old place)");
  assertGpuMatchesCpu(w, "re-shown");
  // A tick with no render in between (render throttled / skipped): the span
  // of the unrendered tick must not be dropped either — in both orders (a
  // pending span below and above the next one).
  w.anchors[1].visible = true;
  w.frame({ render: false }); // slot 1 restored, not drawn this tick
  w.anchors[2].visible = true;
  w.frame();                  // slot 2 restored, drawn
  assertGpuMatchesCpu(w, "after a tick without a render (pending span below)");
  w.anchors[2].visible = false;
  w.frame({ render: false }); // slot 2 collapsed, not drawn this tick
  w.anchors[0].visible = false;
  w.frame();                  // slot 0 collapsed, drawn
  assertGpuMatchesCpu(w, "after a tick without a render (pending span above)");
  // A whole-buffer upload asked for while not drawn (clearUpdateRanges +
  // needsUpdate, e.g. the ?animSceneryBatch teardown) stays whole through
  // the next flush instead of shrinking to that flush's span.
  w.anchors[1].visible = false;
  w.frame();
  assert.equal(w.bucket.visible, false, "hidden again");
  w.bucket.instanceMatrix.clearUpdateRanges();
  w.bucket.instanceMatrix.needsUpdate = true;
  w.anchors[2].visible = true;
  w.frame();
  assert.equal(w.bucket.visible, true);
  assertGpuMatchesCpu(w, "a whole upload asked for while hidden");
  AS.disposeAnimatedScenery();
  AS.__setAnimSceneryBucketVisForTest(undefined);
});

test("4. drawn every frame: one bufferSubData per frame over that frame's dirty slots, as before", async () => {
  const w = await glWorld(3);
  w.frame();
  const run = (label, mutate, want) => {
    mutate();
    w.subs.length = 0;
    w.frame();
    assert.deepEqual(w.subs, want, `${label}: [dstByteOffset, srcOffset, count]`);
  };
  run("collapse slot 0", () => { w.anchors[0].visible = false; }, [[0, 0, 16]]);
  run("collapse slot 2", () => { w.anchors[2].visible = false; }, [[128, 32, 16]]);
  run("restore slot 0", () => { w.anchors[0].visible = true; }, [[0, 0, 16]]);
  run("restore slot 2 + collapse slot 1", () => { w.anchors[2].visible = true; w.anchors[1].visible = false; }, [[64, 16, 32]]);
  run("nothing dirty", () => {}, []);
  assertGpuMatchesCpu(w, "drawn every frame");
  AS.disposeAnimatedScenery();
  AS.__setAnimSceneryBucketVisForTest(undefined);
});
