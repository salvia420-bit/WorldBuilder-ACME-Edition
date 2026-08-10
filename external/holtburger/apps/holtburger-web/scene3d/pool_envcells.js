// scene3d/pool_envcells.js — THE ENVCELL PRODUCER SWAP (ST9 / T22-PRODUCER
// remainder D3; SPEC §1.5 "statics + buildings + envcells collapse in",
// pass-07 D-07.1/D-07.6/D-07.8).
//
// WHAT THIS IS
// ------------
// T22-PRODUCER swapped statics and buildings onto the draw pools and recorded
// the ENVCELL domain as its remainder, with three read-verified blockers. This
// module is the interior half, and it exists as its own file because interiors
// are not a third one-line call site — they carry three facts statics do not:
//
//   (a) THEY LIVE ON ANOTHER LAYER. `index.js:1455` puts `cellsGroup` on
//       RENDER_LAYER_INDOOR and `cells.js:1642` stamps every node of every cell
//       container `layers.set(1)`, because `atmosphere_pipeline` renders layer
//       0, CLEARS DEPTH, then renders layer 1. A pool on the statics group
//       would be drawn before the clear and lose the isolation. Handled in the
//       registry (`groups`/`layers`, leg 1) and armed in `index.js`.
//
//   (b) THEY ARE VISIBLE PER CELL. `cells.js`'s PVS tick flips
//       `container.visible` per cellId, diff-driven, 0-3 cells on a steady
//       tick. The pooled form is `PoolRegistry.setCellsVisible` over the same
//       diff — see `poolCellVisibilityTick`, which is called from the SAME
//       tick, right after the container loop, so both halves of a partly
//       pooled cell toggle together.
//
//   (c) THE PORTAL TICKS WALK CONTAINERS. `tickPortalStencil` MOVES a cell
//       container's whole subtree between layer 1 and RENDER_LAYER_PORTAL_CELL
//       — an operation with no pooled equivalent (a pool is one object; its
//       instances cannot be on two layers). `?portalStencil` is DEFAULT-OFF and
//       explicitly UNVALIDATED (`docs/url-flags.md:256`), so rather than
//       half-support it the envcell swap DISARMS ITSELF when that flag is on,
//       loudly and counted: interiors stay wholly legacy and the stencil path
//       is exactly what it is today. `tickPortalPunch` and `tickPortalSeal`
//       walk apertures, not containers, and need nothing — the punched doorway
//       reveals whatever is on layer 1, which is where the pools are.
//
// WHAT STAYS ON THE LEGACY PRODUCER, DELIBERATELY
// -----------------------------------------------
//   * cell STATIC props (furniture, braziers, banners): they are per-placement
//     nodes under the cell container with animated/scripted siblings that read
//     that parenting (`cells.js:1684` resolveParent, the particle anchors), so
//     they keep the container and never reach this module at all.
//   * every surface the class-material registry refuses (the D2 residue and
//     friends) — returned as passthrough and FUSED exactly as today.
//   * the cell CONTAINER itself. It is never removed: it still carries the
//     cell's userData contract (`portalCellIds`, `isEnvCell`, the geom-audit
//     rows), its props, and its own `.visible` flag. Pooling replaces its
//     SURFACE meshes, not the cell.
//
// THE BAKE IS A HARD GATE (not negotiable)
// ----------------------------------------
// A cell surface whose material carries `__acBakedLight` must reach the pool
// WITH its `acBakedLight` attribute, or the dungeon renders on ambient alone
// (lighting.js's RND-04 handshake has already dropped the static lamps). The
// class material takes the patch (leg 2) and this module refuses any member
// whose geometry cannot supply the attribute — counted `bakedMissing`, never
// silently flattened.

import * as THREE from "three";
import {
  poolWorldActive, getPoolWorld, addSingletonsToPools,
} from "./pool_producer.js";

// ---------------------------------------------------------------------------
// arming
// ---------------------------------------------------------------------------

