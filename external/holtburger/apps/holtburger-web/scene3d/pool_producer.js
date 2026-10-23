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
//
// THE CONTENT KEY IS THE GEOMETRY'S BYTES (`?poolRuns`, 2026-10-22, handoff F1)
// ---------------------------------------------------------------------------
// D-07.7 makes pool geometry dedup "default and EXACT-keyed" on the bake's
// content identity. This producer works from finished singleton meshes, and it
// keyed on `n.geometry.uuid` — an OBJECT identity. Both live geometry sources
// mint fresh objects per landblock bake (the runtime decode per LB, and
// `geom_bundles.js#assembleModels`, which builds new attributes per call;
// `?statGeomCache`, which would share them, is off), so the same model placed in
// two LBs of one sector became two pool geometries, and its ranges never
// repeated across LBs. Runs (pool_registry.js header) regroup REPEATED ranges
// only, so that key left them little to regroup [D]. The key is now a 64-bit
// hash (two avalanching 32-bit lanes, 2026-10-23 — see `_mix`) over exactly
// what `normalizeForPool` reads — position / normal / uv / acBakedLight (raw
// bytes + item size + normalized + array type) and the index — memoised per
// STREAM (a model's per-surface groups share their vertex streams, so its
// bytes are hashed once per model, not once per surface) and per geometry
// object, and every hit on a DIFFERENT object is BYTE-VERIFIED against the
// key's representative (a shared stream pair is compared once); a mismatch (a
// hash collision) takes the key's next chained slot and is counted
// (`producer.contentCollisions`). Equal bytes ⇒ an identical normalized pool
// geometry, so sharing it is exact by construction — the per-instance matrix
// carries the placement. It also shrinks pool vertex storage (one copy per
// content per pool, M6) and `geomByContent` now retains one representative per
// CONTENT instead of one per object.
// `?poolRuns=off` keeps the old object-identity key and leaves every pool
// unmarked. It is NOT HEAD's pooled world: the node-bounds upkeep, the band-swap
// `_visibilityChanged` raise, the per-tile plan list, the park-aware commit and
// the vacate wiring are unconditional fixes and stay on in both arms, so the
// =off arm isolates the F1 terms (marker + content keys) against THIS build
// and a reading of HEAD is not comparable to either arm.

