// RouteRecorder — the experience loop's first half (NavAtlas W2.1). Turns a
// walk the bot ACTUALLY completed into a reusable atlas route. This is
// perception + experience only (SPEC §0): breadcrumbs are the bot's own
// pose samples during a real goto/exit_building/manual walk — never a
// server-side path.
//
// Contract (pull model, driven by whatever tick already drives router.js):
//   const rec = new RouteRecorder({ log });
//   rec.start({ from: pose, runRate, runSkill });   // arm at travel begin
//   rec.sample(host.TryGetPlayerPose());             // once per host tick
//   rec.notePortalHop({ before, after, label });     // from router PORTAL xition
//   const route = rec.finish({ ok: true, to: pose }); // RDP-simplify -> route|null
//
// A breadcrumb is kept when the pose has moved >= spacingM (world-frame)
// since the last kept crumb OR the landblock word changed (Alastor's
// landcell-recording insight: a cell change is always route-worthy). A
// world-frame jump >= seamJumpM is a teleport/portal (same threshold as
// router.js SEAM_JUMP_M) — annotated as a portal crumb, NOT walked. On
// finish, the crumb polyline is RDP-simplified per portal-bounded segment
// (portal crumbs are un-removable anchors) so a straight corridor collapses
// to two legs while a dog-leg keeps its corners.
//
// finish({ok:false}) returns null — a route that did not complete is not
// experience and is never stored. A route with < minLegs kept crumbs is
// likewise dropped (nothing worth reusing).
//
// Format contract v2 (agreed with the replay side): finish() stamps `fmt: 2`
// and, per leg, `portal: true` on the DEPARTURE leg of a >= hopM (500 m) hop
// and `indoor: true` for any EnvCell waypoint (cell low word >= 0x0100). Indoor
// sampling is densified (indoorSpacingM, 4 m vs 8 m outdoor) and a de-noise pass
// drops sub-denoiseM (3 m) cell-boundary jitter so a wedge-meander does not become
// a leg. Legacy (fmt-less) routes stay valid and are never migrated.

// World-frame (metres) from a full objCellId + landblock-local x,y (mirror of
// router.js worldXY / observe.js global frame).
function worldXY(objCellId, x, y) {
  return [((objCellId >>> 24) & 0xff) * 192 + x, ((objCellId >>> 16) & 0xff) * 192 + y];
}

const SPACING_M = 8; // keep a crumb every >= this many world-frame metres (OUTDOOR cadence)
const INDOOR_SPACING_M = 4; // denser cadence while indoors (2x outdoor): EnvCell interiors
// are off-mesh and replayed tightly, and the v16 fixture's 10-20 m indoor leg
// spacing proved marginal — 4 m sampling keeps simplified indoor legs well under
// the ~8 m replay budget. (contract v2 §densify)
const SEAM_JUMP_M = 30; // world-frame jump >= this = teleport/portal (router.js parity)
const DENOISE_M = 3; // drop a would-be crumb within this of the previous RECORDED crumb —
// kills sub-metre cell-boundary jitter / wedge-meander oscillation without smoothing
// real geometry (a legitimate spacing keep is always >= INDOOR_SPACING_M > this).
const HOP_M = 500; // consecutive legs >= this apart (world-frame) => a teleport/portal hop;
// the DEPARTURE leg is flagged portal:true (contract v2 §format).
const MIN_LEGS = 2; // a route worth storing has at least this many legs
const RDP_EPS_M = 2.0; // RDP tolerance (below router ARRIVE_M=3 so legs stay arrivable)
const FMT_VERSION = 2; // recorded-route format version (portal-on-departure + indoor flags)

// Indoor = the pose sits in an EnvCell: objCellId low word (cell) >= 0x0100
// (outdoor cells are 0x0001..0x0040). (contract v2 §indoor)
function isIndoorCell(objCellId) {
  return ((objCellId >>> 0) & 0xffff) >= 0x0100;
}

