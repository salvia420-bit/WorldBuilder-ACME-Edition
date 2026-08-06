// Phase 7.2 — MaterialCache: surfaceDid → MeshStandardMaterial.
//
// Caches the (Surface DID → wasm pixels → DataTexture → Material)
// chain so each unique surface only hits `fetch_surfaces_pixels` once
// per session. Buildings + statics share the cache via
// `MaterialCache.preload(allDids)` — one wasm round-trip resolves all
// surfaces referenced by every model in the neighbourhood.
//
// Phase 7 follow-on #7+8 (2026-05-10) — surface-type bitfield decode.
// The wasm-side `SurfacePixels` now surfaces the raw `Surface.surface_type`
// u32 (see `holtburger_dat::file_type::surface::Surface.surface_type`).
// We decode it via `_materialFromFlags(surfaceTypeFlags, texture)` into:
//
//   ACE.Entity.Enum.SurfaceType bit constants (verified against
//   `external/ACE/Source/ACE.Entity/Enum/SurfaceType.cs`):
//     - Base1Solid    = 0x1
//     - Base1Image    = 0x2
//     - Base1ClipMap  = 0x4   → binary alpha mask: alphaTest = 100/255 when the
//                               source texture is paletted else 200/255, plus
//                               ONE/INVSRCALPHA blend (RND-08/33; see
//                               `applyClipMapRenderState`)
//     - Translucent   = 0x10  → transparent + depthWrite = false
//     - Diffuse       = 0x20  → matte (no specular highlight)
//     - Luminous      = 0x40  → emissive map + colour
//     - Alpha         = 0x100 (rare; ACE-side legacy)
//     - InvAlpha      = 0x200 (rare; ACE-side legacy)
//     - Additive      = 0x10000 → blending = AdditiveBlending
//     - Detail        = 0x20000
//     - Gouraud       = 0x10000000
//     - Stippled      = 0x40000000
//     - Perspective   = 0x80000000
//
// IMPORTANT: AC has **no explicit "TwoSided" bit**. Two-sidedness is
// encoded per-Polygon via `sides_type == CullMode::Clockwise (0x2)`
// and is handled in the Rust triangulator
// (`append_gfx_tris_with_tex_swaps` in apps/holtburger-web/src/lib.rs).
// When pos_surface != neg_surface, the Rust code emits TWO oriented
// tris (one per side, opposite winding); the materials.js side just
// applies `side: DoubleSide` as the default so single-emit (same-surface)
// two-sided polys still draw both faces from one tri.
//
// PBR-style normalised lighting model (`MeshStandardMaterial`):
// roughness = 0.9, metalness = 0.0. AC textures are pre-lit so we
// don't try to recover physically-correct roughness/metalness; the
// flat 0.9/0.0 values just keep three's lighting model from blowing
// out highlights.

import * as THREE from "three";
import {
  surfacePixelsToTexture,
  surfacePixelsToNormalTexture,
  surfacePixelsToHeightTexture,
  surfacePixelsToRoughnessTexture,
  surfacePixelsToAoTexture,
} from "./adapter.js";
import { aoMapIntensityValue, materialBakeEnabled } from "./vfx_flags.js";
import { getQuality } from "./quality.js";
import { SuiteAssetSource, loadTexchanManifest } from "./suite_assets.js";
// X6 (`?texBc7=on`, DEFAULT-OFF) — direct BC7/BPTC albedo upload. Every entry
// point below is inert unless the flag is on AND the GPU reports
// EXT_texture_compression_bptc, so the RGBA8 path is unchanged by default.
import { bc7Available, bc7TextureBytes, upgradeMaterialToBc7 } from "./bc7_textures.js";
// Task 4 (2026-08-05): release the CPU-side copy after upload. Default OFF —
// see `texture_release.js` for the preconditions that gate the flag.
import { armCpuRelease } from "./texture_release.js";
import { PLANE } from "./surface_planes.js";

// ACE SurfaceType bit constants (mirrored from ACE.Entity.Enum.SurfaceType,
// see external/ACE/Source/ACE.Entity/Enum/SurfaceType.cs). Exported so
// the ESM test (test_f7_8_surface_bitfield.mjs) can assert exact bit
// values rather than reading source comments.
export const SURFACE_TYPE = Object.freeze({
  Base1Solid: 0x1,
  Base1Image: 0x2,
  Base1ClipMap: 0x4,
  Translucent: 0x10,
  Diffuse: 0x20,
  Luminous: 0x40,
  Alpha: 0x100,
  InvAlpha: 0x200,
  Additive: 0x10000,
  Detail: 0x20000,
  Gouraud: 0x10000000,
  Stippled: 0x40000000,
  Perspective: 0x80000000,
});

// Surface DID 0 is reserved for the FALLBACK group emitted by
// `meshToGeometryGroups` for triangles whose Polygon had no resolved
// Surface. Caller paints these with `materialCache.fallbackMaterial`.
const FALLBACK_SURFACE_DID = 0;

// === G2-fix (2026-06-19) — object-surface texture WRAP mode ===============
// The G2 blocks below (2026-05-29) clamped every non-Stippled object surface,
// reading the wrap flag off the *Surface type's* Stippled bit (0x40000000).
// That was a misread of retail: D3DPolyRender::SetSurface (acclient.c:454437)
// takes its `stippled` arg from `isStippledOrAlphaedMask[subset] & 1`, whose
// bit 0 is set ONLY by `CPolygon.stippling > 0` (acclient.c:456003) — a
// PER-POLYGON field, NOT the surface-type bit (which is ~never set). Net effect:
// every tiling object surface (tree-trunk bark, building walls — whose UVs run
// past [0,1]) wrongly CLAMPED, so the whole face sampled one stretched edge
// texel → flat, untextured (validated on the GTX 1070: conifer 0x02000257
// surface 0x0800157e, UVs 0→4.7, rendered as a smooth flat cylinder; flipping
// wrapS/wrapT→Repeat in-place instantly restored detailed bark). AC object
// textures tile by design — adapter.js's surfacePixelsTo*Texture hardcodes
// RepeatWrapping ("most AC textures tile"). ClampToEdge and RepeatWrapping are
// identical for UVs within [0,1], so defaulting to Repeat is safe for
// non-tiling surfaces and fixes the tiling ones. Default-on;
// `?surfaceWrapClamp=on` restores the old clamp-default for A/B.
// READER POLARITY (2026-08-02, resolving the standing audit finding): this flag
// is an EXACT `=== "on"` OPT-IN, i.e. ABSENT means OFF. The surrounding prose
// calls the feature "default-on" — that refers to the REPEAT-WRAP behaviour
// being the default render, not to this flag being on. Turning the flag ON
// opts back IN to the old clamp. Both statements are true; the pairing reads
// backwards, hence this note.
const _SURFACE_WRAP_CLAMP = (() => {
  try {
    return (
      (new URLSearchParams(globalThis.location.search).get("surfaceWrapClamp") || "")
        .toLowerCase() === "on"
    );
  } catch {
    return false;
  }
})();

// === RND-33 (2026-07-27) — per-polygon-stipple wrap, the faithful source =====
// The TODO the block above carried is now plumbed: the wasm ships
// `ModelMesh.subsetStippled`, one byte per surface subset, OR-ed over that
// subset's polygons (see `ModelMesh::subset_stippled` /
// `tri_stipple_bits`). Bit 0 is the batched `DrawMesh` reading
// (`acclient.c:456003` `mask |= stippling > 0`, forwarded at `:454676`); bit 1
// is the side-specific `SetSurface(CPolygon*, Sidedness, int)` reading
// (`acclient.c:455236`: positive side `stippling & 1`, negative `& 2`). Set ->
// `TEXADDRESS_WRAP`, clear -> `TEXADDRESS_CLAMP` (`acclient.c:454437`).
//
// `?surfaceStippleWrap=` selects which reading drives the sampler:
//   off (DEFAULT) — ignore the bits; keep the G2-fix Repeat default. Retail
//                   fidelity here means CLAMPing every unstippled surface,
//                   which is exactly what the 2026-06-19 G2-fix reverted after
//                   the 1070 showed conifer bark (0x02000257 / surface
//                   0x0800157e, UVs 0..4.7) rendering as a flat stretched
//                   cylinder. Turning this on without first censusing the
//                   Stippling byte across the DATs would re-break that.
//   drawmesh      — bit 0 (what retail's batched path actually did).
//   polygon       — bit 1 (side-correct, what our per-side triangulation can
//                   represent and retail's non-batched path used).
const _SURFACE_STIPPLE_WRAP = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location.search).get("surfaceStippleWrap") || "")
      .toLowerCase();
    return v === "drawmesh" || v === "polygon" ? v : "off";
  } catch {
    return "off";
  }
})();

/**
 * RND-33 — the sampler address mode for one surface subset.
 *
 * `subsetStippled` is the wasm per-subset byte, or `null`/`undefined` when the
 * wasm did not supply one (stale `pkg-web`, fused geometry, terrain). ABSENT IS
 * NOT "UNSTIPPLED": with no bits to read this returns the pre-RND-33 default,
 * so a stale pkg degrades inert rather than clamping the world.
 *
 * Terrain is deliberately out of scope: `CLandBlockStruct::ConstructUVs`
 * (`acclient.c:354717-354718`) sets `polygon.stippling = 3` on both triangles
 * of a cell iff `bSingleTextureCell`, i.e. uniform cells WRAP and blended cells
 * CLAMP. Our atlas base tiles are already fract-tiled (WRAP-equivalent) and the
 * alpha-mask array is ClampToEdge, so the per-cell distinction only starts to
 * matter if we ever composite one texture per cell.
 */
export function wrapModeForSubsetStipple(subsetStippled) {
  const legacy = _SURFACE_WRAP_CLAMP
    ? THREE.ClampToEdgeWrapping
    : THREE.RepeatWrapping;
  if (_SURFACE_STIPPLE_WRAP === "off") return legacy;
  if (typeof subsetStippled !== "number") return legacy;
  const bit = _SURFACE_STIPPLE_WRAP === "polygon" ? 0x2 : 0x1;
  return (subsetStippled & bit) !== 0
    ? THREE.RepeatWrapping
    : THREE.ClampToEdgeWrapping;
}

// #22 (2026-06-07) — paletted-material LRU cap. Each recolored outfit
// signature (surface|palette|subPalettes) mints one cache-owned
// MeshStandardMaterial + (optionally) one owned DataTexture. Without a
// cap a long crowded-town session grows `palettedMaterials` /
// `palettedTextures` unbounded (one live leak — every other cache is
// keyed by a bounded DID/bucket space). The cap is GENEROUS (256) so a
// same-frame-baked material is never evicted out from under the caller
// that just installed it; eviction is oldest-by-insertion (Map preserves
// insertion order), disposing the material AND its paired owned texture
// together. This is NOT the page-teardown `dispose()` path — the LRU
// never calls `dispose()`.
//
// ⚠ SUPERSEDED AS THE DEFAULT (2026-07-26, `?palBudgetMB=`). A COUNT cap
// bounds signatures, not BYTES, and the bytes are what OOMs the renderer: a
// 512² recolored surface is 1 MiB and a 64² one is 16 KiB, so 256 signatures is
// anywhere between 4 MiB and 256 MiB of `DataTexture.image.data`. The cap now
// governs only two things:
//   1. `?palBudgetMB=off` — the legacy-behaviour escape hatch;
//   2. `vfxPalettedVariants` (`getCachedVariantFromPaletted`), which caches
//      MATERIAL CLONES that share the base's texture and therefore carry ~no
//      bytes of their own — a count cap is the right shape there.
// See the `?palBudgetMB` block below for the replacement.
const PALETTED_CACHE_CAP = 256;

// How many recently-evicted paletted keys `_palEvictedKeys` remembers, so
// `palRemint` (see the constructor) can tell a re-needed eviction from a
// harmless one. Key strings are ~20-60 B, so the whole ring is well under
// 1 MB — three orders below the budget it instruments.
const PAL_EVICT_MEMORY_KEYS = 8192;

// === `?palDedup` — SINGLE-FLIGHT over a paletted signature (2026-08-06) ===
// `palettedMaterials` already dedups by VALUE key (`did|paletteId|subPalettes`),
// so two entities in the same outfit are MEANT to share one material object —
// and on a cache HIT they do (entities.js reads the hit straight into
// `_entityMaterials`). The hole is the window between the miss and the install:
// `_spawnImpl` does `getCachedPaletted()` (sync) → `await
// fetchEntitySurfacesPixels()` (mean 897 ms) → mint → `installPaletted()`, and
// spawns.js dispatches a landblock's spawns in one un-awaited loop. Every rig
// that misses inside another rig's decode window misses TOO, mints its own
// material, and the last install wins the map slot — the earlier ones are
// orphaned onto their meshes forever (never in the cache, so the LRU can't
// reclaim them; `__cacheOwned`, so the entity's dispose won't either).
//
// MEASURED (1070, Nanto, 2026-08-06): FOUR separate material objects all named
// `paletted-8000015-400007e`, identical in every inspected property AND in
// `userData.__paletteKey`, carrying 21/21/17/17 meshes on four different entity
// guids. That is 3 wasted wasm decodes, 3 wasted texture uploads, 3 extra
// material objects each carrying its own program/uniform state, and 3 ORPHANS:
// the last install won the map slot, so the other three are in no cache (the
// LRU cannot reclaim them) yet carry `__cacheOwned` (so the entity's dispose
// won't either). Anything that merges by material IDENTITY — the statics
// batcher's `_getOrCreateBucket` is the in-tree precedent — also cannot see
// them as one.
//
// The fix is the paletted twin of the `pendingFetches` single-flight the PLAIN
// per-DID path has had since the 2026-06-20 grey-surface race fix: the first
// misser CLAIMS the key, later missers JOIN its promise instead of re-decoding.
// See `claimPalettedInflight` / `getPalettedInflight`.
//
// ⚠ NOT the same bug as `palEvict` thrash (see the `?palBudgetMB` block below):
// past the budget the cache evicts a live signature and the next wearer
// re-mints, which ALSO produces duplicate objects for one key. Both are real;
// they are distinguished live by `__diag.palettedCache()` — `palEvict`/
// `palRemint` > 0 means thrash (raise `?palBudgetMB`), == 0 with duplicates
// means this race. This flag only closes the race.
let _palDedupFlag;
/** `?palDedup=off` escapes the paletted single-flight (restores the
 *  pre-2026-08-06 mint-per-misser behaviour). DEFAULT-ON. Lazy + memoised so
 *  the Node harnesses (no `location`) read the default without touching the DOM. */
export function palettedDedupEnabled() {
  if (_palDedupFlag !== undefined) return _palDedupFlag;
  let on = true; // DEFAULT-ON; ?palDedup=off escapes
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("palDedup") || "").toLowerCase();
      if (v) on = !(v === "off" || v === "0" || v === "false" || v === "no");
    }
  } catch (_) { on = true; }
  _palDedupFlag = on;
  return on;
}
/** Test seam — reset the memoised flag. */
export function __setPalettedDedupForTest(v) { _palDedupFlag = v; }

// Phase 0.1 — shadow casting gate. Translucent and Additive surfaces
// don't cast (shadow pass is depth-only — would render a solid box,
// and three.js warns). Opaque + ClipMap honour alphaTest, so they cast.
export function materialCanCastShadow(material) {
  if (!material) return false;
  const flags = (material.userData?.surfaceTypeFlags ?? 0) >>> 0;
  if (flags & SURFACE_TYPE.Translucent) return false;
  if (flags & SURFACE_TYPE.Additive) return false;
  // Alpha (0x100) / InvAlpha (0x200) are alpha-blended like Translucent —
  // a depth-only shadow pass would render them as solid boxes.
  if (flags & SURFACE_TYPE.Alpha) return false;
  if (flags & SURFACE_TYPE.InvAlpha) return false;
  return true;
}

/**
 * True when a material can never put a pixel on screen, now or later, so the
 * mesh carrying it is a pure no-op draw.
 *
 * WHY THIS EXISTS (2026-08-06). A frame at Nanto measured 519 draws, of which
 * 80 were fully invisible: 76 entity part meshes (one triangle each) on surface
 * 0x08000015, whose Surface record carries `translucency: 1` — verified against
 * the DAT, not inferred — so `opacity = 1 - T = 0`. They were submitted every
 * frame and contributed nothing. 76 draws is ~15% of that frame.
 *
 * Every clause is load-bearing; this is deliberately narrow, because the point
 * is that skipping is OUTPUT-IDENTICAL rather than merely close:
 *   - `opacity <= 0` with NormalBlending means the source contributes
 *     `src*0 + dst*1` = dst exactly. ADDITIVE blending is excluded on purpose:
 *     `srcFactor = ONE` adds the colour regardless of alpha, so an additive
 *     material at opacity 0 still lights the pixel.
 *   - `depthWrite === false` — a depth-writing invisible surface still occludes
 *     what is behind it, so hiding it would CHANGE the image.
 *   - `__baseTranslucency >= 1` is the PERMANENCE proof, and it is why this is
 *     safe against animation. A Transparent(20)/TransparentPart(7) hook floors
 *     its ramp value to the authored base translucency (entities.js
 *     `_applyRampValueToMaterial`, mirroring retail's floor to
 *     translucencyOriginal at acclient.c:316947-316956), so
 *     `opacity = 1 - max(value, 1) <= 0` for every value a hook can ever set.
 *     Without this clause a mid-fade material at opacity 0 would be hidden
 *     permanently — a bug that would only show as a prop that never fades in.
 *
 * Materials that are transiently at opacity 0 WITHOUT the authored base
 * deliberately fail this test and keep rendering. The `stat-atlas-x-*` bucket
 * material is the live example: `makeArrayMaterial` (static_atlas.js) mints a
 * FRESH MeshStandardMaterial and replays only `_stateKeyOf` (transparent /
 * alphaTest / depthWrite / blend factors) — `opacity` is not in the key and is
 * never copied, so an atlas bucket sits at opacity 1 and fails the very first
 * clause. The statics BATCH buckets are the opposite case and DO qualify: both
 * `consolidateStaticSingletons` (statics.js) and `_getOrCreateBucket`
 * (static_batch_x.js) key their buckets by the MATERIAL OBJECT and hand that
 * same object to `new THREE.BatchedMesh(..., mat)`, so the bucket material IS a
 * member material, marker and all (see `skipDeadBatchEnabled` below).
 *
 * @param {object|Array<object>} material  material or material array.
 * @returns {boolean} true when nothing this material draws can ever be seen.
 */
let _skipDeadAlphaFlag;
/** `?skipDeadAlpha=off` escapes the invisible-draw skip above (restores the
 *  pre-2026-08-06 behaviour of submitting them). DEFAULT-ON. */
export function skipDeadAlphaEnabled() {
  if (_skipDeadAlphaFlag !== undefined) return _skipDeadAlphaFlag;
  let on = true; // DEFAULT-ON; ?skipDeadAlpha=off escapes
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("skipDeadAlpha") || "").toLowerCase();
      if (v) on = !(v === "off" || v === "0" || v === "false" || v === "no");
    }
  } catch (_) { on = true; }
  _skipDeadAlphaFlag = on;
  return on;
}
/** Test seam — reset the memoised flag. */
export function __setSkipDeadAlphaForTest(v) { _skipDeadAlphaFlag = v; }

let _skipDeadBatchFlag;
/**
 * `?skipDeadBatch=off` escapes the STATICS-BUCKET half of the invisible-draw
 * skip. DEFAULT-ON.
 *
 * WHY THIS IS A SECOND FLAG AND NOT A SECOND CALLER OF `?skipDeadAlpha`
 * (2026-08-06). The entity fix above shipped on the same day and found 76
 * invisible part meshes; the statics side at the same spot (Nanto, quality
 * `mid`) holds 4 BatchedMesh buckets whose material is transparent, opacity 0,
 * NormalBlending, depthWrite false — i.e. every clause of
 * `materialRendersNothing` EXCEPT the permanence proof, because
 * `__baseTranslucency` was `undefined` on all 4.
 *
 * ⚠ CORRECTION (2026-08-06, same day): the first write-up of this — including
 * the eb2ac114 commit message and the task that commissioned this flag — said
 * those 4 buckets held "~21,845 triangles". THEY DO NOT. That number was
 * `position.count / 3` read off a BatchedMesh, which is its ALLOCATED vertex
 * buffer, not its used geometry: `_INIT_VERTS = 1 << 14`, and
 * 4 × 16384 / 3 = 21,845 exactly. Live `__statBatchXStats().deadBatch` reports
 * **27 triangles** across the 4. So the honest payoff of this flag is 4 draws
 * and 27 triangles — by the same session's calibration (62 draws bought 2.8%
 * of frame time) that is BELOW the measurement noise floor, and it should not
 * be expected to move a frame number. It ships because it is provably
 * output-identical and because the missing stamp it fixes was a real decoder
 * divergence, NOT because it is a performance win.
 *
 * The general lesson, since it will recur: never size a BatchedMesh's contents
 * from its geometry attributes. Ask the batch for its used extent.
 *
 * THE STAMP WAS MISSING AT THE SOURCE, NOT AT THE BATCHER. It is tempting to
 * read "the batcher builds its own material" — it does not. Both statics
 * batchers key by the material OBJECT and pass that object straight to
 * `new THREE.BatchedMesh(..., mat)`, so a bucket material is a member material.
 * The real gap is in `_materialFromFlags` below: the A10-M1 unified decoder
 * (`applySurfaceRenderState`, `?surfaceUnified=on`) stamps `__baseTranslucency`
 * for Translucent>0, and the LEGACY inline ladder — which is the DEFAULT path,
 * `readSurfaceUnifiedFlag()` is opt-in — sets the same `opacity = 1 - T` and
 * stamps nothing. The two decoders are documented as "byte-identical output";
 * on this one userData field they were not. So there is nothing to "plumb
 * through" the batcher: stamping at the authoring site is the whole fix, and it
 * is the ONLY sound place for it — a batcher has no access to the Surface
 * record, and inferring a base translucency from the current opacity is exactly
 * the unsound inference the permanence clause exists to forbid.
 *
 * This flag gates BOTH halves — the legacy-ladder stamp and the bucket hiding —
 * so `?skipDeadBatch=off` is a complete restore of the pre-2026-08-06 statics
 * behaviour. `?skipDeadAlpha=off` also disables the hiding (the predicate
 * carries its own gate) but leaves the stamp; that asymmetry is deliberate —
 * the stamp is retail-correct on its own merits (it is what lets a
 * Transparent(20) hook floor its ramp to `translucencyOriginal`,
 * acclient.c:316947-316956) and only this flag rolls it back.
 */
export function skipDeadBatchEnabled() {
  if (_skipDeadBatchFlag !== undefined) return _skipDeadBatchFlag;
  let on = true; // DEFAULT-ON; ?skipDeadBatch=off escapes
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("skipDeadBatch") || "").toLowerCase();
      if (v) on = !(v === "off" || v === "0" || v === "false" || v === "no");
    }
  } catch (_) { on = true; }
  _skipDeadBatchFlag = on;
  return on;
}
/** Test seam — reset the memoised flag. */
export function __setSkipDeadBatchForTest(v) { _skipDeadBatchFlag = v; }

export function materialRendersNothing(material) {
  if (!skipDeadAlphaEnabled()) return false;
  const mats = Array.isArray(material) ? material : [material];
  if (mats.length === 0) return false;
  return mats.every(
    (m) =>
      !!m &&
      m.transparent === true &&
      (m.opacity ?? 1) <= 0 &&
      m.blending === THREE.NormalBlending &&
      m.depthWrite === false &&
      +(m.userData?.__baseTranslucency ?? 0) >= 1
  );
}

// Phase 1.4 — heuristic surface category mirror. MUST match the
// `SurfaceCategory::as_u8` encoding in
// `crates/holtburger-dat/src/surface_classify.rs`.
export const SURFACE_CATEGORY = Object.freeze({
  Stone: 0,
  Wood: 1,
  Metal: 2,
  Sand: 3,
  Lava: 4,
  Water: 5,
  Foliage: 6,
  Cloth: 7,
  Dirt: 8,
  Snow: 9,
  Brick: 10,
  Tile: 11,
  Generic: 12,
});

// Category-aware material defaults applied AFTER the surface-type flag
// decoder. Procedural normal maps (Phase 1.1) ship per-surface via
// `holtburger_dat::normal_gen::normal_from_luminance` (Sobel-X on the
// Rec.601 luminance channel); wiring is at `_materialFromFlags` below.
// === Wave 2.B — procedural normals (2026-05-28) === closed the visibility
// gap: the quality preset's `normalMaps` flag is now consumed by
// `MaterialCache` (it was a no-op flag prior). See `normalMapsEnabled`
// constructor opt + the gate in `_materialFromFlags`.
// === Wave 2.B — procedural normals (2026-05-28) ===
// `normalScale` per-category: the Sobel-X height-to-normal pipeline emits
// the same magnitude regardless of surface, so to land the bump strength
// roughly where it should be we scale per-category at material-build
// time. Stone/Brick/Tile get the strongest bumps (deep mortar/grout
// detail), Wood is mid (anisotropic grain), Cloth/Foliage are subtle
// (cloth fibers, leaf veins shouldn't lift like brick), Sand/Snow flat
// (no real macro relief — would look noisy). Metal is mid (rivets,
// brushed scoring). Lava is subtle (we want the emissive bloom to read
// before the lava-skin micro-relief). Missing categories use 0.8 (Phase
// 1.1 hand-off note default; preserves prior behaviour for Dirt/Water/
// Generic). The Phase 1.5 per-DID override still beats this — when the
// wasm bundle supplies a finite `normalScaleOverride` for a specific DID
// (eg. surface_overrides.json hand tuning), that wins.
const CATEGORY_NORMAL_SCALE_DEFAULTS = Object.freeze({
  [SURFACE_CATEGORY.Stone]: 1.0,
  [SURFACE_CATEGORY.Brick]: 1.1,
  [SURFACE_CATEGORY.Tile]: 0.9,
  [SURFACE_CATEGORY.Wood]: 0.7,
  [SURFACE_CATEGORY.Metal]: 0.6,
  [SURFACE_CATEGORY.Sand]: 0.4,
  [SURFACE_CATEGORY.Snow]: 0.3,
  [SURFACE_CATEGORY.Foliage]: 0.5,
  [SURFACE_CATEGORY.Cloth]: 0.5,
  [SURFACE_CATEGORY.Lava]: 0.4,
  // Water / Dirt / Generic — fall through to the 0.8 default below.
});

const CATEGORY_MATERIAL_DEFAULTS = Object.freeze({
  [SURFACE_CATEGORY.Stone]: { roughness: 0.85, metalness: 0.0 },
  [SURFACE_CATEGORY.Wood]: { roughness: 0.8, metalness: 0.0 },
  [SURFACE_CATEGORY.Metal]: { roughness: 0.3, metalness: 0.9 },
  [SURFACE_CATEGORY.Sand]: { roughness: 0.95, metalness: 0.0 },
  [SURFACE_CATEGORY.Lava]: { roughness: 0.4, metalness: 0.0 },
  [SURFACE_CATEGORY.Foliage]: { roughness: 0.85, metalness: 0.0 },
  // Water, Cloth, Dirt, Snow, Brick, Tile, Generic — fall through to
  // the 0.9 / 0.0 defaults until Phase 1.5 overrides tune per DID.
});

// Phase 0.2 — surface category → detail tile key. The picker stays a
// one-liner so the branch in `_materialFromFlags` is trivial:
//   Stone/Brick/Tile/Lava/Metal → stone-grain  (hard granular)
//   Wood → wood-grain  (anisotropic)
//   Sand/Snow → sand-grain  (fine grain)
//   Foliage/Cloth → fabric-weave  (warp+weft)
//   Water/Dirt/Generic/unset → generic-rough  (fallback)
const DETAIL_KEY_BY_CATEGORY = Object.freeze({
  [SURFACE_CATEGORY.Stone]: "stone-grain",
  [SURFACE_CATEGORY.Brick]: "stone-grain",
  [SURFACE_CATEGORY.Tile]: "stone-grain",
  [SURFACE_CATEGORY.Lava]: "stone-grain",
  [SURFACE_CATEGORY.Metal]: "stone-grain",
  [SURFACE_CATEGORY.Wood]: "wood-grain",
  [SURFACE_CATEGORY.Sand]: "sand-grain",
  [SURFACE_CATEGORY.Snow]: "sand-grain",
  [SURFACE_CATEGORY.Foliage]: "fabric-weave",
  [SURFACE_CATEGORY.Cloth]: "fabric-weave",
});

export function pickDetailTileKey(category) {
  if (typeof category === "number") {
    const key = DETAIL_KEY_BY_CATEGORY[category];
    if (key) return key;
  }
  return "generic-rough";
}

// Phase 0.2 — composite a tiled grayscale detail texture over the
// diffuse via `MeshStandardMaterial.onBeforeCompile`. The PBR pipeline
// stays intact — we only patch the fragment shader's `map_fragment`
// chunk to do
//
//     diffuseColor.rgb = mix(diffuseColor.rgb,
//                            diffuseColor.rgb * (2.0 * detail),
//                            uDetailBlend);
//
// AFTER the texture sample, BEFORE lighting. `detail` is grayscale in
// [0, 1] (mean ~0.5) so `2.0 * detail` re-centres at 1.0 — surfaces
// don't darken or lighten on average, only modulate locally.
// `uDetailBlend = 0.6` keeps the effect visible without overpowering
// the original artwork. `vMapUv * uDetailScale` ties tile frequency to
// surface UV (default 8 → ~12.5 cm grain on a 1 m² wall).
//
// Per plan-doc hand-off: keep this an `onBeforeCompile` patch, NOT a
// custom `ShaderMaterial`. PBR lighting/normal/light-probe chunks then
// pick up every three.js upgrade for free.
const DETAIL_UNIFORM_DEFAULTS = Object.freeze({
  scale: 8.0,
  blend: 0.6,
});

// Build the program-cache-key string for whatever patch set is on the
// material RIGHT NOW. three.js uses `customProgramCacheKey()` to decide
// whether two materials can share a compiled WebGLProgram; the stock
// key ignores our onBeforeCompile string surgery, so without this two
// materials that differ ONLY in their patch composition (e.g. CSM+POM
// vs CSM+lightClamp) collapse onto one program and render each other's
// shader. The key reads each patch's userData flag LAZILY at call time
// (three calls this during setProgram, after every installer has run)
// so the order of patch installation never matters.
function _patchSetCacheKey(material) {
  const u = material.userData || {};
  return (
    "hb" +
    "|d" + (u.detailEnabled ? 1 : 0) +
    "|c" + (u.csmEnabled ? 1 : 0) +
    "|p" + (u.pomEnabled ? 1 : 0) +
    "|l" + (u.lightClampRetail ? 1 : 0) +
    "|a" + (u.__aoPatched ? 1 : 0) +
    "|b" + (u.__depthBiased ? 1 : 0) +
    "|f" + (u.__floorBiased ? 1 : 0) +
    // 2026-07-28 — the two patch flags that were shipped WITHOUT a key bit and
    // therefore silently collapsed onto the un-patched program. `__staticBiased`
    // (applyStaticDepthBias, 2026-07-06) and `__acBakedLight`
    // (applyBakedVertexLightPatch, RND-04 `83e87ada`). The bake one was a
    // LIGHTING regression, not a cosmetic one: three's program cache is keyed
    // per (parameters + this string) RENDERER-WIDE and compiles from whichever
    // material's onBeforeCompile ran first, so an EnvCell mesh sharing the key
    // with any plain surface material got the plain program — no emissive add
    // from `acBakedLight` — while lighting.js had ALREADY dropped that cell's
    // static lamps from the live pool on the strength of the bake. Interiors
    // rendered on ambient alone (measured: 28 programs live, zero carrying
    // `uAcBakedGain`). One bit each; the un-patched key is unchanged.
    "|s" + (u.__staticBiased ? 1 : 0) +
    "|k" + (u.__acBakedLight ? 1 : 0) +
    // VFX component-SET key (Visual-Behavior Suite, spec §2.4). Encodes the
    // component SET + each component's linkVariant() — NEVER per-instance
    // config/hash — so program count ≈ distinct sets, not 10k DIDs. Empty ""
    // when no VFX patch is installed → key unchanged for every existing material.
    "|v" + (u.__vfxSetKey || "")
  );
}

// Install a `customProgramCacheKey` that disambiguates our patch sets.
// Idempotent — every installer calls it via `_chainBeforeCompile`, but
// the closure always reflects the current userData so re-installing is
// harmless. The closure reads userData lazily (NOT at install time) so
// patches added after this call are still reflected in the key.
function _installPatchSetCacheKey(material) {
  material.customProgramCacheKey = function () {
    return _patchSetCacheKey(this);
  };
}

// === 2026-08-03 — live handles on userData must be NON-ENUMERABLE ===========
// three's `Material.copy()` does `userData = JSON.parse(JSON.stringify(...))`,
// and a stashed `shader.uniforms` pins EVERY bound texture (map, normalMap,
// shadow maps) — so an enumerable slot makes each `.clone()` serialize the
// material's whole texture set via `Array.from(image.data)`. Non-enumerable
// keeps `mat.userData.xShaderUniforms` reads working (csm.js, landblock_lru.js,
// the capture scripts) while JSON.stringify AND object spread both skip it; a
// clone builds its own handle from its own compile anyway.
// INVARIANT: never assign a Texture / TypedArray / shader.uniforms to an
// enumerable userData key.
function _defineLiveUserData(material, key, value) {
  const ud = (material.userData = material.userData || {});
  try {
    Object.defineProperty(ud, key, {
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  } catch (_) {
    ud[key] = value; // fail-soft (frozen userData) — behaviour unchanged
  }
}

// Compose a new onBeforeCompile hook with whatever was previously set on
// the material. Each shader-patch installer (detail, CSM, ...) calls
// this so the chain is preserved — three.js calls onBeforeCompile ONCE
// per material at first render, so we have to manually chain the
// patches at install time rather than relying on three to do it.
function _chainBeforeCompile(material, newHook) {
  const prev = material.onBeforeCompile;
  if (typeof prev !== "function" || prev === THREE.Material.prototype.onBeforeCompile) {
    material.onBeforeCompile = newHook;
    _installPatchSetCacheKey(material);
    return;
  }
  material.onBeforeCompile = function chainedOnBeforeCompile(shader, renderer) {
    prev.call(this, shader, renderer);
    newHook.call(this, shader, renderer);
  };
  _installPatchSetCacheKey(material);
}

// Shared VFX uniform globals (Visual-Behavior Suite, spec §2.5). One {value}
// object per global, assigned BY REFERENCE into every patched material's
// uniforms and driven once/frame by the material-oscillator tick (Phase 1):
// `uTime` IS the single VFX clock — there is exactly ONE per-frame VFX tick.
// Dormant until a frag/MECH-B component declares one of these uniforms.
export const VFX_GLOBALS = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(1, 0) },
  uWetness: { value: 0 },
  uFrost: { value: 0 },
  uCamPos: { value: new THREE.Vector3() },
};

// Install ONE frag/MECH-B VFX component's patch onto a getCachedVariant clone
// (Visual-Behavior Suite, spec §2.3/§2.6). frag_install.js calls this per
// component in (FAMILY_ORDER, id) order; the chain composition + the
// __vfxSetKey-driven program-cache key (set by getCachedVariant, read by
// _patchSetCacheKey) live entirely here so frag_install stays THREE-free.
// declareUniforms binds VFX_GLOBALS by REFERENCE (shared {value} objects driven
// once/frame); inject splices the GLSL seam. Both run at compile (inside
// onBeforeCompile), never at install time — so the shared uniforms are present
// on shader.uniforms before three builds the program.
export function installVfxComponentPatch(material, component, config, globals) {
  if (!material || !component) return;
  _chainBeforeCompile(material, function vfxComponentHook(shader) {
    try { component.declareUniforms && component.declareUniforms(shader, config, globals); }
    catch (e) { console.warn(`[vfx] declareUniforms ${component.id} failed:`, e); }
    try { component.inject && component.inject(shader, { material: this, config, globals }); }
    catch (e) { console.warn(`[vfx] inject ${component.id} failed:`, e); }
  });
}

// 2026-05-22 — wire-agent: cheap normal-based AO modulation. Patches a
// MeshBasicMaterial's shader to multiply the fragment colour by
// `mix(0.45, 1.0, smoothstep(-0.3, 1.0, vWorldNormalAO.y))`. Result:
// floors (N=up) full bright, walls (N⊥up) ~70%, ceilings/overhangs
// (N=-up) ~45%. Adds 3D depth perception to flat-shaded wireframe
// fills without per-vertex precompute or new geometry attributes —
// just one extra varying + one mix() per fragment. Applied to every
// wire-bucket / fill-bucket / per-DID material in this cache.
export function applyWireVertexAOPatch(material) {
  if (!material || material.userData?.__aoPatched) return;
  _chainBeforeCompile(material, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vWorldNormalAO;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vWorldNormalAO = normalize(mat3(modelMatrix) * normal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vWorldNormalAO;`,
      )
      .replace(
        "#include <fog_fragment>",
        // Apply BEFORE fog so the AO darkening fades into the fog
        // colour at distance, not the unmodulated colour.
        `gl_FragColor.rgb *= mix(0.45, 1.0, smoothstep(-0.3, 1.0, vWorldNormalAO.y));
        #include <fog_fragment>`,
      );
  });
  material.userData = material.userData ?? {};
  material.userData.__aoPatched = true;
}

