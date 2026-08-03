// Phase 7.1 — terrain heightfield + bilinear-blend shader.
//
// Ports the GLSL ES 3.00 shader pair from `index.html:975-1082` to a
// `THREE.ShaderMaterial`. The 2D path uses PIXI v8's MeshPipe shader
// chain (`uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix`,
// `vColor` modulation, `aPosition` as vec2) — three.js injects its own
// `projectionMatrix` + `modelViewMatrix` + `position` (vec3) so we
// drop the PIXI plumbing and keep the bilinear-blend body byte-for-
// byte identical, which is what the visual output depends on.
//
// Builds one heightfield Mesh per landblock (Holtburg 9-LB ring), each
// with vertex Z = real terrain height in metres (range [0, 510]). The
// 2D `buildLandblockChildren` path (`index.html:2071-2199`) flattens to
// 2D positions before upload; we keep the third dimension and rely on
// `computeVertexNormals()` (called inside `landblockMeshToGeometry`)
// to set up Lambert sun lighting for Phase 7.6.
//
// Roads are painted inside the terrain shader (uRoadEnabled block
// below) — bilinear-blend on the per-vertex road flag from
// uVertexTypes.G, gated by smoothstep(0.85, 0.95) for a ~5 m band
// matching retail's _road_width (acclient.c:467318). The prior
// triangle-strip overlay mesh is gone.

import * as THREE from "three";
import { prewarmSubtree } from "./bake_prewarm.js";
import {
  landblockMeshToGeometry,
  subdividedLandblockMeshToGeometry,
  buildVertexTypesDataTexture,
  buildTerrainAtlasArrayBytes,
  buildTerrainDetailArrayBytes,
  buildAlphaMaskArrayBytes,
  getAdapterMaxAnisotropy,
  loadPbrTerrainAtlasSet,
  applyPbrColorOverrides,
  buildPbrNraTexture,
} from "./adapter.js";
// ?terrainBc7=on (DEFAULT OFF) — retail-derived BC7 terrain atlas. The A/B twin
// of the CC0 `?pbrTerrain` arm above: same 33 layers, but the albedo is the art
// AC shipped (4x realesrgan-x4plus, the statics model) delivered as BC7 with a
// full mip chain, and normal/roughness/AO/height are derived from that same
// retail albedo instead of coming from a CC0 set authored for different pixels.
// Flag absent ⇒ every export here returns null before fetching ⇒ the CC0 path
// below runs byte-for-byte unchanged. See scene3d/terrain_bc7.js.
import {
  terrainBc7Enabled,
  buildTerrainBc7Atlas,
  terrainBc7Stats,
} from "./terrain_bc7.js";
// 2026-08-02 — FAR MACRO ("mspaint" fix). Default ON; `?terrainMacro=off`
// makes every export below inert (loader returns null → uMacroEnabled 0 →
// the fragment branch is skipped → render byte-identical to before).
import {
  terrainMacroEnabled,
  loadTerrainMacroArray,
  macroNumFlag,
  MACRO_SLICE_NONE,
  MACRO_STRENGTH_DEFAULT,
  MACRO_FADE_START_DEFAULT,
  MACRO_FADE_END_DEFAULT,
  MACRO_SCALE_A_DEFAULT,
  MACRO_SCALE_B_DEFAULT,
  MACRO_NOISE_AMP_DEFAULT,
} from "./terrain_macro.js";
import { applyWireVertexAOPatch, applyFillDepthBias } from "./materials.js";
// streamFix urgent lane (2026-07-02) — near-player bake detection.
import { isNearPlayerLb } from "./landblock_lru.js";
// FCULL (2026-06-08) — distance horizon for the OPT-IN per-LB terrain cull
// (`?cullTerrain=on`). Default OFF: three.js already per-mesh frustum-culls
// terrain LB meshes correctly (plain Meshes with a lazily-computed geometry
// bounding sphere), so app-level terrain culling is redundant in the common
// case and exists only for A/B eye-test. Only the constant is imported.
import { CULL_DIST_SQ } from "./culling.js";
// ?terrainBatch (2026-07-02) — OPT-IN cross-LB terrain draw consolidation
// (~203 per-LB draws → 1 BatchedMesh multidraw). terrain_batch.js never
// imports this module back (the GLSL strings are passed as arguments), so
// there is no cycle. Flag off ⇒ both imports are inert.
import {
  terrainBatchEnabled,
  tryAbsorbTerrainLbIntoBatch,
} from "./terrain_batch.js";
// Wave 1B — the sand family LUT (leaf module, imports nothing) + the two flag
// readers that gate the grain sparkle. `terrain_families.js` is the single
// source of truth for which CODES are sand; `vfx_flags.js` owns every
// terrain-VFX flag reader (no second reader, plan §2.4).
import { FAM_SAND, FAM_SNOWICE, FAM_VOLCANO, FAM_DIRT, familyForCode } from "./terrain_families.js";
import { terrainSandEnabled, terrainSandSparkleEnabled } from "./vfx_flags.js";
// Wave 2A (SNOW/ICE) — a SECOND import statement from the same module rather
// than widening the line above, deliberately: `test_terrain_sand_sparkle.mjs`
// locks that exact one-line form as its "no second reader" assertion, and one
// family's test should not have to be rewritten for another family's landing.
// ESM dedupes the module either way.
import {
  terrainSnowEnabled,
  terrainSnowSparkleEnabled,
  terrainSnowPrintsEnabled,
  terrainIceEnabled,
  terrainIceRefractionEnabled,
} from "./vfx_flags.js";
// Wave 2B (plan §3.6) — same rationale, third statement (ESM dedupes).
import { terrainVolcanoEnabled, terrainCrackGlowEnabled } from "./vfx_flags.js";
// Wave 3B (plan §3.7, DIRT/MUD) — same rationale, fourth statement.
import { terrainDirtEnabled, terrainMudPrintsEnabled, terrainMudWetnessEnabled } from "./vfx_flags.js";

// ----- AC world-coord constants -------------------------------------
const METERS_PER_LANDBLOCK = 192.0;
// HOLTBURG_X/HOLTBURG_Y retired (spawn-driven-boot): the buildHoltburgTerrain
// wrapper that referenced them is gone.

// ----- Phase 1.2 — terrain detail normal mapping --------------------
//
// Region 0x13 ("Dereth") publishes 32 terrain types via `TerrainDesc`.
// Names come from `get-region` against the retail portal.dat. Each code
// maps to one of 5 detail-normal slices (grass / dirt / sand / stone /
// snow) or to the sentinel UNKNOWN (255) for water + swamp + slime,
// which we render flat at the detail layer.
//
// Slice ordering matches `TERRAIN_DETAIL_KEYS` in adapter.js:
//   0 grass | 1 dirt | 2 sand | 3 stone | 4 snow
//
// Verified against Holtburg LB 0xA9B4 (`get-terrain-layers`):
//   3 LushGrass (42%), 1 Grassland (22%), 14 SemiBarrenRock (22%),
//   9 PatchyGrassland (14%) — all map to grass/stone, exercises the
//   blend correctly.
const DETAIL_SLICE_GRASS = 0;
const DETAIL_SLICE_DIRT = 1;
const DETAIL_SLICE_SAND = 2;
const DETAIL_SLICE_STONE = 3;
const DETAIL_SLICE_SNOW = 4;
const DETAIL_SLICE_NONE = 255;

// 2026-05-22 — wire-agent fill palette. One sRGB triple per terrain code
// (0..31), approximating the per-code base colour of the atlas texture
// `TERRAIN_TEXTURE_NAMES` would sample at distance. The wire-mode bake
// builds a per-vertex `color` BufferAttribute from this table + the
// existing per-vertex `terrainCode` attribute, so MeshBasicMaterial
// ({vertexColors:true}) can render distinguishable terrain types without
// the 33-layer DataArrayTexture upload that dominates `resolveTerrainRing-
// Opts` (the ~840ms silent gap in the wire-agent boot profile). Values
// stay in sRGB — three.js's LinearSRGBColorSpace conversion at upload
// linearises them.
const TERRAIN_CODE_TO_RGB = new Float32Array([
  /*  0 BarrenRock         */ 0.36, 0.32, 0.26,
  /*  1 Grassland          */ 0.34, 0.46, 0.20,
  /*  2 Ice                */ 0.78, 0.86, 0.92,
  /*  3 LushGrass          */ 0.40, 0.56, 0.22,
  /*  4 MarshSparseSwamp   */ 0.34, 0.40, 0.20,
  /*  5 MudRichDirt        */ 0.30, 0.22, 0.12,
  /*  6 ObsidianPlain      */ 0.16, 0.16, 0.20,
  /*  7 PackedDirt         */ 0.38, 0.28, 0.18,
  /*  8 PatchyDirt         */ 0.46, 0.36, 0.24,
  /*  9 PatchyGrassland    */ 0.42, 0.50, 0.22,
  /* 10 sand-yellow        */ 0.78, 0.66, 0.40,
  /* 11 sand-grey          */ 0.70, 0.62, 0.50,
  /* 12 sand-rockStrewn    */ 0.60, 0.54, 0.42,
  /* 13 SedimentaryRock    */ 0.46, 0.42, 0.36,
  /* 14 SemiBarrenRock     */ 0.52, 0.46, 0.38,
  /* 15 Snow               */ 0.90, 0.92, 0.96,
  /* 16 WaterRunning       */ 0.18, 0.26, 0.42,
  /* 17 WaterStandingFresh */ 0.14, 0.24, 0.46,
  /* 18 WaterShallowSea    */ 0.18, 0.34, 0.50,
  /* 19 WaterShallowStillSea*/ 0.16, 0.30, 0.46,
  /* 20 WaterDeepSea       */ 0.10, 0.18, 0.38,
  /* 21 forestfloor        */ 0.22, 0.30, 0.16,
  /* 22 FauxWaterRunning   */ 0.18, 0.28, 0.46,
  /* 23 SeaSlime           */ 0.30, 0.38, 0.20,
  /* 24 Argila             */ 0.42, 0.24, 0.18,
  /* 25 Volcano1           */ 0.30, 0.20, 0.18,
  /* 26 Volcano2           */ 0.22, 0.16, 0.16,
  /* 27 BlueIce            */ 0.68, 0.80, 0.92,
  /* 28 Moss               */ 0.28, 0.36, 0.20,
  /* 29 DarkMoss           */ 0.16, 0.24, 0.12,
  /* 30 olthoi             */ 0.32, 0.24, 0.34,
  /* 31 DesolateLands      */ 0.34, 0.30, 0.24,
]);

function buildWireTerrainColors(terrainCodes) {
  const out = new Float32Array(terrainCodes.length * 3);
  for (let i = 0; i < terrainCodes.length; i += 1) {
    // Mask to 5 bits — table is 32 codes; defensive against any future
    // bit-packing into the high nibbles of the per-vertex code byte.
    const code = terrainCodes[i] & 0x1f;
    const base = code * 3;
    out[i * 3 + 0] = TERRAIN_CODE_TO_RGB[base + 0];
    out[i * 3 + 1] = TERRAIN_CODE_TO_RGB[base + 1];
    out[i * 3 + 2] = TERRAIN_CODE_TO_RGB[base + 2];
  }
  return out;
}

/**
 * 2026-05-28 — Per-vertex brightness factor for TerrainTex vertex
 * modulation.
 *
 * Retail's `TerrainTex` carries (min_bright, max_bright) ranges per
 * terrain type — 90..100 for most natural terrain (very subtle
 * variation), 30..60 for Ice (type 2) and RoadType (type 32). The
 * values are written to the DAT but acclient.c never applies them; we
 * restore the authors' intent here by picking a random value per
 * vertex within the type's range, hashed by world position so the
 * same vertex always gets the same modulation (cache-stable, no
 * frame-to-frame flicker, seamless across LB seams).
 *
 * Best-guess unit interpretation (untestable against acclient.c since
 * no application code exists): `bright` is a percentage in 0-100,
 * applied as a multiplier on the final fragment color
 * (`color *= bright / 100`). This makes Ice/Road dramatically darker
 * (0.3-0.6× luminance) while leaving natural terrain barely touched
 * (0.9-1.0×). The fragment shader gates the multiply behind
 * `uTerrainModulationEnabled` so the attribute is a no-op when the
 * quality preset / URL flag is off.
 *
 * The hash uses world-frame XY (`lbX * 192 + local_x`, ditto Y) so
 * vertices on the seam between two adjacent landblocks resolve to the
 * same random value — no visible discontinuity at LB boundaries.
 *
 * Saturation + hue ranges (R1.A, 2026-05-28) are now emitted alongside
 * brightness as two more per-vertex factors. The fragment shader still
 * gates them behind `uTerrainModulationEnabled` (master) AND a
 * `uTerrainModSatHue` sub-gate so brightness-only vs full sat/hue can
 * be A/B'd on the GPU. Like brightness, the unit interpretation is a
 * best-guess (percent: factor = value/100) — the 1070 eye-test is
 * load-bearing because retail ships no apply-path.
 *
 * To keep the three channels decorrelated (so a vertex isn't dim AND
 * desaturated AND hue-shifted in lockstep) each channel hashes the same
 * world-XY with a different additive salt before the sin() — same
 * deterministic, seam-continuous hash, three independent draws.
 *
 * @param {Float32Array} positions  flat [x0,y0,z0,x1,y1,z1,...] in LB-local metres
 * @param {Uint8Array}   terrainCodes per-vertex terrain type byte
 * @param {Uint32Array}  modRanges  flat [33×6] (min_b,max_b,min_s,max_s,min_h,max_h)
 * @param {number}       lbX        landblock X (0..255)
 * @param {number}       lbY        landblock Y (0..255)
 * @returns {{brightness: Float32Array, saturate: Float32Array, hue: Float32Array}}
 *   three arrays of length = vertexCount; each value in [min/100, max/100]
 *   for its channel (1.0 fallback = no-op when the type/range is missing).
 */
function buildTerrainVertexModulation(positions, terrainCodes, modRanges, lbX, lbY) {
  const vertexCount = (positions.length / 3) | 0;
  const brightness = new Float32Array(vertexCount);
  const saturate = new Float32Array(vertexCount);
  const hue = new Float32Array(vertexCount);
  const lbOriginX = lbX * 192;
  const lbOriginY = lbY * 192;
  // Mirrors the GLSL `hash21` (world-frame, deterministic). The salts
  // decorrelate the three channels: each adds a distinct offset before
  // the sin() so brightness/sat/hue draw independent fracts from the
  // same world-XY. Pure arithmetic → stable across reloads + LB seams.
  const hashChannel = (worldX, worldY, salt) => {
    const t = Math.sin(worldX * 127.1 + worldY * 311.7 + salt) * 43758.5453;
    return t - Math.floor(t); // fract — in [0, 1)
  };
  for (let i = 0; i < vertexCount; i += 1) {
    const type = terrainCodes[i] | 0;
    if (type >= 33) {
      // unknown type → no modulation on any channel
      brightness[i] = 1.0;
      saturate[i] = 1.0;
      hue[i] = 1.0;
      continue;
    }
    const base = type * 6;
    const minB = modRanges[base] | 0;
    const maxB = modRanges[base + 1] | 0;
    const minS = modRanges[base + 2] | 0;
    const maxS = modRanges[base + 3] | 0;
    const minH = modRanges[base + 4] | 0;
    const maxH = modRanges[base + 5] | 0;
    // World-frame hash input — see docstring re: LB-seam continuity.
    const worldX = lbOriginX + positions[i * 3 + 0];
    const worldY = lbOriginY + positions[i * 3 + 1];
    // Brightness — indices 0,1. No range → no modulation. Defensive:
    // zero-filled modRanges from a fetch-failure produces (0, 0) → 0
    // which would render black. Clamp to 1.0 so a missing table is a
    // no-op. Salt 0.0 keeps brightness bit-identical to the pre-R1.A
    // hash (no behaviour change for the already-shipped channel).
    if (minB === 0 && maxB === 0) {
      brightness[i] = 1.0;
    } else {
      const r = hashChannel(worldX, worldY, 0.0);
      brightness[i] = (minB + (maxB - minB) * r) * 0.01;
    }
    // Saturation — indices 2,3. Same fallback contract; distinct salt.
    if (minS === 0 && maxS === 0) {
      saturate[i] = 1.0;
    } else {
      const r = hashChannel(worldX, worldY, 13.37);
      saturate[i] = (minS + (maxS - minS) * r) * 0.01;
    }
    // Hue — indices 4,5. Same fallback contract; distinct salt.
    if (minH === 0 && maxH === 0) {
      hue[i] = 1.0;
    } else {
      const r = hashChannel(worldX, worldY, 71.9);
      hue[i] = (minH + (maxH - minH) * r) * 0.01;
    }
  }
  return { brightness, saturate, hue };
}

// === RP4 — per-LB DataTexture pools (2026-06-08) ===========================
//
// `vertexTypesTex` (9×9 RGBA8) and `mergeDataTex` (48×8 RGBA8, ?texMerge=on
// only) are PER-LB GPU textures whose dimensions/format are FIXED across
// every LB. On the prior code path each LB allocated a brand-new
// `THREE.DataTexture` (a fresh GPU upload), and on LRU eviction that texture
// was `.dispose()`'d (a GPU free). Crossing an LB boundary therefore churned
// one (or two) full texture alloc+free per LB — pure waste, since the next
// LB needs an identically-shaped texture.
//
// These pools recycle the GPU resource instead. Acquire pulls a texture off
// the free list (or allocates one on a cold miss), then OVERWRITES every byte
// of `tex.image.data` with this LB's codes and flags `needsUpdate` so three
// re-uploads the new bytes into the SAME GPU texture object. The pooled
// texture's `.dispose` is wrapped so the LRU's eviction-time `t.dispose()`
// (landblock_lru.js step 5) returns the texture to the free list rather than
// freeing the GPU resource — the standard pool-via-dispose-interception
// pattern, fully contained in this file.
//
// CORRECTNESS INVARIANTS (see RP4 brief):
//   * Full reset on reuse — the acquire helpers rewrite ALL 324 / 1536 bytes
//     of the texture every time, so no stale codes from a prior LB bleed in.
//   * No double-free / no aliasing — a texture only re-enters the free list
//     via its wrapped dispose (called exactly once per eviction by the LRU);
//     acquire only ever hands out a texture that is on the free list, so two
//     resident LBs can never share one texture object.
//   * The pool is per-session, fixed-shape, and self-limits to ~the max LB
//     residency (LRU cap), so it does not grow unbounded.
//   * Ring-shared textures (atlas, palette, detail arrays, road, alpha masks)
//     are NOT pooled here — they live on `opts` and are cached scene3d-wide.
//
// The wrapped dispose carries a `__realDispose` handle so a future hard scene
// teardown could force-free the whole pool if ever needed; today nothing
// other than the LRU disposes these textures (verified: the only cross-file
// references are the two `disposables.textures` track sites in index.js).
const _vertexTypesTexFreeList = [];
const _mergeDataTexFreeList = [];

// Tag so the texture is recognisable in heap dumps / future audits and so a
// double-recycle (dispose called twice) is a no-op rather than a corruption.
const POOL_TAG = "__rp4Pooled";

/**
 * Install the pool-return dispose wrapper on a freshly-built pooled texture.
 * The wrapper:
 *   - on the FIRST dispose call (LRU eviction): pushes the texture back onto
 *     `freeList` instead of freeing the GPU resource, and marks it as parked
 *     so a stray second dispose is ignored.
 *   - never touches `__realDispose` (the genuine THREE.Texture.dispose) — the
 *     GPU resource is intentionally kept alive for reuse for the session.
 */
function _installPoolDispose(tex, freeList) {
  const realDispose = tex.dispose.bind(tex);
  tex.userData = { ...(tex.userData || {}), [POOL_TAG]: true, __parked: false };
  tex.userData.__realDispose = realDispose;
  tex.dispose = function pooledDispose() {
    // Re-entrancy / double-free guard: only park once per checkout.
    if (tex.userData.__parked) return;
    tex.userData.__parked = true;
    freeList.push(tex);
  };
  return tex;
}

/**
 * Acquire a 9×9 vertex-types DataTexture for this LB. Reuses a pooled texture
 * (overwriting all bytes) when one is free, else builds a fresh one via the
 * shared adapter helper and installs the pool-return dispose wrapper.
 *
 * The byte layout + column-major transpose MUST stay bit-identical to
 * `adapter.js::buildVertexTypesDataTexture` (RGBA8: R=terrainCode,
 * G=roadCode*64, B=0, A=255) — the warm-path fill below mirrors it exactly so
 * a re-baked LB is byte-identical to a cold-baked one.
 */
function acquireVertexTypesTex(terrainCodes, roadCodes) {
  const tex = _vertexTypesTexFreeList.pop();
  if (!tex) {
    // Cold miss — build via the shared adapter helper (correct dims, filters,
    // NoColorSpace, needsUpdate) then make it pool-managed.
    const fresh = buildVertexTypesDataTexture(terrainCodes, roadCodes);
    return _installPoolDispose(fresh, _vertexTypesTexFreeList);
  }
  // Warm hit — overwrite EVERY byte (full reset; no stale codes bleed in).
  const bytes = tex.image.data; // Uint8Array(9*9*4)
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      const dst = (row * 9 + col) * 4;
      const src = col * 9 + row; // column-major source (see adapter.js)
      bytes[dst + 0] = terrainCodes[src];
      bytes[dst + 1] = roadCodes ? roadCodes[src] * 64 : 0;
      bytes[dst + 2] = 0;
      bytes[dst + 3] = 255;
    }
  }
  tex.userData.__parked = false; // checked back out
  tex.needsUpdate = true; // re-upload the rewritten bytes to the same texture
  return tex;
}

/**
 * Acquire a 48×8 TexMerge DataTexture for this LB. `mergeBytes` is the wasm
 * `terrainMergeData` block (Uint8Array length 48*8*4 = 1536). Reuses a pooled
 * texture (overwriting all bytes) when one is free, else builds a fresh one
 * with the same params the prior inline `new THREE.DataTexture(...)` used and
 * installs the pool-return dispose wrapper.
 */
function acquireMergeDataTex(mergeBytes) {
  const tex = _mergeDataTexFreeList.pop();
  if (!tex) {
    const fresh = new THREE.DataTexture(
      Uint8Array.from(mergeBytes),
      48,
      8,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    fresh.colorSpace = THREE.NoColorSpace; // packed data, not colour
    fresh.magFilter = THREE.NearestFilter;
    fresh.minFilter = THREE.NearestFilter;
    fresh.generateMipmaps = false;
    fresh.needsUpdate = true;
    return _installPoolDispose(fresh, _mergeDataTexFreeList);
  }
  // Warm hit — overwrite EVERY byte (full reset).
  tex.image.data.set(mergeBytes); // both length 1536
  tex.userData.__parked = false;
  tex.needsUpdate = true;
  return tex;
}

// === Wave 2.A / Agent 2.A — terrain palette LUT (2026-05-28) ===
//
// Retail's Region 1 ("Dereth") publishes a 32-entry terrain palette via
// `TerrainDesc.terrain_types[i].terrain_color` — one Windows-COLORREF
// dword (BGRA byte layout per PhatSDK `Palette.h::RGBAUnion`) per
// terrain code 0..31. The atlas-sampled fragment shader has historically
// ignored this palette, so two cells that happen to share an atlas tile
// (e.g. type 0 BarrenRock and type 24 Argila both point at
// `0x0500145C`) render identical when retail tints them per-biome.
//
// We bake the 32 palette entries into a 32×1 RGBA `DataTexture` (Nearest
// filter, no mipmaps so integer code lookup is exact), bind it as
// `uTerrainPalette`, and the fragment shader samples the four cell
// corners' palette colours with the SAME bilinear weights it already
// uses for atlas-tile blending. The blended palette tint then modulates
// the atlas colour by a controllable strength (default ~0.25 — atlas
// detail stays primary; palette adds the biome bias).
//
// Source of truth: `apps/holtburger-web/data/terrain_palette.json`
// (generated by
// `cargo run -p holtburger-dat --example dump_terrain_palette`).
// The Rust dump walks the canonical DAT bytes; do NOT hand-edit the
// JSON.
//
// Sized at 128 bytes / 1 sampler unit / 1 uniform — well below every
// quality tier's headroom. The fragment branch costs four
// `texelFetch`es per pixel, all spatially coherent (same row, adjacent
// columns), which the GPU sampler hits at L1-cache speed.

const TERRAIN_PALETTE_LENGTH = 32;
let _terrainPaletteLutPromise = null;
let _terrainPaletteTextureSingleton = null;

/**
 * Fetch the committed 32-entry retail terrain palette and build a
 * `THREE.DataTexture` (32×1 RGBA, Nearest filter, no mipmaps). The
 * promise is memoised — one fetch + texture upload per session.
 *
 * Returns `{ texture, rgba }` where `rgba` is the raw 32×4 Uint8Array
 * (exposed for the unit test that asserts known indices round-trip
 * through the buffer correctly).
 *
 * On fetch failure, resolves to `null` — the terrain shader's
 * `uTerrainPaletteEnabled` falls back to 0 and the atlas-only path
 * renders unchanged. Same fail-silent contract as the
 * `terrainDetailNormalArray` and `surfaceColors` loaders elsewhere in
 * scene3d/.
 *
 * Exported for tests + the in-app loader. Production callers should
 * await this through `resolveTerrainRingOpts` rather than calling it
 * directly so the LUT lives in the same ring-opts bag as the atlas
 * texture.
 */
export async function loadTerrainPaletteLut() {
  if (_terrainPaletteLutPromise) return _terrainPaletteLutPromise;
  _terrainPaletteLutPromise = (async () => {
    let json = null;
    try {
      const r = await fetch("./data/terrain_palette.json", {
        cache: "force-cache",
      });
      if (!r.ok) {
        // eslint-disable-next-line no-console
        console.warn(
          `[wave-2.A] terrain_palette.json HTTP ${r.status}; palette tint disabled`
        );
        // Wave 3 / M6 fix (2026-05-28) — palette failure makes biome
        // tints disappear silently (e.g. code 0 BarrenRock and code 24
        // Argila both map to 0x0500145C; without palette they render
        // identically). Defensive `__diag.terrain.onPaletteLoadFailed`
        // hook so future tooling can surface the regression.
        try { window.__diag?.terrain?.onPaletteLoadFailed?.({ status: r.status, reason: "http_error" }); } catch (_) {}
        return null;
      }
      json = await r.json();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[wave-2.A] terrain_palette.json fetch failed (${e?.message ?? e}); palette tint disabled`
      );
      try { window.__diag?.terrain?.onPaletteLoadFailed?.({ error: String(e?.message ?? e), reason: "fetch_threw" }); } catch (_) {}
      return null;
    }

    const entries = Array.isArray(json?.palette) ? json.palette : null;
    if (!entries || entries.length !== TERRAIN_PALETTE_LENGTH) {
      // eslint-disable-next-line no-console
      console.warn(
        `[wave-2.A] terrain_palette.json: expected ${TERRAIN_PALETTE_LENGTH} entries, got ${entries?.length ?? "none"}; palette tint disabled`
      );
      return null;
    }

    // 32×1 RGBA, byte order R,G,B,A per Three.js DataTexture upload
    // contract. Indexed by `terrainCode` so the shader uses the same
    // discrete code that drives the atlas-array layer selection.
    const rgba = new Uint8Array(TERRAIN_PALETTE_LENGTH * 4);
    for (let i = 0; i < TERRAIN_PALETTE_LENGTH; i += 1) {
      const e = entries[i];
      const idx = Number.isFinite(e?.index) ? e.index : i;
      if (idx !== i) {
        // Defensive — the JSON is generated in index order, but mis-
        // ordered input would silently swap biome tints. Bail out
        // loudly rather than render the wrong palette.
        // eslint-disable-next-line no-console
        console.warn(
          `[wave-2.A] terrain_palette.json entry ${i} has out-of-order index=${idx}; palette tint disabled`
        );
        return null;
      }
      rgba[i * 4 + 0] = (e.r ?? 0) & 0xff;
      rgba[i * 4 + 1] = (e.g ?? 0) & 0xff;
      rgba[i * 4 + 2] = (e.b ?? 0) & 0xff;
      rgba[i * 4 + 3] = (e.a ?? 255) & 0xff;
    }

    const texture = new THREE.DataTexture(
      rgba,
      TERRAIN_PALETTE_LENGTH,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    // Discrete per-code colours — any interpolation between adjacent
    // codes produces colours that don't exist in the source palette.
    // texelFetch in the shader bypasses the sampler's filter, but we
    // still set NearestFilter so a sampler2D fallback (if ever
    // refactored) does the right thing.
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    // sRGB so three.js linearises the byte values into the fragment
    // shader's linear-space pipeline — matches the atlas texture's
    // colourSpace contract so the multiplication downstream stays in
    // the right space.
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    _terrainPaletteTextureSingleton = texture;
    return { texture, rgba };
  })();
  return _terrainPaletteLutPromise;
}

/**
 * Synchronous getter for the previously-loaded LUT texture, or null
 * before the first `loadTerrainPaletteLut()` resolves. Used by
 * `resolveTerrainRingOpts` to avoid re-awaiting the promise on every
 * ring rebuild.
 */
export function getTerrainPaletteTextureSync() {
  return _terrainPaletteTextureSingleton;
}

/**
 * Test-only reset of the memoised LUT promise + texture singleton.
 * Called from the unit test to validate the loader's error paths
 * independently of one another.
 */
export function _resetTerrainPaletteLutForTest() {
  _terrainPaletteLutPromise = null;
  _terrainPaletteTextureSingleton = null;
}

// Opt-in tint strength for the per-biome palette nudge. 0.0 = disabled
// (atlas-only); 1.0 = palette is the only colour signal.
//
// T8 (2026-05-28): this tint samples `TerrainType.terrain_color`, which the
// DAT parser documents as the RADAR/MINIMAP colour (region.rs:653) — NOT the
// retail terrain tint, so it's an approximation. It is now OFF by default and
// opt-in via `?terrainPalette=on` (was silently on at 0.25). The retail
// per-biome differentiation for biomes that SHARE a base texture (e.g. codes
// 0/24/31 → 0x0500145C) is the per-type vertex bright/sat/hue modulation
// (`TerrainTex.{max,min}_vert_*`, the `?terrainMod` path), not a colour tint
// — see the [Terrain vertex modulation] memory (brightness opt-in; sat/hue
// deferred pending a 1070 eye-test).
const DEFAULT_TERRAIN_PALETTE_STRENGTH = 0.25;
export { DEFAULT_TERRAIN_PALETTE_STRENGTH };

// Indexed by terrain code 0..31. UNKNOWN codes (water, swamp, slime,
// faux-water) get NONE; the shader branches and skips sampling.
const TERRAIN_CODE_TO_DETAIL_SLICE = new Uint8Array([
  /*  0 BarrenRock         */ DETAIL_SLICE_STONE,
  /*  1 Grassland          */ DETAIL_SLICE_GRASS,
  /*  2 Ice                */ DETAIL_SLICE_SNOW,
  /*  3 LushGrass          */ DETAIL_SLICE_GRASS,
  /*  4 MarshSparseSwamp   */ DETAIL_SLICE_NONE,
  /*  5 MudRichDirt        */ DETAIL_SLICE_DIRT,
  /*  6 ObsidianPlain      */ DETAIL_SLICE_STONE,
  /*  7 PackedDirt         */ DETAIL_SLICE_DIRT,
  /*  8 PatchyDirt         */ DETAIL_SLICE_DIRT,
  /*  9 PatchyGrassland    */ DETAIL_SLICE_GRASS,
  /* 10 sand-yellow        */ DETAIL_SLICE_SAND,
  /* 11 sand-grey          */ DETAIL_SLICE_SAND,
  /* 12 sand-rockStrewn    */ DETAIL_SLICE_SAND,
  /* 13 SedimentaryRock    */ DETAIL_SLICE_STONE,
  /* 14 SemiBarrenRock     */ DETAIL_SLICE_STONE,
  /* 15 Snow               */ DETAIL_SLICE_SNOW,
  /* 16 WaterRunning       */ DETAIL_SLICE_NONE,
  /* 17 WaterStandingFresh */ DETAIL_SLICE_NONE,
  /* 18 WaterShallowSea    */ DETAIL_SLICE_NONE,
  /* 19 WaterShallowStillSea*/ DETAIL_SLICE_NONE,
  /* 20 WaterDeepSea       */ DETAIL_SLICE_NONE,
  /* 21 forestfloor        */ DETAIL_SLICE_GRASS,
  /* 22 FauxWaterRunning   */ DETAIL_SLICE_NONE,
  /* 23 SeaSlime           */ DETAIL_SLICE_NONE,
  /* 24 Argila             */ DETAIL_SLICE_DIRT,
  /* 25 Volcano1           */ DETAIL_SLICE_STONE,
  /* 26 Volcano2           */ DETAIL_SLICE_STONE,
  /* 27 BlueIce            */ DETAIL_SLICE_SNOW,
  /* 28 Moss               */ DETAIL_SLICE_GRASS,
  /* 29 DarkMoss           */ DETAIL_SLICE_GRASS,
  /* 30 olthoi             */ DETAIL_SLICE_STONE,
  /* 31 DesolateLands      */ DETAIL_SLICE_DIRT,
]);

// Detail-normal UV scale (tile repeats per landblock metre). The terrain
// is a 192 m landblock with `vGridUv = position.xy / 24` (range [0, 8]).
// uDetailScale of 16 → 8 * 16 = 128 detail-tile repeats per 192 m LB,
// or one detail tile per ~1.5 m. Reads as sub-character-scale at eye
// height.
const DEFAULT_DETAIL_SCALE = 16.0;

// ----- T7 (2026-05-28) — terrain detail-diffuse texture defaults -----
//
// All four are eye-test-tuned (the handoff flags tiling/blend/fade as
// "does it look right" knobs). They're shader uniforms fed from these JS
// constants, so they can be retuned by editing here and reloading (no wasm
// rebuild) — only the detail textures themselves come from wasm.
//
// BASE_SCALE: detail UV = vGridUv * (detail_tex_tiling * BASE_SCALE).
//   vGridUv is 1.0 per 24 m. At BASE_SCALE 8 and the common tiling=1 →
//   8 repeats per cell = one detail tile per 3 m; the rock/grass tiling=4
//   types get 1 per 0.75 m. Mirrors the sub-metre frequency of the
//   detail-NORMAL path (DEFAULT_DETAIL_SCALE 16) at a slightly coarser
//   rate so the diffuse grain doesn't alias against the normal grain.
// STRENGTH: MODULATE2X blend amount near camera (0 = off, 1 = full 2×).
// FADE_START/END: metres of view-space depth over which the effect ramps
//   from full to zero — a near-camera-only layer (retail's detail mips
//   average out by ~one cell distance anyway).
const DEFAULT_DETAIL_TEX_BASE_SCALE = 8.0;
const DEFAULT_DETAIL_TEX_STRENGTH = 0.5;
const DEFAULT_DETAIL_TEX_FADE_START = 18.0;
const DEFAULT_DETAIL_TEX_FADE_END = 75.0;
// 2026-07-02 — retail landscape-detail fade band: ACRender::get_alpha_for_z
// (acclient.c:719936) returns alpha 255 below 10 m, a LINEAR ramp 10→50 m,
// 0 beyond. Used by the default "global" (retail crossfade) mode; the
// modern "percode" A/B mode keeps the 18/75 smoothstep above.
const RETAIL_DETAIL_TEX_FADE_START = 10.0;
const RETAIL_DETAIL_TEX_FADE_END = 50.0;
// Fallback LUTs when the detail-tex flag is off / fetch failed: every code
// maps to slice 255 (= "none", shader skips) and tiling 1. The int[33]
// uniforms must still be the right length even when disabled, or three.js
// warns on a length-mismatched uniform array bind.
const DETAIL_TEX_SLICE_FALLBACK = Object.freeze(new Array(33).fill(255));
const DETAIL_TEX_TILING_FALLBACK = Object.freeze(new Array(33).fill(1));

// T1 (2026-05-29) — base tex_tiling LUT fallback (default-on path). The real
// per-code values come from the wasm `fetch_terrain_base_tex_tiling()` export.
// 2026-06-21: the fallback is now retail's value (2 for all 33 types, verified
// against the DAT via WB.Terminal get-terrain-textures — texTiling is a uniform
// 2 across every TerrainDesc) instead of 1. The prior `fill(1)` meant that any
// silent fetch failure / stale-bundle / pre-LUT bake left base tiles rendered
// 1× = 2× too large = stretched/blurry ground (observed live on the 1070:
// uBaseTexTiling all-1). Failing soft to the correct retail tiling keeps the
// ground sharp even when the LUT path doesn't run.
const BASE_TEX_TILING_FALLBACK = Object.freeze(new Array(33).fill(2));

// R4.a 2026-05-28 — retail TexMerge mid-point alpha rounding sub-flag.
// The composite already ships behind ?texMerge; this rides that flag (no
// new top-level URL param) and is ON by default so ?texMerge now includes
// the acclient.c:365787-365798 rounding (if 0<a<0xFF && a>0x80, a++). Flip
// to false here for an on-GPU A/B of the composite with vs without the
// rounding alone. Default (no ?texMerge) stays byte-identical regardless.
const TEXMERGE_ALPHA_ROUND = true;

// ----- Phase 1.3 — triplanar mapping on terrain slopes --------------
//
// Slope is computed in AC-space (Z-up): `slope = 1.0 - normal.z`.
// Below the LO slope threshold, pure grid-UV sampling. Above
// `TRIPLANAR_SLOPE_HI`, pure triplanar. Between, `smoothstep` lerp.
// HI=0.5 ≈ 30° (point at which UV stretching becomes objectionable).
// LO was 0.2 ≈ 11° from horizontal; Perf D3 moves the LO end into the
// quality preset (`triplanarSlopeThresholdPct`, 0..100 → 0.0..1.0) so
// `mid` can raise it to 0.6 (steep cliffs only) and `high`/`ultra`
// keep the 0.3 audit value.
//
// Triplanar sharpness 6.0 is the centre of the 4-8 sweet spot per the
// hand-off note. Lower values produce muddy blends; higher values
// produce hard seams at 45°.
const TRIPLANAR_SLOPE_HI = 0.5;
const DEFAULT_TRIPLANAR_SHARPNESS = 6.0;

// ----- Wave 1B — SAND GRAIN SPARKLE (terrain-VFX plan §3.2 item 4) ----
//
// Tuned as a WHISPER: this is an additive term over every sand fragment in
// view, so it must read as glitter caught at a grazing angle, not as a sheen.
// All four are shader constants rather than URL flags — the two flags that
// exist (`?terrainSand`, `?terrainSandSparkle`) gate the whole block, and the
// plan reserves no numeric knob for it. Calibration target is the BC7 arm
// (:8767 with `texBc7=on&terrainBc7=on`), per plan §8 risk 13.
const DEFAULT_SAND_SPARKLE_STRENGTH = 0.55;
// Grain cells per metre. High enough that a cell is well under a pixel at
// range (which is why the distance fade below exists) and coarse enough near
// the camera to read as individual glints rather than as noise.
const DEFAULT_SAND_SPARKLE_DENSITY = 26.0;
// Distance fade — the same reasoning as the 2026-07-31 water sheen's 30→160 m
// band: a per-pixel hashed micro-facet with no derivative-aware filtering
// aliases hard once one pixel spans many grain cells. Sand is a near-field
// effect; beyond the band the ground reads as the plain tile it did before.
const DEFAULT_SAND_SPARKLE_FADE_START = 18.0;
const DEFAULT_SAND_SPARKLE_FADE_END = 70.0;

// ----- Wave 2B — VOLCANO CRACK GLOW + OBSIDIAN (plan §3.6 items 3 + 5) ----
//
// CRACK GLOW is emissive, so unlike the sand sparkle it is NOT multiplied by
// the shadow terms — lava glows in shadow. It is added to `iblSpec`, which the
// final colour already adds un-shadowed, so the `fragColor` line is untouched.
//
// Vein DENSITY is deliberately LOW (cells per metre): these are metre-scale
// fissures in the ground, not a micro-facet field, which is also why the
// distance fade below can be so much wider than the sparkle's without aliasing.
const DEFAULT_CRACK_GLOW_DENSITY = 0.55;      // ≈ 1.8 m period
// Vein WIDTH as a threshold on the ridged noise: smaller = thinner, hotter
// cracks. 0.06 reads as a hairline at the ground scale above.
const DEFAULT_CRACK_GLOW_WIDTH = 0.06;
// Emissive gain. Tuned to sit UNDER the bloom threshold (0.85, atmosphere_
// pipeline.js) at the breath minimum and just over it at the peak, so the
// cracks bloom on the inhale and not constantly.
const DEFAULT_CRACK_GLOW_STRENGTH = 1.15;
// Deep orange-red. Calibration target is the BC7 arm (:8767 with
// `texBc7=on&terrainBc7=on`) — plan §8 risk 13.
const DEFAULT_CRACK_GLOW_COLOR = Object.freeze([1.0, 0.30, 0.06]);
const DEFAULT_CRACK_GLOW_FADE_START = 120.0;
const DEFAULT_CRACK_GLOW_FADE_END = 420.0;
// The breathing oscillator's neutral value. `loop.js::tickTerrainUTime` pushes
// the live one from the shared `vfx/oscillators.js` registry; this literal is
// what a frame before the first push (or with the oscillator unregistered)
// reads, and it is the oscillator's own bias, so it is never a visible step.
const DEFAULT_CRACK_GLOW_BREATH = 0.72;

// OBSIDIAN — code 6 only. "roughness ↓↓, dark tight specular": a high-exponent
// Blinn lobe at LOW intensity plus a sharp (low-mip) env reflection. It is a
// specular-only treatment, added to `iblSpec` alongside the crack glow: the
// albedo is left alone so the two texture arms both keep their own black.
const DEFAULT_OBSIDIAN_SHININESS = 220.0;
const DEFAULT_OBSIDIAN_SPECULAR = 0.55;
const DEFAULT_OBSIDIAN_ENV = 0.35;

// ----- Retail zFightTerrainAdjust (terrain drawn ~1 cm below grade) --
//
// Verified against the decomp: `float zFightTerrainAdjust = 0.0099999998;`
// (acclient.c:46689) and applied in BOTH `ACRender::landPolyDraw` overloads
// as `vertex.z - zFightTerrainAdjust` written into the D3D vertex buffer
// BEFORE projection — i.e. every terrain vertex is drawn ~1 cm below its true
// elevation so building-interior floors and at-grade cell/dungeon-entrance
// geometry win the depth test cleanly. This is retail's ENTIRE solution to the
// terrain-vs-floor z-fight: runtime depth bias is NOT used (RenderDeviceD3D::
// SetDepthBias is only ever called with 0.0), and polygonOffset is dead under
// logarithmicDepthBuffer anyway. gmriggs did the identical hack in ACViewer
// ("similar with building interior floors, so they don't clash with the
// overworld ground, i bumped them up like 0.01" — worldbuilder, 2026-02-13).
//
// Applied in the SHARED TERRAIN_VERTEX_GLSL below, so it covers the per-LB
// ShaderMaterial, the ?terrainBatch BatchedMesh path, and the wireframe fill
// alike. Modifies only displacedPos.z (→ vWorldPos / gl_Position / log depth);
// the texture-coordinate paths read `position` and are untouched. Physics /
// collision grade is unaffected (this is a visual draw-time lower, exactly as
// retail does it — the heightfield data is not changed).
//
// Override live for an A/B on a real GPU with `?terrainLower=<metres>`
// (0 disables; e.g. ?terrainLower=0.05 for a bigger margin at buried
// dungeon/cave entrances). Default = retail 1 cm. Re-read requires a reload
// (the value is baked into the GLSL template at module load); use ?nosw=1.
const ZFIGHT_TERRAIN_ADJUST_M = (() => {
  const DEFAULT = 0.0099999998;
  try {
    const raw = new URLSearchParams(globalThis.location?.search || "").get(
      "terrainLower",
    );
    if (raw == null) return DEFAULT;
    const v = Number.parseFloat(raw);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT;
  } catch (_) {
    return DEFAULT;
  }
})();
try {
  globalThis.__terrainLowerMeters = ZFIGHT_TERRAIN_ADJUST_M;
} catch (_) {
  /* non-browser */
}

// ----- Phase 2.2 — animated vertex displacement (water + lava) -----
//
// Per-vertex Y-axis (AC Z-axis) displacement driven by `uTime` in the
// vertex shader. Branches on `vTerrainCode` (provoking-vertex code from
// the Phase 1.2 per-vertex attribute).
//
// Codes for Region 0x13 ("Dereth") from the terrain code table in this
// file:
//   water: 16, 17, 18, 19, 20, 22, 23
//   lava:  none — retail Holtburg has no lava terrain (lava is in
//          dungeons via SetupModel floors, not landblock terrain).
//          A region-aware extension would add lava codes for the
//          Volcanic Hills region, etc. The lava branch is present but
//          inactive (no codes match).
//
// Total amplitude ≤ 0.4 m per plan §4 constraint #3 — small enough that
// the player never feels they're walking through visible ridges. Water
// uses two sines summed (~0.25 m envelope); lava (future) would use
// 2D value-noise at 0.4 m.
//
// 2026-07-31 (water-fix) — the swell is now LATTICE-LOCKED: it is evaluated
// at the four corners of the enclosing 24 m CONTROL cell and bilinearly
// interpolated to the vertex, instead of being evaluated at the vertex
// directly. Two consequences, both load-bearing:
//
//   1. CRACK-FREE ACROSS THE SUBDIV LOD BOUNDARY. `pickSubdivLevelForLb`
//      gives the player's LB + ring-1 `halfLevel` and everything at
//      Chebyshev distance >= 2 factor 1, so an LOD boundary sits ~2 LBs from
//      the player and MOVES WITH HIM. The static heights are crack-free
//      because the subdivided surface is linear along every cell edge
//      (terrain_subdiv's lod_boundary_edges_coincide_across_factors), but a
//      raw per-vertex sine is NOT linear: the fine side's edge midpoint sat
//      up to ~0.23 m off the coarse side's straight chord, tearing open
//      water along a seam that followed the player around. Bilinear over the
//      control lattice restricted to a cell edge IS linear, so every LOD
//      level reproduces exactly the same surface.
//   2. LEVEL-INDEPENDENT, so the subdivLevel >= 2 quality gate is gone (see
//      `readWaterWaveFlag`): at factor 1 the vertices ARE the lattice
//      corners and the wave is exact, so low/mid quality and the distance
//      >= 2 rings now bob identically to the centre LB instead of staying
//      frozen (or, worse, bobbing out of phase with their neighbour).
//
// The wavelengths were lengthened to match (140 m / 101 m, from 63 m / 48 m)
// so 24 m lattice sampling reconstructs a smooth swell — peak bilinear
// facet error ~2-3 cm, invisible at 0.25 m amplitude. The high-frequency
// surface motion the short wavelengths used to supply now comes from the
// fragment-side UV scroll + the water sheen normal, which have no geometry
// dependency and therefore no LOD constraint.
// F12-5 — `?strictWaterCodes` (DEFAULT-ON — `!== "off"` reader) restricts
// the animated-water set to retail's
// SurfChar water codes (16-20). The default set ALSO includes 22
// (FauxWaterRunning) and 23 (SeaSlime), which retail's surface-characteristic
// table marks NOT water — so marsh/slime terrain currently bobs ±0.25 m,
// scrolls, and breathes blue like open sea. This single set feeds the
// uWaterCodeMask that now drives all three sites (vertex displacement, the
// per-corner UV scroll, and the blue tint), so the flag affects them
// uniformly. `=off` restores the legacy 16-23 set (marsh/slime bobbing). The
// doc hedges on 22 ("render with scroll/tint only if eye-test agrees" — it
// is faux *running* water visually); the conservative strict set drops it
// per the SurfChar table, deferring the keep-22-scroll-only refinement (a
// second mask) to the 1070 eye-test.
// RND-20/21 — retail faceted-terrain Gouraud. DEFAULT ON; the only escape is
// the exact string "off" (`?terrainGouraud=off`). Reader semantics are
// `!== "off"`, so an ABSENT param is ON — do not infer the default from prose.
export function readTerrainGouraudFlag() {
  try {
    return typeof window !== "undefined" && window.location
      ? new URLSearchParams(window.location.search || "").get("terrainGouraud") !== "off"
      : true;
  } catch (_) { return true; }
}

export const TERRAIN_GOURAUD_ON = readTerrainGouraudFlag();

function readStrictWaterCodesFlag() {
  // 2026-07-31 (water-fix) — the NO-BROWSER branch used to fall through to
  // `false`, i.e. the Node harness resolved TERRAIN_WATER_CODES to the LEGACY
  // 7-code set {16-20,22,23} while a real page resolved the strict 5-code set
  // {16-20}. Every sibling reader in this file returns the BROWSER DEFAULT
  // when `window` is absent; this one silently disagreed, so any node-side
  // test or capture probe reasoning about the water mask was reasoning about
  // a set the client never uses (live uniform dump: uWaterCodeMask ==
  // 0x1F0000). Explicit try/catch shape now, matching the siblings.
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return new URLSearchParams(window.location.search).get("strictWaterCodes") !== "off";
  } catch (_) { return true; }
}
const TERRAIN_WATER_CODES = new Set(
  readStrictWaterCodesFlag() ? [16, 17, 18, 19, 20] : [16, 17, 18, 19, 20, 22, 23],
);
// 2026-07-31 (water-fix) — THE SECOND MASK F12-5 deferred ("keep-22-scroll-only
// (faux running water) ... needs a 2nd mask", url-flags.md).
//
// Two questions, two answers:
//   - "does it BEHAVE like water?" (the vertical swell) -> retail's
//     surface-characteristic table. 22 FauxWaterRunning and 23 SeaSlime are
//     NOT water there, so they must not bob. That is TERRAIN_WATER_CODES.
//   - "does it LOOK like water?" (scroll, tint, sheen, POM bypass) -> the art.
//     Code 22 is faux *running water*: on the BC7 arm it literally shares one
//     retail RenderSurface with 16 WaterRunning (terrain_bc7.js layer->rsId
//     dedupe). With one mask, two cells drawn from the SAME texture animated
//     differently — a static "river" beside a flowing one. That is exactly the
//     "water effect missing in places" symptom, and it is what this set fixes.
//
// So 22 gets the SURFACE animation and no swell. 23 SeaSlime stays out of both
// (its art is slime, not water, and retail agrees). `?strictWaterCodes=off`
// still widens BOTH sets to the legacy 16-23, so the escape keeps meaning
// "restore the pre-F12-5 behaviour" exactly.
const TERRAIN_WATER_SURFACE_CODES = new Set(
  readStrictWaterCodesFlag()
    ? [16, 17, 18, 19, 20, 22]
    : [16, 17, 18, 19, 20, 22, 23],
);
// Region 0x13 lava codes: none (see comment above). Future region-aware
// extension would populate this for, e.g., Volcanic Hills.
const TERRAIN_LAVA_CODES = new Set([]);

// Wave 1B — the SAND set for the grain sparkle, DERIVED from
// `terrain_families.js` (FAM_SAND = codes 10/11/12 in Dereth) rather than
// written out here. Family membership is a property of the CODE and the family
// module is the single source of truth for it (plan §1.3 / §8 risk 12); a
// hardcoded 10..12 range here would be the same class of bug as the pre-F12-5
// hardcoded water range. Sand is in no water set, so `?strictWaterCodes`
// cannot move it and this can be computed once.
const TERRAIN_SAND_CODES = Object.freeze(
  (() => {
    const s = new Set();
    for (let c = 0; c < 32; c += 1) if (familyForCode(c) === FAM_SAND) s.add(c);
    return s;
  })(),
);

// Wave 2A — the SNOW/ICE set for the crystal sparkle and the footprint dent,
// DERIVED from `terrain_families.js` (FAM_SNOWICE = codes 2 `Ice`, 15 `Snow`,
// 27 `BlueIce` in Dereth) for exactly the reason TERRAIN_SAND_CODES is. Snow is
// in no water set, so `?strictWaterCodes` cannot move it.
const TERRAIN_SNOW_CODES = Object.freeze(
  (() => {
    const s = new Set();
    for (let c = 0; c < 32; c += 1) if (familyForCode(c) === FAM_SNOWICE) s.add(c);
    return s;
  })(),
);

// Wave 2B — the VOLCANO set for the crack glow, DERIVED from
// `terrain_families.js` (FAM_VOLCANO = codes 6/25/26 in Dereth) for exactly the
// reason the sand set above is: family membership is a property of the CODE and
// the family module is the single source of truth (plan §1.3 / §8 risk 12).
// Volcanic codes are in no water set, so `?strictWaterCodes` cannot move them.
const TERRAIN_VOLCANO_CODES = Object.freeze(
  (() => {
    const s = new Set();
    for (let c = 0; c < 32; c += 1) if (familyForCode(c) === FAM_VOLCANO) s.add(c);
    return s;
  })(),
);

// Wave 2A — the ICE MATERIAL set. A STRICT SUBSET of FAM_SNOWICE: hard, wet,
// low-roughness ice is codes 2 (`Ice`) and 27 (`BlueIce`) only; 15 (`Snow`) is
// matte and must never get the specular/refraction treatment (plan §3.4 "codes
// 2/27"). This is the plan's "per-code parameter table INSIDE the family
// module" rule (§1.3) expressed as a filter over the family rather than a
// second hardcoded list: the family stays the source of truth for membership,
// and the sub-variant table in `terrain_snow.js::SNOWICE_VARIANTS` is the
// source of truth for which members are ICE. Kept in lockstep by
// `test_terrain_ice.mjs`.
const TERRAIN_ICE_MATERIAL_CODES = Object.freeze(
  (() => {
    const s = new Set();
    for (const c of TERRAIN_SNOW_CODES) if (c === 2 || c === 27) s.add(c);
    return s;
  })(),
);

// Wave 3B — the DIRT set for the mud print and the wet-mud treatment, DERIVED
// from `terrain_families.js` (FAM_DIRT = codes 5 `MudRichDirt`, 7 `PackedDirt`,
// 8 `PatchyDirt`, 24 `Argila`, 31 `DesolateLands` in Dereth) for exactly the
// reason the sand set above is. ⚠ This family is the sharpest illustration of
// plan §2.7.2: retail shares ONE RenderSurface across `BarrenRock (0)`,
// `Argila (24)` and `DesolateLands (31)`, and 0 is ROCK while 24 and 31 are
// DIRT — so any test keyed off texture identity would wet BarrenRock too.
// Dirt codes are in no water set, so `?strictWaterCodes` cannot move them.
const TERRAIN_DIRT_CODES = Object.freeze(
  (() => {
    const s = new Set();
    for (let c = 0; c < 32; c += 1) if (familyForCode(c) === FAM_DIRT) s.add(c);
    return s;
  })(),
);

// Wave 3B — the CLAY set: `Argila (24)` alone, a STRICT SUBSET of FAM_DIRT.
// The plan asks for clay "redder and slicker after rain" (§3.7), which is a
// per-code sub-variant, and §1.3 says a sub-variant is a table INSIDE the
// family module — so the family stays the source of truth for membership and
// `terrain_dirt.js::DIRT_VARIANTS[c].clay` is the source of truth for which
// members are clay. Kept in lockstep by `test_terrain_dirt_shader.mjs`, the
// same arrangement `TERRAIN_ICE_MATERIAL_CODES` has with `SNOWICE_VARIANTS`.
const TERRAIN_CLAY_CODES = Object.freeze(
  (() => {
    const s = new Set();
    for (const c of TERRAIN_DIRT_CODES) if (c === 24) s.add(c);
    return s;
  })(),
);

// ----- Wave 2A — SNOW CRYSTAL SPARKLE (terrain-VFX plan §3.4 item 2) --
//
// Louder than the sand grain sparkle on purpose: sand glitters at a grazing
// angle, snow FLASHES — and the flash is what sells it. Camera-motion-dependent
// twinkle is the whole effect (plan §3.4: "a static sparkle texture reads as
// noise"), which is why the lobe exponent is enormous: a facet lights only when
// the sun/eye half-vector lands almost exactly on it, so moving the camera
// sweeps the half-vector across the facet field and different crystals pop.
const DEFAULT_SNOW_SPARKLE_STRENGTH = 1.35;
// Crystal cells per metre. Finer than sand's 26 — a snow glint is a point, not
// a grain — which makes the distance fade below more load-bearing, not less.
const DEFAULT_SNOW_SPARKLE_DENSITY = 42.0;
// The lobe exponent. See above: this IS the camera-motion dependence.
const DEFAULT_SNOW_SPARKLE_SHARPNESS = 420.0;
// Distance fade, same reasoning as the sand sparkle and the water sheen: an
// unfiltered per-pixel micro-facet aliases hard once one pixel spans many
// cells. Snow's band is shorter than sand's because its cells are finer.
const DEFAULT_SNOW_SPARKLE_FADE_START = 12.0;
const DEFAULT_SNOW_SPARKLE_FADE_END = 55.0;

// ----- Wave 2A — SNOW FOOTPRINTS (plan §3.4 item 3) -------------------
//
// The dent, in the same units the POM march works in: a UV shift along the view
// parallax vector. Deliberately ~1/3 of uPomScale (0.012) so a print reads as a
// depression IN the relief rather than fighting it (plan §3.4 "keep the
// amplitude well under uPomScale").
const DEFAULT_SNOW_PRINT_DEPTH = 0.004;
// Fraction of the lit colour removed at a full-strength print. Compressed snow
// is denser and shadowed, so darkening alone already reads as a print — which
// is exactly the `mid`/no-POM degrade (plan §2.7.3 point 4).
const DEFAULT_SNOW_PRINT_DARKEN = 0.32;

// ----- Wave 2A — ICE MATERIAL (plan §3.4 item 4) ----------------------
//
// Gloss = 1 - roughness for the ice codes. 0.88 is "wet, hard, slightly
// pitted": a sharp sun glint and a near-mirror env reflection at a low mip,
// without the plastic look a flat 1.0 gives.
const DEFAULT_ICE_GLOSS = 0.88;
// Blinn sun-glint gain, and the env-reflection gain (the latter only does
// anything with ?ibl on, which is default-ON).
const DEFAULT_ICE_SPEC_STRENGTH = 0.55;
const DEFAULT_ICE_ENV_STRENGTH = 0.65;
// Fake refraction: ONE extra atlas tap at cellUv offset by the view vector.
// 0.004 cell-UV units = a third of uPomScale, i.e. well under it as the plan
// requires — the two are applied in the same direction and must not fight.
const DEFAULT_ICE_REFRACT_AMOUNT = 0.004;

// ----- Wave 3B — MUD PRINTS + WET MUD (plan §3.7 items 2 + 4) ---------
//
// The print is the SNOW PRINT's twin — same shared trail map, same sampler,
// same post-POM siting — with mud's amplitudes: a DEEPER dent than snow (mud
// yields more than powder) and a slightly softer darkening (a snow print is a
// hard blue shadow; a mud print is a wet smear). Still well under uPomScale
// (0.012) so the dent reads as a depression IN the relief rather than fighting
// it, exactly as §3.4 asks of snow.
const DEFAULT_MUD_PRINT_DEPTH = 0.006;
const DEFAULT_MUD_PRINT_DARKEN = 0.28;
// THE RAIN-DEPENDENT PERSISTENCE (see the `terrain_dirt.js` header, decision
// (b)): the shared trail fade is GLOBAL and mud cannot have its own, so the
// rain dependence rides AMPLITUDE. At bone-dry wetness the print is scaled to
// this fraction of full — faint, and gone from the eye long before the map's
// fade removes it; at full wetness it is 1.0. The stamp side does the same
// thing (`terrain_dirt.js::mudStampFor`), so the two compose.
const DEFAULT_MUD_PRINT_DRY_SCALE = 0.35;
//
// WET MUD reuses the RESPONSE CURVE of `vfx/components/wetness.js` verbatim
// (plan §3.7 item 2: "so puddled statics and puddled ground agree"): its
// `smoothstep(0.05, 0.6, worldNormal.y)` up-facing weight — here the terrain's
// AC-space geomN.z, which IS the world up component in this frame — times a
// 0.62 diffuse darken and a 0.25 roughness multiplier. The numbers below are
// that component's `defaults` object, not new tuning.
const DEFAULT_MUD_WET_STRENGTH = 1.0;        // wetness.js defaults.strength
const DEFAULT_MUD_WET_DARKEN = 0.62;         // wetness.js defaults.darken
const DEFAULT_MUD_WET_ROUGH_DROP = 0.25;     // wetness.js defaults.roughDrop
// Dry dirt's base roughness. The `nra` B channel carries a real per-layer
// roughness, but it is only sampled inside the `uPbrEnabled && !acGouraud`
// block, which retail Gouraud (DEFAULT-ON) makes dead in a normal session —
// the same reason the water sheen and the ice treatment were lifted out of it.
// So the wet lobe runs off a constant, and 0.86 is where curated dirt/gravel
// albedo sits in both texture arms.
const DEFAULT_MUD_BASE_ROUGH = 0.86;
// Gains for the two halves of "glossier": a Blinn sun lobe and an env
// reflection off the shared ?ibl cube. Deliberately well under the ice
// treatment's 0.55/0.65 — wet mud is damp, not glazed.
const DEFAULT_MUD_WET_SPEC = 0.22;
const DEFAULT_MUD_WET_ENV = 0.28;
// Clay (`Argila`, 24) "redder and slicker after rain" (plan §3.7): a warm tint
// multiplied into the wet darkening, and a gloss bonus on top of the family's.
// Calibration target is the BC7 arm (:8767 with `texBc7=on&terrainBc7=on`) —
// plan §8 risk 13.
const DEFAULT_CLAY_WET_TINT = Object.freeze([1.12, 0.92, 0.86]);
const DEFAULT_CLAY_WET_GLOSS_BONUS = 0.35;

// Wave 2B — OBSIDIAN is CODE 6 ALONE (plan §3.6 item 5), not the whole family:
// Volcano1/Volcano2 are cracked rock, ObsidianPlain is glass. Codes 0..0x14 are
// NAMED in the retail `LandDefs::TerrainType` enum, so 6 IS ObsidianPlain
// engine-wide — a retail-enum constant, not a name match against the Dereth
// palette (which §8 risk 12 forbids). `terrain_volcano.js` exports the same
// number as `TERRAIN_CODE_OBSIDIAN_PLAIN`; the node test locks them together.
const TERRAIN_OBSIDIAN_CODES = Object.freeze(new Set([6]));

// ----- GLSL — bilinear-blend shader, three.js port ------------------
//
// Vertex shader: drops the PIXI mat3 chain in favour of three.js's
// auto-injected `projectionMatrix` + `modelViewMatrix` + `position`
// (vec3) builtins. The per-fragment `vGridUv = position.xy / 24.0`
// matches the 2D path: position.xy is in LB-local metres (0..192,
// 24 m vertex spacing), so dividing by 24 yields a [0, 8] grid coord
// the fragment shader uses to bilinear-blend.
//
// Vertex Z (height) ends up in clip-space via the same
// `projectionMatrix * modelViewMatrix * vec4(position, 1.0)` chain;
// the fragment shader is height-agnostic — it samples by xy only —
// which is correct because terrain types are 2D footprints, not 3D.
const TERRAIN_VERTEX_GLSL = `
precision highp float;

in float terrainCode;                 // Phase 1.2 — per-vertex (uint8→float)
// 2026-05-28 — per-vertex brightness factor in [0..1+] sourced from
// TerrainTex's (min_vert_bright, max_vert_bright) range with a
// world-position-hashed random pick per vertex. Always supplied
// (defaults to 1.0 when the modulation ranges table is unavailable);
// the fragment shader gates the multiply behind
// uTerrainModulationEnabled so an attribute of all-1.0s with the gate
// off is also a no-op. See buildTerrainVertexModulation for math.
in float vertexBrightness;
// R1.A 2026-05-28 — companion per-vertex saturation + hue factors from
// TerrainTex's (min/max_vert_saturate) + (min/max_vert_hue) ranges.
// Same world-XY hash as vertexBrightness, decorrelated by a per-channel
// salt. Always supplied (default 1.0 when the table is missing); the
// fragment shader gates them behind uTerrainModulationEnabled *
// uTerrainModSatHue so all-1.0 attributes with either gate off are a
// no-op. See buildTerrainVertexModulation for math.
in float vertexSaturate;
in float vertexHue;
// RND-20/21 — retail CLandBlockStruct::calc_lighting per-vertex normal
// (acclient.c:353713): summed UNIT face normals, BLOCK-LOCAL (landblock seams
// are a retail feature, not a bug), resampled onto the subdivided grid through
// the same per-cell split diagonal the positions use. Distinct from normal,
// which is seam-continuous and drives the detail/triplanar path. Supplied by
// adapter.js only when the wasm bundle exports acLightNormals; the fragment
// gate uAcGouraudEnabled is 0 otherwise, so a missing attribute is a no-op.
in vec3 acLightNormal;

uniform float uTime;                  // Phase 2.2 — shared wall-clock seconds
uniform int uWaterCodeMask;           // Phase 2.2 — bitmask of SWELL-eligible water codes (retail SurfChar set; the fragment stage uses the wider uWaterSurfaceCodeMask for the surface look)
uniform int uLavaCodeMask;            // Phase 2.2 — bitmask of lava terrain codes (Region 0x13 = 0)
uniform float uDisplacementEnabled;   // Phase 2.2 — 0.0 OFF / 1.0 ON (2026-07-31: plain ?waterWave=off escape; NO subdiv gate, the wave is lattice-locked and level-independent)
uniform vec2 uLbOriginXy;             // Phase 2.2 — per-LB world-frame origin (lbX*192, lbY*192); ensures wave-phase continuity across LB seams

out vec2 vGridUv;
out vec3 vWorldPos;  // Clouds-L: terrain world-space position for cloud-shadow projection
out float vViewDepth; // CSM-on-terrain: view-space depth (positive = in front of camera) for cascade selection
flat out int vTerrainCode;            // Phase 1.2 — passed flat-int to FS
out float vBrightness;                // 2026-05-28 — TerrainTex brightness modulation (interpolated, applies in FS)
out float vSaturate;                  // R1.A 2026-05-28 — TerrainTex saturation modulation (interpolated, applies in FS)
out float vHue;                       // R1.A 2026-05-28 — TerrainTex hue modulation (interpolated, applies in FS)
// Phase 1.3 — AC-space LB-local position + interpolated geometry
// normal, used by the fragment shader for slope-gated triplanar
// sampling. Both are in AC coords (Z-up); the worldRoot Y-up rotation
// is applied to a parent transform that we deliberately bypass here
// so the existing 'vGridUv = position.xy / 24.0' semantics extend
// naturally to YZ + XZ planes.
out vec3 vAcPos;
out vec3 vAcNormal;
// NOT normalised here or in the FS: retail interpolates the per-vertex COLOUR
// linearly across each triangle, and colour is affine in dot(N, sunVec).
// Interpolating the raw normal keeps that dot linear, so the GPU's Gouraud
// interpolation reproduces retail's lerp. Renormalising would bend it.
out vec3 vAcLightNormal;
// Phase 2.2 — 1.0 if the vertex is water, 0.0 otherwise. The fragment
// shader uses this to decide whether to apply UV scroll + tint shift.
// Flat-interpolated alongside vTerrainCode so the fragment sees the
// same provoking-vertex classification.
flat out int vIsWater;
// Perf D1 — vertex-side fold of the water modulation the fragment shader
// used to evaluate per-pixel.
//   .x = sin(uTime * 0.3)  -- water tint breath (constant per draw, so
//        linear interpolation of it is exact)
//   .y = 2026-07-31 (water-fix) this vertex's APPLIED swell height in
//        metres (0.0 on non-water vertices). Interpolates across the
//        triangle exactly the way the displaced geometry does, so the
//        fragment stage reads a consistent crest/trough signal.
out vec2 vWaveModulation;

// 2026-05-30 — logarithmic depth buffer participation. The renderer runs
// with logarithmicDepthBuffer:true (index.js); three.js injects the
// USE_LOGARITHMIC_DEPTH_BUFFER define (renamed from USE_LOGDEPTHBUF circa
// r163; we guard both) + the logDepthBufFC uniform into EVERY program, and
// its built-in materials (buildings/cells/statics = MeshStandardMaterial)
// write a LOGARITHMIC gl_FragDepth. This raw ShaderMaterial omitted the
// chunk, so terrain wrote ordinary HARDWARE depth — a different encoding —
// and could not occlude buildings/EnvCells in the shared depth buffer. That
// (not the indoor depth-clear pass) is the real "buildings through terrain"
// see-through; the regression dates to eda27718 (2026-05-25) which turned
// log-depth on without updating this shader. Inlined rather than
// #include <logdepthbuf_*> to avoid the chunk's isPerspectiveMatrix()
// dependency on <common>. Guarded by the log-depth define so a non-log
// renderer (none today) stays correct.
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
out float vFragDepth;
out float vIsPerspective;
#endif

// Phase 2.2 — 2D value-noise (Perlin-fade interp). Tiny port from
// Phase 2.1's Rust impl at terrain_subdiv.rs::value_noise_2d. Reserved
// for the lava displacement branch (Region 0x13 has no lava terrain
// codes — branch never executes for retail Holtburg).
float fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float hash21(vec2 p) {
  // Cheap deterministic hash — same period as the Rust impl. Stable
  // across LB seams because input is world-frame AC coords.
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float valueNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  float u = fade(f.x);
  float v = fade(f.y);
  return mix(mix(a, b, u), mix(c, d, u), v) * 2.0 - 1.0;
}

// 2026-07-31 (water-fix) — the water swell, sampled at an arbitrary
// WORLD-frame XY (metres). Two sines at ~140 m and ~101 m wavelength;
// combined envelope ~0.25 m, inside the 0.4 m plan cap.
float waterSwellAt(vec2 wxy) {
  return sin(uTime * 0.5 + wxy.x * 0.045) * 0.15
       + sin(uTime * 0.7 + wxy.y * 0.062) * 0.10;
}

// 2026-07-31 (water-fix) — LOD-safe evaluation of the swell: sample it on
// the 24 m CONTROL lattice and bilinearly interpolate to the vertex. See
// the long comment above the shader source for why this (and not a direct
// per-vertex sine) is what keeps the water surface identical at every
// subdivision factor, hence crack-free across the moving LOD ring and
// phase-continuous across landblock seams (the lattice is world-frame and
// 192 is a multiple of 24, so both LBs sharing a seam agree exactly).
float waterSwellLattice(vec2 wxy) {
  vec2 c0 = floor(wxy / 24.0) * 24.0;
  vec2 f = (wxy - c0) / 24.0;
  float s00 = waterSwellAt(c0);
  float s10 = waterSwellAt(c0 + vec2(24.0, 0.0));
  float s01 = waterSwellAt(c0 + vec2(0.0, 24.0));
  float s11 = waterSwellAt(c0 + vec2(24.0, 24.0));
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

// 2026-07-31 (water-fix) — same lattice lock for the (currently inactive)
// lava branch, so a region-aware extension that populates uLavaCodeMask
// inherits the crack-free property instead of re-opening the seam.
float lavaSwellLattice(vec2 wxy) {
  vec2 c0 = floor(wxy / 24.0) * 24.0;
  vec2 f = (wxy - c0) / 24.0;
  vec2 t = vec2(uTime * 0.2, 0.0);
  float s00 = valueNoise2D(c0 * 0.05 + t);
  float s10 = valueNoise2D((c0 + vec2(24.0, 0.0)) * 0.05 + t);
  float s01 = valueNoise2D((c0 + vec2(0.0, 24.0)) * 0.05 + t);
  float s11 = valueNoise2D((c0 + vec2(24.0, 24.0)) * 0.05 + t);
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

void main() {
  vec3 displacedPos = position;
  // Retail zFightTerrainAdjust — lower every terrain vertex ~1 cm so at-grade
  // floors / cell / dungeon-entrance geometry win the shared-depth test (see
  // ZFIGHT_TERRAIN_ADJUST_M in terrain.js; acclient.c ACRender::landPolyDraw
  // writes vertex.z - zFightTerrainAdjust). Constant subtract → identical
  // effect whether applied before or after the water/lava wave below.
  displacedPos.z -= ${ZFIGHT_TERRAIN_ADJUST_M.toFixed(10)};
  int code = int(terrainCode + 0.5);
  int isWater = 0;
  // World-frame XY = per-LB origin + LB-local position. Hoisted out of
  // the displacement gate so Perf D1's vWaveModulation can read it
  // unconditionally below.
  vec2 worldXy = uLbOriginXy + position.xy;
  // Perf D1 — the tint-breath sine at vertex rate (once per vertex instead
  // of once per fragment). uTime is constant per draw so .x is literally the
  // same value at every vertex and survives interpolation exactly.
  // 2026-07-31 (water-fix) — .y used to carry one wavelet of the old
  // per-vertex sine so the displacement could reuse it. The swell is now
  // lattice-locked (see waterSwellLattice), so .y instead exports THIS
  // vertex's applied swell height in metres — a value the fragment stage can
  // read without re-deriving the wave. Zero on non-water vertices.
  float waveModX = sin(uTime * 0.3);
  float appliedSwell = 0.0;
  // Time-varying displacement on water + lava terrain, gated by
  // uDisplacementEnabled (now a plain ?waterWave=off escape, NOT a subdiv
  // quality gate — the lattice lock makes the surface level-independent).
  // The bitmask lookups are 32-bit shifts; both masks are constructed
  // JS-side from the TERRAIN_WATER_CODES / TERRAIN_LAVA_CODES sets so the
  // GLSL stays free of per-code if/elif chains.
  if (uDisplacementEnabled > 0.5 && code >= 0 && code < 32) {
    int bit = 1 << code;
    if ((uWaterCodeMask & bit) != 0) {
      appliedSwell = waterSwellLattice(worldXy);
      displacedPos.z += appliedSwell;
      isWater = 1;
    } else if ((uLavaCodeMask & bit) != 0) {
      // Slow chunky 2D value-noise — 0.4 m max amplitude. Inactive for
      // Region 0x13 (no lava codes in the mask); kept here for forward
      // compat with region-aware extensions.
      appliedSwell = lavaSwellLattice(worldXy) * 0.4;
      displacedPos.z += appliedSwell;
    }
  }
  vWaveModulation = vec2(waveModX, appliedSwell);
  vIsWater = isWater;

  vWorldPos = (modelMatrix * vec4(displacedPos, 1.0)).xyz;
  vec4 mvPos = modelViewMatrix * vec4(displacedPos, 1.0);
  vViewDepth = -mvPos.z;
  gl_Position = projectionMatrix * mvPos;
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
  // Standard three.js logarithmic-depth vertex term (matches the built-in
  // logdepthbuf_vertex chunk). vIsPerspective folds isPerspectiveMatrix()
  // inline: a perspective projection has m[2][3] == -1.0.
  vFragDepth = 1.0 + gl_Position.w;
  vIsPerspective = float( projectionMatrix[2][3] == -1.0 );
#endif
  // Per-vertex grid coordinate in [0, 8] across the 192 m landblock
  // (8 cells × 24 m each). Fragment splits into integer cell index
  // + intra-cell UV, looks up the cell's 4 corner terrain types
  // from uVertexTypes, samples uAtlas at each corner, and blends by
  // bilinear weights.
  vGridUv = position.xy / 24.0;
  // Pass terrain code as a flat int for the Phase 1.2 detail-normal
  // slice lookup. Flat interpolation means every fragment of a
  // triangle sees the provoking vertex's code — three corners may
  // disagree but we deliberately pick one per triangle rather than
  // blending (terrain codes are discrete categories).
  vTerrainCode = code;
  // 2026-05-28 — pass per-vertex brightness through to FS. Linear
  // interpolation across the triangle gives a smooth gradient between
  // vertices' picked values (each vertex's value is hashed by world
  // position so neighbours differ slightly). Fragment shader applies
  // the multiply at the end of color composition, gated by uniform.
  vBrightness = vertexBrightness;
  // R1.A 2026-05-28 — pass per-vertex saturation + hue factors through.
  // Same linear-interpolation rationale as brightness; the fragment
  // shader applies the HSL adjust just before the brightness multiply,
  // gated by uTerrainModulationEnabled * uTerrainModSatHue.
  vSaturate = vertexSaturate;
  vHue = vertexHue;
  // vAcPos passes the UNDISPLACED position so the Phase 1.3 triplanar
  // sampler reads consistent values across frames (displacement is
  // visual-only; collision math + detail-normal projections stay
  // anchored to the bilinear-on-control 24 m surface).
  vAcPos = position;
  vAcNormal = normal;
  vAcLightNormal = acLightNormal;
}
`;

// Fragment shader: ported verbatim from `index.html:1006-1082` minus
// the PIXI-specific `vColor` varying + uColor/uWorldColorAlpha
// modulation. The bilinear-blend body is byte-identical to the 2D
// path — same texelFetch lookup, same atlasUvFor mapping, same 4-
// corner weights — so visual output should match the 2D bilinear
// reference once the camera converges (Phase 7.5+ camera work).
const TERRAIN_FRAGMENT_GLSL = `
precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2DArray uAtlas;        // 33 layers of 256×256 retail terrain tiles, one per code (0..32). ClampToEdge per layer eliminates the cross-tile bleed that the prior 6×6 packed atlas produced at mip levels ≥3 (the "not flush with vertices" artefact: gutter-less neighbours bled into each other along cell vertex lines).
// T1 (2026-05-29) — per-code base texture tiling (retail TerrainTex.tex_tiling
// == 2 for all 33). Retail's TexMerge::CopyAndTile→TileCSI replicates the
// source NxN into the merged tile (acclient.c:304685,365513), so a UV∈[0,1]
// sample shows N×N copies. atlasUvFor mirrors that with fract(cellUv * tiling).
// Default 1 (no tiling) when the LUT is unavailable → fail-soft to the prior
// 1× render. The atlas is ClampToEdge per layer (see uAtlas above), so the
// fract() wrap is REQUIRED — a raw *tiling would clamp and cut the tile off.
uniform int uBaseTexTiling[33];       // per-code base tex_tiling (retail 2; 1 = off/fallback)
// T2 (2026-07-28, ?pbrTerrain on by default) -- 33-layer nra array parallel
// to uAtlas: R/G = CC0 tangent-normal XY (Z reconstructed below), B =
// roughness, A = ambient occlusion; uncurated layers hold 128,128,230,255
// (flat normal, high rough -> no false sheen). Same layer indexing and the
// same atlasUvFor fract-tiling addressing as uAtlas so material data and
// albedo stay registered per cell. Linear (NoColorSpace) -- non-colour data.
uniform sampler2DArray uAtlasNormalAo;
uniform float uPbrEnabled;            // 0.0 OFF (default) / 1.0 ON
// T3 (2026-07-28, ?ibl=on) -- mipmapped HDR sky cube rendered from
// skyDome.skyScene by IblEnvironment (three WORLD space, y-up). Sampled for
// a per-layer env-specular gloss term on ice/snow. Uniforms are pushed each
// frame by IblEnvironment.tick over scene3d.terrainMaterials (bake order vs
// ibl-init order never matters). uEnvIntensity carries the retail diurnal
// ambient term (L1 ambBright curve, 0.2 night floor).
uniform samplerCube uEnvCube;
uniform float uIblEnabled;            // 0.0 OFF / 1.0 ON (default)
uniform float uEnvIntensity;
uniform float uWaterEnvEnabled;       // terrainplan s4 default tier: water sheen gate
uniform sampler2D uVertexTypes;       // 9×9 RGBA8: R = terrain code, G = roadCode*64, A = 255
uniform sampler2D uRoadTexture;       // retail road tile (RepeatWrap)
uniform float uRoadTileScale;         // road UV tile rate per LB unit
uniform float uRoadEnabled;           // 0 = no road overlay (back-compat / disable)
uniform float uRoadPaintLegacy;       // 1 = pre-2026-07-02 bilinear+smoothstep lane (?roadPaint=legacy)
uniform float uRoadSlotsEnabled;      // 1 = retail TexMerge road overlay slots 4..5 (default; ?roadSlots=off disables)

// Wave 2.A — 32x1 RGBA terrain palette LUT. One sRGB triple per retail
// terrain code 0..31 from TerrainDesc.terrain_types[i].terrain_color
// (Region 0x13000000 in client_portal.dat). The fragment shader samples
// the four cell-corner palette colours with the same bilinear weights
// it uses for atlas-tile blending, then modulates the resulting atlas
// colour by uTerrainPaletteStrength so the biome tint nudges
// atlas-sampled pixels toward the canonical retail per-biome colour
// without losing the photographic surface detail.
//
// Disabled (==0.0) when the palette JSON is missing or the loader
// failed — branch around the texelFetches so the atlas-only path
// renders unchanged.
uniform sampler2D uTerrainPalette;
uniform float uTerrainPaletteEnabled;
uniform float uTerrainPaletteStrength;

// Phase 1.2 — detail-normal array. 5 RGB normal maps (slice order:
// 0 grass | 1 dirt | 2 sand | 3 stone | 4 snow). The shader looks up
// the slice for the provoking vertex's terrain code from uCodeToSlice[]
// then samples uTerrainDetailNormalArray at vGridUv * uDetailScale.
uniform sampler2DArray uTerrainDetailNormalArray;
uniform int uCodeToSlice[32];         // terrain-code → slice (255 = no detail)
uniform float uDetailScale;
uniform vec2 uWindDir;                // unit vec2 (cos, sin) — sand UV rotation
uniform float uDetailNormalEnabled;   // 0.0 OFF / 1.0 ON (quality gate)
uniform float uTerrainSlopeShadingEnabled; // F12-3: 0.0 OFF / 1.0 ON (?terrainSlopeShading)
// T7 (2026-05-28) — terrain DETAIL DIFFUSE texture. Retail modulates the
// merged base tile by a per-terrain-type detail texture (acclient
// TexMerge::GetDetailTex / GetDetailTiling) that tiles at sub-metre
// frequency, adding near-camera high-frequency contrast (grass blades,
// gravel, rock grain) that fades to a neutral mean at distance (the mip
// chain averages to ~mid-grey → MODULATE2X neutral). Opt-in via the
// ?terrainDetailTex=on URL flag; uDetailTexEnabled=0 → fragment branch
// skipped, render byte-identical to before.
uniform sampler2DArray uTerrainDetailTex; // unique detail slices (retail ~3)
uniform int uCodeToDetailTexSlice[33];    // terrain-code (0..32) → detail slice (255 = none)
uniform int uDetailTexTiling[33];         // per-code detail_tex_tiling (retail 1/2/4/8)
uniform int uDetailTexSliceCount;         // number of valid slices (slice < count is real)
uniform float uDetailTexBaseScale;        // UV repeats per cell-unit per tiling step (eye-test-tuned)
uniform float uDetailTexStrength;         // 0..1 modulation strength near camera
uniform float uDetailTexFadeStart;        // metres — full strength nearer than this
uniform float uDetailTexFadeEnd;          // metres — zero strength beyond this
uniform float uDetailTexEnabled;          // 0.0 OFF / 1.0 ON (URL flag gate)
// 2026-07-02 — 1.0 = retail landscape-detail op (alpha CROSSFADE toward the
// tile, weighted by the tile's own alpha and a linear 10-50 m distance fade;
// acclient.c:459046/454415/719936). 0.0 = the legacy per-code MODULATE2X
// grain (?terrainDetailTex=percode A/B mode).
uniform float uDetailTexCrossfade;
// ---------------------------------------------------------------------------
// FAR MACRO (2026-08-02, ?terrainMacro — DEFAULT ON, escape ?terrainMacro=off)
// ---------------------------------------------------------------------------
// The "mspaint" fix. uTerrainDetailTex above is a NEAR-camera layer by
// design (uDetailTexFadeEnd = 50 m), and past it the atlas mip chain has
// averaged each 24 m cell into one flat colour — so distant Dereth is N flat
// colour fields separated by the TexMerge masks' hand-drawn cell-grid edges.
//
// uMacroTex is a 7-slice array of 1024² TILEABLE MODULATION maps, one per
// terrain FAMILY (grass/sand/rock/snowice/swamp/volcano/dirt — see
// terrain_macro.js + assets/terrain_macro/generate.py), baked offline from the
// same ground textures the atlas renders with. MODULATE2X encoded with every
// channel's mean pinned to 0.5, so multiplying by it PRESERVES the authored
// average colour of a distant field exactly and changes only its structure.
// The DAT still decides what is where; this only changes how it is shaded far
// away. Two taps at different world scales (one rotated) kill the tile repeat.
uniform sampler2DArray uMacroTex;
uniform int uMacroSliceForCode[33];   // terrain code -> family slice (255 = none, e.g. water/road)
uniform int uMacroSliceCount;         // slices actually loaded; slice >= count means skip
uniform float uMacroEnabled;          // 0.0 OFF / 1.0 ON
uniform float uMacroStrength;         // peak blend weight of the modulation
uniform float uMacroFadeStart;        // metres — untouched nearer than this
uniform float uMacroFadeEnd;          // metres — full strength beyond this
uniform float uMacroScaleA;           // world metres per macro tile, tap A
uniform float uMacroScaleB;           // world metres per macro tile, tap B (rotated)
uniform float uMacroNoiseAmp;         // extra procedural world-space octaves
// T1 (2026-05-28) — retail TexMerge composite. AC's landscape does NOT
// bilinear-blend between cells: each 24 m cell picks a base terrain texture
// plus up to 3 alpha-masked overlays (one per differing corner) + up to 2
// road overlays, composited with hand-authored A8 masks selected + rotated
// per cell. uMergeData is a per-LB 48×8 data texture: 8 EW cells × 6 slots
// (slot 0 base, 1..3 overlays, 4..5 roads); each texel = [atlasLayer,
// alphaMaskIdx, rotation(0-3), valid(0/255)] (see
// holtburger_dat::terrain_merge::pack_merge_record). uAlphaMasks is the
// ordered mask array [corner0..3, side0, road0..2]. Opt-in via
// ?texMerge=on; uTexMergeEnabled=0 → the bilinear path below runs unchanged.
uniform highp sampler2D uMergeData;       // per-LB 48×8 RGBA8 (NearestFilter)
uniform sampler2DArray uAlphaMasks;       // 8 ordered A8 masks (R = weight)
uniform float uTexMergeEnabled;           // 0.0 OFF / 1.0 ON
// T1 (terrainplan, 2026-07-28) -- splat-noise borders. Perturbs the texMerge
// overlay mask weight with world-space coherent value noise, band-limited by
// w*(1-w) so ONLY the transition zone fingers (mask interiors and pure
// cells are untouched, and amp 0 is a strict no-op). Kills the "transitions
// follow the 24 m cell grid / fixed retail masks" read.
uniform float uSplatNoiseAmp;             // 0 = off; ~0.6 default via flag
uniform float uSplatNoiseFreq;            // world-space 1/m; ~0.35 default
// 2026-08-02 (?splatMacro, DEFAULT ON) — SECOND, MUCH LOWER-FREQUENCY splat
// octave. uSplatNoiseFreq 0.35 /m is a ~3 m wavelength: it is sub-pixel past
// roughly 150 m, averages to nothing under the mip/aniso filter, and the hard
// 24 m cell-grid border comes straight back at exactly the distances the user
// called "mspaint". This octave wanders at 30-60 m and survives to the horizon.
// The same flag also restores the historical (biased) splatN expression when
// set to off -- see the splatN block in main() for that bug's description.
uniform float uSplatMacroAmp;             // 0 = legacy path; ~0.9 default
uniform float uSplatMacroFreq;            // world-space 1/m; ~0.022 default (~45 m)
// T4 (terrainplan, 2026-07-28) -- parallax occlusion mapping. Material
// height lives in uAtlas ALPHA (v3 bake; sRGB decode never touches A;
// retail layers hold A=255 = flat = zero offset by construction). Steep-
// parallax march of the nearest-corner layer's height field, 8 steps,
// distance-faded, applied to cellUv BEFORE all sampling so albedo, nra,
// masks and detail stay registered. Quality-gated high/ultra (SwiftShader-
// hostile); escape ?pom=off.
uniform float uPomEnabled;                // 0.0 OFF / 1.0 ON
uniform float uPomScale;                  // UV offset amplitude (~0.012)
uniform float uPomFadeStart;              // metres -- full effect nearer
uniform float uPomFadeEnd;                // metres -- zero beyond
// 2026-06-21 — per-vertex stochastic winner-take-all blend (?paintMode=winner).
// uPaintMode 0=bilinear average (legacy default), 1=winner-take-all per vertex.
// uPaintNoiseFreq: noise sampling rate over vGridUv (which is 1.0 per 24 m), so
// a value of 8.0 = ~3 m noise pattern. uPaintNoiseStrength: how far noise can
// push a corner's bilinear weight (0.4 = noise dominates near cell diagonals,
// bilinear dominates near vertex corners). Both runtime-tunable via uniforms.
uniform float uPaintMode;
uniform float uPaintNoiseFreq;
uniform float uPaintNoiseStrength;
// 2026-06-22 — Candidate H (domain-warped coherent-noise winner). uWarpAmp>0
// swaps the per-pixel sin-hash perturbation (fragHash21 — directional moire +
// salt-and-pepper, and STATIC over scrolling water, the "liney" coast look)
// for a spatially-coherent value-noise field (fragValueNoise2D) sampled through
// a domain warp, so the boundary goes organic instead of liney. uWarpFreq
// scales the warp lattice. uWinnerSoftness>0 replaces the hard argmax with a
// soft top-two blend (a narrow, distinct-texture transition band). All three
// default 0.0 = byte-identical to the shipped ?paintMode=winner path.
uniform float uWarpAmp;
uniform float uWarpFreq;
uniform float uWinnerSoftness;

// Per-fragment 2D hash. Mirrors hash21 in TERRAIN_VERTEX_GLSL (line ~801).
// Fragment + vertex shaders compile separately, so a function defined in the
// vertex stage is NOT visible here; without this redeclaration the
// uPaintMode=1 branch fails to compile and three.js renders the whole
// terrain as a black fallback (no console error visible in __bootState,
// just black ground). Same constants as the vertex copy for byte-identical
// output if shared.
float fragHash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
// 2026-06-22 — Candidate H: fragment-stage copy of TERRAIN_VERTEX_GLSL's
// fade + valueNoise2D (lines ~800-816). Quintic-interpolated lattice noise is
// C1-continuous, so it has NONE of the sin-dot directional banding the raw
// fragHash21 shows, and it varies smoothly in space (no per-pixel speckle).
// Returns roughly [-0.5, 0.5] to match the old (fragHash21 - 0.5) amplitude.
float fragFade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float fragValueNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = fragHash21(i);
  float b = fragHash21(i + vec2(1.0, 0.0));
  float c = fragHash21(i + vec2(0.0, 1.0));
  float d = fragHash21(i + vec2(1.0, 1.0));
  float u = fragFade(f.x);
  float v = fragFade(f.y);
  return (mix(mix(a, b, u), mix(c, d, u), v) - 0.5);
}
// R4.a 2026-05-28 — sub-gate for the retail mid-point alpha rounding
// (acclient.c:365787-365798 ImgTex::MergeTexture: if 0<a<0xFF && a>0x80, a++).
// 1.0 when ?texMerge=on so the composite includes the rounding by default;
// can be forced 0 for an on-GPU A/B of the rounding alone. Multiplied by
// uTexMergeEnabled, so it is a strict no-op whenever the master gate is off.
uniform float uTexMergeAlphaRound;        // 0.0 OFF / 1.0 ON (under uTexMergeEnabled)
// Phase 1.3 — slope-gated triplanar sampling of the detail normal.
// uTriplanarEnabled gates the whole block off when quality is low;
// uTriplanarSharpness is the power applied to abs(normal) before
// normalising the blend weights (4-8 is the sweet spot — see
// DEFAULT_TRIPLANAR_SHARPNESS comment on the JS side).
uniform float uTriplanarEnabled;
uniform float uTriplanarSharpness;
// Perf D3 — slope threshold (LO end of the smoothstep). Driven by the
// quality preset's triplanarSlopeThresholdPct (0..100 -> 0.0..1.0).
// low/100 effectively keeps triBlend at 0; mid/60 restricts triplanar
// to the steepest cliffs; high+ultra/30 matches the legacy 0.3 gate.
// HI end remains the JS constant TRIPLANAR_SLOPE_HI baked into the
// shader source — only the LO end varies per quality.
uniform float uTriplanarSlopeLo;
// Phase 2.2 — shared wall-clock seconds, pushed once per rAF by
// loop.js::tickTerrainUTime over scene3d.terrainMaterials. ONE clock drives
// the vertex swell, the UV scroll and the sheen, so all three stay
// phase-locked with each other and across landblock seams.
uniform float uTime;
// 2026-07-08 — water UV scroll gate, DECOUPLED from the vertex displacement.
// The scroll used to share uDisplacementEnabled, which is a geometry/subdiv
// gate — so the batched ring, the distance >= 2 LODs and quality low/mid left
// open water frozen ("moves far, freezes close").
// 2026-07-31 (water-fix) — this is now the gate for the WHOLE per-pixel
// surface animation: the UV scroll AND the blue tint breath (the tint was
// still on uDisplacementEnabled and died at low/mid with it). The fragment
// stage therefore no longer declares uDisplacementEnabled at all — it is a
// vertex-stage-only uniform. ?waterScroll=off => static surface; the
// separate ?waterWave=off => flat geometry; both off => fully static water.
uniform float uWaterScrollEnabled;
// F12-5 + 2026-07-31 (water-fix) — the SURFACE water set (bit i = terrain code
// i gets the water LOOK: scroll, tint, sheen, POM bypass). Deliberately WIDER
// than the vertex stage's uWaterCodeMask, which drives the swell and follows
// retail's surface-characteristic table: code 22 FauxWaterRunning shares a
// retail RenderSurface with 16 WaterRunning, so it must FLOW like the texture
// it is drawn from while not BOBBING like real water. See
// TERRAIN_WATER_SURFACE_CODES on the JS side. Read only through
// isWaterCode() below, the single water test for the whole fragment stage;
// ?strictWaterCodes=off collapses both sets to the legacy 16-23.
uniform int uWaterSurfaceCodeMask;

// === 2026-07-31 (Wave 1B) — SAND GRAIN SPARKLE ==========================
// Terrain-VFX plan §3.2 item 4. A grazing-angle specular twinkle on FAM_SAND
// ground (codes 10/11/12), keyed off the TERRAIN CODE read from uVertexTypes
// — plan trap T3: the per-vertex terrainCode ATTRIBUTE is not read by the
// fragment stage at all on the subdivided path, so an attribute-keyed effect
// would be silently dead. The mask is built on the JS side from
// terrain_families.js (FAM_SAND), never from a hardcoded 10..12 range, so a
// region whose palette moves sand moves this with it (plan §8 risk 12).
// Strict no-op when uSandSparkleEnabled is 0 (?terrainSand / ?terrainSandSparkle
// both ship OFF), and on every non-sand fragment.
uniform float uSandSparkleEnabled;   // 0.0 OFF / 1.0 ON
uniform int uSandSparkleCodeMask;    // bit i = terrain code i is FAM_SAND
uniform float uSandSparkleStrength;  // additive specular gain
uniform float uSandSparkleDensity;   // grain cells per metre
uniform float uSandSparkleFadeStart; // metres — full strength nearer than this
uniform float uSandSparkleFadeEnd;   // metres — zero beyond

// === 2026-08-01 (Wave 2A) — SNOW / ICE ==================================
// Terrain-VFX plan §3.4. THREE independent terms, three gates:
//   1. uSnowSparkleEnabled — sun-glitter on FAM_SNOWICE (codes 2/15/27)
//   2. uSnowPrintEnabled   — the shared trail map read as a dent + darkening
//   3. uIceEnabled         — the codes-2/27-only hard/wet material treatment
// Every mask is built on the JS side from terrain_families.js, never from a
// hardcoded code range (plan §8 risk 12), and every code test goes through the
// uVertexTypes 9x9 DataTexture, never the terrainCode ATTRIBUTE, which the
// fragment stage does not read on the subdivided path (plan trap T3). All
// three are strict no-ops when their gate is 0 and on every non-snow fragment.
uniform float uSnowSparkleEnabled;   // 0.0 OFF / 1.0 ON
uniform int uSnowSparkleCodeMask;    // bit i = terrain code i is FAM_SNOWICE
uniform float uSnowSparkleStrength;
uniform float uSnowSparkleDensity;   // crystal cells per metre
uniform float uSnowSparkleSharpness; // half-vector lobe exponent
uniform float uSnowSparkleFadeStart;
uniform float uSnowSparkleFadeEnd;

// Footprints. uSnowPrintEnabled is the FLAG (baked with the material);
// uSnowTrailEnabled is "a trail map exists and is bound THIS FRAME", pushed by
// scene3d/terrain_snow.js over scene3d.terrainMaterials — the same per-frame
// push idiom loop.js::tickTerrainUTime and IblEnvironment.tick already use.
// Both must be on: the map is built ONLY under ?terrainTrail=on and this family
// never lazily creates one (the grass-stomp precedent).
uniform float uSnowPrintEnabled;     // 0.0 OFF / 1.0 ON
uniform float uSnowPrintDepth;       // cell-UV dent amplitude (<< uPomScale)
uniform float uSnowPrintDarken;      // 0..1 fraction of lit colour removed
uniform sampler2D uSnowTrailMap;     // R8 ping-ponged trail RT (trail_map.js)
uniform vec2 uSnowTrailCenter;       // AC world centre of the map, texel-snapped
uniform float uSnowTrailRadius;      // HALF-extent in metres
uniform float uSnowTrailEnabled;     // 0.0 = no map bound this frame

// Ice. The mask is a STRICT SUBSET of the snow mask: 2 (Ice) + 27 (BlueIce)
// only, never 15 (Snow), which stays matte.
uniform float uIceEnabled;           // 0.0 OFF / 1.0 ON
uniform int uIceCodeMask;            // bit i = terrain code i is ICE MATERIAL
uniform float uIceGloss;             // 1 - roughness
uniform float uIceSpecStrength;      // Blinn sun-glint gain
uniform float uIceEnvStrength;       // env-cube reflection gain (needs ?ibl)
uniform float uIceRefractEnabled;    // 0.0 OFF / 1.0 ON (ultra tier)
uniform float uIceRefractAmount;     // cell-UV offset amplitude (<< uPomScale)

// === 2026-08-01 (Wave 2B) — VOLCANO CRACK GLOW + OBSIDIAN ================
// Terrain-VFX plan §3.6 items 3 + 5. A dull red glow breathing in the cracks
// on FAM_VOLCANO ground (codes 6/25/26) plus a tight dark specular on
// ObsidianPlain (code 6 only), keyed off the TERRAIN CODE read from
// uVertexTypes — plan trap T3, the same reason the sand sparkle above does.
// The masks are built on the JS side from terrain_families.js (FAM_VOLCANO)
// and the retail enum (obsidian = 6), never from a hardcoded range here.
// Strict no-op when uCrackGlowEnabled is 0 (?terrainVolcano / ?terrainCrackGlow
// both ship OFF), and on every non-volcanic fragment.
//
// uCrackGlowBreath is the SLOW BREATHING OSCILLATOR, driven through the shared
// vfx/oscillators.js registry (terrain_volcano.js::CRACK_GLOW_OSC_NAME, a
// 0.07 Hz sine) and PUSHED here each frame by loop.js::tickTerrainUTime. It is
// pushed rather than bound by reference because terrain_batch.js CLONES uniform
// values into fresh objects when it builds the batched material, and
// ?terrainBatch is default-ON -- a by-reference binding would silently freeze
// the breath on the batched path.
uniform float uCrackGlowEnabled;     // 0.0 OFF / 1.0 ON  (gates BOTH terms)
uniform int uVolcanoCodeMask;        // bit i = terrain code i is FAM_VOLCANO
uniform int uObsidianCodeMask;       // bit 6 — ObsidianPlain alone
uniform float uCrackGlowStrength;    // emissive gain
uniform float uCrackGlowDensity;     // vein cells per metre
uniform float uCrackGlowWidth;       // ridged-noise threshold (vein thickness)
uniform vec3 uCrackGlowColor;
uniform float uCrackGlowBreath;      // 0.44..1.0, pushed each frame
uniform float uCrackGlowFadeStart;   // metres — full strength nearer than this
uniform float uCrackGlowFadeEnd;     // metres — zero beyond
uniform float uObsidianShininess;    // Blinn exponent (roughness down-down)
uniform float uObsidianSpecular;     // sun-lobe gain
uniform float uObsidianEnv;          // env-cube reflection gain

// === 2026-08-01 (Wave 3B) — MUD PRINTS + WET MUD =========================
// Terrain-VFX plan §3.7 items 2 + 4. A deforming, darkening footprint on
// FAM_DIRT ground (codes 5/7/8/24/31) plus the wet-mud darkening and sheen,
// keyed off the TERRAIN CODE read from uVertexTypes — plan trap T3, the same
// reason the sand sparkle, the snow print and the crack glow all do. The masks
// are built on the JS side from terrain_families.js (FAM_DIRT) and its
// sub-variant table (clay = Argila 24), never from a hardcoded range here.
// Strict no-op when both gate uniforms are 0 (?terrainDirt, ?terrainMudPrints
// and ?terrainMudWetness all ship OFF), and on every non-dirt fragment.
//
// ⚠ THE TRAIL SAMPLER IS SHARED, AND ITS NAME IS A WAVE-2A ARTEFACT. There is
// ONE trail map (scene3d/trail_map.js) and ONE sampler2D for it in this shader.
// Wave 2A landed first, so it is called uSnowTrailMap; renaming it for wave 3B
// would be a cross-family churn edit for zero behaviour change, and binding a
// SECOND sampler is precisely what wave 2A's budget ruling forbids (14 samplers
// were bound before the print; this shader is at 15 of a guaranteed 16, and a
// second map would sit on the floor with nothing left for anyone). So MUD reads
// the same sampler, centre and radius that SNOW does — either family's
// per-frame push writes them, identically — and gates itself with its OWN
// float, uMudTrailEnabled. uSnowTrailEnabled stays snow's. Both families may
// run at once; neither can disable the other.
//
// uMudWetness is the live 0..1 rain signal, PUSHED each frame by
// scene3d/terrain_dirt.js from VFX_GLOBALS.uWetness (the already-smoothed
// weather_inputs.js value — plan §3.7 item 4 forbids re-deriving it). Pushed
// rather than bound by reference for the uCrackGlowBreath reason above:
// terrain_batch.js CLONES uniform values and ?terrainBatch is default-ON.
uniform float uMudPrintEnabled;      // 0.0 OFF / 1.0 ON  (the FLAG)
uniform float uMudTrailEnabled;      // 0.0 = no map bound this frame (the PUSH)
uniform int uDirtCodeMask;           // bit i = terrain code i is FAM_DIRT
uniform int uClayCodeMask;           // bit 24 — Argila alone, a strict subset
uniform float uMudPrintDepth;        // cell-UV dent amplitude (<< uPomScale)
uniform float uMudPrintDarken;       // 0..1 fraction of lit colour removed
uniform float uMudPrintDryScale;     // print amplitude at zero wetness
uniform float uMudWetEnabled;        // 0.0 OFF / 1.0 ON
uniform float uMudWetness;           // 0..1, pushed each frame
uniform float uMudWetStrength;       // wetness.js defaults.strength
uniform float uMudWetDarken;         // wetness.js defaults.darken (0.62)
uniform float uMudWetRoughDrop;      // wetness.js defaults.roughDrop (0.25)
uniform float uMudBaseRough;         // dry-dirt roughness the drop scales
uniform float uMudWetSpec;           // Blinn sun-lobe gain
uniform float uMudWetEnv;            // env-cube reflection gain (needs ?ibl)
uniform vec3 uClayWetTint;           // Argila goes redder when wet
uniform float uClayWetGloss;         // ...and slicker

// Clouds-L — sample the cloud effect's cascade-0 shadow buffer to dim
// terrain ambient + diffuse where clouds occlude the sun. takram's
// cloud raymarch already produces these as a side effect of its
// self-shadowing pass; we piggyback rather than running a second
// raymarch. uCloudShadowEnabled gates the whole block off when no
// CloudOverlay is wired (e.g. ?clouds=off).
uniform float uCloudShadowEnabled;
uniform sampler2DArray uCloudShadowMap;
uniform mat4 uCloudShadowMatrix0;
uniform float uCloudShadowStrength;

// AC-z-up unit direction TO the sun. Pushed each frame from
// loop.js (tickTerrainSunDir) off the same SkyState the rest of the
// sky stack reads. Default literal kept for the no-state fallback
// (pre-populator) so terrain is never lit from (0,0,0).
uniform vec3 uSunDir;

// === RND-20/21 — retail terrain Gouraud (?terrainGouraud, default ON) ===
// ACRender::landPolyDraw (acclient.c:719994) calls SetFFLighting(0): retail
// terrain has NO hardware lighting. The only shading is the Gouraud-
// interpolated per-vertex colour that CLandBlockStruct::calc_lighting
// (acclient.c:353886-353899) baked on the light tick:
//   L = max(0, N . sunlight_vec)          // |sunlight_vec| == dirBright
//   c = min(1, sunColor*L + ambColor*ambLevel)   // per channel
// Final pixel = terrain texture x c.
// uAcSunVec therefore carries dirBright as its MAGNITUDE and must not be
// normalised. uAcAmbLevel arrives already floored at LSCAPE_LIGHT_MINIMUM=0.2
// (acclient.c:40344 / 307261) — the floor is on AMBIENT ONLY.
// uAcGouraudEnabled is 0 unless the flag is on AND the geometry carries the
// acLightNormal attribute, so the off path is bit-exact.
uniform float uAcGouraudEnabled;
uniform vec3 uAcSunVec;
uniform vec3 uAcSunColor;
uniform vec3 uAcAmbColor;
uniform float uAcAmbLevel;

// CSM-on-terrain. Mirror of materials.js's MeshStandardMaterial patch
// at materials.js:267-445. Three cascade shadow maps, view-space-depth
// selection, blend zones at boundaries. uCsmEnabled gates the whole
// block off so terrain renders correctly when ?shadows=off or quality
// preset has csm:false. Uniforms refreshed each frame by
// csm.refreshCsmUniforms (registered alongside other materialCache
// patched materials in terrain bake).
uniform float uCsmEnabled;
uniform sampler2D uCsmShadowMap0;
uniform sampler2D uCsmShadowMap1;
uniform sampler2D uCsmShadowMap2;
uniform mat4 uCsmMatrix0;
uniform mat4 uCsmMatrix1;
uniform mat4 uCsmMatrix2;
uniform vec2 uCsmSplits;
uniform float uCsmFar;
uniform float uCsmBlend;

float csmSampleCascade(sampler2D sm, mat4 m, vec3 worldPos) {
  vec4 sc = m * vec4(worldPos, 1.0);
  sc.xyz /= max(sc.w, 1e-6);
  if (sc.x < 0.0 || sc.x > 1.0 ||
      sc.y < 0.0 || sc.y > 1.0 ||
      sc.z > 1.0) {
    return 1.0;
  }
  float bias = 0.0005;
  float ref = sc.z - bias;
  float stored = texture(sm, sc.xy).r;
  return stored < ref ? 0.0 : 1.0;
}

float csmShadowFactor(vec3 worldPos, float viewDepth) {
  float blendW0 = uCsmSplits.x * uCsmBlend;
  float blendW1 = uCsmSplits.y * uCsmBlend;
  if (viewDepth > uCsmFar) return 1.0;
  if (viewDepth < uCsmSplits.x - blendW0) {
    return csmSampleCascade(uCsmShadowMap0, uCsmMatrix0, worldPos);
  }
  if (viewDepth < uCsmSplits.x) {
    float s0 = csmSampleCascade(uCsmShadowMap0, uCsmMatrix0, worldPos);
    float s1 = csmSampleCascade(uCsmShadowMap1, uCsmMatrix1, worldPos);
    float t = (viewDepth - (uCsmSplits.x - blendW0)) / blendW0;
    return mix(s0, s1, clamp(t, 0.0, 1.0));
  }
  if (viewDepth < uCsmSplits.y - blendW1) {
    return csmSampleCascade(uCsmShadowMap1, uCsmMatrix1, worldPos);
  }
  if (viewDepth < uCsmSplits.y) {
    float s1 = csmSampleCascade(uCsmShadowMap1, uCsmMatrix1, worldPos);
    float s2 = csmSampleCascade(uCsmShadowMap2, uCsmMatrix2, worldPos);
    float t = (viewDepth - (uCsmSplits.y - blendW1)) / blendW1;
    return mix(s1, s2, clamp(t, 0.0, 1.0));
  }
  return csmSampleCascade(uCsmShadowMap2, uCsmMatrix2, worldPos);
}

in vec2 vGridUv;
in vec3 vWorldPos;
in float vViewDepth;                  // CSM-on-terrain: view-space depth for cascade selection
flat in int vTerrainCode;             // provoking-vertex terrain code
in vec3 vAcPos;                       // Phase 1.3 — LB-local AC pos (z=up)
in vec3 vAcNormal;                    // Phase 1.3 — geometry normal (AC z-up)
in vec3 vAcLightNormal;               // RND-20/21 — retail calc_lighting normal, NOT renormalised
flat in int vIsWater;                 // Phase 2.2 — 1 if water, 0 otherwise
in float vBrightness;                 // 2026-05-28 — TerrainTex per-vertex brightness modulation factor
in float vSaturate;                   // R1.A 2026-05-28 — TerrainTex per-vertex saturation modulation factor
in float vHue;                        // R1.A 2026-05-28 — TerrainTex per-vertex hue modulation factor

// 2026-05-28 — gate for the TerrainTex modulation multiply. 0.0 = no
// modulation (final color unchanged), 1.0 = full multiply by
// vBrightness. Driven by the URL flag ?terrainMod=on (defaults off
// per project_terrain_vertex_modulation_gap memo: the modulation was
// authored into the DAT but never applied by retail's shipped client,
// so it's opt-in until visual verification confirms the
// best-guess unit interpretation looks right on real hardware).
uniform float uTerrainModulationEnabled;
// R1.A 2026-05-28 — sub-gate for the saturation + hue adjust. 0.0 =
// brightness-only (the shipped behaviour); 1.0 = also apply sat/hue.
// The full sat/hue block is gated by uTerrainModulationEnabled *
// uTerrainModSatHue, so it is a strict no-op whenever the master gate
// is off — and when the master is on it can be forced off for an
// on-GPU A/B of brightness-only vs full. Default 1.0 when
// ?terrainMod=on so the full effect shows by default (see wiring).
uniform float uTerrainModSatHue;
// Perf D1 — water-modulation sines folded to vertex rate.
//   .x = sin(uTime * 0.3)   tint breath (constant per draw, so this is
//                           literally the same value at every vertex
//                           and survives linear interpolation exactly)
//   .y = 2026-07-31 (water-fix) the APPLIED swell height in metres at this
//                           fragment (0.0 off water). A crest/trough signal
//                           matched to the real displaced geometry; the old
//                           raw-sine export no longer exists because the
//                           swell is now lattice-locked (see the vertex
//                           stage's waterSwellLattice).
in vec2 vWaveModulation;

out vec4 fragColor;

// 2026-05-30 — logarithmic depth buffer participation (see the matching
// block in TERRAIN_VERTEX_GLSL for the full rationale). Writing gl_FragDepth
// with the SAME log encoding three.js' built-in materials use is what lets
// terrain correctly occlude buildings/EnvCells in the shared depth buffer.
// logDepthBufFC is a renderer-supplied built-in uniform (set every frame
// from camera.far), present on this program because the log-depth define
// is set — no entry needed in the material uniforms map.
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
uniform float logDepthBufFC;
in float vFragDepth;
in float vIsPerspective;
#endif

// Map terrain code (0..32) → atlas UV at the given cell-local UV.
// Retail terrain codes 0..32 are individual layers of a sampler2DArray.
// cellUv (range [0,1]) is the intra-cell UV; the layer index is the
// code itself -- DataArrayTexture clamps integer layer selection so no
// neighbour-tile bleed at any mip level.
//
// T1 (2026-05-29): apply the retail base tex_tiling (== 2 for all 33 types)
// as fract(cellUv * tiling) — TexMerge::TileCSI replicates the source N×N
// into the merged tile (acclient.c:365513), so the merged texture sampled at
// UV∈[0,1] shows N×N copies. fract() wraps WITHIN the ClampToEdge atlas layer
// (a raw *tiling would clamp the >1 UVs and cut the extra tiles off). tiling 1
// (the LUT fallback) makes this an exact no-op → fail-soft to the prior 1×.
vec3 atlasUvFor(int code, vec2 cellUv) {
  float tiling = float(uBaseTexTiling[clamp(code, 0, 32)]);
  return vec3(fract(cellUv * tiling), float(code));
}

// T1 — rotate an intra-cell UV ([0,1]^2) by 90 deg steps around its centre, so
// a single authored alpha mask covers all four corner orientations (the retail
// LandDefs::Rotation the selection core resolves per overlay).
//
// The SIGN is now pinned numerically, not by eye. ImgTex::MergeTexture
// (acclient.c:365632) reads the mask for dest pixel (row r, col c) at
// rot0 a[r][c], rot1 a[c][w-1-r], rot2 a[h-1-r][w-1-c], rot3 a[h-1-c][r].
// Authored row 0 = NORTH and col 0 = WEST (forced: the corner masks are dark in
// the row0/col0 quadrant and carry TCode 8, and TCode bit 8 = NW per
// GetCellRotation + BuildTCodes). Substituting the cell frame
// (cellUv.x = east, cellUv.y = north, so r = 1 - y and c = x) gives the mask
// texel each rot must read as (u = col, v = row):
//   rot0 (x, 1-y)   rot1 (y, x)   rot2 (1-x, y)   rot3 (1-y, 1-x)
// which is exactly maskUvFor()'s flip of the branches below. The dark corner
// therefore walks NW -> SW -> SE -> NE per step, matching the TCode rol4 cycle
// 8 -> 1 -> 2 -> 4.
//
// uMaskRotFlip / ?texMergeRot=flip restore the pre-fix (N-S mirrored) sign for
// live A/B; default 0 is the retail-exact one.
uniform float uMaskRotFlip;
vec2 rotateCellUv(vec2 uv, int rot) {
  if (uMaskRotFlip > 0.5) {
    if (rot == 1) rot = 3;
    else if (rot == 3) rot = 1;
  }
  vec2 c = uv - 0.5;
  if (rot == 1) c = vec2(c.y, -c.x);        // 90
  else if (rot == 2) c = vec2(-c.x, -c.y);  // 180
  else if (rot == 3) c = vec2(-c.y, c.x);   // 270
  return c + 0.5;
}

// T1 — cell UV to alpha-mask texture UV for a given rotation. The mask array is
// a DataArrayTexture uploaded row-major with no flipY (adapter.js
// buildAlphaMaskArrayBytes copies source rows in order), so texture v = 0 is
// authored row 0 = NORTH, while cellUv.y = 0 is the cell's SOUTH edge. The
// 1.0 - y here is that N-S reflection; without it the sampling frame is a
// vertical mirror of the authored frame, which used to cancel against the
// N-S-reversed pcode corner gather in build_terrain_merge_data. Both were
// fixed together -- reintroducing either alone mirrors every overlay.
vec2 maskUvFor(vec2 cellUv, int rot) {
  vec2 m = rotateCellUv(cellUv, rot);
  return vec2(m.x, 1.0 - m.y);
}

// 2026-07-31 (water-fix) — THE single water-code test for the whole fragment
// stage. Every water site (UV scroll, POM bypass, TexMerge composite, blue
// tint, surface sheen) now calls this, so ?strictWaterCodes and any future
// region-aware mask edit move all of them together and none can silently
// drift onto a hardcoded range again (the pre-F12-5 bug). Code 32 is the road
// layer and is never water, so the < 32 bound is also the mask's domain.
bool isWaterCode(int c) {
  return c >= 0 && c < 32 && (uWaterSurfaceCodeMask & (1 << c)) != 0;
}

// Wave 1B — THE single sand-code test for the fragment stage, exactly the same
// shape as isWaterCode above and reading a mask built from terrain_families.js
// FAM_SAND. Code 32 is the road layer and is never sand.
bool isSandCode(int c) {
  return c >= 0 && c < 32 && (uSandSparkleCodeMask & (1 << c)) != 0;
}

// Wave 2A — THE single snow test and THE single ice test for the fragment
// stage, both the same shape as isWaterCode/isSandCode above and both reading a
// mask built from terrain_families.js. isIceCode's mask is a STRICT SUBSET of
// isSnowCode's (2/27 vs 2/15/27): snow sparkles, ice additionally goes hard and
// wet. Code 32 is the road layer and is never snow or ice.
bool isSnowCode(int c) {
  return c >= 0 && c < 32 && (uSnowSparkleCodeMask & (1 << c)) != 0;
}
bool isIceCode(int c) {
  return c >= 0 && c < 32 && (uIceCodeMask & (1 << c)) != 0;
}

// Wave 2B — the single VOLCANO / OBSIDIAN code tests for the fragment stage,
// same shape as isWaterCode / isSandCode above and reading masks built from
// terrain_families.js FAM_VOLCANO and the retail ObsidianPlain enum value.
// Code 32 is the road layer and is never volcanic.
bool isVolcanoCode(int c) {
  return c >= 0 && c < 32 && (uVolcanoCodeMask & (1 << c)) != 0;
}
bool isObsidianCode(int c) {
  return c >= 0 && c < 32 && (uObsidianCodeMask & (1 << c)) != 0;
}

// Wave 3B — the DIRT / CLAY code tests for the fragment stage, same shape as
// every mask test above and reading masks built from terrain_families.js
// FAM_DIRT and its sub-variant table (clay = Argila 24). isClayCode's mask is a
// STRICT SUBSET of isDirtCode's, exactly as isIceCode's is of isSnowCode's: all
// dirt takes a print and goes dark when wet, only clay goes red and slick.
// Code 32 is the road layer and is never dirt.
bool isDirtCode(int c) {
  return c >= 0 && c < 32 && (uDirtCodeMask & (1 << c)) != 0;
}
bool isClayCode(int c) {
  return c >= 0 && c < 32 && (uClayCodeMask & (1 << c)) != 0;
}

int vertexTypeAt(int iu, int iv) {
  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);
}

// Per-vertex road bit, packed into G channel as roadCode*64. Any nonzero
// (i.e. roadCode > 0) returns 1.0, else 0.0. Bilinear-blended across the
// 4 cell corners in the main body to get a smooth road-presence mask.
float vertexRoadAt(int iu, int iv) {
  return texelFetch(uVertexTypes, ivec2(iu, iv), 0).g > 0.125 ? 1.0 : 0.0;
}

// 2026-07-02 — point-to-segment distance (metres, cell frame) for the
// analytic road lane painter in main(). No backticks in comments here.
float distToSegment(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  return length(p - (a + ab * t));
}

// Wave 2.A — sample the 32×1 terrain palette LUT at the given code.
// Codes 0..31 clamp to the palette length; the 32-tile (road) layer
// has no palette entry and falls through to (1,1,1) so road colour
// stays untinted in the modulation downstream. texelFetch with the
// integer pixel coord bypasses the sampler's filter so neighbouring
// codes never bleed into one another.
vec3 paletteFor(int code) {
  if (code < 0 || code > 31) return vec3(1.0);
  return texelFetch(uTerrainPalette, ivec2(code, 0), 0).rgb;
}

// R1.A 2026-05-28 — RGB <-> HSV conversion for the TerrainTex
// saturation + hue modulation. Branch-free formulation (Sam Hocevar
// style) so it stays cheap on the per-pixel terrain path. H is in
// [0,1) (circular), S and V in [0,1]. NOTE: no backticks anywhere in
// these comments -- the esbuild template-string path + Firefox reject
// a stray backtick inside a GLSL string (it has bitten this file).
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// R1.A 2026-05-28 — apply the per-vertex saturation + hue factors to a
// lit RGB colour. INTERPRETATION (best-guess, retail ships no
// apply-path -- this is the ONE spot to retune after the 1070
// eye-test): treat S as a multiplier (S *= vSaturate) and H as a
// circular multiplier (H = fract(H * vHue)). gate is the product
// uTerrainModulationEnabled * uTerrainModSatHue, so this is a strict
// no-op whenever either gate is 0.0 (we early-out so RGB stays
// bit-identical -- HSV round-trip is not perfectly lossless, so the
// branch is load-bearing for the default-off guarantee).
vec3 applyTerrainSatHue(vec3 rgb, float gate) {
  if (gate < 0.5) return rgb;
  vec3 hsv = rgb2hsv(rgb);
  hsv.x = fract(hsv.x * vHue);   // hue: circular multiplier, wrapped
  hsv.y = clamp(hsv.y * vSaturate, 0.0, 1.0); // saturation: multiplier
  return hsv2rgb(hsv);
}

// R4.a 2026-05-28 — retail TexMerge mid-point alpha rounding.
// ImgTex::MergeTexture (acclient.c:365787-365798) reads the A8 mask byte
// a and, before the integer blend (a*dst + (256-a)*src) >> 8, nudges the
// upper half UP by one: when 0 < a < 0xFF and a > 0x80, a++. This biases
// the quantized blend toward the dominant layer at the threshold, which
// firms up the splotchy overlay edges by ~1/256 rather than leaving them
// dead-centre. We sample the mask as a normalized float (overlay weight,
// the port convention -- see lib.rs:951 mix(base, overlay, mask.r)), so
// the rounding is applied on the reconstructed 0..255 byte and re-
// normalized. Gated by gate (uTexMergeEnabled * uTexMergeAlphaRound) so
// it is a strict no-op when off: an unrounded float passes through
// untouched, preserving the shipped composite when the sub-flag is 0.
// NOTE: no backticks in this comment -- esbuild + Firefox reject a stray
// backtick inside a GLSL string (it has bitten this file).
float roundMergeAlpha(float alpha, float gate) {
  if (gate < 0.5) return alpha;
  // Reconstruct the integer mask byte the float came from.
  int a = int(alpha * 255.0 + 0.5);
  // Retail guard: only the strict interior (0 < a < 0xFF) is rounded; the
  // 0x00 / 0xFF extremes are left exact so a fully-covered or fully-empty
  // texel never shifts.
  if (a > 0 && a < 255 && a > 128) {
    a += 1;
  }
  return float(a) / 255.0;
}

void main() {
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
  // Matches the built-in logdepthbuf_fragment chunk. Placed first so the
  // depth write is unconditional for every drawn fragment. Perspective
  // camera → log2 encoding; ortho (radar) → pass through gl_FragCoord.z.
  gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
#endif
  // vGridUv is [0, 8] across the 192 m LB. Bilinear 4-corner blend.
  vec2 grid = vGridUv;
  int iu = int(floor(grid.x));
  int iv = int(floor(grid.y));
  iu = clamp(iu, 0, 7);
  iv = clamp(iv, 0, 7);
  float fu = grid.x - float(iu);
  float fv = grid.y - float(iv);
  vec2 cellUv = vec2(fu, fv);

  // Phase 2.2 — water UV scroll. Apply a per-frame offset to the
  // intra-cell UV so the water texture pattern drifts. The scroll is
  // small enough to stay within a tile each frame; fract() wraps
  // cleanly inside the per-tile slot via atlasUvFor's modular indexing
  // because the slot only sees the fractional part.
  //
  // 2026-06-21 — dropped the "and vIsWater == 1" gate. vIsWater is FLAT (the
  // triangle's provoking vertex), so on a shoreline cell whose provoking
  // vertex is land it was 0 → the cell's water corners stayed STATIC even
  // though open-water neighbours scrolled, producing a hard per-cell
  // flow/no-flow block right at the waterline (user reported water flowing
  // in neighbouring blocks but not the one underfoot). The per-corner selection below
  // already scrolls only the water-typed corners, so computing the drifted UV
  // unconditionally (still under the displacement quality gate) makes the flow
  // bilinear-continuous across the land/water seam — no provoking-vertex block.
  // 2026-07-08 — gate the scroll on uWaterScrollEnabled (default 1), NOT
  // uDisplacementEnabled. The scroll is a per-pixel fragment effect with no
  // geometry dependency, so coupling it to the subdiv/displacement LOD froze
  // open water on the batched ring + distance>=2 LODs + low/mid quality. The
  // per-corner uWaterCodeMask test below still restricts the scrolled UV to
  // water corners, so land stays static regardless.
  // 2026-07-31 (water-fix) — the scrolled UV is now derived BELOW, after the
  // POM march, so it inherits the same parallax-offset cellUv every other
  // sampler reads. Deriving it here (as it used to be) left the water tile
  // off-registration against albedo / nra / masks whenever POM was live.

  int t00 = vertexTypeAt(iu,     iv    );  // SW
  int t10 = vertexTypeAt(iu + 1, iv    );  // SE
  int t01 = vertexTypeAt(iu, iv + 1);  // NW
  int t11 = vertexTypeAt(iu + 1, iv + 1);  // NE

  // 2026-07-31 (water-fix) — per-corner water classification, resolved ONCE
  // and reused by the POM bypass, the scroll UV selection, the TexMerge
  // composite, the tint and the sheen.
  bool wc00 = isWaterCode(t00);
  bool wc10 = isWaterCode(t10);
  bool wc01 = isWaterCode(t01);
  bool wc11 = isWaterCode(t11);
  bool cellTouchesWater = wc00 || wc10 || wc01 || wc11;

  // Wave 2A — per-cell SNOW presence, resolved here for exactly the reason
  // cellTouchesWater is: the FOOTPRINT DENT has to run BEFORE the albedo taps
  // (it shifts cellUv, like POM), and the smooth bilinear snowW is not computed
  // until after them. A binary cell test is the right gate for a UV shift (the
  // dent either applies to this cell's sampling or it does not); the SMOOTH
  // fraction still governs the darkening amplitude further down, so the print
  // fades across a snow/rock boundary instead of stopping at a cell edge.
  bool cellTouchesSnow = isSnowCode(t00) || isSnowCode(t10)
                      || isSnowCode(t01) || isSnowCode(t11);

  // Wave 3B — per-cell DIRT presence, resolved here for exactly the reason
  // cellTouchesSnow is: the MUD PRINT DENT has to run BEFORE the albedo taps
  // (it shifts cellUv, like POM), and the smooth bilinear dirtW is not computed
  // until after them. A binary cell test is the right gate for a UV shift; the
  // SMOOTH fraction still governs the darkening and the sheen further down, so
  // a print running off mud onto grass fades instead of ending at a cell edge.
  bool cellTouchesDirt = isDirtCode(t00) || isDirtCode(t10)
                      || isDirtCode(t01) || isDirtCode(t11);

  // T4 POM -- computed here (before every texture sample) so the offset
  // cellUv feeds the whole pipeline. Nearest-corner layer only (same
  // single-sample convention as the detail layers); constant-height
  // retail layers self-disable (alpha 255 everywhere -> march exits at
  // step 0 with zero offset).
  // 2026-07-31 (water-fix) — WATER BYPASSES POM. POM offsets cellUv by
  // marching a height field sampled from the layer's own uAtlas alpha. On a
  // scrolling water tile that is wrong twice over: the offset is derived from
  // the UNSCROLLED cellUv (so relief and texels slide against each other),
  // and a liquid surface has no parallax relief to begin with — the retail
  // RGBA8 water layers self-disable (alpha 255 -> zero offset) but the BC7
  // arm derives height from the retail albedo, so on ?terrainBc7=on water
  // WOULD have marched and made the flow swim. Bypassing on any
  // water-touching cell keeps both arms identical here and is a strict
  // no-op wherever water is absent.
  if (uPomEnabled > 0.5 && vViewDepth < uPomFadeEnd && !cellTouchesWater) {
    float pw00 = (1.0 - fu) * (1.0 - fv);
    float pw10 = fu * (1.0 - fv);
    float pw01 = (1.0 - fu) * fv;
    float pw11 = fu * fv;
    int pomCode = t00; float pnw = pw00;
    if (pw10 > pnw) { pnw = pw10; pomCode = t10; }
    if (pw01 > pnw) { pnw = pw01; pomCode = t01; }
    if (pw11 > pnw) { pnw = pw11; pomCode = t11; }
    pomCode = clamp(pomCode, 0, 32);
    // world view -> AC tangent frame: world(x,y,z) = ac(x,z,-y), so
    // ac = (w.x, -w.z, w.y). Only march when looking meaningfully down
    // at the surface (grazing rays explode the offset).
    vec3 vw = normalize(vWorldPos - cameraPosition);
    vec3 vt = vec3(vw.x, -vw.z, vw.y);
    if (vt.z < -0.15) {
      float pomFade = 1.0 - clamp(
        (vViewDepth - uPomFadeStart) / max(uPomFadeEnd - uPomFadeStart, 1e-3),
        0.0, 1.0);
      float tiling = float(uBaseTexTiling[pomCode]);
      vec2 stepUv = (vt.xy / max(-vt.z, 0.3)) * (uPomScale * pomFade) * 0.125;
      vec2 uvOff = vec2(0.0);
      float layerH = 1.0;
      for (int i = 0; i < 8; i++) {
        float mapH = texture(uAtlas,
          vec3(fract((cellUv + uvOff) * tiling), float(pomCode))).a;
        if (mapH >= layerH) break;
        layerH -= 0.125;
        uvOff += stepUv;
      }
      cellUv += uvOff;
    }
  }

  // === Wave 2A — SNOW FOOTPRINTS (terrain-VFX plan §3.4 item 3) ===========
  // The shared trail map (scene3d/trail_map.js, wave 0B) read as a small
  // downward displacement plus a darkening. Prints persist because the map's
  // recovery is a URL knob (?terrainTrailFade) that snow asks to be set long --
  // the map is FAMILY-AGNOSTIC and nobody allocates a second one.
  //
  // WHERE IT SITS AND WHY (plan §2.7.3 point 1):
  //   - IMMEDIATELY AFTER the POM march, so the trail is sampled at the
  //     PARALLAX-CORRECTED surface point (the post-march cellUv offset is added
  //     back to the world position in cell units x 24 m). Sampling at the raw
  //     point would slide the print against the relief it is denting -- exactly
  //     the registration bug the 07-31 water fix closed (plan §8 risk 14).
  //   - The DENT then shifts cellUv AGAIN, along the same view-parallax vector
  //     POM marches, so every downstream sampler (albedo, nra, masks, TexMerge,
  //     detail) rides it as one -- which is the whole reason the water fix moved
  //     the scroll derivation below the march. Amplitude is uSnowPrintDepth,
  //     deliberately a third of uPomScale so the two never fight.
  //   - It HONOURS the cellTouchesWater bypass: POM does not run there, and a
  //     shoreline snow cell must not dent through the water surface.
  //   - MID-TIER DEGRADE (plan §2.7.3 point 4): the dent is inside a
  //     uPomEnabled test, so with POM off snowPrint is still computed and the
  //     print degrades to DARKENING ONLY -- a coherent lesser effect, not a
  //     broken one. snowPrint stays in scope for that darkening at the end.
  float snowPrint = 0.0;
  if (uSnowPrintEnabled > 0.5 && uSnowTrailEnabled > 0.5
      && cellTouchesSnow && !cellTouchesWater) {
    // world(x,y,z) = ac(x,z,-y), so the AC ground point is (w.x, -w.z).
    vec2 printShift = (cellUv - vec2(fu, fv)) * 24.0;
    vec2 printXy = vec2(vWorldPos.x, -vWorldPos.z) + printShift;
    vec2 trailUv = (printXy - uSnowTrailCenter) / (2.0 * uSnowTrailRadius) + 0.5;
    // Outside the map footprint there is NO trail -- never a clamped smear
    // (the trail_map.js contract).
    if (trailUv.x >= 0.0 && trailUv.x <= 1.0 && trailUv.y >= 0.0 && trailUv.y <= 1.0) {
      snowPrint = clamp(texture(uSnowTrailMap, trailUv).r, 0.0, 1.0);
    }
    if (snowPrint > 0.0 && uPomEnabled > 0.5 && vViewDepth < uPomFadeEnd) {
      vec3 pvw = normalize(vWorldPos - cameraPosition);
      vec3 pvt = vec3(pvw.x, -pvw.z, pvw.y);
      if (pvt.z < -0.15) {
        cellUv += (pvt.xy / max(-pvt.z, 0.3)) * (uSnowPrintDepth * snowPrint);
      }
    }
  }

  // === Wave 3B — MUD PRINTS (terrain-VFX plan §3.7 item 2) ================
  // The SNOW PRINT's twin on FAM_DIRT ground, reading the SAME shared trail map
  // through the SAME sampler (see the uniform block for why the sampler carries
  // a snow name and why there is no second one), with mud's amplitudes.
  //
  // WHERE IT SITS AND WHY (plan §2.7.3 point 1) — identical reasoning to snow:
  //   - IMMEDIATELY AFTER the POM march (and after the snow dent, so the two
  //     compose additively on the pathological cell that is both snowy and
  //     dirty), so the trail is sampled at the PARALLAX-CORRECTED surface point.
  //     Sampling at the raw point would slide the print against the relief it is
  //     denting -- plan §8 risk 14.
  //   - The DENT then shifts cellUv AGAIN along the same view-parallax vector,
  //     so every downstream sampler rides it as one.
  //   - It HONOURS the cellTouchesWater bypass: POM does not run there, and a
  //     shoreline mud cell must not dent through the water surface.
  //   - MID-TIER DEGRADE (plan §2.7.3 point 4): the dent is inside a uPomEnabled
  //     test, so with POM off mudPrint is still computed and the print degrades
  //     to DARKENING ONLY -- a coherent lesser effect. mudPrint stays in scope
  //     for that darkening at the end.
  //
  // THE RAIN DEPENDENCE (plan §3.7 items 2 + 4) rides AMPLITUDE, not the map's
  // fade: the shared fade is global and mud cannot have its own, so a dry print
  // is scaled to uMudPrintDryScale and a soaked one to full. The stamp side
  // scales the same way, so the two compose into "wet mud keeps a print, dry
  // dirt barely takes one" without a second render target or a second constant.
  float mudPrint = 0.0;
  float mudWetAmt = 0.0;
  if (uMudPrintEnabled > 0.5 && uMudTrailEnabled > 0.5
      && cellTouchesDirt && !cellTouchesWater) {
    // world(x,y,z) = ac(x,z,-y), so the AC ground point is (w.x, -w.z).
    vec2 mudShift = (cellUv - vec2(fu, fv)) * 24.0;
    vec2 mudXy = vec2(vWorldPos.x, -vWorldPos.z) + mudShift;
    vec2 mudUv = (mudXy - uSnowTrailCenter) / (2.0 * uSnowTrailRadius) + 0.5;
    // Outside the map footprint there is NO trail -- never a clamped smear
    // (the trail_map.js contract).
    if (mudUv.x >= 0.0 && mudUv.x <= 1.0 && mudUv.y >= 0.0 && mudUv.y <= 1.0) {
      mudPrint = clamp(texture(uSnowTrailMap, mudUv).r, 0.0, 1.0);
    }
    mudPrint *= mix(uMudPrintDryScale, 1.0, clamp(uMudWetness, 0.0, 1.0));
    if (mudPrint > 0.0 && uPomEnabled > 0.5 && vViewDepth < uPomFadeEnd) {
      vec3 mvw = normalize(vWorldPos - cameraPosition);
      vec3 mvt = vec3(mvw.x, -mvw.z, mvw.y);
      if (mvt.z < -0.15) {
        cellUv += (mvt.xy / max(-mvt.z, 0.3)) * (uMudPrintDepth * mudPrint);
      }
    }
  }

  // Phase 2.2 — water UV scroll. Apply a per-frame offset to the intra-cell
  // UV so the water texture pattern drifts. fract() keeps it inside the cell;
  // atlasUvFor's fract(uv * tex_tiling) then wraps cleanly inside the atlas
  // layer because tex_tiling is an INTEGER (retail 2) — the wrap point of the
  // outer fract lands on a wrap point of the inner one, so there is no seam.
  //
  // 2026-06-21 — dropped the "and vIsWater == 1" gate. vIsWater is FLAT (the
  // triangle's provoking vertex), so on a shoreline cell whose provoking
  // vertex is land it was 0 -> the cell's water corners stayed STATIC even
  // though open-water neighbours scrolled, producing a hard per-cell
  // flow/no-flow block right at the waterline. The per-corner selection below
  // already scrolls only water-typed corners, so computing the drifted UV
  // unconditionally makes the flow bilinear-continuous across the seam.
  // 2026-07-31 (water-fix) — moved here (post-POM) so it rides the same
  // parallax-adjusted cellUv every other sampler uses.
  vec2 waterCellUv = cellUv;
  if (uWaterScrollEnabled > 0.5) {
    waterCellUv = fract(cellUv + vec2(uTime * 0.05, uTime * 0.02));
  }

  // Per-corner cellUv: water-typed corners get the scrolled UV, others
  // stay on the static path. This keeps the blend across the water /
  // land seam continuous because non-water corners contribute their
  // unscrolled tile while the water corners drift.
  //
  // F12-5 — was a hardcoded "t >= 16 && t <= 23 && t != 21" range (=
  // {16-20,22,23}); now reads the shared uWaterCodeMask (via isWaterCode)
  // so this scroll site, the displacement mask, the TexMerge composite, the
  // tint and the sheen all use ONE water set.
  vec2 uv00 = wc00 ? waterCellUv : cellUv;
  vec2 uv10 = wc10 ? waterCellUv : cellUv;
  vec2 uv01 = wc01 ? waterCellUv : cellUv;
  vec2 uv11 = wc11 ? waterCellUv : cellUv;

  vec3 c00 = texture(uAtlas, atlasUvFor(clamp(t00, 0, 32), uv00)).rgb;
  vec3 c10 = texture(uAtlas, atlasUvFor(clamp(t10, 0, 32), uv10)).rgb;
  vec3 c01 = texture(uAtlas, atlasUvFor(clamp(t01, 0, 32), uv01)).rgb;
  vec3 c11 = texture(uAtlas, atlasUvFor(clamp(t11, 0, 32), uv11)).rgb;

  float w00 = (1.0 - fu) * (1.0 - fv);
  float w10 = fu * (1.0 - fv);
  float w01 = (1.0 - fu) * fv;
  float w11 = fu * fv;

  // 2026-07-31 (water-fix) — bilinear WATER FRACTION for this fragment,
  // computed once here and reused by the tint and the sheen. Weighting by
  // the same 4-corner weights the texture blend uses is what makes the water
  // treatments fade in across the land/water seam instead of switching on a
  // per-cell (flat provoking-vertex) or per-half-cell (nearest-corner) step.
  float waterW = clamp(
    (wc00 ? w00 : 0.0) + (wc10 ? w10 : 0.0) +
    (wc01 ? w01 : 0.0) + (wc11 ? w11 : 0.0), 0.0, 1.0);

  // Wave 1B — bilinear SAND FRACTION, computed with the SAME four corner
  // weights for the same reason the water fraction is: the grain sparkle then
  // fades in across a sand/grass or sand/rock boundary instead of switching on
  // a per-half-cell nearest-corner step (plan §8 risk 2 — a 24 m nearest-vertex
  // quantisation draws visible square patches). Consumed by the SAND SPARKLE
  // block at the end of main().
  float sandW = clamp(
    (isSandCode(t00) ? w00 : 0.0) + (isSandCode(t10) ? w10 : 0.0) +
    (isSandCode(t01) ? w01 : 0.0) + (isSandCode(t11) ? w11 : 0.0), 0.0, 1.0);

  // Wave 2A — bilinear SNOW and ICE fractions, same four corner weights again
  // and for the same reason: the sparkle, the print darkening and the ice
  // treatment all fade in across a boundary rather than switching at a cell
  // midline. iceW is a STRICT SUBSET of snowW by construction (isIceCode's mask
  // is a subset of isSnowCode's), so a BlueIce/Snow seam gets the sparkle
  // continuously while only the ice half goes hard and wet.
  float snowW = clamp(
    (isSnowCode(t00) ? w00 : 0.0) + (isSnowCode(t10) ? w10 : 0.0) +
    (isSnowCode(t01) ? w01 : 0.0) + (isSnowCode(t11) ? w11 : 0.0), 0.0, 1.0);
  float iceW = clamp(
    (isIceCode(t00) ? w00 : 0.0) + (isIceCode(t10) ? w10 : 0.0) +
    (isIceCode(t01) ? w01 : 0.0) + (isIceCode(t11) ? w11 : 0.0), 0.0, 1.0);

  // Wave 2B — bilinear VOLCANO and OBSIDIAN fractions, computed with the SAME
  // four corner weights, for the same reason the water and sand fractions are:
  // the crack glow and the obsidian specular then feather across a type
  // boundary instead of switching on a per-half-cell nearest-corner step (plan
  // §8 risk 2). Consumed by the VOLCANO CRACK GLOW block further down main().
  float volcW = clamp(
    (isVolcanoCode(t00) ? w00 : 0.0) + (isVolcanoCode(t10) ? w10 : 0.0) +
    (isVolcanoCode(t01) ? w01 : 0.0) + (isVolcanoCode(t11) ? w11 : 0.0), 0.0, 1.0);
  float obsidianW = clamp(
    (isObsidianCode(t00) ? w00 : 0.0) + (isObsidianCode(t10) ? w10 : 0.0) +
    (isObsidianCode(t01) ? w01 : 0.0) + (isObsidianCode(t11) ? w11 : 0.0), 0.0, 1.0);

  // Wave 3B — bilinear DIRT and CLAY fractions, computed with the SAME four
  // corner weights, for the same reason every fraction above is: the print
  // darkening and the wet-mud treatment then feather across a type boundary
  // instead of switching on a per-half-cell nearest-corner step (plan §8
  // risk 2). clayW is a STRICT SUBSET of dirtW by construction (isClayCode's
  // mask is a subset of isDirtCode's), so an Argila/PatchyDirt seam darkens
  // continuously while only the clay half goes red and slick. Consumed by the
  // MUD PRINT DARKENING and WET MUD blocks further down main().
  float dirtW = clamp(
    (isDirtCode(t00) ? w00 : 0.0) + (isDirtCode(t10) ? w10 : 0.0) +
    (isDirtCode(t01) ? w01 : 0.0) + (isDirtCode(t11) ? w11 : 0.0), 0.0, 1.0);
  float clayW = clamp(
    (isClayCode(t00) ? w00 : 0.0) + (isClayCode(t10) ? w10 : 0.0) +
    (isClayCode(t01) ? w01 : 0.0) + (isClayCode(t11) ? w11 : 0.0), 0.0, 1.0);

  // Skip stochastic blending when all four corners are the same terrain type:
  // there is no boundary to draw, and picking between identical textures only
  // sampled at slightly different scrolled UVs (water + lava cells) made the
  // animated water look grainy. Uniform cells fall back to plain bilinear.
  bool allSameType = (t00 == t10) && (t00 == t01) && (t00 == t11);

  vec3 result;
  if (uPaintMode > 0.5 && !allSameType) {
    // Stochastic per-vertex winner-take-all (2026-06-21, revised 2026-06-22).
    // The 9x9 vertex grid carries 1 terrain-type byte per vertex (5.27M total
    // across the world); the data IS per-vertex. The default bilinear average
    // mudded distinct types together because the 4 corner colours were just
    // linearly mixed by position. Here each fragment perturbs the four
    // bilinear corner weights with a unique noise value and selects the
    // SINGLE winning corner — distinct textures, no muddying. In the middle
    // of a single-type region each corner's weight is ~1 so noise cannot flip
    // it; only near the cell diagonals (weights converge to ~0.5) does noise
    // decide — that is where the organic, noise-shaped boundary appears.
    //
    // Sample the noise at WORLD-SPACE position (vWorldPos.xy in metres), NOT
    // at vGridUv which is LB-LOCAL [0..8] and resets every 192 m, producing a
    // visible LB-grid pattern. World-space sampling gives one continuous noise
    // field across all 5.27M vertices — the user-reported "lines, slightly
    // different colors" were the 192-m LB-grid repeat of the noise pattern.
    float NOISE_FREQ = uPaintNoiseFreq / 24.0;     // freq in 1/m
    float NOISE_STRENGTH = uPaintNoiseStrength;
    vec2 np = vWorldPos.xy * NOISE_FREQ;
    // Candidate H (2026-06-22): pick the perturbation noise source.
    // uWarpAmp == 0 -> legacy per-pixel sin-hash (byte-identical to the shipped
    // winner). uWarpAmp > 0 -> spatially-coherent value noise sampled through a
    // domain warp: organic, no sin-dot banding, and (being continuous) it does
    // not sit as a static line grid over scrolling water. The 4 corner offsets
    // are spread across separate lattice cells so the corners stay decorrelated
    // while each remains individually smooth.
    float n00, n10, n01, n11;
    if (uWarpAmp > 0.0) {
      vec2 warp = vec2(
        fragValueNoise2D(np * uWarpFreq),
        fragValueNoise2D(np * uWarpFreq + vec2(19.3, 7.7))
      ) * uWarpAmp;
      vec2 wp = np + warp;
      n00 = fragValueNoise2D(wp + vec2(0.0, 0.0));
      n10 = fragValueNoise2D(wp + vec2(11.3, 4.1));
      n01 = fragValueNoise2D(wp + vec2(5.7, 19.2));
      n11 = fragValueNoise2D(wp + vec2(23.4, 13.8));
    } else {
      n00 = fragHash21(np + vec2(0.317, 0.731)) - 0.5;
      n10 = fragHash21(np + vec2(0.443, 0.119)) - 0.5;
      n01 = fragHash21(np + vec2(0.561, 0.917)) - 0.5;
      n11 = fragHash21(np + vec2(0.682, 0.379)) - 0.5;
    }
    float pw00 = w00 + n00 * NOISE_STRENGTH;
    float pw10 = w10 + n10 * NOISE_STRENGTH;
    float pw01 = w01 + n01 * NOISE_STRENGTH;
    float pw11 = w11 + n11 * NOISE_STRENGTH;
    if (uWinnerSoftness > 0.0) {
      // Soft top-two blend (Candidate D half): cross-fade between the two
      // highest-perturbed-weight corner colours across a band of width
      // uWinnerSoftness (in weight units). Away from a boundary the winner
      // dominates (pure distinct texture); at the boundary it is a 2-way blend
      // of the two adjacent types only (distinct, NOT a muddy 4-way average).
      // No arrays / dynamic indexing (ANGLE D3D11-safe): single-pass top-two.
      float w1 = -1e9; vec3 col1 = c00;
      float w2 = -1e9; vec3 col2 = c00;
      if (pw00 > w1) { w2 = w1; col2 = col1; w1 = pw00; col1 = c00; }
      else if (pw00 > w2) { w2 = pw00; col2 = c00; }
      if (pw10 > w1) { w2 = w1; col2 = col1; w1 = pw10; col1 = c10; }
      else if (pw10 > w2) { w2 = pw10; col2 = c10; }
      if (pw01 > w1) { w2 = w1; col2 = col1; w1 = pw01; col1 = c01; }
      else if (pw01 > w2) { w2 = pw01; col2 = c01; }
      if (pw11 > w1) { w2 = w1; col2 = col1; w1 = pw11; col1 = c11; }
      else if (pw11 > w2) { w2 = pw11; col2 = c11; }
      float gap = w1 - w2;
      float t = clamp(0.5 + 0.5 * gap / max(uWinnerSoftness, 1e-4), 0.0, 1.0);
      result = mix(col2, col1, t);
    } else {
      float maxW = pw00; result = c00;
      if (pw10 > maxW) { maxW = pw10; result = c10; }
      if (pw01 > maxW) { maxW = pw01; result = c01; }
      if (pw11 > maxW) { maxW = pw11; result = c11; }
    }
  } else {
    // Uniform-type cell OR paintMode off: plain bilinear (which for a uniform
    // cell is just the same texture, slightly averaged for the per-corner UVs).
    result = c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11;
  }

  // T1 — retail TexMerge composite (opt-in, overrides the bilinear blend
  // above). Per-cell merge data lives in uMergeData (48×8: 8 EW cells × 6
  // slots, row = NS cell iv). Slot 0 is the base terrain tile; slots 1..3
  // are alpha-masked terrain overlays; slots 4..5 are alpha-masked ROAD
  // overlays (atlas layer 32, same [layer,mask,rotation,valid] format —
  // pack_merge_record, terrain_merge.rs:417). T2 (2026-05-29) extends the
  // loop to s<6 so the authored road masks composite here; the legacy
  // bilinear road painter (uRoadEnabled block below) is gated OFF whenever
  // this path is active so roads aren't double-blended.
  if (uTexMergeEnabled > 0.5) {
    int colBase = iu * 6;
    vec4 baseTexel = texelFetch(uMergeData, ivec2(colBase, iv), 0);
    int baseLayer = int(baseTexel.r * 255.0 + 0.5);
    // 2026-07-31 (water-fix) — THE headline bug. This composite REPLACES the
    // bilinear result wholesale (result = merged, below) and it sampled every
    // slot at the unscrolled cellUv — so with ?texMerge on (the DEFAULT since
    // 2026-07-02) the water UV scroll was dead world-wide. Live proof before
    // the fix: freezing uDisplacementEnabled left open sea at meanAbsDiff
    // 0.42 / 0% pixels changed over 5 s with texMerge on, and 2.50 / 45.7%
    // with texMerge forced off. Each slot now picks the scrolled UV iff ITS
    // OWN atlas layer is a water code, which is also what keeps a water
    // overlay flowing over a static land base at a blended cell border.
    vec3 merged = texture(uAtlas, atlasUvFor(clamp(baseLayer, 0, 32),
      isWaterCode(baseLayer) ? waterCellUv : cellUv)).rgb;
    // R4.a 2026-05-28 — explicit all-road corner case. Per
    // terrain_merge.rs::road_code (mask == 0xF -> all_road = true) +
    // texture_merge_info, an all-road cell is packed with base layer
    // ROAD_ATLAS_LAYER (32) and ZERO terrain overlays, so the loop below
    // already short-circuits and the cell renders as pure road. We make
    // that intent explicit here: when the base IS the road layer the
    // terrain-overlay loop is skipped outright (it would be a no-op
    // anyway -- every overlay slot is invalid -- but the guard documents
    // the Chorizite FindRoadAlpha all-road semantics and avoids three
    // dead texelFetch / mask samples per all-road fragment).
    // T1 splat-noise: one world-space noise sample shared by every slot
    // this fragment composites (per-slot noise would decorrelate the same
    // border across slots and shimmer).
    float splatN = 0.0;
    if (uSplatNoiseAmp > 0.0) {
      if (uSplatMacroAmp > 0.0) {
        // 2026-08-02 — TWO fixes, both under ?splatMacro (default on; "off"
        // restores the byte-exact legacy line below).
        //
        // (1) SIGN BIAS. fragValueNoise2D ALREADY returns mean-zero
        //     [-0.5, +0.5] (see its declaration ~line 1544 — it subtracts 0.5
        //     internally). The legacy expression subtracted 0.5 a SECOND time,
        //     making splatN one-sided [-1, 0]: every masked border was pushed
        //     toward the OVERLAY and never toward the base. Half the intended
        //     perturbation, applied asymmetrically, which is why the borders
        //     still read as authored edges rather than as organic transitions.
        // (2) MACRO OCTAVE. See the uSplatMacroAmp/Freq declarations.
        splatN = fragValueNoise2D(vWorldPos.xy * uSplatNoiseFreq)
               + uSplatMacroAmp * fragValueNoise2D(vWorldPos.xy * uSplatMacroFreq);
      } else {
        splatN = fragValueNoise2D(vWorldPos.xy * uSplatNoiseFreq) - 0.5;
      }
    }
    if (baseLayer != 32) {
      // Slots 1..3 = terrain overlays; slots 4..5 = road overlays. The road
      // slots were abandoned on 2026-06-21 because the masks "decoded to
      // near-full coverage" (two-lane highway) — that was the inverted mask
      // sense (see baseW below), NOT the masks: they are a dark lane on
      // white. With the retail sense restored they paint a single masked
      // lane. DEFAULT ON (escape ?roadSlots=off); the analytic
      // segment-distance painter below is now the fallback and is gated OFF
      // whenever these slots are active, so the lane is painted once.
      for (int s = 1; s < 6; s++) {
        if (s >= 4 && uRoadSlotsEnabled < 0.5) break;
        vec4 t = texelFetch(uMergeData, ivec2(colBase + s, iv), 0);
        if (t.a < 0.5) continue;            // empty slot
        int layer = int(t.r * 255.0 + 0.5);
        int maskIdx = int(t.g * 255.0 + 0.5);
        int rot = int(t.b * 255.0 + 0.5);
        vec2 mUv = maskUvFor(cellUv, rot);
        // 2026-07-02 — RETAIL MASK SENSE. ImgTex::MergeTexture
        // (acclient.c:365787) computes dst = (a*dst + (256-a)*src) >> 8 where
        // dst is the composited BASE tile and src the incoming OVERLAY: the
        // mask byte weights the BASE — white keeps base, black shows overlay
        // (corner masks are ~75-80 pct white with one dark quadrant; road
        // masks are a dark lane on white). This mix previously weighted the
        // OVERLAY by the mask — inverted — flooding boundary cells with the
        // overlay: the 2026-06-21 "big-blocks"/bars, AND the "near-full road
        // masks / two-lane highway" that got the road overlay slots
        // abandoned. R4.a roundMergeAlpha nudges the mask byte up when
        // a > 0x80 — with the mask now weighting the base, that is exactly
        // retail's rounding on the same operand.
        float baseW = roundMergeAlpha(
          texture(uAlphaMasks, vec3(mUv, float(maskIdx))).r,
          uTexMergeAlphaRound
        );
        // T1 splat-noise: shift the base/overlay balance inside the
        // transition band only -- baseW*(1-baseW) peaks at the border and
        // vanishes at 0/1, so authored full-coverage areas never change.
        baseW = clamp(
          baseW + splatN * uSplatNoiseAmp * 4.0 * baseW * (1.0 - baseW),
          0.0, 1.0);
        // 2026-07-31 (water-fix) — per-slot water UV, same rule as the base
        // slot above. The alpha MASK keeps reading the unscrolled cellUv:
        // the mask is the cell's authored coverage shape and must not drift,
        // only the water texels inside it do.
        vec3 overlayCol = texture(uAtlas, atlasUvFor(clamp(layer, 0, 32),
          isWaterCode(layer) ? waterCellUv : cellUv)).rgb;
        merged = mix(overlayCol, merged, baseW);
      }
    }
    result = merged;
  }

  // Wave 2.A — terrain-palette tint (OPT-IN, off by default since T8).
  // Sample the four cell-corner palette colours with the SAME bilinear
  // weights used for atlas tiles above, then modulate result by the blended
  // palette colour scaled by uTerrainPaletteStrength.
  //
  // T8 (2026-05-28): the per-code LUT is TerrainType.terrain_color, which is
  // the RADAR/MINIMAP colour (region.rs:653) -- an approximation, NOT the retail
  // terrain tint. It does differentiate biomes that share a base atlas tile
  // (e.g. BarrenRock 0 / Argila 24 both 0x0500145C), but via the wrong source,
  // so it's now gated behind the terrainPalette=on URL flag. The retail
  // mechanism is the per-type vertex bright/sat/hue modulation (the terrainMod
  // path), not a colour tint.
  if (uTerrainPaletteEnabled > 0.5) {
    vec3 p00 = paletteFor(t00);
    vec3 p10 = paletteFor(t10);
    vec3 p01 = paletteFor(t01);
    vec3 p11 = paletteFor(t11);
    vec3 paletteBlend = p00 * w00 + p10 * w10 + p01 * w01 + p11 * w11;
    vec3 tint = mix(vec3(1.0), paletteBlend, clamp(uTerrainPaletteStrength, 0.0, 1.0));
    result *= tint;
  }

  // Phase 2.2 — water tint shift. Subtle bluish modulation that breathes
  // over time (period ~21 s at uTime * 0.3).
  // Perf D1 — read the pre-computed sin(uTime * 0.3) from the varying
  // (constant across the cell since uTime is constant per draw call;
  // linear interpolation of a constant is exact).
  //
  // 2026-06-21 — was gated on the FLAT vIsWater (provoking vertex), tinting
  // the whole cell or none of it → a hard tint step at shoreline cells (same
  // per-cell block as the scroll). Now weighted by the bilinear per-corner
  // water fraction (waterW) so the tint fades in across the land/water seam
  // exactly like the texture blend — continuous, no block.
  // 2026-07-31 (water-fix) — was gated on uDisplacementEnabled, i.e. on
  // subdivLevel >= 2, so the breath died entirely at quality low/mid even
  // though it is a pure per-pixel effect with no geometry dependency. It now
  // rides uWaterScrollEnabled with the rest of the SURFACE animation, which
  // also gives ?waterScroll=off its documented meaning: one flag, fully
  // static water. waterW is the hoisted bilinear water fraction.
  if (uWaterScrollEnabled > 0.5 && waterW > 0.0) {
    vec3 tint = mix(vec3(0.9, 0.95, 1.05), vec3(1.0, 1.0, 1.0),
                    0.5 + 0.5 * vWaveModulation.x);
    result *= mix(vec3(1.0), tint, waterW);
  }

  // T7 — terrain detail-diffuse modulation (near-camera, MODULATE2X).
  // Applied to the merged base colour BEFORE the road overlay (road art
  // paints over the terrain in retail too). Uses the provoking-vertex
  // terrain code like the detail-NORMAL path above for one sample per
  // fragment. The detail tile tiles at (tiling * baseScale) repeats per
  // cell-unit (vGridUv is 1.0 per 24 m), giving sub-metre grain.
  //
  // MODULATE2X: a detail texel of ~0.5 (the tile's mid-grey mean) yields
  // 2*0.5 = 1.0 → no net colour change, so the base tile's average is
  // preserved while local light/dark grain is added. Strength + distance
  // fade keep it a near-camera effect; beyond uDetailTexFadeEnd the term
  // collapses to 1.0 (neutral), matching how retail's detail mip averages
  // out at distance.
  // 2026-07-02 — nearest-corner (max bilinear weight) terrain code for BOTH
  // detail layers below. They previously keyed off flat vTerrainCode (the
  // provoking vertex = ONE code per triangle), which stamped razor-edged
  // triangle-shaped detail patches at every type boundary (user-reported
  // "triangle" artefact). Nearest-corner keeps one sample per fragment but
  // moves the switch to the cell midlines, tracking the colour blend above.
  int nearCode = t00;
  {
    float nw = w00;
    if (w10 > nw) { nw = w10; nearCode = t10; }
    if (w01 > nw) { nw = w01; nearCode = t01; }
    if (w11 > nw) { nw = w11; nearCode = t11; }
  }

  // === Wave 2A — ICE FAKE REFRACTION (terrain-VFX plan §3.4 item 4) =======
  // A hint of refractive DEPTH for ~one texture tap: re-sample the nearest
  // corner's albedo at a UV pushed along the view vector, and blend it under
  // the real one by the ice fraction. That is the cheap stand-in the plan
  // specifies, and it is EXPLICITLY NOT MeshTransmissionMaterial (which needs a
  // second full scene render per frame for a handful of texels -- rejected on
  // cost, plan §3.4).
  //
  // ORDERING (plan §3.4): applied AFTER the POM march (cellUv already carries
  // the parallax offset here, and the snow-print dent too), and the amplitude
  // uIceRefractAmount is a third of uPomScale (0.012) so the two offsets are in
  // the same direction and never fight. Bypassed on water-touching cells, where
  // POM did not run and the water agent owns the surface. Gated separately from
  // the rest of the ice treatment because it is the only part with a texture
  // cost -- the ultra tier turns it on alone.
  if (uIceRefractEnabled > 0.5 && uIceEnabled > 0.5 && iceW > 0.0 && !cellTouchesWater) {
    vec3 rvw = normalize(vWorldPos - cameraPosition);
    vec3 rvt = vec3(rvw.x, -rvw.z, rvw.y);
    if (rvt.z < -0.15) {
      vec2 refrUv = cellUv + (rvt.xy / max(-rvt.z, 0.3)) * uIceRefractAmount;
      vec3 refr = texture(uAtlas, atlasUvFor(clamp(nearCode, 0, 32), refrUv)).rgb;
      // 0.55 keeps the surface tile dominant: this reads as something seen a
      // few centimetres INTO the ice, not as a doubled texture.
      result = mix(result, refr, iceW * 0.55);
    }
  }

  if (uDetailTexEnabled > 0.5) {
    int dcode = clamp(nearCode, 0, 32);
    int dslice = uCodeToDetailTexSlice[dcode];
    if (dslice >= 0 && dslice < uDetailTexSliceCount) {
      float tiling = float(uDetailTexTiling[dcode]);
      vec2 dUv = vGridUv * (tiling * uDetailTexBaseScale);
      vec4 detail = texture(uTerrainDetailTex, vec3(dUv, float(dslice)));
      if (uDetailTexCrossfade > 0.5) {
        // 2026-07-02 RETAIL OP (default "global" mode). The landscape detail
        // pass is an ALPHA CROSSFADE toward the detail tile, NOT a modulate:
        // src_blend=SRCALPHA dst_blend=INVSRCALPHA (acclient.c:459046-459049;
        // single-pass twin TEXOP_BLENDCURRENTALPHA at :454415). The blend
        // weight is the tile's own ALPHA channel (authored ~0.21 on retail
        // 0x06006D57 - the fixed-function stage multiplies texture alpha by
        // the vertex fade alpha) times the per-vertex distance fade
        // ACRender::get_alpha_for_z (acclient.c:719936): full inside 10 m,
        // LINEAR to zero at 50 m. The previous MODULATE2X of an
        // sRGB-DECODED texel at strength 1.0 multiplied terrain by 0..2x
        // (tile mean 106/255 decodes to 0.14 linear, x2 = 0.29) - the
        // 2026-07-02 "washed out + very bright and very dark" speckle.
        float fadeA = clamp(
          1.0 - (vViewDepth - uDetailTexFadeStart)
                / max(uDetailTexFadeEnd - uDetailTexFadeStart, 1e-3),
          0.0, 1.0);
        float amtA = detail.a * fadeA * clamp(uDetailTexStrength, 0.0, 1.0);
        result = mix(result, detail.rgb, amtA);
      } else {
        // "percode" A/B mode keeps the modern per-type MODULATE2X grain.
        float fade = 1.0 - smoothstep(uDetailTexFadeStart, uDetailTexFadeEnd, vViewDepth);
        float amt = clamp(uDetailTexStrength, 0.0, 1.0) * fade;
        vec3 mod2x = clamp(detail.rgb * 2.0, 0.0, 2.0);
        result *= mix(vec3(1.0), mod2x, amt);
      }
    }
  }

  // Retail-style road painting. Roads in retail AC are a per-vertex bit
  // (surface code bits 0-1), encoded into uVertexTypes.G during build.
  // Sample the 4 corner road bits with the SAME bilinear weights we
  // used for terrain colour blending — that produces a smooth 0..1
  // road-presence mask across each cell. When the mask is non-zero,
  // sample the retail road texture (tiled across the LB) and blend
  // it into the terrain colour by the mask. This replaces the prior
  // separate road-overlay quad mesh — same painted appearance retail
  // had, naturally flush with the terrain surface.
  //
  // SUPERSEDED as the default (see readRoadSlotsFlag): the retail TexMerge road
  // overlay slots composite above are now the default road source, and this
  // analytic lane is the FALLBACK for the bilinear path and for
  // ?roadSlots=off. It stays because it has no retail counterpart but does
  // give a clean single ~5 m lane (retail _road_width=5.0,
  // acclient.c:467318) when the merge path is unavailable. Gated OFF whenever
  // the merge road slots run, so the lane is never double-painted.
  if (uRoadEnabled > 0.5 && !(uTexMergeEnabled > 0.5 && uRoadSlotsEnabled > 0.5)) {
    float r00 = vertexRoadAt(iu,     iv    );
    float r10 = vertexRoadAt(iu + 1, iv    );
    float r01 = vertexRoadAt(iu,     iv + 1);
    float r11 = vertexRoadAt(iu + 1, iv + 1);
    float roadWeight = 0.0;
    if (uRoadPaintLegacy > 0.5) {
      // Legacy (?roadPaint=legacy): bilinear road-presence mask narrowed by
      // smoothstep(0.85, 0.95) to a ~5 m band. Correct on straight vertex-line
      // runs (mask = 1.0 along the shared cell edge) but a DIAGONAL road run
      // has road bits only on the two diagonal corners: the mask peaks at 0.5
      // mid-cell, never reaching 0.85 — the lane vanished mid-cell, visibly
      // amputating every diagonal road (user-reported "road broken").
      float roadMask = r00 * w00 + r10 * w10 + r01 * w01 + r11 * w11;
      roadWeight = smoothstep(0.85, 0.95, roadMask);
    } else if (r00 + r10 + r01 + r11 > 0.5) {
      // 2026-07-02 — analytic lane: paint within half of retail's
      // _road_width = 5.0 (acclient.c:467318) of the road POLYLINE. Road
      // segments connect road-flagged corners along the four cell edges AND
      // the two diagonals (retail roads step diagonally through the vertex
      // grid); a road corner also paints its joint disc so L-turns and lane
      // ends stay capped. ~1 m soft edge outside the 2.5 m half-width.
      vec2 p = cellUv * 24.0;
      vec2 k00 = vec2(0.0, 0.0);
      vec2 k10 = vec2(24.0, 0.0);
      vec2 k01 = vec2(0.0, 24.0);
      vec2 k11 = vec2(24.0, 24.0);
      float d = 1e9;
      if (r00 > 0.5 && r10 > 0.5) d = min(d, distToSegment(p, k00, k10));
      if (r01 > 0.5 && r11 > 0.5) d = min(d, distToSegment(p, k01, k11));
      if (r00 > 0.5 && r01 > 0.5) d = min(d, distToSegment(p, k00, k01));
      if (r10 > 0.5 && r11 > 0.5) d = min(d, distToSegment(p, k10, k11));
      if (r00 > 0.5 && r11 > 0.5) d = min(d, distToSegment(p, k00, k11));
      if (r10 > 0.5 && r01 > 0.5) d = min(d, distToSegment(p, k10, k01));
      if (r00 > 0.5) d = min(d, length(p - k00));
      if (r10 > 0.5) d = min(d, length(p - k10));
      if (r01 > 0.5) d = min(d, length(p - k01));
      if (r11 > 0.5) d = min(d, length(p - k11));
      roadWeight = 1.0 - smoothstep(2.0, 3.0, d);
    }
    if (roadWeight > 0.0) {
      vec3 roadColor = texture(uRoadTexture, vGridUv * uRoadTileScale).rgb;
      result = mix(result, roadColor, roadWeight);
    }
  }

  // =====================================================================
  // FAR MACRO — the "mspaint" fix (2026-08-02, ?terrainMacro, DEFAULT ON)
  // =====================================================================
  // Sited HERE, at the very end of the albedo chain and before ANY lighting,
  // deliberately: everything above (TexMerge composite, palette tint, water
  // tint, detail crossfade, road paint) is retail-derived placement/colour,
  // and this layer must modulate the finished authored albedo rather than
  // participate in deciding it. result is linear here (the atlas is sRGB and
  // the sampler has already decoded it), which is the space the MODULATE2X
  // encode assumes.
  //
  // Strictly a far-field layer: mFade is 0 nearer than uMacroFadeStart
  // (55 m, just past where the near detail layer hands off at 50 m), so the
  // ground the player is standing on is byte-identical to before.
  if (uMacroEnabled > 0.5 && uMacroStrength > 0.0) {
    int mSlice = uMacroSliceForCode[clamp(nearCode, 0, 32)];
    // Water and road resolve to 255 -> no macro. Water is the water agent's
    // surface (it has its own scroll/tint/sheen treatment and a macro
    // modulation would fight the swell), and a road is a 5 m lane, not a field.
    if (mSlice < uMacroSliceCount) {
      float mFade = smoothstep(uMacroFadeStart, uMacroFadeEnd, vViewDepth);
      if (mFade > 0.0) {
        vec2 wp = vWorldPos.xy;
        // Tap B is rotated ~37 deg (an angle with no small rational relation
        // to the axis-aligned tap A) and uses a scale that is NOT a harmonic
        // of A, so the two lattices' repeats never coincide: the visible
        // period of the sum is far longer than either tile.
        const float MACRO_ROT_C = 0.79863551;   // cos(37 deg)
        const float MACRO_ROT_S = 0.60181502;   // sin(37 deg)
        vec2 wr = vec2(wp.x * MACRO_ROT_C - wp.y * MACRO_ROT_S,
                       wp.x * MACRO_ROT_S + wp.y * MACRO_ROT_C);
        vec3 mA = texture(uMacroTex,
          vec3(wp / max(uMacroScaleA, 1.0), float(mSlice))).rgb;
        vec3 mB = texture(uMacroTex,
          vec3(wr / max(uMacroScaleB, 1.0), float(mSlice))).rgb;
        // MODULATE2X, averaged in MULTIPLIER space: (mA*2 + mB*2) * 0.5.
        // Both maps are baked mean-0.5, so this is exactly mean-1.0 — the
        // average colour of a distant field is preserved to the byte and only
        // its structure changes. That is what keeps WorldBuilder the source of
        // truth: this cannot shift a terrain type's authored colour.
        vec3 macroMod = mA + mB;
        // Direction 1 — procedural octaves on top, sampled in WORLD space so
        // the field is continuous across the whole landscape. (vGridUv would
        // reset every 192 m and stamp the landblock stream grid — the same
        // trap documented on the paintMode noise above.)
        float pn = fragValueNoise2D(wp * 0.014084)             // ~71 m
                 + 0.55 * fragValueNoise2D(wp * 0.038462)      // ~26 m
                 + 0.30 * fragValueNoise2D(wp * 0.111111);     // ~9 m
        macroMod *= (1.0 + pn * uMacroNoiseAmp);
        result *= mix(vec3(1.0), macroMod, mFade * uMacroStrength);
      }
    }
  }

  // ---------------------------------------------------------------
  // Phase 1.2 — detail-normal overlay via reoriented normal blending.
  // ---------------------------------------------------------------
  //
  // Goal: a high-frequency tangent-space normal sampled per terrain
  // category, blended into the surface normal so the sun's NdotL term
  // picks up sub-cell detail (grass blades, sand drifts, pebbles).
  //
  // Reoriented normal mapping (RNM) — see
  //   https://blog.selfshadow.com/publications/blending-in-detail/  §4
  // takes a base tangent-space normal and a detail tangent-space normal
  // and produces a single tangent-space normal that respects the base
  // orientation. The 6 lines below are the standard formulation:
  //   t = base * (2, 2, 2) + (-1, -1,  0)
  //   u = detail * (-2, -2, 2) + (1, 1, -1)
  //   r = normalize(t * dot(t, u) - u * t.z)
  // Then r is treated as the combined tangent-space normal.

  // Sun-direction: AC-z-up unit vector from uSunDir, pushed each frame
  // by loop.js off the same SkyState that drives SkyMaterial /
  // SunDirectionalLight / CloudsEffect. Pre-populator: default uniform
  // value mirrors the original literal so first frames look identical.
  vec3 sunDir = normalize(uSunDir);

  // Base surface normal in tangent space — terrain is flat-Z-up at the
  // grid level, so (0, 0, 1) is the canonical base. (Per-vertex
  // varying normals could be derived from geometry, but at 24 m
  // spacing they're barely non-vertical; the detail layer carries the
  // sub-cell perturbation.)
  //
  // F12-3 — slope-dependent sun shading (?terrainSlopeShading=on, default
  // off). The geometry already carries a per-vertex AC-space normal
  // (vAcNormal), but the lighting term ignored it: mountains / valley walls /
  // cliff bands read airbrushed with no light-shade relief — worst at low
  // (dawn/dusk) sun angles where retail terrain is strongly modelled.
  //
  // FU-2 — the RNM base ALWAYS stays the flat pre-encoded tangent base
  // (0.5, 0.5, 1.0), regardless of the flag. The geometry (world-space)
  // normal must never be routed through the tangent-space RNM decode: that
  // is a space category error that collapses t toward the zero vector on
  // sloped facets and produces normalize(0) = NaN → pure-black terrain. The
  // detail layer perturbs the flat tangent base as it always has. The slope
  // relief from the real geometry normal is instead applied SEPARATELY as a
  // world-space NdotL factor on the final ndotl (below, after the detail
  // path), so flag-off output is bit-exact (ndotl unchanged, no NaN path).
  vec3 geomN = normalize(vAcNormal);
  bool slopeShading = uTerrainSlopeShadingEnabled > 0.5;
  vec3 baseN = vec3(0.5, 0.5, 1.0);    // flat pre-encoded base [0.5, 0.5, 1]

  float ndotl = 1.0;
  // Retail terrain runs with fixed-function lighting DISABLED, so under
  // ?terrainGouraud the per-pixel sun terms (detail-normal NdotL and the
  // FU-2 slope relief) are suppressed entirely and replaced by the vertex
  // Gouraud colour below. The detail NORMAL still shapes nothing here — the
  // detail/triplanar albedo path is untouched, only its NdotL contribution.
  bool acGouraud = uAcGouraudEnabled > 0.5;
  if (uDetailNormalEnabled > 0.5 && !acGouraud) {
    // 2026-07-02 — nearest-corner code (was flat vTerrainCode; see nearCode).
    int slice = uCodeToSlice[clamp(nearCode, 0, 31)];
    if (slice < 5) {
      // ----- Phase 1.3 — slope-gated triplanar detail sampling. -----
      //
      // Existing grid-UV path (vGridUv * uDetailScale) is the XY-plane
      // projection of the LB-local position scaled by uDetailScale (16).
      // For triplanar we additionally sample YZ + XZ projections of the
      // same world point and blend by abs(normal)^sharpness.
      //
      // Slope detection: vAcNormal is AC-space (Z-up before worldRoot
      // rotation); flat ground points (0,0,1). slope = 1 - n.z is 0
      // on flat ground, ~1 on vertical cliffs. We always use the
      // normalised normal to keep weights stable across mesh edges.
      vec3 n = normalize(vAcNormal);
      float slope = 1.0 - n.z;
      float triBlend = uTriplanarEnabled > 0.5
        ? smoothstep(uTriplanarSlopeLo, ${TRIPLANAR_SLOPE_HI.toFixed(3)}, slope)
        : 0.0;
      vec2 detailUvXy = vGridUv * uDetailScale;
      // Slice 2 = sand. Rotate the sample UV by uWindDir = (cos θ, sin θ)
      // so the anisotropic drift pattern tracks the wind direction. The
      // rotation is applied to all three triplanar planes consistently
      // so the wind-axis follows the dominant axis at the fragment.
      if (slice == 2) {
        float cw = uWindDir.x;
        float sw = uWindDir.y;
        detailUvXy = vec2(cw * detailUvXy.x - sw * detailUvXy.y,
                          sw * detailUvXy.x + cw * detailUvXy.y);
      }
      vec3 detailEncoded = texture(uTerrainDetailNormalArray,
                                   vec3(detailUvXy, float(slice))).rgb;
      if (triBlend > 0.0) {
        // YZ + XZ samples at the same per-LB frequency as the existing
        // XY path (position scaled by uDetailScale / 24.0).
        float invCell = uDetailScale / 24.0;
        vec2 detailUvYz = vAcPos.yz * invCell;
        vec2 detailUvXz = vAcPos.xz * invCell;
        if (slice == 2) {
          float cw = uWindDir.x;
          float sw = uWindDir.y;
          detailUvYz = vec2(cw * detailUvYz.x - sw * detailUvYz.y,
                            sw * detailUvYz.x + cw * detailUvYz.y);
          detailUvXz = vec2(cw * detailUvXz.x - sw * detailUvXz.y,
                            sw * detailUvXz.x + cw * detailUvXz.y);
        }
        vec3 detailYz = texture(uTerrainDetailNormalArray,
                                vec3(detailUvYz, float(slice))).rgb;
        vec3 detailXz = texture(uTerrainDetailNormalArray,
                                vec3(detailUvXz, float(slice))).rgb;
        // Triplanar blend weights from |normal| raised to sharpness.
        // x-weight pairs with YZ (the plane perpendicular to +x), y with
        // XZ, z with XY — the existing detailEncoded.
        vec3 w = pow(abs(n), vec3(uTriplanarSharpness));
        float wSum = max(w.x + w.y + w.z, 1e-4);
        w /= wSum;
        vec3 detailTri = detailYz * w.x + detailXz * w.y + detailEncoded * w.z;
        detailEncoded = mix(detailEncoded, detailTri, triBlend);
      }
      // RNM blend.
      vec3 t = baseN * vec3(2.0, 2.0, 2.0) + vec3(-1.0, -1.0, 0.0);
      vec3 u = detailEncoded * vec3(-2.0, -2.0, 2.0) + vec3(1.0, 1.0, -1.0);
      // FU-2 — guard against the latent normalize(0) NaN: a degenerate detail
      // sample (e.g. encoded (0.5,0.5,0.5) → u=0) collapses the RNM vector to
      // zero. Compute it raw, then fall back to the flat tangent normal.
      vec3 rnmRaw = t * dot(t, u) - u * t.z;
      vec3 combinedN = (dot(rnmRaw, rnmRaw) > 1e-8) ? normalize(rnmRaw) : vec3(0.0, 0.0, 1.0);
      // Apply combined normal to the sun NdotL.
      ndotl = clamp(dot(combinedN, sunDir), 0.0, 1.0);
      // Wrap-lighting bias so unlit faces don't go pure black — terrain
      // shading is otherwise unmodulated, so a pure cosine produces too
      // much contrast at sunset orientations.
      ndotl = mix(0.65, 1.0, ndotl);
    }
  }

  // FU-2 — geometry-normal slope relief, applied as a WORLD-space factor on
  // the resolved ndotl (whichever path ran: flat seed of 1.0 with detail off,
  // or the floored RNM result with detail on). Only when the flag is on, so
  // flag-off is a strict no-op. This is the SOLE slope contribution (the old
  // Path A seed was dropped above) — folding the wrap-floored (0.65) real
  // geometry NdotL here gives true light/shade relief without ever passing
  // the world normal through the tangent-space RNM. Combined floor ~0.42
  // (0.65 * 0.65), never pure black.
  if (slopeShading && !acGouraud) {
    float slopeNdotL = mix(0.65, 1.0, clamp(dot(geomN, sunDir), 0.0, 1.0));
    ndotl = mix(ndotl, ndotl * slopeNdotL, 1.0);
  }

  // T2 (?pbrTerrain=on) -- per-pixel material relief from the CC0 set:
  // one uAtlasNormalAo sample at the nearest-corner code (same single-sample
  // convention as the detail layers -- the switch tracks the colour blend at
  // cell midlines) through the same atlasUvFor tiling as the albedo, so
  // normal and colour stay registered. The material NdotL REPLACES the
  // detail-normal ndotl when both are on (the 1K material normal carries
  // strictly more structure than the 5-slice category detail); the FU-2
  // geometry slope factor is re-applied on top so hillsides keep their
  // relief. AO multiplies the albedo with a 0.6 floor (crevice darkening,
  // never black). Tangent frame: terrain is flat-Z-up at grid level and
  // cellUv axes track AC east/north -- the same frame the detail-normal RNM
  // path assumes; sign-of-green is eye-test territory on the 1070.
  // acGouraud wins when both flags are set (retail-look mode stays retail).
  vec3 iblSpec = vec3(0.0);
  if (uPbrEnabled > 0.5 && !acGouraud) {
    int pbrCode = clamp(nearCode, 0, 32);
    vec3 pbrUvw = atlasUvFor(pbrCode, cellUv);
    vec4 pbrTexel = texture(uAtlasNormalAo, pbrUvw);
    // nra pack: xy = tangent normal, z reconstructed (unit hemisphere),
    // b = material roughness, a = AO.
    vec2 pbrNxy = pbrTexel.rg * 2.0 - 1.0;
    vec3 pbrN = normalize(vec3(pbrNxy, sqrt(max(1.0 - dot(pbrNxy, pbrNxy), 0.04))));
    float pbrRough = pbrTexel.b;
    // terrainplan s4 water sheen USED TO LIVE HERE, inside the
    // uPbrEnabled && !acGouraud block. 2026-07-31 (water-fix): retail
    // Gouraud (?terrainGouraud) is DEFAULT-ON and wins over PBR, so this
    // branch never executed in a default session -- uWaterEnvEnabled read
    // 1.0 while doing nothing at all (live uniform dump confirmed
    // pbr=1, gouraud=1). The sheen now lives in its own block below the PBR
    // block so it runs in BOTH shading modes; keeping it here as well would
    // double-count it. Water also skips the material NdotL/AO substitution
    // now: the nra layers for water codes are deliberately uncurated in both
    // texture arms (flat normal, rough 230 -- see terrain_bc7.js "the water
    // shader owns their normal and roughness"), so applying them to water
    // just flattens what the sheen block is about to compute.
    float pbrNdotl = mix(0.65, 1.0, clamp(dot(pbrN, sunDir), 0.0, 1.0));
    if (slopeShading) {
      pbrNdotl *= mix(0.65, 1.0, clamp(dot(geomN, sunDir), 0.0, 1.0));
    }
    // 2026-07-31 (water-fix) — fade the material NdotL + AO back out over
    // water by the bilinear waterW. Strict no-op off water (waterW == 0).
    ndotl = mix(pbrNdotl, ndotl, waterW);
    result *= mix(mix(0.6, 1.0, pbrTexel.a), 1.0, waterW);

    // T3 -- env-specular for EVERY layer, driven by the material's own
    // roughness map (nra B channel). Reflection sharpness = mip lod scaled
    // by roughness (128px cube, mips 0..7); strength = fresnel x gloss^2 so
    // high-rough ground (grass/dirt ~0.8+) keeps only a whisper of grazing
    // sheen while low-rough ice reads glassy -- the Fiun-glacier look,
    // data-driven instead of the old 3-code hardcoded gloss table.
    // Space bridge: pbrN is tangent~AC space (z-up); the env cube lives in
    // three world space (worldRoot rotation.x = -PI/2), so ac(x,y,z) ->
    // world(x,z,-y) -- same mapping as acToThree(). cameraPosition is the
    // three.js built-in fragment uniform. Added AFTER the lighting products
    // (env light is ambient -- not sun-shadowed), tone-mapped by AGX.
    if (uIblEnabled > 0.5) {
      float envGloss = 1.0 - pbrRough;
      if (envGloss > 0.03) {
        vec3 nWorld = normalize(vec3(pbrN.x, pbrN.z, -pbrN.y));
        vec3 viewW = normalize(vWorldPos - cameraPosition);
        vec3 reflW = reflect(viewW, nWorld);
        vec3 envSample = textureLod(uEnvCube, reflW, pbrRough * 5.0).rgb;
        float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(-viewW, nWorld), 0.0, 1.0), 5.0);
        // 2026-07-31 (water-fix) — (1 - waterW): the dedicated water sheen
        // below owns the water reflection, so the generic material term
        // stands down over water instead of adding a second, flat one.
        iblSpec = envSample * fres * envGloss * envGloss * uEnvIntensity
                * (1.0 - waterW);
      }
    }
  }

  // === 2026-07-31 (water-fix) — WATER SURFACE SHEEN =======================
  // terrainplan s4's water sheen, lifted out of the PBR block so it runs in
  // BOTH shading modes. It used to sit inside uPbrEnabled > 0.5 &&
  // !acGouraud, and retail Gouraud is default-ON and wins that test, so the
  // default-on uWaterEnvEnabled gate was a no-op in every normal session.
  //
  // The normal is a finite-difference gradient of the existing coherent
  // value-noise field, scrolled in world space -- so it is the SECOND,
  // higher-frequency half of the surface motion, running simultaneously with
  // (and independently of) both the geometry swell and the UV scroll. No
  // extra pass, no new textures, no light-count change (VFX invariant), and
  // it reads only static data + the shared clock + world position.
  //
  // Weighted by waterW, so it fades across the shoreline exactly like the
  // tint and the texture blend rather than switching at a cell midline.
  // DISTANCE FADE is load-bearing, not polish. The wave normal is a
  // finite-difference gradient of a ~3.3 m-period noise field sampled once per
  // pixel with no derivative-aware filtering, so past a few tens of metres one
  // pixel spans many wave periods and the specular term aliases hard: the
  // first live shot of this block showed long white streaks radiating to the
  // horizon across the whole sea (attributed by forcing uWaterEnvEnabled=0,
  // which removed them exactly). Rather than filter the noise, the sheen is
  // simply a NEAR-CAMERA effect: full strength inside 30 m, gone by 160 m,
  // with the normal flattening toward vertical and the env reflection blurring
  // up the mip chain on the way out. Beyond the fade the water reads as the
  // plain retail tile it did before, which is also the conservative answer.
  float sheenFade = 1.0 - smoothstep(30.0, 160.0, vViewDepth);
  if (uWaterEnvEnabled > 0.5 && waterW > 0.0 && sheenFade > 0.001) {
    vec2 wuv = vWorldPos.xy * 0.30 + vec2(uTime * 0.35, uTime * 0.22);
    float wh0 = fragValueNoise2D(wuv);
    float whx = fragValueNoise2D(wuv + vec2(0.7, 0.0));
    float why = fragValueNoise2D(wuv + vec2(0.0, 0.7));
    // AC tangent frame (z-up), same convention the PBR path assumes. The xy
    // slope is scaled by sheenFade so the surface relaxes to flat with
    // distance instead of shimmering.
    vec3 wN = normalize(vec3((wh0 - whx) * 1.4 * sheenFade,
                             (wh0 - why) * 1.4 * sheenFade,
                             1.0));
    // View direction in three world space, and the same vector in AC space:
    // world(x,y,z) = ac(x,z,-y) so ac = (w.x, -w.z, w.y).
    vec3 viewW = normalize(vWorldPos - cameraPosition);
    vec3 viewAc = vec3(viewW.x, -viewW.z, viewW.y);
    // Sun glint (Blinn half-vector). sunDir is the AC-z-up direction TO the
    // sun; -viewAc is the direction to the eye.
    vec3 halfAc = normalize(sunDir - viewAc);
    float glint = pow(clamp(dot(wN, halfAc), 0.0, 1.0), 64.0);
    vec3 waterSpec = uAcSunColor * glint * 0.30;
    if (uIblEnabled > 0.5) {
      vec3 nWorldW = normalize(vec3(wN.x, wN.z, -wN.y));
      vec3 reflW = reflect(viewW, nWorldW);
      // Near camera: low mip, near-mirror sky reflection (water is the one
      // terrain layer that genuinely reflects the sky). Far: blur up the mip
      // chain, which is the correct pre-filter for a shrinking footprint.
      vec3 envSample = textureLod(uEnvCube, reflW, mix(4.0, 0.6, sheenFade)).rgb;
      float fresW = 0.04 + 0.96 * pow(1.0 - clamp(dot(-viewW, nWorldW), 0.0, 1.0), 5.0);
      waterSpec += envSample * fresW * uEnvIntensity * 0.55;
    }
    iblSpec += waterSpec * waterW * sheenFade;
  }

  // === Wave 2B — VOLCANO CRACK GLOW + OBSIDIAN ===========================
  // Terrain-VFX plan §3.6 items 3 + 5. One gate, two terms, both keyed off the
  // TERRAIN CODE from uVertexTypes (trap T3) and both weighted by a bilinear
  // corner fraction so they feather at a type boundary.
  //
  // WHERE IT SITS AND WHY (plan §2.7.3):
  //   • AFTER the POM march, and the vein field is anchored to the
  //     PARALLAX-CORRECTED surface point — vWorldPos is the geometric (pre-POM)
  //     position, so the POM offset (cellUv - the original vec2(fu, fv)) is
  //     added back in cell units x 24 m. Without that, the cracks would slide
  //     against the relief they are supposed to be cut into (plan §8 risk 14).
  //   • It HONOURS the cellTouchesWater bypass. POM does not run on a
  //     water-touching cell, so the correction term is zero there anyway — but
  //     a shoreline volcanic cell must not glow THROUGH the water surface the
  //     water agent owns, so the whole block stands down.
  //   • It adds to iblSpec, NOT to the shadow-multiplied product: crack glow is
  //     EMISSIVE (lava glows in shadow) and the obsidian env reflection is
  //     ambient. That also means the final fragColor line is untouched.
  //   • It never writes cellUv, waterCellUv, waterW or any water uniform.
  // The mid-tier degrade is coherent by construction: POM is high/ultra only,
  // and with POM off the correction term is exactly zero, leaving the same
  // veins on an unrelieved surface (plan §2.7.3 point 4).
  if (uCrackGlowEnabled > 0.5 && !cellTouchesWater && (volcW > 0.0 || obsidianW > 0.0)) {
    // POM-corrected AC ground position (world(x,y,z) = ac(x,z,-y)).
    vec2 pomShiftV = (cellUv - vec2(fu, fv)) * 24.0;
    vec2 groundXy = vec2(vWorldPos.x, -vWorldPos.z) + pomShiftV;

    if (volcW > 0.0) {
      float crackFade = 1.0 - smoothstep(uCrackGlowFadeStart, uCrackGlowFadeEnd, vViewDepth);
      if (crackFade > 0.001) {
        // RIDGED noise: |2n-1| is 0 along the field's mid-level contour, so
        // thresholding it draws thin connected LINES rather than blobs — the
        // cheapest thing that reads as a crack network. Two octaves so the
        // veins branch instead of running as smooth parallel curves.
        vec2 veinXy = groundXy * uCrackGlowDensity;
        float n1 = fragValueNoise2D(veinXy);
        float f1 = abs(n1 * 2.0 - 1.0);
        float vein = 1.0 - smoothstep(0.0, uCrackGlowWidth, f1);
        float n2 = fragValueNoise2D(veinXy * 2.31 + vec2(11.7, 5.3));
        float f2 = abs(n2 * 2.0 - 1.0);
        vein *= 0.45 + 0.55 * (1.0 - smoothstep(0.0, uCrackGlowWidth * 2.5, f2));
        if (vein > 0.001) {
          iblSpec += uCrackGlowColor
                   * (uCrackGlowStrength * vein * volcW * crackFade * uCrackGlowBreath);
        }
      }
    }

    if (obsidianW > 0.0) {
      // ObsidianPlain (code 6) only: roughness DOWN-DOWN reads as a tight,
      // low-intensity Blinn lobe plus a sharp (low-mip) env reflection. It runs
      // in BOTH shading modes on purpose — the uPbrEnabled block above is dead
      // in a default session because retail Gouraud is default-ON and wins that
      // test, which is exactly the trap the 2026-07-31 water sheen fell into.
      vec3 viewWo = normalize(vWorldPos - cameraPosition);
      vec3 viewAcO = vec3(viewWo.x, -viewWo.z, viewWo.y);
      vec3 halfAcO = normalize(sunDir - viewAcO);
      float obsLobe = pow(clamp(dot(geomN, halfAcO), 0.0, 1.0), uObsidianShininess);
      vec3 obsSpec = uAcSunColor * (obsLobe * uObsidianSpecular);
      if (uIblEnabled > 0.5) {
        vec3 nWorldO = normalize(vec3(geomN.x, geomN.z, -geomN.y));
        vec3 reflO = reflect(viewWo, nWorldO);
        // Mip 0.5 = near-mirror: glass, not stone.
        vec3 envO = textureLod(uEnvCube, reflO, 0.5).rgb;
        float fresO = 0.04 + 0.96 * pow(1.0 - clamp(dot(-viewWo, nWorldO), 0.0, 1.0), 5.0);
        obsSpec += envO * fresO * uEnvIntensity * uObsidianEnv;
      }
      iblSpec += obsSpec * obsidianW;
    }
  }

  // Clouds-L — cloud-shadow modulation. Project world pos into cascade
  // 0's shadow space; sample the R channel (cloud optical depth along
  // sun ray); attenuate. Cascade 0 covers the closest ~10% of view
  // distance so terrain near the camera gets the highest-detail
  // shadow. Outside cascade 0 (UV outside [0,1]) → no shadow. Real
  // cascade selection by distance is Clouds-L-extended.
  float cloudShadow = 1.0;
  if (uCloudShadowEnabled > 0.5) {
    vec4 sclip = uCloudShadowMatrix0 * vec4(vWorldPos, 1.0);
    sclip /= sclip.w;
    vec2 suv = sclip.xy * 0.5 + 0.5;
    if (suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0) {
      // takram shadow buffer channels (vendor shadow.frag):
      //   .r = frontDepth (DISTANCE to the cloud front, metres — up to
      //        maxRayDistance ~1e6 when the column is clear),
      //   .g = meanExtinction, .b = maxOpticalDepth, .a = opticalDepthTail.
      // The prior code sampled .r and fed that DISTANCE into
      // exp(-density*strength) as if it were a cloud density — which could
      // never produce a correct shadow (and a garbage/oversized sample made
      // exp() explode above 1 → a full-frame milky wash on a real GPU; it
      // stayed hidden because SwiftShader zero-bakes the cloud pass).
      //
      // Terrain sits BELOW the whole cloud column, so its extinction is the
      // full-column optical depth = .b + .a — exactly takram's own
      // readShadowOpticalDepth() min-branch for a fully-below receiver
      // (clouds.frag:172-183). Clear column → sampleCount==0 → .b=.a=0 →
      // exp(0)=1 (fully lit, no false shadow, no wash).
      vec4 csSample = texture(uCloudShadowMap, vec3(suv, 0.0));
      float csOpticalDepth = max(0.0, csSample.b + csSample.a);
      // Beer-Lambert transmittance, floored to 0.3 (sky ambient still fills
      // thick cloud) and capped at 1.0 (a shadow must NEVER brighten ground).
      cloudShadow = clamp(exp(-csOpticalDepth * uCloudShadowStrength), 0.3, 1.0);
    }
  }

  // CSM-on-terrain — building / static cast shadows now actually land
  // on the ground. csmShadowFactor returns 0.0 (fully shadowed) or
  // 1.0 (fully lit); mix with a 0.45 floor so shadowed terrain keeps
  // ambient lift, matching the MeshStandardMaterial CSM patch in
  // materials.js (same visual feel for cast shadows across surfaces).
  float csmShadow = 1.0;
  if (uCsmEnabled > 0.5) {
    float s = csmShadowFactor(vWorldPos, vViewDepth);
    csmShadow = mix(0.45, 1.0, s);
  }

  // R1.A 2026-05-28 — TerrainTex saturation + hue adjust, applied to
  // the lit color BEFORE the brightness multiply so the channel order
  // is: sat/hue adjust -> brightness multiply -> cloud-shadow/CSM
  // (downstream). Gated by uTerrainModulationEnabled * uTerrainModSatHue:
  //  - master off (uTerrainModulationEnabled==0) -> gate=0 -> early-out,
  //    result unchanged (bit-exact no-op, preserves shipped retail look)
  //  - master on, sub off (uTerrainModSatHue==0) -> gate=0 -> brightness
  //    only (the previously-shipped ?terrainMod behaviour)
  //  - both on -> gate=1 -> full HSV adjust by the per-vertex factors
  // The early-out inside applyTerrainSatHue (not a mix()) is deliberate:
  // an RGB->HSV->RGB round-trip is NOT perfectly lossless, so we must
  // return the untouched RGB to guarantee a bit-exact no-op.
  float satHueGate = uTerrainModulationEnabled * uTerrainModSatHue;
  result = applyTerrainSatHue(result, satHueGate);
  // 2026-05-28 — TerrainTex modulation multiply. vBrightness is the
  // per-vertex factor in [min_bright/100, max_bright/100] (most natural
  // terrain 0.9..1.0, Ice + RoadType 0.3..0.6). mix(1.0, vBrightness, gate)
  // collapses to 1.0 when the URL flag is off → no-op; collapses to
  // vBrightness when on → per-vertex linear modulation of the lit color.
  // Applied to the LIGHTING result (pre-cloud/csm multiply) so cloud
  // shadow + CSM darken on top of the modulation, not the other way
  // around — matches how a brightness-modulated diffuse channel would
  // sit in a PBR composition.
  vec3 modulated = result * mix(1.0, vBrightness, uTerrainModulationEnabled);
  // RND-20/21 — retail Gouraud terrain colour. vAcLightNormal is the raw
  // interpolated retail normal (see the varying decl); dot() with the
  // dirBright-scaled sun vector is therefore linear across each retail
  // triangle, matching acclient's per-vertex colour lerp. max()/min() are
  // applied per fragment rather than per vertex, which differs from retail
  // only inside the terminator band and never overshoots it.
  if (acGouraud) {
    float acL = max(0.0, dot(vAcLightNormal, uAcSunVec));
    vec3 acC = min(vec3(1.0), uAcSunColor * acL + uAcAmbColor * uAcAmbLevel);
    modulated *= acC;
  }

  // === Wave 2A — SNOW FOOTPRINT DARKENING (plan §3.4 item 3) =============
  // The other half of the print. Compressed snow is denser and self-shadowed,
  // so a darkening alone already reads as a footprint -- which is precisely why
  // the mid degrade (no POM, hence no dent) is a coherent lesser effect and
  // not a broken one. Weighted by the SMOOTH bilinear snowW so a print running
  // off snow onto rock fades out instead of ending at a cell edge, and applied
  // to modulated (the lit colour, pre cloud/CSM) so a print inside a cloud
  // shadow does not double-darken.
  if (uSnowPrintEnabled > 0.5 && snowPrint > 0.0 && snowW > 0.0) {
    modulated *= mix(1.0, 1.0 - uSnowPrintDarken, snowPrint * snowW);
  }

  // === Wave 3B — MUD PRINT DARKENING (plan §3.7 item 2) ==================
  // The other half of the mud print, sited and reasoned exactly as the snow
  // one: weighted by the SMOOTH bilinear dirtW so a track running off mud onto
  // grass fades out instead of ending at a cell edge, and applied to
  // modulated (the lit colour, pre cloud/CSM) so a print inside a cloud
  // shadow does not double-darken. This is also the whole mid degrade — with
  // POM off there is no dent, and compressed wet earth reads as a print from
  // the darkening alone.
  if (uMudPrintEnabled > 0.5 && mudPrint > 0.0 && dirtW > 0.0) {
    modulated *= mix(1.0, 1.0 - uMudPrintDarken, mudPrint * dirtW);
  }

  // === Wave 3B — WET MUD DARKENING (plan §3.7 items 2 + 4) ===============
  // THE RESPONSE CURVE IS vfx/components/wetness.js's, REUSED RATHER THAN
  // RE-INVENTED (plan §3.7 item 2: "so puddled statics and puddled ground
  // agree"). That component computes, at the <map_fragment> seam:
  //     _vfxWetUp  = smoothstep(0.05, 0.6, vVfxWorldNormal.y)
  //     _vfxWetAmt = clamp(uWetness * uWetStrength, 0, 1) * _vfxWetUp
  //     diffuseColor.rgb *= mix(1.0, uWetDarken, _vfxWetAmt)
  // and the three lines below are that, verbatim, with two substitutions the
  // frames force: geomN.z for vVfxWorldNormal.y (the terrain works in AC
  // space, where +Z is world up — the same component would compute the same
  // number), and modulated for diffuseColor (this shader has no
  // <map_fragment> seam; modulated is the lit colour at the equivalent point,
  // pre cloud/CSM, which is where the print darkening also lands so the two
  // compose instead of fighting). uMudWetDarken/uMudWetStrength are the
  // component's own defaults, not new tuning.
  //
  // CLAY goes REDDER (plan §3.7): the darkening is tinted by uClayWetTint,
  // weighted by the strict-subset clayW, so Argila warms as it soaks while the
  // rest of the family just goes dark.
  //
  // mudWetAmt is declared up at the print block so the SHEEN below reads the
  // same weight this darkening used — the same main()-scope-local trick
  // wetness.js uses to share _vfxWetAmt between its two seams.
  if (uMudWetEnabled > 0.5 && dirtW > 0.0 && !cellTouchesWater) {
    float mudWetUp = smoothstep(0.05, 0.6, geomN.z);
    mudWetAmt = clamp(uMudWetness * uMudWetStrength, 0.0, 1.0) * mudWetUp * dirtW;
    if (mudWetAmt > 0.0) {
      vec3 mudDark = mix(vec3(1.0), vec3(uMudWetDarken) * mix(vec3(1.0), uClayWetTint, clayW),
                         mudWetAmt);
      modulated *= mudDark;
    }
  }

  // === Wave 2A — SNOW CRYSTAL SPARKLE (plan §3.4 item 2) =================
  // vfx/components/glint.js's maths -- a Blinn half-vector lobe times a
  // time+hash twinkle -- with the metalness gate replaced by the SNOW FRACTION
  // and the PER-INSTANCE hash replaced by a high-frequency WORLD-SPACE one
  // (plan §3.4: "port that maths with a high-frequency world-space hash instead
  // of the per-instance one"). There is no instance here: the terrain is one
  // mesh, so vVfxHash does not exist and could not vary per crystal anyway.
  //
  // CAMERA-MOTION-DEPENDENT TWINKLE IS THE WHOLE EFFECT (plan §3.4: "a static
  // sparkle texture reads as noise"). Two things produce it, and neither is the
  // clock: (a) the lobe exponent is enormous (uSnowSparkleSharpness, 420 vs
  // sand's 180), so a crystal flashes only when the sun/eye half-vector lands
  // almost exactly on its facet -- walking or turning sweeps the half-vector
  // across the field and different crystals pop; (b) the facet normals have a
  // WIDE spread about the vertical, unlike sand's, because snow crystals lie at
  // every angle and a flash must be able to come from any direction. The uTime
  // term only keeps a STANDING camera from freezing into a static dot pattern.
  //
  // NO GRAZING GATE, deliberately -- that is sand's signature (dune faces catch
  // the light at a low angle). Snow glitters from directly above too, and
  // gating it out would remove the effect exactly where a walking player sees
  // the ground.
  //
  // WHERE IT SITS AND WHY: after the POM march with its crystal field anchored
  // to the PARALLAX-CORRECTED point (plan §2.7.3 point 2), honouring the
  // cellTouchesWater bypass, multiplied by cloudShadow * csmShadow (a sparkle
  // is sunlight -- it must go out under a cloud), and EMISSIVE-ONLY: it is
  // ADDED through iblSpec and never touches albedo, cellUv or any water term.
  // Nothing in this block reads uPomEnabled, so the mid degrade is the same
  // sparkle on an unrelieved surface.
  if (uSnowSparkleEnabled > 0.5 && snowW > 0.0 && !cellTouchesWater) {
    float snowFade = 1.0 - smoothstep(uSnowSparkleFadeStart, uSnowSparkleFadeEnd, vViewDepth);
    if (snowFade > 0.001) {
      vec3 snowViewW = normalize(vWorldPos - cameraPosition);
      vec3 snowViewAc = vec3(snowViewW.x, -snowViewW.z, snowViewW.y);
      // POM-corrected AC ground position, quantised to crystal cells.
      vec2 snowShift = (cellUv - vec2(fu, fv)) * 24.0;
      vec2 crystalXy = (vec2(vWorldPos.x, -vWorldPos.z) + snowShift) * uSnowSparkleDensity;
      vec2 ccell = floor(crystalXy);
      float ch1 = fragHash21(ccell);
      float ch2 = fragHash21(ccell + vec2(19.3, 71.9));
      float ch3 = fragHash21(ccell + vec2(53.1, 7.7));
      vec3 crystalN = normalize(vec3((ch1 - 0.5) * 2.4, (ch2 - 0.5) * 2.4, 0.45 + ch3 * 1.1));
      vec3 snowHalfAc = normalize(sunDir - snowViewAc);
      float snowLobe = pow(clamp(dot(crystalN, snowHalfAc), 0.0, 1.0), uSnowSparkleSharpness);
      // glint.js's phase term: deterministic in (uTime + hash), no Math.random
      // equivalent. Floored at 0.3 so a flashing crystal is never fully erased
      // by the clock -- the camera owns the twinkle, the clock only animates it.
      float snowPhase = uTime * 1.1 + ch1 * 6.2831853 + ch2 * 23.0;
      float snowTwinkle = 0.3 + 0.7 * (0.5 + 0.5 * sin(snowPhase));
      iblSpec += uAcSunColor * (uSnowSparkleStrength * snowW * snowFade
                                * snowLobe * snowTwinkle)
               * cloudShadow * csmShadow;
    }
  }

  // === Wave 2A — ICE MATERIAL TREATMENT (plan §3.4 item 4) ===============
  // Codes 2 (Ice) and 27 (BlueIce) ONLY -- never 15 (Snow). Roughness DOWN,
  // specular UP, plus an env term off the ?ibl cube (scene3d/ibl_environment.js
  // pushes uEnvCube / uIblEnabled / uEnvIntensity over scene3d.terrainMaterials
  // every frame, so bake order never matters).
  //
  // It lives HERE, next to the water sheen and OUTSIDE the uPbrEnabled block,
  // for the reason the 07-31 water fix moved the sheen out: retail Gouraud
  // (?terrainGouraud) is DEFAULT-ON and wins the !acGouraud test, so anything
  // inside that block never executes in a normal session. The PBR path's
  // data-driven env term already glosses ice via the nra roughness map when it
  // does run; this is the term that runs in BOTH shading modes, and it is
  // ADDITIVE, so the two compose rather than fight.
  //
  // No new light (§5.2), no new geometry, no program-key change: it is a
  // fragment term weighted by the bilinear iceW.
  if (uIceEnabled > 0.5 && iceW > 0.0 && !cellTouchesWater) {
    // A gentle high-frequency surface perturbation so the glint has structure
    // (pack ice is not a mirror). Same coherent value-noise field the water
    // sheen gradients, at a much finer scale and NOT scrolled -- ice is still.
    vec2 iuv = vec2(vWorldPos.x, -vWorldPos.z) * 1.7;
    float ih0 = fragValueNoise2D(iuv);
    float ihx = fragValueNoise2D(iuv + vec2(0.6, 0.0));
    float ihy = fragValueNoise2D(iuv + vec2(0.0, 0.6));
    float iceRough = 1.0 - clamp(uIceGloss, 0.0, 1.0);
    vec3 iceN = normalize(vec3((ih0 - ihx) * 0.5, (ih0 - ihy) * 0.5, 1.0));
    vec3 iceViewW = normalize(vWorldPos - cameraPosition);
    vec3 iceViewAc = vec3(iceViewW.x, -iceViewW.z, iceViewW.y);
    vec3 iceHalfAc = normalize(sunDir - iceViewAc);
    // Low roughness = a TIGHT lobe. Driven off uIceGloss so one uniform moves
    // both the glint sharpness and the env mip together, which is what
    // "roughness down" means physically.
    float iceLobe = pow(clamp(dot(iceN, iceHalfAc), 0.0, 1.0),
                        mix(24.0, 220.0, clamp(uIceGloss, 0.0, 1.0)));
    vec3 iceSpec = uAcSunColor * (iceLobe * uIceSpecStrength);
    if (uIblEnabled > 0.5) {
      // ac(x,y,z) -> world(x,z,-y), the same space bridge the PBR env term and
      // the water sheen use. Low mip = near-mirror; roughness pushes it up the
      // chain, which is the correct pre-filter as the footprint shrinks.
      vec3 iceNWorld = normalize(vec3(iceN.x, iceN.z, -iceN.y));
      vec3 iceRefl = reflect(iceViewW, iceNWorld);
      vec3 iceEnv = textureLod(uEnvCube, iceRefl, iceRough * 5.0).rgb;
      float iceFres = 0.04 + 0.96 * pow(1.0 - clamp(dot(-iceViewW, iceNWorld), 0.0, 1.0), 5.0);
      iceSpec += iceEnv * iceFres * uEnvIntensity * uIceEnvStrength;
    }
    iblSpec += iceSpec * iceW;
  }

  // === Wave 3B — WET MUD SHEEN (plan §3.7 items 2 + 4) ===================
  // The second half of vfx/components/wetness.js's response curve. That
  // component's other seam is:
  //     roughnessFactor *= mix(1.0, uWetRoughDrop, _vfxWetAmt)
  // i.e. wet surfaces keep a QUARTER of their dry roughness. This shader has no
  // roughnessFactor to scale in the shading mode that actually runs (the nra
  // roughness is read only inside the uPbrEnabled && !acGouraud block, which
  // retail Gouraud — DEFAULT-ON — makes dead; the same reason the 07-31 water
  // fix lifted the sheen out and wave 2A put the ice treatment here). So the
  // drop is applied to a CONSTANT dry roughness and then spent the way the ice
  // treatment spends its gloss: a Blinn sun lobe whose exponent tracks the
  // roughness, plus an env reflection off the ?ibl cube at a matching mip. Same
  // curve, same numbers, expressed in the terms this shader has.
  //
  // CLAY is SLICKER (plan §3.7): uClayWetGloss lifts the roughness drop further
  // on the strict-subset clayW, so Argila glazes while PatchyDirt only damps.
  //
  // It sits HERE, next to the water sheen and the ice treatment and OUTSIDE the
  // PBR block, for the reason above; it honours the cellTouchesWater bypass
  // (a shoreline mud cell must not gloss THROUGH the water surface the water
  // agent owns); it adds NO light (§5.2) and no geometry; and it is ADDED
  // through iblSpec, so it touches no albedo, no cellUv and no water term and
  // the final fragColor line is untouched. mudWetAmt is the SAME weight the
  // darkening above used, so the two halves can never disagree.
  if (uMudWetEnabled > 0.5 && mudWetAmt > 0.0 && !cellTouchesWater) {
    // wetness.js: roughnessFactor *= mix(1.0, uWetRoughDrop, amt). Clay drops
    // further still.
    float clayDrop = uMudWetRoughDrop * (1.0 - clamp(uClayWetGloss, 0.0, 1.0) * clayW);
    float mudRough = uMudBaseRough * mix(1.0, clayDrop, clamp(mudWetAmt, 0.0, 1.0));
    mudRough = clamp(mudRough, 0.02, 1.0);
    // A fine, still surface perturbation so the sheen has structure: wet earth
    // is not a mirror. The same coherent value-noise field the ice treatment
    // and the water sheen gradient, unscrolled (mud does not flow).
    vec2 muv = vec2(vWorldPos.x, -vWorldPos.z) * 2.6;
    float mh0 = fragValueNoise2D(muv);
    float mhx = fragValueNoise2D(muv + vec2(0.55, 0.0));
    float mhy = fragValueNoise2D(muv + vec2(0.0, 0.55));
    vec3 mudN = normalize(vec3((mh0 - mhx) * 0.35, (mh0 - mhy) * 0.35, 1.0));
    vec3 mudViewW = normalize(vWorldPos - cameraPosition);
    vec3 mudViewAc = vec3(mudViewW.x, -mudViewW.z, mudViewW.y);
    vec3 mudHalfAc = normalize(sunDir - mudViewAc);
    float mudLobe = pow(clamp(dot(mudN, mudHalfAc), 0.0, 1.0),
                        mix(12.0, 160.0, 1.0 - mudRough));
    vec3 mudSpec = uAcSunColor * (mudLobe * uMudWetSpec);
    if (uIblEnabled > 0.5) {
      // ac(x,y,z) -> world(x,z,-y), the same space bridge the PBR env term, the
      // water sheen and the ice treatment use.
      vec3 mudNWorld = normalize(vec3(mudN.x, mudN.z, -mudN.y));
      vec3 mudRefl = reflect(mudViewW, mudNWorld);
      vec3 mudEnv = textureLod(uEnvCube, mudRefl, mudRough * 5.0).rgb;
      float mudFres = 0.04 + 0.96 * pow(1.0 - clamp(dot(-mudViewW, mudNWorld), 0.0, 1.0), 5.0);
      mudSpec += mudEnv * mudFres * uEnvIntensity * uMudWetEnv;
    }
    iblSpec += mudSpec * mudWetAmt;
  }

  // === Wave 1B — SAND GRAIN SPARKLE ======================================
  // Terrain-VFX plan §3.2 item 4. Millions of quartz facets, each catching the
  // sun for an instant as the eye moves: a grazing-angle, per-grain-cell
  // specular twinkle. The maths is the vfx/components/glint.js lobe (a Blinn
  // half-vector power) with the metalness gate replaced by the SAND FRACTION
  // and the per-instance hash replaced by a per-grain-cell hash.
  //
  // WHERE IT SITS AND WHY (plan §2.7.3):
  //   • AFTER the POM march, and its grain field is anchored to the
  //     PARALLAX-CORRECTED surface point — vWorldPos is the geometric (pre-POM)
  //     position, so the POM offset (cellUv - the original vec2(fu, fv)) is
  //     added back in cell units x 24 m. Without that, the sparkle would slide
  //     against the relief it is supposed to be sitting on, which is exactly
  //     the registration bug the 07-31 water fix closed (plan §8 risk 14).
  //   • It HONOURS the cellTouchesWater bypass. POM does not run on a
  //     water-touching cell, so on those cells the correction term is zero
  //     anyway — but a shoreline sand cell must not sparkle THROUGH the water
  //     surface the water agent owns, so the whole term stands down there.
  //   • It is added AFTER cloudShadow / csmShadow are resolved and is
  //     MULTIPLIED by both: a sparkle is sunlight, so it must go out under a
  //     cloud and inside a building's shadow.
  //   • It never touches cellUv, waterCellUv, waterW or any water uniform.
  // The mid-tier degrade is coherent by construction: POM is high/ultra only,
  // and with POM off the correction term is exactly zero, leaving the same
  // sparkle on an unrelieved surface (plan §2.7.3 point 4).
  vec3 sandSparkle = vec3(0.0);
  if (uSandSparkleEnabled > 0.5 && sandW > 0.0 && !cellTouchesWater) {
    float sparkFade = 1.0 - smoothstep(uSandSparkleFadeStart, uSandSparkleFadeEnd, vViewDepth);
    if (sparkFade > 0.001) {
      // View direction in AC space (z-up): world(x,y,z) = ac(x,z,-y).
      vec3 viewW = normalize(vWorldPos - cameraPosition);
      vec3 viewAc = vec3(viewW.x, -viewW.z, viewW.y);
      // GRAZING GATE: 1 when the eye skims the surface, 0 looking straight
      // down. Real sand only flashes at a low angle; without this the whole
      // dune glitters from above and reads as noise.
      float graze = 1.0 - clamp(dot(geomN, -viewAc), 0.0, 1.0);
      graze = graze * graze;
      if (graze > 0.001) {
        // POM-corrected AC ground position, then quantised to grain cells.
        vec2 pomShift = (cellUv - vec2(fu, fv)) * 24.0;
        vec2 grainXy = (vec2(vWorldPos.x, -vWorldPos.z) + pomShift) * uSandSparkleDensity;
        vec2 gcell = floor(grainXy);
        float gh1 = fragHash21(gcell);
        float gh2 = fragHash21(gcell + vec2(37.7, 11.3));
        // A hashed micro-facet about the vertical. Amplitude is deliberately
        // wide: a facet that never faces the half-vector never flashes.
        vec3 grainN = normalize(vec3((gh1 - 0.5) * 1.6, (gh2 - 0.5) * 1.6, 1.0));
        vec3 halfAc = normalize(sunDir - viewAc);
        float lobe = pow(clamp(dot(grainN, halfAc), 0.0, 1.0), 180.0);
        // glint.js's phase term: time + hash, so a facet twinkles rather than
        // holding a constant highlight. Deterministic (uTime + hash only).
        float phase = uTime * 1.7 + gh1 * 6.2831853 + gh2 * 17.0;
        float twinkle = 0.5 + 0.5 * sin(phase);
        sandSparkle = uAcSunColor * (uSandSparkleStrength * sandW * graze
                                     * sparkFade * lobe * twinkle);
      }
    }
  }

  fragColor = vec4(modulated * ndotl * cloudShadow * csmShadow + iblSpec
                   + sandSparkle * cloudShadow * csmShadow, 1.0);
}
`;

/**
 * Read `subdivLevel` from `scene3d.quality.flags`, defaulting to 1 if
 * the flag is missing or out of range. Quality preset values are 1, 2,
 * 4, or 8; we coerce any other value to the nearest power-of-two bound.
 */
function pickSubdivLevel(scene3d) {
  const raw = scene3d?.quality?.flags?.subdivLevel;
  if (!Number.isFinite(raw) || raw <= 1) return 1;
  if (raw >= 8) return 8;
  if (raw >= 4) return 4;
  if (raw >= 2) return 2;
  return 1;
}

/**
 * 2026-07-31 (water-fix) — the shared terrain wall-clock in seconds, read
 * from the same `scene3d.frameTime.tsSec` snapshot `loop.js::tickTerrainUTime`
 * pushes onto every material each rAF. Used to SEED a freshly built material's
 * `uTime` so it is phase-locked with its already-resident neighbours on its
 * very first drawn frame instead of starting at 0.
 *
 * Falls back to a fresh `performance.now()` (and finally 0) so the Node test
 * harness and any pre-loop bake still get a sane value. Exported for tests.
 */
export function sharedTerrainTimeSec(scene3d) {
  const snap = scene3d?.frameTime?.tsSec;
  if (Number.isFinite(snap)) return snap;
  if (typeof performance !== "undefined" && performance.now) {
    return performance.now() * 0.001;
  }
  return 0;
}

/**
 * Phase 2.2 — pack a Set<int> of terrain codes into a 32-bit bitmask.
 * Bit `i` is set if code `i` is in the set. Used by the vertex shader's
 * displacement branch (`(uWaterCodeMask & (1 << code)) != 0`) so the
 * GLSL stays free of per-code if/elif chains.
 *
 * Exported for direct unit testing; the production caller is
 * `buildHoltburgTerrain`.
 */
export function computeCodeBitmask(codeSet) {
  let mask = 0;
  for (const code of codeSet) {
    if (Number.isInteger(code) && code >= 0 && code < 32) {
      mask = (mask | (1 << code)) >>> 0;
    }
  }
  // GLSL `int` is signed 32-bit; convert via >>> 0 then |0 so the
  // top bit, if ever set, round-trips correctly through three.js's
  // setUniform path.
  return mask | 0;
}

// Phase 2.2 — exported for tests + capture-script probes.
export const PHASE_2_2_WATER_CODES = TERRAIN_WATER_CODES;
// 2026-07-31 (water-fix) — the wider fragment-side surface set.
export const WATER_SURFACE_CODES = TERRAIN_WATER_SURFACE_CODES;
export const PHASE_2_2_LAVA_CODES = TERRAIN_LAVA_CODES;


// ----- world-expand step 1 — once-per-ring shader uniform constants
//
// Shared by every per-LB material the ring bakes. Lifted out of the
// inner loop so the ring driver builds them once and threads them via
// `opts` to `bakeTerrainForLandblock` rather than recomputing per LB.

/**
 * Resolve the once-per-ring opts the per-LB baker consumes. Reads
 * quality flags / detail-normal array off `scene3d`, computes the
 * shared bitmasks, and (optionally) builds the atlas + road textures
 * from the wasm `fetch_terrain_textures()` payload.
 *
 * Callers that already have an atlas/road texture pair (e.g. the lazy
 * hook reusing a previously baked ring's textures) should pass them via
 * `existing.atlasTexture` / `existing.roadTexture` / `existing.roadCanvas`
 * to skip the texture build.
 *
 * `centreLbX` / `centreLbY` are used by the centre-vs-outer subdivision
 * LOD rule preserved from the prior `buildHoltburgTerrain` body. The
 * distance-keyed LOD generalisation is Objective 7's job, not this
 * objective's.
 */
export async function resolveTerrainRingOpts(
  scene3d,
  wasmExports,
  centreLbX,
  centreLbY,
  existing
) {
  // 2026-05-22 — wire-agent short-circuit. Terrain bake uses a shared
  // `MeshBasicMaterial({vertexColors:true})` (solid fill driven by the
  // 32-entry TERRAIN_CODE_TO_RGB palette) + a shared wireframe overlay
  // material, neither of which sample the atlas / road / detail-normal
  // arrays. Skipping `wasmExports.fetch_terrain_textures()` +
  // `buildTerrainAtlasArrayBytes` + the 33-layer DataArrayTexture
  // upload + the road CanvasTexture removes the ~840ms silent gap
  // between phase6.D cellgraph drain and bakeStaticsRing entry that
  // the post-cellgraph-fix boot profile (2026-05-22) surfaced. Also
  // forces `canSubdivide=false` — the 24m control mesh is plenty for
  // wire-mode visual rough-shape, and skipping the subdivision wasm
  // batch shaves another fetch off the critical path even at
  // ?quality=mid/high/ultra in wire mode.
  if (scene3d?.wireframeMode) {
    return {
      centreLbX,
      centreLbY,
      playerLbKey:
        typeof scene3d?.playerLbKey === "number" ? scene3d.playerLbKey : null,
      initialCentreLbKey:
        typeof scene3d?.initialCentreLbKey === "number"
          ? scene3d.initialCentreLbKey
          : null,
      detailNormalEnabled: false,
      detailNormalArrayTex: null,
      slopeShadingEnabled: false,
      triplanarEnabled: false,
      triplanarSlopeLo: 0.3,
      codeToSliceArr: null,
      subdivLevel: 1,
      canSubdivide: false,
      displacementEnabled: false,
      // 2026-07-31 (water-fix) — present + off for shape parity with the full
      // return below (wire mode builds a MeshBasicMaterial, never the water
      // shader), so a reader can compare the two objects field-for-field.
      waterScrollEnabled: false,
      waterCodeMask: 0,
      waterSurfaceCodeMask: 0,
      lavaCodeMask: 0,
      // Wave 1B — present + off for shape parity with the full return below
      // (wire mode builds a MeshBasicMaterial, never the terrain shader; the
      // whole terrain-VFX programme is a hard no-op under ?wireframe=1 anyway,
      // enforced once in terrain_vfx.js::wireframeActive — plan §8 risk 8).
      sandSparkleEnabled: false,
      sandSparkleCodeMask: 0,
      // Wave 2A — present + off for shape parity, same reasoning as the sand
      // row above (wire mode builds a MeshBasicMaterial, and terrain VFX is a
      // hard no-op under ?wireframe=1 anyway — plan §8 risk 8).
      snowSparkleEnabled: false,
      snowSparkleCodeMask: 0,
      snowPrintEnabled: false,
      iceEnabled: false,
      iceCodeMask: 0,
      iceRefractionEnabled: false,

      // Wave 2B — same shape-parity contract as the sand pair above.
      crackGlowEnabled: false,
      volcanoCodeMask: 0,
      obsidianCodeMask: 0,
      atlasTexture: null,
      roadTexture: null,
      roadCanvas: null,
      // T1 — wire mode never builds the terrain ShaderMaterial; keep the
      // base-tiling field present + null for shape parity (binds the 1×
      // fallback if a path ever reads it).
      baseTexTiling: null,
      // Wave 2.A — wire-agent uses MeshBasicMaterial with vertexColors
      // (TERRAIN_CODE_TO_RGB drives the per-vertex colour attribute);
      // no shader-side palette texture needed.
      terrainPaletteTexture: null,
      terrainPaletteStrength: 0,
      // T7 — wire mode never builds the terrain ShaderMaterial; keep the
      // detail-tex fields present + disabled for shape parity with the
      // full return below.
      detailTexArray: null,
      detailTexCodeToSlice: null,
      detailTexCodeTiling: null,
      detailTexSliceCount: 0,
      detailTexEnabled: false,
      // T1 — wire mode never builds the terrain ShaderMaterial.
      texMergeAlphaArray: null,
      texMergeEnabled: false,
      // T2 — wire mode never builds the terrain ShaderMaterial.
      pbrEnabled: false,
      pbrNormalAoTex: null,
      waterEnvEnabled: false,
      splatNoiseAmp: 0,
      splatNoiseFreq: 0.35,
      splatMacroAmp: 0,
      splatMacroFreq: SPLAT_MACRO_FREQ_DEFAULT,
      pomEnabled: false,
      // FAR MACRO — wire mode never builds the terrain ShaderMaterial.
      macroTex: null,
      macroSliceLut: null,
      macroSliceCount: 0,
      macroEnabled: false,
    };
  }

  // Phase 1.2 — terrain detail normal array. Loaded once in index.js
  // and stashed on scene3d, gated behind `quality.flags.terrainDetailNormal`.
  // When the flag is off, `terrainDetailNormalArray` is null and the
  // ShaderMaterial uniforms get the fallback (uDetailNormalEnabled = 0).
  const detailNormalEnabled =
    !!scene3d.quality?.flags?.terrainDetailNormal &&
    !!scene3d.terrainDetailNormalArray;
  const detailNormalArrayTex = detailNormalEnabled
    ? scene3d.terrainDetailNormalArray
    : null;
  // Phase 1.3 — slope-gated triplanar mapping on the detail normal
  // layer. Requires Phase 1.2's array texture to be loaded; off if
  // either the triplanar flag is off OR the detail normal isn't
  // wired (no point triplanar-sampling a no-op).
  const triplanarEnabled =
    !!scene3d.quality?.flags?.triplanar && detailNormalEnabled;
  // Perf D3 — slope LO threshold derived from the quality preset
  // (0..100 int → 0.0..1.0 float). Defensive fallback to 30 (= 0.3)
  // mirrors the high/ultra preset and the audit's documented gate.
  const triplanarSlopeThresholdPct =
    Number.isFinite(scene3d?.quality?.flags?.triplanarSlopeThresholdPct)
      ? scene3d.quality.flags.triplanarSlopeThresholdPct
      : 30;
  const triplanarSlopeLo = triplanarSlopeThresholdPct / 100.0;
  // Per-ring codeToSlice uniform array — int[32] keyed by terrain
  // code. Built once and shared by reference across every LB material.
  const codeToSliceArr = Array.from(TERRAIN_CODE_TO_DETAIL_SLICE).map(
    (slice) => (slice === DETAIL_SLICE_NONE ? 255 : slice)
  );

  // Phase 2.1 — read subdivision level from the resolved quality preset.
  // The flag is `subdivLevel: 1|2|4|8`. Default to 1 (no subdivision) if
  // the flag is missing or the wasm export hasn't been built yet (e.g.
  // tests stubbing wasmExports).
  const subdivLevel = pickSubdivLevel(scene3d);
  // 2026-06-26: route subdivLevel=1 through the subdivided path too (factor=1).
  // It returns the same 9×9 grid as build_mesh BUT with seam-continuous
  // cross-LB normals + faceted (collision-exact) positions, so the base path
  // no longer shows a lighting seam at every 192 m landblock boundary.
  const canSubdivide =
    subdivLevel >= 1 &&
    typeof wasmExports.fetch_subdivided_landblocks === "function";

  // Phase 2.2 — animated water/lava displacement.
  // 2026-07-31 (water-fix) — the `subdivLevel >= 2` quality gate is GONE.
  // It existed because a raw per-vertex sine needs sub-cell vertices to look
  // like a wave; the swell is now evaluated on the 24 m control lattice and
  // bilinearly interpolated (waterSwellLattice), so factor 1, 2, 4 and 8 all
  // reproduce the SAME surface. Keeping the gate only meant (a) no rise/fall
  // at all on quality low/mid, and (b) — worse — the distance >= 2 rings and
  // the player's own LB producing DIFFERENT surfaces from the same uniform,
  // which is what tore open water along the moving LOD boundary.
  // `?waterWave=off` is the rollback escape. Materials still bind `uTime` /
  // `uDisplacementEnabled` so the JS tick can flip the gate live.
  const displacementEnabled = readWaterWaveFlag();
  const waterCodeMask = computeCodeBitmask(TERRAIN_WATER_CODES);
  // 2026-07-31 (water-fix) — wider SURFACE set (adds 22 FauxWaterRunning);
  // see TERRAIN_WATER_SURFACE_CODES for why the two sets differ.
  const waterSurfaceCodeMask = computeCodeBitmask(TERRAIN_WATER_SURFACE_CODES);
  const lavaCodeMask = computeCodeBitmask(TERRAIN_LAVA_CODES);

  // Atlas + road textures. Built from `fetch_terrain_textures()` when
  // the caller didn't pass a previously-baked pair. The lazy LB-entry
  // path (added in Objective 5/6) will pass the previously-baked
  // textures here so we don't redo the bake work.
  let atlasTexture = existing?.atlasTexture ?? null;
  let roadTexture = existing?.roadTexture ?? null;
  let roadCanvas = existing?.roadCanvas ?? null;
  if (!atlasTexture) {
    const terrainTextures = await wasmExports.fetch_terrain_textures();
    const built = buildTerrainAtlasArrayBytes(terrainTextures);
    roadCanvas = built.roadCanvas;

    // ?terrainBc7=on (DEFAULT OFF) — retail-derived BC7 atlas arm. Resolved
    // FIRST because it is mutually exclusive with the CC0 arm below: both write
    // the albedo of the same 33 layers, and running both would mean one silently
    // overwriting the other. Null for every failure reason (flag off, no BPTC,
    // no bake, a missing/garbled/off-dimension payload) → the CC0 + retail RGBA8
    // path below runs exactly as it does today. Cached on scene3d so a ring
    // rebuild reuses the arrays instead of refetching ~20 MB of blocks —
    // `undefined` means NOT YET ATTEMPTED and `null` means ATTEMPTED AND FAILED,
    // so a failure is remembered rather than re-hammering the endpoint on every
    // rebuild (the same negative-caching contract Bc7RecordSource uses).
    let bc7Atlas = scene3d.terrainBc7State;
    if (terrainBc7Enabled() && bc7Atlas === undefined) {
      try {
        bc7Atlas = await buildTerrainBc7Atlas({
          anisotropy: getAdapterMaxAnisotropy(),
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[terrain-bc7] build failed (RGBA8/CC0 path):", e);
        bc7Atlas = null;
      }
      scene3d.terrainBc7State = bc7Atlas;
      if (typeof window !== "undefined") {
        window.__terrainBc7Stats = () => terrainBc7Stats();
      }
    }
    const bc7Active = !!bc7Atlas?.atlasTexture;
    if (bc7Active) {
      // The nra array is derived from the SAME retail albedo (normal XY,
      // roughness, AO), so uPbrEnabled can stay on with everything registered.
      // If the nra channel failed to load we deliberately leave the PBR gate
      // OFF rather than pairing retail albedo with the CC0 normals — that
      // mismatch is the whole reason this arm derives its own.
      scene3d.pbrTerrainState = bc7Atlas.nraTexture
        ? { nraTex: bc7Atlas.nraTexture, applied: 33, bc7: true }
        : null;
    }

    // T2 (?pbrTerrain=on) — curated CC0 layer set. Loaded once per session
    // and cached on scene3d (the lazy LB-entry path reuses atlasTexture AND
    // this state). Albedo overrides are written into the atlas bytes BEFORE
    // the DataArrayTexture upload so every blend path (bilinear / winner /
    // texMerge / road slots) uses the new colour with zero shader changes;
    // uncurated layers (water ×6, olthoi) keep their retail bytes. Load
    // failure → null state → uPbrEnabled 0 → retail render, no-op.
    if (!bc7Active && readPbrTerrainFlag() && !scene3d.pbrTerrainState) {
      try {
        const pbrSet = await loadPbrTerrainAtlasSet({ tileSize: built.tileSize });
        if (pbrSet) {
          const applied = applyPbrColorOverrides(
            built.atlasArrayBytes,
            built.tileSize,
            pbrSet
          );
          const nraTex = buildPbrNraTexture(pbrSet);
          scene3d.pbrTerrainState = { nraTex, applied };
          // eslint-disable-next-line no-console
          console.log(
            `[pbr-terrain] ${applied} CC0 albedo layers applied, ` +
              `normal+AO array ${pbrSet.tileSize}px × 33`
          );
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[pbr-terrain] load failed (retail render):", e);
        scene3d.pbrTerrainState = null;
      }
    }

    // 2026-05-28 — TerrainTex vertex-modulation ranges. Six u32s per
    // terrain type (33 × 6 = 198 values): min/max for brightness,
    // saturation, hue. Authored deliberately in retail (Ice=2 and
    // RoadType=32 are dramatic outliers vs natural-terrain default
    // 90..100 brightness); acclient.c never applied them — likely a
    // cut feature — but the values let us "alive" the author intent
    // as a per-vertex HSL nudge. Fetch once and stash on scene3d so
    // per-LB bake can mint vertexBrightness attributes without
    // re-fetching. Failure falls back to a 198-zero buffer (treated
    // as "no modulation, pass through" downstream).
    if (typeof wasmExports.fetch_terrain_modulation_ranges === "function") {
      try {
        const raw = await wasmExports.fetch_terrain_modulation_ranges();
        scene3d.terrainModulationRanges = new Uint32Array(raw);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[terrain] fetch_terrain_modulation_ranges failed:", e);
        scene3d.terrainModulationRanges = new Uint32Array(33 * 6);
      }
    } else {
      scene3d.terrainModulationRanges = new Uint32Array(33 * 6);
    }

    // Per-code layer of a `sampler2DArray`. Replaces the prior
    // `CanvasTexture` of a 6x6 packed atlas (1536x1536); the packed
    // atlas had no inter-tile gutter so the GPU's bilinear+mipmap
    // sampler bled neighbouring slots' colours into each cell at
    // mip levels >=3 — the bleed line landed on the 24 m cell vertex
    // grid, which the user described as "terrain textures not flush
    // with vertices". DataArrayTexture clamps integer layer
    // selection per-sample so cross-tile bleed is structurally
    // impossible at any mip level, and each layer carries its own
    // mipmap chain.
    atlasTexture = new THREE.DataArrayTexture(
      built.atlasArrayBytes,
      built.tileSize,
      built.tileSize,
      built.depth
    );
    atlasTexture.format = THREE.RGBAFormat;
    atlasTexture.type = THREE.UnsignedByteType;
    // sRGB so three.js linearises tile colours before the fragment
    // shader's bilinear-on-control corner blend (same colour-space
    // contract the prior CanvasTexture path had).
    atlasTexture.colorSpace = THREE.SRGBColorSpace;
    atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
    atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
    atlasTexture.magFilter = THREE.LinearFilter;
    atlasTexture.minFilter = THREE.LinearMipmapLinearFilter;
    atlasTexture.generateMipmaps = true;
    atlasTexture.anisotropy = getAdapterMaxAnisotropy();
    atlasTexture.needsUpdate = true;

    // ?terrainBc7=on — swap in the compressed array. Done AFTER the RGBA8 build
    // rather than instead of it, on purpose: `built.atlasArrayBytes` is needed
    // for `roadCanvas` regardless, and leaving the default construction path
    // untouched means the flag-off render cannot regress. The RGBA8 twin is
    // disposed here and was never bound, so three never uploads it —
    // `needsUpdate` only marks; the upload happens at first render.
    if (bc7Active) {
      atlasTexture.dispose();
      atlasTexture = bc7Atlas.atlasTexture;
    }

    if (roadCanvas) {
      roadTexture = new THREE.CanvasTexture(roadCanvas);
      roadTexture.colorSpace = THREE.SRGBColorSpace;
      roadTexture.wrapS = THREE.RepeatWrapping;
      roadTexture.wrapT = THREE.RepeatWrapping;
      roadTexture.magFilter = THREE.LinearFilter;
      roadTexture.minFilter = THREE.LinearMipmapLinearFilter;
      roadTexture.generateMipmaps = true;
      roadTexture.anisotropy = getAdapterMaxAnisotropy();
      // Same flipY=false as the atlas above — the road tile is a single
      // sub-image with RepeatWrapping; flipY=true would vertically
      // mirror the tile and rotate any directional road art (arrows /
      // gravel direction) 180°. Matches adapter.js convention.
      roadTexture.flipY = false;
      roadTexture.needsUpdate = true;
    }
  }

  // world-expand step 1 Objective 7 — distance-keyed subdivision LOD
  // reads its reference LB off `playerLbKey` (preferred) or
  // `initialCentreLbKey` (fallback), both optional fields on scene3d.
  // Threaded through opts so `pickSubdivLevelForLb` stays a pure fn of
  // its inputs (easier to unit-test from outside a ring driver).
  const playerLbKey =
    typeof scene3d?.playerLbKey === "number" ? scene3d.playerLbKey : null;
  const initialCentreLbKey =
    typeof scene3d?.initialCentreLbKey === "number"
      ? scene3d.initialCentreLbKey
      : null;

  // Wave 2.A — terrain palette LUT. Memoised loadTerrainPaletteLut()
  // returns a cached `{ texture, rgba }` after the first session-wide
  // fetch + DataTexture upload, so subsequent ring rebuilds re-use
  // the same texture. Null on fetch failure → uTerrainPaletteEnabled
  // falls back to 0 and the atlas-only path renders unchanged.
  let terrainPaletteTexture = null;
  try {
    const paletteLut = await loadTerrainPaletteLut();
    if (paletteLut?.texture) terrainPaletteTexture = paletteLut.texture;
  } catch (_) {
    // Already logged inside the loader; suppress to keep the boot path
    // resilient.
  }

  // T1 (2026-05-29) — base terrain tex_tiling LUT (DEFAULT-ON, fail-soft).
  // Retail TerrainTex.tex_tiling == 2 for all 33 types; atlasUvFor applies it
  // as fract(cellUv * tiling) so each base tile shows the retail 2×2 spatial
  // replication TexMerge::TileCSI bakes (acclient.c:365513) instead of one
  // ~2×-too-large copy. LB-independent → fetched once + cached on scene3d
  // (like the detail/palette LUTs). Missing export or fetch failure → null →
  // the BASE_TEX_TILING_FALLBACK (now all 2, the verified retail value) binds,
  // so a fetch failure still renders at the correct 2× tiling.
  let baseTilingLut = scene3d.terrainBaseTilingLut ?? null;
  if (
    !baseTilingLut &&
    typeof wasmExports.fetch_terrain_base_tex_tiling === "function"
  ) {
    try {
      const lut = await wasmExports.fetch_terrain_base_tex_tiling();
      // Uint32Array(33) → plain number array for the GLSL int[33] uniform.
      const arr = Array.from(lut);
      if (arr.length === 33) {
        baseTilingLut = arr;
        scene3d.terrainBaseTilingLut = baseTilingLut;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[terrain] fetch_terrain_base_tex_tiling failed:", e);
      baseTilingLut = null; // → fallback (1×) below
    }
  }

  // T7 — terrain detail-diffuse array + per-code LUTs (opt-in
  // `?terrainDetailTex=on`). Built once per session and cached on scene3d
  // (like the detail-NORMAL array), so ring rebuilds and lazy LB adds
  // re-use the same DataArrayTexture — that's why it lives OUTSIDE the
  // `if (!atlasTexture)` block (the lazy path reuses the atlas but still
  // wants the detail uniforms). Flag off, fetch missing, or build failure
  // → null state → `uDetailTexEnabled` 0 → shader branch skipped (no-op).
  // 2026-07-02 (rev 2, decomp-grounded) — RETAIL GLOBAL DETAIL is the
  // default. Retail DID ship a terrain detail texture, but NOT per-type:
  // LScape::GenerateDetailSurface(n) only ever reads TerrainDesc[0..3] as
  // CATEGORY entries (0=landscape, 1=building, 2=environment, 3=object) —
  // ONE detail texture + tiling for the whole landscape (on retail Dereth:
  // TerrainDesc[0].detail_tex_gid = 0x05001786, detail_tex_tiling = 4;
  // detail UV = cell UV x tiling per D3DPolyRender::SetDetailTiling). The
  // per-TYPE detail fields in the DAT are packed but never consumed
  // per-type by the shipped client (same fate as min/max_vert_bright —
  // dead data, Pack/UnPack only, both 2011 + 2013 decomps).
  //
  // The earlier per-code default-on (2026-06-09) FAILED its 1070 eye-test
  // today: per-code switching stamps pale razor-edged multi-cell blocks at
  // type boundaries. The retail-global mode cannot produce those by
  // construction (same texture everywhere). ?terrainDetailTex=percode
  // keeps the modern per-type variant for A/B; =off kills the layer.
  const detailTexMode = readTerrainDetailTexMode();
  const detailTexFlag = detailTexMode !== "off";
  let detailTexState = scene3d.terrainDetailTexState ?? null;
  if (
    detailTexFlag &&
    !detailTexState &&
    typeof wasmExports.fetch_terrain_detail_textures === "function"
  ) {
    try {
      const bundle = await wasmExports.fetch_terrain_detail_textures();
      const slices = bundle.takeSlices();
      // Uint32Array(33) → plain number arrays for the GLSL int[] uniforms.
      const codeToSlice = Array.from(bundle.codeToSlice());
      const codeTiling = Array.from(bundle.codeTiling());
      if (typeof bundle.free === "function") bundle.free();

      // Retail-global mode (default; see the detailTexMode comment above):
      // every code renders TerrainDesc[0]'s landscape detail slice at its
      // authored tiling — one texture, one frequency, world-wide, exactly
      // LScape::GenerateDetailSurface(0). baseScale 1.0 = retail's
      // detail-UV = cellUV x tiling (tiling 4 → 6 m period).
      // 2026-07-02 rev 3 — retail OP is an alpha CROSSFADE, not a modulate
      // (crossfade: true → uDetailTexCrossfade; see the shader comment):
      // blend weight = tile alpha (~0.21 authored) × linear 10→50 m fade.
      // strength stays 1.0 = "authored weight, unscaled".
      let detailBaseScale = DEFAULT_DETAIL_TEX_BASE_SCALE;
      let detailStrength = DEFAULT_DETAIL_TEX_STRENGTH;
      let detailFadeStart = DEFAULT_DETAIL_TEX_FADE_START;
      let detailFadeEnd = DEFAULT_DETAIL_TEX_FADE_END;
      let detailCrossfade = false;
      if (detailTexMode !== "percode" && codeToSlice[0] !== 255) {
        const s0 = codeToSlice[0];
        const t0 = codeTiling[0];
        for (let i = 0; i < codeToSlice.length; i++) {
          codeToSlice[i] = s0;
          codeTiling[i] = t0;
        }
        detailBaseScale = 1.0;
        detailStrength = 1.0;
        detailFadeStart = RETAIL_DETAIL_TEX_FADE_START;
        detailFadeEnd = RETAIL_DETAIL_TEX_FADE_END;
        detailCrossfade = true;
      }

      const built = buildTerrainDetailArrayBytes(slices);
      const tex = new THREE.DataArrayTexture(
        built.detailArrayBytes,
        built.tileSize,
        built.tileSize,
        built.depth
      );
      tex.format = THREE.RGBAFormat;
      tex.type = THREE.UnsignedByteType;
      // sRGB to match the base atlas colour-space contract (the detail
      // texel is multiplied with the linearised atlas colour in-shader).
      tex.colorSpace = THREE.SRGBColorSpace;
      // RepeatWrapping (unlike the ClampToEdge base atlas): the detail tile
      // is *meant* to tile at sub-metre frequency across each cell.
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = getAdapterMaxAnisotropy();
      tex.needsUpdate = true;

      detailTexState = {
        array: tex,
        codeToSlice, // length 33, 255 = no detail
        codeTiling, // length 33
        sliceCount: built.depth,
        baseScale: detailBaseScale,
        strength: detailStrength,
        fadeStart: detailFadeStart,
        fadeEnd: detailFadeEnd,
        crossfade: detailCrossfade,
      };
      scene3d.terrainDetailTexState = detailTexState;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[terrain] fetch_terrain_detail_textures failed:", e);
      detailTexState = null;
    }
  }

  // T1 — TexMerge alpha-mask array (opt-in `?texMerge=on`). Built once per
  // session + cached on scene3d (the 8 retail masks are LB-independent). The
  // ORDER matters: [corner0..3, side0, road0..2] so the array layer index
  // equals the `alpha_index` the Rust selection core emits. Off / fetch
  // failure → null → `uTexMergeEnabled` 0 → the bilinear path runs unchanged.
  const texMergeFlag = readTexMergeFlag();
  let texMergeState = scene3d.texMergeAlphaState ?? null;
  if (
    texMergeFlag &&
    !texMergeState &&
    typeof wasmExports.fetch_terrain_alpha_masks === "function"
  ) {
    try {
      const bundle = await wasmExports.fetch_terrain_alpha_masks();
      const corner = bundle.takeCorner();
      const side = bundle.takeSide();
      const road = bundle.takeRoad();
      if (typeof bundle.free === "function") bundle.free();
      // [corner0..3, side0, road0..2] — matches alpha_index conventions.
      const ordered = [...corner, ...side, ...road];
      const built = buildAlphaMaskArrayBytes(ordered);
      const tex = new THREE.DataArrayTexture(
        built.alphaArrayBytes,
        built.tileSize,
        built.tileSize,
        built.depth
      );
      tex.format = THREE.RGBAFormat;
      tex.type = THREE.UnsignedByteType;
      // Masks are weight data, NOT colour — keep them linear (NoColorSpace)
      // so the sRGB decode three.js applies to the atlas doesn't distort the
      // blend weight. RepeatWrapping is irrelevant (UVs stay in-cell) but
      // ClampToEdge avoids any wrap artefact at the rotated mask edges.
      tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.magFilter = THREE.LinearFilter;
      // 2026-08-02 (?maskMips, DEFAULT ON) — the masks USED to ship with
      // `minFilter = LinearFilter; generateMipmaps = false` on the reasoning
      // "a mask is sampled 1:1 per cell". That holds under the camera and is
      // false everywhere else: a 24 m cell covers a handful of pixels past
      // ~200 m, so a 256² mask was being point-ish sampled far below its
      // Nyquist rate. The result is exactly the artefact the user reported —
      // distant terrain-type borders snapping to hard, hand-drawn-looking
      // lines that crawl as the camera moves. Mips + anisotropy make the
      // border resolve to its true area coverage at distance while leaving
      // mip 0 (i.e. everything near the camera) bit-identical.
      if (readMaskMipsFlag()) {
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = getAdapterMaxAnisotropy();
      } else {
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
      }
      tex.needsUpdate = true;
      texMergeState = { alphaArray: tex, count: built.depth };
      scene3d.texMergeAlphaState = texMergeState;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[terrain] fetch_terrain_alpha_masks failed:", e);
      texMergeState = null;
    }
  }

  // 2026-08-02 — FAR MACRO array (?terrainMacro, DEFAULT ON). One session-wide
  // load, cached on scene3d like every other ring texture. `undefined` means
  // NOT YET ATTEMPTED and `null` means ATTEMPTED AND FAILED, so a failure is
  // remembered instead of re-hammering the fetch on every ring rebuild (the
  // same negative-caching contract terrainBc7State uses).
  let macroState = scene3d.terrainMacroState;
  if (terrainMacroEnabled() && macroState === undefined) {
    try {
      macroState = await loadTerrainMacroArray();
      if (macroState) {
        // eslint-disable-next-line no-console
        console.log(
          `[terrain-macro] ${macroState.sliceCount} family macro maps loaded ` +
            `(fade ${readMacroFadeStart()}-${readMacroFadeEnd()} m, ` +
            `strength ${readMacroStrength()})`
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[terrain-macro] load failed (far terrain unchanged):", e);
      macroState = null;
    }
    scene3d.terrainMacroState = macroState ?? null;
  }
  if (!terrainMacroEnabled()) macroState = null;

  // Live tuning without a reload — every macro/splat knob is a plain uniform,
  // so an A/B sweep can run in ONE page load (which is what makes the arms
  // comparable: same streamed ring, same shader cache, same sky tick).
  //   window.__setTerrainMacro({ strength, start, end, scaleA, scaleB, noise,
  //                              enabled, splatMacroAmp, splatMacroFreq })
  //   window.__terrainMacroState()
  if (typeof window !== "undefined") {
    window.__setTerrainMacro = (o = {}) => {
      const mats = scene3d.terrainMaterials ?? [];
      for (const m of mats) {
        const u = m?.uniforms;
        if (!u) continue;
        if (Number.isFinite(o.strength) && u.uMacroStrength) u.uMacroStrength.value = o.strength;
        if (Number.isFinite(o.start) && u.uMacroFadeStart) u.uMacroFadeStart.value = o.start;
        if (Number.isFinite(o.end) && u.uMacroFadeEnd) u.uMacroFadeEnd.value = o.end;
        if (Number.isFinite(o.scaleA) && u.uMacroScaleA) u.uMacroScaleA.value = o.scaleA;
        if (Number.isFinite(o.scaleB) && u.uMacroScaleB) u.uMacroScaleB.value = o.scaleB;
        if (Number.isFinite(o.noise) && u.uMacroNoiseAmp) u.uMacroNoiseAmp.value = o.noise;
        if (o.enabled != null && u.uMacroEnabled) u.uMacroEnabled.value = o.enabled ? 1.0 : 0.0;
        if (Number.isFinite(o.splatMacroAmp) && u.uSplatMacroAmp) {
          u.uSplatMacroAmp.value = o.splatMacroAmp;
        }
        if (Number.isFinite(o.splatMacroFreq) && u.uSplatMacroFreq) {
          u.uSplatMacroFreq.value = o.splatMacroFreq;
        }
      }
      return mats.length;
    };
    window.__terrainMacroState = () => {
      const u = (scene3d.terrainMaterials ?? [])[0]?.uniforms;
      if (!u) return null;
      return {
        enabled: u.uMacroEnabled?.value,
        strength: u.uMacroStrength?.value,
        start: u.uMacroFadeStart?.value,
        end: u.uMacroFadeEnd?.value,
        scaleA: u.uMacroScaleA?.value,
        scaleB: u.uMacroScaleB?.value,
        noise: u.uMacroNoiseAmp?.value,
        sliceCount: u.uMacroSliceCount?.value,
        splatNoiseAmp: u.uSplatNoiseAmp?.value,
        splatMacroAmp: u.uSplatMacroAmp?.value,
        splatMacroFreq: u.uSplatMacroFreq?.value,
        materials: (scene3d.terrainMaterials ?? []).length,
      };
    };
  }

  return {
    centreLbX,
    centreLbY,
    playerLbKey,
    initialCentreLbKey,
    detailNormalEnabled,
    detailNormalArrayTex,
    triplanarEnabled,
    triplanarSlopeLo,
    codeToSliceArr,
    subdivLevel,
    canSubdivide,
    displacementEnabled,
    // 2026-07-08 — surface UV-scroll independent of the subdiv/displacement
    // LOD. Default on (`?waterScroll=off` → static water). Read once per ring;
    // toggling at runtime needs a reload.
    waterScrollEnabled: readWaterScrollFlag(),
    waterCodeMask,
    waterSurfaceCodeMask,
    lavaCodeMask,
    // Wave 1B — SAND GRAIN SPARKLE (plan §3.2 item 4). Composed exactly like
    // every other terrain-VFX gate: the FAMILY MASTER and the per-effect flag
    // (`scene3d/vfx_flags.js`, both STRICT `=== "on"` opt-ins that ship OFF),
    // so an absent flag leaves `uSandSparkleEnabled` 0.0 and the fragment block
    // is a strict no-op. The code mask is DERIVED from terrain_families.js
    // FAM_SAND through `sandCodeBitmask()` — the same "never hardcode a code
    // range" rule `uWaterSurfaceCodeMask` follows.
    sandSparkleEnabled: terrainSandEnabled() && terrainSandSparkleEnabled(),
    sandSparkleCodeMask: computeCodeBitmask(TERRAIN_SAND_CODES),
    // Wave 2A — SNOW / ICE (plan §3.4 items 2/3/4). Composed exactly like the
    // sand row: a FAMILY MASTER and a per-effect flag, both STRICT `=== "on"`
    // opt-ins that ship OFF, so an absent flag leaves every gate uniform at 0.0
    // and all three fragment blocks are strict no-ops. SNOW and ICE are two
    // INDEPENDENT masters on purpose (plan §3.4: one is particles+shader, the
    // other a material change, and bisecting them separately matters). Both
    // masks are DERIVED from terrain_families.js, never a hardcoded range.
    snowSparkleEnabled: terrainSnowEnabled() && terrainSnowSparkleEnabled(),
    snowSparkleCodeMask: computeCodeBitmask(TERRAIN_SNOW_CODES),
    // The print's SECOND gate (a trail map bound this frame) is pushed per
    // frame by scene3d/terrain_snow.js; this is only the flag.
    snowPrintEnabled: terrainSnowEnabled() && terrainSnowPrintsEnabled(),
    iceEnabled: terrainIceEnabled(),
    iceCodeMask: computeCodeBitmask(TERRAIN_ICE_MATERIAL_CODES),
    iceRefractionEnabled: terrainIceEnabled() && terrainIceRefractionEnabled(),

    // Wave 2B — VOLCANO CRACK GLOW + OBSIDIAN (plan §3.6 items 3 + 5). Composed
    // exactly like the sand gate above: the FAMILY MASTER and the per-effect
    // flag (`scene3d/vfx_flags.js`, both STRICT `=== "on"` opt-ins that ship
    // OFF), so an absent flag leaves `uCrackGlowEnabled` 0.0 and the fragment
    // block is a strict no-op. ONE gate covers both terms: they are one edit
    // and one eye-test. The masks are DERIVED — FAM_VOLCANO from
    // terrain_families.js, obsidian from the retail ObsidianPlain enum value.
    crackGlowEnabled: terrainVolcanoEnabled() && terrainCrackGlowEnabled(),
    volcanoCodeMask: computeCodeBitmask(TERRAIN_VOLCANO_CODES),
    obsidianCodeMask: computeCodeBitmask(TERRAIN_OBSIDIAN_CODES),

    // Wave 3B — MUD PRINTS + WET MUD (plan §3.7 items 2 + 4). Composed exactly
    // like every terrain-VFX gate above: the FAMILY MASTER and the per-effect
    // flag (`scene3d/vfx_flags.js`, both STRICT `=== "on"` opt-ins that ship
    // OFF), so an absent flag leaves both gate uniforms at 0.0 and all three
    // fragment blocks are strict no-ops. TWO gates, not one: the print is
    // high/ultra and the wetness is ultra-only in the plan's own tier table, and
    // they are separately bisectable for the eye-test. The print's SECOND gate
    // (a trail map bound this frame) is pushed per frame by
    // scene3d/terrain_dirt.js; this is only the flag. Both masks are DERIVED
    // from terrain_families.js, never a hardcoded range.
    mudPrintEnabled: terrainDirtEnabled() && terrainMudPrintsEnabled(),
    mudWetnessEnabled: terrainDirtEnabled() && terrainMudWetnessEnabled(),
    dirtCodeMask: computeCodeBitmask(TERRAIN_DIRT_CODES),
    clayCodeMask: computeCodeBitmask(TERRAIN_CLAY_CODES),
    atlasTexture,
    roadTexture,
    roadCanvas,
    // T1 (2026-05-29) — base tex_tiling LUT (length-33 number array; retail
    // all 2). Null when the fetch failed/export missing → the material binds
    // BASE_TEX_TILING_FALLBACK (now all 2, the retail value) → correct tiling.
    baseTexTiling: baseTilingLut ?? null,
    // Wave 2.A — terrain palette LUT + tint strength. Texture is the
    // 32×1 RGBA DataTexture built from data/terrain_palette.json;
    // strength is the default unless a future quality preset or
    // runtime slider overrides it via existing/opts.
    terrainPaletteTexture,
    // T8: opt-in only (`?terrainPalette=on`). Was on-by-default at 0.25, but it
    // sources the minimap colour (region.rs:653), not the retail terrain
    // palette — defaulting off avoids a non-faithful biome tint.
    terrainPaletteStrength: readTerrainPaletteFlag()
      ? DEFAULT_TERRAIN_PALETTE_STRENGTH
      : 0,
    // 2026-05-28 — TerrainTex modulation toggle. Off by default (the
    // shipped retail client never applied this data); flip via URL
    // flag `?terrainMod=on` to A/B test the look. The check is run
    // once per ring (not per LB) so toggling at runtime requires a
    // page reload.
    terrainModulationEnabled: readTerrainModulationFlag(),
    // R1.A 2026-05-28 — sat/hue sub-gate. Rides the master `?terrainMod`
    // flag (on -> full sat/hue + brightness by default). Can be forced
    // off for an on-GPU A/B of brightness-only via `?terrainModSatHue=off`.
    // Only meaningful when terrainModulationEnabled is true (the fragment
    // multiplies the two gates, so master-off is always a no-op).
    terrainModSatHueEnabled:
      readTerrainModulationFlag() && readTerrainModSatHueFlag(),
    // F12-3 — slope-dependent sun shading (?terrainSlopeShading=on, default
    // off). Render-pipeline change → default-off + 1070 eye-test before the
    // default flips, per the loop's flag policy.
    slopeShadingEnabled: readTerrainSlopeShadingFlag(),
    // 2026-07-02 — ?roadPaint=legacy A/B escape for the analytic road lane.
    roadPaintLegacy: readRoadPaintLegacyFlag(),
    // 2026-07-02 — ?roadSlots=on: retail TexMerge road overlay slots.
    roadSlotsEnabled: readRoadSlotsFlag(),
    // T7 — terrain detail-diffuse array + per-code LUTs (opt-in
    // `?terrainDetailTex=on`). Null array + enabled:false when off/failed →
    // shader branch skipped. codeToSlice/codeTiling are length-33 number
    // arrays (255 = no detail); the material binds them as int[33] uniforms.
    detailTexArray: detailTexState?.array ?? null,
    detailTexCodeToSlice: detailTexState?.codeToSlice ?? null,
    detailTexCodeTiling: detailTexState?.codeTiling ?? null,
    detailTexSliceCount: detailTexState?.sliceCount ?? 0,
    detailTexEnabled: !!detailTexState,
    // 2026-07-02 — retail-global detail scale/strength (1.0/1.0) vs the
    // modern per-code tuning (8.0/0.5); resolved in the state build above.
    detailTexBaseScale: detailTexState?.baseScale ?? DEFAULT_DETAIL_TEX_BASE_SCALE,
    detailTexStrength: detailTexState?.strength ?? DEFAULT_DETAIL_TEX_STRENGTH,
    // 2026-07-02 rev 3 — retail crossfade op + its 10/50 m linear fade band
    // (global mode) vs the percode MODULATE2X + 18/75 smoothstep.
    detailTexCrossfade: detailTexState?.crossfade ?? false,
    detailTexFadeStart: detailTexState?.fadeStart ?? DEFAULT_DETAIL_TEX_FADE_START,
    detailTexFadeEnd: detailTexState?.fadeEnd ?? DEFAULT_DETAIL_TEX_FADE_END,
    // T1 — TexMerge alpha-mask array + enable flag. Per-LB merge texture is
    // built in bakeTerrainForLandblock (it needs wasmMesh); this provides the
    // shared mask array + the gate. Disabled → bilinear path unchanged.
    texMergeAlphaArray: texMergeState?.alphaArray ?? null,
    texMergeEnabled: !!texMergeState,
    // T2 — PBR terrain (?pbrTerrain=on). The albedo overrides are already
    // baked into atlasTexture above; these thread the normal+AO array + the
    // gate into the per-LB materials. Null/false when the flag is off or the
    // asset bake is absent → uPbrEnabled 0 → shader branch skipped.
    pbrEnabled: !!scene3d.pbrTerrainState?.nraTex,
    pbrNormalAoTex: scene3d.pbrTerrainState?.nraTex ?? null,
    // terrainplan s4 — water env sheen (default on; ?waterEnv=off escape).
    waterEnvEnabled: readWaterEnvFlag(),
    // T1 — splat-noise border tunables (?splatNoise=off, ?splatNoiseAmp=,
    // ?splatNoiseFreq=).
    splatNoiseAmp: readSplatNoiseAmp(),
    splatNoiseFreq: readSplatNoiseFreq(),
    // 2026-08-02 — macro splat octave + the splatN sign-bias fix
    // (?splatMacro=off restores the byte-exact legacy expression).
    splatMacroAmp: readSplatMacroAmp(),
    splatMacroFreq: readSplatMacroFreq(),
    // 2026-08-02 — FAR MACRO array (?terrainMacro=off escape). Loaded once
    // per session and cached on scene3d alongside the other ring textures.
    macroTex: macroState?.texture ?? null,
    macroSliceLut: macroState?.sliceLut ?? null,
    macroSliceCount: macroState?.sliceCount ?? 0,
    macroEnabled: !!macroState?.texture,
    // T4 — POM: high/ultra only (8 dependent atlas taps/fragment near
    // camera; SwiftShader-hostile), needs the pbr height bake in uAtlas.A.
    pomEnabled:
      readPomFlag() &&
      !!scene3d.pbrTerrainState?.nraTex &&
      (scene3d.quality?.preset === "high" || scene3d.quality?.preset === "ultra"),
    // 2026-06-21 — ?texMergeRot=flip swaps the alpha-mask 90°/270° rotation
    // (rotateCellUv) back to the pre-fix N-S-mirrored sign, for A/B only.
    // 2026-06-21 — ?paintMode=winner switches the per-fragment blend to
    // stochastic per-vertex winner-take-all (organic noise-shaped edges,
    // distinct textures, no blocks). ?paintNoiseFreq + ?paintNoiseStrength
    // tune the noise pattern frequency / how aggressively it overrides
    // bilinear position weight. Defaults restore the muddy-bilinear look.
    paintMode: (() => {
      try {
        return (
          new URLSearchParams(window.location.search).get("paintMode") || ""
        ).toLowerCase();
      } catch (_) {
        return "";
      }
    })(),
    paintNoiseFreq: (() => {
      try {
        const v = Number.parseFloat(
          new URLSearchParams(window.location.search).get("paintNoiseFreq"),
        );
        return Number.isFinite(v) && v > 0 ? v : 8.0;
      } catch (_) {
        return 8.0;
      }
    })(),
    paintNoiseStrength: (() => {
      try {
        const v = Number.parseFloat(
          new URLSearchParams(window.location.search).get("paintNoiseStrength"),
        );
        return Number.isFinite(v) && v >= 0 ? v : 0.4;
      } catch (_) {
        return 0.4;
      }
    })(),
    // 2026-06-22 — Candidate H. ?paintMode=warp turns it on with sensible
    // defaults; ?warpAmp / ?warpFreq / ?winnerSoftness tune it live (and also
    // compose onto ?paintMode=winner). warpAmp/winnerSoftness 0 = legacy winner.
    warpAmp: (() => {
      try {
        const v = Number.parseFloat(
          new URLSearchParams(window.location.search).get("warpAmp"),
        );
        if (Number.isFinite(v) && v >= 0) return v;
        return (
          new URLSearchParams(window.location.search).get("paintMode") || ""
        ).toLowerCase() === "warp" ? 0.6 : 0.0;
      } catch (_) {
        return 0.0;
      }
    })(),
    warpFreq: (() => {
      try {
        const v = Number.parseFloat(
          new URLSearchParams(window.location.search).get("warpFreq"),
        );
        return Number.isFinite(v) && v > 0 ? v : 1.0;
      } catch (_) {
        return 1.0;
      }
    })(),
    winnerSoftness: (() => {
      try {
        const v = Number.parseFloat(
          new URLSearchParams(window.location.search).get("winnerSoftness"),
        );
        if (Number.isFinite(v) && v >= 0) return v;
        return (
          new URLSearchParams(window.location.search).get("paintMode") || ""
        ).toLowerCase() === "warp" ? 0.3 : 0.0;
      } catch (_) {
        return 0.0;
      }
    })(),
    maskRotFlip: (() => {
      try {
        return (
          new URLSearchParams(window.location.search)
            .get("texMergeRot") || ""
        ).toLowerCase() === "flip";
      } catch (_) {
        return false;
      }
    })(),
  };
}

/**
 * F12-3 (2026-06-09) — Parse `?terrainSlopeShading=on`. Gates the
 * geometry-normal slope-dependent sun shading on the terrain (base NdotL +
 * RNM base re-encoded from vAcNormal). DEFAULT-OFF: a render-pipeline change
 * that needs a 1070 eye-test against the white/dark exposure pipeline
 * before the default flips, per the loop's flag policy. Any value other
 * than the literal "on" (case-insensitive) — including missing — is off.
 * Wrapped in try/catch for the non-browser Node harness.
 */
function readTerrainSlopeShadingFlag() {
  // 2026-06-15 — default-ON (KEPT after live eval on the Dell: subtle hill
  // light/shade relief, no black/NaN at Yaraq or Holtburg). Opt-out
  // ?terrainSlopeShading=off. Was default-OFF (F12-3/FU-2).
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get(
      "terrainSlopeShading",
    );
    return !(typeof v === "string" && v.toLowerCase() === "off");
  } catch (_) {
    return true;
  }
}

/**
 * B2 (2026-06-20) — Parse `?terrainRingTimeSlice` from the page URL.
 * Defaults to ON; only the literal `"off"` (case-insensitive) disables it.
 * When ON, `bakeTerrainRing`'s final synchronous per-LB bake fan-out is
 * frame-budgeted: the centre + ring-1 (9 nearest coords) bake first, then
 * the remaining coords bake in small batches that yield a REAL macrotask
 * (`setTimeout(0)`) whenever ~6ms of wall-clock has elapsed, so the rAF
 * pump (pumpNetFrame → __lastPumpMs) keeps running and the load watchdog
 * never trips during the ~169-LB radius-6 boot ring. `=off` restores the
 * prior single uninterrupted `Promise.all` fan-out. Wrapped in try/catch
 * for the non-browser Node harness, mirroring the sibling readers.
 */
function readTerrainRingTimeSliceFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get(
      "terrainRingTimeSlice",
    );
    return !(typeof v === "string" && v.toLowerCase() === "off");
  } catch (_) {
    return true;
  }
}

/**
 * 2026-05-28 — Parse `?terrainMod=on` from the page URL. Returns true
 * only for the literal value `"on"` (case-insensitive); any other
 * value (including missing) is false. Wrapped in a try/catch so the
 * non-browser test harness (Node-side smoke tests) doesn't blow up on
 * missing `window`.
 */
function readTerrainModulationFlag() {
  // 2026-06-15 — REVERTED to default-OFF. The default-ON flip (render-audit
  // T1a 2026-06-09, never eye-tested) BLACKED OUT non-Holtburg terrain: the
  // per-vertex TerrainTex brightness modulation (`result * vBrightness`,
  // shader ~L1654, vBrightness NOT floored) computes ~0 for some biomes'
  // terrain codes → black. Live-confirmed on the Dell at Yaraq (LB 0x7d64):
  // terrainMod-only = black, all-off = correct grass. Dead-in-retail
  // (acclient.c never applied it). Opt-in `?terrainMod=on` to A/B.
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("terrainMod");
    return typeof v === "string" && v.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

/**
 * 2026-07-08 — Parse `?waterScroll` from the page URL. Default ON: the water
 * surface UV scroll animates at every subdiv/LOD level (the fix that decouples
 * it from `uDisplacementEnabled`). `?waterScroll=off` (or `0`/`false`) sets the
 * shader gate to 0 → fully static water, a rollback escape. Any other/missing
 * value is on. try/catch for the non-browser Node harness, like the siblings.
 */
/**
 * 2026-07-31 (water-fix) — Parse `?waterWave` from the page URL. Gates the
 * VERTICAL swell (the rise/fall). DEFAULT ON at every quality tier and every
 * subdivision factor: the swell is lattice-locked so it is level-independent
 * (see `waterSwellLattice` in TERRAIN_VERTEX_GLSL). `?waterWave=off` (or
 * `0`/`false`) sets `uDisplacementEnabled` to 0 — flat water geometry, with
 * the surface scroll + sheen still running. Same reader shape (and
 * try/catch for the Node harness) as `readWaterScrollFlag`.
 *
 * The pair is deliberately independent: `?waterWave=off` isolates the
 * surface effects, `?waterScroll=off` isolates the geometry, and both off is
 * the fully-static rollback.
 */
function readWaterWaveFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("waterWave");
    if (typeof v !== "string") return true;
    const lv = v.toLowerCase();
    return !(lv === "off" || lv === "0" || lv === "false");
  } catch (_) {
    return true;
  }
}

function readWaterScrollFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("waterScroll");
    if (typeof v !== "string") return true;
    const lv = v.toLowerCase();
    return !(lv === "off" || lv === "0" || lv === "false");
  } catch (_) {
    return true;
  }
}

/**
 * R1.A (2026-05-28) — Parse `?terrainModSatHue` from the page URL. This
 * is the sat/hue SUB-gate that rides on top of `?terrainMod=on`. It
 * defaults to ON (full sat/hue + brightness) so the master flag shows
 * the complete effect; set `?terrainModSatHue=off` to A/B brightness-only
 * on the GPU. Any value other than the literal `"off"` (case-insensitive)
 * — including missing — is treated as on. Wrapped in try/catch for the
 * non-browser Node harness, same as `readTerrainModulationFlag`.
 */
function readTerrainModSatHueFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("terrainModSatHue");
    // Default on (full effect); only the explicit "off" disables it.
    return !(typeof v === "string" && v.toLowerCase() === "off");
  } catch (_) {
    return true;
  }
}

/**
 * T8 (2026-05-28) — Parse `?terrainPalette=on`. Gates the minimap-colour
 * per-biome tint (`uTerrainPaletteStrength`), now OFF by default because it
 * sources the radar/minimap colour rather than the retail terrain palette.
 * Same try/catch shape as `readTerrainModulationFlag` for the Node harness.
 */
function readTerrainPaletteFlag() {
  // 2026-06-15 — default-ON (KEPT after live eval on the Dell: subtle per-biome
  // tint at 0.25 strength, no black). Opt-out ?terrainPalette=off. Note it
  // sources the minimap/radar colour (region.rs:653), not the true retail
  // terrain palette — a subtle biome bias, not a faithful tint.
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("terrainPalette");
    return !(typeof v === "string" && v.toLowerCase() === "off");
  } catch (_) {
    return true;
  }
}

/**
 * T7 (2026-05-28) / rev 2026-07-02 — Parse `?terrainDetailTex` as a MODE:
 *   "global"  (default, any value incl. "on") — retail behaviour: ONE
 *             landscape detail texture + tiling world-wide, read from
 *             TerrainDesc[0] exactly like LScape::GenerateDetailSurface(0)
 *             (decomp: categories 0-3 = landscape/building/env/object; the
 *             per-TYPE detail fields are dead data in the shipped client).
 *   "percode" — the modern per-terrain-type variant (razor-edged blocks at
 *             type boundaries — failed the 2026-07-02 1070 eye-test; kept
 *             for A/B).
 *   "off"     — no detail layer.
 */
function readTerrainDetailTexMode() {
  try {
    if (typeof window === "undefined" || !window.location) return "global";
    const v = (
      new URLSearchParams(window.location.search).get("terrainDetailTex") || ""
    ).toLowerCase();
    if (v === "off") return "off";
    if (v === "percode") return "percode";
    return "global";
  } catch (_) {
    return "global";
  }
}

/**
 * T1 (2026-05-28) — Parse `?texMerge`. Gates the retail TexMerge composite
 * (`uTexMergeEnabled` + the per-LB merge texture + the alpha-mask array fetch).
 *
 * 2026-06-21 — flipped to DEFAULT OFF (opt-in `?texMerge=on`). The composite
 * shipped default-on with its real-GPU eye-test waived (2026-06-20), and the
 * user confirmed live on the 1070 that it renders WRONG: per-cell flat tiles
 * read as hard "big blocks", and the road alpha masks paint near-full cells
 * across BOTH cell-columns adjacent to a road vertex-line → a "two-lane
 * highway" instead of one narrow lane. With this flag OFF the bilinear path
 * (a) cross-dissolves the 4 cell corners → smooth biome transitions (no
 * blocks) and (b) runs the legacy road painter, which narrows the road via
 * smoothstep(0.85, 0.95) to retail's _road_width (~5 m, acclient.c:467318) =
 * a single centered lane. Live A/B at 0xcd9d confirmed bilinear fixes both.
 *
 * 2026-07-02 — ROOT-CAUSED AND DEFAULT ON AGAIN (see readTexMergeFlag). Both
 * 06-21 symptoms were ONE bug: the shader weighted the OVERLAY by the mask
 * byte, but retail ImgTex::MergeTexture (acclient.c:365787) weights the BASE
 * (dst = (a*dst + (256-a)*src) >> 8; white keeps base, black shows overlay).
 * Corner masks are ~75-80 pct white → inverted, every boundary cell flooded
 * with overlay = "big blocks"; road masks are a dark lane on white →
 * inverted, near-full-cell road = "two-lane highway". With the sense fixed
 * the composite renders organic masked transitions (1070-confirmed live);
 * the road overlay slots are re-armed behind ?roadSlots=on pending eye-test.
 *
 * NOTE: this docstring documents `?texMerge`, but the function immediately
 * below it is `readRoadSlotsFlag`. `readTexMergeFlag` is further down. Left in
 * place rather than moved so the history above stays greppable from both.
 */

/**
 * Parse `?roadSlots`. Gates the retail TexMerge ROAD overlay slots (merge
 * record slots 4..5, `pack_merge_record`) in the composite loop; when on, the
 * analytic segment-distance lane painter is gated off so the road is painted
 * exactly once (the `uRoadEnabled` guard in main()).
 *
 * DEFAULT ON (escape `?roadSlots=off`). The retail road overlays are the only
 * road source retail itself had: `TexMerge::GetRoadCode` +
 * `TexMerge::FindRoadAlpha` pick a hand-authored road alpha map per cell and
 * `FillTempTexBuffer` composites it after the terrain overlays. The analytic
 * painter is a stand-in with no retail counterpart and now becomes the
 * fallback. The 2026-06-21 "two-lane highway" that got these slots abandoned
 * was the inverted mask sense (fixed 2026-07-02) compounded by the wrong PRNG
 * draw from an N-S-reversed pcode (fixed with the corner-order patch): the road
 * rcode -> map choice is rcode-determined, so with a retail-exact pcode the
 * map AND its rotation are now retail-exact on every cell of 0xA9B4/0xAAB4.
 */
function readRoadSlotsFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("roadSlots");
    return !(typeof v === "string" && v.toLowerCase() === "off");
  } catch (_) {
    return true;
  }
}

function readRoadPaintLegacyFlag() {
  // 2026-07-02 — ?roadPaint=legacy restores the pre-2026-07-02 bilinear+
  // smoothstep road lane (breaks on diagonal road runs — mask peaks at 0.5
  // mid-cell) for A/B against the analytic segment-distance painter.
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("roadPaint");
    return typeof v === "string" && v.toLowerCase() === "legacy";
  } catch (_) {
    return false;
  }
}

function readTexMergeFlag() {
  // 2026-07-02 — DEFAULT ON again (escape ?texMerge=off). The TexMerge
  // composite (per-cell base + retail alpha-masked overlays) IS the retail
  // terrain look; the "smoother" bilinear default chosen on 2026-06-21
  // (39394a4e) muddied type boundaries world-wide. Independently, the
  // subdiv mesh path shipped no terrainMergeData until 2026-07-02, so even
  // ?texMerge=on was a silent no-op on every landblock — flag readers and
  // uniforms all said "off" with zero console evidence. Both are fixed.
  //
  // The reader below is the AUTHORITY on the default, not this comment: the
  // absent-param branch returns true, so texMerge is ON unless the URL says
  // "off". (Superseded note: roads no longer come from the analytic lane
  // painter by default — see readRoadSlotsFlag, also default-ON, and the
  // s < 6 composite loop.)
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("texMerge");
    return !(typeof v === "string" && v.toLowerCase() === "off");
  } catch (_) {
    return true;
  }
}

function readSplatNoiseAmp() {
  // T1 splat-noise borders — DEFAULT ON at amp 0.6 (?splatNoise=off → 0;
  // ?splatNoiseAmp=N tunes). Amp 0 is a strict shader no-op.
  try {
    if (typeof window === "undefined" || !window.location) return 0.6;
    const q = new URLSearchParams(window.location.search);
    const off = (q.get("splatNoise") ?? "").toLowerCase() === "off";
    if (off) return 0;
    const v = Number.parseFloat(q.get("splatNoiseAmp"));
    return Number.isFinite(v) && v >= 0 ? v : 0.6;
  } catch (_) {
    return 0.6;
  }
}

function readSplatNoiseFreq() {
  try {
    const v = Number.parseFloat(
      new URLSearchParams(window.location.search).get("splatNoiseFreq"));
    return Number.isFinite(v) && v > 0 ? v : 0.35;
  } catch (_) {
    return 0.35;
  }
}

// 2026-08-02 — macro splat octave. DEFAULT ON (?splatMacro=off → amp 0, which
// ALSO restores the byte-exact legacy splatN expression including its sign
// bias; see the splatN block in main()). ?splatMacroAmp / ?splatMacroFreq tune.
export const SPLAT_MACRO_AMP_DEFAULT = 0.9;
export const SPLAT_MACRO_FREQ_DEFAULT = 0.022; // ~45 m wavelength

function readSplatMacroAmp() {
  try {
    if (typeof window === "undefined" || !window.location) {
      return SPLAT_MACRO_AMP_DEFAULT;
    }
    const q = new URLSearchParams(window.location.search);
    const raw = (q.get("splatMacro") ?? "").toLowerCase();
    if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return 0;
    const v = Number.parseFloat(q.get("splatMacroAmp"));
    return Number.isFinite(v) && v >= 0 ? v : SPLAT_MACRO_AMP_DEFAULT;
  } catch (_) {
    return SPLAT_MACRO_AMP_DEFAULT;
  }
}

function readSplatMacroFreq() {
  try {
    const v = Number.parseFloat(
      new URLSearchParams(window.location.search).get("splatMacroFreq"));
    return Number.isFinite(v) && v > 0 ? v : SPLAT_MACRO_FREQ_DEFAULT;
  } catch (_) {
    return SPLAT_MACRO_FREQ_DEFAULT;
  }
}

// 2026-08-02 — TexMerge alpha-mask mipmaps + anisotropy. DEFAULT ON
// (?maskMips=off restores the un-mipped legacy sampler). Rationale at the
// construction site.
function readMaskMipsFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("maskMips");
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

// 2026-08-02 — FAR MACRO tunables. Defaults live in terrain_macro.js next to
// the bake that produced the maps.
function readMacroStrength() {
  return macroNumFlag("terrainMacroStrength", MACRO_STRENGTH_DEFAULT, 0, 2);
}
function readMacroFadeStart() {
  return macroNumFlag("terrainMacroStart", MACRO_FADE_START_DEFAULT, 0, 4000);
}
function readMacroFadeEnd() {
  return macroNumFlag("terrainMacroEnd", MACRO_FADE_END_DEFAULT, 1, 8000);
}
function readMacroScaleA() {
  return macroNumFlag("terrainMacroScaleA", MACRO_SCALE_A_DEFAULT, 4, 4000);
}
function readMacroScaleB() {
  return macroNumFlag("terrainMacroScaleB", MACRO_SCALE_B_DEFAULT, 4, 4000);
}
function readMacroNoiseAmp() {
  return macroNumFlag("terrainMacroNoise", MACRO_NOISE_AMP_DEFAULT, 0, 1);
}

function readPomFlag() {
  // T4 POM — DEFAULT ON at quality high/ultra (`?pom=off` escape); the
  // opts site adds the quality + pbr-asset gates.
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("pom");
    return !(typeof v === "string" && v.toLowerCase() === "off");
  } catch (_) {
    return true;
  }
}

function readWaterEnvFlag() {
  // terrainplan s4 default tier — water reflection sheen off the T3 env
  // cube. DEFAULT ON (`?waterEnv=off` escape) — rides pbrTerrain+ibl which
  // are default-on; a no-op when either of those is off.
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("waterEnv");
    return !(typeof v === "string" && v.toLowerCase() === "off");
  } catch (_) {
    return true;
  }
}

function readPbrTerrainFlag() {
  // T2 (2026-07-28, terrainplan.md) — curated CC0 PBR terrain layers:
  // albedo overrides into uAtlas + the nra array (per-pixel material-normal
  // NdotL, AO, roughness). DEFAULT ON as of 2026-07-28 (escape
  // `?pbrTerrain=off`) after the off-screen 1070 pass: real ANGLE D3D11,
  // zero console errors, grass/snow/ice biome shots approved. The
  // `!== "off"` shape below is the DELIBERATE default-on idiom (url-flags.md
  // 2026-07-23 box), flipped from the strict `=== "on"` opt-in it shipped
  // with. Fail-soft stays: a checkout without the gitignored asset bake
  // renders retail with one console warn.
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("pbrTerrain");
    return !(typeof v === "string" && v.toLowerCase() === "off");
  } catch (_) {
    return true;
  }
}

/**
 * Pick the subdivision level for a single LB using Chebyshev-distance
 * cascade from the reference LB (world-expand step 1 Objective 7).
 *
 *   - distance 0 (the reference LB itself): full `opts.subdivLevel`.
 *   - distance 1 (the 8 LBs immediately around): `max(1, floor(level/2))`.
 *   - distance ≥ 2 (outer rings at radius≥2): `1` (no subdivision).
 *
 * The reference LB is `scene3d.playerLbKey` when set, otherwise
 * `scene3d.initialCentreLbKey`, otherwise the ring driver's centre
 * (`opts.centreLbX` / `opts.centreLbY`). We do NOT plumb a runtime
 * `playerLbKey` updater in step 1: the brief notes that lazy adds
 * compute distance at bake time from whatever centre was provided, and
 * already-baked LBs do not re-bake on player movement (re-bake-on-LOD-
 * shift is step 2 scope per docs/world-expand-step-1-handoff.md). So
 * in practice, every LB picks its level from the centre passed to
 * `bakeTerrainRing` — which is the spawn LB at init and the lazy-walk
 * centre on subsequent loads.
 *
 * At radius=1 this is IDENTICAL to the prior centre-vs-outer flip:
 *   distance 0 → full, distance 1 → half (no distance ≥ 2 in a 3×3).
 * At radius≥2 (Objective 8 flips to radius=6) the cascade flattens
 * the outer rings to subdivLevel=1 so triangle counts don't explode.
 */
function pickSubdivLevelForLb(opts, lbX, lbY) {
  // Per-LB subdivision cascade. Centre and ring-1 both cap at halfLevel
  // (perf fix 2026-05-20 — see comment below). Outer rings stay at 1.
  const halfLevel = Math.max(1, Math.floor(opts.subdivLevel / 2));
  // Resolve the distance reference. The scene3d ref is threaded through
  // `opts` by `resolveTerrainRingOpts` (which captures the scene3d at
  // ring-bake start). If neither dynamic key is present, fall back to
  // the centre LB passed to the ring driver — preserves radius=1
  // behaviour for callers that never touch the player position.
  const playerLb = opts.playerLbKey ?? opts.initialCentreLbKey ?? null;
  let pX;
  let pY;
  if (playerLb != null) {
    pX = (playerLb >>> 24) & 0xff;
    pY = (playerLb >>> 16) & 0xff;
  } else {
    pX = opts.centreLbX;
    pY = opts.centreLbY;
  }
  const distLb = Math.max(Math.abs(lbX - pX), Math.abs(lbY - pY));
  // Perf 2026-05-20 — the centre LB (distLb=0) previously got the full
  // `opts.subdivLevel` (8 at ultra), producing 8192 triangles per centre
  // tile vs 2048 for ring-1 neighbours. User report: "FPS bad in a
  // specific landblock, gone when I move away" — the slow LB was always
  // the centre one. At ~3 m vertex spacing the centre LB also dominated
  // the per-frame triangle traverse cost for no visible benefit (vertex
  // displacement / triplanar slope detection both look equivalent at 6 m
  // spacing). Cap centre at `halfLevel` to match ring-1; ring-2+ stays
  // at 1.
  if (distLb <= 1) return halfLevel;
  return 1;
}

// === F12-6 — per-LB subdiv LOD re-bake on player approach ==================
//
// `pickSubdivLevelForLb` picks each LB's subdivision level from the player's
// LB at BAKE time. Pre-F12-6 that level was frozen for the LB's lifetime —
// walking from a coarse outer-ring LB (subdiv=1) toward it never upgraded its
// detail, so terrain under your feet stayed visibly coarser (24 m facets, no
// micro-relief) than the terrain where you logged in, and detail only "popped"
// when a distant LB happened to be evicted + re-baked. This reconciles each
// resident LB's BAKED level (`lbMesh.userData.subdivLevel`) against the level
// the NEW player centre would pick, and re-bakes the mismatches one-per-frame.
//
// DEFAULT-ON (2026-06-28): re-bakes each resident LB to the subdiv level the
// CURRENT player centre picks, one-per-frame, as the player moves — so detail
// follows you instead of being frozen at login. The F12-1 edge-weld it was once
// gated on is NOT needed: the subdivided vertex Z is the faceted collision
// surface (`triangle_height_in_cell`), which is LINEAR along every cell edge, so
// a finer LB's boundary vertices land EXACTLY on a coarser neighbour's straight
// chord — crack-free across LOD levels regardless of the moving boundary. Locked
// by the Rust regression test
// `holtburger_dat::terrain_subdiv::tests::lod_boundary_edges_coincide_across_factors`.
// Escape: `?lodRebake=off` (byte-identical: no reconcile, no re-bake).
const LOD_REBAKE_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return new URLSearchParams(window.location.search).get("lodRebake") !== "off";
  } catch (_) { return true; }
})();

// Re-point the LOD reference at `newLbKey` and enqueue every resident terrain
// LB whose baked subdiv level no longer matches what the new centre picks.
// Private — driven by `tickTerrainLodRebake` on an LB change.
function reconcileTerrainLodForCentre(scene3d, newLbKey) {
  const opts = scene3d.terrainOpts;
  if (!opts) return;
  // Move the LOD reference so pickSubdivLevelForLb (here + in any subsequent
  // lazy bake) measures distance from where the player actually is. Pre-F12-6
  // this was never runtime-updated (see the pickSubdivLevelForLb header).
  opts.playerLbKey = newLbKey;
  scene3d.playerLbKey = newLbKey;
  // The lazy bakers run against the scene3dForBuilders facade — a DIFFERENT
  // object from window.liveScene3d (the statics.js:3786 footgun) — and
  // pickSubdivLevelForLb reads playerLbKey off whichever facade the bake was
  // invoked with. The LOD reference must move on BOTH facades: with only one
  // updated, every bake measured distance from the session's FIRST region,
  // so touring far enough (~4-5 towns) degraded every new town to factor-1
  // stub terrain (81 verts) that the reconcile then agreed never needed an
  // upgrade — the "world stops loading after portalling around" hollow-town
  // wedge. Mirror in both directions so it holds regardless of which facade
  // drives the tick.
  const _twin =
    (scene3d.cameraSwitcher && scene3d.cameraSwitcher.scene3d) ||
    (typeof window !== "undefined" ? window.liveScene3d : null);
  if (_twin && _twin !== scene3d) {
    _twin.playerLbKey = newLbKey;
    if (_twin.terrainOpts) _twin.terrainOpts.playerLbKey = newLbKey;
  }
  if (!(scene3d._lodRebakeQueue instanceof Set)) scene3d._lodRebakeQueue = new Set();
  for (const c of scene3d.terrainGroup.children) {
    const ud = c.userData;
    // Only the real terrain mesh carries `subdivLevel`; the wire-fill
    // companion (userData {wireFillFor, lbX, lbY}) does not — skip it.
    if (!ud || typeof ud.subdivLevel !== "number" || typeof ud.lbX !== "number") continue;
    const desired = pickSubdivLevelForLb(opts, ud.lbX, ud.lbY);
    if (desired !== ud.subdivLevel) {
      scene3d._lodRebakeQueue.add((((ud.lbX & 0xff) << 24) | ((ud.lbY & 0xff) << 16)) >>> 0);
    }
  }
}

// Tear down only the TERRAIN layer for one queued LB and re-bake it at the
// new level. LandblockLRU.evict is intentionally NOT used — it would also
// drop the LB's buildings / statics / EnvCells, which a terrain LOD swap must
// leave in place. The LRU entry keeps stale refs to the now-disposed terrain
// resources, but eviction's dispose() calls are try/caught no-ops and the
// fresh bake's track() appends the new refs (a small JS-ref accrual bounded by
// how often one LB re-bakes before it evicts — acceptable for opt-in). The new
// mesh arrives async, so the LB shows a brief terrain gap; the integrator
// holds pose Z from the cached heights so the player never falls through.
function drainOneTerrainLodRebake(scene3d) {
  const queue = scene3d._lodRebakeQueue;
  if (!(queue instanceof Set) || queue.size === 0) return;
  const lbKey = queue.values().next().value;
  queue.delete(lbKey);
  const lbX = (lbKey >>> 24) & 0xff;
  const lbY = (lbKey >>> 16) & 0xff;
  const group = scene3d.terrainGroup;
  if (group && group.children) {
    const kill = [];
    for (const c of group.children) {
      const ud = c.userData;
      if (ud && ud.lbX === lbX && ud.lbY === lbY) kill.push(c);
    }
    for (const c of kill) {
      group.remove(c);
      try { c.geometry && c.geometry.dispose && c.geometry.dispose(); } catch (_) {}
      const m = c.material;
      if (m && !(m.userData && m.userData.__cacheOwned)) {
        try { m.dispose && m.dispose(); } catch (_) {}
      }
      try { c.userData && c.userData.vertexTypesTexture && c.userData.vertexTypesTexture.dispose(); } catch (_) {}
      try { c.userData && c.userData.mergeDataTexture && c.userData.mergeDataTexture.dispose(); } catch (_) {}
    }
  }
  // ?terrainBatch — also excise this LB's geometry from the cross-LB terrain
  // BatchedMesh (the kill loop above only removed the hidden proxy). The hook
  // is installed by terrain_batch.js only when the flag is on; absent ⇒ this
  // typeof guard no-ops (flag-off behaviour unchanged). Mirrors the
  // _evictStaticAtlasForLb idiom in landblock_lru.evict.
  if (typeof scene3d._evictTerrainBatchForLb === "function") {
    try { scene3d._evictTerrainBatchForLb(lbKey); } catch (_) { /* fail-soft */ }
  }
  // Clear the idempotency gate so the lazy baker re-bakes (it short-circuits
  // on terrainBakedLbs.has(lbKey)); opts.playerLbKey was updated in reconcile
  // so the re-bake's pickSubdivLevelForLb picks the upgraded level.
  if (scene3d.terrainBakedLbs instanceof Set) scene3d.terrainBakedLbs.delete(lbKey);
  try {
    if (typeof scene3d.loadTerrainForLandblock === "function") {
      scene3d.loadTerrainForLandblock(lbX, lbY);
    }
  } catch (_) { /* fire-and-forget; never break the frame on a re-bake */ }
}

/**
 * F12-6 — per-frame LOD re-bake driver. Call once per rAF with the player's
 * current LB key (e.g. `landblockLru.getCurrentLbId()`). On an LB change it
 * reconciles resident LB subdiv levels against the new centre; every frame it
 * drains at most ONE queued re-bake so a burst (crossing into a fresh region)
 * spreads across frames instead of hitching. No-op unless `?lodRebake=on` AND
 * the quality tier subdivides (`opts.canSubdivide`) — at subdivLevel=1 every
 * LB is level 1 and there is nothing to reconcile.
 */
export function tickTerrainLodRebake(scene3d, currentLbKey) {
  if (!LOD_REBAKE_ON) return;
  if (!scene3d || !scene3d.terrainGroup) return;
  const opts = scene3d.terrainOpts;
  if (!opts || !opts.canSubdivide) return;
  const key = (currentLbKey == null) ? null : (currentLbKey >>> 0);
  if (key != null && key !== scene3d._lodLastCentre) {
    scene3d._lodLastCentre = key;
    reconcileTerrainLodForCentre(scene3d, key);
  }
  drainOneTerrainLodRebake(scene3d);
}

/**
 * world-expand step 1 — per-LB terrain baker.
 *
 * Bakes ONE landblock's terrain mesh (heightfield + bilinear-blend
 * shader + per-LB vertex-types texture + Phase 2.1 subdivision +
 * Phase 2.2 displacement + road overlay) and adds it to
 * `scene3d.terrainGroup`. Idempotent via `scene3d.terrainBakedLbs:
 * Set<u32>` keyed by `((lbX << 24) | (lbY << 16)) >>> 0`.
 *
 * `opts` is the once-per-ring bag built by `resolveTerrainRingOpts`.
 * For the lazy LB-entry path (called from outside a ring driver, e.g.
 * the `handlePositionUpdate` hook Objective 6 will wire), callers can
 * either (a) reuse the previously-baked ring's `opts` straight off
 * `scene3d.terrainOpts` (set by `bakeTerrainRing`) or (b) call
 * `resolveTerrainRingOpts(scene3d, wasmExports, lbX, lbY, scene3d)` to
 * get a fresh one centred on the new LB.
 *
 * `opts.prefetchedMesh` / `opts.prefetchedSubdiv` short-circuit the
 * wasm round-trip when the ring driver has already batched the fetch
 * for this LB. Solo callers leave both unset and the baker fetches via
 * single-element `fetch_landblock_heightmaps` / per-LB
 * `fetch_subdivided_landblock`.
 *
 * Returns the added `THREE.Mesh`, or `null` if the LB was already baked.
 */
export async function bakeTerrainForLandblock(
  scene3d,
  lbX,
  lbY,
  opts,
  wasmExports
) {
  if (!scene3d || !scene3d.terrainGroup) {
    throw new Error(
      "bakeTerrainForLandblock: scene3d.terrainGroup missing (call init3D first)"
    );
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_heightmaps !== "function"
  ) {
    throw new Error(
      "bakeTerrainForLandblock: wasmExports missing fetch_landblock_heightmaps"
    );
  }
  if (!opts) {
    throw new Error(
      "bakeTerrainForLandblock: opts missing (call resolveTerrainRingOpts or pass scene3d.terrainOpts)"
    );
  }

  // Idempotency: short-circuit if this LB is already in the baked set.
  // Initialise both the bake set + the per-rAF terrainMaterials registry
  // lazily so solo callers (the future lazy LB-entry hook) work even if
  // the ring driver hasn't run yet.
  if (!(scene3d.terrainBakedLbs instanceof Set)) {
    scene3d.terrainBakedLbs = new Set();
  }
  if (!Array.isArray(scene3d.terrainMaterials)) {
    scene3d.terrainMaterials = [];
  }
  const lbKey = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
  if (scene3d.terrainBakedLbs.has(lbKey)) {
    return null;
  }

  // 1. Fetch base mesh. Ring drivers pass a prefetched mesh via opts;
  // solo callers (lazy hook) issue a single-element batch call to the
  // same wasm export the ring driver uses.
  const cellId = (lbKey | 0xffff) >>> 0;
  // streamFix urgent lane (2026-07-02): current-LB/3×3 terrain is
  // player-blocking (the ground the player stands on) — bypass the fetch
  // semaphore like the statics/buildings twins. Speculative ring LBs keep
  // the normal lane. Fail-soft false when the LRU isn't wired.
  const urgent = isNearPlayerLb(scene3d, lbKey);
  let wasmMesh = opts.prefetchedMesh ?? null;
  if (!wasmMesh) {
    const meshes = await wasmExports.fetch_landblock_heightmaps(
      new Uint32Array([cellId]),
      urgent
    );
    if (!meshes || meshes.length === 0) {
      throw new Error(
        `bakeTerrainForLandblock: fetch_landblock_heightmaps returned 0 meshes for (${lbX.toString(
          16
        )},${lbY.toString(16)})`
      );
    }
    wasmMesh = meshes[0];
  }

  // 2. Subdivided mesh (visual-fidelity Phase 2.1). Either passed in by
  // the ring driver (it batched the per-LB subdiv fetch in parallel) or
  // fetched here for the solo path. The level is the centre-vs-outer
  // pick — same rule as the prior `buildHoltburgTerrain` body.
  let subdivEntry = opts.prefetchedSubdiv ?? null;
  if (!subdivEntry && opts.canSubdivide) {
    const level = pickSubdivLevelForLb(opts, lbX, lbY);
    try {
      const mesh = await wasmExports.fetch_subdivided_landblock(cellId, level, urgent);
      subdivEntry = { mesh, level };
    } catch (err) {
      console.warn(
        `[terrain] subdivide failed for (${lbX},${lbY}) @ level=${level}:`,
        err
      );
      subdivEntry = null;
    }
  }

  // Mark baked AFTER successful base fetch but BEFORE building geometry
  // so any in-flight concurrent call for the same LB short-circuits
  // immediately. Three.js mesh construction is sync from here on.
  scene3d.terrainBakedLbs.add(lbKey);

  // 3. Snapshot the per-vertex code arrays before freeing the wasm
  // mesh. terrainCodes feeds uVertexTypes.R; roadCodes feeds .G for
  // the in-shader road painting.
  const roadCodesCopy = Uint8Array.from(wasmMesh.roadCodes);
  const terrainCodesCopy = Uint8Array.from(wasmMesh.terrainCodes);
  const heightMin = wasmMesh.heightMin;
  const heightMax = wasmMesh.heightMax;

  // 4. Phase 2.1 — if the LB has a subdivided mesh, build geometry from
  // it. Otherwise fall back to the 9×9 path. The 9×9 vertex-types
  // texture (`uVertexTypes`) is always the 9×9 control grid — the
  // subdivided mesh's per-vertex `terrainCode` attribute is unused by
  // the current shader (kept on the geometry for forward compat).
  let geom;
  let effectiveSubdiv = 1;
  if (subdivEntry && subdivEntry.mesh) {
    geom = subdividedLandblockMeshToGeometry(subdivEntry.mesh);
    effectiveSubdiv = subdivEntry.level;
    if (typeof subdivEntry.mesh.free === "function") subdivEntry.mesh.free();
  } else {
    geom = landblockMeshToGeometry(wasmMesh);
  }
  // 2026-05-28 — per-vertex brightness + (R1.A) saturation + hue
  // attributes for the TerrainTex modulation. Always built; the
  // fragment-shader application is gated by `uTerrainModulationEnabled`
  // (master) and `uTerrainModSatHue` (sat/hue sub-gate) so the
  // attributes being present is a no-op when modulation is off. See
  // `buildTerrainVertexModulation` for the math + the
  // `project_terrain_vertex_modulation_gap_2026-05-28.md` memo for
  // the audit trail. Skipped on a missing ranges table (defensive —
  // shouldn't happen post-2026-05-28 wasm).
  if (scene3d.terrainModulationRanges) {
    const positions = geom.getAttribute("position");
    const terrainCodesAttr = geom.getAttribute("terrainCode");
    if (positions && terrainCodesAttr) {
      const mod = buildTerrainVertexModulation(
        positions.array,
        terrainCodesAttr.array,
        scene3d.terrainModulationRanges,
        lbX, lbY,
      );
      geom.setAttribute(
        "vertexBrightness",
        new THREE.BufferAttribute(mod.brightness, 1, false),
      );
      geom.setAttribute(
        "vertexSaturate",
        new THREE.BufferAttribute(mod.saturate, 1, false),
      );
      geom.setAttribute(
        "vertexHue",
        new THREE.BufferAttribute(mod.hue, 1, false),
      );
    }
  }
  let vertexTypesTex = null;
  // T1/#23 — hoisted to function scope (sibling of `vertexTypesTex`) so
  // the per-LB DataTexture is reachable from `lbMesh.userData` below.
  // Built inside the textured-mode `else` branch (wire-agent leaves it
  // null). Without this hoist the userData read would throw a
  // ReferenceError (the texture was previously block-scoped to `else`).
  let mergeDataTex = null;
  // Wire-agent: skip the per-LB DataTexture upload and use a pair of
  // shared MeshBasicMaterials. The fill material reads a per-vertex
  // `color` attribute computed from TERRAIN_CODE_TO_RGB + the existing
  // per-vertex terrainCode array — Gouraud-interpolates colour across
  // each triangle so terrain types (grass / road / water / sand / etc.)
  // read as themselves. The wireframe overlay is then rendered on top
  // (second mesh, same geometry) with a near-black colour and a slight
  // polygonOffset on the fill so the lines aren't z-fought. No atlas
  // sampling, no road painting, no detail normals, no time-driven wave
  // displacement; the GPU sees two MeshBasicMaterials totalling a few
  // KB of program state per LB.
  let material;
  if (scene3d.wireframeMode) {
    // Build per-vertex colour attribute from the palette + existing
    // per-vertex terrainCode. Cheap — ~750 verts × 3 floats per LB at
    // subdivLevel=1; ~50,000 floats per LB at subdivLevel=8. Wire mode
    // forces subdivLevel=1 via resolveTerrainRingOpts so we stay on
    // the smaller end.
    const colorAttr = buildWireTerrainColors(terrainCodesCopy);
    geom.setAttribute("color", new THREE.BufferAttribute(colorAttr, 3, false));

    if (!scene3d._wireTerrainFillMaterial) {
      scene3d._wireTerrainFillMaterial = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        fog: true,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      scene3d._wireTerrainFillMaterial.name = "wire-terrain-fill";
      scene3d._wireTerrainFillMaterial.userData = { __cacheOwned: true };
      applyWireVertexAOPatch(scene3d._wireTerrainFillMaterial);
      applyFillDepthBias(scene3d._wireTerrainFillMaterial);
    }
    if (!scene3d._wireTerrainMaterial) {
      scene3d._wireTerrainMaterial = new THREE.MeshBasicMaterial({
        color: 0x1c2a22, // very dark green — readable on the colour fill
        wireframe: true,
        side: THREE.DoubleSide,
        fog: true,
      });
      scene3d._wireTerrainMaterial.name = "wire-terrain";
      scene3d._wireTerrainMaterial.userData = { __cacheOwned: true };
      applyWireVertexAOPatch(scene3d._wireTerrainMaterial);
    }
    material = scene3d._wireTerrainMaterial;
  } else {
    // RP4 — pooled 9×9 vertex-types texture (reuses the GPU texture across LB
    // transitions; bytes fully overwritten per LB). See acquireVertexTypesTex.
    vertexTypesTex = acquireVertexTypesTex(terrainCodesCopy, roadCodesCopy);

    // T1 — per-LB TexMerge data texture (48×8 RGBA8, NearestFilter). Built
    // only when `?texMerge=on` AND the wasm mesh carries merge data. The
    // shader reads it via texelFetch(uMergeData, ivec2(cx*6+slot, cy)). On
    // the off path mergeDataTex stays null and uTexMergeEnabled is 0.
    // (Declaration hoisted to function scope above; assigned here.)
    // RP4 — pooled like vertexTypesTex (same fixed shape every LB).
    if (opts.texMergeEnabled) {
      const mergeBytes = wasmMesh.terrainMergeData; // Uint8Array(1536) or empty
      if (mergeBytes && mergeBytes.length === 48 * 8 * 4) {
        mergeDataTex = acquireMergeDataTex(mergeBytes);
      }
    }

    // 5. ShaderMaterial — verbatim port from the prior in-loop body.
    // Per-LB uniforms (uVertexTypes, uLbOriginXy) are bound here; the
    // once-per-ring uniforms (uAtlas, uTerrainDetailNormalArray,
    // uCodeToSlice, uWaterCodeMask, etc.) come straight off `opts`.
    material = new THREE.ShaderMaterial({
    // three.js auto-injects `projectionMatrix`, `modelViewMatrix`,
    // and the `position` attribute. We just supply the user
    // uniforms.
    uniforms: {
      uAtlas: { value: opts.atlasTexture },
      // T2 (?pbrTerrain=on) — 33-layer normal+AO array (RGB = tangent
      // normal, A = AO) parallel to uAtlas, same layer indexing + the same
      // atlasUvFor addressing. Null + gate 0 when off → three.js skips the
      // bind and the fragment branches around the samples.
      uAtlasNormalAo: { value: opts.pbrNormalAoTex ?? null },
      uPbrEnabled: { value: opts.pbrEnabled ? 1.0 : 0.0 },
      // T3 (?ibl=on) — seeded off; IblEnvironment.tick (loop.js) pushes the
      // env cube + enable + diurnal intensity over scene3d.terrainMaterials
      // every frame, so bake order vs ibl-init order never matters.
      uEnvCube: { value: null },
      uIblEnabled: { value: 0.0 },
      uEnvIntensity: { value: 1.0 },
      uWaterEnvEnabled: { value: opts.waterEnvEnabled ? 1.0 : 0.0 },
      // T1 splat-noise borders (default on; ?splatNoise=off → amp 0 no-op).
      uSplatNoiseAmp: { value: Number.isFinite(opts.splatNoiseAmp) ? opts.splatNoiseAmp : 0.0 },
      uSplatNoiseFreq: { value: Number.isFinite(opts.splatNoiseFreq) ? opts.splatNoiseFreq : 0.35 },
      // 2026-08-02 — macro splat octave (?splatMacro=off → 0 → legacy expr).
      uSplatMacroAmp: {
        value: Number.isFinite(opts.splatMacroAmp) ? opts.splatMacroAmp : 0.0,
      },
      uSplatMacroFreq: {
        value: Number.isFinite(opts.splatMacroFreq)
          ? opts.splatMacroFreq
          : SPLAT_MACRO_FREQ_DEFAULT,
      },
      // 2026-08-02 — FAR MACRO ("mspaint" fix). Null texture + gate 0 when the
      // flag is off or the asset load failed → three skips the bind and the
      // fragment branches around every sample. The int[33] LUT must ALWAYS be
      // length 33 or three warns on the bind, so it falls back to all-255
      // ("no family macro for any code"), which is itself a full no-op.
      uMacroTex: { value: opts.macroTex ?? null },
      uMacroSliceForCode: {
        value: opts.macroSliceLut ?? new Array(33).fill(MACRO_SLICE_NONE),
      },
      uMacroSliceCount: { value: opts.macroSliceCount ?? 0 },
      uMacroEnabled: { value: opts.macroEnabled ? 1.0 : 0.0 },
      uMacroStrength: { value: readMacroStrength() },
      uMacroFadeStart: { value: readMacroFadeStart() },
      uMacroFadeEnd: { value: readMacroFadeEnd() },
      uMacroScaleA: { value: readMacroScaleA() },
      uMacroScaleB: { value: readMacroScaleB() },
      uMacroNoiseAmp: { value: readMacroNoiseAmp() },
      // T4 POM (quality high/ultra + pbr assets; ?pom=off escape).
      uPomEnabled: { value: opts.pomEnabled ? 1.0 : 0.0 },
      uPomScale: { value: 0.012 },
      uPomFadeStart: { value: 12.0 },
      uPomFadeEnd: { value: 25.0 },
      // T1 (2026-05-29) — per-code base tex_tiling (retail all 2). Falls back
      // to the all-1 LUT (atlasUvFor no-op) when the wasm fetch failed, so the
      // default-on path is fail-soft to the prior 1× render. The int[33]
      // uniform must always be length 33 or three.js warns on the bind.
      uBaseTexTiling: {
        value: opts.baseTexTiling ?? BASE_TEX_TILING_FALLBACK,
      },
      uVertexTypes: { value: vertexTypesTex },
      // Retail-style road painting (replaces the prior road-overlay
      // mesh). The road texture is the same retail-DAT road tile we
      // were previously stamping onto separate quads; now it's sampled
      // directly in the terrain shader, bilinear-blended via the
      // per-vertex road bit packed into uVertexTypes.G.
      // uRoadTileScale = 1/6 means one tile per 6 m along vGridUv
      // (matches the prior ROAD_TEXTURE_TILE_M = 6 from the overlay
      // path). vGridUv is in cell units (1.0 per 24 m), so the scale
      // factor here is 24 / 6 = 4 — four tile repeats per cell.
      uRoadTexture: { value: opts.roadTexture ?? null },
      uRoadTileScale: { value: 4.0 },
      uRoadEnabled: { value: opts.roadTexture ? 1.0 : 0.0 },
      // 2026-07-02 — ?roadPaint=legacy restores the bilinear+smoothstep lane
      // (vanishes on diagonal road runs) for A/B against the analytic
      // segment-distance painter that is now the default.
      uRoadPaintLegacy: { value: opts.roadPaintLegacy ? 1.0 : 0.0 },
      // 2026-07-02 — ?roadSlots=on: retail mask-composited road overlays
      // (TexMerge slots 4..5); analytic lane painter gates off when active.
      uRoadSlotsEnabled: { value: opts.roadSlotsEnabled ? 1.0 : 0.0 },
      // Wave 2.A — terrain palette LUT (see comment block at the top
      // of this file for the schema + fallback behaviour). Threaded
      // via opts from resolveTerrainRingOpts so the texture is shared
      // across every per-LB material in the ring (one upload).
      uTerrainPalette: { value: opts.terrainPaletteTexture ?? null },
      uTerrainPaletteEnabled: {
        value: opts.terrainPaletteTexture ? 1.0 : 0.0,
      },
      uTerrainPaletteStrength: {
        value: Number.isFinite(opts.terrainPaletteStrength)
          ? opts.terrainPaletteStrength
          : DEFAULT_TERRAIN_PALETTE_STRENGTH,
      },
      // 2026-05-28 — TerrainTex modulation gate. 0.0 = no per-vertex
      // brightness multiply (default — modulation was not applied by
      // shipped retail per the audit memo); 1.0 = apply. Wired from
      // `opts.terrainModulationEnabled` which `resolveTerrainRingOpts`
      // sets from the URL flag `?terrainMod=on`.
      uTerrainModulationEnabled: {
        value: opts.terrainModulationEnabled ? 1.0 : 0.0,
      },
      // R1.A 2026-05-28 — sat/hue sub-gate. Defaults to 1.0 (full
      // effect) when `?terrainMod=on`, so the master flag turns on
      // brightness + sat/hue together; force it to 0.0 to A/B
      // brightness-only on the GPU (see `terrainModSatHueEnabled` in
      // resolveTerrainRingOpts, driven by `?terrainModSatHue=off`).
      // Multiplied with uTerrainModulationEnabled in the fragment so
      // the master gate being off is always a strict no-op.
      uTerrainModSatHue: {
        value: opts.terrainModSatHueEnabled ? 1.0 : 0.0,
      },
      // Phase 1.2 — terrain detail-normal array + per-code slice
      // table + per-frame wind direction + quality gate. When
      // `detailNormalEnabled` is false the texture uniform is set
      // to null (three.js skips the bind) and uDetailNormalEnabled
      // = 0.0 makes the fragment shader branch around the sample.
      uTerrainDetailNormalArray: { value: opts.detailNormalArrayTex },
      uCodeToSlice: { value: opts.codeToSliceArr },
      uDetailScale: { value: DEFAULT_DETAIL_SCALE },
      uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
      uDetailNormalEnabled: {
        value: opts.detailNormalEnabled ? 1.0 : 0.0,
      },
      // F12-3 — slope-dependent sun shading gate (?terrainSlopeShading=on,
      // default off). Feeds the geometry normal (vAcNormal) into baseN +
      // base NdotL so terrain slopes pick up light/shade relief.
      uTerrainSlopeShadingEnabled: {
        value: opts.slopeShadingEnabled ? 1.0 : 0.0,
      },
      // T7 — terrain detail-DIFFUSE array + per-code LUTs + tuning. All
      // threaded from opts (built once in resolveTerrainRingOpts). When the
      // flag is off `opts.detailTexArray` is null and uDetailTexEnabled = 0
      // so the fragment branch is skipped; the int[33] LUTs still bind a
      // valid 33-length fallback so three.js doesn't warn on a short array.
      uTerrainDetailTex: { value: opts.detailTexArray ?? null },
      uCodeToDetailTexSlice: {
        value: opts.detailTexCodeToSlice ?? DETAIL_TEX_SLICE_FALLBACK,
      },
      uDetailTexTiling: {
        value: opts.detailTexCodeTiling ?? DETAIL_TEX_TILING_FALLBACK,
      },
      uDetailTexSliceCount: {
        value: Number.isInteger(opts.detailTexSliceCount)
          ? opts.detailTexSliceCount
          : 0,
      },
      uDetailTexBaseScale: {
        value: Number.isFinite(opts.detailTexBaseScale)
          ? opts.detailTexBaseScale
          : DEFAULT_DETAIL_TEX_BASE_SCALE,
      },
      uDetailTexStrength: {
        value: Number.isFinite(opts.detailTexStrength)
          ? opts.detailTexStrength
          : DEFAULT_DETAIL_TEX_STRENGTH,
      },
      uDetailTexFadeStart: {
        value: Number.isFinite(opts.detailTexFadeStart)
          ? opts.detailTexFadeStart
          : DEFAULT_DETAIL_TEX_FADE_START,
      },
      uDetailTexFadeEnd: {
        value: Number.isFinite(opts.detailTexFadeEnd)
          ? opts.detailTexFadeEnd
          : DEFAULT_DETAIL_TEX_FADE_END,
      },
      uDetailTexEnabled: { value: opts.detailTexEnabled ? 1.0 : 0.0 },
      // 2026-07-02 rev 3 — retail crossfade op (see the fragment branch).
      uDetailTexCrossfade: { value: opts.detailTexCrossfade ? 1.0 : 0.0 },
      // T1 — TexMerge composite. uMergeData is per-LB (built just above);
      // uAlphaMasks is the shared ordered mask array from opts. Enabled only
      // when BOTH the flag built a mask array AND this LB got a merge texture
      // — otherwise the bilinear path runs (uTexMergeEnabled = 0).
      uMergeData: { value: mergeDataTex },
      uAlphaMasks: { value: opts.texMergeAlphaArray ?? null },
      uTexMergeEnabled: {
        value: opts.texMergeEnabled && mergeDataTex ? 1.0 : 0.0,
      },
      // 2026-06-21 — runtime A/B toggle for the alpha-mask rotation sign (see
      // rotateCellUv). Default 0 is now the retail-exact sign (derived from
      // MergeTexture's rotation addressing, not eye-tested); 1 restores the
      // pre-fix N-S-mirrored sign. Honour ?texMergeRot=flip too.
      uMaskRotFlip: { value: opts.maskRotFlip ? 1.0 : 0.0 },
      // 2026-06-21 — per-vertex stochastic painting (?paintMode=winner).
      uPaintMode: { value: (opts.paintMode === "winner" || opts.paintMode === "warp") ? 1.0 : 0.0 },
      uPaintNoiseFreq: { value: Number.isFinite(opts.paintNoiseFreq) ? opts.paintNoiseFreq : 8.0 },
      uPaintNoiseStrength: { value: Number.isFinite(opts.paintNoiseStrength) ? opts.paintNoiseStrength : 0.4 },
      // 2026-06-22 — Candidate H (domain-warped coherent-noise winner + soft band).
      uWarpAmp: { value: Number.isFinite(opts.warpAmp) ? opts.warpAmp : 0.0 },
      uWarpFreq: { value: Number.isFinite(opts.warpFreq) ? opts.warpFreq : 1.0 },
      uWinnerSoftness: { value: Number.isFinite(opts.winnerSoftness) ? opts.winnerSoftness : 0.0 },
      // R4.a — retail mid-point alpha rounding sub-gate. Rides ?texMerge
      // (defaults ON when the composite is active) so the refinement is
      // part of the opt-in feature; flip TEXMERGE_ALPHA_ROUND to false for
      // an on-GPU A/B of the composite with vs without the rounding. The
      // shader also multiplies by uTexMergeEnabled, so this is a no-op
      // whenever the composite itself is off.
      uTexMergeAlphaRound: {
        value:
          opts.texMergeEnabled && mergeDataTex && TEXMERGE_ALPHA_ROUND
            ? 1.0
            : 0.0,
      },
      // Phase 1.3 — triplanar gate + sharpness. When the gate is
      // 0.0 the fragment skips the YZ+XZ samples entirely and the
      // detail-normal falls back to the XY-only Phase 1.2 path.
      uTriplanarEnabled: { value: opts.triplanarEnabled ? 1.0 : 0.0 },
      uTriplanarSharpness: { value: DEFAULT_TRIPLANAR_SHARPNESS },
      // Perf D3 — per-quality slope LO threshold. `opts.triplanarSlopeLo`
      // is resolved from `quality.flags.triplanarSlopeThresholdPct / 100`
      // in resolveTerrainRingOpts (defensive fallback 30 → 0.3).
      uTriplanarSlopeLo: { value: opts.triplanarSlopeLo },
      // Phase 2.2 — animated displacement uniforms. uTime is pushed
      // from `loop.js::tickPerFrame` once per rAF via the shared
      // `scene3d.terrainMaterials` registry below. uWaterCodeMask /
      // uLavaCodeMask are packed bitmasks (bit i = code i). Gate is
      // 1.0 only when subdivLevel >= 2. uLbOriginXy lets the wave
      // phase stay continuous across LB seams (world-frame XY).
      // 2026-07-31 (water-fix) — SEEDED to the live shared clock, not 0.0.
      // Every LB stream-in / LOD re-bake / LRU unpark builds a fresh material
      // whose uTime stayed 0 until the next tickTerrainUTime, so its first
      // rendered frame (the bake pre-warm draws it) showed water at t=0 while
      // its neighbours were at t=now — a one-frame phase tear along the new
      // LB's seam every time terrain rebaked around the player.
      uTime: { value: sharedTerrainTimeSec(scene3d) },
      uWaterCodeMask: { value: opts.waterCodeMask },
      // 2026-07-31 (water-fix) — the fragment stage's wider SURFACE set.
      // Defaults to the swell set when a caller predates this field, so an
      // older opts object degrades to the previous single-mask behaviour
      // rather than to "no water at all".
      uWaterSurfaceCodeMask: {
        value: Number.isInteger(opts.waterSurfaceCodeMask)
          ? opts.waterSurfaceCodeMask
          : opts.waterCodeMask,
      },
      uLavaCodeMask: { value: opts.lavaCodeMask },
      // Wave 1B — SAND GRAIN SPARKLE (plan §3.2 item 4). Ships OFF: the gate is
      // `?terrainSand=on && ?terrainSandSparkle` composed in
      // resolveTerrainRingOpts, so an absent flag leaves the value 0.0 and the
      // fragment block is a strict no-op. The code mask is derived from
      // terrain_families.js FAM_SAND (never a hardcoded 10..12 range).
      uSandSparkleEnabled: { value: opts.sandSparkleEnabled ? 1.0 : 0.0 },
      uSandSparkleCodeMask: {
        value: Number.isInteger(opts.sandSparkleCodeMask) ? opts.sandSparkleCodeMask : 0,
      },
      uSandSparkleStrength: {
        value: Number.isFinite(opts.sandSparkleStrength)
          ? opts.sandSparkleStrength
          : DEFAULT_SAND_SPARKLE_STRENGTH,
      },
      uSandSparkleDensity: { value: DEFAULT_SAND_SPARKLE_DENSITY },
      uSandSparkleFadeStart: { value: DEFAULT_SAND_SPARKLE_FADE_START },
      uSandSparkleFadeEnd: { value: DEFAULT_SAND_SPARKLE_FADE_END },
      // Wave 2A — SNOW / ICE (plan §3.4). Ships OFF: every gate below is
      // seeded from a flag that requires an exact `=== "on"`, so the three
      // fragment blocks are strict no-ops on a bare-default boot.
      uSnowSparkleEnabled: { value: opts.snowSparkleEnabled ? 1.0 : 0.0 },
      uSnowSparkleCodeMask: {
        value: Number.isInteger(opts.snowSparkleCodeMask) ? opts.snowSparkleCodeMask : 0,
      },
      uSnowSparkleStrength: { value: DEFAULT_SNOW_SPARKLE_STRENGTH },
      uSnowSparkleDensity: { value: DEFAULT_SNOW_SPARKLE_DENSITY },
      uSnowSparkleSharpness: { value: DEFAULT_SNOW_SPARKLE_SHARPNESS },
      uSnowSparkleFadeStart: { value: DEFAULT_SNOW_SPARKLE_FADE_START },
      uSnowSparkleFadeEnd: { value: DEFAULT_SNOW_SPARKLE_FADE_END },
      // Footprints. uSnowTrailMap / uSnowTrailCenter / uSnowTrailRadius /
      // uSnowTrailEnabled are seeded INERT and refreshed each frame by
      // scene3d/terrain_snow.js over scene3d.terrainMaterials — the same
      // per-frame push loop.js::tickTerrainUTime and IblEnvironment.tick use,
      // so bake order vs trail-map construction order never matters. A null
      // sampler binds three's empty texture; it is never read while
      // uSnowTrailEnabled is 0.
      uSnowPrintEnabled: { value: opts.snowPrintEnabled ? 1.0 : 0.0 },
      uSnowPrintDepth: { value: DEFAULT_SNOW_PRINT_DEPTH },
      uSnowPrintDarken: { value: DEFAULT_SNOW_PRINT_DARKEN },
      uSnowTrailMap: { value: null },
      uSnowTrailCenter: { value: new THREE.Vector2(0, 0) },
      uSnowTrailRadius: { value: 48.0 },
      uSnowTrailEnabled: { value: 0.0 },
      // Ice material treatment — codes 2/27 only (a strict subset of the snow
      // mask). Separate master (`?terrainIce`) from the snow family.
      uIceEnabled: { value: opts.iceEnabled ? 1.0 : 0.0 },
      uIceCodeMask: {
        value: Number.isInteger(opts.iceCodeMask) ? opts.iceCodeMask : 0,
      },
      uIceGloss: { value: DEFAULT_ICE_GLOSS },
      uIceSpecStrength: { value: DEFAULT_ICE_SPEC_STRENGTH },
      uIceEnvStrength: { value: DEFAULT_ICE_ENV_STRENGTH },
      uIceRefractEnabled: { value: opts.iceRefractionEnabled ? 1.0 : 0.0 },
      uIceRefractAmount: { value: DEFAULT_ICE_REFRACT_AMOUNT },

      // Wave 2B — VOLCANO CRACK GLOW + OBSIDIAN (plan §3.6 items 3 + 5). Ships
      // OFF: the gate is `?terrainVolcano=on && ?terrainCrackGlow` composed in
      // resolveTerrainRingOpts, so an absent flag leaves the value 0.0 and the
      // fragment block is a strict no-op. Masks derived from
      // terrain_families.js FAM_VOLCANO / the retail ObsidianPlain enum.
      uCrackGlowEnabled: { value: opts.crackGlowEnabled ? 1.0 : 0.0 },
      uVolcanoCodeMask: {
        value: Number.isInteger(opts.volcanoCodeMask) ? opts.volcanoCodeMask : 0,
      },
      uObsidianCodeMask: {
        value: Number.isInteger(opts.obsidianCodeMask) ? opts.obsidianCodeMask : 0,
      },
      uCrackGlowStrength: { value: DEFAULT_CRACK_GLOW_STRENGTH },
      uCrackGlowDensity: { value: DEFAULT_CRACK_GLOW_DENSITY },
      uCrackGlowWidth: { value: DEFAULT_CRACK_GLOW_WIDTH },
      uCrackGlowColor: {
        value: new THREE.Vector3(
          DEFAULT_CRACK_GLOW_COLOR[0],
          DEFAULT_CRACK_GLOW_COLOR[1],
          DEFAULT_CRACK_GLOW_COLOR[2],
        ),
      },
      // Pushed each frame by loop.js::tickTerrainUTime from the shared
      // oscillator registry — see the GLSL declaration for why it is a PUSH and
      // not a by-reference binding (terrain_batch.js clones uniform values).
      uCrackGlowBreath: { value: DEFAULT_CRACK_GLOW_BREATH },
      uCrackGlowFadeStart: { value: DEFAULT_CRACK_GLOW_FADE_START },
      uCrackGlowFadeEnd: { value: DEFAULT_CRACK_GLOW_FADE_END },
      uObsidianShininess: { value: DEFAULT_OBSIDIAN_SHININESS },
      uObsidianSpecular: { value: DEFAULT_OBSIDIAN_SPECULAR },
      uObsidianEnv: { value: DEFAULT_OBSIDIAN_ENV },

      // Wave 3B — MUD PRINTS + WET MUD (plan §3.7 items 2 + 4). Ships OFF: the
      // gates are `?terrainDirt=on && ?terrainMudPrints` / `?terrainMudWetness`
      // composed in resolveTerrainRingOpts, so an absent flag leaves both values
      // 0.0 and the fragment blocks are strict no-ops. Masks derived from
      // terrain_families.js FAM_DIRT and its clay sub-variant.
      //
      // uMudTrailEnabled and uMudWetness are seeded INERT and refreshed each
      // frame by scene3d/terrain_dirt.js over scene3d.terrainMaterials — the
      // same per-frame push loop.js::tickTerrainUTime and IblEnvironment.tick
      // use, so bake order vs trail-map construction order never matters, and
      // the push (not a by-reference bind) is what makes it work on the
      // ?terrainBatch path where uniform VALUES are cloned. NOTE there is no
      // uMudTrailMap: the trail SAMPLER is shared with wave 2A's uSnowTrailMap
      // (see the GLSL uniform block) — the sampler budget is 15/16 and a second
      // one would sit on the WebGL2 floor.
      uMudPrintEnabled: { value: opts.mudPrintEnabled ? 1.0 : 0.0 },
      uMudTrailEnabled: { value: 0.0 },
      uDirtCodeMask: {
        value: Number.isInteger(opts.dirtCodeMask) ? opts.dirtCodeMask : 0,
      },
      uClayCodeMask: {
        value: Number.isInteger(opts.clayCodeMask) ? opts.clayCodeMask : 0,
      },
      uMudPrintDepth: { value: DEFAULT_MUD_PRINT_DEPTH },
      uMudPrintDarken: { value: DEFAULT_MUD_PRINT_DARKEN },
      uMudPrintDryScale: { value: DEFAULT_MUD_PRINT_DRY_SCALE },
      uMudWetEnabled: { value: opts.mudWetnessEnabled ? 1.0 : 0.0 },
      uMudWetness: { value: 0.0 },
      uMudWetStrength: { value: DEFAULT_MUD_WET_STRENGTH },
      uMudWetDarken: { value: DEFAULT_MUD_WET_DARKEN },
      uMudWetRoughDrop: { value: DEFAULT_MUD_WET_ROUGH_DROP },
      uMudBaseRough: { value: DEFAULT_MUD_BASE_ROUGH },
      uMudWetSpec: { value: DEFAULT_MUD_WET_SPEC },
      uMudWetEnv: { value: DEFAULT_MUD_WET_ENV },
      uClayWetTint: {
        value: new THREE.Vector3(
          DEFAULT_CLAY_WET_TINT[0],
          DEFAULT_CLAY_WET_TINT[1],
          DEFAULT_CLAY_WET_TINT[2],
        ),
      },
      uClayWetGloss: { value: DEFAULT_CLAY_WET_GLOSS_BONUS },
      uDisplacementEnabled: {
        value: opts.displacementEnabled ? 1.0 : 0.0,
      },
      // 2026-07-08 — surface UV-scroll gate, independent of the subdiv/
      // displacement LOD (opts.waterScrollEnabled defaults true; `?waterScroll=off`
      // → 0.0 = fully static). Cloned into the batched material by
      // terrain_batch._buildBatchMaterial, so both paths animate.
      uWaterScrollEnabled: {
        value: opts.waterScrollEnabled === false ? 0.0 : 1.0,
      },
      uLbOriginXy: {
        value: new THREE.Vector2(
          lbX * METERS_PER_LANDBLOCK,
          lbY * METERS_PER_LANDBLOCK
        ),
      },
      // Clouds-L — cloud shadow uniforms. Updated each frame from
      // cloud_volume.js when CloudOverlay is wired. Default off
      // (uCloudShadowEnabled=0) so terrain renders correctly when
      // clouds=on isn't set.
      uCloudShadowEnabled: { value: 0.0 },
      uCloudShadowMap: { value: null },
      uCloudShadowMatrix0: { value: new THREE.Matrix4() },
      uCloudShadowStrength: { value: 2.0 },
      // Initial sun direction = the prior hardcoded literal so the
      // pre-populator fallback matches old behavior exactly.
      uSunDir: { value: new THREE.Vector3(-0.4, -0.3, 1.0).normalize() },
      // RND-20/21 — retail Gouraud terrain. Gated on BOTH the flag and the
      // acLightNormal attribute actually being present on this geometry (the
      // 9x9 non-subdivided path and any stale wasm bundle have no such
      // attribute, and WebGL would feed it (0,0,0) → a sunless terrain).
      // Seeded to the retail no-region fallback (ambient at
      // LSCAPE_LIGHT_MINIMUM, sun dark) so the pre-populator frame before
      // loop.js's first push is dim rather than black or blown out.
      uAcGouraudEnabled: {
        value: TERRAIN_GOURAUD_ON && geom.getAttribute("acLightNormal") ? 1.0 : 0.0,
      },
      uAcSunVec: { value: new THREE.Vector3(0, 0, 0) },
      uAcSunColor: { value: new THREE.Color(1, 1, 1) },
      uAcAmbColor: { value: new THREE.Color(1, 1, 1) },
      uAcAmbLevel: { value: 0.2 },
      // CSM-on-terrain. Mirrors materials.js's MeshStandardMaterial
      // patch. Texture refs + matrices refreshed each frame by
      // csm.refreshCsmUniforms once the material is registered on
      // csmState.patchedMaterials below. uCsmEnabled stays 0.0 when
      // csmState is absent (low/mid quality presets, ?shadows=off);
      // shader branch around the sampling cost.
      uCsmEnabled: {
        value: scene3d?.csmState ? 1.0 : 0.0,
      },
      uCsmShadowMap0: {
        value: scene3d?.csmState?.lights?.[0]?.shadow?.map?.texture ?? null,
      },
      uCsmShadowMap1: {
        value: scene3d?.csmState?.lights?.[1]?.shadow?.map?.texture ?? null,
      },
      uCsmShadowMap2: {
        value: scene3d?.csmState?.lights?.[2]?.shadow?.map?.texture ?? null,
      },
      uCsmMatrix0: {
        value: scene3d?.csmState?.lights?.[0]?.shadow?.matrix?.clone() ?? new THREE.Matrix4(),
      },
      uCsmMatrix1: {
        value: scene3d?.csmState?.lights?.[1]?.shadow?.matrix?.clone() ?? new THREE.Matrix4(),
      },
      uCsmMatrix2: {
        value: scene3d?.csmState?.lights?.[2]?.shadow?.matrix?.clone() ?? new THREE.Matrix4(),
      },
      uCsmSplits: {
        value: new THREE.Vector2(
          scene3d?.csmState?.splits?.[0] ?? 30,
          scene3d?.csmState?.splits?.[1] ?? 100,
        ),
      },
      uCsmFar: {
        value: scene3d?.csmState?.splits?.[2] ?? 300,
      },
      uCsmBlend: {
        value: scene3d?.csmState?.blendFrac ?? 0.1,
      },
    },
    vertexShader: TERRAIN_VERTEX_GLSL,
    fragmentShader: TERRAIN_FRAGMENT_GLSL,
    glslVersion: THREE.GLSL3,
    // Heightfield is single-sided: backfaces are looking at the
    // world from below the terrain — never the player's vantage.
    // The F#27 fix in `landblockMeshToGeometry` reverses the wasm's
    // CW-from-AC-+Z index winding so FrontSide is correct post-
    // worldRoot rotation. Don't flip back to DoubleSide without
    // also reverting the adapter's index reversal.
    side: THREE.FrontSide,
    });
  }

  // Phase 2.2 — register the material so the per-rAF tick can push
  // the shared wall-clock `uTime`. Single shared time source means
  // matched wave motion across LB seams (objective #4). The registry
  // entry retains the ShaderMaterial handle directly; on
  // disposal/rebuild the caller should null out scene3d.terrainMaterials.
  // Wire-agent skips the time-push (MeshBasicMaterial has no uTime).
  if (!scene3d.wireframeMode) {
    scene3d.terrainMaterials.push(material);
  }

  // CSM-on-terrain — register the material on csmState.patchedMaterials
  // so csm.refreshCsmUniforms walks it each frame and pushes fresh
  // shadow.matrix + shadow.map.texture refs onto our uniforms. Mirrors
  // materials.js's MeshStandardMaterial patch but for our raw GLSL3
  // shader. `csmShaderUniforms = material.uniforms` works because
  // ShaderMaterial's uniforms ARE the shader's uniforms (no
  // onBeforeCompile copy). Skipped in wire-agent (no CSM, no shader).
  if (!scene3d.wireframeMode && scene3d.csmState?.patchedMaterials) {
    material.userData = {
      ...(material.userData || {}),
      csmShaderUniforms: material.uniforms,
    };
    scene3d.csmState.patchedMaterials.add(material);
  }

  const lbMesh = new THREE.Mesh(geom, material);
  lbMesh.name = `terrain-lb-${lbX.toString(16)}-${lbY.toString(16)}`;
  // Visual-fidelity Phase 0.1 + 3.3 — flag the terrain mesh as a shadow
  // receiver under EITHER the single-shadow path (shadowsEnabled) OR
  // the CSM path (csmEnabled). CSM sampling is now injected directly
  // into the terrain ShaderMaterial above (the "deferred to Phase
  // 1.* / 2.*" gap is closed); building/static cast shadows land on
  // terrain when ?quality=high or ultra (csm flag on).
  if (scene3d.shadowsEnabled || scene3d.csmEnabled) {
    lbMesh.receiveShadow = true;
  }
  // Per-LB world offset (xy in metres). The geometry is LB-local
  // (x,y in [0, 192]) so the world position is just (lbX*192, lbY*192).
  lbMesh.position.set(
    lbX * METERS_PER_LANDBLOCK,
    lbY * METERS_PER_LANDBLOCK,
    0
  );
  // Stash height range on the userData so the capture can verify
  // terrain isn't flat-zero without a wasm round-trip.
  //
  // Task D (2026-05-12) — `terrainCodes` is the wasm column-major
  // 81-byte block (vertex `i` has gridX = i/9, gridY = i%9; see
  // `adapter.js::buildVertexTypesDataTexture` for the transpose note).
  // The ambient-runtime sampler reads this per tick to look up the
  // player's terrain type for the Region → AmbientSTB chain. Storing
  // the raw bytes (not the DataTexture) keeps the runtime free of
  // GPU readback — sampling is a single byte fetch per tick.
  // Has any vertex with a road bit set? Used by the post-bake summary
  // counter; previously inferred from the road-overlay child mesh
  // which no longer exists (roads are now painted in the terrain
  // shader via uVertexTypes.G).
  let hasRoads = false;
  for (let i = 0; i < roadCodesCopy.length; i += 1) {
    if (roadCodesCopy[i] !== 0) { hasRoads = true; break; }
  }
  lbMesh.userData = {
    lbX,
    lbY,
    lbId: ((lbX << 24) | (lbY << 16) | 0xffff) >>> 0,
    heightMin,
    heightMax,
    vertexTypesTexture: vertexTypesTex,
    // T1/#23 — per-LB TexMerge DataTexture (null unless `?texMerge=on`
    // AND the wasm mesh carried merge data). Exposed so the LRU track
    // sites can add it to `disposables.textures` for eviction (it's a
    // per-LB GPU resource, not a cache-shared atlas).
    mergeDataTexture: mergeDataTex,
    terrainCodes: terrainCodesCopy,
    // Terrain-VFX Wave 0A — the 81 control-grid Z values, column-major
    // (`idx = vx*9 + vy`), so `scene3d/terrain_oracle.js` can cache exact
    // ground height per LB and keep answering after `landblock_lru.park()`
    // removes this mesh from terrainGroup.
    heights: Float32Array.from(wasmMesh.heights),
    roadCodes: roadCodesCopy,
    hasRoads,
    // Phase 1.2 — capture probes inspect this to verify the detail-
    // normal patch is wired without a GL state pull.
    detailNormalEnabled: opts.detailNormalEnabled,
    detailNormalSlice: opts.detailNormalEnabled ? "array(5)" : "off",
    // Phase 1.3 — same idea for triplanar wiring. `slopeLo`/`slopeHi`
    // come from the JS-side constants the GLSL is interpolated with;
    // captures use them to compute the expected smoothstep blend at
    // any given fragment without re-reading the shader source.
    triplanarEnabled: opts.triplanarEnabled,
    triplanarSharpness: opts.triplanarEnabled ? DEFAULT_TRIPLANAR_SHARPNESS : 0,
    // Perf D3 — opts-driven LO (per-quality) replaces the prior constant.
    // HI end is still the JS-side TRIPLANAR_SLOPE_HI baked into the
    // shader source.
    triplanarSlopeLo: opts.triplanarSlopeLo,
    triplanarSlopeHi: TRIPLANAR_SLOPE_HI,
    // Phase 2.1 — actual subdivision factor used for this LB.
    // 1 = no subdivision (legacy 9×9 path); 2/4/8 = subdivided.
    subdivLevel: effectiveSubdiv,
    // Phase 2.2 — capture probes inspect these to verify the
    // displacement patch is wired. uTime is mutated each rAF by
    // `loop.js::tickPerFrame`; the snapshot here records the wiring
    // state at build time.
    displacementEnabled: opts.displacementEnabled,
    waterCodeMask: opts.waterCodeMask,
    waterSurfaceCodeMask: opts.waterSurfaceCodeMask,
    lavaCodeMask: opts.lavaCodeMask,
  };

  // ?terrainBatch (2026-07-02, default OFF) — fold this LB's draw into the
  // shared cross-LB BatchedMesh (scene3d/terrain_batch.js). The absorber is
  // synchronous and copies the geometry + the per-LB DataTexture bytes into
  // the batch; on success it sets lbMesh.visible=false so the mesh below
  // attaches as a HIDDEN data-carrier (userData still feeds the ambient
  // sampler / LRU / LOD walkers; a hidden mesh never uploads VBOs, so its
  // prewarm is skipped). On any failure it returns false having changed
  // nothing and the legacy visible per-LB draw runs unchanged (fail-soft —
  // a failed consolidation is never a vanished landblock). Flag off ⇒ the
  // guard short-circuits before the call.
  let terrainBatchAbsorbed = false;
  if (!scene3d.wireframeMode && terrainBatchEnabled()) {
    terrainBatchAbsorbed = tryAbsorbTerrainLbIntoBatch(scene3d, lbMesh, opts, {
      vertexGlsl: TERRAIN_VERTEX_GLSL,
      fragmentGlsl: TERRAIN_FRAGMENT_GLSL,
      texMergeAlphaRound: TEXMERGE_ALPHA_ROUND,
    });
  }

  // Item 4 (2026-06-22): pre-warm this LB's shader program + DataTexture uploads
  // (vertexTypes / TexMerge) in the driver background BEFORE attaching, so the
  // first render frame after attach doesn't pay a synchronous compile+upload hitch
  // (the cost the 1070 r10 probe flagged). Safe without a residency re-check: the LB
  // isn't LRU-tracked until this baker resolves and the stream guard holds the
  // in-flight key, so it can't be evicted across this await. `?bakePrewarm=off` skips.
  // (?terrainBatch: skipped for an absorbed proxy — it never renders.)
  if (!terrainBatchAbsorbed) {
    await prewarmSubtree(scene3d, lbMesh);
  }

  scene3d.terrainGroup.add(lbMesh);

  // 2026-05-22 — wire-agent: pair the wireframe mesh with a second mesh
  // sharing the same BufferGeometry that draws the solid colour fill
  // (vertexColors driven by the TERRAIN_CODE_TO_RGB palette). polygon-
  // Offset on the fill material pushes it slightly behind the wire so
  // the cell lines stay crisp without z-fighting. Sharing geometry means
  // no extra GPU memory; two draw calls per LB instead of one — still
  // negligible at 9-LB (agentic=low) or 169-LB scale.
  if (scene3d.wireframeMode && scene3d._wireTerrainFillMaterial) {
    const fillMesh = new THREE.Mesh(geom, scene3d._wireTerrainFillMaterial);
    fillMesh.name = `terrain-lb-fill-${lbX.toString(16)}-${lbY.toString(16)}`;
    fillMesh.position.set(
      lbX * METERS_PER_LANDBLOCK,
      lbY * METERS_PER_LANDBLOCK,
      0
    );
    fillMesh.userData = { wireFillFor: lbMesh.name, lbX, lbY };
    scene3d.terrainGroup.add(fillMesh);
  }

  // Roads are now painted inside the terrain shader via the G-channel
  // of uVertexTypes + uRoadTexture (retail-style bilinear-blended,
  // naturally flush with the terrain surface). The prior road-overlay
  // mesh path is gone; see TERRAIN_FRAGMENT_GLSL's `uRoadEnabled` block.

  // Free the wasm mesh now that all needed data is copied. Skip if the
  // mesh came from the prefetch batch — the ring driver owns those and
  // will free them when its loop completes (avoids double-free).
  if (!opts.prefetchedMesh && typeof wasmMesh.free === "function") {
    wasmMesh.free();
  }

  return lbMesh;
}

/**
 * world-expand step 1 — terrain ring driver.
 *
 * Bakes every LB in the `(dx, dy) ∈ [-radius, +radius]² ∩ [0, 255]²`
 * ring around `(centreLbX, centreLbY)`. Resolves once-per-ring shader
 * uniforms / textures (atlas, road, codeToSliceArr, etc.) up front, then
 * batches the per-LB heightmap + subdiv fetches and fans out
 * `bakeTerrainForLandblock` via `Promise.all`.
 *
 * Returns the same summary shape `buildHoltburgTerrain` returned before
 * the refactor, plus `lbCount` reflecting the actual number of LBs in
 * the ring (radius=1 → 9; radius=6 → 169 at full ring, fewer at world
 * edges). The lbCount is the **ring size**, not necessarily the number
 * of LBs added in this call — re-bakes of an already-baked LB
 * short-circuit in `bakeTerrainForLandblock` and don't change the
 * children count of `terrainGroup`.
 *
 * Note on child order: prior `buildHoltburgTerrain` added children in
 * coord-traversal order (`dy:+1→-1, dx:-1→+1`). The ring driver still
 * issues the bakes in that order, but the `Promise.all` fan-out means
 * the actual `terrainGroup.children` order is microtask-resolution
 * order, not coord order. No caller relies on a specific index
 * (capture_phase7_1_terrain asserts only count; capture_visfid_p21_subdiv
 * finds the centre LB via `find(c => c.userData.lbX === 0xa9)`).
 */
export async function bakeTerrainRing(
  scene3d,
  centreLbX,
  centreLbY,
  radius,
  wasmExports
) {
  if (!scene3d || !scene3d.terrainGroup) {
    throw new Error(
      "bakeTerrainRing: scene3d.terrainGroup missing (call init3D first)"
    );
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_heightmaps !== "function" ||
    typeof wasmExports.fetch_terrain_textures !== "function"
  ) {
    throw new Error(
      "bakeTerrainRing: wasmExports missing fetch_landblock_heightmaps / fetch_terrain_textures"
    );
  }

  // 1. Build the coord list. Order matches the prior
  // `holtburgNeighbourhoodCellIds` traversal at radius=1 so the
  // batch-fetch input array stays bit-identical to today's call.
  const coords = [];
  for (let dy = radius; dy >= -radius; dy -= 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = centreLbX + dx;
      const y = centreLbY + dy;
      if (x < 0 || x > 0xff || y < 0 || y > 0xff) continue;
      coords.push({
        x,
        y,
        id: ((x << 24) | (y << 16) | 0xffff) >>> 0,
      });
    }
  }

  // 2. Resolve once-per-ring opts (atlas/road textures, detail-normal
  // wiring, subdivision flags, water/lava bitmasks) BEFORE the
  // heightmap batch fetch so the per-LB baker can consume them straight
  // off `opts` without further async work.
  const opts = await resolveTerrainRingOpts(
    scene3d,
    wasmExports,
    centreLbX,
    centreLbY,
    null
  );

  // A1 (2026-06-20) — stash the resolved opts on the scene3d IMMEDIATELY,
  // not at the end of this function. If any later per-LB bake throws, the
  // tail-end `scene3d.terrainOpts = opts;` never runs, leaving terrainOpts
  // undefined → `bakeTerrainForLandblock` throws "opts missing" (~:2517) on
  // every lazy LB-entry and the stream guard cooldown-retries forever
  // (permanent barren terrain). Setting it here means even a partial ring
  // bake leaves the lazy path with a usable opts bag. (The tail assignment
  // remains below as a harmless idempotent duplicate.)
  scene3d.terrainOpts = opts;

  // 3. Batch-fetch heightmaps for the whole ring in a single call —
  // matches today's `fetch_landblock_heightmaps(ids)` shape.
  const ids = new Uint32Array(coords.map((c) => c.id >>> 0));
  const meshes = await wasmExports.fetch_landblock_heightmaps(ids);
  if (meshes.length !== coords.length) {
    throw new Error(
      `bakeTerrainRing: expected ${coords.length} meshes, got ${meshes.length}`
    );
  }

  // 4. Batch-fetch subdivided meshes. Cold-boot Phase D (2026-05-21) —
  // group LBs by subdivision level and issue ONE
  // `fetch_subdivided_landblocks(idsAtLevel, level)` call per group
  // instead of N separate per-LB calls. At radius=6 ultra the cascade
  // produces just two groups (centre+ring-1 at halfLevel; ring-2..6 at
  // level=1), so 169 separate wasm round-trips collapse to 2. Mirrors
  // the buildings-ring batching pattern.
  let subdivMeshes = null;
  if (opts.canSubdivide && typeof wasmExports.fetch_subdivided_landblocks === "function") {
    const levelByIndex = new Array(coords.length);
    const indicesByLevel = new Map();
    for (let i = 0; i < coords.length; i += 1) {
      const level = pickSubdivLevelForLb(opts, coords[i].x, coords[i].y);
      levelByIndex[i] = level;
      let bucket = indicesByLevel.get(level);
      if (!bucket) {
        bucket = [];
        indicesByLevel.set(level, bucket);
      }
      bucket.push(i);
    }
    const subdivByIndex = new Array(coords.length).fill(null);
    const groupPromises = [];
    for (const [level, indices] of indicesByLevel.entries()) {
      const ids = new Uint32Array(indices.map((i) => coords[i].id >>> 0));
      groupPromises.push(
        wasmExports
          .fetch_subdivided_landblocks(ids, level)
          .then((batch) => {
            for (let k = 0; k < indices.length; k += 1) {
              subdivByIndex[indices[k]] = { mesh: batch[k], level };
            }
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.warn(
              `[terrain] subdivide batch failed at level=${level} (${indices.length} LBs):`,
              err
            );
            // Leave subdivByIndex entries at null so the per-LB baker
            // falls back to the prefetched 9×9 mesh — same as the prior
            // per-call catch path's `return null` shape.
          })
      );
    }
    await Promise.all(groupPromises);
    subdivMeshes = subdivByIndex;
  } else if (opts.canSubdivide) {
    // Fallback path for older wasm bundles without the batch export.
    // Preserves the prior per-LB shape so a stale `pkg/` doesn't break
    // the ring driver.
    const promises = coords.map((c) => {
      const level = pickSubdivLevelForLb(opts, c.x, c.y);
      return wasmExports
        .fetch_subdivided_landblock(c.id, level)
        .then((m) => ({ mesh: m, level }))
        .catch((err) => {
          console.warn(
            `[terrain] subdivide failed for (${c.x},${c.y}) @ level=${level}:`,
            err
          );
          return null;
        });
    });
    subdivMeshes = await Promise.all(promises);
  }

  // 5. Fan out per-LB bakes. Each baker receives its prefetched
  // wasmMesh + subdivEntry via a shallow-copied `opts` so the once-
  // per-ring fields stay shared by reference and the per-LB prefetch
  // is the only per-call payload variation.
  //
  // B2 (2026-06-20) — `bakeTerrainForLandblock` is fully synchronous from
  // its mesh-build onward (~:2576 "sync from here on"), so the prior
  // `Promise.all` over all 169 radius-6 coords was one uninterrupted
  // main-thread burst (multi-second stall, black viewport, watchdog trip).
  // When `?terrainRingTimeSlice` is ON (default), bake the centre + ring-1
  // (the 9 nearest coords) FIRST so the player's immediate surroundings
  // appear, then bake the rest in small batches, yielding a REAL macrotask
  // (`setTimeout(0)`, NOT a microtask — a microtask wouldn't let the rAF
  // pump run) whenever ~6ms of wall-clock has elapsed. This keeps
  // pumpNetFrame's __lastPumpMs fresh so the load watchdog never trips.
  // `?terrainRingTimeSlice=off` restores the single Promise.all.
  const bakeOne = (c, i) => {
    const perLbOpts = {
      ...opts,
      prefetchedMesh: meshes[i],
      prefetchedSubdiv: subdivMeshes ? subdivMeshes[i] : null,
    };
    return bakeTerrainForLandblock(scene3d, c.x, c.y, perLbOpts, wasmExports);
  };
  let lbMeshes;
  if (readTerrainRingTimeSliceFlag()) {
    // Order the coords centre/ring-1 first, then the rest, so the nearest
    // terrain shows immediately while the far ring trickles in.
    const nearIdx = [];
    const farIdx = [];
    for (let i = 0; i < coords.length; i += 1) {
      const dx = coords[i].x - centreLbX;
      const dy = coords[i].y - centreLbY;
      if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1) nearIdx.push(i);
      else farIdx.push(i);
    }
    const order = nearIdx.concat(farIdx);
    lbMeshes = new Array(coords.length);
    let sliceStart = performance.now();
    for (let k = 0; k < order.length; k += 1) {
      const i = order[k];
      lbMeshes[i] = await bakeOne(coords[i], i);
      // Yield a real macrotask every ~6ms so the rAF pump keeps the
      // watchdog's __lastPumpMs fresh during the burst.
      if (performance.now() - sliceStart >= 6) {
        await new Promise((r) => setTimeout(r, 0));
        sliceStart = performance.now();
      }
    }
  } else {
    const bakePromises = coords.map((c, i) => bakeOne(c, i));
    lbMeshes = await Promise.all(bakePromises);
  }

  // Free the prefetched base wasm meshes the ring driver owns. The
  // per-LB baker skips freeing prefetched meshes specifically so this
  // loop is the single owner and avoids double-free.
  for (const wasmMesh of meshes) {
    if (wasmMesh && typeof wasmMesh.free === "function") {
      try {
        wasmMesh.free();
      } catch (_) {
        // Already-freed wasm structs throw; swallow because we own
        // single-free here and the alternative is leaking memory if a
        // future refactor stops returning fresh handles per call.
      }
    }
  }

  // Count roads after the bake so the summary stays in sync with the
  // prior `buildHoltburgTerrain` return shape. Roads are painted in the
  // terrain shader now (no separate overlay child); the per-mesh
  // `userData.hasRoads` flag was set during bake from roadCodes.
  let lbWithRoads = 0;
  for (const m of lbMeshes) {
    if (m?.userData?.hasRoads) lbWithRoads += 1;
  }

  // Stash on the scene3d for later phases (Phase 7.5 camera, Phase 7.7
  // cleanup, and the lazy LB-entry path that Objective 6 will wire).
  scene3d.terrainAtlasTexture = opts.atlasTexture;
  scene3d.terrainRoadTexture = opts.roadTexture;
  scene3d.terrainRoadCanvas = opts.roadCanvas;
  scene3d.terrainLbCount = coords.length;
  // Persist the resolved ring opts so the lazy LB-entry hook (Objective
  // 6) can call `bakeTerrainForLandblock` without redoing the canvas /
  // detail-normal / bitmask work. The lazy hook should rebuild only the
  // per-LB prefetch fields (`prefetchedMesh`, `prefetchedSubdiv`) before
  // calling the baker.
  scene3d.terrainOpts = opts;

  return {
    atlasTexture: opts.atlasTexture,
    roadTexture: opts.roadTexture,
    roadCanvas: opts.roadCanvas,
    lbCount: coords.length,
    lbWithRoads,
  };
}

/**
 * Build the Holtburg 9-LB terrain (heightfield meshes + bilinear-blend
 * shader + per-LB vertex-types texture + road overlays) and add it to
 * `scene3d.terrainGroup`.
 *
 * Returns a summary `{ atlasTexture, roadTexture, lbCount, roadCanvas }`
 * with the shared atlas / road textures stashed for later phases
 * (Phase 7.5 camera, Phase 7.7 cleanup) to reuse.
 *
 * world-expand step 1 (Objective 2): preserved as a thin radius=1
 * wrapper around `bakeTerrainRing`. Existing captures + smoke tests
 * call this directly and rely on the 9-LB Holtburg behaviour; the lazy
 * LB-entry / per-LB-baker symbol is the new `bakeTerrainForLandblock`.
 */
// buildHoltburgTerrain() retired (spawn-driven-boot): the Holtburg-centred
// back-compat wrapper is gone. Terrain streams per-LB via loadTerrainForLandblock;
// bakeTerrainRing remains exported for any explicit-centre caller (tests/captures).

// ---------------------------------------------------------------------
// Visual-vs-collision Z reconciliation was REMOVED 2026-06-26.
//
// The terrain mesh now sits *exactly* on the faceted collision surface:
// `terrain_subdiv::subdivide_landblock` builds every vertex Z from
// `triangle_height_in_cell` on the cell's retail split — the same surface
// `WorldState::terrain_height_at` binds the player to. With visual ==
// collision there is no gap to reconcile, so the old `getTerrainVisualZ`
// raycast (+ its 0.3 m lift / indoor-clamp dance) is gone. The rig and
// remote players render directly at their authoritative Z (see loop.js).
// ---------------------------------------------------------------------

// ── FCULL — OPT-IN per-LB terrain frustum + distance cull (2026-06-08) ─
//
// DEFAULT OFF (`?cullTerrain=on` to enable). Terrain LB meshes are plain
// THREE.Meshes with `frustumCulled` left at the default `true`, so the
// renderer ALREADY frustum-culls each LB per-mesh (using its lazily-
// computed geometry bounding sphere) — app-level terrain culling is
// redundant in the common case. We leave the COARSE gate to the wasm
// cell-visibility BFS (which keeps `terrainGroup.visible`) + three's auto
// per-mesh cull, exactly as the recon recommended.
//
// CAVEAT (why this is opt-in, not default): kept opt-in conservatively to
// avoid any behaviour change. The original reason no longer applies — it was
// that `getTerrainVisualZ` raycast the terrain group and THREE's raycaster
// skips `.visible === false` objects, so flipping an LB's `.visible` could
// change a raycast result — but that reconcile raycast was removed
// 2026-06-26. If a future audit confirms nothing else raycasts the terrain
// group, this pass could safely become default-on.
//
// The per-LB cull sphere is a CLOSED-FORM known-bounds sphere (no geometry
// walk): center at the LB's AC-space middle (lb*192 + 96, height midpoint),
// radius covering the 192×192 footprint half-diagonal plus the height span.
// Cached on `userData._cullSphere` (terrain never moves). AC-space, so it
// pairs directly with the AC-space FrustumCuller.

const _terrainCullSphereScratch = new THREE.Vector3();

function _resolveTerrainCullSphere(mesh) {
  const ud = mesh.userData;
  if (!ud) return null;
  if (ud._cullSphere) return ud._cullSphere;
  if (typeof ud.lbX !== "number" || typeof ud.lbY !== "number") return null;
  const halfLb = METERS_PER_LANDBLOCK * 0.5; // 96 m
  const cx = ud.lbX * METERS_PER_LANDBLOCK + halfLb;
  const cy = ud.lbY * METERS_PER_LANDBLOCK + halfLb;
  const hMin = Number.isFinite(ud.heightMin) ? ud.heightMin : 0;
  const hMax = Number.isFinite(ud.heightMax) ? ud.heightMax : 0;
  const cz = (hMin + hMax) * 0.5;
  // Half-diagonal of the 192×192 footprint plus half the height span.
  const halfHeight = Math.max(0, (hMax - hMin) * 0.5);
  const footprintRadius = Math.sqrt(halfLb * halfLb + halfLb * halfLb);
  const radius = Math.sqrt(
    footprintRadius * footprintRadius + halfHeight * halfHeight
  );
  _terrainCullSphereScratch.set(cx, cy, cz);
  const sphere = new THREE.Sphere(_terrainCullSphereScratch.clone(), radius);
  ud._cullSphere = sphere;
  return sphere;
}

/**
 * Per-frame OPT-IN terrain cull. Only invoked by loop.js when
 * `?cullTerrain=on`. `culler` is the shared AC-space FrustumCuller (already
 * `.update()`d this frame). Fail-soft: missing group / sphere → leave the
 * LB visible. Skips the paired wire-fill meshes (`userData.wireFillFor`),
 * which inherit visibility from their wire partner.
 */
export function cullTerrainGroup(scene3d, culler) {
  const group = scene3d?.terrainGroup;
  if (!group || !culler || !culler.valid) return { tested: 0, culled: 0 };
  const children = group.children;
  if (!children || children.length === 0) return { tested: 0, culled: 0 };
  let tested = 0;
  let culled = 0;
  for (const mesh of children) {
    if (!mesh || !mesh.userData) continue;
    // Wire-fill partner meshes have no lbX/lbY bounds of their own; they
    // share geometry with the wire mesh. three's auto per-mesh cull handles
    // them; skip here (they'd resolve a null sphere → fail-open anyway).
    if (mesh.userData.wireFillFor) continue;
    // ?terrainBatch — batched proxies are HIDDEN data-carriers (the cross-LB
    // BatchedMesh draws them, with its own per-instance frustum cull); the
    // visibility flips below would resurrect them into double-draws. The key
    // only exists when the flag is on, so flag-off this check is always false.
    if (mesh.userData.__terrainBatchGid != null) continue;
    const sphere = _resolveTerrainCullSphere(mesh);
    if (!sphere) {
      if (mesh.visible === false) mesh.visible = true;
      continue;
    }
    tested += 1;
    let want = culler.isSphereInFrustum(sphere);
    if (want && CULL_DIST_SQ !== Infinity) {
      const c = sphere.center;
      const distSq = culler.getDistanceSq(c.x, c.y, c.z);
      const r = sphere.radius;
      if (distSq > CULL_DIST_SQ + r * r + 2 * r * Math.sqrt(CULL_DIST_SQ)) {
        want = false;
      }
    }
    if (mesh.visible !== want) mesh.visible = want;
    if (!want) culled += 1;
  }
  return { tested, culled };
}
