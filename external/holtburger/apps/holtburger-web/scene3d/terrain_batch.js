// scene3d/terrain_batch.js — cross-LB terrain draw consolidation (?terrainBatch=on).
//
// PROBLEM (2026-07-02, live 1070 census at quality=low): terrainGroup holds ~203
// per-LB THREE.Mesh children — one draw submission each pre-frustum — at ~50 µs
// of CPU per draw call. Terrain is the third wall after animated scenery
// (instanced, ca8e5e03) and per-LB static batches: ~203 of the ~800 residual
// calls. Every LB mesh compiles the SAME terrain ShaderMaterial program; the
// only per-LB material state is
//   - uVertexTypes   (9×9 RGBA8 DataTexture: R=terrainCode, G=roadCode*64)
//   - uMergeData     (48×8 RGBA8 TexMerge DataTexture, may be null per LB)
//   - uTexMergeEnabled / uTexMergeAlphaRound (derived from uMergeData presence)
//   - uLbOriginXy    (lbX*192, lbY*192 — wave-phase continuity)
// plus the mesh's own translation. ALL of that folds into per-instance /
// per-vertex data, so the whole resident ring can render as ONE
// THREE.BatchedMesh (one multidraw submission; r184 renderMultiDraw counts 1
// in renderer.info.render.calls and issues 1 GL call):
//   - per-LB translation      → BatchedMesh per-instance matrix
//                               (getBatchingMatrix(getIndirectIndex(gl_DrawID)))
//   - uVertexTypes            → one DataArrayTexture(9, 9, capacity), layer =
//                               slot, selected by a per-vertex aLbSlot attribute
//   - uMergeData              → one DataArrayTexture(48, 8, capacity), same slot
//   - per-LB uTexMergeEnabled → B channel of the LB's vertex-types layer
//                               (legacy writes B=0; the batch writes B=255 when
//                               the LB carries a valid merge texture)
//   - uLbOriginXy             → (batchingMatrix * vec4(position,1)).xy
// The batched material's GLSL is derived from the legacy TERRAIN_*_GLSL strings
// AT RUNTIME via anchored string replacement (the legacy strings are passed in
// by terrain.js and are NOT modified — flag-off compiles byte-identical shader
// source). If any anchor fails to match (future shader edits), batching
// disables itself with one console.warn and every LB falls back to the legacy
// per-LB draw — a failed consolidation is never a vanished landblock.
//
// PROXY DESIGN (why the per-LB meshes stay in the scene graph): ambient audio
// (userData.terrainCodes per tick), the LRU eviction walker, the terrain LOD
// re-bake queue, capture probes and __diag all read terrainGroup.children.
// bakeTerrainForLandblock therefore builds the per-LB mesh EXACTLY as before;
// on successful absorption the mesh attaches with visible=false (a hidden
// data-carrier: three.js projectObject skips it, no VBO is ever uploaded for
// it, prewarm is skipped) and userData.__terrainBatchGid records the batch
// geometry id. On ANY absorb failure the mesh attaches visible (legacy draw)
// — per-LB fail-soft.
//
// EVICTION mirrors static_atlas.js: landblock_lru.evict() and the terrain LOD
// re-bake teardown call the `scene3d._evictTerrainBatchForLb(lbKey)` hook
// (installed on first absorb; absent when the flag is off ⇒ typeof-guard
// no-ops). deleteGeometry drops the LB from the multidraw the same frame;
// slots + layers are recycled; buffer space is reclaimed lazily by
// tickTerrainBatchOptimize() (driven from loop.js next to
// tickStatAtlasOptimize, >30% dead → bm.optimize()).
//
// DEFAULT OFF (`?terrainBatch=on` to enable) pending the 1070 eye-test.
// Wireframe mode (?wireframe=1) is never batched (different material system);
// quality=high LOD re-bakes flow through the eviction hook + re-absorb.

import * as THREE from "three";
import { prewarmSubtree } from "./bake_prewarm.js";

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

