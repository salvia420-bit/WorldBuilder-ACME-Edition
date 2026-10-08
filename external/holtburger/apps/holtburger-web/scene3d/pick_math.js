// selection-5 (2026-10-08) — retail mouse-pick sphere fallback, import-free so
// it loads under plain node (tests/pick_math.test.mjs).
//
// Retail picks per drawn part: Render::GfxObjUnderSelectionRay
// (acclient.c:379997-380073) intersects the selection ray with the part's
// drawing sphere (CSphere::sphere_intersects_ray) and records the nearest
// sphere hit, then tests the part's polygons and records the nearest polygon
// hit. Render::GetMouseSelectionObjectID (:380089) returns the polygon hit's
// object when any polygon was hit, otherwise the nearest sphere hit's object.
// picking.js keeps three's polygon raycast and calls this only when it found
// nothing.

/**
 * CSphere::sphere_intersects_ray (acclient.c) for one sphere. Returns the
 * entry parameter t along `dir` (in units of |dir|), or -1 for no hit. A ray
 * that starts inside (or on) the sphere is NOT a hit (`c <= 0`), nor is a
 * degenerate direction (`|dir|^2 < 2e-4`). Retail never tests a sphere
 * behind the eye (it is not drawn), so a negative t is reported as no hit.
 */
export function sphereRayEntry(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const px = ox - cx;
  const py = oy - cy;
  const pz = oz - cz;
  const a = dx * dx + dy * dy + dz * dz;
  const b = -(px * dx + py * dy + pz * dz);
  const c = px * px + py * py + pz * pz - r * r;
  if (c <= 0 || a < 0.00019999999) return -1;
  const disc = b * b - c * a;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = b <= s ? (s + b) / a : (b - s) / a;
  return t >= 0 ? t : -1;
}

/**
 * The guid of the nearest sphere the ray enters, or null. Ties keep the
 * first sphere seen.
 *
 * @param {{x:number,y:number,z:number}} origin
 * @param {{x:number,y:number,z:number}} dir
 * @param {Array<{guid:number, cx:number, cy:number, cz:number, r:number}>} spheres
 * @param {number} [count] — how many entries of `spheres` are live (lets the
 *        caller reuse a pooled array without truncating it).
 * @returns {number|null}
 */
export function pickNearestSphereHit(origin, dir, spheres, count = spheres.length) {
  let best = null;
  let bestT = Infinity;
  const n = Math.min(count, spheres.length);
  for (let i = 0; i < n; i++) {
    const sp = spheres[i];
    const t = sphereRayEntry(
      origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, sp.cx, sp.cy, sp.cz, sp.r);
    if (t < 0 || t >= bestT) continue;
    bestT = t;
    best = sp.guid;
  }
  return best;
}
