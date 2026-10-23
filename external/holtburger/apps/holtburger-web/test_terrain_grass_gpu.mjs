// test_terrain_grass_gpu.mjs — GPU grass placement, INTEGRATION
// (`?terrainGrassGpu`, `scene3d/terrain_grass.js`; contract
// docs/2026-10-23-grass-gpu-placement.md "Integration").
//
// Run with:
//   cd apps/holtburger-web && node test_terrain_grass_gpu.mjs
//   (HB_CELL_DAT / HB_PORTAL_DAT override ~/ac_base_dats/client_{cell_1,portal}.dat)
//
// Locks:
//  G0  CONFIG — `resolveGrassConfig` carries `gpu` (override > the flag reader);
//      the provider's `mode` follows it; a caller's material keeps the CPU path.
//  G1  END-TO-END PARITY ON REAL LANDBLOCKS (client_cell_1.dat, 7x7 around
//      Holtburg 0xA9B4, plus the real EnvCells of the player's 3x3 from
//      client_cell_1.dat + client_portal.dat). The REAL CPU provider vs the REAL
//      GPU provider built from the same inputs: the placement mirror driven by
//      the GPU provider's own ring states (the values bound as uniforms), its own
//      terrain field (`sampleMirror` over the texture arrays after
//      `field.update`) and its own interior mask (`gpuContainsMirror` over the
//      texture arrays), every instance of every ring, matched by WORLD CELL
//      against the CPU pools. Ultra and high layouts; Holtburg centre (town,
//      roads, buildings), a landblock corner, the owner's road screenshot spot.
//      Tolerances: live-set mismatch <= 0.5 % per ring; position within 1e-3 m
//      PLUS the f32 storage quantum of the CPU value (see the note below);
//      normal and per-blade scalars within 1e-4; mismatches + out-of-tolerance
//      blades <= 0.5 %. The measured rates are printed ([info]).
//      THE EARLY-OUT (2026-10-23, review integ-1 / gpu-cost-1): a JS port of
//      the GPU main block's fade x dissolve decision, over every mapped cell,
//      = the CPU's own zero-size decision (fadeFor / grassLodKeep / the
//      dissolve over its rand(7)); the blades the GPU draws at non-zero size =
//      the CPU's live non-zero blades (<= 0.5 % per ring, f32).
//  G2  THE GPU BUILD (real three) — one Mesh per ring over an
//      InstancedBufferGeometry with NO instanced attributes, frustumCulled
//      false, castShadow false, no InstancedMesh anywhere, ONE shared field and
//      mask bound by reference; onBeforeCompile output holds the hash, the
//      field GLSL, the mask GLSL and the placement functions exactly once, no
//      instanceMatrix in any grass snippet, the placement before
//      beginnormal_vertex, every declared uniform bound, and the SAME source
//      for every ring (one program); the fragment stage is the CPU one. The
//      early-out's lines ARE the shared snippet's (names swapped); a zero
//      scale is the last thing that touches the blade (degenerate = dead);
//      a dead blade skips the look but writes transformed and vGrassTint.
//  G3  onBeforeRender — a real PerspectiveCamera under a rotated + translated
//      worldRoot looking along the run direction: uGpTiles / instanceCount
//      follow the cull, every tile verdict equals an independent reference
//      (disc, dissolve hole, resident z range, three's own Frustum on the
//      world-space box), tiles behind the camera are culled, nearest first;
//      instanceCount is 0-safe (no terrain, looking at the sky, an override
//      material, before the first update). LIVE MARGINS (integ-2): 2 m at the
//      default look; under setLod({heightGain: 2}) + a ?treeWindStrength=4
//      wind amplitude the margins grow to the blade reach, the verdicts follow
//      and tiles the 2 m box would drop are kept; the stomp term only where the
//      trail can reach a sized blade of the ring.
//  G4  PER FRAME — uGpWindowMin / uScatterCenter / radius / fade start follow
//      the player (= grassGpuWindowMin), the field re-walks only on a landblock
//      change, setOffRoad flips uGpOffRoad on every ring (provider and
//      window.__terrainGrass handle), setLodLook rewrites the bands and the cull
//      reads them live, stats() reports mode "gpu" and stays null-safe (before
//      the build, after dispose, rebuilt). The interior mask gets
//      setGpuCenter(p.x, p.y, p.z, outer reach) BEFORE each sync, for a finite
//      p only (lifecycle-1); the CPU path never calls it.
//  G5  FLAG OFF — the CPU path exactly as before: pools, InstancedMesh, the CPU
//      injector's output, no GPU uniform or object anywhere.
//  G7  GLSL FINGERPRINT LOCK (2026-10-23, review tests-1) — the sha256 of the
//      shipped GLSL (harness/glsl_smoke/grass_gpu_fingerprint.mjs) equals the
//      one the browser readback smoke stamped on its last PASS
//      (harness/glsl_smoke/grass_gpu_smoke.stamp.json). On a mismatch or no
//      stamp: re-run 'capped-build node harness/glsl_smoke/grass_gpu_smoke.mjs'
//      (orchestrator only), which rewrites the stamp on PASS.
//
// Positions: the CPU pool stores blade origins in a Float32Array
// (instanceMatrix), and at Holtburg (y ~ 34.6 km) one f32 step is 3.9 mm — the
// CPU's own uploaded value is up to 1.95 mm off its f64 origin, so a flat 1e-3 m
// cannot hold for ANY f32 value there. Same rule as test_grass_gpu_place.mjs.

import { existsSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import * as THREE from "three";

// terrain_grass.js FIRST (the app's order; grass_gpu_place.js imports it back).
import {
  createTerrainGrassProvider, resolveGrassConfig, injectTerrainGrassShader, injectTerrainGrassGpuShader,
  initTerrainGrass, _resetTerrainGrass, GRASS_MARKER, GRASS_END, GRASS_ATTRIBUTES, GRASS_DEFAULTS, grassLodKeep,
} from "./scene3d/terrain_grass.js";
import {
  GRASS_GPU_HASH_GLSL, buildGrassPlaceGlsl, grassGpuPlaceMirror, makeGrassGpuBlade, grassGpuWindowMin,
  grassGpuCellMirror, grassGpuPlaceCellMirror, grassGpuRankMirror, makeGrassGpuCell, grassGpuBladeReach,
  GRASS_GPU_RING_UNIFORMS, GRASS_GPU_CULL_BELOW_M, GRASS_GPU_CULL_ABOVE_M, GRASS_GPU_CULL_XY_MARGIN_M,
} from "./scene3d/grass_gpu_place.js";
import { fadeFor, scatterHash01 } from "./scene3d/terrain_scatter.js";
import { TERRAIN_FIELD_GLSL, FIELD_TEX_SIZE } from "./scene3d/terrain_field_gpu.js";
import { INTERIOR_MASK_GLSL } from "./scene3d/grass_interior_mask.js";
import { createTerrainOracle } from "./scene3d/terrain_oracle.js";
import { lbKeyFromXY } from "./scene3d/landblock_lru.js";
import { _resetVfxFlags } from "./scene3d/vfx_flags.js";
import { lintSource } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

/** f32 spacing at |v| (the storage quantum of a Float32Array value). */
function ulp32(v) {
  const a = Math.abs(v);
  if (!(a > 1e-30)) return 1.4e-45;
  return 2 ** (Math.floor(Math.log2(a)) - 23);
}
const count = (s, sub) => (sub ? s.split(sub).length - 1 : 0);
const hex8 = (id) => (id >>> 0).toString(16).padStart(8, "0");

const ULTRA = { blades: 119716, radiusM: 40, reach: 5 };
const HIGH = { blades: 60025, radiusM: 32, reach: 5 };
const BASE = { density: 1, stomp: false, offRoad: true };

function makeCtx(x, y, z, oracle, scene3d = null, extra = {}) {
  return {
    scene3d, tSec: 1.25, dt: 0.016, hasPlayer: true, camera: null, quality: null,
    playerPos: { x, y, z }, oracle, trail: null, ...extra,
  };
}
function makeProvider(config, { gpu, parent = new THREE.Group(), withThree = true, ...rest } = {}) {
  return createTerrainGrassProvider({
    THREE: withThree ? THREE : null, parent,
    config: { ...BASE, ...config, gpu }, ...rest,
  });
}
/** A fresh three onBeforeCompile `shader` for MeshLambertMaterial (real ShaderLib). */
function lambertShader() {
  return {
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.lambert.uniforms),
  };
}

// ---------------------------------------------------------------------------
// DAT readers — the directory B-tree walk of test_terrain_grass_offroad.mjs, and
// the EnvCell / Environment readers of test_grass_interior_mask_gpu.mjs.
// ---------------------------------------------------------------------------
function openDat(path) {
  const fd = openSync(path, "r");
  const hdr = Buffer.alloc(36);
  readSync(fd, hdr, 0, 36, 0x140);
  const blockSize = hdr.readUInt32LE(4);
  const root = hdr.readUInt32LE(32);
  const readAt = (len, off) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
  const readData = (offset, size) => { // block chain: u32 next, then data
    const out = Buffer.alloc(size);
    let cur = offset, done = 0;
    while (done < size) {
      const next = readAt(4, cur).readUInt32LE(0);
      const take = next === 0 ? size - done : Math.min(size - done, blockSize - 4);
      readAt(take, cur + 4).copy(out, done);
      done += take; cur = next;
    }
    return out;
  };
  const find = (id) => { // 62 branches, count, 24-byte entries ascending by id
    let node = root;
    for (let depth = 0; node && depth < 32; depth += 1) {
      const d = readData(node, 1716);
      const n = d.readUInt32LE(248);
      const leaf = d.readUInt32LE(0) === 0;
      let i = 0;
      for (; i < n; i += 1) {
        const eid = d.readUInt32LE(252 + 24 * i + 4);
        if (eid === id) { const e = 252 + 24 * i; return { offset: d.readUInt32LE(e + 8), size: d.readUInt32LE(e + 12) }; }
        if (eid > id) break;
      }
      if (leaf) return null;
      node = d.readUInt32LE(4 * i);
    }
    return null;
  };
  const get = (id) => { const e = find(id >>> 0); return e ? readData(e.offset, e.size) : null; };
  return { get, close: () => closeSync(fd) };
}

/** CellLandblock: u32 id, u32 hasObjects, u16 terrain[81], u8 height[81]. */
function readLandblock(dat, lbX, lbY) {
  const b = dat.get((((lbX & 0xff) << 24) | ((lbY & 0xff) << 16) | 0xffff) >>> 0);
  if (!b) return null;
  const codes = new Uint8Array(81), roads = new Uint8Array(81), heights = new Float32Array(81);
  for (let v = 0; v < 81; v += 1) {
    const w = b.readUInt16LE(8 + 2 * v);
    roads[v] = w & 0x3;              // the wasm `roadCodes` (raw 2-bit field)
    codes[v] = (w >> 2) & 0x1f;      // the wasm `terrainCodes`
    heights[v] = b[8 + 162 + v] * 2; // retail LandHeightTable == byte*2
  }
  return { lbX, lbY, codes, roads, heights };
}

