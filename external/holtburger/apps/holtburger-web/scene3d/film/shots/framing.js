// scene3d/film/shots/framing.js — shot sizes, screen projection and composition metrics (SPEC §2.10).
//
// WHY: every technique, the scout/solver and the JEV pilot's "framing" question
// need ONE definition of how big a subject should be on screen and where it
// sits. Shot sizes are expressed as the frame height in units of the subject
// height (FRAMINGS: a full shot shows 1.15·H of world height, a close-up
// 0.2·H), so camera distance and fov follow from the pinhole model:
//   frame height at distance d = 2·d·tan(fov/2)   ⇒   d = k·H / (2·tan(fov/2)).
// projectToNdc reproduces three.js PerspectiveCamera projection exactly (same
// NDC values, including the mirrored values three produces for points behind
// the camera) but straight from an AC-frame Pose, so Node tools and tests can
// measure composition without a renderer.
//
// Conventions (SPEC §1): AC world metres (x east, y north, z up). A SUBJECT is
// `{pos, height, radius}` where `pos` is the BASE (feet / ground contact) and
// the subject spans pos.z .. pos.z + height. A `{center, radius}` sphere is
// also accepted (normalizeSubject converts it). Vertical fov in degrees;
// aspect = width / height. NDC: x right, y up, the frame is [−1, 1]².
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks. Deterministic; never returns NaN.

import { FilmShotError } from "../core/errors.js";
import { quatFromHPR } from "../core/gimbal.js";
import { qNorm, qToBasis } from "../core/quat.js";
import { dist, dot, isFiniteV, sub } from "../core/vec3.js";

const DEG = Math.PI / 180;
const HALF_PI = Math.PI / 2;
/** NDC values are clamped to ±this so off-axis / behind points never produce Infinity. */
const NDC_LIMIT = 1e6;

/**
 * Shot sizes: frame height = k · subject height (SPEC §2.10).
 * EWS extreme wide · WS wide · FS full · MWS medium-wide (knees up) · MS medium
 * (waist up) · MCU medium close-up · CU close-up · ECU extreme close-up.
 * @type {Readonly<{EWS:number, WS:number, FS:number, MWS:number, MS:number, MCU:number, CU:number, ECU:number}>}
 */
export const FRAMINGS = Object.freeze({ EWS: 8.0, WS: 2.5, FS: 1.15, MWS: 0.75, MS: 0.5, MCU: 0.33, CU: 0.2, ECU: 0.1 });

/** Framing names, widest first. @type {ReadonlyArray<string>} */
export const FRAMING_NAMES = Object.freeze(Object.keys(FRAMINGS));

/** Subject height assumed when a subject gives none (an AC humanoid, metres). */
export const DEFAULT_SUBJECT_HEIGHT = 1.8;

/** Default frame aspect (width / height) when none or an invalid one is given. */
export const DEFAULT_ASPECT = 16 / 9;

/** Default vertical fov (degrees) when neither the argument nor the pose carries a valid one. */
export const DEFAULT_FRAMING_FOV = 60;

/** Depth (metres) below which a subject segment is clipped for size measurement (the camera near plane). */
export const FRAMING_NEAR = 0.1;

/**
 * Machine-readable `.code`s of the FilmShotErrors thrown by this module.
 * @type {Readonly<{BAD_FRAMING:string, BAD_SUBJECT:string, BAD_ARGUMENT:string}>}
 */
export const FRAMING_ERROR_CODES = Object.freeze({
  BAD_FRAMING: "BAD_FRAMING",
  BAD_SUBJECT: "BAD_SUBJECT",
  BAD_ARGUMENT: "BAD_ARGUMENT",
});

/**
 * @typedef {Object} Subject
 * @property {number[]} pos     BASE of the subject (feet / ground contact), AC world metres
 * @property {number}   height  metres (> 0)
 * @property {number}   radius  bounding radius in metres (> 0)
 * @property {number}   [heading]  compass radians the subject faces
 * @property {number[]} [velocity] m/s, world frame
 */

/**
 * @typedef {Object} NdcPoint
 * @property {number}  x        NDC x (right +), three.js-identical, clamped to ±1e6
 * @property {number}  y        NDC y (up +), three.js-identical, clamped to ±1e6
 * @property {number}  depth    metres along the camera forward (negative = behind)
 * @property {boolean} inFront  depth > 0
 * @property {boolean} onScreen inFront && |x| ≤ 1 && |y| ≤ 1
 */

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** @param {string} message @param {string} code @param {*} [details] @returns {FilmShotError} */
function err(message, code, details) {
  return new FilmShotError(message, details === undefined ? { code } : { code, details });
}

