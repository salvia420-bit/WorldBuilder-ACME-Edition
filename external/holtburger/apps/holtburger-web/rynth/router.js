// RynthRouter — the local leg executor for report 09's nav integration.
//
// RynthNav's global routing (offline navmesh bake + Detour query + portal
// Dijkstra) is the sidecar's job (deferred XL, report 09 §sidecar). This is
// the in-page half report 09 assigns to the web client: given a route as an
// ordered list of legs, walk each via the proven `moveToPosition` primitive,
// detect arrival (pursuitStatus latch + a distance check), advance, and
// recognize portal hops (landblock change) so a leg that ends at a portal
// resumes on the far side. A route is just [{ lb, x, y, z, portal? }, ...].
//
// This is what makes moveToPosition useful for travel: the combat/loot loops
// move a few metres; a route moves across the world.

const ARRIVE_M = 3.0; // within this of a leg target = arrived
const LEG_TIMEOUT_MS = 30_000; // per-leg watchdog
const REISSUE_MS = 3000; // re-issue moveTo if not closing
const PORTAL_SETTLE_MS = 4000; // after a landblock change, let streaming catch up

export class RynthRouter {
  constructor(host, opts = {}) {
    this.host = host;
    this.log = opts.log || ((m) => console.log(`[router] ${m}`));
    this.route = [];
    this.leg = 0;
    this.state = "IDLE"; // IDLE | WALK | PORTAL | DONE | FAILED
    this.legStartAt = 0;
    this.lastD = Infinity;
    this.lastReissueAt = 0;
    this.lastLb = 0;
    this.onArrive = opts.onArrive || null;
  }

  /** Begin following `route` (array of {lb,x,y,z,portal?}). */
  follow(route) {
    this.route = route.slice();
    this.leg = 0;
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
    this.lastLb = pose ? pose.objCellId >>> 16 : 0;
    this.legStartAt = Date.now();
    this.lastReissueAt = Date.now();
    this.lastD = Infinity;
    this.host.MoveToPosition(l.lb, l.x, l.y, l.z, true);
    this.log(`leg ${this.leg + 1}/${this.route.length} -> lb=0x${(l.lb >>> 0).toString(16)} (${l.x.toFixed(0)},${l.y.toFixed(0)})`);
  }

  /** Drive once per tick (call from a host.onTick or a kernel arm). */
  tick() {
    if (this.state !== "WALK" && this.state !== "PORTAL") return;
    const h = this.host;
    const now = Date.now();
    const pose = h.TryGetPlayerPose();
    if (!pose) return;
    const l = this.route[this.leg];

    if (this.state === "PORTAL") {
      // Waiting for the far side to stream in after a landblock change.
      if (now - this.legStartAt > PORTAL_SETTLE_MS) {
        this.state = "WALK";
        this._advance();
      }
      return;
    }

    const curLb = pose.objCellId >>> 16;
    // Portal detection: an unexpected landblock change means we traversed
    // a portal. If the leg was flagged as a portal leg, that's success;
    // either way, settle then advance.
    if (curLb !== this.lastLb) {
      this.log(`landblock ${this.lastLb.toString(16)} -> ${curLb.toString(16)} (portal?)`);
      this.lastLb = curLb;
      this.state = "PORTAL";
      this.legStartAt = now;
      h.StopCompletely();
      return;
    }

    // Same-landblock arrival check.
    const sameLb = curLb === (l.lb >>> 16);
    const d = sameLb ? Math.hypot(pose.x - l.x, pose.y - l.y) : Infinity;
    if (sameLb && d <= ARRIVE_M) {
      this._advance();
      return;
    }
    // pursuitStatus arrival latch (2) is a secondary completion signal.
    const ps = h.GetPursuitStatus ? h.GetPursuitStatus() : { last: 0 };
    if (ps.last === 2 && sameLb && d <= ARRIVE_M * 2) {
      this._advance();
      return;
    }

    // Progress watchdog: re-issue if distance isn't closing.
    if (d >= this.lastD - 0.2 && now - this.lastReissueAt > REISSUE_MS) {
      h.MoveToPosition(l.lb, l.x, l.y, l.z, true);
      this.lastReissueAt = now;
    }
    this.lastD = Math.min(this.lastD, d);

    if (now - this.legStartAt > LEG_TIMEOUT_MS) {
      this.log(`leg ${this.leg + 1} timed out`);
      this.state = "FAILED";
      h.StopCompletely();
    }
  }

  _advance() {
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
    return { state: this.state, leg: this.leg, legs: this.route.length };
  }
}

export default RynthRouter;
