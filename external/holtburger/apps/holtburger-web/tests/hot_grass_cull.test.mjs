// tests/hot_grass_cull.test.mjs — lane F2 (2026-10-26): `?hotGrassCull`, the GPU
// grass tile cull with a per-ring zRange memo keyed by the terrain field's
// generation() stamp, and the frustum planes read once per call
// (scene3d/grass_gpu_place.js cullGrassTiles / _cullGrassTilesHot,
// scene3d/terrain_field_gpu.js generation(), scene3d/terrain_grass.js cullRing).
//
// CLAIM: with the flag on, every cull returns the same survivors in the same
// order (the `uGpTiles` value, element by element) and the same count as the
// shipped cull — over a real terrain field whose window walks, whose LBs are
// rebaked and evicted, under ring-window moves, live margins, holes, discs,
// eye positions and frustums of random cameras (three Planes, arrays, holes in
// the plane list, more planes than the hoist holds), with zRange answers that
// are not numbers (read the same number of times), and through the real GPU
// grass provider's per-ring cull (instanceCount included). The stamp changes
// on every walk and dispose, never on a no-op update, and never repeats
// across fields.
//
// Run:   cd apps/holtburger-web && node tests/hot_grass_cull.test.mjs
// Bench: node tests/hot_grass_cull.test.mjs --bench=off   (then --bench=on; one arm per process)

import * as THREE from "three";

globalThis.window = globalThis.window || { location: { search: "" }, addEventListener: () => {}, removeEventListener: () => {} };

const GP = await import("../scene3d/grass_gpu_place.js");
const { createTerrainFieldGpu } = await import("../scene3d/terrain_field_gpu.js");
const { createTerrainOracle } = await import("../scene3d/terrain_oracle.js");
const { lbKeyFromXY } = await import("../scene3d/landblock_lru.js");
const { createTerrainGrassProvider } = await import("../scene3d/terrain_grass.js");
const { cullGrassTiles, createGrassZMemo, __setHotGrassCullForTest, GRASS_GPU_MAX_TILES } = GP;

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

const LBM = 192;
const HX = 0xa9, HY = 0xb4;
function noteLb(o, lbX, lbY, r, opts = {}) {
  const heights = opts.noHeights ? undefined : Float32Array.from({ length: 81 }, () => 40 + r() * 30);
  o.noteLandblock(lbKeyFromXY(lbX, lbY), { codes: new Uint8Array(81).fill(1), heights, roads: new Uint8Array(81), lbX, lbY });
}
function makeOracle(r) {
  const o = createTerrainOracle();
  for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) {
    if (r() < 0.08) continue;                                     // holes in the resident set
    noteLb(o, HX + dx, HY + dy, r, { noHeights: r() < 0.05 });
  }
  return o;
}
const sameOut = (a, b, n) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `slot ${i}: ${a[i]} vs ${b[i]}`; return null; };

// ── [1] unit: shipped vs hot over a real field ───────────────────────────────
check("[1] cullGrassTiles: identical survivors over a walking, rebaked field (6,000 culls)", () => {
  const r = rng(26);
  const o = makeOracle(r);
  const field = createTerrainFieldGpu({ oracle: o });
  const zOut = { min: 0, max: 0 };
  const zRange = (x0, y0, x1, y1) => field.heightRange(x0, y0, x1, y1, zOut);
  const memos = [createGrassZMemo(), createGrassZMemo(), createGrassZMemo()];
  const outA = new Float32Array(64), outB = new Float32Array(64);
  let px = HX * LBM + 96, py = HY * LBM + 96;
  field.update(px, py);
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.5, 400);
  const frustum = new THREE.Frustum(), m = new THREE.Matrix4();
  let hits = 0, culls = 0;
  for (let step = 0; step < 2000; step++) {
    const x = r();
    if (x < 0.1) { px += (r() - 0.5) * 60; py += (r() - 0.5) * 60; field.update(px, py); }        // walks on LB changes
    else if (x < 0.13) { noteLb(o, HX + ((r() * 13) | 0) - 6, HY + ((r() * 13) | 0) - 6, r); field.update(px, py); } // rebake
    else if (x < 0.15) { o.invalidate(lbKeyFromXY(HX + ((r() * 13) | 0) - 6, HY + ((r() * 13) | 0) - 6)); field.update(px, py); }
    else if (x < 0.152) { field.update(NaN, py); }                                                 // no walk
    cam.position.set(px + (r() - 0.5) * 20, py + (r() - 0.5) * 20, 60 + r() * 40);
    cam.up.set(0, 0, 1);
    cam.lookAt(px + (r() - 0.5) * 200, py + (r() - 0.5) * 200, 40 + r() * 20);
    cam.updateMatrixWorld(true);
    m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(m);
    for (let ring = 0; ring < 3; ring++) {
      const cell = [1.25, 2.5, 5][ring];
      const g = [64, 48, 40][ring];
      const ts = Math.ceil(g / 8);
      const winMin = [Math.floor((px - g * cell / 2) / cell), Math.floor((py - g * cell / 2) / cell)];
      const y = r();
      const planes = y < 0.6 ? frustum.planes
        : y < 0.75 ? frustum.planes.map((pl) => [pl.normal.x, pl.normal.y, pl.normal.z, pl.constant])
        : y < 0.85 ? [null, ...frustum.planes.slice(0, 3), null]
        : y < 0.9 ? Array.from({ length: 20 }, (_, k) => frustum.planes[k % 6])             // > the hoist's 16
        : null;
      const p = {
        winMin, g, ts, T: 8, cell, center: [px, py], outerR: g * cell / 2, holeR: ring === 0 ? -1 : (r() < 0.5 ? g * cell / 5 : -1),
        planes, zRange, camPos: r() < 0.8 ? [cam.position.x, cam.position.y, cam.position.z] : null,
        xyMarginM: 2 + r() * 2, zAboveM: 2 + r() * 3,
      };
      __setHotGrassCullForTest(false);
      const nA = cullGrassTiles(p, outA);
      __setHotGrassCullForTest(true);
      const q = { ...p, zMemo: memos[ring], zGen: field.generation() };
      const before = memos[ring].hits;
      const nB = cullGrassTiles(q, outB);
      hits += memos[ring].hits - before;
      culls += 1;
      if (nA !== nB) throw new Error(`step ${step} ring ${ring}: n ${nA} vs ${nB}`);
      const d = sameOut(outA, outB, nA);
      if (d) throw new Error(`step ${step} ring ${ring}: ${d}`);
    }
  }
  __setHotGrassCullForTest(undefined);
  assert(culls === 6000, `culls ${culls}`);
  assert(hits > culls * 20, `the memo answered only ${hits} tiles over ${culls} culls`);
});

