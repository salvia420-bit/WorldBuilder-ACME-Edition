// scene3d/terrain_round.js — TERRAIN EDGE ROUNDING: shading bevel + a
// centimetre fillet. Visual only; the retail surface is untouched.
//
// ===========================================================================
// HISTORY (all 2026-10-07, owner playtest on the 1070 at 41.1S 54.6W)
// ===========================================================================
//   1. "see the two hills they have sharp points ... very slightly rounded
//      out. all corners and sharp edges."
//   2. v1 pulled crease vertices toward their neighbours (up to 0.5 m). Owner:
//      "im standing in the air on top of it ... we need compatibility with
//      legacy" — physics, the server and every PhysObj/GfxObj placement stand
//      on the retail surface, so the drawn ground must too.
//   3. Owner: "we are rounding by half meters when inches would give the
//      look". Hard-surface-style bevel: soften the SHADING across creases and
//      take at most a few centimetres off the geometry.
//
// ===========================================================================
// 1. SHADING BEVEL (primary) — fragment shader, `terrainRoundBevel()`
// ===========================================================================
// What the shipped terrain actually shades with (verified in terrain.js): the
// retail Gouraud term (`?terrainGouraud`, default ON) evaluates
// dot(vAcLightNormal, sun) per pixel, where vAcLightNormal is retail's
// per-VERTEX `calc_lighting` normal interpolated LINEARLY across each retail
// triangle. That field is continuous inside a landblock but its GRADIENT
// jumps at every triangle edge (cell edges and the split diagonal) and every
// vertex — the classic Gouraud crease / Mach band that makes a hill read as
// a faceted pyramid.
//
// The bevel replaces that piecewise-linear field, inside a band of
// `bevelWidthM` around every retail edge, with a partition-of-unity blend of
// the neighbouring triangles' linear normal fields:
//
//     n(p) = sum_T S_T(p) n_T(p) / sum_T S_T(p),   S_T = smoothstep(-w, w, sd_T(p))
//
// n_T = triangle T's own linear field (extrapolated outside T), sd_T = signed
// distance to T (+ inside). Deep inside a triangle only S_T = 1 survives, so
// the retail field is returned EXACTLY (early-out, no work); across an edge
// the weights hand over smoothly, so the normal becomes C1 across the edge
// (the gradient kink is gone); at a vertex all incident triangles blend. A
// planar region has identical fields on both sides, so nothing changes.
// Data: the 81 retail normals ride extra texels of the per-LB `uVertexTypes`
// texture (columns 9..17, RG = normal xy, z reconstructed). NO new sampler:
// the terrain program is at 15 of the 1070's 16 fragment units (see the
// SAMPLER-UNIT BUDGET notes in terrain.js) and a 17th turns terrain black.
// Landblock seams are left exactly as retail (block-local normals; the other
// landblock's normals are not in this texture).
//
// ===========================================================================
// 2. CENTIMETRE FILLET (secondary) — bake-time `aRoundZ`, vertex shader
// ===========================================================================
//   * EVERY RETAIL GRID VERTEX (9x9 per landblock, 24 m apart) KEEPS ITS EXACT
//     HEIGHT: its offset is exactly 0. Only subdivided in-cell points move.
//   * Each crease gets a monotone fillet (PCHIP slopes, Fritsch-Carlson): at
//     a vertex the curve leaves with the PCHIP slope (0 at a peak or valley:
//     a crown at the SAME height), rejoins the straight facet C1 at tau, never
//     rises above the higher end vertex nor below the lower one. Per end:
//        c(t) = chord(t) + (m - d) g(t),  g(t) = t (1 - t/tau)^2 (t < tau)
//        tau  = min(widthM / 24, (27/4) maxDevM / |m - d|)
//     so a sharp crease gets a SHORTER fillet, never a flattened one, and the
//     deviation never exceeds `maxDevM` (default 8 cm). The retail split
//     diagonal is its own crease curve; inside a triangle the three edge
//     curves are blended side-vertex style and clamped to the triangle's
//     [min, max] retail height.
//   * Honest scale note: an 8 cm fillet is ~1 px at 50 m. It only becomes
//     visible where vertices are close enough to sample it (`terrainRoundLevel`
//     8 = 3 m), so by default it adds NO subdivision and mostly does nothing —
//     the shading bevel is the effect.
//   * Crack-free: an edge's curve depends only on its two end heights and the
//     slopes ALONG it; along a 192 m landblock edge those come from that line's
//     own 9 vertices (one-sided at the corners), so both landblocks compute
//     bit-identical values; landblock edges are sampled at the `minLevel`
//     spacing and lerped for finer factors (default minLevel 1 = landblock
//     edges stay exactly retail). Slopes ACROSS a landblock edge use the
//     neighbour's heights when seen (`noteTerrainRoundHeights`) and only shape
//     this landblock's interior.
//
// ===========================================================================
// FLAGS (read once at module load; docs/url-flags.md rows `terrainRound*` /
// `terrainBevel*`)
//   ?terrainRound=off        master escape (also 0/false): byte-identical to
//                            the pre-wave build (no shader code, no attribute,
//                            no wide texture, no LOD floor).
//   ?terrainBevel=off        shading bevel off (fillet stays).
//   ?terrainBevelWidth=<m>   band half-width around each crease, default 2,
//                            [0, 10]. Live.
//   ?terrainBevelStrength=<k> 0..1, default 1. Live.
//   ?terrainRoundMax=<m>     fillet cap, default 0.08, [0, 0.5]; 0 = no fillet.
//   ?terrainRound=<n>        fillet strength 0..1 (live: filletCm / scale).
//   ?terrainRoundWidth=<m>   max fillet length per vertex, default 12, [1, 12].
//   ?terrainRoundLevel=<n>   minimum subdivision for every landblock: 1
//                            (default, no extra triangles) | 2 | 4 | 8.
//   ?terrainRoundFade=<m>    optional camera-distance fade-in of the fillet.
// Live: window.__terrainRound.set({ bevelWidthM, bevelStrength, filletCm,
//       fadeStartM, fadeFullM })
// ===========================================================================

import { cellSwToNeCut } from "./terrain_oracle.js";

