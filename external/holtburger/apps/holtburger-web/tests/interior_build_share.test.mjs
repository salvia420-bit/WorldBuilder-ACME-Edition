// tests/interior_build_share.test.mjs — `?interiorBuildShare` (2026-10-09).
//
// app/landblock_stream.js `ensureCellContainersForLandblock` (collision / cell
// graph) and scene3d/cells.js `buildEnvCellsForLandblock` (meshes) each ran
// their own `fetchEnvCellsInLandblock` for the same landblock — the academy's
// ~1.7 s per-cell loop twice on the main thread, and every cell static BSP /
// portal polygon queued twice. ON: one in-flight build per landblock, shared
// through `globalThis.__hbInteriorBuildShare`; the handles belong to the one
// READER (cells.js), an observer (landblock_stream) frees only when it was the
// sole caller.
//
//   H1  two concurrent callers -> one wasm call, the same array; entry dropped on settle
//   H2  sequential calls -> two wasm calls
//   H3  rejection reaches both callers, clears the entry; the next call is fresh
//   H4  =off -> every call runs its own build (consumersOf = 1)
//   H5  a second READER never joins (own build); a later observer joins the newest
//   H6  a different fn (other instance / stub) never shares
//   H7  fn is called synchronously (same turn — interiorEarlyBake's request sharing)
//   H8  a synchronously throwing fn -> rejected promise, entry cleared
//   H9  forget(lb) (eviction) -> next call fresh; the old callers still settle
//   I1  real code, stream first + cells joins: ONE wasm call, no use-after-free,
//       every handle freed exactly once (by cells.js), LB marked populated
//   I2  real code, cells first + stream joins: same
//   I3  real code, stream alone: the sole owner frees each handle once
//   I4  real code, =off: two wasm calls, stream frees nothing (today's behaviour)
//   I5  real code, __onLandblockEvicted mid-build -> the re-entry starts a fresh build
//   I6  eviction of an x>=0x80 landblock clears its populated mark (the hook's key was signed)
//   C1  contract: cells.js hunk, landblock_stream install site, docs row
//
// Run: node tests/interior_build_share.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.location = { search: "?noEnvcellTimeSlice=1&interiorEarlyBake=off" };
// cells.js (and statics.js under it) must load WITHOUT a `window` (browser-only
// module-load paths); landblock_stream.js reads `window.location` and assigns
// `window.__…` hooks at call time, so `window` is aliased after the import.
const cells = await import("../scene3d/cells.js");
const stream = await import("../app/landblock_stream.js");
const { installInteriorBuildShare, interiorBuildShareEnabled, createLandblockStream } = stream;
globalThis.window = globalThis;

