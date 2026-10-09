// tests/interior_early_bake.test.mjs — `?interiorEarlyBake` (A1-lite, 2026-10-09).
//
// An interior build started Step B (the cells' surface decode in the bake
// worker) and Step C (the cell statics' meshes, then their surfaces) only
// after `fetchEnvCellsInLandblock` resolved — after the Environments, every
// stab's geometry walk and the per-cell loop. Their inputs are on the EnvCell
// records. ON (player's own landblock, export present): the wasm
// `fetchEnvCellDepsInLandblock` runs beside the build and, as soon as it
// resolves, Step B's preload and Step C's mesh fetch (then its surface preload)
// start; the build's own Step B/C join that work instead of repeating it.
//
//   E1  ON: Step B + Step C start before fetchEnvCellsInLandblock resolves
//   E2  ON: no duplicate work — one mesh fetch, every surface decoded once
//   E3  ON: the deps call rejects → the build completes the old way
//   E4  ON: the export is missing (stale pkg) → the old way, nothing called
//   E5  ON: not the player's own landblock → no deps call (ring / skirt)
//   E6  ?interiorEarlyBake=off: the deps call is never made
//   E7  ON: the early mesh fetch fails → Step C refetches once, nothing dropped
//   E8  ON: deps still pending at Step B → abandoned, nothing posted later
//   E9  ON: an early id list in another order → reordered, extras freed
//   E10 contract: lib.rs export (same urgent LBI + EnvCell prefetch), cells.js
//       gate (isNearPlayerLb radius 0), docs row
//
// Run: node tests/interior_early_bake.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.location = { search: "?noEnvcellTimeSlice=1" };
const on = await import("../scene3d/cells.js");
globalThis.location = { search: "?noEnvcellTimeSlice=1&interiorEarlyBake=off" };
const off = await import("../scene3d/cells.js?interiorEarlyBake=off");
globalThis.location = { search: "?noEnvcellTimeSlice=1" };

const LB = 0x86020000;
const CELL = (LB | 0x0100) >>> 0;
const CELL_SURF = 0x08000001;
const STATIC_SURF = 0x08000002;
const STAB_A = 0x02000001;
const STAB_B = 0x01000007;

function triMesh(surface) {
  return {
    triCount: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    uvs: new Float32Array(6),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([surface]),
    freed: 0,
    free() { this.freed += 1; },
  };
}

