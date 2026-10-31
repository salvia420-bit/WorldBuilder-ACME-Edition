// scene3d/gpu_batch/interior_batch.js — R3-5 `?interiorBatch` (DEFAULT OFF;
// `=on|1|true|yes` opt-in; `=plan` = census only, no draw change), the GPU
// batch kit's interior consumer (docs/2026-10-29-round3-gpu-driven.md §R3-5;
// design: r3-batching/r3-5/design.md).
//
// TODAY (cells.js buildEnvCellsForLandblock): one draw per geometry group per
// visible interior mesh — each EnvCell's fused opaque surface mesh and every
// cell-static prop. Holtburg, 1070 census 2026-10-30: cell statics 314 + cell
// surfaces 65 draws a frame.
//
// THE BATCH. After a landblock's EnvCell build completed (cells.js calls
// `noteInteriorBatchBuilt` right after `envCellLoadedLbs.add`), every
// eligible cell's fused OPAQUE surface mesh and every eligible cell-static
// prop are merged into per-(landblock, chunk, class, chain, map page, normal
// page) geometries:
//   - vertices pre-transformed to LANDBLOCK-LOCAL space (f64 M * v, minus the
//     landblock origin, stored f32; the cellStaticMerge math), the batch
//     object sits at T(origin) under a worldRoot sibling of cellsGroup;
//   - two extra attributes per vertex: `hbBatchSlot` (the kit layer-state
//     slot: texture layer + per-surface uniforms) and `hbIbCell` (cell-bit
//     row * 4096 + cell * 2 + base cast);
//   - drawn with a kit class material (array pages hold the driver's own mip
//     bytes) that runs the MEMBER'S OWN shader chain (baked vertex light for
//     cells, static depth bias for props, light clamp) — proven by a dry-run
//     fingerprint, not trusted from flags — so lighting, fog and the clamp
//     chain are the same text.
// A town landblock is one chunk; big dungeon landblocks split into ~1 MiB
// chunks (`?interiorBatchChunkKB`).
//
// VISIBILITY BITS. One kit RowTexture (RGBA32F, 32 texels a row, one row per
// chunk, row 0 reserved zero) holds a DRAW row (texels 0-15, read by the
// colour class material) and a CAST row (texels 16-31, read by the batch
// object's customDepthMaterial in the shadow raster), 24 bits per float
// channel = 96 cells a texel = 1536 cells a row. cells.js calls
// `ibNoteVisible(container, v)` right after each of the three places
// tickCellVisibility3D writes `container.visible`, so the bits come from the
// very same per-frame decision (frustum + PView set, the indoor-split
// narrowing, interiorApertureCull, the occlusion verdict). A hidden cell
// collapses to one point in the vertex shader (zero-area triangles). One draw
// row is enough: every pass that draws interiors today draws exactly the
// `container.visible` cells on layer 1, and the batch objects sit on that
// same layer (design T1/T2).
//
// WHAT STAYS. The legacy containers and meshes stay in the graph: raycasts
// (picking, ragdoll), light anchors, occlusion / aperture boxes, the texture
// upgrade queue, the geometry audit and LRU park / evict keep reading them.
// When a chunk is live, its legacy meshes stop DRAWING through a frustum
// sentinel: an own `boundingSphere` with radius -Infinity (three r184
// Frustum.intersectsObject reads an own sphere first, so projectObject and the
// shadow renderObject drop the mesh, while Mesh.raycast, Box3.setFromObject
// and light collection keep using the geometry). Transparent cell surfaces
// stay per cell and sorted.
//
// LIFECYCLE (per chunk): planning (per landblock, cell by cell) -> admitting
// (layers + slots, under the kit upload budget; then the class materials) ->
// warming (class programs linked: shader_prewarm; depth programs linked by a
// private one-shot shadow warm) -> building (only when a cell of the chunk is
// drawn: the bit row and the deferred geometry ticket; a refusal allocates
// nothing) -> merging (entry by entry; the sync that finishes adds every
// object at once) -> overlap (legacy still draws: same surfaces, same colour)
// -> active (once three has drawn every class material of the chunk; then
// the sentinel goes on and one shadow raster is requested). Drift (a texture
// swap, a material change, a context loss, an evict) hands the chunk back to
// legacy within the frame. LRU park / unpark / evict:
// `scene3d.interiorBatchHooks` (the landblock_lru.js patch) plus a per-sync
// reconcile fallback.
//
// WITH THE ENV-CELL DRAW POOLS (`?drawPools`, DEFAULT ON since 2026-10-25;
// realboot fix 2026-10-31: this consumer used to disarm whenever
// pool_envcells.js envCellPoolsActive() was true, i.e. it never ran in the
// shipped configuration). The pools take a cell's SHELL surfaces that the
// class-material registry admits, at build, before fusion: a pooled surface
// never reaches the container (pool_envcells.js offerCellSurfacesToPools ->
// cells.js buckets only the refused ones). What they leave on the legacy
// producer — every cell-static prop (never offered) and the fused
// passthrough surfaces they refuse — is exactly what this batch takes. The
// split is read from the pools' own state, never from names: cells.js stamps
// the offer's per-entry verdict on the container (`ibNotePooled`, `__ibPool`),
// and planning checks it against the container's legacy surface meshes and
// the registry's per-cell instance index (PoolRegistry.readCellState); a cell
// that does not add up keeps its SURFACES legacy (its props still batch). The
// pool BatchedMeshes are cellsGroup children, never container descendants, so
// no candidate walk can reach them; the batch never mutates a pool. Layer and
// pass: unchanged (the batch objects take the containers' layer mask, cells
// on RENDER_LAYER_INDOOR, the same as the "ec" pools). Bits: the pools flip
// per cell from the same tick and the same set (cells.js
// poolCellVisibilityTick, right before the container writes this module
// notes), so DRAW = container.visible = the pool's per-cell PVS state; the
// backstop counts any pool cell whose registry hide state disagrees
// (`stats().pools.visDiverged`: a pools-side divergence, the bits follow the
// container). One known pre-existing exception, flag-independent, legacy LRU
// residency only (`?slotGrid=off`; under the grid the LRU is assert-only): a
// park removes the containers with whatever `visible` they had and unpark
// re-adds them as they were, while the tick's hidden loop only revisits
// `_lastCellVisibleSet` — so a cell visible at the park and out of the set at
// the unpark keeps drawing (legacy) until it re-enters and leaves the set,
// with its pooled half hidden meanwhile. The bits follow the container
// (today's frame; tests/interior_batch_pools.test.mjs Q4 models it).
//
// CPU BUDGET (`?interiorBatchMergeMs`, default 2 ms a sync): planning,
// class-material set-up, program warms and merging share it, each one unit
// at least per sync (a cell, a new class, one program warm, a merged entry;
// merging gets a quarter of the budget at least), so a dungeon arrival
// spreads over frames instead of one long sync. Steady state (every chunk active):
// the visibility notes, the reconcile, the slot drift compares and the bits
// flush — no allocation in this module's own code.
//
// THE UPLOAD-BUDGET CONTRACT (kit.js): layer admits through pages.admit
// (immediate kind), slot / bit-row growth deferred tickets, the merged
// geometry one spendDeferred(bytes, "geometry") ticket per chunk landed by
// three's onUploadCallback (dropped on a teardown before the upload).
//
// POM MEMBERS (2026-10-31; realboot keys, Holtburg ultra: 823 of 1008 cell
// materials carry `|p1|`). Two kinds, told apart by the member's chain DRY
// RUN, never by the key:
//   - FLAG-ONLY p1: the cache clone families cells.js draws with
//     (getCachedStaticBias décor, getCachedCellBaked structure) copy the
//     base's `pomEnabled` flag but not its onBeforeCompile (materials.js
//     _CLONE_LOST_PATCH_FLAGS), so the program key says p1 while the chain is
//     the clone's own patch alone (no POM text, no uPom uniform). They draw
//     WITHOUT parallax today and batch as exactly that: the chain key the
//     class and the batch are keyed by is the member key with its `|p` token
//     set to what the dry run found (`interiorChainKey`), so a flag-only p1
//     member shares its class (and its draw) with the p0 members of the same
//     chain fingerprint.
//   - REAL POM chains (materials.js _installPomShaderPatch on the member,
//     e.g. a base material under `?vertexBake=off`): the class material runs
//     the same POM text with per-slot uniforms (class_materials.js "POM
//     MEMBERS": the height map from a kit R8 page layer, the seven scalars
//     from the slot's POM extension row, layer_state.js), the fingerprint
//     leaves the POM uniform VALUES out (they are slot data, not program
//     state), and the batch splits by height page as it does by map page. A
//     POM member needs its normal map (the POM text calls getTangentFrame);
//     its height texture's re-upload (version) re-plans like a map swap.
//
// FLAG OFF: cells.js runs one constant-false branch per hook site and calls
// nothing here; this module creates no state at import (constant tables only:
// name arrays, one frozen enum, one regex; no Map, Set, WeakMap, typed array
// or THREE object: all of those are created at the first armed call),
// installs no listener, global or hook, and never touches the kit
// (`kitSummary()` stays all-null).
//
// GLSL text below: no backticks, quotes or apostrophes.

import * as THREE from "three";
import {
  kitBudget, kitBeginFrame, kitPages, kitStateTable, kitFlush, kitSummary, kitContextGeneration, kitLiveGeneration,
} from "./kit.js";
import {
  describeTexture, liveContextGeneration, trackContextGenerations, disposeOnLiveContext, LOST_CONTEXT_GENERATION, R8_PLANES,
} from "./array_pages.js";
import { pageKeyOf } from "./page_allocator.js";
import { RowTexture, landblockOrigin } from "./row_texture.js";
import { UPLOAD_KIND, uploadNowMs } from "./upload_budget.js";
import {
  makeClassMaterial, classKeyOf, classPatchMissing, classPrewarmProxy, dummyMap, SLOT_ATTR, STATE_SAMPLER,
  CLASS_ALPHA_TEST_PLACEHOLDER, pomStateOf, POM_NONE, chainFingerprintOf,
} from "./class_materials.js";
import { noRaycast } from "./raycast.js";
import {
  memberProgramKey, memberChainHook, BATCH_REPLAN_LIMIT, BATCH_OVERLAP_GIVEUP_FRAMES, BATCH_WARM_WAIT_FRAMES,
  BATCH_RENDERER_WAIT_FRAMES,
} from "./anim_scenery_batch.js";
import { registerBatchClassPrewarm, prewarmBatchClasses, batchClassWarmedKeys, programsOf, programPending } from "../shader_prewarm.js";
import { requestShadowRaster } from "../interior_shadow_cull.js";
import { envCellPoolsActive } from "../pool_envcells.js";
import { getPoolRegistry } from "../pool_registry.js";

// ===========================================================================
// Constants.
// ===========================================================================

export const IB_CELL_ATTR = "hbIbCell";
export const IB_BITS_SAMPLER = "hbIbBits";
export const IB_MARKER = "HB_INTERIOR_BATCH_BITS";
/** Texels per bit row: 16 DRAW + 16 CAST. */
export const IB_TEXELS_PER_ROW = 32;
/** First texel of the CAST row. */
export const IB_CAST_BASE = 16;
export const IB_BITS_PER_CHANNEL = 24;
export const IB_BITS_PER_TEXEL = 96;
/** Cells one chunk (one bit row) can hold. */
export const IB_CELLS_PER_ROW = 1536;
/**
 * Highest bit row handed out (row 0 reserved). The row field is 12 bits, but
 * the decode reads `int( hbIbCell + 0.5 )` in f32: for a code at or above
 * 2^23 the ulp is 1, so `code + 0.5` rounds to even and an ODD code comes back
 * as code + 1 (the wrong cast bit, or the next cell). Rows below 2048 keep
 * every code under 2^23, where `+ 0.5` is exact (tests/interior_batch_bits).
 */
export const IB_MAX_ROW = 2047;
/**
 * Re-plans of one chunk for a texture swap (a BC7 preview upgraded to its
 * full tier, a sidecar normal map arriving, a POM height re-upload): each happens once per surface,
 * so they get a wider cap than other drift (BATCH_REPLAN_LIMIT).
 */
export const IB_TEXTURE_REPLAN_LIMIT = 64;
/** Syncs between two bit backstops (bits rebuilt from container.visible). */
export const IB_BACKSTOP_SYNCS = 60;
/** Default chunk cap (merged bytes) and per-frame merge budget. */
export const IB_CHUNK_BYTES_DEFAULT = 1024 * 1024;
export const IB_MERGE_MS_DEFAULT = 2;

// The member shader chains a batch may carry: materials.js `_patchSetCacheKey`
// with no detail, CSM, AO, depth or floor bias, VFX or env-detail;
// the light clamp `l`, the static depth bias `s1` (cell décor), the baked
// vertex light `k1` / `k1d` (EnvCell structure) and POM `p1` (header "POM
// MEMBERS": flag-only or the real patch, told apart by the dry run) are
// accepted — each is a pure function of the shader text and constant
// uniforms (POM: plus its per-slot uniforms), and the class material runs the
// member's own chain (proven per member by `chainFingerprint`).
export const INTERIOR_CHAIN_KEY = /^hb\|d0\|c0\|p[01]\|l[01]\|a0\|b0\|f0\|s[01]\|k(0|1d?)\|v$/;

const _NO_EXTRA_MAPS = ["lightMap", "aoMap", "bumpMap", "displacementMap", "roughnessMap", "metalnessMap", "alphaMap", "emissiveMap", "envMap", "specularMap", "gradientMap", "matcap"];
/** The attributes a candidate may carry, in merge order (anything else: ineligible). */
const _ATTR_ORDER = ["position", "normal", "uv", "acBakedLight"];

// ===========================================================================
// The flag.
// ===========================================================================

/**
 * `?interiorBatch`: `on|1|true|yes` -> "on"; `plan` -> "plan"; anything else
 * or absent -> "off". Read once by cells.js at module evaluation.
 */
export function interiorBatchMode(search) {
  let v = null;
  try {
    const s = search !== undefined ? search : globalThis.location?.search;
    if (s) v = new URLSearchParams(s).get("interiorBatch");
  } catch (_) { v = null; }
  const t = String(v ?? "").trim().toLowerCase();
  if (t === "on" || t === "1" || t === "true" || t === "yes") return "on";
  if (t === "plan") return "plan";
  return "off";
}

function _numParam(name, def, min, max) {
  try {
    const s = globalThis.location?.search;
    if (s) {
      const raw = new URLSearchParams(s).get(name);
      if (raw !== null) {
        const v = Number(raw);
        if (Number.isFinite(v) && v >= min && v <= max) return v;
      }
    }
  } catch (_) { /* default */ }
  return def;
}

// ===========================================================================
// Cell bits (pure; the JS mirror of the GLSL decode is node-tested).
// ===========================================================================

/** The per-vertex `hbIbCell` code. */
export function ibPackCell(row, cell, baseCast) {
  return (row | 0) * 4096 + (cell | 0) * 2 + (baseCast ? 1 : 0);
}

/** Inverse of ibPackCell (code < 2^24). */
export function ibUnpackCell(code) {
  const c = Math.trunc(code + 0.5);
  return { row: c >> 12, cell: (c >> 1) & 2047, baseCast: c & 1 };
}

/** Float offset of the channel holding `cell`'s bit in row `row` at texel base `base`. */
export function ibChannelOffset(row, base, cell) {
  const q = (cell / IB_BITS_PER_TEXEL) | 0;
  const w = cell - q * IB_BITS_PER_TEXEL;
  const ch = (w / IB_BITS_PER_CHANNEL) | 0;
  return (row * IB_TEXELS_PER_ROW + base + q) * 4 + ch;
}

/**
 * The bit the vertex shader reads (1 = drawn): `data` is the bit table's
 * Float32Array (IB_TEXELS_PER_ROW texels a row), `code` an `hbIbCell` value,
 * `base` 0 (DRAW) or IB_CAST_BASE (CAST). Mirrors `hbIbHidden` (negated).
 */
export function ibBitOf(data, code, base) {
  const { row, cell } = ibUnpackCell(code);
  const q = (cell / IB_BITS_PER_TEXEL) | 0;
  const w = cell - q * IB_BITS_PER_TEXEL;
  const ch = (w / IB_BITS_PER_CHANNEL) | 0;
  const f = data[(row * IB_TEXELS_PER_ROW + base + q) * 4 + ch];
  return ((f | 0) >> (w - ch * IB_BITS_PER_CHANNEL)) & 1;
}

/** Set (`v` truthy) or clear one bit; returns true when the stored float changed. */
export function ibSetBit(data, row, base, cell, v) {
  const o = ibChannelOffset(row, base, cell);
  const q = (cell / IB_BITS_PER_TEXEL) | 0;
  const w = cell - q * IB_BITS_PER_TEXEL;
  const b = w % IB_BITS_PER_CHANNEL;
  const cur = data[o] | 0;
  const next = v ? (cur | (1 << b)) : (cur & ~(1 << b));
  if (next === cur) return false;
  data[o] = next;
  return true;
}

