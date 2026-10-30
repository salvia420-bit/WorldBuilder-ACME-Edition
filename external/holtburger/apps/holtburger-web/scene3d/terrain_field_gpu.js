// scene3d/terrain_field_gpu.js — per-landblock terrain DATA for the GPU
// (2026-10-23, `?terrainGrassGpu`; design contract
// `docs/2026-10-23-grass-gpu-placement.md` Module A).
//
// WHAT THIS IS. The terrain oracle (`terrain_oracle.js`) answers "height,
// normal, corner codes, road distance at world (x, y)" on the CPU, from a cache
// of 81-vertex landblock records written at bake. GPU grass placement needs the
// SAME answer inside a vertex shader, so this module mirrors the oracle cache
// into two small float textures and ships the GLSL that samples them exactly the
// way `oracle.sample()` does:
//
//   uHbField     RGBA32F 144x144 = 16x16 landblock SLOTS of 9x9 vertices.
//                Slot of LB (lbX, lbY) = (lbX & 15, lbY & 15); vertex (col, row)
//                of that LB (oracle index col*9 + row) is texel
//                (slotX*9 + col, slotY*9 + row), data index
//                ((slotY*9 + row) * 144 + slotX*9 + col) * 4.
//                r = height (the oracle's Float32 value, 0 with no heights),
//                g = terrain code (& 0x1f), b = road flag 0/1, a = 1.
//   uHbFieldKey  RGBA32F 16x16: texel (slotX, slotY) = (lbX, lbY, hasHeights,
//                valid). The shader trusts a slot only when the key names the
//                very LB it wants — so slot ALIASING (LB x and x+16 share a slot)
//                can never hand back another landblock's ground.
//
// THE WINDOW. Only LBs within `windowRadiusLb` (<= 7) of the player's LB are
// resident: (2r+1)^2 <= 15x15 never puts two window LBs in one 16x16 slot grid
// cell. `update(px, py)` is a no-op unless the player's LB or the oracle's
// `version()` moved (or a different oracle object arrived); then it walks the
// window and rewrites a slot only when it does not already hold that exact cache
// ENTRY (identity: a rebake makes a new entry object, park keeps the old one).
// A full re-upload of both textures is ~332 KB and happens only when landblocks
// change, never per frame.
//
// THE MIRROR. `sampleMirror(x, y)` is a line-by-line JS port of
// `hbFieldSample` reading the SAME Float32Arrays the textures hold, with every
// float op rounded to f32 (`Math.fround`) the way the shader evaluates it. The
// node test holds the MIRROR against `oracle.sample()` on real Holtburg
// landblocks; it never runs the GLSL, so a green node test says nothing about
// a GLSL edit. Only the browser readback smoke
// (harness/glsl_smoke/grass_gpu_smoke.mjs) holds the GLSL to the CPU, and the
// node gate's fingerprint lock (test_terrain_grass_gpu.mjs G7) fails until that
// smoke has passed on the current GLSL (2026-10-23, review tests-1). Keep the
// two in lockstep (same variable names, same branch order) when either is
// edited.
//
// EXACT DECISIONS. Every DISCRETE choice in `hbFieldSample` — landblock, cell,
// split triangle — is made on exactly-representable values (integer LB index,
// an integer fix-up of floor(local / 24), triangle tests on the exact metres
// into the cell), so it resolves identically on every GPU whatever its division
// precision, and identically in the mirror. Only the smooth outputs (height,
// normal, road distance) carry f32 rounding. One honest residue vs the f64
// oracle: a point EXACTLY on a cell's split diagonal (~1 in 6,000 at Holtburg's
// 2^-8 m f32 spacing) has one height but two candidate face normals; the shader
// takes the triangle the oracle's maths names (`fx >= fy`, `fx + fy <= 1`), the
// oracle's f64 division rounding sometimes picks the other. Height, codes and
// road distance agree there; only `normal` can differ.
//
// INJECTED THREE (the `terrain_scatter.js` idiom). This module imports no three.
// With no THREE the arrays, the window logic and the mirror all still run; only
// the two `DataTexture`s are skipped (node tests, `?nullRender=1`).
//
// INVARIANTS. No `Math.random`, no clocks: the textures are a pure function of
// (oracle cache, player LB). No light, no program-cache-key variation. Reads
// terrain only.
//
// GLSL rules (house): the GLSL below is a template literal — NEVER put a
// backtick inside it — and its comments stay inside the GLSL ES source
// character set (plain ASCII, no quotes or apostrophes).

import { lbKeyFromXY } from "./landblock_lru.js";
import {
  ROAD_PAINT,
  VERTEX_GRID,
  VERTEX_SPACING_M,
  METERS_PER_LANDBLOCK,
} from "./terrain_oracle.js";

