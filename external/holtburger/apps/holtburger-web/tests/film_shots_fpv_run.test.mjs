// tests/film_shots_fpv_run.test.mjs
//
// WHY: fpv.fpv-run is the long FPV piece of a film (the Egg Orchard run: an
// entrance drop down twelve dungeon levels to the exit portal, ≈ 100–130 s, with
// tricks at the big spaces). The director writes it as plan JSON — a racing line
// in shot.path, a speed plan in `zones`, tricks in `tricks` — and the take
// player flies it through the fpv flight model with the JEV pilot frozen in the
// trick windows. This suite EXECUTES the technique through the real registry
// (shots/index.js) and proves:
//   F1  catalog: registered with the DESIGN §2 params and defaults; `zones` /
//       `tricks` are registry `list` params whose item schema (and per-type
//       variants) is in the JSON catalog; bounds; needs;
//   F2  exact duration (with and without time-adding tricks), pure in t;
//   F3  the speed plan: zones honoured (peak ≤ zone speed × 1.05), the fitted
//       cruise outside them, overspeed reported when the line cannot fit;
//   F4  every trick in meta.tricks with its window, skipped ones with a reason,
//       meta.lockWindows = the merged trick windows;
//   F5  validate ok WITH meta.validate (and the same loops fail the default 240°/s
//       — the meta limits are what makes them legal);
//   F6  the throttle bob and wobble are seeded: identical spec → identical take,
//       another seed → another bob (≤ throttleBobM), throttleBobM 0 → no bob;
//   F7  FPV body attitude: start hover holds, a punch dips the view, braking
//       flares it, a turn banks into it, throttle ≈ 1 g in the hover;
//   F8  a dungeon-like line (90° corners, a ramp, an 18 m vertical shaft) with a
//       dive flies within 0.6 m tracking, validates, stays near the line, and the
//       heading turns smoothly through the shaft;
//   F9  context: ctx.path wins over ctx.indoor.route, a missing line is
//       MISSING_CONTEXT, a coincident line hovers; ends 'cruise';
//   F10 list params: readable BAD_PARAM errors naming the list (details.param),
//       the item path, unknown fields with suggestions, zone s1 ≤ s0 — and the
//       plan validator's param-only probe (invalid framing) stops at them.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure shot modules.
// Run from apps/holtburger-web/: node tests/film_shots_fpv_run.test.mjs

import assert from "node:assert/strict";

const SH = await import("../scene3d/film/shots/index.js");
const DR = await import("../scene3d/film/shots/drone.js");
const TR = await import("../scene3d/film/shots/trajectory.js");
const FL = await import("../scene3d/film/drone/flight_model.js");
const FT = await import("../scene3d/film/shots/fpv_tricks.js");
const { FilmShotError } = await import("../scene3d/film/core/errors.js");

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
function shotErr(code, re) {
  return (e) => {
    assert.ok(e instanceof FilmShotError, `expected FilmShotError, got ${e && e.name}: ${e && e.message}`);
    assert.equal(e.code, code, `code (message: ${e.message})`);
    if (re) assert.match(e.message, re);
    return true;
  };
}

const DEG = Math.PI / 180;
const ID = "fpv.fpv-run";
const build = (params, ctx, duration = 30, extra = {}) => SH.buildShot({ technique: ID, duration, params, ...extra }, ctx);
/** Speed of the nominal at t (central difference, optionally horizontal only). */
function speed(tr, t, horiz = false) {
  const h = 0.005;
  const a = tr.sample(Math.max(0, t - h)).pos, b = tr.sample(Math.min(tr.duration, t + h)).pos;
  const dt = Math.min(tr.duration, t + h) - Math.max(0, t - h);
  return (horiz ? Math.hypot(b[0] - a[0], b[1] - a[1]) : Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])) / dt;
}
function issues(v) {
  return v.issues.slice(0, 3).map((i) => i.message).join(" | ");
}

const STRAIGHT = [[0, 0, 3], [300, 0, 3]];
/** A loop-friendly run: 120 m straight east, a 90° turn, 60 m north. */
const LSHAPE = [[0, 0, 4], [120, 0, 4], [120, 60, 4]];

