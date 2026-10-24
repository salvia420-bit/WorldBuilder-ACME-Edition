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
//                               (getBatchingMatrix(getIndirectIndex(gl_DrawID)),
//                               or getBatchingMatrix(aLbIid) under
//                               ?terrainNoDrawId — see NO-gl_DrawID PROGRAM)
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
//
// NO-gl_DrawID PROGRAM (`?terrainNoDrawId`, DEFAULT ON since 2026-10-23, escapes
// off/0/false/no; built 2026-10-22, improvement hunt B10 = findings-round1
// `gl-driver-2`, handoff P1d).
//   WHY [D, ANGLE main read 2026-10-22]. Chrome on Windows has no native
// multi-draw: ANGLE's D3D11 backend loops the ranges (Context11::multiDrawElements,
// MULTI_DRAW_BLOCK). Before each range it calls
// `executable->setDrawIDUniform(drawID)` — but ONLY when
// `executable->hasDrawIDUniform()`, i.e. `drawIDLocation >= 0`, which
// Program::postResolveLink takes from `getUniformLocation("gl_DrawID")`. That
// uniform exists only if the translator emulated the builtin: EmulateGLDrawID
// (tree_ops/EmulateMultiDrawShaderBuiltins.cpp) declares `angle_DrawID` only when
// a symbol with qualifier EvqDrawID is still in the AST, and Compiler.cpp renames
// it to "gl_DrawID" for the uniform list afterwards. Each set goes
// ProgramExecutableD3D::setUniformInternal → mShaderUniformsDirty[Vertex] →
// StateManager11 DIRTY_BIT_PROGRAM_UNIFORMS → applyUniformsForShader →
// UpdateSubresource of the WHOLE vertex default uniform block, before every
// range, plus one reset to 0 after the loop. This program reads gl_DrawID for
// one thing only: `getIndirectIndex( gl_DrawID )`, the instance id whose
// batching matrix places the LB.
//   WHAT. Each LB is exactly one geometry with exactly one instance (every absorb
// adds a fresh `shadow` geometry; nothing here calls addInstance on an existing
// gid or setGeometryIdAt), so the instance id is constant over that geometry's
// vertices. It rides a second per-vertex float, `aLbIid`, written into the
// BATCH's copy of the attribute right after addInstance (the id does not exist
// before it; the shadow carries a zero stand-in so the attribute layout is fixed
// from the first absorb). The vertex stage reads `getBatchingMatrix( aLbIid )`.
// The `#include <batching_pars_vertex>` goes: only the `batchingTexture`
// declaration and three's own getBatchingMatrix are spliced in, lifted from
// THREE.ShaderChunk at state creation (so the texel layout follows three). That
// keeps batched_runs.js's hbBatchSlot() — it reads gl_DrawID — out of the source.
// (ANGLE would prune that uncalled function anyway: pruneUnusedFunctions runs
// before EmulateGLDrawID in TCompiler::checkAndSimplifyAST. A derived source with
// no gl_DrawID token at all does not depend on that.)
//   EXACT. Same matrix texels, same index value (float(iid), exact far below
// 2^24), the same `lbBatchMat * vec4(...)` expressions: pixel-identical by
// construction [D]. Visibility is untouched: three still builds the multidraw
// list from the visible, frustum-passing instances; only the shader stops asking
// which range it is in. optimize() moves aLbIid with the vertices (copyWithin
// over every attribute), setGeometrySize copies every attribute, and instance
// ids survive both. GPU proof: harness/glsl_smoke/terrain_no_drawid_smoke.mjs
// (=on vs off, max channel diff 0, with slots ≠ instance ids after an evict +
// optimize + re-absorb).
//   SHRINKS (CrGpuMain, per terrain multidraw): one setDrawIDUniform and one
// vertex default-uniform-block UpdateSubresource per visible LB range, plus the
// trailing reset [D]. The program also stops sampling `batchingIdTexture`: one
// vertex texture unit fewer, and three binds (so uploads) the indirect texture
// only for a program that declares it (WebGLUniforms.setValue). Renderer main
// thread: nothing (BatchedMesh.onBeforeRender still writes the list). NOT
// removed: every range is still its own D3D11 DrawIndexed. Coalescing
// index-adjacent rows into spans (gl-driver-2's second half) becomes legal once
// nothing depends on the draw index, but is NOT built here. Neither the
// per-range cost nor the visible range count is measured [A]: P0 reads CrGpuMain
// WebGL ms/frame (gpu_thread_split.py) =on vs off on the 1070.
//   FALLBACK. If the chunk anchors do not match (three drift), or the derived
// vertex stage, with its #includes expanded against THREE.ShaderChunk, still
// names gl_DrawID / getIndirectIndex / batchingIdTexture / hbBatchSlot (or has
// an #include that does not resolve), the batch builds today's program and says
// why once (`stats().noDrawIdFallback`). An LB whose aLbIid write fails draws
// per-LB, like any other absorb failure.
//   DIAG. `window.__terrainBatch.stats()`: noDrawId (live), noDrawIdRequested,
// noDrawIdFallback, iidWrites, iidWriteFails, optimizes;
// `window.__terrainBatch.verifyIids()` walks every live row (its aLbIid range
// == its instance id) and counts rows whose slot ≠ instance id.

