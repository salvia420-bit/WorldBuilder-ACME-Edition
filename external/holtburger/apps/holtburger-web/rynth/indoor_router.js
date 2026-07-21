// RynthIndoorRouter — dungeon cell-graph A* (report 09 §1b's "pure layer").
//
// Dungeon walls are NOT in the sidecar's Detour tiles (upstream bake gap,
// report 09 §1b/§(b)), so indoor routing is the web client's job. This module
// is a straight port of the PURE algorithm layer of RynthSuite's
// DungeonPathfinder.cs — A* FindPath (DungeonPathfinder.cs:275), IsDropEdge
// (:61), the 2-core patrol prune GetMainRouteNodes (:451) and the Euler
// closed-walk patrol builder BuildPatrolRoute (:530) — WITHOUT the DAT reader:
// on web the EnvCell portal-record graph already exists in the wasm client
// (report 09 §1b), so BuildGraph (:115) is replaced by buildGraphFromWasm()
// below, fed by fetchEnvCellsInLandblock (lib.rs:17415) + the EnvCellPlacement
// getters (lib.rs:15939-15977).
//
// ADJACENCY = portal records, not visible-cell lists (DungeonPathfinder.cs:3-10):
// visible-cell adjacency creates diagonal edges that cut through walls; portal
// records are real doorways. The wasm builder already widens portal ids to full
// 32-bit objCellIds (lib.rs:15970-15977) but does NOT filter sentinels
// (lib.rs:17604-17607: "JS can ignore zero / sentinel values") — we filter to
// the EnvCell low-word range [0x0100, 0xFFFD] like DungeonPathfinder.cs:163.
//
// GRAPH CONTRACT (caller-provided, synthetic or wasm-built):
//   { cellId -> { pos: {x, y, z}, neighbors: [cellId, ...] } }
//   plain object (string keys OK) or Map. pos is WORLD-frame AC metres, Z-up
//   (wx = lbX*192 + localX — the same frame router.js's worldXY uses), because
//   EnvCellPlacement.cellOriginX/Y are already world-frame (lib.rs:17593-17597).
//   Neighbors may reference missing cells; they are skipped during search.
//
// OUTPUT CONTRACT (consumed by rynth/router.js):
//   findPath(graph, from, to)  -> [cellId, ...] or null (unreachable)
//   toLegs(graph, path)        -> [{lb, x, y, z}, ...] where lb is the FULL
//   EnvCell objCellId (indoor cells ARE the objCellId) and x/y/z are
//   landblock-local — exactly what RynthRouter.follow() / MoveToPosition eat.
//
// KNOWN LIMITATION (carried from Nav deep-dive J3, cited in report 09 §1b):
// IsDropEdge prunes ALL drop/jump edges from the GRAPH SEARCH — this module
// has no jump-feasibility test (edge-walk + simulate, per
// DESIGN-jump-primitive-2026-07-21.md Phase 3) — so drop-gated dungeon areas
// are unreachable BY PLANNING, and findPath returns null when the only route
// to the goal crosses a drop. As of Phase 1 of that design doc, the executor
// itself is no longer jump-blind (goto_compose.js's replayRoute fires
// corpus-recorded `jmp` legs via attemptJumpLeg) — this limitation is now
// specifically about A*/findExitPath never GENERATING a jump edge, not about
// jump execution being entirely absent from the stack.
//
// SIMPLIFICATIONS vs DungeonPathfinder.cs (deliberate, documented):
//   - No NavRouteParser/waypoint emission (:353-431): we return cell paths;
//     toLegs stamps cell CENTERS per the task contract. The C# 30%/50%
//     doorway-midpoint pre-approach (:377-399) and SimplifyRoute (:404) are
//     dropped — MoveToManager owns local steering (report 09 §(b) tier 1).
//     If live tests snag on offset doorways, pass {midpoints:true} to toLegs.
//   - No graph cache (:75-92) — buildGraphFromWasm is explicit; callers cache.
//   - No NearestSafeCell hazard evacuation (:230) — that's RynthAi combat
//     behavior, not routing. findPath still honors a hazards set (:308
//     semantics: goal allowed even if hazardous).

// Drop classification (DungeonPathfinder.cs:47-73). The C# converts /loc
// degrees to raw units (×240, :66-67) so NS/EW share Z's scale; our graph pos
// is already raw world metres, so the thresholds apply directly.
const DROP_ANGLE_DEG = 45.0; // :53 — ramps 10-25°, floor-shaft drops 60-90°
const FLAT_DZ_M = 0.5; //       :64 — |dZ| below this is trivially flat
const SHAFT_HORIZ_M = 1.0; //   :70 — near-zero horizontal = vertical shaft

// Retail walkable-slope cosine threshold (holtburger-dat/src/transition/
// types.rs FLOOR_Z, decomp-verified against acclient.c's step_up/step_down
// floor gate — NOT the looser Z_FOR_LANDING=0.0871557 CONTACT/landing test).
// A triangle counts as "floor" when its world-frame up-normal component
// (N·up) is >= this, i.e. slope <= ~48.36°.
const FLOOR_Z = 0.66417414618662751;

// Cell-center anchors are bbox-derived (soak-13 anchor fix below), not exact
// portal-doorway positions, so allow this much slack when checking whether a
// cell's scanned floor span reaches the neighbour's cell-center Z. Same order
// of magnitude as SHAFT_HORIZ_M — both are "anchor imprecision" fudge factors.
const FLOOR_SPAN_TOL_M = 1.0;

