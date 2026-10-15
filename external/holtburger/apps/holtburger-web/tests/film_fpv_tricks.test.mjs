// tests/film_fpv_tricks.test.mjs
//
// WHY: fpv.fpv-run splices FPV tricks (float, roll, yaw-spin, power-loop,
// split-s, dive, dip) into a long racing-line run. The take player flies the
// nominal through the fpv flight model (vmax 25, amax 15, jmax 60) and the JEV
// pilot is frozen inside trick windows, so a trick is only as good as its
// nominal: a kink at a join, a jerk beyond the craft, a fake "free fall" or a
// quaternion jump all show up as a trailing craft or a visible pop. This suite
// EXECUTES scene3d/film/shots/fpv_tricks.js (and the run through the real
// registry) and proves:
//   K1  primitives: integratePhases is exact (cubic) and continuous; planFloat
//       reaches EXACTLY the requested apex, lands back on the line with zero
//       velocity and acceleration, its free-fall phase is a = −g, apex =
//       z(chop end) + v²/(2g) (ballistic closed form), every phase's jerk is the
//       trick jerk; hangSec fixes the free-fall time; a too-small rise is raised;
//       bumpC2 is C² with peak 1; loopShape turns exactly ±2π / −π, closes its
//       height, drifts forward (loop) / drops ≈ 2R (half loop), and its
//       curvature ramp is flyable (jerk ≤ trickJerk at the design speed);
//       quinticHermite meets its six boundary conditions;
//   K2  every trick in a synthetic run: present in meta.tricks with its window,
//       C² joins (Δa across t0 / t1 ≪ a real kink), the float's free fall
//       a_z = −g within 0.3 m/s² and apex = rise above the line (closed form) with
//       net Δz = 0, roll / yaw-spin / loop / split-s rotate by their full angle,
//       quaternions continuous frame to frame, deterministic table checksum;
//   K3  flyable: flyTrajectory(traj, 'fpv') maxTrackingErrorM ≤ 0.6 m and the
//       nominal's jerk ≤ 60 m/s³ everywhere (free-fall onsets included — the chop
//       is a jerk-limited ramp), validate ok with meta.validate.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure shot modules.
// Run from apps/holtburger-web/: node tests/film_fpv_tricks.test.mjs

import assert from "node:assert/strict";

const FT = await import("../scene3d/film/shots/fpv_tricks.js");
const SH = await import("../scene3d/film/shots/index.js");
const DR = await import("../scene3d/film/shots/drone.js");
const TR = await import("../scene3d/film/shots/trajectory.js");
const FL = await import("../scene3d/film/drone/flight_model.js");
const Q = await import("../scene3d/film/core/quat.js");

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

const G = FT.GRAVITY;
const DEG = Math.PI / 180;
const J = FT.FPV_RUN_CONSTANTS.trickJerk;

/** Second derivative of a scalar function by central differences. */
const d2 = (f, t, h = 1e-3) => (f(t + h) - 2 * f(t) + f(t - h)) / (h * h);
const d1 = (f, t, h = 1e-4) => (f(t + h) - f(t - h)) / (2 * h);
/** Vector acceleration of a trajectory at t (central differences, step h). */
function accel(tr, t, h = 0.002) {
  const a = tr.sample(t - h).pos, b = tr.sample(t).pos, c = tr.sample(t + h).pos;
  return [0, 1, 2].map((k) => (a[k] - 2 * b[k] + c[k]) / (h * h));
}
/** Largest |jerk| of the nominal (4-point third difference at step h) over [t0, t1]. */
function maxJerk(tr, t0, t1, h = 1 / 60) {
  let m = 0, at = 0;
  const p = (x) => tr.sample(x).pos;
  for (let t = Math.max(t0, 2 * h); t <= Math.min(t1, tr.duration - 2 * h); t += h / 2) {
    const a = p(t + 2 * h), b = p(t + h), c = p(t - h), d = p(t - 2 * h);
    const j = Math.hypot(...[0, 1, 2].map((k) => (a[k] - 2 * b[k] + 2 * c[k] - d[k]) / (2 * h ** 3)));
    if (j > m) { m = j; at = t; }
  }
  return { max: m, at };
}

