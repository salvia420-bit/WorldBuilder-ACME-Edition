// scene3d/film/core/gimbal.js — heading/pitch/roll camera gimbal for AC Film Mode (SPEC §1, §2.3).
//
// WHY: the stock camera builds orientation with `lookAt` + a fixed up vector,
// which three r184 resolves to a fixed north-up basis exactly at ±90° pitch —
// a top-down tilt or a drone pass-over then snaps / flips the image. Film
// cameras instead carry explicit gimbal angles in the AC frame:
//   heading h  compass radians, clockwise from north (+y)
//   pitch   p  radians, + looks up, valid [−π/2, +π/2] INCLUSIVE
//   roll    r  right-hand about forward (top of frame moves right for r > 0)
// The basis {right, forward, up} is well defined for every (h, p, r) —
// including straight down — so the gimbal itself has no singularity. Only
// DERIVING a heading from a vertical look direction is ambiguous; that is
// resolved by an explicit heading hint (stateless) or by the stateful
// look controller's nadir policy (yaw-slew / pitch-through / hold).
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks. Deterministic.

import { FilmError, FILM_ERROR_CODES } from "./errors.js";
import { qAngle, qFromThree, qToThree } from "./quat.js";
import { isFiniteV } from "./vec3.js";

const PI = Math.PI;
const TAU = 2 * Math.PI;
const HALF_PI = Math.PI / 2;
const DEG = Math.PI / 180;

/** Nadir/zenith policies understood by createLookController. */
export const NADIR_MODES = Object.freeze(["yaw-slew", "pitch-through", "hold"]);

// ---------------------------------------------------------------------------
// Angle helpers
// ---------------------------------------------------------------------------

/**
 * Wrap an angle into (−π, π]. Non-finite input returns 0 (never NaN).
 * @param {number} a radians
 * @returns {number}
 */
export function wrapPi(a) {
  if (!Number.isFinite(a)) return 0;
  if (a > -PI && a <= PI) return a;
  let x = a % TAU;
  if (x <= -PI) x += TAU;
  else if (x > PI) x -= TAU;
  return x;
}

/**
 * Signed shortest difference `a − b`, wrapped into (−π, π] — the same operand
 * order as vec3 `sub(a, b)`. Example: shortestAngleDiff(−3.0, 3.0) ≈ +0.283.
 * @param {number} a @param {number} b
 * @returns {number}
 */
export function shortestAngleDiff(a, b) {
  return wrapPi(a - b);
}

/**
 * The representative of angle `a` (mod 2π) closest to `ref`:
 * `ref + shortestAngleDiff(a, ref)`. Use it to keep heading streams continuous.
 * A non-finite `ref` returns wrapPi(a); a non-finite `a` returns `ref`.
 * @param {number} a @param {number} ref
 * @returns {number}
 */
export function unwrapAngle(a, ref) {
  if (!Number.isFinite(ref)) return wrapPi(a);
  if (!Number.isFinite(a)) return ref;
  return ref + wrapPi(a - ref);
}

// ---------------------------------------------------------------------------
// Gimbal ↔ basis ↔ quaternion
// ---------------------------------------------------------------------------

/**
 * Camera forward for heading/pitch: `(sin h·cos p, cos h·cos p, sin p)`.
 * @param {number} h @param {number} p
 * @returns {number[]}
 */
export function forwardFromHP(h, p) {
  const cp = Math.cos(p);
  return [Math.sin(h) * cp, Math.cos(h) * cp, Math.sin(p)];
}

/**
 * Orthonormal right-handed camera basis for (h, p, r) — defined for every
 * angle including p = ±π/2 (right × forward = up).
 * Roll-free: right = (cos h, −sin h, 0), up = (−sin h·sin p, −cos h·sin p, cos p);
 * roll r rotates right/up about forward (up tilts toward right for r > 0).
 * @param {number} h @param {number} p @param {number} [r=0]
 * @returns {{right:number[], forward:number[], up:number[]}}
 */
export function basisFromHPR(h, p, r = 0) {
  const sh = Math.sin(h), ch = Math.cos(h);
  const sp = Math.sin(p), cp = Math.cos(p);
  const rr = Number.isFinite(r) ? r : 0;
  const sr = Math.sin(rr), cr = Math.cos(rr);
  return {
    right: [ch * cr + sh * sp * sr, -sh * cr + ch * sp * sr, -cp * sr],
    forward: [sh * cp, ch * cp, sp],
    up: [-sh * sp * cr + ch * sr, -ch * sp * cr - sh * sr, cp * cr],
  };
}

