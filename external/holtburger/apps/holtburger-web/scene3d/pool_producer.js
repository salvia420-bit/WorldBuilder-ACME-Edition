// scene3d/pool_producer.js — THE PRODUCER SWAP (ST9 / T22-PRODUCER;
// SPEC §1.5/§3 T22, pass-07 S1/S2/D-07.5, T22 report Handoffs 2–7).
//
// WHAT THIS IS
// ------------
// T22 landed the pool SUBSTRATE (class key, registry, TilePlan, stage B/C,
// prewarm) with nothing feeding it. This module is the feed: it takes the
// singleton meshes the live producers already build (statics, buildings,
// envcells) and routes them into (sector × class) pools instead of the scene
// graph — behind the full F-11.3 flag chain, with the legacy stack untouched
// as the kill path.
//
// THE SEAM IS DELIBERATELY THE ATLAS'S SEAM
// -----------------------------------------
// `addSingletonsToPools(nodes, scene3d, opts)` has the same shape and the same
// contract as `static_atlas.js#addSingletonsToCrossLbAtlas(nodes, scene3d)`:
// nodes in, `{ passthrough }` out, every refusal counted, the caller adds the
// passthrough to its own group unchanged. That is not a coincidence — SPEC §1.5
// says the atlas is "subsumed wholesale" by pools, so the pooled producer is
// the atlas's successor at the atlas's own call sites, and each producer swap
// is a one-line change with a bisectable commit of its own.
//
// A node's local TRS must already be group-relative — the atlas's own
// `n.updateMatrix(); setMatrixAt(iid, n.matrix)` contract
// (static_atlas.js:1684). Every existing call site already satisfies it.
//
// WHERE THE CLASS IS DERIVED (DEVIATION from pass-07 D-07.5, recorded)
// -------------------------------------------------------------------
// D-07.5 says "the main thread never derives a class": the bake worker emits a
// TilePlan with the class already resolved. T22's D1 recorded why that half is
// not landed — resolving a pack surface record into an axis record off-thread
// means reproducing `materials.js`'s builder ladder (ClipMap render state, the
// patch installers, the MECH-B VFX `set#config` token) in the worker, whose
// failure mode is SILENT VISUAL DIVERGENCE between arms.
//
// This module derives the axis record from the RESOLVED MATERIAL the legacy
// producer would itself have used (`axisRecordOf(mat, …)`), so the pooled arm
// and the legacy arm cannot disagree about render state by construction — the
// two arms read the same object. The class KEY is still produced only by
// `classKeyOf` (through the landed `buildTilePlan`), so census, prewarm and
// runtime still agree byte-for-byte. Moving the derivation off-thread stays the
// recorded remainder; it is now a RELOCATION with a live pooled world to differ
// against, instead of a rewrite with nothing to check it.
//
// THE D2 LEGACY ROUTE (counted, never silent)
// -------------------------------------------
// A member whose native texture dims are not its class's PAGE dims has no legal
// layer until the bake/transcode resample lands (T22 D2; a concurrent task owns
// it). `ClassMaterialRegistry.admit` refuses it, `refused.needsResample` counts
// it, and it comes back in `passthrough` — i.e. it renders through TODAY'S
// producer. The pooled world is therefore a strict SUBSET of the world until
// the resample lands, and the size of the residue is a published number
// (`__diag.pools().classPages.refused`).

import {
  initDrawPools, getPoolRegistry, drawPoolsActive, checkDrawPoolsPrereqs,
} from "./pool_registry.js";
import { ClassMaterialRegistry, normalizeForPool, REFUSE } from "./pool_material.js";
import { axisRecordOf, classKeyOf, sectorKeyOfLb } from "./pool_class_key.js";
import { buildTilePlan } from "./tile_plan.js";
import { PoolStreamController } from "./pool_stream.js";
import { tileOfLb, tileLbKeys } from "./residency_grid.js";
import { frameWorkEnabled, getFrameWorkScheduler } from "./frame_work.js";
import { registerAtlasRefeed } from "./bc7_textures.js";

// ---------------------------------------------------------------------------
// the pool world singleton
// ---------------------------------------------------------------------------

let _world = null;
let _initTried = false;

/**
 * Arm the pooled world. Returns the handle when the F-11.3 chain is satisfied,
 * else `null` (and `initDrawPools` has already said why, loudly). Idempotent.
 *
 * @param {object} deps
 * @param {object} deps.THREE
 * @param {object} [deps.group]   scene group pools attach to (staticsGroup)
 * @param {string} [deps.search]
 */
