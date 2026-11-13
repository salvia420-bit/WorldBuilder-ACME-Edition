// scene3d/cloud_storm_look.js — the ONE writer of the takram cloud-layer
// config (2026-08-01, replaces the 2026-05 WMO/étage/LCL machinery).
//
// The old `_applyWeatherToCloudLayers` derived layer altitudes from a
// synthetic meteorology model (Espy LCL, WMO étage bands, DayGroup T/Td
// profiles). In practice it fought the hand-tuned baseline that
// cloud_overlay.js set at construct time — `?cloudWeather=off` (freeze the
// baseline) looked right, `?cloudWeather=on` (let WMO clobber it) broke the
// sky. The meteorology is gone; what remains is two hand-tuned looks:
//
//   fair  — takram's CloudLayers.DEFAULT cumulus/cirrus plus the alto deck
//           on channel A (the middle étage takram leaves empty), coverage
//           0.5. This IS the config the sky shipped with under
//           `?cloudWeather=off`, now shared with cloud_overlay.js instead
//           of duplicated there.
//   storm — cumulus deck dropped to ~600 m, channel A swapped to a
//           cumulonimbus tower (base 600 m, ~9 km top), coverage 0.7.
//           Cb density sits at the 0.05 soft-alpha ceiling (probe
//           2026-05-16: "densityScale > 0.05 kills soft alpha") and the
//           coverage/density pairing was eye-tested on the 1070 2026-07.
//
// The switch is the REAL weather signal: `is_storm` from the active
// DayGroup's SkyObject scan (daygroup_weather.js::scanWeatherSkyObjects —
// DAT truth, not synthesized), read via weather_state. Storms therefore
// come and go with the server's DayGroup rotation.
//
// Pure module — no three.js / takram imports — so node test suites can
// drive it directly (test_cloud_storm_look.mjs).

import { getWeatherState } from './weather_state.js';

export const FAIR_COVERAGE = 0.5;   // cloud_overlay's legacy test baseline
// Live Dereth sunlit cumulus targets (2026-11-12 Pass 2): crisp sculptural
// cumulus puffs against deep Dereth blue sky instead of 0.50 grey overcast soup.
export const CLEAR_CUMULUS_COVERAGE = 0.23;
export const FAIR_CUMULUS_COVERAGE = 0.30;
export const CLOUDY_COVERAGE = 0.44;
// 0.7 → 0.62 (2026-08-01 live 1070 session) → 0.55 (2026-08-02, owner
// verdict on the 7-town tour: "a big layer of stratocumulus everywhere,
// very bland"): the coverageFilterWidth flood turns high coverage into a
// featureless global veil — even zero-weather sky is remapped to ~37%
// density at 0.62/cfw 0.6. Storm overcast now comes from the WEATHER MAP
// (deck/storm channels over marsh, obsidian, etc.) instead of the global
// lift; storm coverage stays only modestly above fair.
export const STORM_COVERAGE = 0.55;

// takram's built-in ground haze density: near-invisible default in fair
// weather, ~10× under a storm (the old humid-air endpoint).
export const FAIR_HAZE_DENSITY = 3e-5;
export const STORM_HAZE_DENSITY = 3e-4;

// Every CloudLayer key is written explicitly so the resulting state is
// deterministic no matter what wrote the layers before us.
export const FAIR_LAYERS = [
  // R/G/B = takram CloudLayers.DEFAULT verbatim (vendor CloudLayers.ts).
  { channel: 'r', altitude: 750,  height: 650,  densityScale: 0.2,
    shapeAmount: 1,   shapeDetailAmount: 1, weatherExponent: 1,
    shapeAlteringBias: 0.35, coverageFilterWidth: 0.6, shadow: true },
  { channel: 'g', altitude: 1000, height: 1200, densityScale: 0.2,
    shapeAmount: 1,   shapeDetailAmount: 1, weatherExponent: 1,
    shapeAlteringBias: 0.35, coverageFilterWidth: 0.6, shadow: true },
  { channel: 'b', altitude: 7500, height: 500,  densityScale: 0.003,
    shapeAmount: 0.4, shapeDetailAmount: 0, weatherExponent: 1,
    shapeAlteringBias: 0.35, coverageFilterWidth: 0.5, shadow: false },
  // A = the alto deck cloud_overlay.js added (~3.5 km, cirrus-class
  // density so it stays translucent).
  { channel: 'a', altitude: 3500, height: 600,  densityScale: 0.004,
    shapeAmount: 0.5, shapeDetailAmount: 0, weatherExponent: 1,
    shapeAlteringBias: 0.35, coverageFilterWidth: 0.5, shadow: false },
];