import {
  initDrawPools, getPoolRegistry, drawPoolsActive, checkDrawPoolsPrereqs, poolRunsEnabled,
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
// ?poolRuns (2026-10-22, handoff F1): the registry takes the batchedRuns marker
// as a dependency (it keeps no renderer-side import); the producer is the one
// live constructor, so it is the one that hands it over. batched_runs.js is
// already in the boot graph (index.js installs it), so this adds no module.
import { markBatchedRuns } from "./batched_runs.js";

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
    // Opaque, draw-order-free pools draw their repeated ranges as instanced
    // runs (pool_registry.js header); `?poolRuns=off` makes this inert.
    markRuns: markBatchedRuns,
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
    /** Content-keyed dedup (header): true unless `?poolRuns=off`. */
    contentKeys: poolRunsEnabled(search),
    /** contentKey -> source geometry (the pool's dedup identity; with
     *  `contentKeys`, the content's REPRESENTATIVE). */
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
      heldOut: 0, heldOutNoRsId: 0, heldOutDupes: 0, heldOutRetired: 0,
      heldOutByReason: {}, reOfferedByReason: {},
      reOffered: 0, reOfferAdmitted: 0, reOfferStale: 0,
      reOfferRefused: {},
      // Content keys (header): geometry objects keyed, hits on a DIFFERENT
      // object that byte-verified (cross-LB sharing — expected > 0), distinct
      // colliding contents (hash collisions — must stay 0; each takes the
      // key's next chained slot).
      contentHashed: 0, contentShared: 0, contentCollisions: 0,
      // ...and the work under them: distinct STREAMS hashed (a model's streams
      // once, however many surface groups view them) and stream compares run.
      contentStreamsHashed: 0, contentStreamsVerified: 0,
      // Nodes of a plan the stream controller REFUSED because the grid had
      // vacated its tile: handed back as passthrough (2026-10-23).
      vacatedPassthrough: 0,
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
      // RSID-MARKER filed the `bc7Pending` class; T22-PRODUCER leg 8 adds
      // `offPage`. Both are refusals with a KNOWN future event — the BC7
      // verdict settling — after which the member's dims stop moving and it
      // can take a page layer. Everything else (needsResample, deformed,
      // layerFull) has no event and is not filed.
      if (admit.reason === REFUSE.BC7_PENDING || admit.reason === REFUSE.OFF_PAGE) {
        _holdOut(n, scene3d, opts, mat, admit.reason);
      }
      passthrough.push(n);
      continue;
    }
    n.updateMatrix();
    // The dedup identity (header): the geometry's CONTENT, byte-verified;
    // `?poolRuns=off` keeps the old object identity.
    let contentKey;
    if (w.contentKeys) {
      contentKey = _contentKeyFor(n.geometry, w);
    } else {
      contentKey = n.geometry.uuid;
      if (!w.geomByContent.has(contentKey)) w.geomByContent.set(contentKey, n.geometry);
    }
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
    if (!w.controller.onPlanReady(plan, geometrySource, { urgent: opts.urgent === true })) {
      // REFUSED — the grid emptied this tile while the LB was baking (2026-10-23
      // review). Every caller drops whatever it does not get back from the
      // legacy path, so a refused plan returned as "pooled" would vanish; it
      // comes back as passthrough instead and renders under the legacy LB
      // lifecycle, exactly as the pools-off arm renders a late bake.
      for (const p of placements) passthrough.push(p.__node);
      w.stats.vacatedPassthrough += placements.length;
      w.stats.passthrough += passthrough.length;
      return { passthrough, pooled: 0 };
    }
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
function _holdOut(node, scene3d, opts, mat, reason) {
  const rs = _rsIdOf(mat);
  if (!rs) { _world.stats.heldOutNoRsId += 1; return; }
  // DRAIN BY CONSTRUCTION (leg 8). The ledger is re-armed by the BC7 verdict
  // SETTLING (`upgradeMaterialToBc7` fires `atlasRefeed(rsId)` on landed,
  // absent AND failed — RSID-MARKER leg 1), so a refusal is only worth filing
  // while a settle is still coming. A member refused `offPage` DURING a
  // re-offer has just had its settle: its `map` is final, so its dims can
  // never stop differing from the declared page and no further event will
  // ever change the answer. Re-filing it would be a ledger entry that retains
  // a node for the session and never drains — the exact leak RSID-MARKER's D2
  // declined to create. It is RETIRED instead: it renders on the legacy
  // producer, once, and is counted.
  if (opts && opts.__poolReoffer === true && reason !== REFUSE.BC7_PENDING) {
    _world.stats.heldOutRetired += 1;
    return;
  }
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
  list.push({ node, scene3d, opts, reason });
  _world.stats.heldOut += 1;
  _world.stats.heldOutByReason[reason] = (_world.stats.heldOutByReason[reason] || 0) + 1;
}

// ---------------------------------------------------------------------------
// content identity (the header's "content key is the geometry's bytes")
// ---------------------------------------------------------------------------

/** The attributes `normalizeForPool` reads, in a fixed order. */
const _CONTENT_ATTRS = ["position", "normal", "uv", "acBakedLight"];
/** geometry object -> its content key (each object is keyed once). */
const _contentKeyOfGeom = new WeakMap();
/** STREAM (a vertex attribute or an index) -> its {a, b} lane hashes
 *  (2026-10-23 review). geom_bundles.js `_subsetsToGroups` hands every
 *  per-surface group of a model the SAME vertex stream objects, so keyed per
 *  geometry the model's position / normal / uv bytes were hashed once per
 *  SURFACE, synchronously, outside the W3 budget [M: node probe 2026-10-22,
 *  80 models × 1,500 verts × 4 surfaces = 84 ms for one LB's statics]. Per
 *  stream, a model's bytes are hashed once; a group adds only its index.
 *  Decoded streams are immutable — the per-object memo above assumes the same. */
