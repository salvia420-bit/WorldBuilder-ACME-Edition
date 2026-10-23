// scene3d/grass_gpu_place.js — grass PLACEMENT in the vertex shader: the GLSL,
// its line-by-line JS mirror and the per-ring tile culling (2026-10-23,
// `?terrainGrassGpu`; design contract `docs/2026-10-23-grass-gpu-placement.md`
// Module C).
//
// WHAT THIS IS. On the CPU path every grass blade is placed by
// `terrain_scatter.js scatterInstance` + `terrain_grass.js makeGrassFill`:
// jitter a point in its world cell, sample the terrain oracle, reject road /
// interior / non-grass ground, then draw six attributes from the cell's hash
// stream. All of that is a pure function of (world cell, seeds, terrain data),
// so `hbGrassPlace(gl_InstanceID)` recomputes it per vertex instead: no
// per-instance buffers, no per-frame CPU placement, no edge-first drain.
//
// INSTANCE -> CELL. A ring's g x g window of cells is cut into T x T = 8 x 8
// TILES of ts x ts cells (ts = ceil(g / 8), so the last row / column of tiles
// is partial). Instance `id` lives in draw SLOT `id / (ts*ts)`; the slot's tile
// id comes from `uGpTiles` (written per frame by `cullGrassTiles`, nearest tile
// first, -1 = unused) and the remainder picks the cell inside the tile. There
// is no torus here: a blade at world cell (gx, gy) is identical whichever
// instance draws it, so the window maps DIRECTLY (cell = winMin + offset).
// T is a GLSL literal (GRASS_GPU_TILES_PER_ROW), not a uniform (2026-10-23).
//
// TWO HALVES (2026-10-23, review integ-1 / gpu-cost-1). `hbGrassCell(id)` is
// the cheap half (instance -> cell -> jittered point: integer maths and two
// hashes); `hbGrassPlaceCell(cell)` is the rest (terrain fetches, the interior
// bucket walk, the hash chain). `hbGrassPlace(id)` is exactly the two in a row.
// The grass snippet (terrain_grass.js) calls the halves itself so a blade its
// distance blend or dissolve would scale to zero never pays for the second.
//
// THE CONTRACT. Same live set per world cell as the CPU pool for the same
// layout, seeds and terrain; same origin, normal, (height, width), yaw, tint,
// mat and rank. Tolerated: f32 rounding only. `test_grass_gpu_place.mjs` holds
// the mirror against the REAL CPU provider's pools on real Holtburg landblocks.
//
// THE MIRROR. `grassGpuPlaceMirror` is a line-by-line JS port of
// `hbGrassPlace` (same names, same branch order — keep them in lockstep when
// either is edited). By default it rounds the positional chain to f32 with
// `Math.fround` the way the shader evaluates it (x, y, the cell fractions, the
// dither weights, the verge ramp), so its disagreement with the CPU estimates
// the GPU's; `{ f64: true }` runs the same algorithm in doubles (the CPU's own
// arithmetic) and must agree with the pool to the last decision. The hash is
// the GLSL's: 32-bit integer maths, then the TOP 24 BITS as the [0, 1) float
// (always < 1.0 in f32; the CPU divides the full u32 by 2^32 — a <= 2^-24
// difference).
//
// THE TABLE. `buildGrassPlaceGlsl()` GENERATES the variant table from
// `GRASS_VARIANTS` intersected with `familyForCode(code) === FAM_GRASS` as GLSL
// branches with literal constants — no uniform arrays, so the vertex uniform
// count stays low and every ring shares ONE program.
//
// CULLING. `cullGrassTiles` is the tile cull the single InstancedMesh never had
// (`frustumCulled = false`: blades behind the camera paid the vertex shader in
// full, and grass is vertex-bound). Pure maths, no THREE, no allocation. Its
// blade margins come from `grassGpuBladeReach` over the live look (2026-10-23,
// review integ-2), never below the 2 m constants.
//
// IMPORT ORDER. `terrain_grass.js` will import this module and this module
// imports `GRASS_VARIANTS` / `GRASS_DEFAULTS` from it — an ESM cycle. So
// nothing here reads a `terrain_grass.js` binding at module top level (only
// inside functions), and `terrain_grass.js` must read this module's CONSTANT
// exports (`GRASS_GPU_HASH_GLSL`, ...) inside functions too, not at its own top
// level. Function exports are hoisted and safe either way.
//
// INVARIANTS. No `Math.random`, no clocks: placement is a pure function of its
// inputs. No light, no program-cache-key variation, no THREE (strings + maths).
//
// GLSL rules (house): every GLSL string is plain ASCII inside the GLSL ES
// source character set — NO BACKTICKS, no quotes or apostrophes, even in
// comments — and needs GLSL ES 3.00 (uint, texelFetch via the field module).

import { GRASS_VARIANTS, GRASS_DEFAULTS, GRASS_BLADE_POSITIONS } from "./terrain_grass.js";
import { FAM_GRASS, familyForCode, TERRAIN_CODE_COUNT } from "./terrain_families.js";
import { SCATTER_DEFAULTS, gridSizeFor, cellSizeFor } from "./terrain_scatter.js";

// ---------------------------------------------------------------------------
// Layout constants.
// ---------------------------------------------------------------------------

/**
 * Tiles per row of a ring's window (T); the window is T x T tiles. Emitted
 * into the placement GLSL as a LITERAL (a power of two, so the tile divide and
 * remainder need no runtime integer division); there is no uniform for it.
 */
export const GRASS_GPU_TILES_PER_ROW = 8;
/** Draw slots per ring = the length of `uGpTiles` as floats (vec4[16]). */
export const GRASS_GPU_MAX_TILES = GRASS_GPU_TILES_PER_ROW * GRASS_GPU_TILES_PER_ROW; // 64
/**
 * Blade margin of a tile's culling box below / above its terrain range (m).
 * ABOVE is the default of `p.zAboveM` and the FLOOR of the live margin the
 * provider passes (2026-10-23: `grassGpuBladeReach`, see integ-2 there).
 */
export const GRASS_GPU_CULL_BELOW_M = 0.5;
export const GRASS_GPU_CULL_ABOVE_M = 2.0;
/**
 * Sideways blade margin of the FRUSTUM box only (m; `p.xyMarginM` overrides).
 * A blade's geometry reaches past its origin — lean, bow, wind, stomp splay and
 * an outer ring's widened blades — so a tile whose ORIGINS are just outside a
 * side plane can still draw a sliver on the screen edge. 2 m holds the DEFAULT
 * look (ultra ring 3 reaches ~1.55 m); `setLod()` and `?treeWindStrength` reach
 * further, so the provider passes `max(this, grassGpuBladeReach().lateralM)`
 * (2026-10-23, review integ-2) and this is the floor. The disc and hole tests
 * need no margin: a blade at the rim already has zero scale there.
 */
