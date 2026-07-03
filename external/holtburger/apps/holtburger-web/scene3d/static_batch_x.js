// scene3d/static_batch_x.js — ?statBatchCrossLb: cross-LB consolidation of the
// per-LB ?staticBatch BatchedMeshes.
//
// PROBLEM (2026-07-02, measured live on the GTX 1070 at quality=low in forest):
// the per-LB `consolidateStaticSingletons` (statics.js) emits ONE BatchedMesh
// per (landblock, surface material) — ~3,008 `static-batch-lb…` nodes across
// the 203-LB resident ring, the BULK of the remaining ~750 draw calls after the
// instanced-animated-scenery fix. The structure is GLOBAL: the same surface
// material (MaterialCache is cross-LB) recurs in nearly every LB, so the same
// population collapses to ONE persistent BatchedMesh per surface MATERIAL
// spanning the whole ring — bucket-scale (~tens) instead of 3k-scale.
//
// Design (option b of the Track-D brief): keep each surface's OWN material
// (identical shading to the per-LB batches — no texture-array involvement, no
// normal-map/emissive/alphaTest loss like the statAtlas albedo-only trade).
// Grouping key = material OBJECT identity, exactly the per-LB consolidator's
// key (visual frag-SET variant clones stay distinct — P1.14 EDIT F). Only
// groups of >=2 nodes are consumed, so the lone-singleton population keeps
// flowing to the cross-LB statAtlas seam exactly as before — the off/on
// population split is identical, only WHERE the >=2 groups land changes.
//
// Improvements over the per-LB batches (safe, same-frame):
//   - geometry dedupe: within one LB's feed all placements of a model share
//     ONE BufferGeometry object; the per-LB path re-adds it per placement,
//     this path adds it ONCE per (bucket, geometry) and addInstance()s per
//     placement (BatchedMesh multi-instance — less vertex-buffer duplication).
//   - sortObjects only for transparent materials (opaque buckets skip the
//     per-frame instance depth sort; the statAtlas precedent).
//
// EVICTION (mirrors static_atlas.js): a cross-LB bucket has NO single
// landblockId, so the LRU per-LB statics scan (landblock_lru step 3) naturally
// SKIPS it (and must NEVER dispose it). Per-LB removal is a dedicated hook
// `scene3d._evictStaticBatchXForLb` — wired deterministically at LRU
// construction (index.js) AND re-installed by each feed — that
// `bm.deleteGeometry(gid)`s every geometry this LB contributed. deleteGeometry
// flips the geometry + ALL its instances inactive the SAME FRAME (a gid is
// exclusively owned by one LB: geometry objects are per-LB-baked, so the
// cascade never touches another LB's placements). Freed buffer space is
// reclaimed LAZILY via `bm.optimize()` off the hot path (~10 Hz PVS tick,
// loop.js) once >30% of a bucket's used extent is dead; optimize() preserves
// geometryIds (verified against three r184 BatchedMesh.optimize — inactive
// ranges are skipped, active infos keep their list index). Re-entry after
// evict re-feeds with fresh gids (three recycles freed ids internally).
//
// Growth (house style, animated_scenery.js `_registerSlot` doubling adapted to
// BatchedMesh): vertex/index budget grows via setGeometrySize (re-allocates +
// copies; also upgrades the index array type past 65,535 verts — r184
// _initializeGeometry re-runs), instance budget via setInstanceCount.
//
// Sources are NOT disposed here: node geometries stay in the per-LB
// `disposables` list exactly like the per-LB batch path (BatchedMesh COPIES
// vertex data; the LRU disposes the sources on evict → no double-free, and a
// group member that fails mid-feed can still render as a passthrough Mesh).
//
// Gated DEFAULT-OFF behind `?statBatchCrossLb=on` pending the 1070 eye-test.
// Flag-off: nothing in this module runs; statics.js takes the byte-identical
// per-LB consolidation path.

import * as THREE from "three";

let _flag;
/** `?statBatchCrossLb=on` enables cross-LB per-material consolidation of the
 *  ?staticBatch population. DEFAULT-ON (2026-07-03); `?statBatchCrossLb=off` restores the per-LB legacy path. */
export function statBatchCrossLbEnabled() {
  if (_flag !== undefined) return _flag;
  let on = false; // DEFAULT-OFF (2026-07-03): re-feed idempotence is FIXED (tests 24/25) but the full-ring live run measured ~4k calls / 1.1M tris / 6 fps pre-fix with ~40k legitimate instances — per-instance culling cost + the call-count mystery are unresolved; opt-in via ?statBatchCrossLb=on for the next daytime probe session
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("statBatchCrossLb") || "").toLowerCase();
      if (v === "on" || v === "1" || v === "true" || v === "yes") on = true;
    }
  } catch (_) { on = false; }
  _flag = on;
  return on;
}
// Test seams.
export function __setStatBatchCrossLbForTest(v) { _flag = v; }
export function __resetStatBatchXForTest() {
  _buckets.clear();
  _lbMembership.clear();
  _dirtyBuckets.clear();
  _bucketSeq = 0;
}

