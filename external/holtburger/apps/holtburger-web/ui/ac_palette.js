/**
 * AC Palette (DAT 0x04) reader.
 *
 * Each Palette is a 256-entry ARGB lookup table (some are shorter —
 * the wire format has an explicit count). Palettes are referenced
 * by palettized [`Texture`] records and by [`PaletteSet`] entries
 * (the dye/variant chain).
 *
 *   - `loadPalette(id)`              → Promise<PaletteRuntime | null>
 *   - `getPalette(id)`               → PaletteRuntime | null  (sync)
 *   - `paletteColor(rt, index)`      → {r, g, b, a} | null
 *
 * Wave 7.7 — Phase B of the Clothing II dye-picker foundation. The
 * spawn-time dye compositor (lib.rs::fetch_entity_surface_pixels_impl)
 * already reads Palette records internally; this runtime exists for
 * plugins that need to inspect the raw colour table directly (dye-
 * picker thumbnails, character-creation swatches, debug overlays).
 *
 * Companion to `ui/ac_palette_set.js` which loads bundles of these.
 * A typical dye lookup is:
 *   1. `loadClothingTable(clothingId)` → ClothingRuntime
 *   2. `getCloSubPalEffect(rt, paletteTemplate)` → {clo_sub_palettes}
 *   3. `loadPaletteSet(sp.palette_set)` → PaletteSet
 *   4. `pickPaletteForShade(set, shade)` → palette_did
 *   5. `loadPalette(palette_did)` → 256 colours (this runtime)
 *   6. Apply ranges to base palette + composite into texture pixels
 *      (step 6 is the wasm-side `fetch_entity_surface_pixels_impl`
 *      job today; preview compositors that want to bypass wasm can
 *      do it in JS here)
 */

/**
 * @typedef {Object} PaletteRuntime
 * @property {number} id
 * @property {Uint32Array} colors — ARGB u32 per entry, alpha in the high byte
 */

const runtimes = new Map();
const inFlight = new Map();

/**
 * Load + cache a Palette by DataID. Idempotent.
 *
 * @param {number} paletteId — DataID (0x04xxxxxx).
 * @returns {Promise<PaletteRuntime | null>}
 */
export async function loadPalette(paletteId) {
  const cached = runtimes.get(paletteId);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(paletteId);
  if (pending) return pending;

  const promise = (async () => {
    // R9 (2026-08-03) — yield once so the `inFlight.set(...)` below has run
    // before this body (and its `finally`) executes. Without it the
    // synchronous wasm-missing early return fired `inFlight.delete` BEFORE
    // the matching set, and the set then pinned a settled promise. Same
    // ordering hazard ui/ac_layout.js documents on loadLayout.
    await Promise.resolve();
    try {
      const wasm = window.__hbWasm ?? window.__wasm ?? null;
      // R9 — "wasm isn't ready yet" is transient (plugins mount before
      // init_resource_source resolves); memoising it as `null` blanked this
      // record for the WHOLE session with no way back. Unproven failures are
      // NOT cached — only the authoritative DAT answers below are. Same rule
      // as ui/ac_icon_cache.js §P0.4 / LEAK-03 and ui/ac_layout.js.
      if (!wasm?.fetch_palette) return null;
      const json = await wasm.fetch_palette(paletteId >>> 0);
      const data = JSON.parse(json);
      if (!data || !Array.isArray(data.colors) || data.colors.length === 0) {
        try { window.__diag?.palettes?.onPaletteLoadFailed?.({ paletteId, error: "empty", source: "empty" }); } catch (_) {}
        runtimes.set(paletteId, null);
        return null;
      }
      const runtime = {
        id: data.id >>> 0,
        colors: new Uint32Array(data.colors.map((c) => c >>> 0)),
      };
      runtimes.set(paletteId, runtime);
      try { window.__diag?.palettes?.onPaletteLoaded?.({ paletteId, colorCount: runtime.colors.length }); } catch (_) {}
      return runtime;
    } catch (err) {
      console.warn(`[ac-palette] 0x${paletteId.toString(16)} load failed:`, err);
      try { window.__diag?.palettes?.onPaletteLoadFailed?.({ paletteId, error: err, source: "fetch" }); } catch (_) {}
      return null; // not cached — a later call retries
    } finally {
      inFlight.delete(paletteId);
    }
  })();
  inFlight.set(paletteId, promise);
  return promise;
}

/**
 * Sync accessor. Returns the cached Palette runtime or null.
 */
export function getPalette(paletteId) {
  const v = runtimes.get(paletteId);
  return v === undefined ? null : v;
}

/**
 * Resolve one palette entry to a {r, g, b, a} record (each 0-255).
 * Returns `null` when the palette isn't loaded or the index is out
 * of range.
 *
 * @param {PaletteRuntime | null} runtime
 * @param {number} index — 0..colors.length
 * @returns {{r:number, g:number, b:number, a:number} | null}
 */
export function paletteColor(runtime, index) {
  if (!runtime?.colors) return null;
  const i = index | 0;
  if (i < 0 || i >= runtime.colors.length) return null;
  const argb = runtime.colors[i] >>> 0;
  return {
    a: (argb >>> 24) & 0xFF,
    r: (argb >>> 16) & 0xFF,
    g: (argb >>> 8) & 0xFF,
    b: argb & 0xFF,
  };
}

/**
 * Diag-layer accessor. Used by `scene3d/diag/palettes.js` to surface
 * loaded Palettes alongside the existing PaletteSet read-through.
 */
export function getPaletteDiagSnapshot() {
  return {
    palettes: Array.from(runtimes.entries())
      .filter(([, r]) => r !== null)
      .map(([pid, r]) => ({ paletteId: pid, colorCount: r.colors.length })),
  };
}
