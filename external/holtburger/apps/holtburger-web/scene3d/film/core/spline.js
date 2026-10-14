// scene3d/film/core/spline.js — camera paths for AC Film Mode (SPEC §2.4).
//
// WHY: every moving shot is "a smooth path + a speed profile". Control points
// come from the director, from techniques (orbits, flyovers) and from the
// dungeon router (doorway centres joined at 90° corridor turns). This module
// turns them into paths a camera can fly at constant, physically limited
// speed:
//   - centripetal Catmull-Rom (α = ½) — passes through every control point,
//     no cusps or self-intersections on uneven spacing (Yuksel et al.);
//   - an arc-length parameterisation (Gauss–Legendre LUT + Newton refinement),
//     so `at(s)` moves exactly s metres along the curve;
//   - polyline filleting, so a 90° corridor turn becomes a circular arc the
//     camera can round smoothly instead of a corner it must pivot on;
//   - a curvature-limited speed profile (v ≤ √(a_lat/κ), forward/backward
//     passes) — the camera slows into tight turns like a real dolly/drone.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks. Points are plain `[x, y, z]` arrays in AC world metres.
// Input policy: a non-array or a point that is not three finite numbers throws
// FilmError (BAD_ARGUMENT); empty inputs return empty results, except
// catmullRom/makePath, which need at least one point.

import { FilmError, FILM_ERROR_CODES } from "./errors.js";
import { addScaled, angleBetween, cross, dist, dot, len, norm, sub } from "./vec3.js";

/** Consecutive control points closer than this (metres) are treated as one point. */
const DEDUPE_EPS = 1e-9;
/** A Catmull-Rom segment shorter than this (metres) is evaluated as a constant point. */
const DEGENERATE_SEG = 1e-6;
/** Turning angles below this (radians) count as collinear in filletPolyline. */
const COLLINEAR_EPS = 1e-6;

// Gauss–Legendre nodes/weights on [−1, 1].
const GL5_X = [0, -0.5384693101056831, 0.5384693101056831, -0.906179845938664, 0.906179845938664];
const GL5_W = [0.5688888888888889, 0.47862867049936647, 0.47862867049936647, 0.23692688505618908, 0.23692688505618908];
const GL3_X = [0, -0.7745966692414834, 0.7745966692414834];
const GL3_W = [0.8888888888888888, 0.5555555555555556, 0.5555555555555556];

// ---------------------------------------------------------------------------
// Input hygiene
// ---------------------------------------------------------------------------

/**
 * Copy `points` as fresh `[x, y, z]` arrays, throwing a readable FilmError on
 * a non-array or a non-finite point.
 * @param {string} fn @param {*} points
 * @returns {number[][]}
 */
function cleanPoints(fn, points) {
  if (!Array.isArray(points)) {
    throw new FilmError(`${fn}: points must be an array of [x, y, z] (got ${points === null ? "null" : typeof points})`,
      FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p == null || typeof p !== "object" || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
      let shown;
      try { shown = JSON.stringify(p); } catch { shown = String(p); }
      throw new FilmError(`${fn}: point ${i} is not a finite [x, y, z] (got ${shown})`, FILM_ERROR_CODES.BAD_ARGUMENT);
    }
    out[i] = [p[0], p[1], p[2]];
  }
  return out;
}

/**
 * Indices of the points kept after dropping consecutive duplicates (and, when
 * closed, a last point equal to the first). The first of each run is kept.
 * @param {number[][]} P @param {boolean} closed
 * @returns {number[]}
 */
function dedupeIndices(P, closed) {
  const keep = [];
  for (let i = 0; i < P.length; i++) {
    if (keep.length === 0 || dist(P[keep[keep.length - 1]], P[i]) > DEDUPE_EPS) keep.push(i);
  }
  if (closed && keep.length > 1 && dist(P[keep[0]], P[keep[keep.length - 1]]) <= DEDUPE_EPS) keep.pop();
  return keep;
}

