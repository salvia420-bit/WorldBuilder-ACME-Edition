// scene3d/vfx/weather_inputs.js — VFX weather/wind input driver
// (Visual-Behavior Suite, Phase 1, slice 12 — 2026-06-23).
//
// Derives the three CLIENT-SIDE environment uniforms the cheap-fragment
// weathering family reads — VFX_GLOBALS.uWetness / uFrost / uWindDir — from
// the already-client-derived weather_state.js snapshot (is_storm, season,
// temperature_C). This is the single owner of those three globals; the
// oscillator registry (slice 01) owns uTime, and a frag component reads these
// {value} objects BY REFERENCE (never reassigns them).
//
// THE RULE (binding): reads only derived client weather + the client clock
// (VFX_GLOBALS.uTime is the same frameTime.tsSec the oscillator pushes);
// writes only shared cloned-material uniforms the server neither stores nor
// replicates. NO server state, NO wire, NO Math.random — every modulation is a
// pure function of the client clock so two clients with the same weather +
// clock agree. weather_state.js is itself fully client-derived (DayGroup
// heuristic + SkyObject scan), so nothing here touches a replicated field.
//
// This file lives in scene3d/vfx/ (infra), NOT scene3d/vfx/components/, so the
// test_vfx_legacy_safety component scan does not (and should not) cover it —
// same as oscillators.js, registry.js, lint_caps.js. It is still written
// clean (no forbidden patterns) and has its own test.
//
// Tick: loop.js calls tickWeatherInputs(tSec) once/frame next to the oscillator
// tick (slice 01), gated by the same ?visual flag. O(1), zero per-frame alloc.

import { VFX_GLOBALS } from "../materials.js";
import { readWeatherVfxInputs } from "../weather_state.js";

const TAU = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

// --- Tunables (all client-only feel constants; no retail analogue) ---------

// Wind azimuth. Default 135° (SE) matches tree_wind.js's treeWindDir default so
// frag wind shaders and the MECH-A tree clip share a prevailing direction.
let _baseWindDirDeg = 135;
const WIND_WANDER_DEG = 12;        // ± slow directional wander amplitude
const WIND_WANDER_HZ = 1 / 45;     // ~45 s per wander cycle = "slowly rotating"
const CALM_BREATHE_AMP = 0.06;     // gentle |wind| breathing when calm
const CALM_BREATHE_HZ = 1 / 13;    // ~13 s breathing period
const STORM_GUST_AMP = 0.7;        // peak storm gust added on top of the breathe

// Frost ramp: full frost at/below FROST_T_LO °C, none at/above FROST_T_HI °C.
const FROST_T_HI = 2;
const FROST_T_LO = -8;
const WINTER_FROST_FLOOR = 0.35;   // season 0 keeps a light frost even if warmish
const SEASON_WINTER = 0;

// First-order lowpass time constants (seconds) so onset/offset never pops.
const WET_TAU = 3.0;
const FROST_TAU = 6.0;
const STORM_TAU = 4.0;
const MAX_DT = 0.25;               // clamp tab-resume / first-frame spikes

// --- Smoothed state (module-singleton; mirrors weather_state's pattern) -----

const _st = { lastT: null, wetness: 0, frost: 0, stormness: 0 };
// Reused scratch for the zero-alloc weather read (no per-frame allocation).
const _scratch = { is_storm: false, temperature_C: 15, season: 1 };

// --- Pure mapping functions (testable, deterministic) -----------------------

/** Clamp helper. */
function _clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/**
 * Frame-rate-independent exponential approach of `cur` toward `target`.
 * dt may be Infinity (first frame) → snaps. Deterministic given (cur,target,dt).
 */
function _approach(cur, target, dt, tau) {
  if (!(dt > 0)) return cur;        // dt 0 / NaN → hold
  if (!(tau > 0) || !Number.isFinite(dt)) return target; // snap (first frame)
  const k = 1 - Math.exp(-dt / tau);
  return cur + (target - cur) * k;
}

/**
 * Frost target [0,1] from temperature + season. Pure.
 * Cold → 1, warm → 0; winter season clamps a frost floor so a momentarily warm
 * DayGroup profile in a snow zone doesn't melt the whole world.
 * @param {number} tempC  surface temperature °C
 * @param {number} season 0=winter,1=spring,2=summer,3=autumn
 */
export function frostTarget(tempC, season) {
  const t = Number.isFinite(tempC) ? tempC : 15;
  let f = _clamp01((FROST_T_HI - t) / (FROST_T_HI - FROST_T_LO));
  if (season === SEASON_WINTER) f = Math.max(f, WINTER_FROST_FLOOR);
  return f;
}

/**
 * Wetness target [0,1]. Rain sheen only when storming AND not freezing
 * (cold storm = snow, handled by frost) — the wet/frost mutual-exclusion rule
 * (spec §4.2): wetness is scaled down by the frost target. Pure.
 * @param {boolean} isStorm
 * @param {number} frostT  result of frostTarget()
 */
export function wetnessTarget(isStorm, frostT) {
  return isStorm ? (1 - _clamp01(frostT)) : 0;
}

