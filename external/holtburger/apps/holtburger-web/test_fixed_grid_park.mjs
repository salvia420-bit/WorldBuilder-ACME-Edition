// test_fixed_grid_park.mjs — S15c (2026-07-11) acceptance gate for the
// ?fixedGrid vacated-edge → whole-LB PARK wiring + the post-crossing diag grace
// (docs/PLAN-fixed-slot-grid-residency-2026-07-11.md §5.4; docs/1123.md §5.1).
//
// Pure injected-deps style (the test_fixed_grid.mjs / test_park_usetime.mjs
// pattern): drives the pure EdgeParkScheduler + FixedSlotGrid from fixed_grid.js
// and the REAL LandblockLRU (window-stub + cache-busted dynamic import, like
// test_park_usetime) — no browser, no build, no `three`, no wasm.
//
// Covers the brief's (a)–(g):
//   (a) vacated edge → park called with EXACTLY the vacated key set; in-entries
//       filtering (park()==false counted as parkSkippedInEntriesMiss).
//   (b) re-entry within the UseTime floor → pointer re-adopt (unpark), no re-bake.
//   (c) zig-zag crossing → bounded (zero) parks; committed walk parks bounded.
//   (d) teleport invalidate bypasses park (reset; park never called).
//   (e) diag grace: transient unbacked suppressed inside the window, real
//       divergence still warns after it.
//   (f) flag matrix for the ?fixedGridPark sub-escape (default-ON-within).
//   (g) buildings/statics/scenery adoption: a whole-LB park detaches the layer
//       containers (staticsGroup [incl. animated-scenery nodes] + buildingsGroup
//       + cells) — the layer coverage S15c claims.
//
// Run: node test_fixed_grid_park.mjs   (no browser, no build)

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

const { FixedSlotGrid, EdgeParkScheduler } = await import("./scene3d/fixed_grid.js");

const lbKeyFromXY = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;
const keysAt = (coords) => new Set(coords.map(([x, y]) => lbKeyFromXY(x, y)));
const sameSet = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));

// A controllable clock the scheduler + grid share.
function makeClock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  now.set = (ms) => { t = ms; };
  return now;
}

// Facade emulation: exactly the loadTerrainRing lifecycle in scene3d/index.js —
// grid.update → (seed|teleport ? reset : shift ? onResident(incoming)) → drain.
function drivePos(grid, sched, cx, cy) {
  const res = grid.update(cx, cy);
  if (res.seed || res.teleport) sched.reset();
  else if (res.moved) sched.onResident(res.incoming);
  sched.drain();
  return res;
}

// Grid + scheduler wired the same way index.js wires them (releaseEdge → onVacated).
function makeWired({ hysteresisMs = 2000, park } = {}) {
  const now = makeClock(1000);
  const parkCalls = []; // [key]
  const parkFn = park || ((k) => { parkCalls.push(k >>> 0); return true; });
  const sched = new EdgeParkScheduler({ park: parkFn, hysteresisMs, now });
  const grid = new FixedSlotGrid({
    radius: 1,
    lbKeyFromXY,
    fetchEdge: () => {},
    releaseEdge: (vacated) => sched.onVacated(vacated),
    now,
  });
  return { grid, sched, now, parkCalls };
}

// ---------------------------------------------------------------------
// (a) vacated edge → park EXACTLY the vacated set; in-entries filtering
// ---------------------------------------------------------------------
{
  const { grid, sched, now, parkCalls } = makeWired();
  const CX = 0x80, CY = 0x80;
  drivePos(grid, sched, CX, CY);         // seed
  const res = drivePos(grid, sched, CX + 1, CY); // shift east: vacates west col 0x7f
  const expVacated = keysAt([[CX - 1, CY - 1], [CX - 1, CY], [CX - 1, CY + 1]]);
  check("(a) shift produced the expected vacated set (west column)",
    sameSet(res.vacated, expVacated));
  check("(a) park NOT issued on the crossing tick (dwell 0 < hysteresis)",
    parkCalls.length === 0);
  now.advance(2500); // past hysteresis
  drivePos(grid, sched, CX + 1, CY); // no-move drain tick
  check("(a) after hysteresis a drain parks EXACTLY the vacated set",
    parkCalls.length === 3 && sameSet(new Set(parkCalls), expVacated),
    `parked=[${parkCalls.map((k) => k.toString(16)).join(",")}]`);
  check("(a) parksIssued counter == 3", sched.getStats().parksIssued === 3);
  check("(a) pending drained to empty", sched.getStats().pending === 0);
}
{
  // in-entries filtering: park() returns false for keys not resident.
  const entries = new Set(); // empty → every park is a miss
  const now = makeClock(0);
  const sched = new EdgeParkScheduler({
    park: (k) => entries.has(k >>> 0), // false unless present
    hysteresisMs: 1000,
    now,
  });
  const vac = keysAt([[0x10, 0x10], [0x11, 0x10]]);
  sched.onVacated(vac);
  now.advance(1500);
  const r = sched.drain();
  check("(a) park()==false → counted as parkSkippedInEntriesMiss, not parked",
    sched.getStats().parksIssued === 0 && sched.getStats().parkSkippedInEntriesMiss === 2
      && r.parked.length === 0 && r.skipped.length === 2);
  check("(a) missed keys still drained from pending (not retried forever)",
    sched.getStats().pending === 0);
}

