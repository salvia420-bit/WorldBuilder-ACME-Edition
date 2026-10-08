// 2026-10-07 — grass (and rock pebbles) OFF THE ROAD, against real DAT data.
//
// Owner, preparing a Holtburg video take with `?terrainGrass=on`: "see the grass
// on the road. can we make it so its not on the road". A retail road is 2 bits
// on the vertex word, not a terrain code, so the code-keyed grass dither planted
// blades straight across the cobbles.
//
// Run with:
//   cd apps/holtburger-web && node test_terrain_grass_offroad.mjs
//   (HB_PORTAL_DAT / HB_CELL_DAT override ~/ac_base_dats/client_{portal,cell_1}.dat)
//
// Locks:
//  1. FLAG — `?grassOffRoad` is DEFAULT-ON; off/0/false/no turn it off;
//     `resolveGrassConfig` carries it and an explicit override wins.
//  2. MASK CALIBRATION (real client_portal.dat) — the three retail road alpha
//     masks the default TexMerge path composites (src/lib.rs RETAIL_ROAD_MASKS)
//     are read straight out of the DAT. Their authored orientation is asserted
//     (edge lane on the west column, diagonal NW->SE, corner disc at NW — the
//     frame the shader's rotation table assumes), then every >= 50 %-road texel
//     must lie inside `ROAD_PAINT`'s half-width of its skeleton, the half-widths
//     must stay TIGHT (no "just make it huge"), and the 1.5 m grass verge must
//     cover the masks' soft fringe (>= 15 % road).
//  3. GROUND TRUTH (real client_cell_1.dat + portal masks) — a full port of the
//     shader's road coverage for every cell of Holtburg's 3x3 landblocks
//     (road_code -> FindRoadAlpha rotation -> the documented mask-texel table
//     of `rotateCellUv`/`maskUvFor` -> 1 - prod(baseW)), sampled on a 0.5 m
//     grid: every point the shader paints >= 50 % road has the REAL oracle's
//     `roadEdgeM <= 0`, i.e. the model contains the painted road.
//  4. END TO END (real oracle, real grass provider, real three) — at the
//     owner's screenshot spot (42.0N 33.6E) and two more road spots: ZERO live
//     blades on painted road (shader ground truth, not the model), while with
//     `offRoad` off the same field DOES plant on the road (the reported bug,
//     reproduced); grass still lands on non-road grass, INCLUDING inside cells
//     that carry road corners (no 24 m square cut-outs); the verge is a ramp.
//  5. LIVE A/B — `window.__terrainGrass.setOffRoad()` flips the gate without a
//     reload and the field converges with no movement.
//  6. ROCK PEBBLES obey the same gate (0.5 m verge); a stub oracle without
//     `roadEdgeM` leaves every other family untouched.
//  7. WIRING — the terrain-VFX spine forwards `userData.roadCodes` to the oracle
//     at attach AND at the late-oracle replay, and roads survive park.

import { existsSync, openSync, readSync, closeSync } from "node:fs";
import * as THREE from "three";

import {
  createTerrainOracle, roadEdgeDistanceInCell, ROAD_PAINT,
  METERS_PER_LANDBLOCK,
} from "./scene3d/terrain_oracle.js";
import { createTerrainGrassProvider, resolveGrassConfig, GRASS_DEFAULTS } from "./scene3d/terrain_grass.js";
import { createPebbleField } from "./scene3d/terrain_rock.js";
import { grassOffRoadEnabled, _resetVfxFlags } from "./scene3d/vfx_flags.js";
import { FAM_GRASS, FAM_ROCK, familyForCode } from "./scene3d/terrain_families.js";
import {
  initTerrainVfx, terrainVfxNoteLandblockMesh, terrainVfxLandblockPark,
  lbKeyFromXY, _resetTerrainVfx,
} from "./scene3d/terrain_vfx.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---------------------------------------------------------------------------
// DAT reader — the same directory B-tree walk as test_terrain_round.mjs.
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

