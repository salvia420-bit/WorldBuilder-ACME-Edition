// nav_guard.js (WP-9) — a pure nav *shield* in front of every indoor leg
// issuance. Two survival guards (C2 items 1+3; invariants C6 sub-floor-Z, C7
// landblock-legality), applied BEFORE any MoveToPosition / router leg is
// emitted. It is a shield, NOT the wasm floor-solve fix — it only refuses to
// issue a leg that cannot be legal, so a mis-solved pose parks instead of
// walking through un-loaded geometry or driving into a landblock seam.
//
//   1. SUB-FLOOR-Z / un-solved pose (C6): an EnvCell pose whose z sits
//      strictly BELOW the cell's own floor plane − EPSILON is treated as
//      NOT yet solved. z EQUAL to the plane is a SOLVED pose: retail's
//      CTransition settle is geometrically exact (CPolygon::check_walkable →
//      CPhysicsObj::SetPositionInternal commit no additive epsilon — decomp-
//      verified 2026-07-21), so the faithful placement port legitimately rests
//      the player at exactly floor z (live: academy cells 0x860201Bx, z=0.000,
//      server accepts every transition). ACE's persisted 0.005 is authored
//      data headroom, NOT a physics invariant — an earlier revision parked on
//      z≤plane+ε and froze frontier exploration on every correct settle. The
//      streaming/respawn gap is caught by the objCellId-0 sentinel
//      (indoor_router.js isUnresolvedCellId); a true stuck-below-floor wedge
//      shows as realized-distance≈0 under drive, which the stall watchdogs
//      own — z-at-plane is not evidence of either. OUTDOOR poses are EXEMPT
//      as before.
//
//      The plane is NOT a fixed world-z=0 (2026-07-23 fix): FLOOR_PLANE_Z=0
//      is only the last-resort default for a cell nav_guard knows nothing
//      about. The real per-cell floor (indoor_router.js's scanned
//      node.floorZMin, ~:816) is pulled through setFloorPlaneProvider() — an
//      injected getter, NOT an import of indoor_router.js (forbidden below,
//      cycle) — so the sole caller (bot.js's `this.ir.guardLeg`, wired as a
//      bare function reference with no opts) gets the CORRECT default for
//      every EnvCell, including deep-dungeon floors well below world-z 0,
//      without bot.js passing anything. opts.floorPlaneZ still overrides
//      per-call when a caller does know better.
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

// EnvCell floor-plane reference + slack. A caller that knows the true floor
// of this cell passes opts.floorPlaneZ; absent that, isSubFloorZ asks the
// injected floor-plane provider (see setFloorPlaneProvider) for THIS cell's
// own floor before ever falling back to FLOOR_PLANE_Z. EPSILON is numerical
// tolerance BELOW the plane before a pose counts as sub-floor (z=plane and
// z=plane−0.0001 proceed; z=plane−0.001 parks).
export const FLOOR_PLANE_Z = 0;
export const FLOOR_EPSILON = 0.0002;

// Per-EnvCell floor lookup, dependency-INJECTED (this module must not import
// indoor_router.js — see header). indoor_router.js registers itself with
// setFloorPlaneProvider(fn) at load time, fn: (cellId:u32) => number|
// undefined, backed by the node.floorZMin it already scans while building
// the cell graph. A test double / older bundle that never registers one
// degrades to the flat FLOOR_PLANE_Z=0 default — unchanged prior behavior.
let _floorPlaneProvider = null;

/** Inject (or, with a non-function arg, clear) the per-cell floor lookup. */
export function setFloorPlaneProvider(fn) {
  _floorPlaneProvider = typeof fn === "function" ? fn : null;
}

// Resolve the floor plane for `cellId`: an explicit finite floorPlaneZ wins
// outright (the per-call override contract); otherwise ask the injected
// provider for THIS cell; otherwise the flat default.
function resolveFloorPlaneZ(cellId, floorPlaneZ) {
  if (Number.isFinite(floorPlaneZ)) return floorPlaneZ;
  if (_floorPlaneProvider) {
    try {
      const z = _floorPlaneProvider(cellId >>> 0);
      if (Number.isFinite(z)) return z;
    } catch {
      /* provider threw — fall through to the flat default */
    }
  }
  return FLOOR_PLANE_Z;
}

// verdict.reason values — stable strings; callers branch on these.
export const NAV_OK = "ok";
export const NAV_UNSOLVED = "unsolved";
export const NAV_CROSS_LB = "cross_lb";

// Compact one-line operator messages (the caller prefixes its own context).
export const MSG_UNSOLVED = "NAV: pose un-solved (sub-floor z), holding";
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
 * True if an INDOOR pose/leg sits strictly BELOW the EnvCell floor plane
 * (beyond EPSILON tolerance) and is therefore un-solved (don't path from OR
 * to it). z at the plane is a solved pose — the faithful settle is exact (see
 * header). Outdoor and unresolved (id 0) cells return false — the sub-floor
 * rule is EnvCell-only; z≈0 outdoors is a real ground height, and the id-0
 * gap is caught by the caller's own isEnvCellId gate before it ever reaches
 * leg issuance. A non-finite z is treated as un-solved (there is no solved
 * pose without a z).
 *
 * floorPlaneZ, if finite, is an explicit per-call override; otherwise the
 * plane is resolved per-cellId via the injected floor-plane provider (this
 * cell's real floor — deep-dungeon floors sit well below world-z 0), falling
 * back to the flat FLOOR_PLANE_Z=0 only when no provider is registered or it
 * has nothing for this cell yet.
 */
export function isSubFloorZ(cellId, z, floorPlaneZ = undefined) {
  if (!isEnvCellId(cellId >>> 0)) return false;
  if (typeof z !== "number" || !Number.isFinite(z)) return true;
  const plane = resolveFloorPlaneZ(cellId, floorPlaneZ);
  return z < plane - FLOOR_EPSILON;
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
 *
 * opts.floorPlaneZ, if given, overrides the plane for BOTH endpoints alike
 * (the explicit per-call contract, unchanged). Otherwise each endpoint
 * resolves its OWN floor independently via the injected provider — start
 * and target need not share a cell (or a landblock).
 */
export function guardLeg(start, target, opts = {}) {
  const floorPlaneZ = opts && Number.isFinite(opts.floorPlaneZ) ? opts.floorPlaneZ : undefined;
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
  setFloorPlaneProvider,
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
