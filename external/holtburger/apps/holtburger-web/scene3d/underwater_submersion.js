// scene3d/underwater_submersion.js — Item 12 (Fix 12A + Fix 12B):
//   1. Water-cell submersion query (`waterSubmersionAt`) + submerged Z placement
//      (`computeSubmergedCreatureZ`) + fast scene3d registry for underwater
//      creatures (`syncEntityWaterSubmersion` / `unregisterSubmergedEntity`).
//   2. Visible underwater monster rendering (`createUnderwaterSubmersionRenderer`
//      + `createUnderwaterSubmersionPass`):
//        - Fast 0.000 ms / 0 draw-call early-out when no submerged water entity
//          is visible within frustum and < 180 m of the camera.
//        - Renders after the opaque world pass (when `stableDepthTexture` holds
//          resolved world + water surface depth -> zero WebGL2 feedback loop)
//          and before `fxPass` (clouds / aerial perspective).
//        - Two-pass self-occluding draw into a private depth-buffered target
//          (`depthPrepass` with `colorMask(false,false,false,false)` followed by
//          `depthFunc = EqualDepth` aquatic color pass) so multi-part monster
//          limbs self-occlude cleanly with zero internal alpha-stacking, then
//          hardware `SrcAlpha, OneMinusSrcAlpha` composite (alpha capped <= 0.78)
//          into the scene color buffer while leaving scene depth untouched.

import * as THREE from "three";
import {
  VERTEX_GRID,
  VERTEX_SPACING_M,
  METERS_PER_LANDBLOCK,
  cellSwToNeCut,
  triangleHeightInCell,
} from "./terrain_oracle.js";

/** Retail `TERRAIN_SURF_CHAR[code] == WATER` (acclient.c:41303): codes 16..20. */
export const WATER_TERRAIN_CODES = Object.freeze([16, 17, 18, 19, 20]);

export const MAX_UNDERWATER_RENDER_DIST_M = 180.0;
export const RETAIL_WATER_FLOOR_ENTIRE_M = 0.90;
export const RETAIL_WATER_FLOOR_PARTIAL_M = 0.45;
export const FOREGROUND_OCCLUSION_BIAS_M = 0.45;
export const MAX_TRANSMISSION_ALPHA = 0.78;

const ITEM_TYPE_CREATURE = 0x00000010;
const ODF_CORPSE = 0x00000010;
const OFF_VALUES = new Set(["off", "0", "false", "no"]);

/**
 * True iff `code` (masked to 5-bit terrain type) is one of the 5 retail water
 * terrain types `{16, 17, 18, 19, 20}` (FauxWater 22/23 are solid).
 * @param {number} code
 * @returns {boolean}
 */
export function isWaterTerrainCode(code) {
  const c = (code >>> 0) & 0x1f;
  return c >= 16 && c <= 20;
}

/**
 * `?underwaterSubmersion=off|0|false|no` disables the underwater monster pass.
 * DEFAULT ON.
 * @param {string} [search]
 * @returns {boolean}
 */
export function underwaterSubmersionEnabled(search) {
  try {
    const s = typeof search === "string"
      ? search
      : (typeof globalThis !== "undefined" && globalThis.location ? globalThis.location.search || "" : "");
    if (!s) return true;
    const v = new URLSearchParams(s).get("underwaterSubmersion");
    if (v === null) return true;
    return !OFF_VALUES.has(String(v).trim().toLowerCase());
  } catch (_) {
    return true;
  }
}

const _oracleScratch = {
  cornerCodes: new Uint8Array(4),
  cornerRoads: new Uint8Array(4),
};

function _sessionTerrainHeight(scene3d, wx, wy) {
  if (scene3d?._terrainOracle && typeof scene3d._terrainOracle.heightAt === "function") {
    try {
      const gz = scene3d._terrainOracle.heightAt(wx, wy);
      if (typeof gz === "number" && Number.isFinite(gz)) return gz;
    } catch (_) {}
  }
  if (scene3d && typeof scene3d.terrainHeightAt === "function") {
    try {
      const gz = scene3d.terrainHeightAt(wx, wy);
      if (typeof gz === "number" && Number.isFinite(gz)) return gz;
    } catch (_) {}
  }
  const sh =
    scene3d?.sessionHandle ??
    (typeof globalThis !== "undefined" ? globalThis.window?.__sessionHandle : null);
  if (!sh || typeof sh.terrainHeightAt !== "function") return null;
  try {
    const gz = sh.terrainHeightAt(wx, wy);
    return typeof gz === "number" && Number.isFinite(gz) ? gz : null;
  } catch (_) {
    return null;
  }
}

function _fallbackMeshTerrainSample(scene3d, wx, wy) {
  const lbX = Math.floor(wx / METERS_PER_LANDBLOCK);
  const lbY = Math.floor(wy / METERS_PER_LANDBLOCK);
  if (lbX < 0 || lbX > 255 || lbY < 0 || lbY > 614) return null;

  // Test hook or direct terrainGroup fallback when `_terrainOracle` is absent.
  let ud = null;
  if (scene3d?._waterTerrainByLb instanceof Map) {
    const lbKey = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
    ud = scene3d._waterTerrainByLb.get(lbKey) || null;
  }
  if (!ud) {
    const children = scene3d?.terrainGroup?.children;
    if (Array.isArray(children)) {
      for (let i = 0; i < children.length; i += 1) {
        const mUd = children[i]?.userData;
        if (mUd && mUd.lbX === lbX && mUd.lbY === lbY && mUd.terrainCodes?.length >= 81) {
          ud = mUd;
          break;
        }
      }
    }
  }
  if (!ud || !ud.terrainCodes || ud.terrainCodes.length < 81) return null;

  const localX = wx - lbX * METERS_PER_LANDBLOCK;
  const localY = wy - lbY * METERS_PER_LANDBLOCK;
  const gridCells = VERTEX_GRID - 1;
  const cellXf = Math.min(Math.max(localX / VERTEX_SPACING_M, 0), gridCells);
  const cellYf = Math.min(Math.max(localY / VERTEX_SPACING_M, 0), gridCells);
  const cx0 = Math.min(Math.floor(cellXf), gridCells - 1);
  const cy0 = Math.min(Math.floor(cellYf), gridCells - 1);
  const cx1 = Math.min(cx0 + 1, gridCells);
  const cy1 = Math.min(cy0 + 1, gridCells);
  const fx = Math.min(Math.max((localX - cx0 * VERTEX_SPACING_M) / VERTEX_SPACING_M, 0), 1);
  const fy = Math.min(Math.max((localY - cy0 * VERTEX_SPACING_M) / VERTEX_SPACING_M, 0), 1);

  const iSW = cx0 * VERTEX_GRID + cy0;
  const iSE = cx1 * VERTEX_GRID + cy0;
  const iNW = cx0 * VERTEX_GRID + cy1;
  const iNE = cx1 * VERTEX_GRID + cy1;
  const codes = ud.terrainCodes;

  let height = null;
  const h = ud.heights;
  if (h && h.length >= 81) {
    const swNeCut = cellSwToNeCut(lbX * gridCells + cx0, lbY * gridCells + cy0);
    height = triangleHeightInCell(h[iSW], h[iSE], h[iNW], h[iNE], fx, fy, swNeCut);
  }
  return {
    cSW: codes[iSW] & 0x1f,
    cSE: codes[iSE] & 0x1f,
    cNW: codes[iNW] & 0x1f,
    cNE: codes[iNE] & 0x1f,
    fx,
    fy,
    height,
  };
}