// ---------------------------------------------------------------------
// (c) zig-zag → zero parks; committed walk → bounded parks
// ---------------------------------------------------------------------
{
  const { grid, sched, now, parkCalls } = makeWired({ hysteresisMs: 2000 });
  const CX = 0x80, CY = 0x80;
  drivePos(grid, sched, CX, CY); // seed
  // Oscillate across the CX/CX+1 boundary, 500 ms/step (< hysteresis).
  for (let i = 0; i < 8; i += 1) {
    now.advance(500);
    drivePos(grid, sched, CX + (i % 2), CY);
  }
  check("(c) tight zig-zag issues ZERO parks (re-entry cancels every pending)",
    parkCalls.length === 0 && sched.getStats().parksIssued === 0,
    `parks=${parkCalls.length}`);
  check("(c) the anti-storm cancels were observed (reAdoptCancels > 0)",
    sched.getStats().reAdoptCancels > 0);
}
{
  const { grid, sched, now, parkCalls } = makeWired({ hysteresisMs: 2000 });
  let x = 0x80; const CY = 0x80;
  drivePos(grid, sched, x, CY); // seed
  // Committed straight walk east, 2500 ms/step (> hysteresis) — each vacated
  // column ages out and parks. 5 steps → 5 vacated columns × 3 = 15 keys, but
  // bounded: never more than 3·steps.
  const steps = 5;
  for (let i = 0; i < steps; i += 1) {
    now.advance(2500);
    x += 1;
    drivePos(grid, sched, x, CY);
  }
  now.advance(2500);
  drivePos(grid, sched, x, CY); // final drain for the last aged column
  check("(c) committed walk parks the trailing edge (parksIssued > 0)",
    sched.getStats().parksIssued > 0);
  check("(c) parks bounded by 3·steps (no storm/duplication)",
    parkCalls.length <= 3 * (steps + 1) && parkCalls.length === new Set(parkCalls).size,
    `parks=${parkCalls.length}`);
}

// ---------------------------------------------------------------------
// (d) teleport invalidate bypasses park
// ---------------------------------------------------------------------
{
  const { grid, sched, now, parkCalls } = makeWired({ hysteresisMs: 2000 });
  const CX = 0x40, CY = 0x40;
  drivePos(grid, sched, CX, CY); // seed
  // Walk one step first so there IS a pending park, then teleport away.
  now.advance(500);
  drivePos(grid, sched, CX + 1, CY); // shift → west col pending
  check("(d) fixture: a park is pending after the walk step",
    sched.getStats().pending > 0);
  now.advance(500);
  const res = drivePos(grid, sched, CX + 40, CY + 40); // teleport (|d| >= W)
  check("(d) teleport flagged", res.teleport === true);
  check("(d) teleport reset() cleared pending — no park scheduled",
    sched.getStats().pending === 0 && sched.getStats().resets >= 1);
  now.advance(5000);
  drivePos(grid, sched, CX + 40, CY + 40); // drain long after — nothing to park
  check("(d) teleport path issued ZERO parks (LRU evict-on-teleport owns it)",
    parkCalls.length === 0 && sched.getStats().parksIssued === 0);
}

