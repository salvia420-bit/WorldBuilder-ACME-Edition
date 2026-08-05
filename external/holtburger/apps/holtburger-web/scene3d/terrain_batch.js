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
// PARK (2026-07-28 slot-leak fix). Phase 9a warm-park is DEFAULT-ON and, once
// the LRU is at cap, it REPLACES eviction entirely — a 52-hop @telepoi tour
// measured evicted=0 / parkedTotal=358, i.e. `_evictTerrainBatchForLb` fired
// ZERO times end to end. park() detaches an LB's proxy mesh from terrainGroup
// but left the batch row alive, so every parked LB became a GHOST: still drawn
// by the multidraw at its world position, still holding its slot. Measured
// (BEFORE): resident flat at 32, parked → 347, slotsUsed → 256 (of which 256
// ghosts, `batched` = 0), the exhaustion warning at hop 30, and from that hop
// on EVERY landblock the player actually stands in falls back to a visible
// per-LB draw — which park DOES detach. That is the reported flicker: before
// exhaustion a park is invisible (the ghost keeps painting), after exhaustion
// the same park blanks the landblock until the next unpark re-attaches it, so
// terrain strobes in and out with the at-cap park↔unpark churn.
//
// The fix mirrors static_atlas' park/unpark split, with the extra step the
// hard 256-layer cap forces:
//   - park   → `bm.setVisibleAt(iid, false)`: the row stops drawing THE SAME
//              FRAME the proxy detaches (no ghost), but keeps its slot, so a
//              park↔unpark ping-pong costs two flag writes and never re-uploads
//              geometry.
//   - unpark → `setVisibleAt(iid, true)`, or a re-absorb when the slot was
//              stolen (below), or a visible per-LB draw if even that fails.
//   - slot exhaustion → STEAL the oldest parked (hidden) row instead of
//              falling back forever: parked rows are invisible by definition,
//              so reclaiming one costs nothing on screen and the LB re-absorbs
//              on unpark from the park pool's still-intact bake data. The
//              capacity warning now only fires when the RESIDENT ring alone
//              exceeds 256 LBs — a real signal, not an accumulation artifact.
//
// DEFAULT-ON (2026-07-03 restore; `?terrainBatch=off` escapes).
// Wireframe mode (?wireframe=1) is never batched (different material system);
// quality=high LOD re-bakes flow through the eviction hook + re-absorb.

import * as THREE from "three";
import { prewarmSubtree } from "./bake_prewarm.js";

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