let _flag;
/** `?terrainBatch=on` enables the cross-LB terrain BatchedMesh. DEFAULT-OFF
 *  pending the 1070 eye-test; flag-off executes the legacy per-LB path with
 *  byte-identical shader source. */
export function terrainBatchEnabled() {
  if (_flag !== undefined) return _flag;
  let on = true; // DEFAULT-ON (2026-07-03, restored with the statBatchCrossLb re-feed fix); ?terrainBatch=off escapes
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const v = new URLSearchParams(window.location.search).get("terrainBatch");
      if (v != null) {
        const s = v.toLowerCase();
        on = !(s === "off" || s === "0" || s === "false" || s === "no");
      }
    }
  } catch (_) {
    on = false;
  }
  return (_flag = on);
}

// ---------------------------------------------------------------------------
// Capacities. Slots are the hard cap (DataArrayTexture layers cannot grow in
// place): 256 covers the default self-sized LRU cap (~151-203 resident LBs)
// with headroom. Vertex/index buffers grow by doubling (setGeometrySize),
// starting Uint32-indexed (65536 > 65535) so growth never changes index type.
// quality=low: 81 verts / 384 indices per LB → 203 LBs ≈ 16.5k verts.
// quality=high mixed subdiv (9 LBs @ 33², rest 9²) ≈ 26k verts. Both fit the
// initial allocation; re-bake fragmentation is compacted by optimize().
// ---------------------------------------------------------------------------

const TB_SLOT_CAPACITY = 256;
const TB_INIT_VERTS = 1 << 16; // 65,536 → Uint32 batch index from the start
const TB_INIT_INDEX_RATIO = 6; // 9×9 LB: 384 idx / 81 verts ≈ 4.75; subdiv → ~6
const TB_OPTIMIZE_FRAC = 0.3;  // compact once >30% of the used extent is dead
const VT_W = 9, VT_H = 9;          // vertex-types layer dims (bytes: 324)
const MERGE_W = 48, MERGE_H = 8;   // TexMerge layer dims (bytes: 1536)

// ---------------------------------------------------------------------------
// Module state (allocated only when the flag is on AND the first absorb runs;
// flag-off, nothing here is ever touched). Module-local like static_atlas —
// immune to the liveScene3d / scene3dForBuilders dual-facade footgun.
// ---------------------------------------------------------------------------

let _state = null;     // { bm, material, vtArray, mergeArray, mergeEnabled,
                       //   attrNames, freeSlots, nextSlot, byLb: Map,
                       //   gidVerts: Map, usedVerts, deadVerts, dirty,
                       //   maxVerts, maxIndices, passthroughCount }
let _disabled = false; // sticky: anchor/validation failure → legacy forever
const _warned = new Set(); // one console.warn per failure reason

function _warnOnce(reason, detail) {
  if (_warned.has(reason)) return;
  _warned.add(reason);
  // eslint-disable-next-line no-console
  console.warn(`[terrain_batch] ${reason} — falling back to per-LB terrain draws`, detail ?? "");
}

