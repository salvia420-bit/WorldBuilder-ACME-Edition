// scene3d/film/core/easing.js — easing curves and motion profiles for AC Film Mode (SPEC §2.5).
//
// WHY: shot techniques map normalised time to progress along a move. Every
// easing here is clamped, exact at the ends (f(0) = 0, f(1) = 1 bit-exactly)
// and monotone, so a technique can swap easings freely without the camera ever
// backing up or overshooting its mark. The motion profiles (trapezoid,
// jerk-limited S-curve) turn "move D metres with these limits" into a
// duration and a position-vs-time function for physically plausible dollies.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks.

import { FilmError, FILM_ERROR_CODES } from "./errors.js";

/** Clamp to [0, 1]; NaN → 0. */
function c01(t) {
  return t > 0 ? (t < 1 ? t : 1) : 0;
}

/** Identity easing. @param {number} t @returns {number} */
export function linear(t) {
  return c01(t);
}

/** @param {number} t @returns {number} 1 − cos(πt/2) */
export function sineIn(t) {
  const x = c01(t);
  return x >= 1 ? 1 : 1 - Math.cos((x * Math.PI) / 2);
}

/** @param {number} t @returns {number} sin(πt/2) */
export function sineOut(t) {
  const x = c01(t);
  return x >= 1 ? 1 : Math.sin((x * Math.PI) / 2);
}

/** @param {number} t @returns {number} (1 − cos πt)/2 */
export function sineInOut(t) {
  const x = c01(t);
  return x >= 1 ? 1 : (1 - Math.cos(Math.PI * x)) / 2;
}

/** @param {number} t @returns {number} t² */
export function quadIn(t) {
  const x = c01(t);
  return x * x;
}

/** @param {number} t @returns {number} 1 − (1 − t)² */
export function quadOut(t) {
  const x = c01(t);
  return 1 - (1 - x) * (1 - x);
}

/** @param {number} t @returns {number} piecewise quadratic ease-in-out */
export function quadInOut(t) {
  const x = c01(t);
  return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) * (-2 * x + 2)) / 2;
}

/** @param {number} t @returns {number} t³ */
export function cubicIn(t) {
  const x = c01(t);
  return x * x * x;
}

/** @param {number} t @returns {number} 1 − (1 − t)³ */
export function cubicOut(t) {
  const x = c01(t);
  const y = 1 - x;
  return 1 - y * y * y;
}

/** @param {number} t @returns {number} piecewise cubic ease-in-out */
export function cubicInOut(t) {
  const x = c01(t);
  if (x < 0.5) return 4 * x * x * x;
  const y = -2 * x + 2;
  return 1 - (y * y * y) / 2;
}

/** @param {number} t @returns {number} piecewise quintic ease-in-out */
export function quintInOut(t) {
  const x = c01(t);
  if (x < 0.5) return 16 * x * x * x * x * x;
  const y = -2 * x + 2;
  return 1 - (y * y * y * y * y) / 2;
}

const EXPO_FLOOR = Math.pow(2, -10);
/**
 * Exponential ease-in-out, renormalised so it is exactly 0 / 1 at the ends
 * and continuous there (the textbook form jumps by 2⁻¹¹ at t = 0 and 1).
 * @param {number} t @returns {number}
 */
export function expoInOut(t) {
  const x = c01(t);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const half = (s) => (Math.pow(2, 20 * s - 10) - EXPO_FLOOR) / (1 - EXPO_FLOOR) / 2;
  return x < 0.5 ? half(x) : 1 - half(1 - x);
}

/** Hermite smoothstep 3t² − 2t³ (zero slope at both ends). @param {number} t @returns {number} */
export function smoothstep(t) {
  const x = c01(t);
  return x * x * (3 - 2 * x);
}

/** Perlin smootherstep 6t⁵ − 15t⁴ + 10t³ (zero slope and curvature at both ends). @param {number} t @returns {number} */
export function smootherstep(t) {
  const x = c01(t);
  return x * x * x * (x * (6 * x - 15) + 10);
}

/**
 * Minimum-jerk normalised position 10t³ − 15t⁴ + 6t⁵ (Flash & Hogan) — the
 * smoothest rest-to-rest move; identical in shape to smootherstep.
 * @param {number} t @returns {number}
 */
export function minJerk(t) {
  const x = c01(t);
  return x * x * x * (10 + x * (-15 + 6 * x));
}

/**
 * Every named easing (all clamped, f(0) = 0, f(1) = 1, monotone).
 * @type {Readonly<Record<string, (t:number)=>number>>}
 */
export const EASINGS = Object.freeze({
  linear, sineIn, sineOut, sineInOut, quadIn, quadOut, quadInOut, cubicIn, cubicOut, cubicInOut,
  quintInOut, expoInOut, smoothstep, smootherstep, minJerk,
});

