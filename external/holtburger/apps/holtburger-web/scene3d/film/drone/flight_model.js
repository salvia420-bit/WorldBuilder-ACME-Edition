// scene3d/film/drone/flight_model.js — multirotor flight model for AC Film Mode (SPEC §2.13).
//
// WHY: a technique trajectory is geometry — a perfect, massless camera path.
// Real aerial footage reads as "flown" because the craft has inertia: it
// cannot change speed or direction instantly, it leans into every
// acceleration, its gimbal lags a hair behind the operator's stick, and an
// FPV's hard-mounted camera shows every bank and nose-dip. This module turns a
// nominal pose stream into that "real drone feel" deterministically:
//
//   translation  jerk-, acceleration- and velocity-limited tracking of the
//                target position with velocity/acceleration feed-forward and a
//                braking-aware speed command (critically damped near the target,
//                never overshoots a step by more than a few percent);
//   body         attitude from the thrust vector (multirotor physics): the craft
//                pitches nose-down to accelerate / hold speed against drag and
//                banks into lateral acceleration, both ≤ maxTiltDeg, through a
//                critically damped attitude loop (finite rotational bandwidth);
//   camera       'gimbal' mount = stabilised, a critically damped (lagged)
//                follow of the target orientation with angular-rate
//                feed-forward, pitch limited to [−90°, +30°]; the horizon-roll
//                FOLLOW ERROR (camera roll − the target's own roll, measured
//                the short way across ±180°) is pulled back inside
//                ±rollLimitDeg while the horizon can be in frame, by a
//                correction that turns toward the target and shares the
//                follow's maxRateDeg budget (so it is a soft bound: a target
//                rolling faster than maxRateDeg still out-runs it) — the
//                operator's own roll (a Dutch angle, a barrel roll, the
//                inverted image of a pitch-through pass-over) is never
//                clamped, and the limit never snaps or turns the long way;
//                'hard' mount (FPV) = the target orientation carried by the
//                BODY: the physical attitude's deviation from the attitude the
//                nominal motion implies is applied in the body frame, which is
//                tilted down by the camera uptilt — so banks show up as the
//                characteristic FPV roll-plus-yaw image motion;
//   wind         optional seeded gusts (pure function of sim time) entering as
//                the differential drag force, rejected by the controller.
//
// `createDrone()` is the per-frame engine the take player uses
// (`nominal → drone dynamics → pilot residual → safety`); `flyTrajectory()`
// bakes a whole trajectory through it (scouting, rehearsal previews, tests).
//
// Conventions (SPEC §1): AC world metres (x east, y north, z up), compass
// heading h (clockwise from north), pitch p (+ up), roll r (+ = top of frame
// moves right = bank right), quaternions [w, x, y, z]. Roll > 0 banks right,
// so a craft accelerating to its right has body roll > 0.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three, no
// wasm, no clocks, no Math.random — identical inputs (and wind seed) give
// identical outputs.

import { FilmError, FILM_ERROR_CODES } from "../core/errors.js";
import { hprFromQuat, quatFromHPR, shortestAngleDiff, unwrapAngle } from "../core/gimbal.js";
import { createNoise1D, fbm1D } from "../core/noise.js";
import { qAngle, qConj, qExp, qFromAxisAngle, qLog, qMul, qNorm, qSlerp, qToBasis } from "../core/quat.js";
import { deriveSeed, seedOf } from "../core/rng.js";
import { isFiniteV } from "../core/vec3.js";
import { frameTimes, isTrajectory, makePose, TABLE_STRIDE, trajectoryFromTable } from "../shots/trajectory.js";

const DEG = Math.PI / 180;
/** Standard gravity, m/s². */
const GRAVITY = 9.80665;
/** Internal integration step (s): every step() is sub-stepped at ≤ this. */
const SUB_DT = 1 / 240;
/** Upper bound on sub-steps per step() call (a 10 s dt is still integrated, just coarser). */
const MAX_SUBSTEPS = 4800;
/** Thrust's vertical component is floored at this fraction of g when deriving tilt (free fall). */
const MIN_LIFT_FRACTION = 0.2;
/** The gimbal roll limit applies only while |forward.z| is below this (≈ ±72° pitch) for both the camera and its target: near nadir/zenith the horizon is out of frame and "roll" is just image rotation. */
const ROLL_LIMIT_MAX_SIN = Math.sin(72 * DEG);

/**
 * Flight presets (SPEC §2.13). All angles in degrees, speeds m/s, accelerations m/s², jerk m/s³.
 *  - `cinema` — smooth camera drone (vmax 12, amax 4, jmax 8, tilt 25°), stabilised gimbal;
 *  - `heavy`  — cinema lifter carrying a big camera: slower, softer, more gimbal lag;
 *  - `fpv`    — agile racing/freestyle quad (vmax 25, amax 15, tilt 60°), HARD-mounted camera with 20° uptilt;
 *  - `indoor` — small cinewhoop-style gimbal drone for interiors: slow, small tilt.
 * Keys: `mount` 'gimbal'|'hard'; `vmax`, `amax`, `jmax`; `maxTiltDeg` (body tilt limit);
 * `bandwidth` (rad/s, natural frequency of the critically damped position loop, capped at
 * 0.75·jmax/amax so the jerk-limited acceleration can always follow the loop — no overshoot);
 * `brakeFraction` (share of amax planned for braking along the jerk-aware braking curve);
 * `drag` (1/m, quadratic drag per unit mass → tilt needed to hold speed);
 * `rotSmoothSec` (camera follow time constant); `maxRateDeg` (camera angular-rate limit, °/s);
 * `yawSmoothSec` (body yaw follow); `attSmoothSec` (attitude-loop time constant: the body's tilt —
 * and a hard-mounted camera's deviation — follow their demanded values critically damped, so
 * the image never jumps faster than the craft can rotate); `pitchMinDeg`/`pitchMaxDeg` (gimbal pitch
 * stops); `rollLimitDeg` (gimbal horizon-roll FOLLOW-ERROR limit: the camera's horizon roll is pulled
 * back, at ≤ maxRateDeg, to within ±rollLimitDeg of the tracked target's own horizon roll, measured
 * the short way across ±180°, while both look within 72° of level — the target's deliberate roll is
 * never clamped; 180 = off);
 * `uptiltDeg` (hard-mount camera uptilt above the body's forward axis).
 * @type {Readonly<Record<'cinema'|'heavy'|'fpv'|'indoor', Readonly<Object>>>}
 */