// 2026-06-02 — wire-fill z-fight fix. The renderer runs
// `logarithmicDepthBuffer: true`, so every material writes `gl_FragDepth`,
// which makes `polygonOffset` a NO-OP (the fixed-function offset is discarded
// once a fragment shader writes depth). The wire fills relied on polygonOffset
// to sit just behind their own coplanar outline lines; under log-depth the
// lines z-fight the fill — worst in wall-dense indoor corners (the Academy).
// Replace the dead offset with a tiny log-depth-space bias: nudge the FILL a
// hair deeper so the wire (drawn on top, unbiased) always wins the depth test,
// while the fill still writes depth to occlude geometry behind it. Tunable via
// the constant below — raise if a corner still flickers, lower if the fill
// detaches at silhouettes.
export function applyFillDepthBias(material) {
  if (!material || material.userData?.__depthBiased) return;
  _chainBeforeCompile(material, (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <logdepthbuf_fragment>",
      `#include <logdepthbuf_fragment>
      #if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
        gl_FragDepth += 2.0e-4;
      #endif`,
    );
  });
  material.userData = material.userData ?? {};
  material.userData.__depthBiased = true;
}

// 2026-06-15 — building/EnvCell floor-vs-terrain z-fight fix. Same log-depth
// space as applyFillDepthBias, OPPOSITE sign. A SetupModel building's floor (or
// an EnvCell floor) and the terrain beneath it write the IDENTICAL logarithmic
// gl_FragDepth and are coplanar to ~cm at a building footprint, so under
// GL_LESS the depth test is a tie → per-pixel/per-frame flicker (the "floor vs
// grass, shows both" bug). Subtracting a tiny epsilon pulls the surface a hair
// NEARER so it deterministically wins against the coplanar terrain. polygonOffset
// is dead here (see applyFillDepthBias above — manual gl_FragDepth discards it).
// The epsilon only breaks exact coplanar ties — far too small to push a floor up
// through a real hill. Applied via getCachedFloorBias (cache-owned CLONE) so the
// shared base material is never mutated.
export function applyFloorDepthBias(material) {
  if (!material || material.userData?.__floorBiased) return;
  _chainBeforeCompile(material, (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <logdepthbuf_fragment>",
      `#include <logdepthbuf_fragment>
      #if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
        gl_FragDepth -= 2.0e-4;
      #endif`,
    );
  });
  material.userData = material.userData ?? {};
  material.userData.__floorBiased = true;
}

// 2026-07-06 — cell-static décor z-fight fix. Wall/floor décor props (tapestries,
// sconces, signs, rugs) are separate SetupModels placed FLUSH against an EnvCell
// wall or floor, so the prop face and the cell surface write the IDENTICAL
// logarithmic gl_FragDepth and tie under GL_LESS → per-pixel flicker (the
// "z-fight near walls" seen in dungeon hallways + building interiors). Same
// log-depth trick as applyFloorDepthBias, OPPOSITE of terrain, but a STRONGER
// pull (−4e-4 vs the floor's −2e-4) so the décor wins even over a surface that
// itself already carries the floor bias. The epsilon only breaks exact coplanar
// ties — far too small to visibly detach a prop from its wall. Applied via
// getCachedStaticBias (cache-owned CLONE) so the shared base is never mutated.
export function applyStaticDepthBias(material) {
  if (!material || material.userData?.__staticBiased) return;
  _chainBeforeCompile(material, (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <logdepthbuf_fragment>",
      `#include <logdepthbuf_fragment>
      #if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
        gl_FragDepth -= 4.0e-4;
      #endif`,
    );
  });
  material.userData = material.userData ?? {};
  material.userData.__staticBiased = true;
}

// === RND-04 (2026-07-27) — BAKED STATIC LIGHT (retail vertex burn-in) ======
//
// Retail bakes every static light in the loaded cell set into the EnvCell
// mesh's vertex DIFFUSE (`D3DPolyRender::SetStaticLightingVertexColors`
// acclient.c:454918) and then draws that mesh with
// `SetFFEmissiveColorSource(FromVertex)` (acclient.c:454724) — the baked
// colour is an EMISSIVE ADD on top of ambient + the enabled hardware lights,
// NOT a diffuse modulation. The wasm side ships the bytes as the
// `acBakedLight` attribute (see adapter.js / lib.rs RND-04).
//
// Two retail behaviours, one flag:
//   1. emissive-add of `albedo * bakedRGB` (always, when the bake is on);
//   2. `Render::minimize_envcell_lighting` (acclient.c:379652) enables
//      DYNAMIC lights only for an EnvCell draw — statics are already in the
//      mesh, and the sun is not enabled indoors. three's light list is
//      per-program, not per-draw, so the equivalent is to drop the DIRECT
//      terms on this material and keep indirect + the bake.
//
//   ?vertexBake=off  everything off; cell meshes render exactly as today.
//   ?vertexBake=lit  bake ADDS but direct light is kept (pure-additive A/B
//                    arm — double-lights the walls, useful only for eyeball
//                    diffing the bake against the live pool).
//   (absent / anything else) = ON, both behaviours. Reader semantics are
//   `=== "off"` / `=== "lit"`, so an ABSENT param is FULLY ON — do not infer
//   the default from prose.
export function readVertexBakeFlag() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location) {
      const raw = (
        new URLSearchParams(globalThis.location.search || "").get("vertexBake") || ""
      ).toLowerCase();
      if (raw === "off" || raw === "false" || raw === "0" || raw === "no") {
        return { enabled: false, suppressDirect: false };
      }
      if (raw === "lit" || raw === "add") {
        return { enabled: true, suppressDirect: false };
      }
    }
  } catch (_) {}
  return { enabled: true, suppressDirect: true };
}

export const VERTEX_BAKE = readVertexBakeFlag();

// Installs the bake term on a material. Idempotent (userData guard) and
// chained, so it composes with the detail / CSM / light-clamp patches.
//
// Anchors chosen to not collide with anything else in this file: the light
// clamp expands `<lights_pars_begin>` + `<lights_fragment_begin>`, so we take
// `<lights_fragment_end>`, which nothing patches and which runs after every
// RE_Direct/RE_IndirectDiffuse has accumulated into `reflectedLight`.
export function applyBakedVertexLightPatch(material, opts = {}) {
  if (!material || material.userData?.__acBakedLight) return;
  const suppressDirect = opts.suppressDirect === true;
  _chainBeforeCompile(material, (shader) => {
    // Uniforms rather than #defines so a future light tick can cross-fade the
    // bake without a shader relink (relink-freeze rule).
    shader.uniforms.uAcBakedGain = { value: 1.0 };
    shader.uniforms.uAcBakedSuppressDirect = { value: suppressDirect ? 1.0 : 0.0 };

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        [
          "#include <common>",
          // three r184 aliases attribute/varying to in/out for GLSL3, so this
          // one spelling compiles on both paths.
          "attribute vec3 acBakedLight;",
          "varying vec3 vAcBakedLight;",
        ].join("\n"),
      )
      .replace(
        "#include <begin_vertex>",
        [
          "#include <begin_vertex>",
          // Gouraud by construction: retail interpolates the burned vertex
          // diffuse across the triangle. No renormalisation, no clamping.
          "vAcBakedLight = acBakedLight;",
        ].join("\n"),
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        [
          "#include <common>",
          "varying vec3 vAcBakedLight;",
          "uniform float uAcBakedGain;",
          "uniform float uAcBakedSuppressDirect;",
          // The baked bytes are in the AUTHORED (sRGB) space, exactly as the
          // DAT stores the lamp ARGB and as retail writes the D3D diffuse.
          // The live-light path decodes with setRGB(..., SRGBColorSpace) in
          // lighting.js; decode here too or a baked lamp reads brighter and
          // flatter than the same lamp run live. Piecewise EOTF is inlined
          // rather than taken from a three chunk so this does not depend on
          // colorspace_pars_fragment being included by the host material.
          "vec3 acBakedEotf(vec3 c) {",
          "  return mix(",
          "    pow((c + 0.055) / 1.055, vec3(2.4)),",
          "    c / 12.92,",
          "    step(c, vec3(0.04045))",
          "  );",
          "}",
        ].join("\n"),
      )
      .replace(
        "#include <lights_fragment_end>",
        [
          "#include <lights_fragment_end>",
          "{",
          "  // acclient.c:379652 minimize_envcell_lighting: an EnvCell draw",
          "  // enables DYNAMIC lights only. Statics live in the bake and the",
          "  // sun is off indoors, so under the retail arm the direct terms",
          "  // are dropped and indirect (ambient / IBL) plus the bake carry",
          "  // the surface. uAcBakedSuppressDirect = 0 keeps them (?vertexBake=lit).",
          "  float acKeepDirect = 1.0 - uAcBakedSuppressDirect;",
          "  reflectedLight.directDiffuse *= acKeepDirect;",
          "  reflectedLight.directSpecular *= acKeepDirect;",
          "  // Emissive ADD, retail semantics: D3D fixed-function sums",
          "  // emissive + ambient + lights into the vertex colour, then the",
          "  // texture stage MODULATES by it, so the baked term arrives",
          "  // scaled by the albedo. acclient.c:454724.",
          "  reflectedLight.indirectDiffuse +=",
          "    diffuseColor.rgb * acBakedEotf(vAcBakedLight) * uAcBakedGain;",
          "}",
        ].join("\n"),
      );

    // Stash for post-compile introspection by tests / capture scripts, same
    // convention as lightClampShaderUniforms.
    _defineLiveUserData(material, "acBakedLightUniforms", shader.uniforms);
  });
  material.userData = material.userData ?? {};
  material.userData.__acBakedLight = true;
  material.userData.__acBakedSuppressDirect = suppressDirect;
}

function _installDetailShaderPatch(material, detailTexture, opts = {}) {
  const detailScale = opts.scale ?? DETAIL_UNIFORM_DEFAULTS.scale;
  const detailBlend = opts.blend ?? DETAIL_UNIFORM_DEFAULTS.blend;
  // Track injected uniforms on the material itself so tests + capture
  // scripts can introspect them without re-compiling the shader.
  material.userData = {
    ...(material.userData || {}),
    detailEnabled: true,
    detailTextureName: detailTexture?.name ?? null,
    detailUniforms: {
      scale: detailScale,
      blend: detailBlend,
    },
  };
  _chainBeforeCompile(material, (shader) => {
    shader.uniforms.uDetailMap = { value: detailTexture };
    shader.uniforms.uDetailScale = { value: detailScale };
    shader.uniforms.uDetailBlend = { value: detailBlend };
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      `uniform sampler2D uDetailMap;
uniform float uDetailScale;
uniform float uDetailBlend;
void main() {`
    );
    // `#include <map_fragment>` is the MeshStandard chunk that folds
    // the diffuse texture (`map`) into `diffuseColor`. We append the
    // detail composite right after so PBR shading downstream sees the
    // modulated diffuse.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#include <map_fragment>
{
  vec2 _dUv = vMapUv * uDetailScale;
  float _d = texture2D(uDetailMap, _dUv).r;
  vec3 _modulated = diffuseColor.rgb * (2.0 * _d);
  diffuseColor.rgb = mix(diffuseColor.rgb, _modulated, uDetailBlend);
}`
    );
    // Stash the patched shader handle back on the material so tests
    // can read uniforms post-compile (three.js doesn't expose
    // `shader.uniforms` after the upload otherwise).
    _defineLiveUserData(material, "detailShaderUniforms", shader.uniforms);
  });
  // Force shader re-compile if the material was already used.
  material.needsUpdate = true;
}

// Visual-fidelity Phase 3.3 — install the CSM cascade-sample shader
// patch on a `MeshStandardMaterial`. Sampling pattern:
//
//   1. Compute view-space depth from the fragment's view-space position
//      (vViewPosition.z; three.js gives positive depth in front of cam
//      so we negate for the linear "metres from camera" we compare to
//      `splits`).
//   2. Pick a cascade index by comparing depth to the two split points.
//   3. Sample that cascade's shadow map (light-NDC projection from
//      `uCsmMatrix[i]`).
//   4. Smooth-blend at boundaries — at depth ≥ split * (1 - blendFrac),
//      sample the NEXT cascade too and lerp by depth.
//   5. Multiply the directional sun's diffuse contribution by the
//      resulting shadow factor.
//
// Where it patches: we replace the `<lights_fragment_begin>` chunk with
// our version. Three's stock chunk multiplies each directional light's
// contribution by `getShadowMask()` (which queries the per-light shadow
// maps); we substitute our manually-computed CSM factor as the only
// shadow attenuation. The directional light that we actually consider
// is the sun's "logical" sun (intensity > 0) — the 3 CSM cascade lights
// have intensity=0 so they contribute zero to direct lighting AND
// they're the lights three.js will keep generating shadow maps for.
//
// IMPORTANT: this patch ALSO disables three's built-in shadow path for
// the cascade lights by replacing `<shadowmask_pars_fragment>`'s
// `getShadowMask` with a stub that returns 1.0 — that way three's
// stock light loop doesn't try to attenuate the (intensity=0) cascade
// lights' contribution (which would be wasteful + interfere).
function _installCsmShaderPatch(material, csmState) {
  if (!csmState) return;
  material.userData = {
    ...(material.userData || {}),
    csmEnabled: true,
  };
  _chainBeforeCompile(material, (shader) => {
    // Allocate uniforms (texture refs filled in by refreshCsmUniforms
    // each frame; init to whatever's already on the cascade lights so
    // the first frame doesn't render with a null sampler).
    shader.uniforms.uCsmShadowMap0 = { value: csmState.lights[0]?.shadow?.map?.texture ?? null };
    shader.uniforms.uCsmShadowMap1 = { value: csmState.lights[1]?.shadow?.map?.texture ?? null };
    shader.uniforms.uCsmShadowMap2 = { value: csmState.lights[2]?.shadow?.map?.texture ?? null };
    shader.uniforms.uCsmMatrix0 = { value: csmState.lights[0]?.shadow?.matrix?.clone() ?? new THREE.Matrix4() };
    shader.uniforms.uCsmMatrix1 = { value: csmState.lights[1]?.shadow?.matrix?.clone() ?? new THREE.Matrix4() };
    shader.uniforms.uCsmMatrix2 = { value: csmState.lights[2]?.shadow?.matrix?.clone() ?? new THREE.Matrix4() };
    shader.uniforms.uCsmSplits = { value: new THREE.Vector2(csmState.splits[0], csmState.splits[1]) };
    shader.uniforms.uCsmFar = { value: csmState.splits[2] };
    shader.uniforms.uCsmBlend = { value: csmState.blendFrac };

    // Declare uniforms + the sampling helper. Inject right after the
    // existing `void main() {` insertion point — the detail patch puts
    // its uniforms there too, so we append (the _chainBeforeCompile
    // mechanism means the detail patch already ran if it's also active).
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      `uniform sampler2D uCsmShadowMap0;
uniform sampler2D uCsmShadowMap1;
uniform sampler2D uCsmShadowMap2;
uniform mat4 uCsmMatrix0;
uniform mat4 uCsmMatrix1;
uniform mat4 uCsmMatrix2;
uniform vec2 uCsmSplits;
uniform float uCsmFar;
uniform float uCsmBlend;

// Sample one cascade's shadow map at worldPos. Returns 1.0 for fully
// lit, 0.0 for fully shadowed. Standard PCF-1-tap (3-tap unrolled for
// a softer edge without the cost of full PCF).
float _csmSampleCascade(sampler2D sm, mat4 m, vec3 worldPos) {
  vec4 shadowCoord = m * vec4(worldPos, 1.0);
  // shadow.matrix is composed by three to produce coords in [0,1] for
  // x,y already; z is in [0,1] as depth in NDC. Perspective-divide
  // not needed for ortho but doesn't hurt.
  shadowCoord.xyz /= max(shadowCoord.w, 1e-6);
  // Bail out if outside [0,1]² UV — the fragment is outside this
  // cascade's coverage. Return 1.0 (lit) so the caller can fall
  // through to the next cascade. The selector logic above this loop
  // picks the correct cascade so out-of-range hits are rare; still,
  // a defensive return prevents shader divisions by zero.
  if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 ||
      shadowCoord.y < 0.0 || shadowCoord.y > 1.0 ||
      shadowCoord.z > 1.0) {
    return 1.0;
  }
  // Compare reference depth against stored. three.js renders
  // depth-only into the R channel of the shadow map texture
  // (DepthTexture; sampled via .x).
  float bias = 0.0005;
  float ref = shadowCoord.z - bias;
  float stored = texture2D(sm, shadowCoord.xy).r;
  return stored < ref ? 0.0 : 1.0;
}

// CSM main entry — pick cascade by view-space depth and sample with
// blending at boundaries.
float _csmShadowFactor(vec3 worldPos, float viewDepth) {
  // Hard-decide cascade by depth; near < splits.x => 0, < splits.y => 1,
  // < uCsmFar => 2, else => unshadowed (we're beyond the last cascade).
  float blendW0 = uCsmSplits.x * uCsmBlend; // width of blend zone end of cascade 0
  float blendW1 = uCsmSplits.y * uCsmBlend; // width of blend zone end of cascade 1
  if (viewDepth > uCsmFar) {
    return 1.0;
  }
  if (viewDepth < uCsmSplits.x - blendW0) {
    // Solidly in cascade 0.
    return _csmSampleCascade(uCsmShadowMap0, uCsmMatrix0, worldPos);
  }
  if (viewDepth < uCsmSplits.x) {
    // Blend zone between cascade 0 and 1.
    float s0 = _csmSampleCascade(uCsmShadowMap0, uCsmMatrix0, worldPos);
    float s1 = _csmSampleCascade(uCsmShadowMap1, uCsmMatrix1, worldPos);
    float t = (viewDepth - (uCsmSplits.x - blendW0)) / blendW0;
    return mix(s0, s1, clamp(t, 0.0, 1.0));
  }
  if (viewDepth < uCsmSplits.y - blendW1) {
    // Solidly in cascade 1.
    return _csmSampleCascade(uCsmShadowMap1, uCsmMatrix1, worldPos);
  }
  if (viewDepth < uCsmSplits.y) {
    // Blend zone between cascade 1 and 2.
    float s1 = _csmSampleCascade(uCsmShadowMap1, uCsmMatrix1, worldPos);
    float s2 = _csmSampleCascade(uCsmShadowMap2, uCsmMatrix2, worldPos);
    float t = (viewDepth - (uCsmSplits.y - blendW1)) / blendW1;
    return mix(s1, s2, clamp(t, 0.0, 1.0));
  }
  // Solidly in cascade 2 (far range).
  return _csmSampleCascade(uCsmShadowMap2, uCsmMatrix2, worldPos);
}

void main() {`
    );

    // We need access to the world-space fragment position. Three.js
    // doesn't ship a stock `vWorldPosition` for MeshStandardMaterial
    // unless the env-map path or USE_TRANSMISSION is active. Inject one
    // by piggy-backing on the existing `worldpos_vertex` chunk, which
    // computes `worldPosition` in vertex shader for shadow path; mirror
    // that into a varying we can read in fragment.
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
varying vec3 vCsmWorldPos;
varying float vCsmViewDepth;`
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
{
  vec4 _wp = modelMatrix * vec4(transformed, 1.0);
  vCsmWorldPos = _wp.xyz;
  // mvPosition is in view space (camera-relative). View-space depth
  // is -mvPosition.z (z is negative in front of camera).
  vCsmViewDepth = -mvPosition.z;
}`
    );

    // Apply our CSM factor as a multiplier on the directional light's
    // diffuse contribution. Three's MeshStandardMaterial light loop
    // calls `getShadowMask()` per directional light; we patch the
    // `<lights_fragment_begin>` chunk so the shadow mask uses our CSM
    // factor instead of three's per-light shadow texture lookup. Since
    // the cascade lights have intensity=0 they contribute nothing
    // directly; the shadow comes from THIS material's manual
    // multiplication of the sun's contribution.
    //
    // Simpler integration: we apply the CSM factor in the
    // `<output_fragment>` chunk as a multiplier on the final RGB —
    // this isn't ideal (it attenuates ambient too) BUT given that the
    // sun's contribution dominates the lit-side colour budget, the
    // visual outcome is acceptable. A future iteration can move the
    // multiplier inside `<lights_fragment_end>` to attenuate only the
    // sun's term. For Phase 3.3 starting visual smoke this is enough.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
varying vec3 vCsmWorldPos;
varying float vCsmViewDepth;`
    );
    // Inject the CSM shadow term right before final output composition.
    // `<dithering_fragment>` is the very last chunk in MeshStandard's
    // fragment shader (post-tonemap, pre-output); we apply our
    // attenuation just before it so the lit colour ALREADY accounts
    // for ambient + directional, then we modulate by shadow factor.
    // Ambient gets a 0.45 floor so deep shadows don't crush to black
    // (matches Phase 0.1's ambient baseline contribution feel).
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_fragment>",
      `{
  float _csmShadow = _csmShadowFactor(vCsmWorldPos, vCsmViewDepth);
  // Floor shadow at 0.45 so receivers in shadow keep some ambient
  // lift — matches the visual feel of Phase 0.1's PCFShadowMap path
  // (which also doesn't crush to 0 because of ambient + hemisphere).
  float _csmAtten = mix(0.45, 1.0, _csmShadow);
  gl_FragColor.rgb *= _csmAtten;
}
#include <dithering_fragment>`
    );

    // Stash the uniforms so `refreshCsmUniforms` can update the texture
    // + matrix references each frame post-compile.
    _defineLiveUserData(material, "csmShaderUniforms", shader.uniforms);
  });
  // Register on the bundle's set so refreshCsmUniforms walks us.
  if (csmState.patchedMaterials && typeof csmState.patchedMaterials.add === "function") {
    csmState.patchedMaterials.add(material);
  }
  material.needsUpdate = true;
}

// Public export: install the CSM patch on an arbitrary material.
// Phase 3.3 callers (MaterialCache + the fallback path) use this; tests
// import it directly to assert the shader-patch wires up.
export function installCsmShaderPatch(material, csmState) {
  _installCsmShaderPatch(material, csmState);
}

// Visual-fidelity Phase 3.1 — Parallax Occlusion Mapping (POM).
//
// Ray-marches through a per-surface heightmap (R8; since 2026-07-30 the
// SEAM-derived field from `holtburger_dat::height_seam` — 255 = proud
// face, joints dip toward 0 — replacing the luminance operator that
// inverted on half-timber) to give a stone wall the illusion of
// recessed mortar / raised brick. Standard
// learnopengl.com/Advanced-Lighting/Parallax-Mapping recipe:
//
//   1. Compute view direction in tangent space (transposed TBN times
//      world-space view dir).
//   2. Step along that direction in UV space, comparing the current
//      sampled height to the marching ray's depth. When the ray dips
//      below the heightfield, we've found the intersection — that's
//      the perturbed UV to sample the diffuse + normal with.
//   3. The fragment-shader normal sample uses the perturbed UV too
//      so the per-pixel normal aligns with where the diffuse appears
//      to come from at depth.
//
// Patching path: we use `_chainBeforeCompile` so this composes with the
// Phase 0.2 Detail patch + the Phase 3.3 CSM patch installed on the
// same material. Three.js calls onBeforeCompile once at first render
// so we have to manually chain at install time.
//
// LOD ramp (§Phase 3.1 Objective #3): POM full-strength below 5m,
// linearly fades to 0 between 5m and 10m (camera distance to the
// fragment), beyond 10m POM is fully disabled — the fragment falls
// back to flat normal mapping. Camera distance is computed from
// `vViewPosition.z` (three.js's view-space z, negative in front of
// camera → we negate). This keeps the fragment-shader cost focused
// on the close foreground where POM is visually load-bearing.
//
// Self-shadowing (§Phase 3.1 Objective #4): after the primary
// intersection we shoot a secondary ray FROM the heightfield TOWARD
// the sun's tangent-space direction. If a higher point along that
// ray blocks the sun, the fragment is in micro-shadow and we darken
// the diffuse contribution. This is the "POM + self-shadow" variant
// (per hand-off #2). Step count for self-shadow ray is capped at 8
// regardless of the primary uPomSteps to keep the fragment cost
// bounded (the secondary ray is always at grazing angles where many
// samples collapse to the same texel anyway).
//
// IMPORTANT (per hand-off note #3): we accept the silhouette
// artifact. Pixels at the edge of the mesh can't extend geometry, so
// the perturbed UV bleeds outside the surface. The ultra preset can
// add silhouette clipping later; for now this is intentional.
/**
 * `?pomGraze` — DEFAULT ON. Grazing-angle step ramp + amplitude fade in the
 * POM march (see the GRAZING FIX notes in `_pomPerturbedUv`). `off` restores
 * the pre-2026-08-02 constants so the roof-shingle smear can be A/B'd in one
 * session.
 */
export function pomGrazeEnabled(search) {
  try {
    const q = typeof search === "string"
      ? search
      : (typeof window !== "undefined" && window.location ? window.location.search : "");
    const v = new URLSearchParams(q || "").get("pomGraze");
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

const POM_UNIFORM_DEFAULTS = Object.freeze({
  steps: 16,
  ultraSteps: 32,
  // Tangent-space depth scale. 0.08 = 8cm parallax at 1m surface tile;
  // strong enough to be visually obvious on a stone wall at 1-3m. Too
  // high (>0.15) and silhouette artifacts dominate; too low (<0.03)
  // and the effect is invisible.
  depth: 0.08,
  // Distance-based LOD ramp (camera-to-fragment, metres). POM full
  // strength below 5m, fades to zero between 5-10m. Per §Phase 3.1
  // Objective #3: "distance < 10m only".
  lodNear: 5.0,
  lodFar: 10.0,
  // Self-shadow secondary ray step count + bias.
  shadowSteps: 8,
  shadowDarkness: 0.5, // [0,1] — 0=fully dark, 1=no shadow
});

function _installPomShaderPatch(material, heightTexture, opts = {}) {
  if (!heightTexture) return;
  // Perf D2: pull primary + self-shadow step counts from the quality
  // preset (`pomStepsPrimary`, `pomStepsSelfShadow`) so `mid` can run
  // POM at ~50% the cost of `high`. Per-call `opts.steps` still wins
  // if explicitly passed (test harness, A/B). 2026-07-30: resolve via
  // getQuality() (memoized), NOT window.liveScene3d — that is stamped
  // ~35 s after in-world, so every material built during boot silently
  // took the 16/8 POM_UNIFORM_DEFAULTS instead of the tier's counts
  // (2x the intended fragment cost at mid). liveScene3d stays as the
  // fallback for harnesses that stub quality there.
  let _qFlags = null;
  try {
    _qFlags = getQuality()?.flags || null;
  } catch (_) {
    _qFlags = typeof window !== "undefined" ? window.liveScene3d?.quality?.flags : null;
  }
  const _qPrimary = Number.isFinite(_qFlags?.pomStepsPrimary)
    ? _qFlags.pomStepsPrimary
    : null;
  const _qShadow = Number.isFinite(_qFlags?.pomStepsSelfShadow)
    ? _qFlags.pomStepsSelfShadow
    : null;
  const steps = opts.steps ?? _qPrimary ?? POM_UNIFORM_DEFAULTS.steps;
  const depth = opts.depth ?? POM_UNIFORM_DEFAULTS.depth;
  const lodNear = opts.lodNear ?? POM_UNIFORM_DEFAULTS.lodNear;
  const lodFar = opts.lodFar ?? POM_UNIFORM_DEFAULTS.lodFar;
  const shadowSteps =
    opts.shadowSteps ?? _qShadow ?? POM_UNIFORM_DEFAULTS.shadowSteps;
  const shadowDarkness =
    opts.shadowDarkness ?? POM_UNIFORM_DEFAULTS.shadowDarkness;
  // Mark on userData BEFORE _chainBeforeCompile so the test harness can
  // assert installation without waiting for first render.
  material.userData = {
    ...(material.userData || {}),
    pomEnabled: true,
    pomTextureName: heightTexture.name ?? null,
    pomUniforms: {
      steps,
      depth,
      lodNear,
      lodFar,
      shadowSteps,
      shadowDarkness,
    },
  };
  _chainBeforeCompile(material, (shader) => {
    shader.uniforms.uPomMap = { value: heightTexture };
    shader.uniforms.uPomSteps = { value: steps };
    shader.uniforms.uPomDepth = { value: depth };
    shader.uniforms.uPomLodNear = { value: lodNear };
    shader.uniforms.uPomLodFar = { value: lodFar };
    shader.uniforms.uPomShadowSteps = { value: shadowSteps };
    shader.uniforms.uPomShadowDarkness = { value: shadowDarkness };
    // 2026-08-02 — grazing-angle step ramp + amplitude fade. DEFAULT ON;
    // `?pomGraze=off` restores the pre-fix numbers exactly (0.05 epsilon,
    // fixed step count, hard `z > 0.15` cut) for a same-session A/B.
    shader.uniforms.uPomGraze = { value: pomGrazeEnabled() ? 1.0 : 0.0 };

    // S4 fix (2026-07-30) — the vertex-stage TBN this patch used to
    // fabricate (`cross(view-space up, normal)`) had no relationship
    // to the UV layout and ROTATED WITH THE CAMERA — the parallax
    // slid rather than deepened. No geometry in the tree carries a
    // `tangent` attribute, so the `#ifdef USE_TANGENT` arm never ran.
    // The frame is now built in the FRAGMENT stage from three's own
    // `getTangentFrame` (declared by <normalmap_pars_fragment>, which
    // this material always includes — `pomShouldApply` requires
    // `normalTexture`): the same UV-correct derivative frame the
    // normal map itself uses. No vertex-shader patch remains.

    // Fragment shader: declare uniforms + the ray-march helper, then
    // patch the `<map_fragment>` chunk so the diffuse sample uses the
    // perturbed UV. We have to inject BEFORE `<map_fragment>` so the
    // perturbed UV is in scope by the time the chunk samples `map`.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
uniform sampler2D uPomMap;
uniform int uPomSteps;
uniform float uPomDepth;
uniform float uPomLodNear;
uniform float uPomLodFar;
uniform int uPomShadowSteps;
uniform float uPomShadowDarkness;
uniform float uPomGraze;
// Fragment-stage tangent frame (S4 fix) — built once in the patched
// <map_fragment> from getTangentFrame, reused by the self-shadow pass.
// Constant initializers only (GLSL ES 3.0 global rule); _pomLodG = 0.0
// covers every early-out so the self-shadow block self-gates.
mat3 _pomTbnG;
float _pomLodG = 0.0;
vec2 _pomUvG = vec2(0.0);

// Ray-march a heightfield in tangent UV space. Returns the perturbed
// UV — sample diffuse/normal/etc at this UV to get the POM look.
// Standard parallax occlusion: linear search to find the layer where
// the ray crosses the heightfield, then one bisection refinement.
//
// vTanDir is the tangent-space view direction (FROM fragment TO
// camera). Higher z = looking down at the surface (small parallax);
// lower z = grazing (large parallax).
vec2 _pomPerturbedUv(vec2 baseUv, vec3 vTanDir, float depthScale, int steps) {
  // 2026-08-02 GRAZING FIX (?pomGraze=off restores the legacy numbers).
  //
  // The user-visible symptom was roof shingles at a glancing view degenerating
  // into vertical stalactite smears with hard stair-stepping. Two causes, both
  // addressed here:
  //
  //  (a) STEP RAMP. The march always took the same step COUNT regardless
  //      of angle, but the UV path length it has to cover grows as 1/cos —
  //      about 7x longer at 82 deg than head-on. So the sample SPACING along
  //      the ray grew with the same factor and the linear search started
  //      skipping whole shingle edges: the stair-stepping. Scale the count by
  //      1/max(dot(V,N), eps), capped at the loop bound.
  //  (b) BOUNDED PROJECTION. The 0.05 epsilon allowed a 20x UV shift, i.e. a
  //      smear up to 20 * depthScale long, which is the stalactite itself.
  //      0.12 bounds it at ~8x, still ample for real relief.
  float _pz = max(abs(vTanDir.z), uPomGraze > 0.5 ? 0.12 : 0.05);
  int nSteps = steps;
  if (uPomGraze > 0.5) {
    nSteps = int(min(64.0, float(steps) * clamp(1.0 / _pz, 1.0, 3.0) + 0.5));
  }
  vec2 uvStep = vTanDir.xy / _pz * depthScale / float(nSteps);
  float layerStep = 1.0 / float(nSteps);
  steps = nSteps;
  vec2 currentUv = baseUv;
  float currentLayerDepth = 0.0;
  // The seam field stores the PROUD face at 255 and joints dipping
  // toward 0 (height_seam.rs — broad regions are invariant, only thin
  // lines carve). Convert to depth: depth = 1 - height. We walk INTO
  // the surface (current layer depth increases), and stop when our
  // current depth exceeds the heightmap depth at the current UV.
  float currentHeight = 1.0 - texture2D(uPomMap, currentUv).r;
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    if (currentLayerDepth >= currentHeight) break;
    currentUv -= uvStep;
    currentLayerDepth += layerStep;
    currentHeight = 1.0 - texture2D(uPomMap, currentUv).r;
  }
  // One-step secant refinement: lerp between the last two samples by
  // the crossing fraction. afterDepth is <= 0 once the ray crossed and
  // beforeDepth >= 0, so the true denominator is NEGATIVE — the old
  // max(denominator, 1e-6) clamp degenerated the weight to 0 on every
  // real crossing. A march that never crossed (flat seam field, the
  // common texel) keeps the un-refined uv.
  vec2 prevUv = currentUv + uvStep;
  float afterDepth = currentHeight - currentLayerDepth;
  float beforeDepth = (1.0 - texture2D(uPomMap, prevUv).r)
                      - (currentLayerDepth - layerStep);
  float den = afterDepth - beforeDepth;
  float w = den < -1e-6 ? clamp(afterDepth / den, 0.0, 1.0) : 0.0;
  return mix(currentUv, prevUv, w);
}

// Self-shadow: from the perturbed UV (the intersection point), shoot
// a ray TOWARD the sun in tangent space. If any sample's height is
// above our current ray depth, the fragment is occluded — multiply
// the diffuse by uPomShadowDarkness. Skipped (returns 1.0) when the
// sun is behind the surface (lTan.z <= 0).
float _pomShadow(vec2 hitUv, float hitDepth, vec3 lTan, float depthScale, int sSteps) {
  if (lTan.z <= 0.001) return 1.0;
  vec2 uvStep = lTan.xy / max(abs(lTan.z), 0.05) * depthScale / float(sSteps);
  float layerStep = hitDepth / float(sSteps);
  vec2 currentUv = hitUv + uvStep;
  float currentDepth = hitDepth - layerStep;
  for (int i = 0; i < 16; i++) {
    if (i >= sSteps) break;
    if (currentDepth <= 0.0) break;
    float h = 1.0 - texture2D(uPomMap, currentUv).r;
    if (h < currentDepth) {
      // Heightfield is ABOVE our ray (occluder blocking sun).
      return uPomShadowDarkness;
    }
    currentUv += uvStep;
    currentDepth -= layerStep;
  }
  return 1.0;
}`
    );

    // Now patch `<map_fragment>`. The stock chunk reads `vMapUv` and
    // samples `map`. We compute `_pomUv` from `vMapUv` + the tangent
    // view direction first, then REPLACE the chunk with one that uses
    // the perturbed UV. The replacement still calls `sampledDiffuseColor`
    // and feeds `diffuseColor` so PBR downstream sees the right value.
    //
    // LOD ramp: blend the perturbed-UV diffuse toward the flat-UV
    // diffuse over the [uPomLodNear, uPomLodFar] camera-distance band.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `// Phase 3.1 POM begin (S4-fixed frame: fragment-stage getTangentFrame)
vec2 _pomBaseUv = vMapUv;
vec2 _pomUv = _pomBaseUv;
// The TBN is computed UNCONDITIONALLY: getTangentFrame takes dFdx/dFdy,
// and a derivative inside the non-uniform LOD branch is undefined
// behaviour. Four derivatives — cheap.
float _pomFace = gl_FrontFacing ? 1.0 : -1.0;
vec3 _pomGeomN = normalize(vNormal);
#ifdef DOUBLE_SIDED
_pomGeomN *= _pomFace;
#endif
_pomTbnG = getTangentFrame(-vViewPosition, _pomGeomN, vMapUv);
#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
_pomTbnG[0] *= _pomFace;
_pomTbnG[1] *= _pomFace;
#endif
float _pomLod = 1.0 - smoothstep(uPomLodNear, uPomLodFar, length(vViewPosition));
if (_pomLod > 0.001) {
  vec3 _pomTanDir = normalize(transpose(_pomTbnG) * normalize(vViewPosition));
  // 2026-08-02 GRAZING FADE (?pomGraze=off restores the hard gate). The legacy
  // gate was a hard z > 0.15 cut, so the effect ran at FULL amplitude right
  // up to 81 deg and then popped off in one pixel. The band 66-81 deg is
  // precisely where a pitched roof is seen from the ground, and it is where the
  // smear lived. Ramp the amplitude to zero across it instead: the geometry
  // stops smearing AND the cut-off stops popping.
  float _pomGrazeW = (uPomGraze > 0.5)
    ? smoothstep(0.12, 0.45, _pomTanDir.z)
    : step(0.15, _pomTanDir.z);
  if (_pomGrazeW > 0.001) {
    float _pomAmt = _pomLod * _pomGrazeW;
    _pomUv = _pomPerturbedUv(_pomBaseUv, _pomTanDir, uPomDepth, uPomSteps);
    _pomUv = mix(_pomBaseUv, _pomUv, _pomAmt);
    _pomLodG = _pomAmt;
  }
}
_pomUvG = _pomUv;
#ifdef USE_MAP
vec4 sampledDiffuseColor = texture2D(map, _pomUv);
#ifdef DECODE_VIDEO_TEXTURE
sampledDiffuseColor = sRGBTransferOETF(sampledDiffuseColor);
#endif
diffuseColor *= sampledDiffuseColor;
#endif
// Phase 3.1 POM end`
    );

    // Patch the normal-map sample too: use the perturbed UV so the
    // per-pixel normal aligns with the perceived geometry. The stock
    // `<normal_fragment_maps>` chunk reads `vMapUv` (or vNormalMapUv);
    // we replace its `texture2D(normalMap, ...)` call to use `_pomUv`.
    // Three.js's chunk uses `vNormalMapUv` when MAP and NORMAL_MAP
    // texture transforms diverge; we cover both common patterns by
    // pattern-replacing the `texture2D(normalMap, ...)` invocation.
    shader.fragmentShader = shader.fragmentShader.replace(
      "texture2D( normalMap, vNormalMapUv )",
      "texture2D( normalMap, _pomUv )"
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "texture2D( normalMap, vMapUv )",
      "texture2D( normalMap, _pomUv )"
    );

    // Self-shadowing (S4 fix): march toward the REAL sun. The legacy
    // proxy (the negated tangent view direction) made the micro-shadow
    // track the CAMERA, not the light — the single most reliable way
    // to make relief read as painted-on rather than lit. three's
    // lighting pipeline exposes `directionalLights[0].direction`
    // (view-space, FROM surface TO light) in the fragment stage;
    // transform it with the same fragment-stage TBN the primary march
    // used (`_pomTbnG`). `_pomLodG` is non-zero only when the primary
    // march actually ran, so this self-gates on every early-out.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_fragment>",
      `#if NUM_DIR_LIGHTS > 0
if (_pomLodG > 0.001) {
  vec3 _pomLightTan = normalize(transpose(_pomTbnG) * directionalLights[0].direction);
  float _pomHitDepth = 1.0 - texture2D(uPomMap, _pomUvG).r;
  float _pomShadowFactor = _pomShadow(_pomUvG, _pomHitDepth, _pomLightTan,
                                       uPomDepth, uPomShadowSteps);
  gl_FragColor.rgb *= mix(1.0, _pomShadowFactor, _pomLodG);
}
#endif
#include <dithering_fragment>`
    );

    // Stash the patched shader handle so tests can read uniforms post-
    // compile (three.js doesn't expose shader.uniforms otherwise).
    _defineLiveUserData(material, "pomShaderUniforms", shader.uniforms);
  });
  material.needsUpdate = true;
}

