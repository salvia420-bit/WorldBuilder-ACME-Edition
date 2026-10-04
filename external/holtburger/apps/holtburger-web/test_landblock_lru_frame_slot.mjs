// Perf T4 (OpenAC comparison 2026-10-04) — under `?frameWork=on` the LRU's
// multi-LB loops stop on an exhausted stream slot instead of running whole.
// One LB is one stage; the rest stay candidates for the next tick.
//
// Needs its own process: `frame_work.js` reads `?frameWork` once, at first
// import, so the window stub must exist before anything loads it.
//
// Run: cd apps/holtburger-web/ && node test_landblock_lru_frame_slot.mjs

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? (passed += 1) : (failed += 1);
}

globalThis.window = {
  location: { search: "?frameWork=on&workBudget=5&workShrink=off&warmPark=on&maxLiveGeom=off&parkUseTimeMs=0&reclaimMinAgeMs=0&reclaimGate=off" },
  __bootState: "in-world",
};
const fw = await import("./scene3d/frame_work.js");
const { LandblockLRU, lbKeyFromXY } = await import("./scene3d/landblock_lru.js");

function makeScene() {
  return {
    terrainBakedLbs: new Set(), buildingsBakedLbs: new Set(),
    staticsBakedLbs: new Set(), envCellLoadedLbs: new Set(),
    terrainMaterials: [], activeLights: [],
    _streamGuardState: { inFlight: new Set() },
    renderer: { info: { memory: { geometries: 0 } } },
  };
}
const spin = (ms) => { const t = performance.now(); while (performance.now() - t < ms) { /* busy */ } };
const CX = 0x40, CY = 0x40;
const centre = lbKeyFromXY(CX, CY);

function build(n, maxResident) {
  const s = makeScene();
  const lru = new LandblockLRU({ scene3d: s, maxResident, getCurrentLbId: () => centre });
  for (let i = 0; i < n; i += 1) lru.track(lbKeyFromXY(CX + 5 + (i % 25), CY + 5 + Math.floor(i / 25)));
  const reclaimed = [];
  // Each reclaim costs ~2 ms of real main-thread time; drop the entry the way
  // park() would so the next tick sees the shrunk resident set.
  lru._reclaim = (key) => { spin(2); reclaimed.push(key); lru.entries.delete(key); };
  return { lru, reclaimed };
}

console.log("LRU under the ?frameWork slot (perf T4)");

// ── 1. normal at-cap path: 8 victims (MAX_PARKS_PER_TICK) against a 5 ms slot.
{
  const { lru, reclaimed } = build(20, 12);
  fw.frameWorkW6Run("lruEviction", () => lru.tickEviction(centre), { release: true });
  fw.frameWorkP4({});
  const n1 = reclaimed.length;
  check("the slot stops the victim loop early", n1 >= 2 && n1 <= 4, `reclaimed=${n1} of 8`);
  check("the rest are recorded as slot-deferred", lru.getStats().reclaimSlotDeferred === 8 - n1,
    `deferred=${lru.getStats().reclaimSlotDeferred}`);
  check("the yield shows on __frameWork.caps.slotYields", window.__frameWork.caps.slotYields >= 1);
  for (let t = 0; t < 10 && lru.entries.size > 12; t += 1) {
    fw.frameWorkW6Run("lruEviction", () => lru.tickEviction(centre), { release: true });
    fw.frameWorkP4({});
  }
  check("later slots finish the overage", lru.entries.size === 12, `resident=${lru.entries.size}`);
  const seen = new Set(reclaimed);
  check("no LB reclaimed twice", seen.size === reclaimed.length);
}

// ── 2. outside a slot the same tick runs whole (flag-OFF shape).
{
  const { lru, reclaimed } = build(20, 12);
  lru.tickEviction(centre);
  check("outside the slot all 8 victims go in one tick", reclaimed.length === 8, `reclaimed=${reclaimed.length}`);
  check("...and nothing is slot-deferred", lru.getStats().reclaimSlotDeferred === 0);
}

// ── 3. sealed drain: the slot, not the private 250 ms first burst, bounds it.
{
  const { lru, reclaimed } = build(30, 200);
  const keep = centre;
  fw.frameWorkW6Run("lruEviction", () => lru.tickEviction(centre, keep), { release: true });
  fw.frameWorkP4({});
  const n = reclaimed.length;
  check("sealed first burst is slot-bounded (~5 ms, not 250 ms)", n >= 2 && n <= 4, `reclaimed=${n} of 30`);
  const { lru: lru2, reclaimed: r2 } = build(30, 200);
  lru2.tickEviction(centre, keep);
  check("outside the slot the private 250 ms burst drains everything", r2.length === 30, `reclaimed=${r2.length}`);
}

delete globalThis.window;
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
