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
/** `?statAtlas=off` escapes the cross-LB texture-array batching of unique-material
 *  STATIC LIT singletons. DEFAULT-ON (2026-06-28). NOTE: the atlas only ever captures
 *  genuinely static lit singletons (`buildSingletonNode` output). Animated scenery
 *  (`isAnimatedScenery` Groups) and additive particle billboards (`particle-unlit-*`)
 *  are a DIFFERENT subsystem and are correctly never fed here — they must keep their
 *  per-frame animation/orientation/blend. See docs/2026-06-28-cross-lb-atlas-feedbug-handoff.md. */
export function statAtlasEnabled() {
  if (_flag !== undefined) return _flag;
  let on = true; // DEFAULT-ON; ?statAtlas=off is the escape hatch (byte-identical legacy path)
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const v = new URLSearchParams(window.location.search).get("statAtlas");
      if (v != null) { const s = v.toLowerCase(); on = !(s === "off" || s === "0" || s === "false" || s === "no"); }
    }
  } catch (_) { on = true; }
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

// === RND-08/33 (2026-07-27) — buckets must carry the EXACT source render state.
// The bucket key used to collapse the members' alpha-test ref to `>0 ? 0.5 : 0`
// and to ignore blending entirely. That was survivable while every ClipMap
// material was `alphaTest = 0.5, transparent = false`; it is not now that
// ClipMap carries retail's per-format ref (100/255 paletted, 200/255 DDS) plus a
// CustomBlending ONE/INVSRCALPHA state (materials.js `applyClipMapRenderState`,
// acclient.c:454497-454511) — the collapse would silently re-cut every atlased
// foliage prop at 0.5 and drop the blend. `_stateKeyOf` therefore encodes the
// ref verbatim and the blend factors, and `_applyStateKey` replays them onto the
// bucket material. `alphaTest` is a uniform (not a define) in three, so the
// distinct refs still share one compiled program.
function _stateKeyOf(mat) {
  const at = +(mat.alphaTest || 0);
  const dw = mat.depthWrite === false ? 0 : 1;
  const b = mat.blending ?? THREE.NormalBlending;
  const blend =
    b === THREE.CustomBlending
      ? `c${mat.blendSrc}.${mat.blendDst}.${mat.blendEquation}`
      : `b${b}`;
  // full precision, not toFixed — the key must round-trip the ref EXACTLY
  // (100/255 and 200/255 are non-terminating) so the bucket material's cutoff
  // is bit-identical to its members'.
  return `${mat.transparent ? 1 : 0}|${String(at)}|${dw}|${blend}`;
}

function _applyStateKey(m, stateKey) {
  const [tr, at, dw, blend] = String(stateKey).split("|");
  m.transparent = tr === "1";
  m.alphaTest = Number(at) || 0;
  m.depthWrite = dw !== "0";
  if (blend && blend[0] === "c") {
    const [s, d, e] = blend.slice(1).split(".").map(Number);
    m.blending = THREE.CustomBlending;
    m.blendSrc = s;
    m.blendDst = d;
    m.blendEquation = e;
  } else {
    m.blending = Number(String(blend).slice(1));
  }
  return m;
}

// MeshStandardMaterial whose `map` is replaced by a sampler2DArray indexed per
// vertex (aLayer). Shares ONE compiled program across buckets (customProgramCacheKey)
// so the array variant compiles once; the array uniform differs per material.
function makeArrayMaterial(diffArray, stateKey) {
  const m = new THREE.MeshStandardMaterial({
    map: dummyMap(),
    side: THREE.DoubleSide,
    roughness: 1.0,
    metalness: 0.0,
  });
  _applyStateKey(m, stateKey);
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
        // onBeforeCompile runs BEFORE three resolves #include directives, so the
        // expanded `vec4 sampledDiffuseColor = texture2D( map, vMapUv );` line
        // does not exist in the source yet — the old replace never matched, the
        // array sampler was optimized out of the linked program
        // (getUniformLocation(uDiffuseArray) === null), and every bucket rendered
        // its 1x1 white dummy `map` instead (the 2026-07-02 white-trees bug,
        // exposed once the origin-sphere cull stopped hiding the buckets). Swap
        // the whole <map_fragment> include at the directive level instead: same
        // diffuse multiply, sampled from the layer array. sRGB decode is
        // hardware-side (SRGB8_ALPHA8 upload path), so no manual EOTF here.
        "#include <map_fragment>",
        [
          "#ifdef USE_MAP",
          "\tvec4 sampledDiffuseColor = texture( uDiffuseArray, vec3( vMapUv, vLayer ) );",
          "\tdiffuseColor *= sampledDiffuseColor;",
          "#endif",
        ].join("\n")
      );
  };
  // All atlas materials share one program; the per-material uDiffuseArray uniform
  // is bound per-draw. Distinct from the stock MeshStandard key so it links once.
  m.customProgramCacheKey = () => "statAtlasArrayMatV2";
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
    const key = `${lb}|${w}x${h}|${_stateKeyOf(mat)}`;
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
      const stateKey = parts.slice(2).join("|");
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
      const mat = makeArrayMaterial(diffArray, stateKey);
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
const _buckets = new Map();        // bucketKey -> { bm, w, h, stateKey }
const _lbMembership = new Map();   // lbKey -> Array<{ bucketKey, gid, texUuid }>
const _atlasBakedLbs = new Set();  // lbKeys whose singletons are live in the buckets

