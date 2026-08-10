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
import { registerAtlasRefeed, texRefPageInfo, materialRsId } from "./bc7_textures.js";
import { isBc7AtlasTexture } from "./static_atlas.js";
import { _atlasRefeedImpl as atlasSideRefeed } from "./static_atlas.js";

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
      texRefPageKeyed: 0, texRefBitClear: 0, texRefAbsent: 0, texRefDimsWillMove: 0,
      parks: 0, adopts: 0, releases: 0,
      refeedCalls: 0, refeedLayers: 0, refeedRehomed: 0, refeedAtlasSide: 0,
      // RSID-MARKER — the hold-out → re-offer ledger. `heldOut` is what the
      // refusal counters promised was recoverable; `reOffered` is what was
      // actually offered a second time; the two `reOffer*` outcomes account
      // for every one of them, per refusal reason. `heldOutNoRsId` is the
      // marker gap the stamp closes and MUST read 0 on a stamped build.
      heldOut: 0, heldOutNoRsId: 0, heldOutDupes: 0,
      reOffered: 0, reOfferAdmitted: 0, reOfferStale: 0,
      reOfferRefused: {},
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
      rec = _axisRecordFor(mat, domain, cast, recv, w.stats);
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

/**
 * Build the axis record, keyed on the TEXREF-DECLARED page dims whenever the
 * bake declares the member IS at its page (PAGE-RESAMPLE, `FULL_PAGE_DIMS`).
 *
 * WHY THIS EXISTS (the stitch the PAGE-RESAMPLE task left open, its Handoff
 * #2): without it the pooled arm keys on LIVE `material.map` dims, so a
 * page-dim dist buys the pools NOTHING — the whole point of the bake-side
 * resample is that class identity comes from the DECLARED dims and is
 * therefore stable across preview → full (pass-5 D-05.6.2, pass-7 D-07.9's
 * closed class set).
 *
 * THE BIT IS THE AUTHORITY, NEVER THE DIMS BYTE. `texRefPageInfo` decodes a
 * 4-bit-per-axis `ceil(log2)` pair, so a non-pow2 member (1096² is in the
 * shipped corpus) reads exactly like a real 2048² page; only the
 * `FULL_PAGE_DIMS` tier bit distinguishes them, so the declared dims are
 * trusted ONLY when `onPage` is true.
 *
 * THE BIT GATES THE WHOLE GATE (orchestrator ruling 2026-08-10, option (b),
 * after the ENVCELL-POOL arm read 1,852/1,852 members refused `offPage` and a
 * pooled world of ZERO). Leg 6 originally applied the DECLARED ≠ RESIDENT
 * refusal whichever way the bit read — but with the bit CLEAR the "declared"
 * dims it compared against are exactly the untrustworthy pre-resample TEXREF
 * values, and under `?texCompressedOnly` world materials are PREVIEW-born, so
 * essentially every member of a pre-page-dim dist differs from them. The
 * refusal therefore emptied the pooled world on today's dist. Now:
 *
 *   bit SET   ⇒ STRICT. Declared dims key the record, and DECLARED ≠ RESIDENT
 *               marks the member `texOffPage` so `admit()` refuses it: its
 *               dims WILL move when the full tier lands, and a page layer
 *               taken now would pin it to the wrong page for the session (the
 *               refeed would read a dims mismatch and it would keep its
 *               preview texels). Counted `texRefPageKeyed` / `texRefDimsWillMove`.
 *   bit CLEAR ⇒ PERMISSIVE, exactly the pre-leg-6 behaviour: live dims key the
 *               record (`texApprox`), nothing is refused on page grounds, and
 *               the existing `needsResample` gate decides. Counted
 *               `texRefBitClear`. The cost is D7's own: a member whose full
 *               tier later lands at different dims keeps its preview texels,
 *               which `classPages.layers.refeedDimMismatch` already counts.
 *
 * so today's dist pools exactly as the 51-pool Nanto arm measured, and the
 * page-dim dist gets the strict gate the resample exists to enable.
 *
 * ONE MORE REFINEMENT, kept from leg 6: the `f7|f8` format bit comes from the
 * LIVE texture (`isBc7AtlasTexture`), not asserted `true`. That axis must
 * match what the class PAGE actually allocates, or two members could share a
 * class key while needing different `texStorage3D` internal formats — the one
 * thing D-07.2 says a class must never do.
 */