/** Clamp to ±NDC_LIMIT (NaN → 0). */
function clampNdc(v) {
  if (!(v === v)) return 0;
  return v > NDC_LIMIT ? NDC_LIMIT : v < -NDC_LIMIT ? -NDC_LIMIT : v;
}

/** Vertical fov in degrees: the argument when valid, else the fallback when valid, else 60. */
function resolveFov(fovDeg, fallback) {
  if (Number.isFinite(fovDeg) && fovDeg > 0 && fovDeg < 180) return fovDeg;
  if (Number.isFinite(fallback) && fallback > 0 && fallback < 180) return fallback;
  return DEFAULT_FRAMING_FOV;
}

/** Aspect when valid (finite > 0), else 16/9. */
function resolveAspect(aspect) {
  return Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
}

/** True for a finite, non-zero 4-component quaternion. */
function quatLike(q) {
  if (q == null || typeof q !== "object") return false;
  const w = q[0], x = q[1], y = q[2], z = q[3];
  if (!Number.isFinite(w) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  return w * w + x * x + y * y + z * z > 1e-24;
}

/**
 * Orientation quaternion of a pose: `pose.q` when valid, else quatFromHPR(h, p, r), else identity.
 * @param {{q?:number[], h?:number, p?:number, r?:number}} pose
 * @returns {number[]} unit `[w, x, y, z]`
 */
export function poseQuat(pose) {
  if (pose && quatLike(pose.q)) return qNorm(pose.q);
  if (pose && Number.isFinite(pose.h) && Number.isFinite(pose.p)) {
    return quatFromHPR(pose.h, pose.p, Number.isFinite(pose.r) ? pose.r : 0);
  }
  return [1, 0, 0, 0];
}

// ---------------------------------------------------------------------------
// shot sizes
// ---------------------------------------------------------------------------

/**
 * The frame-height factor k of a framing: a FRAMINGS name (case-insensitive)
 * or a positive number (used as k directly). Throws FilmShotError
 * (code BAD_FRAMING) listing the valid names otherwise.
 * @param {string|number} framing
 * @returns {number}
 */
export function framingFactor(framing) {
  if (typeof framing === "number") {
    if (Number.isFinite(framing) && framing > 0) return framing;
  } else if (typeof framing === "string") {
    const key = framing.trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(FRAMINGS, key)) return FRAMINGS[key];
  }
  throw err(
    `unknown framing ${typeof framing === "string" ? JSON.stringify(framing) : String(framing)} ` +
      `(valid: ${FRAMING_NAMES.join(", ")}, or a number > 0 = frame height / subject height)`,
    FRAMING_ERROR_CODES.BAD_FRAMING,
    { framing: typeof framing === "string" || typeof framing === "number" ? framing : String(framing), valid: FRAMING_NAMES.slice() },
  );
}

/**
 * Canonical form of a framing: the upper-case FRAMINGS name, or the number
 * itself. Throws like framingFactor on invalid input.
 * @param {string|number} framing
 * @returns {string|number}
 */
export function canonicalFraming(framing) {
  framingFactor(framing);
  return typeof framing === "string" ? framing.trim().toUpperCase() : framing;
}

/**
 * Height of the aim point as a fraction of the subject height: the eye line
 * (0.9) for MS and tighter, the centre (0.5) for FS and wider, linear in k in
 * between (MWS → ≈0.75).
 * @param {string|number} framing
 * @returns {number} in [0.5, 0.9]
 */
export function aimHeightFraction(framing) {
  const k = framingFactor(framing);
  const wide = FRAMINGS.FS, close = FRAMINGS.MS;
  if (k >= wide) return 0.5;
  if (k <= close) return 0.9;
  return 0.5 + (0.4 * (wide - k)) / (wide - close);
}

/**
 * Camera distance that frames `H` metres of subject at `framing` with a
 * vertical fov of `fovDeg`: `k·H / (2·tan(fov/2))`.
 * Example: FS (1.15) of a 1.8 m human at fov 50° → 2.2196 m.
 * @param {string|number} framing
 * @param {number} H subject height in metres (> 0)
 * @param {number} fovDeg vertical fov in degrees, (0, 180)
 * @returns {number} metres
 */
