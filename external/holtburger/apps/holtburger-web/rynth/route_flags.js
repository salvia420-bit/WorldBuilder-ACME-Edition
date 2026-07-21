// route_flags.js — shared v2 route-flag derivation (contract v2: task #17,
// extended for nav import 2026-07-20). Single source of truth for the
// portal/indoor flag rules so the replay side (goto_compose.js) and the
// VTank/.nav import side (nav_import.js) can never drift on what a v2 flag
// means. Previously this lived only inside goto_compose.js; pulled out here
// so nav_import.js (which has no business importing indoor_router's replay
// machinery) can reuse the SAME deriveRouteFlags rather than re-implementing
// the distance/indoor heuristics.
//
// Contract recap:
//   - portal: set on leg[i] when dist(leg[i], leg[i+1]) >= HOP_DISCONTINUITY_M
//     world-frame metres (the departure leg of a hop) for a LEGACY (fmt!==2)
//     route; a fmt===2 route's recorded/imported flags are trusted as-is.
//   - indoor: waypoint cell isEnvCellId (legacy only; fmt===2 trusts l.indoor).

import { isEnvCellId } from "./indoor_router.js";

// World-frame metres from a full objCellId + landblock-local x/y (mirrors the
// same tiny helper duplicated in atlas.js/route_recorder.js/goto_compose.js —
// consistent with this codebase's existing convention of a local worldXY per
// file rather than a shared math import).
const worldX = (cell, x) => ((cell >>> 24) & 0xff) * 192 + x;
const worldY = (cell, y) => ((cell >>> 16) & 0xff) * 192 + y;

// World-frame 2D distance between two legs (each {lb,x,y}).
function legDist2D(a, b) {
  return Math.hypot(
    worldX(a.lb >>> 0, a.x) - worldX(b.lb >>> 0, b.x),
    worldY(a.lb >>> 0, a.y) - worldY(b.lb >>> 0, b.y)
  );
}

export const HOP_DISCONTINUITY_M = 500;

// nav_import.js meta.navType values that are ALWAYS a real portal/teleport by
// construction of the source record (prt/rcl/ptl — see nav_import.js header),
// independent of geometry. Only nav-imported legs ever carry meta.navType
// (route_recorder.js's own per-leg shape has no `meta` field at all — see
// route_flags.js's caller-side note), so this can never collide with a
// recorded route's legacy per-leg `.portal` marker.
const GROUND_TRUTH_PORTAL_NAV_TYPES = new Set(["prt", "rcl", "ptl"]);

/**
 * Derive contract-v2 flags on a route's legs. fmt===2 routes carry flags from
 * the recorder (or a v2-aware importer) and are trusted; a LEGACY route (no
 * fmt, or fmt!==2) is scanned:
 *   - portal: set on leg[i] when dist(leg[i], leg[i+1]) >= 500m world-frame
 *     (the departure leg of a hop) — recomputed, so a legacy route's stale
 *     arrival-portal flags are corrected. OR'd with a nav-import GROUND-TRUTH
 *     navType (prt/rcl/ptl): an imported route replayed without its `fmt:2`
 *     threaded through (e.g. bot.followRoute(route.legs, opts) without
 *     opts.fmt) must not lose a real portal/recall leg just because its hub
 *     neighbour happens to sit within 500m (the MatronHive portal-hub
 *     pattern) — a record the file ITSELF says is a portal is never
 *     downgraded by the geometric heuristic. Recorded routes never carry
 *     meta.navType, so this never resurrects a stale recorded `.portal` flag
 *     (see the arrival-flag-clearing contract this preserves, below).
 *   - indoor: waypoint cell isEnvCellId.
 * Returns a NEW leg array; input is not mutated.
 */
export function deriveRouteFlags(legs, fmt) {
  if (!Array.isArray(legs)) return [];
  const legacy = fmt !== 2;
  return legs.map((l, i) => {
    const out = { ...l };
    const lb = (l.lb >>> 0);
    const indoor = legacy ? isEnvCellId(lb) : l.indoor === true;
    let portal = l.portal === true;
    if (legacy) {
      const nxt = legs[i + 1];
      const geomPortal = !!nxt && legDist2D(l, nxt) >= HOP_DISCONTINUITY_M;
      const groundTruth = !!(l.meta && GROUND_TRUTH_PORTAL_NAV_TYPES.has(l.meta.navType));
      portal = geomPortal || groundTruth;
    }
    if (portal) out.portal = true; else delete out.portal;
    if (indoor) out.indoor = true; else delete out.indoor;
    return out;
  });
}

export default { deriveRouteFlags, HOP_DISCONTINUITY_M };
