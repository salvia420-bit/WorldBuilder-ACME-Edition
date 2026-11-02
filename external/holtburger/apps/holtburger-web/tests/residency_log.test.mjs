// 2026-11-01 — ?residencyLog (scene3d/residency_log.js): the flight-experience
// Phase 0 residency sampler. Pure helpers + a simulated flight over a mock scene
// (Sets for the baked marks, a fake LRU / object-radius / far probe).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/residency_log.test.mjs

import {
  residencyLogEnabled, __setResidencyLogForTest, rlogEvent, rlogEvents, RLOG, BIT,
  lbKeyXY, cheb, tDrawn, oDrawn, farDrawn, isHole, percentile, computeFlips, leadSeconds,
  tickResidencyLog, residencyFlips, residencyLeadTimes, residencyHoles, residencySummary,
  residencyClear, rlogSetFarProbe, rlogBake, rlogSetTreeCensus,
} from "../scene3d/residency_log.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

console.log("-- R1 flag grammar ---------------------------------------------------");
check("absent -> OFF", residencyLogEnabled("") === false && residencyLogEnabled("?x=1") === false);
check("on/1/true/yes -> ON", ["on", "1", "true", "yes", "ON"].every((v) => residencyLogEnabled(`?residencyLog=${v}`)));
check("off/garbage -> OFF", ["off", "0", "false", "maybe"].every((v) => !residencyLogEnabled(`?residencyLog=${v}`)));
__setResidencyLogForTest(false);
rlogEvent(RLOG.LEAD, 123);
check("flag off: rlogEvent writes nothing", rlogEvents().length === 0);

console.log("-- R2 bit derivations -------------------------------------------------");
check("terrain drawn = baked and not parked", tDrawn(BIT.TB) && !tDrawn(BIT.TB | BIT.TP) && !tDrawn(0));
check("objects drawn = (statics|buildings) baked, not hidden, not parked",
  oDrawn(BIT.SB) && oDrawn(BIT.BB) && !oDrawn(BIT.SB | BIT.OH) && !oDrawn(BIT.SB | BIT.TP) && !oDrawn(BIT.TB));
check("far drawn = covered and not discarded", farDrawn(BIT.FC) && !farDrawn(BIT.FC | BIT.FD) && !farDrawn(0));
check("hole = no near and no far", isHole(0) && isHole(BIT.FC | BIT.FD) && !isHole(BIT.TB) && !isHole(BIT.FC));
check("cheb", cheb(lbKeyXY(10, 10), lbKeyXY(13, 8)) === 3);
check("percentile", percentile([5, 1, 3, 2, 4], 50) === 3 && percentile([], 50) === null);
check("leadSeconds", leadSeconds(5000, 2000) === 3 && leadSeconds(1000, 3000) === -2 && leadSeconds(1, null) === null);

console.log("-- R3 computeFlips -----------------------------------------------------");
{
  const H = new Map();
  // LB A: shown, hidden 2 s later, shown again 2 s later, all within range 3 -> 2 flips
  H.set(1, [{ t: 0, on: true, d: 2 }, { t: 2000, on: false, d: 3 }, { t: 4000, on: true, d: 3 }]);
  // LB B: hidden at the boundary (d 6) -> not in range -> 0 flips
  H.set(2, [{ t: 0, on: true, d: 4 }, { t: 1000, on: false, d: 6 }]);
  // LB C: shown, hidden 30 s later (outside the 10 s window) -> 0
  H.set(3, [{ t: 0, on: true, d: 1 }, { t: 30000, on: false, d: 1 }]);
  const r = computeFlips(H, 10000, 5);
  check("only the in-range, in-window toggles count", r.flips === 2 && r.lbs.length === 1 && r.lbs[0].lb === 1, JSON.stringify(r));
}

