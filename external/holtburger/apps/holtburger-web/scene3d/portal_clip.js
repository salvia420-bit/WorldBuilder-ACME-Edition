// scene3d/portal_clip.js — pure geometry helpers for the retail portal renderer.
//
// NEW 2026-08-04 (terrain-over-interiors fix). Dependency-free on purpose: no
// THREE, no DOM, no wasm — so `tests/portal_clip.test.mjs` can exercise every
// rule directly and so the two consumers (cells.js `tickPortalPunch`,
// cells.js `tickCellVisibility3D`) share ONE implementation of each rule.
//
// ─────────────────────────────────────────────────────────────────────────
// RETAIL GROUNDING (verified in the decomp + the 2026-08-04 C++ drop)
// ─────────────────────────────────────────────────────────────────────────
// `D3DPolyRender::DrawPortalPolyInternal` (acclient.c:453882) is the routine
// our `portal_punch.js` ports. Read verbatim, it does FOUR things before it
// ever touches the depth buffer — our port did only the last one:
//
//   1. DEGENERATE-BOUNDARY REJECT (acclient.c:453918-453931). If every vertex
//      of the polygon sits on x == ±12 or y == ±12 — the LandCell wall planes
//      of AC's 24 m outdoor cell grid — the polygon is a cell-boundary artifact
//      and the whole draw is skipped.
//   2. `ACRender::polyClipFinish(scrBuf, num_pts, scrBufclipped, &clip_pts, 0)`
//      (acclient.c:453942) — the SCREEN-SPACE CLIP. `if (clip_pts >= 3)` gates
//      everything below it, so a polygon that clips away to nothing draws
//      nothing. THIS is the guard our port is missing: with no clip, a polygon
//      straddling the near plane projects to garbage covering the viewport.
//   3. Only then `SetDepthBufferMode(DEPTHTEST_ALWAYS, …)` + the depth write.
//      Retail really does use DEPTHTEST_ALWAYS — the punch is NOT depth-tested
//      against the scene. Its bound is the CLIP (2), not an occlusion test.
//   4. The depth VALUE is chosen by the `zClear` argument via `maxZ1`/`maxZ2`
//      (acclient.c:45770-45771 = 7 / 6; `v12 = v2 & 1` at :454009):
//        zClear=1 → maxZ1=7 → z = 0.99999899  (FAR PUNCH)
//        zClear=0 → maxZ2=6 → z = zw/w        (the polygon's TRUE depth: a
//                                              SEAL, not a punch)
//      Colour alpha is forced to 0 in both cases (`~(v2 << 30) & 0x80000000`),
//      so the poly is a pure depth write.
//
// And the caller adds a fifth gate we also lacked — `PView::ConstructView`
// (acclient.c:462507-462543) SIDEDNESS-rejects the portal before any of this:
// it dots the camera against the portal plane and returns 0 unless the sign
// matches `outside_portal->portal_side`. Our wire format
// (`getVisiblePortalApertures`) does not carry `portal_side`, so we cannot
// port that test verbatim; `terrainRayBlocked` below is the substitute that
// covers the case the 2026-07-06 blackout actually reported ("an aperture
// behind a hill").
//
// ─────────────────────────────────────────────────────────────────────────
// COORDINATES
// ─────────────────────────────────────────────────────────────────────────
// Aperture vertices are AC world coords (Z-up), exactly as
// `SessionHandle.getVisiblePortalApertures` emits them. `mvp` is the
// column-major 16-float AC→clip matrix cells.js already composes
// (`projection · viewInverse · worldRoot.matrixWorld`), i.e. the same layout
// as `THREE.Matrix4.elements`. Screen rects come back in the GL convention:
// [0,1] with y INCREASING UPWARD, ready for `renderer.setScissor`.

/**
 * Near-plane clip margin, metres in front of the camera. Must exceed the
 * three.js camera near plane (0.1) with room for fp slop — a vertex that
 * survives this is guaranteed to project to a finite, sane clip-space point.
 */
export const PUNCH_NEAR_MARGIN_M = 0.25;

/**
 * Per-aperture screen-area sanity clamp. A real door/window never covers
 * essentially the whole viewport in BOTH axes; a polygon that projects that
 * large after clipping is degenerate (mirrored winding, NaN vertex, a portal
 * quad the size of a landblock). Rejecting it is what makes the 2026-07-06
 * whole-world blackout structurally impossible rather than merely unlikely.
 */
export const PUNCH_MAX_SCREEN_FRAC = 0.9;

/**
 * Plane-distance band, in metres, within which the viewer counts as CROSSING an
 * aperture and the punch drops it (DEFECT 2, round 4). ~player capsule radius
 * plus slop, so it covers the whole doorway transition.
 */
