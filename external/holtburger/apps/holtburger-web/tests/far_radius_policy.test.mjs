// tests/far_radius_policy.test.mjs — 2026-10-18 review §7 follow-up (stream-terrain,
// HANDOFF-1070-session-2026-10-11 §4 item 7).
//
// `?farDiag` (default ON) asserts the far ring never drags a near-ring system
// (statics / buildings / terrain / the LRU) along. The assertion fired
// `[far_terrain] RADIUS POLICY VIOLATION` after any short walk or teleport:
//   - its invariant was distance only (beyond pvsRingRadius + 1), but the near
//     ring keeps what it baked once the player moves on — the LRU cap holds the
//     trailing rows past the gate, and a teleport leaves the old town resident;
//   - `farLbKeys` held every landblock the far ring ever fetched, never pruned,
//     so the old town stayed "far" for the session.
//
//   P1 a walk: landblocks the player passed, still in the LRU past the gate,
//      are no violation
//   P2 a teleport: the old town's landblocks leave farLbKeys with their patches,
//      and are no violation
//   P3 negative control: a far landblock the player was never near that reaches
//      a near-ring set IS a violation (one console.error)
//   P4 the near-seen record stays the size of the near ring's residency on a
//      long walk
//   P5 a heightmap fetch that lands after its patch retired adds nothing
//
// Runs the real far_terrain.js (initFarTerrain → tickFarTerrain → farTerrainState)
// with a stub fetch_landblock_heightmaps; no GPU, no renderer.
//
// Run: node tests/far_radius_policy.test.mjs

import assert from "node:assert/strict";
import * as THREE from "three";

globalThis.location = { search: "" };
globalThis.window = globalThis;

const FT = await import("../scene3d/far_terrain.js");

