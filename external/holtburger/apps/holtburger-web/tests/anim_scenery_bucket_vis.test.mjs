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
//      restore; a GPU-posed slot is restored to its static placement.
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
