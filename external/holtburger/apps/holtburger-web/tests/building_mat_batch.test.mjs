// tests/building_mat_batch.test.mjs
//
// `?buildingMatBatch` (2026-10-17, DEFAULT-ON, `=off|0|false|no` escape) —
// building surfaces are batched by their OWN material, per landblock, instead
// of being offered to the cross-LB statics atlas (scene3d/buildings.js
// `consolidateBuildingSurfaces`).
//
// The whole bake runs for real: `bakeBuildingsForLandblock` → the real
// `MaterialCache` (materials built by `_installFromPixels` /
// `_materialFromFlags` from SurfacePixels-shaped records, the real
// `getCachedFloorBias` clones) → the real `meshToGeometryGroups` /
// `buildOneBuilding` / flatten → atlas or batch. Only the wasm exports are
// fakes. Draw-level identity is proven on three r184's REAL WebGLRenderer over
// tests/helpers/fake_webgl2.mjs.
//
//   B1  flag grammar.
//   B2  R1 reproduced on the legacy arm (`=off`): a base whose BC7 verdict is in
//       flight when the bake mints its floor-bias clone leaves the clone marked
//       `__bc7Pending` after the base clears — the atlas defers every surface,
//       and the arm is byte-for-byte today's route.
//   B3  routing (flag on): one BatchedMesh per (landblock, material) for opaque
//       groups of >= 2 (the default `?clipMapOpaque` alpha-tested ClipMap is
//       opaque-pass and batches); blended translucent, lone and cross-LB-lone
//       surfaces stay singletons; nothing reaches the atlas; the stale marker
//       is moot.
//   B4  bucket shape: member material behind the variant, landblock id + origin
//       anchor, shadow flags, sort/cull flags, one geometry per shared mesh.
//   B5  geometry identity: every batched range is the source's position /
//       normal / uv bytes; every instance's world matrix equals the singleton's,
//       and the anchored float32 matrices are ~100x more precise than world ones.
//   B6  GL identity, log depth AND reversed-Z: the batched program's shader
//       source equals the singleton program's minus the batching define(s); per
//       material, every uniform (samplers resolved to the bound GL texture) and
//       the GL depth/blend/cull state at the draw are equal, except the model
//       transforms and the batching samplers; draw counts drop.
//   B7  a member change (BC7-style map re-point + needsUpdate) reaches the
//       batched draw after the per-frame variant sync.
//   B8  LRU: evict removes + disposes the landblock's batches (variant hold
//       released); park detaches / unpark re-attaches; disposeParked disposes.
//   B9  per-landblock consumers: cells.js `nodeInLandblock` hoists the bucket
//       for its own landblock only; the bucket raycasts like the singletons.
//   B10 source wiring: docs row, harness registration, LRU disposes, the env
//       detail bypass order the envDetail suite pins.
//
// Run: node tests/building_mat_batch.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

globalThis.window ??= {};
window.location ??= { search: "" };
window.requestAnimationFrame ??= () => 0;
globalThis.location ??= window.location;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;
const src = (p) => readFileSync(path.join(APP, p), "utf8");

const THREE = await import("three");
const B = await import(v("scene3d/buildings.js"));
const { MaterialCache } = await import(v("scene3d/materials.js"));
const ATLAS = await import(v("scene3d/static_atlas.js"));
const BC7 = await import(v("scene3d/bc7_textures.js"));
const BMV = await import(v("scene3d/batched_material_variant.js"));
const { LandblockLRU } = await import(v("scene3d/landblock_lru.js"));
const { nodeInLandblock } = await import(v("scene3d/portal_clip.js"));
const { createFakeWebGL2, fakeCanvas, preprocessGlsl } = await import("./helpers/fake_webgl2.mjs");

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---------------------------------------------------------------------------
// Fixture: two building models, five surfaces, two landblocks.
// ---------------------------------------------------------------------------
const LB = 0xa21e0000;          // Linvak Tukal's landblock
const LB_N = 0xa21f0000;        // its north neighbour (cross-LB placement)
const CELL = (LB | 0xfffe) >>> 0;
const S_WALL = 0x08000101;      // opaque Base1Image
const S_LUM = 0x08000102;       // opaque Base1Image + Luminous
const S_GLASS = 0x08000103;     // Base1Image + Translucent (blended)
const S_CLIP = 0x08000104;      // Base1ClipMap (alpha-tested; opaque pass under the default ?clipMapOpaque)
const S_ROOF = 0x08000105;      // opaque Base1Image, other tile size
const ST = { Base1Image: 0x2, Base1ClipMap: 0x4, Translucent: 0x10, Luminous: 0x40 };
const SURF = {
  [S_WALL]: { w: 8, h: 8, type: ST.Base1Image, seed: 10 },
  [S_LUM]: { w: 8, h: 8, type: ST.Base1Image | ST.Luminous, seed: 20, luminosity: 0.6 },
  [S_GLASS]: { w: 8, h: 8, type: ST.Base1Image | ST.Translucent, seed: 30, translucency: 0.5 },
  [S_CLIP]: { w: 8, h: 8, type: ST.Base1ClipMap, seed: 40, clip: true },
  [S_ROOF]: { w: 16, h: 16, type: ST.Base1Image, seed: 50 },
};

