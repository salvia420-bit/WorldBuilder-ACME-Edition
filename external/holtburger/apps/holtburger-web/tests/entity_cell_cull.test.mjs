// tests/entity_cell_cull.test.mjs — cells-portals-1 (2026-10-13):
// `?rigCellGate=on` (OPT-IN, default OFF), the indoor cell term of the entity
// render cull (scene3d/rig_cell_gate.js + entities.js
// tickEntityRenderVisibility).
//
// Retail draws an object only through the cells the portal walk reached
// (PView::DrawCells → DrawObjCellForDummies, acclient.c:461450) and selection
// only hit-tests drawn parts (Render::GfxObjUnderSelectionRay, :379997). A rig
// in an undrawn room was still submitted and pickable through the wall.
//
//   C1  flag reader is an exact `=on` opt-in.
//   C2  rigCellHidden: an EnvCell rig whose resident container is hidden and
//       whose sphere touches no drawn cell box is hidden.
//   C3  the same rig with its sphere touching a drawn cell's AABB is kept
//       (retail shadow parts: CPhysicsObj::add_shadows_to_cells).
//   C4  fail open: unknown / zero cell, missing or detached container, a
//       visible container, unknown drawn-box list.
//   C5  landcell rigs: kept unless the walk's outside view is EXACTLY 0.
//   C6  cellAcBox measures in AC space under the -pi/2 worldRoot and caches
//       per child count; collectDrawnCellBoxes lists drawn EnvCells only and
//       fails open on an unmeasurable drawn cell.
//   C7  noteEntityLandcell keeps the full cell id (and still the low 16).
//   C8  tickPortalSeal publishes the raw outside-view count only with the
//       flag on (null when unknown, never written when off); a 0 with the
//       camera within INDOOR_LANDSCAPE_NEAR_PORTAL_M of an outdoor portal (a
//       near-clipped doorway) is unknown too.
//   C9  tickEntityRenderVisibility end to end: hides only far rigs in hidden
//       cells, keeps the exemptions, and does nothing when the flag is off,
//       the viewer is outdoors, or the indoor split is not armed.
//   C10 source pins: the helper is called only under `_currentCellIndoor &&
//       _indoorSplitArmed`; spawn stores the full cell; picking still skips
//       hidden roots (so a gated rig is unpickable with no picking change).
//
// Run: node tests/entity_cell_cull.test.mjs

import * as THREE from "three";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

globalThis.location = { search: "" };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = globalThis;

const gate = await import("../scene3d/rig_cell_gate.js");
const {
  readRigCellGateFlag,
  rigCellGateEnabled,
  setRigCellGateFlag,
  rigCellHidden,
  sphereTouchesBox,
  cellAcBox,
  collectDrawnCellBoxes,
  isEnvCellId,
  RIG_CELL_GATE_STATS,
} = gate;
const { noteEntityLandcell, tickPortalSeal } = await import("../scene3d/cells.js");
const { tickEntityRenderVisibility } = await import("../scene3d/entities.js");

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

const LB = 0x01d90000;
const A = (LB | 0x0100) >>> 0; // viewer room, drawn
const B = (LB | 0x0101) >>> 0; // neighbour, drawn (x 10..20)
const C = (LB | 0x0102) >>> 0; // two portals away, hidden (x 40..50)
const D = (LB | 0x0103) >>> 0; // hidden, adjacent to B (x 20..30)
const OUT = (0xa9b40000 | 0x0021) >>> 0; // an outdoor landcell
const R = 6; // entities.js ENTITY_CULL_RADIUS

const BOX_A = [0, 0, 0, 10, 10, 4];
const BOX_B = [10, 0, 0, 20, 10, 4];
const at = (x, y, z) => ({ x, y, z });
/** A registry entry: attached (has a parent) unless told otherwise. */
const cont = (visible, attached = true) => ({ visible, parent: attached ? {} : null });

