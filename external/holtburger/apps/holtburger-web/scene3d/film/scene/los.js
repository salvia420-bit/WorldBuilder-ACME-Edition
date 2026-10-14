// scene3d/film/scene/los.js — layered line-of-sight / clearance sweeps for AC Film Mode (SPEC §2.15).
//
// WHY: the film camera has to know, many times per second, whether a segment
// is free — camera → subject (is the subject visible?), eye → next eye (the
// safety clamp), eye → probe point (perception sectors). The wasm client
// already answers that per collision LAYER (building physics triangles, stab
// AABBs, scenery trunks/boulders, EnvCell shells, cell furniture, BSP doors,
// creature/player cylspheres), but each export has its own catch:
//   * building triangles are indexed per landblock (ONE lb per call), statics
//     and scenery scan the 3×3 ring around the lb passed — a long segment
//     swept once silently passes through everything outside that ring, so
//     the segment is CHUNKED per landblock (every chunk ≤ 192 m);
//   * every hit is a wasm-bindgen `CollisionHit` box that leaks unless freed
//     — fields are COPIED and every box is `free()`d, kept or not;
//   * a stale pkg/ may lack an export — every method is typeof-guarded and
//     try-wrapped, a missing layer simply finds nothing;
//   * t ≈ 0 means the sphere STARTED embedded — `projectileHitStops` decides
//     (moving away from / along the surface never counts, moving into it does);
//   * the object layer must ignore the subject itself — its guid goes in as
//     `missile_guid` (`sweepSphereAgainstObjects` skips guid == missile_guid).
// Terrain is not a wasm layer here: `projectileTerrainCrossing` marches the
// segment against an INJECTED `terrainZAt(x, y)` (the page passes
// `sh.terrainHeightAt` or the terrain corridor oracle; never pass it indoors —
// above a dungeon it returns the SURFACE height).
//
// The earliest stopping hit over all layers and chunks wins and is reported
// with its layer and a kind word (`kindForLayer`) for the JEV pilot's state.
// Hits carry no object identity; page adapters may refine the kind near the
// hit point (world_query) and pass it back through kindForLayer's `extra`.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm imports — the session handle is injected (or a test fake).
// Deterministic. Imports only dependency-free modules.

import { FilmError, FILM_ERROR_CODES } from "../core/errors.js";
import { landblockOfWorld } from "../core/units.js";
import { projectileHitStops, projectileTerrainCrossing } from "../../projectile_sweep.js";

/** Landblock edge (m) — the maximum chunk length and the chunk grid. */
export const LOS_CHUNK_M = 192;

/** Default sweep-sphere radius (m). */
export const LOS_DEFAULT_RADIUS = 0.25;

/** Entity-layer scan reach beyond a chunk's length (m): door leaf half-width + slack. */
export const LOS_ENTITY_RANGE_MARGIN_M = 5;

/** Below-surface tolerance (m) before a terrain probe counts as a crossing. */
export const LOS_TERRAIN_EPS = 0.05;

/** Step (m) of the central-difference terrain normal at a terrain hit. */
const TERRAIN_NORMAL_STEP_M = 0.5;

/** Hard cap on the number of chunks swept per call (≈ 49 km of segment). */
export const LOS_MAX_CHUNKS = 256;

/** Segments shorter than this (m) are never swept (zero-length → clear). */
const MIN_SEGMENT_M = 1e-6;

/**
 * Collision layers, in sweep order (terrain first: it is pure JS and lets the
 * chunk loop stop early). Layer names are what `segmentBlocked` reports and
 * what its `layers` option selects.
 * @type {ReadonlyArray<string>}
 */
export const LOS_LAYER_NAMES = Object.freeze([
  "terrain", "buildingMesh", "statics", "scenery", "cellMesh", "cellStatics", "entities", "objects",
]);

/**
 * Wasm `SessionHandle` method of each sweep layer (terrain has none — it uses
 * the injected `terrainZAt`).
 * @type {Readonly<Record<string, string>>}
 */
export const LOS_LAYER_METHODS = Object.freeze({
  buildingMesh: "sweepSphereAgainstBuildingMesh",
  statics: "sweepSphereAgainstStatics",
  scenery: "sweepSphereAgainstScenery",
  cellMesh: "sweepSphereAgainstCellMesh",
  cellStatics: "sweepSphereAgainstCellStatics",
  entities: "sweepSphereAgainstEntities",
  objects: "sweepSphereAgainstObjects",
});

