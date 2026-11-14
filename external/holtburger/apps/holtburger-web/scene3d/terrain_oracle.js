// Terrain-VFX Wave 0A — the terrain oracle: terrain code + ground height at
// world (x, y).
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §2.1.
//
// This generalises the proven sampler in `scene3d/audio/ambient_runtime.js`
// (`_sampleTerrainVertex`) rather than inventing a new one, and adds the three
// things a VFX consumer needs that an audio consumer does not:
//
//   1. EXACT ground height + surface normal on the retail split-diagonal
//      triangle — a JS port of `holtburger_dat::terrain_subdiv::
//      {cell_swto_ne_cut, triangle_height_in_cell, triangle_grad_in_cell}`,
//      i.e. the same maths `SessionHandle.terrainHeightAt()` runs in wasm.
//      The wasm fn stays the reference; `test_terrain_oracle.mjs` +
//      `oracleSelfTest()` validate the port against it.
//
//   2. PARK SURVIVAL. `landblock_lru.js::park()` REMOVES the terrain mesh from
//      `terrainGroup` (stashing it in `p.terrain`) and deliberately does NOT
//      fire `_onEvictLandblock`. Park is default-ON and REPLACES eviction once
//      the LRU is at cap, so at cap most of the ring is parked and any sampler
//      that walks `terrainGroup.children` returns null for it. `ambient_runtime`
//      tolerates that (audio just goes quiet); a VFX oracle must not. So the
//      oracle owns its own cache, populated once at bake, retained across
//      park/unpark, cleared ONLY on evict/rebake via `invalidate()`.
//      NEVER scan the scene graph to decide whether an LB exists.
//      Budget: 2 x Uint8Array(81) + Float32Array(81) ≈ 486 B per LB; at the
//      256-slot LRU cap ≈ 125 KB.
//
//   3. `cornerCodes` — the four cell-corner codes, so a family can feather at
//      a type boundary instead of showing 24 m square patches (plan §8 risk 2:
//      the GPU bilinear-blends the four corner textures, so a nearest-vertex
//      code sample and the rendered pixel actively disagree near cell edges).
//
//   4. ROADS (2026-10-07, owner report off a Holtburg video take: "see the
//      grass on the road. can we make it so its not on the road"). A retail
//      road is NOT a terrain code — it is 2 extra bits on the vertex word, and
//      a road vertex keeps its Grassland/LushGrass code underneath. So every
//      code-keyed scatter (grass, pebbles) planted straight through the town
//      roads. The oracle now caches the per-vertex road flags too (the same
//      `userData.roadCodes` terrain.js already feeds to `uVertexTypes.G`) and
//      `sample()` reports `cornerRoads` plus `roadEdgeM`: the signed distance
//      to the edge of the road the GROUND SHADER PAINTS at that point. See
//      `roadEdgeDistanceInCell` for the model and `ROAD_PAINT` for where its
//      numbers come from (measured off the retail road masks in portal.dat).
//
// THREE-free on purpose (plan §6). The only import is `landblock_lru.js`,
// which is itself import-free, so this file loads in node unaided.

import { lbKeyFromXY, lbKeyOf } from "./landblock_lru.js";
import {
  TERRAIN_CODE_TO_FAMILY,
  FAM_COUNT,
  FAM_WATER,
  familyForCode,
} from "./terrain_families.js";
import { waterFlowTable, waterFlowEntry } from "./terrain_water_flow.js";

// ----- constants (verbatim from ambient_runtime.js / the wasm side) --
export const VERTEX_GRID = 9;
export const VERTEX_SPACING_M = 24.0;
export const METERS_PER_LANDBLOCK = 192.0;
const GRID_CELLS = VERTEX_GRID - 1;          // 8
const VERTEX_COUNT = VERTEX_GRID * VERTEX_GRID; // 81

// ----- shore classification constants (Item 6A) ----------------------
export const SEA_WATER_CODES = Object.freeze([18, 19, 20]);
export const OCEAN_SHORE_MIN_Z = -0.06;
export const OCEAN_SHORE_MAX_Z = 2.30;
export const OCEAN_SHORE_MIN_NZ = 0.80;
export const RIVER_SHORE_MIN_ABOVE_WATER_M = -0.06;
export const RIVER_SHORE_MAX_ABOVE_WATER_M = 2.20;
export const RIVER_SHORE_MIN_NZ = 0.76;
export const SHORE_ROAD_CLEARANCE_M = 0.5;
export const RIVER_STANDING_FLOW_MIN = 0.03;

/** True for ocean water codes: WaterShallowSea (18), WaterShallowStillSea (19), WaterDeepSea (20). */
export function isSeaWaterCode(code) {
  return code === 18 || code === 19 || code === 20;
}

/** True for any terrain code that paints water (codes 16..20, FauxWaterRunning 22, or FAM_WATER). */
function isAnyWaterCode(code) {
  return (code >= 16 && code <= 20) || code === 22 || familyForCode(code) === FAM_WATER;
}

/**
 * Sample baked water flow velocity `(vx, vy, speed)` at world `(wx, wy)` from
 * `data/water_flow.bin` (or an explicit parsed flow table). Returns null when no
 * flow table or entry exists for the landblock.
 */
export function sampleWaterFlowTableAt(wx, wy, out, tableOverride) {
  if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
  const tbl = tableOverride !== undefined ? tableOverride : waterFlowTable();
  if (!tbl) return null;
  const lbX = Math.floor(wx / METERS_PER_LANDBLOCK);
  const lbY = Math.floor(wy / METERS_PER_LANDBLOCK);
  if (lbX < 0 || lbX > 255 || lbY < 0 || lbY > 255) return null;
  const entry = waterFlowEntry(tbl, ((lbX & 0xff) << 8) | (lbY & 0xff));
  if (!entry) return null;
  const localX = wx - lbX * METERS_PER_LANDBLOCK;
  const localY = wy - lbY * METERS_PER_LANDBLOCK;
  const cellXf = Math.min(Math.max(localX / VERTEX_SPACING_M, 0), GRID_CELLS);
  const cellYf = Math.min(Math.max(localY / VERTEX_SPACING_M, 0), GRID_CELLS);
  const cx0 = Math.floor(cellXf);
  const cy0 = Math.floor(cellYf);
  const cx1 = Math.min(cx0 + 1, GRID_CELLS);
  const cy1 = Math.min(cy0 + 1, GRID_CELLS);
  const fx = cellXf - cx0;
  const fy = cellYf - cy0;
  const scale = tbl.fullScaleUnits / 127.0;
  const i00 = (cx0 * VERTEX_GRID + cy0) * 3;
  const i10 = (cx1 * VERTEX_GRID + cy0) * 3;
  const i01 = (cx0 * VERTEX_GRID + cy1) * 3;
  const i11 = (cx1 * VERTEX_GRID + cy1) * 3;
  const e00 = (entry[i00] - 128) * scale;
  const n00 = (entry[i00 + 1] - 128) * scale;
  const e10 = (entry[i10] - 128) * scale;
  const n10 = (entry[i10 + 1] - 128) * scale;
  const e01 = (entry[i01] - 128) * scale;
  const n01 = (entry[i01 + 1] - 128) * scale;
  const e11 = (entry[i11] - 128) * scale;
  const n11 = (entry[i11 + 1] - 128) * scale;
  const vx = (e00 * (1 - fx) + e10 * fx) * (1 - fy) + (e01 * (1 - fx) + e11 * fx) * fy;
  const vy = (n00 * (1 - fx) + n10 * fx) * (1 - fy) + (n01 * (1 - fx) + n11 * fx) * fy;
  const speed = Math.hypot(vx, vy);
  const r = out || {};
  r.vx = vx;
  r.vy = vy;
  r.speed = speed;
  return r;
}

