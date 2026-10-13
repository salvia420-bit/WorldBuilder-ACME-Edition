// rynth/vt/nav/executors.js — one tick-driven state machine per VTank
// waypoint type (W1-6 NAV, PLAN §3.8 "Executor rules", U7b §5.5).
//
// ActiveNav (active_nav.js) builds one executor for the ACTIVE waypoint and
// calls `step(nowMs)` from its kernel slot tick (the host Worker heartbeat —
// no timers here, C4). `step` returns "running" | "done" | "failed"; a failure
// leaves `failReason` set. Everything an executor must remember across a
// yield or a bot rebind lives in `ctx.mem`, a plain object ActiveNav keeps in
// the page session (session.navState.exec.mem), so a second ActiveNav on the
// same state continues the same waypoint (deadlines, pause remaining time).
//
// The one async exception (C4/V-8) is the jump: the Jump executor and the
// Point executor's stuck rung wrap goto_compose.attemptJumpLeg as a JOB and
// poll its settled flag from step().
//
// Casts go ONLY through host.CastUntargetedSafe (C6; recall spells are
// SelfTargeted). UseObject claims the host item token (C8). Output goes
// through ctx.print (C7). Every executor holds in portal space (V-12).

import { navPointToLeg, degToWorld } from "../../nav_file.js";
import { worldXY, isEnvCellId } from "../../nav_frame.js";
import { portalSpaceActive } from "../../portal_gate.js";
import { casterWielded } from "../../buff_loop.js";
import { POINT, POINT_NAMES, isSentinel, pointWorld } from "./route_model.js";

export const NAV_TUNING = Object.freeze({
  minArriveM: 1.5, // CS/NavigationEngine.cs:99 ArrivalYards = max(1.5, FollowNavMin)
  walkSpeedMps: 4, // run rate 1 (U3 H10)
  legTimeoutFactor: 2.5,
  legTimeoutPadMs: 10_000,
  legTimeoutMinMs: 15_000,
  legTimeoutMaxMs: 120_000,
  indoorDzM: 3, // |Δz| arrival gate for same-landblock EnvCell legs (U7b §9)
  zRetryMs: 3_000, // a 2D arrival on the wrong floor re-issues at the router's re-issue cadence
  stuckReissues: 2,
  stuckJumpMs: 500,
  teleportJumpM: 30, // router.js SEAM_JUMP_M
  portalSearchM: 10,
  entitySearchM: 30,
  approachM: 3,
  approachArriveM: 2.5,
  findBudgetMs: 60_000, // to find/approach the object, counted once at the waypoint (not while walking to it)
  approachJumpGapMs: 1_500, // tick-to-tick teleport test on a portal approach (= active_nav EXTERNAL_TELEPORT_TICK_GAP_MS)
  portalWaitMs: 20_000,
  portalRetryMs: 4_000,
  recallTimeoutMs: 60_000, // CS ActionTimeoutMs
  recallRetryMs: 4_000, // CS RecallCastRetryMs
  modeRetryMs: 3_000,
  npcSettleMs: 3_000,
  vendorRetryMs: 3_000,
  vendorTimeoutMs: 20_000,
  talkRetryMs: 4_000,
  talkTimeoutMs: 45_000,
  chatGapMs: 250,
  checkpointStableMs: 750,
  checkpointEpsM: 0.1,
  checkpointTimeoutMs: 10_000,
  jumpRebindGraceMs: 12_000,
  movingEpsM: 0.3,
});

// The `mem` fields that anchor an executor's time budgets (find/approach,
// recall 60 s, post-use waits, checkpoint 10 s). ActiveNav shifts them by the
// time the waypoint spent outside the slot (combat, buffing, an operator hold,
// a rebind), so a waypoint never fails for time it was not running — C# resets
// its portal/recall action state whenever nav stops (NavigationEngine.cs
// ResetPortalState). Pause keeps its own remaining time (lastAt).
export const BUDGET_ANCHORS = Object.freeze(["startedAt", "firstUseAt"]);

export const CAST_OWNER = "vtnav";
export const ITEM_OWNER = "vtnav";
const COMBAT_MODE_MAGIC = 8;
const ODF_PORTAL = 0x40000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const msg = (e) => (e && e.message ? e.message : String(e));

/** World-frame {wx, wy, z} of a pose / object position ({objCellId,x,y,z}). */
export function posWorld(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  const [wx, wy] = worldXY(p.objCellId >>> 0, p.x, p.y);
  return { wx, wy, z: Number.isFinite(p.z) ? p.z : 0 };
}

const dist2 = (a, b) => Math.hypot(a.wx - b.wx, a.wy - b.wy);

/** Compass bearing (0 = N, clockwise, degrees) from a to b (world frame). */
export function bearingDeg(a, b) {
  const d = (Math.atan2(b.wx - a.wx, b.wy - a.wy) * 180) / Math.PI;
  return ((d % 360) + 360) % 360;
}

/** Distance-scaled per-leg watchdog (PLAN §3.8 Point rule; U3 H10). */
export function legTimeoutMs(distM) {
  const t = NAV_TUNING;
  if (!Number.isFinite(distM)) return t.legTimeoutMaxMs;
  return Math.round(clamp(t.legTimeoutFactor * (distM / t.walkSpeedMps) * 1000 + t.legTimeoutPadMs, t.legTimeoutMinMs, t.legTimeoutMaxMs));
}

/**
 * Router leg for a Point waypoint. Outdoor-format (nav_file.navPointToLeg)
 * unless the live pose is in an EnvCell of the SAME landblock: then the leg is
 * issued in the pose's cell with the point's local x/y/z and arrival also
 * needs |Δz| < 3 m (stacked dungeon floors).
 * → { leg: {lb,x,y,z}, zGate: boolean, world: {wx,wy,z} }
 */
