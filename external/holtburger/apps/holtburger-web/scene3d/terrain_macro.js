// terrain_macro.js — FAR-TERRAIN macro modulation array (?terrainMacro, DEFAULT ON).
//
// THE PROBLEM (user, 2026-08-02): "distant terrain has an obvious painted look
// like it was done in mspaint".
//
// THE MECHANISM. AC ground textures are small tiles stretched over 24 m cells.
// The client already fights this near the camera — `uTerrainDetailTex` adds
// sub-metre grain — but that layer is deliberately faded out by
// `uDetailTexFadeEnd` (50 m), and beyond it every mip level above ~3 has
// averaged the tile into a flat colour patch. Past ~60 m the ground is
// therefore literally N flat colour fields separated by the retail TexMerge
// alpha masks, whose hand-authored edges trace the 24 m cell grid. That is the
// paint look, and no amount of lighting work touches it.
//
// THE FIX. Per TERRAIN FAMILY (grass / sand / rock / snowice / swamp / volcano
// / dirt — `terrain_families.js`, code-keyed, never name-keyed) we bake one
// 1024² tileable MODULATION map offline from the SAME ground textures the
// atlas renders with (`assets/terrain_macro/generate.py`), and the terrain
// shader multiplies it into the albedo with a distance ramp.
//
// WHY A MODULATION AND NOT A REPLACEMENT ALBEDO. WorldBuilder stays the source
// of truth. The map is MODULATE2X-encoded with every channel's mean pinned to
// exactly 0.5, so a distant grass field keeps its authored average colour to
// the byte; only its STRUCTURE changes. Two different terrain codes that share
// a family keep their distinct colours — which a "blend toward one family
// albedo" scheme would have destroyed (that would be MORE mspaint, not less).
//
// Provenance: the maps are synthesised from `assets/pbr_terrain/L<NN>_color_1k
// .png`, i.e. exactly the pixels on screen when `?pbrTerrain` is on (the
// default), so the palette is Dereth's by construction.
//
// Fail-soft in every direction: flag off, fetch failure, decode failure or no
// `DataArrayTexture` all resolve to `null`, `uMacroEnabled` stays 0 and the
// fragment shader branches around the samples — byte-identical to the
// pre-feature render.

import * as THREE from "three";
import { getAdapterMaxAnisotropy } from "./adapter.js";
import {
  FAM_GRASS,
  FAM_SAND,
  FAM_ROCK,
  FAM_SNOWICE,
  FAM_SWAMP,
  FAM_VOLCANO,
  FAM_DIRT,
  familyForCode,
} from "./terrain_families.js";

/** Slice order in the DataArrayTexture. MUST match FAMILY_ORDER in generate.py. */
export const TERRAIN_MACRO_KEYS = Object.freeze([
  "grass", "sand", "rock", "snowice", "swamp", "volcano", "dirt",
]);

/** family constant -> array slice. Families without a macro map (water, none) -> 255. */
const FAMILY_TO_SLICE = new Map([
  [FAM_GRASS, 0],
  [FAM_SAND, 1],
  [FAM_ROCK, 2],
  [FAM_SNOWICE, 3],
  [FAM_SWAMP, 4],
  [FAM_VOLCANO, 5],
  [FAM_DIRT, 6],
]);

/** No macro slice — the shader treats >= uMacroSliceCount as "skip". */
export const MACRO_SLICE_NONE = 255;

// ---------------------------------------------------------------- defaults --
//
// Every number below was picked on the 1070 against the Holtburg long-sightline
// vantage; see docs/visual-quality-pass2 (`?terrainMacro*` A/B grid).

/** Metres of view depth where the macro starts fading IN. Sits just past
 *  `uDetailTexFadeEnd` (50 m) so the two layers hand over rather than stack. */
export const MACRO_FADE_START_DEFAULT = 55.0;
/** Metres where the macro reaches full strength. */
export const MACRO_FADE_END_DEFAULT = 260.0;
/** Peak blend weight of the macro modulation (0 = off, 1 = raw MODULATE2X).
 *  1070-swept 2026-08-02 at 0.62 / 1.00 / 1.40 on the Holtburg far shore
 *  (`CROP-MAC-1to1.png`): 0.62 was real but barely readable at 350-450 m, 1.40
 *  started reading as noise on the near edge of the fade band. 1.00 breaks the
 *  flat colour field without announcing itself. */
export const MACRO_STRENGTH_DEFAULT = 1.0;
/** World metres per macro tile, primary tap. */
export const MACRO_SCALE_A_DEFAULT = 118.0;
/** World metres per macro tile, secondary tap (rotated). Deliberately NOT a
 *  harmonic of A, so the two taps' repeats never coincide. */
