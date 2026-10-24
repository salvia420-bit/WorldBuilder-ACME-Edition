// tests/cam_terrain_sweep.test.mjs — ?camTerrainSweep (2026-10-24, default
// ON): the follow camera sweeps the boom (pivot → eye) against the terrain,
// not only flooring the eye, so a crest between the eye and the runner pulls
// the eye in instead of hiding the character (retail SmartBox::update_viewer,
// acclient.c:144991). Drives the real CameraSwitcher.prototype methods.
//
// Run: node tests/cam_terrain_sweep.test.mjs

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
const P = CameraSwitcher.prototype;
let failures = 0, passes = 0;
function t(name, fn) {
  try { fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name, "\n   ", e.message); }
}

// Player at the origin facing +y; the eye 6 m behind (-y) and 2.8 m up.
const p = { x: 0, y: 0, z: 0 };
const flat = { terrainHeightAt: () => 0 };
// A ridge 3 m behind the player rising to 2.6 m (the runner has just crossed
// the crest going downhill; the eye sits back up the far slope).
const ridge = { terrainHeightAt: (x, y) => (y < -2 && y > -4 ? 2.6 : 0) };

t("flat ground: the boom is clear", () => {
  assert.equal(P._terrainBoomT.call({}, flat, 0, 0, 1.5, 0, -6, 2.8, 0.3), null);
});

t("a crest between eye and pivot: t stops before the ridge", () => {
  const tb = P._terrainBoomT.call({}, ridge, 0, 0, 1.5, 0, -6, 2.8, 0.3);
  assert.ok(tb != null, "blocked");
  const y = -6 * tb;
  assert.ok(y > -2.05 && y < -1.6, `stops just short of the ridge (y=${y.toFixed(2)})`);
});

t("the pivot itself under the ground is left to the floor step", () => {
  const sunk = { terrainHeightAt: () => 3 };
  assert.equal(P._terrainBoomT.call({}, sunk, 0, 0, 1.5, 0, -6, 2.8, 0.3), null);
});

t("no height source / short boom → null", () => {
  assert.equal(P._terrainBoomT.call({}, {}, 0, 0, 1.5, 0, -6, 2.8, 0.3), null);
  assert.equal(P._terrainBoomT.call({}, ridge, 0, 0, 1.5, 0, -0.2, 1.6, 0.3), null);
});

// Through the real clip chain (landblockId 0 = no wasm object sweeps).
const self = (on) => Object.assign(Object.create(P), {
  _camRetailSphereOn: true, _camAabbSweepOn: false, _camSceneryOn: false, _camTerrainSweepOn: on,
});
t("_clipCameraAgainstWorld pulls the eye in over the crest; =off keeps it", () => {
  const ctx = { handle: ridge, landblockId: 0, indoor: false };
  const on = P._clipCameraAgainstWorld.call(self(true), p, 0, -6, 2.8, ctx, true);
  assert.ok(on.y > -2.1, `pulled in (y=${on.y.toFixed(2)})`);
  const off = P._clipCameraAgainstWorld.call(self(false), p, 0, -6, 2.8, ctx, true);
  assert.ok(Math.abs(off.y + 6) < 1e-9, "=off leaves the eye at the ideal");
  const indoor = P._clipCameraAgainstWorld.call(self(true), p, 0, -6, 2.8, { ...ctx, indoor: true }, true);
  assert.ok(Math.abs(indoor.y + 6) < 1e-9, "indoors untouched");
});

t("the chain marks a terrain-only clip for ?camTerrainEase (and clears it)", () => {
  const s = self(true);
  P._clipCameraAgainstWorld.call(s, p, 0, -6, 2.8, { handle: ridge, landblockId: 0, indoor: false }, true);
  assert.equal(s._clipTerrainBound, true);
  P._clipCameraAgainstWorld.call(s, p, 0, -6, 2.8, { handle: flat, landblockId: 0, indoor: false }, true);
  assert.equal(s._clipTerrainBound, false);
  // A later step that shortens the boom further (a static in front of the ridge) owns it.
  const statics = { ...ridge, sweepSphereAgainstStatics: () => ({ t: 0.1 }) };
  P._clipCameraAgainstWorld.call(s, p, 0, -6, 2.8, { handle: statics, landblockId: 0xa9b40025, indoor: false }, true);
  assert.equal(s._clipTerrainBound, false);
});

console.log(`\ncam_terrain_sweep: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