export function pointLeg(point, pose) {
  const base = navPointToLeg(Number(point.ew) || 0, Number(point.ns) || 0, Number(point.z) || 0);
  let leg = { lb: base.lb >>> 0, x: base.x, y: base.y, z: base.z };
  let zGate = false;
  if (pose && isEnvCellId(pose.objCellId) && base.lb >>> 16 === pose.objCellId >>> 16) {
    leg = { lb: pose.objCellId >>> 0, x: base.x, y: base.y, z: base.z };
    zGate = true;
  }
  const [wx, wy] = worldXY(leg.lb, leg.x, leg.y);
  return { leg, zGate, world: { wx, wy, z: leg.z } };
}

/** Start an async job (the jump primitive) whose outcome step() polls.
 *  `job.promise` resolves (never rejects) once `settled` is set. */
export function runJob(fn) {
  const job = { settled: false, result: null, promise: null };
  let p;
  try {
    p = Promise.resolve(fn());
  } catch (e) {
    job.settled = true;
    job.result = { ok: false, error: msg(e) };
    job.promise = Promise.resolve(job.result);
    return job;
  }
  job.promise = p.then(
    (r) => {
      job.settled = true;
      job.result = r && typeof r === "object" ? r : { ok: false, error: "jump returned no result" };
    },
    (e) => {
      job.settled = true;
      job.result = { ok: false, error: msg(e) };
    },
  );
  return job;
}

/** The leg + tune attemptJumpLeg needs (PLAN §3.8 Jump rule, critic C5). */
export function jumpArgs(gotoCompose, { headingDeg, holdShift, delayMs, direction }) {
  const base = gotoCompose && typeof gotoCompose.buildTune === "function" ? gotoCompose.buildTune({}) : {};
  return {
    leg: { meta: { navType: "jmp", headingDeg: Number(headingDeg) || 0, holdShift: !!holdShift, delayMs: Math.max(0, Number(delayMs) || 0) } },
    tune: { ...base, direction: direction || "forward" },
  };
}

// ── shared helpers over ctx ───────────────────────────────────────────────
function inPortal(ctx) {
  return ctx.inPortalSpace ? ctx.inPortalSpace() : portalSpaceActive(ctx.host);
}

function armTeleport(ctx) {
  const pose = ctx.pose();
  const w = posWorld(pose);
  return {
    at: ctx.now(),
    wx: w ? w.wx : null,
    wy: w ? w.wy : null,
    lb: pose ? pose.objCellId >>> 16 : null,
    env: pose ? isEnvCellId(pose.objCellId) : false,
  };
}

// A teleport since `t` was armed: portal space up, a portalIn/teleportArrived
// signal after it, a >= 30 m world jump, or a landblock change that is not an
// outdoor seam crossing on foot.
function teleported(ctx, t) {
  if (!t) return false;
  if (inPortal(ctx)) return true;
  const s = ctx.signalsLatest || {};
  if ((s.portalIn && s.portalIn.at >= t.at) || (s.teleportArrived && s.teleportArrived.at >= t.at)) return true;
  const pose = ctx.pose();
  const w = posWorld(pose);
  if (!w || t.wx == null) return false;
  const jump = Math.hypot(w.wx - t.wx, w.wy - t.wy);
  if (jump >= NAV_TUNING.teleportJumpM) return true;
  if ((pose.objCellId >>> 16) !== t.lb && (t.env || isEnvCellId(pose.objCellId))) return true;
  return false;
}

// A transit whose far-side pose has not landed yet: a portalIn (kind 33,
// PlayerTeleport) newer than the last portalOut (host_signals synthesizes it
// from the presentation's falling edge, or from kind 66 TeleportArrived when no
// presentation runs: nullRender / ?portalSpace=off pages, where inPortal() never
// reads true). Bounded by portalWaitMs so a lost portalOut cannot park nav.
function transitPending(ctx, now) {
  const s = ctx.signalsLatest || {};
  const pin = s.portalIn;
  if (!pin || !Number.isFinite(pin.at)) return false;
  const out = s.portalOut && Number.isFinite(s.portalOut.at) ? s.portalOut.at : -Infinity;
  return out < pin.at && now - pin.at < NAV_TUNING.portalWaitMs;
}

// Post-teleport settle (PostPortalDelaySec, CS PostTeleportSettle): counted
// from the END of portal space (or of the transit, without a presentation), so
// a long tunnel still gets its settle and the next waypoint never starts from
// the pre-teleport pose.
function settling(ctx, mem, now) {
  if (inPortal(ctx) || transitPending(ctx, now)) {
    mem.teleAt = now;
    return true;
  }
  return now - mem.teleAt < ctx.postPortalDelayMs();
}

// Before the first use of a Portal/NPC waypoint's PORTAL the body can still go
// through it by walking into it (ACE Portal.OnCollideObject → OnActivate; the
// approach walks to within 2.5 m of the portal's centre). Armed (mem.armedAt)
// once the portal object is resolved and the approach toward it begins. Only
// portal space, a teleport signal since arming, or a tick-to-tick jump count
// here: the armed pose is no reference, the approach itself walks away from it.
function teleportedOnApproach(ctx, mem, now) {
  if (mem.armedAt == null) return false;
  if (inPortal(ctx)) return true;
  const s = ctx.signalsLatest || {};
  if ((s.portalIn && s.portalIn.at >= mem.armedAt) || (s.teleportArrived && s.teleportArrived.at >= mem.armedAt)) return true;
  const w = posWorld(ctx.pose());
  const prev = mem.walkPrev;
  mem.walkPrev = w ? { wx: w.wx, wy: w.wy, at: now } : null;
  return !!(prev && w && now - prev.at <= NAV_TUNING.approachJumpGapMs && Math.hypot(w.wx - prev.wx, w.wy - prev.wy) >= NAV_TUNING.teleportJumpM);
}

