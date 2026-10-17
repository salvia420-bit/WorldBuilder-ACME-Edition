// tests/statics_cull_gate.test.mjs — ?staticsCullGate (2026-10-17, default ON).
//
// `cullStaticsGroup` re-tested every staticsGroup child against the frustum
// every frame (1070 profile: 170 ms of 7.25 s, ~0.8 ms/frame) — standing still
// it re-derived the previous frame's answer. The gate skips the walk while the
// AC-space MVP is bit-identical, the child count and `scene3d.activeLights`
// length are unchanged, with a full walk at least every 4th frame. Locks:
//   1. still camera: walk, 3 skips, walk (seen through a foreign write the
//      walk undoes);
//   2. camera move / child added / light attached re-run it the same frame;
//   3. END RESULT: every node's `visible` is identical, frame by frame, to an
//      ungated walk across camera motion, a stop, a bake and a light attach;
//   4. flag off → every frame walks; a POJO culler (no `_mvp`) never gates.
//
// Run from apps/holtburger-web/:  node tests/statics_cull_gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};

const THREE = await import("three");
const S = await import("../scene3d/statics.js");
const { FrustumCuller } = await import("../scene3d/culling.js");

function staticMesh(x, y) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
  m.position.set(x, y, 1);
  return m;
}

function world() {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2; // AC Z-up → three Y-up, as index.js
  scene.add(worldRoot);
  const staticsGroup = new THREE.Group();
  worldRoot.add(staticsGroup);
  // A ring of statics around the origin (AC x/y), so any heading culls some.
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    staticsGroup.add(staticMesh(Math.cos(a) * 60, Math.sin(a) * 60));
  }
  const camera = new THREE.PerspectiveCamera(50, 1.5, 0.5, 2000);
  scene.add(camera);
  const s3 = { scene, worldRoot, staticsGroup, camera, activeLights: [] };
  const culler = new FrustumCuller();
  const frame = () => {
    scene.updateMatrixWorld(true);
    culler.update(camera, worldRoot);
    return S.cullStaticsGroup(s3, culler);
  };
  return { s3, culler, frame };
}

function aim(cam, yawDeg) {
  const a = (yawDeg * Math.PI) / 180;
  cam.position.set(0, 2, 0);
  cam.lookAt(Math.cos(a) * 10, 2, -Math.sin(a) * 10);
  cam.updateMatrixWorld(true);
}

test("1-2. cadence while still; motion / bake / light attach re-run at once", () => {
  S.__setStaticsCullGateForTest(true);
  const w = world();
  aim(w.s3.camera, 0);
  w.frame();
  const probe = w.s3.staticsGroup.children.find((n) => n.visible);
  assert.ok(probe, "setup: something is in view");
  const walked = () => { probe.visible = false; w.frame(); return probe.visible === true; };
  assert.deepEqual([walked(), walked(), walked(), walked(), walked(), walked(), walked(), walked()],
    [false, false, false, true, false, false, false, true], "one walk per 4 frames while still");
  probe.visible = false;
  aim(w.s3.camera, 0.5); w.frame();
  assert.equal(probe.visible, true, "camera moved → walked this frame");
  aim(w.s3.camera, 0); w.frame(); // settle
  probe.visible = false;
  w.s3.staticsGroup.add(staticMesh(500, 500)); w.frame();
  assert.equal(probe.visible, true, "child added → walked this frame");
  probe.visible = false;
  w.s3.activeLights.push(new THREE.PointLight()); w.frame();
  assert.equal(probe.visible, true, "light attached → walked this frame");
  S.__setStaticsCullGateForTest(undefined);
});

test("3. node visibility identical to an ungated walk every frame", () => {
  const run = (gated) => {
    S.__setStaticsCullGateForTest(gated);
    const w = world();
    const out = [];
    let lightOwner = null;
    for (let f = 0; f < 50; f++) {
      if (f < 15) aim(w.s3.camera, f * 9); // panning
      else if (f < 30) aim(w.s3.camera, 135); // still
      else aim(w.s3.camera, 135 + (f - 30) * 0.25); // slow pan
      if (f === 20) w.s3.staticsGroup.add(staticMesh(-40, 45)); // bake lands while still
      if (f === 22) { // inside a skip window of the still-camera cadence
        // lighting.js attaches a lamp to an off-screen static, then pushes it
        // to activeLights — the guardrail must un-hide its owner.
        lightOwner = w.s3.staticsGroup.children.find((n) => !n.visible);
        const l = new THREE.PointLight();
        lightOwner.add(l);
        w.s3.activeLights.push(l);
      }
      w.frame();
      out.push(w.s3.staticsGroup.children.map((n) => (n.visible ? 1 : 0)).join(""));
    }
    S.__setStaticsCullGateForTest(undefined);
    return { out, lightOwnerVisible: lightOwner?.visible };
  };
  const ungated = run(false);
  const gated = run(true);
  assert.ok(ungated.out.some((r) => r.includes("0")) && ungated.out.some((r) => r.includes("1")), "setup: mixed cull");
  assert.equal(ungated.lightOwnerVisible, true, "setup: guardrail kept the lamp owner visible");
  for (let f = 0; f < ungated.out.length; f++) {
    assert.equal(gated.out[f], ungated.out[f], `frame ${f}: visibility differs`);
  }
});

test("4. flag off walks every frame; a culler without _mvp never gates", () => {
  S.__setStaticsCullGateForTest(false);
  const w = world();
  aim(w.s3.camera, 0);
  w.frame();
  const probe = w.s3.staticsGroup.children.find((n) => n.visible);
  for (let i = 0; i < 4; i++) { probe.visible = false; w.frame(); assert.equal(probe.visible, true); }
  S.__setStaticsCullGateForTest(true);
  const pojo = { valid: true, isSphereInFrustum: (s) => w.culler.isSphereInFrustum(s), getDistanceSq: () => 0 };
  for (let i = 0; i < 4; i++) {
    probe.visible = false;
    S.cullStaticsGroup(w.s3, pojo);
    assert.equal(probe.visible, true, "no _mvp → always walks");
  }
  S.__setStaticsCullGateForTest(undefined);
});
