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
//     - Base1ClipMap  = 0x4   → alphaTest = 0.5  (binary alpha mask)
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
import { surfacePixelsToTexture } from "./adapter.js";

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

// Phase 1.4 — heuristic surface category mirror.
// MUST match the `SurfaceCategory::as_u8` encoding in
// `crates/holtburger-dat/src/surface_classify.rs`. See the JS-side
// `_materialFromFlags` for category-aware roughness / metalness
// defaults. The Rust-side classifier ships these as a single u8 on
// `SurfacePixels.category`.
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

// Category-aware material defaults — applied AFTER the surface-type
// flag decoder. Categories listed in §Phase 1.4 Objectives #4 get
// concrete roughness / metalness values; the rest fall through to
// the existing 0.9 / 0.0 defaults.
//
// normalScale defaults are intentionally left at the THREE default
// (`new Vector2(1, 1)` once Phase 1.1's procedural normal maps land);
// this phase only touches roughness + metalness. Documenting this so
// Phase 1.1 doesn't accidentally double-set normalScale here.
const CATEGORY_MATERIAL_DEFAULTS = Object.freeze({
  [SURFACE_CATEGORY.Stone]: { roughness: 0.85, metalness: 0.0 },
  [SURFACE_CATEGORY.Wood]: { roughness: 0.8, metalness: 0.0 },
  [SURFACE_CATEGORY.Metal]: { roughness: 0.3, metalness: 0.9 },
  [SURFACE_CATEGORY.Sand]: { roughness: 0.95, metalness: 0.0 },
  [SURFACE_CATEGORY.Lava]: { roughness: 0.4, metalness: 0.0 },
  [SURFACE_CATEGORY.Foliage]: { roughness: 0.85, metalness: 0.0 },
  // Water, Cloth, Dirt, Snow, Brick, Tile, Generic — fall through
  // to the existing 0.9 / 0.0 defaults until Phase 1.5 overrides
  // tune them per real-DID survey.
});

