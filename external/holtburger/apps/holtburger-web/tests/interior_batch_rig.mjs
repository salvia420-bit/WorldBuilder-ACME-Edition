// tests/interior_batch_rig.mjs — the shared world for the R3-5 `?interiorBatch`
// suites (tests/interior_batch_*.test.mjs). Not a test itself.
//
// One fixture landblock built by the REAL cells.js buildEnvCellsForLandblock
// from a fake wasm (cells, props, surfaces), with member materials from the
// REAL MaterialCache ladders (`_materialFromFlags` over adapter.js textures,
// then getCachedCellBaked / getCachedStaticBias: the clones and chains the
// app draws with), rendered by three r184's real WebGLRenderer against the
// recording fake WebGL2 (tests/helpers/fake_webgl2.mjs). Every draw three
// submits goes through `renderer.renderBufferDirect`, which the rig records
// per pass (colour / shadow), so a suite can compare what a flag-off world
// and a flag-on world DRAW for each pass the app renders interiors in.
//
// This file does NOT import interior_batch.js statically: the flag-off golden
// (tests/fixtures/interior_batch_flag_off.golden.json) is generated through it
// from the pre-change tree, where that module does not exist.

import * as THREE from "three";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";

// --- the URL every cells.js instance of the suites sees at import ------------
// The occlusion culler and the aperture cull only narrow the visible set BEFORE
// the three container.visible writes; the walks script that set directly.
export const BASE_SEARCH = "?noEnvcellTimeSlice=1&occlusionCull=off&interiorApertureCull=off";

/** Import a fresh cells.js instance under `extra` URL params (the walls-first test's trick). */
export async function loadCells(extra = "") {
  const search = BASE_SEARCH + (extra ? "&" + extra : "");
  globalThis.window ??= {};
  globalThis.location = { search };
  globalThis.window.location = globalThis.location;
  const mod = await import("../scene3d/cells.js" + (extra ? "?" + extra : ""));
  globalThis.location = { search: BASE_SEARCH };
  globalThis.window.location = globalThis.location;
  return mod;
}

// --- fixture -----------------------------------------------------------------
export const LB = 0xa9b40000; // Holtburg's block: realistic f32 magnitudes (x ~ 32.4 km)
export const LB_X = ((LB >>> 24) & 0xff) * 192;
export const LB_Y = ((LB >>> 16) & 0xff) * 192;
export const CELL = (n) => (LB | (0x100 + n)) >>> 0;

// Surfaces: did -> { flags, w, h, nrm }
//  0x2 Base1Image (opaque), 0x4 Base1ClipMap (alpha-tested), 0x10 Translucent.
export const SURF = {
  0x08000101: { flags: 0x2, w: 32, h: 32 },
  0x08000102: { flags: 0x2, w: 32, h: 32 },
  0x08000103: { flags: 0x4, w: 32, h: 32 },
  0x08000104: { flags: 0x10, w: 32, h: 32, translucency: 0.5 },
  0x08000105: { flags: 0x2, w: 64, h: 64 },
  0x08000106: { flags: 0x2, w: 32, h: 32, nrm: true },
  0x08000111: { flags: 0x2, w: 16, h: 16 },
  0x08000112: { flags: 0x4, w: 16, h: 16 },
  0x08000113: { flags: 0x10, w: 16, h: 16, translucency: 0.4 },
};

// Props: did -> surfaces (one triangle pair per surface)
export const PROPS = {
  0x02000011: [0x08000111],
  0x02000012: [0x08000111, 0x08000112],
  0x02000013: [0x08000113, 0x08000111],
};

// Cells: n -> { surfaces, origin (LB-local), quat [w,x,y,z], stabs [[did, local x, y, z, quat]] }
const Q = (deg, ax = [0, 0, 1]) => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...ax).normalize(), (deg * Math.PI) / 180);
  return [q.w, q.x, q.y, q.z];
};
export const CELLS = {
  0: { surfaces: [0x08000101, 0x08000102, 0x08000103], origin: [100.25, 80.5, 12.0], quat: Q(90), stabs: [[0x02000011, 101.5, 81.25, 12.5, Q(30)], [0x02000012, 102.5, 79.75, 12.25, Q(-45)]] },
  1: { surfaces: [0x08000101, 0x08000104], origin: [110.75, 80.5, 12.0], quat: Q(0), stabs: [[0x02000011, 111.5, 81.0, 12.0, Q(10, [1, 0, 0])]] },
  2: { surfaces: [0x08000105, 0x08000102], origin: [100.25, 92.0, 12.0], quat: Q(180), stabs: [] },
  3: { surfaces: [0x08000106], origin: [120.0, 60.0, 4.0], quat: Q(45), stabs: [[0x02000013, 121.0, 61.0, 4.5, Q(0)]] },
};
export const CELL_IDS = Object.keys(CELLS).map((n) => CELL(+n));

