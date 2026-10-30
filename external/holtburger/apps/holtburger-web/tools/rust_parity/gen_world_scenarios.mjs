// tools/rust_parity/gen_world_scenarios.mjs — scripted worlds for lane W
// (`?rustWorld` shadow mode, docs/2026-10-26-rust-world.md), driven through the
// REAL producers in node with three headless (the harness/test_draw_pools.mjs
// shape): static_batch_x.js chunk buckets, static_atlas.js atlas buckets,
// pool_registry.js pools, buildings.js building batches, landblock_lru.js,
// object_radius.js, residency_grid.js SlotGrid + GridResidencyAdapter.
//
// Used by tests/rust_world_shadow.test.mjs (audit every checkpoint with the JS
// model and, when built, the compiled SceneWorld; compare the armed run's JS
// state with a disarmed run's) and by tools/rust_parity/gen_world.mjs (the
// cargo fixtures crates/holtburger-scene/tests/fixtures/world_*.json).
//
// A scenario is `async (W) => void`: it builds its world from `W.M` (the
// modules) and calls `W.checkpoint(label, state)` at points worth auditing;
// `state()` returns the JS-side truth as a plain object (instance tables,
// matrices, LRU / grid / pool / objRadius state), compared armed vs disarmed.

import * as THREE from "three";
import { inputRng } from "./fixture_util.mjs";

// The producers read window / location at module load (flags, diag hooks).
globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};
globalThis.location ??= globalThis.window.location;

let _M = null;
/** The real modules (loaded once). */
export async function loadModules() {
  if (_M) return _M;
  const { applyBatchedMeshColorTextureFix } = await import("../../scene3d/three_batchedmesh_colortexture_fix.js");
  applyBatchedMeshColorTextureFix(THREE);
  _M = {
    THREE,
    world: await import("../../scene3d/rust/world.js"),
    SBX: await import("../../scene3d/static_batch_x.js"),
    atlas: await import("../../scene3d/static_atlas.js"),
    B: await import("../../scene3d/buildings.js"),
    pools: await import("../../scene3d/pool_registry.js"),
    lruMod: await import("../../scene3d/landblock_lru.js"),
    objR: await import("../../scene3d/object_radius.js"),
    grid: await import("../../scene3d/residency_grid.js"),
  };
  return _M;
}

const lb = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;
const M_PER_LB = 192;

// ── content ───────────────────────────────────────────────────────────────

function triGeom(scale = 1, seed = 0) {
  const g = new THREE.BufferGeometry();
  const p = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 1, 1, 1].map((v, i) => v * scale + (i % 3 === 0 ? seed * 0.125 : 0));
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(p), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(15).fill(0.5), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(10).fill(0.25), 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 1, 3, 4]);
  g.computeBoundingSphere();
  return g;
}

function quadGeom(seed = 0) {
  const p = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0].map((v, i) => (i % 3 === 2 ? seed * 0.0625 : v));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(p), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), 2));
  return g;
}

