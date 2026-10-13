// rynth/vt/nav/route_model.js — the VTank route model (W1-6 NAV, PLAN §3.8).
//
// Pure functions over a RouteState (PLAN §3.2): route types, the active
// waypoint index, Linear direction, reversal, insert/remove, and the "Navroute
// Empty" / "Dist Any Route Pt" reads. No host, no clock, no I/O: ActiveNav
// (active_nav.js) owns the runtime and stores the RouteState in the page
// session (session.navState) so a bot rebind continues the same route.
//
// Semantics (U7b §5.2, U3 §3, guide G:185-224):
//   Circular  A B C A B C …          advance = (i+1) % n
//   Linear    A B C B A B C …        i += dir; at either end flip dir and re-step
//                                    (C# behaviour: endpoints visited once per
//                                    bounce, Q7). A single-point Linear route is
//                                    FINISHED (fixes U7b H16: C# went to -1 and
//                                    "Navroute Empty" never fired).
//   Once      A B C, then empty      the points are cleared and `finished` is
//                                    set; navigation itself stays ENABLED (U7b
//                                    H4: the guide's runback example loads the
//                                    next route without re-enabling nav).
//   Follow    (no points)            the follow target is the route.
// Start index on load: 0 for Once/Follow, else the nearest Point (type 0)
// (CS/Meta/MetaManager.cs:161-169).
//
// Every function returns a NEW RouteState (or the same one when nothing
// changes) and keeps point OBJECTS by identity, so ActiveNav can recognise
// "the same waypoint" across an insert above it or a reversal.

import { degToWorld } from "../../nav_file.js";

export const ROUTE = Object.freeze({ Circular: 1, Linear: 2, Follow: 3, Once: 4 });
export const ROUTE_NAMES = Object.freeze({ 1: "circular", 2: "linear", 3: "follow", 4: "once" });