export const APERTURE_STRADDLE_EPS_M = 1.5;

/**
 * Minimum distance (metres) the owning cell's centre must sit off an aperture's
 * plane before the sidedness gate trusts its own orientation. Below this the
 * gate fails OPEN. See `facesAwayWithPlane` for why this guard exists.
 */
export const SIDEDNESS_MIN_INWARD_M = 0.75;

/**
 * Keep-band for the sidedness gate: the viewer must be at least this far onto
 * the INWARD side before an aperture is dropped.
 */
export const SIDEDNESS_DROP_MARGIN_M = 0.5;

/** Samples taken along a camera→aperture ray by `terrainRayBlocked`. */
export const TERRAIN_LOS_SAMPLES = 12;

/**
 * Camera movement, in metres, that invalidates every cached terrain-LOS
 * verdict. The LOS gate answers "does a hill stand between the camera and this
 * doorway"; that answer is a property of the (camera cell, doorway) pair, not
 * of the exact sub-metre camera position, so re-deriving it every frame from a
 * standing or slowly-turning camera is pure waste. 0.75 m is under a walking
 * step, so a verdict can never survive a meaningful change of vantage.
 */
export const LOS_CACHE_CAM_MOVE_M = 0.75;

/**
 * Hard ceiling, in frames, on how long a cached verdict may be reused while the
 * camera holds still. Bounds the one case a pure movement threshold cannot see:
 * terrain STREAMING IN under a stationary camera. `terrainRayBlocked` fails
 * open on an unbaked landblock, so a verdict taken mid-bake reads "clear"; this
 * makes it re-derive within ~0.5 s at 60 Hz instead of never.
 */
export const LOS_CACHE_MAX_AGE_FRAMES = 30;

/**
 * Allocate the caller-owned cache `clipAperturesForPunch` uses for its terrain
 * line-of-sight verdicts. Caller-owned (rather than module-global) on purpose:
 * the unit tests and any second consumer stay completely unaffected by it —
 * omit `opts.losCache` and the LOS gate runs exactly as it always did.
 */
export function makeLosCache() {
  return { camX: NaN, camY: NaN, camZ: NaN, gen: 0, m: new Map() };
}

/**
 * Collision-free-enough integer key for an aperture, from its RAW (camera-
 * independent) centroid quantised to 0.25 m. Returns -1 when the centroid falls
 * outside the AC world box, in which case the caller skips the cache and
 * computes the verdict directly.
 *
 * The packing keeps the result a safe integer: qx (≤ 2^18) << 31, qy (≤ 2^18)
 * << 13, qz (≤ 2^13) — max ≈ 4.2e14, well inside 2^53.
 */
function losKey(cx, cy, cz) {
  const qx = Math.round(cx * 4);
  const qy = Math.round(cy * 4);
  const qz = Math.round((cz + 1024) * 4);
  if (!(qx >= 0 && qx < 262144) || !(qy >= 0 && qy < 262144)) return -1;
  if (!(qz >= 0 && qz < 8192)) return -1;
  return qx * 2147483648 + qy * 8192 + qz;
}

/**
 * Clearance, in metres, a camera→aperture ray must keep above the terrain
 * surface before `terrainRayBlocked` calls it occluded. Generous on purpose:
 * a false "blocked" only costs us the reveal through that doorway (the
 * pre-fix behaviour), while a false "clear" is what over-punches.
 */
export const TERRAIN_LOS_CLEARANCE_M = 0.5;

/**
 * Build the AC-world-space near plane `{ nx, ny, nz, d }` such that a point
 * `v` is in front of the camera iff `nx*vx + ny*vy + nz*vz + d > 0`.
 *
 * @param {{x:number,y:number,z:number}} camAc  camera position, AC world coords
 * @param {{x:number,y:number,z:number}} fwdAc  camera forward, AC world coords
 *                                              (need not be normalised)
 * @param {number} [marginM=PUNCH_NEAR_MARGIN_M]
 * @returns {{nx:number,ny:number,nz:number,d:number}|null} null on a
 *          degenerate/zero forward vector (caller should skip the punch).
 */
export function makeNearPlane(camAc, fwdAc, marginM = PUNCH_NEAR_MARGIN_M) {
  if (!camAc || !fwdAc) return null;
  const len = Math.hypot(fwdAc.x, fwdAc.y, fwdAc.z);
  if (!Number.isFinite(len) || len < 1e-6) return null;
  const nx = fwdAc.x / len;
  const ny = fwdAc.y / len;
  const nz = fwdAc.z / len;
  // Plane passes through camAc + margin * n  →  d = -dot(n, camAc + margin*n)
  const px = camAc.x + nx * marginM;
  const py = camAc.y + ny * marginM;
  const pz = camAc.z + nz * marginM;
  return { nx, ny, nz, d: -(nx * px + ny * py + nz * pz) };
}