// How many cache hits between refreshes of the "which LBs are still attached
// to terrainGroup" set that backs `stats().parkedHits`. Deliberately a HIT
// COUNTER, not a clock: no `Date.now()`, no `performance.now()`, so the
// oracle stays deterministic and node-testable (plan §5.5).
const PARK_RESCAN_EVERY_HITS = 2048;

/**
 * Retail per-cell diagonal split. JS port of
 * `crates/holtburger-dat/src/terrain_subdiv.rs::cell_swto_ne_cut`, which is
 * verbatim acclient.c `CLandBlockStruct::ConstructPolygons` (@531D10) and
 * matches ACE `LandblockStruct.ConstructPolygons`.
 *
 * ⚠ 32-bit UNSIGNED wraparound throughout. `Math.imul` gives the exact low 32
 * bits of each product and `>>> 0` re-normalises; widening to a double would
 * lose the wrap and silently flip diagonals on large global cell coords.
 *
 * @param {number} globalCellX landblock byte * 8 + cell index (0..2047)
 * @param {number} globalCellY same, north
 * @returns {boolean} true = SW↔NE diagonal, false = NW↔SE
 */
export function cellSwToNeCut(globalCellX, globalCellY) {
  const gx = globalCellX >>> 0;
  const gy = globalCellY >>> 0;
  const inner = (Math.imul(214614067, gx) + 1813693831) >>> 0;
  const v8 = (Math.imul(gy, inner) - Math.imul(1109124029, gx) - 1369149221) >>> 0;
  // 2.3283064e-10 ≈ 1/2^32 — normalise the u32 to [0, 1) and test >= 0.5.
  return v8 * 2.3283064e-10 >= 0.5;
}

/**
 * Height inside one 24 m cell on the SAME triangulation the render mesh uses.
 * Port of `terrain_subdiv.rs::triangle_height_in_cell`.
 * Corners: `z00`=SW, `z10`=SE, `z01`=NW, `z11`=NE; `fx`/`fy` ∈ [0,1].
 */
export function triangleHeightInCell(z00, z10, z01, z11, fx, fy, swNeCut) {
  if (swNeCut) {
    // SW↔NE diagonal (z00↔z11): split on fx == fy.
    if (fx >= fy) {
      // lower-right triangle: SW, SE, NE.
      return z00 + (z10 - z00) * fx + (z11 - z10) * fy;
    }
    // upper-left triangle: SW, NE, NW.
    return z00 + (z11 - z01) * fx + (z01 - z00) * fy;
  }
  // NW↔SE diagonal (z01↔z10): split on fx + fy == 1.
  if (fx + fy <= 1.0) {
    // lower-left triangle: SW, SE, NW.
    return z00 + (z10 - z00) * fx + (z01 - z00) * fy;
  }
  // upper-right triangle: NE, NW, SE.
  return z11 + (z01 - z11) * (1.0 - fx) + (z10 - z11) * (1.0 - fy);
}

/**
 * Per-cell gradient `(dz/dfx, dz/dfy)` in CELL-FRACTION units on the same
 * triangle as `triangleHeightInCell`. Port of
 * `terrain_subdiv.rs::triangle_grad_in_cell`. Constant within a triangle
 * (planar), so this is the exact face normal, not a bilinear smear.
 *
 * 2026-10-24 — optional `out`: pass a reusable 2-slot plain Array (or a
 * Float64Array; NOT a Float32Array, which would round the doubles) and the
 * gradient is written into `out[0]`, `out[1]` and `out` is returned, so a hot
 * caller (`sample()`, hence the per-frame sand-devil walk) allocates nothing.
 * Without `out` a new `[dx, dy]` is returned, exactly as before. The same
 * four subtractions either way, so both forms are bit-identical.
 * @param {number[]|Float64Array} [out]
 * @returns {[number, number]}
 */
export function triangleGradInCell(z00, z10, z01, z11, fx, fy, swNeCut, out) {
  let gx;
  let gy;
  if (swNeCut) {
    if (fx >= fy) { gx = z10 - z00; gy = z11 - z10; } // lower-right: SW, SE, NE
    else { gx = z11 - z01; gy = z01 - z00; }          // upper-left:  SW, NE, NW
  } else if (fx + fy <= 1.0) {
    gx = z10 - z00; gy = z01 - z00;                   // lower-left: SW, SE, NW
  } else {
    gx = z11 - z01; gy = z11 - z10;                   // upper-right: NE, NW, SE
  }
  if (out) {
    out[0] = gx;
    out[1] = gy;
    return out;
  }
  return [gx, gy];
}

// ----- roads (2026-10-07) ---------------------------------------------

/**
 * Half-widths of the road the ground shader paints, in metres from the road
 * SKELETON of one 24 m cell. 2026-10-07, measured off the three retail road
 * alpha masks the default TexMerge path composites (`?roadSlots`, default on —
 * `RETAIL_ROAD_MASKS` in src/lib.rs: rcode 9 = 0x0500168E edge lane, rcode 10 =
 * 0x0500168C diagonal, rcode 8 = 0x0500168D corner), 512² A8 in
 * client_portal.dat. Each value is the LARGEST distance from the skeleton of
 * any texel that is >= 50 % road (mask byte < 128), plus ~0.1 m for the GPU's
 * 256² resample + bilinear filter, so the core contains every painted road
 * texel whatever the mask's rotation:
 *   edge   p50 3.47 m, max 4.15 m  (a hand-drawn lane, 2.8..4.2 m wide)
 *   diag   max 4.77 m              (an S-curve: ~7 m wide, meandering ±1.2 m
 *                                   about the cell diagonal)
 *   corner max 3.49 m              (a quarter disc)
 * The masks' soft fringe (byte < 217, i.e. >= 15 % road — the band the
 * shader's splat noise can push to 50 %) reaches 4.99 / 5.87 / 4.99 m, which is
 * what a consumer's verge margin should cover. `test_terrain_grass_offroad.mjs`
 * re-measures all of this from the real DAT and fails if these drift.
 *
 * The retail lane is ~7-8 m across because BOTH cells sharing a road edge paint
 * their own ~3.5 m half of it.
 */
export const ROAD_PAINT = Object.freeze({
  edgeHalfWidthM: 4.3,
  diagHalfWidthM: 4.9,
  cornerRadiusM: 3.6,
});

/**
 * Signed distance (metres) from a point in a 24 m cell to the EDGE of the road
 * the ground shader paints there: < 0 inside the road, > 0 outside, `Infinity`
 * when no corner of the cell is road.
 *
 * The decomposition is retail's, not a heuristic: `TexMerge::GetRoadCode` →
 * `holtburger_dat::terrain_merge::road_code` turns the cell's 4 corner road bits
 * into at most two road overlays, and `FindRoadAlpha` rotates one of three
 * masks onto each:
 *   1 road corner              → corner mask (quarter disc at that corner)
 *   2 ADJACENT road corners    → edge mask (lane along that cell edge)
 *   2 OPPOSITE road corners    → diagonal mask (lane along that diagonal)
 *   3 road corners (0x7/B/D/E) → TWO edge masks meeting at the corner opposite
 *                                the missing one — never the diagonal
 *   4 road corners (0xF)       → `all_road`: the base tile IS road (layer 32),
 *                                the whole cell is road
 * Each overlay is then modelled as distance-to-skeleton minus its `ROAD_PAINT`
 * half-width. Inside the cell the projection onto an edge or diagonal always
 * lands on the segment, so the perpendicular distance IS the segment distance.
 *
 * The analytic fallback lane (`?roadSlots=off` / no TexMerge) is narrower
 * (2.5 m + 1 m soft) and fully contained in this, so the model is safe there too.
 *
 * Corner order is the oracle's `cornerCodes` order: SW, SE, NW, NE. Any
 * non-zero value is road (the wasm `roadCodes` are the raw 2-bit field).
 *
 * @param {number} r00 SW road flag
 * @param {number} r10 SE road flag
 * @param {number} r01 NW road flag
 * @param {number} r11 NE road flag
 * @param {number} fx  cell fraction east,  0..1
 * @param {number} fy  cell fraction north, 0..1
 * @returns {number}
 */
