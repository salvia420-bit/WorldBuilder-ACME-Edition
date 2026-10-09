// tests/interior_walls_first.test.mjs — `?interiorWallsFirst` (2026-10-09).
//
// An interior build attached nothing until Step C (the cell statics' meshes,
// then their surfaces) had finished, although the walls only need Step B.
// Academy 0x8602 on the 1070 (run fin2A1): Step B's cell materials were in by
// ~13.8 s, cellsGroup stayed empty until 28.6 s (fetch_model_meshes 5.6 s,
// then the statics' 232 surfaces in one 13.9 s fetchSurfacesPixels call).
// ON: the walls are built, prewarmed, attached and registered while Step C
// runs; the statics join the live containers when it settles; only then is
// the landblock built (envCellLoadedLbs, in-flight marker released, result).
//
//   W1  ON: walls attached + registered while the statics' mesh fetch is
//       pending; LB not built, still in flight; the login tunnel's
//       destinationCellsReady reads ready; statics then join the SAME
//       containers (layer mask, frozen world matrix), LB built only then
//   W2  ON: same while the statics' SURFACES are still decoding (the 13.9 s
//       academy case): walls up, statics wait for their materials
//   W3  ON: Step C's fetch fails → walls stay, statics reported exactly as
//       =off reports them (warn + geom-audit, skippedNoMesh, missing stamps),
//       LB built
//   W4  ON: evicted between walls and statics → nothing attached, every
//       geometry the build made disposed, wasm meshes freed; a re-approach
//       rebuilds cleanly (no orphans)
//   W5  ON: parked between walls and statics → the walls-only containers
//       leave the park stash; unpark re-attaches nothing; LB not built
//   W6  ON: park → unpark → a NEW build attaches its walls while the old one
//       still waits on Step C → the old walls are detached, the old build
//       cancels without touching the new one, which completes normally
//   W12 ON: park → a NEW build attaches its walls → unpark (the reverse
//       order of W6): the new build's attach dropped the stale walls from
//       the park stash, so the unpark cannot re-register them over its own
//       (which the old build's cancel would then unregister → the landblock
//       built with its cells unregistered, the new walls orphaned)
//   W7  ON: an unexpected throw after the walls attached → walls removed,
//       build rejects, LB not built, in-flight cleared (same end state as =off)
//   W8  ON: a landblock without cell statics → single-stage path, identical
//       call sequence to =off
//   W9  ?interiorWallsFirst=off: nothing attached until Step C settles; one
//       prewarm with walls + statics (today's order)
//   W10 ON: the same park / evict (and W12's park → new build → unpark)
//       through the REAL LandblockLRU (its park stash shape is what
//       `_dropCellsFromParkStash` edits)
//   W11 contract: cells.js reader, portal_space login readiness, docs row
//
// Run: node tests/interior_walls_first.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.location = { search: "?noEnvcellTimeSlice=1" };
const on = await import("../scene3d/cells.js");
globalThis.location = { search: "?noEnvcellTimeSlice=1&interiorWallsFirst=off" };
const off = await import("../scene3d/cells.js?interiorWallsFirst=off");
globalThis.location = { search: "?noEnvcellTimeSlice=1" };
const ps = await import("../scene3d/portal_space.js");

const LB = 0x86020000;
const CELL_A = (LB | 0x0100) >>> 0; // two statics
const CELL_B = (LB | 0x0101) >>> 0; // none
const CELL_SURF = 0x08000001;
const STATIC_SURF = 0x08000002;
const STAB_A = 0x02000001;
const STAB_B = 0x01000007;
const hex = (d) => (d >>> 0).toString(16);

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

/** A static mesh whose surface table throws: an unexpected Step C error. */
function badMesh() {
  const m = triMesh(STATIC_SURF);
  Object.defineProperty(m, "surfaces", { get() { throw new Error("surfaces boom"); } });
  return m;
}