/**
 * AC-frame quaternion `[w,x,y,z]` for (h, p, r): Rz(−h) · Rx(p) · Ry(r)
 * (heading clockwise about +z, pitch about the camera right axis, roll about
 * forward). Consistent with basisFromHPR / qToBasis. Any real p is accepted
 * (|p| > π/2 = pitched past the pole, i.e. an inverted camera).
 * @param {number} h @param {number} p @param {number} [r=0]
 * @returns {number[]}
 */
export function quatFromHPR(h, p, r = 0) {
  const rr = Number.isFinite(r) ? r : 0;
  const ch = Math.cos(h / 2), sh = Math.sin(h / 2);
  const cp = Math.cos(p / 2), sp = Math.sin(p / 2);
  const cr = Math.cos(rr / 2), sr = Math.sin(rr / 2);
  return [
    ch * cp * cr + sh * sp * sr,
    ch * sp * cr + sh * cp * sr,
    ch * cp * sr - sh * sp * cr,
    ch * sp * sr - sh * cp * cr,
  ];
}

/**
 * Gimbal angles of an AC-frame quaternion. p ∈ [−π/2, π/2]; h is unwrapped
 * next to `headingHint`; r ∈ (−π, π] (or next to `rollHint` when given).
 * When the forward vector is vertical (cos p < 1e-6) the heading is
 * ambiguous: h = headingHint and r absorbs the image rotation, so
 * quatFromHPR(h, p, r) reproduces `q` exactly.
 * @param {number[]} q `[w,x,y,z]` (need not be unit)
 * @param {number} [headingHint=0]
 * @param {number} [rollHint] optional continuity reference for r
 * @returns {{h:number, p:number, r:number}}
 */
export function hprFromQuat(q, headingHint = 0, rollHint) {
  const hint = Number.isFinite(headingHint) ? headingHint : 0;
  if (q == null || typeof q !== "object") return { h: hint, p: 0, r: 0 };
  let w = q[0], x = q[1], y = q[2], z = q[3];
  const l = Math.sqrt(w * w + x * x + y * y + z * z);
  if (!(l > 0) || !Number.isFinite(l)) return { h: hint, p: 0, r: 0 };
  w /= l; x /= l; y /= l; z /= l;
  // forward = q·(0,1,0), up = q·(0,0,1)
  const fx = 2 * (x * y - w * z), fy = 1 - 2 * (x * x + z * z), fz = 2 * (y * z + w * x);
  const ux = 2 * (x * z + w * y), uy = 2 * (y * z - w * x), uz = 1 - 2 * (x * x + y * y);
  const horiz = Math.sqrt(fx * fx + fy * fy);
  const p = Math.atan2(fz, horiz);
  const h = horiz < 1e-6 ? hint : unwrapAngle(Math.atan2(fx, fy), hint);
  const sh = Math.sin(h), ch = Math.cos(h), sp = Math.sin(p), cp = Math.cos(p);
  // up = U0·cos r + R0·sin r with R0 = (cos h, −sin h, 0), U0 = (−sin h sin p, −cos h sin p, cos p)
  const sinR = ux * ch - uy * sh;
  const cosR = -ux * sh * sp - uy * ch * sp + uz * cp;
  let r = Math.atan2(sinR, cosR);
  if (Number.isFinite(rollHint)) r = unwrapAngle(r, rollHint);
  return { h, p, r };
}

// ---------------------------------------------------------------------------
// Stateless look-at
// ---------------------------------------------------------------------------

/**
 * Geometry of the eye→target ray, or null when unusable (non-finite or coincident).
 * @param {number[]} eye @param {number[]} target
 * @returns {{dx:number, dy:number, dz:number, dh:number, L:number, bearing:number, elev:number, thetaV:number}|null}
 */
function lookGeometry(eye, target) {
  if (!isFiniteV(eye) || !isFiniteV(target)) return null;
  const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
  const dh = Math.sqrt(dx * dx + dy * dy);
  const L = Math.sqrt(dh * dh + dz * dz);
  if (!(L > 1e-9) || !Number.isFinite(L)) return null;
  return {
    dx, dy, dz, dh, L,
    bearing: Math.atan2(dx, dy),
    elev: Math.atan2(dz, dh),
    thetaV: Math.atan2(dh, Math.abs(dz)), // angle from the vertical axis
  };
}

