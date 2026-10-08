// scene3d/cloud_night.js — clouds lit by the SAME night-ramped sun the sky
// raymarches (?cloudNight, DEFAULT ON, `=off` escape). 2026-10-07.
//
// THE BUG (owner, 1070 playtest: "at night the clouds glow deep sunset
// orange-red while the sky is night-dark"; asked "should the clouds go dark at
// night?" → "yes clouds realistic at night").
//
// Dereth's DayGroup sun never sets: `dirPitch` bottoms out at 0.9 deg for the
// whole 23:02h → 03:50h block (night_ramp.js header). `?nightRamp` (2026-08-02)
// fixed that FOR THE SKY ONLY — `atmosphere_sky.js` `AtmosphereSky.tick` feeds
// `artSunPitchDeg(dirPitch)` (−14 deg at night) to the SkyMaterial. The takram
// clouds were left on the RAW pitch (`cloud_volume.js` tick passed
// `state.dirPitch` straight to `sunDirFromHeadingPitch`), so all night the cloud
// raymarch — which samples the SAME Bruneton LUTs as the sky — saw a sun 0.9 deg
// above the horizon: direct sun through ~a whole air-mass of atmosphere (deep
// orange-red transmittance), sunset-level sky irradiance, and a sunset-coloured
// aerial-perspective inscatter (`applyAerialPerspective` in clouds.frag). Live
// at the time: `skyLightingController._lastState.dirPitch` 0.9 vs
// `atmosphereSky._artPitchDeg` −14. Since 2026-10-07 the clouds also composite
// at full opacity (`?cloudsFullOpacity`), which made the glow unmissable.
//
// THE FIX. The clouds take the sky's art elevation from the same function on
// the same SkyState snapshot (loop.js ticks `atmosphereSky` and then `skyDome` →
// `cloudOverlay.tick` from one `skyLightingController._lastState`), so there is
// no seam: sunset, after-glow and night happen in the sky and in the clouds on
// the same frame. Everything at or above the ramp knee (20 deg) is unchanged.
//
// WHY POINTING THE SUN BELOW THE HORIZON REALLY DARKENS (not "lights from
// below"). takram's direct cloud light is
//   solar_irradiance * GetTransmittanceToSun(r, mu_s)
// and GetTransmittanceToSun multiplies by
//   smoothstep(-sinH*sunR, sinH*sunR, mu_s - cosH),   sinH = R/r, cosH = -sqrt(1-sinH^2)
// i.e. it is EXACTLY zero once the sun disc is below the geometric horizon of
// the sample point (vendor/takram/three-atmosphere-shaders-bruneton.js,
// GetTransmittanceToSun). At −14 deg that is zero for every cloud layer
// (750 m → 8 km: horizon dip 0.9 → 2.9 deg) and for every raymarch sample out to
// takram's 200 km maxRayDistance (local vertical tilts ≤ 1.8 deg). Ground bounce
// uses the same term. What remains is the irradiance LUT's SKY light at −14 deg
// (muSMin = cos 120 deg, so −14 deg is inside the table — no clamping) and the
// LUT's own twilight inscatter: the same numbers the sky draws. So night clouds
// come out as dim, cool, sky-lit silhouettes against the same night sky, and
// golden hour is preserved (the art sun crosses 0 deg at authored ~8.8 deg,
// ≈21:48h / 04:52h; clouds at altitude keep catching warm light a degree or two
// past that, which is the real after-glow). `sunHorizonVisibility()` below is a
// JS mirror of that smoothstep for the test and the live diag.
//
// SHADOWS + LIGHT SHAFTS. Both come from takram's beer-shadow map, which is
// built ALONG the sun direction. With the sun under the horizon the map looks
// up from below the ground: meaningless, so it must not reach anything.
//   - terrain cloud shadows (`_pushCloudShadowsToTerrain`): strength is scaled
//     by `directFactor`; at 0 the terrain block is switched off outright
//     (uCloudShadowEnabled 0 — exact "no shadow", and the sample is skipped);
//   - light shafts (takram SHADOW_LENGTH, on at high/ultra): the
//     `maxShadowLengthRayDistance` UNIFORM is scaled by `directFactor` — at 0
//     the shadow-length march exits on its first step (shadowLength = 0, and the
//     march is free). NOT `effect.lightShafts = false`: that flips the
//     SHADOW_LENGTH define → a compound-shader relink freeze at every dusk.
// `directFactor` = sin(elev) / sin(fadeDeg), clamped [0,1]: full above
// `?cloudShadowFadeDeg` (6 deg ≈ the star-fade band's "full day" edge,
// sin = 0.10), zero when the sun reaches the horizon.
//
// TUNABLES (all URL, read once per session through night_ramp.js's cached
// parse — zero per-frame allocation):
//   ?cloudNight=off            raw retail pitch for the clouds (pre-2026-10-07)
//   ?cloudShadowFadeDeg=<deg>  art elevation where shadows/shafts reach full
//   ?cloudNightSkyLight=<x>    takram skyLightScale multiplier at full night
//                              (1 = physical, same LUT as the sky). NOTE: the
//                              physical night sky light is ~0, so this cannot
//                              lift night clouds — use the floor knobs below.
//   ?cloudNightColor=RRGGBB    on-screen colour of night clouds (default
//                              171725, Dereth's authored night sky/fog tone)
//   ?cloudNightLevel=<x>       night floor radiance multiplier (0 = black)
// LIVE: window.__cloudNightState() — authored/sky/cloud pitch, seam, dirs,
// factors, the live uniforms and the terrain shadow uniforms.
//
// NIGHT FLOOR (2026-10-07, follow-up after the 1070 preview: "the clouds
// render as pure-black blotches at night"). The physical cloud light at the
// ramped −14 deg sun really is ~0: measured off the shipped LUTs
// (scene3d/assets/atmosphere/*.exr, Bruneton GetSkyRadiance/GetIrradiance
// ported to JS) the zenith sky is 1.9e-2 relative luminance at a 45 deg sun,
// 1.3e-5 at −6 deg and 2.8e-9 at −14 deg; the clouds' sky-light source tracks
// it (2–5× the zenith at every elevation). Through `toneMappingExposure` 5 +
// AgX (log2 window [−12.47, +4.03]) anything under ~1e-5 is display black —
// so the PHYSICAL night sky and the physical night clouds are both black (the
// 2026-08-03 fog-probe note in loop.js measured the night sky at (2,2,2)). The
// SkyMaterial has no stylised night colour to borrow: it is plain takram
// GetSkyRadiance + sun/moon discs; the night ramp only moves the sun.
// `?cloudNightSkyLight` multiplies that ~0, so it cannot help.
// Fix: an ART sky-light floor injected into the takram in-scatter term
// (`radiance += cloudNightAmbient * skyGradient`, next to the sky-light line —
// cloud_volume.js `_installNightAmbient`), so night clouds stay volumetric
// (bases darker than tops, thin edges blend into the sky) instead of a flat
// overlay. Its colour is Dereth's own authored night sky/fog tone, 0x171725
// (DayGroup fogColor in the night block — dim grey-blue), and its level is
// SOLVED through the live display transform (exposure × AgX × sRGB, ported
// below from three r184 tonemapping_pars_fragment, which postprocessing 6.39.1
// includes) so a cloud with skyGradient 0.75 lands ON that colour on screen,
// whatever the exposure. Weight: 0 while the sun is up (golden hour and day
// are bit-identical: the uniform is (0,0,0)), smoothstep in from the horizon
// to −6 deg (end of civil twilight, where the physical light has fallen 200×),
// 1 below. Knobs: ?cloudNightColor=RRGGBB, ?cloudNightLevel=<x>.

