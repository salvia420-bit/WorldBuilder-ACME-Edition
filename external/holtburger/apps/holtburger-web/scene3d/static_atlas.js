// scene3d/static_atlas.js — texture-array batching for unique-material static singletons.
//
// PROBLEM (2026-06-27, measured on a real GTX 1070 at Holtburg): after the
// foliage-instancing fix the scene is still CPU/draw-call bound — ~5,400 static
// SINGLETON meshes, each its own draw call, because they carry UNIQUE materials
// (different surface textures) and so cannot be collapsed by the material-keyed
// `consolidateStaticSingletons` (which only batches >=2 nodes sharing one material).
//
// FEASIBILITY SPIKE (same session): those ~5,400 singletons reference only ~353
// unique textures, ALL RGBA8 DataTextures (image.data accessible), ALL
// ClampToEdge, sRGB, MeshStandardMaterial/DoubleSide, across ~20 power-of-2 SIZE
// buckets. That is ideal for a sampler2DArray: bucket by texture size, pack each
// bucket's textures as layers of a DataArrayTexture, tag every vertex with its
// layer, and merge the bucket's geometry into ONE mesh sampling the array by
// layer. ~5,400 unique-material draws collapse to a few dozen.
//
// v1 scope: ALBEDO-ONLY (the source materials also carry a normalMap; v1 drops it
// for the atlased path -> slightly flatter shading, an eye-test trade). Gated
// DEFAULT-OFF behind `?statAtlas=on` so master is untouched until the 1070 A/B
// eye-test signs off. The frag-VFX suite still applies to non-atlased nodes.
//
// LRU-safe: bucketed PER landblock; each merged mesh carries userData.landblockId,
// so the existing per-LB eviction (which scans staticsGroup.children by
// landblockId) tears it down identically to the singletons it replaces.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

let _flag;
/** `?statAtlas=on` — texture-array batch unique-material static singletons. DEFAULT-OFF. */
export function statAtlasEnabled() {
  if (_flag !== undefined) return _flag;
  let on = false;
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const v = new URLSearchParams(window.location.search).get("statAtlas");
      if (v != null) { const s = v.toLowerCase(); on = s === "on" || s === "1" || s === "true" || s === "yes"; }
    }
  } catch (_) { on = false; }
  return (_flag = on);
}

// One shared 1x1 white map forces USE_MAP so three emits the vMapUv plumbing the
// injected array sampler reuses. Never sampled itself.
let _dummyMap = null;
function dummyMap() {
  if (_dummyMap) return _dummyMap;
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  _dummyMap = t;
  return t;
}

// Build a sRGB RGBA8 DataArrayTexture from same-size RGBA8 source DataTextures.
// `layerCount` (optional) pre-allocates a fixed capacity larger than the supplied
// textures (the cross-LB path allocates an empty array of `capacity` layers up
// front and writes each layer's pixels on demand). Omitted ⇒ exactly textures.length
// (the original per-(LB,size) path — byte-identical).
function buildDiffuseArray(textures, w, h, layerCount) {
  const layers = layerCount != null ? layerCount : textures.length;
  const data = new Uint8Array(w * h * 4 * layers);
  const stride = w * h * 4;
  for (let i = 0; i < textures.length; i++) {
    const src = textures[i]?.image?.data;
    if (src && src.length === stride) data.set(src, i * stride);
    // missing/mismatched source -> that layer stays black (rare; fail-soft).
  }
  const arr = new THREE.DataArrayTexture(data, w, h, layers);
  arr.format = THREE.RGBAFormat;
  arr.type = THREE.UnsignedByteType;
  arr.colorSpace = THREE.SRGBColorSpace; // GPU sRGB->linear decode on sample
  arr.wrapS = THREE.ClampToEdgeWrapping;
  arr.wrapT = THREE.ClampToEdgeWrapping;
  arr.minFilter = THREE.LinearMipmapLinearFilter;
  arr.magFilter = THREE.LinearFilter;
  arr.generateMipmaps = true;
  arr.needsUpdate = true;
  return arr;
}