function _lbKeyOf(lbX, lbY) {
  return (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Batched-GLSL derivation. Anchored replacements against the UNTOUCHED legacy
// strings; every anchor must match exactly once or batching disables itself.
// ---------------------------------------------------------------------------

function _replaceOnce(src, anchor, replacement, label) {
  const parts = src.split(anchor);
  if (parts.length !== 2) {
    _warnOnce(`GLSL anchor drift (${label}: ${parts.length - 1} matches)`);
    return null;
  }
  return parts[0] + replacement + parts[1];
}

function _buildBatchedGlsl(vertexGlsl, fragmentGlsl) {
  // --- vertex stage ---
  let v = vertexGlsl;
  // 1. Declarations: slot attribute + varying + the three.js batching chunk
  //    (getBatchingMatrix / getIndirectIndex; USE_BATCHING is auto-defined for
  //    any material rendered on a BatchedMesh, and the renderer binds
  //    batchingTexture / batchingIdTexture itself).
  v = _replaceOnce(
    v,
    "in float vertexHue;",
    [
      "in float vertexHue;",
      "",
      "// ?terrainBatch — cross-LB BatchedMesh variant. Per-LB slot for the",
      "// vertex-types / TexMerge array-texture layers; per-LB translation",
      "// comes from the standard three.js batching matrix below.",
      "in float aLbSlot;",
      "flat out float vLbSlot;",
      "#include <batching_pars_vertex>",
    ].join("\n"),
    "vertex decls",
  );
  if (v == null) return null;
  // 2. World-frame XY (wave phase): batching matrix translation == uLbOriginXy.
  v = _replaceOnce(
    v,
    "  vec2 worldXy = uLbOriginXy + position.xy;",
    [
      "  mat4 lbBatchMat = getBatchingMatrix( getIndirectIndex( gl_DrawID ) );",
      "  vLbSlot = aLbSlot;",
      "  vec2 worldXy = (lbBatchMat * vec4(position, 1.0)).xy;",
    ].join("\n"),
    "vertex worldXy",
  );
  if (v == null) return null;
  // 3. Placement: apply the per-LB translation before model/view (the legacy
  //    path bakes it into modelMatrix via the per-LB mesh position).
  v = _replaceOnce(
    v,
    "  vWorldPos = (modelMatrix * vec4(displacedPos, 1.0)).xyz;\n  vec4 mvPos = modelViewMatrix * vec4(displacedPos, 1.0);",
    [
      "  vec3 lbPlacedPos = (lbBatchMat * vec4(displacedPos, 1.0)).xyz;",
      "  vWorldPos = (modelMatrix * vec4(lbPlacedPos, 1.0)).xyz;",
      "  vec4 mvPos = modelViewMatrix * vec4(lbPlacedPos, 1.0);",
    ].join("\n"),
    "vertex placement",
  );
  if (v == null) return null;

  // --- fragment stage ---
  let f = fragmentGlsl;
  // 4. uVertexTypes: per-LB sampler2D → shared sampler2DArray + slot varying.
  f = _replaceOnce(
    f,
    "uniform sampler2D uVertexTypes;",
    "uniform highp sampler2DArray uVertexTypes;\nflat in float vLbSlot;",
    "frag uVertexTypes decl",
  );
  if (f == null) return null;
  f = _replaceOnce(
    f,
    "  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);",
    "  return int(texelFetch(uVertexTypes, ivec3(iu, iv, int(vLbSlot + 0.5)), 0).r * 255.0 + 0.5);",
    "frag vertexTypeAt",
  );
  if (f == null) return null;
  f = _replaceOnce(
    f,
    "  return texelFetch(uVertexTypes, ivec2(iu, iv), 0).g > 0.125 ? 1.0 : 0.0;",
    "  return texelFetch(uVertexTypes, ivec3(iu, iv, int(vLbSlot + 0.5)), 0).g > 0.125 ? 1.0 : 0.0;",
    "frag vertexRoadAt",
  );
  if (f == null) return null;
  // 5. uMergeData: per-LB sampler2D → shared sampler2DArray.
  f = _replaceOnce(
    f,
    "uniform highp sampler2D uMergeData;",
    "uniform highp sampler2DArray uMergeData;",
    "frag uMergeData decl",
  );
  if (f == null) return null;
  f = _replaceOnce(
    f,
    "vec4 baseTexel = texelFetch(uMergeData, ivec2(colBase, iv), 0);",
    "vec4 baseTexel = texelFetch(uMergeData, ivec3(colBase, iv, int(vLbSlot + 0.5)), 0);",
    "frag merge base fetch",
  );
  if (f == null) return null;
  f = _replaceOnce(
    f,
    "vec4 t = texelFetch(uMergeData, ivec2(colBase + s, iv), 0);",
    "vec4 t = texelFetch(uMergeData, ivec3(colBase + s, iv, int(vLbSlot + 0.5)), 0);",
    "frag merge slot fetch",
  );
  if (f == null) return null;
  // 6. Per-LB merge validity: legacy sets uTexMergeEnabled=0 for an LB without
  //    merge data (bilinear path). The batch keeps the uniform batch-wide and
  //    rides the per-LB bit on the vertex-types layer's B channel (legacy
  //    writes B=0; the batch writes 255 on merge-valid layers).
  f = _replaceOnce(
    f,
    "  if (uTexMergeEnabled > 0.5) {\n    int colBase = iu * 6;",
    "  if (uTexMergeEnabled > 0.5 && texelFetch(uVertexTypes, ivec3(0, 0, int(vLbSlot + 0.5)), 0).b > 0.5) {\n    int colBase = iu * 6;",
    "frag merge gate",
  );
  if (f == null) return null;
  // 7. The analytic road painter is suppressed when the merge road slots are
  //    active — that suppression must also honour the per-LB merge validity
  //    (an LB without merge data keeps its analytic road under ?roadSlots=on).
  f = _replaceOnce(
    f,
    "  if (uRoadEnabled > 0.5 && !(uTexMergeEnabled > 0.5 && uRoadSlotsEnabled > 0.5)) {",
    "  if (uRoadEnabled > 0.5 && !(uTexMergeEnabled > 0.5 && uRoadSlotsEnabled > 0.5 && texelFetch(uVertexTypes, ivec3(0, 0, int(vLbSlot + 0.5)), 0).b > 0.5)) {",
    "frag road gate",
  );
  if (f == null) return null;

  return { vertexShader: v, fragmentShader: f };
}

// ---------------------------------------------------------------------------
// Array-texture helpers
// ---------------------------------------------------------------------------

function _makeDataArray(w, h, layers) {
  const arr = new THREE.DataArrayTexture(new Uint8Array(w * h * 4 * layers), w, h, layers);
  arr.format = THREE.RGBAFormat;
  arr.type = THREE.UnsignedByteType;
  arr.colorSpace = THREE.NoColorSpace; // packed data, not colour (matches the pooled per-LB textures)
  arr.magFilter = THREE.NearestFilter;
  arr.minFilter = THREE.NearestFilter;
  arr.generateMipmaps = false;
  arr.needsUpdate = true;
  return arr;
}

// Copy one LB's vertex-types bytes into its slot layer. mergeValid rides the
// otherwise-unused B channel (see _buildBatchedGlsl step 6).
function _writeVtLayer(state, slot, vtTex, mergeValid) {
  const src = vtTex?.image?.data;
  const stride = VT_W * VT_H * 4;
  if (!src || src.length !== stride || vtTex.image.width !== VT_W || vtTex.image.height !== VT_H) {
    return false;
  }
  const dst = state.vtArray.image.data;
  dst.set(src, slot * stride);
  const b = mergeValid ? 255 : 0;
  for (let i = 0; i < VT_W * VT_H; i += 1) dst[slot * stride + i * 4 + 2] = b;
  state.vtArray.addLayerUpdate(slot);
  state.vtArray.needsUpdate = true;
  return true;
}

// Copy (or zero) one LB's TexMerge bytes into its slot layer. Zeroing is only
// hygiene — the shader's per-LB B-channel gate already skips the block.
function _writeMergeLayer(state, slot, mergeTex) {
  if (!state.mergeArray) return mergeTex == null; // merge disabled batch-wide: only ok if the LB has none
  const stride = MERGE_W * MERGE_H * 4;
  const dst = state.mergeArray.image.data;
  if (mergeTex) {
    const src = mergeTex.image?.data;
    if (!src || src.length !== stride) return false;
    dst.set(src, slot * stride);
  } else {
    dst.fill(0, slot * stride, (slot + 1) * stride);
  }
  state.mergeArray.addLayerUpdate(slot);
  state.mergeArray.needsUpdate = true;
  return true;
}

// ---------------------------------------------------------------------------
// Batched material — a clone of a REAL legacy per-LB ShaderMaterial's uniforms
// (parity by construction: shared textures by ref, mutable math objects
// cloned) with the per-LB entries overridden to their array/batch forms.
// ---------------------------------------------------------------------------

function _cloneUniformValue(v) {
  if (v == null) return v;
  if (v.isTexture) return v;                       // shared atlas/detail/palette/CSM textures
  if (typeof v.clone === "function") return v.clone(); // Vector2/3, Matrix4, Color
  if (Array.isArray(v)) return v.slice();          // int[33] LUT arrays
  if (ArrayBuffer.isView(v)) return v.slice();     // typed-array LUTs
  return v;                                        // numbers / booleans / null
}

function _buildBatchMaterial(srcMaterial, glsl, state, opts, extras) {
  const uniforms = {};
  for (const [name, u] of Object.entries(srcMaterial.uniforms || {})) {
    uniforms[name] = { value: _cloneUniformValue(u ? u.value : null) };
  }
  const mergeOn = !!(state.mergeArray && opts.texMergeEnabled && opts.texMergeAlphaArray);
  uniforms.uVertexTypes = { value: state.vtArray };
  uniforms.uMergeData = { value: state.mergeArray };
  uniforms.uTexMergeEnabled = { value: mergeOn ? 1.0 : 0.0 };
  uniforms.uTexMergeAlphaRound = { value: mergeOn && extras.texMergeAlphaRound ? 1.0 : 0.0 };
  // Unused in the batched GLSL (replaced by the batching matrix); kept for
  // uniform-shape parity. three.js skips upload of optimized-out uniforms.
  uniforms.uLbOriginXy = { value: new THREE.Vector2(0, 0) };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: glsl.vertexShader,
    fragmentShader: glsl.fragmentShader,
    glslVersion: srcMaterial.glslVersion ?? THREE.GLSL3,
    side: srcMaterial.side ?? THREE.FrontSide,
  });
  mat.name = "terrain-batch";
  return mat;
}