export function distanceForFraming(framing, H, fovDeg) {
  const k = framingFactor(framing);
  if (!(Number.isFinite(H) && H > 0)) {
    throw err(`distanceForFraming: subject height must be a finite number > 0 (got ${H})`, FRAMING_ERROR_CODES.BAD_ARGUMENT);
  }
  if (!(Number.isFinite(fovDeg) && fovDeg > 0 && fovDeg < 180)) {
    throw err(`distanceForFraming: fovDeg must be in (0, 180) (got ${fovDeg})`, FRAMING_ERROR_CODES.BAD_ARGUMENT);
  }
  return (k * H) / (2 * Math.tan((fovDeg * DEG) / 2));
}

/**
 * Vertical fov (degrees) that frames `H` metres of subject at `framing` from
 * `dist` metres: `2·atan(k·H / (2·dist))` (inverse of distanceForFraming).
 * @param {string|number} framing
 * @param {number} H subject height in metres (> 0)
 * @param {number} dist camera distance in metres (> 0)
 * @returns {number} degrees in (0, 180)
 */
export function fovForFraming(framing, H, dist) {
  const k = framingFactor(framing);
  if (!(Number.isFinite(H) && H > 0)) {
    throw err(`fovForFraming: subject height must be a finite number > 0 (got ${H})`, FRAMING_ERROR_CODES.BAD_ARGUMENT);
  }
  if (!(Number.isFinite(dist) && dist > 0)) {
    throw err(`fovForFraming: distance must be a finite number > 0 (got ${dist})`, FRAMING_ERROR_CODES.BAD_ARGUMENT);
  }
  return (2 * Math.atan((k * H) / (2 * dist))) / DEG;
}

// ---------------------------------------------------------------------------
// subjects
// ---------------------------------------------------------------------------

/**
 * Normalise a subject description to `{pos (base), height, radius, ...extra}`.
 *
 * Accepted inputs:
 *  - `[x, y, z]` → a default 1.8 m subject standing at that point;
 *  - `{pos|position, height?, radius?, ...}` → pos is the BASE; height defaults
 *    to 2·radius when a radius is given, else 1.8; radius defaults to 0.25·height;
 *  - `{center, radius, height?}` → a sphere/box centred at `center`; the base is
 *    center − height/2 (height defaults to 2·radius; radius defaults to 0.5).
 * Extra fields (heading, velocity, guid, …) are kept. Throws FilmShotError
 * (code BAD_SUBJECT) for a missing / non-finite position or a negative /
 * non-finite size.
 * @param {*} subject
 * @returns {Subject}
 */
export function normalizeSubject(subject) {
  if (Array.isArray(subject) || ArrayBuffer.isView(subject)) {
    if (!isFiniteV(subject)) throw err(`subject position must be a finite [x,y,z] (got ${String(subject)})`, FRAMING_ERROR_CODES.BAD_SUBJECT);
    return { pos: [subject[0], subject[1], subject[2]], height: DEFAULT_SUBJECT_HEIGHT, radius: 0.25 * DEFAULT_SUBJECT_HEIGHT };
  }
  if (!subject || typeof subject !== "object") {
    throw err(`subject must be an object {pos, height, radius} or [x,y,z] (got ${String(subject)})`, FRAMING_ERROR_CODES.BAD_SUBJECT);
  }
  const centred = subject.pos === undefined && subject.position === undefined && subject.center !== undefined;
  const p = subject.pos !== undefined ? subject.pos : subject.position !== undefined ? subject.position : subject.center;
  if (!isFiniteV(p)) {
    throw err("subject.pos must be a finite [x,y,z] (AC world metres, the subject's base)", FRAMING_ERROR_CODES.BAD_SUBJECT);
  }
  const size = (name) => {
    const v = subject[name];
    if (v === undefined || v === null) return undefined;
    if (!(typeof v === "number" && Number.isFinite(v) && v >= 0)) {
      throw err(`subject.${name} must be a finite number ≥ 0 (got ${String(v)})`, FRAMING_ERROR_CODES.BAD_SUBJECT);
    }
    return v > 0 ? v : undefined;
  };
  let radius = size("radius");
  let height = size("height");
  let base;
  if (centred) {
    if (radius === undefined) radius = 0.5;
    if (height === undefined) height = 2 * radius;
    base = [p[0], p[1], p[2] - height / 2];
  } else {
    if (height === undefined) height = radius !== undefined ? 2 * radius : DEFAULT_SUBJECT_HEIGHT;
    if (radius === undefined) radius = 0.25 * height;
    base = [p[0], p[1], p[2]];
  }
  const out = { ...subject, pos: base, height, radius };
  delete out.center;
  delete out.position;
  return out;
}

