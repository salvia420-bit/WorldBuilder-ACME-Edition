// scene3d/vehicle/audio.js — F6F-5 Hellcat procedural WebAudio soundscape (vehicles HBV1).
//
// Deterministic, zero-asset synthesis on `audioManager.getEffectBus()`:
//   * Pratt & Whitney R-2800-10W Double Wasp (18-cyl twin-row radial): multi-harmonic
//     PeriodicWave (harmonics 1, 2, 4, 5, 9, 18) at crankHz + 4.5×crankHz collector
//     sub-thump → soft-tanh WaveShaper manifold saturation → dynamic low-pass, with
//     first-order spool lag (tauUp 0.26 s, tauDown 0.44 s) and airborne windmilling floor.
//   * Hamilton Standard 3-blade Hydromatic propeller (2:1 reduction → 1.5×crankHz chop)
//     + transonic prop-tip sawtooth rasp/buzz above rpmNorm 0.76 / WEP / fast dives.
//   * Two-stage centrifugal supercharger whine (1150..4450 Hz, stepping up in WEP boost).
//   * Full-envelope slipstream (0..115 m/s, never clamped at 40 m/s), gun-port/cowling
//     steep-dive howl, 14 Hz high-G/pre-stall airframe shudder, and 8 Hz pulsed cockpit
//     stall/envelope reed (880/1046 Hz on ear).
//   * 3D observer flyby pool (up to maxObserverVoices = 4 within 1800 m) with smoothed
//     radial 3D Doppler shift, approach/recede atmospheric filtering, and < 65 m propwash
//     whoosh (including the pilot's own derelict Hellcat roaring away after bailout).
//   * Bailout canopy bang + freefall wind (50 m/s roar → 6 m/s parachute breeze) and
//     10 concurrency-capped procedural one-shot FX scheduled purely on ctx.currentTime.
//
// Routes directly to `bus.node` (`_effectMaster`), bypassing the 16-slot retail voicePool,
// scaling by `bus.sliderGain()` so both HRTF and `?audioRetailPan=on` honour the Options
// sliders, and honouring `isActive()` focus mute. Deterministic noise comes exclusively
// from `mulberry32(hashString("vehicle-hellcat-audio"))` (never `Math.random()`).

import { hashString, mulberry32 } from "../film/core/rng.js";

/**
 * Frozen acoustic and physical tuning constants for the F6F Hellcat soundscape.
 * @type {Readonly<Record<string, number>>}
 */
export const HELLCAT_AUDIO_TUNING = Object.freeze({
  // Atmosphere & 3D Doppler
  speedOfSound: 343,
  dopplerMaxRelVel: 150,
  dopplerMin: 0.55,
  dopplerMax: 1.75,
  dopplerTau: 0.05,

  // R-2800-10W Double Wasp RPM envelope
  rpmIdle: 660, // 11.0 Hz crank, 99.0 Hz 9-per-rev firing
  rpmCruise: 2150, // ~35.83 Hz crank
  rpmMilitary: 2700, // 45.0 Hz crank
  rpmWep: 2820, // 47.0 Hz crank (water-injection boost)
  rpmOverspeed: 2910,
  windmillRpmSpan: 980,
  cylindersPerRow: 9,
  propBpfPerCrank: 1.5, // 3 blades × 0.5 reduction gear
  tauUp: 0.26,
  tauDown: 0.44,

  // Reference flight speeds (m/s)
  vMinDefault: 30,
  vCruiseRef: 83,
  vMaxRef: 111,
  windMaxSpeed: 115,

  // Prop-tip transonic buzz
  tipBuzzRpmOnset: 0.76,
  tipBuzzDiveSpeed: 88,
  tipBuzzMaxGain: 0.24,

  // Two-stage centrifugal supercharger
  blowerMinHz: 1150,
  blowerSpanHz: 3050,
  blowerBoostStepHz: 250, // 1150 + 3050 + 250 = 4450 Hz in WEP
  blowerMaxGain: 0.06,

  // Manifold drive & radial collector filter
  driveMin: 1.2,
  driveThrottleSpan: 1.9,
  driveBoostAdd: 0.45,
  radialCutoffMinHz: 260,
  radialCutoffMaxHz: 2950,
  radialGainIdle: 0.11,
  radialGainMax: 0.34,
  propChopBaseGain: 0.055,
  propChopMaxGain: 0.17,

  // Perspective tone shaping & crossfade
  cockpitCutoffHz: 3000,
  cockpitLowShelfHz: 180,
  cockpitLowShelfDb: 3.5,
  externalCutoffHz: 7800,
  earTau: 0.07,
  paramTau: 0.045,

  // Airspeed slipstream & steep-dive howl
  windCutoffMinHz: 280,
  windCutoffMaxHz: 3400,
  windMaxGain: 0.22,
  divePitchOnset: -0.18,
  diveSpeedOnset: 58,
  diveHowlMinHz: 320,
  diveHowlMaxHz: 680,
  diveHowlQ: 11,
  diveHowlMaxGain: 0.14,

  // High-G / pre-stall buffet & cockpit stall/envelope reed
  buffetGOnset: 1.85,
  buffetStallRatio: 1.18,
  buffetLfoHz: 14,
  buffetMaxGain: 0.18,
  stallSpeedRatio: 1.12,
  stallPulseHz: 8,
  stallFreqAHz: 880,
  stallFreqBHz: 1046,
  stallHornMaxGain: 0.09,

  // Spatial panners & observer pool
  pilotRefDistance: 14,
  pilotRolloffFactor: 1.35,
  pilotMaxDistance: 1800,
  observerRefDistance: 18,
  observerRolloffFactor: 1.25,
  observerMaxDistance: 1800,
  observerRangeM: 1800,
  maxObserverVoices: 4,
  flybyWhooshRangeM: 65,

  // Bailout, ordnance & one-shot pool
  fallMaxGain: 0.24,
  explosionMaxRangeM: 2500,
  explosionMaxDelaySec: 2.2,
  maxOneShots: 14,
  hitMinIntervalSec: 0.055,
  noiseSec: 2.0,
});

const NOISE_SEED = "vehicle-hellcat-audio";
const EPS_GAIN = 1e-4;
const EPS_HZ = 0.05;

const MODE_PARKED = 0;
const MODE_FLIGHT = 2;
const MODE_CRASHED = 4;
const MODE_DERELICT = 5;

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const finOr = (v, def) => (typeof v === "number" && Number.isFinite(v) ? v : def);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clampN = (v, lo, hi) => (!fin(v) ? lo : v < lo ? lo : v > hi ? hi : v);
const smooth01 = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/** `?vehicleAudio=off` (exact) disables vehicle synthesis. */
export function vehicleAudioEnabled(search) {
  try {
    return new URLSearchParams(search || "").get("vehicleAudio") !== "off";
  } catch (_) {
    return true;
  }
}

/** Read either `[x, y, z]` array-like or `{x, y, z}` object into `[x, y, z]`, or `null`. */
function readVec3(p) {
  if (!p || typeof p !== "object") return null;
  if (fin(p[0]) && fin(p[1]) && fin(p[2])) return [p[0] + 0, p[1] + 0, p[2] + 0];
  if (fin(p.x) && fin(p.y) && fin(p.z)) return [p.x + 0, p.y + 0, p.z + 0];
  return null;
}

/**
 * Convert AC world coordinates `(x east, y north, z up)` to Three.js / WebAudio
 * PannerNode coordinates `[x, z, -y + 0]` (never produces `-0`).
 * @param {ArrayLike<number>|{x:number,y:number,z:number}|null|undefined} pos
 * @returns {[number, number, number]|null}
 */
export function acToThreePos(pos) {
  const v = readVec3(pos);
  if (!v) return null;
  return [v[0] + 0, v[2] + 0, -v[1] + 0];
}

/**
 * Convert Three.js / WebAudio coordinates `(x east, y up, -z north)` back to AC
 * world coordinates `[x, -z + 0, y]` (never produces `-0`).
 * @param {ArrayLike<number>|{x:number,y:number,z:number}|null|undefined} pos
 * @returns {[number, number, number]|null}
 */
export function threeToAcPos(pos) {
  const v = readVec3(pos);
  if (!v) return null;
  return [v[0] + 0, -v[2] + 0, v[1] + 0];
}

/**
 * Compute 3D radial Doppler pitch factor `343 / (343 - vRel)` where `vRel` is the
 * closing velocity along `listener - src`, clamped to `[-150, +150]`, with result
 * clamped to `[0.55, 1.75]`.
 * @param {ArrayLike<number>|{x:number,y:number,z:number}|null} srcPos
 * @param {ArrayLike<number>|{x:number,y:number,z:number}|null} srcVel
 * @param {ArrayLike<number>|{x:number,y:number,z:number}|null} listenerPos
 * @param {ArrayLike<number>|{x:number,y:number,z:number}|null} listenerVel
 * @returns {number}
 */
export function computeDoppler(srcPos, srcVel, listenerPos, listenerVel) {
  const T = HELLCAT_AUDIO_TUNING;
  const s = readVec3(srcPos);
  const l = readVec3(listenerPos);
  if (!s || !l) return 1;
  const dx = l[0] - s[0];
  const dy = l[1] - s[1];
  const dz = l[2] - s[2];
  const dist = Math.hypot(dx, dy, dz);
  if (!(dist > 1e-6)) return 1;
  const sv = readVec3(srcVel);
  const lv = readVec3(listenerVel);
  const rvx = (sv ? sv[0] : 0) - (lv ? lv[0] : 0);
  const rvy = (sv ? sv[1] : 0) - (lv ? lv[1] : 0);
  const rvz = (sv ? sv[2] : 0) - (lv ? lv[2] : 0);
  const rawVRel = (rvx * dx + rvy * dy + rvz * dz) / dist;
  const vRel = clamp(finOr(rawVRel, 0), -T.dopplerMaxRelVel, T.dopplerMaxRelVel);
  const d = T.speedOfSound / (T.speedOfSound - vRel);
  return clamp(d, T.dopplerMin, T.dopplerMax) + 0;
}