// Patrol prune safety valves (DungeonPathfinder.cs:437-438): if the 2-core
// collapses a small/linear dungeon, fall back to the full reachable set.
const PATROL_MIN_KEEP_NODES = 8;
const PATROL_MIN_KEEP_FRACTION = 0.2;

/** True if id's low word is a real EnvCell index (DungeonPathfinder.cs:163). */
export function isEnvCellId(id) {
  const lo = (id >>> 0) & 0xffff;
  return lo >= 0x0100 && lo <= 0xfffd;
}

// Normalize a caller graph (Map or plain object, string or number keys) into
// Map<u32, node>. Dungeon graphs are tens-to-hundreds of cells; O(n) per call.
function asMap(graph) {
  const m = new Map();
  if (!graph) return m;
  const entries = graph instanceof Map ? graph.entries() : Object.entries(graph);
  for (const [k, v] of entries) {
    if (!v || !v.pos) continue;
    m.set(Number(k) >>> 0, v);
  }
  return m;
}

// True if `node` carries a usable floor-span hint (set by
// collectLandblockIntoGraph from the cell's own Environment mesh — see
// scanWalkableFloorSpan below). Absent on synthetic graphs / callers that
// don't build via buildGraphFromWasm; isDropEdge degrades to the pure
// cell-center geometric test in that case (unchanged behavior).
function hasFloorSpan(node) {
  return typeof node.floorZMin === "number" && typeof node.floorZMax === "number";
}

// Does a walkable floor/ramp/stair surface span the full vertical gap
// between two cell centers? Checked EITHER alone (the common case: one cell
// — e.g. a stairwell/shaft hub — physically contains the whole run) OR as a
// touching union of both cells' spans (a run that splits across the portal).
// FLOOR_SPAN_TOL_M absorbs the bbox-anchor's imprecision vs the real doorway.
function spansWalkableFloor(a, b) {
  const lo = Math.min(a.pos.z, b.pos.z);
  const hi = Math.max(a.pos.z, b.pos.z);
  const okAlone = (n) =>
    hasFloorSpan(n) && n.floorZMin <= lo + FLOOR_SPAN_TOL_M && n.floorZMax >= hi - FLOOR_SPAN_TOL_M;
  if (okAlone(a) || okAlone(b)) return true;
  if (!hasFloorSpan(a) || !hasFloorSpan(b)) return false;
  const touching = a.floorZMin <= b.floorZMax + FLOOR_SPAN_TOL_M && b.floorZMin <= a.floorZMax + FLOOR_SPAN_TOL_M;
  if (!touching) return false;
  const uLo = Math.min(a.floorZMin, b.floorZMin);
  const uHi = Math.max(a.floorZMax, b.floorZMax);
  return uLo <= lo + FLOOR_SPAN_TOL_M && uHi >= hi - FLOOR_SPAN_TOL_M;
}

/**
 * Drop-edge classification (port of DungeonPathfinder.cs:61-73). A slope has
 * significant horizontal movement per unit Z (angle well under 45°); a drop is
 * near-vertical (centres almost stacked). Drops need a jump the executor
 * doesn't have (J3), so both A* and the patrol walk skip these edges.
 *
 * REFINEMENT (2026-07-20, apartment z-stack false positive — see
 * docs/rynth-integration/HANDOFF-wedge-closeout-phi4-rig-2026-07-20.md
 * Track E3/F Venue 2): cell-CENTER geometry alone can't tell a spiral
 * staircase shaft from an open drop shaft — bbox-anchor centers legitimately
 * sit near-stacked (dHoriz~0) for BOTH, since a tight stairwell's footprint
 * is small. When the pure geometric test says "drop", consult the per-cell
 * floor-span hint (set from the SAME Environment mesh already fetched for
 * the bbox anchor, scanWalkableFloorSpan below): if a continuous
 * walkable-slope floor (retail FLOOR_Z threshold) spans the full vertical
 * gap, override to walkable. Nodes without the hint (synthetic graphs,
 * pre-refinement callers) fall through unchanged.
 */
export function isDropEdge(a, b) {
  const dZ = Math.abs(b.pos.z - a.pos.z);
  if (dZ < FLAT_DZ_M) return false;
  const dHoriz = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
  const geometricDrop =
    dHoriz < SHAFT_HORIZ_M ? true : Math.atan2(dZ, dHoriz) * (180 / Math.PI) > DROP_ANGLE_DEG;
  if (!geometricDrop) return false;
  if (spansWalkableFloor(a, b)) return false;
  return true;
}

/**
 * Nearest cell to a WORLD-frame (x, y[, z]) position (DungeonPathfinder.cs:196-221).
 * Cells within 8m in Z (same floor band) are preferred when z is given; falls
 * back to 2D-nearest for single-level dungeons / unknown z. Returns 0 if empty.
 */
export function nearestCell(graph, x, y, z = NaN) {
  const nodes = asMap(graph);
  const Z_BAND = 8;
  const useZ = !Number.isNaN(z);
  let best2d = 0;
  let best2dDist = Infinity;
  let bestZ = 0;
  let bestZDist = Infinity;
  for (const [id, node] of nodes) {
    const dx = node.pos.x - x;
    const dy = node.pos.y - y;
    const d = dx * dx + dy * dy;
    if (d < best2dDist) {
      best2dDist = d;
      best2d = id;
    }
    if (useZ && Math.abs(node.pos.z - z) <= Z_BAND && d < bestZDist) {
      bestZDist = d;
      bestZ = id;
    }
  }
  return useZ && bestZ !== 0 ? bestZ : best2d;
}