export class MaterialCache {
  constructor() {
    /** @type {Map<number, THREE.MeshStandardMaterial>} */
    this.materials = new Map();
    /** @type {Map<number, THREE.DataTexture>} */
    this.textures = new Map();
    /** @type {Map<number, Promise<THREE.MeshStandardMaterial>>} */
    this.pendingFetches = new Map();

    // Shared fallback for the 0xFF "no surface" bucket and for any
    // surface DID that fails to resolve (zero-size SurfacePixels, etc).
    this.fallbackMaterial = new THREE.MeshStandardMaterial({
      color: 0x888888,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    this.fallbackMaterial.name = "scene3d-fallback";

    // Diagnostic counters so capture scripts can see how many
    // textures resolved vs fell back without a separate probe.
    this.fallbackHits = 0;
    this.realHits = 0;
  }

  /**
   * Synchronous lookup. Returns the cached material for `surfaceDid`,
   * or the shared fallback if none is loaded yet (or `surfaceDid === 0`,
   * the FALLBACK sentinel emitted by `meshToGeometryGroups`).
   *
   * Bumps `realHits` / `fallbackHits` so callers can spot the ratio
   * of resolved vs fallback materials at instantiation time.
   */
  getCached(surfaceDid) {
    if (surfaceDid === FALLBACK_SURFACE_DID) {
      this.fallbackHits += 1;
      return this.fallbackMaterial;
    }
    const m = this.materials.get(surfaceDid >>> 0);
    if (m) {
      this.realHits += 1;
      return m;
    }
    this.fallbackHits += 1;
    return this.fallbackMaterial;
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
   *   - Base1ClipMap (0x4): `alphaTest = 0.5, transparent = false`.
   *     Binary alpha mask — the alpha channel cuts holes (foliage,
   *     fence cutouts) without depth-sort issues.
   *   - Luminous (0x40): emissive map + colour. Self-illuminating
   *     surfaces (torches, lanterns, glowing runes) survive even when
   *     the sun is off in indoor cells.
   *   - Additive (0x10000): `blending = AdditiveBlending` +
   *     `transparent = true, depthWrite = false`. For flame, sparks,
   *     and other particle-style additive surfaces.
   *   - Diffuse (0x20): `metalness = 0.0, roughness = 1.0` — matte,
   *     no specular reflection.
   *   - **No explicit TwoSided bit.** All surfaces default to
   *     `side: DoubleSide` because the AC two-sidedness bit lives on
   *     the Polygon (`sides_type == 0x2`), not the Surface; the Rust
   *     triangulator handles the distinct-pos/neg case by emitting
   *     two tris with opposite winding.
   *
   * `surfaceTypeFlags === 0` (the empty-surface fallback) hits the
   * opaque path → standard albedo material with DoubleSide.
   */
  _materialFromFlags(surfaceTypeFlags, texture, category) {
    const flags = surfaceTypeFlags >>> 0;
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
    const isLuminous = (flags & SURFACE_TYPE.Luminous) !== 0;
    const isAdditive = (flags & SURFACE_TYPE.Additive) !== 0;
    const isDiffuse = (flags & SURFACE_TYPE.Diffuse) !== 0;
    if (isAdditive) {
      // Additive blend (flames, sparks). depthWrite=false so additive
      // surfaces don't occlude geometry behind them.
      opts.blending = THREE.AdditiveBlending;
      opts.transparent = true;
      opts.depthWrite = false;
    } else if (isTranslucent) {
      // True alpha blend. depthWrite=false to avoid sort artefacts
      // (the renderer painter-sorts transparent objects automatically).
      opts.transparent = true;
      opts.depthWrite = false;
    } else if (isClipMap) {
      // Binary alpha mask (foliage, fences). alphaTest cuts the
      // alpha=0 fragments at rasterise time → no transparency sort.
      opts.alphaTest = 0.5;
      opts.transparent = false;
    }
    if (isLuminous) {
      // Self-illuminating. emissiveMap reuses the same texture so the
      // entire surface glows according to its colour values; the white
      // multiplier on `emissive` lets the unmodulated texture pass
      // through. emissiveIntensity=0.6 keeps it bright but doesn't
      // saturate (1.0 looks blown-out under the default sun rig).
      // Phase 1.4 — Lava category still sets roughness=0.4 above; the
      // Luminous flag overlays emissive on top without overriding it.
      opts.emissive = new THREE.Color(0xffffff);
      opts.emissiveMap = texture;
      opts.emissiveIntensity = 0.6;
    }
    if (isDiffuse) {
      // Diffuse flag wins over category-default roughness — AC's
      // explicit matte hint should trump heuristic guesses.
      opts.roughness = 1.0; // matte — no specular highlight
      opts.metalness = 0.0;
    }
    return new THREE.MeshStandardMaterial(opts);
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
    if (surfaceDid === FALLBACK_SURFACE_DID) {
      return this.fallbackMaterial;
    }
    const did = surfaceDid >>> 0;
    if (this.materials.has(did)) {
      return this.materials.get(did);
    }
    if (this.pendingFetches.has(did)) {
      return this.pendingFetches.get(did);
    }
    const p = (async () => {
      const results = await fetchSurfacesPixels(new Uint32Array([did]));
      const sp = results[0];
      if (!sp || sp.width === 0 || sp.height === 0) {
        // Free the empty wasm-bindgen handle and return the shared
        // fallback. NOT cached — a future preload that resolves the
        // same DID via a different code path can still install a real
        // material.
        if (sp && typeof sp.free === "function") sp.free();
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
      if (typeof sp.free === "function") sp.free();
      const mat = this._materialFromFlags(surfaceTypeFlags, tex, category);
      mat.name = `scene3d-surface-${did.toString(16).padStart(8, "0")}`;
      mat.userData = {
        ...(mat.userData || {}),
        surfaceTypeFlags,
        surfaceCategory: category,
      };
      this.textures.set(did, tex);
      this.materials.set(did, mat);
      return mat;
    })();
    this.pendingFetches.set(did, p);
    try {
      return await p;
    } finally {
      this.pendingFetches.delete(did);
    }
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
    // Dedupe + filter cached. The 0 sentinel never goes to wasm.
    const need = [];
    for (const did of surfaceDids) {
      const d = did >>> 0;
      if (d === FALLBACK_SURFACE_DID) continue;
      if (this.materials.has(d)) continue;
      if (this.pendingFetches.has(d)) continue;
      need.push(d);
    }
    if (need.length === 0) return 0;

    // Install one shared promise per DID before the wasm call so
    // concurrent `get()` calls latch on.
    const ids = new Uint32Array(need);
    const sharedFetch = fetchSurfacesPixels(ids);
    for (const d of need) {
      this.pendingFetches.set(
        d,
        sharedFetch.then((all) => {
          // Each parallel slot has the matching SurfacePixels; bind
          // by index in `need`.
          const i = need.indexOf(d);
          const sp = all[i];
          return this._installFromPixels(d, sp);
        })
      );
    }

    let results;
    try {
      results = await sharedFetch;
    } catch (e) {
      // Bulk fetch failed entirely — clear all pending so subsequent
      // calls can retry. Caller's await of `preload()` will reject.
      for (const d of need) this.pendingFetches.delete(d);
      throw e;
    }

    let resolved = 0;
    for (let i = 0; i < need.length; i += 1) {
      const d = need[i];
      const sp = results[i];
      const installed = this._installFromPixels(d, sp);
      if (installed !== this.fallbackMaterial) resolved += 1;
      this.pendingFetches.delete(d);
    }
    return resolved;
  }

  _installFromPixels(did, sp) {
    if (!sp) return this.fallbackMaterial;
    // wasm-bindgen wrappers around a null Rust pointer throw on every
    // getter (`.width` / `.height` / `.pixels`), so read them once under
    // a try/catch instead of an inline `sp.width === 0` check. A throw
    // here means the surface DID had no pixels — fall back to the
    // shared fallback material exactly as for the zero-dim case.
    let w, h, pixels, surfaceType, category;
    try {
      w = sp.width;
      h = sp.height;
    } catch (_) {
      return this.fallbackMaterial;
    }
    if (w === 0 || h === 0) {
      try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
      return this.fallbackMaterial;
    }
    try {
      pixels = sp.pixels;
      surfaceType = sp.surfaceType ?? 0;
      // Phase 1.4: heuristic category as u8. Missing getter on older
      // wasm builds → undefined → generic defaults in _materialFromFlags.
      category = typeof sp.category === "number" ? sp.category : undefined;
    } catch (_) {
      return this.fallbackMaterial;
    }
    const tex = surfacePixelsToTexture(pixels, w, h);
    // Phase 7 follow-on #7+8: surface_type bitfield from the wasm side.
    const surfaceTypeFlags = surfaceType >>> 0;
    try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
    const mat = this._materialFromFlags(surfaceTypeFlags, tex, category);
    mat.name = `scene3d-surface-${did.toString(16).padStart(8, "0")}`;
    mat.userData = {
      ...(mat.userData || {}),
      surfaceTypeFlags,
      surfaceCategory: category,
    };
    this.textures.set(did, tex);
    this.materials.set(did, mat);
    return mat;
  }

  /**
   * Free GPU resources owned by this cache. Materials don't dispose
   * their textures automatically in three.js, so we walk both maps.
   * Safe to call multiple times; future `get()` calls return the
   * fallback (the cache is empty).
   */
  dispose() {
    for (const tex of this.textures.values()) tex.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    this.fallbackMaterial.dispose();
    this.materials.clear();
    this.textures.clear();
    this.pendingFetches.clear();
  }
}
