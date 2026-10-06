// Map of Dereth — port of retail gmMapUI (LayoutDesc 0x21000026) plus a
// modern expanded world map (HUD overhaul 2026-10-05).
//
// Two surfaces share one set of pure maths (exported + unit-tested in
// test_map_panel.mjs):
//
//   1. COMPACT view (F3) — a registered main-panel view (300×337 body),
//      laid out exactly like retail gmMapUI's 0x100001EA content panel:
//        0x100001EB Map_DateTimeLabel   (21,4)   227×30  "Date: …\nTime: …"
//        0x100001EC Map                 (21,36)  257×267 bitmap 0x0600127D
//        0x100001ED Map_PlayerPosition_Icon      17×16   sprite 0x06004D10
//        0x100001EE Map_HousePosition_Icon       8×8     sprite 0x06004D11
//        0x100001EF Map_CoordinateLabel (21,303) 257×20  "42.1N, 33.6E"
//      (positions from data/retail-layouts/0x21000026.json). The empty
//      30-px slot right of the date strip (above the map's right edge)
//      carries the one addition: an "expand" button for the world map;
//      clicking the map itself opens the world map centred there.
//
//   2. EXPANDED world map — `#hb-map-overlay`, a draggable/resizable kit
//      window (rebindable local action, default M; Esc closes;
//      `window.__worldMap` console hook). One <canvas>,
//      rAF only while open: cursor-anchored wheel zoom, drag-to-pan,
//      player ring + heading arrow, cursor NS/EW readout, retail town
//      notes as labels, click-to-drop waypoint pin (localStorage) with
//      distance/bearing, "Centre on me" follow mode, coordinate grid +
//      landblock lines, nearby radar blips, fellow/allegiance pins,
//      house marker and a scale bar.
//
// Position source (fix for the "96.3S, 101.3W / LB 0x0006" bug): the
// old view read liveScene3d.cameraSwitcher, which is null for ~35 s
// after login and forever under ?nullRender=1. Both surfaces now read
// the wasm pose `__sessionHandle.getLocalPlayerPose()` (landblockId +
// LB-local metres + heading; copy-then-free like app/client_events.js)
// cross-checked against `getCurrentCellId()` for the indoor/outdoor
// decision (app/landblock_stream.js documents the stale-pose wedge).
//
// Retail behaviour matched (acclient.c):
//   - gmMapUI::Update: coords "%.1f%s, %.1f%s" (NS first), shown only
//     when CPlayerSystem::IsOutside() → SmartBox::is_player_outside
//     ((objcell_id & 0xFFFF) < 0x100); otherwise the strip is blanked
//     and the player icon hidden. Modern liberty: building interiors
//     (same landblock frame) keep a live fix marked "(indoors)", and
//     dungeons show "Underground" with the last outdoor fix dimmed.
//   - gmMapUI::PlaceMarkerOnMap: marker centre =
//       x0 + (x1-x0+1)·(EW·10+1024)/2048,
//       y0 + (y1-y0+1)·(2047-(NS·10+1024))/2048
//     over m_boxMapMarkerArea (m_pMap attributes 0x1000004E..51 =
//     6, 247, 8, 258).
//   - gmMapUI::Update date strip: GameTime::GetDateTimeString →
//     "Date: <Month> <day>, <year> P.Y." / "Time: <time-of-day>",
//     refreshed every 5 s. We derive it from the server's PortalYearTicks
//     clock (`handle.serverTime()`), the domain ACE's
//     Timers.CurrentInGameTime documents as "as seen on Map Panel". The
//     real-world date the old view showed is gone.
//   - gmMapUI::PostInit/AddMapNote: 53 s_rgLocations rollover notes
//     (town names) over the bitmap's town icons — our hover tooltips and
//     the expanded map's labels.

import { setAcText } from "../ui/ac_font.js";
import { makeTitlebar } from "../ui/hud_kit.js";
import { getHudScale, hudPoint, hudRect, hudViewport, onHudScaleChange } from "../ui/hud_scale.js";
import { attachWindowPosition, persistWindowSize, attachEdgeResizers } from "../ui/ac_window_position.js";
import { LOCAL_ACTION_IDS, resolveLocalBinding, matchesBinding } from "../ui/keymap.js";

// ─────────────────────────────────────────────────────────────────────
// Pure maths (exported for test_map_panel.mjs)
// ─────────────────────────────────────────────────────────────────────

/** 0x0600127D — the whole-world parchment bitmap, drawn 1:1 by m_pMap. */
export const MAP_W = 257;
export const MAP_H = 267;
/** gmMapUI::m_boxMapMarkerArea — m_pMap int attributes 0x1000004E (x0),
 *  0x1000004F (x1), 0x10000050 (y0), 0x10000051 (y1); read in
 *  gmMapUI::PostInit, values from data/retail-layouts/0x21000026.json. */
export const MAP_MARKER_AREA = Object.freeze({ x0: 6, x1: 247, y0: 8, y1: 258 });

const LB_METRES = 192;
const METRES_PER_COORD = 240;
const COORD_ORIGIN = 101.95;

/** World metres (lbX·192 + x, lbY·192 + y) → map coordinates (EW, NS);
 *  E/N positive. Same convention ACE/Decal use for "@loc". */
export function worldToCoords(wx, wy) {
  return { ew: wx / METRES_PER_COORD - COORD_ORIGIN, ns: wy / METRES_PER_COORD - COORD_ORIGIN };
}

/** Inverse of worldToCoords. */
export function coordsToWorld(ew, ns) {
  return { wx: (ew + COORD_ORIGIN) * METRES_PER_COORD, wy: (ns + COORD_ORIGIN) * METRES_PER_COORD };
}

/** Landblock/cell id ((x<<24)|(y<<16)|cell) + LB-local metres → coords. */
export function lbToCoords(landblockId, x, y) {
  const id = landblockId >>> 0;
  const lbX = (id >>> 24) & 0xff;
  const lbY = (id >>> 16) & 0xff;
  return worldToCoords(lbX * LB_METRES + (Number(x) || 0), lbY * LB_METRES + (Number(y) || 0));
}

function fmtAxis(v, pos, neg) {
  // gmMapUI::Update: the suffix comes from the raw sign (exact zero → no
  // suffix), the magnitude is printed "%.1f".
  const suffix = v > 0 ? pos : (v < 0 ? neg : "");
  return `${Math.abs(v).toFixed(1)}${suffix}`;
}

/** Retail coordinate string, NS first: "42.1N, 33.6E". */
export function formatCoords(ew, ns) {
  if (!Number.isFinite(ew) || !Number.isFinite(ns)) return "—";
  return `${fmtAxis(ns, "N", "S")}, ${fmtAxis(ew, "E", "W")}`;
}

/** gmMapUI::PlaceMarkerOnMap — coords → marker centre in m_pMap px. */
export function coordsToMapPx(ew, ns, area = MAP_MARKER_AREA) {
  return {
    x: area.x0 + ((area.x1 - area.x0 + 1) * (ew * 10 + 1024)) / 2048,
    y: area.y0 + ((area.y1 - area.y0 + 1) * (2047 - (ns * 10 + 1024))) / 2048,
  };
}

/** Inverse of coordsToMapPx (cursor readout, click-to-pin). */
export function mapPxToCoords(px, py, area = MAP_MARKER_AREA) {
  return {
    ew: (((px - area.x0) * 2048) / (area.x1 - area.x0 + 1) - 1024) / 10,
    ns: (2047 - ((py - area.y0) * 2048) / (area.y1 - area.y0 + 1) - 1024) / 10,
  };
}

/** Map px per one coordinate unit (both axes ≈ 1.18 at 1:1). */
export const MAP_PX_PER_COORD = ((MAP_MARKER_AREA.x1 - MAP_MARKER_AREA.x0 + 1) * 10) / 2048;

/** SmartBox::is_player_outside: (objcell_id & 0xFFFF) < 0x100. */
export function isOutdoorCell(cellId) {
  return ((cellId >>> 0) & 0xffff) < 0x100;
}

/**
 * Choose the cell that decides indoor/outdoor. The raw pose can carry a
 * stale pre-portal outdoor cell after a teleport (app/landblock_stream.js
 * "Town Network no-walk wedge"); the cell-scene snapshot
 * (`getCurrentCellId`) is the server-truth carried cell.
 */
export function pickCell(poseCell, snapshotCell) {
  const p = poseCell >>> 0;
  const s = snapshotCell >>> 0;
  if (!s) return p;
  if (!p) return s;
  if ((s >>> 16) === (p >>> 16)) return s;  // same landblock: snapshot knows indoor/outdoor
  return isOutdoorCell(s) ? p : s;           // LBs disagree: an indoor snapshot means the pose is stale
}

/**
 * "outside" | "indoors" | "underground" | "unknown".
 * Indoors = an EnvCell of the landblock we were last outside in (a
 * building — its cells share the landblock's coordinate frame), or a
 * SeenOutside cell when we have no outdoor history (login inside a
 * building). Anything else indoor is a dungeon.
 */
export function classifyPlace(cellId, { seenOutside = false, lastOutdoorLb = null } = {}) {
  const id = cellId >>> 0;
  if (!id) return "unknown";
  if (isOutdoorCell(id)) return "outside";
  if (lastOutdoorLb != null) return (lastOutdoorLb >>> 0) === (id >>> 16) ? "indoors" : "underground";
  return seenOutside ? "indoors" : "underground";
}

/**
 * pose.heading θ is the CCW-about-+Z yaw; AC forward = (−sinθ, +cosθ)
 * (Frame::get_heading; derivation in scene3d/camera.js AUTOFOLLOW doc).
 * Compass bearing, clockwise from north, is therefore −θ.
 */
export function headingToBearingDeg(theta) {
  if (!Number.isFinite(theta)) return null;
  const d = (-theta * 180) / Math.PI;
  return ((d % 360) + 360) % 360;
}