// ---------------------------------------------------------------------------
console.log("K1 primitives");
// ---------------------------------------------------------------------------
check("integratePhases: exact cubic segments, continuous z / v / a across phase boundaries", () => {
  const ph = FT.integratePhases([{ dur: 0.4, a0: 0, a1: 6 }, { dur: 0.5, a0: 6, a1: 6 }, { dur: 0.3, a0: 6, a1: -3 }], 1.5, 2);
  near(ph.T, 1.2, 1e-12, "T");
  // closed form at the end of phase 1: z = z0 + v0 t + j t³/6, v = v0 + j t²/2 (j = 15)
  const e1 = ph.at(0.4);
  near(e1.z, 2 + 1.5 * 0.4 + (15 * 0.4 ** 3) / 6, 1e-12, "z after ramp");
  near(e1.v, 1.5 + (15 * 0.4 ** 2) / 2, 1e-12, "v after ramp");
  for (const tb of [0.4, 0.9]) {
    const a = ph.at(tb - 1e-9), b = ph.at(tb + 1e-9);
    near(a.z, b.z, 1e-7, "z continuous");
    near(a.v, b.v, 1e-7, "v continuous");
    near(a.a, b.a, 1e-6, "a continuous");
  }
  near(ph.at(1.2).z, ph.zEnd, 1e-12, "zEnd");
  near(ph.at(99).v, ph.vEnd, 1e-12, "τ clamps");
});

check("planFloat: exact apex, true free fall (a = −g), ballistic closed form, C² landing, jerk-limited phases", () => {
  for (const rise of [0.8, 2.6, 6, 14]) {
    const f = FT.planFloat({ rise, punchAccel: 8, catchAccel: 12 });
    near(f.apex, rise, 1e-6, `apex for rise ${rise}`);
    near(f.zEnd, 0, 1e-6, "lands back on the line");
    near(f.vEnd, 0, 1e-6, "zero vertical speed at the end");
    near(f.at(f.T).a, 0, 1e-9, "zero acceleration at the end");
    near(f.at(0).a, 0, 1e-12, "zero acceleration at the start");
    // the max height over the whole float is the apex, reached at tApex
    let zMax = -Infinity, tMax = 0;
    for (let t = 0; t <= f.T; t += f.T / 4000) { const z = f.at(t).z; if (z > zMax) { zMax = z; tMax = t; } }
    near(zMax, rise, 1e-4, "sampled max = apex");
    near(tMax, f.tApex, f.T / 1000 + 1e-6, "tApex");
    // free fall: a ≡ −g and the ballistic closed form from the chop end
    const [a, b] = f.freeFall;
    assert.ok(b - a > 0.15, `free fall lasts ${b - a} s`);
    for (let t = a; t <= b; t += (b - a) / 50) near(f.at(t).a, -G, 1e-9, "a = −g in free fall");
    const s0 = f.at(a);
    near(s0.z + (s0.v * s0.v) / (2 * G), f.apex, 1e-9, "apex = z0 + v0²/(2g)");
    near(f.hangSec, b - a, 1e-12, "hangSec = free-fall time");
    // every phase ramps at the trick jerk (or holds)
    for (let t = 0; t < f.T; t += f.T / 997) assert.ok(Math.abs(f.at(t).j) <= J + 1e-9, `jerk ${f.at(t).j}`);
    // numerical derivatives agree with the reported v / a (smooth, not just piecewise)
    const z = (t) => f.at(t).z;
    for (const t of [0.1, a + 0.05, f.tApex, b - 0.05]) {
      near(d1(z, t), f.at(t).v, 1e-5, "dz/dt");
      near(d2(z, t), f.at(t).a, 2e-3, "d²z/dt²");
    }
  }
});

