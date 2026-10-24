// tests/buildings_rebake_after_evict.test.mjs — building shells must come back
// after a landblock is evicted and re-approached (2026-10-23).
//
// The owner's 3.5 h endurance session on the 1070: towns lost their roofs and
// walls (Arwic showed lit interiors with no shells; 47 landblocks in all). Cause:
// resolveBuildingsOpts minted a PRIVATE placementKey dedup map whenever
// scene3d.buildingMap3d was not a Map — and on the live path it is null (init3D
// publishes `?? null`) — while the LRU's evict / park / unpark prune
// scene3d.buildingMap3d. After the first true eviction the re-bake hit the dedup
// for every placement, built nothing, and still marked the landblock baked.
// Every older fixture passed `buildingMap3d: new Map()`, so no suite saw it.
//
// Drives the REAL scene3d/buildings.js bake + scene3d/landblock_lru.js with fake
// wasm exports (the tests/building_mat_batch.test.mjs fixture shape) on a scene3d
// shaped like the live one (buildingMap3d null, no buildingsOpts).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

globalThis.window ??= {};
window.location ??= { search: "" };
window.requestAnimationFrame ??= () => 0;
globalThis.location ??= window.location;

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;
const THREE = await import(v("node_modules/three/build/three.module.js"));
const B = await import(v("scene3d/buildings.js"));
const { MaterialCache } = await import(v("scene3d/materials.js"));
const { LandblockLRU } = await import(v("scene3d/landblock_lru.js"));

let passed = 0, failed = 0;
function check(name, ok, info = "") {
  if (ok) { passed += 1; console.log(`  ok  ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name} ${info}`); }
}

const LB = 0xa21e0000, NEIGHBOUR = 0xa21f0000;
const CELL = (LB | 0xfffe) >>> 0;
const S_WALL = 0x08000101, S_ROOF = 0x08000105, S_DOOR = 0x08000106;
const SURF = { [S_WALL]: { w: 8, h: 8, seed: 10 }, [S_ROOF]: { w: 16, h: 16, seed: 50 }, [S_DOOR]: { w: 8, h: 8, seed: 70 } };
function surfacePixels(did) {
  const s = SURF[did];
  const px = new Uint8Array(s.w * s.h * 4);
  for (let i = 0; i < s.w * s.h; i++) { px[i * 4] = (s.seed + i) & 0xff; px[i * 4 + 1] = 90; px[i * 4 + 2] = 40; px[i * 4 + 3] = 255; }
  return { width: s.w, height: s.h, pixels: px, surfaceType: 0x2, category: undefined, normalPixels: null, heightPixels: null,
    translucency: 0, luminosity: 0, diffuse: 0, hasPalette: false, rsId: 0, free() {} };
}
function wasmMesh(surfaces, tris, seed) {
  const triCount = surfaces.length * tris;
  const positions = new Float32Array(triCount * 9), uvs = new Float32Array(triCount * 6), normals = new Float32Array(triCount * 9);
  const surfaceIndices = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    surfaceIndices[t] = Math.floor(t / tris);
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = ((seed * 31 + t * 7 + k * 3) % 23) - 11 + k * 0.125;
    for (let k = 0; k < 6; k++) uvs[t * 6 + k] = ((seed + t * 5 + k) % 17) * 0.05;
    for (let k = 0; k < 3; k++) normals[t * 9 + k * 3 + 2] = 1;
  }
  return { triCount, positions, uvs, normals, surfaceIndices, surfaces: new Uint32Array(surfaces), free() {} };
}
const MODEL_HOUSE = 0x01000a01; // walls + door (part 0), roof (part 1)
const MODELS = { [MODEL_HOUSE]: { parts: [{ surfaces: [S_WALL, S_DOOR] }, { surfaces: [S_ROOF] }] } };
const PLACEMENTS = [
  { landblockId: CELL, modelId: MODEL_HOUSE, x: 20.25, y: 30.5, z: 61, rotationZ: 0.0, isBuilding: true },
  { landblockId: CELL, modelId: MODEL_HOUSE, x: 70.75, y: 32.0, z: 62, rotationZ: 1.2, isBuilding: true },
  { landblockId: CELL, modelId: MODEL_HOUSE, x: 120.5, y: 140.25, z: 64, rotationZ: -2.1, isBuilding: true },
  // Fetched across the boundary: it carries the NEIGHBOUR's id, so it belongs
  // to the neighbour's lifecycle — evicting LB must neither drop it nor forget
  // its key (a forgotten key under a live building would bake a duplicate).
  { landblockId: (NEIGHBOUR | 0xfffe) >>> 0, modelId: MODEL_HOUSE, x: 4.5, y: 2.25, z: 63, rotationZ: 0.4, isBuilding: true },
];
const wasm = {
  async fetch_landblock_objects(cellIds) {
    return [...cellIds].flatMap((c) => ((c >>> 0) === CELL ? PLACEMENTS.map((p) => ({ ...p, free() {} })) : []));
  },
  async fetchBuildingPlacement(modelId) {
    const m = MODELS[modelId >>> 0];
    return {
      setupId: modelId, partCount: m.parts.length, decodeMisses: 0,
      takePartMeshes: () => m.parts.map((p, i) => wasmMesh(p.surfaces, 3, (modelId & 0xff) + i)),
      takePartHingeFrames: () => m.parts.map(() => ({ x: 0, y: 0, z: 0, qw: 1, qx: 0, qy: 0, qz: 0, free() {} })),
      free() {},
    };
  },
  async fetch_surfaces_pixels(dids) { return [...dids].map((d) => surfacePixels(d >>> 0)); },
};

