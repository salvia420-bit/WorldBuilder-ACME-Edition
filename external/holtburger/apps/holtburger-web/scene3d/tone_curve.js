// scene3d/tone_curve.js — which display transform the composer tone-maps with.
//
// `?tone=neutral|agx|aces` (2026-10-07, DEFAULT `neutral`; owner's pick on the
// GTX 1070 from a live AgX / Neutral / ACES compare at Holtburg).
//
// AgX (the previous default) is built to keep HDR highlights hue-stable, and it
// pays for that with a desaturated, lifted mid-range: AC's hand-painted albedo
// came out as a pale grey sky and yellow-grey grass. Khronos PBR Neutral is
// near-identity below ~0.76 and only compresses the highlights, so the texture
// colours the artists painted reach the screen. `?tone=agx` restores the old
// look exactly; `?tone=aces` is the filmic option.
//
// Anything that inverts the display transform to hit a target ON SCREEN (the
// night-cloud floor in cloud_night.js) must invert the curve that is actually
// live — `neutralToneMap` / `acesToneMap` below are JS mirrors of three r184's
// shaders, and cloud_night.js `displayForward` dispatches on `toneCurveName()`.
// (No imports: cloud_night.js imports this module, so this one stays a leaf.)

export const TONE_CURVES = Object.freeze(["neutral", "agx", "aces"]);
export const TONE_CURVE_DEFAULT = "neutral";

/** The live curve name. Unknown / absent → the default. */
export function toneCurveName(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("tone");
    if (v == null) return TONE_CURVE_DEFAULT;
    const lv = String(v).toLowerCase();
    return TONE_CURVES.includes(lv) ? lv : TONE_CURVE_DEFAULT;
  } catch (_) {
    return TONE_CURVE_DEFAULT;
  }
}

/** pmndrs ToneMappingMode value for a curve name (enum passed in, no import). */
export function toneMappingModeFor(name, ToneMappingMode) {
  if (name === "agx") return ToneMappingMode.AGX;
  if (name === "aces") return ToneMappingMode.ACES_FILMIC;
  return ToneMappingMode.NEUTRAL;
}

/** three r184 NeutralToneMapping (tonemapping_pars_fragment), in place, post-exposure. */
export function neutralToneMap(v) {
  const START = 0.8 - 0.04;
  const DESAT = 0.15;
  const x = Math.min(v[0], v[1], v[2]);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  v[0] -= offset; v[1] -= offset; v[2] -= offset;
  const peak = Math.max(v[0], v[1], v[2]);
  if (peak < START) return v;
  const d = 1 - START;
  const newPeak = 1 - (d * d) / (peak + d - START);
  const k = newPeak / peak;
  v[0] *= k; v[1] *= k; v[2] *= k;
  const g = 1 - 1 / (DESAT * (peak - newPeak) + 1);
  for (let i = 0; i < 3; i += 1) v[i] = v[i] + (newPeak - v[i]) * g;
  return v;
}

// three r184 ACESFilmicToneMapping (Stephen Hill fit), per pixel.
const _ACES_IN = [[0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]];
const _ACES_OUT = [[1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]];
function _mul(m, v) {
  const x = v[0], y = v[1], z = v[2];
  v[0] = m[0][0] * x + m[1][0] * y + m[2][0] * z;
  v[1] = m[0][1] * x + m[1][1] * y + m[2][1] * z;
  v[2] = m[0][2] * x + m[1][2] * y + m[2][2] * z;
  return v;
}
/** three r184 ACESFilmicToneMapping, in place, post-exposure (linear out, clamped). */
export function acesToneMap(v) {
  for (let i = 0; i < 3; i += 1) v[i] /= 0.6;
  _mul(_ACES_IN, v);
  for (let i = 0; i < 3; i += 1) {
    const c = v[i];
    v[i] = (c * (c + 0.0245786) - 0.000090537) / (c * (0.983729 * c + 0.4329510) + 0.238081);
  }
  _mul(_ACES_OUT, v);
  for (let i = 0; i < 3; i += 1) v[i] = Math.min(1, Math.max(0, v[i]));
  return v;
}