// ---------------------------------------------------------------------------
console.log("F1 catalog");
// ---------------------------------------------------------------------------
check("registered as fpv.fpv-run with the DESIGN §2 params / defaults, list params documented in the JSON catalog", () => {
  const def = SH.getTechnique(ID);
  assert.ok(def, "registered");
  assert.equal(def.family, "fpv");
  assert.ok(DR.FPV_TECHNIQUES.some((d) => d.id === ID));
  const want = {
    speed: 8, speedMax: 16, amax: 9, alat: 12, cornerRadius: 2, lookAhead: 5, uptiltDeg: 25, lookAlongPath: 0.55, bankGain: 1.2,
    maxBankDeg: 60, throttleBobM: 0.1, bobHz: 1.1, wobbleDeg: 0.4, propwashDeg: 0.8, startHoldSec: 0.8, ends: "rest",
  };
  for (const [k, v] of Object.entries(want)) assert.equal(def.params[k].default, v, `${k} default`);
  assert.deepEqual(def.params.ends.values.slice(), ["rest", "cruise"]);
  assert.equal(def.params.zones.type, "list");
  assert.equal(def.params.tricks.type, "list");
  const cat = SH.listTechniques({ family: "fpv" }).find((e) => e.id === ID);
  assert.deepEqual(JSON.parse(JSON.stringify(cat)), cat, "JSON-safe");
  assert.deepEqual(cat.params.zones.default, []);
  assert.deepEqual(Object.keys(cat.params.zones.item), ["s0", "s1", "speed"]);
  assert.equal(cat.params.tricks.item.type.type, "enum");
  assert.deepEqual(cat.params.tricks.item.type.values, FT.FPV_TRICK_TYPES.slice());
  assert.equal(cat.params.tricks.variants.key, "type");
  assert.deepEqual(Object.keys(cat.params.tricks.variants.fields).sort(), FT.FPV_TRICK_TYPES.slice().sort());
  assert.equal(cat.params.tricks.variants.fields.float.hangSec.optional, true);
  assert.equal(cat.params.tricks.variants.fields["power-loop"].radius.default, 3);
  assert.equal(cat.params.tricks.item.s.required, true);
  assert.ok(cat.params.tricks.maxItems >= 16);
  assert.deepEqual({ ...def.defaultBounds }, { maxLateral: 1, maxRise: 0.8, maxSink: 0.5, minSpeedScale: 0.6, maxSpeedScale: 1.1, maxDistanceScale: 1 });
  assert.deepEqual({ ...def.needs }, { subject: false, path: false, indoor: null });
  assert.ok(def.tags.includes("trick") && def.tags.includes("dungeon"));
});

// ---------------------------------------------------------------------------
console.log("F2 duration");
// ---------------------------------------------------------------------------
check("exact duration with and without time-adding tricks; t clamps; pure in t", () => {
  for (const [D, tricks] of [[17.3, []], [31.7, [{ type: "power-loop", s: 60 }]], [44.9, [{ type: "power-loop", s: 40 }, { type: "float", s: 90 }, { type: "roll", s: 140 }]]]) {
    const tr = build({ tricks }, { path: LSHAPE }, D);
    assert.equal(tr.duration, D);
    assert.equal(tr.sample(D).t, D);
    assert.deepEqual(tr.sample(D + 5).pos, tr.sample(D).pos, "clamps at the end");
    for (const t of tr.meta.tricks) assert.ok(!t.skipped, `${t.type}: ${t.reason}`);
    const ts = [0.61 * D, 0.13 * D, 0.61 * D];
    assert.deepEqual(tr.sample(ts[0]), tr.sample(ts[2]), "pure");
    // the run reaches the end of the line at the end of the shot
    near(Math.hypot(tr.sample(D).pos[0] - 120, tr.sample(D).pos[1] - 60), 0, 0.05, "ends at the end of the line");
  }
  const lp = build({ tricks: [{ type: "power-loop", s: 60 }] }, { path: LSHAPE }, 31.7);
  const L = lp.meta.tricks[0];
  assert.ok(L.t1 - L.t0 > 3, `the loop adds its own time (${(L.t1 - L.t0).toFixed(2)} s)`);
});