// ---------------------------------------------------------------------------
// Layout constants.
// ---------------------------------------------------------------------------

export const FIELD_SLOTS = 16;                          // slots per axis
export const FIELD_TILE = VERTEX_GRID;                  // 9 texels per LB per axis
export const FIELD_TEX_SIZE = FIELD_SLOTS * FIELD_TILE; // 144
/** GLSL stand-in for the oracle's `roadEdgeM === Infinity` (no road corner). */
export const HB_ROAD_NONE = 1e9;
/** Largest window radius whose (2r+1)^2 window fits the 16x16 slot grid. */
export const FIELD_MAX_WINDOW_RADIUS_LB = (FIELD_SLOTS - 1) >> 1; // 7
/**
 * `cellSwToNeCut`'s `v8 * 2.3283064e-10 >= 0.5` as an exact u32 compare: the
 * smallest u32 whose f64 product clears 0.5 (2.3283064e-10 is a hair UNDER
 * 2^-32, so the cutoff is 2^31 + 34, not 2^31). Computed 2026-10-23;
 * `test_terrain_field_gpu.mjs` re-derives it.
 */
export const SW_NE_CUT_MIN_U32 = 2147483682;

const GRID_CELLS = VERTEX_GRID - 1;                     // 8
const LB_M = METERS_PER_LANDBLOCK;                      // 192
const VERT_M = VERTEX_SPACING_M;                        // 24
const WORLD_M = 256 * METERS_PER_LANDBLOCK;             // 49152
const SLOT_COUNT = FIELD_SLOTS * FIELD_SLOTS;           // 256
const VERTEX_COUNT = VERTEX_GRID * VERTEX_GRID;         // 81