check("planFloat: hangSec alone solves the apex; with a rise it solves the catch (or is ignored with the longest hang that lands); tiny rises raised", () => {
  const f = FT.planFloat({ punchAccel: 8, catchAccel: 12, hangSec: 1.4 });
  near(f.hangSec, 1.4, 1e-6, "free fall lasts hangSec");
  assert.ok(f.apex > 2.5 && f.apex < 20, `apex solved ${f.apex}`);
  near(f.zEnd, 0, 1e-6, "lands on the line");
  near(FT.planFloat({ punchAccel: 8, catchAccel: 12 }).apex, 2.5, 1e-6, "neither rise nor hangSec: 2.5 m");
  const both = FT.planFloat({ rise: 2.5, punchAccel: 8, catchAccel: 12, hangSec: 0.585 });
  near(both.hangSec, 0.585, 1e-6, "catch solved for the hang");
  assert.ok(both.catchAccel >= 7.2 && both.catchAccel <= 13 && both.notes.length === 0, `catch ${both.catchAccel} ${both.notes}`);
  const bad = FT.planFloat({ rise: 2.5, punchAccel: 8, catchAccel: 12, hangSec: 1.4 });
  assert.ok(bad.notes.some((n) => /hangSec 1\.4 s .*lands ≈ 0\.5\d–0\.\d\d s; omit rise/.test(n)), JSON.stringify(bad.notes));
  near(bad.zEnd, 0, 1e-6, "falls back to the default catch");
  near(bad.apex, 2.5, 1e-6, "the rise wins");
  const tiny = FT.planFloat({ rise: 0.05, punchAccel: 8, catchAccel: 12 });
  assert.ok(tiny.apex > 0.05 && tiny.notes.length > 0, "raised with a note");
  near(tiny.zEnd, 0, 1e-6, "and still lands");
  const soft = FT.planFloat({ rise: 0.6, punchAccel: 13, catchAccel: 12 });
  assert.ok(soft.punchAccel < 13, `a zero-length punch at 13 overshoots 0.6 m → lowered to ${soft.punchAccel}`);
  near(soft.apex, 0.6, 1e-6);
});

check("bumpC2: value / slope / curvature 0 at both ends, peak 1 at ½; bumpMinSec matches the jerk budget", () => {
  for (const x of [0, 1]) {
    near(FT.bumpC2(x), 0, 1e-15);
    near(d1(FT.bumpC2, x === 0 ? 1e-4 : 1 - 1e-4), 0, 1e-6, "slope");
  }
  near(FT.bumpC2(0.5), 1, 1e-15, "peak");
  near(d2(FT.bumpC2, 2e-4, 1e-4), 0, 1e-3, "curvature at 0");
  const T = FT.bumpMinSec(1.2, 40);
  near((1.2 * FT.FPV_BUMP_JERK) / T ** 3, 40, 1e-9, "a 1.2 m bump over bumpMinSec peaks at the jerk");
});

check("loopShape: full loop turns 2π, closes in height, drifts forward ≈ 1.56 R, climbs ≈ 2.04 R; half loop down drops ≈ 2 R and reverses", () => {
  for (const R of [1.5, 3, 8]) {
    const lp = FT.loopShape(2 * Math.PI, R);
    near(lp.end.theta, 2 * Math.PI, 1e-12, "turned 2π");
    near(lp.end.z, 0, 1e-6 * R, "back at entry height");
    assert.ok(lp.end.x > 1.2 * R && lp.end.x < 2.2 * R, `forward drift ${lp.end.x / R} R`);
    near(lp.zMax / R, 2.04, 0.08, "loop height");
    const hl = FT.loopShape(-Math.PI, R, 1.5);
    near(hl.end.theta, -Math.PI, 1e-12, "turned −π (half loop down)");
    near(-hl.end.z / R, 2.02, 0.1, "drop");
    near(hl.end.x, 1.5, 0.02 * R, "a symmetric half loop comes back over its start (after the roll lead)");
    // tangent continuity of the Hermite table
    const p = (l) => lp.at(l);
    const l0 = lp.length * 0.37, h = 1e-4;
    near(Math.atan2(p(l0 + h).z - p(l0 - h).z, p(l0 + h).x - p(l0 - h).x), Math.atan2(Math.sin(p(l0).theta), Math.cos(p(l0).theta)), 1e-3, "tangent");
  }
});

