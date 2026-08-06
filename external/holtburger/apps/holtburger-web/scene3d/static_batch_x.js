// scene3d/static_batch_x.js — ?statBatchChunk: spatially-chunked consolidation
// of the per-LB ?staticBatch BatchedMeshes (design v2, 2026-07-03).
//
// HISTORY: v1 (?statBatchCrossLb) consolidated per-(LB, surface) batches into
// ONE ring-spanning BatchedMesh per material. CLOSED-NEGATIVE on the 1070:
// ring-spanning nodes forfeit node-level frustum culling (the per-LB batches
// only draw the ~10% in view) and pay a per-frame CPU walk over ~36k instances
// to build multidraw ranges — moving A/B measured 22.5 vs ~29 fps. The fix
// that survives from v1: re-feed idempotence (re-bake REPLACES an LB's
// contribution) and the per-LB eviction hook machinery.
//
// v2: one BatchedMesh per (3x3-LB REGION, surface material). Chunks are
// spatially bounded, so frustumCulled=true works — off-screen regions cost
// zero draws AND zero per-instance range-building (three culls the node by
// its BatchedMesh-level boundingSphere before any instance work). In-frustum
// chunks still dedupe geometry cross-LB within the region and draw as one
// multidraw each. Bounds maintenance is lazy: membership changes null
// `bm.boundingSphere`; three recomputes it at the next cull
// (Frustum.intersectsObject: `if (object.boundingSphere === null)
// object.computeBoundingSphere()` — three.core.js r184 :25320).
//
// Eviction/growth/idempotence are v1 machinery unchanged: per-LB membership
// gid lists + deleteGeometry cascade via scene3d._evictStaticBatchXForLb
// (wired at LRU construction AND re-installed per feed), lazy optimize() off
// the ~10 Hz PVS tick, doubling growth, sources stay in the LB disposables.
//
// DEFAULT-ON (2026-07-03 1070 A/B: rest 24->66 fps / 1,057->223 calls; moving
// ~29->~47 fps). `?statBatchChunk=off` escapes to the per-LB legacy path.

import * as THREE from "three";

let _flag;
/** `?statBatchChunk=off` escapes region-chunked per-material consolidation of
 *  the ?staticBatch population. DEFAULT-ON (2026-07-03 1070 A/B: rest 24->66 fps
 *  / 1,057->223 calls; moving ~29->~47 fps / ~630->~270 calls). */
export function statBatchChunkEnabled() {
  if (_flag !== undefined) return _flag;
  let on = true; // DEFAULT-ON (2026-07-03, measured 2.7x rest / 1.7x moving); ?statBatchChunk=off escapes
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("statBatchChunk") || "").toLowerCase();
      if (v) on = !(v === "off" || v === "0" || v === "false" || v === "no");
    }
  } catch (_) { on = true; }
  _flag = on;
  return on;
}
// Test seams.
export function __setStatBatchChunkForTest(v) { _flag = v; }
export function __resetStatBatchXForTest() {
  _buckets.clear();
  _lbMembership.clear();
  _dirtyBuckets.clear();
  _bucketSeq = 0;
  _dedupStats.hits = 0;
  _dedupStats.adds = 0;
  _dedupStats.keyed = 0;
  _stats.bucketsCreated = 0;
  _stats.bucketsReaped = 0;
  _stats.gidProbeFailures = 0;
  _stats.deadMarked = 0;
  _stats.deadUnmarked = 0;
  _stats.deadShadowSkipped = 0;
  for (const k of Object.keys(_mergeStats)) _mergeStats[k] = 0;
  _warned.clear();
}

// ---------------------------------------------------------------------------
// ?statGeomDedup — CONTENT-KEY geometry dedup inside a chunk bucket (2026-08-01)
//
// THE BUG THIS FIXES. The feed loop below dedups geometry by BufferGeometry
// OBJECT IDENTITY, scoped to ONE feed (`gidOf`, ~:234). Within one LB feed all
// placements of a model DO share one object (`fetchPrimaryGeometries` decodes
// once per unique modelId and `buildSingletonNode` hands the same `g.geometry`
// to every placement — statics.js :756/:2114), so per-feed identity is enough
// there. But buckets are PERSISTENT and span a 3x3-LB region: the NEXT LB in
// the same region re-decodes the same tree/wall/rock into a FRESH
// BufferGeometry object, which the identity map cannot recognise, so its
// vertices are copied into the bucket AGAIN. Up to 9 copies of every shared
// model per region bucket, re-paid on every evict/re-approach cycle. The
// pinned-pose census (perf-synthesis §3, net-review/singleton-dedupe-probe.mjs)
// measured 17,774 batched instances over only 324 distinct geometries.
//
// THE KEY IS DECODE IDENTITY, NOT BYTES. A statics geometry is a pure function
// of (modelId, surfaceDid, doubleSided): `fetch_model_meshes` takes ONLY model
// ids (src/lib.rs :14331) and routes to the substitution-free
// `triangulate_model` (:8769), which is memoised by model_id in the shared
// MODEL_TRI_CACHE (:8813-8843) precisely BECAUSE it is deterministic against
// the immutable DAT; `pack_model_mesh` (:9229) assigns surface indices in
// insertion order, and `meshToGeometryGroups` (adapter.js :814) buckets tris by
// (surfaceIndex, sides) with no per-LB input. Statics never pass substitutions
// (those are character clothing/equipment) and never mutate a baked geometry.
// So the key carries (modelId, surfaceDid, doubleSided) PLUS vertex/index counts
// and a bounded FNV-1a fingerprint of the position buffer — the counts+
// fingerprint are what make a PARTIAL decode (`decodeMisses > 0`, accepted
// after STATICS_STARVED_RETRY_CAP) impossible to confuse with the complete one.
// A substituted or otherwise non-statics geometry simply carries no stamp and
// falls through to the legacy per-feed identity path.
//
// WHY IT IS BYTE-IDENTICAL UNDER THE FLAG. `BatchedMesh.addGeometry` COPIES the
// source attributes into the batch's own buffers (three r184
// BatchedMesh.js :694 → `setGeometryAt` :738-792) and returns an id; a draw is
// then (geometryId, per-instance matrix) via `addInstance` (:560-607), which
// allocates its OWN matrix slot and only STORES `geometryIndex`. Reusing an
// existing id for a placement therefore reads the same vertex bytes that a
// second `addGeometry` would have written, with that placement's own matrix
// untouched. Nothing about instance count, per-instance culling, or multiDraw
// range count changes — this is a memory/upload/bake-CPU win, NOT a draw-range
// win (the range-merge half stays gated on the §3 ceiling probe).
//
// EVICTION. Buckets are cross-LB, so a shared id must outlive the LB that
// first added it: entries are REFCOUNTED by lb-key, this LB's instances are
// removed individually with `deleteInstance` (:860), and `deleteGeometry`
// (whose documented side effect is deleting EVERY instance of the id, :834-844)
// only runs when the last referencing LB leaves. The map lives on the bucket
// (`userData.dedupGids`), so it can never outlive the BatchedMesh, and entries
// are removed at last-ref — bounded by the bucket's live geometry count.
//
// DEFAULT-OFF, exact-match opt-in (`?statGeomDedup=on`). Flag off = not one
// extra byte read on the feed path (no key is ever stamped, so `_contentKeyOf`
// short-circuits on an absent property) and eviction takes the identical
// legacy branch.
let _dedupFlag;
/** `?statGeomDedup=on` — content-key geometry dedup inside a chunk bucket.
 *  EXACT-match opt-in (url-flags.md header rule: never `!== "off"` for an
 *  opt-in). DEFAULT-OFF pending the 1070 re-base. */