function dataTex(seed, w = 64, h = 64) {
  const d = new Uint8Array(w * h * 4).fill(seed & 0xff);
  d[1] = (seed >> 8) & 0xff;
  const t = new THREE.DataTexture(d, w, h, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/** A static node at a deterministic placement inside landblock `key`. */
function placeNode(geom, mat, key, i, rnd, extra = {}) {
  const m = new THREE.Mesh(geom, mat);
  const ox = ((key >>> 24) & 0xff) * M_PER_LB;
  const oy = ((key >>> 16) & 0xff) * M_PER_LB;
  m.position.set(ox + 8 + rnd() * 176, oy + 8 + rnd() * 176, rnd() * 12 - 2);
  if (i % 3 === 0) m.quaternion.setFromEuler(new THREE.Euler(0.11 * rnd(), -0.07 * rnd(), rnd() * 6.283)).normalize();
  else m.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rnd() * 6.283);
  const s = i % 4 === 1 ? 0.5 + rnd() : 1;
  m.scale.set(s, s, s);
  m.userData = { landblockId: (key | (1 + (i & 0xff))) >>> 0, surfaceDid: 0x08000100 + (i & 7), ...extra };
  return m;
}

// ── JS-side truth (compared armed vs disarmed) ─────────────────────────────

function bmState(bm) {
  const info = bm._instanceInfo.map((x) => [x.active ? 1 : 0, x.visible ? 1 : 0, x.geometryIndex]);
  const mats = [];
  const d = bm._matricesTexture ? bm._matricesTexture.image.data : null;
  if (d) bm._instanceInfo.forEach((x, i) => { if (x.active) mats.push(i, ...Array.from(d.subarray(i * 16, i * 16 + 16))); });
  const geoms = bm._geometryInfo.map((g) => [g.active ? 1 : 0, g.start, g.count]);
  return { name: bm.name, info, mats, geoms, sort: bm.sortObjects, cull: bm.perObjectFrustumCulled, visible: bm.visible };
}

function collectBatches(roots, extra = []) {
  const seen = new Set();
  const out = [];
  const add = (o) => { if (o && o.isBatchedMesh && !seen.has(o)) { seen.add(o); out.push(o); } };
  for (const r of roots) if (r) r.traverse(add);
  for (const o of extra) add(o);
  return out.map(bmState).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function lruState(lru) {
  return { live: [...lru.entries.keys()].sort((a, b) => a - b), parked: [...lru.parkPool.keys()].sort((a, b) => a - b) };
}

function regState(reg) {
  const tiles = [];
  for (const [tile, byTile] of reg.tiles) {
    for (const [pk, mem] of byTile) tiles.push([tile, pk, mem.live, [...mem.instanceIds], mem.hiddenCells ? [...mem.hiddenCells].sort((a, b) => a - b) : []]);
  }
  return { parked: [...reg._parkedTiles].sort((a, b) => a - b), hidden: [...reg._hiddenLbs].sort((a, b) => a - b), tiles };
}

// ── scenarios ─────────────────────────────────────────────────────────────

function sceneShell() {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group(); worldRoot.name = "worldRoot"; worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const terrainGroup = new THREE.Group(); terrainGroup.name = "terrain";
  const buildingsGroup = new THREE.Group(); buildingsGroup.name = "buildings";
  const staticsGroup = new THREE.Group(); staticsGroup.name = "statics";
  const cellsGroup = new THREE.Group(); cellsGroup.name = "cells";
  const entitiesGroup = new THREE.Group(); entitiesGroup.name = "entities";
  worldRoot.add(terrainGroup, buildingsGroup, staticsGroup, cellsGroup, entitiesGroup);
  return {
    scene, worldRoot, terrainGroup, buildingsGroup, staticsGroup, cellsGroup, entitiesGroup,
    staticsBakedLbs: new Set(), buildingsBakedLbs: new Set(), envCellLoadedLbs: new Set(),
    activeLights: [], terrainMaterials: [], wireframeMode: false,
  };
}

/** Wire the facades index.js installs on liveScene3d. */
function wireFacades(M, s3, lru) {
  s3.landblockLru = lru;
  s3._parkStaticAtlasForLb = M.atlas.parkStaticAtlasForLb;
  s3._unparkStaticAtlasForLb = M.atlas.unparkStaticAtlasForLb;
  s3._evictStaticAtlasForLb = M.atlas.evictStaticAtlasForLb;
  s3._evictStaticBatchXForLb = M.SBX.evictStaticBatchXForLb;
  s3._parkStaticBatchXForLb = M.SBX.parkStaticBatchXForLb;
  s3._unparkStaticBatchXForLb = M.SBX.unparkStaticBatchXForLb;
  s3._objRadiusAfterUnpark = (k) => M.objR.afterUnpark(s3, k);
}

function resetModules(M) {
  M.SBX.__setStatBatchChunkForTest(true);
  M.SBX.__resetStatBatchXForTest();
  M.atlas._resetStatAtlasForTest();
  M.objR.__resetObjectRadiusStatsForTest();
  M.objR.__setObjRadiusForTest(undefined);
}

/**
 * Chunk buckets (static_batch_x.js): feeds across two 3x3-LB regions (a
 * value-merged material pair, a 270-instance group that grows the bucket past
 * its 256-instance first allocation), LRU park / unpark / evict / disposeParked,
 * ?objRadius hide / show / afterUnpark / afterObjectBake / forget, a re-feed of a
 * PARKED, hidden landblock (the late-track merge re-applies the park hide), the
 * optimize tick and bucket reaping. `dedup` runs it under ?statGeomDedup.
 */
function chunkScenario(dedup) {
  return async (W) => {
    const { M } = W;
    resetModules(M);
    M.SBX.__setStatGeomDedupForTest(dedup);
    const rnd = inputRng(dedup ? 11 : 7);
    const s3 = sceneShell();
    const lru = new M.lruMod.LandblockLRU({ scene3d: s3, maxResident: 64 });
    wireFacades(M, s3, lru);
    const mats = [
      new THREE.MeshStandardMaterial({ color: 0x808080 }),
      new THREE.MeshStandardMaterial({ color: 0x408040 }),
      new THREE.MeshStandardMaterial({ color: 0x808080 }), // equal by value to mats[0]: ?statBatchValueKey merges
      new THREE.MeshStandardMaterial({ color: 0x203040, roughness: 0.3 }),
    ];
    const geoms = [triGeom(1, 0), triGeom(0.5, 1), triGeom(2, 2), triGeom(1.5, 3)];
    // statics.js fetchPrimaryGeometries stamps the content key at decode (a no-op with the flag off);
    // clones below copy the stamp, which is the cross-object share the dedup exists for.
    geoms.forEach((g, i) => M.SBX.stampStaticContentKeys(0x01000200 + i, [{ geometry: g, surfaceDid: 0x08000200 + i, doubleSided: true }]));
    const L1 = lb(0xa2, 0x1e), L2 = lb(0xa3, 0x1e), L3 = lb(0xa6, 0x1e), L4 = lb(0xa2, 0x21);
    const feed = (key, spec) => {
      const nodes = [];
      let i = 0;
      for (const [mi, gi, count] of spec) {
        for (let k = 0; k < count; k++) {
          // Two geometry OBJECTS per model per feed (decode-per-LB), same bytes.
          const g = k % 5 === 4 ? geoms[gi].clone() : geoms[gi];
          nodes.push(placeNode(g, mats[mi], key, i++, rnd));
        }
      }
      const r = M.SBX.consolidateStaticSingletonsCrossLb(nodes, s3, key);
      if (r) for (const n of r.out) s3.staticsGroup.add(n); // loners stay nodes (statics.js attaches them)
      s3.staticsBakedLbs.add(key);
      lru.track(key);
      return r;
    };
    const state = () => ({
      batches: collectBatches([s3.staticsGroup]),
      lru: lruState(lru),
      objr: s3._objRadius ? [...s3._objRadius.hidden].sort((a, b) => a - b) : null,
    });
    feed(L1, [[0, 0, 6], [1, 1, 270], [2, 2, 3], [3, 3, 1]]);
    feed(L2, [[0, 0, 4], [1, 2, 3], [3, 3, 2]]);
    feed(L3, [[0, 1, 5], [3, 0, 4]]);
    feed(L4, [[1, 0, 3], [2, 3, 3]]);
    await W.checkpoint("fed four landblocks over two regions", state);
    lru.park(L2);
    await W.checkpoint("park L2 (warm park hides its bucket instances)", state);
    M.objR.__setObjRadiusForTest(1);
    M.objR.tickObjectRadius(s3, new Set([L1]));
    await W.checkpoint("objRadius 1 around L1 hides L3 + L4", state);
    lru.unpark(L2);
    await W.checkpoint("unpark L2 (afterUnpark: not hidden)", state);
    lru.park(L4);
    // A late re-bake of the PARKED, hidden L4: the feed excises its old
    // contribution and adds VISIBLE instances; the track merges into the parked
    // copy and re-applies the park hide; afterObjectBake re-hides.
    feed(L4, [[1, 0, 2], [3, 1, 3]]);
    await W.checkpoint("late re-bake of parked L4 + track merge", state);
    M.objR.afterObjectBake(s3, L4);
    await W.checkpoint("afterObjectBake(L4)", state);
    M.objR.tickObjectRadius(s3, new Set([L4]));
    await W.checkpoint("centre moves to L4: L4 shows (still parked), L1/L2 hide", state);
    lru.unpark(L4);
    await W.checkpoint("unpark L4", state);
    lru.unpark(L4); // not parked: a no-op
    lru.evict(L1);
    await W.checkpoint("evict L1 (excise, reap emptied buckets)", state);
    M.SBX.tickStatBatchXOptimize();
    await W.checkpoint("optimize tick", state);
    lru.park(L3);
    lru.disposeParked(L3);
    s3.staticsBakedLbs.delete(L3);
    await W.checkpoint("disposeParked L3", state);
    s3.staticsBakedLbs.delete(L1);
    M.objR.tickObjectRadius(s3, new Set([L2]));
    await W.checkpoint("objRadius forgets evicted landblocks", state);
    lru.dispose();
    M.SBX.tickStatBatchXOptimize();
    await W.checkpoint("LRU teardown", state);
  };
}

/** Atlas buckets (static_atlas.js): feed, park / unpark, objRadius, evict, optimize, growth. */
async function atlasScenario(W) {
  const { M } = W;
  resetModules(M);
  const rnd = inputRng(23);
  const s3 = sceneShell();
  const lru = new M.lruMod.LandblockLRU({ scene3d: s3, maxResident: 64 });
  wireFacades(M, s3, lru);
  const texes = Array.from({ length: 6 }, (_, i) => dataTex(40 + i));
  const L1 = lb(0x50, 0x50), L2 = lb(0x51, 0x50), L3 = lb(0x55, 0x50);
  const feed = (key, n, seed0) => {
    const nodes = [];
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshStandardMaterial({ map: texes[(seed0 + i) % texes.length] });
      nodes.push(placeNode(quadGeom(i % 3), mat, key, i, rnd));
    }
    const { passthrough } = M.atlas.addSingletonsToCrossLbAtlas(nodes, s3);
    for (const p of passthrough) s3.staticsGroup.add(p);
    s3.staticsBakedLbs.add(key);
    lru.track(key);
  };
  const state = () => ({
    batches: collectBatches([s3.staticsGroup]),
    lru: lruState(lru),
    objr: s3._objRadius ? [...s3._objRadius.hidden].sort((a, b) => a - b) : null,
  });
  feed(L1, 9, 0);
  feed(L2, 7, 2);
  feed(L3, 300, 1); // grows past the bucket's first instance allocation
  await W.checkpoint("atlas fed", state);
  lru.park(L1);
  await W.checkpoint("park L1", state);
  M.objR.__setObjRadiusForTest(1);
  M.objR.tickObjectRadius(s3, new Set([L1]));
  await W.checkpoint("objRadius hides L3", state);
  lru.unpark(L1);
  await W.checkpoint("unpark L1", state);
  lru.evict(L2);
  M.atlas.tickStatAtlasOptimize();
  await W.checkpoint("evict L2 + optimize", state);
  M.objR.tickObjectRadius(s3, new Set([L3]));
  await W.checkpoint("centre L3: shows L3, hides L1", state);
  lru.dispose();
  M.atlas.tickStatAtlasOptimize();
  await W.checkpoint("teardown", state);
}

/** Building batches (buildings.js consolidateBuildingSurfaces): built, parked (detached), unparked, evicted (disposed). */
async function buildingScenario(W) {
  const { M } = W;
  resetModules(M);
  const rnd = inputRng(31);
  const s3 = sceneShell();
  const lru = new M.lruMod.LandblockLRU({ scene3d: s3, maxResident: 64 });
  wireFacades(M, s3, lru);
  const L1 = lb(0x60, 0x61), L2 = lb(0x61, 0x61);
  const bmatA = new THREE.MeshStandardMaterial({ color: 0x777777 });
  const bmatB = new THREE.MeshStandardMaterial({ color: 0x775533 });
  const g = [triGeom(2, 0), triGeom(3, 1)];
  const bake = (key) => {
    const nodes = [];
    for (let i = 0; i < 9; i++) {
      const n = placeNode(g[i % 2], i < 5 ? bmatA : (i < 8 ? bmatB : new THREE.MeshStandardMaterial()), key, i, rnd);
      n.userData.landblockId = (key | 0xfffe) >>> 0;
      nodes.push(n);
    }
    for (const n of M.B.consolidateBuildingSurfaces(nodes).out) s3.buildingsGroup.add(n);
    s3.buildingsBakedLbs.add(key);
    lru.track(key);
  };
  const state = () => ({ batches: collectBatches([s3.buildingsGroup]), lru: lruState(lru) });
  bake(L1);
  bake(L2);
  await W.checkpoint("buildings baked", state);
  lru.park(L1);
  await W.checkpoint("park L1 (batches detached whole)", state);
  lru.unpark(L1);
  lru.evict(L2);
  await W.checkpoint("unpark L1, evict L2 (dispose)", state);
  lru.dispose();
  await W.checkpoint("teardown", state);
}

/**
 * Pools (pool_registry.js), the whole registry surface: stage-A feeds, a
 * stage-B style plan parked mid-feed (commit INTO the parked state), adopt,
 * sticky landblock hides across commit / park / adopt, both cell-PVS forms,
 * band swaps, a cell release that empties a record, abandon, tile release with
 * optimize and reap, a parked mark on a non-resident tile, registry dispose.
 */
async function poolScenario(W) {
  const { M } = W;
  resetModules(M);
  const rnd = inputRng(43);
  const group = new THREE.Group();
  const cells = new THREE.Group();
  const mats = new Map();
  const reg = new M.pools.PoolRegistry({
    THREE, group, groups: { st: group, ec: cells }, layers: { ec: 1 }, warn: () => {},
    materialFactory: (classKey) => {
      const m = new THREE.MeshStandardMaterial();
      m.name = `pool-${classKey}`;
      mats.set(classKey, m);
      return m;
    },
    search: "",
  });
  const made = new Map();
  const geomSource = {
    get(contentKey) {
      let gg = made.get(contentKey);
      if (!gg) { gg = triGeom(1 + made.size * 0.25, made.size); made.set(contentKey, gg); }
      return gg;
    },
  };
  const tileOf = (key) => M.pools.tileKeyOfLbKey(key);
  const LA = lb(0x20, 0x20), LB = lb(0x21, 0x20), LC = lb(0x22, 0x20), LD = lb(0x30, 0x30);
  const T1 = tileOf(LA), T2 = tileOf(LC), T3 = tileOf(LD);
  const C1 = 0x20200101, C2 = 0x20200102, C3 = 0x21200103, C4 = 0x22200104;
  let mid = 0;
  const member = (key, over = {}) => {
    const i = mid++;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(((key >>> 24) & 0xff) * M_PER_LB + rnd() * 190, ((key >>> 16) & 0xff) * M_PER_LB + rnd() * 190, rnd() * 4),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rnd() * 6.28),
      new THREE.Vector3(1, 1, 1));
    return {
      domain: "st", classKey: `st|opaque|c${i % 2}`, passClass: "opaque",
      sectorKey: `s${((key >>> 24) & 0xff) >> 2}x${((key >>> 16) & 0xff) >> 2}`,
      contentKey: `m${i % 3}`, layer: 0, matrix: m.toArray(), rsId: 0x06001000 + (i % 4), lbKey: key,
      ...over,
    };
  };
  const plan = (tile, members) => ({ tile, lbs: [], members, counts: {} });
  const state = () => ({ batches: collectBatches([group, cells]), reg: regState(reg) });

  reg.feedTile(plan(T1, [
    member(LA), member(LA), member(LA), member(LB), member(LB),
    member(LA, { domain: "ec", classKey: "ec|opaque|i0", cellId: C1 }),
    member(LA, { domain: "ec", classKey: "ec|opaque|i0", cellId: C1 }),
    member(LB, { domain: "ec", classKey: "ec|opaque|i0", cellId: C2 }),
    member(LB, { domain: "ec", classKey: "ec|opaque|i0", cellId: C3 }),
    member(LA, { bandGids: ["near0", "far0"], band: 0, pos: { x: 6150, y: 6150, z: 0 } }),
    member(LB, { bandGids: ["near1", "far1"], band: 1, pos: { x: 6400, y: 6200, z: 0 } }),
  ]), geomSource);
  await W.checkpoint("tile T1 fed (stage A)", state);
  // T2's interior member keeps the envcell pool alive when T1's cells are released
  // (so the release has to prune T1's emptied record on its own).
  const job = reg.beginFeed(plan(T2, [member(LC), member(LC), member(LC), member(LC),
    member(LC, { domain: "ec", classKey: "ec|opaque|i0", cellId: C4 })]), geomSource);
  job.step(2);
  reg.parkTile(T2); // the grid parks the tile while its plan is still feeding
  job.step();
  job.commit(); // commits INTO the parked state
  await W.checkpoint("T2 parked mid-feed, committed parked", state);
  reg.adoptTile(T2);
  await W.checkpoint("adopt T2", state);
  reg.hideLb(LA);
  reg.feedTile(plan(T1, [member(LA), member(LB)]), geomSource); // merge into T1's records; LA stays hidden
  await W.checkpoint("hide LA, re-feed T1 (merge)", state);
  reg.parkTile(T1);
  reg.showLb(LA); // parked: nothing shows
  await W.checkpoint("park T1, show LA while parked", state);
  reg.adoptTile(T1);
  await W.checkpoint("adopt T1", state);
  reg.setCellsVisible([C1], false);
  reg.cellSetChanged(T1, new Set([C1]));
  await W.checkpoint("cell PVS: C1 hidden then the full set {C1}", state);
  reg.parkTile(T1);
  reg.setCellsVisible([C2], true); // parked: recorded, no flip
  reg.adoptTile(T1);
  reg.hideLb(LB);
  reg.setCellsVisible([C3], true); // LB hidden: recorded, no flip
  await W.checkpoint("cells across park / adopt and an LB hide", state);
  reg.showLb(LB);
  reg.bandTick({ x: 6150, y: 6150, z: 0 }, 100);
  reg.bandTick({ x: 6900, y: 6900, z: 0 }, 100);
  await W.checkpoint("band swaps", state);
  reg.releaseCells([C1, C3]);
  reg.releaseCells(new Set([C2]));
  await W.checkpoint("release cells (records emptied)", state);
  const job3 = reg.beginFeed(plan(T3, [member(LD), member(LD), member(LD)]), geomSource);
  job3.step();
  job3.abandon();
  await W.checkpoint("abandon a vacated plan", state);
  reg.releaseTile(T1);
  await W.checkpoint("release T1 (deletes, optimize, reap)", state);
  reg.parkTile(T3);
  reg.clearParked(T3);
  reg.parkTile(T2);
  reg.releaseTile(T2);
  await W.checkpoint("park marks on resident and non-resident tiles", state);
  reg.feedTile(plan(T3, [member(LD), member(LD)]), geomSource);
  reg.parkTile(T3); // dispose clears the parked marks (and keeps the landblock hides)
  reg.hideLb(LD);
  reg.dispose();
  await W.checkpoint("registry dispose", state);
}

