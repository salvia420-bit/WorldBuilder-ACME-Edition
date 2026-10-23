// test_grass_gpu_place.mjs — GPU grass placement, Module C: the placement GLSL,
// its JS mirror and the per-ring tile culling (`scene3d/grass_gpu_place.js`),
// plus the `?terrainGrassGpu` flag reader (`vfx_flags.js`). Contract:
// docs/2026-10-23-grass-gpu-placement.md.
//
// Run with:
//   cd apps/holtburger-web && node test_grass_gpu_place.mjs
//   (HB_CELL_DAT overrides ~/ac_base_dats/client_cell_1.dat)
//
// Locks:
//  P1  HASH — the JS mirror AND the GLSL text itself (its statements parsed and
//      executed) are bit-identical to `scatterHashU32` over 100k+ inputs incl.
//      negative / large ints and seeds; `hash01` keeps the top 24 bits (exact
//      in f32, < 1, within 2^-24 of `scatterHash01`).
//  P2  SPLIT — the u32 cutoff form agrees with `cellSwToNeCut` on EVERY global
//      cell of the world (2048 x 2048); 2147483682 is re-derived.
//  P3  RING STATE — `grassGpuRingState` = what the REAL provider's pools use
//      (grid, cell, seed, randSeed, base seed, jitter, height offset, window)
//      for single-field and 4-ring layouts, read back from the pools' own
//      outputs; `grassGpuWindowMin` = the pool window at many centres. No
//      `band` in the state (2026-10-23, lifecycle-3) and no uGpTilesPerRow
//      uniform (T is a GLSL literal).
//  P4  MIRROR MAPPING — instance -> tile -> cell is a bijection onto the g x g
//      window for any tile order; unused slots / partial tiles map to nothing.
//  P5  PARITY ON REAL LANDBLOCKS (client_cell_1.dat, 5x5 around Holtburg
//      0xA9B4) — the real CPU provider (real three) at ultra / high / single
//      field, full scatter, every ring: the mirror over ALL instances (all 64
//      tiles) vs the pool's attribute arrays + instanceMatrix, matched by world
//      cell. f64 mirror: live set exact to 0.01 %, every field in tolerance.
//      f32 mirror (the GPU estimate): live-set mismatch + field outliers
//      <= 0.5 %. Plus the unresident / heightless fringe and the interior hook.
//  P6  CULLING — disc, hole, frustum (== three's Frustum.intersectsBox on the
//      same box, with the default AND explicit xyMarginM / zAboveM), null
//      zRange, near-first sort, -1 padding, partial tiles; and end to end:
//      every potentially visible CPU blade is in a kept tile, and the mirror
//      over the CULLED tile list reproduces exactly those blades.
//  P7  GLSL HYGIENE — no backticks, GLSL ES charset only, each uniform declared
//      once, HbBlade / HbCell and every placement function present once,
//      hbGrassPlace = hbGrassPlaceCell(hbGrassCell(id)), T a literal, the
//      interior test after the cheap rejections, the step order of the GLSL =
//      the mirror source's, no grass snippet uniform referenced (the readback
//      page compiles the chain standalone), no instanceMatrix, the generated
//      variant table IS GRASS_VARIANTS (FAM_GRASS codes), the whole injected
//      chain (hash + field + indoor + place) declares each name once.
//  P8  FLAG — `?terrainGrassGpu`: on / off / absent / garbage (warns once) /
//      memoized / reset.
//  P9  module lint-clean (no Math.random / clocks).
//  P10 SPLIT + REORDER (2026-10-23, review gpu-cost-1) — on real Holtburg
//      terrain at ultra and high, every id of every ring, f32 and f64, with an
//      interior hook that culls: the mirror = a port of the ORIGINAL step
//      order (interior test right after the road) field for field, bit for bit
//      (live AND dead blades); = grassGpuPlaceCellMirror(grassGpuCellMirror);
//      the rank of a live blade = grassGpuRankMirror; the interior hook now
//      runs only for blades every cheaper test kept.
//  P11 BLADE REACH (review integ-2) — `grassGpuBladeReach` against a direct
//      JS port of the grass vertex snippet: no sampled input reaches past it,
//      the inputs lined up reach it exactly; the default look stays inside the
//      2 m floors on every ultra / high ring; setLod and wind push it past.
//
// Tolerances: positions are compared within 1e-3 m PLUS the f32 quantum of the
// value — the CPU pool itself stores positions in a Float32Array
// (instanceMatrix), and at Holtburg (y ~ 34.6 km) one f32 ULP is 3.9 mm.

import { existsSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import * as THREE from "three";

// terrain_grass.js FIRST (the app's order): it will import grass_gpu_place.js,
// and grass_gpu_place.js imports it back (see IMPORT ORDER in that header).
import {
  GRASS_VARIANTS, GRASS_DEFAULTS, GRASS_CODES, GRASS_ATTRIBUTES, GRASS_BLADE_POSITIONS,
  createTerrainGrassProvider, resolveGrassConfig, grassLodLayout,
  makeGrassFill, makeGrassBladeGeometry,
} from "./scene3d/terrain_grass.js";
import {
  GRASS_GPU_HASH_GLSL, buildGrassPlaceGlsl, grassGpuRingState, grassGpuWindowMin,
  grassGpuSetWindow, grassGpuPlaceMirror, cullGrassTiles, grassGpuHashU32, grassGpuHash01,
  createGrassGpuRingUniforms, makeGrassGpuBlade, grassGpuVariantCodes,
  grassGpuCellMirror, grassGpuPlaceCellMirror, grassGpuRankMirror, makeGrassGpuCell, grassGpuBladeReach,
  GRASS_GPU_RING_UNIFORMS, GRASS_GPU_MAX_TILES, GRASS_GPU_TILES_PER_ROW,
  GRASS_GPU_CULL_BELOW_M, GRASS_GPU_CULL_ABOVE_M, GRASS_GPU_CULL_XY_MARGIN_M,
} from "./scene3d/grass_gpu_place.js";
import { scatterHashU32, scatterHash01, createScatterPool } from "./scene3d/terrain_scatter.js";
import { createTerrainOracle, cellSwToNeCut } from "./scene3d/terrain_oracle.js";
import { FAM_GRASS, familyForCode, TERRAIN_CODE_COUNT } from "./scene3d/terrain_families.js";
import { lbKeyFromXY } from "./scene3d/landblock_lru.js";
import { terrainGrassGpuEnabled, _resetVfxFlags } from "./scene3d/vfx_flags.js";
import { lintSource } from "./scene3d/vfx/lint_caps.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// Deterministic u32 stream (no Math.random).
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

/** f32 spacing at |v| (the storage quantum of a Float32Array value). */
function ulp32(v) {
  const a = Math.abs(v);
  if (!(a > 1e-30)) return 1.4e-45;
  return 2 ** (Math.floor(Math.log2(a)) - 23);
}

// ---------------------------------------------------------------------------
// DAT reader — copied from test_terrain_grass_offroad.mjs (directory B-tree walk).
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
      const count = d.readUInt32LE(248);
      const leaf = d.readUInt32LE(0) === 0;
      let i = 0;
      for (; i < count; i += 1) {
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

const CELL = process.env.HB_CELL_DAT || "/home/wbterminal/ac_base_dats/client_cell_1.dat";

/** `sampleMirror` adapter over the REAL oracle (Module A's contract). */
function oracleTerrain(oracle) {
  const scratch = {};
  const res = { height: 0, normal: { x: 0, y: 0, z: 1 }, cornerCodes: new Int32Array(4), roadEdgeM: 1e9 };
  return {
    sampleMirror(x, y) {
      const s = oracle.sample(x, y, scratch);
      if (!s || s.hasHeight !== true || !Number.isFinite(s.height)) return null;
      res.height = s.height;
      res.normal.x = s.normal.x; res.normal.y = s.normal.y; res.normal.z = s.normal.z;
      for (let k = 0; k < 4; k += 1) res.cornerCodes[k] = s.cornerCodes[k];
      res.roadEdgeM = Number.isFinite(s.roadEdgeM) ? s.roadEdgeM : 1e9;
      return res;
    },
  };
}

console.log("GPU grass placement — Module C (grass_gpu_place.js)");
console.log("====================================================");

// ---------------------------------------------------------------------------
console.log("\n-- P1. hash: bit-identical to scatterHashU32 (mirror AND the GLSL text) --");
/** Execute GLSL `hbHashU32` by parsing its statements (four forms, nothing else). */
function interpretGlslHash(glsl) {
  const m = /highp uint hbHashU32\(highp uint a, highp uint b, highp uint c, highp uint seed\) \{\n([\s\S]*?)\n\s*return h;\n\}/.exec(glsl);
  if (!m) return null;
  const ops = [];
  for (const raw of m[1].split("\n")) {
    const line = raw.trim();
    let r;
    if ((r = /^highp uint h = seed \^ (\d+)u;$/.exec(line))) ops.push(["init", Number(r[1])]);
    else if ((r = /^h = \(h \^ ([abc])\) \* (\d+)u;$/.exec(line))) ops.push(["mix", r[1], Number(r[2])]);
    else if ((r = /^h \^= h >> (\d+)u;$/.exec(line))) ops.push(["xs", Number(r[1])]);
    else if ((r = /^h \*= (\d+)u;$/.exec(line))) ops.push(["mul", Number(r[1])]);
    else return { error: `unparsed GLSL statement: ${line}` };
  }
  return {
    ops,
    run(a, b, c, seed) {
      const v = { a: a >>> 0, b: b >>> 0, c: c >>> 0 };
      let h = 0;
      for (const op of ops) {
        if (op[0] === "init") h = ((seed >>> 0) ^ op[1]) >>> 0;
        else if (op[0] === "mix") h = Math.imul((h ^ v[op[1]]) >>> 0, op[2]) >>> 0;
        else if (op[0] === "xs") h = (h ^ (h >>> op[1])) >>> 0;
        else h = Math.imul(h, op[1]) >>> 0;
      }
      return h;
    },
  };
}
{
  const gl = interpretGlslHash(GRASS_GPU_HASH_GLSL);
  check("GLSL hbHashU32 parses into the four statement forms (init, 3 x mix, fmix32)",
    !!gl && !gl.error && gl.ops.length === 9, gl && gl.error ? gl.error : "");
  const h01 = /return float\(hbHashU32\(uint\(a\), uint\(b\), uint\(c\), seed\) >> (\d+)u\) \* \(1\.0 \/ (\d+)\.0\);/.exec(GRASS_GPU_HASH_GLSL);
  check("GLSL hbHash01 keeps the top 24 bits: (h >> 8u) * (1.0 / 16777216.0)",
    !!h01 && h01[1] === "8" && h01[2] === "16777216");
  const rng = makeRng(0x1234567);
  const SPECIAL = [0, 1, -1, 2, -2, 255, 256, 2047, 2048, 0x7fffffff, -0x80000000, 0xffffffff, 0x80000000,
    123456, -123456, 212000, -212000, 16, 23, 9, 3];
  const SEEDS = [GRASS_DEFAULTS.seed, GRASS_DEFAULTS.seed ^ Math.imul(1, 0x9e3779b9), (GRASS_DEFAULTS.seed ^ Math.imul(3, 0x9e3779b9)) | 0,
    0, -1, 0x7fffffff, -0x80000000, 0xdeadbeef, 0xdeadbeef | 0, 0x5bd1e995];
  let n = 0, badMirror = 0, badGlsl = 0, bad01 = 0, badF32 = 0, worst01 = 0, firstBad = null;
  const test = (a, b, c, s) => {
    n += 1;
    const ref = scatterHashU32(a, b, c, s);
    if (grassGpuHashU32(a, b, c, s) !== ref) { badMirror += 1; if (!firstBad) firstBad = [a, b, c, s]; }
    if (gl && gl.run && gl.run(a, b, c, s) !== ref) badGlsl += 1;
    const g01 = grassGpuHash01(a, b, c, s);
    const c01 = scatterHash01(a, b, c, s);
    const d = c01 - g01;
    if (!(g01 >= 0 && g01 < 1 && d >= 0 && d < 2 ** -24)) bad01 += 1;
    if (Math.fround(g01) !== g01) badF32 += 1;
    if (d > worst01) worst01 = d;
  };
  for (const a of SPECIAL) for (const b of SPECIAL) for (const s of SEEDS) test(a, b, SPECIAL[(n * 7) % SPECIAL.length], s);
  for (let i = 0; i < 120000; i += 1) {
    // Mix of full-range int32 (negative included), u32 > 2^31, and cell-sized ints.
    const kind = i % 4;
    const r = () => rng() | 0;
    const a = kind === 0 ? r() : kind === 1 ? rng() : kind === 2 ? (r() % 250000) : (rng() % 2048);
    const b = kind === 0 ? r() : kind === 1 ? rng() : kind === 2 ? (r() % 250000) : (rng() % 2048);
    const c = kind < 2 ? r() : (rng() % 32);
    const s = kind === 3 ? SEEDS[i % SEEDS.length] : (i & 1 ? r() : rng());
    test(a, b, c, s);
  }
  check(`JS mirror grassGpuHashU32 === scatterHashU32 on ${n} inputs`, badMirror === 0, `${badMirror} bad, first ${JSON.stringify(firstBad)}`);
  check(`the GLSL text (parsed + executed) === scatterHashU32 on ${n} inputs`, !!gl && gl.run && badGlsl === 0, String(badGlsl));
  check("hash01: in [0,1), never above the CPU value, and within 2^-24 of it", bad01 === 0,
    `${bad01} bad, worst ${worst01}`);
  check("hash01 is exact in f32 (24-bit mantissa), so the GPU value is the mirror value", badF32 === 0, String(badF32));
  check("hash01 of h = 0xffffffff is (2^24 - 1) / 2^24 < 1 (the u32 / 2^32 form rounds to 1.0 in f32)",
    ((0xffffffff >>> 8) * (1 / 16777216)) === 1 - 2 ** -24 && Math.fround(0xffffffff / 4294967296) === 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- P2. split diagonal: the uint cutoff form vs cellSwToNeCut (all 2048 x 2048 cells) --");
{
  const CUT = 2147483682;
  check("2147483682 is the smallest u32 with v * 2.3283064e-10 >= 0.5",
    CUT * 2.3283064e-10 >= 0.5 && (CUT - 1) * 2.3283064e-10 < 0.5);
  const uintCut = (gx, gy) => {
    const inner = (Math.imul(214614067, gx) + 1813693831) >>> 0;
    const v8 = (Math.imul(gy, inner) - Math.imul(1109124029, gx) - 1369149221) >>> 0;
    return v8 >= CUT;
  };
  let bad = 0, sw = 0, first = null;
  for (let gx = 0; gx < 2048; gx += 1) {
    for (let gy = 0; gy < 2048; gy += 1) {
      const a = uintCut(gx, gy);
      if (a !== cellSwToNeCut(gx, gy)) { bad += 1; if (!first) first = [gx, gy]; }
      if (a) sw += 1;
    }
  }
  check(`uint cutoff form === cellSwToNeCut on all ${2048 * 2048} global cells`, bad === 0, `${bad} bad, first ${first}`);
  check("both diagonals actually occur (not a constant)", sw > 1e6 && sw < 2048 * 2048 - 1e6, String(sw));
  // Module A (written in parallel) — informative only, its own test owns it.
  try {
    const A = await import("./scene3d/terrain_field_gpu.js");
    if (typeof A.fieldCellSwToNeCut === "function") {
      let badA = 0;
      for (let gx = 0; gx < 2048; gx += 3) for (let gy = 0; gy < 2048; gy += 1) if (A.fieldCellSwToNeCut(gx, gy) !== uintCut(gx, gy)) badA += 1;
      console.log(`  [info] terrain_field_gpu.js fieldCellSwToNeCut vs the uint form (every 3rd column): ${badA} mismatches; GLSL has 2147483682u: ${String(A.TERRAIN_FIELD_GLSL).includes("2147483682")}`);
    }
  } catch (e) {
    console.log(`  [info] terrain_field_gpu.js not importable right now (${e.message}) — Module A is checked by its own test`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- P3. ring state = what the CPU pools use --");
const STUB_H = 57.25;
function stubOracle(code) {
  return {
    sample(x, y, out) {
      const r = out || {};
      r.code = code; r.family = familyForCode(code);
      r.hasHeight = true; r.height = STUB_H;
      r.normal = r.normal || { x: 0, y: 0, z: 1 };
      r.normal.x = 0; r.normal.y = 0; r.normal.z = 1;
      r.cornerCodes = r.cornerCodes || new Uint8Array(4);
      r.cornerCodes.fill(code);
      r.cornerRoads = r.cornerRoads || new Uint8Array(4);
      r.hasRoads = false; r.roadEdgeM = Infinity;
      return r;
    },
  };
}
function buildProvider(config, oracle, cx, cy, withThree = true) {
  const parent = withThree ? new THREE.Group() : null;
  const p = createTerrainGrassProvider({
    THREE: withThree ? THREE : null, parent,
    config: { density: 1, stomp: false, offRoad: true, ...config },
  });
  p.update(0.016, {
    scene3d: null, tSec: 0, dt: 0.016, hasPlayer: true, camera: null, quality: null,
    playerPos: { x: cx, y: cy, z: 60 }, oracle, trail: null,
  });
  return p;
}
const LAYOUTS = [
  ["single field 60025 / 48 m (reach 1)", { blades: 60025, radiusM: 48, reach: 1 }],
  ["single field, NON-square 50000 / 37.5 m", { blades: 50000, radiusM: 37.5, reach: 1 }],
  ["ultra 4 rings 119716 / 40 m / reach 5", { blades: 119716, radiusM: 40, reach: 5 }],
  ["high 4 rings 60025 / 32 m / reach 5, seed -123456789", { blades: 60025, radiusM: 32, reach: 5, seed: -123456789 }],
  ["3 rings 24336 / 33.3 m / reach 3, seed 0xdeadbeef", { blades: 24336, radiusM: 33.3, reach: 3, seed: 0xdeadbeef }],
];
{
  const cx = 0xa9 * 192 + 96.37, cy = 0xb4 * 192 + 101.9;
  for (const [name, config] of LAYOUTS) {
    // LushGrass everywhere: every blade lives, so every attribute is checkable.
    const p = buildProvider(config, stubOracle(3), cx, cy);
    const cfg = p.quality();
    const layout = p._layout;
    const pools = p._pools;
    let geomOk = true, winOk = true, posBad = 0, randBad = 0, liveBad = 0, total = 0;
    for (let k = 0; k < layout.length; k += 1) {
      const st = grassGpuRingState(layout[k], cfg);
      const pool = pools[k];
      if (pool.gridSize !== st.g || pool.count !== st.count || pool.cellSizeM !== st.cell || pool.radiusM !== st.radiusM
        || pool.seed !== st.seed || pool.randSalt !== st.randSalt || st.ts !== Math.ceil(st.g / 8) || st.T !== 8) geomOk = false;
      grassGpuSetWindow(st, cx, cy);
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (let i = 0; i < pool.count; i += 1) {
        mnx = Math.min(mnx, pool._cellX[i]); mny = Math.min(mny, pool._cellY[i]);
        mxx = Math.max(mxx, pool._cellX[i]); mxy = Math.max(mxy, pool._cellY[i]);
      }
      if (mnx !== st.winMin[0] || mny !== st.winMin[1] || mxx !== st.winMin[0] + st.g - 1 || mxy !== st.winMin[1] + st.g - 1
        || grassGpuWindowMin(cx, st.radiusM, st.cell) !== mnx || grassGpuWindowMin(cy, st.radiusM, st.cell) !== mny) winOk = false;
      const m = pool.mesh.instanceMatrix.array;
      const A = pool.arrays;
      for (let i = 0; i < pool.count; i += 1) {
        total += 1;
        if (pool._live[i] !== 1) { liveBad += 1; continue; }
        const gx = pool._cellX[i], gy = pool._cellY[i];
        const x = (gx + 0.5 + (scatterHash01(gx, gy, 1, st.seed) - 0.5) * st.jitter) * st.cell;
        const y = (gy + 0.5 + (scatterHash01(gx, gy, 2, st.seed) - 0.5) * st.jitter) * st.cell;
        if (m[i * 16 + 12] !== Math.fround(x) || m[i * 16 + 13] !== Math.fround(y)
          || m[i * 16 + 14] !== Math.fround(STUB_H + st.heightOffsetM)) posBad += 1;
        const rand = (ch) => scatterHash01(gx, gy, ch + 16, st.randSeed);
        if (A.aRank[i] !== Math.fround(rand(7)) || A.aRot[i] !== Math.fround(rand(0) * 6.283185307179586)
          || A.aScale[i * 2] !== Math.fround(GRASS_VARIANTS[3].h * (0.7 + 0.6 * rand(1)))) randBad += 1;
      }
    }
    check(`${name}: ${layout.length} ring(s) — grid / count / cell / radius / seed / randSalt / ts = the pools'`, geomOk);
    check(`${name}: window min = the pools' cell range (= grassGpuWindowMin, = grassGpuSetWindow)`, winOk);
    check(`${name}: positions = (g + 0.5 + jitter(seed)) * cell, z = h + heightOffsetM, bit-exact vs instanceMatrix`,
      posBad === 0 && liveBad === 0, `${posBad} bad, ${liveBad} not live of ${total}`);
    check(`${name}: rank / rot / height = the randSeed stream, bit-exact`, randBad === 0, String(randBad));
    p.dispose();

    // PatchyGrassland everywhere: bare clumps read the BASE seed, thinning the
    // ring randSeed — the live set must be exactly predicted by the state.
    const q = buildProvider(config, stubOracle(9), cx, cy);
    let mism = 0, live = 0, n = 0;
    for (let k = 0; k < layout.length; k += 1) {
      const st = grassGpuRingState(q._layout[k], q.quality());
      const pool = q._pools[k];
      for (let i = 0; i < pool.count; i += 1) {
        const gx = pool._cellX[i], gy = pool._cellY[i];
        const x = (gx + 0.5 + (scatterHash01(gx, gy, 1, st.seed) - 0.5) * st.jitter) * st.cell;
        const y = (gy + 0.5 + (scatterHash01(gx, gy, 2, st.seed) - 0.5) * st.jitter) * st.cell;
        const v = GRASS_VARIANTS[9];
        const want = !(scatterHash01(Math.floor(x / 2), Math.floor(y / 2), 9, st.baseSeed) < v.bare)
          && !(scatterHash01(gx, gy, 20, st.randSeed) > v.keep);
        n += 1;
        if (want) live += 1;
        if (want !== (pool._live[i] === 1)) mism += 1;
      }
    }
    check(`${name}: bare clumps (BASE seed ${q.quality().seed}) + keep (randSeed) predict the live set exactly`,
      mism === 0 && live > 0.2 * n && live < 0.6 * n, `${mism} mismatches, live ${live}/${n}`);
    q.dispose();
  }

  // randSeed fold for arbitrary salts / seeds, straight off createScatterPool.
  let saltBad = 0;
  const rng = makeRng(77);
  for (let t = 0; t < 40; t += 1) {
    const seed = t < 4 ? [0, -1, 0x7fffffff, -0x80000000][t] : rng() | 0;
    const randSalt = t % 5 === 0 ? 0 : (t % 3 === 0 ? -(rng() % 1000) : rng() % 100000);
    const st = grassGpuRingState({ count: 16, radiusM: 10, seed, randSalt }, {});
    const got = [];
    const pool = createScatterPool({
      count: 16, radiusM: 10, seed, randSalt, shape: "square", oracle: stubOracle(3),
      fill: (ctx) => { got.push([ctx.cellX, ctx.cellY, ctx.rand(5)]); },
    });
    pool.update(0, 1000.5, 2000.25);
    for (const [gx, gy, r] of got) if (r !== scatterHash01(gx, gy, 21, st.randSeed)) saltBad += 1;
    if (got.length !== 16 || st.seed !== pool.seed) saltBad += 1;
  }
  check("randSeed = createScatterPool's fold for 40 seeds x salts (0, negative, large)", saltBad === 0, String(saltBad));

  // The window at many centres (incl. negative and fractional), every ultra ring.
  const ultra = resolveGrassConfig({ blades: 119716, radiusM: 40, reach: 5, density: 1 });
  const rings = grassLodLayout(ultra);
  let wBad = 0, wN = 0;
  const centres = [[0, 0], [-37.2, 12.5], [25, 25], [32544.0, 34656.0], [32544.123, 34656.987], [49151.9, 49151.9],
    [12345.678, 23456.789], [-0.0001, 1e-9], [100, -100], [8000.5, 8000.25]];
  for (const ring of rings) {
    const st = grassGpuRingState(ring, ultra);
    const pool = createScatterPool({ count: ring.count, radiusM: ring.radiusM, shape: "square", oracle: null });
    for (const [x, y] of centres) {
      pool.rescatterAll(x, y);
      let mnx = Infinity, mny = Infinity;
      for (let i = 0; i < pool.count; i += 1) { if (pool._cellX[i] < mnx) mnx = pool._cellX[i]; if (pool._cellY[i] < mny) mny = pool._cellY[i]; }
      const w = grassGpuWindowMin([x, y], st.radiusM, st.cell);
      const w2 = grassGpuWindowMin({ x, y }, st.radiusM, st.cell);
      grassGpuSetWindow(st, x, y);
      wN += 1;
      if (w[0] !== mnx || w[1] !== mny || w2[0] !== mnx || w2[1] !== mny || st.winMin[0] !== mnx || st.winMin[1] !== mny) wBad += 1;
    }
  }
  check(`grassGpuWindowMin / grassGpuSetWindow = the pool window at ${wN} (ring, centre) pairs`, wBad === 0, String(wBad));

  // The uniform bag binds the mutable state by reference.
  const st = grassGpuRingState(rings[1], ultra);
  const bag = createGrassGpuRingUniforms(st);
  check("createGrassGpuRingUniforms: exactly the declared uniform names",
    JSON.stringify(Object.keys(bag).sort()) === JSON.stringify([...GRASS_GPU_RING_UNIFORMS].sort()));
  check("…uGpWindowMin / uGpTiles hold state.winMin / state.tileIds BY REFERENCE (Float32Array, three-uploadable)",
    bag.uGpWindowMin.value === st.winMin && bag.uGpTiles.value === st.tileIds
    && st.tileIds instanceof Float32Array && st.tileIds.length === 64 && st.winMin instanceof Float32Array);
  check("…seeds are non-negative u32 for the uint uniforms; ring 1 salt folds back to the base seed",
    bag.uGpSeed.value === st.seed >>> 0 && bag.uGpRandSeed.value === st.randSeed >>> 0
    && bag.uGpBaseSeed.value === (ultra.seed >>> 0) && st.randSeed === ultra.seed && bag.uGpSeed.value >= 0);
  check("…jitter 1, heightOffset -0.02, verge 1.5, offRoad from the config; state T 8 and NO uGpTilesPerRow uniform (a GLSL literal)",
    bag.uGpJitter.value === 1 && bag.uGpHeightOffset.value === -0.02 && bag.uGpVergeM.value === 1.5
    && bag.uGpOffRoad.value === (ultra.offRoad ? 1 : 0) && st.T === GRASS_GPU_TILES_PER_ROW && !("uGpTilesPerRow" in bag));
  // lifecycle-3: applyGrassLodLook REPLACES ring.band, so a state copy would
  // go stale; the state carries none (readers take the live ring.band).
  check("grassGpuRingState carries no dissolve band (the live one is ring.band)",
    !("band" in st) && !("bandAtBuild" in st) && Array.isArray(rings[1].band));
}

// ---------------------------------------------------------------------------
console.log("\n-- P4. instance -> tile -> cell --");
{
  const flat = { sampleMirror: () => null };
  let ok = true;
  const detail = [];
  for (const g of [1, 2, 7, 8, 9, 15, 16, 17, 162, 201, 346]) {
    const st = grassGpuRingState({ count: g * g, radiusM: 50 }, {});
    grassGpuSetWindow(st, 1234.5, 6789.25);
    if (st.g !== g) { ok = false; detail.push(`g ${st.g} != ${g}`); continue; }
    // A scrambled tile order: the mapping must not care.
    const rng = makeRng(g);
    const order = Array.from({ length: 64 }, (_, i) => i);
    for (let i = 63; i > 0; i -= 1) { const j = rng() % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    st.tileIds.set(order);
    const seen = new Uint8Array(g * g);
    const b = makeGrassGpuBlade();
    let mapped = 0, dup = 0, out = 0, formulaBad = 0;
    for (let id = 0; id < st.maxInstances; id += 1) {
      grassGpuPlaceMirror(id, st, flat, null, b);
      if (b.live) { ok = false; }
      if (!b.mapped) continue;
      const ox = b.cellX - st.winMin[0], oy = b.cellY - st.winMin[1];
      if (ox < 0 || oy < 0 || ox >= g || oy >= g) { out += 1; continue; }
      // The spec formula, written independently.
      const n = st.ts * st.ts, slot = Math.floor(id / n), li = id % n, tile = order[slot];
      if (ox !== (tile % 8) * st.ts + (li % st.ts) || oy !== Math.floor(tile / 8) * st.ts + Math.floor(li / st.ts)) formulaBad += 1;
      if (seen[ox * g + oy]) dup += 1;
      seen[ox * g + oy] = 1;
      mapped += 1;
    }
    if (mapped !== g * g || dup || out || formulaBad) { ok = false; detail.push(`g=${g}: mapped ${mapped}/${g * g} dup ${dup} out ${out} formula ${formulaBad}`); }
    // Beyond the last slot, a negative id, an unused slot: nothing.
    grassGpuPlaceMirror(st.maxInstances, st, flat, null, b);
    if (b.mapped || b.live) { ok = false; detail.push(`g=${g}: id past 64 tiles mapped`); }
    grassGpuPlaceMirror(-1, st, flat, null, b);
    if (b.mapped) { ok = false; detail.push(`g=${g}: id -1 mapped`); }
    st.tileIds[0] = -1;
    grassGpuPlaceMirror(0, st, flat, null, b);
    if (b.mapped) { ok = false; detail.push(`g=${g}: unused slot mapped`); }
  }
  check("bijection onto the g x g window for g in {1..346}, scrambled tile order, spec formula; dead on unresident ground",
    ok, detail.join("; "));
}

// ---------------------------------------------------------------------------
console.log("\n-- P5. parity on real landblocks: mirror vs the real CPU provider --");
const LBS = [];
let ORACLE = null;
if (!existsSync(CELL)) {
  console.log(`  real-DAT parity not run: ${CELL} missing (set HB_CELL_DAT)`);
} else {
  const dat = openDat(CELL);
  for (let dx = -2; dx <= 2; dx += 1) for (let dy = -2; dy <= 2; dy += 1) {
    const lb = readLandblock(dat, 0xa9 + dx, 0xb4 + dy);
    if (lb) LBS.push(lb);
  }
  dat.close();
  check("5x5 landblocks around Holtburg (0xA9B4) read", LBS.length === 25);
  ORACLE = createTerrainOracle();
  for (const lb of LBS) {
    ORACLE.noteLandblock(lbKeyFromXY(lb.lbX, lb.lbY), { codes: lb.codes, heights: lb.heights, roads: lb.roads, lbX: lb.lbX, lbY: lb.lbY });
  }
}

/**
 * Mirror every instance of every ring of a built provider and compare with its
 * pools by world cell. Returns per-mode tallies.
 */
function parity(provider, terrain, indoor, px, py, f64) {
  const cfg = provider.quality();
  const layout = provider._layout;
  const res = { rings: [], mism: 0, liveCpu: 0, liveGpu: 0, matched: 0, fieldOut: 0, worst: {}, geomOk: true, mapOk: true, first: null };
  const b = makeGrassGpuBlade();
  const bump = (k, v) => { if (!(res.worst[k] >= v)) res.worst[k] = v; };
  for (let k = 0; k < layout.length; k += 1) {
    const pool = provider._pools[k];
    const st = grassGpuRingState(layout[k], cfg);
    grassGpuSetWindow(st, px, py);
    const g = st.g, wmx = st.winMin[0], wmy = st.winMin[1];
    if (pool.gridSize !== g || pool.cellSizeM !== st.cell || pool.seed !== st.seed) res.geomOk = false;
    const byCell = new Int32Array(g * g).fill(-1);
    for (let i = 0; i < pool.count; i += 1) {
      const ox = pool._cellX[i] - wmx, oy = pool._cellY[i] - wmy;
      if (ox < 0 || oy < 0 || ox >= g || oy >= g || byCell[ox * g + oy] !== -1) { res.mapOk = false; continue; }
      byCell[ox * g + oy] = i;
    }
    const m = pool.mesh.instanceMatrix.array;
    const A = pool.arrays;
    let ringMism = 0, ringLive = 0, ringMapped = 0;
    for (let id = 0; id < st.maxInstances; id += 1) {
      grassGpuPlaceMirror(id, st, terrain, indoor, b, { f64 });
      if (!b.mapped) continue;
      ringMapped += 1;
      const i = byCell[(b.cellX - wmx) * g + (b.cellY - wmy)];
      if (i < 0) { res.mapOk = false; continue; }
      const cpuLive = pool._live[i] === 1;
      if (cpuLive) { res.liveCpu += 1; ringLive += 1; }
      if (b.live) res.liveGpu += 1;
      if (cpuLive !== b.live) {
        res.mism += 1; ringMism += 1;
        if (!res.first) res.first = { ring: k, cell: [b.cellX, b.cellY], cpuLive, gpuLive: b.live, x: b.origin.x, y: b.origin.y };
        continue;
      }
      if (!cpuLive) continue;
      res.matched += 1;
      const cx = m[i * 16 + 12], cy = m[i * 16 + 13], cz = m[i * 16 + 14];
      const nx = A.aNormal[i * 3], ny = A.aNormal[i * 3 + 1], nz = A.aNormal[i * 3 + 2];
      const dxy = Math.max(Math.abs(b.origin.x - cx), Math.abs(b.origin.y - cy));
      const dz = Math.abs(b.origin.z - cz);
      const qxy = Math.max(ulp32(cx), ulp32(cy));
      const slope = Math.sqrt(nx * nx + ny * ny) / Math.max(nz, 1e-3);
      const tolXy = 1e-3 + (f64 ? 1 : 2) * qxy;
      const tolZ = 1e-3 + ulp32(cz) + (f64 ? 0 : slope * 3 * qxy);
      const dn = Math.max(Math.abs(b.normal.x - nx), Math.abs(b.normal.y - ny), Math.abs(b.normal.z - nz));
      const ds = Math.max(
        Math.abs(b.scale.x - A.aScale[i * 2]), Math.abs(b.scale.y - A.aScale[i * 2 + 1]),
        Math.abs(b.rot - A.aRot[i]),
        Math.abs(b.tint.x - A.aTint[i * 3]), Math.abs(b.tint.y - A.aTint[i * 3 + 1]), Math.abs(b.tint.z - A.aTint[i * 3 + 2]),
        Math.abs(b.mat - A.aFamilyParam[i]), Math.abs(b.rank - A.aRank[i]),
      );
      bump("xy", dxy); bump("z", dz); bump("normal", dn); bump("scalar", ds);
      if (dxy > tolXy || dz > tolZ || dn > 1e-4 || ds > 1e-4) {
        res.fieldOut += 1;
        if (!res.firstField) res.firstField = { ring: k, cell: [b.cellX, b.cellY], dxy, tolXy, dz, tolZ, dn, ds };
      }
    }
    if (ringMapped !== g * g) res.mapOk = false;
    res.rings.push({ level: k, g, live: ringLive, mism: ringMism });
  }
  return res;
}

function fmtWorst(w) {
  return Object.entries(w).map(([k, v]) => `${k} ${v.toExponential(2)}`).join(", ");
}

if (ORACLE) {
  const terrain = oracleTerrain(ORACLE);
  const SPOTS = [
    ["Holtburg centre (0xA9B4)", 0xa9 * 192 + 96, 0xb4 * 192 + 96],
    ["owner's road screenshot, 42.0N 33.6E", (336 + 1019.5) * 24, (420 + 1019.5) * 24],
  ];
  const CONFIGS = [
    ["ultra 119716 / 40 m / reach 5", { blades: 119716, radiusM: 40, reach: 5 }],
    ["high 60025 / 32 m / reach 5", { blades: 60025, radiusM: 32, reach: 5 }],
    ["single field 60025 / 48 m", { blades: 60025, radiusM: 48, reach: 1 }],
  ];
  for (const [cname, config] of CONFIGS) {
    for (const [sname, px, py] of SPOTS) {
      const p = buildProvider(config, ORACLE, px, py);
      const tag = `${cname} @ ${sname}`;
      const e = parity(p, terrain, null, px, py, true);
      const f = parity(p, terrain, null, px, py, false);
      const live = Math.max(e.liveCpu, 1);
      console.log(`  [info] ${tag}: rings ${e.rings.map((r) => `${r.level}:${r.live}`).join(" ")} live; `
        + `f64 mismatch ${e.mism}, worst ${fmtWorst(e.worst)}; f32 mismatch ${f.mism} + field outliers ${f.fieldOut}, worst ${fmtWorst(f.worst)}`);
      check(`${tag}: pools = ring state; the mirror covers every window cell exactly once`, e.geomOk && e.mapOk && f.mapOk);
      check(`${tag}: real grass lives (> 25 % of ${p.stats().blades} blades)`, e.liveCpu > 0.25 * p.stats().blades, String(e.liveCpu));
      check(`${tag}: f64 mirror — live set matches the CPU per world cell (<= 0.01 %)`,
        e.mism <= 1e-4 * live, `${e.mism} ${JSON.stringify(e.first)}`);
      check(`${tag}: f64 mirror — every matched blade in tolerance (xy/z 1e-3 + f32 storage, normal + scalars 1e-4)`,
        e.fieldOut === 0 && e.matched > 0, `${e.fieldOut} ${JSON.stringify(e.firstField)}`);
      check(`${tag}: f32 mirror (GPU estimate) — live-set mismatch <= 0.5 %`, f.mism <= 0.005 * live,
        `${f.mism}/${live} ${JSON.stringify(f.first)}`);
      check(`${tag}: f32 mirror — mismatch + field outliers <= 0.5 %`, f.mism + f.fieldOut <= 0.005 * live,
        `${f.mism}+${f.fieldOut}/${live} ${JSON.stringify(f.firstField)}`);
      p.dispose();
    }
  }

  // The unresident / heightless fringe: east edge of the loaded block, with the
  // easternmost loaded column's centre LB re-noted WITHOUT heights.
  {
    const o2 = createTerrainOracle();
    for (const lb of LBS) {
      const noH = lb.lbX === 0xab && lb.lbY === 0xb4;
      o2.noteLandblock(lbKeyFromXY(lb.lbX, lb.lbY), { codes: lb.codes, heights: noH ? undefined : lb.heights, roads: lb.roads, lbX: lb.lbX, lbY: lb.lbY });
    }
    const px = 0xac * 192 - 30, py = 0xb4 * 192 + 96;
    const p = buildProvider({ blades: 119716, radiusM: 40, reach: 5 }, o2, px, py);
    let nulls = 0, noH = 0;
    for (const pool of p._pools) { const s = pool.stats(); nulls += s.nullSamples; noH += s.noHeight; }
    const e = parity(p, oracleTerrain(o2), null, px, py, true);
    const f = parity(p, oracleTerrain(o2), null, px, py, false);
    console.log(`  [info] fringe: CPU nullSamples ${nulls}, noHeight ${noH}; f64 mismatch ${e.mism}, f32 ${f.mism}+${f.fieldOut}`);
    check("fringe scenario exercises unresident (null) AND heightless LBs on the CPU", nulls > 1000 && noH > 1000, `${nulls} ${noH}`);
    check("fringe: f64 mirror — live set exact (<= 0.01 %), fields in tolerance",
      e.mapOk && e.mism <= 1e-4 * Math.max(e.liveCpu, 1) && e.fieldOut === 0, `${e.mism} ${e.fieldOut} ${JSON.stringify(e.first)}`);
    check("fringe: f32 mirror — mismatch + outliers <= 0.5 %", f.mism + f.fieldOut <= 0.005 * Math.max(f.liveCpu, 1));
    p.dispose();
  }

  // The interior hook: a raw pool built exactly like the provider's ring, with
  // an exclude test the mirror sees as gpuContainsMirror. Box 3 only matches
  // when it is handed the GROUND height (not height + heightOffsetM).
  {
    const cfg = resolveGrassConfig({ blades: 119716, radiusM: 40, reach: 5, density: 1, stomp: false, offRoad: true });
    const ring = grassLodLayout(cfg)[0];
    const px = 0xa9 * 192 + 96, py = 0xb4 * 192 + 96;
    const rects = [[px - 10, py - 10, px - 2, py - 4], [px + 3, py + 1, px + 12, py + 9], [px - 20, py + 5, px - 8, py + 20]];
    const contains = (x, y, z) => {
      if (x >= rects[0][0] && x <= rects[0][2] && y >= rects[0][1] && y <= rects[0][3]) return true;
      if (x >= rects[1][0] && x <= rects[1][2] && y >= rects[1][1] && y <= rects[1][3]) return true;
      if (x >= rects[2][0] && x <= rects[2][2] && y >= rects[2][1] && y <= rects[2][3]) {
        const h = ORACLE.heightAt(x, y);
        return h !== null && Math.abs(z - h) < 1e-6;
      }
      return false;
    };
    const pool = createScatterPool({
      THREE, geometry: makeGrassBladeGeometry(THREE), material: new THREE.MeshBasicMaterial(),
      oracle: ORACLE, count: ring.count, radiusM: ring.radiusM, fadeFraction: ring.fadeFraction,
      shape: "square", fadeShape: "disc", seed: ring.seed, randSalt: ring.randSalt,
      heightOffsetM: GRASS_DEFAULTS.heightOffsetM, attributes: GRASS_ATTRIBUTES.map((a) => ({ ...a })),
      offRoad: true, offRoadVergeM: GRASS_DEFAULTS.roadVergeM, exclude: contains, fill: makeGrassFill(cfg.seed),
    });
    pool.update(0.016, px, py, 60);
    const fake = { quality: () => cfg, _layout: [ring], _pools: [pool] };
    const indoor = { gpuContainsMirror: contains };
    const e = parity(fake, terrain, indoor, px, py, true);
    const f = parity(fake, terrain, indoor, px, py, false);
    const none = parity(fake, terrain, null, px, py, true);
    const rejects = pool.stats().excludeRejects;
    console.log(`  [info] interior: CPU excludeRejects ${rejects}; f64 mismatch ${e.mism} (without the hook: ${none.mism}); f32 ${f.mism}+${f.fieldOut}`);
    check("interior: the boxes really cull blades on the CPU (incl. the ground-height box)", rejects > 200, String(rejects));
    check("interior: f64 mirror with gpuContainsMirror(x, y, groundHeight) — live set exact", e.mism === 0 && e.fieldOut === 0,
      `${e.mism} ${JSON.stringify(e.first)}`);
    // (Not every excluded blade would have lived: the fill rejects some anyway.)
    check("interior: …and the hook is load-bearing (without it, the excluded blades come back)",
      none.mism > 0.3 * rejects && none.liveGpu > e.liveGpu, `${none.mism} of ${rejects}`);
    check("interior: f32 mirror <= 0.5 %", f.mism + f.fieldOut <= 0.005 * Math.max(f.liveCpu, 1));
    pool.dispose();
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- P6. tile culling --");
{
  const out = new Float32Array(64);
  // A ring-0-like layout: g 201, ts 26 (8 x 26 = 208 >= 201), 50 m window.
  const g = 201, W = 25, cell = 2 * W / g;
  const cx = 32544.3, cy = 34656.8;
  const winMin = [Math.floor((cx - W) / cell), Math.floor((cy - W) / cell)];
  const ts = Math.ceil(g / 8);
  const rectOf = (t) => {
    const ox0 = (t % 8) * ts, oy0 = Math.floor(t / 8) * ts;
    if (ox0 >= g || oy0 >= g) return null;
    const ox1 = Math.min(ox0 + ts, g), oy1 = Math.min(oy0 + ts, g);
    return { ox0, oy0, ox1, oy1, x0: (winMin[0] + ox0) * cell, x1: (winMin[0] + ox1) * cell, y0: (winMin[1] + oy0) * cell, y1: (winMin[1] + oy1) * cell };
  };
  const flatZ = () => ({ min: 50, max: 60 });
  const base = { winMin, g, ts, T: 8, cell, center: [cx, cy], outerR: W, holeR: -2, planes: null, zRange: flatZ, camPos: null };
  const keptSet = (n) => new Set(Array.from(out.slice(0, n)));
  // Per-CELL brute force (an independent formulation of the rect tests).
  const cellNear = (gx, gy, px, py) => {
    const x0 = gx * cell, x1 = (gx + 1) * cell, y0 = gy * cell, y1 = (gy + 1) * cell;
    const dx = Math.max(x0 - px, 0, px - x1), dy = Math.max(y0 - py, 0, py - y1);
    return Math.sqrt(dx * dx + dy * dy);
  };
  const cellFar = (gx, gy, px, py) => {
    const x0 = gx * cell, x1 = (gx + 1) * cell, y0 = gy * cell, y1 = (gy + 1) * cell;
    return Math.hypot(Math.max(Math.abs(x0 - px), Math.abs(x1 - px)), Math.max(Math.abs(y0 - py), Math.abs(y1 - py)));
  };
  {
    const n = cullGrassTiles(base, out);
    const kept = keptSet(n);
    let bad = 0;
    for (let t = 0; t < 64; t += 1) {
      const r = rectOf(t);
      if (!r) { if (kept.has(t)) bad += 1; continue; }
      let anyIn = false;
      for (let ox = r.ox0; ox < r.ox1 && !anyIn; ox += 1) for (let oy = r.oy0; oy < r.oy1 && !anyIn; oy += 1) {
        if (cellNear(winMin[0] + ox, winMin[1] + oy, cx, cy) <= W) anyIn = true;
      }
      if (anyIn !== kept.has(t)) bad += 1;
    }
    check(`disc: kept <=> some cell of the tile reaches inside outerR (${n} of 64 kept)`, bad === 0 && n < 64 && n > 40, `${bad} bad`);
    check("disc: out is padded with -1 after the survivors", Array.from(out.slice(n)).every((v) => v === -1));
  }
  {
    // Ring-2-like: W 100. NOTE the default dissolve start band[0] = 0.6 x 50 =
    // 30 m (0.3 W) never covers a whole tile: the window is centred on the
    // player, so the four central tiles each reach 0.354 W from it. A 40 m hole
    // (lodBlend 0.8) does, so that is what exercises the rule here.
    const g2 = 162, W2 = 100, cell2 = 2 * W2 / g2, ts2 = Math.ceil(g2 / 8), hole = 40;
    const wm2 = [Math.floor((cx - W2) / cell2), Math.floor((cy - W2) / cell2)];
    const n = cullGrassTiles({ ...base, g: g2, ts: ts2, cell: cell2, winMin: wm2, outerR: W2, holeR: hole }, out);
    const kept = keptSet(n);
    let bad = 0, holed = 0;
    for (let t = 0; t < 64; t += 1) {
      const ox0 = (t % 8) * ts2, oy0 = Math.floor(t / 8) * ts2;
      if (ox0 >= g2 || oy0 >= g2) { if (kept.has(t)) bad += 1; continue; }
      let anyNear = false, allHole = true;
      for (let ox = ox0; ox < Math.min(ox0 + ts2, g2); ox += 1) for (let oy = oy0; oy < Math.min(oy0 + ts2, g2); oy += 1) {
        const gx = wm2[0] + ox, gy = wm2[1] + oy;
        const x0 = gx * cell2, y0 = gy * cell2;
        const near = Math.hypot(Math.max(x0 - cx, 0, cx - x0 - cell2), Math.max(y0 - cy, 0, cy - y0 - cell2));
        const far = Math.hypot(Math.max(Math.abs(x0 - cx), Math.abs(x0 + cell2 - cx)), Math.max(Math.abs(y0 - cy), Math.abs(y0 + cell2 - cy)));
        if (far >= hole) allHole = false;
        if (near <= W2) anyNear = true;
      }
      if (allHole) holed += 1;
      if ((anyNear && !allHole) !== kept.has(t)) bad += 1;
    }
    check(`hole: tiles wholly inside band[0] are culled, the rest of the disc kept (${holed} holed, ${n} kept)`, bad === 0 && holed >= 1, `${bad} bad`);
  }
  {
    // zRange: null => no resident terrain => culled; args are the tile rects.
    let n = cullGrassTiles({ ...base, zRange: () => null }, out);
    check("zRange returning null everywhere culls every tile (0, all -1)", n === 0 && Array.from(out).every((v) => v === -1));
    const calls = [];
    n = cullGrassTiles({ ...base, outerR: Infinity, zRange: (x0, y0, x1, y1) => { calls.push([x0, y0, x1, y1]); return x0 >= cx ? { min: 50, max: 60 } : null; } }, out);
    let argsOk = calls.length === 64;
    for (const [x0, y0, x1, y1] of calls) {
      const t = (() => { for (let k = 0; k < 64; k += 1) { const r = rectOf(k); if (r && r.x0 === x0 && r.y0 === y0 && r.x1 === x1 && r.y1 === y1) return k; } return -1; })();
      if (t < 0) argsOk = false;
    }
    const kept = keptSet(n);
    let eastOnly = true;
    for (const t of kept) if (!(rectOf(t).x0 >= cx)) eastOnly = false;
    check("zRange is called with each tile's exact rect (x0, y0, x1, y1), partial tiles clipped to g", argsOk, String(calls.length));
    check("a null zRange culls exactly those tiles", eastOnly && n > 0 && n < 64);
    n = cullGrassTiles({ ...base, outerR: Infinity, zRange: undefined }, out);
    check("no zRange function at all = no z cull (all 64 tiles kept)", n === 64);
    // Partial tiles: g = 10, ts = 2 -> only tiles with tx, ty < 5 have cells.
    n = cullGrassTiles({ ...base, g: 10, ts: 2, outerR: Infinity, center: [0, 0], winMin: [0, 0], cell: 1 }, out);
    let partialOk = n === 25;
    for (let k = 0; k < n; k += 1) if ((out[k] % 8) >= 5 || Math.floor(out[k] / 8) >= 5) partialOk = false;
    check("tiles past the grid (g 10, ts 2) are never returned (25 of 64)", partialOk, String(n));
  }
  {
    // Near-first sort: by distance from camPos to the tile (rect + z range), else the centre.
    const cam = [cx + 7.3, cy - 3.1, 90];
    const n = cullGrassTiles({ ...base, outerR: Infinity, camPos: cam }, out);
    const keyOf = (t, p, useZ) => {
      const r = rectOf(t);
      const dx = Math.max(r.x0 - p[0], 0, p[0] - r.x1), dy = Math.max(r.y0 - p[1], 0, p[1] - r.y1);
      const dz = useZ ? Math.max(50 - GRASS_GPU_CULL_BELOW_M - p[2], 0, p[2] - 60 - GRASS_GPU_CULL_ABOVE_M) : 0;
      return dx * dx + dy * dy + dz * dz;
    };
    let sorted = n === 64;
    for (let k = 1; k < n; k += 1) if (keyOf(out[k - 1], cam, true) > keyOf(out[k], cam, true)) sorted = false;
    const first = rectOf(out[0]);
    check("sorted NEAREST-FIRST from camPos; the tile under the camera is first",
      sorted && cam[0] >= first.x0 && cam[0] <= first.x1 && cam[1] >= first.y0 && cam[1] <= first.y1);
    const n2 = cullGrassTiles({ ...base, outerR: Infinity, camPos: null }, out);
    let sorted2 = n2 === 64;
    for (let k = 1; k < n2; k += 1) if (keyOf(out[k - 1], [cx, cy], false) > keyOf(out[k], [cx, cy], false)) sorted2 = false;
    const f2 = rectOf(out[0]);
    check("camPos null: sorted from the centre", sorted2 && cx >= f2.x0 && cx <= f2.x1 && cy >= f2.y0 && cy <= f2.y1);
    const again = new Float32Array(64);
    cullGrassTiles({ ...base, outerR: Infinity, camPos: null }, again);
    check("deterministic: the same inputs give the same order", Array.from(again).join() === Array.from(out).join());
  }
  {
    // Frustum: planes from a real three camera; every tile's verdict must be
    // three's own Frustum.intersectsBox on the same (margined) box.
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
    cam.up.set(0, 0, 1);
    cam.position.set(cx - 6, cy + 2, 63);
    cam.lookAt(cx + 30, cy + 9, 52);
    cam.updateMatrixWorld(true);
    const proj = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(proj, THREE.WebGLCoordinateSystem, cam.reversedDepth === true);
    const planes = frustum.planes.map((pl) => [pl.normal.x, pl.normal.y, pl.normal.z, pl.constant]);
    const pIn = { ...base, outerR: Infinity, planes, camPos: [cam.position.x, cam.position.y, cam.position.z] };
    const n = cullGrassTiles(pIn, out);
    const kept = keptSet(n);
    let bad = 0;
    const m = GRASS_GPU_CULL_XY_MARGIN_M;
    for (let t = 0; t < 64; t += 1) {
      const r = rectOf(t);
      const box = new THREE.Box3(new THREE.Vector3(r.x0 - m, r.y0 - m, 50 - GRASS_GPU_CULL_BELOW_M), new THREE.Vector3(r.x1 + m, r.y1 + m, 60 + GRASS_GPU_CULL_ABOVE_M));
      if (frustum.intersectsBox(box) !== kept.has(t)) bad += 1;
    }
    check(`frustum: each tile's verdict = three Frustum.intersectsBox on the margined box (${n} of 64 kept)`, bad === 0 && n > 4 && n < 60, `${bad} bad`);
    const behind = rectOf(0);   // the SW tile, behind a camera looking east-north-east
    check("frustum: tiles behind the camera are culled, the tile under it is kept",
      !kept.has(0) && behind.x1 < cam.position.x && (() => {
        for (const t of kept) { const r = rectOf(t); if (cam.position.x >= r.x0 - m && cam.position.x <= r.x1 + m && cam.position.y >= r.y0 - m && cam.position.y <= r.y1 + m) return true; }
        return false;
      })());
    const out2 = new Float32Array(64);
    const n2 = cullGrassTiles({ ...pIn, planes: frustum.planes }, out2);
    check("frustum: three Plane objects work as well as [nx, ny, nz, d] arrays", n2 === n && Array.from(out2).join() === Array.from(out).join());
    const n0 = cullGrassTiles({ ...pIn, xyMarginM: 0 }, out2);
    check("xyMarginM 0 (spec-exact box) culls at least as much as the default margin", n0 <= n && n0 > 0, `${n0} vs ${n}`);
    // 2026-10-23 (integ-2): p.zAboveM beside p.xyMarginM — the provider passes
    // the live blade reach. Explicit margins: still exactly three's verdict.
    {
      const verdictBad = (xm, za, keptN) => {
        const kp = new Set(Array.from(out2.slice(0, keptN)));
        let bad2 = 0;
        for (let t = 0; t < 64; t += 1) {
          const r = rectOf(t);
          const box = new THREE.Box3(new THREE.Vector3(r.x0 - xm, r.y0 - xm, 50 - GRASS_GPU_CULL_BELOW_M), new THREE.Vector3(r.x1 + xm, r.y1 + xm, 60 + za));
          if (frustum.intersectsBox(box) !== kp.has(t)) bad2 += 1;
        }
        return bad2;
      };
      let bad2 = 0, grew = 0, prev = -1;
      for (const [xm, za] of [[2, 2], [0, 0], [3.7, 5.25], [5.29, 4.91], [13.3, 4.91], [0.5, 30]]) {
        const k = cullGrassTiles({ ...pIn, xyMarginM: xm, zAboveM: za }, out2);
        bad2 += verdictBad(xm, za, k);
        if (xm >= 2 && za >= 2 && k >= n) grew += 1;
        prev = k;
      }
      check("explicit xyMarginM / zAboveM (incl. live-look sizes 5.3 / 13.3 m): every verdict = three Frustum.intersectsBox on that box",
        bad2 === 0 && prev >= 0, `${bad2} bad`);
      check("…margins at or above the 2 m defaults keep at least the default tiles", grew === 4, String(grew));
      const kd = cullGrassTiles({ ...pIn }, out2);
      const kDef = Array.from(out2.slice(0, kd)).join();
      const k2 = cullGrassTiles({ ...pIn, zAboveM: GRASS_GPU_CULL_ABOVE_M, xyMarginM: GRASS_GPU_CULL_XY_MARGIN_M }, out2);
      const same2 = Array.from(out2.slice(0, k2)).join() === kDef;
      const kn = cullGrassTiles({ ...pIn, zAboveM: NaN, xyMarginM: undefined }, out2);
      const sameN = Array.from(out2.slice(0, kn)).join() === kDef;
      const kneg = cullGrassTiles({ ...pIn, zAboveM: -5, xyMarginM: -1 }, out2);
      const negBad = verdictBad(0, 0, kneg);
      check("zAboveM / xyMarginM absent or non-finite = the 2 m defaults; negative = 0",
        same2 && sameN && negBad === 0 && kd === n, `${same2} ${sameN} ${negBad}`);
      // A camera just above the ground looking UP a slope: the bottom plane
      // tests the box TOP, so ground below the view whose blades reach into it
      // is kept only with a tall enough zAboveM (the integ-2 bottom edge).
      const upCam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2000);
      upCam.up.set(0, 0, 1);
      upCam.position.set(cx, cy - 2, 61);
      upCam.lookAt(cx + 1, cy + 30, 80);
      upCam.updateMatrixWorld(true);
      const fu = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(upCam.projectionMatrix, upCam.matrixWorldInverse), THREE.WebGLCoordinateSystem, false);
      const pu = { ...base, outerR: Infinity, planes: fu.planes, camPos: [upCam.position.x, upCam.position.y, upCam.position.z] };
      const lo = cullGrassTiles({ ...pu, zAboveM: 2 }, out2);
      const hi = cullGrassTiles({ ...pu, zAboveM: 12 }, out2);
      check(`a taller zAboveM keeps tiles a 2 m top margin culls (looking up a slope: ${lo} -> ${hi} tiles)`, hi > lo, `${lo} ${hi}`);
      // The near-first sort key uses the same zAboveM (the box top).
      const camHi = [cx + 7.3, cy - 3.1, 90];
      const ks = cullGrassTiles({ ...base, outerR: Infinity, camPos: camHi, zAboveM: 25 }, out2);
      let sortedZ = ks === 64;
      const keyZ = (t) => {
        const r = rectOf(t);
        const dx = Math.max(r.x0 - camHi[0], 0, camHi[0] - r.x1), dy = Math.max(r.y0 - camHi[1], 0, camHi[1] - r.y1);
        const dz = Math.max(50 - GRASS_GPU_CULL_BELOW_M - camHi[2], 0, camHi[2] - 60 - 25);
        return dx * dx + dy * dy + dz * dz;
      };
      for (let k = 1; k < ks; k += 1) if (keyZ(out2[k - 1]) > keyZ(out2[k])) sortedZ = false;
      check("the near-first sort key reads the same zAboveM", sortedZ);
    }
    // OBJECT space (the integrator's recipe: proj x view x mesh.matrixWorld) —
    // a worldRoot-like transform must give the same verdict as world space.
    const meshWorld = new THREE.Matrix4().makeRotationX(-Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(-cx, 0, cy));
    const camW = cam.clone();
    // The camera moves with the world: same view of the same blades.
    const camWorldPos = cam.position.clone().applyMatrix4(meshWorld);
    const camWorldTarget = new THREE.Vector3(cx + 30, cy + 9, 52).applyMatrix4(meshWorld);
    camW.up.set(0, 1, 0);
    camW.position.copy(camWorldPos);
    camW.lookAt(camWorldTarget);
    camW.updateMatrixWorld(true);
    const projObj = new THREE.Matrix4().multiplyMatrices(camW.projectionMatrix, camW.matrixWorldInverse).multiply(meshWorld);
    const fObj = new THREE.Frustum().setFromProjectionMatrix(projObj, THREE.WebGLCoordinateSystem, false);
    const n3 = cullGrassTiles({ ...pIn, planes: fObj.planes }, out2);
    check("object-space planes (proj x view x mesh.matrixWorld) give the world-space verdict under a worldRoot transform",
      n3 === n && Array.from(out2.slice(0, n3)).sort().join() === Array.from(out.slice(0, n)).sort().join(), `${n3} vs ${n}`);
  }
  {
    // Allocation-free steady state: the same out array, no growth.
    const before = out;
    cullGrassTiles(base, out);
    check("writes into the caller's Float32Array(64) in place", before === out && out.length === GRASS_GPU_MAX_TILES);
  }

  // End to end on real terrain: culled tiles hold no potentially visible blade,
  // and the mirror over the CULLED tile list reproduces exactly those blades.
  if (ORACLE) {
    const zRangeOf = (x0, y0, x1, y1) => {
      let mn = Infinity, mx = -Infinity;
      for (const lb of LBS) {
        const lx0 = lb.lbX * 192, ly0 = lb.lbY * 192;
        if (lx0 > x1 || lx0 + 192 < x0 || ly0 > y1 || ly0 + 192 < y0) continue;
        for (let i = 0; i < 81; i += 1) { if (lb.heights[i] < mn) mn = lb.heights[i]; if (lb.heights[i] > mx) mx = lb.heights[i]; }
      }
      return mn === Infinity ? null : { min: mn, max: mx };
    };
    const px = 0xa9 * 192 + 96, py = 0xb4 * 192 + 96;
    const p = buildProvider({ blades: 119716, radiusM: 40, reach: 5 }, ORACLE, px, py);
    const terrain = oracleTerrain(ORACLE);
    let allOk = true;
    const notes = [];
    for (let k = 0; k < p._layout.length; k += 1) {
      const ring = p._layout[k];
      const st = grassGpuRingState(ring, p.quality());
      grassGpuSetWindow(st, px, py);
      const W = st.radiusM, hole = ring.band[0];
      const n = cullGrassTiles({ winMin: st.winMin, g: st.g, ts: st.ts, T: st.T, cell: st.cell, center: [px, py],
        outerR: W, holeR: hole, planes: null, zRange: zRangeOf, camPos: [px, py, 70] }, st.tileIds);
      const kept = new Set(Array.from(st.tileIds.slice(0, n)));
      const pool = p._pools[k];
      const m = pool.mesh.instanceMatrix.array;
      // CPU: every live blade, and the potentially visible ones (non-zero scale
      // on the GPU: inside the disc, outside the dissolve hole).
      const cpuLive = new Set();
      const vis = new Set();
      let lost = 0;
      for (let i = 0; i < pool.count; i += 1) {
        if (pool._live[i] !== 1) continue;
        const key = pool._cellX[i] * 1e6 + pool._cellY[i];
        cpuLive.add(key);
        const x = m[i * 16 + 12], y = m[i * 16 + 13];
        const d = Math.hypot(x - px, y - py);
        if (!(d < W && d > hole)) continue;
        const ox = pool._cellX[i] - st.winMin[0], oy = pool._cellY[i] - st.winMin[1];
        const tile = Math.floor(oy / st.ts) * 8 + Math.floor(ox / st.ts);
        if (!kept.has(tile)) lost += 1;
        vis.add(key);
      }
      // GPU: the mirror over ONLY the culled tile list (count * ts^2 instances).
      const b = makeGrassGpuBlade();
      const drawn = new Set();
      let extra = 0, dup = 0;
      for (let id = 0; id < n * st.ts * st.ts; id += 1) {
        grassGpuPlaceMirror(id, st, terrain, null, b, { f64: true });
        if (!b.live) continue;
        const key = b.cellX * 1e6 + b.cellY;
        if (drawn.has(key)) dup += 1;
        drawn.add(key);
        if (!cpuLive.has(key)) extra += 1;
      }
      let missing = 0;
      for (const key of vis) if (!drawn.has(key)) missing += 1;
      notes.push(`ring ${k}: ${n} tiles, ${vis.size} visible blades, lost ${lost}, missing ${missing}, extra ${extra}`);
      if (lost || missing || dup || extra > 1e-4 * drawn.size || vis.size < 1000 || n === 64) allOk = false;
    }
    console.log(`  [info] ${notes.join("; ")}`);
    check("end to end (ultra @ Holtburg): culled tiles hold no potentially visible blade, and the mirror over the culled, "
      + "nearest-first tile list draws exactly the CPU's visible blades", allOk, notes.join("; "));
    p.dispose();
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- P7. GLSL hygiene --");
{
  const place = buildGrassPlaceGlsl();
  const hash = GRASS_GPU_HASH_GLSL;
  const CHARSET = /^[A-Za-z0-9_ \t\n.+\-/*%<>[\](){}^|&~=!:;,?#]*$/;
  check("no backticks in GRASS_GPU_HASH_GLSL / buildGrassPlaceGlsl()", !hash.includes("`") && !place.includes("`"));
  check("GLSL ES source charset only (ASCII, no quotes or apostrophes, even in comments)", CHARSET.test(hash) && CHARSET.test(place));
  const declared = [...place.matchAll(/\buniform\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)/g)].map((m) => m[1]);
  check("each per-ring uniform declared exactly once, and nothing else",
    GRASS_GPU_RING_UNIFORMS.every((u) => declared.filter((d) => d === u).length === 1) && declared.length === GRASS_GPU_RING_UNIFORMS.length,
    declared.join(","));
  check("the seeds are highp uint uniforms; uGpTiles is vec4[16]",
    /uniform highp uint uGpSeed;/.test(place) && /uniform highp uint uGpRandSeed;/.test(place)
    && /uniform highp uint uGpBaseSeed;/.test(place) && /uniform vec4 uGpTiles\[16\];/.test(place));
  check("struct HbBlade has exactly the contract fields, once",
    (place.match(/struct HbBlade \{ bool live; vec3 origin; vec3 normal; vec2 scale; float rot; vec3 tint; float mat; float rank; \};/g) || []).length === 1);
  check("HbBlade hbGrassPlace(int id) defined once", (place.match(/HbBlade hbGrassPlace\(int id\) \{/g) || []).length === 1);
  // 2026-10-23 (gpu-cost-1): the two halves, the rank and the dead blade.
  check("struct HbCell { bool mapped; ivec2 g; vec2 xy; } once; hbGrassCell / hbGrassRank / hbGrassDead / hbGrassPlaceCell defined once each",
    (place.match(/struct HbCell \{ bool mapped; ivec2 g; vec2 xy; \};/g) || []).length === 1
    && ["HbCell hbGrassCell(int id) {", "float hbGrassRank(HbCell hc) {", "HbBlade hbGrassDead(HbCell hc) {", "HbBlade hbGrassPlaceCell(HbCell hc) {"]
      .every((d) => place.split(d).length === 2));
  check("hbGrassPlace(id) is exactly hbGrassPlaceCell(hbGrassCell(id)) (the readback page calls it; production calls the halves)",
    /HbBlade hbGrassPlace\(int id\) \{\n  return hbGrassPlaceCell\(hbGrassCell\(id\)\);\n\}/.test(place));
  const body = (sig) => { const a = place.indexOf(sig); return a < 0 ? "" : place.slice(a, place.indexOf("\n}\n", a)); };
  const cellBody = body("HbCell hbGrassCell(int id) {");
  const placeBody = body("HbBlade hbGrassPlaceCell(HbCell hc) {");
  check("hbGrassCell is the cheap half: no texture, no field / interior call, two hashes (the jitter)",
    !!cellBody && !/texelFetch|texture|hbFieldSample|hbIndoorAt|hbGrassVariant/.test(cellBody) && cellBody.split("hbHash01(").length - 1 === 2);
  check(`tiles per row is the literal ${GRASS_GPU_TILES_PER_ROW} (tile % 8, tile / 8), and no uGpTilesPerRow anywhere`,
    cellBody.includes(`(tile % ${GRASS_GPU_TILES_PER_ROW}) * ts`) && cellBody.includes(`(tile / ${GRASS_GPU_TILES_PER_ROW}) * ts`)
    && !/uGpTilesPerRow|\btpr\b/.test(place));
  const at = (s) => placeBody.indexOf(s);
  check("the interior test runs after the road, variant, bare clump and thinning rejections and before step 10",
    at("hbFieldSample(") > 0 && at("hbFieldSample(") < at("uGpOffRoad > 0.5") && at("uGpOffRoad > 0.5") < at("hbGrassVariant(code")
    && at("hbGrassVariant(code") < at("uGpBaseSeed) < shape.w") && at("uGpBaseSeed) < shape.w") < at("hbGpRand(gx, gy, 4) > shape.z")
    && at("hbGpRand(gx, gy, 4) > shape.z") < at("hbIndoorAt(") && at("hbIndoorAt(") < at("b.live = true;"));
  check("every rejection in hbGrassPlaceCell is a plain return of the dead blade, and nothing writes b before step 10",
    (() => {
      const pre = placeBody.slice(0, at("b.live = true;"));
      const returns = pre.match(/return [^;]*;/g) || [];
      // mapped, ground, road, variant, bare, thinning, interior.
      const writes = pre.replace("HbBlade b = hbGrassDead(hc);", "").match(/\bb\.\w+\s*=[^=]|\bb\s*=[^=]/g) || [];
      return returns.length === 7 && returns.every((r) => r === "return b;") && writes.length === 0
        && pre.includes("HbBlade b = hbGrassDead(hc);");
    })());
  check("the blade rank comes from hbGrassRank (the function the grass snippet early-out reads)",
    placeBody.includes("b.rank = hbGrassRank(hc);") && /float hbGrassRank\(HbCell hc\) \{\n  return hbGpRand\(hc\.g\.x, hc\.g\.y, 7\);\n\}/.test(place));
  check("standalone: the chain names no grass-snippet uniform (uScatter*, uGrassLod*) — the readback page does not declare them",
    !/uScatter|uGrassLod|hbScatterFade/.test(place + hash));
  // The step comments, in order, in the GLSL and in the mirror's source: the
  // two must stay line for line.
  {
    const src = readFileSync(resolvePath(__dirname, "scene3d/grass_gpu_place.js"), "utf8");
    const steps = (s) => (s.match(/\/\/ (\d+)\. /g) || []).map((m) => m.replace(/\D/g, "")).join(",");
    const mirrorSrc = src.slice(src.indexOf("export function grassGpuCellMirror("), src.indexOf("// Tile culling."));
    const glslSteps = steps(place);
    check(`the GLSL step order (${glslSteps}) = the mirror source step order`,
      glslSteps === "1,2,3,4,5,6,7,8,9,10" && steps(mirrorSrc) === glslSteps, steps(mirrorSrc));
  }
  check("no instanceMatrix, no attribute, no gl_InstanceID (the injector passes the id)",
    !/instanceMatrix|\battribute\b|gl_InstanceID/.test(place + hash));
  check("needs the field + indoor + hash functions (and only calls them)",
    /hbFieldSample\(vec2\(x, y\), height, nrm, cc, edge\)/.test(place) && /hbIndoorAt\(vec3\(x, y, height\)\)/.test(place)
    && /hbHash01\(/.test(place) && !/hbHashU32\s*\(/.test(place));
  check("hash GLSL defines hbHashU32 and hbHash01 exactly once",
    (hash.match(/highp uint hbHashU32\(/g) || []).length === 1 && (hash.match(/highp float hbHash01\(/g) || []).length === 1);
  const balanced = (src) => {
    const s = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");   // comments may hold "[0, 1)"
    const pairs = { ")": "(", "]": "[", "}": "{" };
    const st = [];
    for (const ch of s) {
      if (ch === "(" || ch === "[" || ch === "{") st.push(ch);
      else if (pairs[ch]) { if (st.pop() !== pairs[ch]) return false; }
    }
    return st.length === 0;
  };
  check("braces / brackets / parens balanced", balanced(hash) && balanced(place));
  // The generated table IS GRASS_VARIANTS restricted to FAM_GRASS codes.
  const want = GRASS_CODES.filter((c) => familyForCode(c) === FAM_GRASS);
  const rows = [...place.matchAll(/if \(code == (\d+)\) \{ shape = vec4\(([^)]*)\); look = vec4\(([^)]*)\); return true; \}/g)];
  let tableOk = rows.length === want.length && JSON.stringify(grassGpuVariantCodes()) === JSON.stringify(want);
  for (const r of rows) {
    const code = Number(r[1]);
    const v = GRASS_VARIANTS[code];
    const s = r[2].split(",").map(Number), l = r[3].split(",").map(Number);
    if (!v || !want.includes(code)) { tableOk = false; continue; }
    const exp = [v.h, v.w, v.keep, v.bare, v.tint[0], v.tint[1], v.tint[2], v.mat];
    const gotv = [...s, ...l];
    if (gotv.length !== 8 || exp.some((e, k) => gotv[k] !== e)) tableOk = false;
  }
  check(`generated variant table = GRASS_VARIANTS on FAM_GRASS codes [${want}] (exact literals)`, tableOk);
  check("every float literal in the table carries a decimal point", rows.every((r) => (r[2] + "," + r[3]).split(",").every((t) => /\./.test(t))));
  check("deterministic: two builds are byte-identical (every ring = one program)", buildGrassPlaceGlsl() === place);
  // The whole chain as the injector concatenates it (Modules A + B written in
  // parallel — skipped, with a note, if either is not importable yet).
  let A = null, B = null;
  try { A = await import("./scene3d/terrain_field_gpu.js"); } catch (e) { console.log(`  [info] terrain_field_gpu.js: ${e.message}`); }
  try { B = await import("./scene3d/grass_interior_mask.js"); } catch (e) { console.log(`  [info] grass_interior_mask.js: ${e.message}`); }
  if (A && typeof A.TERRAIN_FIELD_GLSL === "string" && B && typeof B.INTERIOR_MASK_GLSL === "string") {
    const chain = hash + "\n" + A.TERRAIN_FIELD_GLSL + "\n" + B.INTERIOR_MASK_GLSL + "\n" + place;
    const names = [...chain.matchAll(/\buniform\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)/g)].map((m) => m[1]);
    const dupU = names.filter((u, i) => names.indexOf(u) !== i);
    const fns = [...chain.matchAll(/^\s*(?:(?:highp|mediump|lowp)\s+)?(?:bool|int|uint|float|vec[234]|ivec[234]|HbBlade|HbCell)\s+(\w+)\s*\([^;{]*\)\s*\{/gm)].map((m) => m[1]);
    const dupF = fns.filter((f, i) => fns.indexOf(f) !== i);
    check("injected chain (hash + field + indoor + place): every uniform and function declared once, no backticks",
      dupU.length === 0 && dupF.length === 0 && !chain.includes("`") && balanced(chain), `uniforms ${dupU} functions ${dupF}`);
    check("…the field defines hbFieldSample and the mask hbIndoorAt BEFORE the place code uses them",
      chain.indexOf("bool hbFieldSample(") >= 0 && chain.indexOf("bool hbFieldSample(") < chain.indexOf("HbBlade hbGrassPlace(")
      && chain.indexOf("bool hbIndoorAt(") >= 0 && chain.indexOf("bool hbIndoorAt(") < chain.indexOf("HbBlade hbGrassPlace("));
  } else {
    console.log("  [info] chain check skipped: Module A / B GLSL not importable yet");
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- P8. ?terrainGrassGpu --");
{
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); };
  const withSearch = (search, fn) => {
    globalThis.window = { location: { search } };
    try { return fn(); } finally { delete globalThis.window; }
  };
  try {
    _resetVfxFlags();
    check("absent (no window): false", terrainGrassGpuEnabled() === false);
    _resetVfxFlags();
    check("absent (other flags only): false", withSearch("?terrainGrass=on&quality=ultra", terrainGrassGpuEnabled) === false);
    _resetVfxFlags();
    check("?terrainGrassGpu=on: true", withSearch("?terrainGrassGpu=on", terrainGrassGpuEnabled) === true);
    check("memoized: a later URL change does not move it without a reset", withSearch("?terrainGrassGpu=off", terrainGrassGpuEnabled) === true);
    _resetVfxFlags();
    check("_resetVfxFlags clears it: ?terrainGrassGpu=off -> false", withSearch("?terrainGrassGpu=off", terrainGrassGpuEnabled) === false);
    _resetVfxFlags();
    warns.length = 0;
    const g1 = withSearch("?terrainGrassGpu=yes", terrainGrassGpuEnabled);
    const g2 = withSearch("?terrainGrassGpu=yes", terrainGrassGpuEnabled);
    check("garbage (=yes): false, and warns exactly once", g1 === false && g2 === false && warns.length === 1
      && /terrainGrassGpu/.test(warns[0]), `${warns.length} ${warns[0] || ""}`);
    _resetVfxFlags();
    const g3 = withSearch("?terrainGrassGpu=ON", terrainGrassGpuEnabled);
    check("EXACT match: =ON is garbage (false) and the reset re-arms the warning", g3 === false && warns.length === 2);
    _resetVfxFlags();
    const g4 = withSearch("?terrainGrassGpu=1", terrainGrassGpuEnabled);
    check("=1 is garbage too (false)", g4 === false && warns.length === 3);
    _resetVfxFlags();
    check("empty value (?terrainGrassGpu=) is garbage: false", withSearch("?terrainGrassGpu=", terrainGrassGpuEnabled) === false);
  } finally {
    console.warn = origWarn;
    delete globalThis.window;
    _resetVfxFlags();
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- P9. lint --");
{
  const src = readFileSync(resolvePath(__dirname, "scene3d/grass_gpu_place.js"), "utf8");
  const hits = lintSource(src);
  check("lintSource(grass_gpu_place.js) clean (no Math.random / Date.now() / ...)", hits.length === 0,
    hits.map((h) => `${h.label}@${h.lineno}`).join(", "));
  check("the module imports no three", !/from\s+["']three["']/.test(src));
  check("constants exported as documented", GRASS_GPU_MAX_TILES === 64 && GRASS_GPU_TILES_PER_ROW === 8
    && GRASS_GPU_CULL_BELOW_M === 0.5 && GRASS_GPU_CULL_ABOVE_M === 2.0);
}

// ---------------------------------------------------------------------------
console.log("\n-- P10. split + reorder: the mirror = the original step order, bit for bit --");
/**
 * The mirror as it was before 2026-10-23: one function, the interior test right
 * after the road check, T read from the ring state. The reference the split +
 * reordered chain must reproduce for EVERY id (live and dead fields alike).
 */
const REF_VARIANTS = (() => {
  const t = new Array(TERRAIN_CODE_COUNT).fill(null);
  for (let c = 0; c < TERRAIN_CODE_COUNT; c += 1) if (GRASS_VARIANTS[c] && familyForCode(c) === FAM_GRASS) t[c] = GRASS_VARIANTS[c];
  return t;
})();
function refPlaceOriginalOrder(id, ring, terrain, indoor, opts) {
  const f32 = Math.fround;
  const F = opts && opts.f64 === true ? (v) => v : f32;
  const b = makeGrassGpuBlade();
  const ts = Math.trunc(f32(ring.ts) + 0.5);
  const tpr = Math.trunc(f32(ring.T) + 0.5);
  const g = Math.trunc(f32(ring.g) + 0.5);
  const n = ts * ts;
  if (id < 0 || n <= 0 || tpr <= 0) return b;
  const slot = Math.trunc(id / n);
  const li = id - slot * n;
  if (slot >= 64) return b;
  const ft = f32(ring.tileIds[slot]);
  if (ft < 0) return b;
  const tile = Math.trunc(ft + 0.5);
  const ox = (tile % tpr) * ts + (li % ts);
  const oy = Math.trunc(tile / tpr) * ts + Math.trunc(li / ts);
  if (ox >= g || oy >= g) return b;
  const gx = Math.floor(f32(ring.winMin[0]) + 0.5) + ox;
  const gy = Math.floor(f32(ring.winMin[1]) + 0.5) + oy;
  b.mapped = true; b.cellX = gx; b.cellY = gy;
  const jitter = F(ring.jitter), cell = F(ring.cell);
  const jx = jitter > 0 ? F((grassGpuHash01(gx, gy, 1, ring.seed) - 0.5) * jitter) : 0;
  const jy = jitter > 0 ? F((grassGpuHash01(gx, gy, 2, ring.seed) - 0.5) * jitter) : 0;
  const x = F(F(F(gx + 0.5) + jx) * cell);
  const y = F(F(F(gy + 0.5) + jy) * cell);
  b.origin.x = x; b.origin.y = y;
  const s = terrain.sampleMirror(x, y);
  if (!s) return b;
  const height = s.height, nrm = s.normal, cc = s.cornerCodes;
  const edge = Number.isFinite(s.roadEdgeM) ? s.roadEdgeM : 1e9;
  const verge = F(ring.vergeM);
  if (ring.offRoad && edge < verge) {
    const p = edge <= 0 ? 1 : F(1 - F(edge / verge));
    if (p >= 1 || grassGpuHash01(gx, gy, 3, ring.randSeed) < p) return b;
  }
  if (indoor && indoor.gpuContainsMirror(x, y, height)) return b;   // the ORIGINAL position
  const z = F(height + F(ring.heightOffsetM));
  const x24 = F(x / 24), y24 = F(y / 24);
  const fx = F(x24 - Math.floor(x24)), fy = F(y24 - Math.floor(y24));
  const wSW = F(F(1 - fx) * F(1 - fy)), wSE = F(fx * F(1 - fy)), wNW = F(F(1 - fx) * fy);
  const rand = (ch) => grassGpuHash01(gx, gy, ch + 16, ring.randSeed);
  let r = rand(5);
  let code = cc[3];
  if (r < wSW) code = cc[0];
  else { r = F(r - wSW); if (r < wSE) code = cc[1]; else { r = F(r - wSE); if (r < wNW) code = cc[2]; } }
  const v = REF_VARIANTS[code & 0x1f];
  if (!v || code < 0 || code >= TERRAIN_CODE_COUNT) return b;
  const bare = F(v.bare);
  if (bare > 0 && grassGpuHash01(Math.floor(F(x / 2)), Math.floor(F(y / 2)), 9, ring.baseSeed) < bare) return b;
  const keep = F(v.keep);
  if (keep < 1 && rand(4) > keep) return b;
  const shade = 0.82 + 0.36 * rand(3), warm = 0.94 + 0.12 * rand(6);
  b.live = true; b.origin.z = z;
  b.normal.x = F(nrm ? nrm.x : 0); b.normal.y = F(nrm ? nrm.y : 0); b.normal.z = F(nrm ? nrm.z : 1);
  b.scale.x = F(v.h * (0.7 + 0.6 * rand(1))); b.scale.y = F(v.w * (0.85 + 0.3 * rand(2)));
  b.rot = F(rand(0) * 6.283185307179586);
  b.tint.x = F(v.tint[0] * shade * warm); b.tint.y = F(v.tint[1] * shade); b.tint.z = F(v.tint[2] * shade * (2 - warm));
  b.mat = F(v.mat); b.rank = F(rand(7));
  return b;
}
const BLADE_KEYS = ["live", "mapped", "cellX", "cellY", "rot", "mat", "rank"];
const BLADE_VECS = [["origin", "xyz"], ["normal", "xyz"], ["scale", "xy"], ["tint", "xyz"]];
function sameBlade(a, b) {
  for (const k of BLADE_KEYS) if (!Object.is(a[k], b[k])) return false;
  for (const [k, cs] of BLADE_VECS) for (const c of cs) if (!Object.is(a[k][c], b[k][c])) return false;
  return true;
}
if (ORACLE) {
  const terrain = oracleTerrain(ORACLE);
  const px = 0xa9 * 192 + 96, py = 0xb4 * 192 + 96;
  // Interior boxes over the town AND the fields, two kinds: plain rects, and
  // rects that only match the GROUND height (the hook must get height, not z).
  const rng = makeRng(0x51ab);
  const rects = [];
  for (let i = 0; i < 48; i += 1) {
    const cx = px + ((rng() % 3000) / 10 - 150), cy = py + ((rng() % 3000) / 10 - 150);
    const hw = 3 + (rng() % 90) / 10, hh = 3 + (rng() % 90) / 10;
    rects.push([cx - hw, cy - hh, cx + hw, cy + hh, i % 3 === 0]);
  }
  let calls = 0;
  const contains = (x, y, z) => {
    calls += 1;
    for (const [x0, y0, x1, y1, ground] of rects) {
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (!ground) return true;
      const h = ORACLE.heightAt(x, y);
      if (h !== null && Math.abs(z - h) < 1e-6) return true;
    }
    return false;
  };
  const indoor = { gpuContainsMirror: contains };
  for (const [cname, config] of [["ultra 119716 / 40 m / reach 5", { blades: 119716, radiusM: 40, reach: 5 }],
    ["high 60025 / 32 m / reach 5", { blades: 60025, radiusM: 32, reach: 5 }]]) {
    const cfg = resolveGrassConfig({ ...config, density: 1, stomp: false, offRoad: true });
    const layout = grassLodLayout(cfg);
    for (const f64 of [false, true]) {
      let ids = 0, bad = 0, badSplit = 0, badRank = 0, live = 0, mapped = 0, indoorKills = 0, first = null;
      let callsNew = 0, callsRef = 0;
      const b = makeGrassGpuBlade(), b2 = makeGrassGpuBlade(), hc = makeGrassGpuCell();
      for (const ring of layout) {
        const st = grassGpuRingState(ring, cfg);
        grassGpuSetWindow(st, px, py);
        // A scrambled tile order, so the slot -> tile path is exercised too.
        const order = Array.from({ length: 64 }, (_, i) => i);
        const r2 = makeRng(st.g);
        for (let i = 63; i > 0; i -= 1) { const j = r2() % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
        st.tileIds.set(order);
        for (let id = -1; id <= st.maxInstances; id += 1) {
          ids += 1;
          calls = 0;
          grassGpuPlaceMirror(id, st, terrain, indoor, b, { f64 });
          callsNew += calls;
          calls = 0;
          const ref = refPlaceOriginalOrder(id, st, terrain, indoor, { f64 });
          callsRef += calls;
          if (!sameBlade(b, ref)) { bad += 1; if (!first) first = { id, got: JSON.stringify(b), want: JSON.stringify(ref) }; }
          grassGpuPlaceCellMirror(grassGpuCellMirror(id, st, hc, { f64 }), st, terrain, indoor, b2, { f64 });
          if (!sameBlade(b, b2) || hc.mapped !== b.mapped || (hc.mapped && (hc.gx !== b.cellX || hc.gy !== b.cellY
            || hc.x !== b.origin.x || hc.y !== b.origin.y)) || (!hc.mapped && (hc.x !== 0 || hc.y !== 0))) badSplit += 1;
          if (b.mapped) mapped += 1;
          if (b.live) {
            live += 1;
            if (b.rank !== Math.fround(grassGpuRankMirror(hc, st))) badRank += 1;
          } else if (b.mapped && !f64) {
            const noIndoor = refPlaceOriginalOrder(id, st, terrain, null, { f64 });
            if (noIndoor.live) indoorKills += 1;
          }
        }
      }
      const tag = `${cname} @ Holtburg, ${f64 ? "f64" : "f32"}`;
      check(`${tag}: every id (${ids}, scrambled tiles, incl. -1 and past the end) = the original step order, every field bit-identical`,
        bad === 0 && live > 0.2 * mapped, `${bad} bad ${first ? JSON.stringify(first) : ""}`);
      check(`${tag}: = grassGpuPlaceCellMirror(grassGpuCellMirror(id)); the cell record = the blade's cell + jittered point`, badSplit === 0, String(badSplit));
      check(`${tag}: a live blade's rank = grassGpuRankMirror(cell) (what the early-out tests)`, badRank === 0, String(badRank));
      console.log(`  [info] ${tag}: ${live} live of ${mapped} mapped; interior hook calls ${callsNew} (was ${callsRef}: ${(100 * callsNew / Math.max(1, callsRef)).toFixed(1)} %)`
        + (f64 ? "" : `; blades only the interior test kills: ${indoorKills}`));
      check(`${tag}: the interior test now runs only for blades every cheaper test kept (fewer calls than before)`,
        callsNew < callsRef && callsNew > 0 && (f64 || indoorKills > 100), `${callsNew} vs ${callsRef}, kills ${indoorKills}`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- P11. blade reach (cull margins) vs a JS port of the grass vertex snippet --");
{
  // terrain_grass.js _grassVertexSnippet, the blade displacement hbP up to
  // (not including) the fade and dissolve, which only shrink it.
  const displace = (pos, q) => {
    const hbH = Math.min(Math.max(pos[2], 0), 1);
    const sx = q.aScale[0] * q.lodScale[0], sy = q.aScale[1] * q.lodScale[1];
    let x = pos[0] * sy, y = pos[1] * sy, z = pos[2] * sx;
    y += q.bow * sx * hbH * hbH * (0.5 + q.hash);
    const c = Math.cos(q.rot), s = Math.sin(q.rot);
    const rx = x * c - y * s, ry = x * s + y * c;
    x = rx; y = ry;
    const osc = Math.sin(q.t + q.phase) + q.flutter * Math.sin(q.t * 3.7 + q.phase * 1.7 + 1.3);
    const stiff = 1 + (0.25 - 1) * q.mat;
    const w = q.windAmp * sx * stiff * hbH * hbH * hbH * osc;
    x += q.windDir[0] * w; y += q.windDir[1] * w;
    x += q.n[0] * (z * q.lean); y += q.n[1] * (z * q.lean);
    if (q.stomp > 0) {
      z *= 1 - q.bend * q.stomp;
      x += q.away[0] * (q.splay * sx * hbH * q.stomp);
      y += q.away[1] * (q.splay * sx * hbH * q.stomp);
    }
    return [x, y, z];
  };
  const VERTS = [];
  for (let i = 0; i < GRASS_BLADE_POSITIONS.length; i += 3) VERTS.push(GRASS_BLADE_POSITIONS.slice(i, i + 3));
  const VARS = grassGpuVariantCodes().map((c) => GRASS_VARIANTS[c]);
  const D = GRASS_DEFAULTS;
  const ultra = resolveGrassConfig({ blades: 119716, radiusM: 40, reach: 5, density: 1 });
  const high = resolveGrassConfig({ blades: 60025, radiusM: 32, reach: 5, density: 1 });
  const lookOf = (ring, windAmp, stomp) => ({
    heightMul: ring.heightMul, widthMul: ring.widthMul, bow: D.bowAmount, windAmp, windDirLen: 1,
    flutter: D.windFlutter, lean: D.lean, stomp, stompSplay: D.stompSplay, stompBend: D.stompBend,
  });
  // Defaults: inside the floors on every ring (the 2 m margins hold, nothing changes).
  let defOk = true;
  const defNotes = [];
  for (const [nm, cfg] of [["ultra", ultra], ["high", high]]) {
    for (const ring of grassLodLayout(cfg)) {
      const r = grassGpuBladeReach(lookOf(ring, D.windAmp, false));
      defNotes.push(`${nm}${ring.level} ${r.lateralM.toFixed(2)}/${r.aboveM.toFixed(2)}`);
      if (!(r.lateralM <= GRASS_GPU_CULL_XY_MARGIN_M && r.aboveM <= GRASS_GPU_CULL_ABOVE_M && r.lateralM > 0.5)) defOk = false;
    }
  }
  console.log(`  [info] default reach (lateral/above m): ${defNotes.join(", ")}`);
  check("the DEFAULT look reaches less than the 2 m floors on every ultra / high ring (the floors decide there)", defOk);
  const SCEN = [
    ["ultra ring 3, defaults", ultra, {}, 3, D.windAmp, false],
    ["ultra ring 0, defaults + stomp", ultra, {}, 0, D.windAmp, true],
    ["ultra ring 3, setLod({heightGain: 2})", ultra, { heightGain: 2 }, 3, D.windAmp, false],
    ["ultra ring 3, setLod({widthExp: 2})", ultra, { widthExp: 2 }, 3, D.windAmp, false],
    ["ultra ring 2, ?treeWindStrength=4", ultra, {}, 2, D.windAmp * 4, false],
    ["high ring 3, heightGain 2 + wind x4 + stomp", high, { heightGain: 2 }, 3, D.windAmp * 4, true],
  ];
  const rng = makeRng(0xbeef);
  const u01 = () => (rng() >>> 8) / 16777216;
  let allBelow = true, allTight = true;
  const notes = [];
  for (const [nm, cfg, lk, k, windAmp, stomp] of SCEN) {
    const ring = grassLodLayout(cfg, lk)[k];
    const look = lookOf(ring, windAmp, stomp);
    const reach = grassGpuBladeReach(look);
    const base = { lodScale: [ring.heightMul, ring.widthMul], bow: D.bowAmount, windAmp, flutter: D.windFlutter, lean: D.lean,
      bend: D.stompBend, splay: D.stompSplay };
    // 1) Random inputs never reach past the bound.
    let maxLat = 0, maxUp = 0;
    for (let i = 0; i < 20000; i += 1) {
      const v = VARS[rng() % VARS.length];
      const a = u01() * 6.283185307179586, nn = u01() * 1, na = u01() * 6.283185307179586, sa = u01() * 6.283185307179586;
      const q = { ...base, aScale: [v.h * (0.7 + 0.6 * u01()), v.w * (0.85 + 0.3 * u01())], mat: v.mat, hash: u01(), rot: u01() * 6.283185307179586,
        t: u01() * 1000, phase: u01() * 100, windDir: [Math.cos(a), Math.sin(a)], n: [nn * Math.cos(na), nn * Math.sin(na)],
        stomp: stomp ? u01() : 0, away: [Math.cos(sa), Math.sin(sa)] };
      for (const pos of VERTS) {
        const d = displace(pos, q);
        maxLat = Math.max(maxLat, Math.hypot(d[0], d[1]));
        maxUp = Math.max(maxUp, d[2]);
      }
    }
    // 2) The inputs lined up (all lateral terms along the wind; the gust at
    //    its peak 1 + flutter; |n.xy| = 1; full stomp along the wind; the bow
    //    hash and the size jitter at their sup) reach it.
    let supLat = 0, supUp = 0;
    const tPk = (Math.PI / 2 + 2 * Math.PI - 0.85 * Math.PI - 1.3) / 2, phPk = Math.PI / 2 - tPk;   // both sines = 1
    const wd = [Math.SQRT1_2, -Math.SQRT1_2];
    for (const v of VARS) {
      for (const pos of VERTS) {
        const hbH = Math.min(Math.max(pos[2], 0), 1);
        const sx = v.h * 1.3 * ring.heightMul, sy = v.w * 1.15 * ring.widthMul;
        const bowY = D.bowAmount * sx * hbH * hbH * 1.5;
        const rot = Math.atan2(wd[1], wd[0]) - Math.atan2(bowY, pos[0] * sy);
        const q = { ...base, aScale: [v.h * 1.3, v.w * 1.15], mat: v.mat, hash: 1, rot, t: tPk, phase: phPk, windDir: wd,
          n: wd, stomp: stomp ? 1 : 0, away: wd };
        const d = displace(pos, q);
        supLat = Math.max(supLat, Math.hypot(d[0], d[1]));
        supUp = Math.max(supUp, displace(pos, { ...q, stomp: 0 })[2]);
      }
    }
    notes.push(`${nm}: reach ${reach.lateralM.toFixed(3)}/${reach.aboveM.toFixed(3)}, sampled ${maxLat.toFixed(3)}/${maxUp.toFixed(3)}, lined up ${supLat.toFixed(3)}/${supUp.toFixed(3)}`);
    if (!(maxLat <= reach.lateralM + 1e-9 && maxUp <= reach.aboveM + 1e-9 && supLat <= reach.lateralM + 1e-9 && supUp <= reach.aboveM + 1e-9)) allBelow = false;
    // The bound takes the tallest h and the widest w from (possibly) different
    // variants; the lined-up port uses real variants, so allow 2 %.
    if (!(reach.lateralM - supLat <= 0.02 * reach.lateralM && Math.abs(reach.aboveM - supUp) <= 1e-9 * reach.aboveM)) allTight = false;
  }
  for (const nline of notes) console.log(`  [info] ${nline}`);
  check("no sampled input of the snippet port reaches past grassGpuBladeReach (lateral or up), in 6 looks x 20000 blades x 5 vertices", allBelow);
  check("…and the inputs lined up reach it (lateral within 2 % — tallest and widest are different variants; up exactly)", allTight);
  const r0 = grassGpuBladeReach(lookOf(grassLodLayout(ultra)[3], D.windAmp, false));
  const rW = grassGpuBladeReach(lookOf(grassLodLayout(ultra)[3], D.windAmp * 2, false));
  const rH = grassGpuBladeReach(lookOf(grassLodLayout(ultra, { heightGain: 0.6 })[3], D.windAmp, false));
  check(`setLod / ?treeWindStrength push ultra ring 3 past the 2 m floor (wind x2 ${rW.lateralM.toFixed(2)} m, heightGain 0.6 ${rH.lateralM.toFixed(2)} m; default ${r0.lateralM.toFixed(2)} m)`,
    rW.lateralM > GRASS_GPU_CULL_XY_MARGIN_M && rH.lateralM > GRASS_GPU_CULL_XY_MARGIN_M && r0.lateralM < GRASS_GPU_CULL_XY_MARGIN_M);
  const scratch = { lateralM: -1, aboveM: -1 };
  check("writes into the caller's out record (no allocation on the per-draw path); garbage inputs fall back, never NaN",
    grassGpuBladeReach(lookOf(grassLodLayout(ultra)[3], D.windAmp, false), scratch) === scratch && scratch.lateralM === r0.lateralM
    && Number.isFinite(grassGpuBladeReach({ heightMul: NaN, windAmp: undefined }).lateralM) && Number.isFinite(grassGpuBladeReach(null).aboveM));
}

console.log(`\ngrass GPU placement (Module C): ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