const _INIT_VERTS = 1 << 15;      // 32,768; grows via setGeometrySize on demand
const _INIT_INST = 512;           // grows via setInstanceCount on demand
const _OPTIMIZE_FRAC = 0.30;      // compact a bucket once >30% of its used extent is dead
const _GROW_TRIES = 8;            // doubling attempts before a node falls through

// Lazy module state — only ever touched under ?statBatchCrossLb=on.
const _buckets = new Map();       // material object -> bucket { bm }
const _lbMembership = new Map();  // lbKey -> Array<{ bm, gid }>
const _dirtyBuckets = new Set();  // buckets with freed geometry awaiting optimize()
let _bucketSeq = 0;

function _lbKeyOfId(id) {
  return (((id >>> 0) & 0xffff0000) >>> 0);
}

function _getOrCreateBucket(mat, scene3d, templateNode) {
  let b = _buckets.get(mat);
  if (b) return b;
  const bm = new THREE.BatchedMesh(_INIT_INST, _INIT_VERTS, _INIT_VERTS * 2, mat);
  // OPAQUE: skip the per-frame instance depth sort (CPU win; statAtlas
  // precedent). Transparent buckets keep the sort for blend order.
  bm.sortObjects = !!mat.transparent;
  bm.perObjectFrustumCulled = true; // per-instance sphere cull trims the multidraw
  bm.frustumCulled = false;         // the batch spans the ring; never cull as one
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
  };
  bm.name = `static-batch-x-s${surf.toString(16).padStart(8, "0")}-m${_bucketSeq++}`;
  b = { bm };
  _buckets.set(mat, b);
  try { scene3d?.staticsGroup?.add(bm); } catch (_) { /* fail-soft */ }
  return b;
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
      if (n && n.isMesh && !n.isLOD && n.geometry && n.material && n.userData) {
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
    let consumed = 0;
    let bucketsTouched = 0;
    for (const group of byMat.values()) {
      if (group.length < 2) { out.push(...group); continue; } // lone → statAtlas seam, as before
      let bucket;
      try {
        bucket = _getOrCreateBucket(group[0].material, scene3d, group[0]);
      } catch (_) {
        out.push(...group); // bucket creation failed — whole group stays unbatched
        continue;
      }
      const bm = bucket.bm;
      const ud = bm.userData;
      // Within one feed all placements of a model share ONE BufferGeometry
      // object — add it once, instance it per placement.
      const gidOf = new Map(); // BufferGeometry -> gid (this feed only)
      let groupAdded = 0;
      for (const m of group) {
        try {
          m.updateMatrix();
          let gid = gidOf.get(m.geometry);
          if (gid === undefined) {
            gid = _addGeometryGrow(bm, m.geometry); // throws → catch → passthrough
            gidOf.set(m.geometry, gid);
            let list = _lbMembership.get(lbKey);
            if (!list) { list = []; _lbMembership.set(lbKey, list); }
            list.push({ bm, gid });
          }
          const iid = _addInstanceGrow(bm, gid);
          bm.setMatrixAt(iid, m.matrix); // node is staticsGroup-relative, so is the bucket
          ud.instances += 1;
          groupAdded += 1;
        } catch (_) {
          // Geometry didn't fit this bucket's layout / budget — keep it as a
          // standalone Mesh so nothing goes invisible (fail-soft).
          out.push(m);
        }
      }
      if (groupAdded > 0) { consumed += groupAdded; bucketsTouched += 1; }
    }
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
  for (const m of list) {
    const ud = m.bm.userData;
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
    _dirtyBuckets.add(m.bm);
  }
  _lbMembership.delete(key);
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
      try { bm.optimize(); ud.usedVerts -= ud.deadVerts; ud.deadVerts = 0; } catch (_) { /* fail-soft */ }
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
  for (const { bm } of _buckets.values()) {
    const ud = bm.userData;
    buckets.push({
      name: bm.name,
      instances: ud.instances,
      usedVerts: ud.usedVerts,
      deadVerts: ud.deadVerts,
      maxVerts: ud.maxVerts,
      maxInst: ud.maxInst,
    });
    instances += ud.instances;
  }
  return { buckets: buckets.length, instances, detail: buckets, lbsFed: _lbMembership.size };
}