function placement(stabs) {
  return {
    cellId: CELL,
    environmentId: 0x0d000001,
    cellOriginX: 0, cellOriginY: 0, cellOriginZ: 0,
    cellOrientationQw: 1, cellOrientationQx: 0, cellOrientationQy: 0, cellOrientationQz: 0,
    takePortalCellIds: () => [],
    takeMesh: () => triMesh(CELL_SURF),
    takeStaticObjects: () =>
      stabs.map((did) => ({ did, x: 1, y: 2, z: 3, qw: 1, qx: 0, qy: 0, qz: 0, free() {} })),
    free() {},
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * A MaterialCache stand-in with the REAL dedupe contract (materials.js
 * `preload`): a DID already cached is skipped, a DID in flight is awaited, the
 * rest go to the fetcher in one batch.
 */
function dedupeMaterialCache(log) {
  const cached = new Set();
  const pending = new Map();
  return {
    getCached: () => new THREE.MeshBasicMaterial(),
    getCachedStaticBias: () => new THREE.MeshBasicMaterial(),
    fallbackMaterial: new THREE.MeshBasicMaterial(),
    async preload(dids, fetchSurfacesPixels) {
      log.push(`preload:${[...dids].map((d) => (d >>> 0).toString(16)).join(",")}`);
      const need = [];
      const waits = [];
      for (const d0 of dids) {
        const d = d0 >>> 0;
        if (cached.has(d)) continue;
        if (pending.has(d)) { waits.push(pending.get(d)); continue; }
        need.push(d);
      }
      if (need.length > 0) {
        const shared = Promise.resolve(fetchSurfacesPixels(new Uint32Array(need)));
        for (const d of need) {
          pending.set(d, shared.then(() => { cached.add(d); pending.delete(d); }, () => { pending.delete(d); }));
        }
        await shared;
      }
      await Promise.allSettled(waits);
      return need.length;
    },
  };
}

function rig({
  stabs = [STAB_A, STAB_B],
  depsStabs = null,
  deps = "resolve", // resolve | reject | missing | hang
  mmFailFirst = false,
  playerLb = LB,
} = {}) {
  const log = [];
  const spByDid = new Map();
  const meshesHandedOut = [];
  let mmCalls = 0;
  let depsCalls = 0;
  const placementsGate = deferred();
  const depsGate = deferred();
  const scene3d = {
    cellsGroup: new THREE.Group(),
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    cellContainers3d: new Map(),
    envCellLoadedLbs: new Set(),
    materialCache: dedupeMaterialCache(log),
    renderer: { compile: () => new Set() },
    landblockLru: { getCurrentLbId: () => playerLb },
  };
  const wasm = {
    fetchEnvCellsInLandblock: async (lb) => {
      log.push("fetchEnvCells:start");
      await placementsGate.promise;
      log.push("fetchEnvCells:end");
      return [placement(stabs)];
    },
    fetch_surfaces_pixels: async (dids, urgent) => {
      for (const d of dids) spByDid.set(d >>> 0, (spByDid.get(d >>> 0) || 0) + 1);
      log.push(`sp:${[...dids].map((d) => d.toString(16)).join(",")}:${urgent === true ? "urgent" : "normal"}`);
      return Array.from(dids, () => ({ width: 0, free() {} }));
    },
    fetch_model_meshes: async (ids, urgent) => {
      mmCalls += 1;
      log.push(`mm:${[...ids].map((d) => d.toString(16)).join(",")}:${urgent === true ? "urgent" : "normal"}`);
      if (mmFailFirst && mmCalls === 1) throw new Error("mm boom");
      return Array.from(ids, () => {
        const m = triMesh(STATIC_SURF);
        meshesHandedOut.push(m);
        return m;
      });
    },
  };
  if (deps !== "missing") {
    wasm.fetchEnvCellDepsInLandblock = async (lb) => {
      depsCalls += 1;
      log.push("deps:start");
      if (deps === "reject") throw new Error("deps boom");
      if (deps === "hang") await depsGate.promise;
      return JSON.stringify({
        lb: lb >>> 0,
        numCells: 1,
        cellSurfaceDids: [CELL_SURF],
        stabIds: depsStabs ?? stabs,
      });
    };
  }
  return {
    scene3d, wasm, log, spByDid, meshesHandedOut, placementsGate, depsGate,
    mmCalls: () => mmCalls, depsCalls: () => depsCalls,
  };
}

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}
const quiet = (fn) => async () => {
  const w = console.warn, l = console.log, i = console.info;
  console.warn = () => {}; console.log = () => {}; console.info = () => {};
  try { return await fn(); } finally { console.warn = w; console.log = l; console.info = i; }
};
const hex = (d) => (d >>> 0).toString(16);

await t("E1 ON: Step B + Step C start before fetchEnvCellsInLandblock resolves", quiet(async () => {
  const r = rig();
  const p = on.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm);
  await settle();
  assert.equal(r.depsCalls(), 1);
  assert.ok(!r.log.includes("fetchEnvCells:end"), "the build's fetch is still pending");
  assert.ok(r.log.includes(`preload:${hex(CELL_SURF)}`), "Step B's cell surfaces preloaded early");
  assert.ok(r.log.includes(`mm:${hex(STAB_A)},${hex(STAB_B)}:urgent`), "Step C's mesh fetch posted early, urgent lane");
  assert.ok(r.log.includes(`preload:${hex(STATIC_SURF)}`), "Step C's surfaces preloaded once the meshes landed");
  assert.ok(r.log.includes(`sp:${hex(CELL_SURF)}:urgent`), "the early decode rides the build's urgent lane");
  r.placementsGate.resolve();
  const sum = await p;
  assert.equal(sum.cellCount, 1);
  assert.equal(sum.staticObjectCount, 2);
  assert.equal(sum.skippedNoMesh, 0);
}));