function cellMesh(surfaces, baked = true) {
  const tris = surfaces.length * 2;
  const pos = new Float32Array(tris * 9);
  const uv = new Float32Array(tris * 6);
  const nrm = new Float32Array(tris * 9);
  const sidx = new Uint8Array(tris);
  const bl = new Uint8Array(tris * 9);
  for (let s = 0; s < surfaces.length; s += 1) {
    for (let k = 0; k < 2; k += 1) {
      const t = s * 2 + k;
      const x0 = s * 1.5 + 0.125, y0 = k * 1.25 + 0.0625;
      const v = [[x0, y0, 0.5 * s], [x0 + 1.37, y0 + 0.11, 0.5 * s + 0.25], [x0 + 0.21, y0 + 1.19, 0.5 * s + 0.0625]];
      for (let j = 0; j < 3; j += 1) {
        pos.set(v[j], t * 9 + j * 3);
        uv.set([((j * 0.37 + t * 0.11) % 1), ((j * 0.53 + s * 0.17) % 1)], t * 6 + j * 2);
        const n = new THREE.Vector3(0.1 * s, 0.2 * k, 1).normalize();
        nrm.set([n.x, n.y, n.z], t * 9 + j * 3);
        bl.set([(40 + t * 7 + j) & 255, (90 + s * 11) & 255, (200 - t * 3) & 255], t * 9 + j * 3);
      }
      sidx[t] = s;
    }
  }
  const m = {
    triCount: tris, positions: pos, uvs: uv, normals: nrm, surfaceIndices: sidx, surfaces: new Uint32Array(surfaces),
    freed: 0, free() { this.freed += 1; },
  };
  if (baked) m.bakedLightRgb = bl;
  return m;
}

function placement(n, opts) {
  const c = (opts.table || CELLS)[n];
  return {
    cellId: CELL(n),
    environmentId: 0x0d000001,
    cellOriginX: LB_X + c.origin[0], cellOriginY: LB_Y + c.origin[1], cellOriginZ: c.origin[2],
    cellOrientationQw: c.quat[0], cellOrientationQx: c.quat[1], cellOrientationQy: c.quat[2], cellOrientationQz: c.quat[3],
    takePortalCellIds: () => [],
    takeMesh: () => cellMesh(c.surfaces, opts.baked !== false),
    takeStaticObjects: () => c.stabs.map(([did, x, y, z, q]) => ({
      did, x: LB_X + x, y: LB_Y + y, z, qw: q[0], qx: q[1], qy: q[2], qz: q[3], defaultScriptId: 0, defaultAnimationId: 0, free() {},
    })),
    free() {},
  };
}

/**
 * A synthetic big landblock (the R3-5 budget suite): `n` cells on a grid in
 * the fixture landblock, each with three of the fixture surfaces (opaque,
 * opaque / normal-mapped, alpha-tested) and two props.
 */
export function bigTable(n) {
  const out = {};
  const opaque = [0x08000101, 0x08000102, 0x08000105, 0x08000106];
  for (let i = 0; i < n; i += 1) {
    const gx = i % 16, gy = (i / 16) | 0;
    const x = 8 + gx * 11.5, y = 8 + gy * 11.5;
    out[i] = {
      surfaces: [opaque[i % 4], opaque[(i + 1) % 4], 0x08000103],
      origin: [x, y, 12.0], quat: Q((i * 37) % 360),
      stabs: [[0x02000011, x + 1.5, y + 1.25, 12.5, Q(30)], [0x02000012, x + 2.5, y - 1.75, 12.25, Q(-45)]],
    };
  }
  return out;
}