/**
 * Resolve an easing by name. A function is returned unchanged; null/undefined
 * returns `fallback` (default linear). Unknown names throw FilmError
 * (code UNKNOWN_EASING) listing the valid names.
 * @param {string|((t:number)=>number)|null|undefined} name
 * @param {(t:number)=>number} [fallback=linear]
 * @returns {(t:number)=>number}
 */
export function ease(name, fallback = linear) {
  if (typeof name === "function") return name;
  if (name === undefined || name === null) return fallback;
  if (typeof name === "string" && Object.prototype.hasOwnProperty.call(EASINGS, name)) return EASINGS[name];
  throw new FilmError(
    `unknown easing "${String(name)}" (valid: ${Object.keys(EASINGS).join(", ")})`,
    { code: FILM_ERROR_CODES.UNKNOWN_EASING, details: { name: String(name), valid: Object.keys(EASINGS) } },
  );
}

/**
 * Hold at 0 for the first `holdIn` fraction, hold at 1 for the last `holdOut`
 * fraction, ease (named easing, default sineInOut) in between. Fractions are
 * clamped to [0, 1]; when they leave no room the result is a step at
 * holdIn/(holdIn+holdOut). Monotone, f(0) = 0, f(1) = 1.
 * @param {number} t @param {number} [holdIn=0] @param {number} [holdOut=0] @param {string} [name='sineInOut']
 * @returns {number}
 */
export function holdEase(t, holdIn = 0, holdOut = 0, name = "sineInOut") {
  const fn = ease(name, sineInOut);
  const x = c01(t);
  const hi = c01(holdIn), ho = c01(holdOut);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const span = 1 - hi - ho;
  if (!(span > 1e-12)) {
    const m = hi + ho > 0 ? hi / (hi + ho) : 0.5;
    return x < m ? 0 : 1;
  }
  if (x <= hi) return 0;
  if (x >= 1 - ho) return 1;
  return c01(fn((x - hi) / span));
}