check("loopShape flown at its design speed √(1.1·g·R): jerk ≤ trickJerk (curvature ramps sized for it), |a| < amax", () => {
  for (const [turn, R] of [[2 * Math.PI, 1.5], [2 * Math.PI, 3], [-Math.PI, 1.5], [-Math.PI, 2.5], [-Math.PI, 6]]) {
    const u = Math.sqrt(FT.FPV_RUN_CONSTANTS.loopG * G * R);
    const sh = FT.loopShape(turn, R);
    const pos = (t) => { const g = sh.at(u * t); return [g.x, g.z]; };
    const T = sh.length / u, h = 1 / 120;
    let jm = 0, am = 0;
    for (let t = 2 * h; t <= T - 2 * h; t += h / 3) {
      const a = pos(t + 2 * h), b = pos(t + h), c = pos(t - h), d = pos(t - 2 * h);
      jm = Math.max(jm, Math.hypot(...[0, 1].map((k) => (a[k] - 2 * b[k] + 2 * c[k] - d[k]) / (2 * h ** 3))));
      const e = pos(t - h), f = pos(t), g = pos(t + h);
      am = Math.max(am, Math.hypot(...[0, 1].map((k) => (e[k] - 2 * f[k] + g[k]) / (h * h))));
    }
    assert.ok(jm <= J + 2, `turn ${turn.toFixed(2)} R ${R}: jerk ${jm.toFixed(1)}`);
    assert.ok(am <= 12, `turn ${turn.toFixed(2)} R ${R}: |a| ${am.toFixed(2)}`);
  }
});

check("quinticHermite meets value / first / second derivative at both ends", () => {
  const T = 1.7;
  const q = FT.quinticHermite(T, [1, 2, 3], [0.5, -1, 0], [2, 0, -1], [-1, 0, 4], [0, 3, 1], [-2, 1, 0]);
  const comp = (k) => (t) => q(t)[k];
  for (let k = 0; k < 3; k++) {
    near(q(0)[k], [1, 2, 3][k], 1e-12);
    near(q(T)[k], [-1, 0, 4][k], 1e-12);
    near(d1(comp(k), 1e-4, 1e-5), [0.5, -1, 0][k], 2e-3);
    near(d1(comp(k), T - 1e-4, 1e-5), [0, 3, 1][k], 2e-3);
    near(d2(comp(k), 2e-4, 1e-4), [2, 0, -1][k], 2e-2, "second derivative at 0");
    near(d2(comp(k), T - 2e-4, 1e-4), [-2, 1, 0][k], 2e-2, "second derivative at T");
  }
});

// ---------------------------------------------------------------------------
console.log("K2/K3 every trick in a run");
// ---------------------------------------------------------------------------
// A synthetic run: 80 m east (float, roll, power-loop), a 90° turn north (yaw-spin, dip), an 18 m vertical
// drop (dive), a level run, then a hairpin that drops ≈ 2R and comes back south — exactly where a split-S
// (radius 2.5, half roll 0.5 s) ends, so it can re-join.
const R_SS = 2.5;
const uSS = Math.sqrt(FT.FPV_RUN_CONSTANTS.loopG * G * R_SS);
const SS = FT.loopShape(-Math.PI, R_SS, uSS * 0.5);
const E = SS.end.x + 4;
const RUN = [[0, 0, 5], [80, 0, 5], [80, 40, 5], [80, 74, 5], [80, 74, -13], [80, 110, -13], [80, 110 + E, -13], [80, 110 + E, -13 + SS.end.z], [80, 85, -13 + SS.end.z]];
const RL = DR.fpvRunLine(RUN);
const S_DROP = RL.nearestS([80, 74, 5]);
const S_SPLIT = RL.nearestS([80, 110, -13]) - 1;
const TRICKS = [
  { type: "float", s: 8, rise: 2.6 },
  { type: "roll", s: 34 },
  { type: "power-loop", s: 52 },
  { type: "yaw-spin", s: 95 },
  { type: "dip", s: 112, depth: 0.8 },
  { type: "dive", s: +(S_DROP - 1.5).toFixed(2) },
  { type: "split-s", s: +S_SPLIT.toFixed(2), radius: R_SS },
];
const D_RUN = 50;
const run = SH.buildShot({ technique: "fpv.fpv-run", duration: D_RUN, params: { tricks: TRICKS } }, { path: RUN });
const rec = (type) => run.meta.tricks.find((t) => t.type === type);
/** Line position at the route progress of time t, for tricks riding the line: pos(t) − offset. */

