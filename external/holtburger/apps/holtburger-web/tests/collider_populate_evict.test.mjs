// tests/collider_populate_evict.test.mjs — app/landblock_stream.js
// `ensureBuildingAabbsAroundLandblock` (the building, static and scenery
// collider populate for the 3x3 ring) across an LRU eviction that lands while
// the populate is still running.
//
// 2026-10-18 review follow-up (§10.5 "Streaming", the STREAM-TERRAIN-3 JS
// pattern): the populate had no eviction re-check. The eviction hook clears the
// LB's populated / in-flight marks (the wasm clear drops its colliders), but the
// populate went on to stage the static and scenery colliders of the evicted LB,
// re-marked its scenery staged after the clear, populated a target evicted while
// it was still queued, and its `finally` deleted the in-flight bit a re-entry
// had set meanwhile.
//
//   P0  the player's own LB populates first also for an x byte >= 0x80 (the
//       signed `&` key matched no target, so the centre went fifth)
//   P1  no eviction: building, static and scenery colliders populate once; a
//       second trigger is a no-op
//   P2  evicted during the building populate: no static or scenery populate
//       for it, and the revisit populates it afresh
//   P3  evicted during the static populate: no scenery populate, and the
//       revisit populates it afresh
//   P4  evicted during the scenery populate: the revisit stages the scenery
//       colliders again
//   P5  evicted while queued behind the other ring targets: never populated by
//       the orphaned call
//   P6  evicted + re-entry, then the orphan's populate fails: it leaves the
//       re-entry's in-flight bit alone (no third populate)
//   P7  wasm side (source pins; the piles are wasm32-only thread-locals): the
//       eviction export also drops the building / static / scenery products a
//       populate staged BEFORE the eviction, which the next drain would insert
//       right after its clear
//
// Run from apps/holtburger-web/:  node tests/collider_populate_evict.test.mjs

import assert from "node:assert/strict";

// landblock_stream.js reads `window.location` and assigns `window.__…` hooks at
// call time (same setup as tests/cell_containers_evict.test.mjs).
globalThis.location = { search: "" };
const { createLandblockStream } = await import("../app/landblock_stream.js");
globalThis.window = globalThis;