/**
 * The point a camera should aim at for `framing`: the subject's eye line
 * (0.9·H above the base) for MS and tighter, its centre (0.5·H) for FS and
 * wider, interpolated in between (see aimHeightFraction).
 * @param {string|number} framing
 * @param {*} subject anything normalizeSubject accepts
 * @returns {number[]} `[x, y, z]`
 */
export function aimPointForFraming(framing, subject) {
  const s = normalizeSubject(subject);
  const f = aimHeightFraction(framing);
  return [s.pos[0], s.pos[1], s.pos[2] + f * s.height];
}

// ---------------------------------------------------------------------------
// composition helpers
// ---------------------------------------------------------------------------

/** Resolve a horizontal screen placement to an NDC x. */
function screenX(side) {
  if (typeof side === "number" && Number.isFinite(side)) return Math.max(-1, Math.min(1, side));
  if (side === "left") return -1 / 3;
  if (side === "right") return 1 / 3;
  if (side === undefined || side === null || side === "center" || side === "centre") return 0;
  throw err(`screen side must be "left" | "center" | "right" or an NDC number (got ${String(side)})`, FRAMING_ERROR_CODES.BAD_ARGUMENT);
}

/** Resolve a vertical screen placement to an NDC y. */
function screenY(vertical) {
  if (typeof vertical === "number" && Number.isFinite(vertical)) return Math.max(-1, Math.min(1, vertical));
  if (vertical === "upper" || vertical === "top") return 1 / 3;
  if (vertical === "lower" || vertical === "bottom") return -1 / 3;
  if (vertical === undefined || vertical === null || vertical === "center" || vertical === "centre") return 0;
  throw err(`screen vertical must be "upper" | "center" | "lower" or an NDC number (got ${String(vertical)})`, FRAMING_ERROR_CODES.BAD_ARGUMENT);
}

/**
 * Gimbal offsets to ADD to a camera that looks straight at the subject so the
 * subject lands on a thirds line instead of the centre.
 * `side` is where the SUBJECT should appear ('left' → NDC x −1/3, 'right' →
 * +1/3, 'center', or an NDC number); `vertical` likewise ('upper' → +1/3,
 * 'lower' → −1/3, 'center', or a number). Exact at pitch 0 for each axis
 * (dh = −atan(x·aspect·tan(fov/2)), dp = −atan(y·tan(fov/2))); a close
 * approximation elsewhere.
 * @param {{side?:string|number, vertical?:string|number}} placement
 * @param {number} fovDeg vertical fov in degrees
 * @param {number} aspect width / height
 * @returns {{dh:number, dp:number}} radians
 */
export function thirdsAimOffset(placement, fovDeg, aspect) {
  const o = placement || {};
  const sx = screenX(o.side);
  const sy = screenY(o.vertical);
  const ty = Math.tan((resolveFov(fovDeg) * DEG) / 2);
  const tx = ty * resolveAspect(aspect);
  return { dh: -Math.atan(sx * tx), dp: -Math.atan(sy * ty) };
}

/**
 * Lead room: which side of the frame a moving subject should sit on so there
 * is space in the direction it travels. A subject moving to screen-right is
 * framed on the 'left' (and vice versa); 'center' when the lateral speed is
 * below `minSpeed` or the camera looks straight up/down (no horizontal right
 * vector — pass `opts.right` to override).
 * @param {number[]} velocity subject velocity, m/s (world)
 * @param {number[]} camForward camera forward (world)
 * @param {{minSpeed?:number, right?:number[]}} [opts] minSpeed default 0.2 m/s
 * @returns {'left'|'right'|'center'}
 */
export function leadRoomSide(velocity, camForward, opts = {}) {
  const o = opts || {};
  if (!isFiniteV(velocity)) return "center";
  let rx, ry, rz;
  if (isFiniteV(o.right)) {
    rx = o.right[0]; ry = o.right[1]; rz = o.right[2];
  } else {
    if (!isFiniteV(camForward)) return "center";
    rx = camForward[1]; ry = -camForward[0]; rz = 0; // forward × up(z)
  }
  const l = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (!(l > 1e-6)) return "center";
  const lateral = (velocity[0] * rx + velocity[1] * ry + velocity[2] * rz) / l;
  const minSpeed = Number.isFinite(o.minSpeed) && o.minSpeed >= 0 ? o.minSpeed : 0.2;
  if (!(Math.abs(lateral) > minSpeed)) return "center";
  return lateral > 0 ? "left" : "right";
}

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

