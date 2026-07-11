// S15a (2026-07-11, PLAN-fixed-slot-grid-residency §2/§5) — park→DBOCache
// UseTime floor tests.
//
// Retail's DBOCache (acclient.c:83485 GetIfUsing) holds decoded resources
// behind a ~30 s UseTime freelist floor: release ≠ free. Applied at our park
// layer — a parked slot younger than PARK_USE_TIME_MS is NOT true-disposed by
// park-pool byte PRESSURE (_tickParkPoolPressure), so a short-hop re-entry
// within the window is a pointer re-adopt (unpark), zero decode/bake. The
// byte-budget LRU stays the memory backstop BEHIND the floor: pressure
// disposes only entries older than the floor; if the budget is still exceeded
// with everything young, the overage is RECORDED (useTimeDeferred* counters)
// and ages out on later ticks — pressure never violates the floor.
//
// PARK_USE_TIME_MS + WARM_PARK_ON are module-load consts read from
// window.location.search, so — like the warmpark/sealed suites — each flag
// config installs a window stub BEFORE a cache-busting dynamic import (the
// module is a zero-import leaf, so re-importing with a fresh `?cfg=` query
// re-evaluates it cleanly against the new stub).
//
// Run with:
//   cd apps/holtburger-web/
//   node test_park_usetime.mjs

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

async function load(search, tag) {
  globalThis.window = { location: { search } };
  return import(`./scene3d/landblock_lru.js?cfg=${tag}`);
}

function makeStubScene3d() {
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
  };
}

// Track + park an LB carrying `bytes` of geometry so the pool has real weight
// (park()'s _estimateParkedBytes reads attribute.array.byteLength). Returns the
// parked-pool record so tests can age it.
function parkLb(lru, key, bytes) {
  const geom = {
    uuid: `g-${key >>> 0}`,
    attributes: { position: { array: { byteLength: bytes } } },
    index: null,
    disposed: false,
    dispose() { this.disposed = true; },
  };
  lru.track(key, { geometries: [geom] });
  lru.park(key);
  return { geom, p: lru.parkPool.get(key >>> 0) };
}

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

console.log("S15a — park→DBOCache UseTime floor (?parkUseTimeMs)");

// Shared default config: floor ON (absent param → 30000), warm-park ON, gate +
// hysteresis OFF so tickEviction/pressure aren't perturbed by unrelated arms.
const DEFAULT_SEARCH = "?warmPark=on&reclaimMinAgeMs=0&reclaimGate=off";
const modDefault = await load(DEFAULT_SEARCH, "default");
const { LandblockLRU, lbKeyFromXY } = modDefault;

const KEEP = lbKeyFromXY(0x40, 0x40);
const FAR = lbKeyFromXY(0x50, 0x50);
const FAR2 = lbKeyFromXY(0x52, 0x52);
const FAR3 = lbKeyFromXY(0x54, 0x54);

// --- sanity: the floor is DEFAULT-ON at 30000 with the param absent.
{
  const lru = new LandblockLRU({ scene3d: makeStubScene3d(), maxResident: 1 });
  check("floor default-ON = 30000 (param absent)", lru.getStats().parkUseTimeMs === 30_000,
    `parkUseTimeMs=${lru.getStats().parkUseTimeMs}`);
  check("warm-park ON under the window stub", lru.warmParkEnabled === true);
}

// --- (a) a YOUNG parked entry survives a pressure tick that would otherwise
//     dispose it (release ≠ free within the floor).
{
  const lru = new LandblockLRU({ scene3d: makeStubScene3d(), maxResident: 1 });
  parkLb(lru, FAR, 10 * 1024 * 1024); // just-parked → parkedAtMs ≈ now (young)
  lru.parkBudgetBytes = 1; // force byte pressure
  lru._tickParkPoolPressure(KEEP);
  check("(a) young parked slot NOT disposed under pressure", lru.parkPool.has(FAR));
  check("(a) zero true-disposes", lru.getStats().evicted === 0, `evicted=${lru.getStats().evicted}`);
  check("(a) deferral counted", lru.getStats().useTimeDeferredCount === 1,
    `count=${lru.getStats().useTimeDeferredCount}`);
  check("(a) deferred bytes recorded", lru.getStats().useTimeDeferredBytes >= 10 * 1024 * 1024);
}

// --- (b) an entry OLDER than the floor IS disposable under pressure (the byte
//     LRU stays the backstop behind the floor).
{
  const lru = new LandblockLRU({ scene3d: makeStubScene3d(), maxResident: 1 });
  const { p } = parkLb(lru, FAR, 10 * 1024 * 1024);
  p.parkedAtMs = nowMs() - 40_000; // aged past the 30 s floor
  lru.parkBudgetBytes = 1;
  lru._tickParkPoolPressure(KEEP);
  check("(b) aged parked slot IS true-disposed", !lru.parkPool.has(FAR));
  check("(b) exactly one true-dispose", lru.getStats().evicted === 1, `evicted=${lru.getStats().evicted}`);
  check("(b) no deferral for an aged slot", lru.getStats().useTimeDeferredCount === 0);
}