function surfacePixels(did) {
  const s = SURF[did];
  const px = new Uint8Array(s.w * s.h * 4);
  for (let i = 0; i < s.w * s.h; i++) {
    px[i * 4] = (s.seed + i) & 0xff;
    px[i * 4 + 1] = (s.seed * 3 + i) & 0xff;
    px[i * 4 + 2] = (s.seed * 7) & 0xff;
    // ClipMap: a real cutout (half the texels transparent).
    px[i * 4 + 3] = s.clip ? (i % 2 ? 255 : 0) : 255;
  }
  const normal = new Uint8Array(s.w * s.h * 3);
  for (let i = 0; i < s.w * s.h; i++) { normal[i * 3] = 128 + (i % 9); normal[i * 3 + 1] = 120; normal[i * 3 + 2] = 250; }
  return {
    width: s.w, height: s.h, pixels: px, surfaceType: s.type, category: undefined,
    normalPixels: normal, heightPixels: null,
    translucency: s.translucency || 0, luminosity: s.luminosity || 0, diffuse: 0,
    hasPalette: false, rsId: 0, // rsId 0: no live BC7 upgrade — the test drives the marker by hand
    free() {},
  };
}

// A wasm ModelMesh-shaped record: `tris` triangles per surface, UVs running
// past [0,1] (retail building walls tile — the wrap path).
function wasmMesh(surfaces, tris, seed) {
  const triCount = surfaces.length * tris;
  const positions = new Float32Array(triCount * 9);
  const uvs = new Float32Array(triCount * 6);
  const normals = new Float32Array(triCount * 9);
  const surfaceIndices = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    surfaceIndices[t] = Math.floor(t / tris);
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = ((seed * 31 + t * 7 + k * 3) % 23) - 11 + k * 0.125;
    for (let k = 0; k < 6; k++) uvs[t * 6 + k] = ((seed + t * 5 + k) % 17) * 0.4 - 1.5;
    for (let k = 0; k < 3; k++) { normals[t * 9 + k * 3] = 0; normals[t * 9 + k * 3 + 1] = 0.6; normals[t * 9 + k * 3 + 2] = 0.8; }
  }
  return { triCount, positions, uvs, normals, surfaceIndices, surfaces: new Uint32Array(surfaces), free() {} };
}

const MODEL_A = 0x01000a01; // one part: wall, luminous window, glass
const MODEL_B = 0x01000b02; // two parts (non-identity hinge on part 1): wall + clip, roof
const MODELS = {
  [MODEL_A]: { parts: [{ surfaces: [S_WALL, S_LUM, S_GLASS], hinge: [0, 0, 0, 1, 0, 0, 0] }] },
  [MODEL_B]: {
    parts: [
      { surfaces: [S_WALL, S_CLIP], hinge: [0, 0, 0, 1, 0, 0, 0] },
      { surfaces: [S_ROOF], hinge: [1.5, -2, 4, Math.cos(0.3), 0, 0, Math.sin(0.3)] },
    ],
  },
};
// Placements: AC metres relative to the landblock's SW corner (lib.rs).
const PLACEMENTS = [
  { landblockId: CELL, modelId: MODEL_A, x: 20.25, y: 30.5, z: 61, rotationZ: 0.0, isBuilding: true },
  { landblockId: CELL, modelId: MODEL_A, x: 70.75, y: 32.0, z: 62, rotationZ: 1.2, isBuilding: true },
  { landblockId: CELL, modelId: MODEL_A, x: 120.5, y: 140.25, z: 64, rotationZ: -2.1, isBuilding: true },
  { landblockId: CELL, modelId: MODEL_B, x: 50.0, y: 90.0, z: 60.5, rotationZ: 0.7, isBuilding: true },
  { landblockId: CELL, modelId: MODEL_B, x: 160.0, y: 20.0, z: 66, rotationZ: 3.0, isBuilding: true },
  // Cross-LB inclusion: a placement of the NORTH landblock surfaced by this LB's fetch.
  { landblockId: (LB_N | 0xfffe) >>> 0, modelId: MODEL_A, x: 15.0, y: 5.0, z: 60, rotationZ: 0.4, isBuilding: true },
  // A static (not a building) — the buildings baker must ignore it.
  { landblockId: CELL, modelId: 0x02000001, x: 1, y: 1, z: 1, rotationZ: 0, isBuilding: false },
];

function makeWasm(counter) {
  return {
    async fetch_landblock_objects(cellIds) {
      counter.lbo++;
      return [...cellIds].flatMap((c) => (c >>> 0) === CELL ? PLACEMENTS.map((p) => ({ ...p })) : []);
    },
    async fetchBuildingPlacement(modelId) {
      counter.models++;
      const m = MODELS[modelId >>> 0];
      return {
        setupId: modelId, partCount: m.parts.length, decodeMisses: 0,
        takePartMeshes: () => m.parts.map((p, i) => wasmMesh(p.surfaces, 3, (modelId & 0xff) + i)),
        takePartHingeFrames: () => m.parts.map((p) => ({
          x: p.hinge[0], y: p.hinge[1], z: p.hinge[2], qw: p.hinge[3], qx: p.hinge[4], qy: p.hinge[5], qz: p.hinge[6], free() {},
        })),
        free() {},
      };
    },
    async fetch_surfaces_pixels(dids) { counter.surf++; return [...dids].map((d) => surfacePixels(d >>> 0)); },
  };
}

