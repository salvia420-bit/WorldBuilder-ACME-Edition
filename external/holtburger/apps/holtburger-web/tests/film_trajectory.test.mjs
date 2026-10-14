// tests/film_trajectory.test.mjs
//
// WHY: every AC Film Mode shot — technique output, director composition,
// replayed realised take — is a Trajectory whose sample(t) is pure in film
// time, and the stepped take player records/replays the baked TABLE format
// `[t, x, y, z, qw, qx, qy, qz, fov, focus, roll]` with a checksum. If the
// table round trip drifts, the checksum wobbles, or the validator misses NaN,
// teleports, angular spikes or gimbal (heading) flips, takes become
// unrepeatable or ship visible glitches. This suite EXECUTES
// scene3d/film/shots/trajectory.js and proves:
//   T1  makeTrajectory fills q ⇄ h/p/r, clamps t, normalises pitch past the
//       pole, defaults keyframes/bounds, throws FilmShotError on NaN;
//   T2  bakeTrajectory grid/rows layout, quaternion sign continuity;
//   T3  table round trip (bake → trajectoryFromTable → bake) is row- and
//       checksum-identical, incl. JSON / array-of-rows forms and a top-down
//       table whose roll column resolves the nadir heading ambiguity;
//   T4  tableChecksum equals an independent BigInt reference of the documented
//       algorithm, is stable below the quantum, changes above it;
//   T5  validateTrajectory flags NaN, teleports (> maxLinearSpeed), angular
//       spikes, heading flips (stateless look-at pass-over) but NOT a smooth
//       pitch through the pole; respects declared cuts; caps issues;
//   T6  timeWarp / withOffset / concatTrajectories (cut + blend) behave;
//   T7  helpers: orientLookAt, smoothLookAt (pre-simulated look controller:
//       the pass-over that flips stateless stays flip-free), aimSubject,
//       clampToEnvelope (C¹ soft floor), subjectCoverage, bounds, determinism.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure shot modules.
// Run from apps/holtburger-web/: node tests/film_trajectory.test.mjs

import assert from "node:assert/strict";

const TR = await import("../scene3d/film/shots/trajectory.js");
const FR = await import("../scene3d/film/shots/framing.js");
const G = await import("../scene3d/film/core/gimbal.js");
const Q = await import("../scene3d/film/core/quat.js");
const { FilmShotError } = await import("../scene3d/film/core/errors.js");
const { sineInOut } = await import("../scene3d/film/core/easing.js");

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
const HALF_PI = PI / 2;
const DEG = PI / 180;

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
}
function nearV(a, b, eps, msg) {
  for (let i = 0; i < a.length; i++) near(a[i], b[i], eps, `${msg ?? "vec"}[${i}]`);
}
function shotErr(code) {
  return (e) => e instanceof FilmShotError && (code === undefined || e.code === code);
}
function poseFinite(p) {
  return [...p.pos, ...p.q, p.h, p.p, p.r, p.fov].every(Number.isFinite);
}