check("every trick is placed: meta.tricks in input order with [t0, t1] windows, lock windows cover them", () => {
  assert.equal(run.meta.tricks.length, TRICKS.length);
  run.meta.tricks.forEach((t, i) => {
    assert.equal(t.type, TRICKS[i].type);
    assert.ok(!t.skipped, `${t.type} skipped: ${t.reason}`);
    assert.ok(t.t0 >= 0 && t.t1 > t.t0 && t.t1 <= D_RUN, `${t.type} window [${t.t0}, ${t.t1}]`);
    assert.ok(run.meta.lockWindows.some(([a, b]) => a <= t.t0 + 1e-9 && b >= t.t1 - 1e-9), `${t.type} inside a lock window`);
  });
  const sorted = run.meta.tricks.slice().sort((a, b) => a.t0 - b.t0);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].t0 >= sorted[i - 1].t1, "windows do not overlap");
  assert.equal(rec("dive").steepM, 18, "the dive found the 18 m drop");
  assert.ok(rec("split-s").exitMismatchM < 0.5, `split-S re-join ${rec("split-s").exitMismatchM} m`);
});

check("C² joins: Δacceleration across every trick start / end ≤ 0.6 m/s² (a hard join would be ≥ 5)", () => {
  for (const t of run.meta.tricks) {
    for (const tj of [t.t0, t.t1]) {
      const aL = accel(run, tj - 0.006), aR = accel(run, tj + 0.006);
      const da = Math.hypot(aL[0] - aR[0], aL[1] - aR[1], aL[2] - aR[2]);
      assert.ok(da <= 0.6, `${t.type} at t=${tj.toFixed(3)}: Δa ${da.toFixed(3)} m/s²`);
      const vL = run.sample(tj - 1e-4).pos, vR = run.sample(tj + 1e-4).pos;
      assert.ok(Math.hypot(vL[0] - vR[0], vL[1] - vR[1], vL[2] - vR[2]) < 0.01, "position continuous");
    }
  }
  // the yardstick: a constant-speed loop entered without a clothoid ramp jumps by v²/R
  const v = rec("power-loop").speed;
  assert.ok((v * v) / 3 > 5, "a hard loop entry would jump > 5 m/s²");
});

check("float: free fall a_z = −g within 0.3 m/s²; apex = rise above the line (closed form); net Δz = 0 at the catch", () => {
  const f = rec("float");
  const z = (t) => run.sample(t).pos[2];
  for (let t = f.freeFall[0] + 0.02; t <= f.freeFall[1] - 0.02; t += 0.01) near(d2(z, t, 0.004), -G, 0.3, `a_z at t=${t.toFixed(2)}`);
  // the line is level at z = 5 here: apex 5 + rise, and the ballistic closed form from the free-fall start
  near(z(f.apexT), 5 + f.rise, 0.01, "apex height");
  const v0 = d1(z, f.freeFall[0] + 1e-3, 1e-4);
  near(z(f.freeFall[0] + 1e-3) + (v0 * v0) / (2 * G), 5 + f.rise, 0.01, "z0 + v0²/(2g)");
  near(z(f.t1), 5, 0.002, "net Δz = 0: back on the line at the end");
  near(f.hangSec, f.freeFall[1] - f.freeFall[0], 1e-9);
  assert.ok(run.meta.throttleAt(f.apexT) < 0.3, `throttle at the apex ${run.meta.throttleAt(f.apexT)}`);
});