function makeScene(cache) {
  return {
    buildingsGroup: new THREE.Group(),
    staticsGroup: new THREE.Group(),
    materialCache: cache,
    buildingBakeCache: new Map(),
    buildingMap3d: new Map(),
    shadowsEnabled: true, // tags castShadow/receiveShadow, so the bucket flags are exercised
    quality: { preset: "ultra" },
  };
}

const ALL_DIDS = Object.keys(SURF).map(Number);
// Flattened surface meshes: model A x4 placements x3 surfaces + model B x2 x3 = 18.
const FLAT_MESHES = 18;

// ---------------------------------------------------------------------------
console.log("\n-- B1 flag grammar -----------------------------------------------");
{
  const read = (s) => { window.location.search = s; B.__setBuildingMatBatchForTest(undefined); return B.buildingMatBatchEnabled(); };
  check("absent -> on", read("") === true);
  check("=on / =1 / =yes / garbage -> on", ["on", "1", "yes", "maybe"].every((x) => read(`?buildingMatBatch=${x}`) === true));
  check("=off / =0 / =false / =no (any case) -> off",
    ["off", "0", "false", "no", "OFF", "No"].every((x) => read(`?buildingMatBatch=${x}`) === false));
  window.location.search = "";
  B.__setBuildingMatBatchForTest(undefined);
}

// ---------------------------------------------------------------------------
// Shared material cache: both arms draw the SAME material + texture objects.
// ---------------------------------------------------------------------------
const counter = { lbo: 0, models: 0, surf: 0 };
const wasm = makeWasm(counter);
const cache = new MaterialCache({ wasmExports: null, normalMapsEnabled: true });
await cache.preload(ALL_DIDS, wasm.fetch_surfaces_pixels);
const bases = ALL_DIDS.map((d) => cache.materials.get(d));
check("fixture: every surface built a real material", bases.every((m) => m && m.isMeshStandardMaterial && m.map));
// BC7 support ON (the 1070's verdict) and every base mid-upgrade when the bake
// mints its clones — the measured live state.
BC7._setBc7SupportForTest(true);
check("fixture: bc7Available() under the default flag", BC7.bc7Available() === true);
for (const m of bases) m.userData.__bc7Pending = true;

// ---------------------------------------------------------------------------
console.log("\n-- B2 legacy arm (=off): R1 reproduced, atlas defers everything ---");
ATLAS._resetStatAtlasForTest();
B.__setBuildingMatBatchForTest(false);
const sceneA = makeScene(cache);
const resA = await B.bakeBuildingsForLandblock(sceneA, 0xa2, 0x1e, null, wasm);
// The verdict lands on every base.
for (const m of bases) delete m.userData.__bc7Pending;
const clones = ALL_DIDS.map((d) => cache.floorBiasMaterials.get(d));
check("baked 6 placements", resA.placementCount === 6, JSON.stringify(resA));
check("buildings draw the per-DID floor-bias clone", clones.every((c, i) => c && c !== bases[i] && c.userData.__floorBiased === true));
check("R1: bases cleared, every clone STILL reads __bc7Pending",
  bases.every((m) => !m.userData.__bc7Pending) && clones.every((c) => c.userData.__bc7Pending === true));
check("R1: bc7AtlasShouldDefer(clone) stays true after the verdict", clones.every((c) => ATLAS.bc7AtlasShouldDefer(c)));
const stA = ATLAS._statAtlasStatsForTest();
const nA = sceneA.buildingsGroup.children.length;
check("legacy: every flattened surface was offered to the atlas and deferred",
  stA.nodesIn === nA && stA.ptBc7Deferred === nA && stA.atlased === 0, `nodesIn=${stA.nodesIn} deferred=${stA.ptBc7Deferred} atlased=${stA.atlased} children=${nA}`);
check("legacy: buildingsGroup holds plain Mesh singletons only",
  nA === FLAT_MESHES && sceneA.buildingsGroup.children.every((c) => c.isMesh && !c.isBatchedMesh), `n=${nA}`);

// ---------------------------------------------------------------------------
console.log("\n-- B3 routing (default arm) ---------------------------------------");
B.__setBuildingMatBatchForTest(true);
const atlasBefore = { ...ATLAS._statAtlasStatsForTest() };
const sceneB = makeScene(cache);
const statsBefore = B.buildingBatchStats();
const resB = await B.bakeBuildingsForLandblock(sceneB, 0xa2, 0x1e, null, wasm);
const kidsB = sceneB.buildingsGroup.children;
const batches = kidsB.filter((c) => c.isBatchedMesh);
const singles = kidsB.filter((c) => !c.isBatchedMesh);
const atlasAfter = ATLAS._statAtlasStatsForTest();
check("same placements baked", resB.placementCount === resA.placementCount && resB.surfaceMeshCount === resA.surfaceMeshCount);
check("nothing offered to the atlas", atlasAfter.nodesIn === atlasBefore.nodesIn && atlasAfter.feeds === atlasBefore.feeds);
check("4 batches: (LB, wall) x5, (LB, luminous) x3, (LB, clip) x2, (LB, roof) x2", batches.length === 4,
  batches.map((b) => b.name).join(", "));