export const STORM_LAYERS = [
  // Cumulus deck lowered to the storm base (~600 m). cfw 0.6 → 0.35
  // (2026-08-02): the wide filter floods zero-weather sky into a uniform
  // sheet under storm coverage; the tighter filter keeps storm decks
  // anchored to the weather map's dense regions with real gaps between.
  { channel: 'r', altitude: 600,  height: 650,  densityScale: 0.2,
    shapeAmount: 1,   shapeDetailAmount: 1, weatherExponent: 1,
    shapeAlteringBias: 0.35, coverageFilterWidth: 0.35, shadow: true },
  { channel: 'g', altitude: 850,  height: 1200, densityScale: 0.2,
    shapeAmount: 1,   shapeDetailAmount: 1, weatherExponent: 1,
    shapeAlteringBias: 0.35, coverageFilterWidth: 0.35, shadow: true },
  // Cirrus unchanged — thin, mostly hidden behind the overcast anyway.
  { channel: 'b', altitude: 7500, height: 500,  densityScale: 0.003,
    shapeAmount: 0.4, shapeDetailAmount: 0, weatherExponent: 1,
    shapeAlteringBias: 0.35, coverageFilterWidth: 0.5, shadow: false },
  // Cumulonimbus tower: base at the storm cumulus base. Constants re-tuned
  // in the 2026-08-01 live 1070 session (nasa-cb-final/pano-east shots):
  //   height 8800 → 6000 — the full-troposphere slab smeared; 6 km reads
  //     as a genuine tower against the deck.
  //   coverageFilterWidth 0.7 → 0.2 — the wide filter dissolved the tower
  //     into the flood veil; sharp threshold keeps it a discrete mass tied
  //     to the weather map's A channel (real storm cores under ?wxMap=nasa).
  //   densityProfile inverted (const 1.0, linear −0.55) — takram's default
  //     (0.75·h + 0.25) is TOP-heavy, rendering anvils with no base; dense-
  //     base profile gives the classic dark underside + soft top.
  // shadow:true so the dominant storm mass darkens the terrain.
  { channel: 'a', altitude: 600,  height: 6000, densityScale: 0.05,
    shapeAmount: 1,   shapeDetailAmount: 1, weatherExponent: 1.2,
    shapeAlteringBias: 0.4,  coverageFilterWidth: 0.2, shadow: true,
    densityProfile: { expTerm: 0, exponent: 0, linearTerm: -0.55, constantTerm: 1.0 } },
];