/** The shared vertex header: the bits sampler, the cell attribute and the decode. */
export function ibVertexHeader() {
  return [
    "// ---- " + IB_MARKER + " (scene3d/gpu_batch/interior_batch.js) ----",
    "uniform highp sampler2D " + IB_BITS_SAMPLER + ";",
    "attribute float " + IB_CELL_ATTR + ";",
    "bool hbIbHidden( int base ) {",
    "  int c = int( " + IB_CELL_ATTR + " + 0.5 );",
    "  int row = c >> 12;",
    "  int bit = ( c >> 1 ) & 2047;",
    "  int q = bit / 96;",
    "  int w = bit - q * 96;",
    "  vec4 t = texelFetch( " + IB_BITS_SAMPLER + ", ivec2( base + q, row ), 0 );",
    "  int ch = w / 24;",
    "  float f = ch == 0 ? t.x : ( ch == 1 ? t.y : ( ch == 2 ? t.z : t.w ) );",
    "  return ( ( int( f ) >> ( w - ch * 24 ) ) & 1 ) == 0;",
    "}",
    "// ---- end " + IB_MARKER + " ----",
    "",
  ].join("\n");
}

export const IB_COLOR_COLLAPSE = "\tif ( hbIbHidden( 0 ) ) transformed = vec3( 0.0 );";
export const IB_DEPTH_COLLAPSE = "\tif ( hbIbHidden( " + IB_CAST_BASE + " ) || ( int( " + IB_CELL_ATTR + " + 0.5 ) & 1 ) == 0 ) transformed = vec3( 0.0 );";

/**
 * The colour class material's vertex hook: the bits header at the top, one
 * collapse right after `#include <begin_vertex>` (makeClassMaterial runs the
 * member chain first, then this, then the class patch). Returns false when
 * the anchor is missing (the class self-check then refuses the class).
 */
export function injectIbColorHook(shader) {
  const vs = shader && shader.vertexShader;
  if (typeof vs !== "string" || vs.indexOf(IB_MARKER) !== -1) return false;
  if (vs.indexOf("#include <begin_vertex>") === -1) return false;
  shader.vertexShader = ibVertexHeader() + vs.replace("#include <begin_vertex>", "#include <begin_vertex>\n" + IB_COLOR_COLLAPSE);
  return true;
}

/**
 * The depth (shadow) material patch, on three's MeshDepthMaterial templates.
 * Opaque: no texture sample, only the CAST collapse. Alpha-tested: the slot
 * row gives the alpha-test ref and the map layer (flat varyings, as the
 * colour class does); the page is sampled exactly where map_fragment sampled
 * the 2D map, and the per-slot ref replaces the material ref. Returns the
 * number of anchors not found (0 = complete).
 */
export function patchIbDepthShader(shader, alpha) {
  let missing = 0;
  let vs = shader.vertexShader;
  let fs = shader.fragmentShader;
  if (vs.indexOf(IB_MARKER) !== -1) return 0;
  if (vs.indexOf("#include <begin_vertex>") === -1) missing += 1;
  vs = vs.replace("#include <begin_vertex>", "#include <begin_vertex>\n" + IB_DEPTH_COLLAPSE);
  let header = ibVertexHeader();
  if (alpha) {
    header += [
      "uniform highp sampler2D " + STATE_SAMPLER + ";",
      "attribute float " + SLOT_ATTR + ";",
      "flat varying vec4 vHbIbS2;",
      "void hbIbSlotSetup() {",
      "  vHbIbS2 = texelFetch( " + STATE_SAMPLER + ", ivec2( 2, int( " + SLOT_ATTR + " + 0.5 ) ), 0 );",
      "}",
      "",
    ].join("\n");
    if (vs.indexOf("void main() {") === -1) missing += 1;
    vs = vs.replace("void main() {", "void main() {\n\thbIbSlotSetup();");
  }
  shader.vertexShader = header + vs;
  if (fs.indexOf("#include <map_fragment>") === -1) missing += 1;
  if (alpha) {
    if (fs.indexOf("#include <alphatest_fragment>") === -1) missing += 1;
    fs = fs
      .replace("#include <map_fragment>", "#ifdef USE_MAP\n\tdiffuseColor *= texture( hbIbMapArr, vec3( vMapUv, vHbIbS2.y ) );\n#endif")
      .replace("#include <alphatest_fragment>", "#ifdef USE_ALPHATEST\n\tif ( diffuseColor.a < vHbIbS2.x ) discard;\n#endif");
    fs = "uniform highp sampler2DArray hbIbMapArr;\nflat varying vec4 vHbIbS2;\n" + fs;
  } else {
    fs = fs.replace("#include <map_fragment>", "");
  }
  shader.fragmentShader = fs;
  return missing;
}

/** Dry run of the depth patch on three's stock depth templates (0 = complete). */
export function depthPatchMissing(alpha) {
  const shader = { vertexShader: THREE.ShaderLib.depth.vertexShader, fragmentShader: THREE.ShaderLib.depth.fragmentShader, uniforms: {}, defines: {} };
  return patchIbDepthShader(shader, !!alpha);
}

// ===========================================================================
// Eligibility (pure; exported for the node suite).
// ===========================================================================

/**
 * Why one candidate MESH cannot batch (null = it can, if its members can).
 * `container` is the cell container it belongs to (its layer mask is the
 * batch object's).
 */
export function interiorMeshReason(mesh, container) {
  if (!mesh || mesh.isMesh !== true) return "not-mesh";
  if (mesh.isInstancedMesh || mesh.isBatchedMesh || mesh.isSkinnedMesh) return "kind";
  // A draw-pool member node (pool_envcells.js stamps `__poolCellId` on what it
  // feeds; a pool owns its geometry): never ours, wherever it hangs.
  if (mesh.userData && mesh.userData.__poolCellId !== undefined) return "pool-member";
  if (mesh.frustumCulled !== true) return "frustum-culled-off";
  if (mesh.visible !== true) return "invisible";
  if (Object.prototype.hasOwnProperty.call(mesh, "boundingSphere")) return "own-sphere";
  if (container && mesh.layers.mask !== container.layers.mask) return "layers";
  if ((mesh.renderOrder | 0) !== 0) return "render-order";
  if (mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender || mesh.onAfterRender !== THREE.Object3D.prototype.onAfterRender) return "render-hooks";
  const g = mesh.geometry;
  if (!g || !g.attributes || !g.attributes.position) return "no-position";
  if (g.morphAttributes && Object.keys(g.morphAttributes).length > 0) return "morph";
  for (const n of Object.keys(g.attributes)) {
    if (_ATTR_ORDER.indexOf(n) === -1) return "attribute:" + n;
    if (g.attributes[n].isInterleavedBufferAttribute) return "interleaved";
  }
  if (!g.attributes.normal || !g.attributes.uv) return "attribute-set";
  if (g.attributes.position.itemSize !== 3 || g.attributes.normal.itemSize !== 3 || g.attributes.uv.itemSize !== 2) return "attribute-layout";
  if (g.index && g.index.isInterleavedBufferAttribute) return "interleaved";
  return null;
}

// Per-member / per-texture caches of the costly eligibility parts: the
// member's program key string (materials.js builds it from ~15 flags) and the
// texture descriptors + page keys (describeTexture allocates and walks the
// mips). Planning a landblock asks for the same few dozen members once per
// drawn range (a dungeon: thousands of ranges). Keyed by what three itself
// re-reads them on: a program key changes only with the member's version (or
// a new chain / key function), a texture's upload state only with its
// version (or a new image); the placement fields describeTexture refuses on
// (channel, offset, repeat, rotation, matrix) are not versioned, so they are
// compared on every hit. Lazy: nothing at import.
let _pkCache = null; // WeakMap member -> { version, obc, cpk, key }
let _texCache = null; // WeakMap texture -> { version, image, ...placement, desc, pageKey }
let _texCacheR8 = null; // the same for R8 planes (the POM height maps: describeTexture with R8_PLANES)

/** memberProgramKey(member), cached per member version + chain + key function. */
export function interiorProgramKeyOf(member) {
  if (!_pkCache) _pkCache = new WeakMap();
  const c = _pkCache.get(member);
  if (c !== undefined && c.version === member.version && c.obc === member.onBeforeCompile && c.cpk === member.customProgramCacheKey) return c.key;
  const key = memberProgramKey(member);
  _pkCache.set(member, { version: member.version, obc: member.onBeforeCompile, cpk: member.customProgramCacheKey, key });
  return key;
}

function _isIdentity3(m) {
  const e = m && m.elements;
  return !!e && e[0] === 1 && e[1] === 0 && e[2] === 0 && e[3] === 0 && e[4] === 1 && e[5] === 0 && e[6] === 0 && e[7] === 0 && e[8] === 1;
}

/**
 * `{ desc, pageKey }` of a texture: describeTexture(tex) and pageKeyOf of it
 * (both null when the texture cannot go into an array page), cached per
 * texture version + image + placement. `r8`: as an R8 plane (a POM height
 * map; describeTexture with R8_PLANES), a separate cache.
 */
export function interiorTextureInfo(tex, r8 = false) {
  if (!tex) return null;
  if (r8) { if (!_texCacheR8) _texCacheR8 = new WeakMap(); } else if (!_texCache) _texCache = new WeakMap();
  const cache = r8 ? _texCacheR8 : _texCache;
  const c = cache.get(tex);
  const off = tex.offset, rep = tex.repeat;
  if (c !== undefined && c.version === tex.version && c.image === tex.image && c.channel === tex.channel
    && c.ox === (off && off.x) && c.oy === (off && off.y) && c.rx === (rep && rep.x) && c.ry === (rep && rep.y)
    && c.rot === tex.rotation && c.ident === _isIdentity3(tex.matrix)) return c;
  const desc = describeTexture(tex, r8 ? R8_PLANES : null);
  const e = {
    version: tex.version, image: tex.image, channel: tex.channel, ox: off && off.x, oy: off && off.y, rx: rep && rep.x, ry: rep && rep.y,
    rot: tex.rotation, ident: _isIdentity3(tex.matrix), desc, pageKey: desc ? pageKeyOf(desc) : null,
  };
  cache.set(tex, e);
  return e;
}

/**
 * The chain key a class and a batch are keyed by: the member's program key
 * with its `|p` token set to what the chain dry run found (`pom` = the
 * fingerprint's POM verdict): a flag-only p1 member (header "POM MEMBERS")
 * keys as the p0 chain it runs.
 */
export function interiorChainKey(member, pom) {
  const k = interiorProgramKeyOf(member) || "";
  if (!k) return k;
  return k.replace(/\|p[01]\|/, pom && pom.pom === true ? "|p1|" : "|p0|");
}

/**
 * Why a member's POM chain cannot batch (null = it can, or it has none):
 * the patch needs the normal map (getTangentFrame), the height map must fit
 * an R8 page.
 */
export function interiorPomReason(member, pom) {
  if (!pom || pom.pom !== true) return null;
  if (!member.normalMap) return "pom-no-normal";
  const ti = interiorTextureInfo(pom.texture, true);
  if (!ti || !ti.desc) return "pom-map-format";
  return null;
}

/** Why one member material cannot join a batch (null = it can). */
export function interiorArrayReason(member) {
  if (!member) return "no-member";
  if (member.type !== "MeshStandardMaterial" || !member.isMeshStandardMaterial || member.isMeshPhysicalMaterial) return "type";
  if (member.visible === false) return "invisible";
  if (member.transparent === true) return "transparent";
  const pk = interiorProgramKeyOf(member);
  if (pk === null || (pk !== "" && !INTERIOR_CHAIN_KEY.test(pk))) return "shader-chain";
  if (member.defines) {
    for (const k of Object.keys(member.defines)) if (k !== "STANDARD" || member.defines[k] !== "") return "defines";
  }
  for (const k of _NO_EXTRA_MAPS) if (member[k]) return "map:" + k;
  if (!member.map) return "no-map";
  const em = member.emissive;
  if (em && (em.r !== 0 || em.g !== 0 || em.b !== 0)) return "luminous";
  if (member.vertexColors || member.flatShading || member.wireframe || member.alphaHash || member.alphaToCoverage || member.premultipliedAlpha) return "feature";
  if (member.clippingPlanes && member.clippingPlanes.length > 0) return "clipping";
  if (member.polygonOffset || member.stencilWrite) return "raster-state";
  if (member.blending !== THREE.NormalBlending && member.blending !== THREE.NoBlending) return "blending";
  if (member.side !== THREE.DoubleSide && member.side !== THREE.FrontSide) return "side";
  if (member.normalMap && member.normalMapType !== THREE.TangentSpaceNormalMap) return "normal-map-type";
  if (!interiorTextureInfo(member.map).desc) return "map-format";
  if (member.normalMap && !interiorTextureInfo(member.normalMap).desc) return "normal-map-format";
  return null;
}

/** The draw class of an eligible member. */
export function interiorMemberClass(member) {
  return {
    blend: member.alphaTest > 0 ? "alphaTest" : "opaque",
    light: member.userData && member.userData.__acBakedLight ? "baked" : "lit",
    side: member.side === THREE.FrontSide ? "front" : "double",
  };
}

/**
 * The non-slot state two members must share to draw through ONE class
 * material (the slot row carries diffuse, opacity, roughness, metalness,
 * normal scale, alpha ref and the layers).
 */
export function interiorMemberSignature(member) {
  const r = member.envMapRotation;
  return [
    member.fog, member.envMapIntensity, member.dithering, member.toneMapped, member.depthTest, member.depthWrite,
    member.depthFunc, member.colorWrite, member.forceSinglePass, member.shadowSide, member.precision, member.blending,
    r ? `${r.x},${r.y},${r.z},${r.order}` : "-",
  ].join("|");
}

// Chain fingerprints. The cache's clone families copy userData flags but not
// every chain (materials.js _CLONE_LOST_PATCH_FLAGS), so the program key of a
// member does not prove what its chain does. The member's chain is run on
// three's stock physical templates; (vertex text, fragment text, defines,
// uniform names + numeric values) is the fingerprint. A texture-valued chain
// uniform (per surface: detail) makes a member ineligible — except the POM
// patch's, whose eight uniforms are slot data (header "POM MEMBERS"): for a
// POM chain of the exact shape the class patch redirects, their names stay in
// the fingerprint and their values do not (the dry run hands them back as
// `pom`); a POM chain of any other shape refuses (`chain-pom-shape`).
let _fpScratch = null;
let _fpCache = null; // WeakMap member -> { version, obc, res } (lazy)

/**
 * The fingerprint of `member`'s chain (`{ fp, pom }`: `pom` = the dry run's
 * POM verdict, POM_NONE or class_materials.js pomInfoFromShader's `{ pom:
 * true, texture, values }`), or `{ reason }` when the chain cannot be shared
 * (throws, texture-valued or opaque uniform, POM text of another shape):
 * class_materials.js chainFingerprintOf of the member's chain hook.
 */
export function chainFingerprint(member) {
  const hook = memberChainHook(member);
  if (hook && !_fpScratch) _fpScratch = new THREE.MeshStandardMaterial();
  return chainFingerprintOf(hook, _fpScratch);
}

function _fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * `{ id, pom }` (a short, session-stable fingerprint id + the POM verdict) or
 * `{ reason }`; cached per member + version + chain.
 */
export function chainFingerprintId(member) {
  if (!_fpCache) _fpCache = new WeakMap();
  const c = _fpCache.get(member);
  if (c && c.version === member.version && c.obc === member.onBeforeCompile) return c.res;
  const r = chainFingerprint(member);
  let res;
  if (r.reason) res = { reason: r.reason };
  else {
    const S = _S;
    const ids = S ? S.fpIds : (_fpIdsLoose || (_fpIdsLoose = new Map()));
    let id = ids.get(r.fp);
    if (!id) {
      const base = _fnv1a(r.fp).toString(16).padStart(8, "0");
      id = base;
      let k = 1;
      const taken = S ? S.fpIdTaken : (_fpTakenLoose || (_fpTakenLoose = new Set()));
      while (taken.has(id)) id = base + "." + (k++);
      taken.add(id);
      ids.set(r.fp, id);
    }
    res = { id, pom: r.pom };
  }
  _fpCache.set(member, { version: member.version, obc: member.onBeforeCompile, res });
  return res;
}
let _fpIdsLoose = null;
let _fpTakenLoose = null;

// ===========================================================================
// Candidates, ranges, merge (pure).
// ===========================================================================

/**
 * The batch candidates of one cell container, in draw order: the cell
 * surface meshes (fused OPAQUE mesh, or under ?envcellFusion=off each
 * non-transparent `surface-*` mesh) inside the mesh group(s), then the
 * cell-static props (plain or ?cellStaticMerge meshes) in child order.
 * Never: the transparent fused mesh, animated props, anchors, companions.
 */
