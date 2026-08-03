// Residency #11 (2026-08-03) — sealedPark warm-return reserve.
//
// THE PROBLEM. A sealed dungeon (no outdoor-facing portal: the Holtburg
// meeting hall, Town Network, every portal hub) is where players round-trip
// constantly, and it is where the residency stack reclaims hardest — the
// sealed purge parks every resident LB beyond the keep-ring and
// `tickPvsLoadExpansion` drops the prefetch skirt to 0. Under `?warmPark`
// (default-on) the purge PARKS rather than disposes, but the parked set does
// not survive the dwell: the pool's byte backstop drains it once the 30 s
// UseTime floor ages out, and the live-geometry governor BYPASSES that floor
// entirely — and inside a sealed hub the parked outdoor set is the governor's
// only feed (the interior EnvCells are resident and un-reclaimable), so a
// breach drains the pool to EMPTY. Either way the exit is a cold rebuild.
//
// THE FIX UNDER TEST. `?sealedPark` (default on) pins a bounded RETURN CORE of
// the sealed-parked set — nearest to the dungeon's own LB, ≤ SEALED_PARK_RADIUS
// (3), ≤ SEALED_PARK_MAX_LBS (48), ≤ `?sealedParkBudgetMb` (64 MB) — exempt
// from BOTH pressure halves while sealed, then drained back on the
// sealed→outdoor transition (nearest-first, ≤4/tick). Pins are released by a
// keep-LB change, a teleport away while inside, a governor breach at exit, the
// drain deadline, and every pool exit (`unpark` / `disposeParked`).
//
// Run from apps/holtburger-web/:  node test_landblock_lru_sealed_park.mjs

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// The module reads its flags at LOAD time from window.location.search, so each
// arm installs a stub then cache-busts the import (zero-import leaf module).
async function load(search, tag) {
  globalThis.window = { location: { search } };
  return import(`./scene3d/landblock_lru.js?cfg=${tag}`);
}

function makeStubScene3d(geometries = 0) {
  return {
    terrainGroup: { children: [], add() {}, remove() {} },
    buildingsGroup: { children: [], add() {}, remove() {} },
    staticsGroup: { children: [], add() {}, remove() {} },
    cellsGroup: { children: [], add() {}, remove() {} },
    cellContainers3d: new Map(),
    buildingMap3d: new Map(),
    terrainBakedLbs: new Set(),
    buildingsBakedLbs: new Set(),
    staticsBakedLbs: new Set(),
    envCellLoadedLbs: new Set(),
    terrainMaterials: [],
    activeLights: [],
    // #10 governor input. `_geomPressure()` reads it live, so a test can flip
    // `.memory.geometries` mid-run to simulate a ceiling breach.
    renderer: { info: { memory: { geometries } } },
  };
}

// Track an LB carrying `bytes` of geometry so park()'s _estimateParkedBytes
// gives the pool real weight (that is what the byte caps key on).
function trackLb(lru, key, bytes) {
  lru.track(key >>> 0, {
    geometries: [{
      uuid: `g-${key >>> 0}`,
      attributes: { position: { array: { byteLength: bytes } } },
      index: null,
      dispose() { this.disposed = true; },
    }],
  });
}

const MB = 1024 * 1024;

// Build a keep LB + a square neighbourhood out to `radius`, all tracked.
// Returns { keep, keys, byDist: Map<dist, keys[]> }.
function seedNeighbourhood(lru, lbKeyFromXY, cx, cy, radius, bytes) {
  const keep = lbKeyFromXY(cx, cy);
  const keys = [];
  const byDist = new Map();
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      const k = lbKeyFromXY(cx + dx, cy + dy);
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      trackLb(lru, k, bytes);
      keys.push(k);
      if (!byDist.has(d)) byDist.set(d, []);
      byDist.get(d).push(k);
    }
  }
  return { keep, keys, byDist };
}

console.log("Residency #11 — sealedPark warm-return reserve (?sealedPark)");

// Warm-park ON (the feature is layered on the park pool); gate + hysteresis OFF
// so tickEviction's normal path isn't perturbed by unrelated arms.
const DEFAULT_SEARCH = "?warmPark=on&reclaimGate=off&reclaimMinAgeMs=0";