// ?flightView high band (flight experience Phase 4, 2026-11-01): flying through and above a storm. The cumulonimbus
// layer is the storm's 2D weather map extruded through 6 km with a sharp coverage edge: from the ground it reads as
// towers, but from an aircraft it is streaky vertical walls, and inside it (0.6-6.6 km) a featureless murk. The 1070
// A/B (forced storm, 1.2 km and 5 km, bench/cloud-ab-1070.mjs) showed that light shafts, the march step and the shape
// detail are NOT the cause, and that without the tower layer the storm reads right from the air: flying among its
// cumulus deck (the r / g layers, 0.6-2 km) with gaps onto the ground, and from above a deck below the aircraft. So
// while the aircraft is up (the altitude policy eases `highBand` 0 → 1 above 900 m AGL, back below 700 m) the
// tower FADES OUT (density × 0.02) as its height eases 6,000 → 1,900 m. Everything else is the storm look verbatim;
// players on the ground never see it (highBand 0).
export const STORM_TOWER_HEIGHT_LOW = 6000;
export const STORM_TOWER_HEIGHT_HIGH = 1900;
export const STORM_TOWER_DENSITY_HIGH_SCALE = 0.02;
// ...and the cumulus deck's tops round off (shapeAlteringBias 0.35 → 0.7 on r / g): the same A/B, fewer vertical
// striations on the flanks seen from above, the gaps onto the ground kept (a wider coverage filter closed them).
export const STORM_DECK_SHAPE_BIAS_HIGH = 0.7;
// The FAIR look, from the air (2026-11-02, 1070 A/B on a live flight at 5 km, bench/fps-ab-1070.mjs, paired shots): its
// alto deck (3.5 km, 600 m, density 0.004 — a faint high veil from below) lay over the whole view from above as one
// grey-lavender sheet: at the grazing angles of a view from 4-5 km its path is kilometres long, so the cumulus deck
// and the ground under it were a blur. While the aircraft is up (the same `highBand` blend) the alto deck thins
// (density × 0.1; × 0.25 still read as haze) and the cumulus tops round off as the storm deck's do. The frame rate is
// unchanged (within the A/B's noise). Players on the ground never see it (highBand 0).
export const FAIR_ALTO_DENSITY_HIGH_SCALE = 0.1;
/** The look's layer table for a storm flag and a high-band blend (0..1, quantized to 1 %). */
export function lookLayers(isStorm, highBand = 0) {
  const b = Math.max(0, Math.min(1, Math.round((Number(highBand) || 0) * 100) / 100));
  if (!isStorm) {
    if (b === 0) return FAIR_LAYERS;
    const out = FAIR_LAYERS.map((l) => ({ ...l }));
    out[3].densityScale = FAIR_LAYERS[3].densityScale * (1 + (FAIR_ALTO_DENSITY_HIGH_SCALE - 1) * b);
    for (const i of [0, 1]) {
      const base = FAIR_LAYERS[i].shapeAlteringBias;
      out[i].shapeAlteringBias = Math.round((base + (STORM_DECK_SHAPE_BIAS_HIGH - base) * b) * 1000) / 1000;
    }
    return out;
  }
  if (b === 0) return STORM_LAYERS;
  const out = STORM_LAYERS.map((l) => ({ ...l }));
  const t = out[3];
  t.height = Math.round(STORM_TOWER_HEIGHT_LOW + (STORM_TOWER_HEIGHT_HIGH - STORM_TOWER_HEIGHT_LOW) * b);
  t.densityScale = STORM_LAYERS[3].densityScale * (1 + (STORM_TOWER_DENSITY_HIGH_SCALE - 1) * b);
  for (const i of [0, 1]) {
    const base = STORM_LAYERS[i].shapeAlteringBias;
    out[i].shapeAlteringBias = Math.round((base + (STORM_DECK_SHAPE_BIAS_HIGH - base) * b) * 1000) / 1000;
  }
  return out;
}

const LAYER_KEYS = [
  'channel', 'altitude', 'height', 'densityScale', 'shapeAmount',
  'shapeDetailAmount', 'weatherExponent', 'shapeAlteringBias',
  'coverageFilterWidth', 'shadow',
];

// takram's CloudLayer default density profile (vendor CloudLayer.ts) — what a
// layer the look does not profile is reset to.
const DEFAULT_DENSITY_PROFILE = Object.freeze({ expTerm: 0, exponent: 0, linearTerm: 0.75, constantTerm: 0.25 });

// SKY-4 remainder (2026-10-18 follow-up): the effects whose coverage a user
// knob owns. `?cloudCoverage` and `__setCloudCoverage` (index.js) write through
// setCloudCoverageKnob, which marks the effect; the look never writes coverage
// on a marked effect, whatever the value. (The fix pass compared values
// instead, so a knob set to exactly the look's current value — 0.5 fair,
// 0.55 storm — was taken back at the next storm edge.)
const _knobCoverage = new WeakSet();

/**
 * Set an effect's coverage from a user knob (`?cloudCoverage`,
 * `__setCloudCoverage`) and hand coverage to the knob for good: applyCloudLook
 * leaves it alone from then on. Clamped to [0, 1]; a value that is not a
 * number changes nothing and marks nothing.
 *
 * @param {Object} effect — takram CloudsEffect (or a test double)
 * @param {number|string} value
 * @returns {number|null} the coverage in force afterwards (null: no effect)
 */
export function setCloudCoverageKnob(effect, value) {
  if (!effect || typeof effect !== 'object') return null;
  const v = Number(value);
  if (Number.isFinite(v)) {
    effect.coverage = Math.max(0, Math.min(1, v));
    _knobCoverage.add(effect);
  }
  return typeof effect.coverage === 'number' ? effect.coverage : null;
}