export function initPoolWorld({ THREE, group, search } = {}) {
  if (_world) return _world;
  if (_initTried) return null;
  _initTried = true;
  const chk = checkDrawPoolsPrereqs(search);
  if (!chk.armed) {
    // `initDrawPools` names every unmet flag; call it so the refusal message is
    // identical whichever entry point armed first.
    initDrawPools({ THREE, search, materialFactory: () => null });
    return null;
  }
  const classMats = new ClassMaterialRegistry({});
  const registry = initDrawPools({
    THREE,
    search,
    group,
    materialFactory: (classKey) => classMats.materialFactory(classKey),
  });
  if (!registry) return null;
  let controller = null;
  if (chk.frameWork && frameWorkEnabled(search)) {
    try {
      controller = new PoolStreamController({ registry, scheduler: getFrameWorkScheduler() });
    } catch (e) {
      // Stage A pools (feeds on the caller's cadence) stay legal without it.
      try { console.warn("[drawPools] stream controller unavailable; feeding inline", e); } catch (_) { /* fail-soft */ }
      controller = null;
    }
  }
  _world = {
    registry,
    classMats,
    controller,
    /** contentKey -> source geometry (the pool's dedup identity). */
    geomByContent: new Map(),
    /** rsId -> [{node, scene3d, opts}] held out until the full tier lands. */
    holdouts: new Map(),
    stats: {
      nodesIn: 0, pooled: 0, passthrough: 0, plans: 0, planErrors: 0,
      byDomain: { st: 0, ec: 0 },
      refusedNodes: 0, normFails: 0,
      parks: 0, adopts: 0, releases: 0,
      refeedCalls: 0, refeedLayers: 0, refeedRehomed: 0,
    },
  };
  // F-11.17: the producer-agnostic re-home seam. The atlas registers the same
  // hook at module load; the LAST registration wins, and pools are the declared
  // successor producer, so arming the pooled world takes ownership. The
  // atlas-side implementation is the declared throwaway (T22 Handoff 6).
  try { registerAtlasRefeed((rsId) => poolAtlasRefeed(rsId)); } catch (_) { /* fail-soft */ }
  return _world;
}

export function poolWorldActive() {
  return _world !== null && drawPoolsActive();
}

export function getPoolWorld() {
  return _world;
}

// ---------------------------------------------------------------------------
// the feed
// ---------------------------------------------------------------------------

/**
 * Route singleton meshes into (sector × class) pools.
 *
 * @param {Array<object>} nodes  THREE.Mesh singletons whose local TRS is
 *   already group-relative (the atlas contract).
 * @param {object} scene3d
 * @param {object} opts
 * @param {"st"|"ec"} opts.domain  pool domain (statics/buildings = "st",
 *   envcells = "ec") — D-07.1's table, never a predicate.
 * @param {number} opts.lbKey      owning landblock key (0xXXYY0000)
 * @param {boolean} [opts.urgent]  player-tile feed ⇒ W1 instead of W3
 * @returns {{passthrough: Array<object>, pooled: number}}
 */