/** Validate a profile limit (> 0; finite unless allowInf). */
function limitArg(fn, name, v, allowInf) {
  const n = Number(v);
  if (!(n > 0) || (!allowInf && !Number.isFinite(n))) {
    throw new FilmError(`${fn}: ${name} must be ${allowInf ? "> 0" : "a finite number > 0"} (got ${v})`, FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  return n;
}

/**
 * Rest-to-rest trapezoidal velocity profile covering `distance` with
 * |v| ≤ vmax and |a| ≤ amax (triangular when vmax is never reached).
 * A negative distance moves backwards (s(t) ≤ 0). s(t) is clamped to
 * [0, duration] in time and lands exactly on `distance` at the end.
 * @param {number} distance @param {number} vmax (> 0) @param {number} amax (> 0)
 * @returns {{duration:number, s:(t:number)=>number, v:(t:number)=>number, vPeak:number, accelTime:number, cruiseTime:number}}
 */
export function trapezoidProfile(distance, vmax, amax) {
  const V = limitArg("trapezoidProfile", "vmax", vmax, false);
  const A = limitArg("trapezoidProfile", "amax", amax, false);
  if (!Number.isFinite(distance)) {
    throw new FilmError(`trapezoidProfile: distance must be finite (got ${distance})`, FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  const sign = distance < 0 ? -1 : 1;
  const D = Math.abs(distance);
  if (D === 0) return { duration: 0, s: () => 0, v: () => 0, vPeak: 0, accelTime: 0, cruiseTime: 0 };
  let vp = V;
  let ta = V / A;
  let tc;
  if (V * V / A >= D) {
    vp = Math.sqrt(D * A);
    ta = vp / A;
    tc = 0;
  } else {
    tc = (D - (V * V) / A) / V;
  }
  const duration = 2 * ta + tc;
  const da = 0.5 * A * ta * ta;
  const pos = (t) => {
    const x = t > 0 ? (t < duration ? t : duration) : 0;
    if (x >= duration) return D;
    let s;
    if (x < ta) s = 0.5 * A * x * x;
    else if (x < ta + tc) s = da + vp * (x - ta);
    else {
      const tr = duration - x;
      s = D - 0.5 * A * tr * tr;
    }
    return s < 0 ? 0 : s > D ? D : s;
  };
  const vel = (t) => {
    const x = t > 0 ? (t < duration ? t : duration) : 0;
    if (x < ta) return A * x;
    if (x < ta + tc) return vp;
    return Math.max(0, A * (duration - x));
  };
  return {
    duration,
    s: (t) => sign * pos(t),
    v: (t) => sign * vel(t),
    vPeak: vp,
    accelTime: ta,
    cruiseTime: tc,
  };
}

/**
 * Rest-to-rest jerk-limited ("S-curve", 7-phase) profile covering `distance`
 * with |v| ≤ vmax, |a| ≤ amax, |jerk| ≤ jmax. jmax may be Infinity (then it is
 * a trapezoid). The peak velocity is solved in closed form when vmax cannot be
 * reached. A negative distance moves backwards. s(t) is clamped in time and
 * lands exactly on `distance` at the end.
 * @param {number} distance @param {number} vmax (> 0) @param {number} amax (> 0) @param {number} jmax (> 0, may be ∞)
 * @returns {{duration:number, s:(t:number)=>number, v:(t:number)=>number, a:(t:number)=>number, vPeak:number, aPeak:number}}
 */
export function sCurveProfile(distance, vmax, amax, jmax) {
  const V = limitArg("sCurveProfile", "vmax", vmax, false);
  const A = limitArg("sCurveProfile", "amax", amax, false);
  const J = limitArg("sCurveProfile", "jmax", jmax, true);
  if (!Number.isFinite(distance)) {
    throw new FilmError(`sCurveProfile: distance must be finite (got ${distance})`, FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  const sign = distance < 0 ? -1 : 1;
  const D = Math.abs(distance);
  if (D === 0) return { duration: 0, s: () => 0, v: () => 0, a: () => 0, vPeak: 0, aPeak: 0 };

  // Accel phase reaching velocity Vp from rest: jerk-up tj, constant-accel tc, jerk-down tj.
  const accelPhase = (Vp) => {
    if (Vp * J >= A * A) return { tj: A / J, tc: Vp / A - A / J, ap: A };
    const tj = Math.sqrt(Vp / J);
    return { tj, tc: 0, ap: J * tj };
  };
  const accelDist = (Vp) => {
    const ph = accelPhase(Vp);
    return (Vp * (2 * ph.tj + ph.tc)) / 2;
  };

  let Vp = V;
  let cruise = 0;
  if (2 * accelDist(V) <= D) {
    cruise = (D - 2 * accelDist(V)) / V;
  } else {
    const ratio = A / J; // 0 when jerk is unlimited
    const vA = (A / 2) * (-ratio + Math.sqrt(ratio * ratio + (4 * D) / A));
    Vp = vA * J >= A * A ? vA : Math.pow((D * Math.sqrt(J)) / 2, 2 / 3);
    Vp = Math.min(Vp, V);
  }
  const ph = accelPhase(Vp);
  const jerks = [J, 0, -J, 0, -J, 0, J];
  const durs = [ph.tj, ph.tc, ph.tj, cruise, ph.tj, ph.tc, ph.tj].map((d) => (d > 0 && Number.isFinite(d) ? d : 0));
  // When jerk is unlimited the jerk phases have zero length; model the
  // constant-accel phases directly so the integration below stays exact.
  const accels = [null, ph.ap, null, 0, null, -ph.ap, null];
  const t0 = [0], s0 = [0], v0 = [0], a0 = [0];
  for (let k = 0; k < 7; k++) {
    const d = durs[k];
    let a = a0[k], v = v0[k], s = s0[k];
    if (d === 0) {
      // Zero-length phase (e.g. unlimited jerk): state passes through unchanged.
      if (accels[k] !== null) a = accels[k];
    } else if (accels[k] !== null) {
      a = accels[k];
      s = s + v * d + 0.5 * a * d * d;
      v = v + a * d;
    } else {
      const j = jerks[k];
      s = s + v * d + 0.5 * a * d * d + (j * d * d * d) / 6;
      v = v + a * d + 0.5 * j * d * d;
      a = a + j * d;
    }
    t0.push(t0[k] + d);
    s0.push(s);
    v0.push(v);
    a0.push(k === 2 ? 0 : k === 6 ? 0 : a);
  }
  const duration = t0[7];
  const locate = (t) => {
    const x = t > 0 ? (t < duration ? t : duration) : 0;
    let k = 0;
    while (k < 6 && x >= t0[k + 1]) k++;
    return { k, tau: x - t0[k], x };
  };
  const evalAt = (t) => {
    const { k, tau, x } = locate(t);
    if (x >= duration) return { s: D, v: 0, a: 0 };
    if (accels[k] !== null) {
      const a = accels[k];
      return { s: s0[k] + v0[k] * tau + 0.5 * a * tau * tau, v: v0[k] + a * tau, a };
    }
    const j = jerks[k], a = a0[k], v = v0[k];
    return {
      s: s0[k] + v * tau + 0.5 * a * tau * tau + (j * tau * tau * tau) / 6,
      v: v + a * tau + 0.5 * j * tau * tau,
      a: a + j * tau,
    };
  };
  return {
    duration,
    s: (t) => {
      const s = evalAt(t).s;
      return sign * (s < 0 ? 0 : s > D ? D : s);
    },
    v: (t) => sign * Math.max(0, evalAt(t).v),
    a: (t) => sign * evalAt(t).a,
    vPeak: Vp,
    aPeak: ph.ap,
  };
}
