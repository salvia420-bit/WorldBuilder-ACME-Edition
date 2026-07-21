// nav_guard.js (WP-9) — a pure nav *shield* in front of every indoor leg
// issuance. Two survival guards (C2 items 1+3; invariants C6 sub-floor-Z, C7
// landblock-legality), applied BEFORE any MoveToPosition / router leg is
// emitted. It is a shield, NOT the wasm floor-solve fix — it only refuses to
// issue a leg that cannot be legal, so a mis-solved pose parks instead of
// walking through un-loaded geometry or driving into a landblock seam.
//
//   1. SUB-FLOOR-Z / un-solved pose (C6): an EnvCell pose whose z sits at or
//      below the cell floor plane (default 0) + EPSILON is treated as NOT yet
//      solved — the local player pose reads z≈0 during a streaming/respawn gap
//      (the objCellId-0 sentinel is the id-side of that same gap,
//      indoor_router.js isUnresolvedCellId; z≈0 is the pose-side). Pathing
//      FROM or TO such a pose stamps a leg through geometry that is not loaded
//      yet, so the guard PARKS ("NAV: pose un-solved (z=0), holding") and the
//      caller no-ops this tick. OUTDOOR poses are EXEMPT — z≈0 is a legitimate
//      outdoor ground height, so the rule is EnvCell-only.
//
//   2. INDOOR->INDOOR CROSS-LANDBLOCK leg (C7): a single MoveToPosition cannot
//      safely step across a dungeon landblock seam — the wasm nav/physics is
//      per-landblock, so a direct cross-seam leg drives INTO the boundary. The
//      legal move is to walk to the seam PORTAL first (findExitPath) and let
//      the cell transition carry the crossing. The guard REJECTS the direct
//      leg ("NAV: no legal path this landblock"); legalIndoorReroute() picks
//      the portal exit instead (dependency-INJECTED findExitPath — this module
//      must NOT import indoor_router.js, which consumes THIS module).
//
// Observation-token cost: ZERO when legs are legal (silent pass-through). On
// failure the guard returns a single compact one-line message the caller may
// journal at most once per hold/reject *episode*. Degrades to today's behavior
// when the caller can't see guardLeg (test double / older indoor_router) — it
// is a shield, never a hard dependency.
//
// Pure, leaf module: imports ONLY nav_frame.js (WP-8). No host/session/DOM,
// never throws. Do NOT add an import of indoor_router.js here (cycle).

import { isEnvCellId, landblockOf } from "./nav_frame.js";

// EnvCell floor-plane reference + slack. The default plane 0 catches the z≈0
// streaming-gap sentinel; a caller that knows the true floor of this cell
// passes opts.floorPlaneZ. EPSILON is the "z==0 vs solved-just-above-floor"
// boundary the task fixes at 0.0002 (z=0 parks, z=0.005 proceeds).
export const FLOOR_PLANE_Z = 0;
export const FLOOR_EPSILON = 0.0002;

// verdict.reason values — stable strings; callers branch on these.
export const NAV_OK = "ok";
export const NAV_UNSOLVED = "unsolved";
export const NAV_CROSS_LB = "cross_lb";

// Compact one-line operator messages (the caller prefixes its own context).
export const MSG_UNSOLVED = "NAV: pose un-solved (z=0), holding";
export const MSG_CROSS_LB = "NAV: no legal path this landblock";

// Accept a pose ({objCellId}), a router leg ({lb}), or a bare {cellId}. A
// missing / -1 / NaN id collapses to 0 (the unresolved sentinel), which
// isEnvCellId already rejects, so it never masquerades as indoor.
function cellOf(o) {
  if (!o || typeof o !== "object") return 0;
  const raw = o.cellId ?? o.objCellId ?? o.lb;
  return Number.isFinite(raw) ? raw >>> 0 : 0;
}

