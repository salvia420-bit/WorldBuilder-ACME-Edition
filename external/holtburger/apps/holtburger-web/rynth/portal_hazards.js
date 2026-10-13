// portal_hazards.js — keep the bot's graph walks out of portals it did not
// mean to take (rynth-macro-nav-6). DEFAULT-OFF: `?botPortalAvoid=on`, or
// `opts.portalAvoid: true` on composeGoto / composeEgress / replayRoute.
//
// Portals are ethereal, so neither the indoor cell graph nor the walker's
// collision treats them as an obstacle, and touching one teleports the player
// (ACE Player.OnCollideObject -> Portal.OnCollideObject; only a 3.5 s
// re-portal cooldown). The indoor legs (indoor_router.js toLegs) run
// centre-to-centre, and the first leg is the centre of the cell the player
// already stands in. In a dungeon entry room whose exit portal stands next to
// the arrival point, that leg can walk the body straight back out. holtburger
// only recovered afterwards (goto_compose.js outdoorWithAssist re-exit;
// live v15: the Town Network clipped a non-target portal into the academy).
//
// This module plans around them geometrically, not by cell (a whole-cell
// hazard in a junction room can disconnect the graph): every portal within
// 80 m that is not the walk's own target becomes a disk of reach + clearance,
// and each leg SEGMENT that enters a disk gets a side-step waypoint on the
// disk's rim. When no clear side-step exists the legs come back unchanged.
// After WebAC packages/renderer/src/agent/portalAvoid.ts + AgentApi.ts
// (the 80 m scan, the 0.8 m clearance, the 3 m floor span and the "a walk may
// start inside a disk if it heads away" rule), AGPL-3.0.
//
// Pure apart from portalHazards (host reads, never throws) and import-free.
// The recorded-route legs (replayRoute's main follow, VT nav) and the sidecar
// requests never pass through here.

const ITEM_TYPE_PORTAL = 0x00010000; // ACE ItemType.Portal (PropertyInt 1)
const ODF_PORTAL = 0x40000; //          ACE ObjectDescriptionFlag.Portal

/** Portals farther than this from the player are not planned around (WebAC 80 m). */
export const PORTAL_HAZARD_MAX_M = 80;
/** A portal's touch reach from its origin. The host has no per-object radius
 *  read yet (WebAC uses the Setup radius x scale), so a fixed typical value. */
export const PORTAL_REACH_M = 1.5;
/** Kept between the body and a portal's reach: body radius 0.48 m + margin (WebAC). */
export const PORTAL_CLEARANCE_M = 0.8;
/** Disks more than this above or below a segment are on another floor (WebAC). */
export const PORTAL_FLOOR_SPAN_M = 3;
/** How far outside the disk a side-step waypoint sits. Covers the corner the
 *  walker cuts when it turns inside its arrival radius (below). */
export const SIDE_STEP_MARGIN_M = 1.0;
/** Arrival radius stamped on side-step / moved legs, so the walker reaches the
 *  corner before it turns (router.js honours a per-leg `arriveM`; 1.5 m is
 *  the VT nav minimum, rynth/vt/nav/active_nav.js arriveM). */
export const SIDE_STEP_ARRIVE_M = 1.5;
/** A target portal given as a world point (a transit leg) excludes the nearest
 *  portal within this distance of it. */
export const TARGET_PORTAL_MAX_M = 25;

const MAX_SPLIT_DEPTH = 4; // recursive side-steps per segment (2^4 - 1 points at most)
const MAX_SIDE_STEPS = 64; // per avoidPortalDisks call

const lbBaseX = (lb) => (((lb >>> 0) >>> 24) & 0xff) * 192;
const lbBaseY = (lb) => (((lb >>> 0) >>> 16) & 0xff) * 192;

/**
 * `?botPortalAvoid=on` (also `1` / `true`). DEFAULT OFF: absent, `off` or any
 * other value reads false. No page URL (node) reads false. Never throws.
 */