/**
 * Inspect the 4 corner terrain codes `[SW, SE, NW, NE]` of the 24 m terrain
 * cell containing AC world `(wx, wy)` and return its water classification and
 * retail floor submersion offset:
 *   - `EntirelyWater` (all 4 corners in `{16..20}`):
 *       `overWater: true`, `submergeM: 0.90`, `waterZ`
 *   - `PartiallyWater` (1..3 corners in `{16..20}`):
 *       `overWater: true` when the local point falls in a wet quadrant or has
 *       bilinear water coverage `>= 0.5`, with `submergeM` in `[0.45, 0.90]`.
 *   - `null` when dry (`0` water corners), off-world, or terrain unresolvable.
 *
 * @param {object|null} scene3d
 * @param {number} wx AC world X (east, metres)
 * @param {number} wy AC world Y (north, metres)
 * @param {object} [out]
 * @returns {null | {
 *   waterType: "EntirelyWater" | "PartiallyWater",
 *   wetCorners: number,
 *   overWater: boolean,
 *   waterZ: number,
 *   submergeM: number,
 *   waterCoverage: number,
 *   cornerCodes: [number, number, number, number],
 * }}
 */
export function waterSubmersionAt(scene3d, wx, wy, out) {
  if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
  const lbX = Math.floor(wx / METERS_PER_LANDBLOCK);
  const lbY = Math.floor(wy / METERS_PER_LANDBLOCK);
  if (lbX < 0 || lbX > 255 || lbY < 0 || lbY > 614) return null;

  const localX = wx - lbX * METERS_PER_LANDBLOCK;
  const localY = wy - lbY * METERS_PER_LANDBLOCK;
  const gridCells = VERTEX_GRID - 1;
  const cx0 = Math.min(Math.max(Math.floor(localX / VERTEX_SPACING_M), 0), gridCells - 1);
  const cy0 = Math.min(Math.max(Math.floor(localY / VERTEX_SPACING_M), 0), gridCells - 1);
  const fx = Math.min(Math.max((localX - cx0 * VERTEX_SPACING_M) / VERTEX_SPACING_M, 0), 1);
  const fy = Math.min(Math.max((localY - cy0 * VERTEX_SPACING_M) / VERTEX_SPACING_M, 0), 1);

  let cSW = 0;
  let cSE = 0;
  let cNW = 0;
  let cNE = 0;
  let sampleHeight = null;
  let haveCodes = false;

  const oracle = scene3d?._terrainOracle;
  if (oracle && typeof oracle.sample === "function") {
    const s = oracle.sample(wx, wy, _oracleScratch);
    if (s && s.cornerCodes && s.cornerCodes.length >= 4) {
      cSW = s.cornerCodes[0] & 0x1f;
      cSE = s.cornerCodes[1] & 0x1f;
      cNW = s.cornerCodes[2] & 0x1f;
      cNE = s.cornerCodes[3] & 0x1f;
      if (s.hasHeight && typeof s.height === "number" && Number.isFinite(s.height)) {
        sampleHeight = s.height;
      }
      haveCodes = true;
    }
  }

  if (!haveCodes) {
    const fb = _fallbackMeshTerrainSample(scene3d, wx, wy);
    if (!fb) return null;
    cSW = fb.cSW;
    cSE = fb.cSE;
    cNW = fb.cNW;
    cNE = fb.cNE;
    sampleHeight = fb.height;
  }

  const wSW = isWaterTerrainCode(cSW) ? 1 : 0;
  const wSE = isWaterTerrainCode(cSE) ? 1 : 0;
  const wNW = isWaterTerrainCode(cNW) ? 1 : 0;
  const wNE = isWaterTerrainCode(cNE) ? 1 : 0;
  const wetCorners = wSW + wSE + wNW + wNE;
  if (wetCorners === 0) return null;

  const waterZ = sampleHeight !== null ? sampleHeight : _sessionTerrainHeight(scene3d, wx, wy);
  if (waterZ === null || !Number.isFinite(waterZ)) return null;

  const waterCoverage =
    (1 - fx) * (1 - fy) * wSW +
    fx * (1 - fy) * wSE +
    (1 - fx) * fy * wNW +
    fx * fy * wNE;

  const res = out || {};
  res.cornerCodes = [cSW, cSE, cNW, cNE];
  res.wetCorners = wetCorners;
  res.waterZ = waterZ;
  res.waterCoverage = waterCoverage;

  if (wetCorners === 4) {
    res.waterType = "EntirelyWater";
    res.overWater = true;
    res.submergeM = RETAIL_WATER_FLOOR_ENTIRE_M;
    return res;
  }

  // PartiallyWater: retail `calc_water_depth` compares against cell centre
  // (`fx > 0.5` east, `fy > 0.5` north). Also treat `waterCoverage >= 0.5` as
  // over water so shoreline diagonal cuts agree with the rendered water triangle.
  const east = fx > 0.5 ? 1 : 0;
  const north = fy > 0.5 ? 1 : 0;
  const quadWet = (east === 0 && north === 0 && wSW) ||
    (east === 1 && north === 0 && wSE) ||
    (east === 0 && north === 1 && wNW) ||
    (east === 1 && north === 1 && wNE);
  const overWater = Boolean(quadWet || waterCoverage >= 0.5);
  res.waterType = "PartiallyWater";
  res.overWater = overWater;
  res.submergeM = overWater
    ? RETAIL_WATER_FLOOR_PARTIAL_M +
      (RETAIL_WATER_FLOOR_ENTIRE_M - RETAIL_WATER_FLOOR_PARTIAL_M) *
        Math.min(1, Math.max(0, (waterCoverage - 0.25) / 0.75))
    : 0.0;
  return res;
}

const FLYING_NAME_RE = /\b(wisp|banderling\s+scout\s+flyer|phyntos\s+wasp|wasp|grievver\s+sky|mosswart\s+cloud)\b/i;

/**
 * True when an entity/spawn represents a non-flying monster/creature eligible
 * for automatic underwater placement when spawned on water.
 * Excludes NPC vendors/townspeople, corpses, doors, portals, projectiles, and
 * explicit flying creatures.
 * @param {object|null} meta
 * @param {object|null} [inst]
 * @returns {boolean}
 */
