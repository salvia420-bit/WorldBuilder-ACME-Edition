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
  for (const k of Object.keys(_memoStats)) _memoStats[k] = 0;
  for (const k of Object.keys(_sphereStats)) _sphereStats[k] = 0;
  _camPose.camera = null;
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

// ---------------------------------------------------------------------------
// THE PER-INSTANCE WALK — ?statBatchNoSort and ?statBatchMemo (2026-08-06)
//
// THE MEASUREMENT THESE TWO ANSWER (docs/2026-08-06-frame-cost-structure-
// measured.md §5a). `BatchedMesh.onBeforeRender` costs 5.72 ms/frame over 197
// rendered buckets, and the regression against instance count says
// `t = 5.9 us/bucket + 0.348 us/instance`, r2 = 0.876 — **80% of it is
// PER-INSTANCE**. That is why every bucket-COUNT change measured ~0:
// `?statArrayMerge` removed 23 draws/frame for 0.0 ms, and a region-width sweep
// removed 131 of 376 buckets for 0.00 ms. Both removed the 20% fixed part.
// Nothing has ever attacked the instance axis. These two do, from opposite ends:
// one makes each walked instance cheaper, the other stops walking at all.
//
// WHAT THREE ACTUALLY DOES (three.core.js r184 :27214-27368 — read it before
// believing any summary, including this one). `onBeforeRender` is NOT
// unconditional; its first statement is
//
//     if ( ! this._visibilityChanged && ! this.perObjectFrustumCulled && ! this.sortObjects ) return;
//
// so three already skips the rebuild for a settled bucket — but ONLY when
// per-instance culling AND sorting are both off. We set
// `perObjectFrustumCulled = true` on every bucket (:480) and
// `sortObjects = !!mat.transparent` (:479), so that early-out is unreachable
// here, for every bucket, on every frame.
//
// THIS EXPLAINS THE 0.40 ms. The `perObjectFrustumCulled = false` A/B (§3d)
// saved only 0.40 ms of 5.72 and cost +420k triangles. If that had let three
// early-out, essentially the whole 5.72 ms would have gone. It did not, because
// the early-out ALSO requires `!sortObjects` — so the buckets that kept paying
// are the TRANSPARENT ones, and those are where the statics instance mass lives
// (ClipMap foliage/fences: `applyClipMapRenderState` sets `transparent = true`,
// §5b). ⚠ This is an inference from three's source plus that one A/B, not a
// direct measurement of the split. `getStatBatchXStats().walk` reports the
// sorted/unsorted bucket AND instance-slot split precisely so the next 1070
// session can confirm or kill it in one read.
//
// --- ?statBatchNoSort: make the walked instance cheaper -------------------
//
// For a `sortObjects` bucket three takes the OTHER branch (:27266-27327): the
// same per-instance matrix fetch, sphere transform and frustum test, PLUS a
// `_renderList.push` per survivor, PLUS `list.sort()` — an n log n JS sort with
// a function-call comparator — PLUS a second pass to write the multidraw
// arrays. That machinery is a large fraction of the 0.348 us.
//
// It buys nothing when the material's blend does not depend on draw order, and
// a bucket is ONE material by construction (`byMat` in the feed loop), so the
// question is answerable per bucket:
//   - `depthWrite === true` — the z-buffer resolves overlap, so ordering the
//     ranges cannot change the result. This is the ClipMap population, and it
//     is the SAME argument §5b/§5e made for moving those materials to the
//     opaque pass — but strictly weaker and therefore safer: the pass, the
//     blending and the material are all untouched here, only the order of
//     ranges INSIDE one bucket of one material changes.
//   - `AdditiveBlending` — addition commutes. `dst + a + b == dst + b + a`.
// Everything else (true Translucent: transparent, depthWrite false, alpha
// blend) keeps the sort. Off = `!!mat.transparent`, exactly as before.
//
// --- ?statBatchMemo: stop walking a bucket that cannot have changed --------
//
// The multidraw arrays are a pure function of (instance set, instance matrices,
// geometry ranges, camera, this.matrixWorld, material.wireframe). Between two
// frames in which none of those changed, three rebuilds an identical answer.
// `=on` remembers the inputs and skips the rebuild when they are bit-identical:
// OUTPUT-IDENTICAL, and it recovers the WHOLE 5.72 ms whenever the camera is
// still. Its honest limit is equally plain — a moving camera changes the view
// matrix every frame, so `=on` is worth ~0 while walking. Do not sell it as a
// movement win.
//
// `=slack:<m>:<deg>` is the movement half. It rebuilds through a frustum
// DILATED by `trans + rot * r` (r = distance from the camera to the instance,
// i.e. an angular dilation), which makes the cached answer a provable SUPERSET
// of the exact one for any camera that has since translated <= `trans` and
// rotated <= `rot`. Nothing visible can be dropped; a few extra ranges are
// drawn. That trade is only sane because §1 measured this frame CPU-bound —
// 8.2x fewer pixels changed nothing, and the +420k triangles of §3d cost ~0 ms
// — so over-inclusion is paid at the draw side's 0.038 us/instance (§5a) rather
// than on the GPU. Slack rebuilds use our own loop (a transcription of three's
// non-sorted branch with the margin added), so it applies to `sortObjects ===
// false` buckets only; sorted buckets fall back to the exact tier. Combining it
// with `?statBatchNoSort=on` is what makes that population the majority.
//
// PRICING, STATED AS A RANGE AND EXPECTED TO BE OPTIMISTIC. On the §5a model
// (13,195 instances in rendered buckets x 0.348 us + 197 x 5.9 us): a hit frame
// costs ~48 float compares per bucket, call it 0.02 ms total, and saves up to
// 5.7 ms. `=on` therefore projects ~5.7 ms at rest and ~0 moving. `=slack`
// projects `(1 - h) * 5.72 * (1 + over) + h * 0.2` for hit rate h and
// over-inclusion fraction `over`; at h = 0.5 / over = 0.3 that is ~2 ms saved,
// at h = 0.8 ~4 ms. h is NOT predictable from here — it depends on how the
// camera actually moves — which is why `walk.hits*` / `walk.rebuilds` are
// counted per call rather than modelled.
//
// BOTH DEFAULT-OFF, exact-match opt-in. Off = not one extra property read on
// any path: no override is installed, `sortObjects` keeps its old expression,
// and `getStatBatchXStats().walk` reports `mode: "off"` with the census only.
// ---------------------------------------------------------------------------
const _MEMO_TRANS_DEFAULT_M = 8;    // world metres of camera translation slack
const _MEMO_ROT_DEFAULT_DEG = 3;    // degrees of camera rotation slack

let _noSortFlag;
/** `?statBatchNoSort=on` — drop the per-bucket instance depth sort for buckets
 *  whose material's blend is order-independent. EXACT-match opt-in (url-flags.md
 *  header rule: never `!== "off"` for an opt-in). */
export function statBatchNoSortEnabled() {
  if (_noSortFlag !== undefined) return _noSortFlag;
  let on = false;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("statBatchNoSort") || "").toLowerCase();
      on = v === "on";
    }
  } catch (_) { on = false; }
  _noSortFlag = on;
  return on;
}
/** Test seam. */
export function __setStatBatchNoSortForTest(v) { _noSortFlag = v; }