function placement(cellId, stabs) {
  return {
    cellId,
    environmentId: 0x0d000001,
    cellOriginX: 0, cellOriginY: 0, cellOriginZ: 0,
    cellOrientationQw: 1, cellOrientationQx: 0, cellOrientationQy: 0, cellOrientationQz: 0,
    takePortalCellIds: () => [],
    takeMesh: () => triMesh(CELL_SURF),
    takeStaticObjects: () =>
      stabs.map((did, i) => ({ did, x: 1 + i, y: 2, z: 3, qw: 1, qx: 0, qy: 0, qz: 0, free() {} })),
    free() {},
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const MAT = new THREE.MeshBasicMaterial();

/** The cells half of landblock_lru.js `park` / `unpark` / `evict` (④ + ⑥). */
function lruStub(scene3d) {
  const parkPool = new Map();
  const mine = (cellId) => (((cellId >>> 0) & 0xffff0000) >>> 0);
  const detach = (lbKey) => {
    const cells = [];
    for (const [cellId, c] of scene3d.cellContainers3d) if (mine(cellId) === lbKey) cells.push([cellId, c]);
    for (const [cellId, c] of cells) {
      scene3d.cellsGroup.remove(c);
      scene3d.cellContainers3d.delete(cellId);
    }
    scene3d.envCellBuildInFlight?.delete(lbKey);
    scene3d.envCellBuildGen?.delete(lbKey);
    return cells;
  };
  return {
    parkPool,
    isParked: (k) => parkPool.has(k >>> 0),
    park(lbKey) { parkPool.set(lbKey, { cells: detach(lbKey) }); },
    unpark(lbKey) {
      const p = parkPool.get(lbKey);
      if (!p) return false;
      for (const [cellId, c] of p.cells) {
        scene3d.cellsGroup.add(c);
        scene3d.cellContainers3d.set(cellId, c);
      }
      parkPool.delete(lbKey);
      return true;
    },
    evict(lbKey) {
      detach(lbKey);
      scene3d.envCellLoadedLbs.delete(lbKey);
    },
  };
}

function makeScene3d(log) {
  const compiles = [];
  const scene3d = {
    cellsGroup: new THREE.Group(),
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    cellContainers3d: new Map(),
    envCellLoadedLbs: new Set(),
    materialCache: null,
    renderer: {
      compile: (obj) => {
        const names = [];
        obj.traverse((o) => { if (o.isMesh) names.push(o.name); });
        compiles.push(names);
        log.push(`compile:${names.length}`);
        return new Set();
      },
    },
  };
  scene3d.landblockLru = lruStub(scene3d);
  return { scene3d, compiles };
}

/**
 * One build's wasm + material cache. `mm`: "gate" (resolves on mmGate),
 * "now", "throw" (rejects on mmGate), "bad" (resolves on mmGate with a mesh
 * whose surfaces getter throws). `ssGate`: the statics' surface preload waits.
 */
function rig({ scene = null, mm = "gate", ssGate = false, cells = [[CELL_A, [STAB_A, STAB_B]], [CELL_B, []]] } = {}) {
  const log = [];
  const made = scene || makeScene3d(log);
  const { scene3d } = made;
  const mmGate = deferred();
  const ssG = deferred();
  const handed = [];
  scene3d.materialCache = {
    getCached: () => MAT,
    getCachedStaticBias: () => MAT,
    fallbackMaterial: MAT,
    async preload(dids) {
      const ds = [...dids].map((d) => d >>> 0);
      log.push(`preload:${ds.map(hex).join(",")}`);
      if (ssGate && ds.includes(STATIC_SURF)) await ssG.promise;
      log.push(`preload-end:${ds.map(hex).join(",")}`);
    },
  };
  const wasm = {
    fetchEnvCellsInLandblock: async () => cells.map(([id, stabs]) => placement(id, stabs)),
    fetch_surfaces_pixels: async () => [],
    fetch_model_meshes: async (ids) => {
      log.push(`mm:${[...ids].map(hex).join(",")}`);
      if (mm !== "now") await mmGate.promise;
      if (mm === "throw") throw new Error("mm boom");
      return Array.from(ids, () => {
        const m = mm === "bad" ? badMesh() : triMesh(STATIC_SURF);
        handed.push(m);
        return m;
      });
    },
  };
  return { scene3d, wasm, log, mmGate, ssG, handed, compiles: made.compiles };
}

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
function tracked(p) {
  const t = { done: false, value: undefined, error: undefined };
  t.p = p.then((v) => { t.done = true; t.value = v; return v; }, (e) => { t.done = true; t.error = e; throw e; });
  return t;
}
const statics = (c) => c.children.filter((k) => k.userData?.isCellStatic === true);
const meshGroupOf = (c) => c.children.find((k) => (k.name || "").startsWith("mesh-"));

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}
/** Silence the build's console; collect warnings for the assertions. */
const quiet = (fn) => async () => {
  const w = console.warn, l = console.log, i = console.info;
  const warns = [];
  console.warn = (...a) => { warns.push(a.map(String).join(" ")); };
  console.log = () => {}; console.info = () => {};
  try { return await fn(warns); } finally { console.warn = w; console.log = l; console.info = i; }
};

await t("W1 ON: walls attached before the statics' mesh fetch resolves; statics join them; LB built only then", quiet(async () => {
  const r = rig();
  const b = tracked(on.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm));
  await settle();
  const s = r.scene3d;
  assert.equal(b.done, false, "the build is still pending (Step C)");
  assert.ok(r.log.includes(`mm:${hex(STAB_A)},${hex(STAB_B)}`), "statics fetch in flight");
  assert.equal(s.cellsGroup.children.length, 2, "both cells attached");
  const cA = s.cellContainers3d.get(CELL_A);
  const cB = s.cellContainers3d.get(CELL_B);
  assert.ok(cA && cB && cA.parent === s.cellsGroup && cB.parent === s.cellsGroup, "registered + attached");
  assert.ok(meshGroupOf(cA), "walls (mesh group) present");
  assert.equal(statics(cA).length, 0, "no statics yet");
  assert.equal(cA.layers.mask, 1 << 1, "layer 1 like today's attach");
  assert.equal(cA.matrixWorldAutoUpdate, false, "frozen like today's attach");
  assert.equal(s.envCellLoadedLbs.has(LB), false, "LB NOT built");
  assert.equal(s.envCellBuildInFlight.has(LB), true, "LB still building");
  assert.equal(ps.destinationCellsReady(s, CELL_A), true, "login/teleport tunnel: spawn cell resident at walls");
  assert.equal(ps.destinationBuildInFlight(s, CELL_A), true);
  assert.equal(r.compiles.length, 1, "walls prewarmed once");
  assert.ok(r.compiles[0].length > 0 && r.compiles[0].every((n) => !n.startsWith("cellstatic-")), "the walls prewarm has no props");

  r.mmGate.resolve();
  const sum = await b.p;
  assert.equal(sum.cellCount, 2);
  assert.equal(sum.staticObjectCount, 2);
  assert.equal(sum.skippedNoMesh, 0);
  assert.equal(sum.wallsFirst, true);
  assert.equal(s.cellContainers3d.get(CELL_A), cA, "same container (not rebuilt)");
  const st = statics(cA);
  assert.equal(st.length, 2, "statics joined the live container");
  assert.equal(statics(cB).length, 0);
  for (const m of st) {
    assert.equal(m.layers.mask, cA.layers.mask, "prop on the container's layer");
    const e = m.matrixWorld.elements;
    assert.deepEqual([e[12], e[13], e[14]], [m.position.x, m.position.y, m.position.z], "world matrix composed under the frozen container");
  }
  assert.ok(st.some((m) => m.position.x !== 0), "props placed");
  assert.equal(s.envCellLoadedLbs.has(LB), true, "LB built after the statics");
  assert.equal(s.envCellBuildInFlight.has(LB), false, "in-flight released at the end");
  assert.equal(r.compiles.length, 2, "statics prewarmed separately");
  assert.ok(r.compiles[1].length === 2 && r.compiles[1].every((n) => n.startsWith("cellstatic-")), "the second prewarm = the props");
  const geoms = new Set(sum.disposables.geometries);
  assert.ok(geoms.has(meshGroupOf(cA).children[0].geometry), "walls geometry handed to the LRU");
  assert.ok(st.every((m) => geoms.has(m.geometry)), "statics geometry handed to the LRU");
  assert.ok(r.handed.every((m) => m.freed === 1), "each wasm mesh freed once");
}));