/** Camera-space coordinates of a world point: {x right, y up, z depth}. */
function toView(B, eye, point) {
  const d = sub(point, eye);
  return [dot(d, B.right), dot(d, B.up), dot(d, B.forward)];
}

/**
 * Project a world point through a pose's perspective camera.
 * Identical to three.js `Vector3.project(PerspectiveCamera)` x/y for the same
 * camera (position acToThreePos(pos), quaternion acQuatToThree(q), fov,
 * aspect): x = xc/(depth·aspect·tan(fov/2)), y = yc/(depth·tan(fov/2)) —
 * including three's mirrored values for points BEHIND the camera
 * (`inFront` false). Values are clamped to ±1e6 (a point on the camera plane
 * gives ±1e6, never Infinity/NaN). A pose without a valid position or a
 * non-finite point returns `{x:0, y:0, depth:0, inFront:false, onScreen:false}`.
 * @param {{pos:number[], q?:number[], h?:number, p?:number, r?:number, fov?:number}} pose
 * @param {number[]} point world `[x, y, z]`
 * @param {number} [fovDeg] vertical fov (defaults to pose.fov, then 60)
 * @param {number} [aspect] width / height (default 16/9)
 * @returns {NdcPoint}
 */
export function projectToNdc(pose, point, fovDeg, aspect) {
  if (!pose || !isFiniteV(pose.pos) || !isFiniteV(point)) {
    return { x: 0, y: 0, depth: 0, inFront: false, onScreen: false };
  }
  const fov = resolveFov(fovDeg, pose.fov);
  const ty = Math.tan((fov * DEG) / 2);
  const tx = ty * resolveAspect(aspect);
  const B = qToBasis(poseQuat(pose));
  const [xc, yc, depth] = toView(B, pose.pos, point);
  const w = Math.abs(depth) > 1e-300 ? depth : -1e-300;
  const x = clampNdc(xc / (w * tx));
  const y = clampNdc(yc / (w * ty));
  const inFront = depth > 0;
  return { x, y, depth, inFront, onScreen: inFront && Math.abs(x) <= 1 && Math.abs(y) <= 1 };
}

/** Screen NDC of a view-space angle (radians from the optical axis) along one axis. */
function angleToNdc(a, t) {
  if (a <= -HALF_PI) return -NDC_LIMIT;
  if (a >= HALF_PI) return NDC_LIMIT;
  return clampNdc(Math.tan(a) / t);
}

/** Exact projected [lo, hi] of a sphere along one screen axis (c lateral, z depth). */
function sphereAxisBounds(c, z, R, t) {
  const d2 = c * c + z * z;
  if (!(d2 > R * R)) return [-NDC_LIMIT, NDC_LIMIT];
  const th = Math.atan2(c, z);
  const ph = Math.asin(Math.min(1, R / Math.sqrt(d2)));
  return [angleToNdc(th - ph, t), angleToNdc(th + ph, t)];
}

/** Exact NDC bounding box of a view-space sphere, or null when it is entirely behind the camera plane. */
function sphereRectView(v, R, tx, ty) {
  if (v[2] + R <= 0) return null;
  const [x0, x1] = sphereAxisBounds(v[0], v[2], R, tx);
  const [y0, y1] = sphereAxisBounds(v[1], v[2], R, ty);
  return { x0, y0, x1, y1 };
}

/**
 * Screen-space bounding box (NDC) of a subject's volume.
 *
 * A plain sphere `{center|pos, radius}` (no `height`) is projected exactly
 * (tangent-plane bounds per axis — the true perspective extent, not a
 * small-angle estimate). A subject with a `height` is treated as a capsule
 * from its base to base + height of its radius (union of exact sphere bounds
 * along the axis). Parts behind the camera push the box to ±1e6; a camera
 * inside the volume yields the full ±1e6 box. `heightFrac` = (y1 − y0)/2 is
 * the box height as a fraction of the frame height (unclamped, may exceed 1);
 * `visible` = some part is in front and overlaps the frame.
 * @param {{pos:number[], q?:number[], fov?:number}} pose
 * @param {{center?:number[], pos?:number[], radius?:number, height?:number}} sphere
 * @param {number} [fovDeg] @param {number} [aspect]
 * @returns {{x0:number, y0:number, x1:number, y1:number, heightFrac:number, widthFrac:number, visible:boolean}}
 */
