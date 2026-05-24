/**
 * AC ClothingTable (DAT 0x10) lookup runtime.
 *
 * Wraps `fetch_clothing_table(id)` with a JS layer that decodes the
 * serde_json-serialized payload (HashMap keys come back as strings)
 * and exposes ergonomic accessors for the common wardrobe queries.
 *
 *   - `loadClothingTable(id)`            → Promise<ClothingRuntime | null>
 *   - `getClothingTable(id)`             → ClothingRuntime | null  (sync)
 *   - `getCloObjectEffects(rt, setupDid)`
 *     → Array<{index, model_id, clo_texture_effects}>
 *     The body-part overrides applied when the given Setup is worn —
 *     this is what an Option-(a) helmet-swap consumer needs.
 *   - `getCloSubPalEffect(rt, paletteTemplate)`
 *     → {icon, clo_sub_palettes} | null
 *     The icon + dye-overlay set keyed by palette-template index. Used
 *     by an Option-(d) dye-picker.
 *
 * The spawn-time path already plumbs ModelData.texture_changes +
 * model_changes + sub_palettes through to `fetch_entity_animation_
 * keyframes` (src/lib.rs:~L10778), so for ObjectCreate the visible
 * equipped state is computed automatically. This runtime exists for
 * code that needs to *enumerate* a wardrobe without triggering a
 * spawn — character creation, dye-picker UI, examine-target popover.
 *
 * Equip-change mid-game (UpdateObject opcode 0xF7DB) is a separate
 * wire path NOT yet routed — see `docs/handoff-clothing-table-2026-
 * 05-24.md` § "Equip-mid-game (UpdateObject) follow-on".
 */

/**
 * @typedef {Object} ClothingRuntime
 * @property {number} id
 * @property {Map<number, {clo_object_effects: Array<{index:number, model_id:number, clo_texture_effects:Array<{old_texture:number, new_texture:number}>}>}>} clothingBaseEffects
 * @property {Map<number, {icon:number, clo_sub_palettes:Array<{palette_set:number, ranges:Array<{offset:number, num_colors:number}>}>}>} clothingSubPalEffects
 */

const runtimes = new Map();
const inFlight = new Map();

/**
 * Load + decode a ClothingTable by DataID. Idempotent.
 *
 * @param {number} clothingId — DataID (0x10xxxxxx).
 * @returns {Promise<ClothingRuntime | null>}
 */
export async function loadClothingTable(clothingId) {
  const cached = runtimes.get(clothingId);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(clothingId);
  if (pending) return pending;

  const promise = (async () => {
    const wasm = window.__hbWasm ?? window.__wasm ?? null;
    if (!wasm?.fetch_clothing_table) {
      runtimes.set(clothingId, null);
      return null;
    }
    try {
      const json = await wasm.fetch_clothing_table(clothingId >>> 0);
      const data = JSON.parse(json);
      if (!data || data === null) {
        try { window.__diag?.clothing?.onLoadFailed?.({ clothingId, error: "empty", source: "empty" }); } catch (_) {}
        runtimes.set(clothingId, null);
        return null;
      }
      const runtime = _buildRuntime(data);
      runtimes.set(clothingId, runtime);
      try {
        window.__diag?.clothing?.onLoadSucceeded?.({
          clothingId,
          baseEffectCount: runtime.clothingBaseEffects.size,
          subPalEffectCount: runtime.clothingSubPalEffects.size,
        });
      } catch (_) {}
      return runtime;
    } catch (err) {
      console.warn(`[ac-clothing] 0x${clothingId.toString(16)} load failed:`, err);
      try { window.__diag?.clothing?.onLoadFailed?.({ clothingId, error: err, source: "fetch" }); } catch (_) {}
      runtimes.set(clothingId, null);
      return null;
    } finally {
      inFlight.delete(clothingId);
    }
  })();
  inFlight.set(clothingId, promise);
  return promise;
}

/**
 * Sync accessor. Returns the cached ClothingTable runtime or null.
 */
export function getClothingTable(clothingId) {
  const v = runtimes.get(clothingId);
  return v === undefined ? null : v;
}

/**
 * Return the per-body-part overrides applied when the given Setup is
 * worn. Each entry's `index` is the part-slot, `model_id` is the
 * substitute GfxObj (or 0 for no model swap), and
 * `clo_texture_effects` is the list of old→new SurfaceTexture pairs.
 *
 * @param {ClothingRuntime | null} runtime
 * @param {number} setupDid
 * @returns {Array<{index:number, model_id:number, clo_texture_effects:Array<{old_texture:number, new_texture:number}>}>}
 */
export function getCloObjectEffects(runtime, setupDid) {
  if (!runtime?.clothingBaseEffects) return [];
  const eff = runtime.clothingBaseEffects.get(setupDid >>> 0);
  if (!eff?.clo_object_effects) return [];
  return eff.clo_object_effects;
}

/**
 * Return the icon + dye-overlay set keyed by palette-template index.
 * `clo_sub_palettes` is an array of {palette_set, ranges[]} the dye
 * picker walks.
 *
 * @param {ClothingRuntime | null} runtime
 * @param {number} paletteTemplate
 * @returns {{icon:number, clo_sub_palettes:Array<{palette_set:number, ranges:Array<{offset:number, num_colors:number}>}>} | null}
 */
export function getCloSubPalEffect(runtime, paletteTemplate) {
  if (!runtime?.clothingSubPalEffects) return null;
  return runtime.clothingSubPalEffects.get(paletteTemplate >>> 0) ?? null;
}

/**
 * Diag-layer accessor. Used by `scene3d/diag/clothing.js`.
 */
export function getClothingDiagSnapshot() {
  return {
    tables: Array.from(runtimes.entries())
      .filter(([, r]) => r !== null)
      .map(([cid, r]) => ({
        clothingId: cid,
        baseEffectCount: r.clothingBaseEffects.size,
        subPalEffectCount: r.clothingSubPalEffects.size,
      })),
  };
}

// ---------------------------------------------------------------------
// Internal helpers

function _buildRuntime(data) {
  // serde_json serialises HashMap<u32, _> as { "<numeric-string>": _ };
  // walk the entries + parse the string back to a number so callers
  // can pass setup_did / palette_template as a real u32.
  const clothingBaseEffects = new Map();
  if (data.clothing_base_effects) {
    for (const [keyStr, eff] of Object.entries(data.clothing_base_effects)) {
      const key = (parseInt(keyStr, 10) >>> 0);
      clothingBaseEffects.set(key, eff);
    }
  }
  const clothingSubPalEffects = new Map();
  if (data.clothing_sub_pal_effects) {
    for (const [keyStr, eff] of Object.entries(data.clothing_sub_pal_effects)) {
      const key = (parseInt(keyStr, 10) >>> 0);
      clothingSubPalEffects.set(key, eff);
    }
  }
  return {
    id: data.id >>> 0,
    clothingBaseEffects,
    clothingSubPalEffects,
  };
}