console.log("-- R4 simulated flight over a mock scene --------------------------------");
{
  __setResidencyLogForTest(true);
  residencyClear();
  // a fake clock through performance.now
  let nowMs = 1000;
  const realPerf = globalThis.performance;
  globalThis.performance = { now: () => nowMs };
  const scene = {
    terrainBakedLbs: new Set(), staticsBakedLbs: new Set(), buildingsBakedLbs: new Set(),
    pvsRingRadius: 5,
    _objRadius: { hidden: new Set() },
    landblockLru: { parked: new Set(), isParked(k) { return this.parked.has(k); } },
  };
  // far ring: covers everything within 8 of (plb), discards within nearFadeLb
  let plb = { x: 100, y: 100 };
  rlogSetFarProbe(() => ({
    plb, nearFadeLb: 5.45,
    covered: (x, y) => Math.max(Math.abs(x - plb.x), Math.abs(y - plb.y)) <= 8,
  }));
  // bake the whole 11x11 ring + objects within 4 around 100,100
  scene._objAttach = new Map();
  for (let dx = -5; dx <= 5; dx++) for (let dy = -5; dy <= 5; dy++) {
    scene.terrainBakedLbs.add(lbKeyXY(100 + dx, 100 + dy));
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= 4) {
      scene.staticsBakedLbs.add(lbKeyXY(100 + dx, 100 + dy));
      scene._objAttach.set(lbKeyXY(100 + dx, 100 + dy), { s: 1, b: 0 }); // attached (index.js stamps this)
    }
  }
  // a statics bake that STARTED (baked mark set) but has not attached: never counts as drawn
  scene.staticsBakedLbs.add(lbKeyXY(90, 90));
  const tick = (cx, cy, x) => {
    tickResidencyLog(scene, { centreLb: lbKeyXY(cx, cy), pose: { x, y: cy * 192 + 96, z: 150 }, groundZ: () => 50, objRadiusLb: 4 });
  };
  // 1 s at 100,100
  for (let i = 0; i < 60; i++) { nowMs += 16; tick(100, 100, 100 * 192 + 96); }
  check("no holes on a fully baked ring", residencyHoles().holeFrames === 0, JSON.stringify(residencyHoles()));
  // cross into 101,100: the far discard square moves with it, the new leading
  // column x=106 is NOT baked yet -> holes ahead until it bakes
  plb = { x: 101, y: 100 };
  // make 101,100's statics "ready" earlier: it was baked at t<=1960 (in the window)
  for (let i = 0; i < 30; i++) { nowMs += 16; tick(101, 100, 101 * 192 + 10 + i * 2); }
  const h1 = residencyHoles();
  check("unbaked leading column inside the discard square = holes", h1.holeFrames > 0 && h1.holeLbFrames >= 30 * 11, JSON.stringify(h1));
  // bake the leading column; holes stop
  for (let dy = -5; dy <= 5; dy++) scene.terrainBakedLbs.add(lbKeyXY(106, 100 + dy));
  const before = residencyHoles().holeFrames;
  for (let i = 0; i < 30; i++) { nowMs += 16; tick(101, 100, 101 * 192 + 70 + i * 2); }
  check("baking it ends the holes", residencyHoles().holeFrames === before, `${before} vs ${residencyHoles().holeFrames}`);
  // the crossing's lead time: 101,100 had terrain + objects drawn since the first sample (t ~1016) -> ~1 s ahead
  const lt = residencyLeadTimes();
  check("one crossing recorded with positive terrain + object lead",
    lt.crossings === 1 && lt.terrain.n === 1 && lt.terrain.p50 > 0.9 && lt.objects.p50 > 0.9, JSON.stringify(lt.rows));
  // a flicker: objects of 102,100 hidden then shown within 2 s while in range
  scene._objRadius.hidden.add(lbKeyXY(102, 100));
  for (let i = 0; i < 30; i++) { nowMs += 16; tick(101, 100, 101 * 192 + 140); }
  scene._objRadius.hidden.delete(lbKeyXY(102, 100));
  for (let i = 0; i < 30; i++) { nowMs += 16; tick(101, 100, 101 * 192 + 140); }
  const f = residencyFlips(10);
  check("hide then show inside range within the window = 1 object flip on that LB",
    f.objects.flips === 1 && f.objects.lbs[0].lb === lbKeyXY(102, 100).toString(16).padStart(8, "0"), JSON.stringify(f));
  // a park of a ring LB = terrain hidden in range
  scene.landblockLru.parked.add(lbKeyXY(99, 100));
  for (let i = 0; i < 10; i++) { nowMs += 16; tick(101, 100, 101 * 192 + 140); }
  scene.landblockLru.parked.delete(lbKeyXY(99, 100));
  for (let i = 0; i < 10; i++) { nowMs += 16; tick(101, 100, 101 * 192 + 140); }
  const f2 = residencyFlips(10);
  check("park then unpark inside range = 1 terrain flip", f2.terrain.flips === 1, JSON.stringify(f2.terrain));
  // crossing into an LB whose terrain is not baked yet -> pending, then a negative lead once it bakes
  scene.terrainBakedLbs.delete(lbKeyXY(102, 100));
  for (let i = 0; i < 5; i++) { nowMs += 16; tick(101, 100, 101 * 192 + 190); }
  nowMs += 16; tick(102, 100, 102 * 192 + 1);
  nowMs += 500;
  scene.terrainBakedLbs.add(lbKeyXY(102, 100));
  nowMs += 16; tick(102, 100, 102 * 192 + 30);
  const lt2 = residencyLeadTimes();
  const last = lt2.rows[lt2.rows.length - 1];
  check("late terrain -> negative lead (~-0.5 s)", last.leadT != null && last.leadT < -0.4 && last.leadT > -0.7, JSON.stringify(last));
  // bake events land in the aggregate + log
  rlogBake("terrain", "start", lbKeyXY(1, 1), 3);
  rlogBake("terrain", "done", lbKeyXY(1, 1), 120);
  const s = residencySummary();
  check("summary carries bakes + rows + flips", s.bakes.bakeStarts === 1 && s.bakes.bakeDones === 1 && s.seconds >= 1
    // the hide/show of 102,100 + the park/unpark of 99,100 (a park hides its objects too)
    && s.flips.objects.flips === 2,
    JSON.stringify({ bakes: s.bakes, seconds: s.seconds, flips: s.flips }));
  check("a STATE event exists for the hide", rlogEvents().some((e) => e.kind === RLOG.STATE && e.lb === lbKeyXY(102, 100) && (e.a & BIT.OH)));
  check("rows carry coverage bands", Array.isArray(s.cover) === false && s.cover["0-1km"] != null, JSON.stringify(s.cover));
  // tree coverage counts only the landblocks the retail census has trees in: desert / sea / fields are not
  // "missing forest" (1070 arm G read 0 % over the southern desert)
  const cov = (census) => {
    residencyClear();
    rlogSetTreeCensus(census);
    for (let i = 0; i < 80; i++) { nowMs += 16; tick(101, 100, 101 * 192 + 140); }
    return residencySummary().cover["0-1km"];
  };
  const all = cov(null);
  const treed = cov((x, y) => (x === 101 && y === 100 ? 7 : 0));
  check("tree coverage over treed landblocks only (the one treed, drawn LB = 100 %; all LBs < 100 %)",
    treed === 1 && all < 1, JSON.stringify({ all, treed }));
  rlogSetTreeCensus(null);
  globalThis.performance = realPerf;
  __setResidencyLogForTest(undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