export function isWaterSubmergibleCreature(meta, inst = null) {
  if (!meta && !inst) return false;
  const m = meta || inst?.meta || {};
  if (inst?._isProjectile || inst?._ballistic || inst?._attachedParentGuid != null) return false;
  if (((m.objDescFlags >>> 0) & ODF_CORPSE) !== 0) return false;
  if (m.isFlying === true || inst?._isFlying === true) return false;
  const cat = String(m.__category || m.category || "");
  if (cat === "NPC") return false;
  if (cat === "Creature") {
    return !(typeof m.name === "string" && /\bwisp\b/i.test(m.name));
  }
  const weenieType = m.weenieType >>> 0;
  if (weenieType === 12) return false; // NPC
  if (weenieType === 10) {
    return !(typeof m.name === "string" && /\bwisp\b/i.test(m.name));
  }
  const itemType = (m.itemType >>> 0);
  if ((itemType & ITEM_TYPE_CREATURE) !== 0) {
    // Exclude obvious human NPC vendors if flagged on wire (`isNpc` / radar NPC)
    if (m.isNpc === true || m.weenieClass === "npc") return false;
    if (typeof m.name === "string" && FLYING_NAME_RE.test(m.name) && /\bwisp\b/i.test(m.name)) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Measure an entity rig's vertical model height in AC metres (Three local Y/Z
 * under `inst.root`), falling back to `1.15 m` when parts have not been measured.
 * @param {object|null} inst
 * @returns {number}
 */
export function estimateEntityHeightM(inst) {
  if (!inst) return 1.15;
  if (typeof inst._waterModelHeightM === "number" && inst._waterModelHeightM > 0.05) {
    return inst._waterModelHeightM;
  }
  if (Array.isArray(inst._partDims) && typeof inst._partDims[1] === "number" && inst._partDims[1] > 0.05) {
    return inst._partDims[1];
  }
  const scale = (typeof inst._baseScale === "number" && inst._baseScale > 0)
    ? inst._baseScale
    : ((inst.meta?.objScale && inst.meta.objScale > 0) ? inst.meta.objScale : 1.0);
  const root = inst.root;
  if (!root || typeof root.traverse !== "function") return 1.15 * scale;

  let minZ = Infinity;
  let maxZ = -Infinity;
  let found = false;
  try {
    root.updateMatrixWorld?.(true);
    const rootY = root.position ? root.position.z : 0; // AC Z height
    // Measure part geometries in rig-local space so it works before/after worldRoot attach.
    const parts = Array.isArray(inst.parts) ? inst.parts : [];
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      if (!p) continue;
      const pz = p.position ? p.position.z : 0;
      p.traverse?.((o) => {
        if (!o.isMesh || !o.geometry) return;
        const g = o.geometry;
        if (!g.boundingBox && typeof g.computeBoundingBox === "function") {
          g.computeBoundingBox();
        }
        const bb = g.boundingBox;
        if (bb && Number.isFinite(bb.min.z) && Number.isFinite(bb.max.z)) {
          // AC part geometry vertices are (x, y, z) with Z up inside `worldRoot`.
          const lo = pz + bb.min.z * scale;
          const hi = pz + bb.max.z * scale;
          if (lo < minZ) minZ = lo;
          if (hi > maxZ) maxZ = hi;
          found = true;
        }
      });
    }
    void rootY;
  } catch (_) {
    found = false;
  }
  if (found && maxZ > minZ + 0.05) {
    const h = Math.min(4.0, Math.max(0.25, maxZ - Math.min(0, minZ)));
    inst._waterModelHeightM = h;
    return h;
  }
  return 1.15 * scale;
}

/**
 * Compute the corrected vertical `z` for an outdoor placement at `(wx, wy, z)`
 * given `waterInfo = waterSubmersionAt(scene3d, wx, wy)`:
 *   1. NEVER lifts a submerged entity (`z < waterZ`) up to `waterZ` on any water cell!
 *   2. For a non-flying creature on `EntirelyWater` (or `PartiallyWater` with
 *      `overWater === true`):
 *      - When `z >= waterZ - 0.15` (and not high above on a bridge/cliff,
 *        `z <= waterZ + 1.75`), sinks `z` below `waterZ` by
 *        `max(0.90, min(modelHeight * 0.85, 1.80))` on `EntirelyWater` (or
 *        `max(submergeM, min(modelHeight * 0.75, 1.25))` on `PartiallyWater`).
 *      - When `z < waterZ - 0.15` on `EntirelyWater` (e.g. `-0.895 m` retail
 *        water floor) AND its top sticks completely/substantially above water,
 *        sinks `z` so the monster sits underwater while keeping already-submerged
 *        `-0.895 m` creatures submerged below `waterZ`.
 *
 * @param {number} z
 * @param {ReturnType<typeof waterSubmersionAt>} waterInfo
 * @param {object} [opts]
 * @param {boolean} [opts.isCreature=false]
 * @param {number} [opts.modelHeight=1.15]
 * @returns {number}
 */
export function computeSubmergedCreatureZ(z, waterInfo, opts = undefined) {
  if (!waterInfo || !Number.isFinite(z)) return z;
  const waterZ = waterInfo.waterZ;
  if (!waterInfo.overWater) return z;

  const isCreature = Boolean(opts?.isCreature);
  if (!isCreature) {
    // Non-creature on water: never ground-clamp lift `z < waterZ` up to `waterZ`.
    return z;
  }

  const h = (typeof opts?.modelHeight === "number" && opts.modelHeight > 0)
    ? opts.modelHeight
    : 1.15;
  const dz = z - waterZ;

  // High above water (standing on a bridge, dock, boat deck, or cliff overhang):
  // leave untouched.
  if (dz > 1.75) return z;

  if (waterInfo.waterType === "EntirelyWater") {
    const targetSink = Math.max(
      RETAIL_WATER_FLOOR_ENTIRE_M,
      Math.min(h * 0.85, 1.80),
    );
    if (dz >= -0.15) {
      return waterZ - targetSink;
    }
    // Already below water (e.g. retail -0.895 m): keep submerged, and if a tall
    // model's top still sticks well above deep EntirelyWater, sink to targetSink.
    if (z + h > waterZ + 0.15) {
      return Math.min(z, waterZ - targetSink);
    }
    return Math.min(z, waterZ - Math.min(RETAIL_WATER_FLOOR_ENTIRE_M, targetSink));
  }

  // PartiallyWater (`overWater === true`):
  const partialSink = Math.max(
    waterInfo.submergeM || RETAIL_WATER_FLOOR_PARTIAL_M,
    Math.min(h * 0.75, 1.25),
  );
  if (dz >= -0.15) {
    return waterZ - partialSink;
  }
  return z;
}

