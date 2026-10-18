// tests/cell_containers_evict.test.mjs — app/landblock_stream.js
// `ensureCellContainersForLandblock` across an LRU eviction that lands while
// its `fetchEnvCellsInLandblock` build is still running.
//
// STREAM-TERRAIN-3 (2026-10-18 review): the eviction hook clears the LB's
// populated / in-flight marks and the wasm collision, but the build's await
// then resolved and re-marked the LB populated with no re-check — so a revisit
// skipped the collision populate and the LB kept only the cells the orphaned
// build pushed after the clear. Its `finally` also deleted the in-flight bit a
// re-entry had set meanwhile, so a third concurrent build could start.
//
//   E1  no eviction: the build marks the LB populated (a later trigger is a no-op)
//   E2  evicted mid-build, no re-entry: the orphan does not mark it populated;
//       the revisit starts a fresh build
//   E3  evicted mid-build + re-entry: the orphan's settle leaves the re-entry's
//       in-flight bit alone (no third build); the re-entry marks it populated
//   E4  the same with `?interiorBuildShare=off`
//   E5  the orphaned build FAILS while the re-entry runs: no third build
//       (`?interiorBuildShare=off`: no third wasm call)
//   E6  the same with the share on: the third trigger does not even join
//
// Run from apps/holtburger-web/:  node tests/cell_containers_evict.test.mjs

import assert from "node:assert/strict";

// landblock_stream.js reads `window.location` and assigns `window.__…` hooks at
// call time (same setup as tests/interior_build_share.test.mjs).
globalThis.location = { search: "" };
const { createLandblockStream } = await import("../app/landblock_stream.js");
globalThis.window = globalThis;

const LB = 0x86020000;

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${(e && e.stack) || e}`); }
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A main-instance export whose every call waits on its own gate. */
function makeWasm() {
  const wasm = {
    calls: 0,
    gates: [],
    fails: [],
    fetchEnvCellsInLandblock: async () => {
      wasm.calls += 1;
      let open, fail;
      const g = new Promise((res, rej) => { open = res; fail = rej; });
      wasm.gates.push(open);
      wasm.fails.push(fail);
      await g;
      return [{ free() {} }];
    },
  };
  return wasm;
}

function makeStream(wasm, search = "") {
  globalThis.location = { search };
  delete globalThis.__hbInteriorBuildShare;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0; // the cell-residency watchdog — not under test
  try {
    const noop = () => {};
    return createLandblockStream({
      fetch_landblock_heightmaps: noop,
      populateBuildingAabbsForLandblock: noop,
      populateStaticsAabbsForLandblock: noop,
      fetchEnvCellsInLandblock: wasm.fetchEnvCellsInLandblock,
      __hbWasmNs: {},
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

await t("E1 no eviction: the build marks the LB populated", async () => {
  const wasm = makeWasm();
  const api = makeStream(wasm);
  const p = api.ensureCellContainersForLandblock(LB | 0x0101);
  await settle();
  wasm.gates[0]();
  await p;
  await api.ensureCellContainersForLandblock(LB);
  assert.equal(wasm.calls, 1, "populated: the second trigger is a no-op");
});

await t("E2 evicted mid-build, no re-entry: the revisit starts a fresh build", async () => {
  const wasm = makeWasm();
  const api = makeStream(wasm);
  const p1 = api.ensureCellContainersForLandblock(LB);
  await settle();
  globalThis.__onLandblockEvicted(LB);
  wasm.gates[0]();
  await p1;
  const p2 = api.ensureCellContainersForLandblock(LB);
  await settle();
  assert.equal(wasm.calls, 2, "the orphaned build did not re-mark the evicted LB populated");
  wasm.gates[1]();
  await p2;
  await api.ensureCellContainersForLandblock(LB);
  assert.equal(wasm.calls, 2, "the post-eviction build marks it populated");
});

for (const [label, search] of [["E3", ""], ["E4", "?interiorBuildShare=off"]]) {
  await t(`${label} evicted mid-build + re-entry: no third build${search ? ` (${search})` : ""}`, async () => {
    const wasm = makeWasm();
    const api = makeStream(wasm, search);
    const p1 = api.ensureCellContainersForLandblock(LB);
    await settle();
    globalThis.__onLandblockEvicted(LB);
    const p2 = api.ensureCellContainersForLandblock(LB);
    await settle();
    assert.equal(wasm.calls, 2, "the re-entry started its own build");
    wasm.gates[0](); // the orphan settles first
    await p1;
    await api.ensureCellContainersForLandblock(LB);
    assert.equal(wasm.calls, 2, "the re-entry's build is still in flight: no third build");
    wasm.gates[1]();
    await p2;
    await api.ensureCellContainersForLandblock(LB);
    assert.equal(wasm.calls, 2, "the re-entry marked the LB populated");
  });
}

for (const [label, search] of [["E5", "?interiorBuildShare=off"], ["E6", ""]]) {
  await t(`${label} the orphaned build fails while the re-entry runs: no third build${search ? ` (${search})` : ""}`, async () => {
    const wasm = makeWasm();
    const api = makeStream(wasm, search);
    const p1 = api.ensureCellContainersForLandblock(LB);
    await settle();
    globalThis.__onLandblockEvicted(LB);
    const p2 = api.ensureCellContainersForLandblock(LB);
    await settle();
    const warn = console.warn;
    console.warn = () => {};
    try {
      wasm.fails[0](new Error("build failed"));
      await p1;
    } finally {
      console.warn = warn;
    }
    const p3 = api.ensureCellContainersForLandblock(LB);
    await settle();
    // Share off: a third build would be a third wasm call. Share on: it would
    // join the re-entry's build (one more `joined`) instead of returning early.
    assert.equal(wasm.calls, 2, "the orphan's finally left the re-entry's in-flight bit alone");
    if (!search) assert.equal(globalThis.__hbInteriorBuildShare.stats.joined, 0, "the third trigger never reached the share");
    wasm.gates[1]();
    await Promise.all([p2, p3]);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