/**
 * Stateless look rotation from `eye` to `target` (AC world metres).
 * Heading = atan2(dx, dy) (unwrapped next to headingHint) unless the target is
 * inside the vertical hold cone (within holdConeDeg of straight up/down), then
 * headingHint — inside the cone the forward vector may deviate from the exact
 * target direction by at most 2·holdConeDeg. Pitch = true elevation
 * atan2(dz, horizontal). Never NaN: coincident / non-finite points give
 * p = 0, h = headingHint.
 * @param {number[]} eye @param {number[]} target
 * @param {{headingHint?:number, roll?:number, holdConeDeg?:number}} [opts]
 * @returns {{h:number, p:number, r:number, q:number[]}}
 */
export function lookRotation(eye, target, opts = {}) {
  const o = opts || {};
  const hint = Number.isFinite(o.headingHint) ? o.headingHint : 0;
  const r = Number.isFinite(o.roll) ? o.roll : 0;
  const coneDeg = o.holdConeDeg == null ? NaN : Number(o.holdConeDeg);
  const cone = (coneDeg >= 0 ? coneDeg : 1.5) * DEG;
  const g = lookGeometry(eye, target);
  let h = hint, p = 0;
  if (g) {
    p = g.elev;
    if (!(g.thetaV < cone)) h = unwrapAngle(g.bearing, hint);
  }
  return { h, p, r, q: quatFromHPR(h, p, r) };
}

// ---------------------------------------------------------------------------
// Stateful smooth look controller
// ---------------------------------------------------------------------------

/** @param {number} v @param {number} m @returns {number} v clamped to [−m, m] */
function clampAbs(v, m) {
  return v > m ? m : v < -m ? -m : v;
}

/** Body pitch of the inverted realisation that points the same way as upright pitch p. */
function mirrorPitch(p) {
  return p >= 0 ? PI - p : -PI - p;
}

/** Signed horizontal component of the eye→target ray along heading h. */
function alongHeading(g, h) {
  return g.dx * Math.sin(h) + g.dy * Math.cos(h);
}

/**
 * Best UPRIGHT pitch (|p| ≤ π/2) at heading h: atan2(dz, max(s, dh·cos²e)).
 * With the heading on the bearing this is the true elevation; when the target
 * is behind the heading it stays near the pole for steep targets (the drone
 * "hold nadir while yawing round") and near the horizon for level ones (a pan).
 */
function uprightPitch(g, h) {
  const c2 = (g.dh / g.L) * (g.dh / g.L);
  return Math.atan2(g.dz, Math.max(alongHeading(g, h), g.dh * c2));
}

/**
 * One exact critically damped step tracking a target that moves linearly at
 * vT (velocity feed-forward; vT = 0 → plain critically damped spring).
 * omega = Infinity snaps.
 */
function trackStep(x, v, xT, vT, omega, dt) {
  if (!(omega < Infinity)) return { x: xT, v: vT };
  const ex = omega * dt;
  if (ex > 700) return { x: xT, v: vT };
  const e0 = x - (xT - vT * dt);
  const ev0 = v - vT;
  const k = Math.exp(-ex);
  const b = ev0 + omega * e0;
  return { x: xT + (e0 + b * dt) * k, v: vT + (ev0 - omega * b * dt) * k };
}