// ---------------------------------------------------------------------------
console.log("F3 speed plan");
// ---------------------------------------------------------------------------
check("zones are honoured (peak ≤ zone speed × 1.05); the fitted cruise runs outside them; meta reports the plan", () => {
  const zones = [{ s0: 60, s1: 100, speed: 3 }, { s0: 180, s1: 230, speed: 6 }];
  const tr = build({ speed: 12, speedMax: 14, zones }, { path: STRAIGHT }, 50);
  assert.equal(tr.meta.overspeed, false);
  const pk = [0, 0];
  let outside = 0;
  for (let t = 0.02; t < 50; t += 0.02) {
    const x = tr.sample(t).pos[0];
    const v = speed(tr, t);
    zones.forEach((z, i) => { if (x >= z.s0 && x <= z.s1) pk[i] = Math.max(pk[i], v); });
    if (x > 120 && x < 160) outside = Math.max(outside, v);
  }
  zones.forEach((z, i) => assert.ok(pk[i] <= z.speed * 1.05, `zone ${i}: peak ${pk[i].toFixed(3)} > ${z.speed}`));
  assert.ok(outside > 8, `between the zones the run speeds up again (${outside.toFixed(2)} m/s)`);
  near(tr.meta.lengthM, 300, 0.01, "lengthM");
  assert.deepEqual(tr.meta.zones.map((z) => z.applied), [true, true]);
  assert.ok(tr.meta.cruiseSpeed > 6 && tr.meta.cruiseSpeed <= 14 + 1e-9, `cruise ${tr.meta.cruiseSpeed}`);
  // meta.peakSpeed ≈ the measured peak (the take player's flight check reads it)
  let pkAll = 0;
  for (let t = 0.01; t < 50; t += 1 / 60) pkAll = Math.max(pkAll, speed(tr, t));
  near(tr.meta.peakSpeed, pkAll, 0.05 * pkAll, "meta.peakSpeed");
});

check("a line too long for the shot is time-compressed and flagged overspeed; a feasible one is not", () => {
  const fast = build({ speed: 8, speedMax: 10 }, { path: STRAIGHT }, 12);
  assert.equal(fast.meta.overspeed, true);
  assert.equal(fast.duration, 12);
  near(fast.sample(12).pos[0], 300, 0.05, "still covers the line in the shot");
  assert.equal(build({}, { path: STRAIGHT }, 45).meta.overspeed, false);
});

