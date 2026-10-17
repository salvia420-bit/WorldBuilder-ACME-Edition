// scene3d/interior_aperture_cull.js — don't draw an interior room from outside
// unless a door or window it could be seen through is in view
// (`?interiorApertureCull`, DEFAULT ON; `=off` escape; `=noside` drops only the
// sidedness half). Perf 2026-10-17 (outdoor fps wave 1, card "interiors").
//
// WHY. From an outdoor camera the wasm render set (`getRenderSetWithFrustum`'s
// outdoor branch) admits interior cells by AABB alone: every frustum-visible
// cell with an outdoor exit, plus — under ?stablist — every frustum-visible
// SeenOutside cell, unclipped. ?occlusionCull then drops the ones whose box put
// no sample on screen, but a box that peeks past a shell edge, through a gap or
// a translucent surface, or that is still inside its 3-24 frame hide delay,
// keeps its room drawn. MEASURED (GTX 1070, quality=ultra, LB 0xE632, player
// outdoors ~120 m from a multi-storey pagoda, 2026-10-17): interior rooms cost
// 141 world draws + 54 shadow draws a frame, ~1.6-1.9 ms GPU; hiding every
// interior was +3.3 fps (26.1 → 29.5). That is the UPPER bound of this cull:
// rooms really visible through an open door or window stay drawn.
//
// RETAIL. An outdoor camera reaches interior cells ONLY through a building's
// portal polygons: `RenderDeviceD3D::DrawBuilding` (acclient.c:456933) →
// `BSPTREE::build_draw_portals_only` → `PView::DrawPortal` (:462565) →
// `PView::ConstructView(CBldPortal*, CPolygon*, …)` (:462507), which rejects
// the portal on SIDEDNESS (:462513-462541 — the viewer must be on the outside
// of the aperture plane) and on an empty `PView::GetClip` (:462542 — the
// aperture must project on screen), and only then floods the interior inward
// (`ConstructView(CEnvCell*, …)`, :462423), each room clipped to the screen
// region of the portal it was reached through. So a room drawn from outside
// always lies, on screen, inside the projection of some front-facing on-screen
// aperture.
//
// WHAT. That containment is a NECESSARY condition we can test cheaply without
// the building-portal data (BLDPORTAL-CONSUME, queued, Rust): each frame,
// outdoors, take the outdoor-facing apertures of the frustum-visible exit cells
// (`getVisiblePortalAperturesWithSidedness`, the punch's own feed — the
// EnvCell side of the same door/window polygons), keep those whose viewer is
// on the outside (`portal_side`, `apertureFacesAwayWithSide`, live-measured
// two-sided: 127 apertures / 0 bad) and that survive the near-plane clip, and
// take their screen rects. An interior cell whose (padded) screen rect touches
// none of them cannot be seen through any door or window → it leaves this
// frame's visible set, before the occlusion culler ever issues its query.
// Rects are conservative in both directions (a polygon's or a box's projection
// lies inside its rect), so a culled room was never visible through an
// aperture: the cull removes only what retail would not draw.
//
// SAFETY NETS (all keep the room drawn): the camera within
// `APERTURE_STRADDLE_EPS_M` of a doorway it is passing through (every room
// stays, so entering/leaving a building never pops — the viewer cell flips to
// the EnvCell and the indoor path takes over); the camera within
// `CELL_NEAR_GUARD_M` of a room's box; a box corner at/behind the camera (its
// rect is unbounded); a room whose bounds cannot be measured; the player's and
// the viewer's own cells; a stale pkg/ without the aperture export, or a throw
// (the gate steps aside for the frame).
//
// Live A/B seam: `window.__interiorApertureCull.off = true` (stats under
// `.stats`).

import {
  clipPolygonAgainstPlane,
  projectScreenRect,
  apertureStraddlesViewer,
  apertureFacesAwayWithSide,
  APERTURE_STRADDLE_EPS_M,
  SIDEDNESS_DROP_MARGIN_M,
} from "./portal_clip.js";

/** Screen-fraction pad on every aperture rect side (≈ 19 px at 1920 wide). */
export const APERTURE_RECT_PAD = 0.01;
/** Metres a cell box grows before projection (walls/door frames on its edge). */
export const CELL_BOX_PAD_M = 0.25;
/** Camera this close (m) to a cell's box keeps that cell drawn. */
export const CELL_NEAR_GUARD_M = 1.0;