import {
  artSunPitchDeg,
  nightFactorFromArtPitch,
  nightNumFlag,
  nightRampEnabled,
} from "./night_ramp.js";

const DEG_TO_RAD = Math.PI / 180;

/** Art elevation (deg) at which cloud shadows + light shafts are at full. */
export const CLOUD_SHADOW_FADE_DEG_DEFAULT = 6.0;
/** takram `skyLightScale` multiplier at full night. 1 = physical. */
export const CLOUD_NIGHT_SKY_LIGHT_DEFAULT = 1.0;
/** Terrain `uCloudShadowStrength` when no `?cloudShadowStrength` override is
 *  set — mirrors the terrain.js uniform initialiser and the url-flags default. */
export const CLOUD_SHADOW_STRENGTH_DEFAULT = 2.0;
/** Lowest cloud base / highest cloud top in the shipped looks
 *  (cloud_storm_look.js: cumulus R 750 m … cirrus B 7500+500 m). */
export const CLOUD_BASE_ALTITUDE_M = 750;
export const CLOUD_TOP_ALTITUDE_M = 8000;

// takram AtmosphereParameters.DEFAULT (vendor/takram/three-atmosphere.js).
const BOTTOM_RADIUS_M = 6360000;
const SUN_ANGULAR_RADIUS = 0.004675;