// ── 1. Sealed entry pins the return core, and only the return core ──────────
{
  const { LandblockLRU, lbKeyFromXY, lbChebyshev } = await load(DEFAULT_SEARCH, "t1");
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 500, getCurrentLbId: () => 0 });
  // Radius 5 = the default pvs prefetch ring (121 LBs) — the real sealed set.
  const { keep, keys } = seedNeighbourhood(lru, lbKeyFromXY, 0x40, 0x40, 5, 64 * 1024);
  check("121 LBs resident before the seal", lru.entries.size === 121, `size=${lru.entries.size}`);

  lru.tickEviction(keep, keep);

  const kept = keys.filter((k) => lru.entries.has(k));
  check("sealed purge keeps only the 3×3 floor resident (sealedKeepRing)",
    kept.length === 9 && kept.every((k) => lbChebyshev(keep, k) <= 1),
    `resident=${kept.length}`);
  check("everything else PARKED, not disposed (warm-park)",
    lru.parkPool.size === 112 && lru.getStats().evicted === 0,
    `pool=${lru.parkPool.size} evicted=${lru.getStats().evicted}`);

  const st = lru.sealedParkStats();
  // Pinnable = 7×7 (49) minus the 9 kept resident = 40.
  check("reserve = the 7×7 return core minus the resident 3×3 (40 LBs)",
    st.pinned === 40, `pinned=${st.pinned}`);
  check("every pinned LB is within SEALED_PARK_RADIUS of the keep",
    [...lru._sealedPinned.keys()].every((k) => lbChebyshev(keep, k) <= 3));
  check("nothing beyond the radius is pinned (the far skirt reclaims as today)",
    st.budgetDrops === 72, `drops=${st.budgetDrops}`);
  check("pin keep LB recorded", st.pinKeepLbKey === keep);
  check("pinnedBytes tracks the reserve", st.pinnedBytes === 40 * 64 * 1024,
    `bytes=${st.pinnedBytes}`);
}

// ── 2. The byte cap binds nearest-first (the core, not the rim) ─────────────
{
  const { LandblockLRU, lbKeyFromXY, lbChebyshev } =
    await load(`${DEFAULT_SEARCH}&sealedParkBudgetMb=4`, "t2");
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 500, getCurrentLbId: () => 0 });
  const { keep } = seedNeighbourhood(lru, lbKeyFromXY, 0x40, 0x40, 4, 1 * MB);
  lru.tickEviction(keep, keep);
  const st = lru.sealedParkStats();
  check("byte cap bounds the reserve (4 MB / 1 MB per LB)", st.pinned === 4,
    `pinned=${st.pinned} bytes=${st.pinnedBytes}`);
  check("the 4 pinned are the NEAREST (dist 2 — the 3×3 is resident)",
    [...lru._sealedPinned.keys()].every((k) => lbChebyshev(keep, k) === 2));
  check("over-cap slots stay ordinary pool entries", lru.parkPool.size === 72,
    `pool=${lru.parkPool.size}`);
}

// ── 3. Byte pressure never disposes the reserve; unpinned slots still drain ─
{
  const { LandblockLRU, lbKeyFromXY, lbChebyshev } =
    await load(`${DEFAULT_SEARCH}&warmParkBudgetMb=1&parkUseTimeMs=0`, "t3");
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 500, getCurrentLbId: () => 0 });
  const { keep } = seedNeighbourhood(lru, lbKeyFromXY, 0x40, 0x40, 5, 256 * 1024);
  lru.tickEviction(keep, keep);
  const pinnedKeys = [...lru._sealedPinned.keys()];
  check("reserve pinned before pressure", pinnedKeys.length === 40);
  // Drive many pressure ticks: the pool is far over a 1 MB budget with the
  // UseTime floor disabled, so every eligible slot is a victim.
  for (let i = 0; i < 200; i += 1) lru.tickEviction(keep, keep);
  const st = lru.sealedParkStats();
  check("every unpinned slot was true-disposed", lru.parkPool.size === 40,
    `pool=${lru.parkPool.size}`);
  check("the reserve survived byte pressure intact",
    pinnedKeys.every((k) => lru.parkPool.has(k)) && st.pinned === 40,
    `pinned=${st.pinned}`);
  check("pin holds counted (the retention proof)", st.pinHolds > 0,
    `pinHolds=${st.pinHolds}`);
  check("no pinned slot was purged", st.fallbackPurged === 0);
  check("survivors are the return core", [...lru.parkPool.keys()].every((k) => lbChebyshev(keep, k) <= 3));
}

// ── 4. The live-geometry governor (which bypasses the UseTime floor) too ────
{
  const { LandblockLRU, lbKeyFromXY } = await load(DEFAULT_SEARCH, "t4");
  // liveGeom far over MAX_LIVE_GEOM (8000): the governor engages, floorMs = 0,
  // and inside a sealed hub the pool is its only feed — pre-#11 that drained
  // the pool to empty.
  const scene3d = makeStubScene3d(99_999);
  const lru = new LandblockLRU({ scene3d, maxResident: 500, getCurrentLbId: () => 0 });
  const { keep } = seedNeighbourhood(lru, lbKeyFromXY, 0x40, 0x40, 5, 64 * 1024);
  lru.tickEviction(keep, keep);
  check("governor engaged", lru.getStats().geomPressureActive === true);
  const pinnedKeys = [...lru._sealedPinned.keys()];
  for (let i = 0; i < 200; i += 1) lru.tickEviction(keep, keep);
  check("governor drained everything OUTSIDE the reserve", lru.parkPool.size === 40,
    `pool=${lru.parkPool.size}`);
  check("reserve survives the governor breach (bounded, ≤64 MB)",
    pinnedKeys.every((k) => lru.parkPool.has(k)));
}