const COMPASS_8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export function bearingToCompass(deg) {
  if (!Number.isFinite(deg)) return "";
  return COMPASS_8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Vector from one coord fix to another: distance (coords + metres) and
 *  compass bearing (clockwise from north). */
export function waypointVector(from, to) {
  const dEw = to.ew - from.ew;
  const dNs = to.ns - from.ns;
  const coords = Math.hypot(dEw, dNs);
  const bearing = ((((Math.atan2(dEw, dNs) * 180) / Math.PI) % 360) + 360) % 360;
  return { dEw, dNs, coords, metres: coords * METRES_PER_COORD, bearing, compass: bearingToCompass(bearing) };
}

export function formatDistance(metres) {
  if (!Number.isFinite(metres)) return "";
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0).replace(/\.0$/, "")} km`;
}

/** Zoom about an anchor point: the map point under (ax, ay) stays put.
 *  A view maps map px → local px as `local = map·scale + o`. */
export function zoomAt(view, ax, ay, nextScale) {
  const k = nextScale / view.scale;
  return { scale: nextScale, ox: ax - (ax - view.ox) * k, oy: ay - (ay - view.oy) * k };
}

/** Whole map centred in a w×h viewport. */
export function fitView(w, h, pad = 0.96) {
  const scale = Math.max(0.05, Math.min(w / MAP_W, h / MAP_H) * pad);
  return { scale, ox: (w - MAP_W * scale) / 2, oy: (h - MAP_H * scale) / 2 };
}

/** View at `scale` with map point (mx, my) at the viewport centre. */
export function centreView(scale, w, h, mx, my) {
  return { scale, ox: w / 2 - mx * scale, oy: h / 2 - my * scale };
}

/** Keep at least `margin` px of the map inside the viewport on each axis. */
export function clampView(view, w, h, margin = 48) {
  const mw = MAP_W * view.scale;
  const mh = MAP_H * view.scale;
  const mx = Math.min(margin, w / 2, mw);
  const my = Math.min(margin, h / 2, mh);
  return {
    scale: view.scale,
    ox: Math.min(Math.max(view.ox, mx - mw), w - mx),
    oy: Math.min(Math.max(view.oy, my - mh), h - my),
  };
}

/** Local px → map px and back for a view. */
export function toMapPx(view, lx, ly) { return { x: (lx - view.ox) / view.scale, y: (ly - view.oy) / view.scale }; }
export function toLocalPx(view, mx, my) { return { x: mx * view.scale + view.ox, y: my * view.scale + view.oy }; }

/** Sampling for the 257×267 bitmap. Nearest from 2 device px per map
 *  px (pixel doubling reads sharper than bilinear blur, town icons stay
 *  crisp); below 2, smoothing hides uneven pixel widths; from 12 up —
 *  far past the bitmap's detail, ~200 m per map px — smoothing again so
 *  the deep zoom reads as a soft terrain wash under the vector layers
 *  (grid, pins, labels) instead of a mosaic of 12-px blocks. */
export function mapIsCrisp(devicePxPerMapPx) {
  return devicePxPerMapPx >= 2 && devicePxPerMapPx < 12;
}

/** Coordinate-grid step (coords) so lines sit ≥ minPx apart. */
export function gridStep(pxPerCoord, minPx = 56) {
  for (const s of [0.5, 1, 2, 5, 10, 20]) {
    if (s * pxPerCoord >= minPx) return s;
  }
  return 50;
}

/** Scale bar: a round distance whose bar is minPx..maxPx long. */
export function scaleBarFor(scale, minPx = 48, maxPx = 140) {
  const metresPerPx = METRES_PER_COORD / (MAP_PX_PER_COORD * scale);
  const steps = [10, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000];
  let pick = steps[steps.length - 1];
  for (const m of steps) {
    if (m / metresPerPx >= minPx) { pick = m; break; }
  }
  const px = pick / metresPerPx;
  return { metres: pick, px: Math.min(px, maxPx * 2), label: formatDistance(pick) };
}

/**
 * Greedy label placement: highest priority (lowest number) first, a
 * label is dropped when its box overlaps an already-placed one or falls
 * outside the viewport. `items[i] = {x, y, w, h, priority}` (top-left
 * box). Returns the indices to draw.
 */
export function placeLabels(items, viewW, viewH, pad = 2) {
  const order = items.map((_, i) => i).sort((a, b) => (items[a].priority - items[b].priority) || (a - b));
  const placed = [];
  const out = [];
  for (const i of order) {
    const it = items[i];
    if (it.x < 0 || it.y < 0 || it.x + it.w > viewW || it.y + it.h > viewH) continue;
    let hit = false;
    for (const p of placed) {
      if (it.x < p.x + p.w + pad && it.x + it.w + pad > p.x && it.y < p.y + p.h + pad && it.y + it.h + pad > p.y) {
        hit = true;
        break;
      }
    }
    if (hit) continue;
    placed.push(it);
    out.push(i);
  }
  return out;
}

/** Validate a persisted waypoint. */
export function sanitizeWaypoint(raw) {
  if (!raw || typeof raw !== "object") return null;
  const ew = Number(raw.ew);
  const ns = Number(raw.ns);
  if (!Number.isFinite(ew) || !Number.isFinite(ns) || Math.abs(ew) > 110 || Math.abs(ns) > 110) return null;
  const label = typeof raw.label === "string" ? raw.label.slice(0, 48) : "";
  return { ew, ns, label };
}

// Derethian calendar. Retail GameTime (Region 0x13000000) + ACE
// DerethDateTime: 7620-tick days of 16 hours, 30-day months, 360-day
// years, zero_time_of_year 3600 (ticks 0 = Morningthaw 1, 10 P.Y.,
// Morntide-and-Half — ACE's dayZero/hourOne/dayOne/yearZero anchors all
// reproduce exactly). The P.Y. rolls at Morningthaw, so Snowreap,
// Coldeve and Wintersebb close the year. Names: acpedia "Time" (region
// data). ACE caps ticks at 1073741828 (acclient crashes beyond).
const DAY_TICKS = 7620;
const ZERO_TIME_OF_YEAR = 3600;
const ZERO_YEAR = 10;
const MAX_PORTAL_TICKS = 1073741828;
export const DERETH_MONTHS = Object.freeze([
  "Morningthaw", "Solclaim", "Seedsow", "Leafdawning", "Verdantine", "Thistledown",
  "Harvestgain", "Leafcull", "Frostfell", "Snowreap", "Coldeve", "Wintersebb",
]);
export const DERETH_HOURS = Object.freeze([
  "Darktide", "Darktide-and-Half", "Foredawn", "Foredawn-and-Half",
  "Dawnsong", "Dawnsong-and-Half", "Morntide", "Morntide-and-Half",
  "Midsong", "Midsong-and-Half", "Warmtide", "Warmtide-and-Half",
  "Evensong", "Evensong-and-Half", "Gloaming", "Gloaming-and-Half",
]);

/** PortalYearTicks (seconds) → Derethian date/time, or null. */
export function derethDateTime(ticks) {
  const t = Number(ticks);
  if (!Number.isFinite(t) || t <= 0 || t > MAX_PORTAL_TICKS) return null;
  const abs = t + ZERO_TIME_OF_YEAR;
  const dayAbs = Math.floor(abs / DAY_TICKS);
  const timeOfDay = (abs - dayAbs * DAY_TICKS) / DAY_TICKS;
  const hourIndex = Math.min(15, Math.floor(timeOfDay * 16));
  const year = ZERO_YEAR + Math.floor(dayAbs / 360);
  const dayOfYear = dayAbs % 360;
  const month = DERETH_MONTHS[Math.floor(dayOfYear / 30)];
  const day = (dayOfYear % 30) + 1;
  const hour = DERETH_HOURS[hourIndex];
  return { year, month, day, hour, hourIndex, timeOfDay, date: `${month} ${day}, ${year} P.Y.`, time: hour };
}

// gmMapUI s_rgLocations[53] (acclient.c, `gmMapUI::LocationRolloverInfo
// s_rgLocations[53]`): {X, Y, Width, Height, Name} rollover rects in
// m_pMap pixel space, added as tooltip notes by gmMapUI::AddMapNote.
// The trailing [cellId, x, y] is the landing point from ACViewer's
// Locations.txt (WorldBuilder/Data/Locations.txt, Town/POI rows) where
// one exists — every match lands within ~4 map px of the retail rect,
// which validates both tables and the PlaceMarkerOnMap mapping. null =
// no outdoor Locations.txt entry (islands, the Mt Esper entry is an
// EnvCell); those fall back to the rect centre.
const RETAIL_MAP_NOTES = [
  ["Aerlinthe Island", 178, 20, 11, 12, null],
  ["Ahurenga", 18, 74, 5, 5, [0x0FB90009, 43, 8.6]],
  ["Al-Arqas", 141, 166, 7, 6, [0x8F58003B, 183.851, 60.183]],
  ["Al-Jalima", 129, 121, 7, 6, [0x8588002C, 120.359, 95.47]],
  ["Arwic", 190, 88, 9, 8, [0xC6A90009, 46.805, 4.219]],
  ["Ayan Baqur", 19, 201, 7, 6, [0x1133001F, 88.1, 166.2]],
  ["Baishi", 200, 190, 7, 6, [0xCE410007, 12.6, 152.8]],
  ["Bandit Castle", 184, 53, 5, 5, [0xBDD00006, 16.9, 120.5]],
  ["Bluespire", 34, 84, 5, 5, [0x21B00017, 48.19, 165.89]],
  ["Candeth Keep", 44, 235, 5, 5, [0x2B120029, 120.642, 1.549]],
  ["Cragstone", 180, 97, 9, 8, [0xBB9F0040, 169.358, 168.251]],
  ["Danby's Outpost", 91, 102, 5, 5, [0x5A9C0004, 23.5, 77.1]],
  ["Dryreach", 211, 138, 9, 8, [0xDA75002B, 132, 60]],
  ["Eastham", 199, 106, 9, 8, [0xCE940035, 151.053, 112.61]],
  ["Fiun Outpost", 56, 13, 5, 5, [0x38F7001B, 91, 54]],
  ["Fort Tethana", 37, 127, 9, 8, [0x2681001D, 77.7, 108.1]],
  ["Glenden Wood", 156, 94, 9, 8, [0xA0A40025, 96.302, 119.847]],
  ["Greenspire", 43, 79, 5, 5, [0x2BB5003C, 178.958, 86.57]],
  ["Hebian-to", 224, 177, 7, 6, [0xE64E002F, 138.304, 161.905]],
  ["Holtburg", 164, 77, 9, 8, [0xA9B40019, 84, 7.1]],
  ["Kara", 182, 230, 7, 6, [0xBA170039, 181.2, 3.2]],
  ["Khayyaban", 155, 185, 7, 6, [0x9F440012, 90, 24.553]],
  ["Kryst", 224, 218, 7, 6, [0xE822002A, 132.7, 37.9]],
  ["Lin", 212, 195, 7, 6, [0xDC3C0011, 59.72, 10.774]],
  ["Linvak Tukal", 159, 224, 5, 5, [0xA21E001A, 83, 38]],
  ["Lytelthorpe", 185, 126, 9, 8, [0xC0800007, 11.723, 155.56]],
  ["MacNiall's Freehold", 235, 220, 7, 6, [0xF224001A, 81.8, 33]],
  ["Mayoi", 223, 203, 7, 6, [0xE6320021, 107.417, 10.763]],
  ["Mt Esper-Crater Village", 141, 53, 5, 5, null],
  ["Nanto", 224, 191, 7, 6, [0xE63E0022, 96.96, 37.722]],
  ["Neydisa", 142, 46, 5, 5, [0x95D60033, 146.9, 71.3]],
  ["Oolutanga's Refuge", 240, 128, 5, 5, [0xF6820033, 145.7, 49.855]],
  ["Plateau Village", 74, 79, 5, 5, [0x49B70021, 100.1, 20.8]],
  ["Qalaba'r", 148, 218, 7, 6, [0x9722003A, 168.354, 24.618]],
  ["Redspire", 26, 83, 5, 5, [0x17B2002A, 132.623, 25.809]],
  ["Rithwic", 193, 114, 9, 8, [0xC98C0028, 113.666, 190.259]],
  ["Samsur", 146, 133, 7, 6, [0x977B000C, 25.811, 73.853]],
  ["Sanamar", 50, 42, 5, 5, [0x33D90015, 59.1, 100.3]],
  ["Sawato", 195, 163, 7, 6, [0xC95B0001, 14.8, 0.3]],
  ["Shoushi", 213, 171, 7, 6, [0xDA55001D, 84.8, 99]],
  ["Silyun", 41, 25, 5, 5, [0x26EC003D, 175.927, 110.334]],
  ["Singularity Caul Island", 6, 239, 15, 16, null],
  ["Stonehold", 100, 48, 5, 5, [0x64D5000B, 30, 50]],
  ["Timaru", 32, 76, 5, 5, [0x1DB60016, 71.3873, 134.291]],
  ["Tou-Tou", 239, 163, 7, 6, [0xF5590034, 152.59, 80.8]],
  ["Tufa", 131, 148, 7, 6, [0x876C0008, 2, 186.9]],
  ["Ulgrim's Island", 112, 244, 5, 5, null],
  ["Uziz", 159, 160, 7, 6, [0xA260003C, 182.919, 87.934]],
  ["Wai Jhou", 63, 203, 7, 6, [0x3F310007, 23, 149.6]],
  ["Xarabydun", 144, 181, 7, 6, [0x934B0021, 108.3, 6.1]],
  ["Yanshi", 175, 145, 7, 6, [0xB46F001E, 75.2, 124.1]],
  ["Yaraq", 121, 156, 7, 6, [0x7D64000D, 31.9, 104.6]],
  ["Zaikhal", 123, 112, 7, 6, [0x80900013, 64.863, 55.687]],
];