// Centre LB of the ring (0x86,0x02: an x byte >= 0x80, see P0) and its 3x3 ring.
const LB = 0x86020000;
const RING = [];
for (let dy = -1; dy <= 1; dy += 1) {
  for (let dx = -1; dx <= 1; dx += 1) RING.push((((0x86 + dx) << 24) | ((0x02 + dy) << 16)) >>> 0);
}

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${(e && e.stack) || e}`); }
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Await a populate, failing (not hanging) when it is stuck on a held gate. */
const done = (p) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error("the populate is still pending on a held gate")), 500)),
]);

/**
 * The three wasm populate exports. A call for an LB in `hold` waits on its own
 * gate (`release` / `fail` settle the oldest one of that kind and LB); every
 * other call resolves at once.
 */
function makeWasm() {
  const calls = { building: [], statics: [], scenery: [] };
  const gates = new Map(); // `${kind}:${lb}` → [{open, fail}, …]
  const hold = new Set();
  const fn = (kind) => async (lb) => {
    calls[kind].push(lb >>> 0);
    if (!hold.has(lb >>> 0)) return 1;
    const key = `${kind}:${lb >>> 0}`;
    await new Promise((open, fail) => {
      if (!gates.has(key)) gates.set(key, []);
      gates.get(key).push({ open, fail });
    });
    return 1;
  };
  const take = (kind, lb) => {
    const q = gates.get(`${kind}:${lb >>> 0}`);
    assert.ok(q && q.length, `a ${kind} populate of 0x${(lb >>> 0).toString(16)} is waiting`);
    return q.shift();
  };
  return {
    calls,
    hold,
    count: (kind, lb) => calls[kind].filter((x) => x === lb).length,
    release: (kind, lb) => take(kind, lb).open(),
    fail: (kind, lb) => take(kind, lb).fail(new Error("populate failed")),
    /** Stop holding and open every waiting gate. */
    drain() {
      hold.clear();
      for (const q of gates.values()) while (q.length) q.shift().open();
    },
    populateBuildingAabbsForLandblock: fn("building"),
    populateStaticsAabbsForLandblock: fn("statics"),
    populateSceneryCollidersForLandblock: fn("scenery"),
  };
}

function makeStream(wasm) {
  globalThis.location = { search: "" };
  delete globalThis.__hbInteriorBuildShare;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0; // the cell-residency watchdog — not under test
  try {
    const noop = () => {};
    return createLandblockStream({
      fetch_landblock_heightmaps: noop,
      populateBuildingAabbsForLandblock: wasm.populateBuildingAabbsForLandblock,
      populateStaticsAabbsForLandblock: wasm.populateStaticsAabbsForLandblock,
      fetchEnvCellsInLandblock: async () => [],
      __hbWasmNs: { populateSceneryCollidersForLandblock: wasm.populateSceneryCollidersForLandblock },
      METERS_PER_LANDBLOCK: 192,
      applyConfirmedStance: noop,
      entityMap: new Map(),
      __UNIFIED_DISPATCH: true,
      worldObjectManager: null,
      liveScene: null,
      localPlayerGuid: null,
      lastLocalPlayerLb: 0,
    });
  } finally {
    globalThis.setInterval = realSetInterval;
  }
}

// The populate logs one line per staged family (and warns on a failure); keep
// the output readable.
const quiet = async (fn) => {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
};

await t("P0 the player's own LB populates first (x byte >= 0x80)", () => quiet(async () => {
  const wasm = makeWasm();
  const api = makeStream(wasm);
  await done(api.ensureBuildingAabbsAroundLandblock(LB | 0x0101));
  assert.equal(wasm.calls.building[0], LB, `first populate 0x${wasm.calls.building[0].toString(16)}`);
}));

await t("P1 no eviction: the three families populate once, then the ring is a no-op", () => quiet(async () => {
  const wasm = makeWasm();
  const api = makeStream(wasm);
  await done(api.ensureBuildingAabbsAroundLandblock(LB | 0x0101));
  for (const lb of RING) {
    assert.equal(wasm.count("building", lb), 1);
    assert.equal(wasm.count("statics", lb), 1);
    assert.equal(wasm.count("scenery", lb), 1);
  }
  await done(api.ensureBuildingAabbsAroundLandblock(LB));
  assert.equal(wasm.calls.building.length, 9, "populated: the second trigger is a no-op");
}));

await t("P2 evicted during the building populate: no static/scenery populate, the revisit re-populates", () => quiet(async () => {
  const wasm = makeWasm();
  const api = makeStream(wasm);
  wasm.hold.add(LB);
  const p1 = api.ensureBuildingAabbsAroundLandblock(LB);
  await settle();
  globalThis.__onLandblockEvicted(LB);
  wasm.release("building", LB);
  await settle();
  assert.equal(wasm.count("statics", LB), 0, "no static colliders staged for the evicted LB");
  assert.equal(wasm.count("scenery", LB), 0, "no scenery colliders staged for the evicted LB");
  wasm.drain();
  await done(p1);
  await done(api.ensureBuildingAabbsAroundLandblock(LB));
  assert.equal(wasm.count("building", LB), 2, "the revisit populates the evicted LB again");
  assert.equal(wasm.count("statics", LB), 1);
  assert.equal(wasm.count("scenery", LB), 1);
  assert.equal(wasm.calls.building.length, 10, "only the evicted LB was populated again");
}));

await t("P3 evicted during the static populate: no scenery populate, the revisit re-populates", () => quiet(async () => {
  const wasm = makeWasm();
  const api = makeStream(wasm);
  wasm.hold.add(LB);
  const p1 = api.ensureBuildingAabbsAroundLandblock(LB);
  await settle();
  wasm.release("building", LB);
  await settle();
  globalThis.__onLandblockEvicted(LB);
  wasm.release("statics", LB);
  await settle();
  assert.equal(wasm.count("scenery", LB), 0, "no scenery colliders staged for the evicted LB");
  wasm.drain();
  await done(p1);
  await done(api.ensureBuildingAabbsAroundLandblock(LB));
  assert.equal(wasm.count("building", LB), 2, "the revisit populates the evicted LB again");
  assert.equal(wasm.count("statics", LB), 2);
  assert.equal(wasm.count("scenery", LB), 1);
}));

await t("P4 evicted during the scenery populate: the revisit stages the scenery colliders again", () => quiet(async () => {
  const wasm = makeWasm();
  const api = makeStream(wasm);
  wasm.hold.add(LB);
  const p1 = api.ensureBuildingAabbsAroundLandblock(LB);
  await settle();
  wasm.release("building", LB);
  await settle();
  wasm.release("statics", LB);
  await settle();
  globalThis.__onLandblockEvicted(LB);
  wasm.release("scenery", LB);
  wasm.drain();
  await done(p1);
  await done(api.ensureBuildingAabbsAroundLandblock(LB));
  assert.equal(wasm.count("building", LB), 2);
  assert.equal(wasm.count("scenery", LB), 2, "the orphan did not mark the evicted LB's scenery staged");
  await done(api.ensureBuildingAabbsAroundLandblock(LB));
  assert.equal(wasm.count("building", LB), 2, "the revisit's populate marks it populated");
}));

await t("P5 evicted while queued behind the other ring targets: the orphan never populates it", () => quiet(async () => {
  const wasm = makeWasm();
  const api = makeStream(wasm);
  for (const lb of RING) wasm.hold.add(lb);
  const p1 = api.ensureBuildingAabbsAroundLandblock(LB);
  await settle();
  assert.equal(wasm.calls.building.length, 3, "three workers, three populates in flight");
  const QUEUED = RING.find((lb) => wasm.count("building", lb) === 0);
  globalThis.__onLandblockEvicted(QUEUED);
  wasm.drain();
  await done(p1);
  assert.equal(wasm.count("building", QUEUED), 0, "no colliders staged for the LB evicted in the queue");
  assert.equal(wasm.count("statics", QUEUED), 0);
  await done(api.ensureBuildingAabbsAroundLandblock(LB));
  assert.equal(wasm.count("building", QUEUED), 1, "the revisit populates it");
  assert.equal(wasm.calls.building.length, 9, "the other ring LBs stay populated");
}));

await t("P6 evicted + re-entry, the orphan fails: no third populate", () => quiet(async () => {
  const wasm = makeWasm();
  const api = makeStream(wasm);
  wasm.hold.add(LB);
  const p1 = api.ensureBuildingAabbsAroundLandblock(LB);
  await settle();
  globalThis.__onLandblockEvicted(LB);
  const p2 = api.ensureBuildingAabbsAroundLandblock(LB);
  await settle();
  assert.equal(wasm.count("building", LB), 2, "the re-entry started its own populate");
  wasm.fail("building", LB); // the orphan's call fails first
  await done(p1);
  const p3 = api.ensureBuildingAabbsAroundLandblock(LB);
  await settle();
  assert.equal(wasm.count("building", LB), 2, "the orphan's finally left the re-entry's in-flight bit alone");
  wasm.drain();
  await done(Promise.all([p2, p3]));
  await done(api.ensureBuildingAabbsAroundLandblock(LB));
  assert.equal(wasm.count("building", LB), 2, "the re-entry marked the LB populated");
}));

await t("P7 the eviction export drops the populate products already staged (source pins)", async () => {
  const { readFileSync } = await import("node:fs");
  const lib = readFileSync(new URL("../src/lib.rs", import.meta.url), "utf8");
  const at = lib.indexOf("pub fn enqueue_clear_landblock_collision(lb_id: u32) {");
  assert.ok(at > 0, "anchor drifted");
  const body = lib.slice(at, lib.indexOf("\n}", at));
  const purge = body.indexOf("purge_pending_populate_products(lb_high);");
  assert.ok(purge > 0 && purge < body.indexOf("LANDBLOCK_CLEAR_PENDING"), "purged before the clear is queued");
  const fnAt = lib.indexOf("fn purge_pending_populate_products(lb_high: u32) {");
  assert.ok(fnAt > 0);
  const fnBody = lib.slice(fnAt, lib.indexOf("\n}", fnAt));
  for (const pile of [
    "BUILDING_AABB_PENDING", "BUILDING_ORIGIN_PENDING", "BUILDING_BSP_PENDING", "BUILDING_PORTALS_PENDING",
    "LANDBLOCK_RESTRICTIONS_PENDING", "BUILDING_PHYSICS_PENDING", "STATIC_AABB_PENDING", "STATIC_BSP_PENDING",
    "SCENERY_COLLIDER_PENDING",
  ]) assert.ok(fnBody.includes(`${pile}\n`) || fnBody.includes(`${pile}.with`), `${pile} purged`);
  assert.match(fnBody, /id\.landblock_id & 0xFFFF_0000 != lb_high/, "origins keyed by BuildingId.landblock_id");
});

console.log(`\ncollider_populate_evict: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