// ── 5. Exit drain: warm re-adopt, nearest-first, bounded per tick ───────────
{
  const { LandblockLRU, lbKeyFromXY, lbChebyshev } = await load(DEFAULT_SEARCH, "t5");
  const scene3d = makeStubScene3d();
  let cur = 0;
  const lru = new LandblockLRU({ scene3d, maxResident: 500, getCurrentLbId: () => cur });
  const { keep } = seedNeighbourhood(lru, lbKeyFromXY, 0x40, 0x40, 5, 64 * 1024);
  cur = keep;
  lru.tickEviction(keep, keep);
  const residentAfterSeal = lru.entries.size;
  // Sealed state clears (player portals out onto the dungeon's own LB).
  lru.tickEviction(keep, 0);
  const afterOne = lru.sealedParkStats();
  check("exit drain re-adopts ≤ SEALED_EXIT_UNPARK_PER_TICK per tick",
    afterOne.warmUnparked === 4, `warmUnparked=${afterOne.warmUnparked}`);
  check("re-adopts are resident again", lru.entries.size === residentAfterSeal + 4,
    `resident=${lru.entries.size}`);
  check("re-adopts are pure re-attaches, not re-bakes (unpark, 0 evictions)",
    lru.getStats().unparkedTotal === 4 && lru.getStats().evicted === 0);
  check("nearest-first: the dist-2 ring goes first",
    lru.getStats().resident === residentAfterSeal + 4
      && [...lru.entries.keys()].every((k) => lbChebyshev(keep, k) <= 2));
  // Drain to completion.
  for (let i = 0; i < 20; i += 1) lru.tickEviction(keep, 0);
  const st = lru.sealedParkStats();
  check("drain re-adopts the whole 5×5 exit neighbourhood (25 − 9 resident = 16)",
    st.warmUnparked === 16, `warmUnparked=${st.warmUnparked}`);
  check("reserve released once nothing near is left to warm", st.pinned === 0);
  check("the rest stays PARKED (still warm for the loaders' fast path)",
    lru.parkPool.size === 112 - 16, `pool=${lru.parkPool.size}`);
}

// ── 6. Teleport away WHILE INSIDE → release, no re-adopt, reclaimable ───────
{
  // parkUseTimeMs=0 so the post-release pressure check isn't just the 30 s
  // DBOCache floor deferring everything (that floor is tested separately).
  const { LandblockLRU, lbKeyFromXY } = await load(`${DEFAULT_SEARCH}&parkUseTimeMs=0`, "t6");
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 500, getCurrentLbId: () => 0 });
  const { keep } = seedNeighbourhood(lru, lbKeyFromXY, 0x40, 0x40, 5, 64 * 1024);
  lru.tickEviction(keep, keep);
  check("reserve pinned", lru.sealedParkStats().pinned === 40);
  // Player recalls/portals to a distant area while still inside; the sealed
  // flag clears with a center far from the keep.
  const far = lbKeyFromXY(0x10, 0x10);
  lru.tickEviction(far, 0);
  const st = lru.sealedParkStats();
  check("reserve released without re-adopting", st.pinned === 0 && st.warmUnparked === 0);
  check("release counted as teleport-away", st.releasedAway === 40, `away=${st.releasedAway}`);
  check("slots stay in the pool for ordinary pressure to reclaim",
    lru.parkPool.size === 112, `pool=${lru.parkPool.size}`);
  // …and pressure CAN now reclaim them (parking is not immortality).
  lru.parkBudgetBytes = 0;
  for (let i = 0; i < 400; i += 1) lru.tickEviction(far, 0);
  check("pressure reclaims the former reserve after release", lru.parkPool.size === 0,
    `pool=${lru.parkPool.size}`);
}

