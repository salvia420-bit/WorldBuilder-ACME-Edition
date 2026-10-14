// scene3d/film/scene/terrain_corridor.js — residency-independent terrain heights for a film flight corridor
// (SPEC §1.1 page adapters, §3 perception; recon_terrain.md Q1).
//
// WHY: the film camera flies far from the hidden player (drone vistas, scouting
// candidates two landblocks away), but `SessionHandle.terrainHeightAt` only
// answers for the 3×3 rings the PLAYER has visited (it returns undefined
// elsewhere) and the live terrain oracle only knows landblocks the renderer
// baked. Without ground truth along the camera path the terrain floor clamp,
// "can sink" limits and terrain line-of-sight all fail open — the camera dives
// into hills it never streamed. This module owns a PRIVATE height cache fed by
// `wasmExports.fetch_landblock_heightmaps`, which reads any landblock's
// heightmap straight from the dist shards:
//   * ids are `(lbKey | 0xFFFF) >>> 0`, fetched in batches of ≤ 16 (the far
//     ring's batch size);
//   * the WHOLE batch rejects when any single id fails, so a rejected batch is
//     retried landblock by landblock and only the bad ones are reported;
//   * every returned `LandblockMesh` is a wasm-bindgen box: heights (Float32Array
//     81, idx = vx·9 + vy) and terrainCodes (Uint8Array 81) are COPIED and the
//     mesh is `free()`d — kept, surplus or malformed alike.
// Heights are sampled on the RETAIL split diagonal: `cellSwToNeCut`,
// `triangleHeightInCell` and `triangleGradInCell` below are verbatim ports of
// scene3d/terrain_oracle.js (itself a port of holtburger_dat::terrain_subdiv /
// acclient.c `CLandBlockStruct::ConstructPolygons` @531D10 — the maths
// `terrainHeightAt` runs in wasm). They are ported, not imported, because
// terrain_oracle.js imports the stateful landblock_lru.js (SPEC §1.1 forbids
// that import in film page modules); tests/film_terrain_corridor.test.mjs pins
// the port to terrain_oracle.js numerically.
//
// Water is a terrain code, not a plane: codes 16–20 (the strict default set,
// terrain_families.js `isWaterCode`) on the nearest vertex.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page adapter: the wasm exports are
// INJECTED (or a test fake); no window/document/three imports; deterministic —
// no clocks.

import { LB_SIZE, CELL_SIZE } from "../core/units.js";

/** Most landblock ids sent to one `fetch_landblock_heightmaps` call. */
export const CORRIDOR_BATCH_MAX = 16;

/** Vertices per landblock edge (8 cells of 24 m). */
export const CORRIDOR_VERTEX_GRID = 9;

/** Default cap on cached landblocks (≈ 0.4 KB each; FIFO eviction beyond it). */
export const CORRIDOR_DEFAULT_MAX_LANDBLOCKS = 1024;

/** Terrain codes that are water (the strict default set of terrain_families.js). */
export const CORRIDOR_WATER_CODES = Object.freeze([16, 17, 18, 19, 20]);

/** Largest footprint radius (m) `maxHeightInFootprint` samples; larger radii are clamped. */
export const CORRIDOR_MAX_FOOTPRINT_M = 96;

const GRID_CELLS = CORRIDOR_VERTEX_GRID - 1; // 8
const VERTEX_COUNT = CORRIDOR_VERTEX_GRID * CORRIDOR_VERTEX_GRID; // 81
const FOOTPRINT_RING = 24; // samples on the footprint circle
const FOOTPRINT_INNER = 12; // samples on the half-radius circle

/**
 * Retail per-cell diagonal split — port of terrain_oracle.js `cellSwToNeCut`
 * (holtburger_dat terrain_subdiv `cell_swto_ne_cut`, acclient.c
 * CLandBlockStruct::ConstructPolygons). 32-bit UNSIGNED wraparound via
 * Math.imul; widening to doubles would silently flip diagonals.
 * @param {number} globalCellX landblock byte · 8 + cell index (0..2047)
 * @param {number} globalCellY same, north
 * @returns {boolean} true = SW↔NE diagonal, false = NW↔SE
 */
