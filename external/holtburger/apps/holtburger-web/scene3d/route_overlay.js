// scene3d/route_overlay.js — the RynthSuite VTank route drawn in the 3D world
// (2026-10-19), the way Virindi Tank drew its route in the retail client: a ring
// at each waypoint, a line between consecutive waypoints, the current waypoint
// highlighted. VTank's own knobs for it, NavRingThickness / NavLineThickness
// (rynth/vt/settings/schema.js, inert rows until this module), map onto the
// ring / line widths through `thicknessToWidthM`.
//
// ── Two layers ─────────────────────────────────────────────────────────────
//   createRouteOverlay({ THREE, parent, toScene, opts })  — a pure factory over
//     an injected THREE. Allocates NOTHING (no THREE object, no scene edit)
//     until the first setVisible(true). Plain-data route in, a handful of draw
//     calls out. No globals, no timers.
//   installRouteOverlay({ source, opts })  — the page attach: polls for the
//     live scene (window.liveScene3d.entitiesGroup), follows a scene swap,
//     feeds the route (by default from window.__bot.vt.nav through its public
//     route() / enabled reads) and the player pose, and publishes
//     window.__rynthRouteOverlay. Nothing runs until setVisible(true); hidden
//     ⇒ no timer, nothing in the scene graph.
//   The module has no imports: THREE is injected, or loaded with a dynamic
//   import of "three" (the import-map instance scene3d already uses) on the
//   first setVisible(true), so it adds nothing to the boot graph
//   (scripts/gen-modulepreload.mjs follows only static imports).
//
// ── Coordinates ────────────────────────────────────────────────────────────
// A waypoint is VTank map degrees (ew, ns) plus nav z (metres / 240). The same
// conversion rynth uses everywhere (rynth/nav_file.js degToWorld, route_model
// pointWorld): x = (ew·10 + 1019.5)·24, y = (ns·10 + 1019.5)·24, z = navZ·240 —
// AC world metres, x east, y north, z up, i.e. lbX·192 + local (navPointToLeg).
// That IS the frame of everything under scene3d's `worldRoot` (index.js:1661-
// 1671: worldRoot.rotation.x = −π/2 turns AC Z-up into three Y-up; statics,
// cells and entities are positioned at lbX·192 + local with no floating
// origin). The overlay hangs under `entitiesGroup` (identity transform inside
// worldRoot), so a waypoint lands at three world (x, z, −y). Dungeons need
// nothing special: VTank writes an indoor point from its landblock + local
// position the same way (legToNavPoint), and cells.js places EnvCells at
// lbX·192 + local too, so an indoor point lands inside its cell. Vertex data
// is stored relative to a per-route origin (pathGroup.position, float64 in the
// matrix) so float32 attributes stay precise at 30 km from the map corner.
//
// ── What is drawn (and why) ────────────────────────────────────────────────
// The executors (rynth/vt/nav/executors.js) WALK only to Point, Portal,
// Open Vendor, Portal/NPC and NPC Talk waypoints ("walk targets"); Recall,
// Pause, Chat, Checkpoint and Jump run IN PLACE wherever the previous walk
// target left the player (their recorded coordinates are often stale or the
// 0,0 sentinel — rynth/testdata/MatronHive.nav has a Chat point on the Recall
// point's coordinates). So:
//   • walk targets: a ring at the waypoint (type colour); the path joins them
//     in route order. Portal/NPC and NPC Talk are placed at their OBJECT's
//     recorded position (exitEW/exitNS/exitZ, what executors.js
//     objectAnchor() searches around) when they carry one — their own
//     coordinates are stale in real files (MatronHive.nav point 30 sits on
//     the route's starting spot, 56.8E 33.6N, while its portal is inside the
//     Town Network);
//   • in-place points: a small gem stacked on a pole at the rim of the walk
//     target they run at (the previous one in route order; Circular wraps;
//     points before the first walk target hang on the first one);
//   • a leg after a Portal / Portal-NPC on a portal (objectClass 14) or across
//     a Recall is a teleport, not a walk: hidden (opts.teleportLinks draws it
//     dashed). NPC (Portal/NPC on an NPC, NPC Talk) legs longer than
//     teleportGapM and ANY leg longer than maxSegmentM count as teleports too
//     (a route recorded through a walk-in portal, a corrupt import);
//   • a leg with a Jump waypoint inside it is drawn in the jump colour;
//   • Circular: the closing leg (last → first) is dashed and dimmer;
//   • chevrons at leg midpoints point the walking direction (not on Linear
//     routes, which walk both ways);
//   • the CURRENT waypoint: a green ring + a floating arrow (always visible,
//     depth test off), a line from the player's feet to it, and one label
//     sprite with its 1-based row number ("12 Chat"). Amber while the route is
//     paused, grey while EnableNavigation is off. An in-place current waypoint
//     is shown at the walk target it runs at.
//   Follow routes draw nothing (no points are walked).
//
// Palette (sRGB): path / Point #4fc3ff azure · Portal & Portal/NPC #b26bff
// violet · NPC Talk #e3a8ff lavender · Open Vendor #ff5fa2 pink · Recall
// #ff8c2e orange · Pause #ffe047 yellow · Chat #ffffff white · Checkpoint
// #2fe0c0 teal · Jump #ff3b3b red · closing leg #2b7aa3 · teleport link
// #6a3f99 · gem pole #8fa3b0 · current #3dff5a green / paused #ffb000 /
// nav off #9a9a9a.
//
// ── Budget ─────────────────────────────────────────────────────────────────
// Draw calls while visible: x-ray lines + depth-tested lines + ribbon mesh +
// current marker + player line + label = 6 (5 without a canvas); 0 while
// hidden or never enabled. Programs: one LineBasicMaterial program (lines,
// x-ray, player line share every program-key input: vertexColors, transparent,
// fog off, toneMapped off), one MeshBasicMaterial program (ribbons + marker),
// one SpriteMaterial program (label). Built-in unlit materials only; no
// lights, no onBeforeCompile, no customProgramCacheKey (vfx invariant).
// GPU buffers are rebuilt ONLY when the route signature (route type, point
// types, coordinates incl. Portal/NPC object coordinates, order, objectClass)
// or a geometry option changes; an
// active-index or enabled / paused change moves the marker (one matrix) and
// redraws the 256×64 label canvas (one 64 KB texture upload). Per frame:
// one sin() for the marker pulse and a 2-vertex player-line write (24 bytes);
// no allocations. Per waypoint ≈ 54 line vertices + ≈ 104 mesh vertices
// (24 B each) + ≈ 300 indices — ≈ 0.5 MB for a 100-point route; rings drop to
// 12 segments above 500 points; drawing stops at maxPoints (4000).
//
// ── Depth / order ──────────────────────────────────────────────────────────
// Every material is transparent with depthWrite off (never feeds SSAO / the
// depth readers; drawn in the transparent list after all opaque geometry).
// The 1 px lines draw twice from ONE geometry: an "x-ray" pass (depthTest off,
// opacity 0.3, renderOrder −20) so the route stays readable through hills and
// walls, then the depth-tested pass (opacity 0.95, −19) over it. Ribbons
// (−19) give the lines and rings their width near the camera; the 1 px lines
// keep at least one pixel at any distance. The current marker and player line
// (−18) and the label (9, under nameplates at 10) skip the depth test. All
// below 0 so particles / portal swirls (renderOrder 0) still blend over the
// path in front of them; all on render layer 1 (RENDER_LAYER_INDOOR), like
// blood_decals.js, so the route draws in the outdoor pass AND after the
// indoor depth wipe inside EnvCells. raycast is a no-op on every object
// (picking raycasts entitiesGroup), castShadow stays false.
//
// ── Thickness ──────────────────────────────────────────────────────────────
// WebGL lines are 1 px. NavLineThickness / NavRingThickness (1..16, default
// 6) become world widths of 0.02 m per step (6 → 0.12 m): a "cross" ribbon
// per leg (a flat strip + a vertical fin, so it keeps its width seen from
// above or edge-on without per-frame billboarding) and a flat annulus + a
// vertical band per ring. A world width shrinks with distance like VTank's 3D
// rings did; the 1 px line under it keeps far legs visible. Cost: 8 vertices
// per leg, 4·segments per ring, all in the one ribbon mesh.

// ── constants ──────────────────────────────────────────────────────────────

/** Waypoint types (rynth/vt/nav/route_model.js POINT; VTank names). */
export const NAV_POINT = Object.freeze({
  Point: 0,
  PortalLegacy: 1,
  Recall: 2,
  Pause: 3,
  Chat: 4,
  OpenVendor: 5,
  PortalNPC: 6,
  NpcTalk: 7,
  Checkpoint: 8,
  Jump: 9,
});

/** Route types (route_model.js ROUTE). */
export const NAV_ROUTE = Object.freeze({ Circular: 1, Linear: 2, Follow: 3, Once: 4 });

/** Types the executors walk to (executors.js: point / portalLegacy /
 *  openVendor / portalNpc / npcTalk call pointLeg or walkToPoint); the rest
 *  run in place. Indexed by type. */
const WALKS = Object.freeze([true, true, false, false, false, true, true, true, false, false]);