export function statGeomDedupEnabled() {
  if (_dedupFlag !== undefined) return _dedupFlag;
  let on = false;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("statGeomDedup") || "").toLowerCase();
      on = v === "on";
    }
  } catch (_) { on = false; }
  _dedupFlag = on;
  return on;
}
// Test seam.
export function __setStatGeomDedupForTest(v) { _dedupFlag = v; }

const _dedupStats = { hits: 0, adds: 0, keyed: 0 };

// Unconditional lifecycle counters (not flag-gated, not debug-gated). The
// 2026-08-03 leak was a bucket population that only ever grew, which is exactly
// what `bucketsCreated` vs `bucketsReaped` makes visible. `gidProbeFailures`
// tracks the three-internals probe below.
const _stats = {
  bucketsCreated: 0,
  bucketsReaped: 0,
  gidProbeFailures: 0,
  // ?skipDeadBatch lifecycle: transitions, not a level. `deadUnmarked > 0` is
  // the interesting one — it means a bucket material stopped being provably
  // invisible after the bucket was built (the `_reseatSurfaceState` case), i.e.
  // proof that re-deriving on the tick is load-bearing and not paranoia.
  deadMarked: 0,
  deadUnmarked: 0,
  deadShadowSkipped: 0,
};

// ---------------------------------------------------------------------------
// ?statArrayMerge — ARRAY-TEXTURE MERGING of the region buckets (2026-08-06,
// DEFAULT-OFF, exact-match opt-in).
//
// THE MEASUREMENT. Buckets are keyed by the MATERIAL OBJECT, so every distinct
// surface in a region is its own BatchedMesh and its own draw. Merging them by
// (region, tile, state, format) collapses that at no fidelity cost.
//
// ⚠ SIZE CORRECTION (2026-08-06) — every earlier figure for this work, including
// docs/2026-08-06-statics-array-merge-design.md §0b's "127 drawn -> 54, +2.92 ms",
// counted a RESIDENT population, not a SUBMITTED one (`_projDrawn` tests
// `visible` + `instances > 0` and never the frustum, so "drawn" removed 4 buckets
// of 346). Re-measured with a real submitted-scale sampler
// (`__statMergeArmSubmitted`) on a settled Nanto session:
//
//     submitted BatchedMesh nodes: 128   (mergeable 60 + deformed 68)
//     MERGEABLE  60 -> regionStrict 35   = +1.00 ms   (image-preserving)
//     DEFORMED   68 -> regionStrict 43   = +1.00 ms
//     COMBINED  128 -> 78                = +2.00 ms
//
// **Do not quote 2.9 ms.** ~1.00 ms per half, and the DEFORMED half is the
// larger population (68 of 128) — it is admitted here, via the VFX set token in
// the pool key. See scene3d/static_array_pool.js's VFX-hook block.
//
// WHAT THIS MODULE DOES AND DOES NOT DO. It changes ONE thing: which bucket an
// already-batched material group lands in. The population split is untouched —
// `group.length < 2` still punts to the statAtlas seam, so the merged set is
// exactly the set measured above and the atlas is not starved. Geometry is still
// shared per MODEL (one addGeometry per distinct BufferGeometry, one addInstance
// per placement); routing this population through the atlas's per-NODE copier
// instead is the measured 89 ms / 4,576-draw wall and is not what happens here.
//
// THE ARRAY MACHINERY IS INJECTED, NEVER IMPORTED. This module is a deliberate
// THREE-only leaf (its headless test loads it by stripping the import lines
// outright, and `setDeadBatchPredicate` exists precisely so that stays true).
// The layer pools, the sampler2DArray material and the admission rules live in
// scene3d/static_array_pool.js and reach here as ONE injected provider object
// installed by statics.js. Never installed, or flag off ⇒ every branch below is
// dead and the feed path is byte-identical.
//
// THE TWO REFCOUNTS, AND WHY THEY ARE ONE RECORD. A pool is GLOBAL (region-
// scoped arrays measured 1,440.2 MB against 142.2 MB shared, 10.1x, on a page
// that OOMs near 2,800 MB), so a LAYER can outlive the landblock that first
// supplied it AND the region bucket that first indexed it. A GEOMETRY can be
// shared across landblocks (?statGeomDedup) and carries its layer index baked
// into a per-vertex `aLayer` attribute. If the layer were freed and recycled to
// another surface while a geometry still addressed it, that prop would render
// with another surface's pixels — the exact failure this design has to rule out.
//
// The rule that rules it out: **every membership record holds exactly one
// geometry reference and exactly one layer reference, taken together and
// released together.** A group takes ONE layer ref per feed and hands it to the
// FIRST membership record it produces; that record's eviction releases it in the
// same sweep that drops (or decrefs) the geometry. So while any geometry
// addressing layer L is live, at least one record holding a ref on L is live,
// and L cannot be recycled. Two independent refcounts would drift; one record
// cannot. If a group produces no record (every node failed), the ref is released
// on the spot.
//
// FAIL-SOFT EVERYWHERE. Admission rejection, layer-pool overflow, a failed layer
// write, a refused array allocation, an unexpected material shape — all fall
// through to today's per-material bucket. Nothing that cannot merge disappears.
// ---------------------------------------------------------------------------
let _arrayMerge = null;

/**
 * Install the array-merge provider (statics.js does this once at module load,
 * exactly as it installs `setDeadBatchPredicate`). The provider carries its OWN
 * flag gate, so `?statArrayMerge=off`/absent lands here as `admit()` returning
 * null rather than as a second gate in this module.
 */
export function setStatArrayMergeProvider(p) {
  _arrayMerge = (p && typeof p.admit === "function" && typeof p.acquire === "function") ? p : null;
}
/** Test seam. */
export function __getStatArrayMergeProviderForTest() { return _arrayMerge; }

// Merge census. `bucketsBefore`/`bucketsAfter` are derived live in
// `getStatBatchXStats` from each merged bucket's distinct SOURCE materials — the
// same before/after the 127 -> 54 projection reports, computed from the buckets
// that actually exist rather than from a model.
const _mergeStats = { mergedBuckets: 0, mergedReaped: 0, groupsMerged: 0, groupsLegacy: 0, layerRefsHeld: 0, layerRefsReleased: 0 };

// Geometry-level stamp read by `_contentKeyOf`.
// ---------------------------------------------------------------------------
// ?skipDeadBatch — hide a bucket whose material can never put a pixel on screen
// (2026-08-06). Measured at Nanto, quality `mid`: 4 buckets whose material is
// transparent / opacity-0 / NormalBlending / depthWrite-false, submitted every
// frame for nothing.
//
// ⚠ SIZE CORRECTION (2026-08-06): the task that commissioned this said those
// buckets held "~21,845 triangles". They hold **27**. The 21,845 was
// `position.count / 3` off a BatchedMesh — its ALLOCATED buffer, not its used
// extent (`_INIT_VERTS = 1 << 14`; 4 × 16384 / 3 = 21,845 exactly). Live
// `getStatBatchXStats().deadBatch.triangles` is the honest number. So this
// saves 4 draws and 27 triangles, which is below this workload's noise floor —
// it ships for correctness (a real decoder divergence left the permanence stamp
// missing) and not as a perf win. Never size a batch from its geometry
// attributes; ask the batch for its used extent.
//
// THE PREDICATE IS INJECTED, NOT IMPORTED. `materialRendersNothing` lives in
// materials.js (which pulls THREE + quality + suite_assets); this module is a
// deliberate THREE-only leaf and its headless test loads it by stripping the
// import lines outright. setup_rig.js already established the house answer —
// it takes `materialRendersNothing` as an ARGUMENT rather than importing it —
// so statics.js (which imports both) installs it here once at module load.
// Never installed ⇒ `_markDeadBatch` is a no-op and nothing is ever hidden.
let _rendersNothing = null;