await t("W2 ON: walls up while the statics' surfaces decode; statics wait for their materials", quiet(async () => {
  const r = rig({ mm: "now", ssGate: true });
  const b = tracked(on.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm));
  await settle();
  const s = r.scene3d;
  assert.ok(r.log.includes(`preload:${hex(STATIC_SURF)}`), "statics' surface preload in flight");
  assert.ok(!r.log.includes(`preload-end:${hex(STATIC_SURF)}`));
  assert.equal(b.done, false);
  assert.equal(s.cellsGroup.children.length, 2, "walls attached");
  assert.equal(statics(s.cellContainers3d.get(CELL_A)).length, 0);
  assert.equal(s.envCellLoadedLbs.has(LB), false);
  r.ssG.resolve();
  const sum = await b.p;
  assert.equal(sum.staticObjectCount, 2);
  assert.equal(statics(s.cellContainers3d.get(CELL_A)).length, 2);
  assert.equal(s.envCellLoadedLbs.has(LB), true);
}));

await t("W3 ON: Step C fetch fails → walls stay, statics reported exactly as =off", async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on("unhandledRejection", onUnhandled);
  const run = async (mod) => quiet(async (warns) => {
    const r = rig({ mm: "throw" });
    const b = tracked(mod.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm));
    await settle();
    const attachedEarly = r.scene3d.cellsGroup.children.length;
    const cA = r.scene3d.cellContainers3d.get(CELL_A);
    r.mmGate.resolve();
    const sum = await b.p;
    return { r, sum, warns, attachedEarly, cA };
  })();
  const a = await run(on);
  const o = await run(off);
  await settle();
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, 0);
  assert.equal(a.attachedEarly, 2, "ON: walls attached before the failure");
  assert.equal(o.attachedEarly, 0, "OFF: nothing before Step C");
  assert.equal(a.r.scene3d.cellContainers3d.get(CELL_A), a.cA, "the walls stayed (same container)");
  for (const k of ["cellCount", "staticObjectCount", "skippedNoMesh", "skippedZeroTri", "surfaceCount"]) {
    assert.equal(a.sum[k], o.sum[k], `summary.${k} as today`);
  }
  assert.equal(a.sum.skippedNoMesh, 2);
  const missA = a.r.scene3d.cellContainers3d.get(CELL_A).userData.missingStaticDids;
  const missO = o.r.scene3d.cellContainers3d.get(CELL_A).userData.missingStaticDids;
  assert.deepEqual(missA, missO, "per-cell geom-audit stamps as today");
  assert.deepEqual(missA, [STAB_A, STAB_B]);
  const pick = (w) => w.filter((x) => x.includes("fetch_model_meshes (cell statics) failed") || x.startsWith("[geom-audit]"));
  assert.deepEqual(pick(a.warns), pick(o.warns), "same warnings");
  assert.equal(pick(a.warns).length, 2);
  assert.equal(a.r.scene3d.envCellLoadedLbs.has(LB), true, "LB built (as today)");
  assert.equal(a.r.scene3d.envCellBuildInFlight.has(LB), false);
});

