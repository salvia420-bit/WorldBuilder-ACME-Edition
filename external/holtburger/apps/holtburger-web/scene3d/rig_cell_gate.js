// scene3d/rig_cell_gate.js — cells-portals-1 (2026-10-13): `?rigCellGate=on`
// (OPT-IN, default OFF). Indoors, an entity rig is drawn — and so pickable /
// hoverable — only while the cell it stands in is drawn.
//
// Retail draws an object only through the cells the portal walk reached:
// PView::DrawCells (acclient.c:461450) ends with
// `DrawObjCellForDummies(cell_draw_list[i])` for each reached cell, which draws
// that cell's shadow parts, and Render::GfxObjUnderSelectionRay
// (acclient.c:379997) only hit-tests the part being drawn. A monster in a room
// no portal view reaches is neither drawn nor selectable. The same function
// draws LANDCELL objects only inside LScape::draw, under
// `outside_view.view_count`, so an indoor viewer with no outside view draws
// none of them.
//
// Holtburger's entity cull (entities.js tickEntityRenderVisibility) is frustum
// + distance + ?occlusionCull, and the occlusion culler is disarmed indoors, so
// rigs in undrawn rooms behind solid walls were submitted (~40 part draws per
// humanoid) and picking (picking.js skips only hidden roots) could select or
// tooltip them through the wall.
//
// The gate runs only while the viewer is indoors AND the ?indoorDepthSplit is
// armed (its narrowed cell set is our `cell_draw_list`). A rig is hidden when
//   - its cell (last KIND_POSITION cell `_wireCellId`, else the spawn cell
//     `_spawnCellId`) is an EnvCell whose container is resident (registered +
//     attached) and hidden this frame, or an outdoor landcell while the walk's
//     outside view is known to be empty; AND
//   - its cull sphere touches no AABB of an EnvCell drawn this frame. Retail
//     registers an object's shadow in EVERY cell its sphere overlaps
//     (CPhysicsObj::add_shadows_to_cells, acclient.c:321978), so a rig
//     straddling into a drawn room stays drawn; this also absorbs the
//     KIND_POSITION lag of a rig walking out of a hidden room.
// Everything unknown fails OPEN (drawn): no cell, cell 0, an unregistered or
// detached container, a drawn cell whose bounds cannot be measured, an unknown
// outside-view count. The local player, attached children and light owners
// keep their existing exemptions in entities.js.
//
// Known limit: retail also clips each cell's objects to that cell's own
// portal_view (`Render::PortalList = cell->portal_view[...]`), so a rig in a
// DRAWN neighbour room can still be picked through the wall in front of it.
//
// WebAC fixed the same gap (packages/renderer/src/world/ServerObjectManager.ts
// updateInteriorVisibility); this module is re-derived from the decomp.

import * as THREE from "three";

let _RIG_CELL_GATE_ON = null;

/** `?rigCellGate=on` — exact opt-in; any other value (or none) is OFF. */
export function readRigCellGateFlag(search) {
  try {
    const s =
      typeof search === "string"
        ? search
        : typeof window !== "undefined" && window.location
        ? window.location.search
        : typeof location !== "undefined" && location
        ? location.search
        : "";
    return new URLSearchParams(s || "").get("rigCellGate") === "on";
  } catch (_) {
    return false;
  }
}

/** Cached flag accessor (parse once per page load). */
export function rigCellGateEnabled() {
  if (_RIG_CELL_GATE_ON === null) {
    _RIG_CELL_GATE_ON = readRigCellGateFlag();
    if (_RIG_CELL_GATE_ON) _installRigCellGateDiag();
  }
  return _RIG_CELL_GATE_ON;
}

/** Test/A-B seam: force the flag (`null` re-reads the URL on next use). */
export function setRigCellGateFlag(on) {
  _RIG_CELL_GATE_ON = on == null ? null : !!on;
}

/**
 * Per-frame counters, rewritten in place by entities.js while the gate runs
 * (`armed` false on frames it does not). Read via `window.__rigCellGateDiag()`.
 */
export const RIG_CELL_GATE_STATS = {
  armed: false,
  gated: 0,
  drawnCellBoxes: 0,
  boxesUnknown: false,
  outsideViewCount: null,
  frames: 0,
};

function _installRigCellGateDiag() {
  if (typeof window === "undefined" || !window) return;
  try {
    window.__rigCellGateDiag = () => ({ on: rigCellGateEnabled(), ...RIG_CELL_GATE_STATS });
    // Runtime A/B on one page load. Turning it off needs no restore: the next
    // tickEntityRenderVisibility recomputes every tested rig's cull state.
    window.__setRigCellGate = (on) => {
      setRigCellGateFlag(on);
      return window.__rigCellGateDiag();
    };
  } catch (_) {}
}

/** An EnvCell id (`cell & 0xFFFF >= 0x100`); landcells are 0x01-0x40. */
export function isEnvCellId(cellId) {
  return ((cellId >>> 0) & 0xffff) >= 0x100;
}