function _axisRecordFor(mat, domain, cast, recv, stats) {
  const rsId = _rsIdOf(mat);
  const info = rsId ? texRefPageInfo(rsId) : null;
  const tex = mat && mat.map;
  if (!info) {
    stats.texRefAbsent += 1; // no TEXREF row ⇒ live dims, `texApprox: true`
    return axisRecordOf(mat, { domain, castShadow: cast, receiveShadow: recv });
  }
  if (!info.onPage) {
    // The bit is the authority and it says NO — so the declared dims are not
    // trusted for anything, neither to key with nor to compare against.
    stats.texRefBitClear += 1;
    return axisRecordOf(mat, { domain, castShadow: cast, receiveShadow: recv });
  }
  const rec = axisRecordOf(mat, {
    domain, castShadow: cast, receiveShadow: recv,
    texRef: { w: info.w, h: info.h, compressed: isBc7AtlasTexture(tex) },
  });
  stats.texRefPageKeyed += 1;
  const liveW = (tex && tex.image && tex.image.width) | 0;
  const liveH = (tex && tex.image && tex.image.height) | 0;
  if (liveW !== (info.w | 0) || liveH !== (info.h | 0)) {
    rec.texOffPage = true;
    stats.texRefDimsWillMove += 1;
  }
  return rec;
}

/** Test hook — the axis record exactly as the feed builds it. */
export function _poolAxisRecordForTest(mat, { domain = "st", castShadow = false, receiveShadow = false } = {}) {
  const stats = { texRefPageKeyed: 0, texRefBitClear: 0, texRefAbsent: 0, texRefDimsWillMove: 0 };
  return { rec: _axisRecordFor(mat, domain, castShadow, receiveShadow, stats), stats };
}

/** RSID-MARKER: ONE reader (`bc7_textures.js#materialRsId`) so the key a
 *  hold-out is filed under and the key `atlasRefeed(rsId)` arrives with cannot
 *  drift. Was an inline `__bc7RsId ?? __pvwRsId` read, which is 0 for exactly
 *  the state that gets a member refused (`__bc7Pending`) — the 363-hold-out
 *  class; `__texRsId` is the stamp that makes the read total. */
function _rsIdOf(mat) {
  return materialRsId(mat);
}

/** A member whose texture tier is still in flight is held out (its page dims
 *  would be the PREVIEW's, i.e. the wrong class) and re-offered when
 *  `atlasRefeed(rsId)` fires — the F-11.17 "nothing can stick" rule.
 *
 *  UNRECOVERABLE-BY-DESIGN is still COUNTED: a member with no rsId marker
 *  cannot be filed under any key, so it would sit on the legacy producer for
 *  the session. That population is `heldOutNoRsId`, and the whole point of the
 *  stamp is that it reads 0 — a nonzero value names a material class the
 *  texture lane builds without going through either stamp site. */
function _holdOut(node, scene3d, opts, mat) {
  const rs = _rsIdOf(mat);
  if (!rs) { _world.stats.heldOutNoRsId += 1; return; }
  // A held-out node is ALSO returned as passthrough and rendered by the legacy
  // producer, so the same node can be offered again on a later feed while its
  // verdict is still pending. Filing it twice would re-offer it twice, and the
  // second re-offer would add a SECOND pool instance for a node the first one
  // already pooled — a double-drawn prop. The mark is cleared when the
  // hold-out is consumed.
  const ud = (node.userData = node.userData || {});
  if (ud.__poolHeldRs === rs) { _world.stats.heldOutDupes += 1; return; }
  ud.__poolHeldRs = rs;
  let list = _world.holdouts.get(rs);
  if (!list) { list = []; _world.holdouts.set(rs, list); }
  list.push({ node, scene3d, opts });
  _world.stats.heldOut += 1;
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
  const canDispatch = typeof w.controller.dispatch.post === "function";
  for (const t of tiles || []) {
    if (w.registry.isTileResident(t)) {
      // PARKED → LIVE is a pointer re-adopt: no bake, no fetch, no decode.
      w.controller.onAdmit(t);
      continue;
    }
    // LIVE-ARM FIX (2026-08-10): with no `postBake` wired (the worker-side
    // record→axis ladder is T22's D1 remainder — the PRODUCERS feed today),
    // `BakeDispatchQueue.dispatch()` can never post, so recording admits just
    // grew the queue forever (the first arm ended at depth 36, posted 0).
    // Record only when there is something that can post.
    if (canDispatch) w.controller.onAdmit(t);
  }
}