const _streamHash = new WeakMap();
/** candidate stream -> the representative stream it byte-verified equal to,
 *  so the K groups of a cross-LB copy compare the shared streams ONCE. */
const _streamSameAs = new WeakMap();
const _ABSENT = Object.freeze({ a: 0x0a77e000, b: 0x000a77e0 });
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

/** Two independent 32-bit lanes per word — murmur3_32's block step and an
 *  xxhash32 round, each with its own constants — finished by fmix32. Both
 *  rotate before they multiply, so a difference in any bit reaches every bit.
 *  The plain FNV-1a lanes this replaced (2026-10-23 review) never moved a high
 *  bit down: equal deltas in two words — two sign flips, a mirrored model —
 *  cancelled in BOTH lanes, and the same high-byte delta in two words
 *  collided ~1 in 200 [M: review node probe, 10–14 of 2,000 trials; 0 now]. Byte verification kept every pixel
 *  right, but each collision read as `contentCollisions`. */
function _mix(h, w) {
  let k = Math.imul(w, 0xcc9e2d51);
  k = Math.imul((k << 15) | (k >>> 17), 0x1b873593);
  const a = h.a ^ k;
  h.a = (Math.imul((a << 13) | (a >>> 19), 5) + 0xe6546b64) | 0;
  const b = (h.b + Math.imul(w, 0x85ebca77)) | 0;
  h.b = Math.imul((b << 13) | (b >>> 19), 0x9e3779b1);
}

/** `_mix` over a run of words, lanes held in locals — the hot loop (every
 *  vertex stream goes through here); bit-identical to calling `_mix` per word. */
function _mixWords(h, words, n) {
  let a = h.a, b = h.b;
  for (let i = 0; i < n; i++) {
    const w = words[i];
    let k = Math.imul(w, 0xcc9e2d51);
    k = Math.imul((k << 15) | (k >>> 17), 0x1b873593);
    a ^= k;
    a = (Math.imul((a << 13) | (a >>> 19), 5) + 0xe6546b64) | 0;
    b = (b + Math.imul(w, 0x85ebca77)) | 0;
    b = Math.imul((b << 13) | (b >>> 19), 0x9e3779b1);
  }
  h.a = a;
  h.b = b;
}

/** murmur3's finaliser (full avalanche of one lane). */
function _fmix(x) {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

function _typeTag(arr) {
  const n = arr && arr.constructor ? arr.constructor.name : "";
  let t = 0;
  for (let i = 0; i < n.length; i++) t = (Math.imul(t, 31) + n.charCodeAt(i)) | 0;
  return t;
}

/** One stream's LOGICAL content hash: header + raw element bytes, 32-bit
 *  little-endian words (an interleaved attribute is read component by
 *  component). Memoised per stream object. */
function _streamHashOf(attr, stats) {
  if (!attr) return _ABSENT;
  const hit = _streamHash.get(attr);
  if (hit !== undefined) return hit;
  if (stats) stats.contentStreamsHashed += 1;
  const h = { a: 0x9747b28c, b: 0x165667b1 };
  _mix(h, attr.count | 0);
  _mix(h, attr.itemSize | 0);
  _mix(h, attr.normalized ? 1 : 0);
  if (attr.isInterleavedBufferAttribute) {
    _mix(h, 0x11);
    for (let i = 0; i < attr.count; i++) {
      for (let c = 0; c < attr.itemSize; c++) { _f32[0] = attr.getComponent(i, c); _mix(h, _u32[0]); }
    }
  } else {
    const arr = attr.array;
    _mix(h, _typeTag(arr));
    const off = arr.byteOffset | 0, len = arr.byteLength | 0;
    _mix(h, len);
    const nw = len >>> 2;
    const bytes = new Uint8Array(arr.buffer, off, len);
    if ((off & 3) === 0) {
      _mixWords(h, new Uint32Array(arr.buffer, off, nw), nw);
    } else {
      for (let i = 0, j = 0; i < nw; i++, j += 4) {
        _mix(h, bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24));
      }
    }
    if (len & 3) {
      let t = 0;
      for (let j = nw << 2, sh = 0; j < len; j++, sh += 8) t |= bytes[j] << sh;
      _mix(h, t);
    }
  }
  const s = { a: _fmix(h.a), b: _fmix(h.b) };
  _streamHash.set(attr, s);
  return s;
}