/** `?portalStencil` — read with the house exact-match grammar (default OFF). */
function portalStencilOn(search) {
  try {
    const s = search !== undefined
      ? search
      : (typeof window !== "undefined" && window.location ? window.location.search : "");
    return String(new URLSearchParams(s).get("portalStencil") || "").toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

let _state = null;
let _warnedStencil = false;

function _freshState() {
  return {
    world: null,
    /** `?portalStencil` verdict, resolved once per armed world. */
    stencil: undefined,
    /** lbKey -> Set<cellId> with pooled instances (the rebuild ledger). */
    cellsByLb: new Map(),
    /** the PVS set as of the last tick (the pooled twin of `_lastCellVisibleSet`). */
    lastVisible: new Set(),
    /** cells fed but not yet committed by the W3 feed — hidden on arrival. */
    pending: new Map(), // cellId -> ticks waited
    stats: {
      cellsOffered: 0, surfacesOffered: 0, surfacesPooled: 0, cellsPooled: 0,
      refusedBakedMissing: 0, bakeStripped: 0, skippedShape: 0,
      hides: 0, shows: 0, pendingHidden: 0, pendingDropped: 0,
      releasedCells: 0, releasedInstances: 0, lbsReleased: 0,
      disarmedPortalStencil: 0, feedErrors: 0,
    },
  };
}

/** Pending cells that never commit are dropped after this many PVS ticks (a
 *  feed can be abandoned by a slot vacation; the ledger must not grow). */
const PENDING_MAX_TICKS = 600;

function _st() {
  const w = getPoolWorld();
  if (!_state || _state.world !== w) {
    _state = _freshState();
    _state.world = w;
  }
  return _state;
}

/**
 * True when envcell surfaces should be routed into pools. False (and LOUD,
 * once) when `?portalStencil` is armed — that path re-layers whole cell
 * containers, which a pool cannot do.
 */
export function envCellPoolsActive(search) {
  if (!poolWorldActive()) return false;
  const st = _st();
  // Resolved ONCE per armed world (a URL flag cannot change mid-session), so
  // every later reader — the census included — gets the same answer without
  // having to carry the query string.
  if (st.stencil === undefined) st.stencil = portalStencilOn(search);
  if (st.stencil) {
    if (!_warnedStencil) {
      _warnedStencil = true;
      st.stats.disarmedPortalStencil += 1;
      try {
        console.warn(
          "[drawPools] envcell pooling DISARMED: ?portalStencil moves whole cell "
          + "containers to RENDER_LAYER_PORTAL_CELL, which pooled instances cannot "
          + "follow. Interiors stay on the legacy producer for this session.",
        );
      } catch (_) { /* fail-soft */ }
    }
    return false;
  }
  return true;
}

/**
 * Point the registry's "ec" pools at the CELLS group on RENDER_LAYER_INDOOR
 * (blocker (a)). Called by `index.js` immediately after `initPoolWorld`.
 *
 * Set POST-CONSTRUCTION rather than threaded through `initPoolWorld`'s deps
 * because `PoolRegistry` reads `groups`/`layers` lazily, at the moment a pool
 * is first created — which is always after boot arming — and because
 * `pool_producer.js` is concurrently owned by another in-flight task. Folding
 * this into the arming call is a one-line follow-up, recorded as a handoff.
 *
 * @param {object} args
 * @param {object} args.staticsGroup  the layer-0 group (statics/buildings)
 * @param {object} args.cellsGroup    the layer-1 group (EnvCells)
 * @param {number} [args.indoorLayer] RENDER_LAYER_INDOOR (default 1)
 * @returns {boolean} armed
 */
export function armEnvCellPoolGroups({ staticsGroup, cellsGroup, indoorLayer = 1 } = {}) {
  if (!poolWorldActive()) return false;
  const w = getPoolWorld();
  const reg = w && w.registry;
  if (!reg || !cellsGroup) return false;
  reg.groups = { st: staticsGroup || reg.group, ec: cellsGroup };
  reg.layers = { ec: indoorLayer };
  return true;
}

// ---------------------------------------------------------------------------
// the feed
// ---------------------------------------------------------------------------

/** A geometry minus its `acBakedLight` attribute, sharing every other
 *  attribute VIEW (no copy). Used when the class is unbaked but the source
 *  bundle carried the attribute — BatchedMesh fixes its attribute set at the
 *  first `addGeometry`, so a class's members must agree. */
function _withoutBake(geom) {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geom.attributes)) {
    if (name === "acBakedLight") continue;
    g.setAttribute(name, attr);
  }
  if (geom.index) g.setIndex(geom.index);
  return g;
}

/**
 * Offer ONE cell's per-surface groups to the (sector × class) pools.
 *
 * Called BEFORE `cell_fusion.js` runs: a pooled surface leaves the fusion
 * bucket entirely, and everything refused fuses exactly as it does today, so
 * the legacy shape is preserved for whatever the pools cannot take. Buckets
 * keep their all-or-nothing baked contract (removing members from a bucket
 * whose every member carries the attribute leaves that true).
 *
 * @param {object} scene3d
 * @param {object} args
 * @param {number} args.lbKey        owning landblock key
 * @param {number} args.cellId       full cellId (the PVS/visibility identity)
 * @param {THREE.Matrix4} args.cellMatrix  the cell's mesh-group transform —
 *   pooled instances are stored in CELLS-GROUP space, and a cell surface's own
 *   local TRS is identity, so this IS the member's world matrix.
 * @param {Array<{group:{geometry:object, surfaceDid:number}, material:object}>} args.entries
 * @param {boolean} [args.castShadow]
 * @param {boolean} [args.receiveShadow]
 * @param {boolean} [args.urgent]
 * @returns {boolean[]|null} per-entry "was pooled" flags, or null when inactive
 */