await t("C1 flag reader is an exact =on opt-in", () => {
  assert.equal(readRigCellGateFlag(""), false);
  assert.equal(readRigCellGateFlag("?rigCellGate=on"), true);
  assert.equal(readRigCellGateFlag("?foo=1&rigCellGate=on"), true);
  for (const v of ["off", "0", "1", "true", "ON", "yes", ""]) {
    assert.equal(readRigCellGateFlag(`?rigCellGate=${v}`), false, v);
  }
  // The bare page (location.search = "") reads OFF.
  setRigCellGateFlag(null);
  assert.equal(rigCellGateEnabled(), false);
});

await t("C2 hidden resident EnvCell, sphere reaches no drawn cell → hidden", () => {
  const reg = new Map([[A, cont(true)], [B, cont(true)], [C, cont(false)]]);
  assert.equal(rigCellHidden(C, reg, [BOX_A, BOX_B], at(45, 5, 0), R, null), true);
  // With no drawn boxes at all (the walk drew nothing else) it is still hidden.
  assert.equal(rigCellHidden(C, reg, [], at(45, 5, 0), R, null), true);
  assert.equal(sphereTouchesBox(45, 5, 0, R, BOX_B), false);
});

await t("C3 sphere touching a drawn cell's AABB keeps the rig", () => {
  const reg = new Map([[A, cont(true)], [B, cont(true)], [D, cont(false)]]);
  // 2 m past B's +x face: inside the 6 m sphere.
  assert.equal(rigCellHidden(D, reg, [BOX_A, BOX_B], at(22, 5, 0), R, null), false);
  // 6.5 m past it: outside.
  assert.equal(rigCellHidden(D, reg, [BOX_A, BOX_B], at(26.5, 5, 0), R, null), true);
  // Exactly on the radius counts as touching.
  assert.equal(sphereTouchesBox(26, 5, 2, R, BOX_B), true);
  // Corner distance is Euclidean, not per-axis.
  assert.equal(sphereTouchesBox(24.5, 14.5, 2, R, BOX_B), false); // 4.5² + 4.5² > 36? 40.5 > 36
  assert.equal(sphereTouchesBox(24, 14, 2, R, BOX_B), true); // 32 <= 36
});

await t("C4 fail open on every unknown", () => {
  const reg = new Map([[A, cont(true)], [C, cont(false)], [D, cont(false, false)]]);
  const far = at(45, 5, 0);
  for (const id of [undefined, null, NaN, 0, LB /* low16 0 */]) {
    assert.equal(rigCellHidden(id, reg, [BOX_A], far, R, 0), false, String(id));
  }
  // Not in the registry (not built yet / evicted).
  assert.equal(rigCellHidden((LB | 0x0199) >>> 0, reg, [BOX_A], far, R, null), false);
  // Registered but detached (warm-parked).
  assert.equal(rigCellHidden(D, reg, [BOX_A], far, R, null), false);
  // Its cell is drawn.
  assert.equal(rigCellHidden(A, reg, [BOX_A], far, R, null), false);
  // No registry / unknown drawn boxes.
  assert.equal(rigCellHidden(C, null, [BOX_A], far, R, null), false);
  assert.equal(rigCellHidden(C, reg, null, far, R, null), false);
  // A throwing registry.
  const bad = { get() { throw new Error("boom"); } };
  assert.equal(rigCellHidden(C, bad, [BOX_A], far, R, null), false);
});

await t("C5 landcell rigs: hidden only when the outside view is exactly 0", () => {
  const reg = new Map([[A, cont(true)]]);
  const far = at(300, 300, 0);
  assert.equal(isEnvCellId(OUT), false);
  for (const oc of [undefined, null, 1, 3]) {
    assert.equal(rigCellHidden(OUT, reg, [BOX_A], far, R, oc), false, String(oc));
  }
  assert.equal(rigCellHidden(OUT, reg, [BOX_A], far, R, 0), true);
  // A landcell rig straddling into a drawn EnvCell (standing in its doorway)
  // stays drawn.
  assert.equal(rigCellHidden(OUT, reg, [BOX_A], at(12, 5, 0), R, 0), false);
  // Unknown drawn boxes still fail open.
  assert.equal(rigCellHidden(OUT, reg, null, far, R, 0), false);
});