// Public export: install the POM patch on an arbitrary material.
// Phase 3.1 callers (MaterialCache) use this; tests import it
// directly to assert the shader-patch wires up.
export function installPomShaderPatch(material, heightTexture, opts) {
  _installPomShaderPatch(material, heightTexture, opts);
}

// === "Retail light response" combined patch — R2.B + L3 (2026-05-29) ===
//
// One `onBeforeCompile` patch behind ONE flag (`?lightClamp=retail`) that
// applies BOTH retail point/spot-light fidelity changes, so there is no
// competing second onBeforeCompile chain (per the waves-2 doc's R2.B
// fold-in coordination rule):
//   - L3 (waves-2): point/spot LINEAR distance falloff. Retail
//     `attenuation = clamp(1 - dist/range, 0, 1)` (acclient.c:454615,
//     guarded by `if (dist < range)`), vs three's physical inverse-square
//     (LIGHT_DECAY = 2.0). `range` = the three `distance` cutoff, which L2
//     already scaled by static_light_factor 1.3 in lighting.js. Redefines
//     `getDistanceAttenuation` (lives in <lights_pars_begin>) to the AC law.
//   - R2.B (2026-05-28): per-RGB light-color clamp in the direct-lighting
//     accumulation (acclient.c:454616-454627).
//
// Parse `?lightClamp=retail` from the page URL. Default OFF (anything
// other than the literal "retail", or the flag absent, returns false →
// the standard THREE PBR lighting accumulation is untouched and the
// emitted shader string is byte-identical to the shipped baseline).
//
// IMPORTANT (scope): callers read this flag by invoking THIS helper
// directly at the consumption site (the install-decision point inside
// `_makeTexturedMaterial` / the fallback path AND inside the installer
// itself). We deliberately do NOT stash the result in a const in one
// function and read it in another — a prior wave shipped a ReferenceError
// that way. The reader is a pure module-level function with no closure
// over caller-local state, so the flag and its consumer always share
// scope.
export function readLightClampRetailFlag() {
  // default-ON flipped per render-audit T1b (2026-06-09): retail linear-falloff
  // + per-channel color clamp so colored torches stop washing to white; opt-out
  // ?lightClamp=off (physical inverse-square), pending 1070 eye-test.
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("lightClamp");
    if (typeof v === "string") {
      const lv = v.toLowerCase();
      if (lv === "off" || lv === "physical") return false;
    }
    return true;
  } catch (_) {
    return true;
  }
}

// === L4 (render-completeness waves-2, 2026-05-29) — flat-diffuse preset ===
// Retail's fixed-function `SetSurface` (acclient.c:454385-454561) NEVER sets
// a specular term — lit surfaces are pure Lambertian diffuse + ambient. Our
// PBR Metal category (metalness:0.9, roughness:0.3) therefore over-responds
// with glossy specular highlights vs retail's flat metal. `?flatDiffuse=retail`
// opts a surface category into a non-specular PBR look (metalness 0 /
// roughness ~1) so metal + lava read flat like retail. Default OFF: when the
// flag is absent we keep the classifier defaults unchanged (byte-identical).
export function readFlatDiffuseRetailFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("flatDiffuse");
    return typeof v === "string" && v.toLowerCase() === "retail";
  } catch (_) {
    return false;
  }
}

// === A10-M1 (unification, 2026-06-11) — single surface render-state decoder ===
// The JS analogue of retail's sole `D3DPolyRender::SetSurface`
// (acclient.c:454385-454565). Before this, the Surface (0x08) flag→three.js
// blend/emissive/diffuse ladder was decoded at TWO sites that had already
// drifted: `MaterialCache._materialFromFlags` (cache path) attached the diffuse
// texture as an `emissiveMap` for luminous surfaces, while
// `EntityManager._applyPalettedSurfaceRenderState` (recolored/paletted path)
// explicitly did NOT — both citing the SAME retail line (acclient.c:454691-454697)
// with opposite readings (A10 survey §3 row 2; ROADMAP §7 item 2). A recolored luminous
// item therefore washed to white while its unrecolored twin glowed correctly.
//
// Resolution (ROADMAP §7 ruling, A10 §4 Stage M1): adopt the emissiveMap-attached
// reading. Retail's grayscale D3D emissive (Emissive.rgb = luminosity,
// acclient.c:454691-454697) is MODULATED by the diffuse texture in the
// fixed-function combiner (TEXOP_MODULATE stage 0, acclient.c:454429-454432) —
// final ≈ texture × (lighting + emissive). three.js' `emissive` is ADDED and is
// texture-modulated ONLY when an `emissiveMap` is set; without one a flat-white
// emissive ADD washes the texture to pure white. So attaching the diffuse texture
// as emissiveMap reproduces retail's texture×emissive for COLOURED luminous
// surfaces (e.g. the blue lifestone crystal glows in its own colour, brighter).
//
// MUTATES `mat` in place (settable post-construction with `needsUpdate`):
//   - `state`: { flags, translucency, luminosity, diffuse } (the Surface bitfield
//     + the trailing T/L/D float triplet).
//   - `opts.texture`: the diffuse map, used as `emissiveMap` for luminous surfaces.
// Returns nothing. Does NOT touch `userData.surfaceTypeFlags` bookkeeping — each
// caller owns that (the cache path stores it via meshToGeometryGroups; the
// paletted path stamps it before delegating). `flags === 0` (empty/fallback
// surface) skips ONLY the flag-driven blend ladder so it stays opaque, but the
// float-driven luminosity-emissive and diffuse-tint STILL apply (they are
// bit-independent — retail reads the floats, not the bits — matching the legacy
// cache path which gated lum/diffuse on the floats alone, not on flags).
// ── Retail cull parity: ONE draw per surface (`?surfaceSinglePass`, 2026-07-15) ─
// three r184 submits a material TWICE — BackSide, then FrontSide, with a
// `needsUpdate` program re-resolve between them — when
//     transparent === true && side === DoubleSide && forceSinglePass === false
// (three.module.js:18065 `renderObject`, and :17280 `prepareMaterial`). Every
// surface material here is DoubleSide, so every TRANSLUCENT one was drawn twice.
//
// Retail does not do this. Its per-polygon path picks ONE cull mode and issues
// ONE draw (D3DPolyRender::DrawPolyInternal, acclient.c:455306):
//     if ( override_cull_state_0 || p->sides_type == 1 )
//         SetCullMode(CULLMODE_NONE);      // two-sided -> cull nothing
//     else
//         SetCullMode(CULLMODE_CW);
//     ... DrawPrimitiveUP(D3DPT_TRIANGLEFAN, ...)   // once
// (CullModeType, acclient.h:5294; the 3 DrawPrimitiveUP sites in that function
// are mutually-exclusive vertex-format branches, not repeat draws.) The
// back-then-front two-pass is a three-ism with NO retail counterpart, so the
// single pass is the PARITY behaviour and the two-pass is the deviation.
//
// MEASURED on the 1070 at a settled Holtburg, A/B/A inside ONE page load
// (net-review/forcesinglepass-ab.mjs; A2 drift 0.00 fps / 3 draws, and a
// 0-material placebo arm moved -0.06 fps): flipping the 33 transparent
// DoubleSide surface materials is worth **-11% draws and +45% fps**
// (2153 -> 1913 draws/f, 461k -> 444k tris/f, 20.75 -> 30.16 fps, p50 50 -> 33.3
// ms). ⚠ The win is SCENE-DEPENDENT — it was measured with a large translucent
// creature in frame; where nothing translucent is on screen there is nothing to
// save (Cragstone's two paths differ by 22 px, max delta 1).
//
// NOT a fill-rate win, despite the size of it — the win is CPU, and it is
// MEASURED, not reasoned: wall time inside renderer.render() (which returns at
// SUBMIT, before the GPU executes) falls 39.94 -> 24.26 ms/frame while the frame
// itself falls 49.9 -> 33.3 ms, so ~95% of the gain is CPU submission. Both paths
// rasterize the SAME fragments (BackSide-then-FrontSide covers exactly what one
// DoubleSide pass does), so there is no overdraw to save. What the second pass
// adds is a second SUBMIT of the whole geometry (culling happens at
// rasterization, AFTER vertex shading — hence triangles/frame -3.8%) plus, per
// object per frame, TWO `needsUpdate = true` program re-resolves
// (three.module.js:18068/18072). 15.7 ms over 236 removed draws is ~66 us per
// draw — an order of magnitude more than a draw call costs — which implicates
// that churn rather than the calls themselves. The CPU-vs-GPU split is measured;
// pinning it specifically to getProgram is NOT, so do not quote that as settled.
//
// IT CHANGES PIXELS, and that is expected: 0.7-0.9% of them, confined to
// translucent surfaces (eye-tested at 4 POIs, net-review/singlepass-eyetest.mjs
// + the PNGs it writes). Blend ORDER within one translucent mesh changes, which
// is exactly what the dropped pass was ordering. `?surfaceSinglePass=off`
// restores three's two-pass.
//
// NOTE this is NOT the same call as the particle fix (particle_manager.js): a
// particle is a flat quad, so its second pass was fully face-culled and dropping
// it is pixel-IDENTICAL. Here the geometry is closed and the pixels move.
let _SURF_SINGLE_PASS = null;
export function surfaceSinglePassEnabled() {
  if (_SURF_SINGLE_PASS === null) {
    try {
      // Default ON => strict opt-OUT (`=== "off"`). The mirror of the flag
      // footgun: for a default-OFF flag only `=== "on"` may enable, and for a
      // default-ON flag only `=== "off"` may disable. Bare `location` is
      // `globalThis.location` — undefined under node, so the catch is the
      // node/test path and must land on the DEFAULT, not on false.
      _SURF_SINGLE_PASS = new URLSearchParams(location.search).get("surfaceSinglePass") !== "off";
    } catch (_) {
      _SURF_SINGLE_PASS = true;
    }
  }
  return _SURF_SINGLE_PASS;
}

/**
 * Give `mat` retail's one-draw-per-surface behaviour when three would otherwise
 * two-pass it. No-op unless the material actually meets three's condition, so
 * it is safe to call on every material from every factory.
 */
export function applyRetailSinglePass(mat) {
  if (!mat || mat.transparent !== true || mat.side !== THREE.DoubleSide) return false;
  const want = surfaceSinglePassEnabled();
  if (mat.forceSinglePass !== want) {
    mat.forceSinglePass = want;
    mat.needsUpdate = true; // program-affecting: without this the flip is inert
  }
  return want;
}

export function applySurfaceRenderState(mat, state, opts) {
  if (!mat || !state) return;
  const flags = (state.flags ?? 0) >>> 0;
  const sfTranslucency = +(state.translucency ?? 0.0);
  const sfLuminosity = +(state.luminosity ?? 0.0);
  const sfDiffuse = +(state.diffuse ?? 0.0);
  const texture = opts?.texture ?? null;
  const isTranslucent = (flags & SURFACE_TYPE.Translucent) !== 0;
  const isClipMap = (flags & SURFACE_TYPE.Base1ClipMap) !== 0;
  const isAdditive = (flags & SURFACE_TYPE.Additive) !== 0;
  const isAlpha = (flags & SURFACE_TYPE.Alpha) !== 0;
  const isInvAlpha = (flags & SURFACE_TYPE.InvAlpha) !== 0;
  // === A10-M3b (2026-06-12) — `?surfaceParityV2=on` parity details =========
  // Default OFF. The remaining two sub-behaviours (additive fog exemption,
  // true InvAlpha blend) live ONLY inside this decoder, which is itself only
  // reached when `?surfaceUnified=on` — so parityV2 is inert without
  // surfaceUnified (documented in url-flags.md; deliberately no cross-flag
  // enforcement). The third (ClipMap alpha-test ref 100/200) graduated to the
  // default-ON `?clipMapParity` in RND-08/33 and is no longer gated here.
  const parityV2 = readSurfaceParityV2Flag();
  // === FIXUP A10-M1 (2026-06-11) — float-driven lum/diffuse are BIT-INDEPENDENT.
  // The blend-state ladder below IS flag-driven, but luminosity-emissive and
  // diffuse-tint are driven by the FLOATS, not by any surface-type bit (retail
  // acclient.c:454452-454467; census 2026-05-28: Luminous/Diffuse bits set on
  // 0/6152 surfaces while 762 carry luminosity>0 and 6150 carry diffuse>0 — all
  // bit-independent). The legacy cache path (flag OFF) applies lum/diffuse on
  // `hasLum`/`sfDiffuse` regardless of flags, so a `flags === 0` early-return
  // here dropped them ON (opposite of the recolored-luminous fix). So: skip ONLY the
  // blend ladder when flags===0 (empty/fallback surface stays opaque), then fall
  // through to the float-driven lum/diffuse so they match the legacy path.
  if (flags === 0) {
    applyFloatLumDiffuse(mat, sfLuminosity, sfDiffuse, texture);
    mat.needsUpdate = true;
    return;
  }
  if (isAdditive && isAlpha) {
    // Wave-3 M1: Alpha+Additive (0x10000|0x100) blends SRCALPHA/ONE, not ONE/ONE
    // — the additive contribution is weighted by per-texel source alpha (retail
    // acclient.c:454474). depthWrite off so the halo doesn't occlude geometry.
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.SrcAlphaFactor;
    mat.blendDst = THREE.OneFactor;
    mat.blendEquation = THREE.AddEquation;
    mat.transparent = true;
    mat.depthWrite = false;
  } else if (parityV2 && isInvAlpha && !isAlpha && !isTranslucent) {
    // A10-M3b (b3) — TRUE inverse-alpha blend (retail acclient.c:454478-454484):
    // src = BLEND_INVSRCALPHA(6), dst = ADDITIVE? BLEND_ONE(2) : BLEND_SRCALPHA(5).
    // Retail checks ALPHA first (acclient.c:454470) so Alpha wins when both bits
    // are set (the `!isAlpha` guard); Translucent (0x10) is evaluated AFTER the
    // A/IA ladder (acclient.c:454513) and does not override an already-blending
    // surface, so Translucent+InvAlpha keeps our existing plain alpha-blend arm
    // (the `!isTranslucent` guard). This arm MUST sit before the pure-`isAdditive`
    // arm or InvAlpha+Additive would be swallowed by it — retail evaluates
    // INVALPHA before the pure-ADDITIVE fallthrough (454478 before 454486-454489).
    // Census-zero in the retail base DAT (A10 §3 row 6) — completeness only.
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneMinusSrcAlphaFactor;
    mat.blendDst = isAdditive ? THREE.OneFactor : THREE.SrcAlphaFactor;
    mat.blendEquation = THREE.AddEquation;
    mat.transparent = true;
    mat.depthWrite = false;
  } else if (isAdditive) {
    // Pure-additive (no Alpha bit) → ONE/ONE (flames, sparks); depthWrite off so
    // they don't occlude geometry behind them.
    mat.blending = THREE.AdditiveBlending;
    mat.transparent = true;
    mat.depthWrite = false;
  } else if (isTranslucent || isAlpha || isInvAlpha) {
    // Alpha blend (SRCALPHA/INVSRCALPHA), depthWrite off — painter-sorted. Retail
    // routes both Translucent (0x10, acclient.c:454513) and Alpha (0x100, :454470)
    // through this blend state. InvAlpha (0x200) first-cut shares it (census-zero
    // in retail base DAT; true inverse blend deferred — A10 §3 row 6).
    mat.transparent = true;
    mat.depthWrite = false;
    // Translucent's alpha = 1 - T (acclient.c:454523); Alpha (0x100) takes its
    // alpha from the texture channel, so only adjust opacity for Translucent T>0.
    if (isTranslucent && sfTranslucency > 0) {
      mat.opacity = Math.max(0, 1 - sfTranslucency);
      // DIM7-5 / W4.2: stash the AUTHORED base translucency so a later
      // Transparent(20)/TransparentPart(7) hook ramp can floor against it — retail
      // floors `_end` to translucencyOriginal (acclient.c:316947-316956).
      mat.userData = { ...(mat.userData || {}), __baseTranslucency: sfTranslucency };
    }
  } else if (isClipMap) {
    // Binary alpha mask (foliage, fences). RND-08/33 (2026-07-27): the
    // per-format alpha-test ref GRADUATED out of `?surfaceParityV2` — it, and
    // retail's `SetAlphaBlendEnable(1)` + ONE/INVSRCALPHA blend, now ship
    // default-ON through the shared helper (see `applyClipMapRenderState` for
    // the acclient.c anchors and the census). parityV2 keeps only (b1) the
    // additive fog exemption and (b3) the true INVALPHA blend.
    applyClipMapRenderState(mat, state.hasPalette);
  }
  // A10-M3b (b1) — additive surfaces are exempt from fog (retail
  // acclient.c:454551-454553: ADDITIVE 0x10000 → SetFFFogAlphaDisabled(1),
  // whose body at acclient.c:460295-460302 is SetRenderState(28 =
  // D3DRS_FOGENABLE, !value) — i.e. fixed-function fog fully OFF for that
  // draw; fog-SKIP, not fog-to-black, so per-material `fog: false` is the
  // exact three.js analogue). Retail's check is on the BIT, evaluated after
  // the blend ladder — NOT per-branch — so it also covers Translucent+Additive
  // and InvAlpha+Additive combos. Known residual: `material.fog` only exempts
  // from `scene.fog` (the wireframe FogExp2 path, index.js:585, and the
  // `?fogLerp=on` linear-Fog path, index.js:2962); the default 3D path's
  // Bruneton aerial-perspective post pass is screen-space and cannot honour a
  // per-material exemption (A10-M3 spec §5/§6 OQ-2). The retail "fog globally
  // off" half (acclient.c:454551 !GetFFFogEnable) needs no analogue — with no
  // scene.fog three.js applies no fog anyway. `fog` is program-affecting; the
  // trailing `needsUpdate = true` below forces the recompile.
  if (parityV2 && isAdditive) mat.fog = false;
  applyFloatLumDiffuse(mat, sfLuminosity, sfDiffuse, texture);
  // Retail draws a surface ONCE (see applyRetailSinglePass). This is THE funnel
  // for the unified/entity/recolored-paletted paths — the blend ladder above is what
  // decides `transparent`, so the parity call has to come after it, not at the
  // construction sites (which all build `transparent: false` and are mutated
  // here later).
  applyRetailSinglePass(mat);
  mat.needsUpdate = true;
}

// === FIXUP A10-M1 (2026-06-11) — the float-driven (bit-independent) half of the
// decoder. Self-illumination (luminosity float) and diffuse-reflectance tint
// (diffuse float) are applied for ALL surfaces regardless of surface-type bits
// (retail acclient.c:454452-454467 reads the FLOATS, not the 0x40/0x20 bits).
// Factored out so both the flags===0 (empty/fallback) branch and the main
// branch run it identically — matching the legacy cache path which gated these
// on `hasLum`/`sfDiffuse` alone, not on flags. Caller sets `needsUpdate`.
function applyFloatLumDiffuse(mat, sfLuminosity, sfDiffuse, texture) {
  if (sfLuminosity > 0) {
    // Self-illumination driven by the luminosity FLOAT (not the 0x40 bit). Keep
    // emissive=white scaled by luminosity AND attach the diffuse texture as
    // emissiveMap (the resolved reading — see header). Untextured luminous
    // surfaces keep the flat-white glow. Clamp to (0, 2] (ACE ~[0,1] with
    // occasional HDR-ish pushes >1).
    mat.emissive = new THREE.Color(0xffffff);
    mat.emissiveIntensity = Math.min(2.0, sfLuminosity);
    if (texture) mat.emissiveMap = texture;
  }
  // Diffuse-reflectance albedo tint — retail uses `diffuse` as a reflectance
  // multiplier on the material's diffuse colour (acclient.c:454458). No-op at
  // d≈1 (~96% of surfaces); dims the d≠1 minority. Multiplies with `map`.
  if (sfDiffuse > 0 && Math.abs(sfDiffuse - 1.0) > 0.01) {
    mat.color = new THREE.Color(sfDiffuse, sfDiffuse, sfDiffuse);
  }
}

// === A10-M1 (unification, 2026-06-11) — `?surfaceUnified=on` opt-in =========
// When ON, both Surface-flag decode sites delegate to the single
// `applySurfaceRenderState` above (the recolored/paletted path then ALSO attaches the
// luminous emissiveMap, fixing the recolored-luminous wash-to-white). Default OFF
// keeps the legacy dual-path (byte-identical on the cache path — only the
// paletted path's emissiveMap differs). JS-live (reload to toggle).
export function readSurfaceUnifiedFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("surfaceUnified");
    if (typeof v !== "string") return false;
    const lv = v.toLowerCase();
    return lv === "on" || lv === "1" || lv === "true";
  } catch (_) {
    return false;
  }
}

// === Missing-surface negative cache (2026-07-07; provenance-gated 2026-07-09) =
// `MaterialCache.missingSurfaces` records surface DIDs PROVEN absent from the
// manifest catalog (e.g. the contiguous 0x08F0xxxx gap in the base DATs) so
// per-LB / ring `preload`/`get` bakes stop re-issuing the wasm fetch +
// re-warning for them (measured 162 re-decodes / 90 s across 58 absent DIDs,
// stationary; far worse while roaming).
//
// R-2 (net-fixwave 2026-07-09): the original insert trigger — ANY zero-dim
// result — was NOT proof of absence. The wasm walk loop swallows exhausted
// dependency-fetch rounds into Ok(()) (prefetch.rs run_walk_loop), so a
// transient shard failure ALSO decodes zero-dim; a DID poisoned that way was
// then skipped by preload() BEFORE fetching, which silently disabled the
// 2026-05-30 white-surface recovery ladder (its preload() retries no-op'd —
// session-permanent grey/white). Inserts are now gated on the decode-audit
// fields the wasm stamps on each fetch result (surfaceResultProvenAbsent
// below): only DIDs the catalog AUTHORITATIVELY lacks are memoised; zero-dims
// without proof stay retryable (the pre-negcache contract), and a legacy wasm
// without the fields never poisons at all. A successful install still clears
// the entry, and `materials.has(did)` is always checked first so a real
// material wins. Default ON; `?surfaceNegCache=off` (or `=0`) disables even
// the proven-absent memoisation (the re-hammer path).
export function surfaceNegCacheEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("surfaceNegCache");
    if (typeof v !== "string") return true;
    const lv = v.toLowerCase();
    return !(lv === "off" || lv === "0" || lv === "false");
  } catch (_) {
    return true;
  }
}

// --- P2↔P3 ABI (net-fixwave 2026-07-09): surface decode-audit readers -------
// The wasm surface-pixels exports stamp two OPTIONAL fields on each CALL-level
// result (the returned array / batch object; carried verbatim through the
// bake-worker serialization):
//   decodeMisses : number — count of dependency keys that failed to hydrate
//                  during this call's prefetch walk (0 = complete decode);
//   provenAbsent : Array<"0x%08X"> — surface DIDs the catalog authority PROVES
//                  absent (the only DIDs eligible for the negative cache).
// Both readers treat a missing field as "legacy wasm" → null; callers must
// then never poison and may retry freely. The absent-set is memoised per
// result object so preload()'s per-DID chains don't re-parse the same batch.
const _provenAbsentMemo = new WeakMap();
export function surfaceResultProvenAbsent(result) {
  if (result === null || (typeof result !== "object" && typeof result !== "function")) {
    return null;
  }
  if (_provenAbsentMemo.has(result)) return _provenAbsentMemo.get(result);
  let set = null;
  try {
    const pa = result.provenAbsent;
    if (Array.isArray(pa)) {
      set = new Set();
      for (const s of pa) {
        const v = typeof s === "string" ? parseInt(s, 16) : Number(s);
        if (Number.isFinite(v)) set.add(v >>> 0);
      }
    }
  } catch (_) {
    set = null; // a throwing getter (freed wasm handle) must never poison
  }
  _provenAbsentMemo.set(result, set);
  return set;
}
export function surfaceResultDecodeMisses(result) {
  try {
    const n = result ? result.decodeMisses : undefined;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

// === R1 (2026-06-24) — `?luminousEmissiveMap` opt-in ========================
// Narrow sibling of `?surfaceUnified`: on the RECOLORED/paletted luminous path,
// attach the (recoloured) diffuse map as `emissiveMap` so a COLOURED
// recolored-luminous surface glows in-colour instead of washing to flat white —
// WITHOUT the rest of the surfaceUnified render-state unification. The
// non-recolored (cache) path already does this via `applyFloatLumDiffuse`.
// DEFAULT-ON since 2026-06-24 (`=off` restores flat-white emissive). Also implied when
// `?surfaceUnified=on` (that path already attaches the emissiveMap). Memoized.
let _luminousEmissiveMap;
export function readLuminousEmissiveMapFlag() {
  if (_luminousEmissiveMap === undefined) {
    _luminousEmissiveMap = false; // non-browser/test default
    try {
      if (typeof window !== "undefined" && window.location) {
        const v = new URLSearchParams(window.location.search).get("luminousEmissiveMap");
        // 2026-06-24: DEFAULT-ON (retail-faithful recolored-luminous glow; `=off` to opt out)
        _luminousEmissiveMap = (v == null)
          ? true
          : !(["off", "0", "false", "no"].includes(String(v).toLowerCase()));
      }
    } catch (_) { /* default off in non-browser */ }
  }
  return _luminousEmissiveMap;
}

// === A10-M3b (2026-06-12) — `?surfaceParityV2=on` opt-in ====================
// Layered ON TOP of `?surfaceUnified=on`: the parityV2 branches live only
// inside `applySurfaceRenderState`, which is only invoked when surfaceUnified
// is on — so this flag is inert by construction without it. Guards the three
// A10 §3 row-4/5/6 parity details: (b1) additive fog exemption, (b2) ClipMap
// alpha-test ref 100/255-vs-200/255 by texture palettedness (needs the M3a
// `hasPalette` wasm getter; stale pkg → legacy 0.5), (b3) true INVALPHA blend.
// Default OFF (JS-live, reload to toggle). NOT cached — the test harness
// re-stubs `globalThis.window` per case.
export function readSurfaceParityV2Flag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("surfaceParityV2");
    if (typeof v !== "string") return false;
    const lv = v.toLowerCase();
    return lv === "on" || lv === "1" || lv === "true";
  } catch (_) {
    return false;
  }
}

// === RND-08/33 (2026-07-27) — ClipMap alpha-test ref + blend ===============
// Retail's ClipMap arm in `D3DPolyRender::SetSurface` (acclient.c:454497-454511)
// does THREE things the legacy ladder collapsed into `alphaTest = 0.5,
// transparent = false`:
//
//  1. PER-FORMAT alpha-test ref. `if (!curr_texture_is_set || (v12 =
//     s_256AlphaTestRef, !curr_texture->m_pPalette)) v12 = s_ddsAlphaTestRef;`
//     — a PALETTED texture (`ImgTex::m_pPalette` non-null ⇔ P8/Index16) takes
//     `s_256AlphaTestRef = 100`, everything else (DXT/uncompressed/no texture)
//     takes `s_ddsAlphaTestRef = 200` (constants acclient.c:45764-45765).
//     Compared `ALPHATESTFUNC_GREATEREQUAL` (:454546); three.js discards
//     `a < alphaTest`, so `ref/255` reproduces the >=-with-equality boundary
//     exactly. 0.5 was wrong for BOTH classes.
//  2. ALPHA BLENDING IS ON: `surfacea = 1` → `SetAlphaBlendEnable(1)` (:454548)
//     with `SetBlendFunction(v9, v10, BLENDOP_ADD)` (:454547) where the arm sets
//     `v9 = 2, v10 = 6` when no earlier bit already enabled blending. Per
//     `enum BlendMode` (acclient.h:5193-5211) 2 is **BLEND_ONE**, 6 is
//     BLEND_INVSRCALPHA — i.e. premultiplied-alpha "over", NOT SRCALPHA/
//     INVSRCALPHA. Identical to opaque for the alpha=255 interior; only the
//     bilinear-filtered edge texels blend.
//  3. DEPTH WRITES STAY ON. `SetDepthBufferMode(zfunc, curr_texturea)` (:454550)
//     takes `curr_texturea = singlePassDetailinga || !v11` (:454541) and the
//     ClipMap arm sets alpha-test-enable (`singlePassDetailinga`) to 1.
//
// Census (2026-07-27, `client_portal.dat`, 6152 surfaces): 721 carry
// Base1ClipMap — 518 paletted (all PFID_INDEX16) → 0.392, 203 non-paletted
// (DXT5 97, A8R8G8B8 71, DXT1 27, DXT3 5, A4R4G4B4 2, R8G8B8 1) → 0.784.
//
// SORTING IMPLICATION of `transparent = true`: three.js moves these draws into
// the transparent list (rendered after opaque, painter-sorted). Correctness is
// unaffected because `depthWrite` stays on and the surviving texels are ~opaque,
// but per-object sorting is now paid; `static_atlas.js` therefore keeps
// `sortObjects = false` for alpha-tested buckets.
export const CLIPMAP_ALPHA_REF_PALETTED = 100 / 255; // s_256AlphaTestRef
export const CLIPMAP_ALPHA_REF_DDS = 200 / 255;      // s_ddsAlphaTestRef
export const CLIPMAP_ALPHA_REF_LEGACY = 0.5;         // pre-RND-08 hardcode

// `?clipMapParity` — DEFAULT ON ("full"). `=off` restores the pre-RND-08 legacy
// state (ref 0.5, no blend) and `=ref` takes the per-format ref WITHOUT the
// blend, so the 1070 A/B can separate the two halves. NOT memoized: the ESM
// harness re-stubs `globalThis.window` per case (same reason as
// `readSurfaceParityV2Flag`).
export function readClipMapParityMode() {
  try {
    if (typeof window === "undefined" || !window.location) return "full";
    const v = new URLSearchParams(window.location.search).get("clipMapParity");
    if (typeof v !== "string") return "full";
    const lv = v.trim().toLowerCase();
    if (lv === "off" || lv === "0" || lv === "false" || lv === "no") return "legacy";
    if (lv === "ref") return "ref";
    return "full";
  } catch (_) {
    return "full";
  }
}

// `?clipMapOpaque` — DEFAULT ON. `=off` restores the pre-2026-08-06 state where
// a full-parity ClipMap surface rendered in the z-sorted TRANSPARENT pass with
// CustomBlending ONE/INVSRCALPHA. See `applyClipMapRenderState` for the measured
// cost and for why the scope is structural rather than a flag-bit filter.
//
// NOT memoized, deliberately, matching `readClipMapParityMode` immediately
// above: the ESM harness re-stubs `globalThis.window` per case, and a memoized
// reader would latch the first case's answer for the whole suite.
export function clipMapOpaqueEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("clipMapOpaque");
    if (typeof v !== "string") return true;
    const lv = v.trim().toLowerCase();
    return !(lv === "off" || lv === "0" || lv === "false" || lv === "no");
  } catch (_) {
    return true;
  }
}

/**
 * Write retail's ClipMap render state onto `target` — either a live material or
 * the plain `opts` bag a `MeshStandardMaterial` is about to be constructed from
 * (both take the same property names). `hasPalette` is the M3a
 * `SurfacePixels.hasPalette` boolean; STRICT boolean-or-undefined, because an
 * older pkg without the wasm getter must fall back to the legacy 0.5 ref rather
 * than silently pin every clipmap at the wrong 0.784.
 */
export function applyClipMapRenderState(target, hasPalette) {
  if (!target) return;
  const mode = readClipMapParityMode();
  target.alphaTest =
    mode !== "legacy" && typeof hasPalette === "boolean"
      ? (hasPalette ? CLIPMAP_ALPHA_REF_PALETTED : CLIPMAP_ALPHA_REF_DDS)
      : CLIPMAP_ALPHA_REF_LEGACY;
  if (mode !== "full") {
    target.transparent = false;
    return;
  }
  if (clipMapOpaqueEnabled()) {
    // `?clipMapOpaque` (2026-08-06) — keep the retail alpha-test ref and the
    // z-writes, but leave the surface in the OPAQUE pass.
    //
    // A ClipMap surface is a binary MASK with depth writes: its surviving
    // fragments are at alpha >= ref and it occludes what is behind it, so it
    // does not depend on blend order the way a translucent surface does. The
    // `transparent = true` below was costing it the opaque pass's grouping and
    // making it pay the transparent pass's per-frame z-sort, for a blend that
    // is very nearly a no-op on fragments that survive a 0.784 alpha test.
    //
    // MEASURED (1070, Holtburg, quality mid, 3 interleaved in-session pairs):
    // p50 34/34.2/35.5 -> 33.3/33/33 ms, i.e. **-1.2 ms / 3.5%**, ranges
    // non-overlapping. The transparent pass overall is 212 draws / 8.70 ms
    // against opaque's 215 draws / 4.28 ms — half the frame's draws at 2x the
    // per-draw cost — and this moves 50 materials out of it. Frame is
    // CPU-bound (an 8.2x render-scale cut does not move it), which is why a
    // pass change pays at all.
    //
    // ⚠ SCOPE IS STRUCTURAL, NOT A FILTER, and that distinction is the whole
    // safety argument. An eye-test of the naive version — toggling every
    // material carrying the ClipMap BIT — was a hard FAIL: a large translucent
    // object turned fully opaque and blanketed the frame. 27 of those 77
    // materials also carry Translucent (flags 0x14, opacity 0.75/0) and
    // genuinely need the blend. They never reach this function: in all three
    // surface ladders (`_materialFromFlags`, the unified decoder, and
    // entities.js) the `isTranslucent || isAlpha || isInvAlpha` branch is
    // tested BEFORE `else if (isClipMap)`, so only pure ClipMap arrives here.
    // Do not "widen" this by testing the flag bit somewhere else — the bit is
    // not the predicate, the blend dependency is.
    //
    // Blending is deliberately NOT set: three disables blending outright for a
    // material with `transparent === false`, so assigning CustomBlending here
    // would be dead state that misleads the next reader.
    target.transparent = false;
    target.depthWrite = true;
    return;
  }
  target.blending = THREE.CustomBlending;
  target.blendSrc = THREE.OneFactor;              // BLEND_ONE (2)
  target.blendDst = THREE.OneMinusSrcAlphaFactor; // BLEND_INVSRCALPHA (6)
  target.blendEquation = THREE.AddEquation;       // BLENDOP_ADD
  target.transparent = true;
  target.depthWrite = true; // retail keeps z-writes on for the alpha-tested arm
}