export const DRONE_PRESETS = Object.freeze({
  cinema: Object.freeze({
    name: "cinema", mount: "gimbal", vmax: 12, amax: 4, jmax: 8, maxTiltDeg: 25, bandwidth: 2.2, brakeFraction: 0.6,
    drag: 0.03, rotSmoothSec: 0.25, maxRateDeg: 120, yawSmoothSec: 0.35, attSmoothSec: 0.15, pitchMinDeg: -90,
    pitchMaxDeg: 30, rollLimitDeg: 45, uptiltDeg: 0,
  }),
  heavy: Object.freeze({
    name: "heavy", mount: "gimbal", vmax: 7, amax: 2.5, jmax: 4, maxTiltDeg: 20, bandwidth: 1.6, brakeFraction: 0.6,
    drag: 0.04, rotSmoothSec: 0.4, maxRateDeg: 80, yawSmoothSec: 0.5, attSmoothSec: 0.2, pitchMinDeg: -90,
    pitchMaxDeg: 30, rollLimitDeg: 45, uptiltDeg: 0,
  }),
  fpv: Object.freeze({
    name: "fpv", mount: "hard", vmax: 25, amax: 15, jmax: 60, maxTiltDeg: 60, bandwidth: 5, brakeFraction: 0.7,
    drag: 0.025, rotSmoothSec: 0.06, maxRateDeg: 720, yawSmoothSec: 0.08, attSmoothSec: 0.1, pitchMinDeg: -90,
    pitchMaxDeg: 90, rollLimitDeg: 180, uptiltDeg: 20,
  }),
  indoor: Object.freeze({
    name: "indoor", mount: "gimbal", vmax: 4, amax: 2, jmax: 5, maxTiltDeg: 12, bandwidth: 2.5, brakeFraction: 0.6,
    drag: 0.05, rotSmoothSec: 0.3, maxRateDeg: 90, yawSmoothSec: 0.35, attSmoothSec: 0.15, pitchMinDeg: -90,
    pitchMaxDeg: 30, rollLimitDeg: 45, uptiltDeg: 0,
  }),
});

/** Names of the shipped presets. @type {ReadonlyArray<string>} */
export const DRONE_PRESET_NAMES = Object.freeze(Object.keys(DRONE_PRESETS));

/**
 * Numeric config keys and their legal ranges `[min, max, minExclusive]` (degrees / SI units).
 * @type {Readonly<Record<string, ReadonlyArray<number|boolean>>>}
 */
const NUMERIC_RULES = Object.freeze({
  vmax: [0, 200, true],
  amax: [0, 200, true],
  jmax: [0, 10000, true],
  maxTiltDeg: [0, 89, true],
  bandwidth: [0, 100, true],
  brakeFraction: [0, 1, true],
  drag: [0, 10, false],
  rotSmoothSec: [0, 10, false],
  maxRateDeg: [0, 7200, true],
  yawSmoothSec: [0, 10, false],
  attSmoothSec: [0, 5, false],
  pitchMinDeg: [-90, 0, false],
  pitchMaxDeg: [0, 90, false],
  rollLimitDeg: [0, 180, false],
  uptiltDeg: [-45, 60, false],
});

const CONFIG_KEYS = Object.freeze(["preset", "name", "mount", "wind", ...Object.keys(NUMERIC_RULES)]);

/** @param {string} msg @returns {FilmError} */
function badArg(msg) {
  return new FilmError(msg, FILM_ERROR_CODES.BAD_ARGUMENT);
}