export function interiorCandidatesOf(container) {
  const cells = [];
  const props = [];
  if (!container || !Array.isArray(container.children)) return { cells, props };
  for (const ch of container.children) {
    if (!ch) continue;
    const ud = ch.userData || {};
    if (ch.isMesh === true && (ud.isCellStatic === true || ud.isCellStaticMerged === true)) { props.push(ch); continue; }
    if (ch.isMesh !== true && typeof ch.name === "string" && ch.name.startsWith("mesh-") && Array.isArray(ch.children)) {
      for (const m of ch.children) {
        if (!m || m.isMesh !== true) continue;
        const mu = m.userData || {};
        if (mu.fused === true) { if (mu.fusedKind === "opaque") cells.push({ mesh: m, group: ch }); continue; }
        if (mu.surfaceDid !== undefined && !Array.isArray(m.material) && !(m.material && m.material.transparent === true)) cells.push({ mesh: m, group: ch });
      }
    }
  }
  return { cells, props };
}

/**
 * How many surface groups a cell container's legacy surface meshes hold (the
 * fused opaque + transparent meshes' `surfaceCount`, or one per `surface-*`
 * mesh under ?envcellFusion=off): with the draw pools armed, exactly the
 * groups the pools refused.
 */
export function legacySurfaceCountOf(container) {
  let n = 0;
  if (!container || !Array.isArray(container.children)) return 0;
  for (const ch of container.children) {
    if (!ch || ch.isMesh === true || typeof ch.name !== "string" || !ch.name.startsWith("mesh-") || !Array.isArray(ch.children)) continue;
    for (const m of ch.children) {
      if (!m || m.isMesh !== true) continue;
      const mu = m.userData || {};
      if (mu.fused === true) n += mu.surfaceCount | 0;
      else if (mu.surfaceDid !== undefined) n += 1;
    }
  }
  return n;
}

/**
 * cells.js (IB_ON only), right after a cell's surface groups were offered to
 * the env-cell draw pools (`_offerCellSurfaces`, both fusion shapes): stamps
 * the offer's own per-entry verdict (pool_envcells.js
 * offerCellSurfacesToPools' "was pooled" flags) on the container as
 * `userData.__ibPool = { offered, pooled, legacy, dids }` — the pooled
 * groups never reach the container, the legacy ones are its surface meshes.
 * Non-enumerable (the `__ib` convention: Object.keys / JSON / clone never see
 * it). No module state.
 */
export function ibNotePooled(container, entries, flags) {
  if (!container || !Array.isArray(flags)) return;
  let pooled = 0;
  const dids = [];
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] !== true) continue;
    pooled += 1;
    const g = entries && entries[i] && entries[i].group;
    dids.push(g ? g.surfaceDid >>> 0 : 0);
  }
  if (!container.userData) container.userData = {};
  Object.defineProperty(container.userData, "__ibPool", {
    value: { offered: flags.length, pooled, legacy: flags.length - pooled, dids },
    configurable: true, writable: true, enumerable: false,
  });
}

/**
 * The triangle ranges three r184 draws for `mesh`, as
 * [{ material, start, count }] in INDEX units when indexed, VERTEX units
 * otherwise (projectObject's group resolution, clipped to the draw range;
 * a group whose material is missing is not drawn).
 */
export function drawnRangesOf(mesh) {
  const g = mesh.geometry;
  const total = g.index ? g.index.count : g.attributes.position.count;
  const dr = g.drawRange || { start: 0, count: Infinity };
  const clip = (s, c) => {
    const a = Math.max(s, dr.start);
    const b = Math.min(s + c, dr.start + dr.count, total);
    return b > a ? [a, b - a] : null;
  };
  const out = [];
  if (Array.isArray(mesh.material)) {
    for (const grp of g.groups || []) {
      const mat = mesh.material[grp.materialIndex];
      if (!mat) continue;
      const r = clip(grp.start, grp.count);
      if (r) out.push({ material: mat, start: r[0], count: r[1] });
    }
  } else if (mesh.material) {
    const r = clip(0, total);
    if (r) out.push({ material: mesh.material, start: r[0], count: r[1] });
  }
  return out;
}

// Referenced vertices of one index RANGE (a vertex shared by two groups is
// copied once per group: the slots differ). Cached per index attribute,
// version and range.
let _rangeCache = null; // WeakMap index attr -> Map(`${start}:${count}` -> { version, n, used }) (lazy)
let _mark = null;
let _remap = null;

/**
 * Sorted unique source vertex ids the index names in [start, start+count),
 * a Uint32Array; null for a non-indexed geometry (the range is the vertices
 * themselves); false when the index names a vertex the attributes lack.
 */
export function rangeVerticesOf(geo, start, count) {
  const index = geo.index;
  if (!index) return null;
  const n = geo.attributes.position.count;
  if (!_rangeCache) _rangeCache = new WeakMap();
  let m = _rangeCache.get(index);
  if (!m) { m = new Map(); _rangeCache.set(index, m); }
  const key = `${start}:${count}`;
  const c = m.get(key);
  if (c && c.version === index.version && c.n === n) return c.used;
  if (!_mark || _mark.length < n) _mark = new Uint8Array(Math.max(n, 1024));
  _mark.fill(0, 0, n);
  const src = index.array;
  let k = 0;
  for (let i = start; i < start + count; i += 1) {
    const v = src[i];
    if (v >= n) { k = -1; break; }
    if (_mark[v] === 0) { _mark[v] = 1; k += 1; }
  }
  let used = false;
  if (k >= 0) {
    used = new Uint32Array(k);
    let o = 0;
    for (let v = 0; v < n && o < k; v += 1) if (_mark[v] !== 0) used[o++] = v;
  }
  m.set(key, { version: index.version, n, used });
  return used;
}

/** The attribute layout key of a geometry (names, item sizes, normalized, array types). */
export function layoutOf(geo) {
  const parts = [];
  for (const n of _ATTR_ORDER) {
    const a = geo.attributes[n];
    if (a) parts.push(`${n}:${a.itemSize}:${a.normalized ? 1 : 0}:${a.array.constructor.name}`);
  }
  return parts.join("|");
}

/** Vertex / index counts an entry contributes (after compaction). */
export function entryCounts(e) {
  const g = e.geometry;
  if (g.index) {
    const used = rangeVerticesOf(g, e.start, e.count);
    return { vertices: used ? used.length : 0, indices: e.count };
  }
  return { vertices: e.count, indices: e.count };
}

/**
 * The bytes `mergeChunk(entries, ...)` allocates (and uploads): every layout
 * attribute over the merged (compacted) vertices, `hbBatchSlot` +
 * `hbIbCell` (f32 each), the index (16-bit up to 65,535 vertices, else 32).
 * Arithmetic over the sources, before anything is allocated.
 */
export function chunkBytesOf(entries) {
  if (!entries.length) return 0;
  const g0 = entries[0].geometry;
  let perVertex = 8;
  for (const n of _ATTR_ORDER) {
    const a = g0.attributes[n];
    if (a) perVertex += a.itemSize * a.array.BYTES_PER_ELEMENT;
  }
  let vtx = 0;
  let idx = 0;
  for (const e of entries) {
    const c = entryCounts(e);
    vtx += c.vertices;
    idx += c.indices;
  }
  return vtx * perVertex + idx * (vtx > 65535 ? 4 : 2);
}

let _scr = null; // lazy THREE scratch (nothing at import)
function _scratch() {
  return _scr || (_scr = { v: new THREE.Vector3(), n: new THREE.Matrix3(), a: new THREE.Matrix4(), b: new THREE.Matrix4() });
}

/**
 * Merge `entries` (one batch) into one indexed BufferGeometry in
 * landblock-local space. Entry: `{ geometry, start, count, matrix (container
 * space Matrix4), slot, code }`; `origin` = [x, y, z] (the landblock origin,
 * f64). Positions: fround((M * v) in f64 - origin) — Vector3.applyMatrix4 in
 * f64, the cellStaticMerge math; normals: normalize(N * n) with N =
 * getNormalMatrix(M), operation for operation as cellStaticMerge; uv /
 * acBakedLight verbatim. Triangle order = entry order, then source order.
 * `slices[k]` = entry k's merged vertex and index ranges.
 */
export function mergeChunk(entries, origin) {
  const job = beginMerge(entries, origin);
  mergeStep(job);
  return finishMerge(job);
}

/**
 * A merge that can run over several syncs (the per-sync CPU budget,
 * `?interiorBatchMergeMs`): the output arrays are sized and allocated here
 * (arithmetic over the sources), `mergeStep` fills them entry by entry, and
 * `finishMerge` wraps them in the BufferGeometry. The result is the same
 * bytes whatever the slicing.
 */
export function beginMerge(entries, origin) {
  const g0 = entries[0].geometry;
  const names = _ATTR_ORDER.filter((n) => g0.attributes[n]);
  let vtx = 0;
  let idx = 0;
  for (const e of entries) {
    const c = entryCounts(e);
    vtx += c.vertices;
    idx += c.indices;
  }
  const out = [];
  for (const n of names) {
    const a = g0.attributes[n];
    out.push({ name: n, a, arr: new a.array.constructor(vtx * a.itemSize) });
  }
  const I = vtx > 65535 ? Uint32Array : Uint16Array;
  return {
    entries, origin, names, out, vtx, idx,
    slotArr: new Float32Array(vtx), cellArr: new Float32Array(vtx), ia: new I(idx),
    slices: new Array(entries.length), k: 0, vw: 0, iw: 0,
  };
}

/**
 * Merge the job's next entries; stops once `now() >= deadline` after an
 * entry (at least one entry per call). Returns true when every entry is in.
 */
export function mergeStep(job, deadline = Infinity, now = null) {
  const n = job.entries.length;
  while (job.k < n) {
    _mergeEntry(job, job.k);
    job.k += 1;
    if (deadline !== Infinity && now && now() >= deadline) break;
  }
  return job.k >= n;
}

/** One entry, attribute by attribute (the hot loops read typed arrays only). */
function _mergeEntry(job, k) {
  const e = job.entries[k];
  const g = e.geometry;
  const me = e.matrix.elements;
  const used = g.index ? rangeVerticesOf(g, e.start, e.count) : null;
  const nv = used ? used.length : e.count;
  const vbase = job.vw;
  const start = e.start;
  job.slices[k] = { vertexStart: vbase, vertexCount: nv, indexStart: job.iw, indexCount: e.count };
  for (let a = 0; a < job.out.length; a += 1) {
    const o = job.out[a];
    const src = g.attributes[o.name].array;
    const dst = o.arr;
    if (o.name === "position") {
      // Vector3.applyMatrix4 (three r184), operation for operation, in f64;
      // minus the landblock origin; rounded to f32 by the store.
      const ox = job.origin[0], oy = job.origin[1], oz = job.origin[2];
      const e0 = me[0], e1 = me[1], e2 = me[2], e3 = me[3], e4 = me[4], e5 = me[5], e6 = me[6], e7 = me[7];
      const e8 = me[8], e9 = me[9], e10 = me[10], e11 = me[11], e12 = me[12], e13 = me[13], e14 = me[14], e15 = me[15];
      for (let j = 0; j < nv; j += 1) {
        const v = (used ? used[j] : start + j) * 3;
        const x = src[v], y = src[v + 1], z = src[v + 2];
        const w = 1 / (e3 * x + e7 * y + e11 * z + e15);
        const d = (vbase + j) * 3;
        dst[d] = (e0 * x + e4 * y + e8 * z + e12) * w - ox;
        dst[d + 1] = (e1 * x + e5 * y + e9 * z + e13) * w - oy;
        dst[d + 2] = (e2 * x + e6 * y + e10 * z + e14) * w - oz;
      }
    } else if (o.name === "normal") {
      // normalize(getNormalMatrix(M) * n): Vector3.applyMatrix3 then
      // normalize (divideScalar(length() || 1)), operation for operation.
      const ne = _scratch().n.getNormalMatrix(e.matrix).elements;
      const n0 = ne[0], n1 = ne[1], n2 = ne[2], n3 = ne[3], n4 = ne[4], n5 = ne[5], n6 = ne[6], n7 = ne[7], n8 = ne[8];
      for (let j = 0; j < nv; j += 1) {
        const v = (used ? used[j] : start + j) * 3;
        const x = src[v], y = src[v + 1], z = src[v + 2];
        const tx = n0 * x + n3 * y + n6 * z;
        const ty = n1 * x + n4 * y + n7 * z;
        const tz = n2 * x + n5 * y + n8 * z;
        const s = 1 / (Math.sqrt(tx * tx + ty * ty + tz * tz) || 1);
        const d = (vbase + j) * 3;
        dst[d] = tx * s;
        dst[d + 1] = ty * s;
        dst[d + 2] = tz * s;
      }
    } else {
      const s = o.a.itemSize;
      for (let j = 0; j < nv; j += 1) {
        const v = (used ? used[j] : start + j) * s;
        const d = (vbase + j) * s;
        for (let c = 0; c < s; c += 1) dst[d + c] = src[v + c];
      }
    }
  }
  job.slotArr.fill(e.slot, vbase, vbase + nv);
  job.cellArr.fill(e.code, vbase, vbase + nv);
  const ia = job.ia;
  let iw = job.iw;
  if (used) {
    const sn = g.attributes.position.count;
    if (!_remap || _remap.length < sn) _remap = new Uint32Array(Math.max(sn, 1024));
    for (let j = 0; j < used.length; j += 1) _remap[used[j]] = j;
    const src = g.index.array;
    for (let i = start; i < start + e.count; i += 1) ia[iw++] = _remap[src[i]] + vbase;
  } else {
    for (let j = 0; j < nv; j += 1) ia[iw++] = vbase + j;
  }
  job.iw = iw;
  job.vw = vbase + nv;
}

/**
 * The job's BufferGeometry, with the bounding box and sphere three's
 * computeBoundingBox / computeBoundingSphere would give (the same arithmetic,
 * over the f32 positions, without the per-vertex Vector3 calls).
 */
export function finishMerge(job) {
  const geometry = new THREE.BufferGeometry();
  let bytes = 0;
  for (const o of job.out) {
    geometry.setAttribute(o.name, new THREE.BufferAttribute(o.arr, o.a.itemSize, o.a.normalized));
    bytes += o.arr.byteLength;
  }
  geometry.setAttribute(SLOT_ATTR, new THREE.BufferAttribute(job.slotArr, 1));
  geometry.setAttribute(IB_CELL_ATTR, new THREE.BufferAttribute(job.cellArr, 1));
  geometry.setIndex(new THREE.BufferAttribute(job.ia, 1));
  bytes += job.slotArr.byteLength + job.cellArr.byteLength + job.ia.byteLength;
  const p = geometry.attributes.position.array;
  const n = job.vtx;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  const box = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ));
  const center = new THREE.Vector3();
  box.getCenter(center);
  let r2 = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = center.x - p[i * 3], dy = center.y - p[i * 3 + 1], dz = center.z - p[i * 3 + 2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  geometry.boundingSphere = new THREE.Sphere(center, Math.sqrt(r2));
  geometry.boundingBox = box;
  job.out = null;
  return { geometry, bytes, vertexCount: job.vtx, indexCount: job.idx, slices: job.slices };
}

/** The matrix three draws `o` with, relative to its parent (TRS when auto-updating, else `.matrix`). */
function _localMatrix(o, out) {
  if (o.matrixAutoUpdate) return out.compose(o.position, o.quaternion, o.scale);
  return out.copy(o.matrix);
}

/**
 * The container-space matrix of a candidate: cells `C * G * m` (container,
 * mesh group, mesh), props `C * m` — what three composes into matrixWorld
 * below cellsGroup.
 */
export function candidateMatrix(container, mesh, group, out = new THREE.Matrix4()) {
  const { a: _mA, b: _mB } = _scratch();
  _localMatrix(container, out);
  if (group) { _localMatrix(group, _mA); out.multiply(_mA); }
  _localMatrix(mesh, _mB);
  out.multiply(_mB);
  return out;
}

/**
 * Greedy chunking (pure): `cells` in cellId order, each `{ bytes }`; a chunk
 * closes when adding the next cell would pass `capBytes` or `maxCells`. A
 * cell larger than the cap gets a chunk of its own. Returns arrays of cell
 * indices.
 */
