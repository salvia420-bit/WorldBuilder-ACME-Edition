/**
 * AC dye-preview compositor.
 *
 * Wave 7.8 — Phase C of `handoff-clothing-table-2026-05-24.md` § C.
 * Given a (ClothingTable, target Setup, paletteTemplate, shade),
 * returns a `<canvas>` showing the dye-overlayed texture appearance.
 * Implementation strategy (i) from the handoff: call the existing
 * `fetchEntitySurfacesPixels` wasm export with synthetic
 * (palette_id, sub_palettes) triples — guaranteed byte-parity with
 * the spawn-time render path that ACE pre-computes via
 * `Creature.CalculateObjDesc` (Source/ACE.Server/WorldObjects/
 * WorldObject_Networking.cs).
 *
 * Why composite the mesh texture and not the icon? CloSubPalEffect.
 * icon is a per-variant baked-in image (one DID per paletteTemplate)
 * and doesn't vary with shade — useful as a static thumbnail but
 * useless for the "what does shade=0.3 look like?" question. The
 * mesh texture (CloObjectEffect.clo_texture_effects[].new_texture)
 * IS what the dye sub_palettes overlay onto, so previewing the
 * composed mesh texture mirrors what a player actually sees after
 * the recipe commits server-side.
 *
 * Public API:
 *  - `composeDyePreview(clothingId, setupDid, paletteTemplate, shade)`
 *    → Promise<Canvas | null>
 *  - `loadIconThumbnail(iconDid)` → Promise<Canvas | null>
 *  - `clearPreviewCache()` (test helper)
 *
 * Caching: keyed by `(clothingId, setupDid, paletteTemplate,
 * round(shade * 100))`. Quantizing shade to 0.01 caps the cache at
 * 100 buckets per (clothing, setup, template) tuple — bounded for
 * a typical wardrobe.
 */

import { loadClothingTable, getCloObjectEffects, getCloSubPalEffect } from "./ac_clothing.js";
import { loadPaletteSet, pickPaletteForShade } from "./ac_palette_set.js";

const previewCache = new Map(); // cacheKey → Canvas
const inFlight = new Map();     // cacheKey → Promise<Canvas|null>
const iconCache = new Map();    // iconDid → Canvas
const iconInFlight = new Map(); // iconDid → Promise<Canvas|null>

const MAX_PREVIEW_CACHE = 256;
const MAX_ICON_CACHE = 256;

function _cacheKey(clothingId, setupDid, paletteTemplate, shade) {
  const sBucket = Math.round(Math.max(0, Math.min(1, shade)) * 100);
  return `${clothingId >>> 0}:${setupDid >>> 0}:${paletteTemplate >>> 0}:${sBucket}`;
}

function _evictLruIfNeeded(cache, max) {
  if (cache.size <= max) return;
  let evicted = 0;
  for (const key of cache.keys()) {
    if (cache.size <= max) break;
    cache.delete(key);
    evicted += 1;
  }
  return evicted;
}

/**
 * Compose a dye preview canvas for the given clothing/setup/template/
 * shade combination.
 *
 * @param {number} clothingId — ClothingTable DataID (0x10xxxxxx)
 * @param {number} setupDid — target SetupModel (0x02xxxxxx) keying ClothingBaseEffects
 * @param {number} paletteTemplate — sub-pal-effect key (0/1/2/... depending on item)
 * @param {number} shade — 0..1 (clamped + quantized to 0.01 buckets for caching)
 * @returns {Promise<HTMLCanvasElement | null>}
 */
