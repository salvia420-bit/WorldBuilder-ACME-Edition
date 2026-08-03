// Session 7 (2026-07-10) — TN-transition park↔unpark storm fix tests
// (1114 §2b root cause / §5 top item).
//
// The storm: an in-flight guarded bake completing AFTER its LB parked
// called track(), which didn't check parkPool — leaving the LB in
// `entries` AND the pool (dual state). The next park() of that key hit the
// "shouldn't happen" branch and TRUE-DISPOSED the pool copy (measured
// 74–614 disposes/run at TN entry). The fix restores the entries-XOR-pool
// invariant at both ends:
//   1. reclaim victim selection (normal at-cap AND both sealed-purge arms)
//      skips LBs with an in-flight guarded bake (scene3d._streamGuardState
//      membership — the loaders call track() INSIDE the guarded run, so
//      membership exactly brackets the race window);
//   2. a track() that still lands while parked (envcell build resolving
//      past its cancellation, setup-lights rescan) MERGES its disposables
//      into the pool copy instead of creating an entries entry.
//
// WARM_PARK_ON is a module-load const read from window.location.search, so
// this suite installs a window stub with ?warmPark=on BEFORE dynamically
// importing the module (the other LRU suites import statically and stay on
// the classic paths — deliberate, per the headless-stays-classic note).
//
// Run with:
//   cd apps/holtburger-web/
//   node test_landblock_lru_warmpark_dualstate.mjs

globalThis.window = { location: { search: "?warmPark=on&reclaimMinAgeMs=0&reclaimGate=off" } };

const { LandblockLRU, lbKeyFromXY } = await import("./scene3d/landblock_lru.js");

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

console.log("Session 7 — LandblockLRU warm-park dual-state (TN storm) fix");

function makeStubScene3d() {
  return {
    terrainBakedLbs: new Set(),
    buildingsBakedLbs: new Set(),
    staticsBakedLbs: new Set(),
    envCellLoadedLbs: new Set(),
    terrainMaterials: [],
    activeLights: [],
    _streamGuardState: { inFlight: new Set(), failUntil: new Map(), warnedAt: new Map() },
  };
}

const CX = 0x40;
const CY = 0x40;
const centreKey = lbKeyFromXY(CX, CY);
const farKey = lbKeyFromXY(CX + 10, CY + 10);
const farKey2 = lbKeyFromXY(CX + 12, CY + 12);

function makeGeom(tag) {
  return { uuid: `geom-${tag}`, attributes: {}, disposed: false, dispose() { this.disposed = true; } };
}

// --- Test 1: warm-park is actually ON under the window stub (sanity —
//     without this every other test silently exercises classic evict).
{
  const lru = new LandblockLRU({ scene3d: makeStubScene3d(), maxResident: 1 });
  check("warmParkEnabled under ?warmPark=on window stub", lru.warmParkEnabled === true);
}

// --- Test 2: at-cap reclaim DEFERS an LB whose guarded bake is in flight
//     (any of the three kinds), and parks it once the bake completes.
{
  const s = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d: s, maxResident: 1, getCurrentLbId: () => centreKey });
  lru.track(centreKey);
  lru.track(farKey);
  lru.entries.get(farKey).lastTouchMs = -10_000; // age past any hysteresis
  s._streamGuardState.inFlight.add(`statics:${farKey}`);

  lru.tickEviction(centreKey);
  check("in-flight LB NOT parked (still in entries)", lru.entries.has(farKey));
  check("nothing entered the pool while deferred", lru.parkPool.size === 0, `pool=${lru.parkPool.size}`);
  check("deferral counted", lru.getStats().reclaimDeferredInFlight > 0);

  // Bake completes: guard entry clears, next tick parks it.
  s._streamGuardState.inFlight.delete(`statics:${farKey}`);
  lru.entries.get(farKey).lastTouchMs = -10_000;
  lru.tickEviction(centreKey);
  check("parked once the bake landed", lru.parkPool.has(farKey) && !lru.entries.has(farKey));
  check("no true-dispose in the whole sequence", lru.getStats().evicted === 0, `evicted=${lru.getStats().evicted}`);
}

// --- Test 3: sealed purge (burst arm) defers in-flight LBs to the
//     straggler flow instead of parking them mid-bake.
{
  const s = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d: s, maxResident: 200, getCurrentLbId: () => centreKey });
  lru.track(centreKey);
  lru.track(farKey);
  lru.track(farKey2);
  s._streamGuardState.inFlight.add(`terrain:${farKey}`);

  lru.tickEviction(centreKey, centreKey); // sealed: keep = centre
  check("sealed purge parked the idle LB", lru.parkPool.has(farKey2));
  check("sealed purge deferred the in-flight LB", lru.entries.has(farKey) && !lru.parkPool.has(farKey));

  // Straggler flow: bake completes, next sealed tick purges it cleanly.
  s._streamGuardState.inFlight.delete(`terrain:${farKey}`);
  lru.tickEviction(centreKey, centreKey);
  check("straggler parked on the next sealed tick", lru.parkPool.has(farKey) && !lru.entries.has(farKey));
  check("sealed sequence produced ZERO true-disposes", lru.getStats().evicted === 0, `evicted=${lru.getStats().evicted}`);
}