import * as THREE from "three";
import { prewarmSubtree } from "./bake_prewarm.js";
import { TERRAIN_FX_LIGHT_UNIFORMS } from "./vfx/fx_lights.js";

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

let _noDrawIdFlag;
/** `?terrainNoDrawId` — the batch program without gl_DrawID (see NO-gl_DrawID
 *  PROGRAM in the header). DEFAULT ON since 2026-10-23 (owner, ahead of its 1070
 *  arm): escapes `off`/`0`/`false`/`no` (any case); absent or anything else = on.
 *  Read once. Means nothing without
 *  ?terrainBatch (no batch, no program). */
export function terrainNoDrawIdEnabled() {
  if (_noDrawIdFlag !== undefined) return _noDrawIdFlag;
  let on = true;
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const v = (new URLSearchParams(window.location.search).get("terrainNoDrawId") || "").toLowerCase();
      on = !(v === "off" || v === "0" || v === "false" || v === "no");
    }
  } catch (_) {
    on = true;
  }
  return (_noDrawIdFlag = on);
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
// 2026-10-07 — the terrain shading bevel's retail-normal fetch, legacy and
// batched forms. MUST equal scene3d/terrain_round.js
// TERRAIN_ROUND_FETCH_ANCHOR / _BATCHED (test_terrain_round.mjs asserts it);
// inlined rather than imported so this module stays import-light (the batch
// test evaluates its source with the imports stripped).
const ROUND_FETCH_ANCHOR =
  "  vec2 roundE = texelFetch(uVertexTypes, ivec2(9 + x, y), 0).rg * 2.0 - 1.0;";
const ROUND_FETCH_BATCHED =
  "  vec2 roundE = texelFetch(uVertexTypes, ivec3(9 + x, y, int(vLbSlot + 0.5)), 0).rg * 2.0 - 1.0;";
