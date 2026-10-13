// scene3d/indoor_landscape_gate.js — cells-portals-2 (2026-10-13):
// `?indoorLandscapeGate=on` (OPT-IN, default OFF). Indoors, skip the landscape
// (terrain, other-landblock buildings/statics, sky) on frames where the portal
// walk reaches no outside portal.
//
// Retail: PView::DrawCells (acclient.c:461450) runs LScape::draw — the sky
// objects (GameSky::Draw(sky, 0)), the DrawBlock loop (terrain, buildings,
// landcell objects) and the weather (GameSky::Draw(sky, 1)), acclient.c:307754
// — and the Clear(4) Z-wipe ONLY under
// `if (this->outside_view.view_count)` (:461476). SmartBox::RenderNormalMode
// (acclient.c:144889) sends an EnvCell viewer to DrawInside alone and calls
// LScape::draw directly only for an outdoor viewer. So a room with no doorway
// or window in view draws its cells and nothing else.
//
// Holtburger computes that set (wasm getPViewOutsidePortals, fed to the
// doorway seal by cells.js tickPortalSeal), but the armed indoor split
// (atmosphere_pipeline.js preFrameSkySync) drew the full layer-0 world pass,
// the sky pass and the depth wipe on every indoor frame and then overdrew it
// with the room.
//
// With the flag on, cells.js decides per tick and hands the pipeline one
// boolean (`setIndoorLandscapeSkip`). The pipeline honours it only on an armed
// indoor frame: the world pass keeps running with an EMPTY layer mask (so its
// colour + depth clear still happens), the depth wipe is off, and the sky,
// sky-capture and horizon passes are off. The cells pass and the relayered
// room shell are untouched. Skip only when ALL hold; anything unknown fails
// OPEN (the world is drawn):
//   - the walk's RAW outside-view count is 0 (before the punch clip, which
//     drops a doorway the camera straddles), and a second walk through a
//     wider frustum (INDOOR_LANDSCAPE_WIDE_CLIP) is 0 too. The walk runs
//     before cameraSwitcher.tick, so it is one frame stale; the wider walk
//     covers a doorway turning into view during that frame;
//   - the count has been 0 for INDOOR_LANDSCAPE_MIN_ZERO_FRAMES ticks;
//   - every EnvCell the cells pass draws is resident (container registered and
//     attached; pooled cells and ?cellBugParity are unknown);
//   - no drawn cell the walk did not reach (the depth-1 BFS union in
//     tickCellVisibility3D) has an outdoor portal while its bounds are in the
//     view frustum — the walk cannot vouch for its doorway;
//   - the camera is more than INDOOR_LANDSCAPE_NEAR_PORTAL_M from every
//     outdoor portal near it: a doorway closer than the near plane projects to
//     nothing, so the walk reports no outside view while it fills the screen.
//
// Visible difference (why it is opt-in): a crack in the cell geometry shows
// the cleared background, as in retail, instead of terrain or sky.
//
// WebAC applies the static approximation (no sky for a non-SeenOutside viewer
// cell, packages/renderer/src/effects/SkyboxRenderer.ts); this module is
// re-derived from the decomp.

let _INDOOR_LANDSCAPE_GATE_ON = null;

/** Consecutive zero-count ticks before the landscape is skipped. */
export const INDOOR_LANDSCAPE_MIN_ZERO_FRAMES = 2;
/** The camera must be further than this (m) from every nearby outdoor portal. */
export const INDOOR_LANDSCAPE_NEAR_PORTAL_M = 1.0;
/**
 * Clip-space x/y scale of the second, wider walk. 0.75 widens tan(half-FOV)
 * by 1/0.75: a 90° horizontal view gains ~8° per side, more than one frame of
 * camera turn at any normal mouse speed.
 */
export const INDOOR_LANDSCAPE_WIDE_CLIP = 0.75;

/** `?indoorLandscapeGate=on` — exact opt-in; any other value (or none) is OFF. */
export function readIndoorLandscapeGateFlag(search) {
  try {
    const s =
      typeof search === "string"
        ? search
        : typeof window !== "undefined" && window.location
        ? window.location.search
        : typeof location !== "undefined" && location
        ? location.search
        : "";
    return new URLSearchParams(s || "").get("indoorLandscapeGate") === "on";
  } catch (_) {
    return false;
  }
}

