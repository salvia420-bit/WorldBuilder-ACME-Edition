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
// status = { state, leg, legs, walked, stitchBlocked, portalBlocked,
// portalHold, ticks } — `walked` counts legs actually completed (arrivals +
// consumed portal legs); portal-skipped stale legs don't count. `stitchBlocked`
// is true when FAILED came from a {stitch} leg's (shorter) watchdog — the plan
// stitched a straight line through something physical; replanning from the
// same pose is futile.
//
// PORTAL SPACE (2026-10-12): since 1aedd85c a teleport runs retail's portal-
// space tunnel, and 0d06b92e's `?portalHoldBuild` keeps it up while the
// destination interior builds (up to ~80 s). The movement step keeps ticking
// underneath it, so the old fixed 4 s settle walked the body into cells whose
// collision had not landed. The router now HOLDS while portal space is up
// (portal_gate.js, bounded by portalSpaceMaxMs): a tunnel that starts mid-walk
// (before the far-side pose arrives) or at a leg's start parks the route in
// PORTAL with no further MoveToPosition; it resumes when the tunnel ends. A
// portal leg counts as consumed only if the pose actually jumped — a tunnel
// that ends where it began (a failed hop) re-begins the same leg.
// `status.portalHold` is true during the hold and `status.ticks` advances on
// every tick, so walk polls (goto_compose walkLegs, global_router) can tell a
// live hold from a host that stopped ticking.
//
// This is what makes moveToPosition useful for travel: the combat/loot loops
// move a few metres; a route moves across the world.

const ARRIVE_M = 3.0; // within this of a leg target = arrived
const LEG_TIMEOUT_MS = 30_000; // per-leg watchdog
const PORTAL_CONTACT_MS = 6_000; // arrived at a portal leg but no hop within this
// window -> FAILED portalBlocked (the compose touch assist USEs the portal)
const STITCH_TIMEOUT_MS = 15_000; // watchdog for stitch legs (sidecar contract v2:
// sized so a full ~40m stitch stride (~10s at 4 m/s) has headroom, while a
// truly blocked stitch still fails 2x faster than a normal leg.
// legs flagged {stitch:true} are straight-line fallback through unbaked/carved
// space — a physical obstacle there never resolves, so fail it fast)
const REISSUE_MS = 3000; // re-issue moveTo if not closing
const PORTAL_SETTLE_MS = 4000; // after a real portal hop, let streaming catch up
const SEAM_JUMP_M = 30; // world-frame jump vs last known pose >= this = teleport