/**
 * `?interiorApertureCull` → "on" (default) | "noside" | "off".
 * @param {string} [search] defaults to the page's query string
 */
export function readApertureCullMode(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = (new URLSearchParams(s).get("interiorApertureCull") || "").toLowerCase();
    if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
    if (v === "noside") return "noside";
    return "on";
  } catch (_) {
    return "on";
  }
}

const MODE = readApertureCullMode();
const ctl = { off: false };
const stats = {
  frames: 0,       // frames the gate ran
  skipped: "",     // why it last stepped aside ("" = it ran)
  offered: 0,      // apertures in the export (last frame)
  inView: 0,       // apertures that passed (last frame)
  away: 0,         // dropped: viewer inside the owning room's side
  behind: 0,       // dropped: clipped away by the near plane
  offscreen: 0,    // dropped: rect outside the viewport
  straddle: 0,     // frames the camera stood in a doorway (everything kept)
  candidates: 0,   // interior cells tested (last frame)
  culled: 0,       // interior cells removed (last frame)
  culledTotal: 0,  // cumulative
};

/** True when the gate should run at all (flag on, not switched off live). */
export function interiorApertureCullActive() {
  return MODE !== "off" && !ctl.off;
}

export function interiorApertureCullMode() {
  return MODE;
}

const _pts = [];

/**
 * Parse an aperture export and return the screen rects ([0,1], GL y-up) of the
 * apertures an interior can be seen through this frame.
 *
 * @param {ArrayLike<number>} flat `[count, (nverts, [cx,cy,cz], [side], verts…)×count]`
 * @param {ArrayLike<number>} mvp  AC world → clip, column-major (THREE layout)
 * @param {object} o
 * @param {{nx,ny,nz,d}} o.nearPlane  AC-space near plane (portal_clip makeNearPlane)
 * @param {{x,y,z}} o.camAc           camera, AC world
 * @param {boolean} [o.withCellCenter] the v2/v3 shape (centre floats present)
 * @param {boolean} [o.withPortalSide] the v3 shape (`portal_side` present)
 * @param {boolean} [o.sidedness=true] apply the `portal_side` reject (v3 only)
 * @param {number[]} [o.out] reusable output array (cleared)
 * @returns {{rects:number[], full:boolean, offered:number, inView:number,
 *            away:number, behind:number, offscreen:number}}
 *   `rects` packs x0,y0,x1,y1 per aperture. `full` = the camera is crossing an
 *   aperture: treat the whole screen as seen through a doorway.
 */
export function apertureViewRects(flat, mvp, o = {}) {
  const rects = o.out || [];
  rects.length = 0;
  const res = { rects, full: false, offered: 0, inView: 0, away: 0, behind: 0, offscreen: 0 };
  if (!flat || flat.length < 1 || !mvp || mvp.length !== 16 || !o.nearPlane || !o.camAc) return res;
  const withCellCenter = !!o.withCellCenter;
  const withPortalSide = !!o.withPortalSide;
  const sided = withPortalSide && o.sidedness !== false;
  const pad = APERTURE_RECT_PAD;
  let k = 0;
  const count = flat[k++] | 0;
  res.offered = Math.max(0, count);
  for (let a = 0; a < count; a++) {
    const nv = flat[k++] | 0;
    if (withCellCenter) k += 3;
    // Strict `=== 1`, as clipAperturesForPunch reads it: NaN / short buffer ≠ true.
    const portalSide = withPortalSide ? flat[k++] === 1 : false;
    const start = k;
    k += nv * 3;
    if (nv < 3 || k > flat.length) continue;
    _pts.length = nv * 3;
    for (let i = 0; i < nv * 3; i++) _pts[i] = flat[start + i];
    // Passing through this doorway: everything behind it may be on screen in
    // a frame or two and the viewer cell has not flipped yet — keep it all.
    if (apertureStraddlesViewer(_pts, o.camAc, APERTURE_STRADDLE_EPS_M)) {
      res.full = true;
      return res;
    }
    // Retail ConstructView sidedness: the viewer must be OUTSIDE the room the
    // aperture belongs to (a far-side door seen through the building is not a
    // way in). Keep-band SIDEDNESS_DROP_MARGIN_M so a grazing viewer keeps it.
    if (sided && apertureFacesAwayWithSide(_pts, portalSide, o.camAc, SIDEDNESS_DROP_MARGIN_M)) {
      res.away += 1;
      continue;
    }
    // Retail GetClip: the aperture must survive the near plane …
    const clipped = clipPolygonAgainstPlane(_pts, o.nearPlane);
    if (clipped.length < 9) {
      res.behind += 1;
      continue;
    }
    // … and land on screen.
    const r = projectScreenRect(clipped, mvp);
    if (!r || !(r.x1 >= 0 && r.x0 <= 1 && r.y1 >= 0 && r.y0 <= 1)) {
      res.offscreen += 1;
      continue;
    }
    rects.push(
      Math.max(0, r.x0) - pad,
      Math.max(0, r.y0) - pad,
      Math.min(1, r.x1) + pad,
      Math.min(1, r.y1) + pad,
    );
    res.inView += 1;
  }
  return res;
}

