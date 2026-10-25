// tests/drone_tether.test.mjs
//
// WHY: the Drone Deploy craft may only fly where the client already has the
// world — the 3×3 terrain ring around the player's landblock reaches ≥ 192 m,
// so the range sphere is capped at 180 m (SPEC DV-20) — and its battery has to
// warn, trigger exactly ONE automatic return-to-home and force a landing at
// the right moments, or the sequence (scene3d/drone/sequence.js T18 / T19)
// fires twice or never. The return path is what manual_flight.js flies home:
// it must climb, cruise at ≥ 15 m above the ground and descend onto home
// EXACTLY. This suite EXECUTES scene3d/drone/tether.js (pure, no fakes
// needed) and pins SPEC §3.4 / §8.2 drone_tether:
//   T1  TETHER_DEFAULTS values (frozen); signalForDistance (100 → 1, 125 → 0.5,
//       ≥ 150 → 0 at rangeM 150), fade / step / non-finite edges;
//   T2  clamp: 3-D range projection onto the sphere (kind 'range', inward unit
//       normal, limited, distM and signal BEFORE the projection), rangeM
//       clamped to [20, 180] (500 → 180), configure live, reused result;
//   T3  ceiling against groundZ and the home fallback, range wins the report;
//   T4  battery: hover drain empties in batterySec, warn ≤ 0.2, rth exactly
//       once at the 0.1 crossing, empty at 0, throttle clamp, battery off,
//       reset re-arms;
//   T5  planReturn: climb → cruise → descend, cruise ≥ ground + 15 (both
//       ends), last point === home, lengthM = Σ segments, the < 3 m variant,
//       duplicates dropped, fresh arrays, never throws;
//   T6  JSON-safe state(); determinism.
//
// Flag: drone (DEFAULT ON since 2026-10-25, `?drone=off` disables it) — this is its pure tether module.
// Run from apps/holtburger-web/: node tests/drone_tether.test.mjs

import assert from "node:assert/strict";