// Minimal binary min-heap keyed on f-score (replaces C# PriorityQueue, :288).
class MinHeap {
  constructor() {
    this.a = [];
  }
  push(id, f) {
    const a = this.a;
    a.push({ id, f });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l].f < a[s].f) s = l;
        if (r < a.length && a[r].f < a[s].f) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top ? top.id : 0;
  }
  get size() {
    return this.a.length;
  }
}

function dist2d(a, b) {
  return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
}

// Escape hatch (2026-07-20, HANDOFF-wedge-closeout Track E3/F): corpus-
// derived ground truth ("we walked this edge on stream, it is NOT a drop")
// can override isDropEdge/spansWalkableFloor outright, for venues where the
// JS-side floor-span hint is unavailable or still gets the classification
// wrong. `overrides` is a Set of canonical `edgeKey(aId,bId)` strings — same
// undirected-pair encoding buildPatrolRoute already uses. Checked BEFORE the
// geometric/floor-span test so an override always wins.
function edgeIsDrop(overrides, aId, bId, aNode, bNode) {
  if (overrides && overrides.has(edgeKey(aId, bId))) return false;
  return isDropEdge(aNode, bNode);
}

/**
 * A* over portal adjacency (port of DungeonPathfinder.cs:275-339). Skips drop
 * edges and cells in opts.hazards (a Set of cellIds); the GOAL is allowed even
 * if hazardous — the caller asked to go there (:307-308). Heuristic = 2D
 * euclidean cell-centre distance (:326-330), admissible since edge cost is the
 * same metric.
 *
 * opts.walkableOverrides (Set<string>, default none): canonical
 * `edgeKey(cellA,cellB)` pairs to force-treat as walkable regardless of
 * isDropEdge's verdict — the ground-truth escape hatch (see edgeIsDrop
 * above), for edges the JS-side classifier still gets wrong.
 *
 * opts.excludeEdges (Set<string>, default none): the INVERSE escape hatch —
 * canonical `edgeKey(cellA,cellB)` pairs to force-treat as IMPASSABLE
 * regardless of geometry, checked BEFORE walkableOverrides/isDropEdge (an
 * exclusion always wins over an override). For goto_compose.js's bounded
 * indoor-wedge retry (2026-07-20): when a recovery walk stalls partway across
 * a specific portal doorway, the next A* attempt excludes that exact edge so
 * it can't just re-offer the same jammed transition — this is a RUNTIME,
 * per-attempt exclusion (not a corpus-derived permanent classification like
 * walkableOverrides), so it lives in opts rather than the graph itself.
 *
 * DIVERGENCE from the C#: returns null when unreachable / endpoints missing
 * (task contract) instead of the empty list (:281,:323). Same-cell trivially
 * returns [from] (:282-283).
 */
export function findPath(graph, fromCell, toCell, opts = {}) {
  const nodes = asMap(graph);
  const from = Number(fromCell) >>> 0;
  const to = Number(toCell) >>> 0;
  const hazards = opts.hazards || null;
  const overrides = opts.walkableOverrides || null;
  const excluded = opts.excludeEdges || null;
  if (!nodes.has(from) || !nodes.has(to)) return null;
  if (from === to) return [from];

  const goalNode = nodes.get(to);
  const gScore = new Map([[from, 0]]);
  const cameFrom = new Map();
  const open = new MinHeap();
  const closed = new Set();
  open.push(from, dist2d(nodes.get(from), goalNode));

  while (open.size > 0) {
    const current = open.pop();
    if (closed.has(current)) continue; // lazy-delete duplicate (C# :296)
    closed.add(current);
    if (current === to) {
      const path = [current];
      let cur = current;
      while (cameFrom.has(cur)) {
        cur = cameFrom.get(cur);
        path.push(cur);
      }
      path.reverse();
      return path;
    }
    const curNode = nodes.get(current);
    const gCur = gScore.get(current);
    for (const nbRaw of curNode.neighbors || []) {
      const nbId = Number(nbRaw) >>> 0;
      if (closed.has(nbId)) continue;
      const nbNode = nodes.get(nbId);
      if (!nbNode) continue;
      if (excluded && excluded.has(edgeKey(current, nbId))) continue;
      if (edgeIsDrop(overrides, current, nbId, curNode, nbNode)) continue;
      if (nbId !== to && hazards && hazards.has(nbId)) continue;
      const tentG = gCur + dist2d(curNode, nbNode);
      if (tentG < (gScore.has(nbId) ? gScore.get(nbId) : Infinity)) {
        cameFrom.set(nbId, current);
        gScore.set(nbId, tentG);
        open.push(nbId, tentG + dist2d(nbNode, goalNode));
      }
    }
  }
  return null;
}