// --- the env-cell draw pools (`?drawPools`, DEFAULT ON since 2026-10-25) --------
// Two page-dim surfaces (256^2 RGBA8: the pools' class page admits them; the
// 16-64 px fixture surfaces are refused `needsResample` and stay on the legacy
// producer, fused, exactly as the D2 residue does live).
export const SURF_POOLED = {
  0x08000201: { flags: 0x2, w: 256, h: 256 },
  0x08000202: { flags: 0x2, w: 256, h: 256 },
};
/**
 * The fixture cells with pooled surfaces in their shells: cell 0 shares its
 * shell (one pooled, three legacy), cell 1's opaque shell is wholly pooled
 * (its translucent surface and its prop stay legacy: no opaque fused mesh),
 * cell 2 has none, cell 3 shares (one pooled, one legacy). Props unchanged.
 */
export const POOL_CELLS = {
  0: { ...CELLS[0], surfaces: [0x08000201, ...CELLS[0].surfaces] },
  1: { ...CELLS[1], surfaces: [0x08000202, 0x08000201, 0x08000104] },
  2: CELLS[2],
  3: { ...CELLS[3], surfaces: [0x08000202, ...CELLS[3].surfaces] },
};
/** cellId -> the surface dids of POOL_CELLS a pool takes (the page-dim ones). */
export const POOLED_DIDS = new Map(Object.entries(POOL_CELLS).map(([n, c]) => [CELL(+n), c.surfaces.filter((d) => SURF_POOLED[d])]));
/**
 * The search the pools arm under: the shipped default chain (slotGrid,
 * packSource, geomBundles, texCompressedOnly: pipeline_flags.js
 * PIPELINE_DEFAULT_ON) spelled out, with `frameWork=off` — stage A, the feed
 * commits inline at the offer. The shipped stage B (a resumable W3 feed under
 * the slot grid's tile states) needs the grid, which no node rig has; the
 * offer verdict, the bucketed residue and the per-cell index it leaves are
 * the same, only the commit lands later.
 */
export const POOL_SEARCH = "?drawPools=on&slotGrid=on&packSource=on&geomBundles=on&texCompressedOnly=on&frameWork=off";

/** The pool modules (dynamic: the rig's static graph stays the golden's). */
export async function poolModules() {
  return {
    producer: await import("../scene3d/pool_producer.js"),
    registry: await import("../scene3d/pool_registry.js"),
    envcells: await import("../scene3d/pool_envcells.js"),
    fix: await import("../scene3d/three_batchedmesh_colortexture_fix.js"),
  };
}

/** Drop the pooled world (every module singleton), so the next arm starts clean. */
export async function resetPools() {
  const P = await poolModules();
  P.producer._resetPoolWorldForTest();
  P.registry._resetDrawPoolsForTest();
  P.envcells._resetEnvCellPoolsForTest();
  return P;
}

/**
 * Arm the pooled world on world `w` EXACTLY as scene3d/index.js arms it
 * (the BatchedMesh colour-texture fix first, `initPoolWorld({ THREE, group:
 * staticsGroup })`, then `armEnvCellPoolGroups({ staticsGroup, cellsGroup,
 * indoorLayer: 1 })`), under POOL_SEARCH. Call before the build. Returns
 * the pool modules and the registry.
 */
export async function armPools(w, search = POOL_SEARCH) {
  const P = await resetPools();
  P.fix.applyBatchedMeshColorTextureFix(THREE);
  const wn = console.warn;
  console.warn = () => {};
  try {
    if (!P.producer.initPoolWorld({ THREE, group: w.scene3d.staticsGroup, search })) throw new Error("rig: the pooled world did not arm");
  } finally { console.warn = wn; }
  if (!P.envcells.armEnvCellPoolGroups({ staticsGroup: w.scene3d.staticsGroup, cellsGroup: w.scene3d.cellsGroup, indoorLayer: 1 })) throw new Error("rig: envcell groups did not arm");
  if (!P.envcells.envCellPoolsActive()) throw new Error("rig: envcell pools inactive");
  return { ...P, reg: P.registry.getPoolRegistry() };
}

/** The pools' per-cell state: cellId -> { instances, hidden } (the registry's own index). */
export function poolCellStates(reg) {
  const out = new Map();
  for (const [cellId, mems] of reg._cellIndex) {
    let instances = 0, hidden = 0;
    for (const mem of mems) {
      const ids = (mem.cellRanges && mem.cellRanges.get(cellId)) || [];
      instances += ids.length;
      for (const id of ids) if (mem.hiddenCells && mem.hiddenCells.has(id)) hidden += 1;
    }
    out.set(cellId >>> 0, { instances, hidden });
  }
  return out;
}