export function planChunks(cells, capBytes, maxCells = IB_CELLS_PER_ROW) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (let i = 0; i < cells.length; i += 1) {
    const b = cells[i].bytes | 0;
    if (cur.length > 0 && (bytes + b > capBytes || cur.length >= maxCells)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(i);
    bytes += b;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// ===========================================================================
// The frustum sentinel.
// ===========================================================================

let _sentinel = null;
/** The shared frozen Sphere(0, -Infinity) (lazy: nothing at import). */
export function ibSentinel() {
  if (!_sentinel) {
    const s = new THREE.Sphere(new THREE.Vector3(0, 0, 0), -Infinity);
    Object.freeze(s.center);
    _sentinel = Object.freeze(s);
  }
  return _sentinel;
}

/** Stop `mesh` drawing (main + shadow passes) while every geometry reader keeps working. */
export function suppressLegacy(mesh) {
  Object.defineProperty(mesh, "boundingSphere", { value: ibSentinel(), configurable: true, writable: true, enumerable: false });
}

/** Undo suppressLegacy (only our own sentinel is removed). */
export function restoreLegacy(mesh) {
  if (Object.prototype.hasOwnProperty.call(mesh, "boundingSphere") && mesh.boundingSphere === _sentinel) delete mesh.boundingSphere;
}

// ===========================================================================
// State (created at the first armed call; nothing before).
// ===========================================================================

let _S = null;
let _envOverride = null;

function _newStats() {
  return {
    lbsNoted: 0, chunksPlanned: 0, builds: 0, activations: 0, teardowns: 0, replans: 0, textureReplans: 0, contextResets: 0,
    giveUps: 0, bitMismatch: 0, bitUploads: 0, bitUploadBytes: 0, mergeMs: 0, maxMergeMs: 0, mergeSlices: 0, plans: 0,
    planMs: 0, maxPlanMs: 0, planSlices: 0, maxSyncMs: 0, classWarms: 0,
    depthWarms: 0, rasterRequests: 0, slotRewrites: 0, legacyReasons: {}, unitReasons: {}, disarmed: {},
    // Members refused for an extra map, by their whole extra-map set (census).
    extraMaps: {},
    // With the env-cell draw pools armed (header): planned cells whose shell
    // the pools share, the surface groups pooled / left on the legacy
    // producer in them, cells whose surfaces stayed legacy because the split
    // did not add up, and the backstop's pool visibility comparisons.
    pools: { active: false, cells: 0, surfacesPooled: 0, surfacesLegacy: 0, partitionRefused: 0, visChecks: 0, visDiverged: 0 },
  };
}

/**
 * The clock the per-sync CPU budget reads (the kit's performance.now; the
 * test seam can hand in its own). Stats always use uploadNowMs.
 */
function _now() {
  return _envOverride && typeof _envOverride.now === "function" ? _envOverride.now() : uploadNowMs();
}

function _st() {
  if (_S) return _S;
  const mode = (_envOverride && _envOverride.mode) || interiorBatchMode();
  _S = {
    mode,
    chunkBytes: Math.round(_numParam("interiorBatchChunkKB", IB_CHUNK_BYTES_DEFAULT / 1024, 256, 8192) * 1024),
    // The per-sync CPU budget of planning + material set-up + merging (ms);
    // each phase still does one unit per sync (a cell, a class, an entry).
    mergeMs: (_envOverride && _envOverride.mergeMs) || _numParam("interiorBatchMergeMs", IB_MERGE_MS_DEFAULT, 0.5, 8),
    work: { deadline: 0, mergeDeadline: 0, planUnits: 0, classUnits: 0, warmUnits: 0, mergeUnits: 0 },
    envScratch: { renderer: null, camera: null, scene: null },
    lbs: new Map(),
    slots: new Map(),
    classMats: new Map(),
    depthMats: new Map(),
    warm: new Map(),
    fpIds: new Map(),
    fpIdTaken: new Set(),
    bits: null,
    bitsU: { value: null },
    bitsDirty: false,
    root: null,
    scene3d: null,
    frameNo: 0,
    lastTs: NaN, // a number field: the per-sync store does not box
    castOn: null,
    off: false,
    disarmed: null,
    poolsOn: false, // the env-cell draw pools armed (read per sync)
    poolRead: null, // PoolRegistry.readCellState's out object (lazy)
    watch: null,
    depthWarm: null,
    recording: null,
    stats: _newStats(),
  };
  return _S;
}

function _count(map, reason) { map[reason] = (map[reason] || 0) + 1; }

/**
 * Test seam: `{ renderer, camera, scene, mode, now, mergeMs }` instead of
 * scene3d / window.liveScene3d / the clock / the URL knob (null clears).
 */
export function __setInteriorBatchEnvForTest(env) {
  _envOverride = env || null;
  if (_S && env && env.mode) _S.mode = env.mode;
  if (_S && env && env.mergeMs) _S.mergeMs = env.mergeMs;
}

/** Test seam: the LB records (null before the first armed call). */
export function __interiorBatchLbsForTest() {
  return _S ? _S.lbs : null;
}

/** Test seam: the whole state object (null before the first armed call). */
export function __interiorBatchStateForTest() {
  return _S;
}

/**
 * The renderer / camera / scene of this sync, in ONE reused object (no
 * allocation per sync; every reader in a sync sees the same values).
 */
function _env() {
  const S = _S;
  const s3 = S && S.scene3d;
  let renderer = (_envOverride && _envOverride.renderer) || (s3 && s3.renderer) || null;
  let camera = (_envOverride && _envOverride.camera) || (s3 && (s3.cameraSwitcher?.activeCamera ?? s3.camera)) || null;
  let scene = (_envOverride && _envOverride.scene) || (s3 && s3.scene) || null;
  if (!renderer || !camera) {
    try {
      const live = typeof window !== "undefined" ? window.liveScene3d : null;
      if (live) { renderer = renderer || live.renderer || null; camera = camera || live.camera || null; scene = scene || live.scene || null; }
    } catch (_) { /* no window */ }
  }
  const out = S ? S.envScratch : { renderer: null, camera: null, scene: null };
  out.renderer = renderer;
  out.camera = camera;
  out.scene = scene;
  return out;
}

// ===========================================================================
// Build hook (cells.js, after envCellLoadedLbs.add).
// ===========================================================================

/**
 * A landblock's EnvCell build completed (cells.js buildEnvCellsForLandblock,
 * right after `envCellLoadedLbs.add`). Registers it for planning; a record of
 * an older build of the same landblock is torn down first. Cancelled or
 * evicted builds never reach this call, so they register nothing.
 */
export function noteInteriorBatchBuilt(scene3d, lbKey, buildGen, newCells) {
  const S = _st();
  if (S.mode === "off") return null;
  if (!S.scene3d && scene3d) _install(S, scene3d);
  const key = lbKey >>> 0;
  const have = S.lbs.get(key);
  if (have) {
    if (have.buildGen === buildGen) return have;
    _teardownLb(have, "rebuild");
    S.lbs.delete(key);
  }
  const cells = [];
  for (const c of newCells || []) if (c && c.container) cells.push({ container: c.container, cellId: c.cellId >>> 0 });
  cells.sort((a, b) => a.cellId - b.cellId);
  const rec = {
    lbKey: key, buildGen, cells, status: "pending", reason: null, chunks: [], plan: null, group: null,
    parked: false, origin: landblockOrigin(key, [0, 0, 0]), planning: null,
    rep: cells.length ? [cells[0].container, cells[0].cellId] : null,
  };
  S.lbs.set(key, rec);
  S.stats.lbsNoted += 1;
  return rec;
}

function _install(S, scene3d) {
  S.scene3d = scene3d;
  if (S.mode === "on") {
    try {
      scene3d.interiorBatchHooks = {
        detached: (lbKey, why) => _lruDetached(lbKey >>> 0, why),
        attached: (lbKey) => _lruAttached(lbKey >>> 0),
      };
    } catch (_) { /* frozen scene3d: the reconcile fallback runs anyway */ }
  }
  try {
    if (typeof window !== "undefined") window.__interiorBatch = _diagApi();
  } catch (_) { /* no window */ }
}

// ===========================================================================
// Planning.
// ===========================================================================

/** Eligibility + entries of one candidate mesh (null entries = stays legacy). */
function _meshPlan(cand, container, kind, reasons) {
  const mesh = cand.mesh;
  const r = interiorMeshReason(mesh, container);
  if (r) { _count(reasons, kind + ":" + r); return null; }
  const ranges = drawnRangesOf(mesh);
  if (ranges.length === 0) { _count(reasons, kind + ":no-ranges"); return null; }
  const members = [];
  for (const rg of ranges) {
    const m = rg.material;
    const ar = interiorArrayReason(m);
    if (ar) {
      _count(reasons, kind + ":" + ar);
      // Census (2026-10-31): the WHOLE extra-map set of a member refused for a
      // map (the reason names the first one only): is an AO-only class enough,
      // or do texchan's AO + roughness planes come together? Per planning pass.
      if (_S && ar.startsWith("map:")) _count(_S.stats.extraMaps, _extraMapSet(m));
      return null;
    }
    const fp = chainFingerprintId(m);
    if (fp.reason) { _count(reasons, kind + ":" + fp.reason); return null; }
    const pr = interiorPomReason(m, fp.pom);
    if (pr) { _count(reasons, kind + ":" + pr); return null; }
    const cls = interiorMemberClass(m);
    if (cls.light === "baked" && !mesh.geometry.attributes.acBakedLight) { _count(reasons, kind + ":baked-without-attribute"); return null; }
    members.push({ m, fp: fp.id, cls, pom: fp.pom });
  }
  if (mesh.geometry.index) {
    for (const rg of ranges) {
      if (rangeVerticesOf(mesh.geometry, rg.start, rg.count) === false) { _count(reasons, kind + ":index-range"); return null; }
    }
  }
  const matrix = candidateMatrix(container, mesh, cand.group, new THREE.Matrix4());
  const ud = mesh.userData || {};
  const baseCast = ud.__baseCast !== undefined ? ud.__baseCast === true : mesh.castShadow === true;
  const layout = layoutOf(mesh.geometry);
  const entries = [];
  for (let i = 0; i < ranges.length; i += 1) {
    const rg = ranges[i];
    const { m, fp, cls, pom } = members[i];
    const mapK = interiorTextureInfo(m.map).pageKey;
    const nrmK = m.normalMap ? interiorTextureInfo(m.normalMap).pageKey : "-";
    const pomK = pom && pom.pom ? "|h:" + interiorTextureInfo(pom.texture, true).pageKey : "";
    const pre = `${kind}|${classKeyOf(cls)}|${interiorChainKey(m, pom)}|fp${fp}|${interiorMemberSignature(m)}|${layout}|rs${mesh.receiveShadow ? 1 : 0}`;
    entries.push({
      mesh, member: m, cls, fp, kind, geometry: mesh.geometry, start: rg.start, count: rg.count, matrix, baseCast,
      receiveShadow: mesh.receiveShadow === true, preKey: pre, pageKey: pre + "|m:" + mapK + "|n:" + nrmK + pomK,
      slot: -1, code: 0, cellIdx: -1,
    });
  }
  return { mesh, entries, baseCast };
}

function _extraMapSet(m) {
  let out = "";
  for (const k of _NO_EXTRA_MAPS) if (m[k]) out += (out ? "+" : "") + k;
  return out || "-";
}

/** Are the env-cell draw pools armed (pool_envcells.js; fail-soft false)? */
function _poolsActive() {
  try { return envCellPoolsActive() === true; } catch (_) { return false; }
}

/**
 * Pools armed: may this cell's SURFACE meshes batch? Its shell was split
 * between the pools and the container at build (header). Yes when the split
 * adds up from the pools' own state: the offer verdict cells.js stamped
 * (`__ibPool`) gives the groups pooled and the groups left legacy; the
 * container's legacy surface meshes hold exactly the legacy ones; and the
 * registry's cell index holds no more instances for the cell than the offer
 * pooled (fewer: a stage-B feed not committed yet, or a vacated one — nothing
 * a pool draws then). An unstamped cell (never offered: env-detail, a failed
 * offer) must have no pooled instance at all. Props are never pooled: not
 * affected.
 */
function _poolSplitOk(S, cellRec, plan) {
  const c = cellRec.container;
  const st = c.userData && c.userData.__ibPool;
  const reg = getPoolRegistry();
  const r = S.poolRead || (S.poolRead = { instances: 0, hidden: 0 });
  const instances = reg && typeof reg.readCellState === "function" && reg.readCellState(cellRec.cellId, r) ? r.instances : 0;
  const pp = plan.pools;
  if (!st) {
    if (instances === 0) return true;
    pp.refused += 1;
    return false;
  }
  if (st.pooled > 0) pp.cells += 1;
  pp.pooled += st.pooled;
  pp.legacy += st.legacy;
  if (instances > st.pooled || legacySurfaceCountOf(c) !== st.legacy) {
    pp.refused += 1;
    return false;
  }
  return true;
}

/** One cell's candidates -> eligible meshes + entries (and the census counts). */
function _cellPlan(cellRec, reasons, plan) {
  const { container } = cellRec;
  const { cells, props } = interiorCandidatesOf(container);
  const S = _S;
  const surfacesOk = !(S && S.poolsOn) || _poolSplitOk(S, cellRec, plan);
  if (!surfacesOk) _count(reasons, "cells:pool-split");
  const meshes = [];
  for (const c of cells) {
    plan.candidates.cells += 1;
    if (!surfacesOk) continue;
    const p = _meshPlan(c, container, "cells", reasons);
    if (p) { meshes.push(p); plan.eligible.cells += 1; }
  }
  for (const m of props) {
    plan.candidates.props += 1;
    const p = _meshPlan({ mesh: m, group: null }, container, "props", reasons);
    if (p) { meshes.push(p); plan.eligible.props += 1; }
  }
  return meshes;
}

function _newPlan() {
  return {
    cells: 0, candidates: { cells: 0, props: 0 }, eligible: { cells: 0, props: 0 }, reasons: {}, keys: 0, projectedDraws: 0, projectedBytes: 0, chunks: 0,
    pools: { cells: 0, pooled: 0, legacy: 0, refused: 0 },
  };
}

/**
 * Disarm conditions (the whole consumer steps aside; reason counted once per
 * change). The env-cell draw pools are NOT one (realboot 2026-10-31): the
 * batch takes what they leave on the legacy producer (header).
 */
function _disarmReason(S) {
  const s3 = S.scene3d;
  if (s3 && s3.materialCache && s3.materialCache.wireframeMode) return "wireframe";
  if (S.portalStencilUrl === undefined) {
    S.portalStencilUrl = false;
    try {
      const q = globalThis.location?.search || "";
      S.portalStencilUrl = String(new URLSearchParams(q).get("portalStencil") || "").toLowerCase() === "on";
    } catch (_) { /* default */ }
  }
  if (S.portalStencilUrl || (s3 && s3._portalStencilPass)) return "portal-stencil";
  if (s3 && s3.csmEnabled) return "csm";
  return null;
}

/**
 * Plan one landblock, cell by cell under the per-sync budget (status
 * "planning" between syncs): candidates, eligibility, keys; once every cell
 * is in, the chunks. Returns true when the landblock is planned (or legacy).
 * At least one cell per call.
 */
function _planLbStep(S, rec) {
  let p = rec.planning;
  if (!p) {
    p = rec.planning = { i: 0, plan: _newPlan(), cellPlans: [], mask: null };
    p.plan.cells = rec.cells.length;
    rec.status = "planning";
  }
  const W = S.work;
  while (p.i < rec.cells.length) {
    const c = rec.cells[p.i];
    p.i += 1;
    if (c.container) {
      if (p.mask === null) p.mask = c.container.layers.mask;
      if (c.container.layers.mask !== p.mask) _count(p.plan.reasons, "cell:layers");
      else {
        const meshes = _cellPlan(c, p.plan.reasons, p.plan);
        if (meshes.length > 0) {
          let bytes = 0;
          for (const mp of meshes) bytes += chunkBytesOf(mp.entries);
          p.cellPlans.push({ cell: c, meshes, bytes });
        }
      }
    }
    W.planUnits += 1;
    if (_now() >= W.deadline) break;
  }
  if (p.i < rec.cells.length) return false;
  rec.planning = null;
  _finishPlan(S, rec, p.plan, p.cellPlans, p.mask);
  return true;
}

/** The chunks of a fully planned landblock. */
function _finishPlan(S, rec, plan, cellPlans, mask) {
  rec.plan = plan;
  rec.mask = mask === null ? 2 : mask;
  S.stats.plans += 1;
  const parts = planChunks(cellPlans, S.chunkBytes, IB_CELLS_PER_ROW);
  const projectedKeys = new Set();
  rec.chunks = [];
  for (let ci = 0; ci < parts.length; ci += 1) {
    const chunk = _newChunk(rec, ci, parts[ci].map((i) => cellPlans[i]));
    const keys = new Set();
    for (const cp of chunk.cellPlans) for (const mp of cp.meshes) for (const e of mp.entries) { keys.add(e.pageKey); projectedKeys.add(e.pageKey); }
    plan.projectedDraws += keys.size;
    for (const cp of chunk.cellPlans) plan.projectedBytes += cp.bytes;
    rec.chunks.push(chunk);
  }
  plan.keys = projectedKeys.size;
  plan.chunks = rec.chunks.length;
  for (const k of Object.keys(plan.reasons)) S.stats.unitReasons[k] = (S.stats.unitReasons[k] || 0) + plan.reasons[k];
  const sp = S.stats.pools;
  sp.cells += plan.pools.cells;
  sp.surfacesPooled += plan.pools.pooled;
  sp.surfacesLegacy += plan.pools.legacy;
  sp.partitionRefused += plan.pools.refused;
  if (rec.chunks.length === 0) { _setLbLegacy(S, rec, "nothing-eligible"); return; }
  rec.status = "planned";
  S.stats.chunksPlanned += rec.chunks.length;
}

function _newChunk(rec, index, cellPlans) {
  const n = cellPlans.length;
  const chunk = {
    rec, index, cellPlans, status: S_CHUNK.PENDING, reason: null,
    drawState: new Uint8Array(n), cellObjs: new Array(n), row: -1, batches: [], slotsHeld: new Set(),
    ticket: null, ticketBudget: null, bytes: 0, overlapFrames: 0, replans: 0, textureReplans: 0, retryFrame: 0,
    noKeys: null, suppressed: [], meshInfo: [], casts: false, mask: rec.mask, planned: true, admitted: false, mergeAt: 0, replan: null,
  };
  for (let i = 0; i < n; i += 1) {
    const c = cellPlans[i].cell.container;
    chunk.drawState[i] = c && c.visible === true ? 1 : 0;
    chunk.cellObjs[i] = [];
  }
  return chunk;
}

const S_CHUNK = Object.freeze({
  PENDING: "pending", ADMITTING: "admitting", WARMING: "warming", BUILDING: "building", MERGING: "merging",
  OVERLAP: "overlap", ACTIVE: "active", LEGACY: "legacy",
});

function _setLbLegacy(S, rec, reason) {
  rec.status = "legacy";
  rec.reason = reason;
  _count(S.stats.legacyReasons, "lb:" + reason);
}

function _setChunkLegacy(S, chunk, reason) {
  chunk.status = S_CHUNK.LEGACY;
  chunk.reason = reason;
  _count(S.stats.legacyReasons, "chunk:" + reason);
}

/**
 * (Re)plan a chunk's entries from its cells (a replan re-runs eligibility:
 * it sees today's materials; cell by cell under the per-sync budget, false
 * until every cell is in) and stamp its containers: their bits follow the
 * visibility notes from now on.
 */
function _planChunkEntries(S, chunk) {
  if (!chunk.planned) {
    const W = S.work;
    if (W.planUnits > 0 && _now() >= W.deadline) return false;
    let r = chunk.replan;
    if (!r) r = chunk.replan = { i: 0, cellPlans: [], reasons: {}, scratch: _newPlan() };
    while (r.i < chunk.cellPlans.length) {
      const cp = chunk.cellPlans[r.i];
      r.i += 1;
      r.cellPlans.push({ cell: cp.cell, meshes: _cellPlan(cp.cell, r.reasons, r.scratch), bytes: cp.bytes });
      W.planUnits += 1;
      if (_now() >= W.deadline) break;
    }
    if (r.i < chunk.cellPlans.length) return false;
    chunk.cellPlans = r.cellPlans;
    chunk.replan = null;
  }
  chunk.planned = false;
  const cellPlans = chunk.cellPlans;
  for (let i = 0; i < cellPlans.length; i += 1) {
    const c = cellPlans[i].cell.container;
    if (!c) continue;
    c.userData = c.userData || {};
    // NON-enumerable (materials.js _defineLiveUserData convention): the stamp
    // references the chunk, so an enumerable one would make
    // JSON.stringify(userData) — and with it Object3D.copy / clone — throw on
    // a circular structure; a clone must not carry it either.
    Object.defineProperty(c.userData, "__ib", { value: { chunk, cell: i }, configurable: true, writable: true, enumerable: false });
    chunk.drawState[i] = c.visible === true ? 1 : 0;
  }
  return true;
}

// ===========================================================================
// Slots, class materials, depth materials.
// ===========================================================================

/** The slot entry for `member` (created empty: layers + row are admitted by `_slotAdmit`). */
function _slotEntry(S, member) {
  let e = S.slots.get(member);
  if (e && e.dead) { S.slots.delete(member); e = null; }
  if (!e) {
    const cls = interiorMemberClass(member);
    const fpr = chainFingerprintId(member);
    const pom = fpr.pom && fpr.pom.pom === true ? fpr.pom : null;
    e = {
      member, slot: -1, mapRef: null, nrmRef: null, map: null, mapVersion: -1, normalMap: null, nrmVersion: -1,
      version: member.version, clsKey: classKeyOf(cls), clsBlend: cls.blend, clsLight: cls.light, clsSide: cls.side,
      programKey: interiorProgramKeyOf(member),
      fp: fpr.id, sig: interiorMemberSignature(member), chunks: new Set(), dead: false,
      obc: member.onBeforeCompile, transparent: member.transparent === true, side: member.side, visible: member.visible !== false,
      // POM (header "POM MEMBERS"): the dry run's verdict, the height layer
      // and the POM extension row (layer_state.js packPomState).
      pom, pomTex: pom ? pom.texture : null, pomVersion: pom ? pom.texture.version : -1, pomRef: null, pomRow: 0, pomState: pom ? {} : null,
    };
    S.slots.set(member, e);
  }
  return e;
}

/** A slot entry is resident: map (+ normal, + POM height and extension row) admitted and its state row written. */
function _slotResident(e) {
  return !!e.mapRef && e.slot >= 0 && (!e.member.normalMap || !!e.nrmRef) && (!e.pom || (!!e.pomRef && e.pomRow > 0));
}

/** The slot's POM extension row index (0 = none). */
function _extRow(e) {
  return e.pomRow > 0 ? e.pomRow : 0;
}

/**
 * Admit an entry's layers and state row (each step once; a deferral keeps
 * what was admitted and retries next frame). Returns true when resident;
 * `out.deferred` / `out.failed` say why not.
 */
function _slotAdmit(S, e, pages, budget, out) {
  const member = e.member;
  if (!e.mapRef) {
    const r = pages.admit(member.map, budget);
    if (r && r.deferred) { out.deferred = true; return false; }
    if (!r) { out.failed = "admit-failed"; return false; }
    e.mapRef = { ...r, pages };
    e.map = member.map;
    e.mapVersion = member.map.version;
  }
  if (member.normalMap && !e.nrmRef) {
    const r = pages.admit(member.normalMap, budget);
    if (r && r.deferred) { out.deferred = true; return false; }
    if (!r) { out.failed = "admit-failed"; return false; }
    e.nrmRef = { ...r, pages };
  }
  e.normalMap = member.normalMap || null;
  e.nrmVersion = member.normalMap ? member.normalMap.version : -1;
  if (e.pom) {
    if (!e.pomRef) {
      const r = pages.admit(e.pomTex, budget, R8_PLANES);
      if (r && r.deferred) { out.deferred = true; return false; }
      if (!r) { out.failed = "admit-failed"; return false; }
      e.pomRef = { ...r, pages };
      e.pomVersion = e.pomTex.version;
    }
    if (e.pomRow <= 0) {
      const row = kitStateTable().addPom(pomStateOf(member, e.pom, e.pomRef.layer, e.pomState), budget);
      if (row < 0) { out.deferred = true; return false; }
      e.pomRow = row;
    }
  }
  if (e.slot < 0) {
    const s = kitStateTable().addFromMaterial(member, e.mapRef.layer, budget, e.nrmRef ? e.nrmRef.layer : 0, _extRow(e));
    if (s < 0) { out.deferred = true; return false; }
    e.slot = s;
  }
  return true;
}

function _releaseSlot(S, e, chunk) {
  if (!e) return;
  e.chunks.delete(chunk);
  if (e.chunks.size > 0) return;
  if (e.mapRef) { try { e.mapRef.pages.release(e.mapRef.contentKey); } catch (_) { /* fail-soft */ } e.mapRef = null; }
  if (e.nrmRef) { try { e.nrmRef.pages.release(e.nrmRef.contentKey); } catch (_) { /* fail-soft */ } e.nrmRef = null; }
  if (e.pomRef) { try { e.pomRef.pages.release(e.pomRef.contentKey); } catch (_) { /* fail-soft */ } e.pomRef = null; }
  if (e.pomRow > 0) { try { kitStateTable().remove(e.pomRow); } catch (_) { /* fail-soft */ } e.pomRow = 0; }
  if (e.slot >= 0) { try { kitStateTable().remove(e.slot); } catch (_) { /* fail-soft */ } e.slot = -1; }
  e.dead = true;
  if (S.slots.get(e.member) === e) S.slots.delete(e.member);
}

function _hookKey(fp, rs) {
  return `ibCell1|fp${fp}|rs${rs ? 1 : 0}`;
}

function _classOpts(member, cls, mapUniform, normalUniform, hookKey, pomUniform = null) {
  return {
    cls,
    chain: memberChainHook(member),
    chainKey: interiorChainKey(member, pomUniform ? { pom: true } : POM_NONE),
    mapUniform,
    normalUniform,
    pomUniform,
    stateUniform: kitStateTable().rows.uniform,
    vertexHook: (shader) => {
      shader.uniforms[IB_BITS_SAMPLER] = _S ? _S.bitsU : { value: null };
      injectIbColorHook(shader);
    },
    vertexHookKey: hookKey,
    base: {
      fog: member.fog, envMapIntensity: member.envMapIntensity, dithering: member.dithering,
      toneMapped: member.toneMapped, depthTest: member.depthTest,
    },
  };
}

function _copyRasterState(material, member) {
  material.depthWrite = member.depthWrite;
  material.colorWrite = member.colorWrite;
  material.depthFunc = member.depthFunc;
  material.shadowSide = member.shadowSide;
  material.precision = member.precision;
}

/** The class entry of one batch (refcounted, shared across chunks and landblocks); null = class self-check failed. */
function _classEntryFor(S, b) {
  const e0 = b.entries[0];
  const m = e0.member;
  const mapPage = b.mapPage;
  const nrmPage = b.nrmPage;
  const pomPage = b.pomPage || null;
  // (A POM batch's height page rides the normal-page field, so every key
  // keeps its page ids in the same two trailing places.)
  const key = `${classKeyOf(e0.cls)}|${interiorChainKey(m, pomPage ? { pom: true } : POM_NONE)}|fp${e0.fp}|${interiorMemberSignature(m)}|${mapPage.id}|${nrmPage ? nrmPage.id : "-"}${pomPage ? "+h" + pomPage.id : ""}|rs${e0.receiveShadow ? 1 : 0}`;
  let ce = S.classMats.get(key);
  if (!ce) {
    const hookKey = _hookKey(e0.fp, e0.receiveShadow);
    const opts = _classOpts(m, e0.cls, { value: mapPage.gl.texture }, nrmPage ? { value: nrmPage.gl.texture } : null, hookKey,
      pomPage ? { value: pomPage.gl.texture } : null);
    // Every stock line the class patch replaces (and the collapse anchor)
    // must survive the member chain.
    if (classPatchMissing({ chain: opts.chain, withNormal: !!nrmPage, withPom: !!pomPage }) !== 0) return null;
    if (!_hookAnchorSurvives(opts.chain)) return null;
    const material = makeClassMaterial(opts);
    _copyRasterState(material, m);
    material.name = `ibatch-class-${classKeyOf(e0.cls)}`;
    const programKey = material.customProgramCacheKey();
    if (!S.warm.has(programKey)) {
      const warmMat = makeClassMaterial(opts);
      _copyRasterState(warmMat, m);
      S.warm.set(programKey, { material: warmMat, tries: 0, registered: false, warmedOn: null });
    }
    ce = { key, material, refs: 0, programKey };
    S.classMats.set(key, ce);
  }
  ce.refs += 1;
  return ce;
}

function _hookAnchorSurvives(chain) {
  const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}, defines: {} };
  try { if (chain) chain.call(_fpScratch || (_fpScratch = new THREE.MeshStandardMaterial()), shader, null); } catch (_) { return false; }
  return shader.vertexShader.indexOf("#include <begin_vertex>") !== -1;
}

