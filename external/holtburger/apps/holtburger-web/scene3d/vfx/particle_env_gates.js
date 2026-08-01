// scene3d/vfx/particle_env_gates.js — derived day/weather/region/season
// VISIBILITY GATES for the synthesized-particle family (Visual-Behavior Suite,
// Phase 3 / P3.7 — 2026-06-24).
//
// THE RULE (binding, build-spec §1.2 / handoff §5): every input here is a
// CLIENT-DERIVED environment scalar (sky-state sun altitude, weather_state
// season/temperature/storm, weather_inputs smoothed frost/wind) + the client
// clock. NO server-replicated field, NO wire, NO Math.random — each gate is a
// PURE deterministic function of its `env` argument, so two clients with the
// same sky/weather snapshot agree on whether (and how strongly) an ambient
// emitter shows. This is the particle-family analogue of weather_inputs.js,
// which already derives uFrost/uWetness for the frag-weathering family.
//
// SPLIT OF OWNERSHIP (coordinate w/ agent 15's input contract):
//   • THIS module owns the PURE consumers: nightFactor(), the four
//     <effect>Gate(env) functions, and the ParticleEnv field contract. It is
//     node-testable (no THREE, no window) and is scanned clean by
//     test_vfx_legacy_safety (no forbidden source patterns).
//   • Agent 15's env PRODUCER (readParticleEnv, sketched at the bottom as a
//     reference, NOT exported here) snapshots the live derived state once/frame
//     from scene3d.skyLightingController._lastState + weather_state +
//     weather_inputs and hands the plain `env` POJO to the particle attach
//     layer (P3.1) which forwards it as ctx.env to each component's emit(ctx).
//
// Gate convention: every gate returns a VISIBILITY SCALAR in [0,1].
//   0     → fully gated OUT (the attach layer synthesizes NO emitter — so a
//           gated-out effect is exactly as cheap as flag-off: zero draw calls).
//   (0,1] → emit, with birthrate / maxParticles scaled by the scalar so dusk
//           fireflies ramp in smoothly rather than popping. The emit() hook
//           multiplies the base spawn-rate by the scalar (see foliageAmbient.js).
//
// Season enum (weather_state.js): 0=winter, 1=spring, 2=summer, 3=autumn.

const SEASON_WINTER = 0;
const SEASON_SPRING = 1;
const SEASON_SUMMER = 2;
const SEASON_AUTUMN = 3;

/**
 * @typedef {Object} ParticleEnv  Derived, client-only environment snapshot.
 * @property {number} sunAlt        sin(dirPitch°) ∈ [-1,1]; <0 = sun below horizon.
 * @property {number} nightFactor   1=full night … 0=full day (see nightFactor()).
 * @property {number} [timeOfDay]   skyState.timeOfDayNormalized ∈ [0,1] (optional).
 * @property {number} frost         smoothed cold drive ∈ [0,1] (weather_inputs.getWeatherInputs().frost).
 * @property {number} season        0..3 (weather_state).
 * @property {number} temperatureC  weather_state.temperature_C.
 * @property {boolean} isStorm      weather_state.is_storm.
 * @property {number} stormness     smoothed storm presence ∈ [0,1] (weather_inputs).
 * @property {number} windStrength  |VFX_GLOBALS.uWindDir| gust scalar (~1 = calm baseline).
 * @property {number} [latitudeDeg] weather_state.latitude_deg (region proxy; optional).
 */

/** clamp helper (no allocation). */
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smoothstep(e0, e1, x) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// Dawn/dusk band, IDENTICAL to ac_moons.js moonBrightnessFactorFromSunAltitude
// (the established precedent): full day at sunAlt ≥ +0.10, full night at
// sunAlt ≤ -0.10, linear dusk/dawn between. Keeping the same band means
// fireflies cross-fade in exactly as the moon brightens and the stars appear.
const SUN_DAY = 0.10;
const SUN_NIGHT = -0.10;

