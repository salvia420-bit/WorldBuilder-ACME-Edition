// scene3d/film/core/vec3.js — 3-vector helpers for AC Film Mode (SPEC §2.1).
//
// WHY: every film module (shots, drone, pilot, solver, runtime) does its
// geometry in AC world metres (x east, y north, z up) on plain `[x, y, z]`
// arrays. One tiny, allocation-explicit, NaN-safe helper set keeps that math
// identical in the page and in Node tools/tests.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm. Every function returns a NEW array (inputs are never mutated).

/**
 * Build a vector. Missing (undefined) components default to 0.
 * @param {number} [x=0] @param {number} [y=0] @param {number} [z=0]
 * @returns {number[]} `[x, y, z]`
 */
export function v3(x = 0, y = 0, z = 0) {
  return [x, y, z];
}

/** @param {number[]} a @param {number[]} b @returns {number[]} a + b */
export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** @param {number[]} a @param {number[]} b @returns {number[]} a − b */
export function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** @param {number[]} a @param {number} s @returns {number[]} a·s */
export function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** @param {number[]} a @param {number[]} b @param {number} s @returns {number[]} a + b·s */
export function addScaled(a, b, s) {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

/** @param {number[]} a @returns {number[]} −a */
export function neg(a) {
  return [-a[0], -a[1], -a[2]];
}

/** @param {number[]} a @param {number[]} b @returns {number} a·b */
export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Right-handed cross product. @param {number[]} a @param {number[]} b @returns {number[]} a × b */
export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** @param {number[]} a @returns {number} |a|² */
export function lenSq(a) {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

/** @param {number[]} a @returns {number} |a| */
export function len(a) {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

/** @param {number[]} a @param {number[]} b @returns {number} |a − b|² */
export function distSq(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/** @param {number[]} a @param {number[]} b @returns {number} |a − b| */
export function dist(a, b) {
  return Math.sqrt(distSq(a, b));
}

/**
 * Unit vector along `a`. A zero-length or non-finite input returns `[0, 0, 0]`
 * (never NaN) — callers test `lenSq(result) > 0` when they need a direction.
 * @param {number[]} a
 * @returns {number[]}
 */
export function norm(a) {
  const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  if (!(l > 0) || !Number.isFinite(l)) return [0, 0, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Linear interpolation (t is not clamped). @param {number[]} a @param {number[]} b @param {number} t @returns {number[]} */
export function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Copy of `a` shortened to length `max` when longer (direction kept).
 * `max <= 0` (or NaN) returns `[0, 0, 0]`; `max = Infinity` returns a copy.
 * @param {number[]} a @param {number} max
 * @returns {number[]}
 */
export function clampLen(a, max) {
  if (!(max > 0)) return [0, 0, 0];
  const l = len(a);
  if (!(l > max)) return [a[0], a[1], a[2]];
  const s = max / l;
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** Horizontal (ground-plane) part. @param {number[]} a @returns {number[]} `[x, y, 0]` */
export function horiz(a) {
  return [a[0], a[1], 0];
}

/**
 * Unsigned angle between two vectors in radians, [0, π]. Uses atan2(|a×b|, a·b),
 * which stays accurate near 0 and π. A zero-length operand returns 0.
 * @param {number[]} a @param {number[]} b
 * @returns {number}
 */
export function angleBetween(a, b) {
  const c = cross(a, b);
  const s = len(c);
  const d = dot(a, b);
  if (!(s > 0) && d === 0) return 0;
  const ang = Math.atan2(s, d);
  return Number.isFinite(ang) ? ang : 0;
}

/**
 * Remove the component of `a` along `n` (n need not be unit). A zero `n` returns a copy of `a`.
 * @param {number[]} a @param {number[]} n
 * @returns {number[]}
 */
export function projectOnPlane(a, n) {
  const nn = lenSq(n);
  if (!(nn > 0) || !Number.isFinite(nn)) return [a[0], a[1], a[2]];
  const k = dot(a, n) / nn;
  return [a[0] - n[0] * k, a[1] - n[1] * k, a[2] - n[2] * k];
}

/**
 * Rotate counter-clockwise about +z (seen from above) by `ang` radians.
 * NOTE: compass headings are CLOCKWISE; rotating a heading-h direction to
 * heading h+δ is `rotateZ(v, −δ)`.
 * @param {number[]} a @param {number} ang
 * @returns {number[]}
 */
export function rotateZ(a, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c, a[2]];
}

/**
 * Component-wise |a_i − b_i| ≤ eps. Any NaN component compares unequal.
 * @param {number[]} a @param {number[]} b @param {number} [eps=1e-9]
 * @returns {boolean}
 */
export function equalsApprox(a, b, eps = 1e-9) {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;
}

/**
 * True when `a` is an array-like with three finite numeric components.
 * @param {*} a
 * @returns {boolean}
 */
export function isFiniteV(a) {
  return a != null && typeof a === "object" &&
    Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
}