/**
 * Drop consecutive duplicates (and, when closed, a last point equal to the first).
 * @param {number[][]} P @param {boolean} closed
 * @returns {number[][]}
 */
function dedupe(P, closed) {
  return dedupeIndices(P, closed).map((i) => P[i]);
}

/** Clamp u to [0, 1]; non-finite → 0. */
function clampU(u) {
  return Number.isFinite(u) ? (u < 0 ? 0 : u > 1 ? 1 : u) : 0;
}

// ---------------------------------------------------------------------------
// Catmull-Rom
// ---------------------------------------------------------------------------

/**
 * Cubic coefficients of the Catmull-Rom segment p1→p2 in the stable
 * non-uniform tangent form (same as three.js CatmullRomCurve3):
 * h(s) = c0 + c1·s + c2·s² + c3·s³, s ∈ [0, 1]. Coefficients other than c0
 * are differences, so large AC world coordinates do not lose precision.
 *
 * `ta` / `tb` (unit directions or null) override the estimated end tangents:
 * the Hermite tangent becomes direction × chord × 2·tan(φ/4)/sin(φ/2), φ the
 * angle between ta and tb — the optimal cubic approximation of a circular arc
 * (handle 4r·tan(φ/4)), and an exact straight line when ta = tb = chord.
 * @returns {{c0:number[], c1:number[], c2:number[], c3:number[], degenerate:boolean}}
 */
function segmentCoeffs(p0, p1, p2, p3, alpha, ta, tb) {
  const D = sub(p2, p1);
  const chord = len(D);
  if (chord < DEGENERATE_SEG) {
    return { c0: p1.slice(), c1: [0, 0, 0], c2: [0, 0, 0], c3: [0, 0, 0], degenerate: true };
  }
  const knot = (a, b) => Math.pow(dist(a, b), alpha);
  let dt0 = knot(p0, p1), dt1 = knot(p1, p2), dt2 = knot(p2, p3);
  if (dt1 < 1e-4) dt1 = 1;
  if (dt0 < 1e-4) dt0 = dt1;
  if (dt2 < 1e-4) dt2 = dt1;
  let m1 = new Array(3), m2 = new Array(3);
  for (let k = 0; k < 3; k++) {
    const t1 = (p1[k] - p0[k]) / dt0 - (p2[k] - p0[k]) / (dt0 + dt1) + (p2[k] - p1[k]) / dt1;
    const t2 = (p2[k] - p1[k]) / dt1 - (p3[k] - p1[k]) / (dt1 + dt2) + (p3[k] - p2[k]) / dt2;
    m1[k] = t1 * dt1;
    m2[k] = t2 * dt1;
  }
  if (ta || tb) {
    let gain = 1;
    if (ta && tb) {
      const phi = angleBetween(ta, tb);
      if (phi > 1e-9) gain = (2 * Math.tan(phi / 4)) / Math.sin(phi / 2);
      if (!Number.isFinite(gain)) gain = 2;
    }
    if (ta) m1 = [ta[0] * gain * chord, ta[1] * gain * chord, ta[2] * gain * chord];
    if (tb) m2 = [tb[0] * gain * chord, tb[1] * gain * chord, tb[2] * gain * chord];
  }
  const c2 = new Array(3), c3 = new Array(3);
  for (let k = 0; k < 3; k++) {
    c2[k] = 3 * D[k] - 2 * m1[k] - m2[k];
    c3[k] = -2 * D[k] + m1[k] + m2[k];
  }
  return { c0: p1.slice(), c1: m1, c2, c3, degenerate: false };
}

/**
 * Resolve the optional per-point tangent directions: `opts.tangents` wins
 * (null disables), else the points array's own `tangents` property (attached,
 * non-enumerable, by filletPolyline). Entries are null/undefined (estimate
 * with Catmull-Rom) or finite non-zero vectors (normalised here).
 * @param {string} fn @param {*} points @param {object} o @param {number} n
 * @returns {(number[]|null)[]|null}
 */