/**
 * The pooled instances one pass DREW: for every draw record of a pool
 * BatchedMesh, its visible instances, keyed `pool:<cell>:<pool key>:<id>`.
 */
export function poolDrawnKeys(reg, recs) {
  const out = new Set();
  const memsOf = new Map();
  for (const byTile of reg.tiles.values()) {
    for (const mem of byTile.values()) {
      const l = memsOf.get(mem.pool.mesh) || [];
      l.push(mem);
      memsOf.set(mem.pool.mesh, l);
    }
  }
  for (const r of recs) {
    const mems = memsOf.get(r.object);
    if (!mems) continue;
    for (const mem of mems) {
      for (const [cellId, ids] of mem.cellRanges || []) {
        for (const id of ids) if (r.object.getVisibleAt(id)) out.add(`pool:${(cellId >>> 0).toString(16)}:${mem.pool.key}:${id}`);
      }
    }
  }
  return out;
}

/** The fake wasm a build reads (cells.js buildEnvCellsForLandblock); `opts.table` swaps the fixture cells. */
export function fakeWasm(opts = {}) {
  const table = opts.table || CELLS;
  return {
    fetchEnvCellsInLandblock: async () => Object.keys(table).filter((n) => !opts.cells || opts.cells.includes(+n)).map((n) => placement(+n, opts)),
    fetch_surfaces_pixels: async () => [],
    fetch_model_meshes: async (ids) => {
      if (opts.mmGate) await opts.mmGate;
      return Array.from(ids, (id) => cellMesh(PROPS[id >>> 0] || [0x08000111], false));
    },
  };
}

function pixels(w, h, seed) {
  const a = new Uint8Array(w * h * 4);
  for (let i = 0; i < a.length; i += 1) a[i] = (i * 31 + seed * 17) & 255;
  for (let i = 3; i < a.length; i += 4) a[i] = ((i >> 2) * 13 + seed) & 255; // alpha varies: the ClipMap test matters
  return a;
}

/**
 * A seam-height plane like holtburger_dat::height_seam's (255 = proud face,
 * joints dip toward 0): a brick bond whose mortar lines carve to 40, so the
 * POM march really moves the sampled uv.
 */
export function heightPixels(w, h, seed = 0) {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const row = (y >> 2) & 1;
      const joint = (y & 3) === 0 || (((x + row * 4 + seed) & 7) === 0);
      a[y * w + x] = joint ? 40 + ((x * 7 + y * 3 + seed) & 15) : 230 + ((x + y + seed) & 15);
    }
  }
  return a;
}

/** A tangent-space normal plane with a gentle per-texel tilt (RGB). */
function normalPixels(w, h, seed = 0) {
  const a = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i += 1) { a[i * 3] = 120 + ((i * 5 + seed) & 15); a[i * 3 + 1] = 120 + ((i * 3 + seed) & 15); a[i * 3 + 2] = 250; }
  return a;
}

/**
 * A real MaterialCache with every fixture surface installed (preload is a no-op).
 * `opts.pom` (2026-10-31, POM members): the cache built the way the ultra
 * preset builds it (`pomEnabled`), every surface with a normal and a seam-height
 * plane and the Stone category — so materials.js's own `_materialFromFlags`
 * installs its POM patch on every surface it applies to (opaque and ClipMap;
 * never translucent), and the clone families copy the flag.
 */
export async function materialCache(M, adapter, surf = SURF, opts = {}) {
  const mc = new M.MaterialCache(opts.pom ? { pomEnabled: true } : undefined);
  for (const [didS, s] of Object.entries(surf)) {
    const did = +didS;
    const tex = adapter.surfacePixelsToTexture(pixels(s.w, s.h, did & 255), s.w, s.h);
    const ntex = s.nrm || opts.pom ? adapter.surfacePixelsToNormalTexture(opts.pom ? normalPixels(s.w, s.h, did & 255) : new Uint8Array(s.w * s.h * 3).fill(128), s.w, s.h) : null;
    const htex = opts.pom ? adapter.surfacePixelsToHeightTexture(heightPixels(s.w, s.h, did & 7), s.w, s.h) : null;
    const m = mc._materialFromFlags(s.flags, tex, opts.pom ? M.SURFACE_CATEGORY.Stone : undefined, ntex, undefined, htex,
      { translucency: s.translucency ?? 0, luminosity: 0, diffuse: 1, hasPalette: true });
    mc.materials.set(did >>> 0, m);
  }
  mc.preload = async () => {};
  return mc;
}