let _memoMode;                                  // "off" | "exact" | "slack"
let _memoTransM = _MEMO_TRANS_DEFAULT_M;
let _memoRotRad = (_MEMO_ROT_DEFAULT_DEG * Math.PI) / 180;
/**
 * `?statBatchMemo` — DEFAULT "slack" since 2026-08-06. `=off` escapes;
 * `=on`/`=exact` selects the output-identical tier; `=slack[:<m>[:<deg>]]`
 * re-selects the default with custom margins.
 *
 * WHY DEFAULT-ON, AND WHY THE SLACK TIER (measured on the 1070, quality `mid`,
 * settled Nanto, control repeated between EVERY arm across six boots):
 *
 *   PARKED  off [22.3, 20.9, 23.2]   slack [17.8, 18.3, 19.9]
 *           delta 4.00 ms, control spread 2.30 ms  -> usable
 *
 * 4.00 ms of a ~23 ms frame, the largest single win of the 2026-08-06
 * investigation. `errors` 0 in every run, and rebuilds fall from ~65,000 to
 * ~4,100. The superset the slack tier draws costs `ktris` 409 -> 439 (+7.3%),
 * nowhere near the +81% that made `perObjectFrustumCulled = false`
 * unshippable — and §1 measured this frame CPU-bound, so vertex work is the
 * cheap side of the trade. No eye-test is owed: a dilated frustum can only
 * ADD instances outside the view, never drop one that is inside it.
 *
 * ⚠ WHAT IS NOT MEASURED, stated plainly because it is the risk. The MOVING
 * case is unresolved. The rig that produced the parked numbers spun the camera
 * at ~54 deg/s, which makes every run stream and frustum-cull a different
 * amount, so the moving control alone ranged 27.0-33.6 ms — wider than the
 * effect, and the harness's own gate called it NOT USABLE. The only moving
 * evidence in hand is the EXACT tier's consistent **+0.5 ms regression**.
 * Slack exists precisely to cover camera motion (its cached answer stays a
 * provable superset while the camera translates <= `transM` / rotates <=
 * `rotDeg`), so it should behave better than exact there — but "should" is not
 * a measurement. If a moving regression is ever observed, `?statBatchMemo=off`
 * is the one-flag revert and this default should come back off.
 */
export function statBatchMemoMode() {
  if (_memoMode !== undefined) return _memoMode;
  let mode = "slack"; // DEFAULT-ON (2026-08-06, -4.00 ms parked); ?statBatchMemo=off escapes
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const raw = (new URLSearchParams(globalThis.location.search).get("statBatchMemo") || "").toLowerCase();
      if (raw) {
        const parts = raw.split(":");
        if (parts[0] === "off" || parts[0] === "0" || parts[0] === "false" || parts[0] === "no") mode = "off";
        else if (parts[0] === "on" || parts[0] === "exact") mode = "exact";
        else if (parts[0] === "slack") {
          mode = "slack";
          const t = Number(parts[1]);
          if (Number.isFinite(t) && t >= 0 && t <= 500) _memoTransM = t;
          const r = Number(parts[2]);
          if (Number.isFinite(r) && r >= 0 && r <= 45) _memoRotRad = (r * Math.PI) / 180;
        }
        // anything else: keep the default rather than silently disabling —
        // a typo must not cost 4 ms without saying so.
      }
    }
  } catch (_) { mode = "slack"; }
  _memoMode = mode;
  return mode;
}
// ---------------------------------------------------------------------------
// ?statBatchSphere — CACHE THE PER-INSTANCE BOUNDING SPHERE (2026-08-06)
//
// THE MEASUREMENT. `docs/2026-08-06-object-glue-census.md`. The 3.42 ms of
// `sceneSubmit` that is not the draw funnel is NOT per-object glue: three's own
// glue for a submitted object (`layers.test` + `onBeforeRender` + `modelView
// Matrix.multiplyMatrices` + `normalMatrix.getNormalMatrix` + `material.on
// BeforeRender` + `onAfterRender`, three.module.js r184 :18046-18085) benches at
// **70.7 ns**, so all ~470 submitted objects together are **0.03 ms**. The block
// is `BatchedMesh.prototype.onBeforeRender` — a PER-INSTANCE population of
// ~13,000, not a per-object one of 470 — which lands inside `sceneSubmit`
// because three calls it from `renderObject`. Pricing it per submitted object
// was a scale error of the same family as `_projDrawn`.
//
// WHAT THE LOOP ACTUALLY SPENDS. Per instance three does (three.core.js
// :27331-27360) `getMatrixAt(i, m)` — 16 reads out of the matrices TEXTURE plus
// a Matrix4 write — then `getBoundingSphereAt(gid, s).applyMatrix4(m)`, whose
// `Sphere.applyMatrix4` calls `Matrix4.getMaxScaleOnAxis` (3 squared lengths and
// a `Math.sqrt`), and only then the 6 plane dots that are the actual question.
// **The sphere is recomputed every frame from inputs that never change.** A
// static placement's local-frame world sphere is a pure function of its instance
// matrix and its geometry's bounds; the camera enters only through the frustum,
// which three already composes ONCE per bucket per call (:27251-27262) in the
// mesh's local frame. So the per-instance work is cacheable in full.
//
// MEASURED, against the real r0.184.0 build, node 22, this laptop
// (`docs/2026-08-06-object-glue-census.md` §3 — the bench is in the doc):
//
//   three's unsorted branch          93-122 ns/instance
//   the same answer from a cache      15-19 ns/instance
//   => 5-7x, with the survivor sets and multidraw arrays BYTE-IDENTICAL
//
// Applied to the ~3.3 ms this block costs at Nanto that projects **~2.4-2.8 ms**,
// and — the part that matters — it holds WHILE THE CAMERA MOVES. `?statBatchMemo`
// is worth ~2-3 ms parked and **+0.5 ms WORSE moving**, because a moving camera
// invalidates it every frame; this cache is invalidated by PLACEMENT changes,
// which a moving camera does not cause. The two are complementary and compose:
// with both on, a memo miss rebuilds through the cache instead of three's loop.
//
// EXPECT THIS TO COME BACK SMALLER THAN 2.4 ms. Five estimates on this workload
// have collapsed by 2x or more under measurement. The two named reasons here:
// only `sortObjects === false` buckets are eligible (three's sorted branch needs
// its module-private `_renderList`, and `?statBatchNoSort=on` is what widens that
// population), and the node bench does not reproduce the cache-miss behaviour of
// ~200 live buckets. `getStatBatchXStats().walk.sphere` reports the eligible and
// skipped populations so the projection can be evaluated rather than believed.
//
// WHY IT IS SAFE. The cache is keyed on the SAME epoch `?statBatchMemo` uses —
// bumped by every membership change and by the feed's `setMatrixAt`, which three
// does NOT flag via `_visibilityChanged` (see `_memoInvalidate`). Values are
// `Float64Array` and computed by exactly three's own expression, so a cached
// sphere is bit-identical to the one three would have computed, not an
// approximation: `test_stat_batch_walk.mjs` §7 asserts the multidraw arrays match
// three's byte for byte across a rebuild, an invalidation and a growth. Every
// failure path falls back to `BatchedMesh.prototype.onBeforeRender` untouched.
//
// `=verify` recomputes each sphere the slow way and compares, counting
// `sphere.verifyFails`. It is a diagnostic tier and is SLOWER than off.
//
// DOES THE MOTION CLAIM ACTUALLY HOLD? (audited 2026-08-06, second pass)
// ---------------------------------------------------------------------
// The claim above — "invalidated by PLACEMENT changes, which a moving camera
// does not cause" — was checked against the code and by test rather than taken
// on report. Three findings, in descending order of how much they matter.
//
// 1. THE KEY IS CLEAN. `_sphereCacheEnsure` keys on `(st.epoch, _instanceInfo
//    .length)` and nothing else. `st.epoch` moves only through
//    `_memoInvalidate`, whose four callers are the cross-LB feed (:1794), the
//    per-LB evict (:1850/:1869), `optimize()` (:1929) and a `sortObjects` flip
//    (`_reseatBucketSort`). Not one of them reads a camera. The cached spheres
//    live in the MESH'S LOCAL FRAME, so they are additionally valid for ANY
//    camera — where `?statBatchMemo`'s single state slot thrashes between the
//    shadow cascade and the colour pass (see `_memoOnBeforeRender`'s note),
//    this cache serves both from one build. §17 pins that.
//
// 2. IT WAS INERT IN THE SHIPPED CONFIGURATION. See the long note at the
//    `_trySphereBuild` call inside `_memoOnBeforeRender`'s slack branch: with
//    `?statBatchMemo` defaulting to "slack", `?statBatchSphere=on` did zero
//    work until that fix. A motion claim cannot hold for a flag that never ran.
//
// 3. IT DEGRADES UNDER STREAMING, AND THE SCALE IS THE POINT. A rebuild is
//    O(`_instanceInfo.length`) — the WHOLE bucket — while an invalidation is
//    caused by as little as ONE landblock's feed. Buckets are region-scoped and
//    span many LBs, so a 1-LB feed into a 13,000-slot bucket costs a
//    13,000-slot rebuild, not a 200-slot one. That is the honest limit of the
//    "moving is fine" claim: camera motion does not invalidate, but the
//    STREAMING that accompanies camera motion does, and it invalidates at
//    bucket granularity. Break-even is roughly one rebuild per walk (a rebuild
//    costs about what three's own loop costs), so the flag PAYS when the epoch
//    is stable for more than ~1 frame and LOSES while a bucket is fed every
//    frame. `sphere.slotsWalked / sphere.slotsBuilt` is that ratio; read it
//    before quoting any ms figure, and use `harness/moving-bench.mjs`
//    `--mode=hop` (which streams on purpose) rather than an orbit to provoke
//    the bad case.
// ---------------------------------------------------------------------------
let _sphereMode;
/** `?statBatchSphere=on` (cache) or `=verify` (cache + per-instance recompute
 *  and compare). Anything else, including absent, reads "off". */
