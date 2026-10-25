// scene3d/drone/manual_flight.js — the stick-flown craft of Drone Deploy (scene3d/drone/SPEC.md §3.3).
//
// WHY: film mode's multirotor (film/drone/flight_model.js `createDrone`) flies
// a target POSE; a pilot flies STICKS. This module turns the controls.js
// sticks (§3.5) into a craft with real inertia in three modes and runs the
// autopilot plans index.js builds (§7.4), producing one reused CraftFrame per
// frame (position, velocity, body attitude for the mesh, camera pose for the
// goggles):
//   cine   position-hold camera drone: one internal createDrone('cinema',
//          vmax 20) flies a ONE-STEP LEAD target (pos + vCmd·dt with exact
//          velocity feed-forward) while a translation stick is held and the
//          latched jerk-aware stop point once released — never a longer lead
//          (createDrone adds kp·|e| on top of the feed-forward: a 0.5 s carrot
//          settles at 16.3 m/s instead of 12), never a zero lead (1–2 % slow,
//          frame-rate dependent); heading command 90°/s + mouse X, gimbal
//          pitch 60°/s + mouse Y in [−90°, +30°] (DV-6);
//   angle  self-levelling FPV: a sub-stepped (1/240 s) rigid body, sticks →
//          tilt ≤ 35° through a critically damped attitude loop (ω 12),
//          yaw ≤ 200°/s (+ mouse X), auto-throttle altitude hold, thrust
//          along body up in [0, 2.5 g], quadratic drag, hard mount 20° uptilt;
//   acro   the same body on Betaflight rates (rc / super / expo, 666.67°/s at
//          the defaults), collective 0…2.5 g (centred = 1 g), 25° uptilt,
//          mouse ignored (DV-29);
//   plans  `liftoff` is KINEMATIC (every step createDrone.reset onto the
//          min-jerk path with its exact velocity / acceleration — a tracked
//          3.8 m in 2.2 s is outside the cinema limits, DV-31); `rth`, `hold`
//          and `land` are tracked targets INSIDE the cinema limits (a brake
//          profile, then rest-to-rest jerk-limited S-curves per path segment
//          fed as pos + vel + acc, so the craft brakes into every corner and
//          the end; one that something holds off its end point lands where
//          it is 3 s after its clock ends, so returning / landing always
//          finish; a `rth` carrying the drop `yaw` turns onto it during its
//          final descent, so it lands facing the way it was set down);
//          `crash` is a ballistic tumble onto the ground. A cine plan handing
//          over to angle / acro (`autopilot(null)`) eases the camera onto the
//          hard mount over 0.4 s instead of snapping (the lift-off looks down
//          at the pilot, the mount 20–25° up: a 28–33° pop at T8).
// The craft never wins against geometry: `contact()` takes the safety-reflex
// hits (plus the tether hit) every frame, removes the into-surface velocity
// and moves the craft to the clamped position, so it never winds up against a
// wall and never keeps integrating into the ground.
//
// Conventions (SPEC §2.1): AC world metres (x east, y north, z up), compass
// heading h (clockwise from north), pitch p (+ up), roll r (+ bank right),
// quaternions [w, x, y, z]; body frame +x right, +y forward, +z up.
//
// Drone Deploy is DEFAULT ON since 2026-10-25 (`?drone=off`, exact match, disables it). Pure module: no DOM,
// three, wasm, clocks or Math.random — identical inputs give deep-equal
// frames. The per-frame members (`step`, `contact`) allocate nothing in this
// file: scratch objects are reused, and the only allocations are inside the
// film pieces (createDrone.step / .reset / .state() of the cine craft, SPEC §5
// "Allocation rules"); plan installs (`autopilot`, `setMode`, `reset`) may.

import { createDrone, DRONE_PRESETS } from "../film/drone/flight_model.js";
import { minJerk } from "../film/core/easing.js";
import { unwrapAngle } from "../film/core/gimbal.js";
import { isFiniteV } from "../film/core/vec3.js";

const DEG = Math.PI / 180;

/** The three manual flight modes (SPEC §3.3). @type {ReadonlyArray<'cine'|'angle'|'acro'>} */
export const CRAFT_MODES = Object.freeze(["cine", "angle", "acro"]);

/**
 * Every tuning constant of the craft (SPEC §3.3; angles in degrees where the
 * name ends in `Deg`, speeds m/s, accelerations m/s², jerk m/s³).
 *  - `cine`: horizontal speed `vmaxH` (boost `vmaxBoost`), vertical `vzMax`,
 *    heading command `yawRateDeg`, gimbal command `gimbalRateDeg` within
 *    [`pitchMinDeg`, `pitchMaxDeg`].
 *  - `angle`: target tilt ≤ `maxTiltDeg`, yaw `yawRateDeg`, vertical speed
 *    command `vzMax`, camera `uptiltDeg`, attitude loop ω `levelOmega` (rad/s,
 *    critically damped), quadratic `drag` (1/m), thrust ≤ `maxThrustG`;
 *    altitude hold below |throttle| `holdBelow`, vertical-speed loop gain
 *    `vzGain` (1/s) limited to ±`azMax`, altitude loop gain `altGain` (1/s;
 *    vzGain / 4 = critically damped).
 *  - `acro`: Betaflight `rc` / `super` / `expo`, collective `hoverG` centred
 *    up to `maxThrustG`, camera `uptiltDeg`, `drag`.
 *  - `common`: `gravity`, integrator sub-step `subDt` and `maxSubsteps` per
 *    step (a longer dt is clamped to subDt·maxSubsteps = 20 s), the resting
 *    height `restHeightM` (props DRONE_BODY), idle rotor spin `idleSpin`.
 *  - `rth`: plan speeds — climb `climbMps`, cruise `cruiseMps`, descend
 *    `descendMps`, the last `finalM` at `finalMps` — and the profile limits
 *    `amax` / `jmax` (0.9 × the cinema craft's 4 / 8, so the tracked target is
 *    feasible with margin).
 *  - `crash`: tumble rate `tumbleRadPerMps` · impact speed in
 *    [`tumbleMinRad`, `tumbleMaxRad`] rad/s, `drag`, and on the ground the
 *    sliding friction `frictionPerSec`, spin decay `spinDecayPerSec` and the
 *    settle toward level `settlePerSec` (all 1/s).
 * The lift-off geometry (1.7 m up, 3.4 m back, 2.2 s) travels in the plan built by index.js.
 * @type {Readonly<Object>}
 */
export const CRAFT_TUNING = Object.freeze({
  cine: Object.freeze({ vmaxH: 12, vmaxBoost: 20, vzMax: 4, yawRateDeg: 90, gimbalRateDeg: 60, pitchMinDeg: -90, pitchMaxDeg: 30 }),
  angle: Object.freeze({ maxTiltDeg: 35, yawRateDeg: 200, vzMax: 4, uptiltDeg: 20, levelOmega: 12, drag: 0.025, maxThrustG: 2.5,
    holdBelow: 0.05, vzGain: 4, azMax: 4, altGain: 1 }),
  acro: Object.freeze({ rc: 1.0, super: 0.7, expo: 0, hoverG: 1, maxThrustG: 2.5, uptiltDeg: 25, drag: 0.025 }),
  common: Object.freeze({ gravity: 9.80665, subDt: 1 / 240, maxSubsteps: 4800, restHeightM: 0.06, idleSpin: 0.35 }),
  rth: Object.freeze({ climbMps: 3, cruiseMps: 8, descendMps: 2, finalMps: 0.6, finalM: 1.5, amax: 3.6, jmax: 7.2 }),
  crash: Object.freeze({ tumbleRadPerMps: 1.2, tumbleMinRad: 3, tumbleMaxRad: 12, drag: 0.025, frictionPerSec: 6,
    spinDecayPerSec: 8, settlePerSec: 6 }),
});

// ---- contract numbers (SPEC §3.3 prose) --------------------------------------------------------
/** A ground-ending plan has landed within this distance (m) of its end point … */
const LAND_TOL_M = 0.05;
/** … at a speed below this (m/s). */
const LAND_SPEED_MPS = 0.3;
/** Cine contact re-seeds createDrone only past this move (m) … */
const CONTACT_MOVE_M = 0.02;
/** … or this removed speed (m/s) — fewer gimbal hitches. */
const CONTACT_SPEED_MPS = 0.05;
/** A landed craft with no plan and throttle ≤ this stays landed. */
const TAKEOFF_THROTTLE = 0.1;
/** A cine plan → angle / acro handover slerps the camera onto the hard mount over this (s, min-jerk; R4-04). */
const HANDOVER_BLEND_SEC = 0.4;
// ---- internal thresholds -----------------------------------------------------------------------
/** A stick deflection below this is centred. */
const STICK_EPS = 1e-6;
/** A plan starting below this speed (m/s) needs no brake segment. */
const MOVING_MPS = 0.05;
/** Angle mode latches the hold altitude once |vz| drops below this (m/s). */
const HOLD_LATCH_MPS = 0.05;
/** A contact normal with z ≥ this is a floor (touchdown / crash rest). */
const FLOOR_NZ = 0.5;
/** A floor contact lands a rth / land plan within this much remaining plan distance (m) beyond finalM. */
const TOUCHDOWN_SLACK_M = 0.5;
/** Waypoints closer than this (m) are duplicates. */
const DUP_M = 1e-6;
/** A path segment with more horizontal length than this (m) turns the camera toward its travel direction. */
const TURN_MIN_M = 0.5;
/** Floor on body-up z when dividing the angle-mode thrust (a near-horizontal body cannot hold altitude). */
const MIN_UP_Z = 0.1;
/** Per-poll mouse look is clamped to ±this (rad). */
const LOOK_MAX_RAD = Math.PI;
/** Upper bound of the hit list walked by contact(). */
const MAX_HITS = 64;
/** A plan clock within this of its end (s) has reached it (float drift of Σdt). */
const PLAN_END_EPS_SEC = 1e-9;
/** A camera whose forward |z| exceeds this (within 10° of straight down / up) is checked for a pole flip. */
const POLE_FZ = Math.cos(10 * DEG);
/**
 * A rth / land route still not down this long (s) after its clock ended is held off its end
 * point (a wall or a ledge the safety reflex never lets it through): it lands where it is.
 */
const STALL_GRACE_SEC = 3;
/** The longest dt one step integrates (s): maxSubsteps · subDt. */
const MAX_STEP_SEC = CRAFT_TUNING.common.maxSubsteps * CRAFT_TUNING.common.subDt;

const NO_INPUT = Object.freeze({});

/** Rotation about body +x (nose up) by `deg` — the hard-mount camera uptilt. */
function uptiltQuat(deg) {
  const a = (deg * DEG) / 2;
  return Object.freeze([Math.cos(a), Math.sin(a), 0, 0]);
}

/** Camera mount per mode: cine is a gimbal (no uptilt; used only by the crash tumble), angle / acro hard mounts. */
const MOUNT_Q = Object.freeze({
  cine: uptiltQuat(0),
  angle: uptiltQuat(CRAFT_TUNING.angle.uptiltDeg),
  acro: uptiltQuat(CRAFT_TUNING.acro.uptiltDeg),
});