// --- the world ----------------------------------------------------------------

/**
 * A scene3d shaped like index.js's (worldRoot with the AC -> three rotation,
 * the five world groups, cellsGroup on layer 1), a real WebGLRenderer on the
 * fake WebGL2 with a sun shadow map, a camera that sees the whole fixture.
 * `opts.record` records canvas listeners and shader sources; `opts.pom` builds
 * the POM material cache (`materialCache` above).
 */
export async function makeWorld(deps, opts = {}) {
  const { M, adapter } = deps;
  const sources = [];
  const calls = [];
  const gl = createFakeWebGL2({
    onCall: opts.recordShaders || opts.recordCalls
      ? (n, a) => {
        if (n === "shaderSource" && opts.recordShaders) sources.push(String(a[1]));
        if (opts.recordCalls) calls.push([n, Array.from(a)]);
      }
      : undefined,
  });
  const canvas = fakeCanvas(gl);
  const listeners = {};
  canvas.addEventListener = (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); };
  canvas.removeEventListener = (type, fn) => {
    const l = listeners[type] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };
  let lost = false;
  gl.isContextLost = () => lost;
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  const threeListenerCount = Object.values(listeners).reduce((n, l) => n + l.length, 0);
  renderer.shadowMap.enabled = opts.shadows !== false;
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.name = "worldRoot";
  worldRoot.rotation.x = -Math.PI / 2;
  const groups = {};
  for (const n of ["terrain", "buildings", "statics", "cells", "entities"]) {
    const g = new THREE.Group();
    g.name = n;
    groups[n] = g;
    worldRoot.add(g);
  }
  groups.cells.layers.set(1);
  scene.add(worldRoot);
  worldRoot.updateMatrixWorld(true);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.name = "sun";
  sun.castShadow = true;
  sun.layers.enableAll();
  const cx = LB_X + 110, cy = LB_Y + 80; // AC -> three: (x, z, -y)
  sun.position.set(cx, 400, -cy + 50);
  sun.target.position.set(cx, 0, -cy);
  Object.assign(sun.shadow.camera, { left: -300, right: 300, top: 300, bottom: -300, near: 1, far: 2000 });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun, sun.target);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 20000);
  camera.position.set(cx, 420, -cy + 1);
  camera.lookAt(cx, 0, -cy);
  camera.layers.enableAll();
  camera.updateMatrixWorld(true);
  const mc = await materialCache(M, adapter, opts.pools ? { ...SURF, ...SURF_POOLED } : SURF, { pom: opts.pom === true });
  const scene3d = {
    scene, worldRoot, camera, renderer,
    terrainGroup: groups.terrain, buildingsGroup: groups.buildings, staticsGroup: groups.statics,
    cellsGroup: groups.cells, entitiesGroup: groups.entities,
    cellContainers3d: new Map(), envCellLoadedLbs: new Set(), materialCache: mc,
    shadowsEnabled: opts.shadows !== false,
    frameTime: { tsMs: 1000, tsSec: 1, dt: 0.016 },
    atmospherePipeline: { setIndoorSplitArmed() {}, setIndoorLandscapeSkip() {}, portalSealPass: { setApertures() {}, outdoorRemainder: null } },
  };
  const draws = [];
  const rbd = renderer.renderBufferDirect;
  renderer.renderBufferDirect = function recordDraw(cam, sc, geometry, material, object, group) {
    draws.push({ object, material, group, shadow: material && material.isMeshDepthMaterial === true });
    return rbd.call(this, cam, sc, geometry, material, object, group);
  };
  return {
    gl, renderer, scene, worldRoot, camera, scene3d, mc, sun, listeners, sources, calls, draws, threeListenerCount,
    loseContext() { lost = true; for (const fn of [...(listeners.webglcontextlost || [])]) fn({ preventDefault() {} }); },
    restoreContext() { lost = false; for (const fn of [...(listeners.webglcontextrestored || [])]) fn({}); },
  };
}