await t("E2 ON: no duplicate Step B/C work (one mesh fetch, each surface decoded once)", quiet(async () => {
  const r = rig();
  const p = on.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm);
  await settle();
  r.placementsGate.resolve();
  const sum = await p;
  assert.equal(sum.cellCount, 1);
  assert.equal(r.mmCalls(), 1, "Step C joined the early mesh fetch");
  assert.equal(r.spByDid.get(CELL_SURF), 1, "cell surface decoded once (Step B joined)");
  assert.equal(r.spByDid.get(STATIC_SURF), 1, "static surface decoded once (Step C joined)");
  // The build's own Step B / Step C preloads still ran — and found the work done.
  assert.equal(r.log.filter((l) => l === `preload:${hex(CELL_SURF)}`).length, 2);
  assert.equal(r.log.filter((l) => l === `preload:${hex(STATIC_SURF)}`).length, 2);
  assert.ok(r.meshesHandedOut.every((m) => m.freed === 1), "every early mesh consumed (freed) exactly once");
  const stats = globalThis.window?.__interiorEarlyBake;
  if (stats) assert.ok(stats.staticsJoined >= 1);
}));

await t("E3 ON: the deps call rejects → the build completes the old way", quiet(async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on("unhandledRejection", onUnhandled);
  const r = rig({ deps: "reject" });
  const p = on.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm);
  await settle();
  assert.equal(r.depsCalls(), 1);
  assert.equal(r.mmCalls(), 0, "nothing posted early");
  r.placementsGate.resolve();
  const sum = await p;
  await settle();
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, 0);
  assert.equal(sum.cellCount, 1);
  assert.equal(sum.staticObjectCount, 2);
  assert.equal(r.mmCalls(), 1, "Step C fetched normally");
}));

/** The build's call sequence (log) for a rig, for the identity checks. */
async function sequence(mod, opts) {
  const r = rig(opts);
  const p = mod.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm);
  await settle();
  r.placementsGate.resolve();
  const sum = await p;
  return { r, sum };
}

await t("E4 ON: the export is missing (stale pkg) → identical to =off", quiet(async () => {
  const a = await sequence(on, { deps: "missing" });
  const b = await sequence(off, {});
  assert.deepEqual(a.r.log, b.r.log, "same call sequence");
  assert.equal(a.sum.cellCount, 1);
}));

await t("E5 ON: not the player's own landblock → no deps call", quiet(async () => {
  const { r, sum } = await sequence(on, { playerLb: 0x86030000 }); // the neighbour
  assert.equal(r.depsCalls(), 0);
  assert.equal(sum.cellCount, 1);
  const b = await sequence(off, { playerLb: 0x86030000 });
  assert.deepEqual(r.log, b.r.log, "a ring/skirt build keeps today's sequence");
}));

await t("E6 ?interiorEarlyBake=off: the deps call is never made", quiet(async () => {
  const { r, sum } = await sequence(off, {});
  assert.equal(r.depsCalls(), 0);
  assert.equal(sum.cellCount, 1);
  assert.ok(r.log.indexOf("fetchEnvCells:end") < r.log.findIndex((l) => l.startsWith("preload:")), "Step B after the fetch");
}));

await t("E7 ON: the early mesh fetch fails → Step C refetches once, nothing dropped", quiet(async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on("unhandledRejection", onUnhandled);
  const r = rig({ mmFailFirst: true });
  const p = on.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm);
  await settle();
  assert.equal(r.mmCalls(), 1, "early fetch made (and failed)");
  r.placementsGate.resolve();
  const sum = await p;
  await settle();
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, 0);
  assert.equal(r.mmCalls(), 2, "one normal refetch");
  assert.equal(sum.skippedNoMesh, 0, "not reported as dropped");
  assert.equal(sum.staticObjectCount, 2);
}));

await t("E8 ON: deps still pending at Step B → abandoned, nothing posted later", quiet(async () => {
  const r = rig({ deps: "hang" });
  const p = on.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm);
  await settle();
  r.placementsGate.resolve();
  const sum = await p;
  assert.equal(sum.cellCount, 1);
  assert.equal(r.mmCalls(), 1, "the build fetched its statics itself");
  const before = r.log.length;
  r.depsGate.resolve();
  await settle();
  assert.equal(r.mmCalls(), 1, "late deps posted no mesh fetch");
  assert.deepEqual(r.log.slice(before), [], "late deps posted nothing at all");
}));

await t("E9 ON: early ids in another order → reordered, extras freed", quiet(async () => {
  // The build references STAB_A, STAB_B; the deps listed an extra id first.
  const EXTRA = 0x02000099;
  const r = rig({ depsStabs: [EXTRA, STAB_B, STAB_A] });
  const p = on.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm);
  await settle();
  r.placementsGate.resolve();
  const sum = await p;
  assert.equal(r.mmCalls(), 1, "no second mesh fetch");
  assert.equal(sum.staticObjectCount, 2);
  assert.equal(sum.skippedNoMesh, 0);
  assert.equal(r.meshesHandedOut.length, 3);
  assert.equal(r.meshesHandedOut[0].freed, 1, "the unused early mesh was freed");
}));