// A scene graph shaped like index.js: worldRoot (AC → three, -pi/2 about X) →
// cellsGroup → per-cell container → mesh group at the cell origin → surfaces.
function makeWorld() {
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  const cellsGroup = new THREE.Group();
  const entitiesGroup = new THREE.Group();
  worldRoot.add(cellsGroup, entitiesGroup);
  return { worldRoot, cellsGroup, entitiesGroup };
}
function makeCell(cellsGroup, { origin, size, visible }) {
  const container = new THREE.Group();
  container.userData = { isEnvCell: true };
  const meshGroup = new THREE.Group();
  meshGroup.position.set(origin[0], origin[1], origin[2]);
  const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]));
  m.position.set(size[0] / 2, size[1] / 2, size[2] / 2);
  meshGroup.add(m);
  container.add(meshGroup);
  container.visible = visible;
  cellsGroup.add(container);
  return container;
}
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-4);

await t("C6 cellAcBox is AC-space + cached; collectDrawnCellBoxes lists drawn EnvCells", () => {
  const w = makeWorld();
  const ca = makeCell(w.cellsGroup, { origin: [100, 200, 10], size: [10, 10, 4], visible: true });
  w.worldRoot.updateMatrixWorld(true);
  const b = cellAcBox(ca);
  assert.ok(near(b, [100, 200, 10, 110, 210, 14]), JSON.stringify(b));
  assert.equal(cellAcBox(ca), b, "cached");
  // A new child (a static streaming in) re-measures.
  const prop = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  prop.position.set(115, 205, 11);
  ca.add(prop);
  w.worldRoot.updateMatrixWorld(true);
  const b2 = cellAcBox(ca);
  assert.notEqual(b2, b);
  assert.ok(near(b2, [100, 200, 10, 116, 210, 14]), JSON.stringify(b2));
  // Detached → no box.
  assert.equal(cellAcBox(new THREE.Group()), null);

  const w2 = makeWorld();
  const cA = makeCell(w2.cellsGroup, { origin: [0, 0, 0], size: [10, 10, 4], visible: true });
  const cB = makeCell(w2.cellsGroup, { origin: [10, 0, 0], size: [10, 10, 4], visible: true });
  const cC = makeCell(w2.cellsGroup, { origin: [40, 0, 0], size: [10, 10, 4], visible: false });
  w2.worldRoot.updateMatrixWorld(true);
  const scene3d = {
    cellContainers3d: new Map([[A, cA], [B, cB], [C, cC]]),
    // OUT: a landcell id in the set has no container and is skipped; the
    // unbuilt EnvCell 0x0199 is not drawn and contributes nothing.
    _lastCellVisibleSet: new Set([A, B, OUT, (LB | 0x0199) >>> 0]),
  };
  const out = [];
  const got = collectDrawnCellBoxes(scene3d, out);
  assert.equal(got, out);
  assert.equal(out.length, 2);
  assert.ok(near(out[0], BOX_A) && near(out[1], BOX_B), JSON.stringify(out));
  // A listed cell whose container is hidden this frame contributes nothing.
  scene3d._lastCellVisibleSet.add(C);
  assert.equal(collectDrawnCellBoxes(scene3d, out).length, 2);
  // A DRAWN cell with no measurable geometry → unknown → null (fail open).
  const empty = new THREE.Group();
  empty.userData = { isEnvCell: true };
  w2.cellsGroup.add(empty);
  const E = (LB | 0x0104) >>> 0;
  scene3d.cellContainers3d.set(E, empty);
  scene3d._lastCellVisibleSet.add(E);
  assert.equal(collectDrawnCellBoxes(scene3d, out), null);
  assert.equal(out.length, 0);
  // No set (?cellBugParity never fills it) / no registry → null.
  assert.equal(collectDrawnCellBoxes({ cellContainers3d: new Map() }, []), null);
  assert.equal(collectDrawnCellBoxes({}, []), null);
});