/**
 * Install the shared invisible-material predicate. Expected to be handed
 * materials.js `materialRendersNothing` composed with `skipDeadBatchEnabled`
 * (statics.js does exactly that), so BOTH flags' escapes land here as a null
 * result from the predicate rather than as a second gate in this module.
 */
export function setDeadBatchPredicate(fn) {
  _rendersNothing = typeof fn === "function" ? fn : null;
}
/** Test seam. */
export function __getDeadBatchPredicateForTest() { return _rendersNothing; }

/**
 * Derive `visible` for one bucket from its material, and mark it so the
 * per-frame statics cull knows the hide was deliberate.
 *
 * WHY A MARKER AND NOT JUST `visible = false`. `cullStaticsGroup`
 * (statics.js) runs EVERY frame over `staticsGroup.children` and force-restores
 * `node.visible = true` for every BatchedMesh it finds — that line exists
 * because a bucket's origin-centred bounds made node-level culling hide the
 * whole batch (the 2026-07-02 vanished-forests bug). A bare `visible = false`
 * here would therefore survive exactly one frame. `userData.__deadBatch` makes
 * that pass the SINGLE per-frame writer of bucket visibility instead of a
 * competing one — the same "two writers of .visible is the bug" lesson the
 * particle/RP6 exemption in that function records.
 *
 * WHY EVERY MEMBER IS PROVABLY INVISIBLE. Buckets are keyed by the MATERIAL
 * OBJECT (`byMat` in the feed loop, `region.get(mat)` here) and that same
 * object is the BatchedMesh's `material`, which a BatchedMesh applies to EVERY
 * instance — so `m.material === bm.material` for every member by construction,
 * and a bucket cannot mix visible with invisible members. This is not a
 * property of the current population; it is what the bucket key IS.
 *
 * SHADOWS. The colour-pass argument (opacity 0 under NormalBlending composites
 * to dst exactly) says nothing about the depth-only shadow pass, which ignores
 * opacity entirely — hiding a shadow-casting bucket would change the image. In
 * practice `castShadow` is always false here (statics set it from
 * `materialCanCastShadow`, which rejects the Translucent bit that a
 * `__baseTranslucency >= 1` material must carry), so the guard is provably
 * free; it is counted rather than silent so a future regime where it starts
 * biting shows up in `getStatBatchXStats` instead of quietly costing the win.
 */
function _markDeadBatch(bm) {
  if (!_rendersNothing) return false;
  let dead = false;
  try {
    dead = _rendersNothing(bm.material) === true;
    if (dead && bm.castShadow) { dead = false; _stats.deadShadowSkipped += 1; }
  } catch (_) { dead = false; /* fail-soft: keep rendering */ }
  const was = bm.userData.__deadBatch === true;
  if (dead !== was) {
    bm.userData.__deadBatch = dead;
    bm.visible = !dead;
    if (dead) _stats.deadMarked += 1; else _stats.deadUnmarked += 1;
  }
  return dead;
}

const STAT_CONTENT_KEY = "__statContentKey";

// Float bit-pattern view for the fingerprint (avoids float→string formatting).
const _fpF32 = new Float32Array(1);
const _fpU32 = new Uint32Array(_fpF32.buffer);

/**
 * Bounded FNV-1a over the position buffer: <= 96 strided samples plus the
 * length, so the cost is O(1) per GEOMETRY (not per placement) regardless of
 * model size. This is the belt to the identity key's braces — it is what makes
 * a partial decode (fewer/other triangles for the same modelId) key
 * differently from the complete one.
 */
function _positionFingerprint(geom) {
  const pos = geom.attributes && geom.attributes.position;
  const a = pos && pos.array;
  if (!a || a.length === 0) return 0;
  const n = a.length;
  const stride = Math.max(1, (n / 96) | 0);
  let h = 0x811c9dc5;
  for (let i = 0; i < n; i += stride) {
    _fpF32[0] = a[i];
    h ^= _fpU32[0];
    h = Math.imul(h, 0x01000193);
  }
  h ^= n;
  h = Math.imul(h, 0x01000193);
  return h >>> 0;
}

/**
 * Stamp the content key on each `meshToGeometryGroups` output group of ONE
 * model. Called from statics.js `fetchPrimaryGeometries` (the single decode
 * seam both bakers share) where `modelId` is in scope and `doubleSided` has
 * not yet been dropped — the node's `userData` carries modelId + surfaceDid
 * but NOT `doubleSided`, and statics calls `materialCache.getCached(did)`
 * without the side argument, so two same-DID groups that differ ONLY in
 * sidedness land in the SAME bucket. Keying without `doubleSided` would fuse
 * them; this is the reason the stamp is made here and not derived downstream.
 *
 * No-op when the flag is off (nothing stamped ⇒ the feed path is untouched).
 * Returns the number of groups stamped (test/diag).
 */
export function stampStaticContentKeys(modelId, groups) {
  if (!statGeomDedupEnabled() || !groups) return 0;
  let stamped = 0;
  for (const g of groups) {
    const geom = g && g.geometry;
    if (!geom) continue;
    try {
      const pos = geom.attributes && geom.attributes.position;
      if (!pos) continue;
      const ud = geom.userData || (geom.userData = {});
      if (typeof ud[STAT_CONTENT_KEY] === "string") { stamped += 1; continue; }
      ud[STAT_CONTENT_KEY] =
        `${(modelId >>> 0).toString(16)}|${(g.surfaceDid >>> 0).toString(16)}` +
        `|${g.doubleSided ? 1 : 0}|${pos.count}|${geom.index ? geom.index.count : 0}` +
        `|${_positionFingerprint(geom).toString(16)}`;
      stamped += 1;
      _dedupStats.keyed += 1;
    } catch (_) { /* fail-soft: an unstamped geometry just takes the legacy path */ }
  }
  return stamped;
}

/** Read the stamp off a mesh's geometry; null ⇒ legacy per-feed identity. */
function _contentKeyOf(geom) {
  try {
    const k = geom && geom.userData && geom.userData[STAT_CONTENT_KEY];
    return typeof k === "string" ? k : null;
  } catch (_) { return null; }
}

/**
 * Is `gid` still a live geometry slot in this bucket? (stale-entry guard)
 *
 * ⚠ READS A THREE INTERNAL (`_geometryInfo`). If a three upgrade renames or
 * reshapes it this returns false for every live id, the caller treats every
 * dedup hit as stale, and `?statGeomDedup` silently becomes a no-op that copies
 * each geometry in again — the exact duplication the flag exists to remove,
 * while still reporting `enabled: true`. So the SHAPE probe is separated from
 * the answer and announced once: a degraded feature must say so.
 */
