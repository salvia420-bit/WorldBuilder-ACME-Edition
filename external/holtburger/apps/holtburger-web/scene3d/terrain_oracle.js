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
//      Budget: Uint8Array(81) + Float32Array(81) ≈ 405 B per LB; at the
//      256-slot LRU cap ≈ 104 KB.
//
//   3. `cornerCodes` — the four cell-corner codes, so a family can feather at
//      a type boundary instead of showing 24 m square patches (plan §8 risk 2:
//      the GPU bilinear-blends the four corner textures, so a nearest-vertex
//      code sample and the rendered pixel actively disagree near cell edges).
//
// THREE-free on purpose (plan §6). The only import is `landblock_lru.js`,
// which is itself import-free, so this file loads in node unaided.

import { lbKeyFromXY, lbKeyOf } from "./landblock_lru.js";
import {
  TERRAIN_CODE_TO_FAMILY,
  FAM_COUNT,
  familyForCode,
} from "./terrain_families.js";

// ----- constants (verbatim from ambient_runtime.js / the wasm side) --
export const VERTEX_GRID = 9;
export const VERTEX_SPACING_M = 24.0;
export const METERS_PER_LANDBLOCK = 192.0;
const GRID_CELLS = VERTEX_GRID - 1;          // 8
const VERTEX_COUNT = VERTEX_GRID * VERTEX_GRID; // 81

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
 * @returns {[number, number]}
 */
export function triangleGradInCell(z00, z10, z01, z11, fx, fy, swNeCut) {
  if (swNeCut) {
    if (fx >= fy) return [z10 - z00, z11 - z10]; // lower-right: SW, SE, NE
    return [z11 - z01, z01 - z00];               // upper-left:  SW, NE, NW
  }
  if (fx + fy <= 1.0) return [z10 - z00, z01 - z00]; // lower-left: SW, SE, NW
  return [z11 - z01, z11 - z10];                     // upper-right: NE, NW, SE
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
 */
export function createTerrainOracle(opts = {}) {
  const getTerrainMeshes = opts.getTerrainMeshes || null;
  const parkRescanEveryHits = Number.isFinite(opts.parkRescanEveryHits)
    ? Math.max(1, opts.parkRescanEveryHits | 0)
    : PARK_RESCAN_EVERY_HITS;

  /** @type {Map<number, {codes:Uint8Array, heights:Float32Array|null, lbX:number, lbY:number, coverage:Uint16Array|null}>} */
  const cache = new Map();
  /** Bumped by every successful note/backfill — gives missed LBs another look. */
  let noteEpoch = 0;
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
   * @param {{codes:ArrayLike<number>, heights?:ArrayLike<number>, lbX?:number, lbY?:number}} data
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
      lbX,
      lbY,
      coverage: null,
    });
    noteEpoch += 1;
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
    return cache.delete(lbKey);
  }

  /** Drop everything (teleport across regions, full rebake, dispose). */
  function clear() {
    cache.clear();
    scanIdx = null;
    scanIdxEpoch = -1;
    attachedLbKeys = null;
    noteEpoch += 1;
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
   *   lbX:number, lbY:number, lbKey:number, cornerCodes:Uint8Array}}
   *   null when the LB is not cached, is off-world, or carried no codes.
   */
  function sample(x, y, out) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      misses += 1;
      return null;
    }
    const lbX = Math.floor(x / METERS_PER_LANDBLOCK);
    const lbY = Math.floor(y / METERS_PER_LANDBLOCK);
    // Off-world. Matches `WorldState::terrain_height_at`'s `(0..256)` guard —
    // and is REQUIRED, because `lbKeyFromXY` masks with `& 0xff` and would
    // otherwise wrap -1 onto landblock 255.
    if (lbX < 0 || lbX > 255 || lbY < 0 || lbY > 255) {
      misses += 1;
      return null;
    }
    const lbKey = lbKeyFromXY(lbX, lbY);
    const e = entryFor(lbKey);
    if (!e) {
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

    const g = triangleGradInCell(z00, z10, z01, z11, fx, fy, swNeCut);
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
    if (lbX < 0 || lbX > 255 || lbY < 0 || lbY > 255) {
      misses += 1;
      return -1;
    }
    const lbKey = lbKeyFromXY(lbX, lbY);
    const e = entryFor(lbKey);
    if (!e) {
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

  return {
    noteLandblock,
    invalidate,
    clear,
    sample,
    sampleCode,
    heightAt,
    familyCoverage,
    hasLandblock,
    stats,
    // Diagnostics — the live `oracleSelfTest()` in `terrain_vfx.js` walks these.
    keys: () => Array.from(cache.keys()),
  };
}