// MeshStandardMaterial whose `map` is replaced by a sampler2DArray indexed per
// vertex (aLayer). Shares ONE compiled program across buckets (customProgramCacheKey)
// so the array variant compiles once; the array uniform differs per material.
function makeArrayMaterial(diffArray, transparent, alphaTest) {
  const m = new THREE.MeshStandardMaterial({
    map: dummyMap(),
    transparent: !!transparent,
    alphaTest: alphaTest || 0,
    side: THREE.DoubleSide,
    roughness: 1.0,
    metalness: 0.0,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uDiffuseArray = { value: diffArray };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aLayer;\nvarying float vLayer;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n\tvLayer = aLayer;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nprecision highp sampler2DArray;\nuniform sampler2DArray uDiffuseArray;\nvarying float vLayer;"
      )
      .replace(
        "vec4 sampledDiffuseColor = texture2D( map, vMapUv );",
        "vec4 sampledDiffuseColor = texture( uDiffuseArray, vec3( vMapUv, vLayer ) );"
      );
  };
  // All atlas materials share one program; the per-material uDiffuseArray uniform
  // is bound per-draw. Distinct from the stock MeshStandard key so it links once.
  m.customProgramCacheKey = () => "statAtlasArrayMatV1";
  m.userData = { __statAtlasMat: true };
  return m;
}

// Normalize a cloned geometry to exactly {position, normal, uv, aLayer}, non-indexed,
// so a whole bucket merges with consistent attributes regardless of source variety.
function normalizeForMerge(geom, layer) {
  let g = geom.index ? geom.toNonIndexed() : geom;
  if (g === geom) g = geom.clone(); // ensure we own it
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
  }
  if (!g.attributes.position || !g.attributes.normal || !g.attributes.uv) return null;
  const cnt = g.attributes.position.count;
  g.setAttribute("aLayer", new THREE.BufferAttribute(new Float32Array(cnt).fill(layer), 1));
  return g;
}

/**
 * Collapse unique-material static SINGLETON Mesh nodes into per-(landblock, size)
 * texture-array-batched merged meshes. Returns { meshes, passthrough }: `meshes`
 * are the new atlas meshes to add; `passthrough` are nodes that couldn't be atlased
 * (no map/uv, LOD, lone-in-bucket, or merge failure) and must be added unchanged.
 * Fail-soft per bucket. Disposes the consumed singleton geometries (cloned into the
 * merge); leaves passthrough nodes intact.
 */