export function portalAvoidEnabled(search) {
  try {
    const src = search ?? (typeof location !== "undefined" ? location.search : "");
    const v = (new URLSearchParams(src || "").get("botPortalAvoid") || "").toLowerCase();
    return v === "on" || v === "1" || v === "true";
  } catch {
    return false;
  }
}

/** opts.portalAvoid (boolean) wins; otherwise the URL flag. Always a boolean. */
export function resolvePortalAvoid(opts) {
  if (opts && opts.portalAvoid != null) return opts.portalAvoid === true;
  return portalAvoidEnabled();
}

/** ItemType.Portal on PropertyInt 1, or the Portal description flag (the
 *  goto_compose.js findNearbyPortal test). Never throws. */
export function isPortalObject(host, guid) {
  try {
    const it = host.TryGetObjectIntProperty ? host.TryGetObjectIntProperty(guid, 1) : null;
    if (typeof it === "number" && it & ITEM_TYPE_PORTAL) return true;
  } catch (_) {
    /* fall through to the flag */
  }
  try {
    const f = host.TryGetObjectDescFlags ? host.TryGetObjectDescFlags(guid) : null;
    if (typeof f === "number" && f & ODF_PORTAL) return true;
  } catch (_) {
    /* not a portal */
  }
  return false;
}

/**
 * The portals to keep out of: [{guid, wx, wy, z, r}] in the world frame
 * (wx = lbX*192 + x, as router.js / the indoor graph).
 *   center       {wx, wy}; default the player pose. Portals beyond maxM are dropped.
 *   maxM         default 80
 *   reachM, clearanceM   r = reach + clearance (default 1.5 + 0.8)
 *   excludeGuids iterable of guids (the walk's own portal, when known)
 *   target       {wx, wy, maxM?}: the walk's own portal given as a point (a
 *                transit leg); the nearest portal within maxM (25) of it is dropped
 * Held or contained objects are skipped. Never throws; [] without a host.
 */
export function portalHazards(host, opts = {}) {
  if (!host || typeof host.NearbyGuids !== "function") return [];
  let guids;
  try {
    guids = host.NearbyGuids() || [];
  } catch (_) {
    return [];
  }
  let center = opts.center && Number.isFinite(opts.center.wx) && Number.isFinite(opts.center.wy) ? opts.center : null;
  if (!center) {
    try {
      const p = host.TryGetPlayerPose ? host.TryGetPlayerPose() : null;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) center = { wx: lbBaseX(p.objCellId) + p.x, wy: lbBaseY(p.objCellId) + p.y };
    } catch (_) {
      center = null;
    }
  }
  const maxM = Number.isFinite(opts.maxM) ? opts.maxM : PORTAL_HAZARD_MAX_M;
  const r = (Number.isFinite(opts.reachM) ? opts.reachM : PORTAL_REACH_M) + (Number.isFinite(opts.clearanceM) ? opts.clearanceM : PORTAL_CLEARANCE_M);
  const exclude = new Set();
  for (const g of opts.excludeGuids || []) exclude.add(g >>> 0);
  const out = [];
  for (const g of guids) {
    const guid = g >>> 0;
    if (exclude.has(guid) || !isPortalObject(host, guid)) continue;
    if (typeof host.TryGetObjectOwnershipInfo === "function") {
      try {
        const own = host.TryGetObjectOwnershipInfo(guid);
        if (own && (own.container || own.wielder)) continue; // not on the floor
      } catch (_) {
        /* treat as on the floor */
      }
    }
    let p = null;
    try {
      p = host.TryGetObjectPosition ? host.TryGetObjectPosition(guid) : null;
    } catch (_) {
      p = null;
    }
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const wx = lbBaseX(p.objCellId) + p.x;
    const wy = lbBaseY(p.objCellId) + p.y;
    if (center && Math.hypot(wx - center.wx, wy - center.wy) > maxM) continue;
    out.push({ guid, wx, wy, z: Number.isFinite(p.z) ? p.z : NaN, r });
  }
  const t = opts.target;
  if (t && Number.isFinite(t.wx) && Number.isFinite(t.wy)) {
    const tMax = Number.isFinite(t.maxM) ? t.maxM : TARGET_PORTAL_MAX_M;
    let bi = -1;
    let bd = Infinity;
    out.forEach((d, i) => {
      const dd = Math.hypot(d.wx - t.wx, d.wy - t.wy);
      if (dd <= tMax && dd < bd) {
        bd = dd;
        bi = i;
      }
    });
    if (bi >= 0) out.splice(bi, 1);
  }
  return out;
}