/**
 * Every kind word kindForLayer can return (a subset of pilot/sense_words.js OBSTACLE_KINDS).
 * @type {ReadonlyArray<string>}
 */
export const LOS_KINDS = Object.freeze(["tree", "rock", "wall", "building", "prop", "door", "creature", "terrain"]);

/** Wasm layers in sweep order (LOS_LAYER_NAMES minus terrain). */
const WASM_LAYERS = LOS_LAYER_NAMES.filter((n) => n !== "terrain");

/** Aliases accepted for layer names (lower-cased keys). */
const LAYER_ALIASES = Object.freeze({
  terrain: "terrain",
  ground: "terrain",
  buildingmesh: "buildingMesh",
  building: "buildingMesh",
  buildings: "buildingMesh",
  statics: "statics",
  static: "statics",
  scenery: "scenery",
  cellmesh: "cellMesh",
  cell: "cellMesh",
  cells: "cellMesh",
  cellstatics: "cellStatics",
  entities: "entities",
  doors: "entities",
  objects: "objects",
  creatures: "objects",
});

/** Kind aliases → LOS_KINDS (lower-cased keys). */
const KIND_ALIASES = Object.freeze({
  tree: "tree", trees: "tree", foliage: "tree", bush: "tree", plant: "tree", trunk: "tree",
  rock: "rock", rocks: "rock", boulder: "rock", stone: "rock",
  wall: "wall", walls: "wall", cell: "wall", dungeon: "wall",
  building: "building", buildings: "building", house: "building", tower: "building",
  prop: "prop", props: "prop", static: "prop", statics: "prop", furniture: "prop", object: "prop", chest: "prop",
  door: "door", doors: "door", gate: "door",
  creature: "creature", creatures: "creature", npc: "creature", monster: "creature", player: "creature",
  entity: "creature",
  terrain: "terrain", ground: "terrain", hill: "terrain",
});

/**
 * Canonical layer name for a layer name, alias ("building", "cell", "doors",
 * "creatures") or wasm method name ("sweepSphereAgainstScenery", as
 * projectile_sweep.js reports it). Unknown / non-string → null.
 * @param {*} name
 * @returns {string|null}
 */
export function normalizeLayerName(name) {
  if (typeof name !== "string") return null;
  const s = name.trim();
  if (!s) return null;
  for (const [layer, method] of Object.entries(LOS_LAYER_METHODS)) if (s === method) return layer;
  const key = s.toLowerCase();
  return Object.prototype.hasOwnProperty.call(LAYER_ALIASES, key) ? LAYER_ALIASES[key] : null;
}

/**
 * A kind word or alias as one of LOS_KINDS ("boulder" → rock, "npc" / "player"
 * → creature, "furniture" → prop, "foliage" → tree, "house" → building, …);
 * null when unknown or not a string.
 * @param {*} kind
 * @returns {string|null}
 */
export function normalizeKind(kind) {
  if (typeof kind !== "string") return null;
  const k = kind.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(KIND_ALIASES, k) ? KIND_ALIASES[k] : null;
}

/**
 * Obstacle kind word for a hit layer (SPEC §2.15): `tree | rock | wall |
 * building | prop | door | creature | terrain`.
 *
 * - `extra.kind` (e.g. resolved by world_query near the hit point) wins when it
 *   names a known kind or alias ("boulder" → rock, "npc"/"player" → creature,
 *   "furniture" → prop, "foliage" → tree);
 * - terrain → terrain; cellMesh → wall; cellStatics / statics → prop;
 *   entities (closed doors, chests: HAS_PHYSICS_BSP) → door; objects
 *   (creatures/players/props by cylsphere) → creature;
 * - buildingMesh → `wall` when `extra.indoor` (a town interior's walls ARE the
 *   building GfxObj), else `building`;
 * - scenery (trunk cylspheres and boulder spheres; the hit has no identity) →
 *   `rock` when the hit normal is steep (|normal.z| ≥ 0.5 — a trunk's side
 *   normal is horizontal), else `tree`;
 * - an unknown layer → `prop` (a generic solid).
 * @param {string} layer a layer name, alias or wasm method name
 * @param {{kind?:string, indoor?:boolean, normal?:number[]|{x:number,y:number,z:number}}} [extra]
 * @returns {string} one of LOS_KINDS
 */
