// scene3d/film/scene/dungeon_route.js — camera routes through dungeons and interiors (SPEC §2.15).
//
// WHY: an indoor fly-through must enter every room THROUGH its doorway and
// round 90° corridor turns smoothly — a camera aimed straight from room
// centre to room centre cuts wall corners, and a polyline through doorways
// pivots on its corners. The planning graph already exists:
// rynth/indoor_router.js builds `Map<cellId, {pos, neighbors, exits, doors,
// floorZMin, floorZMax}>` from the wasm EnvCell placements, where `doors`
// are the real portal openings (`doorsFromRows(takePortalDoorways())`:
// centroid, unit normal pointing OUT of the owning cell, vertical extent,
// lowest point). This module turns a cell path into camera control points
// that straddle each doorway (centroid ∓ approach·normal at
// bottomZ + heightFrac·height — about 55 % of the door height, a camera, not
// feet), rounds the polyline with circular fillets (spline.js
// filletPolyline: a 90° corridor turn becomes a quarter circle) and wraps it
// as an arc-length Path.
//
// The camera variant of the cell search ALLOWS DROP EDGES: indoor_router's
// findPath prunes |Δz| ≥ 0.5 m near-vertical edges because a walking body
// cannot jump them, but a camera can fly a shaft or a stairwell straight
// down. indoor_router supports that through its `walkableOverrides` option
// (every edge of the graph is passed as walkable); a small local A*
// (`cameraFindPath`, 3-D cost, drops allowed) is the fallback when the
// injected search returns nothing.
//
// Floor/ceiling openings (|normal.z| > 0.7 — stairwells, shafts) get control
// points along the full 3-D normal, so a route can turn into a vertical dive;
// orientation through the nadir is the gimbal's job (core/gimbal.js), never
// lookAt.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm. Deterministic. Imports only dependency-free modules.

import { FilmShotError } from "../core/errors.js";
import { filletPolyline, makePath } from "../core/spline.js";
import { edgeKey, findPath as routerFindPath } from "../../../rynth/indoor_router.js";

/** Default fraction of the doorway height at which the camera crosses it. */
export const DOORWAY_HEIGHT_FRAC = 0.55;
/** Default distance (m) before / past a doorway centroid of its two control points. */
export const DOORWAY_APPROACH_M = 1.2;
/** Default fillet radius (m) of route corners. */
export const ROUTE_FILLET_M = 1.5;
/** Default camera height (m) above a cell's floor for the route's start / end anchors. */
export const ROUTE_ANCHOR_HEIGHT_M = 1.5;
/** Opening height assumed for a transition without doorway data (m). */
export const FALLBACK_OPENING_HEIGHT_M = 2.5;
/** |normal.z| above this is a floor/ceiling opening (stairwell, shaft), not an upright doorway. */
export const UPRIGHT_MAX_NZ = 0.7;
/** Upright openings lower than this (m) are windows / counters: passable for a camera, avoided when possible. */
export const LOW_OPENING_M = 1.83;
/** Extra A* cost (m) for crossing an edge whose only openings are low (windows / serving counters). */
export const LOW_OPENING_PENALTY_M = 6;

/**
 * Machine-readable `.code`s of the FilmShotErrors thrown by this module.
 * @type {Readonly<{BAD_GRAPH:string, UNKNOWN_CELL:string, NO_ROUTE:string, BAD_ARGUMENT:string}>}
 */