function _releaseTile(tile) {
  const w = _world;
  // LIVE-ARM FIX (2026-08-10): a teleport drives dozens of NEVER-RESIDENT tiles
  // to EMPTY (the first arm read 89 such transitions against 33 resident
  // tiles), and each one used to enqueue a W4 item that released nothing —
  // 89 scheduler items of pure bookkeeping. Only a tile the registry actually
  // holds is worth a release, and the counter now means what it says.
  if (!w.registry.isTileResident(tile)) return;
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
  // LIVE-ARM FIX (2026-08-10): the pooled world REPLACED the atlas on this
  // seam, but the atlas still renders the pooled world's residue — the first
  // arm read refeedCalls=54 with the atlas half never running, i.e. every
  // atlas-committed preview node would have kept its preview texels for the
  // session. Chain, never displace: the atlas half runs first (it owns the
  // nodes it committed), the pool half second (it owns its class pages).
  let atlasSide = 0;
  try { atlasSide = atlasSideRefeed(rs) | 0; } catch (_) { /* fail-soft */ }
  w.stats.refeedAtlasSide += atlasSide;
  const layers = w.classMats.refeedRsId(rs);
  w.stats.refeedLayers += layers;
  const held = w.holdouts.get(rs);
  if (!held || held.length === 0) return layers + atlasSide;
  w.holdouts.delete(rs);
  let rehomed = 0;
  // Group by (scene3d, lbKey, domain) so each re-offer is one TilePlan.
  const groups = new Map();
  for (const h of held) {
    // STALE: both producer call sites parent every passthrough node the same
    // synchronous turn they take it back (statics.js:2653,
    // buildings.js:192), and a verdict can only resolve on a LATER turn — so
    // a parentless node here is one whose landblock was evicted while its
    // texture was in flight. Re-offering it would resurrect an evicted LB's
    // geometry into a pool no residency event owns. Dropped, and counted.
    if (!h.node || !h.node.parent) {
      _world.stats.reOfferStale += 1;
      if (h.node && h.node.userData) delete h.node.userData.__poolHeldRs;
      continue;
    }
    const k = `${(h.opts.lbKey >>> 0)}|${h.opts.domain || "st"}`;
    let g = groups.get(k);
    if (!g) { g = { scene3d: h.scene3d, opts: h.opts, nodes: [] }; groups.set(k, g); }
    g.nodes.push(h.node);
  }
  for (const g of groups.values()) {
    try {
      // RSID-MARKER: account for EVERY re-offered node. `refused` is read
      // before and after so each refusal lands under the reason the class
      // registry gave it — a re-offer that is refused AGAIN (still deformed,
      // dims moved anyway, page full) is not a silent no-op, it is a row.
      const before = { ...w.classMats.stats.refused };
      w.stats.reOffered += g.nodes.length;
      // Clear the hold-out mark BEFORE the re-offer, never after: a member can
      // be re-offered while STILL pending (one rsId's verdict can settle while
      // a member of the same rsId waits on the ST5 tier's own event), and it
      // must then be RE-FILED by `_holdOut` rather than silently dropped from
      // the ledger — that would strand it exactly the way the missing marker
      // did. "Nothing can stick" (F-11.17) means the loop re-arms itself.
      for (const n of g.nodes) { if (n.userData) delete n.userData.__poolHeldRs; }
      const { passthrough } = addSingletonsToPools(g.nodes, g.scene3d, g.opts);
      const after = w.classMats.stats.refused;
      for (const k of Object.keys(after)) {
        const d = (after[k] | 0) - (before[k] | 0);
        if (d > 0) w.stats.reOfferRefused[k] = (w.stats.reOfferRefused[k] || 0) + d;
      }
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
  w.stats.reOfferAdmitted += rehomed;
  w.stats.refeedRehomed += rehomed;
  return rehomed + layers + atlasSide;
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
