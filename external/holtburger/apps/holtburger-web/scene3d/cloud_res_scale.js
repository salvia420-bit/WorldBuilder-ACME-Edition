// scene3d/cloud_res_scale.js — `?cloudResScale=N` (2026-10-19, opt-in knob;
// absent = takram's own default, 1). The volumetric clouds' render resolution.
//
// WHY A KNOB. The clouds are the largest GPU item at the 1070's default
// (`ultra`, clouds on at high/ultra since 2026-10-17): the 2026-10-17 GPU census
// put CloudsEffect + AerialPerspective at 9-10 ms with cloudQuality ultra and
// ~4.3-4.6 ms with the `high` raymarch settings — over half of a 120 Hz frame by
// itself. takram's README ("Performance tweaks"): `resolutionScale` 0.5 "reduces
// the total number of texels to compute by 1/4" (the temporal upscale already
// marches 1/16 of the texels each frame, `ceil(w/4) x ceil(h/4)` of the SCALED
// size, build/index.js CloudsPass.setSize), and the resolve pass shrinks with it.
// The cloud shadow cascades are a separate cost (`?cloudShadowRes`).
//
// Range (0.25, 1]; values outside clamp, junk is ignored. Applied after
// `?cloudQuality` — takram's `qualityPreset` setter assigns `resolutionScale: 1`
// back (qualityPresets.ts values), so the scale has to land after any preset.

export const CLOUD_RES_SCALE_MIN = 0.25;
export const CLOUD_RES_SCALE_MAX = 1;

/** `?cloudResScale=N` → a scale in [0.25, 1], or null when absent / not a number. */
export function parseCloudResScale(search) {
  try {
    const raw = new URLSearchParams(search ?? "").get("cloudResScale");
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(CLOUD_RES_SCALE_MAX, Math.max(CLOUD_RES_SCALE_MIN, n));
  } catch (_) {
    return null;
  }
}

/** Set takram's resolution scale (it resizes its targets on change). Returns the
 *  applied scale, or null if the effect has no such property or `n` is junk. */
export function applyCloudResScale(effect, n) {
  const v = Number(n);
  if (!effect || !("resolutionScale" in effect) || !Number.isFinite(v) || v <= 0) return null;
  const s = Math.min(CLOUD_RES_SCALE_MAX, Math.max(CLOUD_RES_SCALE_MIN, v));
  if (effect.resolutionScale !== s) effect.resolutionScale = s;
  return s;
}
