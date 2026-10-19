// rynth/vt/nav/follow_trail.js — the Follow route's leader trail
// (FollowAroundCorners, W1-6 NAV).
//
// VTank: "When following a character, if True the follower runs the exact
// route as leader, if False the follower runs directly at the leader." The
// trail is the leader's path as ActiveNav saw it: their position sampled on
// the heartbeat (at most every `sampleMs`) and kept as the CORNERS of the
// path. A new position in line with the two before it (within `turnDeg`)
// replaces the last point, so a straight run is one leg — until that leg is
// `spacingM` long, then the run gets another point. Under `minStepM` of
// movement adds nothing; past `maxPoints` the oldest points go. With one
// point, the line it continues is the one from the follower to it: a leader
// running straight away from us keeps a one-point trail (no corner ahead).
//
// ActiveNav walks it (active_nav.js _followTrail): while a corner lies
// between the follower and the leader (`next()`, i.e. two points or more —
// the last one is where the leader is now), one router leg to that corner;
// otherwise straight at the leader, as with the option off. `prune()` drops
// the points the follower reached (`reachM`) or passed (within `passM` and
// nearer the next point than that point is); when a walk (re)starts — after
// a hold near them, a fight — it first JOINS their path at the point nearest
// the follower, so their wander before it is never walked. (Not on every
// tick of a walk: a later point beyond a thin wall can be nearer than the
// corner around it.) While the follower is not walking (holding, or a fight
// holds the tick) and the leader is within 8 m, only their last `holdKeep`
// points are kept (`keepLast`): an exit around a corner close by is still
// known, their dance there is not. A teleport — the leader or the follower
// moved `teleportM` or more faster than `teleportMps` — starts the trail over
// at the leader (their path is not walkable through it); out of sight and a
// far-stop hold clear it (ActiveNav).
//
// Behaviour after WebAC RoutineEngine.ts watchLeader / walkNav and its
// addTrailPoint (250 ms samples, the 15° corner rule, corners reached or
// passed); no code is shared. Pure: no host, no clock — `now` is passed in.

import { worldXY } from "../../nav_frame.js";

export const TRAIL_TUNING = Object.freeze({
  sampleMs: 250,
  minStepM: 1,
  turnDeg: 15,
  spacingM: 5,
  reachM: 1.5, // = NAV_TUNING.minArriveM
  passM: 3,
  legArriveM: 1, // the router's own arrival is tighter than reachM: a corner is left before the body stops on it
  holdKeep: 4,
  maxPoints: 128,
  teleportM: 30, // router.js SEAM_JUMP_M
  teleportMps: 20, // faster than anyone runs
});
const T = TRAIL_TUNING;

const dist = (a, b) => Math.hypot(a.wx - b.wx, a.wy - b.wy);

/** A trail point from a pose / object position ({objCellId, x, y, z}):
 *  {cell, x, y, z, wx, wy} (the cell for the router leg, the world frame for
 *  distances), or null. */
export function trailPoint(pos) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
  const cell = pos.objCellId >>> 0;
  const [wx, wy] = worldXY(cell, pos.x, pos.y);
  return { cell, x: pos.x, y: pos.y, z: Number.isFinite(pos.z) ? pos.z : 0, wx, wy };
}

/** Angle in degrees (0..180) between the headings a→b and b→c. */
function turnDeg(a, b, c) {
  const h1 = Math.atan2(b.wy - a.wy, b.wx - a.wx);
  const h2 = Math.atan2(c.wy - b.wy, c.wx - b.wx);
  let d = Math.abs(h1 - h2);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return (d * 180) / Math.PI;
}

export class FollowTrail {
  /** One trail per leader (`guid`). */
  constructor(guid = 0) {
    this.guid = guid >>> 0;
    this.points = [];
    this.sampledAt = -Infinity;
    this.lastLeader = null;
    this.lastMe = null;
  }

  get size() {
    return this.points.length;
  }

  /**
   * Record the leader's position (trail points; `me` is the follower). At
   * most one sample per `sampleMs`. → "reset" after a teleport, "sampled"
   * when the sample was taken, null when skipped (too soon, no position).
   */
  sample(now, leader, me) {
    if (!leader || !me) return null;
    const dt = now - this.sampledAt;
    if (dt < T.sampleMs && now >= this.sampledAt) return null;
    const jumped = (a, b) => {
      if (!a) return false;
      const d = dist(a, b);
      return d >= T.teleportM && d > (T.teleportMps * Math.max(dt, T.sampleMs)) / 1000;
    };
    const teleport = jumped(this.lastLeader, leader) || jumped(this.lastMe, me);
    this.sampledAt = now;
    this.lastLeader = leader;
    this.lastMe = me;
    if (teleport) {
      this.points = [leader];
      return "reset";
    }
    this._add(leader, me);
    return "sampled";
  }

  _add(at, me) {
    const pts = this.points;
    const last = pts[pts.length - 1];
    if (last && dist(at, last) < T.minStepM) return;
    if (last) {
      const two = pts.length >= 2;
      const prev = two ? pts[pts.length - 2] : dist(last, me) >= T.minStepM ? me : null;
      if (prev && turnDeg(prev, last, at) < T.turnDeg && (!two || dist(prev, last) < T.spacingM)) {
        pts[pts.length - 1] = at;
        return;
      }
    }
    pts.push(at);
    if (pts.length > T.maxPoints) pts.splice(0, pts.length - T.maxPoints);
  }

  /** Drop the points the follower (`me`, world frame) reached or passed;
   *  `join` (a walk that (re)starts): everything before the point nearest
   *  the follower first (a tie: the later point). → how many. */
  prune(me, join = false) {
    if (!me) return 0;
    const pts = this.points;
    let n = 0;
    if (join) {
      let best = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = dist(me, pts[i]);
        if (d <= best) {
          best = d;
          n = i;
        }
      }
    }
    while (n < pts.length) {
      const p = pts[n];
      const dp = dist(me, p);
      if (dp <= T.reachM) {
        n++;
        continue;
      }
      const q = pts[n + 1];
      if (q && dp <= T.passM && dist(me, q) < dist(p, q)) {
        n++;
        continue;
      }
      break;
    }
    if (n) pts.splice(0, n);
    return n;
  }

  /** The corner to walk to next, or null: no corner between the follower
   *  and the leader (one point left — where the leader is now). */
  next() {
    return this.points.length >= 2 ? this.points[0] : null;
  }

  /** Drop `point` and everything before it (reached, or could not be reached). */
  drop(point) {
    const i = this.points.indexOf(point);
    if (i >= 0) this.points.splice(0, i + 1);
  }

  /** Keep only the last `k` points. */
  keepLast(k) {
    if (this.points.length > k) this.points.splice(0, this.points.length - k);
  }

  /** Start over: just the leader's position (or nothing). */
  reset(leader = null) {
    this.points = leader ? [leader] : [];
    if (!leader) {
      this.lastLeader = null;
      this.lastMe = null;
      this.sampledAt = -Infinity;
    }
  }
}

export default { FollowTrail, TRAIL_TUNING, trailPoint };