const T = await import("../scene3d/drone/tether.js");
const { TETHER_DEFAULTS, signalForDistance, createTether } = T;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failed += 1;
    const msg = err && err.message ? String(err.message).split("\n")[0] : String(err);
    console.log(`[FAIL] ${name}: ${msg}`);
  }
}

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b} (±${eps})`);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------------------------------------------------------------------------
// T1 — defaults and the signal curve
// ---------------------------------------------------------------------------

await check("T1 TETHER_DEFAULTS carries the SPEC §3.4 numbers and is frozen", () => {
  assert.deepEqual({ ...TETHER_DEFAULTS }, { rangeM: 150, hardCapM: 180, signalFadeM: 50, ceilingAglM: 120,
    batterySec: 600, warnAt: 0.2, rthAt: 0.1, drainIdle: 0.6, drainPerThrottle: 0.4 });
  assert.ok(Object.isFrozen(TETHER_DEFAULTS));
});

await check("T1 signalForDistance: 1 at ≤ rangeM − 50, linear, 0 at ≥ rangeM (rangeM 150: 100 → 1, 125 → 0.5)", () => {
  assert.equal(signalForDistance(0, 150), 1);
  assert.equal(signalForDistance(100, 150), 1);
  assert.equal(signalForDistance(125, 150), 0.5);
  near(signalForDistance(110, 150), 0.8, 1e-12, "110 m");
  assert.equal(signalForDistance(150, 150), 0);
  assert.equal(signalForDistance(170, 150), 0);
  assert.equal(signalForDistance(400, 150), 0);
  // monotone non-increasing over the whole band
  let prev = 1;
  for (let d = 0; d <= 200; d += 0.5) {
    const s = signalForDistance(d, 150);
    assert.ok(s <= prev + 1e-15 && s >= 0 && s <= 1, `d=${d}: ${s}`);
    prev = s;
  }
});

await check("T1 signalForDistance edges: custom fade, step fade, non-finite distance / range", () => {
  assert.equal(signalForDistance(60, 80, 20), 1);
  assert.equal(signalForDistance(70, 80, 20), 0.5);
  assert.equal(signalForDistance(79.999, 80, 0), 1, "fadeM 0 = a step at rangeM");
  assert.equal(signalForDistance(80, 80, 0), 0);
  assert.equal(signalForDistance(NaN, 150), 0);
  assert.equal(signalForDistance(Infinity, 150), 0);
  assert.equal(signalForDistance(125, NaN), 0.5, "non-finite rangeM → the 150 default");
  assert.equal(signalForDistance(125, 150, NaN), 0.5, "non-finite fadeM → the 50 default");
});

// ---------------------------------------------------------------------------
// T2 — the range sphere
// ---------------------------------------------------------------------------

await check("T2 inside the sphere: unlimited, position unchanged, 3-D distance and signal", () => {
  const t = createTether();
  const home = [1000, 2000, 50];
  const r = t.clamp([1060, 2080, 50], home, 48);
  assert.equal(r.limited, false);
  assert.equal(r.kind, null);
  assert.equal(r.normal, null);
  assert.deepEqual(r.pos, [1060, 2080, 50]);
  near(r.distM, 100, 1e-12, "distM");
  assert.equal(r.signal, 1);
  // 3-D (not horizontal): 120 m straight up and 90 m out = 150 m
  const up = t.clamp([1090, 2000, 50 + 120], home, null);
  near(up.distM, 150, 1e-9, "3-D distance");
  assert.equal(up.limited, false, "exactly on the sphere is not outside it (and below the 120 m ceiling)");
  near(up.signal, 0, 1e-12, "signal at the sphere");
});

await check("T2 outside: projected onto the sphere, kind 'range', inward unit normal, distM / signal before projection", () => {
  const t = createTether();
  const home = [500, 500, 20];
  const p = [500 + 200, 500 + 100, 20 + 50];
  const d = Math.hypot(200, 100, 50);
  const r = t.clamp(p, home, 20);
  assert.equal(r.limited, true);
  assert.equal(r.kind, "range");
  near(dist3(r.pos, home), 150, 1e-9, "on the sphere");
  // same direction from home
  const u = [(p[0] - home[0]) / d, (p[1] - home[1]) / d, (p[2] - home[2]) / d];
  for (let k = 0; k < 3; k++) near(r.pos[k], home[k] + u[k] * 150, 1e-9, `pos[${k}]`);
  near(Math.hypot(...r.normal), 1, 1e-12, "|normal|");
  for (let k = 0; k < 3; k++) near(r.normal[k], -u[k], 1e-12, `normal[${k}] toward home`);
  near(r.distM, d, 1e-9, "distM is the distance before the projection");
  assert.equal(r.signal, 0, "signal from the unprojected distance (> rangeM)");
});

await check("T2 rangeM is clamped to [20, 180] (500 → 180), configure applies live, bad values keep the old one", () => {
  const home = [0, 0, 0];
  const far = [0, 400, 10];
  const t = createTether({ rangeM: 500 });
  assert.equal(t.state().rangeM, 180);
  near(dist3(t.clamp(far, home, 0).pos, home), 180, 1e-9, "the 180 m hard cap");
  assert.equal(createTether({ rangeM: 5 }).state().rangeM, 20);
  assert.equal(createTether({ rangeM: NaN }).state().rangeM, 150);
  assert.equal(createTether({}).state().rangeM, 150);
  t.configure({ rangeM: 60 });
  assert.equal(t.state().rangeM, 60);
  near(dist3(t.clamp(far, home, 0).pos, home), 60, 1e-9, "live range");
  near(t.clamp([0, 25, 0], home, 0).signal, 0.7, 1e-12, "fade over the last 50 m of the new range (35 → 1 at 10)");
  t.configure({ rangeM: "x" });
  assert.equal(t.state().rangeM, 60);
  t.configure({ rangeM: 1000 });
  assert.equal(t.state().rangeM, 180);
  t.configure({ ceilingAglM: 30 });
  assert.equal(t.state().ceilingAglM, 30);
  t.configure({ ceilingAglM: -4 });
  assert.equal(t.state().ceilingAglM, 30);
  t.configure(null);
  assert.equal(t.state().rangeM, 180);
});

await check("T2 clamp reuses its result object and arrays (allocation-free per frame)", () => {
  const t = createTether();
  const a = t.clamp([0, 10, 0], [0, 0, 0], 0);
  const posRef = a.pos;
  const b = t.clamp([0, 400, 0], [0, 0, 0], 0);
  assert.equal(a, b);
  assert.equal(b.pos, posRef);
  const nRef = b.normal;
  const c = t.clamp([300, 0, 0], [0, 0, 0], 0);
  assert.equal(c.normal, nRef, "the range normal array is reused");
  assert.deepEqual(c.normal.map((v) => +v.toFixed(12)), [-1, 0, 0]);
  const e = t.clamp([0, 10, 0], [0, 0, 0], 0);
  assert.equal(e.normal, null);
  assert.equal(e.kind, null);
});

await check("T2 degenerate input never throws: no home = no tether, non-finite pos passes with signal 0", () => {
  const t = createTether();
  const a = t.clamp([1, 2, 3], null, 0);
  assert.equal(a.limited, false);
  assert.equal(a.signal, 1);
  assert.deepEqual(a.pos, [1, 2, 3]);
  const b = t.clamp([NaN, 2, 3], [0, 0, 0], 0);
  assert.equal(b.limited, false);
  assert.equal(b.signal, 0);
  assert.ok(Number.isNaN(b.pos[0]), "passes through for the safety reflex to reject");
  const c = t.clamp(undefined, undefined, undefined);
  assert.equal(c.limited, false);
});

// ---------------------------------------------------------------------------
// T3 — ceiling
// ---------------------------------------------------------------------------

await check("T3 ceiling: z clamped to groundZ + ceilingAglM, kind 'ceiling', normal [0, 0, −1]", () => {
  const t = createTether({ ceilingAglM: 120 });
  const home = [0, 0, 10];
  const r = t.clamp([5, 5, 140], home, 15);
  assert.equal(r.limited, true);
  assert.equal(r.kind, "ceiling");
  assert.deepEqual(r.normal, [0, 0, -1]);
  assert.deepEqual(r.pos, [5, 5, 135]);
  const ok = t.clamp([5, 5, 134.9], home, 15);
  assert.equal(ok.limited, false);
  assert.equal(ok.pos[2], 134.9);
});

await check("T3 ceiling falls back to home[2] when groundZ is null / non-finite", () => {
  const t = createTether({ ceilingAglM: 40 });
  const home = [0, 0, 10];
  assert.deepEqual(t.clamp([1, 1, 60], home, null).pos, [1, 1, 50]);
  assert.deepEqual(t.clamp([1, 1, 60], home, NaN).pos, [1, 1, 50]);
  assert.deepEqual(t.clamp([1, 1, 60], home, undefined).pos, [1, 1, 50]);
  assert.equal(t.clamp([1, 1, 49], home, null).limited, false);
});

await check("T3 both limits: range wins the report, the result is inside both", () => {
  const t = createTether({ rangeM: 150, ceilingAglM: 100 });
  const home = [0, 0, 0];
  const r = t.clamp([0, 10, 200], home, 0); // 200 m straight up: outside the sphere and above the ceiling
  assert.equal(r.kind, "range");
  assert.equal(r.limited, true);
  near(r.normal[2], -Math.cos(Math.atan2(10, 200)), 1e-12, "normal toward home");
  assert.ok(r.pos[2] <= 100 + 1e-9, `z ${r.pos[2]} under the ceiling`);
  assert.ok(dist3(r.pos, home) <= 150 + 1e-9, "inside the sphere");
});

// ---------------------------------------------------------------------------
// T4 — battery
// ---------------------------------------------------------------------------

/** Drain at a constant throttle with a fixed dt; returns the events with their times. */
function runBattery(t, dt, throttle, maxSec) {
  const ev = { warnAt: null, rthAt: [], emptyAt: null, last: null };
  let time = 0;
  for (let i = 0; i < Math.ceil(maxSec / dt); i++) {
    const r = t.drain(dt, throttle);
    time = (i + 1) * dt;
    if (r.warn && ev.warnAt === null) ev.warnAt = time;
    if (r.rth) ev.rthAt.push(time);
    if (r.empty && ev.emptyAt === null) ev.emptyAt = time;
    ev.last = { ...r };
  }
  return ev;
}

await check("T4 hover (throttle 1) empties in batterySec; warn at 20 %, rth exactly once at 10 %, empty at 0", () => {
  const dt = 1 / 60;
  const t = createTether({ batterySec: 120 });
  const ev = runBattery(t, dt, 1, 130);
  near(ev.emptyAt, 120, 2 * dt, "empty time");
  near(ev.warnAt, 120 * 0.8, 2 * dt, "warn time");
  assert.equal(ev.rthAt.length, 1, `rth fired ${ev.rthAt.length}×`);
  near(ev.rthAt[0], 120 * 0.9, 2 * dt, "rth time");
  assert.deepEqual(ev.last, { battery: 0, warn: true, rth: false, empty: true });
  assert.equal(t.state().rthFired, true);
});

await check("T4 drain rate (0.6 + 0.4·clamp(throttle, 0, 2.5)) / batterySec; dt ≤ 0 drains nothing", () => {
  const t = createTether({ batterySec: 100 });
  near(t.drain(1, 0).battery, 1 - 0.6 / 100, 1e-12, "idle");
  t.reset();
  near(t.drain(1, 2.5).battery, 1 - 1.6 / 100, 1e-12, "full thrust");
  t.reset();
  near(t.drain(1, 9).battery, 1 - 1.6 / 100, 1e-12, "throttle clamped at 2.5");
  t.reset();
  near(t.drain(1, -3).battery, 1 - 0.6 / 100, 1e-12, "negative throttle clamped at 0");
  t.reset();
  near(t.drain(1, NaN).battery, 1 - 0.6 / 100, 1e-12, "non-finite throttle counts as 0");
  t.reset();
  assert.equal(t.drain(0, 1).battery, 1);
  assert.equal(t.drain(-5, 1).battery, 1);
  assert.equal(t.drain(NaN, 1).battery, 1);
  assert.equal(t.drain(Infinity, 1).battery, 1);
});

await check("T4 rth fires on the crossing call only, also when one huge dt crosses 0.1 and 0 together", () => {
  const t = createTether({ batterySec: 100 });
  t.reset({ battery: 0.1001 });
  const above = t.drain(0.0001, 1); // −1e-6
  assert.equal(above.rth, false, "still above 0.1");
  assert.ok(above.battery > 0.1);
  const r = t.drain(0.1, 1); // −1e-3: crosses
  assert.equal(r.rth, true, "the crossing call");
  assert.ok(r.battery <= 0.1);
  for (let i = 0; i < 50; i++) assert.equal(t.drain(0.1, 1).rth, false, "never again");
  t.reset();
  const big = t.drain(1000, 1);
  assert.deepEqual({ ...big }, { battery: 0, warn: true, rth: true, empty: true });
  assert.equal(t.drain(1, 1).rth, false);
});

await check("T4 batterySec ≤ 0 = battery off: always {battery: 1, warn: false, rth: false, empty: false}", () => {
  for (const s of [0, -1]) {
    const t = createTether({ batterySec: s });
    for (let i = 0; i < 10; i++) assert.deepEqual({ ...t.drain(100, 2.5) }, { battery: 1, warn: false, rth: false, empty: false });
    assert.equal(t.state().battery, 1);
    assert.equal(t.state().batterySec, s);
  }
  assert.equal(createTether({}).state().batterySec, 600, "default 600 s");
  assert.equal(createTether({ batterySec: NaN }).state().batterySec, 600);
});

await check("T4 reset({battery}) sets the level (clamped) and re-arms the one-shot RTH; drain reuses its object", () => {
  const t = createTether({ batterySec: 10 });
  runBattery(t, 0.1, 1, 12);
  assert.equal(t.state().rthFired, true);
  t.reset({ battery: 0.5 });
  assert.deepEqual(t.state(), { rangeM: 150, ceilingAglM: 120, batterySec: 10, battery: 0.5, rthFired: false });
  const ev = runBattery(t, 0.1, 1, 6);
  assert.equal(ev.rthAt.length, 1);
  t.reset({ battery: 7 });
  assert.equal(t.state().battery, 1);
  t.reset({ battery: -1 });
  assert.equal(t.state().battery, 0);
  t.reset();
  assert.equal(t.state().battery, 1);
  const a = t.drain(0.1, 1), b = t.drain(0.1, 1);
  assert.equal(a, b, "drain returns its reused object");
});

// ---------------------------------------------------------------------------
// T5 — planReturn
// ---------------------------------------------------------------------------

/** Σ of the segment lengths of a polyline. */
const polyLen = (pts) => pts.slice(1).reduce((s, p, i) => s + dist3(p, pts[i]), 0);

await check("T5 far return: [from, climb, cruise end, home] — climb, cruise ≥ ground + 15, descend, lands on home exactly", () => {
  const t = createTether();
  const from = [1100, 2050, 40];
  const home = [1000, 2000, 12.06];
  const r = t.planReturn(from, home, { cruiseAglM: 15, groundZFrom: 30, groundZHome: 12 });
  assert.equal(r.cruiseZ, 45, "max(from z 40, 30 + 15, 12 + 15)");
  assert.deepEqual(r.points, [from, [1100, 2050, 45], [1000, 2000, 45], home]);
  assert.deepEqual(r.points[r.points.length - 1], home, "last point is home exactly");
  near(r.lengthM, polyLen(r.points), 1e-9, "lengthM");
  near(r.lengthM, 5 + Math.hypot(100, 50) + (45 - 12.06), 1e-9, "lengthM value");
  // continuity: the climb is vertical, the cruise level, the descent vertical
  const [a, b, c, d] = r.points;
  assert.ok(b[0] === a[0] && b[1] === a[1] && b[2] >= a[2], "climb");
  assert.ok(c[2] === b[2], "cruise level");
  assert.ok(d[0] === c[0] && d[1] === c[1] && d[2] < c[2], "descend");
});

await check("T5 cruise height covers both ends' ground (+ cruiseAglM) and the from height; defaults to home[2]", () => {
  const t = createTether();
  const home = [0, 0, 10];
  assert.equal(t.planReturn([100, 0, 12], home, { groundZFrom: 50 }).cruiseZ, 65, "high ground under the drone");
  assert.equal(t.planReturn([100, 0, 12], home, { groundZHome: 33 }).cruiseZ, 48, "high ground at home");
  assert.equal(t.planReturn([100, 0, 90], home, { groundZFrom: 50, groundZHome: 33 }).cruiseZ, 90, "already higher");
  assert.equal(t.planReturn([100, 0, 12], home).cruiseZ, 25, "nulls fall back to home[2] + 15");
  assert.equal(t.planReturn([100, 0, 12], home, { groundZFrom: NaN, cruiseAglM: 30 }).cruiseZ, 40);
  assert.equal(t.planReturn([100, 0, 12], home, { cruiseAglM: "x" }).cruiseZ, 25);
});

await check("T5 < 3 m horizontally: [from, over home at max(from z, home z + 1), home]", () => {
  const t = createTether();
  const home = [10, 10, 5];
  const a = t.planReturn([11, 12, 9], home, { groundZFrom: 4, groundZHome: 4 });
  assert.deepEqual(a.points, [[11, 12, 9], [10, 10, 9], home]);
  near(a.lengthM, Math.hypot(1, 2) + 4, 1e-12, "lengthM");
  const low = t.planReturn([11, 10, 5.2], home);
  assert.deepEqual(low.points, [[11, 10, 5.2], [10, 10, 6], home], "rises to home z + 1 first");
  const edge = t.planReturn([13, 10, 9], home); // exactly 3 m → the cruise variant
  assert.equal(edge.points.length, 4);
});

await check("T5 consecutive duplicates are dropped and the last point stays home", () => {
  const t = createTether();
  const home = [0, 0, 10];
  const atCruise = t.planReturn([50, 0, 25], home); // from is already at cruise height
  assert.deepEqual(atCruise.points, [[50, 0, 25], [0, 0, 25], home]);
  near(atCruise.lengthM, 50 + 15, 1e-12, "lengthM");
  const above = t.planReturn([0, 0, 30], home); // straight above home
  assert.deepEqual(above.points, [[0, 0, 30], home]);
  near(above.lengthM, 20, 1e-12, "lengthM");
  for (const r of [atCruise, above]) {
    for (let i = 1; i < r.points.length; i++) assert.ok(dist3(r.points[i], r.points[i - 1]) > 0, "no zero-length segment");
  }
});

await check("T5 fresh arrays every call (a plan, not a per-frame result); inputs untouched; never throws", () => {
  const t = createTether();
  const from = [100, 0, 12], home = [0, 0, 10];
  const a = t.planReturn(from, home), b = t.planReturn(from, home);
  assert.notEqual(a, b);
  assert.notEqual(a.points, b.points);
  assert.notEqual(a.points[0], from, "a copy of from, not the caller's array");
  assert.notEqual(a.points[a.points.length - 1], home, "a copy of home");
  a.points[0][0] = 999;
  a.points[3][2] = -1;
  assert.deepEqual(from, [100, 0, 12]);
  assert.deepEqual(home, [0, 0, 10]);
  assert.deepEqual(b.points[0], [100, 0, 12]);
  assert.deepEqual(t.planReturn(from, null), { points: [[100, 0, 12]], lengthM: 0, cruiseZ: 12 });
  assert.deepEqual(t.planReturn([NaN, 0, 0], home).points, [[0, 0, 10]]);
  assert.deepEqual(t.planReturn(null, null).points, []);
  assert.doesNotThrow(() => t.planReturn(from, home, null));
});

// ---------------------------------------------------------------------------
// T6 — state, determinism
// ---------------------------------------------------------------------------

await check("T6 state() is plain JSON-safe data and a fresh object", () => {
  const t = createTether({ rangeM: 90, ceilingAglM: 60, batterySec: 300 });
  t.drain(30, 1);
  const s = t.state();
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.deepEqual(Object.keys(s).sort(), ["batterySec", "battery", "ceilingAglM", "rangeM", "rthFired"].sort());
  near(s.battery, 0.9, 1e-12, "battery");
  assert.notEqual(t.state(), s);
});

await check("T6 identical input streams give deep-equal outputs", () => {
  const run = () => {
    const t = createTether({ rangeM: 120, ceilingAglM: 50, batterySec: 60 });
    const rows = [];
    for (let i = 0; i < 4000; i++) {
      const a = i * 0.013;
      const pos = [Math.sin(a) * i * 0.05, Math.cos(a * 0.7) * i * 0.04, 10 + (i % 97)];
      const c = t.clamp(pos, [0, 0, 5], i % 3 === 0 ? null : 4);
      const b = t.drain(1 / 60, (i % 50) / 20);
      rows.push([...c.pos, c.signal, c.limited, c.kind, c.normal ? [...c.normal] : null, c.distM, b.battery, b.warn, b.rth, b.empty]);
    }
    rows.push(t.planReturn([80, -40, 33], [0, 0, 5], { groundZFrom: 20, groundZHome: 4 }));
    return rows;
  };
  assert.deepEqual(run(), run());
});

console.log(`drone_tether: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
