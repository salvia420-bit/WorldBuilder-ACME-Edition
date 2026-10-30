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
    // 2026-10-25: draw pools' sticky per-landblock hide (pool_registry.js hideLb/showLb).
    _poolHideLb: (k) => calls.push(["poolHide", k]),
    _poolShowLb: (k) => calls.push(["poolShow", k]),
  };
  return { s, calls, parked };
}

console.log("?objRadius — object near radius");
console.log("=========================");

// ---- 1. flag grammar ----
{
  const _l = globalThis.location;
  for (const [search, want] of [["", 4], ["?objRadius=3", 3], ["?objRadius=1", 1], ["?objRadius=12", 12],
    ["?objRadius=off", null], ["?objRadius=0", null], ["?objRadius=false", null], ["?objRadius=no", null],
    ["?objRadius=13", 4], ["?objRadius=on", 4], ["?objRadius=3x", 4]]) {
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
  check("4c2. pooled members of exactly those LBs get the sticky pool hide (2026-10-25)",
    calls.filter((c) => c[0] === "poolHide").map((c) => c[1]).sort().join() === [keys[4], keys[5]].sort().join());
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
  check("4i2. …and lifts the pool hide", calls.some((c) => c[0] === "poolShow" && c[1] === keys[4]));
  // The far side now: keys[0] at d=3 band (still visible), then d=4 hides.
  M.tickObjectRadius(s, new Set([keys[4]]));
  check("4j. walking away hides the trailing LB past N+1", hid(keys[0]) && vis(keys[1]));
  // A PARKED LB that comes back into range: nodes restored, but park owns the instances.
  parked.add(keys[0]);
  calls.length = 0;
  M.tickObjectRadius(s, new Set([keys[1]]));
  check("4k. show of a parked LB leaves bucket/atlas instances to unpark",
    !calls.some((c) => c[0] === "batchShow" || c[0] === "atlasShow"));
  check("4k2. …but the pool hide lifts regardless (the registry keeps tile parking separate)",
    calls.some((c) => c[0] === "poolShow" && c[1] === keys[0]));
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
  calls.length = 0;
  const forgets0 = M.getObjectRadiusStats(s).forgets;
  M.tickObjectRadius(s, new Set([lb(11, 10)]));
  check("5e. an evicted LB is dropped from the hidden set", !s._objRadius.hidden.has(far));
  // 2026-10-29 (lane W review r2): the forget lifts the pool registry's sticky
  // hide too — before, a hidden-then-evicted landblock stayed in the registry's
  // `_hiddenLbs` and its re-baked pooled statics committed invisible for good.
  check("5f. …and the forget lifts the pool registry's sticky hide (exactly once, for that LB)",
    calls.filter((c) => c[0] === "poolShow").map((c) => c[1]).join() === String(far) &&
    M.getObjectRadiusStats(s).forgets === forgets0 + 1, JSON.stringify(calls));
  check("5g. …and touches nothing else (no node / bucket / atlas call for an evicted LB)",
    calls.every((c) => c[0] === "poolShow"), JSON.stringify(calls));
}

// ---- 6. the real PoolRegistry: hide -> release -> forget -> return (2026-10-29) ----
// The pooled-statics path end to end, wired as index.js wires liveScene3d
// (`_poolHideLb` / `_poolShowLb` -> registry.hideLb / showLb). Pre-fix the
// forget left the registry's hide behind and 6d / 6g read [false, false].
{
  globalThis.window ??= {};
  globalThis.window.location ??= { search: "" };
  const THREE = await import("three");
  const { applyBatchedMeshColorTextureFix } = await import("./scene3d/three_batchedmesh_colortexture_fix.js");
  applyBatchedMeshColorTextureFix(THREE);
  const { PoolRegistry, tileKeyOfLbKey } = await import("./scene3d/pool_registry.js");
  M.__setObjRadiusForTest(4); // the shipped default
  const reg = new PoolRegistry({
    THREE, group: new THREE.Group(), warn: () => {}, search: "",
    materialFactory: (k) => { const m = new THREE.MeshStandardMaterial(); m.name = `pool-${k}`; return m; },
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(9).fill(0.5), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(6).fill(0.25), 2));
  g.setIndex([0, 1, 2]);
  const geomSource = { get: () => g };
  const s3 = {
    staticsGroup: new THREE.Group(), buildingsGroup: new THREE.Group(),
    staticsBakedLbs: new Set(), buildingsBakedLbs: new Set(),
    _poolHideLb: (k) => reg.hideLb(k), // index.js liveScene3d._poolHideLb
    _poolShowLb: (k) => reg.showLb(k), // index.js liveScene3d._poolShowLb
  };
  const member = (key) => ({
    domain: "st", classKey: "st|opaque|g", passClass: "opaque", sectorKey: "s0", contentKey: "g0", layer: 0, lbKey: key,
    matrix: new THREE.Matrix4().makeTranslation(((key >>> 24) & 0xff) * 192 + 10, ((key >>> 16) & 0xff) * 192 + 10, 0).toArray(),
  });
  // Visible flags of `key`'s pooled instances (the registry's per-landblock ranges).
  const visOf = (key) => {
    const out = [];
    const byTile = reg.tiles.get(tileKeyOfLbKey(key));
    if (byTile) for (const mem of byTile.values()) for (const id of (mem.lbRanges && mem.lbRanges.get(key)) || []) out.push(mem.pool.mesh._instanceInfo[id].visible);
    return out;
  };
  const bake = (key) => {
    reg.feedTile({ tile: tileKeyOfLbKey(key), lbs: [key], members: [member(key), member(key)], counts: {} }, geomSource);
    s3.staticsBakedLbs.add(key);
    M.afterObjectBake(s3, key);
  };
  const K = lb(0x40, 0x40);
  M.tickObjectRadius(s3, new Set([K]));
  bake(K);
  check("6a. baked on the player's landblock: pooled statics visible", visOf(K).join() === "true,true", visOf(K).join());
  M.tickObjectRadius(s3, new Set([lb(0x46, 0x40)]));
  check("6b. 6 landblocks away: hidden, in the registry's sticky set too", visOf(K).join() === "false,false" && reg.isLbHidden(K));
  // The grid parks the vacated tile, then its pressure pass releases it: the
  // baked marks go first (lru.disposeLb), the registry record with the EMPTY event.
  reg.parkTile(tileKeyOfLbKey(K));
  s3.staticsBakedLbs.delete(K);
  M.tickObjectRadius(s3, new Set([lb(0x47, 0x40)]));
  check("6c. forget on a PARKED tile drops the registry's mark and flips nothing (park still owns it)",
    !reg.isLbHidden(K) && !s3._objRadius.hidden.has(K) && visOf(K).join() === "false,false", `${reg.isLbHidden(K)} ${visOf(K).join()}`);
  reg.releaseTile(tileKeyOfLbKey(K));
  // The player comes back: the tile re-feeds inside the radius.
  M.tickObjectRadius(s3, new Set([K]));
  bake(K);
  M.tickObjectRadius(s3, new Set([lb(0x40, 0x41)]));
  M.tickObjectRadius(s3, new Set([K]));
  check("6d. back on the landblock, re-baked: its pooled statics are VISIBLE again", visOf(K).join() === "true,true", visOf(K).join());
  // Same cycle with the registry record released BEFORE the forget (the usual
  // order: release, then the next crossing forgets).
  const K2 = lb(0x60, 0x40);
  M.tickObjectRadius(s3, new Set([K2]));
  bake(K2);
  M.tickObjectRadius(s3, new Set([lb(0x66, 0x40)]));
  reg.parkTile(tileKeyOfLbKey(K2));
  s3.staticsBakedLbs.delete(K2);
  reg.releaseTile(tileKeyOfLbKey(K2));
  check("6e. released while hidden: the registry still holds the hide until the forget", reg.isLbHidden(K2));
  M.tickObjectRadius(s3, new Set([lb(0x67, 0x40)]));
  // (K is legitimately hidden again meanwhile: baked and far from K2.)
  check("6f. the forget lifts it; the registry's hides equal objRadius's again",
    !reg.isLbHidden(K2) && [...reg._hiddenLbs].sort().join() === [...s3._objRadius.hidden].sort().join(),
    `${[...reg._hiddenLbs].join()} vs ${[...s3._objRadius.hidden].join()}`);
  M.tickObjectRadius(s3, new Set([K2]));
  bake(K2);
  check("6g. back on it: re-baked visible", visOf(K2).join() === "true,true", visOf(K2).join());
  // Fail-soft: a throwing show hook (or none: the chain off) never blocks the forget.
  const s4 = { staticsGroup: { children: [] }, buildingsGroup: { children: [] }, staticsBakedLbs: new Set([K]), buildingsBakedLbs: new Set(),
    _poolShowLb: () => { throw new Error("boom"); } };
  M.tickObjectRadius(s4, new Set([lb(0x46, 0x40)]));
  s4.staticsBakedLbs.delete(K);
  M.tickObjectRadius(s4, new Set([lb(0x47, 0x40)]));
  const s5 = { staticsGroup: { children: [] }, buildingsGroup: { children: [] }, staticsBakedLbs: new Set([K]), buildingsBakedLbs: new Set() };
  M.tickObjectRadius(s5, new Set([lb(0x46, 0x40)]));
  s5.staticsBakedLbs.delete(K);
  M.tickObjectRadius(s5, new Set([lb(0x47, 0x40)]));
  check("6h. a throwing (or absent: chain off) _poolShowLb never blocks the forget",
    s4._objRadius.hidden.size === 0 && s5._objRadius.hidden.size === 0);
}

M.__setObjRadiusForTest(undefined);
console.log(`object-radius test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