function resolveTangents(fn, points, o, n) {
  const src = o.tangents !== undefined ? o.tangents : (Array.isArray(points) ? points.tangents : undefined);
  if (src === undefined || src === null) return null;
  if (!Array.isArray(src) || src.length !== n) {
    throw new FilmError(`${fn}: tangents must be an array with one entry per point (${n})`, FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  return src.map((t, i) => {
    if (t === null || t === undefined) return null;
    if (typeof t !== "object" || !Number.isFinite(t[0]) || !Number.isFinite(t[1]) || !Number.isFinite(t[2])) {
      throw new FilmError(`${fn}: tangent ${i} is not a finite [x, y, z] or null`, FILM_ERROR_CODES.BAD_ARGUMENT);
    }
    const u = norm(t);
    return u[0] === 0 && u[1] === 0 && u[2] === 0 ? null : u;
  });
}

/**
 * Catmull-Rom spline through `points` (centripetal for α = ½, uniform α = 0,
 * chordal α = 1). The curve passes through every control point; u ∈ [0, 1] is
 * spread UNIFORMLY over the segments (control point i sits at u = i/segments),
 * exactly like three.js CatmullRomCurve3.getPoint. Open curves extend the ends
 * with reflected phantom points (2p₀ − p₁); closed curves wrap (segments = n).
 * Zero-length segments (coincident consecutive points) hold still instead of
 * looping. u is clamped; non-finite u → 0.
 *
 * Optional `tangents` (one unit direction or null per point; default: the
 * points array's own non-enumerable `tangents`, which filletPolyline attaches)
 * replace the Catmull-Rom tangent estimate where given — arcs then stay
 * circular (curvature ≈ 1/r) and straight legs exactly straight, with no
 * curvature overshoot where a leg meets an arc. Pass `tangents: null` to
 * force the plain Catmull-Rom estimate.
 *
 * - `sample(u)` → `[x, y, z]`
 * - `tangent(u)` → UNIT tangent (falls back to the segment chord, then `[0, 1, 0]`)
 * - `derivative(u)` → dP/du, `secondDerivative(u)` → d²P/du²
 * - `segments` → number of cubic segments (0 for a single point)
 *
 * @param {number[][]} points at least one `[x, y, z]`
 * @param {{alpha?:number, closed?:boolean, tangents?:(number[]|null)[]|null}} [opts]
 *   alpha ∈ [0, 1] (default 0.5), closed default false
 * @returns {{sample:(u:number)=>number[], tangent:(u:number)=>number[], derivative:(u:number)=>number[],
 *   secondDerivative:(u:number)=>number[], segments:number, closed:boolean, alpha:number, points:number[][]}}
 */
export function catmullRom(points, opts = {}) {
  const o = opts || {};
  const alpha = Number.isFinite(o.alpha) ? Math.min(1, Math.max(0, o.alpha)) : 0.5;
  const P = cleanPoints("catmullRom", points);
  const n = P.length;
  if (n === 0) throw new FilmError("catmullRom: needs at least one control point", FILM_ERROR_CODES.BAD_ARGUMENT);
  const T = resolveTangents("catmullRom", points, o, n);
  const closed = !!o.closed && n >= 2;
  const segments = n === 1 ? 0 : closed ? n : n - 1;
  const C = new Array(segments);
  for (let i = 0; i < segments; i++) {
    const p1 = P[i];
    const p2 = P[(i + 1) % n];
    let p0, p3;
    if (closed) {
      p0 = P[(i - 1 + n) % n];
      p3 = P[(i + 2) % n];
    } else {
      p0 = i > 0 ? P[i - 1] : [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1], 2 * P[0][2] - P[1][2]];
      p3 = i + 2 < n ? P[i + 2]
        : [2 * P[n - 1][0] - P[n - 2][0], 2 * P[n - 1][1] - P[n - 2][1], 2 * P[n - 1][2] - P[n - 2][2]];
    }
    C[i] = segmentCoeffs(p0, p1, p2, p3, alpha, T ? T[i] : null, T ? T[(i + 1) % n] : null);
  }

  /** Segment of u: coefficients, index (undefined for a single point) and local s ∈ [0, 1]. @returns {{c:object|null, i?:number, s:number}} */
  function locate(u) {
    if (segments === 0) return { c: null, s: 0 };
    const x = clampU(u) * segments;
    const i = Math.min(Math.floor(x), segments - 1);
    return { c: C[i], i, s: x - i };
  }

  function sample(u) {
    const { c, s } = locate(u);
    if (!c) return P[0].slice();
    return [0, 1, 2].map((k) => c.c0[k] + s * (c.c1[k] + s * (c.c2[k] + s * c.c3[k])));
  }

  function derivative(u) {
    const { c, s } = locate(u);
    if (!c) return [0, 0, 0];
    return [0, 1, 2].map((k) => (c.c1[k] + s * (2 * c.c2[k] + 3 * s * c.c3[k])) * segments);
  }

  function secondDerivative(u) {
    const { c, s } = locate(u);
    if (!c) return [0, 0, 0];
    return [0, 1, 2].map((k) => (2 * c.c2[k] + 6 * s * c.c3[k]) * segments * segments);
  }

  function tangent(u) {
    const d = norm(derivative(u));
    if (d[0] !== 0 || d[1] !== 0 || d[2] !== 0) return d;
    const { i } = locate(u);
    if (i !== undefined) {
      const chord = norm(sub(P[(i + 1) % n], P[i]));
      if (chord[0] !== 0 || chord[1] !== 0 || chord[2] !== 0) return chord;
    }
    return [0, 1, 0];
  }

  return { sample, tangent, derivative, secondDerivative, segments, closed, alpha, points: P.map((p) => p.slice()) };
}

// ---------------------------------------------------------------------------
// Arc-length parameterised path
// ---------------------------------------------------------------------------

/**
 * Arc-length parameterised camera path through `points` (a Catmull-Rom
 * underneath; consecutive duplicate points are merged first).
 *
 * `length` metres; `at(s)` position s metres along the curve (s clamped to
 * [0, length], non-finite → 0) — accurate to ≪ 0.1% of ds between nearby
 * samples (Gauss–Legendre LUT of `samples` intervals + Newton refinement);
 * `tangentAt(s)` unit tangent (`[0, 1, 0]` for a zero-length path);
 * `curvatureAt(s)` κ = |P′ × P″| / |P′|³ (1/metres, 0 where undefined);
 * `uAt(s)` the Catmull-Rom parameter; `sAtU(u)` its inverse; `points` the
 * merged control points. Optional `tangents` behave as in catmullRom (default:
 * the points array's own `tangents`, so `makePath(filletPolyline(pts, r))`
 * flies true arcs with curvature ≈ 1/r and straight legs).
 * @param {number[][]} points at least one `[x, y, z]`
 * @param {{alpha?:number, closed?:boolean, samples?:number, tangents?:(number[]|null)[]|null}} [opts]
 *   alpha 0.5, closed false, samples 1024
 * @returns {{length:number, at:(s:number)=>number[], tangentAt:(s:number)=>number[],
 *   curvatureAt:(s:number)=>number, uAt:(s:number)=>number, sAtU:(u:number)=>number,
 *   points:number[][], closed:boolean, curve:ReturnType<typeof catmullRom>}}
 */
export function makePath(points, opts = {}) {
  const o = opts || {};
  const raw = cleanPoints("makePath", points);
  if (raw.length === 0) throw new FilmError("makePath: needs at least one control point", FILM_ERROR_CODES.BAD_ARGUMENT);
  const Traw = resolveTangents("makePath", points, o, raw.length);
  const closedReq = !!o.closed;
  const keep = dedupeIndices(raw, closedReq);
  const P = keep.map((i) => raw[i]);
  const curve = catmullRom(P, { alpha: o.alpha, closed: closedReq, tangents: Traw ? keep.map((i) => Traw[i]) : null });
  const segs = curve.segments;
  const pointsCopy = () => P.map((p) => p.slice());

  if (segs === 0) {
    const p0 = P[0];
    return {
      length: 0,
      at: () => p0.slice(),
      tangentAt: () => [0, 1, 0],
      curvatureAt: () => 0,
      uAt: () => 0,
      sAtU: () => 0,
      points: pointsCopy(),
      closed: curve.closed,
      curve,
    };
  }

  const speed = (u) => len(curve.derivative(u));
  /** ∫ |P′| du over [a, b] with Gauss–Legendre of the given order. */
  const integrate = (a, b, X, W) => {
    const h = (b - a) / 2, m = (a + b) / 2;
    let acc = 0;
    for (let k = 0; k < X.length; k++) acc += W[k] * speed(m + h * X[k]);
    return acc * h;
  };

  const want = Number.isFinite(o.samples) && o.samples > 0 ? Math.round(o.samples) : 1024;
  const perSeg = Math.max(1, Math.ceil(Math.min(1 << 16, Math.max(16, want)) / segs));
  const N = perSeg * segs; // multiple of segs → every LUT interval lies inside one cubic
  const U = new Float64Array(N + 1);
  const L = new Float64Array(N + 1);
  for (let k = 0; k <= N; k++) U[k] = k / N;
  for (let k = 0; k < N; k++) L[k + 1] = L[k] + integrate(U[k], U[k + 1], GL5_X, GL5_W);
  const length = L[N];

  const clampS = (s) => (Number.isFinite(s) ? (s < 0 ? 0 : s > length ? length : s) : 0);

  function uAt(s) {
    if (!(length > 0)) return 0;
    const ss = clampS(s);
    if (ss >= length) return 1;
    let lo = 0, hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (L[mid] <= ss) lo = mid;
      else hi = mid;
    }
    const a = U[lo], b = U[lo + 1];
    const span = L[lo + 1] - L[lo];
    if (!(span > 0)) return a;
    let u = a + ((ss - L[lo]) / span) * (b - a);
    for (let it = 0; it < 4; it++) {
      const f = L[lo] + integrate(a, u, GL3_X, GL3_W) - ss;
      const sp = speed(u);
      if (!(sp > 1e-12)) break;
      let un = u - f / sp;
      if (un < a) un = a;
      else if (un > b) un = b;
      const done = Math.abs(un - u) < 1e-15;
      u = un;
      if (done) break;
    }
    return u;
  }

  function sAtU(u) {
    const uu = clampU(u);
    if (uu >= 1) return length;
    const k = Math.min(N - 1, Math.floor(uu * N));
    const s = L[k] + integrate(U[k], uu, GL3_X, GL3_W);
    return s < 0 ? 0 : s > length ? length : s;
  }

  function curvatureAt(s) {
    const u = uAt(s);
    const d1 = curve.derivative(u);
    const d2 = curve.secondDerivative(u);
    const sp = len(d1);
    if (!(sp > 1e-9)) return 0;
    const k = len(cross(d1, d2)) / (sp * sp * sp);
    return Number.isFinite(k) ? k : 0;
  }

  return {
    length,
    at: (s) => curve.sample(uAt(s)),
    tangentAt: (s) => curve.tangent(uAt(s)),
    curvatureAt,
    uAt,
    sAtU,
    points: pointsCopy(),
    closed: curve.closed,
    curve,
  };
}