async function makeScene(buildingMap3d) {
  const cache = new MaterialCache({ wasmExports: null, normalMapsEnabled: true });
  await cache.preload(Object.keys(SURF).map(Number), wasm.fetch_surfaces_pixels);
  const s = {
    buildingsGroup: new THREE.Group(), staticsGroup: new THREE.Group(), terrainGroup: new THREE.Group(),
    materialCache: cache,
    buildingMap3d,                       // the live shape: null
    shadowsEnabled: true, quality: { preset: "ultra" },
    activeLights: [], terrainBakedLbs: new Set(), buildingsBakedLbs: new Set(), staticsBakedLbs: new Set(),
    envCellLoadedLbs: new Set(), terrainMaterials: [],
  };
  const lru = new LandblockLRU({ scene3d: s, maxResident: 8, getCurrentLbId: () => null });
  return { s, lru };
}
const instancesOf = (s) => s.buildingsGroup.children.reduce((a, c) => a + (c.isBatchedMesh ? c.instanceCount : 1), 0);
const bake = (s) => B.bakeBuildingsForLandblock(s, 0xa2, 0x1e, s.buildingsOpts, wasm);

console.log("-- the live shape: scene3d.buildingMap3d === null --");
const OWN = PLACEMENTS.filter((p) => ((p.landblockId >>> 0) & 0xffff0000) >>> 0 === LB).length;
const ownedBy = (s, lb) => s.buildingsGroup.children.filter((c) => c.userData && c.userData.landblockId != null
  && (((c.userData.landblockId >>> 0) & 0xffff0000) >>> 0) === lb).reduce((a, c) => a + (c.isBatchedMesh ? c.instanceCount : 1), 0);
{
  const { s, lru } = await makeScene(null);
  const r1 = await bake(s); lru.track(LB);
  const n1 = instancesOf(s), own1 = ownedBy(s, LB), nb1 = ownedBy(s, NEIGHBOUR);
  check("first bake attaches every placement (own + the neighbour-id one)", r1.placementCount === PLACEMENTS.length && own1 > 0 && nb1 > 0 && own1 + nb1 === n1, `${r1.placementCount} ${own1} ${nb1} ${n1}`);
  check("the dedup map is PUBLISHED on scene3d and is the one the baker uses",
    s.buildingMap3d instanceof Map && s.buildingsOpts.buildingMap3d === s.buildingMap3d && s.buildingMap3d.size === PLACEMENTS.length);
  lru.evict(LB);
  check("evict drops LB's own buildings, forgets their keys and the baked mark",
    ownedBy(s, LB) === 0 && !s.buildingsBakedLbs.has(LB) && s.buildingMap3d.size === PLACEMENTS.length - OWN, `keys left ${s.buildingMap3d.size}`);
  check("the neighbour-id building stays attached with its key (it follows its own landblock)",
    ownedBy(s, NEIGHBOUR) === nb1 && [...s.buildingMap3d.keys()].every((k) => k.startsWith((NEIGHBOUR >>> 0).toString(16).slice(0, 4))));
  const r2 = await bake(s); lru.track(LB);
  check("re-bake after evict restores LB's buildings (was: 0 — the missing roofs) with no duplicate",
    ownedBy(s, LB) === own1 && ownedBy(s, NEIGHBOUR) === nb1 && instancesOf(s) === n1 && r2.placementCount === PLACEMENTS.length, `${ownedBy(s, LB)} vs ${own1}, total ${instancesOf(s)} vs ${n1}`);
  // A second round, so the fix is not a first-eviction accident.
  lru.evict(LB);
  await bake(s); lru.track(LB);
  check("and again after a second evict", ownedBy(s, LB) === own1 && instancesOf(s) === n1);
}

console.log("-- park / unpark keeps the shells --");
{
  const { s, lru } = await makeScene(null);
  await bake(s); lru.track(LB);
  const n1 = instancesOf(s);
  lru.park(LB);
  check("park detaches LB's own buildings", ownedBy(s, LB) === 0);
  lru.unpark(LB);
  check("unpark brings the same buildings back without a re-bake", instancesOf(s) === n1 && s.buildingsBakedLbs.has(LB));
}

console.log("-- the old fixture shape (a Map supplied) is unchanged --");
{
  const supplied = new Map();
  const { s, lru } = await makeScene(supplied);
  await bake(s); lru.track(LB);
  const n1 = instancesOf(s);
  check("a supplied map is used as is", s.buildingMap3d === supplied && s.buildingsOpts.buildingMap3d === supplied);
  lru.evict(LB);
  await bake(s); lru.track(LB);
  check("evict + re-bake restores the buildings", instancesOf(s) === n1);
}

console.log(`\nbuildings rebake after evict: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