export function statBatchSphereMode() {
  if (_sphereMode !== undefined) return _sphereMode;
  let mode = "off";
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("statBatchSphere") || "").toLowerCase();
      if (v === "on") mode = "on";
      else if (v === "verify") mode = "verify";
    }
  } catch (_) { mode = "off"; }
  _sphereMode = mode;
  return mode;
}
/** Test seam. */
export function __setStatBatchSphereForTest(mode) { _sphereMode = mode; }

const _sphereStats = {
  calls: 0,          // onBeforeRender invocations that reached the cached path
                     // — SPHERE-ONLY override. 0 under `?statBatchMemo` != off,
                     // where the memo owns the seam; use `walks` for the rate.
  walks: 0,          // cached walks actually served, on ANY path (sphere-only
                     // override AND the memo's rebuilds). `slotsWalked/slotsBuilt`
                     // is the payback ratio; below ~1 the epoch is moving faster
                     // than the cache can pay for itself and the flag is a LOSS.
  builds: 0,         // full cache (re)builds — one per bucket per epoch
  slotsBuilt: 0,     // instance slots written by those builds (cumulative)
  slotsWalked: 0,    // instance slots read from the cache (cumulative)
  ineligible: 0,     // sorted / array-camera / malformed ⇒ three's own loop
  errors: 0,         // fail-soft fallbacks to three's own loop
  lateActivations: 0,// slots live at walk time but sentinel at build time —
                     // MUST stay 0; nonzero is a missing invalidation site
  verifyChecked: 0,  // =verify only
  verifyFails: 0,    // =verify only — MUST stay 0; nonzero is an image bug
  installed: 0,
  bytes: 0,          // live cache bytes across all buckets
};

/** Test seam. `slacks` = { transM, rotDeg } (optional). */
export function __setStatBatchMemoForTest(mode, slacks) {
  _memoMode = mode;
  if (slacks && Number.isFinite(slacks.transM)) _memoTransM = slacks.transM;
  if (slacks && Number.isFinite(slacks.rotDeg)) _memoRotRad = (slacks.rotDeg * Math.PI) / 180;
}

const _memoStats = {
  calls: 0,          // onBeforeRender invocations on memo-installed buckets
  hitsExact: 0,      // reuse under bit-identical camera + state
  hitsSlack: 0,      // reuse under the dilated-frustum validity region
  rebuilds: 0,       // full walks, three's loop
  rebuildsSlack: 0,  // full walks, OUR loop (dilated, or ?statBatchSphere's
                     // zero-margin cached build — both are `_memoBuildSlack`'s
                     // arithmetic, and zero margins are a legal degenerate)
  instancesWalked: 0,   // instance SLOTS visited by a rebuild (cumulative)
  instancesSkipped: 0,  // instance SLOTS a hit did not visit (cumulative)
  errors: 0,         // fail-soft fallbacks to three's own path
  installed: 0,
};

/**
 * Does this bucket's material make the intra-bucket depth sort load-bearing?
 *
 * `?statBatchNoSort` off ⇒ `!!mat.transparent`, byte-identical to the
 * expression this replaced. On ⇒ the two provable exemptions above.
 */
function _shouldSortBucket(mat) {
  if (!mat || !mat.transparent) return false;
  if (!statBatchNoSortEnabled()) return true;
  try {
    // Addition commutes — an additive bucket composites to the same pixel in
    // any order (this is the same reason `materialRendersNothing` must EXCLUDE
    // additive: the blend function, not the flag, is the predicate).
    if (mat.blending === THREE.AdditiveBlending) return false;
    // A depth-writing alpha-MASK (ClipMap: alphaTest 0.784, opacity 1) is
    // resolved by the z-buffer, so range order cannot change the image.
    if (mat.depthWrite === true) return false;
  } catch (_) { return true; /* fail-soft: keep the sort */ }
  return true;
}

/**
 * Re-derive `sortObjects` from the live material. Same lifecycle argument as
 * `_markDeadBatch`: `bm.material` never changes, but `_reseatSurfaceState`
 * (materials.js) rewrites `transparent`/`depthWrite`/`blending` in BOTH
 * directions when a real surface lands after a spawn-race fallback, so a
 * creation-time-only decision can go stale either way. Writes only on a
 * transition, and invalidates the memo when it flips (the cached arrays were
 * built by the other branch).
 */
function _reseatBucketSort(bm) {
  const want = _shouldSortBucket(bm.material);
  if (bm.sortObjects !== want) {
    bm.sortObjects = want;
    _memoInvalidate(bm);
    return true;
  }
  return false;
}

// Scratch — module-level, never re-entrant (three calls onBeforeRender
// synchronously from the render loop, single-threaded).
const _memoM = new THREE.Matrix4();
const _memoInstM = new THREE.Matrix4();
const _memoFrustum = new THREE.Frustum();
const _memoSphere = new THREE.Sphere();
const _memoCamLocal = new THREE.Vector3();
const _memoPos = new THREE.Vector3();
const _memoQuat = new THREE.Quaternion();
const _memoScale = new THREE.Vector3();

