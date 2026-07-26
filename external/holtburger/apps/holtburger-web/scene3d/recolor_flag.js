// `?recolor=off` — the entity subpalette-recolor escape hatch (2026-07-26).
//
// WHAT IT GATES
// -------------
// Every entity surface fetch in entities.js carries a `(paletteId,
// subPalettes)` pair lifted straight off the spawn/appearance meta. Non-empty,
// that pair sends the surface through wasm's COMPOSED decode
// (`fetchEntitySurfacesPixels`) — the ObjDesc subpalette overlay that paints
// loot colour variants, skin/hair tones and player-dyed gear — and the result
// is a per-WEARER texture, not a per-DID one.
//
// With `?recolor=off` the pair is forced to `(0, [])` at the four sites that
// assemble it, so `hasPaletteSubs` is false and EVERY entity takes the plain,
// shared `MaterialCache` path: the palette-free base ClothingTable class.
//
// This is a CONSEQUENCE EXPERIMENT, not an optimisation: it exists so the
// visual value of the recolor path (judged live, by eye) can be weighed
// against its measured cost (`__diag.entityOwned()` → `entMB` /
// `jsHeapPeak`). It is also the escape hatch owed to the "dyed"-terminology
// audit — the spawn path is named `dyed*` throughout entities.js, but dye is
// only ONE producer of subpalette overlays; the flag is named for the general
// mechanism (recolor), not the mislabel.
//
// GRAMMAR (⚠ read docs/url-flags.md's 2026-07-23 reader-idiom box)
// ----------------------------------------------------------------
// This flag is an intentional **opt-OUT**: absent ⇒ ON ⇒ today's behaviour,
// bit-for-bit. ONLY the literal value `off` (case-insensitive, whitespace
// trimmed) disables. Garbage (`?recolor=banana`, `?recolor=0`, `?recolor=`)
// reads ON — deliberately: a typo must never silently strip every character's
// colours mid-stream. Because absent ⇒ ON, this flag does NOT belong on the
// "frozen render until set" default-OFF opt-in list.

/**
 * Grammar core. `true` = recolor ON (default). Only the literal `"off"`
 * (case-insensitive, trimmed) is OFF; every other value — including `null`
 * / `undefined` (absent) — is ON.
 */
export function parseRecolorFlag(value) {
  if (typeof value !== "string") return true;
  return value.trim().toLowerCase() !== "off";
}

/**
 * Resolve from a query string (`"?a=1&recolor=off"` or `"a=1&recolor=off"`).
 * Fail-soft: an unparseable string reads ON.
 */
export function resolveRecolorEnabled(search) {
  try {
    return parseRecolorFlag(new URLSearchParams(search || "").get("recolor"));
  } catch (_) {
    return true;
  }
}

/** Read the live page URL. Node / no-`window` ⇒ ON (the default). */
export function readRecolorFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return resolveRecolorEnabled(window.location.search);
  } catch (_) {
    return true;
  }
}

/** Module-scope const — read ONCE at load, like every other entity flag. */
export const RECOLOR_ON = readRecolorFlag();

/** Shared empty triple list. Never mutated; wasm reads it as a zero-length view. */
export const EMPTY_SUB_PALETTES = new Uint32Array(0);

/**
 * THE CHOKE POINT (subpalette half). Returns the caller's overlay list
 * unchanged when recolor is on, and the shared EMPTY list when off.
 *
 * @param {Uint32Array|number[]|null|undefined} subPalettes flat (offset,
 *   length, slot) triples straight off the spawn/appearance meta
 * @param {boolean} [enabled] injectable for tests; defaults to the URL flag
 */
export function gateSubPalettes(subPalettes, enabled = RECOLOR_ON) {
  if (!enabled) return EMPTY_SUB_PALETTES;
  return subPalettes ?? EMPTY_SUB_PALETTES;
}

/**
 * THE CHOKE POINT (base-palette half). The base palette override is the other
 * half of `hasPaletteSubs`; leaving it armed would keep the composed decode
 * (and its per-wearer texture) alive with an empty overlay list, which is
 * neither arm of the experiment.
 *
 * @param {number|null|undefined} paletteId
 * @param {boolean} [enabled] injectable for tests; defaults to the URL flag
 */
export function gatePaletteId(paletteId, enabled = RECOLOR_ON) {
  if (!enabled) return 0;
  return (paletteId ?? 0) >>> 0;
}

// Boot readback — one line, only when the escape is armed (matches the
// other entity flags' style; silent in the default arm and under node).
try {
  if (!RECOLOR_ON && typeof window !== "undefined" && typeof console !== "undefined") {
    // eslint-disable-next-line no-console
    console.log(
      "[recolor] ?recolor=off — entity subpalette recolor DISABLED: all gear/" +
        "creatures render the base ClothingTable palette (no composed decode, " +
        "no per-wearer owned textures). Observe cost via __diag.entityOwned()."
    );
  }
} catch (_) { /* never throw from a boot readback */ }