// Diagnostic (2026-07-14): cumulative passthrough-reason tally + per-bucket fullness, so a
// census can see WHY a static stays individual — layer-pool-full (capacity) vs never-fed
// (routing) vs merge-fail. Cheap counters, no behaviour change. Read via window.__atlasStats().
const _atlasStats = { feeds: 0, nodesIn: 0, atlased: 0, ptFiltered: 0, ptDeformed: 0, ptNoWH: 0, ptLayerFull: 0, ptNormFail: 0, ptGeomFail: 0, ptInstFail: 0, ptError: 0 };
if (typeof window !== "undefined") {
  window.__atlasStats = () => ({
    ..._atlasStats,
    bucketCount: _buckets.size,
    atlasBakedLbs: _atlasBakedLbs.size,
    buckets: [..._buckets.entries()].map(([k, b]) => {
      const ud = (b.bm && b.bm.userData) || {};
      return { key: k, w: b.w, h: b.h, stateKey: b.stateKey, nextLayer: ud.nextLayer ?? null,
        capacity: ud.capacity ?? null, layersUsed: ud.layerOf ? ud.layerOf.size : null,
        full: (ud.nextLayer != null && ud.capacity != null) ? ud.nextLayer >= ud.capacity : null };
    }),
  });
}
const _dirtyBuckets = new Set();   // buckets with freed geometry awaiting optimize()

function _lbKeyOfId(id) {
  return (((id >>> 0) & 0xffff0000) >>> 0);
}