// ---------------------------------------------------------------------
// (e) diag grace: transient unbacked suppressed in-window; real divergence loud
// ---------------------------------------------------------------------
{
  const now = makeClock(10_000);
  const warns = [];
  const grid = new FixedSlotGrid({
    radius: 1, lbKeyFromXY,
    fetchEdge: () => {}, releaseEdge: () => {},
    now, warn: (m, d) => warns.push([m, d]),
  });
  grid.update(0x20, 0x20); // seed = a crossing; _lastCrossingAtMs = 10_000
  const GRACE = 3000;
  // Immediately after the crossing, nothing baked → all resident unbacked.
  const d1 = grid.assertResidency({ baked: new Set(), inFlight: null, graceMs: GRACE });
  check("(e) within grace: unbacked reclassified transient, NO warn",
    warns.length === 0 && d1.unbacked.length === 0 && d1.transientUnbacked.length > 0);
  check("(e) grace suppression counted",
    grid.getStats().transientUnbackedSuppressed > 0 && grid.getStats().graceSuppressedRuns === 1
      && grid.getStats().assertWarns === 0);
  // Advance PAST the grace with the edge still unbacked → now a real divergence.
  now.advance(GRACE + 100);
  const d2 = grid.assertResidency({ baked: new Set(), inFlight: null, graceMs: GRACE });
  check("(e) past grace: still-unbacked warns loudly",
    warns.length === 1 && d2.unbacked.length > 0 && /derived-view divergence/.test(warns[0][0]));
  // untracked/offBlock are NEVER graced (real bookkeeping bugs).
  {
    const now2 = makeClock(0);
    const warns2 = [];
    const g2 = new FixedSlotGrid({ radius: 1, lbKeyFromXY, fetchEdge: () => {}, releaseEdge: () => {}, now: now2, warn: (m, d) => warns2.push([m, d]) });
    g2.update(0x30, 0x30); // crossing at t=0
    // Baked includes an off-block key so offBlock fires, all within grace.
    const baked = new Set(g2.residentKeys);
    // Force an offBlock resident by injecting a stale key.
    g2.residentKeys.add(lbKeyFromXY(0x99, 0x99));
    g2.assertResidency({ baked, inFlight: null, graceMs: 3000, nowMs: 10 });
    check("(e) offBlock is NOT graced — warns even inside the window",
      warns2.length === 1 && warns2[0][1].offBlock.length === 1);
  }
  // graceMs default 0 = no grace (byte-identical to pre-S15c / existing tests).
  {
    const now3 = makeClock(0);
    const warns3 = [];
    const g3 = new FixedSlotGrid({ radius: 1, lbKeyFromXY, fetchEdge: () => {}, releaseEdge: () => {}, now: now3, warn: (m, d) => warns3.push([m, d]) });
    g3.update(0x40, 0x40);
    g3.assertResidency({ baked: new Set(), inFlight: null }); // no graceMs
    check("(e) graceMs default 0 → unbacked warns immediately (pre-S15c behavior kept)",
      warns3.length === 1);
  }
}

// ---------------------------------------------------------------------
// (f) flag matrix for the ?fixedGridPark sub-escape (default-ON-within-fixedGrid)
// ---------------------------------------------------------------------
{
  // Mirrors FIXED_GRID_PARK_ENABLED in index.js: absent/on → ON; only the
  // explicit off-spellings disable (house footgun rule for a default-ON flag).
  const readFixedGridPark = (v) => v !== "off" && v !== "0" && v !== "false";
  const onVals = [null, "", "1", "on", "true", "yes", "anything"];
  const offVals = ["off", "0", "false"];
  check("(f) absent + any non-off value → park ON (default-ON-within)",
    onVals.every((v) => readFixedGridPark(v) === true));
  check("(f) off/0/false → park OFF (S15b no-op release)",
    offVals.every((v) => readFixedGridPark(v) === false));
}