function _gidLive(bm, gid) {
  const info = bm._geometryInfo;
  if (!Array.isArray(info)) {
    _stats.gidProbeFailures += 1;
    _warnOnce(
      "statGeomDedup",
      "[static_batch_x] BatchedMesh._geometryInfo is not an array — this three " +
      "build does not expose the internal ?statGeomDedup relies on. Dedup is " +
      "INERT (geometry will be copied per landblock as if the flag were off).",
    );
    return false;
  }
  return !!info[gid] && info[gid].active !== false;
}

const _warned = new Set();
function _warnOnce(key, msg) {
  if (_warned.has(key)) return;
  _warned.add(key);
  // eslint-disable-next-line no-console
  console.warn(msg);
}

const _INIT_VERTS = 1 << 14;      // 16,384 (chunk-scale); grows via setGeometrySize on demand
const _INIT_INST = 256;           // chunk-scale; grows via setInstanceCount on demand
const _OPTIMIZE_FRAC = 0.30;      // compact a bucket once >30% of its used extent is dead
const _GROW_TRIES = 8;            // doubling attempts before a node falls through

// Lazy module state — only ever touched under ?statBatchCrossLb=on.
const _buckets = new Map();       // regionKey -> Map<material object, bucket { bm }>
const _lbMembership = new Map();  // lbKey -> Array<{ bm, gid }>
const _dirtyBuckets = new Set();  // buckets with freed geometry awaiting optimize()
let _bucketSeq = 0;

function _lbKeyOfId(id) {
  return (((id >>> 0) & 0xffff0000) >>> 0);
}

// 3x3-LB region key: spatial chunk this LB's statics batch into. 192 m * 3 =
// 576 m squares — big enough to dedupe cross-LB, small enough that node-level
// frustum culling keeps off-screen chunks at zero cost.
function _regionKeyOfId(id) {
  const rx = (((id >>> 24) & 0xff) / 3) | 0;
  const ry = (((id >>> 16) & 0xff) / 3) | 0;
  return `${rx}x${ry}`;
}

/**
 * `poolRef` (?statArrayMerge, else null) makes this a MERGED bucket: `mat` is
 * then the pool's ONE shared sampler2DArray material rather than a member's
 * material, and the region map keys on it exactly as it keys on any other
 * material object — two pools are two materials, and a pool material can never
 * collide with a member material. That is why merging needs no second bucket
 * map and no change to `_reapBucketIfEmpty`'s `ud.material` back-reference.
 *
 * Sharing ONE material across every region bucket of a class is better than
 * free: three sorts the opaque pass by `material.id`, so a class's region
 * buckets sort adjacent — and the frame-cost census measured 71% of draws
 * changing material against 79 distinct programs.
 */
function _getOrCreateBucket(mat, scene3d, templateNode, regionKey, poolRef) {
  let region = _buckets.get(regionKey);
  if (!region) { region = new Map(); _buckets.set(regionKey, region); }
  let b = region.get(mat);
  if (b) return b;
  const bm = new THREE.BatchedMesh(_INIT_INST, _INIT_VERTS, _INIT_VERTS * 2, mat);
  // OPAQUE: skip the per-frame instance depth sort (CPU win; statAtlas
  // precedent). Transparent buckets keep the sort for blend order.
  bm.sortObjects = !!mat.transparent;
  bm.perObjectFrustumCulled = true; // per-instance sphere cull trims the multidraw
  bm.frustumCulled = true;          // the chunk is spatially bounded — cull the whole
                                    // node by its lazy boundingSphere (v2 core win)
  // Uniform per-surface shadow flags — the per-LB batch already flattens these
  // per (LB, surface); this widens the same documented trade to per-surface.
  bm.castShadow = !!templateNode.castShadow;
  bm.receiveShadow = !!templateNode.receiveShadow;
  const surf = (templateNode.userData?.surfaceDid >>> 0) || 0;
  // NO userData.landblockId (the LRU statics scan must skip this ring-spanning
  // node) and NO __staticBatch (that marks the per-LB batches).
  bm.userData = {
    __staticBatchCrossLb: true,
    // ?statArrayMerge: this bucket's members are MANY surfaces sharing one array
    // texture, so `surfaceDid` below names only the template's — it is kept for
    // the name/census shape and must not be read as "the bucket's surface".
    __statArrayMerged: !!poolRef,
    surfaceDid: surf,
    maxVerts: _INIT_VERTS,
    maxInst: _INIT_INST,
    usedVerts: 0,        // used extent ever appended (delete does NOT compact;
                         //   only drops on optimize())
    deadVerts: 0,        // vertices in deleted geometries awaiting optimize()
    gidVerts: new Map(), // gid -> vertexCount (dead-space accounting on delete)
    instances: 0,        // live instance count (diag/census)
    // ?statGeomDedup only: contentKey -> { gid, refs:Set<lbKey> }. Created
    // lazily on first keyed feed and scoped to THIS bucket object, so it dies
    // with the BatchedMesh and can never key one bucket's ids into another.
    dedupGids: null,
    // ?statArrayMerge only. `pool` is the GLOBAL layer pool this bucket indexes
    // into (released back in `_reapBucketIfEmpty`); `mergedMats` is the set of
    // distinct SOURCE material objects that collapsed into it, i.e. the number
    // of buckets this one replaced — the live half of the 127 -> 54 headline.
    pool: poolRef ? poolRef.pool : null,
    mergedMats: poolRef ? new Set() : null,
  };
  bm.name = poolRef
    ? `static-batch-xa-r${regionKey}-p${String(poolRef.pool?.key ?? "").replace(/[^0-9a-zA-Z]+/g, "_").slice(0, 40)}-m${_bucketSeq++}`
    : `static-batch-c-r${regionKey}-s${surf.toString(16).padStart(8, "0")}-m${_bucketSeq++}`;
  // Back-references so an emptied bucket can find and remove itself (see
  // _reapBucketIfEmpty). Kept on userData rather than in a side map so they
  // cannot outlive the BatchedMesh.
  bm.userData.regionKey = regionKey;
  bm.userData.material = mat;
  b = { bm };
  region.set(mat, b);
  _stats.bucketsCreated += 1;
  if (poolRef) {
    _mergeStats.mergedBuckets += 1;
    // Register with the GLOBAL pool so it can tell when its last region bucket
    // has gone and its arrays + program are dead weight.
    try { _arrayMerge?.attachBucket(poolRef.pool, bm); } catch (_) { /* fail-soft */ }
  }
  // ?skipDeadBatch — derive visibility from the material now that castShadow is
  // set. Re-derived on the optimize tick below; see `_markDeadBatch`.
  _markDeadBatch(bm);
  try { scene3d?.staticsGroup?.add(bm); } catch (_) { /* fail-soft */ }
  return b;
}

/**
 * Drop a bucket that no longer holds any geometry.
 *
 * WHY THIS EXISTS (2026-08-03). Buckets are keyed by (3x3-LB region, material)
 * and were deliberately PERSISTENT — but nothing ever removed one, so a bucket
 * survived in `staticsGroup` with its full GPU allocation for the whole session
 * even after every landblock in its region had been evicted. Each bucket costs
 * `_INIT_VERTS` verts of position/normal/uv plus `_INIT_VERTS * 2` indices
 * (~0.65 MB before any growth) and its own matrix/indirect textures, and the
 * region key space is 86x86 — so a cross-Dereth roam ratcheted VRAM and
 * `staticsGroup.children` monotonically with regions VISITED rather than
 * regions RESIDENT. `?statBatchChunk` is default-ON, so this was the shipped
 * path.
 *
 * `gidVerts.size === 0` is the exact emptiness signal: entries are added by
 * `_addGeometryGrow` and removed when `deleteGeometry` actually runs (per
 * record on the legacy path, at last reference on the dedup path).
 *
 * The material is SHARED cross-LB (MaterialCache) and is never disposed here —
 * only the bucket's own geometry buffers and BatchedMesh-internal textures.
 */
