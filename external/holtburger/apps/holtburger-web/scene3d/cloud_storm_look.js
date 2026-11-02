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

/**
 * True when the effect's four cloud layers carry exactly the look's values —
 * every layer key plus the density profile. Coverage and haze are deliberately
 * NOT compared: `?cloudCoverage` / `__setCloudCoverage` tune them live, and the
 * look must not fight a knob. Nothing but applyCloudLook writes the layers in
 * production, so a mismatch while the flag says this look means something
 * reset them after the look was applied (cloud_volume.js re-applies it then).
 *
 * @param {Object} effect — takram CloudsEffect (or a test double)
 * @param {boolean} isStorm
 * @returns {boolean} also true when the effect has no usable cloudLayers
 */
export function cloudLayersMatchLook(effect, isStorm, highBand = 0) {
  const layers = effect?.cloudLayers;
  if (!layers || layers.length < 4) return true;
  const src = lookLayers(isStorm, highBand);
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