/** Readable value for messages. */
function show(v) {
  if (typeof v === "string") return JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Resolve and validate a preset name or config object into a complete, frozen config.
 * Accepts: undefined/null (→ cinema), a preset name, or `{preset?, ...overrides, wind?}`.
 * Unknown keys / preset names and out-of-range values throw FilmError (BAD_ARGUMENT).
 * @param {string|Object|null|undefined} presetOrConfig
 * @returns {Readonly<Object>}
 */
export function resolveDroneConfig(presetOrConfig) {
  const src = presetOrConfig === undefined || presetOrConfig === null ? "cinema" : presetOrConfig;
  let base;
  let over = {};
  if (typeof src === "string") {
    if (!Object.prototype.hasOwnProperty.call(DRONE_PRESETS, src)) {
      throw badArg(`createDrone: unknown preset ${show(src)} (valid: ${DRONE_PRESET_NAMES.join(", ")})`);
    }
    base = DRONE_PRESETS[src];
  } else if (typeof src === "object" && !Array.isArray(src)) {
    for (const k of Object.keys(src)) {
      if (!CONFIG_KEYS.includes(k)) throw badArg(`createDrone: unknown config key "${k}" (valid: ${CONFIG_KEYS.join(", ")})`);
    }
    const pName = src.preset === undefined || src.preset === null ? "cinema" : src.preset;
    if (typeof pName !== "string" || !Object.prototype.hasOwnProperty.call(DRONE_PRESETS, pName)) {
      throw badArg(`createDrone: unknown preset ${show(pName)} (valid: ${DRONE_PRESET_NAMES.join(", ")})`);
    }
    base = DRONE_PRESETS[pName];
    over = src;
  } else {
    throw badArg(`createDrone: expected a preset name (${DRONE_PRESET_NAMES.join(", ")}) or a config object (got ${show(src)})`);
  }
  const cfg = { ...base };
  for (const [k, rule] of Object.entries(NUMERIC_RULES)) {
    if (over[k] === undefined || over[k] === null) continue;
    const v = over[k];
    const [lo, hi, exclusive] = rule;
    const ok = typeof v === "number" && Number.isFinite(v) && (exclusive ? v > lo : v >= lo) && v <= hi;
    if (!ok) throw badArg(`createDrone: ${k} must be a number in ${exclusive ? "(" : "["}${lo}, ${hi}] (got ${show(v)})`);
    cfg[k] = v;
  }
  if (over.mount !== undefined && over.mount !== null) {
    if (over.mount !== "gimbal" && over.mount !== "hard") throw badArg(`createDrone: mount must be "gimbal" or "hard" (got ${show(over.mount)})`);
    cfg.mount = over.mount;
  }
  if (over.name !== undefined && over.name !== null) {
    if (typeof over.name !== "string" || !over.name) throw badArg("createDrone: name must be a non-empty string");
    cfg.name = over.name;
  }
  if (cfg.pitchMinDeg > cfg.pitchMaxDeg) throw badArg("createDrone: pitchMinDeg must be ≤ pitchMaxDeg");
  cfg.preset = base.name;
  let wind = null;
  if (over.wind !== undefined && over.wind !== null) {
    const w = over.wind;
    if (typeof w !== "object" || Array.isArray(w)) throw badArg("createDrone: wind must be an object {gustMps, seed, frequencyHz?}");
    for (const k of Object.keys(w)) {
      if (!["gustMps", "seed", "frequencyHz"].includes(k)) throw badArg(`createDrone: unknown wind key "${k}" (valid: gustMps, seed, frequencyHz)`);
    }
    const g = w.gustMps === undefined ? 0 : w.gustMps;
    if (!(typeof g === "number" && Number.isFinite(g) && g >= 0 && g <= 60)) throw badArg(`createDrone: wind.gustMps must be a number in [0, 60] (got ${show(g)})`);
    const f = w.frequencyHz === undefined ? 0.3 : w.frequencyHz;
    if (!(typeof f === "number" && Number.isFinite(f) && f > 0 && f <= 20)) throw badArg(`createDrone: wind.frequencyHz must be a number in (0, 20] (got ${show(f)})`);
    wind = Object.freeze({ gustMps: g, seed: seedOf(w.seed === undefined ? 0 : w.seed), frequencyHz: f });
  }
  cfg.wind = wind;
  return Object.freeze(cfg);
}

// ---------------------------------------------------------------------------
// small vector helpers (local: hot loop, no allocation-heavy helpers)
// ---------------------------------------------------------------------------

function vlen(a) {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

function vdot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** a − n·(a·n) for a unit n: removes the component of a along n. */
function removeAlong(a, n) {
  const k = vdot(a, n);
  return [a[0] - n[0] * k, a[1] - n[1] * k, a[2] - n[2] * k];
}

/** Copy of `a` scaled down to length ≤ max. */
function clampV(a, max) {
  const l = vlen(a);
  if (!(l > max)) return [a[0], a[1], a[2]];
  const s = max / l;
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** Shortest-arc world-frame rotation vector (axis·angle) taking orientation a to b. */
function rotVec(a, b) {
  let r = qMul(b, qConj(a));
  if (r[0] < 0) r = [-r[0], -r[1], -r[2], -r[3]];
  const h = qLog(r);
  return [2 * h[0], 2 * h[1], 2 * h[2]];
}

/** Apply a world-frame rotation vector ω·dt to q. */
function rotate(q, w, dt) {
  return qNorm(qMul(qExp([w[0] * dt * 0.5, w[1] * dt * 0.5, w[2] * dt * 0.5]), q));
}

/** Quaternion of a loose pose ({q} or {h, p, r}); null when unusable. */
function poseQuat(p) {
  if (!p || typeof p !== "object") return null;
  const q = p.q;
  if (q && Number.isFinite(q[0]) && Number.isFinite(q[1]) && Number.isFinite(q[2]) && Number.isFinite(q[3]) &&
    q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] > 1e-24) return qNorm(q);
  if (Number.isFinite(p.h) && Number.isFinite(p.p)) return quatFromHPR(p.h, p.p, Number.isFinite(p.r) ? p.r : 0);
  return null;
}

/**
 * Forward tilt (nose-down positive) and bank (right positive) of a thrust vector in the yaw frame ψ,
 * each limited so the total tilt stays ≤ maxTilt (radians).
 */
function tiltOf(T, psi, maxTilt) {
  const fx = Math.sin(psi), fy = Math.cos(psi);
  const tf = T[0] * fx + T[1] * fy;
  const tr = T[0] * fy - T[1] * fx;
  const tz = Math.max(T[2], MIN_LIFT_FRACTION * GRAVITY);
  let th = Math.atan2(tf, tz);
  let ph = Math.atan2(tr, tz);
  const tot = Math.sqrt(th * th + ph * ph);
  if (tot > maxTilt && tot > 0) {
    th *= maxTilt / tot;
    ph *= maxTilt / tot;
  }
  return { th, ph };
}

/**
 * Horizon roll (radians, + = bank right, ±π = an inverted image) of a camera basis
 * `{forward, right}`: the angle of `right` from the level right axis R0 = forward × up, measured
 * about forward. null while |forward.z| ≥ sin 72°: near nadir/zenith the horizon is out of frame
 * and the roll is ill-conditioned (an image rotation, not a horizon tilt).
 * @param {{forward:number[], right:number[]}} B
 * @returns {number|null}
 */
function horizonRoll(B) {
  const F = B.forward;
  if (!(Math.abs(F[2]) < ROLL_LIMIT_MAX_SIN)) return null;
  const hl = Math.hypot(F[0], F[1]);
  const R0 = [F[1] / hl, -F[0] / hl, 0];
  const U0 = [R0[1] * F[2] - R0[2] * F[1], R0[2] * F[0] - R0[0] * F[2], R0[0] * F[1] - R0[1] * F[0]];
  return Math.atan2(-vdot(B.right, U0), vdot(B.right, R0));
}

/**
 * hprFromQuat with a KNOWN roll resolving the vertical ambiguity: when the forward vector is
 * (numerically) vertical only h ± r is fixed by q, so the split is chosen to keep r = rollHint
 * (nadir: h + r invariant; zenith: h − r invariant). A top-down shot rotating its image then
 * reads as a heading change, never as a camera roll.
 */
function decompose(q, headingHint, rollHint) {
  const e = hprFromQuat(q, headingHint, rollHint);
  if (Math.cos(e.p) < 1e-6 && Number.isFinite(rollHint)) {
    const s = -Math.sin(e.p) >= 0 ? 1 : -1;
    return { h: e.h + s * (e.r - rollHint), p: e.p, r: rollHint };
  }
  return e;
}

/** Thrust acceleration (per unit mass) for net acceleration a at velocity v with quadratic drag c. */
function thrustOf(a, v, c) {
  const s = vlen(v);
  return [a[0] + c * v[0] * s, a[1] + c * v[1] * s, a[2] + c * v[2] * s + GRAVITY];
}

// ---------------------------------------------------------------------------
// createDrone
// ---------------------------------------------------------------------------

/**
 * Create a stateful multirotor (SPEC §2.13).
 *
 * `reset(pose, {velocity?, acceleration?})` places the craft (finite `pos` and `q` or `h/p`) and
 * returns the camera Pose; throws FilmError on an unusable pose. `step(targetPose, dt)` advances
 * `dt` seconds toward the target Pose (optional `vel` / `acc` fields are used as exact
 * feed-forward; otherwise they are estimated from successive targets, and a target jump faster
 * than 1.5·vmax is treated as a step, not a velocity) and returns the realised camera Pose
 * `{t, pos, h, p, r, q, fov, focus?}`. A non-finite target position / orientation holds the
 * previous one; dt ≤ 0 or non-finite returns the current pose; the first step without a reset
 * snaps to the target. `state()` is a JSON-safe snapshot: position, velocity, acceleration,
 * speed, body attitude {h, p, r} (radians; physical thrust attitude: p < 0 nose-down, r > 0 bank
 * right), camera {h, p, r, q}, tracking error, config.
 *
 * Guarantees (no wind): |v| ≤ vmax, |a| ≤ amax and |Δa|/dt ≤ jmax for the commanded
 * acceleration; gimbal camera pitch ∈ [pitchMinDeg, pitchMaxDeg] (default [−90°, +30°]); the
 * gimbal's horizon-roll follow error |shortestAngleDiff(camera roll, target roll)| is pulled back
 * toward ≤ rollLimitDeg while both the camera and its target are at |pitch| < 72° (near nadir a
 * heading slew is an image rotation, never clamped as roll). The limit bounds follow error only:
 * the target's deliberate roll — a Dutch angle, a barrel roll, the inverted image of a
 * 'pitch-through' pass-over — is carried; the correction turns toward the target the short way
 * (a roll crossing ±180° never sends the camera the long way round) and shares the follow's
 * angular-rate budget, so the gimbal never rotates faster than maxRateDeg (a target rolling faster
 * than that leaves a larger lag, never a snap); body tilt ≤ maxTiltDeg; deterministic.
 * @param {string|Object} [presetOrConfig='cinema'] preset name or `{preset, ...overrides, wind:{gustMps, seed, frequencyHz}}`
 * @returns {{reset:(pose:Object, opts?:{velocity?:number[], acceleration?:number[]})=>Object,
 *   step:(targetPose:Object, dt:number)=>Object, state:()=>Object, config:Readonly<Object>}}
 */
export function createDrone(presetOrConfig) {
  const cfg = resolveDroneConfig(presetOrConfig);
  const vmax = cfg.vmax, amax = cfg.amax, jmax = cfg.jmax;
  // Velocity-loop gain: the jerk limit can only follow an acceleration demand that decays at
  // ≤ jmax/amax·a, so kv ≤ 1.5·jmax/amax keeps the loop out of jerk saturation; kp = kv/4 makes
  // the position loop critically damped (natural frequency kv/2).
  const kv = Math.min(2 * cfg.bandwidth, (1.5 * jmax) / amax);
  const kp = kv / 4;
  const aBrake = cfg.brakeFraction * amax;
  // Jerk-aware braking curve: the largest approach speed that can still stop within d using
  // deceleration aBrake entered with jerk jmax: v²/(2·aB) + v·aB/(2·j) = d.
  const brakeA = (aBrake * aBrake) / (2 * jmax);
  const brakeSpeed = (d) => -brakeA + Math.sqrt(brakeA * brakeA + 2 * aBrake * d);
  const maxTilt = cfg.maxTiltDeg * DEG;
  const maxRate = cfg.maxRateDeg * DEG;
  const wRot = cfg.rotSmoothSec > 1e-6 ? 2 / cfg.rotSmoothSec : Infinity;
  const wYaw = cfg.yawSmoothSec > 1e-6 ? 2 / cfg.yawSmoothSec : Infinity;
  const wAtt = cfg.attSmoothSec > 1e-6 ? 2 / cfg.attSmoothSec : Infinity;
  const pitchMin = cfg.pitchMinDeg * DEG, pitchMax = cfg.pitchMaxDeg * DEG, rollLim = cfg.rollLimitDeg * DEG;
  const hard = cfg.mount === "hard";
  const uptilt = cfg.uptiltDeg * DEG;
  const qUp = qFromAxisAngle([1, 0, 0], uptilt);
  const qUpInv = qConj(qUp);

  let windFn = null;
  if (cfg.wind && cfg.wind.gustMps > 0) {
    const nx = createNoise1D(deriveSeed(cfg.wind.seed, "wind:x"));
    const ny = createNoise1D(deriveSeed(cfg.wind.seed, "wind:y"));
    const nz = createNoise1D(deriveSeed(cfg.wind.seed, "wind:z"));
    const g = cfg.wind.gustMps, f = cfg.wind.frequencyHz;
    const fb = { octaves: 3, lacunarity: 2, gain: 0.5 };
    windFn = (t) => [g * fbm1D(nx, t * f, fb), g * fbm1D(ny, t * f, fb), 0.3 * g * fbm1D(nz, t * f, fb)];
  }

  /** @type {null|Object} */
  let S = null;

  function poseOut() {
    const e = decompose(S.qCam, S.camH, S.rollT);
    S.camH = e.h;
    const fields = { t: S.tOut, pos: S.x.slice(), q: S.qCam, h: e.h, r: e.r, fov: S.fov };
    if (S.focus !== undefined) fields.focus = S.focus;
    return makePose(fields);
  }

  /**
   * Apply the gimbal limits to the follow orientation after a follow sub-step of `h` seconds,
   * measured from the camera basis (never from an ill-conditioned near-vertical h/p/r
   * decomposition).
   *
   * Pitch: the elevation of forward is clamped to [pitchMin, pitchMax] by a rotation about the
   * horizontal axis ⊥ forward; angular velocity pushing past the stop is removed.
   *
   * Roll bounds FOLLOW ERROR, never the operator's intent. The error is the camera's horizon roll
   * minus the tracked target's own (`qTarget`), taken with shortestAngleDiff so a roll crossing
   * ±180° is one continuous angle (an absolute band — or one symmetric about level — would push a
   * lagging camera the long way round once the target crosses the seam). Past ±rollLimitDeg the
   * camera is rotated about forward TOWARD the target, the short way, by at most the angular-rate
   * budget the follow loop left this sub-step: follow + correction ≤ maxRateDeg·h, so a target
   * rolling faster than the gimbal can follow leaves a larger lag, never a snap. Nothing is
   * corrected while the camera or the target looks (nearly) straight down/up (no horizon in frame;
   * roll there is an image rotation). The follow velocity is left alone: it already turns toward
   * the target the same short way. A deliberate roll — a Dutch angle, a barrel roll, the inverted
   * image of drone.pass-over nadirMode 'pitch-through' — has zero error and is carried as is.
   * @param {number[]} qTarget orientation being tracked this sub-step
   * @param {number} h sub-step length (s); 0 at a reset (pitch stops only: the camera IS its target)
   */
  function applyGimbalLimits(qTarget, h) {
    const wStep = S.wF; // the follow rotated qF by wStep·h this sub-step
    let B = qToBasis(S.qF);
    let F = B.forward;
    const p = Math.asin(Math.max(-1, Math.min(1, F[2])));
    if (p > pitchMax || p < pitchMin) {
      const lim = p > pitchMax ? pitchMax : pitchMin;
      const hl = Math.hypot(F[0], F[1]);
      const axis = hl > 1e-9 ? [F[1] / hl, -F[0] / hl, 0] : B.right;
      S.qF = qNorm(qMul(qFromAxisAngle(axis, lim - p), S.qF));
      const wr = vdot(S.wF, axis);
      if ((p > pitchMax && wr > 0) || (p < pitchMin && wr < 0)) S.wF = removeAlong(S.wF, axis);
      B = qToBasis(S.qF);
      F = B.forward;
    }
    if (!(rollLim < Math.PI) || !(h > 0)) return;
    const r = horizonRoll(B);
    if (r === null) return;
    const rT = horizonRoll(qToBasis(qTarget));
    if (rT === null) return;
    const e = shortestAngleDiff(r, rT);
    const over = Math.abs(e) - rollLim;
    if (!(over > 0)) return;
    // A rotation by θ about forward changes the horizon roll by +θ: turn by s·c, s toward the target.
    const s = e > 0 ? -1 : 1;
    const budget = maxRate * h;
    const along = vdot(wStep, F) * h; // the follow's own rotation about forward this sub-step
    const perp2 = Math.max(0, vdot(wStep, wStep) * h * h - along * along);
    // largest c ≥ 0 with |wStep·h + s·c·F| ≤ budget
    const room = Math.sqrt(Math.max(0, budget * budget - perp2)) - s * along;
    const c = Math.min(over, room);
    if (!(c > 0)) return;
    S.qF = qNorm(qMul(qFromAxisAngle(F, s * c), S.qF));
  }

  /** Demanded physical tilt {th (nose-down +), ph (bank right +)} for the current thrust. */
  function demandedTilt() {
    return tiltOf(thrustOf(S.a, S.v, cfg.drag), S.psi, maxTilt);
  }

  /**
   * Demanded hard-mount deviation {p (pitch up +), r (roll right +)}: the body's attitude
   * DEVIATES from the attitude the nominal motion implies (linearised about hover: an
   * acceleration error Δa leans the craft by atan(Δa/g)). The nominal acceleration is
   * jerk-limited like the craft's, so a jerk-feasible track shows no deviation; saturation
   * lurches and wind gusts do.
   */
  function demandedDeviation() {
    const s1 = vlen(S.v), s2 = vlen(S.vT), c = cfg.drag;
    const dx = S.a[0] - S.aTf[0] + c * (S.v[0] * s1 - S.vT[0] * s2);
    const dy = S.a[1] - S.aTf[1] + c * (S.v[1] * s1 - S.vT[1] * s2);
    const fx = Math.sin(S.psi), fy = Math.cos(S.psi);
    const clampT = (x) => (x > maxTilt ? maxTilt : x < -maxTilt ? -maxTilt : x);
    return { p: clampT(-Math.atan((dx * fx + dy * fy) / GRAVITY)), r: clampT(Math.atan((dx * fy - dy * fx) / GRAVITY)) };
  }

  /** One critically damped attitude-loop step of a 2-angle state toward a demand. */
  function attStep(st, d0, d1, h) {
    if (wAtt === Infinity) return { a: d0, b: d1, va: 0, vb: 0 };
    const k = wAtt * wAtt, c = 2 * wAtt;
    const va = st.va + (k * (d0 - st.a) - c * st.va) * h;
    const vb = st.vb + (k * (d1 - st.b) - c * st.vb) * h;
    return { a: st.a + va * h, b: st.b + vb * h, va, vb };
  }

  /** Advance the attitude loops (body tilt and, for a hard mount, the camera deviation) by h. */
  function stepAttitude(h) {
    const dt = demandedTilt();
    S.tilt = attStep(S.tilt, dt.th, dt.ph, h);
    const tot = Math.hypot(S.tilt.a, S.tilt.b);
    if (tot > maxTilt) {
      S.tilt.a *= maxTilt / tot;
      S.tilt.b *= maxTilt / tot;
    }
    if (hard) {
      const dd = demandedDeviation();
      S.dev = attStep(S.dev, dd.p, dd.r, h);
    }
  }

  /** Body attitude and camera orientation from the current attitude-loop state. */
  function updateAttitude() {
    S.body = { h: S.psi, p: -S.tilt.a, r: S.tilt.b };
    if (!hard || (S.dev.a === 0 && S.dev.b === 0)) {
      S.qCam = S.qF;
      return;
    }
    const dev = quatFromHPR(0, S.dev.a, S.dev.b);
    S.qCam = qNorm(qMul(qMul(qMul(S.qF, qUpInv), dev), qUp));
  }

  function reset(pose, opts = {}) {
    if (!pose || typeof pose !== "object" || !isFiniteV(pose.pos)) {
      throw badArg("drone.reset: pose with a finite pos [x,y,z] is required");
    }
    const q = poseQuat(pose);
    if (!q) throw badArg("drone.reset: pose needs a finite quaternion q or heading/pitch h, p");
    const o = opts || {};
    const v0 = isFiniteV(o.velocity) ? clampV(o.velocity, vmax) : [0, 0, 0];
    const a0 = isFiniteV(o.acceleration) ? clampV(o.acceleration, amax) : [0, 0, 0];
    const e = hprFromQuat(q, Number.isFinite(pose.h) ? pose.h : 0, Number.isFinite(pose.r) ? pose.r : undefined);
    const fov = Number.isFinite(pose.fov) && pose.fov > 0 && pose.fov < 180 ? pose.fov : 60;
    S = {
      x: [pose.pos[0], pose.pos[1], pose.pos[2]],
      v: v0,
      a: a0,
      qF: q,
      wF: [0, 0, 0],
      qCam: q,
      psi: e.h,
      psiV: 0,
      tSim: Number.isFinite(pose.t) ? pose.t : 0,
      tOut: Number.isFinite(pose.t) ? pose.t : 0,
      fov,
      focus: Number.isFinite(pose.focus) && pose.focus > 0 ? pose.focus : undefined,
      lastPos: [pose.pos[0], pose.pos[1], pose.pos[2]],
      lastQ: q,
      lastH: e.h,
      vT: v0.slice(),
      aT: a0.slice(),
      aTf: a0.slice(),
      wT: [0, 0, 0],
      camH: e.h,
      rollT: e.r,
      body: { h: e.h, p: 0, r: 0 },
      tilt: { a: 0, b: 0, va: 0, vb: 0 },
      dev: { a: 0, b: 0, va: 0, vb: 0 },
      err: 0,
    };
    const t0 = demandedTilt();
    S.tilt = { a: t0.th, b: t0.ph, va: 0, vb: 0 };
    if (!hard) applyGimbalLimits(q, 0);
    updateAttitude();
    return poseOut();
  }

  function step(targetPose, dt) {
    const tp = targetPose && typeof targetPose === "object" ? targetPose : {};
    if (!S) {
      if (isFiniteV(tp.pos) && poseQuat(tp)) return reset(tp);
      throw badArg("drone.step: the first target (or a reset) needs a finite pos and orientation");
    }
    if (!(Number.isFinite(dt) && dt > 0)) return poseOut();

    // ---- target + feed-forward estimates --------------------------------------------------
    const posT = isFiniteV(tp.pos) ? [tp.pos[0], tp.pos[1], tp.pos[2]] : S.lastPos.slice();
    const qTraw = poseQuat(tp);
    const qT = qTraw ? (qTraw[0] * S.lastQ[0] + qTraw[1] * S.lastQ[1] + qTraw[2] * S.lastQ[2] + qTraw[3] * S.lastQ[3] < 0
      ? [-qTraw[0], -qTraw[1], -qTraw[2], -qTraw[3]] : qTraw) : S.lastQ;
    let hT;
    if (Number.isFinite(tp.h)) hT = unwrapAngle(tp.h, S.lastH);
    else hT = hprFromQuat(qT, S.lastH).h;
    if (qTraw) S.rollT = Number.isFinite(tp.r) ? tp.r : hprFromQuat(qT, hT, S.rollT).r;
    if (Number.isFinite(tp.fov) && tp.fov > 0 && tp.fov < 180) S.fov = tp.fov;
    if (tp.focus !== undefined) S.focus = Number.isFinite(tp.focus) && tp.focus > 0 ? tp.focus : undefined;
    S.tOut = Number.isFinite(tp.t) ? tp.t : S.tOut + dt;

    const diff = [(posT[0] - S.lastPos[0]) / dt, (posT[1] - S.lastPos[1]) / dt, (posT[2] - S.lastPos[2]) / dt];
    const jumped = vlen(diff) > 1.5 * vmax;
    let vT;
    if (isFiniteV(tp.vel)) vT = clampV(tp.vel, vmax);
    else vT = jumped ? [0, 0, 0] : clampV(diff, vmax);
    let aT;
    if (isFiniteV(tp.acc)) aT = clampV(tp.acc, amax);
    else if (jumped) aT = [0, 0, 0];
    else {
      const k = 1 - Math.exp(-dt / 0.15);
      const raw = [(vT[0] - S.vT[0]) / dt, (vT[1] - S.vT[1]) / dt, (vT[2] - S.vT[2]) / dt];
      aT = clampV([S.aT[0] + (raw[0] - S.aT[0]) * k, S.aT[1] + (raw[1] - S.aT[1]) * k, S.aT[2] + (raw[2] - S.aT[2]) * k], amax);
    }
    let wT = rotVec(S.lastQ, qT).map((c) => c / dt);
    if (vlen(wT) > 1.5 * maxRate) wT = [0, 0, 0];
    else wT = clampV(wT, maxRate);
    const hRate = Math.max(-maxRate, Math.min(maxRate, (hT - S.lastH) / dt));

    // ---- integrate --------------------------------------------------------------------------
    const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / SUB_DT - 1e-9)));
    const h = dt / n;
    const p0 = S.lastPos, q0 = S.lastQ, h0 = S.lastH;
    let err = 0;
    for (let j = 1; j <= n; j++) {
      const f = j / n;
      const xT = [p0[0] + (posT[0] - p0[0]) * f, p0[1] + (posT[1] - p0[1]) * f, p0[2] + (posT[2] - p0[2]) * f];
      // translation: braking-aware speed command toward the (interpolated) target + feed-forward
      const e = [xT[0] - S.x[0], xT[1] - S.x[1], xT[2] - S.x[2]];
      const d = vlen(e);
      let vDes = vT.slice();
      if (d > 1e-12) {
        const vc = Math.min(vmax, kp * d, brakeSpeed(d));
        vDes = [vDes[0] + (e[0] / d) * vc, vDes[1] + (e[1] / d) * vc, vDes[2] + (e[2] / d) * vc];
      }
      vDes = clampV(vDes, vmax);
      let aDes = [aT[0] + kv * (vDes[0] - S.v[0]), aT[1] + kv * (vDes[1] - S.v[1]), aT[2] + kv * (vDes[2] - S.v[2])];
      aDes = clampV(aDes, amax);
      const da = clampV([aDes[0] - S.a[0], aDes[1] - S.a[1], aDes[2] - S.a[2]], jmax * h);
      S.a = clampV([S.a[0] + da[0], S.a[1] + da[1], S.a[2] + da[2]], amax);
      const dn = clampV([aT[0] - S.aTf[0], aT[1] - S.aTf[1], aT[2] - S.aTf[2]], jmax * h);
      S.aTf = [S.aTf[0] + dn[0], S.aTf[1] + dn[1], S.aTf[2] + dn[2]];
      let aw = [0, 0, 0];
      S.tSim += h;
      if (windFn) {
        // Differential drag of the gust: D(w − v) − D(−v), with D(u) = c·u·|u|.
        const w = windFn(S.tSim);
        const ra = [w[0] - S.v[0], w[1] - S.v[1], w[2] - S.v[2]];
        const la = vlen(ra), lv = vlen(S.v);
        const c = Math.max(cfg.drag, 0.02);
        aw = [c * (ra[0] * la + S.v[0] * lv), c * (ra[1] * la + S.v[1] * lv), c * (ra[2] * la + S.v[2] * lv)];
      }
      S.v = clampV([S.v[0] + (S.a[0] + aw[0]) * h, S.v[1] + (S.a[1] + aw[1]) * h, S.v[2] + (S.a[2] + aw[2]) * h], vmax);
      S.x = [S.x[0] + S.v[0] * h, S.x[1] + S.v[1] * h, S.x[2] + S.v[2] * h];
      err = d;

      // body yaw: critically damped follow of the target heading with rate feed-forward
      const hTj = h0 + (hT - h0) * f;
      if (wYaw === Infinity) {
        S.psi = hTj;
        S.psiV = hRate;
      } else {
        const ex = S.psi - hTj;
        const ev = S.psiV - hRate;
        const acc = -wYaw * wYaw * ex - 2 * wYaw * ev;
        S.psiV = Math.max(-maxRate, Math.min(maxRate, S.psiV + acc * h));
        S.psi += S.psiV * h;
      }

      // camera follow: critically damped rotation-vector tracking with angular-rate feed-forward
      const qTj = qSlerp(q0, qT, f);
      if (wRot === Infinity) {
        S.qF = qTj;
        S.wF = wT.slice();
      } else {
        const er = rotVec(S.qF, qTj);
        const al = [wRot * wRot * er[0] + 2 * wRot * (wT[0] - S.wF[0]),
          wRot * wRot * er[1] + 2 * wRot * (wT[1] - S.wF[1]),
          wRot * wRot * er[2] + 2 * wRot * (wT[2] - S.wF[2])];
        S.wF = clampV([S.wF[0] + al[0] * h, S.wF[1] + al[1] * h, S.wF[2] + al[2] * h], maxRate);
        S.qF = rotate(S.qF, S.wF, h);
      }
      if (!hard) applyGimbalLimits(qTj, h);
      stepAttitude(h);
    }
    S.vT = vT;
    S.aT = aT;
    S.wT = wT;
    S.lastPos = posT;
    S.lastQ = qT;
    S.lastH = hT;
    S.err = err;
    updateAttitude();
    return poseOut();
  }

  function state() {
    if (!S) return { initialized: false, preset: cfg.preset, name: cfg.name, mount: cfg.mount };
    const cam = decompose(S.qCam, S.camH, S.rollT);
    const r6 = (v) => v.map((c) => c);
    return {
      initialized: true,
      preset: cfg.preset,
      name: cfg.name,
      mount: cfg.mount,
      t: S.tOut,
      simTime: S.tSim,
      pos: r6(S.x),
      vel: r6(S.v),
      acc: r6(S.a),
      speed: vlen(S.v),
      body: { h: S.body.h, p: S.body.p, r: S.body.r },
      camera: { h: cam.h, p: cam.p, r: cam.r, q: S.qCam.slice() },
      target: { pos: S.lastPos.slice(), vel: S.vT.slice(), acc: S.aT.slice() },
      trackingError: S.err,
      limits: { vmax, amax, jmax, maxTiltDeg: cfg.maxTiltDeg, pitchMinDeg: cfg.pitchMinDeg, pitchMaxDeg: cfg.pitchMaxDeg },
      wind: cfg.wind ? { gustMps: cfg.wind.gustMps, seed: cfg.wind.seed, frequencyHz: cfg.wind.frequencyHz } : null,
    };
  }

  return { reset, step, state, config: cfg };
}