await t("C7 noteEntityLandcell keeps the full cell id", () => {
  const inst = {};
  const em = { entityMap: new Map([[7, inst]]) };
  assert.equal(noteEntityLandcell(em, 7, 0xa9b40105), true);
  assert.equal(inst._wireCellId, 0xa9b40105);
  assert.equal(inst._wireCellIdx, 0x0105);
  noteEntityLandcell(em, 7, 0xa9b40021);
  assert.equal(inst._wireCellId, 0xa9b40021);
  assert.equal(inst._wireCellIdx, 0x0021);
  assert.equal(noteEntityLandcell(em, 8, 0xa9b40021), false, "no rig");
});

function quadAt(y, x0, x1) {
  return [4, x0, y, 0, x1, y, 0, x1, y, 2, x0, y, 2];
}
function makeSealScene3d() {
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  worldRoot.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.position.set(0, 1, 0);
  camera.lookAt(0, 1, -10); // = AC +y
  camera.updateMatrixWorld(true);
  const seal = { setApertures() {}, outdoorRemainder: null, remainderRect: null };
  return { worldRoot, camera, _indoorSplitArmed: true, atmospherePipeline: { portalSealPass: seal } };
}

await t("C8 tickPortalSeal publishes the outside-view count only with the flag on", () => {
  try {
    setRigCellGateFlag(false);
    const off = makeSealScene3d();
    let offProbes = 0;
    tickPortalSeal(off, {
      getPViewOutsidePortals: () => Float32Array.from([0]),
      getVisiblePortalApertures: () => { offProbes++; return Float32Array.from([0]); },
    });
    assert.equal("_rigGateOutsideViewCount" in off, false, "flag off: never written");
    assert.equal(offProbes, 0, "flag off: no near-portal box query");

    setRigCellGateFlag(true);
    const s = makeSealScene3d();
    // A 0 is trusted only when the near-portal box query (the same
    // getVisiblePortalApertures probe as ?indoorLandscapeGate) finds no
    // outdoor portal within INDOOR_LANDSCAPE_NEAR_PORTAL_M of the camera.
    // Camera = AC (0, 0, 1); quadAt(5, …) is 5 m away, quadAt(0.05, …) 5 cm.
    const ZERO_FAR = {
      getPViewOutsidePortals: () => Float32Array.from([0]),
      getVisiblePortalApertures: () => Float32Array.from([1, ...quadAt(5, -1, 1)]),
    };
    tickPortalSeal(s, ZERO_FAR);
    assert.equal(s._rigGateOutsideViewCount, 0, "mouthless walk");
    tickPortalSeal(s, {
      getPViewOutsidePortals: () => Float32Array.from([0]),
      getVisiblePortalApertures: () => Float32Array.from([0]),
    });
    assert.equal(s._rigGateOutsideViewCount, 0, "no outdoor portal anywhere near");
    tickPortalSeal(s, { getPViewOutsidePortals: () => Float32Array.from([1, ...quadAt(5, -1, 1)]) });
    assert.equal(s._rigGateOutsideViewCount, 1);
    // A doorway the camera straddles is dropped by the punch clip but is
    // still an outside view: the RAW count is published.
    tickPortalSeal(s, { getPViewOutsidePortals: () => Float32Array.from([1, ...quadAt(0, -1, 1)]) });
    assert.equal(s._rigGateOutsideViewCount, 1);
    // V-cells-stream-R1: a doorway inside the 0.1 m near plane projects to
    // nothing, so the walk says 0 while the outdoors fills the screen. Within
    // INDOOR_LANDSCAPE_NEAR_PORTAL_M of an outdoor portal a 0 is unknown.
    let boxMvp = null;
    tickPortalSeal(s, {
      getPViewOutsidePortals: () => Float32Array.from([0]),
      getVisiblePortalApertures: (mvp) => {
        boxMvp = Array.from(mvp);
        return Float32Array.from([1, ...quadAt(0.05, -1, 1)]);
      },
    });
    assert.equal(s._rigGateOutsideViewCount, null, "near-clipped doorway → unknown");
    // The probe is the camera-centred box query, not the view MVP.
    assert.ok(boxMvp && Math.abs(boxMvp[0] - 1 / 1.5) < 1e-6 && Math.abs(boxMvp[14] + 1 / 1.5) < 1e-5,
      `box query centred on AC (0,0,1), half-size 1.5: ${boxMvp}`);
    tickPortalSeal(s, {
      getPViewOutsidePortals: () => Float32Array.from([0]),
      getVisiblePortalApertures: () => Float32Array.from([1, ...quadAt(0.9, -1, 1)]),
    });
    assert.equal(s._rigGateOutsideViewCount, null, "0.9 m: still inside the guard");
    // Unmeasurable → unknown: no box-query export, an empty (no current
    // cell) or malformed result, a throw.
    tickPortalSeal(s, { getPViewOutsidePortals: () => Float32Array.from([0]) });
    assert.equal(s._rigGateOutsideViewCount, null, "no box-query export");
    tickPortalSeal(s, {
      getPViewOutsidePortals: () => Float32Array.from([0]),
      getVisiblePortalApertures: () => new Float32Array(0),
    });
    assert.equal(s._rigGateOutsideViewCount, null, "empty probe result");
    tickPortalSeal(s, {
      getPViewOutsidePortals: () => Float32Array.from([0]),
      getVisiblePortalApertures: () => Float32Array.from([2, 4, 0]),
    });
    assert.equal(s._rigGateOutsideViewCount, null, "malformed probe result");
    tickPortalSeal(s, {
      getPViewOutsidePortals: () => Float32Array.from([0]),
      getVisiblePortalApertures: () => { throw new Error("probe"); },
    });
    assert.equal(s._rigGateOutsideViewCount, null, "probe threw");
    // A positive walk count never needs the probe.
    let probed = 0;
    tickPortalSeal(s, {
      getPViewOutsidePortals: () => Float32Array.from([1, ...quadAt(5, -1, 1)]),
      getVisiblePortalApertures: () => { probed++; return Float32Array.from([0]); },
    });
    assert.equal(s._rigGateOutsideViewCount, 1);
    assert.equal(probed, 0, "count > 0: no box query");
    // Stale pkg (unrestricted export only) → unknown.
    tickPortalSeal(s, { getVisiblePortalApertures: () => Float32Array.from([0]) });
    assert.equal(s._rigGateOutsideViewCount, null);
    // Split not armed → reset to unknown.
    tickPortalSeal(s, ZERO_FAR);
    assert.equal(s._rigGateOutsideViewCount, 0);
    s._indoorSplitArmed = false;
    tickPortalSeal(s, ZERO_FAR);
    assert.equal(s._rigGateOutsideViewCount, null);
  } finally {
    setRigCellGateFlag(null);
  }
});

