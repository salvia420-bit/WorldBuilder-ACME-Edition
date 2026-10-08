// scene3d/diag/remote_sync.js — `__diag.remoteSync`: how well REMOTE entities
// (other players, NPCs) track the server, and whether their cast gestures play.
//
// NETSYNC (2026-10-07, Coldeve capture with ~60 players). The capture showed
// remote runners standing on each ~1 Hz server position and then gliding to
// the next one (64% of moving intervals), and nothing on the client measured
// it: `__diag.cast` only follows the LOCAL cast chain, and `__diag.motion`
// records cycle changes, not the link one-shots that animate a cast.
//
// MOVEMENT. `EntityManager.setPose` (reached only from the KIND_POSITION
// drain) calls `onWirePose` for a remote entity BEFORE it applies the new
// server pose. Per update:
//   jump  = |newWire - prevWire|  horizontal metres the entity really moved
//   corr  = |drawn - newWire|     the correction the renderer now owes: the
//                                 dead-reckoning (prediction) error
//   held  = jump > MOVING_M and the rig is still within HELD_M of prevWire:
//           it stood on the last server pose instead of moving on
//   ratio = corr / jump           1.0 = no better than standing still,
//                                 near 0 = good dead reckoning
// Retail moves a remote by its interpreted motion between corrections
// (`CPhysicsObj::MoveOrTeleport` acclient.c:323451-323498 never touches the
// object's CMotionInterp), so a healthy client shows a low held fraction and a
// ratio well under 1.
//
// CASTS. `setMotion` reports each remote cast GESTURE commit (the held 0x40
// substate, e.g. MagicSelfHead) with whether its Ready->gesture LINK (the arm
// raise) played, and each remote action one-shot (windups, swings) with
// whether its link resolved and played.
//
// Cost: O(1) per update / cast; bounded rings. Fail-soft: every hook site is
// wrapped in try/catch + optional chaining.

const MAX_TAIL = 200;
const MAX_PER_GUID = 64;
const MAX_MISSES = 16;
/** Server step that counts as "the entity moved" (m). */
export const MOVING_M = 0.5;
/** Rig within this of the previous server pose = it stood still (m). */
export const HELD_M = 0.05;
/** Larger steps are teleports / portals, not locomotion (m). */
export const TELEPORT_M = 50;
/**
 * Updates whose new server pose is farther than this from the local player
 * are not scored (counted in `farUpdates`): the rig is past the 120 m tick
 * gate (`MAX_TICK_DIST`) or in a cell we do not have (a remote who portalled
 * into a dungeon keeps sending positions for ACE's 25 s known-object window).
 */
export const FAR_M = 120;

/**
 * Classify one remote server-position update. Pure; horizontal (AC x/y) only.
 * @param {{x:number,y:number}} drawn  rig position when the update arrived
 * @param {{x:number,y:number}|null} prev  previous server pose (null = first)
 * @param {{x:number,y:number}} next  the new server pose
 * @returns {null | {jump:number, corr:number, moved:number, moving:boolean, held:boolean, ratio:number}}
 *   null for a first update or a teleport-class step.
 */
export function classifyRemoteUpdate(drawn, prev, next) {
  if (!drawn || !prev || !next) return null;
  const jump = Math.hypot(next.x - prev.x, next.y - prev.y);
  if (!Number.isFinite(jump) || jump > TELEPORT_M) return null;
  const corr = Math.hypot(drawn.x - next.x, drawn.y - next.y);
  const moved = Math.hypot(drawn.x - prev.x, drawn.y - prev.y);
  const moving = jump > MOVING_M;
  return {
    jump,
    corr,
    moved,
    moving,
    held: moving && moved < HELD_M,
    ratio: moving ? corr / jump : 0,
  };
}

/**
 * NETSYNC round 2 (2026-10-07): why a remote stood on its last server pose.
 * `bs` is the wasm `SessionHandle.remoteBodyState(guid)` layout (src/lib.rs):
 * [0] forward_low16 [1] forward_speed [2] turn_low16 [3] turn_speed
 * [4] sidestep_low16 [5] interp_active [6] wire_contact (1/0/-1) [7] indoors
 * [8] moveto (0/1 turn/2 walk-run) [9] sticky [10] airborne [11] |state v|
 * [12] state omega z [13] table turn omega z [14] has_motion_state.
 * It is read when the NEXT server pose arrives (after the wasm reconcile), so
 * the interp flag is not used (a fresh correction always arms it); the motion
 * state is the one that was live during the interval unless the same packet
 * batch changed it. Ordered from structural to incidental. Pure.
 * @returns {string}
 */