/** Compute pure engine/aero parameters into `out` (zero-alloc hot path). */
function computeHellcatInto(out, u, overrideRpm) {
  const T = HELLCAT_AUDIO_TUNING;
  const s = u && typeof u === "object" ? u : {};
  const thr = clamp(finOr(s.throttle, 0), 0, 1);
  const spd = clamp(finOr(s.speed, 0), 0, 180);
  const mode = s.mode === undefined ? MODE_FLIGHT : (fin(s.mode) ? Math.trunc(s.mode) : MODE_FLIGHT);
  const boost = Boolean(s.boost);
  const pitch = clamp(finOr(s.pitch, 0), -Math.PI * 0.5, Math.PI * 0.5);
  const bank = clamp(finOr(s.bank, 0), -Math.PI, Math.PI);
  const vMin = clamp(finOr(s.vMin, T.vMinDefault), 5, 90);
  const backPressure = Boolean(s.backPressure);
  const rawLevel = clamp(finOr(s.level, 1), 0, 1);
  const level = mode === MODE_CRASHED ? 0 : rawLevel;

  const airborne = mode !== MODE_PARKED && mode !== MODE_CRASHED;
  const gEff = fin(s.gLoad)
    ? clamp(s.gLoad, 0, 12)
    : (airborne ? 1 / Math.max(0.25, Math.cos(bank)) : 1);

  const thrRpm = T.rpmIdle + (T.rpmMilitary - T.rpmIdle) * Math.pow(thr, 0.78);
  const windmillRpm = airborne
    ? T.rpmIdle + T.windmillRpmSpan * clamp(spd / T.vMaxRef, 0, 1.15)
    : T.rpmIdle;
  let targetRpm = Math.max(thrRpm, windmillRpm);
  if (boost) {
    const boostAdd = (T.rpmWep - T.rpmMilitary) * (0.35 + 0.65 * thr);
    targetRpm = Math.max(targetRpm + boostAdd, airborne ? T.rpmMilitary + boostAdd * 0.5 : targetRpm + boostAdd);
  }
  const unloadRpm = airborne && !boost
    ? 18 * clamp((spd - T.vCruiseRef) / (T.windMaxSpeed - T.vCruiseRef), 0, 1)
    : 0;
  targetRpm = clamp(targetRpm + unloadRpm, T.rpmIdle, T.rpmOverspeed);

  const rpm = fin(overrideRpm) ? clamp(overrideRpm, T.rpmIdle * 0.5, T.rpmOverspeed) : targetRpm;
  const rpmNorm = clamp((rpm - T.rpmIdle) / (T.rpmWep - T.rpmIdle), 0, 1);
  const crankHz = rpm / 60;
  const fireHz = T.cylindersPerRow * crankHz;
  const propBpfHz = T.propBpfPerCrank * crankHz;

  // Transonic 3-blade Hamilton Standard prop-tip rasp/buzz
  const rpmBuzz = rpmNorm > T.tipBuzzRpmOnset
    ? smooth01((rpmNorm - T.tipBuzzRpmOnset) / (1 - T.tipBuzzRpmOnset))
    : 0;
  const diveBuzz = airborne && spd > T.tipBuzzDiveSpeed
    ? clamp((spd - T.tipBuzzDiveSpeed) / (T.windMaxSpeed - T.tipBuzzDiveSpeed), 0, 1)
      * (pitch < -0.1 ? 1.0 : 0.55)
      * clamp(rpmNorm / 0.45, 0, 1)
    : 0;
  const tipBuzzGain = level * T.tipBuzzMaxGain * clamp(rpmBuzz * 0.82 + diveBuzz * 0.45 + (boost ? 0.22 : 0), 0, 1);

  // Two-stage mechanical centrifugal supercharger whine
  const blowerHz = T.blowerMinHz + T.blowerSpanHz * rpmNorm + (boost ? T.blowerBoostStepHz : 0);
  const blowerGain = level * clamp(0.008 + 0.038 * Math.pow(rpmNorm, 1.25) + (boost ? 0.014 : 0), 0, T.blowerMaxGain);

  // Manifold waveshaper drive & collector lowpass
  const drive = T.driveMin + T.driveThrottleSpan * (0.45 * rpmNorm + 0.55 * thr) + (boost ? T.driveBoostAdd : 0);
  const radialCutoffHz = clamp(
    320 + 1920 * rpmNorm + 360 * thr + 1.8 * clamp(spd, 0, T.windMaxSpeed) + (boost ? 180 : 0),
    T.radialCutoffMinHz,
    T.radialCutoffMaxHz,
  );
  const radialGain = level * clamp(
    T.radialGainIdle + (T.radialGainMax - T.radialGainIdle) * (0.55 * rpmNorm + 0.45 * thr) + (boost ? 0.03 : 0),
    0,
    T.radialGainMax + 0.04,
  );

  // Full-envelope 0..115 m/s airspeed slipstream (no 40 m/s clamp!)
  const spdNorm = clamp(spd / T.windMaxSpeed, 0, 1);
  const windCutoffHz = T.windCutoffMinHz + (T.windCutoffMaxHz - T.windCutoffMinHz) * Math.pow(spdNorm, 0.9);
  const windGain = level * T.windMaxGain * (0.25 * spdNorm + 0.75 * spdNorm * spdNorm);

  // Gun-port / cowling aerodynamic dive howl (pitch < -0.18 and speed > 58)
  const divePitchAmt = pitch < T.divePitchOnset
    ? clamp((-pitch - (-T.divePitchOnset)) / 0.55, 0, 1)
    : 0;
  const diveSpeedAmt = spd > T.diveSpeedOnset
    ? clamp((spd - T.diveSpeedOnset) / (T.windMaxSpeed - T.diveSpeedOnset), 0, 1)
    : 0;
  const diveHowlHz = T.diveHowlMinHz + (T.diveHowlMaxHz - T.diveHowlMinHz) * clamp(0.65 * diveSpeedAmt + 0.35 * divePitchAmt, 0, 1);
  const diveHowlGain = airborne && divePitchAmt > 0 && diveSpeedAmt > 0
    ? level * T.diveHowlMaxGain * Math.pow(divePitchAmt, 0.75) * Math.pow(diveSpeedAmt, 0.85)
    : 0;

  // High-G & low-speed pre-stall airframe buffet + cockpit stall/envelope reed
  const gBuffet = gEff > T.buffetGOnset ? clamp((gEff - T.buffetGOnset) / 2.65, 0, 1) : 0;
  const inFreeFlight = mode === MODE_FLIGHT || mode === MODE_DERELICT;
  const stallBuffetCeil = vMin * T.buffetStallRatio;
  const lowSpdBuffet = inFreeFlight && spd > 0.5 && spd < stallBuffetCeil
    ? clamp((stallBuffetCeil - spd) / Math.max(2, vMin * 0.22), 0, 1)
    : 0;
  const buffetGain = level * T.buffetMaxGain * clamp(Math.max(gBuffet, lowSpdBuffet), 0, 1);

  const stallCeil = vMin * T.stallSpeedRatio;
  const preStallAmt = mode === MODE_FLIGHT && spd > 0.5 && spd < stallCeil
    ? clamp(0.35 + 0.65 * ((stallCeil - spd) / Math.max(1.5, vMin * 0.15)), 0, 1)
    : 0;
  const hornAmt = backPressure ? 1 : preStallAmt;
  const stallHornGain = level * T.stallHornMaxGain * hornAmt;

  out.rpm = rpm + 0;
  out.rpmNorm = rpmNorm + 0;
  out.crankHz = crankHz + 0;
  out.fireHz = fireHz + 0;
  out.propBpfHz = propBpfHz + 0;
  out.tipBuzzGain = tipBuzzGain + 0;
  out.blowerHz = blowerHz + 0;
  out.blowerGain = blowerGain + 0;
  out.drive = drive + 0;
  out.radialCutoffHz = radialCutoffHz + 0;
  out.radialGain = radialGain + 0;
  out.windCutoffHz = windCutoffHz + 0;
  out.windGain = windGain + 0;
  out.diveHowlHz = diveHowlHz + 0;
  out.diveHowlGain = diveHowlGain + 0;
  out.buffetGain = buffetGain + 0;
  out.stallHornGain = stallHornGain + 0;
  return out;
}

function emptyEngineParams() {
  return {
    rpm: 0, rpmNorm: 0, crankHz: 0, fireHz: 0, propBpfHz: 0, tipBuzzGain: 0,
    blowerHz: 0, blowerGain: 0, drive: 0, radialCutoffHz: 0, radialGain: 0,
    windCutoffHz: 0, windGain: 0, diveHowlHz: 0, diveHowlGain: 0,
    buffetGain: 0, stallHornGain: 0,
  };
}

/**
 * Pure acoustic transfer model for the F6F-5 Hellcat (P&W R-2800-10W + 3-blade prop).
 * Never throws; every returned field is guaranteed finite.
 *
 * @param {{
 *   throttle?: number, speed?: number, mode?: number, boost?: boolean,
 *   pitch?: number, bank?: number, gLoad?: number, vMin?: number,
 *   backPressure?: boolean, level?: number
 * }} [u]
 */
export function hellcatEngineParams(u = {}) {
  return computeHellcatInto(emptyEngineParams(), u, NaN);
}

/**
 * Compute speed-of-sound arrival delay (`Math.min(2.2, dist / 343)`) and distance/yield-scaled
 * shockwave, detonation crack, and rolling thunder gains out to `2500 m`.
 *
 * @param {ArrayLike<number>|{x:number,y:number,z:number}|null} at AC world impact position
 * @param {number} [lb=1000] Ordnance weight in pounds (e.g. 1000 or 2000)
 * @param {ArrayLike<number>|{x:number,y:number,z:number}|null} [listenerPos=null] AC world listener position
 */
export function explosionDelayAndGain(at, lb = 1000, listenerPos = null) {
  const T = HELLCAT_AUDIO_TUNING;
  const pAt = readVec3(at);
  const pLis = readVec3(listenerPos);
  const dist = pAt && pLis
    ? Math.hypot(pAt[0] - pLis[0], pAt[1] - pLis[1], pAt[2] - pLis[2])
    : 0;
  const massLb = fin(lb) && lb > 0 ? clamp(lb, 100, 10000) : 1000;
  const scale = Math.pow(massLb / 1000, 0.38);
  const delaySec = Math.min(T.explosionMaxDelaySec, dist / T.speedOfSound) + 0;
  if (dist > T.explosionMaxRangeM) {
    return {
      dist: dist + 0,
      delaySec,
      audible: false,
      gain: 0,
      shockGain: 0,
      crackGain: 0,
      rumbleGain: 0,
      durationSec: clamp(1.65 * scale, 0.8, 3.8) + 0,
      cutoffHz: 260,
    };
  }
  const normDist = clamp(dist / T.explosionMaxRangeM, 0, 1);
  const edge = 1 - normDist * normDist;
  const nearAtten = 1 / (1 + dist / (145 * scale));
  const crackAtten = 1 / (1 + dist / (95 * scale));
  const farRumbleAtten = 1 / (1 + dist / (430 * scale));
  const shockGain = clamp(0.54 * scale * nearAtten * edge, 0, 0.95) + 0;
  const crackGain = clamp(0.44 * scale * crackAtten * edge, 0, 0.88) + 0;
  const rumbleGain = clamp(0.40 * scale * farRumbleAtten * edge, 0, 0.82) + 0;
  const gain = Math.max(shockGain, crackGain, rumbleGain) + 0;
  const durationSec = clamp((1.65 + 0.55 * normDist) * scale, 0.8, 3.8) + 0;
  const cutoffHz = clamp(3800 / (1 + dist / 220), 260, 3800) + 0;
  return {
    dist: dist + 0,
    delaySec,
    audible: gain > 1e-4,
    gain,
    shockGain,
    crackGain,
    rumbleGain,
    durationSec,
    cutoffHz,
  };
}

// ---------------------------------------------------------------------------
// Shared deterministic caches (noise buffers, PeriodicWave, soft-tanh curve)
// ---------------------------------------------------------------------------

/** @type {Map<string, Float32Array>} `${sampleRate}:${len}` → deterministic white noise */
const _sharedNoiseArrays = new Map();
/** @type {WeakMap<object, Map<number, object>>} ctx → (len → AudioBuffer) */
const _sharedCtxBuffers = new WeakMap();
/** @type {WeakMap<object, object>} ctx → PeriodicWave */
const _sharedPeriodicWaves = new WeakMap();
/** @type {Float32Array|null} */
let _softTanhCurve = null;

function buildNoiseSamples(len, rngFn) {
  const rng = typeof rngFn === "function" ? rngFn : mulberry32(hashString(NOISE_SEED));
  const arr = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const r = Number(rng());
    arr[i] = Number.isFinite(r) ? r * 2 - 1 : 0;
  }
  return arr;
}

function getSharedNoiseSamples(sr, len) {
  const key = `${sr}:${len}`;
  let arr = _sharedNoiseArrays.get(key);
  if (!arr) {
    if (_sharedNoiseArrays.size >= 16) {
      const oldest = _sharedNoiseArrays.keys().next().value;
      _sharedNoiseArrays.delete(oldest);
    }
    arr = buildNoiseSamples(len, null);
    _sharedNoiseArrays.set(key, arr);
  }
  return arr;
}

function getSoftTanhCurve() {
  if (_softTanhCurve) return _softTanhCurve;
  const n = 257;
  const c = new Float32Array(n);
  const k = 2.2;
  const norm = Math.tanh(k) || 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  _softTanhCurve = c;
  return c;
}

/**
 * Twin-row 18-cylinder radial PeriodicWave:
 *   1, 2: crankshaft & two-throw master-rod imbalance
 *   4, 5: articulated-rod uneven twin-row lope
 *   9:    dominant 9-cylinders-per-revolution firing bark
 *   18:   exhaust port crack harmonic
 */
function getRadialPeriodicWave(ctx) {
  if (!ctx || typeof ctx.createPeriodicWave !== "function") return null;
  let wave = _sharedPeriodicWaves.get(ctx);
  if (wave) return wave;
  const real = new Float32Array(19);
  const imag = new Float32Array(19);
  imag[1] = 0.42;
  imag[2] = 0.30;
  imag[4] = 0.26;
  imag[5] = 0.34;
  imag[9] = 1.00;
  imag[18] = 0.48;
  wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  if (wave) _sharedPeriodicWaves.set(ctx, wave);
  return wave;
}

// ---------------------------------------------------------------------------
// Safe WebAudio parameter & node helpers (graceful on minimal test mocks)
// ---------------------------------------------------------------------------

function setParam(param, v) {
  if (!param) return;
  try { param.value = v; } catch (_) { /* read-only mock */ }
}

function setParamAt(param, v, t) {
  if (!param) return;
  try {
    if (typeof param.setValueAtTime === "function") param.setValueAtTime(v, t);
    else param.value = v;
  } catch (_) {
    setParam(param, v);
  }
}

function targetParam(param, v, t, tau) {
  if (!param) return;
  try {
    if (typeof param.setTargetAtTime === "function") param.setTargetAtTime(v, t, tau);
    else param.value = v;
  } catch (_) {
    setParam(param, v);
  }
}