/** SurfaceTexture -> its top-mip Texture -> A8 pixels. */
function readMask(dat, surfaceId) {
  const s = dat.get(surfaceId);
  if (!s) return null;
  const n = s.readInt32LE(9); // u32 id, i32 unk, u8 unk, i32 count, u32 ids[count]
  const t = dat.get(s.readUInt32LE(13 + 4 * (n - 1)));
  const w = t.readInt32LE(8), h = t.readInt32LE(12), len = t.readInt32LE(20);
  return { w, h, px: t.subarray(24, 24 + len) };
}

// ---------------------------------------------------------------------------
// The shader's road coverage, ported (terrain.js TexMerge composite, slots 4..5).
// ---------------------------------------------------------------------------
// [rcode, SurfaceTexture] — src/lib.rs RETAIL_ROAD_MASKS, in alpha_index order.
const RETAIL_ROAD_MASKS = [[9, 0x0500168e], [10, 0x0500168c], [8, 0x0500168d]];

/** holtburger_dat::terrain_merge::road_code (TexMerge::GetRoadCode). */
function roadCode(bits) {
  switch (bits) {
    case 0xf: return null; // all_road
    case 0xe: return [6, 12];
    case 0xd: return [9, 12];
    case 0xb: return [9, 3];
    case 0x7: return [3, 6];
    case 0x0: return [0, 0];
    default: return [bits, 0];
  }
}

/**
 * Painted road weight 0..1 at cell fraction (fx east, fy north). Corners in
 * pcode bit order: bit 1 = SW, 2 = SE, 4 = NE, 8 = NW (pack_pcode).
 * Rotation = FindRoadAlpha's step count; the mask texel each rotation reads is
 * the table documented above terrain.js `rotateCellUv` (u = col, v = row, row 0
 * = north): rot0 (x, 1-y), rot1 (y, x), rot2 (1-x, y), rot3 (1-y, 1-x).
 * Splat noise is not modelled (it only moves the soft fringe, see the verge).
 */
function shaderRoadWeight(masks, sw, se, ne, nw, fx, fy) {
  const bits = (sw ? 1 : 0) | (se ? 2 : 0) | (ne ? 4 : 0) | (nw ? 8 : 0);
  if (bits === 0) return 0;
  const rc = roadCode(bits);
  if (rc === null) return 1; // all_road: the base tile is the road
  let baseW = 1;
  for (const r of rc) {
    if (!r) break;
    let hit = null;
    for (const m of masks) {
      let a = m.rcode;
      for (let j = 0; j < 4 && !hit; j += 1) {
        if (a === r) hit = { m, rot: j };
        a *= 2; if (a >= 16) a -= 15;
      }
      if (hit) break;
    }
    if (!hit) continue;
    let u, v;
    switch (hit.rot) {
      case 0: u = fx; v = 1 - fy; break;
      case 1: u = fy; v = fx; break;
      case 2: u = 1 - fx; v = fy; break;
      default: u = 1 - fy; v = 1 - fx; break;
    }
    const { w, px } = hit.m;
    const col = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
    const row = Math.min(w - 1, Math.max(0, Math.floor(v * w)));
    baseW *= px[row * w + col] / 255; // mix(road, merged, baseW) per slot
  }
  return 1 - baseW;
}

const PORTAL = process.env.HB_PORTAL_DAT || "/home/wbterminal/ac_base_dats/client_portal.dat";
const CELL = process.env.HB_CELL_DAT || "/home/wbterminal/ac_base_dats/client_cell_1.dat";