function _ensureWaterRegistry(scene3d) {
  if (!scene3d) return null;
  if (!(scene3d._submergedWaterEntities instanceof Map)) {
    scene3d._submergedWaterEntities = new Map();
  }
  if (!(scene3d._submergedWaterMeshes instanceof Set)) {
    scene3d._submergedWaterMeshes = new Set();
  }
  return scene3d._submergedWaterEntities;
}

/**
 * Collect renderable `THREE.Mesh` leaves belonging directly to `inst.root`
 * (excluding nameplates and debug helpers).
 * @param {object} inst
 * @returns {THREE.Mesh[]}
 */
function _collectEntityMeshes(inst) {
  const meshes = [];
  const root = inst?.root;
  if (!root || typeof root.traverse !== "function") return meshes;
  root.traverse((o) => {
    if (!o || !o.isMesh || !o.geometry || !o.material) return;
    if (o.userData?.isNameplate || o.userData?.isSelectionRing || o.userData?.__particle) return;
    meshes.push(o);
  });
  return meshes;
}

/**
 * Synchronize `inst`'s membership in `scene3d._submergedWaterEntities` and
 * `scene3d._submergedWaterMeshes` based on its current AC world `(wx, wy, z)`.
 * Fast no-op on dry ground when not previously registered.
 *
 * @param {object|null} scene3d
 * @param {object|null} inst
 * @param {number} wx
 * @param {number} wy
 * @param {number} z
 * @param {ReturnType<typeof waterSubmersionAt>} [precomputedWater]
 * @returns {boolean} true if registered as water-submerged
 */
export function syncEntityWaterSubmersion(scene3d, inst, wx, wy, z, precomputedWater = undefined) {
  if (!scene3d || !inst || inst._disposed) return false;
  const guid = (inst.guid >>> 0);
  const cellIdx = ((inst._currentCellId ?? inst._outdoorCellIdx ?? inst.meta?.landblockId ?? 0) >>> 0) & 0xffff;
  if ((cellIdx & 0x7fff) >= 0x0100) {
    if (inst._isWaterSubmerged) unregisterSubmergedEntity(scene3d, guid, inst);
    return false;
  }

  const wInfo = precomputedWater !== undefined
    ? precomputedWater
    : waterSubmersionAt(scene3d, wx, wy);

  if (!wInfo || !wInfo.overWater || !(z < wInfo.waterZ - 0.02)) {
    if (inst._isWaterSubmerged) unregisterSubmergedEntity(scene3d, guid, inst);
    return false;
  }

  const map = _ensureWaterRegistry(scene3d);
  const meshSet = scene3d._submergedWaterMeshes;
  let entry = map.get(guid);
  const meshes = _collectEntityMeshes(inst);
  if (entry && entry.meshes) {
    for (let i = 0; i < entry.meshes.length; i += 1) {
      meshSet.delete(entry.meshes[i]);
    }
  }
  for (let i = 0; i < meshes.length; i += 1) {
    meshSet.add(meshes[i]);
  }
  const h = estimateEntityHeightM(inst);
  entry = {
    guid,
    inst,
    waterSurfaceY: wInfo.waterZ, // Three Y == AC Z under `worldRoot.rotation.x = -PI/2`
    submergeM: wInfo.submergeM,
    waterType: wInfo.waterType,
    radius: Math.max(1.75, h * 1.15),
    meshes,
  };
  map.set(guid, entry);
  inst._isWaterSubmerged = true;
  inst._waterSurfaceZ = wInfo.waterZ;
  return true;
}

/**
 * Remove an entity from `scene3d._submergedWaterEntities` & `_submergedWaterMeshes`.
 * @param {object|null} scene3d
 * @param {number} guid
 * @param {object|null} [inst]
 */
export function unregisterSubmergedEntity(scene3d, guid, inst = null) {
  const g = guid >>> 0;
  if (inst) {
    inst._isWaterSubmerged = false;
    inst._waterSurfaceZ = undefined;
  }
  const map = scene3d?._submergedWaterEntities;
  if (!(map instanceof Map)) return;
  const entry = map.get(g);
  if (entry) {
    if (entry.inst) {
      entry.inst._isWaterSubmerged = false;
      entry.inst._waterSurfaceZ = undefined;
    }
    const meshSet = scene3d._submergedWaterMeshes;
    if (meshSet instanceof Set && Array.isArray(entry.meshes)) {
      for (let i = 0; i < entry.meshes.length; i += 1) {
        meshSet.delete(entry.meshes[i]);
      }
    }
    map.delete(g);
  }
}

// ============================================================================
// Fix 12B — Underwater Submersion Renderer & Composer Pass
// ============================================================================

const SUBMERSION_VERTEX_GLSL = /* glsl */ `
uniform float uTime;
uniform float uWaterSurfaceY;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying float vViewZ;
#include <common>
#include <logdepthbuf_pars_vertex>

void main() {
  #ifdef USE_UV
    vUv = uv;
  #else
    vUv = position.xy * 0.5 + 0.5;
  #endif
  vec4 wp = modelMatrix * vec4(position, 1.0);
  // Subtle underwater wave-refraction vertex shimmer strictly below waterZ so
  // Pass 1 (depth prepass) and Pass 2 (EqualDepth color) stay 100% invariant.
  float sub = max(0.0, uWaterSurfaceY - wp.y);
  if (sub > 0.0) {
    float amp = min(sub, 1.5) * 0.012;
    wp.x += sin(wp.x * 2.1 + wp.z * 1.7 + uTime * 2.4) * amp;
    wp.z += cos(wp.z * 2.3 - wp.x * 1.5 + uTime * 2.1) * amp;
  }
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 mvPosition = viewMatrix * wp;
  vViewZ = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
}
`;