// ---------------------------------------------------------------------------
// flyTrajectory
// ---------------------------------------------------------------------------

/**
 * The flight preset a trajectory should be flown with when none is given:
 * 'fpv' for the fpv family, `traj.meta.flightPreset` when it names a preset,
 * 'indoor' when `opts.indoor`, else 'cinema'.
 * @param {{family?:string, meta?:Object}} traj
 * @param {{indoor?:boolean}} [opts]
 * @returns {'cinema'|'heavy'|'fpv'|'indoor'}
 */
export function presetForTrajectory(traj, opts = {}) {
  const t = traj && typeof traj === "object" ? traj : {};
  const m = t.meta && typeof t.meta === "object" ? t.meta.flightPreset : undefined;
  if (typeof m === "string" && Object.prototype.hasOwnProperty.call(DRONE_PRESETS, m)) return m;
  if (t.family === "fpv") return "fpv";
  if (opts && opts.indoor) return "indoor";
  return "cinema";
}

/** Position of a trajectory at t (clamped). */
function posAt(traj, t) {
  return traj.sample(t).pos;
}

/**
 * Central-difference velocity and acceleration of the nominal path at t (one-sided at the ends,
 * and forward-only right after a cut so the stencil never straddles it).
 */
function derivatives(traj, t, D, hd, forwardOnly = false) {
  if (!(D > 0)) return { vel: [0, 0, 0], acc: [0, 0, 0] };
  let a = forwardOnly ? t : t - hd, b = forwardOnly ? t + 2 * hd : t + hd;
  if (a < 0) { b -= a; a = 0; }
  if (b > D) { a = Math.max(0, a - (b - D)); b = D; }
  const m = (a + b) / 2;
  const pa = posAt(traj, a), pm = posAt(traj, m), pb = posAt(traj, b);
  const w = b - a;
  if (!(w > 0)) return { vel: [0, 0, 0], acc: [0, 0, 0] };
  const vel = [(pb[0] - pa[0]) / w, (pb[1] - pa[1]) / w, (pb[2] - pa[2]) / w];
  const hh = w / 2;
  const acc = [(pb[0] - 2 * pm[0] + pa[0]) / (hh * hh), (pb[1] - 2 * pm[1] + pa[1]) / (hh * hh), (pb[2] - 2 * pm[2] + pa[2]) / (hh * hh)];
  return { vel, acc };
}

