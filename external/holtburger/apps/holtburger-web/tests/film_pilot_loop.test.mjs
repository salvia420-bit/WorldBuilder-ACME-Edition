// tests/film_pilot_loop.test.mjs
//
// WHY: the AC Film Mode pilot turns JEV / code-policy answers into the camera's
// residual setpoint several times a second while a take is recorded. The prior
// art (jev-drone, jevs-fly, mikespins' pipelined DOOM bot) found the failure
// modes that ruin footage or burn money: dithering between maneuvers, acting on
// a stale answer (a stale "sink" carrying the camera down), answers about an
// older scene overwriting a newer one, re-asking for an unchanged scene, an
// unbounded pipeline, and a hung bridge freezing the take. This suite executes
// the real modules with an injected clock (plain numbers — no real timers) and a
// fake bridge whose latency and answers the test controls:
//   L1  mapper.js  commit window, high-risk override, low-confidence decay toward
//                  neutral, stale answers frozen (never descend), return-to-path
//                  only toward clear sides, every channel rate-limited and
//                  clamped to the shot bounds, occluder / framing / lost mapping;
//   L2  pilot.js   consult gating, code mode, JEV pipelining (≤ maxInFlight,
//                  ≥ dispatch interval, sequence numbers, older answers dropped,
//                  duplicates skipped), fingerprint reuse ≤ reuseSec, bridge
//                  errors / malformed answers / timeouts → code fallback for that
//                  tick, shadow agreement, stepped determinism + timeout, reset,
//                  telemetry / stats / logs.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure pilot modules.
// Run from apps/holtburger-web/: node tests/film_pilot_loop.test.mjs

import assert from "node:assert/strict";