check("rotations: roll and yaw-spin turn 360°, the loop pitches through vertical and inverted, the split-S comes out heading back", () => {
  const roll = rec("roll");
  // integrate the frame-to-frame rotation about the view axis over the roll window
  let acc = 0;
  for (let t = roll.t0; t < roll.t1 - 1e-9; t += 1 / 240) {
    const qa = run.sample(t).q, qb = run.sample(Math.min(roll.t1, t + 1 / 240)).q;
    const dq = Q.qMul(Q.qConj(qa), Q.qEnsureContinuity(qa, qb));
    acc += 2 * Math.atan2(dq[2], dq[0]); // local y = view axis
  }
  near(acc, 2 * Math.PI, 0.1, "roll right = +360° about the view axis");
  const sp = rec("yaw-spin");
  let hAcc = 0;
  for (let t = sp.t0; t < sp.t1 - 1e-9; t += 1 / 240) hAcc += run.sample(Math.min(sp.t1, t + 1 / 240)).h - run.sample(t).h;
  near(hAcc, 2 * Math.PI, 0.15, "spin right = +360° of heading");
  const lp = rec("power-loop");
  const ps = [];
  for (let k = 0; k <= 40; k++) ps.push(run.sample(lp.t0 + ((lp.t1 - lp.t0) * k) / 40));
  assert.ok(Math.max(...ps.map((p) => p.p)) > 60 * DEG, "looks up through the loop");
  assert.ok(ps.some((p) => Math.abs(Math.abs(p.r) - Math.PI) < 0.3), "inverted at the top");
  const top = Math.max(...ps.map((p) => p.pos[2]));
  near(top - 5, lp.heightM, 0.5, "the loop climbs its height above the line");
  const ss = rec("split-s");
  const pIn = run.sample(ss.t0), pOut = run.sample(ss.t1);
  const fwdIn = [Math.sin(pIn.h), Math.cos(pIn.h)], fwdOut = [Math.sin(pOut.h), Math.cos(pOut.h)];
  assert.ok(fwdIn[0] * fwdOut[0] + fwdIn[1] * fwdOut[1] < -0.9, "heading reversed after the split-S");
  near(pIn.pos[2] - pOut.pos[2], ss.dropM, 0.6, "dropped ≈ 2R");
  const dv = rec("dive");
  const mid = run.sample((dv.t0 + dv.bottomT) / 2);
  near(mid.p, (dv.pitchDeg + 25) * DEG, 6 * DEG, "dive: camera at pitchDeg + uptilt");
  const dp = rec("dip");
  const zLine = 5 - 0; // the dip runs on the level 5 m line north of the corner
  near(Math.min(...[0.3, 0.4, 0.5, 0.6, 0.7].map((f) => run.sample(dp.t0 + f * (dp.t1 - dp.t0)).pos[2])), zLine - dp.depth, 0.15, "dip depth");
});

check("quaternions are continuous frame to frame (≤ peak rate · dt) and validate passes with meta.validate", () => {
  const fps = 60;
  const times = TR.frameTimes(D_RUN, fps);
  let prev = null, maxStep = 0;
  for (const t of times) {
    const q = run.sample(t).q;
    if (prev) maxStep = Math.max(maxStep, Q.qAngle(prev, q));
    prev = q;
  }
  assert.ok(maxStep / DEG <= 900 / fps, `largest frame rotation ${(maxStep / DEG).toFixed(2)}° at ${fps} fps`);
  const v = TR.validateTrajectory(run);
  assert.ok(v.ok, JSON.stringify(v.issues.slice(0, 3)));
  assert.equal(v.limits.source.maxAngularSpeedDeg, "meta");
  assert.deepEqual(run.meta.validate, { maxAngularSpeedDeg: 900 });
  assert.ok(v.stats.maxAngularSpeedDeg > 400, `the tricks really turn fast (${v.stats.maxAngularSpeedDeg.toFixed(0)}°/s)`);
});

check("deterministic: an identical spec bakes the identical table (checksum)", () => {
  const again = SH.buildShot({ technique: "fpv.fpv-run", duration: D_RUN, params: { tricks: TRICKS } }, { path: RUN });
  assert.equal(TR.bakeTrajectory(run, 30).checksum, TR.bakeTrajectory(again, 30).checksum);
  assert.deepEqual(again.meta.tricks, run.meta.tricks);
});

check("flyable: flyTrajectory(traj, 'fpv') tracks within 0.6 m; nominal jerk ≤ 60 m/s³ everywhere (free-fall onsets included)", () => {
  const f = FL.flyTrajectory(run, "fpv");
  assert.ok(f.meta.flight.maxTrackingErrorM <= 0.6, `tracking ${f.meta.flight.maxTrackingErrorM.toFixed(3)} m`);
  assert.equal(f.meta.flight.preset, "fpv");
  const jm = maxJerk(run, 0, D_RUN);
  assert.ok(jm.max <= 60, `nominal jerk ${jm.max.toFixed(1)} m/s³ at t=${jm.at.toFixed(2)}`);
  for (const t of run.meta.tricks) {
    const j = maxJerk(run, t.t0, t.t1);
    assert.ok(j.max <= 60, `${t.type}: jerk ${j.max.toFixed(1)}`);
  }
});

console.log(`film_fpv_tricks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