// --- C9: the real per-frame cull ------------------------------------------
const LOCAL = 0x50000001;
globalThis.getLocalPlayerGuid = () => LOCAL;
const ALWAYS = { valid: true, isSphereInFrustum: () => true, getDistanceSq: () => 0 };

function rig(guid, x, y, z, fields = {}) {
  const root = new THREE.Group();
  root.position.set(x, y, z);
  return { guid, root, ...fields };
}
function makeCullScene() {
  const w = makeWorld();
  const cA = makeCell(w.cellsGroup, { origin: [0, 0, 0], size: [10, 10, 4], visible: true });
  const cB = makeCell(w.cellsGroup, { origin: [10, 0, 0], size: [10, 10, 4], visible: true });
  const cC = makeCell(w.cellsGroup, { origin: [40, 0, 0], size: [10, 10, 4], visible: false });
  const cD = makeCell(w.cellsGroup, { origin: [20, 0, 0], size: [10, 10, 4], visible: false });
  w.worldRoot.updateMatrixWorld(true);
  const lit = rig(0x80000007, 45, 6, 0, { _wireCellId: C, _setupLightScanned: true });
  lit.root.add(new THREE.PointLight());
  const rigs = {
    farC: rig(0x80000001, 45, 5, 0, { _wireCellId: C }),
    spawnC: rig(0x80000002, 46, 5, 0, { _spawnCellId: C }), // static NPC: spawn cell only
    nearD: rig(0x80000003, 22, 5, 0, { _wireCellId: D }), // sphere reaches B
    inA: rig(0x80000004, 5, 5, 0, { _wireCellId: A }),
    unknown: rig(0x80000005, 45, 4, 0, {}),
    local: rig(LOCAL, 44, 5, 0, { _wireCellId: C }),
    child: rig(0x80000006, 45, 5, 1, { _wireCellId: C, _attachedParentGuid: 0x80000001 }),
    lit,
    // Last KIND_POSITION says C although it spawned in A: the wire cell wins.
    wireWins: rig(0x80000008, 47, 5, 0, { _spawnCellId: A, _wireCellId: C }),
    outdoor: rig(0x80000009, 300, 300, 0, { _wireCellId: OUT }),
  };
  const entityMap = new Map();
  for (const r of Object.values(rigs)) entityMap.set(r.guid, r);
  const scene3d = {
    entityManager: { entityMap },
    cellContainers3d: new Map([[A, cA], [B, cB], [C, cC], [D, cD]]),
    _lastCellVisibleSet: new Set([A, B]),
    _currentCellIndoor: true,
    _indoorSplitArmed: true,
    _rigGateOutsideViewCount: 0,
  };
  return { scene3d, rigs };
}
const shown = (rigs) =>
  Object.fromEntries(Object.entries(rigs).map(([k, r]) => [k, r.root.visible]));