// 2026-10-19 — ?waterBank / ?waterFlow (scene3d/terrain_water_flow.js): the
// swell weights are read in the VERTEX stage (its own sampler declaration and
// fetch, slot from the aLbSlot attribute), the flow and whitewater in the
// fragment stage. MUST equal the module's *_ANCHOR / *_BATCHED exports
// (test_terrain_water_flow.mjs asserts it); inlined like the bevel's.
const WATER_BANK_VDECL_ANCHOR = "uniform highp sampler2D uVertexTypes;";
const WATER_BANK_VDECL_BATCHED = "uniform highp sampler2DArray uVertexTypes;";
const WATER_BANK_FETCH_ANCHOR = "  return texelFetch(uVertexTypes, ivec2(27 + x, y), 0).r;";
const WATER_BANK_FETCH_BATCHED = "  return texelFetch(uVertexTypes, ivec3(27 + x, y, int(aLbSlot + 0.5)), 0).r;";
const WATER_FLOW_FETCH_ANCHOR = "  vec2 e = texelFetch(uVertexTypes, ivec2(18 + x, y), 0).rg;";
const WATER_FLOW_FETCH_BATCHED = "  vec2 e = texelFetch(uVertexTypes, ivec3(18 + x, y, int(vLbSlot + 0.5)), 0).rg;";
const WATER_FOAM_FETCH_ANCHOR = "  return texelFetch(uVertexTypes, ivec2(27 + x, y), 0).g;";
const WATER_FOAM_FETCH_BATCHED = "  return texelFetch(uVertexTypes, ivec3(27 + x, y, int(vLbSlot + 0.5)), 0).g;";
// 2026-10-07 — with the terrain shading bevel on (scene3d/terrain_round.js)
// the per-LB vertex-types texture is 18 wide (columns 9..17 = retail normals).
// The batch takes the layer width from the first texture it sees
// (`state.vtW`); the width is session-constant.
const MERGE_W = 48, MERGE_H = 8;   // TexMerge layer dims (bytes: 1536)
// 2026-10-22 — ?terrainNoDrawId: the two pieces of three r184's
// batching_pars_vertex the no-gl_DrawID program keeps (header). Lifted from
// THREE.ShaderChunk at state creation, never inlined, so the matrix texel layout
// is always three's own. Each must occur exactly once in the chunk.
const BATCHING_TEX_DECL = "uniform highp sampler2D batchingTexture;";
const BATCHING_MATRIX_FN = "mat4 getBatchingMatrix( const in float i ) {";
// The matrix line of the batched vertex stage, both forms (step 2 below).
const LB_MATRIX_DRAWID = "  mat4 lbBatchMat = getBatchingMatrix( getIndirectIndex( gl_DrawID ) );";
const LB_MATRIX_IID = "  mat4 lbBatchMat = getBatchingMatrix( aLbIid );";
// 2026-10-23 (review b10-terrain-1) — _resolveNoDrawId's guard reads the derived
// vertex stage the way three compiles it: WebGLProgram's includePattern
// (verbatim, r184) expanded against THREE.ShaderChunk. Then none of the draw
// index or the batching_pars_vertex pieces the =on stage leaves out may appear:
// batching_vertex / color_vertex reach getIndirectIndex( gl_DrawID ), or
// hbBatchSlot() once batched_runs.js patched them, and the =on stage declares
// neither (a compile failure with every absorbed LB already hidden).
const GLSL_INCLUDE_RE = /^[ \t]*#include +<([\w\d./]+)>/gm;
const DRAW_INDEX_RE = /gl_DrawID|getIndirectIndex|batchingIdTexture|hbBatchSlot/;

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

/**
 * ?terrainNoDrawId — the part of three's batching_pars_vertex the no-gl_DrawID
 * program keeps: the `batchingTexture` declaration plus getBatchingMatrix, and
 * nothing else (no batchingIdTexture, getIndirectIndex, hbBatchSlot or
 * `_gl_DrawID` fallback). Pure. Returns the GLSL, or null when the chunk does
 * not look like r184's (three drift) — the caller then keeps today's program.
 */
function _batchingMatrixGlsl(pars) {
  if (typeof pars !== "string") return null;
  const d = pars.indexOf(BATCHING_TEX_DECL);
  const f = pars.indexOf(BATCHING_MATRIX_FN);
  if (d < 0 || f < 0) return null;
  if (pars.indexOf(BATCHING_TEX_DECL, d + 1) >= 0 || pars.indexOf(BATCHING_MATRIX_FN, f + 1) >= 0) return null;
  // The function ends at the first tab-indented closing brace line after it
  // (three's chunk formatting; batched_runs.js finds getIndirectIndex's end the
  // same way).
  const end = pars.indexOf("\n\t}\n", f);
  if (end < 0) return null;
  const fn = pars.slice(f, end + "\n\t}".length);
  if (!fn.includes("batchingTexture") || /gl_DrawID|batchingIdTexture|getIndirectIndex|hbBatchSlot/.test(fn)) {
    return null;
  }
  return BATCHING_TEX_DECL + "\n" + fn;
}