/**
 * True if an INDOOR pose/leg sits at or below the EnvCell floor plane and is
 * therefore un-solved (don't path from OR to it). Outdoor and unresolved
 * (id 0) cells return false — the sub-floor rule is EnvCell-only; z≈0 outdoors
 * is a real ground height, and the id-0 gap is caught by the caller's own
 * isEnvCellId gate before it ever reaches leg issuance. A non-finite z is
 * treated as un-solved (there is no solved pose without a z).
 */
export function isSubFloorZ(cellId, z, floorPlaneZ = FLOOR_PLANE_Z) {
  if (!isEnvCellId(cellId >>> 0)) return false;
  if (typeof z !== "number" || !Number.isFinite(z)) return true;
  const plane = Number.isFinite(floorPlaneZ) ? floorPlaneZ : FLOOR_PLANE_Z;
  return z <= plane + FLOOR_EPSILON;
}

/**
 * True if BOTH endpoints are EnvCells in DIFFERENT landblocks — the direct leg
 * would cross a dungeon seam and is illegal (route via the exit portal). An
 * indoor→OUTDOOR or outdoor→indoor pair is not this case (that IS the portal
 * transition); only indoor→indoor across the seam is refused here.
 */
export function isCrossLandblockIndoor(startCellId, targetCellId) {
  const a = startCellId >>> 0, b = targetCellId >>> 0;
  return isEnvCellId(a) && isEnvCellId(b) && landblockOf(a) !== landblockOf(b);
}

/**
 * The shield. Given a start pose and a target (pose or leg), return a verdict:
 *   { ok: true,  reason: NAV_OK }
 *   { ok: false, reason: NAV_UNSOLVED, message: MSG_UNSOLVED }  // park, no leg
 *   { ok: false, reason: NAV_CROSS_LB, message: MSG_CROSS_LB }  // reroute via portal
 * Never throws. Order: sub-floor (either endpoint) is checked BEFORE the
 * cross-landblock test — a z≈0 endpoint is un-solved regardless of which
 * landblock it claims to be in, so "holding" is the truthful verdict there.
 */
export function guardLeg(start, target, opts = {}) {
  const floorPlaneZ = opts && Number.isFinite(opts.floorPlaneZ) ? opts.floorPlaneZ : FLOOR_PLANE_Z;
  const s = start || {}, t = target || {};
  const sCell = cellOf(s), tCell = cellOf(t);
  if (isSubFloorZ(sCell, s.z, floorPlaneZ) || isSubFloorZ(tCell, t.z, floorPlaneZ)) {
    return { ok: false, reason: NAV_UNSOLVED, message: MSG_UNSOLVED };
  }
  if (isCrossLandblockIndoor(sCell, tCell)) {
    return { ok: false, reason: NAV_CROSS_LB, message: MSG_CROSS_LB };
  }
  return { ok: true, reason: NAV_OK };
}

/**
 * When guardLeg rejects a cross-landblock indoor leg, this picks the LEGAL
 * move instead: findExitPath from the start cell to the nearest walkable exit
 * portal within the CURRENT landblock. `ir` is the indoor_router module,
 * dependency-INJECTED (this module must not import it — indoor_router.js
 * consumes THIS module). Returns the findExitPath result
 * ({ path, exitCell, outdoorId }) or null when no exit is known / ir lacks
 * findExitPath / it throws. Never throws.
 */
export function legalIndoorReroute(ir, graph, fromCell, opts = {}) {
  if (!ir || typeof ir.findExitPath !== "function") return null;
  let exit = null;
  try {
    exit = ir.findExitPath(graph, fromCell >>> 0, opts || {});
  } catch {
    return null;
  }
  if (!exit || !Array.isArray(exit.path) || !exit.path.length) return null;
  return exit;
}

export default {
  FLOOR_PLANE_Z,
  FLOOR_EPSILON,
  NAV_OK,
  NAV_UNSOLVED,
  NAV_CROSS_LB,
  MSG_UNSOLVED,
  MSG_CROSS_LB,
  isSubFloorZ,
  isCrossLandblockIndoor,
  guardLeg,
  legalIndoorReroute,
};