// ---------------------------------------------------------------------------
// State creation (first absorb)
// ---------------------------------------------------------------------------

function _createState(scene3d, lbMesh, opts, extras) {
  const glsl = _buildBatchedGlsl(extras.vertexGlsl, extras.fragmentGlsl);
  if (!glsl) return null; // anchors drifted — warned already

  const state = {
    bm: null,
    material: null,
    vtArray: _makeDataArray(VT_W, VT_H, TB_SLOT_CAPACITY),
    mergeArray:
      opts.texMergeEnabled && opts.texMergeAlphaArray
        ? _makeDataArray(MERGE_W, MERGE_H, TB_SLOT_CAPACITY)
        : null,
    attrNames: null,
    freeSlots: [],
    nextSlot: 0,
    byLb: new Map(),     // lbKey -> { gid, iid, slot }
    gidVerts: new Map(), // gid -> vertexCount (dead-space accounting)
    usedVerts: 0,
    deadVerts: 0,
    dirty: false,
    maxVerts: TB_INIT_VERTS,
    maxIndices: TB_INIT_VERTS * TB_INIT_INDEX_RATIO,
    passthroughCount: 0,
  };

  state.material = _buildBatchMaterial(lbMesh.material, glsl, state, opts, extras);

  const bm = new THREE.BatchedMesh(
    TB_SLOT_CAPACITY,
    state.maxVerts,
    state.maxIndices,
    state.material,
  );
  // OPAQUE terrain: skip the per-frame instance depth sort. Per-object frustum
  // culling keeps per-LB cull granularity inside the single multidraw.
  bm.sortObjects = false;
  bm.perObjectFrustumCulled = true;
  bm.frustumCulled = false; // spans the resident ring; never cull as one
  bm.castShadow = false;    // terrain never casts (matches the per-LB meshes)
  bm.receiveShadow = !!(scene3d.shadowsEnabled || scene3d.csmEnabled);
  bm.name = "terrain-batch-x";
  // NO lbX/lbY/subdivLevel in userData: the LRU terrain scan, the LOD re-bake
  // reconcile/teardown walkers and cullTerrainGroup all key on those and must
  // skip this ring-spanning node.
  bm.userData = { __terrainBatchMesh: true };
  state.bm = bm;

  // Registrations — mirror what bakeTerrainForLandblock does per LB:
  // 1. uTime / uSunDir / cloud-shadow per-frame pushes iterate terrainMaterials.
  try {
    if (Array.isArray(scene3d.terrainMaterials) && !scene3d.terrainMaterials.includes(state.material)) {
      scene3d.terrainMaterials.push(state.material);
    }
    const live = typeof window !== "undefined" ? window.liveScene3d : null;
    if (
      live &&
      Array.isArray(live.terrainMaterials) &&
      live.terrainMaterials !== scene3d.terrainMaterials &&
      !live.terrainMaterials.includes(state.material)
    ) {
      live.terrainMaterials.push(state.material);
    }
  } catch (_) { /* fail-soft: water waves lose time updates, nothing breaks */ }
  // 2. CSM refresh walks csmState.patchedMaterials (quality high/ultra only).
  try {
    if (scene3d.csmState?.patchedMaterials) {
      state.material.userData = {
        ...(state.material.userData || {}),
        csmShaderUniforms: state.material.uniforms,
      };
      scene3d.csmState.patchedMaterials.add(state.material);
    }
  } catch (_) { /* fail-soft */ }

  scene3d.terrainGroup.add(bm);

  // Pre-warm the batch program off the first-paint path (fail-soft inside).
  // Fire-and-forget: the absorb path stays synchronous after state creation.
  try { prewarmSubtree(scene3d, bm); } catch (_) { /* lazy-compiles on first render */ }

  // Diag surface for census scripts (window.__terrainBatch.stats()).
  try {
    if (typeof window !== "undefined") {
      window.__terrainBatch = {
        stats: () => ({
          enabled: true,
          instances: state.byLb.size,
          slotsUsed: state.nextSlot - state.freeSlots.length,
          slotCapacity: TB_SLOT_CAPACITY,
          usedVerts: state.usedVerts,
          deadVerts: state.deadVerts,
          maxVerts: state.maxVerts,
          passthrough: state.passthroughCount,
          mergeEnabled: !!state.mergeArray,
        }),
      };
    }
  } catch (_) { /* diag only */ }

  // eslint-disable-next-line no-console
  console.log(
    `[terrain_batch] cross-LB terrain BatchedMesh created (slots=${TB_SLOT_CAPACITY}, ` +
    `verts=${state.maxVerts}, texMerge=${state.mergeArray ? "on" : "off"})`,
  );
  return state;
}