/** The identity rotation (the handover blend's end offset). */
const Q_ID = Object.freeze([1, 0, 0, 0]);

/** betaflightRateDeg's result slot (see rateInto). */
const RATE_OUT = new Float64Array(1);

/**
 * Betaflight "actual" rate curve (SPEC §3.3): `x' = x·|x|³·expo + x·(1 − expo)`,
 * `rate = 200·rc·x'`, and with `super > 0` `rate /= clamp(1 − |x'|·super, 0.01, 1)`.
 * At the defaults (rc 1, super 0.7, expo 0) full stick = 666.67 °/s. `x` is
 * clamped to [−1, 1] (non-finite → 0); a missing / non-finite rate field
 * takes its CRAFT_TUNING.acro default.
 * @param {number} x stick deflection in [−1, 1]
 * @param {{rc:number, super:number, expo:number}} rates
 * @returns {number} body rate, degrees per second (sign of x)
 */
export function betaflightRateDeg(x, rates) {
  const o = rates && typeof rates === "object" ? rates : CRAFT_TUNING.acro;
  const rc = Number.isFinite(o.rc) ? o.rc : CRAFT_TUNING.acro.rc;
  const sup = Number.isFinite(o.super) ? o.super : CRAFT_TUNING.acro.super;
  const expo = Number.isFinite(o.expo) ? o.expo : CRAFT_TUNING.acro.expo;
  rateInto(RATE_OUT, 0, x, rc, sup, expo);
  return RATE_OUT[0];
}

/**
 * betaflightRateDeg's curve written into out[i] (finite rc / sup / expo): the per-frame acro path
 * stores into a typed array instead of returning a double, which V8 would box whenever the call
 * is not inlined.
 */
function rateInto(out, i, x, rc, sup, expo) {
  const xx = Number.isFinite(x) ? (x > 1 ? 1 : x < -1 ? -1 : x) : 0;
  const ax = Math.abs(xx);
  const xp = xx * ax * ax * ax * expo + xx * (1 - expo);
  let rate = 200 * rc * xp;
  if (sup > 0) {
    const d = 1 - Math.abs(xp) * sup;
    rate /= d < 0.01 ? 0.01 : d > 1 ? 1 : d;
  }
  out[i] = rate;
}

// ---------------------------------------------------------------------------
// allocation-free helpers (the per-frame path never calls an allocating film helper)
// ---------------------------------------------------------------------------