// Geometries one successful ON build creates and disposes internally (G) and
// hands to the LRU (K), measured with the same rig; a cancelled build must
// dispose exactly G + K.
const disposedDuring = async (fn) => {
  const orig = THREE.BufferGeometry.prototype.dispose;
  const seen = new Set();
  THREE.BufferGeometry.prototype.dispose = function () { seen.add(this); return orig.call(this); };
  try { await fn(); } finally { THREE.BufferGeometry.prototype.dispose = orig; }
  return seen;
};
let refK = -1;
const refG = (await disposedDuring(quiet(async () => {
  const r = rig({ mm: "now" });
  const sum = await on.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm);
  refK = sum.disposables.geometries.length;
}))).size;

await t("W4 ON: evicted between walls and statics → nothing attached, all geometry disposed, clean rebuild", quiet(async () => {
  let wallsGeom = null;
  let r;
  let sum;
  const disposed = await disposedDuring(async () => {
    r = rig();
    const b = tracked(on.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm));
    await settle();
    const cA = r.scene3d.cellContainers3d.get(CELL_A);
    wallsGeom = meshGroupOf(cA).children[0].geometry;
    r.scene3d.landblockLru.evict(LB);
    r.mmGate.resolve();
    sum = await b.p;
    assert.equal(statics(cA).length, 0, "no statics attached to the evicted walls");
    assert.equal(cA.parent, null);
  });
  const s = r.scene3d;
  assert.equal(sum.evictedDuringBuild, true);
  assert.equal(sum.cellCount, 0);
  assert.equal(s.cellsGroup.children.length, 0);
  assert.equal(s.cellContainers3d.size, 0);
  assert.equal(s.envCellLoadedLbs.has(LB), false);
  assert.ok(disposed.has(wallsGeom), "walls geometry disposed");
  assert.ok(refK > 0);
  assert.equal(disposed.size, refG + refK, "every geometry the build made was disposed");
  assert.ok(r.handed.length === 2 && r.handed.every((m) => m.freed === 1), "wasm meshes freed once");
  // Re-approach: a fresh build attaches exactly one set.
  const r2 = rig({ scene: { scene3d: s, compiles: [] }, mm: "now" });
  const sum2 = await on.buildEnvCellsForLandblock(s, LB, r2.wasm);
  assert.equal(sum2.cellCount, 2);
  assert.equal(s.cellsGroup.children.length, 2, "no orphans");
  assert.equal(statics(s.cellContainers3d.get(CELL_A)).length, 2);
  assert.equal(s.envCellLoadedLbs.has(LB), true);
}));