// World-frame (metres) from a full objCellId + landblock-local x,y — the ONE
// copy now lives in nav_frame.js (C3 Stage-0 dedup).
import { worldXY } from "./nav_frame.js";
import { portalSpaceActive, PORTAL_SPACE_MAX_HOLD_MS } from "./portal_gate.js";

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
    this.stitchTimeoutMs = opts.stitchTimeoutMs ?? STITCH_TIMEOUT_MS;
    this.portalContactMs = opts.portalContactMs ?? PORTAL_CONTACT_MS;
    this.portalSpaceMaxMs = opts.portalSpaceMaxMs ?? PORTAL_SPACE_MAX_HOLD_MS;
    // Test seam: opts.portalSpaceActive() replaces the host/page read.
    this._portalSpaceFn =
      typeof opts.portalSpaceActive === "function" ? opts.portalSpaceActive : () => portalSpaceActive(host);
    this.ticks = 0; // monotonic _tickInner count (status.ticks — walk-poll liveness)
    this._portalHoldSince = 0; // when the current portal-space hold began (0 = none)
    this._portalHolding = false; // the last tick returned on the hold (status.portalHold)
    // A flag still up past portalSpaceMaxMs is treated as stuck and ignored
    // until it reads false once (else every _beginLeg would re-enter the hold).
    this._portalSpaceIgnored = false;
    this._portalNoHop = false; // hold entered without a pose jump yet — resume decides
    this._portalFromWx = 0; // pose at that hold's entry (the no-hop resume test)
    this._portalFromWy = 0;
    this._portalFromValid = false;
    this.route = [];
    this.leg = 0;
    this.walked = 0; // legs actually completed (arrival or consumed portal)
    this.state = "IDLE"; // IDLE | WALK | PORTAL | DONE | FAILED
    this.legStartAt = 0;
    this.legDeadlineMs = this.legTimeoutMs; // per-leg (stitch legs get the shorter deadline)
    this.failedLegStitch = false; // FAILED on a stitch leg = physically blocked stitched segment
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
    this.failedLegStitch = false;
    this.failedLegPortal = false;
    this._clearPortalHold();
    this.state = this.route.length ? "WALK" : "DONE";
    this._beginLeg();
    return this;
  }

  cancel() {
    this.state = "IDLE";
    this._clearPortalHold();
    this.host.StopCompletely();
  }

  _inPortalSpace() {
    let up = false;
    try {
      up = this._portalSpaceFn() === true;
    } catch (_) {
      up = false;
    }
    if (!up) {
      this._portalSpaceIgnored = false; // the flag cleared — honour the next tunnel
      return false;
    }
    return !this._portalSpaceIgnored;
  }

  _clearPortalHold() {
    this._portalHoldSince = 0;
    this._portalHolding = false;
    this._portalNoHop = false;
  }

  /** Park the route in PORTAL because portal space is up but the far-side
   *  pose has not jumped yet (the tunnel starts with PlayerTeleport; the
   *  destination position lands later). Resume decides hop vs no-hop. */
  _enterPortalHold(now, pose, why) {
    if (pose) {
      [this._portalFromWx, this._portalFromWy] = worldXY(pose.objCellId, pose.x, pose.y);
      this._portalFromValid = true;
    } else {
      this._portalFromWx = this.lastWx;
      this._portalFromWy = this.lastWy;
      this._portalFromValid = this._poseSeen === true; // no anchor at all -> resume decides by leg distance
    }
    this._portalNoHop = true;
    this._portalHoldSince = now;
    this._portalHolding = true;
    this.state = "PORTAL";
    this.legStartAt = now;
    this.log(`portal space ${why} — holding the route until it ends`);
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
    // A leg that begins inside portal space (a replan right after a hop, a
    // route started mid-teleport) issues nothing until the tunnel ends.
    if (this._inPortalSpace()) {
      this._enterPortalHold(Date.now(), pose, `up at leg ${this.leg + 1}/${this.route.length}`);
      return;
    }
    this.legStartAt = Date.now();
    this.lastReissueAt = Date.now();
    this.lastD = Infinity;
    // Stitch legs (contract v2: straight-line fallback through unbaked/carved
    // space) get the short deadline — a physical obstacle there never clears.
    this.legDeadlineMs = Number.isFinite(l.timeoutMs)
      ? l.timeoutMs // per-leg override (goto_compose indoor transit legs)
      : l.stitch ? Math.min(this.legTimeoutMs, this.stitchTimeoutMs) : this.legTimeoutMs;
    this.portalArrivedAt = 0; // portal-leg contact window anchor (set on first arrival)
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
    this.ticks += 1;
    const inPortalSpace = this._inPortalSpace();
    this._portalHolding = false;

    if (this.state === "WALK" && inPortalSpace) {
      // The tunnel started mid-walk (a portal leg's hop, a recall, a server
      // teleport) before the far-side pose arrived — stop re-walking the old
      // leg under it.
      this._enterPortalHold(now, pose, "began mid-walk");
      return;
    }

    if (this.state === "PORTAL") {
      // Portal space up: the destination may still be building — hold, bounded.
      if (inPortalSpace) {
        if (!this._portalHoldSince) this._portalHoldSince = now;
        if (now - this._portalHoldSince <= this.portalSpaceMaxMs) {
          this._portalHolding = true;
          return;
        }
        this._portalSpaceIgnored = true; // stuck flag: stop honouring it until it clears
        this.log(`portal space still up after ${Math.round(this.portalSpaceMaxMs / 1000)}s — resuming anyway`);
      }
      if (this._portalHoldSince) {
        // The hold just ended: the tunnel only drops once the destination is
        // ready, so a hold longer than the settle served it (resume on this
        // tick); a shorter one waits out the rest of the settle. Either way the
        // no-pose watchdog below gets a fresh window instead of the hold's age.
        this.legStartAt = Math.max(this.legStartAt, now - this.settleMs - 1);
        this._portalHoldSince = 0;
      }
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
      if (now - this.legStartAt > this.legDeadlineMs) {
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
        this._clearPortalHold(); // a real hop — the resume consumes a portal leg
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
    // Per-leg arrival radius override (VTank Follow/Nav Min on VT-nav legs,
    // rynth/vt/nav) — the per-leg `timeoutMs` precedent in _beginLeg. A leg
    // without one keeps the router-wide radius (3.0 m) for every other mover.
    const arriveM = Number.isFinite(l.arriveM) ? l.arriveM : this.arriveM;
    const [lwx, lwy] = worldXY(l.lb, l.x, l.y);
    const d = Math.hypot(wx - lwx, wy - lwy);
    if (d <= arriveM) {
      if (l.portal) {
        // A portal leg's completion condition is the HOP (teleport detection
        // above), not proximity: advancing on 3m arrival let the next leg
        // (often a far-side pseudo-coord) drag the walker AWAY from the portal
        // (live: Arwic TN, walked to 2m then marched 20m southwest into the
        // yard fence). Hold the leg, keep nudging INTO the portal point, and
        // after portalContactMs without a hop fail as portalBlocked — the
        // goto_compose portal-touch assist then USEs the portal we are
        // standing on.
        if (!this.portalArrivedAt) this.portalArrivedAt = now;
        if (now - this.portalArrivedAt > this.portalContactMs) {
          this.log(`portal leg ${this.leg + 1} arrived but no hop in ${this.portalContactMs}ms — failing for the touch assist`);
          this.failedLegPortal = true;
          this.state = "FAILED";
          h.StopCompletely();
        } else if (now - this.lastReissueAt > this.reissueMs) {
          h.MoveToPosition(l.lb, l.x, l.y, l.z, true);
          this.lastReissueAt = now;
        }
        return;
      }
      this._advance();
      return;
    }
    // Fresh mover completion (2, read-clear — nonzero exactly on the tick it
    // completed) is a secondary arrival signal. NOT `ps.last`: the host latch
    // is never reset by a new movement command, so after any first arrival it
    // reads 2 forever — in a small dungeon whose legs sit within arriveM*2 of
    // the player, that phantom-advanced every leg with ZERO movement (v6.0
    // live: routed(4) to a next-room NPC with an unchanged pose, then the
    // straight-line pursue wedged on the wall exactly as before routing).
    const ps = h.GetPursuitStatus ? h.GetPursuitStatus() : { now: 0 };
    if (ps.now === 2 && d <= arriveM * 2 && !l.portal) {
      this._advance();
      return;
    }

    // Progress watchdog: re-issue if distance isn't closing.
    if (d >= this.lastD - 0.2 && now - this.lastReissueAt > this.reissueMs) {
      h.MoveToPosition(l.lb, l.x, l.y, l.z, true);
      this.lastReissueAt = now;
    }
    this.lastD = Math.min(this.lastD, d);

    if (now - this.legStartAt > this.legDeadlineMs) {
      this.log(l.stitch
        ? `stitch leg ${this.leg + 1} blocked (obstacle in stitched segment) — failing fast`
        : `leg ${this.leg + 1} timed out`);
      this.failedLegStitch = !!l.stitch;
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
    // A hold entered on portal space alone (no pose jump seen yet): did a
    // teleport actually happen under the tunnel?
    let hopped = true;
    if (this._portalNoHop) {
      let jump;
      if (this._portalFromValid) {
        jump = Math.hypot(wx - this._portalFromWx, wy - this._portalFromWy);
      } else {
        // No pre-hold anchor: only a portal leg's consumption hangs on this, so
        // measure from that leg — standing next to it means we never went in.
        const pl = this.route[this.leg];
        if (pl && pl.portal) {
          const [plx, ply] = worldXY(pl.lb, pl.x, pl.y);
          jump = Math.hypot(wx - plx, wy - ply);
        } else {
          jump = Infinity;
        }
      }
      hopped = jump >= this.seamJumpM;
      this.log(hopped
        ? `teleport landed under portal space (jump ${Number.isFinite(jump) ? jump.toFixed(0) : "?"}m)`
        : `portal space ended without a teleport (${jump.toFixed(1)}m) — re-walking leg ${this.leg + 1}`);
    }
    this._clearPortalHold();
    this.lastLb = pose.objCellId >>> 16;
    this.lastWx = wx;
    this.lastWy = wy;
    this._poseSeen = true;

    if (!hopped) {
      // Nothing moved us: the current leg (portal or not) is still the one to
      // walk — re-begin it with a fresh watchdog, consume nothing.
      this.state = "WALK";
      this._beginLeg();
      return;
    }

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
    return {
      state: this.state,
      leg: this.leg,
      legs: this.route.length,
      walked: this.walked,
      stitchBlocked: this.failedLegStitch,
      portalBlocked: !!this.failedLegPortal,
      portalHold: this._portalHolding === true,
      ticks: this.ticks,
    };
  }
}

export default RynthRouter;
