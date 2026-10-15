// scene3d/film/shots/trajectory.js — camera trajectories for AC Film Mode (SPEC §2.9).
//
// WHY: every shot — a classic dolly, a drone orbit, an FPV corridor run, a
// replayed realised take — is ONE value type: a Trajectory whose `sample(t)`
// is PURE in film time t (random access: the scout samples arbitrary times,
// the stepped take player samples frame by frame, a rehearsal can re-run a
// take bit-identically). Poses carry explicit gimbal angles AND a quaternion
// in the AC frame, so straight-down / straight-up shots never flip (the
// quaternion is the truth; h/p/r are its readable decomposition with
// p ∈ [−π/2, π/2]).
//
// The module also owns the baked TABLE format the runtime records and replays
// (`[t, x, y, z, qw, qx, qy, qz, fov, focus, roll]` rows), its checksum, the
// combinators the director composes shots with (time warp, offsets, concat
// with cuts or blends), the trajectory validator (NaN, teleports, angular
// spikes, heading flips) and small helpers that let technique modules stay
// short (orientLookAt, aimSubject, clampToEnvelope, subjectCoverage).
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks. Deterministic; inputs are never mutated.

import { FilmShotError } from "../core/errors.js";
import { EASINGS, smootherstep } from "../core/easing.js";
import { createLookController, hprFromQuat, lookRotation, quatFromHPR, shortestAngleDiff } from "../core/gimbal.js";
import { qAngle, qEnsureContinuity, qNorm, qRotate, qSlerp } from "../core/quat.js";
import { isFiniteV } from "../core/vec3.js";
import { aimPointForFraming, DEFAULT_ASPECT, framingFactor, projectToNdc } from "./framing.js";

const DEG = Math.PI / 180;
const HALF_PI = Math.PI / 2;

/** Vertical fov (degrees) used when a trajectory supplies none — the game camera's default. */
export const DEFAULT_FOV = 60;

/** Minimum camera height above outdoor terrain (metres) — SPEC §2.12 "ctx.groundZ (+0.7 m)". */
export const GROUND_CLEARANCE = 0.7;

/** Column names of a baked table row (SPEC §2.9). `focus` 0 = no focus channel. */
export const TABLE_COLUMNS = Object.freeze(["t", "x", "y", "z", "qw", "qx", "qy", "qz", "fov", "focus", "roll"]);

/** Number of Float64 values per baked table row. */
export const TABLE_STRIDE = 11;

/** Largest table bakeTrajectory / trajectoryFromTable accept (frames). */
export const MAX_TABLE_FRAMES = 1000000;

/**
 * How far the pilot may push a shot when no technique / spec says otherwise.
 * maxLateral / maxRise / maxSink in metres (path-frame offsets), speed scales
 * multiply the progress rate (minSpeedScale ∈ [0, 1], maxSpeedScale ≥ 1),
 * distanceScale multiplies the subject distance within
 * [1/maxDistanceScale, maxDistanceScale].
 * @type {Readonly<{maxLateral:number, maxRise:number, maxSink:number, minSpeedScale:number,
 *   maxSpeedScale:number, maxDistanceScale:number}>}
 */
export const DEFAULT_BOUNDS = Object.freeze({
  maxLateral: 2.0,
  maxRise: 2.0,
  maxSink: 1.0,
  minSpeedScale: 0.25,
  maxSpeedScale: 1.25,
  maxDistanceScale: 1.3,
});

/** The keys of a Bounds object, in canonical order. @type {ReadonlyArray<string>} */
export const BOUND_KEYS = Object.freeze(Object.keys(DEFAULT_BOUNDS));

/**
 * Machine-readable `.code`s of the FilmShotErrors thrown by this module.
 * @type {Readonly<{BAD_TRAJECTORY:string, NAN_POSE:string, BAD_TABLE:string, BAD_BOUNDS:string,
 *   BAD_WARP:string, BAD_ARGUMENT:string, MISSING_SUBJECT:string}>}
 */
export const TRAJECTORY_ERROR_CODES = Object.freeze({
  BAD_TRAJECTORY: "BAD_TRAJECTORY",
  NAN_POSE: "NAN_POSE",
  BAD_TABLE: "BAD_TABLE",
  BAD_BOUNDS: "BAD_BOUNDS",
  BAD_WARP: "BAD_WARP",
  BAD_ARGUMENT: "BAD_ARGUMENT",
  MISSING_SUBJECT: "MISSING_SUBJECT",
});

/**
 * Issue codes reported by validateTrajectory.
 * @type {Readonly<{NAN:string, SAMPLE_ERROR:string, TELEPORT:string, ANGULAR_SPIKE:string, HEADING_FLIP:string,
 *   FOV_RANGE:string, FOV_SPIKE:string, PITCH_RANGE:string, STRUCTURE:string}>}
 */
export const VALIDATION_CODES = Object.freeze({
  NAN: "nan",
  SAMPLE_ERROR: "sample-error",
  TELEPORT: "teleport",
  ANGULAR_SPIKE: "angular-spike",
  HEADING_FLIP: "heading-flip",
  FOV_RANGE: "fov-range",
  FOV_SPIKE: "fov-spike",
  PITCH_RANGE: "pitch-range",
  STRUCTURE: "structure",
});

/**
 * @typedef {Object} Pose
 * @property {number}   t     film time, seconds
 * @property {number[]} pos   `[x, y, z]` AC world metres
 * @property {number}   h     compass heading, radians (may be unwrapped beyond ±π)
 * @property {number}   p     pitch, radians, always in [−π/2, π/2]
 * @property {number}   r     roll, radians
 * @property {number[]} q     unit AC quaternion `[w, x, y, z]` (the truth when h/p/r are ambiguous)
 * @property {number}   fov   vertical fov, degrees, (0, 180)
 * @property {number}   [focus] focus distance, metres (> 0); absent = no focus channel
 */

/**
 * @typedef {Object} Bounds
 * @property {number} maxLateral @property {number} maxRise @property {number} maxSink
 * @property {number} minSpeedScale @property {number} maxSpeedScale @property {number} maxDistanceScale
 */

/**
 * @typedef {Object} Keyframe
 * @property {number} t @property {number[]} pos @property {number} h @property {number} p
 * @property {number} r @property {number} fov @property {number} [focus] @property {string} [label]
 */

/**
 * @typedef {Object} Trajectory
 * @property {string} id
 * @property {string} technique
 * @property {string} family     'classic' | 'drone' | 'fpv' (or 'mixed' for a mixed concat)
 * @property {number} duration   seconds (≥ 0)
 * @property {(t:number) => Pose} sample  PURE in t; t clamps to [0, duration] (NaN → 0)
 * @property {Keyframe[]} keyframes
 * @property {*} [subject]
 * @property {(t:number) => *} [subjectAt]
 * @property {Bounds} bounds
 * @property {Object} meta       JSON-safe; `cuts` (seconds) marks deliberate discontinuities
 */

/**
 * @typedef {Object} BakedTable
 * @property {number} fps
 * @property {number} frames      rows (fence-post inclusive: t = 0 … duration)
 * @property {Float64Array} rows  frames × 11 values, TABLE_COLUMNS order
 * @property {number} duration
 * @property {string} id @property {string} technique @property {string} family
 * @property {Bounds} bounds @property {Object} meta
 * @property {string} checksum    tableChecksum(rows)
 */

/** Trajectories whose bounds were given explicitly (not defaulted) — buildShot lets these override a technique's defaults. */
const EXPLICIT_BOUNDS = new WeakSet();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** @param {string} message @param {string} code @param {*} [details] @returns {FilmShotError} */
function shotError(message, code, details) {
  return new FilmShotError(message, details === undefined ? { code } : { code, details });
}

/** Short readable number for messages. */
function fmt(n) {
  return typeof n === "number" && Number.isFinite(n) ? String(Math.round(n * 1e4) / 1e4) : String(n);
}

