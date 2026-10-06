// Top-right compass/radar disk — retail gmRadarUI, floaty layout 0x21000074
// (120×140: 120×120 disk + 120×18 coordinates strip).
//
// HUD overhaul 2026-10-05 — rewritten against the decomp. The previous build
// was NORTH-UP and its header claimed retail DrawObjects was too. It is not,
// and that is why the owner saw the radar as "busted and inverted": the disk
// sprite's lighter wedge (the player's view cone) always points UP, so with
// north-up blips it pointed the wrong way whenever you weren't facing north.
// What retail actually does (all cited functions are in ~/ac-headers/acclient.c):
//
//   * gmRadarUI::DrawObjects — every blip goes through
//     SmartBox::convert_to_player_space = Position::localtolocal(player frame,
//     object) ⇒ v is in PLAYER space (x = right, y = forward). Pixel =
//     (trunc(cx + v.x·R/range), trunc(cy − v.y·R/range)); skipped when
//     v.x²+v.y² ≥ (range−1)²; intensity 0.65 when |v.z| ≥ 5 (colour × 0.65).
//     ⇒ HEADING-UP: forward is up, your right is right.
//   * gmRadarUI::UpdateCompassTokens — the N/E/S/W tokens orbit the rim by
//     CPhysicsObj::get_heading (degrees, 0 = north, clockwise): token at angle
//     a = h + {N: π, E: π/2, S: 0, W: 3π/2}, x = cx + sin(a)·mag,
//     y = cy + cos(a)·mag (screen y down); mag = the token's layout distance
//     from the centre (gmRadarUI::PostInit). Facing east puts N on the LEFT.
//   * gmRadarUI::DrawChildren — the player marker is a bright-green 5×5 plus
//     at the centre (FillArea centre + DrawEdges + the four ±2 pixels).
//   * gmRadarUI::DrawBlip + Draw{Point,Hollow,Cross,X,XBox,Triangle,
//     InvertedTriangle,Selected} — pixel-art shapes; selected target gets the
//     DrawSelected 4-bar bracket. GetBlipShape: fellowship leader ▲, fellow ▼,
//     allegiance member □, mutual PK/PK-lite ×, everyone else +.
//   * gmRadarUI::GetBlipColor — ported once in scene3d/selection_brackets.js
//     (`blipColorForEntity`); the radar reuses it so blip and target-bracket
//     colours can never disagree.
//   * ACCWeenieObject::InqShowableOnRadar — only RadarBehavior (PropertyInt
//     ShowableOnRadar 133) ∈ {ShowMovement 2, ShowAttacking 3, ShowAlways 4}
//     is listed. Pure membership: a standing ShowMovement monster still blips.
//   * CPlayerSystem::GetRadarRadius — range 75 m outdoors, 25 m indoors.
//   * gmRadarUI::UpdateCoordinates / CPlayerSystem::InqPlayerCoords /
//     LandDefs::gid_to_lcoord — "%.1f%s,%.1f%s" (NS first, no space), from the
//     player's OUTDOOR CELL (cell-centre, 0.1 per 24 m cell); hidden indoors and
//     when the "Show coordinates by the radar" option (CharacterOption 0x14,
//     PlayerModule::CoordinatesOnRadar) is off.
//   * gmRadarUI::ListenToElementMessage — clicking the radar selects
//     m_iidObjectUnderMouse = the closest blip within 6 px (DrawObjects).
//   * gmRadarUI::UpdateLockedStatus — lock sprite LockedUI 0x060074B7 /
//     UnlockedUI 0x060074B8; the drag button (0x060074C9, cursor 0x06006119)
//     is hidden while locked.
//
// Data sources: the local pose comes from the wasm session
// (`getLocalPlayerPose`, via scene3d/frame_pose.js which frees the box) so
// the heading, coordinates and range work from the first in-world frame and
// under ?nullRender=1. Blips prefer the scene's smoothed entity positions
// (`liveScene3d.entityManager`) and fall back to the wasm world state
// (`nearbyEntityGuids` + `objectPosition`) while the scene isn't up yet.
//
// Rendering: blips + centre marker are drawn into one <canvas> in retail
// pixel units (120×120 logical) with a backing store of round(zoom·dpr)
// device pixels per retail pixel, so the pixel-art stays crisp at every
// HUD scale (ui/hud_scale.js). The pure maths is exported for
// test_radar_projection.mjs.

import { setAcText } from "../ui/ac_font.js";
import { attachWindowPosition, WINDOW_ID } from "../ui/ac_window_position.js";
import { getHudScale, hudRect, hudViewport, HUD_SCALE_EVENT } from "../ui/hud_scale.js";
import { readLocalPlayerPose } from "../scene3d/frame_pose.js";
import { blipColorForEntity, readFellowshipRoster } from "../scene3d/selection_brackets.js";

const OVERLAY_ID = "hb-radar";
const TOOLTIP_ID = "hb-radar-tooltip";
const SPRITES = "./data/ui-sprites";