// ONE camera decompose per frame, not one per bucket: 197 buckets share a
// camera, and `Matrix4.decompose` is not free. Keyed on the camera object plus
// the raw elements of its matrixWorld, so it is correct across any number of
// cameras (main pass, shadow cascades) at the cost of one 16-float compare.
const _camPose = { camera: null, el: new Float64Array(16), pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
function _cameraPose(camera) {
  const e = camera.matrixWorld.elements;
  if (_camPose.camera !== camera || !_elemsEqual(_camPose.el, e)) {
    _camPose.camera = camera;
    for (let i = 0; i < 16; i++) _camPose.el[i] = e[i];
    camera.matrixWorld.decompose(_camPose.pos, _camPose.quat, _memoScale);
  }
  return _camPose;
}

function _elemsEqual(a, b) {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}
function _elemsCopy(dst, src) {
  for (let i = 0; i < 16; i++) dst[i] = src[i];
}

function _memoStateFor() {
  return {
    valid: false,
    epoch: 0,        // bumped by every membership/matrix change (see _memoInvalidate)
    builtEpoch: -1,
    camera: null,
    material: null,
    camMw: new Float64Array(16),   // camera.matrixWorld at build (exact tier)
    proj: new Float64Array(16),    // camera.projectionMatrix at build
    mw: new Float64Array(16),      // this.matrixWorld at build
    camPos: new THREE.Vector3(),   // decomposed, for the slack validity region
    camQuat: new THREE.Quaternion(),
    sortObjects: null,
    pOFC: null,
    wireframe: null,
    idxBytes: -1,
    slackTrans: 0,   // world metres of translation the cached answer tolerates
    slackDotMin: 2,  // cos(rot/2); 2 = "no rotation tolerated" (|dot| <= 1)
    walked: 0,
    drawn: 0,
  };
}

/**
 * Membership / matrix / state change ⇒ the cached multidraw is stale.
 *
 * Called from every site that already nulls `boundingSphere` (those ARE the
 * membership-change sites) plus `optimize()` and a `sortObjects` flip. three's
 * own `_visibilityChanged` covers add/delete/optimize/setVisibleAt, but NOT a
 * bare `setMatrixAt` (three.core.js :26770 does not set the flag) — this epoch
 * is what closes that hole, and it is why the invalidation is ours rather than
 * a read of three's flag alone.
 */
function _memoInvalidate(bm) {
  const st = bm.userData && bm.userData.__memo;
  if (st) { st.epoch = (st.epoch + 1) | 0; }
}

/** Membership changed: bounds AND the cached multidraw are both stale. */
function _memoDirtyBounds(bm) {
  bm.boundingSphere = null;
  _memoInvalidate(bm);
}

/**
 * Is the cached multidraw still a valid answer for this call?
 *
 * Returns 0 (rebuild), 1 (exact hit) or 2 (slack hit). Everything the build
 * READ must be compared here — a field checked at build time and not here is a
 * silent image bug, so the list is deliberately exhaustive and mirrors
 * three.core.js :27214-27368 line for line.
 */
function _memoDecide(bm, st, camera, material, geometry, mode) {
  if (!st.valid) return 0;
  if (st.camera !== camera || st.material !== material) return 0;
  if (bm._visibilityChanged) return 0;
  if (st.builtEpoch !== st.epoch) return 0;
  if (st.sortObjects !== bm.sortObjects || st.pOFC !== bm.perObjectFrustumCulled) return 0;
  if (st.wireframe !== !!material.wireframe) return 0;
  const index = geometry.getIndex();
  if (st.idxBytes !== (index === null ? 0 : index.array.BYTES_PER_ELEMENT)) return 0;
  if (!_elemsEqual(st.proj, camera.projectionMatrix.elements)) return 0;
  if (!_elemsEqual(st.mw, bm.matrixWorld.elements)) return 0;
  // Exact tier: the camera has not moved AT ALL, so three would recompute the
  // identical arrays (including the sort order, which is why this tier is safe
  // for `sortObjects` buckets too).
  if (_elemsEqual(st.camMw, camera.matrixWorld.elements)) return 1;
  if (mode !== "slack" || st.slackTrans <= 0) return 0;
  // Slack tier: the build dilated the frustum by `trans + rot * r`, so the
  // cached set is a superset while the camera stays inside that region.
  const pose = _cameraPose(camera);
  if (pose.pos.distanceTo(st.camPos) > st.slackTrans) return 0;
  // |dot| >= cos(theta/2) <=> the quaternions are within theta of each other.
  if (Math.abs(pose.quat.dot(st.camQuat)) < st.slackDotMin) return 0;
  return 2;
}

/**
 * Our transcription of three's NON-SORTED branch (three.core.js :27329-27362)
 * with the dilation added. Byte-identical to three's output when both slacks
 * are 0 — `test_stat_batch_walk.mjs` asserts exactly that against the real
 * r184 build, which is the only reason this duplication is acceptable.
 *
 * The sorted branch is deliberately NOT transcribed: it needs three's
 * module-private `_renderList`, and a re-implementation would be a second
 * sort with its own tie-breaking. Sorted buckets get the exact tier only.
 */
function _memoBuildSlack(bm, camera, geometry, material, transLocal, rotSlack) {
  const index = geometry.getIndex();
  let bytesPerElement = index === null ? 1 : index.array.BYTES_PER_ELEMENT;
  let multiDrawMultiplier = 1;
  if (material.wireframe) {
    multiDrawMultiplier = 2;
    bytesPerElement = geometry.attributes.position.count > 65535 ? 4 : 2;
  }
  const instanceInfo = bm._instanceInfo;
  const geometryInfoList = bm._geometryInfo;
  const multiDrawStarts = bm._multiDrawStarts;
  const multiDrawCounts = bm._multiDrawCounts;
  const indirectTexture = bm._indirectTexture;
  const indirectArray = indirectTexture.image.data;

  // Frustum in the mesh's LOCAL frame — same composition three uses, so the
  // plane distances below are in local units and so is the margin.
  _memoM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(bm.matrixWorld);
  _memoFrustum.setFromProjectionMatrix(_memoM, camera.coordinateSystem, camera.reversedDepth);
  // Camera position in the same local frame, for the distance-proportional
  // (i.e. ANGULAR) half of the margin.
  _memoM.copy(bm.matrixWorld).invert();
  _memoCamLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_memoM);

  const planes = _memoFrustum.planes;
  // The build margin has to cover the camera being at the EDGE of the validity
  // region when the cache is next read: a point r from the old camera position
  // can be up to r + transLocal from the new one, so the rotation term is taken
  // against (r + transLocal), not r. Without this the region leaks by
  // trans*rot local units and an instance could pop out.
  const rotTrans = rotSlack * transLocal;
  let multiDrawCount = 0;
  let walked = 0;
  for (let i = 0, l = instanceInfo.length; i < l; i++) {
    const inf = instanceInfo[i];
    if (!inf.visible || !inf.active) continue;
    walked++;
    const geometryId = inf.geometryIndex;
    bm.getMatrixAt(i, _memoInstM);
    const sph = bm.getBoundingSphereAt(geometryId, _memoSphere);
    if (sph === null) continue; // three does not guard this; a null here means
                                // a stale geometryIndex, and drawing it would
                                // read another geometry's range.
    sph.applyMatrix4(_memoInstM);
    const c = sph.center;
    let negRadius = -sph.radius;
    if (transLocal > 0 || rotSlack > 0) {
      const dx = c.x - _memoCamLocal.x, dy = c.y - _memoCamLocal.y, dz = c.z - _memoCamLocal.z;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      negRadius -= transLocal + rotSlack * r + rotTrans;
    }
    let culled = false;
    for (let p = 0; p < 6; p++) {
      if (planes[p].distanceToPoint(c) < negRadius) { culled = true; break; }
    }
    if (!culled) {
      const geometryInfo = geometryInfoList[geometryId];
      multiDrawStarts[multiDrawCount] = geometryInfo.start * bytesPerElement * multiDrawMultiplier;
      multiDrawCounts[multiDrawCount] = geometryInfo.count * multiDrawMultiplier;
      indirectArray[multiDrawCount] = i;
      multiDrawCount++;
    }
  }
  indirectTexture.needsUpdate = true;
  bm._multiDrawCount = multiDrawCount;
  bm._visibilityChanged = false;
  return { walked, drawn: multiDrawCount };
}