/** Orbit of radius 12 around the origin at 3 m, looking at [0,0,1], 6 s, fov ramp + focus. */
function orbit(extra = {}) {
  return TR.makeTrajectory({
    id: "orbit",
    technique: "test.orbit",
    duration: 6,
    positionAt: (t) => [12 * Math.sin(t * 0.5), 12 * Math.cos(t * 0.5), 3],
    orientAt: TR.orientLookAt([0, 0, 1], { roll: (t) => 0.05 * Math.sin(t) }),
    fovAt: (t) => 50 + 2 * t,
    focusAt: (t) => 12 + 0.1 * t,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// T1 makeTrajectory
// ---------------------------------------------------------------------------

check("T1 makeTrajectory: pose shape, q ⇄ hpr consistency, t clamping, defaults", () => {
  const tr = orbit();
  assert.equal(tr.id, "orbit");
  assert.equal(tr.technique, "test.orbit");
  assert.equal(tr.family, "classic");
  assert.equal(tr.duration, 6);
  assert.deepEqual(tr.bounds, { ...TR.DEFAULT_BOUNDS });
  assert.equal(TR.hasExplicitBounds(tr), false);
  assert.equal(tr.keyframes.length, 5);
  assert.deepEqual(tr.keyframes.map((k) => k.t), [0, 1.5, 3, 4.5, 6]);
  for (const t of [0, 0.7, 3, 5.99, 6]) {
    const p = tr.sample(t);
    assert.equal(p.t, t);
    assert.ok(poseFinite(p));
    near(Math.hypot(...p.q), 1, 1e-12, "unit q");
    assert.ok(Q.qAngle(p.q, G.quatFromHPR(p.h, p.p, p.r)) < 1e-9, "q matches h/p/r");
    near(p.fov, 50 + 2 * t, 1e-12, "fov channel");
    near(p.focus, 12 + 0.1 * t, 1e-12, "focus channel");
    const f = Q.qToBasis(p.q).forward;
    const want = [0 - p.pos[0], 0 - p.pos[1], 1 - p.pos[2]];
    const l = Math.hypot(...want);
    nearV(f, want.map((x) => x / l), 1e-9, "looks at target");
  }
  assert.deepEqual(tr.sample(-5), tr.sample(0));
  assert.deepEqual(tr.sample(99), tr.sample(6));
  assert.deepEqual(tr.sample(NaN), tr.sample(0));
  assert.equal(tr.sample(99).t, 6);
});

check("T1 orientAt {q} fills h/p/r; pitch past the pole is re-expressed with |p| ≤ π/2", () => {
  const q0 = G.quatFromHPR(0.7, -0.4, 0.2);
  const a = TR.makeTrajectory({ duration: 1, positionAt: [0, 0, 5], orientAt: () => ({ q: q0 }) }).sample(0.5);
  near(a.h, 0.7, 1e-12, "h");
  near(a.p, -0.4, 1e-12, "p");
  near(a.r, 0.2, 1e-12, "r");
  near(a.fov, TR.DEFAULT_FOV, 0, "default fov 60");
  assert.equal(a.focus, undefined, "no focus channel unless asked");
  const pBeyond = -100 * DEG;
  const b = TR.makeTrajectory({ duration: 1, positionAt: [0, 0, 5], orientAt: { h: 0.3, p: pBeyond, r: 0 } }).sample(0);
  assert.ok(Math.abs(b.p) <= HALF_PI + 1e-12, `p ${b.p} within ±π/2`);
  assert.ok(Q.qAngle(b.q, G.quatFromHPR(0.3, pBeyond, 0)) < 1e-9, "orientation preserved through q");
  assert.ok(Q.qAngle(b.q, G.quatFromHPR(b.h, b.p, b.r)) < 1e-9, "re-expressed angles reproduce q");
  const c = TR.makeTrajectory({ duration: 1, positionAt: [0, 0, 5], orientAt: { h: 1.1, p: -HALF_PI, r: 0.4 } }).sample(0);
  assert.equal(c.p, -HALF_PI);
  assert.equal(c.h, 1.1);
  assert.equal(c.r, 0.4);
});

check("T1 makeTrajectory throws FilmShotError (NAN_POSE / BAD_TRAJECTORY) on NaN and bad headers", () => {
  const nanLate = TR.makeTrajectory({ duration: 4, positionAt: (t) => [t > 3.2 ? NaN : t, 0, 0], orientAt: { h: 0, p: 0 }, keyframes: [0, 1] });
  assert.throws(() => nanLate.sample(3.5), shotErr("NAN_POSE"));
  assert.throws(() => TR.makeTrajectory({ duration: 4, positionAt: (t) => [t > 1 ? NaN : t, 0, 0], orientAt: { h: 0, p: 0 } }),
    shotErr("NAN_POSE"), "default keyframes sample eagerly");
  assert.throws(() => TR.makeTrajectory({ duration: 1, positionAt: [0, 0, 0], orientAt: () => ({ h: NaN, p: 0 }) }), shotErr("NAN_POSE"));
  assert.throws(() => TR.makeTrajectory({ duration: 1, positionAt: [0, 0, 0], orientAt: () => ({ q: [0, 0, 0, 0] }) }), shotErr("NAN_POSE"));
  assert.throws(() => TR.makeTrajectory({ duration: 1, positionAt: [0, 0, 0], orientAt: { h: 0, p: 0 }, fov: 0 }), shotErr("NAN_POSE"));
  assert.throws(() => TR.makeTrajectory({ duration: 1, positionAt: [0, 0, 0], orientAt: { h: 0, p: 0 }, fovAt: () => 180 }), shotErr("NAN_POSE"));
  assert.throws(() => TR.makeTrajectory({ duration: 1, positionAt: [0, 0, 0], orientAt: { h: 0, p: 0 }, focusAt: () => NaN }), shotErr("NAN_POSE"));
  assert.throws(() => TR.makeTrajectory({ duration: -1, positionAt: [0, 0, 0], orientAt: { h: 0, p: 0 } }), shotErr("BAD_TRAJECTORY"));
  assert.throws(() => TR.makeTrajectory({ duration: NaN, positionAt: [0, 0, 0], orientAt: { h: 0, p: 0 } }), shotErr("BAD_TRAJECTORY"));
  assert.throws(() => TR.makeTrajectory({ duration: 1, positionAt: "here", orientAt: { h: 0, p: 0 } }), shotErr("BAD_TRAJECTORY"));
  assert.throws(() => TR.makeTrajectory({ duration: 1, positionAt: [0, 0, 0] }), shotErr("BAD_TRAJECTORY"));
  assert.throws(() => TR.makeTrajectory(null), shotErr("BAD_TRAJECTORY"));
  const z = TR.makeTrajectory({ duration: 0, positionAt: [1, 2, 3], orientAt: { h: 0, p: 0 } });
  assert.equal(z.keyframes.length, 1);
  assert.deepEqual(z.sample(5).pos, [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// T2 bake
// ---------------------------------------------------------------------------

check("T2 bakeTrajectory: fence-post grid, row layout, sign-continuous quaternions, focus 0 = none", () => {
  const tr = orbit();
  const tb = TR.bakeTrajectory(tr, 30);
  assert.equal(tb.fps, 30);
  assert.equal(tb.frames, 181);
  assert.ok(tb.rows instanceof Float64Array);
  assert.equal(tb.rows.length, 181 * TR.TABLE_STRIDE);
  assert.deepEqual(TR.TABLE_COLUMNS, ["t", "x", "y", "z", "qw", "qx", "qy", "qz", "fov", "focus", "roll"]);
  assert.equal(tb.rows[180 * 11], 6, "last row at t = duration");
  assert.equal(tb.checksum, TR.tableChecksum(tb.rows));
  assert.equal(tb.technique, "test.orbit");
  for (const k of [0, 37, 180]) {
    const o = k * 11;
    const p = tr.sample(tb.rows[o]);
    near(tb.rows[o], k / 30, 1e-12, "t");
    nearV([tb.rows[o + 1], tb.rows[o + 2], tb.rows[o + 3]], p.pos, 1e-12, "pos");
    assert.ok(Q.qAngle([tb.rows[o + 4], tb.rows[o + 5], tb.rows[o + 6], tb.rows[o + 7]], p.q) < 1e-12, "q");
    near(tb.rows[o + 8], p.fov, 1e-12, "fov");
    near(tb.rows[o + 9], p.focus, 1e-12, "focus");
    near(tb.rows[o + 10], p.r, 1e-12, "roll");
  }
  assert.ok(tb.rows[4] >= 0, "first quaternion canonical w ≥ 0");
  for (let k = 1; k < tb.frames; k++) {
    let d = 0;
    for (let c = 4; c < 8; c++) d += tb.rows[k * 11 + c] * tb.rows[(k - 1) * 11 + c];
    assert.ok(d >= 0, `quaternion sign continuous at row ${k}`);
  }
  const nofocus = TR.bakeTrajectory(TR.makeTrajectory({ duration: 1, positionAt: [0, 0, 0], orientAt: { h: 0, p: 0 } }), 10);
  assert.equal(nofocus.rows[9], 0);
  assert.deepEqual(TR.frameTimes(4.01, 30).length, 122);
  near(TR.frameTimes(4.01, 30).at(-1), 4.01, 0, "sliver frame ends exactly at duration");
  assert.equal(TR.frameTimes(5.0000000001, 30).length, 151, "no sliver within 1e-6 frames");
  assert.deepEqual(TR.frameTimes(0, 30), [0]);
  assert.throws(() => TR.frameTimes(1, 0), shotErr("BAD_ARGUMENT"));
  assert.throws(() => TR.bakeTrajectory(tr, NaN), shotErr("BAD_ARGUMENT"));
});

// ---------------------------------------------------------------------------
// T3 table round trip
// ---------------------------------------------------------------------------

check("T3 bake → trajectoryFromTable → bake is row-identical with the same checksum", () => {
  const tb = TR.bakeTrajectory(orbit(), 30);
  const rt = TR.trajectoryFromTable(tb);
  assert.equal(rt.duration, 6);
  assert.equal(rt.id, "orbit");
  assert.equal(rt.meta.fromTable.checksum, tb.checksum);
  for (let k = 0; k < tb.frames; k++) {
    const o = k * 11;
    const p = rt.sample(tb.rows[o]);
    nearV(p.pos, [tb.rows[o + 1], tb.rows[o + 2], tb.rows[o + 3]], 0, "row pos exact");
    assert.ok(Q.qAngle(p.q, [tb.rows[o + 4], tb.rows[o + 5], tb.rows[o + 6], tb.rows[o + 7]]) < 1e-12);
    assert.equal(p.fov, tb.rows[o + 8]);
    assert.equal(p.focus, tb.rows[o + 9]);
    near(p.r, tb.rows[o + 10], 1e-12, "roll");
  }
  const again = TR.bakeTrajectory(rt, 30);
  assert.equal(again.checksum, tb.checksum);
  for (let i = 0; i < tb.rows.length; i++) near(again.rows[i], tb.rows[i], 1e-12, `row value ${i}`);
});

check("T3 table JSON / array-of-rows forms replay identically; interpolation between rows is lerp/slerp", () => {
  const tb = TR.bakeTrajectory(orbit(), 30);
  const json = JSON.parse(JSON.stringify(TR.tableToJSON(tb)));
  assert.equal(json.checksum, tb.checksum);
  const a = TR.trajectoryFromTable(json);
  assert.equal(TR.bakeTrajectory(a, 30).checksum, tb.checksum);
  const rows2d = [];
  for (let k = 0; k < tb.frames; k++) rows2d.push(Array.from(tb.rows.subarray(k * 11, k * 11 + 11)));
  const b = TR.trajectoryFromTable({ fps: 30, rows: rows2d });
  assert.equal(TR.bakeTrajectory(b, 30).checksum, tb.checksum);
  // midway between rows 10 and 11
  const tm = (10.5) / 30;
  const pm = a.sample(tm);
  const r10 = tb.rows.subarray(110, 121), r11 = tb.rows.subarray(121, 132);
  nearV(pm.pos, [0, 1, 2].map((i) => (r10[1 + i] + r11[1 + i]) / 2), 1e-12, "lerp pos");
  const q10 = Array.from(r10.subarray(4, 8)), q11 = Array.from(r11.subarray(4, 8));
  near(Q.qAngle(pm.q, q10), Q.qAngle(q10, q11) / 2, 1e-9, "slerp midway");
  near(pm.fov, (r10[8] + r11[8]) / 2, 1e-12, "fov lerp");
  near(pm.focus, (r10[9] + r11[9]) / 2, 1e-12, "focus lerp");
  assert.ok(poseFinite(pm));
});

check("T3 top-down table: the roll column resolves the nadir heading ambiguity on replay", () => {
  const tr = TR.makeTrajectory({
    id: "topdown", duration: 2, positionAt: (t) => [t, 0, 40],
    orientAt: (t) => ({ h: 0.2 + 0.6 * t, p: -HALF_PI, r: 0.3 * t }),
  });
  const tb = TR.bakeTrajectory(tr, 25);
  const rt = TR.trajectoryFromTable(tb);
  for (const t of [0, 0.4, 1.0, 1.52, 2]) {
    const p = rt.sample(t), s = tr.sample(t);
    assert.ok(Q.qAngle(p.q, s.q) < 1e-9, `orientation at ${t}`);
    near(p.r, s.r, 1e-9, `roll restored at ${t}`);
    near(p.h + p.r, s.h + s.r, 1e-9, `nadir invariant h + r at ${t}`);
    near(p.p, -HALF_PI, 1e-9, "still straight down");
  }
  assert.equal(TR.bakeTrajectory(rt, 25).checksum, tb.checksum);
});

check("T3 trajectoryFromTable rejects malformed tables (BAD_TABLE)", () => {
  const tb = TR.bakeTrajectory(orbit(), 10);
  assert.throws(() => TR.trajectoryFromTable({ fps: 10, rows: tb.rows.subarray(0, 15) }), shotErr("BAD_TABLE"));
  const bad = Float64Array.from(tb.rows); bad[3] = NaN;
  assert.throws(() => TR.trajectoryFromTable({ fps: 10, rows: bad }), shotErr("BAD_TABLE"));
  const back = Float64Array.from(tb.rows); back[11] = 0; // row 1 t == row 0 t
  assert.throws(() => TR.trajectoryFromTable({ fps: 10, rows: back }), shotErr("BAD_TABLE"));
  assert.throws(() => TR.trajectoryFromTable({ fps: 0, rows: tb.rows }), shotErr("BAD_TABLE"));
  assert.throws(() => TR.trajectoryFromTable({ fps: 10, rows: tb.rows, frames: 3 }), shotErr("BAD_TABLE"));
  const shifted = Float64Array.from(tb.rows);
  for (let k = 0; k < tb.frames; k++) shifted[k * 11] += 100;
  const rt = TR.trajectoryFromTable({ fps: 10, rows: shifted });
  near(rt.duration, 6, 1e-9, "time shifted to start at 0");
  nearV(rt.sample(0).pos, Array.from(tb.rows.subarray(1, 4)), 0, "first row at t = 0");
});

// ---------------------------------------------------------------------------
// T4 checksum
// ---------------------------------------------------------------------------

/** Independent reference of the documented checksum (BigInt int64 LE bytes, FNV-1a 32). */
function refChecksum(flat) {
  let h = 0x811c9dc5n;
  for (let i = 0; i < flat.length; i++) {
    const col = i % 11;
    const scale = col === 1 || col === 2 || col === 3 || col === 9 ? 1000 : 10000;
    let q = BigInt(Math.round(flat[i] * scale));
    q = BigInt.asUintN(64, q);
    for (let b = 0n; b < 8n; b++) {
      h ^= (q >> (8n * b)) & 0xffn;
      h = (h * 0x01000193n) & 0xffffffffn;
    }
  }
  return h.toString(16).padStart(8, "0");
}

check("T4 tableChecksum matches an independent reference; stable below the quantum, changes above", () => {
  const rows = [
    [0, 1.2344, -2.5, 30000.75, 1, 0, 0, 0, 60, 0, 0],
    [0.1, 1.2354, -2.6, 30000.8, 0.99, 0.01, -0.02, 0.1, 59.5, 12.25, -0.125],
    [0.2, -48000.123, 52000.987, -3.2, 0.5, -0.5, 0.5, -0.5, 30, 3.5, 3.1],
  ];
  const flat = rows.flat();
  const sum = TR.tableChecksum(flat);
  assert.match(sum, /^[0-9a-f]{8}$/);
  assert.equal(sum, refChecksum(flat), "documented algorithm");
  assert.equal(TR.tableChecksum(Float64Array.from(flat)), sum, "Float64Array form");
  assert.equal(TR.tableChecksum(rows), sum, "array-of-rows form");
  const tiny = flat.slice(); tiny[1] += 1e-7; tiny[4] += 1e-9;
  assert.equal(TR.tableChecksum(tiny), sum, "sub-quantum noise does not change the checksum");
  const moved = flat.slice(); moved[1] += 0.005;
  assert.notEqual(TR.tableChecksum(moved), sum, "a 5 mm move changes it");
  const turned = flat.slice(); turned[5] += 0.001;
  assert.notEqual(TR.tableChecksum(turned), sum, "a 1e-3 quaternion change changes it");
  const nanRow = flat.slice(); nanRow[2] = NaN;
  assert.notEqual(TR.tableChecksum(nanRow), TR.tableChecksum(flat.map((v, i) => (i === 2 ? 0 : v))), "NaN ≠ 0");
  assert.equal(TR.bakeTrajectory(orbit(), 24).checksum, TR.bakeTrajectory(orbit(), 24).checksum, "deterministic bake");
});

// ---------------------------------------------------------------------------
// T5 validateTrajectory
// ---------------------------------------------------------------------------

check("T5 a smooth orbit validates clean (table input too)", () => {
  const v = TR.validateTrajectory(orbit());
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  assert.equal(v.frames, 181);
  assert.ok(v.stats.maxSpeed > 5.9 && v.stats.maxSpeed < 6.1, `orbit speed ${v.stats.maxSpeed}`);
  const vt = TR.validateTrajectory(TR.bakeTrajectory(orbit(), 30));
  assert.equal(vt.ok, true);
});

check("T5 validateTrajectory flags NaN frames", () => {
  const tr = TR.makeTrajectory({ duration: 3, positionAt: (t) => [t > 2 ? NaN : t, 0, 2], orientAt: { h: 0, p: 0 }, keyframes: [0] });
  const v = TR.validateTrajectory(tr, { fps: 10 });
  assert.equal(v.ok, false);
  assert.equal(v.counts.nan, 10, "frames 2.1 … 3.0");
  assert.equal(v.issues[0].code, "nan");
  near(v.issues[0].t, 2.1, 1e-9, "first NaN frame");
  const handmade = { duration: 1, sample: (t) => ({ t, pos: [0, 0, 0], q: [1, 0, 0, 0], h: 0, p: NaN, r: 0, fov: 60 }) };
  assert.equal(TR.validateTrajectory(handmade, { fps: 4 }).counts.nan, 5);
});

check("T5 validateTrajectory flags teleports above maxLinearSpeed", () => {
  const tr = TR.makeTrajectory({ duration: 2, positionAt: (t) => [t < 1 ? t : t + 10, 0, 2], orientAt: { h: 0, p: 0 } });
  const v = TR.validateTrajectory(tr, { fps: 30 });
  assert.equal(v.counts.teleport, 1);
  const iss = v.issues.find((i) => i.code === "teleport");
  near(iss.t, 1, 1e-9, "at the jump");
  assert.ok(iss.value > 300 && iss.limit === 80);
  assert.equal(TR.validateTrajectory(tr, { fps: 30, maxLinearSpeed: 1000 }).counts.teleport, 0);
});

check("T5 validateTrajectory flags angular spikes and fov spikes", () => {
  const tr = TR.makeTrajectory({ duration: 2, positionAt: [0, 0, 2], orientAt: (t) => ({ h: t < 1 ? 0 : 45 * DEG, p: 0 }) });
  const v = TR.validateTrajectory(tr, { fps: 30 });
  assert.equal(v.counts["angular-spike"], 1);
  assert.equal(v.counts["heading-flip"], 0, "45° is a spike, not a flip");
  near(v.issues[0].value, 45 * 30, 1e-6, "°/s");
  const pan = TR.makeTrajectory({ duration: 2, positionAt: [0, 0, 2], orientAt: (t) => ({ h: t * 90 * DEG, p: 0 }) });
  assert.equal(TR.validateTrajectory(pan).ok, true, "a 90°/s pan is fine");
  const zoom = TR.makeTrajectory({ duration: 1, positionAt: [0, 0, 2], orientAt: { h: 0, p: 0 }, fovAt: (t) => (t < 0.5 ? 60 : 20) });
  assert.equal(TR.validateTrajectory(zoom).counts["fov-spike"], 1);
});

check("T5 heading flip: stateless look-at pass-over IS flagged, a smooth pitch through the pole is NOT", () => {
  // eye flies north at 10 m/s over a target 20 m below → bearing flips 0 → π as it passes overhead
  const flip = TR.makeTrajectory({ duration: 8, positionAt: (t) => [0, -40 + 10 * t, 20], orientAt: TR.orientLookAt([0, 0, 0]) });
  const v = TR.validateTrajectory(flip, { fps: 30 });
  assert.ok(v.counts["heading-flip"] >= 1, JSON.stringify(v.counts));
  const hf = v.issues.find((i) => i.code === "heading-flip");
  assert.ok(hf.value > 170, `jump ${hf.value}°`);
  near(hf.t, 4, 0.1, "at the overhead moment");
  // FPV-style: pitch −60° → −120° (through nadir) at 30°/s; quaternion continuous
  const through = TR.makeTrajectory({ duration: 2, positionAt: [0, 0, 30], orientAt: (t) => ({ h: 0.4, p: (-60 - 30 * t) * DEG, r: 0 }) });
  const w = TR.validateTrajectory(through, { fps: 30 });
  assert.equal(w.ok, true, JSON.stringify(w.issues.slice(0, 3)));
  for (const t of [0, 0.9, 1.0, 1.1, 2]) assert.ok(Math.abs(through.sample(t).p) <= HALF_PI);
});

check("T5 validateTrajectory: pitch/fov range on hand-made trajectories, structure errors, issue cap", () => {
  const hm = { duration: 1, sample: (t) => ({ t, pos: [0, 0, 0], q: [1, 0, 0, 0], h: 0, p: 2, r: 0, fov: 200 }) };
  const v = TR.validateTrajectory(hm, { fps: 10, maxIssues: 3 });
  assert.equal(v.counts["pitch-range"], 11);
  assert.equal(v.counts["fov-range"], 11);
  assert.equal(v.issues.length, 3, "issue list capped");
  assert.equal(v.ok, false);
  const s = TR.validateTrajectory(null);
  assert.equal(s.ok, false);
  assert.equal(s.issues[0].code, "structure");
  assert.equal(TR.validateTrajectory({ fps: 30, rows: [1, 2, 3] }).issues[0].code, "structure");
  const thrower = { duration: 1, sample: () => { throw new TypeError("boom"); } };
  assert.equal(TR.validateTrajectory(thrower, { fps: 2 }).counts["sample-error"], 3);
  assert.equal(TR.validateTrajectory(TR.bakeTrajectory(orbit(), 12)).frames, 73, "a table is checked at its own fps");
  assert.equal(TR.validateTrajectory(TR.bakeTrajectory(orbit(), 12), { fps: 30 }).frames, 181);
  const huge = TR.validateTrajectory({ duration: 1e7, sample: (t) => ({ t, pos: [0, 0, 0], q: [1, 0, 0, 0], h: 0, p: 0, r: 0, fov: 60 }) });
  assert.equal(huge.ok, false);
  assert.equal(huge.issues[0].code, "structure", "oversize grid reported, not thrown");
});

// ---------------------------------------------------------------------------
// T6 combinators
// ---------------------------------------------------------------------------

/** Straight 10 m/s dolly north from y = 0, 4 s, looking north. */
function line(id = "line", y0 = 0, x = 0) {
  return TR.makeTrajectory({ id, technique: "test.line", duration: 4, positionAt: (t) => [x, y0 + 10 * t, 2], orientAt: { h: 0, p: 0 }, fovAt: (t) => 40 + t });
}

check("T6 timeWarp: rate, easing (normalised), explicit map (reverse), keyframes, errors", () => {
  const base = line();
  const fast = TR.timeWarp(base, 2);
  assert.equal(fast.duration, 2);
  for (const t of [0, 0.3, 1, 2]) {
    const p = fast.sample(t);
    assert.equal(p.t, t);
    nearV(p.pos, base.sample(2 * t).pos, 1e-12);
    near(p.fov, base.sample(2 * t).fov, 1e-12);
  }
  assert.deepEqual(fast.keyframes.map((k) => +k.t.toFixed(9)), [0, 0.5, 1, 1.5, 2]);
  assert.deepEqual(fast.meta.timeWarp, { kind: "rate", rate: 2, sourceDuration: 4 });
  const eased = TR.timeWarp(base, "sineInOut");
  assert.equal(eased.duration, 4);
  nearV(eased.sample(0).pos, base.sample(0).pos, 1e-12);
  nearV(eased.sample(4).pos, base.sample(4).pos, 1e-12);
  nearV(eased.sample(2).pos, base.sample(2).pos, 1e-12, "sineInOut(0.5) = 0.5");
  nearV(eased.sample(1).pos, base.sample(4 * sineInOut(0.25)).pos, 1e-12);
  const custom = TR.timeWarp(base, (u) => u * u);
  nearV(custom.sample(2).pos, base.sample(1).pos, 1e-12);
  const rev = TR.timeWarp(base, { map: (t) => 4 - t });
  nearV(rev.sample(0).pos, base.sample(4).pos, 1e-12);
  nearV(rev.sample(3).pos, base.sample(1).pos, 1e-12);
  assert.deepEqual(rev.keyframes.map((k) => +k.t.toFixed(6)), [0, 1, 2, 3, 4]);
  const slow = TR.timeWarp(base, { duration: 8, map: (t) => t / 2 });
  assert.equal(slow.duration, 8);
  assert.equal(TR.validateTrajectory(slow).ok, true);
  assert.throws(() => TR.timeWarp(base, 0), shotErr("BAD_WARP"));
  assert.throws(() => TR.timeWarp(base, "wobble"), shotErr("BAD_WARP"));
  assert.throws(() => TR.timeWarp(base, {}), shotErr("BAD_WARP"));
  assert.throws(() => TR.timeWarp(base, { map: () => NaN }), shotErr("NAN_POSE"));
  assert.throws(() => TR.timeWarp({}, 2), shotErr("BAD_TRAJECTORY"));
});

check("T6 withOffset: world/local position, gimbal and fov offsets; null = identity; NaN throws", () => {
  const base = line();
  const off = TR.withOffset(base, (t) => ({ dpos: [1, 0, 0.5 * t], dh: 0.1, dfov: -5 }));
  const p = off.sample(2), b = base.sample(2);
  nearV(p.pos, [b.pos[0] + 1, b.pos[1], b.pos[2] + 1], 1e-12);
  near(p.h, b.h + 0.1, 1e-12, "dh");
  near(p.fov, b.fov - 5, 1e-12, "dfov");
  assert.ok(Q.qAngle(p.q, G.quatFromHPR(p.h, p.p, p.r)) < 1e-9);
  const fwd = TR.withOffset(base, () => ({ dposLocal: [0, 3, 0] }));
  nearV(fwd.sample(1).pos, [0, 13, 2], 1e-12, "local forward offset");
  const ident = TR.withOffset(base, () => null);
  assert.deepEqual(ident.sample(1.3), base.sample(1.3));
  const bad = TR.withOffset(base, (t) => (t > 3.2 && t < 3.6 ? { dh: NaN } : {}));
  assert.throws(() => bad.sample(3.5), shotErr("NAN_POSE"));
  assert.throws(() => TR.withOffset(base, (t) => (t > 3 ? { dh: NaN } : {})), shotErr("NAN_POSE"), "keyframes sample eagerly");
  assert.throws(() => TR.withOffset(base, 5), shotErr("BAD_ARGUMENT"));
  // straight-down base + oscillating pitch offset stays finite and smooth
  const top = TR.makeTrajectory({ duration: 2, positionAt: [0, 0, 30], orientAt: { h: 0.5, p: -HALF_PI, r: 0 } });
  const shaken = TR.withOffset(top, (t) => ({ dp: 0.02 * Math.sin(6 * t), dh: 0.01 * t }));
  const v = TR.validateTrajectory(shaken);
  assert.equal(v.ok, true, JSON.stringify(v.issues.slice(0, 2)));
  assert.equal(shaken.meta.offset, true);
});

check("T6 concatTrajectories 'cut': durations add, next shot owns the boundary, cuts declared", () => {
  const a = line("a", 0), b = line("b", 500, 300);
  const drone = TR.makeTrajectory({ id: "c", family: "drone", duration: 2, positionAt: [0, 0, 50], orientAt: { h: 0, p: -0.5 }, bounds: { maxLateral: 0.5 } });
  const cat = TR.concatTrajectories([a, b, drone]);
  assert.equal(cat.duration, 10);
  assert.equal(cat.technique, "concat");
  assert.equal(cat.id, "a+b+c");
  assert.equal(cat.family, "mixed");
  assert.deepEqual(cat.meta.cuts, [4, 8]);
  assert.deepEqual(cat.meta.segments.map((s) => [s.id, s.start, s.end]), [["a", 0, 4], ["b", 4, 8], ["c", 8, 10]]);
  nearV(cat.sample(3.999).pos, a.sample(3.999).pos, 1e-12);
  nearV(cat.sample(4).pos, b.sample(0).pos, 1e-12, "boundary belongs to the next shot");
  nearV(cat.sample(9).pos, [0, 0, 50], 1e-12);
  assert.equal(cat.bounds.maxLateral, 0.5, "most restrictive bounds");
  assert.equal(TR.validateTrajectory(cat).ok, true, "declared cuts are not teleports");
  assert.ok(TR.validateTrajectory(cat, { respectCuts: false }).counts.teleport >= 1);
  assert.equal(TR.concatTrajectories([a]).duration, 4);
  assert.throws(() => TR.concatTrajectories([]), shotErr("BAD_ARGUMENT"));
  assert.throws(() => TR.concatTrajectories([a], { bridge: "dissolve" }), shotErr("BAD_ARGUMENT"));
});

check("T6 concatTrajectories 'blend': overlap, continuity at both blend edges, NaN-free", () => {
  const a = line("a", 0);
  const b = TR.makeTrajectory({ id: "b", duration: 3, positionAt: (t) => [0.5 * t, 40 + 8 * t, 2.5], orientAt: { h: 0.4, p: -0.1, r: 0 }, fovAt: 50, focusAt: 9 });
  const cat = TR.concatTrajectories([a, b], { bridge: "blend", blendSec: 1 });
  near(cat.duration, 6, 1e-12, "4 + 3 − 1");
  assert.deepEqual(cat.meta.cuts, []);
  nearV(cat.sample(3).pos, a.sample(3).pos, 1e-12, "blend start = A");
  assert.ok(Q.qAngle(cat.sample(3).q, a.sample(3).q) < 1e-9);
  nearV(cat.sample(4).pos, b.sample(1).pos, 1e-12, "blend end = B");
  assert.ok(Q.qAngle(cat.sample(4).q, b.sample(1).q) < 1e-9);
  const mid = cat.sample(3.5);
  nearV(mid.pos, [0, 1, 2].map((i) => (a.sample(3.5).pos[i] + b.sample(0.5).pos[i]) / 2), 1e-12, "smootherstep(0.5) = 0.5");
  assert.equal(mid.focus, 9, "focus from the side that has one");
  const v = TR.validateTrajectory(cat);
  assert.equal(v.ok, true, JSON.stringify(v.issues.slice(0, 3)));
  const short = TR.concatTrajectories([a, TR.timeWarp(b, 6)], { bridge: "blend", blendSec: 2 });
  near(short.duration, 4 + 0.5 - 0.25, 1e-12, "blend clamped to half the shorter shot");
});

// ---------------------------------------------------------------------------
// T7 helpers
// ---------------------------------------------------------------------------

check("T7 orientLookAt: aims at static and moving targets; nadir uses the heading hint; offsets; NaN target throws", () => {
  const o = TR.orientLookAt((t) => [t, 5, 0], { headingHint: 1.2 });
  const r = o(2, [0, 0, 0]);
  const f = G.forwardFromHP(r.h, r.p);
  const d = [2, 5, 0], l = Math.hypot(...d);
  nearV(f, d.map((x) => x / l), 1e-12);
  const down = TR.orientLookAt([3, 3, 0], { headingHint: 1.2, roll: 0.1 })(0, [3, 3, 50]);
  assert.equal(down.p, -HALF_PI);
  assert.equal(down.h, 1.2);
  assert.equal(down.r, 0.1);
  const offs = TR.orientLookAt([0, 10, 0], { offset: { dh: 0.2, dp: -0.1 } })(0, [0, 0, 0]);
  near(offs.h, 0.2, 1e-12);
  near(offs.p, -0.1, 1e-12);
  assert.throws(() => TR.orientLookAt([NaN, 0, 0]), shotErr("BAD_ARGUMENT"));
  assert.throws(() => TR.orientLookAt(() => [NaN, 0, 0])(0, [0, 0, 0]), shotErr("NAN_POSE"));
  // a whole straight-down trajectory is NaN-free and keeps image-up = hint
  const td = TR.makeTrajectory({ duration: 2, positionAt: (t) => [t, 0, 30], orientAt: TR.orientLookAt((t) => [t, 0, 0], { headingHint: 0.7 }) });
  for (const t of [0, 1, 2]) {
    const p = td.sample(t);
    assert.ok(poseFinite(p));
    near(p.p, -HALF_PI, 1e-12);
    near(p.h, 0.7, 1e-12);
  }
});

check("T7 smoothLookAt: the same pass-over is flip-free (yaw-slew + pitch-through), pure in t, reaches straight down", () => {
  const posAt = (t) => [0, -40 + 10 * t, 20];
  for (const nadirMode of ["yaw-slew", "pitch-through", "hold"]) {
    const tr = TR.makeTrajectory({ duration: 8, positionAt: posAt, orientAt: TR.smoothLookAt(posAt, [0, 0, 0], 8, { nadirMode }) });
    const v = TR.validateTrajectory(tr, { fps: 30 });
    assert.equal(v.counts["heading-flip"], 0, `${nadirMode}: ${JSON.stringify(v.counts)}`);
    assert.equal(v.counts["angular-spike"], 0, `${nadirMode}: peak ${v.stats.maxAngularSpeedDeg}°/s`);
    assert.equal(v.ok, true);
    let minP = 0;
    for (let k = 0; k <= 240; k++) minP = Math.min(minP, tr.sample(k / 30).p);
    assert.ok(minP <= -89 * DEG, `${nadirMode}: reaches straight down (${minP / DEG}°)`);
    assert.deepEqual(tr.sample(3.33), tr.sample(3.33), "pure in t");
  }
  const tr = TR.makeTrajectory({ duration: 8, positionAt: posAt, orientAt: TR.smoothLookAt(posAt, [0, 0, 0], 8) });
  const p0 = tr.sample(0);
  const f = Q.qToBasis(p0.q).forward, d = [0, 40, -20], l = Math.hypot(...d);
  nearV(f, d.map((x) => x / l), 1e-9, "first sample snaps onto the target");
  const td = TR.smoothLookAt([0, 0, 30], [0, 0, 0], 0, { headingHint: 0.4 })(5);
  near(Q.qAngle(td.q, G.quatFromHPR(0.4, -HALF_PI, 0)), 0, 1e-9, "zero-length: straight down at the hint");
  assert.throws(() => TR.smoothLookAt(posAt, () => [NaN, 0, 0], 2), shotErr("NAN_POSE"));
  assert.throws(() => TR.smoothLookAt(posAt, [0, 0, 0], 2, { nadirMode: "spin" }), shotErr("BAD_ARGUMENT"));
  assert.throws(() => TR.smoothLookAt("x", [0, 0, 0], 2), shotErr("BAD_ARGUMENT"));
});

check("T7 aimSubject: framing aim heights, moving subjects, anchor fallback, missing subject throws", () => {
  const ctx = { subject: { pos: [10, 20, 5], height: 2, radius: 0.5 } };
  nearV(TR.aimSubject(ctx, "CU")(0), [10, 20, 5 + 1.8], 1e-12, "eye line 0.9H");
  nearV(TR.aimSubject(ctx, "FS")(0), [10, 20, 6], 1e-12, "centre for FS");
  nearV(TR.aimSubject(ctx)(0), [10, 20, 6.8], 1e-12, "default MS");
  const moving = { subjectAt: (t) => ({ pos: [t, 0, 0], height: 1.8 }) };
  nearV(TR.aimSubject(moving, "WS")(3), [3, 0, 0.9], 1e-12);
  nearV(TR.aimSubject({ anchor: [1, 2, 3] })(5), [1, 2, 3], 0);
  assert.throws(() => TR.aimSubject({}), shotErr("MISSING_SUBJECT"));
  assert.throws(() => TR.aimSubject(ctx, "XXL"), shotErr("BAD_FRAMING"));
  assert.equal(TR.subjectAtTime(moving, 2).pos[0], 2);
  assert.equal(TR.subjectAtTime({}, 2), null);
});

check("T7 clampToEnvelope: ground clearance with a C¹ soft floor; indoor floor/ceiling; unknown ground untouched", () => {
  const ctx = { groundZ: () => 10 };
  assert.ok(TR.clampToEnvelope([0, 0, 5], ctx)[2] >= 10.7, "lifted above ground + 0.7");
  assert.ok(TR.clampToEnvelope([0, 0, -1e9], ctx)[2] >= 10.7);
  assert.deepEqual(TR.clampToEnvelope([1, 2, 20], ctx), [1, 2, 20], "well above: unchanged");
  assert.deepEqual(TR.clampToEnvelope([1, 2, 11.2], ctx), [1, 2, 11.2], "at floor + soft: unchanged");
  const zf = (z) => TR.clampToEnvelope([0, 0, z], ctx)[2];
  const h = 1e-6;
  for (const z of [10.7, 11.0, 11.2, 11.3]) {
    const dl = (zf(z) - zf(z - h)) / h, dr = (zf(z + h) - zf(z)) / h;
    near(dl, dr, 1e-3, `C¹ at z=${z}`);
    assert.ok(dl > 0, "monotone");
  }
  assert.equal(TR.clampToEnvelope([0, 0, 5], ctx, { soft: 0 })[2], 10.7, "hard clamp");
  assert.deepEqual(TR.clampToEnvelope([0, 0, -3], { groundZ: () => null }), [0, 0, -3]);
  assert.deepEqual(TR.clampToEnvelope([0, 0, -3], { groundZ: () => { throw new Error("x"); } }), [0, 0, -3]);
  const indoor = { groundZ: () => 1000, indoor: { floor: () => 0, ceiling: () => 4 } };
  const zi = TR.clampToEnvelope([0, 0, -2], indoor)[2];
  assert.ok(zi >= 0.5 && zi < 0.6, `indoor floor ${zi} (ground ignored indoors)`);
  const zc = TR.clampToEnvelope([0, 0, 9], indoor)[2];
  assert.ok(zc <= 3.7 && zc > 3.5, `ceiling ${zc}`);
  assert.equal(TR.clampToEnvelope([0, 0, 2], indoor)[2], 2);
  assert.equal(TR.clampToEnvelope([0, 0, 2], { indoor: { floor: () => 0, ceiling: () => 0.6 } })[2], 0.3, "too tight → midpoint");
  assert.throws(() => TR.clampToEnvelope([NaN, 0, 0], ctx), shotErr("NAN_POSE"));
});

check("T7 subjectCoverage: orbit keeps the subject in frame; looking away does not", () => {
  const subject = { pos: [0, 0, 0], height: 1.8, radius: 0.4 };
  const tr = TR.makeTrajectory({
    duration: 5, positionAt: (t) => [6 * Math.sin(t), 6 * Math.cos(t), 1.6],
    orientAt: TR.orientLookAt(TR.aimSubject({ subject }, "MS")), subject,
  });
  const c = TR.subjectCoverage(tr);
  assert.equal(c.fraction, 1);
  assert.equal(c.samples, 151);
  assert.equal(c.firstMiss, null);
  const away = TR.makeTrajectory({ duration: 1, positionAt: [0, -6, 1.6], orientAt: { h: PI, p: 0 } });
  const a = TR.subjectCoverage(away, { subject });
  assert.equal(a.fraction, 0);
  assert.equal(a.firstMiss, 0);
  assert.throws(() => TR.subjectCoverage(away), shotErr("MISSING_SUBJECT"));
});

check("T7 bounds: normalise / validate / intersect; explicit bounds are tracked", () => {
  assert.deepEqual(TR.normalizeBounds({ maxLateral: 0.5 }), { ...TR.DEFAULT_BOUNDS, maxLateral: 0.5 });
  assert.throws(() => TR.normalizeBounds({ maxLaterall: 1 }), shotErr("BAD_BOUNDS"));
  assert.throws(() => TR.normalizeBounds({ minSpeedScale: 1.5 }), shotErr("BAD_BOUNDS"));
  assert.throws(() => TR.normalizeBounds({ maxSpeedScale: 0.5 }), shotErr("BAD_BOUNDS"));
  assert.throws(() => TR.normalizeBounds({ maxRise: -1 }), shotErr("BAD_BOUNDS"));
  assert.throws(() => TR.normalizeBounds({ maxSink: NaN }), shotErr("BAD_BOUNDS"));
  const x = TR.intersectBounds([{ maxLateral: 1, minSpeedScale: 0.1 }, { maxLateral: 3, minSpeedScale: 0.6, maxDistanceScale: 1.1 }]);
  assert.equal(x.maxLateral, 1);
  assert.equal(x.minSpeedScale, 0.6);
  assert.equal(x.maxDistanceScale, 1.1);
  const tr = TR.makeTrajectory({ duration: 1, positionAt: [0, 0, 0], orientAt: { h: 0, p: 0 }, bounds: { maxRise: 0.2 } });
  assert.equal(TR.hasExplicitBounds(tr), true);
  assert.equal(TR.hasExplicitBounds(TR.timeWarp(tr, 2)), true, "explicit-ness survives combinators");
  assert.equal(tr.bounds.maxRise, 0.2);
});

check("T7 makePose / isTrajectory / determinism of identical constructions", () => {
  const p = TR.makePose({ pos: [1, 2, 3], h: 0.5, p: 0.1, fov: 45, focus: 7 });
  assert.equal(p.t, 0);
  assert.equal(p.focus, 7);
  assert.ok(Q.qAngle(p.q, G.quatFromHPR(0.5, 0.1, 0)) < 1e-12);
  assert.throws(() => TR.makePose({ pos: [1, 2] }), shotErr("NAN_POSE"));
  assert.equal(TR.isTrajectory(orbit()), true);
  assert.equal(TR.isTrajectory({ sample: () => 0 }), false);
  const a = TR.bakeTrajectory(orbit(), 60).rows, b = TR.bakeTrajectory(orbit(), 60).rows;
  assert.deepEqual(Array.from(a), Array.from(b));
});

check("T7 framing helpers are shared with framing.js (subject normalisation round trip)", () => {
  const s = FR.normalizeSubject({ center: [0, 0, 1], radius: 1 });
  assert.deepEqual(s.pos, [0, 0, 0]);
  assert.equal(s.height, 2);
  nearV(TR.aimSubject({ subject: s }, "FS")(0), [0, 0, 1], 1e-12);
});

console.log(`film_trajectory: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