// ── Retail geometry (layout 0x21000074, data/retail-layouts/0x21000074.json) ──
// Root RootFloatyRadar_Field 0x100006D3 carries the gmRadarUI attributes:
// 0x1000002D RadarRadius = 50, 0x1000002E CenterPoint = (60, 60).
export const RADAR_GEOMETRY = Object.freeze({ size: 120, cx: 60, cy: 60, radius: 50 });
const WIDTH = 120;
const HEIGHT = 140;
// Child rects (x, y, w, h) straight from the layout.
const RECT_COORDS = Object.freeze({ x: 0, y: 120, w: 120, h: 18 }); // RadarCoords 0x1000003E
const RECT_LOCK = Object.freeze({ x: 6, y: 6, w: 27, h: 27 });      // LockUI 0x10000619
const RECT_DRAG = Object.freeze({ x: 87, y: 6, w: 27, h: 27 });     // RadarDrag 0x100006A3
/** N/E/S/W token rects at heading 0 (RadarNorth..RadarWest 0x10000040-43). */
export const RADAR_TOKEN_RECTS = Object.freeze({
  n: Object.freeze({ x: 55, y: 1, w: 10, h: 9, sprite: "0x060011FB" }),
  e: Object.freeze({ x: 110, y: 55, w: 10, h: 9, sprite: "0x06001938" }),
  s: Object.freeze({ x: 55, y: 110, w: 10, h: 9, sprite: "0x0600193A" }),
  w: Object.freeze({ x: 0, y: 55, w: 10, h: 9, sprite: "0x0600193C" }),
});
// UpdateCompassTokens angle offsets added to the heading (radians).
const TOKEN_ANGLE = Object.freeze({ n: Math.PI, e: Math.PI / 2, s: 0, w: 1.5 * Math.PI });

/** CPlayerSystem::GetRadarRadius. */
export const RADAR_RANGE_OUTDOOR = 75;
export const RADAR_RANGE_INDOOR = 25;

// Retail repaints the radar from gmRadarUI::UseTime every 0.025 s.
const UPDATE_INTERVAL_MS = 25;
const MAX_BLIPS = 200;
// DrawObjects: an object is "under the mouse" within 6 px (dist² ≤ 0x24).
const PICK_RADIUS_SQ = 36;
// Per-guid property cache lifetime (radar look changes are rare —
// gmRadarUI::RecvNotice_ChangeRadarLook).
const INFO_TTL_MS = 2000;

// PropertyInt / PropertyInstanceId ids (ACE Properties/*.cs).
const PROP_INT_ITEM_TYPE = 1;
const PROP_INT_SHOWABLE_ON_RADAR = 133;
const PROP_IID_MONARCH = 26;
// CharacterOption::ShowCoordinatesByTheRadar (holtburger-common character.rs).
const OPT_COORDS_ON_RADAR = 0x14;

// ObjectDescriptionFlag bits (ACE ObjectDescriptionFlag.cs).
const ODF_PLAYER = 0x00000008;
const ODF_ATTACKABLE = 0x00000010;
const ODF_PLAYER_KILLER = 0x00000020;
const ODF_UI_HIDDEN = 0x00000080;
const ODF_VENDOR = 0x00000200;
const ODF_CORPSE = 0x00002000;
const ODF_LIFESTONE = 0x00004000;
const ODF_PORTAL = 0x00040000;
const ODF_PKLITE = 0x02000000;
const ITEM_TYPE_CREATURE = 0x00000010;

const BRIGHT_GREEN = "#00ff00"; // RGBAColor_RadarBrightGreen (player marker)

// ─────────────────────────────────────────────────────────────────────────
// Pure maths (exported for test_radar_projection.mjs)
// ─────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
// (unsigned __int64) cast: truncate toward zero; `|| 0` folds −0 into 0.
const trunc0 = (v) => Math.trunc(v) || 0;

/**
 * `LocalPlayerPose.heading` is the raw quaternion yaw θ = atan2(2(wz+xy),
 * 1−2(y²+z²)) — counter-clockwise about +Z, with AC forward = (−sinθ, cosθ)
 * (ACE Position.InFrontOf; scene3d/camera.js AUTOFOLLOW notes). Retail's
 * compass heading (Frame::get_heading / set_heading: forward = (sin h, cos h),
 * 0 = north, 90° = east) is therefore h = −θ. Returns radians in [0, 2π).
 * (The d.ts comment "yaw = π/2 → facing +X (east)" has the sign backwards.)
 */
export function compassHeadingFromPoseYaw(yaw) {
  const y = Number(yaw);
  if (!Number.isFinite(y)) return 0;
  const h = (-y) % TAU;
  return h < 0 ? h + TAU : h;
}

/**
 * World delta (dx east, dy north) → player space (x right, y forward) for a
 * compass heading h — SmartBox::convert_to_player_space.
 */