function claimItem(ctx) {
  const h = ctx.host;
  if (!h || typeof h.tryClaimItemAction !== "function") return true;
  try {
    return h.tryClaimItemAction(ITEM_OWNER) !== false;
  } catch (_) {
    return true;
  }
}
function releaseItem(ctx) {
  try {
    ctx.host?.releaseItemAction?.(ITEM_OWNER);
  } catch (_) {
    /* token self-expires */
  }
}
function releaseCast(ctx) {
  try {
    ctx.host?.releaseCast?.(CAST_OWNER);
  } catch (_) {
    /* token self-expires */
  }
}

function useObject(ctx, guid) {
  const h = ctx.host;
  if (!h || typeof h.UseObject !== "function") return false;
  try {
    return h.UseObject(guid >>> 0) !== false;
  } catch (_) {
    return false;
  }
}

function objectPos(ctx, guid) {
  if (!guid) return null;
  try {
    return ctx.host?.TryGetObjectPosition?.(guid >>> 0) || null;
  } catch (_) {
    return null;
  }
}
function findByName(ctx, name, anchor, maxM) {
  const gc = ctx.gotoCompose;
  if (!name || !anchor || !gc || typeof gc.findEntityByName !== "function") return null;
  try {
    const r = gc.findEntityByName(ctx.host, name, anchor.wx, anchor.wy, maxM);
    return r && r.guid ? r : null;
  } catch (_) {
    return null;
  }
}

function nearestPortal(ctx, anchor, maxM) {
  const h = ctx.host;
  if (!h || typeof h.NearbyGuids !== "function" || !anchor) return null;
  let guids = [];
  try {
    guids = h.NearbyGuids() || [];
  } catch (_) {
    return null;
  }
  let best = null;
  for (const g of guids) {
    let f = null;
    try {
      f = h.TryGetObjectDescFlags ? h.TryGetObjectDescFlags(g) : null;
    } catch (_) {
      f = null;
    }
    if (f == null || (f & ODF_PORTAL) === 0) continue;
    const w = posWorld(objectPos(ctx, g));
    if (!w) continue;
    const d = dist2(w, anchor);
    if (d <= maxM && (!best || d < best.d)) best = { guid: g >>> 0, d };
  }
  return best;
}

// Walk to within approachM of `pos` before a use. → "near" | "walking".
// A failed approach leg falls through to the use (ACE walks the player to a
// used object itself).
function approach(ctx, mem, st, pos) {
  const pose = ctx.pose();
  const pw = posWorld(pose);
  const tw = posWorld(pos);
  if (!pw || !tw) return "near";
  const d = dist2(pw, tw);
  if (d <= NAV_TUNING.approachM || mem.approachGaveUp) {
    if (st.leg) ctx.cancelLeg(st.leg);
    return "near";
  }
  const ls = st.leg ? ctx.legState(st.leg) : null;
  if (ls === "WALK" || ls === "PORTAL") return "walking";
  if (ls === "FAILED") {
    mem.approachGaveUp = true;
    return "near";
  }
  if (ls === "DONE") return "near";
  st.leg = { lb: pos.objCellId >>> 0, x: pos.x, y: pos.y, z: pos.z, arriveM: NAV_TUNING.approachArriveM, timeoutMs: legTimeoutMs(d) };
  ctx.issueLeg(st.leg);
  return "walking";
}

// Walk toward the waypoint's own (non-sentinel) position while its object is
// not yet in view. → true while walking.
function walkToPoint(ctx, st, point) {
  if (isSentinel(point)) return false;
  const pose = ctx.pose();
  const pw = posWorld(pose);
  if (!pw) return false;
  const { leg, world } = pointLeg(point, pose);
  if (dist2(pw, world) <= NAV_TUNING.approachM) return false;
  const ls = st.leg ? ctx.legState(st.leg) : null;
  if (ls === "WALK" || ls === "PORTAL") return true;
  if (ls === "FAILED") return false;
  st.leg = { ...leg, arriveM: NAV_TUNING.approachArriveM, timeoutMs: legTimeoutMs(dist2(pw, world)) };
  ctx.issueLeg(st.leg);
  return true;
}

// The object a Portal/NPC/NpcTalk waypoint names: by name near its recorded
// object position (else near the waypoint).
function objectAnchor(point) {
  const ew = Number(point.exitEW) || 0;
  const ns = Number(point.exitNS) || 0;
  if (ew !== 0 || ns !== 0) {
    const { wx, wy } = degToWorld(ew, ns);
    return { wx, wy };
  }
  return pointWorld(point);
}

const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() !== "";

// ── executors ─────────────────────────────────────────────────────────────

function base(point, ctx) {
  return {
    point,
    type: point.type,
    failReason: null,
    warning: null,
    get pinned() {
      return false;
    },
    get expectsTeleport() {
      return false;
    },
    get label() {
      return POINT_NAMES[point.type] || `type ${point.type}`;
    },
    cancel() {},
    _fail(reason) {
      this.failReason = reason;
      return "failed";
    },
    ctx,
  };
}