/** Waypoint types (nav_file.js NavPointType; VTank names). */
export const POINT = Object.freeze({
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
export const POINT_NAMES = Object.freeze({
  0: "Point",
  1: "Portal",
  2: "Recall",
  3: "Pause",
  4: "Chat",
  5: "OpenVendor",
  6: "PortalNPC",
  7: "NpcTalk",
  8: "Checkpoint",
  9: "Jump",
});

/** Jump launch directions (PLAN §3.2 NavPoint.ext.direction). */
export const JUMP_DIRECTIONS = Object.freeze(["none", "forward", "strafeleft", "straferight", "back"]);

const NAV_DEG_TO_M = 240; // 1 /loc degree = 240 m; nav Z unit = m/240

const finite = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);

/** Normalise a route type to 1..4 (anything else → Circular, VTank's default). */
export function normalizeRouteType(t) {
  if (typeof t === "string") {
    const k = t.trim().toLowerCase();
    const byName = { circular: 1, linear: 2, follow: 3, once: 4 }[k];
    if (byName) return byName;
  }
  const n = Number(t);
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : ROUTE.Circular;
}

/** A follow target `{guid, name}` or null. */
export function normalizeFollowTarget(t) {
  if (!t || typeof t !== "object") return null;
  const guid = Number(t.guid) >>> 0;
  const name = typeof t.name === "string" ? t.name : "";
  if (!guid && !name.trim()) return null;
  return { guid, name };
}

/**
 * Validate + copy one waypoint (the nav_file.parseNav point shape plus the VT
 * `ext`). Returns null for an unknown type. `raw` (the source lines, for a
 * byte-stable `.nav` round trip) is kept only when it is an array of strings.
 */
export function normalizePoint(p) {
  if (!p || typeof p !== "object") return null;
  const type = Number(p.type);
  if (!Number.isInteger(type) || type < 0 || type > 9) return null;
  const out = { type, ew: finite(p.ew), ns: finite(p.ns), z: finite(p.z) };
  if (p.flag != null) out.flag = String(p.flag);
  if (Array.isArray(p.raw) && p.raw.length && p.raw.every((l) => typeof l === "string")) out.raw = p.raw.slice();
  switch (type) {
    case POINT.PortalLegacy:
      out.guid = finite(p.guid) >>> 0;
      break;
    case POINT.Recall:
      out.spellId = Math.trunc(finite(p.spellId));
      break;
    case POINT.Pause:
      out.pauseMs = Math.max(0, Math.round(finite(p.pauseMs)));
      break;
    case POINT.Chat:
      out.chat = p.chat == null ? "" : String(p.chat);
      break;
    case POINT.OpenVendor:
      out.vendorId = finite(p.vendorId) >>> 0;
      out.name = p.name == null ? "" : String(p.name);
      break;
    case POINT.PortalNPC:
    case POINT.NpcTalk:
      out.name = p.name == null ? "" : String(p.name);
      out.objectClass = Math.trunc(finite(p.objectClass));
      out.isTie = p.isTie === true;
      out.exitEW = finite(p.exitEW);
      out.exitNS = finite(p.exitNS);
      out.exitZ = finite(p.exitZ);
      break;
    case POINT.Jump:
      out.headingDeg = finite(p.headingDeg);
      out.holdShift = p.holdShift === true;
      out.delayMs = Math.max(0, finite(p.delayMs));
      break;
    default:
      break;
  }
  if (p.ext && typeof p.ext === "object") {
    const ext = {};
    if (typeof p.ext.direction === "string" && JUMP_DIRECTIONS.includes(p.ext.direction)) ext.direction = p.ext.direction;
    if (Object.keys(ext).length) out.ext = ext;
  }
  return out;
}

/** Deep copy of a point (keeps every field, incl. raw/ext). */
export function clonePoint(p) {
  const out = { ...p };
  if (Array.isArray(p.raw)) out.raw = p.raw.slice();
  if (p.ext && typeof p.ext === "object") out.ext = { ...p.ext };
  return out;
}

/** Deep copy of a RouteState (for status/UI reads). */
export function cloneRoute(route) {
  return {
    ...route,
    points: (route.points || []).map(clonePoint),
    followTarget: route.followTarget ? { ...route.followTarget } : null,
    paused: route.paused ? { ...route.paused } : null,
  };
}

/**
 * A fresh RouteState. Points are validated and copied (an unknown type is
 * dropped — the caller reports it); the active index starts at 0 (ActiveNav
 * applies startIndex() against the live pose).
 */
export function makeRoute({ name = null, routeType = ROUTE.Circular, points = [], followTarget = null } = {}) {
  const pts = [];
  for (const p of Array.isArray(points) ? points : []) {
    const n = normalizePoint(p);
    if (n) pts.push(n);
  }
  return {
    name: typeof name === "string" && name ? name : null,
    routeType: normalizeRouteType(routeType),
    points: pts,
    activeIndex: 0,
    linearDir: 1,
    reversed: false,
    followTarget: normalizeFollowTarget(followTarget),
    finished: false,
    paused: null,
    dirty: false,
  };
}

/** True for an in-place action point recorded at the 0,0(,0|-1000) sentinel
 *  (VTank/metaf write EW=NS=0 for Chat/Pause; vr-bridge-jump.nav:32-37). */
export function isSentinel(point) {
  if (!point) return true;
  const ew = Number(point.ew);
  const ns = Number(point.ns);
  if (!Number.isFinite(ew) || !Number.isFinite(ns)) return true;
  return ew === 0 && ns === 0;
}

/** World-frame metres of a point ({wx, wy, z}); null for sentinel points. */
export function pointWorld(point) {
  if (isSentinel(point)) return null;
  const { wx, wy } = degToWorld(Number(point.ew), Number(point.ns));
  return { wx, wy, z: finite(point.z) * NAV_DEG_TO_M };
}

function dist2(a, b) {
  return Math.hypot(a.wx - b.wx, a.wy - b.wy);
}

/** Index of the nearest Point-type waypoint to `poseWorld` ({wx,wy}); -1 if none. */
export function nearestPointIndex(route, poseWorld) {
  if (!route || !poseWorld) return -1;
  let best = -1;
  let bestD = Infinity;
  route.points.forEach((p, i) => {
    if (p.type !== POINT.Point) return;
    const w = pointWorld(p);
    if (!w) return;
    const d = dist2(w, poseWorld);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Start index on load: 0 for Once/Follow, else the nearest Point (0 if none). */
export function startIndex(route, poseWorld) {
  if (!route || !route.points.length) return 0;
  if (route.routeType === ROUTE.Once || route.routeType === ROUTE.Follow) return 0;
  const i = nearestPointIndex(route, poseWorld);
  return i >= 0 ? i : 0;
}

/** "Navroute Empty": no points (Follow: no follow target), or finished. */
export function isEmpty(route) {
  if (!route) return true;
  if (route.finished) return true;
  if (route.routeType === ROUTE.Follow) return !route.followTarget;
  return !route.points || route.points.length === 0;
}

/**
 * One step past the active waypoint (CS/NavigationEngine.cs:692-728 with the
 * H4/H16 fixes). Once at its end clears the points and sets `finished`.
 */
export function advance(route) {
  const n = route.points.length;
  if (route.routeType === ROUTE.Follow) return { ...route, activeIndex: 0 };
  if (n === 0) return { ...route, activeIndex: 0 };
  const i = Math.min(Math.max(route.activeIndex | 0, 0), n - 1);
  switch (route.routeType) {
    case ROUTE.Linear: {
      if (n === 1) return { ...route, activeIndex: 0, finished: true };
      let dir = route.linearDir === -1 ? -1 : 1;
      let next = i + dir;
      if (next < 0 || next >= n) {
        dir = -dir;
        next = i + dir;
      }
      return { ...route, activeIndex: next, linearDir: dir };
    }
    case ROUTE.Once: {
      if (i + 1 >= n) return { ...route, points: [], activeIndex: 0, finished: true };
      return { ...route, activeIndex: i + 1 };
    }
    case ROUTE.Circular:
    default:
      return { ...route, activeIndex: (i + 1) % n };
  }
}

/**
 * Dense-waypoint skip (U7b §5.2, CS/NavigationEngine.cs:743-770): after an
 * advance, keep advancing while the new target is a POINT already within
 * `arriveM` of the player. Never skips an action waypoint. Bounded by the
 * route length so a Circular route of co-located points cannot spin.
 */
export function skipDense(route, poseWorld, arriveM) {
  if (!poseWorld || !(arriveM > 0)) return { route, skipped: 0 };
  let r = route;
  let skipped = 0;
  const budget = r.points.length;
  while (skipped < budget && !isEmpty(r)) {
    const p = r.points[r.activeIndex];
    if (!p || p.type !== POINT.Point) break;
    const w = pointWorld(p);
    if (!w || dist2(w, poseWorld) > arriveM) break;
    r = advance(r);
    skipped += 1;
  }
  return { route: r, skipped };
}

/**
 * Insert a waypoint (G:210 "Add to End / Insert Above / Insert Below"),
 * relative to the SELECTED row; no (valid) selection ⇒ End. The active
 * waypoint keeps pointing at the same point. Returns `{ route, index }`.
 */
export function insert(route, point, mode = "end", selected = null) {
  const n = route.points.length;
  const sel = Number.isInteger(selected) && selected >= 0 && selected < n ? selected : null;
  let index = n;
  if (sel !== null && mode === "above") index = sel;
  else if (sel !== null && mode === "below") index = sel + 1;
  const points = route.points.slice();
  points.splice(index, 0, point);
  let activeIndex = route.activeIndex | 0;
  if (n > 0 && index <= activeIndex) activeIndex += 1;
  if (n === 0) activeIndex = 0;
  return { route: { ...route, points, activeIndex, finished: false, dirty: true }, index };
}

/** Delete row `i`; deleting the active row keeps `min(i, n-1)` (U7b H17). */
export function removeAt(route, i) {
  const n = route.points.length;
  if (!Number.isInteger(i) || i < 0 || i >= n) return route;
  const points = route.points.slice();
  points.splice(i, 1);
  let a = route.activeIndex | 0;
  if (i < a) a -= 1;
  else if (i === a) a = Math.min(i, points.length - 1);
  if (a < 0) a = 0;
  return { ...route, points, activeIndex: a, dirty: true };
}

/** Make row `i` the active waypoint (the green arrow), clamped. */
export function setActive(route, i) {
  const n = route.points.length;
  const idx = n === 0 ? 0 : Math.min(Math.max(Math.trunc(Number(i)) || 0, 0), n - 1);
  return { ...route, activeIndex: idx, finished: false };
}

/** ▲/▼ on the active row: wraps for Circular, clamps otherwise. */
export function step(route, delta) {
  const n = route.points.length;
  if (n === 0) return route;
  const d = Math.trunc(Number(delta)) || 0;
  let idx = (route.activeIndex | 0) + d;
  if (route.routeType === ROUTE.Circular) idx = ((idx % n) + n) % n;
  else idx = Math.min(Math.max(idx, 0), n - 1);
  return { ...route, activeIndex: idx, finished: false };
}

/**
 * `/rs reverseroute [true|false]` (G:223, Q4 defaults): `true`/`false` are
 * idempotent, no argument toggles. A reversal reverses the points, mirrors
 * the index (`n-1-i`, CS/Meta/MetaManager.cs:1012-1023) and leaves `linearDir`
 * alone, as C# does, so the walk turns around on every route type (G:223). The
 * plan text (R21 / §3.8) also flipped `linearDir`, which on a Linear route
 * cancelled the turn-around; dropped by the orchestrator after the W1-6 review
 * (Q4's "flip" = the walk changes direction).
 */
export function reverse(route, flag) {
  const want = flag === true ? true : flag === false ? false : !route.reversed;
  if (want === !!route.reversed) return route;
  const n = route.points.length;
  return {
    ...route,
    points: route.points.slice().reverse(),
    activeIndex: n > 0 ? n - 1 - Math.min(Math.max(route.activeIndex | 0, 0), n - 1) : 0,
    reversed: want,
  };
}

/** "Dist Any Route Pt" in metres (2D) over points with coordinates; Infinity if none. */
export function minDistM(route, poseWorld) {
  if (!route || !poseWorld) return Infinity;
  let best = Infinity;
  for (const p of route.points) {
    const w = pointWorld(p);
    if (!w) continue;
    const d = dist2(w, poseWorld);
    if (d < best) best = d;
  }
  return best;
}

export default {
  ROUTE,
  ROUTE_NAMES,
  POINT,
  POINT_NAMES,
  JUMP_DIRECTIONS,
  normalizeRouteType,
  normalizeFollowTarget,
  normalizePoint,
  clonePoint,
  cloneRoute,
  makeRoute,
  isSentinel,
  pointWorld,
  nearestPointIndex,
  startIndex,
  isEmpty,
  advance,
  skipDense,
  insert,
  removeAt,
  setActive,
  step,
  reverse,
  minDistM,
};