await t("W5 ON: parked between walls and statics → walls leave the stash, unpark re-attaches nothing", quiet(async () => {
  const r = rig();
  const s = r.scene3d;
  const b = tracked(on.buildEnvCellsForLandblock(s, LB, r.wasm));
  await settle();
  const cA = s.cellContainers3d.get(CELL_A);
  s.landblockLru.park(LB);
  assert.equal(s.landblockLru.parkPool.get(LB).cells.length, 2, "park stashed the walls");
  r.mmGate.resolve();
  const sum = await b.p;
  assert.equal(sum.evictedDuringBuild, true);
  assert.equal(s.landblockLru.parkPool.get(LB).cells.length, 0, "stash emptied of this build's walls");
  assert.equal(statics(cA).length, 0);
  s.landblockLru.unpark(LB);
  assert.equal(s.cellsGroup.children.length, 0, "unpark re-attached nothing");
  assert.equal(s.cellContainers3d.size, 0);
  assert.equal(s.envCellLoadedLbs.has(LB), false, "LB not built → rebuilt on return");
}));

await t("W6 ON: park → unpark → new build: old walls detached, old build cancels, new one completes", quiet(async () => {
  const r1 = rig();
  const s = r1.scene3d;
  const b1 = tracked(on.buildEnvCellsForLandblock(s, LB, r1.wasm));
  await settle();
  const old = s.cellContainers3d.get(CELL_A);
  s.landblockLru.park(LB);
  s.landblockLru.unpark(LB); // before the old build notices its cancel
  assert.equal(s.cellContainers3d.get(CELL_A), old);
  const r2 = rig({ scene: { scene3d: s, compiles: [] } });
  const b2 = tracked(on.buildEnvCellsForLandblock(s, LB, r2.wasm));
  await settle();
  const neu = s.cellContainers3d.get(CELL_A);
  assert.notEqual(neu, old, "the new build registered its own walls");
  assert.equal(old.parent, null, "stale walls detached");
  assert.equal(s.cellsGroup.children.length, 2, "one set of walls drawn");
  r1.mmGate.resolve();
  const sum1 = await b1.p;
  assert.equal(sum1.evictedDuringBuild, true);
  assert.equal(s.cellContainers3d.get(CELL_A), neu, "the new build's registration untouched");
  assert.equal(neu.parent, s.cellsGroup);
  assert.equal(s.envCellBuildInFlight.has(LB), true, "the old build's finally kept the new marker");
  assert.equal(b2.done, false);
  r2.mmGate.resolve();
  const sum2 = await b2.p;
  assert.equal(sum2.staticObjectCount, 2);
  assert.equal(statics(neu).length, 2);
  assert.equal(statics(old).length, 0);
  assert.equal(s.cellsGroup.children.length, 2);
  assert.equal(s.envCellLoadedLbs.has(LB), true);
  assert.equal(s.envCellBuildInFlight.has(LB), false);
}));

