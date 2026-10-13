// scene3d/film/core/spring.js — smoothing dynamics for AC Film Mode (SPEC §2.6).
//
// WHY: camera footage reads as "operated" only when every channel (position,
// angles, pilot residual offsets, fov) moves with continuous velocity. The film
// runtime runs at an arbitrary, sometimes stepped, frame rate, so the
// smoothers here are EXACT closed-form solutions (critically damped springs)
// or explicitly sub-stepped (second-order dynamics) — results do not depend
// on the frame rate and never blow up for large dt.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks.

import { FilmError, FILM_ERROR_CODES } from "./errors.js";
import { unwrapAngle } from "./gimbal.js";

/** Upper bound on second-order sub-steps per update (stability is still guaranteed past it). */
const MAX_SUBSTEPS = 4096;

/**
 * Exact critically damped spring step toward `target`:
 * e(t) = (e0 + (v0 + ω·e0)·t)·e^(−ωt), e = x − target.
 * From rest it approaches the target monotonically (no overshoot).
 * Robustness: non-finite x → target; non-finite v → 0; non-finite target or
 * dt ≤ 0 → unchanged; ω ≤ 0 → coasting at v; ω = ∞ (or ω·dt > 700) → snap.
 * @param {number} x current value @param {number} v current velocity
 * @param {number} target @param {number} omega natural frequency (rad/s; ≈ 2/smoothTime)
 * @param {number} dt seconds
 * @returns {{x:number, v:number}}
 */
export function critDamp(x, v, target, omega, dt) {
  const tgtOk = Number.isFinite(target);
  const xx = Number.isFinite(x) ? x : (tgtOk ? target : 0);
  const vv = Number.isFinite(v) ? v : 0;
  if (!tgtOk || !(dt > 0) || !Number.isFinite(dt)) return { x: xx, v: vv };
  if (!(omega > 0)) return { x: xx + vv * dt, v: vv };
  const ex = omega * dt;
  if (!(ex <= 700)) return { x: target, v: 0 };
  const e0 = xx - target;
  const b = vv + omega * e0;
  const k = Math.exp(-ex);
  return { x: target + (e0 + b * dt) * k, v: (vv - omega * b * dt) * k };
}

/**
 * critDamp applied per component of `[x, y, z]` vectors.
 * @param {number[]} x @param {number[]} v (missing → zero velocity) @param {number[]} target
 * @param {number} omega @param {number} dt
 * @returns {{x:number[], v:number[]}}
 */
export function critDampV3(x, v, target, omega, dt) {
  const vv = v || [0, 0, 0];
  const a = critDamp(x[0], vv[0], target[0], omega, dt);
  const b = critDamp(x[1], vv[1], target[1], omega, dt);
  const c = critDamp(x[2], vv[2], target[2], omega, dt);
  return { x: [a.x, b.x, c.x], v: [a.v, b.v, c.v] };
}

/**
 * Wrap-aware critDamp for angles (radians): the target is first unwrapped next
 * to `x`, so the spring always takes the short way round. The returned angle is
 * continuous with `x` (it is NOT re-wrapped into (−π, π]).
 * @param {number} x @param {number} v @param {number} target @param {number} omega @param {number} dt
 * @returns {{x:number, v:number}}
 */
export function critDampAngle(x, v, target, omega, dt) {
  const xx = Number.isFinite(x) ? x : (Number.isFinite(target) ? target : 0);
  return critDamp(xx, v, Number.isFinite(target) ? unwrapAngle(target, xx) : target, omega, dt);
}

/**
 * Unity-style SmoothDamp (critically damped, ω = 2/smoothTime, EXACT exponential)
 * with an optional speed cap and the no-overshoot guard (lands exactly on the
 * target with zero velocity instead of passing it).
 * maxSpeed ≤ 0 / NaN / ∞ means unlimited. smoothTime is floored at 1e-4 s.
 * @param {number} cur @param {number} target @param {number} vel
 * @param {number} smoothTime seconds @param {number} maxSpeed units/s @param {number} dt seconds
 * @returns {{value:number, vel:number}}
 */
