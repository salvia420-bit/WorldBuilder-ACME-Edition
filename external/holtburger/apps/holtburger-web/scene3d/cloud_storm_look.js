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

export const FAIR_COVERAGE = 0.5;   // cloud_overlay's tuned default
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

const LAYER_KEYS = [
  'channel', 'altitude', 'height', 'densityScale', 'shapeAmount',
  'shapeDetailAmount', 'weatherExponent', 'shapeAlteringBias',
  'coverageFilterWidth', 'shadow',
];

/**
 * Write one of the two looks onto a CloudsEffect (or an effect-shaped test
 * double: `{ cloudLayers: [{},{},{},{}], coverage, haze, clouds }`).
 * Idempotent; safe to call on every storm-flag edge.
 *
 * @param {Object} effect — takram CloudsEffect
 * @param {boolean} isStorm — the DayGroup SkyObject storm signal
 * @returns {boolean} false if the effect had no usable cloudLayers
 */
export function applyCloudLook(effect, isStorm) {
  const layers = effect?.cloudLayers;
  if (!layers || layers.length < 4) return false;
  const src = isStorm ? STORM_LAYERS : FAIR_LAYERS;
  for (let i = 0; i < 4; i++) {
    for (const key of LAYER_KEYS) layers[i][key] = src[i][key];
    // densityProfile: write the spec'd terms, or RESET to takram's default
    // (0, 0, 0.75, 0.25) when the look doesn't specify one — otherwise a
    // storm profile would leak into the fair look on restore.
    const dp = layers[i].densityProfile;
    if (dp) {
      const p = src[i].densityProfile ??
        { expTerm: 0, exponent: 0, linearTerm: 0.75, constantTerm: 0.25 };
      dp.expTerm = p.expTerm; dp.exponent = p.exponent;
      dp.linearTerm = p.linearTerm; dp.constantTerm = p.constantTerm;
    }
  }
  // Coverage is a TOP-LEVEL CloudsEffect property (`effect.coverage`), NOT
  // on the `effect.clouds` uniform proxy — writing the proxy was the
  // historical dead-knob trap (verified in-browser 2026-07-06).
  if (typeof effect.coverage === 'number') {
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