/** Readable form of a bad value for messages. */
function show(v) {
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return `[${Array.from(v, (x) => String(x)).join(", ")}]`;
  if (v && typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** FilmShotError for a non-finite pose component. */
function nanError(label, t, what, value) {
  return shotError(`${label}: ${what} is not finite at t=${fmt(t)} (got ${show(value)})`, TRAJECTORY_ERROR_CODES.NAN_POSE, {
    t: Number.isFinite(t) ? t : null,
    what,
  });
}

/** t clamped to [0, D]; non-finite → 0. */
function clampTime(t, D) {
  if (!Number.isFinite(t) || t <= 0) return 0;
  return t >= D ? D : t;
}

/** True for a finite, non-zero 4-component quaternion. */
function quatLike(q) {
  if (q == null || typeof q !== "object") return false;
  const w = q[0], x = q[1], y = q[2], z = q[3];
  if (!Number.isFinite(w) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  return w * w + x * x + y * y + z * z > 1e-24;
}

/** A function of t from a function or a constant (number / vec3 / object). */
function asFnOfT(v) {
  return typeof v === "function" ? v : () => v;
}

/**
 * hprFromQuat that keeps a KNOWN roll exact: when the forward vector is
 * vertical only h ± r is determined by q, so the stored roll fixes the split
 * (nadir: h + r invariant; zenith: h − r invariant).
 */
function hprWithRoll(q, headingHint, roll) {
  const e = hprFromQuat(q, headingHint, Number.isFinite(roll) ? roll : undefined);
  if (!Number.isFinite(roll)) return e;
  if (Math.cos(e.p) < 1e-6) {
    const s = -Math.sin(e.p) >= 0 ? 1 : -1;
    return { h: e.h + s * (e.r - roll), p: e.p, r: roll };
  }
  if (Math.abs(shortestAngleDiff(e.r, roll)) < 1e-6) return { h: e.h, p: e.p, r: roll };
  return e;
}

/**
 * Finish a pose: validate position, resolve orientation (h/p/r ⇄ q), validate
 * fov and focus. `orient` is `{q, h?, r?}` (h = heading hint, r = roll hint) or
 * `{h, p, r?}`; |p| > π/2 is legal on input (pitched past the pole) and is
 * re-expressed from q so the output p ∈ [−π/2, π/2].
 */
function finishPose(t, pos, orient, fov, focus, label) {
  if (!isFiniteV(pos)) throw nanError(label, t, "position", pos);
  if (!orient || typeof orient !== "object") throw nanError(label, t, "orientation", orient);
  let h, p, r, q;
  if (orient.q !== undefined && orient.q !== null) {
    if (!quatLike(orient.q)) throw nanError(label, t, "quaternion", orient.q);
    q = qNorm(orient.q);
    const given = Number.isFinite(orient.h) && Number.isFinite(orient.p) && Number.isFinite(orient.r) &&
      Math.abs(orient.p) <= HALF_PI;
    if (given && qAngle(q, quatFromHPR(orient.h, orient.p, orient.r)) < 1e-9) {
      // Consistent {h, p, r, q} (e.g. lookRotation output): keep the exact angles.
      h = orient.h;
      p = orient.p;
      r = orient.r;
    } else {
      const e = hprFromQuat(q, Number.isFinite(orient.h) ? orient.h : 0, Number.isFinite(orient.r) ? orient.r : undefined);
      h = e.h;
      p = e.p;
      r = e.r;
    }
  } else {
    h = orient.h;
    p = orient.p;
    r = orient.r === undefined || orient.r === null ? 0 : orient.r;
    if (!Number.isFinite(h) || !Number.isFinite(p) || !Number.isFinite(r)) {
      throw nanError(label, t, "heading/pitch/roll", { h, p, r });
    }
    q = quatFromHPR(h, p, r);
    if (Math.abs(p) > HALF_PI) {
      const e = hprFromQuat(q, h, r);
      h = e.h;
      p = e.p;
      r = e.r;
    }
  }
  const f = fov === undefined || fov === null ? DEFAULT_FOV : fov;
  if (!(typeof f === "number" && Number.isFinite(f) && f > 0 && f < 180)) {
    throw shotError(`${label}: fov must be a finite number in (0, 180) degrees at t=${fmt(t)} (got ${show(f)})`,
      TRAJECTORY_ERROR_CODES.NAN_POSE, { t, what: "fov" });
  }
  const pose = { t, pos: [pos[0], pos[1], pos[2]], h, p, r, q, fov: f };
  if (focus !== undefined && focus !== null) {
    if (!(typeof focus === "number" && Number.isFinite(focus) && focus >= 0)) {
      throw shotError(`${label}: focus must be a finite distance ≥ 0 m at t=${fmt(t)} (got ${show(focus)})`,
        TRAJECTORY_ERROR_CODES.NAN_POSE, { t, what: "focus" });
    }
    if (focus > 0) pose.focus = focus;
  }
  return pose;
}

/**
 * Build a validated Pose from loose fields: `pos` plus either `q` or `h`/`p`
 * (`r` optional), `fov` (default 60) and optional `focus`. Throws FilmShotError
 * (code NAN_POSE) on any non-finite component.
 * @param {{t?:number, pos:number[], h?:number, p?:number, r?:number, q?:number[], fov?:number, focus?:number}} fields
 * @returns {Pose}
 */
export function makePose(fields) {
  const o = fields || {};
  const t = Number.isFinite(o.t) ? o.t : 0;
  return finishPose(t, o.pos, { q: o.q, h: o.h, p: o.p, r: o.r }, o.fov, o.focus, "makePose");
}

/**
 * True when `x` looks like a Trajectory (has `sample()` and a finite duration ≥ 0).
 * @param {*} x
 * @returns {boolean}
 */
export function isTrajectory(x) {
  return !!x && typeof x === "object" && typeof x.sample === "function" && Number.isFinite(x.duration) && x.duration >= 0;
}

/** Throw unless `x` is a Trajectory. */
function assertTrajectory(x, fn) {
  if (!isTrajectory(x)) {
    throw shotError(`${fn}: expected a Trajectory (object with sample(t) and a finite duration ≥ 0)`, TRAJECTORY_ERROR_CODES.BAD_TRAJECTORY);
  }
}

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

/**
 * Validate and complete a Bounds object: missing keys come from `base`
 * (default DEFAULT_BOUNDS). maxLateral / maxRise / maxSink must be finite ≥ 0,
 * minSpeedScale ∈ [0, 1], maxSpeedScale ≥ 1, maxDistanceScale ≥ 1 (all
 * finite). Unknown keys throw (typo protection). Throws FilmShotError
 * (code BAD_BOUNDS).
 * @param {Partial<Bounds>|null|undefined} bounds
 * @param {Bounds} [base=DEFAULT_BOUNDS]
 * @returns {Bounds} a new plain object
 */
export function normalizeBounds(bounds, base = DEFAULT_BOUNDS) {
  const b = bounds == null ? {} : bounds;
  if (typeof b !== "object" || Array.isArray(b)) {
    throw shotError(`bounds must be an object with keys ${BOUND_KEYS.join(", ")}`, TRAJECTORY_ERROR_CODES.BAD_BOUNDS);
  }
  for (const k of Object.keys(b)) {
    if (!BOUND_KEYS.includes(k)) {
      throw shotError(`unknown bounds key "${k}" (valid: ${BOUND_KEYS.join(", ")})`, TRAJECTORY_ERROR_CODES.BAD_BOUNDS, { key: k });
    }
  }
  const src = base && typeof base === "object" ? base : DEFAULT_BOUNDS;
  const out = {};
  for (const k of BOUND_KEYS) {
    const v = b[k] !== undefined && b[k] !== null ? b[k] : src[k] !== undefined ? src[k] : DEFAULT_BOUNDS[k];
    let ok = typeof v === "number" && Number.isFinite(v);
    if (ok) {
      if (k === "minSpeedScale") ok = v >= 0 && v <= 1;
      else if (k === "maxSpeedScale" || k === "maxDistanceScale") ok = v >= 1;
      else ok = v >= 0;
    }
    if (!ok) {
      const rule = k === "minSpeedScale" ? "in [0, 1]" : k === "maxSpeedScale" || k === "maxDistanceScale" ? "≥ 1" : "≥ 0 (metres)";
      throw shotError(`bounds.${k} must be a finite number ${rule} (got ${show(v)})`, TRAJECTORY_ERROR_CODES.BAD_BOUNDS, { key: k });
    }
    out[k] = v;
  }
  return out;
}

/**
 * The most restrictive combination of several Bounds (min of the maxima,
 * max of minSpeedScale). An empty list returns DEFAULT_BOUNDS (copy).
 * @param {Bounds[]} list
 * @returns {Bounds}
 */
export function intersectBounds(list) {
  const arr = Array.isArray(list) ? list.filter(Boolean).map((b) => normalizeBounds(b)) : [];
  if (arr.length === 0) return { ...DEFAULT_BOUNDS };
  const out = { ...arr[0] };
  for (const b of arr.slice(1)) {
    out.maxLateral = Math.min(out.maxLateral, b.maxLateral);
    out.maxRise = Math.min(out.maxRise, b.maxRise);
    out.maxSink = Math.min(out.maxSink, b.maxSink);
    out.minSpeedScale = Math.max(out.minSpeedScale, b.minSpeedScale);
    out.maxSpeedScale = Math.min(out.maxSpeedScale, b.maxSpeedScale);
    out.maxDistanceScale = Math.min(out.maxDistanceScale, b.maxDistanceScale);
  }
  return out;
}

/**
 * True when the trajectory's bounds were supplied explicitly (makeTrajectory
 * `bounds`, or attached by buildShot) rather than defaulted — buildShot lets
 * explicit bounds override a technique's `defaultBounds`.
 * @param {Trajectory} traj
 * @returns {boolean}
 */
export function hasExplicitBounds(traj) {
  return !!traj && typeof traj === "object" && EXPLICIT_BOUNDS.has(traj);
}

/**
 * Mark a trajectory's bounds as explicit (see hasExplicitBounds). Returns the trajectory.
 * @param {Trajectory} traj
 * @returns {Trajectory}
 */
export function markBoundsExplicit(traj) {
  if (traj && typeof traj === "object") EXPLICIT_BOUNDS.add(traj);
  return traj;
}

// ---------------------------------------------------------------------------
// trajectory assembly
// ---------------------------------------------------------------------------

/** Keyframe view of a pose. */
function keyframeOf(pose, label) {
  const k = { t: pose.t, pos: pose.pos.slice(), h: pose.h, p: pose.p, r: pose.r, fov: pose.fov };
  if (pose.focus !== undefined) k.focus = pose.focus;
  if (typeof label === "string" && label) k.label = label;
  return k;
}

/** Evenly spaced keyframes (5, or 1 for a zero-length trajectory). */
function defaultKeyframes(sample, D, count = 5) {
  const n = D > 0 ? Math.max(2, count) : 1;
  const out = [];
  for (let i = 0; i < n; i++) out.push(keyframeOf(sample(n === 1 ? 0 : (D * i) / (n - 1))));
  return out;
}

/** Keyframes at caller-chosen times (values re-sampled so they always agree with sample()). */
function keyframesAt(list, sample, D, label) {
  if (!Array.isArray(list)) throw shotError(`${label}: keyframes must be an array`, TRAJECTORY_ERROR_CODES.BAD_TRAJECTORY);
  const out = [];
  for (const k of list) {
    const t = k && typeof k === "object" ? k.t : k;
    if (!(typeof t === "number" && Number.isFinite(t) && t >= -1e-9 && t <= D + 1e-9)) {
      throw shotError(`${label}: keyframe time must be a finite number in [0, ${fmt(D)}] (got ${show(t)})`,
        TRAJECTORY_ERROR_CODES.BAD_TRAJECTORY);
    }
    out.push(keyframeOf(sample(t), k && typeof k === "object" ? k.label : undefined));
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Plain-object meta copy (throws when meta is not an object). */
function copyMeta(meta, label) {
  if (meta === undefined || meta === null) return {};
  if (typeof meta !== "object" || Array.isArray(meta)) {
    throw shotError(`${label}: meta must be a plain object`, TRAJECTORY_ERROR_CODES.BAD_TRAJECTORY);
  }
  return { ...meta };
}

/**
 * Assemble a Trajectory from a header and a pose function of CLAMPED time.
 * @param {{id:string, technique:string, family:string, duration:number, subject?:*, subjectAt?:Function,
 *   bounds:Bounds, boundsExplicit:boolean, meta:Object, keyframes?:Array, keyframeCount?:number}} hd
 * @param {(tc:number) => Pose} poseAt
 * @returns {Trajectory}
 */
function assemble(hd, poseAt) {
  const D = hd.duration;
  const sample = (t) => poseAt(clampTime(t, D));
  const traj = {
    id: hd.id,
    technique: hd.technique,
    family: hd.family,
    duration: D,
    sample,
    keyframes: [],
    bounds: hd.bounds,
    meta: hd.meta,
  };
  if (hd.subject !== undefined && hd.subject !== null) traj.subject = hd.subject;
  if (typeof hd.subjectAt === "function") traj.subjectAt = hd.subjectAt;
  traj.keyframes = hd.keyframes ? keyframesAt(hd.keyframes, sample, D, hd.id) : defaultKeyframes(sample, D, hd.keyframeCount);
  if (hd.boundsExplicit) EXPLICIT_BOUNDS.add(traj);
  return traj;
}

/** Non-empty string or the fallback. */
function str(v, fallback) {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/**
 * Build a Trajectory from per-time callbacks (SPEC §2.9).
 *
 * `positionAt(t) → [x,y,z]` (or a constant vec3); `orientAt(t, pos) →
 * {h,p,r}` or `{q}` (optionally `{q, h}` with h as a heading hint at the
 * poles; or a constant); `fovAt(t)` (or a number, or `fov`; default 60);
 * `focusAt(t)` (or a number; metres; omitted → no focus channel). The
 * callbacks MUST be pure in t. `sample(t)` clamps t to [0, duration] and
 * returns a fresh Pose with q filled from h/p/r (or h/p/r from q) and
 * p ∈ [−π/2, π/2] (orientations pitched past the pole are re-expressed).
 * Throws FilmShotError (code NAN_POSE) when any component is non-finite or the
 * fov leaves (0, 180), and (code BAD_TRAJECTORY) for a bad header. Keyframes
 * default to 5 evenly spaced samples (computed eagerly, which also validates
 * the callbacks once); given keyframe times are re-sampled. Bounds are
 * completed from DEFAULT_BOUNDS.
 * @param {{id?:string, technique?:string, family?:string, duration:number,
 *   positionAt:((t:number)=>number[])|number[], orientAt:((t:number, pos:number[])=>({h:number,p:number,r?:number}|{q:number[],h?:number,r?:number}))|Object,
 *   fovAt?:((t:number)=>number)|number, fov?:number, focusAt?:((t:number)=>number)|number,
 *   keyframes?:Array<number|{t:number,label?:string}>, keyframeCount?:number, subject?:*, subjectAt?:(t:number)=>*,
 *   bounds?:Partial<Bounds>, meta?:Object}} opts
 * @returns {Trajectory}
 */
export function makeTrajectory(opts) {
  if (!opts || typeof opts !== "object") {
    throw shotError("makeTrajectory: options object required", TRAJECTORY_ERROR_CODES.BAD_TRAJECTORY);
  }
  const technique = str(opts.technique, "custom");
  const id = str(opts.id, technique);
  const family = str(opts.family, "classic");
  const D = opts.duration;
  if (!(typeof D === "number" && Number.isFinite(D) && D >= 0)) {
    throw shotError(`${id}: duration must be a finite number ≥ 0 seconds (got ${show(D)})`, TRAJECTORY_ERROR_CODES.BAD_TRAJECTORY);
  }
  let posFn;
  if (typeof opts.positionAt === "function") posFn = opts.positionAt;
  else if (isFiniteV(opts.positionAt)) {
    const c = [opts.positionAt[0], opts.positionAt[1], opts.positionAt[2]];
    posFn = () => c;
  } else {
    throw shotError(`${id}: positionAt must be a function of t or a finite [x,y,z]`, TRAJECTORY_ERROR_CODES.BAD_TRAJECTORY);
  }
  let oriFn;
  if (typeof opts.orientAt === "function") oriFn = opts.orientAt;
  else if (opts.orientAt && typeof opts.orientAt === "object") {
    const c = opts.orientAt;
    oriFn = () => c;
  } else {
    throw shotError(`${id}: orientAt must be a function (t, pos) → {h,p,r}|{q} or a constant orientation`, TRAJECTORY_ERROR_CODES.BAD_TRAJECTORY);
  }
  const fovSrc = opts.fovAt !== undefined && opts.fovAt !== null ? opts.fovAt : opts.fov !== undefined && opts.fov !== null ? opts.fov : DEFAULT_FOV;
  const fovFn = asFnOfT(fovSrc);
  const focusFn = opts.focusAt === undefined || opts.focusAt === null ? null : asFnOfT(opts.focusAt);
  const poseAt = (tc) => {
    const raw = posFn(tc);
    if (!isFiniteV(raw)) throw nanError(id, tc, "position", raw);
    const pos = [raw[0], raw[1], raw[2]];
    const orient = oriFn(tc, [pos[0], pos[1], pos[2]]);
    return finishPose(tc, pos, orient, fovFn(tc), focusFn ? focusFn(tc) : undefined, id);
  };
  const boundsExplicit = opts.bounds !== undefined && opts.bounds !== null;
  return assemble({
    id,
    technique,
    family,
    duration: D,
    subject: opts.subject,
    subjectAt: opts.subjectAt,
    bounds: normalizeBounds(opts.bounds, DEFAULT_BOUNDS),
    boundsExplicit,
    meta: copyMeta(opts.meta, id),
    keyframes: opts.keyframes,
    keyframeCount: Number.isInteger(opts.keyframeCount) && opts.keyframeCount >= 2 ? opts.keyframeCount : 5,
  }, poseAt);
}

/** Header fields copied from a source trajectory (bounds explicit-ness preserved). */
function headerFrom(traj, extra) {
  return {
    id: traj.id,
    technique: traj.technique,
    family: traj.family,
    duration: traj.duration,
    subject: traj.subject,
    subjectAt: traj.subjectAt,
    bounds: normalizeBounds(traj.bounds),
    boundsExplicit: EXPLICIT_BOUNDS.has(traj),
    meta: copyMeta(traj.meta, traj.id),
    keyframeCount: Array.isArray(traj.keyframes) && traj.keyframes.length >= 2 ? traj.keyframes.length : 5,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// combinators
// ---------------------------------------------------------------------------

/** Times at which a monotone map hits each target (bisection), or null when the map is not monotone. */
function invertMonotone(map, D2, targets) {
  const N = 64;
  const vals = [];
  for (let i = 0; i <= N; i++) vals.push(map((D2 * i) / N));
  let inc = true, dec = true;
  for (let i = 1; i <= N; i++) {
    if (!(vals[i] >= vals[i - 1] - 1e-12)) inc = false;
    if (!(vals[i] <= vals[i - 1] + 1e-12)) dec = false;
  }
  if (!inc && !dec) return null;
  const sgn = inc ? 1 : -1;
  return targets.map((target) => {
    let lo = 0, hi = D2;
    if (sgn * (map(lo) - target) >= 0) return lo;
    if (sgn * (map(hi) - target) <= 0) return hi;
    for (let k = 0; k < 60; k++) {
      const m = (lo + hi) / 2;
      if (sgn * (map(m) - target) < 0) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  });
}

/**
 * Re-time a trajectory. `warp` is one of:
 *  - a number `rate` > 0 — constant playback speed; duration becomes D / rate;
 *  - an easing name (EASINGS) or a function `f(u)` on NORMALISED time
 *    (u ∈ [0, 1] → source fraction, f(0) = 0, f(1) = 1 for a full take) —
 *    duration unchanged (e.g. `timeWarp(linearMove, 'sineInOut')`);
 *  - `{duration?, map(t) → sourceSeconds}` — explicit map in seconds from
 *    output time to source time (duration defaults to the source's).
 * Non-monotone maps (boomerangs, reverse) are allowed: keyframes are then
 * re-spaced evenly and declared cuts are dropped. Pose.t is the OUTPUT time.
 * Throws FilmShotError (code BAD_WARP) for an invalid warp and (NAN_POSE) when
 * the map yields a non-finite time.
 * @param {Trajectory} traj
 * @param {number|string|((u:number)=>number)|{duration?:number, map:(t:number)=>number}} warp
 * @returns {Trajectory}
 */
export function timeWarp(traj, warp) {
  assertTrajectory(traj, "timeWarp");
  const D = traj.duration;
  let D2, map, info;
  if (typeof warp === "number") {
    if (!(Number.isFinite(warp) && warp > 0)) {
      throw shotError(`timeWarp: rate must be a finite number > 0 (got ${warp})`, TRAJECTORY_ERROR_CODES.BAD_WARP);
    }
    D2 = D / warp;
    map = (t) => t * warp;
    info = { kind: "rate", rate: warp };
  } else if (typeof warp === "string" || typeof warp === "function") {
    let f = warp;
    if (typeof warp === "string") {
      if (!Object.prototype.hasOwnProperty.call(EASINGS, warp)) {
        throw shotError(`timeWarp: unknown easing "${warp}" (valid: ${Object.keys(EASINGS).join(", ")})`, TRAJECTORY_ERROR_CODES.BAD_WARP);
      }
      f = EASINGS[warp];
    }
    D2 = D;
    map = D > 0 ? (t) => D * f(t / D) : () => 0;
    info = typeof warp === "string" ? { kind: "ease", ease: warp } : { kind: "function" };
  } else if (warp && typeof warp === "object" && typeof warp.map === "function") {
    const d = warp.duration === undefined || warp.duration === null ? D : warp.duration;
    if (!(typeof d === "number" && Number.isFinite(d) && d >= 0)) {
      throw shotError(`timeWarp: duration must be a finite number ≥ 0 (got ${show(d)})`, TRAJECTORY_ERROR_CODES.BAD_WARP);
    }
    D2 = d;
    map = warp.map;
    info = { kind: "map" };
  } else {
    throw shotError("timeWarp: warp must be a rate > 0, an easing name, a function f(u) on normalised time, or {duration, map(t)}",
      TRAJECTORY_ERROR_CODES.BAD_WARP);
  }
  const label = traj.id;
  const poseAt = (tc) => {
    const ts = map(tc);
    if (!Number.isFinite(ts)) throw nanError(label, tc, "warped time", ts);
    const base = traj.sample(ts);
    return { ...base, t: tc };
  };
  const srcKeys = Array.isArray(traj.keyframes) ? traj.keyframes.map((k) => k.t) : [];
  const srcCuts = Array.isArray(traj.meta && traj.meta.cuts) ? traj.meta.cuts.filter(Number.isFinite) : [];
  const inv = invertMonotone(map, D2, srcKeys.concat(srcCuts));
  const meta = copyMeta(traj.meta, label);
  meta.timeWarp = { ...info, sourceDuration: D };
  if (srcCuts.length) {
    if (inv) meta.cuts = inv.slice(srcKeys.length);
    else delete meta.cuts;
  }
  const keyframes = inv && srcKeys.length ? inv.slice(0, srcKeys.length).map((t, i) => ({ t, label: traj.keyframes[i].label })) : undefined;
  return assemble(headerFrom(traj, { duration: D2, meta, keyframes }), poseAt);
}

/** Finite number or 0 for missing; throws for a present non-finite value. */
function offNum(o, key, label, t) {
  const v = o[key];
  if (v === undefined || v === null) return 0;
  if (!(typeof v === "number" && Number.isFinite(v))) throw nanError(label, t, `offset ${key}`, v);
  return v;
}

/**
 * Add a time-varying offset to a trajectory (shake, pilot residuals, framing
 * nudges). `fn(t, basePose)` returns `{dpos?, dposLocal?, dh?, dp?, dr?,
 * dfov?, dfocus?}` (or null for none): `dpos` world metres, `dposLocal`
 * camera-frame metres `[right, forward, up]`, `dh/dp/dr` radians added to the
 * base gimbal angles (pitch may cross ±π/2 — the quaternion stays continuous),
 * `dfov` degrees, `dfocus` metres (only when the base has a focus channel).
 * Must be pure in t. Throws FilmShotError (NAN_POSE) on non-finite offsets.
 * @param {Trajectory} traj
 * @param {(t:number, base:Pose) => ({dpos?:number[], dposLocal?:number[], dh?:number, dp?:number, dr?:number,
 *   dfov?:number, dfocus?:number}|null|undefined)} fn
 * @returns {Trajectory}
 */
export function withOffset(traj, fn) {
  assertTrajectory(traj, "withOffset");
  if (typeof fn !== "function") {
    throw shotError("withOffset: fn(t, basePose) → {dpos, dh, dp, dr, dfov} required", TRAJECTORY_ERROR_CODES.BAD_ARGUMENT);
  }
  const label = traj.id;
  const poseAt = (tc) => {
    const base = traj.sample(tc);
    const off = fn(tc, base);
    if (off === undefined || off === null) return { ...base, t: tc };
    if (typeof off !== "object") throw nanError(label, tc, "offset", off);
    const pos = base.pos.slice();
    if (off.dpos !== undefined && off.dpos !== null) {
      if (!isFiniteV(off.dpos)) throw nanError(label, tc, "offset dpos", off.dpos);
      pos[0] += off.dpos[0]; pos[1] += off.dpos[1]; pos[2] += off.dpos[2];
    }
    if (off.dposLocal !== undefined && off.dposLocal !== null) {
      if (!isFiniteV(off.dposLocal)) throw nanError(label, tc, "offset dposLocal", off.dposLocal);
      const w = qRotate(base.q, off.dposLocal);
      pos[0] += w[0]; pos[1] += w[1]; pos[2] += w[2];
    }
    const dh = offNum(off, "dh", label, tc);
    const dp = offNum(off, "dp", label, tc);
    const dr = offNum(off, "dr", label, tc);
    const dfov = offNum(off, "dfov", label, tc);
    const dfocus = offNum(off, "dfocus", label, tc);
    const orient = dh === 0 && dp === 0 && dr === 0
      ? { q: base.q, h: base.h, r: base.r }
      : { h: base.h + dh, p: base.p + dp, r: base.r + dr };
    const focus = base.focus !== undefined ? base.focus + dfocus : undefined;
    return finishPose(tc, pos, orient, base.fov + dfov, focus, label);
  };
  const meta = copyMeta(traj.meta, label);
  meta.offset = true;
  return assemble(headerFrom(traj, {
    meta,
    keyframes: Array.isArray(traj.keyframes) ? traj.keyframes.map((k) => ({ t: k.t, label: k.label })) : undefined,
  }), poseAt);
}

/** Blend two poses (weight w toward b): lerp position/fov/focus, slerp orientation, h/r hints interpolated. */
function blendPoses(a, b, w, t, label) {
  const pos = [a.pos[0] + (b.pos[0] - a.pos[0]) * w, a.pos[1] + (b.pos[1] - a.pos[1]) * w, a.pos[2] + (b.pos[2] - a.pos[2]) * w];
  const q = qSlerp(a.q, b.q, w);
  const hHint = a.h + shortestAngleDiff(b.h, a.h) * w;
  const rHint = a.r + shortestAngleDiff(b.r, a.r) * w;
  let focus;
  if (a.focus !== undefined && b.focus !== undefined) focus = a.focus + (b.focus - a.focus) * w;
  else focus = a.focus !== undefined ? a.focus : b.focus;
  const e = hprWithRoll(q, hHint, rHint);
  const pose = finishPose(t, pos, { q, h: e.h, r: e.r }, a.fov + (b.fov - a.fov) * w, focus, label);
  return pose;
}

/** Index of the last start ≤ t (binary search over a non-decreasing array). */
function segmentIndex(starts, t) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (starts[m] <= t) lo = m;
    else hi = m - 1;
  }
  return lo;
}

/**
 * Join trajectories end to end.
 *  - `bridge: 'cut'` (default): durations add; at each boundary the next shot
 *    starts (a deliberate discontinuity recorded in `meta.cuts`, which
 *    validateTrajectory skips).
 *  - `bridge: 'blend'`: consecutive shots OVERLAP by
 *    b = min(blendSec, dA/2, dB/2) seconds and cross-fade with a
 *    smootherstep weight (position/fov lerp, orientation slerp) — continuous;
 *    total = Σd − Σb. Use cuts for shots far apart (a blend between distant
 *    shots is a fast swoop).
 * The result has technique 'concat', family = the common family or 'mixed',
 * the most restrictive bounds, keyframes re-sampled at the shifted source
 * keyframe times, `meta.segments` `[{id, technique, family, start, end}]`,
 * and `subjectAt(t)` when every segment has subject information.
 * @param {Trajectory[]} list
 * @param {{bridge?:'cut'|'blend', blendSec?:number, id?:string}} [opts]
 * @returns {Trajectory}
 */
export function concatTrajectories(list, opts = {}) {
  const o = opts || {};
  if (!Array.isArray(list) || list.length === 0) {
    throw shotError("concatTrajectories: a non-empty array of trajectories is required", TRAJECTORY_ERROR_CODES.BAD_ARGUMENT);
  }
  list.forEach((tr, i) => assertTrajectory(tr, `concatTrajectories[${i}]`));
  const bridge = o.bridge === undefined || o.bridge === null ? "cut" : o.bridge;
  if (bridge !== "cut" && bridge !== "blend") {
    throw shotError(`concatTrajectories: bridge must be "cut" or "blend" (got ${show(bridge)})`, TRAJECTORY_ERROR_CODES.BAD_ARGUMENT);
  }
  const blendReq = o.blendSec === undefined || o.blendSec === null ? 0.5 : o.blendSec;
  if (!(typeof blendReq === "number" && Number.isFinite(blendReq) && blendReq >= 0)) {
    throw shotError(`concatTrajectories: blendSec must be a finite number ≥ 0 (got ${show(blendReq)})`, TRAJECTORY_ERROR_CODES.BAD_ARGUMENT);
  }
  const n = list.length;
  const durs = list.map((tr) => tr.duration);
  const blends = new Array(Math.max(0, n - 1)).fill(0);
  if (bridge === "blend") {
    for (let i = 0; i < n - 1; i++) blends[i] = Math.max(0, Math.min(blendReq, durs[i] / 2, durs[i + 1] / 2));
  }
  const starts = new Array(n);
  starts[0] = 0;
  for (let i = 1; i < n; i++) starts[i] = starts[i - 1] + durs[i - 1] - blends[i - 1];
  const total = starts[n - 1] + durs[n - 1];
  const cuts = [];
  for (let i = 1; i < n; i++) if (!(blends[i - 1] > 0)) cuts.push(starts[i]);
  const id = str(o.id, list.map((tr) => tr.id).join("+"));
  const families = new Set(list.map((tr) => tr.family));
  const family = families.size === 1 ? list[0].family : "mixed";

  const poseAt = (tc) => {
    const i = segmentIndex(starts, tc);
    const local = tc - starts[i];
    const cur = list[i].sample(local);
    if (i > 0 && blends[i - 1] > 0 && local < blends[i - 1]) {
      const prev = list[i - 1].sample(tc - starts[i - 1]);
      return blendPoses(prev, cur, smootherstep(local / blends[i - 1]), tc, id);
    }
    return { ...cur, t: tc };
  };

  const hasSubject = list.every((tr) => typeof tr.subjectAt === "function" || (tr.subject !== undefined && tr.subject !== null));
  const subjectAt = hasSubject
    ? (t) => {
      const tc = clampTime(t, total);
      const i = segmentIndex(starts, tc);
      const tr = list[i];
      return typeof tr.subjectAt === "function" ? tr.subjectAt(tc - starts[i]) : tr.subject;
    }
    : undefined;
  const sameSubject = list.every((tr) => tr.subject === list[0].subject) ? list[0].subject : undefined;

  const keyTimes = [];
  list.forEach((tr, i) => {
    if (Array.isArray(tr.keyframes)) {
      for (const k of tr.keyframes) keyTimes.push({ t: Math.min(total, Math.max(0, starts[i] + k.t)), label: k.label });
    }
  });

  const meta = {
    bridge,
    blendSec: bridge === "blend" ? blendReq : 0,
    cuts,
    segments: list.map((tr, i) => ({ id: tr.id, technique: tr.technique, family: tr.family, start: starts[i], end: starts[i] + durs[i] })),
  };
  return assemble({
    id,
    technique: "concat",
    family,
    duration: total,
    subject: sameSubject,
    subjectAt,
    bounds: intersectBounds(list.map((tr) => tr.bounds)),
    boundsExplicit: list.some((tr) => EXPLICIT_BOUNDS.has(tr)),
    meta,
    keyframes: keyTimes.length ? keyTimes : undefined,
  }, poseAt);
}

// ---------------------------------------------------------------------------
// baking, tables, checksum
// ---------------------------------------------------------------------------

/**
 * Frame times of a take at `fps`, fence-post inclusive: every 1/fps from 0,
 * plus a final time of exactly `duration` (so a table always reaches the end
 * pose). `ceil(duration·fps)` intervals; a duration within 1e-6 frames of a
 * whole number of frames gets no sliver frame. Duration 0 → `[0]`.
 * @param {number} duration seconds ≥ 0
 * @param {number} fps frames per second > 0
 * @returns {number[]}
 */
export function frameTimes(duration, fps) {
  if (!(Number.isFinite(duration) && duration >= 0)) {
    throw shotError(`frameTimes: duration must be a finite number ≥ 0 (got ${show(duration)})`, TRAJECTORY_ERROR_CODES.BAD_ARGUMENT);
  }
  if (!(Number.isFinite(fps) && fps > 0 && fps <= 1000)) {
    throw shotError(`frameTimes: fps must be a finite number in (0, 1000] (got ${show(fps)})`, TRAJECTORY_ERROR_CODES.BAD_ARGUMENT);
  }
  if (!(duration > 0)) return [0];
  const N = Math.max(1, Math.ceil(duration * fps - 1e-6));
  if (N + 1 > MAX_TABLE_FRAMES) {
    throw shotError(`frameTimes: ${N + 1} frames exceeds the ${MAX_TABLE_FRAMES}-frame limit`, TRAJECTORY_ERROR_CODES.BAD_ARGUMENT);
  }
  const out = new Array(N + 1);
  for (let k = 0; k < N; k++) out[k] = k / fps;
  out[N] = duration;
  return out;
}

/**
 * Bake a trajectory into a table at `fps` (SPEC §2.9): rows
 * `[t, x, y, z, qw, qx, qy, qz, fov, focus, roll]` at frameTimes(duration, fps)
 * (fence-post inclusive), quaternions sign-continuous (first row w ≥ 0),
 * focus 0 when the pose has none. Also carries the header (id, technique,
 * family, bounds, meta, duration) and `checksum = tableChecksum(rows)`.
 * Throws whatever sample() throws (FilmShotError NAN_POSE on NaN).
 * @param {Trajectory} traj
 * @param {number} fps
 * @returns {BakedTable}
 */
export function bakeTrajectory(traj, fps) {
  assertTrajectory(traj, "bakeTrajectory");
  const times = frameTimes(traj.duration, fps);
  const frames = times.length;
  const rows = new Float64Array(frames * TABLE_STRIDE);
  let prev = null;
  for (let k = 0; k < frames; k++) {
    const pose = traj.sample(times[k]);
    let q = qNorm(pose.q);
    if (prev) q = qEnsureContinuity(prev, q);
    else if (q[0] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
    prev = q;
    const o = k * TABLE_STRIDE;
    rows[o] = times[k];
    rows[o + 1] = pose.pos[0];
    rows[o + 2] = pose.pos[1];
    rows[o + 3] = pose.pos[2];
    rows[o + 4] = q[0];
    rows[o + 5] = q[1];
    rows[o + 6] = q[2];
    rows[o + 7] = q[3];
    rows[o + 8] = pose.fov;
    rows[o + 9] = pose.focus !== undefined ? pose.focus : 0;
    rows[o + 10] = Number.isFinite(pose.r) ? pose.r : 0;
  }
  return {
    fps,
    frames,
    rows,
    duration: traj.duration,
    id: traj.id,
    technique: traj.technique,
    family: traj.family,
    bounds: normalizeBounds(traj.bounds),
    meta: copyMeta(traj.meta, traj.id),
    checksum: tableChecksum(rows),
  };
}

/** Flatten rows given as Float64Array / number[] / number[][] into a Float64Array. */
function flattenRows(rows, fn) {
  if (rows instanceof Float64Array) return rows;
  if (ArrayBuffer.isView(rows)) return Float64Array.from(rows);
  if (Array.isArray(rows)) {
    if (rows.length > 0 && Array.isArray(rows[0])) {
      const out = new Float64Array(rows.length * TABLE_STRIDE);
      rows.forEach((r, i) => {
        if (!Array.isArray(r) || r.length !== TABLE_STRIDE) {
          throw shotError(`${fn}: row ${i} must have ${TABLE_STRIDE} values (${TABLE_COLUMNS.join(", ")})`, TRAJECTORY_ERROR_CODES.BAD_TABLE);
        }
        for (let c = 0; c < TABLE_STRIDE; c++) out[i * TABLE_STRIDE + c] = typeof r[c] === "number" ? r[c] : NaN;
      });
      return out;
    }
    return Float64Array.from(rows, (v) => (typeof v === "number" ? v : NaN));
  }
  throw shotError(`${fn}: rows must be a Float64Array, a flat number array or an array of ${TABLE_STRIDE}-value rows`, TRAJECTORY_ERROR_CODES.BAD_TABLE);
}

/** Positions (x, y, z) and focus are quantised to 1 mm, every other column to 1e-4. */
function quantScale(col) {
  return col === 1 || col === 2 || col === 3 || col === 9 ? 1e3 : 1e4;
}

/**
 * Stable checksum of a table's rows: each value is quantised to an integer
 * (round(v·1000) for x, y, z, focus — 1 mm; round(v·10000) for t, quaternion,
 * fov, roll — 1e-4), fed as 8 little-endian bytes of its 64-bit two's
 * complement into 32-bit FNV-1a (offset 0x811c9dc5, prime 0x01000193).
 * Non-finite values hash as distinct sentinels. Returns 8 lower-case hex
 * digits. Rows may be a Float64Array, a flat array or an array of rows.
 * @param {Float64Array|number[]|number[][]} rows
 * @returns {string}
 */
export function tableChecksum(rows) {
  const flat = flattenRows(rows, "tableChecksum");
  let h = 0x811c9dc5;
  const byte = (b) => {
    h ^= b & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  const word = (w) => {
    byte(w);
    byte(w >>> 8);
    byte(w >>> 16);
    byte(w >>> 24);
  };
  for (let i = 0; i < flat.length; i++) {
    const v = flat[i];
    let lo, hi;
    if (Number.isFinite(v)) {
      const q = Math.round(v * quantScale(i % TABLE_STRIDE));
      lo = q >>> 0;
      hi = Math.floor(q / 4294967296) >>> 0;
    } else if (v === Infinity) {
      lo = 0; hi = 0x7ff00000;
    } else if (v === -Infinity) {
      lo = 0; hi = 0xfff00000;
    } else {
      lo = 0; hi = 0x7ff80000;
    }
    word(lo);
    word(hi);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * JSON-safe copy of a baked table (rows as a flat number array). Inverse:
 * trajectoryFromTable accepts the result directly.
 * @param {BakedTable} table
 * @returns {{fps:number, frames:number, rows:number[], duration:number, id:string, technique:string,
 *   family:string, bounds:Bounds, meta:Object, checksum:string}}
 */
export function tableToJSON(table) {
  if (!table || typeof table !== "object") {
    throw shotError("tableToJSON: a baked table is required", TRAJECTORY_ERROR_CODES.BAD_TABLE);
  }
  const rows = flattenRows(table.rows, "tableToJSON");
  return {
    fps: table.fps,
    frames: rows.length / TABLE_STRIDE,
    rows: Array.from(rows),
    duration: table.duration,
    id: table.id,
    technique: table.technique,
    family: table.family,
    bounds: normalizeBounds(table.bounds),
    meta: copyMeta(table.meta, "tableToJSON"),
    checksum: tableChecksum(rows),
  };
}

/**
 * Replay trajectory of a baked / realised table (SPEC §2.9): position and fov
 * lerp, quaternion slerp between rows, focus lerp when both rows have one;
 * sampling exactly at a row time returns that row. Heading is recovered from
 * the quaternion with a continuity chain across rows and the stored roll
 * resolves the vertical (nadir/zenith) ambiguity. Times are shifted so the
 * first row is t = 0. Accepts BakedTable, tableToJSON output or
 * `{fps, rows}` with rows as Float64Array / flat array / array of rows.
 * Throws FilmShotError (code BAD_TABLE) for malformed tables (wrong row
 * width, non-finite values, non-increasing t, bad fps).
 * @param {{fps:number, rows:Float64Array|number[]|number[][], frames?:number, id?:string, technique?:string,
 *   family?:string, bounds?:Partial<Bounds>, meta?:Object}} table
 * @returns {Trajectory}
 */
export function trajectoryFromTable(table) {
  if (!table || typeof table !== "object") {
    throw shotError("trajectoryFromTable: a table {fps, rows} is required", TRAJECTORY_ERROR_CODES.BAD_TABLE);
  }
  const fps = table.fps;
  if (!(typeof fps === "number" && Number.isFinite(fps) && fps > 0)) {
    throw shotError(`trajectoryFromTable: fps must be a finite number > 0 (got ${show(fps)})`, TRAJECTORY_ERROR_CODES.BAD_TABLE);
  }
  const R = flattenRows(table.rows, "trajectoryFromTable");
  if (R.length === 0 || R.length % TABLE_STRIDE !== 0) {
    throw shotError(`trajectoryFromTable: rows length ${R.length} is not a positive multiple of ${TABLE_STRIDE}`, TRAJECTORY_ERROR_CODES.BAD_TABLE);
  }
  const frames = R.length / TABLE_STRIDE;
  if (frames > MAX_TABLE_FRAMES) {
    throw shotError(`trajectoryFromTable: ${frames} frames exceeds the ${MAX_TABLE_FRAMES}-frame limit`, TRAJECTORY_ERROR_CODES.BAD_TABLE);
  }
  if (table.frames !== undefined && table.frames !== null && table.frames !== frames) {
    throw shotError(`trajectoryFromTable: frames ${show(table.frames)} disagrees with ${frames} rows`, TRAJECTORY_ERROR_CODES.BAD_TABLE);
  }
  for (let i = 0; i < R.length; i++) {
    if (!Number.isFinite(R[i])) {
      const row = Math.floor(i / TABLE_STRIDE);
      throw shotError(`trajectoryFromTable: row ${row} column ${TABLE_COLUMNS[i % TABLE_STRIDE]} is not finite`, TRAJECTORY_ERROR_CODES.BAD_TABLE,
        { row, column: TABLE_COLUMNS[i % TABLE_STRIDE] });
    }
  }
  const t0 = R[0];
  const T = new Float64Array(frames);
  const Q = new Array(frames);
  const H = new Float64Array(frames);
  const P = new Float64Array(frames);
  const Rl = new Float64Array(frames);
  for (let k = 0; k < frames; k++) {
    const o = k * TABLE_STRIDE;
    T[k] = R[o] - t0;
    if (k > 0 && !(T[k] > T[k - 1])) {
      throw shotError(`trajectoryFromTable: t must increase strictly (row ${k}: ${fmt(R[o])} after ${fmt(R[o - TABLE_STRIDE])})`,
        TRAJECTORY_ERROR_CODES.BAD_TABLE, { row: k });
    }
    const fv = R[o + 8];
    if (!(fv > 0 && fv < 180)) {
      throw shotError(`trajectoryFromTable: row ${k} fov ${fmt(fv)} is outside (0, 180)`, TRAJECTORY_ERROR_CODES.BAD_TABLE, { row: k });
    }
    if (R[o + 9] < 0) {
      throw shotError(`trajectoryFromTable: row ${k} focus ${fmt(R[o + 9])} is negative`, TRAJECTORY_ERROR_CODES.BAD_TABLE, { row: k });
    }
    const raw = [R[o + 4], R[o + 5], R[o + 6], R[o + 7]];
    if (!quatLike(raw)) throw shotError(`trajectoryFromTable: row ${k} quaternion is zero`, TRAJECTORY_ERROR_CODES.BAD_TABLE, { row: k });
    let q = qNorm(raw);
    if (k > 0) q = qEnsureContinuity(Q[k - 1], q);
    Q[k] = q;
    const e = hprWithRoll(q, k > 0 ? H[k - 1] : 0, R[o + 10]);
    H[k] = e.h;
    P[k] = e.p;
    Rl[k] = e.r;
  }
  const D = T[frames - 1];
  const id = str(table.id, "table");
  const rowPose = (k, tc) => {
    const o = k * TABLE_STRIDE;
    const pose = { t: tc, pos: [R[o + 1], R[o + 2], R[o + 3]], h: H[k], p: P[k], r: Rl[k], q: Q[k].slice(), fov: R[o + 8] };
    if (R[o + 9] > 0) pose.focus = R[o + 9];
    return pose;
  };
  const poseAt = (tc) => {
    let lo = 0, hi = frames - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (T[m] <= tc) lo = m;
      else hi = m - 1;
    }
    const k = lo;
    if (k >= frames - 1 || T[k] === tc) return rowPose(k, tc);
    const u = (tc - T[k]) / (T[k + 1] - T[k]);
    const a = k * TABLE_STRIDE, b = a + TABLE_STRIDE;
    const pos = [R[a + 1] + (R[b + 1] - R[a + 1]) * u, R[a + 2] + (R[b + 2] - R[a + 2]) * u, R[a + 3] + (R[b + 3] - R[a + 3]) * u];
    const q = qSlerp(Q[k], Q[k + 1], u);
    const rollHint = R[a + 10] + shortestAngleDiff(R[b + 10], R[a + 10]) * u;
    const e = hprWithRoll(q, H[k] + (H[k + 1] - H[k]) * u, rollHint);
    const fa = R[a + 9], fb = R[b + 9];
    const pose = { t: tc, pos, h: e.h, p: e.p, r: e.r, q, fov: R[a + 8] + (R[b + 8] - R[a + 8]) * u };
    if (fa > 0 && fb > 0) pose.focus = fa + (fb - fa) * u;
    else {
      const f = u < 0.5 ? fa : fb;
      if (f > 0) pose.focus = f;
    }
    return pose;
  };
  const meta = copyMeta(table.meta, id);
  meta.fromTable = { fps, frames, checksum: tableChecksum(R) };
  const boundsGiven = table.bounds !== undefined && table.bounds !== null;
  return assemble({
    id,
    technique: str(table.technique, "table"),
    family: str(table.family, "classic"),
    duration: D,
    bounds: normalizeBounds(table.bounds, DEFAULT_BOUNDS),
    boundsExplicit: boundsGiven,
    meta,
  }, poseAt);
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/**
 * Check a trajectory (or a baked table) frame by frame at `fps`
 * (frameTimes grid). Issues (`{code, frame, t, value, limit, message}`, codes
 * in VALIDATION_CODES):
 *  - `nan` / `sample-error` — sample() threw or returned a non-finite pose;
 *  - `fov-range` (fov ∉ (0, 180)), `pitch-range` (|p| > π/2);
 *  - `teleport` — |Δpos|/Δt > maxLinearSpeed (m/s);
 *  - `angular-spike` — orientation change rate > maxAngularSpeedDeg (°/s);
 *  - `heading-flip` — the quaternion-derived heading (continuity chain) jumps
 *    by more than maxHeadingJumpDeg in one frame AND the image really rotates
 *    by at least half that (so a smooth pitch through the pole is NOT a flip,
 *    a stateless look-at passing over its target IS);
 *  - `fov-spike` — |Δfov|/Δt > maxFovRateDeg (°/s).
 * Intervals containing a declared cut (`meta.cuts`) skip the continuity
 * checks. At most `maxIssues` issues are listed; `counts` always has the full
 * per-code totals; `stats` the peak rates seen. `ok` ⇔ no issues at all.
 * A table input is replayed with trajectoryFromTable and checked at its own
 * fps unless `opts.fps` is given; an unusable input or an oversize frame grid
 * is a `structure` issue (never a throw).
 * Per-trajectory limits: a technique may declare its own limits in
 * `meta.validate` ({maxLinearSpeed?, maxAngularSpeedDeg?, maxHeadingJumpDeg?,
 * maxFovRateDeg?} — e.g. fpv.fpv-run's loops and rolls turn at up to 900°/s);
 * they apply BY DEFAULT (tables carry the meta too). Precedence per limit:
 * an explicit `opts` value > `meta.validate` > the built-in default;
 * `useMetaLimits: false` ignores meta.validate. The limits used are reported
 * in `limits` (with `source` per key: 'opts' | 'meta' | 'default').
 * @param {Trajectory|BakedTable} trajOrTable
 * @param {{fps?:number, maxLinearSpeed?:number, maxAngularSpeedDeg?:number, maxHeadingJumpDeg?:number,
 *   maxFovRateDeg?:number, maxIssues?:number, respectCuts?:boolean, useMetaLimits?:boolean}} [opts]
 *   defaults fps 30, maxLinearSpeed 80, maxAngularSpeedDeg 240, maxHeadingJumpDeg 90, maxFovRateDeg 240,
 *   maxIssues 64, respectCuts true, useMetaLimits true
 * @returns {{ok:boolean, issues:Array<{code:string, frame:number, t:number, value:number|null, limit:number|null,
 *   message:string}>, counts:Object<string, number>, frames:number, duration:number,
 *   stats:{maxSpeed:number, maxAngularSpeedDeg:number, maxFovRateDeg:number},
 *   limits:{maxLinearSpeed:number, maxAngularSpeedDeg:number, maxHeadingJumpDeg:number, maxFovRateDeg:number,
 *   source:Object<string, 'opts'|'meta'|'default'>}}}
 */
export function validateTrajectory(trajOrTable, opts = {}) {
  const o = opts || {};
  const num = (v, def, ok) => (typeof v === "number" && ok(v) ? v : def);
  const fpsOk = (v) => Number.isFinite(v) && v > 0 && v <= 1000;
  const isTable = !!trajOrTable && typeof trajOrTable === "object" && trajOrTable.rows !== undefined && typeof trajOrTable.sample !== "function";
  const fps = num(o.fps, isTable ? num(trajOrTable.fps, 30, fpsOk) : 30, fpsOk);
  const metaV = o.useMetaLimits !== false && trajOrTable && typeof trajOrTable === "object" && trajOrTable.meta &&
    typeof trajOrTable.meta === "object" && trajOrTable.meta.validate && typeof trajOrTable.meta.validate === "object"
    ? trajOrTable.meta.validate : null;
  const source = {};
  /** opts value > meta.validate value > default, each only when it passes `ok`. */
  const limit = (key, def, ok) => {
    if (typeof o[key] === "number" && ok(o[key])) { source[key] = "opts"; return o[key]; }
    if (metaV && typeof metaV[key] === "number" && ok(metaV[key])) { source[key] = "meta"; return metaV[key]; }
    source[key] = "default";
    return def;
  };
  const maxLinV = limit("maxLinearSpeed", 80, (v) => v > 0);
  const maxAngV = limit("maxAngularSpeedDeg", 240, (v) => v > 0);
  const maxJumpV = limit("maxHeadingJumpDeg", 90, (v) => v > 0 && v <= 180);
  const maxFovRate = limit("maxFovRateDeg", 240, (v) => v > 0);
  const maxLin = maxLinV;
  const maxAng = maxAngV * DEG;
  const maxJump = maxJumpV * DEG;
  const maxIssues = num(o.maxIssues, 64, (v) => Number.isInteger(v) && v >= 0);
  const respectCuts = o.respectCuts !== false;
  const limits = { maxLinearSpeed: maxLinV, maxAngularSpeedDeg: maxAngV, maxHeadingJumpDeg: maxJumpV, maxFovRateDeg: maxFovRate, source };

  const issues = [];
  const counts = {};
  for (const c of Object.values(VALIDATION_CODES)) counts[c] = 0;
  const stats = { maxSpeed: 0, maxAngularSpeedDeg: 0, maxFovRateDeg: 0 };
  const report = (code, frame, t, value, limit, message) => {
    counts[code] += 1;
    if (issues.length < maxIssues) {
      issues.push({ code, frame, t, value: Number.isFinite(value) ? value : null, limit: Number.isFinite(limit) ? limit : null, message });
    }
  };

  let traj = trajOrTable;
  if (isTable) {
    try {
      traj = trajectoryFromTable(traj);
    } catch (e) {
      report(VALIDATION_CODES.STRUCTURE, -1, 0, null, null, `table: ${e && e.message ? e.message : String(e)}`);
      return { ok: false, issues, counts, frames: 0, duration: 0, stats, limits };
    }
  }
  if (!isTrajectory(traj)) {
    report(VALIDATION_CODES.STRUCTURE, -1, 0, null, null, "not a Trajectory (needs sample(t) and a finite duration ≥ 0)");
    return { ok: false, issues, counts, frames: 0, duration: 0, stats, limits };
  }
  let times;
  try {
    times = frameTimes(traj.duration, fps);
  } catch (e) {
    report(VALIDATION_CODES.STRUCTURE, -1, 0, null, null, e && e.message ? e.message : String(e));
    return { ok: false, issues, counts, frames: 0, duration: traj.duration, stats, limits };
  }
  const cuts = respectCuts && traj.meta && Array.isArray(traj.meta.cuts) ? traj.meta.cuts.filter(Number.isFinite) : [];

  let prev = null; // {t, pos, q, h, fov, frame}
  for (let k = 0; k < times.length; k++) {
    const t = times[k];
    let pose;
    try {
      pose = traj.sample(t);
    } catch (e) {
      const isNan = e instanceof FilmShotError && e.code === TRAJECTORY_ERROR_CODES.NAN_POSE;
      report(isNan ? VALIDATION_CODES.NAN : VALIDATION_CODES.SAMPLE_ERROR, k, t, null, null,
        `t=${fmt(t)}: ${e && e.message ? e.message : String(e)}`);
      prev = null;
      continue;
    }
    const finite = pose && isFiniteV(pose.pos) && quatLike(pose.q) && Number.isFinite(pose.fov) &&
      Number.isFinite(pose.h) && Number.isFinite(pose.p) && Number.isFinite(pose.r);
    if (!finite) {
      report(VALIDATION_CODES.NAN, k, t, null, null, `t=${fmt(t)}: pose has non-finite components`);
      prev = null;
      continue;
    }
    if (!(pose.fov > 0 && pose.fov < 180)) {
      report(VALIDATION_CODES.FOV_RANGE, k, t, pose.fov, null, `t=${fmt(t)}: fov ${fmt(pose.fov)}° outside (0, 180)`);
    }
    if (Math.abs(pose.p) > HALF_PI + 1e-9) {
      report(VALIDATION_CODES.PITCH_RANGE, k, t, pose.p, HALF_PI, `t=${fmt(t)}: pitch ${fmt(pose.p / DEG)}° outside [−90°, 90°]`);
    }
    const q = qNorm(pose.q);
    const hq = hprFromQuat(q, prev ? prev.h : pose.h).h;
    const cur = { t, pos: pose.pos, q, h: hq, fov: pose.fov };
    if (prev) {
      const dt = t - prev.t;
      const acrossCut = cuts.some((c) => c > prev.t + 1e-9 && c <= t + 1e-9);
      if (dt > 1e-9 && !acrossCut) {
        const dx = cur.pos[0] - prev.pos[0], dy = cur.pos[1] - prev.pos[1], dz = cur.pos[2] - prev.pos[2];
        const speed = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
        if (speed > stats.maxSpeed) stats.maxSpeed = speed;
        if (speed > maxLin) {
          report(VALIDATION_CODES.TELEPORT, k, t, speed, maxLin, `t=${fmt(t)}: moved at ${fmt(speed)} m/s (limit ${fmt(maxLin)})`);
        }
        const ang = qAngle(prev.q, cur.q);
        const angRate = ang / dt;
        if (angRate / DEG > stats.maxAngularSpeedDeg) stats.maxAngularSpeedDeg = angRate / DEG;
        if (angRate > maxAng) {
          report(VALIDATION_CODES.ANGULAR_SPIKE, k, t, angRate / DEG, maxAng / DEG,
            `t=${fmt(t)}: rotated at ${fmt(angRate / DEG)}°/s (limit ${fmt(maxAng / DEG)})`);
        }
        const jump = Math.abs(shortestAngleDiff(cur.h, prev.h));
        if (jump > maxJump && ang >= 0.5 * jump) {
          report(VALIDATION_CODES.HEADING_FLIP, k, t, jump / DEG, maxJump / DEG,
            `t=${fmt(t)}: heading jumped ${fmt(jump / DEG)}° in one frame (gimbal flip)`);
        }
        const fovRate = Math.abs(cur.fov - prev.fov) / dt;
        if (fovRate > stats.maxFovRateDeg) stats.maxFovRateDeg = fovRate;
        if (fovRate > maxFovRate) {
          report(VALIDATION_CODES.FOV_SPIKE, k, t, fovRate, maxFovRate, `t=${fmt(t)}: fov changed at ${fmt(fovRate)}°/s (limit ${fmt(maxFovRate)})`);
        }
      }
    }
    prev = cur;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { ok: total === 0, issues, counts, frames: times.length, duration: traj.duration, stats, limits };
}

// ---------------------------------------------------------------------------
// technique helpers
// ---------------------------------------------------------------------------

/**
 * `orientAt` for makeTrajectory that looks at a target (SPEC §2.3
 * lookRotation, stateless — pure in t). `target` is `[x,y,z]` or `(t) →
 * [x,y,z]`; `headingHint` / `roll` are numbers or functions of t (radians;
 * the hint is used inside the vertical hold cone, i.e. it sets the image "up"
 * of a straight-down shot); `offset` `{dh, dp}` (or a function of t) is added
 * after the look-at (e.g. thirdsAimOffset). Throws FilmShotError (NAN_POSE)
 * when the target is not finite.
 * @param {number[]|((t:number)=>number[])} target
 * @param {{headingHint?:number|((t:number)=>number), roll?:number|((t:number)=>number), holdConeDeg?:number,
 *   offset?:{dh?:number, dp?:number}|((t:number)=>{dh?:number, dp?:number})}} [opts]
 * @returns {(t:number, pos:number[]) => {h:number, p:number, r:number, q?:number[]}}
 */
export function orientLookAt(target, opts = {}) {
  const o = opts || {};
  if (typeof target !== "function" && !isFiniteV(target)) {
    throw shotError("orientLookAt: target must be a finite [x,y,z] or a function of t", TRAJECTORY_ERROR_CODES.BAD_ARGUMENT);
  }
  const tgt = typeof target === "function" ? target : (() => {
    const c = [target[0], target[1], target[2]];
    return () => c;
  })();
  const hint = asFnOfT(o.headingHint === undefined || o.headingHint === null ? 0 : o.headingHint);
  const roll = asFnOfT(o.roll === undefined || o.roll === null ? 0 : o.roll);
  const offset = o.offset === undefined || o.offset === null ? null : asFnOfT(o.offset);
  const holdConeDeg = Number.isFinite(o.holdConeDeg) && o.holdConeDeg >= 0 ? o.holdConeDeg : undefined;
  return (t, pos) => {
    const T = tgt(t);
    if (!isFiniteV(T)) throw nanError("orientLookAt", t, "look target", T);
    const hh = hint(t), rr = roll(t);
    if (!Number.isFinite(hh)) throw nanError("orientLookAt", t, "heading hint", hh);
    if (!Number.isFinite(rr)) throw nanError("orientLookAt", t, "roll", rr);
    const la = lookRotation(pos, T, { headingHint: hh, roll: rr, holdConeDeg });
    if (!offset) return la;
    const off = offset(t) || {};
    const dh = Number.isFinite(off.dh) ? off.dh : 0;
    const dp = Number.isFinite(off.dp) ? off.dp : 0;
    if (dh === 0 && dp === 0) return la;
    return { h: la.h + dh, p: la.p + dp, r: la.r };
  };
}

/**
 * Smooth, gimbal-flip-free look-at as a PURE `orientAt`: runs the stateful
 * createLookController (SPEC §2.3 — springs, rate limits, nadir policy
 * 'yaw-slew' | 'pitch-through' | 'hold') over the whole shot ONCE at
 * construction, sampling `positionAt` / `target` at `rate` Hz, and returns
 * `(t) → {q, h, r}` that slerps between the pre-simulated orientations — so
 * sample(t) stays pure while a drone pass-over or a tilt to straight down
 * slews the image smoothly instead of flipping. The first sample snaps to the
 * exact look rotation. Pair it with the SAME positionAt in makeTrajectory
 * (the `pos` argument is ignored). Throws FilmShotError (NAN_POSE) when a
 * position or target is not finite, (BAD_ARGUMENT) for bad inputs; options
 * are validated by createLookController.
 * @param {((t:number)=>number[])|number[]} positionAt
 * @param {((t:number)=>number[])|number[]} target
 * @param {number} duration seconds ≥ 0
 * @param {{rate?:number, maxYawRate?:number, maxPitchRate?:number, smoothTime?:number, holdConeDeg?:number,
 *   nadirMode?:'yaw-slew'|'pitch-through'|'hold', leadGain?:number, roll?:number|((t:number)=>number),
 *   headingHint?:number|((t:number)=>number)}} [opts] rate default 120 Hz (10…1000)
 * @returns {(t:number) => {q:number[], h:number, r:number}}
 */
export function smoothLookAt(positionAt, target, duration, opts = {}) {
  const o = opts || {};
  const posFn = typeof positionAt === "function" ? positionAt : isFiniteV(positionAt) ? () => positionAt : null;
  const tgtFn = typeof target === "function" ? target : isFiniteV(target) ? () => target : null;
  if (!posFn || !tgtFn) {
    throw shotError("smoothLookAt: positionAt and target must be finite [x,y,z] or functions of t", TRAJECTORY_ERROR_CODES.BAD_ARGUMENT);
  }
  if (!(typeof duration === "number" && Number.isFinite(duration) && duration >= 0)) {
    throw shotError(`smoothLookAt: duration must be a finite number ≥ 0 (got ${show(duration)})`, TRAJECTORY_ERROR_CODES.BAD_ARGUMENT);
  }
  const rate = typeof o.rate === "number" && Number.isFinite(o.rate) ? Math.min(1000, Math.max(10, o.rate)) : 120;
  const roll = asFnOfT(o.roll === undefined || o.roll === null ? 0 : o.roll);
  const hint = o.headingHint === undefined || o.headingHint === null ? null : asFnOfT(o.headingHint);
  let ctl;
  try {
    ctl = createLookController({
      maxYawRate: o.maxYawRate, maxPitchRate: o.maxPitchRate, smoothTime: o.smoothTime,
      holdConeDeg: o.holdConeDeg, nadirMode: o.nadirMode, leadGain: o.leadGain,
    });
  } catch (e) {
    throw shotError(`smoothLookAt: ${e && e.message ? e.message : String(e)}`, TRAJECTORY_ERROR_CODES.BAD_ARGUMENT);
  }
  const N = duration > 0 ? Math.max(1, Math.ceil(duration * rate)) : 0;
  if (N + 1 > MAX_TABLE_FRAMES) {
    throw shotError(`smoothLookAt: ${N + 1} steps exceeds the ${MAX_TABLE_FRAMES}-step limit`, TRAJECTORY_ERROR_CODES.BAD_ARGUMENT);
  }
  const dt = N > 0 ? duration / N : 0;
  const Qs = new Array(N + 1);
  const H = new Float64Array(N + 1);
  const Rl = new Float64Array(N + 1);
  for (let k = 0; k <= N; k++) {
    const t = k === N ? duration : k * dt;
    const pos = posFn(t);
    const tgt = tgtFn(t);
    if (!isFiniteV(pos)) throw nanError("smoothLookAt", t, "position", pos);
    if (!isFiniteV(tgt)) throw nanError("smoothLookAt", t, "look target", tgt);
    const rr = roll(t);
    if (!Number.isFinite(rr)) throw nanError("smoothLookAt", t, "roll", rr);
    const uo = { roll: rr };
    if (hint) {
      const hh = hint(t);
      if (!Number.isFinite(hh)) throw nanError("smoothLookAt", t, "heading hint", hh);
      uo.headingHint = hh;
    }
    const out = ctl.update(pos, tgt, k === 0 ? 0 : dt, uo);
    const q = qNorm(out.q);
    Qs[k] = k > 0 ? qEnsureContinuity(Qs[k - 1], q) : q;
    H[k] = out.h;
    Rl[k] = out.r;
  }
  return (t) => {
    const tc = clampTime(t, duration);
    if (N === 0) return { q: Qs[0].slice(), h: H[0], r: Rl[0] };
    const x = tc / dt;
    const i = Math.min(N - 1, Math.floor(x));
    const u = Math.min(1, Math.max(0, x - i));
    if (u === 0) return { q: Qs[i].slice(), h: H[i], r: Rl[i] };
    return { q: qSlerp(Qs[i], Qs[i + 1], u), h: H[i] + (H[i + 1] - H[i]) * u, r: Rl[i] + (Rl[i + 1] - Rl[i]) * u };
  };
}

/**
 * The subject of a ShotContext at time t: `ctx.subjectAt(t)` when present,
 * else `ctx.subject`, else null.
 * @param {{subject?:*, subjectAt?:(t:number)=>*}} ctx
 * @param {number} t
 * @returns {*}
 */
export function subjectAtTime(ctx, t) {
  if (!ctx || typeof ctx !== "object") return null;
  if (typeof ctx.subjectAt === "function") {
    const s = ctx.subjectAt(t);
    if (s !== undefined && s !== null) return s;
  }
  return ctx.subject !== undefined ? ctx.subject : null;
}

/**
 * Look target function for a shot's subject: `(t) → aimPointForFraming(framing,
 * subject at t)` — the eye line for close framings, the centre for wide ones.
 * Without a subject it aims at `ctx.anchor`. Throws FilmShotError
 * (MISSING_SUBJECT) when the context has neither, (BAD_FRAMING) for an
 * unknown framing.
 * @param {{subject?:*, subjectAt?:(t:number)=>*, anchor?:number[]}} ctx
 * @param {string|number} [framing='MS']
 * @returns {(t:number) => number[]}
 */
export function aimSubject(ctx, framing = "MS") {
  const fr = framing === undefined || framing === null ? "MS" : framing;
  framingFactor(fr);
  const c = ctx || {};
  const has = typeof c.subjectAt === "function" || (c.subject !== undefined && c.subject !== null);
  if (has) return (t) => aimPointForFraming(fr, subjectAtTime(c, t));
  if (isFiniteV(c.anchor)) {
    const a = [c.anchor[0], c.anchor[1], c.anchor[2]];
    return () => a.slice();
  }
  throw shotError("aimSubject: the shot context has no subject and no anchor to aim at", TRAJECTORY_ERROR_CODES.MISSING_SUBJECT);
}

/** C¹ soft floor: z when z ≥ floor + k, else floor + k·exp((z − floor − k)/k) (> floor). */
function softAbove(z, floor, k) {
  const d = z - floor;
  if (!(k > 0)) return d >= 0 ? z : floor;
  if (d >= k) return z;
  return floor + k * Math.exp((d - k) / k);
}

/** Finite number or null (a throwing callback counts as no data). */
function sampleZ(fn, x, y) {
  if (typeof fn !== "function") return null;
  let z;
  try {
    z = fn(x, y);
  } catch {
    return null;
  }
  return typeof z === "number" && Number.isFinite(z) ? z : null;
}

/**
 * Keep a camera position inside the shot's legal envelope (SPEC §2.12):
 * outdoors at least `clearance` (0.7 m) above `ctx.groundZ(x, y)`; indoors
 * (`ctx.indoor`) at least `floorClearance` above `indoor.floor` and
 * `ceilingClearance` below `indoor.ceiling` (midway when the gap is too
 * small). The floor/ceiling are approached with a C¹ exponential soft limit of
 * width `soft` metres (0 = hard clamp), so a path that dips below the floor
 * glides along it instead of kinking; positions well inside the envelope are
 * returned unchanged. Unknown ground (null) leaves z alone. Pure; x, y never change.
 * @param {number[]} pos
 * @param {{groundZ?:(x:number,y:number)=>number|null, indoor?:{floor?:Function, ceiling?:Function}|null}} ctx
 * @param {{clearance?:number, floorClearance?:number, ceilingClearance?:number, soft?:number}} [opts]
 *   defaults clearance 0.7, floorClearance 0.5, ceilingClearance 0.3, soft 0.5
 * @returns {number[]}
 */
export function clampToEnvelope(pos, ctx, opts = {}) {
  if (!isFiniteV(pos)) throw nanError("clampToEnvelope", NaN, "position", pos);
  const o = opts || {};
  const nn = (v, d) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const clearance = nn(o.clearance, GROUND_CLEARANCE);
  const floorCl = nn(o.floorClearance, 0.5);
  const ceilCl = nn(o.ceilingClearance, 0.3);
  const soft = nn(o.soft, 0.5);
  const x = pos[0], y = pos[1];
  let z = pos[2];
  const c = ctx || {};
  if (c.indoor && typeof c.indoor === "object") {
    const fl = sampleZ(c.indoor.floor, x, y);
    const ce = sampleZ(c.indoor.ceiling, x, y);
    const lo = fl !== null ? fl + floorCl : null;
    const hi = ce !== null ? ce - ceilCl : null;
    if (lo !== null && hi !== null && lo > hi) return [x, y, (fl + ce) / 2];
    const k = lo !== null && hi !== null ? Math.min(soft, (hi - lo) / 2) : soft;
    if (lo !== null) z = softAbove(z, lo, k);
    if (hi !== null) z = -softAbove(-z, -hi, k);
    if (lo !== null && z < lo) z = lo;
    if (hi !== null && z > hi) z = hi;
    return [x, y, z];
  }
  const g = sampleZ(c.groundZ, x, y);
  if (g !== null) z = softAbove(z, g + clearance, soft);
  return [x, y, z];
}

/**
 * Fraction of frames in which the subject's framing aim point is in frame
 * (in front and |ndc| ≤ 1 + margin) — the SPEC §2.12 "≥ 95% of samples"
 * check for techniques with `needs.subject`. The subject comes from
 * `opts.subject` (object or function of t), else `traj.subjectAt` /
 * `traj.subject`. Throws FilmShotError (MISSING_SUBJECT) when none is known.
 * @param {Trajectory} traj
 * @param {{subject?:*|((t:number)=>*), framing?:string|number, fps?:number, aspect?:number, margin?:number}} [opts]
 *   defaults framing 'MS', fps 30, aspect 16/9, margin 0
 * @returns {{fraction:number, samples:number, inFrame:number, firstMiss:number|null}}
 */
export function subjectCoverage(traj, opts = {}) {
  assertTrajectory(traj, "subjectCoverage");
  const o = opts || {};
  const framing = o.framing === undefined || o.framing === null ? "MS" : o.framing;
  framingFactor(framing);
  const fps = Number.isFinite(o.fps) && o.fps > 0 ? o.fps : 30;
  const aspect = Number.isFinite(o.aspect) && o.aspect > 0 ? o.aspect : DEFAULT_ASPECT;
  const lim = 1 + (Number.isFinite(o.margin) && o.margin >= 0 ? o.margin : 0);
  let subj = null;
  if (typeof o.subject === "function") subj = o.subject;
  else if (o.subject !== undefined && o.subject !== null) subj = () => o.subject;
  else if (typeof traj.subjectAt === "function") subj = traj.subjectAt;
  else if (traj.subject !== undefined && traj.subject !== null) subj = () => traj.subject;
  if (!subj) throw shotError("subjectCoverage: no subject (pass opts.subject or give the trajectory a subject)", TRAJECTORY_ERROR_CODES.MISSING_SUBJECT);
  const times = frameTimes(traj.duration, fps);
  let inFrame = 0;
  let firstMiss = null;
  for (const t of times) {
    const pose = traj.sample(t);
    const P = projectToNdc(pose, aimPointForFraming(framing, subj(t)), pose.fov, aspect);
    if (P.inFront && Math.abs(P.x) <= lim && Math.abs(P.y) <= lim) inFrame += 1;
    else if (firstMiss === null) firstMiss = t;
  }
  return { fraction: inFrame / times.length, samples: times.length, inFrame, firstMiss };
}