function _attrOf(g, name) {
  return (g.getAttribute ? g.getAttribute(name) : g.attributes && g.attributes[name]) || null;
}

/** 64-bit content hash of everything `normalizeForPool` reads: the stream
 *  hashes in a fixed order, then the index. */
function _hashGeometry(g, stats) {
  const h = { a: 0x811c9dc5 | 0, b: 0x84222325 | 0 };
  for (const name of _CONTENT_ATTRS) {
    const s = _streamHashOf(_attrOf(g, name), stats);
    _mix(h, s.a); _mix(h, s.b);
  }
  const si = _streamHashOf(g.index || null, stats);
  _mix(h, si.a); _mix(h, si.b);
  return `c${_fmix(h.a).toString(16).padStart(8, "0")}${_fmix(h.b).toString(16).padStart(8, "0")}`;
}

/** Exact equality of one stream's logical content; positive answers are
 *  memoised per (candidate, representative) pair. Aligned views compare as
 *  32-bit words. */
function _sameStream(a, b, stats) {
  if (!a || !b) return a === b;
  if (a === b || _streamSameAs.get(b) === a || _streamSameAs.get(a) === b) return true;
  if ((a.count | 0) !== (b.count | 0) || (a.itemSize | 0) !== (b.itemSize | 0) || !!a.normalized !== !!b.normalized) return false;
  if (stats) stats.contentStreamsVerified += 1;
  let eq = true;
  if (a.isInterleavedBufferAttribute || b.isInterleavedBufferAttribute) {
    for (let i = 0; eq && i < a.count; i++) {
      for (let c = 0; c < a.itemSize; c++) {
        if (!Object.is(a.getComponent(i, c), b.getComponent(i, c))) { eq = false; break; }
      }
    }
  } else {
    const x = a.array, y = b.array;
    if (!x || !y || x.constructor !== y.constructor || x.byteLength !== y.byteLength) return false;
    const len = x.byteLength;
    const xb = new Uint8Array(x.buffer, x.byteOffset, len);
    const yb = new Uint8Array(y.buffer, y.byteOffset, len);
    let j = 0;
    if (((x.byteOffset | y.byteOffset) & 3) === 0) {
      const nw = len >>> 2;
      const xw = new Uint32Array(x.buffer, x.byteOffset, nw);
      const yw = new Uint32Array(y.buffer, y.byteOffset, nw);
      for (let i = 0; i < nw; i++) if (xw[i] !== yw[i]) { eq = false; break; }
      j = nw << 2;
    }
    for (; eq && j < len; j++) if (xb[j] !== yb[j]) eq = false;
  }
  if (eq) _streamSameAs.set(b, a);
  return eq;
}

/** Byte-for-byte: will `normalizeForPool` produce the same geometry from both? */
function _sameContent(a, b, stats) {
  for (const name of _CONTENT_ATTRS) if (!_sameStream(_attrOf(a, name), _attrOf(b, name), stats)) return false;
  return _sameStream(a.index || null, b.index || null, stats);
}