function _releaseClassEntry(S, ce) {
  if (!ce) return;
  ce.refs -= 1;
  if (ce.refs > 0) return;
  S.classMats.delete(ce.key);
  _disposeMaterial(ce.material);
}

/** Dispose a kit material unless the context is lost right now (anim_scenery_batch.js rule). */
function _disposeMaterial(material) {
  if (kitLiveGeneration() === LOST_CONTEXT_GENERATION) return;
  try { material.dispose(); } catch (_) { /* fail-soft */ }
}

/**
 * The depth (customDepthMaterial) entry for a batch: one for every opaque
 * batch, one per map page for alpha-tested batches (sharing one across alpha
 * classes would flip `alphaTest` 0 <-> 0.5, bump its version and relink).
 */
function _depthEntryFor(S, blend, mapPage) {
  const alpha = blend === "alphaTest";
  const key = "hbIbDepth1|" + blend + (alpha ? "|" + mapPage.id : "");
  let de = S.depthMats.get(key);
  if (!de) {
    const material = _makeDepthMaterial(alpha, alpha ? { value: mapPage.gl.texture } : null);
    de = { key, material, refs: 0, alpha };
    S.depthMats.set(key, de);
  }
  de.refs += 1;
  return de;
}

export const IB_DEPTH_KEY_PREFIX = "hbIbDepth1|";

function _makeDepthMaterial(alpha, mapUniform) {
  const m = new THREE.MeshDepthMaterial();
  m.name = alpha ? "ibatch-depth-alphaTest" : "ibatch-depth-opaque";
  const pk = IB_DEPTH_KEY_PREFIX + (alpha ? "alphaTest" : "opaque");
  m.onBeforeCompile = function hbIbDepthOnBeforeCompile(shader) {
    shader.uniforms = shader.uniforms || {};
    shader.uniforms[IB_BITS_SAMPLER] = _S ? _S.bitsU : { value: null };
    if (alpha) {
      shader.uniforms.hbIbMapArr = mapUniform;
      shader.uniforms[STATE_SAMPLER] = kitStateTable().rows.uniform;
    }
    patchIbDepthShader(shader, alpha);
  };
  m.customProgramCacheKey = function hbIbDepthProgramKey() { return pk; };
  m.userData = { hbIbDepth: alpha ? "alphaTest" : "opaque", hbIbProgramKey: pk };
  return m;
}

function _releaseDepthEntry(S, de) {
  if (!de) return;
  de.refs -= 1;
  if (de.refs > 0) return;
  S.depthMats.delete(de.key);
  _disposeMaterial(de.material);
}

const _ctxOf = (renderer) => kitContextGeneration(renderer);

/**
 * A program warm (a renderer.compile of one new class program, or the depth
 * warm render) is one unit of the per-sync budget: false = not this sync.
 */
function _warmSlot(S) {
  const W = S.work;
  if (W.warmUnits > 0 && _now() >= W.deadline) return false;
  W.warmUnits += 1;
  return true;
}

/** Is the class program for `ce` linked (or never compiled ahead: draw anyway)? */
function _classReady(S, ce, env) {
  if (!env.renderer) return true;
  const w = S.warm.get(ce.programKey);
  if (!w) return true;
  if ((!w.registered || (w.warmedOn !== _ctxOf(env.renderer) && env.camera)) && !_warmSlot(S)) return false;
  if (!w.registered) {
    w.registered = true;
    // Registration is idempotent per key and outlives this module's state
    // (a re-arm after disposeInteriorBatches): the factory looks the CURRENT
    // warm material up by key.
    const key = ce.programKey;
    registerBatchClassPrewarm(key, () => {
      const cur = _S && _S.warm.get(key);
      return cur ? [classPrewarmProxy(cur.material, { instanced: false, extraAttributes: [IB_CELL_ATTR] })] : [];
    });
  }
  const ctx = _ctxOf(env.renderer);
  if (w.warmedOn !== ctx && env.camera) {
    w.warmedOn = ctx;
    w.tries = 0;
    S.stats.classWarms += 1;
    try { prewarmBatchClasses(env.renderer, env.camera, env.scene || null); } catch (_) { /* first draw compiles */ }
  }
  const progs = programsOf(env.renderer, w.material);
  if (progs.length === 0) {
    // Warmed on this context through an earlier warm material of the same
    // key: three's program cache holds it (the parked proxy keeps it).
    let warmed = false;
    try { warmed = batchClassWarmedKeys(env.renderer).includes(ce.programKey); } catch (_) { warmed = false; }
    if (warmed) return true;
    return ++w.tries > BATCH_WARM_WAIT_FRAMES;
  }
  for (const p of progs) if (programPending(p)) return false;
  return true;
}

/**
 * Depth programs: renderer.compile cannot reach them (pool_prewarm.js), so a
 * private warm scene holds one castShadow proxy per depth material and a
 * tiny castShadow DirectionalLight; one render into a private 1x1 target
 * links them (the proxies sit BEHIND the warm camera, so its colour pass
 * culls them and compiles nothing: only the shadow pass draws them). Parked
 * for the session; re-run on a new GL-context generation.
 */
function _depthReady(S, de, env) {
  const r = env.renderer;
  if (!r || !r.shadowMap || r.shadowMap.enabled !== true) return true;
  if (!de.warm) de.warm = { tries: 0, warmedOn: null };
  const ctx = _ctxOf(r);
  if (de.warm.warmedOn !== ctx && !_warmSlot(S)) return false;
  if (de.warm.warmedOn !== ctx) {
    de.warm.warmedOn = ctx;
    de.warm.tries = 0;
    _warmDepth(S, r, de);
  }
  const progs = programsOf(r, de.material);
  if (progs.length === 0) return ++de.warm.tries > BATCH_WARM_WAIT_FRAMES;
  for (const p of progs) if (programPending(p)) return false;
  return true;
}