export function consolidateSingletonsViaTexArray(nodes) {
  const meshes = [];
  const passthrough = [];
  const buckets = new Map();
  for (const n of nodes) {
    const mat = n && n.material;
    const tex = mat && mat.map;
    const img = tex && tex.image;
    if (!n || !n.isMesh || n.isLOD || !n.geometry || !n.geometry.attributes?.uv || !tex || !img || !img.data) {
      passthrough.push(n);
      continue;
    }
    const w = img.width | 0, h = img.height | 0;
    if (!w || !h) { passthrough.push(n); continue; }
    const lb = (n.userData?.landblockId >>> 0) || 0;
    const key = `${lb}|${w}x${h}|${mat.transparent ? 1 : 0}|${(mat.alphaTest || 0) > 0 ? 1 : 0}`;
    let a = buckets.get(key);
    if (!a) { a = []; buckets.set(key, a); }
    a.push(n);
  }
  for (const [key, bucketNodes] of buckets) {
    if (bucketNodes.length < 2) { passthrough.push(...bucketNodes); continue; }
    try {
      const parts = key.split("|");
      const lb = (Number(parts[0]) >>> 0);
      const [w, h] = parts[1].split("x").map(Number);
      const transparent = parts[2] === "1";
      const alphaTest = parts[3] === "1" ? 0.5 : 0;
      // unique textures -> layer index
      const layerOf = new Map();
      const texList = [];
      for (const n of bucketNodes) {
        const u = n.material.map.uuid;
        if (!layerOf.has(u)) { layerOf.set(u, texList.length); texList.push(n.material.map); }
      }
      // merge geometry (baked transform + aLayer), normalized
      const geos = [];
      const consumed = [];
      for (const n of bucketNodes) {
        n.updateMatrix();
        const g = normalizeForMerge(n.geometry, layerOf.get(n.material.map.uuid));
        if (!g) { passthrough.push(n); continue; }
        g.applyMatrix4(n.matrix);
        geos.push(g);
        consumed.push(n);
      }
      if (geos.length < 2) { for (const g of geos) g.dispose?.(); passthrough.push(...consumed); continue; }
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose?.();
      if (!merged) { passthrough.push(...consumed); continue; }
      const diffArray = buildDiffuseArray(texList, w, h);
      const mat = makeArrayMaterial(diffArray, transparent, alphaTest);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = !!consumed[0].castShadow;
      mesh.receiveShadow = !!consumed[0].receiveShadow;
      mesh.frustumCulled = true;
      mesh.userData = { landblockId: lb, __statAtlas: true, layers: texList.length, props: consumed.length };
      mesh.name = `stat-atlas-lb${lb.toString(16)}-${parts[1]}-x${consumed.length}`;
      meshes.push(mesh);
      // the merged mesh owns its geometry (cloned); free the originals' GPU geometry.
      for (const n of consumed) { try { n.geometry?.dispose?.(); } catch (_) {} }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[static_atlas] bucket failed, passthrough:", String(e?.message ?? e));
      passthrough.push(...bucketNodes);
    }
  }
  return { meshes, passthrough };
}

// ===========================================================================
// CROSS-LANDBLOCK texture-array batching (the real win — ?statAtlas=on).
//
// The per-(LB,size) `consolidateSingletonsViaTexArray` above is a near-no-op:
// within ONE landblock too few singletons share a size bucket. The structure
// is GLOBAL — ~5,400 singletons collapse to ~20 size buckets across the whole
// resident ring. So we bucket by SIZE ONLY (drop the `${lb}|` prefix) and back
// each bucket with ONE persistent THREE.BatchedMesh that spans the ring:
//   - addGeometry/addInstance per singleton → ONE multidraw call per bucket.
//   - per-instance world transform via setMatrixAt (NOT baked into geometry).
//   - the PROVEN sampler2DArray shader (makeArrayMaterial/normalizeForMerge)
//     is reused UNCHANGED — `aLayer` is a per-vertex attribute that BatchedMesh
//     copies into its merged buffer and `optimize()` carries with its vertices.
//
// EVICTION (the hard part): a cross-LB BatchedMesh has NO single landblockId,
// so the LRU per-LB statics scan (landblock_lru step 3) naturally SKIPS it.
// Per-LB removal is done by a dedicated hook `scene3d._evictStaticAtlasForLb`
// (installed below, mirrors `_evictStaticParticlesForLb`) that calls
// `bm.deleteGeometry(gid)` for every gid that LB contributed. deleteGeometry
// flips the geometry+instance to active=false and onBeforeRender drops it from
// the multidraw THE SAME FRAME — no orphan, no wrong render, other LBs' gids
// untouched (ids are integer-keyed, not slot-keyed). The bucket BatchedMesh is
// NEVER disposed on per-LB eviction (it spans the ring). Buffer space freed by
// delete is reclaimed LAZILY via `bm.optimize()` off the per-frame hot path
// (driven from the ~10 Hz PVS tick). Layers are refcounted + recycled.
//
// Re-entry: eviction clears `_atlasBakedLbs[lbKey]`; the per-LB baker's atlas
// feed seam re-feeds the LB's singletons with fresh gids from the recycled pool.
// ===========================================================================

