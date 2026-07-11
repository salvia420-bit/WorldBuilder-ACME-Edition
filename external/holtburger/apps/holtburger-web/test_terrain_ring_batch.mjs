// test_terrain_ring_batch.mjs — A4 (2026-07-11 s13) batched terrain-ring
// planner acceptance gate (docs/1120-appendix.md §1 A4, §2 Conflict C2).
//
// Imports scene3d/terrain_ring.js's pure `runTerrainRingBatch` directly as
// ESM and drives it with mock deps (recording loader + spy meshes + a fake
// wasm fetch), the world_stream.js dependency-injection test style — no
// browser, no build, no `three`.
//
// Covers:
//   1. batch happy path — ONE fetch_landblock_heightmaps for the ring, 9
//      per-LB loads each fed a prefetched mesh, every mesh freed after settle.
//   2. urgent-lane forwarding (isNearPlayerLb → the batch fetch's urgent arg).
//   3. corner clamp — a map-edge centre batches only the in-range LBs.
//   4. already-baked LBs pre-filtered — only the un-baked half is fetched;
//      baked LBs still get a solo (pm=null) unpark/touch call; every fetched
//      mesh is freed even though the loader stub never consumes it (proves the
//      guard-skip / unconsumed-mesh path can't leak).
//   5. batch failure → 9-solo fallback (async reject AND sync throw), no mesh
//      handed out.
//   6. wrong-length batch → free partial + solo fallback.
//   7. flag OFF (?terrainRingBatch=off) → pure solo loop, fetch never called.
//   8. missing wasm export → solo loop.
//   9. whole ring already baked → solo loop (fast-path unpark), no fetch.
//
// Run: node test_terrain_ring_batch.mjs   (no browser, no build)

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

const { runTerrainRingBatch } = await import("./scene3d/terrain_ring.js");

const lbKeyFromXY = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;
const cellIdFor = (x, y) => (lbKeyFromXY(x, y) | 0xffff) >>> 0;

// A spy wasm mesh — records its own free() so leak/double-free assertions are
// exact.
function makeMesh(tag) {
  return {
    tag,
    freeCount: 0,
    free() { this.freeCount += 1; },
  };
}

// Build a mock harness. `bakedKeys` seeds terrainBakedLbs; `fetchImpl`
// overrides the default (return one spy mesh per requested id).
function makeHarness({
  ringBatchEnabled = true,
  bakedKeys = [],
  near = false,
  hasFetch = true,
  fetchImpl = null,
  loadImpl = null,
} = {}) {
  const loads = []; // [x, y, prefetchedMesh]
  const fetchCalls = []; // [idsArray, urgent]
  const terrainBakedLbs = new Set(bakedKeys);
  const wasmExports = {};
  if (hasFetch) {
    wasmExports.fetch_landblock_heightmaps = (ids, urgent) => {
      fetchCalls.push([Array.from(ids), urgent]);
      if (fetchImpl) return fetchImpl(ids, urgent);
      // Default: one spy mesh per id, resolved async.
      return Promise.resolve(Array.from(ids).map((id) => makeMesh(id >>> 0)));
    };
  }
  const loadTerrainForLandblock = (x, y, pm) => {
    loads.push([x, y, pm]);
    if (loadImpl) return loadImpl(x, y, pm);
    return Promise.resolve(null);
  };
  return {
    loads,
    fetchCalls,
    terrainBakedLbs,
    deps: {
      ringBatchEnabled,
      wasmExports,
      terrainBakedLbs,
      isNearPlayerLb: () => near,
      scene3d: {},
      lbKeyFromXY,
      loadTerrainForLandblock,
      warn: () => {}, // silence expected warnings
    },
  };
}