/** Cached flag accessor (parse once per page load). */
export function indoorLandscapeGateEnabled() {
  if (_INDOOR_LANDSCAPE_GATE_ON === null) {
    _INDOOR_LANDSCAPE_GATE_ON = readIndoorLandscapeGateFlag();
    if (_INDOOR_LANDSCAPE_GATE_ON) _installIndoorLandscapeGateDiag();
  }
  return _INDOOR_LANDSCAPE_GATE_ON;
}

/** Test/A-B seam: force the flag (`null` re-reads the URL on next use). */
export function setIndoorLandscapeGateFlag(on) {
  _INDOOR_LANDSCAPE_GATE_ON = on == null ? null : !!on;
}

/**
 * Per-tick state, rewritten in place by cells.js tickPortalSeal while the flag
 * is on; `skippedFrames` counts frames the pipeline actually skipped. Read via
 * `window.__indoorLandscapeGateDiag()`.
 */
export const INDOOR_LANDSCAPE_GATE_STATS = {
  skip: false,
  reason: "init",
  count: null,
  wideCount: null,
  zeroFrames: 0,
  allResident: null,
  bfsOutdoor: null,
  nearOutdoorPlaneM: null,
  drawnCells: 0,
  ticks: 0,
  skippedFrames: 0,
};

function _installIndoorLandscapeGateDiag() {
  if (typeof window === "undefined" || !window) return;
  try {
    window.__indoorLandscapeGateDiag = () => ({
      on: indoorLandscapeGateEnabled(),
      ...INDOOR_LANDSCAPE_GATE_STATS,
    });
    // Runtime A/B on one page load. Off needs no restore: the next tick hands
    // the pipeline `false` and the world pass draws again.
    window.__setIndoorLandscapeGate = (on) => {
      setIndoorLandscapeGateFlag(on);
      return window.__indoorLandscapeGateDiag();
    };
  } catch (_) {}
}

/**
 * Should this frame skip the landscape? Pure. Every argument must be known
 * and passing; anything else draws the world.
 *
 * @param {object} s
 * @param {boolean} s.flag            `?indoorLandscapeGate=on`
 * @param {number|null} s.count       walk outside-view count this tick (raw +
 *                                    wide); null = unknown
 * @param {number} s.zeroFrames       consecutive ticks the count was 0
 * @param {boolean|null} s.allResident every drawn EnvCell resident
 * @param {boolean|null} s.bfsOutdoor  a drawn non-walk cell in view has an
 *                                    outdoor portal (null = unknown)
 * @param {number|null} s.nearOutdoorPlaneM distance (m) from the camera to the
 *                                    nearest outdoor portal (Infinity = none)
 */
export function indoorLandscapeSkip(s) {
  if (!s || s.flag !== true) return false;
  const c = s.count;
  if (typeof c !== "number" || c !== 0) return false;
  if (!(s.zeroFrames >= INDOOR_LANDSCAPE_MIN_ZERO_FRAMES)) return false;
  if (s.allResident !== true) return false;
  if (s.bfsOutdoor !== false) return false;
  const d = s.nearOutdoorPlaneM;
  if (typeof d !== "number" || !(d > INDOOR_LANDSCAPE_NEAR_PORTAL_M)) return false;
  return true;
}

/** An EnvCell id proper (`0x0100..0xFFFD`), not a landcell or the outdoor sentinel. */
export function isDrawnEnvCellId(id) {
  const low = (id >>> 0) & 0xffff;
  return low >= 0x0100 && low < 0xfffe;
}

/**
 * Does a cell's portal list (container `userData.portalCellIds`) hold an
 * outdoor portal? The wasm resolves a leads-outdoors portal to
 * `landblock | 0xFFFF` (env_cell.rs resolved_other_cell_id); the sentinel test
 * is the usual `>= 0xFFFE`. null = no list (unknown).
 */
export function hasOutdoorPortal(portalCellIds) {
  if (!portalCellIds || typeof portalCellIds.length !== "number") return null;
  for (let i = 0; i < portalCellIds.length; i++) {
    if (((portalCellIds[i] >>> 0) & 0xffff) >= 0xfffe) return true;
  }
  return false;
}

function _toIdSet(ids) {
  if (!ids || typeof ids[Symbol.iterator] !== "function") return null;
  const s = new Set();
  for (const v of ids) s.add(v >>> 0);
  return s;
}