function planeDist(plane, x, y, z) {
  return plane.nx * x + plane.ny * y + plane.nz * z + plane.d;
}

/**
 * Sutherland–Hodgman clip of one convex polygon against one plane, in AC
 * world space. The retail analogue is `ACRender::polyClipFinish`
 * (acclient.c:453942), which clips in SCREEN space; clipping in world space
 * here means the output is still AC world vertices, so `portal_punch.js`
 * keeps building its mesh exactly as before and the shader still does the
 * projection. Same result, one fewer coordinate system to get wrong.
 *
 * @param {number[]} pts flat [x,y,z, …] (>= 3 vertices)
 * @param {{nx:number,ny:number,nz:number,d:number}} plane
 * @returns {number[]} flat clipped polygon, `[]` when fully behind the plane.
 */
export function clipPolygonAgainstPlane(pts, plane) {
  const n = (pts.length / 3) | 0;
  if (n < 3) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[i * 3], ay = pts[i * 3 + 1], az = pts[i * 3 + 2];
    const bx = pts[j * 3], by = pts[j * 3 + 1], bz = pts[j * 3 + 2];
    const da = planeDist(plane, ax, ay, az);
    const db = planeDist(plane, bx, by, bz);
    if (da >= 0) out.push(ax, ay, az);
    // Straddling edge → emit the intersection point.
    if ((da >= 0) !== (db >= 0)) {
      const denom = da - db;
      if (Math.abs(denom) > 1e-9) {
        const t = da / denom;
        out.push(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
      }
    }
  }
  return out.length >= 9 ? out : [];
}

/**
 * Retail's degenerate-boundary reject (acclient.c:453918-453931): a polygon
 * whose vertices ALL share x == +12, or all x == -12, or all y == +12, or all
 * y == -12 lies flat on an outdoor LandCell wall plane and is skipped. Our
 * aperture vertices are LANDBLOCK-frame (the wasm adds the LB corner offset),
 * so the retail literal ±12 becomes "the coordinate is an exact multiple of
 * 24 offset by 12" — i.e. the local coordinate within the 24 m cell is ±12.
 *
 * @param {number[]} pts flat [x,y,z, …]
 * @returns {boolean} true when the polygon should be skipped.
 */
export function isLandCellBoundaryPoly(pts) {
  const n = (pts.length / 3) | 0;
  if (n < 3) return false;
  const EPS = 1e-3;
  let allXWall = true;
  let allYWall = true;
  const xRef = wallOffset(pts[0]);
  const yRef = wallOffset(pts[1]);
  if (xRef === null) allXWall = false;
  if (yRef === null) allYWall = false;
  for (let i = 0; i < n && (allXWall || allYWall); i++) {
    if (allXWall) {
      const o = wallOffset(pts[i * 3]);
      if (o === null || Math.abs(o - xRef) > EPS) allXWall = false;
    }
    if (allYWall) {
      const o = wallOffset(pts[i * 3 + 1]);
      if (o === null || Math.abs(o - yRef) > EPS) allYWall = false;
    }
  }
  return allXWall || allYWall;

  // Distance from the nearest 24 m LandCell wall plane, or null when the
  // coordinate is not on one. Walls sit at multiples of 24 (cell corners) —
  // retail's ±12 literals are the CELL-LOCAL form of the same planes.
  function wallOffset(v) {
    if (!Number.isFinite(v)) return null;
    const m = v - Math.floor(v / 24) * 24;
    if (Math.abs(m) < EPS) return 0;
    if (Math.abs(m - 24) < EPS) return 0;
    return null;
  }
}

/**
 * Project an AC-world polygon through `mvp` and return its screen-space AABB
 * in the GL convention ([0,1], y up), or null when any vertex fails to
 * project (w <= 0 — which cannot happen after `clipPolygonAgainstPlane`, but
 * is checked because a NaN vertex from a corrupt snapshot must not become a
 * full-screen rect).
 *
 * @param {number[]} pts flat [x,y,z, …]
 * @param {ArrayLike<number>} e column-major 16-float AC→clip matrix
 * @returns {{x0:number,y0:number,x1:number,y1:number}|null}
 */