/**
 * Stateful smooth look-at with explicit nadir/zenith policies (SPEC §2.3).
 *
 * Each axis is a critically damped spring (ω = 2/smoothTime) with velocity
 * feed-forward of the target's own angular rate (low-pass filtered, scaled by
 * `leadGain`) so steady pans/tilts track with no lag, then rate-limited:
 * |Δh| ≤ maxYawRate·dt, |Δp| ≤ maxPitchRate·dt every update. Roll follows the
 * requested roll through the same spring (no rate limit).
 *
 * nadirMode:
 *  - 'yaw-slew' (default): the heading target holds while the target is inside
 *    the vertical cone (or follows `headingHint` when given), then slews to the
 *    new bearing at ≤ maxYawRate. Pitch is the best upright pitch for the
 *    current heading, so at nadir the slew is a smooth image rotation (the
 *    drone "gimbal flip"); p stays in [−π/2, π/2].
 *  - 'pitch-through': inside the cone pitch follows the signed elevation along
 *    the held heading and continues past ±90° (image inverts, FPV style);
 *    outside the cone the controller keeps whichever realisation — upright
 *    (bearing, e) or inverted (bearing+π, ±π−e) — is the smaller rotation from
 *    the current orientation (10° hysteresis). h stays continuous; the true
 *    orientation is in `q`, `p` is reported clamped to [−π/2, π/2], `pRaw` is
 *    the body pitch and `inverted` flags cos(pRaw) < 0.
 *  - 'hold': the heading is frozen (output constant) from the moment the
 *    target enters the cone until it leaves 2×holdConeDeg, then slews.
 *
 * The first update after construction (or `reset()` with no arguments) snaps
 * to lookRotation. `h` is continuous (unwrapped), never wrapped back.
 * Never NaN: non-finite / coincident eye-target pairs hold the current aim;
 * dt ≤ 0 or non-finite returns the current pose unchanged.
 *
 * @param {{maxYawRate?:number, maxPitchRate?:number, smoothTime?:number, holdConeDeg?:number,
 *   nadirMode?:'yaw-slew'|'pitch-through'|'hold', leadGain?:number, flipMarginDeg?:number}} [opts]
 * @returns {{
 *   reset:(h?:number, p?:number, r?:number)=>void,
 *   update:(eye:number[], target:number[], dt:number, o?:{roll?:number, headingHint?:number})=>
 *     {h:number, p:number, r:number, q:number[], pRaw:number, inverted:boolean},
 *   state:()=>object,
 *   options:object
 * }}
 */
