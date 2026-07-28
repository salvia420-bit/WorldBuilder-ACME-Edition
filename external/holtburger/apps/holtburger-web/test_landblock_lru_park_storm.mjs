// Park-storm bounds — LandblockLRU bounded/farthest-first reclaim (2026-07-28).
//
// THE BUG (measured live, 52-hop telepoi tour): at-cap reclaim parked nearly the
// entire resident set in one burst (`resident` 32 → 1), previously MASKED by the
// terrain_batch ghost rows that kept painting parked landblocks. Two unbounded
// park paths:
//   (a) the count-cap overage parked `entries.size - maxResident` in ONE tick;
//   (b) the #7/#10 geom-pressure feed parked GEOM_PRESSURE_PARK_PER_TICK extra
//       resident LBs per tick from a trigger PARK CANNOT RELIEVE —
//       renderer.info.memory.geometries falls on disposeParked, never on park.
//       Since a large share of live geometry is UNTRACKED (entities/atlas), once
//       that baseline alone exceeds MAX_LIVE_GEOM the feed is UNSATISFIABLE and
//       strips the resident set to the bare ring, which the streamer then
//       unparks and the next tick re-parks: the park↔unpark storm.
//
// The fix is retail-shaped (LScape::update_block — incremental, farthest-first,
// bounded work per step): MAX_PARKS_PER_TICK, a pool-backlog gate, a resident
// floor, hysteresis on the governor latch, and farthest-first victim order.
//
// Run: cd apps/holtburger-web/ && node test_landblock_lru_park_storm.mjs

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? (passed += 1) : (failed += 1);
}

function makeScene(untracked = 0) {
  return {
    terrainBakedLbs: new Set(), buildingsBakedLbs: new Set(),
    staticsBakedLbs: new Set(), envCellLoadedLbs: new Set(),
    terrainMaterials: [], activeLights: [],
    _streamGuardState: { inFlight: new Set() },
    renderer: { info: { memory: { geometries: untracked } } },
  };
}
function makeGeom(scene, tag) {
  scene.renderer.info.memory.geometries += 1;      // three.js ++ on first GPU use
  return {
    uuid: `g-${tag}`, attributes: {}, disposed: false,
    dispose() { if (!this.disposed) { this.disposed = true; scene.renderer.info.memory.geometries -= 1; } },
  };
}
function trackLb(scene, lru, key, n, tag) {
  const geometries = [];
  for (let i = 0; i < n; i += 1) geometries.push(makeGeom(scene, `${tag}-${i}`));
  lru.track(key, { geometries });
}
let importSeq = 0;
async function loadLru(search) {
  globalThis.window = { location: { search } };
  return import(`./scene3d/landblock_lru.js?ps=${importSeq += 1}`);
}

const CX = 0x40, CY = 0x40;
console.log("park-storm bounds — LandblockLRU");