/** Row labels (the VT panel's type names). */
export const NAV_POINT_LABEL = Object.freeze([
  "Point", "Portal", "Recall", "Pause", "Chat", "Vendor", "Portal/NPC", "NPC Talk", "Checkpoint", "Jump",
]);

/** Colour slots of the per-vertex palette. */
export const COLOR_KEY = Object.freeze({
  path: 0,
  portal: 1,
  recall: 2,
  pause: 3,
  chat: 4,
  vendor: 5,
  talk: 6,
  checkpoint: 7,
  jump: 8,
  closing: 9,
  link: 10,
  pole: 11,
  white: 12,
});
const KEY_NAMES = Object.freeze(Object.keys(COLOR_KEY));
const KEY_COUNT = KEY_NAMES.length;

/** Waypoint type → colour slot. Portal/NPC shares the portal violet. */
const TYPE_KEY = Object.freeze([0, 1, 2, 3, 4, 5, 1, 6, 7, 8]);

/** Default palette (sRGB hex) — see the header. */
export const ROUTE_OVERLAY_COLORS = Object.freeze({
  path: 0x4fc3ff,
  portal: 0xb26bff,
  recall: 0xff8c2e,
  pause: 0xffe047,
  chat: 0xffffff,
  vendor: 0xff5fa2,
  talk: 0xe3a8ff,
  checkpoint: 0x2fe0c0,
  jump: 0xff3b3b,
  closing: 0x2b7aa3,
  link: 0x6a3f99,
  pole: 0x8fa3b0,
  white: 0xffffff,
  active: 0x3dff5a,
  paused: 0xffb000,
  disabled: 0x9a9a9a,
});

/** Leg kinds. */
export const SEG = Object.freeze({ walk: 0, jump: 1, closing: 2, link: 3, hidden: 4 });

/** Metres of width per NavLineThickness / NavRingThickness step. */
export const NAV_THICKNESS_M = 0.02;

/** Pulse period of the current-waypoint marker (ms). */
const PULSE_MS = 1200;
/** The player line is hidden this close to the current waypoint (m). */
const PLAYER_LINE_MIN_M = 0.5;
/** Gems stack at most this high on one pole. */
const MAX_PIP_STACK = 8;

export const ROUTE_OVERLAY_DEFAULTS = Object.freeze({
  ringRadiusM: 1.0, // waypoint ring radius
  ringWidthM: 6 * NAV_THICKNESS_M, // NavRingThickness 6
  lineWidthM: 6 * NAV_THICKNESS_M, // NavLineThickness 6
  liftM: 0.12, // rings / legs float this far above the recorded (feet) z
  ringSegments: 24,
  pipBaseM: 0.6, // first gem above the anchor's z
  pipStepM: 0.45,
  pipRadiusM: 0.2,
  chevrons: true,
  closing: true, // Circular closing leg
  teleportLinks: false, // draw hidden teleport legs as dashed links
  maxSegmentM: 1000, // longer legs are teleports whatever the types say
  teleportGapM: 192, // an NPC leg longer than this teleported
  dashM: 1.0,
  gapM: 0.75,
  xray: true,
  xrayOpacity: 0.3,
  pathOpacity: 0.95,
  ribbonOpacity: 0.85,
  activeOpacity: 0.9,
  playerLine: true,
  playerLineOpacity: 0.6,
  playerLineMaxM: 400, // a route far from the player gets no 1 km line
  labels: true,
  renderOrder: -20, // x-ray; path −19, marker −18
  labelRenderOrder: 9,
  layer: 1, // RENDER_LAYER_INDOOR (index.js:1699-1702)
  maxPoints: 4000,
  autoUpdate: true, // drive update() from onBeforeRender of the route lines
});

const finiteOr = (v, d) => {
  const n = Number(v);
  return v === null || v === "" || !Number.isFinite(n) ? d : n;
};
const clampNum = (v, lo, hi, d) => Math.min(hi, Math.max(lo, finiteOr(v, d)));

/** NavLineThickness / NavRingThickness (VTank 1..16) → world width (m). 0 or
 *  less (or not a number) → 0 (no ribbon, 1 px line only). */
