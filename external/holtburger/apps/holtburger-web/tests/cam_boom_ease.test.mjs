// tests/cam_boom_ease.test.mjs — ?camBoomEase (2026-10-24, default ON): under
// the hard-locked follow camera, an occluder crossing the boom pulls the eye in
// at once, but the boom eases back OUT at retail's 0.45-stiffness rate (0.15 per
// 30 Hz tick, CameraManager::UpdateCamera acclient.c:147800-147842) instead of
// snapping from 0.2 m back to 6 m in one frame. Drives the real
// CameraSwitcher.prototype._easeBoomOut.
//
// Run: node tests/cam_boom_ease.test.mjs

import assert from "node:assert/strict";

globalThis.location = { search: "?rustPose=off" };
globalThis.window = globalThis;
{
  const winET = new EventTarget();
  globalThis.addEventListener = winET.addEventListener.bind(winET);
  globalThis.removeEventListener = winET.removeEventListener.bind(winET);
  globalThis.dispatchEvent = winET.dispatchEvent.bind(winET);
}
const doc = new EventTarget();
doc.activeElement = null;
globalThis.document = doc;

const { CameraSwitcher } = await import("../scene3d/camera.js");
const ease = CameraSwitcher.prototype._easeBoomOut;
const PIVOT_Z = 1.5; // VIEWER_PIVOT_Z_M
let failures = 0, passes = 0;
function t(name, fn) {
  try { fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name, "\n   ", e.message); }
}
const p = { x: 10, y: 20, z: 5 };
// An eye `len` metres behind the pivot along -y.
const eyeAt = (len) => ({ x: p.x, y: p.y - len, z: p.z + PIVOT_Z });
const lenOf = (e) => Math.hypot(e.x - p.x, e.y - p.y, e.z - (p.z + PIVOT_Z));

t("a pull-in is immediate", () => {
  const self = { _camBoomEaseOn: true, _prevBoomLen: 6.0 };
  const out = ease.call(self, eyeAt(0.3), p, 1 / 60, false);
  assert.ok(Math.abs(lenOf(out) - 0.3) < 1e-9);
  assert.ok(Math.abs(self._prevBoomLen - 0.3) < 1e-9);
});

t("re-extension eases at 0.15 per 1/30 s and converges", () => {
  const self = { _camBoomEaseOn: true, _prevBoomLen: 0.3 };
  const first = lenOf(ease.call(self, eyeAt(6.0), p, 1 / 30, false));
  assert.ok(Math.abs(first - (0.3 + 5.7 * 0.15)) < 1e-6, `first step ${first}`);
  let L = first;
  for (let i = 0; i < 60; i += 1) L = lenOf(ease.call(self, eyeAt(6.0), p, 1 / 60, false));
  assert.ok(L > 5.95 && L <= 6.0 + 1e-9, `after 1 s: ${L}`);
});

t("the same rate at 60 and 30 fps (frame-rate independent)", () => {
  const a = { _camBoomEaseOn: true, _prevBoomLen: 1.0 };
  const b = { _camBoomEaseOn: true, _prevBoomLen: 1.0 };
  let la, lb;
  for (let i = 0; i < 6; i += 1) la = lenOf(ease.call(a, eyeAt(6.0), p, 1 / 60, false));
  for (let i = 0; i < 3; i += 1) lb = lenOf(ease.call(b, eyeAt(6.0), p, 1 / 30, false));
  assert.ok(Math.abs(la - lb) < 1e-6, `${la} vs ${lb}`);
});

t("the eased eye stays on this frame's swept direction (never past the sweep)", () => {
  const self = { _camBoomEaseOn: true, _prevBoomLen: 1.0 };
  const swept = { x: p.x + 3, y: p.y - 4, z: p.z + PIVOT_Z }; // 5 m, oblique
  const out = ease.call(self, swept, p, 1 / 60, false);
  const cross = (out.x - p.x) * (swept.y - p.y) - (out.y - p.y) * (swept.x - p.x);
  assert.ok(Math.abs(cross) < 1e-9, "collinear with the swept eye");
  assert.ok(lenOf(out) < 5.0);
});