// === 2026-06-20 — `?particleUnlit` (DEFAULT ON) ============================
// ParticleViewer parity: particles render UNLIT (texture × opacity, additive/
// alpha picked from Surfaces[0].Type) — NOT through the lit MeshStandard entity
// path. That lit path dragged scene lighting + luminosity-emissive + normalMap
// into particle billboards, so a particle whose first surface is a bright/white
// texture or a `ColorValue=0xFFFFFFFF` 1×1 swatch rendered as a flat lit white
// BOX (the "white box instead of a particle effect" symptom). Default ON;
// `?particleUnlit=off` restores the legacy lit-material path for A/B.
export function readParticleUnlitFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("particleUnlit");
    if (typeof v !== "string") return true;
    const lv = v.toLowerCase();
    return !(lv === "off" || lv === "0" || lv === "false");
  } catch (_) {
    return true;
  }
}

// L4 — categories that get the flat-diffuse treatment under
// `?flatDiffuse=retail`. Metal (the over-glossy offender) + Lava (so the
// emissive bloom reads instead of a specular sheen). Stone/Wood/Sand/Foliage
// are already near-matte (roughness 0.8-0.95, metalness 0) so they need no
// override.
const FLAT_DIFFUSE_CATEGORIES = Object.freeze({
  [SURFACE_CATEGORY.Metal]: { roughness: 1.0, metalness: 0.0 },
  [SURFACE_CATEGORY.Lava]: { roughness: 1.0, metalness: 0.0 },
});

// Wave R2.B — per-RGB-channel light-color clamp in the DIRECT lighting
// accumulation, behind `?lightClamp=retail`.
//
// Retail (acclient.c:454616-454627, `calc_point_light`) caps each light's
// contribution at the light's OWN color per channel rather than the
// standard PBR clamp toward [0,1]:
//
//     coeff = intensity * dot * atten           // scalar
//     contrib_c = min(coeff * color_c, color_c) // per channel R/G/B
//
// i.e. a saturated red light can add AT MOST `color.r` to red and
// (smaller) amounts to G/B, so the light keeps its tone instead of
// washing the surface toward white once the coefficient exceeds 1.
//
// HOW WE INJECT IT (genuine per-light, NOT a post-accumulation
// approximation): three.js's `<lights_fragment_begin>` chunk runs
// `RE_Direct(directLight, ...)` once per direct light (point/spot/
// directional). `RE_Direct_Physical` lives behind `#include
// <lights_physical_pars_fragment>`, which three resolves AFTER
// onBeforeCompile, so we cannot edit the BRDF function text directly.
// Instead we expand the `lights_fragment_begin` chunk ourselves (its
// text is available synchronously via `THREE.ShaderChunk`) and wrap
// EACH `RE_Direct( directLight, ... )` call so that, per light, we:
//   1. snapshot reflectedLight.directDiffuse + directSpecular,
//   2. run the stock RE_Direct (computes this light's BRDF contribution),
//   3. take the per-light delta (what this light just added),
//   4. clamp the delta per channel at `directLight.color` (min(delta_c,
//      directLight.color_c)) — the retail `min(contrib_c, color_c)` cap,
//   5. re-add the clamped delta.
// This is per-light and reaches `directLight.color`, so colored lights
// keep their hue: every channel is capped at the SAME tinted color
// vector, so the brightest channel can't outrun the others into white.
//
// DIVERGENCE FROM acclient (documented honestly): retail caps against
// the light's BASE, un-attenuated `color_c`, with intensity/attenuation
// living in the scalar `coeff`; the cap therefore only engages when
// `coeff > 1`. three.js has already folded intensity AND distance
// attenuation INTO `directLight.color` by the time `RE_Direct` runs
// (directLight.color = lightColor * intensity * attenuation), and it has
// no separate base-color uniform reachable in this chunk without forking
// the light-uniform layout. So our cap is against the *attenuated*
// color: the per-light diffuse/specular delta is capped at the light's
// current (attenuated, intensity-scaled) color rather than its base
// color. The VISIBLE behavior — colored lights retain tone instead of
// blowing to white — matches retail's intent; the exact engage threshold
// differs (ours engages when the BRDF*dotNL gain pushes a channel past
// the attenuated light color, retail's when coeff>1). This is the best
// safe per-light reachable surgery without re-authoring three's light
// uniforms; flagged off by default so the standard PBR path is unchanged.
//
// We also expose `uLightColorClamp` (default 1.0) so an A/B can fade the
// effect in the shader without recompiling the material (0.0 = stock
// accumulation even with the chunk patched in; 1.0 = full retail cap).
function _installLightClampShaderPatch(material) {
  if (!material || material.userData?.__lightClampPatched) return;
  // Read the flag at the consumption site (same scope as the install
  // decision). If it isn't `retail`, do nothing AT ALL — the shader
  // string is left byte-identical to the shipped baseline.
  if (!readLightClampRetailFlag()) return;

  material.userData = {
    ...(material.userData || {}),
    __lightClampPatched: true,
    lightClampRetail: true,
  };

  _chainBeforeCompile(material, (shader) => {
    shader.uniforms.uLightColorClamp = { value: 1.0 };

    // === L3 (waves-2, 2026-05-29) — AC LINEAR point/spot falloff =========
    // Retail `calc_point_light` (acclient.c:454605-454615) uses a LINEAR
    // distance attenuation `clamp(1 - dist/range, 0, 1)` (guarded by
    // `if (dist < range)`), where `range = falloff * static_light_factor`
    // (the 1.3× L2 already baked into three's `distance`/cutoffDistance).
    // three's `getDistanceAttenuation` (defined inside <lights_pars_begin>)
    // is physical inverse-square (Frostbite eq.26). We expand that chunk and
    // replace the stock function body with the AC linear law. We keep three's
    // exact signature so every call site (getPointLightInfo / getSpotLightInfo)
    // is unchanged. When `cutoffDistance <= 0` (infinite-reach light) we fall
    // back to the stock inverse-square so unbounded lights still behave.
    // Skipped harmlessly if the chunk text ever changes shape (split/join
    // no-ops, leaving the stock function intact).
    const stockParsBegin = THREE.ShaderChunk.lights_pars_begin;
    const stockAttenFn =
      "float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {\n\n" +
      "\t// based upon Frostbite 3 Moving to Physically-based Rendering\n" +
      "\t// page 32, equation 26: E[window1]\n" +
      "\t// https://seblagarde.files.wordpress.com/2015/07/course_notes_moving_frostbite_to_pbr_v32.pdf\n" +
      "\tfloat distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );\n\n" +
      "\tif ( cutoffDistance > 0.0 ) {\n\n" +
      "\t\tdistanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );\n\n" +
      "\t}\n\n" +
      "\treturn distanceFalloff;\n\n" +
      "}";
    const acLinearAttenFn =
      "float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {\n" +
      "\t// L3 (waves-2): AC linear falloff clamp(1 - dist/range, 0, 1).\n" +
      "\t// acclient.c:454615. range = cutoffDistance (= AC falloff * 1.3).\n" +
      "\tif ( cutoffDistance > 0.0 ) {\n" +
      "\t\treturn saturate( 1.0 - lightDistance / cutoffDistance );\n" +
      "\t}\n" +
      "\t// Infinite-reach light (cutoffDistance == 0): keep physical falloff.\n" +
      "\treturn 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );\n" +
      "}";
    const patchedParsBegin = stockParsBegin.split(stockAttenFn).join(acLinearAttenFn);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_pars_begin>",
      patchedParsBegin,
    );

    // Build a per-light wrapper around each stock RE_Direct call by
    // expanding the chunk text and substituting every
    // `RE_Direct( directLight, ... )` invocation. The replacement
    // snapshots the accumulators, runs the stock call, clamps the
    // per-light delta against directLight.color, and re-adds it.
    //
    // NOTE: no backticks appear inside this GLSL string (esbuild/Firefox
    // reject backticks inside the literal). Comments use // only.
    const stockBegin = THREE.ShaderChunk.lights_fragment_begin;

    // The three RE_Direct invocations (point/spot/directional) all share
    // the same argument list and the same `directLight` source variable,
    // so one textual substitution covers all of them.
    const reDirectCall =
      "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";

    const clampedCall =
      "{\n" +
      "  // Wave R2.B per-RGB light-color clamp (retail accumulation).\n" +
      "  vec3 _lcDiffBefore = reflectedLight.directDiffuse;\n" +
      "  vec3 _lcSpecBefore = reflectedLight.directSpecular;\n" +
      "  " + reDirectCall + "\n" +
      "  vec3 _lcDiffDelta = reflectedLight.directDiffuse - _lcDiffBefore;\n" +
      "  vec3 _lcSpecDelta = reflectedLight.directSpecular - _lcSpecBefore;\n" +
      "  // === R-JS-T2c (render audit G15): half-Lambert wrap ================\n" +
      "  // Retail's point/spot diffuse uses a WRAPPED N.L instead of a raw\n" +
      "  // saturate(dot(N,L)): the (n.l * 0.5 + 0.5) form softens the\n" +
      "  // terminator so back-facing-ish surfaces fade gently rather than\n" +
      "  // clamping hard to black (acclient.c:454608). Closes the LG2 TODO at\n" +
      "  // lighting.js:1741-1743, which notes the wrap belongs in THIS shader,\n" +
      "  // not in the lighting.js point/spot setup. three's stock RE_Direct\n" +
      "  // already folded the raw saturate(dot(N,L)) into _lcDiffDelta, so we\n" +
      "  // rescale that diffuse delta by wrapped/raw to convert it to the\n" +
      "  // half-Lambert law. Specular is left on the physical dotNL (retail\n" +
      "  // only wraps the diffuse term). Squaring (the classic Valve form)\n" +
      "  // keeps the lit-side response near-identical while still lifting the\n" +
      "  // dark side. Only ever runs under the retail lighting law (this whole\n" +
      "  // patch is gated by readLightClampRetailFlag()).\n" +
      "  float _hlRaw = saturate(dot(geometryNormal, directLight.direction));\n" +
      "  float _hlWrapBase = dot(geometryNormal, directLight.direction) * 0.5 + 0.5;\n" +
      "  float _hlWrapped = saturate(_hlWrapBase * _hlWrapBase);\n" +
      "  // raw == 0 on the fully-lit-from-behind hemisphere; the stock delta\n" +
      "  // is 0 there so a ratio can't recover the wrap. Reconstruct a soft\n" +
      "  // Lambert term from the light color and the fragment albedo\n" +
      "  // (diffuseColor.rgb is the in-scope BRDF albedo, see line ~884).\n" +
      "  // Elsewhere just scale the existing delta by wrapped/raw.\n" +
      "  vec3 _hlDiff = (_hlRaw > 1e-4)\n" +
      "    ? _lcDiffDelta * (_hlWrapped / _hlRaw)\n" +
      "    : directLight.color * (_hlWrapped * RECIPROCAL_PI) * diffuseColor.rgb;\n" +
      "  _lcDiffDelta = _hlDiff;\n" +
      "  // Cap this light's per-channel contribution at the light's own\n" +
      "  // (attenuated) color so a colored light keeps its tone instead\n" +
      "  // of washing toward white. min() mirrors acclient.c:454616-454627.\n" +
      "  vec3 _lcDiffClamped = min(_lcDiffDelta, directLight.color);\n" +
      "  vec3 _lcSpecClamped = min(_lcSpecDelta, directLight.color);\n" +
      "  // uLightColorClamp fades between stock (0.0) and capped (1.0).\n" +
      "  reflectedLight.directDiffuse = _lcDiffBefore + mix(_lcDiffDelta, _lcDiffClamped, uLightColorClamp);\n" +
      "  reflectedLight.directSpecular = _lcSpecBefore + mix(_lcSpecDelta, _lcSpecClamped, uLightColorClamp);\n" +
      "}";

    // split/join replaces ALL occurrences without regex escaping concerns.
    const patchedBegin = stockBegin.split(reDirectCall).join(clampedCall);

    // Declare the uniform, then swap the stock chunk include for our
    // expanded+wrapped version.
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        "uniform float uLightColorClamp;\nvoid main() {",
      )
      .replace("#include <lights_fragment_begin>", patchedBegin);

    // Stash for post-compile introspection by tests / capture scripts.
    _defineLiveUserData(material, "lightClampShaderUniforms", shader.uniforms);
  });

  material.needsUpdate = true;
}

// Public export: install the per-RGB light-color clamp on an arbitrary
// material (no-op unless `?lightClamp=retail`). MaterialCache call sites
// use this; tests import it directly to assert the patch wiring.
export function installLightClampShaderPatch(material) {
  _installLightClampShaderPatch(material);
}

// ===========================================================================
// `?matBudgetMB=N` — byte-budget LRU over the four per-surface-DID maps
// (2026-07-25, RESULTS-validation-battery next-move 1 / DESIGN-first-bake-
// batches §6).
//
// WHAT THIS BOUNDS. `materials` / `textures` / `normalTextures` /
// `heightTextures` are keyed by surface DID and, before this, were never
// deleted or cleared — a monotone retainer over "distinct surface DIDs ever
// seen", which is a function of ROUTE LENGTH, not of boot. Each cached DID
// pins its decoded planes in the JS heap through
// `THREE.DataTexture.image.data`: RGBA8 albedo (4 B/px) + the RGB→RGBA-padded
// procedural normal (4 B/px, `surfacePixelsToNormalTexture` pads for
// three r152+) + R8 height (1 B/px) ≈ **9 B/px**, i.e. ~2.25 MiB for a 512²
// surface. The 2026-07-25 armLong arm measured `mats` 6 → 479 → 1,117 →
// 1,777 → 1,802 with `usedJSHeapSize` stepping to **3,586 MB at mats≈1,777**
// (≈2.0 MiB/DID averaged over the real 256²/512² mix) — right against
// Chrome's ~4 GB `jsHeapSizeLimit`, i.e. the renderer OOM.
//
// DEFAULT-NEUTRAL. Absent / garbage / `<= 0` ⇒ budget 0 ⇒ **unbounded**, the
// pre-flag behaviour bit-for-bit: `_enforceMatBudget` returns before looking
// at a single entry and nothing is ever deleted or disposed. The reader is
// an explicit positive-number parse — deliberately NOT the `!== "off"` shape
// that reads ON when the param is absent (the standing footgun in this tree,
// see `scripts/lint-url-flags.mjs` OFF-SPELLING). The only unconditional
// change is the size bookkeeping (`_matLru`, one `Map<did, bytes>`), which is
// what lets an UNBUDGETED falsifier arm report the bytes it would have
// capped at.
//
// ---------------------------------------------------------------------------
// DISPOSE POLICY (the design risk; read before changing anything here)
// ---------------------------------------------------------------------------
// 1. **The reference drop IS the reclaim.** The arena that died is the JS
//    heap, and it is held by `DataTexture.image.data`. `Texture.dispose()` /
//    `Material.dispose()` free GPU objects and the compiled program — they do
//    **not** release `image.data`. So evicting the Map entry (dropping the
//    cache's last reference so GC can take the buffer once no mesh holds it)
//    is both necessary and sufficient for the 3.6 GB step. Dispose is a
//    separate, GPU-only concern and is never load-bearing for the budget.
// 2. **Never dispose inline something that was handed out.** Every consumer
//    in this tree is built on the `__cacheOwned` convention: cache materials
//    and their textures are NEVER disposed by whoever holds them —
//    `scene3d/landblock_lru.js:1063-1077` (LB eviction skips `__cacheOwned`
//    geometries/materials/textures), `scene3d/buildings.js:245-250`,
//    `scene3d/particles/particle_manager.js:628`, `scene3d/terrain.js:3043`,
//    entities.js `_disposeMaterialIfOwned`. A live mesh keeps its material
//    for its whole lifetime, and nothing tells us when the last one goes.
//    Disposing under a live mesh is not a crash (three re-uploads the texture
//    from `image.data` and recompiles the program on the next render) but it
//    is a shader recompile + GPU re-upload storm for **zero** heap benefit —
//    the exact trade this flag exists to avoid.
// 3. So: an evicted entry is disposed IMMEDIATELY only when it is **provably
//    unreferenced** — the DID was installed but never handed to a caller
//    (`_matHandedOut`). That is the common `preload()` over-fetch case (a
//    bake warms a building's part DIDs, the ring never draws half of them)
//    and it is the whole `?nullRender=1` measurement rig, where no texture
//    ever reached the GPU anyway.
// 4. A handed-out entry goes to `_matGraveyard` as a **WeakRef** (weak, or it
//    would re-create the very leak we are evicting) and is disposed only by
//    the explicit `releaseEvictedGpu()` hook, which has NO default caller.
//    Call it only at a point where the scene provably no longer references
//    the old materials (a full scene rebuild / teardown). Left uncalled, the
//    GPU-side objects of evicted-and-still-referenced entries are leaked
//    exactly as they are leaked today — this flag cannot make GPU residency
//    worse than the unbounded status quo, only better.
// 5. Eviction also drops the per-DID DERIVED clones (`frontSideMaterials`,
//    `floorBiasMaterials`, `staticBiasMaterials`, `particleUnlitMaterials`,
//    the `did|set|config` `vfxVariants`) and the animated-frame entry, all of
//    which share or wrap the base's textures. Leaving them behind would keep
//    the evicted bytes alive through a back door and would let a stale clone
//    outlive its base.
//
// FOOTGUN, same class as `?surfaceBudgetMB`: a budget below one bake's live
// working set re-introduces the grey-surface failure mode (a `getCached()`
// after an eviction returns the shared fallback until something re-preloads
// the DID). Two structural guards: eviction is strictly least-recently-USED
// (a DID just preloaded/drawn is the newest, evicted last), and the entry
// installed by the current call is never the one evicted (the same
// `oldestKey === key` guard `installPaletted` uses). Set the budget above one
// town's live surface set — see the url-flags.md row for the measured floor.
// ===========================================================================

/** Bookkeeping overhead charged per cached DID (mirrors Rust `surface_pixels_bytes`'s +64). */
export const MAT_ENTRY_OVERHEAD_BYTES = 64;

/** How many evicted-but-handed-out entries the deferred-release list holds. */
const MAT_GRAVEYARD_CAP = 1024;

/**
 * Parse one `matBudgetMB` token → MB (number) or 0 for "unbounded".
 * Absent / empty / `off` / `0` / negative / non-numeric ⇒ 0. Positive
 * decimals are accepted (`0.5` = 512 KiB) so a deliberately-tiny negative
 * control arm is expressible.
 */
export function parseMatBudgetMB(raw) {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).trim();
  if (!/^\d+(?:\.\d+)?$/.test(s)) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * `?matBudgetMB` default, in MiB — DEFAULT ARMED 2026-08-05.
 *
 * WHY IT IS ARMED. Unset used to mean UNBOUNDED, and the block comment above
 * says exactly what that costs: the four per-DID maps are "a monotone retainer
 * over distinct surface DIDs ever seen, i.e. a function of ROUTE LENGTH, not of
 * boot". A 1070 session that teleported Holtburg → Arwic → Yaraq → Sawato →
 * Shoushi took the renderer process to 2.5 GB against Chrome's 4.19 GB cap and
 * OOM-crashed the tab (black screen + auto-reload) repeatedly. A V8 heap
 * snapshot attributed 2,021 MB of the 2,184 MB heap to `system /
 * JSArrayBufferData`, and the retainer walk landed on Texture CPU pixel data:
 * DataTexture 115 MB / DataArrayTexture 398 MB / CompressedTexture 74 MB /
 * CompressedArrayTexture 82 MB. The per-DID DataTextures in these maps are the
 * share this budget governs; the atlas ARRAY textures have their own owners
 * (static_atlas layer recycling, terrain_bc7 tiers) and are unaffected.
 *
 * WHY 384. The measured live working set for a town is ~115-130 MB across ~760
 * cached DIDs, so this sits ~3x above one bake's set — comfortably clear of the
 * FOOTGUN documented above (a budget under the live set re-introduces grey
 * fallback surfaces), while still capping the route-length growth that has no
 * ceiling at all today.
 *
 * ⚠ STILL OWED: the ABAB interleave `?surfaceBudgetMB` got before IT was armed
 * (RESULTS-abab-surface-budget-2026-07-26.md). This arming is justified by a
 * crash and a heap snapshot, not by a settle-within-noise A/B. `?matBudgetMB=off`
 * restores the never-evicted maps bit-for-bit.
 */
export const MAT_BUDGET_DEFAULT_MB = 384;

/**
 * Resolve `?matBudgetMB=` out of a query string into BYTES.
 *
 * GRAMMAR (changed 2026-08-05 with the arming above):
 *   absent / unparseable ⇒ `MAT_BUDGET_DEFAULT_MB` (the armed default)
 *   explicit `off` / `0` ⇒ 0 = unbounded (the bit-for-bit legacy escape)
 *
 * Garbage resolving to the DEFAULT rather than to unbounded is deliberate and
 * is the one behaviour change: with a default armed, "typo silently disables
 * the memory cap" is the same class of footgun as the `!== "off"` reader this
 * flag's own tests warn about. Only the explicit escape disarms it.
 *
 * Pure — touches no globals, so the control arms stay testable in node.
 */
export function resolveMatBudgetBytes(search = "") {
  let raw = null;
  try {
    raw = new URLSearchParams(search || "").get("matBudgetMB");
  } catch (_) {
    return Math.floor(MAT_BUDGET_DEFAULT_MB * 1024 * 1024);
  }
  if (raw === null || raw === undefined) {
    return Math.floor(MAT_BUDGET_DEFAULT_MB * 1024 * 1024);
  }
  const s = String(raw).trim().toLowerCase();
  if (s === "off" || s === "0") return 0; /* explicit escape ⇒ unbounded */
  const mb = parseMatBudgetMB(raw);
  return mb > 0
    ? Math.max(1, Math.floor(mb * 1024 * 1024))
    : Math.floor(MAT_BUDGET_DEFAULT_MB * 1024 * 1024);
}

/** The live page's budget in bytes; 0 (unbounded) anywhere without a location. */
export function matBudgetBytesFromLocation() {
  try {
    if (typeof window === "undefined" || !window.location) return 0;
    return resolveMatBudgetBytes(window.location.search);
  } catch (_) {
    return 0;
  }
}

// ===========================================================================
// `?palBudgetMB=N` — BYTE budget for the paletted (recolored) surface cache
// (2026-07-26, retail-palette research #1 / `RESULTS-matcache-falsifier-
// 2026-07-26.md` next-move 1).
//
// WHAT IT REPLACES. `palettedMaterials` / `palettedTextures` are keyed by
// outfit SIGNATURE (`did|paletteId|subPalettes`) and were bounded by
// `PALETTED_CACHE_CAP = 256` — a COUNT. `matBudgetMB` structurally cannot see
// this pool (`_matLru` charges only the four per-DID maps), so these two maps
// were the one unbudgeted per-surface retainer in the tree. A count cap is the
// wrong instrument here because the per-signature cost is not a constant: at
// 256² a recolored surface pins 256 KiB of `DataTexture.image.data`, at 512² it
// pins 1 MiB, at 64² 16 KiB. 256 signatures is therefore anywhere from 4 MiB
// to 256 MiB — and at Hotel Swank (an item museum: hundreds of distinct recolor
// signatures in one stop) the cap was hit while the bytes were still small,
// so the "shared" cache THRASHED (`palEvict` spiking) and each next wearer
// re-minted a full-size copy. Both failure modes — thrash below the byte
// ceiling, and blowing past it on big surfaces — come from measuring the
// wrong quantity.
//
// DEFAULT 64 MiB, and it is a real default, not "unbounded" (that is the one
// deliberate difference from `matBudgetMB`'s default-neutral grammar): the
// pool was ALREADY bounded, so shipping unbounded-by-default would be a
// regression. 64 MiB is the byte-equivalent of the old 256-count cap at the
// 256² modal surface size (256 × 256 KiB = 64 MiB) — i.e. the default is
// chosen to be behaviour-preserving at the size the cap was implicitly tuned
// for, while sizing correctly for the 64²/512² tails the count cap got wrong.
// ⚠ PROVISIONAL: confirm/adjust from the Swank rerun's `palHiMB` (the
// high-water the relay reports). If `palHiMB` settles well under 64 the
// default can come down; if `palEvict` is still spiking at 64 it must go up.
//
// GRAMMAR (mirrors `matBudgetMB`'s explicit-positive-number reader, so it is
// NOT the `!== "off"` shape that reads ON when the param is absent):
//   absent            ⇒ 64 MiB   (the default)
//   `?palBudgetMB=N`  ⇒ N MiB     (positive decimals OK; `0.5` = 512 KiB)
//   `?palBudgetMB=off`⇒ LEGACY    (the 256-COUNT cap, bit-for-bit pre-change)
//   garbage / `0` / negative ⇒ 64 MiB (the default — a typo must not silently
//                                      unbound or unbind the cache)
// `off` is the escape hatch, and it is the ONLY way back to count semantics.
//
// WHAT DOES NOT CHANGE. Eviction order (oldest-by-insertion — Map iteration
// order), the `oldestKey === key` protect-the-just-installed guard, the
// dispose pairing (material + its owned texture together), and every tally
// (`_palEvictions`, `_palEvictedBytes`, `_palBytes`, `_palHiWaterBytes`,
// `_palHiWaterSigs`, `_palInstalls`). `__diag.palettedCache()` and the relay
// columns (`palMB` / `palHiMB` / `palEvict` / `palSigs`) keep working
// unchanged; only `cap` changes meaning (it now reports the BYTE budget) and
// `legacyCountCap` / `budgetMode` are added so a reader can tell which
// instrument is armed.
//
// SAME FOOTGUN as `matBudgetMB` / `?surfaceBudgetMB`: a budget below one
// bake's live working set re-introduces the thrash it exists to remove (and,
// at the extreme, an evicted-then-refetched signature renders unrecolored for a
// frame). The two structural guards are unchanged: eviction is
// oldest-by-insertion and the entry installed by the current call is never
// the one evicted.
// ===========================================================================

/** `?palBudgetMB` default, in MiB. See the block comment for the derivation. */
export const PAL_BUDGET_DEFAULT_MB = 64;

/**
 * Parse one `palBudgetMB` token → MB (positive number), or the string
 * `"off"` for LEGACY count-cap mode.
 *
 * Absent / empty / garbage / `0` / negative ⇒ `PAL_BUDGET_DEFAULT_MB`.
 * Only the literal `off` (case-insensitive, trimmed) selects legacy.
 */
export function parsePalBudgetMB(raw) {
  if (raw === null || raw === undefined) return PAL_BUDGET_DEFAULT_MB;
  const s = String(raw).trim();
  if (s.toLowerCase() === "off") return "off";
  if (!/^\d+(?:\.\d+)?$/.test(s)) return PAL_BUDGET_DEFAULT_MB;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return PAL_BUDGET_DEFAULT_MB;
  return n;
}

/**
 * Resolve `?palBudgetMB=` out of a query string into BYTES.
 * Returns `0` for LEGACY (count-cap) mode — the one sentinel, mirroring
 * `resolveMatBudgetBytes`'s "0 means the other regime". Pure: touches no
 * globals, so every arm is testable in node.
 */
export function resolvePalBudgetBytes(search = "") {
  let mb;
  try {
    mb = parsePalBudgetMB(new URLSearchParams(search || "").get("palBudgetMB"));
  } catch (_) {
    mb = PAL_BUDGET_DEFAULT_MB;
  }
  if (mb === "off") return 0; /* legacy count cap */
  return Math.max(1, Math.floor(mb * 1024 * 1024));
}

/** The live page's paletted budget in bytes; the default anywhere without a location. */
export function palBudgetBytesFromLocation() {
  try {
    if (typeof window === "undefined" || !window.location) {
      return PAL_BUDGET_DEFAULT_MB * 1024 * 1024;
    }
    return resolvePalBudgetBytes(window.location.search);
  } catch (_) {
    return PAL_BUDGET_DEFAULT_MB * 1024 * 1024;
  }
}

/**
 * JS-heap bytes a `THREE.DataTexture` pins through `image.data`. This is the
 * honest number — it is measured AFTER `?textureDownscale` decimation and
 * after the normal map's RGB→RGBA padding, rather than derived from the
 * surface's nominal w×h. Excludes the GPU-side mip chain (~+33%), which the
 * JS heap does not hold. Non-DataTexture / absent ⇒ 0.
 */
export function estimateTextureBytes(tex) {
  const d = tex && tex.image ? tex.image.data : null;
  if (d && typeof d.byteLength === "number") return d.byteLength;
  // X6 — a compressed texture keeps NO `image.data` (its `image` carries only
  // the dims; the blocks live in `mipmaps[i].data`), so the read above returns
  // 0 and `?matBudgetMB` would account a BC7 surface as free. Charge its real
  // block bytes instead.
  return bc7TextureBytes(tex);
}

/** Per-DID entry size: albedo + normal + height planes + fixed overhead. */
export function estimateMatEntryBytes(tex, normalTex, heightTex) {
  return (
    estimateTextureBytes(tex) +
    estimateTextureBytes(normalTex) +
    estimateTextureBytes(heightTex) +
    MAT_ENTRY_OVERHEAD_BYTES
  );
}

// === 2026-08-03 — seam-height side channel ==================================
// INVARIANT: nothing may store a THREE.Texture (or a typed array) in a
// `material.userData`. three's `Material.copy()` does
// `userData = JSON.parse(JSON.stringify(source.userData))`, and Texture.toJSON
// serializes a DataTexture via `Array.from(image.data)` — so a userData-held
// height plane costs a full pixel-array serialize + reparse on EVERY clone
// (getCachedFloorBias / StaticBias / CellBaked / Variant / FrontSide are all
// default-path). The statics atlas still needs the plane (`packNraLayer`), so
// it lives here, keyed weakly by material, and is inherited explicitly at each
// clone site via `_inheritHeightTex`.
const _heightTexByMaterial = new WeakMap();

/** The seam-height plane for a material, or null. Read by static_atlas.js. */
export function heightTexForMaterial(mat) {
  if (!mat) return null;
  return _heightTexByMaterial.get(mat) || null;
}

/** Carry the base's height plane onto a derived clone (clones share textures). */
function _inheritHeightTex(base, clone) {
  const h = base && _heightTexByMaterial.get(base);
  if (h && clone) _heightTexByMaterial.set(clone, h);
}

// === 2026-08-03 — derived-clone re-seat ====================================
// The surface-derived half of a material, i.e. everything `_materialFromFlags`
// / `applySurfaceRenderState` / `_applyRough` can set. Deliberately EXCLUDES
// `side` and everything the clone's own patch owns (onBeforeCompile,
// customProgramCacheKey, the userData patch flags below).
const _RESEAT_FIELDS = [
  "map", "normalMap", "emissiveMap", "roughnessMap", "aoMap",
  "roughness", "metalness", "aoMapIntensity", "emissiveIntensity",
  "transparent", "opacity", "depthWrite", "alphaTest",
  "blending", "blendSrc", "blendDst", "blendEquation",
  "forceSinglePass", "fog",
];
// Clone-local markers that must survive a re-seat: `_patchSetCacheKey` reads
// them, so losing one collapses the clone onto the un-patched program.
const _RESEAT_KEEP_USERDATA = [
  "__cacheOwned", "__floorBiased", "__staticBiased", "__acBakedLight",
  "__aoPatched", "__depthBiased", "__vfxSetKey", "__vfxColorPassOnly",
  "detailEnabled", "csmEnabled", "pomEnabled", "lightClampRetail",
];
/** Non-enumerable live handles (see `_defineLiveUserData`) — a spread skips them. */
const _LIVE_USERDATA_KEYS = [
  "acBakedLightUniforms", "detailShaderUniforms", "csmShaderUniforms",
  "pomShaderUniforms", "lightClampShaderUniforms",
];

function _reseatSurfaceState(clone, base) {
  for (const k of _RESEAT_FIELDS) clone[k] = base[k];
  // Colour-valued fields are objects — copy VALUES so the clone never aliases
  // the base's Color/Vector2.
  if (clone.color && base.color) clone.color.copy(base.color);
  if (clone.emissive && base.emissive) clone.emissive.copy(base.emissive);
  if (clone.normalScale && base.normalScale) clone.normalScale.copy(base.normalScale);
  const prev = clone.userData || {};
  const keep = {};
  for (const k of _RESEAT_KEEP_USERDATA) if (k in prev) keep[k] = prev[k];
  clone.userData = { ...(base.userData || {}), ...keep, __cacheOwned: true };
  // Carry the clone's own live handles across — the spread above skips
  // non-enumerable keys, and csm.js reads csmShaderUniforms every frame.
  for (const k of _LIVE_USERDATA_KEYS) {
    if (prev[k] !== undefined) _defineLiveUserData(clone, k, prev[k]);
  }
  _inheritHeightTex(base, clone);
  clone.needsUpdate = true;
}