/** Town/POI notes: rect (map px), label tier (1 = town/island icon,
 *  2 = 5×5 outpost icon) and coords (Locations.txt landing point, else
 *  the rect centre). */
export const MAP_LOCATIONS = Object.freeze(RETAIL_MAP_NOTES.map(([name, x, y, w, h, at]) => {
  const centre = { x: x + w / 2, y: y + h / 2 };
  const c = at ? lbToCoords(at[0], at[1], at[2]) : mapPxToCoords(centre.x, centre.y);
  return Object.freeze({ name, x, y, w, h, tier: w >= 7 ? 1 : 2, ew: c.ew, ns: c.ns, exact: !!at, cx: centre.x, cy: centre.y });
}));

/** Retail note under a map-px point (`slop` widens each rect). */
export function locationAtMapPx(px, py, slop = 0) {
  let best = null;
  let bestD = Infinity;
  for (const loc of MAP_LOCATIONS) {
    if (px < loc.x - slop || px > loc.x + loc.w + slop || py < loc.y - slop || py > loc.y + loc.h + slop) continue;
    const d = Math.hypot(px - loc.cx, py - loc.cy);
    if (d < bestD) { best = loc; bestD = d; }
  }
  return best;
}

/** Copy-then-free read of the wasm LocalPlayerPose box. */
export function readPlayerPose(handle) {
  if (!handle || typeof handle.getLocalPlayerPose !== "function") return null;
  let p = null;
  try {
    p = handle.getLocalPlayerPose();
    if (!p) return null;
    return { cell: p.landblockId >>> 0, x: Number(p.x), y: Number(p.y), z: Number(p.z), heading: Number(p.heading) };
  } catch (_) {
    return null;
  } finally {
    try { p?.free?.(); } catch (_) {}
  }
}

/**
 * Pose + deciding cell → a map fix. `tracker.lastOutdoor` remembers the
 * last outdoor fix so dungeons can show where you went underground.
 * Returns {place, ew, ns, live, bearing, cell}; ew/ns are NaN when
 * nothing is known.
 */
export function resolvePlayerFix(pose, cellId, opts = {}) {
  const tracker = opts.tracker ?? { lastOutdoor: null };
  const cell = cellId >>> 0;
  if (!pose || !cell) return { place: "unknown", ew: NaN, ns: NaN, live: false, bearing: null, cell: 0 };
  const lb = cell >>> 16;
  const place = classifyPlace(cell, { seenOutside: !!opts.seenOutside, lastOutdoorLb: tracker.lastOutdoor?.lb ?? null });
  if (place === "outside" || place === "indoors") {
    const { ew, ns } = lbToCoords(cell, pose.x, pose.y);
    if (place === "outside") tracker.lastOutdoor = { ew, ns, lb };
    return { place, ew, ns, live: true, bearing: headingToBearingDeg(pose.heading), cell };
  }
  const last = tracker.lastOutdoor;
  return { place, ew: last ? last.ew : NaN, ns: last ? last.ns : NaN, live: false, bearing: null, cell };
}

/** Player-facing description of a fix (coordinate strip). */
export function describeFix(fix) {
  if (!fix || fix.place === "unknown") return "—";
  const at = formatCoords(fix.ew, fix.ns);
  if (fix.place === "outside") return at;
  if (fix.place === "indoors") return `${at} (indoors)`;
  return Number.isFinite(fix.ew) ? `Underground (last: ${at})` : "Underground";
}

// Retail RadarColor → RGB (acclient.c:45107-45116; same table as
// plugins/radar.js) and gmRadarUI's per-kind defaults.
const RADAR_COLOR_HEX = Object.freeze({
  0x01: "#40A8FF", 0x02: "#FFAB00", 0x03: "#FFFFFF", 0x04: "#BF63FF", 0x05: "#FF4063",
  0x06: "#FFA8BF", 0x07: "#008040", 0x08: "#FFFF80", 0x09: "#00FFFF", 0x10: "#00FF00",
});
const BLIP_KIND_HEX = Object.freeze({ player: "#FFFFFF", creature: "#FFAB00", npc: "#FFFF80", vendor: "#FFFF80" });
const ODF_PLAYER = 0x08;
const ODF_VENDOR = 0x10;

/** Classify a world entity for a blip (null = not drawn): WO class first,
 *  objDescFlags fallback; RadarBehavior ShowNever (1) hides. */
export function blipKindOf(className, meta) {
  const m = meta || {};
  if (((m.radarBehavior >>> 0) || 0) === 1) return null;
  if (className === "Player") return "player";
  if (className === "Vendor") return "vendor";
  if (className === "Npc") return "npc";
  if (className === "Creature" || className === "Monster") return "creature";
  const odf = (m.objDescFlags >>> 0) || 0;
  if (odf & ODF_PLAYER) return "player";
  if (odf & ODF_VENDOR) return "vendor";
  if (m.category === "creature") return "creature";
  return null;
}
export function blipColor(kind, radarColor) {
  return RADAR_COLOR_HEX[(radarColor >>> 0) || 0] || BLIP_KIND_HEX[kind] || "#FFFFFF";
}