export const DUNGEON_ROUTE_ERROR_CODES = Object.freeze({
  BAD_GRAPH: "BAD_GRAPH",
  UNKNOWN_CELL: "UNKNOWN_CELL",
  NO_ROUTE: "NO_INDOOR_ROUTE",
  BAD_ARGUMENT: "BAD_ARGUMENT",
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** @param {number} n @returns {string} 0x-prefixed 8-digit hex */
function hex(n) {
  return `0x${(Number(n) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/** @param {string} message @param {string} code @param {*} [details] @returns {FilmShotError} */
function routeError(message, code, details) {
  return new FilmShotError(message, details === undefined ? { code } : { code, details });
}

/**
 * `[x, y, z]` from an array-like or `{x, y, z}`; null unless all three are finite.
 * @param {*} p
 * @returns {number[]|null}
 */
function vec(p) {
  if (p == null || typeof p !== "object") return null;
  const x = p[0] !== undefined ? p[0] : p.x;
  const y = p[1] !== undefined ? p[1] : p.y;
  const z = p[2] !== undefined ? p[2] : p.z;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/** @param {number[]} a @param {number[]} b @returns {number} */
function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Finite number ≥ 0 or the default. */
function nonNeg(v, d) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d;
}

/**
 * Normalise a caller graph (Map or plain object, number or string keys) into
 * Map<u32, node>, keeping only nodes with a finite position. Never throws.
 * @param {*} graph
 * @returns {Map<number, object>}
 */
function asGraph(graph) {
  const m = new Map();
  if (!graph || typeof graph !== "object") return m;
  const entries = graph instanceof Map ? graph.entries() : Object.entries(graph);
  for (const [k, v] of entries) {
    if (!v || typeof v !== "object" || !vec(v.pos)) continue;
    const id = Number(k) >>> 0;
    m.set(id, v);
  }
  return m;
}

/** Neighbour ids of a node as u32 numbers (missing/invalid entries dropped). */
function neighborsOf(node) {
  const out = [];
  if (!node || !Array.isArray(node.neighbors)) return out;
  for (const nb of node.neighbors) {
    const n = Number(nb);
    if (Number.isFinite(n)) out.push(n >>> 0);
  }
  return out;
}

/**
 * A door record normalised to `{other, at:[x,y,z], normal:[x,y,z] (unit), height, bottom}`,
 * or null when malformed.
 * @param {*} d
 * @returns {{other:number, at:number[], normal:number[], height:number, bottom:number}|null}
 */
function cleanDoor(d) {
  if (!d || typeof d !== "object") return null;
  const at = vec(d.at);
  const n = vec(d.normal);
  if (!at || !n) return null;
  const l = Math.hypot(n[0], n[1], n[2]);
  if (!(l > 1e-9)) return null;
  const height = typeof d.height === "number" && Number.isFinite(d.height) && d.height >= 0 ? d.height : 0;
  const bottom = typeof d.bottom === "number" && Number.isFinite(d.bottom) ? d.bottom : at[2] - height / 2;
  return { other: Number(d.other) >>> 0, at, normal: [n[0] / l, n[1] / l, n[2] / l], height, bottom };
}

/** True for an upright (wall) opening. */
function isUpright(door) {
  return Math.abs(door.normal[2]) <= UPRIGHT_MAX_NZ;
}

/** True for an upright opening too low for a body (window, counter). */
function isLow(door) {
  return isUpright(door) && door.height < LOW_OPENING_M;
}

/**
 * Every doorway joining a → b, oriented OUT of a (b's own copy of the portal
 * comes back with its normal reversed). [] without door data.
 */
function doorsBetween(nodes, aId, bId) {
  const a = nodes.get(aId), b = nodes.get(bId);
  const fromA = a && Array.isArray(a.doors)
    ? a.doors.map(cleanDoor).filter((d) => d && d.other === bId)
    : [];
  if (fromA.length) return fromA;
  const fromB = b && Array.isArray(b.doors)
    ? b.doors.map(cleanDoor).filter((d) => d && d.other === aId)
    : [];
  return fromB.map((d) => ({ ...d, other: bId, normal: [-d.normal[0], -d.normal[1], -d.normal[2]] }));
}

/**
 * The doorway a camera flies through from a to b: a body-sized upright door
 * first, then any upright opening, then a floor/ceiling opening; null without
 * door data.
 */
function pickDoor(nodes, aId, bId) {
  const list = doorsBetween(nodes, aId, bId);
  if (!list.length) return null;
  return list.find((d) => isUpright(d) && !isLow(d)) || list.find(isUpright) || list[0];
}

/** Floor height of a cell: floorZMin when present, else pos.z (bbox min). */
function floorOf(node) {
  if (node && typeof node.floorZMin === "number" && Number.isFinite(node.floorZMin)) return node.floorZMin;
  const p = node ? vec(node.pos) : null;
  return p ? p[2] : 0;
}

/**
 * The camera anchor of a cell: its bbox-centre XY at floor + anchorHeight.
 * @param {object} node
 * @param {number} anchorHeight
 * @returns {number[]}
 */
export function cellAnchor(node, anchorHeight = ROUTE_ANCHOR_HEIGHT_M) {
  const p = node ? vec(node.pos) : null;
  if (!p) throw routeError("cellAnchor: the cell has no finite pos", DUNGEON_ROUTE_ERROR_CODES.BAD_GRAPH);
  return [p[0], p[1], floorOf(node) + nonNeg(anchorHeight, ROUTE_ANCHOR_HEIGHT_M)];
}

// ---------------------------------------------------------------------------
// doorway frames / control points
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DoorwayFrame
 * @property {number} from          cell id the camera leaves
 * @property {number} to            cell id it enters
 * @property {number[]} center      crossing point: [cx, cy, bottom + heightFrac·height] (upright) or the
 *                                  opening centroid (floor/ceiling opening)
 * @property {number[]} normal      unit direction of travel through the opening (out of `from`)
 * @property {boolean} upright      wall doorway (true) or floor/ceiling opening (false)
 * @property {boolean} low          upright but lower than LOW_OPENING_M (window / counter)
 * @property {number} height        opening height (m; 0 when unknown)
 * @property {boolean} fallback     no doorway data: midpoint of the two cell anchors
 * @property {number[]} before      control point on the `from` side
 * @property {number[]} after       control point on the `to` side
 */

/**
 * Doorway frames for every transition of a cell path (see DoorwayFrame).
 * Upright doorways: the crossing height is bottomZ + heightFrac·height, the
 * control points sit `approach` metres before / past the centroid along the
 * HORIZONTAL normal (both at the crossing height). Floor/ceiling openings:
 * along the full 3-D normal through the centroid (a shaft dive). Without door
 * data the frame is the midpoint of the two cell anchors (floor +
 * heightFrac·FALLBACK_OPENING_HEIGHT_M) with points along the anchor-to-anchor
 * direction. Each approach is clamped to half the gap to the neighbouring
 * crossing (thin door-frame cells never make the route double back), and to
 * half the depth of `opts.start` / `opts.end` in front of / behind the first /
 * last doorway. Transitions whose cells are both unknown and carry no door
 * data are skipped. Never throws for bad graph content.
 * @param {*} graph indoor_router graph (Map or object)
 * @param {Array<number|string>} cellPath
 * @param {{heightFrac?:number, approach?:number, start?:number[], end?:number[]}} [opts]
 * @returns {DoorwayFrame[]}
 */
export function doorwayFrames(graph, cellPath, opts = {}) {
  const o = opts || {};
  const nodes = asGraph(graph);
  const heightFrac = Math.min(1, nonNeg(o.heightFrac, DOORWAY_HEIGHT_FRAC));
  const approach = nonNeg(o.approach, DOORWAY_APPROACH_M);
  if (!Array.isArray(cellPath) || cellPath.length < 2) return [];
  const ids = cellPath.map((c) => Number(c) >>> 0);
  const raw = [];
  for (let i = 0; i + 1 < ids.length; i++) {
    const aId = ids[i], bId = ids[i + 1];
    if (aId === bId) continue;
    const door = pickDoor(nodes, aId, bId);
    if (door) {
      const upright = isUpright(door);
      let normal, center;
      if (upright) {
        const h = Math.hypot(door.normal[0], door.normal[1]);
        normal = [door.normal[0] / h, door.normal[1] / h, 0];
        center = [door.at[0], door.at[1], door.height > 0 ? door.bottom + heightFrac * door.height : door.at[2]];
      } else {
        normal = door.normal.slice();
        center = door.at.slice();
      }
      raw.push({ from: aId, to: bId, center, normal, upright, low: isLow(door), height: door.height, fallback: false });
      continue;
    }
    const a = nodes.get(aId), b = nodes.get(bId);
    if (!a || !b) continue;
    const pa = cellAnchor(a, heightFrac * FALLBACK_OPENING_HEIGHT_M);
    const pb = cellAnchor(b, heightFrac * FALLBACK_OPENING_HEIGHT_M);
    const L = dist3(pa, pb);
    const normal = L > 1e-9 ? [(pb[0] - pa[0]) / L, (pb[1] - pa[1]) / L, (pb[2] - pa[2]) / L] : [0, 1, 0];
    const center = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
    raw.push({ from: aId, to: bId, center, normal, upright: Math.abs(normal[2]) <= UPRIGHT_MAX_NZ, low: false, height: 0,
      fallback: true, span: L });
  }
  const start = vec(o.start), end = vec(o.end);
  const frames = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    let before = approach, after = approach;
    if (i > 0) before = Math.min(before, dist3(raw[i - 1].center, f.center) / 2);
    if (i + 1 < raw.length) after = Math.min(after, dist3(f.center, raw[i + 1].center) / 2);
    if (f.fallback) {
      before = Math.min(before, 0.25 * f.span);
      after = Math.min(after, 0.25 * f.span);
    }
    if (i === 0 && start) {
      const depth = (f.center[0] - start[0]) * f.normal[0] + (f.center[1] - start[1]) * f.normal[1] + (f.center[2] - start[2]) * f.normal[2];
      if (depth > 0) before = Math.min(before, depth / 2);
    }
    if (i + 1 === raw.length && end) {
      const depth = (end[0] - f.center[0]) * f.normal[0] + (end[1] - f.center[1]) * f.normal[1] + (end[2] - f.center[2]) * f.normal[2];
      if (depth > 0) after = Math.min(after, depth / 2);
    }
    const c = f.center, n = f.normal;
    frames.push({
      from: f.from,
      to: f.to,
      center: c.slice(),
      normal: n.slice(),
      upright: f.upright,
      low: f.low,
      height: f.height,
      fallback: f.fallback,
      before: [c[0] - n[0] * before, c[1] - n[1] * before, c[2] - n[2] * before],
      after: [c[0] + n[0] * after, c[1] + n[1] * after, c[2] + n[2] * after],
    });
  }
  return frames;
}

/**
 * Camera control points through the doorways of a cell path (SPEC §2.15):
 * per transition `centroid − approach·normal` and `centroid + approach·normal`
 * at `bottomZ + heightFrac·height` (see doorwayFrames for openings in floors /
 * ceilings, missing door data and the approach clamps). With
 * `includeCentre: true` the crossing point itself is inserted between the two
 * (collinear, so a later fillet never cuts the doorway). [] for a path of
 * fewer than two cells.
 * @param {*} graph indoor_router graph (Map or object)
 * @param {Array<number|string>} cellPath
 * @param {{heightFrac?:number, approach?:number, includeCentre?:boolean, start?:number[], end?:number[]}} [opts]
 *   heightFrac 0.55, approach 1.2 m, includeCentre false
 * @returns {number[][]}
 */
export function doorwayControlPoints(graph, cellPath, opts = {}) {
  const o = opts || {};
  const out = [];
  for (const f of doorwayFrames(graph, cellPath, o)) {
    out.push(f.before);
    if (o.includeCentre === true) out.push(f.center.slice());
    out.push(f.after);
  }
  return out;
}

// ---------------------------------------------------------------------------
// cell search
// ---------------------------------------------------------------------------

/**
 * Every undirected edge of the graph as indoor_router `edgeKey` strings — the
 * `walkableOverrides` that make indoor_router.findPath accept drop edges.
 * @param {*} graph
 * @returns {Set<string>}
 */
export function allEdgeKeys(graph) {
  const nodes = asGraph(graph);
  const keys = new Set();
  for (const [id, node] of nodes) {
    for (const nb of neighborsOf(node)) if (nb !== id) keys.add(edgeKey(id, nb));
  }
  return keys;
}

/** Binary min-heap of {id, f} (lazy deletion by the caller). */
class Heap {
  constructor() {
    /** @type {{id:number, f:number, seq:number}[]} */
    this.a = [];
    this.seq = 0;
  }
  /** @param {number} id @param {number} f */
  push(id, f) {
    const a = this.a;
    a.push({ id, f, seq: this.seq++ });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (Heap.less(a[p], a[i])) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  /** @returns {number} */
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < a.length && Heap.less(a[l], a[s])) s = l;
        if (r < a.length && Heap.less(a[r], a[s])) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top.id;
  }
  /** Deterministic order: f, then insertion order. */
  static less(x, y) {
    return x.f < y.f || (x.f === y.f && x.seq < y.seq);
  }
  get size() {
    return this.a.length;
  }
}

/**
 * Camera A* over the portal graph: like indoor_router.findPath but DROP EDGES
 * ARE ALLOWED (a camera flies shafts and stairwells), the cost is the 3-D
 * distance between cell anchors (so a same-level corridor beats a detour
 * through a lower floor), and an edge whose only openings are low windows /
 * counters costs `lowOpeningPenalty` extra metres. Honours `hazards` (Set of
 * cell ids; the goal is still allowed) and `excludeEdges` (Set of edgeKey
 * strings). Deterministic (ties broken by insertion order). Returns the cell
 * id array (from … to), [from] when from === to, or null when unreachable or
 * an endpoint is not in the graph. Never throws.
 * @param {*} graph indoor_router graph (Map or object)
 * @param {number|string} fromCell
 * @param {number|string} toCell
 * @param {{hazards?:Set<number>, excludeEdges?:Set<string>, lowOpeningPenalty?:number}} [opts]
 * @returns {number[]|null}
 */
export function cameraFindPath(graph, fromCell, toCell, opts = {}) {
  const o = opts || {};
  const nodes = asGraph(graph);
  const from = Number(fromCell) >>> 0;
  const to = Number(toCell) >>> 0;
  if (!nodes.has(from) || !nodes.has(to)) return null;
  if (from === to) return [from];
  const penalty = nonNeg(o.lowOpeningPenalty, LOW_OPENING_PENALTY_M);
  const hazards = o.hazards instanceof Set ? o.hazards : null;
  const excluded = o.excludeEdges instanceof Set ? o.excludeEdges : null;
  const posOf = (id) => vec(nodes.get(id).pos);
  const goal = posOf(to);
  const g = new Map([[from, 0]]);
  const came = new Map();
  const closed = new Set();
  const open = new Heap();
  open.push(from, dist3(posOf(from), goal));
  while (open.size > 0) {
    const cur = open.pop();
    if (closed.has(cur)) continue;
    closed.add(cur);
    if (cur === to) {
      const path = [cur];
      let c = cur;
      while (came.has(c)) {
        c = came.get(c);
        path.push(c);
      }
      return path.reverse();
    }
    const pc = posOf(cur);
    const gc = g.get(cur);
    for (const nb of neighborsOf(nodes.get(cur))) {
      if (nb === cur || closed.has(nb) || !nodes.has(nb)) continue;
      if (excluded && excluded.has(edgeKey(cur, nb))) continue;
      if (nb !== to && hazards && hazards.has(nb)) continue;
      const doors = doorsBetween(nodes, cur, nb);
      const lowOnly = doors.length > 0 && doors.every(isLow);
      const pn = posOf(nb);
      const tentative = gc + dist3(pc, pn) + (lowOnly ? penalty : 0);
      if (tentative < (g.has(nb) ? g.get(nb) : Infinity)) {
        g.set(nb, tentative);
        came.set(nb, cur);
        open.push(nb, tentative + dist3(pn, goal));
      }
    }
  }
  return null;
}

/** True when `path` is a usable cell path from `from` to `to` over real graph edges. */
function validPath(nodes, path, from, to) {
  if (!Array.isArray(path) || path.length === 0) return false;
  const ids = path.map((c) => Number(c) >>> 0);
  if (ids[0] !== from || ids[ids.length - 1] !== to) return false;
  for (const id of ids) if (!nodes.has(id)) return false;
  for (let i = 0; i + 1 < ids.length; i++) {
    const a = nodes.get(ids[i]), b = nodes.get(ids[i + 1]);
    if (!neighborsOf(a).includes(ids[i + 1]) && !neighborsOf(b).includes(ids[i])) return false;
  }
  return true;
}

/**
 * True when every node carries the `{x, y, z}` position objects (and object
 * door records) indoor_router's search reads; array-shaped graphs go straight
 * to cameraFindPath.
 */
function routerCompatible(nodes) {
  for (const node of nodes.values()) {
    const p = node.pos;
    if (Array.isArray(p) || ArrayBuffer.isView(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
    if (Array.isArray(node.doors)) {
      for (const d of node.doors) {
        if (!d || !d.normal || Array.isArray(d.normal) || !Number.isFinite(d.normal.z)) return false;
      }
    }
  }
  return true;
}

/**
 * 3-D cost of a cell path, the metric cameraFindPath minimises: anchor-to-anchor
 * distances plus LOW_OPENING_PENALTY_M for every low-opening-only edge.
 * @param {Map<number, object>} nodes
 * @param {number[]} path
 * @param {number} penalty
 * @returns {number}
 */
function routeCost(nodes, path, penalty) {
  let c = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    c += dist3(vec(nodes.get(path[i]).pos), vec(nodes.get(path[i + 1]).pos));
    const doors = doorsBetween(nodes, path[i], path[i + 1]);
    if (doors.length > 0 && doors.every(isLow)) c += penalty;
  }
  return c;
}

/** A router route may be at most this factor longer (3-D) than the camera optimum before the camera route wins. */
export const ROUTER_COST_SLACK = 1.1;

/** Drop consecutive points closer than `eps` metres. */
function dedupePoints(points, eps = 1e-3) {
  const out = [];
  for (const p of points) {
    if (!out.length || dist3(out[out.length - 1], p) > eps) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} IndoorPlan
 * @property {number[][]} points          the camera route for ShotContext.indoor.route: the CONTROL polyline —
 *                                        start anchor, per doorway before / centre / after, end anchor
 *                                        (consecutive duplicates merged). Techniques fillet it themselves
 *                                        (fpv.fpv-corridor cornerRadius, indoorCameraPath); it is NOT
 *                                        pre-filleted because re-filleting an arc's chords turns the arc into
 *                                        a polygon of straight legs (visible heading steps).
 * @property {number[][]} filleted        `points` rounded by filletPolyline(fillet) (plain copies; equal to
 *                                        `points` when fillet = 0) — for consumers that do not fillet
 * @property {number[]} cells             the cell path (from … to)
 * @property {DoorwayFrame[]} doorways    one frame per transition
 * @property {number} length              polyline length of `filleted` (m) — the distance flown
 * @property {number} fillet              the fillet radius used for `filleted` (m)
 * @property {"router"|"camera"|"trivial"} search which search produced `cells`
 */

/**
 * Plan a camera route between two cells of an indoor_router graph (SPEC §2.15).
 *
 * Cells: `opts.findPath` (default rynth/indoor_router.js findPath) is called as
 * `findPath(graph, from, to, {walkableOverrides: allEdgeKeys(graph), bodySized: true})`
 * — every edge marked walkable, so drop edges (shafts, stairwells) are allowed;
 * real doors are preferred over windows. The router's cost is 2-D (vertical
 * travel is free), so its route is kept only while its 3-D length (plus
 * low-opening penalties) is within ROUTER_COST_SLACK (×1.1) of the local
 * `cameraFindPath` optimum; otherwise — and when it returns nothing usable,
 * throws, or the graph's positions are arrays indoor_router cannot read — the
 * camera route is used (`search` says which). Points: the start anchor (`opts.start`, else
 * the from-cell's bbox centre at floor + anchorHeight), every doorway's
 * before / centre / after control point (doorwayFrames; the collinear centre
 * means ANY later fillet keeps the doorway crossing straight — filletPolyline
 * caps each arc at 0.45 of its shorter leg), the end anchor (`opts.end`, else
 * the to-cell's), consecutive duplicates merged. `filleted` / `length` round
 * that polyline with radius `fillet` (a 90° corridor turn becomes an arc).
 *
 * Throws FilmShotError: BAD_GRAPH (empty / not a graph), UNKNOWN_CELL (an
 * endpoint is not in the graph), NO_INDOOR_ROUTE (unreachable even with drops).
 * @param {*} graph indoor_router graph `Map<cellId, {pos, neighbors, exits, doors, floorZMin, floorZMax}>`
 * @param {number|string} fromCell
 * @param {number|string} toCell
 * @param {{findPath?:Function|null, fillet?:number, heightFrac?:number, approach?:number,
 *   anchorHeight?:number, start?:number[], end?:number[], arcSegments?:number,
 *   hazards?:Set<number>, excludeEdges?:Set<string>}} [opts]
 *   fillet 1.5 m, heightFrac 0.55, approach 1.2 m, anchorHeight 1.5 m, arcSegments 8
 * @returns {IndoorPlan}
 */
export function planIndoorPath(graph, fromCell, toCell, opts = {}) {
  const o = opts || {};
  const nodes = asGraph(graph);
  if (nodes.size === 0) {
    throw routeError("planIndoorPath: the cell graph is empty — build it with indoor_router buildStitchedGraphFromWasm([lb]) first",
      DUNGEON_ROUTE_ERROR_CODES.BAD_GRAPH);
  }
  const from = Number(fromCell) >>> 0;
  const to = Number(toCell) >>> 0;
  for (const [name, id, raw] of [["fromCell", from, fromCell], ["toCell", to, toCell]]) {
    if (!Number.isFinite(Number(raw)) || !nodes.has(id)) {
      throw routeError(`planIndoorPath: ${name} ${Number.isFinite(Number(raw)) ? hex(id) : JSON.stringify(raw)} is not a cell of the graph (${nodes.size} cells)`,
        DUNGEON_ROUTE_ERROR_CODES.UNKNOWN_CELL, { cell: Number.isFinite(Number(raw)) ? id : null });
    }
  }
  const fillet = nonNeg(o.fillet, ROUTE_FILLET_M);
  const search = o.findPath === undefined ? routerFindPath : o.findPath;

  let cells = null;
  let source = "camera";
  if (from === to) {
    cells = [from];
    source = "trivial";
  } else {
    if (typeof search === "function" && (search !== routerFindPath || routerCompatible(nodes))) {
      try {
        const r = search(graph instanceof Map ? graph : nodes, from, to, {
          walkableOverrides: allEdgeKeys(nodes),
          bodySized: true,
          hazards: o.hazards,
          excludeEdges: o.excludeEdges,
        });
        if (validPath(nodes, r, from, to)) {
          cells = r.map((c) => Number(c) >>> 0);
          source = "router";
        }
      } catch (_) {
        /* the injected search failed — the camera A* decides */
      }
    }
    const camera = cameraFindPath(nodes, from, to, { hazards: o.hazards, excludeEdges: o.excludeEdges });
    if (camera && cells) {
      // indoor_router's cost is 2-D (a shaft is free): keep its route unless a
      // camera flying it would travel clearly farther than the 3-D optimum.
      const penalty = LOW_OPENING_PENALTY_M;
      if (routeCost(nodes, cells, penalty) > ROUTER_COST_SLACK * routeCost(nodes, camera, penalty) + 1e-6) {
        cells = camera;
        source = "camera";
      }
    } else if (!cells) {
      cells = camera;
    }
    if (!cells) {
      throw routeError(`planIndoorPath: no camera route from ${hex(from)} to ${hex(to)} (the cells are not connected by portals)`,
        DUNGEON_ROUTE_ERROR_CODES.NO_ROUTE, { from, to });
    }
  }

  const anchorHeight = nonNeg(o.anchorHeight, ROUTE_ANCHOR_HEIGHT_M);
  const start = vec(o.start) || cellAnchor(nodes.get(from), anchorHeight);
  const end = vec(o.end) || cellAnchor(nodes.get(to), anchorHeight);
  const doorways = doorwayFrames(nodes, cells, { heightFrac: o.heightFrac, approach: o.approach, start, end });
  const control = [start];
  for (const f of doorways) control.push(f.before, f.center.slice(), f.after);
  control.push(end);
  const points = dedupePoints(control);
  const arcSegments = Number.isFinite(o.arcSegments) ? o.arcSegments : 8;
  const rounded = fillet > 0 && points.length >= 3 ? filletPolyline(points, fillet, { arcSegments }) : points;
  const filleted = rounded.map((p) => [p[0], p[1], p[2]]);
  let length = 0;
  for (let i = 1; i < filleted.length; i++) length += dist3(filleted[i - 1], filleted[i]);
  return { points, filleted, cells, doorways, length, fillet, search: source };
}

/**
 * Arc-length camera Path along an indoor route (SPEC §2.15):
 * `makePath(filletPolyline(points, fillet))` — corners become true circular
 * arcs (curvature ≈ 1/fillet), straight legs stay straight. Pass
 * planIndoorPath's `points` (the control polyline), never its `filleted`
 * copy with fillet > 0 (re-filleting arc chords yields a polygon). Throws
 * FilmShotError (BAD_ARGUMENT) for a non-array, FilmError for a non-finite
 * point or an empty list.
 * @param {number[][]} points
 * @param {{fillet?:number, arcSegments?:number, samples?:number}} [opts]
 *   fillet 1.5 m, arcSegments 8, samples 1024
 * @returns {ReturnType<typeof makePath>}
 */
export function indoorCameraPath(points, opts = {}) {
  const o = opts || {};
  if (!Array.isArray(points)) {
    throw routeError(`indoorCameraPath: points must be an array of [x, y, z] (got ${points === null ? "null" : typeof points})`,
      DUNGEON_ROUTE_ERROR_CODES.BAD_ARGUMENT);
  }
  const fillet = nonNeg(o.fillet, ROUTE_FILLET_M);
  const arcSegments = Number.isFinite(o.arcSegments) ? o.arcSegments : 8;
  const pts = fillet > 0 ? filletPolyline(points, fillet, { arcSegments }) : points;
  return makePath(pts, { samples: Number.isFinite(o.samples) ? o.samples : 1024 });
}