// ---------------------------------------------------------------------------
console.log("F4 tricks + lock windows");
// ---------------------------------------------------------------------------
check("every trick lands in meta.tricks (input order) with its window; skipped ones carry a reason; lockWindows merge the windows", () => {
  const tricks = [
    { type: "float", s: 20, rise: 3 },
    { type: "dip", s: 22 },               // overlaps the float → skipped
    { type: "power-loop", s: 70 },
    { type: "split-s", s: 100 },          // the line never comes back → skipped
    { type: "roll", s: 125, dir: "left" }, // in the corner region: allowed (attitude only)
    { type: "yaw-spin", s: 400 },          // beyond the line → skipped
  ];
  const tr = build({ tricks }, { path: LSHAPE }, 40);
  const m = tr.meta.tricks;
  assert.deepEqual(m.map((t) => t.type), tricks.map((t) => t.type));
  assert.deepEqual(m.map((t) => t.s), tricks.map((t) => t.s));
  const by = (i) => m[i];
  for (const i of [0, 2, 4]) {
    assert.ok(!by(i).skipped, `${by(i).type}: ${by(i).reason}`);
    assert.ok(Number.isFinite(by(i).t0) && by(i).t1 > by(i).t0);
  }
  assert.match(by(1).reason, /overlaps the float at s=20/);
  assert.match(by(3).reason, /no re-join point/);
  assert.match(by(5).reason, /beyond the end of the racing line/);
  for (const i of [1, 3, 5]) assert.equal(by(i).t0, null);
  const wins = [0, 2, 4].map((i) => [by(i).t0, by(i).t1]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(tr.meta.lockWindows, wins);
  assert.equal(by(0).rise, 3);
  assert.ok(by(2).heightM > 5.5 && by(2).sEnd > 70, "loop meta");
  // a loop on a steep line is refused
  const steep = build({ tricks: [{ type: "power-loop", s: 10 }] }, { path: [[0, 0, 40], [30, 0, 0]] }, 10);
  assert.match(steep.meta.tricks[0].reason, /too steep/);
  // keyframes mark the trick starts
  assert.ok(tr.keyframes.some((k) => k.label === "float@20"));
});

check("indoor headroom: a float under a low ceiling is lowered (or skipped); a loop that does not fit is skipped", () => {
  const indoor = { route: LSHAPE, floor: () => 2.5, ceiling: () => 8 };
  const tr = build({ tricks: [{ type: "float", s: 20, rise: 6 }, { type: "power-loop", s: 70 }] }, { indoor }, 40);
  const [f, lp] = tr.meta.tricks;
  assert.ok(!f.skipped && f.rise < 6 && f.rise <= 8 - 0.6 - 4 + 1e-9, `float lowered to ${f.rise}`);
  assert.ok(f.notes && f.notes.some((n) => /ceiling/.test(n)));
  assert.match(lp.reason, /no headroom/);
  for (let t = 0; t <= 40; t += 0.05) assert.ok(tr.sample(t).pos[2] <= 8 - 0.3 + 1e-6, "under the ceiling");
});

// ---------------------------------------------------------------------------
console.log("F5 validation limits");
// ---------------------------------------------------------------------------
check("validate ok with meta.validate (900°/s) — the same loop + roll fail the default 240°/s without it", () => {
  const tr = build({ tricks: [{ type: "power-loop", s: 50 }, { type: "roll", s: 100, durationSec: 0.9 }] }, { path: LSHAPE }, 35);
  assert.deepEqual(tr.meta.validate, { maxAngularSpeedDeg: 900 });
  const v = TR.validateTrajectory(tr);
  assert.ok(v.ok, issues(v));
  assert.equal(v.limits.maxAngularSpeedDeg, 900);
  const strict = TR.validateTrajectory(tr, { useMetaLimits: false });
  assert.ok(!strict.ok && strict.counts["angular-spike"] > 0, "fails at 240°/s");
  // a baked table carries the meta (the take player validates tables too)
  assert.ok(TR.validateTrajectory(TR.bakeTrajectory(tr, 30)).ok);
});

// ---------------------------------------------------------------------------
console.log("F6 seeded bob / wobble");
// ---------------------------------------------------------------------------
check("bob and wobble are reproducible from the seed; another seed moves the bob only (≤ throttleBobM); throttleBobM 0 → no bob", () => {
  const a = build({}, { path: STRAIGHT }, 40, { seed: 7 });
  const b = build({}, { path: STRAIGHT }, 40, { seed: 7 });
  const c = build({}, { path: STRAIGHT }, 40, { seed: 8 });
  assert.equal(TR.bakeTrajectory(a, 30).checksum, TR.bakeTrajectory(b, 30).checksum, "same seed → same take");
  let maxDz = 0, maxDxy = 0, maxDq = 0;
  for (let t = 0; t <= 40; t += 0.1) {
    const p = a.sample(t), q = c.sample(t);
    maxDz = Math.max(maxDz, Math.abs(p.pos[2] - q.pos[2]));
    maxDxy = Math.max(maxDxy, Math.hypot(p.pos[0] - q.pos[0], p.pos[1] - q.pos[1]));
    maxDq = Math.max(maxDq, Math.acos(Math.min(1, Math.abs(p.q[0] * q.q[0] + p.q[1] * q.q[1] + p.q[2] * q.q[2] + p.q[3] * q.q[3]))) * 2);
  }
  assert.ok(maxDz > 0.02 && maxDz <= 2 * 0.1 + 1e-9, `bob difference ${maxDz}`);
  assert.ok(maxDxy < 1e-9, "the bob is vertical");
  assert.ok(maxDq > 0.1 * DEG && maxDq < 6 * DEG, `wobble difference ${(maxDq / DEG).toFixed(2)}°`);
  const still = build({ throttleBobM: 0 }, { path: STRAIGHT }, 40, { seed: 7 });
  const still2 = build({ throttleBobM: 0 }, { path: STRAIGHT }, 40, { seed: 8 });
  for (let t = 0; t <= 40; t += 0.5) assert.deepEqual(still.sample(t).pos, still2.sample(t).pos);
  // idle bob in the start hover: the craft bobs vertically in place
  const zs = [];
  for (let t = 0; t <= 0.8; t += 0.02) { zs.push(a.sample(t).pos[2]); near(a.sample(t).pos[0], 0, 1e-6, "hover holds x"); }
  assert.ok(Math.max(...zs) - Math.min(...zs) > 0.005, "it bobs");
});

// ---------------------------------------------------------------------------
console.log("F7 FPV body attitude");
// ---------------------------------------------------------------------------
check("hover → punch dips the view, cruise in between, braking flares it; throttle ≈ 1 g hovering; turns bank into the turn", () => {
  const tr = build({ speed: 12, speedMax: 12, zones: [{ s0: 150, s1: 200, speed: 3 }], throttleBobM: 0, wobbleDeg: 0, propwashDeg: 0 }, { path: STRAIGHT }, 40);
  const hover = tr.sample(0.4);
  near(tr.meta.throttleAt(0.4), 1, 0.05, "hover throttle");
  near(hover.p, 0.45 * 25 * DEG, 1 * DEG, "hover: (1 − lookAlongPath)·uptilt");
  // punch: the strongest forward acceleration right after the hover
  let punchP = Infinity, brakeP = -Infinity;
  for (let t = 0.8; t < 4; t += 0.02) punchP = Math.min(punchP, tr.sample(t).p);
  // braking into the 3 m/s zone at x = 150
  for (let t = 4; t < 40; t += 0.02) if (tr.sample(t).pos[0] < 150 && tr.sample(t).pos[0] > 100) brakeP = Math.max(brakeP, tr.sample(t).p);
  let cruiseP = null;
  for (let t = 2; t < 40; t += 0.05) if (Math.abs(speed(tr, t) - tr.meta.cruiseSpeed) < 0.01 && tr.sample(t).pos[0] < 100) { cruiseP = tr.sample(t).p; break; }
  assert.ok(cruiseP !== null, "a cruise sample");
  assert.ok(punchP < hover.p - 10 * DEG && punchP < cruiseP - 5 * DEG, `punch dips: ${(punchP / DEG).toFixed(1)}° vs hover ${(hover.p / DEG).toFixed(1)}°, cruise ${(cruiseP / DEG).toFixed(1)}°`);
  assert.ok(brakeP > cruiseP + 10 * DEG, `brake flares: ${(brakeP / DEG).toFixed(1)}° vs cruise ${(cruiseP / DEG).toFixed(1)}°`);
  assert.ok(tr.meta.throttleAt(1.5) > 1.15, `punch throttle ${tr.meta.throttleAt(1.5)}`);
  // ends at rest: horizontal speed → 0 at both ends
  near(speed(tr, 0, true), 0, 1e-6, "rest start");
  near(speed(tr, 40, true), 0, 0.02, "rest end");
  // a left turn banks left (roll < 0), a right turn right
  for (const [pts, sgn] of [[LSHAPE, -1], [[[0, 0, 4], [120, 0, 4], [120, -60, 4]], 1]]) {
    const t2 = build({ throttleBobM: 0, wobbleDeg: 0, propwashDeg: 0 }, { path: pts }, 25);
    let ext = 0;
    for (let t = 0; t <= 25; t += 0.05) { const r = t2.sample(t).r; if (Math.abs(r) > Math.abs(ext)) ext = r; }
    assert.equal(Math.sign(ext), sgn, `bank sign ${(ext / DEG).toFixed(1)}°`);
    assert.ok(Math.abs(ext) > 15 * DEG && Math.abs(ext) <= 60 * DEG + 1e-9, `bank ${(ext / DEG).toFixed(1)}°`);
  }
});

// ---------------------------------------------------------------------------
console.log("F8 dungeon-like line");
// ---------------------------------------------------------------------------
// corridors 1.6 m above the floor with 90° turns, a 6 m ramp down, then an 18 m vertical shaft and on
const DUNGEON = [[0, 0, 1.6], [20, 0, 1.6], [20, 15, 1.6], [35, 15, 1.6], [50, 15, -4.4], [60, 15, -4.4], [60, 25, -4.4], [60, 25, -22.4],
  [60, 40, -22.4], [45, 40, -22.4], [45, 55, -22.4]];
check("90° corners + a ramp + an 18 m vertical shaft (with a dive): tracking ≤ 0.6 m, validates, stays on the line, heading smooth through the shaft", () => {
  const sTop = DR.fpvRunLine(DUNGEON).nearestS([60, 25, -4.4]);
  const tr = build({ tricks: [{ type: "dive", s: +(sTop - 1.5).toFixed(2) }, { type: "float", s: 5, rise: 1.2 }] }, { indoor: { route: DUNGEON } }, 32);
  const [dive, flt] = tr.meta.tricks;
  assert.ok(!dive.skipped && dive.steepM === 18, JSON.stringify(dive));
  assert.ok(!flt.skipped, JSON.stringify(flt));
  const v = TR.validateTrajectory(tr);
  assert.ok(v.ok, issues(v));
  const f = FL.flyTrajectory(tr, "fpv");
  assert.ok(f.meta.flight.maxTrackingErrorM <= 0.6, `tracking ${f.meta.flight.maxTrackingErrorM.toFixed(3)} m`);
  // near the racing line outside the float (fillets + smoothing cut corners by < 1 m)
  const line = DR.fpvRunLine(DUNGEON);
  for (let t = 0; t <= 32; t += 0.1) {
    if (t >= flt.t0 && t <= flt.t1) continue;
    const p = tr.sample(t).pos;
    const s = line.nearestS(p);
    const q = line.at(s);
    assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.3, `t=${t.toFixed(1)} off the line by ${Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]).toFixed(3)} m`);
  }
  // the dive speeds up down the shaft and the camera looks down it with the uptilt showing
  let vMax = 0;
  for (let t = dive.t0; t <= dive.bottomT; t += 0.02) vMax = Math.max(vMax, speed(tr, t));
  assert.ok(vMax > tr.meta.cruiseSpeed * 1.2, `dive speed ${vMax.toFixed(2)} vs cruise ${tr.meta.cruiseSpeed.toFixed(2)}`);
  const mid = tr.sample((dive.t0 + dive.bottomT) / 2);
  near(mid.p, (-80 + 25) * DEG, 8 * DEG, "camera pitch in the dive");
  // heading turns smoothly (no heading-flip) — the shaft continues north then turns west: total ≈ −90°
  assert.equal(v.counts["heading-flip"], 0);
  near(tr.sample(32).h - tr.sample(0).h, -90 * DEG + 0 * DEG, 25 * DEG, "net heading (east → north … west → north)");
});