// --- (c) ?parkUseTimeMs=0 restores pre-floor behavior byte-identically: a
//     YOUNG slot is disposed under pressure, no deferral counters bump.
{
  const mod0 = await load("?warmPark=on&reclaimMinAgeMs=0&reclaimGate=off&parkUseTimeMs=0", "floor0");
  const lru = new mod0.LandblockLRU({ scene3d: makeStubScene3d(), maxResident: 1 });
  check("(c) floor disabled (parkUseTimeMs=0)", lru.getStats().parkUseTimeMs === 0);
  parkLb(lru, mod0.lbKeyFromXY(0x50, 0x50), 10 * 1024 * 1024); // young
  lru.parkBudgetBytes = 1;
  lru._tickParkPoolPressure(mod0.lbKeyFromXY(0x40, 0x40));
  check("(c) young slot DISPOSED with floor off (pre-S15 behavior)",
    !lru.parkPool.has(mod0.lbKeyFromXY(0x50, 0x50)) && lru.getStats().evicted === 1);
  check("(c) no deferral counters bumped when disabled", lru.getStats().useTimeDeferredCount === 0
    && lru.getStats().useTimeDeferredBytes === 0);

  // `off` / `false` tokens also disable the floor.
  const modOff = await load("?warmPark=on&parkUseTimeMs=off", "flooroff");
  const lruOff = new modOff.LandblockLRU({ scene3d: makeStubScene3d(), maxResident: 1 });
  check("(c) parkUseTimeMs=off disables the floor", lruOff.getStats().parkUseTimeMs === 0);
  const modFalse = await load("?warmPark=on&parkUseTimeMs=false", "floorfalse");
  const lruFalse = new modFalse.LandblockLRU({ scene3d: makeStubScene3d(), maxResident: 1 });
  check("(c) parkUseTimeMs=false disables the floor", lruFalse.getStats().parkUseTimeMs === 0);
}

// --- (d) sealedKeepRing interplay unchanged: the sealed purge still parks the
//     backlog beyond the 3×3 and KEEPS the 3×3 floor, and the freshly-parked
//     (young) sealed victims survive the pressure pass at the tick's tail.
{
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 200, getCurrentLbId: () => KEEP });
  lru.track(KEEP);
  const ring = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const k = lbKeyFromXY(0x40 + dx, 0x40 + dy);
      ring.push(k);
      lru.track(k);
    }
  }
  // Two far LBs (Chebyshev > 1) carrying bytes so the pool has weight.
  for (const k of [FAR, FAR2]) lru.track(k, { geometries: [{ uuid: `g-${k}`, attributes: { position: { array: { byteLength: 8 * 1024 * 1024 } } }, index: null, dispose() {} }] });

  lru.tickEviction(KEEP, KEEP); // sealed: keep = KEEP
  check("(d) sealed purge parked the far backlog", lru.parkPool.has(FAR) && lru.parkPool.has(FAR2));
  check("(d) sealedKeepRing kept the dungeon LB + its 3×3",
    lru.entries.has(KEEP) && ring.every((k) => lru.entries.has(k)),
    `residentRing=${ring.filter((k) => lru.entries.has(k)).length}/8`);
  check("(d) sealed purge produced zero true-disposes", lru.getStats().evicted === 0,
    `evicted=${lru.getStats().evicted}`);

  // Now squeeze the pool: the young sealed-parks must survive the floor.
  lru.parkBudgetBytes = 1;
  lru._tickParkPoolPressure(KEEP);
  check("(d) young sealed-parks survive pressure (floor protects them)",
    lru.parkPool.has(FAR) && lru.parkPool.has(FAR2) && lru.getStats().evicted === 0);
  check("(d) deferral counters bumped for the young sealed-parks",
    lru.getStats().useTimeDeferredCount >= 2);
}

// --- (e) budget exceeded with EVERY parked slot young: nothing disposed, the
//     counters bump for each, and no throw.
{
  const lru = new LandblockLRU({ scene3d: makeStubScene3d(), maxResident: 1 });
  parkLb(lru, FAR, 10 * 1024 * 1024);
  parkLb(lru, FAR2, 10 * 1024 * 1024);
  parkLb(lru, FAR3, 10 * 1024 * 1024);
  lru.parkBudgetBytes = 1; // way over budget, everything young
  let threw = false;
  try { lru._tickParkPoolPressure(KEEP); } catch (_) { threw = true; }
  check("(e) no throw when all candidates are young", threw === false);
  check("(e) nothing disposed", lru.parkPool.size === 3 && lru.getStats().evicted === 0,
    `pool=${lru.parkPool.size} evicted=${lru.getStats().evicted}`);
  check("(e) all three deferrals counted", lru.getStats().useTimeDeferredCount === 3,
    `count=${lru.getStats().useTimeDeferredCount}`);
  check("(e) deferred bytes ≈ pooled residency", lru.getStats().useTimeDeferredBytes >= 30 * 1024 * 1024);
}

// --- (f) unpark within the floor works: a pointer re-adopt back into entries,
//     out of the pool, with ZERO true-disposes.
{
  const lru = new LandblockLRU({ scene3d: makeStubScene3d(), maxResident: 1 });
  parkLb(lru, FAR, 10 * 1024 * 1024); // young
  check("(f) fixture: parked", lru.parkPool.has(FAR) && !lru.entries.has(FAR));
  const ok = lru.unpark(FAR);
  check("(f) unpark re-adopts into entries", ok && lru.entries.has(FAR) && !lru.parkPool.has(FAR));
  check("(f) unpark is a pure re-attach — no true-dispose", lru.getStats().evicted === 0);
  check("(f) unpark counted", lru.getStats().unparkedTotal === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