function _reapBucketIfEmpty(bm) {
  const ud = bm.userData;
  if (!ud || ud.gidVerts.size > 0) return false;
  const region = _buckets.get(ud.regionKey);
  if (region) {
    region.delete(ud.material);
    if (region.size === 0) _buckets.delete(ud.regionKey);
  }
  _dirtyBuckets.delete(bm);
  try { bm.parent?.remove(bm); } catch (_) { /* fail-soft */ }
  // BatchedMesh.dispose() releases the matrix/indirect/colour textures; the
  // big vertex+index buffers live on its own geometry.
  try { bm.dispose(); } catch (_) { /* fail-soft */ }
  try { bm.geometry?.dispose(); } catch (_) { /* fail-soft */ }
  _stats.bucketsReaped += 1;
  // ?statArrayMerge — hand the GLOBAL pool back its bucket reference. The pool
  // disposes its arrays + shared material only when it has neither a live layer
  // NOR a live bucket, so a layer that outlives this region (the whole point of
  // a global pool) keeps it alive, and a pool nothing indexes any more does not
  // linger. Note the ORDER this relies on in `evictStaticBatchXForLb`: every
  // layer ref is released first, buckets are reaped after — so the last reap of
  // a departed class is what actually frees the arrays.
  if (ud.pool) {
    _mergeStats.mergedReaped += 1;
    try { _arrayMerge?.detachBucket(ud.pool, bm); } catch (_) { /* fail-soft */ }
  }
  return true;
}

// addGeometry with vertex+index headroom growth (delete never reclaims space;
// optimize() does, lazily). Throws only if _GROW_TRIES doublings still can't
// fit — the caller fail-softs the node to the passthrough list.
function _addGeometryGrow(bm, g) {
  const ud = bm.userData;
  const vcount = g.attributes.position.count;
  const icount = g.index ? g.index.count : 0;
  let tries = 0;
  while (bm.unusedVertexCount < vcount || (icount > 0 && bm.unusedIndexCount < icount)) {
    if (++tries > _GROW_TRIES) throw new Error("static_batch_x: geometry budget growth exhausted");
    const newMax = Math.max(ud.maxVerts * 2, ud.maxVerts + vcount + 4096);
    bm.setGeometrySize(newMax, newMax * 2);
    ud.maxVerts = newMax;
  }
  const gid = bm.addGeometry(g);
  ud.gidVerts.set(gid, vcount);
  ud.usedVerts += vcount;
  return gid;
}

/**
 * ?statArrayMerge — `_addGeometryGrow` with the surface's array LAYER stamped
 * into a per-vertex `aLayer` attribute, which is what the pool material's
 * injected `sampler2DArray` reads (`static_atlas.js makeArrayMaterial`).
 *
 * WHY PER-VERTEX IS COMPATIBLE WITH SHARING THE GEOMETRY ACROSS PLACEMENTS, and
 * why the atlas never learned this: a statics geometry is a pure function of
 * (modelId, surfaceDid, doubleSided) — precisely the `?statGeomDedup` content
 * key — so it carries exactly ONE surface, hence one texture, hence one layer.
 * Every placement of a geometry wants the same `aLayer`. The atlas's population
 * is singletons BY DEFINITION, so sharing was structurally impossible there;
 * here it is the whole point.
 *
 * WHY THE SOURCE GEOMETRY IS NOT CLONED. `BatchedMesh.addGeometry` COPIES the
 * source attributes into the batch's own buffers (three r184
 * `_initializeGeometry` :26076 defines the layout from the FIRST geometry,
 * `setGeometryAt` copies per attribute), so the attribute only has to exist for
 * the duration of the call. Cloning instead would be ~324 geometry copies per
 * region and would re-introduce exactly the per-node copying that makes the
 * atlas the weaker merger on volume. The attribute is removed immediately after
 * so the shared BufferGeometry is left byte-identical for every other consumer
 * (the legacy per-LB batch, the atlas's `normalizeForMerge`, a passthrough
 * render) — this mutation is synchronous and single-threaded, so no other reader
 * can observe it.
 */
function _addGeometryGrowLayered(bm, g, layer) {
  const prev = g.getAttribute("aLayer");
  const cnt = g.attributes.position.count;
  g.setAttribute("aLayer", new THREE.BufferAttribute(new Float32Array(cnt).fill(layer), 1));
  try {
    return _addGeometryGrow(bm, g);
  } finally {
    if (prev) g.setAttribute("aLayer", prev); else g.deleteAttribute("aLayer");
  }
}

// addInstance, growing the instance capacity on demand (atlas pattern).
function _addInstanceGrow(bm, gid) {
  const ud = bm.userData;
  try {
    return bm.addInstance(gid);
  } catch (_) {
    const newInst = ud.maxInst * 2;
    bm.setInstanceCount(newInst);
    ud.maxInst = newInst;
    return bm.addInstance(gid);
  }
}

/**
 * Cross-LB sibling of statics.js `consolidateStaticSingletons`: consume one
 * LB's plain-Mesh singleton groups (>=2 nodes sharing one material object)
 * into persistent per-material cross-LB BatchedMeshes; LOD wrappers, lone
 * singletons and any node that fails to fit fall through UNCHANGED in the
 * returned list (fail-soft — no vanished props; the statAtlas seam downstream
 * still sees them exactly as it would on the per-LB path).
 *
 * NEVER throws. Returns `{ out, bucketsTouched }`, or `null` when nothing was
 * consumed (grouping failed / no >=2 group fed) so the caller can run the
 * legacy per-LB consolidation with no double-render risk.
 */