const LB = 0x86020000;
const CELL = (LB | 0x0100) >>> 0;
const CELL_SURF = 0x08000001;

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${(e && e.stack) || e}`);
  }
}
const quiet = (fn) => async () => {
  const w = console.warn, l = console.log, i = console.info;
  console.warn = () => {}; console.log = () => {}; console.info = () => {};
  try { return await fn(); } finally { console.warn = w; console.log = l; console.info = i; }
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
/** A fresh registry on its own global object (`search` = its query string). */
const freshShare = (search = "") => installInteriorBuildShare({ location: { search } });

console.log("interior build share (?interiorBuildShare)");

// ── the registry ───────────────────────────────────────────────────────────
await t("H1 two concurrent callers -> one wasm call, the same array; entry dropped on settle", async () => {
  const share = freshShare();
  const gate = deferred();
  let calls = 0;
  const fn = (lb) => { calls += 1; assert.equal(lb, LB); return gate.promise; };
  const quietLog = console.log; console.log = () => {};
  let pa, pb;
  try {
    pa = share.fetch(LB, fn, { who: "landblock_stream" });
    pb = share.fetch(LB | 0x0123, fn, { who: "cells", reads: true }); // any cell of the LB
  } finally { console.log = quietLog; }
  assert.equal(calls, 1, "one wasm build");
  assert.equal(pa, pb, "the same promise");
  assert.equal(share.inFlight.size, 1);
  const arr = [{}, {}];
  gate.resolve(arr);
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.equal(ra, arr);
  assert.equal(rb, arr);
  assert.equal(share.inFlight.size, 0, "entry deleted on settle");
  assert.equal(share.consumersOf(arr), 2, "both callers received it");
  assert.equal(share.stats.builds, 1);
  assert.equal(share.stats.joined, 1);
});

await t("H2 sequential calls -> two wasm calls", async () => {
  const share = freshShare();
  let calls = 0;
  const fn = async () => { calls += 1; return [{}]; };
  const a = await share.fetch(LB, fn, { who: "landblock_stream" });
  const b = await share.fetch(LB, fn, { who: "cells", reads: true });
  assert.equal(calls, 2);
  assert.notEqual(a, b);
  assert.equal(share.consumersOf(a), 1);
  assert.equal(share.consumersOf(b), 1);
});

await t("H3 rejection reaches both callers, clears the entry; the next call is fresh", async () => {
  const share = freshShare();
  const gate = deferred();
  let calls = 0;
  const fn = () => { calls += 1; return calls === 1 ? gate.promise : Promise.resolve([{}]); };
  const l = console.log; console.log = () => {};
  const pa = share.fetch(LB, fn, { who: "landblock_stream" });
  const pb = share.fetch(LB, fn, { who: "cells", reads: true });
  console.log = l;
  gate.reject(new Error("prefetch EnvCells failed"));
  const [ra, rb] = await Promise.allSettled([pa, pb]);
  assert.equal(ra.status, "rejected");
  assert.equal(rb.status, "rejected");
  assert.match(String(ra.reason.message), /prefetch EnvCells failed/);
  assert.equal(share.inFlight.size, 0, "entry cleared on rejection");
  assert.equal(share.stats.rejected, 1);
  await share.fetch(LB, fn, { who: "cells", reads: true });
  assert.equal(calls, 2, "a retry starts a new build");
});

await t("H4 =off -> every call runs its own build", async () => {
  for (const tok of ["off", "0", "false", "no", "OFF"]) {
    assert.equal(interiorBuildShareEnabled(`?interiorBuildShare=${tok}`), false, tok);
  }
  for (const tok of ["", "?interiorBuildShare=on", "?interiorBuildShare=1", "?x=1"]) {
    assert.equal(interiorBuildShareEnabled(tok), true, tok);
  }
  const share = freshShare("?interiorBuildShare=off");
  assert.equal(share.enabled, false);
  let calls = 0;
  const gate = deferred();
  const fn = () => { calls += 1; return gate.promise.then(() => [{}]); };
  const pa = share.fetch(LB, fn, { who: "landblock_stream" });
  const pb = share.fetch(LB, fn, { who: "cells", reads: true });
  assert.equal(calls, 2, "two builds, as before");
  assert.equal(share.inFlight.size, 0, "nothing registered");
  gate.resolve();
  const [a, b] = await Promise.all([pa, pb]);
  assert.notEqual(a, b);
  assert.equal(share.consumersOf(a), 1);
});

await t("H5 a second READER never joins; a later observer joins the newest build", async () => {
  const share = freshShare();
  const gates = [deferred(), deferred()];
  let calls = 0;
  const fn = () => gates[calls++].promise;
  const l = console.log; console.log = () => {};
  const r1 = share.fetch(LB, fn, { who: "cells", reads: true });
  const r2 = share.fetch(LB, fn, { who: "cells", reads: true }); // e.g. park → rebuild
  const obs = share.fetch(LB, fn, { who: "landblock_stream" });
  console.log = l;
  assert.equal(calls, 2, "the second reader got its own build");
  assert.notEqual(r1, r2);
  assert.equal(obs, r2, "the observer joined the newest build");
  assert.equal(share.stats.readerBypass, 1);
  const a1 = [{}], a2 = [{}];
  gates[0].resolve(a1);
  gates[1].resolve(a2);
  await Promise.all([r1, r2, obs]);
  assert.equal(share.inFlight.size, 0, "the older build's settle did not leave/clobber the newer entry");
  assert.equal(share.consumersOf(a1), 1);
  assert.equal(share.consumersOf(a2), 2);
});

await t("H6 a different fn (another instance / a stub) never shares", async () => {
  const share = freshShare();
  let a = 0, b = 0;
  const gate = deferred();
  const fnA = () => { a += 1; return gate.promise; };
  const fnB = () => { b += 1; return gate.promise; };
  const pa = share.fetch(LB, fnA, { who: "landblock_stream" });
  const pb = share.fetch(LB, fnB, { who: "cells", reads: true });
  assert.equal(a + b, 2);
  assert.notEqual(pa, pb);
  assert.equal(share.stats.fnMismatch, 1);
  gate.resolve([]);
  await Promise.all([pa, pb]);
});

await t("H7 fn is called synchronously, with thisArg", async () => {
  const share = freshShare();
  const exportsObj = { tag: "wasm" };
  let sawThis = null;
  let called = false;
  function fn(lb) { called = true; sawThis = this; return Promise.resolve([]); }
  const p = share.fetch(LB, fn, { who: "cells", reads: true, thisArg: exportsObj });
  assert.equal(called, true, "called inside fetch(), before any await");
  assert.equal(sawThis, exportsObj);
  await p;
});

await t("H8 a synchronously throwing fn -> rejected promise, entry cleared", async () => {
  const share = freshShare();
  const p = share.fetch(LB, () => { throw new Error("wasm trap"); }, { who: "cells", reads: true });
  await assert.rejects(p, /wasm trap/);
  assert.equal(share.inFlight.size, 0);
});

await t("H9 forget(lb) -> the next call is fresh; the old callers still settle", async () => {
  const share = freshShare();
  const gates = [deferred(), deferred()];
  let calls = 0;
  const fn = () => gates[calls++].promise;
  const old = share.fetch(LB, fn, { who: "landblock_stream" });
  share.forget(LB | 0x0105);
  assert.equal(share.stats.forgotten, 1);
  const fresh = share.fetch(LB, fn, { who: "cells", reads: true });
  assert.equal(calls, 2);
  assert.notEqual(old, fresh);
  const a = [{}], b = [{}];
  gates[0].resolve(a);
  gates[1].resolve(b);
  assert.equal(await old, a);
  assert.equal(await fresh, b);
  assert.equal(share.inFlight.size, 0);
});

// ── the real callers ───────────────────────────────────────────────────────
function triMesh(surface) {
  return {
    triCount: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    uvs: new Float32Array(6),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([surface]),
    free() {},
  };
}

/**
 * A wasm-bindgen-like `EnvCellPlacement`: any property read after `free()`
 * records a use-after-free and throws, like the real "null pointer passed to rust".
 */
function guardedPlacement(audit, i) {
  let freed = false;
  const base = {
    cellId: (CELL + i) >>> 0,
    environmentId: 0x0d000001,
    cellOriginX: i * 10, cellOriginY: 0, cellOriginZ: 0,
    cellOrientationQw: 1, cellOrientationQx: 0, cellOrientationQy: 0, cellOrientationQz: 0,
    takePortalCellIds: () => [],
    takeMesh: () => triMesh(CELL_SURF),
    takeStaticObjects: () => [],
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "free") {
        return () => {
          if (freed) audit.doubleFree += 1;
          freed = true;
          audit.frees += 1;
        };
      }
      if (freed) {
        audit.uaf.push(String(prop));
        throw new Error("null pointer passed to rust");
      }
      return target[prop];
    },
  });
}

/** The one main-instance export both callers receive (index.html passes the same binding). */
function makeWasm(audit, nCells = 3) {
  const gate = deferred();
  const wasm = {
    calls: 0,
    gate,
    fetchEnvCellsInLandblock: async (lb) => {
      wasm.calls += 1;
      await gate.promise;
      return Array.from({ length: nCells }, (_, i) => guardedPlacement(audit, i));
    },
    fetch_surfaces_pixels: async (dids) => Array.from(dids, () => ({ width: 0, free() {} })),
    fetch_model_meshes: async (ids) => Array.from(ids, () => triMesh(CELL_SURF)),
  };
  return wasm;
}

function makeScene3d() {
  return {
    cellsGroup: new THREE.Group(),
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    cellContainers3d: new Map(),
    envCellLoadedLbs: new Set(),
    materialCache: {
      getCached: () => new THREE.MeshBasicMaterial(),
      getCachedStaticBias: () => new THREE.MeshBasicMaterial(),
      fallbackMaterial: new THREE.MeshBasicMaterial(),
      async preload() { return 0; },
    },
    renderer: { compile: () => new Set() },
    landblockLru: { getCurrentLbId: () => LB },
  };
}

/** Build the real landblock stream (3D: liveScene null) on a fresh registry. */
function makeStream(wasm, search = "?noEnvcellTimeSlice=1&interiorEarlyBake=off") {
  globalThis.location = { search };
  delete globalThis.__hbInteriorBuildShare;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0; // the cell-residency watchdog — not under test
  try {
    const noop = () => {};
    const api = createLandblockStream({
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
    return api;
  } finally {
    globalThis.setInterval = realSetInterval;
  }
}
const newAudit = () => ({ frees: 0, doubleFree: 0, uaf: [] });

await t("I1 real code, stream first + cells joins: one wasm call, no use-after-free", quiet(async () => {
  const audit = newAudit();
  const wasm = makeWasm(audit, 3);
  const api = makeStream(wasm);
  const scene3d = makeScene3d();
  // The spawn kick (client_events.js) fires the collision half, then the mesh half.
  const pStream = api.ensureCellContainersForLandblock(LB | 0x0101);
  await settle(); // cells.js reaches its fetch later (stream-bake guard / init3D)
  const pCells = cells.buildEnvCellsForLandblock(scene3d, LB, wasm);
  await settle();
  assert.equal(wasm.calls, 1, "ONE fetchEnvCellsInLandblock for the landblock");
  wasm.gate.resolve();
  const [, res] = await Promise.all([pStream, pCells]);
  assert.equal(res.cellCount, 3, "cells.js built every cell from the shared array");
  assert.deepEqual(audit.uaf, [], "no handle read after free");
  assert.equal(audit.doubleFree, 0);
  assert.equal(audit.frees, 3, "each handle freed exactly once (by the reader)");
  assert.ok(scene3d.envCellLoadedLbs.has(LB));
  const share = globalThis.__hbInteriorBuildShare;
  assert.equal(share.stats.builds, 1);
  assert.equal(share.stats.joined, 1);
  assert.equal(share.inFlight.size, 0);
  // The stream half counts as populated: a later trigger is a no-op.
  await api.ensureCellContainersForLandblock(LB);
  assert.equal(wasm.calls, 1, "populated LB is not re-fetched");
}));

await t("I2 real code, cells first + stream joins: same", quiet(async () => {
  const audit = newAudit();
  const wasm = makeWasm(audit, 2);
  const api = makeStream(wasm);
  const scene3d = makeScene3d();
  const pCells = cells.buildEnvCellsForLandblock(scene3d, LB, wasm);
  await settle();
  const pStream = api.ensureCellContainersForLandblock(LB);
  await settle();
  assert.equal(wasm.calls, 1);
  wasm.gate.resolve();
  const [res] = await Promise.all([pCells, pStream]);
  assert.equal(res.cellCount, 2);
  assert.deepEqual(audit.uaf, []);
  assert.equal(audit.doubleFree, 0);
  assert.equal(audit.frees, 2);
}));

await t("I3 real code, stream alone: the sole owner frees each handle once", quiet(async () => {
  const audit = newAudit();
  const wasm = makeWasm(audit, 4);
  const api = makeStream(wasm);
  const p = api.ensureCellContainersForLandblock(LB);
  wasm.gate.resolve();
  await p;
  assert.equal(wasm.calls, 1);
  assert.equal(audit.frees, 4, "released now instead of at GC");
  assert.equal(audit.doubleFree, 0);
  assert.deepEqual(audit.uaf, []);
}));

await t("I4 real code, =off: two wasm calls, the stream frees nothing (today)", quiet(async () => {
  const audit = newAudit();
  const wasm = makeWasm(audit, 2);
  const api = makeStream(wasm, "?noEnvcellTimeSlice=1&interiorEarlyBake=off&interiorBuildShare=off");
  assert.equal(globalThis.__hbInteriorBuildShare.enabled, false);
  const scene3d = makeScene3d();
  const pStream = api.ensureCellContainersForLandblock(LB);
  const pCells = cells.buildEnvCellsForLandblock(scene3d, LB, wasm);
  await settle();
  assert.equal(wasm.calls, 2, "each caller ran its own build, as before the flag");
  wasm.gate.resolve();
  const [, res] = await Promise.all([pStream, pCells]);
  assert.equal(res.cellCount, 2);
  assert.equal(audit.frees, 2, "only cells.js freed (its own array); the stream left its copy to GC");
  assert.deepEqual(audit.uaf, []);
}));

await t("I5 real code, __onLandblockEvicted mid-build -> the re-entry starts a fresh build", quiet(async () => {
  const audit = newAudit();
  const wasm = makeWasm(audit, 1);
  const api = makeStream(wasm);
  const p1 = api.ensureCellContainersForLandblock(LB);
  await settle();
  globalThis.__onLandblockEvicted(LB | 0x0101);
  const p2 = api.ensureCellContainersForLandblock(LB);
  await settle();
  assert.equal(wasm.calls, 2, "the re-entry did not join the pre-eviction build");
  assert.equal(globalThis.__hbInteriorBuildShare.stats.forgotten, 1);
  wasm.gate.resolve();
  await Promise.all([p1, p2]);
  assert.equal(audit.frees, 2, "each sole owner freed its own array");
  assert.deepEqual(audit.uaf, []);
}));

await t("I6 eviction of an x>=0x80 landblock clears its populated mark (unsigned key)", quiet(async () => {
  const audit = newAudit();
  const wasm = makeWasm(audit, 1);
  wasm.gate.resolve();
  const api = makeStream(wasm);
  await api.ensureCellContainersForLandblock(LB);
  await api.ensureCellContainersForLandblock(LB);
  assert.equal(wasm.calls, 1, "populated: the second trigger is a no-op");
  // index.js passes `lbKey >>> 0`; the hook used to mask it back to a SIGNED
  // int32 for x >= 0x80 and delete nothing.
  globalThis.__onLandblockEvicted(LB >>> 0);
  await api.ensureCellContainersForLandblock(LB);
  assert.equal(wasm.calls, 2, "after eviction the revisit re-populates");
}));

await t("C1 contract: cells.js hunk, landblock_stream install + evict, docs row", async () => {
  const cellsSrc = readFileSync(path.join(APP, "scene3d", "cells.js"), "utf8");
  assert.match(cellsSrc, /globalThis\.__hbInteriorBuildShare/);
  assert.match(cellsSrc, /interiorShare\.fetch\(lbKey, wasmExports\.fetchEnvCellsInLandblock, \{ who: "cells", reads: true, thisArg: wasmExports \}\)/);
  assert.match(cellsSrc, /: wasmExports\.fetchEnvCellsInLandblock\(lbKey\)\)/, "direct-call fallback kept");
  const lsSrc = readFileSync(path.join(APP, "app", "landblock_stream.js"), "utf8");
  assert.match(lsSrc, /const envCellsShare = installInteriorBuildShare\(globalThis\);/);
  assert.match(lsSrc, /envCellsShare\.forget\(lb\);/);
  const docsPath = process.env.HB_URL_FLAGS_MD || path.join(APP, "docs", "url-flags.md");
  const docs = readFileSync(docsPath, "utf8");
  const row = docs.split("\n").find((l) => l.startsWith("| `interiorBuildShare` |"));
  assert.ok(row, "url-flags.md row `| \\`interiorBuildShare\\` |` missing");
  assert.match(row, /`off`\/`0`\/`false`\/`no`/);
  assert.match(row, /app\/landblock_stream\.js/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