/**
 * Night fraction in [0,1] from the sun-altitude component. 1 at night, 0 by
 * day, linear across the ±0.10 dawn/dusk band. Mirrors
 * ac_moons.js:361-373 (sin(dirPitch)→nightFrac) so all twilight effects share
 * ONE timebase. Pure.
 * @param {number} sunAlt  sin(dirPitch°)
 */
export function nightFactor(sunAlt) {
  const a = Number.isFinite(sunAlt) ? sunAlt : SUN_DAY; // default = full day
  const t = (a - SUN_NIGHT) / (SUN_DAY - SUN_NIGHT);
  return 1 - clamp01(t);
}

/**
 * Convert an AC sky-state pitch (degrees) to the sun-altitude component.
 * sky_lighting.js snapshots dirPitch on _lastState; sin(pitch°) is the
 * three.js sun.y (sun_direction.js). Pure helper for the env producer.
 * @param {number} dirPitchDeg
 */
export function sunAltFromPitchDeg(dirPitchDeg) {
  const p = Number.isFinite(dirPitchDeg) ? dirPitchDeg : 67; // ~Dereth noon default
  return Math.sin(p * Math.PI / 180);
}

// ── The four P3.7 visibility gates (pure, deterministic) ──────────────────────

/**
 * POLLEN — daytime, calm, growing-season ambient motes. Suppressed at night,
 * in storm, and in winter (no pollen on bare/snow trees). Peaks spring/summer.
 * @param {ParticleEnv} env
 * @returns {number} visibility ∈ [0,1]
 */
export function pollenGate(env) {
  if (!env) return 0;
  // env.nightFactor is the canonical input (precomputed by the producer); fall
  // back to deriving it from sunAlt only if it is absent.
  const night = Number.isFinite(env.nightFactor) ? env.nightFactor : nightFactor(env.sunAlt);
  const dayFactor = 1 - night;
  const calm = clamp01(1 - (Number.isFinite(env.stormness) ? env.stormness : (env.isStorm ? 1 : 0)));
  let seasonW;
  switch (env.season) {
    case SEASON_SPRING: seasonW = 1.0; break;
    case SEASON_SUMMER: seasonW = 0.85; break;
    case SEASON_AUTUMN: seasonW = 0.35; break;
    default: seasonW = 0.0; // winter: none
  }
  // also fade out if it is freezing regardless of nominal season
  const notFrozen = 1 - clamp01(env.frost);
  return clamp01(dayFactor) * calm * seasonW * notFrozen;
}

/**
 * FIREFLIES — dusk/night, warm season, calm. Additive sparks. Ramps in as the
 * sun dips (nightFactor), peaks summer, off in storm and cold.
 * @param {ParticleEnv} env
 * @returns {number} visibility ∈ [0,1]
 */
export function firefliesGate(env) {
  if (!env) return 0;
  const night = Number.isFinite(env.nightFactor) ? env.nightFactor : nightFactor(env.sunAlt);
  const calm = clamp01(1 - (Number.isFinite(env.stormness) ? env.stormness : (env.isStorm ? 1 : 0)));
  const tempC = Number.isFinite(env.temperatureC) ? env.temperatureC : 15;
  let seasonW, warm;
  if (env.strictFoliageSeason) {
    // STRICT (?foliageStrictSeason=1) — the original realism gate: summer-warm only.
    switch (env.season) {
      case SEASON_SUMMER: seasonW = 1.0; break;
      case SEASON_SPRING: seasonW = 0.5; break;
      case SEASON_AUTUMN: seasonW = 0.25; break;
      default: seasonW = 0.0; // winter: none
    }
    warm = smoothstep(8, 14, tempC);                 // fade across 8°C→14°C
  } else {
    // RELAXED (default 2026-07-04) — fireflies are THE night foliage effect, so
    // keep the defining night + calm gate but drop the summer-warm-ONLY
    // requirement: Dereth has no reliable summer, and the user wants to see them.
    // They still ramp brighter in warm summer and thin out in a hard freeze.
    switch (env.season) {
      case SEASON_SUMMER: seasonW = 1.0; break;
      case SEASON_SPRING: seasonW = 0.75; break;
      case SEASON_AUTUMN: seasonW = 0.65; break;
      default: seasonW = 0.55; // winter fireflies still show (relaxed)
    }
    warm = 0.5 + 0.5 * smoothstep(6, 14, tempC);     // floor 0.5, never fully off by cold
  }
  return clamp01(night) * seasonW * warm * calm;
}