export function cellSwToNeCut(globalCellX, globalCellY) {
  const gx = globalCellX >>> 0;
  const gy = globalCellY >>> 0;
  const inner = (Math.imul(214614067, gx) + 1813693831) >>> 0;
  const v8 = (Math.imul(gy, inner) - Math.imul(1109124029, gx) - 1369149221) >>> 0;
  return v8 * 2.3283064e-10 >= 0.5;
}

/**
 * Height inside one 24 m cell on the retail triangulation — port of
 * terrain_oracle.js `triangleHeightInCell`. Corners z00 = SW, z10 = SE,
 * z01 = NW, z11 = NE; fx / fy ∈ [0, 1] (east / north cell fractions).
 * @param {number} z00 @param {number} z10 @param {number} z01 @param {number} z11
 * @param {number} fx @param {number} fy
 * @param {boolean} swNeCut cellSwToNeCut of the cell
 * @returns {number}
 */
export function triangleHeightInCell(z00, z10, z01, z11, fx, fy, swNeCut) {
  if (swNeCut) {
    if (fx >= fy) return z00 + (z10 - z00) * fx + (z11 - z10) * fy;
    return z00 + (z11 - z01) * fx + (z01 - z00) * fy;
  }
  if (fx + fy <= 1.0) return z00 + (z10 - z00) * fx + (z01 - z00) * fy;
  return z11 + (z01 - z11) * (1.0 - fx) + (z10 - z11) * (1.0 - fy);
}

/**
 * Gradient `[dz/dfx, dz/dfy]` (per CELL FRACTION) on the same triangle as
 * triangleHeightInCell — port of terrain_oracle.js `triangleGradInCell`.
 * Constant within a triangle, so it gives the exact face normal.
 * @param {number} z00 @param {number} z10 @param {number} z01 @param {number} z11
 * @param {number} fx @param {number} fy
 * @param {boolean} swNeCut
 * @returns {number[]}
 */
export function triangleGradInCell(z00, z10, z01, z11, fx, fy, swNeCut) {
  if (swNeCut) {
    if (fx >= fy) return [z10 - z00, z11 - z10];
    return [z11 - z01, z01 - z00];
  }
  if (fx + fy <= 1.0) return [z10 - z00, z01 - z00];
  return [z11 - z01, z11 - z10];
}

/**
 * Landblock key of any landblock / cell id: `(id & 0xFFFF0000) >>> 0`;
 * null for a non-finite or non-integer input.
 * @param {*} id
 * @returns {number|null}
 */
export function corridorLbKey(id) {
  if (typeof id !== "number" || !Number.isFinite(id) || !Number.isInteger(id)) return null;
  return (id & 0xffff0000) >>> 0;
}

/**
 * True when a terrain code (masked to 5 bits) is water (16–20).
 * @param {number} code
 * @returns {boolean}
 */
export function isWaterTerrainCode(code) {
  if (typeof code !== "number" || !Number.isFinite(code)) return false;
  const c = (code | 0) & 0x1f;
  return c >= 16 && c <= 20;
}

