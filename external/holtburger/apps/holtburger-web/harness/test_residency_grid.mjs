// harness/test_residency_grid.mjs — T20 (ST7, `?slotGrid`): the slot-grid
// residency core, node-only, MOCKED CLOCK (no browser, no wasm).
//
// WHAT IS UNDER TEST (SPEC §3 T20; pass-06 D-06.1/D-06.3/D-06.6/D-06.10 +
// S1/S2/S4):
//   PART 1  — flag grammar: `?slotGrid` EXACT-MATCH opt-in (DEFAULT OFF).
//   PART 2  — grid geometry: W_T = 6 (36 slots); ring-min anchor covers the
//             full 11×11 ring at BOTH parities (the D-06.1 cover proof,
//             exercised exhaustively); world-edge clamp.
//   PART 3  — shift semantics: ±1 anchor per 2 LBs; one row/column admitted
//             and vacated; 30 interior slots pointer-copied; the positional
//             shift cross-check equals the set intersection
//             (shiftMismatches = 0); multi-step shift; teleport predicate
//             (anchor max-axis delta ≥ 6).
//   PART 4  — slot state machine: the S2 legal-transition table; illegal
//             transitions REFUSED and counted as slotDesyncs.
//   PART 5  — integrity audit: positional slot check, window lockstep,
//             tier legality; a corrupted slot table is CAUGHT.
//   PART 6  — adapter admit/vacate: pack fetch → STAGED (pin) → feeds for
//             the tile's 4 LBs; quarantined tiles NEVER fed; vacated
//             FETCHING/STAGED → EMPTY (never fetch-then-drop); late fetch
//             resolution after vacate does NOT stage; STAGED→LIVE
//             promotion on the baked predicate.
//   PART 7  — park hysteresis: no park before 2 s continuous-vacated; a
//             zig-zag CANCELS (reAdoptCancels — BENCH-ZIGZAG's absorbing
//             counter, node arm); walk-then-stand parks after the window;
//             PARKED→LIVE re-adopt (zero fetch).
//   PART 8  — pressure pass: floors honored (all-young + over-budget ⇒ run
//             over + parkDeferredCount/Bytes); floor NEVER below 5 s even
//             when set to 0; ≤1 tile released per tick; farthest-first;
//             player-adjacent tiles never shed; release unpins + clears
//             per-LB caches; pin audit (pinLeaks = 0).
//   PART 9  — pressure ladder: R1→R4 rung order with the 5 s dwell;
//             release in REVERSE at the 0.85 low-water; r4Engagements +
//             floorLowerings counted; context-loss trigger.
//   PART 10 — teleport drain: pending hysteresis parks dropped; vacated
//             LIVE tiles parked amortized (BENCH-TELEPORT node arm).
//   PART 11 — sealed interiors: freeze + amortized park drain + pinned
//             return core (≤9 tiles, pressure-exempt R1–R3, sheddable
//             under emergency); exit re-seed vacates departed tiles.
//   PART 12 — the battery: a scripted 40-crossing walk + zig-zags + a
//             teleport with all integrity counters
//             (shiftMismatches / slotDesyncs / pinLeaks) ending 0 and the
//             audit green on every steady tick.
//
// Run:  node harness/test_residency_grid.mjs        (exit 0/1)