export class RouteRecorder {
  constructor(opts = {}) {
    this.log = opts.log || ((m) => console.log(`[recorder] ${m}`));
    this.spacingM = opts.spacingM ?? SPACING_M;
    this.indoorSpacingM = opts.indoorSpacingM ?? INDOOR_SPACING_M;
    this.seamJumpM = opts.seamJumpM ?? SEAM_JUMP_M;
    this.denoiseM = opts.denoiseM ?? DENOISE_M;
    this.hopM = opts.hopM ?? HOP_M;
    this.minLegs = opts.minLegs ?? MIN_LEGS;
    this.rdpEps = opts.rdpEps ?? RDP_EPS_M;
    this._reset();
  }

  _reset() {
    this.armed = false;
    this.crumbs = []; // { lb, x, y, z, wx, wy, portal, label, tMs }
    this.portalsUsed = 0;
    this.startedAt = 0;
    this.meta = {};
    this._lastWx = 0;
    this._lastWy = 0;
    this._lastLb = 0;
    this._seen = false; // an anchor pose has been observed
  }

  /** Arm the recorder. `from` (a pose) seeds the first crumb; if null the
   *  first sample() seeds it instead. meta carries runRate/runSkill/source. */
  start(meta = {}) {
    this._reset();
    this.armed = true;
    this.startedAt = Date.now();
    this.meta = {
      runRate: meta.runRate ?? null,
      runSkill: meta.runSkill ?? null,
      source: meta.source || "walk",
      name: meta.name || null,
    };
    if (meta.from) this._push(meta.from, false, null);
    this.log(`armed${meta.from ? " (seeded)" : ""}`);
    return this;
  }

  _push(pose, portal, label) {
    const [wx, wy] = worldXY(pose.objCellId, pose.x, pose.y);
    this.crumbs.push({
      lb: pose.objCellId >>> 0,
      x: pose.x,
      y: pose.y,
      z: pose.z,
      wx,
      wy,
      portal: !!portal,
      label: label || null,
      tMs: Date.now() - this.startedAt,
    });
    this._lastWx = wx;
    this._lastWy = wy;
    this._lastLb = pose.objCellId >>> 16;
    this._seen = true;
    if (portal) this.portalsUsed += 1;
  }

  /** Offer a pose to the recorder (once per host tick). Keeps it as a crumb
   *  only if it advances the route (>= spacingM, cell change, or a portal
   *  jump). Null poses (boot / mid-teleport) are ignored. */
  sample(pose) {
    if (!this.armed || !pose) return;
    const [wx, wy] = worldXY(pose.objCellId, pose.x, pose.y);
    if (!this._seen) {
      this._push(pose, false, null);
      return;
    }
    const jump = Math.hypot(wx - this._lastWx, wy - this._lastWy);
    if (jump >= this.seamJumpM) {
      // Teleport/portal: the far-side pose is a portal-annotated crumb. The
      // hop itself is not walked, so it does not count toward leg length.
      this._push(pose, true, "portal");
      this.log(`portal crumb (jump ${jump.toFixed(0)}m)`);
      return;
    }
    // Indoor (EnvCell) interiors are densified — a denser crumb cadence keeps
    // the tight, off-mesh indoor legs faithful for replay (contract v2 §densify).
    const spacing = isIndoorCell(pose.objCellId) ? this.indoorSpacingM : this.spacingM;
    const lbChanged = (pose.objCellId >>> 16) !== this._lastLb;
    if (jump >= spacing || lbChanged) {
      // De-noise: a crumb within denoiseM of the last RECORDED crumb is
      // cell-boundary jitter / wedge-meander oscillation, not real geometry — a
      // genuine spacing keep is always >= spacing (> denoiseM), so only sub-
      // denoiseM cell-change crumbs are dropped here (contract v2 §de-noise).
      if (jump < this.denoiseM) return;
      this._push(pose, false, null);
    }
  }

