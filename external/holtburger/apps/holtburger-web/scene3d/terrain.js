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
import {
  landblockMeshToGeometry,
  subdividedLandblockMeshToGeometry,
  buildVertexTypesDataTexture,
  buildTerrainAtlasArrayBytes,
  buildTerrainDetailArrayBytes,
  buildAlphaMaskArrayBytes,
  getAdapterMaxAnisotropy,
} from "./adapter.js";
import { applyWireVertexAOPatch, applyFillDepthBias } from "./materials.js";
// FCULL (2026-06-08) — distance horizon for the OPT-IN per-LB terrain cull
// (`?cullTerrain=on`). Default OFF: three.js already per-mesh frustum-culls
// terrain LB meshes correctly (plain Meshes with a lazily-computed geometry
// bounding sphere), so app-level terrain culling is redundant in the common
// case and exists only for A/B eye-test. Only the constant is imported.
import { CULL_DIST_SQ } from "./culling.js";

// ----- AC world-coord constants -------------------------------------
const METERS_PER_LANDBLOCK = 192.0;
const HOLTBURG_X = 0xa9;
const HOLTBURG_Y = 0xb4;

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
// Fallback LUTs when the detail-tex flag is off / fetch failed: every code
// maps to slice 255 (= "none", shader skips) and tiling 1. The int[33]
// uniforms must still be the right length even when disabled, or three.js
// warns on a length-mismatched uniform array bind.
const DETAIL_TEX_SLICE_FALLBACK = Object.freeze(new Array(33).fill(255));
const DETAIL_TEX_TILING_FALLBACK = Object.freeze(new Array(33).fill(1));

// T1 (2026-05-29) — base tex_tiling LUT fallback (default-on path). When the
// wasm `fetch_terrain_base_tex_tiling()` export is missing or the fetch fails,
// every code tiles 1× → atlasUvFor is an exact no-op → fail-soft to the prior
// (pre-T1) render. Real retail values (all 2) come from the wasm LUT.
const BASE_TEX_TILING_FALLBACK = Object.freeze(new Array(33).fill(1));

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
// Quality gate: only installed when `liveScene3d.quality.flags.subdivLevel
// >= 2`. At subdivLevel=1, terrain verts are 24 m apart — the wavelength
// would be larger than the screen and the wave would be invisible.
// F12-5 — `?strictWaterCodes=on` restricts the animated-water set to retail's
// SurfChar water codes (16-20). The default set ALSO includes 22
// (FauxWaterRunning) and 23 (SeaSlime), which retail's surface-characteristic
// table marks NOT water — so marsh/slime terrain currently bobs ±0.25 m,
// scrolls, and breathes blue like open sea. This single set feeds the
// uWaterCodeMask that now drives all three sites (vertex displacement, the
// per-corner UV scroll, and the blue tint), so the flag affects them
// uniformly. Default OFF → set unchanged → byte-identical render. The
// doc hedges on 22 ("render with scroll/tint only if eye-test agrees" — it
// is faux *running* water visually); the conservative strict set drops it
// per the SurfChar table, deferring the keep-22-scroll-only refinement (a
// second mask) to the 1070 eye-test.
function readStrictWaterCodesFlag() {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("strictWaterCodes") === "on";
  } catch (_) { return false; }
}
const TERRAIN_WATER_CODES = new Set(
  readStrictWaterCodesFlag() ? [16, 17, 18, 19, 20] : [16, 17, 18, 19, 20, 22, 23],
);
// Region 0x13 lava codes: none (see comment above). Future region-aware
// extension would populate this for, e.g., Volcanic Hills.
const TERRAIN_LAVA_CODES = new Set([]);

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