// Point (0): one router leg at a time; stuck ladder re-issue ×2 → directional
// jump → (ActiveNav) skip / pause.
function pointExecutor(point, ctx) {
  const mem = ctx.mem;
  if (!Number.isInteger(mem.reissues)) mem.reissues = 0;
  const st = { leg: null, job: null };
  const ex = base(point, ctx);
  Object.defineProperty(ex, "pinned", { get: () => !!(st.job && !st.job.settled) });
  // The stuck-rung jump job (cannot be cancelled): ActiveNav keeps an
  // unsettled one when it resets this executor (review runtime-2).
  Object.defineProperty(ex, "job", { get: () => st.job });
  Object.defineProperty(ex, "label", {
    get: () => {
      if (st.job && !st.job.settled) return "Point: unstick jump";
      const pose = ctx.pose();
      const pw = posWorld(pose);
      const tw = pointWorld(point);
      return pw && tw ? `Point: ${dist2(pw, tw).toFixed(1)} m` : "Point";
    },
  });
  const issue = (pose) => {
    const { leg, world } = pointLeg(point, pose);
    const pw = posWorld(pose);
    st.leg = { ...leg, arriveM: ctx.arriveM(), timeoutMs: legTimeoutMs(pw ? dist2(pw, world) : Infinity) };
    ctx.issueLeg(st.leg);
  };
  const stuck = (pose, why) => {
    if (mem.reissues < NAV_TUNING.stuckReissues) {
      mem.reissues += 1;
      ctx.log(`nav: ${why} — re-issuing the leg (${mem.reissues}/${NAV_TUNING.stuckReissues})`);
      issue(pose);
      return "running";
    }
    const gc = ctx.gotoCompose;
    if (!mem.jumped && gc && typeof gc.attemptJumpLeg === "function") {
      mem.jumped = true;
      const pw = posWorld(pose);
      const tw = pointWorld(point);
      const headingDeg = pw && tw ? bearingDeg(pw, tw) : 0;
      ctx.cancelLeg(st.leg);
      const { leg, tune } = jumpArgs(gc, { headingDeg, holdShift: false, delayMs: NAV_TUNING.stuckJumpMs, direction: "forward" });
      ctx.log(`nav: ${why} — trying a directional jump (heading ${headingDeg.toFixed(0)})`);
      st.job = runJob(() => gc.attemptJumpLeg({ host: ctx.host }, leg, tune));
      return "running";
    }
    return ex._fail("stuck");
  };
  ex.step = (now) => {
    if (inPortal(ctx)) return "running";
    const pose = ctx.pose();
    if (st.job) {
      if (!st.job.settled) return "running";
      st.job = null;
      if (pose) issue(pose);
      return "running";
    }
    if (!pose) return "running";
    const { zGate, world } = pointLeg(point, pose);
    const pw = posWorld(pose);
    const zOk = !zGate || Math.abs(pose.z - world.z) < NAV_TUNING.indoorDzM;
    if (dist2(pw, world) <= ctx.arriveM() && zOk) {
      if (st.leg) ctx.cancelLeg(st.leg);
      return "done";
    }
    const ls = st.leg ? ctx.legState(st.leg) : null;
    if (ls === "WALK" || ls === "PORTAL") return "running";
    if (ls === "DONE") {
      if (zOk) return "done";
      // 2D-arrived on another floor: the router stopped the body; re-issue at
      // the router's own re-issue cadence (each one is a stuck-ladder rung).
      if (mem.zWaitAt == null) mem.zWaitAt = now;
      if (now - mem.zWaitAt < NAV_TUNING.zRetryMs) return "running";
      mem.zWaitAt = null;
      return stuck(pose, "arrived on the wrong floor");
    }
    if (ls === "FAILED") return stuck(pose, "leg failed");
    // not issued yet, cancelled by a yield, or taken by another mover: (re-)issue
    issue(pose);
    return "running";
  };
  ex.cancel = () => {
    if (st.leg) ctx.cancelLeg(st.leg);
  };
  return ex;
}

// Portal (legacy, 1): use the recorded guid, else the nearest portal within
// 10 m of the waypoint; wait for the teleport; settle PostPortalDelaySec.
function portalLegacyExecutor(point, ctx) {
  const mem = ctx.mem;
  const st = { leg: null };
  const ex = base(point, ctx);
  const waiting = () => (mem.uses || 0) > 0 || mem.phase === "settle";
  Object.defineProperty(ex, "pinned", { get: waiting });
  Object.defineProperty(ex, "expectsTeleport", { get: waiting });
  Object.defineProperty(ex, "label", {
    get: () => (mem.phase === "settle" ? "Portal: settling" : waiting() ? "Portal: waiting for the teleport" : "Portal: looking for the portal"),
  });
  ex.step = (now) => {
    if (mem.startedAt == null) mem.startedAt = now;
    if (mem.phase === "settle") {
      if (settling(ctx, mem, now)) return "running";
      releaseItem(ctx);
      return "done";
    }
    if ((mem.uses || 0) > 0 && teleported(ctx, mem.tele)) {
      mem.phase = "settle";
      mem.teleAt = now;
      return "running";
    }
    if ((mem.uses || 0) > 0 && now - mem.firstUseAt >= NAV_TUNING.portalWaitMs) {
      releaseItem(ctx);
      return ex._fail(`no teleport within ${NAV_TUNING.portalWaitMs / 1000} s`);
    }
    if (!(mem.uses > 0) && now - mem.startedAt >= NAV_TUNING.findBudgetMs) return ex._fail("portal not found");
    if (inPortal(ctx)) return "running";
    let guid = 0;
    if (point.guid && objectPos(ctx, point.guid)) guid = point.guid >>> 0;
    if (!guid) {
      const anchor = pointWorld(point) || posWorld(ctx.pose());
      const p = nearestPortal(ctx, anchor, NAV_TUNING.portalSearchM);
      if (p) guid = p.guid;
    }
    if (!guid) {
      if (walkToPoint(ctx, st, point)) mem.startedAt = now; // the find budget starts at the waypoint
      return "running";
    }
    if (st.leg) ctx.cancelLeg(st.leg);
    if (mem.lastUseAt != null && now - mem.lastUseAt < NAV_TUNING.portalRetryMs) return "running";
    if (!claimItem(ctx)) return "running";
    if (!(mem.uses > 0)) mem.tele = armTeleport(ctx);
    useObject(ctx, guid);
    mem.lastUseAt = now;
    if (mem.firstUseAt == null) mem.firstUseAt = now;
    mem.uses = (mem.uses || 0) + 1;
    return "running";
  };
  ex.cancel = () => {
    if (st.leg) ctx.cancelLeg(st.leg);
    releaseItem(ctx);
  };
  return ex;
}