function _warmDepth(S, renderer, de) {
  try {
    let w = S.depthWarm;
    if (!w || w.ctx !== _ctxOf(renderer)) {
      const scene = new THREE.Scene();
      scene.name = "ibatch-depth-warm";
      const light = new THREE.DirectionalLight(0xffffff, 1);
      light.castShadow = true;
      light.shadow.mapSize.set(64, 64);
      light.position.set(0, 0, 30);
      light.target.position.set(0, 0, 10);
      scene.add(light, light.target);
      const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 50);
      camera.position.set(0, 0, 0);
      camera.lookAt(0, 0, -1);
      camera.updateMatrixWorld(true);
      const target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
      target.texture.name = "ibatch-depth-warm-target";
      w = { scene, light, camera, target, ctx: _ctxOf(renderer), proxies: new Map() };
      S.depthWarm = w;
    }
    if (!w.proxies.has(de.key)) {
      // The carrier stands for a class material: getDepthMaterial copies its
      // map (the class dummy: USE_MAP on) and alphaTest (0, or the class
      // placeholder) onto the depth material, which decides the program.
      const carrier = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, map: dummyMap() });
      if (de.alpha) carrier.alphaTest = CLASS_ALPHA_TEST_PLACEHOLDER;
      const proxy = classPrewarmProxy(carrier, { instanced: false, extraAttributes: [IB_CELL_ATTR] });
      proxy.frustumCulled = true;
      proxy.position.set(0, 0, 10); // behind the warm camera, in front of the light
      proxy.castShadow = true;
      proxy.name = "ibatch-depth-warm-" + de.key;
      w.scene.add(proxy);
      w.proxies.set(de.key, proxy);
    }
    // The entry's CURRENT material (a released entry of the same key was disposed).
    w.proxies.get(de.key).customDepthMaterial = de.material;
    w.scene.updateMatrixWorld(true);
    const sm = renderer.shadowMap;
    const prevNeeds = sm.needsUpdate;
    const prevTarget = renderer.getRenderTarget();
    sm.needsUpdate = true;
    try {
      renderer.setRenderTarget(w.target);
      renderer.render(w.scene, w.camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      sm.needsUpdate = prevNeeds;
    }
    S.stats.depthWarms += 1;
  } catch (_) { /* fail-soft: the first raster links it */ }
}

// ===========================================================================
// Bits table.
// ===========================================================================

function _ensureBits(S, renderer) {
  if (S.bits) return S.bits;
  const gen = () => liveContextGeneration(renderer);
  S.bits = new RowTexture({
    texelsPerRow: IB_TEXELS_PER_ROW, rows: 64, name: "interior-batch-bits",
    onTexture: (tex) => trackContextGenerations(tex, gen),
    disposeTexture: disposeOnLiveContext,
  });
  S.bitsU.value = S.bits.texture;
  return S.bits;
}

function _writeChunkBits(S, chunk) {
  const bits = S.bits;
  if (!bits || chunk.row <= 0) return;
  const d = bits.data;
  const castOn = S.castOn === true;
  for (let i = 0; i < chunk.drawState.length; i += 1) {
    const v = chunk.drawState[i];
    if (ibSetBit(d, chunk.row, 0, i, v)) S.bitsDirty = true;
    if (ibSetBit(d, chunk.row, IB_CAST_BASE, i, v && castOn)) S.bitsDirty = true;
  }
}

// ===========================================================================
// The visibility notes (cells.js tickCellVisibility3D).
// ===========================================================================

/**
 * cells.js calls this right after each of tickCellVisibility3D's three
 * `container.visible` writes (idempotent: marks the bits dirty only on a
 * change). Returns at once for a container in no planned chunk.
 */
export function ibNoteVisible(container, v) {
  const ib = container && container.userData && container.userData.__ib;
  if (!ib) return;
  _applyNote(_S, ib.chunk, ib.cell, v ? 1 : 0);
}

function _applyNote(S, chunk, i, nv) {
  if (!S || chunk.drawState[i] === nv) return;
  chunk.drawState[i] = nv;
  if (chunk.row > 0 && S.bits) {
    const d = S.bits.data;
    if (ibSetBit(d, chunk.row, 0, i, nv)) S.bitsDirty = true;
    if (ibSetBit(d, chunk.row, IB_CAST_BASE, i, nv && S.castOn === true)) S.bitsDirty = true;
  }
  const objs = chunk.cellObjs[i];
  if (objs && objs.length && chunk.batches.length) {
    for (let k = 0; k < objs.length; k += 1) {
      const b = chunk.batches[objs[k]];
      if (!b || !b.mesh) continue;
      b.visibleCells += nv ? 1 : -1;
      const show = b.visibleCells > 0;
      if (b.mesh.visible !== show) b.mesh.visible = show;
    }
  }
}

function _chunkShown(chunk) {
  for (let i = 0; i < chunk.drawState.length; i += 1) if (chunk.drawState[i]) return true;
  return false;
}

// ===========================================================================
// Admit / warm / build / overlap / activate / teardown.
// ===========================================================================

/** Admit every member's layers + slot; then split batches by page. True = resident. */
function _admitChunk(S, chunk, pages, budget) {
  const members = new Set();
  for (const cp of chunk.cellPlans) for (const mp of cp.meshes) for (const e of mp.entries) members.add(e.member);
  for (const m of members) {
    // Held BEFORE anything is admitted: a teardown mid-admission releases
    // exactly what this chunk took.
    const e = _slotEntry(S, m);
    if (!chunk.slotsHeld.has(e)) { chunk.slotsHeld.add(e); e.chunks.add(chunk); }
    if (_slotResident(e)) continue;
    const out = {};
    if (!_slotAdmit(S, e, pages, budget, out)) {
      if (out.deferred) return false;
      _replanChunk(S, chunk, out.failed || "admit-failed");
      return false;
    }
  }
  // Final batches: (page key) groups split by the actual page ids.
  const byKey = new Map();
  for (let ci = 0; ci < chunk.cellPlans.length; ci += 1) {
    for (const mp of chunk.cellPlans[ci].meshes) {
      for (const e of mp.entries) {
        const se = S.slots.get(e.member);
        const mapPage = se.mapRef.page;
        const nrmPage = se.nrmRef ? se.nrmRef.page : null;
        const pomPage = se.pomRef ? se.pomRef.page : null;
        const k = e.pageKey + "|p" + mapPage.id + "|" + (nrmPage ? nrmPage.id : "-") + (pomPage ? "|h" + pomPage.id : "");
        let b = byKey.get(k);
        if (!b) {
          b = { key: k, preKey: e.preKey, kind: e.kind, cls: e.cls, entries: [], mapPage, nrmPage, pomPage, classEntry: null, depthEntry: null,
            mesh: null, geometry: null, visibleCells: 0, hasBaseCasters: false, cells: new Set(), receiveShadow: e.receiveShadow };
          byKey.set(k, b);
        }
        e.slot = se.slot;
        e.cellIdx = ci;
        b.entries.push(e);
        b.cells.add(ci);
        if (e.baseCast) b.hasBaseCasters = true;
      }
    }
  }
  chunk.batches = [...byKey.values()];
  return true;
}

/**
 * Class + depth materials of every batch. A NEW class entry (two class
 * materials, the chain dry runs) is one unit of the per-sync budget: true =
 * done, null = the budget ran out (the rest next sync), false = re-planned.
 */
function _resolveMaterials(S, chunk, env) {
  const shadowOn = !!(env.renderer && env.renderer.shadowMap && env.renderer.shadowMap.enabled);
  const W = S.work;
  for (const b of chunk.batches) {
    if (!b.classEntry) {
      if (W.classUnits > 0 && _now() >= W.deadline) return null;
      const n0 = S.classMats.size;
      b.classEntry = _classEntryFor(S, b);
      if (b.classEntry && S.classMats.size > n0) W.classUnits += 1;
      if (!b.classEntry) {
        if (!chunk.noKeys) chunk.noKeys = new Set();
        chunk.noKeys.add(b.preKey);
        _count(S.stats.unitReasons, "class-self-check");
        _replanChunk(S, chunk, "class-self-check");
        return false;
      }
    }
    if (!b.depthEntry && b.hasBaseCasters && shadowOn) b.depthEntry = _depthEntryFor(S, b.cls.blend, b.mapPage);
  }
  return true;
}

function _chunkReady(S, chunk, env) {
  let ready = true;
  for (const b of chunk.batches) {
    if (b.classEntry && !_classReady(S, b.classEntry, env)) ready = false;
    if (b.depthEntry && !_depthReady(S, b.depthEntry, env)) ready = false;
  }
  return ready;
}

/**
 * BUILDING -> MERGING: only while a cell of the chunk is drawn, the bit row
 * and the deferred geometry ticket are granted first (a refusal allocates
 * nothing; legacy keeps drawing). The ticket is charged here, before the
 * merge: the kit carries it into every following frame until three's upload
 * callbacks land it, so the frame that uploads (the render after the sync
 * that adds the objects) has the bytes booked whichever sync that is.
 */
function _startBuild(S, chunk, budget, env) {
  if (!_chunkShown(chunk)) return false;
  const bits = _ensureBits(S, env.renderer);
  if (chunk.row <= 0) {
    const row = bits.alloc(budget);
    if (row < 0) return false;
    if (row > IB_MAX_ROW) { bits.free(row); _setChunkLegacy(S, chunk, "bit-rows"); return false; }
    chunk.row = row;
    S.bitsU.value = bits.texture;
  }
  let bytes = 0;
  for (const b of chunk.batches) {
    for (const e of b.entries) e.code = ibPackCell(chunk.row, e.cellIdx, e.baseCast);
    bytes += chunkBytesOf(b.entries);
  }
  const ticket = budget.spendDeferred(bytes, UPLOAD_KIND.GEOMETRY);
  if (!ticket) return false;
  chunk.ticket = ticket;
  chunk.ticketBudget = budget;
  chunk.bytes = bytes;
  chunk.mergeAt = 0;
  for (const b of chunk.batches) { b.job = null; b.geometry = null; }
  _writeChunkBits(S, chunk);
  chunk.status = S_CHUNK.MERGING;
  return true;
}

/**
 * MERGING: merge the chunk's batches entry by entry under the per-sync budget
 * (at least one entry per sync); the sync that completes the last batch adds
 * every object at once (-> OVERLAP). Returns true when the objects are in.
 */
function _mergeChunkStep(S, chunk, budget, env) {
  const W = S.work;
  const t0 = uploadNowMs();
  // Merging never starves behind planning / class set-up / program warms of
  // the same sync: it gets at least a quarter of the budget.
  if (W.mergeDeadline === 0) W.mergeDeadline = Math.max(W.deadline, _now() + S.mergeMs * 0.25);
  while (chunk.mergeAt < chunk.batches.length) {
    if (W.mergeUnits > 0 && _now() >= W.mergeDeadline) break;
    const b = chunk.batches[chunk.mergeAt];
    if (!b.job) b.job = beginMerge(b.entries, chunk.rec.origin);
    const k0 = b.job.k;
    const done = mergeStep(b.job, W.mergeDeadline, _now);
    W.mergeUnits += b.job.k - k0;
    if (!done) break;
    const merged = finishMerge(b.job);
    b.job = null;
    b.geometry = merged.geometry;
    b.cpuBytes = merged.bytes;
    chunk.mergeAt += 1;
  }
  const ms = uploadNowMs() - t0;
  budget.addMs(UPLOAD_KIND.GEOMETRY, ms, "geometryBuild");
  S.stats.mergeMs += ms;
  S.stats.mergeSlices += 1;
  if (ms > S.stats.maxMergeMs) S.stats.maxMergeMs = ms;
  if (chunk.mergeAt < chunk.batches.length) return false;
  _addChunkObjects(S, chunk, budget, env);
  return true;
}

/** Every batch object of a merged chunk, added in one sync (-> OVERLAP). */
function _addChunkObjects(S, chunk, budget, env) {
  const ticket = chunk.ticket;
  const group = _lbGroup(S, chunk.rec);
  const lbHex = (chunk.rec.lbKey >>> 0).toString(16).padStart(8, "0");
  for (let i = 0; i < chunk.cellObjs.length; i += 1) chunk.cellObjs[i] = [];
  for (let k = 0; k < chunk.batches.length; k += 1) {
    const b = chunk.batches[k];
    const mesh = new THREE.Mesh(b.geometry, b.classEntry.material);
    mesh.name = `ibatch-${b.kind}-${lbHex}-${chunk.index}-${k}`;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeTranslation(chunk.rec.origin[0], chunk.rec.origin[1], chunk.rec.origin[2]);
    mesh.matrixWorldNeedsUpdate = true;
    mesh.raycast = noRaycast;
    mesh.frustumCulled = true;
    mesh.layers.mask = chunk.mask;
    mesh.receiveShadow = b.receiveShadow;
    if (b.depthEntry) mesh.customDepthMaterial = b.depthEntry.material;
    mesh.userData = { interiorBatch: true, lbKey: chunk.rec.lbKey, chunk: chunk.index, batchKey: b.key };
    b.visibleCells = 0;
    for (const ci of b.cells) {
      chunk.cellObjs[ci].push(k);
      if (chunk.drawState[ci]) b.visibleCells += 1;
    }
    mesh.visible = b.visibleCells > 0;
    mesh.castShadow = S.castOn === true && b.hasBaseCasters && !!b.depthEntry;
    _trackBatchGeometry(b.geometry, mesh, env.renderer, budget, ticket, b);
    b.mesh = mesh;
    group.add(mesh);
    mesh.updateWorldMatrix(true, false);
  }
  S.stats.builds += 1;
  chunk.casts = chunk.batches.some((b) => b.hasBaseCasters && b.depthEntry);
  const byMesh = new Map();
  for (let k = 0; k < chunk.batches.length; k += 1) {
    for (const e of chunk.batches[k].entries) {
      let mi = byMesh.get(e.mesh);
      if (!mi) { mi = { mesh: e.mesh, batches: new Set(), suppressed: false, casts: false }; byMesh.set(e.mesh, mi); }
      mi.batches.add(k);
      if (e.baseCast && chunk.batches[k].depthEntry) mi.casts = true;
    }
  }
  chunk.meshInfo = [...byMesh.values()];
  chunk.suppressed = [];
  chunk.status = S_CHUNK.OVERLAP;
  chunk.overlapFrames = 0;
}

const _protoBeforeRender = THREE.Object3D.prototype.onBeforeRender;
const _protoAfterRender = THREE.Object3D.prototype.onAfterRender;

/** Generation tag + upload ticket + S1 timings on a merged geometry (anim_scenery_batch.js shape). */
function _trackBatchGeometry(geo, mesh, renderer, budget, ticket, b) {
  let touched = -1;
  trackContextGenerations(geo, () => liveContextGeneration(renderer), () => { if (touched < 0) touched = uploadNowMs(); });
  const attrs = Object.values(geo.attributes);
  let left = attrs.length;
  function onAttrUpload() {
    delete this.onUploadCallback;
    budget.land(ticket, this.array.byteLength);
    if (this === geo.index) return;
    left -= 1;
    if (left === 0 && touched >= 0) budget.addMs(UPLOAD_KIND.GEOMETRY, uploadNowMs() - touched, "geometryUpload");
  }
  for (const a of attrs) a.onUploadCallback = onAttrUpload;
  if (geo.index) geo.index.onUploadCallback = onAttrUpload;
  let drawT0 = -1;
  mesh.onBeforeRender = function hbIbFirstDrawBegin() { drawT0 = uploadNowMs(); };
  mesh.onAfterRender = function hbIbFirstDrawEnd() {
    if (drawT0 >= 0) budget.addMs(UPLOAD_KIND.GEOMETRY, uploadNowMs() - drawT0, "geometryFirstDraw");
    b.drawn = true;
    mesh.onBeforeRender = _protoBeforeRender;
    mesh.onAfterRender = _protoAfterRender;
  };
}

/** Has three drawn this batch's class material at least once on this context? */
function _classDrawn(b, env) {
  if (!env.renderer || !b.classEntry) return true;
  let mp = null;
  try { mp = env.renderer.properties.get(b.classEntry.material); } catch (_) { mp = null; }
  return !!mp && mp.__version !== undefined;
}

let _frustum = null;
let _frustumFrame = -1;
/** Is `mesh` inside the camera frustum (three's own test; no camera: yes)? */
function _inView(mesh, env) {
  const cam = env.camera;
  if (!cam || !cam.projectionMatrix || !cam.matrixWorldInverse) return true;
  const S = _S;
  if (!_frustum) _frustum = { f: new THREE.Frustum(), m: new THREE.Matrix4() };
  if (_frustumFrame !== (S ? S.frameNo : 0)) {
    _frustumFrame = S ? S.frameNo : 0;
    _frustum.m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.f.setFromProjectionMatrix(_frustum.m, cam.coordinateSystem, cam.reversedDepth === true); // three r184 projectObject: the same
  }
  try { return _frustum.f.intersectsObject(mesh); } catch (_) { return true; }
}