const DEPTH_PREPASS_FRAGMENT_GLSL = /* glsl */ `
uniform sampler2D uMap;
uniform float uHasMap;
uniform float uAlphaTest;
uniform sampler2D uSceneDepth;
uniform float uHasSceneDepth;
uniform vec2 uInvResolution;
uniform vec3 uCamPos;
uniform float uNear;
uniform float uFar;
uniform float uWaterSurfaceY;
uniform float uReversedZActive;
uniform float uLogDepthActive;
varying vec3 vWorldPos;
varying vec2 vUv;
varying float vViewZ;
#include <common>
#include <logdepthbuf_pars_fragment>

float linearizeSceneDepth(float rawDepth) {
  if (uLogDepthActive > 0.5) {
    return exp2(rawDepth * log2(uFar + 1.0)) - 1.0;
  }
  if (uReversedZActive > 0.5) {
    return (uNear * uFar) / max(uNear + (uFar - uNear) * rawDepth, 1e-6);
  }
  return (uNear * uFar) / max(uFar - rawDepth * (uFar - uNear), 1e-6);
}

void main() {
  // Only draw geometry below the water surface; any dorsal fin tip above
  // waterSurfaceY already drew in the main opaque pass.
  if (vWorldPos.y >= uWaterSurfaceY - 0.01) discard;

  if (uHasMap > 0.5 && uAlphaTest > 0.0) {
    if (texture2D(uMap, vUv).a < uAlphaTest) discard;
  }

  if (uHasSceneDepth > 0.5) {
    vec2 screenUv = gl_FragCoord.xy * uInvResolution;
    float rawSceneDepth = texture2D(uSceneDepth, screenUv).x;
    float sceneLinearDepth = linearizeSceneDepth(rawSceneDepth);
    float fragLinearDepth = max(vViewZ, uNear);
    float tWater = clamp(
      (uCamPos.y - uWaterSurfaceY) / max(uCamPos.y - vWorldPos.y, 1e-3),
      0.0,
      1.0
    );
    float expectedWaterDepth = tWater * fragLinearDepth;
    if (sceneLinearDepth < expectedWaterDepth - 0.45) discard;
  }

  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(0.0);
}
`;

const AQUATIC_COLOR_FRAGMENT_GLSL = /* glsl */ `
uniform sampler2D uMap;
uniform float uHasMap;
uniform float uAlphaTest;
uniform vec3 uBaseColor;
uniform float uOpacity;
uniform sampler2D uSceneDepth;
uniform float uHasSceneDepth;
uniform vec2 uInvResolution;
uniform vec3 uCamPos;
uniform float uNear;
uniform float uFar;
uniform float uTime;
uniform float uWaterSurfaceY;
uniform vec3 uSunDir;
uniform float uSunStrength;
uniform float uAmbientStrength;
uniform float uReversedZActive;
uniform float uLogDepthActive;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying float vViewZ;
#include <common>
#include <logdepthbuf_pars_fragment>

float linearizeSceneDepth(float rawDepth) {
  if (uLogDepthActive > 0.5) {
    return exp2(rawDepth * log2(uFar + 1.0)) - 1.0;
  }
  if (uReversedZActive > 0.5) {
    return (uNear * uFar) / max(uNear + (uFar - uNear) * rawDepth, 1e-6);
  }
  return (uNear * uFar) / max(uFar - rawDepth * (uFar - uNear), 1e-6);
}

float dualWaveCaustics(vec2 p, float t) {
  vec2 uv1 = p * 0.85 + vec2(t * 0.42, -t * 0.31);
  vec2 uv2 = vec2(p.x * 0.62 - p.y * 0.71, p.x * 0.71 + p.y * 0.62) - vec2(t * 0.37, t * 0.46);
  float w1 = sin(uv1.x * 3.1 + sin(uv1.y * 2.7 + t * 1.4)) * cos(uv1.y * 2.9 - cos(uv1.x * 2.3 - t * 1.1));
  float w2 = sin(uv2.x * 3.7 - cos(uv2.y * 3.2 - t * 1.6)) * cos(uv2.y * 3.4 + sin(uv2.x * 2.8 + t * 1.3));
  float c = clamp(0.5 + 0.5 * (w1 * 0.55 + w2 * 0.45), 0.0, 1.0);
  return pow(c, 3.2);
}

void main() {
  if (vWorldPos.y >= uWaterSurfaceY - 0.01) discard;

  if (uHasSceneDepth > 0.5) {
    vec2 screenUv = gl_FragCoord.xy * uInvResolution;
    float rawSceneDepth = texture2D(uSceneDepth, screenUv).x;
    float sceneLinearDepth = linearizeSceneDepth(rawSceneDepth);
    float fragLinearDepth = max(vViewZ, uNear);
    float tWater = clamp(
      (uCamPos.y - uWaterSurfaceY) / max(uCamPos.y - vWorldPos.y, 1e-3),
      0.0,
      1.0
    );
    float expectedWaterDepth = tWater * fragLinearDepth;
    if (sceneLinearDepth < expectedWaterDepth - 0.45) discard;
  }

  float submergeDepth = max(0.0, uWaterSurfaceY - vWorldPos.y);

  // Subtle wave-refraction UV shimmer scaled by shallow submersion depth.
  float refrStrength = 0.0085 * clamp(submergeDepth, 0.08, 2.0);
  vec2 shimmer = vec2(
    sin(vWorldPos.x * 3.4 + vWorldPos.z * 2.2 + uTime * 2.8),
    cos(vWorldPos.z * 3.1 - vWorldPos.x * 2.5 + uTime * 2.5)
  ) * refrStrength;
  vec2 sampleUv = vUv + shimmer;

  vec4 texel = vec4(1.0);
  if (uHasMap > 0.5) {
    texel = texture2D(uMap, sampleUv);
    if (uAlphaTest > 0.0 && texel.a < uAlphaTest) discard;
  }

  vec3 N = normalize(vWorldNormal);
  float halfLambert = 0.5 * dot(N, normalize(uSunDir)) + 0.5;
  float lit = uAmbientStrength + uSunStrength * (0.35 + 0.65 * halfLambert);
  vec3 albedo = uBaseColor * texel.rgb * lit;

  // Animated dual-wave underwater caustics across upward-facing surfaces.
  float upFacing = clamp(N.y * 0.65 + 0.35, 0.15, 1.0);
  float causticFade = exp(-0.32 * submergeDepth) * clamp(submergeDepth * 3.0, 0.0, 1.0);
  float caustics = dualWaveCaustics(vWorldPos.xz, uTime) * upFacing * causticFade * (0.25 + 0.55 * uSunStrength);
  vec3 litBody = albedo + vec3(0.42, 0.78, 0.88) * caustics * 0.48;

  // Beer-Lambert teal-blue underwater light absorption:
  //   I(d) = I0 * exp(-sigma * d), sigma = (0.55, 0.22, 0.16) m^-1
  vec3 absorption = exp(-vec3(0.55, 0.22, 0.16) * submergeDepth);
  vec3 inscatter = vec3(0.028, 0.115, 0.155) * (0.35 + 0.65 * uSunStrength);
  vec3 aquaticColor = litBody * absorption + inscatter * (vec3(1.0) - absorption);

  // Fresnel water-surface transmission: steep downward views see clearly into
  // the water (alpha <= 0.78), while shallow grazing angles reflect the sky.
  vec3 viewToCam = normalize(uCamPos - vWorldPos);
  float cosTheta = clamp(abs(viewToCam.y), 0.05, 1.0);
  float f0 = 0.02;
  float fresnelReflect = f0 + (1.0 - f0) * pow(1.0 - cosTheta, 5.0);
  float depthVis = exp(-0.14 * submergeDepth);
  float transmissionAlpha = (1.0 - fresnelReflect) * 0.78 * depthVis * clamp(uOpacity * texel.a, 0.0, 1.0);
  transmissionAlpha = clamp(transmissionAlpha, 0.0, 0.78);

  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(max(aquaticColor, vec3(0.0)), transmissionAlpha);
}
`;