// Recall (2): fires on activation (no walk). Known-spell check, caster
// wielded, Magic mode (<= 1 change / 3 s), cast token "vtnav",
// CastUntargetedSafe; re-cast every 4 s until the teleport; settle; 60 s ⇒ fail.
function recallExecutor(point, ctx) {
  const mem = ctx.mem;
  const ex = base(point, ctx);
  const spellId = Math.trunc(Number(point.spellId) || 0);
  const awaiting = () => (mem.casts || 0) > 0 || mem.phase === "settle";
  Object.defineProperty(ex, "pinned", { get: awaiting });
  Object.defineProperty(ex, "expectsTeleport", { get: awaiting });
  Object.defineProperty(ex, "label", {
    get: () => {
      const nm = ctx.spellName ? ctx.spellName(spellId) : `spell ${spellId}`;
      if (mem.phase === "settle") return `Recall: settling after ${nm}`;
      return (mem.casts || 0) > 0 ? `Recall: casting ${nm} (${mem.casts} cast${mem.casts === 1 ? "" : "s"})` : `Recall: preparing ${nm}`;
    },
  });
  ex.step = (now) => {
    const h = ctx.host;
    if (mem.startedAt == null) mem.startedAt = now;
    if (mem.phase === "settle") return settling(ctx, mem, now) ? "running" : "done";
    if ((mem.casts || 0) > 0 && teleported(ctx, mem.tele)) {
      mem.phase = "settle";
      mem.teleAt = now;
      releaseCast(ctx);
      return "running";
    }
    if (now - mem.startedAt >= NAV_TUNING.recallTimeoutMs) {
      releaseCast(ctx);
      return ex._fail(`no teleport within ${NAV_TUNING.recallTimeoutMs / 1000} s${mem.lastIssue ? ` (${mem.lastIssue})` : ""}`);
    }
    if (inPortal(ctx)) return "running";
    if (!spellId) return ex._fail("no recall spell id");
    if (!mem.checked) {
      mem.checked = true;
      if (h && typeof h.TryGetKnownSpells === "function") {
        let known = [];
        try {
          known = (h.TryGetKnownSpells() || []).map(Number);
        } catch (_) {
          known = [];
        }
        if (known.length && !known.includes(spellId)) return ex._fail("not in the spellbook");
      }
      if (casterWielded(h) === false) return ex._fail("no caster wielded (needs Magic mode)");
    }
    if (!h || typeof h.CastUntargetedSafe !== "function") return ex._fail("cast API unavailable");
    if (typeof h.GetCurrentCombatMode === "function" && typeof h.ChangeCombatMode === "function") {
      let mode = COMBAT_MODE_MAGIC;
      try {
        mode = h.GetCurrentCombatMode();
      } catch (_) {
        mode = COMBAT_MODE_MAGIC;
      }
      if (mode !== COMBAT_MODE_MAGIC) {
        if (mem.lastModeAt == null || now - mem.lastModeAt >= NAV_TUNING.modeRetryMs) {
          mem.lastModeAt = now;
          try {
            h.ChangeCombatMode(COMBAT_MODE_MAGIC);
          } catch (_) {
            /* the next tick re-reads the mode */
          }
        }
        mem.lastIssue = "entering Magic mode";
        return "running";
      }
    }
    if (mem.lastCastAt != null && now - mem.lastCastAt < NAV_TUNING.recallRetryMs) return "running";
    let busy = 0;
    try {
      busy = typeof h.GetBusyState === "function" ? h.GetBusyState() : 0;
    } catch (_) {
      busy = 0;
    }
    if (busy) {
      mem.lastIssue = "busy";
      return "running";
    }
    if (typeof h.tryClaimCast === "function") {
      let ok = true;
      try {
        ok = h.tryClaimCast(CAST_OWNER) !== false;
      } catch (_) {
        ok = true;
      }
      if (!ok) {
        mem.lastIssue = "waiting for the cast token";
        return "running";
      }
    }
    if (!(mem.casts > 0)) mem.tele = armTeleport(ctx);
    let sent = false;
    try {
      sent = h.CastUntargetedSafe(spellId) !== false;
    } catch (_) {
      sent = false;
    }
    mem.lastCastAt = now;
    if (sent) {
      mem.casts = (mem.casts || 0) + 1;
      mem.refused = 0;
      mem.lastIssue = null;
    } else {
      releaseCast(ctx);
      mem.refused = (mem.refused || 0) + 1;
      mem.lastIssue = "cast refused";
      if (mem.refused >= 2) return ex._fail("cast refused by the host (not SelfTargeted or no spell record)");
    }
    return "running";
  };
  ex.cancel = () => releaseCast(ctx);
  return ex;
}

// Pause (3): in place, never walks; holds bot.claimMovement("vt-nav") for the
// dwell (unwedge-safe, U3 H8); the remaining time survives a yield.
function pauseExecutor(point, ctx) {
  const mem = ctx.mem;
  if (!Number.isFinite(mem.remainingMs)) mem.remainingMs = Math.max(0, Number(point.pauseMs) || 0);
  let release = null;
  const ex = base(point, ctx);
  const doRelease = () => {
    if (release) {
      try {
        release();
      } catch (_) {
        /* idempotent */
      }
      release = null;
    }
  };
  Object.defineProperty(ex, "label", { get: () => `Pause: ${(Math.max(0, mem.remainingMs) / 1000).toFixed(1)} s left` });
  ex.step = (now) => {
    if (ctx.ownsRouterWalk()) ctx.cancelLeg();
    if (!release) release = ctx.claimMovement("vt-nav");
    if (inPortal(ctx)) {
      mem.lastAt = null;
      return "running";
    }
    if (mem.lastAt != null) {
      const dt = now - mem.lastAt;
      if (dt > 0 && dt <= 5_000) mem.remainingMs -= dt;
    }
    mem.lastAt = now;
    if (mem.remainingMs <= 0) {
      doRelease();
      return "done";
    }
    return "running";
  };
  ex.cancel = () => {
    mem.lastAt = null;
    doRelease();
  };
  return ex;
}