export function smoothDamp(cur, target, vel, smoothTime, maxSpeed, dt) {
  const tgtOk = Number.isFinite(target);
  const c = Number.isFinite(cur) ? cur : (tgtOk ? target : 0);
  let v = Number.isFinite(vel) ? vel : 0;
  if (!tgtOk || !(dt > 0) || !Number.isFinite(dt)) return { value: c, vel: v };
  const T = Math.max(1e-4, Number.isFinite(smoothTime) ? smoothTime : 1e-4);
  const omega = 2 / T;
  const maxChange = (maxSpeed > 0 ? maxSpeed : Infinity) * T;
  let change = c - target;
  if (change > maxChange) change = maxChange;
  else if (change < -maxChange) change = -maxChange;
  const tgt = c - change;
  const ex = omega * dt;
  const k = ex > 700 ? 0 : Math.exp(-ex);
  const temp = (v + omega * change) * dt;
  v = (v - omega * temp) * k;
  let out = tgt + (change + temp) * k;
  if ((target - c > 0) === (out > target)) {
    out = target;
    v = 0;
  }
  return { value: out, vel: v };
}

/**
 * Vector SmoothDamp: the speed cap limits the change VECTOR's magnitude and the
 * overshoot guard tests the approach direction (dot product), as in Unity.
 * @param {number[]} cur @param {number[]} target @param {number[]} vel (missing → zero)
 * @param {number} smoothTime @param {number} maxSpeed @param {number} dt
 * @returns {{value:number[], vel:number[]}}
 */
export function smoothDampV3(cur, target, vel, smoothTime, maxSpeed, dt) {
  const tOk = Number.isFinite(target[0]) && Number.isFinite(target[1]) && Number.isFinite(target[2]);
  const c = [0, 1, 2].map((i) => (Number.isFinite(cur[i]) ? cur[i] : (tOk ? target[i] : 0)));
  const vin = vel || [0, 0, 0];
  let v = [0, 1, 2].map((i) => (Number.isFinite(vin[i]) ? vin[i] : 0));
  if (!tOk || !(dt > 0) || !Number.isFinite(dt)) return { value: c, vel: v };
  const T = Math.max(1e-4, Number.isFinite(smoothTime) ? smoothTime : 1e-4);
  const omega = 2 / T;
  const maxChange = (maxSpeed > 0 ? maxSpeed : Infinity) * T;
  let change = [c[0] - target[0], c[1] - target[1], c[2] - target[2]];
  const mag = Math.sqrt(change[0] * change[0] + change[1] * change[1] + change[2] * change[2]);
  if (mag > maxChange) change = change.map((x) => (x / mag) * maxChange);
  const tgt = [c[0] - change[0], c[1] - change[1], c[2] - change[2]];
  const ex = omega * dt;
  const k = ex > 700 ? 0 : Math.exp(-ex);
  const temp = [0, 1, 2].map((i) => (v[i] + omega * change[i]) * dt);
  v = [0, 1, 2].map((i) => (v[i] - omega * temp[i]) * k);
  let out = [0, 1, 2].map((i) => tgt[i] + (change[i] + temp[i]) * k);
  const toTarget = [target[0] - c[0], target[1] - c[1], target[2] - c[2]];
  const past = [out[0] - target[0], out[1] - target[1], out[2] - target[2]];
  if (toTarget[0] * past[0] + toTarget[1] * past[1] + toTarget[2] * past[2] > 0) {
    out = [target[0], target[1], target[2]];
    v = [0, 0, 0];
  }
  return { value: out, vel: v };
}