let _flag;
/** `?terrainBatch` — cross-LB terrain BatchedMesh, DEFAULT-ON (2026-07-03);
 *  `=off` executes the legacy per-LB path with byte-identical shader
 *  source. */
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
  // 8. RND-20/21 — PER-LB retail-Gouraud validity (2026-08-03 fix).
  //    `acLightNormal` is NOT session-constant: adapter.js supplies it ONLY
  //    from `subdividedLandblockMeshToGeometry` (:386), never from
  //    `landblockMeshToGeometry` (:288-352), and the LOD ring mixes both in one
  //    resident ring at quality=high. The legacy path decides per LB
  //    (terrain.js seeds uAcGouraudEnabled from `TERRAIN_GOURAUD_ON &&
  //    geom.getAttribute("acLightNormal")`), so the batch must too — a
  //    batch-wide uniform cannot express it.
  //    The bit rides the vertex-types layer's A channel, exactly like merge
  //    validity rides B. A is free: the shader reads only .r (terrain code)
  //    and .g (road code), and BOTH legacy writers store a constant 255
  //    (terrain.js:399 `bytes[dst + 3] = 255`, adapter.js:754), so the batch
  //    writing 0/255 there cannot disturb any other reader.
  f = _replaceOnce(
    f,
    "  bool acGouraud = uAcGouraudEnabled > 0.5;",
    "  bool acGouraud = uAcGouraudEnabled > 0.5 && texelFetch(uVertexTypes, ivec3(0, 0, int(vLbSlot + 0.5)), 0).a > 0.5;",
    "frag gouraud gate",
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

// Copy one LB's vertex-types bytes into its slot layer. Two per-LB validity
// bits ride channels the shader otherwise ignores:
//   B = merge-data validity   (see _buildBatchedGlsl step 6)
//   A = retail-Gouraud validity — i.e. "this LB's geometry carries
//       acLightNormal AND ?terrainGouraud is on" (step 8). Legacy writes a
//       constant 255 into A, so it must be written explicitly here rather than
//       inherited from the copied source bytes.
function _writeVtLayer(state, slot, vtTex, mergeValid, gouraudValid) {
  const src = vtTex?.image?.data;
  const stride = VT_W * VT_H * 4;
  if (!src || src.length !== stride || vtTex.image.width !== VT_W || vtTex.image.height !== VT_H) {
    return false;
  }
  const dst = state.vtArray.image.data;
  dst.set(src, slot * stride);
  const b = mergeValid ? 255 : 0;
  const a = gouraudValid ? 255 : 0;
  for (let i = 0; i < VT_W * VT_H; i += 1) {
    dst[slot * stride + i * 4 + 2] = b;
    dst[slot * stride + i * 4 + 3] = a;
  }
  state.vtArray.addLayerUpdate(slot);
  state.vtArray.needsUpdate = true;
  return true;
}

// Zero-filled `acLightNormal` stand-in for a landblock whose geometry has none
// (the non-subdivided 9x9 path). A BatchedMesh fixes its attribute layout from
// the first geometry admitted, so every later geometry MUST present the same
// set — but the per-LB A-channel gate keeps these zeros from ever being read.
// Cached by vertex count: the ring only ever has a handful of distinct counts.
const _zeroAttrCache = new Map();
function _zeroVec3Attr(vcount) {
  let attr = _zeroAttrCache.get(vcount);
  if (!attr) {
    attr = new THREE.BufferAttribute(new Float32Array(vcount * 3), 3, false);
    _zeroAttrCache.set(vcount, attr);
  }
  return attr;
}

// Copy (or zero) one LB's TexMerge bytes into its slot layer. Zeroing is only
// hygiene — the shader's per-LB B-channel gate already skips the block.
//
// Returns "ok" | "capability" | "shape" rather than a bare boolean: the two
// failure modes are genuinely different and used to share one misleading
// "merge texture shape mismatch" warning. "capability" means the batch-wide
// merge array was never allocated (the FIRST absorb ran before texMerge state
// existed, and `state.mergeArray` is decided once in _createState), so EVERY
// merge-carrying LB for the rest of the session falls out of the batch — a
// session-shaped problem that a "shape mismatch" message actively misdirects.
function _writeMergeLayer(state, slot, mergeTex) {
  if (!state.mergeArray) return mergeTex == null ? "ok" : "capability";
  const stride = MERGE_W * MERGE_H * 4;
  const dst = state.mergeArray.image.data;
  if (mergeTex) {
    const src = mergeTex.image?.data;
    if (!src || src.length !== stride) return "shape";
    dst.set(src, slot * stride);
  } else {
    dst.fill(0, slot * stride, (slot + 1) * stride);
  }
  state.mergeArray.addLayerUpdate(slot);
  state.mergeArray.needsUpdate = true;
  return "ok";
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
    // S1 far-terrain wave (2026-08-02): `fog` is a plain Material field, not a
    // uniform, so the uniform-parity copy above misses it. Without this the
    // DEFAULT-ON batched path would be the ONE terrain draw that never fogs
    // while the (invisible) per-LB proxies did — i.e. the feature would look
    // like it silently did nothing. Inherit it from the per-LB source material.
    fog: srcMaterial.fog === true,
    // Same class of omission as `fog` above, found by the 2026-08-05 1070
    // black-flicker hunt: `defines` is a plain Material field too, so the
    // uniform-parity copy missed it. terrain.js gates its trail-map and CSM
    // sampler DECLARATIONS on HB_TERRAIN_TRAIL_MAP / HB_TERRAIN_CSM; without
    // this line the batched material — the one that actually draws terrain
    // under the default-on ?terrainBatch — would compile the wrong variant of
    // the shader it was cloned from (dropping live CSM cascades, or keeping the
    // dead samplers that overflow this GPU's 16 fragment texture units).
    defines: { ...(srcMaterial.defines || {}) },
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
    // Does the shader declare the retail calc_lighting normal? Session-constant
    // (it is a property of the GLSL source, not of any one landblock), so it is
    // resolved ONCE here and consulted by every absorb — including the unpark
    // re-absorb path, which receives no `extras`.
    wantsAcLightNormal: extras.vertexGlsl.includes("acLightNormal"),
    freeSlots: [],
    nextSlot: 0,
    byLb: new Map(),     // lbKey -> { gid, iid, slot }
    // Warm-park bookkeeping: lbKeys whose row is alive but hidden
    // (setVisibleAt false). Set iteration order == park order, so the first
    // entry is the oldest park — the slot-steal victim.
    parkedLbs: new Set(),
    gidVerts: new Map(), // gid -> vertexCount (dead-space accounting)
    usedVerts: 0,
    deadVerts: 0,
    dirty: false,
    maxVerts: TB_INIT_VERTS,
    maxIndices: TB_INIT_VERTS * TB_INIT_INDEX_RATIO,
    passthroughCount: 0,
    // Unconditional lifecycle counters (NOT flag-gated, NOT debug-gated —
    // the 2026-07-28 root cause was a release path that looked installed and
    // never ran; `parkHides` growing on a live tour is the proof it fires).
    absorbs: 0,
    reabsorbs: 0,
    evicts: 0,
    // Per-LB retail-Gouraud accounting. `gouraudLbs` counts absorbs whose LB
    // carried acLightNormal with the flag on; at quality=high it should track
    // the subdivided sub-ring, and at quality=low it should be 0. A non-zero
    // `gouraudLbs` with uAcGouraudEnabled still 0 would mean the promote path
    // never ran.
    gouraudLbs: 0,
    // Absorbs rejected for a genuinely unexpected attribute set (NOT the
    // acLightNormal case, which is now handled per-LB).
    attrMismatches: 0,
    // Absorbs rejected because this LB carries merge data the batch cannot
    // hold — the batch-wide merge array was never allocated (the first absorb
    // ran before texMerge state existed). Distinct from a real shape mismatch.
    mergeCapabilityMisses: 0,
    mergeShapeMisses: 0,
    parkHides: 0,
    unparkShows: 0,
    unparkReabsorbs: 0,
    unparkFallbacks: 0,
    slotSteals: 0,
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
          // rows whose LB is parked: alive + slot-holding, but hidden
          parkedRows: state.parkedLbs.size,
          // rows actually contributing to the multidraw
          visibleRows: state.byLb.size - state.parkedLbs.size,
          slotsUsed: state.nextSlot - state.freeSlots.length,
          slotCapacity: TB_SLOT_CAPACITY,
          usedVerts: state.usedVerts,
          deadVerts: state.deadVerts,
          maxVerts: state.maxVerts,
          passthrough: state.passthroughCount,
          mergeEnabled: !!state.mergeArray,
          // lifecycle counters — see the state literal for why these are
          // unconditional. parkHides/unparkShows prove the warm-park release
          // path is wired to a facade the LRU actually holds.
          absorbs: state.absorbs,
          reabsorbs: state.reabsorbs,
          evicts: state.evicts,
          // Per-LB retail-Gouraud health (2026-08-03). `gouraudUniform` is the
          // batch-wide enable; `gouraudLbs` is how many absorbed LBs actually
          // presented the attribute. gouraudLbs > 0 with gouraudUniform 0 means
          // the promote path is broken; both 0 at quality=high means no
          // subdivided LB was ever absorbed.
          gouraudUniform: state.material?.uniforms?.uAcGouraudEnabled?.value ?? null,
          gouraudLbs: state.gouraudLbs,
          carriesAcLightNormal: !!state.wantsAcLightNormal,
          attrMismatches: state.attrMismatches,
          mergeCapabilityMisses: state.mergeCapabilityMisses,
          mergeShapeMisses: state.mergeShapeMisses,
          parkHides: state.parkHides,
          unparkShows: state.unparkShows,
          unparkReabsorbs: state.unparkReabsorbs,
          unparkFallbacks: state.unparkFallbacks,
          slotSteals: state.slotSteals,
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
// Hook installation. The LRU calls park/unpark/evict through
// `this.scene3d.<hook>`, and `this.scene3d` is NOT guaranteed to be the same
// facade the terrain bakers hand us (the documented liveScene3d /
// scene3dForBuilders dual-facade footgun — and a hook installed on the wrong
// facade is indistinguishable from a hook that never fires). Install on every
// facade we can reach, INCLUDING the LRU's own scene3d back-reference, which
// is the object that actually dispatches park()/unpark()/evict().
// ---------------------------------------------------------------------------

function _installHooksOn(target) {
  if (!target) return;
  try {
    if (target._evictTerrainBatchForLb !== evictTerrainBatchForLb) {
      target._evictTerrainBatchForLb = evictTerrainBatchForLb;
    }
    if (target._parkTerrainBatchForLb !== parkTerrainBatchForLb) {
      target._parkTerrainBatchForLb = parkTerrainBatchForLb;
    }
    if (target._unparkTerrainBatchForLb !== unparkTerrainBatchForLb) {
      target._unparkTerrainBatchForLb = unparkTerrainBatchForLb;
    }
  } catch (_) { /* fail-soft: frozen/proxied facade */ }
}

function _installHooks(scene3d) {
  _installHooksOn(scene3d);
  try { _installHooksOn(scene3d?.landblockLru?.scene3d); } catch (_) { /* fail-soft */ }
  try {
    const live = typeof window !== "undefined" ? window.liveScene3d : null;
    _installHooksOn(live);
    _installHooksOn(live?.landblockLru?.scene3d);
  } catch (_) { /* fail-soft */ }
}

// ---------------------------------------------------------------------------
// Slot allocation. Free list → fresh layer → STEAL the oldest parked row.
// Parked rows are hidden by definition, so reclaiming one is invisible; the
// LB re-absorbs from the park pool's intact bake data when it unparks (or
// fails soft to a visible per-LB draw). Only a resident ring larger than the
// layer capacity can now exhaust the batch.
// ---------------------------------------------------------------------------

function _allocSlot(state) {
  if (state.freeSlots.length > 0) return state.freeSlots.pop();
  if (state.nextSlot < TB_SLOT_CAPACITY) return state.nextSlot++;
  const victim = state.parkedLbs.values().next().value;
  if (victim !== undefined) {
    evictTerrainBatchForLb(victim);
    state.slotSteals += 1;
    if (state.freeSlots.length > 0) return state.freeSlots.pop();
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Core absorb (state already exists). Shared by the fresh-bake entry point and
// the unpark re-absorb path, which has no `opts`/`extras` to offer: merge
// validity is derived from the mesh's own userData plus whether the batch was
// built with a merge array at all, and the canonical attribute set was fixed
// by the first absorb.
// ---------------------------------------------------------------------------

function _absorbMeshIntoState(state, lbMesh) {
  const ud = lbMesh.userData;
  const lbKey = _lbKeyOf(ud.lbX, ud.lbY);
  // Re-bake of a still-batched LB (LOD swap raced, or an evict hook was
  // missed): excise the stale entry first so the fresh geometry replaces it.
  if (state.byLb.has(lbKey)) evictTerrainBatchForLb(lbKey);

  // Slot allocation (layer index for both array textures).
  const slot = _allocSlot(state);
  if (slot < 0) {
    state.passthroughCount += 1;
    _warnOnce(
      "slot capacity exhausted (256 resident LBs live in batch)",
      "extra LBs draw per-LB",
    );
    return false;
  }
  const releaseSlot = () => state.freeSlots.push(slot);

  // Per-LB data layers. Merge validity must match what the legacy material
  // would have done: mergeDataTexture is only ever set when texMerge is on
  // AND the wasm mesh carried merge data.
  const mergeTex = ud.mergeDataTexture || null;
  const mergeValid = !!(mergeTex && state.mergeArray);
  // RND-20/21 per-LB Gouraud validity. Read the LB's OWN source material,
  // which terrain.js already seeded as `TERRAIN_GOURAUD_ON &&
  // geom.getAttribute("acLightNormal")` — so this is the flag AND the
  // attribute in one read, with no need to know the flag independently.
  const gouraudValid = !!(
    lbMesh.material?.uniforms?.uAcGouraudEnabled?.value > 0
    && lbMesh.geometry?.getAttribute?.("acLightNormal")
  );
  if (!_writeVtLayer(state, slot, ud.vertexTypesTexture, mergeValid, gouraudValid)) {
    releaseSlot();
    state.passthroughCount += 1;
    _warnOnce("vertex-types texture shape mismatch");
    return false;
  }
  const mergeWrite = _writeMergeLayer(state, slot, mergeTex);
  if (mergeWrite !== "ok") {
    releaseSlot();
    state.passthroughCount += 1;
    if (mergeWrite === "capability") {
      state.mergeCapabilityMisses += 1;
      _warnOnce(
        "batch built without a TexMerge array (first absorb preceded texMerge state)",
        "EVERY merge-carrying landblock will draw per-LB for this session",
      );
    } else {
      state.mergeShapeMisses += 1;
      _warnOnce("merge texture shape mismatch");
    }
    return false;
  }

  // Canonical attribute set. The modulation trio IS session-constant (present
  // iff the wasm modulation-ranges table loaded), so it is still decided by the
  // first absorbed geometry; `acLightNormal` is NOT and is handled separately
  // below. roadCode is intentionally dropped (unused by the shader; roads ride
  // uVertexTypes.G).
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
    // RND-20/21 (2026-08-03 fix) — `acLightNormal` is admitted UNCONDITIONALLY
    // when the shader declares it, NOT when the first geometry happens to have
    // it. It is not session-constant (subdivided LBs carry it, base 9x9 LBs do
    // not, and quality=high mixes both in one ring), so keying the canonical
    // set off geometry #1 made the whole session depend on which LB streamed
    // first: either every base LB fell out of the batch as an attribute-set
    // mismatch, or `uAcGouraudEnabled` was latched to 0 batch-wide and every
    // subdivided LB silently lost the retail calc_lighting term. Geometries
    // without the attribute now present a zeroed stand-in and are switched off
    // individually by the A-channel gate.
    // (`wantsAcLightNormal` is resolved once in _createState from the shader
    // source — `extras` is not in scope here: the unpark re-absorb path calls
    // this function with no opts/extras to offer.)
    if (state.wantsAcLightNormal) {
      names.push("acLightNormal");
    }
    state.attrNames = names;
  }
  const vcount = srcGeom.attributes.position.count;
  const shadow = new THREE.BufferGeometry();
  for (const name of state.attrNames) {
    let attr = srcGeom.getAttribute(name);
    if (!attr && name === "acLightNormal") {
      // Never read: this LB's A-channel gate is 0 (see gouraudValid above).
      attr = _zeroVec3Attr(vcount);
    }
    if (!attr) {
      releaseSlot();
      state.passthroughCount += 1;
      state.attrMismatches += 1;
      _warnOnce(`geometry attribute set mismatch (missing ${name})`);
      return false;
    }
    shadow.setAttribute(name, attr); // shared ref; setGeometryAt copies the data out
  }
  // Promote-on-evidence, never demote. The batch material is cloned from ONE
  // LB's material, so a base-mesh first absorb would otherwise pin the uniform
  // at 0 for the session. Raising it here is safe because the per-LB A gate
  // still decides each landblock, and it stays 0 forever when ?terrainGouraud
  // is off (no LB ever presents a non-zero source uniform).
  if (gouraudValid) {
    const gu = state.material?.uniforms?.uAcGouraudEnabled;
    if (gu && gu.value !== 1.0) gu.value = 1.0;
    state.gouraudLbs += 1;
  }
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
  // A fresh row always starts visible: an absorb only ever happens for an LB
  // the loaders just made (or re-made) resident.
  state.parkedLbs.delete(lbKey);

  // Hide the proxy: it stays in terrainGroup as the userData/LRU/LOD data
  // carrier but never renders (and never uploads its VBOs).
  lbMesh.visible = false;
  ud.__terrainBatchGid = gid;
  return true;
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

    // Install / refresh the residency hooks on every facade that might drive
    // an eviction, a park/unpark or a LOD re-bake teardown.
    _installHooks(scene3d);

    const ok = _absorbMeshIntoState(state, lbMesh);
    if (ok) state.absorbs += 1;
    return ok;
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
  state.parkedLbs.delete(key);
  state.dirty = true;
  state.evicts += 1;
}

/**
 * Warm-park hook (installed as scene3d._parkTerrainBatchForLb; called by
 * landblock_lru.park AFTER it detaches the LB's proxy meshes from
 * terrainGroup). Hides the LB's row so the multidraw stops painting it the
 * same frame the proxies leave the scene graph — WITHOUT dropping the row, so
 * an unpark is two flag writes rather than a geometry re-upload (the sealed-
 * purge park↔unpark storm measured thousands of round-trips in 25 s).
 *
 * The slot stays allocated but becomes reclaimable: `_allocSlot` steals the
 * oldest parked row when the layer capacity is otherwise exhausted.
 */
export function parkTerrainBatchForLb(lbKey) {
  const state = _state;
  if (!state) return;
  const key = ((lbKey >>> 0) & 0xffff0000) >>> 0;
  const entry = state.byLb.get(key);
  if (!entry) return;                 // never absorbed (passthrough / flag off)
  if (state.parkedLbs.has(key)) return;
  try { state.bm.setVisibleAt(entry.iid, false); } catch (_) { /* fail-soft */ }
  state.parkedLbs.add(key);
  state.parkHides += 1;
}

/**
 * Warm-park re-attach hook (installed as scene3d._unparkTerrainBatchForLb;
 * called by landblock_lru.unpark AFTER it re-adds the stashed proxy meshes to
 * terrainGroup). `meshes` is the park pool's terrain stash.
 *
 * Three outcomes, in order of cost:
 *   1. the row survived the park  → un-hide it (the common case);
 *   2. the slot was stolen while parked → re-absorb from the stashed proxy
 *      (park disposes nothing, so geometry + vertexTypes/TexMerge textures are
 *      all still live);
 *   3. re-absorb failed → drop the stale batch tag and let the proxy draw
 *      per-LB, exactly like a first-bake absorb failure. Fail-soft: a parked
 *      landblock coming back must never come back INVISIBLE.
 */
export function unparkTerrainBatchForLb(lbKey, meshes) {
  const state = _state;
  if (!state) return;
  const key = ((lbKey >>> 0) & 0xffff0000) >>> 0;
  const entry = state.byLb.get(key);
  if (entry) {
    if (state.parkedLbs.delete(key)) {
      try { state.bm.setVisibleAt(entry.iid, true); } catch (_) { /* fail-soft */ }
      state.unparkShows += 1;
    }
    return;
  }
  // Row gone (slot stolen, or a teardown ran while parked). Only meshes that
  // WERE batched carry __terrainBatchGid; wire-fill companions and never-
  // absorbed passthrough meshes are already drawing themselves.
  if (!Array.isArray(meshes)) return;
  for (const mesh of meshes) {
    const ud = mesh?.userData;
    if (!ud || ud.__terrainBatchGid == null) continue;
    let ok = false;
    try {
      ok = typeof ud.lbX === "number" && typeof ud.lbY === "number"
        && _absorbMeshIntoState(state, mesh);
    } catch (e) {
      _warnOnce("unpark re-absorb threw", String(e?.message ?? e));
      ok = false;
    }
    if (ok) {
      state.reabsorbs += 1;
      state.unparkReabsorbs += 1;
    } else {
      // Legacy per-LB draw. Clearing the tag re-enables cullTerrainGroup for
      // this mesh (it skips anything still tagged as a batched proxy).
      delete ud.__terrainBatchGid;
      mesh.visible = true;
      state.unparkFallbacks += 1;
    }
  }
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