// Per-bucket DataArrayTexture VRAM budget → layer capacity. Pre-allocated fixed
// at creation (a DataArrayTexture cannot grow its layer count in place). The
// spike measured max 123 layers (128×128) and only 353 unique textures total, so
// a memory-bounded capacity comfortably covers every bucket; overflow is fail-soft
// (the offending node falls back to an unbatched singleton — never vanishes).
const _ATLAS_LAYER_BUDGET_BYTES = 32 * 1024 * 1024;
const _ATLAS_MIN_LAYERS = 32;
const _ATLAS_MAX_LAYERS = 256;
const _ATLAS_INIT_VERTS = 1 << 15; // 32,768; grows via setGeometrySize on demand
const _ATLAS_INIT_INST = 1024;     // grows via setInstanceCount on demand
const _ATLAS_OPTIMIZE_FRAC = 0.30; // compact a bucket once >30% of its buffer is dead

// Lazy module state — allocated only when the cross-LB path actually runs (i.e.
// only under ?statAtlas=on). Flag-off, nothing here is ever touched.
const _buckets = new Map();        // bucketKey -> { bm, w, h, transparent, alphaTest }
const _lbMembership = new Map();   // lbKey -> Array<{ bucketKey, gid, texUuid }>
const _atlasBakedLbs = new Set();  // lbKeys whose singletons are live in the buckets
const _dirtyBuckets = new Set();   // buckets with freed geometry awaiting optimize()

function _lbKeyOfId(id) {
  return (((id >>> 0) & 0xffff0000) >>> 0);
}

function _bucketKeyFor(w, h, transparent, alphaTest) {
  return `${w}x${h}|${transparent ? 1 : 0}|${alphaTest > 0 ? 1 : 0}`;
}

function _layerCapacityFor(w, h) {
  const per = Math.max(1, (w | 0) * (h | 0) * 4);
  let c = Math.floor(_ATLAS_LAYER_BUDGET_BYTES / per);
  if (c < _ATLAS_MIN_LAYERS) c = _ATLAS_MIN_LAYERS;
  if (c > _ATLAS_MAX_LAYERS) c = _ATLAS_MAX_LAYERS;
  return c;
}

/** Whether an LB's singletons are currently live in the cross-LB buckets. */
export function hasAtlasLb(lbKey) {
  return _atlasBakedLbs.has((lbKey >>> 0));
}

function _getOrCreateBucket(bucketKey, w, h, transparent, alphaTest, scene3d) {
  let b = _buckets.get(bucketKey);
  if (b) return b;
  const capacity = _layerCapacityFor(w, h);
  const diffArray = buildDiffuseArray([], w, h, capacity);
  const material = makeArrayMaterial(diffArray, transparent, alphaTest);
  const bm = new THREE.BatchedMesh(_ATLAS_INIT_INST, _ATLAS_INIT_VERTS, _ATLAS_INIT_VERTS * 2, material);
  // OPAQUE: skip the per-frame depth sort of every instance (the CPU win we are
  // here for). Transparent buckets keep the sort for correct blending order.
  bm.sortObjects = !!transparent;
  bm.perObjectFrustumCulled = true; // cheap per-instance sphere cull trims the multidraw
  bm.frustumCulled = false;         // the whole batch spans the ring; never cull as one
  bm.castShadow = true;
  bm.receiveShadow = true;
  // NO userData.landblockId — that is what keeps the LRU per-LB statics scan
  // (landblock_lru step 3) from removing/disposing this ring-spanning batch.
  bm.userData = {
    __statAtlasCrossLb: true,
    diffArray,
    layerOf: new Map(),  // texUuid -> { layer, refs }
    freeLayers: [],      // recycled layer indices (pixels overwritten on reuse)
    capacity,
    nextLayer: 0,
    maxVerts: _ATLAS_INIT_VERTS,
    maxInst: _ATLAS_INIT_INST,
    deadVerts: 0,        // vertices in deleted geometries awaiting optimize()
    gidVerts: new Map(), // gid -> vertexCount (to account dead space on delete)
  };
  bm.name = `stat-atlas-x-${bucketKey}`;
  b = { bm, w, h, transparent, alphaTest };
  _buckets.set(bucketKey, b);
  try { scene3d?.staticsGroup?.add(bm); } catch (_) { /* fail-soft */ }
  return b;
}