/**
 * The clock the flag-on suites hand the module's per-sync CPU budget
 * (`__setInteriorBatchEnvForTest({ now })`): frozen, so the fixture's whole
 * plan / class set-up / merge lands in the sync it would on a fast machine,
 * whatever this machine's load. The budget slicing itself is proven with an
 * advancing clock in tests/interior_batch_budget.test.mjs.
 */
export const FROZEN_CLOCK = () => 0;

export const settle = async (n = 40) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

/**
 * Build the fixture LB through cells.js, quietly. `extra`: URL params the
 * build reads at call time (`envcellFusion=off`).
 */
export async function build(cells, w, wasmOpts = {}, extra = "") {
  const l = console.log, i = console.info, wn = console.warn;
  console.log = () => {}; console.info = () => {}; console.warn = () => {};
  if (extra) { globalThis.location = { search: BASE_SEARCH + "&" + extra }; globalThis.window.location = globalThis.location; }
  try {
    return await cells.buildEnvCellsForLandblock(w.scene3d, LB, fakeWasm(wasmOpts));
  } finally {
    console.log = l; console.info = i; console.warn = wn;
    if (extra) { globalThis.location = { search: BASE_SEARCH }; globalThis.window.location = globalThis.location; }
  }
}

// --- the session the visibility tick reads ------------------------------------
export function makeSession(state) {
  return {
    getCurrentCellId: () => state.player,
    isCurrentCellIndoor: () => state.indoor,
    isCurrentCellSeenOutside: () => true,
    isCellSeenOutside: () => true,
    getRenderSet: () => [state.player, ...(state.bfs || [])],
    getViewerRenderSet: () => state.bfs || [state.player],
    getRenderSetWithFrustum: () => state.frustum,
    getRenderSetWithPView: () => state.walk,
    getLocalPlayerPose: () => ({ landblockId: state.player, x: 100, y: 80, z: 12, free() {} }),
    terrainHeightAt: () => 0,
    resolveViewerCell: () => state.player,
    setViewerCell() {},
    getPViewOutsidePortals: () => Float32Array.from([0]),
    getVisiblePortalApertures: () => Float32Array.from([0]),
    currentDungeonHasOutdoorPortal: () => true,
  };
}

/** One app frame's tick (cells.js tickCellVisibility3D; the frame clock advances). */
export function tick(cells, w, session) {
  w.scene3d.frameTime = { tsMs: w.scene3d.frameTime.tsMs + 16.7, tsSec: 0, dt: 0.0167 };
  const l = console.log;
  console.log = () => {};
  try { cells.tickCellVisibility3D(w.scene3d, session); } finally { console.log = l; }
}

// --- passes (design T1) ----------------------------------------------------------
export const MASK_BOTH = 3, MASK_WORLD = 1, MASK_INDOOR = 2;

/** Render once with the camera on `mask`; returns this render's draw records. */
export function renderPass(w, mask, { shadow = false, hide = null } = {}) {
  const sm = w.renderer.shadowMap;
  sm.autoUpdate = false;
  sm.needsUpdate = !!shadow;
  const saved = w.camera.layers.mask;
  w.camera.layers.mask = mask;
  const hidden = [];
  if (hide) for (const o of hide) { if (o.visible) { o.visible = false; hidden.push(o); } }
  const from = w.draws.length;
  try {
    w.renderer.render(w.scene, w.camera);
  } finally {
    for (const o of hidden) o.visible = true;
    w.camera.layers.mask = saved;
  }
  return w.draws.slice(from);
}

/**
 * Every pass that can draw interiors (design T1): the unsplit world pass
 * (camera mask BOTH), the split world pass (WORLD_ONLY) and cells pass
 * (INDOOR_ONLY), drawOutdoorRemainder (INDOOR with every non-kept worldRoot
 * child hidden: portal_punch.js collectOutdoorRemainderHidden) and the sun
 * shadow raster (layer test against the main camera's BOTH mask).
 */
export function renderAllPasses(w, collectOutdoorRemainderHidden) {
  const rem = collectOutdoorRemainderHidden({
    worldRoot: w.worldRoot, buildingsGroup: w.scene3d.buildingsGroup, staticsGroup: w.scene3d.staticsGroup, entitiesGroup: w.scene3d.entitiesGroup,
  }, []);
  const colour = (d) => d.filter((r) => !r.shadow);
  return {
    unsplit: colour(renderPass(w, MASK_BOTH)),
    world: colour(renderPass(w, MASK_WORLD)),
    cells: colour(renderPass(w, MASK_INDOOR)),
    remainder: colour(renderPass(w, MASK_INDOOR, { hide: rem.slice() })),
    shadow: renderPass(w, MASK_BOTH, { shadow: true }).filter((r) => r.shadow),
  };
}