export function consolidateStaticSingletonsCrossLb(nodes, scene3d, lbId) {
  try {
    const out = [];
    const byMat = new Map(); // material identity -> Mesh[] (same key as per-LB)
    for (const n of nodes) {
      // !isInstancedMesh (2026-07-15, ?walkInInstance): an InstancedMesh is
      // `isMesh === true`. Un-guarded, a walk-in instanced node would be
      // consumed here and re-added as a SINGLE instance (addGeometry once,
      // addInstance once, setMatrixAt(m.matrix) — the InstancedMesh's own
      // per-instance matrices are never read), silently deleting every
      // placement but one. This path had never seen an InstancedMesh before
      // that flag, which is exactly why the guard did not exist.
      if (n && n.isMesh && !n.isInstancedMesh && !n.isLOD && n.geometry && n.material && n.userData) {
        const key = n.material;
        let arr = byMat.get(key);
        if (!arr) { arr = []; byMat.set(key, arr); }
        arr.push(n);
      } else {
        out.push(n); // LOD wrappers / unexpected nodes — keep verbatim
      }
    }
    // Install the per-LB eviction hook (mirrors addSingletonsToCrossLbAtlas;
    // ALSO wired deterministically at LRU construction in index.js so an LB
    // can evict before its first feed with no orphan).
    if (scene3d && scene3d._evictStaticBatchXForLb !== evictStaticBatchXForLb) {
      scene3d._evictStaticBatchXForLb = evictStaticBatchXForLb;
    }
    const lbKey = _lbKeyOfId(lbId);
    const regionKey = _regionKeyOfId(lbId);
    const touched = new Set();
    // RE-FEED IDEMPOTENCE (2026-07-03 fix): a re-bake of an already-fed LB
    // (LOD/facade re-bakes; any path that re-runs bakeStaticsForLandblock
    // without an LRU evict) used to APPEND duplicate geometry+instances —
    // measured live at 41k instances vs ~8k placements within minutes (6 fps,
    // ~4k calls). Legacy per-LB batches are REPLACED by re-bakes (their nodes
    // carry userData.landblockId, so the re-bake cleanup scan removes them);
    // persistent cross-LB buckets are invisible to that scan, so replacement
    // must be explicit: excise this LB's previous contribution, then feed
    // fresh (same-frame, matches legacy replace semantics).
    if (_lbMembership.has(lbKey)) evictStaticBatchXForLb(lbKey);
    // Normal mode: a material appearing once in THIS LB feed (group.length < 2)
    // punts to the downstream statAtlas seam, which absorbs it by baking its
    // texture into a shared atlas (static_atlas.js ~389 needs mat.map.image.data).
    // Wireframe mode has NO such atlas — the shared MeshBasicMaterial buckets
    // carry no `.map`, so a punted loner survives as a plain Mesh AND gains a
    // wireFill companion: the ~4,100-draw / tripled-node pile-up that pins
    // wireframe at 4.5 fps (normal ~703 statics draws vs wireframe ~4,708).
    // Buckets here are PERSISTENT and cross-LB (keyed by region + material
    // object), and wireframe materials are SHARED cross-LB (per-DID
    // `didMaterials` / 32-bucket hash in materials._wireframeMaterialFor), so
    // consuming loners collapses ~121 LBs' worth of them into one BatchedMesh
    // per (region, material) — reusing the exact machinery that already batches
    // the >=2 groups in wireframe, and BatchedMesh loses its fill companion
    // automatically (addFillCompanions skips isBatchedMesh, materials.js ~2213).
    // Keep the punt untouched when wireframe is off (normal mode byte-identical).
    const wireframeMode = !!(scene3d && scene3d.wireframeMode);
    // ?statGeomDedup (default OFF) — read ONCE per feed, not per node.
    const dedupOn = statGeomDedupEnabled();
    let consumed = 0;
    let bucketsTouched = 0;
    for (const group of byMat.values()) {
      if (group.length < 2 && !wireframeMode) { out.push(...group); continue; } // lone → statAtlas seam (normal mode only)
      // ?statArrayMerge (default-OFF) — try to seat this whole group in a SHARED
      // array-texture bucket first. The population split above is untouched, so
      // the merged set is exactly the >=2 groups that are batched today.
      //
      // One layer reference is taken HERE, per group per feed, and is handed to
      // the first membership record the group produces (see below) — one
      // acquire, one release, released in the same eviction sweep that drops the
      // geometry whose `aLayer` addresses it.
      let poolRef = null;
      let bucket = null;
      if (_arrayMerge) {
        try {
          const handle = _arrayMerge.admit(group[0].material, group[0]);
          const ref = handle ? _arrayMerge.acquire(handle) : null;
          if (ref) {
            try {
              bucket = _getOrCreateBucket(ref.material, scene3d, group[0], regionKey, ref);
              poolRef = ref;
              _mergeStats.groupsMerged += 1;
              _mergeStats.layerRefsHeld += 1;
            } catch (_) {
              // Bucket creation failed — give the layer straight back, then take
              // today's per-material path below. Never leave a ref stranded.
              bucket = null;
              try { _arrayMerge.release(ref); _mergeStats.layerRefsReleased += 1; } catch (_2) {}
            }
          }
        } catch (_) { bucket = null; poolRef = null; /* fail-soft: legacy bucket */ }
      }
      if (!bucket) {
        try {
          bucket = _getOrCreateBucket(group[0].material, scene3d, group[0], regionKey, null);
          _mergeStats.groupsLegacy += 1;
        } catch (_) {
          out.push(...group); // bucket creation failed — whole group stays unbatched
          continue;
        }
      }
      const bm = bucket.bm;
      const ud = bm.userData;
      // >= 0 ⇒ merged: every geometry added below is stamped with this layer.
      const mergeLayer = poolRef ? poolRef.layer : -1;
      // The group's single layer ref, until a membership record takes ownership.
      let layerHeld = poolRef !== null;
      if (poolRef && ud.mergedMats) ud.mergedMats.add(group[0].material.id);
      // Within one feed all placements of a model share ONE BufferGeometry
      // object — add it once, instance it per placement.
      const gidOf = new Map(); // BufferGeometry -> gid (this feed only)
      // ?statGeomDedup: gid -> this LB's membership record in THIS bucket, so
      // the instance ids a shared geometry receives from THIS feed can be
      // evicted without touching another LB's instances of the same id.
      const recOf = dedupOn ? new Map() : null;
      let groupAdded = 0;
      for (const m of group) {
        try {
          m.updateMatrix();
          let gid = gidOf.get(m.geometry);
          let rec = null;
          if (gid === undefined) {
            // CONTENT-KEY LOOKUP (flag-gated). `shared` is the bucket-scoped
            // map; a hit reuses the id whose vertex bytes a second
            // addGeometry would have re-copied verbatim.
            const ckey = dedupOn ? _contentKeyOf(m.geometry) : null;
            let entry;
            if (ckey !== null) {
              const shared = ud.dedupGids || (ud.dedupGids = new Map());
              entry = shared.get(ckey);
              // Stale-entry guard: an id is removed from `shared` at last-ref
              // eviction, so this can only fire if some other path deleted it.
              if (entry !== undefined && !_gidLive(bm, entry.gid)) {
                shared.delete(ckey);
                entry = undefined;
              }
              if (entry !== undefined) {
                gid = entry.gid;
                _dedupStats.hits += 1;
              } else {
                gid = mergeLayer >= 0
                  ? _addGeometryGrowLayered(bm, m.geometry, mergeLayer)
                  : _addGeometryGrow(bm, m.geometry); // throws → catch → passthrough
                entry = { gid, refs: new Set() };
                shared.set(ckey, entry);
                _dedupStats.adds += 1;
              }
            } else {
              gid = mergeLayer >= 0
                ? _addGeometryGrowLayered(bm, m.geometry, mergeLayer)
                : _addGeometryGrow(bm, m.geometry); // throws → catch → passthrough
            }
            gidOf.set(m.geometry, gid);
            let list = _lbMembership.get(lbKey);
            if (!list) { list = []; _lbMembership.set(lbKey, list); }
            let pushed;
            if (entry !== undefined) {
              entry.refs.add(lbKey);
              rec = { bm, gid, key: ckey, entry, iids: [] };
              pushed = rec;
              recOf.set(gid, rec);
            } else {
              pushed = { bm, gid }; // legacy record: deleteGeometry cascades
            }
            // ?statArrayMerge — the ONE layer ref this group took rides on the
            // FIRST record it produces. That is what makes the two refcounts a
            // single record: this record's eviction releases the layer in the
            // same sweep that drops (dedup: decrefs) the geometry whose vertices
            // carry the layer index, so a layer can never be recycled to another
            // surface while a live geometry still addresses it.
            if (layerHeld) { pushed.poolRef = poolRef; layerHeld = false; }
            list.push(pushed);
          } else if (recOf) {
            rec = recOf.get(gid) || null;
          }
          const iid = _addInstanceGrow(bm, gid);
          // Track BEFORE setMatrixAt so a throw there can't orphan an instance
          // that the dedup eviction path would then never reclaim.
          if (rec) rec.iids.push(iid);
          bm.setMatrixAt(iid, m.matrix); // node is staticsGroup-relative, so is the bucket
          ud.instances += 1;
          groupAdded += 1;
        } catch (_) {
          // Geometry didn't fit this bucket's layout / budget — keep it as a
          // standalone Mesh so nothing goes invisible (fail-soft).
          out.push(m);
        }
      }
      // The group produced no membership record at all (every node threw before
      // its geometry landed), so nothing will ever release the layer ref — do it
      // here. A leaked ref would pin a layer for the session and, worse, keep a
      // recycled index out of circulation, so this is not merely tidy.
      if (layerHeld && poolRef) {
        try { _arrayMerge?.release(poolRef); _mergeStats.layerRefsReleased += 1; } catch (_) {}
        layerHeld = false;
      }
      if (groupAdded > 0) { consumed += groupAdded; bucketsTouched += 1; touched.add(bm); }
    }
    // ?statArrayMerge — ONE `needsUpdate` per touched array per feed (the atlas's
    // touchedDiff/touchedNra pattern). `addLayerUpdate` already marked the
    // individual layers, so this uploads those and not the whole array.
    if (_arrayMerge) { try { _arrayMerge.flush(); } catch (_) { /* fail-soft */ } }
    // Membership changed — invalidate node bounds; three recomputes at next cull.
    for (const bm of touched) bm.boundingSphere = null;
    if (consumed === 0) return null; // nothing landed — let the caller run the legacy path
    return { out, bucketsTouched };
  } catch (e) {
    // A throw before ANY consumption (grouping) is the only way here; after
    // consumption starts, all failure paths are per-node/per-group above.
    // eslint-disable-next-line no-console
    console.warn("[scene3d.statics/statBatchCrossLb] consolidation failed, falling back to per-LB batches:", String(e?.message ?? e));
    return null;
  }
}

