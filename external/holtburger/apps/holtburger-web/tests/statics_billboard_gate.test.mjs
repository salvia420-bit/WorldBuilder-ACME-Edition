// tests/statics_billboard_gate.test.mjs — ?billboardTickGate (2026-10-17, default ON).
//
// statics.js loads as two module instances on the unbundled page, so two
// `_bbLoop`s walked staticsGroup every frame (1070 profile: 37.9 + 35.1 ms of
// 7.25 s), and each walk re-faced every degraded leaf even with the camera
// still. `staticsBillboardTickDue(scene3d, ts)` lets one walk per frame through
// and skips frames whose answer cannot have changed. Locks:
//   1. a second call with the same rAF timestamp is dropped;
//   2. still camera: walk, 2 hold walks, then 1 walk per 8 frames;
//   3. camera move / child-count change re-arms immediately;
//   4. flag off → every call walks (legacy);
//   5. END RESULT: leaf quaternions are identical, frame by frame, to an
//      ungated walk every frame — across a camera move, a stop, and a node
//      added mid-run (identity matrixWorld until the following render).
//
// Run from apps/holtburger-web/:  node tests/statics_billboard_gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};

const THREE = await import("three");
const S = await import("../scene3d/statics.js");

function billboardLod(x, y) {
  const lod = new THREE.LOD();
  const near = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
  const far = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
  lod.addLevel(near, 0);
  lod.addLevel(far, 30);
  lod.position.set(x, y, 0);
  lod.userData.billboardMode = 2;
  lod.userData.billboardLevel = 1;
  return lod;
}

function world() {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const staticsGroup = new THREE.Group();
  worldRoot.add(staticsGroup);
  const cam = new THREE.PerspectiveCamera(60, 1.5, 0.1, 5000);
  scene.add(cam);
  for (let i = 0; i < 6; i++) staticsGroup.add(billboardLod(40 + i * 10, 25 * (i % 3)));
  scene.updateMatrixWorld(true);
  return { scene, staticsGroup, camera: cam };
}

test("1-4. dedupe, still-camera cadence, re-arm, flag off", () => {
  S.__setBillboardTickGateForTest(true);
  const w = world();
  w.camera.position.set(0, 2, 0);
  let ts = 0;
  const due = () => S.staticsBillboardTickDue(w, ts);
  ts = 16; assert.equal(due(), true, "first frame walks");
  assert.equal(due(), false, "same frame, second module instance: dropped");
  const seq = [];
  for (let f = 0; f < 19; f++) { ts += 16; seq.push(due() ? 1 : 0); }
  assert.deepEqual(seq, [1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0],
    "two hold walks, then one walk per 8 frames");
  ts += 16; w.camera.position.x += 0.01; assert.equal(due(), true, "camera moved");
  ts += 16; assert.equal(due(), true, "hold 1");
  ts += 16; assert.equal(due(), true, "hold 2");
  ts += 16; assert.equal(due(), false, "settled");
  ts += 16; w.staticsGroup.add(billboardLod(-50, 0)); assert.equal(due(), true, "child added");
  S.__setBillboardTickGateForTest(false);
  ts += 16; assert.equal(due(), true);
  assert.equal(due(), true, "flag off: no dedupe");
  S.__setBillboardTickGateForTest(undefined);
});

test("5. leaf facing identical to an ungated walk every frame", () => {
  const run = (gated) => {
    S.__setBillboardTickGateForTest(gated);
    const w = world();
    const out = [];
    for (let f = 0; f < 60; f++) {
      const ts = (f + 1) * 16.6;
      // An async bake lands BETWEEN frames: the node's matrixWorld is still
      // identity when the next _bbLoop walks (it runs before the render).
      if (f === 33) w.staticsGroup.add(billboardLod(70, -40));
      // rAF order on the page: both _bbLoops, then the main tick (camera), then render.
      if (S.staticsBillboardTickDue(w, ts)) S.tickStaticsBillboards(w);
      S.staticsBillboardTickDue(w, ts); // the second module instance (dropped or walks)
      if (!gated) S.tickStaticsBillboards(w);
      if (f < 20) w.camera.position.set(f * 0.7, 2 + f * 0.05, 3); // moving, then still
      w.scene.updateMatrixWorld(true); // the render: matrixWorld + LOD levels
      for (const lod of w.staticsGroup.children) lod.update(w.camera);
      const q = [];
      for (const lod of w.staticsGroup.children) {
        const leaf = lod.levels[1].object;
        q.push(leaf.visible ? leaf.quaternion.toArray().map((v) => +v.toFixed(6)).join(",") : "hidden");
      }
      out.push(q.join("|"));
    }
    S.__setBillboardTickGateForTest(undefined);
    return out;
  };
  const ungated = run(false);
  const gated = run(true);
  assert.ok(ungated.some((r) => r.includes(",")), "setup: some degraded leaves are showing");
  for (let f = 0; f < ungated.length; f++) {
    assert.equal(gated[f], ungated[f], `frame ${f}: drawn leaf facing differs`);
  }
});