await t("C9 tickEntityRenderVisibility hides only far rigs in hidden cells", () => {
  try {
    setRigCellGateFlag(true);
    const { scene3d, rigs } = makeCullScene();
    const res = tickEntityRenderVisibility(scene3d, ALWAYS);
    assert.deepEqual(shown(rigs), {
      farC: false,
      spawnC: false,
      nearD: true,
      inA: true,
      unknown: true,
      local: true,
      child: true,
      lit: true,
      wireWins: false,
      outdoor: false,
    });
    assert.equal(res.cellGated, 4);
    assert.equal(RIG_CELL_GATE_STATS.armed, true);
    assert.equal(RIG_CELL_GATE_STATS.gated, 4);
    assert.equal(RIG_CELL_GATE_STATS.drawnCellBoxes, 2);
    assert.equal(RIG_CELL_GATE_STATS.outsideViewCount, 0);
    // A server-hidden rig stays hidden; un-gating never un-hides it.
    rigs.inA._stateVisible = false;
    rigs.inA.root.visible = false;
    tickEntityRenderVisibility(scene3d, ALWAYS);
    assert.equal(rigs.inA.root.visible, false);
    rigs.inA._stateVisible = true;

    // The walk sees outside → outdoor rigs draw again.
    scene3d._rigGateOutsideViewCount = 2;
    tickEntityRenderVisibility(scene3d, ALWAYS);
    assert.equal(rigs.outdoor.root.visible, true);
    // Unknown count (no seal this frame) → drawn.
    scene3d._rigGateOutsideViewCount = null;
    tickEntityRenderVisibility(scene3d, ALWAYS);
    assert.equal(rigs.outdoor.root.visible, true);

    // The room is reached again → its rigs reappear next frame.
    scene3d.cellContainers3d.get(C).visible = true;
    scene3d._lastCellVisibleSet.add(C);
    tickEntityRenderVisibility(scene3d, ALWAYS);
    assert.equal(rigs.farC.root.visible, true);
    assert.equal(rigs.spawnC.root.visible, true);
  } finally {
    setRigCellGateFlag(null);
  }
});

