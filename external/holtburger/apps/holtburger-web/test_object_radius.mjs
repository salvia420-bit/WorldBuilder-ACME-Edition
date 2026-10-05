// ?objRadius (perf T7) — headless test for scene3d/object_radius.js.
// Run: cd apps/holtburger-web/ && node test_object_radius.mjs

import * as M from "./scene3d/object_radius.js";

let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };

const lb = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;
const node = (lbKey, visible = true) => ({ visible, userData: { landblockId: (lbKey | 0x0001) >>> 0 } });

function fakeScene() {
  const calls = [];
  const parked = new Set();
  const s = {
    staticsGroup: { children: [] },
    buildingsGroup: { children: [] },
    staticsBakedLbs: new Set(),
    buildingsBakedLbs: new Set(),
    landblockLru: { isParked: (k) => parked.has(k >>> 0) },
    _parkStaticBatchXForLb: (k) => calls.push(["batchHide", k]),
    _unparkStaticBatchXForLb: (k) => calls.push(["batchShow", k]),
    _parkStaticAtlasForLb: (k) => calls.push(["atlasHide", k]),
    _unparkStaticAtlasForLb: (k) => calls.push(["atlasShow", k]),
  };
  return { s, calls, parked };
}

console.log("?objRadius — object near radius");
console.log("=========================");

// ---- 1. flag grammar ----
{
  const _l = globalThis.location;
  for (const [search, want] of [["", null], ["?objRadius=3", 3], ["?objRadius=1", 1], ["?objRadius=12", 12],
    ["?objRadius=0", null], ["?objRadius=13", null], ["?objRadius=on", null], ["?objRadius=3x", null]]) {
    globalThis.location = { search };
    M.__setObjRadiusForTest(undefined);
    check(`1. ${search || "(absent)"} -> ${want}`, M.objRadiusSetting() === want, String(M.objRadiusSetting()));
  }
  if (_l === undefined) delete globalThis.location; else globalThis.location = _l;
}

// ---- 2. off = no-op ----
{
  M.__setObjRadiusForTest(null);
  const { s, calls } = fakeScene();
  const far = lb(60, 50);
  s.staticsBakedLbs.add(far);
  const n = node(far); s.staticsGroup.children.push(n);
  M.tickObjectRadius(s, new Set([lb(50, 50)]));
  M.afterObjectBake(s, far);
  M.afterUnpark(s, far);
  check("2a. off: nothing hidden, no hooks, no state", n.visible && calls.length === 0 && s._objRadius === undefined);
  check("2b. off: every bake is allowed", M.objectBakeAllowed(new Set([lb(50, 50)]), far) === true);
}

// ---- 3. bake gate ----
{
  M.__setObjRadiusForTest(2);
  const seen = new Set([lb(50, 50)]);
  check("3a. d=2 allowed at N=2", M.objectBakeAllowed(seen, lb(52, 48)) === true);
  check("3b. d=3 gated at N=2", M.objectBakeAllowed(seen, lb(53, 50)) === false);
  check("3c. nearest of several centres counts", M.objectBakeAllowed(new Set([lb(50, 50), lb(60, 50)]), lb(58, 50)) === true);
}