const zNear = (z, dz, span) => !Number.isFinite(z) || !Number.isFinite(dz) || Math.abs(z - dz) <= span;
const insideDisk = (p, d, span) => Math.hypot(p.wx - d.wx, p.wy - d.wy) < d.r && zNear(p.z, d.z, span);
const legWorld = (leg) => ({ wx: lbBaseX(leg.lb) + leg.x, wy: lbBaseY(leg.lb) + leg.y, z: leg.z });

// The disk the straight segment a->b enters first, or null. A segment that
// starts INSIDE a disk only counts when it heads toward the centre: a walk
// that begins beside a portal may leave it (WebAC portalAvoid.ts).
function firstBlockingDisk(a, b, disks, span) {
  const dx = b.wx - a.wx;
  const dy = b.wy - a.wy;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return null;
  let best = null;
  let bestT = Infinity;
  for (const d of disks) {
    if (!zNear(a.z, d.z, span) && !zNear(b.z, d.z, span)) continue;
    const fx = a.wx - d.wx;
    const fy = a.wy - d.wy;
    if (Math.hypot(fx, fy) < d.r) {
      if (fx * dx + fy * dy < 0 && bestT > 0) {
        best = d;
        bestT = 0;
      }
      continue;
    }
    // |a + t(b-a) - c| = r for t in [0, 1]; a grazing tangent is clear.
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - d.r * d.r;
    const disc = B * B - 4 * len2 * C;
    if (disc <= 0) continue;
    const t = (-B - Math.sqrt(disc)) / (2 * len2);
    if (t >= 0 && t <= 1 && t < bestT) {
      best = d;
      bestT = t;
    }
  }
  return best;
}

// Candidate side-step points for a->b around disk d, best first: on the rim
// (r + margin) along the normal from the centre through the segment's closest
// point, then the opposite side. A segment starting inside the disk steps
// straight out through its own start instead.
function sideStepPoints(a, b, d, margin) {
  const dx = b.wx - a.wx;
  const dy = b.wy - a.wy;
  const len = Math.hypot(dx, dy);
  const R = d.r + margin;
  const fx = a.wx - d.wx;
  const fy = a.wy - d.wy;
  const f = Math.hypot(fx, fy);
  if (f < d.r) {
    const ux = f > 1e-6 ? fx / f : -dy / len;
    const uy = f > 1e-6 ? fy / f : dx / len;
    return [{ wx: d.wx + ux * R, wy: d.wy + uy * R, z: a.z }];
  }
  const t = Math.max(0, Math.min(1, -(fx * dx + fy * dy) / (len * len)));
  const hx = a.wx + dx * t - d.wx;
  const hy = a.wy + dy * t - d.wy;
  const h = Math.hypot(hx, hy);
  const nx = h > 1e-6 ? hx / h : -dy / len;
  const ny = h > 1e-6 ? hy / h : dx / len;
  const z = Number.isFinite(a.z) && Number.isFinite(b.z) ? a.z + (b.z - a.z) * t : Number.isFinite(a.z) ? a.z : b.z;
  return [
    { wx: d.wx + nx * R, wy: d.wy + ny * R, z },
    { wx: d.wx - nx * R, wy: d.wy - ny * R, z },
  ];
}