function rampLinParam(param, v, tEnd, tStart) {
  if (!param) return;
  try {
    if (typeof param.linearRampToValueAtTime === "function") {
      param.linearRampToValueAtTime(v, tEnd);
      return;
    }
  } catch (_) { /* fallback below */ }
  targetParam(param, v, tStart, Math.max(0.004, (tEnd - tStart) * 0.35));
}

function rampExpParam(param, v, tEnd, tStart) {
  if (!param) return;
  const safe = Math.max(1e-4, v);
  try {
    if (typeof param.exponentialRampToValueAtTime === "function") {
      param.exponentialRampToValueAtTime(safe, tEnd);
      return;
    }
  } catch (_) { /* fallback below */ }
  targetParam(param, v, tStart, Math.max(0.004, (tEnd - tStart) * 0.3));
}

function cancelParam(param, t) {
  if (!param) return;
  try {
    if (typeof param.cancelScheduledValues === "function") param.cancelScheduledValues(t);
  } catch (_) {}
}

function writePannerThree(panner, tx, ty, tz) {
  if (!panner) return;
  if (panner.positionX && typeof panner.positionX === "object") {
    setParam(panner.positionX, tx);
    setParam(panner.positionY, ty);
    setParam(panner.positionZ, tz);
  } else if (typeof panner.setPosition === "function") {
    try { panner.setPosition(tx, ty, tz); } catch (_) {}
  }
}

function configureHrtfPanner(panner, refDistance, rolloffFactor, maxDistance) {
  if (!panner) return;
  try {
    panner.panningModel = "HRTF";
    panner.distanceModel = "exponential";
    panner.refDistance = refDistance;
    panner.rolloffFactor = rolloffFactor;
    panner.maxDistance = maxDistance;
  } catch (_) {}
}

function connectSafe(from, to) {
  if (!from || !to || typeof from.connect !== "function") return false;
  try {
    from.connect(to);
    return true;
  } catch (_) {
    return false;
  }
}

function makeFilter(ctx, nodes, type, freqHz, q = 1, gainDb = 0) {
  if (typeof ctx.createBiquadFilter !== "function") return null;
  const f = ctx.createBiquadFilter();
  nodes.push(f);
  try { f.type = type; } catch (_) {}
  setParam(f.frequency, freqHz);
  setParam(f.Q, q);
  if (gainDb !== 0) setParam(f.gain, gainDb);
  return f;
}

function connectChain(list) {
  let prev = null;
  for (const n of list) {
    if (!n) continue;
    if (prev) connectSafe(prev, n);
    prev = n;
  }
  return prev;
}

// ---------------------------------------------------------------------------
// Coordinator: createVehicleAudio
// ---------------------------------------------------------------------------

/**
 * Create the complete F6F Hellcat WebAudio coordinator:
 * pilot continuous synth + 3D observer Doppler flyby pool + freefall wind + 10 one-shot FX.
 *
 * @param {{
 *   bus?: ({ctx: object, node: object, sliderGain?: () => number, isActive?: () => boolean}|(() => object|null)|null),
 *   audioManager?: {getEffectBus?: () => object|null, isActive?: () => boolean, getListenerAc?: () => object|null}|null,
 *   liveScene3d?: {audioManager?: object}|null,
 *   isActive?: () => boolean,
 *   enabled?: boolean,
 *   volume?: () => number,
 *   maxObserverVoices?: number,
 *   maxOneShots?: number,
 *   rng?: () => number,
 *   clock?: () => number,
 * }} [opts]
 */