export function addSingletonsToPools(nodes, scene3d, opts = {}) {
  if (!poolWorldActive() || !nodes || nodes.length === 0) {
    return { passthrough: nodes || [], pooled: 0 };
  }
  const w = _world;
  const domain = opts.domain === "ec" ? "ec" : "st";
  const lbKey = (opts.lbKey >>> 0);
  const lbx = (lbKey >>> 24) & 0xff;
  const lby = (lbKey >>> 16) & 0xff;
  const tile = tileOfLb(lbx, lby);
  const passthrough = [];
  const placements = [];
  const recBySurface = new Map(); // material uuid -> axis record (memo)

  for (const n of nodes) {
    w.stats.nodesIn += 1;
    // Same admission gate as the atlas: real single-material meshes with UVs.
    // A BatchedMesh / LOD wrapper / already-batched node is never re-fed.
    // `isInstancedMesh` (the ?walkInInstance path): a pool re-emits the node as
    // ONE instance, so an InstancedMesh routed here would lose every placement
    // but the first — the atlas's own guard, same reason.
    if (!n || !n.isMesh || n.isInstancedMesh || n.isBatchedMesh || n.isLOD || !n.geometry
        || !n.geometry.attributes || !n.geometry.attributes.uv
        || !n.material || Array.isArray(n.material)
        || (n.userData && n.userData.__staticBatch)) {
      passthrough.push(n);
      continue;
    }
    const mat = n.material;
    const cast = n.castShadow === true;
    const recv = n.receiveShadow === true;
    const surfaceKey = mat.uuid;
    let rec = recBySurface.get(surfaceKey);
    if (rec === undefined) {
      rec = axisRecordOf(mat, { domain, castShadow: cast, receiveShadow: recv });
      recBySurface.set(surfaceKey, rec);
    }
    // The class key `buildTilePlan` will build, from the SAME record composed
    // the SAME way (tile_plan.js:157) — resolved here only because a member's
    // LAYER is part of its plan row and the layer comes from its class page.
    const classKey = classKeyOf({ ...rec, domain, castShadow: cast, receiveShadow: recv });
    const admit = w.classMats.admit(classKey, mat, { ...rec, castShadow: cast, receiveShadow: recv });
    if (!admit.ok) {
      // Counted in `classMats.stats.refused[reason]`; RENDERED by the legacy
      // producer. `needsResample` is the D2 residue and is expected to be the
      // dominant reason until the bake/transcode resample lands.
      w.stats.refusedNodes += 1;
      if (admit.reason === REFUSE.BC7_PENDING) _holdOut(n, scene3d, opts, mat);
      passthrough.push(n);
      continue;
    }
    n.updateMatrix();
    const contentKey = n.geometry.uuid;
    if (!w.geomByContent.has(contentKey)) w.geomByContent.set(contentKey, n.geometry);
    placements.push({
      lbx, lby,
      surfaceKey,
      matrix: n.matrix.toArray(),
      layer: admit.layer,
      rsId: _rsIdOf(mat),
      cellId: (n.userData && n.userData.__poolCellId != null) ? n.userData.__poolCellId : undefined,
      domain,
      castShadow: cast,
      receiveShadow: recv,
      __contentKey: contentKey,
      __node: n,
    });
  }

  if (placements.length === 0) return { passthrough, pooled: 0 };

  let plan;
  try {
    plan = buildTilePlan({
      tile,
      lbs: [lbKey],
      placements,
      resolveAxes: (key) => recBySurface.get(key) || null,
      contentKeyOf: (p) => p.__contentKey,
    }).plan;
  } catch (e) {
    // A malformed plan is a producer bug: route the whole LB legacy rather
    // than feed half a tile (the S2.4 ordering invariant's own reasoning).
    w.stats.planErrors += 1;
    try { console.warn("[drawPools] TilePlan build failed; this LB stays on the legacy producer", e); } catch (_) { /* fail-soft */ }
    for (const p of placements) passthrough.push(p.__node);
    return { passthrough, pooled: 0 };
  }

  const geometrySource = {
    get: (contentKey, layer) => {
      const src = w.geomByContent.get(contentKey);
      if (!src) return null;
      const g = normalizeForPool(src, layer);
      if (!g) w.stats.normFails += 1;
      return g;
    },
  };

  if (w.controller) {
    // Stage B: the feed becomes a RESUMABLE W3 (or W1) item under the P4 budget.
    w.controller.onPlanReady(plan, geometrySource, { urgent: opts.urgent === true });
  } else {
    // Stage A: feed on the caller's cadence (legal without ?frameWork).
    w.registry.feedTile(plan, geometrySource);
  }
  w.stats.plans += 1;
  w.stats.pooled += placements.length;
  w.stats.byDomain[domain] += placements.length;
  w.stats.passthrough += passthrough.length;
  return { passthrough, pooled: placements.length };
}

function _rsIdOf(mat) {
  const ud = mat && mat.userData;
  if (!ud) return 0;
  return ((ud.__bc7RsId != null ? ud.__bc7RsId : ud.__pvwRsId) || 0) >>> 0;
}

/** A preview-born member whose full tier is still in flight is held out (its
 *  page dims would be the PREVIEW's, i.e. the wrong class) and re-offered when
 *  `atlasRefeed(rsId)` fires — the F-11.17 "nothing can stick" rule. */
function _holdOut(node, scene3d, opts, mat) {
  const rs = _rsIdOf(mat);
  if (!rs) return;
  let list = _world.holdouts.get(rs);
  if (!list) { list = []; _world.holdouts.set(rs, list); }
  list.push({ node, scene3d, opts });
}

// ---------------------------------------------------------------------------
// residency (the grid's event hooks — T22 Handoff 4)
// ---------------------------------------------------------------------------

/**
 * `SlotGrid.onSlotState` handler: the ONE choke point every S2 transition
 * passes through, so the pool half of residency is complete by construction
 * rather than by enumerating call sites.
 */
export function poolOnSlotState(ev) {
  if (!poolWorldActive() || !ev) return;
  const w = _world;
  try {
    if (ev.to === "PARKED") {
      if (w.controller) w.controller.enqueuePark(ev.tile);
      else w.registry.parkTile(ev.tile);
      w.stats.parks += 1;
    } else if (ev.to === "LIVE" && ev.from === "PARKED") {
      if (w.controller) w.controller.enqueueAdopt(ev.tile);
      else w.registry.adoptTile(ev.tile);
      w.stats.adopts += 1;
    } else if (ev.to === "EMPTY") {
      _releaseTile(ev.tile);
    }
  } catch (e) {
    try { console.warn("[drawPools] slot-state hook threw", e); } catch (_) { /* fail-soft */ }
  }
}