// Side-step points (excluding a and b) that take a->b clear of every disk, or
// null when none is found within the depth / budget bound.
function clearSegment(a, b, disks, o, depth, budget) {
  const d = firstBlockingDisk(a, b, disks, o.span);
  if (!d) return [];
  if (depth >= MAX_SPLIT_DEPTH) return null;
  for (const w of sideStepPoints(a, b, d, o.margin)) {
    if (budget.left <= 0) return null;
    if (disks.some((x) => insideDisk(w, x, o.span))) continue;
    budget.left -= 1;
    const left = clearSegment(a, w, disks, o, depth + 1, budget);
    if (!left) continue;
    const right = clearSegment(w, b, disks, o, depth + 1, budget);
    if (!right) continue;
    return [...left, w, ...right];
  }
  return null;
}

// Move a waypoint that sits inside disk d out to its rim (+ margin), away from
// the centre (or back toward where the walk comes from when it is dead centre).
function displaceOut(p, d, margin, prev) {
  const fx = p.wx - d.wx;
  const fy = p.wy - d.wy;
  const f = Math.hypot(fx, fy);
  let ux = 1;
  let uy = 0;
  if (f > 1e-6) {
    ux = fx / f;
    uy = fy / f;
  } else if (prev) {
    const px = prev.wx - d.wx;
    const py = prev.wy - d.wy;
    const pl = Math.hypot(px, py);
    if (pl > 1e-6) {
      ux = px / pl;
      uy = py / pl;
    }
  }
  const R = d.r + margin;
  return { wx: d.wx + ux * R, wy: d.wy + uy * R, z: p.z };
}

// A leg at world point w in `leg`'s landblock frame (the toLegs convention:
// stamped with the destination cell, locals may leave [0,192); callers that
// normalize the frame re-bucket it).
const atWorld = (leg, w) => ({ ...leg, x: w.wx - lbBaseX(leg.lb), y: w.wy - lbBaseY(leg.lb) });

/**
 * Route `legs` ([{lb, x, y, z, ...}], router.js frame) around portal `disks`
 * (portalHazards). Returns {legs, changed, sideSteps, displaced, dropped,
 * unresolved?}; when nothing needs avoiding, or no clear detour exists, the
 * INPUT array itself comes back (changed:false).
 *   start       {wx, wy, z}: the player; the first segment is start -> legs[0]
 *   dropLeading drop legs[0] when it sits in a disk or start -> legs[0] enters
 *               one (toLegs' own-cell-centre leg; only where nothing maps leg
 *               indices back to path edges)
 *   marginM, floorSpanM  side-step distance outside the rim / floor band
 * The LAST leg is the caller's goal: a disk containing it is ignored (findPath's
 * goal-is-allowed rule). An inner leg inside a disk is moved to the rim.
 * Inserted legs carry `portalSideStep: true`, moved legs `portalDisplaced:
 * true`; both, and the leg a side-step follows, get `arriveM` 1.5 m. A
 * side-step copies the destination leg's `timeoutMs`.
 */