// ?camTerrainEase: a pull-in the terrain sweep alone forced glides in (half the
// gap per 1/30 s), each eased eye floored above the ground at its own spot.
const P = CameraSwitcher.prototype;
const terrainSelf = (extra) => Object.assign(Object.create(P), {
  _camBoomEaseOn: true, _camTerrainEaseOn: true, _clipTerrainBound: true, _prevBoomLen: 5.87, ...extra,
});
t("a terrain-only pull-in glides: half the gap per 1/30 s, settled in ~0.15 s", () => {
  const self = terrainSelf();
  const first = lenOf(ease.call(self, eyeAt(2.76), p, 1 / 30, false, null));
  assert.ok(Math.abs(first - (5.87 - 3.11 * 0.5)) < 1e-6, `first step ${first}`);
  let L = first;
  for (let i = 0; i < 9; i += 1) L = lenOf(ease.call(self, eyeAt(2.76), p, 1 / 60, false, null));
  assert.ok(L - 2.76 < 0.1, `after ~0.18 s: ${L}`);
});

t("each eased eye is floored above the terrain under it", () => {
  const self = terrainSelf();
  // A crest under the eased eye's spot: the ground there is 3 m above the pivot.
  const ctx = { handle: { terrainHeightAt: () => p.z + PIVOT_Z + 3 }, indoor: false };
  const out = ease.call(self, eyeAt(2.76), p, 1 / 30, false, ctx);
  assert.ok(Math.abs(out.z - (p.z + PIVOT_Z + 3 + 0.7)) < 1e-9, `z ${out.z}`);
  assert.ok(Math.abs(Math.hypot(out.x - p.x, out.y - p.y) - (5.87 - 3.11 * 0.5)) < 1e-6, "horizontal glide unchanged");
});

t("the eased eye is re-swept (no terrain) and stops at a wall inside the glide span", () => {
  const calls = [];
  const self = terrainSelf({
    // A wall 4.0 m out along the boom: the chain clips anything past it.
    _clipCameraAgainstWorld(pp, x, y, z, ctx, floor, terrain) {
      calls.push({ floor, terrain });
      const L = Math.hypot(x - pp.x, y - pp.y, z - (pp.z + PIVOT_Z));
      if (L <= 4.0) return { x, y, z };
      const s = 4.0 / L;
      return { x: pp.x + (x - pp.x) * s, y: pp.y + (y - pp.y) * s, z: pp.z + PIVOT_Z + (z - pp.z - PIVOT_Z) * s };
    },
  });
  const ctx = { handle: { terrainHeightAt: () => -1e9 }, indoor: false };
  const out = ease.call(self, eyeAt(2.76), p, 1 / 30, false, ctx);
  assert.deepEqual(calls, [{ floor: false, terrain: false }], "one re-sweep, terrain sweep off");
  assert.ok(Math.abs(lenOf(out) - 4.0) < 1e-9, `stopped at the wall: ${lenOf(out)}`);
  assert.ok(Math.abs(self._prevBoomLen - 4.0) < 1e-9);
  assert.equal(self._clipTerrainBound, true, "the re-sweep does not overwrite the frame's marker");
});

t("a wall / static clip (not terrain-bound), and =off, still pull in at once", () => {
  for (const extra of [{ _clipTerrainBound: false }, { _camTerrainEaseOn: false }]) {
    const self = terrainSelf(extra);
    assert.ok(Math.abs(lenOf(ease.call(self, eyeAt(2.76), p, 1 / 60, false, null)) - 2.76) < 1e-9);
  }
  const reseed = terrainSelf();
  assert.ok(Math.abs(lenOf(ease.call(reseed, eyeAt(2.76), p, 1 / 60, true, null)) - 2.76) < 1e-9, "skip snaps");
});

t("skip (stiffness lerp active / snapped step) and =off pass the swept eye through", () => {
  const s1 = { _camBoomEaseOn: true, _prevBoomLen: 0.3 };
  assert.ok(Math.abs(lenOf(ease.call(s1, eyeAt(6.0), p, 1 / 60, true)) - 6.0) < 1e-9);
  const s2 = { _camBoomEaseOn: false, _prevBoomLen: 0.3 };
  assert.ok(Math.abs(lenOf(ease.call(s2, eyeAt(6.0), p, 1 / 60, false)) - 6.0) < 1e-9);
  const s3 = { _camBoomEaseOn: true, _prevBoomLen: null };
  assert.ok(Math.abs(lenOf(ease.call(s3, eyeAt(6.0), p, 1 / 60, false)) - 6.0) < 1e-9, "unseeded snaps");
});

console.log(`\ncam_boom_ease: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