uniform float uTime;                  // Phase 2.2 — shared wall-clock seconds
uniform int uWaterCodeMask;           // Phase 2.2 — bitmask of water terrain codes (bit i = code i)
uniform int uLavaCodeMask;            // Phase 2.2 — bitmask of lava terrain codes (Region 0x13 = 0)
uniform float uDisplacementEnabled;   // Phase 2.2 — 0.0 OFF / 1.0 ON (quality gate; off when subdivLevel < 2)
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
// Phase 2.2 — 1.0 if the vertex is water, 0.0 otherwise. The fragment
// shader uses this to decide whether to apply UV scroll + tint shift.
// Flat-interpolated alongside vTerrainCode so the fragment sees the
// same provoking-vertex classification.
flat out int vIsWater;
// Perf D1 — vertex-side fold of the two water-modulation sines that
// the fragment shader used to evaluate per-pixel.
//   .x = sin(uTime * 0.3)                       -- water tint breath (constant per draw)
//   .y = sin(uTime * 0.5 + worldXy.x * 0.1)     -- one term of the displacement wave
// Per-vertex linear interpolation across a 24 m cell is visually
// indistinguishable from per-pixel evaluation at these slow
// frequencies (worldXy.x advances by 0.1 rad per 1 m, so a 24 m cell
// spans ~2.4 rad; the curve is still smooth enough that linear
// interpolation across the cell looks identical to a half-pixel eye).
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