export function avoidPortalDisks(legs, disks, opts = {}) {
  const unchanged = (why) => ({ legs, changed: false, sideSteps: 0, displaced: 0, dropped: 0, ...(why ? { unresolved: why } : {}) });
  if (!Array.isArray(legs) || legs.length === 0 || !Array.isArray(disks) || disks.length === 0) return unchanged();
  const span = Number.isFinite(opts.floorSpanM) ? opts.floorSpanM : PORTAL_FLOOR_SPAN_M;
  const margin = Number.isFinite(opts.marginM) ? opts.marginM : SIDE_STEP_MARGIN_M;
  const pts = legs.map(legWorld);
  const goal = pts[pts.length - 1];
  const active = disks.filter(
    (d) => d && Number.isFinite(d.wx) && Number.isFinite(d.wy) && d.r > 0 && !insideDisk(goal, d, span)
  );
  if (!active.length) return unchanged();
  const s = opts.start;
  let prev = s && Number.isFinite(s.wx) && Number.isFinite(s.wy) ? { wx: s.wx, wy: s.wy, z: s.z } : null;
  const o = { span, margin };
  const budget = { left: MAX_SIDE_STEPS };
  const tight = (leg) => (Number.isFinite(leg.arriveM) ? leg : { ...leg, arriveM: SIDE_STEP_ARRIVE_M });
  const out = [];
  let sideSteps = 0;
  let displaced = 0;
  let dropped = 0;
  for (let i = 0; i < legs.length; i++) {
    const isGoal = i === legs.length - 1;
    let leg = legs[i];
    let p = pts[i];
    if (i === 0 && opts.dropLeading && !isGoal && prev) {
      if (active.some((d) => insideDisk(p, d, span)) || firstBlockingDisk(prev, p, active, span)) {
        dropped += 1;
        continue;
      }
    }
    if (!isGoal) {
      const hit = active.find((d) => insideDisk(p, d, span));
      if (hit) {
        const q = displaceOut(p, hit, margin, prev);
        if (active.some((d) => insideDisk(q, d, span))) return unchanged("waypoint inside a portal disk");
        p = q;
        leg = { ...tight(atWorld(leg, q)), portalDisplaced: true };
        displaced += 1;
      }
    }
    if (prev) {
      const mids = clearSegment(prev, p, active, o, 0, budget);
      if (!mids) return unchanged("no clear side-step");
      if (mids.length && out.length) out[out.length - 1] = tight(out[out.length - 1]);
      for (const w of mids) {
        const z = Number.isFinite(w.z) ? w.z : leg.z;
        out.push({
          lb: leg.lb >>> 0,
          x: w.wx - lbBaseX(leg.lb),
          y: w.wy - lbBaseY(leg.lb),
          z,
          arriveM: SIDE_STEP_ARRIVE_M,
          portalSideStep: true,
          ...(Number.isFinite(leg.timeoutMs) ? { timeoutMs: leg.timeoutMs } : {}),
        });
        sideSteps += 1;
      }
    }
    out.push(leg);
    prev = p;
  }
  if (!sideSteps && !displaced && !dropped) return unchanged();
  return { legs: out, changed: true, sideSteps, displaced, dropped };
}

/** Legs of the ORIGINAL list a walk got through, given `walked` legs of the
 *  avoided list (side-steps don't count): keeps goto_compose's
 *  stalledEdgeFromWalk leg->edge mapping right. Identity without side-steps. */
export function originalLegsWalked(legs, walked) {
  if (!Array.isArray(legs) || !(walked > 0)) return walked;
  let extra = 0;
  const n = Math.min(walked, legs.length);
  for (let i = 0; i < n; i++) if (legs[i] && legs[i].portalSideStep === true) extra += 1;
  return walked - extra;
}

/**
 * Outdoor half (NOT WIRED yet: global_router.js sends `avoid` only after a
 * blocked leg; seeding its first request is a follow-up). The sidecar contract
 * v2 `avoid` circles [{x, y, r}] for the disks within `corridorM` of the
 * straight from -> to line ({wx, wy}), so a request carries `avoid` only when
 * a portal is actually near the way. Disks containing either end are skipped.
 */
export function sidecarAvoidCircles(disks, from, to, opts = {}) {
  if (!Array.isArray(disks) || !from || !to) return [];
  const corridorM = Number.isFinite(opts.corridorM) ? opts.corridorM : 10;
  const dx = to.wx - from.wx;
  const dy = to.wy - from.wy;
  const len2 = dx * dx + dy * dy;
  const out = [];
  for (const d of disks) {
    if (!d || !Number.isFinite(d.wx) || !Number.isFinite(d.wy) || !(d.r > 0)) continue;
    if (Math.hypot(d.wx - from.wx, d.wy - from.wy) < d.r || Math.hypot(d.wx - to.wx, d.wy - to.wy) < d.r) continue;
    const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((d.wx - from.wx) * dx + (d.wy - from.wy) * dy) / len2)) : 0;
    const dist = Math.hypot(from.wx + dx * t - d.wx, from.wy + dy * t - d.wy);
    if (dist - d.r <= corridorM) out.push({ x: d.wx, y: d.wy, r: d.r });
  }
  return out;
}

export default {
  portalAvoidEnabled,
  resolvePortalAvoid,
  isPortalObject,
  portalHazards,
  avoidPortalDisks,
  originalLegsWalked,
  sidecarAvoidCircles,
};