// ---- 4. hide / show with hysteresis ----
{
  M.__setObjRadiusForTest(2);
  M.__resetObjectRadiusStatsForTest();
  const { s, calls, parked } = fakeScene();
  const keys = [0, 1, 2, 3, 4, 5].map((d) => lb(50 + d, 50));
  const nodes = new Map();
  for (const k of keys) {
    s.staticsBakedLbs.add(k);
    const a = node(k), b = node(k);
    s.staticsGroup.children.push(a); s.buildingsGroup.children.push(b);
    nodes.set(k, [a, b]);
  }
  // A node something ELSE hid must never be un-hidden by us.
  const foreign = node(keys[5], false); s.staticsGroup.children.push(foreign);
  M.tickObjectRadius(s, new Set([keys[0]]));
  const vis = (k) => nodes.get(k).every((n) => n.visible);
  const hid = (k) => nodes.get(k).every((n) => !n.visible);
  check("4a. d<=N+1 visible (d=0..3)", [0, 1, 2, 3].every((d) => vis(keys[d])));
  check("4b. d>N+1 hidden (d=4,5), statics AND buildings nodes", hid(keys[4]) && hid(keys[5]));
  check("4c. bucket + atlas instances hidden for exactly those LBs",
    calls.filter((c) => c[0] === "batchHide").map((c) => c[1]).sort().join() === [keys[4], keys[5]].sort().join() &&
    calls.filter((c) => c[0] === "atlasHide").length === 2);
  check("4d. stats: 2 hidden LBs", M.getObjectRadiusStats(s).hiddenLbs === 2);
  // Same centre again: signature unchanged -> no work.
  calls.length = 0;
  M.tickObjectRadius(s, new Set([keys[0]]));
  check("4e. unchanged centre set is a no-op", calls.length === 0);
  // Move one LB east: keys[4] is now d=3 (band) -> stays hidden; keys[3] d=2 -> visible.
  M.tickObjectRadius(s, new Set([keys[1]]));
  check("4f. hysteresis: an LB entering the N+1 band stays hidden", hid(keys[4]));
  // Move to keys[2]: keys[4] is d=2 -> shown; the foreign-hidden node stays hidden.
  calls.length = 0;
  M.tickObjectRadius(s, new Set([keys[3]]));
  check("4g. d<=N shows again", vis(keys[4]) && vis(keys[5]));
  check("4h. a node hidden by someone else is not un-hidden", foreign.visible === false);
  check("4i. show re-shows bucket + atlas instances", calls.some((c) => c[0] === "batchShow" && c[1] === keys[4]) &&
    calls.some((c) => c[0] === "atlasShow" && c[1] === keys[4]));
  // The far side now: keys[0] at d=3 band (still visible), then d=4 hides.
  M.tickObjectRadius(s, new Set([keys[4]]));
  check("4j. walking away hides the trailing LB past N+1", hid(keys[0]) && vis(keys[1]));
  // A PARKED LB that comes back into range: nodes restored, but park owns the instances.
  parked.add(keys[0]);
  calls.length = 0;
  M.tickObjectRadius(s, new Set([keys[1]]));
  check("4k. show of a parked LB leaves bucket/atlas instances to unpark",
    !calls.some((c) => c[0] === "batchShow" || c[0] === "atlasShow"));
}

// ---- 5. late bakes, unpark, eviction ----
{
  M.__setObjRadiusForTest(1);
  const { s, calls, parked } = fakeScene();
  const near = lb(10, 10), far = lb(14, 10);
  s.staticsBakedLbs.add(near); s.staticsBakedLbs.add(far);
  M.tickObjectRadius(s, new Set([near]));
  // A bake lands for `far` after the tick: its new nodes must be hidden on arrival.
  const late = node(far); s.staticsGroup.children.push(late);
  M.afterObjectBake(s, far);
  check("5a. a late bake outside the band is hidden on arrival", late.visible === false);
  const lateNear = node(near); s.staticsGroup.children.push(lateNear);
  M.afterObjectBake(s, near);
  check("5b. a bake inside the radius is left alone", lateNear.visible === true);
  // Park detaches `far`'s nodes; unpark re-shows its instances and re-attaches nodes.
  parked.add(far);
  s.staticsGroup.children = s.staticsGroup.children.filter((n) => n !== late);
  const reattached = node(far); // a node that was attached visible before the hide ran
  parked.delete(far);
  s.staticsGroup.children.push(late, reattached);
  calls.length = 0;
  M.afterUnpark(s, far);
  check("5c. unpark of a hidden LB re-hides nodes and instances",
    reattached.visible === false && calls.some((c) => c[0] === "batchHide" && c[1] === far));
  // Shown while parked: flagged detached nodes are restored on unpark.
  M.tickObjectRadius(s, new Set([lb(13, 10)])); // far now d=1 -> shown; `late` attached -> restored
  const detached = node(far); detached.visible = false; detached.userData.__objRadiusHidden = true;
  s.staticsGroup.children.push(detached);
  M.afterUnpark(s, far);
  check("5d. unpark of a no-longer-hidden LB restores flagged nodes", detached.visible === true);
  // Eviction: the LB leaves the baked sets -> forgotten.
  M.tickObjectRadius(s, new Set([near]));
  s.staticsBakedLbs.delete(far);
  M.tickObjectRadius(s, new Set([lb(11, 10)]));
  check("5e. an evicted LB is dropped from the hidden set", !s._objRadius.hidden.has(far));
}

M.__setObjRadiusForTest(undefined);
console.log(`object-radius test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