export function kindForLayer(layer, extra = {}) {
  const e = extra && typeof extra === "object" ? extra : {};
  const known = normalizeKind(e.kind);
  if (known) return known;
  switch (normalizeLayerName(layer)) {
    case "terrain":
      return "terrain";
    case "buildingMesh":
      return e.indoor === true ? "wall" : "building";
    case "statics":
      return "prop";
    case "scenery": {
      const n = toVec(e.normal);
      return n && Math.abs(n[2]) >= 0.5 ? "rock" : "tree";
    }
    case "cellMesh":
      return "wall";
    case "cellStatics":
      return "prop";
    case "entities":
      return "door";
    case "objects":
      return "creature";
    default:
      return "prop";
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * `[x, y, z]` from an array-like or `{x, y, z}`; null unless all three are finite.
 * @param {*} p
 * @returns {number[]|null}
 */
function toVec(p) {
  if (p == null || typeof p !== "object") return null;
  const x = p[0] !== undefined ? p[0] : p.x;
  const y = p[1] !== undefined ? p[1] : p.y;
  const z = p[2] !== undefined ? p[2] : p.z;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/**
 * Resolve the `layers` option to a Set of canonical names (default: all).
 * Throws FilmError (BAD_ARGUMENT) for an unknown name — a programming error.
 * @param {*} layers
 * @returns {Set<string>}
 */
function resolveLayers(layers) {
  if (layers === undefined || layers === null) return new Set(LOS_LAYER_NAMES);
  const list = layers instanceof Set ? [...layers] : Array.isArray(layers) ? layers : typeof layers === "string" ? [layers] : null;
  if (!list) {
    throw new FilmError(`segmentBlocked: layers must be an array or Set of layer names (valid: ${LOS_LAYER_NAMES.join(", ")})`,
      FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  const out = new Set();
  for (const n of list) {
    const c = normalizeLayerName(n);
    if (!c) {
      throw new FilmError(`segmentBlocked: unknown layer ${JSON.stringify(n)} (valid: ${LOS_LAYER_NAMES.join(", ")})`,
        FILM_ERROR_CODES.BAD_ARGUMENT);
    }
    out.add(c);
  }
  return out;
}

/**
 * Cell id list as the Uint32Array the wasm cell sweeps take; null when empty.
 * Non-finite entries are dropped.
 * @param {*} cellIds
 * @returns {Uint32Array|null}
 */
function toCellArray(cellIds) {
  if (cellIds == null) return null;
  if (cellIds instanceof Uint32Array) return cellIds.length > 0 ? cellIds : null;
  let list;
  if (Array.isArray(cellIds) || ArrayBuffer.isView(cellIds)) list = Array.from(cellIds);
  else if (cellIds instanceof Set) list = [...cellIds];
  else if (typeof cellIds === "number") list = [cellIds];
  else return null;
  const ids = list.filter((v) => typeof v === "number" && Number.isFinite(v)).map((v) => v >>> 0);
  return ids.length > 0 ? Uint32Array.from(ids) : null;
}

/** True when any id in the list is an EnvCell (low word 0x0100..0xFFFD). */
function hasIndoorCell(cells) {
  if (!cells) return false;
  for (const id of cells) {
    const lo = id & 0xffff;
    if (lo >= 0x0100 && lo <= 0xfffd) return true;
  }
  return false;
}

/** A terrainZAt wrapper that never throws and returns a finite number or null. */
function safeTerrain(fn) {
  return (x, y) => {
    let z;
    try {
      z = fn(x, y);
    } catch {
      return null;
    }
    return typeof z === "number" && Number.isFinite(z) ? z : null;
  };
}

/** Up-facing unit terrain normal at (x, y) by central differences; [0,0,1] when unknown. */
function terrainNormal(zAt, x, y) {
  const h = TERRAIN_NORMAL_STEP_M;
  const zx0 = zAt(x - h, y), zx1 = zAt(x + h, y), zy0 = zAt(x, y - h), zy1 = zAt(x, y + h);
  if (zx0 === null || zx1 === null || zy0 === null || zy1 === null) return [0, 0, 1];
  const gx = (zx1 - zx0) / (2 * h), gy = (zy1 - zy0) / (2 * h);
  const l = Math.sqrt(gx * gx + gy * gy + 1);
  return [-gx / l, -gy / l, 1 / l];
}

/**
 * Split the segment `from → to` into chunks that each lie inside one landblock
 * square (split where the XY line crosses a multiple of 192 m) and are at most
 * `maxLen` metres long (long vertical runs are subdivided evenly). Each chunk
 * names the landblock containing its midpoint (grid-clamped). Zero-length or
 * non-finite input → []. At most LOS_MAX_CHUNKS chunks; `truncated` is set on
 * the returned array when the segment needed more (the rest is not swept).
 * @param {number[]|{x:number,y:number,z:number}} from
 * @param {number[]|{x:number,y:number,z:number}} to
 * @param {{maxLen?:number}} [opts] maxLen default 192 (clamped to [1, 192])
 * @returns {Array<{t0:number, t1:number, from:number[], to:number[], length:number, lbKey:number}> & {truncated?:boolean}}
 */
export function segmentChunks(from, to, opts = {}) {
  const out = [];
  const a = toVec(from), b = toVec(to);
  if (!a || !b) return out;
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  if (!(L > MIN_SEGMENT_M)) return out;
  const o = opts || {};
  const maxLen = Number.isFinite(o.maxLen) ? Math.min(LOS_CHUNK_M, Math.max(1, o.maxLen)) : LOS_CHUNK_M;
  const ts = [0, 1];
  let truncated = false;
  for (let axis = 0; axis < 2; axis++) {
    const da = d[axis];
    if (!(Math.abs(da) > 1e-12)) continue;
    const lo = Math.min(a[axis], b[axis]), hi = Math.max(a[axis], b[axis]);
    const k0 = Math.floor(lo / LOS_CHUNK_M) + 1;
    const k1 = Math.ceil(hi / LOS_CHUNK_M) - 1;
    if (k1 - k0 + 1 > LOS_MAX_CHUNKS) {
      truncated = true;
    }
    const kEnd = Math.min(k1, k0 + LOS_MAX_CHUNKS);
    for (let k = k0; k <= kEnd; k++) {
      const t = (k * LOS_CHUNK_M - a[axis]) / da;
      if (t > 0 && t < 1) ts.push(t);
    }
  }
  ts.sort((x, y) => x - y);
  const cuts = [ts[0]];
  for (let i = 1; i < ts.length; i++) if (ts[i] - cuts[cuts.length - 1] > 1e-12) cuts.push(ts[i]);
  if (cuts[cuts.length - 1] < 1) cuts.push(1);
  const at = (t) => [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const c0 = cuts[i], c1 = cuts[i + 1];
    const span = (c1 - c0) * L;
    if (!(span > 1e-9)) continue;
    const parts = Math.max(1, Math.ceil(span / maxLen - 1e-9));
    for (let j = 0; j < parts; j++) {
      if (out.length >= LOS_MAX_CHUNKS) {
        truncated = true;
        break;
      }
      const t0 = c0 + ((c1 - c0) * j) / parts;
      const t1 = j + 1 === parts ? c1 : c0 + ((c1 - c0) * (j + 1)) / parts;
      const p0 = at(t0), p1 = at(t1);
      const mid = at((t0 + t1) / 2);
      out.push({ t0, t1, from: p0, to: p1, length: (t1 - t0) * L, lbKey: landblockOfWorld(mid[0], mid[1]) });
    }
    if (truncated && out.length >= LOS_MAX_CHUNKS) break;
  }
  if (truncated) Object.defineProperty(out, "truncated", { value: true, enumerable: false });
  return out;
}

/**
 * @typedef {Object} LosResult
 * @property {boolean} blocked   a stopping hit was found on the segment
 * @property {number} t          fraction of from→to where it stops (1 when clear)
 * @property {string|null} layer the layer that produced the earliest hit (LOS_LAYER_NAMES)
 * @property {number[]|null} point world hit point (copied from the CollisionHit / terrain surface)
 * @property {number[]|null} normal hit normal (toward the segment start for wasm hits; terrain: up-facing)
 * @property {string|null} kind  kindForLayer(layer, {normal, indoor})
 * @property {number} distance   t · |to − from| (metres)
 * @property {number} length     |to − from| (metres)
 * @property {number} chunks     landblock chunks swept
 * @property {number} calls      wasm sweep calls made (for perception budgets)
 * @property {boolean} valid     false when from/to were not finite points (then never blocked)
 * @property {boolean} [truncated] the segment exceeded LOS_MAX_CHUNKS; its tail was not swept
 */

/**
 * Is the segment `from → to` blocked? A sphere of `radius` is swept through
 * every available collision layer (SPEC §2.15):
 *
 * - the segment is split per landblock (`segmentChunks`, every chunk ≤ 192 m);
 *   per chunk, in order: `sweepSphereAgainstBuildingMesh(…, r, lbKey)`,
 *   `sweepSphereAgainstStatics(…, r, lbKey)`, `sweepSphereAgainstScenery(…, r,
 *   lbKey)`, `sweepSphereAgainstCellMesh(…, r, cellIds)`,
 *   `sweepSphereAgainstCellStatics(…, r, cellIds)` (cell layers only with
 *   `cellIds`), `sweepSphereAgainstEntities(…, r, chunkLength + 5)`,
 *   `sweepSphereAgainstObjects(…, r, subjectGuid, exemptLocalPlayer)`
 *   (missile_guid = subjectGuid, so the subject never occludes itself);
 * - each `sh` method is typeof-guarded and try-wrapped (a stale pkg/ or a
 *   RefCell borrow conflict = no hit from that layer); every returned
 *   CollisionHit is COPIED (t, x, y, z, normalX/Y/Z) and then `free()`d,
 *   whether it is used or not;
 * - the embedded-start rule (`projectileHitStops`, no launch window): a hit at
 *   t ≈ 0 counts only when the segment moves INTO the surface;
 * - terrain (layer "terrain", only with an injected `terrainZAt(x, y) → z|null`)
 *   is marched by `projectileTerrainCrossing` (0.5 m probes + bisection);
 * - the EARLIEST stopping hit over all layers and chunks wins (ties keep the
 *   layer order above); chunks that start after the best hit are skipped.
 *
 * Never throws for bad geometry: non-finite endpoints → `{blocked:false,
 * valid:false}`, a zero-length segment → clear. Throws FilmError only for an
 * unknown `layers` name (a programming error).
 * @param {object|null} sh wasm SessionHandle (or a fake); null → terrain only
 * @param {number[]|{x:number,y:number,z:number}} from world AC metres
 * @param {number[]|{x:number,y:number,z:number}} to world AC metres
 * @param {{radius?:number, subjectGuid?:number, cellIds?:Uint32Array|number[]|Set<number>|null,
 *   layers?:string[]|Set<string>, terrainZAt?:(x:number,y:number)=>number|null,
 *   exemptLocalPlayer?:boolean, terrainEps?:number, entityRangeMargin?:number}} [opts]
 *   radius 0.25; subjectGuid 0; exemptLocalPlayer true (the hidden player is the streaming
 *   dolly, never an occluder); terrainEps 0.05; entityRangeMargin 5
 * @returns {LosResult}
 */
export function segmentBlocked(sh, from, to, opts = {}) {
  const o = opts || {};
  const layers = resolveLayers(o.layers);
  const a = toVec(from), b = toVec(to);
  const base = { blocked: false, t: 1, layer: null, point: null, normal: null, kind: null, distance: 0, length: 0, chunks: 0, calls: 0, valid: true };
  if (!a || !b) return { ...base, valid: false };
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  if (!(L > MIN_SEGMENT_M)) return { ...base, length: Number.isFinite(L) ? L : 0 };
  const R = typeof o.radius === "number" && Number.isFinite(o.radius) && o.radius >= 0 ? o.radius : LOS_DEFAULT_RADIUS;
  const subjectGuid = typeof o.subjectGuid === "number" && Number.isFinite(o.subjectGuid) ? o.subjectGuid >>> 0 : 0;
  const exempt = o.exemptLocalPlayer !== false;
  const cells = toCellArray(o.cellIds);
  const margin = typeof o.entityRangeMargin === "number" && Number.isFinite(o.entityRangeMargin) && o.entityRangeMargin >= 0
    ? o.entityRangeMargin : LOS_ENTITY_RANGE_MARGIN_M;
  const eps = typeof o.terrainEps === "number" && Number.isFinite(o.terrainEps) && o.terrainEps >= 0 ? o.terrainEps : LOS_TERRAIN_EPS;

  /** @type {{t:number, layer:string, point:number[], normal:number[]}|null} */
  let best = null;
  let calls = 0;

  // Terrain (pure JS): one march over the whole segment.
  if (layers.has("terrain") && typeof o.terrainZAt === "function") {
    const zAt = safeTerrain(o.terrainZAt);
    const hit = projectileTerrainCrossing({ x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }, zAt, eps);
    if (hit && Number.isFinite(hit.s)) {
      best = {
        t: Math.max(0, Math.min(1, hit.s)),
        layer: "terrain",
        point: [hit.x, hit.y, hit.z],
        normal: terrainNormal(zAt, hit.x, hit.y),
      };
    }
  }

  const hasHandle = sh !== null && sh !== undefined && (typeof sh === "object" || typeof sh === "function");
  const wasmLayers = hasHandle ? WASM_LAYERS.filter((n) => layers.has(n)) : [];
  const chunks = wasmLayers.length > 0 ? segmentChunks(a, b) : [];
  const ux = d[0] / L, uy = d[1] / L, uz = d[2] / L;

  /** Run one layer on one chunk; updates `best`. */
  const sweep = (layer, chunk) => {
    const fn = sh[LOS_LAYER_METHODS[layer]];
    if (typeof fn !== "function") return;
    let args;
    switch (layer) {
      case "buildingMesh":
      case "statics":
      case "scenery":
        args = [R, chunk.lbKey];
        break;
      case "cellMesh":
      case "cellStatics":
        if (!cells) return;
        args = [R, cells];
        break;
      case "entities":
        args = [R, chunk.length + margin];
        break;
      case "objects":
        args = [R, subjectGuid, exempt];
        break;
      default:
        return;
    }
    let hit = null;
    try {
      calls += 1;
      hit = fn.call(sh, chunk.from[0], chunk.from[1], chunk.from[2], chunk.to[0], chunk.to[1], chunk.to[2], ...args);
      if (!hit || typeof hit !== "object") return;
      // Copy every field BEFORE free() (wasm-bindgen box).
      const t = +hit.t;
      const px = +hit.x, py = +hit.y, pz = +hit.z;
      const nx = +hit.normalX || 0, ny = +hit.normalY || 0, nz = +hit.normalZ || 0;
      if (!(t >= 0)) return;
      const nd = nx * ux + ny * uy + nz * uz;
      if (!projectileHitStops(t, nd, false)) return;
      const tg = chunk.t0 + Math.min(1, t) * (chunk.t1 - chunk.t0);
      if (best === null || tg < best.t) {
        const point = Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz)
          ? [px, py, pz]
          : [a[0] + d[0] * tg, a[1] + d[1] * tg, a[2] + d[2] * tg];
        best = { t: tg, layer, point, normal: [nx, ny, nz] };
      }
    } catch (_) {
      /* stale pkg / borrow conflict → no hit from this layer */
    } finally {
      if (hit && typeof hit === "object") {
        try {
          if (typeof hit.free === "function") hit.free();
        } catch (_) {
          /* already released */
        }
      }
    }
  };

  let swept = 0;
  for (const chunk of chunks) {
    if (best !== null && chunk.t0 >= best.t) break;
    swept += 1;
    for (const layer of wasmLayers) sweep(layer, chunk);
  }

  const out = { ...base, length: L, chunks: swept, calls };
  if (chunks.truncated) out.truncated = true;
  if (best === null) {
    out.distance = L;
    return out;
  }
  out.blocked = true;
  out.t = best.t;
  out.layer = best.layer;
  out.point = best.point;
  out.normal = best.normal;
  out.distance = best.t * L;
  out.kind = kindForLayer(best.layer, { normal: best.normal, indoor: hasIndoorCell(cells) });
  return out;
}