function cursor(b) {
  let o = 0;
  return {
    get pos() { return o; },
    u8: () => b[o++],
    u16: () => { const v = b.readUInt16LE(o); o += 2; return v; },
    i16: () => { const v = b.readInt16LE(o); o += 2; return v; },
    u32: () => { const v = b.readUInt32LE(o); o += 4; return v; },
    i32: () => { const v = b.readInt32LE(o); o += 4; return v; },
    f32: () => { const v = b.readFloatLE(o); o += 4; return v; },
    skip: (n) => { o += n; },
    align: () => { if (o % 4) o += 4 - (o % 4); },
  };
}
/** ACE EnvCell.Unpack up to the frame: environment, cell structure, origin, quaternion (w x y z). */
function readEnvCell(b) {
  const r = cursor(b);
  const id = r.u32(), flags = r.u32(); r.skip(4);
  const nSurf = r.u8(); r.u8(); r.u16();
  r.skip(2 * nSurf);
  const env = (0x0d000000 | r.u16()) >>> 0;
  const cellStruct = r.u16();
  const origin = [r.f32(), r.f32(), r.f32()];
  const qw = r.f32(), qx = r.f32(), qy = r.f32(), qz = r.f32();
  return { id, flags, env, cellStruct, origin, quat: [qw, qx, qy, qz] };
}
const TAG_PORT = 0x504f5254, TAG_LEAF = 0x4c454146;
const BSP_CELL = 0, BSP_PHYSICS = 1, BSP_DRAWING = 2;
function skipBsp(r, type) {
  const tag = r.u32();
  if (tag === TAG_LEAF) {
    r.i32();
    if (type === BSP_PHYSICS) { r.i32(); r.skip(16); r.skip(2 * r.u32()); }
    return;
  }
  if (tag === TAG_PORT) {
    r.skip(16);
    skipBsp(r, type); skipBsp(r, type);
    if (type === BSP_DRAWING) { r.skip(16); const np = r.u32(), nq = r.u32(); r.skip(2 * np + 4 * nq); }
    return;
  }
  r.skip(16);
  const s = String.fromCharCode(tag >>> 24, (tag >>> 16) & 255, (tag >>> 8) & 255, tag & 255);
  if (s === "BPnn" || s === "BPIn" || s === "BpIN" || s === "BpnN") skipBsp(r, type);
  else if (s === "BPIN" || s === "BPnN") { skipBsp(r, type); skipBsp(r, type); }
  if (type === BSP_CELL) return;
  r.skip(16);
  if (type === BSP_PHYSICS) return;
  r.skip(2 * r.u32());
}
function readPolygons(r, n, used) {
  for (let i = 0; i < n; i += 1) {
    r.u16();
    const np = r.u8(), stip = r.u8(), sides = r.i32(); r.i16(); r.i16();
    for (let k = 0; k < np; k += 1) { const v = r.i16() & 0xffff; if (used) used.push(v); }
    if (!(stip & 4)) r.skip(np);                   // !NoPos
    if (sides === 2 && !(stip & 8)) r.skip(np);    // Clockwise && !NoNeg
  }
}
/** Environment (0x0D): CellStruct key -> the positions its drawing polygons use. */
function readEnvironment(b) {
  const r = cursor(b);
  r.u32();
  const n = r.u32();
  const out = new Map();
  for (let i = 0; i < n; i += 1) {
    const key = r.u32();
    const nPoly = r.u32(), nPhys = r.u32(), nPort = r.u32();
    if (r.i32() !== 1) throw new Error("CellStruct vertex type != 1");
    const nv = r.u32();
    const verts = new Map();
    for (let k = 0; k < nv; k += 1) {
      const vid = r.u16(), nuv = r.u16();
      verts.set(vid, [r.f32(), r.f32(), r.f32()]);
      r.skip(12 + 8 * nuv);
    }
    const used = [];
    readPolygons(r, nPoly, used);
    r.skip(2 * nPort); r.align();
    skipBsp(r, BSP_CELL);
    readPolygons(r, nPhys, null);
    skipBsp(r, BSP_PHYSICS);
    if (r.u32() !== 0) skipBsp(r, BSP_DRAWING);
    r.align();
    const pos = [];
    for (const v of used) { const p = verts.get(v); if (p) pos.push(p[0], p[1], p[2]); }
    out.set(key, new Float32Array(pos));
  }
  return { cells: out, consumed: r.pos === b.length };
}

/**
 * The live shape cells.js builds (worldRoot, AC Z-up -> three Y-up -> cells ->
 * container `envcell-<id>` -> `mesh-<id>` in the cell frame -> structure mesh)
 * for every EnvCell of the 3x3 landblocks around (cx, cy) — cells.js's
 * ENVCELL_RING_RADIUS = 1 — as the scene3d facade the mask syncs from.
 */
function loadRealCells(cellDat, portalDat, cx, cy, envCache) {
  const root = new THREE.Group();
  root.name = "worldRoot";
  root.rotation.x = -Math.PI / 2;
  const cellsGroup = new THREE.Group();
  root.add(cellsGroup);
  const map = new Map();
  let parsed = true;
  for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
    const lx = cx + dx, ly = cy + dy;
    const info = cellDat.get(((lx << 24) | (ly << 16) | 0xfffe) >>> 0); // LandBlockInfo: u32 id, u32 numCells
    if (!info) continue;
    const n = info.readUInt32LE(4);
    for (let c = 0; c < n; c += 1) {
      const id = ((lx << 24) | (ly << 16) | (0x100 + c)) >>> 0;
      const buf = cellDat.get(id);
      if (!buf) continue;
      const ec = readEnvCell(buf);
      if (!envCache.has(ec.env)) {
        const eb = portalDat.get(ec.env);
        const env = eb ? readEnvironment(eb) : { cells: new Map(), consumed: false };
        parsed = parsed && env.consumed;
        envCache.set(ec.env, env);
      }
      const pos = envCache.get(ec.env).cells.get(ec.cellStruct);
      if (!pos || pos.length < 9) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const container = new THREE.Group();
      container.name = `envcell-${hex8(id)}`;
      const mg = new THREE.Group();
      mg.name = `mesh-${hex8(id)}`;
      mg.position.set(lx * 192 + ec.origin[0], ly * 192 + ec.origin[1], ec.origin[2]);
      const [qw, qx, qy, qz] = ec.quat;
      mg.quaternion.set(qx, qy, qz, qw); // cells.js acQuatToThree
      container.add(mg);
      const mesh = new THREE.Mesh(geometry);
      mesh.name = "surfaces-fused-opaque";
      mg.add(mesh);
      cellsGroup.add(container);
      map.set(id, container);
    }
  }
  return { scene3d: { cellContainers3d: map, worldRoot: root }, cells: map.size, parsed };
}

const CELL = process.env.HB_CELL_DAT || "/home/wbterminal/ac_base_dats/client_cell_1.dat";
const PORTAL = process.env.HB_PORTAL_DAT || "/home/wbterminal/ac_base_dats/client_portal.dat";

console.log("GPU grass placement — integration (terrain_grass.js ?terrainGrassGpu)");
console.log("======================================================================");

// ---------------------------------------------------------------------------
console.log("\n-- G0. config + mode --");
{
  _resetVfxFlags();
  check("resolveGrassConfig carries gpu, default TRUE (no window; default on since 2026-10-23)", resolveGrassConfig({ blades: 1024 }).gpu === true);
  check("an explicit gpu override wins", resolveGrassConfig({ blades: 1024, gpu: false }).gpu === false);
  const withFlag = (search, fn) => { globalThis.window = { location: { search } }; _resetVfxFlags(); try { return fn(); } finally { delete globalThis.window; _resetVfxFlags(); } };
  const viaOff = withFlag("?terrainGrassGpu=off", () => [resolveGrassConfig({ blades: 1024 }).gpu, resolveGrassConfig({ blades: 1024, gpu: true }).gpu]);
  check("?terrainGrassGpu=off reaches the config; an explicit true still wins", viaOff[0] === false && viaOff[1] === true);
  check("the escape spellings 0 / false / no / OFF all fall back to the CPU path",
    ["0", "false", "no", "OFF"].every((v) => withFlag(`?terrainGrassGpu=${v}`, () => resolveGrassConfig({ blades: 1024 }).gpu) === false));
  check("=on and an unrecognised value keep the default (GPU)",
    withFlag("?terrainGrassGpu=on", () => resolveGrassConfig({ blades: 1024 }).gpu) === true
    && withFlag("?terrainGrassGpu=maybe", () => resolveGrassConfig({ blades: 1024 }).gpu) === true);
  check("provider mode follows the config (cpu / gpu)",
    makeProvider(ULTRA, { gpu: false }).mode === "cpu" && makeProvider(ULTRA, { gpu: true }).mode === "gpu");
  check("a caller-supplied material keeps the CPU path (it cannot place blades)",
    makeProvider(ULTRA, { gpu: true, material: new THREE.MeshBasicMaterial() }).mode === "cpu");
}

// ---------------------------------------------------------------------------
console.log("\n-- G1. end-to-end parity on real landblocks: GPU provider mirror vs CPU provider pools --");
const LBS = [];
let ORACLE = null;
let cellDat = null, portalDat = null;
const envCache = new Map();
if (!existsSync(CELL) || !existsSync(PORTAL)) {
  console.log(`  real-DAT parity not run: ${existsSync(CELL) ? PORTAL : CELL} missing (set HB_CELL_DAT / HB_PORTAL_DAT)`);
} else {
  cellDat = openDat(CELL);
  portalDat = openDat(PORTAL);
  for (let dx = -3; dx <= 3; dx += 1) for (let dy = -3; dy <= 3; dy += 1) {
    const lb = readLandblock(cellDat, 0xa9 + dx, 0xb4 + dy);
    if (lb) LBS.push(lb);
  }
  check("7x7 landblocks around Holtburg (0xA9B4) read", LBS.length === 49);
  ORACLE = createTerrainOracle();
  for (const lb of LBS) {
    ORACLE.noteLandblock(lbKeyFromXY(lb.lbX, lb.lbY), { codes: lb.codes, heights: lb.heights, roads: lb.roads, lbX: lb.lbX, lbY: lb.lbY });
  }
}

/**
 * Mirror every instance of every ring of the GPU provider (its own ring states,
 * field and mask; all 64 tiles) and match by world cell against the CPU
 * provider's pools.
 */
