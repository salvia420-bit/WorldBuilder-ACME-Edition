// scene3d/film/core/quat.js — quaternions for AC Film Mode (SPEC §1, §2.2).
//
// WHY: film cameras must never derive orientation from `lookAt` + a fixed up
// vector (three r184 snaps north-up at ±90° pitch → image flips). Every film
// orientation is a unit quaternion in the AC frame (x east, y north, z up),
// `[w, x, y, z]`, mapping the identity camera basis (right +x, forward +y,
// up +z) to the actual basis. Interpolation is slerp / squad (C¹), and the
// hand-off to three.js is an exact frame conjugation (qToThree).
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm. Every function returns a NEW array; inputs are never mutated.

import { cross, dot, lenSq, norm } from "./vec3.js";

/** Below this |dot| gap slerp degrades to normalised lerp (numerically safer, visually identical). */
const SLERP_NLERP_DOT = 0.9995;

/**
 * Identity rotation (a function so callers always get a fresh array).
 * @returns {number[]} `[1, 0, 0, 0]`
 */
export function qIdentity() {
  return [1, 0, 0, 0];
}

/**
 * Hamilton product a ⊗ b (apply b first, then a, when rotating vectors).
 * @param {number[]} a `[w,x,y,z]` @param {number[]} b `[w,x,y,z]`
 * @returns {number[]}
 */