// ── Test 1: the storm itself. Untracked geometry ALONE exceeds the cap, so the
// geom-pressure trigger can NEVER be satisfied by anything the LRU reclaims.
// Pre-fix this stripped the resident set to the bare 3×3 (and, mid-teleport
// when only the arriving centre was tracked, to 1) and never stopped.
{
  const mod = await loadLru("?warmPark=on&maxLiveGeom=30&parkUseTimeMs=0&reclaimMinAgeMs=0&reclaimGate=off");
  const { LandblockLRU, lbKeyFromXY } = mod;
  const s = makeScene(40);                       // 40 untracked > cap 30
  const centre = lbKeyFromXY(CX, CY);
  const lru = new LandblockLRU({ scene3d: s, maxResident: 32, getCurrentLbId: () => centre });
  const ring = [];
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
    const k = lbKeyFromXY(CX + dx, CY + dy); ring.push(k); trackLb(s, lru, k, 1, `r${dx}${dy}`);
  }
  for (let i = 0; i < 23; i += 1) trackLb(s, lru, lbKeyFromXY(CX + 2 + (i % 6), CY + 2 + Math.floor(i / 6)), 1, `o${i}`);
  check("Test1: 32 resident, count cap NOT exceeded", lru.entries.size === 32 && lru.entries.size <= lru.maxResident);
  let worstTick = 0;
  for (let t = 0; t < 40; t += 1) {
    const before = lru.entries.size;
    lru.tickEviction(centre);
    worstTick = Math.max(worstTick, before - lru.entries.size);
  }
  const st = lru.getStats();
  check("Test1: geom pressure DID engage (trigger real)", st.geomPressureEngagements > 0);
  check("Test1: trigger is unsatisfiable (still over cap at the end)",
    s.renderer.info.memory.geometries > 30, `liveGeom=${s.renderer.info.memory.geometries}`);
  check("Test1: resident never collapsed below ring+margin",
    lru.entries.size >= st.geomPressureResidentFloor,
    `resident=${lru.entries.size} floor=${st.geomPressureResidentFloor}`);
  check("Test1: the whole 3×3 ring is still resident", ring.every((k) => lru.entries.has(k)));
  check("Test1: parksPerTickMax within the bound",
    st.parksPerTickMax <= st.maxParksPerTick, `${st.parksPerTickMax} <= ${st.maxParksPerTick}`);
  check("Test1: observed per-tick drop within the bound", worstTick <= st.maxParksPerTick, `worst=${worstTick}`);
  check("Test1: the feed STOPPED at the floor instead of storming",
    st.geomPressureFloorHolds > 0, `floorHolds=${st.geomPressureFloorHolds}`);
  const parksAtRest = st.parkedTotal;
  for (let t = 0; t < 30; t += 1) lru.tickEviction(centre);
  check("Test1: no further parks once at the floor (storm over, not paused)",
    lru.getStats().parkedTotal === parksAtRest, `${parksAtRest} → ${lru.getStats().parkedTotal}`);
}

// ── Test 2: count-cap overage is amortized, not a one-tick bulk park, and the
// oldest-first victim ORDER is preserved across the ticks it spreads over.
{
  const mod = await loadLru("?warmPark=on&maxLiveGeom=off&parkUseTimeMs=0&reclaimMinAgeMs=0&reclaimGate=off");
  const { LandblockLRU, lbKeyFromXY } = mod;
  const s = makeScene(0);
  const centre = lbKeyFromXY(CX, CY);
  const lru = new LandblockLRU({ scene3d: s, maxResident: 10, getCurrentLbId: () => centre });
  const far = [];
  for (let i = 0; i < 50; i += 1) {
    const k = lbKeyFromXY(CX + 5 + (i % 25), CY + 5 + Math.floor(i / 25));
    far.push(k); lru.track(k);
    lru.entries.get(k).lastTouchMs = -100000 + i;   // strictly increasing age order
  }
  const st0 = lru.getStats();
  const before = lru.entries.size;
  lru.tickEviction(centre);
  const parked1 = before - lru.entries.size;
  check("Test2: one tick parked at most maxParksPerTick", parked1 <= st0.maxParksPerTick, `parked=${parked1}`);
  check("Test2: bound actually fired (storm clipped)", lru.getStats().parkBoundHits > 0);
  check("Test2: deferred victims recorded", lru.getStats().parksDeferredByBound > 0,
    `deferred=${lru.getStats().parksDeferredByBound}`);
  check("Test2: the OLDEST were the victims (order preserved)",
    far.slice(0, parked1).every((k) => !lru.entries.has(k)) && lru.entries.has(far[parked1]));
  let ticks = 1;
  while (lru.entries.size > lru.maxResident && ticks < 200) { lru.tickEviction(centre); ticks += 1; }
  check("Test2: the backlog still drains to the cap", lru.entries.size <= lru.maxResident, `in ${ticks} ticks`);
  check("Test2: parksPerTickMax stayed within the bound",
    lru.getStats().parksPerTickMax <= st0.maxParksPerTick);
}