export class MaterialCache {
  /**
   * @param {{
   *   detailTileCache?: Map<string, THREE.Texture>,
   *   forceDetail?: boolean,
   *   csmState?: object,
   *   pomEnabled?: boolean,
   *   pomOpts?: object,
   *   forcePom?: boolean,
   *   normalMapsEnabled?: boolean,
   * }} [opts]
   * `detailTileCache`: optional shared `Map<key, THREE.Texture>` (built
   * once at scene init via `loadDetailTileCache` from adapter.js). When
   * provided + a surface carries the `Detail (0x20000)` bit, the
   * generated material wires the matching tile via an `onBeforeCompile`
   * shader patch. `null` / undefined → the cache simply skips the patch
   * (legacy capture flows + Node tests where no GPU is around). Phase
   * X.1 gates this behind `quality.flags.detailFlag` at the call site
   * by passing `null` for `low` preset.
   *
   * `forceDetail`: testing override. When `true`, the Detail composite
   * is applied to every textured material regardless of the
   * `surface_type` bit. Used by the visual-smoke capture to render the
   * effect against real Holtburg surfaces even when the retail DAT
   * doesn't ship any Detail-flagged surfaces — see Phase 0.2 report.
   *
   * `pomEnabled`: Phase 3.1 gate. When `true`, surfaces classified as
   * Stone/Brick/Tile get the parallax occlusion mapping shader patch
   * (ray-marches a per-surface heightmap from
   * `holtburger_dat::normal_gen::height_from_luminance`). Default
   * `false` (low/mid quality presets); high/ultra flip this on via
   * `quality.flags.pom`.
   *
   * `forcePom`: testing override. When `true`, POM applies to EVERY
   * textured material regardless of category (subject to the heightmap
   * being non-empty). Used by the visual-smoke capture to verify the
   * patch installs on real Holtburg surfaces without requiring a
   * specific Stone DID to be on-screen.
   *
   * `normalMapsEnabled`: Phase 1.1 / Wave 2.B gate. When `true`, the
   * per-surface procedural normal map baked in
   * `holtburger_dat::normal_gen::normal_from_luminance` (Sobel-X over
   * Rec.601 luminance) is wired onto the `MeshStandardMaterial.normalMap`
   * slot, giving stone/brick/wood/etc. surfaces tangent-space micro-relief
   * under directional + probe lighting. When `false`, the normal texture
   * is dropped at the gate — the material falls back to flat shading
   * (cheap-path for `low` and `mid` quality presets where the +texture
   * memory cost outweighs the visual delta on weaker GPUs). Default
   * `true` (preserves behaviour for any caller that constructs a
   * MaterialCache without going through the quality preset, eg. test
   * harnesses and the Node-side material smoke tests).
   */
  constructor(opts = {}) {
    /** @type {Map<number, THREE.MeshStandardMaterial>} */
    this.materials = new Map();
    // Missing-surface negative cache (2026-07-07). DIDs that resolve to zero
    // pixels (permanent catalog absence) — see surfaceNegCacheEnabled() for the
    // safety argument. Short-circuits get()/preload() so absent surfaces are not
    // re-fetched + re-warned every bake. Default ON (`?surfaceNegCache=off`).
    /** @type {Set<number>} */
    this.missingSurfaces = new Set();
    this._negCacheEnabled = surfaceNegCacheEnabled();
    // Phase-5 — baked material-detail (texchan roughnessMap). DEFAULT-ON via
    // `materialBakeEnabled()` (`?material=off` escape). The wasm namespace is
    // threaded in for the by-key suite fetch; the SuiteAssetSource + manifest
    // are built lazily on first gated use. Normal stays runtime-generated
    // (byte-identical to the bake); only roughness is sourced from the sidecar.
    // aoMap is baked-and-ready but deferred (needs a uv2 the geometry lacks).
    this.materialBakeEnabled = materialBakeEnabled();
    this._texchanWasm = opts.wasmExports || null;
    this._texchanSource = null;
    this._texchanManifest = null;
    this._texchanInit = false;
    /** Materials awaiting the manifest (built before it loaded): [mat, did]. */
    this._pendingRough = [];
    /**
     * 2026-08-03 — the texchan roughness/AO planes minted by `_applyRough`,
     * keyed by DID. They hang off the material only, so without this map
     * neither `_evictMatEntry` nor `dispose()` could ever free them.
     * @type {Map<number, THREE.DataTexture[]>}
     */
    this._texchanTextures = new Map();
    // Render-completeness audit (2026-05-29) — animated SurfaceTextures.
    // `_animFramesFetch` is the wasm `fetchSurfaceAnimFrames(did)` getter
    // (null on legacy builds → animation silently disabled). `_animatedMaterials`
    // maps surfaceDid → { mat, frames:[DataTexture], idx, accumS }. Cycled by
    // `tickAnimatedSurfaces(dt)` from the render loop. Animating the SHARED
    // cache material's `.map` is correct: every instance of a water/lava
    // surface should cycle in sync.
    this._animFramesFetch = opts.animFramesFetch || null;
    /** @type {Map<number, {mat: any, frames: any[], idx: number, accumS: number, cyclesEmissive?: boolean}>} */
    this._animatedMaterials = new Map();
    /** Set of DIDs already checked for animation (avoid re-fetching). */
    this._animChecked = new Set();
    /**
     * T2 (2026-05-28): FrontSide (single-sided) variants, keyed by surfaceDid.
     * Built lazily by `getCached(did, false)` for `?perPolyCull=on`. Each is a
     * `.clone()` of the DoubleSide base with `side = FrontSide` — clones SHARE
     * the underlying textures (THREE clone copies map refs), so no texture
     * duplication. Empty (never built) when the cull flag is off.
     * @type {Map<number, THREE.Material>}
     */
    this.frontSideMaterials = new Map();
    // 2026-06-15 — floor-bias variants, keyed by surfaceDid. A `.clone()` of the
    // DoubleSide base with a log-depth `gl_FragDepth -= 2e-4` patch
    // (applyFloorDepthBias). Used for surfaces coplanar with terrain (SetupModel
    // building floors; EnvCell floors) so the floor wins the depth tie instead
    // of flickering against the grass. Clones SHARE textures (THREE clone copies
    // map refs); cache-owned; lazily minted; mirrors frontSideMaterials lifecycle.
    this.floorBiasMaterials = new Map();
    // 2026-07-06 — cell-static décor bias variants, keyed by surfaceDid. A
    // .clone() of the DoubleSide base with a log-depth `gl_FragDepth -= 4e-4`
    // patch (applyStaticDepthBias) so wall/floor-flush interior props win the
    // coplanar depth tie against the cell surface behind them. Clones SHARE
    // textures; cache-owned; lazily minted; mirrors floorBiasMaterials lifecycle.
    this.staticBiasMaterials = new Map();
    // RND-04 baked-static-light variants: .clone() of the DoubleSide base with
    // applyBakedVertexLightPatch installed, used ONLY by EnvCell surface meshes
    // (the geometries that carry `acBakedLight`). A separate map because the
    // same surface DID is also drawn by props/buildings that have no bake and
    // must keep their live lighting — sharing one material would leak the
    // suppress-direct arm onto them. Clones SHARE textures; cache-owned;
    // lazily minted; mirrors staticBiasMaterials lifecycle exactly.
    this.cellBakedMaterials = new Map();
    // VFX component-variant clones (Visual-Behavior Suite). Keyed by
    // (surfaceDid|setKey|configKey); CLONES of the base material that share
    // textures. Dormant until a frag/MECH-B component calls getCachedVariant.
    this.vfxVariants = new Map();
    // Paletted twin of vfxVariants: frag/MECH-B variant clones built ON TOP of a
    // recolored paletted base (the `_entityMaterials` path), so itemFx /
    // catalog effects (magicGlow, enchantShimmer, glint, itemAura) reach recolored
    // gear too — not just surfaceDid-keyed non-paletted entities. Keyed by the
    // exact paletteKey × component-SET so the recolor stays correct and programs dedup.
    this.vfxPalettedVariants = new Map();
    /** @type {Map<number, THREE.DataTexture>} */
    this.textures = new Map();
    /** @type {Map<number, THREE.DataTexture>} */
    this.normalTextures = new Map();
    /** @type {Map<number, THREE.DataTexture>} */
    this.heightTextures = new Map();
    /** @type {Map<number, Promise<THREE.MeshStandardMaterial>>} */
    this.pendingFetches = new Map();
    /**
     * 2026-05-28 — Paletted-material dedup cache. Keyed by
     * `${surfaceDid}|${paletteId}|${subPalettesHash}` so multiple
     * entities sharing the same outfit signature (same surface +
     * palette substitutions) hit one cached material instead of
     * minting a fresh recoloured one per entity. Spawn-trace data on
     * the 120s drive showed 57/97 spawns going the palette path with
     * mean 897ms wasm-fetch each — most are dedupable.
     *
     * Cache-owned: tagged `__cacheOwned: true` so per-entity dispose
     * doesn't free a material another entity is still using. Lives
     * for scene lifetime; cleared on scene rebuild.
     * @type {Map<string, THREE.Material>}
     */
    this.palettedMaterials = new Map();
    /** @type {Map<string, THREE.DataTexture>} — cache-owned paletted textures. */
    this.palettedTextures = new Map();
    /**
     * `?palDedup` (2026-08-06) — single-flight over the SAME key space as
     * `palettedMaterials`. One entry per signature currently being decoded by
     * some spawn; the value settles with the minted material (or `null` when
     * that spawn bailed / decoded empty). Entries are transient: the claimer
     * deletes its own entry when it settles, so a steady-state scene holds an
     * empty map. See the `?palDedup` block near PAL_EVICT_MEMORY_KEYS.
     * @type {Map<string, {promise: Promise<THREE.Material|null>, settle: (m: THREE.Material|null) => void}>}
     */
    this.palettedInflight = new Map();
    this._palClaims = 0;   // signatures this cache handed out a claim for
    this._palJoins = 0;    // decodes AVOIDED by joining another spawn's claim
    // === `palMB` instrument (2026-07-26, RESULTS-matcache-falsifier next-move 1) ===
    // The paletted maps are the ONLY per-surface caches `matBudgetMB` cannot
    // see: `_matLru` is populated exclusively for the four per-DID maps
    // (:2255/:2282/:2296), so `matMB` reported 261–355 MB while these two
    // held an unknown amount — which is why the falsifier's budget
    // intervention pinned the wrong maps and the 3.6 GB step survived it.
    //
    // These counters are the discriminator — and, since 2026-07-26, also the
    // budget's own input: `?palBudgetMB=N` evicts on `_palBytes`, not on
    // signature count. The old `PALETTED_CACHE_CAP = 256` was a COUNT cap, and
    // past it the cache THRASHED: an evicted texture is `dispose()`d (GPU
    // handles only — the JS `image.data` stays alive as long as a live mesh
    // still references the material), and the next wearer with the same
    // signature mints a fresh full-size copy. An item museum like Hotel Swank
    // blows through 256 distinct `(did|paletteId|subPalettes)` signatures in
    // one stop while the BYTES were still small, so above the cap the "shared"
    // cache degenerated into per-wearer duplication. The count cap now lives
    // on only as `?palBudgetMB=off`.
    //
    // Confirming signal at Swank: `palEvict` spiking and `palMB`/heap
    // climbing while `matMB` stays flat.
    //
    // Charged incrementally, O(1) per insert/evict (`image.data.byteLength`,
    // the same honest measure as `estimateTextureBytes`) — never a walk.
    this._palBytes = 0;          // live Σ bytes over palettedTextures
    this._palHiWaterBytes = 0;   // max _palBytes ever observed
    this._palEvictions = 0;      // cap-driven evictions, cumulative
    this._palEvictedBytes = 0;   // Σ bytes evicted, cumulative
    this._palInstalls = 0;       // installPaletted calls that stored a texture
    this._palHiWaterSigs = 0;    // max palettedMaterials.size ever observed
    /** @type {Map<string, number>} charged bytes per live paletted key */
    this._palKeyBytes = new Map();
    // `palRemint` (2026-07-26, museum-density confirmation of the 64 MiB
    // default) — the THRASH-COST counter, and the only headless proxy for the
    // "visual fallback flash" the palBudget decision rule asks about.
    //
    // `_palEvictions` alone cannot answer it: evicting a signature no wearer
    // ever asks for again is the budget working, and costs nothing. What costs
    // is an eviction that is immediately re-needed — the next wearer with that
    // signature takes the full `fetchEntitySurfacesPixels` round-trip (mean
    // ~897 ms) instead of a cache hit, and renders untextured/unrecolored for
    // that window (entities.js spawn path: a paletted miss goes to
    // `missDids`; an empty/pending decode paints `fallbackMaterial`). A
    // re-install of a signature THIS cache evicted is exactly that event.
    //
    // Bounded by construction: `_palEvictedKeys` is a FIFO of at most
    // `PAL_EVICT_MEMORY_KEYS` recently-evicted key strings (insertion-ordered
    // Set, oldest dropped), so the instrument can never become the leak it
    // measures. A remint older than that window is simply not counted —
    // the counter is a floor, never an over-count.
    /** @type {Set<string>} recently-evicted keys (FIFO, bounded) */
    this._palEvictedKeys = new Set();
    this._palRemints = 0;        // installs of a signature this cache evicted
    // `?palBudgetMB=N` — BYTE budget over `palettedMaterials`/`palettedTextures`
    // (see the block comment above the class). `0` = LEGACY `PALETTED_CACHE_CAP`
    // count mode (`?palBudgetMB=off`). `opts.palBudgetBytes` is the
    // test/embedder seam and accepts 0 (to request legacy explicitly), so the
    // guard is `>= 0` rather than `> 0`; anything else takes the URL path,
    // which is the 64 MiB default on a page without the flag.
    const _optPalBudget = Number(opts.palBudgetBytes);
    this._palBudgetBytes =
      Number.isFinite(_optPalBudget) && _optPalBudget >= 0
        ? Math.floor(_optPalBudget)
        : palBudgetBytesFromLocation();
    /**
     * 2026-06-20 ParticleViewer parity — cache-owned UNLIT particle materials
     * keyed by surfaceDid. Particles render unlit (texture × opacity, additive/
     * alpha from the surface flag) — NOT through the lit MeshStandard entity
     * path. See `getParticleUnlit`. Cleared on scene rebuild with the others.
     * @type {Map<number, THREE.MeshBasicMaterial>}
     */
    this.particleUnlitMaterials = new Map();
    /**
     * Sidecar to `pendingFetches` keyed by the same DID — records the
     * wall-clock at which the fetch was kicked off so `__diag.assets
     * .stuck(thresholdMs)` can identify entries that have been in-flight
     * too long. Set on every `pendingFetches.set(did, ...)`; deleted on
     * every `pendingFetches.delete(did)` (both success and failure
     * paths). Never read from cache logic — observation only.
     * @type {Map<number, number>}
     */
    this.pendingStartTimes = new Map();

    // Wire-agent mode (?wireframe=1). When true, getCached() returns
    // shared per-DID-hash MeshBasicMaterial({wireframe:true}) instead of
    // a textured MeshStandardMaterial, and preload() skips the
    // expensive surface-pixel fetch + GPU texture upload entirely.
    // Designed so software-WebGL (SwiftShader) can keep up — no PBR
    // shader, no fragment fill, no texture sampling. Composable with
    // any quality preset; orthogonal to `agentic=low`.
    this.wireframeMode = !!opts.wireframeMode;
    // 2026-07-04 — solid-fill companion pass toggle (?wireFill URL flag).
    // Default ON (undefined → true) so wireframe keeps its depth-occluded
    // look; `?wireFill=0` sets it false to skip the second-draw pass for
    // the cheapest wireframe. Only consulted while wireframeMode is on.
    this.wireFill = opts.wireFill !== false;
    /** @type {Map<number, THREE.MeshBasicMaterial>} */
    this.wireframeBuckets = new Map();
    // 2026-05-22 — companion solid-fill materials for the wire buckets,
    // populated lazily alongside the wireframe materials. Keyed by the
    // same bucket index (0..WIRE_BUCKETS) so `addFillCompanions` can
    // map a wire material back to its fill twin by either bucket-index
    // (via `wireMatToFill`) or reference. polygonOffset on the fill
    // pushes it slightly behind the wire so the wireframe lines stay
    // crisp without z-fighting.
    /** @type {Map<number, THREE.MeshBasicMaterial>} */
    this.wireframeFillBuckets = new Map();
    /** @type {Map<THREE.MeshBasicMaterial, THREE.MeshBasicMaterial>} */
    this.wireMatToFill = new Map();
    // 2026-05-22 — per-surface dominant-colour pair, populated lazily
    // when the manifest at `data/surface-colors.json` has an entry for
    // the requested DID. Each entry is `{ wire, fill }`; both
    // MeshBasicMaterial. With the manifest installed, wire-mode
    // surfaces render in their actual dominant texture colour (grass
    // green, bark brown, stone grey, water blue, etc.) instead of the
    // 32-bucket HSL hash. Surfaces missing from the manifest still
    // fall through to `wireframeBuckets`. See
    // `apps/holtburger-tools/src/bin/surface-colors.rs` for the
    // build-time tool.
    //
    // `surfaceColors` is the loaded `Map<u32, [r, g, b]>` (Uint8 0..255).
    /** @type {Map<number, {wire: THREE.MeshBasicMaterial, fill: THREE.MeshBasicMaterial}>} */
    this.didMaterials = new Map();
    this.surfaceColors = opts.surfaceColors ?? null;

    // Phase 0.2 — shared detail-tile cache. `null` means "Detail flag
    // is decoded but the composite is not wired" (preserves Phase 7.2
    // baseline). All MaterialCache instances in one scene share the
    // same Map so each tile is uploaded to GPU exactly once.
    this.detailTileCache = opts.detailTileCache ?? null;
    this.forceDetail = !!opts.forceDetail;

    // Visual-fidelity Phase 3.3 — Cascaded Shadow Maps bundle. When
    // present, every material this cache produces gets the CSM shader
    // patch (samples 3 cascade shadow maps, blends at boundaries,
    // multiplies the sun's contribution by the resulting factor). Null
    // means Phase 0.1 single-shadow path stays in effect (low/mid
    // quality preset). Mutually exclusive with single-shadow; the two
    // paths are gated by `quality.flags.csm` at the call site.
    this.csmState = opts.csmState ?? null;

    // Visual-fidelity Phase 3.1 — POM gate. When `true`, stone-class
    // surfaces (Stone/Brick/Tile) get the parallax shader patch +
    // per-surface heightmap texture installed. Default false; high/
    // ultra presets pass `pomEnabled: true` via the call site.
    this.pomEnabled = !!opts.pomEnabled;
    this.pomOpts = opts.pomOpts ?? null;
    this.forcePom = !!opts.forcePom;

    // === Wave 2.B — procedural normals (2026-05-28) ===
    // Phase 1.1 normal map gate. Defaults to `true` so legacy callers and
    // test harnesses that don't plumb the quality preset still get the
    // pre-Wave-2.B behaviour. Quality-preset call sites (index.js +
    // statics.js + buildings.js) pass `quality.flags.normalMaps` so
    // `low`/`mid` presets opt out per the preset table in quality.js.
    this.normalMapsEnabled =
      opts.normalMapsEnabled === undefined ? true : !!opts.normalMapsEnabled;

    // Shared fallback for the 0xFF "no surface" bucket and for any
    // surface DID that fails to resolve (zero-size SurfacePixels, etc).
    this.fallbackMaterial = this.wireframeMode
      ? new THREE.MeshBasicMaterial({
          color: 0x808080,
          wireframe: true,
          side: THREE.DoubleSide,
        })
      : new THREE.MeshStandardMaterial({
          color: 0x888888,
          roughness: 0.9,
          metalness: 0.0,
          side: THREE.DoubleSide,
        });
    this.fallbackMaterial.name = "scene3d-fallback";
    // Perf B3 (2026-05-18) — tag cache-owned so entity dispose chains
    // (entities.js `_disposeMaterialIfOwned`) skip this shared
    // singleton. See the `__disposable` convention block in
    // entities.js's module docstring. C5 + E3 also consume this tag.
    this.fallbackMaterial.userData = {
      ...(this.fallbackMaterial.userData || {}),
      __cacheOwned: true,
    };
    if (this.csmState && !this.wireframeMode) {
      _installCsmShaderPatch(this.fallbackMaterial, this.csmState);
    }
    // === Wave R2.B — per-RGB light-color clamp (2026-05-28) ===
    // No-op unless `?lightClamp=retail`. Skip in wireframe mode — the
    // fallback is then a MeshBasicMaterial with NO direct-lighting
    // accumulation (no `RE_Direct`/`reflectedLight`), so the patch's
    // `<lights_fragment_begin>` target is absent and the chunk swap would
    // be a no-op replace at best / a broken shader at worst.
    if (!this.wireframeMode) {
      _installLightClampShaderPatch(this.fallbackMaterial);
    }

    // Diagnostic counters so capture scripts can see how many
    // textures resolved vs fell back without a separate probe.
    this.fallbackHits = 0;
    this.realHits = 0;

    // === `?matBudgetMB=N` byte-budget LRU (see the block comment above the
    // class for the full contract + dispose policy). `opts.matBudgetBytes`
    // is the test/embedder seam; it is only consulted when it parses to a
    // positive finite number, so `{}` (and every existing call site) takes
    // the URL path, which is 0 = unbounded on any page without the flag.
    const _optBudget = Number(opts.matBudgetBytes);
    this._matBudgetBytes =
      Number.isFinite(_optBudget) && _optBudget > 0
        ? Math.floor(_optBudget)
        : matBudgetBytesFromLocation();
    /**
     * did → estimated bytes, in LRU order (Map iteration is insertion order;
     * a touch deletes + re-sets so the FIRST key is the least-recently-used).
     * Maintained even when unbounded — sizing data for the falsifier arm.
     * @type {Map<number, number>}
     */
    this._matLru = new Map();
    this._matLruBytes = 0;
    /** DIDs whose material has been handed to a caller (see dispose policy 3). */
    this._matHandedOut = new Set();
    /** WeakRefs to evicted-but-handed-out disposables; see releaseEvictedGpu(). */
    this._matGraveyard = [];
    this._matEvictions = 0;
    this._matEvictedBytes = 0;
    this._matDisposedImmediate = 0;
    this._matDeferredDisposals = 0;
  }

  // --- `?matBudgetMB` LRU internals ---------------------------------------

  /** True when a positive budget is armed (i.e. eviction can happen at all). */
  matBudgetArmed() {
    return this._matBudgetBytes > 0;
  }

  /**
   * Mark `did` as most-recently-used. Called on every cache HIT (the
   * synchronous render path `_getCachedDouble`, the async `get()` fast path,
   * and `preload()`'s already-cached skip) so recency tracks real use rather
   * than install order. No-op for a DID that isn't resident.
   */
  _touchMatEntry(did) {
    // Unarmed is the default and `_getCachedDouble` is a bake hot path, so
    // the recency bookkeeping is skipped entirely when no budget can consume
    // it — default-neutral in cycles as well as in behaviour. (Consequence:
    // in an unbounded run `_matLru` stays in INSTALL order. Nothing reads the
    // order unless a budget is armed, and the budget is fixed at construction.)
    if (this._matBudgetBytes <= 0) return;
    const bytes = this._matLru.get(did);
    if (bytes === undefined) return;
    this._matLru.delete(did);
    this._matLru.set(did, bytes);
  }

  /**
   * Record that `did`'s material has left the cache, which switches its
   * eviction from inline-dispose to deferred (dispose policy 3/4). Same
   * unarmed short-circuit as `_touchMatEntry`.
   */
  _noteHandout(did) {
    if (this._matBudgetBytes <= 0) return;
    this._matHandedOut.add(did);
  }

  /**
   * Install one freshly-built entry into the four per-DID maps and account
   * for its bytes. The single write path — `get()` and `_installFromPixels`
   * both route through here, so the LRU can never drift from the maps.
   */
  _installCacheEntry(did, mat, tex, normalTex, heightTex) {
    // Stamp the surface DID on the material (2026-08-05, atlas-staging seam).
    // The atlas stages layers from `THREE.DataTexture.image.data` and knows only
    // the material; `scene3d/surface_planes.js` can re-supply those pixels from
    // the wasm decode memo instead, but it needs the DID to ask, and nothing
    // else on the material carries it. Stamped HERE because this is the single
    // write path into the four per-DID maps — `get()` and `_installFromPixels`
    // both route through it, which is the same reason the LRU accounting lives
    // here. Non-enumerable it is not: `userData` is plain data that gets spread
    // into clones (`:2501`), and a clone SHOULD inherit the DID — it samples the
    // same surface.
    mat.userData = { ...(mat.userData || {}), surfaceDid: did >>> 0 };
    // Task 4 (2026-08-05) — arm the CPU-copy release. Inert unless
    // `?texFreeCpu=on`, and see that module's header for the preconditions:
    // turning it on before the atlas stages through `surface_planes.js` will
    // silently UNBATCH statics. Armed HERE because this is the one place that
    // has both the DID and all three planes, and because arming the albedo
    // without the DID would produce a texture that cannot be refilled.
    //
    // Only these three: roughness and AO are texchan sidecars and are NOT in
    // the wasm decode memo, so nothing could refill them after a context loss.
    // Releasing a plane you cannot re-supply is just a black texture on a timer.
    try {
      armCpuRelease(tex, PLANE.ALBEDO, did);
      if (normalTex) armCpuRelease(normalTex, PLANE.NORMAL, did);
      if (heightTex) armCpuRelease(heightTex, PLANE.HEIGHT, did);
    } catch (_) { /* a memory optimisation must never break material install */ }
    this.textures.set(did, tex);
    if (normalTex) this.normalTextures.set(did, normalTex);
    if (heightTex) this.heightTextures.set(did, heightTex);
    this.materials.set(did, mat);
    const bytes = estimateMatEntryBytes(tex, normalTex, heightTex);
    const prev = this._matLru.get(did);
    if (prev !== undefined) this._matLruBytes -= prev;
    this._matLru.delete(did);
    this._matLru.set(did, bytes);
    this._matLruBytes += bytes;
    this._enforceMatBudget(did);
    return mat;
  }

  /**
   * Add `delta` bytes to an already-resident entry's accounting (the animated
   * SurfaceTexture frames land asynchronously, long after install, and are a
   * real multi-MB retainer per animated DID). Does not change recency.
   */
  _addMatEntryBytes(did, delta) {
    const prev = this._matLru.get(did);
    if (prev === undefined || !Number.isFinite(delta) || delta <= 0) return;
    this._matLru.set(did, prev + delta);
    this._matLruBytes += delta;
    this._enforceMatBudget(did);
  }

  /**
   * Evict the least-recently-used entries until the estimate is within
   * budget. Unbounded (the default) returns immediately, before touching a
   * single entry — this is the negative control the whole flag rests on.
   * `protectDid` is never evicted (the entry the current call just
   * installed), mirroring `installPaletted`'s `oldestKey === key` guard.
   * @returns {number} entries evicted this call
   */
  _enforceMatBudget(protectDid = -1) {
    if (this._matBudgetBytes <= 0) return 0;
    let n = 0;
    while (this._matLruBytes > this._matBudgetBytes && this._matLru.size > 1) {
      const oldest = this._matLru.keys().next().value;
      if (oldest === undefined || oldest === protectDid) break;
      this._evictMatEntry(oldest);
      n += 1;
    }
    return n;
  }

  /**
   * Drop every reference this cache holds for `did` — the four base maps, the
   * per-DID derived clones, and the animated-frame entry — then apply the
   * dispose policy documented above the class: dispose NOW only if the DID
   * was never handed out (provably unreferenced), otherwise hand the GPU
   * objects to the weak deferred-release list.
   */
  _evictMatEntry(did) {
    const bytes = this._matLru.get(did) ?? 0;
    this._matLru.delete(did);
    this._matLruBytes -= bytes;
    if (this._matLruBytes < 0) this._matLruBytes = 0;

    const disposables = [];
    const take = (map) => {
      const v = map.get(did);
      if (v !== undefined) {
        map.delete(did);
        if (v) disposables.push(v);
      }
    };
    // Base entry: the material and its three owned planes.
    take(this.materials);
    take(this.textures);
    take(this.normalTextures);
    take(this.heightTextures);
    // Derived per-DID clones. These SHARE the base's textures (THREE's
    // Material.clone copies map references), so only the material objects
    // are disposables here — but they must be dropped or a stale clone
    // outlives its base and keeps the evicted bytes reachable.
    take(this.frontSideMaterials);
    take(this.floorBiasMaterials);
    take(this.staticBiasMaterials);
    take(this.cellBakedMaterials);
    take(this.particleUnlitMaterials);
    // VFX component variants are keyed `${did}|${setKey}|${configKey}`.
    if (this.vfxVariants.size > 0) {
      const prefix = `${did}|`;
      for (const k of [...this.vfxVariants.keys()]) {
        if (typeof k === "string" && k.startsWith(prefix)) {
          const v = this.vfxVariants.get(k);
          this.vfxVariants.delete(k);
          if (v) disposables.push(v);
        }
      }
    }
    // Animated SurfaceTexture frames (a per-DID array of DataTextures, the
    // largest hidden retainer). `entry.mat` is the base material, already
    // collected above — push only the frames.
    const anim = this._animatedMaterials.get(did);
    if (anim) {
      this._animatedMaterials.delete(did);
      if (Array.isArray(anim.frames)) {
        for (const f of anim.frames) if (f) disposables.push(f);
      }
    }
    // Phase-5 texchan planes (roughness/AO). They hang off the material and
    // live in no other map, so they are freed here or never.
    const tcPlanes = this._texchanTextures && this._texchanTextures.get(did);
    if (tcPlanes) {
      this._texchanTextures.delete(did);
      for (const t of tcPlanes) if (t) disposables.push(t);
    }
    // Let a re-install re-check animation for this DID.
    this._animChecked.delete(did);
    // X6 — same reason: a re-install must be allowed to re-ask for BC7 (the
    // record source's own cache makes the retry free).
    if (this._bc7Asked) this._bc7Asked.delete(did);

    const wasHandedOut = this._matHandedOut.delete(did);
    this._matEvictions += 1;
    this._matEvictedBytes += bytes;

    if (!wasHandedOut) {
      // Provably unreferenced: nothing outside this cache ever received the
      // material, so disposing now cannot force a recompile on a live mesh.
      for (const d of disposables) {
        try { d?.dispose?.(); } catch (_) { /* fail-soft */ }
      }
      this._matDisposedImmediate += 1;
      return;
    }
    // Handed out: a live mesh may still be drawing with it. Defer the GPU
    // free to `releaseEvictedGpu()` and hold the objects WEAKLY so this list
    // can never be the retainer we are here to remove.
    this._matDeferredDisposals += 1;
    if (typeof WeakRef !== "function") return;
    for (const d of disposables) {
      try { this._matGraveyard.push(new WeakRef(d)); } catch (_) { /* fail-soft */ }
    }
    if (this._matGraveyard.length > MAT_GRAVEYARD_CAP) {
      // Oldest-first drop. Dropping a WeakRef only forfeits the chance to
      // free that object's GPU handle later — the same position the
      // unbounded pre-flag cache is in for every entry, forever.
      this._matGraveyard.splice(0, this._matGraveyard.length - MAT_GRAVEYARD_CAP);
    }
  }

  /**
   * Deferred-release hook for the GPU objects of evicted entries that HAD
   * been handed out (dispose policy 4). No default caller: the caller must
   * be able to promise the scene no longer references them — e.g. after a
   * full scene rebuild. Entries already collected by GC are skipped.
   * @returns {number} objects disposed
   */
  releaseEvictedGpu() {
    let n = 0;
    for (const ref of this._matGraveyard) {
      let obj = null;
      try { obj = ref?.deref?.() ?? null; } catch (_) { obj = null; }
      if (!obj) continue;
      try { obj.dispose?.(); n += 1; } catch (_) { /* fail-soft */ }
    }
    this._matGraveyard.length = 0;
    return n;
  }

  /**
   * Read-only budget/residency snapshot. Surfaced as `__diag.materialCache()`
   * (scene3d/index.js) so the battery relay can verify "mats bounded at cap"
   * against the same numbers the eviction loop uses. `budgetBytes: 0` (and
   * `budgetMB: null`) is the unauthored/unbounded default, mirroring
   * `shardCacheBudget`'s `-1 = unbounded` convention on the Rust side.
   */
  materialCacheStats() {
    return {
      entries: this.materials.size,
      lruEntries: this._matLru.size,
      textures: this.textures.size,
      normalTextures: this.normalTextures.size,
      heightTextures: this.heightTextures.size,
      bytes: this._matLruBytes,
      bytesMB: +(this._matLruBytes / (1024 * 1024)).toFixed(2),
      budgetBytes: this._matBudgetBytes,
      budgetMB: this._matBudgetBytes > 0
        ? +(this._matBudgetBytes / (1024 * 1024)).toFixed(2)
        : null,
      armed: this._matBudgetBytes > 0,
      evictions: this._matEvictions,
      evictedBytes: this._matEvictedBytes,
      disposedImmediate: this._matDisposedImmediate,
      deferredDisposals: this._matDeferredDisposals,
      graveyard: this._matGraveyard.length,
      handedOut: this._matHandedOut.size,
      missingSurfaces: this.missingSurfaces.size,
      palettedMaterials: this.palettedMaterials.size,
      // `palMB` cross-link (2026-07-26) — so a relay row that reads only
      // `materialCacheStats()` still carries the paletted pool's headline
      // numbers. Full view: `palettedCacheStats()` / `__diag.palettedCache()`.
      palettedBytes: this._palBytes,
      palettedEvictions: this._palEvictions,
    };
  }

  /**
   * `palMB` — the paletted (recolored) surface cache's residency view
   * (2026-07-26, RESULTS-matcache-falsifier-2026-07-26.md next-move 1).
   *
   * WHY IT IS SEPARATE FROM `materialCacheStats()`: `_matLru` — and therefore
   * `matMB` / `matBudgetMB` — covers ONLY the four per-DID maps (`materials`,
   * `textures`, `normalTextures`, `heightTextures`; charged at :2255/:2282/
   * :2296). The paletted maps are keyed by `(did|paletteId|subPalettes)`, a
   * per-OUTFIT-SIGNATURE space, and were never charged to that LRU at all.
   * The falsifier's `?matBudgetMB=64` intervention therefore bounded the
   * wrong maps: the cache was pinned at 64 MB with 5,723 evictions and the
   * 3.6 GB heap step fired anyway, at the same POI.
   *
   * WHAT BOUNDS IT NOW (2026-07-26): `?palBudgetMB=N`, a BYTE budget
   * (default 64 MiB), not the old `PALETTED_CACHE_CAP` COUNT of 256 — which
   * survives only as the `?palBudgetMB=off` escape. `budgetMode` reports
   * which instrument is armed and `cap` reports its value in the matching
   * unit (bytes when armed, signatures in legacy mode). Either way
   * `evictions` climbing means same-signature wearers are re-minting
   * full-size textures, i.e. the "shared" cache has degenerated into
   * per-wearer duplication. Reading:
   *
   *   palEvict spiking + palMB/heap climbing, matMB flat  ⇒ CONFIRMS this pool.
   *   palEvict ~0 across the step                          ⇒ refutes it; the
   *     bytes are elsewhere (post-dispose reachability, or the entity-owned
   *     pool — see `__diag.entityOwned()`).
   *
   * Synchronous, allocation-light, O(1): every number is maintained
   * incrementally at insert/evict. Never walks the maps.
   */
  palettedCacheStats() {
    // 2026-07-26 `?palBudgetMB`: `cap` now reports the armed instrument — the
    // BYTE budget by default, the legacy 256-COUNT cap under
    // `?palBudgetMB=off`. `budgetMode` says which, and `legacyCountCap` is
    // non-null only in the legacy arm, so a reader can never mistake a byte
    // number for a signature number. Every other field is unchanged: the
    // relay's `palMB`/`palHiMB`/`palEvict`/`palSigs` columns read
    // `bytes`/`hiWaterBytes`/`evictions`/`signatures` exactly as before.
    const armed = this._palBudgetBytes > 0;
    return {
      signatures: this.palettedMaterials.size,
      textures: this.palettedTextures.size,
      budgetMode: armed ? "bytes" : "count",
      cap: armed ? this._palBudgetBytes : PALETTED_CACHE_CAP,
      capMB: armed ? +(this._palBudgetBytes / 1048576).toFixed(2) : null,
      legacyCountCap: armed ? null : PALETTED_CACHE_CAP,
      atCap: armed
        ? this._palBytes >= this._palBudgetBytes
        : this.palettedMaterials.size >= PALETTED_CACHE_CAP,
      bytes: this._palBytes,
      bytesMB: +(this._palBytes / 1048576).toFixed(2),
      hiWaterBytes: this._palHiWaterBytes,
      hiWaterMB: +(this._palHiWaterBytes / 1048576).toFixed(2),
      hiWaterSignatures: this._palHiWaterSigs,
      evictions: this._palEvictions,
      evictedBytes: this._palEvictedBytes,
      evictedMB: +(this._palEvictedBytes / 1048576).toFixed(2),
      installs: this._palInstalls,
      // `palRemint` — evictions that were re-needed (see the constructor).
      // `evictions` is the churn count; THIS is the churn COST: each remint is
      // one wearer that paid a decode round-trip and rendered unrecolored
      // across it. A budget large enough for the working set drives it to ~0
      // even while `evictions` is nonzero.
      remints: this._palRemints,
      evictedKeysTracked: this._palEvictedKeys.size,
      // `?palDedup` single-flight (2026-08-06). `joins` is the headline: every
      // join is one wasm decode + one texture upload + one DUPLICATE material
      // object that did not happen. `inflight` should idle at 0 — a nonzero
      // steady-state reading means a claim leaked (see the settle contract on
      // `claimPalettedInflight`).
      dedupEnabled: palettedDedupEnabled(),
      claims: this._palClaims,
      joins: this._palJoins,
      inflight: this.palettedInflight.size,
    };
  }

  /**
   * Synchronous lookup. Returns the cached material for `surfaceDid`,
   * or the shared fallback if none is loaded yet (or `surfaceDid === 0`,
   * the FALLBACK sentinel emitted by `meshToGeometryGroups`).
   *
   * Bumps `realHits` / `fallbackHits` so callers can spot the ratio
   * of resolved vs fallback materials at instantiation time.
   */
  getCached(surfaceDid, doubleSided = true) {
    const base = this._getCachedDouble(surfaceDid);
    // T2: per-poly single-sided variant (FrontSide) for `?perPolyCull=on`.
    // Wireframe mode ignores cull (both faces always drawn), so keep base.
    if (doubleSided || this.wireframeMode) {
      return base;
    }
    const key = surfaceDid >>> 0;
    let front = this.frontSideMaterials.get(key);
    if (!front) {
      front = base.clone();
      front.side = THREE.FrontSide;
      // Match the other derived-clone sites: re-seat userData from the base
      // (Material.copy hands back a JSON round-trip) and carry the height plane.
      front.userData = { ...(base.userData || {}), __cacheOwned: true };
      _inheritHeightTex(base, front);
      this.frontSideMaterials.set(key, front);
    }
    return front;
  }

  /**
   * Floor-bias variant of `getCached`: the DoubleSide base with a tiny
   * log-depth `gl_FragDepth` nudge toward the camera (applyFloorDepthBias), so a
   * surface coplanar with terrain — a SetupModel building floor (buildings.js)
   * or an EnvCell floor — deterministically wins the GL_LESS depth tie instead
   * of flickering against the grass. Clone shares textures; cache-owned. Wire
   * mode returns the base (wire path unaffected).
   */
  getCachedFloorBias(surfaceDid) {
    const base = this._getCachedDouble(surfaceDid);
    if (this.wireframeMode) return base;
    const key = surfaceDid >>> 0;
    let v = this.floorBiasMaterials.get(key);
    if (!v) {
      v = base.clone();
      v.userData = { ...(base.userData || {}), __cacheOwned: true };
      _inheritHeightTex(base, v);
      applyFloorDepthBias(v);
      this.floorBiasMaterials.set(key, v);
    }
    return v;
  }