// ── [2] answers that are not numbers: no caching, the same reads ─────────────
check("[2] non-number zRange answers: same survivors, same valueOf / getter calls, nothing cached", () => {
  let readsA = 0, readsB = 0;
  const mk = (tag) => (x0, y0) => {
    const v = { valueOf() { if (tag === "A") readsA++; else readsB++; return 40 + (x0 % 7); } };
    return x0 % 3 === 0 ? null : { get min() { return v; }, max: 70 + (y0 % 5) };
  };
  const zA = mk("A"), zB = mk("B");
  const base = { winMin: [100, 200], g: 40, ts: 5, T: 8, cell: 2.5, center: [300, 550], outerR: 50, holeR: -1, planes: null, camPos: [300, 550, 80] };
  const memo = createGrassZMemo();
  const outA = new Float32Array(64), outB = new Float32Array(64);
  for (let i = 0; i < 5; i++) {
    __setHotGrassCullForTest(false);
    const nA = cullGrassTiles({ ...base, zRange: zA }, outA);
    __setHotGrassCullForTest(true);
    const nB = cullGrassTiles({ ...base, zRange: zB, zMemo: memo, zGen: 7 }, outB);
    assert(nA === nB && !sameOut(outA, outB), `pass ${i}: ${nA} vs ${nB}`);
  }
  __setHotGrassCullForTest(undefined);
  assert(readsA === readsB && readsA > 0, `valueOf calls ${readsA} vs ${readsB}`);
  assert(memo.state.every((s) => s !== 2), "a non-number answer was cached");
});

// ── [3] the stamp ────────────────────────────────────────────────────────────
check("[3] field.generation(): new on every walk and dispose, unchanged by a no-op update, unique across fields", () => {
  const r = rng(3);
  const o = makeOracle(r);
  const f1 = createTerrainFieldGpu({ oracle: o }), f2 = createTerrainFieldGpu({ oracle: o });
  const seen = new Set([f1.generation(), f2.generation()]);
  assert(seen.size === 2, "two fresh fields share a stamp");
  const px = HX * LBM + 96, py = HY * LBM + 96;
  const g0 = f1.generation();
  f1.update(px, py);
  const g1 = f1.generation();
  assert(g1 !== g0 && !seen.has(g1), "a walk did not move the stamp");
  seen.add(g1);
  f1.update(px + 5, py - 3);                                            // same LB, same oracle version: no walk
  assert(f1.generation() === g1 && f1.stats().walks === 1, "a no-op update moved the stamp");
  f2.update(px, py);
  assert(!seen.has(f2.generation()), "the second field reused a stamp");
  noteLb(o, HX, HY, r);                                                 // oracle version bump -> walk
  f1.update(px + 5, py - 3);
  assert(f1.generation() !== g1 && f1.stats().walks === 2, "a rebake walk did not move the stamp");
  const g2 = f1.generation();
  f1.dispose();
  assert(f1.generation() !== g2 && f1.heightRange(px, py, px + 1, py + 1) === null, "dispose did not move the stamp");
});