// ── 7. A DIFFERENT sealed dungeon invalidates the reserve ───────────────────
{
  const { LandblockLRU, lbKeyFromXY, lbChebyshev } = await load(DEFAULT_SEARCH, "t7");
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 500, getCurrentLbId: () => 0 });
  const { keep } = seedNeighbourhood(lru, lbKeyFromXY, 0x40, 0x40, 5, 64 * 1024);
  lru.tickEviction(keep, keep);
  check("reserve belongs to dungeon A", lru.sealedParkStats().pinKeepLbKey === keep);
  // Hub→hub portal: a new sealed dungeon 20 LBs away becomes the keep.
  const keepB = lbKeyFromXY(0x54, 0x40);
  trackLb(lru, keepB, 64 * 1024);
  lru.tickEviction(keepB, keepB);
  const st = lru.sealedParkStats();
  check("dungeon A's reserve released on the keep change", st.releasedAway === 40,
    `away=${st.releasedAway}`);
  check("only dungeon B's own neighbourhood can be pinned now",
    st.pinKeepLbKey === 0 || [...lru._sealedPinned.keys()].every((k) => lbChebyshev(keepB, k) <= 3),
    `pinned=${st.pinned}`);
}

// ── 8. The exit drain is deadlined (a stuck center can't pin forever) ───────
{
  const { LandblockLRU, lbKeyFromXY } = await load(DEFAULT_SEARCH, "t8");
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 500, getCurrentLbId: () => null });
  const { keep } = seedNeighbourhood(lru, lbKeyFromXY, 0x40, 0x40, 5, 64 * 1024);
  lru.tickEviction(keep, keep);
  lru.tickEviction(null, 0); // sealed clears, center still unresolved
  check("drain waits for a center", lru.sealedParkStats().pinned === 40);
  // Age the drain past SEALED_EXIT_DRAIN_MAX_MS.
  lru._sealedExitAtMs -= 6000;
  lru.tickEviction(null, 0);
  check("deadline releases the reserve", lru.sealedParkStats().pinned === 0);
}

// ── 9. `?sealedPark=off` restores today's purge exactly ─────────────────────
{
  const { LandblockLRU, lbKeyFromXY } =
    await load(`${DEFAULT_SEARCH}&sealedPark=off&warmParkBudgetMb=1&parkUseTimeMs=0`, "t9");
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 500, getCurrentLbId: () => 0 });
  const { keep } = seedNeighbourhood(lru, lbKeyFromXY, 0x40, 0x40, 5, 256 * 1024);
  lru.tickEviction(keep, keep);
  const st = lru.sealedParkStats();
  check("off: nothing is pinned", st.pinned === 0 && st.enabled === false);
  check("off: the purge itself is unchanged (9 resident, 112 reclaimed)",
    lru.entries.size === 9 && lru.parkPool.size + lru.getStats().evicted === 112,
    `resident=${lru.entries.size} pool=${lru.parkPool.size} evicted=${lru.getStats().evicted}`);
  lru.parkBudgetBytes = 0;
  for (let i = 0; i < 400; i += 1) lru.tickEviction(keep, keep);
  check("off: pressure drains the whole pool (today's cold-exit behavior)",
    lru.parkPool.size === 0 && lru.getStats().evicted === 112,
    `pool=${lru.parkPool.size} evicted=${lru.getStats().evicted}`);
  check("off: no exit drain", lru.sealedParkStats().warmUnparked === 0);
}

// ── 10. A loader fast-path unpark while inside drops the pin ────────────────
{
  const { LandblockLRU, lbKeyFromXY } = await load(DEFAULT_SEARCH, "t10");
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 500, getCurrentLbId: () => 0 });
  const { keep } = seedNeighbourhood(lru, lbKeyFromXY, 0x40, 0x40, 5, 64 * 1024);
  lru.tickEviction(keep, keep);
  const victim = [...lru._sealedPinned.keys()][0];
  // `index.js loadTerrainForLandblock`'s already-baked fast path: unpark on
  // sight. The slot is resident again, so the pin must go with it.
  check("unpark re-adopts", lru.unpark(victim) === true);
  check("pin dropped with the slot", !lru._sealedPinned.has(victim));
  check("pinnedBytes stays consistent",
    lru.sealedParkStats().pinnedBytes === 39 * 64 * 1024,
    `bytes=${lru.sealedParkStats().pinnedBytes}`);
}

// ── 11. Classic mode (?warmPark=off): inert, purge unchanged ────────────────
{
  const { LandblockLRU, lbKeyFromXY } = await load("?warmPark=off&reclaimGate=off", "t11");
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 500, getCurrentLbId: () => 0 });
  const { keep } = seedNeighbourhood(lru, lbKeyFromXY, 0x40, 0x40, 5, 64 * 1024);
  lru.tickEviction(keep, keep);
  check("classic: sealed purge still DISPOSES (warmPark is the escape)",
    lru.getStats().evicted === 112 && lru.parkPool.size === 0,
    `evicted=${lru.getStats().evicted}`);
  check("classic: nothing pinned (no pool to pin)",
    lru.sealedParkStats().pinned === 0 && lru.sealedParkStats().active === false);
}

// eslint-disable-next-line no-console
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