export function createVehicleAudio(opts = {}) {
  const d = opts && typeof opts === "object" ? opts : {};
  const enabled = d.enabled !== false;
  const T = HELLCAT_AUDIO_TUNING;
  const maxObserverVoices = fin(d.maxObserverVoices) && d.maxObserverVoices >= 0
    ? Math.trunc(d.maxObserverVoices)
    : T.maxObserverVoices;
  const maxOneShots = fin(d.maxOneShots) && d.maxOneShots >= 1
    ? Math.trunc(d.maxOneShots)
    : T.maxOneShots;

  const hasBusSource = typeof d.bus === "function"
    || Boolean(d.bus && typeof d.bus === "object")
    || Boolean(d.audioManager && typeof d.audioManager === "object")
    || Boolean(d.liveScene3d && typeof d.liveScene3d === "object");
  const busIsGetter = typeof d.bus === "function"
    || (!d.bus && Boolean(d.audioManager || d.liveScene3d));

  const clock = typeof d.clock === "function"
    ? d.clock
    : () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() / 1000 : 0);

  let disposed = false;
  let pilotStarted = false;
  let pilotGraph = null;
  let lastNullBusAt = -Infinity;

  /** @type {Map<string, Float32Array>|null} instance-local noise cache when custom `opts.rng` is supplied */
  const localNoiseArrays = typeof d.rng === "function" ? new Map() : null;
  /** @type {WeakMap<object, Map<number, object>>|null} */
  const localCtxBuffers = typeof d.rng === "function" ? new WeakMap() : null;

  /** @type {Map<number|string, object>} id → observer voice */
  const observerVoices = new Map();
  let fallStarted = false;
  let fallGraph = null;
  /** @type {Set<object>} active transient one-shot voices */
  const activeOneShots = new Set();

  let hasHitBefore = false;
  let lastHitAudioAt = -Infinity;
  let lastHitWallAt = -Infinity;

  const P = emptyEngineParams();
  const obsP = emptyEngineParams();

  function rawResolveBus() {
    let b = null;
    if (typeof d.bus === "function") {
      try { b = d.bus(); } catch (_) { b = null; }
    } else if (d.bus && typeof d.bus === "object") {
      b = d.bus;
    } else {
      const am = d.audioManager ?? d.liveScene3d?.audioManager ?? null;
      if (am && typeof am.getEffectBus === "function") {
        try { b = am.getEffectBus(); } catch (_) { b = null; }
      }
    }
    if (!b || typeof b !== "object" || !b.ctx || typeof b.ctx !== "object" || !b.node) return null;
    return b;
  }

  /** Resolve bus, throttling retries to <= 1 Hz while the context is still uncreated. */
  function resolveBusLazy(forceNow = false) {
    if (!hasBusSource || disposed || !enabled) return null;
    if (!forceNow && lastNullBusAt > -Infinity) {
      const now = clock();
      if (now - lastNullBusAt < 1) return null;
    }
    const b = rawResolveBus();
    if (!b) {
      lastNullBusAt = clock();
      return null;
    }
    lastNullBusAt = -Infinity;
    return b;
  }

  /** Resolve bus for discrete event one-shots without delaying the 1 Hz frame retry clock. */
  function resolveBusEvent() {
    if (!hasBusSource || disposed || !enabled) return null;
    const b = rawResolveBus();
    if (b) lastNullBusAt = -Infinity;
    return b;
  }

  function resumeCtx(ctx) {
    if (!ctx || ctx.state !== "suspended" || typeof ctx.resume !== "function") return;
    try {
      const p = ctx.resume();
      if (p && typeof p.then === "function") p.then(undefined, () => {});
    } catch (_) { /* resumes on later user gesture */ }
  }

  function readVolume() {
    if (typeof d.volume !== "function") return 1;
    let v;
    try { v = Number(d.volume()); } catch (_) { return 0; }
    return fin(v) ? clamp(v, 0, 1) : 0;
  }

  function readSlider(bus) {
    if (!bus || typeof bus.sliderGain !== "function") return 1;
    let v;
    try { v = Number(bus.sliderGain()); } catch (_) { return 1; }
    return fin(v) ? clamp(v, 0, 1) : 1;
  }

  function isClientActive(bus) {
    if (typeof d.isActive === "function") {
      try { if (!d.isActive()) return false; } catch (_) {}
    }
    const am = d.audioManager ?? d.liveScene3d?.audioManager ?? null;
    if (am && typeof am.isActive === "function") {
      try { if (!am.isActive()) return false; } catch (_) {}
    }
    if (bus && typeof bus.isActive === "function") {
      try { if (!bus.isActive()) return false; } catch (_) {}
    }
    return true;
  }

  function masterGainScale(bus) {
    if (!isClientActive(bus)) return 0;
    return readVolume() * readSlider(bus);
  }

  function getNoiseBuffer(ctx, sec = T.noiseSec) {
    if (!ctx || typeof ctx.createBuffer !== "function") return null;
    const sr = fin(ctx.sampleRate) && ctx.sampleRate > 0 ? Math.round(ctx.sampleRate) : 48000;
    const len = Math.max(1, Math.round(sr * sec));
    const bufMapStore = localCtxBuffers || _sharedCtxBuffers;
    let byLen = bufMapStore.get(ctx);
    if (byLen && byLen.has(len)) return byLen.get(len);
    let samples;
    if (localNoiseArrays) {
      const key = `${sr}:${len}`;
      samples = localNoiseArrays.get(key);
      if (!samples) {
        samples = buildNoiseSamples(len, d.rng);
        localNoiseArrays.set(key, samples);
      }
    } else {
      samples = getSharedNoiseSamples(sr, len);
    }
    const buf = ctx.createBuffer(1, len, sr);
    try { buf.getChannelData(0).set(samples); } catch (_) {}
    if (!byLen) {
      byLen = new Map();
      bufMapStore.set(ctx, byLen);
    }
    byLen.set(len, buf);
    return buf;
  }

  function makeLoopNoiseSource(ctx, nodes, sources, sec = T.noiseSec) {
    if (typeof ctx.createBufferSource !== "function") return null;
    const buf = getNoiseBuffer(ctx, sec);
    if (!buf) return null;
    const src = ctx.createBufferSource();
    nodes.push(src);
    sources.push(src);
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  function teardownVoiceGraph(g) {
    if (!g || g.dead) return;
    g.dead = true;
    for (const src of g.sources) {
      try { src.onended = null; } catch (_) {}
      try { if (!g.endedByClock) src.stop(); } catch (_) {}
    }
    for (const n of g.nodes) {
      try { n.disconnect(); } catch (_) {}
    }
    if (pilotGraph === g) pilotGraph = null;
    if (fallGraph === g) fallGraph = null;
  }

  // -------------------------------------------------------------------------
  // 1. Pilot Continuous Synth
  // -------------------------------------------------------------------------

  function buildPilotGraph(bus) {
    const ctx = bus.ctx;
    if (typeof ctx.createGain !== "function" || typeof ctx.createOscillator !== "function" || typeof ctx.createPanner !== "function") {
      return false;
    }
    const nodes = [];
    const sources = [];
    try {
      const t = fin(ctx.currentTime) ? ctx.currentTime : 0;
      computeHellcatInto(P, { throttle: 0, speed: 0, mode: MODE_PARKED, level: 0 }, T.rpmIdle);

      const makeGain = (v = 1) => {
        const gn = ctx.createGain();
        nodes.push(gn);
        setParam(gn.gain, v);
        return gn;
      };
      const makeOsc = (type, hz) => {
        const o = ctx.createOscillator();
        nodes.push(o);
        sources.push(o);
        try { o.type = type; } catch (_) {}
        setParam(o.frequency, hz);
        return o;
      };

      const aircraftMix = makeGain(0); // silent until first active update()

      // A. R-2800-10W Radial Exhaust: PeriodicWave (harmonics 1,2,4,5,9,18) + 4.5×crank sub → tanh drive → lowpass
      const radialOsc = makeOsc("sawtooth", P.crankHz);
      const pWave = getRadialPeriodicWave(ctx);
      if (pWave && typeof radialOsc.setPeriodicWave === "function") {
        try { radialOsc.setPeriodicWave(pWave); } catch (_) { radialOsc.type = "sawtooth"; }
      }
      const subOsc = makeOsc("triangle", 4.5 * P.crankHz);
      const subGain = makeGain(0.42);
      const driveGain = makeGain(P.drive * 0.55);
      let shaper = null;
      if (typeof ctx.createWaveShaper === "function") {
        try {
          shaper = ctx.createWaveShaper();
          nodes.push(shaper);
          shaper.curve = getSoftTanhCurve();
          shaper.oversample = "2x";
        } catch (_) { shaper = null; }
      }
      const radialLowpass = makeFilter(ctx, nodes, "lowpass", P.radialCutoffHz, 1.15);
      const radialGainNode = makeGain(0);
      connectSafe(subOsc, subGain);
      connectSafe(subGain, driveGain);
      connectSafe(radialOsc, driveGain);
      connectChain([driveGain, shaper, radialLowpass, radialGainNode, aircraftMix]);

      // B. Hamilton Standard 3-blade prop chop (propBpfHz AM noise) + sawtooth tip buzz (3×propBpfHz → highpass)
      const propNoise = makeLoopNoiseSource(ctx, nodes, sources);
      const propBandpass = makeFilter(ctx, nodes, "bandpass", 190, 1.35);
      const propChopMod = makeGain(0.55);
      const propChopGain = makeGain(0);
      const propLfo = makeOsc("sine", P.propBpfHz);
      const propLfoDepth = makeGain(0.45);
      if (propNoise) connectChain([propNoise, propBandpass, propChopMod, propChopGain, aircraftMix]);
      connectSafe(propLfo, propLfoDepth);
      if (propChopMod?.gain) connectSafe(propLfoDepth, propChopMod.gain);

      const tipBuzzOsc = makeOsc("sawtooth", 3 * P.propBpfHz);
      const tipHighpass = makeFilter(ctx, nodes, "highpass", 950, 0.9);
      const tipBuzzGainNode = makeGain(0);
      connectChain([tipBuzzOsc, tipHighpass, tipBuzzGainNode, aircraftMix]);

      // C. Two-stage centrifugal supercharger whine
      const blowerOsc = makeOsc("sine", P.blowerHz);
      const blowerGainNode = makeGain(0);
      connectChain([blowerOsc, blowerGainNode, aircraftMix]);

      // D. 0..115 m/s slipstream + high-Q steep-dive gun-port howl + 14 Hz high-G/stall airframe shudder
      const aeroNoise = makeLoopNoiseSource(ctx, nodes, sources);
      const windBandpass = makeFilter(ctx, nodes, "bandpass", P.windCutoffHz, 0.75);
      const windGainNode = makeGain(0);
      if (aeroNoise) connectChain([aeroNoise, windBandpass, windGainNode, aircraftMix]);

      const diveFilter = makeFilter(ctx, nodes, "bandpass", P.diveHowlHz, T.diveHowlQ);
      const diveOsc = makeOsc("sine", P.diveHowlHz);
      const diveToneGain = makeGain(0.32);
      const diveHowlGainNode = makeGain(0);
      if (aeroNoise && diveFilter) {
        connectSafe(aeroNoise, diveFilter);
        connectSafe(diveFilter, diveHowlGainNode);
      }
      connectChain([diveOsc, diveToneGain, diveHowlGainNode, aircraftMix]);

      const buffetLowpass = makeFilter(ctx, nodes, "lowpass", 95, 1.8);
      const buffetMod = makeGain(0.55);
      const buffetGainNode = makeGain(0);
      const buffetLfo = makeOsc("sine", T.buffetLfoHz);
      const buffetLfoDepth = makeGain(0.45);
      if (aeroNoise) connectChain([aeroNoise, buffetLowpass, buffetMod, buffetGainNode, aircraftMix]);
      connectSafe(buffetLfo, buffetLfoDepth);
      if (buffetMod?.gain) connectSafe(buffetLfoDepth, buffetMod.gain);

      // E. Perspective routing:
      //    cockpit (fpv === true): warm lowshelf + ~3.0 kHz canopy rolloff → earGain → earOut → bus.node
      //    chase / hood (fpv === false): ~7.8 kHz open-air bark → panGain → HRTF PannerNode → bus.node
      const earOut = makeGain(1);
      const earShelf = makeFilter(ctx, nodes, "lowshelf", T.cockpitLowShelfHz, 0.7, T.cockpitLowShelfDb);
      const earLowpass = makeFilter(ctx, nodes, "lowpass", T.cockpitCutoffHz, 0.65);
      const earGain = makeGain(0);
      connectChain([aircraftMix, earShelf, earLowpass, earGain, earOut, bus.node]);

      const panLowpass = makeFilter(ctx, nodes, "lowpass", T.externalCutoffHz, 0.65);
      const panGain = makeGain(1);
      const panner = ctx.createPanner();
      nodes.push(panner);
      configureHrtfPanner(panner, T.pilotRefDistance, T.pilotRolloffFactor, T.pilotMaxDistance);
      connectChain([aircraftMix, panLowpass, panGain, panner, bus.node]);

      // F. 8 Hz pulsed cockpit stall/envelope reed (880 / 1046 Hz, audible directly on earOut)
      const stallOscA = makeOsc("triangle", T.stallFreqAHz);
      const stallOscB = makeOsc("triangle", T.stallFreqBHz);
      const stallPulseMod = makeGain(0.5);
      const stallGainNode = makeGain(0);
      const stallLfo = makeOsc("square", T.stallPulseHz);
      const stallLfoDepth = makeGain(0.5);
      connectSafe(stallOscA, stallPulseMod);
      connectSafe(stallOscB, stallPulseMod);
      connectChain([stallPulseMod, stallGainNode, earOut]);
      connectSafe(stallLfo, stallLfoDepth);
      if (stallPulseMod?.gain) connectSafe(stallLfoDepth, stallPulseMod.gain);

      for (const src of sources) src.start(t);

      pilotGraph = {
        ctx,
        bus,
        nodes,
        sources,
        aircraftMix,
        earOut,
        earGain,
        panGain,
        panner,
        earLowpass,
        panLowpass,
        radialOsc,
        subOsc,
        driveGain,
        shaper,
        radialLowpass,
        radialGainNode,
        propBandpass,
        propChopGain,
        propLfo,
        tipBuzzOsc,
        tipBuzzGainNode,
        blowerOsc,
        blowerGainNode,
        windBandpass,
        windGainNode,
        diveFilter,
        diveOsc,
        diveHowlGainNode,
        buffetGainNode,
        stallGainNode,
        stopping: false,
        dead: false,
        endedByClock: false,
        spooledRpm: null,
        lastAudioTime: t,
        lastClockTime: clock(),
        last: {
          mix: NaN, crankHz: NaN, subHz: NaN, drive: NaN, radialCut: NaN, radialGain: NaN,
          propBpf: NaN, propBand: NaN, propChop: NaN, tipHz: NaN, tipGain: NaN,
          blowerHz: NaN, blowerGain: NaN, windCut: NaN, windGain: NaN,
          diveHz: NaN, diveGain: NaN, buffetGain: NaN, stallGain: NaN,
          fpv: null, tx: NaN, ty: NaN, tz: NaN,
        },
      };
      return true;
    } catch (_) {
      teardownVoiceGraph({ nodes, sources, dead: false });
      return false;
    }
  }

  function start() {
    if (disposed || !enabled || !hasBusSource) return false;
    if (pilotGraph && !pilotGraph.stopping && !pilotGraph.dead) {
      pilotStarted = true;
      return true;
    }
    if (pilotGraph) teardownVoiceGraph(pilotGraph);
    const bus = resolveBusLazy(true);
    if (!bus) {
      pilotStarted = busIsGetter;
      return false;
    }
    pilotStarted = true;
    resumeCtx(bus.ctx);
    return buildPilotGraph(bus);
  }

  function update(u) {
    if (!pilotStarted || disposed || !enabled) return;
    let g = pilotGraph;
    if (!g) {
      if (!busIsGetter) return;
      const bus = resolveBusLazy(false);
      if (!bus || !buildPilotGraph(bus)) return;
      resumeCtx(bus.ctx);
      g = pilotGraph;
    }
    if (!g || g.stopping || g.dead || !u || typeof u !== "object") return;

    const t = fin(g.ctx.currentTime) ? g.ctx.currentTime : 0;
    const now = clock();
    computeHellcatInto(P, u, NaN);
    const targetRpm = P.rpm;

    if (g.spooledRpm === null) {
      g.spooledRpm = targetRpm;
    } else {
      let dt;
      if (fin(u.dt) && u.dt >= 0) dt = Math.min(u.dt, 2);
      else if (t > g.lastAudioTime) dt = Math.min(t - g.lastAudioTime, 2);
      else if (now > g.lastClockTime) dt = Math.min(now - g.lastClockTime, 2);
      else dt = 1 / 60;
      if (dt > 0 && Math.abs(targetRpm - g.spooledRpm) > 1e-4) {
        const tau = targetRpm >= g.spooledRpm ? T.tauUp : T.tauDown;
        g.spooledRpm += (targetRpm - g.spooledRpm) * (1 - Math.exp(-dt / tau));
      }
    }
    g.lastAudioTime = t;
    g.lastClockTime = now;

    computeHellcatInto(P, u, g.spooledRpm);
    const scale = masterGainScale(g.bus);
    const L = g.last;
    const tau = T.paramTau;

    if (!(Math.abs(scale - L.mix) <= EPS_GAIN)) {
      L.mix = scale;
      targetParam(g.aircraftMix.gain, scale, t, tau);
    }
    if (!(Math.abs(P.crankHz - L.crankHz) <= EPS_HZ)) {
      L.crankHz = P.crankHz;
      targetParam(g.radialOsc.frequency, P.crankHz, t, tau);
    }
    const subHz = 4.5 * P.crankHz;
    if (!(Math.abs(subHz - L.subHz) <= EPS_HZ)) {
      L.subHz = subHz;
      targetParam(g.subOsc.frequency, subHz, t, tau);
    }
    const driveGainVal = P.drive * 0.55;
    if (!(Math.abs(driveGainVal - L.drive) <= EPS_GAIN)) {
      L.drive = driveGainVal;
      targetParam(g.driveGain.gain, driveGainVal, t, tau);
    }
    if (g.radialLowpass && !(Math.abs(P.radialCutoffHz - L.radialCut) <= 0.5)) {
      L.radialCut = P.radialCutoffHz;
      targetParam(g.radialLowpass.frequency, P.radialCutoffHz, t, tau);
    }
    if (!(Math.abs(P.radialGain - L.radialGain) <= EPS_GAIN)) {
      L.radialGain = P.radialGain;
      targetParam(g.radialGainNode.gain, P.radialGain, t, tau);
    }

    if (!(Math.abs(P.propBpfHz - L.propBpf) <= EPS_HZ)) {
      L.propBpf = P.propBpfHz;
      targetParam(g.propLfo.frequency, P.propBpfHz, t, tau);
    }
    const propBandHz = 160 + 220 * P.rpmNorm;
    if (g.propBandpass && !(Math.abs(propBandHz - L.propBand) <= 0.5)) {
      L.propBand = propBandHz;
      targetParam(g.propBandpass.frequency, propBandHz, t, tau);
    }
    const rawLevel = clamp(finOr(u.level, 1), 0, 1);
    const mode = u.mode === undefined ? MODE_FLIGHT : (fin(u.mode) ? Math.trunc(u.mode) : MODE_FLIGHT);
    const effLevel = mode === MODE_CRASHED ? 0 : rawLevel;
    const propChopVal = effLevel * (T.propChopBaseGain + (T.propChopMaxGain - T.propChopBaseGain) * P.rpmNorm);
    if (!(Math.abs(propChopVal - L.propChop) <= EPS_GAIN)) {
      L.propChop = propChopVal;
      targetParam(g.propChopGain.gain, propChopVal, t, tau);
    }
    const tipHz = 3 * P.propBpfHz;
    if (!(Math.abs(tipHz - L.tipHz) <= EPS_HZ)) {
      L.tipHz = tipHz;
      targetParam(g.tipBuzzOsc.frequency, tipHz, t, tau);
    }
    if (!(Math.abs(P.tipBuzzGain - L.tipGain) <= EPS_GAIN)) {
      L.tipGain = P.tipBuzzGain;
      targetParam(g.tipBuzzGainNode.gain, P.tipBuzzGain, t, tau);
    }

    if (!(Math.abs(P.blowerHz - L.blowerHz) <= 0.5)) {
      L.blowerHz = P.blowerHz;
      targetParam(g.blowerOsc.frequency, P.blowerHz, t, tau);
    }
    if (!(Math.abs(P.blowerGain - L.blowerGain) <= EPS_GAIN)) {
      L.blowerGain = P.blowerGain;
      targetParam(g.blowerGainNode.gain, P.blowerGain, t, tau);
    }

    if (g.windBandpass && !(Math.abs(P.windCutoffHz - L.windCut) <= 0.5)) {
      L.windCut = P.windCutoffHz;
      targetParam(g.windBandpass.frequency, P.windCutoffHz, t, tau);
    }
    if (!(Math.abs(P.windGain - L.windGain) <= EPS_GAIN)) {
      L.windGain = P.windGain;
      targetParam(g.windGainNode.gain, P.windGain, t, tau);
    }

    if (!(Math.abs(P.diveHowlHz - L.diveHz) <= 0.5)) {
      L.diveHz = P.diveHowlHz;
      if (g.diveFilter) targetParam(g.diveFilter.frequency, P.diveHowlHz, t, tau);
      targetParam(g.diveOsc.frequency, P.diveHowlHz, t, tau);
    }
    if (!(Math.abs(P.diveHowlGain - L.diveGain) <= EPS_GAIN)) {
      L.diveGain = P.diveHowlGain;
      targetParam(g.diveHowlGainNode.gain, P.diveHowlGain, t, tau);
    }

    if (!(Math.abs(P.buffetGain - L.buffetGain) <= EPS_GAIN)) {
      L.buffetGain = P.buffetGain;
      targetParam(g.buffetGainNode.gain, P.buffetGain, t, tau);
    }
    const stallOutGain = P.stallHornGain * scale;
    if (!(Math.abs(stallOutGain - L.stallGain) <= EPS_GAIN)) {
      L.stallGain = stallOutGain;
      targetParam(g.stallGainNode.gain, stallOutGain, t, tau);
    }

    const fpv = u.fpv === true || (u.fpv === undefined && u.view === "cockpit");
    if (fpv !== L.fpv) {
      L.fpv = fpv;
      targetParam(g.earGain.gain, fpv ? 1 : 0, t, T.earTau);
      targetParam(g.panGain.gain, fpv ? 0 : 1, t, T.earTau);
    }

    const three = acToThreePos(u.pos);
    if (three) {
      const [tx, ty, tz] = three;
      if (tx !== L.tx || ty !== L.ty || tz !== L.tz) {
        L.tx = tx;
        L.ty = ty;
        L.tz = tz;
        writePannerThree(g.panner, tx, ty, tz);
      }
    }
  }

  function stop(stopOpts) {
    pilotStarted = false;
    const g = pilotGraph;
    if (!g || g.stopping || g.dead) return;
    g.stopping = true;
    const raw = stopOpts && typeof stopOpts === "object" ? stopOpts.fadeSec : undefined;
    const fade = fin(raw) ? clamp(raw, 0, 10) : 0.5;
    if (fade <= 0) {
      teardownVoiceGraph(g);
      return;
    }
    const t = fin(g.ctx.currentTime) ? g.ctx.currentTime : 0;
    cancelParam(g.aircraftMix.gain, t);
    cancelParam(g.earOut.gain, t);
    targetParam(g.aircraftMix.gain, 0, t, fade / 5);
    targetParam(g.earOut.gain, 0, t, fade / 5);
    const done = () => {
      g.endedByClock = true;
      teardownVoiceGraph(g);
    };
    for (const src of g.sources) {
      try { src.stop(t + fade); } catch (_) {}
    }
    try { g.radialOsc.onended = done; } catch (_) {}
  }

  function isStarted() {
    return pilotStarted && !disposed;
  }

  function isLive() {
    return Boolean(pilotGraph && !pilotGraph.stopping && !pilotGraph.dead && !disposed);
  }

  // -------------------------------------------------------------------------
  // 2. Observer 3D Doppler Flyby Pool
  // -------------------------------------------------------------------------

  function buildObserverVoice(bus, tx, ty, tz) {
    const ctx = bus.ctx;
    if (typeof ctx.createGain !== "function" || typeof ctx.createOscillator !== "function" || typeof ctx.createPanner !== "function") {
      return null;
    }
    const nodes = [];
    const sources = [];
    try {
      const t = fin(ctx.currentTime) ? ctx.currentTime : 0;
      const makeGain = (v = 1) => {
        const gn = ctx.createGain();
        nodes.push(gn);
        setParam(gn.gain, v);
        return gn;
      };
      const makeOsc = (type, hz) => {
        const o = ctx.createOscillator();
        nodes.push(o);
        sources.push(o);
        try { o.type = type; } catch (_) {}
        setParam(o.frequency, hz);
        return o;
      };

      const radialOsc = makeOsc("sawtooth", 30);
      const pWave = getRadialPeriodicWave(ctx);
      if (pWave && typeof radialOsc.setPeriodicWave === "function") {
        try { radialOsc.setPeriodicWave(pWave); } catch (_) { radialOsc.type = "sawtooth"; }
      }
      const radialGain = makeGain(0.28);

      const propOsc = makeOsc("sawtooth", 45);
      const propGain = makeGain(0.14);

      const blowerOsc = makeOsc("sine", 2400);
      const blowerGain = makeGain(0.03);

      const whooshNoise = makeLoopNoiseSource(ctx, nodes, sources);
      const whooshFilter = makeFilter(ctx, nodes, "bandpass", 500, 1.1);
      const whooshGain = makeGain(0);

      const atmoLowpass = makeFilter(ctx, nodes, "lowpass", 3500, 0.8);
      const voiceGain = makeGain(0);
      const panner = ctx.createPanner();
      nodes.push(panner);
      configureHrtfPanner(panner, T.observerRefDistance, T.observerRolloffFactor, T.observerMaxDistance);
      writePannerThree(panner, tx, ty, tz);

      const sumTarget = atmoLowpass || voiceGain;
      connectChain([radialOsc, radialGain, sumTarget]);
      connectChain([propOsc, propGain, sumTarget]);
      connectChain([blowerOsc, blowerGain, sumTarget]);
      if (whooshNoise) connectChain([whooshNoise, whooshFilter, whooshGain, sumTarget]);
      if (atmoLowpass) connectSafe(atmoLowpass, voiceGain);
      connectSafe(voiceGain, panner);
      connectSafe(panner, bus.node);

      for (const src of sources) src.start(t);

      return {
        ctx,
        bus,
        nodes,
        sources,
        radialOsc,
        radialGain,
        propOsc,
        propGain,
        blowerOsc,
        blowerGain,
        whooshFilter,
        whooshGain,
        atmoLowpass,
        voiceGain,
        panner,
        doppler: null,
        prevAcPos: null,
        dead: false,
        last: {
          crankHz: NaN, propHz: NaN, blowerHz: NaN, atmoHz: NaN,
          whooshHz: NaN, whooshGain: NaN, outGain: NaN,
          tx: tx, ty: ty, tz: tz,
        },
      };
    } catch (_) {
      teardownVoiceGraph({ nodes, sources, dead: false });
      return null;
    }
  }

  function releaseAllObservers() {
    for (const v of observerVoices.values()) teardownVoiceGraph(v);
    observerVoices.clear();
  }

  function extractObserverCandidate(item, idx, lp) {
    if (!item || typeof item !== "object") return null;
    if (item.piloted === true || item.isPilot === true || item.skip === true) return null;

    const pose = item.drawPose ?? item.pose ?? item.state ?? item.last ?? null;
    const pos = readVec3(item.pos) ?? readVec3(pose) ?? readVec3(item);
    if (!pos) return null;

    const dist = Math.hypot(pos[0] - lp[0], pos[1] - lp[1], pos[2] - lp[2]);
    if (!(dist <= T.observerRangeM)) return null;

    const rawMode = item.mode ?? pose?.mode ?? item.last?.mode;
    const mode = rawMode === undefined ? MODE_FLIGHT : (fin(rawMode) ? Math.trunc(rawMode) : MODE_FLIGHT);
    if (mode === MODE_CRASHED) return null;

    const explicitVel = readVec3(item.vel ?? item.velocity);
    const rawSpeed = item.speed ?? pose?.speed ?? item.last?.speed;
    const speed = fin(rawSpeed)
      ? Math.max(0, rawSpeed)
      : (explicitVel ? Math.hypot(explicitVel[0], explicitVel[1], explicitVel[2]) : 0);

    const rawThr = item.throttle ?? pose?.throttle;
    const hasExplicitThr = fin(rawThr);
    const inferredThr = mode === MODE_PARKED || mode === MODE_DERELICT
      ? 0
      : clamp((speed - T.vMinDefault) / (T.vCruiseRef - T.vMinDefault), 0.25, 1);
    const throttle = hasExplicitThr ? clamp(rawThr, 0, 1) : inferredThr;

    // Ignore silent parked aircraft (`mode === 0` and `throttle <= 0.05`)
    if (mode === MODE_PARKED && !(throttle > 0.05)) return null;

    const heading = item.heading ?? pose?.heading ?? item.last?.heading;
    const pitch = finOr(item.pitch ?? pose?.pitch ?? item.last?.pitch, 0);
    let vel = explicitVel;
    if (!vel && fin(heading) && speed > 0) {
      const h = speed * Math.cos(pitch);
      vel = [h * Math.sin(heading), h * Math.cos(heading), speed * Math.sin(pitch)];
    }

    const boost = typeof item.boost === "boolean" ? item.boost : speed > 92;
    const id = item.guid ?? item.id ?? item.key ?? idx;
    return { id, pos, vel, dist, mode, speed, throttle, pitch, boost };
  }

  function updateObservers(vehicles, listenerPos, listenerVel = null, dt = 1 / 60) {
    if (disposed || !enabled || maxObserverVoices <= 0) {
      if (observerVoices.size) releaseAllObservers();
      return;
    }
    const lp = readVec3(listenerPos);
    if (!lp || !vehicles || typeof vehicles[Symbol.iterator] !== "function") {
      if (observerVoices.size) releaseAllObservers();
      return;
    }

    const existingVoice = observerVoices.values().next().value;
    const bus = existingVoice ? (rawResolveBus() ?? existingVoice.bus) : resolveBusLazy(false);
    if (!bus) {
      if (observerVoices.size) releaseAllObservers();
      return;
    }

    const candidates = [];
    const iterable = vehicles instanceof Map ? vehicles.values() : vehicles;
    let idx = 0;
    for (const item of iterable) {
      const c = extractObserverCandidate(item, idx++, lp);
      if (c) candidates.push(c);
    }
    candidates.sort((a, b) => a.dist - b.dist);
    const chosen = candidates.length > maxObserverVoices
      ? candidates.slice(0, maxObserverVoices)
      : candidates;

    const keepIds = new Set(chosen.map((c) => c.id));
    for (const [id, voice] of observerVoices) {
      if (!keepIds.has(id) || voice.ctx !== bus.ctx) {
        teardownVoiceGraph(voice);
        observerVoices.delete(id);
      }
    }

    if (!chosen.length) return;

    const lv = readVec3(listenerVel) || [0, 0, 0];
    const effDt = fin(dt) && dt > 0 ? Math.min(dt, 1) : 1 / 60;
    const scale = masterGainScale(bus);
    const t = fin(bus.ctx.currentTime) ? bus.ctx.currentTime : 0;

    for (const c of chosen) {
      const three = acToThreePos(c.pos);
      if (!three) continue;
      let voice = observerVoices.get(c.id);
      if (!voice) {
        voice = buildObserverVoice(bus, three[0], three[1], three[2]);
        if (!voice) continue;
        observerVoices.set(c.id, voice);
      }

      let vel = c.vel;
      if (!vel && voice.prevAcPos && effDt > 1e-4) {
        vel = [
          (c.pos[0] - voice.prevAcPos[0]) / effDt,
          (c.pos[1] - voice.prevAcPos[1]) / effDt,
          (c.pos[2] - voice.prevAcPos[2]) / effDt,
        ];
      }
      voice.prevAcPos = c.pos;

      const rawD = computeDoppler(c.pos, vel, lp, lv);
      if (voice.doppler === null) {
        voice.doppler = rawD;
      } else {
        voice.doppler += (rawD - voice.doppler) * (1 - Math.exp(-effDt / T.dopplerTau));
      }
      const D = voice.doppler;

      computeHellcatInto(obsP, {
        throttle: c.throttle,
        speed: c.speed,
        mode: c.mode,
        boost: c.boost,
        pitch: c.pitch,
        level: 1,
      }, NaN);

      const crankHz = obsP.crankHz * D;
      const propHz = obsP.propBpfHz * D;
      const blowerHz = obsP.blowerHz * D;

      // Atmospheric & aspect filtering: brighter approaching (D > 1), darker receding (D < 1)
      const distFactor = 1 / (1 + c.dist / 380);
      const aspectMul = D >= 1
        ? 1 + 0.55 * (D - 1)
        : Math.max(0.45, 1 - 0.85 * (1 - D));
      const atmoHz = clamp((900 + 5200 * distFactor) * aspectMul, 350, 7800);

      // Closest-approach (< 65 m) propwash/wake whoosh
      let whooshLevel = 0;
      let whooshHz = 420 * D;
      if (c.dist < T.flybyWhooshRangeM) {
        const prox = 1 - c.dist / T.flybyWhooshRangeM;
        const spdFactor = clamp(c.speed / 75, 0.2, 1.35);
        whooshLevel = 0.34 * prox * prox * spdFactor;
        whooshHz = 420 * D + 380 * prox;
      }

      const rangeEdge = 1 - Math.pow(c.dist / T.observerRangeM, 2);
      const outGain = scale * clamp((obsP.radialGain * 2.1 + 0.08) * rangeEdge, 0, 0.95);

      const L = voice.last;
      if (!(Math.abs(crankHz - L.crankHz) <= EPS_HZ)) {
        L.crankHz = crankHz;
        targetParam(voice.radialOsc.frequency, crankHz, t, T.paramTau);
      }
      if (!(Math.abs(propHz - L.propHz) <= EPS_HZ)) {
        L.propHz = propHz;
        targetParam(voice.propOsc.frequency, propHz, t, T.paramTau);
      }
      if (!(Math.abs(blowerHz - L.blowerHz) <= 0.5)) {
        L.blowerHz = blowerHz;
        targetParam(voice.blowerOsc.frequency, blowerHz, t, T.paramTau);
      }
      if (voice.atmoLowpass && !(Math.abs(atmoHz - L.atmoHz) <= 1.0)) {
        L.atmoHz = atmoHz;
        targetParam(voice.atmoLowpass.frequency, atmoHz, t, T.paramTau);
      }
      if (voice.whooshFilter && !(Math.abs(whooshHz - L.whooshHz) <= 1.0)) {
        L.whooshHz = whooshHz;
        targetParam(voice.whooshFilter.frequency, whooshHz, t, T.paramTau);
      }
      if (!(Math.abs(whooshLevel - L.whooshGain) <= EPS_GAIN)) {
        L.whooshGain = whooshLevel;
        targetParam(voice.whooshGain.gain, whooshLevel, t, T.paramTau);
      }
      if (!(Math.abs(outGain - L.outGain) <= EPS_GAIN)) {
        L.outGain = outGain;
        targetParam(voice.voiceGain.gain, outGain, t, T.paramTau);
      }
      if (three[0] !== L.tx || three[1] !== L.ty || three[2] !== L.tz) {
        L.tx = three[0];
        L.ty = three[1];
        L.tz = three[2];
        writePannerThree(voice.panner, three[0], three[1], three[2]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Bailout & Freefall Wind
  // -------------------------------------------------------------------------

  function buildFallGraph(bus) {
    const ctx = bus.ctx;
    if (typeof ctx.createGain !== "function") return false;
    const nodes = [];
    const sources = [];
    try {
      const t = fin(ctx.currentTime) ? ctx.currentTime : 0;
      const noise = makeLoopNoiseSource(ctx, nodes, sources);
      if (!noise) return false;
      const bandpass = makeFilter(ctx, nodes, "bandpass", 950, 0.7);
      const gain = ctx.createGain();
      nodes.push(gain);
      setParam(gain.gain, 0);

      connectChain([noise, bandpass, gain, bus.node]);
      noise.start(t);

      fallGraph = {
        ctx,
        bus,
        nodes,
        sources,
        noise,
        bandpass,
        gain,
        stopping: false,
        dead: false,
        endedByClock: false,
        last: { gain: NaN, cutoff: NaN },
      };
      return true;
    } catch (_) {
      teardownVoiceGraph({ nodes, sources, dead: false });
      return false;
    }
  }

  function bailout(bOpts = {}) {
    if (disposed || !enabled) return false;
    fallStarted = true;
    if (fallGraph && (fallGraph.stopping || fallGraph.dead)) teardownVoiceGraph(fallGraph);
    const bus = resolveBusEvent();
    if (!bus) return false;
    resumeCtx(bus.ctx);
    if (!fallGraph) buildFallGraph(bus);

    // Canopy jettison bang + initial slipstream blast
    const pos = bOpts && typeof bOpts === "object" ? bOpts.pos : null;
    playOneShot(bus, { pos, mine: true, fpv: true, priority: 2, refDistance: 16 }, (ctx, out, t0, addNode, addSrc) => {
      const osc = ctx.createOscillator();
      addNode(osc);
      addSrc(osc, t0, t0 + 0.14);
      osc.type = "triangle";
      setParamAt(osc.frequency, 210, t0);
      rampExpParam(osc.frequency, 46, t0 + 0.12, t0);

      const bangGain = ctx.createGain();
      addNode(bangGain);
      setParamAt(bangGain.gain, 0.42, t0);
      rampExpParam(bangGain.gain, 0.001, t0 + 0.13, t0);
      connectChain([osc, bangGain, out]);

      const nSrc = makeOneShotNoise(ctx, addNode, addSrc, t0, t0 + 0.18);
      if (nSrc) {
        const bp = makeFilter(ctx, [], "bandpass", 1050, 1.0);
        if (bp) addNode(bp);
        const ng = ctx.createGain();
        addNode(ng);
        setParamAt(ng.gain, 0.34, t0);
        rampExpParam(ng.gain, 0.001, t0 + 0.17, t0);
        connectChain([nSrc, bp, ng, out]);
      }
      return t0 + 0.18;
    });
    return true;
  }

  function updateFall(u = {}) {
    if (disposed || !enabled) return;
    fallStarted = true;
    if (fallGraph && (fallGraph.stopping || fallGraph.dead)) teardownVoiceGraph(fallGraph);
    let g = fallGraph;
    if (!g) {
      const bus = resolveBusLazy(false);
      if (!bus || !buildFallGraph(bus)) return;
      resumeCtx(bus.ctx);
      g = fallGraph;
    }
    if (!g || g.stopping || g.dead) return;

    const s = u && typeof u === "object" ? u : {};
    const chute = Boolean(s.chute);
    const spd = clamp(finOr(s.speed, chute ? 6 : 25), 0, 120);
    let rawGain;
    let cutoffHz;
    if (chute) {
      // Gentle ~6 m/s breeze under open canopy
      const n = clamp(spd / 50, 0, 1);
      cutoffHz = clamp(240 + 620 * n, 240, 680);
      rawGain = T.fallMaxGain * clamp(0.055 + 0.18 * n, 0.04, 0.2);
    } else {
      // Freefall accelerating toward ~50 m/s terminal roar
      const n = clamp(spd / 50, 0, 1.25);
      cutoffHz = clamp(320 + 2450 * n, 300, 3400);
      rawGain = T.fallMaxGain * clamp(0.12 + 0.88 * Math.pow(clamp(spd / 50, 0, 1.15), 1.3), 0, 1.15);
    }

    const outGain = rawGain * masterGainScale(g.bus);
    const t = fin(g.ctx.currentTime) ? g.ctx.currentTime : 0;
    if (!(Math.abs(outGain - g.last.gain) <= EPS_GAIN)) {
      g.last.gain = outGain;
      targetParam(g.gain.gain, outGain, t, T.paramTau);
    }
    if (g.bandpass && !(Math.abs(cutoffHz - g.last.cutoff) <= 0.5)) {
      g.last.cutoff = cutoffHz;
      targetParam(g.bandpass.frequency, cutoffHz, t, T.paramTau);
    }
  }

  function stopFall(fOpts) {
    fallStarted = false;
    const g = fallGraph;
    if (!g || g.stopping || g.dead) return;
    g.stopping = true;
    const raw = fOpts && typeof fOpts === "object" ? fOpts.fadeSec : undefined;
    const fade = fin(raw) ? clamp(raw, 0, 10) : 0.35;
    if (fade <= 0) {
      teardownVoiceGraph(g);
      return;
    }
    const t = fin(g.ctx.currentTime) ? g.ctx.currentTime : 0;
    cancelParam(g.gain.gain, t);
    targetParam(g.gain.gain, 0, t, fade / 5);
    const done = () => {
      g.endedByClock = true;
      teardownVoiceGraph(g);
    };
    for (const src of g.sources) {
      try { src.stop(t + fade); } catch (_) {}
    }
    try { g.noise.onended = done; } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // 4. Procedural One-Shot FX (concurrency-capped at 14, zero setTimeout)
  // -------------------------------------------------------------------------

  function teardownShot(shot, fromOnEnded = false) {
    if (!shot || shot.dead) return;
    shot.dead = true;
    activeOneShots.delete(shot);
    for (const entry of shot.sources) {
      try { entry.src.onended = null; } catch (_) {}
      if (!fromOnEnded && !entry.ended) {
        try { entry.src.stop(); } catch (_) {}
      }
    }
    for (const n of shot.nodes) {
      try { n.disconnect(); } catch (_) {}
    }
  }

  function makeSpaceForPriority(priority) {
    if (activeOneShots.size < maxOneShots) return true;
    let victim = null;
    for (const s of activeOneShots) {
      if (s.priority <= priority) {
        victim = s;
        break; // Set preserves insertion order: first match is oldest
      }
    }
    if (!victim) return false;
    teardownShot(victim, false);
    return activeOneShots.size < maxOneShots;
  }

  function makeOneShotNoise(ctx, addNode, addSrc, startAt, stopAt) {
    if (typeof ctx.createBufferSource !== "function") return null;
    const buf = getNoiseBuffer(ctx, T.noiseSec);
    if (!buf) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    addNode(src);
    addSrc(src, startAt, stopAt);
    return src;
  }

  function playOneShot(busOverride, cfg, builder) {
    if (disposed || !enabled) return false;
    const bus = busOverride || resolveBusEvent();
    if (!bus) return false;
    const scale = masterGainScale(bus);
    if (!(scale > 0)) return false;

    const ctx = bus.ctx;
    if (typeof ctx.createGain !== "function") return false;
    const priority = cfg.priority ?? 1;
    if (!makeSpaceForPriority(priority)) return false;
    resumeCtx(ctx);

    const nodes = [];
    const sources = [];
    const addNode = (n) => {
      if (n) nodes.push(n);
      return n;
    };
    const addSrc = (src, startAt, stopAt) => {
      if (src) sources.push({ src, startAt, stopAt, ended: false });
      return src;
    };

    try {
      const t0 = fin(ctx.currentTime) ? ctx.currentTime : 0;
      const outGain = addNode(ctx.createGain());
      setParam(outGain.gain, scale * (cfg.gain ?? 1));

      const three = !(cfg.mine && cfg.fpv) ? acToThreePos(cfg.pos) : null;
      if (three && typeof ctx.createPanner === "function") {
        const panner = addNode(ctx.createPanner());
        configureHrtfPanner(
          panner,
          cfg.refDistance ?? (cfg.mine ? 20 : 14),
          cfg.rolloffFactor ?? 1.25,
          cfg.maxDistance ?? 1800,
        );
        writePannerThree(panner, three[0], three[1], three[2]);
        connectSafe(outGain, panner);
        connectSafe(panner, bus.node);
      } else {
        connectSafe(outGain, bus.node);
      }

      const endTime = builder(ctx, outGain, t0, addNode, addSrc) ?? (t0 + 0.1);
      if (!sources.length) {
        for (const n of nodes) { try { n.disconnect(); } catch (_) {} }
        return false;
      }

      const shot = { nodes, sources, priority, endTime, dead: false };
      activeOneShots.add(shot);

      let anchor = sources[0];
      for (const entry of sources) {
        if (entry.stopAt >= anchor.stopAt) anchor = entry;
      }

      for (const entry of sources) {
        entry.src.onended = () => {
          entry.ended = true;
          try { entry.src.disconnect(); } catch (_) {}
          if (entry === anchor || sources.every((e) => e.ended)) {
            teardownShot(shot, true);
          }
        };
        entry.src.start(entry.startAt);
        entry.src.stop(entry.stopAt);
      }
      return true;
    } catch (_) {
      for (const e of sources) { try { e.src.stop(); } catch (_e) {} }
      for (const n of nodes) { try { n.disconnect(); } catch (_e) {} }
      return false;
    }
  }

  /**
   * 6× .50 cal AN/M2 Browning salvo: 3 micro-staggered bursts (0, +28ms, +62ms)
   * for a continuous ~750 rpm rip-saw roar + chest thump + cockpit breech clatter.
   */
  function fireGun(gOpts = {}) {
    const o = gOpts && typeof gOpts === "object" ? gOpts : {};
    const mine = Boolean(o.mine);
    const fpv = Boolean(o.fpv);
    return playOneShot(null, { pos: o.pos, mine, fpv, priority: 1, gain: mine ? 0.9 : 0.78 }, (ctx, out, t0, addNode, addSrc) => {
      const offsets = [0, 0.028, 0.062];
      let latest = t0 + 0.12;
      for (let i = 0; i < offsets.length; i++) {
        const tb = t0 + offsets[i];
        const te = tb + 0.054;
        if (te > latest) latest = te;

        // .50 BMG muzzle blast crack
        const nSrc = makeOneShotNoise(ctx, addNode, addSrc, tb, te);
        if (nSrc) {
          const bp = makeFilter(ctx, [], "bandpass", 1080 - i * 65, 0.85);
          if (bp) addNode(bp);
          const bg = addNode(ctx.createGain());
          setParamAt(bg.gain, 0.001, tb);
          rampLinParam(bg.gain, 0.42, tb + 0.003, tb);
          rampExpParam(bg.gain, 0.001, te, tb + 0.003);
          connectChain([nSrc, bp, bg, out]);
        }

        // Low chest/wing-spar thump
        if (typeof ctx.createOscillator === "function") {
          const thump = addNode(ctx.createOscillator());
          addSrc(thump, tb, te);
          thump.type = "triangle";
          setParamAt(thump.frequency, 138 - i * 6, tb);
          rampExpParam(thump.frequency, 42, te, tb);
          const tg = addNode(ctx.createGain());
          setParamAt(tg.gain, mine ? 0.44 : 0.32, tb);
          rampExpParam(tg.gain, 0.001, te, tb);
          connectChain([thump, tg, out]);
        }
      }

      // Mechanical breech / link-chute clatter in cockpit / own ship
      if (mine || fpv) {
        const tcEnd = t0 + 0.125;
        if (tcEnd > latest) latest = tcEnd;
        const cSrc = makeOneShotNoise(ctx, addNode, addSrc, t0 + 0.005, tcEnd);
        if (cSrc) {
          const hp = makeFilter(ctx, [], "highpass", 2600, 1.1);
          if (hp) addNode(hp);
          const cg = addNode(ctx.createGain());
          setParamAt(cg.gain, fpv ? 0.22 : 0.10, t0 + 0.005);
          rampExpParam(cg.gain, 0.001, tcEnd, t0 + 0.005);
          connectChain([cSrc, hp, cg, out]);
        }
      }
      return latest;
    });
  }

  /** Crisp igniter snap + 0.55 s 5-inch HVAR rocket motor cordite whoosh. */
  function fireRocket(rOpts = {}) {
    const o = rOpts && typeof rOpts === "object" ? rOpts : {};
    const mine = Boolean(o.mine);
    const fpv = Boolean(o.fpv);
    return playOneShot(null, { pos: o.pos, mine, fpv, priority: 2, gain: 0.92 }, (ctx, out, t0, addNode, addSrc) => {
      // Igniter snap
      if (typeof ctx.createOscillator === "function") {
        const snap = addNode(ctx.createOscillator());
        addSrc(snap, t0, t0 + 0.038);
        snap.type = "square";
        setParamAt(snap.frequency, 660, t0);
        rampExpParam(snap.frequency, 170, t0 + 0.035, t0);
        const sg = addNode(ctx.createGain());
        setParamAt(sg.gain, 0.26, t0);
        rampExpParam(sg.gain, 0.001, t0 + 0.036, t0);
        connectChain([snap, sg, out]);
      }

      // 0.55 s 5-inch HVAR rocket motor whoosh
      const tEnd = t0 + 0.55;
      const nSrc = makeOneShotNoise(ctx, addNode, addSrc, t0, tEnd);
      if (nSrc) {
        const bp = makeFilter(ctx, [], "bandpass", 1450, 0.9);
        if (bp) {
          addNode(bp);
          setParamAt(bp.frequency, 1450, t0);
          rampExpParam(bp.frequency, 510, tEnd, t0);
        }
        const wg = addNode(ctx.createGain());
        setParamAt(wg.gain, 0.01, t0);
        rampLinParam(wg.gain, 0.50, t0 + 0.022, t0);
        rampExpParam(wg.gain, 0.001, tEnd, t0 + 0.022);
        connectChain([nSrc, bp, wg, out]);
      }
      return tEnd;
    });
  }

  /** Metallic bomb-shackle clunk + subtle initial falling-bomb whistle. */
  function bombRelease(bOpts = {}) {
    const o = bOpts && typeof bOpts === "object" ? bOpts : {};
    const mine = Boolean(o.mine);
    const fpv = Boolean(o.fpv);
    return playOneShot(null, { pos: o.pos, mine, fpv, priority: 2, gain: 0.85 }, (ctx, out, t0, addNode, addSrc) => {
      if (typeof ctx.createOscillator !== "function") return t0;
      // Shackle clunk
      const clunk = addNode(ctx.createOscillator());
      addSrc(clunk, t0, t0 + 0.11);
      clunk.type = "triangle";
      setParamAt(clunk.frequency, 310, t0);
      rampExpParam(clunk.frequency, 115, t0 + 0.10, t0);
      const cg = addNode(ctx.createGain());
      setParamAt(cg.gain, 0.42, t0);
      rampExpParam(cg.gain, 0.001, t0 + 0.105, t0);
      connectChain([clunk, cg, out]);

      const clickSrc = makeOneShotNoise(ctx, addNode, addSrc, t0, t0 + 0.045);
      if (clickSrc) {
        const bp = makeFilter(ctx, [], "bandpass", 1550, 1.8);
        if (bp) addNode(bp);
        const kg = addNode(ctx.createGain());
        setParamAt(kg.gain, 0.25, t0);
        rampExpParam(kg.gain, 0.001, t0 + 0.042, t0);
        connectChain([clickSrc, bp, kg, out]);
      }

      // Initial bomb fin whistle
      const tEnd = t0 + 0.48;
      const whistle = addNode(ctx.createOscillator());
      addSrc(whistle, t0 + 0.035, tEnd);
      whistle.type = "sine";
      setParamAt(whistle.frequency, 1320, t0 + 0.035);
      rampExpParam(whistle.frequency, 740, tEnd, t0 + 0.035);
      const wg = addNode(ctx.createGain());
      setParamAt(wg.gain, 0.001, t0 + 0.035);
      rampLinParam(wg.gain, 0.09, t0 + 0.13, t0 + 0.035);
      rampExpParam(wg.gain, 0.001, tEnd, t0 + 0.13);
      connectChain([whistle, wg, out]);
      return tEnd;
    });
  }

  /**
   * Speed-of-sound delayed sub-bass shockwave (58→20 Hz) + broadband detonation
   * crack & rolling thunder scaled for 1,000 lb vs 2,000 lb ordnance out to 2500 m.
   */
  function explosion(eOpts = {}) {
    const o = eOpts && typeof eOpts === "object" ? eOpts : {};
    const am = d.audioManager ?? d.liveScene3d?.audioManager ?? null;
    const lis = o.listenerPos !== undefined ? o.listenerPos : (am?.getListenerAc?.() ?? null);
    const E = explosionDelayAndGain(o.pos, o.lb ?? 1000, lis);
    if (!E.audible) return false;

    return playOneShot(
      null,
      { pos: o.pos, mine: false, fpv: false, priority: 3, refDistance: 40, rolloffFactor: 0.75, maxDistance: T.explosionMaxRangeM, gain: 1 },
      (ctx, out, t0, addNode, addSrc) => {
        const ts = t0 + E.delaySec;
        const tEnd = ts + E.durationSec;

        // 1. Sub-bass blast shockwave (58 → 20 Hz)
        if (typeof ctx.createOscillator === "function") {
          const shockDur = Math.min(E.durationSec, 0.78);
          const sub = addNode(ctx.createOscillator());
          addSrc(sub, ts, ts + shockDur);
          sub.type = "sine";
          setParamAt(sub.frequency, 58, ts);
          rampExpParam(sub.frequency, 20, ts + shockDur * 0.85, ts);
          const sg = addNode(ctx.createGain());
          if (E.delaySec > 0) setParamAt(sg.gain, 0, t0);
          setParamAt(sg.gain, E.shockGain, ts);
          rampExpParam(sg.gain, 0.001, ts + shockDur, ts + 0.02);
          connectChain([sub, sg, out]);
        }

        // 2. Broadband detonation crack
        if (E.crackGain > 1e-3) {
          const crackSrc = makeOneShotNoise(ctx, addNode, addSrc, ts, ts + 0.28);
          if (crackSrc) {
            const lp = makeFilter(ctx, [], "lowpass", E.cutoffHz, 0.9);
            if (lp) addNode(lp);
            const cg = addNode(ctx.createGain());
            if (E.delaySec > 0) setParamAt(cg.gain, 0, t0);
            setParamAt(cg.gain, E.crackGain, ts);
            rampExpParam(cg.gain, 0.001, ts + 0.27, ts + 0.008);
            connectChain([crackSrc, lp, cg, out]);
          }
        }

        // 3. Rolling thunder tail
        const rumbleSrc = makeOneShotNoise(ctx, addNode, addSrc, ts + 0.02, tEnd);
        if (rumbleSrc) {
          const rlp = makeFilter(ctx, [], "lowpass", 440, 1.1);
          if (rlp) {
            addNode(rlp);
            setParamAt(rlp.frequency, 440, ts + 0.02);
            rampExpParam(rlp.frequency, 92, tEnd, ts + 0.02);
          }
          const rg = addNode(ctx.createGain());
          setParamAt(rg.gain, 0.001, t0);
          setParamAt(rg.gain, 0.01, ts + 0.02);
          rampLinParam(rg.gain, E.rumbleGain, ts + 0.14, ts + 0.02);
          rampExpParam(rg.gain, 0.001, tEnd, ts + 0.14);
          connectChain([rumbleSrc, rlp, rg, out]);
        }
        return tEnd;
      },
    );
  }

  /** Rate-limited (>= 0.055 s) gun-camera / airframe duralumin hit confirmation thwack. */
  function hit(hOpts = {}) {
    if (disposed || !enabled) return false;
    const bus = resolveBusEvent();
    if (!bus) return false;
    const audioNow = fin(bus.ctx.currentTime) ? bus.ctx.currentTime : NaN;
    const wallNow = clock();
    if (hasHitBefore) {
      const audioOk = fin(audioNow) && (audioNow - lastHitAudioAt >= T.hitMinIntervalSec - 1e-9);
      const wallOk = fin(wallNow) && (wallNow - lastHitWallAt >= T.hitMinIntervalSec - 1e-9);
      if (!audioOk && !wallOk) return false;
    }

    const o = hOpts && typeof hOpts === "object" ? hOpts : {};
    const dmgScale = clamp(finOr(o.damage, 10) / 22, 0.45, 1.35);
    const ok = playOneShot(bus, { pos: null, mine: true, fpv: true, priority: 2, gain: 0.52 * dmgScale }, (ctx, out, t0, addNode, addSrc) => {
      if (typeof ctx.createOscillator !== "function") return t0;
      const thwack = addNode(ctx.createOscillator());
      addSrc(thwack, t0, t0 + 0.065);
      thwack.type = "triangle";
      setParamAt(thwack.frequency, 310, t0);
      rampExpParam(thwack.frequency, 76, t0 + 0.06, t0);
      const tg = addNode(ctx.createGain());
      setParamAt(tg.gain, 0.58, t0);
      rampExpParam(tg.gain, 0.001, t0 + 0.062, t0);
      connectChain([thwack, tg, out]);

      const tickSrc = makeOneShotNoise(ctx, addNode, addSrc, t0, t0 + 0.032);
      if (tickSrc) {
        const bp = makeFilter(ctx, [], "bandpass", 1900, 1.6);
        if (bp) addNode(bp);
        const kg = addNode(ctx.createGain());
        setParamAt(kg.gain, 0.34, t0);
        rampExpParam(kg.gain, 0.001, t0 + 0.03, t0);
        connectChain([tickSrc, bp, kg, out]);
      }
      return t0 + 0.065;
    });

    if (ok) {
      hasHitBefore = true;
      lastHitAudioAt = audioNow;
      lastHitWallAt = wallNow;
    }
    return ok;
  }

  /** Electric-hydraulic gear/flap motor whine + mechanical downlock/uplock thump. */
  function gear(gOpts = {}) {
    const o = gOpts && typeof gOpts === "object" ? gOpts : {};
    const deploying = o.deploying !== false;
    const mine = o.mine !== false;
    return playOneShot(null, { pos: o.pos, mine, fpv: mine && !o.pos, priority: 1, gain: 0.65 }, (ctx, out, t0, addNode, addSrc) => {
      if (typeof ctx.createOscillator !== "function") return t0;
      // Hydraulic actuator motor whine
      const motor = addNode(ctx.createOscillator());
      addSrc(motor, t0, t0 + 0.44);
      motor.type = "sawtooth";
      setParamAt(motor.frequency, deploying ? 690 : 530, t0);
      rampLinParam(motor.frequency, deploying ? 500 : 740, t0 + 0.43, t0);
      const bp = makeFilter(ctx, [], "bandpass", 720, 2.2);
      if (bp) addNode(bp);
      const mg = addNode(ctx.createGain());
      setParamAt(mg.gain, 0.01, t0);
      rampLinParam(mg.gain, 0.22, t0 + 0.04, t0);
      rampExpParam(mg.gain, 0.001, t0 + 0.44, t0 + 0.36);
      connectChain([motor, bp, mg, out]);

      // Mechanical downlock / uplock thump
      const lockAt = t0 + 0.42;
      const lockEnd = t0 + 0.52;
      const thump = addNode(ctx.createOscillator());
      addSrc(thump, lockAt, lockEnd);
      thump.type = "sine";
      setParamAt(thump.frequency, 132, lockAt);
      rampExpParam(thump.frequency, 44, lockEnd, lockAt);
      const lg = addNode(ctx.createGain());
      setParamAt(lg.gain, 0.001, t0);
      setParamAt(lg.gain, 0.46, lockAt);
      rampExpParam(lg.gain, 0.001, lockEnd, lockAt);
      connectChain([thump, lg, out]);
      return lockEnd;
    });
  }

  /** Tire chirp + oleo strut thud (aircraft) OR boot thud + silk collapse rustle (`chute: true`). */
  function touchdown(tOpts = {}) {
    const o = tOpts && typeof tOpts === "object" ? tOpts : {};
    const chute = Boolean(o.chute);
    const mine = o.mine !== false;
    const impact = clamp(finOr(o.speed, 3) / 10, 0.35, 1.4);

    return playOneShot(null, { pos: o.pos, mine, fpv: mine && !o.pos, priority: 2, gain: 0.78 * impact }, (ctx, out, t0, addNode, addSrc) => {
      if (typeof ctx.createOscillator !== "function") return t0;
      if (!chute) {
        // Tire chirp
        const chirpSrc = makeOneShotNoise(ctx, addNode, addSrc, t0, t0 + 0.13);
        if (chirpSrc) {
          const bp = makeFilter(ctx, [], "bandpass", 1580, 4.2);
          if (bp) {
            addNode(bp);
            setParamAt(bp.frequency, 1580, t0);
            rampExpParam(bp.frequency, 1080, t0 + 0.12, t0);
          }
          const cg = addNode(ctx.createGain());
          setParamAt(cg.gain, 0.38, t0);
          rampExpParam(cg.gain, 0.001, t0 + 0.125, t0);
          connectChain([chirpSrc, bp, cg, out]);
        }

        // Oleo strut compression thud
        const oleo = addNode(ctx.createOscillator());
        addSrc(oleo, t0 + 0.012, t0 + 0.24);
        oleo.type = "sine";
        setParamAt(oleo.frequency, 94, t0 + 0.012);
        rampExpParam(oleo.frequency, 33, t0 + 0.23, t0 + 0.012);
        const og = addNode(ctx.createGain());
        setParamAt(og.gain, 0.52, t0 + 0.012);
        rampExpParam(og.gain, 0.001, t0 + 0.235, t0 + 0.012);
        connectChain([oleo, og, out]);
        return t0 + 0.24;
      }

      // Paratrooper boot thud + silk canopy collapse rustle
      const boot = addNode(ctx.createOscillator());
      addSrc(boot, t0, t0 + 0.14);
      boot.type = "sine";
      setParamAt(boot.frequency, 106, t0);
      rampExpParam(boot.frequency, 38, t0 + 0.13, t0);
      const bg = addNode(ctx.createGain());
      setParamAt(bg.gain, 0.48, t0);
      rampExpParam(bg.gain, 0.001, t0 + 0.135, t0);
      connectChain([boot, bg, out]);

      const silkEnd = t0 + 0.56;
      const silk = makeOneShotNoise(ctx, addNode, addSrc, t0 + 0.05, silkEnd);
      if (silk) {
        const bp = makeFilter(ctx, [], "bandpass", 1850, 0.85);
        if (bp) {
          addNode(bp);
          setParamAt(bp.frequency, 1850, t0 + 0.05);
          rampExpParam(bp.frequency, 720, silkEnd, t0 + 0.05);
        }
        const sg = addNode(ctx.createGain());
        setParamAt(sg.gain, 0.001, t0);
        rampLinParam(sg.gain, 0.22, t0 + 0.14, t0 + 0.05);
        rampExpParam(sg.gain, 0.001, silkEnd, t0 + 0.14);
        connectChain([silk, bp, sg, out]);
      }
      return silkEnd;
    });
  }

  /** Canopy roller-rail slide + positive latch click. */
  function canopy(cOpts = {}) {
    const o = cOpts && typeof cOpts === "object" ? cOpts : {};
    const open = o.open !== false;
    const mine = o.mine !== false;
    return playOneShot(null, { pos: o.pos, mine, fpv: mine && !o.pos, priority: 1, gain: 0.62 }, (ctx, out, t0, addNode, addSrc) => {
      const slideStart = open ? t0 + 0.03 : t0;
      const slideEnd = slideStart + 0.32;
      const slideSrc = makeOneShotNoise(ctx, addNode, addSrc, slideStart, slideEnd);
      if (slideSrc) {
        const bp = makeFilter(ctx, [], "bandpass", open ? 920 : 1420, 2.3);
        if (bp) {
          addNode(bp);
          setParamAt(bp.frequency, open ? 920 : 1420, slideStart);
          rampLinParam(bp.frequency, open ? 1420 : 880, slideEnd, slideStart);
        }
        const sg = addNode(ctx.createGain());
        setParamAt(sg.gain, 0.01, slideStart);
        rampLinParam(sg.gain, 0.26, slideStart + 0.05, slideStart);
        rampExpParam(sg.gain, 0.001, slideEnd, slideStart + 0.22);
        connectChain([slideSrc, bp, sg, out]);
      }

      if (typeof ctx.createOscillator === "function") {
        const clickAt = open ? t0 : t0 + 0.31;
        const clickEnd = clickAt + 0.045;
        const latch = addNode(ctx.createOscillator());
        addSrc(latch, clickAt, clickEnd);
        latch.type = "triangle";
        setParamAt(latch.frequency, open ? 1680 : 1240, clickAt);
        rampExpParam(latch.frequency, open ? 620 : 420, clickEnd, clickAt);
        const lg = addNode(ctx.createGain());
        setParamAt(lg.gain, 0.001, t0);
        setParamAt(lg.gain, 0.36, clickAt);
        rampExpParam(lg.gain, 0.001, clickEnd, clickAt);
        connectChain([latch, lg, out]);
        return Math.max(slideEnd, clickEnd);
      }
      return slideEnd;
    });
  }

  /** Double metallic ammo-chute ratchet on ground rearm. */
  function rearm(rOpts = {}) {
    const o = rOpts && typeof rOpts === "object" ? rOpts : {};
    const mine = o.mine !== false;
    return playOneShot(null, { pos: o.pos, mine, fpv: mine && !o.pos, priority: 2, gain: 0.7 }, (ctx, out, t0, addNode, addSrc) => {
      if (typeof ctx.createOscillator !== "function") return t0;
      const steps = [
        { dt: 0, f0: 540, f1: 270 },
        { dt: 0.12, f0: 680, f1: 340 },
      ];
      let latest = t0 + 0.22;
      for (const st of steps) {
        const ts = t0 + st.dt;
        const te = ts + 0.075;
        if (te > latest) latest = te;

        const clack = addNode(ctx.createOscillator());
        addSrc(clack, ts, te);
        clack.type = "triangle";
        setParamAt(clack.frequency, st.f0, ts);
        rampExpParam(clack.frequency, st.f1, te, ts);
        const cg = addNode(ctx.createGain());
        setParamAt(cg.gain, 0.001, t0);
        setParamAt(cg.gain, 0.42, ts);
        rampExpParam(cg.gain, 0.001, te, ts);
        connectChain([clack, cg, out]);

        const nSrc = makeOneShotNoise(ctx, addNode, addSrc, ts, ts + 0.055);
        if (nSrc) {
          const hp = makeFilter(ctx, [], "highpass", 1850, 1.3);
          if (hp) addNode(hp);
          const ng = addNode(ctx.createGain());
          setParamAt(ng.gain, 0.001, t0);
          setParamAt(ng.gain, 0.28, ts);
          rampExpParam(ng.gain, 0.001, ts + 0.052, ts);
          connectChain([nSrc, hp, ng, out]);
        }
      }
      return latest;
    });
  }

  /** Crisp nylon/silk parachute canopy blossom whoomp-snap. */
  function chuteOpen(cOpts = {}) {
    const o = cOpts && typeof cOpts === "object" ? cOpts : {};
    const mine = o.mine !== false;
    return playOneShot(null, { pos: o.pos, mine, fpv: mine && !o.pos, priority: 2, gain: 0.84 }, (ctx, out, t0, addNode, addSrc) => {
      // Riser line snap
      const snapSrc = makeOneShotNoise(ctx, addNode, addSrc, t0, t0 + 0.065);
      if (snapSrc) {
        const bp = makeFilter(ctx, [], "bandpass", 1780, 1.5);
        if (bp) addNode(bp);
        const sg = addNode(ctx.createGain());
        setParamAt(sg.gain, 0.40, t0);
        rampExpParam(sg.gain, 0.001, t0 + 0.062, t0);
        connectChain([snapSrc, bp, sg, out]);
      }

      // Silk dome blossom whoomp
      const tEnd = t0 + 0.45;
      if (typeof ctx.createOscillator === "function") {
        const dome = addNode(ctx.createOscillator());
        addSrc(dome, t0 + 0.025, t0 + 0.34);
        dome.type = "sine";
        setParamAt(dome.frequency, 90, t0 + 0.025);
        rampExpParam(dome.frequency, 36, t0 + 0.33, t0 + 0.025);
        const dg = addNode(ctx.createGain());
        setParamAt(dg.gain, 0.001, t0);
        rampLinParam(dg.gain, 0.50, t0 + 0.08, t0 + 0.025);
        rampExpParam(dg.gain, 0.001, t0 + 0.335, t0 + 0.08);
        connectChain([dome, dg, out]);
      }

      const whoompSrc = makeOneShotNoise(ctx, addNode, addSrc, t0 + 0.02, tEnd);
      if (whoompSrc) {
        const lp = makeFilter(ctx, [], "lowpass", 520, 1.0);
        if (lp) {
          addNode(lp);
          setParamAt(lp.frequency, 520, t0 + 0.02);
          rampExpParam(lp.frequency, 185, tEnd, t0 + 0.02);
        }
        const wg = addNode(ctx.createGain());
        setParamAt(wg.gain, 0.001, t0);
        rampLinParam(wg.gain, 0.38, t0 + 0.11, t0 + 0.02);
        rampExpParam(wg.gain, 0.001, tEnd, t0 + 0.11);
        connectChain([whoompSrc, lp, wg, out]);
      }
      return tEnd;
    });
  }

  // -------------------------------------------------------------------------
  // 5. Synchronous Leak-Free Teardown & Diagnostics
  // -------------------------------------------------------------------------

  function dispose() {
    pilotStarted = false;
    fallStarted = false;
    if (pilotGraph) teardownVoiceGraph(pilotGraph);
    releaseAllObservers();
    if (fallGraph) teardownVoiceGraph(fallGraph);
    for (const shot of [...activeOneShots]) teardownShot(shot, false);
    activeOneShots.clear();
    disposed = true;
  }

  function stats() {
    let observerNodes = 0;
    for (const v of observerVoices.values()) observerNodes += v.nodes.length;
    let oneShotNodes = 0;
    for (const s of activeOneShots) oneShotNodes += s.nodes.length;
    const pilotNodes = pilotGraph ? pilotGraph.nodes.length : 0;
    const fallNodes = fallGraph ? fallGraph.nodes.length : 0;
    return {
      built: pilotGraph !== null,
      started: pilotStarted && !disposed,
      live: isLive(),
      nodes: pilotNodes,
      pilotNodes,
      observerVoices: observerVoices.size,
      observerNodes,
      fallBuilt: fallGraph !== null,
      fallStarted: fallStarted && !disposed,
      activeOneShots: activeOneShots.size,
      totalNodes: pilotNodes + observerNodes + fallNodes + oneShotNodes,
    };
  }

  return {
    start,
    stop,
    update,
    isStarted,
    isLive,
    get active() {
      return pilotStarted && !disposed;
    },
    updateObservers,
    bailout,
    updateFall,
    stopFall,
    fireGun,
    fireRocket,
    bombRelease,
    explosion,
    hit,
    gear,
    touchdown,
    canopy,
    rearm,
    chuteOpen,
    stats,
    dispose,
  };
}