function _bucketKeyFor(w, h, stateKey) {
  return `${w}x${h}|${stateKey}`;
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

function _getOrCreateBucket(bucketKey, w, h, stateKey, scene3d) {
  let b = _buckets.get(bucketKey);
  if (b) return b;
  const capacity = _layerCapacityFor(w, h);
  const diffArray = buildDiffuseArray([], w, h, capacity);
  const material = makeArrayMaterial(diffArray, stateKey);
  const bm = new THREE.BatchedMesh(_ATLAS_INIT_INST, _ATLAS_INIT_VERTS, _ATLAS_INIT_VERTS * 2, material);
  // OPAQUE: skip the per-frame depth sort of every instance (the CPU win we are
  // here for). Transparent buckets keep the sort for correct blending order —
  // EXCEPT alpha-tested ones (RND-08/33 made ClipMap `transparent = true`): the
  // surviving texels are ~opaque and z-writes stay on, so their draw order is
  // already independent and re-sorting every foliage instance per frame would
  // hand back the CPU win for nothing.
  bm.sortObjects = material.transparent === true && !(material.alphaTest > 0);
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
    usedVerts: 0,        // total live+dead vertices ever appended (the buffer's used extent;
                         //   deleteGeometry does NOT compact, so this only drops on optimize())
    gidVerts: new Map(), // gid -> vertexCount (to account dead space on delete)
  };
  bm.name = `stat-atlas-x-${bucketKey}`;
  b = { bm, w, h, stateKey };
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
  // Install the per-LB eviction hook on the baker's scene3d (the per-LB walk-in path
  // passes liveScene3d directly; the boot-ring path passes scene3dForBuilders). The
  // LRU reads this hook off liveScene3d, which is ALSO wired deterministically at LRU
  // construction (index.js) so a ring-fed LB evicting before the first per-LB feed still
  // excises (no orphan). ?statAtlas=off ⇒ this never runs ⇒ landblock_lru typeof-guard no-ops.
  if (scene3d && scene3d._evictStaticAtlasForLb !== evictStaticAtlasForLb) {
    scene3d._evictStaticAtlasForLb = evictStaticAtlasForLb;
  }
  const touchedDiff = new Set();
  const fedLbs = new Set();
  _atlasStats.feeds++;
  for (const n of nodes) {
    let handled = false;
    _atlasStats.nodesIn++;
    try {
      const mat = n && n.material;
      const tex = mat && mat.map;
      const img = tex && tex.image;
      if (!n || !n.isMesh || n.isBatchedMesh || n.isLOD || !n.geometry || !n.geometry.attributes?.uv || !tex || !img || !img.data || n.userData?.__staticBatch) {
        _atlasStats.ptFiltered++; passthrough.push(n); continue; // ?staticBatch nodes already batched — never re-feed
      }
      // A MECH-B vertex-deformed variant (deformation.windSwayGpu — swaying
      // trees/foliage) must NOT be consumed: the bucket's array material
      // replaces the node's variant, silently stripping the deformation. That
      // produced the 2026-07-02 "trunk sways, foliage frozen" split — the
      // trunk's surface group hit the ?staticBatch consolidator (variant
      // material kept) while the foliage singleton landed here. Pass it
      // through instead; the singleton keeps its swaying variant. Frag-only
      // (color-effect) sets still atlas — match the deformation prefix only.
      if (typeof mat.userData?.__vfxSetKey === "string" && mat.userData.__vfxSetKey.includes("deformation.")) {
        _atlasStats.ptDeformed++; passthrough.push(n); continue;
      }
      const w = img.width | 0, h = img.height | 0;
      if (!w || !h) { _atlasStats.ptNoWH++; passthrough.push(n); continue; }
      const stateKey = _stateKeyOf(mat);
      const bucketKey = _bucketKeyFor(w, h, stateKey);
      const b = _getOrCreateBucket(bucketKey, w, h, stateKey, scene3d);
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
        else { _atlasStats.ptLayerFull++; passthrough.push(n); continue; } // layer pool full → unbatched (fail-soft)
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
        _atlasStats.ptNormFail++; passthrough.push(n); continue;
      }
      const vcount = g.attributes.position.count;
      let gid;
      try {
        gid = _addGeometryGrow(bm, g, vcount);
      } catch (_) {
        g.dispose?.();
        if (--entry.refs <= 0) { ud.freeLayers.push(entry.layer); ud.layerOf.delete(uuid); }
        _atlasStats.ptGeomFail++; passthrough.push(n); continue;
      }
      let iid;
      try {
        iid = _addInstanceGrow(bm, gid);
      } catch (_) {
        try { bm.deleteGeometry(gid); } catch (_2) {}
        g.dispose?.();
        if (--entry.refs <= 0) { ud.freeLayers.push(entry.layer); ud.layerOf.delete(uuid); }
        _atlasStats.ptInstFail++; passthrough.push(n); continue;
      }
      n.updateMatrix();
      bm.setMatrixAt(iid, n.matrix); // world transform (node is staticsGroup-relative)
      ud.gidVerts.set(gid, vcount);
      ud.usedVerts += vcount; // grow the used-extent denominator for the optimize() trigger
      g.dispose?.(); // copied into the batch buffer; the clone is no longer needed
      const lbKey = _lbKeyOfId(n.userData?.landblockId);
      let list = _lbMembership.get(lbKey);
      if (!list) { list = []; _lbMembership.set(lbKey, list); }
      list.push({ bucketKey, gid, iid, texUuid: uuid }); // iid: Phase 9a park hide/show seam
      fedLbs.add(lbKey);
      // free the consumed source geometry's GPU buffer (mirrors the merge path).
      try { n.geometry?.dispose?.(); } catch (_) {}
      _atlasStats.atlased++;
      handled = true;
    } catch (e) {
      _atlasStats.ptError++;
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
 * Phase 9a warm-park (W4 §3.2): hide an LB's atlas instances WITHOUT
 * deleting geometry — `setVisibleAt(iid, false)` per membership entry.
 * Membership, gids and texture-layer refs are all retained, and the bucket
 * is NOT marked dirty (nothing deleted → the optimize() compactor stays
 * untouched). Pre-iid membership entries (a live session that fed before
 * this landed) are skipped fail-soft — worst case those instances stay
 * visible while parked, never the reverse.
 */
export function parkStaticAtlasForLb(lbKey) {
  const list = _lbMembership.get(lbKey >>> 0);
  if (!list) return 0;
  let hidden = 0;
  for (const m of list) {
    if (m.iid == null) continue;
    const b = _buckets.get(m.bucketKey);
    if (!b) continue;
    try { b.bm.setVisibleAt(m.iid, false); hidden += 1; } catch (_) {}
  }
  return hidden;
}

/** Phase 9a: show a parked LB's atlas instances again (see parkStaticAtlasForLb). */
export function unparkStaticAtlasForLb(lbKey) {
  const list = _lbMembership.get(lbKey >>> 0);
  if (!list) return 0;
  let shown = 0;
  for (const m of list) {
    if (m.iid == null) continue;
    const b = _buckets.get(m.bucketKey);
    if (!b) continue;
    try { b.bm.setVisibleAt(m.iid, true); shown += 1; } catch (_) {}
  }
  return shown;
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
    // Trigger on dead / USED-EXTENT (live+dead actually appended), not / CAPACITY
    // (maxVerts, the pre-allocated/grown buffer size) — capacity over-counts the
    // denominator so a small-but-mostly-dead bucket would never compact. optimize()
    // compacts away the dead verts, so the used extent drops by deadVerts.
    if (ud.usedVerts > 0 && ud.deadVerts / ud.usedVerts > _ATLAS_OPTIMIZE_FRAC) {
      try { bm.optimize(); ud.usedVerts -= ud.deadVerts; ud.deadVerts = 0; } catch (_) {}
    }
  }
  _dirtyBuckets.clear();
}
