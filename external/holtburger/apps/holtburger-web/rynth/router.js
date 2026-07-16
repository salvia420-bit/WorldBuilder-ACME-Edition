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
// position (wx = lbX*192 + x, wy = lbY*192 + y) and only treat a landblock
// change as a portal/teleport when the world-frame jump since last tick is
// >= SEAM_JUMP_M; smaller = seam crossing on foot, keep walking the leg.
// Arrival distance is world-frame against the leg's own lb, so cross-seam
// legs can arrive.
//
// This is what makes moveToPosition useful for travel: the combat/loot loops
// move a few metres; a route moves across the world.

const ARRIVE_M = 3.0; // within this of a leg target = arrived
const LEG_TIMEOUT_MS = 30_000; // per-leg watchdog
const REISSUE_MS = 3000; // re-issue moveTo if not closing
const PORTAL_SETTLE_MS = 4000; // after a real portal hop, let streaming catch up
const SEAM_JUMP_M = 30; // world-frame jump/tick >= this on a lb change = portal

// World-frame (metres) from a full objCellId + landblock-local x,y.
function worldXY(objCellId, x, y) {
  return [((objCellId >>> 24) & 0xff) * 192 + x, ((objCellId >>> 16) & 0xff) * 192 + y];
}

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
    this.lastWx = 0; // last tick's world-frame position (seam vs portal)
    this.lastWy = 0;
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
    if (pose) [this.lastWx, this.lastWy] = worldXY(pose.objCellId, pose.x, pose.y);
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
    const [wx, wy] = worldXY(pose.objCellId, pose.x, pose.y);
    // Portal vs seam: only a landblock change WITH a discontinuous world-frame
    // jump is a portal/teleport; a small jump is an on-foot seam crossing —
    // update lastLb and keep walking the same leg.
    if (curLb !== this.lastLb) {
      const jump = Math.hypot(wx - this.lastWx, wy - this.lastWy);
      this.lastLb = curLb;
      if (jump >= SEAM_JUMP_M) {
        this.log(`landblock -> ${curLb.toString(16)}, jump ${jump.toFixed(0)}m (portal)`);
        this.lastWx = wx;
        this.lastWy = wy;
        this.state = "PORTAL";
        this.legStartAt = now;
        h.StopCompletely();
        return;
      }
      this.log(`seam -> ${curLb.toString(16)} (${jump.toFixed(1)}m, walking on)`);
    }
    this.lastWx = wx;
    this.lastWy = wy;

    // World-frame arrival check against the leg's own lb (cross-seam safe).
    const [lwx, lwy] = worldXY(l.lb, l.x, l.y);
    const d = Math.hypot(wx - lwx, wy - lwy);
    if (d <= ARRIVE_M) {
      this._advance();
      return;
    }
    // pursuitStatus arrival latch (2) is a secondary completion signal.
    const ps = h.GetPursuitStatus ? h.GetPursuitStatus() : { last: 0 };
    if (ps.last === 2 && d <= ARRIVE_M * 2) {
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