/**
 * Convert a cell path (or patrol walk) into router.js legs. lb is the FULL
 * EnvCell objCellId (indoor cells ARE the objCellId — router.js worldXY only
 * uses the top two bytes for the landblock frame); x/y are converted from the
 * graph's world frame to landblock-local (wx − lbX·192), z passes through.
 * Positions are cell centres per the task contract.
 *
 * opts.midpoints (default false): additionally emit the doorway-midpoint leg
 * between consecutive cells (stamped with the DESTINATION cell id) — the C#'s
 * anti-corner-cut waypoint trick (DungeonPathfinder.cs:12-17, :377-399),
 * available if live tests show MoveToManager clipping offset doorways.
 *
 * opts.doorwayApproach (default false): the FULL two-stage pre-approach from
 * DungeonPathfinder.cs:377-399 (AddPortalWaypoints), which `midpoints` only
 * half-implemented. For each A->B cell transition emit a 30% PRE-APPROACH
 * waypoint (lines the walker up on the doorway axis before it crosses) followed
 * by the 50% DOORWAY-MIDPOINT (the through point), ending at the last cell
 * centre. This stops MoveToPosition cutting the corner into an offset doorframe
 * — the live Town-Network wedge that `midpoints:true` did not clear. Waypoints
 * are stamped with the DESTINATION cell id; their WORLD position is exact (a 30%
 * point physically near cell A is fine — callers may re-bucket the lb, e.g.
 * normalizeLegWorldFrame). SimplifyRoute (C#:404) is intentionally NOT ported:
 * the router's arrival/reissue tolerates redundant collinear legs, and dropping
 * it guarantees the alignment waypoints survive at every real doorway.
 */
export function toLegs(graph, path, opts = {}) {
  const nodes = asMap(graph);
  if (!path || !path.length) return [];
  const legs = [];
  const local = (id, wx, wy, wz) => ({
    lb: id >>> 0,
    x: wx - ((id >>> 24) & 0xff) * 192,
    y: wy - ((id >>> 16) & 0xff) * 192,
    z: wz,
  });
  if (opts.doorwayApproach) {
    for (let i = 0; i + 1 < path.length; i++) {
      const a = nodes.get(Number(path[i]) >>> 0);
      const b = nodes.get(Number(path[i + 1]) >>> 0);
      if (!a || !b) continue;
      const id = Number(path[i + 1]) >>> 0; // stamp with the DESTINATION cell (C#)
      const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dz = b.pos.z - a.pos.z;
      // 30% pre-approach, then 50% doorway midpoint (AddPortalWaypoints).
      legs.push(local(id, a.pos.x + dx * 0.3, a.pos.y + dy * 0.3, a.pos.z + dz * 0.3));
      legs.push(local(id, a.pos.x + dx * 0.5, a.pos.y + dy * 0.5, a.pos.z + dz * 0.5));
    }
    // Final leg = the last cell centre (callers append the exact goal when they
    // have one; the portal-transit path walks INTO the portal cell itself).
    const lastId = Number(path[path.length - 1]) >>> 0;
    const lastNode = nodes.get(lastId);
    if (lastNode) legs.push(local(lastId, lastNode.pos.x, lastNode.pos.y, lastNode.pos.z));
    return legs;
  }
  for (let i = 0; i < path.length; i++) {
    const id = Number(path[i]) >>> 0;
    const node = nodes.get(id);
    if (!node) continue;
    if (opts.midpoints && i > 0) {
      const prev = nodes.get(Number(path[i - 1]) >>> 0);
      if (prev) {
        legs.push(
          local(
            id,
            (prev.pos.x + node.pos.x) / 2,
            (prev.pos.y + node.pos.y) / 2,
            (prev.pos.z + node.pos.z) / 2
          )
        );
      }
    }
    legs.push(local(id, node.pos.x, node.pos.y, node.pos.z));
  }
  return legs;
}

/**
 * 2-core patrol prune (port of DungeonPathfinder.cs:451-517). BFS the
 * drop-free, hazard-free reachable set from startCell, then repeatedly peel
 * degree-≤1 nodes (the start cell is always kept) until stable — dead-end
 * spurs of any depth vanish, leaving cycles + through-corridors ("the main
 * route"). Falls back to the full reachable set when pruning collapses the
 * graph (< 8 nodes or < 20% of reachable, :512-514). Returns Set<cellId>.
 */
/**
 * BFS from `fromCell` to the NEAREST graph cell that has an outdoor exit
 * portal (`node.exits`, collected from the raw EnvCell portal ids that the
 * neighbor filter above drops). Drop edges are excluded like findPath — an
 * exit you can only fall into is not an exit you can walk to.
 *
 * Returns { path:[cellIds...], exitCell, outdoorId } or null (no exits
 * known / unreachable / fromCell not in graph). `outdoorId` is the full u32
 * outdoor objCellId beyond the exit portal — its LandCell center is a
 * walkable "just outside the door" target (retail cell index decode:
 * LandDefs::gid_to_lcoord, acclient.c:209521 — idx-1 = cx*8 + cy).
 *
 * opts.walkableOverrides — same escape hatch as findPath (edgeIsDrop above).
 */