void main() {
  vec3 displacedPos = position;
  int code = int(terrainCode + 0.5);
  int isWater = 0;
  // World-frame XY = per-LB origin + LB-local position. Hoisted out of
  // the displacement gate so Perf D1's vWaveModulation can read it
  // unconditionally below.
  vec2 worldXy = uLbOriginXy + position.xy;
  // Perf D1 — compute both sine modulations at vertex rate (once per
  // vertex instead of once per fragment). See varying declaration
  // above for the rationale on interpolation fidelity.
  float waveModX = sin(uTime * 0.3);
  float waveModY = sin(uTime * 0.5 + worldXy.x * 0.1);
  vWaveModulation = vec2(waveModX, waveModY);
  // Phase 2.2 — quality-gated time-varying displacement on water + lava
  // terrain. uDisplacementEnabled is 0.0 when subdivLevel < 2 (the
  // vertices are 24 m apart at level 1 and the wave wavelength would
  // exceed the screen). The bitmask lookups are 32-bit shifts; both
  // masks are constructed JS-side from the TERRAIN_WATER_CODES /
  // TERRAIN_LAVA_CODES sets so the GLSL stays free of per-code if/elif
  // chains.
  if (uDisplacementEnabled > 0.5 && code >= 0 && code < 32) {
    int bit = 1 << code;
    if ((uWaterCodeMask & bit) != 0) {
      // Two-wavelet sine sum at different frequencies + phases. Total
      // envelope ~0.25 m, well under the 0.4 m plan-doc cap. waveModY
      // reuses Perf D1's vertex-rate sine for the first wavelet so we
      // do not pay for the same evaluation twice on this vertex.
      float wave = waveModY * 0.15
                 + sin(uTime * 0.7 + worldXy.y * 0.13) * 0.10;
      displacedPos.z += wave;
      isWater = 1;
    } else if ((uLavaCodeMask & bit) != 0) {
      // Slow chunky 2D value-noise — 0.4 m max amplitude. Inactive for
      // Region 0x13 (no lava codes in the mask); kept here for forward
      // compat with region-aware extensions.
      float n = valueNoise2D(worldXy * 0.05 + vec2(uTime * 0.2, 0.0));
      displacedPos.z += n * 0.4;
    }
  }
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
uniform sampler2D uVertexTypes;       // 9×9 RGBA8: R = terrain code, G = roadCode*64, A = 255
uniform sampler2D uRoadTexture;       // retail road tile (RepeatWrap)
uniform float uRoadTileScale;         // road UV tile rate per LB unit
uniform float uRoadEnabled;           // 0 = no road overlay (back-compat / disable)

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
// Phase 2.2 — shared wall-clock seconds + water flag for UV scroll +
// tint modulation. uDisplacementEnabled gates both effects so they
// stay quiet at subdivLevel=1 (matches the vertex-shader gate).
uniform float uTime;
uniform float uDisplacementEnabled;
// F12-5 — same water-code bitmask the vertex shader uses for displacement
// (bit i = terrain code i is animated water). The per-corner UV-scroll test
// below reads it so the displacement / scroll / tint sites share ONE water
// set; ?strictWaterCodes=on shrinks that set to retail's 16-20.
uniform int uWaterCodeMask;

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
//   .y = sin(uTime * 0.5 + worldXy.x * 0.1) -- the displacement wave
//                           term that the vertex shader already needs;
//                           re-exported here so the tint path can read
//                           it without re-evaluating sin() per pixel.
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

// T1 — rotate an intra-cell UV ([0,1]²) by 90° steps around its centre, so a
// single authored alpha mask covers all four corner orientations (the retail
// LandDefs::Rotation the selection core resolves per overlay). The rotation
// SIGN is a convention to confirm by eye-test on the 1070; flip the 90°/270°
// branches if the masked overlays land on the wrong corner.
vec2 rotateCellUv(vec2 uv, int rot) {
  vec2 c = uv - 0.5;
  if (rot == 1) c = vec2(-c.y, c.x);        // 90°
  else if (rot == 2) c = vec2(-c.x, -c.y);  // 180°
  else if (rot == 3) c = vec2(c.y, -c.x);   // 270°
  return c + 0.5;
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
  // because the slot only sees the fractional part. Gated by both the
  // displacement quality flag AND the per-vertex water flag so
  // non-water cells (and low quality) keep their static UV.
  vec2 waterCellUv = cellUv;
  if (uDisplacementEnabled > 0.5 && vIsWater == 1) {
    waterCellUv = fract(cellUv + vec2(uTime * 0.05, uTime * 0.02));
  }

  int t00 = vertexTypeAt(iu,     iv    );  // SW
  int t10 = vertexTypeAt(iu + 1, iv    );  // SE
  int t01 = vertexTypeAt(iu,     iv + 1);  // NW
  int t11 = vertexTypeAt(iu + 1, iv + 1);  // NE

  // Per-corner cellUv: water-typed corners get the scrolled UV, others
  // stay on the static path. This keeps the blend across the water /
  // land seam continuous because non-water corners contribute their
  // unscrolled tile while the water corners drift.
  //
  // F12-5 — was a hardcoded "t >= 16 && t <= 23 && t != 21" range (=
  // {16-20,22,23}); now reads the shared uWaterCodeMask so this scroll
  // site, the displacement mask, and the tint all use ONE water set.
  // Byte-identical with the default mask; ?strictWaterCodes=on drops 22
  // (FauxWaterRunning) + 23 (SeaSlime) — which retail's SurfChar table marks
  // NOT water — so marsh/slime no longer scrolls like open sea.
  vec2 uv00 = (t00 >= 0 && t00 < 32 && (uWaterCodeMask & (1 << t00)) != 0) ? waterCellUv : cellUv;
  vec2 uv10 = (t10 >= 0 && t10 < 32 && (uWaterCodeMask & (1 << t10)) != 0) ? waterCellUv : cellUv;
  vec2 uv01 = (t01 >= 0 && t01 < 32 && (uWaterCodeMask & (1 << t01)) != 0) ? waterCellUv : cellUv;
  vec2 uv11 = (t11 >= 0 && t11 < 32 && (uWaterCodeMask & (1 << t11)) != 0) ? waterCellUv : cellUv;

  vec3 c00 = texture(uAtlas, atlasUvFor(clamp(t00, 0, 32), uv00)).rgb;
  vec3 c10 = texture(uAtlas, atlasUvFor(clamp(t10, 0, 32), uv10)).rgb;
  vec3 c01 = texture(uAtlas, atlasUvFor(clamp(t01, 0, 32), uv01)).rgb;
  vec3 c11 = texture(uAtlas, atlasUvFor(clamp(t11, 0, 32), uv11)).rgb;

  float w00 = (1.0 - fu) * (1.0 - fv);
  float w10 = fu * (1.0 - fv);
  float w01 = (1.0 - fu) * fv;
  float w11 = fu * fv;

  vec3 result = c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11;

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
    vec3 merged = texture(uAtlas, atlasUvFor(clamp(baseLayer, 0, 32), cellUv)).rgb;
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
    if (baseLayer != 32) {
      // T2 — slots 1..3 terrain overlays + 4..5 road overlays. Road slots
      // carry the same [atlas_layer(=32), alpha_mask_idx, rotation, valid]
      // packing as terrain overlays, so the existing rotate + alpha-mask +
      // mid-point-round pipeline handles them with no special-casing. (An
      // all-road cell short-circuits above with baseLayer==32 and no
      // overlays, so this loop only runs for terrain/partial-road cells.)
      for (int s = 1; s < 6; s++) {
        vec4 t = texelFetch(uMergeData, ivec2(colBase + s, iv), 0);
        if (t.a < 0.5) continue;            // empty slot
        int layer = int(t.r * 255.0 + 0.5);
        int maskIdx = int(t.g * 255.0 + 0.5);
        int rot = int(t.b * 255.0 + 0.5);
        vec2 mUv = rotateCellUv(cellUv, rot);
        // R4.a — retail mid-point alpha rounding (acclient.c:365787-365798),
        // gated under uTexMergeEnabled by uTexMergeAlphaRound. No-op (returns
        // the raw sampled weight) when the sub-flag is 0, so the shipped
        // composite is byte-identical with rounding off.
        float alpha = roundMergeAlpha(
          texture(uAlphaMasks, vec3(mUv, float(maskIdx))).r,
          uTexMergeAlphaRound
        );
        vec3 overlayCol = texture(uAtlas, atlasUvFor(clamp(layer, 0, 32), cellUv)).rgb;
        merged = mix(merged, overlayCol, alpha);
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
  // over time (period ~21 s at uTime * 0.3). Only applied on water-
  // flagged provoking vertices; non-water surfaces stay colour-stable.
  // Perf D1 — read the pre-computed sin(uTime * 0.3) from the varying
  // (constant across the cell since uTime is constant per draw call;
  // linear interpolation of a constant is exact).
  if (uDisplacementEnabled > 0.5 && vIsWater == 1) {
    vec3 tint = mix(vec3(0.9, 0.95, 1.05), vec3(1.0, 1.0, 1.0),
                    0.5 + 0.5 * vWaveModulation.x);
    result *= tint;
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
  if (uDetailTexEnabled > 0.5) {
    int dcode = clamp(vTerrainCode, 0, 32);
    int dslice = uCodeToDetailTexSlice[dcode];
    if (dslice >= 0 && dslice < uDetailTexSliceCount) {
      float tiling = float(uDetailTexTiling[dcode]);
      vec2 dUv = vGridUv * (tiling * uDetailTexBaseScale);
      vec3 detail = texture(uTerrainDetailTex, vec3(dUv, float(dslice))).rgb;
      float fade = 1.0 - smoothstep(uDetailTexFadeStart, uDetailTexFadeEnd, vViewDepth);
      float amt = clamp(uDetailTexStrength, 0.0, 1.0) * fade;
      vec3 mod2x = clamp(detail * 2.0, 0.0, 2.0);
      result *= mix(vec3(1.0), mod2x, amt);
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
  // T3 (2026-05-29): this is the LEGACY bilinear-approximation road painter.
  // When the TexMerge path (T2) is active it already composited the authored
  // road alpha masks (slots 4..5) into the result color, so running this too
  // would double-blend roads. Gate it OFF whenever uTexMergeEnabled is on, the
  // painter stays the road source for the default (non-?texMerge) path.
  if (uRoadEnabled > 0.5 && uTexMergeEnabled < 0.5) {
    float r00 = vertexRoadAt(iu,     iv    );
    float r10 = vertexRoadAt(iu + 1, iv    );
    float r01 = vertexRoadAt(iu,     iv + 1);
    float r11 = vertexRoadAt(iu + 1, iv + 1);
    float roadMask = r00 * w00 + r10 * w10 + r01 * w01 + r11 * w11;
    // smoothstep(0.85, 0.95) narrows the paint band to ~5 m, matching
    // retail's _road_width = 5.0 (acclient.c:467318). The raw bilinear
    // mask ramps 0..1 across a 24 m cell, so the previous > 0.001 gate
    // smeared the road across full cells (~10x too wide).
    float roadWeight = smoothstep(0.85, 0.95, roadMask);
    if (roadWeight > 0.0) {
      vec3 roadColor = texture(uRoadTexture, vGridUv * uRoadTileScale).rgb;
      result = mix(result, roadColor, roadWeight);
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
  if (uDetailNormalEnabled > 0.5) {
    int slice = uCodeToSlice[clamp(vTerrainCode, 0, 31)];
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
  if (slopeShading) {
    float slopeNdotL = mix(0.65, 1.0, clamp(dot(geomN, sunDir), 0.0, 1.0));
    ndotl = mix(ndotl, ndotl * slopeNdotL, 1.0);
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
      float density = texture(uCloudShadowMap, vec3(suv, 0.0)).r;
      // Beer-Lambert: transmittance = exp(-density * strength).
      // Clamp to 0.3 so shadowed terrain never goes pure black (sky
      // ambient still fills in even under thick cloud).
      cloudShadow = max(0.3, exp(-density * uCloudShadowStrength));
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
  fragColor = vec4(modulated * ndotl * cloudShadow * csmShadow, 1.0);
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
async function resolveTerrainRingOpts(
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
      waterCodeMask: 0,
      lavaCodeMask: 0,
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
  const canSubdivide =
    subdivLevel > 1 &&
    typeof wasmExports.fetch_subdivided_landblocks === "function";

  // Phase 2.2 — animated water/lava displacement. Only enabled at
  // subdivLevel >= 2 per plan hand-off note #3 (level=1 has 24 m vertex
  // spacing; the wave wavelength would be larger than the screen).
  // Materials still bind `uTime` / `uDisplacementEnabled` so the JS
  // tick can flip the gate later without rebuilding the shader.
  const displacementEnabled = subdivLevel >= 2;
  const waterCodeMask = computeCodeBitmask(TERRAIN_WATER_CODES);
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
  // the BASE_TEX_TILING_FALLBACK (all 1) binds → exact no-op (prior 1×).
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
  // render-audit Site-2 (2026-06-09) — detailFlag preset now wired. The
  // per-preset detailFlag (low:false, mid/high/ultra:true) from quality.js
  // is now consumed for terrain detail textures: detail is ON for the
  // mid/high/ultra presets and OFF for low, while still honouring an
  // explicit `?terrainDetailTex=off` opt-out (and the legacy `=on` force).
  // Effective enable = (preset.detailFlag || ?terrainDetailTex=on) AND NOT
  // ?terrainDetailTex=off. Pending eye-test.
  const detailTexFlag =
    (!!scene3d.quality?.flags?.detailFlag || readTerrainDetailTexFlag()) &&
    !readTerrainDetailTexOffFlag();
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
      tex.minFilter = THREE.LinearFilter; // no mips: a mask is sampled 1:1 per cell
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      texMergeState = { alphaArray: tex, count: built.depth };
      scene3d.texMergeAlphaState = texMergeState;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[terrain] fetch_terrain_alpha_masks failed:", e);
      texMergeState = null;
    }
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
    waterCodeMask,
    lavaCodeMask,
    atlasTexture,
    roadTexture,
    roadCanvas,
    // T1 (2026-05-29) — base tex_tiling LUT (length-33 number array; retail
    // all 2). Null when the fetch failed/export missing → the material binds
    // BASE_TEX_TILING_FALLBACK (all 1) → atlasUvFor no-op → fail-soft 1×.
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
    // T7 — terrain detail-diffuse array + per-code LUTs (opt-in
    // `?terrainDetailTex=on`). Null array + enabled:false when off/failed →
    // shader branch skipped. codeToSlice/codeTiling are length-33 number
    // arrays (255 = no detail); the material binds them as int[33] uniforms.
    detailTexArray: detailTexState?.array ?? null,
    detailTexCodeToSlice: detailTexState?.codeToSlice ?? null,
    detailTexCodeTiling: detailTexState?.codeTiling ?? null,
    detailTexSliceCount: detailTexState?.sliceCount ?? 0,
    detailTexEnabled: !!detailTexState,
    // T1 — TexMerge alpha-mask array + enable flag. Per-LB merge texture is
    // built in bakeTerrainForLandblock (it needs wasmMesh); this provides the
    // shared mask array + the gate. Disabled → bilinear path unchanged.
    texMergeAlphaArray: texMergeState?.alphaArray ?? null,
    texMergeEnabled: !!texMergeState,
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
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get(
      "terrainSlopeShading",
    );
    return typeof v === "string" && v.toLowerCase() === "on";
  } catch (_) {
    return false;
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
  // default-ON per render-audit T1a (2026-06-09): per-vertex bright/sat/hue
  // jitter (TerrainTex modulation); opt-out ?terrainMod=off, pending eye-test.
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("terrainMod");
    return !(typeof v === "string" && v.toLowerCase() === "off");
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
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("terrainPalette");
    return typeof v === "string" && v.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

/**
 * T7 (2026-05-28) — Parse `?terrainDetailTex=on`. Gates the near-camera
 * detail-diffuse modulation (`uDetailTexEnabled` + the wasm detail-texture
 * fetch). Default OFF — the detail layer is a visual refinement whose
 * tiling/strength/fade are eye-test-tuned, so it ships behind a flag like
 * T2 (`?perPolyCull`) did before defaulting on. Same try/catch shape as the
 * sibling flag readers for the Node test harness.
 */
function readTerrainDetailTexFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("terrainDetailTex");
    return typeof v === "string" && v.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

/**
 * render-audit Site-2 (2026-06-09) — explicit `?terrainDetailTex=off`
 * opt-out. Returns true ONLY for the literal value `"off"`
 * (case-insensitive); missing / any other value is false. Lets a user
 * force terrain detail textures off even on the mid/high/ultra presets
 * (whose `detailFlag` now defaults the feature on — see the gate in
 * resolveTerrainRingOpts). Same try/catch shape as the sibling readers.
 */
function readTerrainDetailTexOffFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("terrainDetailTex");
    return typeof v === "string" && v.toLowerCase() === "off";
  } catch (_) {
    return false;
  }
}

/**
 * T1 (2026-05-28) — Parse `?texMerge=on`. Gates the retail TexMerge
 * composite (`uTexMergeEnabled` + the per-LB merge texture + the alpha-mask
 * array fetch). Default OFF — the mask-driven biome boundaries replace the
 * bilinear cross-dissolve and the rotation/orientation conventions are
 * eye-test-tuned, so it ships behind a flag. Same try/catch shape as the
 * sibling flag readers for the Node harness.
 */
function readTexMergeFlag() {
  // default-ON per render-audit T1a (2026-06-09): patchy biome alpha-splat
  // composite; opt-out ?texMerge=off, pending 1070 eye-test.
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("texMerge");
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
// Opt-in via `?lodRebake=on` (default OFF → byte-identical: no reconcile, no
// re-bake). The doc pairs this with the F12-1 edge weld (deferred, 1070) so the
// MOVING LOD boundary stays crack-free; until that lands the flag-on path can
// show a seam at the boundary — hence default-off + eye-test-pending.
const LOD_REBAKE_ON = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("lodRebake") === "on";
  } catch (_) { return false; }
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
  let wasmMesh = opts.prefetchedMesh ?? null;
  if (!wasmMesh) {
    const meshes = await wasmExports.fetch_landblock_heightmaps(
      new Uint32Array([cellId])
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
      const mesh = await wasmExports.fetch_subdivided_landblock(cellId, level);
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
      uDetailTexBaseScale: { value: DEFAULT_DETAIL_TEX_BASE_SCALE },
      uDetailTexStrength: { value: DEFAULT_DETAIL_TEX_STRENGTH },
      uDetailTexFadeStart: { value: DEFAULT_DETAIL_TEX_FADE_START },
      uDetailTexFadeEnd: { value: DEFAULT_DETAIL_TEX_FADE_END },
      uDetailTexEnabled: { value: opts.detailTexEnabled ? 1.0 : 0.0 },
      // T1 — TexMerge composite. uMergeData is per-LB (built just above);
      // uAlphaMasks is the shared ordered mask array from opts. Enabled only
      // when BOTH the flag built a mask array AND this LB got a merge texture
      // — otherwise the bilinear path runs (uTexMergeEnabled = 0).
      uMergeData: { value: mergeDataTex },
      uAlphaMasks: { value: opts.texMergeAlphaArray ?? null },
      uTexMergeEnabled: {
        value: opts.texMergeEnabled && mergeDataTex ? 1.0 : 0.0,
      },
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
      uTime: { value: 0.0 },
      uWaterCodeMask: { value: opts.waterCodeMask },
      uLavaCodeMask: { value: opts.lavaCodeMask },
      uDisplacementEnabled: {
        value: opts.displacementEnabled ? 1.0 : 0.0,
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
    lavaCodeMask: opts.lavaCodeMask,
  };

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
  const bakePromises = coords.map((c, i) => {
    const perLbOpts = {
      ...opts,
      prefetchedMesh: meshes[i],
      prefetchedSubdiv: subdivMeshes ? subdivMeshes[i] : null,
    };
    return bakeTerrainForLandblock(scene3d, c.x, c.y, perLbOpts, wasmExports);
  });
  const lbMeshes = await Promise.all(bakePromises);

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
export async function buildHoltburgTerrain(scene3d, wasmExports) {
  return bakeTerrainRing(scene3d, HOLTBURG_X, HOLTBURG_Y, 1, wasmExports);
}

// ---------------------------------------------------------------------
// Visual-vs-collision Z reconciliation.
//
// Phase 2.1 subdivision interpolates 9×9 control heights with a bicubic
// Catmull-Rom basis. The resulting visual surface deviates from the
// 24 m bilinear collision surface by up to ±VISUAL_VS_COLLISION_MAX_M
// (= 0.3 m, clamped server-side at terrain_subdiv.rs). Physics
// (`WorldState::terrain_height_at`) queries bilinear; the rendered mesh
// is Catmull-Rom. So a player at the bilinear standing-Z appears to
// sink up to 0.3 m into a Catmull-Rom peak, or float over a Catmull-Rom
// valley dip.
//
// `getTerrainVisualZ` casts a vertical ray against the rendered terrain
// group and returns the visible surface Z at (x, y). Callers (loop.js's
// player pose appliers) substitute this for the bilinear Z when
// positioning the rendered avatar, while leaving the server-
// authoritative collision pose unchanged.
//
// Cost: one raycast per call. THREE's bounding-sphere broad-phase skips
// every LB whose mesh doesn't intersect the vertical ray (only the
// 1–2 LBs directly under the query XY get triangle-tested), so per-
// frame cost is ~one LB's worth of triangle tests — sub-millisecond
// at subdivLevel=8 (≈8K tris/LB).
// ---------------------------------------------------------------------

const _terrainVisualRaycaster = new THREE.Raycaster();
const _terrainVisualRayOrigin = new THREE.Vector3();
const _terrainVisualRayDir = new THREE.Vector3(0, -1, 0);
const _terrainVisualIntersects = [];

export function getTerrainVisualZ(scene3d, x, y, fallbackZ, maxDeltaM = Infinity) {
  const group = scene3d?.terrainGroup;
  if (!group || !group.children || group.children.length === 0) {
    return fallbackZ;
  }
  // Raycaster works in three.js WORLD space, but the terrain mesh sits
  // under worldRoot's -π/2 X rotation (AC z-up → three y-up). So we
  // transform the AC query into the world frame: acToThree(x, y, 1000) =
  // (x, 1000, -y), cast straight down (three -Y), and read the hit back
  // as AC z = point.y (the exact closed-form inverse). Cast from well
  // above any plausible terrain height (Holtburg ~96 m peak; AC overall
  // ~200 m max) so the ray origin is always above the surface.
  _terrainVisualRayOrigin.set(x, 1000, -y);
  _terrainVisualRaycaster.set(_terrainVisualRayOrigin, _terrainVisualRayDir);
  _terrainVisualRaycaster.far = 2000;
  _terrainVisualIntersects.length = 0;
  _terrainVisualRaycaster.intersectObject(
    group,
    true,
    _terrainVisualIntersects
  );
  if (_terrainVisualIntersects.length === 0) return fallbackZ;
  const z = _terrainVisualIntersects[0].point.y;
  _terrainVisualIntersects.length = 0;
  if (!Number.isFinite(z)) return fallbackZ;
  // F4-3 (bughunt 2026-06-09) — max-delta safety clamp. This raycast is an
  // OUTDOOR-ONLY cosmetic reconcile (lift the rig ≤0.3 m from the bilinear
  // collision surface onto the Catmull-Rom render surface). The vertical ray
  // is fired from y=1000 and three's raycaster ignores `.visible` (and the
  // PView fix force-shows terrain indoors), so an INDOOR pose's ray hits the
  // OUTDOOR land surface dozens of metres away — pre-fix that buried every
  // dungeon mob / upstairs character at the terrain surface. A hit further
  // than `maxDeltaM` from the caller's authoritative Z is therefore never the
  // surface this object is standing on: reject it and keep `fallbackZ`. With
  // the default `Infinity` this is a no-op (old behaviour); the pose-appliers
  // pass the documented 0.3 m bound + margin.
  if (Math.abs(z - fallbackZ) > maxDeltaM) return fallbackZ;
  return z;
}

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
// CAVEAT (why this is opt-in, not default): `getTerrainVisualZ` raycasts
// the terrain group for nameplate Y-projection, and THREE's raycaster skips
// `.visible === false` objects. Flipping an LB's `.visible` here would make
// a nameplate that projects onto a culled (off-screen / far) LB fall back to
// `fallbackZ`. That is benign (the LB is off-screen by definition) but it is
// a behaviour change, so the pass is opt-in and the default path never
// touches terrain `.visible`.
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