// ---------------------------------------------------------------------
// (b) + (g) — real LandblockLRU: whole-LB park covers all layers; re-adopt
// ---------------------------------------------------------------------
{
  // window stub BEFORE the cache-busted import (test_park_usetime pattern).
  globalThis.window = { location: { search: "?warmPark=on&reclaimMinAgeMs=0&reclaimGate=off" } };
  const lruMod = await import("./scene3d/landblock_lru.js?cfg=s15c_park");
  const { LandblockLRU } = lruMod;

  const makeGroup = () => ({
    children: [],
    add(c) { if (!this.children.includes(c)) this.children.push(c); },
    remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
  });
  const makeScene = () => ({
    terrainGroup: makeGroup(),
    buildingsGroup: makeGroup(),
    staticsGroup: makeGroup(),
    cellsGroup: makeGroup(),
    cellContainers3d: new Map(),
    buildingMap3d: new Map(),
    terrainBakedLbs: new Set(),
    buildingsBakedLbs: new Set(),
    staticsBakedLbs: new Set(),
    envCellLoadedLbs: new Set(),
    terrainMaterials: [],
    activeLights: [],
  });

  // (g) layer coverage: terrain + building + static + animated-scenery (staticsGroup
  // child) + a cell container, all tagged to ONE LB.
  {
    const scene = makeScene();
    const lru = new LandblockLRU({ scene3d: scene, maxResident: 8 });
    const LB = lbKeyFromXY(0x60, 0x60);
    const lbX = 0x60, lbY = 0x60;
    const terrainNode = { userData: { lbX, lbY } };
    const buildingNode = { userData: { landblockId: LB, placementKey: "b1" } };
    const staticNode = { userData: { landblockId: LB } };
    const sceneryNode = { userData: { landblockId: LB, isStaticScriptAnchor: false } }; // animated_scenery outdoor node lives in staticsGroup
    const cellId = (LB | 0x0100) >>> 0;
    const cellContainer = { userData: { landblockId: cellId } };
    scene.terrainGroup.add(terrainNode);
    scene.buildingsGroup.add(buildingNode);
    scene.staticsGroup.add(staticNode);
    scene.staticsGroup.add(sceneryNode);
    scene.cellsGroup.add(cellContainer);
    scene.cellContainers3d.set(cellId, cellContainer);
    scene.buildingMap3d.set("b1", buildingNode);
    lru.track(LB); // register the LB in entries

    const parked = lru.park(LB);
    check("(g) park() returned true (LB was resident)", parked === true);
    check("(g) whole-LB park detached TERRAIN from its group",
      !scene.terrainGroup.children.includes(terrainNode));
    check("(g) whole-LB park detached the BUILDING (+ buildingMap3d entry)",
      !scene.buildingsGroup.children.includes(buildingNode) && !scene.buildingMap3d.has("b1"));
    check("(g) whole-LB park detached the STATIC node",
      !scene.staticsGroup.children.includes(staticNode));
    check("(g) whole-LB park detached the animated-SCENERY node (staticsGroup child)",
      !scene.staticsGroup.children.includes(sceneryNode));
    check("(g) whole-LB park detached the EnvCell container",
      !scene.cellsGroup.children.includes(cellContainer) && !scene.cellContainers3d.has(cellId));
    check("(g) park is not a dispose — LB moved entries → parkPool",
      lru.parkPool.has(LB) && !lru.entries.has(LB) && lru.getStats().evicted === 0);

    // unpark re-adopts every layer.
    const un = lru.unpark(LB);
    check("(g) unpark re-attached all layers",
      un === true &&
      scene.terrainGroup.children.includes(terrainNode) &&
      scene.buildingsGroup.children.includes(buildingNode) &&
      scene.staticsGroup.children.includes(staticNode) &&
      scene.staticsGroup.children.includes(sceneryNode) &&
      scene.cellContainers3d.has(cellId));
  }

  // (b) re-entry within the UseTime floor → pointer re-adopt, no re-bake, driven
  // through the S15c scheduler's park.
  {
    const scene = makeScene();
    const lru = new LandblockLRU({ scene3d: scene, maxResident: 1 });
    const LB = lbKeyFromXY(0x62, 0x62);
    // Real geometry bytes so the pool has weight (test_park_usetime fixture).
    const geom = { uuid: "g", attributes: { position: { array: { byteLength: 8 * 1024 * 1024 } } }, index: null, dispose() { this.disposed = true; } };
    lru.track(LB, { geometries: [geom] });

    const now = makeClock(0);
    const sched = new EdgeParkScheduler({ park: (k) => lru.park(k) === true, hysteresisMs: 1000, now });
    sched.onVacated([LB]);
    now.advance(1500);
    sched.drain();
    check("(b) scheduler parked the LB via the real LRU (young)",
      lru.parkPool.has(LB) && sched.getStats().parksIssued === 1);

    // A pressure tick WITHIN the 30 s floor must NOT dispose it.
    lru.parkBudgetBytes = 1;
    lru._tickParkPoolPressure(lbKeyFromXY(0x40, 0x40));
    check("(b) young parked slot survives pressure (S15a UseTime floor)",
      lru.parkPool.has(LB) && lru.getStats().evicted === 0 && geom.disposed !== true);

    // Re-entry: unpark = pointer re-adopt, zero true-dispose, zero re-bake.
    const un = lru.unpark(LB);
    check("(b) re-entry within floor → pointer re-adopt (unpark), no re-bake",
      un === true && lru.entries.has(LB) && !lru.parkPool.has(LB) &&
      lru.getStats().evicted === 0 && lru.getStats().unparkedTotal === 1);
  }
}

console.log("");
console.log(`S15c fixedGrid park + grace: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