export function findExitPath(graph, fromCell, opts = {}) {
  const nodes = asMap(graph);
  const from = Number(fromCell) >>> 0;
  const overrides = opts.walkableOverrides || null;
  if (!nodes.has(from)) return null;
  const prev = new Map([[from, 0]]);
  let frontier = [from];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      const node = nodes.get(id);
      if (!node) continue;
      if (Array.isArray(node.exits) && node.exits.length) {
        const path = [id];
        for (let p = prev.get(id); p; p = prev.get(p)) path.push(p);
        path.reverse();
        // outdoorId is null for the retail outside-sentinel (0xFFFF low
        // word) — the caller derives the outdoor target from geometry.
        const direct = node.exits.find((e) => ((e & 0xffff) > 0 && (e & 0xffff) < 0x100));
        return { path, exitCell: id, outdoorId: direct != null ? direct >>> 0 : null };
      }
      for (const nb of node.neighbors) {
        if (prev.has(nb) || !nodes.has(nb)) continue;
        if (edgeIsDrop(overrides, id, nb, node, nodes.get(nb))) continue;
        prev.set(nb, id);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return null;
}

// opts.walkableOverrides — same escape hatch as findPath (edgeIsDrop above),
// honored by both the reachability BFS and the degree-pruning pass below.
export function getMainRouteNodes(graph, startCell, hazards = null, opts = {}) {
  const nodes = asMap(graph);
  const start = Number(startCell) >>> 0;
  const overrides = opts.walkableOverrides || null;
  const reachable = new Set();
  if (nodes.has(start)) {
    reachable.add(start);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      const node = nodes.get(cur);
      if (!node) continue;
      for (const nbRaw of node.neighbors || []) {
        const nb = Number(nbRaw) >>> 0;
        if (reachable.has(nb) || !nodes.has(nb)) continue;
        if (edgeIsDrop(overrides, cur, nb, node, nodes.get(nb))) continue;
        if (hazards && hazards.has(nb)) continue;
        reachable.add(nb);
        queue.push(nb);
      }
    }
  }

  const originalCount = reachable.size;
  const pruned = new Set(reachable);
  for (;;) {
    const toRemove = [];
    for (const id of pruned) {
      if (id === start) continue; // always keep spawn cell (:492)
      const node = nodes.get(id);
      if (!node) continue;
      let deg = 0;
      for (const nbRaw of node.neighbors || []) {
        const nb = Number(nbRaw) >>> 0;
        if (pruned.has(nb) && nodes.has(nb) && !edgeIsDrop(overrides, id, nb, node, nodes.get(nb))) {
          deg++;
          if (deg > 1) break;
        }
      }
      if (deg <= 1) toRemove.push(id);
    }
    if (!toRemove.length) break;
    for (const id of toRemove) pruned.delete(id);
  }

  if (pruned.size < PATROL_MIN_KEEP_NODES || pruned.size < originalCount * PATROL_MIN_KEEP_FRACTION)
    return reachable;
  return pruned;
}

// Canonical undirected-edge key (C# packs two u32s into a ulong, :619-620 —
// JS numbers can't, so a string key does the same job). Exported so callers
// (goto_compose.js's bounded indoor-wedge retry) can build the SAME keys for
// opts.excludeEdges without duplicating the pairing convention.
export function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// Shortest hop-path src→dst over adj (inclusive), or null (C# BfsPath :645-665).
function bfsPath(adj, src, dst) {
  if (src === dst) return [src];
  const prev = new Map();
  const seen = new Set([src]);
  const q = [src];
  while (q.length) {
    const c = q.shift();
    for (const nb of adj.get(c) || []) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      prev.set(nb, c);
      if (nb === dst) {
        const path = [dst];
        let cur = dst;
        while (cur !== src) {
          cur = prev.get(cur);
          path.push(cur);
        }
        return path.reverse();
      }
      q.push(nb);
    }
  }
  return null;
}

// Shortest hop-path from src to the nearest cell with an unused edge, or null
// (C# BfsToUnusedEdge :668-689).
function bfsToUnusedEdge(adj, src, remaining) {
  const hasUnused = (cell) => {
    for (const nb of adj.get(cell) || []) if (remaining.has(edgeKey(cell, nb))) return true;
    return false;
  };
  const prev = new Map();
  const seen = new Set([src]);
  const q = [src];
  while (q.length) {
    const c = q.shift();
    if (c !== src && hasUnused(c)) {
      const path = [c];
      let cur = c;
      while (cur !== src) {
        cur = prev.get(cur);
        path.push(cur);
      }
      return path.reverse();
    }
    for (const nb of adj.get(c) || []) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      prev.set(nb, c);
      q.push(nb);
    }
  }
  return null;
}

/**
 * Euler-style closed patrol walk (port of DungeonPathfinder.cs:530-616).
 * Route-inspection (Chinese-postman-style) greedy edge cover over the 2-core:
 * every corridor once, loop-closing edges TAKEN (a cycle is walked forward,
 * not backtracked); only dead-ends/bridges re-tread via shortest reconnecting
 * hops; closed back to the start so a Circular patrol returns home.
 *
 * DIVERGENCE from the C#: returns the cell WALK ([cellId,...], first === last
 * when the loop closes) instead of a waypoint NavRouteParser (:554) — feed it
 * to toLegs() and RynthRouter.follow(). Empty array = nothing walkable (:560-564).
 *
 * opts.walkableOverrides — same escape hatch as findPath (edgeIsDrop above),
 * honored by both the mainRoute BFS/prune (via getMainRouteNodes) and the
 * edge-cover walk built here.
 */