// ---------------------------------------------------------------------------
// Polylines
// ---------------------------------------------------------------------------

/**
 * Total length of a polyline (sum of consecutive distances). Empty / single → 0.
 * @param {number[][]} points
 * @returns {number}
 */
export function polylineLength(points) {
  const P = cleanPoints("polylineLength", points);
  let total = 0;
  for (let i = 1; i < P.length; i++) total += dist(P[i - 1], P[i]);
  return total;
}

/**
 * Round every interior corner of a polyline with a circular arc (in the plane
 * of the two legs) — a 90° corridor turn becomes a quarter circle tangent to
 * both legs. Arc radius = min(radius, 0.45·min(adjacent leg lengths)); for
 * turns sharper than 90° the radius is further reduced so the tangent points
 * stay within 0.45 of each leg (arcs of neighbouring corners never overlap).
 * Collinear corners and exact reversals are kept untouched. Each arc
 * contributes arcSegments+1 points (its two tangent points included); end
 * points are kept; consecutive duplicates are merged. radius ≤ 0 / NaN
 * returns the (merged) polyline unchanged.
 *
 * The filleted result also carries a NON-enumerable `tangents` property (the
 * exact unit tangent at every returned point: leg directions, arc tangents,
 * null at a reversal) that catmullRom/makePath pick up automatically, so
 * `makePath(filletPolyline(pts, r))` flies true arcs (curvature ≈ 1/r, no
 * overshoot where a leg meets an arc). Copying the array (map/slice/JSON)
 * drops it — pass `{tangents: out.tangents}` explicitly then.
 * @param {number[][]} points
 * @param {number} radius metres
 * @param {{arcSegments?:number}} [opts] arcSegments default 8 (clamped 1..256)
 * @returns {number[][] & {tangents?:(number[]|null)[]}}
 */