/**
 * Sphere vs AABB overlap. `b` = [minX, minY, minZ, maxX, maxY, maxZ], same
 * frame as the centre (AC space).
 */
export function sphereTouchesBox(cx, cy, cz, r, b) {
  let d = 0;
  let v = cx < b[0] ? b[0] - cx : cx > b[3] ? cx - b[3] : 0;
  d += v * v;
  v = cy < b[1] ? b[1] - cy : cy > b[4] ? cy - b[4] : 0;
  d += v * v;
  v = cz < b[2] ? b[2] - cz : cz > b[5] ? cz - b[5] : 0;
  d += v * v;
  return d <= r * r;
}

/**
 * Should a rig in `cellId` be withheld from this frame's draw? Pure; positional
 * arguments so the per-rig call allocates nothing.
 *
 * @param {number|null|undefined} cellId  full cell id (0xXXYYcccc)
 * @param {Map<number, THREE.Object3D>} registry  scene3d.cellContainers3d
 * @param {Array<number[]>|null} drawnCellBoxes  AC-space AABBs of the EnvCells
 *   drawn this frame (`collectDrawnCellBoxes`); null = unknown → draw
 * @param {{x:number,y:number,z:number}} center  rig root, AC space
 * @param {number} radius  rig cull-sphere radius (m)
 * @param {number|null|undefined} outsideViewCount  the walk's outside-view
 *   count this frame; only an exact 0 hides landcell rigs
 */
export function rigCellHidden(cellId, registry, drawnCellBoxes, center, radius, outsideViewCount) {
  if (cellId === undefined || cellId === null || !Number.isFinite(cellId)) return false;
  const id = cellId >>> 0;
  const low = id & 0xffff;
  if (low === 0) return false;
  if (low >= 0x100) {
    if (!registry || typeof registry.get !== "function") return false;
    let c;
    try { c = registry.get(id); } catch (_) { return false; }
    // Unregistered (not built yet / evicted) or detached (parked): not
    // resident → fail open.
    if (!c || !c.parent) return false;
    if (c.visible !== false) return false; // its cell is drawn this frame
  } else if (outsideViewCount !== 0) {
    // Landcell rig: LScape::draw runs whenever the outside view is non-empty;
    // an unknown count draws.
    return false;
  }
  if (!Array.isArray(drawnCellBoxes) || !center) return false;
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
  for (let i = 0; i < drawnCellBoxes.length; i++) {
    if (sphereTouchesBox(center.x, center.y, center.z, r, drawnCellBoxes[i])) return false;
  }
  return true;
}

// AC-space AABB of an EnvCell container, cached on the container and rebuilt
// only when its child count changes (statics streaming in) — the cell shell is
// static. Containers sit at identity under `cellsGroup`, which (like
// `entitiesGroup`) is an identity child of `worldRoot`, so the container's
// PARENT frame is the AC frame entity `root.position` lives in. A container
// with no measurable geometry caches `null`.
const _cellBox3 = new THREE.Box3();
const _cellInv = new THREE.Matrix4();
export function cellAcBox(container) {
  if (!container || !container.parent) return null;
  const ud = container.userData || (container.userData = {});
  const n = container.children ? container.children.length : 0;
  const c = ud.__rigCellBox;
  if (c && c.n === n) return c.b;
  let b = null;
  _cellBox3.makeEmpty();
  try {
    _cellBox3.setFromObject(container);
    if (!_cellBox3.isEmpty()) {
      _cellBox3.applyMatrix4(_cellInv.copy(container.parent.matrixWorld).invert());
      const mn = _cellBox3.min, mx = _cellBox3.max;
      b = [mn.x, mn.y, mn.z, mx.x, mx.y, mx.z];
    }
  } catch (_) {
    b = null;
  }
  ud.__rigCellBox = { n, b };
  return b;
}

/**
 * Fill `out` with the AC-space AABBs of the EnvCells drawn this frame — the
 * set cells.js tickCellVisibility3D just applied (`_lastCellVisibleSet`), each
 * re-checked against its container's live `.visible`. Returns `out`, or null
 * when unknown (no registry / set — e.g. `?cellBugParity`, which never fills
 * it — or a drawn cell whose bounds cannot be measured), which fails the gate
 * open for the frame. A listed cell with no attached, visible container is not
 * drawn and contributes nothing.
 */
export function collectDrawnCellBoxes(scene3d, out) {
  out.length = 0;
  const registry = scene3d?.cellContainers3d;
  const drawn = scene3d?._lastCellVisibleSet;
  if (!(registry instanceof Map) || !(drawn instanceof Set)) return null;
  for (const id of drawn) {
    if (!isEnvCellId(id)) continue;
    const c = registry.get(id >>> 0);
    if (!c || c.visible !== true || !c.parent) continue;
    const b = cellAcBox(c);
    if (!b) {
      out.length = 0;
      return null;
    }
    out.push(b);
  }
  return out;
}