// --- ?statBatchSphere: the cache and the loop that reads it ----------------

const _sphM = new THREE.Matrix4();
const _sphS = new THREE.Sphere();
const _sphVerify = new THREE.Sphere();

/**
 * The cached local-frame world sphere of every instance slot, as
 * `[cx, cy, cz, r]` quads in one `Float64Array`.
 *
 * `r < 0` is the SKIP sentinel and covers both cases the walk must not draw:
 * an inactive slot, and a slot whose `geometryIndex` no longer resolves (three's
 * own loop does not guard the latter; `_memoBuildSlack` does, and drawing it
 * would emit another geometry's byte range — so the sentinel preserves that
 * guard rather than dropping it).
 *
 * Rebuilt only when `st.epoch` moves — i.e. on a membership change, a feed's
 * `setMatrixAt`, an `optimize()` or a `sortObjects` flip. A camera moving does
 * NOT move the epoch, which is the whole reason this survives where the memo
 * does not. Returns null on anything malformed; the caller then runs three's
 * loop untouched.
 */
function _sphereCacheEnsure(bm, st) {
  const info = bm._instanceInfo;
  if (!Array.isArray(info)) return null;
  const n = info.length;
  const ud = bm.userData;
  let c = ud.__sphereCache;
  if (c && c.epoch === st.epoch && c.n === n) return c;
  if (!c || c.arr.length < n * 4) {
    // Slots only ever grow (`_instanceInfo.length` is a high-water mark), so
    // this reallocates at most log2(maxInst) times per bucket.
    const arr = new Float64Array(Math.max(16, n) * 4);
    if (c) _sphereStats.bytes -= c.arr.byteLength;
    c = { arr, epoch: -1, n: 0 };
    ud.__sphereCache = c;
    _sphereStats.bytes += arr.byteLength;
  }
  const arr = c.arr;
  for (let i = 0; i < n; i++) {
    const inf = info[i];
    const b = i * 4;
    if (!inf || !inf.active) { arr[b + 3] = -1; continue; }
    bm.getMatrixAt(i, _sphM);
    const sph = bm.getBoundingSphereAt(inf.geometryIndex, _sphS);
    if (sph === null) { arr[b + 3] = -1; continue; }
    sph.applyMatrix4(_sphM);
    arr[b] = sph.center.x;
    arr[b + 1] = sph.center.y;
    arr[b + 2] = sph.center.z;
    arr[b + 3] = sph.radius;
  }
  c.epoch = st.epoch;
  c.n = n;
  _sphereStats.builds += 1;
  _sphereStats.slotsBuilt += n;
  return c;
}

/**
 * `=verify` — recompute every cached sphere the slow way and compare.
 *
 * Exact equality, not an epsilon: the cache is built by three's own expression
 * on inputs that have not changed, so any difference at all is a stale entry,
 * which is precisely the bug worth catching. Diagnostic only — this pass costs
 * more than the walk it is checking.
 */
function _sphereVerifyCache(bm, cache) {
  const info = bm._instanceInfo;
  const arr = cache.arr;
  for (let i = 0, l = info.length; i < l; i++) {
    const inf = info[i];
    if (!inf || !inf.active || !inf.visible) continue;
    const b = i * 4;
    bm.getMatrixAt(i, _sphM);
    const sph = bm.getBoundingSphereAt(inf.geometryIndex, _sphVerify);
    if (sph === null) continue;
    sph.applyMatrix4(_sphM);
    _sphereStats.verifyChecked += 1;
    if (arr[b] !== sph.center.x || arr[b + 1] !== sph.center.y
      || arr[b + 2] !== sph.center.z || arr[b + 3] !== sph.radius) {
      _sphereStats.verifyFails += 1;
      if (_sphereStats.verifyFails === 1) {
        // eslint-disable-next-line no-console
        console.warn(`[statBatchSphere] STALE CACHE on ${bm.name} slot ${i}: `
          + `cached (${arr[b]},${arr[b + 1]},${arr[b + 2]},r${arr[b + 3]}) vs `
          + `live (${sph.center.x},${sph.center.y},${sph.center.z},r${sph.radius})`);
      }
    }
  }
}

/**
 * `_memoBuildSlack` with the per-instance sphere read from the cache instead of
 * recomputed. Same margin arithmetic, same output; with both margins at zero it
 * is byte-identical to three's own loop, which is what
 * `test_stat_batch_walk.mjs` §7 asserts against the real r0.184.0 build.
 *
 * The frustum planes are unpacked to scalars before the loop rather than read
 * through `planes[p].distanceToPoint(center)`. That is not micro-optimisation
 * for its own sake: it is what removes the last per-instance `Vector3` write,
 * and the bench in `docs/2026-08-06-object-glue-census.md` §3 measures the whole
 * body at 15-19 ns/instance against three's 93-122 ns.
 */