  /** Explicit portal annotation from a router PORTAL-state transition. Idempotent
   *  vs sample()'s auto-detect: if the last crumb is already the portal arrival
   *  (within seamJumpM of `after`), only its label is set. */
  notePortalHop({ before, after, label } = {}) {
    if (!this.armed || !after) return;
    const [wx, wy] = worldXY(after.objCellId, after.x, after.y);
    const last = this.crumbs[this.crumbs.length - 1];
    if (last && Math.hypot(wx - last.wx, wy - last.wy) < this.seamJumpM) {
      if (!last.portal) {
        last.portal = true;
        this.portalsUsed += 1;
      }
      last.label = label || last.label || "portal";
      return;
    }
    this._push(after, true, label || "portal");
    this.log("portal hop noted");
  }

  get status() {
    return {
      armed: this.armed,
      breadcrumbs: this.crumbs.length,
      portals: this.portalsUsed,
      walkedMs: this.armed ? Date.now() - this.startedAt : 0,
    };
  }

  /** Finish the recording. ok:false or too-short -> null (not experience,
   *  not stored). Otherwise RDP-simplify and return a route object (schema in
   *  atlas.js) for the caller to atlas.saveRoute(). */
  finish({ ok, to, reason } = {}) {
    if (!this.armed) return null;
    const walkedMs = Date.now() - this.startedAt;
    this.armed = false;
    if (!ok) {
      this.log(`discarded (ok=false${reason ? ` ${reason}` : ""})`);
      return null;
    }
    // Append the final pose if it meaningfully extends the last crumb.
    if (to) {
      const [wx, wy] = worldXY(to.objCellId, to.x, to.y);
      const last = this.crumbs[this.crumbs.length - 1];
      if (!last || Math.hypot(wx - last.wx, wy - last.wy) >= this.rdpEps) this._push(to, false, null);
    }
    const legs = this._simplify();
    if (legs.length < this.minLegs) {
      this.log(`discarded (only ${legs.length} legs, < ${this.minLegs})`);
      return null;
    }
    // contract v2: re-express the internal (arrival-flagged) portal crumbs as
    // DEPARTURE-flagged legs + tag indoor legs; portalsUsed becomes the hop count.
    this.portalsUsed = this._applyV2Flags(legs);
    // Ground units skip the hop: under the departure convention the hop is the
    // segment leg[i-1]->leg[i] where leg[i-1] is portal-flagged.
    let estUnits = 0;
    for (let i = 1; i < legs.length; i++) {
      if (legs[i - 1].portal) continue; // portal hop crosses no ground
      const [awx, awy] = worldXY(legs[i - 1].lb, legs[i - 1].x, legs[i - 1].y);
      const [bwx, bwy] = worldXY(legs[i].lb, legs[i].x, legs[i].y);
      estUnits += Math.hypot(bwx - awx, bwy - awy);
    }
    const first = legs[0];
    const lastLeg = legs[legs.length - 1];
    const route = {
      fmt: FMT_VERSION,
      from: { lb: first.lb, x: first.x, y: first.y, z: first.z },
      to: { lb: lastLeg.lb, x: lastLeg.x, y: lastLeg.y, z: lastLeg.z },
      legs,
      portalsUsed: this.portalsUsed,
      estUnits: Math.round(estUnits),
      walkedMs,
      runSkillAtRecord: this.meta.runSkill,
      runRateAtRecord: this.meta.runRate,
      source: this.meta.source,
      name: this.meta.name,
    };
    this.log(`route: ${legs.length} legs, ${route.estUnits}u, ${this.portalsUsed} portal(s), ${walkedMs}ms`);
    return route;
  }