export function qMul(a, b) {
  const aw = a[0], ax = a[1], ay = a[2], az = a[3];
  const bw = b[0], bx = b[1], by = b[2], bz = b[3];
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

/** Conjugate (the inverse of a unit quaternion). @param {number[]} q @returns {number[]} */
export function qConj(q) {
  return [q[0], -q[1], -q[2], -q[3]];
}

/** 4-D dot product. @param {number[]} a @param {number[]} b @returns {number} */
export function qDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/**
 * Unit-length copy. A zero-length or non-finite quaternion returns the identity (never NaN).
 * @param {number[]} q
 * @returns {number[]}
 */
export function qNorm(q) {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (!(l > 0) || !Number.isFinite(l)) return [1, 0, 0, 0];
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/**
 * Right-handed rotation of `ang` radians about `axis` (need not be unit).
 * A zero axis or non-finite angle returns the identity.
 * @param {number[]} axis @param {number} ang
 * @returns {number[]}
 */
export function qFromAxisAngle(axis, ang) {
  const n = norm(axis);
  if (lenSq(n) === 0 || !Number.isFinite(ang)) return [1, 0, 0, 0];
  const h = ang * 0.5;
  const s = Math.sin(h);
  return [Math.cos(h), n[0] * s, n[1] * s, n[2] * s];
}

/**
 * Rotate vector `v` by quaternion `q` (q is re-normalised if needed).
 * @param {number[]} q `[w,x,y,z]` @param {number[]} v `[x,y,z]`
 * @returns {number[]}
 */
export function qRotate(q, v) {
  let w = q[0], x = q[1], y = q[2], z = q[3];
  const n = w * w + x * x + y * y + z * z;
  if (Math.abs(n - 1) > 1e-12) {
    const l = Math.sqrt(n);
    if (!(l > 0) || !Number.isFinite(l)) return [v[0], v[1], v[2]];
    w /= l; x /= l; y /= l; z /= l;
  }
  // v' = v + w·t + q_v × t, with t = 2·(q_v × v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/**
 * Normalised linear interpolation along the shortest arc (t not clamped; non-finite t → 0).
 * @param {number[]} a @param {number[]} b @param {number} t
 * @returns {number[]}
 */
export function qNlerp(a, b, t) {
  const tt = Number.isFinite(t) ? t : 0;
  const A = qNorm(a);
  let B = qNorm(b);
  if (qDot(A, B) < 0) B = [-B[0], -B[1], -B[2], -B[3]];
  return qNorm([
    A[0] + (B[0] - A[0]) * tt,
    A[1] + (B[1] - A[1]) * tt,
    A[2] + (B[2] - A[2]) * tt,
    A[3] + (B[3] - A[3]) * tt,
  ]);
}

/**
 * Spherical linear interpolation along the SHORTEST arc (b is negated when
 * dot < 0); falls back to nlerp when the inputs are nearly parallel.
 * t is not clamped (extrapolation is allowed); non-finite t → 0.
 * @param {number[]} a @param {number[]} b @param {number} t
 * @returns {number[]}
 */
export function qSlerp(a, b, t) {
  const tt = Number.isFinite(t) ? t : 0;
  const A = qNorm(a);
  let B = qNorm(b);
  let d = qDot(A, B);
  if (d < 0) {
    d = -d;
    B = [-B[0], -B[1], -B[2], -B[3]];
  }
  if (d > SLERP_NLERP_DOT) return qNlerp(A, B, tt);
  const theta = Math.acos(Math.min(1, d));
  const s = Math.sin(theta);
  const wa = Math.sin((1 - tt) * theta) / s;
  const wb = Math.sin(tt * theta) / s;
  return qNorm([A[0] * wa + B[0] * wb, A[1] * wa + B[1] * wb, A[2] * wa + B[2] * wb, A[3] * wa + B[3] * wb]);
}

/**
 * Slerp WITHOUT the hemisphere flip (squad needs the raw great-circle path to stay C¹).
 * @param {number[]} A unit @param {number[]} B unit @param {number} t
 * @returns {number[]}
 */
function slerpNoFlip(A, B, t) {
  const d = Math.max(-1, Math.min(1, qDot(A, B)));
  if (d > SLERP_NLERP_DOT) {
    return qNorm([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t, A[3] + (B[3] - A[3]) * t]);
  }
  const theta = Math.acos(d);
  const s = Math.sin(theta);
  if (!(s > 1e-9)) return qSlerp(A, B, t); // exactly antipodal: same rotation, take the short path
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return qNorm([A[0] * wa + B[0] * wb, A[1] * wa + B[1] * wb, A[2] * wa + B[2] * wb, A[3] * wa + B[3] * wb]);
}

/**
 * Rotation angle between two orientations in radians, [0, π] (sign-invariant: q ≡ −q).
 * @param {number[]} a @param {number[]} b
 * @returns {number}
 */
export function qAngle(a, b) {
  const r = qMul(qConj(qNorm(a)), qNorm(b));
  const s = Math.sqrt(r[1] * r[1] + r[2] * r[2] + r[3] * r[3]);
  return 2 * Math.atan2(s, Math.abs(r[0]));
}

/**
 * `q` or `−q` (same rotation), whichever lies in `prev`'s hemisphere — keeps a
 * quaternion stream sign-continuous for interpolation and table baking.
 * @param {number[]} prev @param {number[]} q
 * @returns {number[]}
 */
export function qEnsureContinuity(prev, q) {
  return qDot(prev, q) < 0 ? [-q[0], -q[1], -q[2], -q[3]] : [q[0], q[1], q[2], q[3]];
}

/**
 * Logarithm of a unit quaternion: the rotation vector HALF-angle form
 * (axis·θ/2). Inverse of qExp.
 * @param {number[]} q
 * @returns {number[]} `[x, y, z]`
 */
export function qLog(q) {
  const u = qNorm(q);
  const s = Math.sqrt(u[1] * u[1] + u[2] * u[2] + u[3] * u[3]);
  if (!(s > 1e-12)) return [u[1], u[2], u[3]];
  const k = Math.atan2(s, u[0]) / s;
  return [u[1] * k, u[2] * k, u[3] * k];
}

/**
 * Exponential of a pure quaternion given as a half-angle rotation vector. Inverse of qLog.
 * @param {number[]} v `[x, y, z]`
 * @returns {number[]} unit `[w, x, y, z]`
 */
export function qExp(v) {
  const th = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (!Number.isFinite(th)) return [1, 0, 0, 0];
  if (th < 1e-12) return qNorm([1, v[0], v[1], v[2]]);
  const k = Math.sin(th) / th;
  return [Math.cos(th), v[0] * k, v[1] * k, v[2] * k];
}

/**
 * Shortest-arc rotation taking direction `a` to direction `b` (parallel
 * transport of camera frames along curved paths). Antiparallel inputs rotate
 * π about a deterministic perpendicular axis; a zero input returns the identity.
 * @param {number[]} a @param {number[]} b
 * @returns {number[]}
 */
export function qFromTo(a, b) {
  const A = norm(a), B = norm(b);
  if (lenSq(A) === 0 || lenSq(B) === 0) return [1, 0, 0, 0];
  const d = dot(A, B);
  if (d < -1 + 1e-12) {
    let axis = cross(A, [1, 0, 0]);
    if (lenSq(axis) < 1e-12) axis = cross(A, [0, 1, 0]);
    axis = norm(axis);
    return [0, axis[0], axis[1], axis[2]];
  }
  const c = cross(A, B);
  return qNorm([1 + d, c[0], c[1], c[2]]);
}

/**
 * Quaternion whose rotation maps the identity camera basis (+x, +y, +z) to
 * `{right, forward, up}`. Inputs are orthonormalised first, trusting forward,
 * then up, then right (so slightly skewed bases are fine). Canonical w ≥ 0.
 * @param {number[]} right @param {number[]} forward @param {number[]} up
 * @returns {number[]}
 */
export function qFromBasis(right, forward, up) {
  const R0 = right ? norm(right) : [0, 0, 0];
  const U0 = up ? norm(up) : [0, 0, 0];
  let f = forward ? norm(forward) : [0, 0, 0];
  if (lenSq(f) === 0) {
    f = norm(cross(U0, R0)); // forward = up × right
    if (lenSq(f) === 0) f = [0, 1, 0];
  }
  let u = [U0[0] - f[0] * dot(f, U0), U0[1] - f[1] * dot(f, U0), U0[2] - f[2] * dot(f, U0)];
  if (lenSq(u) < 1e-18) {
    u = cross(R0, f); // up = right × forward
    u = [u[0] - f[0] * dot(f, u), u[1] - f[1] * dot(f, u), u[2] - f[2] * dot(f, u)];
    if (lenSq(u) < 1e-18) {
      u = cross(f, Math.abs(f[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
      u = cross(u, f);
    }
  }
  u = norm(u);
  const r = cross(f, u); // right = forward × up
  // Rotation matrix columns: [r, f, u]; m_ij = row i, column j.
  const m00 = r[0], m01 = f[0], m02 = u[0];
  const m10 = r[1], m11 = f[1], m12 = u[1];
  const m20 = r[2], m21 = f[2], m22 = u[2];
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const q = qNorm([w, x, y, z]);
  return q[0] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

/**
 * Camera basis of an orientation: the images of +x (right), +y (forward), +z (up).
 * @param {number[]} q
 * @returns {{right:number[], forward:number[], up:number[]}}
 */
export function qToBasis(q) {
  const [w, x, y, z] = qNorm(q);
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return {
    right: [1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy)],
    forward: [2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx)],
    up: [2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy)],
  };
}

/**
 * Squad inner control point s_i = q_i·exp(−(log(q_i⁻¹q_{i+1}) + log(q_i⁻¹q_{i−1}))/4).
 * @param {number[]} qPrev @param {number[]} q @param {number[]} qNext (unit, hemisphere-continuous)
 * @returns {number[]}
 */
function squadInner(qPrev, q, qNext) {
  const inv = qConj(q);
  const l1 = qLog(qMul(inv, qNext));
  const l0 = qLog(qMul(inv, qPrev));
  return qNorm(qMul(q, qExp([-(l1[0] + l0[0]) / 4, -(l1[1] + l0[1]) / 4, -(l1[2] + l0[2]) / 4])));
}

/**
 * C¹ quaternion spline through keys (Shoemake squad), u ∈ [0, 1] spread
 * UNIFORMLY over the n−1 segments (key i sits at u = i/(n−1)). Keys are
 * normalised and made hemisphere-continuous first. 0 keys → identity,
 * 1 key → that key, 2 keys → slerp. u is clamped; non-finite u → 0.
 * @param {number[][]} qs keys `[w,x,y,z]`
 * @param {number} u
 * @returns {number[]}
 */
export function qSpline(qs, u) {
  const n = Array.isArray(qs) ? qs.length : 0;
  if (n === 0) return [1, 0, 0, 0];
  const keys = new Array(n);
  keys[0] = qNorm(qs[0]);
  for (let i = 1; i < n; i++) keys[i] = qEnsureContinuity(keys[i - 1], qNorm(qs[i]));
  if (n === 1) return keys[0].slice();
  const uu = Number.isFinite(u) ? Math.min(1, Math.max(0, u)) : 0;
  if (n === 2) return slerpNoFlip(keys[0], keys[1], uu);
  const segs = n - 1;
  const x = uu * segs;
  const i = Math.min(Math.floor(x), segs - 1);
  const t = x - i;
  const q1 = keys[i], q2 = keys[i + 1];
  const s1 = squadInner(i > 0 ? keys[i - 1] : q1, q1, q2);
  const s2 = squadInner(q1, q2, i + 2 < n ? keys[i + 2] : q2);
  return slerpNoFlip(slerpNoFlip(q1, q2, t), slerpNoFlip(s1, s2, t), 2 * t * (1 - t));
}

/**
 * AC-frame quaternion → three.js world quaternion in three's `[x, y, z, w]`
 * order (SPEC §1): q_three = qM ⊗ q_ac ⊗ qM⁻¹ with qM = Rx(−90°). Because the
 * conjugation just rotates the vector part by acToThree (x, y, z) → (x, z, −y),
 * this is computed exactly: `[x, z, −y, w]`. Identity ↔ identity.
 * @param {number[]} q AC `[w, x, y, z]`
 * @returns {number[]} three `[x, y, z, w]`
 */
export function qToThree(q) {
  const [w, x, y, z] = qNorm(q);
  return [x, z, -y, w];
}

/**
 * three.js world quaternion (`[x, y, z, w]` array or `{x, y, z, w}` object) → AC `[w, x, y, z]`. Inverse of qToThree.
 * @param {number[]|{x:number,y:number,z:number,w:number}} t
 * @returns {number[]}
 */
export function qFromThree(t) {
  const tx = Array.isArray(t) ? t[0] : t?.x;
  const ty = Array.isArray(t) ? t[1] : t?.y;
  const tz = Array.isArray(t) ? t[2] : t?.z;
  const tw = Array.isArray(t) ? t[3] : t?.w;
  return qNorm([tw, tx, -tz, ty]);
}