function parityGpu(cpuP, gpuP, px, py, f64, useIndoor = true) {
  const field = gpuP._field;
  const mask = useIndoor ? gpuP._indoorMask : null;
  const res = { rings: [], mism: 0, liveCpu: 0, liveGpu: 0, matched: 0, fieldOut: 0, worst: {}, geomOk: true, mapOk: true, first: null, firstField: null };
  const bump = (k, v) => { if (!(res.worst[k] >= v)) res.worst[k] = v; };
  const b = makeGrassGpuBlade();
  const allTiles = new Float32Array(64);
  for (let t = 0; t < 64; t += 1) allTiles[t] = t;
  for (let k = 0; k < cpuP._pools.length; k += 1) {
    const pool = cpuP._pools[k];
    const st0 = gpuP._ringStates[k];
    const st = { ...st0, tileIds: allTiles };
    const g = st.g, wmx = st.winMin[0], wmy = st.winMin[1];
    const want = grassGpuWindowMin([px, py], st.radiusM, st.cell);
    if (pool.gridSize !== g || pool.cellSizeM !== st.cell || pool.radiusM !== st.radiusM || pool.seed !== st.seed
      || pool.randSalt !== st.randSalt || want[0] !== wmx || want[1] !== wmy) res.geomOk = false;
    const byCell = new Int32Array(g * g).fill(-1);
    for (let i = 0; i < pool.count; i += 1) {
      const ox = pool._cellX[i] - wmx, oy = pool._cellY[i] - wmy;
      if (ox < 0 || oy < 0 || ox >= g || oy >= g || byCell[ox * g + oy] !== -1) { res.mapOk = false; continue; }
      byCell[ox * g + oy] = i;
    }
    const m = pool.mesh.instanceMatrix.array;
    const A = pool.arrays;
    let ringMism = 0, ringCpu = 0, ringGpu = 0, ringMapped = 0, ringOut = 0;
    for (let id = 0; id < st.maxInstances; id += 1) {
      grassGpuPlaceMirror(id, st, field, mask, b, { f64 });
      if (!b.mapped) continue;
      ringMapped += 1;
      const i = byCell[(b.cellX - wmx) * g + (b.cellY - wmy)];
      if (i < 0) { res.mapOk = false; continue; }
      const cpuLive = pool._live[i] === 1;
      if (cpuLive) ringCpu += 1;
      if (b.live) ringGpu += 1;
      if (cpuLive !== b.live) {
        ringMism += 1;
        if (!res.first) res.first = { ring: k, cell: [b.cellX, b.cellY], cpuLive, gpuLive: b.live, x: b.origin.x, y: b.origin.y };
        continue;
      }
      if (!cpuLive) continue;
      res.matched += 1;
      const cx = m[i * 16 + 12], cy = m[i * 16 + 13], cz = m[i * 16 + 14];
      const nx = A.aNormal[i * 3], ny = A.aNormal[i * 3 + 1], nz = A.aNormal[i * 3 + 2];
      const dxy = Math.max(Math.abs(b.origin.x - cx), Math.abs(b.origin.y - cy));
      const qxy = Math.max(ulp32(cx), ulp32(cy));
      const dz = Math.abs(b.origin.z - cz);
      const slope = Math.sqrt(nx * nx + ny * ny) / Math.max(nz, 1e-3);
      const tolXy = 1e-3 + (f64 ? 1 : 2) * qxy;
      const tolZ = 1e-3 + ulp32(cz) + slope * 3 * qxy;
      const dn = Math.max(Math.abs(b.normal.x - nx), Math.abs(b.normal.y - ny), Math.abs(b.normal.z - nz));
      const ds = Math.max(
        Math.abs(b.scale.x - A.aScale[i * 2]), Math.abs(b.scale.y - A.aScale[i * 2 + 1]),
        Math.abs(b.rot - A.aRot[i]),
        Math.abs(b.tint.x - A.aTint[i * 3]), Math.abs(b.tint.y - A.aTint[i * 3 + 1]), Math.abs(b.tint.z - A.aTint[i * 3 + 2]),
        Math.abs(b.mat - A.aFamilyParam[i]), Math.abs(b.rank - A.aRank[i]),
      );
      bump("xy m", dxy); bump("xy f32 steps", dxy / qxy); bump("z", dz); bump("normal", dn); bump("scalar", ds);
      if (dxy > tolXy || dz > tolZ || dn > 1e-4 || ds > 1e-4) {
        ringOut += 1;
        if (!res.firstField) res.firstField = { ring: k, cell: [b.cellX, b.cellY], dxy, tolXy, dz, tolZ, dn, ds };
      }
    }
    if (ringMapped !== g * g) res.mapOk = false;
    res.mism += ringMism;
    res.fieldOut += ringOut;
    res.liveCpu += ringCpu;
    res.liveGpu += ringGpu;
    res.rings.push({ level: k, g, cpu: ringCpu, gpu: ringGpu, mism: ringMism, out: ringOut });
  }
  return res;
}
/**
 * JS port of the GPU main block's early-out (terrain_grass.js
 * _grassGpuMainSnippet): hbScatterFade on the cell's jittered point (disc,
 * uScatterShape 0), the dissolve with the same expressions over hbGrassRank.
 * `F` = Math.fround emulates the GPU's f32, identity = doubles. True = placed;
 * `sizeOut[0]` (optional) gets fade x dissolve, the blade's size factor.
 */
function earlyOutPlaces(hc, st, u, band, F, sizeOut) {
  if (sizeOut) sizeOut[0] = 0;
  if (!hc.mapped) return false;
  const c01 = (v) => (v <= 0 ? 0 : (v >= 1 ? 1 : v));
  const cx = F(u.uScatterCenter.value.x), cy = F(u.uScatterCenter.value.y);
  const dx = F(hc.x - cx), dy = F(hc.y - cy);
  const dist = F(Math.sqrt(F(F(dx * dx) + F(dy * dy))));
  const R = F(u.uScatterRadius.value), fs = F(u.uScatterFadeStart.value);
  const fade = c01(F(F(R - dist) / Math.max(F(R - fs), F(1e-4))));
  const b0 = F(band[0]), b1 = F(band[1]), b2 = F(band[2]), b3 = F(band[3]);
  const keep = Math.min(c01(F(F(dist - b0) / Math.max(F(b1 - b0), F(1e-4)))), c01(F(F(b3 - dist) / Math.max(F(b3 - b2), F(1e-4)))));
  const soft = Math.max(F(u.uGrassLodSoft.value), F(1e-4));
  const dissolve = c01(F(F(F(keep * F(1 + soft)) - grassGpuRankMirror(hc, st)) / soft));
  if (sizeOut) sizeOut[0] = fade * dissolve;
  return fade > 0 && dissolve > 0;
}

/**
 * The early-out against the CPU: per ring, over every mapped window cell,
 * (a) the f64 port on the GPU provider's own cell + rank vs the CPU's zero-size
 * decision in the CPU's own arithmetic (its f64 blade point, fadeFor,
 * grassLodKeep, the dissolve over its rand(7)); (b) the blades the GPU draws at
 * non-zero size (f32 mirror live AND f32 port places) vs the CPU's live blades
 * at non-zero size (its stored instanceMatrix point and aRank).
 */
function earlyOutParity(cpuP, gpuP, px, py) {
  const res = { rings: [], decisionMism: 0, visMism: 0, visCpu: 0, mapped: 0, skipped: 0, liveZero: 0, live: 0, first: null, sizeMismMax: 0 };
  const field = gpuP._field, mask = gpuP._indoorMask;
  const allTiles = new Float32Array(64);
  for (let t = 0; t < 64; t += 1) allTiles[t] = t;
  const hc = makeGrassGpuCell(), hc64 = makeGrassGpuCell(), b = makeGrassGpuBlade();
  const gpuSize = [0];
  const soft = Math.max(cpuP._ringUniforms[0].uGrassLodSoft.value, 1e-4);
  for (let k = 0; k < cpuP._pools.length; k += 1) {
    const pool = cpuP._pools[k];
    const ring = cpuP._layout[k];
    const st = { ...gpuP._ringStates[k], tileIds: allTiles };
    const u = gpuP._ringUniforms[k];
    const band = gpuP._layout[k].band;
    const g = st.g, wmx = st.winMin[0], wmy = st.winMin[1];
    const byCell = new Int32Array(g * g).fill(-1);
    for (let i = 0; i < pool.count; i += 1) byCell[(pool._cellX[i] - wmx) * g + (pool._cellY[i] - wmy)] = i;
    const m = pool.mesh.instanceMatrix.array;
    let ringDec = 0, ringVis = 0, ringCpuVis = 0, ringMapped = 0, ringSkip = 0, ringLive = 0, ringSize = 0;
    for (let id = 0; id < st.maxInstances; id += 1) {
      grassGpuCellMirror(id, st, hc);
      if (!hc.mapped) continue;
      ringMapped += 1;
      grassGpuCellMirror(id, st, hc64, { f64: true });
      const gpuPlaces64 = earlyOutPlaces(hc64, st, u, band, (v) => v);
      const gpuPlaces = earlyOutPlaces(hc, st, u, band, Math.fround, gpuSize);
      if (!gpuPlaces) ringSkip += 1;
      // (a) the CPU's decision, its own arithmetic, this cell.
      const gx = hc.gx, gy = hc.gy;
      const x = (gx + 0.5 + (scatterHash01(gx, gy, 1, pool.seed) - 0.5) * st.jitter) * pool.cellSizeM;
      const y = (gy + 0.5 + (scatterHash01(gx, gy, 2, pool.seed) - 0.5) * st.jitter) * pool.cellSizeM;
      const cpuRank = Math.fround(scatterHash01(gx, gy, 7 + 16, st.randSeed));
      const fade = fadeFor(x - px, y - py, pool.radiusM, ring.fadeFraction, "disc");
      const keep = grassLodKeep(ring.band, Math.hypot(x - px, y - py));
      const dis = Math.min(1, Math.max(0, (keep * (1 + soft) - cpuRank) / soft));
      const cpuNonZero = fade > 0 && dis > 0;
      if (cpuNonZero !== gpuPlaces64) {
        ringDec += 1;
        if (!res.first) res.first = { ring: k, cell: [gx, gy], cpuNonZero, gpuPlaces64, fade, keep, cpuRank };
      }
      // (b) drawn at non-zero size.
      grassGpuPlaceCellMirror(hc, st, field, mask, b);
      if (b.live) { res.live += 1; if (!gpuPlaces) res.liveZero += 1; }
      const gpuVis = b.live && gpuPlaces;
      const i = byCell[(gx - wmx) * g + (gy - wmy)];
      let cpuVis = false, cpuSize = 0;
      const cpuLive = i >= 0 && pool._live[i] === 1;
      if (cpuLive) {
        ringLive += 1;
        const cxs = m[i * 16 + 12], cys = m[i * 16 + 13];
        const f2 = fadeFor(cxs - px, cys - py, pool.radiusM, ring.fadeFraction, "disc");
        const k2 = grassLodKeep(ring.band, Math.hypot(cxs - px, cys - py));
        const d2 = Math.min(1, Math.max(0, (k2 * (1 + soft) - pool.arrays.aRank[i]) / soft));
        cpuVis = f2 > 0 && d2 > 0;
        cpuSize = f2 * d2;
      }
      if (cpuVis) ringCpuVis += 1;
      if (cpuVis !== gpuVis) ringVis += 1;
      // Both live: then only the early-out's own f32 decision can differ.
      // The size factor the side that draws it has there (0 = nothing).
      if (cpuLive && b.live && cpuVis !== gpuVis) {
        ringSize += 1;
        res.sizeMismMax = Math.max(res.sizeMismMax, cpuSize, gpuSize[0]);
      }
    }
    res.rings.push({ level: k, mapped: ringMapped, skipped: ringSkip, decisionMism: ringDec, live: ringLive, vis: ringCpuVis, visMism: ringVis, sizeMism: ringSize });
    res.decisionMism += ringDec; res.visMism += ringVis; res.visCpu += ringCpuVis; res.mapped += ringMapped; res.skipped += ringSkip;
  }
  return res;
}