/**
 * LEAVES — autumn shed, modulated by wind (more leaves loosed when gusty).
 * A few stray leaves outside autumn; none in winter (bare). Day or night.
 * @param {ParticleEnv} env
 * @returns {number} visibility ∈ [0,1]
 */
export function leavesGate(env) {
  if (!env) return 0;
  let seasonW;
  if (env.strictFoliageSeason) {
    // STRICT (?foliageStrictSeason=1) — original autumn-shed realism gate.
    switch (env.season) {
      case SEASON_AUTUMN: seasonW = 1.0; break;
      case SEASON_SUMMER: seasonW = 0.15; break;
      case SEASON_SPRING: seasonW = 0.10; break;
      default: seasonW = 0.0; // winter: bare canopy → no shed
    }
  } else {
    // RELAXED (default 2026-07-04) — Dereth has no calendar autumn, so gate
    // canopy leaf-shed YEAR-ROUND (ambient drift from trees/bushes) with an
    // autumn PEAK rather than an autumn-ONLY window. The user wants to see them.
    switch (env.season) {
      case SEASON_AUTUMN: seasonW = 1.0; break;
      case SEASON_SUMMER: seasonW = 0.6; break;
      case SEASON_SPRING: seasonW = 0.55; break;
      case SEASON_WINTER: seasonW = 0.5; break; // winter still sheds a little (relaxed)
      default: seasonW = 0.5;
    }
  }
  // Wind drives the loose-leaf rate: calm baseline ~1.0, gusty storm ~1.7
  // (writeWindVector envelope). Map [1.0, 1.6] gust → [0.3, 1.0] shed weight,
  // so even dead-calm autumn shows a gentle drift.
  const gust = Number.isFinite(env.windStrength) ? env.windStrength : 1.0;
  const windW = 0.3 + 0.7 * smoothstep(1.0, 1.6, gust);
  return clamp01(seasonW * windW);
}

/**
 * BREATH-FOG — visible exhalation in the COLD. Ties to the SAME derived cold
 * drive the frost wash uses (weather_inputs frost = f(temperature, season)), so
 * breath appears exactly in the zones/seasons the world rimes up. Slightly
 * stronger at night (colder air reads as denser breath). Region/season are
 * folded into `frost` already; `latitudeDeg` is an optional extra cold bias.
 * @param {ParticleEnv} env
 * @returns {number} visibility ∈ [0,1]
 */
export function breathFogGate(env) {
  if (!env) return 0;
  // Primary cold signal: prefer the smoothed frost drive; fall back to a raw
  // temperature ramp (warm 6°C → cold 0°C) when frost wasn't supplied.
  const cold = Number.isFinite(env.frost)
    ? clamp01(env.frost)
    : smoothstep(6, 0, Number.isFinite(env.temperatureC) ? env.temperatureC : 15);
  if (cold <= 0) return 0;
  const night = Number.isFinite(env.nightFactor) ? env.nightFactor : nightFactor(env.sunAlt);
  const nightBias = 0.85 + 0.15 * clamp01(night); // 0.85 day … 1.0 night
  return clamp01(cold * nightBias);
}