await t("C9b no-op when the flag is off, the viewer is outdoors, or the split is not armed", () => {
  try {
    const all = (rigs) => Object.values(rigs).every((r) => r.root.visible === true);
    // Flag off (the default).
    setRigCellGateFlag(false);
    let { scene3d, rigs } = makeCullScene();
    let res = tickEntityRenderVisibility(scene3d, ALWAYS);
    assert.ok(all(rigs), JSON.stringify(shown(rigs)));
    assert.equal(res.cellGated, 0);

    setRigCellGateFlag(true);
    ({ scene3d, rigs } = makeCullScene());
    scene3d._currentCellIndoor = false;
    tickEntityRenderVisibility(scene3d, ALWAYS);
    assert.ok(all(rigs), "outdoor viewer");
    assert.equal(RIG_CELL_GATE_STATS.armed, false);

    ({ scene3d, rigs } = makeCullScene());
    scene3d._indoorSplitArmed = false;
    tickEntityRenderVisibility(scene3d, ALWAYS);
    assert.ok(all(rigs), "split not armed");

    // A drawn cell with no measurable bounds → the whole frame fails open.
    ({ scene3d, rigs } = makeCullScene());
    const empty = new THREE.Group();
    scene3d.cellContainers3d.get(A).parent.add(empty);
    const E = (LB | 0x0104) >>> 0;
    scene3d.cellContainers3d.set(E, empty);
    scene3d._lastCellVisibleSet.add(E);
    tickEntityRenderVisibility(scene3d, ALWAYS);
    assert.ok(all(rigs), "unknown drawn bounds");
    assert.equal(RIG_CELL_GATE_STATS.boxesUnknown, true);

    // Turning the flag off at runtime re-shows gated rigs on the next frame.
    ({ scene3d, rigs } = makeCullScene());
    tickEntityRenderVisibility(scene3d, ALWAYS);
    assert.equal(rigs.farC.root.visible, false);
    setRigCellGateFlag(false);
    res = tickEntityRenderVisibility(scene3d, ALWAYS);
    assert.ok(all(rigs), "runtime off");
    assert.equal(RIG_CELL_GATE_STATS.armed, false);
  } finally {
    setRigCellGateFlag(null);
  }
});

await t("C10 source pins", () => {
  const ent = readFileSync(join(ROOT, "scene3d/entities.js"), "utf8");
  const start = ent.indexOf("export function tickEntityRenderVisibility(");
  assert.ok(start > 0);
  const end = ent.indexOf("\nfunction ", start + 10);
  const body = ent.slice(start, end > 0 ? end : undefined);
  // Armed only for an indoor viewer with the split armed.
  assert.match(
    body,
    /rigGateArmed\s*=\s*scene3d\._currentCellIndoor === true && scene3d\._indoorSplitArmed === true;/,
  );
  // Every rigCellHidden call is behind that arm.
  const calls = body.split("rigCellHidden(").length - 1;
  assert.equal(calls, 1, "one call site");
  assert.match(body, /rigGateArmed &&\s*rigCellHidden\(/);
  assert.match(body, /if \(rigCellGateEnabled\(\)\) \{/);
  // The wire cell wins over the spawn cell.
  assert.match(body, /inst\._wireCellId \?\? inst\._spawnCellId/);
  // Spawn stores the full cell id.
  assert.match(ent, /inst\._spawnCellId = lbId;/);
  // Picking still drops hidden roots — a gated rig is unpickable as-is.
  const pick = readFileSync(join(ROOT, "scene3d/picking.js"), "utf8");
  assert.match(pick, /\.filter\(r => r && r\.visible !== false\)/);
  assert.match(pick, /if \(inst\.root\.visible === false\) continue;/);
});

console.log(`entity cell cull: ${groups} groups ok, ${failures} failed`);
// Explicit exit: importing entities.js with a `window` arms play_effect_vfx's
// 30 s __pluginClient bind poll, which would otherwise hold node open.
process.exit(failures ? 1 : 0);