/**
 * Write the horizontal wind vector into a Vector2-like `out`.
 * Convention: out = (x, z) ground-plane wind in three.js space; out.length()
 * is the GUST STRENGTH (1.0 ≈ calm baseline). Direction slowly wanders about
 * the prevailing azimuth; magnitude breathes when calm and gusts irregularly
 * (but deterministically — sum of sines, no Math.random) scaled by `stormness`.
 * Pure in (t, stormness): same inputs → same vector on every client.
 * @param {number} t          client clock seconds (VFX_GLOBALS.uTime)
 * @param {number} stormness  smoothed storm scalar [0,1]
 * @param {{set?:Function,x?:number,y?:number}} out  Vector2-like target
 */
export function writeWindVector(t, stormness, out) {
  const ts = Number.isFinite(t) ? t : 0;
  const s = _clamp01(stormness);
  const angle =
    _baseWindDirDeg * DEG2RAD +
    WIND_WANDER_DEG * DEG2RAD * Math.sin(ts * WIND_WANDER_HZ * TAU);
  // Irregular-but-deterministic gust envelope in [0,1] (incommensurate sines).
  const gustEnv =
    0.5 + 0.5 * (0.5 * Math.sin(ts * 0.37 * TAU) +
                 0.3 * Math.sin(ts * 0.91 * TAU + 1.3) +
                 0.2 * Math.sin(ts * 1.73 * TAU + 2.7));
  const breathe = 1 + CALM_BREATHE_AMP * Math.sin(ts * CALM_BREATHE_HZ * TAU);
  const gust = breathe + s * STORM_GUST_AMP * gustEnv;
  const x = Math.cos(angle) * gust;
  const y = Math.sin(angle) * gust;
  if (out && typeof out.set === "function") out.set(x, y);
  else if (out) { out.x = x; out.y = y; }
  return out;
}

// --- Per-frame tick ---------------------------------------------------------

/**
 * Drive VFX_GLOBALS.uWetness / uFrost / uWindDir for this frame. Called once
 * per frame from loop.js next to the oscillator tick, gated by ?visual.
 *
 * @param {number} nowSec  client clock seconds — pass scene3d.frameTime.tsSec
 *                         (the SAME source the oscillator pushes into uTime, so
 *                         wind/wetness stay phase-locked with uTime).
 * @param {{is_storm:boolean,temperature_C:number,season:number}} [flagsOverride]
 *                         test injection; defaults to the live weather snapshot.
 */
export function tickWeatherInputs(nowSec, flagsOverride) {
  const t = Number.isFinite(nowSec) ? nowSec : 0;

  // dt from the master clock; Infinity on the first frame → snap to the
  // current weather (correct boot state, no spurious multi-second fade-in).
  let dt;
  if (_st.lastT == null) dt = Infinity;
  else {
    dt = t - _st.lastT;
    if (!(dt >= 0)) dt = 0;          // clock reset/backwards → hold this frame
    if (dt > MAX_DT) dt = MAX_DT;    // clamp tab-resume spike
  }
  _st.lastT = t;

  const w = flagsOverride || readWeatherVfxInputs(_scratch);
  const isStorm = !!w.is_storm;
  const tempC = Number.isFinite(w.temperature_C) ? w.temperature_C : 15;
  const season = Number.isFinite(w.season) ? w.season : 1;

  const fTarget = frostTarget(tempC, season);
  const wTarget = wetnessTarget(isStorm, fTarget);
  const sTarget = isStorm ? 1 : 0;   // gust scales with storm presence

  _st.frost = _approach(_st.frost, fTarget, dt, FROST_TAU);
  _st.wetness = _approach(_st.wetness, wTarget, dt, WET_TAU);
  _st.stormness = _approach(_st.stormness, sTarget, dt, STORM_TAU);

  // Write the shared {value} objects BY REFERENCE (never reassign them — a
  // patched material holds the same object reference).
  VFX_GLOBALS.uWetness.value = _st.wetness;
  VFX_GLOBALS.uFrost.value = _st.frost;
  writeWindVector(t, _st.stormness, VFX_GLOBALS.uWindDir.value);
}

// --- Config + introspection -------------------------------------------------

/** Optional config hook (slice 14 flags can set the prevailing wind azimuth). */
export function configureWeatherInputs(opts) {
  if (opts && Number.isFinite(opts.windDirDeg)) _baseWindDirDeg = opts.windDirDeg;
}

/** Read-only snapshot of the smoothed inputs (devtools / tests). */
export function getWeatherInputs() {
  const wd = VFX_GLOBALS.uWindDir.value;
  return {
    wetness: _st.wetness,
    frost: _st.frost,
    stormness: _st.stormness,
    windDir: { x: wd.x, y: wd.y },
    windDirDeg: _baseWindDirDeg,
  };
}

/** Test/reset helper — clears smoothing state and zeroes the uniforms. */
export function resetWeatherInputs() {
  _st.lastT = null;
  _st.wetness = 0;
  _st.frost = 0;
  _st.stormness = 0;
  VFX_GLOBALS.uWetness.value = 0;
  VFX_GLOBALS.uFrost.value = 0;
  if (VFX_GLOBALS.uWindDir.value.set) VFX_GLOBALS.uWindDir.value.set(1, 0);
  _baseWindDirDeg = 135;
}

// Devtools live-tuning hook (mirrors weather_state's __setWeather pattern).
if (typeof window !== "undefined") {
  // eslint-disable-next-line no-undef
  window.__getVfxWeather = getWeatherInputs;
}
