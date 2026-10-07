// tests/paperdoll_retail_framing.test.mjs — bug 13 (2026-10-07): the
// inventory paperdoll faced away from the viewer, from an angled camera.
// Retail: doll heading 191.3679° (gmPaperDollUI::RedressCreature,
// acclient.c:220051), fixed camera eye (0.12, -2.4, 0.88) looking along +Y,
// 45° FOV (acclient.c:221604-221611, :145328); per-heritage eyes from
// UpdateForRace (:220179).
//
// Run from apps/holtburger-web/:  node tests/paperdoll_retail_framing.test.mjs

import assert from "node:assert/strict";
import * as THREE from "three";

globalThis.window = { location: { search: "" }, devicePixelRatio: 1 };
const pd = await import("../ui/ac_paperdoll_viewport.js");

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};

// The viewport's transform chain without a WebGL renderer: dollRoot maps
// AC → three (−π/2 about X); rigRoot (AC frame) carries the heading.
const dollRoot = new THREE.Group();
dollRoot.rotation.x = -Math.PI / 2;
const rigRoot = new THREE.Group();
rigRoot.rotation.z = -pd.PAPERDOLL_HEADING_DEG * Math.PI / 180;
dollRoot.add(rigRoot);
const probe = new THREE.Object3D();
probe.position.set(0, 1, 0); // a point 1 m in front of the doll (AC +Y = model forward)
rigRoot.add(probe);
dollRoot.updateMatrixWorld(true);

check("retail constants", () => {
  assert.equal(pd.PAPERDOLL_HEADING_DEG, 191.3679);
  assert.equal(pd.PAPERDOLL_FOV_DEG, 45);
  assert.deepEqual(pd.paperdollEyeForHeritage(1), [0.12, -2.4, 0.88]);
  assert.deepEqual(pd.paperdollEyeForHeritage(7), [0.12, -3.0, 0.88]);
  assert.deepEqual(pd.paperdollEyeForHeritage(8), [0.12, -3.4, 1.0]);
  assert.deepEqual(pd.paperdollEyeForHeritage(13), [0.12, -3.4, 0.88]);
});

check("the doll faces the camera, turned ~11.4° (not its back)", () => {
  const fwd = new THREE.Vector3();
  probe.getWorldPosition(fwd);
  fwd.y = 0;
  fwd.normalize();
  const [ex, ey, ez] = pd.paperdollEyeForHeritage(1);
  const cam = new THREE.Vector3(ex, ez, -ey); // AC eye in three space
  const toCam = cam.clone().setY(0).normalize();
  const angle = THREE.MathUtils.radToDeg(Math.acos(Math.max(-1, Math.min(1, fwd.dot(toCam)))));
  assert.ok(fwd.z > 0.95, `forward ${fwd.toArray().map((v) => v.toFixed(3))} should point at +Z (the camera side)`);
  assert.ok(angle < 15, `doll is ${angle.toFixed(1)}° off the camera line`);
});

check("the camera looks straight along AC +Y (level, not down at the doll)", () => {
  const [ex, ey, ez] = pd.paperdollEyeForHeritage(1);
  const camera = new THREE.PerspectiveCamera(pd.PAPERDOLL_FOV_DEG, 1, 0.05, 50);
  camera.position.set(ex, ez, -ey);
  camera.lookAt(ex, ez, -ey - 1);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  assert.ok(Math.abs(dir.y) < 1e-6, "no pitch");
  assert.ok(dir.z < -0.999, "looks along three −Z = AC +Y");
});

console.log(`\npaperdoll_retail_framing: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