// ---------------------------------------------------------------------
// 1 + 2 — batch happy path + urgent forwarding
// ---------------------------------------------------------------------
{
  const h = makeHarness({ near: true });
  const CX = 0xa9;
  const CY = 0xb4;
  const meshes = [];
  h.deps.wasmExports.fetch_landblock_heightmaps = (ids, urgent) => {
    h.fetchCalls.push([Array.from(ids), urgent]);
    const m = Array.from(ids).map((id) => makeMesh(id >>> 0));
    meshes.push(...m);
    return Promise.resolve(m);
  };
  await runTerrainRingBatch({ ...h.deps, cx: CX, cy: CY });

  check("(1) fetch_landblock_heightmaps called exactly ONCE for the ring",
    h.fetchCalls.length === 1, `got ${h.fetchCalls.length}`);
  check("(1) batch carried all 9 ring cell ids (3×3 interior)",
    h.fetchCalls[0][0].length === 9);
  const wantIds = [];
  for (let dy = -1; dy <= 1; dy += 1)
    for (let dx = -1; dx <= 1; dx += 1) wantIds.push(cellIdFor(CX + dx, CY + dy));
  check("(1) batch ids are the correct XXYYFFFF cell ids",
    new Set(h.fetchCalls[0][0]).size === 9 &&
      wantIds.every((id) => h.fetchCalls[0][0].includes(id)));
  check("(1) loadTerrainForLandblock fanned out 9× (one per ring LB)",
    h.loads.length === 9, `got ${h.loads.length}`);
  check("(1) every fan-out call carried a prefetched mesh",
    h.loads.every((c) => c[2] && typeof c[2].free === "function"));
  check("(1) every prefetched base mesh freed exactly once after settle",
    meshes.length === 9 && meshes.every((m) => m.freeCount === 1),
    `meshes=${meshes.length} freeCounts=${meshes.map((m) => m.freeCount).join(",")}`);
  check("(2) isNearPlayerLb=true → batch fetched on the URGENT lane",
    h.fetchCalls[0][1] === true);
}

// ---------------------------------------------------------------------
// 3 — corner clamp
// ---------------------------------------------------------------------
{
  const h = makeHarness();
  await runTerrainRingBatch({ ...h.deps, cx: 0xff, cy: 0xff });
  check("(3) 0xFFFF corner → batch fetches only the 4 in-range LBs",
    h.fetchCalls.length === 1 && h.fetchCalls[0][0].length === 4,
    `ids=${h.fetchCalls[0] ? h.fetchCalls[0][0].length : "none"}`);
  check("(3) 0xFFFF corner → 4 per-LB loads", h.loads.length === 4);
  check("(3) non-urgent centre → normal lane",
    h.fetchCalls[0][1] === false);
}

// ---------------------------------------------------------------------
// 4 — already-baked LBs pre-filtered + unconsumed meshes still freed
// ---------------------------------------------------------------------
{
  const CX = 0x30;
  const CY = 0x40;
  // Pre-bake 3 of the 9 ring LBs.
  const bakedKeys = [
    lbKeyFromXY(CX - 1, CY - 1),
    lbKeyFromXY(CX, CY),
    lbKeyFromXY(CX + 1, CY + 1),
  ];
  const meshes = [];
  const h = makeHarness({
    bakedKeys,
    // loader stub NEVER touches the mesh (simulates a guard-skip / no-op
    // baker) — proves the planner is the sole owner and still frees.
    loadImpl: () => Promise.resolve(null),
  });
  h.deps.wasmExports.fetch_landblock_heightmaps = (ids, urgent) => {
    h.fetchCalls.push([Array.from(ids), urgent]);
    const m = Array.from(ids).map((id) => makeMesh(id >>> 0));
    meshes.push(...m);
    return Promise.resolve(m);
  };
  await runTerrainRingBatch({ ...h.deps, cx: CX, cy: CY });

  check("(4) baked LBs pre-filtered → batch fetches only the 6 un-baked",
    h.fetchCalls.length === 1 && h.fetchCalls[0][0].length === 6,
    `fetched=${h.fetchCalls[0] ? h.fetchCalls[0][0].length : "none"}`);
  check("(4) all 9 ring LBs still get a per-LB load (baked → unpark path)",
    h.loads.length === 9, `got ${h.loads.length}`);
  const withMesh = h.loads.filter((c) => c[2]).length;
  const withoutMesh = h.loads.filter((c) => !c[2]).length;
  check("(4) 6 loads carry a prefetched mesh, 3 baked loads carry null",
    withMesh === 6 && withoutMesh === 3, `withMesh=${withMesh} null=${withoutMesh}`);
  check("(4) all 6 fetched meshes freed once even though the loader never consumed them (no leak)",
    meshes.length === 6 && meshes.every((m) => m.freeCount === 1),
    `freeCounts=${meshes.map((m) => m.freeCount).join(",")}`);
}