/**
 * MARSH GAS — sluggish bubbling over swamp ground (terrain-VFX Wave 3A, plan
 * §3.5 item 2). Decomposing peat vents whether or not the sun is up, so unlike
 * the four gates above this one has NO day/night hard cut — it is a slow,
 * always-there phenomenon that three things modulate:
 *  • frost (0..1)          ⇒ linearly to ZERO. A frozen marsh does not vent at
 *                            all, so a hard freeze gates the effect OUT
 *                            entirely (no emitter is synthesized — as cheap as
 *                            flag-off). This reuses the SAME smoothed cold
 *                            drive the frost wash and breath fog read, so the
 *                            marsh stops bubbling exactly where the world
 *                            rimes up.
 *  • wind (`windStrength`) ⇒ a gust disperses the bubble column before it reads.
 *                            The calm baseline is ~1.0 and a storm gust ~1.7
 *                            (writeWindVector's envelope), so [1.0, 1.6] maps to
 *                            [1.0, 0.4] — never to zero, because the bubbles
 *                            still surface, they just do not linger.
 *  • night (`nightFactor`) ⇒ mild 0.75 → 1.0 bias. A pale gas plume reads
 *                            against dark water and washes out at noon.
 * PURE and TOTAL, like every gate here: a null env reads as a calm, temperate,
 * daylit marsh (1.0) rather than throwing.
 * @param {ParticleEnv} env
 * @returns {number} visibility ∈ [0,1]
 */
export function marshGasGate(env) {
  if (!env) return 1;
  const cold = clamp01(Number.isFinite(env.frost) ? env.frost : 0);
  const gust = Number.isFinite(env.windStrength) ? env.windStrength : 1.0;
  const disperse = 1 - 0.6 * smoothstep(1.0, 1.6, gust);
  const night = Number.isFinite(env.nightFactor) ? env.nightFactor : nightFactor(env.sunAlt);
  const nightBias = 0.75 + 0.25 * clamp01(night);
  return clamp01((1 - cold) * disperse * nightBias);
}

/** Map gate id → gate fn (used by the components + tests). */
export const PARTICLE_GATES = Object.freeze({
  "particle.foliagePollen": pollenGate,
  "particle.fireflies": firefliesGate,
  "particle.leaves": leavesGate,
  "particle.breathFog": breathFogGate,
  // Terrain-VFX Wave 3A. The SWAMP family's fireflies and midges deliberately
  // do NOT appear here: they re-anchor `foliageFireflies`/`foliagePollen` and
  // reuse `firefliesGate`/`pollenGate` VERBATIM (that reuse is the point — plan
  // §3.5 item 1 "do not write a second firefly system"). Only the marsh gas is
  // a genuinely new phenomenon and therefore a genuinely new gate.
  "terrain.marshGas": marshGasGate,
});

// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE — the env PRODUCER (owned by agent 15; NOT exported from this pure
// module so the legacy-safety scan stays clean and this file stays node-safe).
// Reproduced here so the input contract is unambiguous. It reads ONLY derived
// client state, exactly like weather_inputs.js, and allocates a reusable scratch.
//
//   import { getWeatherInputs } from "./weather_inputs.js";
//   import { getWeatherState }  from "../weather_state.js";
//   import { sunAltFromPitchDeg, nightFactor } from "./particle_env_gates.js";
//
//   const _envScratch = { sunAlt: 0, nightFactor: 0, timeOfDay: 0, frost: 0,
//     season: 1, temperatureC: 15, isStorm: false, stormness: 0,
//     windStrength: 1, latitudeDeg: 45 };
//
//   export function readParticleEnv(scene3d, out = _envScratch) {
//     const sky = scene3d?.skyLightingController?._lastState || null;
//     const wi  = getWeatherInputs();     // {wetness,frost,stormness,windDir,...}
//     const ws  = getWeatherState();      // {season,temperature_C,is_storm,latitude_deg,...}
//     const sunAlt = sunAltFromPitchDeg(sky ? sky.dirPitch : 67);
//     out.sunAlt = sunAlt;
//     out.nightFactor = nightFactor(sunAlt);
//     out.timeOfDay = sky ? sky.timeOfDayNormalized : 0.5;
//     out.frost = wi.frost;
//     out.stormness = wi.stormness;
//     out.windStrength = Math.hypot(wi.windDir.x, wi.windDir.y);
//     out.season = ws.season;
//     out.temperatureC = ws.temperature_C;
//     out.isStorm = ws.is_storm;
//     out.latitudeDeg = ws.latitude_deg;
//     return out;
//   }
// ─────────────────────────────────────────────────────────────────────────────
