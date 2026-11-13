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
import { tileOfLb } from "./residency_grid.js";
import {
  poolWorldActive, getPoolWorld, addSingletonsToPools, releaseHoldoutsForLb,
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
    scene3d: null,
    /** `?portalStencil` verdict, resolved once per armed world. */
    stencil: undefined,
    /** lbKey -> Set<cellId> with pooled instances (the rebuild ledger). */
    cellsByLb: new Map(),
    /** lbKey -> Map<cellId, Array<ReplayEntry>> for unpark after tile release. */
    replayByLb: new Map(),
    /** cellIds whose pool feed HAS committed at least once (guards auto-reoffer). */
    committedCells: new Set(),
    /** the PVS set as of the last tick (the pooled twin of `_lastCellVisibleSet`). */
    lastVisible: new Set(),
    /** cells fed but not yet committed by the W3 feed — hidden on arrival. */
    pending: new Map(), // cellId -> ticks waited
    stats: {
      cellsOffered: 0, surfacesOffered: 0, surfacesPooled: 0, cellsPooled: 0,
      refusedBakedMissing: 0, bakeStripped: 0, skippedShape: 0,
      hides: 0, shows: 0, pendingHidden: 0, pendingDropped: 0,
      releasedCells: 0, releasedInstances: 0, lbsReleased: 0,
      reofferedLbs: 0, reofferedCells: 0, reofferedSurfaces: 0,
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
 *  first `addGeometry`, so a class's members must agree. Memoised per source
 *  geometry so cross-cell surfaces reuse the same BufferGeometry and content key. */
const _strippedByGeom = new WeakMap();
function _withoutBake(geom) {
  let g = _strippedByGeom.get(geom);
  if (g !== undefined) return g;
  g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geom.attributes)) {
    if (name === "acBakedLight") continue;
    g.setAttribute(name, attr);
  }
  if (geom.index) g.setIndex(geom.index);
  _strippedByGeom.set(geom, g);
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
  const { lbKey, cellId, cellMatrix, meshGroup, entries } = args || {};
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const s = _st();
  if (scene3d) {
    s.scene3d = scene3d;
    if (scene3d._unparkPoolEnvCellsForLb !== _unparkHook) {
      scene3d._unparkPoolEnvCellsForLb = _unparkHook;
    }
    if (scene3d._evictPoolEnvCellsForLb !== releasePooledCellsForLb) {
      scene3d._evictPoolEnvCellsForLb = releasePooledCellsForLb;
    }
  }
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
    n.userData = {
      __poolCellId: cellId >>> 0,
      cellId: cellId >>> 0,
      surfaceDid: e.group.surfaceDid,
      __poolCellPos: cellMatrix ? pos.clone() : null,
      __poolCellQuat: cellMatrix ? quat.clone() : null,
      __poolCellScl: cellMatrix ? scl.clone() : null,
    };
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
  let heldOut = 0;
  const replayNodes = [];
  for (let k = 0; k < nodes.length; k += 1) {
    const n = nodes[k];
    if (!refused.has(n)) {
      out[nodeIndex[k]] = true;
      pooled += 1;
      replayNodes.push({
        node: n,
        geom: n.geometry,
        mat: n.material,
        name: n.name,
        pos: n.position.clone(),
        quat: n.quaternion.clone(),
        scl: n.scale.clone(),
        castShadow: n.castShadow,
        receiveShadow: n.receiveShadow,
        surfaceDid: n.userData.surfaceDid,
        meshGroup: meshGroup || null,
      });
    } else if (n.userData && n.userData.__poolHeldRs != null) {
      // Held out (BC7_PENDING or OFF_PAGE). Parent to meshGroup as a temporary
      // singleton so it renders during texture fetch without being permanently
      // fused into per-cell legacy meshes. IMPORTANT: meshGroup ALREADY carries
      // cellMatrix, so reset `n` to local identity before parenting under meshGroup
      // (avoiding a 2x cellMatrix double-transform!).
      const replayPos = n.position.clone();
      const replayQuat = n.quaternion.clone();
      const replayScl = n.scale.clone();
      if (meshGroup) {
        n.position.set(0, 0, 0);
        n.quaternion.identity();
        n.scale.set(1, 1, 1);
        n.updateMatrix();
        if (meshGroup.layers) n.layers.mask = meshGroup.layers.mask;
        try { meshGroup.add(n); } catch (_) { /* fail-soft */ }
      }
      out[nodeIndex[k]] = true;
      heldOut += 1;
      replayNodes.push({
        node: n,
        geom: n.geometry,
        mat: n.material,
        name: n.name,
        pos: replayPos,
        quat: replayQuat,
        scl: replayScl,
        castShadow: n.castShadow,
        receiveShadow: n.receiveShadow,
        surfaceDid: n.userData.surfaceDid,
        meshGroup: meshGroup || null,
      });
    }
  }
  if (pooled > 0 || heldOut > 0) {
    if (pooled > 0) {
      s.stats.surfacesPooled += pooled;
      s.stats.cellsPooled += 1;
    }
    const key = lbKey >>> 0;
    const cid = cellId >>> 0;
    let set = s.cellsByLb.get(key);
    if (!set) { set = new Set(); s.cellsByLb.set(key, set); }
    set.add(cid);
    if (replayNodes.length > 0) {
      let byCell = s.replayByLb.get(key);
      if (!byCell) { byCell = new Map(); s.replayByLb.set(key, byCell); }
      byCell.set(cid, replayNodes);
    }
    // A pooled instance is born VISIBLE at the LIVE flip (S2.4). Under stage B
    // the flip happens LATER (a W3 item), so the cell cannot be hidden here —
    // it is queued and hidden by the next PVS tick that sees it committed.
    if (!s.lastVisible.has(cid)) s.pending.set(cid, 0);
  }
  return out;
}