const pct = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(3)} %`;
const fmtWorst = (w) => Object.entries(w).map(([k, v]) => `${k} ${v.toExponential(2)}`).join(", ");

if (ORACLE) {
  const SPOTS = [
    ["Holtburg centre, in town with roads (0xA9B4)", 0xa9 * 192 + 96, 0xb4 * 192 + 96],
    ["landblock corner 0xA9B4 / 0xAAB4 / 0xA9B5 / 0xAAB5", 0xaa * 192 + 0.37, 0xb5 * 192 + 0.61],
    ["owner's road screenshot, 42.0N 33.6E", (336 + 1019.5) * 24, (420 + 1019.5) * 24],
  ];
  const LAYOUTS = [["ultra 119716 / 40 m / reach 5", ULTRA], ["high 60025 / 32 m / reach 5", HIGH]];
  const rates = [];
  for (const [sname, px, py] of SPOTS) {
    const lbx = Math.floor(px / 192), lby = Math.floor(py / 192);
    const { scene3d, cells, parsed } = loadRealCells(cellDat, portalDat, lbx, lby, envCache);
    check(`${sname}: the real EnvCells of the player's 3x3 load (${cells}) and every Environment parses to its last byte`,
      cells > 50 && parsed, `${cells} ${parsed}`);
    const pz = ORACLE.heightAt(px, py) + 1.7;
    for (const [lname, layout] of LAYOUTS) {
      const tag = `${lname} @ ${sname}`;
      const cpu = makeProvider(layout, { gpu: false });
      const gpu = makeProvider(layout, { gpu: true });
      cpu.update(0.016, makeCtx(px, py, pz, ORACLE, scene3d));
      gpu.update(0.016, makeCtx(px, py, pz, ORACLE, scene3d));
      const fs = gpu._field.stats();
      const ms = gpu.stats().indoorCull;
      const cs = cpu.stats();
      check(`${tag}: the GPU field mirrors all 49 resident landblocks; the GPU mask holds every interior box (no fold, no overflow)`,
        fs.slotsValid === 49 && ms.boxes > 50 && ms.gpuBoxes === ms.boxes && ms.gpuOverflow === 0 && ms.gpuCollisions === 0
        && ms.gpuBoxOverflow === 0 && cs.indoorCull.boxes === ms.boxes,
        `slots ${fs.slotsValid} boxes ${ms.boxes}/${ms.gpuBoxes} overflow ${ms.gpuOverflow} collisions ${ms.gpuCollisions}`);
      const f = parityGpu(cpu, gpu, px, py, false);
      const e = parityGpu(cpu, gpu, px, py, true);
      rates.push([tag, f.mism, f.fieldOut, f.liveCpu]);
      console.log(`  [info] ${tag}: CPU live ${f.liveCpu} (road rejects ${cs.roadRejects}, indoor rejects ${cs.indoorRejects}); `
        + `GPU-estimate (f32) mismatch ${f.mism} = ${pct(f.mism, f.liveCpu)}, out of tolerance ${f.fieldOut}, `
        + `per ring ${f.rings.map((r) => `${r.level}:${r.mism}/${r.cpu}`).join(" ")}; worst ${fmtWorst(f.worst)}`);
      console.log(`  [info] ${tag}: f64 placement over the same f32 field + mask: mismatch ${e.mism} = ${pct(e.mism, e.liveCpu)}, `
        + `out of tolerance ${e.fieldOut}; worst ${fmtWorst(e.worst)}`);
      check(`${tag}: ring states = the CPU pools (grid, cell, radius, seed, salt, window); every window cell mapped exactly once`,
        f.geomOk && f.mapOk && e.mapOk);
      // (The corner spot is mostly non-grass ground: ~19 % of the blades live there.)
      check(`${tag}: real grass lives (> 10 % of ${cs.blades}) and the real interiors and roads cull some`,
        f.liveCpu > 0.1 * cs.blades && cs.roadRejects > 0 && cs.indoorRejects > 0,
        `${f.liveCpu} road ${cs.roadRejects} indoor ${cs.indoorRejects}`);
      check(`${tag}: live-set mismatch <= 0.5 % on EVERY ring (GPU estimate)`,
        f.rings.every((r) => r.mism <= 0.005 * Math.max(r.cpu, 1)), JSON.stringify(f.rings) + " " + JSON.stringify(f.first));
      check(`${tag}: mismatches + out-of-tolerance blades <= 0.5 % (xy 1e-3 + f32 storage, normal / scalars 1e-4)`,
        f.mism + f.fieldOut <= 0.005 * Math.max(f.liveCpu, 1) && f.matched > 0,
        `${f.mism}+${f.fieldOut}/${f.liveCpu} ${JSON.stringify(f.firstField)}`);
      check(`${tag}: f64 placement over the same field + mask also <= 0.5 %`,
        e.mism + e.fieldOut <= 0.005 * Math.max(e.liveCpu, 1), `${e.mism}+${e.fieldOut}`);
      // 2026-10-23 — the early-out (integ-1 / gpu-cost-1).
      const eo = earlyOutParity(cpu, gpu, px, py);
      console.log(`  [info] ${tag}: early-out skips ${eo.skipped} of ${eo.mapped} mapped cells (${pct(eo.skipped, eo.mapped)}), `
        + `${eo.liveZero} of ${eo.live} live blades were zero size (${pct(eo.liveZero, eo.live)}); `
        + `drawn non-zero: CPU ${eo.visCpu}, mismatch ${eo.visMism} (per ring mismatch / of it the early-out's own / CPU non-zero / CPU live: `
        + `${eo.rings.map((r) => `${r.level}:${r.visMism}/${r.sizeMism}/${r.vis}/${r.live}`).join(" ")})`);
      check(`${tag}: early-out port (f64, GPU cell + rank) = the CPU zero-size decision (fadeFor, grassLodKeep, dissolve over its rand 7) on all ${eo.mapped} mapped cells`,
        eo.decisionMism === 0 && eo.skipped > 0.2 * eo.mapped, `${eo.decisionMism} ${JSON.stringify(eo.first)}`);
      // The live-set contract's denominator (the ring's CPU live blades). The
      // early-out's OWN disagreements (both sides live) are f32 boundary cases:
      // the CPU's stored point and the GPU's computed one differ by up to one
      // f32 step (3.9 mm at Holtburg) and the dissolve factor climbs at most
      // ~0.63 per metre (high ring 0), so the side that draws such a blade draws
      // it at a few 1e-3 of its size (a millimetre or two) — require < 1 %.
      check(`${tag}: blades drawn at non-zero size (f32 mirror live AND f32 early-out) = the CPU live non-zero blades, `
        + `<= 0.5 % of each ring's live blades; where the early-out itself disagrees the blade is < 1 % of its size (worst ${eo.sizeMismMax.toExponential(1)})`,
        eo.rings.every((r) => r.visMism <= 0.005 * Math.max(r.live, 1) && r.sizeMism <= 0.001 * Math.max(r.live, 1))
        && eo.sizeMismMax < 1e-2 && eo.visCpu > 0, JSON.stringify(eo.rings));
      if (sname.startsWith("Holtburg") && lname.startsWith("ultra")) {
        const none = parityGpu(cpu, gpu, px, py, false, false);
        console.log(`  [info] ${tag}: without the GPU mask the mismatch would be ${none.mism} (${pct(none.mism, none.liveCpu)})`);
        // (Not every excluded blade would have lived: the fill rejects some anyway.)
        check(`${tag}: the real interior mask is load-bearing (without it the indoor blades come back)`,
          none.mism - f.mism > 0.3 * cs.indoorRejects && none.liveGpu > f.liveGpu, `${none.mism} vs ${f.mism} (${cs.indoorRejects} rejects)`);
      }
      cpu.dispose(); gpu.dispose();
    }
  }
  let mm = 0, oo = 0, ll = 0;
  for (const [, a, b, c] of rates) { mm += a; oo += b; ll += c; }
  console.log(`  [info] all ${rates.length} runs: GPU-estimate live-set mismatch ${mm} of ${ll} CPU-live blades = ${pct(mm, ll)}; `
    + `out of tolerance ${oo} = ${pct(oo, ll)}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- G2. the GPU build with real three --");
const PX = 0xa9 * 192 + 96, PY = 0xb4 * 192 + 96;
const oracleFallback = () => {
  // Synthetic only when the DAT is missing: Holtburg-like flat Grassland.
  const o = createTerrainOracle();
  for (let dx = -3; dx <= 3; dx += 1) for (let dy = -3; dy <= 3; dy += 1) {
    o.noteLandblock(lbKeyFromXY(0xa9 + dx, 0xb4 + dy), {
      codes: new Uint8Array(81).fill(1), heights: new Float32Array(81).fill(60), roads: new Uint8Array(81), lbX: 0xa9 + dx, lbY: 0xb4 + dy,
    });
  }
  return o;
};
const TERRAIN = ORACLE || oracleFallback();
const PZ = TERRAIN.heightAt(PX, PY) + 1.7;
let gpuShaders = null;
let gpuObcSrc = null;
{
  const parent = new THREE.Group();
  const p = makeProvider(ULTRA, { gpu: true, parent });
  check("nothing built before the first tick (no mesh, no field)", parent.children.length === 0 && p._field === null && p._pool === null);
  p.update(0.016, makeCtx(PX, PY, PZ, TERRAIN));
  const layout = p._layout;
  const group = p._group;
  const meshes = p._meshes;
  let objs = 0, instancedMeshes = 0;
  parent.traverse((o) => { objs += 1; if (o.isInstancedMesh) instancedMeshes += 1; });
  check(`one Mesh per ring (${layout.length}) under the "terrainGrass" group, and NO InstancedMesh anywhere`,
    group && group.name === "terrainGrass" && group.parent === parent && group.children.length === layout.length
    && meshes.length === layout.length && meshes.every((m) => m && m.isMesh && !m.isInstancedMesh && m.parent === group)
    && instancedMeshes === 0, `${objs} objects, ${instancedMeshes} instanced`);
  check("each ring: InstancedBufferGeometry with NO instanced attributes (position / normal / uv + index only)",
    meshes.every((m) => {
      const g = m.geometry;
      const names = Object.keys(g.attributes).sort().join();
      return g.isInstancedBufferGeometry === true && names === "normal,position,uv" && !!g.index
        && Object.values(g.attributes).every((a) => !a.isInstancedBufferAttribute)
        && GRASS_ATTRIBUTES.every((a) => !(a.name in g.attributes));
    }));
  check("each ring: frustumCulled false, castShadow false, instanceCount 0 until a draw",
    meshes.every((m) => m.frustumCulled === false && m.castShadow === false && m.geometry.instanceCount === 0));
  check("the meshes keep the CPU names (terrain-grass-ring0..)", meshes.every((m, k) => m.name === `terrain-grass-ring${k}`));
  const field = p._field;
  const mask = p._indoorMask;
  const bags = p._ringUniforms;
  check("ONE shared terrain field: every ring binds the same uHbField / uHbFieldKey objects (RGBA32F DataTexture 144x144, Nearest)",
    !!field && bags.every((u) => u.uHbField === field.uniforms.uHbField && u.uHbFieldKey === field.uniforms.uHbFieldKey)
    && field.uniforms.uHbField.value && field.uniforms.uHbField.value.isDataTexture
    && field.uniforms.uHbField.value.image.width === FIELD_TEX_SIZE && field.uniforms.uHbField.value.type === THREE.FloatType
    && field.uniforms.uHbField.value.magFilter === THREE.NearestFilter);
  check("ONE shared interior mask built WITH three: every ring binds its three uniforms by reference",
    !!mask && mask.uniforms.uHbIndoorBoxes.value && mask.uniforms.uHbIndoorBoxes.value.isDataTexture
    && bags.every((u) => u.uHbIndoorBoxes === mask.uniforms.uHbIndoorBoxes && u.uHbIndoorBuckets === mask.uniforms.uHbIndoorBuckets
      && u.uHbIndoorOn === mask.uniforms.uHbIndoorOn));
  const sts = p._ringStates;
  check("each ring bag holds its own placement uniforms, uGpWindowMin / uGpTiles = the ring state's arrays BY REFERENCE",
    bags.every((u, k) => GRASS_GPU_RING_UNIFORMS.every((n) => u[n] && "value" in u[n])
      && u.uGpWindowMin.value === sts[k].winMin && u.uGpTiles.value === sts[k].tileIds
      && u.uGpGrid.value === sts[k].g && u.uGpTileSide.value === sts[k].ts && u.uGpSeed.value === (sts[k].seed >>> 0))
    && new Set(bags.map((u) => u.uGpTiles)).size === bags.length);
  check("the shared look uniforms are shared, the ring look + distance blend are ring-owned",
    bags.every((u) => u.uTime === p._uniforms.uTime && u.uGrassWindDir === p._uniforms.uGrassWindDir)
    && new Set(bags.map((u) => u.uGrassLodBand)).size === bags.length && new Set(bags.map((u) => u.uScatterCenter)).size === bags.length
    && p._uniforms.uScatterCenter === bags[0].uScatterCenter);
  const mats = p._materials;
  check("one MeshLambertMaterial per ring, all with the SAME onBeforeCompile source (= the same program cache key)",
    mats.every((m) => m && m.isMeshLambertMaterial) && new Set(mats).size === mats.length
    && new Set(mats.map((m) => m.onBeforeCompile.toString())).size === 1
    && new Set(mats.map((m) => m.customProgramCacheKey())).size === 1);
  // Run every ring's onBeforeCompile on a fresh real lambert shader.
  const shaders = mats.map((m) => { const s = lambertShader(); m.onBeforeCompile(s, null); return s; });
  gpuShaders = shaders;
  gpuObcSrc = mats[0].onBeforeCompile.toString();
  const vs = shaders[0].vertexShader, fs = shaders[0].fragmentShader;
  check("every ring compiles the IDENTICAL vertex + fragment source (one program)",
    shaders.every((s) => s.vertexShader === vs && s.fragmentShader === fs));
  check("the vertex stage holds the hash, TERRAIN_FIELD_GLSL, INTERIOR_MASK_GLSL and the placement GLSL exactly once",
    count(vs, GRASS_GPU_HASH_GLSL) === 1 && count(vs, TERRAIN_FIELD_GLSL) === 1 && count(vs, INTERIOR_MASK_GLSL) === 1
    && count(vs, buildGrassPlaceGlsl()) === 1 && count(vs, "HbBlade hbGrassPlace(int id)") === 1
    && count(vs, "hbGrassCell(gl_InstanceID)") === 1 && count(vs, "hbGrassPlaceCell(hbGpC)") === 1 && count(vs, "hbGrassDead(hbGpC)") === 1
    && count(vs, "hbGrassPlace(gl_InstanceID)") === 0,
    `${count(vs, TERRAIN_FIELD_GLSL)} ${count(vs, INTERIOR_MASK_GLSL)} ${count(vs, "HbBlade hbGrassPlace(int id)")}`);
  check("…in the order grass_gpu_place.js needs: hash, field, mask, place, then main()",
    vs.indexOf(GRASS_GPU_HASH_GLSL) < vs.indexOf(TERRAIN_FIELD_GLSL) && vs.indexOf(TERRAIN_FIELD_GLSL) < vs.indexOf(INTERIOR_MASK_GLSL)
    && vs.indexOf(INTERIOR_MASK_GLSL) < vs.indexOf("HbBlade hbGrassPlace(int id)") && vs.indexOf("HbBlade hbGrassPlace(int id)") < vs.indexOf("void main() {"));
  const blocks = [];
  for (let i = vs.indexOf(GRASS_MARKER); i !== -1; i = vs.indexOf(GRASS_MARKER, i + 1)) blocks.push(vs.slice(i, vs.indexOf(GRASS_END, i)));
  check(`no instanceMatrix in any grass snippet (${blocks.length} blocks) and no grass attribute declared`,
    blocks.length === 3 && blocks.every((b) => !b.includes("instanceMatrix"))
    && GRASS_ATTRIBUTES.every((a) => !new RegExp(`attribute\\s+\\w+\\s+${a.name}\\s*;`).test(vs)));
  check("the six attribute names are plain globals declared exactly once (+ hbGpOrigin / hbGpLive)",
    ["vec2 aScale;", "vec3 aNormal;", "float aRot;", "vec3 aTint;", "float aFamilyParam;", "float aRank;", "vec3 hbGpOrigin;", "float hbGpLive;"]
      .every((d) => count(vs, "\n" + d + "\n") === 1));
  const mainAt = vs.indexOf("void main() {");
  const placeAt = vs.indexOf("hbGrassCell(gl_InstanceID)");
  const codeBefore = vs.slice(mainAt, placeAt).split("\n").map((l) => l.trim()).filter((l) => l && l !== "{" && !l.startsWith("//"));
  check("the placement runs at the very top of main(), BEFORE beginnormal_vertex reads aNormal",
    placeAt > mainAt && vs.indexOf("aNormal = hbGpB.normal;") < vs.indexOf("#include <beginnormal_vertex>")
    && codeBefore.length === 2 && codeBefore[0] === "void main() {" && codeBefore[1] === "HbCell hbGpC =", JSON.stringify(codeBefore));
  // 2026-10-23 — the early-out and the dead-blade path (integ-1 / gpu-cost-1).
  const blockOf = (src, tag) => { const a = src.indexOf(tag); return a < 0 ? "" : src.slice(a, src.indexOf(GRASS_END, a)); };
  const mainBlock = blockOf(vs, "(terrain_grass.js, gpu placement)");
  const vertBlock = blockOf(vs, "(terrain_grass.js, vertex)");
  const cpuRef = lambertShader();
  injectTerrainGrassShader(cpuRef);
  const cpuVert = blockOf(cpuRef.vertexShader, "(terrain_grass.js, vertex)");
  const cpuLines = cpuVert.split("\n").map((l) => l.trim());
  const fadeLine = "hbP *= hbScatterFade(hbWorld);";
  const dA = cpuLines.indexOf("float hbD = length(hbWorld - uScatterCenter.xy);");
  const dB = cpuLines.findIndex((l) => l.startsWith("hbP *= clamp((hbKeep"));
  const swap = (l) => l.replace(/\bhbWorld\b/g, "hbGpC.xy").replace(/\bhbD\b/g, "hbGpD").replace(/\bhbKeep\b/g, "hbGpKeep")
    .replace(/\bhbSoft\b/g, "hbGpSoft").replace(/\baRank\b/g, "hbGrassRank(hbGpC)").replace(/^hbP \*= /, "");
  const want = [
    "float hbGpFade = " + swap(fadeLine),
    ...cpuLines.slice(dA, dB).map(swap),
    "float hbGpDissolve = " + swap(cpuLines[dB]),
  ];
  const mainLines = mainBlock.split("\n").map((l) => l.trim());
  const eA = mainLines.indexOf(want[0]);
  check("the early-out lines ARE the shared snippet's fade + dissolve lines (point = the cell, rank = hbGrassRank), in order",
    cpuLines.includes(fadeLine) && dA > 0 && dB > dA && eA > 0 && want.every((l, i) => mainLines[eA + i] === l),
    JSON.stringify(want) + " vs " + JSON.stringify(mainLines.slice(eA, eA + want.length)));
  check("…the cell is placed only when mapped AND both factors are non-zero; else it is the dead blade",
    mainBlock.includes("if (hbGpC.mapped && hbGpFade > 0.0 && hbGpDissolve > 0.0) {\n      hbGpB = hbGrassPlaceCell(hbGpC);\n    } else {\n      hbGpB = hbGrassDead(hbGpC);\n    }")
    && ["hbGpLive = hbGpB.live ? 1.0 : 0.0;", "hbGpOrigin = hbGpB.origin;", "aScale = hbGpB.scale;", "aNormal = hbGpB.normal;",
      "aRot = hbGpB.rot;", "aTint = hbGpB.tint;", "aFamilyParam = hbGpB.mat;", "aRank = hbGpB.rank;"].every((l) => mainLines.includes(l)));
  // A zero scale is the LAST thing that touches the blade: after the fade
  // line only scales (*=) and declarations, then origin + hbP. So a blade the
  // early-out kills (zero size) is one point, like a dead one.
  {
    const vl = vertBlock.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    const fA = vl.indexOf(fadeLine), tA = vl.indexOf("transformed = hbGpOrigin + hbP;");
    const after = vl.slice(fA + 1, tA);
    const before = vl.slice(0, fA);
    check("degenerate = dead: after the fade every hbP write is a scale (*=); every offset (bow, wind, lean, stomp) comes before it",
      fA > 0 && tA > fA && after.every((l) => !/\bhbP(\.\w+)?\s*(\+|-)?=[^=]/.test(l) || /\bhbP\s*\*=/.test(l))
      && after.filter((l) => /\bhbP\s*\*=/.test(l)).length === 1
      && ["hbP.y += uGrassBow", "hbP.xy += uGrassWindDir", "hbP.xy += aNormal.xy", "hbP.xy += (hbAway / hbLen)", "hbP.z *= (1.0 - uGrassStompBend"]
        .every((s) => before.some((l) => l.startsWith(s))), JSON.stringify(after));
    check("a dead blade skips the look but both branches write transformed, and vGrassTint is written once after them",
      vertBlock.includes("if (hbGpLive > 0.5) {") && vertBlock.includes("      transformed = hbGpOrigin + hbP;\n    } else {\n      transformed = hbGpOrigin;\n    }")
      && count(vertBlock, "vGrassTint =") === 1 && vertBlock.indexOf("vGrassTint =") > vertBlock.indexOf("transformed = hbGpOrigin;\n    }"));
  }
  check("hbWorld = the blade origin; vVfxHash re-derived from it after the shared assignment; transformed = origin + blade",
    vs.includes("vec2 hbWorld = hbGpOrigin.xy;") && vs.indexOf("vVfxHash = vfxHash01(hbGpOrigin.xy);") > vs.indexOf("vVfxHash = vfxHash01(modelMatrix[3].xy);")
    && vs.includes("transformed = hbGpOrigin + hbP;") && !vs.includes("    transformed = hbP;"));
  // Every uniform the injected source declares is bound (three's own come from ShaderLib).
  const declared = new Set([...(vs + "\n" + fs).matchAll(/\buniform\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)/g)].map((mm) => mm[1]));
  const unbound = [...declared].filter((n) => !(n in shaders[0].uniforms));
  check(`every declared uniform (${declared.size}) has a binding in shader.uniforms`, unbound.length === 0, unbound.join(","));
  check("the GPU fragment stage is exactly the CPU fragment stage", (() => {
    const c = lambertShader();
    injectTerrainGrassShader(c);
    return c.fragmentShader === fs;
  })());
  // Expanded through three's own chunks: none of our globals clashes with a three name.
  const expand = (src, depth = 0) => src.replace(/#include <(\w+)>/g, (_, n) => (depth > 8 ? "" : expand(THREE.ShaderChunk[n] || "", depth + 1)));
  const full = expand(vs);
  check("expanded through three's chunks, each new global / function name is declared exactly once",
    ["vec2 aScale;", "vec3 aNormal;", "vec3 hbGpOrigin;", "bool hbFieldSample(", "bool hbIndoorAt(", "HbBlade hbGrassPlace(", "float hbScatterFade(",
      "struct HbCell ", "HbCell hbGrassCell(", "float hbGrassRank(", "HbBlade hbGrassDead(", "HbBlade hbGrassPlaceCell("]
      .every((d) => count(full, d) === 1) && count(full, "uniform highp sampler2D uHbField;") === 1);
  {
    // Our identifiers vs GLSL ES 3.00 reserved words, double underscores and
    // three's own #defines (the GPU program's whole vertex source).
    const code = full.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const ids = new Set(code.match(/\b[A-Za-z_]\w*\b/g) || []);
    const RESERVED = ("coherent volatile restrict readonly writeonly resource atomic_uint noperspective patch sample subroutine common "
      + "partition active asm class union enum typedef template this goto inline noinline public static extern external interface "
      + "long short double half fixed unsigned superp input output hvec2 hvec3 hvec4 dvec2 dvec3 dvec4 fvec2 fvec3 fvec4 "
      + "sampler3DRect filter sizeof cast namespace using").split(" ");
    const defines = new Set([...full.matchAll(/#define\s+(\w+)/g)].map((mm) => mm[1]));
    const ours = ["HbCell", "hbGrassCell", "hbGrassPlaceCell", "hbGrassDead", "hbGrassRank", "hbGpC", "hbGpFade", "hbGpD", "hbGpKeep",
      "hbGpSoft", "hbGpDissolve", "hbGpB", "hbGpLive", "hbGpOrigin", "hc", "mapped", "xy", "g"];
    check("no reserved word, no double-underscore identifier, none of our names a three #define",
      RESERVED.every((w) => !ids.has(w)) && [...ids].every((w) => !w.includes("__")) && ours.every((n) => !defines.has(n))
      && !/[^\x00-\x7f]/.test(code));
  }
  check("no backticks, no #version, idempotent (a second injection is a no-op)", (() => {
    const s = lambertShader();
    injectTerrainGrassGpuShader(s);
    const v1 = s.vertexShader, f1 = s.fragmentShader;
    injectTerrainGrassGpuShader(s);
    return !v1.includes("`") && !f1.includes("`") && !v1.includes("#version") && s.vertexShader === v1 && s.fragmentShader === f1;
  })());
  check("a material without the seams is left untouched (inert)", (() => {
    const s = { vertexShader: "void main() { gl_Position = vec4(0.0); }", fragmentShader: "void main() {}" };
    injectTerrainGrassGpuShader(s);
    return s.vertexShader === "void main() { gl_Position = vec4(0.0); }";
  })());
  p.dispose();
  check("dispose removes the group, disposes the field (uniform values null) and leaves no ring", parent.children.length === 0
    && p._field === null && p._meshes.length === 0 && field.uniforms.uHbField.value === null);
}

// ---------------------------------------------------------------------------
console.log("\n-- G3. onBeforeRender: per-draw tile cull with a real PerspectiveCamera --");
{
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.name = "worldRoot";
  worldRoot.rotation.x = -Math.PI / 2;               // AC Z-up -> three Y-up
  worldRoot.position.set(-PX + 13.5, -2.25, PY - 7); // an origin rebase, so object space != world space
  scene.add(worldRoot);
  const p = makeProvider(ULTRA, { gpu: true, parent: worldRoot });
  p.update(0.016, makeCtx(PX, PY, PZ, TERRAIN));
  scene.updateMatrixWorld(true);
  const ac = (x, y, z) => worldRoot.localToWorld(new THREE.Vector3(x, y, z));
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 3000);
  // Third person behind the player, running EAST (+x AC).
  camera.position.copy(ac(PX - 4, PY, PZ + 1.5));
  camera.lookAt(ac(PX + 40, PY + 3, PZ - 3));
  camera.updateMatrixWorld(true);
  const camAc = worldRoot.worldToLocal(camera.position.clone());
  const fwd = camera.getWorldDirection(new THREE.Vector3());
  /** Every corner of the world box behind the camera's own plane. */
  const wholeBoxBehind = (box) => {
    for (let c = 0; c < 8; c += 1) {
      const q = new THREE.Vector3(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z);
      if (fwd.dot(q.sub(camera.position)) >= 0) return false;
    }
    return true;
  };
  const proj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const worldFrustum = new THREE.Frustum().setFromProjectionMatrix(proj, THREE.WebGLCoordinateSystem, false);
  const field = p._field;
  const layout = p._layout;
  /**
   * Draw every ring with `camera` and check each tile verdict against the
   * independent reference with the blade margins `marginOf(k)` = [xy, above]
   * (2026-10-23: live, see integ-2). `grownVs` = margins to count the tiles
   * kept now that those margins would drop.
   */
  const verifyCull = (cam, frustum, marginOf, grownVs) => {
    const camAcL = worldRoot.worldToLocal(cam.position.clone());
    const out = { allOk: true, behindOk: true, sortOk: true, someBehind: 0, someFrustum: 0, grown: 0, notes: [] };
    for (let k = 0; k < layout.length; k += 1) {
      const mesh = p._meshes[k];
      const st = p._ringStates[k];
      const bag = p._ringUniforms[k];
      const [m, za] = marginOf(k);
      mesh.onBeforeRender(null, scene, cam, mesh.geometry, mesh.material);
      const ids = Array.from(st.tileIds);
      const n = ids.findIndex((v) => v < 0) === -1 ? 64 : ids.findIndex((v) => v < 0);
      const kept = new Set(ids.slice(0, n));
      if (mesh.geometry.instanceCount !== n * st.ts * st.ts || bag.uGpTiles.value !== st.tileIds
        || !ids.slice(n).every((v) => v === -1)) out.allOk = false;
      const hole = layout[k].band[0];
      let preFrustum = 0;
      for (let t = 0; t < 64; t += 1) {
        const ox0 = (t % 8) * st.ts, oy0 = Math.floor(t / 8) * st.ts;
        if (ox0 >= st.g || oy0 >= st.g) { if (kept.has(t)) out.allOk = false; continue; }
        const ox1 = Math.min(ox0 + st.ts, st.g), oy1 = Math.min(oy0 + st.ts, st.g);
        const x0 = (st.winMin[0] + ox0) * st.cell, x1 = (st.winMin[0] + ox1) * st.cell;
        const y0 = (st.winMin[1] + oy0) * st.cell, y1 = (st.winMin[1] + oy1) * st.cell;
        const nearD = Math.hypot(Math.max(x0 - PX, 0, PX - x1), Math.max(y0 - PY, 0, PY - y1));
        const farD = Math.hypot(Math.max(Math.abs(x0 - PX), Math.abs(x1 - PX)), Math.max(Math.abs(y0 - PY), Math.abs(y1 - PY)));
        const zr = field.heightRange(x0, y0, x1, y1);
        let want = nearD <= st.radiusM && !(hole > 0 && farD < hole) && !!zr;
        if (want) {
          preFrustum += 1;
          const box = new THREE.Box3(new THREE.Vector3(x0 - m, y0 - m, zr.min - GRASS_GPU_CULL_BELOW_M),
            new THREE.Vector3(x1 + m, y1 + m, zr.max + za)).applyMatrix4(mesh.matrixWorld);
          want = frustum.intersectsBox(box);
          if (wholeBoxBehind(box)) { out.someBehind += 1; if (kept.has(t)) out.behindOk = false; }
          if (want && grownVs) {
            const [gm, gz] = grownVs;
            const small = new THREE.Box3(new THREE.Vector3(x0 - gm, y0 - gm, zr.min - GRASS_GPU_CULL_BELOW_M),
              new THREE.Vector3(x1 + gm, y1 + gm, zr.max + gz)).applyMatrix4(mesh.matrixWorld);
            if (!frustum.intersectsBox(small)) out.grown += 1;
          }
        }
        if (want !== kept.has(t)) out.allOk = false;
      }
      out.someFrustum += preFrustum - n;
      // Nearest first from the camera (object space), the box top at the margin.
      let last = -1;
      for (const t of ids.slice(0, n)) {
        const ox0 = (t % 8) * st.ts, oy0 = Math.floor(t / 8) * st.ts;
        const x0 = (st.winMin[0] + ox0) * st.cell, x1 = (st.winMin[0] + Math.min(ox0 + st.ts, st.g)) * st.cell;
        const y0 = (st.winMin[1] + oy0) * st.cell, y1 = (st.winMin[1] + Math.min(oy0 + st.ts, st.g)) * st.cell;
        const zr = field.heightRange(x0, y0, x1, y1);
        const dz = Math.max(zr.min - GRASS_GPU_CULL_BELOW_M - camAcL.z, 0, camAcL.z - zr.max - za);
        const d = Math.max(x0 - camAcL.x, 0, camAcL.x - x1) ** 2 + Math.max(y0 - camAcL.y, 0, camAcL.y - y1) ** 2 + dz * dz;
        if (d < last - 1e-6) out.sortOk = false;
        last = d;
      }
      out.notes.push(`ring ${k}: ${n} of 64 tiles (${preFrustum} before the frustum), ${mesh.geometry.instanceCount} instances, margins ${m.toFixed(2)}/${za.toFixed(2)} m`);
    }
    return out;
  };
  const vc = verifyCull(camera, worldFrustum, () => [GRASS_GPU_CULL_XY_MARGIN_M, GRASS_GPU_CULL_ABOVE_M], null);
  const { allOk, behindOk, sortOk, someBehind, someFrustum, notes } = vc;
  console.log(`  [info] ${notes.join("; ")}`);
  check("every ring: uGpTiles = the survivors then -1, instanceCount = tiles x ts^2, and every tile verdict = the reference "
    + "(disc, dissolve hole, resident z range, three Frustum on the world-space box)", allOk, notes.join("; "));
  check(`tiles BEHIND the camera are culled (${someBehind} candidates), and the frustum culls tiles the disc kept (${someFrustum})`,
    behindOk && someBehind > 0 && someFrustum > 0);
  check("the drawn tiles are sorted nearest-first from the camera (object space)", sortOk);
  const st = p.stats();
  check("stats(): visibleBlades = the instances the last render drew, an upper bound below the full window",
    st.mode === "gpu" && st.visibleBlades === st.levels.reduce((a, l) => a + l.instancesDrawn, 0)
    && st.visibleBlades > 0 && st.visibleBlades < st.levels.reduce((a, l) => a + l.maxInstances, 0)
    && st.tilesDrawn === st.levels.reduce((a, l) => a + l.tilesDrawn, 0));
  // 2026-10-23 (integ-2) — LIVE margins. The default look: the 2 m floors.
  check("default look: every ring culls with the 2 m floors (stats().levels[k].cullXyMarginM / cullAboveM)",
    st.levels.every((l) => l.cullXyMarginM === GRASS_GPU_CULL_XY_MARGIN_M && l.cullAboveM === GRASS_GPU_CULL_ABOVE_M));
  {
    // setLod({heightGain: 2}) + the wind ?treeWindStrength=4 writes (0.42 x 4):
    // the reference margin of ring k, derived here from the layout and the
    // grass defaults (not from the ring uniforms the provider reads).
    const D = GRASS_DEFAULTS;
    p.setLodLook({ heightGain: 2 });
    const ampWas = p._uniforms.uGrassWindAmp.value;
    p._uniforms.uGrassWindAmp.value = D.windAmp * 4;
    const refMargin = (k, stomp) => {
      const r = grassGpuBladeReach({ heightMul: 1 + 2 * k, widthMul: layout[k].widthMul, bow: D.bowAmount, windAmp: D.windAmp * 4,
        windDirLen: 1, flutter: D.windFlutter, lean: D.lean, stomp, stompSplay: D.stompSplay, stompBend: D.stompBend });
      return [Math.max(GRASS_GPU_CULL_XY_MARGIN_M, r.lateralM), Math.max(GRASS_GPU_CULL_ABOVE_M, r.aboveM)];
    };
    const lv = verifyCull(camera, worldFrustum, (k) => refMargin(k, false), [GRASS_GPU_CULL_XY_MARGIN_M, GRASS_GPU_CULL_ABOVE_M]);
    console.log(`  [info] heightGain 2 + wind x4: ${lv.notes.join("; ")}; tiles a 2 m box would drop: ${lv.grown}`);
    const sl = p.stats().levels;
    check("setLod({heightGain: 2}) + ?treeWindStrength=4 wind: every ring's margins = max(2 m, the blade reach of its live look)",
      sl.every((l, k) => l.cullXyMarginM === refMargin(k, false)[0] && l.cullAboveM === refMargin(k, false)[1])
      && sl[3].cullXyMarginM > 10 && sl[3].cullAboveM > 4.5, JSON.stringify(sl.map((l) => [l.cullXyMarginM, l.cullAboveM])));
    check("…every tile verdict = the reference on the box grown by those margins (three Frustum, world space), nearest first",
      lv.allOk && lv.sortOk && lv.behindOk, lv.notes.join("; "));
    check(`…and tiles whose blades now reach into view are kept where the fixed 2 m box dropped them (${lv.grown})`, lv.grown > 0);
    // The stomp term: only where the trail square can hold a SIZED blade of
    // the ring (its hole band[0] below |trail centre - player| + R sqrt 2).
    const tu = p._uniforms;
    tu.uTrailEnabled.value = 1;
    tu.uTrailCenter.value.x = PX; tu.uTrailCenter.value.y = PY;
    tu.uTrailRadius.value = 48;
    const reach48 = 48 * Math.SQRT2;
    const stompOf = () => layout.map((r) => r.band[0] < reach48);
    for (let k = 0; k < layout.length; k += 1) p._meshes[k].onBeforeRender(null, scene, camera, p._meshes[k].geometry, p._meshes[k].material);
    const s1 = p.stats().levels, w1 = stompOf();
    p.setLodLook({ blend: 0.9 });   // ring 3's hole: 0.9 x 100 = 90 m > 67.9 m
    for (let k = 0; k < layout.length; k += 1) p._meshes[k].onBeforeRender(null, scene, camera, p._meshes[k].geometry, p._meshes[k].material);
    const s2 = p.stats().levels, w2 = stompOf();
    check(`trail on: the stomp splay counts on rings whose hole the trail square reaches (${w1} / blend 0.9: ${w2})`,
      w1.every(Boolean) && !w2[3] && w2[2]
      && s1.every((l, k) => l.cullXyMarginM === refMargin(k, true)[0])
      && s2.every((l, k) => l.cullXyMarginM === refMargin(k, w2[k])[0]) && s2[3].cullXyMarginM < s1[3].cullXyMarginM,
      JSON.stringify([s1.map((l) => l.cullXyMarginM), s2.map((l) => l.cullXyMarginM)]));
    tu.uTrailEnabled.value = 0;
    p.setLodLook({ blend: GRASS_DEFAULTS.lodBlend, heightGain: GRASS_DEFAULTS.lodHeightGain });
    p._uniforms.uGrassWindAmp.value = ampWas;
    const back = verifyCull(camera, worldFrustum, () => [GRASS_GPU_CULL_XY_MARGIN_M, GRASS_GPU_CULL_ABOVE_M], null);
    check("…restoring the look restores the 2 m margins and the default verdicts",
      back.allOk && p.stats().levels.every((l) => l.cullXyMarginM === GRASS_GPU_CULL_XY_MARGIN_M && l.cullAboveM === GRASS_GPU_CULL_ABOVE_M));
  }
  // 0-safety.
  const sky = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 3000);
  sky.position.copy(ac(PX, PY, PZ + 3000));
  sky.lookAt(ac(PX, PY, PZ + 6000));
  sky.updateMatrixWorld(true);
  let skyOk = true;
  for (const mesh of p._meshes) {
    mesh.onBeforeRender(null, scene, sky, mesh.geometry, mesh.material);
    if (mesh.geometry.instanceCount !== 0) skyOk = false;
  }
  check("a camera looking at the sky from 3 km up draws nothing: instanceCount 0 on every ring (not NaN)", skyOk);
  const over = new THREE.MeshBasicMaterial();
  let overOk = true;
  for (const mesh of p._meshes) {
    mesh.onBeforeRender(null, scene, camera, mesh.geometry, over);
    if (mesh.geometry.instanceCount !== 0) overOk = false;
  }
  check("an override material (scene.overrideMaterial: it cannot place a blade) draws nothing", overOk);
  let noCamOk = true;
  for (let k = 0; k < layout.length; k += 1) {
    const mesh = p._meshes[k];
    mesh.onBeforeRender(null, scene, null, mesh.geometry, mesh.material);
    if (!(mesh.geometry.instanceCount > 0) || mesh.geometry.instanceCount % (p._ringStates[k].ts ** 2) !== 0) noCamOk = false;
  }
  check("no camera = no frustum test: the disc / hole / z cull alone still draws", noCamOk);
  // No terrain at all (the oracle has nothing): every tile culled.
  const q = makeProvider(ULTRA, { gpu: true, parent: worldRoot });
  q.update(0.016, makeCtx(PX, PY, PZ, createTerrainOracle()));
  scene.updateMatrixWorld(true);
  let emptyOk = true;
  for (let k = 0; k < q._meshes.length; k += 1) {
    const mesh = q._meshes[k];
    mesh.onBeforeRender(null, scene, camera, mesh.geometry, mesh.material);
    if (mesh.geometry.instanceCount !== 0 || !Array.from(q._ringStates[k].tileIds).every((v) => v === -1)) emptyOk = false;
  }
  check("no resident terrain (empty oracle): instanceCount 0 and uGpTiles all -1 on every ring", emptyOk);
  // Built, but the first tick had no player: no centre yet -> nothing drawn.
  const r = makeProvider(ULTRA, { gpu: true, parent: worldRoot });
  r.update(0.016, makeCtx(PX, PY, PZ, TERRAIN, null, { hasPlayer: false }));
  check("built without a player position: draws nothing (instanceCount 0), no throw", r._meshes.length === 4
    && r._meshes.every((mesh) => { mesh.onBeforeRender(null, scene, camera, mesh.geometry, mesh.material); return mesh.geometry.instanceCount === 0; }));
  p.dispose(); q.dispose(); r.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- G4. per frame, setOffRoad, setLodLook, stats, the window handle --");
{
  const parent = new THREE.Group();
  const p = makeProvider(ULTRA, { gpu: true, parent });
  const s0 = p.stats();
  check("stats() before the build: mode gpu, no throw, nothing drawn, field null, pool null",
    s0.mode === "gpu" && s0.built === false && s0.visibleBlades === 0 && s0.field === null && s0.pool === null
    && s0.levels.length === 0 && s0.hasMesh === false && s0.offRoad === true);
  check("setOffRoad before the rings exist returns null (as on the CPU path)", p.setOffRoad(false) === null);
  const follow = (x, y, z) => {
    let ok = true;
    const layout = p._layout;
    p._ringUniforms.forEach((u, k) => {
      const st = p._ringStates[k];
      const w = grassGpuWindowMin([x, y], layout[k].radiusM, st.cell);
      if (u.uGpWindowMin.value[0] !== w[0] || u.uGpWindowMin.value[1] !== w[1]) ok = false;
      const c = u.uScatterCenter.value;
      if (c.x !== x || c.y !== y || c.z !== z) ok = false;
      if (u.uScatterRadius.value !== layout[k].radiusM || u.uScatterFadeStart.value !== layout[k].radiusM * (1 - layout[k].fadeFraction)
        || u.uScatterShape.value !== 0) ok = false;
    });
    return ok;
  };
  p.update(0.016, makeCtx(PX, PY, PZ, TERRAIN));
  const w0 = p._field.stats().walks;
  check("after a tick: every ring's uGpWindowMin = grassGpuWindowMin(player), uScatterCenter = player, radius W, fade start W(1 - f), disc",
    follow(PX, PY, PZ));
  p.update(0.016, makeCtx(PX + 5.5, PY - 3.25, PZ + 0.5, TERRAIN));
  check("a move inside the landblock: the window follows, the field does NOT re-walk",
    follow(PX + 5.5, PY - 3.25, PZ + 0.5) && p._field.stats().walks === w0);
  p.update(0.016, makeCtx(PX + 120, PY, PZ, TERRAIN));
  check("a move across a landblock edge: the window follows and the field re-walks once",
    follow(PX + 120, PY, PZ) && p._field.stats().walks === w0 + 1 && p._field.stats().centerLb.x === 0xaa);
  let threw = false;
  try { p.update(0.016, makeCtx(NaN, PY, PZ, TERRAIN)); } catch (_) { threw = true; }
  check("a non-finite player position: no throw, the window stays put", !threw && follow(PX + 120, PY, PZ));
  check("the time + wind uniforms tick as on the CPU path", p._uniforms.uTime.value === 1.25);
  check("setOffRoad(false): every ring's uGpOffRoad -> 0, stats().offRoad false",
    p.setOffRoad(false) === false && p._ringUniforms.every((u) => u.uGpOffRoad.value === 0) && p.stats().offRoad === false);
  check("setOffRoad(true): every ring back to 1",
    p.setOffRoad(true) === true && p._ringUniforms.every((u) => u.uGpOffRoad.value === 1) && p.stats().offRoad === true);
  // setLodLook: bands rewritten, and the cull reads the LIVE band (hole culling starts above ~0.71).
  const tilesAt = () => p._layout.map((_, k) => p._cullRing(k, null, p._materials[k]));
  const before = tilesAt();
  const look = p.setLodLook({ blend: 0.9 });
  const after = tilesAt();
  const L = p._layout;
  check("setLodLook still works: returns the look, rewrites every ring's uGrassLodBand",
    look.blend === 0.9 && p._ringUniforms.every((u, k) => u.uGrassLodBand.value.x === L[k].band[0] && u.uGrassLodBand.value.z === 0.9 * L[k].radiusM)
    && L[1].band[0] === 0.9 * L[0].radiusM);
  check(`…and the tile cull reads the live band: a 0.9 dissolve hole drops tiles on the outer rings (${before} -> ${after})`,
    after[0] === before[0] && after.slice(1).some((n, i) => n < before[i + 1]));
  p.setLodLook({ blend: 0.6 });
  check("…and restoring the look restores the tiles", tilesAt().join() === before.join());
  const st = p.stats();
  check("stats(): mode gpu, per-ring tilesDrawn / instancesDrawn, field + indoor stats, the CPU-only counts null",
    st.mode === "gpu" && st.built && st.levels.length === 4 && st.levels.every((l) => Number.isFinite(l.tilesDrawn) && Number.isFinite(l.instancesDrawn))
    && st.field && st.field.slotsValid > 0 && Number.isFinite(st.field.walks) && st.indoorCull && st.indoorCull.enabled === true
    && st.pool === null && st.roadRejects === null && st.indoorRejects === null && st.hasMesh === true
    && st.blades === p._ringStates.reduce((a, s) => a + s.count, 0) && st.reachM === L[3].radiusM && st.buildError === null);
  check("stats() is JSON-serialisable (the film / diag dumps)", (() => { try { return JSON.stringify(st).length > 100; } catch (_) { return false; } })());
  check("_pool is null and _pools empty in GPU mode", p._pool === null && p._pools.length === 0);
  p.dispose();
  const sd = p.stats();
  check("stats() after dispose: no throw, nothing built, field null", sd.mode === "gpu" && sd.built === false && sd.field === null
    && sd.levels.length === 0 && parent.children.length === 0);
  let twice = true;
  try { p.dispose(); } catch (_) { twice = false; }
  p.update(0.016, makeCtx(PX, PY, PZ, TERRAIN));
  check("dispose twice is safe, and the next tick rebuilds a working field + rings", twice && p._meshes.length === 4
    && p._field && p._field.stats().slotsValid > 0 && parent.children.length === 1 && follow(PX, PY, PZ));
  p.dispose();

  // 2026-10-23 (lifecycle-1) — the interior mask's GPU copy is centred on the
  // player BEFORE each sync: setGpuCenter(p.x, p.y, p.z, outermost half extent),
  // for a finite p.x / p.y only (p.z as is); the CPU path never calls it.
  {
    const spy = (prov) => {
      const mask = prov._indoorMask;
      const log = [];
      const sync0 = mask.sync;
      const set0 = typeof mask.setGpuCenter === "function" ? mask.setGpuCenter : null;
      mask.sync = (...a) => { log.push(["sync"]); return sync0(...a); };
      mask.setGpuCenter = (x, y, z, r) => { log.push(["center", x, y, z, r]); return set0 ? set0(x, y, z, r) : false; };
      return log;
    };
    const q = makeProvider(ULTRA, { gpu: true, parent: new THREE.Group() });
    q.update(0.016, makeCtx(PX, PY, PZ, TERRAIN));   // builds the rings
    const log = spy(q);
    const reach = Math.max(...q._ringStates.map((s) => s.radiusM));
    const frame = (x, y, z, extra) => { log.length = 0; q.update(0.016, makeCtx(x, y, z, TERRAIN, null, extra)); return log.map((e) => e.join()); };
    const f1 = frame(PX + 3.5, PY - 1.25, PZ);
    check(`each frame: setGpuCenter(p.x, p.y, p.z, ${reach} = the outermost ring's half extent) BEFORE the sync`,
      reach === q._layout[q._layout.length - 1].radiusM && f1.length === 2
      && f1[0] === ["center", PX + 3.5, PY - 1.25, PZ, reach].join() && f1[1] === "sync", JSON.stringify(f1));
    const f2 = frame(PX, PY, NaN);
    check("a non-finite p.z still centres (passed through as is), then syncs", f2.length === 2 && f2[0] === ["center", PX, PY, NaN, reach].join() && f2[1] === "sync",
      JSON.stringify(f2));
    const f3 = frame(NaN, PY, PZ);
    const f4 = frame(PX, Infinity, PZ);
    const f5 = frame(PX, PY, PZ, { playerPos: null });
    check("a non-finite p.x / p.y (or no position): no setGpuCenter, the sync still runs",
      [f3, f4, f5].every((f) => f.length === 1 && f[0] === "sync"), JSON.stringify([f3, f4, f5]));
    delete q._indoorMask.setGpuCenter;
    let threw = false;
    try { frame(PX, PY, PZ); } catch (_) { threw = true; }
    check("a mask without setGpuCenter (older module): no throw, the sync still runs", !threw && log.length === 1 && log[0][0] === "sync");
    q.dispose();
    const c = makeProvider(ULTRA, { gpu: false, parent: new THREE.Group() });
    c.update(0.016, makeCtx(PX, PY, PZ, TERRAIN));
    const clog = spy(c);
    c.update(0.016, makeCtx(PX + 1, PY, PZ, TERRAIN));
    check("the CPU path never calls setGpuCenter (only its sync)", clog.length === 1 && clog[0][0] === "sync", JSON.stringify(clog));
    c.dispose();
  }

  // The window handle (`window.__terrainGrass`) in GPU mode.
  _resetTerrainGrass();
  globalThis.window = { location: { search: "?terrainGrass=on&terrainGrassGpu=on" } };
  _resetVfxFlags();
  try {
    const hParent = new THREE.Group();
    const handle = initTerrainGrass({ THREE, parent: hParent });
    check("initTerrainGrass registers a GPU provider: window.__terrainGrass, mode gpu, pool null",
      !!handle && globalThis.window.__terrainGrass === handle && handle.provider.mode === "gpu" && handle.pool === null
      && handle.stats().mode === "gpu");
    check("handle.setOffRoad before the first tick: null (no throw)", handle.setOffRoad(false) === null);
    handle.provider.update(0.016, makeCtx(PX, PY, PZ, TERRAIN));
    check("handle.setOffRoad(false) flips uGpOffRoad on every ring (it used to loop the pools)",
      handle.setOffRoad(false) === false && handle.provider._ringUniforms.every((u) => u.uGpOffRoad.value === 0)
      && handle.setOffRoad(true) === true);
    check("handle.uniforms.uScatterCenter is ring 0's live centre; handle.setLod works",
      handle.uniforms.uScatterCenter.value.x === PX && handle.setLod({ soft: 0.3 }).soft === 0.3);
    // docs/2026-10-08-1070-look-pass-tools/panel.js: finds the "terrainGrass" group and toggles .visible.
    let g = null;
    hParent.traverse((o) => { if (!g && o.name === "terrainGrass") g = o; });
    check("the look-pass panel's group lookup still finds the grass (\"terrainGrass\")", !!g && g === handle.provider._group);
    handle.provider.dispose();
    handle.unregister();
  } finally {
    _resetTerrainGrass();
    delete globalThis.window;
    _resetVfxFlags();
  }

  // Without THREE (node / headless logic): the arrays + mirror exist, no GPU objects, no throw.
  const n = makeProvider(ULTRA, { gpu: true, withThree: false, parent: null });
  n.update(0.016, makeCtx(PX, PY, PZ, TERRAIN));
  const ns = n.stats();
  check("GPU mode without THREE: field arrays + ring states built, no mesh, no texture, nothing drawn, no throw",
    ns.mode === "gpu" && n._field && n._field.stats().gpu === false && n._field.stats().slotsValid > 0
    && n._meshes.every((mm) => mm === null) && n._ringStates.length === 4 && ns.visibleBlades === 0 && ns.hasMesh === false
    && n._cullRing(0, null, null) === 0);
  n.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- G5. ?terrainGrassGpu=off: the CPU path exactly as before --");
{
  globalThis.window = { location: { search: "?terrainGrassGpu=off" } };
  _resetVfxFlags();
  const parent = new THREE.Group();
  const p = createTerrainGrassProvider({ THREE, parent, config: { ...BASE, ...ULTRA } });   // no gpu key: the flag (=off)
  p.update(0.016, makeCtx(PX, PY, PZ, TERRAIN));
  const pools = p._pools;
  check("?terrainGrassGpu=off: mode cpu, one scatter pool + InstancedMesh per ring, no field, no GPU mesh",
    p.mode === "cpu" && p.quality().gpu === false && pools.length === 4 && pools.every((pl) => pl && pl.mesh && pl.mesh.isInstancedMesh)
    && p._pool === pools[0] && p._field === null && p._meshes.every((mm) => mm === null) && p._ringStates.every((s) => s === null));
  check("no GPU uniform in any CPU ring bag (uGp*, uHb*)", p._ringUniforms.every((u) => Object.keys(u).every((k) => !/^uGp|^uHb/.test(k))));
  const s = lambertShader();
  p._materials[0].onBeforeCompile(s, null);
  const ref = lambertShader();
  injectTerrainGrassShader(ref);
  check("the CPU material injects exactly injectTerrainGrassShader's output (no placement GLSL)",
    s.vertexShader === ref.vertexShader && s.fragmentShader === ref.fragmentShader && !s.vertexShader.includes("hbGrassPlace")
    && !s.vertexShader.includes("uHbField") && s.vertexShader.includes("attribute vec2 aScale;")
    && s.vertexShader.includes("vec2 hbWorld = instanceMatrix[3].xy;") && s.vertexShader.includes("    transformed = hbP;"));
  check("CPU and GPU programs differ (never one cache key)",
    !!gpuShaders && gpuShaders[0].vertexShader !== s.vertexShader && !!gpuObcSrc
    && p._materials[0].onBeforeCompile.toString() !== gpuObcSrc);
  const st = p.stats();
  check("stats(): mode cpu with the pool fields as before", st.mode === "cpu" && st.pool && st.pool.count === pools[0].count
    && Number.isFinite(st.roadRejects) && st.visibleBlades === pools.reduce((a, pl) => a + pl.stats().live, 0) && !("field" in st));
  check("setOffRoad on the CPU path still flips every pool", p.setOffRoad(false) === false && pools.every((pl) => pl.stats().offRoad === false)
    && p.setOffRoad(true) === true);
  const explicit = makeProvider(ULTRA, { gpu: false, parent: new THREE.Group() });
  explicit.update(0.016, makeCtx(PX, PY, PZ, TERRAIN));
  let same = explicit._pools.length === pools.length;
  for (let k = 0; same && k < pools.length; k += 1) {
    const a = pools[k], b = explicit._pools[k];
    if (a.count !== b.count) { same = false; break; }
    for (let i = 0; i < a.count; i += 1) if (a._live[i] !== b._live[i] || a._cellX[i] !== b._cellX[i]) { same = false; break; }
  }
  check("gpu: false and ?terrainGrassGpu=off build the same CPU field", same);
  p.dispose(); explicit.dispose();
  delete globalThis.window;
  _resetVfxFlags();
}

