// tests/envcell_statics_overlap.test.mjs — `?envcellStaticsOverlap` (2026-10-09).
//
// An interior build ran Step B (decode the cells' surfaces in the bake
// worker) and THEN Step C (fetch the cell statics' meshes: up to 8 sequential
// discovery rounds, one RTT each). For the Training Academy that put ~4 s of
// network rounds after the 232-surface decode (1070, fresh profile). The
// statics fetch now starts before Step B is awaited.
//
//   O1  ON: fetch_model_meshes is called while Step B's preload is still pending
//   O2  ON: the build still completes, and a failed early fetch is reported the
//       old way (warned + counted dropped) instead of an unhandled rejection
//   O3  `?envcellStaticsOverlap=off`: fetch_model_meshes only after Step B resolves
//
// Run: node tests/envcell_statics_overlap.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import * as THREE from "three";

globalThis.location = { search: "?noEnvcellTimeSlice=1" };
const on = await import("../scene3d/cells.js");
globalThis.location = { search: "?noEnvcellTimeSlice=1&envcellStaticsOverlap=off" };
const off = await import("../scene3d/cells.js?staticsOverlap=off");
globalThis.location = { search: "?noEnvcellTimeSlice=1" };

const LB = 0x86020000;
const CELL = (LB | 0x0100) >>> 0;

function placement() {
  return {
    cellId: CELL,
    environmentId: 0x0d000001,
    cellOriginX: 0, cellOriginY: 0, cellOriginZ: 0,
    cellOrientationQw: 1, cellOrientationQx: 0, cellOrientationQy: 0, cellOrientationQz: 0,
    takePortalCellIds: () => [],
    takeMesh: () => ({
      triCount: 1,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      uvs: new Float32Array(6),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      surfaceIndices: new Uint8Array([0]),
      surfaces: new Uint32Array([0x08000001]),
      free() {},
    }),
    takeStaticObjects: () => [{ did: 0x02000001, x: 1, y: 2, z: 3, qw: 1, qx: 0, qy: 0, qz: 0, free() {} }],
    free() {},
  };
}

function rig({ mmThrows = false } = {}) {
  const log = [];
  let release;
  const stepB = new Promise((r) => { release = r; });
  let preloads = 0;
  const scene3d = {
    cellsGroup: new THREE.Group(),
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    cellContainers3d: new Map(),
    envCellLoadedLbs: new Set(),
    materialCache: {
      getCached: () => new THREE.MeshBasicMaterial(),
      getCachedStaticBias: () => new THREE.MeshBasicMaterial(),
      fallbackMaterial: new THREE.MeshBasicMaterial(),
      async preload() {
        const n = ++preloads;
        log.push(`preload${n}:start`);
        if (n === 1) await stepB; // Step B: the cells' surfaces
        log.push(`preload${n}:end`);
      },
    },
    renderer: { compile: () => new Set() },
  };
  const wasm = {
    fetchEnvCellsInLandblock: async () => [placement()],
    fetch_surfaces_pixels: () => {},
    fetch_model_meshes: async (ids) => {
      log.push("mm");
      if (mmThrows) throw new Error("mm boom");
      return Array.from(ids, () => ({ triCount: 0, free() {} }));
    },
  };
  return { scene3d, wasm, log, release };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

let failures = 0;
async function t(name, fn) {
  try { await fn(); console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}
const quiet = (fn) => async () => {
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.warn = w; console.log = l; }
};

await t("O1 ON: the statics fetch starts while Step B is pending", quiet(async () => {
  const { scene3d, wasm, log, release } = rig();
  const p = on.buildEnvCellsForLandblock(scene3d, LB, wasm);
  await settle();
  assert.deepEqual([...log].sort(), ["mm", "preload1:start"]); // both in flight, Step B unresolved
  release();
  const sum = await p;
  assert.equal(sum.cellCount, 1);
  assert.ok(log.indexOf("mm") < log.indexOf("preload1:end"));
}));

await t("O2 ON: a failed early fetch is reported the old way, the build completes", quiet(async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on("unhandledRejection", onUnhandled);
  const { scene3d, wasm, release } = rig({ mmThrows: true });
  const p = on.buildEnvCellsForLandblock(scene3d, LB, wasm);
  await settle();
  release();
  const sum = await p;
  await settle();
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, 0);
  assert.equal(sum.cellCount, 1);
  assert.equal(sum.skippedNoMesh, 1);
}));

await t("O3 ?envcellStaticsOverlap=off: the statics fetch waits for Step B", quiet(async () => {
  const { scene3d, wasm, log, release } = rig();
  const p = off.buildEnvCellsForLandblock(scene3d, LB, wasm);
  await settle();
  assert.deepEqual(log, ["preload1:start"]);
  release();
  await p;
  assert.ok(log.indexOf("mm") > log.indexOf("preload1:end"));
}));

console.log(`\n${failures ? `${failures} failed` : "3 passed, 0 failed"}`);
process.exit(failures ? 1 : 0);