export function filletPolyline(points, radius, opts = {}) {
  const o = opts || {};
  const P = dedupe(cleanPoints("filletPolyline", points), false);
  if (P.length < 3 || !(radius > 0)) return P;
  const arcSegments = Math.max(1, Math.min(256, Math.round(Number.isFinite(o.arcSegments) ? o.arcSegments : 8)));
  const out = [P[0]];
  const tangents = [norm(sub(P[1], P[0]))];
  const push = (p, t) => {
    if (dist(out[out.length - 1], p) > DEDUPE_EPS) {
      out.push(p);
      tangents.push(t);
    }
  };
  for (let i = 1; i < P.length - 1; i++) {
    const cur = P[i];
    const vin = sub(cur, P[i - 1]);
    const vout = sub(P[i + 1], cur);
    const lin = len(vin), lout = len(vout);
    const a = norm(vin), b = norm(vout);
    const theta = angleBetween(a, b);
    if (!(theta > COLLINEAR_EPS) || !(theta < Math.PI - COLLINEAR_EPS)) {
      push(cur, theta < Math.PI / 2 ? a : null);
      continue;
    }
    const legCap = 0.45 * Math.min(lin, lout);
    const tanHalf = Math.tan(theta / 2);
    let r = Math.min(radius, legCap);
    if (r * tanHalf > legCap) r = legCap / tanHalf;
    const d = r * tanHalf;
    const inward = norm(addScaled(b, a, -dot(a, b)));
    const t1 = addScaled(cur, a, -d);
    const centre = addScaled(t1, inward, r);
    for (let k = 0; k <= arcSegments; k++) {
      const phi = (theta * k) / arcSegments;
      const c = Math.cos(phi), s = Math.sin(phi);
      push([
        centre[0] - inward[0] * r * c + a[0] * r * s,
        centre[1] - inward[1] * r * c + a[1] * r * s,
        centre[2] - inward[2] * r * c + a[2] * r * s,
      ], norm([a[0] * c + inward[0] * s, a[1] * c + inward[1] * s, a[2] * c + inward[2] * s]));
    }
  }
  push(P[P.length - 1], norm(sub(P[P.length - 1], P[P.length - 2])));
  Object.defineProperty(out, "tangents", { value: tangents, enumerable: false, writable: true, configurable: true });
  return out;
}