export function offerCellSurfacesToPools(scene3d, args) {
  if (!envCellPoolsActive()) return null;
  const { lbKey, cellId, cellMatrix, entries } = args || {};
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const s = _st();
  s.stats.cellsOffered += 1;

  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  if (cellMatrix) cellMatrix.decompose(pos, quat, scl);

  const nodes = [];
  const nodeIndex = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const mat = e && e.material;
    const geom = e && e.group && e.group.geometry;
    s.stats.surfacesOffered += 1;
    if (!mat || Array.isArray(mat) || !geom || !geom.attributes || !geom.attributes.uv) {
      s.stats.skippedShape += 1;
      continue;
    }
    // THE BAKE GATE. `__acBakedLight` is a class-key axis, so this decision is
    // class-uniform by construction; what it guards is the ATTRIBUTE actually
    // being there to feed the patched class material.
    const wantBaked = mat.userData && mat.userData.__acBakedLight === true;
    const hasBaked = !!(geom.getAttribute && geom.getAttribute("acBakedLight"));
    let src = geom;
    if (wantBaked && !hasBaked) {
      // Refused, never flattened: the legacy path renders it WITH its lamps
      // already dropped, which is today's behaviour for this (impossible by
      // `cellMaterialFor`'s own all-or-nothing rule) case.
      s.stats.refusedBakedMissing += 1;
      continue;
    }
    if (!wantBaked && hasBaked) {
      src = _withoutBake(geom);
      s.stats.bakeStripped += 1;
    }
    const n = new THREE.Mesh(src, mat);
    n.name = `envcell-pool-${(cellId >>> 0).toString(16)}-${(e.group.surfaceDid >>> 0).toString(16)}`;
    if (cellMatrix) {
      n.position.copy(pos);
      n.quaternion.copy(quat);
      n.scale.copy(scl);
    }
    // Shadow flags are class-key axes (D-07.6) and therefore PER SURFACE: the
    // entry's own values win, the call-level ones are the fallback.
    n.castShadow = (e.castShadow !== undefined ? e.castShadow : args.castShadow) === true;
    n.receiveShadow = (e.receiveShadow !== undefined ? e.receiveShadow : args.receiveShadow) === true;
    // The producer reads this straight into the plan row (pool_producer.js:223)
    // and the registry turns it into the per-cell instance range (D-07.8).
    n.userData = { __poolCellId: cellId >>> 0, cellId: cellId >>> 0, surfaceDid: e.group.surfaceDid };
    nodes.push(n);
    nodeIndex.push(i);
  }
  if (nodes.length === 0) return entries.map(() => false);

  let passthrough = nodes;
  try {
    const r = addSingletonsToPools(nodes, scene3d, {
      domain: "ec",
      lbKey: lbKey >>> 0,
      urgent: args.urgent === true,
    });
    passthrough = r.passthrough || [];
  } catch (e) {
    s.stats.feedErrors += 1;
    try {
      // eslint-disable-next-line no-console
      console.warn("[drawPools/envcells] pool feed failed; this cell stays legacy:", String(e?.message ?? e));
    } catch (_) { /* fail-soft */ }
    return entries.map(() => false);
  }

  const refused = new Set(passthrough);
  const out = entries.map(() => false);
  let pooled = 0;
  for (let k = 0; k < nodes.length; k += 1) {
    if (refused.has(nodes[k])) continue;
    out[nodeIndex[k]] = true;
    pooled += 1;
  }
  if (pooled > 0) {
    s.stats.surfacesPooled += pooled;
    s.stats.cellsPooled += 1;
    const key = lbKey >>> 0;
    let set = s.cellsByLb.get(key);
    if (!set) { set = new Set(); s.cellsByLb.set(key, set); }
    set.add(cellId >>> 0);
    // A pooled instance is born VISIBLE at the LIVE flip (S2.4). Under stage B
    // the flip happens LATER (a W3 item), so the cell cannot be hidden here —
    // it is queued and hidden by the next PVS tick that sees it committed.
    if (!s.lastVisible.has(cellId >>> 0)) s.pending.set(cellId >>> 0, 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// visibility (blocker (b) — the pooled twin of `container.visible`)
// ---------------------------------------------------------------------------

/**
 * Apply this tick's PVS render set to the pooled cell instances.
 *
 * Called from `tickCellVisibility3D` immediately after the container flips, on
 * the SAME set, so a partly-pooled cell's two halves can never disagree. Diff
 * driven: the steady-state cost is the size of the delta (0-3 cells), which is
 * what the legacy walk it replaces costs.
 *
 * @param {Set<number>|Iterable<number>} visibleSet cellIds visible this tick
 * @returns {number} instance flips performed
 */
export function poolCellVisibilityTick(visibleSet) {
  if (!envCellPoolsActive()) return 0;
  const w = getPoolWorld();
  const reg = w && w.registry;
  if (!reg) return 0;
  const s = _st();
  const want = visibleSet instanceof Set ? visibleSet : new Set(visibleSet || []);
  let flips = 0;

  // Cells fed since the last tick: hide the ones the PVS does not want, as soon
  // as their feed has actually committed.
  if (s.pending.size > 0) {
    for (const [cellId, ticks] of [...s.pending]) {
      if (reg.hasCell(cellId)) {
        s.pending.delete(cellId);
        if (!want.has(cellId)) {
          flips += reg.setCellsVisible([cellId], false);
          s.stats.pendingHidden += 1;
        }
      } else if (ticks >= PENDING_MAX_TICKS) {
        // Never committed — an abandoned feed (slot vacated mid-flight).
        s.pending.delete(cellId);
        s.stats.pendingDropped += 1;
      } else {
        s.pending.set(cellId, ticks + 1);
      }
    }
  }

  const entering = [];
  const leaving = [];
  for (const id of want) if (!s.lastVisible.has(id)) entering.push(id);
  for (const id of s.lastVisible) if (!want.has(id)) leaving.push(id);
  if (entering.length > 0) {
    flips += reg.setCellsVisible(entering, true);
    s.stats.shows += entering.length;
  }
  if (leaving.length > 0) {
    flips += reg.setCellsVisible(leaving, false);
    s.stats.hides += leaving.length;
  }
  if (entering.length > 0 || leaving.length > 0) {
    s.lastVisible.clear();
    for (const id of want) s.lastVisible.add(id);
  }
  return flips;
}

/** `?cellBugParity`'s "every cell visible" mode — the pooled equivalent. */
export function poolCellsSetAllVisible() {
  if (!envCellPoolsActive()) return 0;
  const w = getPoolWorld();
  const reg = w && w.registry;
  if (!reg) return 0;
  const s = _st();
  const all = [];
  for (const set of s.cellsByLb.values()) for (const id of set) all.push(id);
  if (all.length === 0) return 0;
  const flips = reg.setCellsVisible(all, true);
  s.pending.clear();
  s.lastVisible.clear();
  for (const id of all) s.lastVisible.add(id);
  return flips;
}

// ---------------------------------------------------------------------------
// release (the rebuild ledger)
// ---------------------------------------------------------------------------

/**
 * Drop every pooled instance this landblock's cells own.
 *
 * Called at the TOP of `buildEnvCellsForLandblock` (and on its eviction-abort
 * path): an LB rebuild after an LRU evict re-feeds its cells, and re-feeding
 * without releasing would double every interior surface. The grid's own
 * release is TILE-scoped (2x2 LBs), which is too coarse to stand in for this.
 *
 * @returns {number} instances deleted
 */
export function releasePooledCellsForLb(lbKey) {
  if (!poolWorldActive()) return 0;
  const w = getPoolWorld();
  const reg = w && w.registry;
  if (!reg) return 0;
  const s = _st();
  const key = lbKey >>> 0;
  const set = s.cellsByLb.get(key);
  if (!set || set.size === 0) return 0;
  let n = 0;
  try {
    n = reg.releaseCells(set);
  } catch (e) {
    try {
      // eslint-disable-next-line no-console
      console.warn("[drawPools/envcells] cell release failed:", String(e?.message ?? e));
    } catch (_) { /* fail-soft */ }
  }
  for (const id of set) s.pending.delete(id);
  s.cellsByLb.delete(key);
  s.stats.releasedCells += set.size;
  s.stats.releasedInstances += n;
  s.stats.lbsReleased += 1;
  return n;
}

// ---------------------------------------------------------------------------
// census
// ---------------------------------------------------------------------------

/** The envcell rows of `__diag.pools` (merged in by index.js). */
export function envCellPoolCensus() {
  if (!poolWorldActive()) return { enabled: false };
  const s = _st();
  let cells = 0;
  for (const set of s.cellsByLb.values()) cells += set.size;
  return {
    enabled: envCellPoolsActive(),
    lbs: s.cellsByLb.size,
    cells,
    visible: s.lastVisible.size,
    pending: s.pending.size,
    ...s.stats,
  };
}

/** Test hook — drop the module state between arms. */
export function _resetEnvCellPoolsForTest() {
  _state = null;
  _warnedStencil = false;
}