/** True once a knob has set this effect's coverage (setCloudCoverageKnob). */
export function cloudCoverageOwnedByKnob(effect) {
  return !!effect && typeof effect === 'object' && _knobCoverage.has(effect);
}

/**
 * Write one of the two looks onto a CloudsEffect (or an effect-shaped test
 * double: `{ cloudLayers: [{},{},{},{}], coverage, haze, clouds }`).
 * Idempotent; safe to call on every storm-flag edge.
 *
 * @param {Object} effect — takram CloudsEffect
 * @param {boolean} isStorm — the DayGroup SkyObject storm signal
 * @returns {boolean} false if the effect had no usable cloudLayers
 */
export function applyCloudLook(effect, isStorm, highBand = 0) {
  const layers = effect?.cloudLayers;
  if (!layers || layers.length < 4) return false;
  _continuousSnap.delete(effect);
  const src = lookLayers(isStorm, highBand);
  for (let i = 0; i < 4; i++) {
    for (const key of LAYER_KEYS) layers[i][key] = src[i][key];
    // densityProfile: write the spec'd terms, or RESET to takram's default
    // (0, 0, 0.75, 0.25) when the look doesn't specify one — otherwise a
    // storm profile would leak into the fair look on restore.
    const dp = layers[i].densityProfile;
    if (dp) {
      const p = src[i].densityProfile ?? DEFAULT_DENSITY_PROFILE;
      dp.expTerm = p.expTerm; dp.exponent = p.exponent;
      dp.linearTerm = p.linearTerm; dp.constantTerm = p.constantTerm;
    }
  }
  // Coverage is a TOP-LEVEL CloudsEffect property (`effect.coverage`), NOT
  // on the `effect.clouds` uniform proxy — writing the proxy was the
  // historical dead-knob trap (verified in-browser 2026-07-06).
  // 2026-10-18: never once a knob owns it (setCloudCoverageKnob). index.js
  // applies `?cloudCoverage` right after the overlay's construct-time fair
  // look, and the boot / adoption / storm-edge re-applies used to put 0.5
  // back over it.
  if (typeof effect.coverage === 'number' && !_knobCoverage.has(effect)) {
    effect.coverage = isStorm ? STORM_COVERAGE : FAIR_COVERAGE;
  }
  // takram's built-in ground haze: ensure on (idempotent — one shader
  // recompile at most), density stepped by the storm state.
  if (effect.haze !== true) effect.haze = true;
  if (effect.clouds && 'hazeDensityScale' in effect.clouds) {
    effect.clouds.hazeDensityScale =
      isStorm ? STORM_HAZE_DENSITY : FAIR_HAZE_DENSITY;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Continuous WeatherState -> Sunlit Cumulus Balance (2026-11-12 Pass 2)
// ---------------------------------------------------------------------------
// Smoothly drives coverage, cumulus filter width, wispy cirrus, and alto/stratus
// across clear -> fair -> cloudy -> storm from live WeatherState + SkyState,
// lowering fair-weather coverage from 0.50 -> ~0.30 (0.23 in dry desert clear)
// with near-zero stratus unless overcast/rainy so Dereth skies show crisp sunlit
// cumulus puffs against deep blue sky. Dormant in synthetic unit tests where
// WeatherState has never been ticked (`updatedAt === 0`) or where `is_storm` is
// explicitly pinned via `setWeatherOverride`.
const _continuousSmooth = new WeakMap();
const _continuousSnap = new WeakMap();

function _lerp(a, b, t) {
  return a + (b - a) * t;
}

function _clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Derive continuous weather regime `w` in [0, 1]:
 *   0.00 = dry clear sky (e.g. Yaraq desert, coverage ~0.23)
 *   0.30 = Dereth fair blue-sky cumulus baseline (coverage ~0.30)
 *   0.68 = cloudy / overcast / light rain (coverage ~0.44, stratus filling in)
 *   1.00 = active storm / heavy rain (coverage 0.55, Cb tower)
 */
export function weatherCloudinessFactor(wx, skyState = null) {
  if (!wx) return 0.30;
  if (wx.is_storm) return 1.0;
  let rh = Number.isFinite(wx.rh_pct) ? wx.rh_pct : NaN;
  if (!Number.isFinite(rh) && Number.isFinite(wx.temperature_C) && Number.isFinite(wx.dewpoint_C)) {
    const T = wx.temperature_C;
    const Td = Math.min(T, wx.dewpoint_C);
    // Magnus saturation vapor pressure ratio -> relative humidity [0..100]
    rh = 100 * Math.exp((17.625 * Td) / (243.04 + Td) - (17.625 * T) / (243.04 + T));
  }
  if (!Number.isFinite(rh)) rh = 65;
  const precip = Number.isFinite(wx.precip_mm_hr) ? Math.max(0, wx.precip_mm_hr) : 0;
  // Magnus RH ~72% at temperate Holtburg (T=15C, Td=10C) -> w ~ 0.30 (sunlit cumulus ~0.30);
  // dry desert RH <= 35% -> w = 0.0 (clear cumulus ~0.23); humid RH >= 95% -> w ~ 0.68 (overcast ~0.44).
  let w = _clamp01((rh - 35) / 88);
  if (skyState && Number.isFinite(skyState.fogMax) && skyState.fogMax > 0) {
    // Tighter authored daytime fog (< 1400m) signals hazy/overcast DayGroups;
    // wide clear DayGroups (>= 3200m) pull slightly clearer.
    const fogCloudy = _clamp01((2400 - skyState.fogMax) / 1800);
    w = _clamp01(w * 0.72 + fogCloudy * 0.34);
  }
  if (precip > 0) {
    const rainBoost = _clamp01(precip / 8.0);
    w = Math.max(w, 0.62 + 0.38 * rainBoost);
  }
  return _clamp01(w);
}

/**
 * Continuously update `effect` cloud layers, coverage, and haze from live
 * `WeatherState` (`clear -> fair -> cloudy -> storm`). Active in live sessions
 * (`window.__sessionHandle` / `liveScene3d.sessionHandle` present, or `force=true`),
 * leaving `applyCloudLook` deterministic for synthetic unit-test harnesses.
 */
export function applyContinuousWeatherLook(effect, skyState = null, highBand = 0, force = false) {
  const layers = effect?.cloudLayers;
  if (!layers || layers.length < 4) return false;
  const liveSession = force || !!(
    typeof globalThis !== 'undefined' &&
    (globalThis.window?.__sessionHandle || globalThis.window?.liveScene3d?.sessionHandle)
  );
  if (!liveSession) return false;
  const wx = getWeatherState();
  if (!wx) return false;

  const nowMs = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
  const targetW = weatherCloudinessFactor(wx, skyState);
  let state = _continuousSmooth.get(effect);
  if (!state) {
    state = { w: targetW, tMs: nowMs };
    _continuousSmooth.set(effect, state);
  } else {
    const dtSec = Math.max(0, Math.min(0.5, (nowMs - state.tMs) * 0.001));
    state.tMs = nowMs;
    const alpha = dtSec > 0 ? (1 - Math.exp(-dtSec / 2.2)) : 0.15;
    state.w = Math.abs(targetW - state.w) < 1e-4 ? targetW : _lerp(state.w, targetW, alpha);
  }

  const w = Math.round(state.w * 50) / 50;
  const b = _clamp01(Math.round((Number(highBand) || 0) * 100) / 100);
  const prevSnap = _continuousSnap.get(effect);
  if (prevSnap && prevSnap.__wQ === w && prevSnap.__bQ === b) {
    return true;
  }
  // Piecewise smooth segments:
  //   [0.00 .. 0.30]: clear -> sunlit fair cumulus
  //   [0.30 .. 0.68]: sunlit fair cumulus -> cloudy/overcast
  //   [0.68 .. 1.00]: cloudy/overcast -> full storm Cb
  let coverage;
  let haze;
  let rAlt, rH, rDens, rCfw;
  let gAlt, gH, gDens, gCfw;
  let bDens, bCfw;
  let aAlt, aH, aDens, aShape, aDetail, aExp, aBias, aCfw, aShadow, stormBlend;

  if (w <= 0.30) {
    const t = w / 0.30;
    coverage = _lerp(CLEAR_CUMULUS_COVERAGE, FAIR_CUMULUS_COVERAGE, t);
    haze = _lerp(1.5e-5, 2.2e-5, t);
    rAlt = _lerp(840, 780, t); rH = _lerp(600, 650, t); rDens = _lerp(0.16, 0.185, t); rCfw = _lerp(0.36, 0.42, t);
    gAlt = _lerp(1100, 1040, t); gH = _lerp(980, 1120, t); gDens = _lerp(0.08, 0.125, t); gCfw = _lerp(0.34, 0.40, t);
    bDens = _lerp(0.0011, 0.0016, t); bCfw = _lerp(0.40, 0.45, t);
    aAlt = 3500; aH = 550; aDens = _lerp(0.0001, 0.00035, t);
    aShape = 0.45; aDetail = 0; aExp = 1; aBias = 0.35; aCfw = 0.45; aShadow = false; stormBlend = 0;
  } else if (w <= 0.68) {
    const t = (w - 0.30) / 0.38;
    coverage = _lerp(FAIR_CUMULUS_COVERAGE, CLOUDY_COVERAGE, t);
    haze = _lerp(2.2e-5, 1.1e-4, t);
    rAlt = _lerp(780, 690, t); rH = 650; rDens = _lerp(0.185, 0.20, t); rCfw = _lerp(0.42, 0.46, t);
    gAlt = _lerp(1040, 940, t); gH = _lerp(1120, 1200, t); gDens = _lerp(0.125, 0.19, t); gCfw = _lerp(0.40, 0.44, t);
    bDens = _lerp(0.0016, 0.0026, t); bCfw = _lerp(0.45, 0.50, t);
    // Stratus / alto stays near-zero in fair weather and only builds under overcast/rain.
    aAlt = _lerp(3500, 2400, t); aH = _lerp(550, 900, t); aDens = _lerp(0.00035, 0.0065, t * t);
    aShape = _lerp(0.45, 0.7, t); aDetail = _lerp(0, 0.35, t); aExp = 1; aBias = 0.35;
    aCfw = _lerp(0.45, 0.38, t); aShadow = t > 0.65; stormBlend = 0;
  } else {
    const t = (w - 0.68) / 0.32;
    coverage = _lerp(CLOUDY_COVERAGE, STORM_COVERAGE, t);
    haze = _lerp(1.1e-4, STORM_HAZE_DENSITY, t);
    rAlt = _lerp(690, 600, t); rH = 650; rDens = 0.20; rCfw = _lerp(0.46, 0.35, t);
    gAlt = _lerp(940, 850, t); gH = 1200; gDens = _lerp(0.19, 0.20, t); gCfw = _lerp(0.44, 0.35, t);
    bDens = _lerp(0.0026, 0.003, t); bCfw = 0.50;
    aAlt = _lerp(2400, 600, t);
    const cbTargetH = _lerp(STORM_TOWER_HEIGHT_LOW, STORM_TOWER_HEIGHT_HIGH, b);
    aH = _lerp(900, cbTargetH, t);
    const cbTargetDens = 0.05 * (1 + (STORM_TOWER_DENSITY_HIGH_SCALE - 1) * b);
    aDens = _lerp(0.0065, cbTargetDens, t);
    aShape = _lerp(0.7, 1.0, t); aDetail = _lerp(0.35, 1.0, t);
    aExp = _lerp(1.0, 1.2, t); aBias = _lerp(0.35, 0.40, t);
    aCfw = _lerp(0.38, 0.20, t); aShadow = true; stormBlend = t;
  }

  if (stormBlend === 0 && b > 0) {
    aDens *= (1 + (FAIR_ALTO_DENSITY_HIGH_SCALE - 1) * b);
  }
  const rgBias = Math.round((_lerp(0.35, STORM_DECK_SHAPE_BIAS_HIGH, b)) * 1000) / 1000;

  const spec = [
    {
      channel: 'r', altitude: Math.round(rAlt), height: Math.round(rH),
      densityScale: rDens, shapeAmount: 1, shapeDetailAmount: 1, weatherExponent: 1,
      shapeAlteringBias: rgBias, coverageFilterWidth: rCfw, shadow: true,
      densityProfile: DEFAULT_DENSITY_PROFILE,
    },
    {
      channel: 'g', altitude: Math.round(gAlt), height: Math.round(gH),
      densityScale: gDens, shapeAmount: 1, shapeDetailAmount: 1, weatherExponent: 1,
      shapeAlteringBias: rgBias, coverageFilterWidth: gCfw, shadow: true,
      densityProfile: DEFAULT_DENSITY_PROFILE,
    },
    {
      channel: 'b', altitude: 7500, height: 500,
      densityScale: bDens, shapeAmount: 0.4, shapeDetailAmount: 0, weatherExponent: 1,
      shapeAlteringBias: 0.35, coverageFilterWidth: bCfw, shadow: false,
      densityProfile: DEFAULT_DENSITY_PROFILE,
    },
    {
      channel: 'a', altitude: Math.round(aAlt), height: Math.round(aH),
      densityScale: aDens, shapeAmount: aShape, shapeDetailAmount: aDetail, weatherExponent: aExp,
      shapeAlteringBias: aBias, coverageFilterWidth: aCfw, shadow: aShadow,
      densityProfile: {
        expTerm: 0,
        exponent: 0,
        linearTerm: _lerp(0.75, -0.55, stormBlend),
        constantTerm: _lerp(0.25, 1.0, stormBlend),
      },
    },
  ];

  for (let i = 0; i < 4; i++) {
    for (const key of LAYER_KEYS) layers[i][key] = spec[i][key];
    const dp = layers[i].densityProfile;
    if (dp) {
      const p = spec[i].densityProfile;
      dp.expTerm = p.expTerm; dp.exponent = p.exponent;
      dp.linearTerm = p.linearTerm; dp.constantTerm = p.constantTerm;
    }
  }
  if (typeof effect.coverage === 'number' && !_knobCoverage.has(effect)) {
    effect.coverage = coverage;
  }
  if (effect.clouds && 'hazeDensityScale' in effect.clouds) {
    effect.clouds.hazeDensityScale = haze;
  }
  spec.__wQ = w;
  spec.__bQ = b;
  _continuousSnap.set(effect, spec);
  return true;
}

/**
 * True when the effect's four cloud layers carry the active look's values —
 * every layer key plus the density profile. Coverage and haze are deliberately
 * NOT compared: `?cloudCoverage` / `__setCloudCoverage` tune them live, and the
 * look must not fight a knob. Nothing but applyCloudLook / applyContinuousWeatherLook
 * writes the layers in production, so a mismatch means something external reset
 * them (cloud_volume.js re-applies it then).
 *
 * @param {Object} effect — takram CloudsEffect (or a test double)
 * @param {boolean} isStorm
 * @returns {boolean} also true when the effect has no usable cloudLayers
 */
export function cloudLayersMatchLook(effect, isStorm, highBand = 0) {
  const layers = effect?.cloudLayers;
  if (!layers || layers.length < 4) return true;
  const cont = _continuousSnap.get(effect);
  const src = cont || lookLayers(isStorm, highBand);
  for (let i = 0; i < 4; i++) {
    const l = layers[i];
    for (const key of LAYER_KEYS) if (l[key] !== src[i][key]) return false;
    const dp = l.densityProfile;
    if (dp) {
      const p = src[i].densityProfile ?? DEFAULT_DENSITY_PROFILE;
      if (dp.expTerm !== p.expTerm || dp.exponent !== p.exponent ||
          dp.linearTerm !== p.linearTerm || dp.constantTerm !== p.constantTerm) return false;
    }
  }
  return true;
}

// ?cloudHighBand (flight experience, 2026-11-01; DEFAULT ON, `=off` escapes) — above the deck (the altitude
// policy's above-deck blend `__hbCloudAboveDeck`, > 1.8 km AGL) the clouds march EVERY pixel at half resolution
// instead of takram's temporal upscale. The upscale refreshes one pixel per 4x4 block per frame and keeps the
// other 15 from history; seen from above, the cloud tops showed as salt-and-pepper speckle that never averaged
// out (1070 probe, a still camera for 24 s at 5 km; a looser variance clip, gamma 12, did not help). With the
// upscale off at half resolution the tops are smooth: 4x the march texels of the upscale, and the 1070 held
// 27-28 fps at 5 km under its 30 fps off-screen cap. The switch flips the RESOLVE material's TEMPORAL_UPSCALE
// define, so its other variant is linked off the frame first (compileAsync) and the switch waits for it.
let _cloudHighBandCache;
export function cloudHighBandEnabled(search) {
  if (search === undefined && _cloudHighBandCache !== undefined) return _cloudHighBandCache;
  let on = true;
  try {
    const s = search !== undefined ? search : (globalThis.location?.search || '');
    const v = (new URLSearchParams(s).get('cloudHighBand') || '').trim().toLowerCase();
    on = !(v === 'off' || v === '0' || v === 'false' || v === 'no');
  } catch (_) {
    on = true;
  }
  if (search === undefined) _cloudHighBandCache = on;
  return on;
}
/** The full-march state for the above-deck blend (0..1; `__hbCloudAboveDeck`), with hysteresis: on above 0.65, off below 0.35. */
export function cloudHighBandWant(hb, current) {
  const b = Number(hb) || 0;
  return current ? b > 0.35 : b > 0.65;
}

// ?cloudHighBandMarch (2026-11-02; DEFAULT ON, `=off` escapes) — the every-pixel march above the deck without the
// two parts of takram's "high" preset the view from above does not show. Uniforms only (no program change): applied at
// the switch into the high band, put back when the march leaves it. 1070 A/B on a live flight at 5 km AGL over the storm
// deck (bench/fps-ab-1070.mjs; vsync, 120 Hz; paired screenshots 0.7 s apart): the high band as built held 39 fps.
//   * The light shafts OFF (CLOUD_HIGH_BAND_SHAFTS_MUL): their per-pixel march (the aerial perspective in cloud
//     shadow, 50 m steps growing x1.01, ~160 over the 20 km of a view ray from 5 km) was the largest single cost —
//     39 → 65 fps without it, and the paired shots are indistinguishable from above. It goes through the SAME
//     uniform ?cloudNight already scales for the night (maxShadowLengthRayDistance × mul; 0 = the march exits on its
//     first step), so there is one writer and no define flip (`lightShafts = false` would relink the clouds program).
//   * maxIterationCountToGround 3 → 1: the ground-bounce samples light the deck's UNDERSIDES, out of view from above.
//     NOT 0: takram's CloudsMaterial.onBeforeRender deletes its GROUND_BOUNCE define when the count is 0 (or the
//     bounce scale is), and that relinks the whole clouds program — the ~300 ms frame at the switch into the band in
//     the 1070 runs U11 / U12 (on a cold shader cache it would be seconds). At 1 the define stays: uniforms only.
//   Rejected: a coarser shaft step (400 m: 45 fps), resolution 0.45 (58 fps with both of the above, visibly grainier).
export const CLOUD_HIGH_BAND_MARCH = Object.freeze({ maxIterationCountToGround: 1 });
export const CLOUD_HIGH_BAND_SHAFTS_MUL = 0;
let _cloudHighBandMarchCache;
export function cloudHighBandMarchEnabled(search) {
  if (search === undefined && _cloudHighBandMarchCache !== undefined) return _cloudHighBandMarchCache;
  let on = true;
  try {
    const s = search !== undefined ? search : (globalThis.location?.search || '');
    const v = (new URLSearchParams(s).get('cloudHighBandMarch') || '').trim().toLowerCase();
    on = !(v === 'off' || v === '0' || v === 'false' || v === 'no');
  } catch (_) {
    on = true;
  }
  if (search === undefined) _cloudHighBandMarchCache = on;
  return on;
}
/** Write `march` onto the effect's clouds params; returns the values it replaced (for restoreHighBandMarch). */
export function applyHighBandMarch(clouds, march = CLOUD_HIGH_BAND_MARCH) {
  const base = {};
  if (!clouds || !march) return base;
  for (const k of Object.keys(march)) {
    if (!(k in clouds)) continue;
    base[k] = clouds[k];
    clouds[k] = march[k];
  }
  return base;
}
/** Put back the values applyHighBandMarch replaced. */
export function restoreHighBandMarch(clouds, base) {
  if (!clouds || !base) return;
  for (const k of Object.keys(base)) clouds[k] = base[k];
}
/**
 * What something (a quality preset) has re-written since applyHighBandMarch: { key: its value now } for each param
 * that no longer holds the high band's value, or null. Those values are the new base for the way down.
 */
export function highBandMarchDrift(clouds, march = CLOUD_HIGH_BAND_MARCH) {
  if (!clouds || !march) return null;
  let out = null;
  for (const k of Object.keys(march)) {
    if (k in clouds && clouds[k] !== march[k]) (out || (out = {}))[k] = clouds[k];
  }
  return out;
}