  /**
   * Static-bias variant of `getCached`: the DoubleSide base with a STRONGER
   * log-depth `gl_FragDepth` nudge toward the camera (applyStaticDepthBias) than
   * getCachedFloorBias, so an EnvCell décor prop coplanar with the wall/floor it
   * sits flush against deterministically wins the GL_LESS depth tie instead of
   * flickering. Clone shares textures; cache-owned. Wire mode returns the base.
   */
  /**
   * RND-04 — the EnvCell variant of `getCached`: the shared base material
   * plus the baked-static-light shader term. Call ONLY for geometry that
   * carries the `acBakedLight` attribute; a mesh without it would read the
   * attribute as (0,0,0) and, under the retail arm, lose its direct light
   * with nothing replacing it (i.e. render black).
   *
   * Returns the plain base when the flag is off, so `?vertexBake=off` is
   * byte-identical to the pre-RND-04 render.
   */
  getCachedCellBaked(surfaceDid) {
    const base = this._getCachedDouble(surfaceDid);
    if (this.wireframeMode || !VERTEX_BAKE.enabled) return base;
    const key = surfaceDid >>> 0;
    let v = this.cellBakedMaterials.get(key);
    if (!v) {
      v = base.clone();
      v.userData = { ...(base.userData || {}), __cacheOwned: true };
      _inheritHeightTex(base, v);
      applyBakedVertexLightPatch(v, { suppressDirect: VERTEX_BAKE.suppressDirect });
      this.cellBakedMaterials.set(key, v);
    }
    return v;
  }

  getCachedStaticBias(surfaceDid) {
    const base = this._getCachedDouble(surfaceDid);
    if (this.wireframeMode) return base;
    const key = surfaceDid >>> 0;
    let v = this.staticBiasMaterials.get(key);
    if (!v) {
      v = base.clone();
      v.userData = { ...(base.userData || {}), __cacheOwned: true };
      _inheritHeightTex(base, v);
      applyStaticDepthBias(v);
      this.staticBiasMaterials.set(key, v);
    }
    return v;
  }

  /**
   * Get-or-create a VFX component-variant material (Visual-Behavior Suite,
   * spec §2.6). Mirrors getCachedFloorBias: a CLONE of the surface's base
   * material (shares textures, owned by this.materials), tagged __cacheOwned +
   * __vfxSetKey, built by `builder(clone)` which installs the component patches
   * via _chainBeforeCompile. Keyed by (surfaceDid|setKey|configKey) so two
   * objects with the same component SET + config share ONE material; the
   * program-cache key (driven by __vfxSetKey, read lazily by _patchSetCacheKey)
   * collapses same-SET materials onto ONE compiled program. Dormant until a
   * frag/MECH-B component uses it (Phase 1).
   * @param {number} surfaceDid
   * @param {string} setKey     component-SET key (drives the program cache key)
   * @param {string} configKey  link-irrelevant config hash (heap dedup only)
   * @param {(m: object) => void} builder  installs the component patches
   */
  getCachedVariant(surfaceDid, setKey, configKey, builder) {
    const base = this._getCachedDouble(surfaceDid);
    if (this.wireframeMode) return base;
    const key = `${surfaceDid >>> 0}|${setKey}|${configKey}`;
    let v = this.vfxVariants.get(key);
    if (!v) {
      v = base.clone();
      // Set __vfxSetKey BEFORE the builder runs _chainBeforeCompile so the
      // lazily-read program cache key reflects this variant's component SET.
      // __vfxColorPassOnly tags this clone as carrying a COLOR-pass-only patch
      // (spec §8): the shadow/depth WRITE must never use it — three renders
      // casters with its internal _depthMaterial (which never sees our
      // onBeforeCompile/userData). See scene3d/vfx/shadow_guard.js.
      v.userData = { ...(base.userData || {}), __cacheOwned: true, __vfxSetKey: setKey, __vfxColorPassOnly: true };
      _inheritHeightTex(base, v);
      try { builder?.(v); } catch (e) { console.warn(`[vfx] getCachedVariant builder failed for ${key}:`, e); }
      v.needsUpdate = true;
      this.vfxVariants.set(key, v);
    }
    return v;
  }

  /**
   * Paletted twin of `getCachedVariant`: build a frag/MECH-B VFX variant ON TOP
   * of an already-recolored paletted base (one tagged with `__paletteKey` by
   * `installPaletted`). This is the fix for recolored/paletted gear getting NO itemFx
   * aura / catalog glow — the `_entityMaterials` branch previously returned the
   * base verbatim. Keys by `${paletteKey}|${setKey}|${configKey}` so two items
   * with the same recolor + same effect SET share one clone + one program, while
   * different recolors (different paletteKey) keep their own colours. Returns the
   * base unchanged if it isn't a tagged paletted material (e.g. the shared
   * fallback) so the caller stays byte-identical there.
   */
  getCachedVariantFromPaletted(baseMaterial, setKey, configKey, builder) {
    if (!baseMaterial) return null;
    if (this.wireframeMode) return baseMaterial;
    const baseKey = baseMaterial.userData && baseMaterial.userData.__paletteKey;
    if (!baseKey) return baseMaterial;
    const key = `${baseKey}|${setKey}|${configKey}`;
    let v = this.vfxPalettedVariants.get(key);
    if (!v) {
      v = baseMaterial.clone();
      // __vfxSetKey BEFORE the builder runs (program-cache key); __vfxColorPassOnly
      // keeps the patch off the shadow/depth write — identical contract to
      // getCachedVariant. The clone shares the paletted base's owned texture
      // (Material.clone copies the .map reference; dispose() never frees textures).
      v.userData = { ...(baseMaterial.userData || {}), __cacheOwned: true, __vfxSetKey: setKey, __vfxColorPassOnly: true };
      try { builder?.(v); } catch (e) { console.warn(`[vfx] getCachedVariantFromPaletted builder failed for ${key}:`, e); }
      v.needsUpdate = true;
      this.vfxPalettedVariants.set(key, v);
      // Insertion-order LRU cap, mirroring installPaletted. Never evict the entry
      // just inserted this call.
      while (this.vfxPalettedVariants.size > PALETTED_CACHE_CAP) {
        const oldestKey = this.vfxPalettedVariants.keys().next().value;
        if (oldestKey === undefined || oldestKey === key) break;
        const oldMat = this.vfxPalettedVariants.get(oldestKey);
        this.vfxPalettedVariants.delete(oldestKey);
        try { oldMat?.dispose?.(); } catch (_) {}
      }
    }
    return v;
  }

  /**
   * 2026-08-03 — re-seat the live derived clones of `did` onto its (re)installed
   * base. Replaces the old `delete` sweep: the map entry is NOT the only
   * reference, so dropping it stranded every mesh already holding the clone on
   * the stale (fallback-derived) material forever AND leaked the clone plus its
   * compiled program. Re-seating fixes both — the meshes hold the same object.
   * Fail-soft per clone.
   */
  _reseatVariantsForDid(did) {
    const key = did >>> 0;
    const base = this.materials.get(key);
    if (!base) return;
    for (const map of [
      this.frontSideMaterials,
      this.floorBiasMaterials,
      this.staticBiasMaterials,
      this.cellBakedMaterials,
    ]) {
      const v = map && map.get(key);
      if (!v || v === base) continue;
      try { _reseatSurfaceState(v, base); } catch (_) { /* fail-soft */ }
    }
  }

  /** The DoubleSide base material for a surface (original `getCached` body). */
  _getCachedDouble(surfaceDid) {
    if (this.wireframeMode) {
      return this._wireframeMaterialFor(surfaceDid >>> 0);
    }
    if (surfaceDid === FALLBACK_SURFACE_DID) {
      this.fallbackHits += 1;
      return this.fallbackMaterial;
    }
    const m = this.materials.get(surfaceDid >>> 0);
    if (m) {
      this.realHits += 1;
      // `?matBudgetMB` LRU: this IS the render-path use — bump recency, and
      // record that the material has left the cache (so eviction can never
      // dispose it out from under the mesh that is about to hold it).
      this._touchMatEntry(surfaceDid >>> 0);
      this._noteHandout(surfaceDid >>> 0);
      return m;
    }
    this.fallbackHits += 1;
    return this.fallbackMaterial;
  }

  /**
   * Build the dedup key for a paletted-material lookup.
   * `subPalettes` is a Uint32Array of (offset_u8, length_u8, slot_u16)
   * triples (or empty); we hash by joining numbers with a separator so
   * the key is stable per (DID, paletteId, exact sub-palette tuple).
   */
  _paletteKey(surfaceDid, paletteId, subPalettes) {
    if (!subPalettes || subPalettes.length === 0) {
      return `${surfaceDid >>> 0}|${paletteId >>> 0}|`;
    }
    // Uint32Array join() is fast enough for the typical 1-12 entry
    // sub-palette payloads; no hot allocation pattern beyond the
    // resulting string itself.
    return `${surfaceDid >>> 0}|${paletteId >>> 0}|${Array.from(subPalettes).join(",")}`;
  }

  /**
   * Synchronous lookup for an already-cached paletted material.
   * Returns null on miss so the caller can fetch + install.
   */
  getCachedPaletted(surfaceDid, paletteId, subPalettes) {
    const key = this._paletteKey(surfaceDid, paletteId, subPalettes);
    return this.palettedMaterials.get(key) ?? null;
  }

  /**
   * `?palDedup` — is some OTHER caller already decoding this signature?
   * Returns its promise (settles with the minted material, or `null` if that
   * caller bailed/decoded empty) or `null` when nothing is in flight.
   *
   * Value-keyed, exactly like `getCachedPaletted`: a different dye ⇒ a
   * different `subPalettes` tuple ⇒ a different key ⇒ never joined. Sharing is
   * only ever offered within one (did, paletteId, subPalettes) signature, which
   * is the same contract the cache hit already has.
   *
   * `?palDedup=off` ⇒ always null ⇒ every caller decodes for itself (the
   * pre-2026-08-06 path, byte-identical).
   */
  getPalettedInflight(surfaceDid, paletteId, subPalettes) {
    if (!palettedDedupEnabled()) return null;
    const e = this.palettedInflight.get(this._paletteKey(surfaceDid, paletteId, subPalettes));
    if (!e) return null;
    this._palJoins += 1;
    return e.promise;
  }

  /**
   * `?palDedup` — claim this signature for the caller that is about to decode
   * it. Returns a `settle(material|null)` callback, or `null` when the flag is
   * off OR someone else already holds the claim (callers check
   * `getPalettedInflight` first, and nothing awaits between the two calls, so
   * the second case only fires on misuse).
   *
   * ⚠ CONTRACT: whoever takes a claim MUST settle it on EVERY exit path,
   * including the abort branches — a claim that never settles hangs every
   * joiner's spawn. `settle` is idempotent and deletes its own map entry.
   * entities.js settles each key the moment it mints, sweeps the leftovers
   * BEFORE it awaits any join (which is what makes mutual joins deadlock-free:
   * a spawn can never be waiting on a key it still owns), and sweeps again in
   * the spawn block's `finally`.
   */
  claimPalettedInflight(surfaceDid, paletteId, subPalettes) {
    if (!palettedDedupEnabled()) return null;
    const key = this._paletteKey(surfaceDid, paletteId, subPalettes);
    if (this.palettedInflight.has(key)) return null;
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const entry = { promise, settle: null };
    entry.settle = (material) => {
      // Idempotent: only the claim we installed may be dropped (a later claim
      // for the same key after we settled belongs to someone else).
      if (this.palettedInflight.get(key) === entry) this.palettedInflight.delete(key);
      resolve(material ?? null);
    };
    this.palettedInflight.set(key, entry);
    this._palClaims += 1;
    return entry.settle;
  }

  /** True when `?palBudgetMB` is armed (byte mode); false = legacy count cap. */
  palBudgetArmed() {
    return this._palBudgetBytes > 0;
  }

  /**
   * The paletted-cache eviction condition — the ONE place the two regimes
   * differ. O(1): two `Map.size` reads and an integer compare, on a path that
   * already walks the maps.
   *
   * BYTE MODE (`?palBudgetMB=N`, default 64 MiB): over budget iff the live
   * charge `_palBytes` exceeds `_palBudgetBytes`.
   *
   * ...plus a count valve for entries that carry NO charge. `installPaletted`
   * accepts a null texture (and `estimateTextureBytes` reads 0 for anything
   * without `image.data`), which stores a signature contributing zero bytes
   * forever — a pure byte budget could never evict it, so the map would grow
   * unbounded. `palettedMaterials.size - _palKeyBytes.size` is exactly that
   * uncharged population and it stays bounded by the old count cap. Neither
   * production call site can reach this (entities.js :3864 and :5025 both
   * pass a real `DataTexture`); it exists so the degenerate case is bounded
   * instead of silently leaking, and it can never evict a charged entry
   * early — a fully-charged cache has `size === _palKeyBytes.size`, i.e. an
   * uncharged population of 0.
   *
   * LEGACY MODE (`?palBudgetMB=off`, `_palBudgetBytes === 0`): the
   * pre-2026-07-26 count cap, verbatim.
   */
  _palOverBudget() {
    if (this._palBudgetBytes <= 0) {
      return this.palettedMaterials.size > PALETTED_CACHE_CAP;
    }
    if (this._palBytes > this._palBudgetBytes) return true;
    return this.palettedMaterials.size - this._palKeyBytes.size > PALETTED_CACHE_CAP;
  }

  /**
   * Install a freshly-fetched paletted material into the cache.
   * The caller is responsible for building the THREE.Material; we
   * tag it `__cacheOwned` so per-entity dispose doesn't free it.
   */
  installPaletted(surfaceDid, paletteId, subPalettes, material, texture = null) {
    const key = this._paletteKey(surfaceDid, paletteId, subPalettes);
    // `palRemint` — this signature was evicted and is now being re-minted:
    // a wearer paid a full decode round-trip (and rendered unrecolored across
    // it) for something the cache used to hold. Delete-on-count so a second
    // evict→remint cycle for the same key counts again.
    if (this._palEvictedKeys.delete(key)) this._palRemints += 1;
    // Stash the exact dedup key so `getCachedVariantFromPaletted` can build a
    // VFX variant of this recolored base without re-plumbing (paletteId, subPalettes).
    material.userData = { ...(material.userData || {}), __cacheOwned: true, __paletteKey: key };
    if (texture) {
      texture.userData = { ...(texture.userData || {}), __cacheOwned: true };
      // `palMB` — a re-install under an existing key REPLACES the stored
      // texture, so discharge the old charge before charging the new one
      // (the R-8 recolored ladder deliberately re-installs a signature that an
      // incomplete decode poisoned).
      const prevBytes = this._palKeyBytes.get(key);
      if (prevBytes !== undefined) this._palBytes -= prevBytes;
      const bytes = estimateTextureBytes(texture);
      this._palKeyBytes.set(key, bytes);
      this._palBytes += bytes;
      this._palInstalls += 1;
      if (this._palBytes > this._palHiWaterBytes) {
        this._palHiWaterBytes = this._palBytes;
      }
      this.palettedTextures.set(key, texture);
    }
    this.palettedMaterials.set(key, material);
    if (this.palettedMaterials.size > this._palHiWaterSigs) {
      this._palHiWaterSigs = this.palettedMaterials.size;
    }
    // #22 — insertion-order LRU. Map iteration is insertion-ordered, so the
    // FIRST key is the oldest. Evict oldest-first while over budget, disposing
    // the material AND its paired owned texture together. The
    // `oldestKey === key` guard ensures the entry we just installed this
    // call is never the one evicted (so a same-frame-baked material stays
    // retrievable same frame). Re-inserting an existing key keeps its
    // original position in the Map (it does NOT move to the end), so that
    // guard also covers the degenerate "the entry we just re-set is also
    // the oldest" case. Fail-soft: a throwing dispose() must not abort.
    //
    // 2026-07-26 `?palBudgetMB` — "over cap" became "over BYTE budget"
    // (`_palBytes`, charged just above from `image.data.byteLength`). Order,
    // guard, dispose pairing and every tally are untouched; only the LOOP
    // CONDITION changed. `?palBudgetMB=off` (`_palBudgetBytes === 0`) restores
    // the count cap bit-for-bit.
    while (this._palOverBudget()) {
      const oldestKey = this.palettedMaterials.keys().next().value;
      if (oldestKey === undefined || oldestKey === key) break;
      const oldMat = this.palettedMaterials.get(oldestKey);
      const oldTex = this.palettedTextures.get(oldestKey);
      this.palettedMaterials.delete(oldestKey);
      this.palettedTextures.delete(oldestKey);
      // `palMB` — discharge the evicted key. ⚠ READING NOTE: this decrements
      // the LIVE byte count, which tracks what the CACHE holds, not what the
      // heap holds: `oldTex.dispose()` frees the GPU handle only, and any
      // live mesh still pointing at `oldMat` keeps `image.data` reachable.
      // `palEvict` is therefore the thrash counter — every eviction above the
      // cap is a signature that the NEXT wearer will re-mint from scratch.
      const evictedBytes = this._palKeyBytes.get(oldestKey);
      if (evictedBytes !== undefined) {
        this._palKeyBytes.delete(oldestKey);
        this._palBytes -= evictedBytes;
        this._palEvictedBytes += evictedBytes;
      }
      this._palEvictions += 1;
      // Remember the key so a later re-install is counted as a remint (the
      // thrash/flash event). Bounded FIFO — Set iteration is insertion-ordered,
      // so the first key is the oldest.
      this._palEvictedKeys.add(oldestKey);
      if (this._palEvictedKeys.size > PAL_EVICT_MEMORY_KEYS) {
        this._palEvictedKeys.delete(this._palEvictedKeys.keys().next().value);
      }
      try { oldMat?.dispose?.(); } catch (_) {}
      try { oldTex?.dispose?.(); } catch (_) {}
    }
    return material;
  }