/**
 * Fly a trajectory through the flight model and bake the realised "real drone feel" camera path
 * (SPEC §2.13). Frames at frameTimes(duration, fps); the nominal path supplies exact
 * velocity/acceleration feed-forward, the craft starts with the nominal velocity (in-motion shots
 * start in motion) and is re-placed at every declared cut (`meta.cuts`, e.g. a concat with
 * bridge 'cut') instead of flying across it. When a shot that ends (nearly) at rest has not caught the nominal end pose
 * (≤ 5 cm and ≤ 0.5°) at the nominal duration, the take overruns — holding the end pose — by at
 * most 10% of the duration; an in-motion ending is never extended (`settled` reports whether the
 * last frame is within tolerance). Returns a replay Trajectory (trajectoryFromTable:
 * lerp position, slerp orientation) with the source's technique / family / bounds / subject,
 * `id = <source id>~<preset>`, and `meta.flight = {preset, name, mount, fps, nominalDuration,
 * overrunSec, settled, maxTrackingErrorM, meanTrackingErrorM, maxSpeed, maxAccel, wind,
 * cutResets}`.
 * Throws FilmError (BAD_ARGUMENT) for a non-trajectory or bad fps; deterministic.
 * @param {import('../shots/trajectory.js').Trajectory} traj
 * @param {string|Object} [preset] preset name or config (default presetForTrajectory(traj))
 * @param {number} [fps=30]
 * @returns {import('../shots/trajectory.js').Trajectory}
 */