/**
 * The grid world (residency_grid.js SlotGrid + GridResidencyAdapter,
 * legacy-lane arm), wired the way index.js wires it: feeds bake chunk buckets
 * and pool plans per landblock and track them in a REAL LandblockLRU; the
 * adapter parks / unparks / disposes through the LRU; slot-state events park /
 * adopt / release the pools; ?objRadius runs per crossing. `poolHides` also
 * wires `_poolHideLb` / `_poolShowLb` to the registry (index.js
 * liveScene3d._poolHideLb / _poolShowLb, the chain default); `preFixForget`
 * then drops the show that object_radius.js's forget issues (it clears
 * `st.hidden` first, `_show` after), i.e. the forget as it was before
 * 2026-10-29 — tests only, to prove the audit's poolHideOrphan category sees
 * that drift.
 */
function gridWorld(W, { objRadius = 3, seed = 57, poolHides = false, preFixForget = false } = {}) {
  const { M } = W;
  resetModules(M);
  M.objR.__setObjRadiusForTest(objRadius);
  const rnd = inputRng(seed);
  let t = 1000;
  const now = () => t;
  const s3 = sceneShell();
  const lru = new M.lruMod.LandblockLRU({ scene3d: s3, maxResident: 400 });
  wireFacades(M, s3, lru);
  const group = new THREE.Group();
  s3.staticsGroup.add(group);
  const reg = new M.pools.PoolRegistry({
    THREE, group, warn: () => {}, search: "",
    materialFactory: (k) => { const m = new THREE.MeshStandardMaterial(); m.name = `pool-${k}`; return m; },
  });
  if (poolHides) {
    s3._poolHideLb = (k) => reg.hideLb(k);
    s3._poolShowLb = (k) => (preFixForget && !(s3._objRadius && s3._objRadius.hidden.has(k >>> 0)) ? 0 : reg.showLb(k));
  }
  const geomSource = { get: (ck) => triGeom(1, ck.length) };
  const mats = [new THREE.MeshStandardMaterial({ color: 0x111111 }), new THREE.MeshStandardMaterial({ color: 0x222222 })];
  const G = M.grid;
  const grid = new G.SlotGrid({
    now, warn: () => {},
    onSlotState: (ev) => {
      // pool_producer.js poolOnSlotState, stage A.
      if (ev.to === "PARKED") reg.parkTile(ev.tile);
      else if (ev.to === "LIVE" && ev.from === "PARKED") reg.adoptTile(ev.tile);
      else if (ev.to === "EMPTY") {
        if (!reg.isTileResident(ev.tile)) reg.clearParked(ev.tile);
        else reg.releaseTile(ev.tile);
      }
    },
    onTeleport: (ev) => { for (const tile of ev.vacated) { if (!reg.isTileResident(tile)) reg.clearParked(tile); else reg.releaseTile(tile); } },
  });
  let playerLb = null;
  const feeds = {
    fireLb: (x, y) => {
      const key = lb(x, y);
      if (playerLb !== null && !M.objR.objectBakeAllowed([playerLb], key)) return;
      if (s3.staticsBakedLbs.has(key)) {
        if (lru.isParked(key)) lru.unpark(key);
        return;
      }
      const nodes = [];
      for (let i = 0; i < 5; i++) nodes.push(placeNode(triGeom(1, i % 2), mats[i % 2], key, i, rnd));
      const r = M.SBX.consolidateStaticSingletonsCrossLb(nodes, s3, key);
      if (r) for (const n of r.out) s3.staticsGroup.add(n);
      const tile = G.tileOfLb(x, y);
      const mk = () => ({
        domain: "st", classKey: "st|opaque|g", passClass: "opaque", sectorKey: `s${x >> 2}x${y >> 2}`,
        contentKey: `g${(x + y) % 2}`, layer: 0, lbKey: key,
        matrix: new THREE.Matrix4().makeTranslation(x * M_PER_LB + rnd() * 180, y * M_PER_LB + rnd() * 180, 0).toArray(),
      });
      reg.feedTile({ tile, lbs: [key], members: [mk(), mk()], counts: {} }, geomSource);
      s3.staticsBakedLbs.add(key);
      lru.track(key);
      M.objR.afterObjectBake(s3, key);
    },
  };
  const lruDeps = {
    parkLb: (k) => lru.park(k) === true,
    unparkLb: (k) => lru.unpark(k) === true,
    disposeLb: (k) => {
      let ok = false;
      if (lru.isParked(k)) ok = lru.disposeParked(k) === true;
      else if (lru.entries.has(k)) ok = lru.evict(k) === true;
      if (ok) s3.staticsBakedLbs.delete(k);
      return ok;
    },
    isParkedLb: (k) => lru.isParked(k),
    lbBytes: (k) => 32 * 1024 * 1024,
    touchLb: (k) => lru.touch(k),
  };
  const adapter = new G.GridResidencyAdapter({
    grid, feeds, lru: lruDeps, packs: null, now, warn: () => {},
    bakedPredicate: (tile) => G.tileLbKeys(tile).every((k) => s3.staticsBakedLbs.has(k) || !M.objR.objectBakeAllowed([playerLb], k)),
  });
  const state = () => ({
    batches: collectBatches([s3.staticsGroup]),
    lru: lruState(lru),
    reg: regState(reg),
    grid: [...grid.records].map(([tile, r]) => [tile, r.state, r.sinceMs, r.parkedAtMs]).sort((a, b) => a[0] - b[0]),
    objr: s3._objRadius ? [...s3._objRadius.hidden].sort((a, b) => a - b) : null,
  });
  const step = (x, y, dtMs = 600) => {
    t += dtMs;
    playerLb = lb(x, y);
    const res = grid.update(x, y);
    adapter.onUpdate(res);
    if (res.moved) adapter.refireWindowFeeds();
    adapter.tickPromotions();
    adapter.tickTeleportDrain();
    adapter.tickPressure();
    M.objR.tickObjectRadius(s3, new Set([playerLb]));
  };
  /** The visible flags of `key`'s pooled instances (the registry's per-landblock ranges). */
  const poolVis = (key) => {
    const out = [];
    const byTile = reg.tiles.get(M.pools.tileKeyOfLbKey(key));
    if (byTile) {
      for (const mem of byTile.values()) {
        const ids = mem.lbRanges && mem.lbRanges.get(key);
        if (ids) for (const id of ids) out.push(mem.pool.mesh._instanceInfo[id].visible ? 1 : 0);
      }
    }
    return out;
  };
  return { s3, lru, reg, grid, adapter, state, step, poolVis, advance: (ms) => { t += ms; } };
}

