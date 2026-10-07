// plugins/vendor_range.js — when the vendor window closes as you walk away
// (bug 3, 2026-10-07). Pure; imported by plugins/vendor-ui.js.
//
// RETAIL: `gmVendorUI::OpenVendor` (acclient.c:246660) registers an object
// range handler with the vendor's own wire `_useRadius`, use_radii=1,
// xy_only=0; `ACCWeenieObject::ObjectsInRange` (:436730) →
// `CPhysicsObj::get_distance_to_object(use_cyls=1)` →
// `Position::cylinder_distance` (:467221) with each body's
// `CPartArray::GetRadius`/`GetHeight`. Out of range → `CloseVendor`.
// An absent use radius is 0 m (the PublicWeenieDesc ctor zeroes it,
// :470951). OpenAC: Runtime/Gameplay/RuntimeVendorRangeQuery.cs +
// Core/Physics/ObjectRangeMath.cs, same inputs.

// Pre-2026-10-07 fixed range (ACE-World vendors' usual UseRadius 3.0 plus two
// humanoid radii, measured planar centre-to-centre). Only used when the
// wasm snapshot predates the wire radius (stale pkg/).
export const VENDOR_FALLBACK_RANGE_M = 3.0 + 0.96;

/**
 * Retail `Position::cylinder_distance` (acclient.c:467221): the 3-D origin
 * distance minus both radii, combined with the vertical gap between the two
 * cylinders. Negative when the bodies overlap in both directions.
 */
export function vendorCylinderDistance(r1, h1, p1, r2, h2, p2) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y, dz = p2.z - p1.z;
  const radial = Math.sqrt(dx * dx + dy * dy + dz * dz) - (r1 + r2);
  const vgap = p1.z <= p2.z ? p2.z - (p1.z + h1) : p1.z - (p2.z + h2);
  if (vgap <= 0) {
    return radial <= 0 ? -Math.sqrt(vgap * vgap + radial * radial) : radial;
  }
  return radial > 0 ? Math.sqrt(vgap * vgap + radial * radial) : vgap;
}

/**
 * Is the player still in range of the open vendor?
 * @param {{useRadius:?number, vendorRadius:number, vendorHeight:number,
 *          playerRadius:number, playerHeight:number}} vs vendor snapshot
 * @param {{x:number,y:number,z:number}} vendorPos vendor origin (world frame)
 * @param {{x:number,y:number,z:number}} playerPos player origin (world frame)
 * @returns {{inRange:boolean, dist:number, range:number, mode:string}}
 */
export function vendorRangeVerdict(vs, vendorPos, playerPos) {
  if (vs && Number.isFinite(vs.useRadius)) {
    const dist = vendorCylinderDistance(
      vs.playerRadius || 0, vs.playerHeight || 0, playerPos,
      vs.vendorRadius || 0, vs.vendorHeight || 0, vendorPos,
    );
    return { inRange: dist <= vs.useRadius, dist, range: vs.useRadius, mode: "cylinder" };
  }
  const dist = Math.hypot(vendorPos.x - playerPos.x, vendorPos.y - playerPos.y);
  return { inRange: dist <= VENDOR_FALLBACK_RANGE_M, dist, range: VENDOR_FALLBACK_RANGE_M, mode: "fallback" };
}