/**
 * The pool content key of `g`, registering `g` as the key's representative on
 * first sight. Keyed once per object; a hit on a different object is verified
 * byte for byte. A verified MISMATCH (a 64-bit collision — expected never) is
 * counted once per colliding CONTENT and takes the key's next chained slot
 * (`<hash>~1`, `~2`, … each verified the same way), so colliding content still
 * shares across LBs — it used to take the object's own uuid, i.e. no sharing
 * for that content for the session (2026-10-23 review).
 */
function _contentKeyFor(g, w) {
  const cached = _contentKeyOfGeom.get(g);
  if (cached !== undefined && w.geomByContent.has(cached)) return cached;
  const base = _hashGeometry(g, w.stats);
  w.stats.contentHashed += 1;
  let key = base;
  for (let n = 1; ; n += 1) {
    const rep = w.geomByContent.get(key);
    if (rep === undefined) {
      w.geomByContent.set(key, g);
      if (n > 1) w.stats.contentCollisions += 1;
      break;
    }
    if (rep === g) break;
    if (_sameContent(rep, g, w.stats)) { w.stats.contentShared += 1; break; }
    key = `${base}~${n}`;
  }
  _contentKeyOfGeom.set(g, key);
  return key;
}

/** Test hooks — the content key machinery, standalone (`stats`, optional,
 *  counts `contentStreamsHashed` / `contentStreamsVerified`). */
const _testStats = (st) => (st && typeof st === "object" ? st : null); // `.map(hash)` passes an index
export const _poolContentForTest = {
  hash: (g, stats) => _hashGeometry(g, _testStats(stats)),
  same: (a, b, stats) => _sameContent(a, b, _testStats(stats)),
};

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
    // Any transition that (re)populates the slot lifts a vacate (2026-10-23):
    // this is the one hook EVERY re-admit passes through — teleport admits and
    // `readmitEmptyTiles` fire no onShift/onSeed.
    if (w.controller && (ev.to === "FETCHING" || ev.to === "STAGED" || ev.to === "LIVE")) {
      w.controller.onReadmit(ev.tile);
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
    // Admitted ⇒ no longer vacated, resident or not (`onAdmit` below runs only
    // for resident tiles or when something can post — never on the live arm).
    w.controller.onReadmit(t);
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
  // The tile left the grid's ownership (EMPTY, or a teleport vacated it), so
  // its plans still in flight go with it (2026-10-23 review). Without this the
  // controller's `onVacate` had no live caller: a plan still feeding when its
  // tile went EMPTY committed after the release, left the tile resident and
  // drawn with no grid owner, and a later re-bake merged into that ghost
  // record (props twice). Runs whether or not anything is resident — a STAGED
  // tile's first plans can all still be in flight. It purges, never enqueues.
  if (w.controller) w.controller.onVacate(tile);
  // LIVE-ARM FIX (2026-08-10): a teleport drives dozens of NEVER-RESIDENT tiles
  // to EMPTY (the first arm read 89 such transitions against 33 resident
  // tiles), and each one used to enqueue a W4 item that released nothing —
  // 89 scheduler items of pure bookkeeping. Only a tile the registry actually
  // holds is worth a release, and the counter now means what it says. A park
  // mark is all such a tile can hold; it goes now (no release will run).
  if (!w.registry.isTileResident(tile)) { w.registry.clearParked(tile); return; }
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
    if (!g) {
      // `__poolReoffer` marks this pass as the POST-SETTLE one, which is what
      // makes `_holdOut`'s retire rule (above) reachable.
      g = { scene3d: h.scene3d, opts: { ...h.opts, __poolReoffer: true }, nodes: [] };
      groups.set(k, g);
    }
    g.nodes.push(h.node);
    // Count the re-offer under the reason the member was FILED with, so
    // `offPage` and `bc7Pending` never share a row.
    w.stats.reOfferedByReason[h.reason] = (w.stats.reOfferedByReason[h.reason] || 0) + 1;
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