function _buildFromSphereCache(bm, camera, geometry, material, transLocal, rotSlack, cache) {
  const index = geometry.getIndex();
  let bytesPerElement = index === null ? 1 : index.array.BYTES_PER_ELEMENT;
  let multiDrawMultiplier = 1;
  if (material.wireframe) {
    multiDrawMultiplier = 2;
    bytesPerElement = geometry.attributes.position.count > 65535 ? 4 : 2;
  }
  const instanceInfo = bm._instanceInfo;
  const geometryInfoList = bm._geometryInfo;
  const multiDrawStarts = bm._multiDrawStarts;
  const multiDrawCounts = bm._multiDrawCounts;
  const indirectTexture = bm._indirectTexture;
  const indirectArray = indirectTexture.image.data;
  const arr = cache.arr;

  // Frustum in the mesh's LOCAL frame — the same composition three does at
  // :27251-27262, and the frame the cached spheres live in.
  _memoM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(bm.matrixWorld);
  _memoFrustum.setFromProjectionMatrix(_memoM, camera.coordinateSystem, camera.reversedDepth);
  const dilate = transLocal > 0 || rotSlack > 0;
  let camX = 0, camY = 0, camZ = 0;
  if (dilate) {
    _memoM.copy(bm.matrixWorld).invert();
    _memoCamLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_memoM);
    camX = _memoCamLocal.x; camY = _memoCamLocal.y; camZ = _memoCamLocal.z;
  }
  const rotTrans = rotSlack * transLocal;

  const pl = _memoFrustum.planes;
  const n0 = pl[0].normal, n1 = pl[1].normal, n2 = pl[2].normal;
  const n3 = pl[3].normal, n4 = pl[4].normal, n5 = pl[5].normal;
  const a0 = n0.x, b0 = n0.y, c0 = n0.z, d0 = pl[0].constant;
  const a1 = n1.x, b1 = n1.y, c1 = n1.z, d1 = pl[1].constant;
  const a2 = n2.x, b2 = n2.y, c2 = n2.z, d2 = pl[2].constant;
  const a3 = n3.x, b3 = n3.y, c3 = n3.z, d3 = pl[3].constant;
  const a4 = n4.x, b4 = n4.y, c4 = n4.z, d4 = pl[4].constant;
  const a5 = n5.x, b5 = n5.y, c5 = n5.z, d5 = pl[5].constant;

  let multiDrawCount = 0;
  let walked = 0;
  for (let i = 0, l = instanceInfo.length; i < l; i++) {
    const inf = instanceInfo[i];
    if (!inf.visible || !inf.active) continue;
    const b = i * 4;
    let r = arr[b + 3];
    if (r < 0) {
      // The slot carries the skip sentinel but is live NOW, so it went active
      // without moving the epoch. That should be unreachable — every
      // `addInstance` path ends in `_memoDirtyBounds` — but the failure mode if
      // it ever is reachable is a SILENTLY DROPPED placement, which is the one
      // outcome worth spending a branch to make impossible. Heal the entry
      // in place and count it; a nonzero `lateActivations` is a missing
      // invalidation site, not a perf note.
      bm.getMatrixAt(i, _sphM);
      const s = bm.getBoundingSphereAt(inf.geometryIndex, _sphS);
      if (s === null) continue; // genuinely a stale gid — three's loop would
                                // draw another geometry's range here; we do not
      s.applyMatrix4(_sphM);
      arr[b] = s.center.x; arr[b + 1] = s.center.y; arr[b + 2] = s.center.z;
      r = arr[b + 3] = s.radius;
      _sphereStats.lateActivations += 1;
    }
    walked++;
    const cx = arr[b], cy = arr[b + 1], cz = arr[b + 2];
    let negRadius = -r;
    if (dilate) {
      const dx = cx - camX, dy = cy - camY, dz = cz - camZ;
      negRadius -= transLocal + rotSlack * Math.sqrt(dx * dx + dy * dy + dz * dz) + rotTrans;
    }
    if (a0 * cx + b0 * cy + c0 * cz + d0 < negRadius) continue;
    if (a1 * cx + b1 * cy + c1 * cz + d1 < negRadius) continue;
    if (a2 * cx + b2 * cy + c2 * cz + d2 < negRadius) continue;
    if (a3 * cx + b3 * cy + c3 * cz + d3 < negRadius) continue;
    if (a4 * cx + b4 * cy + c4 * cz + d4 < negRadius) continue;
    if (a5 * cx + b5 * cy + c5 * cz + d5 < negRadius) continue;
    const geometryInfo = geometryInfoList[inf.geometryIndex];
    multiDrawStarts[multiDrawCount] = geometryInfo.start * bytesPerElement * multiDrawMultiplier;
    multiDrawCounts[multiDrawCount] = geometryInfo.count * multiDrawMultiplier;
    indirectArray[multiDrawCount] = i;
    multiDrawCount++;
  }
  indirectTexture.needsUpdate = true;
  bm._multiDrawCount = multiDrawCount;
  bm._visibilityChanged = false;
  _sphereStats.slotsWalked += walked;
  _sphereStats.walks += 1;
  return { walked, drawn: multiDrawCount };
}

/**
 * Build this call's multidraw through the sphere cache, or return null to mean
 * "run three's own loop". Shared by the sphere-only override and by the memo's
 * rebuild path, so the two flags compose instead of racing for the seam.
 */
function _trySphereBuild(bm, camera, geometry, material, transLocal, rotSlack) {
  const st = bm.userData && bm.userData.__memo;
  const mode = statBatchSphereMode();
  if (!st || mode === "off") return null;
  if (!_slackEligible(bm, camera)) { _sphereStats.ineligible += 1; return null; }
  try {
    const cache = _sphereCacheEnsure(bm, st);
    if (cache === null) { _sphereStats.errors += 1; return null; }
    if (mode === "verify") _sphereVerifyCache(bm, cache);
    return _buildFromSphereCache(bm, camera, geometry, material, transLocal, rotSlack, cache);
  } catch (_) {
    _sphereStats.errors += 1;
    return null;
  }
}

/**
 * `onBeforeRender` override for `?statBatchSphere` with `?statBatchMemo=off`.
 *
 * Deliberately does NOT carry the memo's per-call bookkeeping (two 16-float
 * compares, a camera decompose, the state write-back). That bookkeeping is what
 * measured **+0.5 ms WORSE moving** for the memo, and this flag exists precisely
 * for the moving case — so it must not inherit the cost that broke it.
 */
function _sphereOnBeforeRender(renderer, scene, camera, geometry, material, group) {
  if (camera && material && geometry) {
    _sphereStats.calls += 1;
    if (_trySphereBuild(this, camera, geometry, material, 0, 0) !== null) return undefined;
  }
  return THREE.BatchedMesh.prototype.onBeforeRender.call(this, renderer, scene, camera, geometry, material, group);
}

/** Can this call take the dilated path at all? (fail-soft ⇒ three's own loop) */
function _slackEligible(bm, camera) {
  return bm.sortObjects === false
    && bm.perObjectFrustumCulled === true
    && camera.isArrayCamera !== true
    && Array.isArray(bm._instanceInfo)
    && Array.isArray(bm._geometryInfo)
    && !!(bm._indirectTexture && bm._indirectTexture.image && bm._indirectTexture.image.data)
    && !!bm._multiDrawStarts && !!bm._multiDrawCounts;
}

/**
 * Per-bucket `onBeforeRender` override, installed as an OWN property so it
 * shadows `BatchedMesh.prototype.onBeforeRender` for this node only. Nothing
 * else in the tree is affected, and `?statBatchMemo=off` never installs it.
 *
 * NOTE `onBeforeShadow` (three.core.js :27370) routes through `this.
 * onBeforeRender` with the SHADOW camera, so it lands here too. The state is a
 * single slot, so a shadow pass and the colour pass alternating cameras simply
 * miss each other — correct, but worth zero. Shadows are off at quality `mid`
 * (quality.js `csm: false`, `?shadows` opt-in), which is where the 5.72 ms was
 * measured; a shadowed preset wants a per-camera slot and does not have one.
 */
