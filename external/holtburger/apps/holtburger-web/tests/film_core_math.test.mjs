// tests/film_core_math.test.mjs
//
// WHY: every AC Film Mode lane (shots, drone, pilot, solver, runtime, Node
// CLI) imports the core math in scene3d/film/core/. A wrong sign in a
// heading quaternion, a signed landblock key for x ≥ 0x80, a spring that
// overshoots or a shake that is not reproducible would surface as broken
// footage far from its cause. This suite executes the real modules:
//   M1  errors.js   FilmError / FilmShotError / FilmPlanError carry .code;
//   M2  vec3.js     helpers are exact, allocation-fresh and NaN-safe;
//   M3  quat.js     Hamilton algebra, slerp/nlerp shortest arc, basis
//                   round trips, C¹ squad spline, three.js conjugation (real three);
//   M4  easing.js   every easing f(0)=0, f(1)=1, monotone; trapezoid and
//                   S-curve profiles land on the distance within v/a/j limits;
//   M5  spring.js   critDamp is the EXACT solution (matches fine Euler), never
//                   overshoots from rest; smoothDamp; createSecondOrder stable to dt = 1 s;
//   M6  rng.js / noise.js  deterministic per seed; noise C¹ and in [−1, 1];
//                   shake bounded per channel and time-pure;
//   M7  units.js    world ↔ local ↔ map round trips, Holtburg sanity
//                   (0xA9B4 ∋ 42.1N 33.6E), unsigned lbKey, @teleloc/@tele/@telepoi strings.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure modules.
// Run from apps/holtburger-web/: node tests/film_core_math.test.mjs

import assert from "node:assert/strict";

const E = await import("../scene3d/film/core/errors.js");
const V = await import("../scene3d/film/core/vec3.js");
const Q = await import("../scene3d/film/core/quat.js");
const Es = await import("../scene3d/film/core/easing.js");
const Sp = await import("../scene3d/film/core/spring.js");
const R = await import("../scene3d/film/core/rng.js");
const N = await import("../scene3d/film/core/noise.js");
const U = await import("../scene3d/film/core/units.js");
const G = await import("../scene3d/film/core/gimbal.js");
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

const PI = Math.PI;
const DEG = PI / 180;
function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
}
function nearV(a, b, eps, msg) {
  assert.equal(a.length, b.length, `${msg ?? "vec"} length`);
  for (let i = 0; i < a.length; i++) near(a[i], b[i], eps, `${msg ?? "vec"}[${i}] (${a} vs ${b})`);
}
/** Same rotation (q ≡ −q). */
function sameRot(a, b, eps, msg) {
  const s = Q.qDot(a, b) < 0 ? -1 : 1;
  nearV(a, b.map((x) => x * s), eps, msg);
}
const filmErr = (code) => (e) => e instanceof E.FilmError && (code === undefined || e.code === code);

// ---------------------------------------------------------------------------
console.log("M1 errors");

check("FilmError family: instanceof chain, default codes, explicit codes, details, toJSON", () => {
  const a = new E.FilmError("boom");
  assert.ok(a instanceof Error && a instanceof E.FilmError);
  assert.equal(a.code, "FILM_ERROR");
  assert.equal(a.name, "FilmError");
  const s = new E.FilmShotError("bad shot");
  assert.ok(s instanceof E.FilmError && s instanceof E.FilmShotError);
  assert.equal(s.code, "FILM_SHOT_ERROR");
  assert.equal(s.name, "FilmShotError");
  const p = new E.FilmPlanError("bad plan", { code: "PLAN_SCHEMA", details: { path: "shots[2]" } });
  assert.ok(p instanceof E.FilmError && p instanceof E.FilmPlanError);
  assert.equal(p.code, "PLAN_SCHEMA");
  assert.deepEqual(p.toJSON(), { name: "FilmPlanError", code: "PLAN_SCHEMA", message: "bad plan", details: { path: "shots[2]" } });
  assert.equal(new E.FilmShotError("x", "CUSTOM").code, "CUSTOM");
  assert.equal(new E.FilmPlanError("x").code, "FILM_PLAN_ERROR");
  const cause = new Error("root");
  assert.equal(new E.FilmError("wrapped", { cause }).cause, cause);
  assert.ok(E.isFilmError(s) && !E.isFilmError(new Error("x")));
});

check("toErrorJSON never throws: FilmError, plain Error, string, circular object", () => {
  assert.equal(E.toErrorJSON(new E.FilmShotError("x")).code, "FILM_SHOT_ERROR");
  assert.deepEqual(E.toErrorJSON(new TypeError("t")), { name: "TypeError", code: "INTERNAL_ERROR", message: "t" });
  assert.equal(E.toErrorJSON("plain").message, "plain");
  const circ = {};
  circ.self = circ;
  assert.equal(E.toErrorJSON(circ).code, "INTERNAL_ERROR");
  assert.equal(typeof E.toErrorJSON(undefined).message, "string");
});

// ---------------------------------------------------------------------------
console.log("M2 vec3");