export function subjectScreenRect(pose, sphere, fovDeg, aspect) {
  const none = { x0: 0, y0: 0, x1: 0, y1: 0, heightFrac: 0, widthFrac: 0, visible: false };
  if (!pose || !isFiniteV(pose.pos) || !sphere || typeof sphere !== "object") return none;
  const fov = resolveFov(fovDeg, pose.fov);
  const asp = resolveAspect(aspect);
  const ty = Math.tan((fov * DEG) / 2);
  const tx = ty * asp;
  const B = qToBasis(poseQuat(pose));
  /** @type {{c:number[], R:number}[]} */
  const spheres = [];
  if (sphere.height !== undefined && sphere.height !== null) {
    const s = normalizeSubject(sphere);
    const r = Math.max(1e-3, Math.min(s.radius, s.height / 2));
    const a = s.pos[2] + r;
    const b = s.pos[2] + s.height - r;
    const n = Math.max(1, Math.ceil((b - a) / (0.5 * r)));
    for (let i = 0; i <= n; i++) spheres.push({ c: [s.pos[0], s.pos[1], a + ((b - a) * i) / n], R: r });
  } else {
    const c = sphere.center !== undefined ? sphere.center : sphere.pos;
    if (!isFiniteV(c)) return none;
    const R = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 0;
    spheres.push({ c: [c[0], c[1], c[2]], R });
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let any = false;
  for (const sp of spheres) {
    const v = toView(B, pose.pos, sp.c);
    let rect;
    if (sp.R > 0) {
      rect = sphereRectView(v, sp.R, tx, ty);
    } else if (v[2] > 0) {
      const px = clampNdc(v[0] / (v[2] * tx)), py = clampNdc(v[1] / (v[2] * ty));
      rect = { x0: px, y0: py, x1: px, y1: py };
    } else {
      rect = null;
    }
    if (!rect) continue;
    any = true;
    if (rect.x0 < x0) x0 = rect.x0;
    if (rect.y0 < y0) y0 = rect.y0;
    if (rect.x1 > x1) x1 = rect.x1;
    if (rect.y1 > y1) y1 = rect.y1;
  }
  if (!any) return none;
  const visible = x0 <= 1 && x1 >= -1 && y0 <= 1 && y1 >= -1;
  return { x0, y0, x1, y1, heightFrac: (y1 - y0) / 2, widthFrac: (x1 - x0) / 2, visible };
}

/** Resolve a composition target (intent.thirds) to NDC targets: an array of candidate points. */
function compositionTargets(thirds) {
  if (thirds === undefined || thirds === null || thirds === "auto") {
    return [[-1 / 3, 1 / 3], [1 / 3, 1 / 3], [-1 / 3, -1 / 3], [1 / 3, -1 / 3]];
  }
  if (thirds === "center" || thirds === "centre") return [[0, 0]];
  if (typeof thirds === "object") return [[screenX(thirds.side), screenY(thirds.vertical)]];
  throw err(`intent.thirds must be "auto" | "center" | {side, vertical} (got ${String(thirds)})`, FRAMING_ERROR_CODES.BAD_ARGUMENT);
}

/**
 * Length of a view-space segment's projection, in units of frame height
 * (clipped to depth ≥ FRAMING_NEAR; 0 when entirely clipped).
 */
function projectedSegmentFrac(a, b, tx, ty, aspect) {
  let p = a, q = b;
  const n = FRAMING_NEAR;
  if (p[2] < n && q[2] < n) return 0;
  if (p[2] < n || q[2] < n) {
    const s = (n - p[2]) / (q[2] - p[2]);
    const c = [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, n];
    if (p[2] < n) p = c; else q = c;
  }
  const dx = (p[0] / (p[2] * tx) - q[0] / (q[2] * tx)) * aspect;
  const dy = p[1] / (p[2] * ty) - q[1] / (q[2] * ty);
  return Math.sqrt(dx * dx + dy * dy) / 2;
}

/**
 * Composition measurements of a subject in a pose (scouting, solver scoring,
 * pilot sensing, technique tests).
 *
 * - `ndc` — NDC of the framing's aim point (aimPointForFraming), null when behind;
 * - `heightFrac` — apparent subject size in frame heights (unclamped): the
 *   projected length of its base→top axis, or its projected diameter when that
 *   is larger (e.g. seen from straight above); 0 when behind;
 * - `sizeRatio` — heightFrac · k (1 = exactly the intended framing, >1 too large);
 * - `thirdsError` — NDC distance from the aim point to the composition target
 *   (`intent.thirds`: "auto" = nearest thirds power point (default), "center",
 *   or `{side, vertical}` as in thirdsAimOffset); null when behind;
 * - `headroom` — frame-height fraction between the subject's top and the frame
 *   top (negative = head cut off); null when the top is behind the camera;
 * - `horizonTiltDeg` — apparent horizon tilt (= roll for an upright camera;
 *   0 looking straight up/down; ±180 inverted);
 * - `inFrame` — aim point in front with |x| ≤ 1 and |y| ≤ 1.
 * Extra fields: `inFront`, `depth` (aim point, metres along forward),
 * `distance` (eye→aim, metres), `centerError` (|ndc|), `framing` (k).
 * @param {{pos:number[], q?:number[], h?:number, p?:number, r?:number, fov?:number}} pose
 * @param {*} subject anything normalizeSubject accepts
 * @param {number} [fovDeg] default pose.fov
 * @param {number} [aspect] default 16/9
 * @param {{framing?:string|number, thirds?:string|{side?:string|number, vertical?:string|number}}} [intent]
 *   framing default 'MS'
 * @returns {{ndc:number[]|null, heightFrac:number, sizeRatio:number, thirdsError:number|null,
 *   headroom:number|null, horizonTiltDeg:number, inFrame:boolean, inFront:boolean, depth:number,
 *   distance:number, centerError:number|null, framing:number}}
 */
export function compositionMetrics(pose, subject, fovDeg, aspect, intent = {}) {
  const it = intent || {};
  const s = normalizeSubject(subject);
  const framing = it.framing === undefined || it.framing === null ? "MS" : it.framing;
  const k = framingFactor(framing);
  const targets = compositionTargets(it.thirds);
  if (!pose || !isFiniteV(pose.pos)) {
    throw err("compositionMetrics: pose.pos must be a finite [x,y,z]", FRAMING_ERROR_CODES.BAD_ARGUMENT);
  }
  const fov = resolveFov(fovDeg, pose.fov);
  const asp = resolveAspect(aspect);
  const ty = Math.tan((fov * DEG) / 2);
  const tx = ty * asp;
  const B = qToBasis(poseQuat(pose));

  const aim = aimPointForFraming(framing, s);
  const P = projectToNdc(pose, aim, fov, asp);
  const ndc = P.inFront ? [P.x, P.y] : null;
  const inFrame = P.onScreen;

  const base = toView(B, pose.pos, s.pos);
  const top = toView(B, pose.pos, [s.pos[0], s.pos[1], s.pos[2] + s.height]);
  const mid = toView(B, pose.pos, [s.pos[0], s.pos[1], s.pos[2] + s.height / 2]);
  const axisFrac = projectedSegmentFrac(base, top, tx, ty, asp);
  const diamFrac = mid[2] > 0 ? s.radius / (Math.max(mid[2], FRAMING_NEAR) * ty) : 0;
  const heightFrac = Math.max(axisFrac, diamFrac);

  let thirdsError = null;
  let centerError = null;
  if (ndc) {
    thirdsError = Infinity;
    for (const [qx, qy] of targets) {
      const e = Math.hypot(ndc[0] - qx, ndc[1] - qy);
      if (e < thirdsError) thirdsError = e;
    }
    centerError = Math.hypot(ndc[0], ndc[1]);
  }

  const headroom = top[2] > 0 ? (1 - clampNdc(top[1] / (top[2] * ty))) / 2 : null;

  const rz = B.right[2], uz = B.up[2];
  const horizonTiltDeg = Math.abs(rz) < 1e-12 && Math.abs(uz) < 1e-12 ? 0 : Math.atan2(-rz, uz) / DEG;

  return {
    ndc,
    heightFrac,
    sizeRatio: heightFrac * k,
    thirdsError,
    headroom,
    horizonTiltDeg,
    inFrame,
    inFront: P.inFront,
    depth: P.depth,
    distance: dist(pose.pos, aim),
    centerError,
    framing: k,
  };
}