/**
 * The grid as the authority (`gridWorld`, ?objRadius 3, the pool hides not
 * wired): a walk east, a stand-still (hysteresis parks), a teleport (drain), a
 * walk back (re-adopt), pressure releases.
 */
async function gridScenario(W) {
  const { state, step, adapter, advance } = gridWorld(W);
  step(0x40, 0x40);
  await W.checkpoint("grid seeded at 0x40,0x40", state);
  for (let k = 1; k <= 4; k++) step(0x40 + k, 0x40);
  await W.checkpoint("walked east 4 landblocks", state);
  for (let k = 0; k < 5; k++) step(0x44, 0x40, 1000); // stand: hysteresis parks the vacated column
  await W.checkpoint("stood still (hysteresis parks)", state);
  step(0x10, 0x60, 500); // teleport
  for (let k = 0; k < 3; k++) step(0x10, 0x60, 300);
  await W.checkpoint("teleported (drain)", state);
  advance(40_000); // past the 30 s park floor
  for (let k = 0; k < 6; k++) step(0x10, 0x60, 100); // pressure releases (32 MiB per LB, 128 MiB budget)
  await W.checkpoint("pressure releases", state);
  step(0x43, 0x40, 500); // teleport back: PARKED tiles re-adopt
  step(0x43, 0x40, 300);
  await W.checkpoint("back east (re-adopt)", state);
  adapter.dispose();
  await W.checkpoint("adapter dispose", state);
}