export function thicknessToWidthM(t) {
  const n = Number(t);
  if (t === null || t === "" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(16, Math.round(n)) * NAV_THICKNESS_M;
}

/**
 * Defaults + overrides, clamped. Accepts `navLineThickness` /
 * `navRingThickness` (VTank units) as well as the metre widths; the VTank
 * names win when both are given. Unknown keys (getPlayer, now, createCanvas,
 * colors) pass through.
 */
export function resolveRouteOverlayOptions(opts = {}) {
  const src = opts && typeof opts === "object" ? opts : {};
  const D = ROUTE_OVERLAY_DEFAULTS;
  const o = { ...D, ...src };
  if (src.navLineThickness !== undefined) o.lineWidthM = thicknessToWidthM(src.navLineThickness);
  if (src.navRingThickness !== undefined) o.ringWidthM = thicknessToWidthM(src.navRingThickness);
  o.ringRadiusM = clampNum(o.ringRadiusM, 0.1, 20, D.ringRadiusM);
  o.ringWidthM = clampNum(o.ringWidthM, 0, 2, D.ringWidthM);
  o.lineWidthM = clampNum(o.lineWidthM, 0, 2, D.lineWidthM);
  o.liftM = clampNum(o.liftM, -5, 5, D.liftM);
  o.ringSegments = Math.round(clampNum(o.ringSegments, 6, 96, D.ringSegments));
  o.pipBaseM = clampNum(o.pipBaseM, 0, 10, D.pipBaseM);
  o.pipStepM = clampNum(o.pipStepM, 0.05, 5, D.pipStepM);
  o.pipRadiusM = clampNum(o.pipRadiusM, 0.02, 2, D.pipRadiusM);
  o.maxSegmentM = clampNum(o.maxSegmentM, 1, 1e6, D.maxSegmentM);
  o.teleportGapM = clampNum(o.teleportGapM, 1, 1e6, D.teleportGapM);
  o.dashM = clampNum(o.dashM, 0.05, 100, D.dashM);
  o.gapM = clampNum(o.gapM, 0.05, 100, D.gapM);
  o.xrayOpacity = clampNum(o.xrayOpacity, 0, 1, D.xrayOpacity);
  o.pathOpacity = clampNum(o.pathOpacity, 0, 1, D.pathOpacity);
  o.ribbonOpacity = clampNum(o.ribbonOpacity, 0, 1, D.ribbonOpacity);
  o.activeOpacity = clampNum(o.activeOpacity, 0, 1, D.activeOpacity);
  o.playerLineOpacity = clampNum(o.playerLineOpacity, 0, 1, D.playerLineOpacity);
  o.playerLineMaxM = clampNum(o.playerLineMaxM, 1, 1e6, D.playerLineMaxM);
  o.renderOrder = finiteOr(o.renderOrder, D.renderOrder);
  o.labelRenderOrder = finiteOr(o.labelRenderOrder, D.labelRenderOrder);
  o.layer = Math.round(clampNum(o.layer, 0, 31, D.layer));
  o.maxPoints = Math.round(clampNum(o.maxPoints, 1, 1e6, D.maxPoints));
  for (const k of ["chevrons", "closing", "teleportLinks", "xray", "playerLine", "labels", "autoUpdate"]) o[k] = o[k] !== false;
  o.teleportLinks = src.teleportLinks === true;
  // Consumed: a later metre width must not be overridden by a stale VT value.
  delete o.navLineThickness;
  delete o.navRingThickness;
  return o;
}

/** Merge option patches in call order: a VT thickness and its metre width
 *  replace each other (whichever came last wins). */
export function mergeRouteOverlayOptions(base, patch) {
  const out = { ...(base || {}) };
  if (!patch || typeof patch !== "object") return out;
  if (patch.navLineThickness !== undefined) delete out.lineWidthM;
  if (patch.lineWidthM !== undefined) delete out.navLineThickness;
  if (patch.navRingThickness !== undefined) delete out.ringWidthM;
  if (patch.ringWidthM !== undefined) delete out.navRingThickness;
  return Object.assign(out, patch);
}

/** The options a geometry rebuild depends on (a change ⇒ rebuild). */
const GEOMETRY_KEYS = Object.freeze([
  "ringRadiusM", "ringWidthM", "lineWidthM", "liftM", "ringSegments", "pipBaseM", "pipStepM", "pipRadiusM",
  "chevrons", "closing", "teleportLinks", "maxSegmentM", "teleportGapM", "dashM", "gapM", "maxPoints",
]);

// ── coordinates ────────────────────────────────────────────────────────────

/**
 * VTank nav coordinates → AC world metres (x east, y north, z up) — the frame
 * of entitiesGroup / worldRoot children. Same formula as rynth/nav_file.js
 * degToWorld plus route_model.js pointWorld's z·240. Writes into `out`.
 */
export function navToAcWorld(ew, ns, navZ, out = { x: 0, y: 0, z: 0 }) {
  out.x = (ew * 10 + 1019.5) * 24;
  out.y = (ns * 10 + 1019.5) * 24;
  out.z = navZ * 240;
  return out;
}

/** AC world → three world under worldRoot.rotation.x = −π/2 (index.js:1663):
 *  (x, y, z) → (x, z, −y). For callers outside the scene graph and tests. */
export function acWorldToThree(x, y, z, out = { x: 0, y: 0, z: 0 }) {
  out.x = x;
  out.y = z;
  out.z = -y;
  return out;
}

/** Route type → 1..4 (anything else → Circular, VTank's default). */
export function normalizeRouteType(t) {
  if (typeof t === "string") {
    const byName = { circular: 1, linear: 2, follow: 3, once: 4 }[t.trim().toLowerCase()];
    if (byName) return byName;
  }
  const n = Number(t);
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : NAV_ROUTE.Circular;
}

const quant = (v) => {
  const n = Number(v);
  if (v === null || v === "" || !Number.isFinite(n)) return 0x7fc00000;
  return Math.round(n * 1e7) | 0;
};

/**
 * The geometry signature of a route: route type, point count and, per point,
 * type, ew / ns / z (1e-7 resolution) and — Portal/NPC, NPC Talk — objectClass
 * and the object coordinates; order-sensitive, so a reversal changes it. Active index, paused / enabled / finished do NOT enter
 * it (those are O(1) marker updates). Two independent 32-bit hashes.
 */
export function routeSignature(route) {
  const pts = route && Array.isArray(route.points) ? route.points : null;
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x5bd1e995 | 0;
  const mix = (v) => {
    h1 = Math.imul(h1 ^ v, 16777619);
    h2 = Math.imul(h2 ^ v, 0x5bd1e995);
    h2 ^= h2 >>> 13;
  };
  mix(normalizeRouteType(route && route.routeType));
  mix(pts ? pts.length : -1);
  if (pts) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p || typeof p !== "object") {
        mix(-7);
        continue;
      }
      const t = Number(p.type) | 0;
      mix(t);
      mix(quant(p.ew));
      mix(quant(p.ns));
      mix(p.z === undefined ? 0 : quant(p.z));
      if (t === NAV_POINT.PortalNPC || t === NAV_POINT.NpcTalk) {
        mix(Number(p.objectClass) | 0);
        mix(quant(p.exitEW));
        mix(quant(p.exitNS));
        mix(quant(p.exitZ));
      }
    }
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`;
}

// ── pure geometry ──────────────────────────────────────────────────────────

function makeWriter(sizes, palette) {
  if (!sizes) return { count: true, lv: 0, mv: 0, mi: 0 };
  return {
    count: false,
    lv: 0,
    mv: 0,
    mi: 0,
    linePos: new Float32Array(sizes.lv * 3),
    lineKey: new Uint8Array(sizes.lv),
    lineCol: palette ? new Float32Array(sizes.lv * 3) : null,
    meshPos: new Float32Array(sizes.mv * 3),
    meshKey: new Uint8Array(sizes.mv),
    meshCol: palette ? new Float32Array(sizes.mv * 3) : null,
    meshIdx: sizes.mv > 65535 ? new Uint32Array(sizes.mi) : new Uint16Array(sizes.mi),
    palette,
  };
}

function lineV(w, x, y, z, k) {
  if (!w.count) {
    const i = w.lv;
    w.linePos[i * 3] = x;
    w.linePos[i * 3 + 1] = y;
    w.linePos[i * 3 + 2] = z;
    w.lineKey[i] = k;
    if (w.lineCol) {
      w.lineCol[i * 3] = w.palette[k * 3];
      w.lineCol[i * 3 + 1] = w.palette[k * 3 + 1];
      w.lineCol[i * 3 + 2] = w.palette[k * 3 + 2];
    }
  }
  w.lv += 1;
}

function meshV(w, x, y, z, k) {
  const i = w.mv;
  if (!w.count) {
    w.meshPos[i * 3] = x;
    w.meshPos[i * 3 + 1] = y;
    w.meshPos[i * 3 + 2] = z;
    w.meshKey[i] = k;
    if (w.meshCol) {
      w.meshCol[i * 3] = w.palette[k * 3];
      w.meshCol[i * 3 + 1] = w.palette[k * 3 + 1];
      w.meshCol[i * 3 + 2] = w.palette[k * 3 + 2];
    }
  }
  w.mv += 1;
  return i;
}

function meshQuad(w, a, b, c, d) {
  if (!w.count) {
    const x = w.meshIdx;
    const i = w.mi;
    x[i] = a;
    x[i + 1] = b;
    x[i + 2] = c;
    x[i + 3] = a;
    x[i + 4] = c;
    x[i + 5] = d;
  }
  w.mi += 6;
}

function meshTri(w, a, b, c) {
  if (!w.count) {
    w.meshIdx[w.mi] = a;
    w.meshIdx[w.mi + 1] = b;
    w.meshIdx[w.mi + 2] = c;
  }
  w.mi += 3;
}

/** Ring line loop + (width > 0) a flat annulus and a vertical band. */
function emitRing(w, cx, cy, cz, r, width, key, cosT, sinT, S) {
  for (let s = 0; s < S; s++) {
    const n = (s + 1) % S;
    lineV(w, cx + r * cosT[s], cy + r * sinT[s], cz, key);
    lineV(w, cx + r * cosT[n], cy + r * sinT[n], cz, key);
  }
  if (!(width > 0)) return;
  const hw = width / 2;
  const base = w.mv;
  for (let s = 0; s < S; s++) {
    const c = cosT[s];
    const sn = sinT[s];
    meshV(w, cx + (r - hw) * c, cy + (r - hw) * sn, cz, key); // inner
    meshV(w, cx + (r + hw) * c, cy + (r + hw) * sn, cz, key); // outer
    meshV(w, cx + r * c, cy + r * sn, cz - hw, key); // band low
    meshV(w, cx + r * c, cy + r * sn, cz + hw, key); // band high
  }
  for (let s = 0; s < S; s++) {
    const a = base + s * 4;
    const b = base + ((s + 1) % S) * 4;
    meshQuad(w, a, a + 1, b + 1, b);
    meshQuad(w, a + 2, a + 3, b + 3, b + 2);
  }
}

/** A leg's width: a flat strip + a vertical fin (a "+" cross-section). */
function emitRibbon(w, ax, ay, az, bx, by, bz, width, key) {
  const dx = bx - ax;
  const dy = by - ay;
  const h = Math.hypot(dx, dy);
  const px = h > 1e-6 ? -dy / h : 1;
  const py = h > 1e-6 ? dx / h : 0;
  const hw = width / 2;
  const a0 = meshV(w, ax + px * hw, ay + py * hw, az, key);
  const a1 = meshV(w, ax - px * hw, ay - py * hw, az, key);
  const b1 = meshV(w, bx - px * hw, by - py * hw, bz, key);
  const b0 = meshV(w, bx + px * hw, by + py * hw, bz, key);
  meshQuad(w, a0, a1, b1, b0);
  const c0 = meshV(w, ax, ay, az - hw, key);
  const c1 = meshV(w, ax, ay, az + hw, key);
  const d1 = meshV(w, bx, by, bz + hw, key);
  const d0 = meshV(w, bx, by, bz - hw, key);
  meshQuad(w, c0, c1, d1, d0);
}

/** A dashed 1 px leg (closing leg, teleport link). → dash count. */
function emitDashed(w, ax, ay, az, bx, by, bz, dashM, gapM, key) {
  const L = Math.hypot(bx - ax, by - ay, bz - az);
  if (!(L > 1e-6)) return 0;
  let period = dashM + gapM;
  if (L / period > 256) period = L / 256;
  const dash = Math.min(dashM, period * 0.6);
  let n = 0;
  for (let t0 = 0; t0 < L; t0 += period) {
    const f0 = t0 / L;
    const f1 = Math.min(1, (t0 + dash) / L);
    lineV(w, ax + (bx - ax) * f0, ay + (by - ay) * f0, az + (bz - az) * f0, key);
    lineV(w, ax + (bx - ax) * f1, ay + (by - ay) * f1, az + (bz - az) * f1, key);
    n += 1;
  }
  return n;
}

/** A "V" at the leg midpoint pointing a → b, in the horizontal plane. → 1 or 0. */
function emitChevron(w, ax, ay, az, bx, by, bz, key) {
  const dx = bx - ax;
  const dy = by - ay;
  const h = Math.hypot(dx, dy);
  if (h < 2.5) return 0;
  const ux = dx / h;
  const uy = dy / h;
  const s = Math.min(0.7, h * 0.15);
  const tx = (ax + bx) / 2 + ux * s * 0.5;
  const ty = (ay + by) / 2 + uy * s * 0.5;
  const tz = (az + bz) / 2;
  const bxw = tx - ux * s;
  const byw = ty - uy * s;
  lineV(w, bxw - uy * s * 0.6, byw + ux * s * 0.6, tz, key);
  lineV(w, tx, ty, tz, key);
  lineV(w, bxw + uy * s * 0.6, byw - ux * s * 0.6, tz, key);
  lineV(w, tx, ty, tz, key);
  return 1;
}

/** An in-place waypoint's gem: an octahedron (mesh) + its 12 edges (lines). */
function emitGem(w, cx, cy, cz, g, key) {
  const v = [
    [cx, cy, cz + g],
    [cx + g, cy, cz],
    [cx, cy + g, cz],
    [cx - g, cy, cz],
    [cx, cy - g, cz],
    [cx, cy, cz - g],
  ];
  for (let e = 1; e <= 4; e++) {
    const n = e === 4 ? 1 : e + 1;
    lineV(w, v[0][0], v[0][1], v[0][2], key);
    lineV(w, v[e][0], v[e][1], v[e][2], key);
    lineV(w, v[5][0], v[5][1], v[5][2], key);
    lineV(w, v[e][0], v[e][1], v[e][2], key);
    lineV(w, v[e][0], v[e][1], v[e][2], key);
    lineV(w, v[n][0], v[n][1], v[n][2], key);
  }
  const base = w.mv;
  for (let k = 0; k < 6; k++) meshV(w, v[k][0], v[k][1], v[k][2], key);
  for (let e = 1; e <= 4; e++) {
    const n = e === 4 ? 1 : e + 1;
    meshTri(w, base, base + e, base + n);
    meshTri(w, base + 5, base + n, base + e);
  }
}

/**
 * Build the overlay geometry for one route — pure, no THREE.
 *
 * @param {object} route { points:[{type, ew, ns, z, objectClass?}], routeType }
 * @param {object} [options] resolveRouteOverlayOptions input (or its output)
 * @param {Function} [toScene] (ew, ns, navZ, out) → out {x,y,z} AC metres
 * @param {Float32Array|null} [palette] KEY_COUNT×3 linear RGB → colours filled
 * @returns {{
 *   n:number, routeType:number, truncated:boolean,
 *   origin:{x:number,y:number,z:number},       // AC metres; vertices are relative to it
 *   types:Int8Array, anchorOf:Int32Array,      // per point: walk target it is drawn at (-1 = none)
 *   anchors:Float64Array,                      // per point: that walk target's AC position (NaN = none)
 *   walk:number[],                             // walk-target indices in route order
 *   segments:{a:number,b:number,kind:number}[],
 *   line:{positions:Float32Array, colors:Float32Array|null, keys:Uint8Array, vertexCount:number},
 *   mesh:{positions:Float32Array, colors:Float32Array|null, keys:Uint8Array, indices:Uint16Array|Uint32Array, vertexCount:number, indexCount:number},
 *   counts:object,
 * }}
 */
export function buildRouteGeometry(route, options, toScene = navToAcWorld, palette = null) {
  const o = options && options.__resolved ? options : resolveRouteOverlayOptions(options);
  const pts = route && Array.isArray(route.points) ? route.points : [];
  const truncated = pts.length > o.maxPoints;
  const n = truncated ? o.maxPoints : pts.length;
  const rt = normalizeRouteType(route && route.routeType);
  const types = new Int8Array(n).fill(-1);
  const anchorOf = new Int32Array(n).fill(-1);
  const anchors = new Float64Array(n * 3).fill(NaN);
  const own = new Float64Array(n * 3);
  const valid = new Uint8Array(n);
  const counts = {
    rings: 0,
    pips: 0,
    poles: 0,
    walkSegments: 0,
    jumpSegments: 0,
    closingSegments: 0,
    teleportLinks: 0,
    hiddenLinks: 0,
    chevrons: 0,
    dashes: 0,
  };
  const out = {
    n,
    routeType: rt,
    truncated,
    origin: { x: 0, y: 0, z: 0 },
    types,
    anchorOf,
    anchors,
    walk: [],
    segments: [],
    line: { positions: new Float32Array(0), colors: null, keys: new Uint8Array(0), vertexCount: 0 },
    mesh: { positions: new Float32Array(0), colors: null, keys: new Uint8Array(0), indices: new Uint16Array(0), vertexCount: 0, indexCount: 0 },
    counts,
  };

  // 1) types + positions (a Follow route walks no point: nothing drawn).
  //    Portal/NPC and NPC Talk sit at their OBJECT's recorded position when
  //    it has one (exitEW/exitNS/exitZ — what executors.js objectAnchor()
  //    searches around before approaching within 3 m); their own coordinates
  //    are only the fallback walk target and real files leave them stale
  //    (MatronHive.nav point 30: own = the route's starting spot 56.8E 33.6N,
  //    object = the Baishi portal inside the Town Network, next to point 29).
  const tmp = { x: 0, y: 0, z: 0 };
  const coordOk = (v) => v !== null && v !== "" && v !== undefined && Number.isFinite(Number(v));
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (!p || typeof p !== "object") continue;
    const t = Number(p.type);
    if (!Number.isInteger(t) || t < 0 || t > 9) continue;
    types[i] = t;
    if (rt === NAV_ROUTE.Follow) continue;
    let ew;
    let ns;
    let z;
    if (
      (t === NAV_POINT.PortalNPC || t === NAV_POINT.NpcTalk) &&
      coordOk(p.exitEW) &&
      coordOk(p.exitNS) &&
      (Number(p.exitEW) !== 0 || Number(p.exitNS) !== 0)
    ) {
      ew = Number(p.exitEW);
      ns = Number(p.exitNS);
      z = coordOk(p.exitZ) ? Number(p.exitZ) : coordOk(p.z) ? Number(p.z) : 0;
    } else {
      if (!coordOk(p.ew) || !coordOk(p.ns) || (p.z !== undefined && !coordOk(p.z))) continue;
      ew = Number(p.ew);
      ns = Number(p.ns);
      z = p.z === undefined ? 0 : Number(p.z);
      if (ew === 0 && ns === 0) continue; // the in-place 0,0 sentinel (route_model.isSentinel)
    }
    const wpos = toScene(ew, ns, z, tmp);
    if (!wpos || !Number.isFinite(wpos.x) || !Number.isFinite(wpos.y) || !Number.isFinite(wpos.z)) continue;
    own[i * 3] = wpos.x;
    own[i * 3 + 1] = wpos.y;
    own[i * 3 + 2] = wpos.z;
    valid[i] = 1;
  }

  // 2) walk targets, in route order.
  const isWalk = (i) => types[i] >= 0 && WALKS[types[i]] && valid[i] === 1;
  const walk = out.walk;
  for (let i = 0; i < n; i++) if (isWalk(i)) walk.push(i);
  const W = walk.length;

  // 3) anchors: a walk target is its own; anything else runs at the previous
  //    walk target (Circular wraps to the last one), else the first one, else
  //    (no walk target at all) at its own position when it has one.
  let last = rt === NAV_ROUTE.Circular && W > 0 ? walk[W - 1] : -1;
  for (let i = 0; i < n; i++) {
    if (types[i] < 0) continue;
    if (isWalk(i)) {
      anchorOf[i] = i;
      last = i;
    } else if (last >= 0) anchorOf[i] = last;
    else if (W > 0) anchorOf[i] = walk[0];
    else if (valid[i]) anchorOf[i] = i;
  }
  let originSet = false;
  for (let i = 0; i < n; i++) {
    const a = anchorOf[i];
    if (a < 0) continue;
    anchors[i * 3] = own[a * 3];
    anchors[i * 3 + 1] = own[a * 3 + 1];
    anchors[i * 3 + 2] = own[a * 3 + 2];
    if (!originSet) {
      out.origin.x = Math.round(own[a * 3]);
      out.origin.y = Math.round(own[a * 3 + 1]);
      out.origin.z = Math.round(own[a * 3 + 2]);
      originSet = true;
    }
  }
  if (!originSet) return out;

  // 4) legs between consecutive walk targets (+ Circular's closing leg).
  const objClass = (i) => Number(pts[i] && pts[i].objectClass) | 0;
  const classify = (a, b, closing) => {
    const ta = types[a];
    let teleport = ta === NAV_POINT.PortalLegacy || (ta === NAV_POINT.PortalNPC && objClass(a) === 14);
    let jump = false;
    for (let k = (a + 1) % n; k !== b; k = (k + 1) % n) {
      const t = types[k];
      if (t === NAV_POINT.Recall) teleport = true;
      else if (t === NAV_POINT.Jump) jump = true;
    }
    const h = Math.hypot(own[b * 3] - own[a * 3], own[b * 3 + 1] - own[a * 3 + 1]);
    if (!teleport && (ta === NAV_POINT.PortalNPC || ta === NAV_POINT.NpcTalk) && h > o.teleportGapM) teleport = true;
    if (!teleport && h > o.maxSegmentM) teleport = true;
    if (teleport) return o.teleportLinks ? SEG.link : SEG.hidden;
    if (closing) return o.closing ? SEG.closing : SEG.hidden;
    return jump ? SEG.jump : SEG.walk;
  };
  for (let j = 0; j + 1 < W; j++) out.segments.push({ a: walk[j], b: walk[j + 1], kind: classify(walk[j], walk[j + 1], false) });
  if (rt === NAV_ROUTE.Circular && W >= 2) out.segments.push({ a: walk[W - 1], b: walk[0], kind: classify(walk[W - 1], walk[0], true) });

  // 5) emit (count pass, then fill pass — one code path, exact buffers).
  const S = n > 500 ? Math.min(12, o.ringSegments) : o.ringSegments;
  const cosT = new Float64Array(S);
  const sinT = new Float64Array(S);
  for (let s = 0; s < S; s++) {
    cosT[s] = Math.cos((2 * Math.PI * s) / S);
    sinT[s] = Math.sin((2 * Math.PI * s) / S);
  }
  const ox = out.origin.x;
  const oy = out.origin.y;
  const oz = out.origin.z;
  const lift = o.liftM;
  const R = o.ringRadiusM;
  const rim = R * Math.SQRT1_2;
  const K = COLOR_KEY;
  const pipCount = new Uint16Array(n);
  const emit = (w) => {
    const tally = w.count;
    for (const seg of out.segments) {
      if (seg.kind === SEG.hidden) {
        if (tally) counts.hiddenLinks += 1;
        continue;
      }
      const { a, b, kind } = seg;
      const ax = own[a * 3] - ox;
      const ay = own[a * 3 + 1] - oy;
      const az = own[a * 3 + 2] - oz + lift;
      const bx = own[b * 3] - ox;
      const by = own[b * 3 + 1] - oy;
      const bz = own[b * 3 + 2] - oz + lift;
      const key = kind === SEG.walk ? K.path : kind === SEG.jump ? K.jump : kind === SEG.closing ? K.closing : K.link;
      if (kind === SEG.walk || kind === SEG.jump) {
        lineV(w, ax, ay, az, key);
        lineV(w, bx, by, bz, key);
        if (o.lineWidthM > 0) emitRibbon(w, ax, ay, az, bx, by, bz, o.lineWidthM, key);
        if (tally) counts[kind === SEG.walk ? "walkSegments" : "jumpSegments"] += 1;
      } else {
        const d = emitDashed(w, ax, ay, az, bx, by, bz, o.dashM, o.gapM, key);
        if (tally) {
          counts.dashes += d;
          counts[kind === SEG.closing ? "closingSegments" : "teleportLinks"] += 1;
        }
      }
      if (o.chevrons && rt !== NAV_ROUTE.Linear && kind !== SEG.link) {
        const c = emitChevron(w, ax, ay, az, bx, by, bz, key);
        if (tally) counts.chevrons += c;
      }
    }
    for (const i of walk) {
      emitRing(w, own[i * 3] - ox, own[i * 3 + 1] - oy, own[i * 3 + 2] - oz + lift, R, o.ringWidthM, TYPE_KEY[types[i]], cosT, sinT, S);
      if (tally) counts.rings += 1;
    }
    pipCount.fill(0);
    for (let i = 0; i < n; i++) {
      const a = anchorOf[i];
      if (a < 0 || isWalk(i)) continue;
      const k = Math.min(pipCount[a], MAX_PIP_STACK - 1);
      pipCount[a] += 1;
      emitGem(w, own[a * 3] - ox + rim, own[a * 3 + 1] - oy + rim, own[a * 3 + 2] - oz + o.pipBaseM + k * o.pipStepM, o.pipRadiusM, TYPE_KEY[types[i]]);
      if (tally) counts.pips += 1;
    }
    for (let a = 0; a < n; a++) {
      if (!pipCount[a]) continue;
      const top = Math.min(pipCount[a], MAX_PIP_STACK) - 1;
      const px = own[a * 3] - ox + rim;
      const py = own[a * 3 + 1] - oy + rim;
      lineV(w, px, py, own[a * 3 + 2] - oz + lift, K.pole);
      lineV(w, px, py, own[a * 3 + 2] - oz + o.pipBaseM + top * o.pipStepM - o.pipRadiusM, K.pole);
      if (tally) counts.poles += 1;
    }
  };
  const counter = makeWriter(null, null);
  emit(counter);
  const w = makeWriter(counter, palette);
  emit(w);
  out.line = { positions: w.linePos, colors: w.lineCol, keys: w.lineKey, vertexCount: w.lv };
  out.mesh = { positions: w.meshPos, colors: w.meshCol, keys: w.meshKey, indices: w.meshIdx, vertexCount: w.mv, indexCount: w.mi };
  return out;
}

/**
 * The current-waypoint marker (local to the waypoint, white — tinted by the
 * material): a ring outside the waypoint ring (flat annulus + band) and a
 * downward arrow (two crossed triangles + a stem) floating above head height.
 */
export function buildActiveMarkerGeometry(options) {
  const o = options && options.__resolved ? options : resolveRouteOverlayOptions(options);
  const S = 32;
  const r = o.ringRadiusM + 0.3;
  const width = Math.max(0.1, o.ringWidthM * 1.5);
  const z0 = o.liftM + 0.02;
  const hw = width / 2;
  const pos = [];
  const idx = [];
  const v = (x, y, z) => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  for (let s = 0; s < S; s++) {
    const c = Math.cos((2 * Math.PI * s) / S);
    const sn = Math.sin((2 * Math.PI * s) / S);
    v((r - hw) * c, (r - hw) * sn, z0);
    v((r + hw) * c, (r + hw) * sn, z0);
    v(r * c, r * sn, z0 - hw);
    v(r * c, r * sn, z0 + hw);
  }
  for (let s = 0; s < S; s++) {
    const a = s * 4;
    const b = ((s + 1) % S) * 4;
    idx.push(a, a + 1, b + 1, a, b + 1, b, a + 2, a + 3, b + 3, a + 2, b + 3, b + 2);
  }
  const tipZ = 2.0;
  const baseZ = 2.6;
  const topZ = 3.0;
  const aw = 0.35;
  const sw = 0.07;
  for (const [ux, uy] of [
    [1, 0],
    [0, 1],
  ]) {
    const t = v(0, 0, tipZ);
    const l = v(-ux * aw, -uy * aw, baseZ);
    const rr = v(ux * aw, uy * aw, baseZ);
    idx.push(t, l, rr);
    const s0 = v(-ux * sw, -uy * sw, baseZ);
    const s1 = v(ux * sw, uy * sw, baseZ);
    const s2 = v(ux * sw, uy * sw, topZ);
    const s3 = v(-ux * sw, -uy * sw, topZ);
    idx.push(s0, s1, s2, s0, s2, s3);
  }
  const positions = new Float32Array(pos);
  return { positions, indices: new Uint16Array(idx), vertexCount: positions.length / 3, indexCount: idx.length, labelZ: topZ + 0.15 };
}

// ── THREE layer ────────────────────────────────────────────────────────────

const noRaycast = () => {};

function defaultCreateCanvas(w, h) {
  try {
    const d = globalThis.document;
    if (!d || typeof d.createElement !== "function") return null;
    const c = d.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  } catch (_) {
    return null;
  }
}

const hexCss = (hex) => `#${(hex >>> 0).toString(16).padStart(6, "0")}`;

