// R-outdoor — LandblockLRU live-geometry residency governor (tasks #6/#7/#8/#10).
//
// The resident set has no byte budget (maxResident is an LB COUNT cap that
// "effectively never fires"), so a continuous multi-POI tour accumulated live
// GPU geometry unbounded. The fix governs on renderer.info.memory.geometries:
//   - #10 tickEviction parks EXTRA oldest-beyond-ring resident LBs when live
//     geometry is over MAX_LIVE_GEOM (feeds the pool) — even under the count cap.
//   - #7  pool pressure now fires on the live-geom governor too, not only the
//     (undercounting) parked-byte budget; and runs on EVERY tick, not only when
//     resident > maxResident (the pre-fix early-return skipped it).
//   - #8  the dispose rate is time-budgeted (min 1/tick) instead of a flat 2/tick.
//
// MAX_LIVE_GEOM / warmPark are module-load consts read from window.location, so
// install the stub BEFORE importing. parkUseTimeMs=0 removes the 30 s floor so a
// freshly-tracked far LB is pressure-eligible immediately; reclaimMinAgeMs=0 lets
// it be a victim the same tick.
//
// Run: cd apps/holtburger-web/ && node test_landblock_lru_geom_governor.mjs

globalThis.window = { location: { search:
  "?warmPark=on&maxLiveGeom=30&parkUseTimeMs=0&reclaimMinAgeMs=0&reclaimGate=off" } };

const { LandblockLRU, lbKeyFromXY } = await import("./scene3d/landblock_lru.js");

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? (passed += 1) : (failed += 1);
}

console.log("R-outdoor — LandblockLRU live-geometry governor");

// scene3d stub with a mock renderer.info.memory.geometries. Tracked geoms bump
// the counter (three.js ++ on first GPU use); geom.dispose() decrements it
// (three.js -- in onGeometryDispose) so the pressure loop actually converges.
function makeScene() {
  return {
    terrainBakedLbs: new Set(), buildingsBakedLbs: new Set(),
    staticsBakedLbs: new Set(), envCellLoadedLbs: new Set(),
    terrainMaterials: [], activeLights: [],
    _streamGuardState: { inFlight: new Set() },
    renderer: { info: { memory: { geometries: 0 } } },
  };
}
function makeGeom(scene, tag) {
  scene.renderer.info.memory.geometries += 1; // simulate GPU init
  return {
    uuid: `geom-${tag}`, attributes: {}, disposed: false,
    dispose() { if (!this.disposed) { this.disposed = true; scene.renderer.info.memory.geometries -= 1; } },
  };
}
// Track an LB carrying `n` geometries.
function trackLb(scene, lru, key, n, tag) {
  const geometries = [];
  for (let i = 0; i < n; i += 1) geometries.push(makeGeom(scene, `${tag}-${i}`));
  lru.track(key, { geometries });
}

const CX = 0x40, CY = 0x40;
const centre = lbKeyFromXY(CX, CY);
const ring = [];
for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) ring.push(lbKeyFromXY(CX + dx, CY + dy));

// ── Test 1: sanity — governor + warm-park are actually on.
{
  const s = makeScene();
  const lru = new LandblockLRU({ scene3d: s, maxResident: 100, getCurrentLbId: () => centre });
  const st = lru.getStats();
  check("warm-park on", lru.warmParkEnabled === true);
  check("maxLiveGeom parsed = 30", st.maxLiveGeom === 30, `got ${st.maxLiveGeom}`);
  check("parkBudgetBytes exposed", typeof st.parkBudgetBytes === "number");
}

// ── Test 2: geom-pressure feed + convergence. Count is UNDER maxResident the
// whole time, so ONLY the live-geom governor can drive eviction.
{
  const s = makeScene();
  const lru = new LandblockLRU({ scene3d: s, maxResident: 100, getCurrentLbId: () => centre });
  for (const k of ring) trackLb(s, lru, k, 1, `ring-${k}`);        // 9 geoms (the floor)
  const far = [];
  for (let i = 0; i < 20; i += 1) { const k = lbKeyFromXY(CX + 3 + i, CY + 3); far.push(k); trackLb(s, lru, k, 5, `far${i}`); }
  const geom0 = s.renderer.info.memory.geometries;
  check("Test2: live geom high before governor", geom0 === 9 + 100, `got ${geom0}`);
  check("Test2: resident count under cap (no count-cap eviction)", lru.entries.size === 29 && 29 < 100);

  let ticks = 0;
  while (s.renderer.info.memory.geometries > 30 && ticks < 40) { lru.tickEviction(centre); ticks += 1; }
  const st = lru.getStats();
  check("Test2: live geom driven under cap", s.renderer.info.memory.geometries <= 30, `got ${s.renderer.info.memory.geometries} in ${ticks} ticks`);
  check("Test2: geom-pressure parked extra resident LBs", st.geomPressureParks > 0, `parks=${st.geomPressureParks}`);
  check("Test2: true dispose happened (evicted)", st.evicted > 0, `evicted=${st.evicted}`);
  // The 3×3 floor + centre must survive (Chebyshev ≤ ringFloor never a victim).
  // The governor stops the instant live geom is under cap, so a small working
  // set stays resident — it must NOT strip to the bare floor.
  const floorResident = ring.every((k) => lru.entries.has(k));
  check("Test2: 3×3 floor fully resident (never a victim)", floorResident, `size=${lru.entries.size}`);
  check("Test2: resident set bounded near the working set", lru.entries.size < 20, `size=${lru.entries.size}`);
}