export function createLookController(opts = {}) {
  const o = opts || {};
  const num = (v, ok, def) => {
    const n = Number(v);
    return v !== undefined && v !== null && ok(n) ? n : def;
  };
  const maxYawRate = num(o.maxYawRate, (n) => n > 0, 2.5);
  const maxPitchRate = num(o.maxPitchRate, (n) => n > 0, 2.0);
  const smoothTime = num(o.smoothTime, (n) => n >= 0 && Number.isFinite(n), 0.25);
  const holdConeDeg = num(o.holdConeDeg, (n) => n >= 0 && n < 45, 2);
  const leadGain = num(o.leadGain, (n) => Number.isFinite(n), 1);
  const flipMarginDeg = num(o.flipMarginDeg, (n) => n >= 0 && n < 180, 10);
  const nadirMode = o.nadirMode === undefined || o.nadirMode === null ? "yaw-slew" : o.nadirMode;
  if (!NADIR_MODES.includes(nadirMode)) {
    throw new FilmError(
      `createLookController: unknown nadirMode "${String(nadirMode)}" (expected ${NADIR_MODES.join(" | ")})`,
      FILM_ERROR_CODES.BAD_ARGUMENT,
    );
  }
  const lead = Math.min(1, Math.max(0, leadGain));
  const omega = smoothTime > 1e-6 ? 2 / smoothTime : Infinity;
  const tauLead = Math.max(1e-3, 0.5 * smoothTime);
  const cone = holdConeDeg * DEG;
  const flipMargin = flipMarginDeg * DEG;
  const options = Object.freeze({ maxYawRate, maxPitchRate, smoothTime, holdConeDeg, nadirMode, leadGain: lead, flipMarginDeg });

  /** @type {null|{h:number,p:number,r:number,hv:number,pv:number,rv:number,hT:number,pT:number,ffH:number,ffP:number,haveTargets:boolean,inCone:boolean,frozen:boolean}} */
  let st = null;

  const makeState = (h, p, r) => ({
    h, p, r, hv: 0, pv: 0, rv: 0, hT: h, pT: p, ffH: 0, ffP: 0, haveTargets: false, inCone: false, frozen: false,
  });

  function output() {
    const pw = wrapPi(st.p);
    const pOut = pw > HALF_PI ? HALF_PI : pw < -HALF_PI ? -HALF_PI : pw;
    return { h: st.h, p: pOut, r: st.r, q: quatFromHPR(st.h, st.p, st.r), pRaw: st.p, inverted: Math.cos(st.p) < 0 };
  }

  /**
   * Set the pose (zero velocities). With no finite h and p the controller
   * becomes uninitialised and the next update snaps.
   * @param {number} [h] @param {number} [p] @param {number} [r]
   */
  function reset(h, p, r) {
    if (!Number.isFinite(h) && !Number.isFinite(p)) {
      st = null;
      return;
    }
    let pp = Number.isFinite(p) ? p : 0;
    if (nadirMode !== "pitch-through") pp = Math.min(HALF_PI, Math.max(-HALF_PI, pp));
    st = makeState(Number.isFinite(h) ? h : 0, pp, Number.isFinite(r) ? r : 0);
  }

  function update(eye, target, dt, uo) {
    const u = uo || {};
    const roll = Number.isFinite(u.roll) ? u.roll : 0;
    const hint = Number.isFinite(u.headingHint) ? u.headingHint : undefined;
    const g = lookGeometry(eye, target);

    if (!st) {
      let h0 = hint ?? 0, p0 = 0;
      if (g) {
        const la = lookRotation(eye, target, { headingHint: hint ?? 0, roll, holdConeDeg });
        h0 = la.h;
        p0 = la.p;
      }
      st = makeState(h0, p0, roll);
      st.inCone = !!g && g.thetaV < cone;
      st.frozen = nadirMode === "hold" && st.inCone;
      return output();
    }
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (step === 0) return output();

    // ---- 1. heading target (and nadir policy) --------------------------------
    let hT = st.hT;
    let headingEvent = !st.haveTargets; // target discontinuity → no rate feed-forward this step
    let pitchEvent = !st.haveTargets;
    let useInverted = false; // pitch-through: track the inverted realisation
    let signedPitch = false; // pitch-through inside the cone
    if (g) {
      const wasIn = st.inCone;
      const inNow = g.thetaV < cone;
      if (nadirMode === "hold") {
        if (st.frozen) {
          if (g.thetaV >= 2 * cone) {
            st.frozen = false;
            headingEvent = true;
            hT = unwrapAngle(g.bearing, st.h);
          } else {
            hT = st.h;
          }
        } else if (inNow) {
          st.frozen = true;
          headingEvent = true;
          hT = st.h;
        } else {
          hT = unwrapAngle(g.bearing, hT);
        }
      } else if (nadirMode === "yaw-slew") {
        if (inNow) {
          if (!wasIn) headingEvent = true;
          if (hint !== undefined) hT = unwrapAngle(hint, hT);
        } else if (wasIn) {
          headingEvent = true;
          hT = unwrapAngle(g.bearing, st.h);
        } else {
          hT = unwrapAngle(g.bearing, hT);
        }
      } else {
        // pitch-through
        if (inNow) {
          if (!wasIn) headingEvent = true;
          if (hint !== undefined) hT = unwrapAngle(hint, hT);
          signedPitch = true;
        } else {
          const inv = Math.cos(st.p) < 0;
          const qCur = quatFromHPR(st.h, st.p, st.r);
          const dUp = qAngle(qCur, quatFromHPR(g.bearing, g.elev, st.r));
          const dInv = qAngle(qCur, quatFromHPR(g.bearing + PI, mirrorPitch(g.elev), st.r));
          useInverted = inv ? !(dUp < dInv - flipMargin) : dInv < dUp - flipMargin;
          const switched = useInverted !== inv;
          const b = g.bearing + (useInverted ? PI : 0);
          if (switched || wasIn) {
            headingEvent = true;
            hT = unwrapAngle(b, st.h);
          } else {
            hT = unwrapAngle(b, hT);
          }
          if (switched) pitchEvent = true;
        }
      }
      st.inCone = inNow;
    } else {
      headingEvent = true;
      pitchEvent = true;
    }

    const aLead = 1 - Math.exp(-step / tauLead);

    // ---- 2. heading spring + feed-forward + rate limit -----------------------
    if (headingEvent) st.ffH = 0;
    else st.ffH += (clampAbs((hT - st.hT) / step, maxYawRate) - st.ffH) * aLead;
    if (nadirMode === "hold" && st.frozen) {
      st.hv = 0;
      st.ffH = 0;
    } else {
      const s1 = trackStep(st.h, st.hv, hT, lead * st.ffH, omega, step);
      let dh = s1.x - st.h;
      let hv = s1.v;
      const lim = maxYawRate * step;
      if (dh > lim) { dh = lim; hv = maxYawRate; } else if (dh < -lim) { dh = -lim; hv = -maxYawRate; }
      st.h += dh;
      st.hv = clampAbs(hv, maxYawRate);
    }
    st.hT = hT;

    // ---- 3. pitch target from the NEW heading --------------------------------
    let pT;
    if (g) {
      if (nadirMode === "pitch-through") {
        if (signedPitch) pT = unwrapAngle(Math.atan2(g.dz, alongHeading(g, st.h)), st.p);
        else if (useInverted) pT = unwrapAngle(mirrorPitch(uprightPitch(g, st.h + PI)), st.p);
        else pT = unwrapAngle(uprightPitch(g, st.h), st.p);
      } else {
        pT = uprightPitch(g, st.h);
      }
    } else {
      pT = st.p;
    }
    if (pitchEvent) st.ffP = 0;
    else st.ffP += (clampAbs((pT - st.pT) / step, maxPitchRate) - st.ffP) * aLead;
    const s2 = trackStep(st.p, st.pv, pT, lead * st.ffP, omega, step);
    let dp = s2.x - st.p;
    let pv = s2.v;
    const plim = maxPitchRate * step;
    if (dp > plim) { dp = plim; pv = maxPitchRate; } else if (dp < -plim) { dp = -plim; pv = -maxPitchRate; }
    let p = st.p + dp;
    if (nadirMode !== "pitch-through") {
      if (p > HALF_PI) { p = HALF_PI; if (pv > 0) pv = 0; }
      else if (p < -HALF_PI) { p = -HALF_PI; if (pv < 0) pv = 0; }
    }
    st.p = p;
    st.pv = clampAbs(pv, maxPitchRate);
    st.pT = pT;

    // ---- 4. roll -----------------------------------------------------------
    const s3 = trackStep(st.r, st.rv, unwrapAngle(roll, st.r), 0, omega, step);
    st.r = s3.x;
    st.rv = s3.v;

    st.haveTargets = true;
    return output();
  }

  /**
   * JSON-safe snapshot of the controller (telemetry / tests).
   * @returns {{initialized:boolean, mode:string, h?:number, p?:number, r?:number, hv?:number, pv?:number,
   *   rv?:number, hTarget?:number, pTarget?:number, inCone?:boolean, frozen?:boolean, inverted?:boolean}}
   */
  function state() {
    if (!st) return { initialized: false, mode: nadirMode };
    return {
      initialized: true, mode: nadirMode, h: st.h, p: st.p, r: st.r, hv: st.hv, pv: st.pv, rv: st.rv,
      hTarget: st.hT, pTarget: st.pT, inCone: st.inCone, frozen: st.frozen, inverted: Math.cos(st.p) < 0,
    };
  }

  return { reset, update, state, options };
}

