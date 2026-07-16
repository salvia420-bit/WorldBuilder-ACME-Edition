// RynthRouter — the local leg executor for report 09's nav integration.
//
// RynthNav's global routing (offline navmesh bake + Detour query + portal
// Dijkstra) is the sidecar's job (deferred XL, report 09 §sidecar). This is
// the in-page half report 09 assigns to the web client: given a route as an
// ordered list of legs, walk each via the proven `moveToPosition` primitive,
// detect arrival (pursuitStatus latch + a world-frame distance check), advance,
// and recognize REAL portal hops so a leg that ends at a portal resumes on the
// far side. A route is just [{ lb, x, y, z, portal? }, ...].
//
// Portal vs seam: a landblock-word change alone is NOT a portal — on-foot
// legs cross outdoor seams all the time. We track last tick's world-frame
// position (wx = lbX*192 + x, wy = lbY*192 + y) and treat any world-frame
// jump >= SEAM_JUMP_M since the last KNOWN pose as a teleport — with or
// without an lb-word change (a same-landblock recall/rubber-band is still a
// teleport and must not grind the leg into its timeout). An lb change with a
// small jump = seam crossing on foot, keep walking the leg. Arrival distance
// is world-frame against the leg's own lb, so cross-seam legs can arrive.
//
// After a teleport we settle (PORTAL state), then resume at the REMAINING
// leg nearest the new pose: a leg flagged {portal:true} is consumed by the
// hop (resume scan starts past it); an unexpected teleport may re-begin the
// current leg (fresh watchdog). Stale waypoints whose world-frame position
// belongs to the pre-hop side are skipped, not walked back to.
//
// Null poses (pre-first-tick, mid-teleport) neither advance the route nor
// fake a portal — the seam/portal anchor only ever updates from a real pose
// — but the per-leg watchdog keeps running so a dead pose source fails the
// route instead of stalling it forever. tick() is reentrancy-guarded.
//
// status = { state, leg, legs, walked } — `walked` counts legs actually
// completed (arrivals + consumed portal legs); portal-skipped stale legs
// don't count.
//
// This is what makes moveToPosition useful for travel: the combat/loot loops
// move a few metres; a route moves across the world.

const ARRIVE_M = 3.0; // within this of a leg target = arrived
const LEG_TIMEOUT_MS = 30_000; // per-leg watchdog
const REISSUE_MS = 3000; // re-issue moveTo if not closing
const PORTAL_SETTLE_MS = 4000; // after a real portal hop, let streaming catch up
const SEAM_JUMP_M = 30; // world-frame jump vs last known pose >= this = teleport

// World-frame (metres) from a full objCellId + landblock-local x,y.
function worldXY(objCellId, x, y) {
  return [((objCellId >>> 24) & 0xff) * 192 + x, ((objCellId >>> 16) & 0xff) * 192 + y];
}

export class RynthRouter {
  constructor(host, opts = {}) {
    this.host = host;
    this.log = opts.log || ((m) => console.log(`[router] ${m}`));
    // Timing/threshold overrides (tests + live tuning); defaults above.
    this.arriveM = opts.arriveM ?? ARRIVE_M;
    this.legTimeoutMs = opts.legTimeoutMs ?? LEG_TIMEOUT_MS;
    this.reissueMs = opts.reissueMs ?? REISSUE_MS;
    this.settleMs = opts.settleMs ?? PORTAL_SETTLE_MS;
    this.seamJumpM = opts.seamJumpM ?? SEAM_JUMP_M;
    this.route = [];
    this.leg = 0;
    this.walked = 0; // legs actually completed (arrival or consumed portal)
    this.state = "IDLE"; // IDLE | WALK | PORTAL | DONE | FAILED
    this.legStartAt = 0;
    this.lastD = Infinity;
    this.lastReissueAt = 0;
    this.lastLb = 0;
    this.lastWx = 0; // last KNOWN world-frame position (seam vs portal)
    this.lastWy = 0;
    this._poseSeen = false; // anchor above is valid (seeded from a real pose)
    this._inTick = false; // reentrancy guard
    this.onArrive = opts.onArrive || null;
  }

  /** Begin following `route` (array of {lb,x,y,z,portal?}). */
  follow(route) {
    this.route = route.slice();
    this.leg = 0;
    this.walked = 0;
    this.state = this.route.length ? "WALK" : "DONE";
    this._beginLeg();
    return this;
  }

  cancel() {
    this.state = "IDLE";
    this.host.StopCompletely();
  }

  get done() {
    return this.state === "DONE" || this.state === "FAILED";
  }

  _beginLeg() {
    const l = this.route[this.leg];
    if (!l) {
      this.state = "DONE";
      this.host.StopCompletely();
      this.log(`route complete (${this.route.length} legs)`);
      return;
    }
    const pose = this.host.TryGetPlayerPose();
    // Null pose here (pre-first-tick boot, mid-teleport): leave the anchor
    // unseeded — tick() seeds it from the FIRST real pose instead of
    // comparing against a zero/stale anchor and faking a portal.
    this._poseSeen = !!pose;
    if (pose) {
      this.lastLb = pose.objCellId >>> 16;
      [this.lastWx, this.lastWy] = worldXY(pose.objCellId, pose.x, pose.y);
    }
    this.legStartAt = Date.now();
    this.lastReissueAt = Date.now();
    this.lastD = Infinity;
    this.host.MoveToPosition(l.lb, l.x, l.y, l.z, true);
    this.log(`leg ${this.leg + 1}/${this.route.length} -> lb=0x${(l.lb >>> 0).toString(16)} (${l.x.toFixed(0)},${l.y.toFixed(0)})`);
  }