// --- Test 4: track() while parked MERGES into the pool copy — no entries
//     entry (no dual state), disposables land in the parked disposables and
//     are disposed by disposeParked().
{
  const s = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d: s, maxResident: 1, getCurrentLbId: () => centreKey });
  const g0 = makeGeom("baked-before-park");
  lru.track(centreKey);
  lru.track(farKey, { geometries: [g0] });
  lru.entries.get(farKey).lastTouchMs = -10_000;
  lru.tickEviction(centreKey);
  check("fixture: far LB parked", lru.parkPool.has(farKey) && !lru.entries.has(farKey));

  // A late bake completion / rescan calls track() on the parked key.
  const g1 = makeGeom("late-track");
  const light = { disposed: false, dispose() { this.disposed = true; } };
  lru.track(farKey, { geometries: [g1], lights: [light] });
  check("late track creates NO entries entry (invariant held)", !lru.entries.has(farKey));
  check("late track merge counted", lru.getStats().trackMergedWhileParked === 1);
  const pooled = lru.parkPool.get(farKey);
  check("merged geometry lives in the pool copy", pooled.disposables.geometries.includes(g1));
  check("merged light lives in the pool copy", pooled.disposables.lights.includes(light));

  // The next park-shaped reclaim of that key must be impossible (it's not
  // in entries), so no dual-state true-dispose can fire.
  const evictedBefore = lru.getStats().evicted;
  lru.tickEviction(centreKey);
  check("no storm dispose after the merge", lru.getStats().evicted === evictedBefore);

  // Pool exit (dispose): merged disposables are torn down too.
  lru.disposeParked(farKey);
  check("disposeParked disposes the pre-park geometry", g0.disposed === true);
  check("disposeParked disposes the MERGED geometry", g1.disposed === true);
  check("disposeParked disposes the merged light", light.disposed === true);
}

// --- Test 5: unpark() after a merged track restores ONE entries entry
//     carrying the merged disposables (pool exit #2 stays consistent).
{
  const s = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d: s, maxResident: 1, getCurrentLbId: () => centreKey });
  const g0 = makeGeom("pre-park");
  lru.track(centreKey);
  lru.track(farKey, { geometries: [g0] });
  lru.entries.get(farKey).lastTouchMs = -10_000;
  lru.tickEviction(centreKey);
  const g1 = makeGeom("merged");
  lru.track(farKey, { geometries: [g1] });

  lru.unpark(farKey);
  check("unpark restores the entries entry", lru.entries.has(farKey) && !lru.parkPool.has(farKey));
  const entry = lru.entries.get(farKey);
  check("restored entry carries pre-park AND merged disposables",
    entry.disposables.geometries.includes(g0) && entry.disposables.geometries.includes(g1));
  check("nothing was true-disposed across park/merge/unpark", lru.getStats().evicted === 0);
}

// --- Test 6: the legacy dual-state branch still self-heals if forced
//     (defensive last resort — unreachable with both fix halves, but the
//     resolution semantics must not regress).
{
  const s = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d: s, maxResident: 1, getCurrentLbId: () => centreKey });
  lru.track(centreKey);
  lru.track(farKey);
  lru.entries.get(farKey).lastTouchMs = -10_000;
  lru.tickEviction(centreKey);
  check("fixture: parked", lru.parkPool.has(farKey));
  // Force the dual state the fix normally prevents.
  lru.entries.set(farKey, {
    lastTouchMs: -10_000,
    disposables: { geometries: [], materials: [], textures: [], lights: [], instancedNodes: [] },
  });
  lru.park(farKey);
  check("forced dual state resolves to a single pool copy",
    lru.parkPool.has(farKey) && !lru.entries.has(farKey));
  // 2026-08-03 (#15) — the recovery is now NON-destructive: the stale pool
  // copy is discarded without re-entering evict() against the still-resident
  // LB (the old path tore down the LIVE containers, cleared the baked marks
  // and purged wasm collision to heal a bookkeeping glitch). No true-dispose;
  // the drop is counted on its own stat instead.
  check("forced dual state does NOT true-dispose the live LB", lru.getStats().evicted === 0,
    `evicted=${lru.getStats().evicted}`);
  check("forced dual state drops exactly one stale pool copy",
    lru.getStats().stalePoolCopiesDropped === 1,
    `stalePoolCopiesDropped=${lru.getStats().stalePoolCopiesDropped}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