/**
 * Residency + BFS-only outdoor-portal state of the armed split's drawn set.
 *
 * @param {Map<number, THREE.Object3D>} registry  scene3d.cellContainers3d
 * @param {Iterable<number>} drawn     the cells pass's cell set this tick
 * @param {Iterable<number>|null} bfs  the depth-1 BFS of the viewer cell
 * @param {Iterable<number>|null} walk the portal walk's cell set (null =
 *                                     unknown → bfsOutdoor null)
 * @param {Iterable<number>|null} frustum the BFS cells whose AABB is in the
 *                                     view frustum (null = test every BFS cell)
 * @param {number} anchor              the viewer cell (always walk-reached)
 * @returns {{allResident: boolean, bfsOutdoor: boolean|null, drawnCells: number}}
 */
export function indoorLandscapeCellState(registry, drawn, bfs, walk, frustum, anchor) {
  const out = { allResident: false, bfsOutdoor: null, drawnCells: 0 };
  if (!(registry instanceof Map) || !drawn) return out;
  let all = true;
  for (const v of drawn) {
    const id = v >>> 0;
    if (!isDrawnEnvCellId(id)) continue;
    out.drawnCells++;
    const c = registry.get(id);
    // Unregistered (not built yet / evicted) or detached (parked): the cells
    // pass would draw nothing for it.
    if (!c || !c.parent) all = false;
  }
  out.allResident = all && out.drawnCells > 0;
  const walkSet = _toIdSet(walk);
  if (!walkSet) return out;
  walkSet.add(anchor >>> 0);
  const inView = _toIdSet(frustum);
  let bfsOutdoor = false;
  if (bfs) {
    for (const v of bfs) {
      const id = v >>> 0;
      if (!isDrawnEnvCellId(id) || walkSet.has(id)) continue;
      if (inView && !inView.has(id)) continue;
      const c = registry.get(id);
      const o = c ? hasOutdoorPortal(c.userData?.portalCellIds) : null;
      if (o !== false) {
        bfsOutdoor = true;
        break;
      }
    }
  }
  out.bfsOutdoor = bfsOutdoor;
  return out;
}

/**
 * Copy a column-major MVP into `out` with clip x and y scaled by `k` (rows 0
 * and 1), i.e. the same camera with a wider field of view. Rows 2/3 (depth,
 * w) are untouched, so the near plane the walk clips against is the same.
 */
export function widenClipXY(src, k, out) {
  for (let i = 0; i < 16; i++) out[i] = src[i];
  for (let col = 0; col < 4; col++) {
    out[col * 4] *= k;
    out[col * 4 + 1] *= k;
  }
  return out;
}

/**
 * Column-major orthographic "MVP" whose frustum is the axis-aligned cube of
 * half-size `h` around (cx, cy, cz), AC world space. Fed to the wasm aperture
 * export it turns the frustum test into a "cells near this point" query.
 */
export function boxQueryMvp(cx, cy, cz, h, out) {
  const s = 1 / h;
  out.fill(0);
  out[0] = s;
  out[5] = s;
  out[10] = s;
  out[12] = -cx * s;
  out[13] = -cy * s;
  out[14] = -cz * s;
  out[15] = 1;
  return out;
}

/**
 * Distance (m) from (x, y, z) to the nearest aperture of a flat aperture list
 * (`[count, (nverts, x0,y0,z0, …) × count]`, getVisiblePortalApertures), taken
 * to each aperture's vertex AABB — never more than the true distance to the
 * polygon, so the gate errs towards drawing. Infinity for an empty list, null
 * for a malformed one.
 */
export function minDistToApertures(flat, x, y, z) {
  if (!flat || typeof flat.length !== "number" || flat.length < 1) return null;
  const count = Number(flat[0]);
  if (!Number.isFinite(count) || count < 0) return null;
  let best = Infinity;
  let p = 1;
  for (let a = 0; a < count; a++) {
    if (p >= flat.length) return null;
    const nv = Number(flat[p++]);
    if (!Number.isFinite(nv) || nv < 1 || p + nv * 3 > flat.length) return null;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < nv; i++) {
      const vx = flat[p++], vy = flat[p++], vz = flat[p++];
      if (vx < x0) x0 = vx;
      if (vx > x1) x1 = vx;
      if (vy < y0) y0 = vy;
      if (vy > y1) y1 = vy;
      if (vz < z0) z0 = vz;
      if (vz > z1) z1 = vz;
    }
    const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
    const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
    const dz = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(d)) return null;
    if (d < best) best = d;
  }
  return best;
}