export function classifyHeldReason(bs, wasmDriven) {
  if (!bs || bs.length < 15) return wasmDriven ? "noBodyState" : "noBodyNoRows";
  if (bs[7] === 1) return "indoor"; // D1 walk is outdoor-only (no wall sweep)
  if (bs[10] === 1) return "airborne";
  if (bs[6] === 0) return "noContact"; // wire IS_GROUNDED absent
  if (bs[9] === 1) return "sticky";
  if (bs[8] === 2) return "moveToWalk"; // D5 steer owns the walk
  if (bs[8] === 1) return "moveToTurn";
  if (bs[14] === 0) return "noMotionState";
  if (!(bs[11] > 0.01)) {
    // Ready / no forward or sidestep axis: nothing to dead-reckon with —
    // retail would also only interpolate (a bot that moves without motion).
    if (bs[0] === 0 || bs[0] === 3) return bs[4] ? "zeroSpeedSidestep" : "noForwardAxis";
    return "zeroForwardSpeed";
  }
  return wasmDriven ? "walkStalled" : "rowsNotFlowing";
}

function pct(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}

function round2(v) {
  return v == null ? null : Math.round(v * 100) / 100;
}

export function createRemoteSync(nowFn = () => (typeof performance !== "undefined" ? performance.now() : Date.now())) {
  const byGuid = new Map();
  const tail = [];
  let farUpdates = 0;
  const heldReasons = Object.create(null);
  const actionMissReasons = Object.create(null);
  const actionMisses = []; // last MAX_MISSES missed remote actions
  const cast = {
    gestures: 0,
    gestureLinkPlayed: 0,
    gestureNoLink: 0,
    gestureNoCycle: 0,
    actions: 0,
    actionsPlayed: 0,
    actionsMissed: 0,
  };

  function entryFor(guid, name) {
    let e = byGuid.get(guid);
    if (!e) {
      e = { guid, name: name || "", updates: 0, moving: 0, held: 0, heldReasons: {}, recent: [], cast: { gestures: 0, linkPlayed: 0, actions: 0, actionsPlayed: 0 } };
      byGuid.set(guid, e);
    } else if (!e.name && name) {
      e.name = name;
    }
    return e;
  }

  function push(rec) {
    tail.push(rec);
    if (tail.length > MAX_TAIL) tail.shift();
  }

  const api = {
    MOVING_M,
    HELD_M,
    TELEPORT_M,
    FAR_M,
    byGuid,
    tail,

    /**
     * setPose hook: called BEFORE the new remote server pose is applied.
     * `ctx` (optional): { wasmDriven, animCmd, bodyState: () => remoteBodyState }.
     */
    onWirePose(guid, name, drawn, prev, next, ctx) {
      const c = classifyRemoteUpdate(drawn, prev, next);
      if (!c) return null;
      if (c.moving && ctx?.playerPose) {
        let pp = null;
        try { pp = ctx.playerPose(); } catch (_) { pp = null; }
        if (pp && Math.hypot(next.x - pp.x, next.y - pp.y) > FAR_M) {
          farUpdates += 1;
          return null;
        }
      }
      const g = guid >>> 0;
      const e = entryFor(g, name);
      e.updates += 1;
      if (c.moving) e.moving += 1;
      const rec = { t: nowFn(), g, jump: round2(c.jump), corr: round2(c.corr), held: c.held, moving: c.moving };
      if (c.held) {
        e.held += 1;
        let bs = null;
        try { bs = ctx?.bodyState?.() ?? null; } catch (_) { bs = null; }
        const reason = classifyHeldReason(bs, !!ctx?.wasmDriven);
        heldReasons[reason] = (heldReasons[reason] | 0) + 1;
        e.heldReasons[reason] = (e.heldReasons[reason] | 0) + 1;
        rec.reason = reason;
        rec.animCmd = "0x" + ((ctx?.animCmd ?? 0) >>> 0).toString(16);
        if (bs && bs.length >= 15) {
          rec.fwd = "0x" + (bs[0] >>> 0).toString(16);
          rec.fwdSpeed = round2(bs[1]);
          rec.v = round2(bs[11]);
        }
      }
      e.recent.push(rec);
      if (e.recent.length > MAX_PER_GUID) e.recent.shift();
      if (c.moving) push(rec);
      return c;
    },

    /** setMotion hook: a remote cast-gesture substate committed. */
    onCastGesture(guid, cmd, linkPlayed, cyclePlayed, name) {
      const e = entryFor(guid >>> 0, name);
      cast.gestures += 1;
      e.cast.gestures += 1;
      if (linkPlayed) {
        cast.gestureLinkPlayed += 1;
        e.cast.linkPlayed += 1;
      } else {
        cast.gestureNoLink += 1;
      }
      if (!cyclePlayed) cast.gestureNoCycle += 1;
      push({ t: nowFn(), g: guid >>> 0, gesture: "0x" + (cmd >>> 0).toString(16), link: !!linkPlayed, cycle: !!cyclePlayed });
    },

    /**
     * setMotion hook: a remote action one-shot (windup / swing / emote)
     * resolved. `miss` (when !played): { reason, cls, stance, fromCmd } —
     * reason from `_tryPlayLink`: noLink | lateSkip | superseded | removed |
     * playFailed | noWasm.
     */
    onCastAction(guid, cmd, played, name, miss) {
      const e = entryFor(guid >>> 0, name);
      cast.actions += 1;
      e.cast.actions += 1;
      const rec = { t: nowFn(), g: guid >>> 0, action: "0x" + (cmd >>> 0).toString(16), played: !!played };
      if (played) {
        cast.actionsPlayed += 1;
        e.cast.actionsPlayed += 1;
      } else {
        cast.actionsMissed += 1;
        const reason = miss?.reason || "unknown";
        actionMissReasons[reason] = (actionMissReasons[reason] | 0) + 1;
        rec.reason = reason;
        rec.cls = miss?.cls ?? null;
        rec.stance = "0x" + ((miss?.stance ?? 0) >>> 0).toString(16);
        rec.name = name || "";
        actionMisses.push(rec);
        if (actionMisses.length > MAX_MISSES) actionMisses.shift();
      }
      push(rec);
    },

    /**
     * One-line health read: paste `__diag.remoteSync.summary()`.
     * `ratioP50` (kept for continuity) mixes held updates, whose ratio is
     * EXACTLY 1.0 by construction (drawn == prev wire → corr == jump); with
     * ~40% held and the rest split around 1 the median lands in that cluster,
     * so it reads 1.0 whatever the dead reckoning does. Use
     * `ratioMovedP50` (non-held updates only: how good the prediction is when
     * the rig did move) and `beatHoldFrac` (share of moving updates whose
     * correction was smaller than standing still would have needed).
     */
    summary() {
      const corr = [];
      const jump = [];
      const ratio = [];
      const ratioMoved = [];
      let beatHold = 0;
      let updates = 0;
      let moving = 0;
      let held = 0;
      const worst = [];
      for (const e of byGuid.values()) {
        updates += e.updates;
        moving += e.moving;
        held += e.held;
        for (const r of e.recent) {
          if (!r.moving) continue;
          corr.push(r.corr);
          jump.push(r.jump);
          const q = r.jump > 0 ? r.corr / r.jump : 0;
          ratio.push(q);
          if (!r.held) ratioMoved.push(q);
          if (r.corr < r.jump) beatHold += 1;
        }
        if (e.moving >= 3) {
          worst.push({ guid: "0x" + e.guid.toString(16), name: e.name, moving: e.moving, heldFrac: round2(e.held / e.moving), heldReasons: { ...e.heldReasons } });
        }
      }
      worst.sort((a, b) => b.heldFrac - a.heldFrac || b.moving - a.moving);
      return {
        remotes: byGuid.size,
        updates,
        movingUpdates: moving,
        heldFrac: moving ? round2(held / moving) : null,
        corrP50: round2(pct(corr, 0.5)),
        corrP90: round2(pct(corr, 0.9)),
        jumpP50: round2(pct(jump, 0.5)),
        ratioP50: round2(pct(ratio, 0.5)),
        ratioMovedP50: round2(pct(ratioMoved, 0.5)),
        beatHoldFrac: corr.length ? round2(beatHold / corr.length) : null,
        heldReasons: { ...heldReasons },
        farUpdates,
        worst: worst.slice(0, 8),
        cast: { ...cast, missReasons: { ...actionMissReasons }, lastMisses: actionMisses.slice(-MAX_MISSES) },
      };
    },

    reset() {
      byGuid.clear();
      tail.length = 0;
      actionMisses.length = 0;
      farUpdates = 0;
      for (const k of Object.keys(cast)) cast[k] = 0;
      for (const k of Object.keys(heldReasons)) delete heldReasons[k];
      for (const k of Object.keys(actionMissReasons)) delete actionMissReasons[k];
    },
  };
  return api;
}

/** diag.js attach contract. */
export function attachRemoteSync(diag) {
  if (!diag) return null;
  if (!diag.remoteSync) diag.remoteSync = createRemoteSync();
  return diag.remoteSync;
}