export async function composeDyePreview(clothingId, setupDid, paletteTemplate, shade) {
  const cacheKey = _cacheKey(clothingId, setupDid, paletteTemplate, shade);
  const cached = previewCache.get(cacheKey);
  if (cached) {
    try { window.__diag?.clothing?.onDyePreviewCacheHit?.({ cacheKey }); } catch (_) {}
    return cached;
  }
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const ct = await loadClothingTable(clothingId);
      if (!ct) return null;

      // Pick a representative dye-affected texture as the swatch
      // target. Walk the CloObjectEffects for this setup; CloTexture
      // Effect.old_texture is the BASE palettized texture that dye
      // sub_palettes overlay onto. new_texture is the variant-
      // swapped result — sometimes already-baked + not palettized,
      // which makes it dye-inert.
      const objectEffects = getCloObjectEffects(ct, setupDid);
      let targetSurfaceDid = 0;
      for (const oe of objectEffects) {
        const texs = oe.clo_texture_effects || [];
        if (texs.length > 0) {
          targetSurfaceDid = (texs[0].old_texture || texs[0].new_texture) >>> 0;
          if (targetSurfaceDid) break;
        }
      }
      if (!targetSurfaceDid) {
        try { window.__diag?.clothing?.onDyePreviewFailed?.({ cacheKey, reason: "no target surface" }); } catch (_) {}
        return null;
      }

      // Resolve the (paletteTemplate, shade) → sub_palette overlay triples.
      // Per fetch_entity_surface_pixels_impl (lib.rs:~L5606), each triple's
      // first u32 is an ALREADY-RESOLVED Palette DID (0x04 prefix), not a
      // PaletteSet ID. JS-side resolution mirrors ACE's
      // GetPaletteID(shade) call from CalculateObjDesc.
      const subPalEffect = getCloSubPalEffect(ct, paletteTemplate);
      if (!subPalEffect) {
        try { window.__diag?.clothing?.onDyePreviewFailed?.({ cacheKey, reason: "no sub-pal effect" }); } catch (_) {}
        return null;
      }
      const triples = [];
      for (const sp of (subPalEffect.clo_sub_palettes || [])) {
        const set = await loadPaletteSet(sp.palette_set);
        if (!set) continue;
        const palDid = pickPaletteForShade(set, shade);
        if (!palDid) continue;
        for (const range of (sp.ranges || [])) {
          triples.push(palDid >>> 0, range.offset | 0, range.num_colors | 0);
        }
      }

      // Composite via the dedicated dye-preview compositor (Wave 7.8
      // wasm helper). It takes a SurfaceTexture (0x05) DID directly
      // — short-circuiting the Surface (0x08) → SurfaceTexture
      // indirection — and composes the chosen sub_palette overlay
      // onto the texture's intrinsic palette. Byte-parity with the
      // spawn-time entity render path because the underlying
      // overlay loop is the same `for (sub_id, offset, length) in
      // triples` from fetch_entity_surface_pixels_impl.
      const wasm = window.__hbWasm ?? window.__wasm ?? null;
      if (!wasm?.fetch_dye_preview_pixels) {
        try { window.__diag?.clothing?.onDyePreviewFailed?.({ cacheKey, reason: "no wasm helper" }); } catch (_) {}
        return null;
      }
      const sp = await wasm.fetch_dye_preview_pixels(
        targetSurfaceDid,
        new Uint32Array(triples),
      );
      if (!sp || sp.width === 0 || sp.height === 0) {
        if (sp && typeof sp.free === "function") sp.free();
        try { window.__diag?.clothing?.onDyePreviewFailed?.({ cacheKey, reason: "empty pixels" }); } catch (_) {}
        return null;
      }

      // Wrap pixels in a Canvas. pixels is a Uint8Array view over
      // wasm linear memory; copy via Uint8ClampedArray.from to detach
      // from the wasm-side buffer.
      const canvas = document.createElement("canvas");
      canvas.width = sp.width;
      canvas.height = sp.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        if (typeof sp.free === "function") sp.free();
        return null;
      }
      // Capture wasm-side dimensions BEFORE freeing — sp.free()
      // invalidates the wasm-bindgen handle; subsequent property
      // access throws "null pointer passed to rust" (silently
      // swallowed by an outer try/catch, which is how this took 4
      // verification cycles to spot).
      const spWidth = sp.width;
      const spHeight = sp.height;
      const imgData = ctx.createImageData(spWidth, spHeight);
      imgData.data.set(sp.pixels);
      ctx.putImageData(imgData, 0, 0);
      if (typeof sp.free === "function") sp.free();

      previewCache.set(cacheKey, canvas);
      _evictLruIfNeeded(previewCache, MAX_PREVIEW_CACHE);
      try {
        window.__diag?.clothing?.onDyePreviewRendered?.({
          cacheKey,
          clothingId,
          setupDid,
          paletteTemplate,
          shade,
          targetSurfaceDid,
          tripleCount: (triples.length / 3) | 0,
          width: spWidth,
          height: spHeight,
        });
      } catch (_) {}
      return canvas;
    } catch (err) {
      console.warn("[ac-dye-preview] composeDyePreview failed:", err);
      try { window.__diag?.clothing?.onDyePreviewFailed?.({ cacheKey, reason: String(err?.message ?? err) }); } catch (_) {}
      return null;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();
  inFlight.set(cacheKey, promise);
  return promise;
}