/**
 * Overlap, per legacy MESH: a mesh stops drawing (sentinel) once three has
 * drawn the class material of every batch holding one of its groups — a
 * batch whose cells are all hidden right now cannot draw, and its legacy
 * meshes do not draw either (their container is hidden), so the rest of the
 * chunk does not wait for it. The chunk is ACTIVE when every mesh is
 * suppressed. A mesh whose batch is ON SCREEN but has not drawn yet counts
 * toward the give-up (async_link_guard holds a draw while its program links;
 * the legacy mesh keeps drawing meanwhile, never blinking out). One shadow
 * raster is requested whenever casters moved from legacy to batch.
 */
function _overlapStep(S, chunk, env) {
  let pending = 0;
  let pendingShown = 0;
  let moved = false;
  for (const mi of chunk.meshInfo) {
    if (mi.suppressed) continue;
    let ready = true;
    let shown = false;
    for (const k of mi.batches) {
      const b = chunk.batches[k];
      if (_classDrawn(b, env)) continue;
      ready = false;
      // An undrawn batch three would submit this frame: visible AND in the
      // camera frustum (a batch of cells in the visible set but behind the
      // camera cannot draw, and must not count toward the give-up).
      if (!shown && b.mesh && b.mesh.visible && _inView(b.mesh, env)) shown = true;
    }
    if (!ready) { pending += 1; if (shown) pendingShown += 1; continue; }
    const m = mi.mesh;
    if (m.frustumCulled !== true || Object.prototype.hasOwnProperty.call(m, "boundingSphere")) {
      _replanChunk(S, chunk, "frustum-culled-off");
      return;
    }
    suppressLegacy(m);
    mi.suppressed = true;
    chunk.suppressed.push(m);
    if (mi.casts) moved = true;
  }
  if (moved && S.castOn === true) _requestRaster(S, env);
  if (pending === 0) {
    chunk.status = S_CHUNK.ACTIVE;
    S.stats.activations += 1;
    return;
  }
  if (pendingShown > 0 && ++chunk.overlapFrames > BATCH_OVERLAP_GIVEUP_FRAMES) {
    _teardownChunk(S, chunk, env);
    _unstampChunk(chunk);
    S.stats.giveUps += 1;
    _setChunkLegacy(S, chunk, "never-drawn");
  }
}

function _requestRaster(S, env) {
  try { if (requestShadowRaster(env.renderer, S.scene3d)) S.stats.rasterRequests += 1; } catch (_) { /* fail-soft */ }
}

/** Chunk teardown: legacy back in this frame; every kit reference released. */
function _teardownChunk(S, chunk, env) {
  const wasLive = chunk.status === S_CHUNK.ACTIVE || chunk.status === S_CHUNK.OVERLAP;
  const hadSuppressedCasters = (chunk.meshInfo || []).some((mi) => mi.suppressed && mi.casts);
  if (chunk.ticket) { try { chunk.ticketBudget.drop(chunk.ticket); } catch (_) { /* fail-soft */ } chunk.ticket = null; chunk.ticketBudget = null; }
  for (const b of chunk.batches) {
    if (b.mesh && b.mesh.parent) b.mesh.parent.remove(b.mesh);
    if (b.geometry) { try { disposeOnLiveContext(b.geometry); } catch (_) { /* fail-soft */ } }
    if (b.classEntry) _releaseClassEntry(S, b.classEntry);
    if (b.depthEntry) _releaseDepthEntry(S, b.depthEntry);
    b.mesh = null;
    b.geometry = null;
    b.job = null; // a merge in progress: CPU arrays only, nothing reached GL
    b.classEntry = null;
    b.depthEntry = null;
  }
  chunk.batches = [];
  chunk.admitted = false;
  chunk.mergeAt = 0;
  chunk.replan = null;
  for (const e of chunk.slotsHeld) _releaseSlot(S, e, chunk);
  chunk.slotsHeld.clear();
  for (const m of chunk.suppressed) restoreLegacy(m);
  chunk.suppressed = [];
  chunk.meshInfo = [];
  if (chunk.row > 0 && S.bits) { S.bits.free(chunk.row); S.bitsDirty = true; }
  chunk.row = -1;
  for (let i = 0; i < chunk.cellObjs.length; i += 1) chunk.cellObjs[i] = [];
  S.stats.teardowns += 1;
  if (hadSuppressedCasters && env && env.renderer) _requestRaster(S, env);
  chunk.casts = false;
  return wasLive;
}

function _unstampChunk(chunk) {
  for (const cp of chunk.cellPlans) {
    const c = cp.cell.container;
    if (c && c.userData && c.userData.__ib && c.userData.__ib.chunk === chunk) delete c.userData.__ib;
  }
}

function _replanChunk(S, chunk, reason) {
  _teardownChunk(S, chunk, _env());
  _count(S.stats.unitReasons, "replan:" + reason);
  if (reason === "map" || reason === "normal-map" || reason === "pom-map") { // a texture swap (its own cap)
    chunk.textureReplans += 1;
    S.stats.textureReplans += 1;
    if (chunk.textureReplans > IB_TEXTURE_REPLAN_LIMIT) { _unstampChunk(chunk); _setChunkLegacy(S, chunk, "unstable"); return; }
  } else {
    chunk.replans += 1;
    S.stats.replans += 1;
    if (chunk.replans > BATCH_REPLAN_LIMIT) { _unstampChunk(chunk); _setChunkLegacy(S, chunk, "unstable"); return; }
  }
  chunk.status = S_CHUNK.PENDING;
  chunk.retryFrame = S.frameNo + 1;
}

function _teardownLb(rec, why) {
  const S = _S;
  if (!S) return;
  const env = _env();
  for (const ch of rec.chunks) {
    _teardownChunk(S, ch, env);
    _unstampChunk(ch);
    ch.status = S_CHUNK.LEGACY;
    ch.reason = why;
  }
  if (rec.group && rec.group.parent) rec.group.parent.remove(rec.group);
  rec.group = null;
}

function _lbGroup(S, rec) {
  if (rec.group) return rec.group;
  const root = _root(S);
  const g = new THREE.Group();
  g.name = `ibatch-lb-${(rec.lbKey >>> 0).toString(16).padStart(8, "0")}`;
  g.matrixAutoUpdate = false;
  g.layers.mask = rec.mask;
  rec.group = g;
  if (!rec.parked) root.add(g);
  g.updateWorldMatrix(true, false);
  return g;
}

/** The root Group: a worldRoot sibling of cellsGroup (same transform), layer 1. */
function _root(S) {
  if (S.root) return S.root;
  const s3 = S.scene3d;
  const cg = s3 && s3.cellsGroup;
  const r = new THREE.Group();
  r.name = "interior-batch";
  if (cg) {
    r.position.copy(cg.position);
    r.quaternion.copy(cg.quaternion);
    r.scale.copy(cg.scale);
    r.layers.mask = cg.layers.mask;
    r.visible = cg.visible !== false;
  }
  r.updateMatrix();
  r.matrixAutoUpdate = false;
  const parent = (s3 && s3.worldRoot) || (cg && cg.parent) || null;
  if (parent) parent.add(r);
  r.updateWorldMatrix(true, false);
  S.root = r;
  return r;
}

// ===========================================================================
// Drift (per sync, per live slot).
// ===========================================================================

/**
 * Has a live slot's member drifted (a reason) or not (null)? Runs per live
 * slot per sync: no allocation on the no-drift path (the class is compared
 * field by field, interiorMemberClass's own rules).
 */
function _slotDrift(e) {
  const m = e.member;
  if (m.transparent !== e.transparent || m.transparent === true) return "transparent";
  if (m.visible === false) return "invisible";
  if (m.side !== e.side) return "side";
  if (m.onBeforeCompile !== e.obc) return "chain";
  if ((m.alphaTest > 0 ? "alphaTest" : "opaque") !== e.clsBlend
    || (m.userData && m.userData.__acBakedLight ? "baked" : "lit") !== e.clsLight
    || (m.side === THREE.FrontSide ? "front" : "double") !== e.clsSide) return "alpha-class";
  if (m.version !== e.version) {
    const r = interiorArrayReason(m);
    if (r) return "member:" + r;
    if (interiorProgramKeyOf(m) !== e.programKey) return "chain";
    if (chainFingerprintId(m).id !== e.fp) return "chain";
    if (interiorMemberSignature(m) !== e.sig) return "signature";
    e.version = m.version;
  }
  for (const k of _NO_EXTRA_MAPS) if (m[k]) return "map:" + k;
  const em = m.emissive;
  if (em && (em.r !== 0 || em.g !== 0 || em.b !== 0)) return "luminous";
  if (m.map !== e.map || (m.map && m.map.version !== e.mapVersion)) return "map";
  if ((m.normalMap || null) !== e.normalMap || (e.normalMap && e.normalMap.version !== e.nrmVersion)) return "normal-map";
  if (e.pom) {
    // The height texture the chain binds (fixed per chain) re-uploaded, or a
    // live uniform handle pointing elsewhere: a texture swap.
    if (e.pomTex.version !== e.pomVersion) return "pom-map";
    const live = m.userData ? m.userData.pomShaderUniforms : null;
    if (live && live.uPomMap && live.uPomMap.value !== e.pomTex) return "pom-map";
  }
  return null;
}

/**
 * A map / normal-map swap whose new texture lands in the SAME page: the new
 * layer is admitted, the slot row rewritten, the old layer released — no
 * geometry re-upload. Returns "rewritten", "deferred" (budget: keep the old
 * layer this frame) or null (a different page: the chunks re-plan).
 */
function _trySamePageSwap(S, e, which, pages, budget) {
  const m = e.member;
  const tex = which === "map" ? m.map : m.normalMap;
  const ref = which === "map" ? e.mapRef : e.nrmRef;
  if (!tex || !ref || !pages) return null;
  const ti = interiorTextureInfo(tex);
  if (!ti.desc || ti.pageKey !== ref.page.key) return null;
  const r = pages.admit(tex, budget);
  if (r && r.deferred) return "deferred";
  if (!r) return null;
  if (r.page !== ref.page) { try { pages.release(r.contentKey); } catch (_) { /* fail-soft */ } return null; }
  try { ref.pages.release(ref.contentKey); } catch (_) { /* fail-soft */ }
  if (which === "map") { e.mapRef = { ...r, pages }; e.map = tex; e.mapVersion = tex.version; } else { e.nrmRef = { ...r, pages }; e.normalMap = tex; e.nrmVersion = tex.version; }
  kitStateTable().writeFromMaterial(e.slot, m, e.mapRef.layer, e.nrmRef ? e.nrmRef.layer : 0, _extRow(e));
  S.stats.slotRewrites += 1;
  return "rewritten";
}

function _syncSlots(S, pages, budget) {
  const table = kitStateTable();
  // Map iteration tolerates the deletions a re-plan makes; nothing is added here.
  for (const e of S.slots.values()) {
    if (e.dead || e.chunks.size === 0 || !_slotResident(e)) continue;
    let drift = _slotDrift(e);
    if (drift === "map" || drift === "normal-map") {
      const sw = _trySamePageSwap(S, e, drift, pages, budget);
      if (sw === "rewritten" || sw === "deferred") drift = sw === "deferred" ? null : _slotDrift(e);
    }
    if (drift) {
      for (const ch of [...e.chunks]) _replanChunk(S, ch, drift);
      continue;
    }
    if (e.slot >= 0 && e.mapRef) table.writeFromMaterial(e.slot, e.member, e.mapRef.layer, e.nrmRef ? e.nrmRef.layer : 0, _extRow(e));
    if (e.pomRow > 0 && e.pomRef) table.writePom(e.pomRow, pomStateOf(e.member, e.pom, e.pomRef.layer, e.pomState));
  }
}

// ===========================================================================
// LRU: hooks + reconcile fallback.
// ===========================================================================

function _lruDetached(lbKey, why) {
  const S = _S;
  if (!S) return;
  const rec = S.lbs.get(lbKey);
  if (!rec) return;
  if (why === "park") { _park(rec); return; }
  _evict(S, rec);
}

function _lruAttached(lbKey) {
  const S = _S;
  if (!S) return;
  const rec = S.lbs.get(lbKey);
  if (rec && rec.parked) _unpark(S, rec);
}

/**
 * Park: the batch group leaves the scene, and the parked legacy meshes lose
 * their sentinel (they are detached with their containers, so they draw
 * nothing either way). That way an unpark the batch has not heard of yet
 * (no landblock_lru.js hook: the LRU re-attaches the containers after this
 * frame's sync, before its render) draws the legacy meshes for that one
 * frame instead of a hole; the next sync's reconcile (or the hook) unparks.
 */
function _park(rec) {
  rec.parked = true;
  if (rec.group && rec.group.parent) rec.group.parent.remove(rec.group);
  for (const ch of rec.chunks) for (const m of ch.suppressed) restoreLegacy(m);
}

/** Unpark: the group back, the handed-over legacy meshes suppressed again, the bits re-read. */
function _unpark(S, rec) {
  rec.parked = false;
  if (rec.group && !rec.group.parent) _root(S).add(rec.group);
  for (const ch of rec.chunks) {
    if (ch.status !== S_CHUNK.ACTIVE && ch.status !== S_CHUNK.OVERLAP) continue;
    let ok = true;
    for (const m of ch.suppressed) {
      if (m.frustumCulled !== true || (Object.prototype.hasOwnProperty.call(m, "boundingSphere") && m.boundingSphere !== _sentinel)) { ok = false; break; }
    }
    if (!ok) { _replanChunk(S, ch, "frustum-culled-off"); continue; }
    for (const m of ch.suppressed) suppressLegacy(m);
  }
  _backstopLb(S, rec);
}

function _evict(S, rec) {
  _teardownLb(rec, "evicted");
  S.lbs.delete(rec.lbKey);
}

function _repAttached(S, rec) {
  const s3 = S.scene3d;
  const rep = rec.rep;
  if (!rep || !s3) return true;
  const reg = s3.cellContainers3d;
  // rep = [container, cellId]: a tagged array slot, so the id reaches
  // Map.get without boxing a number every sync.
  return rep[0].parent === s3.cellsGroup && (!(reg instanceof Map) || reg.get(rep[1]) === rep[0]);
}

function _reconcile(S) {
  for (const rec of S.lbs.values()) { // an evict deletes the CURRENT entry: safe
    const attached = _repAttached(S, rec);
    if (!attached && !rec.parked) {
      let parked = false;
      try { parked = !!S.scene3d?.landblockLru?.isParked?.(rec.lbKey); } catch (_) { parked = false; }
      if (parked) _park(rec); else _evict(S, rec);
    } else if (attached && rec.parked) {
      _unpark(S, rec);
    }
  }
}

// ===========================================================================
// Backstop: bits rebuilt from container.visible.
// ===========================================================================

function _backstopChunk(S, chunk, poolCheck) {
  const reg = poolCheck && S.poolsOn ? getPoolRegistry() : null;
  for (let i = 0; i < chunk.cellPlans.length; i += 1) {
    const cp = chunk.cellPlans[i];
    const c = cp.cell.container;
    if (!c) continue;
    const v = c.visible === true ? 1 : 0;
    if (chunk.drawState[i] !== v) {
      S.stats.bitMismatch += 1;
      _applyNote(S, chunk, i, v);
    }
    // The pooled half of the cell (pools armed): its registry PVS hide state
    // must say the same as the container (and so the DRAW bit). Counted, not
    // corrected: the pools own it, and the bits follow the container. Only in
    // the in-sync backstop, right after the tick flipped both halves (an
    // unpark's backstop runs from the LRU hook, before the next tick has
    // re-decided the re-attached containers).
    if (reg && c.userData && c.userData.__ibPool && c.userData.__ibPool.pooled > 0 && typeof reg.readCellState === "function") {
      const r = S.poolRead || (S.poolRead = { instances: 0, hidden: 0 });
      if (reg.readCellState(cp.cell.cellId, r)) {
        S.stats.pools.visChecks += 1;
        if (r.hidden !== (v ? 0 : r.instances)) S.stats.pools.visDiverged += 1;
      }
    }
    if (chunk.status === S_CHUNK.ACTIVE || chunk.status === S_CHUNK.OVERLAP) {
      if (c.layers.mask !== chunk.mask) { _replanChunk(S, chunk, "layer-drift"); return; }
    }
  }
}

function _backstopLb(S, rec, poolCheck = false) {
  for (const ch of rec.chunks) if (ch.status !== S_CHUNK.LEGACY) _backstopChunk(S, ch, poolCheck);
}

// ===========================================================================
// Context loss / restore (the K3 generation rules).
// ===========================================================================

function _contextChanged(S, pages) {
  const env = _env();
  for (const rec of S.lbs.values()) {
    for (const ch of rec.chunks) {
      if (ch.status === S_CHUNK.LEGACY) continue;
      _teardownChunk(S, ch, env);
      ch.status = S_CHUNK.PENDING;
      ch.retryFrame = S.frameNo + 1;
    }
  }
  if (pages) { try { pages.reset(); } catch (_) { /* fail-soft */ } }
  if (S.bits) { try { S.bits.dispose(); } catch (_) { /* fail-soft */ } S.bits = null; S.bitsU.value = null; }
  S.depthWarm = null;
  S.stats.contextResets += 1;
}

