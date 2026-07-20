// perf_aggregate.selftest.cjs — pure-logic tests for the perf loop. No infra.
//   node perf/perf_aggregate.selftest.cjs
const A = require("./perf_aggregate.cjs");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error("FAIL: " + name); } }
function eq(name, a, b) { ok(name + " (got " + JSON.stringify(a) + ")", JSON.stringify(a) === JSON.stringify(b)); }

// ── parseSamples: drops junk + frame-time-less lines, keeps good ones ──
(function () {
  const text = [
    '[not json]',
    JSON.stringify({ lb: "0xa9b4", dt: { p95: 40 }, frames: 60 }),
    JSON.stringify({ lb: "0xa9b4", baked: 5 }),          // no dt.p95 -> dropped
    '   ',
    JSON.stringify({ lb: "0x0001", dt: { p95: 12 }, frames: 60 }),
  ].join("\n");
  const r = A.parseSamples(text);
  eq("parse keeps 2 good", r.samples.length, 2);
  eq("parse drops 2", r.dropped, 2);
})();

// ── rankByLandblock: worst p95 ranks first; sub-minSamples bins excluded ──
(function () {
  const samples = [];
  // bad LB: 5 samples ~80ms p95
  for (let i = 0; i < 5; i++) samples.push({ lb: "0xBAD0", dt: { p50: 50, p95: 78 + i, worst: 120 }, frames: 60, draw: 900, tri: 1e6, heapMB: 300, baked: 20 });
  // good LB: 5 samples ~15ms
  for (let i = 0; i < 5; i++) samples.push({ lb: "0x600D", dt: { p50: 12, p95: 15 + i, worst: 22 }, frames: 60, draw: 200, tri: 2e5, heapMB: 250, baked: 40 });
  // drive-through LB: 1 sample -> excluded at minSamples=2
  samples.push({ lb: "0x0001", dt: { p50: 200, p95: 300, worst: 400 }, frames: 5 });
  const ranked = A.rankByLandblock(samples, { minSamples: 2 });
  eq("rank excludes 1-sample bin", ranked.length, 2);
  eq("worst LB ranks first", ranked[0].lb, "0xBAD0");
  ok("worst p95_med > good p95_med", ranked[0].p95_med > ranked[1].p95_med);
  ok("dwell computed", ranked[0].dwellSec > 0);
})();

// ── sliceTourLbs: top offenders + a control healthy LB ──
(function () {
  const ranked = [
    { lb: "0xA", p95_med: 90 }, { lb: "0xB", p95_med: 70 }, { lb: "0xC", p95_med: 60 },
    { lb: "0xD", p95_med: 40 }, { lb: "0xE", p95_med: 12 },
  ];
  const t = A.sliceTourLbs(ranked, { top: 3, control: 1 });
  eq("offenders = top 3", t.offenders, ["0xA", "0xB", "0xC"]);
  eq("control = healthiest non-offender", t.control, ["0xE"]);
})();

// ── rank captures a representative waypoint (worst frame's pose) ──
(function () {
  const samples = [];
  for (let i = 0; i < 4; i++) samples.push({ lb: "0xBAD0", pos: { lb: 0xBAD00009, x: 10 + i, y: 20, z: 30 }, dt: { p50: 50, p95: 60 + i, worst: 90 }, frames: 60 });
  // the worst frame (p95=70) is at x=110 — that pose should win
  samples.push({ lb: "0xBAD0", pos: { lb: 0xBAD00009, x: 110, y: 22, z: 33 }, dt: { p50: 55, p95: 70, worst: 95 }, frames: 60 });
  const ranked = A.rankByLandblock(samples, { minSamples: 2 });
  eq("waypoint = worst-frame pose", ranked[0].waypoint.x, 110);
})();

// ── buildTour: offender-first waypoints, drops pose-less LBs ──
(function () {
  const samples = [];
  for (let i = 0; i < 4; i++) samples.push({ lb: "0xBAD0", pos: { lb: 0xBAD00009, x: 5, y: 5, z: 5 }, dt: { p50: 70, p95: 80, worst: 120 }, frames: 60 });
  for (let i = 0; i < 4; i++) samples.push({ lb: "0x600D", pos: { lb: 0x600D0009, x: 9, y: 9, z: 9 }, dt: { p50: 12, p95: 14, worst: 20 }, frames: 60 });
  // pose-less offender: appears in ranking but has no waypoint -> dropped
  for (let i = 0; i < 4; i++) samples.push({ lb: "0xNOPO", dt: { p50: 60, p95: 75, worst: 100 }, frames: 60 });
  const ranked = A.rankByLandblock(samples, { minSamples: 2 });
  const tour = A.buildTour(ranked, { top: 2, control: 1, name: "perf-tour-v1" });
  ok("tour kind waypoints", tour.kind === "waypoints");
  ok("first waypoint is worst offender 0xBAD0", tour.waypoints[0].forLb === "0xBAD0");
  ok("pose-less LB dropped", tour.dropped.indexOf("0xNOPO") >= 0);
  ok("control healthy LB included", tour.waypoints.some((w) => w.forLb === "0x600D"));
})();

// ── gate: real improvement with non-overlap ACCEPTs ──
(function () {
  const base = [{ routeMs: 200000, p95: 80 }, { routeMs: 202000, p95: 82 }, { routeMs: 201000, p95: 81 }];
  const cand = [{ routeMs: 180000, p95: 60 }, { routeMs: 181000, p95: 62 }, { routeMs: 179000, p95: 61 }];
  const g = A.gate(base, cand, { minPct: 3 });
  eq("clear win ACCEPTs", g.verdict, "ACCEPT");
  ok("improvePct ~10", g.improvePct >= 9 && g.improvePct <= 12);
  ok("p95 improvement reported", g.p95.improvePct > 0);
})();

// ── gate: noisy overlap is INCONCLUSIVE, not ACCEPT ──
(function () {
  const base = [{ routeMs: 200000, p95: 80 }, { routeMs: 195000, p95: 78 }, { routeMs: 205000, p95: 84 }];
  const cand = [{ routeMs: 199000, p95: 79 }, { routeMs: 194000, p95: 77 }, { routeMs: 206000, p95: 85 }];
  const g = A.gate(base, cand, { minPct: 3 });
  ok("overlapping noise is not ACCEPT", g.verdict !== "ACCEPT");
})();

// ── gate: a slowdown is a REGRESSION ──
(function () {
  const base = [{ routeMs: 180000, p95: 60 }, { routeMs: 181000, p95: 61 }, { routeMs: 179000, p95: 59 }];
  const cand = [{ routeMs: 200000, p95: 80 }, { routeMs: 201000, p95: 81 }, { routeMs: 199000, p95: 79 }];
  const g = A.gate(base, cand, { minPct: 3 });
  eq("slowdown is REGRESSION", g.verdict, "REGRESSION");
})();

// ── gate: too few runs is INSUFFICIENT ──
(function () {
  const g = A.gate([{ routeMs: 1, p95: 1 }], [{ routeMs: 1, p95: 1 }], {});
  eq("1 run -> INSUFFICIENT", g.verdict, "INSUFFICIENT");
})();

console.log((fail ? "✗" : "✓") + " perf_aggregate: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