check("arithmetic, products, lengths; inputs never mutated", () => {
  const a = [1, 2, 3], b = [-4, 5, 0.5];
  assert.deepEqual(V.v3(), [0, 0, 0]);
  assert.deepEqual(V.add(a, b), [-3, 7, 3.5]);
  assert.deepEqual(V.sub(a, b), [5, -3, 2.5]);
  assert.deepEqual(V.scale(a, 2), [2, 4, 6]);
  assert.deepEqual(V.addScaled(a, b, 2), [-7, 12, 4]);
  assert.equal(V.dot(a, b), -4 + 10 + 1.5);
  assert.deepEqual(V.cross([1, 0, 0], [0, 1, 0]), [0, 0, 1], "right-handed x × y = z");
  assert.equal(V.lenSq(a), 14);
  near(V.len(a), Math.sqrt(14), 0, "len");
  near(V.dist(a, b), Math.hypot(5, -3, 2.5), 1e-15, "dist");
  assert.deepEqual(V.lerp(a, b, 0.5), [-1.5, 3.5, 1.75]);
  assert.deepEqual(V.horiz(a), [1, 2, 0]);
  assert.deepEqual(a, [1, 2, 3]);
  assert.deepEqual(b, [-4, 5, 0.5]);
  assert.notEqual(V.clampLen(a, 100), a, "fresh array");
});