function _watchContext(S, renderer) {
  // Per sync: the early return only (the listener closure lives in
  // _installContextWatch, so this call allocates no closure context).
  if (S.watch && S.watch.renderer === renderer) return;
  _installContextWatch(S, renderer);
}

function _installContextWatch(S, renderer) {
  _unwatchContext(S);
  const el = renderer && renderer.domElement;
  if (!el || typeof el.addEventListener !== "function") { S.watch = { renderer, el: null, onEvent: null }; return; }
  const onEvent = () => { try { _contextChanged(S, kitPages(renderer)); } catch (_) { /* the next sync re-checks */ } };
  el.addEventListener("webglcontextlost", onEvent, false);
  el.addEventListener("webglcontextrestored", onEvent, false);
  S.watch = { renderer, el, onEvent };
}

function _unwatchContext(S) {
  const w = S.watch;
  S.watch = null;
  if (!w || !w.el || !w.onEvent) return;
  try {
    w.el.removeEventListener("webglcontextlost", w.onEvent, false);
    w.el.removeEventListener("webglcontextrestored", w.onEvent, false);
  } catch (_) { /* fail-soft */ }
}

// ===========================================================================
// The per-frame sync (cells.js, end of tickCellVisibility3D).
// ===========================================================================

function _cameraLb(S) {
  const env = _env();
  const cam = env.camera;
  if (!cam || !cam.matrixWorld) return null;
  const e = cam.matrixWorld.elements;
  // three (x, y, z) -> AC (x, -z, y) under worldRoot's -pi/2 X rotation.
  return [Math.floor(e[12] / 192), Math.floor(-e[14] / 192)];
}

function _lbDist(rec, at) {
  if (!at) return 0;
  const x = (rec.lbKey >>> 24) & 0xff;
  const y = (rec.lbKey >>> 16) & 0xff;
  return Math.max(Math.abs(x - at[0]), Math.abs(y - at[1]));
}

/**
 * Once per frame, at the end of tickCellVisibility3D (after the three write
 * loops and the shadow-raster request): castOn rows, root visibility, the
 * LRU reconcile, slot drift, plan / admit / warm / build / activate, the
 * backstop, then the one bits upload and the kit state flush.
 */
export function syncInteriorBatches(scene3d, isIndoor, castOn) {
  const S = _S;
  if (!S) return;
  const syncT0 = uploadNowMs();
  if (scene3d && !S.scene3d) _install(S, scene3d);
  S.frameNo += 1;
  // The env-cell draw pools (`?drawPools`, default on): planning reads the
  // shell split from their state, the backstop their per-cell hide state.
  const poolsOn = _poolsActive();
  if (S.poolsOn !== poolsOn) { S.poolsOn = poolsOn; S.stats.pools.active = poolsOn; }
  // The kit frame id: the app's rAF timestamp (shared with every kit
  // consumer of the frame), or a sync-local id when there is none. Two calls,
  // not one mixed number / string value: no number boxed for a phi.
  const ts = scene3d?.frameTime?.tsMs;
  const freshTs = Number.isFinite(ts) && ts !== S.lastTs;
  S.lastTs = ts;
  const want = castOn !== false;
  if (S.castOn !== want) {
    S.castOn = want;
    _applyCastOn(S);
  }
  if (S.root && S.scene3d && S.scene3d.cellsGroup) {
    const v = S.scene3d.cellsGroup.visible !== false;
    if (S.root.visible !== v) S.root.visible = v;
  }
  if (S.mode === "plan") {
    _reconcile(S);
    _workBegin(S);
    _planPending(S);
    return;
  }
  if (S.off) return;
  const dis = _disarmReason(S);
  if (dis) {
    if (S.disarmed !== dis) {
      S.disarmed = dis;
      _count(S.stats.disarmed, dis);
      for (const rec of S.lbs.values()) _teardownLb(rec, "disarmed:" + dis);
    }
    return;
  }
  if (S.disarmed) {
    S.disarmed = null;
    for (const rec of S.lbs.values()) _restartLb(S, rec);
  }
  if (freshTs) kitBeginFrame(ts);
  else kitBeginFrame(`ib:${S.frameNo}`);
  const budget = kitBudget();
  const env = _env();
  let pages = null;
  if (env.renderer) {
    _watchContext(S, env.renderer);
    pages = kitPages(env.renderer);
    if (pages && pages.contextLost()) {
      _contextChanged(S, pages);
      kitFlush();
      return;
    }
  } else {
    S.rendererWaits = (S.rendererWaits | 0) + 1;
    if (S.rendererWaits > BATCH_RENDERER_WAIT_FRAMES && S.disarmed !== "no-renderer") {
      S.disarmed = "no-renderer";
      _count(S.stats.disarmed, "no-renderer");
    }
    return;
  }
  _reconcile(S);
  _syncSlots(S, pages, budget);
  _workBegin(S);
  _planPending(S);
  _advanceChunks(S, pages, budget, env);
  if (S.frameNo % IB_BACKSTOP_SYNCS === 0) for (const rec of S.lbs.values()) if (!rec.parked) _backstopLb(S, rec, true);
  if (S.recording) _recordFrame(S, isIndoor, want);
  if (S.bits) {
    if (S.bitsU.value !== S.bits.texture) S.bitsU.value = S.bits.texture;
    if (S.bitsDirty) {
      S.bitsDirty = false;
      S.bits.markDirty();
      const b = S.bits.flush();
      if (b > 0) { S.stats.bitUploads += 1; S.stats.bitUploadBytes += b; }
    }
  }
  kitFlush();
  const ms = uploadNowMs() - syncT0;
  if (ms > S.stats.maxSyncMs) S.stats.maxSyncMs = ms;
}

/** Open this sync's CPU budget (planning, class set-up and merging share it). */
function _workBegin(S) {
  const W = S.work;
  W.deadline = _now() + S.mergeMs;
  W.mergeDeadline = 0;
  W.planUnits = 0;
  W.classUnits = 0;
  W.warmUnits = 0;
  W.mergeUnits = 0;
}

function _restartLb(S, rec) {
  rec.status = "pending";
  rec.reason = null;
  rec.chunks = [];
  rec.planning = null;
}

function _applyCastOn(S) {
  for (const rec of S.lbs.values()) {
    for (const ch of rec.chunks) {
      if (ch.row > 0) _writeChunkBits(S, ch);
      for (const b of ch.batches) if (b.mesh) b.mesh.castShadow = S.castOn === true && b.hasBaseCasters && !!b.depthEntry;
    }
  }
}

const _planWaiting = (rec) => (rec.status === "pending" || rec.status === "planning") && !rec.parked;

/**
 * Plan waiting landblocks, nearest the camera first, under the per-sync
 * budget (a landblock part-planned keeps its cursor: status "planning").
 */
function _planPending(S) {
  let any = false;
  for (const rec of S.lbs.values()) if (_planWaiting(rec)) { any = true; break; }
  if (!any) return; // steady state: no allocation
  const t0 = uploadNowMs();
  const at = _cameraLb(S);
  const pend = [];
  for (const rec of S.lbs.values()) if (_planWaiting(rec)) pend.push(rec);
  pend.sort((a, b) => _lbDist(a, at) - _lbDist(b, at));
  const W = S.work;
  for (const rec of pend) {
    if (W.planUnits > 0 && _now() >= W.deadline) break;
    if (!_planLbStep(S, rec)) break; // the budget ran out inside this landblock
  }
  const ms = uploadNowMs() - t0;
  S.stats.planMs += ms;
  S.stats.planSlices += 1;
  if (ms > S.stats.maxPlanMs) S.stats.maxPlanMs = ms;
}

function _advanceChunks(S, pages, budget, env) {
  let any = false;
  for (const rec of S.lbs.values()) {
    if (rec.status !== "planned" || rec.parked) continue;
    for (const ch of rec.chunks) if (ch.status !== S_CHUNK.LEGACY && ch.status !== S_CHUNK.ACTIVE) { any = true; break; }
    if (any) break;
  }
  if (!any) return; // steady state: no allocation
  const at = _cameraLb(S);
  const work = [];
  for (const rec of S.lbs.values()) {
    if (rec.status !== "planned" || rec.parked) continue;
    for (const ch of rec.chunks) if (ch.status !== S_CHUNK.LEGACY) work.push(ch);
  }
  if (work.length === 0) return;
  work.sort((a, b) => _lbDist(a.rec, at) - _lbDist(b.rec, at) || a.index - b.index);
  for (const ch of work) {
    if (ch.status === S_CHUNK.ACTIVE) continue;
    if (ch.status === S_CHUNK.OVERLAP) {
      _overlapStep(S, ch, env);
      continue;
    }
    if (ch.status === S_CHUNK.PENDING) {
      if (S.frameNo < ch.retryFrame) continue;
      if (!_planChunkEntries(S, ch)) continue;
      if (ch.noKeys) {
        for (const cp of ch.cellPlans) cp.meshes = cp.meshes.filter((mp) => !mp.entries.some((e) => ch.noKeys.has(e.preKey)));
      }
      if (!ch.cellPlans.some((cp) => cp.meshes.length > 0)) { _unstampChunk(ch); _setChunkLegacy(S, ch, "nothing-eligible"); continue; }
      ch.status = S_CHUNK.ADMITTING;
    }
    if (ch.status === S_CHUNK.ADMITTING) {
      if (!pages) continue;
      _ensureBits(S, env.renderer);
      if (!ch.admitted) {
        if (!_admitChunk(S, ch, pages, budget)) continue;
        ch.admitted = true;
      }
      if (_resolveMaterials(S, ch, env) !== true) continue;
      ch.status = S_CHUNK.WARMING;
    }
    if (ch.status === S_CHUNK.WARMING) {
      if (!_chunkReady(S, ch, env)) continue;
      ch.status = S_CHUNK.BUILDING;
    }
    if (ch.status === S_CHUNK.BUILDING) {
      if (!_startBuild(S, ch, budget, env)) continue;
    }
    if (ch.status === S_CHUNK.MERGING) _mergeChunkStep(S, ch, budget, env);
  }
}

// ===========================================================================
// Dispose / diag.
// ===========================================================================

/** Teardown of everything (scene dispose; tests). The kit's pages stay (shared). */
export function disposeInteriorBatches() {
  const S = _S;
  if (!S) return;
  for (const rec of S.lbs.values()) _teardownLb(rec, "disposed");
  S.lbs.clear();
  for (const ce of S.classMats.values()) _disposeMaterial(ce.material);
  S.classMats.clear();
  for (const de of S.depthMats.values()) _disposeMaterial(de.material);
  S.depthMats.clear();
  if (S.root && S.root.parent) S.root.parent.remove(S.root);
  S.root = null;
  if (S.bits) { try { S.bits.dispose(); } catch (_) { /* fail-soft */ } S.bits = null; }
  _unwatchContext(S);
  try { if (S.scene3d && S.scene3d.interiorBatchHooks) delete S.scene3d.interiorBatchHooks; } catch (_) { /* fail-soft */ }
  try { if (typeof window !== "undefined" && window.__interiorBatch) delete window.__interiorBatch; } catch (_) { /* fail-soft */ }
  _S = null;
}

function _lbSummary(rec) {
  const byStatus = {};
  let objects = 0;
  let drawn = 0;
  for (const ch of rec.chunks) {
    byStatus[ch.status] = (byStatus[ch.status] || 0) + 1;
    for (const b of ch.batches) if (b.mesh) { objects += 1; if (b.mesh.visible) drawn += 1; }
  }
  return {
    lb: "0x" + (rec.lbKey >>> 0).toString(16).padStart(8, "0"), status: rec.status, reason: rec.reason, parked: rec.parked,
    cells: rec.cells.length, chunks: byStatus, objects, drawn, plan: rec.plan ? JSON.parse(JSON.stringify(rec.plan)) : null,
  };
}

function _pomSlotCount(S) {
  let n = 0;
  for (const e of S.slots.values()) if (e.pom && e.pomRow > 0) n += 1;
  return n;
}

/** Diag (window.__interiorBatch.stats()). */
export function interiorBatchDiag() {
  const S = _S;
  if (!S) return null;
  const lbs = {};
  const chunks = {};
  let objects = 0;
  let drawn = 0;
  let geometryCpu = 0;
  for (const rec of S.lbs.values()) {
    lbs[rec.status] = (lbs[rec.status] || 0) + 1;
    for (const ch of rec.chunks) {
      chunks[ch.status] = (chunks[ch.status] || 0) + 1;
      for (const b of ch.batches) if (b.mesh) { objects += 1; if (b.mesh.visible) drawn += 1; geometryCpu += b.cpuBytes || 0; }
    }
  }
  return {
    mode: S.mode, off: S.off, disarmed: S.disarmed, lbs, chunks, objects, drawnObjects: drawn,
    slots: S.slots.size, pomSlots: _pomSlotCount(S), classMaterials: S.classMats.size, depthMaterials: S.depthMats.size,
    bytes: { geometryCpu, bits: S.bits ? S.bits.bytesFor(S.bits.capacity) : 0 },
    ...JSON.parse(JSON.stringify(S.stats)),
    kit: kitSummary(),
  };
}

/** The census (`?interiorBatch=plan` or on): per landblock. */
export function interiorBatchPlan() {
  const S = _S;
  if (!S) return [];
  const out = [];
  for (const rec of S.lbs.values()) out.push(_lbSummary(rec));
  return out;
}

// --- recorded walks (capture seam for tests/fixtures/interior_batch_walk_*.json) ---
// recordWalk(n, sessionHandle): for the next n syncs, every call the
// visibility tick makes on `sessionHandle` is recorded with its result, plus
// the frame's output (the container.visible cell set). The B2 replay drives
// cells.js tickCellVisibility3D with a stub that answers the recorded calls.
const _REC_METHODS = [
  "getCurrentCellId", "isCurrentCellIndoor", "getRenderSet", "getViewerRenderSet", "getRenderSetWithFrustum",
  "getRenderSetWithPView", "resolveViewerCell", "currentDungeonHasOutdoorPortal", "getVisiblePortalApertures",
  "isCurrentCellSeenOutside", "isCellSeenOutside",
];

function _plain(v) {
  if (v === null || v === undefined || typeof v !== "object") return v;
  if (ArrayBuffer.isView(v)) return Array.from(v);
  if (Array.isArray(v)) return v.map(_plain);
  return null;
}

function _startRecording(S, n, sh) {
  const rec = { frames: [], cur: { calls: [] }, left: n | 0, sh, saved: [] };
  if (sh) {
    for (const k of _REC_METHODS) {
      const f = sh[k];
      if (typeof f !== "function") continue;
      rec.saved.push([k, f]);
      sh[k] = function hbIbRecorded(...args) {
        const r = f.apply(this, args);
        rec.cur.calls.push([k, args.map((a) => (ArrayBuffer.isView(a) ? Array.from(a) : _plain(a))), _plain(r)]);
        return r;
      };
    }
  }
  S.recording = rec;
  return rec;
}

function _stopRecording(S) {
  const rec = S.recording;
  if (!rec) return null;
  S.recording = null;
  if (rec.sh) for (const [k, f] of rec.saved) { try { rec.sh[k] = f; } catch (_) { /* fail-soft */ } }
  return rec.frames;
}

function _recordFrame(S, isIndoor, castOn) {
  const rec = S.recording;
  const reg = S.scene3d && S.scene3d.cellContainers3d;
  const visible = [];
  if (reg instanceof Map) for (const [id, c] of reg) if (c && c.visible) visible.push(id >>> 0);
  visible.sort((a, b) => a - b);
  rec.frames.push({ isIndoor: !!isIndoor, castOn: !!castOn, calls: rec.cur.calls, visible });
  rec.cur = { calls: [] };
  rec.left -= 1;
  if (rec.left <= 0) {
    const frames = _stopRecording(S);
    S.lastRecording = frames;
  }
}

function _diagApi() {
  return {
    stats: () => interiorBatchDiag(),
    plan: () => interiorBatchPlan(),
    lb: (lbKey) => {
      const S = _S;
      const rec = S ? S.lbs.get(((lbKey >>> 0) & 0xffff0000) >>> 0) : null;
      return rec ? _lbSummary(rec) : null;
    },
    get off() { return !!(_S && _S.off); },
    set off(v) {
      const S = _S;
      if (!S) return;
      const on = !!v;
      if (on === S.off) return;
      S.off = on;
      for (const rec of S.lbs.values()) {
        if (on) _teardownLb(rec, "off");
        else _restartLb(S, rec);
      }
    },
    recordWalk: (n = 600, sessionHandle) => {
      const S = _S;
      if (!S) return false;
      let sh = sessionHandle;
      try { if (!sh && typeof window !== "undefined") sh = window.__sessionHandle || null; } catch (_) { sh = null; }
      _startRecording(S, n, sh);
      return true;
    },
    takeWalk: () => {
      const S = _S;
      if (!S) return null;
      if (S.recording) return _stopRecording(S);
      const f = S.lastRecording || null;
      S.lastRecording = null;
      return f;
    },
  };
}