export function roadEdgeDistanceInCell(r00, r10, r01, r11, fx, fy) {
  const sw = r00 ? 1 : 0;
  const se = r10 ? 1 : 0;
  const nw = r01 ? 1 : 0;
  const ne = r11 ? 1 : 0;
  const n = sw + se + nw + ne;
  if (n === 0) return Infinity;
  if (n === 4) return -VERTEX_SPACING_M;
  const px = fx * VERTEX_SPACING_M;
  const py = fy * VERTEX_SPACING_M;
  const qx = VERTEX_SPACING_M - px;
  const qy = VERTEX_SPACING_M - py;
  const edge = ROAD_PAINT.edgeHalfWidthM;
  if (n === 3) {
    // Two edge lanes through the corner OPPOSITE the missing one.
    if (!sw) return Math.min(qx, qy) - edge;  // middle NE: east + north edges
    if (!se) return Math.min(px, qy) - edge;  // middle NW: west + north edges
    if (!nw) return Math.min(qx, py) - edge;  // middle SE: east + south edges
    return Math.min(px, py) - edge;           // middle SW: west + south edges
  }
  if (n === 2) {
    if (sw && se) return py - edge;           // south edge
    if (nw && ne) return qy - edge;           // north edge
    if (sw && nw) return px - edge;           // west edge
    if (se && ne) return qx - edge;           // east edge
    // Opposite corners: the diagonal lane.
    const d = (sw && ne)
      ? Math.abs(px - py) * Math.SQRT1_2                    // SW <-> NE
      : Math.abs(px + py - VERTEX_SPACING_M) * Math.SQRT1_2; // SE <-> NW
    return d - ROAD_PAINT.diagHalfWidthM;
  }
  // One road corner: a quarter disc.
  let d;
  if (sw) d = Math.sqrt(px * px + py * py);
  else if (se) d = Math.sqrt(qx * qx + py * py);
  else if (nw) d = Math.sqrt(px * px + qy * qy);
  else d = Math.sqrt(qx * qx + qy * qy);
  return d - ROAD_PAINT.cornerRadiusM;
}

// ----- helpers ------------------------------------------------------

