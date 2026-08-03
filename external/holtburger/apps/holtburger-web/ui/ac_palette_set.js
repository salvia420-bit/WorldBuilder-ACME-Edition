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
      if (!wasm?.fetch_palette_set) return null;
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
      return null; // not cached — a later call retries
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
 * ACE's `PaletteSet::GetPaletteID(shade)` rounding EXACTLY:
 * `idx = (int)((count - 0.000001) * shade)` (PaletteSet.cs:43; acclient
 * `PalSet::GetPaletteID` @470493). The `-0.000001` epsilon biases exact
 * fractional boundaries to the LOWER bucket — e.g. count=4, shade=0.25 →
 * idx 0, not 1. The pre-2026-05-28 `floor(shade * count)` picked the
 * higher bucket at boundaries (off-by-one variant selection).
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
  // R9 (2026-08-03) — NaN used to survive the clamp (Math.max(0, NaN) === NaN),
  // so `palettes[NaN]` handed back `undefined`, not the documented `null`.
  // Retail/ACE both reject an out-of-band shade outright: acclient
  // `PalSet::GetPaletteID` @470491 requires `_shade <= 1.0 && _shade >= 0.0`
  // and otherwise returns the null DID, and ACE PaletteSet.cs:31 returns 0 for
  // `hue < 0 || hue > 1`. We keep the CLAMP for in-band-but-imprecise floats
  // (all 4,776 retail Shade values in LSD-Partial are already inside [0,1], so
  // the clamp is unreachable divergence) but a non-finite shade is a caller
  // bug, not a shade — null, per this function's contract.
  const n = Number(shade);
  if (!Number.isFinite(n)) return null;
  const s = Math.max(0, Math.min(1, n));
  const idx = Math.min(
    set.palettes.length - 1,
    Math.max(0, Math.floor((set.palettes.length - 0.000001) * s)),
  );
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