export function toPlayerSpace(dx, dy, heading) {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/**
 * gmRadarUI::DrawObjects projection. Returns integer retail pixel coords in
 * the 120×120 disk, or null when outside the radar range / disk box.
 */
export function projectToRadar(dx, dy, heading, range = RADAR_RANGE_OUTDOOR, geom = RADAR_GEOMETRY) {
  const v = toPlayerSpace(dx, dy, heading);
  const r1 = range - 1;
  if (v.x * v.x + v.y * v.y >= r1 * r1) return null;
  const k = geom.radius / range;
  const x = trunc0(v.x * k + geom.cx);
  const y = trunc0(geom.cy - k * v.y);
  if (x < geom.cx - geom.radius || x > geom.cx + geom.radius
      || y < geom.cy - geom.radius || y > geom.cy + geom.radius) return null;
  return { x, y, vx: v.x, vy: v.y };
}

/** Distance from the centre to a token's layout centre (gmRadarUI::PostInit). */
export function tokenMagnitude(dir, geom = RADAR_GEOMETRY) {
  const r = RADAR_TOKEN_RECTS[dir];
  const ex = r.x + r.w / 2 - geom.cx;
  const ey = r.y + r.h / 2 - geom.cy;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * gmRadarUI::UpdateCompassTokens — top-left of the `dir` token ("n" | "e" |
 * "s" | "w") for compass heading h (radians).
 */
export function compassTokenPosition(dir, heading, geom = RADAR_GEOMETRY) {
  const r = RADAR_TOKEN_RECTS[dir];
  const a = heading + TOKEN_ANGLE[dir];
  const mag = tokenMagnitude(dir, geom);
  const cx = Math.sin(a) * mag + geom.cx;
  const cy = Math.cos(a) * mag + geom.cy;
  // Retail casts with (unsigned __int64) — truncation toward zero, so the W
  // token at heading 0 (centre x = 60 − 55.002) lands on 0, not −1.
  return { left: trunc0(cx - r.w * 0.5), top: trunc0(cy - r.h * 0.5) };
}

/** An outdoor LandCell (cell index 1..0x40 — SmartBox::is_player_outside). */
export function isOutdoorCell(cellId) {
  const c = (cellId >>> 0) & 0xffff;
  return c >= 1 && c <= 0x40;
}

/** CPlayerSystem::GetRadarRadius. */
export function radarRangeForCell(cellId) {
  return isOutdoorCell(cellId) ? RADAR_RANGE_OUTDOOR : RADAR_RANGE_INDOOR;
}

/**
 * Outdoor cell id for a landblock-local position (cell = cx·8 + cy + 1, 24 m
 * cells). Keeps the landblock bytes of `landblockId`.
 */
export function outdoorCellId(landblockId, x, y) {
  const cx = Math.max(0, Math.min(7, Math.floor(Number(x) / 24)));
  const cy = Math.max(0, Math.min(7, Math.floor(Number(y) / 24)));
  return (((landblockId >>> 0) & 0xffff0000) | (cx * 8 + cy + 1)) >>> 0;
}

/**
 * CPlayerSystem::InqPlayerCoords via LandDefs::gid_to_lcoord. Returns
 * {ew, ns} map coordinates (east/north positive) or null for an indoor /
 * invalid cell (retail then hides the coordinates).
 */
export function mapCoordsForCell(cellId) {
  const id = cellId >>> 0;
  if (!isOutdoorCell(id)) return null;
  const cell = id & 0xffff;
  const lx = ((id >>> 21) & 0x7f8) + ((cell - 1) >>> 3);
  const ly = 8 * ((id >>> 16) & 0xff) + ((cell - 1) & 7);
  if (lx < 0 || ly < 0 || lx >= 2040 || ly >= 2040) return null;
  return { ew: (lx - 1024) * 0.1 + 0.5, ns: (ly - 1024) * 0.1 + 0.5 };
}

/** gmRadarUI::UpdateCoordinates format: "%.1f%s,%.1f%s" — NS first. */
export function formatRadarCoords(ew, ns) {
  const nsSuffix = ns > 0 ? "N" : ns < 0 ? "S" : "";
  const ewSuffix = ew > 0 ? "E" : ew < 0 ? "W" : "";
  return `${Math.abs(ns).toFixed(1)}${nsSuffix},${Math.abs(ew).toFixed(1)}${ewSuffix}`;
}

/** Coordinates-strip text for a cell; "" means the strip is hidden. */
export function radarCoordsText(cellId) {
  const c = mapCoordsForCell(cellId);
  return c ? formatRadarCoords(c.ew, c.ns) : "";
}

/** ACCWeenieObject::InqShowableOnRadar (RadarBehavior 2/3/4). */
export function isShowableOnRadar(radarBehavior) {
  const b = Number(radarBehavior);
  return b === 2 || b === 3 || b === 4;
}

/** Retail RadarBlipShape values (DrawBlip switch). */
export const BLIP_SHAPE = Object.freeze({
  NONE: 0, POINT: 1, HOLLOW: 2, X: 3, CROSS: 4, TRIANGLE: 5, INVERTED_TRIANGLE: 6, X_BOX: 7,
});

/**
 * gmRadarUI::GetBlipShape.
 * @param {{objDescFlags?:number, guid?:number, monarch?:number}} obj
 * @param {{objDescFlags?:number, monarch?:number}|null} player
 * @param {{leaderGuid:number, members:Set<number>}|null} fellowship
 */
export function blipShapeFor(obj, player, fellowship) {
  const odf = (obj?.objDescFlags >>> 0) || 0;
  if (odf & ODF_UI_HIDDEN) return BLIP_SHAPE.NONE;
  const guid = (obj?.guid >>> 0) || 0;
  if (fellowship && guid) {
    if (guid === (fellowship.leaderGuid >>> 0)) return BLIP_SHAPE.TRIANGLE;
    if (fellowship.members?.has?.(guid)) return BLIP_SHAPE.INVERTED_TRIANGLE;
  }
  if (!player) return BLIP_SHAPE.CROSS;
  const monarch = (obj?.monarch >>> 0) || 0;
  if (monarch && monarch === ((player.monarch >>> 0) || 0)) return BLIP_SHAPE.HOLLOW;
  const podf = (player.objDescFlags >>> 0) || 0;
  if (((odf & ODF_PLAYER_KILLER) && (podf & ODF_PLAYER_KILLER))
      || ((odf & ODF_PKLITE) && (podf & ODF_PKLITE))) return BLIP_SHAPE.X;
  return BLIP_SHAPE.CROSS;
}

// Pixel offsets (flat dx,dy pairs) of the retail Draw* helpers.
const EDGES = [0, -1, 0, 1, -1, 0, 1, 0];       // DrawEdges
const CORNERS = [1, 1, -1, -1, -1, 1, 1, -1];   // DrawCorners
const SHAPE_PIXELS = Object.freeze({
  [BLIP_SHAPE.POINT]: Object.freeze([0, 0]),
  [BLIP_SHAPE.HOLLOW]: Object.freeze([...EDGES, ...CORNERS]),
  [BLIP_SHAPE.X]: Object.freeze([0, 0, ...CORNERS]),
  [BLIP_SHAPE.CROSS]: Object.freeze([0, 0, ...EDGES]),
  [BLIP_SHAPE.TRIANGLE]: Object.freeze([0, 0, -1, 1, 0, 1, 1, 1]),
  [BLIP_SHAPE.INVERTED_TRIANGLE]: Object.freeze([0, 0, -1, -1, 0, -1, 1, -1]),
  [BLIP_SHAPE.X_BOX]: Object.freeze([...EDGES, ...CORNERS, -2, -2, 2, -2, -2, 2, 2, 2]),
});
/** gmRadarUI::DrawSelected — four 5-px bars 3 px out from the blip. */
export const SELECTED_PIXELS = Object.freeze((() => {
  const out = [];
  for (let i = -2; i <= 2; i++) out.push(i, 3, 3, i, i, -3, -3, i);
  return out;
})());
/** gmRadarUI::DrawChildren — the player's bright-green centre plus. */
export const CENTRE_PIXELS = Object.freeze([0, 0, ...EDGES, -2, 0, 2, 0, 0, -2, 0, 2]);

/** Flat [dx,dy,…] pixel offsets for a RadarBlipShape (empty for NONE). */
export function blipPixels(shape) {
  return SHAPE_PIXELS[shape] || [];
}

/** DrawObjects/DrawBlip: intensity 1.0 within ±5 m of height, else 0.65. */
export function blipIntensity(dz) {
  return Math.abs(Number(dz) || 0) < 5 ? 1.0 : 0.65;
}

/**
 * DrawObjects m_iidObjectUnderMouse: the closest blip whose pixel is within
 * 6 px of the mouse (ties keep the earlier blip). Returns the index or −1.
 */
export function pickBlipUnderMouse(blips, mx, my) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < blips.length; i++) {
    const b = blips[i];
    const ddx = mx - b.x;
    const ddy = my - b.y;
    const d = ddx * ddx + ddy * ddy;
    if (d > PICK_RADIUS_SQ || d >= bestD) continue;
    best = i;
    bestD = d;
  }
  return best;
}