function copy3(out, a) {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

function copy4(out, a) {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  out[3] = a[3];
  return out;
}

function zero3(out) {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  return out;
}

/** Stick axis: finite → clamped to [−1, 1], else 0. */
function axis(v) {
  return typeof v === "number" && Number.isFinite(v) ? (v > 1 ? 1 : v < -1 ? -1 : v) : 0;
}

/** Mouse look (rad since the last poll): finite → clamped to ±LOOK_MAX_RAD, else 0. */
function look(v) {
  return typeof v === "number" && Number.isFinite(v) ? (v > LOOK_MAX_RAD ? LOOK_MAX_RAD : v < -LOOK_MAX_RAD ? -LOOK_MAX_RAD : v) : 0;
}

/** out ← quatFromHPR(h, p, r) of film core/gimbal.js (Rz(−h)·Rx(p)·Ry(r)), in place. */
function setQuatHPR(out, h, p, r) {
  const ch = Math.cos(h / 2), sh = Math.sin(h / 2);
  const cp = Math.cos(p / 2), sp = Math.sin(p / 2);
  const cr = Math.cos(r / 2), sr = Math.sin(r / 2);
  out[0] = ch * cp * cr + sh * sp * sr;
  out[1] = ch * sp * cr + sh * cp * sr;
  out[2] = ch * cp * sr - sh * sp * cr;
  out[3] = ch * sp * sr - sh * cp * cr;
  return out;
}

/**
 * out ← {h, p, r} of q (film core/gimbal.js hprFromQuat, in place): p ∈ [−π/2, π/2],
 * h unwrapped next to `headingHint` (the hint itself when looking straight up / down),
 * r ∈ (−π, π]. The unwrap is inline (gimbal.js unwrapAngle's (−π, π] rule): a helper returning
 * a double would box it on every frame whenever V8 does not inline the call.
 */
function setHPRFromQuat(out, q, headingHint) {
  const hint = Number.isFinite(headingHint) ? headingHint : 0;
  let w = q[0], x = q[1], y = q[2], z = q[3];
  const l = Math.sqrt(w * w + x * x + y * y + z * z);
  if (!(l > 0) || !Number.isFinite(l)) {
    out.h = hint;
    out.p = 0;
    out.r = 0;
    return out;
  }
  w /= l;
  x /= l;
  y /= l;
  z /= l;
  const fx = 2 * (x * y - w * z), fy = 1 - 2 * (x * x + z * z), fz = 2 * (y * z + w * x);
  const ux = 2 * (x * z + w * y), uy = 2 * (y * z - w * x), uz = 1 - 2 * (x * x + y * y);
  const horiz = Math.sqrt(fx * fx + fy * fy);
  const p = Math.atan2(fz, horiz);
  let h = hint;
  if (!(horiz < 1e-6)) {
    let dh = Math.atan2(fx, fy) - hint;
    if (dh > Math.PI || dh <= -Math.PI) {
      dh %= 2 * Math.PI;
      if (dh <= -Math.PI) dh += 2 * Math.PI;
      else if (dh > Math.PI) dh -= 2 * Math.PI;
    }
    h = hint + dh;
  }
  const sh = Math.sin(h), ch = Math.cos(h), sp = Math.sin(p), cp = Math.cos(p);
  out.h = h;
  out.p = p;
  out.r = Math.atan2(ux * ch - uy * sh, -ux * sh * sp - uy * ch * sp + uz * cp);
  return out;
}

/** setCamHPR's view-heading slot. */
const VIEW = { h: 0 };

/**
 * out.{h, p, r} ← a createDrone camera pose, continuous through the gimbal's −90° stop.
 * createDrone decomposes its camera with hprFromQuat, whose heading is atan2 of the forward
 * vector F; its gimbal follow overshoots the stop by up to a few degrees (the pitch limit is
 * asin F.z, blind past the pole), and while F is past the pole that heading reads off by π and
 * the roll ±π, though the image is the same — measured: holding the gimbal stick down then W
 * flew the craft backwards for ≈ 3 s. Detected against setViewHeading (within 10° of vertical,
 * heading AND roll both off by more than 90°) and re-expressed with the view's heading: h + π,
 * the pitch at the pole, r + π — the same image (the orientation within the overshoot of q;
 * q itself is never changed). The heading is unwrapped next to `hint` (the previous frame's),
 * so it never jumps by 2π when createDrone re-resolves its own split at the pole.
 */
function setCamHPR(out, pose, hint) {
  const q = pose.q;
  let h = pose.h, p = pose.p, r = pose.r;
  const l2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  const fz = l2 > 0 ? (2 * (q[2] * q[3] + q[0] * q[1])) / l2 : 0;
  if (fz > POLE_FZ || fz < -POLE_FZ) {
    setViewHeading(VIEW, q, h);
    let rw = r % (2 * Math.PI);
    if (rw <= -Math.PI) rw += 2 * Math.PI;
    else if (rw > Math.PI) rw -= 2 * Math.PI;
    if (Math.abs(VIEW.h - h) > Math.PI / 2 && Math.abs(rw) > Math.PI / 2) {
      h += Math.PI;
      p = fz < 0 ? -Math.PI / 2 : Math.PI / 2;
      r = rw > 0 ? rw - Math.PI : rw + Math.PI;
    }
  }
  if (Number.isFinite(hint)) {
    let dh = h - hint;
    if (dh > Math.PI || dh <= -Math.PI) {
      dh %= 2 * Math.PI;
      if (dh <= -Math.PI) dh += 2 * Math.PI;
      else if (dh > Math.PI) dh -= 2 * Math.PI;
    }
    h = hint + dh;
  }
  out.h = h;
  out.p = p;
  out.r = r;
  return out;
}

/**
 * out.h ← the heading of camera q that stays continuous through the vertical: the direction
 * of H = F·cos p − U·sin p (forward F, up U, p = asin F.z) — F's own heading for a level camera,
 * the top of the image looking straight down. For a roll-free quatFromHPR(h, p, 0) it is
 * exactly h at every pitch, also for a camera a hair PAST the pole, whose forward heading
 * (hprFromQuat's atan2(F)) has flipped by π. Unwrapped next to `hint`; a degenerate H (an
 * inverted camera at ±45°) → `hint`. Inline unwrap: no double-returning helper per frame.
 */
function setViewHeading(out, q, hint) {
  let w = q[0], x = q[1], y = q[2], z = q[3];
  const l = Math.sqrt(w * w + x * x + y * y + z * z);
  if (!(l > 0) || !Number.isFinite(l)) {
    out.h = hint;
    return out;
  }
  w /= l;
  x /= l;
  y /= l;
  z /= l;
  const fx = 2 * (x * y - w * z), fy = 1 - 2 * (x * x + z * z), fz = 2 * (y * z + w * x);
  const ux = 2 * (x * z + w * y), uy = 2 * (y * z - w * x);
  const fh = Math.sqrt(fx * fx + fy * fy);
  const hx = fx * fh - ux * fz, hy = fy * fh - uy * fz;
  if (!(hx * hx + hy * hy > 1e-12)) {
    out.h = hint;
    return out;
  }
  let dh = Math.atan2(hx, hy) - hint;
  if (dh > Math.PI || dh <= -Math.PI) {
    dh %= 2 * Math.PI;
    if (dh <= -Math.PI) dh += 2 * Math.PI;
    else if (dh > Math.PI) dh -= 2 * Math.PI;
  }
  out.h = hint + dh;
  return out;
}

/** out ← a ⊗ b (out may alias a or b). */
function qMulInto(out, a, b) {
  const aw = a[0], ax = a[1], ay = a[2], az = a[3];
  const bw = b[0], bx = b[1], by = b[2], bz = b[3];
  out[0] = aw * bw - ax * bx - ay * by - az * bz;
  out[1] = aw * bx + ax * bw + ay * bz - az * by;
  out[2] = aw * by - ax * bz + ay * bw + az * bx;
  out[3] = aw * bz + ax * by - ay * bx + az * bw;
  return out;
}

/**
 * out ← slerp(a, b, s) along the shorter arc, normalised (out may alias a or b). The start
 * takes b's hemisphere, so s = 1 gives b itself (sign included); nearly equal → nlerp.
 */
function qSlerpInto(out, a, b, s) {
  let aw = a[0], ax = a[1], ay = a[2], az = a[3];
  const bw = b[0], bx = b[1], by = b[2], bz = b[3];
  let dot = aw * bw + ax * bx + ay * by + az * bz;
  if (dot < 0) {
    aw = -aw;
    ax = -ax;
    ay = -ay;
    az = -az;
    dot = -dot;
  }
  let ka = 1 - s, kb = s;
  if (dot < 0.9995) {
    const th = Math.acos(dot);
    const sn = Math.sin(th);
    ka = Math.sin((1 - s) * th) / sn;
    kb = Math.sin(s * th) / sn;
  }
  out[0] = aw * ka + bw * kb;
  out[1] = ax * ka + bx * kb;
  out[2] = ay * ka + by * kb;
  out[3] = az * ka + bz * kb;
  return qNormalize(out);
}

/** Normalise q in place (a zero / non-finite q becomes the identity). */
function qNormalize(q) {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (!(l > 0) || !Number.isFinite(l)) {
    q[0] = 1;
    q[1] = 0;
    q[2] = 0;
    q[3] = 0;
    return q;
  }
  q[0] /= l;
  q[1] /= l;
  q[2] /= l;
  q[3] /= l;
  return q;
}

const CD = { x: 0, v: 0 };
/** Exact step of the critically damped loop x″ = −ω²(x − target) − 2ω·x′ over h (any h); → CD. */
function cdStep(x, v, target, w, h) {
  const e = x - target;
  const c = v + w * e;
  const E = Math.exp(-w * h);
  CD.x = target + (e + c * h) * E;
  CD.v = (v - w * c * h) * E;
}

// ---------------------------------------------------------------------------
// jerk-limited 1-D profiles (built at plan install, evaluated in place)
// ---------------------------------------------------------------------------

/**
 * Piecewise-constant-jerk motion starting at s = 0 with speed v0 and zero acceleration:
 * phase k lasts durs[k] with jerk jerks[k]. Boundary states are tabulated.
 */
function jerkTable(durs, jerks, v0, length) {
  const n = durs.length;
  const T = new Float64Array(n + 1), S = new Float64Array(n + 1), V = new Float64Array(n + 1), A = new Float64Array(n + 1);
  const J = new Float64Array(n);
  V[0] = v0;
  for (let k = 0; k < n; k++) {
    const d = durs[k] > 0 && Number.isFinite(durs[k]) ? durs[k] : 0;
    const j = jerks[k];
    J[k] = j;
    T[k + 1] = T[k] + d;
    S[k + 1] = S[k] + V[k] * d + 0.5 * A[k] * d * d + (j * d * d * d) / 6;
    V[k + 1] = V[k] + A[k] * d + 0.5 * j * d * d;
    A[k + 1] = A[k] + j * d;
  }
  return { n, T, S, V, A, J, duration: T[n], length: Number.isFinite(length) ? length : S[n] };
}

/** Jerk-up / constant / jerk-down phase lengths [tj, tc] reaching speed Vp from rest with limits A, J. */
function accelPhase(Vp, A, J) {
  if (Vp * J >= A * A) return [A / J, Vp / A - A / J];
  return [Math.sqrt(Vp / J), 0];
}

/**
 * Rest-to-rest S-curve covering D ≥ 0 with |v| ≤ V, |a| ≤ A, |jerk| ≤ J — the closed form of
 * film core/easing.js sCurveProfile, tabulated so it evaluates without allocating.
 */
function sCurveTable(D, V, A, J) {
  const dist = (Vp) => {
    const [tj, tc] = accelPhase(Vp, A, J);
    return (Vp * (2 * tj + tc)) / 2;
  };
  let Vp = V;
  let cruise = 0;
  if (2 * dist(V) <= D) {
    cruise = (D - 2 * dist(V)) / V;
  } else {
    const ratio = A / J;
    const vA = (A / 2) * (-ratio + Math.sqrt(ratio * ratio + (4 * D) / A));
    Vp = vA * J >= A * A ? vA : Math.pow((D * Math.sqrt(J)) / 2, 2 / 3);
    Vp = Math.min(Vp, V);
  }
  const [tj, tc] = accelPhase(Vp, A, J);
  return jerkTable([tj, tc, tj, cruise, tj, tc, tj], [J, 0, -J, 0, -J, 0, J], 0, D);
}

/** Jerk-limited stop from speed s0 > 0 (|a| ≤ A, |jerk| ≤ J): distance s0·(s0/(2A) + A/(2J)) at full A. */
function brakeTable(s0, A, J) {
  const [tj, tc] = accelPhase(s0, A, J);
  return jerkTable([tj, tc, tj], [-J, 0, J], s0, undefined);
}

/** Evaluate a jerk table at local time t → out {s, v, a} (s clamped to [0, length]; rest at the end). */
function evalTable(tab, t, out) {
  if (!(t > 0)) {
    out.s = 0;
    out.v = tab.V[0];
    out.a = 0;
    return out;
  }
  if (t >= tab.duration) {
    out.s = tab.length;
    out.v = 0;
    out.a = 0;
    return out;
  }
  let k = 0;
  while (k < tab.n - 1 && t >= tab.T[k + 1]) k++;
  const tau = t - tab.T[k];
  const j = tab.J[k], a = tab.A[k], v = tab.V[k];
  let s = tab.S[k] + v * tau + 0.5 * a * tau * tau + (j * tau * tau * tau) / 6;
  if (s < 0) s = 0;
  else if (s > tab.length) s = tab.length;
  out.s = s;
  out.v = v + a * tau + 0.5 * j * tau * tau;
  out.a = a + j * tau;
  return out;
}

/** Speed limit along a unit direction u: horizontal part ≤ cruise, vertical part ≤ climb (up) / descend (down). */
function phaseSpeed(u) {
  const R = CRAFT_TUNING.rth;
  const uh = Math.hypot(u[0], u[1]);
  const uz = Math.abs(u[2]);
  let v = Infinity;
  if (uh > 1e-9) v = Math.min(v, R.cruiseMps / uh);
  if (uz > 1e-9) v = Math.min(v, (u[2] > 0 ? R.climbMps : R.descendMps) / uz);
  return Number.isFinite(v) ? v : R.cruiseMps;
}

/** planReturn's construction from a braked stop point (tether.js §3.4 shape; the cruise height never below `start`). */
function returnRoute(start, home, cruiseZ) {
  const horizontal = Math.hypot(start[0] - home[0], start[1] - home[1]);
  if (horizontal >= 3) {
    const cz = Math.max(Number.isFinite(cruiseZ) ? cruiseZ : start[2], start[2]);
    return [start, [start[0], start[1], cz], [home[0], home[1], cz], home];
  }
  return [start, [home[0], home[1], Math.max(start[2], home[2] + 1)], home];
}

/** JSON-safe number: non-finite → null, −0 → 0 (a JSON round trip turns −0 into 0). */
const NUM = (v) => (typeof v === "number" && Number.isFinite(v) ? (v === 0 ? 0 : v) : null);

/**
 * Create the manual craft (SPEC §3.3).
 *
 * Members (every per-frame result is the ONE reused CraftFrame — copy what you keep):
 *  - `reset(pose, opts?)` → CraftFrame: `pose = {pos, h, p = 0}` (AC; p = the cine gimbal pitch),
 *    `opts = {velocity?, landed = false}`; re-seeds every integrator and clears the autopilot plan
 *    (install plans after it); `landed: true` = on the ground, motors idle, zero velocity. A pose
 *    without a finite `pos` keeps the previous state; a non-finite `h` keeps the heading.
 *  - `step({sticks, dt, groundZ, fovDeg})` → CraftFrame: advances `dt` (≤ 0 / non-finite → the
 *    current frame unchanged; a dt above subDt·maxSubsteps = 20 s is clamped; never NaN). The
 *    active plan, else the mode, flies; plans ignore the sticks. A landed craft with no plan and
 *    `throttle ≤ 0.1` stays landed. `groundZ` (terrain under the previous position, or null) is
 *    the crash floor; `fovDeg` is copied to `cam.fov`.
 *  - `contact(hits, clampedPos)` → reused `{impactSpeed}`: impactSpeed = max over hits of −(v·n̂)
 *    (a null normal counts |v|; `layer 'tether'` never counts; ≥ 0). Then (except during a
 *    `liftoff` plan, which owns the position) the into-surface velocity / acceleration components
 *    are removed (a null normal uses the clamp's correction direction; a zero correction stops
 *    the craft), the latched cine / hold point is pushed out of the surface, and the craft moves
 *    to `clampedPos` (cine: createDrone.reset only when the move is > 0.02 m or the removed speed
 *    > 0.05 m/s). A floor-like hit (normal z ≥ 0.5) leaving < 0.3 m/s lands a crash, and lands
 *    a `rth` / `land` plan within its last finalM + 0.5 m of plan distance (a floor above the
 *    planned end point, e.g. the body sphere on a platform).
 *  - `setMode(mode)` → mode: applies at once, continuous in position, velocity and heading (the
 *    newly active integrator is seeded from the frame); during a plan only the mode changes.
 *    Unknown → unchanged.
 *  - `setRates({rc, super, expo})` — acro rates (finite fields applied).
 *  - `autopilot(plan)` → fresh `{ok, kind}`: install a plan or `null` (manual control; the cine
 *    commands re-seed from the camera; from a liftoff / rth / hold / land plan into angle / acro
 *    the camera slerps from the plan's last view onto the hard mount over 0.4 s, min-jerk, in the
 *    mount's frame so stick rotation passes straight through — the body is never blended).
 *    Plans: `{kind:'liftoff', from, to, durationSec, heading, lookAt}`,
 *    `{kind:'rth', path, yaw?}` (a finite `yaw` = the drop heading: the final descent turns the
 *    body and the camera onto it on a min-jerk curve, so it lands facing it; absent / non-finite
 *    → no turn), `{kind:'hold'}`, `{kind:'land', at}`, `{kind:'crash'}` (SPEC §3.3); an invalid
 *    plan → `{ok:false}` and the current plan stays.
 *  - `state()` → fresh JSON-safe `{mode, pos, vel, speed, body, cam, throttle, landed, autopilot,
 *    autopilotDone, distTouchdownM}`.
 *
 * CraftFrame: `{t, pos, vel, speed, body: {h, p, r, q}, cam: {t, pos, h, p, r, q, fov}, throttle,
 * landed, autopilot, autopilotDone, distTouchdownM}` — `cam.pos` equals `pos`; `cam.q` is the
 * camera's orientation (createDrone's pose in cine and the plans, body ⊗ uptilt in angle / acro,
 * eased onto it for 0.4 s after a plan handed over, above) and `cam.h / p / r` describe it with a
 * continuous heading — through the cine gimbal's −90° stop too, where createDrone's own heading
 * flips by π while its follow overshoots the pole (then h / p / r are the same view at the pole,
 * within that overshoot of `q`); `throttle` =
 * thrust / weight (0 landed); `landed` when a rth / land / crash plan reached its end point
 * within 0.05 m below 0.3 m/s (or touched down, above; or, for a rth / land still not down 3 s
 * after its plan clock ended — held off its end point by a wall — on the ground under it, else
 * in place); `autopilotDone` = liftoff at `durationSec`, rth / land / crash once landed, hold
 * never; `distTouchdownM` = the remaining plan distance to touchdown (rth: the remaining path
 * length; land: the height above `at` for its vertical descent, plus the brake / fly-back legs
 * when it started moving), never less than the closest straight-line distance the craft has come
 * to the route end (a craft held back by a wall is as far as it really is) and never increasing;
 * else null.
 *
 * @param {{mode?:'cine'|'angle'|'acro', rates?:{rc?:number, super?:number, expo?:number},
 *   createDrone?:Function}} [deps] `createDrone` defaults to film flight_model's (injectable for tests)
 * @returns {{reset:Function, step:Function, contact:Function, setMode:Function, setRates:Function,
 *   autopilot:Function, state:Function}}
 */
export function createManualCraft(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const makeDrone = typeof d.createDrone === "function" ? d.createDrone : createDrone;
  const C = CRAFT_TUNING.cine, AN = CRAFT_TUNING.angle, AC = CRAFT_TUNING.acro, CM = CRAFT_TUNING.common;
  const R = CRAFT_TUNING.rth, CR = CRAFT_TUNING.crash;
  const G = CM.gravity;
  const PITCH_MIN = C.pitchMinDeg * DEG, PITCH_MAX = C.pitchMaxDeg * DEG;
  const clampPitch = (p) => (Number.isFinite(p) ? (p < PITCH_MIN ? PITCH_MIN : p > PITCH_MAX ? PITCH_MAX : p) : 0);

  let mode = typeof d.mode === "string" && CRAFT_MODES.includes(d.mode) ? d.mode : "cine";
  const rates = { rc: AC.rc, super: AC.super, expo: AC.expo };

  const cine = makeDrone({ preset: "cinema", vmax: C.vmaxBoost });
  const cfg = cine && cine.config && typeof cine.config === "object" ? cine.config : DRONE_PRESETS.cinema;
  const AMAX = Number.isFinite(cfg.amax) ? cfg.amax : DRONE_PRESETS.cinema.amax;
  const JMAX = Number.isFinite(cfg.jmax) ? cfg.jmax : DRONE_PRESETS.cinema.jmax;
  const VMAX = Number.isFinite(cfg.vmax) ? cfg.vmax : C.vmaxBoost;
  const DRAG_C = Number.isFinite(cfg.drag) ? cfg.drag : DRONE_PRESETS.cinema.drag;

  /** The CraftFrame (one object, reused by every step / reset). */
  const frame = {
    t: 0,
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    speed: 0,
    body: { h: 0, p: 0, r: 0, q: [1, 0, 0, 0] },
    cam: { t: 0, pos: [0, 0, 0], h: 0, p: 0, r: 0, q: [1, 0, 0, 0], fov: 75 },
    throttle: 1,
    landed: false,
    autopilot: null,
    autopilotDone: false,
    distTouchdownM: null,
  };

  // ---- state ----------------------------------------------------------------------------------
  /** Integrator producing the frame: 'cine' (createDrone; manual cine and every plan but crash), 'rigid' (angle / acro), 'crash'. */
  let active = "cine";
  /** Installed plan (internal form) or null. */
  let plan = null;
  /**
   * Mutable scalars of the per-frame path as object fields: a double held in a closure
   * variable is re-boxed into a new heap number on every write, an object field is updated in
   * place (SPEC §5 "Allocation rules"). `groundZ` = the last finite step groundZ (NaN = none).
   */
  const sv = {
    cineH: 0, // cine heading command (rad, unwrapped)
    cineP: 0, // cine gimbal pitch command (rad)
    fov: 75,
    groundZ: NaN,
    psi: 0, // angle: heading (compass, unwrapped)
    pa: 0, // angle: body pitch (+ nose up) …
    pv: 0, // … and its rate
    ra: 0, // angle: body roll (+ bank right) …
    rv: 0, // … and its rate
    zHold: 0, // angle: hold altitude
    thrustG: 1, // rigid body thrust / weight
    tumbleRate: 0, // crash spin (rad/s)
    blendT: -1, // plan → angle / acro handover: seconds into the camera blend (< 0 = none)
  };
  let latched = false; // cine: translation sticks centred → hold latchPt
  const latchPt = [0, 0, 0];
  const lastAcc = [0, 0, 0]; // net acceleration of the active integrator (seeds the next one)
  // rigid body (angle / acro / crash)
  const rbPos = [0, 0, 0], rbVel = [0, 0, 0], rbAcc = [0, 0, 0], rbQ = [1, 0, 0, 0];
  let holdPending = false; // angle altitude hold: brake |vz| first, then latch sv.zHold
  // crash
  const tumbleAxis = [1, 0, 0];
  let crashTouch = false;
  /** The plan's last camera relative to the hard mount at the handover, where the blend starts (sv.blendT). */
  const blendQ0 = [1, 0, 0, 0];
  /** The handover blend's scratch quaternion. */
  const blendQ = [1, 0, 0, 0];

  // ---- scratch (allocation-free per frame) ------------------------------------------------------
  const tgt = { t: 0, pos: [0, 0, 0], vel: [0, 0, 0], acc: [0, 0, 0], q: [1, 0, 0, 0], h: 0, r: 0, fov: 75 };
  const rsPose = { t: 0, pos: [0, 0, 0], q: [1, 0, 0, 0], h: 0, r: 0, fov: 75 };
  const rsOpts = { velocity: [0, 0, 0], acceleration: [0, 0, 0] };
  const sc = { throttle: 0, yaw: 0, pitch: 0, roll: 0, gimbal: 0, boost: 0, lookX: 0, lookY: 0 };
  const hpr = { h: 0, p: 0, r: 0 };
  const sva = { s: 0, v: 0, a: 0 };
  const dq = [1, 0, 0, 0];
  const tq = [1, 0, 0, 0];
  const W3 = new Float64Array(3); // acro body rates (°/s) of the current step
  const nrm = [0, 0, 0];
  const good = { pos: [0, 0, 0], h: 0 };
  const contactOut = { impactSpeed: 0 };

  function applyRates(r) {
    if (!r || typeof r !== "object") return;
    if (Number.isFinite(r.rc)) rates.rc = r.rc;
    if (Number.isFinite(r.super)) rates.super = r.super;
    if (Number.isFinite(r.expo)) rates.expo = r.expo;
  }
  applyRates(d.rates);

  function readSticks(s) {
    const o = s && typeof s === "object" ? s : NO_INPUT;
    sc.throttle = axis(o.throttle);
    sc.yaw = axis(o.yaw);
    sc.pitch = axis(o.pitch);
    sc.roll = axis(o.roll);
    sc.gimbal = axis(o.gimbal);
    sc.boost = o.boost ? 1 : 0;
    sc.lookX = look(o.lookX);
    sc.lookY = look(o.lookY);
  }

  // ---- frame writers ----------------------------------------------------------------------------

  /**
   * Copy a createDrone pose (+ its state) into the frame; throttle = |thrust| / weight. The
   * camera's h / p / r stay continuous through the gimbal's −90° stop (setCamHPR), so the cine
   * yaw frame, the plan seeds and the OSD heading never read a pole flip.
   */
  function readCine(pose) {
    const st = cine.state();
    const c = frame.cam;
    c.t = frame.t;
    copy3(c.pos, pose.pos);
    setCamHPR(c, pose, c.h);
    copy4(c.q, pose.q);
    c.fov = sv.fov;
    copy3(frame.pos, pose.pos);
    copy3(frame.vel, st.vel);
    const s = Math.sqrt(st.vel[0] * st.vel[0] + st.vel[1] * st.vel[1] + st.vel[2] * st.vel[2]);
    frame.speed = s;
    const b = frame.body;
    b.h = st.body.h;
    b.p = st.body.p;
    b.r = st.body.r;
    setQuatHPR(b.q, b.h, b.p, b.r);
    copy3(lastAcc, st.acc);
    const tx = st.acc[0] + DRAG_C * st.vel[0] * s;
    const ty = st.acc[1] + DRAG_C * st.vel[1] * s;
    const tz = st.acc[2] + DRAG_C * st.vel[2] * s + G;
    frame.throttle = Math.sqrt(tx * tx + ty * ty + tz * tz) / G;
  }

  /** Frame from the rigid body: body = rbQ (angle: its exact h/p/r), camera = body ⊗ mount. */
  function readRigid(mountQ, angleHPR) {
    copy3(frame.pos, rbPos);
    copy3(frame.vel, rbVel);
    frame.speed = Math.sqrt(rbVel[0] * rbVel[0] + rbVel[1] * rbVel[1] + rbVel[2] * rbVel[2]);
    const b = frame.body;
    if (angleHPR) {
      b.h = sv.psi;
      b.p = sv.pa;
      b.r = sv.ra;
    } else {
      setHPRFromQuat(hpr, rbQ, b.h);
      b.h = hpr.h;
      b.p = hpr.p;
      b.r = hpr.r;
    }
    copy4(b.q, rbQ);
    const c = frame.cam;
    qMulInto(c.q, rbQ, mountQ);
    setHPRFromQuat(hpr, c.q, c.h);
    c.h = hpr.h;
    c.p = hpr.p;
    c.r = hpr.r;
    copy3(c.pos, rbPos);
    c.t = frame.t;
    c.fov = sv.fov;
    copy3(lastAcc, rbAcc);
  }

  /** Landed and idle: zero velocity, motors idle, nothing integrates. */
  function stepIdle() {
    zero3(frame.vel);
    frame.speed = 0;
    frame.throttle = 0;
    frame.cam.t = frame.t;
  }

  // ---- seeding (mode / plan switches keep pos, vel and heading continuous) ----------------------

  function seedCineCommands() {
    sv.cineH = frame.cam.h;
    sv.cineP = clampPitch(frame.cam.p);
    latched = false;
  }

  /**
   * rsPose.q ← the frame camera's orientation, rebuilt from its h / p / r: the same q, except
   * at a pole-flipped createDrone camera (setCamHPR), where it is the vertical view at the kept
   * heading — createDrone.reset derives its body yaw from q's forward vector, which past the
   * pole would face backwards (the mesh would spin 180°).
   */
  function seedCamQ() {
    const c = frame.cam;
    setQuatHPR(rsPose.q, c.h, c.p, c.r);
  }

  /** createDrone ← the frame (position, camera orientation, velocity, last acceleration). */
  function seedCineFromFrame() {
    copy3(rsPose.pos, frame.pos);
    seedCamQ();
    rsPose.h = frame.cam.h;
    rsPose.r = frame.cam.r;
    rsPose.fov = sv.fov;
    rsPose.t = frame.t;
    copy3(rsOpts.velocity, frame.vel);
    copy3(rsOpts.acceleration, lastAcc);
    cine.reset(rsPose, rsOpts);
    seedCineCommands();
  }

  /** Rigid body ← the frame (body attitude; attitude rates zeroed; angle re-latches its hold altitude). */
  function seedRigidFromFrame() {
    copy3(rbPos, frame.pos);
    copy3(rbVel, frame.vel);
    copy3(rbAcc, lastAcc);
    qNormalize(copy4(rbQ, frame.body.q));
    sv.psi = frame.body.h;
    sv.pa = frame.body.p;
    sv.ra = frame.body.r;
    sv.pv = 0;
    sv.rv = 0;
    sv.zHold = frame.pos[2];
    holdPending = Math.abs(frame.vel[2]) > HOLD_LATCH_MPS;
    sv.thrustG = frame.throttle > 0 ? frame.throttle : AC.hoverG;
  }

  function wantActive() {
    if (plan !== null) return plan.kind === "crash" ? "crash" : "cine";
    return mode === "cine" ? "cine" : "rigid";
  }

  /** Seed whichever integrator becomes active from the frame (a running handover blend ends: the new one owns the camera). */
  function syncActive() {
    const want = wantActive();
    if (want === active) return;
    if (want === "cine") seedCineFromFrame();
    else seedRigidFromFrame(); // rigid, or crash (makeCrash adds the tumble)
    active = want;
    sv.blendT = -1;
  }

  /** Re-seed everything at a pose (reset, and the NaN recovery). */
  function reseed(pos, h, p, vel, isLanded) {
    latched = false;
    crashTouch = false;
    sv.tumbleRate = 0;
    sv.blendT = -1;
    sv.cineH = h;
    sv.cineP = p;
    copy3(rsPose.pos, pos);
    setQuatHPR(rsPose.q, h, p, 0);
    rsPose.h = h;
    rsPose.r = 0;
    rsPose.fov = sv.fov;
    rsPose.t = frame.t;
    copy3(rsOpts.velocity, vel);
    zero3(rsOpts.acceleration);
    const pose = cine.reset(rsPose, rsOpts);
    copy3(rbPos, pos);
    copy3(rbVel, vel);
    zero3(rbAcc);
    sv.psi = h;
    sv.pa = 0;
    sv.pv = 0;
    sv.ra = 0;
    sv.rv = 0;
    setQuatHPR(rbQ, h, 0, 0);
    sv.zHold = pos[2];
    holdPending = Math.abs(vel[2]) > HOLD_LATCH_MPS;
    sv.thrustG = AC.hoverG;
    active = wantActive();
    frame.cam.h = h; // the reset heading is the continuity reference (readCine / readRigid unwrap next to it)
    frame.body.h = h;
    if (active === "cine") readCine(pose);
    else readRigid(MOUNT_Q[mode], mode === "angle");
    frame.landed = isLanded;
    if (isLanded) stepIdle();
  }

  // ---- manual modes -------------------------------------------------------------------------------

  /** Cine: one-step lead while a translation stick is held, else hold the latched stop point (DV-6). */
  function stepCine(dt) {
    sv.cineH += sc.yaw * C.yawRateDeg * DEG * dt + sc.lookX;
    sv.cineP = clampPitch(sv.cineP + sc.gimbal * C.gimbalRateDeg * DEG * dt + sc.lookY);
    const P = frame.pos;
    if (Math.abs(sc.pitch) > STICK_EPS || Math.abs(sc.roll) > STICK_EPS || Math.abs(sc.throttle) > STICK_EPS) {
      latched = false;
      // The camera's yaw frame (what the pilot sees); a diagonal stick never exceeds the axis speed.
      const fx = Math.sin(frame.cam.h), fy = Math.cos(frame.cam.h);
      let ro = sc.roll, pi = sc.pitch;
      const m = Math.sqrt(ro * ro + pi * pi);
      if (m > 1) {
        ro /= m;
        pi /= m;
      }
      const sH = sc.boost ? C.vmaxBoost : C.vmaxH;
      const vx = (ro * fy + pi * fx) * sH;
      const vy = (pi * fy - ro * fx) * sH;
      const vz = sc.throttle * C.vzMax;
      tgt.pos[0] = P[0] + vx * dt;
      tgt.pos[1] = P[1] + vy * dt;
      tgt.pos[2] = P[2] + vz * dt;
      tgt.vel[0] = vx;
      tgt.vel[1] = vy;
      tgt.vel[2] = vz;
    } else {
      if (!latched) {
        // the jerk-aware stop point: pos + v·(|v|/(2·amax) + amax/(2·jmax)) (cinema amax 4, jmax 8)
        const V = frame.vel;
        const k = frame.speed / (2 * AMAX) + AMAX / (2 * JMAX);
        latchPt[0] = P[0] + V[0] * k;
        latchPt[1] = P[1] + V[1] * k;
        latchPt[2] = P[2] + V[2] * k;
        latched = true;
      }
      copy3(tgt.pos, latchPt);
      zero3(tgt.vel);
    }
    zero3(tgt.acc);
    setQuatHPR(tgt.q, sv.cineH, sv.cineP, 0);
    tgt.h = sv.cineH;
    tgt.r = 0;
    tgt.fov = sv.fov;
    tgt.t = frame.t;
    readCine(cine.step(tgt, dt));
  }

  /** Angle / acro: the sub-stepped rigid body. */
  function stepRigid(dt, acro) {
    const n = Math.min(CM.maxSubsteps, Math.max(1, Math.ceil(dt / CM.subDt - 1e-9)));
    const h = dt / n;
    const drag = acro ? AC.drag : AN.drag;
    const tMax = AN.maxThrustG * G;
    // exact first-order step gains (1 − e^{−k·h}) / h: → k for small h, never overshoot for any h
    const kAlt = (1 - Math.exp(-AN.altGain * h)) / h;
    const kVz = (1 - Math.exp(-AN.vzGain * h)) / h;
    let tP = 0, tR = 0, yawRate = 0;
    if (!acro) {
      sv.psi += sc.lookX; // mouse X yaws; mouse Y is ignored (DV-29)
      const mt = AN.maxTiltDeg * DEG;
      tP = -sc.pitch * mt; // forward stick = nose down
      tR = sc.roll * mt;
      const tot = Math.sqrt(tP * tP + tR * tR);
      if (tot > mt) {
        tP *= mt / tot;
        tR *= mt / tot;
      }
      yawRate = sc.yaw * AN.yawRateDeg * DEG;
    } else {
      // body rates: pitch stick → nose-down, roll → bank right, yaw → compass + (about body +z by −ψ)
      rateInto(W3, 0, sc.pitch, rates.rc, rates.super, rates.expo);
      rateInto(W3, 1, sc.roll, rates.rc, rates.super, rates.expo);
      rateInto(W3, 2, sc.yaw, rates.rc, rates.super, rates.expo);
      const wx = -W3[0] * DEG;
      const wy = W3[1] * DEG;
      const wz = -W3[2] * DEG;
      const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (wl > 1e-12) {
        const half = (wl * h) / 2;
        const s = Math.sin(half) / wl;
        dq[0] = Math.cos(half);
        dq[1] = wx * s;
        dq[2] = wy * s;
        dq[3] = wz * s;
      } else {
        dq[0] = 1;
        dq[1] = 0;
        dq[2] = 0;
        dq[3] = 0;
      }
      sv.thrustG = AC.hoverG + sc.throttle * (sc.throttle >= 0 ? AC.maxThrustG - AC.hoverG : AC.hoverG);
    }
    for (let i = 0; i < n; i++) {
      if (!acro) {
        cdStep(sv.pa, sv.pv, tP, AN.levelOmega, h);
        sv.pa = CD.x;
        sv.pv = CD.v;
        cdStep(sv.ra, sv.rv, tR, AN.levelOmega, h);
        sv.ra = CD.x;
        sv.rv = CD.v;
        sv.psi += yawRate * h;
        setQuatHPR(rbQ, sv.psi, sv.pa, sv.ra);
      } else {
        qNormalize(qMulInto(rbQ, rbQ, dq)); // body-frame rates: right-multiply
      }
      const qw = rbQ[0], qx = rbQ[1], qy = rbQ[2], qz = rbQ[3];
      const upx = 2 * (qx * qz + qw * qy), upy = 2 * (qy * qz - qw * qx), upz = 1 - 2 * (qx * qx + qy * qy);
      let T;
      if (!acro) {
        const vz = rbVel[2];
        let vzCmd;
        if (Math.abs(sc.throttle) >= AN.holdBelow) {
          vzCmd = sc.throttle * AN.vzMax;
          holdPending = true;
        } else if (holdPending) {
          vzCmd = 0; // brake the climb / sink, then latch the hold altitude
          if (Math.abs(vz) < HOLD_LATCH_MPS) {
            holdPending = false;
            sv.zHold = rbPos[2];
          }
        } else {
          vzCmd = (sv.zHold - rbPos[2]) * kAlt;
          if (vzCmd > AN.vzMax) vzCmd = AN.vzMax;
          else if (vzCmd < -AN.vzMax) vzCmd = -AN.vzMax;
        }
        let azCmd = (vzCmd - vz) * kVz;
        if (azCmd > AN.azMax) azCmd = AN.azMax;
        else if (azCmd < -AN.azMax) azCmd = -AN.azMax;
        const sp = Math.sqrt(rbVel[0] * rbVel[0] + rbVel[1] * rbVel[1] + vz * vz);
        T = (G + azCmd + drag * sp * vz) / (upz > MIN_UP_Z ? upz : MIN_UP_Z);
        if (!(T > 0)) T = 0;
        else if (T > tMax) T = tMax;
        sv.thrustG = T / G;
      } else {
        T = sv.thrustG * G;
      }
      const ax = T * upx, ay = T * upy, az = T * upz - G;
      rbVel[0] += ax * h;
      rbVel[1] += ay * h;
      rbVel[2] += az * h;
      // quadratic drag, integrated implicitly (|v| / (1 + c·|v|·h)): stable for any h
      const sp2 = Math.sqrt(rbVel[0] * rbVel[0] + rbVel[1] * rbVel[1] + rbVel[2] * rbVel[2]);
      const f = 1 / (1 + drag * sp2 * h);
      rbVel[0] *= f;
      rbVel[1] *= f;
      rbVel[2] *= f;
      rbPos[0] += rbVel[0] * h;
      rbPos[1] += rbVel[1] * h;
      rbPos[2] += rbVel[2] * h;
      const sp3 = sp2 * f;
      rbAcc[0] = ax - drag * sp3 * rbVel[0];
      rbAcc[1] = ay - drag * sp3 * rbVel[1];
      rbAcc[2] = az - drag * sp3 * rbVel[2];
    }
    readRigid(acro ? MOUNT_Q.acro : MOUNT_Q.angle, !acro);
    frame.throttle = sv.thrustG;
  }

  /**
   * Start the cine plan → angle / acro handover blend (blendHandover): blendQ0 ← the plan's last
   * camera relative to the hard mount the rigid body was just seeded with, mount0⁻¹ ⊗ cam.q.
   */
  function startHandoverBlend() {
    qMulInto(blendQ, rbQ, MOUNT_Q[mode]);
    blendQ[1] = -blendQ[1]; // conjugate = inverse of the unit mount
    blendQ[2] = -blendQ[2];
    blendQ[3] = -blendQ[3];
    qNormalize(qMulInto(blendQ0, blendQ, frame.cam.q));
    sv.blendT = 0;
  }

  /**
   * The cine plan → angle / acro handover (R4-04): readRigid has just written the hard mount
   * (body ⊗ uptilt), which can sit 28–33° from the plan's last camera (the lift-off looks down at
   * the pilot's chest, the mount 20–25° up). For HANDOVER_BLEND_SEC the camera is instead the live
   * mount ⊗ an offset that min-jerk slerps from the plan's view (blendQ0, in the mount's frame) to
   * none — so it eases from the plan's last view onto body ⊗ mount, and the pilot's stick rotation
   * (T16 and an early T8 are input-triggered) passes straight through: a world-frame slerp from a
   * fixed view lags the sticks and flips when an acro roll carries the mount past 180° from it.
   * h / p / r describe the blended q (heading unwrapped next to `hint`, the previous frame's).
   * Only the camera blends: the body, the mesh and the physics are the rigid integrator's.
   */
  function blendHandover(dt, hint) {
    sv.blendT += dt;
    const u = sv.blendT / HANDOVER_BLEND_SEC;
    if (!(u < 1)) {
      sv.blendT = -1; // done: the mount readRigid wrote stands
      return;
    }
    const s = u * u * u * (10 + u * (-15 + 6 * u)); // film easing minJerk(u), inline (no double-returning call per frame)
    const c = frame.cam;
    qSlerpInto(blendQ, blendQ0, Q_ID, s); // the offset left
    qNormalize(qMulInto(c.q, c.q, blendQ)); // the live mount ⊗ that offset
    setHPRFromQuat(hpr, c.q, hint);
    c.h = hpr.h;
    c.p = hpr.p;
    c.r = hpr.r;
  }

  // ---- plans ------------------------------------------------------------------------------------

  /** Kinematic min-jerk lift-off: createDrone.reset onto the path every step (DV-31). */
  function stepLiftoff(dt) {
    const L = plan;
    L.t += dt;
    // Σdt of N equal frames can land a hair short of durationSec (132 × 1/60 = 2.1999…): count it as the end.
    const tau = L.t >= L.D - PLAN_END_EPS_SEC ? 1 : Math.max(0, L.t / L.D);
    const s = minJerk(tau);
    const om = 1 - tau;
    const kv = (30 * tau * tau * om * om) / L.D; // d/dt of minJerk(t/D)
    const ka = (60 * tau * om * (1 - 2 * tau)) / (L.D * L.D); // d²/dt²
    for (let k = 0; k < 3; k++) {
      rsPose.pos[k] = L.from[k] + L.delta[k] * s;
      rsOpts.velocity[k] = L.delta[k] * kv;
      rsOpts.acceleration[k] = L.delta[k] * ka;
    }
    let h = L.heading, p = 0;
    if (L.lookAt !== null) {
      const dx = L.lookAt[0] - rsPose.pos[0], dy = L.lookAt[1] - rsPose.pos[1], dz = L.lookAt[2] - rsPose.pos[2];
      const hl = Math.sqrt(dx * dx + dy * dy);
      if (hl > 1e-6) h = Math.atan2(dx, dy);
      if (hl > 1e-6 || Math.abs(dz) > 1e-6) p = Math.atan2(dz, hl);
    }
    setQuatHPR(rsPose.q, h, p, 0);
    rsPose.h = h;
    rsPose.r = 0;
    rsPose.fov = sv.fov;
    rsPose.t = frame.t;
    readCine(cine.reset(rsPose, rsOpts));
    frame.autopilotDone = tau >= 1;
  }

  /** Hold the plan's point and orientation (pilot view). */
  function stepHold(dt) {
    copy3(tgt.pos, plan.pt);
    zero3(tgt.vel);
    zero3(tgt.acc);
    setQuatHPR(tgt.q, plan.h, plan.p, 0);
    tgt.h = plan.h;
    tgt.r = 0;
    tgt.fov = sv.fov;
    tgt.t = frame.t;
    readCine(cine.step(tgt, dt));
  }

  /** Route target at plan time t → tgt.pos / vel / acc, rt.curH, rt.remaining. */
  function evalRoute(rt, t) {
    const segs = rt.segs;
    if (segs.length === 0) {
      copy3(tgt.pos, rt.end);
      zero3(tgt.vel);
      zero3(tgt.acc);
      rt.remaining = 0;
      return;
    }
    while (rt.i < segs.length - 1 && t >= segs[rt.i].t1) rt.i++;
    const sg = segs[rt.i];
    evalTable(sg.tab, t - sg.t0, sva);
    const s = sva.s;
    for (let k = 0; k < 3; k++) {
      tgt.pos[k] = sg.p0[k] + sg.u[k] * s;
      tgt.vel[k] = sg.u[k] * sva.v;
      tgt.acc[k] = sg.u[k] * sva.a;
    }
    rt.remaining = sg.L - s + sg.restL;
    rt.curH = sg.heading;
    if (rt.yawOn && t > rt.yawT0) {
      // the final descent turns onto the drop heading (makeRoute; minJerk inline, onto yawU exactly at the end)
      const span = rt.yawT1 - rt.yawT0;
      const u = span > 0 && t < rt.yawT1 ? (t - rt.yawT0) / span : 1;
      rt.curH = rt.yawH0 + (rt.yawU - rt.yawH0) * (u * u * u * (10 + u * (-15 + 6 * u)));
    }
  }

  /** Snap onto `pt` and stop: the plan has landed. */
  function landAt(pt) {
    copy3(rsPose.pos, pt);
    seedCamQ();
    rsPose.h = frame.cam.h;
    rsPose.r = frame.cam.r;
    rsPose.fov = sv.fov;
    rsPose.t = frame.t;
    zero3(rsOpts.velocity);
    zero3(rsOpts.acceleration);
    readCine(cine.reset(rsPose, rsOpts));
    frame.landed = true;
    frame.autopilotDone = true;
    frame.distTouchdownM = 0;
    stepIdle();
  }

  /**
   * distTouchdownM of a rth / land plan: the remaining plan distance to the touchdown point —
   * for `land` from a hover (a vertical descent) exactly the height above `at` — but never less
   * than the craft's straight-line distance to the route end (R3-3): the plan clock runs on while
   * a wall across the return holds the craft back, and the sequence releases the goggles at 5 m
   * (T17), so a clock-only distance would end the cancellable return ≈ 17 m short. While the
   * craft tracks the plan the two differ by its tracking lag at most (the path left from the
   * target is never shorter than the target's straight line). Capped at the last report, so it
   * never increases (the craft's own height wobbles by millimetres; a stall re-plan, `stalled`,
   * keeps the last value) — so it reads at least the CLOSEST straight-line distance reached so
   * far (a wall that deflects the craft away keeps that); landed → 0.
   */
  function routeDist(rt) {
    if (frame.landed) return 0;
    const e = rt.end;
    const ex = frame.pos[0] - e[0], ey = frame.pos[1] - e[1], ez = frame.pos[2] - e[2];
    const real = Math.sqrt(ex * ex + ey * ey + ez * ez);
    const left = rt.remaining > 0 ? rt.remaining : 0;
    const d = left > real ? left : real;
    if (d < rt.cap) rt.cap = d;
    return rt.cap;
  }

  /**
   * The route clock ended STALL_GRACE_SEC ago and the craft is still not down: something holds
   * it off the end point (a wall between it and a raised home, a ledge — the safety reflex never
   * lets it through), and the sequence would wait in `returning` / `landing` forever (T21 needs
   * `landed`). Land where it is: first a fresh vertical descent onto the ground under it
   * (groundZ + restHeightM, the last known groundZ, else the end point's height; never upward),
   * landing by the usual rules (the end point, or a floor contact on its last finalM + 0.5 m;
   * a rth's drop heading carries over, so its descent still turns onto it); should that stall
   * too, in place.
   */
  function stalled(rt, gz) {
    if (rt.fallback > 0) {
      landAt(frame.pos);
      return;
    }
    const g = Number.isFinite(gz) ? gz : sv.groundZ;
    let z = Number.isFinite(g) ? g + CM.restHeightM : rt.end[2];
    if (!(z < frame.pos[2])) z = frame.pos[2];
    const next = makeRoute("land", { at: [frame.pos[0], frame.pos[1], z] }, rt.yaw);
    rt.segs = next.segs;
    rt.end = next.end;
    rt.t = 0;
    rt.i = 0;
    rt.T = next.T;
    rt.remaining = next.remaining;
    rt.yawOn = next.yawOn;
    rt.yawH0 = next.yawH0;
    rt.yawU = next.yawU;
    rt.yawT0 = next.yawT0;
    rt.yawT1 = next.yawT1;
    rt.fallback = 1;
  }

  /** rth / land: track the profile inside the cinema limits; land on the end point (or where a stall leaves it). */
  function stepRoute(dt, gz) {
    const rt = plan;
    rt.t += dt;
    evalRoute(rt, rt.t);
    setQuatHPR(tgt.q, rt.curH, rt.pitch, 0);
    tgt.h = rt.curH;
    tgt.r = 0;
    tgt.fov = sv.fov;
    tgt.t = frame.t;
    readCine(cine.step(tgt, dt));
    const ex = frame.pos[0] - rt.end[0], ey = frame.pos[1] - rt.end[1], ez = frame.pos[2] - rt.end[2];
    if (Math.sqrt(ex * ex + ey * ey + ez * ez) <= LAND_TOL_M && frame.speed < LAND_SPEED_MPS) landAt(rt.end);
    else if (rt.t > rt.T + STALL_GRACE_SEC) stalled(rt, gz);
    frame.distTouchdownM = routeDist(rt);
    frame.autopilotDone = frame.landed;
  }

  /** Ballistic tumble onto the floor (groundZ + restHeightM; the last known one when NaN) or a floor contact. */
  function stepCrash(dt, gz) {
    const floor = (Number.isFinite(gz) ? gz : sv.groundZ) + CM.restHeightM; // NaN = no floor known
    const hasFloor = Number.isFinite(floor);
    const n = Math.min(CM.maxSubsteps, Math.max(1, Math.ceil(dt / CM.subDt - 1e-9)));
    const h = dt / n;
    let grounded = false;
    for (let i = 0; i < n; i++) {
      grounded = crashTouch || (hasFloor && rbPos[2] <= floor + 1e-9);
      if (!grounded) rbVel[2] -= G * h;
      const sp = Math.sqrt(rbVel[0] * rbVel[0] + rbVel[1] * rbVel[1] + rbVel[2] * rbVel[2]);
      const f = 1 / (1 + CR.drag * sp * h);
      rbVel[0] *= f;
      rbVel[1] *= f;
      rbVel[2] *= f;
      rbPos[0] += rbVel[0] * h;
      rbPos[1] += rbVel[1] * h;
      rbPos[2] += rbVel[2] * h;
      if (hasFloor && rbPos[2] < floor) {
        rbPos[2] = floor;
        if (rbVel[2] < 0) rbVel[2] = 0;
        grounded = true;
      }
      if (grounded) {
        const fr = Math.exp(-CR.frictionPerSec * h);
        rbVel[0] *= fr;
        rbVel[1] *= fr;
        sv.tumbleRate *= Math.exp(-CR.spinDecayPerSec * h);
        // settle toward level at the current heading
        const qw = rbQ[0], qx = rbQ[1], qy = rbQ[2], qz = rbQ[3];
        const fx = 2 * (qx * qy - qw * qz), fy = 1 - 2 * (qx * qx + qz * qz);
        const hh = Math.hypot(fx, fy) > 1e-6 ? Math.atan2(fx, fy) : frame.body.h;
        setQuatHPR(tq, hh, 0, 0);
        if (tq[0] * qw + tq[1] * qx + tq[2] * qy + tq[3] * qz < 0) {
          tq[0] = -tq[0];
          tq[1] = -tq[1];
          tq[2] = -tq[2];
          tq[3] = -tq[3];
        }
        const k = 1 - Math.exp(-CR.settlePerSec * h);
        rbQ[0] = qw + (tq[0] - qw) * k;
        rbQ[1] = qx + (tq[1] - qx) * k;
        rbQ[2] = qy + (tq[2] - qy) * k;
        rbQ[3] = qz + (tq[3] - qz) * k;
        qNormalize(rbQ);
      }
      if (sv.tumbleRate > 1e-9) {
        const half = (sv.tumbleRate * h) / 2;
        const s = Math.sin(half);
        dq[0] = Math.cos(half);
        dq[1] = tumbleAxis[0] * s;
        dq[2] = tumbleAxis[1] * s;
        dq[3] = tumbleAxis[2] * s;
        qNormalize(qMulInto(rbQ, dq, rbQ)); // world-frame spin: left-multiply
      }
      const vNet = Math.sqrt(rbVel[0] * rbVel[0] + rbVel[1] * rbVel[1] + rbVel[2] * rbVel[2]);
      rbAcc[0] = -CR.drag * vNet * rbVel[0];
      rbAcc[1] = -CR.drag * vNet * rbVel[1];
      rbAcc[2] = (grounded ? 0 : -G) - CR.drag * vNet * rbVel[2];
    }
    crashTouch = false;
    readRigid(MOUNT_Q[mode], false);
    frame.throttle = 0;
    if (grounded && frame.speed < LAND_SPEED_MPS) crashRest();
    frame.autopilotDone = frame.landed;
  }

  /** The crashed craft has come to rest where it is. */
  function crashRest() {
    zero3(rbVel);
    zero3(rbAcc);
    sv.tumbleRate = 0;
    frame.landed = true;
    frame.autopilotDone = true;
    stepIdle();
  }

  function makeLiftoff(p) {
    if (!isFiniteV(p.from) || !isFiniteV(p.to)) return null;
    const D = p.durationSec;
    if (typeof D !== "number" || !Number.isFinite(D) || !(D > 0)) return null;
    return {
      kind: "liftoff",
      from: [p.from[0], p.from[1], p.from[2]],
      delta: [p.to[0] - p.from[0], p.to[1] - p.from[1], p.to[2] - p.from[2]],
      D,
      heading: Number.isFinite(p.heading) ? p.heading : frame.cam.h,
      lookAt: isFiniteV(p.lookAt) ? [p.lookAt[0], p.lookAt[1], p.lookAt[2]] : null,
      t: 0,
    };
  }

  /**
   * The frame velocity as the cine craft will carry it: createDrone.reset clamps |v| to its vmax
   * (an acro dive can be faster), so a brake / hold planned from the raw speed would aim past
   * what the craft can fly.
   */
  function cineVelocity() {
    const V = frame.vel;
    const s = Math.hypot(V[0], V[1], V[2]);
    const k = s > VMAX ? VMAX / s : 1;
    return [V[0] * k, V[1] * k, V[2] * k];
  }

  function makeHold() {
    const V = cineVelocity();
    const k = Math.hypot(V[0], V[1], V[2]) / (2 * AMAX) + AMAX / (2 * JMAX);
    return {
      kind: "hold",
      pt: [frame.pos[0] + V[0] * k, frame.pos[1] + V[1] * k, frame.pos[2] + V[2] * k],
      h: frame.cam.h,
      p: clampPitch(frame.cam.p),
    };
  }

  /**
   * rth / land route: brake (when moving), then rest-to-rest S-curves per waypoint segment.
   * `yawIn` = the drop heading a rth carries (`plan.yaw`; the stall fallback passes the rth's
   * on), non-finite = none: the final descent turns onto it (evalRoute).
   */
  function makeRoute(kind, p, yawIn) {
    let pts = null;
    let end;
    if (kind === "rth") {
      const path = p.path && typeof p.path === "object" ? p.path : null;
      pts = path && Array.isArray(path.points) ? path.points.filter(isFiniteV).map((q) => [q[0], q[1], q[2]]) : [];
      if (pts.length === 0) return null;
      end = pts[pts.length - 1];
    } else {
      if (!isFiniteV(p.at)) return null;
      end = p.at;
    }
    end = [end[0], end[1], end[2]];
    const P0 = [frame.pos[0], frame.pos[1], frame.pos[2]];
    const V0 = cineVelocity();
    const s0 = Math.hypot(V0[0], V0[1], V0[2]);
    const pitch = clampPitch(frame.cam.p);
    let heading = frame.cam.h;
    const segs = [];
    let t0 = 0;
    let start = P0;
    if (s0 > MOVING_MPS) {
      const tab = brakeTable(s0, R.amax, R.jmax);
      const u = [V0[0] / s0, V0[1] / s0, V0[2] / s0];
      segs.push({ p0: P0, u, L: tab.length, tab, t0, t1: t0 + tab.duration, heading, landing: false, restL: 0 });
      t0 += tab.duration;
      start = [P0[0] + u[0] * tab.length, P0[1] + u[1] * tab.length, P0[2] + u[2] * tab.length];
    }
    let W;
    if (kind === "rth") {
      // At rest the planned path flies as given (from where the craft is); after a brake it is
      // re-planned from the stop point (climb there, cruise straight home) instead of flying back.
      if (segs.length > 0) W = returnRoute(start, end, p.path.cruiseZ);
      else W = [start].concat(pts.length > 1 ? pts.slice(1) : pts);
    } else {
      W = [start];
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) > LAND_TOL_M) W.push([end[0], end[1], start[2]]);
      W.push(end);
    }
    W[W.length - 1] = end;
    const Wd = [];
    for (let i = 0; i < W.length; i++) {
      const a = W[i], b = W[i + 1];
      if (b && Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) <= DUP_M) continue;
      Wd.push(a);
    }
    const pushMove = (a, u, L, v, landing) => {
      const tab = sCurveTable(L, v, R.amax, R.jmax);
      segs.push({ p0: a, u, L, tab, t0, t1: t0 + tab.duration, heading, landing, restL: 0 });
      t0 += tab.duration;
    };
    for (let i = 0; i + 1 < Wd.length; i++) {
      const a = Wd[i], b = Wd[i + 1];
      const dv = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const L = Math.hypot(dv[0], dv[1], dv[2]);
      if (!(L > DUP_M)) continue;
      const u = [dv[0] / L, dv[1] / L, dv[2] / L];
      if (Math.hypot(dv[0], dv[1]) > TURN_MIN_M) heading = unwrapAngle(Math.atan2(dv[0], dv[1]), heading);
      const vP = phaseSpeed(u);
      if (i + 2 === Wd.length) {
        if (L > R.finalM + 1e-3) {
          const L1 = L - R.finalM;
          pushMove(a, u, L1, vP, true);
          pushMove([a[0] + u[0] * L1, a[1] + u[1] * L1, a[2] + u[2] * L1], u, R.finalM, Math.min(vP, R.finalMps), true);
        } else {
          pushMove(a, u, L, Math.min(vP, R.finalMps), true);
        }
      } else {
        pushMove(a, u, L, vP, false);
      }
    }
    let rest = 0;
    for (let i = segs.length - 1; i >= 0; i--) {
      segs[i].restL = rest;
      rest += segs[i].L;
    }
    // The drop heading (R4-03): over the final descent — the trailing `landing` segments, plan
    // time [yawT0, yawT1] — the heading command turns from the descent's own heading (yawH0)
    // onto the yaw, the short way (yawU), on a min-jerk curve. The cine craft's body and camera
    // follow it, so the craft touches down facing the way it was set down and the pickup grab
    // needs no yaw snap. No yaw (or no descent) → the headings stay the route's own.
    let iL = segs.length;
    while (iL > 0 && segs[iL - 1].landing) iL--;
    const yaw = Number.isFinite(yawIn) ? yawIn : NaN;
    const yawOn = Number.isFinite(yaw) && iL < segs.length;
    const yawH0 = yawOn ? segs[iL].heading : 0;
    // T = the route's duration (the stall clock, stepRoute); cap = the distTouchdownM reported so far
    return { kind, segs, end, t: 0, i: 0, curH: segs.length ? segs[0].heading : heading, pitch, remaining: rest, total: rest,
      T: t0, cap: Infinity, fallback: 0, yaw, yawOn, yawH0, yawU: yawOn ? unwrapAngle(yaw, yawH0) : 0,
      yawT0: yawOn ? segs[iL].t0 : 0, yawT1: t0 };
  }

  /** Seed the tumble from the frame (spin axis normalize(v × up), deterministic). */
  function makeCrash() {
    const V = frame.vel;
    const hv = Math.hypot(V[0], V[1]);
    if (hv > 1e-3) {
      tumbleAxis[0] = V[1] / hv;
      tumbleAxis[1] = -V[0] / hv;
      tumbleAxis[2] = 0;
    } else {
      // straight down / at rest: tumble about the body's right axis (horizontal), else east
      const q = frame.body.q;
      const rx = 1 - 2 * (q[2] * q[2] + q[3] * q[3]), ry = 2 * (q[1] * q[2] + q[0] * q[3]);
      const rl = Math.hypot(rx, ry);
      tumbleAxis[0] = rl > 1e-6 ? rx / rl : 1;
      tumbleAxis[1] = rl > 1e-6 ? ry / rl : 0;
      tumbleAxis[2] = 0;
    }
    const sp = frame.speed;
    const rate = sp * CR.tumbleRadPerMps;
    sv.tumbleRate = rate < CR.tumbleMinRad ? CR.tumbleMinRad : rate > CR.tumbleMaxRad ? CR.tumbleMaxRad : rate;
    crashTouch = false;
    return { kind: "crash" };
  }

  // ---- members ------------------------------------------------------------------------------------

  function reset(pose, opts) {
    if (!pose || typeof pose !== "object" || !isFiniteV(pose.pos)) return frame;
    const o = opts && typeof opts === "object" ? opts : NO_INPUT;
    const isLanded = o.landed === true;
    const h = Number.isFinite(pose.h) ? pose.h : frame.cam.h;
    const p = Number.isFinite(pose.p) ? clampPitch(pose.p) : 0;
    plan = null;
    frame.autopilot = null;
    frame.autopilotDone = false;
    frame.distTouchdownM = null;
    if (!isLanded && isFiniteV(o.velocity)) copy3(tq, o.velocity);
    else zero3(tq);
    reseed(pose.pos, h, p, tq, isLanded);
    return frame;
  }

  function frameFinite() {
    const f = frame, b = f.body, c = f.cam;
    return Number.isFinite(f.pos[0] + f.pos[1] + f.pos[2] + f.vel[0] + f.vel[1] + f.vel[2] + f.speed + f.throttle) &&
      Number.isFinite(b.h + b.p + b.r + b.q[0] + b.q[1] + b.q[2] + b.q[3]) &&
      Number.isFinite(c.h + c.p + c.r + c.q[0] + c.q[1] + c.q[2] + c.q[3] + c.pos[0] + c.pos[1] + c.pos[2]);
  }

  function step(input) {
    const inp = input && typeof input === "object" ? input : NO_INPUT;
    const dt0 = inp.dt;
    if (typeof dt0 !== "number" || !Number.isFinite(dt0) || !(dt0 > 0)) return frame;
    const dt = dt0 < MAX_STEP_SEC ? dt0 : MAX_STEP_SEC;
    readSticks(inp.sticks);
    const fv = inp.fovDeg;
    if (typeof fv === "number" && fv > 1 && fv < 170) sv.fov = fv;
    const g = inp.groundZ;
    const gz = typeof g === "number" && Number.isFinite(g) ? g : NaN; // NaN, not null: keeps the local an unboxed double
    if (Number.isFinite(gz)) sv.groundZ = gz;
    copy3(good.pos, frame.pos);
    good.h = frame.cam.h;
    frame.t += dt;
    if (plan !== null) {
      if (plan.kind === "liftoff") stepLiftoff(dt);
      else if (plan.kind === "crash") {
        if (frame.landed) stepIdle();
        else stepCrash(dt, gz);
      } else if (frame.landed) stepIdle();
      else if (plan.kind === "hold") stepHold(dt);
      else stepRoute(dt, gz);
    } else if (frame.landed && sc.throttle <= TAKEOFF_THROTTLE) {
      stepIdle();
    } else {
      frame.landed = false;
      if (active === "cine") stepCine(dt);
      else {
        stepRigid(dt, mode === "acro");
        if (sv.blendT >= 0) blendHandover(dt, good.h);
      }
    }
    if (!frameFinite()) {
      // never NaN: re-seed at the last finite pose, at rest (the plan stays installed)
      reseed(Number.isFinite(good.pos[0] + good.pos[1] + good.pos[2]) ? good.pos : zero3(tq),
        Number.isFinite(good.h) ? good.h : 0, 0, zero3(nrm), frame.landed);
    }
    return frame;
  }

  /** Unit normal of a hit into `nrm`; false for a null / degenerate normal. */
  function unitNormal(n) {
    if (n == null || typeof n !== "object") return false;
    const x = n[0], y = n[1], z = n[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    const l = Math.sqrt(x * x + y * y + z * z);
    if (!(l > 1e-9)) return false;
    nrm[0] = x / l;
    nrm[1] = y / l;
    nrm[2] = z / l;
    return true;
  }

  /** Push a held point out of the surface (n̂ at the contact point c). */
  function projectOut(pt, cx, cy, cz) {
    const k = (pt[0] - cx) * nrm[0] + (pt[1] - cy) * nrm[1] + (pt[2] - cz) * nrm[2];
    if (k < 0) {
      pt[0] -= k * nrm[0];
      pt[1] -= k * nrm[1];
      pt[2] -= k * nrm[2];
    }
  }

  function contact(hits, clampedPos) {
    const out = contactOut;
    out.impactSpeed = 0;
    const len = hits != null && typeof hits === "object" && Number.isFinite(hits.length) ? hits.length : 0;
    const n = len > MAX_HITS ? MAX_HITS : len > 0 ? Math.floor(len) : 0;
    if (n === 0) return out;
    let vx = frame.vel[0], vy = frame.vel[1], vz = frame.vel[2];
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    let imp = 0;
    for (let i = 0; i < n; i++) {
      const hit = hits[i];
      if (!hit || typeof hit !== "object" || hit.layer === "tether") continue;
      const into = unitNormal(hit.normal) ? -(vx * nrm[0] + vy * nrm[1] + vz * nrm[2]) : sp;
      if (into > imp) imp = into;
    }
    out.impactSpeed = imp;
    if (plan !== null && plan.kind === "liftoff") return out; // the kinematic plan owns the position
    const P = frame.pos;
    const cOk = isFiniteV(clampedPos);
    const cx = cOk ? clampedPos[0] : P[0], cy = cOk ? clampedPos[1] : P[1], cz = cOk ? clampedPos[2] : P[2];
    let ax = lastAcc[0], ay = lastAcc[1], az = lastAcc[2];
    let floorHit = false;
    for (let i = 0; i < n; i++) {
      const hit = hits[i];
      if (!hit || typeof hit !== "object") continue;
      if (!unitNormal(hit.normal)) {
        // unknown surface: the clamp's correction stands in for the normal; none → stop
        const mx = cx - P[0], my = cy - P[1], mz = cz - P[2];
        const ml = Math.sqrt(mx * mx + my * my + mz * mz);
        if (!(ml > 1e-6)) {
          vx = 0;
          vy = 0;
          vz = 0;
          ax = 0;
          ay = 0;
          az = 0;
          continue;
        }
        nrm[0] = mx / ml;
        nrm[1] = my / ml;
        nrm[2] = mz / ml;
      }
      const kv = vx * nrm[0] + vy * nrm[1] + vz * nrm[2];
      if (kv < 0) {
        vx -= kv * nrm[0];
        vy -= kv * nrm[1];
        vz -= kv * nrm[2];
      }
      const ka = ax * nrm[0] + ay * nrm[1] + az * nrm[2];
      if (ka < 0) {
        ax -= ka * nrm[0];
        ay -= ka * nrm[1];
        az -= ka * nrm[2];
      }
      if (latched) projectOut(latchPt, cx, cy, cz);
      if (plan !== null && plan.kind === "hold") projectOut(plan.pt, cx, cy, cz);
      if (hit.layer !== "tether" && nrm[2] >= FLOOR_NZ) floorHit = true;
    }
    const dvx = vx - frame.vel[0], dvy = vy - frame.vel[1], dvz = vz - frame.vel[2];
    const removed = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
    const mx = cx - P[0], my = cy - P[1], mz = cz - P[2];
    const moved = Math.sqrt(mx * mx + my * my + mz * mz);
    let changed = true;
    if (active === "cine") {
      if (moved > CONTACT_MOVE_M || removed > CONTACT_SPEED_MPS) {
        rsPose.pos[0] = cx;
        rsPose.pos[1] = cy;
        rsPose.pos[2] = cz;
        seedCamQ();
        rsPose.h = frame.cam.h;
        rsPose.r = frame.cam.r;
        rsPose.fov = sv.fov;
        rsPose.t = frame.t;
        rsOpts.velocity[0] = vx;
        rsOpts.velocity[1] = vy;
        rsOpts.velocity[2] = vz;
        rsOpts.acceleration[0] = ax;
        rsOpts.acceleration[1] = ay;
        rsOpts.acceleration[2] = az;
        cine.reset(rsPose, rsOpts);
      } else {
        changed = false; // below the thresholds createDrone keeps flying (no gimbal hitch)
      }
    } else {
      rbPos[0] = cx;
      rbPos[1] = cy;
      rbPos[2] = cz;
      rbVel[0] = vx;
      rbVel[1] = vy;
      rbVel[2] = vz;
      rbAcc[0] = ax;
      rbAcc[1] = ay;
      rbAcc[2] = az;
      if (active === "crash" && floorHit) crashTouch = true;
    }
    if (changed) {
      P[0] = cx;
      P[1] = cy;
      P[2] = cz;
      copy3(frame.cam.pos, P);
      frame.vel[0] = vx;
      frame.vel[1] = vy;
      frame.vel[2] = vz;
      frame.speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      lastAcc[0] = ax;
      lastAcc[1] = ay;
      lastAcc[2] = az;
    }
    if (!frame.landed && floorHit && Math.sqrt(vx * vx + vy * vy + vz * vz) < LAND_SPEED_MPS && plan !== null) {
      if (plan.kind === "crash") {
        crashRest();
      } else if ((plan.kind === "rth" || plan.kind === "land") && plan.remaining <= R.finalM + TOUCHDOWN_SLACK_M) {
        tq[0] = cx;
        tq[1] = cy;
        tq[2] = cz;
        landAt(tq);
      }
    }
    return out;
  }

  function setMode(m) {
    if (typeof m !== "string" || !CRAFT_MODES.includes(m) || m === mode) return mode;
    const prev = mode;
    mode = m;
    if (plan === null) {
      if (prev !== "cine" && m !== "cine") {
        // angle ⇄ acro share the rigid body; angle re-reads its tilt state from the attitude
        if (m === "angle") {
          setHPRFromQuat(hpr, rbQ, sv.psi);
          sv.psi = hpr.h;
          sv.pa = hpr.p;
          sv.ra = hpr.r;
          sv.pv = 0;
          sv.rv = 0;
          sv.zHold = rbPos[2];
          holdPending = Math.abs(rbVel[2]) > HOLD_LATCH_MPS;
        }
      } else {
        syncActive();
      }
    }
    return mode;
  }

  function setRates(r) {
    applyRates(r);
  }

  function autopilot(p) {
    if (p === null || p === undefined) {
      const fromCinePlan = plan !== null && plan.kind !== "crash"; // the crash camera is already body ⊗ mount
      plan = null;
      frame.autopilot = null;
      frame.autopilotDone = false;
      frame.distTouchdownM = null;
      syncActive();
      seedCineCommands();
      if (fromCinePlan && active === "rigid") startHandoverBlend(); // the camera eases from the plan's last view
      return { ok: true, kind: null };
    }
    if (typeof p !== "object") return { ok: false, kind: null };
    const kind = p.kind;
    let next = null;
    if (kind === "liftoff") next = makeLiftoff(p);
    else if (kind === "rth" || kind === "land") next = makeRoute(kind, p, kind === "rth" ? p.yaw : NaN);
    else if (kind === "hold") next = makeHold();
    else if (kind === "crash") next = makeCrash();
    if (next === null) return { ok: false, kind: typeof kind === "string" ? kind : null };
    plan = next;
    if (kind !== "hold" && kind !== "crash") frame.landed = false;
    frame.autopilot = kind;
    frame.autopilotDone = false;
    frame.distTouchdownM = kind === "rth" || kind === "land" ? routeDist(next) : null;
    syncActive();
    return { ok: true, kind };
  }

  function state() {
    const b = frame.body, c = frame.cam;
    return {
      mode,
      pos: [NUM(frame.pos[0]), NUM(frame.pos[1]), NUM(frame.pos[2])],
      vel: [NUM(frame.vel[0]), NUM(frame.vel[1]), NUM(frame.vel[2])],
      speed: NUM(frame.speed),
      body: { h: NUM(b.h), p: NUM(b.p), r: NUM(b.r), q: [NUM(b.q[0]), NUM(b.q[1]), NUM(b.q[2]), NUM(b.q[3])] },
      cam: {
        t: NUM(c.t),
        pos: [NUM(c.pos[0]), NUM(c.pos[1]), NUM(c.pos[2])],
        h: NUM(c.h),
        p: NUM(c.p),
        r: NUM(c.r),
        q: [NUM(c.q[0]), NUM(c.q[1]), NUM(c.q[2]), NUM(c.q[3])],
        fov: NUM(c.fov),
      },
      throttle: NUM(frame.throttle),
      landed: frame.landed === true,
      autopilot: frame.autopilot,
      autopilotDone: frame.autopilotDone === true,
      distTouchdownM: frame.distTouchdownM === null ? null : NUM(frame.distTouchdownM),
    };
  }

  reseed(frame.pos, 0, 0, frame.vel, false);

  return { reset, step, contact, setMode, setRates, autopilot, state };
}