/**
 * ?objRadius x pooled statics through the grid (2026-10-29, lane W review r2):
 * `gridWorld` with the pool hides wired as index.js wires them, ?objRadius 1.
 * Landblock A is hidden for distance while resident (objRadius's set and the
 * registry's sticky copy), its tile parks on a teleport and the pressure pass
 * releases it (the baked marks go), a crossing far away forgets it, and a
 * teleport back plus a walk re-bakes it inside the radius: its pooled statics
 * must be VISIBLE again. Before the object_radius.js forget fix the registry kept A's
 * hide and the re-fed members committed hidden for the session; `W.opts.preFixForget`
 * replays that drift (gridWorld) for the audit's poolHideOrphan category.
 */
async function objrPoolScenario(W) {
  const A = lb(0x40, 0x40), A2 = lb(0x41, 0x40);
  const o = W.opts || {};
  const g = gridWorld(W, { objRadius: 1, seed: 71, poolHides: true, preFixForget: !!o.preFixForget });
  const { reg, step, advance, adapter } = g;
  const state = () => ({
    ...g.state(),
    poolVis: { A: g.poolVis(A), A2: g.poolVis(A2) },
    regHidden: [...reg._hiddenLbs].sort((a, b) => a - b),
  });
  step(0x40, 0x40);
  step(0x40, 0x40, 300);
  await W.checkpoint("seeded at A", state);
  for (let k = 1; k <= 3; k++) step(0x40 + k, 0x40);
  await W.checkpoint("walked 3 east: A hidden (objRadius + the registry's copy)", state);
  step(0x10, 0x60, 500); // teleport: vacated pool tiles released, the grid drain parks
  for (let k = 0; k < 3; k++) step(0x10, 0x60, 300);
  await W.checkpoint("teleported away (drain parks)", state);
  advance(40_000); // past the 30 s park floor
  for (let k = 0; k < 48; k++) step(0x10, 0x60, 100); // pressure releases, one tile per tick
  await W.checkpoint("pressure released the parked tiles (baked marks gone)", state);
  step(0x11, 0x60, 300); // a crossing: objRadius forgets the released landblocks
  await W.checkpoint("a crossing far away: objRadius forgets them", state);
  // Back by teleport to 4 east of A (A outside the bake radius), then a walk
  // west: A2 (d 1 at 0x42) and A (d 1 at 0x41) re-bake on a crossing, AFTER the
  // previous tick, so no late hide covers them (a bake landing before the tick
  // of a teleport is hidden on arrival by afterObjectBake and shown by that
  // tick, which heals the stale mark by accident).
  step(0x44, 0x40, 500);
  step(0x44, 0x40, 300);
  await W.checkpoint("teleported back to 4 east of A (outside the bake radius)", state);
  for (let k = 3; k >= 0; k--) step(0x40 + k, 0x40);
  await W.checkpoint("walked back onto A: re-baked, its pooled statics visible", state);
  adapter.dispose();
  await W.checkpoint("adapter dispose", state);
}