check("a chute that comes out the other way (down a shaft, back under itself) turns the heading smoothly, never snaps 180°", () => {
  const chute = [[0, 0, 2], [30, 0, 2], [30, 0, -10], [0, 0, -10]];
  const tr = build({}, { indoor: { route: chute } }, 14);
  const v = TR.validateTrajectory(tr, { fps: 60 });
  assert.ok(v.ok, issues(v));
  assert.ok(v.stats.maxAngularSpeedDeg < 360, `turns at ${v.stats.maxAngularSpeedDeg.toFixed(0)}°/s`);
  near(Math.abs(tr.sample(14).h - tr.sample(0).h), Math.PI, 0.2, "heading reversed");
});

// ---------------------------------------------------------------------------
console.log("F9 context");
// ---------------------------------------------------------------------------
check("ctx.path wins over ctx.indoor.route; no line → MISSING_CONTEXT; a coincident line hovers; ends 'cruise' starts and ends at speed", () => {
  const both = build({}, { path: STRAIGHT, indoor: { route: LSHAPE } }, 40);
  near(both.sample(40).pos[0], 300, 0.05, "flies ctx.path");
  assert.throws(() => build({}, { anchor: [0, 0, 0] }, 10), shotErr("MISSING_CONTEXT", /racing line/));
  assert.throws(() => build({}, { indoor: {} }, 10), shotErr("MISSING_CONTEXT", /ctx\.path \(shot\.path\) or ctx\.indoor\.route/));
  const still = build({ tricks: [{ type: "float", s: 0 }] }, { indoor: { route: [[5, 5, 1.5], [5, 5, 1.5]] } }, 4);
  assert.ok(TR.validateTrajectory(still).ok);
  near(Math.hypot(still.sample(2).pos[0] - 5, still.sample(2).pos[1] - 5), 0, 1e-9, "hovers in place");
  assert.match(still.meta.tricks[0].reason, /too short/);
  const cr = build({ ends: "cruise" }, { path: STRAIGHT }, 30);
  near(speed(cr, 0.01), 10, 0.3, "starts at speed");
  near(speed(cr, 29.99), 10, 0.3, "ends at speed");
  near(cr.meta.startHoldSec, 0, 1e-12);
  const f = FL.flyTrajectory(cr, "fpv");
  assert.ok(f.meta.flight.maxTrackingErrorM <= 0.6);
});