const byDid = new Map(batches.map((b) => [b.userData.surfaceDid >>> 0, b]));
check("batch members: wall 5 (two models' geometries), luminous 3, alpha-tested clip 2, roof 2",
  byDid.get(S_WALL)?.instanceCount === 5 && byDid.get(S_LUM)?.instanceCount === 3 &&
    byDid.get(S_CLIP)?.instanceCount === 2 && byDid.get(S_ROOF)?.instanceCount === 2,
  [...byDid].map(([d, b]) => `${d.toString(16)}:${b.instanceCount}`).join(" "));
const singleDids = singles.map((s) => s.userData.surfaceDid >>> 0).sort();
check("singletons: blended glass x4 (3 here + 1 north) + the north LB's lone wall + luminous",
  singles.length === 6 &&
    singleDids.filter((d) => d === S_GLASS).length === 4 &&
    singles.filter((s) => ((s.userData.landblockId >>> 0) & 0xffff0000) >>> 0 === LB_N).length === 3,
  singleDids.map((d) => d.toString(16)).join(","));
check("every surface is drawn exactly once (18 = batched instances + singletons)",
  batches.reduce((n, b) => n + b.instanceCount, 0) + singles.length === nA);
check("the stale clone marker is moot: batched members still carry it, nothing waits on it",
  clones[0].userData.__bc7Pending === true && byDid.get(S_WALL) != null);
const st = B.buildingBatchStats();
check("diag tally: 4 batches, 12 batched, 5 unique geometries, 2 loners, 4 blended refused",
  st.batches - statsBefore.batches === 4 && st.batched - statsBefore.batched === 12 &&
    st.uniqueGeoms - statsBefore.uniqueGeoms === 5 && st.loners - statsBefore.loners === 2 &&
    st.ptIneligible - statsBefore.ptIneligible === 4, JSON.stringify(st));
check("window.__buildingBatchStats is the diag", typeof window.__buildingBatchStats === "function" && window.__buildingBatchStats().enabled === true);

// ---------------------------------------------------------------------------
console.log("\n-- B4 bucket shape -------------------------------------------------");
{
  const wall = byDid.get(S_WALL);
  const wallClone = cache.floorBiasMaterials.get(S_WALL);
  check("member material behind the variant is the floor-bias clone",
    BMV.memberMaterialOf(wall.material) === wallClone && wall.material !== wallClone);
  check("variant mirrors the clone's patch chain + program key",
    wall.material.onBeforeCompile === wallClone.onBeforeCompile &&
      wall.material.customProgramCacheKey() === wallClone.customProgramCacheKey() &&
      wall.material.userData === wallClone.userData);
  check("landblockId carried (full id), anchored at the landblock origin",
    wall.userData.landblockId === CELL && wall.userData.__buildingBatch === true &&
      wall.position.x === 0xa2 * 192 && wall.position.y === 0x1e * 192 && wall.position.z === 0);
  const tmplSingle = sceneA.buildingsGroup.children.find((c) => c.material === wallClone);
  check("shadow flags = the singletons'", wall.castShadow === tmplSingle.castShadow && wall.receiveShadow === tmplSingle.receiveShadow &&
    wall.castShadow === true && wall.receiveShadow === true);
  check("opaque: no instance sort; per-instance + node frustum cull; default layer",
    wall.sortObjects === false && wall.perObjectFrustumCulled === true && wall.frustumCulled === true && wall.layers.mask === 1);
  check("shared model geometry added once per bucket (wall: 2 geometries for 5 instances)",
    wall._geometryCount === 2, `geometries=${wall._geometryCount}`);
  check("named for the census", /^building-batch-lba21efffe-s08000101-x5$/.test(wall.name), wall.name);
}