let failures = 0;
async function t(name, fn) {
  try { await fn(); console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

const key = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A scene3d with the near-ring sets the policy reads, and a stub far fetch. */
function makeScene(fetchImpl = async () => []) {
  return {
    terrainGroup: new THREE.Group(),
    pvsRingRadius: 5,
    staticsBakedLbs: new Set(),
    buildingsBakedLbs: new Set(),
    terrainBakedLbs: new Set(),
    landblockLru: { entries: new Map() },
    currentLandblockKey: key(100, 100),
    wasmExports: { fetch_landblock_heightmaps: fetchImpl },
  };
}

/** Init the ring and silence its boot log; console.error calls are counted. */
function boot(scene) {
  FT.disposeFarTerrain();
  const log = console.log;
  console.log = () => {};
  let st;
  try { st = FT.initFarTerrain(scene, { parent: new THREE.Group() }); } finally { console.log = log; }
  assert.ok(st, "far ring on");
  return st;
}
async function tick(scene, errors, session = null) {
  const err = console.error;
  console.error = (...a) => errors.push(a);
  try { FT.tickFarTerrain(scene, session, null); } finally { console.error = err; }
  await flush();
}
/** The near ring baking the landblocks within `r` of the player row (y = 100). */
function nearBake(scene, px, r) {
  for (let x = px - r; x <= px + r; x += 1) {
    scene.terrainBakedLbs.add(key(x, 100));
    scene.landblockLru.entries.set(key(x, 100), {});
  }
}

await t("P1 a walk: passed landblocks the LRU still holds past the gate are no violation", async () => {
  const scene = makeScene();
  const st = boot(scene);
  const errors = [];
  for (let x = 90; x <= 100; x += 1) {
    scene.currentLandblockKey = key(x, 100);
    nearBake(scene, x, 5);
    // The far ring has no inner hole: it holds the near landblocks too.
    for (let fx = x - 8; fx <= x + 8; fx += 1) st.farLbKeys.add(key(fx, 100));
    await tick(scene, errors);
  }
  // The LRU kept everything from 85 on: 85..93 are now past the gate (6).
  assert.ok(st.farOnlyLbCount > 0, "the walk left far landblocks past the gate");
  assert.deepEqual(st.policyViolations, [], JSON.stringify(st.policyViolations));
  assert.equal(errors.length, 0, "no console.error");
});

await t("P2 a teleport: the old town leaves farLbKeys with its patches; no violation", async () => {
  const scene = makeScene();
  const st = boot(scene);
  const errors = [];
  scene.currentLandblockKey = key(0x10, 0x10);
  for (let x = 0x10 - 5; x <= 0x10 + 5; x += 1) {
    scene.terrainBakedLbs.add(key(x, 0x10));
    scene.landblockLru.entries.set(key(x, 0x10), {});
  }
  await tick(scene, errors);
  for (let x = 0x10 - 8; x <= 0x10 + 8; x += 1) st.farLbKeys.add(key(x, 0x10));
  // Mark the patches that hold them as fetched, as a real fetch would.
  for (const p of st.patches.values()) p.state = "baked";
  // Teleport across the map; the old town stays in the LRU until it ages out.
  scene.currentLandblockKey = key(0xa9, 0xb4);
  await tick(scene, errors);
  assert.deepEqual(st.policyViolations, [], JSON.stringify(st.policyViolations));
  assert.equal(errors.length, 0);
  assert.equal(st.farLbKeys.has(key(0x10, 0x10)), false, "the retired patches dropped their landblocks");
});

await t("P3 negative control: a never-near far landblock in a near-ring set is a violation", async () => {
  const scene = makeScene();
  const st = boot(scene);
  const errors = [];
  nearBake(scene, 100, 5);
  for (let fx = 92; fx <= 108; fx += 1) st.farLbKeys.add(key(fx, 100));
  scene.staticsBakedLbs.add(key(108, 100)); // the bug the assertion exists for
  await tick(scene, errors);
  await tick(scene, errors);
  assert.deepEqual(st.policyViolations, [{ set: "staticsBakedLbs", lbKey: key(108, 100) }]);
  assert.equal(errors.length, 1, "one console.error, not one per frame");
});

await t("P4 the near-seen record stays the near ring's size on a long walk", async () => {
  const scene = makeScene();
  const st = boot(scene);
  const errors = [];
  for (let x = 20; x <= 220; x += 1) {
    scene.currentLandblockKey = key(x, 100);
    scene.terrainBakedLbs.clear();
    scene.landblockLru.entries.clear();
    nearBake(scene, x, 5);
    await tick(scene, errors);
  }
  const gate = 6;
  assert.ok(st.nearSeenLbs.size <= (2 * gate + 1) ** 2 + 11, `nearSeenLbs ${st.nearSeenLbs.size}`);
  assert.ok(st.farLbKeys.size <= 17 * 17, `farLbKeys ${st.farLbKeys.size}`);
  assert.equal(errors.length, 0);
});

await t("P5 a fetch that lands after its patch retired adds nothing and frees its boxes", async () => {
  const pending = [];
  const scene = makeScene((ids) => new Promise((resolve) => pending.push({ ids, resolve })));
  const st = boot(scene);
  const errors = [];
  const session = {}; // a far fetch needs a live session (tickFarTerrain)
  scene.currentLandblockKey = key(0x40, 0x40);
  await tick(scene, errors, session);
  assert.ok(pending.length > 0, "the ring asked for heightmaps");
  // Teleport far away: every patch retires while its fetch is out.
  scene.currentLandblockKey = key(0xc0, 0xc0);
  await tick(scene, errors);
  let freed = 0;
  const mesh = () => ({
    positions: new Float32Array(81 * 3), indices: new Uint16Array(6), terrainCodes: new Uint8Array(81),
    roadCodes: new Uint8Array(81), terrainMergeData: null, free() { freed += 1; },
  });
  const first = pending[0];
  first.resolve(Array.from(first.ids, mesh));
  await flush();
  const lbX = (first.ids[0] >>> 24) & 0xff;
  const lbY = (first.ids[0] >>> 16) & 0xff;
  assert.equal(st.farLbKeys.has(key(lbX, lbY)), false, "no landblock of a retired patch is recorded");
  assert.equal(freed, first.ids.length, "every wasm box freed");
});

FT.disposeFarTerrain();
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