// ── Test 3: farthest-first. Under geom pressure the FARTHEST candidate must be
// parked before a nearer-but-older one (retail LScape::update_block releases the
// row/column that scrolled out; the pre-fix feed reused plain oldest-first and
// victimized landblocks the player was walking back toward).
{
  const mod = await loadLru("?warmPark=on&maxLiveGeom=12&parkUseTimeMs=0&reclaimMinAgeMs=0&reclaimGate=off");
  const { LandblockLRU, lbKeyFromXY } = mod;
  const s = makeScene(0);
  const centre = lbKeyFromXY(CX, CY);
  const lru = new LandblockLRU({ scene3d: s, maxResident: 100, getCurrentLbId: () => centre });
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) trackLb(s, lru, lbKeyFromXY(CX + dx, CY + dy), 1, `r${dx}${dy}`);
  const near = lbKeyFromXY(CX + 3, CY);       // Chebyshev 3, OLDEST
  const mid = lbKeyFromXY(CX + 9, CY);        // Chebyshev 9
  const farK = lbKeyFromXY(CX + 20, CY);      // Chebyshev 20, NEWEST
  trackLb(s, lru, near, 3, "near"); lru.entries.get(near).lastTouchMs = -90000;
  trackLb(s, lru, mid, 3, "mid"); lru.entries.get(mid).lastTouchMs = -50000;
  trackLb(s, lru, farK, 3, "far"); lru.entries.get(farK).lastTouchMs = -10000;
  // Filler so the resident set sits above the geom-pressure floor (otherwise the
  // floor hold — Test 1's guarantee — legitimately suppresses the whole feed).
  for (const d of [6, 7, 8, 10, 11, 12]) {
    const k = lbKeyFromXY(CX, CY + d);
    trackLb(s, lru, k, 1, `fill${d}`);
    lru.entries.get(k).lastTouchMs = -20000;
  }
  // Count cap is not exceeded (18 < 100) so ONLY the geom feed can pick victims.
  lru.tickEviction(centre);
  check("Test3: farthest parked first despite being the newest", !lru.entries.has(farK));
  check("Test3: nearest-but-oldest survived the same tick", lru.entries.has(near),
    `near resident=${lru.entries.has(near)} mid=${lru.entries.has(mid)}`);
}

// ── Test 4: pool-backlog gate. The pool is the DRAIN, not a sink — parking more
// while a dispose backlog is already queued cannot lower live geometry.
// parkDisposeBudgetMs=0 restores the legacy 2-dispose/tick so a backlog persists.
{
  const mod = await loadLru("?warmPark=on&maxLiveGeom=10&parkUseTimeMs=0&reclaimMinAgeMs=0&reclaimGate=off&parkDisposeBudgetMs=0");
  const { LandblockLRU, lbKeyFromXY } = mod;
  const s = makeScene(0);
  const centre = lbKeyFromXY(CX, CY);
  const lru = new LandblockLRU({ scene3d: s, maxResident: 100, getCurrentLbId: () => centre });
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) trackLb(s, lru, lbKeyFromXY(CX + dx, CY + dy), 1, `r${dx}${dy}`);
  const resident = [];
  for (let i = 0; i < 20; i += 1) { const k = lbKeyFromXY(CX + 4 + i, CY + 4); resident.push(k); trackLb(s, lru, k, 2, `p${i}`); }
  for (let i = 0; i < 18; i += 1) lru.park(resident[i]);   // 18 ≥ backlog gate (16)
  const gpp0 = lru.getStats().geomPressureParks;
  lru.tickEviction(centre);
  const st = lru.getStats();
  check("Test4: backlog gate held the feed", st.geomPressureBacklogHolds > 0,
    `holds=${st.geomPressureBacklogHolds}`);
  check("Test4: no extra resident LB was parked into a full pool",
    st.geomPressureParks === gpp0, `gpp ${gpp0} → ${st.geomPressureParks}`);
  check("Test4: the pool still drained (dispose ran)", st.evicted > 0, `evicted=${st.evicted}`);
}