export function projectScreenRect(pts, e) {
  const n = (pts.length / 3) | 0;
  if (n < 3 || !e || e.length !== 16) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (!(cw > 1e-6) || !Number.isFinite(cw)) return null;
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    const sx = (cx / cw + 1) * 0.5;
    const sy = (cy / cw + 1) * 0.5;
    if (sx < x0) x0 = sx;
    if (sx > x1) x1 = sx;
    if (sy < y0) y0 = sy;
    if (sy > y1) y1 = sy;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Terrain line-of-sight test — the substitute for retail's
 * `PView::ConstructView` sidedness reject (acclient.c:462513-462543), which we
 * cannot port verbatim because `getVisiblePortalApertures` does not carry
 * `portal_side`. Marches the camera→target segment in AC world space and
 * reports whether the terrain heightfield rises above it anywhere.
 *
 * This is the ONLY per-aperture occlusion gate that is both cheap and honest:
 * a real depth test cannot be used here, because the very bug being fixed is
 * "terrain wrongly wins depth in front of the interior" — testing the aperture
 * against that same depth buffer would reject exactly the apertures we need
 * to punch. Terrain is also the occluder the 2026-07-06 report named ("sits
 * behind a hill").
 *
 * @param {(x:number,y:number)=>(number|null|undefined)} sampleHeight
 *        AC world (x,y) → terrain Z, or null/undefined when the landblock
 *        isn't baked. UNKNOWN SAMPLES DO NOT BLOCK (fail-open): an unbaked LB
 *        must never suppress a doorway the player can plainly see.
 * @returns {boolean} true when terrain occludes the segment.
 */
export function terrainRayBlocked(
  sampleHeight,
  ax, ay, az,
  bx, by, bz,
  samples = TERRAIN_LOS_SAMPLES,
  clearanceM = TERRAIN_LOS_CLEARANCE_M,
) {
  if (typeof sampleHeight !== "function") return false;
  const n = Math.max(2, samples | 0);
  // Skip the endpoints: the camera may legitimately be under the surface
  // (that IS case (a)), and the aperture itself may be below grade (that IS
  // the bug). Only the span BETWEEN them can prove a hill is in the way.
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const z = az + (bz - az) * t;
    let h;
    try {
      h = sampleHeight(x, y);
    } catch (_) {
      return false; // sampler threw → fail open
    }
    if (h == null || !Number.isFinite(h)) continue; // unbaked → fail open
    if (h > z + clearanceM) return true;
  }
  return false;
}

/**
 * Is the camera below the terrain surface at its own (x, y)?
 *
 * This is the arm predicate for the indoor depth split. It is the exact
 * condition under which the shared-depth world pass can go wrong: a terrain
 * heightfield ABOVE the camera surrounds it, so terrain triangles are nearer
 * than the room's own walls/floor in every horizontal direction and win the
 * depth test — which is what "terrain draws over building interiors that sit
 * below the terrain surface" means, pixel for pixel.
 *
 * It is also the precise anti-regression for the 2026-05-29 see-through:
 * standing on a Holtburg building plot (an EnvCell, so `isCurrentCellIndoor()`
 * is true) the camera is ABOVE the terrain, so this returns false and the
 * split never arms. Only a camera genuinely under the surface — i.e. actually
 * inside a below-grade interior — arms it.
 *
 * Fails CLOSED (returns false, no split) when the height is unknown: an
 * unbaked landblock must not flip the renderer into the split path.
 *
 * @param {(x:number,y:number)=>(number|null|undefined)} sampleHeight
 * @param {number} camZ camera AC-world Z
 * @param {number} [marginM=0.5] how far below the surface before we call it
 *        "below" (a camera skimming the surface is not enclosed by it).
 */
export function isCameraBelowTerrain(sampleHeight, camX, camY, camZ, marginM = 0.5) {
  if (typeof sampleHeight !== "function") return false;
  if (!Number.isFinite(camX) || !Number.isFinite(camY) || !Number.isFinite(camZ)) {
    return false;
  }
  let h;
  try {
    h = sampleHeight(camX, camY);
  } catch (_) {
    return false;
  }
  if (h == null || !Number.isFinite(h)) return false;
  return camZ < h - marginM;
}

/**
 * Newell-normal plane of a polygon, as `{nx, ny, nz, d}` with the plane
 * satisfying `nx*x + ny*y + nz*z + d = 0` through the polygon's centroid.
 * Returns null for a degenerate (zero-area / collinear) polygon.
 *
 * Newell rather than a single cross product because AC portal quads are not
 * always perfectly planar and a two-edge cross product can come back
 * near-zero on a sliver triangle.
 *
 * @param {number[]} pts flat [x,y,z, …]
 */
export function polygonPlane(pts) {
  const n = (pts.length / 3) | 0;
  if (n < 3) return null;
  let nx = 0, ny = 0, nz = 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[i * 3], ay = pts[i * 3 + 1], az = pts[i * 3 + 2];
    const bx = pts[j * 3], by = pts[j * 3 + 1], bz = pts[j * 3 + 2];
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
    cx += ax; cy += ay; cz += az;
  }
  const len = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(len) || len < 1e-9) return null;
  nx /= len; ny /= len; nz /= len;
  cx /= n; cy /= n; cz /= n;
  return { nx, ny, nz, d: -(nx * cx + ny * cy + nz * cz), cx, cy, cz };
}