// ---------------------------------------------------------------------
// 5 — batch failure → 9-solo fallback (async reject + sync throw)
// ---------------------------------------------------------------------
{
  const h = makeHarness({
    fetchImpl: () => Promise.reject(new Error("bad shard")),
  });
  await runTerrainRingBatch({ ...h.deps, cx: 0x50, cy: 0x60 });
  check("(5a) async reject → 9-solo fallback",
    h.loads.length === 9 && h.loads.every((c) => c[2] == null),
    `loads=${h.loads.length}`);

  const h2 = makeHarness({
    fetchImpl: () => { throw new Error("sync boom"); },
  });
  await runTerrainRingBatch({ ...h2.deps, cx: 0x50, cy: 0x60 });
  check("(5b) synchronous throw → 9-solo fallback",
    h2.loads.length === 9 && h2.loads.every((c) => c[2] == null),
    `loads=${h2.loads.length}`);
}

// ---------------------------------------------------------------------
// 6 — wrong-length batch → free partial + solo fallback
// ---------------------------------------------------------------------
{
  const partial = [makeMesh(1), makeMesh(2)]; // 2 meshes for a 9-LB ring
  const h = makeHarness({ fetchImpl: () => Promise.resolve(partial) });
  await runTerrainRingBatch({ ...h.deps, cx: 0x50, cy: 0x60 });
  check("(6) length mismatch → 9-solo fallback (all pm=null)",
    h.loads.length === 9 && h.loads.every((c) => c[2] == null));
  check("(6) partial batch meshes freed (no leak on the mismatch path)",
    partial.every((m) => m.freeCount === 1));
}

// ---------------------------------------------------------------------
// 7 — flag OFF → pure solo loop, fetch never called
// ---------------------------------------------------------------------
{
  const h = makeHarness({ ringBatchEnabled: false });
  await runTerrainRingBatch({ ...h.deps, cx: 0x50, cy: 0x60 });
  check("(7) ?terrainRingBatch=off → fetch_landblock_heightmaps NEVER called",
    h.fetchCalls.length === 0);
  check("(7) flag off → 9 solo loads (all pm=null)",
    h.loads.length === 9 && h.loads.every((c) => c[2] == null));
}

// ---------------------------------------------------------------------
// 8 — missing wasm export → solo loop
// ---------------------------------------------------------------------
{
  const h = makeHarness({ hasFetch: false });
  await runTerrainRingBatch({ ...h.deps, cx: 0x50, cy: 0x60 });
  check("(8) no fetch_landblock_heightmaps export → 9 solo loads",
    h.loads.length === 9 && h.loads.every((c) => c[2] == null));
}

// ---------------------------------------------------------------------
// 9 — whole ring already baked → solo loop (unpark), no fetch
// ---------------------------------------------------------------------
{
  const CX = 0x70;
  const CY = 0x80;
  const bakedKeys = [];
  for (let dy = -1; dy <= 1; dy += 1)
    for (let dx = -1; dx <= 1; dx += 1) bakedKeys.push(lbKeyFromXY(CX + dx, CY + dy));
  const h = makeHarness({ bakedKeys });
  await runTerrainRingBatch({ ...h.deps, cx: CX, cy: CY });
  check("(9) whole ring baked → NO batch fetch", h.fetchCalls.length === 0);
  check("(9) whole ring baked → 9 solo (unpark/touch) loads, all pm=null",
    h.loads.length === 9 && h.loads.every((c) => c[2] == null));
}

console.log("");
console.log(`A4 terrain ring batch: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