const M = await import("../scene3d/film/pilot/mapper.js");
const PL = await import("../scene3d/film/pilot/pilot.js");
const P = await import("../scene3d/film/pilot/policy_code.js");
const Q = await import("../scene3d/film/pilot/questions.js");
const S = await import("../scene3d/film/pilot/scene_state.js");
const R = await import("../scene3d/film/core/rng.js");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err && err.message ? err.message : err}`);
  }
}

const I = Infinity;
const DEG = Math.PI / 180;
const EPS = 1e-9;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
/** Let resolved bridge promises run their .then callbacks (no wall-clock timing involved). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A complete open-air SensorFrame (SPEC §3.1) with overrides merged one level deep. */
function frame(over = {}) {
  const f = {
    t: 0,
    pose: { pos: [0, 0, 10], h: 0, p: 0, r: 0, q: [1, 0, 0, 0], fov: 60 },
    speedMps: 4,
    sectors: {
      far_left: { range: I, kind: null },
      left: { range: I, kind: null },
      center: { range: I, kind: null },
      right: { range: I, kind: null },
      far_right: { range: I, kind: null },
    },
    freeAhead: { level: I, above: I, below: I },
    sides: { left: I, right: I, up: I, down: I, back: I },
    nearest: { range: I, kind: null, bearingDeg: 0, elevDeg: 0 },
    pathAhead: { ttc: I, kind: null },
    subject: { visibleFrac: 1, unseenSec: 0, ndc: [0, 0], sizeRatio: 1, occluderKind: null },
    particles: { onLens: null, inView: [] },
    limits: { canRise: true, canSink: true, roomLeft: 5, roomRight: 5, ceiling: I },
    ages: {},
  };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && f[k] && typeof f[k] === "object") f[k] = { ...f[k], ...v };
    else f[k] = v;
  }
  return f;
}

const OPEN = frame();
// Tree 3 m ahead-left: consult needed (within 6 m); the code policy says drift_right.
const TREE = frame({ sectors: { left: { range: 3, kind: "tree" } }, nearest: { range: 3, kind: "tree", bearingDeg: -16 } });
const CTX = { standingOrder: "Glide past the tree line toward the lifestone.", technique: "drone.flyover", goal: "reveal" };

/** Decisions-API answers for maneuver etc. (mapper tests). */
function ans(m, o = {}) {
  const a = {
    maneuver: { type: "choice", choice: m, confidence: o.conf === undefined ? 1 : o.conf },
    risk: { type: "score", score: o.risk ?? 0, confidence: 1 },
  };
  if (o.conf === null) delete a.maneuver.confidence;
  if (o.probs) a.maneuver.probabilities = o.probs;
  if (o.lost != null) a.subject_lost = { type: "noul", noul: o.lost };
  if (o.occ) a.occluder_action = { type: "choice", choice: o.occ, confidence: o.occConf ?? 1 };
  if (o.fr) a.framing = { type: "choice", choice: o.fr, confidence: o.frConf ?? 1 };
  return a;
}

/** Apply the same answers from t0 to t1 in steps of dt; returns the setpoints. */
function run(mapper, answers, t0, t1, dt, ctx = {}) {
  const out = [];
  for (let t = t0; t <= t1 + 1e-9; t += dt) out.push(mapper.apply(typeof answers === "function" ? answers(t) : answers, { now: t, ...ctx }));
  return out;
}

/** A JEV-like response for a bridge payload: code answers with overrides, probabilities in REVERSED key order. */
function jevAnswers(payload, over = {}, extra = {}) {
  const answers = JSON.parse(JSON.stringify(P.codePolicy(null, payload.state, { questions: payload.questions })));
  for (const [id, v] of Object.entries(over)) {
    const a = answers[id];
    if (a.type === "choice") {
      const keys = Object.keys(payload.questions[id].criteria).reverse();
      a.choice = v;
      delete a.confidence;
      a.probabilities = Object.fromEntries(keys.map((k) => [k, k === v ? 0.9 : 0.1 / (keys.length - 1)]));
    } else if (a.type === "score") {
      a.score = v;
      a.probabilities = { 2: v === 2 ? 0.9 : 0.05, 1: v === 1 ? 0.9 : 0.05, 0: v === 0 ? 0.9 : 0.05 };
      delete a.confidence;
    } else a.noul = v;
  }
  return { answers, usage: { inputTokens: 900, outputTokens: 0, costUsd: 0.0000378 }, ms: 150, id: `dec-${payload.seq}`, seq: payload.seq, ...extra };
}

/** A bridge whose answers and latency the test controls. */
function fakeBridge(opts = {}) {
  const pending = [];
  const calls = [];
  return {
    available: opts.available ?? true,
    calls,
    pending,
    request(payload) {
      calls.push(payload);
      if (opts.auto) return Promise.resolve().then(() => opts.auto(payload));
      return new Promise((resolve, reject) => pending.push({ payload, resolve, reject }));
    },
    answer(seq, value) {
      const i = pending.findIndex((p) => p.payload.seq === seq);
      assert.ok(i >= 0, `no pending request with seq ${seq}`);
      const [p] = pending.splice(i, 1);
      p.resolve(typeof value === "function" ? value(p.payload) : value);
    },
    fail(seq, err) {
      const i = pending.findIndex((p) => p.payload.seq === seq);
      assert.ok(i >= 0, `no pending request with seq ${seq}`);
      const [p] = pending.splice(i, 1);
      p.reject(err);
    },
  };
}

console.log("L1 mapper.js — answers → bounded residual setpoint");

await check("neutral start; the first apply has dt = 0 (no jump); config + bounds exposed", () => {
  const m = M.createResidualMapper({});
  const c = m.current();
  assert.deepEqual(
    { ...c, framing: { ...c.framing } },
    { lateral: 0, vertical: 0, speedScale: 1, distanceScale: 1, framing: { dh: 0, dp: 0, dfovDeg: 0 }, fadeIds: [], reroute: false,
      maneuver: "hold_path", source: "none", status: "init", risk: 0, subjectLost: false, since: 0 },
  );
  const sp = m.apply(ans("drift_left"), { now: 5, source: "jev" });
  assert.equal(sp.lateral, 0);
  assert.equal(sp.maneuver, "drift_left");
  assert.equal(sp.source, "jev");
  assert.deepEqual(m.bounds, M.DEFAULT_PILOT_BOUNDS);
  assert.equal(m.config.commitSec, 1);
  assert.equal(m.config.overrideRisk, 1.6);
  assert.equal(m.config.staleSec, 0.6);
  assert.equal(m.config.minConfidence, 0.45);
});

await check("drift moves at ≤ lateralMps and clamps to ±maxLateral", () => {
  const m = M.createResidualMapper({ bounds: { maxLateral: 2 } });
  const sps = run(m, ans("drift_left"), 0, 2, 1 / 30);
  for (let i = 1; i < sps.length; i++) assert.ok(Math.abs(sps[i].lateral - sps[i - 1].lateral) <= 1.5 / 30 + EPS, `step ${i}`);
  near(sps[3].lateral, -0.15, 1e-9, "1.5 m/s × 0.1 s");
  assert.equal(sps[sps.length - 1].lateral, -2);
  const m2 = M.createResidualMapper({ bounds: { maxLateral: 2 } });
  assert.equal(run(m2, ans("drift_right"), 0, 3, 0.1).pop().lateral, 2);
});

await check("commit window: a new maneuver is held for commitSec, then switches", () => {
  const m = M.createResidualMapper({});
  run(m, ans("drift_left"), 0, 0.5, 0.1);
  let sp = m.apply(ans("drift_right"), { now: 0.6 });
  assert.equal(sp.status, "held");
  assert.equal(sp.maneuver, "drift_left");
  assert.ok(sp.lateral < -0.85, "keeps drifting left inside the window");
  sp = m.apply(ans("drift_right"), { now: 0.99 });
  assert.equal(sp.maneuver, "drift_left");
  sp = m.apply(ans("drift_right"), { now: 1.0 });
  assert.equal(sp.status, "applied");
  assert.equal(sp.maneuver, "drift_right");
  near(sp.since, 0, 1e-12, "since restarts");
  sp = m.apply(ans("drift_right"), { now: 1.5 });
  near(sp.since, 0.5, 1e-12, "since counts the committed maneuver");
  assert.equal(m.stats().held, 2);
  assert.equal(m.stats().switches, 1);
  // Leaving hold_path is immediate: no window on the neutral cruising state.
  const m2 = M.createResidualMapper({});
  m2.apply(ans("hold_path"), { now: 0 });
  sp = m2.apply(ans("drift_left"), { now: 0.1 });
  assert.deepEqual([sp.status, sp.maneuver], ["applied", "drift_left"]);
  sp = m2.apply(ans("hold_path"), { now: 0.2 });
  assert.deepEqual([sp.status, sp.maneuver], ["held", "drift_left"], "but returning to the path waits for the window");
});

await check("risk ≥ overrideRisk overrides the commit window (score thresholded, not interpolated)", () => {
  const m = M.createResidualMapper({});
  m.apply(ans("drift_left"), { now: 0 });
  let sp = m.apply(ans("back_off", { risk: 1.5 }), { now: 0.3 });
  assert.equal(sp.status, "held", "risk 1.5 < 1.6");
  assert.equal(sp.maneuver, "drift_left");
  sp = m.apply(ans("back_off", { risk: 2 }), { now: 0.4 });
  assert.equal(sp.status, "override");
  assert.equal(sp.maneuver, "back_off");
  assert.equal(sp.risk, 2);
  assert.equal(m.stats().overrides, 1);
});

await check("low confidence (explicit or from probabilities) decays toward neutral, never faster than returnMps", () => {
  const m = M.createResidualMapper({});
  run(m, ans("drift_left"), 0, 1, 0.1);
  const before = m.current().lateral;
  near(before, -1.5, 1e-9);
  let prev = before;
  for (let t = 1.1; t <= 5 + 1e-9; t += 0.1) {
    const sp = m.apply(ans("drift_right", { conf: 0.3 }), { now: t });
    assert.equal(sp.status, "decay");
    assert.equal(sp.maneuver, "drift_left", "the committed maneuver is kept");
    assert.ok(Math.abs(sp.lateral) <= Math.abs(prev) + EPS, "monotone toward 0");
    assert.ok(Math.abs(sp.lateral - prev) <= 0.75 * 0.1 + EPS, "rate-limited");
    prev = sp.lateral;
  }
  assert.ok(Math.abs(prev) < 0.05, `decayed to ~0 (got ${prev})`);
  const m2 = M.createResidualMapper({});
  m2.apply(ans("hold_path"), { now: 0 });
  const sp = m2.apply(ans("rise", { conf: null, probs: { hold_path: 0.7, rise: 0.3 } }), { now: 0.1 });
  assert.equal(sp.status, "decay", "P(choice) = 0.3 < minConfidence");
  assert.equal(M.answerConfidence({ type: "choice", choice: "x" }), 1, "no information → trusted");
  assert.equal(M.answerConfidence(null), 0);
  assert.equal(M.answerConfidence({ type: "score", score: 1.2, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 } }), 0.6);
});

await check("stale answers (scene age > staleSec, or NaN sceneTime) freeze the setpoint — a stale sink never descends", () => {
  const m = M.createResidualMapper({});
  run(m, ans("rise"), 0, 1, 0.1);
  const v = m.current().vertical;
  near(v, 1.0, 1e-9);
  let sp = m.apply(ans("sink"), { now: 1.1, sceneTime: 0.4 });
  assert.equal(sp.status, "stale");
  assert.equal(sp.vertical, v);
  sp = m.apply(ans("sink", { risk: 2 }), { now: 1.2, sceneTime: 0.59 });
  assert.equal(sp.vertical, v, "even a high-risk stale answer");
  sp = m.apply(ans("hold_path"), { now: 3, sceneTime: 2 });
  assert.equal(sp.vertical, v, "a stale hold_path does not return downward either");
  sp = m.apply(ans("sink"), { now: 3.1, sceneTime: NaN });
  assert.equal(sp.status, "stale");
  assert.equal(m.stats().stale, 4);
  sp = m.apply(ans("hold_path"), { now: 3.2, sceneTime: 3.15 });
  assert.equal(sp.status, "applied", "fresh again");
  assert.ok(sp.vertical < v, "fresh hold_path returns toward the path");
  sp = m.apply(ans("hold_path"), { now: 3.3 });
  assert.equal(sp.status, "applied", "missing sceneTime counts as fresh");
  sp = m.apply(ans("hold_path"), { now: 3.4, sceneTime: 3.4 - 0.6 });
  assert.equal(sp.status, "applied", "age == staleSec is still fresh");
});

await check("slow_down / back_off: speed targets and back_off moves away from the nearest obstacle", () => {
  const m = M.createResidualMapper({});
  const sps = run(m, ans("slow_down"), 0, 1, 0.1);
  near(sps[1].speedScale, 0.92, 1e-9, "0.8/s × 0.1 s");
  near(sps[sps.length - 1].speedScale, 0.5, 1e-9);
  const away = (bearingDeg, elevDeg) => {
    const mm = M.createResidualMapper({});
    const sf = frame({ nearest: { range: 0.5, kind: "rock", bearingDeg, elevDeg } });
    return run(mm, ans("back_off"), 0, 2, 0.1, { sensorFrame: sf }).pop();
  };
  const r = away(60, 0);
  assert.ok(r.lateral < -0.5, `obstacle on the right → move left (${r.lateral})`);
  assert.equal(r.speedScale, 0, "speed → minSpeedScale");
  assert.ok(away(-90, 0).lateral > 0.5, "obstacle on the left → move right");
  const up = away(0, 80);
  assert.ok(up.vertical < -0.5, "obstacle above → move down");
  assert.ok(Math.abs(up.lateral) < 1e-9);
  const unknown = away(NaN, 0);
  assert.equal(unknown.lateral, 0, "unknown bearing → no lateral guess");
});

await check("return to the path only while the side being returned toward is clear", () => {
  const m = M.createResidualMapper({});
  run(m, ans("drift_left"), 0, 2, 0.1);
  assert.equal(m.current().lateral, -3);
  const blocked = frame({ sides: { right: 1 } });
  let sp = run(m, ans("hold_path"), 2.1, 3, 0.1, { sensorFrame: blocked }).pop();
  assert.equal(sp.maneuver, "hold_path");
  assert.equal(sp.lateral, -3, "right side 1 m → hold the offset");
  const sps = run(m, ans("hold_path"), 3.1, 4, 0.1, { sensorFrame: frame({ sides: { right: { range: 5, kind: "tree" } } }) });
  near(sps[0].lateral, -3 + 0.075, 1e-9, "returns at returnMps");
  const m2 = M.createResidualMapper({});
  run(m2, ans("rise"), 0, 1, 0.1);
  sp = run(m2, ans("hold_path"), 1.1, 2.5, 0.1, { sensorFrame: frame({ sides: { down: 1.5 } }) }).pop();
  near(sp.vertical, 1, 1e-9, "ground 1.5 m below → no descent");
});

await check("bounds: sanitised, and every channel clamps to them", () => {
  assert.deepEqual(M.sanitizeBounds({ maxLateral: -1, maxRise: NaN, maxSink: "x", minSpeedScale: 1.5, maxSpeedScale: 0.5, maxDistanceScale: 0.5 }), {
    maxLateral: 3, maxRise: 3, maxSink: 1.5, minSpeedScale: 1, maxSpeedScale: 1, maxDistanceScale: 1,
  });
  assert.deepEqual(M.sanitizeBounds(null), { ...M.DEFAULT_PILOT_BOUNDS });
  const bounds = { maxLateral: 1, maxRise: 0.5, maxSink: 0.25, minSpeedScale: 0.2, maxSpeedScale: 1, maxDistanceScale: 1.2 };
  const fresh = () => M.createResidualMapper({ bounds });
  assert.equal(run(fresh(), ans("drift_right"), 0, 5, 0.1).pop().lateral, 1);
  assert.equal(run(fresh(), ans("rise"), 0, 5, 0.1).pop().vertical, 0.5);
  assert.equal(run(fresh(), ans("sink"), 0, 5, 0.1).pop().vertical, -0.25);
  assert.equal(run(fresh(), ans("back_off"), 0, 5, 0.1).pop().speedScale, 0.2);
  const w = run(fresh(), ans("hold_path", { fr: "widen" }), 0, 8, 0.1).pop();
  near(w.distanceScale, 1.2, 1e-12);
  assert.equal(w.framing.dfovDeg, 10, "then widens the fov to maxDfovDeg");
  const tt = run(fresh(), ans("hold_path", { fr: "tighten" }), 0, 8, 0.1).pop();
  near(tt.distanceScale, 1 / 1.2, 1e-12);
  assert.equal(tt.framing.dfovDeg, -10);
});

await check("occluder_action: fade → occluder ids, reroute flag, wait caps speed, low confidence ignored", () => {
  const sf = frame({ subject: { visibleFrac: 0.2, occluderKind: "tree", occluderIds: [7, 7, "a", NaN, ""] } });
  const m = M.createResidualMapper({});
  let sp = m.apply(ans("hold_path", { occ: "fade" }), { now: 0, sensorFrame: sf });
  assert.deepEqual(sp.fadeIds, [7, "a"]);
  sp = m.apply(ans("hold_path", { occ: "fade" }), { now: 0.1, sensorFrame: frame({ subject: { occluderId: 9 } }) });
  assert.deepEqual(sp.fadeIds, [9]);
  sp = m.apply(ans("hold_path", { occ: "reroute" }), { now: 0.2, sensorFrame: sf });
  assert.deepEqual([sp.reroute, sp.fadeIds], [true, []]);
  sp = run(m, ans("hold_path", { occ: "wait" }), 0.3, 2, 0.1, { sensorFrame: sf }).pop();
  near(sp.speedScale, 0.6, 1e-9, "wait caps speed");
  assert.equal(sp.reroute, false);
  sp = m.apply(ans("hold_path", { occ: "fade", occConf: 0.2 }), { now: 2.1, sensorFrame: sf });
  assert.deepEqual([sp.fadeIds, sp.reroute], [[], false], "low-confidence occluder answer ignored");
});

await check("occluder_action fade with NO fadeable id (a scenery trunk) falls back to reroute — never a no-op (review contracts-3 / seams-2 / gate-2)", () => {
  // The review scene: all 5 subject rays on a procedural scenery trunk, which never carries a fade
  // key (v1, r4-scenery-fade: CollisionHit names no placement) → occluderIds [].
  const trunk = frame({ subject: { visibleFrac: 0, unseenSec: 3.97, occluderKind: "tree", occluderIds: [] } });
  const m = M.createResidualMapper({});
  let sp = m.apply(ans("hold_path", { occ: "fade" }), { now: 0, sensorFrame: trunk });
  assert.deepEqual([sp.fadeIds, sp.reroute], [[], true], "fade + no ids → reroute");
  assert.equal(m.stats().fadeFallbacks, 1);
  // Nothing in the frame at all (no subject block) behaves the same.
  sp = m.apply(ans("hold_path", { occ: "fade" }), { now: 0.1, sensorFrame: frame({}) });
  assert.equal(sp.reroute, true);
  // With an id (a PLACED tree's object key — procedural scenery trees never get one, r4) the fade stands and no reroute is asked.
  sp = m.apply(ans("hold_path", { occ: "fade" }), { now: 0.2, sensorFrame: frame({ subject: { visibleFrac: 0, occluderKind: "tree", occluderIds: ["placement:05050000:object:0"] } }) });
  assert.deepEqual([sp.fadeIds, sp.reroute], [["placement:05050000:object:0"], false]);
  assert.equal(m.stats().fadeFallbacks, 2);
  // The real code policy on the review scene answers fade (soft kind) → the mapper reroutes.
  const pol = P.codePolicy(trunk, null);
  assert.equal(pol.occluder_action.choice, "fade", "the policy's answer for a hidden subject behind a tree");
  const m2 = M.createResidualMapper({});
  const sp2 = m2.apply(pol, { now: 0, sensorFrame: trunk });
  assert.deepEqual([sp2.fadeIds, sp2.reroute], [[], true], "code policy fade on a trunk → reroute");
});

await check("subject_lost (noul ≥ 0.5) caps speed and freezes framing", () => {
  const sf = frame({ subject: { ndc: [0.9, 0], visibleFrac: 0, unseenSec: 4 } });
  const m = M.createResidualMapper({});
  const sp = run(m, ans("hold_path", { lost: 0.8, fr: "recenter" }), 0, 2, 0.1, { sensorFrame: sf }).pop();
  assert.equal(sp.subjectLost, true);
  near(sp.speedScale, 0.7, 1e-9);
  assert.equal(sp.framing.dh, 0, "no recentring on a lost subject");
  assert.equal(m.apply(ans("hold_path", { lost: 0.3 }), { now: 2.1 }).subjectLost, false);
});

await check("framing: recenter turns toward the subject (rate-limited, clamped), widen/tighten, low confidence decays", () => {
  const m = M.createResidualMapper({});
  const sf = frame({ subject: { ndc: [0.8, 0] } });
  const sps = run(m, ans("hold_path", { fr: "recenter" }), 0, 2, 0.1, { sensorFrame: sf });
  near(sps[1].framing.dh, 15 * DEG * 0.1, 1e-12, "15°/s");
  assert.equal(sps[1].framing.dp, 0);
  near(sps[sps.length - 1].framing.dh, 12 * DEG, 1e-12, "clamped at maxFramingDeg");
  const m2 = M.createResidualMapper({});
  const sf2 = frame({ subject: { ndc: [-0.02, 0.01] } });
  const sp2 = run(m2, ans("hold_path", { fr: "recenter" }), 0, 0.1, 0.1, { sensorFrame: sf2 }).pop();
  const tv = Math.tan(30 * DEG);
  near(sp2.framing.dh, Math.atan(-0.02 * (16 / 9) * tv), 1e-12, "small error corrected exactly (subject left → turn left)");
  near(sp2.framing.dp, Math.atan(0.01 * tv), 1e-12, "subject above → look up");
  const m3 = M.createResidualMapper({});
  run(m3, ans("hold_path", { fr: "recenter" }), 0, 0.5, 0.1, { sensorFrame: frame({ subject: { ndc: null } }) });
  assert.equal(m3.current().framing.dh, 0, "no ndc → nothing to recentre on");
  const w = run(M.createResidualMapper({}), ans("hold_path", { fr: "widen" }), 0, 1, 0.1);
  near(w[1].distanceScale, 1.025, 1e-12, "distancePerSec 0.25");
  const dec = M.createResidualMapper({});
  run(dec, ans("hold_path", { fr: "recenter" }), 0, 2, 0.1, { sensorFrame: sf });
  const d = run(dec, ans("hold_path", { fr: "recenter", frConf: 0.1 }), 2.1, 6, 0.1, { sensorFrame: sf }).pop();
  assert.ok(Math.abs(d.framing.dh) < 0.01, `low-confidence framing decays (${d.framing.dh})`);
});

await check("null / malformed answers and NaN clocks never throw; null answers freeze ('empty')", () => {
  const m = M.createResidualMapper({});
  run(m, ans("drift_left"), 0, 1, 0.1);
  const before = m.current();
  for (const a of [null, undefined, 42, {}, { maneuver: "drift_left" }]) {
    const sp = m.apply(a, { now: 1.5 });
    assert.equal(sp.status, "empty");
    assert.equal(sp.lateral, before.lateral);
  }
  assert.doesNotThrow(() => m.apply(ans("rise"), { now: NaN }));
  assert.doesNotThrow(() => m.apply(ans("rise"), null));
  const sp = m.apply(ans("teleport"), { now: 3 });
  assert.equal(sp.maneuver, "hold_path", "unknown maneuver → hold_path");
  for (const v of [sp.lateral, sp.vertical, sp.speedScale, sp.distanceScale, sp.framing.dh]) assert.ok(Number.isFinite(v));
});

await check("reset() returns to neutral and clears counters", () => {
  const m = M.createResidualMapper({});
  run(m, ans("rise"), 0, 1, 0.1);
  m.reset();
  const c = m.current();
  assert.deepEqual([c.vertical, c.maneuver, c.status, c.since], [0, "hold_path", "init", 0]);
  assert.deepEqual(m.stats(), { applies: 0, applied: 0, held: 0, overrides: 0, switches: 0, decayed: 0, stale: 0, empty: 0, fadeFallbacks: 0 });
});

await check("5000 seeded random answers: every channel continuous (rate-bounded), finite and inside the bounds", () => {
  const rng = R.mulberry32("film-mapper-continuity");
  const bounds = { maxLateral: 2.5, maxRise: 3, maxSink: 1, minSpeedScale: 0.1, maxSpeedScale: 1.2, maxDistanceScale: 1.4 };
  const m = M.createResidualMapper({ bounds });
  const r = M.DEFAULT_MAPPER_RATES;
  let t = 0;
  let prev = m.current();
  for (let i = 0; i < 5000; i++) {
    const dt = rng() < 0.05 ? 0.5 : rng() * 0.1; // includes long pauses (capped to maxDtSec)
    t += dt;
    const a = ans(R.rngPick(rng, [...Q.MANEUVERS, "bogus"]), {
      conf: rng(), risk: R.rngInt(rng, 0, 2), lost: rng() < 0.1 ? rng() : undefined,
      occ: R.rngPick(rng, [...Q.OCCLUDER_ACTIONS, undefined]), occConf: rng(), fr: R.rngPick(rng, [...Q.FRAMING_ACTIONS, undefined]), frConf: rng(),
    });
    const sf = frame({
      nearest: { range: rng() * 5, bearingDeg: rng() * 360 - 180, elevDeg: rng() * 180 - 90 },
      sides: { left: rng() * 6, right: rng() * 6, up: rng() * 6, down: rng() * 6 },
      subject: { ndc: rng() < 0.2 ? null : [rng() * 4 - 2, rng() * 4 - 2], occluderIds: [R.rngInt(rng, 1, 5)] },
    });
    const sp = m.apply(rng() < 0.05 ? null : a, { now: t, sceneTime: t - rng() * 0.9, sensorFrame: sf });
    const h = Math.min(dt, r.maxDtSec);
    const msg = `step ${i}`;
    assert.ok(Math.abs(sp.lateral - prev.lateral) <= Math.max(r.lateralMps, r.returnMps) * h + EPS, `${msg} lateral`);
    assert.ok(Math.abs(sp.vertical - prev.vertical) <= Math.max(r.verticalMps, r.returnMps) * h + EPS, `${msg} vertical`);
    assert.ok(Math.abs(sp.speedScale - prev.speedScale) <= r.speedPerSec * h + EPS, `${msg} speed`);
    assert.ok(Math.abs(sp.distanceScale - prev.distanceScale) <= r.distancePerSec * h + EPS, `${msg} distance`);
    assert.ok(Math.abs(sp.framing.dh - prev.framing.dh) <= r.framingDegPerSec * DEG * h + EPS, `${msg} dh`);
    assert.ok(Math.abs(sp.framing.dp - prev.framing.dp) <= r.framingDegPerSec * DEG * h + EPS, `${msg} dp`);
    assert.ok(Math.abs(sp.framing.dfovDeg - prev.framing.dfovDeg) <= r.fovDegPerSec * h + EPS, `${msg} dfov`);
    assert.ok(sp.lateral >= -2.5 - EPS && sp.lateral <= 2.5 + EPS && sp.vertical >= -1 - EPS && sp.vertical <= 3 + EPS, msg);
    assert.ok(sp.speedScale >= 0.1 - EPS && sp.speedScale <= 1.2 + EPS, msg);
    assert.ok(sp.distanceScale >= 1 / 1.4 - EPS && sp.distanceScale <= 1.4 + EPS, msg);
    if (sp.status === "stale" || sp.status === "empty") assert.equal(sp.vertical, prev.vertical, `${msg}: frozen`);
    prev = sp;
  }
});

console.log("L2 pilot.js — consult gating, pipelining, fallback, shadow, stepped");

await check("consultNeeded: obstacle / sector / level / contact / unseen / occluded / framing reasons", () => {
  const st = (sf, o) => S.buildPilotState(sf, o);
  const need = (sf, c, o) => PL.consultNeeded(sf, st(sf, o), c);
  assert.deepEqual(need(OPEN), { needed: false, reasons: [] });
  assert.deepEqual(need(frame({ nearest: { range: 5 } })).reasons, ["obstacle-near"]);
  assert.deepEqual(need(frame({ sectors: { far_right: { range: 6 } } })).reasons, ["sector-blocked"], "withinM inclusive");
  assert.deepEqual(need(frame({ sectors: { far_right: { range: 6.01 } } })).reasons, []);
  assert.deepEqual(need(frame({ freeAhead: { level: 3 } })).reasons, ["level-blocked"]);
  assert.deepEqual(need(frame({ pathAhead: { ttc: 1.9 } })).reasons, ["contact-soon"]);
  assert.deepEqual(need(frame({ pathAhead: { ttc: 2 } })).reasons, []);
  assert.deepEqual(need(frame({ subject: { unseenSec: 1, visibleFrac: 0.5 } })).reasons, ["subject-unseen"]);
  assert.deepEqual(need(frame({ subject: { visibleFrac: 0.39 } })).reasons, ["subject-occluded"]);
  assert.deepEqual(need(frame({ subject: { sizeRatio: 0.6 } })).reasons, ["framing"]);
  assert.deepEqual(need(frame({ subject: { ndc: [0.9, 0] } })).reasons, ["framing"]);
  assert.deepEqual(need(frame({ subject: { sizeRatio: 0.6 } }), { framing: false }).reasons, [], "framing consults off");
  assert.deepEqual(need(frame({ subject: { sizeRatio: 0.6, visibleFrac: 0 } }), {}, { hasSubject: false }).reasons, [], "no subject");
  assert.deepEqual(need(frame({ nearest: { range: 9 } }), { withinM: 10 }).reasons, ["obstacle-near"]);
  assert.deepEqual(PL.consultNeeded(null, null), { needed: false, reasons: [] });
});

await check("code mode: neutral when not needed (source none), codePolicy when needed; the bridge is never called", () => {
  const bridge = fakeBridge();
  const pilot = PL.createPilot({ bridge, mode: "code" });
  let r = pilot.tick(OPEN, CTX, 0);
  assert.equal(r.telemetry.source, "none");
  assert.equal(r.telemetry.consulted, false);
  assert.equal(r.telemetry.answers.maneuver.choice, "hold_path");
  for (let i = 1; i <= 10; i++) r = pilot.tick(TREE, CTX, i * 0.1);
  assert.equal(r.telemetry.source, "code");
  assert.equal(r.telemetry.newDecision, true);
  assert.equal(r.setpoint.maneuver, "drift_right");
  assert.ok(r.setpoint.lateral > 1, `drifting right (${r.setpoint.lateral})`);
  assert.equal(bridge.calls.length, 0);
  const s = pilot.stats();
  assert.deepEqual([s.ticks, s.consults, s.sources.code, s.sources.none, s.dispatched], [11, 10, 10, 1, 0]);
  assert.equal(pilot.mode, "code");
});

await check("jev mode: dispatch {state, questions, seq}; act on the answer the next tick; then reuse the unchanged scene", async () => {
  const bridge = fakeBridge();
  const pilot = PL.createPilot({ bridge, mode: "jev" });
  let r = pilot.tick(TREE, CTX, 0);
  assert.deepEqual([r.telemetry.source, r.telemetry.dispatched, r.setpoint.status], ["none", 1, "empty"], "nothing to act on yet");
  assert.equal(bridge.calls.length, 1);
  const call = bridge.calls[0];
  assert.deepEqual(Object.keys(call), ["state", "questions", "seq"]);
  assert.equal(call.seq, 1);
  assert.ok(S.isWordsOnly(call.state), "the state is words only");
  assert.equal(call.state.standing_order, CTX.standingOrder);
  assert.deepEqual(Object.keys(call.questions), ["maneuver", "risk", "subject_lost", "occluder_action", "framing"]);
  bridge.answer(1, (pl) => jevAnswers(pl, { maneuver: "drift_left" }));
  await flush();
  r = pilot.tick(TREE, CTX, 0.1);
  assert.equal(r.telemetry.source, "jev");
  assert.equal(r.telemetry.newDecision, true);
  assert.equal(r.telemetry.seq, 1);
  assert.equal(r.telemetry.latencyMs, 150);
  near(r.telemetry.costUsd, 0.0000378, 1e-15);
  assert.equal(r.telemetry.agreeWithCode, false, "code says drift_right");
  assert.equal(r.setpoint.maneuver, "drift_left");
  near(r.setpoint.lateral, -0.15, 1e-9);
  near(r.telemetry.answers.maneuver.confidence, 0.9, 1e-12, "probabilities read by name");
  r = pilot.tick(TREE, CTX, 0.2);
  assert.deepEqual([r.telemetry.source, r.telemetry.newDecision, r.telemetry.costUsd], ["reuse", false, 0]);
  assert.equal(bridge.calls.length, 1, "unchanged scene → no new consult");
  r = pilot.tick(TREE, { ...CTX, standingOrder: CTX.standingOrder }, 2.05);
  assert.equal(bridge.calls.length, 2, "answer older than reuseSec → ask again");
  assert.equal(r.telemetry.source, "none", "the 2 s old answer is stale for the mapper");
  const s = pilot.stats();
  assert.deepEqual([s.dispatched, s.answered, s.appliedAnswers, s.reused], [2, 1, 1, 1]);
  assert.deepEqual(s.sources, { jev: 1, code: 0, reuse: 1, none: 2 });
});

await check("pipelining: ≤ maxInFlight outstanding, dispatches ≥ max(minDispatchSec, 1/decisionHz) apart", async () => {
  const bridge = fakeBridge();
  const pilot = PL.createPilot({ bridge, maxInFlight: 2, decisionHz: 5, minDispatchSec: 0.12, timeoutSec: 100 });
  const times = [];
  for (let i = 0; i <= 40; i++) {
    const r = pilot.tick(TREE, { ...CTX, goal: `g${i}` }, i * 0.05);
    if (r.telemetry.dispatched != null) times.push(r.telemetry.t);
    assert.ok(r.telemetry.inFlight <= 2);
  }
  assert.equal(bridge.calls.length, 2, "no answers → the pipeline stays full at 2");
  assert.ok(pilot.stats().skipped.busy > 0);
  for (let i = 41; i <= 120; i++) {
    for (const p of [...bridge.pending]) bridge.answer(p.payload.seq, (pl) => jevAnswers(pl));
    await flush();
    const r = pilot.tick(TREE, { ...CTX, goal: `g${i}` }, i * 0.05);
    if (r.telemetry.dispatched != null) times.push(r.telemetry.t);
    assert.ok(r.telemetry.inFlight <= 2);
  }
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 0.2 - 1e-9, `gap ${times[i] - times[i - 1]}`);
  assert.ok(times.length >= 15, `${times.length} dispatches`);
  assert.equal(pilot.stats().maxInFlightSeen, 2);
  const seqs = bridge.calls.map((c) => c.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "sequence numbers increase");
  // 1/decisionHz below minDispatchSec → minDispatchSec rules.
  const b2 = fakeBridge({ auto: (pl) => jevAnswers(pl) });
  const fast = PL.createPilot({ bridge: b2, maxInFlight: 8, decisionHz: 50, minDispatchSec: 0.12 });
  const t2 = [];
  for (let i = 0; i <= 50; i++) {
    const r = fast.tick(TREE, { ...CTX, goal: `h${i}` }, i * 0.02);
    if (r.telemetry.dispatched != null) t2.push(r.telemetry.t);
    await flush();
  }
  for (let i = 1; i < t2.length; i++) assert.ok(t2[i] - t2[i - 1] >= 0.12 - 1e-9);
});

await check("answers about an older scene than the applied one are dropped", async () => {
  const bridge = fakeBridge();
  const pilot = PL.createPilot({ bridge, maxInFlight: 3, minDispatchSec: 0, decisionHz: 100 });
  pilot.tick(TREE, { ...CTX, goal: "a" }, 0);
  pilot.tick(TREE, { ...CTX, goal: "b" }, 0.05);
  assert.deepEqual(bridge.calls.map((c) => c.seq), [1, 2]);
  bridge.answer(2, (pl) => jevAnswers(pl, { maneuver: "rise", risk: 0 }));
  await flush();
  let r = pilot.tick(TREE, { ...CTX, goal: "b" }, 0.1);
  assert.deepEqual([r.telemetry.source, r.telemetry.seq, r.setpoint.maneuver], ["jev", 2, "rise"]);
  bridge.answer(1, (pl) => jevAnswers(pl, { maneuver: "sink" }));
  await flush();
  r = pilot.tick(TREE, { ...CTX, goal: "b" }, 0.15);
  assert.equal(pilot.stats().droppedOlder, 1);
  assert.equal(r.telemetry.source, "reuse");
  assert.equal(r.telemetry.answers.maneuver.choice, "rise", "the newer scene's answer stays");
  near(r.telemetry.costUsd, 0.0000378, 1e-15, "the dropped answer's cost is still reported once");
});

await check("a request for a fingerprint already in flight is not duplicated", () => {
  const bridge = fakeBridge();
  const pilot = PL.createPilot({ bridge, maxInFlight: 2, minDispatchSec: 0, decisionHz: 100 });
  for (let i = 0; i < 5; i++) pilot.tick(TREE, CTX, i * 0.05);
  assert.equal(bridge.calls.length, 1);
  assert.equal(pilot.stats().skipped.duplicate, 4);
});

await check("bridge {error} / rejection / sync throw / malformed answers → code policy for that tick, then backoff", async () => {
  const cases = [
    ["jev-rate", (b) => b.answer(1, { error: { kind: "rate", message: "slow down", retryable: true }, seq: 1 })],
    ["bridge-error", (b) => b.fail(1, new Error("boom"))],
    ["bad-answer", (b) => b.answer(1, { answers: { maneuver: { type: "choice", choice: "teleport" } } })],
    ["bad-response", (b) => b.answer(1, "{not json")],
    ["bad-response", (b) => b.answer(1, 17)],
  ];
  for (const [kind, act] of cases) {
    const bridge = fakeBridge();
    const logs = [];
    const pilot = PL.createPilot({ bridge, log: (e) => logs.push(e) });
    pilot.tick(TREE, CTX, 0);
    act(bridge);
    await flush();
    let r = pilot.tick(TREE, CTX, 0.05);
    assert.equal(r.telemetry.source, "code", kind);
    assert.equal(r.telemetry.fallback, kind);
    assert.equal(r.telemetry.answers.maneuver.choice, "drift_right");
    assert.equal(r.setpoint.maneuver, "drift_right");
    assert.deepEqual([pilot.stats().errors, pilot.stats().fallbacks], [1, 1], kind);
    assert.ok(logs.some((e) => e.event === "film-pilot" && e.kind === "error" && e.error === kind), `${kind} logged`);
    r = pilot.tick(TREE, CTX, 0.1);
    assert.equal(r.telemetry.source, "reuse", "the same scene is not re-asked right after an error");
    assert.equal(bridge.calls.length, 1);
  }
  const throwing = { available: true, request() { throw new Error("sync"); } };
  const pilot = PL.createPilot({ bridge: throwing });
  assert.doesNotThrow(() => pilot.tick(TREE, CTX, 0));
  await flush();
  const r = pilot.tick(TREE, CTX, 0.05);
  assert.equal(r.telemetry.fallback, "bridge-error");
  // A JSON-string response is accepted.
  const b2 = fakeBridge();
  const p2 = PL.createPilot({ bridge: b2 });
  p2.tick(TREE, CTX, 0);
  b2.answer(1, (pl) => JSON.stringify(jevAnswers(pl)));
  await flush();
  assert.equal(p2.tick(TREE, CTX, 0.05).telemetry.source, "jev");
});

await check("realtime timeout on the pilot clock → code fallback; the late answer is dropped", async () => {
  const bridge = fakeBridge();
  const pilot = PL.createPilot({ bridge, timeoutSec: 1.5 });
  pilot.tick(TREE, CTX, 0);
  let r = pilot.tick(TREE, CTX, 1.0);
  assert.equal(r.telemetry.source, "none", "still waiting");
  r = pilot.tick(TREE, CTX, 1.6);
  assert.deepEqual([r.telemetry.source, r.telemetry.fallback], ["code", "timeout"]);
  assert.equal(pilot.stats().timeouts, 1);
  bridge.answer(1, (pl) => jevAnswers(pl));
  await flush();
  r = pilot.tick(TREE, CTX, 1.7);
  assert.equal(pilot.stats().droppedLate, 1);
  assert.equal(r.telemetry.source, "reuse");
});

await check("bridge availability is re-read every consult (boolean, getter or function)", async () => {
  const bridge = fakeBridge({ available: false });
  const pilot = PL.createPilot({ bridge });
  assert.equal(pilot.tick(TREE, CTX, 0).telemetry.source, "code");
  assert.equal(bridge.calls.length, 0);
  bridge.available = true;
  pilot.tick(TREE, { ...CTX, goal: "x" }, 0.5);
  assert.equal(bridge.calls.length, 1);
  let on = false;
  const fnBridge = { available: () => on, request: (pl) => Promise.resolve(jevAnswers(pl)) };
  const p2 = PL.createPilot({ bridge: fnBridge });
  assert.equal(p2.tick(TREE, CTX, 0).telemetry.source, "code");
  on = true;
  p2.tick(TREE, { ...CTX, goal: "y" }, 0.5);
  await flush();
  assert.equal(p2.tick(TREE, { ...CTX, goal: "y" }, 0.55).telemetry.source, "jev");
  assert.equal(PL.createPilot({ bridge: null }).tick(TREE, CTX, 0).telemetry.source, "code", "no bridge → code");
  assert.equal(PL.createPilot({ bridge: { available: true } }).tick(TREE, CTX, 0).telemetry.source, "code", "bridge without request()");
});

await check("an answer that arrives older than staleSec is not acted on (source none, setpoint frozen)", async () => {
  const bridge = fakeBridge();
  const pilot = PL.createPilot({ bridge });
  pilot.tick(TREE, { ...CTX, goal: "a" }, 0);
  bridge.answer(1, (pl) => jevAnswers(pl, { maneuver: "sink" }));
  await flush();
  const r = pilot.tick(TREE, { ...CTX, goal: "b" }, 0.8);
  assert.deepEqual([r.telemetry.source, r.setpoint.status, r.telemetry.newDecision], ["none", "stale", false]);
  assert.equal(r.setpoint.vertical, 0, "a stale sink never descends");
  assert.equal(bridge.calls.length, 2, "the new scene is asked about");
});

await check("after a code fallback, the JEV answer for that same scene replaces it", async () => {
  const bridge = fakeBridge();
  const pilot = PL.createPilot({ bridge });
  pilot.tick(TREE, { ...CTX, goal: "a" }, 0);
  bridge.fail(1, new Error("transient"));
  await flush();
  let r = pilot.tick(TREE, { ...CTX, goal: "b" }, 0.25);
  assert.deepEqual([r.telemetry.source, r.telemetry.dispatched], ["code", 2]);
  bridge.answer(2, (pl) => jevAnswers(pl, { maneuver: "rise", risk: 2 }));
  await flush();
  r = pilot.tick(TREE, { ...CTX, goal: "b" }, 0.3);
  assert.deepEqual([r.telemetry.source, r.telemetry.seq, r.telemetry.answers.maneuver.choice], ["jev", 2, "rise"]);
  assert.equal(r.setpoint.maneuver, "rise", "risk 2 overrides the code-committed drift");
});

await check("shadow mode acts on code, asks JEV, and logs per-question agreement", async () => {
  const bridge = fakeBridge();
  const logs = [];
  const pilot = PL.createPilot({ bridge, mode: "shadow", minDispatchSec: 0, decisionHz: 100, maxInFlight: 4, log: (e) => logs.push(e) });
  let costSum = 0;
  for (let i = 0; i <= 10; i++) {
    const r = pilot.tick(TREE, { ...CTX, goal: `g${i}` }, i * 0.05);
    costSum += r.telemetry.costUsd;
    assert.equal(r.telemetry.source, "code");
    for (const p of [...bridge.pending]) bridge.answer(p.payload.seq, (pl) => jevAnswers(pl, pl.seq % 2 ? { maneuver: "rise" } : {}));
    await flush();
  }
  const s = pilot.stats();
  assert.equal(pilot.tick(TREE, CTX, 0.6).setpoint.maneuver, "drift_right", "the camera follows the code policy");
  assert.equal(s.agreement.compared, 10);
  assert.equal(s.agreement.agreed, 5);
  assert.equal(s.agreement.rate, 0.5);
  assert.deepEqual(s.agreement.perQuestion.maneuver, { compared: 10, agreed: 5, rate: 0.5 });
  assert.deepEqual(s.agreement.perQuestion.risk, { compared: 10, agreed: 10, rate: 1 });
  assert.equal(s.sources.jev, 0);
  near(costSum, s.costUsd, 1e-15, "telemetry cost sums to stats().costUsd");
  assert.ok(logs.filter((e) => e.kind === "answer").every((e) => typeof e.agreeWithCode === "boolean" && e.perQuestion));
});

/** One stepped take: 60 frames at 30 fps; scenes change; the bridge answers after a microtask. */
async function steppedTake() {
  const bridge = fakeBridge({ auto: (pl) => jevAnswers(pl, pl.seq % 3 === 0 ? { maneuver: "rise" } : {}) });
  const pilot = PL.createPilot({ bridge, mode: "jev" });
  const out = [];
  for (let i = 0; i < 60; i++) {
    const t = i / 30;
    const sf = i < 40 ? TREE : OPEN;
    const goal = i < 20 ? "a" : `b${Math.floor(i / 5)}`;
    out.push(await pilot.tickStepped(sf, { ...CTX, goal }, t));
  }
  return { out, calls: bridge.calls.length, stats: pilot.stats() };
}

await check("stepped mode awaits the bridge and is deterministic (two runs → identical setpoints + telemetry)", async () => {
  const a = await steppedTake();
  const b = await steppedTake();
  assert.deepEqual(a.out, b.out);
  assert.equal(a.out[0].telemetry.source, "jev", "the first consult is answered within the same film tick");
  assert.equal(a.out[0].telemetry.dispatched, 1);
  const sources = new Set(a.out.map((r) => r.telemetry.source));
  for (const s of ["jev", "reuse", "none"]) assert.ok(sources.has(s), `has ${s}`);
  // Scenes change every 5 frames from frame 20 to 39 → dispatch at most every 0.2 s of film time.
  assert.ok(a.calls >= 4 && a.calls <= 6, `${a.calls} calls`);
  assert.equal(a.stats.errors, 0);
});

await check("stepped timeout (injected timers) → code fallback; timers are cleared on success", async () => {
  const timers = {
    list: [],
    setTimeout(fn, ms) {
      this.list.push({ fn, ms });
      return this.list.length;
    },
    clearTimeout(h) {
      this.list[h - 1] = null;
    },
  };
  const bridge = fakeBridge();
  const pilot = PL.createPilot({ bridge, timers, steppedTimeoutMs: 5000 });
  const pr = pilot.tickStepped(TREE, CTX, 0);
  await flush();
  assert.equal(timers.list.length, 1);
  assert.equal(timers.list[0].ms, 5000);
  timers.list[0].fn();
  const r = await pr;
  assert.deepEqual([r.telemetry.source, r.telemetry.fallback], ["code", "timeout"]);
  assert.deepEqual([pilot.stats().timeouts, pilot.stats().errors], [1, 1]);
  const ok = PL.createPilot({ bridge: fakeBridge({ auto: (pl) => jevAnswers(pl) }), timers, steppedTimeoutMs: 5000 });
  await ok.tickStepped(TREE, { ...CTX, goal: "z" }, 0);
  assert.equal(timers.list[timers.list.length - 1], null, "cleared after the answer");
});

await check("tickStepped calls are serialised (the second waits for the first decision)", async () => {
  const bridge = fakeBridge();
  const pilot = PL.createPilot({ bridge });
  const a = pilot.tickStepped(TREE, { ...CTX, goal: "a" }, 0);
  const b = pilot.tickStepped(TREE, { ...CTX, goal: "b" }, 0.25);
  await flush();
  assert.equal(bridge.calls.length, 1, "the second tick has not started");
  bridge.answer(1, (pl) => jevAnswers(pl));
  const ra = await a;
  await flush();
  assert.equal(bridge.calls.length, 2);
  bridge.answer(bridge.calls[1].seq, (pl) => jevAnswers(pl, { maneuver: "drift_left" }));
  const rb = await b;
  assert.ok(rb.telemetry.scene > ra.telemetry.scene);
  assert.deepEqual([ra.telemetry.source, rb.telemetry.source], ["jev", "jev"]);
});

await check("reset(): in-flight answers from the previous take are ignored; counters and mapper cleared", async () => {
  const bridge = fakeBridge();
  const pilot = PL.createPilot({ bridge });
  pilot.tick(TREE, CTX, 0);
  pilot.reset();
  bridge.answer(1, (pl) => jevAnswers(pl, { maneuver: "rise" }));
  await flush();
  const r = pilot.tick(TREE, CTX, 0);
  assert.equal(r.telemetry.source, "none", "the old take's answer never applies");
  assert.equal(bridge.calls.length, 2, "the new take asks again");
  const s = pilot.stats();
  assert.deepEqual([s.answered, s.dispatched, s.ticks], [0, 1, 1]);
  assert.equal(pilot.mapper.current().maneuver, "hold_path");
});

await check("no subject → only maneuver + risk are asked; telemetry keys, stats JSON, decisions ring, broken logger", async () => {
  const bridge = fakeBridge({ auto: (pl) => jevAnswers(pl) });
  const pilot = PL.createPilot({ bridge, log: () => { throw new Error("logger down"); } });
  const sf = frame({ ...TREE, subject: null });
  let r = pilot.tick(sf, CTX, 0);
  assert.deepEqual(Object.keys(bridge.calls[0].questions), ["maneuver", "risk"]);
  await flush();
  r = pilot.tick(sf, CTX, 0.1);
  assert.deepEqual(Object.keys(r.telemetry.answers), ["maneuver", "risk"]);
  assert.deepEqual(Object.keys(r.telemetry), [
    "seq", "scene", "t", "source", "fingerprint", "answers", "latencyMs", "costUsd", "agreeWithCode",
    "newDecision", "consulted", "reasons", "dispatched", "inFlight", "status",
  ]);
  assert.match(r.telemetry.fingerprint, /^[0-9a-f]{8}$/);
  const s = pilot.stats();
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.equal(s.latencyMs.count, 1);
  assert.equal(s.latencyMs.p50, 150);
  const d = pilot.decisions();
  assert.equal(d.length, 1);
  assert.deepEqual(Object.keys(d[0]), ["seq", "t", "source", "fingerprint", "answers", "latencyMs", "costUsd", "agreeWithCode"]);
  d[0].source = "mutated";
  assert.equal(pilot.decisions()[0].source, "jev", "copies");
  assert.ok(Object.isFrozen(r.telemetry.answers), "JEV answers are frozen (shared across reuse ticks)");
});

await check("bad options fall back to defaults; NaN clocks and junk frames never throw", () => {
  const pilot = PL.createPilot({ mode: "warp", decisionHz: -1, maxInFlight: 0, minDispatchSec: NaN, reuseSec: -5, consult: 7, mapper: {} });
  assert.equal(pilot.mode, "jev");
  for (const sf of [null, undefined, 42, {}, frame({ nearest: { range: NaN } })]) {
    const r = pilot.tick(sf, null, NaN);
    assert.ok(r.setpoint && r.telemetry);
    assert.ok(Number.isFinite(r.setpoint.lateral));
  }
});

console.log(`film_pilot_loop: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