/**
 * DEFECT 2 (2026-08-04 round 4) — the doorway TRANSITION leak.
 *
 * Reported: standing fully outside is clean and standing fully inside is
 * clean, but while CROSSING a doorway "an env cell under terrain appears
 * visible through terrain". That is the viewer sitting ON the aperture plane:
 * the punch stamps far-Z through a doorway the camera has effectively already
 * passed, so interior cells behind it win depth over terrain that should still
 * occlude them.
 *
 * Retail rejects this in `PView::ConstructView` (acclient.c:462513-462543): it
 * dots the viewer against the portal plane and returns 0 unless the sign
 * matches `outside_portal->portal_side` — so an aperture the viewer has
 * crossed is never drawn. We cannot port that test verbatim (our wire format
 * carries no `portal_side`, and polygon winding does not reliably tell us
 * which face is "outside"), so this is the SIDE-AGNOSTIC half of it: drop the
 * aperture whenever the viewer is within `epsM` of its plane AND laterally
 * within the doorway's own extent. Both conditions are required — being 0.5 m
 * from the *infinite plane* of a doorway 40 m down the street must not drop
 * that doorway.
 *
 * Side-agnostic is the safe direction: it drops the aperture for the handful
 * of frames spent in the doorway (interiors simply fall back to the ordinary
 * occluded draw for that instant, which the user already reports as clean) and
 * cannot mistakenly drop a doorway being looked at from across a room.
 *
 * @param {number[]} pts flat [x,y,z, …] AC world-space aperture polygon
 * @param {{x:number,y:number,z:number}} camAc viewer position, AC world
 * @param {number} [epsM=1.5] plane-distance band that counts as "crossing"
 *        (~player capsule radius + slop, so it covers the whole transition)
 * @returns {boolean} true when the aperture must be dropped this frame
 */
export function apertureStraddlesViewer(pts, camAc, epsM = 1.5) {
  if (!pts || !camAc) return false;
  return straddlesViewerWithPlane(polygonPlane(pts), pts, camAc, epsM);
}

/**
 * `apertureStraddlesViewer` with the polygon plane supplied by the caller.
 * `clipAperturesForPunch` needs the same plane for the sidedness reject, and
 * `polygonPlane` is an O(nverts) Newell accumulation — computing it once per
 * aperture instead of once per predicate halves that work in the hot loop.
 */
function straddlesViewerWithPlane(pl, pts, camAc, epsM) {
  if (!pl || !pts || !camAc) return false;
  const dist = pl.nx * camAc.x + pl.ny * camAc.y + pl.nz * camAc.z + pl.d;
  if (!Number.isFinite(dist) || Math.abs(dist) > epsM) return false;
  // Lateral test: is the viewer actually IN this doorway, or merely near the
  // infinite plane it happens to lie on? Compare the distance from the
  // polygon centroid against the polygon's own bounding radius plus the same
  // epsilon, which is cheap and never under-covers a real door.
  let r2 = 0;
  const n = (pts.length / 3) | 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 3] - pl.cx;
    const dy = pts[i * 3 + 1] - pl.cy;
    const dz = pts[i * 3 + 2] - pl.cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  const reach = Math.sqrt(r2) + epsM;
  const ex = camAc.x - pl.cx;
  const ey = camAc.y - pl.cy;
  const ez = camAc.z - pl.cz;
  return ex * ex + ey * ey + ez * ez <= reach * reach;
}

/**
 * DEFECT (round 5) — doors on the FAR side of a building drawn THROUGH it.
 *
 * With `?portalPunch` on, a far-side doorway is still frustum-visible and still
 * passes the terrain line-of-sight test (a building is not terrain), so it got
 * depth-punched: far-Z was stamped where the near wall stands, and the door
 * entity behind it then won the depth test. Retail never does this because
 * `PView::ConstructView` (acclient.c:462513-462543) SIDEDNESS-rejects the
 * portal first — it dots the viewer against the portal plane and bails unless
 * the sign matches `outside_portal->portal_side`.
 *
 * We could not port that while the wire format carried only a bare polygon:
 * winding does not reliably say which face is "outside". The round-5 wasm
 * export `getVisiblePortalAperturesWithCellCenter` supplies the owning cell's
 * AABB centre, which resolves it unambiguously — the aperture is a hole in that
 * room's shell, so OUTWARD is simply "away from the room centre". Orient the
 * Newell normal with that, and keep the aperture only when the viewer stands on
 * the outward side.
 *
 * @param {number[]} pts flat [x,y,z, …] AC world-space aperture polygon
 * @param {{x,y,z}} cellCenter owning cell's AABB centre, AC world
 * @param {{x,y,z}} camAc viewer position, AC world
 * @param {number} [marginM=0] tolerance; positive keeps grazing apertures
 * @returns {boolean} true when the viewer is BEHIND the aperture (drop it)
 */