/**
 * Per-LB eviction hook (installed as scene3d._evictStaticBatchXForLb; called
 * by landblock_lru.evict next to _evictStaticAtlasForLb). Excises every
 * geometry this LB contributed — deleteGeometry cascades the gid's instances
 * the same frame; other LBs' gids untouched. The bucket BatchedMesh itself is
 * never removed/disposed (it spans the ring). No-op for an unfed LB.
 */
export function evictStaticBatchXForLb(lbKey) {
  const key = _lbKeyOfId(lbKey);
  const list = _lbMembership.get(key);
  if (!list) return;
  // Buckets this eviction touched — checked for emptiness once at the end so a
  // multi-record LB does not re-scan the same bucket per record.
  const touched = new Set();
  for (const m of list) {
    const ud = m.bm.userData;
    // ?statArrayMerge — release the array LAYER reference this record carries,
    // BEFORE the branch below, so both the dedup and the legacy geometry path
    // drop it. This is the other half of "one record, both refcounts": the layer
    // and the geometry it is baked into are released in the same iteration, so
    // no ordering between them can leave a live geometry pointing at a recycled
    // layer. A record without `poolRef` is a legacy (unmerged) bucket member and
    // this is a no-op.
    if (m.poolRef) {
      try { _arrayMerge?.release(m.poolRef); _mergeStats.layerRefsReleased += 1; } catch (_) { /* fail-soft */ }
      m.poolRef = null;
    }
    // ?statGeomDedup record — the geometry id may be SHARED with other LBs in
    // this region, so `deleteGeometry` (which deletes every instance of the id,
    // three r184 BatchedMesh.js :834-844) is only safe at the last reference.
    // This LB's own instances go individually via `deleteInstance` (:860).
    if (m.entry) {
      let removed = 0;
      for (const iid of m.iids) {
        try { m.bm.deleteInstance(iid); removed += 1; } catch (_) { /* fail-soft */ }
      }
      if (removed > 0) ud.instances = Math.max(0, ud.instances - removed);
      m.entry.refs.delete(key);
      if (m.entry.refs.size === 0) {
        try { m.bm.deleteGeometry(m.gid); } catch (_) { /* fail-soft */ }
        try { if (ud.dedupGids) ud.dedupGids.delete(m.key); } catch (_) { /* fail-soft */ }
        const deadV = ud.gidVerts.get(m.gid);
        if (deadV) { ud.deadVerts += deadV; ud.gidVerts.delete(m.gid); }
      }
      m.bm.boundingSphere = null; // membership changed — lazy bounds recompute
      _dirtyBuckets.add(m.bm);
      touched.add(m.bm);
      continue;
    }
    let removedInstances = 0;
    try {
      // count the gid's live instances before the cascade (diag/census only)
      const info = m.bm._instanceInfo;
      if (Array.isArray(info)) {
        for (const inst of info) {
          if (inst && inst.active && inst.geometryIndex === m.gid) removedInstances += 1;
        }
      }
    } catch (_) { /* diag only */ }
    try { m.bm.deleteGeometry(m.gid); } catch (_) { /* fail-soft */ }
    const dead = ud.gidVerts.get(m.gid);
    if (dead) { ud.deadVerts += dead; ud.gidVerts.delete(m.gid); }
    if (removedInstances > 0) ud.instances = Math.max(0, ud.instances - removedInstances);
    m.bm.boundingSphere = null; // membership changed — lazy bounds recompute
    _dirtyBuckets.add(m.bm);
    touched.add(m.bm);
  }
  _lbMembership.delete(key);
  // A bucket whose last geometry just left is dead weight: it holds its whole
  // GPU allocation and a staticsGroup child for nothing. Reap it here rather
  // than on the optimize tick so the release is same-frame with the eviction
  // that caused it (and so it cannot be missed when the bucket never becomes
  // fragmented enough for optimize() to look at it).
  for (const bm of touched) _reapBucketIfEmpty(bm);
}

/**
 * Reclaim freed buffer space in fragmented buckets (deleteGeometry does NOT
 * free space — addGeometry appends; optimize() compacts, preserving gids).
 * Driven LAZILY from the ~10 Hz PVS tick (loop.js), never per-frame eviction.
 */
export function tickStatBatchXOptimize() {
  // ?skipDeadBatch — RE-DERIVE bucket visibility from the live material, every
  // tick, over every bucket (not just the dirty ones).
  //
  // A bucket's `material` reference is immutable (assigned once at construction;
  // nothing reassigns `bm.material`), so membership churn — feed, evict,
  // deleteGeometry, optimize(), growth realloc, reap+recreate — can never change
  // the answer: whatever the material renders, every member renders. What CAN
  // change is the material's own render state: `_reseatSurfaceState`
  // (materials.js, 2026-08-03) rewrites `transparent`/`opacity`/`depthWrite`/
  // `blending` AND re-spreads the base's userData onto a derived variant clone
  // when the real surface lands after a spawn-race fallback — and statics DO
  // hold those clones (staticBias / floorBias / frontSide). That runs in BOTH
  // directions, so a creation-time-only decision would either miss a bucket that
  // became invisible or, worse, keep one hidden that became visible. Re-deriving
  // converges either way within one PVS tick (~100 ms). Cost is the bucket count
  // (tens) x six property reads at ~10 Hz, and `_markDeadBatch` only writes on a
  // transition, so a settled scene does no work beyond the read.
  if (_rendersNothing) {
    for (const region of _buckets.values()) for (const { bm } of region.values()) _markDeadBatch(bm);
  }
  // ?statArrayMerge — the pool's own ~10 Hz pass. Its job is the state-DRIFT
  // detector: a pool material is minted once from the strict state key, so a
  // member reseated by `_reseatSurfaceState` after the fact is the one case
  // merging cannot track for free (today's bucket material IS a member
  // material). Counted, not silently fixed — see `tickStatArrayPool`.
  if (_arrayMerge) { try { _arrayMerge.tick(); } catch (_) { /* fail-soft */ } }
  if (_dirtyBuckets.size === 0) return;
  for (const bm of _dirtyBuckets) {
    const ud = bm.userData;
    if (ud.usedVerts > 0 && ud.deadVerts / ud.usedVerts > _OPTIMIZE_FRAC) {
      try { bm.optimize(); ud.usedVerts -= ud.deadVerts; ud.deadVerts = 0; bm.boundingSphere = null; } catch (_) { /* fail-soft */ }
    }
  }
  _dirtyBuckets.clear();
}

