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
const _stats = { bucketsCreated: 0, bucketsReaped: 0, gidProbeFailures: 0 };

// Geometry-level stamp read by `_contentKeyOf`. Absent ⇒ legacy path.
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

function _getOrCreateBucket(mat, scene3d, templateNode, regionKey) {
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
  };
  bm.name = `static-batch-c-r${regionKey}-s${surf.toString(16).padStart(8, "0")}-m${_bucketSeq++}`;
  // Back-references so an emptied bucket can find and remove itself (see
  // _reapBucketIfEmpty). Kept on userData rather than in a side map so they
  // cannot outlive the BatchedMesh.
  bm.userData.regionKey = regionKey;
  bm.userData.material = mat;
  b = { bm };
  region.set(mat, b);
  _stats.bucketsCreated += 1;
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
      let bucket;
      try {
        bucket = _getOrCreateBucket(group[0].material, scene3d, group[0], regionKey);
      } catch (_) {
        out.push(...group); // bucket creation failed — whole group stays unbatched
        continue;
      }
      const bm = bucket.bm;
      const ud = bm.userData;
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
                gid = _addGeometryGrow(bm, m.geometry); // throws → catch → passthrough
                entry = { gid, refs: new Set() };
                shared.set(ckey, entry);
                _dedupStats.adds += 1;
              }
            } else {
              gid = _addGeometryGrow(bm, m.geometry); // throws → catch → passthrough
            }
            gidOf.set(m.geometry, gid);
            let list = _lbMembership.get(lbKey);
            if (!list) { list = []; _lbMembership.set(lbKey, list); }
            if (entry !== undefined) {
              entry.refs.add(lbKey);
              rec = { bm, gid, key: ckey, entry, iids: [] };
              list.push(rec);
              recOf.set(gid, rec);
            } else {
              list.push({ bm, gid }); // legacy record: deleteGeometry cascades
            }
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
      if (groupAdded > 0) { consumed += groupAdded; bucketsTouched += 1; touched.add(bm); }
    }
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

/** Diag/census: per-bucket + total live instance/vert counts. */
export function getStatBatchXStats() {
  const buckets = [];
  let instances = 0;
  for (const region of _buckets.values()) for (const { bm } of region.values()) {
    const ud = bm.userData;
    buckets.push({
      name: bm.name,
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
    });
    instances += ud.instances;
  }
  return {
    buckets: buckets.length,
    instances,
    detail: buckets,
    lbsFed: _lbMembership.size,
    // Bucket lifecycle. `bucketsCreated - bucketsReaped` MUST equal `buckets`;
    // a `buckets` count that only ever climbs on a long roam is the 2026-08-03
    // leak returning. High churn (reaped ~= created on a short walk) would mean
    // the 3x3 region granularity is thrashing and wants a hysteresis pass.
    bucketsCreated: _stats.bucketsCreated,
    bucketsReaped: _stats.bucketsReaped,
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