/** @param {*} v @returns {number[]} list of lbKeys (deduplicated, input order) */
function normalizeKeys(v) {
  let list;
  if (v == null) list = [];
  else if (typeof v === "number") list = [v];
  else if (Array.isArray(v) || ArrayBuffer.isView(v)) list = Array.from(v);
  else if (v instanceof Set) list = [...v];
  else list = [];
  const out = [];
  const seen = new Set();
  for (const id of list) {
    const k = corridorLbKey(id);
    if (k === null || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** @param {number} v @param {number} lo @param {number} hi @returns {number} */
function clampInt(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** @param {*} e @returns {string} */
function errText(e) {
  if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  try {
    return String(e);
  } catch {
    return "unknown error";
  }
}

/**
 * @typedef {Object} CorridorEnsureResult
 * @property {boolean} ok         every requested landblock is now cached
 * @property {number[]} loaded    lbKeys fetched by this call
 * @property {number[]} cached    lbKeys that were already cached (or loaded by a concurrent call)
 * @property {{lbKey:number, error:string}[]} failed  lbKeys that could not be fetched
 */

/**
 * @typedef {Object} TerrainCorridor
 * @property {(lbKeys:number|number[]|Uint32Array|Set<number>) => Promise<CorridorEnsureResult>} ensure
 * @property {(x:number, y:number) => number|null} heightAt
 * @property {(x:number, y:number) => number[]|null} normalAt
 * @property {(x:number, y:number, r:number) => number|null} maxHeightInFootprint
 * @property {(x:number, y:number) => boolean|null} isWater
 * @property {(x:number, y:number) => number} codeAt
 * @property {(x:number, y:number) => ({height:number, normal:number[], code:number, water:boolean, lbKey:number}|null)} sample
 * @property {(lbKey:number) => boolean} has
 * @property {(lbKey:number, data:{heights:ArrayLike<number>, codes?:ArrayLike<number>}) => boolean} seed
 * @property {(lbKey:number) => boolean} drop
 * @property {() => number[]} keys
 * @property {() => void} clear
 * @property {() => object} stats
 */

/**
 * Create a private terrain-height cache for a film flight corridor.
 *
 * - `ensure(lbKeys)` (async): fetches every uncached landblock through
 *   `wasmExports.fetch_landblock_heightmaps(Uint32Array of (lbKey|0xFFFF)>>>0,
 *   urgent)` in batches of ≤ `batchSize` (≤ 16); a rejected batch (or a short /
 *   malformed answer) is retried landblock by landblock; every LandblockMesh is
 *   `free()`d after its heights (Float32Array(81), idx vx·9+vy) and terrain codes
 *   are copied. Concurrent ensures share in-flight fetches. Never rejects: the
 *   result lists `loaded`, `cached` and `failed` landblocks.
 * - `heightAt(x, y)`: retail split-diagonal triangle height (null when the
 *   landblock is not cached or (x, y) is off-world / non-finite).
 * - `normalAt(x, y)`: unit up-facing face normal `[nx, ny, nz]` (null when unknown).
 * - `maxHeightInFootprint(x, y, r)`: highest ground under a disc of radius r
 *   (centre, every grid vertex inside the disc, 24 points on the circle and 12 on
 *   the half-radius circle; r clamped to [0, 96] m). FAIL-CLOSED: null when ANY
 *   sample is unknown, so a clearance check never trusts a half-loaded footprint.
 * - `isWater(x, y)`: nearest-vertex terrain code ∈ 16..20 (null when unknown);
 *   `codeAt(x, y)` the code itself (−1 when unknown).
 * - `has(lbKey)`, `keys()`, `seed(lbKey, {heights, codes})` (adopt data from
 *   another source, e.g. the live terrain oracle), `drop`, `clear`, `stats()`.
 *
 * @param {{wasmExports?:object|null, log?:(entry:object)=>void, batchSize?:number,
 *   maxLandblocks?:number, urgent?:boolean}} [opts]
 *   batchSize default 16 (clamped 1..16); maxLandblocks default 1024; urgent default false
 * @returns {TerrainCorridor}
 */
export function createTerrainCorridor(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const wasm = o.wasmExports && (typeof o.wasmExports === "object" || typeof o.wasmExports === "function") ? o.wasmExports : null;
  const log = typeof o.log === "function" ? o.log : null;
  const batchSize = Number.isFinite(o.batchSize) ? clampInt(Math.floor(o.batchSize), 1, CORRIDOR_BATCH_MAX) : CORRIDOR_BATCH_MAX;
  const maxLandblocks = Number.isFinite(o.maxLandblocks) && o.maxLandblocks >= 1 ? Math.floor(o.maxLandblocks) : CORRIDOR_DEFAULT_MAX_LANDBLOCKS;
  const urgent = o.urgent === true;

  /** @type {Map<number, {heights:Float32Array, codes:Uint8Array|null, lbX:number, lbY:number}>} */
  const cache = new Map();
  /** @type {Map<number, Promise<boolean>>} lbKey → resolves true when cached */
  const inflight = new Map();
  /** @type {Map<number, string>} lbKey → last failure */
  const failures = new Map();
  const counters = { fetchCalls: 0, batchRejections: 0, retries: 0, loaded: 0, failed: 0, freed: 0, evicted: 0 };

  const emit = (entry) => {
    if (!log) return;
    try {
      log({ event: "film-terrain-corridor", ...entry });
    } catch {
      /* a throwing logger never breaks perception */
    }
  };

  /** Copy heights/codes out of a mesh; null when it is not a usable heightmap. */
  function copyMesh(mesh) {
    if (!mesh || typeof mesh !== "object") return null;
    let h;
    let c;
    try {
      h = mesh.heights;
      c = mesh.terrainCodes;
    } catch {
      return null;
    }
    if (!h || typeof h.length !== "number" || h.length < VERTEX_COUNT) return null;
    const heights = new Float32Array(VERTEX_COUNT);
    for (let i = 0; i < VERTEX_COUNT; i++) {
      const v = Number(h[i]);
      if (!Number.isFinite(v)) return null;
      heights[i] = v;
    }
    let codes = null;
    if (c && typeof c.length === "number" && c.length >= VERTEX_COUNT) {
      codes = new Uint8Array(VERTEX_COUNT);
      for (let i = 0; i < VERTEX_COUNT; i++) codes[i] = Number(c[i]) & 0xff;
    }
    return { heights, codes };
  }

  /** free() every distinct mesh of an answer exactly once. */
  function freeAll(meshes) {
    if (!meshes || typeof meshes !== "object" || typeof meshes.length !== "number") {
      if (meshes && typeof meshes === "object" && typeof meshes.free === "function") {
        try {
          meshes.free();
          counters.freed += 1;
        } catch {
          /* already released */
        }
      }
      return;
    }
    const seen = new Set();
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (!m || typeof m !== "object" || seen.has(m)) continue;
      seen.add(m);
      if (typeof m.free === "function") {
        try {
          m.free();
          counters.freed += 1;
        } catch {
          /* already released */
        }
      }
    }
  }

  /** Store a landblock (FIFO eviction past the cap). */
  function store(lbKey, data) {
    if (cache.has(lbKey)) cache.delete(lbKey);
    cache.set(lbKey, { heights: data.heights, codes: data.codes, lbX: (lbKey >>> 24) & 0xff, lbY: (lbKey >>> 16) & 0xff });
    failures.delete(lbKey);
    while (cache.size > maxLandblocks) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
      counters.evicted += 1;
    }
  }

  /** The fetch function, or null when the pkg lacks it. */
  function fetcher() {
    if (!wasm) return null;
    if (typeof wasm.fetch_landblock_heightmaps === "function") {
      return (ids) => wasm.fetch_landblock_heightmaps(ids, urgent);
    }
    if (typeof wasm.fetch_landblock_heightmap === "function") {
      // Single-id fallback (older pkg): fetch each id and collect the meshes.
      return async (ids) => {
        const out = [];
        for (const id of ids) out.push(await wasm.fetch_landblock_heightmap(id));
        return out;
      };
    }
    return null;
  }

  /**
   * Fetch one batch; returns Map lbKey → error for the keys that failed.
   * @param {number[]} keys
   * @param {Function} fetch
   * @param {boolean} isRetry
   * @returns {Promise<Map<number, string>>}
   */
  async function fetchBatch(keys, fetch, isRetry) {
    const failed = new Map();
    const ids = Uint32Array.from(keys, (k) => (k | 0xffff) >>> 0);
    let meshes = null;
    counters.fetchCalls += 1;
    if (isRetry) counters.retries += 1;
    try {
      meshes = await fetch(ids);
    } catch (e) {
      for (const k of keys) failed.set(k, errText(e));
      if (!isRetry) counters.batchRejections += 1;
      return failed;
    }
    try {
      const n = meshes && typeof meshes === "object" && typeof meshes.length === "number" ? meshes.length : -1;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const data = n > i ? copyMesh(meshes[i]) : null;
        if (data) {
          store(k, data);
          counters.loaded += 1;
        } else {
          failed.set(k, n < 0 ? "fetch_landblock_heightmaps returned no array" : n <= i ? "missing heightmap in batch answer" : "malformed heightmap");
        }
      }
    } finally {
      freeAll(meshes);
    }
    return failed;
  }

  /** Load uncached keys (batches, then per-landblock retries). Resolves a Map lbKey → error. */
  async function load(keys) {
    const failedAll = new Map();
    const fetch = fetcher();
    if (!fetch) {
      for (const k of keys) failedAll.set(k, "fetch_landblock_heightmaps is not available (stale pkg/?)");
      return failedAll;
    }
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      const failed = await fetchBatch(batch, fetch, false);
      if (failed.size === 0) continue;
      if (batch.length === 1) {
        for (const [k, e] of failed) failedAll.set(k, e);
        continue;
      }
      // The whole batch rejects when any single id fails: retry landblock by landblock.
      for (const k of batch) {
        if (!failed.has(k)) continue;
        const again = await fetchBatch([k], fetch, true);
        for (const [kk, e] of again) failedAll.set(kk, e);
      }
    }
    return failedAll;
  }

  /**
   * Fetch every uncached landblock of `lbKeys` (see createTerrainCorridor).
   * @param {number|number[]|Uint32Array|Set<number>} lbKeys landblock keys or any cell ids in them
   * @returns {Promise<CorridorEnsureResult>}
   */
  async function ensure(lbKeys) {
    const keys = normalizeKeys(lbKeys);
    const result = { ok: true, loaded: [], cached: [], failed: [] };
    const toLoad = [];
    const waits = [];
    for (const k of keys) {
      if (cache.has(k)) result.cached.push(k);
      else if (inflight.has(k)) waits.push([k, inflight.get(k)]);
      else toLoad.push(k);
    }
    if (toLoad.length > 0) {
      const job = load(toLoad);
      for (const k of toLoad) {
        const p = job.then((failed) => !failed.has(k), () => false);
        inflight.set(k, p);
      }
      let failed;
      try {
        failed = await job;
      } catch (e) {
        failed = new Map(toLoad.map((k) => [k, errText(e)]));
      } finally {
        for (const k of toLoad) inflight.delete(k);
      }
      for (const k of toLoad) {
        if (failed.has(k)) {
          const msg = failed.get(k);
          failures.set(k, msg);
          counters.failed += 1;
          result.failed.push({ lbKey: k, error: msg });
        } else {
          result.loaded.push(k);
        }
      }
      if (result.failed.length > 0) {
        emit({ level: "warn", message: `heightmap fetch failed for ${result.failed.length} landblock(s)`, failed: result.failed.slice(0, 8) });
      }
    }
    for (const [k, p] of waits) {
      let okK = false;
      try {
        okK = await p;
      } catch {
        okK = false;
      }
      if (okK && cache.has(k)) result.cached.push(k);
      else result.failed.push({ lbKey: k, error: failures.get(k) || "concurrent fetch failed" });
    }
    result.ok = result.failed.length === 0;
    return result;
  }

  /**
   * Resolve (x, y) to a cache entry and its cell; null when unknown.
   * Mirrors terrain_oracle.js `sample` index maths exactly (parity).
   */
  function locate(x, y) {
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const lbX = Math.floor(x / LB_SIZE);
    const lbY = Math.floor(y / LB_SIZE);
    if (lbX < 0 || lbX > 255 || lbY < 0 || lbY > 255) return null;
    const lbKey = ((lbX << 24) | (lbY << 16)) >>> 0;
    const e = cache.get(lbKey);
    if (!e) return null;
    const localX = x - lbX * LB_SIZE;
    const localY = y - lbY * LB_SIZE;
    const cellXf = Math.min(Math.max(localX / CELL_SIZE, 0), GRID_CELLS);
    const cellYf = Math.min(Math.max(localY / CELL_SIZE, 0), GRID_CELLS);
    const cx0 = Math.floor(cellXf);
    const cy0 = Math.floor(cellYf);
    const cx1 = Math.min(cx0 + 1, GRID_CELLS);
    const cy1 = Math.min(cy0 + 1, GRID_CELLS);
    return { e, lbKey, lbX, lbY, localX, localY, cx0, cy0, cx1, cy1, fx: cellXf - cx0, fy: cellYf - cy0 };
  }

  /** Corner heights + cut of a located cell. */
  function corners(L) {
    const h = L.e.heights;
    const G = CORRIDOR_VERTEX_GRID;
    return {
      z00: h[L.cx0 * G + L.cy0],
      z10: h[L.cx1 * G + L.cy0],
      z01: h[L.cx0 * G + L.cy1],
      z11: h[L.cx1 * G + L.cy1],
      cut: cellSwToNeCut(L.lbX * GRID_CELLS + L.cx0, L.lbY * GRID_CELLS + L.cy0),
    };
  }

  /**
   * Ground height (m) at world (x, y) on the retail split diagonal; null when unknown.
   * @param {number} x @param {number} y
   * @returns {number|null}
   */
  function heightAt(x, y) {
    const L = locate(x, y);
    if (!L) return null;
    const c = corners(L);
    return triangleHeightInCell(c.z00, c.z10, c.z01, c.z11, L.fx, L.fy, c.cut);
  }

  /**
   * Unit up-facing face normal at (x, y); null when unknown.
   * @param {number} x @param {number} y
   * @returns {number[]|null}
   */
  function normalAt(x, y) {
    const L = locate(x, y);
    if (!L) return null;
    const c = corners(L);
    const g = triangleGradInCell(c.z00, c.z10, c.z01, c.z11, L.fx, L.fy, c.cut);
    const nx = -g[0] / CELL_SIZE + 0; // + 0 turns −0 into 0
    const ny = -g[1] / CELL_SIZE + 0;
    const l = Math.sqrt(nx * nx + ny * ny + 1);
    if (!Number.isFinite(l) || l <= 1e-20) return [0, 0, 1];
    return [nx / l, ny / l, 1 / l];
  }

  /**
   * Nearest-vertex terrain code (0..31) at (x, y); −1 when unknown or no codes were cached.
   * @param {number} x @param {number} y
   * @returns {number}
   */
  function codeAt(x, y) {
    const L = locate(x, y);
    if (!L || !L.e.codes) return -1;
    const col = clampInt(Math.round(L.localX / CELL_SIZE), 0, GRID_CELLS);
    const row = clampInt(Math.round(L.localY / CELL_SIZE), 0, GRID_CELLS);
    return L.e.codes[col * CORRIDOR_VERTEX_GRID + row] & 0x1f;
  }

  /**
   * Is (x, y) water (nearest-vertex code 16..20)? null when unknown.
   * @param {number} x @param {number} y
   * @returns {boolean|null}
   */
  function isWater(x, y) {
    const c = codeAt(x, y);
    return c < 0 ? null : isWaterTerrainCode(c);
  }

  /**
   * Highest ground (m) under the disc of radius r around (x, y); null when any sample is unknown.
   * @param {number} x @param {number} y @param {number} r metres (clamped to [0, 96])
   * @returns {number|null}
   */
  function maxHeightInFootprint(x, y, r) {
    const c0 = heightAt(x, y);
    if (c0 === null) return null;
    const R = typeof r === "number" && Number.isFinite(r) ? Math.min(CORRIDOR_MAX_FOOTPRINT_M, Math.max(0, r)) : 0;
    if (!(R > 1e-9)) return c0;
    let best = c0;
    const take = (px, py) => {
      const z = heightAt(px, py);
      if (z === null) return false;
      if (z > best) best = z;
      return true;
    };
    for (let i = 0; i < FOOTPRINT_RING; i++) {
      const a = (2 * Math.PI * i) / FOOTPRINT_RING;
      if (!take(x + R * Math.sin(a), y + R * Math.cos(a))) return null;
    }
    for (let i = 0; i < FOOTPRINT_INNER; i++) {
      const a = (2 * Math.PI * (i + 0.5)) / FOOTPRINT_INNER;
      if (!take(x + 0.5 * R * Math.sin(a), y + 0.5 * R * Math.cos(a))) return null;
    }
    // Planar triangles: interior maxima sit on grid vertices.
    const gx0 = Math.ceil((x - R) / CELL_SIZE), gx1 = Math.floor((x + R) / CELL_SIZE);
    const gy0 = Math.ceil((y - R) / CELL_SIZE), gy1 = Math.floor((y + R) / CELL_SIZE);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const vx = gx * CELL_SIZE, vy = gy * CELL_SIZE;
        const dx = vx - x, dy = vy - y;
        if (dx * dx + dy * dy > R * R) continue;
        if (!take(vx, vy)) return null;
      }
    }
    return best;
  }

  /**
   * Full sample `{height, normal, code, water, lbKey}`; null when unknown.
   * @param {number} x @param {number} y
   * @returns {{height:number, normal:number[], code:number, water:boolean, lbKey:number}|null}
   */
  function sample(x, y) {
    const L = locate(x, y);
    if (!L) return null;
    const height = heightAt(x, y);
    const normal = normalAt(x, y);
    const code = codeAt(x, y);
    return { height, normal, code, water: code >= 0 && isWaterTerrainCode(code), lbKey: L.lbKey };
  }

  /**
   * Adopt a landblock's heights (and codes) from another source (e.g. the live
   * terrain oracle's bake data). Returns false for malformed data.
   * @param {number} lbKey
   * @param {{heights:ArrayLike<number>, codes?:ArrayLike<number>, terrainCodes?:ArrayLike<number>}} data
   * @returns {boolean}
   */
  function seed(lbKey, data) {
    const k = corridorLbKey(lbKey);
    if (k === null || !data || typeof data !== "object") return false;
    const copied = copyMesh({ heights: data.heights, terrainCodes: data.codes ?? data.terrainCodes });
    if (!copied) return false;
    store(k, copied);
    return true;
  }

  return {
    ensure,
    heightAt,
    normalAt,
    maxHeightInFootprint,
    isWater,
    codeAt,
    sample,
    /** @param {number} lbKey @returns {boolean} */
    has(lbKey) {
      const k = corridorLbKey(lbKey);
      return k !== null && cache.has(k);
    },
    seed,
    /** @param {number} lbKey @returns {boolean} true when it was cached */
    drop(lbKey) {
      const k = corridorLbKey(lbKey);
      return k !== null && cache.delete(k);
    },
    /** @returns {number[]} cached lbKeys (oldest first) */
    keys() {
      return [...cache.keys()];
    },
    /** Forget every landblock (e.g. after a long teleport). */
    clear() {
      cache.clear();
      failures.clear();
    },
    /** @returns {{cached:number, inflight:number, fetchCalls:number, batchRejections:number, retries:number, loaded:number, failed:number, freed:number, evicted:number}} */
    stats() {
      return { cached: cache.size, inflight: inflight.size, ...counters };
    },
  };
}