// HUD rec #139 — collect renderable roster-member map markers. Pure (no DOM):
// given the roster map (guid → {kind, name}), the live entityMap, a last-seen
// position cache, the current time, and the local player's guid, return one
// descriptor per locatable member. Live PVS positions (entityMap) win and
// refresh the cache; recently-seen members fall back to the cache (faded by
// age) up to staleMs. Members never seen — outside the local PVS or offline —
// are omitted: the AC server never broadcast roster-wide positions, so this is
// fidelity-correct, not a regression. A PLAYER objDescFlags guard suppresses
// the rare case of an item guid recycled onto a roster guid (radar.js:38).
// Positions are world metres (x east, y north), as entityMap carries them.
export function collectRosterMarkers(roster, entityMap, lastSeen, nowMs, localGuid, opts = {}) {
  const staleMs = opts.staleMs ?? 5 * 60 * 1000;
  const lg = (localGuid ?? 0) >>> 0;
  const out = [];
  for (const [guidRaw, info] of roster) {
    const g = guidRaw >>> 0;
    if (g === lg) continue; // the local player already has their own marker
    const kind = info?.kind ?? "fellow";
    const name = info?.name ?? "";
    const inst = (entityMap && typeof entityMap.get === "function") ? entityMap.get(g) : null;
    const pos = inst?.root?.position ?? null;
    const odf = inst?.meta?.objDescFlags;
    const isPlayer = (odf == null) ? true : (((odf >>> 0) & ODF_PLAYER) !== 0);
    if (pos && isPlayer && typeof pos.x === "number" && typeof pos.y === "number") {
      lastSeen.set(g, { x: pos.x, y: pos.y, ts: nowMs });
      out.push({ guid: g, kind, name, x: pos.x, y: pos.y, source: "live", ageMs: 0 });
    } else {
      const cached = lastSeen.get(g);
      if (cached && (nowMs - cached.ts) <= staleMs) {
        out.push({ guid: g, kind, name, x: cached.x, y: cached.y, source: "cached", ageMs: nowMs - cached.ts });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Live data (shared by both surfaces)
// ─────────────────────────────────────────────────────────────────────

const SP = "./data/ui-sprites";
const MAP_SRC = `${SP}/0x0600127D.png`;
const PLAYER_ICON_SRC = `${SP}/0x06004D10.png`; // Map_PlayerPosition_Icon 17×16 ring
const HOUSE_ICON_SRC = `${SP}/0x06004D11.png`;  // Map_HousePosition_Icon 8×8
const LS_WAYPOINT = "hb.map.waypoint.v1";
const LS_PREFS = "hb.map.prefs.v1";
const OVERLAY_ID = "hb-map-overlay";
const STYLE_ID = "hb-map-view-style";
// Synthetic window id (0xFFFF00xx + gmMapUI's layout low byte) — no
// retail floaty owns the world map; see WINDOW_ID in ac_window_position.js.
const OVERLAY_WINDOW_ID = 0xFFFF0026;
// Rebindable local action "World Map (toggle)", default KeyM. Falls back
// to this id until ui/keymap.js LOCAL_ACTIONS gains the row.
const WORLD_MAP_ACTION_ID = LOCAL_ACTION_IDS?.WORLD_MAP ?? "0xFF00002B";
const ROSTER_STALE_MS = 5 * 60 * 1000;

function sessionHandle() {
  try { return window.__sessionHandle ?? window.__pluginClient?._handle ?? null; } catch (_) { return null; }
}

function lsGet(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}
function lsSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {}
}

const shared = {
  lastOutdoor: null,
  fix: null,
  fixAt: -1,
  waypoint: sanitizeWaypoint(lsGet(LS_WAYPOINT)),
  waypointRev: 0,
  roster: new Map(),
  rosterLastSeen: new Map(),
  house: null,
  slowAt: -1e9,
};

function setWaypoint(wp) {
  shared.waypoint = wp ? sanitizeWaypoint(wp) : null;
  shared.waypointRev += 1;
  lsSet(LS_WAYPOINT, shared.waypoint);
}

/** Roster guid set, copy-then-free (the snapshot getters return wasm
 *  boxes; the old view never freed them). */
export function readRoster(handle) {
  const next = new Map();
  const add = (m, kind) => {
    try {
      if (m && m.guid != null && !next.has(m.guid >>> 0)) next.set(m.guid >>> 0, { kind, name: String(m.name ?? "") });
    } catch (_) {}
    try { m?.free?.(); } catch (_) {}
  };
  let fel = null;
  try {
    fel = handle?.playerFellowship?.() ?? null;
    if (fel) for (const m of fel.members ?? []) add(m, "fellow");
  } catch (_) {} finally { try { fel?.free?.(); } catch (_) {} }
  let alg = null;
  try {
    alg = handle?.playerAllegiance?.() ?? null;
    if (alg) for (const m of [alg.monarch, alg.patron, alg.myself, ...(alg.vassals ?? [])]) add(m, "alleg");
  } catch (_) {} finally { try { alg?.free?.(); } catch (_) {} }
  return next;
}

function readHouse(handle) {
  let d = null;
  try {
    d = handle?.playerHouseData?.() ?? null;
    const lb = (d?.landblockId >>> 0) || 0;
    if (!lb) return null;
    return lbToCoords(lb, d.posX, d.posY);
  } catch (_) {
    return null;
  } finally {
    try { d?.free?.(); } catch (_) {}
  }
}

/** One fix per frame for both surfaces; slow data (roster/house/date) at 1 Hz. */
function sampleFix(now) {
  if (shared.fix && now - shared.fixAt < 10) return shared.fix;
  const handle = sessionHandle();
  const pose = readPlayerPose(handle);
  let snap = 0;
  let seenOutside = false;
  if (pose && handle) {
    try { snap = typeof handle.getCurrentCellId === "function" ? (handle.getCurrentCellId() >>> 0) : 0; } catch (_) { snap = 0; }
  }
  const cell = pose ? pickCell(pose.cell, snap) : 0;
  if (cell && !isOutdoorCell(cell)) {
    try { seenOutside = !!handle?.isCurrentCellSeenOutside?.(); } catch (_) {}
  }
  shared.fix = resolvePlayerFix(pose, cell, { seenOutside, tracker: shared });
  shared.fixAt = now;
  if (now - shared.slowAt > 1000) {
    shared.slowAt = now;
    shared.roster = readRoster(handle);
    shared.house = readHouse(handle);
    let t = 0;
    try { t = Number(handle?.serverTime?.()) || 0; } catch (_) { t = 0; }
    shared.date = derethDateTime(t);
  }
  return shared.fix;
}

function rosterMarkers() {
  const entityMap = window.liveScene3d?.entityManager?.entityMap ?? null;
  const localGuid = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
  return collectRosterMarkers(shared.roster, entityMap, shared.rosterLastSeen, Date.now(), localGuid, { staleMs: ROSTER_STALE_MS });
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────

// Waypoint pin glyph (no retail sprite exists): gold teardrop, red core.
const PIN_PATH = "M11 29C11 29 2 17.5 2 11a9 9 0 0 1 18 0c0 6.5-9 18-9 18z";
const PIN_SVG = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 30"><path d="${PIN_PATH}" fill="#f3d27a" stroke="#1a1208" stroke-width="2"/><circle cx="11" cy="11" r="3.6" fill="#a3271b"/></svg>`,
)}`;
const EXPAND_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square">'
  + '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4M2 2l4.5 4.5M14 2 9.5 6.5M14 14 9.5 9.5M2 14l4.5-4.5"/></svg>';

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* ── Compact view (gmMapUI 0x100001EA content panel, 300×337 body) ── */
    .hb-map-root {
      position: absolute; inset: 0;
      pointer-events: auto; overflow: hidden;
      font-family: var(--hbk-font); color: var(--hbk-text);
    }
    .hb-map-strip {
      position: absolute; box-sizing: border-box;
      display: flex; align-items: center;
      padding: 0 6px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--hbk-gold-deep);
      box-shadow: inset 0 1px 2px #000;
      pointer-events: none;
    }
    /* 0x100001EB Map_DateTimeLabel (21,4) 227×30 — two retail lines. */
    .hb-map-date { left: 21px; top: 4px; width: 227px; height: 30px;
      flex-direction: column; align-items: flex-start; justify-content: center; }
    .hb-map-date > div { height: 14px; line-height: 14px; overflow: visible; white-space: nowrap; }
    .hb-map-date.is-empty { visibility: hidden; }
    /* Expand button in the gutter right of the date strip. */
    .hb-map-expand { position: absolute; left: 252px; top: 6px; width: 26px; height: 26px; }
    /* 0x100001EC Map (21,36) 257×267 — bitmap drawn 1:1 like retail. */
    .hb-map-view {
      position: absolute; left: 21px; top: 36px; width: ${MAP_W}px; height: ${MAP_H}px;
      overflow: hidden; background: #1a140a; cursor: zoom-in;
      box-shadow: 0 0 0 1px var(--hbk-gold-deep), 0 0 0 2px #000;
    }
    .hb-map-bitmap { position: absolute; left: 0; top: 0; width: ${MAP_W}px; height: ${MAP_H}px;
      pointer-events: none; user-select: none; -webkit-user-drag: none; }
    .hb-map-view.is-crisp .hb-map-bitmap { image-rendering: pixelated; }
    .hb-map-mark { position: absolute; left: 0; top: 0; pointer-events: none; display: none; }
    /* 0x100001ED Map_PlayerPosition_Icon — retail green ring 0x06004D10,
       plus a heading tick (modern liberty: retail's ring is undirected). */
    .hb-map-player { width: 17px; height: 16px; margin: -8px 0 0 -8.5px; z-index: 4;
      background: url("${PLAYER_ICON_SRC}") center / 100% 100% no-repeat;
      filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.9)); }
    .hb-map-player.is-stale { opacity: 0.45; filter: grayscale(0.7); }
    .hb-map-heading { position: absolute; left: -6px; top: -6px; width: 29px; height: 28px; }
    .hb-map-heading::before { content: ""; position: absolute; left: 11px; top: 0; width: 7px; height: 6px;
      background: #c8ff7a; clip-path: polygon(50% 0, 100% 100%, 0 100%); }
    /* 0x100001EE Map_HousePosition_Icon — 0x06004D11. */
    .hb-map-house { width: 8px; height: 8px; margin: -4px 0 0 -4px; z-index: 2;
      background: url("${HOUSE_ICON_SRC}") center / 100% 100% no-repeat; }
    /* HUD rec #139 fellow / allegiance pins (radar BrightGreen = fellowship). */
    .hb-map-roster { width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; z-index: 3;
      box-sizing: border-box; border: 1px solid #000; border-radius: 50%; }
    .hb-map-roster[data-kind="fellow"] { background: #00ff00; }
    .hb-map-roster[data-kind="alleg"] { background: #d8b24a; border-radius: 1px; }
    .hb-map-pin { width: 11px; height: 15px; margin: -15px 0 0 -5.5px; z-index: 3;
      background: url("${PIN_SVG}") center / 100% 100% no-repeat; }
    /* 0x100001EF Map_CoordinateLabel (21,303) 257×20. */
    .hb-map-coords { left: 21px; top: 303px; width: ${MAP_W}px; height: 20px;
      justify-content: center; pointer-events: auto; }
    .hb-map-coords > span { display: block; width: 100%; text-align: center; overflow: hidden; }
    .hb-map-tip.hbk-tooltip { position: absolute; z-index: 10; white-space: nowrap; display: none; }
    .hb-map-tip .hb-map-tip-sub, .hb-wm-tip .hb-map-tip-sub { color: var(--hbk-text-dim); font-size: 11px; }

    /* ── Expanded world map (#hb-map-overlay) ── */
    #${OVERLAY_ID} {
      display: flex; flex-direction: column;
      z-index: 600; min-width: 360px; min-height: 320px;
    }
    #${OVERLAY_ID}[hidden] { display: none; }
    #${OVERLAY_ID}:focus { outline: none; }
    #${OVERLAY_ID} > .hbk-titlebar { flex: 0 0 auto; }
    #${OVERLAY_ID} .hb-wm-toolbar {
      display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; flex: 0 0 auto;
      padding: 4px 8px; min-height: 30px; box-sizing: border-box;
      border-bottom: 1px solid var(--hbk-gold-deep); background: rgba(0, 0, 0, 0.35);
    }
    #${OVERLAY_ID} .hb-wm-toolbar .hbk-icon-btn { font-size: 15px; line-height: 1; font-family: var(--hbk-font); }
    #${OVERLAY_ID} .hb-wm-sep { width: 1px; align-self: stretch; margin: 2px 2px; background: var(--hbk-gold-deep); }
    #${OVERLAY_ID} .hb-wm-date { flex: 1 1 160px; min-width: 0; overflow: hidden; display: flex; justify-content: flex-end; }
    #${OVERLAY_ID} .hb-wm-stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; background: #16110a; }
    #${OVERLAY_ID} .hb-wm-canvas { position: absolute; left: 0; top: 0; display: block; cursor: grab; touch-action: none; }
    #${OVERLAY_ID} .hb-wm-canvas.is-dragging { cursor: grabbing; }
    #${OVERLAY_ID} .hb-wm-canvas.is-over-target { cursor: pointer; }
    #${OVERLAY_ID} .hb-wm-tip.hbk-tooltip { position: absolute; z-index: 3; white-space: nowrap; display: none; }
    #${OVERLAY_ID} .hb-wm-status {
      flex: 0 0 auto; justify-content: space-between; gap: 10px;
      font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; min-height: 26px;
    }
    #${OVERLAY_ID} .hb-wm-status > span { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    #${OVERLAY_ID} .hb-wm-pin { display: inline-flex; align-items: center; gap: 4px; }
    #${OVERLAY_ID} .hb-wm-pin .hbk-icon-btn { width: 16px; height: 16px; font-size: 11px; }
    #${OVERLAY_ID} .hb-wm-pin[hidden] { display: none; }
  `;
  document.head.appendChild(style);
}

function makeEl(tag, className, parent) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (parent) parent.appendChild(el);
  return el;
}

