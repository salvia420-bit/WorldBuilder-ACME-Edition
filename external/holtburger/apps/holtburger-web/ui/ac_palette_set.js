/**
 * AC PaletteSet (DAT 0x0F) lookup runtime.
 *
 * A PaletteSet is a bundle of Palette (0x04) DataIDs that a `shade`
 * float indexes into for character skin/hair tinting and for
 * ClothingTable `CloSubPalette::palette_set` references (the
 * server-pushed dye/variant overlays).
 *
 * This runtime is the standalone reader — useful for character
 * customization / dye-picker UIs that want to enumerate variants
 * without going through the per-pixel surface composer (which
 * already handles the full Clothing → palette compose chain via
 * `fetch_entity_surface_pixels`).
 *
 *   - `loadPaletteSet(id)`  → Promise<PalSetRuntime | null>
 *   - `getPaletteSet(id)`   → PalSetRuntime | null  (sync)
 *   - `pickPaletteForShade(set, shade)` → palette_did | null
 */

const runtimes = new Map();
const inFlight = new Map();

/**
 * Load + cache a PaletteSet by DataID. Idempotent.
 *
 * @param {number} setId — DataID of the PaletteSet (0x0Fxxxxxx).
 * @returns {Promise<PalSetRuntime | null>}
 */
export async function loadPaletteSet(setId) {
  const cached = runtimes.get(setId);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(setId);
  if (pending) return pending;

  const promise = (async () => {
    const wasm = window.__hbWasm ?? window.__wasm ?? null;
    if (!wasm?.fetch_palette_set) {
      runtimes.set(setId, null);
      return null;
    }
    try {
      const json = await wasm.fetch_palette_set(setId >>> 0);
      const data = JSON.parse(json);
      if (!data || !Array.isArray(data.palettes) || data.palettes.length === 0) {
        try { window.__diag?.palettes?.onLoadFailed?.({ setId, error: "empty", source: "empty" }); } catch (_) {}
        runtimes.set(setId, null);
        return null;
      }
      const runtime = {
        id: data.id >>> 0,
        palettes: data.palettes.map((p) => p >>> 0),
      };
      runtimes.set(setId, runtime);
      try { window.__diag?.palettes?.onLoadSucceeded?.({ setId, paletteCount: runtime.palettes.length }); } catch (_) {}
      return runtime;
    } catch (err) {
      console.warn(`[ac-palette-set] 0x${setId.toString(16)} load failed:`, err);
      try { window.__diag?.palettes?.onLoadFailed?.({ setId, error: err, source: "fetch" }); } catch (_) {}
      runtimes.set(setId, null);
      return null;
    } finally {
      inFlight.delete(setId);
    }
  })();
  inFlight.set(setId, promise);
  return promise;
}

/**
 * Sync accessor. Returns the cached PaletteSet runtime or null.
 */
export function getPaletteSet(setId) {
  const v = runtimes.get(setId);
  return v === undefined ? null : v;
}

/**
 * Pick the Palette DataID for a given shade float in [0, 1]. Mirrors
 * ACE's `PaletteSet::GetPaletteID(shade)` rounding semantics:
 * `idx = clamp(floor(shade * palettes.length), 0, palettes.length - 1)`.
 *
 * Returns the chosen palette_did, or null if the PaletteSet isn't
 * loaded.
 *
 * @param {PalSetRuntime | null} set
 * @param {number} shade — 0..1
 * @returns {number | null}
 */
export function pickPaletteForShade(set, shade) {
  if (!set?.palettes?.length) return null;
  const s = Math.max(0, Math.min(1, shade));
  const idx = Math.min(set.palettes.length - 1, Math.floor(s * set.palettes.length));
  return set.palettes[idx];
}

/**
 * Diag-layer accessor. Used by `scene3d/diag/palettes.js`.
 */
export function getPaletteSetDiagSnapshot() {
  return {
    sets: Array.from(runtimes.entries())
      .filter(([, r]) => r !== null)
      .map(([sid, r]) => ({ setId: sid, paletteCount: r.palettes.length })),
  };
}