await t("E10 contract: lib.rs export + cells.js gate + docs row", async () => {
  const lib = readFileSync(path.join(APP, "src", "lib.rs"), "utf8");
  const at = lib.indexOf("pub async fn fetch_env_cell_deps_in_landblock(landblock_id: u32) -> Result<String, JsValue>");
  assert.ok(at > 0, "export present");
  const attr = lib.lastIndexOf("#[wasm_bindgen(js_name = fetchEnvCellDepsInLandblock)]", at);
  assert.ok(attr > 0 && at - attr < 200, "exported as fetchEnvCellDepsInLandblock");
  const body = lib.slice(at, lib.indexOf("\n}\n", at));
  assert.match(body, /prefetch_urgent\(&\[ResourceKey::new\("eor\/cell", info_cell\)\]\)/, "LandblockInfo on the urgent lane (same key as the build)");
  assert.match(body, /ResourceKey::new\("eor\/cell", landblock_high \| \(0x0100 \+ i\)\)/, "EnvCell keys = the build's");
  assert.match(body, /source\.prefetch_urgent\(&cell_keys\)/, "EnvCells on the urgent lane");
  assert.match(body, /collect_envcell_deps\(source\.as_ref\(\), landblock_high, info\.num_cells\)/);
  assert.ok(/fn deps_follow_the_builds_cell_order_and_skip_rules\(\)/.test(lib), "native unit test");
  const cells = readFileSync(path.join(APP, "scene3d", "cells.js"), "utf8");
  assert.match(cells, /get\("interiorEarlyBake"\);\s*return !\(v === "off" \|\| v === "0" \|\| v === "false" \|\| v === "no"\);/, "default-on reader, off|0|false|no");
  assert.match(cells, /if \(!isNearPlayerLb\(scene3d, lbKey, 0\)\)/, "player's own landblock only");
  assert.match(cells, /typeof wasmExports\.fetchEnvCellDepsInLandblock !== "function"\) return null;/, "typeof-guarded (stale pkg = no-op)");
  const kick = cells.indexOf("earlyBake = startInteriorEarlyBake(");
  // `?interiorBuildShare` wraps the build's fetch (the same synchronous call; the direct one without the registry).
  const fetch = cells.indexOf("interiorShare.fetch(lbKey, wasmExports.fetchEnvCellsInLandblock,");
  assert.ok(kick > 0 && fetch > kick && fetch - kick < 700, "kicked in the same turn, right before the build's fetch");
  assert.ok(cells.indexOf(": wasmExports.fetchEnvCellsInLandblock(lbKey));", fetch) - fetch < 200, "direct-call fallback beside it");
  const docs = readFileSync(path.join(APP, "docs", "url-flags.md"), "utf8");
  const row = docs.split("\n").find((l) => l.startsWith("| `interiorEarlyBake` |"));
  assert.ok(row, "url-flags.md row `| \\`interiorEarlyBake\\` |` missing");
  assert.ok(row.includes("| `off`/`0`/`false`/`no` to disable |"), "accepted values column");
  assert.ok(row.includes("tests/interior_early_bake.test.mjs"), "names this test");
  // 2026-10-09 (1070 run finA1): the export existed in pkg/ but init3D's opts object is an
  // explicit list, so cells.js saw no fetchEnvCellDepsInLandblock and the kick never ran
  // (__interiorEarlyBake.kicked 0). index.html must thread it through the namespace import.
  const html = readFileSync(path.join(APP, "index.html"), "utf8");
  const call = html.indexOf("await init3D(canvas, window.__sessionHandle, {");
  const end = html.indexOf("}, window.__preInit3DHandle);", call);
  assert.ok(call > 0 && end > call, "init3D call found");
  const opts = html.slice(call, end);
  assert.match(opts, /typeof __hbWasmNs\?\.fetchEnvCellDepsInLandblock === "function"\s*\?\s*\{ fetchEnvCellDepsInLandblock: __hbWasmNs\.fetchEnvCellDepsInLandblock \}/,
    "index.html threads fetchEnvCellDepsInLandblock into init3D opts (namespace import, stale-pkg safe)");
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