/**
 * ?terrainNoDrawId — `src` with every `#include <x>` replaced by `chunks[x]`,
 * recursively (three's resolveIncludes, for the guard only: the material keeps
 * its unexpanded source). Pure. null when a chunk is missing — three would throw
 * at compile time, and the guard cannot vouch for what it cannot read.
 */
function _expandIncludes(src, chunks, depth = 0) {
  if (!chunks || depth > 8) return null;
  let missing = false;
  const out = src.replace(GLSL_INCLUDE_RE, (_, name) => {
    const c = chunks[name];
    const r = typeof c === "string" ? _expandIncludes(c, chunks, depth + 1) : null;
    if (r == null) missing = true;
    return r ?? "";
  });
  return missing ? null : out;
}

/**
 * `noDrawId` (optional): `{ batchingGlsl }` from _batchingMatrixGlsl derives the
 * ?terrainNoDrawId program (steps 1 and 2 differ, every other step is shared).
 * Absent/null: today's program, byte-identical to before the option existed.
 */
function _buildBatchedGlsl(vertexGlsl, fragmentGlsl, noDrawId = null) {
  const iid = !!(noDrawId && typeof noDrawId.batchingGlsl === "string");
  // --- vertex stage ---
  let v = vertexGlsl;
  // 1. Declarations: slot attribute + varying + the three.js batching chunk
  //    (getBatchingMatrix / getIndirectIndex; USE_BATCHING is auto-defined for
  //    any material rendered on a BatchedMesh, and the renderer binds
  //    batchingTexture / batchingIdTexture itself).
  //    ?terrainNoDrawId: the per-vertex instance id and ONLY the matrix half of
  //    the chunk (batchingTexture + getBatchingMatrix) instead of the include.
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
      ...(iid
        ? [
          // (No draw-ID builtin token in these comments either: the derived
          // stage must not name it anywhere — _resolveNoDrawId checks.)
          "// ?terrainNoDrawId — this LB's BatchedMesh instance id, per vertex",
          "// (terrain_batch.js writes it at absorb): the matrix lookup needs no",
          "// draw index, so ANGLE's multi-draw loop sets no draw-ID uniform.",
          "in float aLbIid;",
          noDrawId.batchingGlsl,
        ]
        : ["#include <batching_pars_vertex>"]),
    ].join("\n"),
    "vertex decls",
  );
  if (v == null) return null;
  // 2. World-frame XY (wave phase): batching matrix translation == uLbOriginXy.
  v = _replaceOnce(
    v,
    "  vec2 worldXy = uLbOriginXy + position.xy;",
    [
      iid ? LB_MATRIX_IID : LB_MATRIX_DRAWID,
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
  // 3b. 2026-10-19 — ?waterBank: the vertex stage reads the swell weights off
  //     the same per-LB vertex-types layer (scene3d/terrain_water_flow.js).
  //     Conditional: an absent declaration is the bank being off, not drift.
  if (v.includes(WATER_BANK_VDECL_ANCHOR)) {
    v = _replaceOnce(v, WATER_BANK_VDECL_ANCHOR, WATER_BANK_VDECL_BATCHED, "vertex water bank decl");
    if (v == null) return null;
    v = _replaceOnce(v, WATER_BANK_FETCH_ANCHOR, WATER_BANK_FETCH_BATCHED, "vertex water bank fetch");
    if (v == null) return null;
  }

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
  // 9. 2026-10-07 — terrain shading bevel (scene3d/terrain_round.js): its
  //    retail-normal fetch reads the same per-LB vertex-types layer. Only
  //    present when ?terrainRound / ?terrainBevel are on, hence conditional
  //    (an absent anchor is the bevel being off, not drift).
  if (f.includes(ROUND_FETCH_ANCHOR)) {
    f = _replaceOnce(f, ROUND_FETCH_ANCHOR, ROUND_FETCH_BATCHED, "frag round bevel fetch");
    if (f == null) return null;
  }
  // 10. 2026-10-19 — ?waterFlow: the flow + whitewater fetches read the same
  //     layer. Present only when the flag is on, hence conditional.
  if (f.includes(WATER_FLOW_FETCH_ANCHOR)) {
    f = _replaceOnce(f, WATER_FLOW_FETCH_ANCHOR, WATER_FLOW_FETCH_BATCHED, "frag water flow fetch");
    if (f == null) return null;
    f = _replaceOnce(f, WATER_FOAM_FETCH_ANCHOR, WATER_FOAM_FETCH_BATCHED, "frag water foam fetch");
    if (f == null) return null;
  }

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
  const vtW = state.vtW || VT_W;
  const stride = vtW * VT_H * 4;
  if (!src || src.length !== stride || vtTex.image.width !== vtW || vtTex.image.height !== VT_H) {
    return false;
  }
  const dst = state.vtArray.image.data;
  dst.set(src, slot * stride);
  const b = mergeValid ? 255 : 0;
  const a = gouraudValid ? 255 : 0;
  // B/A of EVERY texel carry the two validity bits; the bevel's normal texels
  // (columns 9..17) and the water flow / swell-weight / whitewater texels
  // (columns 18..35) only use R/G, so this overwrite is harmless to them.
  for (let i = 0; i < vtW * VT_H; i += 1) {
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

// 2026-10-07 — same idea for the 1-component terrain-rounding offset
// (`aRoundZ`, scene3d/terrain_round.js). Separate cache: the key is the vertex
// count and the two stand-ins have different item sizes.
const _zeroFloatAttrCache = new Map();
function _zeroFloatAttr(vcount) {
  let attr = _zeroFloatAttrCache.get(vcount);
  if (!attr) {
    attr = new THREE.BufferAttribute(new Float32Array(vcount), 1, false);
    _zeroFloatAttrCache.set(vcount, attr);
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
  // `?terrainLights` (vfx/fx_lights.js): the FX light feed is three typed arrays the loop
  // rewrites IN PLACE every frame and terrain.js binds BY IDENTITY on every terrain material.
  // The value copy above froze them at their creation-time snapshot (no lights, the gain of
  // that moment), so the batch — the terrain that actually draws — never took a torch pool
  // (1070, 2026-10-11). Share the uniform objects themselves.
  // (`typeof`: test_terrain_batch.mjs evaluates this file with its imports stripped.)
  const fxShared = typeof TERRAIN_FX_LIGHT_UNIFORMS === "object" ? TERRAIN_FX_LIGHT_UNIFORMS : null;
  for (const [name, u] of Object.entries(fxShared || {})) {
    if (srcMaterial.uniforms && srcMaterial.uniforms[name] === u) uniforms[name] = u;
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

// ?terrainNoDrawId: which program this session's batch got, and why not the
// requested one. Its own one-shot warning: `_warnOnce`'s "falling back to per-LB
// terrain draws" would be false here (the batch still batches, with gl_DrawID).
function _resolveNoDrawId(extras) {
  if (!terrainNoDrawIdEnabled()) return { glsl: null, fallback: null };
  let chunks;
  try {
    chunks = THREE && THREE.ShaderChunk ? THREE.ShaderChunk : undefined;
  } catch (_) {
    chunks = undefined;
  }
  let fallback = null;
  let glsl = null;
  const batchingGlsl = _batchingMatrixGlsl(chunks ? chunks.batching_pars_vertex : undefined);
  if (!batchingGlsl) {
    fallback = "three's batching_pars_vertex did not match (getBatchingMatrix / batchingTexture anchors)";
  } else {
    glsl = _buildBatchedGlsl(extras.vertexGlsl, extras.fragmentGlsl, { batchingGlsl });
    // null = a shared anchor drifted: today's derivation fails at the same
    // anchor and disables the batch with its own warning — no extra one here.
    if (glsl) {
      // Scanned with its #includes expanded (GLSL_INCLUDE_RE note). Text inside
      // an #ifdef that is off (color_vertex without batching colours) also
      // counts: a needless fallback, never a broken program.
      const expanded = _expandIncludes(glsl.vertexShader, chunks);
      const hit = expanded == null ? null : DRAW_INDEX_RE.exec(expanded);
      if (expanded == null) {
        fallback = "a #include in the derived vertex stage did not resolve against THREE.ShaderChunk";
      } else if (hit) {
        fallback = `the derived vertex stage still names ${hit[0]} (#includes expanded)`;
      }
      if (fallback) glsl = null;
    }
  }
  if (fallback && !_warned.has("noDrawId")) {
    _warned.add("noDrawId");
    // eslint-disable-next-line no-console
    console.warn(`[terrain_batch] ?terrainNoDrawId: ${fallback} — the batch keeps the gl_DrawID program`);
  }
  return { glsl, fallback };
}

function _createState(scene3d, lbMesh, opts, extras) {
  const nd = _resolveNoDrawId(extras);
  const glsl = nd.glsl || _buildBatchedGlsl(extras.vertexGlsl, extras.fragmentGlsl);
  if (!glsl) return null; // anchors drifted — warned already

  // 2026-10-07 — 9 (pre-wave) or 18 (terrain shading bevel); see VT_W note.
  // 2026-10-19 — or 36 (?waterFlow / ?waterBank, scene3d/terrain_water_flow.js).
  // Any other width would make _writeVtLayer refuse EVERY LB — a silent fall
  // back to per-LB draws — so it is matched explicitly.
  const vtImgW = lbMesh?.userData?.vertexTypesTexture?.image?.width;
  const vtW = vtImgW === VT_W * 2 || vtImgW === VT_W * 4 ? vtImgW : VT_W;
  const state = {
    bm: null,
    material: null,
    vtW,
    vtArray: _makeDataArray(vtW, VT_H, TB_SLOT_CAPACITY),
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
    // 2026-10-07 — terrain corner rounding (scene3d/terrain_round.js). The
    // vertex shader declares `aRoundZ` only when ?terrainRound is on, so this
    // is session-constant for the same reason as the line above. LBs without
    // the attribute (factor-1 fallback after a failed subdivide) present a
    // zero stand-in, which is exactly "not rounded".
    wantsRoundZ: extras.vertexGlsl.includes("aRoundZ"),
    // ?terrainNoDrawId (2026-10-22): the program reads the matrix through the
    // per-vertex `aLbIid`, so every absorb must write it. Session-constant:
    // decided once with the program, before the first geometry fixes the
    // attribute layout.
    noDrawId: !!nd.glsl,
    noDrawIdFallback: nd.fallback,
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
    // optimize() compactions that ran (both programs; the no-gl_DrawID smoke
    // and suite use it to prove aLbIid moved with its vertices).
    optimizes: 0,
    // ?terrainNoDrawId: aLbIid ranges written (one per absorb) and refused
    // (that LB fell back to its per-LB draw).
    iidWrites: 0,
    iidWriteFails: 0,
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
          optimizes: state.optimizes,
          // ?terrainNoDrawId (2026-10-22). `noDrawId` is the LIVE program;
          // requested-but-false means `noDrawIdFallback` says why.
          noDrawId: state.noDrawId,
          noDrawIdRequested: terrainNoDrawIdEnabled(),
          noDrawIdFallback: state.noDrawIdFallback,
          iidWrites: state.iidWrites,
          iidWriteFails: state.iidWriteFails,
        }),
        // O(resident vertices) audit, on demand only (census scripts, smoke).
        verifyIids: () => _verifyIids(state),
      };
    }
  } catch (_) { /* diag only */ }

  // eslint-disable-next-line no-console
  console.log(
    `[terrain_batch] cross-LB terrain BatchedMesh created (slots=${TB_SLOT_CAPACITY}, ` +
    `verts=${state.maxVerts}, texMerge=${state.mergeArray ? "on" : "off"}` +
    `${state.noDrawId ? ", noDrawId=on" : ""})`,
  );
  return state;
}

// ---------------------------------------------------------------------------
// ?terrainNoDrawId — the per-vertex instance id (see the header).
// ---------------------------------------------------------------------------

const _rangeScratch = {};

/**
 * Write `iid` over geometry `gid`'s reserved vertex range in the BATCH's own
 * `aLbIid` attribute (the shadow geometry only carried a zero stand-in: the id
 * is assigned by addInstance, after addGeometry copied the data). The attribute
 * is looked up fresh every time — setGeometrySize replaces `bm.geometry`. The
 * update range overlaps the one setGeometryAt just queued, and three r184 merges
 * overlapping ranges into one bufferSubData (WebGLAttributes.updateBuffer).
 * Returns false (and counts it) on anything unexpected; the caller then drops
 * the row and the LB draws per-LB.
 */
function _writeLbIid(state, gid, iid) {
  try {
    const attr = state.bm.geometry.getAttribute("aLbIid");
    const r = state.bm.getGeometryRangeAt(gid, _rangeScratch);
    const start = r.vertexStart;
    const n = r.reservedVertexCount;
    if (
      !attr || attr.itemSize !== 1 || !Number.isInteger(iid) || iid < 0 || iid >= TB_SLOT_CAPACITY
      || !(start >= 0) || !(n > 0) || start + n > attr.count
    ) {
      state.iidWriteFails += 1;
      return false;
    }
    attr.array.fill(iid, start, start + n);
    attr.addUpdateRange(start, n);
    attr.needsUpdate = true;
    state.iidWrites += 1;
    return true;
  } catch (_) {
    state.iidWriteFails += 1;
    return false;
  }
}

/**
 * Diag audit (`window.__terrainBatch.verifyIids()`): for every live row, the
 * instance still points at the row's geometry and every vertex of that geometry
 * carries the row's instance id. `slotNeIid` counts rows whose layer slot and
 * instance id differ — the case a slot-for-id shortcut would get wrong.
 */
function _verifyIids(state) {
  const out = { enabled: !!state.noDrawId, rows: state.byLb.size, checked: 0, bad: 0, slotNeIid: 0 };
  if (!state.noDrawId) return out;
  let attr = null;
  try { attr = state.bm.geometry.getAttribute("aLbIid"); } catch (_) { attr = null; }
  for (const e of state.byLb.values()) {
    out.checked += 1;
    if (e.slot !== e.iid) out.slotNeIid += 1;
    let ok = !!attr;
    try {
      if (ok && state.bm.getGeometryIdAt(e.iid) !== e.gid) ok = false;
      const r = ok ? state.bm.getGeometryRangeAt(e.gid, {}) : null;
      for (let i = r ? r.vertexStart : 0, end = r ? r.vertexStart + r.vertexCount : 0; ok && i < end; i += 1) {
        if (attr.array[i] !== e.iid) ok = false;
      }
    } catch (_) {
      ok = false;
    }
    if (!ok) out.bad += 1;
  }
  return out;
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
    if (state.wantsRoundZ) {
      names.push("aRoundZ");
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
    if (!attr && name === "aRoundZ") {
      // Zero offset == the retail faceted surface (2026-10-07).
      attr = _zeroFloatAttr(vcount);
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
  if (state.noDrawId) {
    // ?terrainNoDrawId: a zero stand-in (read-only source, shared cache like
    // aRoundZ's) so the attribute exists for addGeometry's layout check; the
    // real instance id is written into the batch's copy once addInstance has
    // assigned it (below).
    shadow.setAttribute("aLbIid", _zeroFloatAttr(vcount));
  }
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
    // ?terrainNoDrawId: without its instance id this LB's vertices would read
    // another row's matrix — never draw it like that; drop the row instead.
    if (state.noDrawId && !_writeLbIid(state, gid, iid)) {
      throw new Error("aLbIid write failed");
    }
  } catch (e) {
    // deleteGeometry also removes the instance (three r184), so this undoes a
    // half-made row whether addInstance or the aLbIid write was the failure.
    if (gid != null) {
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
 * optimize() compacts in place — geometry and instance ids stay valid and the
 * aLbSlot attribute (and ?terrainNoDrawId's aLbIid) travels with its vertices.
 * Driven from loop.js's ~10 Hz PVS tick,
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
      state.optimizes += 1;
    } catch (_) { /* retry after the next eviction marks dirty again */ }
  }
}