/** `SlotGrid.onTeleport` — the vacated set drains as releases. */
export function poolOnTeleport(ev) {
  if (!poolWorldActive() || !ev || !ev.vacated) return;
  for (const tile of ev.vacated) _releaseTile(tile);
}

/** `SlotGrid.onSeed` / `onShift` — record admits for the F-11.19 dispatch and
 *  keep the distance ordering honest. Feeds themselves stay the adapter's. */
export function poolOnAdmit(tiles, playerTile) {
  if (!poolWorldActive()) return;
  const w = _world;
  if (!w.controller) return;
  if (playerTile != null && playerTile >= 0) w.controller.setPlayerTile(playerTile);
  for (const t of tiles || []) {
    // A resident tile re-entering the window is a pointer re-adopt; a new one
    // records a dispatch item that the producers' own feed satisfies.
    w.controller.onAdmit(t);
  }
}

function _releaseTile(tile) {
  const w = _world;
  if (w.controller) w.controller.enqueueRelease(tile);
  else w.registry.releaseTile(tile);
  w.stats.releases += 1;
}

/** The P4 half — called from the post-render stream slot (pass-08 S1). */
export function poolTickP4() {
  if (!poolWorldActive()) return;
  if (_world.controller) _world.controller.tickP4();
  else _world.registry.beginFrame();
}

// ---------------------------------------------------------------------------
// atlasRefeed (F-11.17 / T22 Handoff 6)
// ---------------------------------------------------------------------------

/**
 * The pool half of `atlasRefeed(rsId)`, in two parts:
 *   1. every class-page layer this rsId owns is REWRITTEN from the upgraded
 *      material (same page dims ⇒ same class ⇒ an in-place layer write);
 *   2. every node HELD OUT at preview time is re-offered to the pools, and the
 *      ones that take are removed from the scene graph they were rendering in.
 * @returns {number} nodes re-homed (the seam's documented return).
 */
export function poolAtlasRefeed(rsId) {
  if (!poolWorldActive()) return 0;
  const w = _world;
  const rs = rsId >>> 0;
  w.stats.refeedCalls += 1;
  const layers = w.classMats.refeedRsId(rs);
  w.stats.refeedLayers += layers;
  const held = w.holdouts.get(rs);
  if (!held || held.length === 0) return layers;
  w.holdouts.delete(rs);
  let rehomed = 0;
  // Group by (scene3d, lbKey, domain) so each re-offer is one TilePlan.
  const groups = new Map();
  for (const h of held) {
    const k = `${(h.opts.lbKey >>> 0)}|${h.opts.domain || "st"}`;
    let g = groups.get(k);
    if (!g) { g = { scene3d: h.scene3d, opts: h.opts, nodes: [] }; groups.set(k, g); }
    g.nodes.push(h.node);
  }
  for (const g of groups.values()) {
    try {
      const { passthrough } = addSingletonsToPools(g.nodes, g.scene3d, g.opts);
      const pt = new Set(passthrough);
      for (const n of g.nodes) {
        if (pt.has(n)) continue;
        rehomed += 1;
        // The held-out node WAS scene-resident (it rendered as passthrough);
        // now that a pool owns its geometry it must leave the graph.
        if (n.parent) { try { n.parent.remove(n); } catch (_) { /* fail-soft */ } }
      }
    } catch (_) { /* fail-soft: the node keeps rendering as it is */ }
  }
  w.stats.refeedRehomed += rehomed;
  return rehomed + layers;
}

// ---------------------------------------------------------------------------
// census (`__diag.pools` — the registry schema plus the producer's own rows)
// ---------------------------------------------------------------------------

export function poolWorldCensus() {
  if (!_world) return { enabled: false };
  const reg = _world.registry.census();
  return {
    enabled: true,
    ...reg,
    producer: {
      ..._world.stats,
      holdoutRsIds: _world.holdouts.size,
      controller: _world.controller ? _world.controller.stats_() : null,
    },
    classPages: _world.classMats.census(),
  };
}

/** Test hook — drop the singleton between arms. */
export function _resetPoolWorldForTest() {
  if (_world) {
    try { _world.classMats.dispose(); } catch (_) { /* fail-soft */ }
  }
  _world = null;
  _initTried = false;
}

export { tileLbKeys, sectorKeyOfLb, getPoolRegistry };