export function apertureFacesAway(pts, cellCenter, camAc, marginM = 0) {
  if (!pts || !cellCenter || !camAc) return false;
  return facesAwayWithPlane(polygonPlane(pts), cellCenter, camAc, marginM);
}

/** `apertureFacesAway` with a caller-supplied plane — see straddlesViewerWithPlane. */
function facesAwayWithPlane(pl, cellCenter, camAc, marginM) {
  if (!pl || !cellCenter || !camAc) return false;
  // Orient the normal to point OUT of the owning room: `inward` is how far the
  // room's centre lies on the Newell-normal side of the aperture plane.
  const inward =
    pl.nx * (cellCenter.x - pl.cx) +
    pl.ny * (cellCenter.y - pl.cy) +
    pl.nz * (cellCenter.z - pl.cz);

  // ── ORIENTATION-CONFIDENCE GUARD (2026-08-04 round 7) ───────────────────
  // THE ROUND-5 REGRESSION. The whole gate rests on `sign(inward)` telling us
  // which side of the doorway is "inside the room". That is only meaningful
  // when the room's centre is CLEARLY off the aperture plane. It frequently is
  // not: the cell centre we get from wasm is an AABB centre, and for a doorway
  // in a long wall it lands close to that wall's plane, while for an L-shaped
  // or multi-part cell the AABB centre can fall OUTSIDE the room altogether —
  // even on the far side of the doorway. In both cases `inward` is ~0 or
  // outright wrong-signed, the outward normal flips, and the gate drops the
  // very doorway the player is looking at. That is exactly the reported
  // regression: the outdoor punch stopped revealing sunken interiors.
  //
  // So: only trust the orientation when the room centre is at least
  // SIDEDNESS_MIN_INWARD_M off the plane. Below that, FAIL OPEN (keep the
  // aperture) — an over-punch is a visual artifact, a wrongly-dropped aperture
  // is the feature not working at all.
  if (!Number.isFinite(inward) || Math.abs(inward) < SIDEDNESS_MIN_INWARD_M) {
    return false;
  }
  const sgn = inward > 0 ? -1 : 1; // flip when the Newell normal points inward
  const dist =
    sgn * (pl.nx * (camAc.x - pl.cx) + pl.ny * (camAc.y - pl.cy) + pl.nz * (camAc.z - pl.cz));
  if (!Number.isFinite(dist)) return false;
  // Drop only when the viewer is CLEARLY on the inward side. `marginM` widens
  // the keep-band, so a viewer near the plane is kept, not culled.
  return dist < -marginM;
}

/**
 * Does a baked buildings/statics scene node belong to landblock `lbKey`?
 *
 * Used by the `?indoorDepthSplit` re-layering (cells.js `_stampSplitLayers`) to
 * hoist ONLY the player's own landblock past the depth clear. Lives here rather
 * than in cells.js so it is unit-testable without pulling in THREE.
 *
 * The baked path offers PER-LANDBLOCK granularity, not per-cell: top-level
 * children carry `userData.landblockId` (buildings.js:490, statics.js:1257,
 * static_batch_x:1758), while merged instanced statics carry `coversLbKeys`
 * (statics.js:1444) and may span several LBs.
 *
 * FAILS CLOSED on an untagged node (returns false → the node stays on layer 0
 * and keeps its terrain occlusion). Leaving a node behind means the original
 * bug persists for it — no NEW artifact — whereas hoisting an unknown
 * world-spanning merged batch past the depth clear would manufacture a fresh
 * see-through.
 *
 * @param {{userData?:object}|null} node
 * @param {number} lbKey landblock key (`cellId & 0xffff0000`)
 */
export function nodeInLandblock(node, lbKey) {
  const ud = node?.userData;
  if (!ud) return false;
  // `x & 0xffff0000` yields a SIGNED int32 in JS (0xffff0000 has the top bit
  // set), so the `>>> 0` on BOTH sides is load-bearing — without it a landblock
  // key above 0x8000_0000 compares negative-vs-unsigned and never matches.
  const want = ((lbKey >>> 0) & 0xffff0000) >>> 0;
  if (ud.landblockId != null) {
    return (((ud.landblockId >>> 0) & 0xffff0000) >>> 0) === want;
  }
  const covers = ud.coversLbKeys;
  if (Array.isArray(covers)) {
    for (const k of covers) {
      if ((((k >>> 0) & 0xffff0000) >>> 0) === want) return true;
    }
  }
  return false;
}