function clampInt(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Normalise whatever a caller hands us into an own Uint8Array(81). A copy is
 * mandatory: the mesh's `userData.terrainCodes` is disposed with the mesh on
 * evict, and the whole point of the cache is to outlive the mesh.
 */
function copyCodes(src) {
  if (!src || src.length < VERTEX_COUNT) return null;
  const out = new Uint8Array(VERTEX_COUNT);
  for (let i = 0; i < VERTEX_COUNT; i += 1) out[i] = src[i] & 0xff;
  return out;
}

function copyHeights(src) {
  if (!src || src.length < VERTEX_COUNT) return null;
  const out = new Float32Array(VERTEX_COUNT);
  for (let i = 0; i < VERTEX_COUNT; i += 1) out[i] = src[i];
  return out;
}

/**
 * 2026-10-07 — per-vertex road flags, normalised to 0/1 (any non-zero 2-bit
 * road field is road — the same test `pack_pcode` and the shader's
 * `vertexRoadAt` apply). A copy for the same reason as `copyCodes`. null when
 * the caller had none (a mesh from before roads reached the oracle): such an LB
 * simply reports no roads.
 */
function copyRoads(src) {
  if (!src || src.length < VERTEX_COUNT) return null;
  const out = new Uint8Array(VERTEX_COUNT);
  for (let i = 0; i < VERTEX_COUNT; i += 1) out[i] = src[i] ? 1 : 0;
  return out;
}

function normalizeFlowSample(raw, out) {
  if (!raw) return null;
  let vx = NaN;
  let vy = NaN;
  if (Array.isArray(raw) || ArrayBuffer.isView(raw)) {
    vx = +raw[0];
    vy = +raw[1];
  } else if (typeof raw === "object") {
    vx = Number.isFinite(+raw.vx) ? +raw.vx : +raw.x;
    vy = Number.isFinite(+raw.vy) ? +raw.vy : +raw.y;
  }
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;
  const r = out || {};
  r.vx = vx;
  r.vy = vy;
  r.speed = Math.hypot(vx, vy);
  return r;
}

function lookupLatticeVertex(lookupFn, gx, gy, out) {
  if (gx < 0 || gx > 2048 || gy < 0 || gy > 4912) return null;
  const lbX0 = Math.min(gx >> 3, 255);
  const col0 = gx - (lbX0 << 3);
  const lbY0 = Math.min(gy >> 3, 614);
  const row0 = gy - (lbY0 << 3);
  let e = lookupFn(lbKeyFromXY(lbX0, lbY0));
  let col = col0;
  let row = row0;
  if ((!e || (typeof e.lbY === "number" && e.lbY !== lbY0)) && col0 === 0 && lbX0 > 0) {
    const eWest = lookupFn(lbKeyFromXY(lbX0 - 1, lbY0));
    if (eWest && (typeof eWest.lbY !== "number" || eWest.lbY === lbY0)) {
      e = eWest;
      col = 8;
    }
  }
  if ((!e || (typeof e.lbY === "number" && e.lbY !== lbY0)) && row0 === 0 && lbY0 > 0) {
    const eSouth = lookupFn(lbKeyFromXY(lbX0, lbY0 - 1));
    if (eSouth && (typeof eSouth.lbY !== "number" || eSouth.lbY === lbY0 - 1)) {
      e = eSouth;
      row = 8;
    }
  }
  if ((!e || (typeof e.lbY === "number" && e.lbY !== lbY0 && e.lbY !== lbY0 - 1)) && col0 === 0 && row0 === 0 && lbX0 > 0 && lbY0 > 0) {
    const eSW = lookupFn(lbKeyFromXY(lbX0 - 1, lbY0 - 1));
    if (eSW && (typeof eSW.lbY !== "number" || eSW.lbY === lbY0 - 1)) {
      e = eSW;
      col = 8;
      row = 8;
    }
  }
  if (!e || !e.codes) return null;
  const idx = col * VERTEX_GRID + row;
  out.code = e.codes[idx] & 0x1f;
  out.hasHeight = !!(e.heights && idx < e.heights.length);
  out.height = out.hasHeight ? e.heights[idx] : NaN;
  return out;
}

function evalOceanShoreInternal(sampleFn, lookupFn, flowFn, wx, wy, sampleScratch, vertScratch, flowScratch, out) {
  const s = sampleFn(wx, wy, sampleScratch);
  if (!s || !s.hasHeight || !s.normal) return null;
  if (isAnyWaterCode(s.code)) return null;
  if (!(s.height >= OCEAN_SHORE_MIN_Z && s.height <= OCEAN_SHORE_MAX_Z)) return null;
  if (!(s.normal.z >= OCEAN_SHORE_MIN_NZ)) return null;
  if (s.roadEdgeM <= SHORE_ROAD_CLEARANCE_M) return null;

  const localX = wx - s.lbX * METERS_PER_LANDBLOCK;
  const localY = wy - s.lbY * METERS_PER_LANDBLOCK;
  const cellXf = Math.min(Math.max(localX / VERTEX_SPACING_M, 0), GRID_CELLS);
  const cellYf = Math.min(Math.max(localY / VERTEX_SPACING_M, 0), GRID_CELLS);
  const cx0 = Math.min(Math.floor(cellXf), GRID_CELLS - 1);
  const cy0 = Math.min(Math.floor(cellYf), GRID_CELLS - 1);
  const fx = cellXf - cx0;
  const fy = cellYf - cy0;
  const cc = s.cornerCodes;
  const wc00 = cc && isAnyWaterCode(cc[0]) ? 1 : 0;
  const wc10 = cc && isAnyWaterCode(cc[1]) ? 1 : 0;
  const wc01 = cc && isAnyWaterCode(cc[2]) ? 1 : 0;
  const wc11 = cc && isAnyWaterCode(cc[3]) ? 1 : 0;
  const waterW = (wc00 * (1 - fx) + wc10 * fx) * (1 - fy) + (wc01 * (1 - fx) + wc11 * fx) * fy;
  if (waterW > 0.48) return null;

  const gx0 = s.lbX * GRID_CELLS + cx0;
  const gy0 = s.lbY * GRID_CELLS + cy0;
  let seaCount = 0;
  let runningFreshCount = 0;
  let toSeaX = 0;
  let toSeaY = 0;
  for (let gx = gx0 - 1; gx <= gx0 + 2; gx += 1) {
    for (let gy = gy0 - 1; gy <= gy0 + 2; gy += 1) {
      const v = lookupLatticeVertex(lookupFn, gx, gy, vertScratch);
      if (!v) continue;
      if (v.code === 16) {
        runningFreshCount += 1;
        continue;
      }
      const vx = gx * VERTEX_SPACING_M;
      const vy = gy * VERTEX_SPACING_M;
      let isCoastalSea = isSeaWaterCode(v.code);
      if (!isCoastalSea && v.code === 17 && v.hasHeight && v.height <= 0.08) {
        const fv = flowFn ? flowFn(vx, vy, flowScratch) : null;
        if (!(fv && fv.speed >= RIVER_STANDING_FLOW_MIN)) {
          isCoastalSea = true;
        } else {
          runningFreshCount += 1;
        }
      }
      if (!isCoastalSea) continue;
      seaCount += 1;
      const dx = vx - wx;
      const dy = vy - wy;
      const w = 1.0 / Math.max(9.0, dx * dx + dy * dy);
      toSeaX += dx * w;
      toSeaY += dy * w;
    }
  }
  if (seaCount === 0 || (runningFreshCount > 0 && seaCount <= runningFreshCount)) return null;

  toSeaX += -s.normal.x * 0.05;
  toSeaY += -s.normal.y * 0.05;
  const seaLen = Math.hypot(toSeaX, toSeaY);
  let tx = 1.0;
  let ty = 0.0;
  if (seaLen > 1e-6) {
    tx = -toSeaY / seaLen;
    ty = toSeaX / seaLen;
  }
  // Swash & wrack proximity bands (0..1): higher near the high-tide swash line.
  const hNorm = (s.height - OCEAN_SHORE_MIN_Z) / (OCEAN_SHORE_MAX_Z - OCEAN_SHORE_MIN_Z);
  const swash = Math.max(0, Math.min(1, 1.0 - Math.abs(hNorm - 0.22) * 2.1));
  const wrack = Math.max(0, Math.min(1, 1.0 - Math.abs(hNorm - 0.36) * 1.8));

  const r = out || {};
  r.isOceanShore = true;
  r.height = s.height;
  r.code = s.code;
  r.nx = s.normal.x;
  r.ny = s.normal.y;
  r.nz = s.normal.z;
  r.tx = tx;
  r.ty = ty;
  r.waterW = waterW;
  r.swash = swash;
  r.wrack = wrack;
  return r;
}

function evalRiverShoreInternal(
  sampleFn,
  lookupFn,
  flowFn,
  wx,
  wy,
  sampleScratch,
  vertScratch,
  oceanScratch,
  flowScratch,
  out,
) {
  const s = sampleFn(wx, wy, sampleScratch);
  if (!s || !s.hasHeight || !s.normal) return null;
  if (isAnyWaterCode(s.code)) return null;
  if (!(s.normal.z >= RIVER_SHORE_MIN_NZ)) return null;
  if (s.roadEdgeM <= SHORE_ROAD_CLEARANCE_M) return null;
  const cc = s.cornerCodes;
  if (cc && (isSeaWaterCode(cc[0]) || isSeaWaterCode(cc[1]) || isSeaWaterCode(cc[2]) || isSeaWaterCode(cc[3]))) {
    return null;
  }
  if (evalOceanShoreInternal(sampleFn, lookupFn, flowFn, wx, wy, sampleScratch, vertScratch, flowScratch, oceanScratch) !== null) {
    return null;
  }

  const localX = wx - s.lbX * METERS_PER_LANDBLOCK;
  const localY = wy - s.lbY * METERS_PER_LANDBLOCK;
  const cellXf = Math.min(Math.max(localX / VERTEX_SPACING_M, 0), GRID_CELLS);
  const cellYf = Math.min(Math.max(localY / VERTEX_SPACING_M, 0), GRID_CELLS);
  const cx0 = Math.min(Math.floor(cellXf), GRID_CELLS - 1);
  const cy0 = Math.min(Math.floor(cellYf), GRID_CELLS - 1);
  const fx = cellXf - cx0;
  const fy = cellYf - cy0;
  const wc00 = cc && isAnyWaterCode(cc[0]) ? 1 : 0;
  const wc10 = cc && isAnyWaterCode(cc[1]) ? 1 : 0;
  const wc01 = cc && isAnyWaterCode(cc[2]) ? 1 : 0;
  const wc11 = cc && isAnyWaterCode(cc[3]) ? 1 : 0;
  const waterW = (wc00 * (1 - fx) + wc10 * fx) * (1 - fy) + (wc01 * (1 - fx) + wc11 * fx) * fy;
  if (waterW > 0.48) return null;

  const gx0 = s.lbX * GRID_CELLS + cx0;
  const gy0 = s.lbY * GRID_CELLS + cy0;
  let riverCount = 0;
  let nearestLowD2 = Infinity;
  let nearestLowZ = NaN;
  let nearestAnyD2 = Infinity;
  let nearestAnyZ = NaN;
  let toRiverX = 0;
  let toRiverY = 0;
  let flowSumX = 0;
  let flowSumY = 0;
  let flowWeightSum = 0;

  // Pass 1: find adjacent river vertices, shoreline normal, flow sum, and nearest water Z.
  for (let gx = gx0 - 1; gx <= gx0 + 2; gx += 1) {
    for (let gy = gy0 - 1; gy <= gy0 + 2; gy += 1) {
      const v = lookupLatticeVertex(lookupFn, gx, gy, vertScratch);
      if (!v) continue;
      const vx = gx * VERTEX_SPACING_M;
      const vy = gy * VERTEX_SPACING_M;
      let isRiver = v.code === 16;
      let fv = null;
      if (isRiver || v.code === 17) {
        fv = flowFn ? flowFn(vx, vy, flowScratch) : null;
        if (!isRiver && fv && fv.speed >= RIVER_STANDING_FLOW_MIN) {
          isRiver = true;
        }
      }
      if (!isRiver || !v.hasHeight || !Number.isFinite(v.height)) continue;

      riverCount += 1;
      const dx = vx - wx;
      const dy = vy - wy;
      const d2 = dx * dx + dy * dy;
      const w = 1.0 / Math.max(9.0, d2);
      toRiverX += dx * w;
      toRiverY += dy * w;

      if (d2 < nearestAnyD2) {
        nearestAnyD2 = d2;
        nearestAnyZ = v.height;
      }
      if (v.height <= s.height + 0.25 && d2 < nearestLowD2) {
        nearestLowD2 = d2;
        nearestLowZ = v.height;
      }
      if (fv && fv.speed > 1e-4) {
        flowSumX += fv.vx * w;
        flowSumY += fv.vy * w;
        flowWeightSum += w;
      }
    }
  }
  if (riverCount === 0) return null;

  const refWaterZ = Number.isFinite(nearestLowZ) ? nearestLowZ : nearestAnyZ;
  if (!Number.isFinite(refWaterZ)) return null;

  // Pass 2: inverse-distance weighted localWaterZ among river vertices on the same terrace.
  let zWeighted = 0;
  let zWeightSum = 0;
  for (let gx = gx0 - 1; gx <= gx0 + 2; gx += 1) {
    for (let gy = gy0 - 1; gy <= gy0 + 2; gy += 1) {
      const v = lookupLatticeVertex(lookupFn, gx, gy, vertScratch);
      if (!v || !v.hasHeight || !Number.isFinite(v.height)) continue;
      let isRiver = v.code === 16;
      if (!isRiver && v.code === 17 && flowFn) {
        const fv = flowFn(gx * VERTEX_SPACING_M, gy * VERTEX_SPACING_M, flowScratch);
        if (fv && fv.speed >= RIVER_STANDING_FLOW_MIN) isRiver = true;
      }
      if (!isRiver) continue;
      if (Math.abs(v.height - refWaterZ) > 2.5) continue;
      const dx = gx * VERTEX_SPACING_M - wx;
      const dy = gy * VERTEX_SPACING_M - wy;
      const w = 1.0 / Math.max(9.0, dx * dx + dy * dy);
      zWeighted += v.height * w;
      zWeightSum += w;
    }
  }
  const localWaterZ = zWeightSum > 0 ? zWeighted / zWeightSum : refWaterZ;
  const bankHeight = s.height - localWaterZ;
  if (!(bankHeight >= RIVER_SHORE_MIN_ABOVE_WATER_M && bankHeight <= RIVER_SHORE_MAX_ABOVE_WATER_M)) {
    return null;
  }

  // Also fold local point flow if available.
  if (flowFn) {
    const localFv = flowFn(wx, wy, flowScratch);
    if (localFv && localFv.speed > 1e-4) {
      const lw = 1.0 / 16.0;
      flowSumX += localFv.vx * lw;
      flowSumY += localFv.vy * lw;
      flowWeightSum += lw;
    }
  }

  toRiverX += -s.normal.x * 0.05;
  toRiverY += -s.normal.y * 0.05;
  const rLen = Math.hypot(toRiverX, toRiverY);
  let stx = 1.0;
  let sty = 0.0;
  if (rLen > 1e-6) {
    stx = -toRiverY / rLen;
    sty = toRiverX / rLen;
  }

  let tx = stx;
  let ty = sty;
  const flowMag = Math.hypot(flowSumX, flowSumY);
  const flowSpeed = flowWeightSum > 0 ? flowMag / flowWeightSum : 0;
  if (flowMag > 1e-5) {
    const fdx = flowSumX / flowMag;
    const fdy = flowSumY / flowMag;
    if (stx * fdx + sty * fdy < 0) {
      stx = -stx;
      sty = -sty;
    }
    const bx = fdx * 0.78 + stx * 0.22;
    const by = fdy * 0.78 + sty * 0.22;
    const bLen = Math.hypot(bx, by);
    if (bLen > 1e-6) {
      tx = bx / bLen;
      ty = by / bLen;
    } else {
      tx = fdx;
      ty = fdy;
    }
  } else if (-s.normal.x * stx - s.normal.y * sty < 0) {
    tx = -stx;
    ty = -sty;
  }

  const r = out || {};
  r.isRiverShore = true;
  r.height = s.height;
  r.localWaterZ = localWaterZ;
  r.bankHeight = bankHeight;
  r.code = s.code;
  r.nx = s.normal.x;
  r.ny = s.normal.y;
  r.nz = s.normal.z;
  r.tx = tx;
  r.ty = ty;
  r.waterW = waterW;
  r.flowSpeed = flowSpeed;
  return r;
}

/**
 * Create a terrain oracle.
 *
 * @param {object} [opts]
 * @param {() => (Array|null)} [opts.getTerrainMeshes] BACKFILL ONLY — used to
 *   adopt LBs that were baked before the oracle existed (or before a provider
 *   registered). Scanned at most once per landblock per "note epoch"; once an
 *   LB is in the cache it is never scanned for again. Wire it to
 *   `() => terrainGroup.children`, exactly as `scene3d/index.js:5355` wires
 *   `ambient_runtime`.
 * @param {number} [opts.parkRescanEveryHits] see PARK_RESCAN_EVERY_HITS.
 * @param {(wx:number, wy:number, out?:object) => (object|null)} [opts.waterFlowAt]
 *   optional override for water-flow queries in `riverShoreAt`.
 * @param {object|null} [opts.waterFlowTable] optional explicit parsed water-flow table.
 */
export function createTerrainOracle(opts = {}) {
  const getTerrainMeshes = opts.getTerrainMeshes || null;
  const customWaterFlowAt = typeof opts.waterFlowAt === "function" ? opts.waterFlowAt : null;
  const explicitFlowTable = opts.waterFlowTable;
  const parkRescanEveryHits = Number.isFinite(opts.parkRescanEveryHits)
    ? Math.max(1, opts.parkRescanEveryHits | 0)
    : PARK_RESCAN_EVERY_HITS;

  /** @type {Map<number, {codes:Uint8Array, heights:Float32Array|null, roads:Uint8Array|null, lbX:number, lbY:number, coverage:Uint16Array|null}>} */
  const cache = new Map();
  /** Bumped by every successful note/backfill — gives missed LBs another look. */
  let noteEpoch = 0;
  /**
   * 2026-10-23 — cache CONTENT version for `version()`: bumped by a successful
   * note (incl. backfill), an `invalidate` that deleted, and `clear`. Unlike
   * `noteEpoch` it moves on deletes too, so a consumer mirroring the cache
   * (`terrain_field_gpu.js`) can skip its walk while this is unchanged.
   */
  let cacheVersion = 0;
  /**
   * Backfill scan INDEX (lbKey -> mesh), rebuilt at most once per note epoch.
   *
   * Was: a `missedAtEpoch` Map remembering which lbKeys had already been
   * scanned for in the current epoch. That memo was invalidated GLOBALLY by
   * every `noteLandblock`, and a note lands on every landblock bake — several
   * per second while the ring streams. So a scatter pass sampling over
   * partly-unbaked ground re-walked `terrainGroup.children` (~203 nodes at the
   * default LRU cap) once per distinct missed landblock, per bake: exactly the
   * "walk the scene graph thousands of times" cost the memo was written to
   * avoid. It also grew without bound (one entry per lbKey ever sampled).
   *
   * Indexing the walk instead makes the epoch bump cheap: ONE walk per epoch
   * however many landblocks miss, O(1) lookups after that, and the index is
   * replaced (not appended to) on rebuild so nothing accumulates.
   */
  let scanIdx = null;
  let scanIdxEpoch = -1;

  let hits = 0;
  let misses = 0;
  let parkedHits = 0;
  let backfills = 0;
  let hitsSinceParkScan = parkRescanEveryHits; // force a scan on the first hit
  /** lbKeys currently ATTACHED to terrainGroup, per the last rescan. */
  let attachedLbKeys = null;

  function refreshAttachedSet() {
    if (!getTerrainMeshes) return;
    let meshes = null;
    try {
      meshes = getTerrainMeshes();
    } catch (_) {
      return;
    }
    if (!meshes) return;
    const set = new Set();
    for (let i = 0; i < meshes.length; i += 1) {
      const ud = meshes[i] && meshes[i].userData;
      if (!ud) continue;
      if (typeof ud.lbX !== "number" || typeof ud.lbY !== "number") continue;
      set.add(lbKeyFromXY(ud.lbX, ud.lbY));
    }
    attachedLbKeys = set;
  }

  /**
   * Adopt an LB into the cache. Called at bake time by the VFX spine — the
   * ONLY population path that matters; the mesh scan below is a fallback.
   *
   * @param {number} lbKeyOrId residency key or the `| 0xffff` `userData.lbId`
   *   form; masked either way.
   * @param {{codes:ArrayLike<number>, heights?:ArrayLike<number>, roads?:ArrayLike<number>, lbX?:number, lbY?:number}} data
   *   `roads` (2026-10-07) is the mesh's `userData.roadCodes`, same
   *   column-major layout as `codes`.
   * @returns {boolean} false when `codes` was missing/short (nothing cached).
   */
  function noteLandblock(lbKeyOrId, data) {
    if (!data) return false;
    const lbKey = lbKeyOf(lbKeyOrId >>> 0);
    const codes = copyCodes(data.codes);
    if (!codes) return false;
    const lbX = typeof data.lbX === "number" ? data.lbX : (lbKey >>> 24) & 0xff;
    const lbY = typeof data.lbY === "number" ? data.lbY : (lbKey >>> 16) & 0xff;
    cache.set(lbKey, {
      codes,
      // May be null on a mesh built before Wave 0A added
      // `heights: Float32Array.from(wasmMesh.heights)` to the userData
      // literal. `sample()` then reports `height: null, normal: null` rather
      // than guessing — see the `hasHeight` field.
      heights: copyHeights(data.heights),
      // 2026-10-07 — null on a caller without road data: `sample()` then
      // reports `hasRoads: false` / `roadEdgeM: Infinity` (no road known),
      // never a guessed road.
      roads: copyRoads(data.roads),
      lbX,
      lbY,
      coverage: null,
    });
    noteEpoch += 1;
    cacheVersion += 1;
    if (attachedLbKeys) attachedLbKeys.add(lbKey);
    return true;
  }

  /**
   * Drop an LB. EVICT AND REBAKE ONLY — calling this on park is the bug this
   * whole module exists to avoid.
   */
  function invalidate(lbKeyOrId) {
    const lbKey = lbKeyOf(lbKeyOrId >>> 0);
    if (attachedLbKeys) attachedLbKeys.delete(lbKey);
    if (scanIdx) scanIdx.delete(lbKey);
    const deleted = cache.delete(lbKey);
    if (deleted) cacheVersion += 1;
    return deleted;
  }

  /** Drop everything (teleport across regions, full rebake, dispose). */
  function clear() {
    cache.clear();
    scanIdx = null;
    scanIdxEpoch = -1;
    attachedLbKeys = null;
    noteEpoch += 1;
    cacheVersion += 1;
  }

  /**
   * Cache lookup with a bounded backfill scan. Returns the entry or null.
   * Rescans a known-missing LB at most once per note epoch, so a scatter pass
   * sampling thousands of points over unloaded ground does not walk
   * `terrainGroup.children` thousands of times.
   */
  function entryFor(lbKey) {
    const hit = cache.get(lbKey);
    if (hit) return hit;
    if (!getTerrainMeshes) return null;
    // Rebuild the index at most ONCE per note epoch, then answer from it.
    if (scanIdxEpoch !== noteEpoch) {
      scanIdxEpoch = noteEpoch;
      const next = new Map();
      let meshes = null;
      try {
        meshes = getTerrainMeshes();
      } catch (_) {
        meshes = null;
      }
      if (meshes) {
        for (let i = 0; i < meshes.length; i += 1) {
          const ud = meshes[i] && meshes[i].userData;
          if (!ud) continue;
          if (typeof ud.lbX !== "number" || typeof ud.lbY !== "number") continue;
          const k = lbKeyFromXY(ud.lbX, ud.lbY);
          if (!next.has(k)) next.set(k, ud);
        }
      }
      scanIdx = next; // REPLACED, never appended to — cannot accumulate
    }
    const ud = scanIdx ? scanIdx.get(lbKey) : null;
    if (!ud) return null;
    if (noteLandblock(lbKey, {
      codes: ud.terrainCodes,
      heights: ud.heights,
      roads: ud.roadCodes,
      lbX: ud.lbX,
      lbY: ud.lbY,
    })) {
      backfills += 1;
      return cache.get(lbKey);
    }
    // A matching mesh with no usable codes is a miss; drop it from the index so
    // we do not re-attempt it for every sample in this epoch.
    scanIdx.delete(lbKey);
    return null;
  }

  function accountHit(lbKey) {
    hits += 1;
    hitsSinceParkScan += 1;
    if (hitsSinceParkScan >= parkRescanEveryHits) {
      hitsSinceParkScan = 0;
      refreshAttachedSet();
    }
    if (attachedLbKeys && !attachedLbKeys.has(lbKey)) parkedHits += 1;
  }

  // Gradient scratch for `sample()` (2026-10-24) — a plain Array keeps the
  // doubles exact, so the normal is bit-identical to the allocating form.
  const _gradScratch = [0, 0];

  /**
   * Full sample at world (x, y). AC frame: +X east, +Y north, +Z up — the
   * frame you are already in inside `terrainGroup` (`worldRoot` carries the
   * `rotation.x = -PI/2`). Do NOT run coords through `acToThree` first.
   *
   * @param {number} x world metres, east
   * @param {number} y world metres, north
   * @param {object} [out] optional reusable result object — pass one from a
   *   hot scatter loop to keep the sampler allocation-free.
   * @returns {null | {code:number, family:number, height:number|null,
   *   normal:{x:number,y:number,z:number}|null, hasHeight:boolean,
   *   lbX:number, lbY:number, lbKey:number, cornerCodes:Uint8Array,
   *   cornerRoads:Uint8Array, hasRoads:boolean, roadEdgeM:number}}
   *   null when the LB is not cached, is off-world, or carried no codes.
   *   `cornerRoads` (2026-10-07) is 0/1 per corner in `cornerCodes` order;
   *   `roadEdgeM` is `roadEdgeDistanceInCell` at (x, y): < 0 = on the painted
   *   road, Infinity = no road corner (or an LB noted without road data, which
   *   `hasRoads: false` distinguishes).
   */
  function sample(x, y, out) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      misses += 1;
      return null;
    }
    const lbX = Math.floor(x / METERS_PER_LANDBLOCK);
    const lbY = Math.floor(y / METERS_PER_LANDBLOCK);
    // Off-world. Matches `WorldState::terrain_height_at`'s `(0..256)` guard on X
    // and extends Y through Dericost (lbY = 359..613) —
    // and is REQUIRED, because `lbKeyFromXY` masks with `& 0xff` and would
    // otherwise wrap -1 onto landblock 255.
    if (lbX < 0 || lbX > 255 || lbY < 0 || lbY > 614) {
      misses += 1;
      return null;
    }
    const lbKey = lbKeyFromXY(lbX, lbY);
    const e = entryFor(lbKey);
    if (!e || e.lbY !== lbY) {
      misses += 1;
      return null;
    }
    accountHit(lbKey);

    const localX = x - lbX * METERS_PER_LANDBLOCK;
    const localY = y - lbY * METERS_PER_LANDBLOCK;

    // --- terrain code: NEAREST-VERTEX snap, column-major idx = col*9 + row.
    // Same semantics as `ambient_runtime._sampleTerrainVertex`, and the same
    // index the baker emits in `vertex_indices`.
    const col = clampInt(Math.round(localX / VERTEX_SPACING_M), 0, GRID_CELLS);
    const row = clampInt(Math.round(localY / VERTEX_SPACING_M), 0, GRID_CELLS);
    const code = e.codes[col * VERTEX_GRID + row] & 0x1f;

    // --- cell corners (for height, normal and boundary feathering).
    const cellXf = Math.min(Math.max(localX / VERTEX_SPACING_M, 0), GRID_CELLS);
    const cellYf = Math.min(Math.max(localY / VERTEX_SPACING_M, 0), GRID_CELLS);
    const cx0 = Math.floor(cellXf);
    const cy0 = Math.floor(cellYf);
    const cx1 = Math.min(cx0 + 1, GRID_CELLS);
    const cy1 = Math.min(cy0 + 1, GRID_CELLS);
    const fx = cellXf - cx0;
    const fy = cellYf - cy0;

    const iSW = cx0 * VERTEX_GRID + cy0;
    const iSE = cx1 * VERTEX_GRID + cy0;
    const iNW = cx0 * VERTEX_GRID + cy1;
    const iNE = cx1 * VERTEX_GRID + cy1;

    const r = out || {};
    let corners = r.cornerCodes;
    if (!corners || corners.length !== 4) {
      corners = new Uint8Array(4);
      r.cornerCodes = corners;
    }
    corners[0] = e.codes[iSW] & 0x1f;
    corners[1] = e.codes[iSE] & 0x1f;
    corners[2] = e.codes[iNW] & 0x1f;
    corners[3] = e.codes[iNE] & 0x1f;

    // 2026-10-07 — road flags at the same four corners, and the signed distance
    // to the painted road's edge. One OR + branch when the cell has no road
    // corner (the overwhelming case), so the hot scatter path stays flat.
    let cr = r.cornerRoads;
    if (!cr || cr.length !== 4) {
      cr = new Uint8Array(4);
      r.cornerRoads = cr;
    }
    const rd = e.roads;
    if (rd) {
      cr[0] = rd[iSW];
      cr[1] = rd[iSE];
      cr[2] = rd[iNW];
      cr[3] = rd[iNE];
      r.hasRoads = true;
      r.roadEdgeM = (cr[0] | cr[1] | cr[2] | cr[3]) === 0
        ? Infinity
        : roadEdgeDistanceInCell(cr[0], cr[1], cr[2], cr[3], fx, fy);
    } else {
      cr[0] = 0; cr[1] = 0; cr[2] = 0; cr[3] = 0;
      r.hasRoads = false;
      r.roadEdgeM = Infinity;
    }

    r.code = code;
    r.family = TERRAIN_CODE_TO_FAMILY[code];
    r.lbX = lbX;
    r.lbY = lbY;
    r.lbKey = lbKey;

    const h = e.heights;
    if (!h) {
      r.hasHeight = false;
      r.height = null;
      r.normal = null;
      return r;
    }
    const swNeCut = cellSwToNeCut(lbX * GRID_CELLS + cx0, lbY * GRID_CELLS + cy0);
    const z00 = h[iSW];
    const z10 = h[iSE];
    const z01 = h[iNW];
    const z11 = h[iNE];
    r.hasHeight = true;
    r.height = triangleHeightInCell(z00, z10, z01, z11, fx, fy, swNeCut);

    // Into the per-oracle scratch (2026-10-24): `sample()` is synchronous and
    // reads both slots straight away, so one 2-slot array serves every call.
    const g = triangleGradInCell(z00, z10, z01, z11, fx, fy, swNeCut, _gradScratch);
    const dzdx = g[0] / VERTEX_SPACING_M;
    const dzdy = g[1] / VERTEX_SPACING_M;
    let nx = -dzdx;
    let ny = -dzdy;
    let nz = 1.0;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!Number.isFinite(len) || len <= 1e-20) {
      nx = 0; ny = 0; nz = 1;
    } else {
      nx /= len; ny /= len; nz /= len;
    }
    let n = r.normal;
    if (!n || typeof n !== "object") {
      n = { x: 0, y: 0, z: 1 };
      r.normal = n;
    }
    n.x = nx; n.y = ny; n.z = nz;
    return r;
  }

  /**
   * Cheap path: terrain code only, no height, no normal, no allocation.
   * @returns {number} 0..31, or -1 on any miss.
   */
  function sampleCode(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      misses += 1;
      return -1;
    }
    const lbX = Math.floor(x / METERS_PER_LANDBLOCK);
    const lbY = Math.floor(y / METERS_PER_LANDBLOCK);
    if (lbX < 0 || lbX > 255 || lbY < 0 || lbY > 614) {
      misses += 1;
      return -1;
    }
    const lbKey = lbKeyFromXY(lbX, lbY);
    const e = entryFor(lbKey);
    if (!e || e.lbY !== lbY) {
      misses += 1;
      return -1;
    }
    accountHit(lbKey);
    const col = clampInt(
      Math.round((x - lbX * METERS_PER_LANDBLOCK) / VERTEX_SPACING_M), 0, GRID_CELLS,
    );
    const row = clampInt(
      Math.round((y - lbY * METERS_PER_LANDBLOCK) / VERTEX_SPACING_M), 0, GRID_CELLS,
    );
    return e.codes[col * VERTEX_GRID + row] & 0x1f;
  }

  // Reused by `heightAt` so the common "just ground me" call allocates nothing.
  const _scratch = {};

  /**
   * Ground height only, mirroring `SessionHandle.terrainHeightAt(x, y)`.
   *
   * ⚠ COMPARING AGAINST THE WASM REFERENCE — READ THIS FIRST.
   * `terrainHeightAt(world_x, world_y)` binds both coordinates as Rust `f32`.
   * Dereth world coords run to ~49,000 m, where one f32 ULP is ~0.004 m, so
   * the wasm evaluates at a point up to ~2 mm away from the one you passed.
   * On a steep cell that shows up as a height difference of up to ~2e-3 m —
   * which is coordinate quantisation in the BINDING, not divergence in this
   * port. Measured live 2026-07-31 (Holtburg ring, 448 comparable samples,
   * `?subdivLevel=4`):
   *   raw f64 coords : max |dz| 1.95e-3, mean 1.5e-4
   *   f32-quantised  : max |dz| 8.9e-6 (= 1 ULP at z ~ 57), mean 1.0e-6
   * So a parity check MUST quantise first:
   *   `oracle.heightAt(Math.fround(x), Math.fround(y))` vs
   *   `sessionHandle.terrainHeightAt(x, y)`  -> agree to ~1e-5.
   * A 1e-3 tolerance on unquantised coordinates WILL flake.
   *
   * @returns {number|null}
   */
  function heightAt(x, y) {
    const s = sample(x, y, _scratch);
    return s && s.hasHeight ? s.height : null;
  }

  /**
   * Per-family vertex counts for one landblock — the cheap "is there any
   * grass in this LB at all?" test a provider runs before doing any work.
   * Computed once and memoised on the cache entry.
   * @returns {Uint16Array|null} length FAM_COUNT, indexed by FAM_*.
   */
  function familyCoverage(lbKeyOrId) {
    const lbKey = lbKeyOf(lbKeyOrId >>> 0);
    const e = entryFor(lbKey);
    if (!e) return null;
    if (e.coverage) return e.coverage;
    const cov = new Uint16Array(FAM_COUNT);
    for (let i = 0; i < VERTEX_COUNT; i += 1) cov[familyForCode(e.codes[i])] += 1;
    e.coverage = cov;
    return cov;
  }

  /** True when the oracle can answer for this LB without touching the scene. */
  function hasLandblock(lbKeyOrId) {
    return cache.has(lbKeyOf(lbKeyOrId >>> 0));
  }

  /**
   * 2026-10-23 (GPU grass placement, `docs/2026-10-23-grass-gpu-placement.md`
   * Module A) — the cache content version: an integer that moves whenever the
   * cache changes (a successful `noteLandblock` or backfill adoption, an
   * `invalidate` that deleted, `clear`). Equal versions = identical cache.
   * @returns {number}
   */
  function version() {
    return cacheVersion;
  }

  /**
   * 2026-10-23 — the raw cache entry `{codes, heights, roads, lbX, lbY, …}` for
   * one LB, or null. Goes through `entryFor`, i.e. WITH the bounded backfill
   * adoption: in GPU-grass mode nothing else calls `sample()`, so this is what
   * adopts LBs baked before the oracle existed. Counts no hit/miss. READ-ONLY
   * by convention — the arrays ARE the cache; a rebake replaces the entry
   * object (never mutates it), so entry identity is a valid "changed?" test.
   */
  function lookup(lbKeyOrId) {
    return entryFor(lbKeyOf(lbKeyOrId >>> 0)) || null;
  }

  /**
   * `parkedHits` counts hits served for landblocks NOT currently attached to
   * `terrainGroup` — i.e. exactly the samples a scene-graph scanner would have
   * dropped. It stays 0 when no `getTerrainMeshes` was supplied. Refreshed on
   * a hit counter, never a clock.
   */
  function stats() {
    return {
      cached: cache.size,
      hits,
      misses,
      parkedHits,
      backfills,
      attachedKnown: attachedLbKeys ? attachedLbKeys.size : -1,
    };
  }

  const _shoreSampleScratch = {};
  const _shoreVertScratch = { code: 0, hasHeight: false, height: 0 };
  const _oceanCheckScratch = {};
  const _flowScratch = { vx: 0, vy: 0, speed: 0 };

  function oracleWaterFlowAt(wx, wy, out) {
    if (customWaterFlowAt) {
      return normalizeFlowSample(customWaterFlowAt(wx, wy, out), out);
    }
    return sampleWaterFlowTableAt(wx, wy, out, explicitFlowTable);
  }

  /**
   * Ocean coastline classification at world `(wx, wy)` (AC frame, metres):
   * dry shore (`0.02m <= height <= 2.30m`, `nz >= 0.80`, off-road) whose
   * containing 24 m cell or 1-ring lattice neighbour carries sea water code
   * `18` (`WaterShallowSea`), `19` (`WaterShallowStillSea`), or `20` (`WaterDeepSea`).
   * Returns `null` on miss.
   */
  function oracleOceanShoreAt(wx, wy, out) {
    return evalOceanShoreInternal(
      sample,
      lookup,
      oracleWaterFlowAt,
      wx,
      wy,
      _shoreSampleScratch,
      _shoreVertScratch,
      _flowScratch,
      out,
    );
  }

  /**
   * River bank classification at world `(wx, wy)` (AC frame, metres):
   * dry bank (`0.02m <= height - localWaterZ <= 1.20m`, `nz >= 0.76`, off-road,
   * `!isOceanShore`) adjacent to `WaterRunning (16)` or flowing `WaterStandingFresh (17)`
   * via `waterFlowAt`, returning normalized shoreline/current tangent `(tx, ty)`.
   * Returns `null` on miss.
   */
  function oracleRiverShoreAt(wx, wy, out) {
    return evalRiverShoreInternal(
      sample,
      lookup,
      oracleWaterFlowAt,
      wx,
      wy,
      _shoreSampleScratch,
      _shoreVertScratch,
      _oceanCheckScratch,
      _flowScratch,
      out,
    );
  }

  return {
    noteLandblock,
    invalidate,
    clear,
    sample,
    sampleCode,
    heightAt,
    waterFlowAt: oracleWaterFlowAt,
    oceanShoreAt: oracleOceanShoreAt,
    riverShoreAt: oracleRiverShoreAt,
    familyCoverage,
    hasLandblock,
    version,
    lookup,
    stats,
    // Diagnostics — the live `oracleSelfTest()` in `terrain_vfx.js` walks these.
    keys: () => Array.from(cache.keys()),
  };
}