function _memoOnBeforeRender(renderer, scene, camera, geometry, material, group) {
  const st = this.userData && this.userData.__memo;
  const mode = statBatchMemoMode();
  if (!st || mode === "off" || !camera || !material || !geometry) {
    return THREE.BatchedMesh.prototype.onBeforeRender.call(this, renderer, scene, camera, geometry, material, group);
  }
  _memoStats.calls += 1;
  let decision = 0;
  try {
    decision = _memoDecide(this, st, camera, material, geometry, mode);
  } catch (_) { decision = 0; _memoStats.errors += 1; }
  if (decision !== 0) {
    if (decision === 1) _memoStats.hitsExact += 1; else _memoStats.hitsSlack += 1;
    _memoStats.instancesSkipped += st.walked;
    // Everything the renderer reads next — `_multiDrawStarts`, `_multiDrawCounts`,
    // `_multiDrawCount` and the indirect texture — still holds this bucket's
    // last answer, and `_visibilityChanged` is already false. Deliberately do
    // NOT touch `indirectTexture.needsUpdate`: skipping the re-upload is part
    // of the win.
    return undefined;
  }

  // ---- rebuild --------------------------------------------------------
  let walked = 0;
  let drawn = 0;
  let slackTrans = 0;
  let slackRot = 0;
  let built = false;
  // Zero margins are a legal degenerate: our loop then computes EXACTLY what
  // three computes, which is the identity `test_stat_batch_walk.mjs` asserts.
  if (mode === "slack") {
    try {
      if (_slackEligible(this, camera)) {
        // Margins are world metres; the frustum and spheres live in the mesh's
        // LOCAL frame, so convert by the node's scale. Buckets sit at the
        // staticsGroup origin unscaled, so this is normally exactly 1.
        const s = this.matrixWorld.getMaxScaleOnAxis();
        if (Number.isFinite(s) && s > 1e-6) {
          // ?statBatchSphere COMPOSES WITH THE SLACK TIER TOO (fixed 2026-08-06,
          // second pass). It did not, and the omission made the flag INERT in
          // the shipped configuration: `?statBatchMemo` defaults to "slack", so
          // every slack-eligible bucket rebuilt here through `_memoBuildSlack`
          // — which recomputes every sphere from scratch — and the sphere cache
          // was only reachable from the `!built` fallthrough below, which
          // `_trySphereBuild` then declined for exactly the same eligibility
          // reason that sent us down this branch. Measured with the test seams
          // over 10 moving frames on a 200-instance bucket:
          //     memo=slack  sphere{builds:0, slotsWalked:0, calls:0}   <- dead
          //     memo=exact  sphere{builds:1, slotsWalked:2000}
          //     memo=off    sphere{builds:1, slotsWalked:2000, calls:10}
          // i.e. the one flag whose whole purpose is the MOVING case did no work
          // at all unless you also turned off the 4.00 ms parked win. Both loops
          // carry the identical margin arithmetic and the cached spheres are
          // bit-identical to three's, so this changes what a rebuild COSTS and
          // never what it answers (§7/§17 assert that byte for byte).
          const r = _trySphereBuild(this, camera, geometry, material, _memoTransM / s, _memoRotRad)
            || _memoBuildSlack(this, camera, geometry, material, _memoTransM / s, _memoRotRad);
          walked = r.walked; drawn = r.drawn;
          slackTrans = _memoTransM; slackRot = _memoRotRad;
          built = true;
          _memoStats.rebuildsSlack += 1;
        }
      }
    } catch (_) { built = false; _memoStats.errors += 1; }
  }
  if (!built && statBatchSphereMode() !== "off") {
    // ?statBatchSphere composes with the memo: a MISS rebuilds through the
    // cached spheres rather than three's loop. Zero margins ⇒ byte-identical to
    // three, so this changes only what the rebuild costs, never its answer.
    const r = _trySphereBuild(this, camera, geometry, material, 0, 0);
    if (r !== null) {
      walked = r.walked; drawn = r.drawn;
      built = true;
      _memoStats.rebuildsSlack += 1;
    }
  }
  if (!built) {
    // Exact tier (and every fail-soft path): three's own loop, untouched.
    THREE.BatchedMesh.prototype.onBeforeRender.call(this, renderer, scene, camera, geometry, material, group);
    walked = Array.isArray(this._instanceInfo) ? this._instanceInfo.length : 0;
    drawn = this._multiDrawCount | 0;
    _memoStats.rebuilds += 1;
  }
  _memoStats.instancesWalked += walked;

  // ---- record the inputs this answer was built from --------------------
  try {
    const index = geometry.getIndex();
    st.camera = camera;
    st.material = material;
    _elemsCopy(st.camMw, camera.matrixWorld.elements);
    _elemsCopy(st.proj, camera.projectionMatrix.elements);
    _elemsCopy(st.mw, this.matrixWorld.elements);
    if (slackTrans > 0 || slackRot > 0) {
      const pose = _cameraPose(camera);
      st.camPos.copy(pose.pos);
      st.camQuat.copy(pose.quat);
    }
    st.slackTrans = slackTrans;
    // cos(theta/2) — compared against |dot(q0,q1)| in `_memoDecide`.
    st.slackDotMin = slackRot > 0 ? Math.cos(slackRot / 2) : 2;
    st.sortObjects = this.sortObjects;
    st.pOFC = this.perObjectFrustumCulled;
    st.wireframe = !!material.wireframe;
    st.idxBytes = index === null ? 0 : index.array.BYTES_PER_ELEMENT;
    st.walked = walked;
    st.drawn = drawn;
    st.builtEpoch = st.epoch;
    st.valid = true;
  } catch (_) {
    st.valid = false; // never cache a state we could not fully capture
    _memoStats.errors += 1;
  }
  return undefined;
}

/**
 * Install the per-instance-walk override on a freshly created bucket. No-op
 * with `?statBatchMemo=off` AND `?statBatchSphere=off`, which is the default —
 * off is then not one extra property read on any path.
 *
 * ONE seam, two flags. Both want to shadow `BatchedMesh.prototype
 * .onBeforeRender` on the same node, so they share the `__memo` state (the
 * epoch is what invalidates both) and the memo's override wins when it is on,
 * routing its MISSES through the sphere cache. The sphere-only override is
 * separate rather than a mode inside the memo's because the memo's per-call
 * bookkeeping is exactly what regressed the moving case, and the sphere cache's
 * whole point is the moving case.
 *
 * ⚠ INTERACTION WITH `__statMergeArmSubmitted`. `armStatMergeSubmittedSampler`
 * (static_atlas.js) measures submitted scale by wrapping `onBeforeRender`, and
 * it deliberately SKIPS any node that already owns one (`hasOwnProperty`) so it
 * cannot double-wrap. With either flag on it therefore counts our buckets as
 * "armed" while never sampling them — the submitted-scale census reads 0 frames
 * for exactly the population it was built to size. Measure submitted scale with
 * both flags off, or read `getStatBatchXStats().walk.calls` /
 * `walk.sphere.calls` instead, which count the same thing and are always live.
 */