const COMPOSITE_VERTEX_GLSL = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMPOSITE_FRAGMENT_GLSL = /* glsl */ `
uniform sampler2D uSubmersionTex;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uSubmersionTex, vUv);
  if (c.a <= 0.001) discard;
  gl_FragColor = vec4(c.rgb, clamp(c.a, 0.0, 0.78));
}
`;

function _buildSharedUniforms() {
  return {
    uMap: { value: null },
    uHasMap: { value: 0 },
    uAlphaTest: { value: 0 },
    uBaseColor: { value: new THREE.Color(1, 1, 1) },
    uOpacity: { value: 1.0 },
    uSceneDepth: { value: null },
    uHasSceneDepth: { value: 0 },
    uInvResolution: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uCamPos: { value: new THREE.Vector3() },
    uNear: { value: 0.1 },
    uFar: { value: 2000.0 },
    uTime: { value: 0.0 },
    uWaterSurfaceY: { value: 0.0 },
    uSunDir: { value: new THREE.Vector3(0.35, 0.85, 0.35).normalize() },
    uSunStrength: { value: 0.85 },
    uAmbientStrength: { value: 0.45 },
    uReversedZActive: { value: 0.0 },
    uLogDepthActive: { value: 0.0 },
  };
}

function _isAncestorVisible(obj) {
  let cur = obj;
  for (let d = 0; d < 32 && cur; d += 1) {
    if (cur.visible === false) return false;
    cur = cur.parent;
  }
  return true;
}

/**
 * Create the standalone underwater submersion renderer for `scene3d`.
 *
 * @param {object} scene3d
 * @param {object} [opts]
 * @param {number} [opts.maxDistanceM=180]
 */