check("norm / clampLen / angleBetween / projectOnPlane / rotateZ edge cases", () => {
  assert.deepEqual(V.norm([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(V.norm([NaN, 1, 1]), [0, 0, 0]);
  nearV(V.norm([3, 0, 4]), [0.6, 0, 0.8], 1e-15, "norm");
  nearV(V.clampLen([3, 0, 4], 2.5), [1.5, 0, 2], 1e-15, "clampLen shortens");
  assert.deepEqual(V.clampLen([3, 0, 4], 10), [3, 0, 4]);
  assert.deepEqual(V.clampLen([3, 0, 4], 0), [0, 0, 0]);
  near(V.angleBetween([1, 0, 0], [0, 1, 0]), PI / 2, 1e-15, "90°");
  near(V.angleBetween([1, 0, 0], [-2, 0, 0]), PI, 1e-15, "180°");
  near(V.angleBetween([1, 0, 0], [1, 1e-9, 0]), 1e-9, 1e-20, "tiny angles stay accurate");
  assert.equal(V.angleBetween([0, 0, 0], [1, 0, 0]), 0);
  assert.deepEqual(V.projectOnPlane([1, 2, 3], [0, 0, 5]), [1, 2, 0]);
  assert.deepEqual(V.projectOnPlane([1, 2, 3], [0, 0, 0]), [1, 2, 3]);
  nearV(V.rotateZ([1, 0, 0], PI / 2), [0, 1, 0], 1e-15, "CCW about +z: east → north");
  nearV(V.rotateZ([0, 1, 7], PI / 2), [-1, 0, 7], 1e-15, "north → west, z kept");
  assert.ok(V.equalsApprox([1, 2, 3], [1 + 1e-10, 2, 3]));
  assert.ok(!V.equalsApprox([1, 2, 3], [1.1, 2, 3]));
  assert.ok(!V.equalsApprox([NaN, 0, 0], [NaN, 0, 0]));
  assert.ok(V.isFiniteV([1, 2, 3]));
  assert.ok(!V.isFiniteV([1, NaN, 3]) && !V.isFiniteV(null) && !V.isFiniteV([1, 2]));
});

// ---------------------------------------------------------------------------
console.log("M3 quat");

const rng0 = R.mulberry32(20261013);
const randQ = () => Q.qNorm([rng0() * 2 - 1, rng0() * 2 - 1, rng0() * 2 - 1, rng0() * 2 - 1]);

check("Hamilton product: identity, associativity, conj inverse, qRotate == rotation of the basis", () => {
  for (let i = 0; i < 200; i++) {
    const a = randQ(), b = randQ(), c = randQ();
    nearV(Q.qMul(Q.qIdentity(), a), a, 1e-15, "identity");
    nearV(Q.qMul(Q.qMul(a, b), c), Q.qMul(a, Q.qMul(b, c)), 1e-14, "associative");
    nearV(Q.qMul(a, Q.qConj(a)), [1, 0, 0, 0], 1e-14, "a·a* = 1");
    const v = [rng0() * 10 - 5, rng0() * 10 - 5, rng0() * 10 - 5];
    nearV(Q.qRotate(Q.qMul(a, b), v), Q.qRotate(a, Q.qRotate(b, v)), 1e-12, "apply b then a");
    const B = Q.qToBasis(a);
    nearV(Q.qRotate(a, [1, 0, 0]), B.right, 1e-14, "right");
    nearV(Q.qRotate(a, [0, 1, 0]), B.forward, 1e-14, "forward");
    nearV(Q.qRotate(a, [0, 0, 1]), B.up, 1e-14, "up");
    sameRot(Q.qFromBasis(B.right, B.forward, B.up), a, 1e-12, "qFromBasis(qToBasis(q)) ≡ q");
  }
  nearV(Q.qRotate(Q.qFromAxisAngle([0, 0, 2], PI / 2), [1, 0, 0]), [0, 1, 0], 1e-15, "Rz(90°) x → y");
  assert.deepEqual(Q.qFromAxisAngle([0, 0, 0], 1), [1, 0, 0, 0]);
  assert.deepEqual(Q.qNorm([0, 0, 0, 0]), [1, 0, 0, 0]);
  assert.deepEqual(Q.qNorm([NaN, 0, 0, 0]), [1, 0, 0, 0]);
});

check("slerp/nlerp: endpoints, constant angular speed, shortest arc, nearly-parallel fallback", () => {
  const a = Q.qFromAxisAngle([0, 0, 1], 0.2);
  const b = Q.qFromAxisAngle([0, 0, 1], 2.2);
  sameRot(Q.qSlerp(a, b, 0), a, 1e-15, "t=0");
  sameRot(Q.qSlerp(a, b, 1), b, 1e-12, "t=1");
  for (let k = 0; k <= 10; k++) near(Q.qAngle(a, Q.qSlerp(a, b, k / 10)), 0.2 * k, 1e-12, "uniform speed");
  const negB = b.map((x) => -x);
  near(Q.qAngle(a, Q.qSlerp(a, negB, 0.5)), 1.0, 1e-12, "−b is the same rotation: still the short way");
  const c = Q.qFromAxisAngle([1, 0, 0], 1e-5);
  const m = Q.qSlerp([1, 0, 0, 0], c, 0.5);
  near(Q.qAngle([1, 0, 0, 0], m), 0.5e-5, 1e-12, "nlerp fallback");
  near(Math.hypot(...Q.qNlerp(a, b, 0.3)), 1, 1e-15, "nlerp unit");
  near(Q.qAngle(a, b), 2.0, 1e-12, "qAngle");
  near(Q.qAngle(a, negB), 2.0, 1e-12, "qAngle sign-invariant");
  const prev = [0.9, 0.1, 0, 0.1];
  assert.ok(Q.qDot(prev, Q.qEnsureContinuity(prev, negB)) >= 0, "continuity flips sign");
});

check("qSpline: hits every key at u = i/(n−1), C¹ (angular velocity continuous at interior keys)", () => {
  const keys = [];
  for (let i = 0; i < 6; i++) keys.push(G.quatFromHPR(i * 0.7, Math.sin(i) * 0.6, (i % 2) * 0.3));
  for (let i = 0; i < keys.length; i++) sameRot(Q.qSpline(keys, i / 5), keys[i], 1e-12, `key ${i}`);
  const omega = (u, h) => {
    const d = Q.qMul(Q.qConj(Q.qSpline(keys, u)), Q.qSpline(keys, u + h));
    const s = d[0] < 0 ? -1 : 1;
    return [2 * s * d[1] / h, 2 * s * d[2] / h, 2 * s * d[3] / h];
  };
  for (let i = 1; i < 5; i++) {
    const u = i / 5, h = 1e-6;
    const left = omega(u - h, h), right = omega(u, h);
    nearV(left, right, 1e-3 * Math.max(1, V.len(left)), `ω continuous at key ${i}`);
  }
  assert.deepEqual(Q.qSpline([], 0.5), [1, 0, 0, 0]);
  sameRot(Q.qSpline([keys[2]], 0.9), keys[2], 1e-15, "one key");
  sameRot(Q.qSpline([keys[0], keys[1]], 0.5), Q.qSlerp(keys[0], keys[1], 0.5), 1e-12, "two keys = slerp");
});

check("qToThree is qM ⊗ q ⊗ qM⁻¹ (real three); qFromThree inverts; qFromTo; qLog/qExp", () => {
  const qM = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -PI / 2);
  for (let i = 0; i < 100; i++) {
    const q = randQ();
    const t = qM.clone().multiply(new THREE.Quaternion(q[1], q[2], q[3], q[0])).multiply(qM.clone().invert());
    sameRot(Q.qToThree(q).slice(), [t.x, t.y, t.z, t.w], 1e-12, "conjugation");
    sameRot(Q.qFromThree(Q.qToThree(q)), q, 1e-15, "round trip");
    sameRot(Q.qFromThree({ x: t.x, y: t.y, z: t.z, w: t.w }), q, 1e-12, "object form");
    sameRot(Q.qExp(Q.qLog(q)), q, 1e-12, "exp(log q)");
    const a = V.norm([rng0() - 0.5, rng0() - 0.5, rng0() - 0.5]), b = V.norm([rng0() - 0.5, rng0() - 0.5, rng0() - 0.5]);
    nearV(Q.qRotate(Q.qFromTo(a, b), a), b, 1e-12, "qFromTo maps a → b");
  }
  nearV(Q.qRotate(Q.qFromTo([0, 0, 1], [0, 0, -1]), [0, 0, 1]), [0, 0, -1], 1e-12, "antiparallel");
});

// ---------------------------------------------------------------------------
console.log("M4 easing and motion profiles");

check("every easing: f(0)=0, f(1)=1 exactly, monotone on 2001 samples, clamped outside [0,1]", () => {
  const required = ["linear", "sineIn", "sineOut", "sineInOut", "quadIn", "quadOut", "quadInOut", "cubicIn", "cubicOut",
    "cubicInOut", "quintInOut", "expoInOut", "smoothstep", "smootherstep"];
  for (const name of required) assert.equal(typeof Es.EASINGS[name], "function", `EASINGS.${name}`);
  for (const [name, f] of Object.entries(Es.EASINGS)) {
    assert.equal(f(0), 0, `${name}(0)`);
    assert.equal(f(1), 1, `${name}(1)`);
    assert.equal(f(-3), 0, `${name}(−3)`);
    assert.equal(f(7), 1, `${name}(7)`);
    assert.equal(f(NaN), 0, `${name}(NaN)`);
    let prev = 0;
    for (let k = 1; k <= 2000; k++) {
      const y = f(k / 2000);
      assert.ok(y >= prev - 1e-15, `${name} monotone at ${k / 2000}: ${y} < ${prev}`);
      prev = y;
    }
  }
  near(Es.minJerk(0.5), 0.5, 1e-15, "minJerk symmetric");
  near(Es.expoInOut(1e-9), 0, 1e-6, "expo continuous at 0");
});

check("ease(name) resolves names/functions, throws FilmError UNKNOWN_EASING; holdEase holds", () => {
  assert.equal(Es.ease("cubicInOut"), Es.cubicInOut);
  const f = (t) => t;
  assert.equal(Es.ease(f), f);
  assert.equal(Es.ease(undefined), Es.linear);
  assert.throws(() => Es.ease("bouncy"), filmErr("UNKNOWN_EASING"));
  assert.throws(() => Es.ease("toString"), filmErr("UNKNOWN_EASING"));
  assert.equal(Es.holdEase(0.1, 0.2, 0.2), 0);
  assert.equal(Es.holdEase(0.9, 0.2, 0.2), 1);
  near(Es.holdEase(0.5, 0.2, 0.2), 0.5, 1e-15, "symmetric middle");
  assert.equal(Es.holdEase(0, 0.2, 0.2, "quadIn"), 0);
  assert.equal(Es.holdEase(1, 0.2, 0.2, "quadIn"), 1);
  let prev = 0;
  for (let k = 0; k <= 1000; k++) {
    const y = Es.holdEase(k / 1000, 0.3, 0.1, "cubicInOut");
    assert.ok(y >= prev - 1e-15, "holdEase monotone");
    prev = y;
  }
});

/** Numerically verify a {duration, s} profile: lands exactly, v ≤ vmax, |a| ≤ amax (and jerk when given). */
function verifyProfile(p, D, vmax, amax, jmax, label) {
  near(p.s(0), 0, 0, `${label} s(0)`);
  near(p.s(p.duration), D, 1e-9 * Math.max(1, Math.abs(D)), `${label} s(T)`);
  near(p.s(p.duration + 10), D, 0, `${label} clamped after the end`);
  const n = 4000, h = p.duration / n;
  let prevV = 0, prevA = 0;
  for (let k = 1; k <= n; k++) {
    const t = k * h;
    const v = (p.s(t) - p.s(t - h)) / h;
    assert.ok(Math.abs(v) <= vmax * (1 + 1e-6) + 1e-9, `${label} |v| ${v} > ${vmax}`);
    if (k > 1) {
      const a = (v - prevV) / h;
      assert.ok(Math.abs(a) <= amax * 1.02 + 1e-6, `${label} |a| ${a} > ${amax} at t=${t}`);
      if (jmax && Number.isFinite(jmax) && k > 2) {
        assert.ok(Math.abs(a - prevA) / h <= jmax * 1.05 + 1e-3, `${label} |j| > ${jmax}`);
      }
      prevA = a;
    }
    prevV = v;
  }
}

check("trapezoidProfile: trapezoid + triangular + backwards cases land on the distance within limits", () => {
  for (const [D, vmax, amax] of [[100, 10, 2], [10, 10, 2], [0.5, 3, 1], [-40, 5, 2.5]]) {
    const p = Es.trapezoidProfile(D, vmax, amax);
    verifyProfile(p, D, vmax, amax, null, `trap(${D},${vmax},${amax})`);
  }
  near(Es.trapezoidProfile(100, 10, 2).duration, 15, 1e-12, "10/2·2 + 50/10");
  near(Es.trapezoidProfile(10, 10, 2).duration, 2 * Math.sqrt(10 / 2), 1e-12, "triangular");
  assert.equal(Es.trapezoidProfile(0, 1, 1).duration, 0);
  assert.throws(() => Es.trapezoidProfile(10, 0, 1), filmErr("BAD_ARGUMENT"));
  assert.throws(() => Es.trapezoidProfile(NaN, 1, 1), filmErr("BAD_ARGUMENT"));
});

check("sCurveProfile: jerk-limited 7-phase (all regimes) within v/a/j limits; jmax=∞ equals the trapezoid", () => {
  for (const [D, vmax, amax, jmax] of [[100, 10, 2, 4], [100, 10, 2, 100], [6, 10, 2, 4], [0.3, 10, 2, 4], [-25, 4, 3, 10]]) {
    const p = Es.sCurveProfile(D, vmax, amax, jmax);
    verifyProfile(p, D, vmax, amax, jmax, `scurve(${D},${vmax},${amax},${jmax})`);
    near(p.v(p.duration), 0, 1e-9, "ends at rest");
  }
  near(Es.sCurveProfile(100, 10, 2, Infinity).duration, Es.trapezoidProfile(100, 10, 2).duration, 1e-9, "∞ jerk");
  assert.ok(Es.sCurveProfile(100, 10, 2, 4).duration > Es.trapezoidProfile(100, 10, 2).duration, "jerk limit costs time");
  assert.throws(() => Es.sCurveProfile(10, 1, 1, 0), filmErr("BAD_ARGUMENT"));
});

// ---------------------------------------------------------------------------
console.log("M5 springs");

check("critDamp is the exact solution: matches fine Euler integration and composes over split steps", () => {
  for (const [x0, v0, target, omega] of [[0, 0, 10, 8], [5, -3, -2, 2.5], [100, 40, 100, 12]]) {
    let x = x0, v = v0;
    const h = 1e-5;
    for (let k = 0; k < 1 / h; k++) {
      const a = -2 * omega * v - omega * omega * (x - target);
      v += a * h;
      x += v * h;
    }
    const ex = Sp.critDamp(x0, v0, target, omega, 1);
    near(ex.x, x, 2e-3 * Math.max(1, Math.abs(x0 - target)), "x vs Euler");
    near(ex.v, v, 2e-3 * Math.max(1, Math.abs(v0) + omega * Math.abs(x0 - target)), "v vs Euler");
    let s = { x: x0, v: v0 };
    for (let k = 0; k < 10; k++) s = Sp.critDamp(s.x, s.v, target, omega, 0.1);
    near(s.x, ex.x, 1e-12, "10×0.1 s == 1×1 s (frame-rate independent)");
    near(s.v, ex.v, 1e-12, "velocity too");
  }
});

check("critDamp from rest never overshoots (any dt mix); robust to NaN / dt ≤ 0 / huge ω·dt", () => {
  const rng = R.mulberry32(11);
  let s = { x: 50, v: 0 };
  let prev = s.x;
  for (let k = 0; k < 500; k++) {
    s = Sp.critDamp(s.x, s.v, 0, 3, rng() * 0.2);
    assert.ok(s.x >= 0 && s.x <= prev + 1e-12, `monotone, no overshoot: ${s.x}`);
    prev = s.x;
  }
  assert.deepEqual(Sp.critDamp(1, 2, 5, 3, 0), { x: 1, v: 2 });
  assert.deepEqual(Sp.critDamp(1, 2, 5, 3, NaN), { x: 1, v: 2 });
  assert.deepEqual(Sp.critDamp(NaN, NaN, 5, 3, 0.1).x >= 0, true);
  assert.deepEqual(Sp.critDamp(1, 2, 5, 1e6, 1), { x: 5, v: 0 });
  const v3 = Sp.critDampV3([0, 0, 0], null, [1, 2, 3], 4, 0.5);
  for (let i = 0; i < 3; i++) near(v3.x[i], Sp.critDamp(0, 0, [1, 2, 3][i], 4, 0.5).x, 1e-15, "V3 per component");
});

check("critDampAngle takes the short way across ±π and stays continuous (no re-wrap)", () => {
  let s = { x: 3.0, v: 0 };
  for (let k = 0; k < 200; k++) s = Sp.critDampAngle(s.x, s.v, -3.0, 6, 1 / 30);
  near(s.x, 2 * PI - 3.0, 1e-6, "converged to −3.0 + 2π (short way through π)");
  assert.ok(s.x > 3.0, "moved up through π, not down through 0");
});

check("smoothDamp: reaches the target without overshoot, honours maxSpeed; V3 variant", () => {
  let cur = 0, vel = 0;
  let maxStep = 0;
  for (let k = 0; k < 600; k++) {
    const r = Sp.smoothDamp(cur, 10, vel, 0.3, 5, 1 / 60);
    assert.ok(r.value <= 10 + 1e-12, "no overshoot");
    maxStep = Math.max(maxStep, (r.value - cur) * 60);
    cur = r.value;
    vel = r.vel;
  }
  near(cur, 10, 1e-6, "reached");
  assert.ok(maxStep <= 5 * 1.05, `speed cap ${maxStep}`);
  let c3 = [0, 0, 0], v3 = [0, 0, 0];
  for (let k = 0; k < 600; k++) {
    const r = Sp.smoothDampV3(c3, [3, -4, 12], v3, 0.25, Infinity, 1 / 60);
    c3 = r.value;
    v3 = r.vel;
  }
  nearV(c3, [3, -4, 12], 1e-6, "V3 reached");
});

check("createSecondOrder: stable for dt up to 1 s for many (f, ζ, r); critical/no-overshoot at ζ=1, r=0", () => {
  for (const f of [0.5, 2, 8]) for (const zeta of [0, 0.3, 1, 2]) for (const r of [-1, 0, 1, 2]) {
    const so = Sp.createSecondOrder({ f, zeta, r, dim: 1 });
    so.reset(0);
    let y = 0;
    for (let k = 0; k < 20; k++) {
      y = so.update(1, 1.0);
      assert.ok(Number.isFinite(y) && Math.abs(y) < 50, `f=${f} ζ=${zeta} r=${r}: y=${y} at step ${k}`);
    }
    if (zeta > 0) near(y, 1, zeta >= 0.3 ? 0.05 : 0.5, `settles f=${f} ζ=${zeta} r=${r}`);
  }
  const so = Sp.createSecondOrder({ f: 1.5, zeta: 1, r: 0 });
  so.reset([0, 0, 0]);
  let out;
  for (let k = 0; k < 300; k++) {
    out = so.update([2, -2, 5], 1 / 60);
    assert.ok(out[0] <= 2 + 1e-9 && out[1] >= -2 - 1e-9 && out[2] <= 5 + 1e-9, "no overshoot");
  }
  nearV(out, [2, -2, 5], 1e-3, "settled");
  assert.equal(so.value().length, 3);
  assert.throws(() => Sp.createSecondOrder({ f: 0 }), filmErr("BAD_ARGUMENT"));
  assert.throws(() => Sp.createSecondOrder({ dim: 0 }), filmErr("BAD_ARGUMENT"));
});

// ---------------------------------------------------------------------------
console.log("M6 rng and noise");

check("mulberry32 / hashString: deterministic per seed, [0,1), seeds of any type", () => {
  const a = R.mulberry32(42), b = R.mulberry32(42), c = R.mulberry32(43);
  const sa = [], sb = [], sc = [];
  for (let i = 0; i < 1000; i++) {
    sa.push(a());
    sb.push(b());
    sc.push(c());
  }
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  for (const x of sa) assert.ok(x >= 0 && x < 1);
  const mean = sa.reduce((s, x) => s + x, 0) / sa.length;
  near(mean, 0.5, 0.05, "roughly uniform");
  assert.equal(R.hashString("holtburg"), R.hashString("holtburg"));
  assert.notEqual(R.hashString("holtburg"), R.hashString("holtburh"));
  const h = R.hashString("x");
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
  assert.deepEqual([R.mulberry32("seed")(), R.mulberry32("seed")()], [R.mulberry32("seed")(), R.mulberry32("seed")()]);
  assert.equal(R.seedOf(-1), 0xffffffff);
  assert.equal(R.seedOf(undefined), 0);
  assert.notEqual(R.deriveSeed(1, "h"), R.deriveSeed(1, "p"));
});

check("rngRange / rngPick / rngInt", () => {
  const rng = R.mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const x = R.rngRange(rng, -3, 5);
    assert.ok(x >= -3 && x < 5);
    const k = R.rngInt(rng, 2, 4);
    assert.ok([2, 3, 4].includes(k));
  }
  const arr = ["a", "b", "c"];
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(R.rngPick(rng, arr));
  assert.equal(seen.size, 3);
  assert.equal(R.rngPick(rng, []), undefined);
  assert.equal(R.rngPick(rng, null), undefined);
});

check("createNoise1D: deterministic, in [−1, 1], 0 at integers, C¹ across lattice points, seeds differ", () => {
  const n1 = N.createNoise1D(5), n1b = N.createNoise1D(5), n2 = N.createNoise1D(6);
  let diff = 0, maxAbs = 0;
  for (let k = -2000; k <= 2000; k++) {
    const t = k * 0.0137;
    const v = n1(t);
    assert.equal(v, n1b(t), "deterministic");
    assert.ok(v >= -1 && v <= 1, `range ${v}`);
    maxAbs = Math.max(maxAbs, Math.abs(v));
    diff += Math.abs(v - n2(t));
  }
  assert.ok(maxAbs > 0.2, `non-trivial amplitude ${maxAbs}`);
  assert.ok(diff > 10, "different seeds give different noise");
  for (let i = -5; i <= 5; i++) {
    near(n1(i), 0, 0, `0 at integer ${i}`);
    const h = 1e-6;
    const left = (n1(i) - n1(i - h)) / h, right = (n1(i + h) - n1(i)) / h;
    near(left, right, 1e-4, `C¹ at ${i}`);
  }
  assert.equal(n1(NaN), 0);
  assert.equal(N.createNoise1D("film")(3.3), N.createNoise1D("film")(3.3));
  near(N.createNoise1D(1)(1e12 + 0.5), N.createNoise1D(1)(1e12 + 0.5), 0, "huge t deterministic");
});

check("fbm1D stays in [−1, 1] and is deterministic; octave/gain options respected", () => {
  const n = N.createNoise1D(99);
  for (let k = 0; k < 3000; k++) {
    const t = k * 0.031;
    const v = N.fbm1D(n, t, { octaves: 5, lacunarity: 2, gain: 0.9 });
    assert.ok(v >= -1 && v <= 1);
    assert.equal(v, N.fbm1D(n, t, { octaves: 5, lacunarity: 2, gain: 0.9 }));
  }
  near(N.fbm1D(n, 1.7, { octaves: 1 }), n(1.7), 1e-15, "one octave = base noise");
  assert.equal(N.fbm1D(n, NaN), 0);
});

check("createShake: bounded per channel, time-pure, seed-deterministic, smooth at 30 fps", () => {
  const opts = { seed: "take-7", amplitudeDeg: 0.6, frequencyHz: 1.2, posAmplitude: 0.03, roughness: 0.5 };
  const sh = N.createShake(opts), sh2 = N.createShake(opts), other = N.createShake({ ...opts, seed: "take-8" });
  const amp = 0.6 * DEG;
  let prev = null, maxStep = 0, peak = 0, diff = 0;
  for (let k = 0; k < 30 * 120; k++) {
    const t = k / 30;
    const s = sh(t);
    assert.ok(Math.abs(s.dh) <= amp && Math.abs(s.dp) <= amp, "|dh|,|dp| ≤ amplitude");
    assert.ok(Math.abs(s.dr) <= 0.5 * amp, "|dr| ≤ rollScale·amplitude");
    for (const c of s.dpos) assert.ok(Math.abs(c) <= 0.03, "|dpos| ≤ posAmplitude");
    assert.deepEqual(s, sh2(t), "same seed → same shake");
    peak = Math.max(peak, Math.abs(s.dh));
    diff += Math.abs(s.dh - other(t).dh);
    if (prev) maxStep = Math.max(maxStep, Math.abs(s.dh - prev.dh));
    prev = s;
  }
  assert.ok(peak > 0.2 * amp, `shake is visible (${peak / DEG}°)`);
  assert.ok(maxStep < 0.25 * amp, `smooth frame-to-frame (${maxStep / DEG}°)`);
  assert.ok(diff > 0, "different seeds differ");
  assert.deepEqual(sh(12.34), sh(12.34), "random access");
  assert.deepEqual(sh(NaN), { dh: 0, dp: 0, dr: 0, dpos: [0, 0, 0] });
  const still = N.createShake({ seed: 1, amplitudeDeg: 0, posAmplitude: 0 })(3.7);
  assert.equal(Math.abs(still.dh) + Math.abs(still.dp) + Math.abs(still.dr), 0);
});

// ---------------------------------------------------------------------------
console.log("M7 units");

check("lbKeyOf is ALWAYS unsigned (x byte ≥ 0x80), accepts int32 and hex strings; bad ids throw", () => {
  assert.equal(U.lbKeyOf(0xa9b4001c), 0xa9b40000);
  assert.ok(U.lbKeyOf(0xa9b4001c) > 0, "positive");
  assert.equal(U.lbKeyOf(0xa9b4001c | 0), 0xa9b40000, "negative int32 view reinterpreted");
  assert.equal(U.lbKeyOf(0xff010123), 0xff010000);
  assert.equal(U.lbKeyOf("0xA9B4001C"), 0xa9b40000);
  assert.equal(U.lbKeyOf("a9b4001c"), 0xa9b40000);
  assert.equal(U.lbKeyFromWord(0xa9b4), 0xa9b40000);
  assert.throws(() => U.lbKeyOf(1.5), filmErr("BAD_CELL_ID"));
  assert.throws(() => U.lbKeyOf("zz"), filmErr("BAD_CELL_ID"));
  assert.throws(() => U.lbKeyOf(2 ** 32), filmErr("BAD_CELL_ID"));
  assert.throws(() => U.lbKeyFromWord(0x10000), filmErr("BAD_CELL_ID"));
  const xy = U.lbXY(0xa9b4001c);
  assert.deepEqual([...xy], [0xa9, 0xb4]);
  assert.equal(xy.x, 0xa9);
  assert.equal(xy.y, 0xb4);
  assert.equal(U.LB_SIZE, 192);
  assert.equal(U.CELL_SIZE, 24);
});

check("isIndoorCell: EnvCells 0x0100..0xFFFD; land cells and the 0xFFFE/0xFFFF sentinels are not", () => {
  assert.equal(U.isIndoorCell(0xa9b40100), true);
  assert.equal(U.isIndoorCell(0x01d90213), true);
  assert.equal(U.isIndoorCell(0xa9b4001c), false);
  assert.equal(U.isIndoorCell(0xa9b40040), false);
  assert.equal(U.isIndoorCell(0xa9b4ffff), false);
  assert.equal(U.isIndoorCell(0xa9b4fffe), false);
});

check("world ↔ local ↔ map round trips (random points across the map, incl. x ≥ 0x80)", () => {
  const rng = R.mulberry32(192);
  for (let i = 0; i < 2000; i++) {
    const wx = rng() * 255 * 192, wy = rng() * 255 * 192, z = rng() * 300 - 50;
    const loc = U.localFromWorld(wx, wy, z);
    assert.ok(loc.lbKey >= 0 && loc.cellId >= 0, "unsigned");
    assert.equal(loc.lbKey, U.lbKeyOf(loc.cellId));
    assert.equal(U.landblockOfWorld(wx, wy), loc.lbKey);
    assert.ok(loc.lx >= 0 && loc.lx < 192 && loc.ly >= 0 && loc.ly < 192, "local in the square");
    const lo = loc.cellId & 0xffff;
    assert.equal(lo, 1 + Math.floor(loc.lx / 24) * 8 + Math.floor(loc.ly / 24), "outdoor cell index");
    assert.equal(U.isIndoorCell(loc.cellId), false);
    nearV(U.worldFromLocal(loc.cellId, loc.lx, loc.ly, loc.z), [wx, wy, z], 1e-9, "world ← local");
    nearV(U.worldFromLocal(loc.lbKey, loc.lx, loc.ly, loc.z), [wx, wy, z], 1e-9, "lbKey works too");
    const m = U.worldToMap(wx, wy);
    nearV(U.mapToWorld(m.ns, m.ew), [wx, wy], 1e-9, "world ← map");
  }
  nearV(U.worldFromLocal(0xa9b40100, -40, 250, 12), [169 * 192 - 40, 180 * 192 + 250, 12], 0,
    "dungeon cells may sit outside their landblock square — the LB comes from the id");
  assert.throws(() => U.localFromWorld(NaN, 0), filmErr("BAD_ARGUMENT"));
});

check("Holtburg sanity: landblock 0xA9B4 contains map 42.1N 33.6E; LB origin maps to 0.8·lb − 101.95", () => {
  const [wx, wy] = U.mapToWorld(42.1, 33.6);
  assert.equal(U.landblockOfWorld(wx, wy), 0xa9b40000);
  assert.equal(U.lbKeyOf(U.localFromWorld(wx, wy).cellId), 0xa9b40000);
  const o = U.worldFromLocal(0xa9b40000, 0, 0, 0);
  const m = U.worldToMap(o[0], o[1]);
  near(m.ew, 0.8 * 0xa9 - 101.95, 1e-9, "ew of LB origin");
  near(m.ns, 0.8 * 0xb4 - 101.95, 1e-9, "ns of LB origin");
  const c = U.worldToMap(169 * 192 + 96, 180 * 192 + 96);
  assert.ok(c.ns > 42.1 && c.ns < 42.9 && c.ew > 33.2 && c.ew < 34.1, `centre ${c.ns}N ${c.ew}E`);
  assert.equal(U.formatMap(42.1, 33.6), "42.1N, 33.6E");
  assert.equal(U.formatMap(-12.34, -56.78), "12.3S, 56.8W");
  assert.equal(U.formatMap(-0.01, 0.01), "0.0N, 0.0E");
  assert.equal(U.formatMap(42.123, 33.456, 2), "42.12N, 33.46E");
});

check("hex32 / headingQuat (qw = cos θ/2, qz = −sin θ/2, qw ≥ 0) agrees with the camera gimbal", () => {
  assert.equal(U.hex32(0xa9b4001c), "0xA9B4001C");
  assert.equal(U.hex32(0xa9b4001c | 0), "0xA9B4001C");
  assert.equal(U.hex32(0x1c), "0x0000001C");
  assert.equal(U.hex32(-1), "0xFFFFFFFF");
  assert.deepEqual(U.headingQuat(0), { qw: 1, qx: 0, qy: 0, qz: 0 });
  const q90 = U.headingQuat(PI / 2);
  near(q90.qw, Math.cos(PI / 4), 1e-15, "qw");
  near(q90.qz, -Math.sin(PI / 4), 1e-15, "qz");
  for (const th of [-3, -1, 0.3, 2, 3.1, 4.5, 9]) {
    const hq = U.headingQuat(th);
    assert.ok(hq.qw >= 0, "canonical hemisphere");
    sameRot([hq.qw, hq.qx, hq.qy, hq.qz], G.quatFromHPR(th, 0, 0), 1e-12, `same as quatFromHPR(${th}, 0, 0)`);
    // the character faces compass heading θ: its local +y maps to (sin θ, cos θ, 0)
    nearV(Q.qRotate([hq.qw, hq.qx, hq.qy, hq.qz], [0, 1, 0]), [Math.sin(th), Math.cos(th), 0], 1e-12, "faces θ");
  }
  assert.deepEqual(U.headingQuat(NaN), { qw: 1, qx: 0, qy: 0, qz: 0 });
});

check("telelocCmd: fixed decimals (xyz 2, quat 4), unsigned hex cell, outdoor cell canonicalised", () => {
  assert.equal(U.telelocCmd(0xa9b4001d, 84, 112, 66), "@teleloc 0xA9B4001D 84.00 112.00 66.00 1.0000 0.0000 0.0000 0.0000");
  assert.equal(U.telelocCmd(0xa9b4001c, 84, 112, 66), "@teleloc 0xA9B4001D 84.00 112.00 66.00 1.0000 0.0000 0.0000 0.0000",
    "(84, 112) is outdoor cell 1 + 3·8 + 4 = 0x1D, whatever the id said");
  assert.equal(U.telelocCmd(0xa9b40000, 84, 112, 66), "@teleloc 0xA9B4001D 84.00 112.00 66.00 1.0000 0.0000 0.0000 0.0000",
    "spawn-row cell 0 fixed");
  assert.equal(U.telelocCmd("0xA9B40001", 84.456, 112.004, 66.5, PI / 2),
    "@teleloc 0xA9B4001D 84.46 112.00 66.50 0.7071 0.0000 0.0000 -0.7071");
  assert.equal(U.telelocCmd(0xa9b4001d, 200, 10, 50), "@teleloc 0xAAB40001 8.00 10.00 50.00 1.0000 0.0000 0.0000 0.0000",
    "outside the square → re-homed to the containing landblock");
  assert.equal(U.telelocCmd(0x01d90213, -12.5, 230.25, -6, PI),
    "@teleloc 0x01D90213 -12.50 230.25 -6.00 0.0000 0.0000 0.0000 -1.0000", "EnvCells pass through unchanged");
  assert.ok(!U.telelocCmd(0xa9b4001d, 1e-9, -0, 0, -1e-12).includes("-0.0"), "no negative zeros");
  const cmd = U.telelocCmd(0xc6a90009, 10, 20, 30, 0.5);
  assert.ok(cmd.startsWith("@teleloc 0xC6A90001 10.00 20.00 30.00 "), `x byte ≥ 0x80 stays unsigned (cell 1 for 10,20): ${cmd}`);
  assert.equal(U.telelocCmd(0xc6a90109, 10, 20, 30).split(" ")[1], "0xC6A90109", "indoor id with x ≥ 0x80 unsigned");
  assert.throws(() => U.telelocCmd(0xa9b4001d, NaN, 1, 1), filmErr("BAD_ARGUMENT"));
});

check("teleMapCmd (NS first, 2 decimals, S/W for negatives) and telepoiCmd (sanitised)", () => {
  assert.equal(U.teleMapCmd(42.1, 33.6), "@tele 42.10N 33.60E");
  assert.equal(U.teleMapCmd(-5.25, -71.5), "@tele 5.25S 71.50W");
  assert.equal(U.teleMapCmd(-0.001, 0), "@tele 0.00N 0.00E");
  assert.equal(U.telepoiCmd("  Holtburg \t "), "@telepoi Holtburg");
  assert.equal(U.telepoiCmd("Town  Network"), "@telepoi Town Network");
  assert.throws(() => U.telepoiCmd("Holtburg\n@ban everyone"), filmErr("BAD_COMMAND"));
  assert.throws(() => U.telepoiCmd("   "), filmErr("BAD_COMMAND"));
  assert.throws(() => U.telepoiCmd(42), filmErr("BAD_COMMAND"));
});

console.log(`film_core_math: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