export const GRASS_GPU_CULL_XY_MARGIN_M = 2.0;
/** The dissolve rank's hash channel: makeGrassFill `ctx.rand(7)`. */
const RANK_CHANNEL = 7;
/**
 * The blade's (height, width) jitter of makeGrassFill: h x (0.7 + 0.6 r),
 * w x (0.85 + 0.3 r), r in [0, 1). Generated into the GLSL and the mirror, and
 * read by `grassGpuBladeReach` (the tallest blade is h x 1.3).
 */
const BLADE_H_JITTER = Object.freeze([0.7, 0.6]);
const BLADE_W_JITTER = Object.freeze([0.85, 0.3]);
/** Bare-clump size, metres — terrain_grass.js GRASS_CLUMP_M (module-private there). */
const GRASS_CLUMP_M = 2;
/** The off-road verge draw's hash slot — terrain_scatter.js ROAD_HASH_SLOT. */
const ROAD_HASH_SLOT = 3;
/** Field stand-in for "no road corner" (terrain_field_gpu.js HB_ROAD_NONE). */
const ROAD_NONE = 1e9;
const TWO_PI = 6.283185307179586;
const f32 = Math.fround;
const f64 = (v) => v;

/** The per-ring uniforms `buildGrassPlaceGlsl()` declares, in declaration order. */
export const GRASS_GPU_RING_UNIFORMS = Object.freeze([
  "uGpWindowMin", "uGpGrid", "uGpCellSize", "uGpJitter", "uGpTileSide",
  "uGpTiles", "uGpSeed", "uGpRandSeed", "uGpBaseSeed",
  "uGpHeightOffset", "uGpOffRoad", "uGpVergeM",
]);

/** A JS number as a GLSL float literal (always carries a '.' or exponent). */
function glf(v) {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

// ---------------------------------------------------------------------------
// The hash — bit-identical to terrain_scatter.js scatterHashU32.
// ---------------------------------------------------------------------------

/**
 * FNV-1a over three words + the murmur3 fmix32 avalanche, highp uint (wraps
 * mod 2^32 in GLSL ES 3.00, exactly like `Math.imul` + `>>> 0`). Integer
 * arguments go through `uint(int)`, which preserves the bit pattern — the
 * same thing `a | 0` does on the CPU — so negative cells hash identically.
 */
export const GRASS_GPU_HASH_GLSL = [
  "// ==== GRASS GPU HASH (scene3d/grass_gpu_place.js) ====",
  "// Bit identical to terrain_scatter scatterHashU32: FNV 1a over three words",
  "// plus the murmur3 fmix32 avalanche. highp uint arithmetic wraps mod 2^32.",
  "highp uint hbHashU32(highp uint a, highp uint b, highp uint c, highp uint seed) {",
  "  highp uint h = seed ^ 2166136261u;",
  "  h = (h ^ a) * 16777619u;",
  "  h = (h ^ b) * 16777619u;",
  "  h = (h ^ c) * 16777619u;",
  "  h ^= h >> 16u;",
  "  h *= 2246822507u;",
  "  h ^= h >> 13u;",
  "  h *= 3266489909u;",
  "  h ^= h >> 16u;",
  "  return h;",
  "}",
  "// The top 24 bits as a float in [0, 1): exact in f32, so always below 1.0.",
  "highp float hbHash01(highp int a, highp int b, highp int c, highp uint seed) {",
  "  return float(hbHashU32(uint(a), uint(b), uint(c), seed) >> 8u) * (1.0 / 16777216.0);",
  "}",
  "",
].join("\n");

/** JS mirror of GLSL `hbHashU32` (u32 out). */
export function grassGpuHashU32(a, b, c, seed) {
  let h = ((seed >>> 0) ^ 2166136261) >>> 0;
  h = Math.imul(h ^ (a >>> 0), 16777619) >>> 0;
  h = Math.imul(h ^ (b >>> 0), 16777619) >>> 0;
  h = Math.imul(h ^ (c >>> 0), 16777619) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 2246822507) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 3266489909) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/** JS mirror of GLSL `hbHash01`: the top 24 bits, exact in f32, < 1. */
export function grassGpuHash01(a, b, c, seed) {
  return (grassGpuHashU32(a, b, c, seed) >>> 8) * (1 / 16777216);
}

// ---------------------------------------------------------------------------
// The variant table (generated, lazily — see IMPORT ORDER in the header).
// ---------------------------------------------------------------------------

let _variants = null;

/**
 * Codes 0..31 -> `{ h, w, keep, bare, tint, mat }` or null: GRASS_VARIANTS
 * restricted to codes whose family is FAM_GRASS — exactly the two dead-checks
 * of `makeGrassFill` (`familyForCode(code) !== FAM_GRASS`, `!GRASS_VARIANTS[code]`).
 */
function variantTable() {
  if (_variants) return _variants;
  const t = new Array(TERRAIN_CODE_COUNT).fill(null);
  for (let code = 0; code < TERRAIN_CODE_COUNT; code += 1) {
    const v = GRASS_VARIANTS[code];
    if (v && familyForCode(code) === FAM_GRASS) t[code] = v;
  }
  _variants = t;
  return t;
}

/** The codes the generated GLSL table plants on, ascending (tests / diag). */
export function grassGpuVariantCodes() {
  const out = [];
  const t = variantTable();
  for (let code = 0; code < t.length; code += 1) if (t[code]) out.push(code);
  return out;
}

let _variantMax = null;

/** The tallest `h` and the widest `w` the generated table can plant (lazy). */
function variantMax() {
  if (_variantMax) return _variantMax;
  let h = 0, w = 0;
  for (const v of variantTable()) {
    if (!v) continue;
    if (v.h > h) h = v.h;
    if (v.w > w) w = v.w;
  }
  _variantMax = { h, w };
  return _variantMax;
}

// ---------------------------------------------------------------------------
// The placement GLSL.
// ---------------------------------------------------------------------------

/**
 * The placement half of the grass GPU shader: per-ring uniforms, the generated
 * variant table, `struct HbBlade`, `struct HbCell` and the functions
 *   `HbCell hbGrassCell(int id)`        instance -> world cell -> jittered point
 *   `float hbGrassRank(HbCell c)`       the cell's dissolve rank (= blade rank)
 *   `HbBlade hbGrassDead(HbCell c)`     the dead blade of a cell
 *   `HbBlade hbGrassPlaceCell(HbCell c)` steps 2..10
 *   `HbBlade hbGrassPlace(int id)`      = hbGrassPlaceCell(hbGrassCell(id))
 * Valid in the vertex and fragment stages (GLSL ES 3.00). REQUIRES, in this
 * order, before it: `GRASS_GPU_HASH_GLSL`, `TERRAIN_FIELD_GLSL`
 * (`hbFieldSample`) and `INTERIOR_MASK_GLSL` (`hbIndoorAt`) — and nothing else:
 * the distance blend / dissolve uniforms are the grass snippet's business, so a
 * standalone readback program compiles this as is. Rebuilt per call (cheap);
 * the output is a pure function of GRASS_VARIANTS + the family LUT, so every
 * ring and every material compiles the same source = one program.
 *
 * 2026-10-23 (review gpu-cost-1): the interior test runs LAST, after the cheap
 * variant / bare / thinning rejections. Safe by construction: every rejection
 * returns the same dead blade (`hbGrassDead`, untouched until step 10); every
 * test is a side-effect-free predicate of values computed before it; and the
 * interior test reads only x, y and height (known after step 2) and writes
 * nothing a later step reads. So the live set is the AND of the same
 * predicates in either order and step 10 sees the same inputs.
 * @returns {string}
 */