function _installMemo(bm) {
  const memo = statBatchMemoMode() !== "off";
  const sphere = statBatchSphereMode() !== "off";
  if (!memo && !sphere) return;
  // The epoch lives on `__memo` and is bumped by `_memoInvalidate` regardless of
  // which flag is on, so the sphere cache needs this state even with memo off.
  bm.userData.__memo = _memoStateFor();
  bm.onBeforeRender = memo ? _memoOnBeforeRender : _sphereOnBeforeRender;
  if (memo) _memoStats.installed += 1;
  if (sphere) _sphereStats.installed += 1;
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
  // precedent). Transparent buckets keep the sort for blend order — unless
  // `?statBatchNoSort=on` proves this material's blend is order-independent
  // (see `_shouldSortBucket`). Flag off ⇒ exactly `!!mat.transparent`.
  bm.sortObjects = _shouldSortBucket(mat);
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
  // ?statBatchMemo — install the per-bucket multidraw memo (no-op when off).
  _installMemo(bm);
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
  // ?statBatchSphere — drop the cache with the bucket, and take its bytes back
  // out of the census. Without this `walk.sphere.bytes` is a high-water mark
  // wearing a live-total name, which is the reporting bug this file has already
  // made once (`deadBatch.triangles` off an allocated vertex buffer).
  if (ud.__sphereCache) {
    _sphereStats.bytes -= ud.__sphereCache.arr.byteLength;
    ud.__sphereCache = null;
  }
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
    // Membership changed — invalidate node bounds (three recomputes at the next
    // cull) AND the ?statBatchMemo cache: this feed ran `setMatrixAt`, which
    // three does NOT flag via `_visibilityChanged`.
    for (const bm of touched) _memoDirtyBounds(bm);
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
      _memoDirtyBounds(m.bm); // membership changed — lazy bounds + memo recompute
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
    _memoDirtyBounds(m.bm); // membership changed — lazy bounds + memo recompute
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
  // ?statBatchNoSort — RE-DERIVE `sortObjects` for the same reason and on the
  // same tick: `_reseatSurfaceState` rewrites `transparent`/`depthWrite`/
  // `blending` in both directions after a spawn-race fallback, and those three
  // ARE the order-independence proof. Only runs under the flag (off ⇒ the
  // creation-time `!!mat.transparent` can never go stale in a way this would
  // notice, and the loop is skipped outright).
  if (statBatchNoSortEnabled()) {
    for (const region of _buckets.values()) for (const { bm } of region.values()) _reseatBucketSort(bm);
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
      // optimize() rewrites every geometry's start/count, so the memoised
      // multidraw ranges are stale even though the instance SET did not change.
      try { bm.optimize(); ud.usedVerts -= ud.deadVerts; ud.deadVerts = 0; _memoDirtyBounds(bm); } catch (_) { /* fail-soft */ }
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
  // THE PER-INSTANCE WALK CENSUS (2026-08-06). `instanceSlots` is the number
  // three's `onBeforeRender` loop actually visits — `_instanceInfo.length`,
  // i.e. the high-water mark of allocated slots INCLUDING inactive ones, which
  // is NOT the same as `ud.instances` (live placements). If the two diverge on
  // a long roam, eviction churn is leaving dead slots that are re-tested every
  // frame forever. Split by `sortObjects` because that is the one bucket
  // property that decides which of three's two loops runs, and the sorted loop
  // is the expensive one (§5a + `?statBatchNoSort`).
  let instanceSlots = 0;
  let sortedBuckets = 0;
  let sortedSlots = 0;
  let drawnSlots = 0;
  let drawnSortedSlots = 0;
  for (const region of _buckets.values()) for (const { bm } of region.values()) {
    const ud = bm.userData;
    const slots = Array.isArray(bm._instanceInfo) ? bm._instanceInfo.length : 0;
    instanceSlots += slots;
    if (bm.sortObjects) { sortedBuckets += 1; sortedSlots += slots; }
    const before = ud.mergedMats ? Math.max(1, ud.mergedMats.size) : 1;
    bucketsBefore += before;
    if (ud.mergedMats) mergedBuckets += 1;
    if (_bucketDrawn(bm)) {
      drawnBuckets += 1;
      drawnBefore += before;
      drawnSlots += slots;
      if (bm.sortObjects) drawnSortedSlots += slots;
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
      // The walk: slots three visits per frame (>= `instances`), and which of
      // three's two loops this bucket takes.
      slots,
      sorted: !!bm.sortObjects,
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
    // THE INSTANCE AXIS (?statBatchNoSort / ?statBatchMemo). Read this before
    // quoting any projection: `slots.drawn` is the population that actually
    // pays the 0.348 us/instance, and every earlier over-estimate in this file
    // came from pricing a RESIDENT count as if it were drawn.
    //
    //   hitRate = (hitsExact + hitsSlack) / calls   — the whole value of the memo
    //   avgWalk = instancesWalked / (rebuilds + rebuildsSlack)
    //
    // To turn these into MILLISECONDS (the only unit that has ever survived a
    // measurement here): sample the counters, wait N displayed frames, sample
    // again, and evaluate the §5a model on the DELTAS —
    //   saved_ms_per_frame = (d.hitsExact + d.hitsSlack) * 5.9e-3
    //                      + d.instancesSkipped * 0.348e-3, all divided by N.
    // Then check that against p50 frame time, and believe the frame time.
    //
    // `errors > 0` means the memo fell back to three's own loop — it is never
    // wrong, only worthless, but a nonzero count wants explaining.
    walk: {
      mode: statBatchMemoMode(),
      noSort: statBatchNoSortEnabled(),
      installed: _memoStats.installed,
      calls: _memoStats.calls,
      hitsExact: _memoStats.hitsExact,
      hitsSlack: _memoStats.hitsSlack,
      rebuilds: _memoStats.rebuilds,
      rebuildsSlack: _memoStats.rebuildsSlack,
      instancesWalked: _memoStats.instancesWalked,
      instancesSkipped: _memoStats.instancesSkipped,
      errors: _memoStats.errors,
      slackTransM: _memoTransM,
      slackRotDeg: (_memoRotRad * 180) / Math.PI,
      // Live population, split the way three's two loops split it.
      slots: { all: instanceSlots, sorted: sortedSlots, drawn: drawnSlots, drawnSorted: drawnSortedSlots },
      sortedBuckets,
      // ?statBatchSphere. The number to watch is `slotsWalked` vs `slotsBuilt`:
      // walked is per FRAME and is what got 5-7x cheaper, built is per EPOCH and
      // is the price of that. A `slotsBuilt` that keeps pace with `slotsWalked`
      // means something is bumping the epoch every frame and the cache is worth
      // nothing — check `?statBatchChunk` feeds and eviction churn before
      // believing any ms figure. `verifyFails` MUST be 0 (`=verify` only);
      // nonzero is a stale sphere, i.e. an image bug, not a perf note.
      //
      // ⚠ `calls` counts the SPHERE-ONLY override and is therefore 0 whenever
      // `?statBatchMemo` is on (the default), because the memo owns the seam
      // and routes its rebuilds through the cache. Reading `calls === 0` as
      // "the cache never ran" is wrong in exactly the configuration that ships.
      // `walks` counts cached walks on BOTH paths — use it, and use
      // `slotsWalked / slotsBuilt` as the payback ratio (< ~1 ⇒ a net loss;
      // the epoch is moving faster than the cache can amortise, which under
      // motion means landblocks are streaming into these buckets).
      //
      // ms/frame saved, on the node bench's 93-122 -> 15-19 ns/instance:
      //   saved ~= d.slotsWalked * 0.080e-3 / N  -  d.slotsBuilt * 0.120e-3 / N
      // and, as ever, believe the p50 over the model.
      sphere: {
        mode: statBatchSphereMode(),
        installed: _sphereStats.installed,
        calls: _sphereStats.calls,
        walks: _sphereStats.walks,
        builds: _sphereStats.builds,
        slotsBuilt: _sphereStats.slotsBuilt,
        slotsWalked: _sphereStats.slotsWalked,
        ineligible: _sphereStats.ineligible,
        errors: _sphereStats.errors,
        lateActivations: _sphereStats.lateActivations,
        verifyChecked: _sphereStats.verifyChecked,
        verifyFails: _sphereStats.verifyFails,
        bytes: _sphereStats.bytes,
      },
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