// ── Test 3: pool drains on EVERY tick (the pre-fix early-return skipped
// pressure when resident ≤ maxResident). Manually park two far LBs, hold live
// geom over cap, and confirm a single under-cap tick disposes.
{
  const s = makeScene();
  const lru = new LandblockLRU({ scene3d: s, maxResident: 100, getCurrentLbId: () => centre });
  for (const k of ring) trackLb(s, lru, k, 1, `r-${k}`);
  const a = lbKeyFromXY(CX + 6, CY), b = lbKeyFromXY(CX + 7, CY);
  trackLb(s, lru, a, 12, "A"); trackLb(s, lru, b, 12, "B");
  lru.park(a); lru.park(b);                                   // 24 geoms parked (still live), 9+24=33 > cap 30
  check("Test3: 2 parked, still live over cap", lru.parkPool.size === 2 && s.renderer.info.memory.geometries === 9 + 24);
  check("Test3: resident under count cap", lru.entries.size === 9 && 9 < 100);
  const before = lru.getStats().evicted;
  lru.tickEviction(centre);                                   // under count cap → old code returned w/o pressure
  check("Test3: under-cap tick still ran pool pressure (disposed)", lru.getStats().evicted > before, `evicted ${before}→${lru.getStats().evicted}`);
}

// ── Test 4: time-budget beats the flat 2/tick. Park many small LBs over cap;
// the 6 ms budget disposes far more than 2 in one tick (each dispose is ~µs).
{
  const s = makeScene();
  const lru = new LandblockLRU({ scene3d: s, maxResident: 100, getCurrentLbId: () => centre });
  for (const k of ring) trackLb(s, lru, k, 1, `r-${k}`);
  const parked = [];
  for (let i = 0; i < 15; i += 1) { const k = lbKeyFromXY(CX + 5 + i, CY + 5); parked.push(k); trackLb(s, lru, k, 2, `p${i}`); lru.park(k); }
  check("Test4: 15 parked", lru.parkPool.size === 15);
  const before = lru.getStats().evicted;
  lru.tickEviction(centre);                                   // one tick
  const disposedThisTick = lru.getStats().evicted - before;
  check("Test4: one tick disposed > 2 (time budget, not 2/tick cap)", disposedThisTick > 2, `disposed=${disposedThisTick}`);
}

// ── Test 5: off-switch. A fresh module import with maxLiveGeom=off disables the
// governor (stats.maxLiveGeom null, no geom pressure).
{
  globalThis.window = { location: { search: "?warmPark=on&maxLiveGeom=off&parkUseTimeMs=0&reclaimMinAgeMs=0&reclaimGate=off" } };
  const mod = await import(`./scene3d/landblock_lru.js?off=${Date.now()}`);
  const s = makeScene();
  const lru = new mod.LandblockLRU({ scene3d: s, maxResident: 100, getCurrentLbId: () => mod.lbKeyFromXY(CX, CY) });
  for (const k of ring) trackLb(s, lru, k, 1, `r-${k}`);
  for (let i = 0; i < 10; i += 1) trackLb(s, lru, mod.lbKeyFromXY(CX + 4 + i, CY + 4), 5, `x${i}`);
  const st = lru.getStats();
  check("Test5: governor off → maxLiveGeom null", st.maxLiveGeom === null, `got ${st.maxLiveGeom}`);
  lru.tickEviction(mod.lbKeyFromXY(CX, CY));
  check("Test5: no geom-pressure parks with governor off", lru.getStats().geomPressureParks === 0);
}

// ── Test 6: the live-geom governor is a HARD ceiling — it bypasses the 30 s
// UseTime floor. With the floor ON (parkUseTimeMs=30000) and freshly-parked
// (young) LBs over the geom cap, pressure must STILL dispose them (a live-verified
// regression: with the floor honored, 72 parked / 3 disposed / liveGeom stuck).
{
  globalThis.window = { location: { search: "?warmPark=on&maxLiveGeom=30&parkUseTimeMs=30000&reclaimMinAgeMs=0&reclaimGate=off" } };
  const mod = await import(`./scene3d/landblock_lru.js?floor=${Date.now()}`);
  const s = makeScene();
  const centreK = mod.lbKeyFromXY(CX, CY);
  const lru = new mod.LandblockLRU({ scene3d: s, maxResident: 100, getCurrentLbId: () => centreK });
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) trackLb(s, lru, mod.lbKeyFromXY(CX + dx, CY + dy), 1, `r${dx}${dy}`); // 9 floor
  const parked = [];
  for (let i = 0; i < 8; i += 1) { const k = mod.lbKeyFromXY(CX + 5 + i, CY + 5); parked.push(k); trackLb(s, lru, k, 5, `y${i}`); lru.park(k); } // 40 geoms parked, all young
  check("Test6: floor default 30000 in effect", lru.getStats().parkUseTimeMs === 30000, `got ${lru.getStats().parkUseTimeMs}`);
  check("Test6: over cap with young parked (9+40=49 > 30)", s.renderer.info.memory.geometries === 49);
  let ticks = 0;
  while (s.renderer.info.memory.geometries > 30 && ticks < 40) { lru.tickEviction(centreK); ticks += 1; }
  check("Test6: hard ceiling bypassed the UseTime floor (disposed young slots)", s.renderer.info.memory.geometries <= 30, `liveGeom=${s.renderer.info.memory.geometries}, evicted=${lru.getStats().evicted}`);
  check("Test6: useTimeDeferred did NOT block the geom breach", lru.getStats().evicted > 0, `evicted=${lru.getStats().evicted}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