export function flyTrajectory(traj, preset, fps = 30) {
  if (!isTrajectory(traj)) throw badArg("flyTrajectory: a Trajectory (sample(t), finite duration ≥ 0) is required");
  const F = fps === undefined || fps === null ? 30 : fps;
  if (!(typeof F === "number" && Number.isFinite(F) && F > 0 && F <= 1000)) {
    throw badArg(`flyTrajectory: fps must be a number in (0, 1000] (got ${show(fps)})`);
  }
  const drone = createDrone(preset === undefined || preset === null ? presetForTrajectory(traj) : preset);
  const cfg = drone.config;
  const D = traj.duration;
  const hd = Math.min(0.5 / F, 0.01);
  let times;
  try {
    times = frameTimes(D, F);
  } catch (e) {
    throw badArg(`flyTrajectory: ${e && e.message ? e.message : String(e)}`);
  }
  const rows = [];
  const push = (pose) => {
    rows.push([pose.t, pose.pos[0], pose.pos[1], pose.pos[2], pose.q[0], pose.q[1], pose.q[2], pose.q[3], pose.fov,
      pose.focus !== undefined ? pose.focus : 0, Number.isFinite(pose.r) ? pose.r : 0]);
  };
  let maxErr = 0, sumErr = 0, nErr = 0, maxSpeed = 0, maxAccel = 0;
  const track = (pose, nominal) => {
    const st = drone.state();
    const ex = pose.pos[0] - nominal.pos[0], ey = pose.pos[1] - nominal.pos[1], ez = pose.pos[2] - nominal.pos[2];
    const e = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (e > maxErr) maxErr = e;
    sumErr += e;
    nErr += 1;
    if (st.speed > maxSpeed) maxSpeed = st.speed;
    const al = vlen(st.acc);
    if (al > maxAccel) maxAccel = al;
  };
  const p0 = traj.sample(0);
  const d0 = derivatives(traj, 0, D, hd);
  const first = drone.reset({ ...p0, t: 0 }, { velocity: d0.vel, acceleration: d0.acc });
  push(first);
  track(first, p0);
  let lastNominal = p0;
  const cuts = traj.meta && Array.isArray(traj.meta.cuts) ? traj.meta.cuts.filter(Number.isFinite) : [];
  let resets = 0;
  for (let k = 1; k < times.length; k++) {
    const t = times[k];
    const nominal = traj.sample(t);
    const cut = cuts.some((c) => c > times[k - 1] + 1e-9 && c <= t + 1e-9);
    const d = derivatives(traj, t, D, hd, cut);
    let pose;
    if (cut) {
      // a declared cut is a new camera setup: the craft starts there, it does not fly across
      pose = drone.reset({ ...nominal, t }, { velocity: d.vel, acceleration: d.acc });
      resets += 1;
    } else {
      pose = drone.step({ ...nominal, t, vel: d.vel, acc: d.acc }, t - times[k - 1]);
    }
    push(pose);
    track(pose, nominal);
    lastNominal = nominal;
  }
  // overrun: let the craft catch the end pose (target continues along its final velocity)
  const dEnd = derivatives(traj, D, D, hd);
  const vEnd = dEnd.vel;
  const settledAt = (pose, nominal) => {
    const ex = pose.pos[0] - nominal.pos[0], ey = pose.pos[1] - nominal.pos[1], ez = pose.pos[2] - nominal.pos[2];
    return Math.sqrt(ex * ex + ey * ey + ez * ez) <= 0.05 && qAngle(pose.q, nominal.q) <= 0.5 * DEG;
  };
  let lastPose = drone.state();
  let settled = D <= 0 || settledAt({ pos: lastPose.pos, q: lastPose.camera.q }, lastNominal);
  // An in-motion ending keeps moving: there is nothing to settle onto, so only a (near) rest
  // ending overruns to let the craft arrive.
  const restEnding = vlen(vEnd) < 0.5;
  let tEnd = times[times.length - 1];
  const maxOver = 0.1 * D;
  let j = 1;
  while (!settled && restEnding && D > 0) {
    const t = Math.min(D + maxOver, D + j / F);
    if (!(t > tEnd + 1e-9)) break;
    const target = {
      ...lastNominal,
      t,
      pos: [lastNominal.pos[0] + vEnd[0] * (t - D), lastNominal.pos[1] + vEnd[1] * (t - D), lastNominal.pos[2] + vEnd[2] * (t - D)],
      vel: vEnd,
      acc: [0, 0, 0],
    };
    const pose = drone.step(target, t - tEnd);
    push(pose);
    track(pose, target);
    tEnd = t;
    settled = settledAt(pose, target);
    j += 1;
    if (t >= D + maxOver - 1e-9) break;
  }
  const flat = new Float64Array(rows.length * TABLE_STRIDE);
  rows.forEach((r, i) => {
    for (let c = 0; c < TABLE_STRIDE; c++) flat[i * TABLE_STRIDE + c] = r[c];
  });
  const meta = {
    ...(traj.meta && typeof traj.meta === "object" ? traj.meta : {}),
    flight: {
      preset: cfg.preset,
      name: cfg.name,
      mount: cfg.mount,
      fps: F,
      nominalDuration: D,
      overrunSec: Math.max(0, tEnd - D),
      settled,
      maxTrackingErrorM: maxErr,
      meanTrackingErrorM: nErr ? sumErr / nErr : 0,
      maxSpeed,
      maxAccel,
      wind: cfg.wind ? { gustMps: cfg.wind.gustMps, seed: cfg.wind.seed, frequencyHz: cfg.wind.frequencyHz } : null,
      cutResets: resets,
    },
    flownFrom: traj.id,
  };
  const out = trajectoryFromTable({
    fps: F,
    rows: flat,
    id: `${typeof traj.id === "string" && traj.id ? traj.id : "trajectory"}~${cfg.name}`,
    technique: typeof traj.technique === "string" && traj.technique ? traj.technique : "flown",
    family: typeof traj.family === "string" && traj.family ? traj.family : "drone",
    bounds: traj.bounds,
    meta,
  });
  if (traj.subject !== undefined && traj.subject !== null) out.subject = traj.subject;
  if (typeof traj.subjectAt === "function") out.subjectAt = traj.subjectAt;
  return out;
}