/**
 * The whole per-frame aperture pipeline for `?portalPunch`, in retail's own
 * order: boundary reject → near-plane clip → screen-rect + area clamp →
 * terrain LOS. Returns the surviving apertures in the SAME flat wire shape
 * `PortalPunchPass.setApertures` already consumes, plus the union scissor
 * rect that bounds the punch to the doorways it kept.
 *
 * @param {ArrayLike<number>|null} flat `[count, (nv, x,y,z ×nv) × count]`
 * @param {ArrayLike<number>} mvp column-major 16-float AC→clip
 * @param {object} opts
 * @param {{nx,ny,nz,d}} opts.nearPlane        from `makeNearPlane`
 * @param {{x,y,z}} opts.camAc                 camera position, AC world
 * @param {Function} [opts.sampleHeight]       terrain sampler (optional)
 * @param {number} [opts.maxScreenFrac]
 * @returns {{flat:number[], rect:{x0,y0,x1,y1}|null, kept:number, dropped:object}}
 */
/**
 * Per-aperture vertex scratch, reused across apertures AND frames. Nothing in
 * the loop retains `pts` past its own iteration (`clipPolygonAgainstPlane`
 * builds a fresh output array), so one buffer is enough — and it removes the
 * per-aperture `new Array(nv*3)` from a function that runs every frame.
 */
const _ptsScratch = [];