export function buildGrassPlaceGlsl() {
  const table = variantTable();
  const branches = [];
  for (let code = 0; code < table.length; code += 1) {
    const v = table[code];
    if (!v) continue;
    branches.push(
      `  if (code == ${code}) { shape = vec4(${glf(v.h)}, ${glf(v.w)}, ${glf(v.keep)}, ${glf(v.bare)}); `
      + `look = vec4(${glf(v.tint[0])}, ${glf(v.tint[1])}, ${glf(v.tint[2])}, ${glf(v.mat)}); return true; }`,
    );
  }
  const T = GRASS_GPU_TILES_PER_ROW;
  return [
    "// ==== GRASS GPU PLACEMENT (scene3d/grass_gpu_place.js) ====",
    "// Needs GRASS_GPU_HASH_GLSL, TERRAIN_FIELD_GLSL and INTERIOR_MASK_GLSL before it.",
    "// Per ring uniforms: one bag per ring, one program for every ring.",
    "uniform vec2 uGpWindowMin;",
    "uniform float uGpGrid;",
    "uniform float uGpCellSize;",
    "uniform float uGpJitter;",
    "uniform float uGpTileSide;",
    `uniform vec4 uGpTiles[${GRASS_GPU_MAX_TILES / 4}];`,
    "uniform highp uint uGpSeed;",
    "uniform highp uint uGpRandSeed;",
    "uniform highp uint uGpBaseSeed;",
    "uniform float uGpHeightOffset;",
    "uniform float uGpOffRoad;",
    "uniform float uGpVergeM;",
    "",
    "// Grass variants, GENERATED from terrain_grass GRASS_VARIANTS (FAM_GRASS codes).",
    "// shape = (height, width, keep, bare), look = (tint rgb, mat). false = no blade.",
    "bool hbGrassVariant(int code, out vec4 shape, out vec4 look) {",
    "  shape = vec4(0.0);",
    "  look = vec4(0.0);",
    ...branches,
    "  return false;",
    "}",
    "",
    "struct HbBlade { bool live; vec3 origin; vec3 normal; vec2 scale; float rot; vec3 tint; float mat; float rank; };",
    "// The world cell an instance draws (mapped false: an unused slot or partial",
    "// tile padding) and the jittered blade point in it (zero when unmapped).",
    "struct HbCell { bool mapped; ivec2 g; vec2 xy; };",
    "",
    "// The CPU fill context rand(ch): hash slot ch + 16 on the ring rand seed.",
    "float hbGpRand(int gx, int gy, int ch) {",
    "  return hbHash01(gx, gy, ch + 16, uGpRandSeed);",
    "}",
    "",
    "// Instance to draw slot to tile to window cell, then step 1. The cheap half:",
    "// integer maths and two hashes, no texture.",
    "HbCell hbGrassCell(int id) {",
    "  HbCell hc;",
    "  hc.mapped = false;",
    "  hc.g = ivec2(0);",
    "  hc.xy = vec2(0.0);",
    "  int ts = int(uGpTileSide + 0.5);",
    "  int g = int(uGpGrid + 0.5);",
    "  int n = ts * ts;",
    "  if (id < 0 || n <= 0) return hc;",
    "  int slot = id / n;",
    "  int li = id - slot * n;",
    `  if (slot >= ${GRASS_GPU_MAX_TILES}) return hc;`,
    "  float ft = uGpTiles[slot >> 2][slot & 3];",
    "  if (ft < 0.0) return hc;",
    "  // Tiles per row: a literal power of two, so no runtime integer division.",
    "  int tile = int(ft + 0.5);",
    `  int ox = (tile % ${T}) * ts + li % ts;`,
    `  int oy = (tile / ${T}) * ts + li / ts;`,
    "  if (ox >= g || oy >= g) return hc;",
    "  ivec2 wm = ivec2(floor(uGpWindowMin + 0.5));",
    "  int gx = wm.x + ox;",
    "  int gy = wm.y + oy;",
    "  // 1. The jittered point in its cell (terrain_scatter scatterInstance).",
    "  float jx = uGpJitter > 0.0 ? (hbHash01(gx, gy, 1, uGpSeed) - 0.5) * uGpJitter : 0.0;",
    "  float jy = uGpJitter > 0.0 ? (hbHash01(gx, gy, 2, uGpSeed) - 0.5) * uGpJitter : 0.0;",
    "  float x = (float(gx) + 0.5 + jx) * uGpCellSize;",
    "  float y = (float(gy) + 0.5 + jy) * uGpCellSize;",
    "  hc.mapped = true;",
    "  hc.g = ivec2(gx, gy);",
    "  hc.xy = vec2(x, y);",
    "  return hc;",
    "}",
    "",
    "// The dissolve rank of a cell (makeGrassFill rand 7): the blade rank AND what",
    "// the grass snippet early out tests, from this one function.",
    "float hbGrassRank(HbCell hc) {",
    `  return hbGpRand(hc.g.x, hc.g.y, ${RANK_CHANNEL});`,
    "}",
    "",
    "// The dead blade of a cell: every field defined, the origin on the jittered",
    "// point at z 0 (all zero when unmapped). Its five vertices collapse onto it.",
    "HbBlade hbGrassDead(HbCell hc) {",
    "  HbBlade b;",
    "  b.live = false;",
    "  b.origin = vec3(hc.xy, 0.0);",
    "  b.normal = vec3(0.0, 0.0, 1.0);",
    "  b.scale = vec2(0.0);",
    "  b.rot = 0.0;",
    "  b.tint = vec3(0.0);",
    "  b.mat = 0.0;",
    "  b.rank = 0.0;",
    "  return b;",
    "}",
    "",
    "// Steps 2 to 10 for one cell. Every rejection returns the dead blade, which",
    "// nothing touches before step 10, and every test reads only values computed",
    "// before it: the order cannot change a blade, so the interior bucket walk",
    "// (the costliest test in a town) runs last.",
    "HbBlade hbGrassPlaceCell(HbCell hc) {",
    "  HbBlade b = hbGrassDead(hc);",
    "  if (!hc.mapped) return b;",
    "  int gx = hc.g.x;",
    "  int gy = hc.g.y;",
    "  float x = hc.xy.x;",
    "  float y = hc.xy.y;",
    "  // 2. Ground. An unresident or off world landblock, or no heights: dead.",
    "  float height;",
    "  vec3 nrm;",
    "  ivec4 cc;",
    "  float edge;",
    "  if (!hbFieldSample(vec2(x, y), height, nrm, cc, edge)) return b;",
    "  // 3. Off road: never on the painted road, thinning linearly over the verge.",
    "  if (uGpOffRoad > 0.5 && edge < uGpVergeM) {",
    "    float p = edge <= 0.0 ? 1.0 : 1.0 - edge / uGpVergeM;",
    `    if (p >= 1.0 || hbHash01(gx, gy, ${ROAD_HASH_SLOT}, uGpRandSeed) < p) return b;`,
    "  }",
    "  // 4. Buried a little so no blade floats on a slope.",
    "  float z = height + uGpHeightOffset;",
    "  // 5. Corner code dither over the cell corners (terrain_grass ditherCornerCode).",
    "  float fx = x / 24.0 - floor(x / 24.0);",
    "  float fy = y / 24.0 - floor(y / 24.0);",
    "  float wSW = (1.0 - fx) * (1.0 - fy);",
    "  float wSE = fx * (1.0 - fy);",
    "  float wNW = (1.0 - fx) * fy;",
    "  float r = hbGpRand(gx, gy, 5);",
    "  int code = cc.w;",
    "  if (r < wSW) {",
    "    code = cc.x;",
    "  } else {",
    "    r -= wSW;",
    "    if (r < wSE) {",
    "      code = cc.y;",
    "    } else {",
    "      r -= wSE;",
    "      if (r < wNW) code = cc.z;",
    "    }",
    "  }",
    "  // 6. A grass variant, or nothing.",
    "  vec4 shape;",
    "  vec4 look;",
    "  if (!hbGrassVariant(code, shape, look)) return b;",
    "  // 7. Bare clumps: world metre clumps on the BASE seed, shared by every ring.",
    `  if (shape.w > 0.0 && hbHash01(int(floor(x / ${glf(GRASS_CLUMP_M)})), int(floor(y / ${glf(GRASS_CLUMP_M)})), 9, uGpBaseSeed) < shape.w) return b;`,
    "  // 8. Per blade thinning.",
    "  if (shape.z < 1.0 && hbGpRand(gx, gy, 4) > shape.z) return b;",
    "  // 9. Never inside a building interior (the ground point, worldRoot local).",
    "  if (hbIndoorAt(vec3(x, y, height))) return b;",
    "  // 10. The blade (terrain_grass makeGrassFill).",
    "  float shade = 0.82 + 0.36 * hbGpRand(gx, gy, 3);",
    "  float warm = 0.94 + 0.12 * hbGpRand(gx, gy, 6);",
    "  b.live = true;",
    "  b.origin = vec3(x, y, z);",
    "  b.normal = nrm;",
    `  b.scale = vec2(shape.x * (${glf(BLADE_H_JITTER[0])} + ${glf(BLADE_H_JITTER[1])} * hbGpRand(gx, gy, 1)), `
      + `shape.y * (${glf(BLADE_W_JITTER[0])} + ${glf(BLADE_W_JITTER[1])} * hbGpRand(gx, gy, 2)));`,
    `  b.rot = hbGpRand(gx, gy, 0) * ${glf(TWO_PI)};`,
    "  b.tint = vec3(look.x * shade * warm, look.y * shade, look.z * shade * (2.0 - warm));",
    "  b.mat = look.w;",
    "  b.rank = hbGrassRank(hc);",
    "  return b;",
    "}",
    "",
    "// One blade per instance; a dead blade has live == false (collapse it).",
    "HbBlade hbGrassPlace(int id) {",
    "  return hbGrassPlaceCell(hbGrassCell(id));",
    "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Ring state — the uniform values, exactly as the CPU pool would derive them.
// ---------------------------------------------------------------------------

/** `terrain_scatter.js _num`, verbatim: the pool's option clamp. */
function _num(v, fallback, lo, hi) {
  const n = Number.isFinite(v) ? v : fallback;
  if (Number.isFinite(lo) && n < lo) return lo;
  if (Number.isFinite(hi) && n > hi) return hi;
  return n;
}

/**
 * The uniform values for ONE ring, computed from the layout exactly as
 * `createTerrainGrassProvider` + `createScatterPool` compute them: the grid
 * side (count rounded UP to a square), the radius clamp, `cell = 2W/g`, the
 * ring seed, `randSeed` from seed + randSalt (the pool's golden-ratio fold),
 * the provider's BASE seed (bare clumps), jitter 1, heightOffsetM -0.02.
 *
 * `winMin` (Float32Array(2), integer-valued cell indices) and `tileIds`
 * (Float32Array(64), identity = every tile, in tile order) are MUTABLE and are
 * meant to be bound by reference as `uGpWindowMin` / `uGpTiles`
 * (`createGrassGpuRingUniforms`): `grassGpuSetWindow` and `cullGrassTiles`
 * write them in place.
 *
 * No dissolve band here (2026-10-23, review lifecycle-3): `applyGrassLodLook`
 * REPLACES `ring.band` on every `setLodLook`, so a copy taken at build goes
 * stale. Readers take the live `ring.band` (the provider's cull does).
 *
 * @param {object} ring one `grassLodLayout()` entry
 * @param {object} [cfg] the resolved grass config (`resolveGrassConfig` /
 *   `provider.quality()`): `seed` (base seed), `offRoad`
 */
export function grassGpuRingState(ring, cfg) {
  const r = ring || {};
  const c = cfg || {};
  const g = gridSizeFor(_num(r.count, SCATTER_DEFAULTS.count, 1, 4194304));
  const radiusM = _num(r.radiusM, SCATTER_DEFAULTS.radiusM, 1, 4096);
  const cell = cellSizeFor(radiusM, g);
  const T = GRASS_GPU_TILES_PER_ROW;
  const ts = Math.ceil(g / T);
  const seed = (Number.isFinite(r.seed) ? r.seed : SCATTER_DEFAULTS.seed) | 0;
  const randSalt = (Number.isFinite(r.randSalt) ? r.randSalt : 0) | 0;
  const randSeed = randSalt === 0 ? seed : (seed ^ Math.imul(randSalt, 0x9e3779b9)) | 0;
  const baseSeed = Number.isFinite(c.seed) ? c.seed | 0 : GRASS_DEFAULTS.seed;
  const fadeFraction = _num(r.fadeFraction, SCATTER_DEFAULTS.fadeFraction, 0, 1);
  const tileIds = new Float32Array(GRASS_GPU_MAX_TILES);
  for (let t = 0; t < GRASS_GPU_MAX_TILES; t += 1) tileIds[t] = t;
  return {
    level: Number.isFinite(r.level) ? r.level : 0,
    g,
    count: g * g,
    radiusM,
    cell,
    // The cull's tiles per row; the GLSL has it as a literal (always this).
    T,
    ts,
    // Instances drawing every tile (an upper bound; the cull draws fewer).
    maxInstances: T * T * ts * ts,
    seed,
    randSalt,
    randSeed,
    baseSeed,
    // As the `uint` uniforms want them (three uploads UNSIGNED_INT via uniform1ui).
    seedU32: seed >>> 0,
    randSeedU32: randSeed >>> 0,
    baseSeedU32: baseSeed >>> 0,
    // The pool defaults grass never overrides.
    jitter: _num(undefined, SCATTER_DEFAULTS.jitter, 0, 1),
    heightOffsetM: _num(GRASS_DEFAULTS.heightOffsetM, SCATTER_DEFAULTS.heightOffsetM, -4096, 4096),
    offRoad: c.offRoad === true,
    vergeM: _num(GRASS_DEFAULTS.roadVergeM, SCATTER_DEFAULTS.offRoadVergeM, 0, 24),
    // Distance blend (uScatterRadius / uScatterFadeStart). The dissolve band
    // is NOT copied: read the live ring.band (see above).
    fadeFraction,
    fadeStartM: radiusM * (1 - fadeFraction),
    winMin: new Float32Array(2),
    tileIds,
  };
}

/**
 * The window's minimum cell index on one axis — `terrain_scatter.js
 * windowMinCell` verbatim: `floor((center - W) / cell)`. Pass a number for one
 * axis, or `{x, y}` / `[x, y]` for both (written into `out`, default a new
 * array, and returned).
 */
export function grassGpuWindowMin(center, W, cell, out) {
  if (typeof center === "number") return Math.floor((center - W) / cell);
  const cx = Array.isArray(center) || ArrayBuffer.isView(center) ? center[0] : center.x;
  const cy = Array.isArray(center) || ArrayBuffer.isView(center) ? center[1] : center.y;
  const o = out || [0, 0];
  o[0] = Math.floor((cx - W) / cell);
  o[1] = Math.floor((cy - W) / cell);
  return o;
}

/** Re-centre a ring: writes `state.winMin` in place (the bound uniform). */
export function grassGpuSetWindow(state, cx, cy) {
  state.winMin[0] = Math.floor((cx - state.radiusM) / state.cell);
  state.winMin[1] = Math.floor((cy - state.radiusM) / state.cell);
  return state.winMin;
}

/**
 * A ring's uniform bag for `buildGrassPlaceGlsl()`'s declarations, every entry
 * a fresh `{value}`. `uGpWindowMin` / `uGpTiles` hold `state.winMin` /
 * `state.tileIds` BY REFERENCE (three uploads a Float32Array as a vec2 / a
 * vec4[16] directly), so `grassGpuSetWindow` / `cullGrassTiles` need no copy.
 */
export function createGrassGpuRingUniforms(state) {
  return {
    uGpWindowMin: { value: state.winMin },
    uGpGrid: { value: state.g },
    uGpCellSize: { value: state.cell },
    uGpJitter: { value: state.jitter },
    uGpTileSide: { value: state.ts },
    uGpTiles: { value: state.tileIds },
    uGpSeed: { value: state.seedU32 },
    uGpRandSeed: { value: state.randSeedU32 },
    uGpBaseSeed: { value: state.baseSeedU32 },
    uGpHeightOffset: { value: state.heightOffsetM },
    uGpOffRoad: { value: state.offRoad ? 1 : 0 },
    uGpVergeM: { value: state.vergeM },
  };
}

// ---------------------------------------------------------------------------
// The mirror — hbGrassCell / hbGrassRank / hbGrassDead / hbGrassPlaceCell /
// hbGrassPlace, line for line.
// ---------------------------------------------------------------------------

/** A blank cell record (`struct HbCell`: mapped, g = (gx, gy), xy = (x, y)). */
export function makeGrassGpuCell() {
  return { mapped: false, gx: 0, gy: 0, x: 0, y: 0 };
}

/** A blank blade record (the mirror's `out`). */
export function makeGrassGpuBlade() {
  return {
    live: false,
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    scale: { x: 0, y: 0 },
    rot: 0,
    tint: { x: 0, y: 0, z: 0 },
    mat: 0,
    rank: 0,
    // Not in the GLSL struct: the world cell this instance maps to (mapped =
    // false when the instance maps to none — unused slot, partial tile).
    mapped: false,
    cellX: 0,
    cellY: 0,
  };
}

const _sampleScratch = {};
const _cellScratch = makeGrassGpuCell();

/**
 * JS port of GLSL `hbGrassCell(id)` for one ring: the world cell instance `id`
 * draws and the jittered blade point in it (all zero, mapped false, when it
 * draws none).
 *
 * @param {number} id instance index (gl_InstanceID)
 * @param {object} ring `grassGpuRingState()` (`winMin`, `g`, `cell`, `jitter`,
 *   `ts`, `tileIds`, `seed`; T is the GRASS_GPU_TILES_PER_ROW literal)
 * @param {object} [out] a `makeGrassGpuCell()` record to reuse
 * @param {{f64?: boolean}} [opts] as `grassGpuPlaceMirror`
 * @returns {object} `out`
 */
export function grassGpuCellMirror(id, ring, out, opts) {
  const F = opts && opts.f64 === true ? f64 : f32;
  const hc = out || makeGrassGpuCell();
  hc.mapped = false;
  hc.gx = 0;
  hc.gy = 0;
  hc.x = 0;
  hc.y = 0;
  const ts = Math.trunc(f32(ring.ts) + 0.5);
  const g = Math.trunc(f32(ring.g) + 0.5);
  const n = ts * ts;
  if (id < 0 || n <= 0) return hc;
  const slot = Math.trunc(id / n);
  const li = id - slot * n;
  if (slot >= GRASS_GPU_MAX_TILES) return hc;
  const ft = f32(ring.tileIds[slot]);   // uGpTiles[slot >> 2][slot & 3]
  if (ft < 0) return hc;
  // Tiles per row: a literal power of two, so no runtime integer division.
  const tile = Math.trunc(ft + 0.5);
  const ox = (tile % GRASS_GPU_TILES_PER_ROW) * ts + (li % ts);
  const oy = Math.trunc(tile / GRASS_GPU_TILES_PER_ROW) * ts + Math.trunc(li / ts);
  if (ox >= g || oy >= g) return hc;
  const wmx = Math.floor(f32(ring.winMin[0]) + 0.5);
  const wmy = Math.floor(f32(ring.winMin[1]) + 0.5);
  const gx = wmx + ox;
  const gy = wmy + oy;
  // 1. The jittered point in its cell (terrain_scatter scatterInstance).
  const jitter = F(ring.jitter);
  const cell = F(ring.cell);
  const jx = jitter > 0 ? F((grassGpuHash01(gx, gy, 1, ring.seed) - 0.5) * jitter) : 0;
  const jy = jitter > 0 ? F((grassGpuHash01(gx, gy, 2, ring.seed) - 0.5) * jitter) : 0;
  const x = F(F(F(gx + 0.5) + jx) * cell);
  const y = F(F(F(gy + 0.5) + jy) * cell);
  hc.mapped = true;
  hc.gx = gx;
  hc.gy = gy;
  hc.x = x;
  hc.y = y;
  return hc;
}

/** JS port of GLSL `hbGrassRank(cell)`: the blade rank of a mapped cell. */
export function grassGpuRankMirror(hc, ring) {
  return grassGpuHash01(hc.gx, hc.gy, RANK_CHANNEL + 16, ring.randSeed);
}

/** JS port of GLSL `hbGrassDead(cell)` into `b` (+ mapped / cellX / cellY). */
function _deadBlade(b, hc) {
  b.live = false;
  b.origin.x = hc.x; b.origin.y = hc.y; b.origin.z = 0;
  b.normal.x = 0; b.normal.y = 0; b.normal.z = 1;
  b.scale.x = 0; b.scale.y = 0;
  b.rot = 0;
  b.tint.x = 0; b.tint.y = 0; b.tint.z = 0;
  b.mat = 0;
  b.rank = 0;
  b.mapped = hc.mapped;
  b.cellX = hc.gx;
  b.cellY = hc.gy;
  return b;
}

/**
 * JS port of GLSL `hbGrassPlace(id)` for one ring (= `grassGpuPlaceCellMirror`
 * over `grassGpuCellMirror`, exactly as the GLSL composes them).
 *
 * @param {number} id instance index (gl_InstanceID)
 * @param {object} ring the ring's uniform values — `grassGpuRingState()`
 *   (`winMin`, `g`, `cell`, `jitter`, `ts`, `tileIds`, `seed`,
 *   `randSeed`, `baseSeed`, `heightOffsetM`, `offRoad`, `vergeM`)
 * @param {object} terrain anything with `sampleMirror(x, y, out?)` ->
 *   null | `{height, normal:{x,y,z}, cornerCodes:[SW,SE,NW,NE], roadEdgeM}`
 *   (`terrain_field_gpu.js`, or an adapter over `oracle.sample()` with
 *   Infinity mapped to 1e9 and null for an LB without heights)
 * @param {object|null} indoor anything with `gpuContainsMirror(x, y, z)`, or null
 * @param {object} [out] a `makeGrassGpuBlade()` record to reuse
 * @param {{f64?: boolean}} [opts] `f64: true` = doubles throughout (the CPU's
 *   arithmetic); default = the positional chain rounded to f32 like the GPU.
 *   Scalar outputs get one f32 rounding at the end either way (a GPU may fuse
 *   multiply-adds, so per-op emulation of those would buy nothing).
 * @returns {object} `out` (fields of `struct HbBlade` + mapped / cellX / cellY)
 */
export function grassGpuPlaceMirror(id, ring, terrain, indoor, out, opts) {
  return grassGpuPlaceCellMirror(grassGpuCellMirror(id, ring, _cellScratch, opts), ring, terrain, indoor, out, opts);
}

/**
 * JS port of GLSL `hbGrassPlaceCell(cell)`: steps 2..10 for a
 * `grassGpuCellMirror` record. Arguments as `grassGpuPlaceMirror`.
 * @returns {object} `out`
 */
export function grassGpuPlaceCellMirror(hc, ring, terrain, indoor, out, opts) {
  const F = opts && opts.f64 === true ? f64 : f32;
  const b = _deadBlade(out || makeGrassGpuBlade(), hc);
  if (!hc.mapped) return b;
  const gx = hc.gx;
  const gy = hc.gy;
  const x = hc.x;
  const y = hc.y;
  // 2. Ground. An unresident or off world landblock, or no heights: dead.
  const s = terrain && typeof terrain.sampleMirror === "function"
    ? terrain.sampleMirror(x, y, _sampleScratch)
    : null;
  if (!s) return b;
  const height = s.height;
  const nrm = s.normal;
  const cc = s.cornerCodes;
  const edge = Number.isFinite(s.roadEdgeM) ? s.roadEdgeM : ROAD_NONE;
  // 3. Off road: never on the painted road, thinning linearly over the verge.
  const verge = F(ring.vergeM);
  if (ring.offRoad && edge < verge) {
    const p = edge <= 0 ? 1 : F(1 - F(edge / verge));
    if (p >= 1 || grassGpuHash01(gx, gy, ROAD_HASH_SLOT, ring.randSeed) < p) return b;
  }
  // 4. Buried a little so no blade floats on a slope.
  const z = F(height + F(ring.heightOffsetM));
  // 5. Corner code dither over the cell corners (terrain_grass ditherCornerCode).
  const x24 = F(x / 24);
  const y24 = F(y / 24);
  const fx = F(x24 - Math.floor(x24));
  const fy = F(y24 - Math.floor(y24));
  const wSW = F(F(1 - fx) * F(1 - fy));
  const wSE = F(fx * F(1 - fy));
  const wNW = F(F(1 - fx) * fy);
  const rand = (ch) => grassGpuHash01(gx, gy, ch + 16, ring.randSeed);
  let r = rand(5);
  let code = cc[3];
  if (r < wSW) {
    code = cc[0];
  } else {
    r = F(r - wSW);
    if (r < wSE) {
      code = cc[1];
    } else {
      r = F(r - wSE);
      if (r < wNW) code = cc[2];
    }
  }
  // 6. A grass variant, or nothing.
  const v = variantTable()[code & 0x1f];
  if (!v || code < 0 || code >= TERRAIN_CODE_COUNT) return b;
  // 7. Bare clumps: world metre clumps on the BASE seed, shared by every ring.
  const bare = F(v.bare);
  if (bare > 0
    && grassGpuHash01(Math.floor(F(x / GRASS_CLUMP_M)), Math.floor(F(y / GRASS_CLUMP_M)), 9, ring.baseSeed) < bare) {
    return b;
  }
  // 8. Per blade thinning.
  const keep = F(v.keep);
  if (keep < 1 && rand(4) > keep) return b;
  // 9. Never inside a building interior (the ground point, worldRoot local).
  if (indoor && typeof indoor.gpuContainsMirror === "function" && indoor.gpuContainsMirror(x, y, height)) return b;
  // 10. The blade (terrain_grass makeGrassFill).
  const shade = 0.82 + 0.36 * rand(3);
  const warm = 0.94 + 0.12 * rand(6);
  b.live = true;
  b.origin.z = z;
  b.normal.x = F(nrm ? nrm.x : 0);
  b.normal.y = F(nrm ? nrm.y : 0);
  b.normal.z = F(nrm ? nrm.z : 1);
  b.scale.x = F(v.h * (BLADE_H_JITTER[0] + BLADE_H_JITTER[1] * rand(1)));
  b.scale.y = F(v.w * (BLADE_W_JITTER[0] + BLADE_W_JITTER[1] * rand(2)));
  b.rot = F(rand(0) * TWO_PI);
  b.tint.x = F(v.tint[0] * shade * warm);
  b.tint.y = F(v.tint[1] * shade);
  b.tint.z = F(v.tint[2] * shade * (2 - warm));
  b.mat = F(v.mat);
  b.rank = F(grassGpuRankMirror(hc, ring));
  return b;
}

// ---------------------------------------------------------------------------
// Tile culling.
// ---------------------------------------------------------------------------

// Scratch for the sort (≤ 64 survivors) — the per-frame path allocates nothing.
const _cullId = new Int32Array(GRASS_GPU_MAX_TILES);
const _cullKey = new Float64Array(GRASS_GPU_MAX_TILES);
const _cullTie = new Float64Array(GRASS_GPU_MAX_TILES);
/** Stand-in z extent when no `zRange` function is given (no NaN from 0 * Infinity). */
const Z_UNBOUNDED = 1e7;

function _pt(v, k) {
  if (!v) return NaN;
  if (k === 0) return v.x !== undefined ? v.x : v[0];
  if (k === 1) return v.y !== undefined ? v.y : v[1];
  return v.z !== undefined ? v.z : v[2];
}

/** |v|, or `d` when v is not a finite number. */
function _absOr(v, d) {
  return Number.isFinite(v) ? Math.abs(v) : d;
}

/**
 * How far a blade's geometry can reach from its origin (m), for the tile
 * cull's margins (2026-10-23, review integ-2: the fixed 2 m margins were below
 * what `setLod()` and `?treeWindStrength` reach). Derived term by term from
 * the grass vertex snippet (terrain_grass.js `_grassVertexSnippet`), per vertex
 * (u across, v up; hbH = clamp(v)) of GRASS_BLADE_POSITIONS, every live input at
 * its worst case:
 *   H  = tallest variant h x 1.3 (step 10 jitter) x |heightMul|, and
 *   Wd = widest variant w x 1.15 x |widthMul| (hbS = aScale x uGrassLodScale);
 *   start (u Wd, 0, v H); the bow adds bow H hbH^2 (0.5 + vVfxHash), < 1.5 bow
 *   H hbH^2, on y; the yaw rotates xy (length kept); the wind adds
 *   |dir| |windAmp| H stiff hbH^3 |osc| with stiff <= 1, |osc| <= 1 + |flutter|;
 *   the lean adds |n.xy| v H |lean| with |n.xy| <= 1 (before the stomp);
 *   the stomp (only when `stomp`) adds |splay| H hbH s and scales z by
 *   (1 - bend s), s in [0, 1]; the fade and the dissolve only shrink.
 * Each lateral term can point anywhere (yaw, wind direction, slope, trail
 * gradient), so the bound per vertex is their SUM and it is attained when they
 * line up. No vertex has both the full half width and the full tip reach (the
 * tip is at u = 0), so this is the max over vertices, not half width + tip.
 *   lateralM = max over vertices of hypot(u Wd, 1.5 bow H hbH^2)
 *              + wind H hbH^3 + lean H v + splay H hbH
 *   aboveM   = max over vertices of v H max(1, |1 - bend|)
 * Not floored: the caller keeps GRASS_GPU_CULL_XY_MARGIN_M / _ABOVE_M as
 * floors. A stomp bend above 1 would push tips below the origin; the 0.5 m
 * below margin does not model that (the bend is a constant 0.88).
 * Pure, no allocation (`out` reused).
 *
 * @param {object} look `{ heightMul, widthMul, bow, windAmp, windDirLen?, flutter,
 *   lean, stomp, stompSplay, stompBend }` — the live uniform values
 *   (uGrassLodScale.x / .y, uGrassBow, uGrassWindAmp, |uGrassWindDir| (default
 *   1), uGrassWindFlutter, uGrassLean, whether a trail can bend a SIZED blade
 *   of the ring, uGrassStompSplay, uGrassStompBend)
 * @param {{lateralM:number, aboveM:number}} [out]
 * @returns {{lateralM:number, aboveM:number}} `out`
 */
export function grassGpuBladeReach(look, out) {
  const o = out || { lateralM: 0, aboveM: 0 };
  const lk = look || {};
  const vm = variantMax();
  const H = vm.h * (BLADE_H_JITTER[0] + BLADE_H_JITTER[1]) * _absOr(lk.heightMul, 1);
  const Wd = vm.w * (BLADE_W_JITTER[0] + BLADE_W_JITTER[1]) * _absOr(lk.widthMul, 1);
  const bow = 1.5 * _absOr(lk.bow, 0);
  const wind = _absOr(lk.windDirLen, 1) * _absOr(lk.windAmp, 0) * (1 + _absOr(lk.flutter, 0));
  const lean = _absOr(lk.lean, 0);
  const stomp = lk.stomp === true;
  const splay = stomp ? _absOr(lk.stompSplay, 0) : 0;
  const zf = stomp ? Math.max(1, Math.abs(1 - (Number.isFinite(lk.stompBend) ? lk.stompBend : 0))) : 1;
  const P = GRASS_BLADE_POSITIONS;
  let lat = 0, up = 0;
  for (let i = 0; i + 2 < P.length; i += 3) {
    const u = Math.abs(P[i]) * Wd;
    const v = Math.abs(P[i + 2]);
    const hh = Math.min(Math.max(P[i + 2], 0), 1);
    const by = Math.abs(P[i + 1]) * Wd + bow * H * hh * hh;
    const l = Math.sqrt(u * u + by * by) + wind * H * hh * hh * hh + lean * H * v + splay * H * hh;
    const z = v * H * zf;
    if (l > lat) lat = l;
    if (z > up) up = z;
  }
  o.lateralM = lat;
  o.aboveM = up;
  return o;
}

/**
 * Pick the tiles of one ring worth drawing this frame. Pure: no THREE, no
 * allocation.
 *
 * A tile (`ts x ts` cells of the window, clipped to `g`) is CULLED when:
 *  - `zRange(x0, y0, x1, y1)` returns null — no resident terrain under it, so
 *    every blade is dead anyway (an absent `zRange` function skips this test
 *    and leaves z unbounded);
 *  - its rect lies entirely outside the disc `outerR` around `center` (the
 *    distance blend is zero there);
 *  - its rect lies entirely inside the hole `holeR` (the ring's dissolve band
 *    start `band[0]`; <= 0 = no hole);
 *  - its box — the rect grown by `xyMarginM` (default
 *    GRASS_GPU_CULL_XY_MARGIN_M), z from `zRange` grown by -0.5 m below and
 *    `zAboveM` above (default GRASS_GPU_CULL_ABOVE_M) — is entirely outside
 *    any plane (three's `Frustum.intersectsBox` p-vertex test; inside =
 *    n.p + d >= 0).
 * Rects bound the blade ORIGINS exactly: jitter keeps a blade inside its cell.
 * The margins bound how far a blade reaches from its origin; the provider
 * passes `grassGpuBladeReach` of the live look, floored at the defaults.
 *
 * @param {object} p `{ winMin:[x,y], g, ts, T, cell, center:[x,y], outerR,
 *   holeR, planes, zRange, camPos, xyMarginM?, zAboveM? }` — `planes` is an
 *   array of `[nx, ny, nz, d]` (or three `Plane`s: `{normal, constant}`) in the
 *   mesh's OBJECT space, or null = no frustum; `camPos` `[x, y, z]` (object
 *   space) or null = sort by distance from `center`.
 * @param {Float32Array|number[]} out >= 64 slots; survivors' tile ids,
 *   NEAREST FIRST, then -1 padding (the `uGpTiles` value).
 * @returns {number} survivors written
 */
export function cullGrassTiles(p, out) {
  const len = Math.min(out.length, GRASS_GPU_MAX_TILES);
  for (let k = 0; k < out.length; k += 1) out[k] = -1;
  const T = p.T > 0 ? p.T | 0 : GRASS_GPU_TILES_PER_ROW;
  const ts = p.ts | 0;
  const g = p.g | 0;
  const cell = p.cell;
  if (!(ts > 0) || !(g > 0) || !(cell > 0)) return 0;
  const wmx = _pt(p.winMin, 0), wmy = _pt(p.winMin, 1);
  const cx = _pt(p.center, 0), cy = _pt(p.center, 1);
  const outerR = p.outerR;
  const holeR = p.holeR;
  const discOn = Number.isFinite(outerR) && Number.isFinite(cx) && Number.isFinite(cy);
  const holeOn = Number.isFinite(holeR) && holeR > 0 && Number.isFinite(cx) && Number.isFinite(cy);
  const zRange = typeof p.zRange === "function" ? p.zRange : null;
  const planes = Array.isArray(p.planes) ? p.planes : null;
  const xym = Number.isFinite(p.xyMarginM) ? Math.max(0, p.xyMarginM) : GRASS_GPU_CULL_XY_MARGIN_M;
  const zab = Number.isFinite(p.zAboveM) ? Math.max(0, p.zAboveM) : GRASS_GPU_CULL_ABOVE_M;
  const cam = p.camPos || null;
  const ex = cam ? _pt(cam, 0) : cx;
  const ey = cam ? _pt(cam, 1) : cy;
  const ez = cam ? _pt(cam, 2) : NaN;
  const hasEye = Number.isFinite(ex) && Number.isFinite(ey);
  const tiles = Math.min(T * T, GRASS_GPU_MAX_TILES);
  let n = 0;
  for (let t = 0; t < tiles; t += 1) {
    const ox0 = (t % T) * ts;
    const oy0 = Math.trunc(t / T) * ts;
    if (ox0 >= g || oy0 >= g) continue;          // a tile past the grid: no cells
    const ox1 = Math.min(ox0 + ts, g);
    const oy1 = Math.min(oy0 + ts, g);
    const x0 = (wmx + ox0) * cell, x1 = (wmx + ox1) * cell;
    const y0 = (wmy + oy0) * cell, y1 = (wmy + oy1) * cell;
    // Outside the disc: the nearest point of the rect is beyond outerR.
    if (discOn) {
      const dx = Math.max(x0 - cx, 0, cx - x1);
      const dy = Math.max(y0 - cy, 0, cy - y1);
      if (dx * dx + dy * dy > outerR * outerR) continue;
    }
    // Inside the hole: the farthest corner is still inside holeR.
    if (holeOn) {
      const fx = Math.max(Math.abs(x0 - cx), Math.abs(x1 - cx));
      const fy = Math.max(Math.abs(y0 - cy), Math.abs(y1 - cy));
      if (fx * fx + fy * fy < holeR * holeR) continue;
    }
    let zLo = -Z_UNBOUNDED, zHi = Z_UNBOUNDED;
    if (zRange) {
      const zr = zRange(x0, y0, x1, y1);
      if (!zr) continue;                           // no resident terrain: all dead
      zLo = zr.min - GRASS_GPU_CULL_BELOW_M;
      zHi = zr.max + zab;
    }
    if (planes) {
      const bx0 = x0 - xym, bx1 = x1 + xym, by0 = y0 - xym, by1 = y1 + xym;
      let outside = false;
      for (let k = 0; k < planes.length && !outside; k += 1) {
        const pl = planes[k];
        if (!pl) continue;
        let nx, ny, nz, d;
        if (pl.normal) { nx = pl.normal.x; ny = pl.normal.y; nz = pl.normal.z; d = pl.constant; }
        else { nx = pl[0]; ny = pl[1]; nz = pl[2]; d = pl[3]; }
        // The corner farthest along the normal (three Frustum.intersectsBox).
        const px = nx > 0 ? bx1 : bx0;
        const py = ny > 0 ? by1 : by0;
        const pz = nz > 0 ? zHi : zLo;
        if (nx * px + ny * py + nz * pz + d < 0) outside = true;
      }
      if (outside) continue;
    }
    if (n >= len) break;
    // Sort key: distance from the eye to the tile (rect, plus its z range when
    // both are known); ties by distance to the tile centre, then tile id.
    let key = 0, tie = 0;
    if (hasEye) {
      const dx = Math.max(x0 - ex, 0, ex - x1);
      const dy = Math.max(y0 - ey, 0, ey - y1);
      const dz = Number.isFinite(ez) && zRange ? Math.max(zLo - ez, 0, ez - zHi) : 0;
      key = dx * dx + dy * dy + dz * dz;
      const mx = 0.5 * (x0 + x1) - ex, my = 0.5 * (y0 + y1) - ey;
      tie = mx * mx + my * my;
    }
    // Insertion sort (n <= 64).
    let j = n;
    while (j > 0 && (_cullKey[j - 1] > key || (_cullKey[j - 1] === key && _cullTie[j - 1] > tie))) {
      _cullKey[j] = _cullKey[j - 1];
      _cullTie[j] = _cullTie[j - 1];
      _cullId[j] = _cullId[j - 1];
      j -= 1;
    }
    _cullKey[j] = key;
    _cullTie[j] = tie;
    _cullId[j] = t;
    n += 1;
  }
  for (let k = 0; k < n; k += 1) out[k] = _cullId[k];
  return n;
}