export function createUnderwaterSubmersionRenderer(scene3dOrCfg, opts = {}) {
  const isCfgObj = Boolean(
    scene3dOrCfg &&
    typeof scene3dOrCfg === "object" &&
    "scene3d" in scene3dOrCfg &&
    scene3dOrCfg.scene3d,
  );
  const scene3d = isCfgObj ? scene3dOrCfg.scene3d : scene3dOrCfg;
  const mergedOpts = isCfgObj ? { ...scene3dOrCfg, ...opts } : (opts || {});
  const defaultRenderer = mergedOpts.renderer ?? scene3d?.renderer ?? null;
  const maxDistM = Number.isFinite(mergedOpts.maxDistanceM) && mergedOpts.maxDistanceM > 0
    ? mergedOpts.maxDistanceM
    : MAX_UNDERWATER_RENDER_DIST_M;

  const uniforms = _buildSharedUniforms();

  const depthPrepassMaterial = new THREE.ShaderMaterial({
    name: "UnderwaterSubmersionDepthPrepass",
    uniforms,
    vertexShader: SUBMERSION_VERTEX_GLSL,
    fragmentShader: DEPTH_PREPASS_FRAGMENT_GLSL,
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    side: THREE.DoubleSide,
  });

  const aquaticColorMaterial = new THREE.ShaderMaterial({
    name: "UnderwaterSubmersionAquaticColor",
    uniforms,
    vertexShader: SUBMERSION_VERTEX_GLSL,
    fragmentShader: AQUATIC_COLOR_FRAGMENT_GLSL,
    colorWrite: true,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.EqualDepth,
    transparent: false,
    blending: THREE.NoBlending,
    side: THREE.DoubleSide,
  });

  const compositeUniforms = {
    uSubmersionTex: { value: null },
  };
  const compositeMaterial = new THREE.ShaderMaterial({
    name: "UnderwaterSubmersionComposite",
    uniforms: compositeUniforms,
    vertexShader: COMPOSITE_VERTEX_GLSL,
    fragmentShader: COMPOSITE_FRAGMENT_GLSL,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });

  // Fullscreen single triangle covering [-1, 1]^2 with no diagonal seam.
  const fsGeom = new THREE.BufferGeometry();
  fsGeom.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  fsGeom.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2),
  );
  const compositeMesh = new THREE.Mesh(fsGeom, compositeMaterial);
  compositeMesh.frustumCulled = false;
  const compositeScene = new THREE.Scene();
  compositeScene.name = "UnderwaterSubmersion.CompositeScene";
  compositeScene.matrixWorldAutoUpdate = false;
  compositeScene.add(compositeMesh);
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const subScene = new THREE.Scene();
  subScene.name = "UnderwaterSubmersion.MeshScene";
  subScene.matrixWorldAutoUpdate = false;
  const emptyChildren = [];

  let submersionTarget = null;
  let targetW = 1;
  let targetH = 1;
  let disposed = false;

  const _projScreenMat = new THREE.Matrix4();
  const _frustum = new THREE.Frustum();
  const _sphere = new THREE.Sphere();
  const _worldPos = new THREE.Vector3();
  const _savedClearColor = new THREE.Color();
  const _visibleEntries = [];

  const stats = {
    frames: 0,
    earlyOutFrames: 0,
    drawnFrames: 0,
    visibleEntities: 0,
    drawCalls: 0,
    lastCpuMs: 0,
  };

  function _ensureSubmersionTarget(w, h) {
    const sw = Math.max(1, w | 0);
    const sh = Math.max(1, h | 0);
    if (!submersionTarget) {
      submersionTarget = new THREE.WebGLRenderTarget(sw, sh, {
        type: THREE.HalfFloatType,
        depthBuffer: true,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      submersionTarget.depthTexture = null; // Own depth renderbuffer -> zero feedback loop!
      submersionTarget.texture.name = "UnderwaterSubmersion.Buffer";
      submersionTarget.texture.generateMipmaps = false;
      targetW = sw;
      targetH = sh;
    } else if (targetW !== sw || targetH !== sh) {
      submersionTarget.setSize(sw, sh);
      targetW = sw;
      targetH = sh;
    }
    return submersionTarget;
  }

  function _syncLightingUniforms() {
    const sunDir = scene3d?.atmosphereLights?.sun?.sunDirection ?? scene3d?.lighting?.csmState?.sunDir;
    if (sunDir && Number.isFinite(sunDir.x)) {
      uniforms.uSunDir.value.set(sunDir.x, sunDir.y, sunDir.z).normalize();
    }
    const sunVis = scene3d?.lighting?.sun?.visible !== false;
    const sunI = scene3d?.lighting?.sun?.intensity;
    uniforms.uSunStrength.value = !sunVis
      ? 0.15
      : (typeof sunI === "number" && Number.isFinite(sunI) ? Math.min(1.25, Math.max(0.12, sunI * 0.45)) : 0.8);
    const ambI = scene3d?.lighting?.ambient?.intensity;
    uniforms.uAmbientStrength.value = typeof ambI === "number" && Number.isFinite(ambI)
      ? Math.min(0.85, Math.max(0.22, ambI * 0.55))
      : 0.42;
  }

  function _applyMeshMaterialUniforms(mesh, passMat) {
    const srcMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const map = srcMat?.map ?? null;
    uniforms.uMap.value = map;
    uniforms.uHasMap.value = map ? 1.0 : 0.0;
    uniforms.uAlphaTest.value = (srcMat && typeof srcMat.alphaTest === "number" && srcMat.alphaTest > 0)
      ? srcMat.alphaTest
      : 0.0;
    if (srcMat?.color?.isColor) {
      uniforms.uBaseColor.value.copy(srcMat.color);
    } else {
      uniforms.uBaseColor.value.setRGB(1, 1, 1);
    }
    uniforms.uOpacity.value = (srcMat && typeof srcMat.opacity === "number")
      ? srcMat.opacity
      : 1.0;
    passMat.side = srcMat?.side ?? THREE.DoubleSide;
  }

  /**
   * Render visible water-submerged monsters into `writeBuffer` (or the default
   * framebuffer when `writeBuffer === null`).
   *
   * Fast early-out: returns `0` in ~`0.000 ms` with `0` GL state changes or draw
   * calls whenever no submerged water entity is within frustum and `< 180 m`.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget|null} writeBuffer
   * @param {THREE.Texture|null} stableDepthTexture
   * @param {THREE.Camera} camera
   * @param {number} [timeSec=0]
   * @returns {number} number of submerged meshes drawn (0 on early-out)
   */
  function render(rendererOrOpts, writeBuffer, stableDepthTexture, camera, timeSec = 0) {
    let renderer = rendererOrOpts;
    if (
      rendererOrOpts &&
      typeof rendererOrOpts === "object" &&
      typeof rendererOrOpts.render !== "function" &&
      ("renderer" in rendererOrOpts || "camera" in rendererOrOpts || "outputBuffer" in rendererOrOpts)
    ) {
      renderer = rendererOrOpts.renderer ?? defaultRenderer;
      writeBuffer = rendererOrOpts.outputBuffer ?? rendererOrOpts.writeBuffer ?? null;
      stableDepthTexture = rendererOrOpts.depthTexture ?? rendererOrOpts.stableDepthTexture ?? null;
      camera = rendererOrOpts.camera ?? scene3d?.cameraSwitcher?.activeCamera ?? scene3d?.camera ?? null;
      timeSec = rendererOrOpts.timeSec ?? 0;
    } else if (!renderer) {
      renderer = defaultRenderer;
    }
    stats.frames += 1;
    if (disposed || !renderer || !camera || !underwaterSubmersionEnabled()) {
      stats.earlyOutFrames += 1;
      stats.visibleEntities = 0;
      stats.drawCalls = 0;
      stats.lastCpuMs = 0;
      return 0;
    }

    const reg = scene3d?._submergedWaterEntities;
    if (!(reg instanceof Map) || reg.size === 0) {
      stats.earlyOutFrames += 1;
      stats.visibleEntities = 0;
      stats.drawCalls = 0;
      stats.lastCpuMs = 0;
      return 0;
    }

    const t0 = typeof performance !== "undefined" && performance.now ? performance.now() : 0;

    camera.updateMatrixWorld?.();
    _projScreenMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreenMat);
    const camPos = camera.position;

    _visibleEntries.length = 0;
    for (const [guid, entry] of reg) {
      const inst = entry.inst;
      if (!inst || inst._disposed || !inst.root) {
        reg.delete(guid);
        continue;
      }
      if (!inst.root.parent || !_isAncestorVisible(inst.root)) continue;

      // Refresh mesh list if parts hot-swapped or spawned after registration.
      if (!entry.meshes || entry.meshes.length === 0) {
        entry.meshes = _collectEntityMeshes(inst);
        if (entry.meshes.length === 0) continue;
        if (scene3d._submergedWaterMeshes instanceof Set) {
          for (let i = 0; i < entry.meshes.length; i += 1) {
            scene3d._submergedWaterMeshes.add(entry.meshes[i]);
          }
        }
      }

      // AC local `(p.x, p.y, p.z)` under `worldRoot.rotation.x = -PI/2` maps to
      // Three world `(p.x, p.z, -p.y)`.
      const p = inst.root.position;
      _worldPos.set(p.x, p.z, -p.y);
      const maxR = maxDistM + entry.radius;
      if (_worldPos.distanceToSquared(camPos) > maxR * maxR) continue;

      _sphere.center.copy(_worldPos);
      _sphere.radius = entry.radius;
      if (!_frustum.intersectsSphere(_sphere)) continue;

      // Skip if the entire bounding sphere is somehow above the water surface.
      if (_worldPos.y - entry.radius >= entry.waterSurfaceY - 0.01) continue;

      _visibleEntries.push(entry);
    }

    if (_visibleEntries.length === 0) {
      stats.earlyOutFrames += 1;
      stats.visibleEntities = 0;
      stats.drawCalls = 0;
      stats.lastCpuMs = 0;
      return 0;
    }

    // Determine pixel dimensions of destination buffer.
    let bufW = writeBuffer?.width ?? 0;
    let bufH = writeBuffer?.height ?? 0;
    if (!(bufW > 0 && bufH > 0)) {
      const sz = renderer.getDrawingBufferSize
        ? renderer.getDrawingBufferSize(new THREE.Vector2())
        : { x: targetW || 1280, y: targetH || 720 };
      bufW = sz.x || 1280;
      bufH = sz.y || 720;
    }

    const subTarget = _ensureSubmersionTarget(bufW, bufH);
    const reversedZ = Boolean(
      mergedOpts.forceReversedZ === true ||
      renderer.state?.buffers?.depth?.getReversed?.() === true,
    );
    const logDepth = Boolean(
      mergedOpts.forceLogDepth === true ||
      renderer.capabilities?.logarithmicDepthBuffer === true,
    );

    depthPrepassMaterial.depthFunc = reversedZ ? THREE.GreaterEqualDepth : THREE.LessEqualDepth;
    uniforms.uReversedZActive.value = reversedZ ? 1.0 : 0.0;
    uniforms.uLogDepthActive.value = logDepth ? 1.0 : 0.0;
    uniforms.uSceneDepth.value = stableDepthTexture || null;
    uniforms.uHasSceneDepth.value = stableDepthTexture ? 1.0 : 0.0;
    uniforms.uInvResolution.value.set(1.0 / bufW, 1.0 / bufH);
    uniforms.uCamPos.value.copy(camPos);
    uniforms.uNear.value = camera.near > 0 ? camera.near : 0.1;
    uniforms.uFar.value = camera.far > 1 ? camera.far : 2000.0;
    uniforms.uTime.value = Number.isFinite(timeSec) ? timeSec : 0.0;
    _syncLightingUniforms();

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClearAlpha = renderer.getClearAlpha ? renderer.getClearAlpha() : 1;
    if (renderer.getClearColor) renderer.getClearColor(_savedClearColor);
    const prevCamMask = camera.layers.mask;
    camera.layers.mask = 0xffffffff;

    let drawCalls = 0;
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(subTarget);
      if (renderer.setClearColor) renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);

      // Pass 1: Depth Prepass (`colorWrite = false`, `depthWrite = true`) so
      // multi-part monster limbs resolve exact frontmost depth with zero
      // internal alpha-stacking.
      for (let eIdx = 0; eIdx < _visibleEntries.length; eIdx += 1) {
        const entry = _visibleEntries[eIdx];
        uniforms.uWaterSurfaceY.value = entry.waterSurfaceY;
        const meshes = entry.meshes;
        for (let mIdx = 0; mIdx < meshes.length; mIdx += 1) {
          const mesh = meshes[mIdx];
          if (!mesh || mesh.visible === false) continue;
          mesh.updateWorldMatrix?.(true, false);
          const origMat = mesh.material;
          const origCulled = mesh.frustumCulled;
          _applyMeshMaterialUniforms(mesh, depthPrepassMaterial);
          mesh.material = depthPrepassMaterial;
          mesh.frustumCulled = false;
          subScene.children = [mesh];
          try {
            renderer.render(subScene, camera);
            drawCalls += 1;
          } finally {
            mesh.material = origMat;
            mesh.frustumCulled = origCulled;
            subScene.children = emptyChildren;
          }
        }
      }

      // Pass 2: Aquatic Shading Color Pass (`depthFunc = EqualDepth`, `depthWrite = false`).
      for (let eIdx = 0; eIdx < _visibleEntries.length; eIdx += 1) {
        const entry = _visibleEntries[eIdx];
        uniforms.uWaterSurfaceY.value = entry.waterSurfaceY;
        const meshes = entry.meshes;
        for (let mIdx = 0; mIdx < meshes.length; mIdx += 1) {
          const mesh = meshes[mIdx];
          if (!mesh || mesh.visible === false) continue;
          const origMat = mesh.material;
          const origCulled = mesh.frustumCulled;
          _applyMeshMaterialUniforms(mesh, aquaticColorMaterial);
          mesh.material = aquaticColorMaterial;
          mesh.frustumCulled = false;
          subScene.children = [mesh];
          try {
            renderer.render(subScene, camera);
            drawCalls += 1;
          } finally {
            mesh.material = origMat;
            mesh.frustumCulled = origCulled;
            subScene.children = emptyChildren;
          }
        }
      }

      // Composite onto `writeBuffer` with hardware `SrcAlpha, OneMinusSrcAlpha`
      // (`depthTest: false, depthWrite: false` -> preserves scene depth buffer!).
      compositeUniforms.uSubmersionTex.value = subTarget.texture;
      renderer.setRenderTarget(writeBuffer || null);
      renderer.render(compositeScene, orthoCam);
      drawCalls += 1;
    } finally {
      subScene.children = emptyChildren;
      camera.layers.mask = prevCamMask;
      if (renderer.setClearColor) renderer.setClearColor(_savedClearColor, prevClearAlpha);
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }

    stats.drawnFrames += 1;
    stats.visibleEntities = _visibleEntries.length;
    stats.drawCalls = drawCalls;
    stats.lastCpuMs = (typeof performance !== "undefined" && performance.now ? performance.now() : 0) - t0;
    return drawCalls;
  }

  function setSize(w, h) {
    targetW = Math.max(1, w | 0);
    targetH = Math.max(1, h | 0);
    if (submersionTarget) {
      submersionTarget.setSize(targetW, targetH);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (submersionTarget) {
      try { submersionTarget.dispose(); } catch (_) {}
      submersionTarget = null;
    }
    try { depthPrepassMaterial.dispose(); } catch (_) {}
    try { aquaticColorMaterial.dispose(); } catch (_) {}
    try { compositeMaterial.dispose(); } catch (_) {}
    try { fsGeom.dispose(); } catch (_) {}
  }

  /**
   * Build a pmndrs `EffectComposer`-compatible Pass (zero `postprocessing`
   * import needed) that runs after the opaque world pass (and `ssaoPass`) and
   * before `fxPass` (clouds / aerial perspective).
   *
   * Setting `needsDepthTexture = true` and `needsSwap = false` instructs
   * `EffectComposer` to copy/resolve the opaque world + water surface depth
   * into `composer.depthTexture` ahead of this pass, while on early-out frames
   * (no visible underwater monster within 180 m) `render()` costs 0.000 ms and
   * 0 draw calls.
   *
   * @param {THREE.Camera} initialCamera
   * @param {{ depthSource?: () => THREE.Texture|null }} [passOpts]
   */
  function createPass(initialCamera, passOpts = {}) {
    let passCamera = initialCamera || null;
    let boundDepthTexture = null;
    let elapsedSec = 0;
    const depthSource = typeof passOpts.depthSource === "function" ? passOpts.depthSource : null;
    return {
      name: "UnderwaterSubmersionPass",
      enabled: true,
      needsSwap: false,
      needsDepthTexture: true,
      renderToScreen: false,
      clear: false,
      get camera() { return passCamera; },
      set camera(c) { passCamera = c; },
      get mainCamera() { return passCamera; },
      set mainCamera(c) { passCamera = c; },
      set mainScene(_s) {},
      initialize() {},
      getDepthTexture() {
        return (depthSource && depthSource()) || boundDepthTexture;
      },
      setDepthTexture(depthTexture, _depthPacking) {
        boundDepthTexture = depthTexture || null;
      },
      setSize(width, height) {
        setSize(width, height);
      },
      render(renderer, inputBuffer, _outputBuffer, deltaTime) {
        if (!this.enabled) return;
        const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? Math.min(deltaTime, 0.25) : 1 / 60;
        elapsedSec = (elapsedSec + dt) % 4096;
        const cam = passCamera ?? scene3d?.cameraSwitcher?.activeCamera ?? scene3d?.camera ?? null;
        const depthTex = (depthSource && depthSource()) || boundDepthTexture;
        render(renderer, inputBuffer, depthTex, cam, elapsedSec);
      },
      dispose() {
        dispose();
      },
    };
  }

  return {
    render,
    createPass,
    createComposerPass: createPass,
    setSize,
    dispose,
    getStats: () => ({ ...stats }),
    stats: () => ({ ...stats }),
    _materials: {
      depthPrepassMaterial,
      aquaticColorMaterial,
      compositeMaterial,
      uniforms,
    },
  };
}