await t("W12 ON: park → NEW build attaches its walls → unpark: the stale walls stay out of the registry; the new build completes registered", quiet(async () => {
  const r1 = rig();
  const s = r1.scene3d;
  const b1 = tracked(on.buildEnvCellsForLandblock(s, LB, r1.wasm));
  await settle();
  const old = s.cellContainers3d.get(CELL_A);
  s.landblockLru.park(LB); // stashes the old build's walls-only containers
  const r2 = rig({ scene: { scene3d: s, compiles: [] } });
  const b2 = tracked(on.buildEnvCellsForLandblock(s, LB, r2.wasm));
  await settle();
  const neu = s.cellContainers3d.get(CELL_A);
  assert.ok(neu && neu !== old && neu.parent === s.cellsGroup, "the new build's walls are up");
  assert.equal(s.landblockLru.parkPool.get(LB).cells.length, 0, "the new build's attach emptied the stale stash");
  s.landblockLru.unpark(LB); // e.g. the terrain fast path / residency grid, AFTER the new walls
  assert.equal(s.cellContainers3d.get(CELL_A), neu, "unpark did not re-register the stale walls over the new ones");
  assert.equal(old.parent, null, "stale walls not re-attached");
  assert.equal(s.cellsGroup.children.length, 2, "one set of walls drawn");
  r1.mmGate.resolve();
  const sum1 = await b1.p;
  assert.equal(sum1.evictedDuringBuild, true);
  assert.equal(s.cellContainers3d.get(CELL_A), neu, "the old build's cancel left the new registration alone");
  r2.mmGate.resolve();
  const sum2 = await b2.p;
  assert.equal(sum2.staticObjectCount, 2);
  assert.equal(s.cellContainers3d.get(CELL_A), neu, "the built landblock's cells are registered");
  assert.equal(s.cellContainers3d.get(CELL_B)?.parent, s.cellsGroup);
  assert.equal(statics(neu).length, 2);
  assert.equal(s.cellsGroup.children.length, 2, "no orphan containers");
  assert.equal(s.envCellLoadedLbs.has(LB), true);
}));

await t("W7 ON: unexpected throw after the walls attached → walls removed, rejects, same end state as =off", async () => {
  const run = async (mod) => quiet(async () => {
    const r = rig({ mm: "bad" });
    const b = tracked(mod.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm));
    b.p.catch(() => {});
    await settle();
    const early = r.scene3d.cellsGroup.children.length;
    r.mmGate.resolve();
    await settle();
    return { r, b, early };
  })();
  const a = await run(on);
  const o = await run(off);
  assert.equal(a.early, 2, "ON: walls were up");
  assert.equal(o.early, 0);
  for (const x of [a, o]) {
    const s = x.r.scene3d;
    assert.equal(x.b.done, true);
    assert.match(String(x.b.error?.message), /surfaces boom/, "the build rejects with the error");
    assert.equal(s.cellsGroup.children.length, 0, "nothing attached");
    assert.equal(s.cellContainers3d.size, 0, "nothing registered");
    assert.equal(s.envCellLoadedLbs.has(LB), false, "not built → retried");
    assert.equal(s.envCellBuildInFlight.has(LB), false, "in-flight released");
  }
});

