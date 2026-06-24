// scene3d/vfx/particle_env.js — the Phase-3 env PRODUCER (P3.7 wiring).
//
// Snapshots the live, CLIENT-DERIVED environment once per attach call and hands a
// plain `env` POJO to particle_attach (via opts.env), which forwards it as ctx.env
// to each component's emit(ctx). The foliage/breath gates (particle_env_gates.js)
// read this to ramp visibility with day-night, season, and the real RAIN/SNOW
// weather state (is_storm / wetness / frost / temperature). Gated-out ⇒ no emitter
// (exactly as cheap as flag-off).
//
// THE FIREWALL: reads ONLY derived client state — getWeatherState()/getWeatherInputs()
// (the same smoothed, pop-free signals the frost/wetness washes already consume) +
// the cached SkyState snapshot (scene3d.skyLightingController._lastState). No wire,
// no replicated state, no Math.random, no argless Date.now. Deterministic given the
// same client state. This module imports the weather/uniform modules (THREE-adjacent)
// so it is NOT imported by particle_attach (which stays node-test-safe) — the seam
// imports this and passes the result through opts.env.

import { getWeatherState } from "../weather_state.js";
import { getWeatherInputs } from "./weather_inputs.js";
import { sunAltFromPitchDeg, nightFactor } from "./particle_env_gates.js";

// Reusable scratch (zero-alloc hot path; filled fresh each call). Mirrors
// weather_inputs._scratch. Defaults are calm spring midday — the fail-soft env if
// the sky/weather subsystems are not yet initialized.
const _envScratch = {
  sunAlt: 0.6, nightFactor: 0, timeOfDay: 0.5,
  frost: 0, wetness: 0, stormness: 0,
  season: 1, temperatureC: 15, isStorm: false,
  windStrength: 1, latitudeDeg: 45,
};

/**
 * Build the derived day-night / season / weather snapshot the particle gates read.
 * @param {object} scene3d  the live scene (NOT window — liveScene3d is module-scoped).
 * @param {object} [out]    optional scratch to fill (defaults to the module scratch).
 * @returns {object} a ParticleEnv POJO (see particle_env_gates.js @typedef).
 */
export function readParticleEnv(scene3d, out = _envScratch) {
  // Day-night: the SkyState the atmosphere stack caches (null-safe; lighting.js:885
  // precedent for reading it off the scene arg).
  const sky = (scene3d && scene3d.skyLightingController && scene3d.skyLightingController._lastState) || null;
  const sunAlt = sunAltFromPitchDeg(sky && Number.isFinite(sky.dirPitch) ? sky.dirPitch : 67);
  out.sunAlt = sunAlt;
  out.nightFactor = nightFactor(sunAlt);
  out.timeOfDay = sky && Number.isFinite(sky.timeOfDayNormalized) ? sky.timeOfDayNormalized : 0.5;

  // Smoothed VFX weather inputs (the lowpassed, pop-free rain/snow drives the suite
  // already owns): wetness (rain), frost (snow/cold), stormness.
  let wi = null;
  try { wi = getWeatherInputs(); } catch (_) { wi = null; }
  out.wetness = wi && Number.isFinite(wi.wetness) ? wi.wetness : 0;
  out.frost = wi && Number.isFinite(wi.frost) ? wi.frost : 0;
  out.stormness = wi && Number.isFinite(wi.stormness) ? wi.stormness : 0;
  out.windStrength = wi && wi.windDir ? Math.hypot(wi.windDir.x, wi.windDir.y) : 1;

  // Raw weather state: season / temperature / storm / region (the rain+snow regime).
  let ws = null;
  try { ws = getWeatherState(); } catch (_) { ws = null; }
  out.season = ws && Number.isFinite(ws.season) ? ws.season : 1;          // 0=winter 1=spring 2=summer 3=autumn
  out.temperatureC = ws && Number.isFinite(ws.temperature_C) ? ws.temperature_C : 15;
  out.isStorm = !!(ws && ws.is_storm);
  out.latitudeDeg = ws && Number.isFinite(ws.latitude_deg) ? ws.latitude_deg : 45;

  return out;
}

export default readParticleEnv;