// ---------------------------------------------------------------------------
// three.js frame bridge (SPEC §1)
// ---------------------------------------------------------------------------

/** Accept `[x,y,z]`, a typed array, `{x,y,z}` or three scalars. */
function readVec(a, y, z) {
  if (Array.isArray(a) || ArrayBuffer.isView(a)) return [a[0], a[1], a[2]];
  if (a !== null && typeof a === "object") return [a.x, a.y, a.z];
  return [a, y, z];
}

/**
 * AC world position → three.js world position `[x, z, −y]` (cameras/lights
 * live outside worldRoot). Accepts `(x, y, z)`, `[x, y, z]` or `{x, y, z}`.
 * @param {number|number[]|{x:number,y:number,z:number}} a @param {number} [y] @param {number} [z]
 * @returns {number[]}
 */
export function acToThreePos(a, y, z) {
  const v = readVec(a, y, z);
  return [v[0], v[2], -v[1]];
}

/**
 * three.js world position → AC world position `[x, −z, y]` (inverse of acToThreePos).
 * Accepts `(x, y, z)`, `[x, y, z]` or `{x, y, z}` (e.g. a THREE.Vector3).
 * @param {number|number[]|{x:number,y:number,z:number}} a @param {number} [y] @param {number} [z]
 * @returns {number[]}
 */
export function threeToAcPos(a, y, z) {
  const v = readVec(a, y, z);
  return [v[0], -v[2], v[1]];
}

/**
 * AC-frame camera quaternion `[w,x,y,z]` → three.js quaternion `[x, y, z, w]`
 * (q_three = qM ⊗ q_ac ⊗ qM⁻¹, qM = Rx(−90°)); build it with
 * `new THREE.Quaternion(...acQuatToThree(q))`.
 * @param {number[]} q
 * @returns {number[]}
 */
export function acQuatToThree(q) {
  return qToThree(q);
}

/**
 * three.js world quaternion (`[x,y,z,w]` or `{x,y,z,w}`) → AC-frame `[w,x,y,z]`.
 * @param {number[]|{x:number,y:number,z:number,w:number}} t
 * @returns {number[]}
 */
export function threeQuatToAc(t) {
  return qFromThree(t);
}