// addGeometry, growing the vertex buffer on demand (delete never reclaims space;
// optimize() does, lazily). unusedVertexCount is the public free-tail getter.
function _addGeometryGrow(bm, g, vcount) {
  const ud = bm.userData;
  if (bm.unusedVertexCount < vcount) {
    const newMax = Math.max(ud.maxVerts * 2, ud.maxVerts + vcount + 4096);
    bm.setGeometrySize(newMax, newMax * 2);
    ud.maxVerts = newMax;
  }
  return bm.addGeometry(g);
}

// addInstance, growing the instance capacity on demand.
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
 * Feed plain-Mesh static SINGLETON nodes into the GLOBAL (cross-LB) size-bucket
 * BatchedMeshes. Each qualifying node's texture takes a refcounted layer in its
 * bucket's DataArrayTexture; its geometry is added to the bucket BatchedMesh in
 * OBJECT space and its world transform is applied via setMatrixAt. Membership is
 * recorded under the node's lbKey so `evictStaticAtlasForLb` can excise it later.
 *
 * Returns { passthrough }: nodes that couldn't be atlased (no map/uv/image.data,
 * LOD, layer overflow, or any per-node error) — the caller must add these to the
 * scene graph unchanged so props NEVER vanish (fail-soft). The bucket BatchedMeshes
 * self-add to scene3d.staticsGroup on first use; the caller adds only passthrough.
 */
export function addSingletonsToCrossLbAtlas(nodes, scene3d) {
  const passthrough = [];
  // Install the per-LB eviction hook the first time the cross-LB path runs. This
  // only ever executes under ?statAtlas=on, so flag-off the hook stays undefined
  // and the landblock_lru typeof-guard no-ops (byte-identical).
  if (scene3d && scene3d._evictStaticAtlasForLb !== evictStaticAtlasForLb) {
    scene3d._evictStaticAtlasForLb = evictStaticAtlasForLb;
  }
  const touchedDiff = new Set();
  const fedLbs = new Set();
  for (const n of nodes) {
    let handled = false;
    try {
      const mat = n && n.material;
      const tex = mat && mat.map;
      const img = tex && tex.image;
      if (!n || !n.isMesh || n.isLOD || !n.geometry || !n.geometry.attributes?.uv || !tex || !img || !img.data) {
        passthrough.push(n); continue;
      }
      const w = img.width | 0, h = img.height | 0;
      if (!w || !h) { passthrough.push(n); continue; }
      const transparent = !!mat.transparent;
      const alphaTest = (mat.alphaTest || 0) > 0 ? 0.5 : 0;
      const bucketKey = _bucketKeyFor(w, h, transparent, alphaTest);
      const b = _getOrCreateBucket(bucketKey, w, h, transparent, alphaTest, scene3d);
      const bm = b.bm;
      const ud = bm.userData;
      const uuid = tex.uuid;
      // refcounted layer (dedup shared textures across LBs)
      let entry = ud.layerOf.get(uuid);
      if (entry) {
        entry.refs += 1;
      } else {
        let layer;
        if (ud.freeLayers.length > 0) layer = ud.freeLayers.pop();
        else if (ud.nextLayer < ud.capacity) layer = ud.nextLayer++;
        else { passthrough.push(n); continue; } // layer pool full → unbatched (fail-soft)
        const stride = w * h * 4;
        const src = img.data;
        if (src && src.length === stride) ud.diffArray.image.data.set(src, layer * stride);
        entry = { layer, refs: 1 };
        ud.layerOf.set(uuid, entry);
        touchedDiff.add(ud.diffArray);
      }
      const g = normalizeForMerge(n.geometry, entry.layer);
      if (!g) {
        if (--entry.refs <= 0) { ud.freeLayers.push(entry.layer); ud.layerOf.delete(uuid); }
        passthrough.push(n); continue;
      }
      const vcount = g.attributes.position.count;
      let gid;
      try {
        gid = _addGeometryGrow(bm, g, vcount);
      } catch (_) {
        g.dispose?.();
        if (--entry.refs <= 0) { ud.freeLayers.push(entry.layer); ud.layerOf.delete(uuid); }
        passthrough.push(n); continue;
      }
      let iid;
      try {
        iid = _addInstanceGrow(bm, gid);
      } catch (_) {
        try { bm.deleteGeometry(gid); } catch (_2) {}
        g.dispose?.();
        if (--entry.refs <= 0) { ud.freeLayers.push(entry.layer); ud.layerOf.delete(uuid); }
        passthrough.push(n); continue;
      }
      n.updateMatrix();
      bm.setMatrixAt(iid, n.matrix); // world transform (node is staticsGroup-relative)
      ud.gidVerts.set(gid, vcount);
      g.dispose?.(); // copied into the batch buffer; the clone is no longer needed
      const lbKey = _lbKeyOfId(n.userData?.landblockId);
      let list = _lbMembership.get(lbKey);
      if (!list) { list = []; _lbMembership.set(lbKey, list); }
      list.push({ bucketKey, gid, texUuid: uuid });
      fedLbs.add(lbKey);
      // free the consumed source geometry's GPU buffer (mirrors the merge path).
      try { n.geometry?.dispose?.(); } catch (_) {}
      handled = true;
    } catch (e) {
      // per-node fail-soft: fall through to passthrough below.
    }
    if (!handled && n && !passthrough.includes(n)) passthrough.push(n);
  }
  for (const d of touchedDiff) d.needsUpdate = true; // batch the array re-upload once
  for (const k of fedLbs) _atlasBakedLbs.add(k);
  return { passthrough };
}