/**
 * Second-order dynamics (t3ssel8r "procedural animation"): y follows input x with
 * natural frequency `f` (Hz), damping ratio `zeta` (0 = undamped wobble, 1 =
 * critical, > 1 sluggish) and initial response `r` (0 = eases in, 1 = immediate,
 * > 1 overshoots, < 0 anticipates):
 *   y + k1·y' + k2·y'' = x + k3·x',  k1 = ζ/(πf), k2 = 1/(2πf)², k3 = rζ/(2πf).
 * Integrated semi-implicitly with sub-steps of at most half the stability
 * limit (and the k2 stability clamp), so it is stable for ANY dt (tested to 1 s).
 * The input is interpolated linearly across sub-steps; x' is estimated from
 * consecutive inputs. `dim` = 1 works on numbers, otherwise on arrays.
 * The first update without a prior reset() initialises y = x.
 * Non-finite input components hold their previous value; dt ≤ 0 returns y unchanged.
 * @param {{f?:number, zeta?:number, r?:number, dim?:number}} [opts] defaults f=1, zeta=1, r=0, dim=3
 * @returns {{reset:(x:number|number[])=>void, update:(x:number|number[], dt:number)=>number|number[], value:()=>number|number[]|null}}
 */
export function createSecondOrder(opts = {}) {
  const o = opts || {};
  const f = o.f === undefined ? 1 : Number(o.f);
  const zeta = o.zeta === undefined ? 1 : Number(o.zeta);
  const r = o.r === undefined ? 0 : Number(o.r);
  const dim = o.dim === undefined ? 3 : Number(o.dim);
  if (!(f > 0) || !Number.isFinite(f)) {
    throw new FilmError(`createSecondOrder: f must be a finite frequency > 0 Hz (got ${o.f})`, FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  if (!(zeta >= 0) || !Number.isFinite(zeta)) {
    throw new FilmError(`createSecondOrder: zeta must be a finite damping ratio >= 0 (got ${o.zeta})`, FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  if (!Number.isFinite(r)) {
    throw new FilmError(`createSecondOrder: r must be finite (got ${o.r})`, FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  if (!Number.isInteger(dim) || dim < 1 || dim > 64) {
    throw new FilmError(`createSecondOrder: dim must be an integer in [1, 64] (got ${o.dim})`, FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  const k1 = zeta / (Math.PI * f);
  const k2 = 1 / ((2 * Math.PI * f) * (2 * Math.PI * f));
  const k3 = (r * zeta) / (2 * Math.PI * f);
  const hMax = 0.5 * (Math.sqrt(4 * k2 + k1 * k1) - k1);

  /** @type {number[]|null} */ let y = null;
  /** @type {number[]} */ let yd = [];
  /** @type {number[]} */ let xp = [];

  const toVec = (x, fallback) => {
    const out = new Array(dim);
    for (let i = 0; i < dim; i++) {
      const c = typeof x === "number" ? x : (x != null && typeof x === "object" ? x[i] : NaN);
      out[i] = Number.isFinite(c) ? c : (fallback ? fallback[i] : 0);
    }
    return out;
  };
  const out = (v) => (dim === 1 ? v[0] : v.slice());

  /** Snap the output (and the input history) to x with zero velocity. @param {number|number[]} x */
  function reset(x) {
    const v = toVec(x, y);
    y = v.slice();
    yd = new Array(dim).fill(0);
    xp = v.slice();
  }

  /**
   * Advance by dt seconds toward input x.
   * @param {number|number[]} x @param {number} dt
   * @returns {number|number[]}
   */
  function update(x, dt) {
    if (!y) reset(x);
    const xv = toVec(x, xp);
    if (!(dt > 0) || !Number.isFinite(dt)) return out(y);
    const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / hMax)));
    const h = dt / n;
    const k2s = Math.max(k2, (h * h) / 2 + (h * k1) / 2, h * k1);
    for (let i = 0; i < dim; i++) {
      const xd = (xv[i] - xp[i]) / dt;
      let yi = y[i], ydi = yd[i];
      for (let s = 1; s <= n; s++) {
        const xi = xp[i] + (xv[i] - xp[i]) * (s / n);
        yi += h * ydi;
        ydi += (h * (xi + k3 * xd - yi - k1 * ydi)) / k2s;
      }
      y[i] = yi;
      yd[i] = ydi;
    }
    xp = xv;
    return out(y);
  }

  /** Current output (null before the first reset/update). @returns {number|number[]|null} */
  function value() {
    return y ? out(y) : null;
  }

  return { reset, update, value };
}