const _standaloneSampleScratch = {};
const _standaloneVertScratch = { code: 0, hasHeight: false, height: 0 };
const _standaloneOceanScratch = {};
const _standaloneFlowScratch = { vx: 0, vy: 0, speed: 0 };

/**
 * Query water flow at `(wx, wy)` either through an `oracle` (if passed first)
 * or directly from `waterFlowTable()`.
 */
export function waterFlowAt(oracleOrWx, wxOrWy, wyOrOut, maybeOut) {
  if (oracleOrWx && typeof oracleOrWx === "object") {
    if (typeof oracleOrWx.waterFlowAt === "function") {
      return oracleOrWx.waterFlowAt(wxOrWy, wyOrOut, maybeOut);
    }
    return sampleWaterFlowTableAt(wxOrWy, wyOrOut, maybeOut);
  }
  return sampleWaterFlowTableAt(oracleOrWx, wxOrWy, wyOrOut);
}

/**
 * Top-level helper forwarding `oceanShoreAt(oracle, wx, wy, out)` (works on both
 * full `createTerrainOracle()` instances and `{ sample, lookup }` test stubs).
 */
export function oceanShoreAt(oracle, wx, wy, out) {
  if (!oracle) return null;
  if (typeof oracle.oceanShoreAt === "function") {
    return oracle.oceanShoreAt(wx, wy, out);
  }
  if (typeof oracle.sample !== "function" || typeof oracle.lookup !== "function") {
    return null;
  }
  const flowFn = typeof oracle.waterFlowAt === "function"
    ? (x, y, o) => normalizeFlowSample(oracle.waterFlowAt(x, y, o), o)
    : (x, y, o) => sampleWaterFlowTableAt(x, y, o);
  return evalOceanShoreInternal(
    (x, y, o) => oracle.sample(x, y, o),
    (k) => oracle.lookup(k),
    flowFn,
    wx,
    wy,
    _standaloneSampleScratch,
    _standaloneVertScratch,
    _standaloneFlowScratch,
    out,
  );
}

/**
 * Top-level helper forwarding `riverShoreAt(oracle, wx, wy, out)` (works on both
 * full `createTerrainOracle()` instances and `{ sample, lookup, waterFlowAt? }` stubs).
 */
export function riverShoreAt(oracle, wx, wy, out) {
  if (!oracle) return null;
  if (typeof oracle.riverShoreAt === "function") {
    return oracle.riverShoreAt(wx, wy, out);
  }
  if (typeof oracle.sample !== "function" || typeof oracle.lookup !== "function") {
    return null;
  }
  const flowFn = typeof oracle.waterFlowAt === "function"
    ? (x, y, o) => normalizeFlowSample(oracle.waterFlowAt(x, y, o), o)
    : (x, y, o) => sampleWaterFlowTableAt(x, y, o);
  return evalRiverShoreInternal(
    (x, y, o) => oracle.sample(x, y, o),
    (k) => oracle.lookup(k),
    flowFn,
    wx,
    wy,
    _standaloneSampleScratch,
    _standaloneVertScratch,
    _standaloneOceanScratch,
    _standaloneFlowScratch,
    out,
  );
}