function _controllerFeedingCell(controller, cellId) {
  if (!controller || !(controller._feeds instanceof Map)) return false;
  const target = cellId >>> 0;
  for (const entry of controller._feeds.values()) {
    const jobs = Array.isArray(entry) ? entry : [entry];
    for (let j = 0; j < jobs.length; j += 1) {
      const job = jobs[j];
      if (!job || job.committed) continue;
      const plan = job.tilePlan || job.plan;
      const items = plan?.members || plan?.items;
      if (!Array.isArray(items)) continue;
      for (let i = 0; i < items.length; i += 1) {
        if ((items[i]?.cellId >>> 0) === target) return true;
      }
    }
  }
  return false;
}

function _unparkHook(lbKey) {
  const s = _state;
  return reofferParkedCellsIfReleased(s ? s.scene3d : null, lbKey);
}

/**
 * Re-offer pooled EnvCell surfaces for a warm-parked LB whose SlotGrid tile was
 * released while the player was away (`0x860201ad` dungeon teleport re-entry).
 * Without this, `LandblockLRU.unpark` re-attaches `cellContainers` holding only
 * unpooled furniture while `PoolRegistry` no longer holds the walls/floors.
 */
export function reofferParkedCellsIfReleased(scene3d, lbKey) {
  if (!envCellPoolsActive()) return 0;
  const w = getPoolWorld();
  const reg = w && w.registry;
  if (!reg) return 0;
  const s = _st();
  const effScene = scene3d || s.scene3d;
  const key = (lbKey >>> 0) & 0xffff0000;
  const byCell = s.replayByLb.get(key >>> 0);
  if (!byCell || byCell.size === 0) return 0;

  const toOffer = [];
  const meta = [];
  const touchedCells = new Set();
  for (const [cellId, list] of byCell) {
    if (reg.hasCell(cellId)) continue;
    if (_controllerFeedingCell(w.controller, cellId)) continue;
    for (let i = 0; i < list.length; i += 1) {
      const rec = list[i];
      // Still parented to meshGroup as an unsettled holdout -> already drawing.
      if (rec.node && rec.node.parent !== null) continue;
      const m = new THREE.Mesh(rec.geom, rec.mat);
      m.name = rec.name;
      m.position.copy(rec.pos);
      m.quaternion.copy(rec.quat);
      m.scale.copy(rec.scl);
      m.castShadow = rec.castShadow;
      m.receiveShadow = rec.receiveShadow;
      m.userData = {
        __poolCellId: cellId >>> 0,
        cellId: cellId >>> 0,
        surfaceDid: rec.surfaceDid,
        __poolCellPos: rec.pos.clone(),
        __poolCellQuat: rec.quat.clone(),
        __poolCellScl: rec.scl.clone(),
      };
      rec.node = m;
      toOffer.push(m);
      meta.push(rec);
      touchedCells.add(cellId >>> 0);
    }
  }
  if (toOffer.length === 0) return 0;

  // Ensure a previously vacated SlotGrid tile accepts the warm-unparked LB's
  // plan instead of immediately abandoning it (`_vacated.has(tileKey)`).
  if (w.controller && typeof w.controller.onReadmit === "function") {
    const lbx = (key >>> 24) & 0xff;
    const lby = (key >>> 16) & 0xff;
    w.controller.onReadmit(tileOfLb(lbx, lby));
  }

  let passthrough = [];
  try {
    const r = addSingletonsToPools(toOffer, effScene, {
      domain: "ec",
      lbKey: key >>> 0,
      urgent: true,
    });
    passthrough = r.passthrough || [];
  } catch (e) {
    s.stats.feedErrors += 1;
    return 0;
  }

  const refused = new Set(passthrough);
  let reoffered = 0;
  for (let i = 0; i < toOffer.length; i += 1) {
    const m = toOffer[i];
    const rec = meta[i];
    if (!refused.has(m)) {
      reoffered += 1;
    } else {
      // Parent ANY refused mesh (whether held-out for BC7/offPage or refused by
      // layer capacity / vacated fallback) onto meshGroup at local identity so
      // no interior wall/floor disappears AND `rec.node.parent !== null` prevents
      // repeated re-offer loops.
      if (rec.meshGroup) {
        m.position.set(0, 0, 0);
        m.quaternion.identity();
        m.scale.set(1, 1, 1);
        m.updateMatrix();
        if (rec.meshGroup.layers) m.layers.mask = rec.meshGroup.layers.mask;
        try { rec.meshGroup.add(m); } catch (_) { /* fail-soft */ }
      }
      if (m.userData && m.userData.__poolHeldRs != null) reoffered += 1;
    }
  }
  if (reoffered > 0) {
    s.stats.reofferedLbs += 1;
    s.stats.reofferedCells += touchedCells.size;
    s.stats.reofferedSurfaces += reoffered;
    for (const cid of touchedCells) {
      s.lastVisible.delete(cid);
      if (!s.lastVisible.has(cid)) s.pending.set(cid, 0);
    }
  }
  return reoffered;
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

  // Auto-reoffer ONLY if PVS wants a cell that HAD previously committed to
  // `PoolRegistry` (`committedCells.has(id)`) and subsequently lost its pooled
  // instances during an away-teleport tile release (`!reg.hasCell(id)`). Never
  // auto-reoffer a cell whose initial feed hasn't committed yet!
  if (s.replayByLb.size > 0 && s.committedCells.size > 0) {
    const checkedLbs = new Set();
    for (const id of want) {
      const cid = id >>> 0;
      if (reg.hasCell(cid)) {
        s.committedCells.add(cid);
        continue;
      }
      if (!s.committedCells.has(cid) || s.pending.has(cid)) continue;
      const lbKey = (cid & 0xffff0000) >>> 0;
      if (checkedLbs.has(lbKey)) continue;
      checkedLbs.add(lbKey);
      const lbCells = s.cellsByLb.get(lbKey);
      if (lbCells) {
        for (const memberCid of lbCells) s.committedCells.delete(memberCid >>> 0);
      } else {
        s.committedCells.delete(cid);
      }
      if (s.replayByLb.has(lbKey)) {
        reofferParkedCellsIfReleased(s.scene3d, lbKey);
      }
    }
  }

  // Cells fed since the last tick: hide the ones the PVS does not want, as soon
  // as their feed has actually committed.
  if (s.pending.size > 0) {
    for (const [cellId, ticks] of [...s.pending]) {
      if (reg.hasCell(cellId)) {
        s.committedCells.add(cellId >>> 0);
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
  let droppedUncommitted = false;
  for (const id of want) {
    if (reg.hasCell(id)) {
      s.committedCells.add(id >>> 0);
      if (!s.lastVisible.has(id)) entering.push(id);
    }
  }
  for (const id of s.lastVisible) {
    if (!reg.hasCell(id)) {
      droppedUncommitted = true;
    } else if (!want.has(id)) {
      leaving.push(id);
    }
  }
  if (entering.length > 0) {
    flips += reg.setCellsVisible(entering, true);
    s.stats.shows += entering.length;
  }
  if (leaving.length > 0) {
    flips += reg.setCellsVisible(leaving, false);
    s.stats.hides += leaving.length;
  }
  if (entering.length > 0 || leaving.length > 0 || droppedUncommitted) {
    s.lastVisible.clear();
    for (const id of want) {
      if (reg.hasCell(id)) s.lastVisible.add(id);
    }
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
  try { releaseHoldoutsForLb(lbKey, "ec"); } catch (_) { /* fail-soft */ }
  const w = getPoolWorld();
  const reg = w && w.registry;
  if (!reg) return 0;
  const s = _st();
  const key = lbKey >>> 0;
  s.replayByLb.delete(key);
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
  for (const id of set) {
    s.pending.delete(id);
    s.lastVisible.delete(id);
    s.committedCells.delete(id >>> 0);
  }
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