export function clipAperturesForPunch(flat, mvp, opts = {}) {
  const dropped = { boundary: 0, backface: 0, straddle: 0, nearPlane: 0, project: 0, oversize: 0, terrain: 0 };
  const empty = { flat: [0], rect: null, kept: 0, dropped };
  if (!flat || flat.length < 1 || !mvp || mvp.length !== 16) return empty;
  const nearPlane = opts.nearPlane;
  if (!nearPlane) return empty;
  const camAc = opts.camAc;
  const sampleHeight = opts.sampleHeight;
  const maxFrac = Number.isFinite(opts.maxScreenFrac)
    ? opts.maxScreenFrac
    : PUNCH_MAX_SCREEN_FRAC;
  const straddleEps = Number.isFinite(opts.straddleEpsM)
    ? opts.straddleEpsM
    : APERTURE_STRADDLE_EPS_M;
  const withCellCenter = !!opts.withCellCenter;
  // Caller-owned terrain-LOS memo (see `makeLosCache`). Absent → every gate
  // runs exactly as before, which is what the unit tests exercise.
  const losCache = opts.losCache ?? null;
  if (losCache && camAc) {
    const dx = camAc.x - losCache.camX;
    const dy = camAc.y - losCache.camY;
    const dz = camAc.z - losCache.camZ;
    const moved =
      !(Number.isFinite(losCache.camX)) ||
      dx * dx + dy * dy + dz * dz > LOS_CACHE_CAM_MOVE_M * LOS_CACHE_CAM_MOVE_M;
    if (moved) {
      losCache.m.clear();
      losCache.camX = camAc.x;
      losCache.camY = camAc.y;
      losCache.camZ = camAc.z;
    }
    losCache.gen = (losCache.gen | 0) + 1;
  }

  let k = 0;
  const count = flat[k++] | 0;
  if (count <= 0) return empty;

  const out = [0];
  let kept = 0;
  let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;

  for (let a = 0; a < count; a++) {
    const nv = flat[k++] | 0;
    // `withCellCenter`: the round-5 wire shape inserts the owning cell's AABB
    // centre after `nverts`. Absent (stale pkg on the v1 export) → no sidedness
    // reject, i.e. exactly the round-4 behaviour.
    let cc = null;
    if (withCellCenter) {
      cc = { x: flat[k], y: flat[k + 1], z: flat[k + 2] };
      k += 3;
    }
    const start = k;
    k += nv * 3;
    if (nv < 3 || k > flat.length) continue;

    // Scratch, not a fresh Array per aperture per frame: every consumer below
    // only reads `pts` by index and `pts.length`, and nothing retains it.
    const pts = _ptsScratch;
    pts.length = nv * 3;
    for (let i = 0; i < nv * 3; i++) pts[i] = flat[start + i];

    // The Newell plane is needed by BOTH sidedness gates (and its centroid is
    // the cache key for the terrain gate). Compute it once per aperture.
    const plane = polygonPlane(pts);

    // 0. retail ConstructView sidedness reject — the viewer must be on the
    //    OUTWARD side of the aperture. Stops a far-side door being punched
    //    through the near wall. Requires the cell centre; skipped without it.
    //    Cheapest real gate, so it stays first: a handful of multiply-adds,
    //    and in a town it rejects roughly half the offered apertures before
    //    anything else in this loop touches them.
    if (cc && camAc && facesAwayWithPlane(plane, cc, camAc, 0)) {
      dropped.backface++;
      continue;
    }

    // 1. retail DrawPortalPolyInternal degenerate-boundary reject.
    if (isLandCellBoundaryPoly(pts)) {
      dropped.boundary++;
      continue;
    }

    // 1b. DEFECT 2 (round 4) — viewer-crossing reject, the side-agnostic half
    //     of retail's `ConstructView` sidedness test (acclient.c:462513-462543).
    //     Runs on the RAW polygon, before the near-plane clip, because a
    //     doorway the camera is standing in is exactly the one the clip would
    //     otherwise trim to a sliver and still punch.
    if (camAc && straddlesViewerWithPlane(plane, pts, camAc, straddleEps)) {
      dropped.straddle++;
      continue;
    }

    // 2. retail polyClipFinish — near-plane clip (NOT a whole-aperture drop:
    //    the visible half of a doorway you are walking through still punches).
    const clipped = clipPolygonAgainstPlane(pts, nearPlane);
    if (clipped.length < 9) {
      dropped.nearPlane++;
      continue;
    }

    // 3. `if (clip_pts >= 3)` — plus the screen-area sanity clamp that makes
    //    a degenerate poly physically unable to blank the frame.
    const rect = projectScreenRect(clipped, mvp);
    if (!rect) {
      dropped.project++;
      continue;
    }
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    if (!(w > 0) || !(h > 0) || (w >= maxFrac && h >= maxFrac)) {
      dropped.oversize++;
      continue;
    }

    // 4. terrain line-of-sight (stand-in for ConstructView sidedness).
    //    LAST on purpose — it is by far the most expensive gate in this loop:
    //    TERRAIN_LOS_SAMPLES-1 = 11 `terrainHeightAt` calls, each a JS→wasm
    //    boundary crossing plus a RefCell borrow and a HashMap lookup. With
    //    `opts.losCache` supplied the verdict is memoised per DOORWAY (keyed on
    //    the raw, camera-independent centroid) and only re-derived when the
    //    camera has actually moved or the entry has aged out — so a standing or
    //    panning camera pays nothing here at all.
    if (sampleHeight && camAc) {
      let cx = 0, cy = 0, cz = 0;
      const cn = (clipped.length / 3) | 0;
      for (let i = 0; i < cn; i++) {
        cx += clipped[i * 3];
        cy += clipped[i * 3 + 1];
        cz += clipped[i * 3 + 2];
      }
      cx /= cn; cy /= cn; cz /= cn;
      let blocked;
      const key = losCache && plane ? losKey(plane.cx, plane.cy, plane.cz) : -1;
      const hit = key >= 0 ? losCache.m.get(key) : undefined;
      if (hit !== undefined && losCache.gen < hit.expire) {
        blocked = hit.v;
      } else {
        blocked = terrainRayBlocked(sampleHeight, camAc.x, camAc.y, camAc.z, cx, cy, cz);
        if (key >= 0) {
          // Stagger the expiry across doorways (the low bits of the key are the
          // quantised height, which differs per aperture) so a set that entered
          // view together does not all re-derive on one frame.
          losCache.m.set(key, {
            v: blocked,
            expire: losCache.gen + LOS_CACHE_MAX_AGE_FRAMES + (key % 13),
          });
        }
      }
      if (blocked) {
        dropped.terrain++;
        continue;
      }
    }

    out.push(clipped.length / 3);
    for (let i = 0; i < clipped.length; i++) out.push(clipped[i]);
    kept++;
    if (rect.x0 < rx0) rx0 = rect.x0;
    if (rect.y0 < ry0) ry0 = rect.y0;
    if (rect.x1 > rx1) rx1 = rect.x1;
    if (rect.y1 > ry1) ry1 = rect.y1;
  }

  out[0] = kept;
  if (!kept) return { flat: [0], rect: null, kept: 0, dropped };
  return {
    flat: out,
    rect: {
      x0: Math.max(0, Math.min(1, rx0)),
      y0: Math.max(0, Math.min(1, ry0)),
      x1: Math.max(0, Math.min(1, rx1)),
      y1: Math.max(0, Math.min(1, ry1)),
    },
    kept,
    dropped,
  };
}