let _enabledCache;
/**
 * `?cloudNight` — DEFAULT ON; `off|0|false` restore the raw retail pitch for
 * the clouds. Cached for the live URL; an explicit `search` parses fresh.
 */
export function cloudNightEnabled(search) {
  const live = typeof search !== "string";
  if (live && _enabledCache !== undefined) return _enabledCache;
  let on = true;
  try {
    let s = search;
    if (live) {
      s = (typeof window !== "undefined" && window.location) ? window.location.search : "";
    }
    const v = new URLSearchParams(s || "").get("cloudNight");
    if (v != null) {
      const t = String(v).toLowerCase();
      on = !(t === "off" || t === "0" || t === "false");
    }
  } catch (_) {
    on = true;
  }
  if (live) _enabledCache = on;
  return on;
}

/** `?cloudShadowFadeDeg=<deg>` clamp [0.5, 45]. */
export function cloudShadowFadeDeg(search) {
  return nightNumFlag("cloudShadowFadeDeg", CLOUD_SHADOW_FADE_DEG_DEFAULT, 0.5, 45, search);
}

/** `?cloudNightSkyLight=<x>` clamp [0, 20]. */
export function cloudNightSkyLight(search) {
  return nightNumFlag("cloudNightSkyLight", CLOUD_NIGHT_SKY_LIGHT_DEFAULT, 0, 20, search);
}

/** Night floor colour: Dereth's authored night sky/fog tone (DayGroup fogColor
 *  for the 23:02h → 03:50h block; cited in loop.js's horizon-probe note). */
export const CLOUD_NIGHT_COLOR_DEFAULT = 0x171725;
/** Art elevations bracketing the floor's fade-in: 0 at/above the horizon, 1 at
 *  and below the end of civil twilight. */
export const CLOUD_NIGHT_AMBIENT_START_DEG = 0;
export const CLOUD_NIGHT_AMBIENT_FULL_DEG = -6;
/** takram skyGradient (0.5 at a layer base … 1 at its top) the floor is
 *  calibrated at: a cloud there displays exactly the night colour. */
export const CLOUD_NIGHT_GRADIENT_REF = 0.75;
/** `renderer.toneMappingExposure` until the overlay reports the live one. */
export const DISPLAY_EXPOSURE_DEFAULT = 5;