/**
 * The overlay. See the module header for the design.
 *
 * @param {object} args
 * @param {object} args.THREE   the three module (required)
 * @param {object} [args.parent] Object3D in the AC frame — scene3d's
 *        entitiesGroup (alias: `scene`). Attached to only by setVisible(true).
 * @param {Function} [args.toScene] (ew, ns, navZ, out) → out {x,y,z} in the
 *        parent's frame; default navToAcWorld.
 * @param {object} [args.opts] ROUTE_OVERLAY_DEFAULTS overrides, plus
 *        `getPlayer(out) → boolean` (per-frame pull of the player's feet in the
 *        parent's frame), `now() → ms`, `createCanvas(w, h)`, `colors` (partial
 *        ROUTE_OVERLAY_COLORS).
 * @returns {{
 *   setRoute(route:object|null):void, setPlayer(pos:{x,y,z}|null):void,
 *   setVisible(v:boolean):void, update(nowMs:number):void, dispose():void,
 *   setOptions(partial:object):void, stats():object,
 *   readonly root:object|null, readonly visible:boolean, readonly parent:object|null,
 * }}
 */
export function createRouteOverlay({ THREE, parent = null, scene = null, toScene = navToAcWorld, opts = {} } = {}) {
  if (!THREE || typeof THREE.BufferGeometry !== "function") throw new TypeError("createRouteOverlay: THREE is required");
  const host = parent || scene || null;
  let o = resolveRouteOverlayOptions(opts);
  o.__resolved = true;
  const project = typeof toScene === "function" ? toScene : navToAcWorld;
  const nowFn = () => {
    try {
      if (typeof o.now === "function") return o.now();
      return globalThis.performance && typeof globalThis.performance.now === "function" ? globalThis.performance.now() : Date.now();
    } catch (_) {
      return 0;
    }
  };

  let route = null; // the caller's object; read, never mutated
  let routeSeen = undefined; // identity of the last route signed
  let sig = null; // signature the GPU buffers hold
  let wantSig = null; // signature of `route`
  let geomDirty = true;
  let markerDirty = true;
  let visible = false;
  let disposed = false;
  let objs = null;
  let geo = null; // last buildRouteGeometry result
  let palette = null;
  let label; // undefined = not tried, null = unavailable
  let lastFrame = -1;
  let lastPulseAt = -1;

  const act = { shown: false, index: -1, anchor: -1, x: 0, y: 0, z: 0, stateKey: "", labelText: "", lastKey: null };
  const player = { x: 0, y: 0, z: 0 };
  let playerValid = false;
  let playerLineShown = false;
  const stats = { rebuilds: 0, markerApplies: 0, updates: 0, labelDraws: 0 };

  const colorOf = (name) => {
    const c = o.colors && o.colors[name] !== undefined ? o.colors[name] : ROUTE_OVERLAY_COLORS[name];
    return new THREE.Color(c);
  };
  const buildPalette = () => {
    const p = new Float32Array(KEY_COUNT * 3);
    KEY_NAMES.forEach((name, k) => {
      const c = colorOf(name);
      p[k * 3] = c.r;
      p[k * 3 + 1] = c.g;
      p[k * 3 + 2] = c.b;
    });
    return p;
  };

  const prep = (obj, order) => {
    obj.renderOrder = order;
    obj.layers.set(o.layer);
    obj.raycast = noRaycast;
    obj.castShadow = false;
    obj.receiveShadow = false;
    obj.matrixAutoUpdate = false;
    obj.updateMatrix();
    return obj;
  };

  function makeActiveGeometry() {
    const m = buildActiveMarkerGeometry(o);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    const col = new Float32Array(m.vertexCount * 3).fill(1);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.userData.labelZ = m.labelZ;
    return g;
  }

  function ensureObjects() {
    if (objs) return objs;
    palette = buildPalette();
    const common = { transparent: true, depthWrite: false, fog: false, toneMapped: false };
    const lineMat = new THREE.LineBasicMaterial({ ...common, vertexColors: true, opacity: o.pathOpacity, depthTest: true });
    const xrayMat = new THREE.LineBasicMaterial({ ...common, vertexColors: true, opacity: o.xrayOpacity, depthTest: false });
    const ribbonMat = new THREE.MeshBasicMaterial({
      ...common,
      vertexColors: true,
      opacity: o.ribbonOpacity,
      depthTest: true,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    const activeMat = new THREE.MeshBasicMaterial({
      ...common,
      vertexColors: true,
      opacity: o.activeOpacity,
      depthTest: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    const playerMat = new THREE.LineBasicMaterial({ ...common, vertexColors: true, opacity: o.playerLineOpacity, depthTest: false });
    lineMat.name = "rynth-route-lines";
    xrayMat.name = "rynth-route-xray";
    ribbonMat.name = "rynth-route-ribbons";
    activeMat.name = "rynth-route-active";
    playerMat.name = "rynth-route-player";

    const emptyGeom = new THREE.BufferGeometry();
    const playerGeom = new THREE.BufferGeometry();
    const pPos = new THREE.BufferAttribute(new Float32Array(6), 3);
    if (typeof pPos.setUsage === "function" && THREE.DynamicDrawUsage !== undefined) pPos.setUsage(THREE.DynamicDrawUsage);
    playerGeom.setAttribute("position", pPos);
    playerGeom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(6).fill(1), 3));
    const activeGeom = makeActiveGeometry();

    const root = new THREE.Group();
    root.name = "rynth-route-overlay";
    root.userData.rynthRouteOverlay = true;
    const pathGroup = new THREE.Group();
    pathGroup.name = "rynth-route-path";
    pathGroup.matrixAutoUpdate = false;
    const activeGroup = new THREE.Group();
    activeGroup.name = "rynth-route-active";
    activeGroup.matrixAutoUpdate = false;
    activeGroup.visible = false;

    const base = o.renderOrder;
    const xray = prep(new THREE.LineSegments(emptyGeom, xrayMat), base);
    xray.name = "rynth-route-xray";
    const lines = prep(new THREE.LineSegments(emptyGeom, lineMat), base + 1);
    lines.name = "rynth-route-lines";
    const ribbons = prep(new THREE.Mesh(emptyGeom, ribbonMat), base + 1);
    ribbons.name = "rynth-route-ribbons";
    const activeMesh = prep(new THREE.Mesh(activeGeom, activeMat), base + 2);
    activeMesh.name = "rynth-route-active-marker";
    const playerLine = prep(new THREE.LineSegments(playerGeom, playerMat), base + 2);
    playerLine.name = "rynth-route-player-line";
    // Big, sparse, rebuilt in place: never frustum-cull the lines (they also
    // carry the per-frame driver below) or the 2-vertex dynamic player line.
    xray.frustumCulled = false;
    lines.frustumCulled = false;
    playerLine.frustumCulled = false;
    xray.visible = false;
    lines.visible = false;
    ribbons.visible = false;
    playerLine.visible = false;

    // Per-frame driver (blood_decals.js pattern): runs only on frames that
    // draw the route — correct under ?renderOnDemand / ?targetFps, free when
    // hidden. Both line objects carry it (the x-ray draws first; it may be
    // off); renderer.info.render.frame dedupes the second call.
    const driver = (renderer) => {
      if (!o.autoUpdate) return;
      const f = renderer && renderer.info && renderer.info.render ? renderer.info.render.frame : NaN;
      if (Number.isFinite(f)) {
        if (f === lastFrame) return;
        lastFrame = f;
      }
      try {
        api.update(nowFn());
      } catch (_) {
        /* never throw into the render loop */
      }
    };
    xray.onBeforeRender = driver;
    lines.onBeforeRender = driver;

    pathGroup.add(xray, lines, ribbons);
    activeGroup.add(activeMesh, playerLine);
    root.add(pathGroup, activeGroup);
    objs = {
      root,
      pathGroup,
      activeGroup,
      xray,
      lines,
      ribbons,
      activeMesh,
      playerLine,
      emptyGeom,
      lineGeom: null,
      meshGeom: null,
      activeGeom,
      playerGeom,
      lineMat,
      xrayMat,
      ribbonMat,
      activeMat,
      playerMat,
    };
    return objs;
  }

  function ensureLabel() {
    if (label !== undefined) return label;
    if (!o.labels || !objs) return null; // not cached: labels may be turned on later
    label = null;
    try {
      const make = typeof o.createCanvas === "function" ? o.createCanvas : defaultCreateCanvas;
      const canvas = make(256, 64);
      const ctx = canvas && typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
      if (!ctx || typeof THREE.CanvasTexture !== "function" || typeof THREE.Sprite !== "function") return label;
      const tex = new THREE.CanvasTexture(canvas);
      if (THREE.SRGBColorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      if (THREE.LinearFilter !== undefined) tex.minFilter = THREE.LinearFilter;
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        sizeAttenuation: false,
        fog: false,
        toneMapped: false,
      });
      mat.name = "rynth-route-label";
      const sprite = prep(new THREE.Sprite(mat), o.labelRenderOrder);
      sprite.name = "rynth-route-label";
      sprite.center.set(0.5, 0);
      // Constant screen size (sizeAttenuation off): ≈ 4 % of the view height.
      sprite.scale.set(0.18, 0.045, 1);
      sprite.position.set(0, 0, objs.activeGeom.userData.labelZ || 3.15);
      sprite.updateMatrix();
      sprite.frustumCulled = false;
      objs.activeGroup.add(sprite);
      label = { canvas, ctx, tex, mat, sprite, text: null };
    } catch (_) {
      label = null;
    }
    return label;
  }

  function drawLabel(text, hex) {
    const L = o.labels ? ensureLabel() : null;
    if (!L) return;
    const key = `${text}|${hex}`;
    if (L.text === key) return;
    L.text = key;
    const { ctx, canvas } = L;
    try {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = "bold 34px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = 6;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(text, canvas.width / 2, canvas.height / 2, canvas.width - 8);
      ctx.fillStyle = hexCss(hex);
      ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 8);
    } catch (_) {
      /* a canvas fault only loses the label text */
    }
    L.tex.needsUpdate = true;
    stats.labelDraws += 1;
  }

  function disposeGeom(g) {
    if (g && objs && g !== objs.emptyGeom) {
      try {
        g.dispose();
      } catch (_) {
        /* already released */
      }
    }
  }

  function rebuild() {
    const O = ensureObjects();
    const res = buildRouteGeometry(route, o, project, palette);
    geo = res;
    sig = wantSig;
    geomDirty = false;
    markerDirty = true;
    stats.rebuilds += 1;
    const oldLine = O.lineGeom;
    const oldMesh = O.meshGeom;
    O.lineGeom = null;
    O.meshGeom = null;
    if (res.line.vertexCount > 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(res.line.positions, 3));
      g.setAttribute("color", new THREE.BufferAttribute(res.line.colors, 3));
      O.lineGeom = g;
    }
    if (res.mesh.indexCount > 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(res.mesh.positions, 3));
      g.setAttribute("color", new THREE.BufferAttribute(res.mesh.colors, 3));
      g.setIndex(new THREE.BufferAttribute(res.mesh.indices, 1));
      O.meshGeom = g;
    }
    O.lines.geometry = O.lineGeom || O.emptyGeom;
    O.xray.geometry = O.lineGeom || O.emptyGeom;
    O.ribbons.geometry = O.meshGeom || O.emptyGeom;
    O.lines.visible = !!O.lineGeom;
    O.xray.visible = !!O.lineGeom && o.xray;
    O.ribbons.visible = !!O.meshGeom;
    O.pathGroup.position.set(res.origin.x, res.origin.y, res.origin.z);
    O.pathGroup.updateMatrix();
    disposeGeom(oldLine);
    disposeGeom(oldMesh);
  }

  function stateOf(r) {
    const enabled = !(r && r.enabled === false);
    const paused = !!(r && r.paused);
    return !enabled ? "disabled" : paused ? "paused" : "active";
  }

  function applyMarker() {
    markerDirty = false;
    if (!objs) return;
    stats.markerApplies += 1;
    const O = objs;
    const n = geo ? geo.n : 0;
    let idx = route ? Math.trunc(Number(route.activeIndex)) : 0;
    if (!Number.isFinite(idx)) idx = 0;
    idx = n > 0 ? Math.min(Math.max(idx, 0), n - 1) : -1;
    const finished = !!(route && route.finished);
    const a = idx >= 0 ? geo.anchorOf[idx] : -1;
    act.index = idx;
    act.anchor = a;
    if (a < 0 || finished) {
      act.shown = false;
      O.activeGroup.visible = false;
      setPlayerLine(false);
      return;
    }
    act.shown = true;
    act.x = geo.anchors[idx * 3];
    act.y = geo.anchors[idx * 3 + 1];
    act.z = geo.anchors[idx * 3 + 2];
    O.activeGroup.position.set(act.x, act.y, act.z);
    O.activeGroup.updateMatrix();
    O.activeGroup.visible = true;
    const state = stateOf(route);
    const hex = o.colors && o.colors[state] !== undefined ? o.colors[state] : ROUTE_OVERLAY_COLORS[state];
    O.activeMat.color.setHex(hex);
    O.playerMat.color.setHex(hex);
    act.stateKey = state;
    const t = geo.types[idx];
    let text = String(idx + 1);
    if (t > 0) text += ` ${NAV_POINT_LABEL[t]}`;
    if (state === "paused") text += " (paused)";
    else if (state === "disabled") text += " (nav off)";
    act.labelText = text;
    drawLabel(text, hex);
    applyPlayer();
  }

  function setPlayerLine(on) {
    playerLineShown = on;
    if (objs) objs.playerLine.visible = on;
  }

  function applyPlayer() {
    if (!objs || !act.shown || !playerValid || !o.playerLine) {
      setPlayerLine(false);
      return;
    }
    const dx = player.x - act.x;
    const dy = player.y - act.y;
    const dz = player.z - act.z;
    const h = Math.hypot(dx, dy);
    if (h < PLAYER_LINE_MIN_M || h > o.playerLineMaxM) {
      setPlayerLine(false);
      return;
    }
    const attr = objs.playerGeom.attributes.position;
    const a = attr.array;
    const fz = dz + 0.15;
    // Upload (24 bytes) only when an end moved — a standing player costs nothing.
    if (Math.abs(a[0] - dx) > 1e-4 || Math.abs(a[1] - dy) > 1e-4 || Math.abs(a[2] - fz) > 1e-4 || a[5] !== Math.fround(o.liftM)) {
      a[0] = dx;
      a[1] = dy;
      a[2] = fz;
      a[3] = 0;
      a[4] = 0;
      a[5] = o.liftM;
      attr.needsUpdate = true;
    }
    setPlayerLine(true);
  }

  /** Bring the GPU side in line with `route` (visible only). */
  function sync() {
    if (!visible || disposed) return;
    ensureObjects();
    if (route !== routeSeen) {
      routeSeen = route;
      wantSig = route ? routeSignature(route) : null;
    }
    if (geomDirty || wantSig !== sig) rebuild();
    const st = route ? `${Math.trunc(Number(route.activeIndex))}|${stateOf(route)}|${route.finished ? 1 : 0}` : "-";
    if (markerDirty || st !== act.lastKey) {
      act.lastKey = st;
      applyMarker();
    }
  }

  const api = {
    /** Plain route data; null clears. Cheap when only the active index /
     *  paused / enabled / finished changed (no GPU rebuild). */
    setRoute(r) {
      if (disposed) return;
      route = r && typeof r === "object" ? r : null;
      sync();
    },
    /** Player feet in the parent's frame ({x,y,z} AC metres), or null. */
    setPlayer(pos) {
      if (disposed) return;
      if (pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y)) && Number.isFinite(Number(pos.z))) {
        player.x = Number(pos.x);
        player.y = Number(pos.y);
        player.z = Number(pos.z);
        playerValid = true;
      } else playerValid = false;
      if (visible && objs) applyPlayer();
    },
    /** First true builds and attaches; false detaches (buffers kept). */
    setVisible(v) {
      if (disposed) return;
      const want = !!v;
      if (want === visible) return;
      visible = want;
      if (want) {
        if (!host || typeof host.add !== "function") {
          visible = false;
          return;
        }
        sync();
        if (objs.root.parent !== host) host.add(objs.root);
      } else if (objs && objs.root.parent) {
        objs.root.parent.remove(objs.root);
      }
    },
    /** Per-frame: marker pulse + player line (pulls opts.getPlayer). */
    update(nowMs) {
      if (!visible || disposed || !objs) return;
      stats.updates += 1;
      if (typeof o.getPlayer === "function") {
        let okp = false;
        try {
          okp = o.getPlayer(player) === true;
        } catch (_) {
          okp = false;
        }
        playerValid = okp && Number.isFinite(player.x) && Number.isFinite(player.y) && Number.isFinite(player.z);
      }
      applyPlayer();
      if (act.shown && Number.isFinite(nowMs) && nowMs !== lastPulseAt) {
        lastPulseAt = nowMs;
        const s = 0.5 + 0.5 * Math.sin((nowMs * 2 * Math.PI) / PULSE_MS);
        objs.activeMat.opacity = o.activeOpacity * (0.7 + 0.3 * s);
      }
    },
    /** Change options; geometry options rebuild, the rest are uniforms. */
    setOptions(partial) {
      if (disposed || !partial || typeof partial !== "object") return;
      const next = resolveRouteOverlayOptions(mergeRouteOverlayOptions({ ...o, __resolved: undefined }, partial));
      next.__resolved = true;
      const geomChanged = GEOMETRY_KEYS.some((k) => next[k] !== o[k]);
      const markerGeomChanged = next.ringRadiusM !== o.ringRadiusM || next.ringWidthM !== o.ringWidthM || next.liftM !== o.liftM;
      const colorsChanged = partial.colors !== undefined;
      o = next;
      if (geomChanged || colorsChanged) geomDirty = true;
      if (!objs) return;
      if (colorsChanged) palette = buildPalette();
      objs.lineMat.opacity = o.pathOpacity;
      objs.xrayMat.opacity = o.xrayOpacity;
      objs.ribbonMat.opacity = o.ribbonOpacity;
      objs.activeMat.opacity = o.activeOpacity;
      objs.playerMat.opacity = o.playerLineOpacity;
      objs.xray.visible = !!objs.lineGeom && o.xray;
      const ro = o.renderOrder;
      objs.xray.renderOrder = ro;
      objs.lines.renderOrder = ro + 1;
      objs.ribbons.renderOrder = ro + 1;
      objs.activeMesh.renderOrder = ro + 2;
      objs.playerLine.renderOrder = ro + 2;
      for (const ob of [objs.xray, objs.lines, objs.ribbons, objs.activeMesh, objs.playerLine]) ob.layers.set(o.layer);
      if (label) {
        label.sprite.renderOrder = o.labelRenderOrder;
        label.sprite.layers.set(o.layer);
        label.sprite.visible = o.labels;
      }
      if (markerGeomChanged) {
        const old = objs.activeGeom;
        objs.activeGeom = makeActiveGeometry();
        objs.activeMesh.geometry = objs.activeGeom;
        disposeGeom(old);
      }
      markerDirty = true;
      sync();
    },
    /** Release every geometry / material / texture; detach. Idempotent. */
    dispose() {
      if (disposed) return;
      disposed = true;
      visible = false;
      if (objs) {
        const O = objs;
        if (O.root.parent) O.root.parent.remove(O.root);
        for (const g of [O.lineGeom, O.meshGeom, O.activeGeom, O.playerGeom, O.emptyGeom]) {
          try {
            if (g) g.dispose();
          } catch (_) {
            /* released */
          }
        }
        for (const m of [O.lineMat, O.xrayMat, O.ribbonMat, O.activeMat, O.playerMat]) {
          try {
            m.dispose();
          } catch (_) {
            /* released */
          }
        }
        O.xray.onBeforeRender = noRaycast;
        O.lines.onBeforeRender = noRaycast;
      }
      if (label) {
        try {
          label.tex.dispose();
          label.mat.dispose();
        } catch (_) {
          /* released */
        }
      }
      label = null;
      objs = null;
      geo = null;
      route = null;
    },
    stats() {
      const O = objs;
      const vis = (x) => !!(x && x.visible);
      let drawCalls = 0;
      if (visible && O) {
        if (vis(O.xray)) drawCalls += 1;
        if (vis(O.lines)) drawCalls += 1;
        if (vis(O.ribbons)) drawCalls += 1;
        if (vis(O.activeGroup)) {
          drawCalls += 1;
          if (vis(O.playerLine)) drawCalls += 1;
          if (label && vis(label.sprite)) drawCalls += 1;
        }
      }
      const lv = geo ? geo.line.vertexCount : 0;
      const mv = geo ? geo.mesh.vertexCount : 0;
      const mi = geo ? geo.mesh.indexCount : 0;
      return {
        visible,
        built: !!O,
        disposed,
        signature: sig,
        rebuilds: stats.rebuilds,
        markerApplies: stats.markerApplies,
        updates: stats.updates,
        labelDraws: stats.labelDraws,
        drawCalls,
        points: geo ? geo.n : 0,
        truncated: geo ? geo.truncated : false,
        lineVertices: lv,
        meshVertices: mv,
        meshIndices: mi,
        gpuBytes: lv * 24 + mv * 24 + mi * (geo && geo.mesh.indices.BYTES_PER_ELEMENT ? geo.mesh.indices.BYTES_PER_ELEMENT : 2),
        counts: geo ? { ...geo.counts } : null,
        active: { shown: act.shown, index: act.index, anchor: act.anchor, state: act.stateKey, label: act.labelText, x: act.x, y: act.y, z: act.z },
        playerLine: playerLineShown,
      };
    },
    get root() {
      return objs ? objs.root : null;
    },
    get visible() {
      return visible;
    },
    get parent() {
      return host;
    },
    get options() {
      return { ...o };
    },
    /** Test / diag access to the built objects (null before the first show). */
    get objects() {
      return objs;
    },
    get geometry() {
      return geo;
    },
  };
  return api;
}