export function buildPatrolRoute(graph, startCell, hazards = null, opts = {}) {
  const nodes = asMap(graph);
  const start = Number(startCell) >>> 0;
  const overrides = opts.walkableOverrides || null;
  const mainRoute = getMainRouteNodes(graph, start, hazards, opts);

  // Undirected walkable subgraph over mainRoute (portal-adjacent, non-drop);
  // mainRoute is already hazard-filtered (:537-552).
  const adj = new Map();
  const edges = new Set();
  for (const c of mainRoute) {
    const cn = nodes.get(c);
    if (!cn) continue;
    for (const nbRaw of cn.neighbors || []) {
      const nb = Number(nbRaw) >>> 0;
      if (!mainRoute.has(nb)) continue;
      const nbn = nodes.get(nb);
      if (!nbn || edgeIsDrop(overrides, c, nb, cn, nbn)) continue;
      if (!adj.has(c)) adj.set(c, []);
      adj.get(c).push(nb);
      edges.add(edgeKey(c, nb));
    }
  }

  // Euler start: the player's cell if it borders a corridor, else the nearest
  // cell that does (:557-559 / NearestCellWithEdges :624-642).
  let walkStart = 0;
  if ((adj.get(start) || []).length > 0) walkStart = start;
  else {
    const from = nodes.get(start);
    let bestD = Infinity;
    for (const [id, list] of adj) {
      if (!list.length) continue;
      const n = nodes.get(id);
      if (!n) continue;
      if (!from) {
        walkStart = id;
        break;
      }
      const d = (n.pos.x - from.pos.x) ** 2 + (n.pos.y - from.pos.y) ** 2;
      if (d < bestD) {
        bestD = d;
        walkStart = id;
      }
    }
  }
  if (walkStart === 0 || edges.size === 0) return [];

  // Greedy edge-covering closed walk (:567-597). Guard bound: each edge is
  // consumed once, each exhausted vertex triggers ≤1 reconnection (:571-572).
  const walk = [walkStart];
  const remaining = new Set(edges);
  let cur = walkStart;
  let guard = edges.size * 4 + mainRoute.size + 16;
  while (remaining.size > 0 && guard-- > 0) {
    let next = 0;
    let found = false;
    for (const nb of adj.get(cur) || []) {
      if (remaining.has(edgeKey(cur, nb))) {
        next = nb;
        found = true;
        break;
      }
    }
    if (found) {
      remaining.delete(edgeKey(cur, next));
      walk.push(next);
      cur = next;
    } else {
      const path = bfsToUnusedEdge(adj, cur, remaining);
      if (!path) break; // remaining edges unreachable (disconnected) — stop
      for (let i = 1; i < path.length; i++) walk.push(path[i]);
      cur = path[path.length - 1];
    }
  }

  // Close the loop back to the start (:600-605).
  if (cur !== walkStart) {
    const back = bfsPath(adj, cur, walkStart);
    if (back) for (let i = 1; i < back.length; i++) walk.push(back[i]);
  }
  return walk;
}

/**
 * Build the cell graph from the live wasm session. FULLY guarded — returns
 * null (never throws) off-wasm, pre-spawn, outdoors, or when the exports are
 * missing, so callers can `(await buildGraphFromWasm(h)) || fallback`.
 *
 * Data sources (all verified in src/lib.rs):
 *   - sessionHandle.getCurrentCellId()      lib.rs:30830 (0 pre-spawn)
 *   - sessionHandle.isCurrentCellIndoor()   lib.rs:31479 (advisory only)
 *   - fetchEnvCellsInLandblock(lbId)        lib.rs:17415 — the WHOLE dungeon's
 *     EnvCellPlacements; getRenderSet(depth) (lib.rs:30845) canNOT enumerate a
 *     dungeon: depth≠1 falls back to the canonical depth-1 snapshot
 *     (lib.rs:30886-30891), so `depth` here is a JS-side BFS radius instead.
 *   - EnvCellPlacement.cellId / cellOriginX/Y/Z  lib.rs:15939-15948 —
 *     WORLD-frame x/y (lb origin pre-added, lib.rs:17593-17597), raw z.
 *   - EnvCellPlacement.takePortalCellIds()  lib.rs:15974 — full 32-bit ids,
 *     sentinels NOT filtered (lib.rs:17604-17607); ONE-SHOT move semantics —
 *     this builder consumes them, so don't recycle the placements for rendering.
 *
 * fetchEnvCellsInLandblock is a module-level wasm export, not a SessionHandle
 * method; in-page it's threaded onto window.liveScene3d.wasmExports
 * (index.html:4418). Pass it explicitly via opts.fetchEnvCells in headless/
 * nullRender contexts where scene3d never boots.
 *
 * depth: 0/undefined = whole landblock; N>0 = BFS radius (portal hops) from
 * the current cell, over drop edges too (radius bounds SIZE, not walkability).
 */
// Shared resolver: explicit opts.fetchEnvCells wins; in-page fall back to the
// scene3d-threaded wasm export (index.html:4418). null when neither exists.
function resolveFetchEnvCells(opts = {}) {
  if (typeof opts.fetchEnvCells === "function") return opts.fetchEnvCells;
  const scene = typeof globalThis !== "undefined" ? globalThis.liveScene3d : null;
  return scene && scene.wasmExports ? scene.wasmExports.fetchEnvCellsInLandblock : null;
}