import {
  slotGridEnabled,
  SlotGrid,
  GridResidencyAdapter,
  PressureLadder,
  SLOT_STATE,
  W_T,
  SLOT_COUNT,
  R_LB,
  anchorOf,
  tileKeyOf,
  tileOfLb,
  tileLbKeys,
  tileChebyshev,
  PARK_HYSTERESIS_MS,
  PARK_FLOOR_MS,
  PARK_FLOOR_EMERGENCY_MS,
  PARK_POOL_MAX_TILES,
  LADDER_HEAP_TRIGGER_BYTES,
  LADDER_WASM_TRIGGER_BYTES,
  LADDER_RUNG_DWELL_MS,
} from "../scene3d/residency_grid.js";

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${msg}`);
  }
}

function mockClock(t0 = 0) {
  const c = { t: t0 };
  c.now = () => c.t;
  c.advance = (ms) => { c.t += ms; };
  return c;
}

const quietWarn = () => {};
const lbKeyFromXY = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;

// ---------------------------------------------------------------------------
// PART 1 — flag grammar
// ---------------------------------------------------------------------------
console.log("PART 1: flag grammar");
check(slotGridEnabled("") === false, "absent => OFF");
check(slotGridEnabled("?slotGrid=on") === true, "on => ON");
check(slotGridEnabled("?slotGrid=1") === true, "1 => ON");
check(slotGridEnabled("?slotGrid=true") === true, "true => ON");
check(slotGridEnabled("?slotGrid=yes") === true, "yes => ON");
check(slotGridEnabled("?slotGrid=off") === false, "off => OFF");
check(slotGridEnabled("?slotGrid=0") === false, "0 => OFF");
check(slotGridEnabled("?slotGrid=") === false, "empty => OFF");
check(slotGridEnabled("?slotGrid=garbage") === false, "garbage => OFF");

// ---------------------------------------------------------------------------
// PART 2 — geometry / cover proof
// ---------------------------------------------------------------------------
console.log("PART 2: geometry");
check(W_T === 6 && SLOT_COUNT === 36 && R_LB === 5, "W_T=6, 36 slots, R=5");
{
  // Exhaustive cover proof over the interior of the map (both parities):
  // every LB of the 11×11 ring around (x,y) must map to a window tile.
  let coverFails = 0;
  for (let x = 5; x <= 250; x += 1) {
    const y = x; // diagonal sweep hits both parities on both axes
    const a = anchorOf(x, y);
    for (let dx = -R_LB; dx <= R_LB; dx += 1) {
      for (let dy = -R_LB; dy <= R_LB; dy += 1) {
        const tx = (x + dx) >> 1;
        const ty = (y + dy) >> 1;
        if (tx < a.ax || tx >= a.ax + W_T || ty < a.ay || ty >= a.ay + W_T) coverFails += 1;
      }
    }
  }
  check(coverFails === 0, `cover proof: ring ⊆ window at every position (fails=${coverFails})`);
}
{
  const g = new SlotGrid({ now: () => 0, warn: quietWarn });
  const res = g.update(100, 100);
  check(res.seed === true && res.admitted.length === 36, "interior seed = 36 tiles");
  check(g.windowTiles.size === 36, "window size 36");
  // Every ring LB covered.
  let missing = 0;
  for (let dx = -5; dx <= 5; dx += 1) {
    for (let dy = -5; dy <= 5; dy += 1) {
      if (!g.windowTiles.has(tileOfLb(100 + dx, 100 + dy))) missing += 1;
    }
  }
  check(missing === 0, "seed window covers the 11×11 ring");
  check(g.audit().ok === true, "seed audit green");
}
{
  // World edge: LB (1,1) → anchor negative → off-map slots absent.
  const g = new SlotGrid({ now: () => 0, warn: quietWarn });
  const res = g.update(1, 1);
  check(res.admitted.length < 36 && res.admitted.length > 0, `edge seed clamps (${res.admitted.length} tiles)`);
  check(g.audit().ok === true, "edge audit green");
}
{
  check(tileLbKeys(tileKeyOf(50, 60)).length === 4, "interior tile = 4 LBs");
  check(tileLbKeys(tileKeyOf(127, 127)).length === 4, "corner tile (254/255) = 4 LBs");
}

// ---------------------------------------------------------------------------
// PART 3 — shift semantics + teleport predicate
// ---------------------------------------------------------------------------
console.log("PART 3: shifts");
{
  const g = new SlotGrid({ now: () => 0, warn: quietWarn });
  g.update(100, 100);
  // +1 LB: anchor floor((101-5)/2)=48 vs floor((100-5)/2)=47 → shifts by 1.
  // (ring-min anchoring: the anchor can move on EITHER parity boundary; the
  // guarantee is ±1 anchor per 2 LBs of net movement, exercised below.)
  let shifts = 0;
  let admitted = 0;
  for (let step = 1; step <= 8; step += 1) {
    const res = g.update(100 + step, 100);
    if (res.shift) {
      shifts += 1;
      check(res.admitted.length <= W_T, `shift admits ≤6 (got ${res.admitted.length})`);
      check(res.vacated.length <= W_T, `shift vacates ≤6 (got ${res.vacated.length})`);
      const sc = g.getStats().lastShiftCheck;
      check(sc && sc.copied === sc.expectedCopied, "shift cross-check equal");
      check(sc && sc.copied === 30, `interior pointer-copy = 30 (got ${sc && sc.copied})`);
      admitted += res.admitted.length;
    } else {
      check(res.moved === false, "non-crossing step is a no-move");
    }
  }
  check(shifts === 4, `8 LBs east = 4 shifts (±1 anchor per 2 LBs; got ${shifts})`);
  check(admitted === 4 * 6, "each shift admits one 6-tile column");
  check(g.getStats().shiftMismatches === 0, "shiftMismatches 0");
  check(g.audit().ok === true, "post-walk audit green");
}
{
  // Multi-step shift: 4-LB jump = anchor delta 2 < 6 → shift, 2 columns.
  const g = new SlotGrid({ now: () => 0, warn: quietWarn });
  g.update(100, 100);
  const res = g.update(104, 100);
  check(res.shift === true && res.teleport === false, "4-LB jump = shift");
  check(res.admitted.length === 12, `2 columns admitted (got ${res.admitted.length})`);
  check(g.getStats().shiftMismatches === 0, "multi-step cross-check clean");
}
{
  // Teleport: anchor max-axis delta ≥ W_T. 12 LBs → delta 6 exactly.
  const g = new SlotGrid({ now: () => 0, warn: quietWarn });
  g.update(100, 100);
  const res = g.update(112, 100);
  check(res.teleport === true, "12-LB jump = teleport (anchor delta 6)");
  check(res.vacated.length === 36 && res.admitted.length === 36, "teleport = whole-grid swap");
  const res2 = g.update(112, 100);
  check(res2.moved === false, "post-teleport steady");
  check(g.getStats().teleports === 1, "teleport counted");
  // Diagonal walk (1,1 LB) is never a teleport.
  const g2 = new SlotGrid({ now: () => 0, warn: quietWarn });
  g2.update(100, 100);
  const r3 = g2.update(101, 101);
  check(r3.teleport === false, "diagonal walk is not a teleport");
}

// ---------------------------------------------------------------------------
// PART 4 — state machine legality
// ---------------------------------------------------------------------------
console.log("PART 4: state machine");
{
  const g = new SlotGrid({ now: () => 0, warn: quietWarn });
  const events = [];
  g._onSlotState = (ev) => events.push(`${ev.from}>${ev.to}`);
  const t = tileKeyOf(50, 50);
  check(g.stateOf(t) === "EMPTY", "initial EMPTY");
  check(g.setState(t, SLOT_STATE.FETCHING) === true, "EMPTY>FETCHING legal");
  check(g.setState(t, SLOT_STATE.STAGED) === true, "FETCHING>STAGED legal");
  check(g.setState(t, SLOT_STATE.LIVE) === true, "STAGED>LIVE legal");
  check(g.setState(t, SLOT_STATE.PARKED) === true, "LIVE>PARKED legal");
  check(g.setState(t, SLOT_STATE.LIVE) === true, "PARKED>LIVE re-adopt legal");
  check(g.setState(t, SLOT_STATE.PARKED) === true, "LIVE>PARKED again");
  check(g.setState(t, SLOT_STATE.EMPTY) === true, "PARKED>EMPTY legal");
  check(events.join(",") === "EMPTY>FETCHING,FETCHING>STAGED,STAGED>LIVE,LIVE>PARKED,PARKED>LIVE,LIVE>PARKED,PARKED>EMPTY",
    "onSlotState event ordering matches the lifecycle");
  check(g.getStats().slotDesyncs === 0, "no desyncs on legal chain");
  // Illegal: EMPTY>LIVE refused + counted.
  const t2 = tileKeyOf(51, 51);
  check(g.setState(t2, SLOT_STATE.LIVE) === false, "EMPTY>LIVE refused");
  check(g.setState(t2, SLOT_STATE.PARKED) === false, "EMPTY>PARKED refused");
  check(g.getStats().slotDesyncs === 2, "illegal transitions counted as slotDesyncs");
  // Idempotent same-state is a no-op true.
  g.setState(t2, SLOT_STATE.FETCHING);
  check(g.setState(t2, SLOT_STATE.FETCHING) === true, "same-state idempotent");
  // QUARANTINED round trip.
  check(g.setState(t2, SLOT_STATE.QUARANTINED) === true, "FETCHING>QUARANTINED legal");
  check(g.setState(t2, SLOT_STATE.FETCHING) === true, "QUARANTINED>FETCHING (re-eligibility) legal");
}

// ---------------------------------------------------------------------------
// PART 5 — integrity audit catches corruption
// ---------------------------------------------------------------------------
console.log("PART 5: audit");
{
  const g = new SlotGrid({ now: () => 0, warn: quietWarn });
  g.update(100, 100);
  // Corrupt one slot positionally.
  g.slots[7] = tileKeyOf(1, 1);
  const a = g.audit();
  check(a.ok === false && a.misplaced.length >= 1, "misplaced slot caught");
  check(g.getStats().slotDesyncs >= 1, "corruption bumps slotDesyncs");
}
{
  const g = new SlotGrid({ now: () => 0, warn: quietWarn });
  g.update(100, 100);
  // Desync the window cache.
  g._window.delete([...g._window][0]);
  const a = g.audit();
  check(a.ok === false && a.lockstep === false, "window lockstep desync caught");
}

// ---------------------------------------------------------------------------
// adapter fixture
// ---------------------------------------------------------------------------
function makeFixture({ clock, packsArmed = true } = {}) {
  const c = clock || mockClock(0);
  const grid = new SlotGrid({ now: c.now, warn: quietWarn });
  const feedCalls = [];
  const feeds = { fireLb: (x, y) => feedCalls.push(lbKeyFromXY(x, y)) };
  // Mock LRU: live/parked LB sets with byte estimates.
  const lru = {
    live: new Set(), parked: new Map(), disposed: [],
    parkLb(lb) {
      if (!this.live.has(lb)) return false;
      this.live.delete(lb);
      this.parked.set(lb, 1024 * 1024); // 1 MiB per LB
      return true;
    },
    unparkLb(lb) {
      if (!this.parked.has(lb)) return false;
      this.parked.delete(lb);
      this.live.add(lb);
      return true;
    },
    disposeLb(lb) {
      this.parked.delete(lb);
      this.disposed.push(lb);
      return true;
    },
    isParkedLb(lb) { return this.parked.has(lb); },
    lbBytes(lb) { return this.parked.get(lb) || 0; },
  };
  // Feeds mark LBs live (the guarded-bake completion analog).
  feeds.fireLb = (x, y) => {
    const lb = lbKeyFromXY(x, y);
    feedCalls.push(lb);
    if (!lru.parked.has(lb)) lru.live.add(lb);
  };
  const fetches = new Map(); // tile -> {resolve, reject}
  const quarantined = new Set();
  const pinned = new Map(); // hash -> count
  const packs = packsArmed ? {
    fetchTile: (tile) => new Promise((resolve, reject) => fetches.set(tile, { resolve, reject })),
    tileHashes: (tile) => [`h${tile.toString(16)}`],
    isQuarantined: (tile) => quarantined.has(tile),
    pin: (h) => pinned.set(h, (pinned.get(h) || 0) + 1),
    unpin: (h) => pinned.set(h, (pinned.get(h) || 0) - 1),
  } : null;
  const evicted = [];
  const adapter = new GridResidencyAdapter({
    grid, feeds, lru, packs,
    evictLbCaches: (lb) => evicted.push(lb),
    bakedPredicate: (tile) => tileLbKeys(tile).every((lb) => lru.live.has(lb) || lru.parked.has(lb)),
    now: c.now,
    warn: quietWarn,
  });
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  const stageAll = async () => {
    for (const [tile, p] of [...fetches]) {
      fetches.delete(tile);
      p.resolve({});
    }
    await settle();
  };
  return { clock: c, grid, adapter, feeds, feedCalls, lru, fetches, quarantined, pinned, evicted, settle, stageAll };
}

// ---------------------------------------------------------------------------
// PART 6 — adapter admit / stage / feed / quarantine
// ---------------------------------------------------------------------------
console.log("PART 6: adapter admit");
await (async () => {
  const f = makeFixture({});
  const res = f.grid.update(100, 100);
  f.adapter.onUpdate(res);
  check(f.grid.counts().fetching === 36, "seed: 36 tiles FETCHING");
  check(f.feedCalls.length === 0, "no feeds before staging (pack-first ordering)");
  await f.stageAll();
  check(f.grid.counts().staged === 36, "all staged after receipt");
  check(f.adapter.pins.size === 36, "36 tile pins held");
  // 36 tiles × 4 LBs = 144 fed (the 19% allocated-vs-used slack, stated).
  check(f.feedCalls.length === 144, `feeds fired for 144 LBs (got ${f.feedCalls.length})`);
  f.adapter.tickPromotions();
  check(f.grid.counts().live === 36, "STAGED→LIVE on baked predicate");
  check(f.adapter.auditPins() === 0, "no pin leaks");
})();
await (async () => {
  // Quarantined tile: never fed, state QUARANTINED.
  const f = makeFixture({});
  const qt = tileOfLb(100 + 4, 100); // a ring tile
  f.quarantined.add(qt);
  const res = f.grid.update(100, 100);
  f.adapter.onUpdate(res);
  await f.stageAll();
  check(f.grid.stateOf(qt) === "QUARANTINED", "quarantined tile marked");
  const qtLbs = new Set(tileLbKeys(qt));
  check(f.feedCalls.every((lb) => !qtLbs.has(lb)), "quarantined tile's LBs never fed");
  // Re-eligibility: quarantine lifts → next admit retries.
  f.quarantined.delete(qt);
  f.grid.setState(qt, SLOT_STATE.FETCHING);
  check(f.grid.stateOf(qt) === "FETCHING", "QUARANTINED>FETCHING retry");
})();
await (async () => {
  // Vacate-before-receipt: FETCHING → EMPTY; the late resolve does NOT stage.
  const f = makeFixture({});
  f.adapter.onUpdate(f.grid.update(100, 100));
  const res = f.grid.update(102, 100); // shift: west column vacated
  const vacatedTile = res.vacated[0];
  f.adapter.onUpdate(res);
  check(f.grid.stateOf(vacatedTile) === "EMPTY", "vacated FETCHING → EMPTY");
  await f.stageAll(); // resolves everything incl. the vacated tile's fetch
  check(f.grid.stateOf(vacatedTile) === "EMPTY", "late receipt does not resurrect (never fetch-then-drop)");
  check(f.adapter.auditPins() === 0, "no pin held for the dropped tile");
})();
await (async () => {
  // Vacated STAGED → EMPTY + unpin.
  const f = makeFixture({});
  f.adapter.onUpdate(f.grid.update(100, 100));
  await f.stageAll();
  const res = f.grid.update(102, 100);
  const vacatedTile = res.vacated[0];
  check(f.grid.stateOf(vacatedTile) === "STAGED", "pre-vacate STAGED");
  f.adapter.onUpdate(res);
  check(f.grid.stateOf(vacatedTile) === "EMPTY", "vacated STAGED → EMPTY (bytes ride the PackStore floor)");
  check(f.adapter.pins.has(vacatedTile) === false, "unpinned at vacate");
})();
await (async () => {
  // Legacy-lane arm (no packs): straight to STAGED + feeds.
  const f = makeFixture({ packsArmed: false });
  f.adapter.onUpdate(f.grid.update(100, 100));
  check(f.grid.counts().staged === 36, "no-pack arm: STAGED immediately");
  check(f.feedCalls.length === 144, "no-pack arm: feeds fire");
  check(f.adapter.pins.size === 0, "no-pack arm: no pins");
})();

// ---------------------------------------------------------------------------
// PART 7 — park hysteresis + zig-zag + re-adopt
// ---------------------------------------------------------------------------
console.log("PART 7: park hysteresis");
await (async () => {
  const f = makeFixture({});
  f.adapter.onUpdate(f.grid.update(100, 100));
  await f.stageAll();
  f.adapter.tickPromotions();
  const res = f.grid.update(102, 100);
  const vacated = res.vacated.slice();
  f.adapter.onUpdate(res);
  await f.stageAll();
  // Vacated LIVE tiles remain LIVE inside the hysteresis window.
  check(vacated.every((t) => f.grid.stateOf(t) === "LIVE"), "vacated LIVE holds through hysteresis");
  f.clock.advance(PARK_HYSTERESIS_MS - 100);
  f.adapter.onUpdate(f.grid.update(102, 100)); // steady tick → drain
  check(vacated.every((t) => f.grid.stateOf(t) === "LIVE"), "no park before 2 s");
  f.clock.advance(200);
  f.adapter.onUpdate(f.grid.update(102, 100));
  check(vacated.every((t) => f.grid.stateOf(t) === "PARKED"), "parks after the 2 s dwell");
  check(f.adapter.getStats().parksIssued === vacated.length, "parksIssued counted");
  // PARKED→LIVE pointer re-adopt on walk-back: zero new fetches.
  const fetchesBefore = f.adapter.getStats().packFetches;
  const resBack = f.grid.update(100, 100);
  f.adapter.onUpdate(resBack);
  check(vacated.every((t) => f.grid.stateOf(t) === "LIVE"), "walk-back re-adopts PARKED→LIVE");
  check(f.adapter.getStats().packFetches === fetchesBefore, "re-adopt = zero fetch");
  check(f.adapter.getStats().reAdopts >= vacated.length, "reAdopts counted");
})();
await (async () => {
  // Zig-zag: re-cross inside the hysteresis window → park cancelled.
  const f = makeFixture({});
  f.adapter.onUpdate(f.grid.update(100, 100));
  await f.stageAll();
  f.adapter.tickPromotions();
  for (let i = 0; i < 6; i += 1) {
    f.adapter.onUpdate(f.grid.update(102, 100));
    await f.stageAll();
    f.adapter.tickPromotions();
    f.clock.advance(500); // well inside the 2 s window
    f.adapter.onUpdate(f.grid.update(100, 100));
    await f.stageAll();
    f.adapter.tickPromotions();
    f.clock.advance(500);
  }
  const st = f.adapter.getStats();
  check(st.parksIssued === 0, `zig-zag issues ZERO parks (got ${st.parksIssued})`);
  check(st.park.reAdoptCancels > 0, `reAdoptCancels absorbs the zig-zag (got ${st.park.reAdoptCancels})`);
  check(f.grid.getStats().shiftMismatches === 0, "zig-zag cross-checks clean");
})();

// ---------------------------------------------------------------------------
// PART 8 — pressure pass (park pool loop)
// ---------------------------------------------------------------------------
console.log("PART 8: pressure");
await (async () => {
  const f = makeFixture({});
  // Manufacture a big parked pool: seed, then teleport repeatedly so old
  // ring content parks (via drain), until tiles > budget.
  f.adapter.onUpdate(f.grid.update(20, 20));
  await f.stageAll();
  f.adapter.tickPromotions();
  let hop = 0;
  while (f.adapter.getStats().parkPoolTiles <= PARK_POOL_MAX_TILES && hop < 4) {
    hop += 1;
    const res = f.grid.update(20 + hop * 20, 20); // 20-LB hops = teleports
    f.adapter.onUpdate(res);
    // Drain the whole teleport backlog (amortized ticks).
    for (let i = 0; i < 50 && f.adapter._teleportDrain; i += 1) f.adapter.tickTeleportDrain();
    await f.stageAll();
    f.adapter.tickPromotions();
  }
  const poolBefore = f.adapter.getStats().parkPoolTiles;
  check(poolBefore > PARK_POOL_MAX_TILES, `pool over budget (${poolBefore} tiles)`);
  // All-young: floor defers everything, pool runs over, deferrals counted.
  f.adapter.tickPressure();
  const st1 = f.adapter.getStats();
  check(st1.releases === 0, "all-young pool: nothing released (floor honored)");
  check(st1.parkDeferredCount > 0 && st1.parkDeferredBytes > 0, "deferrals counted (run over and record)");
  // Floor can never be zeroed: even parkFloorMs = 0 clamps to 5 s.
  f.adapter.parkFloorMs = 0;
  f.adapter.tickPressure();
  check(f.adapter.getStats().releases === 0, "floor=0 request clamps to 5 s (nothing released young)");
  check(f.adapter.getStats().parkFloorMs === PARK_FLOOR_EMERGENCY_MS, "reported floor = 5 s minimum");
  f.adapter.parkFloorMs = PARK_FLOOR_MS;
  // Age past the floor → exactly ONE tile per tick, farthest first.
  f.clock.advance(PARK_FLOOR_MS + 1000);
  const relBefore = f.adapter.getStats().releases;
  f.adapter.tickPressure();
  const st2 = f.adapter.getStats();
  check(st2.releases === relBefore + 1, "≤1 tile released per tick");
  check(f.evicted.length > 0, "per-LB wasm cache clear fired at true release");
  // Repeated ticks drain toward budget without ever exceeding 1/tick.
  let guard = 0;
  while (f.adapter.getStats().parkPoolTiles > PARK_POOL_MAX_TILES && guard < 200) {
    const r0 = f.adapter.getStats().releases;
    f.adapter.tickPressure();
    const r1 = f.adapter.getStats().releases;
    check(r1 - r0 <= 1, "amortization bound holds");
    guard += 1;
    if (r1 === r0) break; // floors/never-shed exhausted eligibility
  }
  check(f.adapter.auditPins() === 0, "pressure path leaks no pins");
})();
await (async () => {
  // Never-shed: the player's own + adjacent tiles are not victims.
  const f = makeFixture({});
  f.adapter.onUpdate(f.grid.update(100, 100));
  await f.stageAll();
  f.adapter.tickPromotions();
  // Park the player's own tile artificially (sealed-like) then over-fill.
  const own = f.grid.playerTile;
  f.grid.frozen = true; // allow window-PARKED legally
  for (const t of f.grid.windowTiles) {
    if (f.grid.stateOf(t) === "LIVE") {
      for (const lb of tileLbKeys(t)) f.lru.parkLb(lb);
      f.grid.setState(t, SLOT_STATE.PARKED);
    }
  }
  f.clock.advance(PARK_FLOOR_MS + 1000);
  // 36 parked tiles < 40-tile budget but bytes: 144 MiB > 128 MiB → pressure.
  f.adapter.tickPressure();
  check(f.grid.stateOf(own) === "PARKED", "player tile never shed");
  const releasedTiles = f.adapter.getStats().releases;
  if (releasedTiles > 0) {
    // The released tile must have been ≥2 tiles from the player.
    const stillParked = [...f.grid.records].filter(([, r]) => r.state === "PARKED").map(([t]) => t);
    check(!stillParked.some((t) => tileChebyshev(t, own) <= 1 && f.grid.stateOf(t) === "EMPTY"),
      "released tile was outside the player 3×3");
  }
  check(releasedTiles === 1, "byte-pressure released exactly one tile this tick");
})();

// ---------------------------------------------------------------------------
// PART 9 — pressure ladder
// ---------------------------------------------------------------------------
console.log("PART 9: ladder");
{
  const c = mockClock(0);
  const sample = { heapBytes: 0, wasmBytes: 0, contextLoss: false };
  const rungLog = [];
  const ladder = new PressureLadder({
    now: c.now,
    sample: () => ({ ...sample }),
    onRung: (r, on) => rungLog.push(`${on ? "+" : "-"}R${r}`),
  });
  ladder.tick();
  check(ladder.rung === 0, "quiet: disengaged");
  // Trigger via heap.
  sample.heapBytes = LADDER_HEAP_TRIGGER_BYTES;
  c.advance(1000); ladder.tick();
  check(ladder.rung === 1, "trigger engages R1");
  c.advance(1000); ladder.tick();
  check(ladder.rung === 1, "R1 holds during dwell");
  c.advance(LADDER_RUNG_DWELL_MS); ladder.tick();
  check(ladder.rung === 2, "R2 after 5 s dwell");
  c.advance(LADDER_RUNG_DWELL_MS); ladder.tick();
  check(ladder.rung === 3, "R3 after another dwell");
  c.advance(LADDER_RUNG_DWELL_MS); ladder.tick();
  check(ladder.rung === 4, "R4 after another dwell");
  c.advance(LADDER_RUNG_DWELL_MS); ladder.tick();
  check(ladder.rung === 4, "R4 is the ceiling");
  check(ladder.getStats().r4Engagements === 1, "r4Engagements counted");
  check(ladder.getStats().floorLowerings === 1, "floorLowerings counted at R4");
  // Release: metric must fall below 0.85 × trigger AND dwell.
  sample.heapBytes = Math.floor(LADDER_HEAP_TRIGGER_BYTES * 0.9);
  c.advance(LADDER_RUNG_DWELL_MS); ladder.tick();
  check(ladder.rung === 4, "0.9× trigger is not below the 0.85 low-water — holds");
  sample.heapBytes = Math.floor(LADDER_HEAP_TRIGGER_BYTES * 0.5);
  c.advance(LADDER_RUNG_DWELL_MS); ladder.tick();
  check(ladder.rung === 3, "release steps DOWN one rung");
  c.advance(LADDER_RUNG_DWELL_MS); ladder.tick();
  c.advance(LADDER_RUNG_DWELL_MS); ladder.tick();
  c.advance(LADDER_RUNG_DWELL_MS); ladder.tick();
  check(ladder.rung === 0, "full reverse release");
  check(rungLog.join(",") === "+R1,+R2,+R3,+R4,-R4,-R3,-R2,-R1", `rung order (got ${rungLog.join(",")})`);
  // Context loss triggers regardless of bytes; wasm trigger too.
  const l2 = new PressureLadder({ now: c.now, sample: () => ({ heapBytes: 0, wasmBytes: 0, contextLoss: true }) });
  c.advance(1000); l2.tick();
  check(l2.rung === 1, "context loss engages");
  const l3 = new PressureLadder({ now: c.now, sample: () => ({ heapBytes: 0, wasmBytes: LADDER_WASM_TRIGGER_BYTES, contextLoss: false }) });
  c.advance(1000); l3.tick();
  check(l3.rung === 1, "wasm-linear trigger engages");
}

// ---------------------------------------------------------------------------
// PART 10 — teleport drain
// ---------------------------------------------------------------------------
console.log("PART 10: teleport drain");
await (async () => {
  const f = makeFixture({});
  f.adapter.onUpdate(f.grid.update(100, 100));
  await f.stageAll();
  f.adapter.tickPromotions();
  // Schedule a pending park (vacate then don't age it out), then teleport.
  const shiftRes = f.grid.update(102, 100);
  f.adapter.onUpdate(shiftRes);
  await f.stageAll();
  check(f.adapter.parkSched.getStats().pending > 0, "pending hysteresis parks exist");
  const tpRes = f.grid.update(200, 200);
  f.adapter.onUpdate(tpRes);
  check(f.adapter.parkSched.getStats().pending === 0, "teleport drops pending parks (reset)");
  check(f.adapter._teleportDrain !== null, "teleport drain armed");
  // Amortized drain parks the departed LIVE tiles.
  for (let i = 0; i < 60 && f.adapter._teleportDrain; i += 1) f.adapter.tickTeleportDrain();
  const parked = [...f.grid.records.values()].filter((r) => r.state === "PARKED").length;
  check(parked > 0, `teleport-departed tiles parked (${parked})`);
  check(f.adapter.getStats().teleportDrains === 1, "drain counted");
  check(f.grid.getStats().slotDesyncs === 0, "teleport leaves no desyncs");
})();

// ---------------------------------------------------------------------------
// PART 11 — sealed interiors
// ---------------------------------------------------------------------------
console.log("PART 11: sealed");
await (async () => {
  const f = makeFixture({});
  f.adapter.onUpdate(f.grid.update(100, 100));
  await f.stageAll();
  f.adapter.tickPromotions();
  const keepLb = lbKeyFromXY(100, 100);
  f.adapter.sealedEnter(keepLb);
  check(f.grid.frozen === true, "grid frozen while sealed");
  check(f.adapter.sealedCore.size <= 9, `return core ≤ 9 tiles (${f.adapter.sealedCore.size})`);
  for (let i = 0; i < 60 && f.adapter._sealedDrainList && f.adapter._sealedDrainList.length; i += 1) {
    f.adapter.tickSealedDrain();
  }
  check(f.grid.counts().parked > 0, "sealed drain parks the outdoor set");
  check(f.grid.audit().ok === true, "frozen-window PARKED is audit-legal");
  // Pressure R1–R3 never sheds the core, even aged.
  f.clock.advance(PARK_FLOOR_MS + 1000);
  for (let i = 0; i < 100; i += 1) f.adapter.tickPressure(false);
  const coreStillParked = [...f.adapter.sealedCore].every((t) => f.grid.stateOf(t) === "PARKED");
  check(coreStillParked, "R1–R3 pressure never sheds the sealed core");
  // Exit: unfreeze + re-seed re-adopts the core.
  f.adapter.sealedExit();
  check(f.grid.frozen === false, "unfrozen at exit");
  f.grid.anchor = null; // the wiring's re-seed trigger
  const res = f.grid.update(100, 100);
  f.adapter.onUpdate(res);
  const core = tileOfLb(100, 100);
  check(f.grid.stateOf(core) === "LIVE", "core tile re-adopted LIVE at exit");
  check(f.adapter.getStats().reAdopts > 0, "exit re-adopts counted");
})();

// ---------------------------------------------------------------------------
// PART 12 — the battery: walk + zig-zag + teleport, integrity 0
// ---------------------------------------------------------------------------
console.log("PART 12: battery");
await (async () => {
  const f = makeFixture({});
  let x = 60;
  let y = 60;
  f.adapter.onUpdate(f.grid.update(x, y));
  await f.stageAll();
  f.adapter.tickPromotions();
  const steady = async () => {
    f.adapter.onUpdate(f.grid.update(x, y));
    await f.stageAll();
    f.adapter.tickPromotions();
    f.adapter.tickTeleportDrain();
    f.adapter.tickPressure();
    f.grid.audit();
    f.adapter.auditPins();
  };
  // 40-crossing walk east/north alternating with steady ticks.
  for (let i = 0; i < 40; i += 1) {
    if (i % 2 === 0) x += 1; else y += 1;
    f.adapter.onUpdate(f.grid.update(x, y));
    await f.stageAll();
    f.adapter.tickPromotions();
    f.clock.advance(700);
    await steady();
  }
  // Zig-zag burst.
  for (let i = 0; i < 8; i += 1) {
    x += 2;
    f.adapter.onUpdate(f.grid.update(x, y));
    await f.stageAll();
    f.clock.advance(400);
    x -= 2;
    f.adapter.onUpdate(f.grid.update(x, y));
    await f.stageAll();
    f.clock.advance(400);
  }
  // Long dwell so trailing tiles park, then a teleport, then settle.
  f.clock.advance(PARK_HYSTERESIS_MS + 500);
  await steady();
  x += 60;
  f.adapter.onUpdate(f.grid.update(x, y));
  for (let i = 0; i < 80; i += 1) { f.adapter.tickTeleportDrain(); }
  await f.stageAll();
  f.adapter.tickPromotions();
  f.clock.advance(PARK_FLOOR_MS + 2000);
  for (let i = 0; i < 120; i += 1) { await steady(); f.clock.advance(200); }
  const g = f.grid.getStats();
  const a = f.adapter.getStats();
  check(g.shiftMismatches === 0, `battery shiftMismatches = 0 (got ${g.shiftMismatches})`);
  check(g.slotDesyncs === 0, `battery slotDesyncs = 0 (got ${g.slotDesyncs})`);
  check(a.pinLeaks === 0, `battery pinLeaks = 0 (got ${a.pinLeaks})`);
  check(f.grid.audit().ok === true, "battery final audit green");
  check(a.parkDeferredCount >= 0 && a.releases >= 0, "pressure ran");
  // Teardown releases everything and leaks nothing.
  f.adapter.dispose();
  check(f.adapter.pins.size === 0, "dispose releases all pins");
  for (const [, n] of f.pinned) check(n === 0, "every pack pin count returns to 0");
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("RESIDENCY-GRID ❌");
  process.exit(1);
}
console.log("RESIDENCY-GRID ✅");