/**
 * Load a per-variant icon thumbnail via the existing
 * `fetch_surface_pixels` export. The icon is a pre-baked variant
 * image — fixed for a given (paletteTemplate); does not vary with
 * shade. Use as a static thumbnail in the dye-picker UI when the
 * user just wants to identify which template is which.
 *
 * @param {number} iconDid — Surface DataID (0x08xxxxxx)
 * @returns {Promise<HTMLCanvasElement | null>}
 */
/**
 * Wave 7.9.A — resolve a (clothingId, paletteTemplate, shade) tuple
 * to the flat `[palette_did, offset, length, ...]` triple buffer that
 * the wasm dye compositor + the entity render path both consume.
 * Extracted from `composeDyePreview` so the 3D viewport plugin can
 * call it without going through the full canvas-composing path.
 *
 * Returns `null` when ClothingTable or the sub-pal effect for the
 * requested paletteTemplate isn't available.
 *
 * @param {number} clothingId — ClothingTable DataID
 * @param {number} paletteTemplate — sub-pal effect key
 * @param {number} shade — 0..1
 * @returns {Promise<Uint32Array | null>}
 */
export async function resolveDyeTriples(clothingId, paletteTemplate, shade) {
  const ct = await loadClothingTable(clothingId);
  if (!ct) return null;
  const subPalEffect = getCloSubPalEffect(ct, paletteTemplate);
  if (!subPalEffect) return null;
  const triples = [];
  for (const sp of (subPalEffect.clo_sub_palettes || [])) {
    const set = await loadPaletteSet(sp.palette_set);
    if (!set) continue;
    const palDid = pickPaletteForShade(set, shade);
    if (!palDid) continue;
    for (const range of (sp.ranges || [])) {
      triples.push(palDid >>> 0, range.offset | 0, range.num_colors | 0);
    }
  }
  return new Uint32Array(triples);
}

export async function loadIconThumbnail(iconDid) {
  const key = iconDid >>> 0;
  if (key === 0) return null;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const pending = iconInFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const wasm = window.__hbWasm ?? window.__wasm ?? null;
      if (!wasm?.fetch_surface_pixels) return null;
      const sp = await wasm.fetch_surface_pixels(key);
      if (!sp || sp.width === 0 || sp.height === 0) {
        if (sp && typeof sp.free === "function") sp.free();
        return null;
      }
      const canvas = document.createElement("canvas");
      canvas.width = sp.width;
      canvas.height = sp.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        if (typeof sp.free === "function") sp.free();
        return null;
      }
      const imgData = ctx.createImageData(sp.width, sp.height);
      imgData.data.set(sp.pixels);
      ctx.putImageData(imgData, 0, 0);
      if (typeof sp.free === "function") sp.free();
      iconCache.set(key, canvas);
      _evictLruIfNeeded(iconCache, MAX_ICON_CACHE);
      return canvas;
    } catch (err) {
      console.warn(`[ac-dye-preview] loadIconThumbnail 0x${key.toString(16)} failed:`, err);
      return null;
    } finally {
      iconInFlight.delete(key);
    }
  })();
  iconInFlight.set(key, promise);
  return promise;
}

/** Test helper — drop both caches. */
export function clearPreviewCache() {
  previewCache.clear();
  iconCache.clear();
}

/** Diag-layer accessor for __diag.clothing read-through. */
export function getDyePreviewDiagSnapshot() {
  return {
    previewCacheSize: previewCache.size,
    previewCacheMax: MAX_PREVIEW_CACHE,
    iconCacheSize: iconCache.size,
    iconCacheMax: MAX_ICON_CACHE,
    previewInFlight: inFlight.size,
    iconInFlight: iconInFlight.size,
  };
}