// --- flag-off snapshot (L1 golden) -----------------------------------------------
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

const VOLATILE = new Set(["uuid", "id", "parent", "children", "matrix", "matrixWorld", "modelViewMatrix", "normalMatrix", "position", "quaternion", "rotation", "scale", "up", "layers", "geometry", "material", "userData", "animations", "_onChangeCallback"]);

/** The scene graph below `root`: per node its shape (no ids, no matrices). */
export function graphShape(root) {
  const out = [];
  root.traverse((o) => {
    const own = Object.keys(o).filter((k) => !VOLATILE.has(k)).sort();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    out.push({
      name: o.name, type: o.type, layers: o.layers.mask, visible: o.visible, castShadow: o.castShadow, receiveShadow: o.receiveShadow,
      frustumCulled: o.frustumCulled, ownKeys: own, ownSphere: Object.prototype.hasOwnProperty.call(o, "boundingSphere"),
      userData: Object.keys(o.userData || {}).sort(),
      programKeys: mats.map((m) => (typeof m.customProgramCacheKey === "function" ? String(m.customProgramCacheKey()).slice(0, 200) : null)),
      geometry: o.geometry ? Object.keys(o.geometry.attributes).sort().join(",") + (o.geometry.index ? "|i" : "") + "|" + (o.geometry.groups || []).length : null,
      children: o.children.length,
    });
  });
  return out;
}

/**
 * The L1 golden: build + 200 ticks of the fixture LB (a scripted walk:
 * outdoors, a doorway, indoors, out again) through `cells` with the flag off,
 * a render after every tick. Returns a JSON-able object.
 */
export async function flagOffSnapshot(cells, deps, kit) {
  const w = await makeWorld(deps, { recordShaders: true });
  await build(cells, w);
  const state = { player: (LB | 0x31) >>> 0, indoor: false, frustum: [], walk: [], bfs: [] };
  const sh = makeSession(state);
  const script = (f) => {
    if (f < 40) { state.player = (LB | 0x31) >>> 0; state.indoor = false; state.frustum = f % 10 < 5 ? [CELL(0), CELL(1)] : [CELL(1)]; state.walk = []; state.bfs = []; }
    else if (f < 120) { state.player = CELL(0); state.indoor = true; state.frustum = [CELL(0), CELL(2)]; state.walk = f % 7 === 0 ? [CELL(0), CELL(1), CELL(3)] : [CELL(0), CELL(1)]; state.bfs = [CELL(1)]; }
    else { state.player = (LB | 0x31) >>> 0; state.indoor = false; state.frustum = f % 20 < 10 ? [CELL(3)] : [CELL(0), CELL(3)]; state.walk = []; state.bfs = []; }
  };
  const visTrace = [];
  for (let f = 0; f < 200; f += 1) {
    script(f);
    tick(cells, w, sh);
    w.renderer.shadowMap.autoUpdate = true;
    w.renderer.render(w.scene, w.camera);
    const vis = [];
    for (const [id, c] of w.scene3d.cellContainers3d) if (c.visible) vis.push((id & 0xfff).toString(16));
    visTrace.push(vis.sort().join(","));
  }
  const win = typeof window !== "undefined" ? Object.keys(window).filter((k) => k.startsWith("__")).sort() : [];
  return {
    graph: graphShape(w.worldRoot),
    scene3dKeys: Object.keys(w.scene3d).sort(),
    windowGlobals: win.filter((k) => /interior|ibatch/i.test(k)),
    containerUserData: [...w.scene3d.cellContainers3d.values()].map((c) => Object.keys(c.userData).sort()),
    canvasListeners: Object.fromEntries(Object.entries(w.listeners).map(([k, v]) => [k, v.length])),
    shaderSources: [...new Set(w.sources.map(fnv))].sort(),
    programs: w.renderer.info.programs.map((p) => fnv(String(p.cacheKey))).sort(),
    drawsPerFrame: w.draws.length / 200,
    visTrace: fnv(visTrace.join("|")),
    kit: kit.kitSummary(),
  };
}