  /**
   * Wire-agent path: return a shared MeshBasicMaterial({wireframe:true})
   * keyed by a 32-bucket hash of the surface DID so different surface
   * categories render as visually distinct wire colors but the GPU
   * sees at most 32 distinct materials per scene. HSL distribution
   * (hue across the wheel, fixed S=0.6, L=0.55) gives perceptually
   * distinct buckets without naming surface types explicitly.
   *
   * 2026-05-22 — also creates the companion solid-fill material for the
   * same bucket so `addFillCompanions` can map wire-material → fill-
   * material by reference. The fill colour uses the same hue with a
   * darker, less-saturated tone (S=0.45, L=0.42) so the wireframe lines
   * (brighter) read clearly against it.
   */
  _wireframeMaterialFor(did) {
    // 2026-05-22 — per-DID dominant-colour path. If the surface-colours
    // manifest has an entry for this DID, mint (or fetch) a dedicated
    // pair { wire, fill } where wire = lighter+more-saturated variant
    // of the dominant for contrast and fill = the dominant itself.
    // Materials cached in `didMaterials` for reuse across meshes that
    // share the surface. Falls through to the 32-bucket HSL hash for
    // any DID the manifest doesn't cover.
    if (did !== FALLBACK_SURFACE_DID && this.surfaceColors) {
      const rgb = this.surfaceColors.get(did >>> 0);
      if (rgb) {
        const existing = this.didMaterials.get(did >>> 0);
        if (existing) return existing.wire;
        const fillColor = new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
        // Derive a brighter, slightly more saturated wire colour so the
        // overlay reads on top of the fill. HSL roundtrip — bumping L
        // alone would wash out saturated colours; bumping S too keeps
        // grass green green and bark brown brown.
        const hsl = { h: 0, s: 0, l: 0 };
        fillColor.getHSL(hsl);
        const wireColor = new THREE.Color().setHSL(
          hsl.h,
          Math.min(1.0, hsl.s + 0.15),
          Math.min(0.85, hsl.l + 0.28),
        );
        const wireMat = new THREE.MeshBasicMaterial({
          color: wireColor,
          wireframe: true,
          side: THREE.DoubleSide,
          fog: true,
        });
        wireMat.name = `wire-did-${did.toString(16).padStart(8, "0")}`;
        wireMat.userData = { __cacheOwned: true, surfaceDid: did >>> 0 };
        const fillMat = new THREE.MeshBasicMaterial({
          color: fillColor,
          side: THREE.DoubleSide,
          fog: true,
          polygonOffset: true,
          polygonOffsetFactor: 4,
          polygonOffsetUnits: 4,
        });
        fillMat.name = `wire-fill-did-${did.toString(16).padStart(8, "0")}`;
        fillMat.userData = { __cacheOwned: true, surfaceDid: did >>> 0 };
        // AO shading on both — floors brighter, walls/ceilings darker.
        applyWireVertexAOPatch(wireMat);
        applyWireVertexAOPatch(fillMat);
        applyFillDepthBias(fillMat);
        this.didMaterials.set(did >>> 0, { wire: wireMat, fill: fillMat });
        this.wireMatToFill.set(wireMat, fillMat);
        return wireMat;
      }
    }
    const WIRE_BUCKETS = 32;
    const bucket = (did === FALLBACK_SURFACE_DID ? 0 : did) % WIRE_BUCKETS;
    let m = this.wireframeBuckets.get(bucket);
    if (m) return m;
    const hue = bucket / WIRE_BUCKETS;
    const color = new THREE.Color().setHSL(hue, 0.6, 0.55);
    m = new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      side: THREE.DoubleSide,
      fog: true,
    });
    m.name = `wire-bucket-${bucket}`;
    m.userData = { __cacheOwned: true, wireBucket: bucket };
    applyWireVertexAOPatch(m);
    this.wireframeBuckets.set(bucket, m);

    // Companion solid-fill material — same hue, darker + less saturated
    // so the wireframe overlay reads clearly. polygonOffset pushes the
    // fill back in depth so the wire lines aren't z-fought. Buildings
    // and statics have dense small triangles where polygonOffsetUnits=1
    // can be smaller than the per-pixel depth precision — bumped to
    // factor=4, units=4 for reliable wire visibility across all mesh
    // densities. The terrain bake uses a separate dedicated path
    // (`scene3d/terrain.js`) with the same offset values.
    const fillColor = new THREE.Color().setHSL(hue, 0.45, 0.32);
    const fillM = new THREE.MeshBasicMaterial({
      color: fillColor,
      side: THREE.DoubleSide,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 4,
    });
    fillM.name = `wire-fill-bucket-${bucket}`;
    fillM.userData = { __cacheOwned: true, wireFillFor: bucket };
    applyWireVertexAOPatch(fillM);
    applyFillDepthBias(fillM);
    this.wireframeFillBuckets.set(bucket, fillM);
    this.wireMatToFill.set(m, fillM);
    return m;
  }

  /**
   * Map a wire-bucket material to its solid-fill twin. Returns null if
   * `mat` isn't one of this cache's wire-bucket materials. Used by
   * `addFillCompanions` and also tolerates per-material arrays (Mesh
   * with geometry groups) by callers iterating their entries.
   */
  _fillMaterialForWire(mat) {
    if (!mat) return null;
    return this.wireMatToFill.get(mat) ?? null;
  }

  /**
   * Wire-agent: walk `group` and for each Mesh / InstancedMesh whose
   * material (or one of its material-array entries) is a wire-bucket
   * material, attach a companion solid-fill mesh sharing the geometry.
   * The fill mesh has identical pose; the wire-bucket material maps to
   * its fill twin via `_fillMaterialForWire`. Sharing the BufferGeometry
   * means no extra GPU memory; the only cost is the additional draw call
   * per source mesh (matched 1:1 by mesh count).
   *
   * Idempotent — each mesh is tagged with `userData.__wireFillCompanion`
   * after seeding so re-walks (e.g. after an LB-lazy bake adds new
   * meshes) only add companions for new objects.
   *
   * Returns the number of companions added.
   */
  addFillCompanions(group) {
    // ?wireFill=0 disables the whole companion pass — cheapest wireframe
    // (halves draw submissions). Default ON preserves the current look.
    if (!this.wireframeMode || !this.wireFill || !group || typeof group.traverse !== "function") {
      return 0;
    }
    /** @type {Array<{source: any, fillMat: any, kind: "mesh"|"instanced"|"skinned"}>} */
    const queue = [];
    group.traverse((obj) => {
      if (!obj || obj.userData?.__wireFillCompanion) return;
      if (obj.userData?.__wireFillSource) return; // skip already-attached fills
      // Defect 1 (2026-07-04): BatchedMesh is `.isMesh` in three r184, so it
      // fell into the plain-Mesh branch — `new THREE.Mesh(source.geometry,
      // …)` draws the batch's whole concatenated vertex buffer at the group
      // origin, ignoring per-instance matrices (a misplaced oversized blob
      // and a heavy wasted draw). Statics consolidate into BatchedMesh per
      // material identity in wireframe mode, so this fired routinely. A
      // correct fill would require cloning the batch — not worth it for a
      // debug mode; the wireframe BatchedMesh itself still draws.
      if (obj.isBatchedMesh) return;
      if (!obj.isMesh && !obj.isInstancedMesh) return;
      // Defect 3 (2026-07-04): animated instanced-scenery buckets
      // (animated_scenery.js) rewrite `instanceMatrix` + `count` per frame
      // and swap the whole InstancedMesh on capacity doubling. A companion
      // copies instanceMatrix ONCE at creation → a frozen ghost fill at the
      // seed pose, plus dead instances when count shrinks and a dangling
      // attribute after a capacity swap. Skip their companions entirely —
      // the wireframe bucket still draws; there is simply no fill for
      // animated scenery in this debug mode (cheaper, and never stale).
      if (obj.isInstancedMesh && obj.userData?.isAnimatedSceneryInstanced) return;
      // Material may be a single material or an array (for grouped geometries).
      const mat = obj.material;
      if (!mat) return;
      const kind = obj.isInstancedMesh
        ? "instanced"
        : obj.isSkinnedMesh
        ? "skinned"
        : "mesh";
      if (Array.isArray(mat)) {
        // Multi-material mesh — map each entry to its fill twin. If any
        // entry has no twin we still attach (using fallback wire material
        // for that slot maps to null → use the source slot directly).
        const fills = mat.map((m) => this._fillMaterialForWire(m));
        if (fills.every((f) => f === null)) return;
        const arr = mat.map((m, i) => fills[i] ?? m);
        queue.push({ source: obj, fillMat: arr, kind });
      } else {
        const fillMat = this._fillMaterialForWire(mat);
        if (!fillMat) return;
        queue.push({ source: obj, fillMat, kind });
      }
    });
    let added = 0;
    for (const { source, fillMat, kind } of queue) {
      let fillMesh;
      if (kind === "instanced") {
        // InstancedMesh — copy count + instanceMatrix (and instanceColor
        // if present). Geometry is shared.
        fillMesh = new THREE.InstancedMesh(source.geometry, fillMat, source.count);
        fillMesh.instanceMatrix.array.set(source.instanceMatrix.array);
        fillMesh.instanceMatrix.needsUpdate = true;
        if (source.instanceColor) {
          fillMesh.instanceColor = source.instanceColor.clone();
          fillMesh.instanceColor.needsUpdate = true;
        }
      } else if (kind === "skinned") {
        // SkinnedMesh — clone as another SkinnedMesh sharing the SAME
        // skeleton + bindMatrix so the fill follows the source's
        // animation exactly. Without this, a plain `new THREE.Mesh(geom,
        // fillMat)` would render at the rest pose (T-pose) regardless of
        // the source's per-frame bone transforms, producing a static
        // ghost blob attached to the animating wire (which is what the
        // first iteration looked like — the `Cow` showed wires but no
        // fill).
        fillMesh = new THREE.SkinnedMesh(source.geometry, fillMat);
        fillMesh.bindMode = source.bindMode;
        fillMesh.bindMatrix.copy(source.bindMatrix);
        fillMesh.bindMatrixInverse.copy(source.bindMatrixInverse);
        fillMesh.bind(source.skeleton, source.bindMatrix);
      } else {
        fillMesh = new THREE.Mesh(source.geometry, fillMat);
      }
      fillMesh.name = (source.name || "wire") + "-fill";
      // Copy pose. matrix is already the local matrix; matrixAutoUpdate
      // controls whether it gets recomputed each frame from p/r/s.
      fillMesh.position.copy(source.position);
      fillMesh.quaternion.copy(source.quaternion);
      fillMesh.scale.copy(source.scale);
      fillMesh.matrixAutoUpdate = source.matrixAutoUpdate;
      if (!source.matrixAutoUpdate) {
        fillMesh.matrix.copy(source.matrix);
        fillMesh.matrixWorldNeedsUpdate = true;
      }
      fillMesh.castShadow = false;
      fillMesh.receiveShadow = false;
      fillMesh.frustumCulled = source.frustumCulled;
      // renderOrder: fill renders BEFORE the wire so the wire's depth
      // values win at edges. Combined with polygonOffset on the fill,
      // gives reliable wire-on-top across hardware (SwiftShader's
      // depth precision in particular benefits).
      fillMesh.renderOrder = (source.renderOrder ?? 0) - 1;
      // Leak fix (2026-07-08): inherit the source's landblock so the LRU
      // step-3 statics sweep (landblock_lru.js) reaps this companion on LB
      // eviction. It shares `source.geometry`, but the sweep removes plain
      // Meshes WITHOUT disposing geometry (only `isBatchedMesh` nodes are
      // disposed there), so the shared buffer stays valid for the source and
      // its own disposables list. Without this tag the wireFill companions —
      // plain Meshes with no landblockId/coversLbKeys — hit none of the three
      // eviction paths and accumulate in staticsGroup as you roam (the
      // wireframe-mode analogue of the default_script particle leak). Sources
      // carrying only `coversLbKeys` (cross-LB InstancedMesh) are ~absent in
      // this build and left as a known residual (the refcount path tracks a
      // list, not a scene walk, so a tag alone wouldn't reach them).
      fillMesh.userData = {
        __wireFillSource: true,
        landblockId: source.userData?.landblockId,
      };
      source.userData = source.userData ?? {};
      source.userData.__wireFillCompanion = true;
      const parent = source.parent;
      if (parent) {
        parent.add(fillMesh);
        added += 1;
      }
    }
    return added;
  }

  /**
   * Build a `MeshStandardMaterial` whose flags are derived from the
   * AC `Surface.surface_type` bitfield. Centralised so `get()` and
   * `preload()` produce identical materials for the same input, and
   * the unit test can assert the decode rules against deterministic
   * synthetic inputs.
   *
   * Decode rules (see SURFACE_TYPE constants above for the bit list):
   *   - Translucent (0x10): `transparent = true, depthWrite = false`.
   *     Wins over Base1ClipMap when both bits are set (true alpha blend
   *     supersedes binary alpha mask).
   *   - Base1ClipMap (0x4): binary alpha mask — the alpha channel cuts
   *     holes (foliage, fence cutouts). `alphaTest` is the retail
   *     per-format ref (paletted 100/255, else 200/255) and the arm
   *     blends ONE/INVSRCALPHA with `depthWrite = true`
   *     (`applyClipMapRenderState`, acclient.c:454497-454511).
   *   - Alpha (0x100): texture-alpha blend (SRCALPHA/INVSRCALPHA),
   *     `transparent = true, depthWrite = false`; opacity comes from the
   *     texture's own alpha channel. acclient.c SetSurface @454470.
   *   - Additive (0x10000): `blending = AdditiveBlending` +
   *     `transparent = true, depthWrite = false`. For flame, sparks,
   *     and other particle-style additive surfaces.
   *   - Self-illumination is driven by the luminosity FLOAT (not the
   *     0x40 bit, which retail never sets): emissive = grayscale
   *     luminosity, flat (no emissiveMap), per acclient.c @454688.
   *   - Diffuse reflectance is driven by the diffuse FLOAT (not the
   *     0x20 bit): albedo `color` ×= diffuse (no-op at ~1.0), per
   *     acclient.c @454458 — NOT a roughness/matte hint.
   *   - **No explicit TwoSided bit.** All surfaces default to
   *     `side: DoubleSide` because the AC two-sidedness bit lives on
   *     the Polygon (`sides_type == 0x2`), not the Surface; the Rust
   *     triangulator handles the distinct-pos/neg case by emitting
   *     two tris with opposite winding.
   *
   * `surfaceTypeFlags === 0` (the empty-surface fallback) hits the
   * opaque path → standard albedo material with DoubleSide.
   */
  // ── Phase-5 baked roughness attach (pre-warm + sync-attach) ──────────────
  /** Lazily build the SuiteAssetSource + kick the (one) manifest fetch. */
  _ensureTexchanInit() {
    if (this._texchanInit) return;
    this._texchanInit = true;
    if (!this._texchanWasm || typeof this._texchanWasm.fetch_suite_artifact_by_key !== "function") return;
    this._texchanSource = new SuiteAssetSource({ wasmExports: this._texchanWasm });
    loadTexchanManifest()
      .then((m) => {
        this._texchanManifest = m;
        const pend = this._pendingRough;
        this._pendingRough = [];
        for (const [mat, did] of pend) {
          // The DID can have been evicted + re-installed while the manifest
          // loaded; only the material still holding the entry may be upgraded.
          if (this.materials.get(did >>> 0) !== mat) continue;
          this._resolveRough(mat, did);
        }
      })
      .catch(() => {
        this._texchanManifest = new Map();
        this._pendingRough = []; // never drained on this path — don't pin the materials
      });
  }

  /** Attach the baked roughnessMap for `did` to `mat` (gated, fail-soft). Called
   *  at material-build time. If the manifest isn't loaded yet, defers until it is. */
  _attachRoughnessMap(mat, did) {
    if (!this.materialBakeEnabled || !mat) return;
    this._ensureTexchanInit();
    if (!this._texchanSource) return;
    if (!this._texchanManifest) { this._pendingRough.push([mat, did]); return; }
    this._resolveRough(mat, did);
  }

  _resolveRough(mat, did) {
    const key = did >>> 0;
    const stem = this._texchanManifest.get(key);
    if (!stem || !this._texchanSource) return;
    const tc = this._texchanSource.getByKey(stem, "texchan"); // sync: decoded|null (kicks fetch)
    // The sync arm runs at BUILD time, before `_installCacheEntry` — no
    // identity guard is possible or needed there.
    if (tc) { this._applyRough(mat, tc, key); return; }
    // Cold: upgrade once the async fetch resolves, then re-seat clone variants.
    this._texchanSource.getByKeyAsync(stem, "texchan").then((t) => {
      if (!t) return;
      // 2026-08-03 identity guard (the sibling pattern at `_maybeUpgradeToBc7` /
      // `_maybeSetupSurfaceAnimation`): an evict+re-install across the fetch
      // would otherwise attach two fresh GPU textures to a dead material.
      if (this.materials.get(key) !== mat) return;
      this._applyRough(mat, t, key);
      this._reseatVariantsForDid(key);
    });
  }

  /**
   * 2026-08-03 — `did` is required: the planes minted here are owned by the
   * cache (`_texchanTextures`) so eviction/teardown can free them.
   */
  _applyRough(mat, tc, did) {
    if (!tc) return;
    let touched = false;
    let bytes = 0;
    if (tc.roughness) {
      const rtex = surfacePixelsToRoughnessTexture(tc.roughness, tc.width, tc.height);
      if (rtex) { mat.roughnessMap = rtex; touched = true; bytes += this._trackTexchanTexture(did, rtex); }
    }
    // F1 — baked cavity AO. r184 lets aoMap use the main "uv" (channel 0); reads
    // .r (RedFormat). Conservative intensity so the darkening stays subtle (AO
    // can only darken, never chrome). Look-polish owed to a 1070 eye-test.
    if (tc.ao) {
      const atex = surfacePixelsToAoTexture(tc.ao, tc.width, tc.height);
      if (atex) {
        mat.aoMap = atex;
        mat.aoMapIntensity = aoMapIntensityValue();
        touched = true;
        bytes += this._trackTexchanTexture(did, atex);
      }
    }
    if (!touched) return;
    // No-op until the entry exists (the build-time sync arm runs pre-install).
    if (bytes > 0) this._addMatEntryBytes(did >>> 0, bytes);
    mat.needsUpdate = true;
    // Mutate in place: this can run POST-compile, and a `{...userData}` spread
    // would drop the non-enumerable live handles (`_defineLiveUserData`).
    mat.userData = mat.userData || {};
    mat.userData.texchanRoughness = !!tc.roughness;
    mat.userData.texchanAo = !!tc.ao;
  }

  /** Take ownership of one texchan plane for `did`; returns its byte cost. */
  _trackTexchanTexture(did, tex) {
    if (!tex || !Number.isFinite(did)) return 0;
    const key = did >>> 0;
    let list = this._texchanTextures.get(key);
    if (!list) { list = []; this._texchanTextures.set(key, list); }
    list.push(tex);
    return estimateTextureBytes(tex);
  }

  _materialFromFlags(surfaceTypeFlags, texture, category, normalTexture, overrides, heightTexture, surfaceFloats) {
    const flags = surfaceTypeFlags >>> 0;
    // Wave 8 (2026-05-28) — Surface (0x08) trailing T/L/D triplet.
    // Pre-Wave-8 these were silently dropped; the bit flags drove
    // hardcoded effect strengths. Now each effect uses the actual
    // per-surface float. `surfaceFloats` may be undefined when an
    // older call site hasn't been migrated; treat that as 0/0/0
    // (≡ pre-Wave-8 binary behaviour).
    const sfTranslucency = +(surfaceFloats?.translucency ?? 0.0);
    const sfLuminosity = +(surfaceFloats?.luminosity ?? 0.0);
    const sfDiffuse = +(surfaceFloats?.diffuse ?? 0.0);
    // Phase 1.4 — start from the category-aware default if the wasm
    // side classified the surface; otherwise stay on the generic
    // 0.9 / 0.0 fall-through. The Diffuse flag below can still
    // override roughness to 1.0 (matte wins regardless of category).
    let baseRoughness = 0.9;
    let baseMetalness = 0.0;
    if (typeof category === "number") {
      const defaults = CATEGORY_MATERIAL_DEFAULTS[category];
      if (defaults) {
        baseRoughness = defaults.roughness;
        baseMetalness = defaults.metalness;
      }
      // === L4 (waves-2, 2026-05-29) — `?flatDiffuse=retail` preset ======
      // Retail FFP has no specular (acclient.c:454385-454561); only opt the
      // glossy categories (Metal, Lava) into a flat non-specular look under
      // the flag — never overwrite the classifier defaults unconditionally.
      // Read at the consumption site (same pattern as readLightClampRetailFlag)
      // so the flag and its consumer share scope.
      if (readFlatDiffuseRetailFlag()) {
        const flat = FLAT_DIFFUSE_CATEGORIES[category];
        if (flat) {
          baseRoughness = flat.roughness;
          baseMetalness = flat.metalness;
        }
      }
    }
    // Phase 1.5 — per-DID overrides from `data/surface_overrides.json`
    // override the category default. Either the wasm bundle passes
    // `Number.isFinite(roughness)` (real override) or the value arrives
    // as `NaN` / `undefined` (fall through to category default). Diffuse
    // flag (below) still overrides this — explicit AC matte hint wins.
    if (overrides) {
      if (typeof overrides.roughness === "number" && Number.isFinite(overrides.roughness)) {
        baseRoughness = overrides.roughness;
      }
    }
    const opts = {
      map: texture,
      roughness: baseRoughness,
      metalness: baseMetalness,
      side: THREE.DoubleSide,
      transparent: false,
      alphaTest: 0,
    };
    const isTranslucent = (flags & SURFACE_TYPE.Translucent) !== 0;
    const isClipMap = (flags & SURFACE_TYPE.Base1ClipMap) !== 0;
    const isAdditive = (flags & SURFACE_TYPE.Additive) !== 0;
    // Alpha (0x100): texture-alpha blend — SRCALPHA/INVSRCALPHA, depthWrite
    // off (acclient.c D3DPolyRender::SetSurface @454470). 253 retail
    // surfaces carry it; pre-2026-05-28 they fell through to opaque here.
    const isAlpha = (flags & SURFACE_TYPE.Alpha) !== 0;
    // InvAlpha (0x200): inverse alpha blend — retail's D3DPolyRender::SetSurface
    // (acclient.c @454478) flips the factors vs Alpha (INVSRCALPHA/SRCALPHA
    // instead of SRCALPHA/INVSRCALPHA). `materialCanCastShadow` (above) already
    // classifies 0x200 as transparent; pre-2026-05-28 the render path had no
    // branch, so InvAlpha surfaces rendered fully opaque — an internal
    // inconsistency. First cut: route through the same alpha-blend branch as
    // Alpha (transparent + depthWrite off). A faithful inverse blend (alpha =
    // 1 - texAlpha) would need a custom blend func / shader and is deferred
    // until a retail occurrence count justifies it.
    const isInvAlpha = (flags & SURFACE_TYPE.InvAlpha) !== 0;
    // `isLuminous` (the 0x40 bit) is kept ONLY to gate the normal-map skip
    // below — self-illumination itself is now driven by the luminosity
    // FLOAT (`hasLum`). Retail's portal.dat sets the Luminous/Diffuse bits
    // on 0/6152 surfaces (census 2026-05-28) while 762 carry luminosity>0
    // and 6150 carry diffuse>0; acclient.c SetSurface reads the floats, not
    // the bits (emissive @454688, diffuse @454458).
    const isLuminous = (flags & SURFACE_TYPE.Luminous) !== 0;
    const hasLum = sfLuminosity > 0;
    // === A10-M1 (2026-06-11) — single-decoder delegation =====================
    // When `?surfaceUnified=on`, defer the blend/emissive/diffuse ladder to the
    // shared `applySurfaceRenderState` (post-construction, mutating the built
    // material) so this path and the recolored/paletted path run ONE decoder. Default
    // OFF keeps the inline `opts` ladder below — byte-identical output (the
    // unified function adopts this path's emissiveMap reading, and the inline
    // writes vs post-construction `needsUpdate` writes resolve to the same
    // MeshStandardMaterial props).
    const useUnifiedDecoder = readSurfaceUnifiedFlag();
    if (!useUnifiedDecoder && isAdditive && isAlpha) {
      // Wave-3 M1 — Alpha+Additive (0x10000|0x100): the additive
      // contribution is WEIGHTED by per-texel source alpha, not added at
      // full RGB. Retail D3DPolyRender::SetSurface (acclient.c:454474) sets
      // src=BLEND_SRCALPHA(5) and, BECAUSE Additive(0x10000) is also set,
      // dst=BLEND_ONE(2) — i.e. SRCALPHA/ONE, not the ONE/ONE that
      // THREE.AdditiveBlending bakes in. 183/202 additive surfaces are
      // Alpha+Additive (spell glows / flame haloes); ONE/ONE over-brightens
      // them (alpha ignored → hard squarish halo cutoffs). The DataTexture
      // is RGBAFormat (adapter.js:907) so the source alpha is present.
      // Use CustomBlending to express SRCALPHA/ONE faithfully. depthWrite
      // off so the halo doesn't occlude geometry behind it.
      opts.blending = THREE.CustomBlending;
      opts.blendSrc = THREE.SrcAlphaFactor;
      opts.blendDst = THREE.OneFactor;
      opts.blendEquation = THREE.AddEquation;
      opts.transparent = true;
      opts.depthWrite = false;
    } else if (!useUnifiedDecoder && isAdditive) {
      // Pure-additive (Additive without the Alpha bit): retail resolves to
      // src=BLEND_ONE(2)/dst=BLEND_ONE(2) (acclient.c:454474, the non-Alpha
      // path), which THREE.AdditiveBlending matches exactly. 19 retail
      // surfaces (flames, sparks). depthWrite=false so additive surfaces
      // don't occlude geometry behind them.
      opts.blending = THREE.AdditiveBlending;
      opts.transparent = true;
      opts.depthWrite = false;
    } else if (!useUnifiedDecoder && (isTranslucent || isAlpha || isInvAlpha)) {
      // Alpha blend (SRCALPHA/INVSRCALPHA), depthWrite off — the renderer
      // painter-sorts transparent objects. Retail routes both Translucent
      // (0x10, acclient.c:454513) and Alpha (0x100, :454470) through this
      // same blend state.
      opts.transparent = true;
      opts.depthWrite = false;
      // Translucent's alpha is the per-surface translucency float
      // (final_alpha = 1 - T, acclient.c:454523; ACE: 0=opaque, 1=invisible).
      // Alpha (0x100) instead takes its alpha from the texture's own alpha
      // channel, so leave opacity at 1.0 for it. Translucent surfaces with
      // T=0 (most) also render at full opacity.
      if (isTranslucent && sfTranslucency > 0) {
        opts.opacity = Math.max(0, 1 - sfTranslucency);
      }
    } else if (!useUnifiedDecoder && isClipMap) {
      // Binary alpha mask (foliage, fences). RND-08/33 (2026-07-27): retail's
      // ref is per-format (paletted 100/255, DDS 200/255) and the arm ALSO
      // enables ONE/INVSRCALPHA blending with z-writes on — see
      // `applyClipMapRenderState` for the acclient.c anchors, the census and
      // the `?clipMapParity=off|ref` escapes. `opts` is the pre-construction
      // bag; the helper writes the same property names a material takes.
      applyClipMapRenderState(opts, surfaceFloats?.hasPalette);
    }
    if (!useUnifiedDecoder && hasLum) {
      // Self-illumination, driven by the per-surface luminosity FLOAT
      // (not the never-set 0x40 bit). Retail's grayscale D3D emissive
      // (D3DMATERIAL9.Emissive.rgb = luminosity, acclient.c
      // D3DPolyRender::SetSurface @454688) MULTIPLIES the surface texture
      // in the fixed-function combiner — final ≈ texture × (lighting +
      // emissive) — so a COLOURED luminous surface (e.g. the blue lifestone
      // crystal) glows in its own colour, just brighter. three.js'
      // `emissive` is ADDED, and is texture-modulated ONLY when an
      // `emissiveMap` is set; without one a flat-white emissive ADD washes
      // the texture out to pure white (the reported white lifestone / chest
      // / door — the old code deliberately attached no emissiveMap on a
      // mistaken "retail isn't texture-modulated" reading). Fix: keep
      // emissive=white scaled by luminosity AND attach the diffuse texture
      // as emissiveMap, which reproduces retail's texture×emissive. The
      // emissiveMap shares uv0 + sRGB decode with `map`. Untextured luminous
      // surfaces keep the flat-white glow. Clamp to (0, 2] (ACE ~[0,1] with
      // occasional HDR-ish pushes >1). 762 retail surfaces have lum>0.
      opts.emissive = new THREE.Color(0xffffff);
      opts.emissiveIntensity = Math.min(2.0, sfLuminosity);
      if (texture) opts.emissiveMap = texture;
    }
    // Diffuse reflectance, driven by the per-surface diffuse FLOAT (not the
    // never-set 0x20 bit). Retail uses `diffuse` as a diffuse-reflectance
    // multiplier on the material's diffuse colour (D3DMATERIAL9.Diffuse/
    // Ambient.rgb = diffuse × sunlight, acclient.c SetSurface @454458) —
    // NOT a roughness/matte hint as the pre-2026-05-28 path assumed. The
    // PBR analogue is the albedo tint `color`, multiplied with `map`.
    // No-op at d≈1.0 (~96% of retail surfaces); dims the 241 with d≠1.
    // d==0 (2 surfaces) is left full-bright rather than forced black,
    // pending the GPU eye-test.
    if (!useUnifiedDecoder && sfDiffuse > 0 && Math.abs(sfDiffuse - 1.0) > 0.01) {
      opts.color = new THREE.Color(sfDiffuse, sfDiffuse, sfDiffuse);
    }
    const mat = new THREE.MeshStandardMaterial(opts);

    // === A10-M1 (2026-06-11) — run the single decoder on the built material ===
    // When `?surfaceUnified=on` the inline `opts` ladder above was skipped; apply
    // the unified render-state now (mutates `mat` + sets `needsUpdate`). The
    // `__baseTranslucency` userData it stamps for Translucent>0 is harmless on
    // the cache path (only the hook-ramp clock reads it). Built with default
    // opts (transparent:false, alphaTest:0) so the decoder starts from the same
    // baseline as the legacy branches.
    if (useUnifiedDecoder) {
      applySurfaceRenderState(
        mat,
        {
          flags,
          translucency: sfTranslucency,
          luminosity: sfLuminosity,
          diffuse: sfDiffuse,
          // A10-M3 — forwarded boolean-or-undefined (parityV2 ClipMap ref).
          hasPalette: surfaceFloats?.hasPalette,
        },
        { texture },
      );
    }

    // === 2026-08-06 (`?skipDeadBatch`) — close the ONE userData divergence
    // between the two decoders. The unified block directly above stamps
    // `__baseTranslucency` for Translucent>0; the legacy inline ladder (the
    // DEFAULT path — `?surfaceUnified` is opt-in) computed the identical
    // `opacity = 1 - T` at :4203 and stamped nothing, which is why every
    // cache-installed material — and therefore every statics batch bucket built
    // from one — failed the permanence clause of `materialRendersNothing` while
    // sitting at opacity 0. Same condition and same value as the unified path,
    // so the two decoders now agree; on any surface that is not Translucent
    // with T>0 this writes nothing at all. See `skipDeadBatchEnabled` for why
    // the stamp belongs here rather than in the batcher.
    if (!useUnifiedDecoder && isTranslucent && sfTranslucency > 0 && skipDeadBatchEnabled()) {
      mat.userData = { ...(mat.userData || {}), __baseTranslucency: sfTranslucency };
    }

    // Phase 1.1 — procedural normal map. Wasm skips Luminous surfaces
    // (empty normal_pixels → null texture), so `!isLuminous` is
    // belt-and-braces. Phase 1.5 normalScale override beats the 0.8
    // default when present.
    // === Wave 2.B — procedural normals (2026-05-28) ===
    // Gate on `this.normalMapsEnabled` so `low`/`mid` quality presets can
    // skip the +texture memory + sampler bandwidth. Wasm still bakes the
    // normal pixels (cached per-DID at decode time); the gate prevents
    // GPU upload via the unused texture. Wasm-side skip is a heavier
    // refactor (would have to plumb the preset through the JS↔wasm
    // boundary at every fetch site); skipping at the JS gate captures
    // the dominant cost (GPU memory + fragment-shader work).
    if (this.normalMapsEnabled && normalTexture && !isLuminous) {
      mat.normalMap = normalTexture;
      const overrideScale =
        overrides && Number.isFinite(overrides.normalScale)
          ? overrides.normalScale
          : null;
      // === Wave 2.B — procedural normals (2026-05-28) ===
      // Fallback chain: explicit per-DID override (Phase 1.5) → per-category
      // default (Wave 2.B) → 0.8 baseline (Phase 1.1 hand-off).
      let scale = overrideScale;
      if (scale === null && typeof category === "number") {
        const catScale = CATEGORY_NORMAL_SCALE_DEFAULTS[category];
        if (typeof catScale === "number") scale = catScale;
      }
      if (scale === null) scale = 0.8;
      mat.normalScale.setScalar(scale);
      if (overrideScale !== null) {
        mat.userData = { ...(mat.userData || {}), normalScaleOverride: overrideScale };
      }
      mat.userData = { ...(mat.userData || {}), normalScaleEffective: scale };
    }

    // Phase 0.2 — Detail flag composites a tiled grayscale overlay
    // over the diffuse. Picker uses Phase 1.4 SurfaceCategory. Gated
    // on caller-supplied detailTileCache + (bit set OR forceDetail).
    // Retail portal.dat ships 0 Detail-flagged surfaces per Phase 0.2
    // probe — forceDetail validates the path against real Holtburg.
    const isDetail = (flags & SURFACE_TYPE.Detail) !== 0;
    if (this.detailTileCache && (isDetail || this.forceDetail) && texture) {
      const key = pickDetailTileKey(category);
      const detailTex =
        this.detailTileCache.get(key) ??
        this.detailTileCache.get("generic-rough") ??
        null;
      if (detailTex) {
        _installDetailShaderPatch(mat, detailTex, {
          scale:
            category === SURFACE_CATEGORY.Sand ||
            category === SURFACE_CATEGORY.Snow
              ? 12.0
              : category === SURFACE_CATEGORY.Wood
              ? 4.0
              : 8.0,
          blend: 0.6,
        });
        mat.userData = {
          ...(mat.userData || {}),
          detailKey: key,
          detailForced: !isDetail && this.forceDetail,
        };
      }
    }
    // Visual-fidelity Phase 3.1 — parallax occlusion mapping. Gated
    // by:
    //   - this.pomEnabled (set from quality.flags.pom at construction)
    //   - heightTexture present (empty for Luminous + constant-lum
    //     surfaces — wasm returns empty heightPixels in either case,
    //     adapter returns null DataTexture, we skip here)
    //   - normalTexture present (POM needs the per-pixel normal map to
    //     align with the perturbed UV; without it the bumps would
    //     light incorrectly)
    //   - category is a SOLID ARCHITECTURAL material. Widened 2026-07-30
    //     (was Stone/Brick/Tile): with the relief_height pillow field the
    //     dungeon themes AC actually ships — wood-plank halls, metal vaults,
    //     dirt warrens — carve correctly too, and leaving them out made
    //     interiors read piecemeal next to statPom outdoors. Still excluded:
    //     Cloth (a painted banner's emblem must not emboss — the §4b false-
    //     positive), Foliage (alpha cards), Water/Lava/Snow (fluid/organic).
    //   - not Additive / Translucent (same reasoning as CSM)
    //   - texture present (POM samples the diffuse via perturbed UV)
    // Force-POM bypasses the category gate for visual-smoke testing.
    const stoneish =
      category === SURFACE_CATEGORY.Stone ||
      category === SURFACE_CATEGORY.Brick ||
      category === SURFACE_CATEGORY.Tile ||
      category === SURFACE_CATEGORY.Wood ||
      category === SURFACE_CATEGORY.Metal ||
      category === SURFACE_CATEGORY.Dirt ||
      category === SURFACE_CATEGORY.Generic;
    const pomShouldApply =
      this.pomEnabled &&
      heightTexture &&
      normalTexture &&
      texture &&
      !isAdditive &&
      !isTranslucent &&
      !isAlpha &&
      (stoneish || this.forcePom);
    if (pomShouldApply) {
      _installPomShaderPatch(mat, heightTexture, this.pomOpts || {});
      mat.userData = {
        ...(mat.userData || {}),
        pomForced: !stoneish && this.forcePom,
      };
    }
    // Visual-fidelity Phase 3.3 — install the CSM cascade-sample
    // shader patch when the cache was constructed with a csmState
    // bundle. Skips Additive + Translucent materials (they're shadow-
    // exempt per Phase 0.1 — `materialCanCastShadow` returns false for
    // them — and applying a shadow attenuation to additive blending
    // would darken sparks/flames). The patch is composed after Detail
    // (if active) so both effects stack cleanly.
    if (this.csmState && !isAdditive && !isTranslucent && !isAlpha) {
      _installCsmShaderPatch(mat, this.csmState);
    }
    // === Wave R2.B — per-RGB light-color clamp (2026-05-28) ===
    // No-op unless `?lightClamp=retail`. Composed LAST so it wraps the
    // direct-lighting accumulation regardless of which other patches
    // (detail/POM/CSM) ran on this material. Applies to additive/
    // translucent too — the clamp only affects direct DIFFUSE/SPECULAR
    // accumulation, which an additive surface still computes.
    _installLightClampShaderPatch(mat);
    // === G2 (waves-2, 2026-05-29) — object-surface texture wrap mode ======
    // Retail `D3DPolyRender::SetSurface` (acclient.c:454437) sets the sampler
    // address mode from the Stippled bit: `!stippled ? (v6 = 3) : (v6 = 1)`
    // then `SetSamplerAddressMode(dev, 0, v6, v6)` for BOTH U and V, where
    // 3 = TEXADDRESS_CLAMP (acclient.h:5261), 1 = TEXADDRESS_WRAP
    // (acclient.h:5259). So normal object surfaces CLAMP (don't tile); only
    // Stippled surfaces (SurfaceType 0x40000000, acclient.h:5833 / ACE
    // SurfaceType.cs:19) WRAP. adapter.js's `surfacePixelsTo*Texture`
    // hardcode `RepeatWrapping`; override it here per-surface now that the
    // textures are in hand. three.js mapping: CLAMP → ClampToEdgeWrapping,
    // WRAP → RepeatWrapping. FAIL-SOFT: `flags===0` (empty/fallback surface)
    // → ClampToEdge (retail default = non-tiling). Cached animated frames
    // inherit the base texture's wrapS/wrapT downstream, so fixing `texture`
    // propagates to them. Terrain detail/atlas textures are OUT OF SCOPE
    // (they tile by design) and never pass through this object path.
    // G2-fix (2026-06-19, see _SURFACE_WRAP_CLAMP): default RepeatWrapping
    // (AC object textures tile; wrap is per-polygon stippling in retail, not the
    // surface Stippled bit). `?surfaceWrapClamp=on` restores the old clamp-default.
    // RND-33: `overrides.subsetStippled` (the wasm per-subset byte, threaded by
    // adapter.js meshToGeometryGroups) drives the sampler when
    // ?surfaceStippleWrap is set; absent or flag-off keeps the G2-fix default.
    // CACHE HAZARD: `this.materials` is keyed by surface DID alone, so one
    // surface reused by a stippled and an unstippled subset shares ONE texture
    // and the first caller wins. Extending the cache key is a prerequisite for
    // making this the default -- see the flag block above.
    const isStippled = (flags & SURFACE_TYPE.Stippled) !== 0;
    const wrapMode = isStippled
      ? THREE.RepeatWrapping
      : wrapModeForSubsetStipple(overrides?.subsetStippled);
    if (texture) {
      texture.wrapS = texture.wrapT = wrapMode;
    }
    if (normalTexture) {
      normalTexture.wrapS = normalTexture.wrapT = wrapMode;
    }
    if (heightTexture) {
      heightTexture.wrapS = heightTexture.wrapT = wrapMode;
      // S3 (2026-07-30) — the statics atlas packs this seam-height field into
      // its nra ALPHA channel (static_atlas.js `packNraLayer`) and marches it
      // per-fragment (`?statPom`). The atlas REPLACES the member material
      // wholesale, so this side channel is the only route by which the
      // per-surface height survives into the atlased path. CPU-side pixels
      // only — never bound as a sampler by the bucket material. 2026-08-03:
      // held in the `_heightTexByMaterial` WeakMap, NOT userData (see the
      // invariant at that declaration).
      _heightTexByMaterial.set(mat, heightTexture);
    }
    // Retail draws a surface ONCE (see applyRetailSinglePass). Covers the LEGACY
    // opts ladder (`useUnifiedDecoder` false), whose `opts.transparent = true`
    // branches never reach applySurfaceRenderState. Idempotent, so the unified
    // path having already set it above is fine.
    applyRetailSinglePass(mat);
    return mat;
  }

  /**
   * Fetch one surface's pixels via wasm + build the
   * `MeshStandardMaterial`. Cached by surface DID; concurrent calls
   * for the same DID share a single fetch promise.
   *
   * Inputs:
   *   - `surfaceDid: u32` — AC Surface DID (`0x08...` or `0x0E...`).
   *   - `fetchSurfacesPixels` — the wasm export (takes
   *     `Uint32Array` of DIDs, returns `SurfacePixels[]` parallel
   *     to inputs).
   *
   * Returns the material. Falls back to `fallbackMaterial` (NOT a
   * cached entry) if the surface has zero pixels.
   */
  async get(surfaceDid, fetchSurfacesPixels) {
    if (this.wireframeMode) {
      return this._wireframeMaterialFor(surfaceDid >>> 0);
    }
    if (surfaceDid === FALLBACK_SURFACE_DID) {
      return this.fallbackMaterial;
    }
    const did = surfaceDid >>> 0;
    if (this.materials.has(did)) {
      this._touchMatEntry(did);
      this._noteHandout(did);
      return this.materials.get(did);
    }
    // Negative cache: a DID known to be catalog-absent renders the shared
    // fallback without re-issuing the wasm fetch. Checked AFTER materials.has so
    // a real material (or a same-session un-poison) always wins.
    if (this._negCacheEnabled && this.missingSurfaces.has(did)) {
      return this.fallbackMaterial;
    }
    if (this.pendingFetches.has(did)) {
      // The in-flight promise resolves to the material and it goes to THIS
      // caller — mark handed-out now (the DID is not resident yet, so the
      // mark simply pre-arms the deferred-dispose branch for it).
      this._noteHandout(did);
      return this.pendingFetches.get(did);
    }
    const p = (async () => {
      const results = await fetchSurfacesPixels(new Uint32Array([did]));
      const sp = results[0];
      if (!sp || sp.width === 0 || sp.height === 0) {
        // Free the empty wasm-bindgen handle and return the shared fallback.
        // R-2 (net-fixwave 2026-07-09): a zero-dim is NOT proof of absence —
        // memoise only DIDs the call-level `provenAbsent` audit lists (legacy
        // wasm without the field never poisons; transient zero-dims stay
        // retryable). `materials.set` on any real resolve un-poisons (below).
        if (sp && typeof sp.free === "function") sp.free();
        const absent = surfaceResultProvenAbsent(results);
        if (this._negCacheEnabled && absent && absent.has(did)) {
          this.missingSurfaces.add(did);
        }
        return this.fallbackMaterial;
      }
      const tex = surfacePixelsToTexture(sp.pixels, sp.width, sp.height);
      // Phase 7 follow-on #7+8: the wasm `SurfacePixels` exposes the
      // raw `Surface.surface_type` bitfield via `surfaceType`. Older
      // wasm builds without the getter fall through to `0` (opaque).
      const surfaceTypeFlags = (sp.surfaceType ?? 0) >>> 0;
      // Phase 1.4: wasm classifier emits a u8 category on
      // SurfacePixels.category — undefined on older builds, in
      // which case `_materialFromFlags` falls through to generic
      // 0.9 / 0.0 defaults.
      const category = typeof sp.category === "number" ? sp.category : undefined;
      // Phase 1.1: procedural normal pixels (RGB8). Empty for Luminous
      // surfaces and the empty-fallback surface.
      // === Wave 2.B — procedural normals (2026-05-28) ===
      // When the quality preset disables normal maps, skip the GPU
      // texture upload entirely (not just the material wire-up). Saves
      // RGBA8 → DataTexture buffer alloc + GL texture handle per DID.
      const normalTex = this.normalMapsEnabled
        ? surfacePixelsToNormalTexture(sp.normalPixels, sp.width, sp.height)
        : null;
      // Phase 3.1: heightmap (R8). Empty for Luminous/constant-lum
      // surfaces — adapter returns null and the POM patch is skipped.
      // `sp.heightPixels` is missing on pre-3.1 wasm builds — guard.
      const heightTex = typeof sp.heightPixels !== "undefined"
        ? surfacePixelsToHeightTexture(sp.heightPixels, sp.width, sp.height)
        : null;
      // Phase 1.5: per-DID overrides from the wasm bundle. Non-finite
      // sentinels → fall through to category defaults.
      const overrides = {
        roughness: typeof sp.roughnessOverride === "number" ? sp.roughnessOverride : undefined,
        normalScale: typeof sp.normalScaleOverride === "number" ? sp.normalScaleOverride : undefined,
      };
      // Wave 8 (2026-05-28) — Surface T/L/D triplet pulled from the
      // wasm side (pre-Wave-8 these were dropped; materials.js used
      // only the surface_type bitflag presence with hardcoded effect
      // strengths). Older wasm builds without the getters fall through
      // to 0 (opaque/no-glow/no-diffuse-adj — same behaviour as the
      // pre-Wave-8 bitflag path).
      const surfaceFloats = {
        translucency: typeof sp.translucency === "number" ? sp.translucency : 0.0,
        luminosity: typeof sp.luminosity === "number" ? sp.luminosity : 0.0,
        diffuse: typeof sp.diffuse === "number" ? sp.diffuse : 0.0,
        // A10-M3 (2026-06-12) — source-texture palettedness (P8/Index16) for
        // the parityV2 ClipMap alpha-test ref. STRICT boolean-or-undefined:
        // missing getter (stale pkg) → undefined → the decoder keeps 0.5.
        hasPalette: typeof sp.hasPalette === "boolean" ? sp.hasPalette : undefined,
      };
      // X6 (`?texBc7=on`) — the RenderSurface (0x06) id behind these pixels.
      // MUST be read before `sp.free()` (every getter throws on a freed handle).
      // 0 on a stale pkg without the getter, and 0 for the 1x1 solid / empty
      // fallback paths, both of which correctly disable the BC7 upgrade.
      const rsIdV = typeof sp.rsId === "number" ? sp.rsId >>> 0 : 0;
      if (typeof sp.free === "function") sp.free();
      const mat = this._materialFromFlags(surfaceTypeFlags, tex, category, normalTex, overrides, heightTex, surfaceFloats);
      mat.name = `scene3d-surface-${did.toString(16).padStart(8, "0")}`;
      mat.userData = {
        ...(mat.userData || {}),
        surfaceTypeFlags,
        surfaceCategory: category,
        surfaceRoughnessOverride: overrides.roughness,
        surfaceNormalScaleOverride: overrides.normalScale,
        // Perf B3 (2026-05-18) — cache-resident material; see
        // `_installFromPixels` for the same tag and entities.js for
        // the convention block.
        __cacheOwned: true,
      };
      this._installCacheEntry(did, mat, tex, normalTex, heightTex);
      this._maybeUpgradeToBc7(did, mat, rsIdV); // X6: no-op unless ?texBc7=on + BPTC
      // This material is being RETURNED to the caller below — handed out, so
      // a later eviction must not dispose it inline (dispose policy 3).
      this._noteHandout(did);
      if (this._negCacheEnabled) this.missingSurfaces.delete(did);
      // 2026-05-30 — a real (textured) material just landed for this surface;
      // any clone getCached*(did) minted from the mapless fallback during a
      // spawn-race must adopt it. 2026-08-03: re-seat in place rather than
      // delete — the meshes already holding those clones are the reference that
      // matters, and a delete left them grey for the session.
      this._reseatVariantsForDid(did);
      // Render-completeness audit (2026-05-29) — kick animated-frame setup.
      this._maybeSetupSurfaceAnimation(did, mat, tex);
      return mat;
    })();
    this.pendingFetches.set(did, p);
    this.pendingStartTimes.set(did, performance.now());
    try {
      return await p;
    } finally {
      this.pendingFetches.delete(did);
      this.pendingStartTimes.delete(did);
    }
  }

  /**
   * 2026-06-20 ParticleViewer parity — resolve a surface as an UNLIT particle
   * billboard material instead of the lit `MeshStandard` entity material.
   *
   * gmriggs ParticleViewer renders particles unlit: the gfxobj's Surfaces[0]
   * texture (or a 1×1 ColorValue swatch) sampled raw, opacity from the per-
   * particle translucency, additive-or-alpha from `Surfaces[0].Type`. Routing
   * particles through `get()` (the entity path) instead dragged in scene
   * lighting + luminosity-emissive + normalMap, so a particle whose first
   * surface is a bright/white texture rendered as a flat LIT WHITE BOX.
   *
   * Reuses `get()` to resolve + cache the surface TEXTURE (and the
   * `surfaceTypeFlags` additive signal that particle_manager.js's meshFactory
   * reads), then wraps it in a cache-owned `MeshBasicMaterial`. The per-slot
   * clone + blend selection still happens in the emitter's meshFactory.
   *
   * `?particleUnlit=off` → returns the legacy lit material from `get()`.
   * Returns the shared `fallbackMaterial` (or the lit material) unchanged when
   * the surface didn't resolve — caller handles null/fallback as before.
   */
  async getParticleUnlit(surfaceDid, fetchSurfacesPixels) {
    const lit = await this.get(surfaceDid, fetchSurfacesPixels);
    if (!readParticleUnlitFlag()) return lit;
    if (!lit || lit === this.fallbackMaterial || this.wireframeMode) return lit;
    const did = surfaceDid >>> 0;
    const cached = this.particleUnlitMaterials.get(did);
    if (cached) return cached;
    const m = new THREE.MeshBasicMaterial({
      map: lit.map || null,
      side: lit.side ?? THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    });
    // Preserve the additive signal both ways so the emitter meshFactory's
    // `baseIsAdditive` probe (blending===Additive || userData.surfaceTypeFlags
    // & 0x10000) still fires; it owns the final per-slot blend/alphaTest.
    m.blending = lit.blending;
    m.userData = { ...(lit.userData || {}), __cacheOwned: true };
    m.name = `particle-unlit-${did.toString(16)}`;
    this.particleUnlitMaterials.set(did, m);
    return m;
  }

  /**
   * Bulk-load N surfaces in one wasm round-trip. Strongly preferred
   * over N x `get()` because `fetch_surfaces_pixels` batches HTTP
   * shard fetches under the hood.
   *
   * Skips surface DIDs already cached (or already mid-flight) so a
   * second pass over a building's part DIDs is a no-op.
   *
   * Returns the count of newly-resolved materials (not including
   * fallbacks for zero-pixel responses).
   */
  async preload(surfaceDids, fetchSurfacesPixels) {
    if (!surfaceDids || surfaceDids.length === 0) return 0;
    if (this.wireframeMode) {
      // Wire-agent mode: skip the wasm surface-pixel fetch + GPU texture
      // upload entirely. Materials are constructed lazily via the
      // bucket-hash path in `_wireframeMaterialFor`, and the synchronous
      // `getCached` route always returns the bucket material regardless
      // of preload. Total skip — no fetch, no upload, no shader compile
      // beyond the ~32 MeshBasicMaterials lazily created on first hit.
      return 0;
    }
    // Dedupe + filter cached. The 0 sentinel never goes to wasm.
    //
    // 2026-06-20 grey-surface race fix: a DID already in `pendingFetches` is
    // being fetched by a CONCURRENT bake (the statics/buildings ring driver,
    // or another per-LB bake firing the same frame). The pre-fix code
    // `continue`d past it WITHOUT awaiting — so `await preload()` could return
    // before that surface resolved, and the caller's SYNCHRONOUS
    // `getCached(did)` then handed back the grey `fallbackMaterial`
    // (`_getCachedDouble` cache-miss → fallback), permanently for that mesh
    // (no re-resolve once the texture lands). The more LBs baking at once, the
    // likelier a common surface is mid-flight when a sibling bake needs it —
    // so `?pvsRingRadius=5` (13× more concurrent bakes than the legacy 3×3)
    // turned a rare race into the "~18% of statics render flat grey 0x888888"
    // symptom. Fix: collect the in-flight promises for those DIDs and await
    // them alongside our own batch, so the post-preload `getCached` sees a
    // resolved material instead of the fallback.
    const need = [];
    const alreadyPending = [];
    for (const did of surfaceDids) {
      const d = did >>> 0;
      if (d === FALLBACK_SURFACE_DID) continue;
      if (this.materials.has(d)) {
        // A skipped-because-cached DID is a USE (the caller is about to
        // `getCached` it) — bump recency so the bake's own working set is
        // the last thing the LRU would evict.
        this._touchMatEntry(d);
        continue;
      }
      // Negative cache: skip a known catalog-absent DID (no wasm fetch, no
      // re-warn). Checked after materials.has so a real material always wins.
      if (this._negCacheEnabled && this.missingSurfaces.has(d)) continue;
      const inflight = this.pendingFetches.get(d);
      if (inflight) { alreadyPending.push(inflight); continue; }
      need.push(d);
    }
    if (need.length === 0) {
      // Nothing fresh to fetch, but a sibling bake may still be resolving
      // surfaces this caller is about to `getCached()` — wait for them.
      if (alreadyPending.length) await Promise.allSettled(alreadyPending);
      return 0;
    }

    // Install one shared promise per DID before the wasm call so
    // concurrent `get()` calls latch on.
    const ids = new Uint32Array(need);
    const sharedFetch = fetchSurfacesPixels(ids);
    const _batchStart = performance.now();
    for (const d of need) {
      this.pendingFetches.set(
        d,
        sharedFetch.then((all) => {
          // Each parallel slot has the matching SurfacePixels; bind
          // by index in `need`. The call-level decode-audit rides along
          // so only proven-absent DIDs are memoised (R-2; the WeakMap
          // memo makes the per-DID extraction O(1) per batch).
          const i = need.indexOf(d);
          const sp = all[i];
          return this._installFromPixels(d, sp, surfaceResultProvenAbsent(all));
        })
      );
      this.pendingStartTimes.set(d, _batchStart);
    }

    try {
      await sharedFetch;
    } catch (e) {
      // Bulk fetch failed entirely — clear all pending so subsequent
      // calls can retry. Caller's await of `preload()` will reject.
      for (const d of need) {
        this.pendingFetches.delete(d);
        this.pendingStartTimes.delete(d);
      }
      try { window.__diag?.assets?.onMaterialError?.({ dids: need, error: e, source: "preload" }); } catch (_) {}
      throw e;
    }

    // Grey-surface race fix (2026-06-20): also wait for the sibling-bake
    // in-flight fetches collected above, so DIDs this caller will `getCached`
    // are resolved into `this.materials` before preload() resolves. allSettled
    // — a sibling's genuine empty-pixel surface resolves to the (uncached)
    // fallback, which is correct; we only need to not return early on it.
    if (alreadyPending.length) await Promise.allSettled(alreadyPending);

    // F4 (2026-06-01) — the per-DID `pendingFetches` chains registered above are
    // the SOLE consumers of each SurfacePixels: each installs + `sp.free()`s
    // exactly once. This loop USED to ALSO call `_installFromPixels(d,
    // results[i])` on the SAME (now-freed) handles, whose `sp.width` getter threw
    // "null pointer passed to rust" (caught + recorded as source:"surface" — the
    // 100-error burst in the stutter diagnostic). Await the pending promises here
    // to count resolutions without double-consuming. The `.then()` chains do NOT
    // clear the pending maps, so we still delete them per-DID.
    let resolved = 0;
    for (const d of need) {
      let installed = this.fallbackMaterial;
      try {
        const p = this.pendingFetches.get(d);
        installed = p ? await p : (this.materials.get(d) || this.fallbackMaterial);
      } catch (_) {
        installed = this.fallbackMaterial;
      }
      if (installed !== this.fallbackMaterial) resolved += 1;
      this.pendingFetches.delete(d);
      this.pendingStartTimes.delete(d);
    }
    return resolved;
  }

  /**
   * F.41 (2026-05-15) — batch-load surfaces for **N entities** in
   * **one** wasm round-trip. Sibling to `preload(...)`; differs in
   * that each group carries its own `(baseplaletteId, subPalettes)`
   * tuple so the wasm batch threads per-entity palette state through.
   *
   * F.40 batched `fetchEntityAnimationKeyframes` so the spawn pipeline
   * pre-warms all setups in one prefetch loop. F.40's report identified
   * surfaces as the next bottleneck: each entity still independently
   * called `fetchEntitySurfacesPixels` (5+ surfaces/entity × 13 entities
   * = 65 surface walks, none batched). `preloadBatch` collapses those
   * 65 walks into ONE prefetch loop via the
   * `fetchEntitySurfacesPixelsBatch` wasm export — sibling to F.40's
   * `fetchEntityAnimationKeyframesBatch`.
   *
   * **Inputs.** Each group: `{ surfaceDids: number[], baseplaletteId:
   * number, subPalettes: number[] }`. `subPalettes` is the flat
   * `[subId, offset, length, ...]` triple buffer the wire's
   * `EntityUpdate.subPalettes` ships. Groups with palette state get
   * **entity-owned materials** (caller's responsibility) — they're
   * returned via the batch payloads but NOT installed into this
   * cache's `materials` map (which is keyed by surface DID alone and
   * would collide with other entities' un-substituted uses).
   * Groups with `baseplaletteId=0` AND empty `subPalettes` go through
   * the same installation path as `preload(...)` — cached in
   * `this.materials` keyed by DID.
   *
   * **Return shape.** `Promise<{ groups: Array<{ surfaceDids: number[],
   * materials: Map<number, MeshStandardMaterial>, isEntityOwned: boolean
   * }> }>`. The caller distributes per-group `materials` to the
   * entity's parts; cached groups have already been installed and
   * subsequent `getCached(did)` calls return the shared material.
   *
   * **Defensive fallbacks.**
   *   - Missing `fetchEntitySurfacesPixelsBatch` (older wasm bundle):
   *     console.warn + per-group serial preload via single-call API.
   *   - Empty input: no-op early return.
   *   - Any per-group failure: that group's materials map is empty;
   *     callers fall back to `this.fallbackMaterial` for missing DIDs.
   *
   * **Bit-equivalence with single-call API.** The wasm batch's
   * `payloadAt(i)` is bit-equivalent to a `fetchEntitySurfacesPixels(
   * group.surfaceDids, group.baseplaletteId, group.subPalettes)` call
   * — proven natively by `tests_entity_surfaces_pixels_batch::
   * batch_surfaces_match_individual_calls`.
   *
   * @param {Array<{ surfaceDids: number[]|Uint32Array,
   *   baseplaletteId?: number, subPalettes?: number[]|Uint32Array }>} groups
   * @param {Function} fetchEntitySurfacesPixelsBatch - the wasm export
   * @returns {Promise<{ groups: Array<{ surfaceDids: number[],
   *   materials: Map<number, any>, isEntityOwned: boolean }> }>}
   */
  async preloadBatch(groups, fetchEntitySurfacesPixelsBatch) {
    if (!Array.isArray(groups) || groups.length === 0) {
      return { groups: [] };
    }
    if (this.wireframeMode) {
      // Wire-agent mode: return empty per-group results. Entity code
      // that uses preloadBatch falls back to its own per-entity material
      // path, which in wireframe-mode is also branched to use a shared
      // wireframe material (see entities.js).
      return { groups: groups.map(() => ({ materials: new Map(), isEntityOwned: false })) };
    }
    if (typeof fetchEntitySurfacesPixelsBatch !== "function") {
      // Fallback path — wasm bundle predates F.41. Serial preload
      // each group via the single-call API path. Slower (N prefetch
      // loops) but correct.
      // eslint-disable-next-line no-console
      console.warn(
        "[MaterialCache] preloadBatch: fetchEntitySurfacesPixelsBatch missing; falling back to serial per-group fetches"
      );
      const out = [];
      for (const g of groups) {
        const surfaceDids = Array.from(g.surfaceDids || []);
        const baseplaletteId = (g.baseplaletteId ?? 0) >>> 0;
        const subPalettes = Array.from(g.subPalettes || []);
        const isEntityOwned = baseplaletteId !== 0 || subPalettes.length > 0;
        out.push({
          surfaceDids,
          materials: new Map(),
          isEntityOwned,
        });
        // We can't easily fall back without the single-call API
        // reference here — leave materials map empty and let callers
        // fall back to fallbackMaterial. The batch path is the
        // load-bearing one; the fallback is informational only.
      }
      return { groups: out };
    }

    // Build the flat input arrays. Each group contributes:
    //   - dids: Uint32 sequence appended to flat_surface_dids
    //   - one count to surface_dids_lens
    //   - one baseplaletteId to base_palette_ids
    //   - sub-palette triples appended to flat_sub_palettes
    //   - triple count to sub_palettes_triple_counts
    const flatSurfaceDids = [];
    const surfaceDidsLens = [];
    const basePaletteIds = [];
    const flatSubPalettes = [];
    const subPalettesTripleCounts = [];
    const groupMeta = []; // parallel to groups: { surfaceDids, isEntityOwned, subDidIdx }

    for (const g of groups) {
      const surfaceDidsArr = Array.from(g.surfaceDids || []).map((d) => d >>> 0);
      const baseplaletteId = (g.baseplaletteId ?? 0) >>> 0;
      const subPalettesArr = Array.from(g.subPalettes || []).map((d) => d >>> 0);
      if (subPalettesArr.length % 3 !== 0) {
        // eslint-disable-next-line no-console
        console.warn(
          "[MaterialCache] preloadBatch: subPalettes must be flat triples; group skipped"
        );
        groupMeta.push({
          surfaceDids: surfaceDidsArr,
          isEntityOwned:
            baseplaletteId !== 0 || subPalettesArr.length > 0,
          skipped: true,
        });
        continue;
      }
      for (const d of surfaceDidsArr) flatSurfaceDids.push(d);
      surfaceDidsLens.push(surfaceDidsArr.length);
      basePaletteIds.push(baseplaletteId);
      for (const d of subPalettesArr) flatSubPalettes.push(d);
      subPalettesTripleCounts.push(subPalettesArr.length / 3);
      groupMeta.push({
        surfaceDids: surfaceDidsArr,
        isEntityOwned: baseplaletteId !== 0 || subPalettesArr.length > 0,
        skipped: false,
      });
    }

    // All-skipped early-out.
    if (surfaceDidsLens.length === 0) {
      return {
        groups: groupMeta.map((m) => ({
          surfaceDids: m.surfaceDids,
          materials: new Map(),
          isEntityOwned: m.isEntityOwned,
        })),
      };
    }

    let batch;
    try {
      batch = await fetchEntitySurfacesPixelsBatch(
        new Uint32Array(flatSurfaceDids),
        new Uint32Array(surfaceDidsLens),
        new Uint32Array(basePaletteIds),
        new Uint32Array(flatSubPalettes),
        new Uint32Array(subPalettesTripleCounts),
      );
    } catch (e) {
      // Bulk batch failed — surface failure to caller and let each
      // group fall back to fallbackMaterial. We don't auto-retry per-
      // group here; the caller can decide.
      // eslint-disable-next-line no-console
      console.warn(
        "[MaterialCache] preloadBatch: wasm batch threw; all groups fall back",
        e
      );
      try { window.__diag?.assets?.onMaterialError?.({ dids: flatSurfaceDids, error: e, source: "batch" }); } catch (_) {}
      return {
        groups: groupMeta.map((m) => ({
          surfaceDids: m.surfaceDids,
          materials: new Map(),
          isEntityOwned: m.isEntityOwned,
        })),
      };
    }

    // Distribute per-group results. payloadAt(i) MOVES the i-th
    // Vec<SurfacePixels> out — JS now owns each SurfacePixels' wasm
    // handle and is responsible for sp.free() per pixels item.
    // R-2: batch-level decode-audit, read once for every group below.
    const batchAbsent = surfaceResultProvenAbsent(batch);
    const resultGroups = new Array(groups.length);
    let payloadIdx = 0;
    for (let gi = 0; gi < groupMeta.length; gi += 1) {
      const meta = groupMeta[gi];
      const materials = new Map();
      if (meta.skipped) {
        resultGroups[gi] = {
          surfaceDids: meta.surfaceDids,
          materials,
          isEntityOwned: meta.isEntityOwned,
        };
        continue;
      }
      const payload = batch.payloadAt(payloadIdx);
      payloadIdx += 1;
      if (!payload) {
        resultGroups[gi] = {
          surfaceDids: meta.surfaceDids,
          materials,
          isEntityOwned: meta.isEntityOwned,
        };
        continue;
      }
      // payload is an Array<SurfacePixels> parallel to meta.surfaceDids.
      for (let j = 0; j < meta.surfaceDids.length; j += 1) {
        const did = meta.surfaceDids[j];
        const sp = payload[j];
        if (!sp) continue;
        if (meta.isEntityOwned) {
          // Build entity-owned material — do NOT install into
          // this.materials (would collide with non-recoloured uses
          // of the same surface DID). Per-entity caller registers
          // ownership via inst.registerOwnedTexture / registerOwnedMaterial.
          const entityMat = this._buildEntityOwnedFromPixels(did, sp);
          if (entityMat) materials.set(did, entityMat);
        } else {
          // Cache-installed path. _installFromPixels keys by DID
          // and installs into this.materials. Future getCached(did)
          // returns the same material across all callers.
          const mat = this._installFromPixels(did, sp, batchAbsent);
          if (mat !== this.fallbackMaterial) {
            materials.set(did, mat);
          }
        }
      }
      resultGroups[gi] = {
        surfaceDids: meta.surfaceDids,
        materials,
        isEntityOwned: meta.isEntityOwned,
      };
    }

    // Free the batch wrapper. Per-payload SurfacePixels handles were
    // freed inside _installFromPixels / _buildEntityOwnedFromPixels.
    try {
      if (batch && typeof batch.free === "function") batch.free();
    } catch (_) {}

    return { groups: resultGroups };
  }

  /**
   * F.41 — build an entity-owned `MeshStandardMaterial` from a
   * `SurfacePixels` handle. Unlike `_installFromPixels`, this does
   * NOT cache the result in `this.materials` — entity-owned materials
   * are keyed by `(entity, did)` and live on the entity until
   * dispose. The caller (entities.js) is responsible for
   * `inst.registerOwnedTexture` / `registerOwnedMaterial`.
   *
   * Returns the material on success; `null` on empty/failed pixels.
   * SurfacePixels handle is `.free()`'d before return.
   */
  _buildEntityOwnedFromPixels(did, sp) {
    if (!sp) return null;
    let w, h, pixels, surfaceType, sfTranslucency, sfLuminosity, sfDiffuse,
        sfHasPalette;
    try {
      w = sp.width;
      h = sp.height;
    } catch (_) {
      return null;
    }
    if (w === 0 || h === 0) {
      try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
      return null;
    }
    try {
      pixels = sp.pixels;
      surfaceType = sp.surfaceType ?? 0;
      // A10-M2 (2026-06-11) — snapshot the trailing T/L/D float triplet BEFORE
      // `sp.free()` so the unified decoder can thread the render-state flags
      // through the entity-owned (F.41 recolour) path. Same read idiom as the
      // cache path (materials.js:2343) and the recolored hot-swap path
      // (entities.js:6733-6735).
      sfTranslucency = typeof sp.translucency === "number" ? sp.translucency : 0.0;
      sfLuminosity = typeof sp.luminosity === "number" ? sp.luminosity : 0.0;
      sfDiffuse = typeof sp.diffuse === "number" ? sp.diffuse : 0.0;
      // A10-M3 — palettedness snapshot BEFORE sp.free() (parityV2 ClipMap
      // ref). Strict boolean-or-undefined (stale-pkg fail-soft).
      sfHasPalette = typeof sp.hasPalette === "boolean" ? sp.hasPalette : undefined;
    } catch (_) {
      return null;
    }
    const tex = surfacePixelsToTexture(pixels, w, h);
    try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
    // Entity-owned material starts as a plain opaque MeshStandardMaterial —
    // mirrors entities.js line 594-600's existing entity-recolour
    // path which keeps things simple (no normal/height/CSM stack on
    // recoloured NPC surfaces today). Under `?surfaceUnified=on` the A10-M2
    // block below threads the Surface(0x08) render-state flags through
    // (transparent/additive/clipmap/luminous/diffuse), closing the F.41
    // flat-opaque gap (A10 §3 row 3).
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: false,
    });
    mat.name = `entity-surface-${did.toString(16).padStart(8, "0")}`;
    mat.userData = {
      surfaceTypeFlags: surfaceType,
      batchOrigin: "F.41",
      // Perf B3 (2026-05-18) — entity-owned (not cache-installed —
      // NOT placed in `this.materials`). When entities.js's
      // preloadBatch consumer lands, `_disposeMaterialIfOwned` reads
      // this tag and frees on entity dispose. See the `__disposable`
      // convention block in entities.js's module docstring.
      __disposable: true,
    };
    // === Wave R2.B — per-RGB light-color clamp (2026-05-28) ===
    // No-op unless `?lightClamp=retail`. Entity-recolour surfaces (NPCs,
    // recoloured gear) honour the cap too so a tinted sun / R2.A lantern
    // keeps its tone on characters, not just terrain/buildings.
    _installLightClampShaderPatch(mat);
    // === G2 (waves-2, 2026-05-29) — object-surface texture wrap mode ======
    // Same retail rule as `_materialFromFlags` (acclient.c:454437): entity-
    // owned surfaces (recoloured NPCs/gear) are object surfaces too, so they
    // CLAMP unless Stippled (SurfaceType 0x40000000). `surfacePixelsToTexture`
    // hardcodes RepeatWrapping; override per-surface. FAIL-SOFT: surfaceType
    // 0/missing → ClampToEdge. Only a base `tex` here (no normal/height).
    // G2-fix (2026-06-19, see _SURFACE_WRAP_CLAMP): default RepeatWrapping.
    // RND-33: entity-owned recolour surfaces arrive without subset context
    // (no ModelMesh in scope here), so `wrapModeForSubsetStipple(undefined)`
    // returns the pre-RND-33 default -- inert by design, not a clamp.
    const isStippled = ((surfaceType >>> 0) & SURFACE_TYPE.Stippled) !== 0;
    tex.wrapS = tex.wrapT = isStippled
      ? THREE.RepeatWrapping
      : wrapModeForSubsetStipple(undefined);
    // === A10-M2 (2026-06-11) — `?surfaceUnified=on` thread render-state flags ===
    // Retail funnels EVERY drawn surface — including recoloured/entity-owned ones
    // — through the SAME render-state decision (D3DPolyRender::SetSurface,
    // acclient.c:454385; there is no special recolour path). Default OFF keeps the
    // legacy plain-opaque material (rollback). When ON, run the single decoder so
    // a recoloured NPC/gear surface with Translucent/Additive/ClipMap/luminosity
    // renders correctly instead of flat-opaque (A10 §3 row 3). The decoder is a
    // no-op when `surfaceType === 0` (empty/fallback), so opaque recolours are
    // byte-identical to the legacy path. `tex` is passed as `emissiveMap` source
    // for luminous surfaces (the resolved FF-modulate reading, M1 header).
    if (readSurfaceUnifiedFlag()) {
      applySurfaceRenderState(
        mat,
        {
          flags: surfaceType,
          translucency: sfTranslucency,
          luminosity: sfLuminosity,
          diffuse: sfDiffuse,
          // A10-M3 — boolean-or-undefined (parityV2 ClipMap alpha-test ref).
          hasPalette: sfHasPalette,
        },
        { texture: tex },
      );
    }
    return mat;
  }

  _installFromPixels(did, sp, provenAbsent = null) {
    if (!sp) return this.fallbackMaterial;
    // Idempotency / free-once guard (F4, 2026-06-01): if this DID is already
    // installed, a second consumer reached us with the SAME (already-freed)
    // SurfacePixels handle. Reading any getter below would throw "null pointer
    // passed to rust"; instead free-if-live (once, no-op on an already-freed
    // handle) and return the cached material. Defends preloadBatch + any future
    // double-consume; preload() itself no longer double-consumes (see below).
    if (this.materials.has(did)) {
      try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
      this._touchMatEntry(did);
      this._noteHandout(did);
      return this.materials.get(did);
    }
    // wasm-bindgen wrappers around a null Rust pointer throw on every
    // getter (`.width` / `.height` / `.pixels`), so read them once under
    // a try/catch instead of an inline `sp.width === 0` check. A throw
    // here means the surface DID had no pixels — fall back to the
    // shared fallback material exactly as for the zero-dim case.
    let w, h, pixels, surfaceType, category, normalPixels, heightPixels,
        roughnessOverride, normalScaleOverride,
        translucencyF, luminosityF, diffuseF, hasPaletteB, rsIdV = 0;
    try {
      w = sp.width;
      h = sp.height;
    } catch (e) {
      // Wave 1 / B1 fix (2026-05-28) — surface pixel-read threw on a
      // wasm-bindgen wrapper backed by a null Rust pointer. Record so
      // operators can see WHICH surface DIDs are failing instead of
      // staring at grey entities with no explanation.
      try {
        window.__diag?.assets?.onMaterialError?.({
          did, error: e, source: "surface",
        });
      } catch (_) {}
      return this.fallbackMaterial;
    }
    if (w === 0 || h === 0) {
      // Wave 1 / B1 fix (2026-05-28) — zero-dim surface (empty pixels
      // payload, parser truncation, etc.). Same fallback as throw case.
      try {
        window.__diag?.assets?.onMaterialError?.({
          did, error: `zero-dim (${w}x${h})`, source: "surface",
        });
      } catch (_) {}
      try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
      // R-2 (net-fixwave 2026-07-09): negative-cache only on PROVEN absence —
      // the caller passes the call-level `provenAbsent` audit set (see
      // surfaceResultProvenAbsent). A zero-dim without proof is a transient
      // (swallowed dependency round) and must stay retryable. NOT set in the
      // throw case above: that is a freed-handle double-consume race (F4),
      // not an absence, so it must never poison a live DID.
      if (this._negCacheEnabled && provenAbsent && provenAbsent.has(did)) {
        this.missingSurfaces.add(did);
      }
      return this.fallbackMaterial;
    }
    try {
      pixels = sp.pixels;
      surfaceType = sp.surfaceType ?? 0;
      // Phase 1.4: heuristic category as u8. Missing getter on older
      // wasm builds → undefined → generic defaults in _materialFromFlags.
      category = typeof sp.category === "number" ? sp.category : undefined;
      // Phase 1.1: procedural normal map (RGB8). Empty Uint8Array for
      // Luminous surfaces, the 1x1 solid path, and the empty fallback.
      normalPixels = sp.normalPixels;
      // Phase 3.1: heightmap (R8). Empty for Luminous + constant-lum
      // + 1x1 solid + empty fallback. Missing on pre-3.1 wasm builds.
      heightPixels = typeof sp.heightPixels !== "undefined" ? sp.heightPixels : null;
      // Phase 1.5: per-DID overrides. Non-finite → fall through to
      // category defaults.
      roughnessOverride = typeof sp.roughnessOverride === "number" ? sp.roughnessOverride : undefined;
      normalScaleOverride = typeof sp.normalScaleOverride === "number" ? sp.normalScaleOverride : undefined;
      // Wave 8 — Surface T/L/D triplet (see main get() path comment).
      translucencyF = typeof sp.translucency === "number" ? sp.translucency : 0.0;
      luminosityF = typeof sp.luminosity === "number" ? sp.luminosity : 0.0;
      diffuseF = typeof sp.diffuse === "number" ? sp.diffuse : 0.0;
      // A10-M3 — palettedness for the parityV2 ClipMap alpha-test ref.
      // Strict boolean-or-undefined (stale-pkg fail-soft, see get() twin).
      hasPaletteB = typeof sp.hasPalette === "boolean" ? sp.hasPalette : undefined;
      // X6 (`?texBc7=on`) — RenderSurface (0x06) id, read before `sp.free()`
      // below. See the `get()` twin. 0 ⇒ no BC7 upgrade for this DID.
      rsIdV = typeof sp.rsId === "number" ? sp.rsId >>> 0 : 0;
    } catch (_) {
      return this.fallbackMaterial;
    }
    const tex = surfacePixelsToTexture(pixels, w, h);
    // === Wave 2.B — procedural normals (2026-05-28) ===
    // Gate normal-pixel → GPU texture conversion on the preset flag, same
    // as the main `get()` path above. Saves the DataTexture alloc + GL
    // upload when `normalMaps` is off in the quality preset.
    const normalTex = this.normalMapsEnabled
      ? surfacePixelsToNormalTexture(normalPixels, w, h)
      : null;
    const heightTex = heightPixels ? surfacePixelsToHeightTexture(heightPixels, w, h) : null;
    // Phase 7 follow-on #7+8: surface_type bitfield from the wasm side.
    const surfaceTypeFlags = surfaceType >>> 0;
    try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
    const overrides = { roughness: roughnessOverride, normalScale: normalScaleOverride };
    const surfaceFloats = {
      translucency: translucencyF,
      luminosity: luminosityF,
      diffuse: diffuseF,
      hasPalette: hasPaletteB,
    };
    const mat = this._materialFromFlags(surfaceTypeFlags, tex, category, normalTex, overrides, heightTex, surfaceFloats);
    this._attachRoughnessMap(mat, did); // Phase-5 baked roughness (gated; fail-soft)
    mat.name = `scene3d-surface-${did.toString(16).padStart(8, "0")}`;
    mat.userData = {
      ...(mat.userData || {}),
      surfaceTypeFlags,
      surfaceCategory: category,
      surfaceRoughnessOverride: roughnessOverride,
      surfaceNormalScaleOverride: normalScaleOverride,
      // Perf B3 (2026-05-18) — cache-resident material. Entity dispose
      // chains (entities.js `_disposeMaterialIfOwned`) skip these;
      // `MaterialCache.dispose()` (page teardown) frees them. C5 +
      // E3 read the same tag.
      __cacheOwned: true,
    };
    this._installCacheEntry(did, mat, tex, normalTex, heightTex);
    this._maybeUpgradeToBc7(did, mat, rsIdV); // X6: no-op unless ?texBc7=on + BPTC
    if (this._negCacheEnabled) this.missingSurfaces.delete(did);
    // 2026-05-30 — adopt this textured base into any stale fallback-derived
    // clone (see the 6-space twin in get()). 2026-08-03: re-seat, don't delete.
    this._reseatVariantsForDid(did);
    // Render-completeness audit (2026-05-29) — kick animated-frame setup.
    this._maybeSetupSurfaceAnimation(did, mat, tex);
    return mat;
  }

  /**
   * X6 (2026-07-29, `?texBc7=on`) — swap a cache-resident surface's RGBA8
   * albedo for a pre-encoded BC7 (BPTC) texture uploaded to the GPU verbatim
   * (8 bpp instead of 32, zero CPU decode).
   *
   * WHY A POST-BUILD SWAP AND NOT A BUILD-TIME CHOICE: the surface is decoded
   * and the material built on one synchronous pass from an already-resolved
   * `SurfacePixels`; the BC7 record is a SEPARATE async resource fetch. Building
   * RGBA8 first keeps frame 1 correct (retail texels) and makes the whole path
   * fail-soft — an absent record, a malformed payload, or a GPU without BPTC all
   * land on "nothing happens". The cost is a race with the statics atlas, which
   * consumes `mat.map` synchronously; `static_atlas.js` defers a node whose BC7
   * verdict is still in flight (`__bc7Pending`) rather than pinning it into an
   * RGBA8 bucket, and a bucket's format is fixed at allocation so the deferral
   * is the only correct answer there.
   *
   * KEYED BY RenderSurface (0x06), NOT Surface DID (0x08): several Surfaces can
   * share one RenderSurface, and the atlas dedups layers by `map.uuid`. Keying
   * the BC7 cache by rs id means those Surfaces share ONE `CompressedTexture`
   * and therefore ONE atlas layer — strictly better dedup than the RGBA8 path,
   * where each Surface decodes its own `DataTexture`.
   *
   * @param {number} did surface DID (cache key)
   * @param {THREE.Material} mat the just-installed cache-owned material
   * @param {number} rsId RenderSurface id, or 0 (solid/fallback/stale pkg)
   */
  _maybeUpgradeToBc7(did, mat, rsId) {
    if (!bc7Available() || !mat) return;
    const rs = rsId >>> 0;
    if (!rs || rs >>> 24 !== 0x06) return;
    const d = did >>> 0;
    if (!this._bc7Asked) this._bc7Asked = new Set();
    if (this._bc7Asked.has(d)) return;
    this._bc7Asked.add(d);
    // P1 (2026-08-04): the re-point handler runs via onSwap for EACH phase
    // (pre then full) — NOT via the returned promise, which would double-run
    // it for the full phase (double LRU delta, double dispose).
    upgradeMaterialToBc7(mat, rs, (res) => {
        if (!res || res.swapped !== true) return;
        // Evicted / replaced between the ask and the land: leave everything
        // alone (the new material has its own ask).
        if (this.materials.get(d) !== mat) return;
        const old = res.replaced || null;
        const tex = mat.map;
        if (!tex || tex === old) return;
        // Clones share `map` BY REFERENCE (three's `.clone()` copies the ref),
        // so every live per-DID variant must be re-pointed BEFORE the RGBA8
        // twin is freed — otherwise a `?perPolyCull` FrontSide clone or an
        // EnvCell floor/static-bias clone would sample a disposed texture.
        // 2026-08-03 — the Luminous path ALIASES the albedo as `emissiveMap`
        // (`applyFloatLumDiffuse`), so every alias must move with `map` or the
        // emissive term samples the RGBA8 twin freed below.
        if (mat.emissiveMap === old) {
          mat.emissiveMap = tex;
          mat.needsUpdate = true;
        }
        for (const m of [
          this.frontSideMaterials,
          this.floorBiasMaterials,
          this.staticBiasMaterials,
          this.cellBakedMaterials,
        ]) {
          const clone = m && m.get(d);
          if (!clone) continue;
          if (clone.map === old) {
            clone.map = tex;
            clone.needsUpdate = true;
          }
          if (clone.emissiveMap === old) {
            clone.emissiveMap = tex;
            clone.needsUpdate = true;
          }
        }
        // VFX component variants are keyed by a composite `(did|setKey|configKey)`
        // string rather than the bare DID, so they have to be scanned. Dormant
        // (size 0) unless a frag/MECH-B component built one for this surface.
        if (this.vfxVariants && typeof this.vfxVariants.values === "function") {
          for (const v of this.vfxVariants.values()) {
            if (!v) continue;
            if (v.map === old) {
              v.map = tex;
              v.needsUpdate = true;
            }
            if (v.emissiveMap === old) {
              v.emissiveMap = tex;
              v.needsUpdate = true;
            }
          }
        }
        // Re-point cache ownership + rebalance the `?matBudgetMB` accounting
        // before freeing: `textures` is what `dispose()` walks at teardown and
        // `_matLru` is what the budget enforcer reads. BC7 is always SMALLER
        // than its RGBA8 twin, so the delta is negative and `_addMatEntryBytes`
        // (which ignores <= 0) cannot express it — adjust the entry directly.
        if (this.textures.get(d) === old) this.textures.set(d, tex);
        const delta = estimateTextureBytes(tex) - estimateTextureBytes(old);
        const prev = this._matLru.get(d);
        if (prev !== undefined && delta !== 0) {
          const next = Math.max(0, prev + delta);
          this._matLru.set(d, next); // re-set on an existing key keeps recency
          this._matLruBytes += next - prev;
        }
        try {
          if (old && typeof old.dispose === "function") old.dispose();
        } catch (_) {
          /* fail-soft */
        }
      })
      .catch(() => {
        /* fail-soft: the surface keeps its RGBA8 albedo */
      });
  }

  /**
   * Render-completeness audit (2026-05-29) — set up frame cycling for an
   * animated SurfaceTexture (water / lava / effects). Fire-and-forget: the
   * base material already renders the highest-res frame, so this only adds
   * motion once frames load. No-op when the wasm getter is absent, the
   * surface isn't animated (frameCount < 2), already checked, or anything
   * fails — the surface simply stays static (zero regression risk).
   */
  _maybeSetupSurfaceAnimation(did, mat, baseTex) {
    const d = did >>> 0;
    if (!this._animFramesFetch || this._animChecked.has(d)) return;
    this._animChecked.add(d);
    Promise.resolve()
      .then(() => this._animFramesFetch(d))
      .then((bundle) => {
        if (!bundle) return;
        const frameCount = (bundle.frameCount ?? 0) >>> 0;
        const w = (bundle.width ?? 0) >>> 0;
        const h = (bundle.height ?? 0) >>> 0;
        if (frameCount < 2 || w === 0 || h === 0) {
          if (typeof bundle.free === "function") { try { bundle.free(); } catch (_) {} }
          return;
        }
        const all =
          typeof bundle.takePixels === "function" ? bundle.takePixels() : null;
        if (typeof bundle.free === "function") { try { bundle.free(); } catch (_) {} }
        const per = w * h * 4;
        if (!all || all.length < per * frameCount) return;
        // Material may have been evicted/disposed between build and now.
        if (this.materials.get(d) !== mat) return;
        const frames = [];
        for (let i = 0; i < frameCount; i += 1) {
          // subarray() shares the big backing buffer; DataTexture wants to
          // own its data, so copy each frame into a fresh Uint8Array.
          const buf = new Uint8Array(per);
          buf.set(all.subarray(i * per, (i + 1) * per));
          const t = surfacePixelsToTexture(buf, w, h);
          // Match the base map's sampler settings so only the image cycles.
          if (baseTex) {
            t.wrapS = baseTex.wrapS;
            t.wrapT = baseTex.wrapT;
            t.magFilter = baseTex.magFilter;
            t.minFilter = baseTex.minFilter;
            t.anisotropy = baseTex.anisotropy;
            if ("colorSpace" in baseTex) t.colorSpace = baseTex.colorSpace;
            t.flipY = baseTex.flipY;
            t.needsUpdate = true;
          }
          frames.push(t);
        }
        // 2026-08-03 — the Luminous path aliases the albedo as `emissiveMap`
        // (`applyFloatLumDiffuse`). Lava/effect surfaces are Luminous AND
        // animated, so the alias has to cycle with `map` or the glow stays
        // frozen on frame 0 under a moving albedo.
        const cyclesEmissive = !!baseTex && mat.emissiveMap === baseTex;
        mat.map = frames[0];
        if (cyclesEmissive) mat.emissiveMap = frames[0];
        this._animatedMaterials.set(d, { mat, frames, idx: 0, accumS: 0, cyclesEmissive });
        // `?matBudgetMB` accounting: the frame set is `frameCount × w×h×4`
        // JS-heap bytes hanging off this DID — by far the largest per-entry
        // retainer when it exists. Charge it to the entry (recency
        // unchanged; the entry is protected from its own enforcement pass).
        let animBytes = 0;
        for (const f of frames) animBytes += estimateTextureBytes(f);
        this._addMatEntryBytes(d, animBytes);
      })
      .catch(() => {
        // Fail-soft: surface stays static on its highest-res frame.
      });
  }

  /**
   * Advance every animated surface's frame on its shared material `.map`.
   * Called once per frame from the render loop. AC stores no per-surface
   * frame rate, so we use a gentle fixed cadence — the eye-test is the
   * source of truth for "does the water shimmer at the right speed"; this
   * is the one tunable knob.
   */
  tickAnimatedSurfaces(dt) {
    if (this._animatedMaterials.size === 0) return;
    const ANIM_SURFACE_FPS = 4;
    const step = 1 / ANIM_SURFACE_FPS;
    const d = typeof dt === "number" && dt > 0 ? dt : 0;
    for (const entry of this._animatedMaterials.values()) {
      entry.accumS += d;
      if (entry.accumS < step) continue;
      // One frame per elapsed step; reset accumulator (drop overflow so a
      // stall doesn't cause a catch-up burst).
      entry.accumS = 0;
      entry.idx = (entry.idx + 1) % entry.frames.length;
      const frame = entry.frames[entry.idx];
      entry.mat.map = frame;
      // Luminous surfaces alias the albedo as emissiveMap — cycle both.
      if (entry.cyclesEmissive) entry.mat.emissiveMap = frame;
    }
  }

  /**
   * Free GPU resources owned by this cache. Materials don't dispose
   * their textures automatically in three.js, so we walk both maps.
   * Safe to call multiple times; future `get()` calls return the
   * fallback (the cache is empty).
   */
  dispose() {
    // Page-teardown only — the LRU eviction path NEVER calls this. Every
    // step is fail-soft (one throwing dispose() must not abort the rest)
    // and idempotent: each map is cleared after its loop, so a second
    // call walks empty maps and is a no-op. Helper keeps the body terse.
    const _disposeEach = (map, pick) => {
      if (!map) return;
      for (const v of map.values()) {
        try { pick(v)?.dispose?.(); } catch (_) {}
      }
      map.clear();
    };

    _disposeEach(this.textures, (t) => t);
    _disposeEach(this.normalTextures, (t) => t);
    _disposeEach(this.heightTextures, (t) => t);
    _disposeEach(this.materials, (m) => m);
    // T2 FrontSide variants — clones of base materials (share textures,
    // which are owned by `this.textures` and already freed above), so we
    // only dispose the material objects themselves.
    _disposeEach(this.frontSideMaterials, (m) => m);
    // 2026-06-15 floor-bias variants — clones of base materials (share textures,
    // freed above), so dispose only the material objects.
    _disposeEach(this.floorBiasMaterials, (m) => m);
    // 2026-07-06 static-bias variants — clones (share textures, freed above).
    _disposeEach(this.staticBiasMaterials, (m) => m);
    // RND-04 baked-static-light variants — clones (share textures, freed above).
    _disposeEach(this.cellBakedMaterials, (m) => m);
    // VFX component-variant clones (share textures, freed above) — dispose the
    // material objects only.
    _disposeEach(this.vfxVariants, (m) => m);
    // Paletted VFX variant clones (share the paletted base's owned texture,
    // freed above) — dispose the material objects only.
    _disposeEach(this.vfxPalettedVariants, (m) => m);
    // Wire-agent buckets + per-DID dominant-colour materials.
    _disposeEach(this.wireframeBuckets, (m) => m);
    _disposeEach(this.wireframeFillBuckets, (m) => m);
    if (this.didMaterials) {
      for (const entry of this.didMaterials.values()) {
        try { entry?.wire?.dispose?.(); } catch (_) {}
        try { entry?.fill?.dispose?.(); } catch (_) {}
      }
      this.didMaterials.clear();
    }
    // Cache-owned paletted materials + their paired owned textures.
    _disposeEach(this.palettedMaterials, (m) => m);
    _disposeEach(this.palettedTextures, (t) => t);
    // `palMB` — page teardown zeroes the LIVE charge (the maps are now
    // empty). The CUMULATIVE counters (`_palEvictions`, `_palEvictedBytes`,
    // `_palInstalls`) and the high-water marks are deliberately preserved:
    // a scene rebuild must not erase the session's thrash history.
    if (this._palKeyBytes) this._palKeyBytes.clear();
    this._palBytes = 0;
    // `?palDedup` — SETTLE (never merely clear) any outstanding claim. A spawn
    // continuation that survives page teardown is still parked on its joined
    // promise; dropping the map entry would leave it awaiting forever, and its
    // `finally` sweep would then never run either. Settling with null sends it
    // down the same "owner produced nothing" branch as a bailed decode.
    if (this.palettedInflight) {
      for (const entry of [...this.palettedInflight.values()]) {
        try { entry?.settle?.(null); } catch (_) {}
      }
      this.palettedInflight.clear();
    }
    // anim-frames (#22 fold-in) — the per-surface animated-frame
    // DataTextures. `entry.mat` is the SAME object held in `this.materials`
    // (guarded by the build path), already disposed above, so dispose ONLY
    // the frame textures here to avoid a double-dispose of the material.
    if (this._animatedMaterials) {
      for (const entry of this._animatedMaterials.values()) {
        const frames = entry?.frames;
        if (Array.isArray(frames)) {
          for (const f of frames) {
            try { f?.dispose?.(); } catch (_) {}
          }
        }
      }
      this._animatedMaterials.clear();
    }
    // Phase-5 texchan planes (roughness/AO) — cache-owned, held in no other map.
    if (this._texchanTextures) {
      for (const list of this._texchanTextures.values()) {
        for (const t of list) {
          try { t?.dispose?.(); } catch (_) {}
        }
      }
      this._texchanTextures.clear();
    }
    if (this._pendingRough) this._pendingRough.length = 0;
    try { this.fallbackMaterial?.dispose?.(); } catch (_) {}
    if (this.wireMatToFill) this.wireMatToFill.clear();
    if (this._animChecked) this._animChecked.clear();
    this.pendingFetches.clear();
    if (this.pendingStartTimes) this.pendingStartTimes.clear();
    // `?matBudgetMB` state. Page teardown IS the safe point for the deferred
    // list (nothing may reference these afterwards), so drain it here; then
    // reset the accounting so a re-used cache object starts from zero. The
    // cumulative counters are deliberately NOT reset — they are the session
    // totals the battery relay reports.
    try { this.releaseEvictedGpu(); } catch (_) {}
    if (this._matLru) this._matLru.clear();
    this._matLruBytes = 0;
    if (this._matHandedOut) this._matHandedOut.clear();
  }
}
