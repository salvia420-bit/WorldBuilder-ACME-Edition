// plugins/slumlord_range.js — when the house (slumlord) window closes as you
// walk away from the covenant crystal (messages-objects-3, 2026-10-13).
// Pure; imported by plugins/house-panel.js.
//
// RETAIL: `gmSlumlordUI::RecvNotice_UpdateHouseProfile` (acclient.c:250593)
// shows the window and calls `CPlayerSystem::RegisterObjectRangeHandler(
// crystal, 9.0, useRadii=1, ignoreZDelta=0, 1.0 s, no timeout)`. Once a
// second `CPlayerSystem::CalculateObjectRangeChecks` (:397612) asks
// `ACCWeenieObject::ObjectsInRange` (:436730) — 0 when either object is
// gone, else `CPhysicsObj::get_distance_to_object(use_cyls=1)` →
// `Position::cylinder_distance` (:467221) `<= 9.0` — and out of range fires
// `gmSlumlordUI::OnObjectRangeExit` (:249388), which hides the window.
// WebAC names the two constants MaxLordDistance (.rdata 0x7b66b8) and
// CHECK_LORD_INTERVAL (packages/renderer/src/world/ObjectRangeChecks.ts).

import { vendorCylinderDistance } from "./vendor_range.js";

/** Retail MaxLordDistance: 9 m, surface to surface (both bodies' radii). */
export const SLUMLORD_MAX_DISTANCE_M = 9.0;
/** Retail CHECK_LORD_INTERVAL: one check a second. */
export const SLUMLORD_RANGE_POLL_MS = 1000;
/**
 * Centre-distance slack used only when either body's size is unknown (a
 * stale pkg/ or a Setup not resident yet): about a human's radius plus a
 * crystal's, the same slack as ground_container_rules.js NO_DIMS_SLACK_M.
 * A window that lingers a little is better than one that closes early.
 */
export const SLUMLORD_NO_DIMS_SLACK_M = 1.5;

/**
 * Is the player still in range of the crystal whose HouseProfile opened the
 * window?
 * @param {{crystalDims?:?ArrayLike<number>, playerDims?:?ArrayLike<number>}} dims
 *   each body's `[radius, height]` (objectPartDims); empty / null = unknown
 * @param {{x:number,y:number,z:number}} crystalPos crystal origin (world, Z-up)
 * @param {{x:number,y:number,z:number}} playerPos player origin (world, Z-up)
 * @returns {{inRange:boolean, dist:number, range:number, mode:string}}
 */
export function slumlordRangeVerdict(dims, crystalPos, playerPos) {
  const cd = dims?.crystalDims, pd = dims?.playerDims;
  const cr = Number(cd?.[0]), pr = Number(pd?.[0]);
  if (cr > 0 && pr > 0) {
    const dist = vendorCylinderDistance(
      pr, Number(pd[1]) || 0, playerPos,
      cr, Number(cd[1]) || 0, crystalPos,
    );
    return { inRange: dist <= SLUMLORD_MAX_DISTANCE_M, dist, range: SLUMLORD_MAX_DISTANCE_M, mode: "cylinder" };
  }
  const dist = Math.hypot(crystalPos.x - playerPos.x, crystalPos.y - playerPos.y, crystalPos.z - playerPos.z);
  const range = SLUMLORD_MAX_DISTANCE_M + SLUMLORD_NO_DIMS_SLACK_M;
  return { inRange: dist <= range, dist, range, mode: "fallback" };
}