// ---------------------------------------------------------------------------
// Growth helper — checks BOTH the vertex and index free tails (terrain is
// index-heavy: ~4.8-6 indices per vertex, unlike the statics atlas' 2×).
// ---------------------------------------------------------------------------

function _ensureCapacity(state, vcount, icount) {
  const bm = state.bm;
  if (bm.unusedVertexCount >= vcount && bm.unusedIndexCount >= icount) return;
  let newV = state.maxVerts;
  let newI = state.maxIndices;
  while (newV - (state.maxVerts - bm.unusedVertexCount) < vcount) newV *= 2;
  while (newI - (state.maxIndices - bm.unusedIndexCount) < icount) newI *= 2;
  if (newV !== state.maxVerts || newI !== state.maxIndices) {
    bm.setGeometrySize(newV, newI);
    state.maxVerts = newV;
    state.maxIndices = newI;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to absorb one freshly-baked terrain LB mesh into the cross-LB
 * BatchedMesh. Called by bakeTerrainForLandblock AFTER the per-LB mesh (and
 * its userData: vertexTypesTexture / mergeDataTexture / lbX / lbY) is fully
 * built, BEFORE prewarm+attach.
 *
 * On success: marks the mesh hidden (visible=false, userData.__terrainBatchGid)
 * and returns true — the caller still attaches it to terrainGroup as a hidden
 * data-carrier and skips its prewarm. On ANY failure: returns false and the
 * caller runs the untouched legacy path (visible per-LB draw). Never throws.
 *
 * `extras` = { vertexGlsl, fragmentGlsl, texMergeAlphaRound } threaded from
 * terrain.js so this module never imports it (no cycle) and the legacy GLSL
 * string constants stay byte-identical.
 */
export function tryAbsorbTerrainLbIntoBatch(scene3d, lbMesh, opts, extras) {
  if (!terrainBatchEnabled() || _disabled) return false;
  try {
    if (!scene3d?.terrainGroup || !lbMesh || !opts || !extras) return false;
    if (scene3d.wireframeMode) return false;
    const ud = lbMesh.userData;
    if (!ud || typeof ud.lbX !== "number" || typeof ud.lbY !== "number") return false;

    if (!_state) {
      _state = _createState(scene3d, lbMesh, opts, extras);
      if (!_state) {
        _disabled = true; // GLSL anchors drifted; permanent legacy fallback
        return false;
      }
    }
    const state = _state;

    // Install / refresh the per-LB eviction hook on every facade that might
    // drive an eviction or a LOD re-bake teardown (mirrors static_atlas).
    if (scene3d._evictTerrainBatchForLb !== evictTerrainBatchForLb) {
      scene3d._evictTerrainBatchForLb = evictTerrainBatchForLb;
    }
    try {
      const live = typeof window !== "undefined" ? window.liveScene3d : null;
      if (live && live._evictTerrainBatchForLb !== evictTerrainBatchForLb) {
        live._evictTerrainBatchForLb = evictTerrainBatchForLb;
      }
    } catch (_) { /* fail-soft */ }

    const lbKey = _lbKeyOf(ud.lbX, ud.lbY);
    // Re-bake of a still-batched LB (LOD swap raced, or an evict hook was
    // missed): excise the stale entry first so the fresh geometry replaces it.
    if (state.byLb.has(lbKey)) evictTerrainBatchForLb(lbKey);

    // Slot allocation (layer index for both array textures).
    let slot;
    if (state.freeSlots.length > 0) slot = state.freeSlots.pop();
    else if (state.nextSlot < TB_SLOT_CAPACITY) slot = state.nextSlot++;
    else {
      state.passthroughCount += 1;
      _warnOnce("slot capacity exhausted (256 LBs live in batch)", "extra LBs draw per-LB");
      return false;
    }
    const releaseSlot = () => state.freeSlots.push(slot);

    // Per-LB data layers. Merge validity must match what the legacy material
    // would have done: mergeDataTexture is only ever set when texMerge is on
    // AND the wasm mesh carried merge data.
    const mergeTex = ud.mergeDataTexture || null;
    const mergeValid = !!(mergeTex && state.mergeArray);
    if (!_writeVtLayer(state, slot, ud.vertexTypesTexture, mergeValid)) {
      releaseSlot();
      state.passthroughCount += 1;
      _warnOnce("vertex-types texture shape mismatch");
      return false;
    }
    if (!_writeMergeLayer(state, slot, mergeTex)) {
      releaseSlot();
      state.passthroughCount += 1;
      _warnOnce("merge texture shape mismatch");
      return false;
    }

    // Canonical attribute set: decided by the first absorbed geometry
    // (modulation attributes are session-constant — present iff the wasm
    // modulation-ranges table loaded). roadCode is intentionally dropped
    // (unused by the shader; roads ride uVertexTypes.G).
    const srcGeom = lbMesh.geometry;
    if (!srcGeom?.attributes?.position || !srcGeom.index) {
      releaseSlot();
      state.passthroughCount += 1;
      _warnOnce("geometry missing position/index");
      return false;
    }
    if (!state.attrNames) {
      const names = ["position", "normal", "terrainCode"];
      if (srcGeom.getAttribute("vertexBrightness")) {
        names.push("vertexBrightness", "vertexSaturate", "vertexHue");
      }
      state.attrNames = names;
    }
    const shadow = new THREE.BufferGeometry();
    for (const name of state.attrNames) {
      const attr = srcGeom.getAttribute(name);
      if (!attr) {
        releaseSlot();
        state.passthroughCount += 1;
        _warnOnce(`geometry attribute set mismatch (missing ${name})`);
        return false;
      }
      shadow.setAttribute(name, attr); // shared ref; setGeometryAt copies the data out
    }
    const vcount = srcGeom.attributes.position.count;
    shadow.setAttribute(
      "aLbSlot",
      new THREE.BufferAttribute(new Float32Array(vcount).fill(slot), 1, false),
    );
    shadow.setIndex(srcGeom.index);
    // LB-local bounds for the per-instance frustum cull (instance matrix
    // supplies the world placement). The adapter always computes one.
    shadow.boundingSphere = srcGeom.boundingSphere
      ? srcGeom.boundingSphere.clone()
      : null;
    if (!shadow.boundingSphere) shadow.computeBoundingSphere();

    let gid = null;
    let iid = null;
    try {
      _ensureCapacity(state, vcount, srcGeom.index.count);
      gid = state.bm.addGeometry(shadow);
      iid = state.bm.addInstance(gid);
    } catch (e) {
      if (gid != null && iid == null) {
        try { state.bm.deleteGeometry(gid); } catch (_) { /* fail-soft */ }
      }
      releaseSlot();
      state.passthroughCount += 1;
      _warnOnce("BatchedMesh add failed", String(e?.message ?? e));
      return false;
    }
    lbMesh.updateMatrix(); // terrainGroup-relative translation (lbX*192, lbY*192)
    state.bm.setMatrixAt(iid, lbMesh.matrix);

    state.gidVerts.set(gid, vcount);
    state.usedVerts += vcount;
    state.byLb.set(lbKey, { gid, iid, slot });

    // Hide the proxy: it stays in terrainGroup as the userData/LRU/LOD data
    // carrier but never renders (and never uploads its VBOs).
    lbMesh.visible = false;
    ud.__terrainBatchGid = gid;
    return true;
  } catch (e) {
    _warnOnce("absorb threw", String(e?.message ?? e));
    if (_state) _state.passthroughCount += 1;
    return false;
  }
}

/**
 * Per-LB eviction hook (installed as scene3d._evictTerrainBatchForLb; called
 * by landblock_lru.evict and the terrain LOD re-bake teardown). Excises the
 * LB's geometry from the batch — deleteGeometry drops it from the multidraw
 * the same frame — recycles its slot, and leaves the batch mesh itself alone
 * (it spans the ring). The hidden proxy mesh is removed/disposed by the
 * caller's existing per-LB teardown, exactly as in the legacy path.
 */
export function evictTerrainBatchForLb(lbKey) {
  const state = _state;
  if (!state) return;
  const key = ((lbKey >>> 0) & 0xffff0000) >>> 0;
  const entry = state.byLb.get(key);
  if (!entry) return;
  try { state.bm.deleteGeometry(entry.gid); } catch (_) { /* fail-soft */ }
  const dead = state.gidVerts.get(entry.gid);
  if (dead) {
    state.deadVerts += dead;
    state.gidVerts.delete(entry.gid);
  }
  state.freeSlots.push(entry.slot);
  state.byLb.delete(key);
  state.dirty = true;
}

/**
 * Lazy buffer compaction (mirrors tickStatAtlasOptimize): once >30% of the
 * appended vertex extent is dead (deleteGeometry never reclaims space),
 * optimize() compacts in place — geometry ids stay valid and the aLbSlot
 * attribute travels with its vertices. Driven from loop.js's ~10 Hz PVS tick,
 * NOT per-frame.
 */
export function tickTerrainBatchOptimize() {
  const state = _state;
  if (!state || !state.dirty) return;
  state.dirty = false;
  if (state.usedVerts > 0 && state.deadVerts / state.usedVerts > TB_OPTIMIZE_FRAC) {
    try {
      state.bm.optimize();
      state.usedVerts -= state.deadVerts;
      state.deadVerts = 0;
    } catch (_) { /* retry after the next eviction marks dirty again */ }
  }
}