const _rect = [0, 0, 0, 0];

/**
 * Screen rect ([0,1], GL y-up) of an axis-aligned box through `vp`, into
 * `out`. Returns false when a corner sits at/behind the camera — the
 * projection is unbounded and the caller must keep the box.
 * @param {ArrayLike<number>} b  [minX,minY,minZ,maxX,maxY,maxZ] in vp's space
 * @param {ArrayLike<number>} e  column-major 4x4 (THREE layout)
 */
export function boxScreenRect(b, e, out = _rect) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? b[3] : b[0];
    const y = c & 2 ? b[4] : b[1];
    const z = c & 4 ? b[5] : b[2];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (!(w > 1e-4)) return false;
    const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) * 0.5;
    const sy = ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w + 1) * 0.5;
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;
    if (sx < x0) x0 = sx;
    if (sx > x1) x1 = sx;
    if (sy < y0) y0 = sy;
    if (sy > y1) y1 = sy;
  }
  out[0] = x0; out[1] = y0; out[2] = x1; out[3] = y1;
  return true;
}

/**
 * Can a room with box `b` (main-scene frame) be seen through any of `rects`?
 * @param {ArrayLike<number>} b   [minX,minY,minZ,maxX,maxY,maxZ], unshrunk
 * @param {ArrayLike<number>} vp  main-scene → clip (projection · view)
 * @param {{x,y,z}} cam           camera, main-scene frame
 * @param {number[]} rects        packed x0,y0,x1,y1 (apertureViewRects)
 */
export function cellSeenThroughApertures(b, vp, cam, rects) {
  const p = CELL_BOX_PAD_M;
  const g = p + CELL_NEAR_GUARD_M;
  if (cam.x > b[0] - g && cam.x < b[3] + g &&
      cam.y > b[1] - g && cam.y < b[4] + g &&
      cam.z > b[2] - g && cam.z < b[5] + g) return true;
  _box[0] = b[0] - p; _box[1] = b[1] - p; _box[2] = b[2] - p;
  _box[3] = b[3] + p; _box[4] = b[4] + p; _box[5] = b[5] + p;
  if (!boxScreenRect(_box, vp, _rect)) return true;
  const x0 = _rect[0], y0 = _rect[1], x1 = _rect[2], y1 = _rect[3];
  for (let i = 0; i + 3 < rects.length; i += 4) {
    if (x1 >= rects[i] && x0 <= rects[i + 2] && y1 >= rects[i + 1] && y0 <= rects[i + 3]) return true;
  }
  return false;
}
const _box = [0, 0, 0, 0, 0, 0];

/** Diag/stat sink for the cells.js caller. */
export function interiorApertureCullStats() {
  return stats;
}

/** Test seam. */
export function __setInteriorApertureCullOffForTest(v) { ctl.off = !!v; }

if (typeof window !== "undefined") {
  try {
    window.__interiorApertureCull = {
      mode: MODE,
      stats,
      get off() { return ctl.off; },
      set off(v) { ctl.off = !!v; },
    };
  } catch (_) { /* fail-soft */ }
}