await t("W8 ON: no cell statics → single-stage path, same sequence as =off", quiet(async () => {
  const cells = [[CELL_A, []], [CELL_B, []]];
  const a = rig({ cells, mm: "now" });
  const sa = await on.buildEnvCellsForLandblock(a.scene3d, LB, a.wasm);
  const o = rig({ cells, mm: "now" });
  const so = await off.buildEnvCellsForLandblock(o.scene3d, LB, o.wasm);
  assert.deepEqual(a.log, o.log);
  assert.equal(sa.wallsFirst, undefined);
  assert.deepEqual(Object.keys(sa).sort(), Object.keys(so).sort());
  assert.equal(sa.cellCount, 2);
  assert.equal(a.compiles.length, 1);
}));

await t("W9 ?interiorWallsFirst=off: nothing attached until Step C settles; one prewarm", quiet(async () => {
  const r = rig();
  const b = tracked(off.buildEnvCellsForLandblock(r.scene3d, LB, r.wasm));
  await settle();
  assert.equal(r.scene3d.cellsGroup.children.length, 0);
  assert.equal(r.scene3d.cellContainers3d.size, 0);
  assert.equal(r.compiles.length, 0);
  r.mmGate.resolve();
  const sum = await b.p;
  assert.equal(sum.wallsFirst, undefined);
  assert.equal(sum.staticObjectCount, 2);
  assert.equal(r.compiles.length, 1, "walls + statics in one prewarm");
  assert.ok(r.compiles[0].some((n) => n.startsWith("cellstatic-")) && r.compiles[0].some((n) => !n.startsWith("cellstatic-")));
  assert.equal(statics(r.scene3d.cellContainers3d.get(CELL_A)).length, 2);
  assert.equal(r.scene3d.envCellLoadedLbs.has(LB), true);
}));