// Chat (4): one line through the local command chain (runChat), then advance
// on the next tick; >= 250 ms between consecutive Chat points.
function chatExecutor(point, ctx) {
  const mem = ctx.mem;
  const ex = base(point, ctx);
  Object.defineProperty(ex, "label", { get: () => `Chat: ${String(point.chat ?? "").trim()}` });
  ex.step = (now) => {
    if (mem.sentAt != null) return "done";
    if (inPortal(ctx)) return "running";
    const text = String(point.chat ?? "").trim();
    if (!text) {
      mem.sentAt = now;
      return "done";
    }
    const last = ctx.lastChatAt();
    if (last != null && now - last < NAV_TUNING.chatGapMs) return "running";
    if (ctx.ownsRouterWalk()) ctx.cancelLeg();
    mem.sentAt = now;
    ctx.setLastChatAt(now);
    try {
      if (typeof ctx.runChat === "function") ctx.runChat(text);
      else ex.warning = "no chat runner";
    } catch (e) {
      ex.warning = `chat failed: ${msg(e)}`;
      ctx.log(`nav: chat waypoint "${text}" threw: ${msg(e)}`);
    }
    return "running";
  };
  return ex;
}

// OpenVendor (5): resolve, walk within 3 m, UseObject; done ONLY on a
// vendorOpen signal (kind 12) for that guid newer than the first use — never
// on TryGetVendorState (cached per guid for the object's lifetime, critic B2).
function openVendorExecutor(point, ctx) {
  const mem = ctx.mem;
  const st = { leg: null };
  const ex = base(point, ctx);
  Object.defineProperty(ex, "label", {
    get: () => `OpenVendor: ${point.name || (point.vendorId ? `0x${(point.vendorId >>> 0).toString(16)}` : "vendor")}${mem.firstUseAt != null ? " (waiting for the vendor to open)" : ""}`,
  });
  ex.step = (now) => {
    if (mem.startedAt == null) mem.startedAt = now;
    if (mem.firstUseAt != null) {
      const vo = ctx.signalsLatest ? ctx.signalsLatest.vendorOpen : null;
      if (vo && (vo.guid >>> 0) === (mem.guid >>> 0) && vo.at >= mem.firstUseAt) {
        releaseItem(ctx);
        return "done";
      }
      if (now - mem.firstUseAt >= NAV_TUNING.vendorTimeoutMs) {
        releaseItem(ctx);
        return ex._fail(`vendor did not open within ${NAV_TUNING.vendorTimeoutMs / 1000} s`);
      }
    } else if (now - mem.startedAt >= NAV_TUNING.findBudgetMs) {
      return ex._fail("vendor not found");
    }
    if (inPortal(ctx)) return "running";
    let guid = 0;
    let pos = null;
    if (point.vendorId) {
      pos = objectPos(ctx, point.vendorId);
      if (pos) guid = point.vendorId >>> 0;
    }
    if (!guid) {
      const found = findByName(ctx, point.name, pointWorld(point) || posWorld(ctx.pose()), NAV_TUNING.entitySearchM);
      if (found) {
        guid = found.guid >>> 0;
        pos = objectPos(ctx, guid);
      }
    }
    if (!guid || !pos) {
      if (walkToPoint(ctx, st, point)) mem.startedAt = now; // the find budget starts at the waypoint
      return "running";
    }
    mem.guid = guid;
    if (approach(ctx, mem, st, pos) === "walking") return "running";
    if (mem.lastUseAt != null && now - mem.lastUseAt < NAV_TUNING.vendorRetryMs) return "running";
    if (!claimItem(ctx)) return "running";
    useObject(ctx, guid);
    mem.lastUseAt = now;
    if (mem.firstUseAt == null) mem.firstUseAt = now;
    return "running";
  };
  ex.cancel = () => {
    if (st.leg) ctx.cancelLeg(st.leg);
    releaseItem(ctx);
  };
  return ex;
}

// Portal/NPC (6): find by name near the object's recorded position, walk
// within 3 m, UseObject; wait for the teleport 20 s (retry the use every 4 s
// while not moving). An NPC (objectClass 37) that does not teleport is done
// 3 s after the use settles (busy 0 / useDone).
function portalNpcExecutor(point, ctx) {
  const mem = ctx.mem;
  const st = { leg: null };
  const ex = base(point, ctx);
  const isNpc = Number(point.objectClass) === 37;
  const waiting = () => (mem.uses || 0) > 0 || mem.phase === "settle";
  Object.defineProperty(ex, "pinned", { get: waiting });
  // A portal (not an NPC) can be walked into on the approach (teleportedOnApproach).
  Object.defineProperty(ex, "expectsTeleport", { get: () => waiting() || (!isNpc && mem.armedAt != null) });
  Object.defineProperty(ex, "label", {
    get: () =>
      `PortalNPC: ${point.name || "?"}${mem.phase === "settle" ? " (settling)" : waiting() ? (isNpc ? " (used)" : " (waiting for the teleport)") : ""}`,
  });
  ex.step = (now) => {
    if (mem.startedAt == null) mem.startedAt = now;
    if (mem.phase === "settle") {
      if (settling(ctx, mem, now)) return "running";
      releaseItem(ctx);
      return "done";
    }
    const used = (mem.uses || 0) > 0;
    if (used && teleported(ctx, mem.tele)) {
      mem.phase = "settle";
      mem.teleAt = now;
      return "running";
    }
    if (!used && !isNpc && teleportedOnApproach(ctx, mem, now)) {
      if (st.leg) ctx.cancelLeg(st.leg);
      mem.phase = "settle";
      mem.teleAt = now;
      return "running";
    }
    if (used) {
      if (isNpc) {
        const ud = ctx.signalsLatest ? ctx.signalsLatest.useDone : null;
        let busy = 0;
        try {
          busy = typeof ctx.host?.GetBusyState === "function" ? ctx.host.GetBusyState() : 0;
        } catch (_) {
          busy = 0;
        }
        if (mem.settledAt == null && ((ud && ud.at >= mem.lastUseAt) || (busy === 0 && now - mem.lastUseAt >= 1_000))) mem.settledAt = now;
        if (mem.settledAt != null && now - mem.settledAt >= NAV_TUNING.npcSettleMs) {
          releaseItem(ctx);
          return "done";
        }
      }
      if (now - mem.firstUseAt >= NAV_TUNING.portalWaitMs) {
        releaseItem(ctx);
        if (isNpc) return "done";
        return ex._fail(`no teleport within ${NAV_TUNING.portalWaitMs / 1000} s`);
      }
    } else if (now - mem.startedAt >= NAV_TUNING.findBudgetMs) {
      return ex._fail(`"${point.name || "?"}" not found`);
    }
    if (inPortal(ctx)) return "running";
    // movement since the last step (a server use-approach in progress)
    const pw = posWorld(ctx.pose());
    const moving = pw && mem.lastWx != null ? Math.hypot(pw.wx - mem.lastWx, pw.wy - mem.lastWy) > NAV_TUNING.movingEpsM : false;
    if (pw) {
      mem.lastWx = pw.wx;
      mem.lastWy = pw.wy;
    }
    if (used && (mem.settledAt != null || moving)) return "running";
    let guid = mem.guid && objectPos(ctx, mem.guid) ? mem.guid >>> 0 : 0;
    if (!guid) {
      const found = findByName(ctx, point.name, objectAnchor(point) || pw, NAV_TUNING.entitySearchM);
      if (found) guid = found.guid >>> 0;
    }
    const pos = guid ? objectPos(ctx, guid) : null;
    if (!guid || !pos) {
      if (!used && walkToPoint(ctx, st, point)) mem.startedAt = now; // the find budget starts at the waypoint
      return "running";
    }
    mem.guid = guid;
    if (!used && !isNpc && mem.armedAt == null) mem.armedAt = now; // approaching the portal: walking into it counts
    if (!used && approach(ctx, mem, st, pos) === "walking") return "running";
    if (mem.lastUseAt != null && now - mem.lastUseAt < NAV_TUNING.portalRetryMs) return "running";
    if (!claimItem(ctx)) return "running";
    if (!used) mem.tele = armTeleport(ctx);
    useObject(ctx, guid);
    mem.lastUseAt = now;
    if (mem.firstUseAt == null) mem.firstUseAt = now;
    mem.uses = (mem.uses || 0) + 1;
    return "running";
  };
  ex.cancel = () => {
    if (st.leg) ctx.cancelLeg(st.leg);
    releaseItem(ctx);
  };
  return ex;
}