// Read-only live census for external probes (house style: window.__dumpWindRig).
if (typeof window !== "undefined") {
  window.__statBatchXStats = () => { try { return getStatBatchXStats(); } catch (_) { return null; } };
}

/**
 * Is this bucket actually SUBMITTED? Visibility up the parent chain plus a live
 * instance — the same signal `projectStatMergeBuckets` uses, and for the same
 * reason: frustum culling happens inside `render()` and a census runs between
 * frames, so `visible` + a nonzero instance count is the honest available proxy.
 * Cross-check any quoted collapse against `renderer.info.render.calls`.
 */
function _bucketDrawn(bm) {
  if ((bm.userData?.instances | 0) <= 0) return false;
  for (let o = bm; o; o = o.parent) if (o.visible === false) return false;
  return true;
}

/** Diag/census: per-bucket + total live instance/vert counts. */
export function getStatBatchXStats() {
  const buckets = [];
  let instances = 0;
  let deadBuckets = 0;
  let deadTris = 0;
  // ?statArrayMerge before/after. "Before" is what this population would have
  // occupied on today's (region, material OBJECT) key: a merged bucket stands in
  // for `mergedMats.size` of them, an unmerged bucket for itself. Reported over
  // BOTH populations because only the DRAWN one pays — the region-width sweep
  // measured 131 fewer RESIDENT buckets buying 14 fewer draws and 0.00 ms.
  let mergedBuckets = 0;
  let bucketsBefore = 0;
  let drawnBuckets = 0;
  let drawnBefore = 0;
  let drawnMerged = 0;
  for (const region of _buckets.values()) for (const { bm } of region.values()) {
    const ud = bm.userData;
    const before = ud.mergedMats ? Math.max(1, ud.mergedMats.size) : 1;
    bucketsBefore += before;
    if (ud.mergedMats) mergedBuckets += 1;
    if (_bucketDrawn(bm)) {
      drawnBuckets += 1;
      drawnBefore += before;
      if (ud.mergedMats) drawnMerged += 1;
    }
    // Triangles as verts/3: statics geometries are NON-indexed (adapter.js
    // `meshToGeometryGroups` emits flat position/normal/uv), so this is exact
    // for the population that actually reaches these buckets and an
    // over-estimate for anything indexed that ever does.
    if (ud.__deadBatch === true) { deadBuckets += 1; deadTris += (ud.usedVerts - ud.deadVerts) / 3; }
    buckets.push({
      name: bm.name,
      // ?skipDeadBatch — this bucket is provably invisible and is not submitted.
      dead: ud.__deadBatch === true,
      instances: ud.instances,
      usedVerts: ud.usedVerts,
      deadVerts: ud.deadVerts,
      maxVerts: ud.maxVerts,
      maxInst: ud.maxInst,
      // ?statGeomDedup: distinct content keys resident in this bucket. With the
      // flag off this is 0 and `gidVerts.size` is the copy count — the two
      // together ARE the duplication factor (`gidVerts.size / dedupGids`).
      dedupGids: ud.dedupGids ? ud.dedupGids.size : 0,
      gids: ud.gidVerts.size,
      // ?statArrayMerge: how many of today's (region, material) buckets this one
      // replaced. 0 ⇒ an ordinary per-material bucket.
      mergedMats: ud.mergedMats ? ud.mergedMats.size : 0,
    });
    instances += ud.instances;
  }
  return {
    buckets: buckets.length,
    instances,
    detail: buckets,
    lbsFed: _lbMembership.size,
    // THE number this flag exists to move. `drawn.before -> drawn.after` is the
    // live form of the 127 -> 54 projection; `all.*` is the resident population,
    // which the region sweep proved is decoupled from frame cost. `pool` carries
    // the layer/byte census (the §2b global-vs-regional memory argument) and
    // every spill reason — a spilled surface kept its own bucket, it never
    // vanished, so `after` already includes it.
    arrayMerge: {
      armed: _arrayMerge !== null,
      all: { before: bucketsBefore, after: buckets.length, merged: mergedBuckets },
      drawn: { before: drawnBefore, after: drawnBuckets, merged: drawnMerged },
      groupsMerged: _mergeStats.groupsMerged,
      groupsLegacy: _mergeStats.groupsLegacy,
      bucketsCreated: _mergeStats.mergedBuckets,
      bucketsReaped: _mergeStats.mergedReaped,
      // MUST converge: every acquire is released exactly once, by the membership
      // record that carries it. `held - released` is the count of layer refs
      // currently owned by live records; it must equal the number of merged
      // membership records and must return to 0 once every LB has evicted.
      layerRefsHeld: _mergeStats.layerRefsHeld,
      layerRefsReleased: _mergeStats.layerRefsReleased,
      pool: (() => { try { return _arrayMerge ? _arrayMerge.stats() : null; } catch (_) { return null; } })(),
    },
    // Bucket lifecycle. `bucketsCreated - bucketsReaped` MUST equal `buckets`;
    // a `buckets` count that only ever climbs on a long roam is the 2026-08-03
    // leak returning. High churn (reaped ~= created on a short walk) would mean
    // the 3x3 region granularity is thrashing and wants a hysteresis pass.
    bucketsCreated: _stats.bucketsCreated,
    bucketsReaped: _stats.bucketsReaped,
    // ?skipDeadBatch census. `armed: false` means statics.js never installed the
    // predicate (both escapes off, or a non-statics harness) — a 0 here then
    // means "not measured", never "nothing to hide".
    deadBatch: {
      armed: _rendersNothing !== null,
      buckets: deadBuckets,
      triangles: deadTris,
      marked: _stats.deadMarked,
      unmarked: _stats.deadUnmarked,
      shadowSkipped: _stats.deadShadowSkipped,
    },
    dedup: {
      enabled: statGeomDedupEnabled(),
      // geometry copies AVOIDED / geometry copies MADE, since page load.
      hits: _dedupStats.hits,
      adds: _dedupStats.adds,
      keyed: _dedupStats.keyed,
      // Non-zero ⇒ the three-internals probe `_gidLive` depends on is gone and
      // dedup is INERT despite `enabled` above. Never expect a silent 0-hit
      // run to mean "nothing to dedup".
      probeFailures: _stats.gidProbeFailures,
      degraded: _stats.gidProbeFailures > 0,
    },
  };
}