export const SCENARIOS = {
  chunk: chunkScenario(false),
  chunkDedup: chunkScenario(true),
  atlas: atlasScenario,
  building: buildingScenario,
  pool: poolScenario,
  grid: gridScenario,
  objrPool: objrPoolScenario,
};

/**
 * Run one scenario. `arm`: arm the bridge with `kernel` (record mode); false ⇒
 * the hooks are inert (the flag-off arm). Returns
 * `{ checkpoints: [{label, state, audit?, eventsEnd?}], events?, report? }`.
 */
export async function runScenario(name, { arm = true, kernel = null, matrices = true, mutate = null, opts = null } = {}) {
  const M = await loadModules();
  const fn = SCENARIOS[name];
  if (!fn) throw new Error(`no scenario ${name}`);
  M.world.disarmRustWorld();
  const bridge = arm ? M.world.armRustWorld({ kernel, record: true, periodic: false }) : null;
  if (bridge && mutate) mutate(bridge); // tests: knock out one hook
  const checkpoints = [];
  const W = {
    M,
    opts: opts || {}, // scenario options (tests: objrPool's preFixForget)
    async checkpoint(label, stateFn) {
      const cp = { label, state: JSON.stringify(stateFn()) };
      if (bridge) {
        const r = bridge.audit({ matrices });
        cp.audit = r ? { mismatches: r.mismatches, report: r.report, arena: r.arena } : null;
        cp.eventsEnd = bridge.recorded().length;
        cp.census = bridge.census();
      }
      checkpoints.push(cp);
    },
  };
  // static_atlas.js prints a per-feed dev census when ?statNra resolves on (node default).
  const info = console.info;
  console.info = () => {};
  try {
    await fn(W);
  } finally {
    console.info = info;
    if (bridge) M.world.disarmRustWorld();
  }
  return {
    checkpoints,
    events: bridge ? bridge.recorded() : null,
    stats: bridge ? { ...bridge.stats } : null,
  };
}