// NPC Talk (7): resolve like Portal/NPC; UseObject every 4 s until a tell
// from that NPC (case-insensitive name); the text goes to ctx.onNpcTell
// (INT-2: meta session var `navlasttell`); 45 s ⇒ fail.
function npcTalkExecutor(point, ctx) {
  const mem = ctx.mem;
  const st = { leg: null };
  const ex = base(point, ctx);
  Object.defineProperty(ex, "label", {
    get: () => `NpcTalk: ${point.name || "?"}${mem.firstUseAt != null ? " (waiting for a tell)" : ""}`,
  });
  ex.step = (now) => {
    if (mem.startedAt == null) mem.startedAt = now;
    if (mem.firstUseAt != null) {
      const tell = ctx.signalsLatest ? ctx.signalsLatest.tell : null;
      if (tell && tell.at >= mem.firstUseAt && (sameName(tell.name, point.name) || sameName(tell.name, mem.name))) {
        releaseItem(ctx);
        try {
          if (typeof ctx.onNpcTell === "function") ctx.onNpcTell(tell.name, tell.text);
        } catch (e) {
          ctx.log(`nav: onNpcTell threw: ${msg(e)}`);
        }
        return "done";
      }
      if (now - mem.firstUseAt >= NAV_TUNING.talkTimeoutMs) {
        releaseItem(ctx);
        return ex._fail(`no tell from "${point.name || "?"}" within ${NAV_TUNING.talkTimeoutMs / 1000} s`);
      }
    } else if (now - mem.startedAt >= NAV_TUNING.findBudgetMs) {
      return ex._fail(`"${point.name || "?"}" not found`);
    }
    if (inPortal(ctx)) return "running";
    let guid = mem.guid && objectPos(ctx, mem.guid) ? mem.guid >>> 0 : 0;
    if (!guid) {
      const found = findByName(ctx, point.name, objectAnchor(point) || posWorld(ctx.pose()), NAV_TUNING.entitySearchM);
      if (found) {
        guid = found.guid >>> 0;
        mem.name = found.name || point.name;
      }
    }
    const pos = guid ? objectPos(ctx, guid) : null;
    if (!guid || !pos) {
      if (mem.firstUseAt == null && walkToPoint(ctx, st, point)) mem.startedAt = now; // the find budget starts at the waypoint
      return "running";
    }
    mem.guid = guid;
    if (mem.firstUseAt == null && approach(ctx, mem, st, pos) === "walking") return "running";
    if (mem.lastUseAt != null && now - mem.lastUseAt < NAV_TUNING.talkRetryMs) return "running";
    if (!claimItem(ctx)) return "running";
    useObject(ctx, guid);
    mem.lastUseAt = now;
    if (mem.firstUseAt == null) mem.firstUseAt = now;
    return "running";
  };
  ex.cancel = () => {
    if (st.leg) ctx.cancelLeg(st.leg);
    releaseItem(ctx);
  };
  return ex;
}