// ---------------------------------------------------------------------------
console.log("\n-- B5 geometry + transform identity --------------------------------");
{
  // Source geometries, from the bake cache (shared by both arms).
  const geomsOf = (did) => {
    const out = [];
    for (const bake of sceneB.buildingBakeCache.values()) for (const p of bake.parts) for (const g of p.groups) if (g.surfaceDid === did) out.push(g.geometry);
    return out;
  };
  let rangesOk = true;
  for (const [did, bm] of byDid) {
    const srcs = geomsOf(did);
    for (let gid = 0; gid < bm._geometryCount; gid++) {
      const r = bm.getGeometryRangeAt(gid);
      const match = srcs.some((g) => ["position", "normal", "uv"].every((name) => {
        const a = g.attributes[name], b = bm.geometry.attributes[name];
        if (r.vertexCount !== a.count) return false;
        const s = b.array.subarray(r.vertexStart * a.itemSize, (r.vertexStart + r.vertexCount) * a.itemSize);
        return s.length === a.array.length && s.every((x, i) => x === a.array[i]);
      }));
      if (!match) rangesOk = false;
    }
  }
  check("every batched range is byte-identical to a source geometry (position, normal, uv incl. UVs past [0,1])", rangesOk);
  check("batch attribute layout = the source's (non-indexed position/normal/uv)",
    batches.every((b) => !b.geometry.index && Object.keys(b.geometry.attributes).sort().join() === "normal,position,uv"));

  // World matrices: bucket.matrixWorld x instance == singleton matrixWorld (same placement set).
  sceneA.buildingsGroup.updateMatrixWorld(true);
  sceneB.buildingsGroup.updateMatrixWorld(true);
  const key = (m) => m.elements.map((x) => x.toFixed(4)).join(",");
  let worldOk = true, maxErr = 0, maxLocalT = 0, f32WorldErr = 0, f32LocalErr = 0;
  const tmp = new THREE.Matrix4(), world = new THREE.Matrix4();
  for (const [did, bm] of byDid) {
    const clone = cache.floorBiasMaterials.get(did);
    const want = sceneA.buildingsGroup.children
      .filter((c) => c.material === clone && (((c.userData.landblockId >>> 0) & 0xffff0000) >>> 0) === LB)
      .map((c) => c.matrixWorld.clone());
    const got = [];
    for (let i = 0; i < bm.instanceCount; i++) {
      bm.getMatrixAt(i, tmp);
      maxLocalT = Math.max(maxLocalT, Math.abs(tmp.elements[12]), Math.abs(tmp.elements[13]), Math.abs(tmp.elements[14]));
      got.push(world.multiplyMatrices(bm.matrixWorld, tmp).clone());
      // float32 storage: anchored (what the batch stores) vs un-anchored world.
      const f32 = (x) => Math.fround(x);
      f32LocalErr = Math.max(f32LocalErr, Math.abs(f32(tmp.elements[12]) - tmp.elements[12]), Math.abs(f32(tmp.elements[13]) - tmp.elements[13]));
      const wx = bm.position.x + tmp.elements[12], wy = bm.position.y + tmp.elements[13];
      f32WorldErr = Math.max(f32WorldErr, Math.abs(f32(wx) - wx), Math.abs(f32(wy) - wy));
    }
    if (want.length !== got.length) { worldOk = false; continue; }
    const wantKeys = want.map(key).sort(), gotKeys = got.map(key).sort();
    if (wantKeys.join("|") !== gotKeys.join("|")) worldOk = false;
    for (const g of got) {
      let best = Infinity;
      for (const w of want) best = Math.min(best, Math.max(...w.elements.map((x, i) => Math.abs(x - g.elements[i]))));
      maxErr = Math.max(maxErr, best);
    }
  }
  // getMatrixAt reads the float32 matrices texture, so the residual is float32
  // storage of small anchored numbers (~1e-6), the same order as three's own
  // float32 upload of a singleton's camera-relative modelViewMatrix.
  check("every instance's world matrix equals its singleton's (incl. the rotated hinge part), to float32 storage",
    worldOk && maxErr < 2e-5, `maxErr=${maxErr.toExponential(2)}`);
  check("anchored instance translations stay inside the landblock (< 200 m)", maxLocalT < 200, `max=${maxLocalT}`);
  check("float32 rounding of the anchored translations is >= 100x below the world-space one",
    f32LocalErr * 100 <= f32WorldErr && f32WorldErr > 0, `local=${f32LocalErr.toExponential(2)} world=${f32WorldErr.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// B6 — the GL view: render both arms with three r184's real renderer.
// ---------------------------------------------------------------------------
const STATE_FNS = ["enable", "disable", "depthFunc", "depthMask", "blendFunc", "blendFuncSeparate", "blendEquation",
  "blendEquationSeparate", "cullFace", "frontFace", "colorMask", "polygonOffset", "clipControlEXT"];
function instrument(gl) {
  const shaderSrc = new Map();
  const progShaders = new Map();
  const state = {};
  const draws = [];
  const wrap = (obj, name, fn) => { const orig = obj[name]; obj[name] = function (...a) { fn(a); return orig.apply(this, a); }; };
  wrap(gl, "shaderSource", ([s, text]) => shaderSrc.set(s, text));
  wrap(gl, "attachShader", ([p, s]) => { const l = progShaders.get(p) || []; l.push(s); progShaders.set(p, l); });
  for (const f of STATE_FNS) {
    if (f === "clipControlEXT") continue;
    wrap(gl, f, (a) => {
      if (f === "enable" || f === "disable") state[`cap${a[0]}`] = f === "enable";
      else state[f] = a.join(",");
    });
  }
  const snap = (kind) => draws.push({ kind, state: { ...state } });
  for (const f of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) wrap(gl, f, () => snap(f));
  const md = gl.getExtension("WEBGL_multi_draw");
  for (const f of ["multiDrawArraysWEBGL", "multiDrawElementsWEBGL", "multiDrawArraysInstancedWEBGL", "multiDrawElementsInstancedWEBGL"]) {
    wrap(md, f, () => snap(f));
  }
  return { shaderSrc, progShaders, draws, state };
}

function renderArm(mode) {
  const gl = createFakeWebGL2({ maxTextures: 16, maxCombined: 32 });
  if (mode === "reversed") {
    const realGet = gl.getExtension;
    const clip = { LOWER_LEFT_EXT: 0x8ca1, ZERO_TO_ONE_EXT: 0x935f, clipControlEXT() {} };
    gl.getExtension = function (name) { return name === "EXT_clip_control" ? clip : realGet.call(this, name); };
  }
  const inst = instrument(gl);
  const params = mode === "reversed"
    ? { canvas: fakeCanvas(gl), context: gl, reversedDepthBuffer: true }
    : { canvas: fakeCanvas(gl), context: gl, logarithmicDepthBuffer: true };
  const renderer = new THREE.WebGLRenderer(params);
  const camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 5000);
  const cx = 0xa2 * 192 + 96, cy = 0x1e * 192 + 96;
  // AC (x, y, z) -> three (x, z, -y) under worldRoot.rotation.x = -PI/2.
  camera.position.set(cx, 450, -cy);
  camera.up.set(0, 0, -1);
  camera.lookAt(cx, 0, -cy);
  camera.updateMatrixWorld(true);
  const out = {};
  for (const [arm, sc] of [["A", sceneA], ["B", sceneB]]) {
    const scene = new THREE.Scene();
    const worldRoot = new THREE.Group();
    worldRoot.rotation.x = -Math.PI / 2;
    scene.add(worldRoot);
    scene.add(new THREE.AmbientLight(0x808080, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(1, 2, 3);
    scene.add(sun);
    worldRoot.add(sc.buildingsGroup);
    gl.__fake.startSnapshots();
    const d0 = inst.draws.length;
    renderer.render(scene, camera);
    const snaps = gl.__fake.takeSnapshots();
    const gld = inst.draws.slice(d0);
    worldRoot.remove(sc.buildingsGroup);
    out[arm] = snaps.map((s, i) => ({ ...s, state: gld[i]?.state, glKind: gld[i]?.kind }));
  }
  return { out, inst, gl, renderer };
}

const TRANSFORM_UNIFORMS = new Set(["modelMatrix", "modelViewMatrix", "normalMatrix"]);
const mapOf = (s) => s.uniforms.map;
function sourcesOf(inst, programId) {
  for (const [p, shaders] of inst.progShaders) {
    if (p.__id !== programId) continue;
    return shaders.map((s) => inst.shaderSrc.get(s));
  }
  return null;
}
// The batching machinery three r184 adds to a BatchedMesh program's PREFIX: the
// define(s) (a filtered prefix entry — absent, not blank, on a plain program) and
// the multi-draw extension (gl_DrawID; its slot is an EMPTY line on a plain
// program). Everything else must match byte for byte.
const stripBatching = (text) => text.split("\n")
  .filter((l) => !/^\s*#define\s+USE_BATCHING(_COLOR)?\s*$/.test(l))
  .map((l) => (/^\s*#extension\s+GL_ANGLE_multi_draw\b/.test(l) ? "" : l))
  .join("\n");
// The GL state a draw actually depends on. The recorder holds the CUMULATIVE
// context state (three's WebGLState only re-issues changes), so state that is
// dormant at a draw (blend factors with BLEND off, cull mode with CULL_FACE off)
// is whatever an earlier draw left and is not compared; a cap never touched
// reads as off, as in GL.
function effective(st, gl) {
  const cap = (e) => st[`cap${e}`] === true;
  const out = { caps: Object.keys(st).filter((k) => k.startsWith("cap") && st[k] === true).sort(), colorMask: st.colorMask };
  if (cap(gl.DEPTH_TEST)) { out.depthFunc = st.depthFunc; out.depthMask = st.depthMask; }
  if (cap(gl.BLEND)) { out.blendEquation = st.blendEquation; out.blendEquationSeparate = st.blendEquationSeparate; out.blendFunc = st.blendFunc; out.blendFuncSeparate = st.blendFuncSeparate; }
  if (cap(gl.CULL_FACE)) { out.cullFace = st.cullFace; out.frontFace = st.frontFace; }
  if (cap(gl.POLYGON_OFFSET_FILL)) out.polygonOffset = st.polygonOffset;
  return out;
}

for (const mode of ["log", "reversed"]) {
  console.log(`\n-- B6 GL identity (${mode} depth) ----------------------------------`);
  const { out, inst, gl } = renderArm(mode);
  const A = out.A, Bd = out.B;
  check(`${mode}: legacy arm = one plain draw per singleton (18)`, A.length === FLAT_MESHES && A.every((s) => s.glKind === "drawArrays"),
    `${A.length} ${[...new Set(A.map((s) => s.glKind))]}`);
  check(`${mode}: batched arm = 4 multi-draws + 6 plain draws (10 vs 18)`,
    Bd.length === 10 && Bd.filter((s) => s.glKind === "multiDrawArraysWEBGL").length === 4,
    `${Bd.length} ${Bd.map((s) => s.glKind).join(",")}`);
  // Per material (identified by the GL texture bound to `map`).
  const byMap = (arr) => { const m = new Map(); for (const s of arr) { const k = mapOf(s); if (!m.has(k)) m.set(k, []); m.get(k).push(s); } return m; };
  const mA = byMap(A), mB = byMap(Bd);
  check(`${mode}: the same 5 albedo textures are bound in both arms`, mA.size === 5 && mB.size === 5 && [...mA.keys()].every((k) => mB.has(k)));
  let uniOk = true, extraOk = true, stateOk = true, srcOk = true, biasOk = true;
  const uniBad = [];
  for (const [tex, drawsB] of mB) {
    const sA = mA.get(tex)[0];
    for (const sB of drawsB) {
      const namesA = Object.keys(sA.uniforms), namesB = Object.keys(sB.uniforms);
      for (const n of namesB) if (!namesA.includes(n) && !/^(batching|_gl_DrawID$)/.test(n)) { extraOk = false; uniBad.push(`+${n}`); }
      for (const n of namesA) {
        if (TRANSFORM_UNIFORMS.has(n)) continue;
        if (JSON.stringify(sA.uniforms[n]) !== JSON.stringify(sB.uniforms[n])) { uniOk = false; uniBad.push(n); }
      }
      if (JSON.stringify(effective(sA.state, gl)) !== JSON.stringify(effective(sB.state, gl))) stateOk = false;
      if (sB.glKind !== "multiDrawArraysWEBGL") continue;
      const [vsA, fsA] = sourcesOf(inst, sA.program);
      const [vsB, fsB] = sourcesOf(inst, sB.program);
      if (sA.program === sB.program) srcOk = false; // must be a distinct (batched) program
      if (stripBatching(vsB) !== stripBatching(vsA) || stripBatching(fsB) !== stripBatching(fsA)) srcOk = false;
      if (!/#define USE_BATCHING\b/.test(vsB) || /#define USE_BATCHING\b/.test(vsA)) srcOk = false;
      // The floor bias is compiled in for the active depth mode, in both programs.
      for (const [vs, fs] of [[vsA, fsA], [vsB, fsB]]) {
        if (mode === "log" && !/gl_FragDepth -= 2\.0e-4;/.test(preprocessGlsl(fs).text)) biasOk = false;
        if (mode === "reversed" && !/gl_Position\.z \*= /.test(preprocessGlsl(vs).text)) biasOk = false;
        if (mode === "reversed" && /gl_FragDepth -= 2\.0e-4;/.test(preprocessGlsl(fs).text)) biasOk = false;
      }
    }
  }
  check(`${mode}: batched shader source == singleton source minus the batching define (vertex + fragment)`, srcOk);
  check(`${mode}: floor bias active in both programs for this depth mode`, biasOk);
  check(`${mode}: every uniform equal per material (samplers -> same GL texture), transforms excepted`, uniOk, [...new Set(uniBad)].join(","));
  check(`${mode}: the only extra uniforms are the batching samplers (+ the gl_DrawID fallback)`, extraOk, [...new Set(uniBad)].join(","));
  check(`${mode}: effective GL depth / blend / cull / offset / colour-mask state identical at every draw`, stateOk);
  if (mode === "log") {
    // B7 — a member change reaches the batched draw after the frame's variant sync.
    console.log("\n-- B7 member change follows (BC7-style re-point) --------------------");
    const wallClone = cache.floorBiasMaterials.get(S_WALL);
    const wallBase = cache.materials.get(S_WALL);
    const oldMap = wallClone.map;
    const swapped = new THREE.DataTexture(new Uint8Array(8 * 8 * 4).fill(77), 8, 8, THREE.RGBAFormat);
    swapped.wrapS = oldMap.wrapS; swapped.wrapT = oldMap.wrapT; swapped.colorSpace = oldMap.colorSpace;
    swapped.needsUpdate = true;
    // What materials.js `_repointAlbedoForDid` does for the clone family.
    wallBase.map = swapped; wallBase.needsUpdate = true;
    wallClone.map = swapped; wallClone.needsUpdate = true;
    BMV.syncBatchMatVariants();
    const wall = byDid.get(S_WALL);
    check("variant follows map + version after one sync", wall.material.map === swapped && wall.material.version === wallClone.version);
    const again = renderArm("log").out;
    const texA = new Set(again.A.map(mapOf)), texB = new Set(again.B.map(mapOf));
    check("both arms bind the same 5 textures after the swap (old one gone from both)",
      texA.size === 5 && [...texA].every((t) => texB.has(t)));
    wallBase.map = oldMap; wallBase.needsUpdate = true;
    wallClone.map = oldMap; wallClone.needsUpdate = true;
    BMV.syncBatchMatVariants();
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- B9 per-landblock consumers ---------------------------------------");
{
  const wall = byDid.get(S_WALL);
  check("indoor-split hoist test (cells.js nodeInLandblock): own landblock only",
    nodeInLandblock(wall, LB) === true && nodeInLandblock(wall, LB_N) === false);
  // Raycast parity (ragdoll_env / blood_decals collect BatchedMesh targets).
  const g2 = new THREE.Group();
  g2.add(...sceneA.buildingsGroup.children
    .filter((c) => c.material === cache.floorBiasMaterials.get(S_WALL) && (((c.userData.landblockId >>> 0) & 0xffff0000) >>> 0) === LB)
    .map((c) => c.clone()));
  const root = new THREE.Group(); root.add(g2); root.updateMatrixWorld(true);
  const root2 = new THREE.Group(); const wb = wall; const prevParent = wb.parent; root2.add(wb); root2.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  let agree = 0, total = 0, hits = 0;
  const c = new THREE.Vector3();
  for (const m of g2.children) {
    // Rays straight down through each wall placement's triangles (bounding-sphere
    // centre plus four offsets), so most of them actually hit.
    m.geometry.computeBoundingSphere();
    c.copy(m.geometry.boundingSphere.center).applyMatrix4(m.matrixWorld);
    for (const [dx, dy] of [[0, 0], [1.5, 0.5], [-2, 1], [0.5, -2.5], [3, 3]]) {
      ray.set(new THREE.Vector3(c.x + dx, c.y + dy, 500), new THREE.Vector3(0, 0, -1));
      const a = ray.intersectObject(root, true)[0];
      const b = ray.intersectObject(root2, true)[0];
      total++;
      if (a) hits++;
      if ((!a && !b) || (a && b && Math.abs(a.distance - b.distance) < 1e-4)) agree++;
    }
  }
  if (prevParent) prevParent.add(wb);
  check("raycasts hit the batch exactly where they hit the singletons (ragdoll / blood-decal targets)",
    agree === total && hits >= total / 2, `${agree}/${total} agree, ${hits} hits`);
}

// ---------------------------------------------------------------------------
console.log("\n-- B8 LRU evict / park / disposeParked ----------------------------");
{
  const mkLruScene = (group) => ({
    buildingsGroup: group, staticsGroup: new THREE.Group(), terrainGroup: new THREE.Group(),
    activeLights: [], terrainBakedLbs: new Set(), buildingsBakedLbs: new Set([LB, LB_N]),
    staticsBakedLbs: new Set(), envCellLoadedLbs: new Set(), terrainMaterials: [], buildingMap3d: new Map(),
  });
  const holdersBefore = BMV.batchMatVariantStats().holders;
  const s3 = mkLruScene(sceneB.buildingsGroup);
  const lru = new LandblockLRU({ scene3d: s3, maxResident: 8, getCurrentLbId: () => null });
  lru.track(LB);
  lru.track(LB_N);
  const lbBatches = () => s3.buildingsGroup.children.filter((c) => c.isBatchedMesh);
  const kept = lbBatches();
  check("park detaches the landblock's batches (nothing disposed)",
    lru.park(LB) === true && lbBatches().length === 0 && kept.every((b) => !b.userData.__disposed) &&
      s3.buildingsGroup.children.every((c) => (((c.userData.landblockId >>> 0) & 0xffff0000) >>> 0) === LB_N));
  lru.unpark(LB);
  check("unpark re-attaches them", lbBatches().length === 4 && kept.every((b) => b.parent === s3.buildingsGroup));
  lru.park(LB);
  lru.disposeParked(LB);
  check("disposeParked disposes the stashed batches + releases their variant holds",
    kept.every((b) => b.userData.__disposed === true) && BMV.batchMatVariantStats().holders === holdersBefore - 4,
    `holders ${holdersBefore} -> ${BMV.batchMatVariantStats().holders}`);
  // A fresh bake for evict (LB re-streams).
  const sceneC = makeScene(cache);
  await B.bakeBuildingsForLandblock(sceneC, 0xa2, 0x1e, null, wasm);
  const s4 = mkLruScene(sceneC.buildingsGroup);
  const lru2 = new LandblockLRU({ scene3d: s4, maxResident: 8, getCurrentLbId: () => null });
  lru2.track(LB);
  const live = s4.buildingsGroup.children.filter((c) => c.isBatchedMesh);
  lru2.evict(LB);
  check("evict removes + disposes the landblock's batches, leaves the neighbour's singletons",
    live.length === 4 && live.every((b) => b.parent === null && b.userData.__disposed === true) &&
      s4.buildingsGroup.children.length === 3 &&
      s4.buildingsGroup.children.every((c) => (((c.userData.landblockId >>> 0) & 0xffff0000) >>> 0) === LB_N));
  check("source geometries are the bake cache's and survive (re-bake needs them)",
    [...sceneC.buildingBakeCache.values()].every((bk) => bk.parts.every((p) => p.groups.every((g) => g.geometry.attributes.position.array.length > 0))));
}

// ---------------------------------------------------------------------------
console.log("\n-- B10 source wiring -------------------------------------------------");
{
  const BLD = src("scene3d/buildings.js");
  const LRU = src("scene3d/landblock_lru.js");
  const DOC = src("docs/url-flags.md");
  const HAR = src("harness/run-js-headless.mjs");
  check("docs/url-flags.md documents buildingMatBatch (default on, =off escape)",
    /^\| `buildingMatBatch` \| `off`\/`0`\/`false`\/`no` \| \*\*on\*\*/m.test(DOC));
  check("registered as a tier-5 harness entry", /\{ tier: 5, flag: "buildingMatBatch", file: "tests\/building_mat_batch\.test\.mjs" \}/.test(HAR));
  check("reader is the off|0|false|no escape", /get\("buildingMatBatch"\)[\s\S]{0,200}s === "off" \|\| s === "0" \|\| s === "false" \|\| s === "no"/.test(BLD));
  check("legacy atlas route kept behind the flag", /\(!matBatch && BUILDING_BATCH && statAtlasEnabled\(\)\)\s*\n\s*\? addSingletonsToCrossLbAtlas/.test(BLD));
  check("env-detail shells still bypass pools + batches (order the envDetail suite pins)",
    /function _feedBuildingGroupsToAtlas[\s\S]*?_carriesEnvDetail[\s\S]*?addSingletonsToPools[\s\S]*?consolidateBuildingSurfaces/.test(BLD));
  check("per-LB baker prewarms the BATCHED nodes before attach",
    /_matBatchActive\(scene3d\)\) \{[\s\S]{0,600}deferAttach: true[\s\S]{0,300}prewarmSubtree\(scene3d, _tmp\)/.test(BLD));
  check("LRU evict + disposeParked dispose building BatchedMeshes",
    /buildingMatBatch[\s\S]{0,600}for \(const c of kill\) \{\s*\n\s*if \(c\?\.isBatchedMesh/.test(LRU) &&
      /for \(const c of p\.buildings \|\| \[\]\) \{\s*\n\s*if \(c\?\.isBatchedMesh/.test(LRU));
}

BC7._setBc7SupportForTest(null);
B.__setBuildingMatBatchForTest(undefined);
console.log(`\nbuilding_mat_batch: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
