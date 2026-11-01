// scene3d/vehicle/board_hop.js — the boarding / exit hop (vehicles DESIGN §6.2, M5 "boarding animation").
//
// Presentation only, local to the pilot's client: the server seats the pilot instantly (VehicleSeat) and every other
// client sees the retail Sitting pilot at the seat at once. Here the local rig travels from where it stood to the seat
// along a short arc while its retail Sitting motion plays (and back down to the exit placement on leaving), instead of
// snapping. With the demo stand-in the seat is up in the balloon's basket (~5.75 m), so the snap read as a teleport.
// `?vehicleBoardAnim=off` (exact) restores the snap. Pure module (no THREE, no DOM): tests/vehicle_flight.test.mjs.

export const HOP = Object.freeze({
  baseSec: 0.45, // + distance / speed, clamped to [minSec, maxSec]
  metresPerSec: 12,
  minSec: 0.6,
  maxSec: 1.2,
  arcM: 0.6, // extra height at the middle of the hop, + arcPerM per metre travelled
  arcPerM: 0.06,
  exitSec: 0.6,
});

/** `?vehicleBoardAnim=off` (exact) disables the hops. */
export function boardAnimEnabled(search) {
  try { return new URLSearchParams(search || "").get("vehicleBoardAnim") !== "off"; } catch (_) { return true; }
}

/** Hop duration (s) for a straight-line distance (m). */
export function hopDuration(dist) {
  const d = Number.isFinite(dist) && dist > 0 ? dist : 0;
  return Math.min(HOP.maxSec, Math.max(HOP.minSec, HOP.baseSec + d / HOP.metresPerSec));
}

function smooth(u) {
  return u * u * (3 - 2 * u);
}

/**
 * Point on the hop at progress u ∈ [0, 1]: eased from `from` to `to`, plus a parabolic arc (zero at both ends).
 * @param {{x:number,y:number,z:number}} from
 * @param {{x:number,y:number,z:number}} to
 */
export function hopPoint(from, to, u, arcM) {
  const t = Math.min(1, Math.max(0, u));
  const e = smooth(t);
  const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const arc = (Number.isFinite(arcM) ? arcM : HOP.arcM + HOP.arcPerM * d) * 4 * t * (1 - t);
  return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: from.z + (to.z - from.z) * e + arc };
}

/** Heading (radians, compass) interpolated the short way round. */
export function hopHeading(h0, h1, u) {
  let d = h1 - h0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return h0 + d * smooth(Math.min(1, Math.max(0, u)));
}

/** Compass heading of an AC-frame quaternion [w, x, y, z] (forward = +y at heading 0, +x at π/2). */
export function headingOfQuat(q) {
  const [w, x, y, z] = q;
  // rotate the forward vector (0, 1, 0)
  const fx = 2 * (x * y - w * z);
  const fy = 1 - 2 * (x * x + z * z);
  return Math.atan2(fx, fy);
}