// ---------------------------------------------------------------------------
console.log("grass off the road (2026-10-07)");
console.log("===============================");
console.log("\n-- 1. ?grassOffRoad --");
{
  const withSearch = (search, fn) => {
    globalThis.window = { location: { search } };
    try { return fn(); } finally { delete globalThis.window; _resetVfxFlags(); }
  };
  check("DEFAULT-ON (no window, no flag)", grassOffRoadEnabled() === true);
  check("DEFAULT-ON (flag absent)", withSearch("?terrainGrass=on", grassOffRoadEnabled) === true);
  for (const v of ["off", "0", "false", "no", "OFF"]) {
    check(`?grassOffRoad=${v} -> off`, withSearch(`?grassOffRoad=${v}`, grassOffRoadEnabled) === false);
  }
  check("?grassOffRoad=on -> on", withSearch("?grassOffRoad=on", grassOffRoadEnabled) === true);
  check("resolveGrassConfig carries the flag (default on)",
    resolveGrassConfig({ blades: 1024 }).offRoad === true);
  check("resolveGrassConfig: ?grassOffRoad=off reaches the config",
    withSearch("?grassOffRoad=off", () => resolveGrassConfig({ blades: 1024 }).offRoad) === false);
  check("an explicit override wins", resolveGrassConfig({ blades: 1024, offRoad: false }).offRoad === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- 2. road-mask calibration (real client_portal.dat) --");
let MASKS = null;
if (!existsSync(PORTAL)) {
  console.log(`  real-DAT sections 2-4 not run: ${PORTAL} missing (set HB_PORTAL_DAT)`);
} else {
  const dat = openDat(PORTAL);
  MASKS = RETAIL_ROAD_MASKS.map(([rcode, id]) => ({ rcode, id, ...readMask(dat, id) }));
  dat.close();
  check("all three retail road masks decode as square A8", MASKS.every((m) => m.px && m.w === m.h && m.px.length === m.w * m.h),
    MASKS.map((m) => `${m.id.toString(16)}:${m.w}x${m.h}`).join(" "));
  const [edge, diag, corner] = MASKS;
  const mean = (m, c0, c1, r0, r1) => {
    let s = 0, n = 0;
    for (let r = Math.floor(r0 * m.w); r < Math.floor(r1 * m.w); r += 1) {
      for (let c = Math.floor(c0 * m.w); c < Math.floor(c1 * m.w); c += 1) { s += m.px[r * m.w + c]; n += 1; }
    }
    return s / n;
  };
  // Authored frame (row 0 = NORTH, col 0 = WEST) — what the shader's rotation
  // table and the model's skeletons both assume.
  check("rcode 9 (SW|NW): the lane is the WEST column strip",
    mean(edge, 0, 0.08, 0, 1) < 40 && mean(edge, 0.4, 1, 0, 1) > 250);
  check("rcode 10 (SE|NW): the lane runs NW -> SE",
    mean(diag, 0, 0.05, 0, 0.05) < 40 && mean(diag, 0.95, 1, 0.95, 1) < 40
    && mean(diag, 0.9, 1, 0, 0.1) > 250 && mean(diag, 0, 0.1, 0.9, 1) > 250);
  check("rcode 8 (NW): a disc at the NW corner only",
    mean(corner, 0, 0.05, 0, 0.05) < 40 && mean(corner, 0.3, 1, 0.3, 1) > 250);

  const M = 24 / edge.w;
  const extent = (m, dist, below) => {
    let mx = 0;
    for (let r = 0; r < m.w; r += 1) {
      for (let c = 0; c < m.w; c += 1) {
        if (m.px[r * m.w + c] < below) mx = Math.max(mx, dist((c + 0.5) * M, (r + 0.5) * M));
      }
    }
    return mx;
  };
  const SKEL = [
    ["edge", edge, (x) => x, ROAD_PAINT.edgeHalfWidthM],
    ["diagonal", diag, (x, y) => Math.abs(x - y) * Math.SQRT1_2, ROAD_PAINT.diagHalfWidthM],
    ["corner", corner, (x, y) => Math.hypot(x, y), ROAD_PAINT.cornerRadiusM],
  ];
  for (const [name, m, dist, half] of SKEL) {
    const e50 = extent(m, dist, 128);
    const e15 = extent(m, dist, 217);
    check(`${name}: every >= 50 % road texel is inside the model core (${e50.toFixed(2)} <= ${half} m)`, e50 <= half);
    check(`${name}: the core is tight (<= 0.2 m beyond the furthest 50 % texel)`, half - e50 <= 0.2, (half - e50).toFixed(2));
    check(`${name}: the 1.5 m grass verge covers the soft fringe (>= 15 % road reaches ${e15.toFixed(2)} m)`,
      e15 <= half + GRASS_DEFAULTS.roadVergeM);
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- 3. ground truth: the model contains the painted road (Holtburg 3x3, real DAT) --");
// Holtburg = 0xA9B4; the owner's screenshot (42.0N 33.6E) is at the north edge
// of 0xA9B3, so the 3x3 around 0xA9B4 covers it with a 48 m radius to spare.
const LBS = [];
let ORACLE = null;
if (MASKS && existsSync(CELL)) {
  const dat = openDat(CELL);
  for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
    const lb = readLandblock(dat, 0xa9 + dx, 0xb4 + dy);
    if (lb) LBS.push(lb);
  }
  dat.close();
  check("3x3 Holtburg landblocks read", LBS.length === 9);
  ORACLE = createTerrainOracle();
  for (const lb of LBS) {
    ORACLE.noteLandblock(lbKeyFromXY(lb.lbX, lb.lbY), { codes: lb.codes, heights: lb.heights, roads: lb.roads, lbX: lb.lbX, lbY: lb.lbY });
  }
  let roadVerts = 0;
  for (const lb of LBS) for (let i = 0; i < 81; i += 1) if (lb.roads[i]) roadVerts += 1;
  check("Holtburg actually has road vertices", roadVerts > 40, String(roadVerts));

  let painted = 0, missed = 0, coreArea = 0, clearlyNotRoad = 0, roadCells = 0, worst = null;
  const STEP = 0.5;
  const out = {};
  for (const lb of LBS) {
    const at = (x, y) => lb.roads[x * 9 + y];
    for (let cx = 0; cx < 8; cx += 1) for (let cy = 0; cy < 8; cy += 1) {
      const sw = at(cx, cy), se = at(cx + 1, cy), nw = at(cx, cy + 1), ne = at(cx + 1, cy + 1);
      if (!(sw || se || nw || ne)) continue;
      roadCells += 1;
      for (let a = STEP / 2; a < 24; a += STEP) for (let b = STEP / 2; b < 24; b += STEP) {
        const fx = a / 24, fy = b / 24;
        const wx = lb.lbX * METERS_PER_LANDBLOCK + cx * 24 + a;
        const wy = lb.lbY * METERS_PER_LANDBLOCK + cy * 24 + b;
        const truth = shaderRoadWeight(MASKS, sw, se, ne, nw, fx, fy);
        const s = ORACLE.sample(wx, wy, out);
        const model = s.roadEdgeM;
        if (truth >= 0.5) {
          painted += 1;
          if (!(model <= 0)) { missed += 1; if (!worst) worst = { lb: `${lb.lbX.toString(16)}${lb.lbY.toString(16)}`, cx, cy, a, b, truth, model }; }
        }
        if (model <= 0) { coreArea += 1; if (truth < 0.15) clearlyNotRoad += 1; }
      }
    }
  }
  check(`every painted-road point (>= 50 %) is inside the oracle's road (${painted} points over ${roadCells} road cells)`,
    painted > 1000 && missed === 0, `missed=${missed} ${JSON.stringify(worst)}`);
  const over = clearlyNotRoad / coreArea;
  console.log(`  [info] model road area / painted road area = ${(coreArea / painted).toFixed(2)}; `
    + `${(over * 100).toFixed(1)} % of the model's road is < 15 % painted (the cleared shoulder)`);
  check("the model does not wildly over-clear (< 35 % of its road is unpainted shoulder)", over < 0.35, over.toFixed(3));
  check("the pure helper and the oracle agree at a cell centre",
    (() => {
      const lb = LBS.find((l) => l.lbX === 0xa9 && l.lbY === 0xb4);
      const at = (x, y) => lb.roads[x * 9 + y];
      const s = ORACLE.sample(0xa9 * 192 + 2.5 * 24, 0xb4 * 192 + 6.5 * 24);
      return s.roadEdgeM === roadEdgeDistanceInCell(at(2, 6), at(3, 6), at(2, 7), at(3, 7), 0.5, 0.5);
    })());
} else if (MASKS) {
  console.log(`  real-DAT sections 3-4 not run: ${CELL} missing (set HB_CELL_DAT)`);
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. end to end: the real grass field over Holtburg --");
function lbOf(x, y) {
  const lbX = Math.floor(x / 192), lbY = Math.floor(y / 192);
  return LBS.find((l) => l.lbX === lbX && l.lbY === lbY) || null;
}
/** The shader's painted road weight at a world point (independent of the oracle). */
function paintedAt(x, y) {
  const lb = lbOf(x, y);
  if (!lb) return 0;
  const lx = x - lb.lbX * 192, ly = y - lb.lbY * 192;
  const cx = Math.min(7, Math.floor(lx / 24)), cy = Math.min(7, Math.floor(ly / 24));
  const at = (vx, vy) => lb.roads[vx * 9 + vy];
  return shaderRoadWeight(MASKS, at(cx, cy), at(cx + 1, cy), at(cx + 1, cy + 1), at(cx, cy + 1),
    lx / 24 - cx, ly / 24 - cy);
}
function cellHasRoad(x, y) {
  const lb = lbOf(x, y);
  if (!lb) return false;
  const cx = Math.min(7, Math.floor((x - lb.lbX * 192) / 24)), cy = Math.min(7, Math.floor((y - lb.lbY * 192) / 24));
  const at = (vx, vy) => lb.roads[vx * 9 + vy];
  return !!(at(cx, cy) || at(cx + 1, cy) || at(cx, cy + 1) || at(cx + 1, cy + 1));
}
function grassField(cx, cy, offRoad, blades = 60025) {
  const parent = new THREE.Group();
  const p = createTerrainGrassProvider({
    THREE, parent,
    config: { blades, density: 1, radiusM: 48, stomp: false, offRoad },
  });
  p.update(0.016, {
    scene3d: null, tSec: 0, dt: 0.016, hasPlayer: true, camera: null, quality: null,
    playerPos: { x: cx, y: cy, z: 60 }, oracle: ORACLE, trail: null,
  });
  return p;
}
function liveBlades(p) {
  const pool = p._pool;
  const m = pool.mesh.instanceMatrix.array;
  const out = [];
  for (let i = 0; i < pool.count; i += 1) if (pool.isLive(i)) out.push([i, m[i * 16 + 12], m[i * 16 + 13]]);
  return out;
}
if (ORACLE) {
  // AC map coords -> world metres: (coord * 10 + 1019.5) * 24.
  const SPOTS = [
    ["owner's screenshot, 42.0N 33.6E", (336 + 1019.5) * 24, (420 + 1019.5) * 24],
    ["Holtburg road vertex (2,6) of 0xA9B4", 0xa9 * 192 + 2 * 24, 0xb4 * 192 + 6 * 24],
    ["Holtburg west road, vertex (1,3) of 0xA9B4", 0xa9 * 192 + 1 * 24, 0xb4 * 192 + 3 * 24],
  ];
  for (const [name, x, y] of SPOTS) {
    const on = grassField(x, y, true);
    const off = grassField(x, y, false);
    const lOn = liveBlades(on), lOff = liveBlades(off);
    const onPainted = lOn.filter(([, bx, by]) => paintedAt(bx, by) >= 0.5).length;
    const offPainted = lOff.filter(([, bx, by]) => paintedAt(bx, by) >= 0.5).length;
    const onModel = lOn.filter(([, bx, by]) => ORACLE.sample(bx, by).roadEdgeM <= 0).length;
    const onFringe = lOn.filter(([, bx, by]) => paintedAt(bx, by) >= 0.15).length;
    console.log(`  [info] ${name}: live ${lOn.length} (off: ${lOff.length}); on painted road ${onPainted} (off: ${offPainted}); `
      + `in the >= 15 % fringe ${onFringe}; roadRejects ${on.stats().roadRejects}`);
    check(`${name}: the bug reproduces with the gate OFF (blades on the painted road)`, offPainted > 50, String(offPainted));
    check(`${name}: ZERO live blades on the painted road with the gate ON`, onPainted === 0, String(onPainted));
    check(`${name}: zero live blades inside the oracle's road`, onModel === 0, String(onModel));
    // Losses are confined to the road + its verge: every blade further out than
    // the verge survives (Holtburg's square is road-dense, so the TOTAL loss is
    // the road's share of the disc, not a quality signal on its own).
    const keptSet = new Set(lOn.map(([i]) => i));
    const farOff = lOff.filter(([, bx, by]) => ORACLE.sample(bx, by).roadEdgeM > GRASS_DEFAULTS.roadVergeM);
    const farLost = farOff.filter(([i]) => !keptSet.has(i)).length;
    check(`${name}: no blade is lost beyond the ${GRASS_DEFAULTS.roadVergeM} m verge`,
      farOff.length > 1000 && farLost === 0, `${farLost}/${farOff.length}`);
    // No 24 m square cut-outs: road cells keep most of their off-road grass.
    const inRoadCellsOff = lOff.filter(([, bx, by]) => cellHasRoad(bx, by) && paintedAt(bx, by) < 0.15);
    const kept = inRoadCellsOff.filter(([i]) => keptSet.has(i)).length;
    check(`${name}: grass still grows in ROAD CELLS off the lane (no 24 m square cut)`,
      inRoadCellsOff.length > 100 && kept / inRoadCellsOff.length > 0.5,
      `${kept}/${inRoadCellsOff.length}`);
    on.dispose(); off.dispose();
  }

  // Verge: survival vs signed distance from the road edge, screenshot spot.
  const [, x0, y0] = SPOTS[0];
  const on = grassField(x0, y0, true), off = grassField(x0, y0, false);
  const keep = new Set(liveBlades(on).map(([i]) => i));
  const bins = [[0, 0.5], [0.5, 1.0], [1.0, 1.5], [1.5, 6]].map(([lo, hi]) => ({ lo, hi, n: 0, k: 0 }));
  for (const [i, bx, by] of liveBlades(off)) {
    const e = ORACLE.sample(bx, by).roadEdgeM;
    for (const b of bins) if (e > b.lo && e <= b.hi) { b.n += 1; if (keep.has(i)) b.k += 1; }
  }
  const frac = bins.map((b) => (b.n ? b.k / b.n : NaN));
  console.log(`  [info] verge survival by metres past the road edge: ${bins.map((b, i) => `(${b.lo},${b.hi}] ${frac[i].toFixed(2)}`).join("  ")}`);
  check("the verge is a ramp: sparse at the edge, denser outward, full past 1.5 m",
    frac[0] < 0.35 && frac[0] < frac[1] && frac[1] < frac[2] && frac[3] === 1, frac.map((f) => f.toFixed(2)).join(" "));

  // -------------------------------------------------------------------------
  console.log("\n-- 5. live A/B without a reload --");
  const p = grassField(x0, y0, true, 4096);
  const onRoadNow = () => liveBlades(p).filter(([, bx, by]) => paintedAt(bx, by) >= 0.5).length;
  check("starts gated (no blade on the road)", onRoadNow() === 0 && p.stats().offRoad === true);
  check("setOffRoad(false) via the pool returns false", p._pool.setOffRoad(false) === false);
  for (let k = 0; k < 8; k += 1) p.update(0.016, { hasPlayer: true, tSec: 0, playerPos: { x: x0, y: y0, z: 60 }, oracle: ORACLE });
  const ungated = onRoadNow();
  check("…blades walk back onto the road with no movement (A/B works live)", ungated > 0 && p.stats().offRoad === false, String(ungated));
  p._pool.setOffRoad(true);
  for (let k = 0; k < 8; k += 1) p.update(0.016, { hasPlayer: true, tSec: 0, playerPos: { x: x0, y: y0, z: 60 }, oracle: ORACLE });
  check("setOffRoad(true) clears them again", onRoadNow() === 0);
  check("no full re-scatter was needed for either flip", p._pool.stats().fullRescatters === 1);
  p.dispose(); on.dispose(); off.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- 6. rock pebbles obey the gate; other families are untouched --");
{
  // A synthetic BarrenRock landblock (code 0 = FAM_ROCK) with a road along the
  // vertex column x = 4, through the REAL oracle.
  const LX = 0x40, LY = 0x40;
  const codes = new Uint8Array(81).fill(0);
  const roads = new Uint8Array(81);
  for (let row = 0; row < 9; row += 1) roads[4 * 9 + row] = 1;
  const oracle = createTerrainOracle();
  oracle.noteLandblock(lbKeyFromXY(LX, LY), { codes, heights: new Float32Array(81).fill(10), roads, lbX: LX, lbY: LY });
  check("code 0 is FAM_ROCK (the pebble family)", familyForCode(0) === FAM_ROCK);
  const cx = LX * 192 + 96, cy = LY * 192 + 96;
  const run = (offRoad) => {
    const f = createPebbleField({ THREE, oracle, count: 9000, radiusM: 40, offRoad });
    f.update(0.016, 0, cx, cy, 10, null);
    const m = f.pool.mesh.instanceMatrix.array;
    let live = 0, onRoad = 0;
    for (let i = 0; i < f.pool.count; i += 1) {
      if (!f.pool.isLive(i)) continue;
      live += 1;
      if (oracle.sample(m[i * 16 + 12], m[i * 16 + 13]).roadEdgeM <= 0) onRoad += 1;
    }
    const st = f.pool.stats();
    f.dispose();
    return { live, onRoad, st };
  };
  const off = run(false), on = run(true), dflt = (() => {
    const f = createPebbleField({ THREE, oracle, count: 9000, radiusM: 40 });
    const st = f.pool.stats(); f.dispose(); return st;
  })();
  check("pebbles default to the flag (ON) with a 0.5 m verge", dflt.offRoad === true && dflt.offRoadVergeM === 0.5);
  check("gate OFF: pebbles litter the road (the same bug as grass)", off.onRoad > 20, String(off.onRoad));
  check("gate ON: zero pebbles on the road", on.onRoad === 0 && on.st.roadRejects > 0, `${on.onRoad} rejects=${on.st.roadRejects}`);
  check("gate ON: the rest of the rock field is intact", on.live > 0.75 * off.live, `${on.live}/${off.live}`);
  check("grass is not FAM_ROCK and vice versa (gates stay per-pool)", familyForCode(1) === FAM_GRASS);
}

// ---------------------------------------------------------------------------
console.log("\n-- 7. spine wiring: userData.roadCodes -> oracle, attach + replay + park --");
{
  class G { constructor() { this.children = []; this.parent = null; this.visible = true; }
    add(c) { this.children.push(c); c.parent = this; return this; }
    remove(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parent = null; } return this; } }
  _resetTerrainVfx();
  _resetVfxFlags();
  const worldRoot = new G(), terrainGroup = new G();
  worldRoot.add(terrainGroup);
  const scene3d = { terrainGroup, quality: { flags: { terrainTrail: false } }, frameTime: { tsSec: 0, dt: 0 }, landblockLru: { scene3d: {} } };
  globalThis.window = { location: { search: "" }, liveScene3d: scene3d };
  const surface = initTerrainVfx({ THREE: { Group: G }, scene3d, parent: worldRoot });
  // The LB mesh exactly as terrain.js stamps it (roadCodes in the userData literal).
  const roads = new Uint8Array(81);
  for (let row = 0; row < 9; row += 1) roads[3 * 9 + row] = 1;
  const mkMesh = (lbX, lbY) => ({
    name: "lb", userData: {
      lbX, lbY, lbId: ((lbX << 24) | (lbY << 16) | 0xffff) >>> 0,
      terrainCodes: new Uint8Array(81).fill(1), heights: new Float32Array(81), roadCodes: roads,
    },
  });
  // Noted BEFORE the oracle exists: the late-oracle replay must carry roads.
  const m1 = mkMesh(5, 6);
  terrainGroup.add(m1);
  terrainVfxNoteLandblockMesh(scene3d, m1);
  const oracle = await surface.ensureOracle();
  check("the oracle loaded", !!oracle);
  const roadX = 5 * 192 + 3 * 24 + 0.5, offX = 5 * 192 + 6 * 24, y = 6 * 192 + 100;
  check("late-oracle REPLAY carries the road", oracle.sample(roadX, y).roadEdgeM < 0 && oracle.sample(offX, y).roadEdgeM > 0);
  // Noted AFTER: the attach path.
  const m2 = mkMesh(7, 6);
  terrainGroup.add(m2);
  terrainVfxNoteLandblockMesh(scene3d, m2);
  const roadX2 = 7 * 192 + 3 * 24 - 0.5;
  check("ATTACH carries the road", oracle.sample(roadX2, y).roadEdgeM < 0);
  // Park: the mesh leaves terrainGroup, the hook fires, roads keep answering.
  terrainGroup.remove(m2);
  terrainVfxLandblockPark(lbKeyFromXY(7, 6));
  check("PARK: the road survives the mesh leaving terrainGroup", oracle.sample(roadX2, y).roadEdgeM < 0);
  _resetTerrainVfx();
  delete globalThis.window;
  _resetVfxFlags();
}

console.log(`\ngrass off-road: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