// ── page attach ────────────────────────────────────────────────────────────

/** Player feet in the AC frame, allocation-free on the normal path: the
 *  camera switcher's integrator pose (the source EntityManager
 *  getLocalPlayerWorldPos prefers, entities.js:16296-16300), else that public
 *  read (allocates one small object) before the predicted pose exists. */
export function readPlayerFeet(win, out) {
  try {
    const ls = win && win.liveScene3d;
    if (!ls) return false;
    const p = ls.cameraSwitcher && ls.cameraSwitcher.predictedPlayerPos;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      out.x = p.x;
      out.y = p.y;
      out.z = p.z;
      return true;
    }
    const em = ls.entityManager;
    if (em && typeof em.getLocalPlayerWorldPos === "function") {
      const q = em.getLocalPlayerWorldPos();
      if (q && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z)) {
        out.x = q.x;
        out.y = q.y;
        out.z = q.z;
        return true;
      }
    }
  } catch (_) {
    /* no pose this frame */
  }
  return false;
}

/** The default route feed: the bot's VTank ActiveNav through its public reads
 *  (route() — a clone — and the `enabled` getter). null without a VT layer. */
export function vtNavRouteSource(win) {
  try {
    const nav = win && win.__bot && win.__bot.vt && win.__bot.vt.nav;
    if (!nav || typeof nav.route !== "function") return null;
    const r = nav.route();
    if (!r || !Array.isArray(r.points)) return null;
    let enabled = true;
    try {
      enabled = nav.enabled !== false;
    } catch (_) {
      enabled = true;
    }
    return {
      points: r.points,
      activeIndex: r.activeIndex,
      routeType: r.routeType,
      reversed: !!r.reversed,
      finished: !!r.finished,
      paused: !!r.paused,
      enabled,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Attach the overlay to the live scene and publish window.__rynthRouteOverlay.
 * Idempotent (a second call returns the installed handle, applying `opts`).
 * Allocates no THREE object and starts no timer until setVisible(true).
 *
 * @param {object} [cfg]
 * @param {"auto"|Function|null} [cfg.source="auto"] route feed polled while
 *        visible: "auto" = vtNavRouteSource(window); a function returning route
 *        data; null = only setRoute() pushes. setRoute() switches to manual.
 * @param {object} [cfg.opts] createRouteOverlay options (navLineThickness,
 *        navRingThickness, ringRadiusM, …).
 * @param {object} [cfg.THREE] the three module (else import("three") on show)
 * @param {number} [cfg.pollMs=250] scene / route poll while visible (4 Hz)
 * @param {object} [cfg.win] window (tests)
 * @param {{setInterval:Function, clearInterval:Function}} [cfg.timers] (tests)
 * @param {Function} [cfg.importThree] () → Promise<THREE> (tests)
 * @returns {object|null} the handle (also window.__rynthRouteOverlay)
 */
export function installRouteOverlay(cfg = {}) {
  const win = cfg.win || (typeof window !== "undefined" ? window : null);
  if (!win) return null;
  const prev = win.__rynthRouteOverlay;
  if (prev && prev.__routeOverlay === true && !prev.disposed) {
    if (cfg.opts) prev.setOptions(cfg.opts);
    if (cfg.source !== undefined) prev.setSource(cfg.source);
    return prev;
  }
  const timers = cfg.timers || {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
  };
  const pollMs = Math.max(50, finiteOr(cfg.pollMs, 250));
  const importThree = typeof cfg.importThree === "function" ? cfg.importThree : () => import("three");
  let THREE = cfg.THREE || null;
  let threeLoading = null;
  let threeError = null;
  let source = cfg.source === undefined ? "auto" : cfg.source;
  let pushed = null;
  let opts = { ...(cfg.opts || {}) };
  let visible = false;
  let timer = null;
  let overlay = null;
  let boundParent = null;
  let boundScene = null;
  let disposed = false;
  let attaches = 0;
  let lastError = null;
  const getPlayer = (out) => readPlayerFeet(win, out);

  const sourceName = () => (source === "auto" ? "auto" : typeof source === "function" ? "function" : "manual");
  const currentRoute = () => {
    if (source === "auto") return vtNavRouteSource(win);
    if (typeof source === "function") {
      try {
        return source() || null;
      } catch (e) {
        lastError = String((e && e.message) || e);
        return null;
      }
    }
    return pushed;
  };
  const drop = () => {
    if (overlay) {
      try {
        overlay.dispose();
      } catch (_) {
        /* released */
      }
    }
    overlay = null;
    boundParent = null;
    boundScene = null;
  };
  const loadThree = () => {
    if (THREE || threeLoading || threeError) return;
    threeLoading = Promise.resolve()
      .then(importThree)
      .then((m) => {
        THREE = m && m.BufferGeometry ? m : m && m.default ? m.default : m;
        threeLoading = null;
        poll();
      })
      .catch((e) => {
        threeLoading = null;
        threeError = String((e && e.message) || e);
      });
  };
  function tick() {
    if (!visible || disposed) return;
    const ls = win.liveScene3d || null;
    const parent = (ls && ls.entitiesGroup) || null;
    // A new scene (or none): the old overlay belongs to a dead graph.
    if (overlay && (parent !== boundParent || ls !== boundScene)) drop();
    if (!parent || typeof parent.add !== "function") return;
    if (!overlay) {
      if (!THREE) {
        loadThree();
        return;
      }
      overlay = createRouteOverlay({ THREE, parent, opts: { ...opts, getPlayer } });
      boundParent = parent;
      boundScene = ls;
      attaches += 1;
    }
    overlay.setRoute(currentRoute());
    overlay.setVisible(true);
  }
  function poll() {
    try {
      tick();
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
  }

  const handle = {
    __routeOverlay: true,
    get disposed() {
      return disposed;
    },
    get visible() {
      return visible;
    },
    /** Push route data (switches the feed to manual until setSource). */
    setRoute(data) {
      if (disposed) return;
      pushed = data && typeof data === "object" ? data : null;
      source = null;
      if (overlay && visible) overlay.setRoute(pushed);
    },
    /** "auto" (the bot's ActiveNav), a function, or null (manual pushes). */
    setSource(fn) {
      if (disposed) return;
      source = fn === "auto" ? "auto" : typeof fn === "function" ? fn : null;
      if (visible) poll();
    },
    /** Show / hide. Hidden = detached from the scene, no timer. → visible. */
    setVisible(v) {
      if (disposed) return false;
      const want = !!v;
      if (want === visible) return visible;
      visible = want;
      if (want) {
        if (timer === null) timer = timers.setInterval(poll, pollMs);
        poll();
      } else {
        if (timer !== null) timers.clearInterval(timer);
        timer = null;
        if (overlay) overlay.setVisible(false);
      }
      return visible;
    },
    toggle() {
      return handle.setVisible(!visible);
    },
    /** createRouteOverlay options; VT names navLineThickness /
     *  navRingThickness accepted. Applied live. */
    setOptions(partial) {
      if (disposed || !partial || typeof partial !== "object") return;
      opts = mergeRouteOverlayOptions(opts, partial);
      if (overlay) overlay.setOptions(partial);
    },
    /** One poll now (scene check + route feed). */
    refresh() {
      poll();
    },
    status() {
      const ls = win.liveScene3d || null;
      return {
        visible,
        disposed,
        source: sourceName(),
        sceneReady: !!(ls && ls.entitiesGroup),
        threeLoaded: !!THREE,
        threeError,
        attached: !!overlay,
        attaches,
        polling: timer !== null,
        lastError,
        overlay: overlay ? overlay.stats() : null,
      };
    },
    /** The live overlay (tests / diag); null until attached. */
    get overlay() {
      return overlay;
    },
    dispose() {
      if (disposed) return;
      if (timer !== null) timers.clearInterval(timer);
      timer = null;
      drop();
      visible = false;
      disposed = true;
      try {
        if (win.__rynthRouteOverlay === handle) delete win.__rynthRouteOverlay;
      } catch (_) {
        win.__rynthRouteOverlay = undefined;
      }
    },
  };
  win.__rynthRouteOverlay = handle;
  return handle;
}