/**
 * Points every `step` metres along a polyline (by arc length), starting at the
 * first point; the last point is always included (so the final spacing may be
 * shorter than `step`). Consecutive duplicates are merged first. Empty → [].
 * Throws FilmError when step is not a finite number > 0 or would produce more
 * than 1,000,000 points.
 * @param {number[][]} points
 * @param {number} step metres
 * @returns {number[][]}
 */
export function resamplePolyline(points, step) {
  const P = dedupe(cleanPoints("resamplePolyline", points), false);
  if (P.length === 0) return [];
  if (!(step > 0) || !Number.isFinite(step)) {
    throw new FilmError(`resamplePolyline: step must be a finite number > 0 (got ${step})`, FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  if (P.length === 1) return [P[0]];
  let total = 0;
  for (let i = 1; i < P.length; i++) total += dist(P[i - 1], P[i]);
  const count = Math.floor(total / step + 1e-9);
  if (count > 1e6) {
    throw new FilmError(`resamplePolyline: step ${step} m over ${total.toFixed(1)} m gives too many points`, FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  const out = [P[0].slice()];
  let seg = 0, segStart = 0, segLen = dist(P[0], P[1]);
  for (let k = 1; k <= count; k++) {
    const target = k * step;
    while (seg < P.length - 2 && segStart + segLen < target) {
      segStart += segLen;
      seg++;
      segLen = dist(P[seg], P[seg + 1]);
    }
    const f = segLen > 0 ? Math.min(1, Math.max(0, (target - segStart) / segLen)) : 0;
    const a = P[seg], b = P[seg + 1];
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
  }
  const last = P[P.length - 1];
  if (dist(out[out.length - 1], last) <= Math.max(1e-9, 1e-9 * total)) out[out.length - 1] = last.slice();
  else out.push(last.slice());
  return out;
}

/**
 * Cubic Bézier point (Bernstein form). t is NOT clamped (extrapolates);
 * non-finite t → 0.
 * @param {number[]} p0 @param {number[]} p1 @param {number[]} p2 @param {number[]} p3 @param {number} t
 * @returns {number[]}
 */
export function bezier3(p0, p1, p2, p3, t) {
  const u = Number.isFinite(t) ? t : 0;
  const v = 1 - u;
  const b0 = v * v * v, b1 = 3 * v * v * u, b2 = 3 * v * u * u, b3 = u * u * u;
  return [0, 1, 2].map((k) => b0 * p0[k] + b1 * p1[k] + b2 * p2[k] + b3 * p3[k]);
}

/**
 * Derivative dB/dt of the cubic Bézier at t (non-finite t → 0).
 * @param {number[]} p0 @param {number[]} p1 @param {number[]} p2 @param {number[]} p3 @param {number} t
 * @returns {number[]}
 */
export function bezier3Derivative(p0, p1, p2, p3, t) {
  const u = Number.isFinite(t) ? t : 0;
  const v = 1 - u;
  return [0, 1, 2].map((k) => 3 * v * v * (p1[k] - p0[k]) + 6 * v * u * (p2[k] - p1[k]) + 3 * u * u * (p3[k] - p2[k]));
}

// ---------------------------------------------------------------------------
// Speed profile
// ---------------------------------------------------------------------------

/** Validate a positive limit; Infinity allowed only when allowInf. */
function posLimit(name, v, allowInf) {
  if (!(v > 0) || (!allowInf && !Number.isFinite(v))) {
    throw new FilmError(`speedLimitedProfile: ${name} must be ${allowInf ? "> 0" : "a finite number > 0"} (got ${v})`,
      FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  return v;
}

/**
 * Time-optimal speed profile along a path under a speed cap, a tangential
 * acceleration cap and a LATERAL acceleration cap: v(s) ≤ min(vmax, √(alat/κ(s))).
 * Stations every ≈0.25 m (64..8192 of them) carry the cap (the minimum over
 * each station's neighbourhood), a forward pass limits acceleration, a
 * backward pass limits deceleration; between stations the motion has constant
 * acceleration, so `sAt` is exact, continuous and monotone, `sAt(0) = 0` and
 * `sAt(duration) = path.length`. Rest-to-rest by default (startSpeed/endSpeed).
 * @param {{length:number, curvatureAt?:(s:number)=>number}} path e.g. makePath(...)
 * @param {{vmax:number, amax:number, alat?:number, startSpeed?:number, endSpeed?:number}} opts
 *   vmax m/s and amax m/s² are required; alat m/s² default 2.5 (Infinity = ignore curvature)
 * @returns {{duration:number, length:number, sAt:(t:number)=>number, vAt:(t:number)=>number, peakSpeed:number}}
 */
export function speedLimitedProfile(path, opts = {}) {
  const o = opts || {};
  if (!path || typeof path !== "object" || !Number.isFinite(path.length) || path.length < 0) {
    throw new FilmError("speedLimitedProfile: path must be a makePath() result with a finite length", FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  const vmax = posLimit("vmax", o.vmax, false);
  const amax = posLimit("amax", o.amax, false);
  const alat = posLimit("alat", o.alat === undefined ? 2.5 : o.alat, true);
  const v0 = Math.min(vmax, Number.isFinite(o.startSpeed) && o.startSpeed > 0 ? o.startSpeed : 0);
  const vEnd = Math.min(vmax, Number.isFinite(o.endSpeed) && o.endSpeed > 0 ? o.endSpeed : 0);
  const Ltot = path.length;
  if (!(Ltot > 0)) {
    return { duration: 0, length: 0, sAt: () => 0, vAt: () => 0, peakSpeed: 0 };
  }
  const kappa = typeof path.curvatureAt === "function"
    ? (s) => {
      const k = path.curvatureAt(s);
      return Number.isFinite(k) && k > 0 ? k : 0;
    }
    : () => 0;
  const capOf = (k) => (k > 0 && Number.isFinite(alat) ? Math.min(vmax, Math.sqrt(alat / k)) : vmax);

  const n = Math.max(64, Math.min(8192, Math.ceil(Ltot / 0.25)));
  const ds = Ltot / n;
  const S = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) S[i] = i === n ? Ltot : i * ds;
  // Peak curvature of every interval (ends + 3 interior sub-samples). A station
  // is capped by BOTH adjacent intervals, so the speed anywhere inside interval
  // i (which lies between its two station speeds) never exceeds √(alat/κ) of i.
  const SUB = 4;
  const kInt = new Float64Array(n);
  let kPrev = kappa(0);
  for (let i = 0; i < n; i++) {
    let kmax = kPrev;
    for (let j = 1; j <= SUB; j++) {
      const k = kappa(j === SUB ? S[i + 1] : S[i] + (ds * j) / SUB);
      if (k > kmax) kmax = k;
      if (j === SUB) kPrev = k;
    }
    kInt[i] = kmax;
  }
  const V = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const k = Math.max(i > 0 ? kInt[i - 1] : 0, i < n ? kInt[i] : 0);
    V[i] = capOf(k);
  }
  V[0] = Math.min(V[0], v0);
  V[n] = Math.min(V[n], vEnd);
  for (let i = 0; i < n; i++) V[i + 1] = Math.min(V[i + 1], Math.sqrt(V[i] * V[i] + 2 * amax * ds));
  for (let i = n - 1; i >= 0; i--) V[i] = Math.min(V[i], Math.sqrt(V[i + 1] * V[i + 1] + 2 * amax * ds));

  const T = new Float64Array(n + 1);
  const A = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const h = S[i + 1] - S[i];
    const vs = V[i] + V[i + 1];
    const dt = vs > 1e-12 ? (2 * h) / vs : Math.sqrt((2 * h) / amax);
    T[i + 1] = T[i] + dt;
    A[i] = dt > 0 ? (V[i + 1] - V[i]) / dt : 0;
    if (V[i] > peak) peak = V[i];
  }
  if (V[n] > peak) peak = V[n];
  const duration = T[n];

  const find = (t) => {
    let lo = 0, hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (T[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  function sAt(t) {
    if (!Number.isFinite(t) || t <= 0) return 0;
    if (t >= duration) return Ltot;
    const i = find(t);
    const tau = t - T[i];
    const s = S[i] + V[i] * tau + 0.5 * A[i] * tau * tau;
    return s < S[i] ? S[i] : s > S[i + 1] ? S[i + 1] : s;
  }

  function vAt(t) {
    if (!Number.isFinite(t) || t <= 0) return V[0];
    if (t >= duration) return V[n];
    const i = find(t);
    const v = V[i] + A[i] * (t - T[i]);
    return v < 0 ? 0 : v;
  }

  return { duration, length: Ltot, sAt, vAt, peakSpeed: peak };
}