// v' = q v q* (standard quaternion rotation, expanded) — shared by the
// bbox-anchor fix and the floor-span scan below; both need to carry a
// cell-local point/vector into the cell's world orientation.
function rotateByQuat(x, y, z, qw, qx, qy, qz) {
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

// Normalize a placement's orientation quaternion; identity when missing/junk
// (mirrors the anchor-fix's existing NaN/all-zero guard).
function normalizedOrientation(p) {
  let qw = p.cellOrientationQw, qx = p.cellOrientationQx, qy = p.cellOrientationQy, qz = p.cellOrientationQz;
  if (![qw, qx, qy, qz].every(Number.isFinite) || (qw === 0 && qx === 0 && qy === 0 && qz === 0)) {
    qw = 1; qx = qy = qz = 0;
  }
  return [qw, qx, qy, qz];
}

// Scan a cell's own Environment mesh (already fetched for the bbox anchor —
// this is additive, no extra wasm call) for walkable-slope triangles and
// return the WORLD-frame Z range they cover, or null if none (a pure-wall
// shaft/void — see isDropEdge's 2026-07-20 refinement doc comment).
// positions/normals are flat non-indexed triangle lists, 3 verts * 3 floats,
// SAME per-vertex ordering (apps/holtburger-web/src/lib.rs pack_model_mesh)
// and in CELL-LOCAL coordinates — normals need the same world rotation as
// positions before the retail FLOOR_Z up-dot test means anything.
function scanWalkableFloorSpan(mesh, originZ, qw, qx, qy, qz) {
  const positions = mesh.positions, normals = mesh.normals;
  if (!positions || !normals || positions.length !== normals.length || positions.length < 9) return null;
  const triCount = (positions.length / 9) | 0;
  let zMin = Infinity, zMax = -Infinity;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    let nx = 0, ny = 0, nz = 0;
    for (let v = 0; v < 3; v++) {
      nx += normals[o + v * 3];
      ny += normals[o + v * 3 + 1];
      nz += normals[o + v * 3 + 2];
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    const [, , wnz] = rotateByQuat(nx / len, ny / len, nz / len, qw, qx, qy, qz);
    if (wnz < FLOOR_Z) continue; // wall/ceiling/steep-slope triangle
    for (let v = 0; v < 3; v++) {
      const [, , wz] = rotateByQuat(
        positions[o + v * 3], positions[o + v * 3 + 1], positions[o + v * 3 + 2],
        qw, qx, qy, qz
      );
      const worldZ = originZ + wz;
      if (worldZ < zMin) zMin = worldZ;
      if (worldZ > zMax) zMax = worldZ;
    }
  }
  return zMin <= zMax ? { zMin, zMax } : null;
}

// Fetch one landblock's EnvCellPlacements and merge them into `graph`
// (the per-placement parse extracted verbatim from buildGraphFromWasm).
// Resolves true when the landblock contributed any cells; never throws.
async function collectLandblockIntoGraph(fetchEnvCells, lbWord, graph) {
  let placements;
  try {
    placements = await fetchEnvCells((lbWord >>> 0) & 0xffff0000);
  } catch (_) {
    return false;
  }
  if (!placements || typeof placements.length !== "number" || placements.length === 0) return false;
  let added = false;
  for (const p of placements) {
    try {
      const id = p.cellId >>> 0;
      if (!isEnvCellId(id)) continue;
      let pos = { x: p.cellOriginX, y: p.cellOriginY, z: p.cellOriginZ };
      if (typeof pos.x !== "number" || typeof pos.y !== "number" || typeof pos.z !== "number")
        continue;
      let floorZMin, floorZMax;
      // Per-cell anchor (soak-13): BUILDING interiors put every EnvCell on
      // the shared building frame — identical origins for all cells — which
      // collapsed path legs to a single point and wedged exit walks into
      // walls. The cell's own geometry is distinct, so refine the anchor to
      // the mesh bbox center (cell-local), rotated by the cell orientation
      // and offset by the origin. z stays at bbox MIN (floor level) — a
      // walk target, not a look target. takeMesh is a one-shot move on OUR
      // private placement fetch; the renderer's own fetches are unaffected.
      try {
        const mesh = typeof p.takeMesh === "function" ? p.takeMesh() : null;
        if (mesh) {
          try {
            const [qw, qx, qy, qz] = normalizedOrientation(p);
            const bb = mesh.bbox;
            if (bb && bb.length === 6) {
              const lx = (bb[0] + bb[3]) / 2, ly = (bb[1] + bb[4]) / 2, lz = bb[2];
              const [rx, ry, rz] = rotateByQuat(lx, ly, lz, qw, qx, qy, qz);
              pos = { x: pos.x + rx, y: pos.y + ry, z: pos.z + rz };
            }
            // isDropEdge refinement (2026-07-20, HANDOFF-wedge-closeout Track
            // E3/F): same mesh, same rotation — additionally record the
            // WORLD-frame Z span of this cell's own walkable-slope floor, so
            // a stair/ramp shaft whose bbox-anchor centers still land near-
            // stacked (SHAFT_HORIZ_M) isn't pruned as an un-jumpable drop.
            const span = scanWalkableFloorSpan(mesh, p.cellOriginZ, qw, qx, qy, qz);
            if (span) {
              floorZMin = span.zMin;
              floorZMax = span.zMax;
            }
          } finally {
            try { mesh.free?.(); } catch (_) { /* moved */ }
          }
        }
      } catch (_) { /* mesh unavailable — frame origin anchor stands */ }
      const raw = typeof p.takePortalCellIds === "function" ? p.takePortalCellIds() : [];
      const neighbors = [];
      const exits = [];
      for (const nbRaw of raw || []) {
        const nb = nbRaw >>> 0;
        if (nb !== id && isEnvCellId(nb)) neighbors.push(nb); // sentinel/self filter (cs:163)
        // Building/dungeon EXIT marker — findExitPath routes to these.
        // Retail encodes "portal leads outside" as other_cell_id == -1
        // (0xFFFF low word; acclient.c:348490 sets check_outside on it);
        // a direct outdoor LandCell id (low word 0x0001..0x00FF) also
        // counts. Neither is a graph node.
        else if (nb !== id) {
          const lo = nb & 0xffff;
          if ((lo > 0 && lo < 0x100) || lo >= 0xfffe) exits.push(nb);
        }
      }
      const node = { pos, neighbors, exits };
      if (typeof floorZMin === "number") {
        node.floorZMin = floorZMin;
        node.floorZMax = floorZMax;
      }
      graph.set(id, node);
      added = true;
    } catch (_) {
      // malformed placement — skip, like the C# per-cell catch (cs:182)
    } finally {
      if (typeof p.free === "function") {
        try {
          p.free();
        } catch (_) {
          /* already freed */
        }
      }
    }
  }
  return added;
}

// Cross-LB stitching bound (2026-07-18): dungeon complexes are small (2-4
// landblocks); the cap only exists so a pathological portal-record web can't
// fan a single route request out into dozens of DAT fetches.
const STITCH_MAX_LANDBLOCKS = 8;

/**
 * Stitched multi-landblock graph (2026-07-18, cross-LB dungeon routing —
 * playtester soak 7 §4.3: the academy courtyard's chest sits across a
 * landblock seam and indoorLegsTo used to bail). Fetches EnvCellPlacements
 * for every landblock in `lbIds` and merges them into ONE graph. Portal ids
 * are full 32-bit objCellIds (lib.rs:15970-15977), so seam doorways connect
 * naturally once both sides are loaded — no synthetic edges needed.
 *
 * opts.expand (default true): chase boundary references — any neighbor id
 * pointing into a landblock not yet fetched pulls that landblock in too, so
 * a complex spanning 3+ blocks stitches without the caller enumerating the
 * middle. Bounded by opts.maxLandblocks (default 8). opts.fetchEnvCells as
 * in buildGraphFromWasm. Returns Map | null; never throws.
 */
export async function buildStitchedGraphFromWasm(lbIds, opts = {}) {
  const want = [
    ...new Set(
      (Array.isArray(lbIds) ? lbIds : [lbIds])
        .map((id) => (Number(id) >>> 0) & 0xffff0000)
        .filter((lb) => lb !== 0)
    ),
  ];
  if (!want.length) return null;
  const fetchEnvCells = resolveFetchEnvCells(opts);
  if (typeof fetchEnvCells !== "function") return null;
  const maxLbs = Number.isFinite(opts.maxLandblocks) ? opts.maxLandblocks : STITCH_MAX_LANDBLOCKS;
  const expand = opts.expand !== false;

  const graph = new Map();
  const fetched = new Set();
  const queue = [...want];
  while (queue.length && fetched.size < maxLbs) {
    const lb = queue.shift();
    if (fetched.has(lb)) continue;
    fetched.add(lb);
    await collectLandblockIntoGraph(fetchEnvCells, lb, graph);
    if (!expand) continue;
    for (const node of graph.values()) {
      for (const nbRaw of node.neighbors) {
        const nbLb = (nbRaw >>> 0) & 0xffff0000;
        if (nbLb && !fetched.has(nbLb) && !queue.includes(nbLb)) queue.push(nbLb);
      }
    }
  }
  return graph.size ? graph : null;
}

export async function buildGraphFromWasm(sessionHandle, depth = 0, opts = {}) {
  if (!sessionHandle || typeof sessionHandle.getCurrentCellId !== "function") return null;
  let cur = 0;
  try {
    cur = sessionHandle.getCurrentCellId() >>> 0;
  } catch (_) {
    return null;
  }
  if (!isEnvCellId(cur)) return null; // pre-spawn (0) or outdoors (>= 0xFFFE low word)

  const fetchEnvCells = resolveFetchEnvCells(opts);
  if (typeof fetchEnvCells !== "function") return null;

  const graph = new Map();
  await collectLandblockIntoGraph(fetchEnvCells, cur & 0xffff0000, graph);
  if (graph.size === 0) return null;

  if (depth > 0 && graph.has(cur)) {
    // JS-side BFS radius from the current cell (see docblock: the wasm
    // getRenderSet can't do depth>1). Drop edges still count for RADIUS.
    const keep = new Set([cur]);
    let frontier = [cur];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = [];
      for (const id of frontier) {
        for (const nb of graph.get(id).neighbors) {
          if (!keep.has(nb) && graph.has(nb)) {
            keep.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
    for (const id of [...graph.keys()]) if (!keep.has(id)) graph.delete(id);
  }
  return graph;
}

export default {
  isEnvCellId,
  isDropEdge,
  edgeKey,
  nearestCell,
  findPath,
  findExitPath,
  toLegs,
  getMainRouteNodes,
  buildPatrolRoute,
  buildGraphFromWasm,
  buildStitchedGraphFromWasm,
};