function setTip(tipEl, title, sub) {
  tipEl.textContent = "";
  const a = makeEl("div", "", tipEl);
  a.textContent = title;
  if (sub) {
    const b = makeEl("div", "hb-map-tip-sub", tipEl);
    b.textContent = sub;
  }
}

function placeMark(el, x, y) {
  el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
  el.style.display = "block";
}

function townSub(loc) {
  return `${loc.exact ? "" : "≈ "}${formatCoords(loc.ew, loc.ns)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Compact view (F3, main-panel)
// ─────────────────────────────────────────────────────────────────────

function mountCompact(parentEl) {
  ensureStyles();
  const root = makeEl("div", "hb-map-root", parentEl);

  // Date/time strip — 0x100001EB.
  const dateEl = makeEl("div", "hb-map-strip hb-map-date is-empty", root);
  const dateLine = makeEl("div", "", dateEl);
  const timeLine = makeEl("div", "", dateEl);

  // Expand → world map.
  const expandBtn = makeEl("button", "hbk-icon-btn hb-map-expand", root);
  expandBtn.type = "button";
  expandBtn.innerHTML = EXPAND_SVG;
  expandBtn.title = "Open the world map (M)";
  expandBtn.setAttribute("aria-label", "Open the world map");
  expandBtn.addEventListener("click", (e) => { e.stopPropagation(); openWorldMap(); });

  // Map — 0x100001EC with its marker children.
  const viewEl = makeEl("div", "hb-map-view", root);
  const bitmap = makeEl("img", "hb-map-bitmap", viewEl);
  bitmap.src = MAP_SRC;
  bitmap.alt = "";
  bitmap.draggable = false;
  const houseEl = makeEl("div", "hb-map-mark hb-map-house", viewEl);
  const pinEl = makeEl("div", "hb-map-mark hb-map-pin", viewEl);
  const playerEl = makeEl("div", "hb-map-mark hb-map-player", viewEl);
  const headingEl = makeEl("div", "hb-map-heading", playerEl);
  const rosterPool = [];

  // Coordinates — 0x100001EF.
  const coordsEl = makeEl("div", "hb-map-strip hb-map-coords", root);
  const coordsText = makeEl("span", "", coordsEl);
  setAcText(coordsText, "—", { fit: true });

  const tipEl = makeEl("div", "hbk-tooltip hb-map-tip", root);

  const applyCrisp = () => {
    const k = getHudScale() * (window.devicePixelRatio || 1);
    viewEl.classList.toggle("is-crisp", mapIsCrisp(k));
  };
  applyCrisp();
  const offScale = onHudScaleChange(applyCrisp);

  // Hover: retail AddMapNote rollovers (town names) + the coords under
  // the cursor. Click: open the world map centred on that spot.
  const localMapPx = (ev) => {
    const p = hudPoint(ev);
    const r = hudRect(viewEl);
    return { x: p.x - r.left, y: p.y - r.top };
  };
  viewEl.addEventListener("pointermove", (ev) => {
    const m = localMapPx(ev);
    const loc = locationAtMapPx(m.x, m.y, 1);
    const c = mapPxToCoords(m.x, m.y);
    if (loc) setTip(tipEl, loc.name, townSub(loc));
    else setTip(tipEl, formatCoords(c.ew, c.ns), "Click to open the world map");
    tipEl.style.display = "block";
    const rootRect = hudRect(root);
    const vr = hudRect(viewEl);
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;
    let x = vr.left - rootRect.left + m.x + 14;
    let y = vr.top - rootRect.top + m.y + 16;
    if (x + tw > rootRect.width - 2) x = vr.left - rootRect.left + m.x - tw - 10;
    if (y + th > rootRect.height - 2) y = vr.top - rootRect.top + m.y - th - 10;
    tipEl.style.left = `${Math.max(2, x)}px`;
    tipEl.style.top = `${Math.max(2, y)}px`;
  });
  viewEl.addEventListener("pointerleave", () => { tipEl.style.display = "none"; });
  viewEl.addEventListener("click", (ev) => {
    const m = localMapPx(ev);
    tipEl.style.display = "none";
    openWorldMap({ centreMapPx: m });
  });

  let lastStrip = "";
  let lastDate = "";
  let lastPinRev = -1;
  let raf = 0;
  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    const fix = sampleFix(now);

    // Player ring + heading (gmMapUI::Update → PlaceMarkerOnMap).
    if (Number.isFinite(fix.ew)) {
      const p = coordsToMapPx(fix.ew, fix.ns);
      placeMark(playerEl, p.x, p.y);
      playerEl.classList.toggle("is-stale", !fix.live);
      if (fix.bearing != null) {
        headingEl.style.display = "block";
        headingEl.style.transform = `rotate(${fix.bearing.toFixed(1)}deg)`;
      } else {
        headingEl.style.display = "none";
      }
    } else {
      playerEl.style.display = "none";
    }
    const strip = describeFix(fix);
    if (strip !== lastStrip) {
      lastStrip = strip;
      setAcText(coordsText, strip, { fit: true });
      // Dev-only detail stays in the tooltip, never in the strip.
      coordsEl.title = fix.cell
        ? `Landblock 0x${(fix.cell >>> 16).toString(16).toUpperCase().padStart(4, "0")} · cell 0x${(fix.cell & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`
        : "";
    }

    const d = shared.date;
    const dateKey = d ? `${d.date}|${d.time}` : "";
    if (dateKey !== lastDate) {
      lastDate = dateKey;
      dateEl.classList.toggle("is-empty", !d);
      if (d) {
        setAcText(dateLine, `Date: ${d.date}`, { fit: true });
        setAcText(timeLine, `Time: ${d.time}`, { fit: true });
      }
    }

    if (shared.house) {
      const h = coordsToMapPx(shared.house.ew, shared.house.ns);
      placeMark(houseEl, h.x, h.y);
      houseEl.title = "Your house";
    } else {
      houseEl.style.display = "none";
    }

    if (shared.waypointRev !== lastPinRev) {
      lastPinRev = shared.waypointRev;
      const wp = shared.waypoint;
      if (wp) {
        const q = coordsToMapPx(wp.ew, wp.ns);
        placeMark(pinEl, q.x, q.y);
      } else {
        pinEl.style.display = "none";
      }
    }

    const markers = rosterMarkers();
    while (rosterPool.length < markers.length) rosterPool.push(makeEl("div", "hb-map-mark hb-map-roster", viewEl));
    for (let i = 0; i < rosterPool.length; i++) {
      const el = rosterPool[i];
      const m = markers[i];
      if (!m) { el.style.display = "none"; continue; }
      const c = worldToCoords(m.x, m.y);
      const q = coordsToMapPx(c.ew, c.ns);
      el.dataset.kind = m.kind;
      el.style.opacity = m.source === "cached" ? String(Math.max(0.25, 1 - m.ageMs / ROSTER_STALE_MS)) : "1";
      placeMark(el, q.x, q.y);
    }
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    try { offScale(); } catch (_) {}
    root.remove();
  };
}

export const view = {
  name: "Map",
  nameFor: () => "Map of Dereth",
  mount: (parentEl) => mountCompact(parentEl),
};

// ─────────────────────────────────────────────────────────────────────
// Expanded world map (#hb-map-overlay)
// ─────────────────────────────────────────────────────────────────────

// Zoom is in HUD px per map px. 8 ≈ a 16 km regional view around the
// player; 64 puts a landblock at ~60 px and the radar's 75 m range at
// ~24 px — the "coordinate sheet" end of the range.
const MAX_SCALE = 64;
const FOLLOW_SCALE = 8;
const BLIP_MIN_SCALE = 16;
const LB_LINES_MIN_SCALE = 10;
const MAX_BLIPS = 160;

const wm = {
  root: null, stage: null, canvas: null, ctx: null, tipEl: null,
  dateEl: null, meEl: null, cursorEl: null, pinWrap: null, pinEl: null,
  chk: {}, imgs: null,
  w: 0, h: 0, k: 1, view: null,
  open: false, raf: 0, drag: null, hover: null, cursor: null,
  prefs: null, sizer: null, font: '"Times New Roman", serif',
  lastSig: "", lastDate: "", lastMe: "", lastPin: null,
};

function loadPrefs() {
  const raw = lsGet(LS_PREFS) || {};
  return {
    grid: raw.grid === true,
    towns: raw.towns !== false,
    blips: raw.blips !== false,
    follow: raw.follow !== false,
    scale: Number.isFinite(raw.scale) && raw.scale > 0 ? Math.min(MAX_SCALE, raw.scale) : FOLLOW_SCALE,
  };
}
function savePrefs() {
  if (!wm.prefs) return;
  if (wm.view) wm.prefs.scale = wm.view.scale;
  lsSet(LS_PREFS, wm.prefs);
}

function loadImg(src) {
  const img = new Image();
  img.decoding = "async";
  img.onload = () => { wm.lastSig = ""; };
  img.src = src;
  return img;
}

function overlayDefaultSize() {
  const vp = hudViewport();
  const h = Math.max(320, Math.min(vp.height - 40, 760));
  const w = Math.max(360, Math.min(vp.width - 40, Math.round(h * 1.2)));
  return { w, h };
}

function clampOverlayToViewport() {
  const el = wm.root;
  if (!el) return;
  const vp = hudViewport();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  if (w > vp.width - 8) el.style.width = `${Math.max(360, vp.width - 8)}px`;
  if (h > vp.height - 8) el.style.height = `${Math.max(320, vp.height - 8)}px`;
}

function minScale() {
  return Math.max(0.5, fitView(wm.w || MAP_W, wm.h || MAP_H).scale * 0.9);
}

function ensureOverlay() {
  if (wm.root) return;
  ensureStyles();
  wm.prefs = loadPrefs();
  wm.imgs = { map: loadImg(MAP_SRC), ring: loadImg(PLAYER_ICON_SRC), house: loadImg(HOUSE_ICON_SRC) };
  try {
    const f = getComputedStyle(document.documentElement).getPropertyValue("--hb-font-serif").trim();
    if (f) wm.font = f;
  } catch (_) {}

  const root = makeEl("div", "hbk-window", null);
  root.id = OVERLAY_ID;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Map of Dereth");
  root.tabIndex = -1;
  const size = overlayDefaultSize();
  root.style.width = `${size.w}px`;
  root.style.height = `${size.h}px`;

  const { bar } = makeTitlebar("Map of Dereth", { onClose: () => closeWorldMap() });
  root.appendChild(bar);

  // Toolbar: zoom, centre/follow, layer toggles, Derethian date.
  const tb = makeEl("div", "hb-wm-toolbar", root);
  const zoomOut = makeEl("button", "hbk-icon-btn", tb);
  zoomOut.type = "button"; zoomOut.textContent = "−"; zoomOut.title = "Zoom out"; zoomOut.setAttribute("aria-label", "Zoom out");
  const zoomIn = makeEl("button", "hbk-icon-btn", tb);
  zoomIn.type = "button"; zoomIn.textContent = "+"; zoomIn.title = "Zoom in"; zoomIn.setAttribute("aria-label", "Zoom in");
  const centreBtn = makeEl("button", "hbk-btn", tb);
  centreBtn.type = "button"; centreBtn.textContent = "Centre on me"; centreBtn.title = "Centre on your position and follow it";
  makeEl("span", "hb-wm-sep", tb);
  const mkCheck = (key, label, title) => {
    const lab = makeEl("label", "hbk-label", tb);
    lab.title = title;
    const input = makeEl("input", "hbk-check", lab);
    input.type = "checkbox";
    input.checked = !!wm.prefs[key];
    const span = makeEl("span", "", lab);
    span.textContent = label;
    input.addEventListener("change", () => {
      wm.prefs[key] = input.checked;
      savePrefs();
      wm.lastSig = "";
      // Hand focus back to the window so M / Esc keep working.
      try { wm.root.focus({ preventScroll: true }); } catch (_) {}
    });
    wm.chk[key] = input;
  };
  mkCheck("towns", "Towns", "Show town and outpost names");
  mkCheck("grid", "Grid", "Coordinate grid (landblock lines when zoomed in)");
  mkCheck("blips", "Nearby", "Show nearby players, NPCs and creatures when zoomed in");
  wm.dateEl = makeEl("div", "hb-wm-date", tb);

  const stage = makeEl("div", "hb-wm-stage", root);
  const canvas = makeEl("canvas", "hb-wm-canvas", stage);
  canvas.setAttribute("aria-label", "World map. Scroll to zoom, drag to pan, click to drop a waypoint, right-click to clear it.");
  const tipEl = makeEl("div", "hbk-tooltip hb-wm-tip", stage);

  const status = makeEl("div", "hbk-footer hb-wm-status", root);
  wm.meEl = makeEl("span", "", status);
  wm.cursorEl = makeEl("span", "", status);
  wm.pinWrap = makeEl("span", "hb-wm-pin", status);
  wm.pinEl = makeEl("span", "", wm.pinWrap);
  const pinClear = makeEl("button", "hbk-icon-btn", wm.pinWrap);
  pinClear.type = "button"; pinClear.textContent = "✕"; pinClear.title = "Clear waypoint"; pinClear.setAttribute("aria-label", "Clear waypoint");
  pinClear.addEventListener("click", () => setWaypoint(null));

  Object.assign(wm, { root, stage, canvas, ctx: canvas.getContext("2d"), tipEl });
  root.hidden = true;
  document.body.appendChild(root);

  zoomIn.addEventListener("click", () => zoomBy(1.5));
  zoomOut.addEventListener("click", () => zoomBy(1 / 1.5));
  centreBtn.addEventListener("click", () => {
    const fix = shared.fix;
    if (!fix || !Number.isFinite(fix.ew)) {
      // Nothing to centre on (pre-login / underground with no outdoor
      // history): show the whole world instead of doing nothing.
      wm.prefs.follow = false;
      setView(fitView(wm.w, wm.h));
      return;
    }
    wm.prefs.follow = true;
    if (wm.view && wm.view.scale < FOLLOW_SCALE) wm.view = { ...wm.view, scale: FOLLOW_SCALE };
    savePrefs();
    wm.lastSig = "";
  });

  wireCanvas();

  // Persisted size + drag/resize (zoom-aware helpers).
  wm.sizer = persistWindowSize(root, OVERLAY_WINDOW_ID, { minW: 360, minH: 320 });
  attachEdgeResizers(root, {
    edges: ["left", "right", "bottom"],
    windowId: OVERLAY_WINDOW_ID,
    minWidth: 360,
    minHeight: 320,
    onSizeChange: ({ width, height }) => wm.sizer?.commit(width, height),
  });

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => resizeCanvas()).observe(stage);
  }
  onHudScaleChange(() => { if (wm.open) { clampOverlayToViewport(); resizeCanvas(); } });
  window.addEventListener("resize", () => { if (wm.open) clampOverlayToViewport(); });
}

function attachOverlayPosition() {
  if (wm.positioned) return;
  wm.positioned = true;
  const vp = hudViewport();
  const r = { w: wm.root.offsetWidth, h: wm.root.offsetHeight };
  attachWindowPosition(wm.root, {
    windowId: OVERLAY_WINDOW_ID,
    dragHandle: wm.root.querySelector(".hbk-titlebar"),
    ignoreSelector: "button",
    defaultPos: {
      left: `${Math.max(0, Math.round((vp.width - r.w) / 2))}px`,
      top: `${Math.max(0, Math.round((vp.height - r.h) / 2))}px`,
    },
  });
}

function resizeCanvas() {
  if (!wm.stage) return;
  const w = wm.stage.clientWidth;
  const h = wm.stage.clientHeight;
  if (!w || !h) return;
  const k = getHudScale() * (window.devicePixelRatio || 1);
  const bw = Math.max(1, Math.round(w * k));
  const bh = Math.max(1, Math.round(h * k));
  if (wm.canvas.width !== bw) wm.canvas.width = bw;
  if (wm.canvas.height !== bh) wm.canvas.height = bh;
  wm.canvas.style.width = `${w}px`;
  wm.canvas.style.height = `${h}px`;
  // Keep the map point at the centre stable across a resize.
  if (wm.view && wm.w) {
    wm.view = { ...wm.view, ox: wm.view.ox + (w - wm.w) / 2, oy: wm.view.oy + (h - wm.h) / 2 };
  }
  wm.w = w;
  wm.h = h;
  wm.k = bw / w;
  wm.lastSig = "";
}

function localPoint(ev) {
  const p = hudPoint(ev);
  const r = hudRect(wm.canvas);
  return { x: p.x - r.left, y: p.y - r.top };
}

function setView(v) {
  wm.view = clampView(v, wm.w, wm.h);
  wm.lastSig = "";
}

function zoomBy(factor, anchor) {
  if (!wm.view) return;
  const next = Math.max(minScale(), Math.min(MAX_SCALE, wm.view.scale * factor));
  // Following: zoom about the player (the view centre) so it stays centred.
  const a = (!anchor || wm.prefs.follow) ? { x: wm.w / 2, y: wm.h / 2 } : anchor;
  setView(zoomAt(wm.view, a.x, a.y, next));
  savePrefs();
}

function waypointHit(lx, ly) {
  const wp = shared.waypoint;
  if (!wp || !wm.view) return false;
  const p = coordsToMapPx(wp.ew, wp.ns);
  const q = toLocalPx(wm.view, p.x, p.y);
  return Math.abs(lx - q.x) <= 7 && ly <= q.y + 2 && ly >= q.y - 17;
}

function wireCanvas() {
  const c = wm.canvas;
  c.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !wm.view) return;
    const p = localPoint(ev);
    wm.drag = { sx: p.x, sy: p.y, ox: wm.view.ox, oy: wm.view.oy, moved: false };
    try { c.setPointerCapture(ev.pointerId); } catch (_) {}
  });
  c.addEventListener("pointermove", (ev) => {
    const p = localPoint(ev);
    wm.cursor = p;
    const d = wm.drag;
    if (d) {
      const dx = p.x - d.sx;
      const dy = p.y - d.sy;
      if (!d.moved && Math.hypot(dx, dy) > 3) {
        d.moved = true;
        wm.prefs.follow = false;
        c.classList.add("is-dragging");
        wm.tipEl.style.display = "none";
      }
      if (d.moved) setView({ scale: wm.view.scale, ox: d.ox + dx, oy: d.oy + dy });
      return;
    }
    updateHover(p);
  });
  const endDrag = (ev) => {
    const d = wm.drag;
    wm.drag = null;
    c.classList.remove("is-dragging");
    try { c.releasePointerCapture(ev.pointerId); } catch (_) {}
    if (d && !d.moved && ev.type === "pointerup") clickAt(localPoint(ev));
  };
  c.addEventListener("pointerup", endDrag);
  c.addEventListener("pointercancel", endDrag);
  c.addEventListener("pointerleave", () => {
    if (wm.drag) return;
    wm.cursor = null;
    wm.hover = null;
    wm.tipEl.style.display = "none";
    c.classList.remove("is-over-target");
    wm.lastSig = "";
  });
  c.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (!wm.view) return;
    const unit = ev.deltaMode === 1 ? 16 : (ev.deltaMode === 2 ? 400 : 1);
    const dy = Math.max(-400, Math.min(400, ev.deltaY * unit));
    zoomBy(Math.exp(-dy * 0.0018), localPoint(ev));
  }, { passive: false });
  c.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    if (shared.waypoint) setWaypoint(null);
  });
}

function clickAt(p) {
  if (!wm.view) return;
  if (waypointHit(p.x, p.y)) { setWaypoint(null); updateHover(p); return; }
  // Clicking a nearby blip selects it, like a gmRadarUI blip click.
  if (wm.hover?.kind === "dot" && wm.hover.guid) {
    try { window.liveScene3d?.entityManager?.setSelectedTarget?.(wm.hover.guid >>> 0); } catch (_) {}
    return;
  }
  const m = toMapPx(wm.view, p.x, p.y);
  const loc = locationAtMapPx(m.x, m.y, Math.max(1, 4 / wm.view.scale));
  if (loc) {
    setWaypoint({ ew: loc.ew, ns: loc.ns, label: loc.name });
  } else {
    if (m.x < 0 || m.y < 0 || m.x > MAP_W || m.y > MAP_H) return;
    const cc = mapPxToCoords(m.x, m.y);
    setWaypoint({ ew: cc.ew, ns: cc.ns, label: "" });
  }
  updateHover(p);
}

function updateHover(p) {
  if (!wm.view) return;
  const m = toMapPx(wm.view, p.x, p.y);
  let hover = null;
  if (waypointHit(p.x, p.y)) {
    const wp = shared.waypoint;
    hover = { kind: "pin", title: wp.label ? `Waypoint: ${wp.label}` : "Waypoint", sub: `${formatCoords(wp.ew, wp.ns)} · click to remove` };
  }
  if (!hover && wm.dots) {
    let best = null;
    let bestD = 7;
    for (const dot of wm.dots) {
      const dd = Math.hypot(p.x - dot.x, p.y - dot.y);
      if (dd < bestD) { best = dot; bestD = dd; }
    }
    if (best) hover = { kind: "dot", title: best.name, sub: best.sub, guid: best.guid };
  }
  if (!hover) {
    const loc = locationAtMapPx(m.x, m.y, Math.max(1, 4 / wm.view.scale));
    if (loc) hover = { kind: "town", loc, title: loc.name, sub: `${townSub(loc)} · click to set a waypoint` };
  }
  wm.hover = hover;
  wm.canvas.classList.toggle("is-over-target", !!hover);
  const tip = wm.tipEl;
  if (!hover) {
    tip.style.display = "none";
  } else {
    setTip(tip, hover.title, hover.sub);
    tip.style.display = "block";
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = p.x + 14;
    let y = p.y + 16;
    if (x + tw > wm.w - 4) x = p.x - tw - 10;
    if (y + th > wm.h - 4) y = p.y - th - 10;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  }
  wm.lastSig = "";
}

export function isWorldMapOpen() { return wm.open; }

export function openWorldMap(opts = {}) {
  if (typeof document === "undefined") return;
  ensureOverlay();
  const wasOpen = wm.open;
  wm.open = true;
  wm.root.hidden = false;
  if (!wasOpen) {
    clampOverlayToViewport();
    attachOverlayPosition();
  }
  resizeCanvas();
  const now = performance.now();
  const fix = sampleFix(now);
  if (opts.centreMapPx) {
    wm.prefs.follow = false;
    const s = Math.max(wm.view?.scale ?? 0, FOLLOW_SCALE);
    setView(centreView(s, wm.w, wm.h, opts.centreMapPx.x, opts.centreMapPx.y));
  } else if (!wasOpen) {
    if (wm.prefs.follow && Number.isFinite(fix.ew)) {
      const p = coordsToMapPx(fix.ew, fix.ns);
      setView(centreView(Math.max(minScale(), wm.prefs.scale), wm.w, wm.h, p.x, p.y));
    } else if (!wm.view) {
      setView(fitView(wm.w, wm.h));
    }
  }
  if (!wm.view) setView(fitView(wm.w, wm.h));
  wm.lastSig = "";
  if (!wm.raf) wm.raf = requestAnimationFrame(overlayTick);
  try { wm.root.focus({ preventScroll: true }); } catch (_) {}
}

export function closeWorldMap() {
  if (!wm.open) return;
  wm.open = false;
  wm.root.hidden = true;
  wm.drag = null;
  wm.hover = null;
  wm.tipEl.style.display = "none";
  if (wm.raf) cancelAnimationFrame(wm.raf);
  wm.raf = 0;
  savePrefs();
}

export function toggleWorldMap(opts) {
  if (wm.open) closeWorldMap();
  else openWorldMap(opts);
}

function overlayTick(now) {
  wm.raf = wm.open ? requestAnimationFrame(overlayTick) : 0;
  if (!wm.open) return;
  if (!wm.w) resizeCanvas();
  if (!wm.view || !wm.w) return;
  const fix = sampleFix(now);
  if (wm.prefs.follow && Number.isFinite(fix.ew) && !wm.drag) {
    const p = coordsToMapPx(fix.ew, fix.ns);
    const v = centreView(wm.view.scale, wm.w, wm.h, p.x, p.y);
    if (Math.abs(v.ox - wm.view.ox) > 0.01 || Math.abs(v.oy - wm.view.oy) > 0.01) wm.view = v;
  }
  // Live layers (blips, roster) refresh at ~10 Hz; everything else only
  // redraws when the signature changes.
  const live = Math.floor(now / 100);
  const v = wm.view;
  const sig = [
    v.scale.toFixed(4), v.ox.toFixed(1), v.oy.toFixed(1),
    Number.isFinite(fix.ew) ? fix.ew.toFixed(3) : "-", Number.isFinite(fix.ns) ? fix.ns.toFixed(3) : "-",
    fix.bearing == null ? "-" : fix.bearing.toFixed(0), fix.place, shared.waypointRev,
    wm.prefs.blips && v.scale >= BLIP_MIN_SCALE ? live : (shared.roster.size ? Math.floor(now / 1000) : 0),
    wm.imgs.map.complete ? 1 : 0,
  ].join("|");
  if (sig !== wm.lastSig) {
    wm.lastSig = sig;
    drawWorldMap(fix);
  }
  updateStatus(fix);
}

function updateStatus(fix) {
  const me = `You: ${describeFix(fix)}`;
  if (me !== wm.lastMe) { wm.lastMe = me; wm.meEl.textContent = me; }
  let cur = "Scroll to zoom · drag to pan · click to drop a waypoint";
  if (wm.cursor && wm.view) {
    const m = toMapPx(wm.view, wm.cursor.x, wm.cursor.y);
    if (m.x >= 0 && m.y >= 0 && m.x <= MAP_W && m.y <= MAP_H) {
      const c = mapPxToCoords(m.x, m.y);
      cur = `Cursor: ${formatCoords(c.ew, c.ns)}`;
    }
  }
  if (cur !== wm.cursorEl.textContent) wm.cursorEl.textContent = cur;
  const wp = shared.waypoint;
  let pin = "";
  if (wp) {
    pin = `${wp.label || "Waypoint"} ${formatCoords(wp.ew, wp.ns)}`;
    if (fix.live && Number.isFinite(fix.ew)) {
      const vec = waypointVector(fix, wp);
      pin += vec.metres < 5 ? " · here" : ` · ${formatDistance(vec.metres)} ${vec.compass}`;
    }
  }
  if (pin !== wm.lastPin) {
    wm.lastPin = pin;
    wm.pinWrap.hidden = !wp;
    wm.pinEl.textContent = pin;
  }
  const d = shared.date;
  const dk = d ? `${d.date} · ${d.time}` : "";
  if (dk !== wm.lastDate) {
    wm.lastDate = dk;
    if (d) setAcText(wm.dateEl, dk, { fit: true });
    else wm.dateEl.textContent = "";
  }
}

// ── Canvas drawing ──────────────────────────────────────────────────

function drawWorldMap(fix) {
  const { ctx, w, h, k, view } = wm;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.fillStyle = "#16110a";
  ctx.fillRect(0, 0, w, h);
  const map = wm.imgs.map;
  if (map.complete && map.naturalWidth) {
    ctx.imageSmoothingEnabled = !mapIsCrisp(view.scale * k);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(map, view.ox, view.oy, MAP_W * view.scale, MAP_H * view.scale);
  }
  ctx.imageSmoothingEnabled = true;
  if (wm.prefs.grid) drawGrid();
  wm.dots = []; // hover targets collected while drawing (local px)
  drawHouse();
  drawRoster();
  if (wm.prefs.blips && view.scale >= BLIP_MIN_SCALE && fix.live) drawBlips();
  drawWaypoint(fix);
  drawPlayer(fix);
  if (wm.prefs.towns) drawTownLabels();
  if (wm.hover?.kind === "town") {
    const l = wm.hover.loc;
    const a = toLocalPx(view, l.x, l.y);
    ctx.strokeStyle = "rgba(243, 210, 122, 0.95)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x - 2, a.y - 2, l.w * view.scale + 4, l.h * view.scale + 4);
  }
  drawScaleBar();
}

function drawGrid() {
  const { ctx, w, h, view } = wm;
  const pxPerCoord = MAP_PX_PER_COORD * view.scale;
  const tl = toMapPx(view, 0, 0);
  const br = toMapPx(view, w, h);
  const cTL = mapPxToCoords(tl.x, tl.y);
  const cBR = mapPxToCoords(br.x, br.y);
  const ewMin = Math.max(-102, cTL.ew);
  const ewMax = Math.min(103, cBR.ew);
  const nsMin = Math.max(-102, cBR.ns);
  const nsMax = Math.min(103, cTL.ns);

  // Landblock lines (192 m = 0.8 coords) once they are ≥ ~10 px apart.
  if (view.scale >= LB_LINES_MIN_SCALE) {
    ctx.strokeStyle = "rgba(20, 12, 0, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let lb = Math.max(0, Math.floor((ewMin + COORD_ORIGIN) / 0.8)); lb <= Math.min(255, Math.ceil((ewMax + COORD_ORIGIN) / 0.8)); lb++) {
      const x = toLocalPx(view, coordsToMapPx(lb * 0.8 - COORD_ORIGIN, 0).x, 0).x;
      ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h);
    }
    for (let lb = Math.max(0, Math.floor((nsMin + COORD_ORIGIN) / 0.8)); lb <= Math.min(255, Math.ceil((nsMax + COORD_ORIGIN) / 0.8)); lb++) {
      const y = toLocalPx(view, 0, coordsToMapPx(0, lb * 0.8 - COORD_ORIGIN).y).y;
      ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }

  // Labelled coordinate graticule.
  const step = gridStep(pxPerCoord);
  const dec = step < 1 ? 1 : 0;
  ctx.font = `11px ${wm.font}`;
  ctx.lineWidth = 1;
  ctx.textBaseline = "top";
  const label = (txt, x, y, align) => {
    ctx.textAlign = align;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = "rgba(243, 222, 170, 0.95)";
    ctx.fillText(txt, x, y);
  };
  const fmtLine = (v, pos, neg) => (Math.abs(v) < 1e-9 ? "0" : `${Math.abs(v).toFixed(dec)}${v > 0 ? pos : neg}`);
  ctx.strokeStyle = "rgba(40, 24, 4, 0.45)";
  ctx.beginPath();
  const xs = [];
  for (let v = Math.ceil(ewMin / step) * step; v <= ewMax + 1e-9; v += step) {
    const x = Math.round(toLocalPx(view, coordsToMapPx(v, 0).x, 0).x) + 0.5;
    ctx.moveTo(x, 0); ctx.lineTo(x, h);
    xs.push([v, x]);
  }
  const ys = [];
  for (let v = Math.ceil(nsMin / step) * step; v <= nsMax + 1e-9; v += step) {
    const y = Math.round(toLocalPx(view, 0, coordsToMapPx(0, v).y).y) + 0.5;
    ctx.moveTo(0, y); ctx.lineTo(w, y);
    ys.push([v, y]);
  }
  ctx.stroke();
  for (const [v, x] of xs) if (x > 24 && x < w - 24) label(fmtLine(v, "E", "W"), x, 3, "center");
  for (const [v, y] of ys) if (y > 18 && y < h - 30) label(fmtLine(v, "N", "S"), 4, y - 6, "left");
}

function drawTownLabels() {
  const { ctx, w, h, view } = wm;
  const showOutposts = view.scale >= 3.5;
  ctx.font = `12px ${wm.font}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const items = [];
  const metas = [];
  for (const loc of MAP_LOCATIONS) {
    if (loc.tier === 2 && !showOutposts) continue;
    const a = toLocalPx(view, loc.x + loc.w, loc.cy);
    const tw = ctx.measureText(loc.name).width;
    // Islands and the big 9×8 town icons claim space first, outposts last.
    items.push({ x: a.x + 3, y: a.y - 8, w: tw + 4, h: 16, priority: (loc.tier === 1 ? 0 : 10) + (16 - loc.w) });
    metas.push({ loc, tx: a.x + 4, ty: a.y });
  }
  const keep = placeLabels(items, w, h);
  ctx.lineJoin = "round";
  for (const i of keep) {
    const { loc, tx, ty } = metas[i];
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(10, 6, 0, 0.88)";
    ctx.strokeText(loc.name, tx, ty);
    ctx.fillStyle = loc.tier === 1 ? "#f6e7b6" : "#d8c99c";
    ctx.fillText(loc.name, tx, ty);
  }
}

function drawHouse() {
  const hs = shared.house;
  const img = wm.imgs.house;
  if (!hs || !img.complete || !img.naturalWidth) return;
  const p = coordsToMapPx(hs.ew, hs.ns);
  const a = toLocalPx(wm.view, p.x, p.y);
  const s = wm.view.scale >= 6 ? 12 : 8;
  wm.ctx.drawImage(img, a.x - s / 2, a.y - s / 2, s, s);
  wm.dots.push({ x: a.x, y: a.y, name: "Your house", sub: formatCoords(hs.ew, hs.ns) });
}

function drawRoster() {
  const { ctx, view } = wm;
  for (const m of rosterMarkers()) {
    const c = worldToCoords(m.x, m.y);
    const p = coordsToMapPx(c.ew, c.ns);
    const a = toLocalPx(view, p.x, p.y);
    ctx.globalAlpha = m.source === "cached" ? Math.max(0.25, 1 - m.ageMs / ROSTER_STALE_MS) : 1;
    ctx.fillStyle = m.kind === "fellow" ? "#00ff00" : "#d8b24a";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;
    const age = m.source === "cached" ? `last seen ${Math.round(m.ageMs / 1000)} s ago` : (m.kind === "fellow" ? "Fellow" : "Allegiance");
    wm.dots.push({ x: a.x, y: a.y, name: m.name || "Unknown", sub: age });
  }
}

function drawBlips() {
  const em = window.liveScene3d?.entityManager?.entityMap;
  if (!em || typeof em[Symbol.iterator] !== "function") return;
  const { ctx, view, w, h } = wm;
  const localGuid = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
  const myZ = em.get?.(localGuid)?.root?.position?.z;
  let n = 0;
  for (const [guid, inst] of em) {
    if (n >= MAX_BLIPS) break;
    const g = guid >>> 0;
    if (g === localGuid) continue;
    const pos = inst?.root?.position;
    if (!pos || typeof pos.x !== "number") continue;
    let cls = null;
    try { const wo = window.__wom?.get?.(g); cls = wo?.canonicalObjectClass || wo?.className || null; } catch (_) {}
    const kind = blipKindOf(cls, inst.meta);
    if (!kind) continue;
    const c = worldToCoords(pos.x, pos.y);
    const p = coordsToMapPx(c.ew, c.ns);
    const a = toLocalPx(view, p.x, p.y);
    if (a.x < -4 || a.y < -4 || a.x > w + 4 || a.y > h + 4) continue;
    ctx.fillStyle = blipColor(kind, inst.meta?.radarColor);
    // gmRadarUI::DrawBlip: |Δz| ≥ 5 m draws at 0.65 intensity.
    ctx.globalAlpha = Number.isFinite(myZ) && Math.abs((pos.z ?? myZ) - myZ) >= 5 ? 0.65 : 1;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
    ctx.lineWidth = 1;
    ctx.stroke();
    const name = (typeof inst.meta?.name === "string" && inst.meta.name) || (typeof inst.root?.name === "string" && inst.root.name) || "";
    if (name) wm.dots.push({ x: a.x, y: a.y, name, sub: `${formatCoords(c.ew, c.ns)} · click to select`, guid: g });
    n += 1;
  }
}

let pinPath = null;
function drawWaypoint(fix) {
  const wp = shared.waypoint;
  if (!wp) return;
  const { ctx, view } = wm;
  const p = coordsToMapPx(wp.ew, wp.ns);
  const a = toLocalPx(view, p.x, p.y);
  if (fix.live && Number.isFinite(fix.ew)) {
    const q = coordsToMapPx(fix.ew, fix.ns);
    const b = toLocalPx(view, q.x, q.y);
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(a.x, a.y); ctx.stroke();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(243, 210, 122, 0.95)";
    ctx.stroke();
    ctx.restore();
  }
  if (!pinPath && typeof Path2D === "function") pinPath = new Path2D(PIN_PATH);
  if (!pinPath) return;
  ctx.save();
  ctx.translate(a.x - 7.33, a.y - 19.33);
  ctx.scale(2 / 3, 2 / 3);
  ctx.fillStyle = "#f3d27a";
  ctx.strokeStyle = "#1a1208";
  ctx.lineWidth = 2;
  ctx.fill(pinPath);
  ctx.stroke(pinPath);
  ctx.fillStyle = "#a3271b";
  ctx.beginPath(); ctx.arc(11, 11, 3.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawPlayer(fix) {
  if (!Number.isFinite(fix.ew)) return;
  const { ctx, view } = wm;
  const p = coordsToMapPx(fix.ew, fix.ns);
  const a = toLocalPx(view, p.x, p.y);
  ctx.save();
  ctx.globalAlpha = fix.live ? 1 : 0.45;
  if (fix.live) {
    ctx.fillStyle = "rgba(140, 255, 90, 0.18)";
    ctx.beginPath(); ctx.arc(a.x, a.y, 13, 0, Math.PI * 2); ctx.fill();
  }
  const ring = wm.imgs.ring;
  if (ring.complete && ring.naturalWidth) {
    ctx.drawImage(ring, a.x - 8.5, a.y - 8, 17, 16);
  } else {
    ctx.strokeStyle = "#5c9"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(a.x, a.y, 7, 0, Math.PI * 2); ctx.stroke();
  }
  if (fix.bearing != null) {
    ctx.translate(a.x, a.y);
    ctx.rotate((fix.bearing * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -17); ctx.lineTo(5, -9); ctx.lineTo(-5, -9); ctx.closePath();
    ctx.fillStyle = "#c8ff7a";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    ctx.lineWidth = 1.2;
    ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function drawScaleBar() {
  const { ctx, h, view } = wm;
  const sb = scaleBarFor(view.scale);
  const x = 10;
  const y = h - 14;
  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + sb.px, y); ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#f3d27a";
  ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + sb.px, y); ctx.lineTo(x + sb.px, y - 4); ctx.stroke();
  ctx.font = `11px ${wm.font}`;
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  ctx.strokeText(sb.label, x, y - 5);
  ctx.fillStyle = "#f3e3b0";
  ctx.fillText(sb.label, x, y - 5);
  ctx.restore();
}

// ── Global keys + console hook ──────────────────────────────────────
// Esc closes the world map; the rebindable "World Map (toggle)" local
// action (default M) toggles it. Listens on window (bubble) so the
// gameplay handler on document wins for any key it consumes
// (defaultPrevented), and typing in chat/inputs never opens the map.
if (typeof window !== "undefined" && typeof window.addEventListener === "function" && !window.__hbWorldMapKeysBound) {
  window.__hbWorldMapKeysBound = true;
  window.addEventListener("keydown", (ev) => {
    const t = ev.target;
    const tag = t?.tagName;
    const typing = tag === "TEXTAREA" || tag === "SELECT" || !!t?.isContentEditable
      || (tag === "INPUT" && !/^(checkbox|radio|button|range)$/i.test(t.type || ""));
    // "Close Panel / Popover" local action (default Escape) — the same
    // rebindable close key the spellbook / vendor windows honour.
    let closeB = null;
    try { closeB = resolveLocalBinding(LOCAL_ACTION_IDS?.CLOSE ?? "0xFF000010", "Escape"); } catch (_) { closeB = null; }
    if (ev.key === "Escape" || (closeB && matchesBinding(ev, closeB))) {
      if (wm.open && (!typing || wm.root.contains(t))) { closeWorldMap(); ev.preventDefault(); }
      if (ev.key === "Escape") return;
    }
    if (typing || tag === "INPUT") return;
    if (ev.defaultPrevented || ev.repeat) return;
    let binding = null;
    try { binding = resolveLocalBinding(WORLD_MAP_ACTION_ID, "KeyM"); } catch (_) { binding = null; }
    if (binding && matchesBinding(ev, binding)) {
      ev.preventDefault();
      toggleWorldMap();
    }
  });
  window.__worldMap = {
    open: openWorldMap, close: closeWorldMap, toggle: toggleWorldMap, isOpen: isWorldMapOpen,
    setWaypoint: (ew, ns, label = "") => setWaypoint({ ew, ns, label }),
    clearWaypoint: () => setWaypoint(null),
    fix: () => (shared.fix ? { ...shared.fix } : null),
  };
}

export const manifest = {
  id: "map-panel",
  name: "Map",
  icon: "🗺",
  iconHidden: true,
  version: "0.2.0",
  description: "Map of Dereth (gmMapUI 0x21000026) + expanded world map (M)",
};