// ---------------------------------------------------------------------------
console.log("\n-- G6. house rules over the shipped source --");
{
  const src = readFileSync("./scene3d/terrain_grass.js", "utf8");
  const hits = lintSource(src);
  check("lintSource(terrain_grass.js) clean", hits.length === 0, hits.map((h) => `${h.lineno}:${h.label}`).join("; "));
  check("terrain_grass.js imports no three, turns no castShadow on, builds no light",
    !/^import .* from "three"/m.test(src) && !/castShadow\s*=\s*true/.test(src) && !/new\s+THREE\.[A-Za-z]*Light\b/.test(src));
  check("grass_gpu_place.js constants are read inside functions only (ESM cycle): no top-level GRASS_GPU_* read",
    !/^(?:const|let|var)\s+\w+\s*=\s*[^;]*\bGRASS_GPU_HASH_GLSL\b/m.test(src));
}

// ---------------------------------------------------------------------------
// 2026-10-23 (review tests-1) — THE GLSL FINGERPRINT LOCK. No node test runs
// the field, mask or placement GLSL (only the hash is interpreted), so a GLSL
// edit that breaks it passes everything above. The browser readback smoke
// does run it, and on PASS stamps the sha256 of the shipped GLSL
// (harness/glsl_smoke/grass_gpu_fingerprint.mjs) into
// harness/glsl_smoke/grass_gpu_smoke.stamp.json; here the current GLSL must
// carry that stamp. The generated GRASS_VARIANTS lines are normalised out (a
// look-table tweak does not trip it); the injected shader also holds the
// SHARED CPU snippets, so an edit there trips it too (accepted: the smoke's
// frame compare runs that shader).
console.log("\n-- G7. GLSL fingerprint lock (the readback smoke's stamp) --");
{
  const FPM = await import("./harness/glsl_smoke/grass_gpu_fingerprint.mjs");
  const { grassGpuVariantCodes } = await import("./scene3d/grass_gpu_place.js");
  const fp = FPM.grassGpuGlslFingerprint();
  const fp2 = FPM.grassGpuGlslFingerprint();
  check("the fingerprint is a stable sha256 over 6 parts (hash, field, mask, place, vertex, fragment)",
    /^[0-9a-f]{64}$/.test(fp.fingerprint) && fp.fingerprint === fp2.fingerprint
    && Object.keys(fp.parts).join(",") === "hash,field,mask,place,vertex,fragment", fp.fingerprint);
  const nCodes = grassGpuVariantCodes().length;
  check("the normaliser removes exactly the generated variant lines (one per grass code, in place and in the injected vertex)",
    nCodes > 0 && fp.variantLines.place === nCodes && fp.variantLines.vertex === nCodes
    && fp.variantLines.hash === 0 && fp.variantLines.field === 0 && fp.variantLines.mask === 0 && fp.variantLines.fragment === 0,
    JSON.stringify(fp.variantLines));
  const place = buildGrassPlaceGlsl();
  const vline = place.split("\n").find((l) => /^\s*if \(code == \d+\) \{ shape = vec4\(/.test(l));
  const tweaked = place.replace(vline, vline.replace(/\d+\.\d+/g, "0.5"))
    .replace(vline, vline + "\n" + vline.replace(/code == \d+/, "code == 31"));
  const base = FPM.normaliseGrassGpuGlsl(place).text;
  check("a look-table tweak (new numbers, a new grass code) leaves the normalised placement GLSL unchanged",
    !!vline && tweaked !== place && FPM.normaliseGrassGpuGlsl(tweaked).text === base);
  check("a placement edit outside the table changes it",
    place.includes("hbGpRand(gx, gy, 4)") && FPM.normaliseGrassGpuGlsl(place.replace("hbGpRand(gx, gy, 4)", "hbGpRand(gx, gy, 5)")).text !== base);
  let stamp = null, stampErr = "";
  if (existsSync(FPM.GRASS_GPU_STAMP_PATH)) {
    try { stamp = JSON.parse(readFileSync(FPM.GRASS_GPU_STAMP_PATH, "utf8")); } catch (e) { stampErr = `unreadable stamp (${e.message}); `; }
  } else {
    stampErr = "no stamp yet; ";
  }
  const moved = stamp && stamp.parts ? Object.keys(fp.parts).filter((k) => stamp.parts[k] !== fp.parts[k]) : [];
  const fix = `re-run '${FPM.GRASS_GPU_SMOKE_CMD}' (orchestrator only) — it rewrites the stamp on PASS`;
  check("the shipped grass GPU GLSL carries the readback smoke's PASS stamp (harness/glsl_smoke/grass_gpu_smoke.stamp.json)",
    !!stamp && stamp.fingerprint === fp.fingerprint,
    `${stampErr}${stamp ? `stamp ${String(stamp.fingerprint).slice(0, 12)} (${stamp.passedAt}) != current ${fp.fingerprint.slice(0, 12)}; changed: ${moved.join(", ") || "?"}; ` : `current ${fp.fingerprint.slice(0, 12)}; `}${fix}`);
}

if (cellDat) cellDat.close();
if (portalDat) portalDat.close();
console.log(`\nterrain grass GPU integration: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