/** Scale a #rrggbb colour's RGB by k (DrawBlip multiplies colour, not alpha). */
export function scaleHexColor(hex, k) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 0xff) * k);
  const g = Math.round(((n >> 8) & 0xff) * k);
  const b = Math.round((n & 0xff) * k);
  return `rgb(${r},${g},${b})`;
}

// ─────────────────────────────────────────────────────────────────────────
// Live data adapters (browser only)
// ─────────────────────────────────────────────────────────────────────────

const RADAR_HOSTILE_ONLY_BY_URL = (() => {
  try {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("radarHostileOnly") === "1";
  } catch (_) { return false; }
})();

function callNum(sh, fn, ...args) {
  try {
    if (!sh || typeof sh[fn] !== "function") return undefined;
    const v = sh[fn](...args);
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch (_) { return undefined; }
}

// Heuristic used only when the wasm bundle can't tell us the RadarBehavior
// (stale pkg/, or the property was never hydrated): living things, vendors,
// portals and lifestones — the classes ACE stamps ShowableOnRadar on.
function fallbackShowable(odf, itemType) {
  if (odf & (ODF_UI_HIDDEN | ODF_CORPSE)) return false;
  if (odf & (ODF_PLAYER | ODF_VENDOR | ODF_PORTAL | ODF_LIFESTONE)) return true;
  return (itemType & ITEM_TYPE_CREATURE) !== 0;
}

const _info = new Map(); // guid → cached radar properties
let _infoPruneAt = 0;

function radarInfoFor(guid, meta, sh, now) {
  let rec = _info.get(guid);
  if (rec && now - rec.t < INFO_TTL_MS) { rec.seen = now; return rec; }
  const odf = (meta?.objDescFlags ?? callNum(sh, "objectDescFlags", guid) ?? 0) >>> 0;
  const itemType = (meta?.itemType ?? callNum(sh, "objectIntProperty", guid, PROP_INT_ITEM_TYPE) ?? 0) >>> 0;
  const behavior = callNum(sh, "objectIntProperty", guid, PROP_INT_SHOWABLE_ON_RADAR);
  const showable = behavior !== undefined
    ? isShowableOnRadar(behavior) && !(odf & ODF_UI_HIDDEN)
    : fallbackShowable(odf, itemType);
  // Same lazy stash as entities.js setSelectedTarget so the target brackets
  // and the radar read one `meta.radarBlipColor`.
  let blipColor = meta?.radarBlipColor;
  if (blipColor === undefined) {
    const v = callNum(sh, "entityRadarBlipColor", guid);
    blipColor = v === undefined ? 0 : (v >>> 0);
    if (v !== undefined && meta) meta.radarBlipColor = blipColor;
  }
  let name = typeof meta?.name === "string" ? meta.name : "";
  if (!name) {
    try { name = sh?.objectName?.(guid) || ""; } catch (_) { name = ""; }
  }
  rec = {
    t: now, seen: now, guid, odf, itemType, showable, blipColor, name,
    monarch: (callNum(sh, "objectInstanceIdProperty", guid, PROP_IID_MONARCH) ?? 0) >>> 0,
  };
  _info.set(guid, rec);
  return rec;
}

function pruneInfo(now) {
  if (now < _infoPruneAt) return;
  _infoPruneAt = now + 5000;
  for (const [g, rec] of _info) if (now - rec.seen > 15000) _info.delete(g);
}

// Slow-changing session state, refreshed at most once a second.
const _slow = { t: -Infinity, fellowship: null, player: null, coordsOn: true };
function refreshSlowState(sh, localGuid, now) {
  if (now - _slow.t < 1000) return;
  _slow.t = now;
  try { _slow.fellowship = readFellowshipRoster(); } catch (_) { _slow.fellowship = null; }
  _slow.player = localGuid ? {
    objDescFlags: (callNum(sh, "objectDescFlags", localGuid) ?? 0) >>> 0,
    monarch: (callNum(sh, "objectInstanceIdProperty", localGuid, PROP_IID_MONARCH) ?? 0) >>> 0,
  } : null;
  // PlayerModule::CoordinatesOnRadar. Unknown (no handle) ⇒ show.
  try {
    if (sh && typeof sh.isCharacterOptionEnabled === "function") {
      _slow.coordsOn = !!sh.isCharacterOptionEnabled(OPT_COORDS_ON_RADAR);
    } else {
      _slow.coordsOn = true;
    }
  } catch (_) { _slow.coordsOn = true; }
}

/** Local player: world-frame position, compass heading and cell. */
function readPlayer(sh, em, localGuid) {
  const pose = readLocalPlayerPose(sh);
  const curCell = (callNum(sh, "getCurrentCellId") ?? 0) >>> 0;
  if (pose && Number.isFinite(pose.x) && Number.isFinite(pose.y)) {
    const lb = pose.landblockId >>> 0;
    return {
      wx: ((lb >>> 24) & 0xff) * 192 + pose.x,
      wy: ((lb >>> 16) & 0xff) * 192 + pose.y,
      z: Number(pose.z) || 0,
      heading: compassHeadingFromPoseYaw(pose.heading),
      landblockId: lb, lx: pose.x, ly: pose.y,
      cellId: curCell || lb,
    };
  }
  // No wasm pose (stale pkg / harness): the scene's own player rig.
  const p = em?.entityMap?.get?.(localGuid)?.root?.position;
  if (!p) return null;
  let heading = 0;
  try { heading = Number(em.getLocalPlayerHeading?.()) || 0; } catch (_) {}
  const lbX = Math.max(0, Math.min(254, Math.floor(p.x / 192)));
  const lbY = Math.max(0, Math.min(254, Math.floor(p.y / 192)));
  const lb = ((lbX << 24) | (lbY << 16)) >>> 0;
  const lx = p.x - lbX * 192;
  const ly = p.y - lbY * 192;
  const h = heading % TAU;
  return {
    wx: p.x, wy: p.y, z: p.z || 0, heading: h < 0 ? h + TAU : h,
    landblockId: lb, lx, ly,
    cellId: curCell || outdoorCellId(lb, lx, ly),
  };
}

/** Blip candidates within range²: [{guid, dx, dy, dz, info, inst}]. */
function gatherCandidates(sh, em, localGuid, player, range, now) {
  const out = [];
  const r2 = range * range;
  const map = em?.entityMap;
  // size > 1: the scene exists but hasn't spawned anyone but us yet (spawns
  // are time-sliced) — the wasm world state already knows the neighbours.
  if (map && typeof map[Symbol.iterator] === "function" && (map.size ?? 0) > 1) {
    for (const [guid, inst] of map) {
      const g = guid >>> 0;
      if (g === localGuid || !inst?.root) continue;
      // A wielded/held object's root is a hand-local frame, not a world pose.
      if (inst._attachedParentGuid != null) continue;
      const p = inst.root.position;
      const dx = p.x - player.wx;
      const dy = p.y - player.wy;
      if (dx * dx + dy * dy >= r2) continue;
      const info = radarInfoFor(g, inst.meta, sh, now);
      if (!info.showable) continue;
      out.push({ guid: g, dx, dy, dz: (p.z || 0) - player.z, info, inst });
    }
    return out;
  }
  // Scene not up yet (first ~35 s in world) or ?nullRender: wasm world state.
  if (!sh || typeof sh.nearbyEntityGuids !== "function"
      || typeof sh.objectPosition !== "function") return out;
  let guids;
  try { guids = sh.nearbyEntityGuids(range + 10); } catch (_) { return out; }
  for (let i = 0; i < (guids?.length || 0) && out.length < MAX_BLIPS * 2; i++) {
    const g = guids[i] >>> 0;
    if (!g || g === localGuid) continue;
    const info = radarInfoFor(g, null, sh, now);
    if (!info.showable) continue;
    let pos;
    try { pos = sh.objectPosition(g); } catch (_) { pos = null; }
    if (!pos || pos.length < 4) continue;
    const lb = pos[0] >>> 0;
    const dx = ((lb >>> 24) & 0xff) * 192 + pos[1] - player.wx;
    const dy = ((lb >>> 16) & 0xff) * 192 + pos[2] - player.wy;
    if (dx * dx + dy * dy >= r2) continue;
    out.push({ guid: g, dx, dy, dz: pos[3] - player.z, info, inst: null });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────────────────

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-radar-style";
  const px = (r) => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;`;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed; top: 8px; right: 8px; z-index: 50;
      width: ${WIDTH}px; height: ${HEIGHT}px;
      pointer-events: none;
      user-select: none; -webkit-user-select: none;
    }
    #${OVERLAY_ID} > * { position: absolute; }
    /* RadarImage 0x1000003F — rim + view-cone wedge (the wedge is the
       player's forward cone: the radar is heading-up). Doubles as the hover /
       click surface; border-radius keeps the transparent corners click-through. */
    #${OVERLAY_ID} .hb-radar-disk {
      left: 0; top: 0; width: 120px; height: 120px;
      background: url("${SPRITES}/0x06004CC1.png") center / 100% 100% no-repeat;
      image-rendering: pixelated;
      border-radius: 50%;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-radar-disk.is-over-blip { cursor: pointer; }
    #${OVERLAY_ID} .hb-radar-token {
      width: 10px; height: 9px;
      background: center / 100% 100% no-repeat;
      image-rendering: pixelated;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-radar-blips {
      left: 0; top: 0; width: 120px; height: 120px;
      image-rendering: pixelated;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-radar-lock,
    #${OVERLAY_ID} .hb-radar-move {
      background: center / 100% 100% no-repeat;
      pointer-events: auto;
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8));
      transition: filter 120ms ease-out;
    }
    #${OVERLAY_ID} .hb-radar-lock {
      ${px(RECT_LOCK)}
      cursor: pointer;
      background-image: url("${SPRITES}/0x060074B8.png"); /* UnlockedUI */
    }
    #${OVERLAY_ID} .hb-radar-lock.is-locked {
      background-image: url("${SPRITES}/0x060074B7.png"); /* LockedUI */
    }
    #${OVERLAY_ID} .hb-radar-move {
      ${px(RECT_DRAG)}
      background-image: url("${SPRITES}/0x060074C9.png");
    }
    #${OVERLAY_ID} .hb-radar-move[hidden] { display: none; }
    #${OVERLAY_ID} .hb-radar-lock:hover,
    #${OVERLAY_ID} .hb-radar-move:hover,
    #${OVERLAY_ID} .hb-radar-lock:focus-visible {
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8)) brightness(1.25);
      outline: none;
    }
    /* RadarCoords 0x1000003E — translucent strip 0x06004CC0 + text. */
    #${OVERLAY_ID} .hb-radar-coords {
      ${px(RECT_COORDS)}
      display: flex; align-items: center; justify-content: center;
      background: url("${SPRITES}/0x06004CC0.png") repeat;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-radar-coords[hidden] { display: none; }
    #${OVERLAY_ID} .hb-radar-hostile {
      left: 0; top: ${HEIGHT}px; width: ${WIDTH}px;
      display: flex; justify-content: center;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-radar-hostile[hidden] { display: none; }
    #${TOOLTIP_ID} {
      white-space: nowrap;
      z-index: 51;
      padding: 2px 6px;
      font-size: 11px;
      line-height: 1.3;
    }
    #${TOOLTIP_ID}[hidden] { display: none; }
    #${TOOLTIP_ID} .hb-radar-tip-swatch {
      display: inline-block; width: 6px; height: 6px; margin-right: 5px;
      vertical-align: 1px; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.8);
    }
    #${TOOLTIP_ID} .hb-radar-tip-dist { color: var(--hbk-text-dim, #a8a090); margin-left: 6px; }
  `;
  document.head.appendChild(style);
}

// Module-level state; mount() owns the lifecycle and teardown resets it.
let _overlayEl = null;
let _hostileEl = null;
let _radarHostileOnly = RADAR_HOSTILE_ONLY_BY_URL;
let _lastSnapshot = null;

function setRadarHostileOnly(enabled) {
  _radarHostileOnly = !!enabled;
  if (_hostileEl) _hostileEl.hidden = !_radarHostileOnly;
}

export const manifest = {
  id: "radar",
  name: "Compass",
  // No bar icon — the radar IS the presentation.
  icon: "🧭",
  iconHidden: true,
  version: "0.2.0",
  description: "Top-right heading-up radar/compass (retail gmRadarUI 0x21000074)",
};

export function mount(_ctx) {
  ensureStyles();
  document.getElementById(OVERLAY_ID)?.remove();
  document.getElementById(TOOLTIP_ID)?.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  const disk = document.createElement("div");
  disk.className = "hb-radar-disk";
  overlay.appendChild(disk);

  const lockBtn = document.createElement("div");
  lockBtn.className = "hb-radar-lock";
  lockBtn.setAttribute("role", "button");
  lockBtn.tabIndex = 0;
  lockBtn.setAttribute("aria-label", "Lock UI");
  lockBtn.setAttribute("aria-pressed", "false");
  lockBtn.title = "Lock UI";
  overlay.appendChild(lockBtn);

  const moveBtn = document.createElement("div");
  moveBtn.className = "hb-radar-move";
  moveBtn.setAttribute("role", "button");
  moveBtn.setAttribute("aria-label", "Move radar");
  moveBtn.title = "Drag to move";
  // RadarDrag's Cursor media (0x06006119, hotspot 16,16).
  moveBtn.style.cursor = `url("${SPRITES}/0x06006119.png") 16 16, move`;
  overlay.appendChild(moveBtn);

  // Tokens draw after the buttons in retail's child order, so a token can
  // pass over the lock/drag buttons as it orbits (pointer-events: none).
  const tokens = {};
  for (const dir of ["n", "e", "s", "w"]) {
    const t = document.createElement("div");
    const r = RADAR_TOKEN_RECTS[dir];
    t.className = `hb-radar-token hb-radar-${dir}`;
    t.style.backgroundImage = `url("${SPRITES}/${r.sprite}.png")`;
    t.style.left = `${r.x}px`;
    t.style.top = `${r.y}px`;
    overlay.appendChild(t);
    tokens[dir] = t;
  }

  // Blips + centre marker — drawn after every child (DrawChildren order).
  const canvas = document.createElement("canvas");
  canvas.className = "hb-radar-blips";
  canvas.width = RADAR_GEOMETRY.size;
  canvas.height = RADAR_GEOMETRY.size;
  overlay.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  const coords = document.createElement("div");
  coords.className = "hb-radar-coords";
  coords.hidden = true;
  overlay.appendChild(coords);

  const hostile = document.createElement("div");
  hostile.className = "hb-radar-hostile";
  hostile.hidden = !_radarHostileOnly;
  setAcText(hostile, "Hostiles only", { color: "#ffd76a" });
  overlay.appendChild(hostile);

  document.body.appendChild(overlay);

  const tooltip = document.createElement("div");
  tooltip.id = TOOLTIP_ID;
  tooltip.className = "hbk-tooltip";
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  _overlayEl = overlay;
  _hostileEl = hostile;

  const winPos = attachWindowPosition(overlay, {
    windowId: WINDOW_ID.RADAR,
    dragHandle: moveBtn,
    lockButton: lockBtn,
    defaultPos: { top: "8px", right: "8px" },
    onLockChange: (locked) => {
      // gmRadarUI::UpdateLockedStatus — LockedUI/UnlockedUI sprite, and the
      // drag button only exists while unlocked.
      lockBtn.classList.toggle("is-locked", locked);
      lockBtn.title = locked ? "Unlock UI" : "Lock UI";
      lockBtn.setAttribute("aria-pressed", locked ? "true" : "false");
      moveBtn.hidden = locked;
      // Backward-compat global hook — other CSS may key off this class.
      document.documentElement.classList.toggle("hb-ui-locked", locked);
    },
  });
  const onLockKey = (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); lockBtn.click(); }
  };
  lockBtn.addEventListener("keydown", onLockKey);

  // ── Hover / click (retail m_iidObjectUnderMouse) ──
  let mouse = null; // retail-pixel coords inside the disk, or null
  let blips = [];   // last drawn blips: {guid, x, y, name, color, dist, dz}
  let hoverGuid = 0;

  const onMove = (ev) => {
    const r = disk.getBoundingClientRect();
    if (!(r.width > 0)) return;
    const s = RADAR_GEOMETRY.size / r.width;
    mouse = { x: (ev.clientX - r.left) * s, y: (ev.clientY - r.top) * s };
    refreshHover();
  };
  const onLeave = () => {
    mouse = null;
    refreshHover();
  };
  const onClick = () => {
    if (!hoverGuid) return;
    try { window.liveScene3d?.entityManager?.setSelectedTarget?.(hoverGuid >>> 0); } catch (_) {}
    lastUpdate = -Infinity; // repaint the DrawSelected bracket immediately
  };
  disk.addEventListener("pointermove", onMove);
  disk.addEventListener("pointerleave", onLeave);
  disk.addEventListener("click", onClick);

  function refreshHover() {
    const idx = mouse ? pickBlipUnderMouse(blips, mouse.x, mouse.y) : -1;
    const b = idx >= 0 ? blips[idx] : null;
    hoverGuid = b ? b.guid : 0;
    disk.classList.toggle("is-over-blip", !!b);
    if (!b) { tooltip.hidden = true; return; }
    // Retail's tooltip is the object name; we add the blip swatch + range.
    const key = `${b.guid}|${b.name}|${b.color}|${Math.round(b.dist)}`;
    if (tooltip.dataset.key !== key) {
      tooltip.dataset.key = key;
      tooltip.textContent = "";
      const sw = document.createElement("span");
      sw.className = "hb-radar-tip-swatch";
      sw.style.background = b.color;
      const nm = document.createElement("span");
      nm.textContent = b.name || "Unknown";
      const dist = document.createElement("span");
      dist.className = "hb-radar-tip-dist";
      dist.textContent = `${Math.round(b.dist)} m`;
      tooltip.append(sw, nm, dist);
    }
    tooltip.hidden = false;
    placeTooltip(b);
  }

  // Tooltip lives in HUD px (it's a zoomed #hb-* body child): position from
  // hudRect()/hudViewport(), never window.innerWidth.
  function placeTooltip(b) {
    const dr = hudRect(disk);
    const s = dr.width / RADAR_GEOMETRY.size || 1;
    const tr = hudRect(tooltip);
    const vp = hudViewport();
    const bx = dr.left + b.x * s;
    const by = dr.top + b.y * s;
    let left = bx - tr.width / 2;
    let top = by - tr.height - 6;
    if (top < 2) top = by + 8; // radar hugs the top edge: flip below the blip
    left = Math.max(2, Math.min(left, vp.width - tr.width - 2));
    top = Math.max(2, Math.min(top, vp.height - tr.height - 2));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  // ── Per-update work ──
  let lastHeading = NaN;
  let lastUpdate = -Infinity;
  let rafId = 0;
  const colorCache = new Map();
  const dimColor = (hex) => {
    let c = colorCache.get(hex);
    if (!c) { c = scaleHexColor(hex, 0.65); colorCache.set(hex, c); }
    return c;
  };

  function placeTokens(heading) {
    if (Math.abs(heading - lastHeading) < 1e-5) return;
    lastHeading = heading;
    for (const dir of ["n", "e", "s", "w"]) {
      const p = compassTokenPosition(dir, heading);
      tokens[dir].style.left = `${p.left}px`;
      tokens[dir].style.top = `${p.top}px`;
    }
  }

  // `canvas.currentCSSZoom` is a computed-style read; update() calls this right
  // after placeTokens() writes token styles, so reading it every frame forced a
  // synchronous style recalc per radar frame (1.3% of main-thread self time at
  // Holtburg on the 1070). Cache it; drop the cache when the HUD zoom changes
  // (hud_scale.js fires HUD_SCALE_EVENT), on resize (covers DPR / browser
  // zoom), and every 2 s as a safety net for anything else that moves it.
  let _backingK = 0;
  let _backingAt = 0;
  const _dropBacking = () => { _backingK = 0; };
  if (typeof document !== "undefined") document.addEventListener(HUD_SCALE_EVENT, _dropBacking);
  if (typeof window !== "undefined") window.addEventListener("resize", _dropBacking);
  function backingScale() {
    const t = performance.now();
    if (_backingK > 0 && t - _backingAt < 2000) return _backingK;
    const z = Number(canvas.currentCSSZoom) > 0 ? Number(canvas.currentCSSZoom) : getHudScale();
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    _backingK = Math.max(1, Math.min(8, Math.round(z * dpr)));
    _backingAt = t;
    return _backingK;
  }

  function drawPixels(k, offsets, x, y, color) {
    ctx.fillStyle = color;
    for (let i = 0; i < offsets.length; i += 2) {
      ctx.fillRect((x + offsets[i]) * k, (y + offsets[i + 1]) * k, k, k);
    }
  }

  function update(now) {
    const sh = window.__sessionHandle;
    const em = window.liveScene3d?.entityManager || null;
    let localGuid = 0;
    try { localGuid = (window.getLocalPlayerGuid?.() ?? 0) >>> 0; } catch (_) {}
    refreshSlowState(sh, localGuid, now);
    pruneInfo(now);

    const player = readPlayer(sh, em, localGuid);
    const range = player ? radarRangeForCell(player.cellId) : RADAR_RANGE_OUTDOOR;
    const heading = player ? player.heading : 0;
    placeTokens(heading);

    // Coordinates strip (UpdateCoordinates): outdoor cell only, option-gated.
    let coordsText = "";
    if (player && _slow.coordsOn && isOutdoorCell(player.cellId)) {
      coordsText = radarCoordsText(outdoorCellId(player.landblockId, player.lx, player.ly));
    }
    // Unhide BEFORE setAcText: <ac-text> skips rendering while invisible and
    // would otherwise keep a stale canvas from the last outdoor cell.
    coords.hidden = !coordsText;
    if (coordsText) setAcText(coords, coordsText);

    // Canvas backing store tracks HUD zoom × DPR.
    const k = backingScale();
    const W = RADAR_GEOMETRY.size * k;
    if (canvas.width !== W) { canvas.width = W; canvas.height = W; }
    ctx.clearRect(0, 0, W, W);

    const drawn = [];
    let source = "none";
    if (player) {
      source = (em?.entityMap?.size ?? 0) > 1 ? "scene" : "wasm";
      const cands = gatherCandidates(sh, em, localGuid, player, range, now);
      for (const c of cands) c.d2 = c.dx * c.dx + c.dy * c.dy;
      cands.sort((a, b) => a.d2 - b.d2);
      let selected = 0;
      try { selected = (em?.getSelectedTarget?.() ?? 0) >>> 0; } catch (_) {}
      const fellowship = _slow.fellowship;
      for (const c of cands) {
        if (drawn.length >= MAX_BLIPS) break;
        const info = c.info;
        if (_radarHostileOnly && !((info.odf & ODF_ATTACKABLE) && !(info.odf & ODF_PLAYER))) continue;
        const shape = blipShapeFor(
          { objDescFlags: info.odf, guid: c.guid, monarch: info.monarch }, _slow.player, fellowship,
        );
        if (shape === BLIP_SHAPE.NONE) continue;
        const p = projectToRadar(c.dx, c.dy, heading, range);
        if (!p) continue;
        const base = blipColorForEntity(
          { meta: { objDescFlags: info.odf, radarBlipColor: info.blipColor, guid: c.guid } },
          fellowship,
        );
        const color = blipIntensity(c.dz) < 1 ? dimColor(base) : base;
        drawPixels(k, blipPixels(shape), p.x, p.y, color);
        if (selected && c.guid === selected) drawPixels(k, SELECTED_PIXELS, p.x, p.y, color);
        drawn.push({
          guid: c.guid, x: p.x, y: p.y, shape, color: base, name: info.name,
          dist: Math.sqrt(c.d2), dz: c.dz,
        });
      }
    }
    // Player marker last, over everything (DrawChildren).
    drawPixels(k, CENTRE_PIXELS, RADAR_GEOMETRY.cx, RADAR_GEOMETRY.cy, BRIGHT_GREEN);

    blips = drawn;
    if (mouse || hoverGuid) refreshHover();

    _lastSnapshot = {
      source,
      headingDeg: Math.round((heading * 180 / Math.PI) * 10) / 10,
      range,
      cellId: player ? `0x${(player.cellId >>> 0).toString(16).padStart(8, "0")}` : null,
      coords: coordsText || null,
      tokens: Object.fromEntries(["n", "e", "s", "w"].map((d) => [
        d, { left: parseInt(tokens[d].style.left, 10), top: parseInt(tokens[d].style.top, 10) },
      ])),
      blips: drawn.map((b) => ({
        guid: `0x${b.guid.toString(16).padStart(8, "0")}`, name: b.name,
        x: b.x, y: b.y, shape: b.shape, color: b.color, dist: Math.round(b.dist * 10) / 10,
      })),
      locked: !!winPos?.isLocked?.(),
    };
  }

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    if (overlay.hidden || (typeof document !== "undefined" && document.hidden)) return;
    if (now - lastUpdate < UPDATE_INTERVAL_MS) return;
    lastUpdate = now;
    try { update(now); } catch (e) {
      // Never let a bad frame kill the radar loop; surface it once.
      if (!tick._warned) { tick._warned = true; console.warn("[radar] update failed", e); }
    }
  }
  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    try {
      disk.removeEventListener("pointermove", onMove);
      disk.removeEventListener("pointerleave", onLeave);
      disk.removeEventListener("click", onClick);
      lockBtn.removeEventListener("keydown", onLockKey);
    } catch (_) {}
    overlay.remove();
    tooltip.remove();
    _overlayEl = null;
    _hostileEl = null;
    _lastSnapshot = null;
    _info.clear();
    _slow.t = -Infinity;
  };
}

// Runtime hooks: the hostile-only filter (also `?radarHostileOnly=1`) and a
// read-only snapshot for verification —
// `window.__radar.snapshot()` → {source, headingDeg, range, cellId, coords,
// tokens:{n,e,s,w}, blips:[{guid,name,x,y,shape,color,dist}], locked}.
if (typeof window !== "undefined") {
  window.__radar = {
    setRadarHostileOnly,
    snapshot: () => (_lastSnapshot ? JSON.parse(JSON.stringify(_lastSnapshot)) : null),
    isMounted: () => !!_overlayEl,
  };
}