// ── [4] the real GPU grass provider: every ring's cull, flag off vs on ───────
const ULTRA = { blades: 119716, radiusM: 40, reach: 5 };
const BASE = { density: 1, stomp: false, offRoad: true };
function makeCtx(x, y, z, oracle) {
  return { scene3d: null, tSec: 1.25, dt: 0.016, hasPlayer: true, camera: null, quality: null, playerPos: { x, y, z }, oracle, trail: null };
}
function makeProvider(o) {
  const p = createTerrainGrassProvider({ THREE, parent: new THREE.Group(), config: { ...BASE, ...ULTRA, gpu: true } });
  return p;
}
check("[4] the real provider: every ring's uGpTiles and instanceCount identical, flag off vs on (1,200 frames)", () => {
  const r = rng(77);
  const o = makeOracle(r);
  const A = makeProvider(o), B = makeProvider(o);
  let px = HX * LBM + 96, py = HY * LBM + 96, pz = 70;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.3, 1000);
  let compared = 0, hits = 0;
  for (let f = 0; f < 1200; f++) {
    if (r() < 0.05) { px += (r() - 0.5) * 300; py += (r() - 0.5) * 300; }
    else { px += (r() - 0.5) * 2; py += (r() - 0.5) * 2; }
    if (r() < 0.02) noteLb(o, HX + ((r() * 13) | 0) - 6, HY + ((r() * 13) | 0) - 6, r);
    if (r() < 0.01) { const look = { blend: r() < 0.5 ? 0.9 : 0.6 }; A.setLodLook(look); B.setLodLook(look); }
    A.update(0.016, makeCtx(px, py, pz, o));
    B.update(0.016, makeCtx(px, py, pz, o));
    cam.position.set(px + (r() - 0.5) * 6, py - 8 + (r() - 0.5) * 6, pz + 3 + r() * 4);
    cam.up.set(0, 0, 1);
    cam.lookAt(px + (r() - 0.5) * 40, py + 20 + (r() - 0.5) * 40, pz - 2);
    cam.updateMatrixWorld(true);
    const passes = r() < 0.2 ? 2 : 1;                                   // a second pass with the same camera
    for (let pass = 0; pass < passes; pass++) {
      for (let k = 0; k < A._meshes.length; k++) {
        const ma = A._meshes[k], mb = B._meshes[k];
        __setHotGrassCullForTest(false);
        ma.onBeforeRender(null, scene, cam, ma.geometry, ma.material);
        __setHotGrassCullForTest(true);
        mb.onBeforeRender(null, scene, cam, mb.geometry, mb.material);
        const ta = A._ringStates[k].tileIds, tb = B._ringStates[k].tileIds;
        const d = sameOut(ta, tb);
        if (d || ma.geometry.instanceCount !== mb.geometry.instanceCount) {
          throw new Error(`frame ${f} ring ${k}: ${d || `instanceCount ${ma.geometry.instanceCount} vs ${mb.geometry.instanceCount}`}`);
        }
        compared += 1;
      }
    }
  }
  __setHotGrassCullForTest(undefined);
  assert(compared >= 4800, `compared ${compared}`);
  A.dispose(); B.dispose();
});

{
  const { __setRustFlagForTest, rustFlag } = await import("../scene3d/rust/scene_core.js");
  __setRustFlagForTest("hotGrassCull", undefined);
  check("[5] ?hotGrassCull defaults OFF (rustFlag reader, no query)", () => assert(rustFlag("hotGrassCull", false) === false, "default must be off"));
}

// ── bench: the provider's four ring culls per frame, one arm per process ─────
const BENCH_ARM = (process.argv.find((a) => a.startsWith("--bench=")) || "").slice(8);
if (BENCH_ARM) {
  __setHotGrassCullForTest(BENCH_ARM === "on");
  const r = rng(5);
  const o = makeOracle(r);
  const P = makeProvider(o);
  let px = HX * LBM + 96, py = HY * LBM + 96;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.3, 1000);
  P.update(0.016, makeCtx(px, py, 70, o));
  const frame = (i) => {
    px += 0.08; py += 0.05;                                             // running: the windows move every few frames
    P.update(0.016, makeCtx(px, py, 70, o));
    cam.position.set(px, py - 8, 74);
    cam.up.set(0, 0, 1);
    cam.lookAt(px + Math.sin(i * 0.01) * 20, py + 20, 68);
    cam.updateMatrixWorld(true);
    for (const mesh of P._meshes) mesh.onBeforeRender(null, scene, cam, mesh.geometry, mesh.material);
  };
  for (let i = 0; i < 2000; i++) frame(i);
  let best = Infinity;
  for (let round = 0; round < 5; round++) {
    const N = 3000, t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) frame(i);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / N / 1000);
  }
  // the cull alone (no provider update): four rings, a moving camera
  let bestCull = Infinity;
  for (let round = 0; round < 5; round++) {
    const N = 3000, t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      cam.lookAt(px + Math.sin(i * 0.01) * 20, py + 20, 68);
      cam.updateMatrixWorld(true);
      for (const mesh of P._meshes) mesh.onBeforeRender(null, scene, cam, mesh.geometry, mesh.material);
    }
    bestCull = Math.min(bestCull, Number(process.hrtime.bigint() - t0) / N / 1000);
  }
  console.log(`  bench ${BENCH_ARM === "on" ? "?hotGrassCull=on" : "shipped         "}: 4 ring culls ${bestCull.toFixed(2)} us/frame; with the provider tick ${best.toFixed(2)} us/frame`);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