// ---------------------------------------------------------------------------
console.log("F10 list params");
// ---------------------------------------------------------------------------
check("bad zones / tricks are readable BAD_PARAMs naming the list, the item path and the fix", () => {
  const bad = (params) => {
    try {
      build(params, { path: STRAIGHT }, 10);
    } catch (e) {
      return e;
    }
    assert.fail("expected a BAD_PARAM");
  };
  let e = bad({ tricks: [{ type: "flaot", s: 3 }] });
  assert.ok(e instanceof FilmShotError && e.code === "BAD_PARAM");
  assert.equal(e.details.param, "tricks");
  assert.equal(e.details.path, "tricks[0].type");
  assert.match(e.message, /tricks\[0\]\.type" must be one of "float" \| "roll"/);
  e = bad({ tricks: [{ type: "power-loop", s: 3, radus: 4 }] });
  assert.match(e.message, /item \[0\] \("power-loop"\): unknown field "radus" \(did you mean "radius"\?\) — valid fields: type, s, radius/);
  assert.equal(e.details.param, "tricks");
  e = bad({ tricks: [{ type: "float", s: 3, radius: 4 }] });
  assert.match(e.message, /unknown field "radius"/, "a variant's fields belong to its type only");
  e = bad({ tricks: [{ type: "roll" }] });
  assert.match(e.message, /field "s" is required/);
  e = bad({ tricks: [{ type: "dive", s: 5, pitchDeg: -10 }] });
  assert.match(e.message, /tricks\[0\]\.pitchDeg" must be in \[-90, -30\] deg/);
  e = bad({ zones: [{ s0: 50, s1: 20, speed: 3 }] });
  assert.match(e.message, /zones" item \[0\]: s1 \(20\) must be greater than s0 \(50\)/);
  e = bad({ zones: { s0: 1 } });
  assert.match(e.message, /must be a list \(array\) of \{s0, s1, speed\} items/);
  e = bad({ tricks: [3] });
  assert.match(e.message, /item \[0\] must be an object/);
  // defaults are filled per item and never shared between builds
  const tr = build({ tricks: [{ type: "power-loop", s: 50 }] }, { path: LSHAPE }, 30);
  assert.deepEqual(tr.meta.spec.params.tricks, [{ type: "power-loop", s: 50, radius: 3 }]);
  assert.deepEqual(SH.getTechnique(ID).params.tricks.default.slice(), []);
});

check("the plan validator's param-only probe (invalid framing) stops at a bad list item with details.param = the list", () => {
  const probe = (params) => {
    try {
      SH.buildShot({ technique: ID, duration: 1, params, framing: "\u0000plan-param-probe" }, {});
    } catch (e) {
      return e;
    }
    return null;
  };
  const e1 = probe({ tricks: [{ type: "split-s", s: 4, radius: 99 }] });
  assert.equal(e1.code, "BAD_PARAM");
  assert.equal(e1.details.param, "tricks");
  const e2 = probe({ tricks: [{ type: "split-s", s: 4 }], zones: [{ s0: 0, s1: 9, speed: 4 }] });
  assert.notEqual(e2.code, "BAD_PARAM", "valid lists pass the param stage (the probe then fails on the framing)");
});

console.log(`film_shots_fpv_run: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