/** Defaults — the numbers the stats in url-flags.md were measured at. */
export const TERRAIN_ROUND_DEFAULTS = Object.freeze({
  bevelWidthM: 2,
  bevelStrength: 1,
  strength: 1,
  maxDevM: 0.08,
  widthM: 12,
  minLevel: 1,
  fadeStartM: 0,
  fadeFullM: 0,
});

const MAXDEV_MAX = 0.5;
const BEVEL_WIDTH_MAX_M = 10; // < 12: the 2x2-cell gather in the shader needs w < half a cell
const WIDTH_MAX_M = 12;       // tau <= 1/2: the two end fillets of a 24 m edge never overlap
const WIDTH_MIN_M = 1;
const G_PEAK = 27 / 4;        // max g = 4 tau / 27

/** Columns of the per-LB `uVertexTypes` texture: 9 = pre-wave, 18 = + normals. */
export const TYPES_COLS_BASE = 9;

function _param(search, name) {
  try {
    if (typeof search === "string") return new URLSearchParams(search).get(name);
    if (typeof window === "undefined" || !window.location) return null;
    return new URLSearchParams(window.location.search || "").get(name);
  } catch (_) {
    return null;
  }
}

function _finite(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function _off(raw) {
  if (typeof raw !== "string" || raw === "") return false;
  const v = raw.toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

/**
 * Resolve the config from a query string (default: the page URL).
 * DEFAULT-ON. Master reader idiom: `!(v === "off" || v === "0" || v === "false")`.
 *
 * @param {string} [search] e.g. "?terrainBevelWidth=3&terrainRoundMax=0.05"
 */
export function readTerrainRoundConfig(search) {
  const source = {};
  const rawMaster = _param(search, "terrainRound");
  const enabled = !_off(rawMaster);
  if (typeof rawMaster === "string" && rawMaster !== "") source.terrainRound = rawMaster;

  // --- shading bevel ---
  const rawBevel = _param(search, "terrainBevel");
  const bevel = enabled && !_off(rawBevel);
  if (typeof rawBevel === "string" && rawBevel !== "") source.terrainBevel = rawBevel;
  let bevelWidthM = TERRAIN_ROUND_DEFAULTS.bevelWidthM;
  const rawBw = _finite(_param(search, "terrainBevelWidth"));
  if (rawBw != null) { bevelWidthM = Math.min(BEVEL_WIDTH_MAX_M, Math.max(0, rawBw)); source.terrainBevelWidth = rawBw; }
  let bevelStrength = TERRAIN_ROUND_DEFAULTS.bevelStrength;
  const rawBs = _finite(_param(search, "terrainBevelStrength"));
  if (rawBs != null) { bevelStrength = Math.min(1, Math.max(0, rawBs)); source.terrainBevelStrength = rawBs; }

  // --- centimetre fillet ---
  let strength = TERRAIN_ROUND_DEFAULTS.strength;
  const nMaster = _finite(rawMaster);
  if (enabled && nMaster != null) strength = Math.min(1, Math.max(0, nMaster));
  let maxDevM = TERRAIN_ROUND_DEFAULTS.maxDevM;
  const rawMax = _finite(_param(search, "terrainRoundMax"));
  if (rawMax != null) { maxDevM = Math.min(MAXDEV_MAX, Math.max(0, rawMax)); source.terrainRoundMax = rawMax; }
  let widthM = TERRAIN_ROUND_DEFAULTS.widthM;
  const rawWidth = _finite(_param(search, "terrainRoundWidth"));
  if (rawWidth != null) { widthM = Math.min(WIDTH_MAX_M, Math.max(WIDTH_MIN_M, rawWidth)); source.terrainRoundWidth = rawWidth; }
  let minLevel = TERRAIN_ROUND_DEFAULTS.minLevel;
  const rawLevel = _finite(_param(search, "terrainRoundLevel"));
  if (rawLevel != null) {
    // The subdivision ladder is powers of two: snap down to 1 | 2 | 4 | 8.
    minLevel = rawLevel >= 8 ? 8 : rawLevel >= 4 ? 4 : rawLevel >= 2 ? 2 : 1;
    source.terrainRoundLevel = rawLevel;
  }
  const fillet = enabled && strength > 0 && maxDevM > 0;
  let fadeStartM = TERRAIN_ROUND_DEFAULTS.fadeStartM;
  let fadeFullM = TERRAIN_ROUND_DEFAULTS.fadeFullM;
  const rawFade = _param(search, "terrainRoundFade");
  if (typeof rawFade === "string" && rawFade !== "") {
    const parts = rawFade.split(",").map((p) => _finite(p.trim()));
    if (parts.length >= 2 && parts[0] != null && parts[1] != null) {
      fadeStartM = Math.max(0, parts[0]);
      fadeFullM = Math.max(0, parts[1]);
    } else if (parts[0] != null) {
      fadeFullM = Math.max(0, parts[0]);
      fadeStartM = fadeFullM / 3;
    }
    source.terrainRoundFade = rawFade;
  }
  // GLSL smoothstep(e0, e1, x) is undefined for e0 >= e1; (0, 0.001) = no fade.
  if (!(fadeFullM > fadeStartM + 0.001)) fadeFullM = fadeStartM + 0.001;
  return {
    enabled, bevel, bevelWidthM, bevelStrength,
    fillet, strength, maxDevM, widthM, minLevel, fadeStartM, fadeFullM,
    source,
  };
}

/** The session config (module load, like every sibling terrain flag). */
export const TERRAIN_ROUND = readTerrainRoundConfig();

/** Width of the per-LB `uVertexTypes` texture this session (9 or 18). */
export function terrainRoundTypesCols(cfg = TERRAIN_ROUND) {
  return cfg && cfg.enabled && cfg.bevel ? TYPES_COLS_BASE * 2 : TYPES_COLS_BASE;
}

/**
 * Minimum subdivision factor the LOD picker must use for every landblock.
 * 1 (no floor) unless a fillet level was asked for.
 */
export function terrainRoundMinLevel(cfg = TERRAIN_ROUND) {
  return cfg && cfg.enabled && cfg.fillet ? cfg.minLevel : 1;
}

// ---------------------------------------------------------------------------
// Retail normals for the bevel: written into columns 9..17 of `uVertexTypes`.
// ---------------------------------------------------------------------------

/** Normal component [-1, 1] -> byte (the shader decodes byte/255 * 2 - 1). */
export function encodeNormalByte(c) {
  const v = Math.round((Math.max(-1, Math.min(1, c)) * 0.5 + 0.5) * 255);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** The shader's decode, for tests: bytes -> unit normal (z reconstructed). */
export function decodeNormalBytes(r, g) {
  const x = (r / 255) * 2 - 1;
  const y = (g / 255) * 2 - 1;
  return [x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))];
}

/**
 * Write the 81 retail normals into an RGBA8 `uVertexTypes` byte block of
 * width `cols` (18): texel (9 + x, y) = (nx, ny, 0, 255). `acLight` is the
 * subdivided geometry's `acLightNormal` array (3 per vertex, layout
 * `i*n + j`); retail vertex (x, y) sits at fine index (x*f, y*f), where the
 * barycentric resample IS the retail normal. Columns 0..8 are untouched.
 */
export function writeTerrainRoundNormals(bytes, cols, acLight, gridSize, factor) {
  if (!bytes || cols < TYPES_COLS_BASE * 2) return false;
  const n = gridSize | 0;
  const f = factor | 0;
  const ok = acLight && f >= 1 && n === 8 * f + 1 && acLight.length >= 3 * n * n;
  for (let y = 0; y <= 8; y += 1) {
    for (let x = 0; x <= 8; x += 1) {
      const dst = (y * cols + TYPES_COLS_BASE + x) * 4;
      if (ok) {
        const src = ((x * f) * n + y * f) * 3;
        bytes[dst] = encodeNormalByte(acLight[src]);
        bytes[dst + 1] = encodeNormalByte(acLight[src + 1]);
      } else {
        bytes[dst] = 128; // decodes to ~(0, 0, 1): harmless; the Gouraud
        bytes[dst + 1] = 128; // gate is off for an LB without acLightNormal
      }
      bytes[dst + 2] = 0;
      bytes[dst + 3] = 255;
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------
// JS mirror of the fragment-shader bevel (tests + diag). Keep in lock-step
// with TERRAIN_ROUND_FRAG_GLSL below — same cells, same distances, same blend.
// ---------------------------------------------------------------------------

const RSQRT2 = Math.SQRT1_2;

function _smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Bevelled shading normal at LB-local grid coords (gx, gy) in [0, 8].
 * @param {(x:number,y:number)=>number[]} normalAt retail normal at vertex (x, y)
 * @param {(cx:number,cy:number)=>boolean} cutAt retail split of LOCAL cell (cx, cy)
 * @param {number[]} nIn the interpolated retail normal at the point
 * @returns {number[]} nIn + strength * (blend - own)
 */
export function terrainRoundBevelNormal(gx, gy, normalAt, cutAt, bandM, strength, nIn) {
  const w = bandM / 24;
  if (!(w > 0) || !(strength > 0)) return nIn.slice();
  const g = [Math.min(8, Math.max(0, gx)), Math.min(8, Math.max(0, gy))];
  const vx = Math.min(8, Math.max(0, Math.floor(g[0] + 0.5)));
  const vy = Math.min(8, Math.max(0, Math.floor(g[1] + 0.5)));
  const cu = Math.min(7, Math.max(0, Math.floor(g[0])));
  const cv = Math.min(7, Math.max(0, Math.floor(g[1])));
  // Cheap early-out (mirrors the GLSL): distance to the containing triangle's
  // nearest edge, before any normal is read.
  const a0 = g[0] - cu, b0 = g[1] - cv;
  const dDiag = cutAt(cu, cv) ? Math.abs(a0 - b0) : Math.abs(a0 + b0 - 1);
  const dIn = Math.min(Math.min(Math.min(a0, 1 - a0), Math.min(b0, 1 - b0)), dDiag * RSQRT2);
  if (dIn >= w) return nIn.slice();
  const acc = [0, 0, 0];
  let ws = 0;
  let own = nIn;
  let ownSd = -1e9;
  const cell = (cx, cy) => {
    if (cx < 0 || cy < 0 || cx > 7 || cy > 7) return;
    const a = g[0] - cx, b = g[1] - cy;
    const nSW = normalAt(cx, cy), nSE = normalAt(cx + 1, cy), nNW = normalAt(cx, cy + 1), nNE = normalAt(cx + 1, cy + 1);
    const lin = (p, q, r, bp, bq, br) => [0, 1, 2].map((k) => p[k] * bp + q[k] * bq + r[k] * br);
    let sd1, sd2, f1, f2;
    if (cutAt(cx, cy)) {
      sd1 = Math.min(Math.min(b, 1 - a), (a - b) * RSQRT2);
      f1 = lin(nSW, nSE, nNE, 1 - a, a - b, b);
      sd2 = Math.min(Math.min(a, 1 - b), (b - a) * RSQRT2);
      f2 = lin(nSW, nNE, nNW, 1 - b, a, b - a);
    } else {
      sd1 = Math.min(Math.min(a, b), (1 - a - b) * RSQRT2);
      f1 = lin(nSW, nSE, nNW, 1 - a - b, a, b);
      sd2 = Math.min(Math.min(1 - a, 1 - b), (a + b - 1) * RSQRT2);
      f2 = lin(nNE, nNW, nSE, a + b - 1, 1 - a, 1 - b);
    }
    const s1 = _smoothstep(-w, w, sd1);
    const s2 = _smoothstep(-w, w, sd2);
    for (let k = 0; k < 3; k += 1) acc[k] += s1 * f1[k] + s2 * f2[k];
    ws += s1 + s2;
    if (sd1 > ownSd) { ownSd = sd1; own = f1; }
    if (sd2 > ownSd) { ownSd = sd2; own = f2; }
  };
  for (let dy = -1; dy <= 0; dy += 1) {
    for (let dx = -1; dx <= 0; dx += 1) cell(vx + dx, vy + dy);
  }
  return [0, 1, 2].map((k) => nIn[k] + strength * (acc[k] / ws - own[k]));
}

// ---------------------------------------------------------------------------
// Neighbour heights (fillet only — slopes ACROSS a landblock edge; they shape
// this landblock's interior, never a shared edge, so availability can change
// smoothness but can never open a crack).
// ---------------------------------------------------------------------------

const NEIGHBOUR_CACHE_MAX = 4096; // 4096 * 81 * 4 B = 1.3 MB
const _heights = new Map();       // ((lbX << 8) | lbY) -> Float32Array(81), x*9 + y

/** Remember one landblock's 81 retail heights (`x*9 + y`). Idempotent. */
export function noteTerrainRoundHeights(lbX, lbY, heights81) {
  if (!heights81 || heights81.length < 81) return;
  const key = ((lbX & 0xff) << 8) | (lbY & 0xff);
  if (_heights.has(key)) return;
  if (_heights.size >= NEIGHBOUR_CACHE_MAX) _heights.delete(_heights.keys().next().value);
  const copy = new Float32Array(81);
  for (let v = 0; v < 81; v += 1) copy[v] = heights81[v];
  _heights.set(key, copy);
}

/** `{ east, west, north, south }` heights of the four edge neighbours seen so far. */
export function terrainRoundNeighbours(lbX, lbY) {
  const get = (x, y) => (x < 0 || y < 0 || x > 0xff || y > 0xff ? null : _heights.get(((x & 0xff) << 8) | (y & 0xff)) || null);
  return { east: get(lbX + 1, lbY), west: get(lbX - 1, lbY), north: get(lbX, lbY + 1), south: get(lbX, lbY - 1) };
}

/** Test seam. */
export function _resetTerrainRoundHeightsForTest() {
  _heights.clear();
}

// ---------------------------------------------------------------------------
// PCHIP slopes (equal 24 m spacing; slope in metres per span)
// ---------------------------------------------------------------------------

/** Interior vertex: harmonic mean of the adjacent differences, 0 at an extremum. */
function pchipMid(dl, dr) {
  if (!(dl * dr > 0)) return 0;
  return (2 * dl * dr) / (dl + dr);
}

/**
 * End vertex (one-sided, three-point, the standard PCHIP end rule).
 * `d0` = the difference of the interval touching the end, `d1` = the next one
 * (both in the direction of travel). Result is within [0, 3] * d0.
 */
function pchipEnd(d0, d1) {
  if (d0 === 0) return 0;
  let m = (3 * d0 - d1) / 2;
  if (!(m * d0 > 0)) return 0;
  if (d0 * d1 < 0 && Math.abs(m) > Math.abs(3 * d0)) m = 3 * d0;
  return m;
}

/** Slope at index k of a 9-sample line with optional samples at -1 / 9. */
function lineSlope(v, k, before, after) {
  const prev = k > 0 ? v[k - 1] : before;
  const next = k < 8 ? v[k + 1] : after;
  if (prev != null && next != null) return pchipMid(v[k] - prev, next - v[k]);
  if (next != null) return pchipEnd(next - v[k], v[k + 2] - next);   // k === 0, one-sided
  return pchipEnd(v[k] - prev, prev - v[k - 2]);                     // k === 8, one-sided
}

// ---------------------------------------------------------------------------
// Bake-time fillet offsets
// ---------------------------------------------------------------------------

/**
 * Per-vertex vertical fillet offsets for one subdivided landblock.
 *
 * Layout matches `terrain_subdiv.rs::subdivide_landblock` exactly:
 * `idx = i * n + j`, `i` east (x = i*h), `j` north (y = j*h), `n = 8f + 1`,
 * and `positions[idx*3 + 2]` is the faceted retail height. Only Z is read.
 *
 * @param {ArrayLike<number>} positions flat xyz, length 3*n*n
 * @param {number} gridSize n
 * @param {number} factor subdivision factor f (>= 2, n === 8f + 1)
 * @param {number} lbX landblock X byte (picks the retail split per cell)
 * @param {number} lbY landblock Y byte
 * @param {object} [cfg] a readTerrainRoundConfig() result
 * @param {{east?,west?,north?,south?}|null} [neighbours] 81-height arrays
 * @returns {Float32Array|null} n*n offsets in metres (exactly 0 at every
 *   retail vertex), or null when the fillet does not apply.
 */
export function computeTerrainRoundOffsets(
  positions,
  gridSize,
  factor,
  lbX,
  lbY,
  cfg = TERRAIN_ROUND,
  neighbours = null,
) {
  if (!cfg || !cfg.enabled || !cfg.fillet) return null;
  const f = factor | 0;
  const n = gridSize | 0;
  if (f < 2 || n !== 8 * f + 1) return null;
  if (!positions || positions.length !== 3 * n * n) return null;
  const s = Math.min(1, Math.max(0, cfg.strength));
  const D = cfg.maxDevM;
  const tauMax = Math.min(0.5, Math.max(0, cfg.widthM / 24));
  if (!(s > 0) || !(D > 0) || !(tauMax > 0)) return null;
  const cap = D / s; // budget of the UNSCALED correction (s * correction <= D)
  // Landblock edges are sampled at this factor and lerped for finer ones.
  const L = cfg.minLevel | 0;
  const edgeLevel = L >= 1 && f >= L && f % L === 0 ? L : f;

  const zAt = (i, j) => positions[(i * n + j) * 3 + 2];
  const h = new Float64Array(81);
  for (let x = 0; x <= 8; x += 1) for (let y = 0; y <= 8; y += 1) h[x * 9 + y] = zAt(x * f, y * f);

  const nb = neighbours || {};
  const sx = new Float64Array(81); // slope along +x at (x, y)
  const sy = new Float64Array(81); // slope along +y
  const line = new Float64Array(9);
  for (let y = 0; y <= 8; y += 1) {
    for (let x = 0; x <= 8; x += 1) line[x] = h[x * 9 + y];
    // A row ON a landblock edge (y = 0 / 8) is shared with the north/south
    // neighbour: its along-line slopes must come from its own 9 vertices.
    const shared = y === 0 || y === 8;
    const before = !shared && nb.west ? nb.west[7 * 9 + y] : null;
    const after = !shared && nb.east ? nb.east[1 * 9 + y] : null;
    for (let x = 0; x <= 8; x += 1) sx[x * 9 + y] = lineSlope(line, x, before, after);
  }
  for (let x = 0; x <= 8; x += 1) {
    for (let y = 0; y <= 8; y += 1) line[y] = h[x * 9 + y];
    const shared = x === 0 || x === 8;
    const before = !shared && nb.south ? nb.south[x * 9 + 7] : null;
    const after = !shared && nb.north ? nb.north[x * 9 + 1] : null;
    for (let y = 0; y <= 8; y += 1) sy[x * 9 + y] = lineSlope(line, y, before, after);
  }

  const fillet = (a, t) => {
    if (a === 0) return 0;
    const tau = Math.min(tauMax, (G_PEAK * cap) / Math.abs(a));
    if (!(t < tau)) return 0;
    const u = 1 - t / tau;
    return a * t * u * u;
  };
  const edgeCorr = (h0, h1, m0, m1, t) => {
    const d = h1 - h0;
    return fillet(m0 - d, t) - fillet(m1 - d, 1 - t);
  };
  const sampled = (h0, h1, m0, m1, t, onLbEdge) => {
    if (!onLbEdge || edgeLevel === f) return edgeCorr(h0, h1, m0, m1, t);
    const tc = t * edgeLevel;
    const q0 = Math.min(Math.floor(tc), edgeLevel - 1);
    const fr = tc - q0;
    const e0 = q0 === 0 ? 0 : edgeCorr(h0, h1, m0, m1, q0 / edgeLevel);
    const e1 = q0 + 1 >= edgeLevel ? 0 : edgeCorr(h0, h1, m0, m1, (q0 + 1) / edgeLevel);
    return e0 * (1 - fr) + e1 * fr;
  };
  const vEdge = (X, cv, t) => sampled(
    h[X * 9 + cv], h[X * 9 + cv + 1], sy[X * 9 + cv], sy[X * 9 + cv + 1], t, X === 0 || X === 8);
  const hEdge = (Y, cu, t) => sampled(
    h[cu * 9 + Y], h[(cu + 1) * 9 + Y], sx[cu * 9 + Y], sx[(cu + 1) * 9 + Y], t, Y === 0 || Y === 8);
  const fcLimit = (m, d) => {
    if (!(m * d > 0)) return 0;
    return Math.abs(m) > Math.abs(3 * d) ? 3 * d : m;
  };

  const out = new Float32Array(n * n);
  const gx0 = (lbX & 0xff) * 8;
  const gy0 = (lbY & 0xff) * 8;
  for (let i = 0; i < n; i += 1) {
    const onCol = i % f === 0;
    const cu = Math.min(Math.floor(i / f), 7);
    const fx = i / f - cu;
    for (let j = 0; j < n; j += 1) {
      const onRow = j % f === 0;
      if (onCol && onRow) continue; // retail vertex: exactly 0
      const cv = Math.min(Math.floor(j / f), 7);
      const fy = j / f - cv;
      let off;
      if (onCol) {
        off = s * vEdge(i / f, cv, fy);
      } else if (onRow) {
        off = s * hEdge(j / f, cu, fx);
      } else {
        const iSW = cu * 9 + cv, iSE = (cu + 1) * 9 + cv, iNW = cu * 9 + cv + 1, iNE = (cu + 1) * 9 + cv + 1;
        const hSW = h[iSW], hSE = h[iSE], hNW = h[iNW], hNE = h[iNE];
        let corr = 0;
        let lo, hi;
        const add = (w, e) => { if (w > 1e-12) corr += w * e; };
        if (cellSwToNeCut(gx0 + cu, gy0 + cv)) {
          const dd = hNE - hSW; // diagonal SW -> NE, direction (+1, +1)
          const m0 = fcLimit(sx[iSW] + sy[iSW], dd);
          const m1 = fcLimit(sx[iNE] + sy[iNE], dd);
          if (fx >= fy) {
            const bSW = 1 - fx, bSE = fx - fy, bNE = fy;
            add(bSW + bSE, hEdge(cv, cu, bSE / (bSW + bSE)));
            add(bSE + bNE, vEdge(cu + 1, cv, bNE / (bSE + bNE)));
            add(bSW + bNE, edgeCorr(hSW, hNE, m0, m1, bNE / (bSW + bNE)));
            lo = Math.min(hSW, hSE, hNE); hi = Math.max(hSW, hSE, hNE);
          } else {
            const bSW = 1 - fy, bNE = fx, bNW = fy - fx;
            add(bSW + bNW, vEdge(cu, cv, bNW / (bSW + bNW)));
            add(bNW + bNE, hEdge(cv + 1, cu, bNE / (bNW + bNE)));
            add(bSW + bNE, edgeCorr(hSW, hNE, m0, m1, bNE / (bSW + bNE)));
            lo = Math.min(hSW, hNE, hNW); hi = Math.max(hSW, hNE, hNW);
          }
        } else {
          const dd = hSE - hNW; // diagonal NW -> SE, direction (+1, -1)
          const m0 = fcLimit(sx[iNW] - sy[iNW], dd);
          const m1 = fcLimit(sx[iSE] - sy[iSE], dd);
          if (fx + fy <= 1) {
            const bSW = 1 - fx - fy, bSE = fx, bNW = fy;
            add(bSW + bSE, hEdge(cv, cu, bSE / (bSW + bSE)));
            add(bSW + bNW, vEdge(cu, cv, bNW / (bSW + bNW)));
            add(bNW + bSE, edgeCorr(hNW, hSE, m0, m1, bSE / (bNW + bSE)));
            lo = Math.min(hSW, hSE, hNW); hi = Math.max(hSW, hSE, hNW);
          } else {
            const bNE = fx + fy - 1, bNW = 1 - fx, bSE = 1 - fy;
            add(bNW + bNE, hEdge(cv + 1, cu, bNE / (bNW + bNE)));
            add(bSE + bNE, vEdge(cu + 1, cv, bNE / (bSE + bNE)));
            add(bNW + bSE, edgeCorr(hNW, hSE, m0, m1, bSE / (bNW + bSE)));
            lo = Math.min(hNE, hNW, hSE); hi = Math.max(hNE, hNW, hSE);
          }
        }
        const zf = zAt(i, j);
        let o = s * corr;
        if (o > D) o = D; else if (o < -D) o = -D;
        let z = zf + o;
        if (z > hi) z = hi; else if (z < lo) z = lo;
        off = z - zf;
      }
      out[i * n + j] = off;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running stats (diag / LIVE-CHECK). Cheap: one pass over each new offset array.
// ---------------------------------------------------------------------------

const HIST_BIN_M = 0.001;
const HIST_BINS = Math.ceil(MAXDEV_MAX / HIST_BIN_M) + 2;
const _stats = {
  lbs: 0, verts: 0, movedVerts: 0, sumAbs: 0, maxAbs: 0, minOff: 0, maxOff: 0,
  hist: new Uint32Array(HIST_BINS),
};

/** Fold one landblock's offsets into the running stats; returns its max |off|. */
export function noteTerrainRoundOffsets(off) {
  if (!off) return 0;
  let lbMax = 0;
  for (let v = 0; v < off.length; v += 1) {
    const o = off[v];
    const a = o < 0 ? -o : o;
    if (a > lbMax) lbMax = a;
    if (a > 0.001) _stats.movedVerts += 1;
    _stats.sumAbs += a;
    if (o < _stats.minOff) _stats.minOff = o;
    if (o > _stats.maxOff) _stats.maxOff = o;
    _stats.hist[Math.min(HIST_BINS - 1, Math.floor(a / HIST_BIN_M))] += 1;
  }
  _stats.lbs += 1;
  _stats.verts += off.length;
  if (lbMax > _stats.maxAbs) _stats.maxAbs = lbMax;
  return lbMax;
}

function _pct(p) {
  const total = _stats.verts;
  if (total === 0) return 0;
  const target = total * p;
  let acc = 0;
  for (let b = 0; b < HIST_BINS; b += 1) {
    acc += _stats.hist[b];
    if (acc >= target) return Math.min((b + 1) * HIST_BIN_M, _stats.maxAbs);
  }
  return _stats.maxAbs;
}

/** Snapshot of the BAKED fillet offsets (all vertices, retail ones included). */
export function terrainRoundStats() {
  const v = _stats.verts;
  return {
    lbs: _stats.lbs, verts: v,
    movedFrac: v ? _stats.movedVerts / v : 0,
    meanAbsM: v ? _stats.sumAbs / v : 0,
    p95AbsM: _pct(0.95), p99AbsM: _pct(0.99), maxAbsM: _stats.maxAbs,
    minOffM: _stats.minOff, maxOffM: _stats.maxOff,
  };
}

/** Test seam. */
export function _resetTerrainRoundStatsForTest() {
  _stats.lbs = 0; _stats.verts = 0; _stats.movedVerts = 0; _stats.sumAbs = 0;
  _stats.maxAbs = 0; _stats.minOff = 0; _stats.maxOff = 0; _stats.hist.fill(0);
}

// ---------------------------------------------------------------------------
// Shader. Injected into terrain.js ONLY when enabled, so `?terrainRound=off`
// compiles the pre-wave programs byte-for-byte.
//   VERTEX: the fillet offset (a DIRECTION, w = 0, added after the
//   vWorldPos/mvPos pair that terrain_batch.js rewrites as one anchor — so it
//   works unchanged per-LB and batched) + this LB's global cell origin for the
//   fragment's split-diagonal hash.
//   FRAGMENT: the bevel. Its one texelFetch line is a terrain_batch.js anchor
//   (rewritten to the sampler2DArray + slot form). No new sampler.
// ---------------------------------------------------------------------------

export const TERRAIN_ROUND_VERTEX_DECL_GLSL = `
// 2026-10-07 — terrain edge rounding (scene3d/terrain_round.js). aRoundZ: the
// baked centimetre fillet (metres, AC +Z), exactly 0 at every retail vertex;
// position stays the retail faceted surface. uRoundScale: live fillet
// multiplier in [0, 1]. uRoundFade: optional camera-distance fade-in (m).
// vRoundLbCell: this landblock's global cell origin, for the bevel.
in float aRoundZ;
uniform float uRoundScale;
uniform vec2 uRoundFade;
flat out vec2 vRoundLbCell;
`;

export const TERRAIN_ROUND_VERTEX_APPLY_GLSL = `
  // 2026-10-07 — terrain edge rounding: the landblock's global cell origin
  // (worldXy - local = lbX*192, lbY*192) and the centimetre fillet along AC +Z
  // (w = 0: direction only), optionally faded in with camera distance.
  vRoundLbCell = floor((worldXy - position.xy) * (1.0 / 24.0) + 0.5);
  if (uRoundScale != 0.0) {
    float roundW = uRoundScale * smoothstep(uRoundFade.x, uRoundFade.y, length(mvPos.xyz));
    vec4 roundOff = vec4(0.0, 0.0, aRoundZ * roundW, 0.0);
    mvPos += modelViewMatrix * roundOff;
    vWorldPos += (modelMatrix * roundOff).xyz;
  }
`;

/** The texelFetch line terrain_batch.js rewrites for the sampler2DArray form. */
export const TERRAIN_ROUND_FETCH_ANCHOR =
  "  vec2 roundE = texelFetch(uVertexTypes, ivec2(9 + x, y), 0).rg * 2.0 - 1.0;";
export const TERRAIN_ROUND_FETCH_BATCHED =
  "  vec2 roundE = texelFetch(uVertexTypes, ivec3(9 + x, y, int(vLbSlot + 0.5)), 0).rg * 2.0 - 1.0;";

export const TERRAIN_ROUND_FRAG_GLSL = `
// 2026-10-07 — terrain SHADING BEVEL (scene3d/terrain_round.js header). The
// retail Gouraud normal is linear per retail triangle, so its gradient jumps
// at every edge and vertex (the faceted read). Within uRoundBevel.x metres of
// a retail edge the normal becomes a smoothstep-weighted blend of the
// neighbouring triangles' linear fields: C1 across the edge, unchanged
// (exactly) outside the band, unchanged on planes. Retail normals ride
// uVertexTypes columns 9..17 (RG = xy). Landblock seams stay retail.
uniform vec2 uRoundBevel;            // x = band half-width (m), y = strength 0..1
flat in vec2 vRoundLbCell;           // global cell origin of this landblock
const float ROUND_RSQRT2 = 0.70710678;
bool terrainRoundCut(int cx, int cy) {
  // Retail CLandBlockStruct::ConstructPolygons split (terrain_subdiv.rs
  // cell_swto_ne_cut), u32 wrap; v8 * 2.3283064e-10 >= 0.5  <=>  v8 >= 2147483652.
  uint gx = uint(int(vRoundLbCell.x) + cx);
  uint gy = uint(int(vRoundLbCell.y) + cy);
  uint inner = 214614067u * gx + 1813693831u;
  uint v8 = gy * inner - 1109124029u * gx - 1369149221u;
  return v8 >= 2147483652u;
}
vec3 terrainRoundN(int x, int y) {
  vec2 roundE = texelFetch(uVertexTypes, ivec2(9 + x, y), 0).rg * 2.0 - 1.0;
  return vec3(roundE, sqrt(max(0.0, 1.0 - dot(roundE, roundE))));
}
void terrainRoundCell(int cx, int cy, vec2 g, float w,
                      inout vec3 acc, inout float ws, inout vec3 own, inout float ownSd) {
  if (cx < 0 || cy < 0 || cx > 7 || cy > 7) return;
  float a = g.x - float(cx);
  float b = g.y - float(cy);
  vec3 nSW = terrainRoundN(cx, cy);
  vec3 nSE = terrainRoundN(cx + 1, cy);
  vec3 nNW = terrainRoundN(cx, cy + 1);
  vec3 nNE = terrainRoundN(cx + 1, cy + 1);
  float sd1;
  float sd2;
  vec3 f1;
  vec3 f2;
  if (terrainRoundCut(cx, cy)) {
    sd1 = min(min(b, 1.0 - a), (a - b) * ROUND_RSQRT2);
    f1 = nSW * (1.0 - a) + nSE * (a - b) + nNE * b;
    sd2 = min(min(a, 1.0 - b), (b - a) * ROUND_RSQRT2);
    f2 = nSW * (1.0 - b) + nNE * a + nNW * (b - a);
  } else {
    sd1 = min(min(a, b), (1.0 - a - b) * ROUND_RSQRT2);
    f1 = nSW * (1.0 - a - b) + nSE * a + nNW * b;
    sd2 = min(min(1.0 - a, 1.0 - b), (a + b - 1.0) * ROUND_RSQRT2);
    f2 = nNE * (a + b - 1.0) + nNW * (1.0 - a) + nSE * (1.0 - b);
  }
  float s1 = smoothstep(-w, w, sd1);
  float s2 = smoothstep(-w, w, sd2);
  acc += s1 * f1 + s2 * f2;
  ws += s1 + s2;
  if (sd1 > ownSd) { ownSd = sd1; own = f1; }
  if (sd2 > ownSd) { ownSd = sd2; own = f2; }
}
vec3 terrainRoundBevel(vec3 nIn) {
  float w = uRoundBevel.x * (1.0 / 24.0);
  float k = uRoundBevel.y;
  if (!(w > 0.0) || !(k > 0.0)) return nIn;
  vec2 g = clamp(vGridUv, 0.0, 8.0);
  int cu = int(clamp(floor(g.x), 0.0, 7.0));
  int cv = int(clamp(floor(g.y), 0.0, 7.0));
  // Cheap early-out BEFORE any fetch: distance to the containing triangle's
  // nearest edge (cell edges + the split diagonal). Most pixels stop here.
  float a0 = g.x - float(cu);
  float b0 = g.y - float(cv);
  float dDiag = terrainRoundCut(cu, cv) ? abs(a0 - b0) : abs(a0 + b0 - 1.0);
  float dIn = min(min(min(a0, 1.0 - a0), min(b0, 1.0 - b0)), dDiag * ROUND_RSQRT2);
  if (dIn >= w) return nIn;     // beyond the band of every edge: exact retail
  int vx = int(clamp(floor(g.x + 0.5), 0.0, 8.0));
  int vy = int(clamp(floor(g.y + 0.5), 0.0, 8.0));
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  vec3 own = nIn;
  float ownSd = -1.0e9;
  for (int dy = -1; dy <= 0; dy++) {
    for (int dx = -1; dx <= 0; dx++) {
      terrainRoundCell(vx + dx, vy + dy, g, w, acc, ws, own, ownSd);
    }
  }
  return nIn + k * (acc / ws - own);
}
`;

// ---------------------------------------------------------------------------
// Live uniforms
// ---------------------------------------------------------------------------

const _live = {
  scale: 1, // fillet multiplier in [0, 1]
  fadeStartM: TERRAIN_ROUND.fadeStartM,
  fadeFullM: TERRAIN_ROUND.fadeFullM,
  bevelWidthM: TERRAIN_ROUND.bevel ? TERRAIN_ROUND.bevelWidthM : 0,
  bevelStrength: TERRAIN_ROUND.bevelStrength,
};

/**
 * Uniform entries for a NEW terrain ShaderMaterial (spread into its
 * `uniforms`). Empty when off so the uniform set — like the program — is the
 * pre-wave one. `Vec2` is THREE.Vector2 (this module stays THREE-free).
 */
export function terrainRoundUniforms(Vec2, cfg = TERRAIN_ROUND) {
  if (!cfg || !cfg.enabled || typeof Vec2 !== "function") return {};
  return {
    uRoundScale: { value: _live.scale },
    uRoundFade: { value: new Vec2(_live.fadeStartM, _live.fadeFullM) },
    uRoundBevel: { value: new Vec2(_live.bevelWidthM, _live.bevelStrength) },
  };
}

/**
 * 2026-10-07 — terrain rounding step 3 (scene3d/visual_ground.js): the weight
 * the vertex shader puts on a baked `aRoundZ` RIGHT NOW, i.e. TERRAIN_ROUND_
 * VERTEX_APPLY_GLSL's `uRoundScale * smoothstep(uRoundFade.x, uRoundFade.y,
 * camDist)`. Pure read of the live uniforms; `camDistM` omitted / Infinity /
 * NaN = beyond any fade (the weight is the live scale). 0 when the fillet is
 * off. Lets the drawn-ground query match the shader without a GPU read.
 */
export function terrainRoundFilletWeight(camDistM = Infinity) {
  if (!TERRAIN_ROUND.enabled) return 0;
  const s = _live.scale;
  if (!(s > 0)) return 0;
  if (!(camDistM < Infinity)) return s;
  return s * _smoothstep(_live.fadeStartM, _live.fadeFullM, camDistM);
}

function _applyLive(mat) {
  const u = mat && mat.uniforms;
  if (!u || !u.uRoundScale) return false;
  u.uRoundScale.value = _live.scale;
  const f = u.uRoundFade && u.uRoundFade.value;
  if (f && typeof f.set === "function") f.set(_live.fadeStartM, _live.fadeFullM);
  const b = u.uRoundBevel && u.uRoundBevel.value;
  if (b && typeof b.set === "function") b.set(_live.bevelWidthM, _live.bevelStrength);
  return true;
}

/**
 * Live tuning without a reload:
 *   bevelWidthM   shading band half-width (m), 0 = bevel off, max 10
 *   bevelStrength 0..1
 *   filletCm      fillet height, 0..(terrainRoundMax in cm) — the baked cap is
 *                 the ceiling (raise it with ?terrainRoundMax + reload)
 *   scale         the same fillet control as a 0..1 multiplier
 *   fadeStartM / fadeFullM  optional fillet camera fade (0, 0 = none)
 * Applies to every registered terrain material (per-LB and the terrain batch)
 * and to materials baked later.
 */
export function setTerrainRoundLive(scene3d, patch = {}) {
  if (Number.isFinite(patch.bevelWidthM)) _live.bevelWidthM = Math.max(0, Math.min(BEVEL_WIDTH_MAX_M, patch.bevelWidthM));
  if (Number.isFinite(patch.bevelStrength)) _live.bevelStrength = Math.max(0, Math.min(1, patch.bevelStrength));
  if (Number.isFinite(patch.filletCm)) {
    const capCm = TERRAIN_ROUND.maxDevM * 100;
    _live.scale = capCm > 0 ? Math.max(0, Math.min(1, patch.filletCm / capCm)) : 0;
  }
  if (Number.isFinite(patch.scale)) _live.scale = Math.max(0, Math.min(1, patch.scale));
  if (Number.isFinite(patch.fadeStartM)) _live.fadeStartM = Math.max(0, patch.fadeStartM);
  if (Number.isFinite(patch.fadeFullM)) _live.fadeFullM = Math.max(0, patch.fadeFullM);
  if (!(_live.fadeFullM > _live.fadeStartM + 0.001)) _live.fadeFullM = _live.fadeStartM + 0.001;
  let touched = 0;
  const seen = new Set();
  const lists = [scene3d && scene3d.terrainMaterials];
  try {
    const liveS = typeof window !== "undefined" ? window.liveScene3d : null;
    if (liveS && liveS !== scene3d) lists.push(liveS.terrainMaterials);
  } catch (_) { /* fail-soft */ }
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (_applyLive(m)) touched += 1;
    }
  }
  return { ..._live, filletCm: _live.scale * TERRAIN_ROUND.maxDevM * 100, materials: touched };
}

// ---------------------------------------------------------------------------
// Diag: window.__terrainRound
// ---------------------------------------------------------------------------

/**
 * Baked fillet offset under a world AC point (metres, +X east, +Y north),
 * read back from the landblock's own `aRoundZ` attribute. Null when that
 * landblock is not attached to `terrainGroup` (parked/unbaked).
 */
export function terrainRoundOffsetAt(scene3d, x, y) {
  const group = scene3d && scene3d.terrainGroup;
  if (!group || !Array.isArray(group.children)) return null;
  const lbX = Math.floor(x / 192);
  const lbY = Math.floor(y / 192);
  for (const c of group.children) {
    const ud = c && c.userData;
    if (!ud || ud.lbX !== lbX || ud.lbY !== lbY || typeof ud.subdivLevel !== "number") continue;
    const attr = c.geometry && c.geometry.getAttribute ? c.geometry.getAttribute("aRoundZ") : null;
    const f = ud.subdivLevel;
    const n = 8 * f + 1;
    if (!attr || attr.count !== n * n) return { lbX, lbY, factor: f, offsetM: 0, attribute: false };
    const h = 24 / f;
    const lx = Math.min(Math.max((x - lbX * 192) / h, 0), n - 1);
    const ly = Math.min(Math.max((y - lbY * 192) / h, 0), n - 1);
    const i0 = Math.min(Math.floor(lx), n - 2);
    const j0 = Math.min(Math.floor(ly), n - 2);
    const fx = lx - i0;
    const fy = ly - j0;
    const a = attr.array;
    const o = (a[i0 * n + j0] * (1 - fx) + a[(i0 + 1) * n + j0] * fx) * (1 - fy)
      + (a[i0 * n + j0 + 1] * (1 - fx) + a[(i0 + 1) * n + j0 + 1] * fx) * fy;
    return { lbX, lbY, factor: f, offsetM: o, lbMaxAbsM: ud.roundMaxAbsM ?? null, attribute: true };
  }
  return null;
}

/** Install `window.__terrainRound` (idempotent; browser only). */
export function installTerrainRoundDiag(scene3d) {
  if (typeof window === "undefined") return null;
  const api = {
    config: TERRAIN_ROUND,
    live: () => ({ ..._live, filletCm: _live.scale * TERRAIN_ROUND.maxDevM * 100 }),
    stats: terrainRoundStats,
    set: (patch) => setTerrainRoundLive(scene3d, patch),
    at: (x, y) => terrainRoundOffsetAt(scene3d, x, y),
    /** Baked fillet under the local player's feet (0 on a retail vertex). */
    underPlayer: () => {
      let p = null;
      try {
        const sh = window.__sessionHandle;
        p = sh && typeof sh.getLocalPlayerPose === "function" ? sh.getLocalPlayerPose() : null;
        if (!p) return null;
        const lb = p.landblockId >>> 0;
        const x = ((lb >>> 24) & 0xff) * 192 + p.x;
        const y = ((lb >>> 16) & 0xff) * 192 + p.y;
        return { x, y, ...(terrainRoundOffsetAt(scene3d, x, y) || {}) };
      } catch (_) {
        return null;
      } finally {
        // WASM box: release after copying (see camera.js `__cam.world`).
        try { p && p.free && p.free(); } catch (_) { /* already released */ }
      }
    },
  };
  try { window.__terrainRound = api; } catch (_) { /* fail-soft */ }
  return api;
}