/** `?cloudNightColor=RRGGBB` (also `#RRGGBB` / `0xRRGGBB`), else 0x171725. */
export function cloudNightColor(search) {
  try {
    let s = search;
    if (typeof s !== "string") {
      s = (typeof window !== "undefined" && window.location) ? window.location.search : "";
    }
    const raw = new URLSearchParams(s || "").get("cloudNightColor");
    if (raw != null) {
      const hex = String(raw).trim().replace(/^(#|0x)/i, "");
      if (/^[0-9a-f]{6}$/i.test(hex)) return parseInt(hex, 16);
    }
  } catch (_) { /* default */ }
  return CLOUD_NIGHT_COLOR_DEFAULT;
}

/** `?cloudNightLevel=<x>` clamp [0, 8] — multiplies the floor RADIANCE (1 = the
 *  night colour on screen; 0 = the pure physical night, i.e. black). */
export function cloudNightLevel(search) {
  return nightNumFlag("cloudNightLevel", 1, 0, 8, search);
}

/** Floor weight from the art elevation: 0 above the horizon, smoothstep to 1
 *  at −6 deg. Golden hour/day ⇒ exactly 0. */
export function cloudNightAmbientWeight(pitchDeg) {
  const e = Number.isFinite(pitchDeg) ? pitchDeg : 0;
  const a = Math.sin(CLOUD_NIGHT_AMBIENT_START_DEG * DEG_TO_RAD);
  const b = Math.sin(CLOUD_NIGHT_AMBIENT_FULL_DEG * DEG_TO_RAD);
  const t = Math.min(1, Math.max(0, (Math.sin(e * DEG_TO_RAD) - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// --- display transform (three r184 AgXToneMapping + sRGB OETF) -------------
// GLSL mat3(c0, c1, c2) is column-major: M * v = c0*v.x + c1*v.y + c2*v.z.
const _M_SRGB_TO_2020 = [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]];
const _M_2020_TO_SRGB = [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]];
const _M_AGX_INSET = [
  [0.856627153315983, 0.137318972929847, 0.11189821299995],
  [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
  [0.0482516061458583, 0.101439036467562, 0.811302368396859],
];
const _M_AGX_OUTSET = [
  [1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
  [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
  [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405],
];
const _AGX_MIN_EV = -12.47393;
const _AGX_MAX_EV = 4.026069;
function _mul(m, v, out) {
  const x = v[0], y = v[1], z = v[2];
  out[0] = m[0][0] * x + m[1][0] * y + m[2][0] * z;
  out[1] = m[0][1] * x + m[1][1] * y + m[2][1] * z;
  out[2] = m[0][2] * x + m[1][2] * y + m[2][2] * z;
  return out;
}
function _agxCurve(x) {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
/** sRGB-encoded 0..1 → linear. */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** Linear 0..1 → sRGB-encoded. */
export function linearToSrgb(c) {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
/**
 * Scene radiance (linear sRGB, pre-exposure) → what the screen shows (sRGB
 * encoded 0..1): `x * exposure` → AgX (three r184) → sRGB OETF.
 */
export function agxDisplay(rgb, exposure = DISPLAY_EXPOSURE_DEFAULT, out = [0, 0, 0]) {
  const v = [rgb[0] * exposure, rgb[1] * exposure, rgb[2] * exposure];
  _mul(_M_SRGB_TO_2020, v, v);
  _mul(_M_AGX_INSET, v, v);
  for (let i = 0; i < 3; i += 1) {
    const l = (Math.log2(Math.max(v[i], 1e-10)) - _AGX_MIN_EV) / (_AGX_MAX_EV - _AGX_MIN_EV);
    v[i] = _agxCurve(Math.min(1, Math.max(0, l)));
  }
  _mul(_M_AGX_OUTSET, v, v);
  for (let i = 0; i < 3; i += 1) v[i] = Math.pow(Math.max(0, v[i]), 2.2);
  _mul(_M_2020_TO_SRGB, v, v);
  for (let i = 0; i < 3; i += 1) out[i] = linearToSrgb(v[i]);
  return out;
}
/**
 * Inverse of `agxDisplay`: the scene radiance that displays as `target`
 * (sRGB-encoded 0..1 triple). Damped per-channel log-space iteration on the
 * full forward transform (AgX's matrices mix channels mildly); converges to
 * < 0.5/255 for any in-gamut colour away from pure black/white.
 */
export function sceneRadianceForDisplay(target, exposure = DISPLAY_EXPOSURE_DEFAULT, out = [0, 0, 0]) {
  const want = [0, 1, 2].map((i) => Math.max(srgbToLinear(Math.min(1, Math.max(0, target[i]))), 1e-6));
  const x = [0.02 / exposure, 0.02 / exposure, 0.02 / exposure];
  const got = [0, 0, 0];
  for (let it = 0; it < 200; it += 1) {
    agxDisplay(x, exposure, got);
    let err = 0;
    for (let i = 0; i < 3; i += 1) {
      const g = Math.max(srgbToLinear(got[i]), 1e-7);
      const d = Math.log2(want[i] / g);
      err = Math.max(err, Math.abs(d));
      x[i] = Math.min(1e3, Math.max(1e-12, x[i] * Math.pow(2, 0.7 * d)));
    }
    if (err < 1e-4) break;
  }
  out[0] = x[0]; out[1] = x[1]; out[2] = x[2];
  return out;
}

/**
 * Floor radiance at weight 1 for a colour/level/exposure: the in-scatter
 * source that makes a cloud at skyGradient CLOUD_NIGHT_GRADIENT_REF display
 * `colorRgb` (×level in radiance). Pure; cloud_volume.js caches it.
 */
export function cloudNightAmbientRadiance(colorRgb, level, exposure, out = [0, 0, 0]) {
  const c = [((colorRgb >>> 16) & 0xff) / 255, ((colorRgb >>> 8) & 0xff) / 255, (colorRgb & 0xff) / 255];
  sceneRadianceForDisplay(c, exposure > 0 ? exposure : DISPLAY_EXPOSURE_DEFAULT, out);
  const k = (Number.isFinite(level) ? level : 1) / CLOUD_NIGHT_GRADIENT_REF;
  out[0] *= k; out[1] *= k; out[2] *= k;
  return out;
}

/**
 * The elevation the cloud raymarch is lit with: the sky's art elevation
 * (identity above the ramp knee, and everywhere when `?nightRamp=off`), or the
 * raw authored pitch when `?cloudNight=off`.
 *
 * @param {number} authoredPitchDeg DayGroup `dirPitch`
 * @param {boolean} [enabled] force on/off (tests); default `cloudNightEnabled()`
 */
export function cloudSunPitchDeg(authoredPitchDeg, enabled) {
  const p = Number.isFinite(authoredPitchDeg) ? authoredPitchDeg : 0;
  const on = enabled == null ? cloudNightEnabled() : !!enabled;
  return on ? artSunPitchDeg(p) : p;
}

/**
 * Direct-sun weight for the beer-shadow consumers (terrain cloud shadows,
 * light shafts): 1 at/above `fadeDeg`, linear in sin(elevation) down to 0 at
 * the horizon, 0 below it.
 */
export function cloudDirectFactor(pitchDeg, fadeDeg = CLOUD_SHADOW_FADE_DEG_DEFAULT) {
  const e = Number.isFinite(pitchDeg) ? pitchDeg : 0;
  const f = Math.max(0.5, Number.isFinite(fadeDeg) ? fadeDeg : CLOUD_SHADOW_FADE_DEG_DEFAULT);
  const t = Math.sin(e * DEG_TO_RAD) / Math.sin(f * DEG_TO_RAD);
  return Math.min(1, Math.max(0, t));
}

/**
 * JS mirror of the horizon term of Bruneton `GetTransmittanceToSun` (the factor
 * takram's direct cloud/ground light is multiplied by): fraction of the sun
 * disc above the geometric horizon of a point `altitudeM` above the ground,
 * for a sun at `pitchDeg` elevation. 0 ⇒ zero direct light, whatever the LUTs.
 */
export function sunHorizonVisibility(pitchDeg, altitudeM) {
  const r = BOTTOM_RADIUS_M + Math.max(0, Number.isFinite(altitudeM) ? altitudeM : 0);
  const sinH = BOTTOM_RADIUS_M / r;
  const cosH = -Math.sqrt(Math.max(1 - sinH * sinH, 0));
  const muS = Math.sin((Number.isFinite(pitchDeg) ? pitchDeg : 0) * DEG_TO_RAD);
  const e = sinH * SUN_ANGULAR_RADIUS;
  const x = Math.min(1, Math.max(0, (muS - cosH + e) / (2 * e)));
  return x * x * (3 - 2 * x);
}

/**
 * Per-frame mapping SkyState → cloud lighting, written into `out` (no
 * allocation). With the flag off it reports the legacy identity (raw pitch,
 * factors 1/0/1, floor weight 0) and `enabled: false`, and cloud_volume.js leaves every
 * uniform it would otherwise scale untouched.
 *
 * @param {{dirPitch:number}|null} state
 * @param {object} [out]
 * @param {boolean} [enabled] force on/off (tests); default `cloudNightEnabled()`
 * @param {string} [search] explicit query string for the tunables (tests);
 *   default = the live URL through the cached parse
 */
export function cloudNightLighting(state, out = {}, enabled, search) {
  const on = enabled == null ? cloudNightEnabled(search) : !!enabled;
  const authored = +(state && state.dirPitch);
  const a = Number.isFinite(authored) ? authored : 0;
  out.enabled = on;
  out.authoredPitchDeg = a;
  out.pitchDeg = cloudSunPitchDeg(a, on);
  if (on) {
    out.directFactor = cloudDirectFactor(out.pitchDeg, cloudShadowFadeDeg(search));
    out.nightFactor = nightFactorFromArtPitch(out.pitchDeg);
    out.skyLightMul = 1 + (cloudNightSkyLight(search) - 1) * out.nightFactor;
    out.ambientWeight = cloudNightAmbientWeight(out.pitchDeg);
  } else {
    out.directFactor = 1;
    out.nightFactor = 0;
    out.skyLightMul = 1;
    out.ambientWeight = 0;
  }
  return out;
}

/**
 * Install `window.__cloudNightState()` — the live read for the orchestrator /
 * 1070 session. `seamDeg` MUST be 0 (clouds and sky lit by the same elevation);
 * `sunVisibleCloudBase/Top` MUST be 0 at night (no direct sun on any layer).
 */
export function installCloudNightDiag(scene3dGetter) {
  if (typeof window === "undefined") return;
  const getter = scene3dGetter ?? (() => window.liveScene3d);
  const v3 = (v) => (v && Number.isFinite(v.x)
    ? [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)]
    : null);
  window.__cloudNightState = () => {
    try {
      const s = typeof getter === "function" ? getter() : getter;
      const st = s?.skyLightingController?._lastState ?? null;
      const vol = s?.cloudOverlay?.volume ?? null;
      const eff = vol?.effect ?? null;
      const u = eff?.cloudsPass?.currentMaterial?.uniforms ?? null;
      const cn = vol?._cloudNight ?? null;
      const sky = s?.atmosphereSky ?? window.__atmosphereSky ?? null;
      const tm = s?.terrainMaterials?.[0]?.uniforms ?? null;
      const cloudPitch = cn ? cn.pitchDeg : null;
      const skyPitch = Number.isFinite(sky?._artPitchDeg) ? sky._artPitchDeg : null;
      return {
        enabled: cloudNightEnabled(),
        nightRamp: nightRampEnabled(),
        authoredPitchDeg: st ? st.dirPitch : null,
        skyArtPitchDeg: skyPitch,
        cloudPitchDeg: cloudPitch,
        seamDeg: (cloudPitch != null && skyPitch != null) ? Math.abs(cloudPitch - skyPitch) : null,
        cloudSunDir: v3(eff?.sunDirection),
        skyMaterialSunDir: v3(sky?.skyMaterial?.sunDirection),
        sunLightDir: v3(s?.atmosphereLights?.sun?.sunDirection),
        directFactor: cn ? cn.directFactor : null,
        nightFactor: cn ? cn.nightFactor : null,
        skyLightMul: cn ? cn.skyLightMul : null,
        sunVisibleCloudBase: cloudPitch != null ? sunHorizonVisibility(cloudPitch, CLOUD_BASE_ALTITUDE_M) : null,
        sunVisibleCloudTop: cloudPitch != null ? sunHorizonVisibility(cloudPitch, CLOUD_TOP_ALTITUDE_M) : null,
        skyLightScale: u?.skyLightScale?.value ?? null,
        maxShadowLengthRayDistance: u?.maxShadowLengthRayDistance?.value ?? null,
        lightShafts: eff ? !!eff.lightShafts : null,
        terrainCloudShadow: tm
          ? { enabled: tm.uCloudShadowEnabled?.value ?? null, strength: tm.uCloudShadowStrength?.value ?? null }
          : null,
        // Night floor: the uniform the shader adds, its weight, and what a
        // cloud at the calibration gradient DISPLAYS (sRGB 0-255) through the
        // live exposure + AgX — must be the night colour (0x171725 → 23,23,37)
        // at full night and [0,0,0] by day.
        nightAmbientPatched: vol ? !!vol._nightAmbientPatched : null,
        ambientWeight: cn ? cn.ambientWeight : null,
        nightAmbient: v3(u?.cloudNightAmbient?.value),
        nightColor: vol ? "#" + (vol._nightColor >>> 0).toString(16).padStart(6, "0") : null,
        displayExposure: vol ? vol._displayExposure : null,
        nightCloudDisplay: u?.cloudNightAmbient?.value
          ? agxDisplay(
            [0, 1, 2].map((i) => u.cloudNightAmbient.value.getComponent(i) * CLOUD_NIGHT_GRADIENT_REF),
            vol._displayExposure,
          ).map((c) => Math.round(c * 255))
          : null,
        tunables: {
          fadeDeg: cloudShadowFadeDeg(),
          nightSkyLight: cloudNightSkyLight(),
          nightLevel: cloudNightLevel(),
        },
      };
    } catch (e) {
      return { error: String(e) };
    }
  };
}

// Self-install (same pattern as night_ramp.js): cloud_volume.js imports this
// module, so the diag exists whenever the clouds do. All reads are lazy.
installCloudNightDiag();
