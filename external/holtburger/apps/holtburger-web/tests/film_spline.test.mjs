// tests/film_spline.test.mjs
//
// WHY: every moving AC Film Mode shot is "a smooth path + a speed profile", and
// dungeon shots must round 90° corridor turns smoothly instead of pivoting on
// a corner. This suite executes scene3d/film/core/spline.js and proves:
//   S1  catmullRom passes through its control points (open/closed, α = 0, ½, 1)
//       and matches REAL three 0.184 CatmullRomCurve3 point-for-point;
//       degenerate inputs (coincident points, one point) never NaN or loop;
//       bad inputs throw FilmError;
//   S2  makePath is arc-length parameterised: |at(s+ds) − at(s)| ≈ ds within
//       0.5%, ends exact, tangent unit, curvature of a circle ≈ 1/R;
//   S3  filletPolyline turns an L-shaped corridor (90° turn) into an arc
//       tangent to both legs with the requested radius, clamped by 0.45×leg;
//       collinear corners untouched; a filleted dungeon zig-zag flies smoothly;
//   S4  resamplePolyline / polylineLength / bezier3 basics;
//   S5  speedLimitedProfile is monotone, ends at the path length, respects
//       v ≤ vmax, |a| ≤ amax and v ≤ √(alat/κ) on a tight arc.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure modules.
// Run from apps/holtburger-web/: node tests/film_spline.test.mjs

import assert from "node:assert/strict";