  /** Drive once per tick (call from a host.onTick or a kernel arm).
   *  Reentrancy-safe: a nested tick (host callback re-entering under a fast
   *  tick source) is a no-op. */
  tick() {
    if (this.state !== "WALK" && this.state !== "PORTAL") return;
    if (this._inTick) return;
    this._inTick = true;
    try {
      this._tickInner();
    } finally {
      this._inTick = false;
    }
  }

  _tickInner() {
    const h = this.host;
    const now = Date.now();
    const pose = h.TryGetPlayerPose();

    if (this.state === "PORTAL") {
      // Waiting for the far side to stream in after a teleport.
      if (now - this.legStartAt <= this.settleMs) return;
      if (!pose) {
        // Settled but no pose yet — keep waiting, bounded by the watchdog.
        if (now - this.legStartAt > this.legTimeoutMs) {
          this.log("no pose after portal settle — failing route");
          this.state = "FAILED";
          h.StopCompletely();
        }
        return;
      }
      this._resumeAfterPortal(pose);
      return;
    }

    const l = this.route[this.leg];

    if (!pose) {
      // Null-pose ticks neither advance nor fake a portal, but the leg
      // watchdog still runs — a dead pose source must fail, not stall.
      if (now - this.legStartAt > this.legTimeoutMs) {
        this.log(`leg ${this.leg + 1} timed out (no pose)`);
        this.state = "FAILED";
        h.StopCompletely();
      }
      return;
    }

    const curLb = pose.objCellId >>> 16;
    const [wx, wy] = worldXY(pose.objCellId, pose.x, pose.y);

    if (!this._poseSeen) {
      // First real pose since the leg began with none: seed the anchor.
      this._poseSeen = true;
      this.lastLb = curLb;
      this.lastWx = wx;
      this.lastWy = wy;
    } else {
      // Teleport vs seam: the world-frame jump vs the last KNOWN pose alone
      // decides — a same-lb recall/rubber-band is still a teleport; an lb
      // change with a small jump is an on-foot seam crossing.
      const jump = Math.hypot(wx - this.lastWx, wy - this.lastWy);
      if (jump >= this.seamJumpM) {
        this.log(`teleport: lb ${this.lastLb.toString(16)} -> ${curLb.toString(16)}, jump ${jump.toFixed(0)}m (portal)`);
        this.lastLb = curLb;
        this.lastWx = wx;
        this.lastWy = wy;
        this.state = "PORTAL";
        this.legStartAt = now;
        h.StopCompletely();
        return;
      }
      if (curLb !== this.lastLb) {
        this.log(`seam -> ${curLb.toString(16)} (${jump.toFixed(1)}m, walking on)`);
        this.lastLb = curLb;
      }
    }
    this.lastWx = wx;
    this.lastWy = wy;

    // World-frame arrival check against the leg's own lb (cross-seam safe).
    const [lwx, lwy] = worldXY(l.lb, l.x, l.y);
    const d = Math.hypot(wx - lwx, wy - lwy);
    if (d <= this.arriveM) {
      this._advance();
      return;
    }
    // pursuitStatus arrival latch (2) is a secondary completion signal.
    const ps = h.GetPursuitStatus ? h.GetPursuitStatus() : { last: 0 };
    if (ps.last === 2 && d <= this.arriveM * 2) {
      this._advance();
      return;
    }

    // Progress watchdog: re-issue if distance isn't closing.
    if (d >= this.lastD - 0.2 && now - this.lastReissueAt > this.reissueMs) {
      h.MoveToPosition(l.lb, l.x, l.y, l.z, true);
      this.lastReissueAt = now;
    }
    this.lastD = Math.min(this.lastD, d);

    if (now - this.legStartAt > this.legTimeoutMs) {
      this.log(`leg ${this.leg + 1} timed out`);
      this.state = "FAILED";
      h.StopCompletely();
    }
  }

  /** After a teleport settles: re-anchor on the far side and resume at the
   *  remaining leg nearest the new pose. A {portal:true} leg was consumed by
   *  the hop (counts as walked; scan starts past it); an unexpected teleport
   *  may re-begin the current leg with a fresh watchdog. Stale legs whose
   *  world-frame position belongs to the pre-hop side are skipped. */
  _resumeAfterPortal(pose) {
    const [wx, wy] = worldXY(pose.objCellId, pose.x, pose.y);
    this.lastLb = pose.objCellId >>> 16;
    this.lastWx = wx;
    this.lastWy = wy;
    this._poseSeen = true;

    const cur = this.route[this.leg];
    const from = cur && cur.portal ? this.leg + 1 : this.leg;
    if (cur && cur.portal) {
      // Portal leg consumed by the hop — counts as walked, and consumers
      // still get their per-leg arrival callback (as _advance would give).
      this.walked += 1;
      if (this.onArrive) {
        try {
          this.onArrive(this.leg, cur);
        } catch (_) {
          /* consumer error must not stall routing */
        }
      }
    }
    let best = -1;
    let bestD = Infinity;
    for (let i = from; i < this.route.length; i++) {
      const [lwx, lwy] = worldXY(this.route[i].lb, this.route[i].x, this.route[i].y);
      const d = Math.hypot(wx - lwx, wy - lwy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.state = "WALK";
    if (best < 0) {
      this.leg = this.route.length; // portal was the final leg
    } else {
      if (best > from) this.log(`portal resume skips ${best - from} stale leg(s)`);
      this.leg = best;
    }
    this._beginLeg();
  }

  _advance() {
    this.walked += 1;
    if (this.onArrive) {
      try {
        this.onArrive(this.leg, this.route[this.leg]);
      } catch (_) {
        /* consumer error must not stall routing */
      }
    }
    this.leg += 1;
    this._beginLeg();
  }

  get status() {
    return { state: this.state, leg: this.leg, legs: this.route.length, walked: this.walked };
  }
}

export default RynthRouter;
