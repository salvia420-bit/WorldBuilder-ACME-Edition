// test_terrain_field_gpu.mjs — GPU grass placement, Module A: the per-landblock
// terrain FIELD textures + `hbFieldSample` GLSL (`scene3d/terrain_field_gpu.js`)
// and the oracle accessors it stands on (`terrain_oracle.js` `version()` /
// `lookup()`). Contract: docs/2026-10-23-grass-gpu-placement.md.
//
// Run with:
//   cd apps/holtburger-web && node test_terrain_field_gpu.mjs
//   (HB_CELL_DAT overrides ~/ac_base_dats/client_cell_1.dat)
//
// Locks:
//  F1  ORACLE ACCESSORS — `version()` moves on a successful note, a backfill
//      adoption, an invalidate that deleted and clear, and on nothing else;
//      `lookup()` returns the live cache entry (backfill included), by lbKey or
//      `| 0xffff` lbId, null when absent, and counts no hit/miss.
//  F2  SPLIT DIAGONAL — the u32 cutoff 2147483682 is re-derived from the JS
//      port's `v * 2.3283064e-10 >= 0.5`, and the GLSL mirror agrees with
//      `cellSwToNeCut` on EVERY global cell of the world (2048 x 2048) plus 1M
//      large hashed coordinates and the Rust / u32-wrap vectors.
//  F3  ROAD DISTANCE — the GLSL mirror of `hbRoadEdgeDistanceInCell` matches
//      `roadEdgeDistanceInCell` for all 16 road-corner combinations over a dense
//      cell grid (HB_ROAD_NONE where the oracle says Infinity).
//  F4  PARITY ON REAL LANDBLOCKS (client_cell_1.dat, 5x5 around Holtburg
//      0xA9B4) — `sampleMirror` (the f32 line-by-line port of `hbFieldSample`
//      reading the very arrays the textures hold) vs `oracle.sample()` over
//      tens of thousands of points: hashed interior points, LB edges and
//      corners, vertex lines, every road cell, and the unloaded fringe. Height
//      within 1e-3, normal within 1e-4, cornerCodes exact, roadEdgeM within
//      1e-3 (or both >= 1e8), null exactly where the oracle has no ground.
//  F5  TEXEL LAYOUT — every written texel is where the contract says (slot =
//      LB & 15, texel (slotX*9 + col, slotY*9 + row)), key = (lbX, lbY, hasH, 1).
//  F6  WINDOW — LBs enter/leave as the player crosses LBs; a returning LB whose
//      tile was not overwritten only re-validates its key; a rebake (new entry)
//      rewrites exactly its slot; invalidate clears; slot ALIASING (LB x and
//      x+16, real DAT data) never returns another LB's ground; off-world and
//      unbaked / heightless LBs are false; the radius clamps to 7 and a full
//      15x15 window fills 225 distinct slots.
//  F7  NO-OP — an update with the same LB + oracle version touches nothing (no
//      lookup, no write, no upload, no texture version bump), including right
//      after a walk that adopted an LB through the backfill.
//  F8  heightRange — per-LB min/max over resident LBs only; null over nothing.
//  F9  GPU OBJECTS (real three) — RGBA32F (RGBAFormat + FloatType), Nearest,
//      no mips, flipY false, 144x144 / 16x16, backed by the test-seam arrays,
//      bound by reference; needsUpdate only on the texture actually touched;
//      dispose. No THREE = arrays only.
//  F10 GLSL HYGIENE — no backticks, plain ASCII with no quotes, each uniform
//      declared once, each function defined once, balanced, float literals,
//      the road widths ARE the oracle's, texelFetch only; module lint-clean.

import { existsSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import * as THREE from "three";

import {
  createTerrainOracle, cellSwToNeCut, roadEdgeDistanceInCell, ROAD_PAINT,
  METERS_PER_LANDBLOCK,
} from "./scene3d/terrain_oracle.js";
import {
  createTerrainFieldGpu, fieldCellSwToNeCut, fieldRoadEdgeDistanceInCell,
  FIELD_SLOTS, FIELD_TILE, FIELD_TEX_SIZE, HB_ROAD_NONE, FIELD_MAX_WINDOW_RADIUS_LB,
  SW_NE_CUT_MIN_U32, TERRAIN_FIELD_GLSL,
} from "./scene3d/terrain_field_gpu.js";
import { lbKeyFromXY } from "./scene3d/landblock_lru.js";
import { lintSource } from "./scene3d/vfx/lint_caps.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// Deterministic hash -> [0, 1) (no Math.random).
function hash01(i, salt = 0) {
  let h = Math.imul((i ^ Math.imul(salt, 0x27d4eb2d)) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const F = Math.fround;
const LBM = METERS_PER_LANDBLOCK;

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

function noteLb(oracle, lb, over = {}) {
  return oracle.noteLandblock(lbKeyFromXY(lb.lbX, lb.lbY), {
    codes: lb.codes, heights: lb.heights, roads: lb.roads, lbX: lb.lbX, lbY: lb.lbY, ...over,
  });
}

const CELL = process.env.HB_CELL_DAT || "/home/wbterminal/ac_base_dats/client_cell_1.dat";
const HX = 0xa9, HY = 0xb4; // Holtburg

console.log("terrain field GPU (2026-10-23, Module A)");
console.log("========================================");

// ---------------------------------------------------------------------------
console.log("\n-- F1. oracle version() / lookup() --");
{
  const o = createTerrainOracle();
  const codes = new Uint8Array(81).fill(1);
  const heights = new Float32Array(81).fill(7);
  check("version() is an integer starting at 0", o.version() === 0);
  check("lookup() of an absent LB -> null", o.lookup(lbKeyFromXY(HX, HY)) === null);
  o.noteLandblock(lbKeyFromXY(HX, HY), { codes, heights, lbX: HX, lbY: HY });
  check("a successful note bumps it", o.version() === 1);
  o.noteLandblock(lbKeyFromXY(HX, HY), { codes: new Uint8Array(9) });
  check("a rejected note (short codes) does not", o.version() === 1);
  const e1 = o.lookup(lbKeyFromXY(HX, HY));
  check("lookup() returns the cache entry {codes, heights, roads, lbX, lbY}",
    !!e1 && e1.codes.length === 81 && e1.heights[0] === 7 && e1.roads === null && e1.lbX === HX && e1.lbY === HY);
  check("lookup() by the `| 0xffff` lbId form finds the same entry",
    o.lookup(((HX << 24) | (HY << 16) | 0xffff) >>> 0) === e1);
  check("lookup() is stable (same object every call)", o.lookup(lbKeyFromXY(HX, HY)) === e1);
  const st = o.stats();
  check("lookup() counts no hit and no miss", st.hits === 0 && st.misses === 0);
  o.noteLandblock(lbKeyFromXY(HX, HY), { codes, heights, lbX: HX, lbY: HY });
  check("a rebake bumps the version and makes a NEW entry object",
    o.version() === 2 && o.lookup(lbKeyFromXY(HX, HY)) !== e1);
  check("invalidate of an absent LB does not bump", o.invalidate(lbKeyFromXY(1, 1)) === false && o.version() === 2);
  check("invalidate that deleted bumps", o.invalidate(lbKeyFromXY(HX, HY)) === true && o.version() === 3);
  check("…and lookup() is null after it", o.lookup(lbKeyFromXY(HX, HY)) === null);
  o.clear();
  check("clear bumps", o.version() === 4);
  o.sample(HX * LBM + 5, HY * LBM + 5);
  o.sampleCode(HX * LBM + 5, HY * LBM + 5);
  o.familyCoverage(lbKeyFromXY(HX, HY));
  check("samples / misses / coverage do not bump", o.version() === 4);

  // Backfill adoption through lookup().
  const mesh = { userData: { lbX: 5, lbY: 6, terrainCodes: codes, heights, roadCodes: null } };
  const ob = createTerrainOracle({ getTerrainMeshes: () => [mesh] });
  const v0 = ob.version();
  const eb = ob.lookup(lbKeyFromXY(5, 6));
  check("lookup() ADOPTS an LB baked before the oracle (backfill)", !!eb && eb.lbX === 5 && ob.stats().backfills === 1);
  check("…and the adoption bumps the version", ob.version() === v0 + 1);
  check("…once: the next lookup is the cached entry, no bump", ob.lookup(lbKeyFromXY(5, 6)) === eb && ob.version() === v0 + 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- F2. split diagonal: hbCellSwToNeCut mirror vs cellSwToNeCut --");
{
  let first = -1;
  for (let v = 2147483648 - 64; v <= 2147483648 + 64; v += 1) {
    if (v * 2.3283064e-10 >= 0.5) { first = v; break; }
  }
  check(`the u32 cutoff re-derives as ${first}`, first === SW_NE_CUT_MIN_U32 && first === 2147483682);
  check("…and the compare is monotone around it (T-1 false, T true, T+1 true)",
    !((SW_NE_CUT_MIN_U32 - 1) * 2.3283064e-10 >= 0.5) && SW_NE_CUT_MIN_U32 * 2.3283064e-10 >= 0.5
    && (SW_NE_CUT_MIN_U32 + 1) * 2.3283064e-10 >= 0.5);
  check("…and at the u32 extremes", !(0 * 2.3283064e-10 >= 0.5) && 4294967295 * 2.3283064e-10 >= 0.5);

  let mism = 0, trues = 0;
  for (let gx = 0; gx < 2048; gx += 1) {
    for (let gy = 0; gy < 2048; gy += 1) {
      const a = fieldCellSwToNeCut(gx, gy);
      if (a !== cellSwToNeCut(gx, gy)) mism += 1;
      if (a) trues += 1;
    }
  }
  check(`agrees on EVERY world cell (2048 x 2048 = ${2048 * 2048})`, mism === 0, `mismatches ${mism}`);
  check("…and both diagonals actually occur (not a constant)", trues > 1e6 && trues < 3.2e6, String(trues));
  let mismBig = 0;
  for (let i = 0; i < 1000000; i += 1) {
    const gx = (hash01(i, 11) * 4294967296) >>> 0;
    const gy = (hash01(i, 12) * 4294967296) >>> 0;
    if (fieldCellSwToNeCut(gx, gy) !== cellSwToNeCut(gx, gy)) mismBig += 1;
  }
  check("agrees on 1M hashed full-range u32 coordinates", mismBig === 0, String(mismBig));
  const VEC = [
    [1352, 1440, true], [1352, 1441, true], [1352, 1442, true],
    [1353, 1440, false], [1353, 1441, false], [1353, 1442, true],
    [1354, 1440, false], [1354, 1441, false], [1354, 1442, false],
    [3262378, 3462562, false], [3692099, 3821186, true], [2959406, 3730572, false], [1962430, 3711880, false],
  ];
  check("Rust reference + u32-wrap vectors", VEC.every(([gx, gy, w]) => fieldCellSwToNeCut(gx, gy) === w));
}

// ---------------------------------------------------------------------------
console.log("\n-- F3. road distance: hbRoadEdgeDistanceInCell mirror vs roadEdgeDistanceInCell --");
{
  let worst = 0, noneOk = true, n = 0;
  for (let bits = 0; bits < 16; bits += 1) {
    const sw = bits & 1, se = (bits >> 1) & 1, nw = (bits >> 2) & 1, ne = (bits >> 3) & 1;
    for (let a = 0; a <= 48; a += 1) {
      for (let b = 0; b <= 48; b += 1) {
        const fx = F(a / 48), fy = F(b / 48);
        const want = roadEdgeDistanceInCell(sw, se, nw, ne, fx, fy);
        const got = fieldRoadEdgeDistanceInCell(sw, se, nw, ne, fx, fy);
        n += 1;
        if (want === Infinity) { if (got !== HB_ROAD_NONE) noneOk = false; continue; }
        worst = Math.max(worst, Math.abs(got - want));
      }
    }
  }
  check(`all 16 corner combos x 49x49 points (${n}): |diff| <= 1e-4`, worst <= 1e-4, worst.toExponential(2));
  check("no road corner -> HB_ROAD_NONE (1e9) exactly where the oracle says Infinity", noneOk && HB_ROAD_NONE === 1e9);
  check("all four -> -24 (the all_road base tile)", fieldRoadEdgeDistanceInCell(1, 1, 1, 1, 0.3, 0.6) === -24);
}

// ---------------------------------------------------------------------------
// Real landblocks.
// ---------------------------------------------------------------------------
const LBS = [];           // 5x5 around Holtburg
const ALIAS = [];         // LBs that share a slot with Holtburg: +16 in x, +16 in y
let haveDat = existsSync(CELL);
if (haveDat) {
  const dat = openDat(CELL);
  for (let dx = -2; dx <= 2; dx += 1) for (let dy = -2; dy <= 2; dy += 1) {
    const lb = readLandblock(dat, HX + dx, HY + dy);
    if (lb) LBS.push(lb);
  }
  for (const [x, y] of [[HX + 16, HY], [HX, HY + 16]]) {
    const lb = readLandblock(dat, x, y);
    if (lb) ALIAS.push(lb);
  }
  dat.close();
  haveDat = LBS.length === 25 && ALIAS.length === 2;
}
const lbAt = (x, y) => LBS.find((l) => l.lbX === x && l.lbY === y) || null;

/**
 * A point EXACTLY on its cell's split diagonal (x, y are f32, so this f64
 * arithmetic is exact). There the height is continuous but the face normal is
 * whichever triangle wins the tie: the oracle's f64 `fx >= fy` / `fx + fy <= 1`
 * can break it either way (division rounding), the GLSL decides on exact metres,
 * i.e. the way the oracle's maths says (>= / <= include equality). Returns the
 * exact-maths normal at a tie point, or null when the point is not a tie.
 */
function tieNormal(oracle, x, y) {
  const lbX = Math.floor(x / LBM), lbY = Math.floor(y / LBM);
  const lx = x - lbX * LBM, ly = y - lbY * LBM;
  const cx = Math.min(Math.floor(lx / 24), 7), cy = Math.min(Math.floor(ly / 24), 7);
  const dx = lx - cx * 24, dy = ly - cy * 24;
  const cut = cellSwToNeCut(lbX * 8 + cx, lbY * 8 + cy);
  if (cut ? dx !== dy : dx + dy !== 24) return null;
  const h = oracle.lookup(lbKeyFromXY(lbX, lbY)).heights;
  const z00 = h[cx * 9 + cy], z10 = h[(cx + 1) * 9 + cy], z01 = h[cx * 9 + cy + 1], z11 = h[(cx + 1) * 9 + cy + 1];
  const g = cut ? [z10 - z00, z11 - z10] : [z10 - z00, z01 - z00]; // lower-right / lower-left
  const v = [-g[0] / 24, -g[1] / 24, 1];
  const len = Math.hypot(v[0], v[1], v[2]);
  return { x: v[0] / len, y: v[1] / len, z: v[2] / len };
}
const ndiff = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));

/** Compare one point; returns null on agreement, else a reason string. */
function comparePoint(field, oracle, x, y, acc) {
  const s = oracle.sample(x, y);
  const m = field.sampleMirror(x, y);
  const oracleHas = !!(s && s.hasHeight);
  if (!oracleHas) return m === null ? null : `mirror non-null where the oracle has no ground at (${x}, ${y})`;
  if (m === null) return `mirror null where the oracle has ground at (${x}, ${y})`;
  const dh = Math.abs(m.height - s.height);
  let dn = ndiff(m.normal, s.normal);
  const tie = tieNormal(oracle, x, y);
  if (tie) {
    acc.ties += 1;
    if (dn > 1e-4) acc.tiesOracleOther += 1;
    dn = ndiff(m.normal, tie); // held to the exact-maths triangle instead
  }
  acc.dh = Math.max(acc.dh, dh);
  acc.dn = Math.max(acc.dn, dn);
  acc.n += 1;
  if (dh > 1e-3) return `height ${m.height} vs ${s.height} at (${x}, ${y})`;
  if (dn > 1e-4) return `normal off by ${dn} at (${x}, ${y})${tie ? " (tie)" : ""}`;
  for (let i = 0; i < 4; i += 1) {
    if (m.cornerCodes[i] !== s.cornerCodes[i]) return `cornerCodes ${Array.from(m.cornerCodes)} vs ${Array.from(s.cornerCodes)} at (${x}, ${y})`;
  }
  if (s.roadEdgeM === Infinity) {
    if (!(m.roadEdgeM >= 1e8)) return `roadEdgeM ${m.roadEdgeM} vs Infinity at (${x}, ${y})`;
  } else {
    acc.roads += 1;
    if (s.roadEdgeM <= 0) acc.onRoad += 1;
    const dr = Math.abs(m.roadEdgeM - s.roadEdgeM);
    acc.dr = Math.max(acc.dr, dr);
    if (!(dr <= 1e-3)) return `roadEdgeM ${m.roadEdgeM} vs ${s.roadEdgeM} at (${x}, ${y})`;
  }
  return null;
}
function runPoints(field, oracle, pts) {
  const acc = { n: 0, dh: 0, dn: 0, dr: 0, roads: 0, onRoad: 0, ties: 0, tiesOracleOther: 0, bad: 0, firstBad: null, total: pts.length };
  for (const [x, y] of pts) {
    const why = comparePoint(field, oracle, x, y, acc);
    if (why) { acc.bad += 1; if (!acc.firstBad) acc.firstBad = why; }
  }
  return acc;
}

if (!haveDat) {
  console.log(`\n  real-DAT sections F4-F8 not run: ${CELL} missing or short (set HB_CELL_DAT)`);
} else {
  // -------------------------------------------------------------------------
  console.log("\n-- F4. sampleMirror vs oracle.sample() on real Holtburg landblocks (5x5) --");
  const oracle = createTerrainOracle();
  for (const lb of LBS) noteLb(oracle, lb);
  const field = createTerrainFieldGpu({ oracle });
  const wrote = field.update(HX * LBM + 96, HY * LBM + 96);
  check("first update writes the 25 cached LBs of the 15x15 window", wrote === 25 && field.stats().slotsValid === 25,
    `${wrote} ${JSON.stringify(field.stats())}`);
  let roadVerts = 0;
  for (const lb of LBS) for (let i = 0; i < 81; i += 1) if (lb.roads[i]) roadVerts += 1;
  check("the block has real road vertices and varied ground", roadVerts > 40
    && new Set(LBS.flatMap((l) => Array.from(l.heights))).size > 20, String(roadVerts));

  const X0 = (HX - 2) * LBM, Y0 = (HY - 2) * LBM, SPAN = 5 * LBM;
  // (a) hashed interior points, f32-quantised (the shader sees f32 p; the oracle
  //     doc's parity rule: compare at the SAME f32 point).
  const ptsA = [];
  for (let i = 0; i < 40000; i += 1) ptsA.push([F(X0 + hash01(i, 1) * SPAN), F(Y0 + hash01(i, 2) * SPAN)]);
  const a = runPoints(field, oracle, ptsA);
  console.log(`  [info] hashed: ${a.n} compared, max |dh| ${a.dh.toExponential(2)}, max |dn| ${a.dn.toExponential(2)}, `
    + `max |droad| ${a.dr.toExponential(2)} over ${a.roads} road-cell points (${a.onRoad} on the road); `
    + `${a.ties} exactly on a split diagonal, of which the f64 oracle broke ${a.tiesOracleOther} the other way`);
  check(`40,000 hashed points agree (height 1e-3, normal 1e-4, codes exact, road 1e-3)`, a.bad === 0 && a.n === 40000,
    `${a.bad} bad; ${a.firstBad}`);

  // (b) LB edges, LB corners, vertex lines, the last f32 below each LB edge.
  const ptsB = [];
  for (const lb of LBS) {
    const ox = lb.lbX * LBM, oy = lb.lbY * LBM;
    for (let k = 0; k <= 8; k += 1) {
      for (let j = 0; j <= 8; j += 1) ptsB.push([ox + k * 24, oy + j * 24]);       // all 81 vertices (incl. LB corners)
    }
    for (let i = 0; i < 64; i += 1) {
      const t = F(hash01(i + lb.lbX * 977 + lb.lbY * 131, 3) * LBM);
      ptsB.push([ox, F(oy + t)], [F(ox + t), oy]);                                 // on the west / south LB edge
      const below = F(ox + LBM) - 2 ** -8;                                         // an f32 just inside the LB's east / north edge
      ptsB.push([F(below), F(oy + t)], [F(ox + t), F(oy + LBM - 2 ** -8)]);
      ptsB.push([F(ox + (i % 9) * 24), F(oy + t)], [F(ox + t), F(oy + (i % 9) * 24)]); // vertex lines
    }
  }
  const b = runPoints(field, oracle, ptsB);
  console.log(`  [info] edges: ${b.n} of ${b.total} on loaded ground (the rest on the unloaded fringe, null on both sides), `
    + `max |dh| ${b.dh.toExponential(2)}, max |dn| ${b.dn.toExponential(2)}, ${b.ties} diagonal ties (oracle other way: ${b.tiesOracleOther})`);
  check(`${b.total} LB edge / corner / vertex-line points agree`, b.bad === 0 && b.n > 0.9 * b.total, `${b.bad} bad; ${b.firstBad}`);
  // Hand-made ties: points ON each cell's split diagonal (both kinds), 4 per cell.
  const ptsT = [];
  for (const lb of LBS) {
    for (let cx = 0; cx < 8; cx += 1) for (let cy = 0; cy < 8; cy += 1) {
      const cut = cellSwToNeCut(lb.lbX * 8 + cx, lb.lbY * 8 + cy);
      for (const t of [1.75, 7.5, 12.25, 19.0625]) {
        const ox = lb.lbX * LBM + cx * 24, oy = lb.lbY * LBM + cy * 24;
        ptsT.push(cut ? [ox + t, oy + t] : [ox + t, oy + 24 - t]);
      }
    }
  }
  const tt = runPoints(field, oracle, ptsT);
  console.log(`  [info] diagonal ties: ${tt.ties} constructed, the f64 oracle broke ${tt.tiesOracleOther} of them the other way`);
  check(`${tt.total} points exactly ON split diagonals: height agrees, normal = the exact-maths triangle`,
    tt.bad === 0 && tt.ties === tt.total && tt.n === tt.total, `${tt.bad} bad; ${tt.firstBad}`);

  // (c) every road cell, an 8x8 grid strictly inside it (3 m pitch).
  const ptsC = [];
  let roadCells = 0;
  for (const lb of LBS) {
    const at = (vx, vy) => lb.roads[vx * 9 + vy];
    for (let cx = 0; cx < 8; cx += 1) for (let cy = 0; cy < 8; cy += 1) {
      if (!(at(cx, cy) || at(cx + 1, cy) || at(cx, cy + 1) || at(cx + 1, cy + 1))) continue;
      roadCells += 1;
      const ox = lb.lbX * LBM + cx * 24, oy = lb.lbY * LBM + cy * 24;
      for (let u = 0; u < 8; u += 1) for (let v = 0; v < 8; v += 1) ptsC.push([F(ox + u * 3 + 0.0625), F(oy + v * 3 + 0.125)]);
    }
  }
  const c = runPoints(field, oracle, ptsC);
  console.log(`  [info] road cells: ${roadCells}; ${c.roads} points with a finite roadEdgeM, ${c.onRoad} on the road, max |droad| ${c.dr.toExponential(2)}`);
  check(`every road cell (${roadCells} cells, ${c.total} points) agrees`, c.bad === 0 && roadCells > 30 && c.roads === c.total && c.onRoad > 500,
    `${c.bad} bad; ${c.firstBad}`);

  // (d) the unloaded fringe: both null, never a wrapped neighbour.
  const ptsD = [];
  for (let i = 0; i < 2000; i += 1) {
    const t = F(Y0 + hash01(i, 5) * SPAN);
    ptsD.push([F(X0 + SPAN + hash01(i, 6) * 300), t], [F(X0 - 1 - hash01(i, 7) * 300), t]);
  }
  ptsD.push([X0 + SPAN, Y0 + 10], [X0 - 2 ** -8, Y0 + 10]);
  const d = runPoints(field, oracle, ptsD);
  check(`${d.total} points on unloaded neighbours: null on both sides`, d.bad === 0 && d.n === 0, `${d.bad} bad; ${d.firstBad}`);

  check("the out object is reused (allocation-free hot path)", (() => {
    const out = {};
    const r1 = field.sampleMirror(HX * LBM + 10, HY * LBM + 10, out);
    const cc = out.cornerCodes, nn = out.normal;
    const r2 = field.sampleMirror(HX * LBM + 50, HY * LBM + 70, out);
    return r1 === out && r2 === out && out.cornerCodes === cc && out.normal === nn;
  })());

  // -------------------------------------------------------------------------
  console.log("\n-- F5. texel layout --");
  {
    let bad = 0;
    for (const lb of LBS) {
      const sx = lb.lbX & 15, sy = lb.lbY & 15;
      for (let col = 0; col < 9; col += 1) for (let row = 0; row < 9; row += 1) {
        const i = col * 9 + row;
        const di = ((sy * 9 + row) * 144 + sx * 9 + col) * 4;
        const D = field._fieldData;
        if (D[di] !== lb.heights[i] || D[di + 1] !== (lb.codes[i] & 0x1f) || D[di + 2] !== (lb.roads[i] ? 1 : 0) || D[di + 3] !== 1) bad += 1;
      }
      const k = (sy * 16 + sx) * 4;
      const K = field._keyData;
      if (K[k] !== lb.lbX || K[k + 1] !== lb.lbY || K[k + 2] !== 1 || K[k + 3] !== 1) bad += 1;
    }
    check("all 25 x 81 texels + 25 keys sit exactly where the contract says", bad === 0, String(bad));
    check("layout constants", FIELD_SLOTS === 16 && FIELD_TILE === 9 && FIELD_TEX_SIZE === 144
      && field._fieldData.length === 144 * 144 * 4 && field._keyData.length === 16 * 16 * 4 && FIELD_MAX_WINDOW_RADIUS_LB === 7);
    const vRoad = LBS.flatMap((l) => Array.from(l.roads)).filter((r) => r > 1).length;
    console.log(`  [info] raw 2-bit road values > 1 in the block: ${vRoad} (stored as flag 1)`);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- F6. window behaviour --");
  {
    // Radius 1 so LBs visibly enter / leave.
    const o = createTerrainOracle();
    for (const lb of LBS) noteLb(o, lb);
    const f = createTerrainFieldGpu({ oracle: o, windowRadiusLb: 1 });
    const mid = (x, y) => [x * LBM + 96.5, y * LBM + 101.25];
    const agrees = (x, y) => {
      const [px, py] = mid(x, y);
      const m = f.sampleMirror(px, py), s = o.sample(px, py);
      return !!m && Math.abs(m.height - s.height) < 1e-3;
    };
    const isNull = (x, y) => f.sampleMirror(...mid(x, y)) === null;
    check("r=1 at Holtburg: 9 slots valid", f.update(...mid(HX, HY)) === 9 && f.stats().slotsValid === 9);
    check("…an in-window LB samples, a cached LB outside the window is false", agrees(HX - 1, HY) && isNull(HX - 2, HY));
    const w0 = f.stats().writes, i0 = f.stats().invalidations;
    const ch = f.update(...mid(HX + 1, HY));
    const s1 = f.stats();
    check("step one LB east: 3 enter (written), 3 leave (invalidated)", ch === 6 && s1.writes - w0 === 3 && s1.invalidations - i0 === 3,
      `${ch} ${s1.writes - w0} ${s1.invalidations - i0}`);
    check("…the left column is false, the new right column samples", isNull(HX - 1, HY) && agrees(HX + 2, HY) && agrees(HX + 2, HY + 1));
    const snap = Float32Array.from(f._fieldData);
    const w1 = s1.writes, u1 = s1.uploads;
    const ch2 = f.update(...mid(HX, HY));
    const s2 = f.stats();
    check("step back: the returning column only RE-VALIDATES (same entries, tiles intact): 0 writes",
      ch2 === 6 && s2.writes === w1 && s2.uploads === u1 + 1, `${ch2} ${s2.writes - w1} ${s2.uploads - u1}`);
    check("…field array untouched, and the returning LB samples again",
      snap.every((v, i) => v === f._fieldData[i]) && agrees(HX - 1, HY));

    // Rebake: a new entry rewrites exactly its slot.
    const lb = lbAt(HX, HY);
    const raised = Float32Array.from(lb.heights, (h) => h + 5);
    const before = Float32Array.from(f._fieldData);
    noteLb(o, lb, { heights: raised });
    const w2 = f.stats().writes;
    const ch3 = f.update(...mid(HX, HY));
    let outside = 0, inside = 0;
    const sx = HX & 15, sy = HY & 15;
    for (let t = 0; t < 144 * 144; t += 1) {
      const tx = t % 144, ty = (t / 144) | 0;
      const mine = Math.floor(tx / 9) === sx && Math.floor(ty / 9) === sy;
      const diff = before[t * 4] !== f._fieldData[t * 4];
      if (diff && !mine) outside += 1;
      if (diff && mine) inside += 1;
    }
    check("rebake (new entry object): exactly 1 slot rewritten", ch3 === 1 && f.stats().writes === w2 + 1, `${ch3}`);
    check("…only that LB's texels changed, all 81 of them", outside === 0 && inside === 81, `${outside} ${inside}`);
    check("…and the mirror reads the NEW heights", agrees(HX, HY)
      && Math.abs(f.sampleMirror(...mid(HX, HY)).height - (o.sample(...mid(HX, HY)).height)) < 1e-3
      && o.sample(...mid(HX, HY)).height > 4);

    // Invalidate clears; re-note restores.
    o.invalidate(lbKeyFromXY(HX, HY));
    const ch4 = f.update(...mid(HX, HY));
    check("invalidate -> the slot goes false (1 change, 8 valid)", ch4 === 1 && isNull(HX, HY) && f.stats().slotsValid === 8);
    check("…the key texel's valid flag is 0", f._keyData[((HY & 15) * 16 + (HX & 15)) * 4 + 3] === 0);
    noteLb(o, lb);
    check("re-note -> valid again", f.update(...mid(HX, HY)) === 1 && agrees(HX, HY) && f.stats().slotsValid === 9);

    // Slot aliasing on REAL data: LB x and x+16 (and y+16) share Holtburg's slot.
    const oa = createTerrainOracle();
    for (const l of LBS) noteLb(oa, l);
    for (const l of ALIAS) noteLb(oa, l);
    const fa = createTerrainFieldGpu({ oracle: oa });
    const [ax, ay] = [ALIAS[0].lbX, ALIAS[0].lbY];
    check("the aliased LBs map to Holtburg's slot and carry different ground",
      (ax & 15) === (HX & 15) && (ALIAS[1].lbY & 15) === (HY & 15)
      && ALIAS.every((l) => l.heights.some((h, i) => h !== lbAt(HX, HY).heights[i])));
    fa.update(...mid(HX, HY));
    const alPts = (x, y) => Array.from({ length: 500 }, (_, i) => [F(x * LBM + hash01(i, 21) * LBM), F(y * LBM + hash01(i, 22) * LBM)]);
    const nonNull = (pts) => pts.filter(([x, y]) => fa.sampleMirror(x, y) !== null).length;
    check("centred on Holtburg: 500 points in 0xB9B4 and 0xA9C4 are ALL false (slot holds 0xA9B4)",
      nonNull(alPts(ax, ay)) === 0 && nonNull(alPts(ALIAS[1].lbX, ALIAS[1].lbY)) === 0);
    check("…while Holtburg itself agrees with the oracle", runPoints(fa, oa, alPts(HX, HY)).bad === 0);
    fa.update(...mid(ax, ay));
    const ra = runPoints(fa, oa, alPts(ax, ay));
    check("centred on 0xB9B4: its 500 points agree with ITS oracle data", ra.bad === 0 && ra.n === 500, `${ra.bad} ${ra.firstBad}`);
    check("…and Holtburg (now outside, same slot) is ALL false", nonNull(alPts(HX, HY)) === 0);
    fa.update(...mid(ALIAS[1].lbX, ALIAS[1].lbY));
    const rb = runPoints(fa, oa, alPts(ALIAS[1].lbX, ALIAS[1].lbY));
    check("centred on 0xA9C4 (y alias): agrees, Holtburg false", rb.bad === 0 && rb.n === 500 && nonNull(alPts(HX, HY)) === 0);

    // Off-world.
    check("off-world points are false (negative, >= 49152, NaN, Infinity)",
      [[-0.001, 100], [100, -0.5], [49152, 100], [100, 49152], [NaN, 5], [5, Infinity]]
        .every(([x, y]) => f.sampleMirror(x, y) === null));
    const ow = createTerrainOracle();
    const hl = lbAt(HX, HY);
    noteLb(ow, { ...hl, lbX: 0, lbY: 0 });
    noteLb(ow, { ...hl, lbX: 255, lbY: 255 });
    const fw = createTerrainFieldGpu({ oracle: ow });
    fw.update(-5000, -5000); // player off-world: window -33..-19 -> nothing
    check("player off-world: no slot valid", fw.stats().slotsValid === 0 && fw.sampleMirror(10, 10) === null);
    fw.update(10, 10);
    const rw = runPoints(fw, ow, Array.from({ length: 300 }, (_, i) => [F(hash01(i, 31) * LBM), F(hash01(i, 32) * LBM)]));
    check("LB (0,0) at the world corner: window clipped, samples agree", rw.bad === 0 && rw.n === 300 && fw.stats().slotsValid === 1);
    check("…a point just west / south of the world is false (no wrap onto LB 255)",
      fw.sampleMirror(-0.01, 10) === null && fw.sampleMirror(10, -0.01) === null);
    fw.update(49151, 49151);
    check("LB (255,255): samples agree; x >= 49152 is false",
      runPoints(fw, ow, [[49151.5, 49100], [255 * LBM + 0.5, 255 * LBM + 0.5], [49151.99609375, 49151.99609375]]).bad === 0
      && fw.sampleMirror(255 * LBM + 10, 255 * LBM + 10) !== null && fw.sampleMirror(49152, 49100) === null);

    // Unbaked / heightless.
    const ou = createTerrainOracle();
    noteLb(ou, lbAt(HX, HY));
    noteLb(ou, lbAt(HX + 1, HY), { heights: undefined });
    const fu = createTerrainFieldGpu({ oracle: ou });
    fu.update(...mid(HX, HY));
    check("an unbaked window LB is false", fu.sampleMirror(...mid(HX - 1, HY)) === null && ou.sample(...mid(HX - 1, HY)) === null);
    const sNoH = ou.sample(...mid(HX + 1, HY));
    check("an LB with codes but NO heights is false (the oracle reports hasHeight false)",
      fu.sampleMirror(...mid(HX + 1, HY)) === null && !!sNoH && sNoH.hasHeight === false);
    const kNoH = (((HY & 15) * 16) + ((HX + 1) & 15)) * 4;
    check("…its key is (lbX, lbY, hasHeights 0, valid 1) and its heights texels are 0",
      fu._keyData[kNoH] === HX + 1 && fu._keyData[kNoH + 2] === 0 && fu._keyData[kNoH + 3] === 1
      && fu._fieldData[(((HY & 15) * 9) * 144 + ((HX + 1) & 15) * 9) * 4] === 0);

    // Radius clamp + a FULL window: 225 distinct slots.
    check("windowRadiusLb clamps: 20 -> 7, -3 -> 0, absent -> 7, 2.9 -> 2",
      createTerrainFieldGpu({ windowRadiusLb: 20 }).stats().windowRadiusLb === 7
      && createTerrainFieldGpu({ windowRadiusLb: -3 }).stats().windowRadiusLb === 0
      && createTerrainFieldGpu({}).stats().windowRadiusLb === 7
      && createTerrainFieldGpu({ windowRadiusLb: 2.9 }).stats().windowRadiusLb === 2);
    const of = createTerrainOracle();
    for (let dx = -8; dx <= 8; dx += 1) for (let dy = -8; dy <= 8; dy += 1) {
      const src = LBS[((dx + 8) * 17 + dy + 8) % 25];
      noteLb(of, { ...src, lbX: HX + dx, lbY: HY + dy });
    }
    const ff = createTerrainFieldGpu({ oracle: of, windowRadiusLb: 99 });
    ff.update(...mid(HX, HY));
    let keysOk = true;
    for (let s = 0; s < 256; s += 1) {
      const kx = ff._keyData[s * 4], ky = ff._keyData[s * 4 + 1];
      if (ff._keyData[s * 4 + 3] !== 1 || Math.abs(kx - HX) > 7 || Math.abs(ky - HY) > 7) {
        // the 31 slots no window LB maps to must be invalid
        if (ff._keyData[s * 4 + 3] === 1) keysOk = false;
      }
    }
    let allSample = true;
    for (let dx = -8; dx <= 8; dx += 1) for (let dy = -8; dy <= 8; dy += 1) {
      const inWin = Math.abs(dx) <= 7 && Math.abs(dy) <= 7;
      if ((ff.sampleMirror(...mid(HX + dx, HY + dy)) !== null) !== inWin) allSample = false;
    }
    check("17x17 cached, r=7: exactly the 15x15 window is valid (225 distinct slots)", ff.stats().slotsValid === 225 && keysOk);
    check("…every window LB samples, every LB beyond it is false", allSample);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- F7. update() is a no-op when nothing changed --");
  {
    const o = createTerrainOracle();
    for (const lb of LBS) noteLb(o, lb);
    let lookups = 0;
    const counting = { version: () => o.version(), lookup: (k) => { lookups += 1; return o.lookup(k); } };
    const f = createTerrainFieldGpu({ THREE, oracle: counting });
    f.update(HX * LBM + 10, HY * LBM + 10);
    const st = f.stats(), vf = f.uniforms.uHbField.value.version, vk = f.uniforms.uHbFieldKey.value.version, L = lookups;
    const r = [f.update(HX * LBM + 150, HY * LBM + 20), f.update(HX * LBM + 1, HY * LBM + 191), f.update(HX * LBM + 96, HY * LBM + 96)];
    const st2 = f.stats();
    check("same LB, same version: returns 0 three times", r.every((v) => v === 0));
    check("…no lookup, no walk, no write, no upload", lookups === L && st2.walks === st.walks && st2.writes === st.writes && st2.uploads === st.uploads);
    check("…no texture version bump (nothing re-uploaded)", f.uniforms.uHbField.value.version === vf && f.uniforms.uHbFieldKey.value.version === vk);
    check("non-finite player position is a no-op", f.update(NaN, 5) === 0 && f.stats().walks === st.walks);
    o.noteLandblock(lbKeyFromXY(HX + 40, HY), { codes: LBS[0].codes, heights: LBS[0].heights }); // far away: version moves
    check("a version bump far outside the window walks but writes nothing", f.update(HX * LBM + 10, HY * LBM + 10) === 0
      && f.stats().walks === st.walks + 1 && f.stats().writes === st.writes && f.uniforms.uHbField.value.version === vf);

    // A walk that ADOPTS through the backfill leaves the next update a no-op.
    const meshes = LBS.map((lb) => ({ userData: { lbX: lb.lbX, lbY: lb.lbY, terrainCodes: lb.codes, heights: lb.heights, roadCodes: lb.roads } }));
    const ob = createTerrainOracle({ getTerrainMeshes: () => meshes });
    const fb = createTerrainFieldGpu({ oracle: ob });
    const wb = fb.update(HX * LBM + 10, HY * LBM + 10);
    check("backfill: the walk adopts all 25 pre-oracle LBs through lookup()", wb === 25 && ob.stats().backfills === 25 && fb.stats().slotsValid === 25);
    check("…and the adoption-bumped version is already absorbed: next update is a no-op",
      fb.update(HX * LBM + 20, HY * LBM + 10) === 0 && fb.stats().walks === 1 && fb.stats().oracleVersion === ob.version());
    check("…the adopted ground agrees with the oracle", runPoints(fb, ob, Array.from({ length: 2000 }, (_, i) =>
      [F(X0 + hash01(i, 41) * SPAN), F(Y0 + hash01(i, 42) * SPAN)])).bad === 0);

    // Getter form: null first (oracle not loaded yet), then the oracle.
    let cur = null;
    const fg = createTerrainFieldGpu({ oracle: () => cur });
    check("getter returning null: nothing valid, no throw", fg.update(HX * LBM + 10, HY * LBM + 10) === 0 && fg.stats().slotsValid === 0);
    check("…and a second call is a no-op", fg.update(HX * LBM + 10, HY * LBM + 10) === 0 && fg.stats().walks === 1);
    cur = o;
    check("the oracle arriving later fills the window with no player movement", fg.update(HX * LBM + 10, HY * LBM + 10) === 25
      && fg.stats().slotsValid === 25);
    // An oracle without version(): re-walks each call, but identity keeps writes at zero.
    const nov = { lookup: (k) => o.lookup(k) };
    const fn = createTerrainFieldGpu({ oracle: nov });
    fn.update(HX * LBM + 10, HY * LBM + 10);
    const wn = fn.stats().writes;
    check("an oracle without version(): re-walks, but identity means 0 rewrites",
      fn.update(HX * LBM + 10, HY * LBM + 10) === 0 && fn.stats().walks === 2 && fn.stats().writes === wn && fn.stats().oracleVersion === null);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- F8. heightRange --");
  {
    const o = createTerrainOracle();
    for (const lb of LBS) noteLb(o, lb);
    const hn = lbAt(HX + 1, HY);
    noteLb(o, hn, { heights: undefined });
    const f = createTerrainFieldGpu({ oracle: o });
    check("null before the first update", f.heightRange(X0, Y0, X0 + 10, Y0 + 10) === null);
    f.update(HX * LBM + 10, HY * LBM + 10);
    const mm = (lbs) => {
      let mn = Infinity, mx = -Infinity;
      for (const l of lbs) for (const h of l.heights) { mn = Math.min(mn, h); mx = Math.max(mx, h); }
      return { min: mn, max: mx };
    };
    const withH = LBS.filter((l) => l !== hn);
    const all = f.heightRange(X0, Y0, X0 + SPAN - 1, Y0 + SPAN - 1);
    const wantAll = mm(withH);
    check("whole 5x5: min/max over every resident LB WITH heights", all && all.min === wantAll.min && all.max === wantAll.max,
      JSON.stringify([all, wantAll]));
    const one = f.heightRange(HX * LBM + 30, HY * LBM + 40, HX * LBM + 100, HY * LBM + 120);
    const wantOne = mm([lbAt(HX, HY)]);
    check("a rect inside one LB: that LB's per-LB extremes", one && one.min === wantOne.min && one.max === wantOne.max);
    check("inverted corners give the same answer", (() => {
      const r = f.heightRange(HX * LBM + 100, HY * LBM + 120, HX * LBM + 30, HY * LBM + 40);
      return r && r.min === one.min && r.max === one.max;
    })());
    const two = f.heightRange(HX * LBM + 150, HY * LBM + 10, (HX - 1) * LBM + 150, HY * LBM + 20);
    const wantTwo = mm([lbAt(HX, HY), lbAt(HX - 1, HY)]);
    check("a rect straddling two LBs: the union", two && two.min === wantTwo.min && two.max === wantTwo.max);
    check("the heightless LB contributes nothing (null over it alone)",
      f.heightRange((HX + 1) * LBM + 10, HY * LBM + 10, (HX + 1) * LBM + 100, HY * LBM + 100) === null);
    check("unloaded ground / off-world / NaN -> null",
      f.heightRange(X0 - 500, Y0, X0 - 300, Y0 + 100) === null
      && f.heightRange(-900, -900, -100, -100) === null && f.heightRange(NaN, 0, 1, 1) === null);
    const out = {};
    check("out object reused", f.heightRange(HX * LBM + 30, HY * LBM + 40, HX * LBM + 100, HY * LBM + 120, out) === out && out.min === wantOne.min);
    // A rebake moves the extremes.
    noteLb(o, lbAt(HX, HY), { heights: Float32Array.from(lbAt(HX, HY).heights, (h) => h + 100) });
    f.update(HX * LBM + 10, HY * LBM + 10);
    const re = f.heightRange(HX * LBM + 30, HY * LBM + 40, HX * LBM + 100, HY * LBM + 120);
    check("a rebake updates the per-LB extremes (+100 m)", re && re.min === wantOne.min + 100 && re.max === wantOne.max + 100);
    f.update((HX + 20) * LBM, HY * LBM);
    check("an LB that left the window -> null", f.heightRange(HX * LBM + 30, HY * LBM + 40, HX * LBM + 100, HY * LBM + 120) === null);
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- F9. GPU objects (real three) / no THREE --");
{
  const o = createTerrainOracle();
  const codes = new Uint8Array(81).fill(1), heights = new Float32Array(81).fill(3);
  o.noteLandblock(lbKeyFromXY(HX, HY), { codes, heights, lbX: HX, lbY: HY });
  const f = createTerrainFieldGpu({ THREE, oracle: o, windowRadiusLb: 1 });
  const t = f.uniforms.uHbField.value, k = f.uniforms.uHbFieldKey.value;
  check("uHbField is a DataTexture 144x144 over _fieldData", !!t && t.isDataTexture === true
    && t.image.width === 144 && t.image.height === 144 && t.image.data === f._fieldData);
  check("uHbFieldKey is a DataTexture 16x16 over _keyData", !!k && k.isDataTexture === true
    && k.image.width === 16 && k.image.height === 16 && k.image.data === f._keyData);
  for (const [name, tex] of [["field", t], ["key", k]]) {
    check(`${name}: RGBAFormat + FloatType (RGBA32F), Nearest/Nearest, no mips, flipY false`,
      tex.format === THREE.RGBAFormat && tex.type === THREE.FloatType
      && tex.minFilter === THREE.NearestFilter && tex.magFilter === THREE.NearestFilter
      && tex.generateMipmaps === false && tex.flipY === false);
  }
  check("arrays are Float32Array", f._fieldData instanceof Float32Array && f._keyData instanceof Float32Array);
  check("stats().gpu true", f.stats().gpu === true);
  const vf = t.version, vk = k.version;
  f.update(HX * LBM + 5, HY * LBM + 5);
  check("a tile write re-uploads BOTH textures (version bump)", t.version > vf && k.version > vk);
  const vf2 = t.version, vk2 = k.version;
  o.invalidate(lbKeyFromXY(HX, HY));
  f.update(HX * LBM + 5, HY * LBM + 5);
  check("an invalidation-only walk re-uploads the KEY only", t.version === vf2 && k.version > vk2);
  let disposedN = 0;
  t.addEventListener("dispose", () => { disposedN += 1; });
  k.addEventListener("dispose", () => { disposedN += 1; });
  const uref = f.uniforms.uHbField;
  f.dispose();
  check("dispose(): both textures disposed, uniform objects kept (by reference) with null values",
    disposedN === 2 && f.uniforms.uHbField === uref && uref.value === null && f.uniforms.uHbFieldKey.value === null);
  check("…update after dispose is a no-op; mirror false", f.update(HX * LBM + 5, HY * LBM + 5) === 0 && f.sampleMirror(HX * LBM + 5, HY * LBM + 5) === null);

  const n = createTerrainFieldGpu({ oracle: o });
  check("no THREE: uniforms exist with null values, gpu false", n.uniforms.uHbField.value === null
    && n.uniforms.uHbFieldKey.value === null && n.stats().gpu === false);
  o.noteLandblock(lbKeyFromXY(HX, HY), { codes, heights, lbX: HX, lbY: HY });
  n.update(HX * LBM + 5, HY * LBM + 5);
  const s = n.sampleMirror(HX * LBM + 5, HY * LBM + 5);
  check("no THREE: the arrays + mirror still run", !!s && s.height === 3 && n.stats().uploads === 2);
  const empty = createTerrainFieldGpu({});
  check("no oracle at all: update/heightRange/mirror are inert", empty.update(5, 5) === 0 && empty.heightRange(0, 0, 10, 10) === null
    && empty.sampleMirror(5, 5) === null);
  check("stats() shape", (() => {
    const st = n.stats();
    return ["slotsValid", "writes", "uploads", "centerLb", "oracleVersion"].every((key) => key in st)
      && st.centerLb.x === HX && st.centerLb.y === HY && st.oracleVersion === o.version();
  })(), JSON.stringify(n.stats()));
}

// ---------------------------------------------------------------------------
console.log("\n-- F10. GLSL hygiene --");
{
  const G = TERRAIN_FIELD_GLSL;
  const countOf = (re) => (G.match(re) || []).length;
  check("no backticks in the GLSL", !G.includes("`"));
  check("plain ASCII, no quotes / apostrophes / $ / @ / backslash (GLSL ES charset, comments too)",
    /^[\x09\x0a\x0d\x20-\x7e]*$/.test(G) && !/['"$@\\]/.test(G));
  check("uHbField declared exactly once", countOf(/\buniform\s+highp\s+sampler2D\s+uHbField\s*;/g) === 1
    && countOf(/\buHbField\b\s*;/g) === 1);
  check("uHbFieldKey declared exactly once", countOf(/\buniform\s+highp\s+sampler2D\s+uHbFieldKey\s*;/g) === 1);
  check("exactly two uniforms in total", countOf(/^\s*uniform\b/gm) === 2);
  for (const sig of [
    /\bbool\s+hbCellSwToNeCut\s*\(\s*int\s+gcx\s*,\s*int\s+gcy\s*\)\s*\{/g,
    /\bfloat\s+hbRoadEdgeDistanceInCell\s*\(\s*ivec4\s+roads\s*,\s*vec2\s+f\s*\)\s*\{/g,
    /\bbool\s+hbFieldSample\s*\(\s*vec2\s+p\s*,\s*out\s+float\s+height\s*,\s*out\s+vec3\s+normal\s*,\s*out\s+ivec4\s+cornerCodes\s*,\s*out\s+float\s+roadEdgeM\s*\)\s*\{/g,
  ]) check(`defined exactly once with the contract signature: ${sig.source.slice(3, 40)}...`, countOf(sig) === 1);
  const bal = (o, c) => G.split(o).length === G.split(c).length;
  check("balanced braces and parentheses", bal("{", "}") && bal("(", ")"));
  check("the split constants + the exact cutoff are in the GLSL",
    ["214614067u", "1813693831u", "1109124029u", "1369149221u", `${SW_NE_CUT_MIN_U32}u`].every((s) => G.includes(s)));
  const constOf = (name) => {
    const m = G.match(new RegExp(`const float ${name} = ([^;]+);`));
    return m ? m[1] : null;
  };
  check("road widths ARE the oracle's ROAD_PAINT",
    parseFloat(constOf("HB_ROAD_EDGE_HALF")) === ROAD_PAINT.edgeHalfWidthM
    && parseFloat(constOf("HB_ROAD_DIAG_HALF")) === ROAD_PAINT.diagHalfWidthM
    && parseFloat(constOf("HB_ROAD_CORNER_R")) === ROAD_PAINT.cornerRadiusM
    && parseFloat(constOf("HB_ROAD_NONE")) === HB_ROAD_NONE);
  const consts = [...G.matchAll(/const float \w+ = ([^;]+);/g)].map((m) => m[1]);
  check("every float constant is a FLOAT literal (an int literal there is a GLSL error)",
    consts.length >= 7 && consts.every((v) => /[.eE]/.test(v)), consts.join(" "));
  check("exact fetches only: texelFetch, no filtered texture() reads",
    countOf(/\btexelFetch\s*\(/g) === 5 && countOf(/\btexture2?D?\s*\(/g) === 0);
  check("no #version / precision statements (three owns the prefix)", !/#version|^\s*precision\b/m.test(G));
  const src = readFileSync(resolvePath(__dirname, "scene3d/terrain_field_gpu.js"), "utf8");
  const hits = lintSource(src);
  check("lintSource(terrain_field_gpu.js) clean (no Math.random / Date.now() / ...)", hits.length === 0,
    hits.map((h) => `${h.lineno}:${h.label}`).join(", "));
  check("THREE is injected: the module imports no three", !/from\s+["']three["']/.test(src));
}

console.log(`\nterrain field gpu: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