// Checkpoint (8): X-partial — no "server verified position" seam (U7b S6).
// Stop, then done once the pose has been still (< 0.1 m) for 750 ms with busy
// 0, no portal space and no active pursuit; 10 s ⇒ done with a warning.
function checkpointExecutor(point, ctx) {
  const mem = ctx.mem;
  const ex = base(point, ctx);
  Object.defineProperty(ex, "label", { get: () => "Checkpoint: waiting for the position to settle" });
  ex.step = (now) => {
    const h = ctx.host;
    if (mem.startedAt == null) {
      mem.startedAt = now;
      ctx.cancelLeg();
      try {
        h?.StopCompletely?.();
      } catch (_) {
        /* best-effort stop */
      }
    }
    if (now - mem.startedAt >= NAV_TUNING.checkpointTimeoutMs) {
      ex.warning = `position did not settle within ${NAV_TUNING.checkpointTimeoutMs / 1000} s`;
      return "done";
    }
    const pose = ctx.pose();
    if (!pose || inPortal(ctx)) {
      mem.stableSince = null;
      mem.last = null;
      return "running";
    }
    const last = mem.last;
    mem.last = { x: pose.x, y: pose.y, z: pose.z, cell: pose.objCellId >>> 0 };
    const moved = last ? (last.cell !== (pose.objCellId >>> 0) ? Infinity : Math.hypot(pose.x - last.x, pose.y - last.y, (pose.z || 0) - (last.z || 0))) : Infinity;
    let busy = 0;
    let pursuing = false;
    try {
      busy = typeof h?.GetBusyState === "function" ? h.GetBusyState() : 0;
      const ps = typeof h?.GetPursuitStatus === "function" ? h.GetPursuitStatus() : null;
      pursuing = !!ps && ((Number(ps.now) || 0) & 0xffff) === 1;
    } catch (_) {
      busy = 0;
    }
    if (moved >= NAV_TUNING.checkpointEpsM || busy || pursuing) {
      mem.stableSince = null;
      return "running";
    }
    if (mem.stableSince == null) mem.stableSince = now;
    return now - mem.stableSince >= NAV_TUNING.checkpointStableMs ? "done" : "running";
  };
  return ex;
}

// Jump (9): a job wrapping goto_compose.attemptJumpLeg with the leg meta
// (navType "jmp") and the FULL buildTune() tune + direction (critic C5).
// In place (never walks); pinned while the job runs.
function jumpExecutor(point, ctx) {
  const mem = ctx.mem;
  const st = { job: null };
  const ex = base(point, ctx);
  const running = () => !!(st.job && !st.job.settled) || (mem.startedAt != null && !st.job && !mem.finished);
  Object.defineProperty(ex, "pinned", { get: running });
  Object.defineProperty(ex, "job", { get: () => st.job });
  Object.defineProperty(ex, "expectsTeleport", { get: running });
  Object.defineProperty(ex, "label", {
    get: () => `Jump: heading ${Number(point.headingDeg) || 0}, ${Number(point.delayMs) || 0} ms${point.ext?.direction ? `, ${point.ext.direction}` : ""}`,
  });
  ex.step = (now) => {
    if (st.job) {
      if (!st.job.settled) return "running";
      mem.finished = true;
      const r = st.job.result || {};
      return r.ok ? "done" : ex._fail(r.error || "jump failed");
    }
    if (mem.startedAt != null) {
      // Rebound mid-jump (a new ActiveNav on the same session state): the
      // old job's outcome is not ours to read — let it land, then move on.
      if (now - mem.startedAt < NAV_TUNING.jumpRebindGraceMs) return "running";
      mem.finished = true;
      ex.warning = "jump outcome unknown after a rebind";
      return "done";
    }
    if (inPortal(ctx)) return "running";
    const gc = ctx.gotoCompose;
    if (!gc || typeof gc.attemptJumpLeg !== "function") return ex._fail("jump primitive unavailable");
    ctx.cancelLeg();
    const { leg, tune } = jumpArgs(gc, {
      headingDeg: point.headingDeg,
      holdShift: point.holdShift,
      delayMs: point.delayMs,
      direction: point.ext && point.ext.direction ? point.ext.direction : "forward",
    });
    mem.startedAt = now;
    st.job = runJob(() => gc.attemptJumpLeg({ host: ctx.host }, leg, tune));
    return "running";
  };
  return ex;
}

/**
 * The executor for one waypoint. `ctx` (ExecCtx, built by ActiveNav):
 *   host, router, bot, options, runChat, gotoCompose, onNpcTell, log,
 *   signalsLatest — { vendorOpen, tell, useDone, portalIn, portalOut,
 *                     teleportArrived }, each the last signal plus `at`,
 *   mem — the persistent per-waypoint memory (session state; ActiveNav shifts
 *         its BUDGET_ANCHORS by the time spent outside the slot),
 *   now(), pose(), inPortalSpace(), arriveM(), postPortalDelayMs(),
 *   issueLeg(leg), legState(leg), cancelLeg(leg?), ownsRouterWalk(),
 *   claimMovement(tag), lastChatAt(), setLastChatAt(t), spellName?(id).
 * → { point, type, step(nowMs) → "running"|"done"|"failed", cancel(), label,
 *     pinned, expectsTeleport, failReason, warning, job? (Point/Jump: the
 *     attemptJumpLeg job in flight, { settled, result, promise }) }
 */
export function makeExecutor(point, ctx) {
  if (!ctx.mem || typeof ctx.mem !== "object") ctx.mem = {};
  switch (point && point.type) {
    case POINT.Point:
      return pointExecutor(point, ctx);
    case POINT.PortalLegacy:
      return portalLegacyExecutor(point, ctx);
    case POINT.Recall:
      return recallExecutor(point, ctx);
    case POINT.Pause:
      return pauseExecutor(point, ctx);
    case POINT.Chat:
      return chatExecutor(point, ctx);
    case POINT.OpenVendor:
      return openVendorExecutor(point, ctx);
    case POINT.PortalNPC:
      return portalNpcExecutor(point, ctx);
    case POINT.NpcTalk:
      return npcTalkExecutor(point, ctx);
    case POINT.Checkpoint:
      return checkpointExecutor(point, ctx);
    case POINT.Jump:
      return jumpExecutor(point, ctx);
    default: {
      const ex = base(point || { type: -1 }, ctx);
      ex.step = () => ex._fail(`unknown waypoint type ${point && point.type}`);
      return ex;
    }
  }
}

export default { makeExecutor, NAV_TUNING, BUDGET_ANCHORS, CAST_OWNER, ITEM_OWNER, legTimeoutMs, pointLeg, bearingDeg, posWorld, runJob, jumpArgs };