// ── Test 5: hysteresis. The latch engages above the cap and releases only at
// GEOM_PRESSURE_RELEASE_FRAC of it, so sitting exactly at the cap cannot
// re-arm the feed on every bake (the park/unpark thrash half).
{
  const mod = await loadLru("?warmPark=on&maxLiveGeom=100&parkUseTimeMs=0&reclaimMinAgeMs=0&reclaimGate=off");
  const { LandblockLRU, lbKeyFromXY } = mod;
  const s = makeScene(0);
  const centre = lbKeyFromXY(CX, CY);
  const lru = new LandblockLRU({ scene3d: s, maxResident: 100, getCurrentLbId: () => centre });
  s.renderer.info.memory.geometries = 101;
  check("Test5: engages above the cap", lru._geomPressure() === true);
  s.renderer.info.memory.geometries = 100;
  check("Test5: still engaged AT the cap (hysteresis)", lru._geomPressure() === true);
  s.renderer.info.memory.geometries = 95;
  check("Test5: still engaged above the low-water mark", lru._geomPressure() === true);
  s.renderer.info.memory.geometries = 90;
  check("Test5: releases at the low-water mark", lru._geomPressure() === false);
  s.renderer.info.memory.geometries = 95;
  check("Test5: does NOT re-arm below the cap", lru._geomPressure() === false);
  check("Test5: one engagement recorded, not one per tick",
    lru.getStats().geomPressureEngagements === 1, `n=${lru.getStats().geomPressureEngagements}`);
}

// ── Test 6: the counters are unconditional (present with the governor OFF and
// with warm-park OFF) — the "flag off vs dead code" lesson.
{
  const mod = await loadLru("?warmPark=off&maxLiveGeom=off");
  const { LandblockLRU, lbKeyFromXY } = mod;
  const lru = new LandblockLRU({ scene3d: makeScene(0), maxResident: 5, getCurrentLbId: () => lbKeyFromXY(CX, CY) });
  const st = lru.getStats();
  check("Test6: parksPerTickMax exposed", typeof st.parksPerTickMax === "number");
  check("Test6: maxParksPerTick exposed", typeof st.maxParksPerTick === "number" && st.maxParksPerTick > 0);
  check("Test6: parkBoundHits exposed", typeof st.parkBoundHits === "number");
  check("Test6: sealedParksPerTickMax exposed", typeof st.sealedParksPerTickMax === "number");
  check("Test6: geomPressure*Holds exposed",
    typeof st.geomPressureBacklogHolds === "number" && typeof st.geomPressureFloorHolds === "number");
  check("Test6: governor off ⇒ latch never engages", lru._geomPressure() === false);
}

// ── Test 7: the sealed purge keeps its deliberate time-budgeted burst (nothing
// outdoor is visible inside a sealed dungeon), counted separately so the
// normal-path bound stays auditable.
{
  const mod = await loadLru("?warmPark=on&maxLiveGeom=off&parkUseTimeMs=0&reclaimMinAgeMs=0&reclaimGate=off");
  const { LandblockLRU, lbKeyFromXY } = mod;
  const s = makeScene(0);
  const keep = lbKeyFromXY(CX, CY);
  const lru = new LandblockLRU({ scene3d: s, maxResident: 500, getCurrentLbId: () => keep });
  for (let i = 0; i < 60; i += 1) lru.track(lbKeyFromXY(CX + 5 + (i % 30), CY + 5 + Math.floor(i / 30)));
  lru.track(keep);
  lru.tickEviction(keep, keep);
  const st = lru.getStats();
  check("Test7: sealed burst still bulk-parks (unchanged)", st.parked > 8, `parked=${st.parked}`);
  check("Test7: sealed parks counted separately", st.sealedParksPerTickMax > 8, `n=${st.sealedParksPerTickMax}`);
  check("Test7: normal-path parksPerTickMax untouched by the sealed burst",
    st.parksPerTickMax === 0, `n=${st.parksPerTickMax}`);
  check("Test7: the keep LB survived", lru.entries.has(keep));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