/**
 * Per-LB eviction hook (installed as scene3d._evictStaticAtlasForLb; called by
 * landblock_lru.evict). Excises every geometry this LB contributed from its
 * cross-LB bucket — same-frame, no rebuild, no orphan — decrefs/recycles its
 * layers, and unmarks the LB so a re-walk re-feeds it. The bucket BatchedMesh
 * itself is never removed (it spans the ring).
 */
export function evictStaticAtlasForLb(lbKey) {
  const key = (lbKey >>> 0);
  const list = _lbMembership.get(key);
  if (!list) return;
  for (const m of list) {
    const b = _buckets.get(m.bucketKey);
    if (!b) continue;
    const bm = b.bm;
    const ud = bm.userData;
    try { bm.deleteGeometry(m.gid); } catch (_) {} // cascades deleteInstance; same-frame drop
    const dead = ud.gidVerts.get(m.gid);
    if (dead) { ud.deadVerts += dead; ud.gidVerts.delete(m.gid); }
    const entry = ud.layerOf.get(m.texUuid);
    if (entry && --entry.refs <= 0) {
      ud.freeLayers.push(entry.layer);
      ud.layerOf.delete(m.texUuid);
    }
    _dirtyBuckets.add(m.bucketKey);
  }
  _lbMembership.delete(key);
  _atlasBakedLbs.delete(key);
}

/**
 * Reclaim freed buffer space in fragmented buckets (deleteGeometry does NOT free
 * space — addGeometry appends; optimize() compacts). Driven LAZILY from the ~10 Hz
 * PVS tick, NOT the per-frame eviction tick. Only compacts a bucket once >30% of
 * its vertex buffer is dead. Compaction preserves geometryIds and carries the
 * aLayer attribute with its vertices, so live gids/instances stay valid.
 */
export function tickStatAtlasOptimize() {
  if (_dirtyBuckets.size === 0) return;
  for (const bucketKey of _dirtyBuckets) {
    const b = _buckets.get(bucketKey);
    if (!b) continue;
    const bm = b.bm;
    const ud = bm.userData;
    if (ud.maxVerts > 0 && ud.deadVerts / ud.maxVerts > _ATLAS_OPTIMIZE_FRAC) {
      try { bm.optimize(); ud.deadVerts = 0; } catch (_) {}
    }
  }
  _dirtyBuckets.clear();
}
