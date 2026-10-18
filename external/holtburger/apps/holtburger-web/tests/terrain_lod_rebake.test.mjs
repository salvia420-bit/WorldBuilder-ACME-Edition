// tests/terrain_lod_rebake.test.mjs — the F12-6 terrain LOD re-bake queue
// (scene3d/terrain.js `tickTerrainLodRebake` → `drainOneTerrainLodRebake`).
//
// STREAM-TERRAIN-1 (2026-10-18 review): the drain never re-checked residency.
// After a portal the old ring's re-bakes are refused by the stream guard's cap
// and re-queued with a 1 s backoff; meanwhile the LRU parks (or pool-disposes)
// those landblocks. The next drain found no terrainGroup child, deleted the
// baked mark and baked a fresh mesh for a landblock that was no longer
// resident — a visible batch row for a parked LB, or an evicted LB re-tracked
// as resident.
//
//   L1  resident LB: re-baked at the new level, the old mesh retired after the
//       replacement lands
//   L2  a refused re-bake keeps the old mesh + mark and retries after backoff
//   L3  parked after the refusal: the retry is dropped (no bake), the baked
//       mark stays for the unpark fast path
//   L4  evicted after the refusal: the retry is dropped (no bake)
//
// Run from apps/holtburger-web/:  node tests/terrain_lod_rebake.test.mjs

import assert from "node:assert/strict";

// Browser-ish globals the terrain modules read at load (same shape as radial_fog.test.mjs).
globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;
window.requestAnimationFrame = window.requestAnimationFrame || (() => 0);
window.cancelAnimationFrame = window.cancelAnimationFrame || (() => {});

const { tickTerrainLodRebake } = await import("../scene3d/terrain.js");

// The drain's backoff clock is `performance.now()`; drive it by hand.
let clock = 1_000_000;
const realPerf = Object.getOwnPropertyDescriptor(globalThis, "performance");
Object.defineProperty(globalThis, "performance", { value: { now: () => clock }, configurable: true, writable: true });

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const key = (x, y) => ((x << 24) | (y << 16)) >>> 0;

const A = { x: 0x40, y: 0x40 };
const FAR = key(0x80, 0x80); // a portal destination: every LB around A wants level 1

function terrainMesh(lbX, lbY, subdivLevel) {
  return {
    parent: null,
    userData: { lbX, lbY, subdivLevel },
    geometry: { disposed: false, dispose() { this.disposed = true; } },
    material: { userData: {}, dispose() {} },
  };
}

// High preset: subdivLevel 4 → the 3x3 around the player bakes at level 2.
function makeScene() {
  const children = [];
  const group = {
    children,
    add(c) { children.push(c); c.parent = group; },
    remove(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parent = null; },
  };
  const parked = new Set();
  const loads = [];
  const s = {
    terrainGroup: group,
    terrainOpts: { canSubdivide: true, subdivLevel: 4, playerLbKey: key(A.x, A.y) },
    terrainBakedLbs: new Set(),
    landblockLru: { isParked: (k) => parked.has(k >>> 0), untrackDisposables() {} },
    // What the guarded loader does this call: "refuse" (cap / cooldown → null)
    // or "bake" (a fresh mesh at the level the new centre picks).
    nextLoad: "refuse",
    loadTerrainForLandblock(lbX, lbY) {
      loads.push(key(lbX, lbY));
      if (s.nextLoad !== "bake") return Promise.resolve(null);
      const m = terrainMesh(lbX, lbY, 1);
      group.add(m);
      s.terrainBakedLbs.add(key(lbX, lbY));
      return Promise.resolve(m);
    },
  };
  const old = terrainMesh(A.x, A.y, 2);
  group.add(old);
  s.terrainBakedLbs.add(key(A.x, A.y));
  // Pin the LOD centre at A so the first tick only sees the portal hop.
  s._lodLastCentre = key(A.x, A.y);
  return { s, group, parked, loads, old, lb: key(A.x, A.y) };
}

await check("L1 resident LB: re-baked at the new level, the old mesh retired after the replacement lands", async () => {
  const t = makeScene();
  t.s.nextLoad = "bake";
  tickTerrainLodRebake(t.s, FAR);
  await flush();
  assert.deepEqual(t.loads, [t.lb]);
  assert.equal(t.group.children.includes(t.old), false, "old level-2 mesh torn down");
  assert.equal(t.old.geometry.disposed, true);
  assert.equal(t.group.children.length, 1);
  assert.equal(t.group.children[0].userData.subdivLevel, 1);
  assert.equal(t.s._lodRebakeQueue.size, 0);
});

await check("L2 a refused re-bake keeps the old mesh + mark and retries after backoff", async () => {
  const t = makeScene();
  tickTerrainLodRebake(t.s, FAR);
  await flush();
  assert.deepEqual(t.loads, [t.lb]);
  assert.equal(t.s._lodRebakeQueue.has(t.lb), true, "re-queued");
  assert.equal(t.s.terrainBakedLbs.has(t.lb), true, "mark restored");
  assert.equal(t.group.children.includes(t.old), true, "old mesh still drawn");
  tickTerrainLodRebake(t.s, FAR);
  await flush();
  assert.equal(t.loads.length, 1, "inside the backoff: no retry");
  clock += 1001;
  t.s.nextLoad = "bake";
  tickTerrainLodRebake(t.s, FAR);
  await flush();
  assert.equal(t.loads.length, 2, "retried once the backoff elapsed");
  assert.equal(t.group.children.includes(t.old), false);
  assert.equal(t.s._lodRebakeQueue.size, 0);
});

await check("L3 parked after the refusal: the retry is dropped, the baked mark stays for unpark", async () => {
  const t = makeScene();
  tickTerrainLodRebake(t.s, FAR);
  await flush();
  assert.equal(t.s._lodRebakeQueue.has(t.lb), true);
  // LandblockLRU.park: detach the terrain children, keep the baked mark.
  t.group.remove(t.old);
  t.parked.add(t.lb);
  clock += 1001;
  t.s.nextLoad = "bake";
  tickTerrainLodRebake(t.s, FAR);
  await flush();
  assert.equal(t.loads.length, 1, "no re-bake for a parked landblock");
  assert.equal(t.group.children.length, 0, "no terrain put back for it");
  assert.equal(t.s.terrainBakedLbs.has(t.lb), true, "mark kept (index.js unpark fast path)");
  assert.equal(t.s._lodRebakeQueue.size, 0, "dropped from the queue");
  assert.equal(t.s._lodRebakeBackoff.has(t.lb), false);
  assert.equal(t.s._lodRebakeDropped, 1);
});

await check("L4 evicted after the refusal: the retry is dropped (no bake)", async () => {
  const t = makeScene();
  tickTerrainLodRebake(t.s, FAR);
  await flush();
  // LandblockLRU.evict: children gone, baked mark cleared, not in the pool.
  t.group.remove(t.old);
  t.s.terrainBakedLbs.delete(t.lb);
  clock += 1001;
  t.s.nextLoad = "bake";
  tickTerrainLodRebake(t.s, FAR);
  await flush();
  assert.equal(t.loads.length, 1, "an evicted landblock is not re-baked by the LOD queue");
  assert.equal(t.group.children.length, 0);
  assert.equal(t.s.terrainBakedLbs.has(t.lb), false);
  assert.equal(t.s._lodRebakeQueue.size, 0);
  assert.equal(t.s._lodRebakeDropped, 1);
});

if (realPerf) Object.defineProperty(globalThis, "performance", realPerf);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