export const MACRO_SCALE_B_DEFAULT = 37.0;
/** Amplitude of the extra procedural macro-noise octaves layered on top of the
 *  baked map (free — reuses the shader's existing fragValueNoise2D). */
export const MACRO_NOISE_AMP_DEFAULT = 0.14;

// -------------------------------------------------------------------- flag --

function _search(search) {
  if (typeof search === "string") return search;
  try {
    if (typeof window !== "undefined" && window.location) return window.location.search;
  } catch (_) { /* fall through */ }
  return "";
}

/**
 * `?terrainMacro` — DEFAULT ON. Only the literal escapes turn it off, matching
 * the house style for validated default-on gates.
 */
export function terrainMacroEnabled(search) {
  try {
    const v = new URLSearchParams(_search(search)).get("terrainMacro");
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

/** Numeric override helper: `?<name>=<float>`, clamped, else `dflt`. */
export function macroNumFlag(name, dflt, lo, hi, search) {
  try {
    const raw = new URLSearchParams(_search(search)).get(name);
    if (raw == null || raw === "") return dflt;
    const v = Number(raw);
    if (!Number.isFinite(v)) return dflt;
    return Math.min(hi, Math.max(lo, v));
  } catch (_) {
    return dflt;
  }
}

/**
 * Build the terrain-code -> macro-slice LUT (length 33; index 32 = the road
 * layer, which gets no macro because a road is a 5 m lane, not a field).
 * Water codes resolve to FAM_WATER, which is not in FAMILY_TO_SLICE, so they
 * fall through to MACRO_SLICE_NONE — the water agent owns that surface.
 */
export function buildMacroSliceLut() {
  const lut = new Array(33).fill(MACRO_SLICE_NONE);
  for (let code = 0; code < 32; code += 1) {
    const slice = FAMILY_TO_SLICE.get(familyForCode(code));
    if (slice != null) lut[code] = slice;
  }
  return lut;
}

// ------------------------------------------------------------------ loader --

function _macroUrl(key, baseUrl) {
  const base = baseUrl ?? "scene3d/assets/terrain_macro";
  return `${base}/macro_${key}.png`;
}

async function _decodePngRgba(url) {
  if (typeof Image === "undefined" || typeof document === "undefined") return null;
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => resolve(i);
    i.onerror = (e) => reject(e);
    i.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, rgba: data.data };
}

/**
 * Load the 7 macro maps into one `THREE.DataArrayTexture`.
 *
 * Memory: 1024 × 1024 × 7 × 4 B ≈ 29 MB GPU. That is the same order as the
 * detail-normal array (20 MB) already resident at mid+, and it buys the single
 * biggest far-terrain look change available without touching world data.
 *
 * @returns {Promise<{texture: THREE.DataArrayTexture, keys: string[],
 *                    sliceLut: number[], sliceCount: number} | null>}
 */
export async function loadTerrainMacroArray(opts = {}) {
  const { baseUrl, THREE: ThreeOverride } = opts;
  const T = ThreeOverride ?? THREE;
  if (typeof T.DataArrayTexture !== "function") return null;

  const decoded = await Promise.all(
    TERRAIN_MACRO_KEYS.map((key) =>
      _decodePngRgba(_macroUrl(key, baseUrl)).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn(`[terrain-macro] ${key} decode failed:`, e);
        return null;
      })
    )
  );
  if (decoded.some((d) => !d)) return null;

  const w = decoded[0].width;
  const h = decoded[0].height;
  if (decoded.some((d) => d.width !== w || d.height !== h)) {
    // eslint-disable-next-line no-console
    console.warn("[terrain-macro] macro maps mismatched dimensions");
    return null;
  }

  const layerStride = w * h * 4;
  const data = new Uint8Array(layerStride * decoded.length);
  for (let i = 0; i < decoded.length; i += 1) data.set(decoded[i].rgba, i * layerStride);

  const tex = new T.DataArrayTexture(data, w, h, decoded.length);
  tex.format = T.RGBAFormat;
  tex.type = T.UnsignedByteType;
  // NoColorSpace, NOT sRGB: this is a multiplier, and 0.5 must mean exactly
  // 1.0×. An sRGB decode would move the neutral point to ~0.21 and every
  // distant surface would darken by ~2.4× the instant the flag went on.
  tex.colorSpace = T.NoColorSpace;
  tex.wrapS = T.RepeatWrapping;
  tex.wrapT = T.RepeatWrapping;
  tex.magFilter = T.LinearFilter;
  tex.minFilter = T.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = getAdapterMaxAnisotropy();
  tex.name = "scene3d-terrain-macro-array";
  tex.needsUpdate = true;

  return {
    texture: tex,
    keys: [...TERRAIN_MACRO_KEYS],
    sliceLut: buildMacroSliceLut(),
    sliceCount: decoded.length,
  };
}