/** A JS number as a GLSL float literal (always carries a '.' or exponent). */
function glslFloat(v) {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

// ---------------------------------------------------------------------------
// GLSL. Valid in BOTH stages (GLSL ES 3.00). The road widths come straight from
// the oracle's ROAD_PAINT so the two cannot drift.
// ---------------------------------------------------------------------------

export const TERRAIN_FIELD_GLSL = /* glsl */ `
// ==== TERRAIN FIELD (scene3d/terrain_field_gpu.js) ====
// Per landblock terrain data, 16x16 landblock slots of 9x9 vertices, and a
// sampler that mirrors terrain_oracle sample(). World coords are AC metres
// (x east, y north), the frame of terrainGroup.
uniform highp sampler2D uHbField;
uniform highp sampler2D uHbFieldKey;

const float HB_ROAD_NONE = ${glslFloat(HB_ROAD_NONE)};
const float HB_ROAD_EDGE_HALF = ${glslFloat(ROAD_PAINT.edgeHalfWidthM)};
const float HB_ROAD_DIAG_HALF = ${glslFloat(ROAD_PAINT.diagHalfWidthM)};
const float HB_ROAD_CORNER_R = ${glslFloat(ROAD_PAINT.cornerRadiusM)};
const float HB_ROAD_SQRT1_2 = ${glslFloat(Math.SQRT1_2)};
const float HB_FIELD_VERT_M = ${glslFloat(VERT_M)};
const float HB_FIELD_WORLD_M = ${glslFloat(WORLD_M)};

// Retail per cell split diagonal (CLandBlockStruct ConstructPolygons), the
// exact u32 form of terrain_oracle cellSwToNeCut: uint multiply wraps mod 2^32.
// true = SW to NE diagonal.
bool hbCellSwToNeCut(int gcx, int gcy) {
  highp uint gx = uint(gcx);
  highp uint gy = uint(gcy);
  highp uint inner = 214614067u * gx + 1813693831u;
  highp uint v8 = gy * inner - 1109124029u * gx - 1369149221u;
  return v8 >= ${SW_NE_CUT_MIN_U32}u;
}

// Signed metres to the edge of the painted road in one 24 m cell, port of
// terrain_oracle roadEdgeDistanceInCell. roads = SW, SE, NW, NE flags (0/1),
// f = cell fraction. HB_ROAD_NONE with no road corner, -24 with all four.
float hbRoadEdgeDistanceInCell(ivec4 roads, vec2 f) {
  bool sw = roads.x != 0;
  bool se = roads.y != 0;
  bool nw = roads.z != 0;
  bool ne = roads.w != 0;
  int n = (sw ? 1 : 0) + (se ? 1 : 0) + (nw ? 1 : 0) + (ne ? 1 : 0);
  if (n == 0) return HB_ROAD_NONE;
  if (n == 4) return -HB_FIELD_VERT_M;
  float px = f.x * HB_FIELD_VERT_M;
  float py = f.y * HB_FIELD_VERT_M;
  float qx = HB_FIELD_VERT_M - px;
  float qy = HB_FIELD_VERT_M - py;
  if (n == 3) {
    // Two edge lanes through the corner opposite the missing one.
    if (!sw) return min(qx, qy) - HB_ROAD_EDGE_HALF;
    if (!se) return min(px, qy) - HB_ROAD_EDGE_HALF;
    if (!nw) return min(qx, py) - HB_ROAD_EDGE_HALF;
    return min(px, py) - HB_ROAD_EDGE_HALF;
  }
  if (n == 2) {
    if (sw && se) return py - HB_ROAD_EDGE_HALF;
    if (nw && ne) return qy - HB_ROAD_EDGE_HALF;
    if (sw && nw) return px - HB_ROAD_EDGE_HALF;
    if (se && ne) return qx - HB_ROAD_EDGE_HALF;
    // Opposite corners: the diagonal lane.
    float dd = (sw && ne)
      ? abs(px - py) * HB_ROAD_SQRT1_2
      : abs(px + py - HB_FIELD_VERT_M) * HB_ROAD_SQRT1_2;
    return dd - HB_ROAD_DIAG_HALF;
  }
  // One road corner: a quarter disc.
  vec2 dc = sw ? vec2(px, py) : (se ? vec2(qx, py) : (nw ? vec2(px, qy) : vec2(qx, qy)));
  return length(dc) - HB_ROAD_CORNER_R;
}

// The oracle sample at world p. false = off world, landblock not resident in
// its slot (the key must name this very landblock), or no heights.
// cornerCodes = SW, SE, NW, NE terrain codes; normal is the exact face normal.
bool hbFieldSample(vec2 p, out float height, out vec3 normal, out ivec4 cornerCodes, out float roadEdgeM) {
  height = 0.0;
  normal = vec3(0.0, 0.0, 1.0);
  cornerCodes = ivec4(0);
  roadEdgeM = HB_ROAD_NONE;
  // Off world (the oracle 0..255 guard); every compare is false for NaN.
  if (!(p.x >= 0.0 && p.y >= 0.0 && p.x < HB_FIELD_WORLD_M && p.y < HB_FIELD_WORLD_M)) return false;
  // Integer landblock index: exact, no float division at landblock edges.
  ivec2 lb = ivec2(floor(p)) / 192;
  ivec2 slot = lb & 15;
  vec4 key = texelFetch(uHbFieldKey, slot, 0);
  if (key.w < 0.5 || key.z < 0.5 || ivec2(key.xy + 0.5) != lb) return false;
  // local is exact in f32 with 0 <= local < 192, so the oracle clamp of
  // local / 24 to 0..8 can only ever yield cells 0..7.
  vec2 local = p - vec2(lb * 192);
  // Cell = floor(local / 24) EXACTLY: the division seeds it and one integer
  // fix up absorbs any GPU division rounding (every product here is exact).
  ivec2 c0 = clamp(ivec2(local / HB_FIELD_VERT_M), 0, 7);
  c0 -= ivec2(lessThan(local, vec2(c0) * HB_FIELD_VERT_M));
  c0 += ivec2(greaterThanEqual(local, vec2(c0 + 1) * HB_FIELD_VERT_M));
  ivec2 c1 = min(c0 + 1, 8);
  // Metres into the cell (exact), and the cell fraction.
  vec2 d = local - vec2(c0) * HB_FIELD_VERT_M;
  vec2 f = d / HB_FIELD_VERT_M;
  ivec2 base = slot * 9;
  vec4 tSW = texelFetch(uHbField, base + ivec2(c0.x, c0.y), 0);
  vec4 tSE = texelFetch(uHbField, base + ivec2(c1.x, c0.y), 0);
  vec4 tNW = texelFetch(uHbField, base + ivec2(c0.x, c1.y), 0);
  vec4 tNE = texelFetch(uHbField, base + ivec2(c1.x, c1.y), 0);
  float z00 = tSW.r;
  float z10 = tSE.r;
  float z01 = tNW.r;
  float z11 = tNE.r;
  cornerCodes = ivec4(int(tSW.g + 0.5), int(tSE.g + 0.5), int(tNW.g + 0.5), int(tNE.g + 0.5));
  ivec4 roads = ivec4(int(tSW.b + 0.5), int(tSE.b + 0.5), int(tNW.b + 0.5), int(tNE.b + 0.5));
  bool cut = hbCellSwToNeCut(lb.x * 8 + c0.x, lb.y * 8 + c0.y);
  // Triangle choice on the EXACT metres d (fx >= fy and fx + fy <= 1 of the
  // oracle), so a point on the diagonal resolves the same on every GPU.
  vec2 g;
  if (cut) {
    if (d.x >= d.y) {
      // lower right triangle: SW, SE, NE
      height = z00 + (z10 - z00) * f.x + (z11 - z10) * f.y;
      g = vec2(z10 - z00, z11 - z10);
    } else {
      // upper left triangle: SW, NE, NW
      height = z00 + (z11 - z01) * f.x + (z01 - z00) * f.y;
      g = vec2(z11 - z01, z01 - z00);
    }
  } else {
    if (d.x + d.y <= HB_FIELD_VERT_M) {
      // lower left triangle: SW, SE, NW
      height = z00 + (z10 - z00) * f.x + (z01 - z00) * f.y;
      g = vec2(z10 - z00, z01 - z00);
    } else {
      // upper right triangle: NE, NW, SE
      height = z11 + (z01 - z11) * (1.0 - f.x) + (z10 - z11) * (1.0 - f.y);
      g = vec2(z11 - z01, z11 - z10);
    }
  }
  g = g / HB_FIELD_VERT_M;
  normal = normalize(vec3(-g.x, -g.y, 1.0));
  roadEdgeM = hbRoadEdgeDistanceInCell(roads, f);
  return true;
}
// ==== END TERRAIN FIELD ====
`;

// ---------------------------------------------------------------------------
// JS mirrors of the GLSL — f32 arithmetic, same names, same branch order.
// ---------------------------------------------------------------------------

const F = Math.fround;
const F_ROAD_EDGE_HALF = F(ROAD_PAINT.edgeHalfWidthM);
const F_ROAD_DIAG_HALF = F(ROAD_PAINT.diagHalfWidthM);
const F_ROAD_CORNER_R = F(ROAD_PAINT.cornerRadiusM);
const F_ROAD_SQRT1_2 = F(Math.SQRT1_2);
const F_VERT_M = F(VERT_M);

/** GLSL `int(v)` — truncation toward zero. */
const toInt = Math.trunc;

/**
 * Mirror of GLSL `hbCellSwToNeCut` (u32 arithmetic, exact threshold compare).
 * Must agree with `terrain_oracle.js::cellSwToNeCut` on every global cell.
 */
export function fieldCellSwToNeCut(gcx, gcy) {
  const gx = gcx >>> 0;                                                // uint(gcx)
  const gy = gcy >>> 0;                                                // uint(gcy)
  const inner = (Math.imul(214614067, gx) + 1813693831) >>> 0;         // wraps mod 2^32
  const v8 = (Math.imul(gy, inner) - Math.imul(1109124029, gx) - 1369149221) >>> 0;
  return v8 >= SW_NE_CUT_MIN_U32;
}

/**
 * Mirror of GLSL `hbRoadEdgeDistanceInCell` (f32). Road flags in the oracle's
 * corner order SW, SE, NW, NE; `fx`/`fy` are the (f32) cell fractions.
 * @returns {number} HB_ROAD_NONE with no road corner, -24 with all four.
 */
export function fieldRoadEdgeDistanceInCell(rSW, rSE, rNW, rNE, fx, fy) {
  const sw = rSW !== 0;
  const se = rSE !== 0;
  const nw = rNW !== 0;
  const ne = rNE !== 0;
  const n = (sw ? 1 : 0) + (se ? 1 : 0) + (nw ? 1 : 0) + (ne ? 1 : 0);
  if (n === 0) return HB_ROAD_NONE;
  if (n === 4) return -F_VERT_M;
  const px = F(fx * F_VERT_M);
  const py = F(fy * F_VERT_M);
  const qx = F(F_VERT_M - px);
  const qy = F(F_VERT_M - py);
  if (n === 3) {
    if (!sw) return F(Math.min(qx, qy) - F_ROAD_EDGE_HALF);
    if (!se) return F(Math.min(px, qy) - F_ROAD_EDGE_HALF);
    if (!nw) return F(Math.min(qx, py) - F_ROAD_EDGE_HALF);
    return F(Math.min(px, py) - F_ROAD_EDGE_HALF);
  }
  if (n === 2) {
    if (sw && se) return F(py - F_ROAD_EDGE_HALF);
    if (nw && ne) return F(qy - F_ROAD_EDGE_HALF);
    if (sw && nw) return F(px - F_ROAD_EDGE_HALF);
    if (se && ne) return F(qx - F_ROAD_EDGE_HALF);
    const dd = (sw && ne)
      ? F(Math.abs(F(px - py)) * F_ROAD_SQRT1_2)
      : F(Math.abs(F(F(px + py) - F_VERT_M)) * F_ROAD_SQRT1_2);
    return F(dd - F_ROAD_DIAG_HALF);
  }
  let dcx, dcy;
  if (sw) { dcx = px; dcy = py; } else if (se) { dcx = qx; dcy = py; } else if (nw) { dcx = px; dcy = qy; } else { dcx = qx; dcy = qy; }
  // length(dc)
  const len = F(Math.sqrt(F(F(dcx * dcx) + F(dcy * dcy))));
  return F(len - F_ROAD_CORNER_R);
}

/**
 * Mirror of GLSL `hbFieldSample` over the texture arrays. Returns null where
 * the shader returns false.
 */
function sampleFieldArrays(field, key, x, y, out) {
  // vec2 p — the shader sees f32 coordinates.
  const px = F(x);
  const py = F(y);
  if (!(px >= 0 && py >= 0 && px < WORLD_M && py < WORLD_M)) return null;
  // ivec2 lb = ivec2(floor(p)) / 192;  (non-negative: integer division truncates)
  const lbx = toInt(toInt(Math.floor(px)) / 192);
  const lby = toInt(toInt(Math.floor(py)) / 192);
  // ivec2 slot = lb & 15;
  const sx = lbx & 15;
  const sy = lby & 15;
  // vec4 key = texelFetch(uHbFieldKey, slot, 0);
  const k = (sy * FIELD_SLOTS + sx) * 4;
  // if (key.w < 0.5 || key.z < 0.5 || ivec2(key.xy + 0.5) != lb) return false;
  if (key[k + 3] < 0.5 || key[k + 2] < 0.5
    || toInt(F(key[k] + 0.5)) !== lbx || toInt(F(key[k + 1] + 0.5)) !== lby) return null;
  // vec2 local = p - vec2(lb * 192);   (exact)
  const localX = F(px - lbx * 192);
  const localY = F(py - lby * 192);
  // ivec2 c0 = clamp(ivec2(local / HB_FIELD_VERT_M), 0, 7);
  let c0x = Math.min(Math.max(toInt(F(localX / F_VERT_M)), 0), GRID_CELLS - 1);
  let c0y = Math.min(Math.max(toInt(F(localY / F_VERT_M)), 0), GRID_CELLS - 1);
  // c0 -= ivec2(lessThan(local, vec2(c0) * HB_FIELD_VERT_M));
  if (localX < c0x * VERT_M) c0x -= 1;
  if (localY < c0y * VERT_M) c0y -= 1;
  // c0 += ivec2(greaterThanEqual(local, vec2(c0 + 1) * HB_FIELD_VERT_M));
  if (localX >= (c0x + 1) * VERT_M) c0x += 1;
  if (localY >= (c0y + 1) * VERT_M) c0y += 1;
  // ivec2 c1 = min(c0 + 1, 8);
  const c1x = Math.min(c0x + 1, GRID_CELLS);
  const c1y = Math.min(c0y + 1, GRID_CELLS);
  // vec2 d = local - vec2(c0) * HB_FIELD_VERT_M;  vec2 f = d / HB_FIELD_VERT_M;
  const dx = F(localX - c0x * VERT_M);
  const dy = F(localY - c0y * VERT_M);
  const fx = F(dx / F_VERT_M);
  const fy = F(dy / F_VERT_M);
  // ivec2 base = slot * 9;  texelFetch(uHbField, base + ivec2(c, r), 0)
  const bx = sx * FIELD_TILE;
  const by = sy * FIELD_TILE;
  const tSW = ((by + c0y) * FIELD_TEX_SIZE + bx + c0x) * 4;
  const tSE = ((by + c0y) * FIELD_TEX_SIZE + bx + c1x) * 4;
  const tNW = ((by + c1y) * FIELD_TEX_SIZE + bx + c0x) * 4;
  const tNE = ((by + c1y) * FIELD_TEX_SIZE + bx + c1x) * 4;
  const z00 = field[tSW];
  const z10 = field[tSE];
  const z01 = field[tNW];
  const z11 = field[tNE];

  const r = out || {};
  let cc = r.cornerCodes;
  if (!cc || cc.length !== 4) {
    cc = new Int32Array(4);
    r.cornerCodes = cc;
  }
  cc[0] = toInt(F(field[tSW + 1] + 0.5));
  cc[1] = toInt(F(field[tSE + 1] + 0.5));
  cc[2] = toInt(F(field[tNW + 1] + 0.5));
  cc[3] = toInt(F(field[tNE + 1] + 0.5));
  const rSW = toInt(F(field[tSW + 2] + 0.5));
  const rSE = toInt(F(field[tSE + 2] + 0.5));
  const rNW = toInt(F(field[tNW + 2] + 0.5));
  const rNE = toInt(F(field[tNE + 2] + 0.5));

  const cut = fieldCellSwToNeCut(lbx * 8 + c0x, lby * 8 + c0y);
  let height, gx, gy;
  if (cut) {
    if (dx >= dy) {
      height = F(F(z00 + F(F(z10 - z00) * fx)) + F(F(z11 - z10) * fy));
      gx = F(z10 - z00); gy = F(z11 - z10);
    } else {
      height = F(F(z00 + F(F(z11 - z01) * fx)) + F(F(z01 - z00) * fy));
      gx = F(z11 - z01); gy = F(z01 - z00);
    }
  } else if (F(dx + dy) <= F_VERT_M) {
    height = F(F(z00 + F(F(z10 - z00) * fx)) + F(F(z01 - z00) * fy));
    gx = F(z10 - z00); gy = F(z01 - z00);
  } else {
    height = F(F(z11 + F(F(z01 - z11) * F(1.0 - fx))) + F(F(z10 - z11) * F(1.0 - fy)));
    gx = F(z11 - z01); gy = F(z11 - z10);
  }
  // g = g / HB_FIELD_VERT_M; normal = normalize(vec3(-g.x, -g.y, 1.0));
  gx = F(gx / F_VERT_M);
  gy = F(gy / F_VERT_M);
  const vx = -gx;
  const vy = -gy;
  const inv = F(1 / Math.sqrt(F(F(F(vx * vx) + F(vy * vy)) + 1)));
  let n = r.normal;
  if (!n || typeof n !== "object") {
    n = { x: 0, y: 0, z: 1 };
    r.normal = n;
  }
  n.x = F(vx * inv);
  n.y = F(vy * inv);
  n.z = inv;
  r.height = height;
  r.roadEdgeM = fieldRoadEdgeDistanceInCell(rSW, rSE, rNW, rNE, fx, fy);
  return r;
}

// ---------------------------------------------------------------------------
// The field.
// ---------------------------------------------------------------------------

/**
 * Create the GPU terrain field.
 *
 * @param {object} opts
 * @param {object} [opts.THREE] injected three; omitted = arrays only.
 * @param {object|Function} [opts.oracle] the terrain oracle, or a GETTER
 *   returning it (`terrain_vfx.js`'s `ctx.oracle` arrives late — never stash
 *   it). Needs `lookup()`; `version()` makes `update()` free when nothing moved
 *   (without it every call re-walks the window).
 * @param {number} [opts.windowRadiusLb=7] clamped to 0..7.
 */
// 2026-10-26 (lane F2, `?hotGrassCull`) — one sequence for every field, so a
// generation stamp never repeats across fields (a rebuilt field cannot pass for
// the one a memo was filled from).
let _fieldGenSeq = 0;

export function createTerrainFieldGpu(opts = {}) {
  const THREE = opts.THREE || null;
  const oracleOpt = opts.oracle || null;
  const rIn = Number.isFinite(opts.windowRadiusLb) ? Math.floor(opts.windowRadiusLb) : FIELD_MAX_WINDOW_RADIUS_LB;
  const radius = Math.max(0, Math.min(FIELD_MAX_WINDOW_RADIUS_LB, rIn));

  const fieldData = new Float32Array(FIELD_TEX_SIZE * FIELD_TEX_SIZE * 4);
  const keyData = new Float32Array(SLOT_COUNT * 4);

  // Per-slot bookkeeping (what the textures currently hold).
  const slotEntry = new Array(SLOT_COUNT).fill(null); // cache entry last WRITTEN (kept while invalid)
  const slotLbX = new Int32Array(SLOT_COUNT).fill(-1);
  const slotLbY = new Int32Array(SLOT_COUNT).fill(-1);
  const slotValid = new Uint8Array(SLOT_COUNT);
  const slotHasHeights = new Uint8Array(SLOT_COUNT);
  const slotMin = new Float32Array(SLOT_COUNT);
  const slotMax = new Float32Array(SLOT_COUNT);
  const slotClaim = new Int32Array(SLOT_COUNT);  // walk stamp: claimed by a window LB
  let walkId = 0;

  let fieldTex = null;
  let keyTex = null;
  if (THREE && typeof THREE.DataTexture === "function") {
    const mk = (data, size, name) => {
      const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
      t.name = name;
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.flipY = false;
      t.needsUpdate = true;
      return t;
    };
    fieldTex = mk(fieldData, FIELD_TEX_SIZE, "hb-terrain-field");
    keyTex = mk(keyData, FIELD_SLOTS, "hb-terrain-field-key");
  }
  /** Bind these BY REFERENCE into every material's shader.uniforms. */
  const uniforms = {
    uHbField: { value: fieldTex },
    uHbFieldKey: { value: keyTex },
  };

  // Window state the textures reflect (null = never updated).
  let centerX = null;
  let centerY = null;
  let lastOracle = undefined;
  let lastVersion = null;
  let disposed = false;

  let writes = 0;
  let invalidations = 0;
  let uploads = 0;
  let walks = 0;
  let gen = ++_fieldGenSeq;

  function resolveOracle() {
    if (!oracleOpt) return null;
    if (typeof oracleOpt === "function") {
      try { return oracleOpt() || null; } catch (_) { return null; }
    }
    return oracleOpt;
  }

  function readVersion(o) {
    if (!o) return -1;
    if (typeof o.version !== "function") return NaN; // never equal: always re-walk
    try { return o.version(); } catch (_) { return NaN; }
  }

  function writeTile(slot, lbX, lbY, e) {
    const sx = slot & 15;
    const sy = slot >> 4;
    const codes = e.codes;
    const h = e.heights && e.heights.length >= VERTEX_COUNT ? e.heights : null;
    const roads = e.roads && e.roads.length >= VERTEX_COUNT ? e.roads : null;
    let mn = Infinity;
    let mx = -Infinity;
    for (let col = 0; col < VERTEX_GRID; col += 1) {
      for (let row = 0; row < VERTEX_GRID; row += 1) {
        const i = col * VERTEX_GRID + row;
        const d = ((sy * FIELD_TILE + row) * FIELD_TEX_SIZE + sx * FIELD_TILE + col) * 4;
        const z = h ? h[i] : 0;
        fieldData[d] = z;
        fieldData[d + 1] = codes[i] & 0x1f;
        fieldData[d + 2] = roads && roads[i] ? 1 : 0;
        fieldData[d + 3] = 1;
        if (h) {
          if (z < mn) mn = z;
          if (z > mx) mx = z;
        }
      }
    }
    const k = slot * 4;
    keyData[k] = lbX;
    keyData[k + 1] = lbY;
    keyData[k + 2] = h ? 1 : 0;
    keyData[k + 3] = 1;
    slotEntry[slot] = e;
    slotLbX[slot] = lbX;
    slotLbY[slot] = lbY;
    slotValid[slot] = 1;
    slotHasHeights[slot] = h ? 1 : 0;
    slotMin[slot] = h ? mn : 0;
    slotMax[slot] = h ? mx : 0;
  }

  /**
   * Re-centre the window on the player and mirror any oracle change.
   * @returns {number} slots whose texture content changed this call (tile
   *   (re)writes + key validations + invalidations); 0 = no-op.
   */
  function update(px, py) {
    if (disposed) return 0;
    if (!Number.isFinite(px) || !Number.isFinite(py)) return 0;
    const cx = Math.floor(px / LB_M);
    const cy = Math.floor(py / LB_M);
    const o = resolveOracle();
    const ver = readVersion(o);
    if (o === lastOracle && cx === centerX && cy === centerY && ver === lastVersion) return 0;

    walks += 1;
    // Everything heightRange() reads (slot arrays, centre, disposed) changes
    // only in a walk or in dispose(): a new stamp for each.
    gen = ++_fieldGenSeq;
    walkId += 1;
    const canLookup = !!(o && typeof o.lookup === "function");
    let changed = 0;
    let fieldDirty = false;
    let keyDirty = false;
    for (let dy = -radius; dy <= radius; dy += 1) {
      const lbY = cy + dy;
      if (lbY < 0 || lbY > 255) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const lbX = cx + dx;
        if (lbX < 0 || lbX > 255) continue;
        const slot = (lbY & 15) * FIELD_SLOTS + (lbX & 15);
        slotClaim[slot] = walkId;
        let e = null;
        if (canLookup) {
          try { e = o.lookup(lbKeyFromXY(lbX, lbY)); } catch (_) { e = null; }
        }
        if (e && e.codes && e.codes.length >= VERTEX_COUNT) {
          if (slotEntry[slot] === e && slotLbX[slot] === lbX && slotLbY[slot] === lbY) {
            // Same entry already in the tile: at most the key needs re-validating
            // (the LB left the window and came back with nothing written over it).
            if (!slotValid[slot]) {
              keyData[slot * 4 + 3] = 1;
              slotValid[slot] = 1;
              keyDirty = true;
              changed += 1;
            }
          } else {
            writeTile(slot, lbX, lbY, e);
            writes += 1;
            fieldDirty = true;
            keyDirty = true;
            changed += 1;
          }
        } else if (slotValid[slot]) {
          keyData[slot * 4 + 3] = 0;
          slotValid[slot] = 0;
          invalidations += 1;
          keyDirty = true;
          changed += 1;
        }
      }
    }
    // Slots no window LB maps to are invalid.
    for (let s = 0; s < SLOT_COUNT; s += 1) {
      if (slotClaim[s] === walkId || !slotValid[s]) continue;
      keyData[s * 4 + 3] = 0;
      slotValid[s] = 0;
      invalidations += 1;
      keyDirty = true;
      changed += 1;
    }
    if (fieldDirty) {
      uploads += 1;
      if (fieldTex) fieldTex.needsUpdate = true;
    }
    if (keyDirty) {
      uploads += 1;
      if (keyTex) keyTex.needsUpdate = true;
    }
    centerX = cx;
    centerY = cy;
    lastOracle = o;
    // Read AFTER the walk: a backfill adoption inside `lookup()` bumps the
    // version, and that entry is already in the textures.
    lastVersion = readVersion(o);
    return changed;
  }

  /**
   * Min/max ground height over the resident LBs (valid, with heights) that
   * overlap the world rect — per-LB extremes recorded at write time, so a
   * conservative box for tile culling.
   * @param {object} [out] reusable `{min, max}`.
   * @returns {{min:number, max:number}|null} null = no resident LB overlaps.
   */
  function heightRange(x0, y0, x1, y1, out) {
    if (centerX === null || disposed) return null;
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return null;
    let lx0 = Math.floor(Math.min(x0, x1) / LB_M);
    let lx1 = Math.floor(Math.max(x0, x1) / LB_M);
    let ly0 = Math.floor(Math.min(y0, y1) / LB_M);
    let ly1 = Math.floor(Math.max(y0, y1) / LB_M);
    // Valid slots all lie inside the last window: clamp to it (and the world).
    lx0 = Math.max(lx0, centerX - radius, 0);
    lx1 = Math.min(lx1, centerX + radius, 255);
    ly0 = Math.max(ly0, centerY - radius, 0);
    ly1 = Math.min(ly1, centerY + radius, 255);
    let mn = Infinity;
    let mx = -Infinity;
    for (let ly = ly0; ly <= ly1; ly += 1) {
      for (let lx = lx0; lx <= lx1; lx += 1) {
        const s = (ly & 15) * FIELD_SLOTS + (lx & 15);
        if (!slotValid[s] || !slotHasHeights[s] || slotLbX[s] !== lx || slotLbY[s] !== ly) continue;
        if (slotMin[s] < mn) mn = slotMin[s];
        if (slotMax[s] > mx) mx = slotMax[s];
      }
    }
    if (mn === Infinity) return null;
    const r = out || {};
    r.min = mn;
    r.max = mx;
    return r;
  }

  /**
   * JS port of `hbFieldSample` over the same arrays the textures hold.
   * @returns {null | {height:number, normal:{x,y,z}, cornerCodes:Int32Array,
   *   roadEdgeM:number}} `roadEdgeM` is HB_ROAD_NONE (1e9) where the oracle
   *   says Infinity.
   */
  function sampleMirror(x, y, out) {
    return sampleFieldArrays(fieldData, keyData, x, y, out);
  }

  function stats() {
    let slotsValid = 0;
    for (let s = 0; s < SLOT_COUNT; s += 1) slotsValid += slotValid[s];
    return {
      slotsValid,
      writes,
      invalidations,
      uploads,
      walks,
      centerLb: centerX === null ? null : { x: centerX, y: centerY },
      oracleVersion: Number.isFinite(lastVersion) && lastVersion >= 0 ? lastVersion : null,
      windowRadiusLb: radius,
      gpu: !!fieldTex,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    gen = ++_fieldGenSeq;
    for (const t of [fieldTex, keyTex]) {
      if (t) { try { t.dispose(); } catch (_) {} }
    }
    uniforms.uHbField.value = null;
    uniforms.uHbFieldKey.value = null;
    slotEntry.fill(null); // drop references into the oracle cache
    slotValid.fill(0);
    keyData.fill(0);
  }

  return {
    uniforms,
    update,
    heightRange,
    /** A stamp that changes whenever heightRange() could answer differently
     *  (unique across fields). `?hotGrassCull` keys its tile memo on it. */
    generation: () => gen,
    sampleMirror,
    stats,
    dispose,
    // Test seams.
    _fieldData: fieldData,
    _keyData: keyData,
    _fieldTex: fieldTex,
    _keyTex: keyTex,
  };
}