const S = await import("../scene3d/film/core/spline.js");
const V = await import("../scene3d/film/core/vec3.js");
const { FilmError } = await import("../scene3d/film/core/errors.js");
const { mulberry32 } = await import("../scene3d/film/core/rng.js");
const THREE = await import("three");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err && err.message ? err.message : err}`);
  }
}

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
}
function nearV(a, b, eps, msg) {
  for (let i = 0; i < 3; i++) near(a[i], b[i], eps, `${msg ?? "vec"}[${i}] (${a} vs ${b})`);
}
const isFilmBadArg = (e) => e instanceof FilmError && e.code === "BAD_ARGUMENT";

// A wiggly 3-D path with uneven spacing, placed at real AC world coordinates (Holtburg).
const OX = 32448, OY = 34560;
const WIGGLY = [
  [0, 0, 60], [12, 3, 61], [20, 15, 63], [22, 30, 62], [35, 38, 66], [36, 39, 66.5], [60, 45, 70], [80, 30, 72],
].map(([x, y, z]) => [OX + x, OY + y, z]);

// ---------------------------------------------------------------------------
console.log("S1 Catmull-Rom");

check("passes through every control point (open & closed; α = 0, 0.5, 1)", () => {
  for (const alpha of [0, 0.5, 1]) for (const closed of [false, true]) {
    const c = S.catmullRom(WIGGLY, { alpha, closed });
    const n = WIGGLY.length;
    assert.equal(c.segments, closed ? n : n - 1);
    for (let i = 0; i < n; i++) nearV(c.sample(i / c.segments), WIGGLY[i], 1e-8, `α=${alpha} closed=${closed} point ${i}`);
    if (closed) nearV(c.sample(1), WIGGLY[0], 1e-8, "closed wraps to the first point");
  }
});

check("matches THREE.CatmullRomCurve3 (centripetal / chordal / uniform) point-for-point", () => {
  const pts = WIGGLY.map(([x, y, z]) => new THREE.Vector3(x - OX, y - OY, z));
  const local = WIGGLY.map(([x, y, z]) => [x - OX, y - OY, z]);
  const cases = [["centripetal", 0.5, 0.5], ["chordal", 1, 0.5], ["catmullrom", 0, 0.5]];
  const tmp = new THREE.Vector3();
  for (const [type, alpha, tension] of cases) for (const closed of [false, true]) {
    const three = new THREE.CatmullRomCurve3(pts, closed, type, tension);
    const mine = S.catmullRom(local, { alpha, closed });
    for (let k = 0; k <= 400; k++) {
      const u = k / 400;
      three.getPoint(u, tmp);
      nearV(mine.sample(u), [tmp.x, tmp.y, tmp.z], 1e-9, `${type} closed=${closed} u=${u}`);
    }
  }
});

check("derivative matches finite differences; tangent is the unit derivative", () => {
  const c = S.catmullRom(WIGGLY);
  const h = 1e-6;
  for (let k = 1; k < 200; k++) {
    const u = k / 200 + 1e-4; // stay off the knots (C¹ only there)
    const fd = V.scale(V.sub(c.sample(u + h), c.sample(u - h)), 1 / (2 * h));
    const d = c.derivative(u);
    nearV(d, fd, 1e-3 * Math.max(1, V.len(d)), `derivative at ${u}`);
    nearV(c.tangent(u), V.norm(d), 1e-12, "tangent");
    near(V.len(c.tangent(u)), 1, 1e-12, "unit");
    const fd2 = V.scale(V.sub(c.derivative(u + h), c.derivative(u - h)), 1 / (2 * h));
    nearV(c.secondDerivative(u), fd2, 1e-2 * Math.max(1, V.len(fd2)), "second derivative");
  }
});

check("coincident consecutive points hold still (no NaN, no loop); a single point is constant", () => {
  const P = [[0, 0, 0], [5, 0, 0], [5, 0, 0], [10, 0, 0]];
  const c = S.catmullRom(P);
  for (let k = 0; k <= 300; k++) {
    const p = c.sample(k / 300);
    assert.ok(V.isFiniteV(p), "finite");
    near(p[1], 0, 1e-12, "stays on the line");
    near(p[2], 0, 1e-12, "stays on the line");
    assert.ok(p[0] >= -1e-12 && p[0] <= 10 + 1e-12, `no overshoot ${p[0]}`);
    assert.ok(V.isFiniteV(c.tangent(k / 300)), "finite tangent");
  }
  for (let k = 0; k <= 10; k++) nearV(c.sample(1 / 3 + k / 30), [5, 0, 0], 1e-12, "degenerate segment is a point");
  const one = S.catmullRom([[1, 2, 3]]);
  assert.equal(one.segments, 0);
  assert.deepEqual(one.sample(0.7), [1, 2, 3]);
  assert.deepEqual(one.tangent(0.7), [0, 1, 0]);
  assert.deepEqual(S.catmullRom([[1, 2, 3]]).sample(NaN), [1, 2, 3]);
  const two = S.catmullRom([[0, 0, 0], [0, 10, 0]]);
  nearV(two.sample(0.5), [0, 5, 0], 1e-12, "two points = straight segment");
});

check("bad inputs throw FilmError BAD_ARGUMENT (empty, NaN point, non-array); u is clamped", () => {
  assert.throws(() => S.catmullRom([]), isFilmBadArg);
  assert.throws(() => S.catmullRom([[0, 0, 0], [1, NaN, 0]]), isFilmBadArg);
  assert.throws(() => S.catmullRom(null), isFilmBadArg);
  assert.throws(() => S.makePath([]), isFilmBadArg);
  assert.throws(() => S.makePath([[0, 0]]), isFilmBadArg);
  const c = S.catmullRom(WIGGLY);
  assert.deepEqual(c.sample(-5), c.sample(0));
  assert.deepEqual(c.sample(7), c.sample(1));
  assert.deepEqual(c.sample(NaN), c.sample(0));
  const input = WIGGLY.map((p) => p.slice());
  S.catmullRom(input);
  assert.deepEqual(input, WIGGLY, "inputs not mutated");
});

// ---------------------------------------------------------------------------
console.log("S2 arc-length path");

check("makePath: |at(s+ds) − at(s)| ≈ ds within 0.5% everywhere (ds = 0.5 m and 0.05 m)", () => {
  const path = S.makePath(WIGGLY);
  assert.ok(path.length > 100, `length ${path.length}`);
  for (const ds of [0.5, 0.05]) {
    let worst = 0;
    for (let s = 0; s + ds <= path.length; s += ds * 0.97) {
      const d = V.dist(path.at(s), path.at(s + ds));
      worst = Math.max(worst, Math.abs(d - ds) / ds);
    }
    assert.ok(worst < 0.005, `ds=${ds}: worst relative error ${worst}`);
  }
});

check("makePath: length matches a dense polyline; ends exact; s clamped; uAt/sAtU inverse", () => {
  const path = S.makePath(WIGGLY);
  const c = S.catmullRom(WIGGLY);
  const dense = [];
  for (let k = 0; k <= 200000; k++) dense.push(c.sample(k / 200000));
  near(path.length, S.polylineLength(dense), 1e-4, "length");
  nearV(path.at(0), WIGGLY[0], 1e-9, "start");
  nearV(path.at(path.length), WIGGLY[WIGGLY.length - 1], 1e-9, "end");
  assert.deepEqual(path.at(-3), path.at(0));
  assert.deepEqual(path.at(path.length + 10), path.at(path.length));
  assert.deepEqual(path.at(NaN), path.at(0));
  for (let k = 0; k <= 50; k++) {
    const s = (k / 50) * path.length;
    near(path.sAtU(path.uAt(s)), s, 1e-6, `sAtU(uAt(${s}))`);
  }
  assert.equal(path.points.length, WIGGLY.length);
});

check("makePath: tangentAt is unit and follows the motion; straight line has κ = 0 and exact positions", () => {
  const path = S.makePath(WIGGLY);
  for (let k = 1; k < 100; k++) {
    const s = (k / 100) * path.length;
    const t = path.tangentAt(s);
    near(V.len(t), 1, 1e-12, "unit");
    const fd = V.norm(V.sub(path.at(s + 0.01), path.at(s - 0.01)));
    assert.ok(V.angleBetween(t, fd) < 0.01, `tangent direction at ${s}`);
  }
  const line = S.makePath([[0, 0, 0], [0, 10, 0], [0, 30, 0]]);
  near(line.length, 30, 1e-9, "line length");
  for (let s = 0; s <= 30; s += 0.7) {
    near(line.curvatureAt(s), 0, 1e-9, "κ = 0");
    near(line.at(s)[1], s, 1e-6, "at(s) on a line");
  }
});

check("makePath: curvature of a sampled circle (R = 10) ≈ 0.1; closed loop returns to its start", () => {
  const R = 10;
  const pts = [];
  for (let k = 0; k < 36; k++) pts.push([R * Math.cos((k * Math.PI) / 18), R * Math.sin((k * Math.PI) / 18), 5]);
  const loop = S.makePath(pts, { closed: true });
  near(loop.length, 2 * Math.PI * R, 2 * Math.PI * R * 1e-3, "circumference");
  // plain Catmull-Rom through 10° samples: curvature ripples a few % around 1/R
  for (let k = 0; k < 60; k++) near(loop.curvatureAt((k / 60) * loop.length), 1 / R, 0.05 / R, "κ ≈ 1/R");
  // with the exact circle tangents the cubic is the optimal arc fit: κ = 1/R to 0.1%
  const tang = pts.map(([x, y]) => [-y / R, x / R, 0]);
  const exact = S.makePath(pts, { closed: true, tangents: tang });
  for (let k = 0; k < 60; k++) near(exact.curvatureAt((k / 60) * exact.length), 1 / R, 0.001 / R, "κ with tangents");
  near(exact.length, 2 * Math.PI * R, 2 * Math.PI * R * 1e-5, "exact circumference");
  nearV(loop.at(loop.length), loop.at(0), 1e-9, "closed");
  // closing duplicate is merged
  const dup = S.makePath([...pts, pts[0]], { closed: true });
  near(dup.length, loop.length, 1e-9, "duplicate closing point ignored");
});

check("makePath: duplicates merged, single-point / all-coincident path has length 0 and finite queries", () => {
  const p = S.makePath([[1, 1, 1], [1, 1, 1], [1, 1, 1]]);
  assert.equal(p.length, 0);
  assert.deepEqual(p.at(5), [1, 1, 1]);
  assert.deepEqual(p.tangentAt(0), [0, 1, 0]);
  assert.equal(p.curvatureAt(0), 0);
  const q = S.makePath([[0, 0, 0], [0, 0, 0], [3, 4, 0], [3, 4, 0]]);
  near(q.length, 5, 1e-9, "merged duplicate length");
  assert.equal(q.points.length, 2);
});

// ---------------------------------------------------------------------------
console.log("S3 fillets: 90° corridor turns become arcs");

function arcInfo(out, corner, a, b, r) {
  // the arc's tangent points and centre for a corner with unit legs a (in) and b (out)
  const theta = V.angleBetween(a, b);
  const d = r * Math.tan(theta / 2);
  const t1 = V.addScaled(corner, a, -d);
  const t2 = V.addScaled(corner, b, d);
  const inward = V.norm(V.addScaled(b, a, -V.dot(a, b)));
  return { t1, t2, centre: V.addScaled(t1, inward, r) };
}

check("L-shaped corridor: arc of the requested radius, tangent to both legs, endpoints kept", () => {
  const P = [[0, 0, 1.5], [0, 20, 1.5], [20, 20, 1.5]];
  const out = S.filletPolyline(P, 3, { arcSegments: 8 });
  assert.equal(out.length, 2 + 9, "2 ends + arcSegments+1 arc points");
  assert.deepEqual(out[0], P[0]);
  assert.deepEqual(out[out.length - 1], P[2]);
  const { t1, t2, centre } = arcInfo(out, P[1], [0, 1, 0], [1, 0, 0], 3);
  nearV(centre, [3, 17, 1.5], 1e-12, "centre");
  nearV(out[1], t1, 1e-12, "first arc point = tangent point on the in-leg");
  nearV(out[9], t2, 1e-12, "last arc point = tangent point on the out-leg");
  for (let k = 1; k <= 9; k++) {
    near(V.dist(out[k], centre), 3, 1e-12, `arc point ${k} on the radius-3 circle`);
    near(out[k][2], 1.5, 1e-12, "stays at corridor height");
  }
  // tangency: the radius at each tangent point is perpendicular to its leg
  near(V.dot(V.sub(t1, centre), [0, 1, 0]), 0, 1e-12, "tangent to the in-leg");
  near(V.dot(V.sub(t2, centre), [1, 0, 0]), 0, 1e-12, "tangent to the out-leg");
  // tangent points lie ON the legs
  near(t1[0], 0, 1e-12, "t1 on x = 0");
  near(t2[1], 20, 1e-12, "t2 on y = 20");
});

check("radius clamps to 0.45 × the shorter leg; sharp turns keep tangent points within 0.45 of each leg", () => {
  const big = S.filletPolyline([[0, 0, 0], [0, 20, 0], [20, 20, 0]], 30);
  near(V.dist(big[1], [0, 20, 0]), 9, 1e-9, "r = 0.45·20 = 9 (tangent distance at 90° = r)");
  const short = S.filletPolyline([[0, 0, 0], [0, 2, 0], [2, 2, 0]], 3);
  const { centre } = arcInfo(short, [0, 2, 0], [0, 1, 0], [1, 0, 0], 0.9);
  for (let k = 1; k < short.length - 1; k++) near(V.dist(short[k], centre), 0.9, 1e-12, "r = 0.45·2 = 0.9");
  // a 150° hairpin: tangent distance would be r·tan(75°) — reduced so it stays inside the leg
  const hp = S.filletPolyline([[0, 0, 0], [0, 10, 0], [5, 10 - 5 * Math.sqrt(3), 0]], 4);
  assert.ok(V.dist(hp[1], [0, 10, 0]) <= 4.5 + 1e-9, "hairpin tangent point within 0.45 of the in-leg");
  assert.ok(hp.every((p) => V.isFiniteV(p)), "finite");
});

check("collinear corners and reversals untouched; ≤ 2 points / radius ≤ 0 unchanged; empty → []", () => {
  const line = [[0, 0, 0], [0, 5, 0], [0, 10, 0]];
  assert.deepEqual(S.filletPolyline(line, 2), line);
  const rev = [[0, 0, 0], [0, 5, 0], [0, 1, 0]];
  assert.deepEqual(S.filletPolyline(rev, 2), rev);
  const L = [[0, 0, 0], [0, 5, 0], [5, 5, 0]];
  assert.deepEqual(S.filletPolyline(L, 0), L);
  assert.deepEqual(S.filletPolyline(L, NaN), L);
  assert.deepEqual(S.filletPolyline([[0, 0, 0], [1, 1, 1]], 2), [[0, 0, 0], [1, 1, 1]]);
  assert.deepEqual(S.filletPolyline([], 2), []);
  assert.throws(() => S.filletPolyline([[0, 0, 0], [NaN, 0, 0], [1, 1, 0]], 1), isFilmBadArg);
});

check("filletPolyline attaches exact, non-enumerable unit tangents (legs + arc tangents)", () => {
  const P = [[0, 0, 1.5], [0, 20, 1.5], [20, 20, 1.5]];
  const out = S.filletPolyline(P, 3, { arcSegments: 8 });
  assert.ok(Array.isArray(out.tangents) && out.tangents.length === out.length, "one tangent per point");
  assert.equal(Object.keys(out).includes("tangents"), false, "non-enumerable (JSON/deepEqual see plain points)");
  assert.equal(JSON.stringify(out), JSON.stringify(out.map((p) => p)), "JSON is just the points");
  nearV(out.tangents[0], [0, 1, 0], 1e-15, "first leg");
  nearV(out.tangents[out.length - 1], [1, 0, 0], 1e-15, "last leg");
  const centre = [3, 17, 1.5];
  for (let k = 1; k <= 9; k++) {
    near(V.len(out.tangents[k]), 1, 1e-12, "unit");
    near(V.dot(out.tangents[k], V.sub(out[k], centre)), 0, 1e-12, "arc tangent ⟂ radius");
  }
  assert.throws(() => S.makePath(P, { tangents: [[0, 1, 0]] }), isFilmBadArg);
  assert.throws(() => S.makePath(P, { tangents: [[0, 1, 0], [NaN, 0, 0], null] }), isFilmBadArg);
});

check("a filleted dungeon zig-zag (four 90° turns, short legs) flies true arcs: κ ≤ 1/r, no corner", () => {
  const corridor = [[0, 0, 1.6], [0, 8, 1.6], [6, 8, 1.6], [6, 14, 1.6], [0, 14, 1.6], [0, 24, 1.6]];
  const radius = 2;
  const fil = S.filletPolyline(corridor, radius, { arcSegments: 8 });
  const path = S.makePath(fil);
  const scan = (p) => {
    let worstTurn = 0, maxK = 0;
    let prevT = p.tangentAt(0);
    for (let s = 0.1; s <= p.length; s += 0.1) {
      const t = p.tangentAt(s);
      worstTurn = Math.max(worstTurn, V.angleBetween(prevT, t));
      maxK = Math.max(maxK, p.curvatureAt(s));
      prevT = t;
    }
    for (let s = 0; s <= p.length; s += 0.013) maxK = Math.max(maxK, p.curvatureAt(s));
    return { worstTurn, maxK };
  };
  const { worstTurn, maxK } = scan(path);
  // a 90° pivot would be one huge step; on a radius-r arc the tangent turns 0.1/r rad per 10 cm
  assert.ok(worstTurn <= (0.1 / radius) * 1.01, `worst tangent turn per 10 cm ${worstTurn} rad`);
  assert.ok(maxK <= (1 / radius) * 1.01, `max curvature ${maxK} vs 1/r = ${1 / radius}`);
  // the plain Catmull-Rom estimate (tangents: null) is still smooth but overshoots at leg/arc joins
  const plain = scan(S.makePath(fil, { tangents: null }));
  assert.ok(plain.maxK > maxK * 1.2 && plain.maxK < 3 / radius, `plain CR κ ${plain.maxK}`);
  // a copied array loses the hidden tangents; passing them explicitly restores the exact arcs
  const copy = fil.map((p) => p.slice());
  near(scan(S.makePath(copy, { tangents: fil.tangents })).maxK, maxK, 1e-12, "explicit tangents");
  // the path stays inside the corridor's corner box (never cuts outside the polyline hull by > 5 cm)
  for (let s = 0; s <= path.length; s += 0.05) {
    const p = path.at(s);
    assert.ok(p[0] >= -0.05 && p[0] <= 6.05 && p[1] >= -0.05 && p[1] <= 24.05, `inside at s=${s}: ${p}`);
    near(p[2], 1.6, 1e-9, "height kept");
  }
});

// ---------------------------------------------------------------------------
console.log("S4 polylines and Bézier");

check("polylineLength; resamplePolyline spacing exactly step (last interval ≤ step), ends kept", () => {
  const P = [[0, 0, 0], [3, 4, 0], [3, 4, 12]];
  near(S.polylineLength(P), 17, 1e-12, "3-4-5 + 12");
  assert.equal(S.polylineLength([]), 0);
  assert.equal(S.polylineLength([[1, 2, 3]]), 0);
  const R = S.resamplePolyline(P, 2);
  assert.equal(R.length, 10, "0,2,…,16 then the end at 17");
  // sample i sits 2·i metres along the ORIGINAL polyline (5 m up the 3-4-5 leg, then up z)
  const alongOriginal = (s) => (s <= 5 ? [0.6 * s, 0.8 * s, 0] : [3, 4, s - 5]);
  for (let i = 0; i < R.length - 1; i++) nearV(R[i], alongOriginal(2 * i), 1e-12, `sample ${i}`);
  assert.deepEqual(R[0], P[0]);
  assert.deepEqual(R[R.length - 1], P[2]);
  const exact = S.resamplePolyline([[0, 0, 0], [0, 10, 0]], 2.5);
  assert.equal(exact.length, 5, "exact multiple: no duplicate end point");
  assert.deepEqual(S.resamplePolyline([], 1), []);
  assert.deepEqual(S.resamplePolyline([[1, 1, 1]], 1), [[1, 1, 1]]);
  assert.throws(() => S.resamplePolyline(P, 0), isFilmBadArg);
  assert.throws(() => S.resamplePolyline(P, NaN), isFilmBadArg);
});

check("bezier3 endpoints/midpoint and derivative vs finite differences", () => {
  const p0 = [0, 0, 0], p1 = [0, 10, 0], p2 = [10, 10, 5], p3 = [10, 0, 5];
  assert.deepEqual(S.bezier3(p0, p1, p2, p3, 0), p0);
  assert.deepEqual(S.bezier3(p0, p1, p2, p3, 1), p3);
  nearV(S.bezier3(p0, p1, p2, p3, 0.5), [5, 7.5, 2.5], 1e-12, "midpoint");
  for (let t = 0.05; t < 1; t += 0.1) {
    const fd = V.scale(V.sub(S.bezier3(p0, p1, p2, p3, t + 1e-6), S.bezier3(p0, p1, p2, p3, t - 1e-6)), 5e5);
    nearV(S.bezier3Derivative(p0, p1, p2, p3, t), fd, 1e-5, "derivative");
  }
  assert.deepEqual(S.bezier3(p0, p1, p2, p3, NaN), p0);
});

// ---------------------------------------------------------------------------
console.log("S5 curvature-limited speed profile");

/** Sample a profile densely and return arrays of t, s, v (from vAt) and numeric accelerations. */
function sampleProfile(prof, n = 4000) {
  const ts = [], ss = [], vs = [];
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * prof.duration;
    ts.push(t);
    ss.push(prof.sAt(t));
    vs.push(prof.vAt(t));
  }
  return { ts, ss, vs };
}

check("straight 100 m path: trapezoid timing, monotone, exact ends, v ≤ vmax, |a| ≤ amax", () => {
  const path = S.makePath([[0, 0, 0], [0, 100, 0]]);
  const prof = S.speedLimitedProfile(path, { vmax: 10, amax: 2 });
  near(prof.duration, 15, 0.02, "duration = 2·(10/2) + (100 − 50)/10");
  assert.equal(prof.sAt(0), 0);
  assert.equal(prof.sAt(prof.duration), path.length);
  assert.equal(prof.sAt(prof.duration + 5), path.length);
  const { ts, ss, vs } = sampleProfile(prof);
  for (let k = 1; k < ts.length; k++) {
    assert.ok(ss[k] >= ss[k - 1], "monotone");
    assert.ok(vs[k] <= 10 + 1e-9, "v ≤ vmax");
    const dt = ts[k] - ts[k - 1];
    const vNum = (ss[k] - ss[k - 1]) / dt;
    assert.ok(vNum <= 10 + 1e-6, "numeric v ≤ vmax");
    assert.ok(Math.abs(vs[k] - vs[k - 1]) / dt <= 2 * (1 + 1e-6), "|a| ≤ amax");
  }
  near(prof.peakSpeed, 10, 1e-9, "reaches vmax");
});

check("tight arc (R = 4 m hairpin): v ≤ √(alat/κ) everywhere, slows in the turn, fast on the straights", () => {
  const pts = [[0, -40, 2], [0, 0, 2]];
  for (let k = 1; k < 18; k++) pts.push([4 - 4 * Math.cos((k * Math.PI) / 18), 4 * Math.sin((k * Math.PI) / 18), 2]);
  pts.push([8, 0, 2], [8, -40, 2]);
  const path = S.makePath(pts);
  const alat = 2.5;
  const prof = S.speedLimitedProfile(path, { vmax: 12, amax: 3, alat });
  const { ts, ss, vs } = sampleProfile(prof, 6000);
  let minArcV = Infinity;
  for (let k = 0; k < ts.length; k++) {
    const kap = path.curvatureAt(ss[k]);
    if (kap > 1e-6) assert.ok(vs[k] <= Math.sqrt(alat / kap) * 1.01 + 1e-6, `v ${vs[k]} > √(alat/κ) ${Math.sqrt(alat / kap)} at s=${ss[k]}`);
    if (k > 0) assert.ok(ss[k] >= ss[k - 1], "monotone");
    if (path.at(ss[k])[1] > 1) minArcV = Math.min(minArcV, vs[k]);
  }
  assert.ok(minArcV <= Math.sqrt(alat * 4) * 1.02, `slow in the turn (${minArcV})`);
  assert.ok(prof.peakSpeed > 8, `fast on the straights (${prof.peakSpeed})`);
  assert.equal(prof.sAt(prof.duration), path.length);
});

check("startSpeed/endSpeed, zero-length path, bad limits → FilmError", () => {
  const path = S.makePath([[0, 0, 0], [0, 50, 0]]);
  const flying = S.speedLimitedProfile(path, { vmax: 5, amax: 1, startSpeed: 5, endSpeed: 5 });
  near(flying.duration, 10, 1e-6, "constant 5 m/s over 50 m");
  near(flying.vAt(0), 5, 1e-12, "flying start");
  const zero = S.speedLimitedProfile(S.makePath([[1, 1, 1]]), { vmax: 5, amax: 1 });
  assert.equal(zero.duration, 0);
  assert.equal(zero.sAt(3), 0);
  assert.throws(() => S.speedLimitedProfile(path, { amax: 1 }), isFilmBadArg);
  assert.throws(() => S.speedLimitedProfile(path, { vmax: 5, amax: 0 }), isFilmBadArg);
  assert.throws(() => S.speedLimitedProfile(path, { vmax: 5, amax: 1, alat: -1 }), isFilmBadArg);
  assert.throws(() => S.speedLimitedProfile(null, { vmax: 5, amax: 1 }), isFilmBadArg);
  const noCurv = S.speedLimitedProfile({ length: 20 }, { vmax: 4, amax: 2 });
  assert.equal(noCurv.sAt(noCurv.duration), 20, "any {length} object works");
});

check("deterministic: same inputs → identical paths and profiles", () => {
  const rng = mulberry32(5);
  const pts = [];
  for (let i = 0; i < 12; i++) pts.push([rng() * 100, rng() * 100, rng() * 10]);
  const a = S.makePath(pts), b = S.makePath(pts);
  const pa = S.speedLimitedProfile(a, { vmax: 8, amax: 2 });
  const pb = S.speedLimitedProfile(b, { vmax: 8, amax: 2 });
  assert.equal(pa.duration, pb.duration);
  for (let k = 0; k <= 50; k++) {
    const t = (k / 50) * pa.duration;
    assert.deepEqual(a.at(pa.sAt(t)), b.at(pb.sAt(t)));
  }
});

console.log(`film_spline: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