await t("W10 ON: the REAL LandblockLRU — park mid-way empties its stash of the walls; evict mid-way leaves nothing", quiet(async () => {
  const { LandblockLRU } = await import("../scene3d/landblock_lru.js");
  // park
  {
    const r = rig();
    const s = r.scene3d;
    const lru = new LandblockLRU({ scene3d: s, maxResident: 64, getCurrentLbId: () => 0 });
    s.landblockLru = lru;
    lru.track(LB); // the LB is resident (terrain / an in-flight loader call tracked it)
    const b = tracked(on.buildEnvCellsForLandblock(s, LB, r.wasm));
    await settle();
    assert.equal(s.cellsGroup.children.length, 2);
    assert.equal(lru.park(LB), true);
    assert.equal(lru.parkPool.get(LB).cells.length, 2, "landblock_lru park stashed the walls");
    assert.equal(s.envCellBuildGen.has(LB), false, "park cancelled the build (gen)");
    r.mmGate.resolve();
    const sum = await b.p;
    assert.equal(sum.evictedDuringBuild, true);
    assert.equal(lru.parkPool.get(LB).cells.length, 0, "the walls left the real stash");
    assert.equal(lru.unpark(LB), true);
    assert.equal(s.cellsGroup.children.length, 0, "unpark re-attached nothing");
    assert.equal(s.cellContainers3d.size, 0);
    assert.equal(s.envCellLoadedLbs.has(LB), false, "rebuilt on return");
  }
  // evict
  {
    const r = rig();
    const s = r.scene3d;
    const lru = new LandblockLRU({ scene3d: s, maxResident: 64, getCurrentLbId: () => 0 });
    s.landblockLru = lru;
    lru.track(LB);
    const b = tracked(on.buildEnvCellsForLandblock(s, LB, r.wasm));
    await settle();
    const cA = s.cellContainers3d.get(CELL_A);
    assert.equal(lru.evict(LB), true);
    assert.equal(s.cellsGroup.children.length, 0, "landblock_lru evict removed the walls");
    r.mmGate.resolve();
    const sum = await b.p;
    assert.equal(sum.evictedDuringBuild, true);
    assert.equal(statics(cA).length, 0);
    assert.equal(s.cellsGroup.children.length, 0);
    assert.equal(s.cellContainers3d.size, 0);
    assert.equal(s.envCellLoadedLbs.has(LB), false);
  }
  // park → a NEW build attaches its walls → unpark (W12 through the real LRU)
  {
    const r1 = rig();
    const s = r1.scene3d;
    const lru = new LandblockLRU({ scene3d: s, maxResident: 64, getCurrentLbId: () => 0 });
    s.landblockLru = lru;
    lru.track(LB);
    const b1 = tracked(on.buildEnvCellsForLandblock(s, LB, r1.wasm));
    await settle();
    assert.equal(lru.park(LB), true);
    const r2 = rig({ scene: { scene3d: s, compiles: [] } });
    const b2 = tracked(on.buildEnvCellsForLandblock(s, LB, r2.wasm));
    await settle();
    const neu = s.cellContainers3d.get(CELL_A);
    assert.ok(neu && neu.parent === s.cellsGroup, "the new build's walls are up");
    assert.equal(lru.unpark(LB), true);
    assert.equal(s.cellContainers3d.get(CELL_A), neu, "real unpark did not re-register the stale walls");
    r1.mmGate.resolve();
    assert.equal((await b1.p).evictedDuringBuild, true);
    r2.mmGate.resolve();
    assert.equal((await b2.p).staticObjectCount, 2);
    assert.equal(s.cellContainers3d.get(CELL_A), neu);
    assert.equal(s.cellsGroup.children.length, 2, "no orphan containers");
    assert.equal(statics(neu).length, 2);
    assert.equal(s.envCellLoadedLbs.has(LB), true);
  }
}));

await t("W11 contract: reader, login readiness at walls, docs row", async () => {
  const cells = readFileSync(path.join(APP, "scene3d", "cells.js"), "utf8");
  assert.match(cells, /get\("interiorWallsFirst"\);\s*return !\(v === "off" \|\| v === "0" \|\| v === "false" \|\| v === "no"\);/, "default-on reader, off|0|false|no");
  assert.match(cells, /const wallsFirst = INTERIOR_WALLS_FIRST && staticIds !== null;/, "only builds with statics split");
  // The loaded mark follows the walls-first stage (the statics), never the walls attach.
  const stage = cells.indexOf("// ---- `?interiorWallsFirst` stage 2");
  const mark = cells.indexOf("scene3d.envCellLoadedLbs.add(lbKey);", stage);
  assert.ok(stage > 0 && mark > stage, "envCellLoadedLbs.add after stage 2");
  // portal_space: the login tunnel (and the teleport one) release on the
  // destination cell's container — i.e. at the walls under walls-first.
  const pss = readFileSync(path.join(APP, "scene3d", "portal_space.js"), "utf8");
  const login = pss.slice(pss.indexOf("function computeLoginWorldReady("), pss.indexOf("function computeWorldReady("));
  assert.match(login, /if \(_arrivalCell && destinationCellsReady\(scene3d, _arrivalCell\)\) \{\s*_reason = "cells-ready";\s*return true;/);
  assert.match(pss, /const m = scene3d\?\.cellContainers3d;\s*return m && typeof m\.has === "function" \? m\.has\(id\) : true;/);
  const docs = readFileSync(path.join(APP, "docs", "url-flags.md"), "utf8");
  const row = docs.split("\n").find((l) => l.startsWith("| `interiorWallsFirst` |"));
  assert.ok(row, "url-flags.md row `| \\`interiorWallsFirst\\` |` missing");
  assert.ok(row.includes("| `off`/`0`/`false`/`no` to disable |"), "accepted values column");
  assert.ok(row.includes("tests/interior_walls_first.test.mjs"), "names this test");
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
