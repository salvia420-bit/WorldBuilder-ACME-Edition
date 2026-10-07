// tests/viewer_cell.test.mjs — bug 4 (2026-10-07): render from the CAMERA's
// cell (retail's viewer cell), not the player's.
//
// Retail `SmartBox::RenderNormalMode` (acclient.c:144889) branches on the
// viewer's cell; OpenAC's `PhysicsCameraCollisionProbe` returns that cell from
// the camera sweep. The barn-door report was both halves of using the player's
// cell instead:
//   V1  player OUTSIDE, camera INSIDE the barn: the outdoor punch ran from
//       inside the room (far depth over the view out of the door, washed to
//       sky colour by the horizon dissolve = "strong fog"). Now the camera's
//       EnvCell arms the indoor split and the punch stands down.
//   V2  player INSIDE, camera OUTSIDE: the split armed and the seal walled the
//       doorway off from the outside camera (interior gone, grass only). Now
//       the outdoor camera disarms the split.
//   V3  the wasm walk root follows (`setViewerCell`), cleared when the camera
//       is back in the player's cell.
//   V4  `viewer_cell.js` state semantics.
//
// Run: node tests/viewer_cell.test.mjs

import * as THREE from "three";
import assert from "node:assert/strict";

globalThis.location = { search: "" };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = globalThis;

const vc = await import("../scene3d/viewer_cell.js");
const { tickCellVisibility3D, tickPortalPunch } = await import("../scene3d/cells.js");

let groups = 0;
let failures = 0;
async function t(name, fn) {
  try {
    await fn();
    groups++;
    console.log("  ok ", name);
  } catch (e) {
    failures++;
    console.log("  FAIL", name);
    console.log(e);
  }
}

const LB = 0xa4b40000;
// `>>> 0`: a bare `|` yields a signed int32 for a landblock ≥ 0x80.
const OUTDOOR = (LB | 0x0024) >>> 0;
const BARN = (LB | 0x010e) >>> 0;

function makeScene3d() {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2; // AC Z-up → three Y-up (adapter.js)
  worldRoot.updateMatrixWorld(true);
  return {
    camera,
    worldRoot,
    cellContainers3d: new Map(),
    terrainGroup: { visible: true },
    buildingsGroup: { visible: true, children: [] },
    staticsGroup: { visible: true, children: [] },
  };
}

function makeSession({ playerCell, playerIndoor, viewer }) {
  const calls = { setViewerCell: [], resolveArgs: null };
  return {
    calls,
    getCurrentCellId: () => playerCell,
    isCurrentCellIndoor: () => playerIndoor,
    isCurrentCellSeenOutside: () => playerIndoor,
    isCellSeenOutside: () => true,
    getRenderSet: () => [playerCell],
    getViewerRenderSet: () => [viewer],
    getLocalPlayerPose: () => ({ landblockId: playerCell, x: 60, y: 175, z: 96, free() {} }),
    terrainHeightAt: () => 96,
    resolveViewerCell: (...args) => {
      calls.resolveArgs = args;
      return viewer;
    },
    setViewerCell: (c) => calls.setViewerCell.push(c >>> 0),
  };
}

console.log("viewer cell — bug 4");

await t("V1 player outside, camera inside the barn → split arms, punch stands down", () => {
  const s3 = makeScene3d();
  const sh = makeSession({ playerCell: OUTDOOR, playerIndoor: false, viewer: BARN });
  tickCellVisibility3D(s3, sh);
  assert.equal(s3._viewerCell, BARN);
  assert.equal(s3._viewerIndoor, true);
  assert.equal(s3._indoorSplitArmed, true, "the camera's EnvCell arms the split");
  assert.equal(globalThis.__indoorDepthSplit.viewerCell, `0x${BARN.toString(16)}`);
  // The punch is the OUTDOOR mechanism: with the camera inside it must not run.
  let fed = null;
  s3._portalPunchPass = {
    setApertures(flat) { fed = flat; },
    get hasApertures() { return false; },
  };
  sh.getVisiblePortalApertures = () => new Float32Array([0]);
  tickPortalPunch(s3, sh);
  assert.equal(fed, null);
  assert.match(s3._portalPunchDiag.reason, /^indoor/);
  // The resolver got the head pivot (player z + 1.6) and the player's cell.
  const a = sh.calls.resolveArgs;
  assert.ok(a, "resolveViewerCell was called");
  assert.equal(a[2], 96 + vc.VIEWER_PIVOT_Z_M);
  assert.equal(a[6], vc.VIEWER_SPHERE_RADIUS_M);
  assert.equal(a[7], OUTDOOR);
  assert.deepEqual(sh.calls.setViewerCell, [BARN]);
});

await t("V2 player inside, camera outside → split disarmed", () => {
  const s3 = makeScene3d();
  const sh = makeSession({ playerCell: BARN, playerIndoor: true, viewer: OUTDOOR });
  tickCellVisibility3D(s3, sh);
  assert.equal(s3._viewerIndoor, false);
  assert.equal(s3._indoorSplitArmed, false, "an outdoor camera must not arm the split");
  assert.equal(vc.viewerState().playerIndoor, true);
  assert.equal(vc.viewerIndoorOr(true), false, "render consumers see the outdoor camera");
});

await t("V2b player and camera both inside → split arms exactly as before", () => {
  const s3 = makeScene3d();
  const sh = makeSession({ playerCell: BARN, playerIndoor: true, viewer: BARN });
  tickCellVisibility3D(s3, sh);
  assert.equal(s3._indoorSplitArmed, true);
  assert.deepEqual(sh.calls.setViewerCell, [0], "same cell → override cleared");
});

await t("V3 a stale pkg without the exports keeps the player's cell", () => {
  const s3 = makeScene3d();
  const sh = makeSession({ playerCell: OUTDOOR, playerIndoor: false, viewer: BARN });
  delete sh.resolveViewerCell;
  tickCellVisibility3D(s3, sh);
  assert.equal(s3._viewerCell, OUTDOOR);
  assert.equal(s3._indoorSplitArmed, false);
});

await t("V4 viewer_cell.js state", () => {
  vc.resetViewerCell();
  assert.equal(vc.viewerIndoorOr(true), true, "unpublished → the fallback");
  assert.equal(vc.viewerIndoorOr(false), false);
  assert.equal(vc.publishViewerCell(OUTDOOR, false, BARN, true), true, "first publish is a change");
  assert.equal(vc.viewerState().indoor, true);
  assert.equal(vc.viewerState().seenOutside, true);
  assert.equal(vc.publishViewerCell(OUTDOOR, false, BARN, true), false, "same → no change");
  vc.publishViewerCell(OUTDOOR, false, 0, false);
  assert.equal(vc.viewerState().cell, OUTDOOR, "0 → the player's cell");
  assert.equal(vc.viewerState().indoor, false);
  assert.equal(vc.isIndoorCellId((LB | 0x0100) >>> 0), true);
  assert.equal(vc.isIndoorCellId((LB | 0x0040) >>> 0), false);
  vc.resetViewerCell();
  assert.equal(vc.viewerState().valid, false);
});

console.log(`viewer cell: ${groups} groups ok, ${failures} failed`);
if (failures) process.exit(1);