  /** RDP simplification, split at portal crumbs (portals are hard anchors so a
   *  hop is never collapsed away). Each non-portal segment is thinned to
   *  rdpEps; endpoints + all portal crumbs are always kept. Output legs are
   *  {lb,x,y,z,portal?,label?} in router.follow() frame. */
  _simplify() {
    const pts = this.crumbs;
    if (pts.length <= 2) return pts.map(toLeg);
    // Split indices at portal crumbs (a portal is both a segment end and start).
    const out = [];
    let segStart = 0;
    const flushSeg = (a, b) => {
      const kept = rdp(pts, a, b, this.rdpEps);
      for (const idx of kept) {
        // Avoid double-adding a boundary already emitted.
        if (out.length && out[out.length - 1] === idx) continue;
        out.push(idx);
      }
    };
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].portal) {
        flushSeg(segStart, i - 1 >= segStart ? i - 1 : segStart);
        if (out[out.length - 1] !== i) out.push(i); // the portal crumb itself
        segStart = i;
      }
    }
    flushSeg(segStart, pts.length - 1);
    // De-dup consecutive identical indices, map to legs.
    const legs = [];
    let prev = -1;
    for (const idx of out) {
      if (idx === prev) continue;
      prev = idx;
      legs.push(toLeg(pts[idx]));
    }
    return legs;
  }

  /** contract v2 flag pass over the simplified legs (mutates in place):
   *   - portal:true moves to the DEPARTURE leg — leg[i] where the hop
   *     leg[i]->leg[i+1] is >= hopM in world-frame — carrying the label the
   *     arrival crumb held (the recorder detects hops internally as seam jumps;
   *     the >= hopM rule is the authoritative on-disk flag the replay side reads).
   *   - indoor:true on any leg whose cell is an EnvCell (low word >= 0x0100).
   * Returns the hop (departure-portal) count. */
  _applyV2Flags(legs) {
    // Lift the internal arrival-crumb portal labels off the legs first.
    const arrivalLabel = new Array(legs.length).fill(null);
    for (let i = 0; i < legs.length; i++) {
      if (legs[i].portal) {
        arrivalLabel[i] = legs[i].label || "portal";
        delete legs[i].portal;
        delete legs[i].label;
      }
    }
    let portals = 0;
    for (let i = 0; i + 1 < legs.length; i++) {
      const [awx, awy] = worldXY(legs[i].lb, legs[i].x, legs[i].y);
      const [bwx, bwy] = worldXY(legs[i + 1].lb, legs[i + 1].x, legs[i + 1].y);
      if (Math.hypot(bwx - awx, bwy - awy) >= this.hopM) {
        legs[i].portal = true;
        legs[i].label = arrivalLabel[i + 1] || legs[i].label || "portal";
        portals++;
      }
    }
    for (const l of legs) if (isIndoorCell(l.lb)) l.indoor = true;
    return portals;
  }
}

function toLeg(c) {
  const leg = { lb: c.lb, x: c.x, y: c.y, z: c.z };
  if (c.portal) {
    leg.portal = true;
    if (c.label) leg.label = c.label;
  }
  return leg;
}

// Ramer–Douglas–Peucker over the world-frame (wx,wy) polyline of crumbs
// [lo..hi] inclusive. Returns the sorted list of KEPT indices (always
// includes lo and hi). Iterative to avoid recursion depth on long walks.
function rdp(pts, lo, hi, eps) {
  if (hi <= lo) return [lo];
  const keep = new Uint8Array(pts.length);
  keep[lo] = 1;
  keep[hi] = 1;
  const stack = [[lo, hi]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1;
    let maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pts[i], pts[a], pts[b]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > eps && maxI > a) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out = [];
  for (let i = lo; i <= hi; i++) if (keep[i]) out.push(i);
  return out;
}

function perpDist(p, a, b) {
  const dx = b.wx - a.wx;
  const dy = b.wy - a.wy;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.wx - a.wx, p.wy - a.wy);
  // |cross((p-a),(b-a))| / |b-a|
  const cross = Math.abs((p.wx - a.wx) * dy - (p.wy - a.wy) * dx);
  return cross / Math.sqrt(len2);
}

export default RouteRecorder;
