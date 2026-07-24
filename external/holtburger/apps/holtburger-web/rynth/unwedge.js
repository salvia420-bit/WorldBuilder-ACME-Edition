// unwedge.js — GENERAL, location-agnostic wedge self-recovery (2026-07-24).
//
// The problem this closes (operator report, Town Network bar / Holtburg
// tavern class): the bot gets physically WEDGED against furniture/static
// geometry — movement is commanded but the body barely translates (<~1m over
// 10-15s), the router stalls or FAILs repeatedly at the same spot, the ACE
// server logs `failed transition` on every micro-step, and the bot loops
// there forever. Per-location fixes do not scale; this is ONE primitive that
// keys purely on pose-not-translating-while-commanded. NO cell ids, NO
// landblocks, NO dungeon/building names anywhere in this module.
//
// Mechanism (kernel-reflex shape, cf. ai/heal_reflex.js survival invariants):
//   1. BREADCRUMBS — continuously sample the player pose off the host
//      heartbeat; whenever it translates > crumbSpacingM since the last kept
//      crumb, ring-buffer the pose (cap crumbCap). Crumbs are known-OPEN,
//      known-walkable spots the bot recently stood on. A teleport (world-
//      frame jump >= teleportJumpM, the router's own seam/portal convention)
//      clears the trail — pre-hop crumbs are on the wrong side of a portal.
//   2. DETECTION — the bot is WEDGED when EITHER:
//        (a) movement is being commanded (router WALK, or a loot APPROACH)
//            continuously for >= wedgeAfterMs AND the pose has not translated
//            more than progressM from its anchor for >= wedgeAfterMs, OR
//        (b) the router reported FAILED twice at effectively the same
//            position (within failNearM, inside failWindowMs) while the pose
//            is still at that position — the goto-retry-FAIL loop.
//      A legitimately idle bot (nothing commanding movement) NEVER trips (a);
//      an in-flight cast gesture (recall/portal waits pin the pose on
//      purpose) suspends (a) via the GetCastBusyState gate.
//   3. RECOVERY LADDER (preempts every other mover — see bot.js wiring):
//        RETREAT — cancel the current route and walk straight back to the
//          most recent breadcrumb far enough from the wedge (direct
//          MoveToPosition + re-issue; the crumb is open ground the bot stood
//          on seconds ago, and a wedged body can usually shift the ~1-2m back
//          the way it came). If that crumb also fails, step OLDER through the
//          trail. Bounded by maxRetreatCrumbs.
//        RECALL — trail exhausted: cast the first KNOWN recall spell
//          (goto_compose.attemptRecallCast — the existing recall primitive)
//          to the lifestone/sanctuary: guaranteed open walkable ground.
//        ADMIN LAST RESORT (opt-out via adminTeleFallback:false) — the
//          character can't recall (`recall-unavailable`, journaled as an
//          honest blocked fact): `@teleloc` to the OLDEST breadcrumb — a spot
//          this same character physically stood on this session. On a
//          non-admin character the command is refused server-side and the
//          recovery ends FAILED (cooldown, then re-detection).
//   4. AVOID SET — the wedge position is recorded into the shared
//      ExploreMemory (markWedge) so frontier()/frontierChain() stop offering
//      tiles at the wedge and the explorer doesn't path straight back in.
//
// Preemption wiring (who yields while this is active()):
//   - kernel.js: the priority ladder yields the tick to "Unwedge" below
//     Vitals (hard survival still wins) and above combat/loot/buff.
//   - bot.js: movementClaimed() reports true, and doGoto/doEgress/travel
//     refuse, while active() — the director and the explore-pressure cruise
//     cannot start a competing walk mid-extraction.
//   - _begin() cancels the router walk, which also unwinds any in-flight
//     goto/followRoute poll loop (they see IDLE -> CANCELLED, their normal
//     last-command-wins path).
//
// Survival invariants (match heal_reflex/confirm_reflex): tick() NEVER
// throws into the host loop; every bot/host read is guarded; a missing
// dependency (no journal, no exploreMemory, no recall API) degrades that one
// rung, never the module. enabled:false makes tick() a no-op.

import { worldX, worldY } from "./nav_frame.js";

// ── defaults (all overridable via opts) ─────────────────────────────────────
const SAMPLE_MS = 500; // detection/breadcrumb cadence (host ticks ~10Hz)
const CRUMB_SPACING_M = 0.75; // keep a crumb every this many metres of real travel
const CRUMB_CAP = 12; // ring-buffer length (~9m of trail at min spacing)
const WEDGE_AFTER_MS = 13_000; // commanded + <progressM translation this long => wedged
const PROGRESS_M = 1.0; // anchor translation below this = "not really moving"
const FAIL_NEAR_M = 2.0; // two router FAILs within this of each other = same spot
const FAIL_WINDOW_MS = 90_000; // ...inside this window
const TELEPORT_JUMP_M = 30; // router.js SEAM_JUMP_M convention — a jump this big = teleport
const RETREAT_ARRIVE_M = 2.0; // within this of the crumb = reached open ground
const RETREAT_LEG_MS = 12_000; // per-crumb retreat watchdog
const REISSUE_MS = 2_500; // re-issue MoveToPosition while retreating
const MIN_RETREAT_M = 3.5; // a crumb closer than this to the wedge buys nothing
// (MUST stay > RETREAT_ARRIVE_M — a "usable" crumb inside arrival distance
// would complete the retreat instantly without the body actually extracting)
const MAX_RETREAT_CRUMBS = 5; // bound the trail walk-back
const FREED_M = 5.0; // translated this far from the wedge = free, wherever we are
const COOLDOWN_MS = 30_000; // after any recovery ends, before re-detection can fire
const AVOID_RADIUS_M = 8; // explore-memory avoid radius around the wedge point

// Default recall candidates, filtered against the character's OWN spellbook
// at recovery time (never cast blind). Ids are cross-verified mechanism
// constants, not content picks: ACE SpellId + LSD spells.json both give
// 1635 = "Lifestone Recall", 2023 = "Recall the Sanctuary" — the two plain
// self-casts that land on the character's lifestone/sanctuary.
const DEFAULT_RECALL_SPELLS = Object.freeze([
  Object.freeze({ id: 1635, name: "Lifestone Recall" }),
  Object.freeze({ id: 2023, name: "Recall the Sanctuary" }),
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class UnwedgeReflex {
  constructor(host, opts = {}) {
    this.host = host;
    this.enabled = opts.enabled ?? true; // core recovery: ON by default (config.unwedge === false disables)
    this.now = typeof opts.now === "function" ? opts.now : () => Date.now();
    this.log = typeof opts.log === "function" ? opts.log : (m) => console.log(`[unwedge] ${m}`);

    this.sampleMs = opts.sampleMs ?? SAMPLE_MS;
    this.crumbSpacingM = opts.crumbSpacingM ?? CRUMB_SPACING_M;
    this.crumbCap = opts.crumbCap ?? CRUMB_CAP;
    this.wedgeAfterMs = opts.wedgeAfterMs ?? WEDGE_AFTER_MS;
    this.progressM = opts.progressM ?? PROGRESS_M;
    this.failNearM = opts.failNearM ?? FAIL_NEAR_M;
    this.failWindowMs = opts.failWindowMs ?? FAIL_WINDOW_MS;
    this.teleportJumpM = opts.teleportJumpM ?? TELEPORT_JUMP_M;
    this.retreatArriveM = opts.retreatArriveM ?? RETREAT_ARRIVE_M;
    this.retreatLegMs = opts.retreatLegMs ?? RETREAT_LEG_MS;
    this.reissueMs = opts.reissueMs ?? REISSUE_MS;
    // Invariant: a usable crumb must sit OUTSIDE arrival distance, or the
    // retreat "arrives" without the body moving (see MIN_RETREAT_M note).
    this.minRetreatM = Math.max(opts.minRetreatM ?? MIN_RETREAT_M, this.retreatArriveM + 0.5);
    this.maxRetreatCrumbs = opts.maxRetreatCrumbs ?? MAX_RETREAT_CRUMBS;
    this.freedM = opts.freedM ?? FREED_M;
    this.cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;
    this.avoidRadiusM = opts.avoidRadiusM ?? AVOID_RADIUS_M;
    this.adminTeleFallback = opts.adminTeleFallback ?? true;
    this.recallSpells = Array.isArray(opts.recallSpells) ? opts.recallSpells : DEFAULT_RECALL_SPELLS;
    // attemptRecallCast tune (goto_compose.js buildTune field names); tests
    // shrink these so the recall path runs in milliseconds.
    this.recallTune = {
      poseTimeoutMs: 10_000,
      posePollMs: 250,
      recallTeleportMs: 20_000,
      teleportPollMs: 500,
      portalJumpM: TELEPORT_JUMP_M,
      adminTeleWaitMs: 8_000,
      ...(opts.recallTune || {}),
    };

    this.bot = null; // set by createGrindBot once the bot object exists

    // state machine: MONITOR (watching) | RETREAT (walking a crumb) | RECALL
    this.state = "MONITOR";
    this._crumbs = []; // oldest -> newest {cell,x,y,z,wx,wy,t}
    this._last = null; // last sampled {wx,wy,cell} (teleport detection)
    this._anchor = null; // progress anchor {wx,wy}
    this._lastProgressAt = this.now();
    this._commandedAt = null; // when "commanded" became continuously true
    this._lastRouterState = null; // FAILED edge detection
    this._fails = []; // recent router-FAILED positions [{wx,wy,t}]
    this._cooldownUntil = 0;
    this._lastSampleAt = 0;
    this._wedge = null; // {wx,wy,z,cell,at}
    this._retreat = null; // {idx, attempts, startedAt, lastIssueAt}
    this._recallBusy = false;

    // counters (status/journal honesty)
    this.wedges = 0;
    this.freedCount = 0;
    this.recalls = 0;
    this.lastResult = null; // {ok, why, at}
  }

  /** True while a recovery is actively extracting the character — every other
   *  mover (kernel loops, director gotos, pressure cruise) must yield. */
  active() {
    return this.state !== "MONITOR";
  }

  /** host.onTick driver. NEVER throws into the host loop. */
  tick() {
    try {
      this._tick();
    } catch (e) {
      this.log(`tick error: ${(e && e.message) || e}`);
    }
  }

  _pose() {
    try {
      return this.host?.TryGetPlayerPose?.() ?? null;
    } catch {
      return null;
    }
  }

  _journal(text) {
    try {
      this.bot?.ai?.journal?.add?.("note", text);
    } catch { /* journal loss is not fatal */ }
  }

  _tick() {
    if (!this.enabled || !this.bot) return;
    const now = this.now();
    const pose = this._pose();
    this._trackRouterFails(now, pose);
    if (!pose || typeof pose.objCellId !== "number") return;
    const cell = pose.objCellId >>> 0;
    // Same unresolved-cell convention as explore_memory.observe(): an
    // unresolved pose is not a real location — never crumb it, never anchor
    // on it, never detect against it.
    const unresolved = pose.cellResolved === false || (pose.cellResolved == null && cell === 0);
    if (unresolved) return;
    const wx = worldX(cell, pose.x);
    const wy = worldY(cell, pose.y);

    // Teleport (portal hop, recall landing, admin tele): the trail is on the
    // wrong side now — reset everything and reseed. A teleport during an
    // active recovery IS the recovery succeeding (recall/admin landed).
    if (this._last && Math.hypot(wx - this._last.wx, wy - this._last.wy) >= this.teleportJumpM) {
      this._crumbs = [];
      this._fails = [];
      this._anchor = { wx, wy };
      this._lastProgressAt = now;
      this._commandedAt = null;
      this._last = { wx, wy, cell };
      this._crumbs.push({ cell, x: pose.x, y: pose.y, z: pose.z, wx, wy, t: now });
      if (this.active()) this._finish(true, "teleported clear of the wedge");
      return;
    }
    this._last = { wx, wy, cell };

    if (this.state === "RETREAT") {
      this._retreatTick(now, wx, wy);
      return;
    }
    if (this.state === "RECALL") return; // async recall drives itself (_doRecall)

    // ── MONITOR ──
    if (now - this._lastSampleAt < this.sampleMs) return;
    this._lastSampleAt = now;

    // Breadcrumbs: only real translation lays a crumb, so a wedged body's
    // tiny oscillation (< spacing) never pollutes the trail.
    const lastCrumb = this._crumbs[this._crumbs.length - 1];
    if (!lastCrumb || Math.hypot(wx - lastCrumb.wx, wy - lastCrumb.wy) > this.crumbSpacingM) {
      this._crumbs.push({ cell, x: pose.x, y: pose.y, z: pose.z, wx, wy, t: now });
      if (this._crumbs.length > this.crumbCap) this._crumbs.shift();
    }

    // Progress anchor: any >progressM translation re-anchors (moving bots
    // re-anchor every sample; a wedged oscillation never does).
    if (!this._anchor) {
      this._anchor = { wx, wy };
      this._lastProgressAt = now;
    } else if (Math.hypot(wx - this._anchor.wx, wy - this._anchor.wy) > this.progressM) {
      this._anchor = { wx, wy };
      this._lastProgressAt = now;
    }

    // Commanded-continuity clock.
    if (this._commanded()) {
      if (this._commandedAt == null) this._commandedAt = now;
    } else {
      this._commandedAt = null;
    }

    if (now < this._cooldownUntil) return;

    const stuckCommanded =
      this._commandedAt != null &&
      now - this._commandedAt >= this.wedgeAfterMs &&
      now - this._lastProgressAt >= this.wedgeAfterMs;
    const stuckFailed = this._doubleFailedHere(now, wx, wy);
    if (stuckCommanded || stuckFailed) {
      this._begin(
        pose, wx, wy,
        stuckCommanded
          ? `pose translated <${this.progressM}m for ${Math.round((now - this._lastProgressAt) / 1000)}s while movement was commanded`
          : "router FAILED twice at the same position",
      );
    }
  }

  // Movement is being COMMANDED right now (a wedged-while-idle bot is not
  // wedged — it is parked). Deliberately narrow: router WALK (goto/egress/
  // followRoute/travel/cruise all drive through the router) or a kernel loot
  // APPROACH (raw MoveToPosition with no router involvement). Router PORTAL
  // (teleport settling) and an open cast gesture (recall/portal waits pin the
  // pose legitimately) are excluded — those pin the pose on purpose.
  _commanded() {
    try {
      const h = this.host;
      if (typeof h?.GetCastBusyState === "function" && h.GetCastBusyState() !== 0) return false;
    } catch { /* gate read is best-effort */ }
    try {
      const b = this.bot;
      if (b?.router?.status?.state === "WALK") return true;
      if (b?.loot && b.loot.state === "APPROACH") return true;
    } catch { /* unreadable bot = not commanded */ }
    return false;
  }

  // Router FAILED edge detector — record where each FAILED landed.
  _trackRouterFails(now, pose) {
    let rs = null;
    try {
      rs = this.bot?.router?.status?.state ?? null;
    } catch {
      rs = null;
    }
    if (rs === "FAILED" && this._lastRouterState !== "FAILED" && pose && typeof pose.objCellId === "number") {
      const cell = pose.objCellId >>> 0;
      const unresolved = pose.cellResolved === false || (pose.cellResolved == null && cell === 0);
      if (!unresolved) {
        this._fails.push({ wx: worldX(cell, pose.x), wy: worldY(cell, pose.y), t: now });
        if (this._fails.length > 6) this._fails.shift();
      }
    }
    this._lastRouterState = rs;
  }

  // Two router FAILs at effectively the same position, both near where the
  // bot still stands, inside the window.
  _doubleFailedHere(now, wx, wy) {
    this._fails = this._fails.filter((f) => now - f.t <= this.failWindowMs);
    const near = this._fails.filter((f) => Math.hypot(f.wx - wx, f.wy - wy) <= this.failNearM * 2);
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        if (Math.hypot(near[i].wx - near[j].wx, near[i].wy - near[j].wy) <= this.failNearM) return true;
      }
    }
    return false;
  }

  // Newest usable crumb at index <= fromIdx that sits far enough from the
  // wedge to be worth walking to. -1 when the trail has nothing left.
  _pickCrumb(fromIdx) {
    if (!this._wedge) return -1;
    for (let i = Math.min(fromIdx, this._crumbs.length - 1); i >= 0; i--) {
      const c = this._crumbs[i];
      if (Math.hypot(c.wx - this._wedge.wx, c.wy - this._wedge.wy) >= this.minRetreatM) return i;
    }
    return -1;
  }

  _begin(pose, wx, wy, why) {
    const now = this.now();
    this.wedges += 1;
    this._wedge = { wx, wy, z: pose.z, cell: pose.objCellId >>> 0, at: now };
    // Avoid set FIRST — even if the rest of the recovery fails, the explorer
    // must stop targeting this spot.
    try {
      this.bot?.ai?.extensions?.exploreMemory?.markWedge?.(wx, wy, this.avoidRadiusM);
    } catch { /* avoid-set is best-effort */ }
    // Preempt: cancel the router walk. An in-flight goto/followRoute poll
    // sees IDLE -> CANCELLED and unwinds (their normal last-command-wins
    // path); a cruise/travel is simply cancelled.
    try {
      this.bot?.router?.cancel?.();
    } catch { /* cancel is best-effort */ }
    this.log(`WEDGED: ${why} — beginning recovery (${this._crumbs.length}-crumb trail)`);
    this._journal(`[unwedge] WEDGED (${why}) — retreating to the last open breadcrumb`);
    const idx = this._pickCrumb(this._crumbs.length - 1);
    if (idx < 0) {
      this.state = "RECALL";
      this._journal("[unwedge] no usable breadcrumb trail — escalating straight to recall");
      this._startRecall();
      return;
    }
    this.state = "RETREAT";
    this._retreat = { idx, attempts: 0, startedAt: now, lastIssueAt: 0 };
    this._issueRetreat(now);
  }

  _issueRetreat(now) {
    const c = this._crumbs[this._retreat.idx];
    if (!c) return;
    try {
      this.host.MoveToPosition(c.cell, c.x, c.y, c.z, true);
    } catch { /* a refused move re-issues on the next reissue window */ }
    this._retreat.lastIssueAt = now;
  }

  _retreatTick(now, wx, wy) {
    const r = this._retreat;
    if (!r || !this._wedge) {
      this.state = "MONITOR";
      return;
    }
    const c = this._crumbs[r.idx];
    if (!c) {
      this.state = "RECALL";
      this._startRecall();
      return;
    }
    const dCrumb = Math.hypot(wx - c.wx, wy - c.wy);
    const dWedge = Math.hypot(wx - this._wedge.wx, wy - this._wedge.wy);
    if (dCrumb <= this.retreatArriveM || dWedge >= this.freedM) {
      try {
        this.host.StopCompletely?.();
      } catch { /* stop is best-effort */ }
      // Crumbs newer than the one we reached lead back INTO the wedge — drop them.
      this._crumbs = this._crumbs.slice(0, r.idx + 1);
      this._finish(true, `retreated to open ground (${dWedge.toFixed(1)}m from the wedge)`);
      return;
    }
    if (now - r.lastIssueAt >= this.reissueMs) this._issueRetreat(now);
    if (now - r.startedAt >= this.retreatLegMs) {
      r.attempts += 1;
      const nextIdx = this._pickCrumb(r.idx - 1);
      if (r.attempts >= this.maxRetreatCrumbs || nextIdx < 0) {
        this._journal(`[unwedge] retreat exhausted after ${r.attempts} breadcrumb attempt(s) — escalating to recall`);
        this.state = "RECALL";
        this._retreat = null;
        this._startRecall();
        return;
      }
      r.idx = nextIdx;
      r.startedAt = now;
      this._issueRetreat(now);
    }
  }

  _startRecall() {
    if (this._recallBusy) return;
    this._recallBusy = true;
    void this._doRecall()
      .catch((e) => {
        this.log(`recall error: ${(e && e.message) || e}`);
        this._finish(false, `recall path threw: ${(e && e.message) || e}`);
      })
      .finally(() => {
        this._recallBusy = false;
      });
  }

  async _doRecall() {
    const kernel = this.bot?.kernel;
    const wasRunning = kernel?.running === true;
    try {
      kernel?.stop?.();
    } catch { /* kernel is optional */ }
    try {
      this.host.StopCompletely?.();
    } catch { /* stop is best-effort */ }
    try {
      // Known recall spells only — never cast blind.
      let known = [];
      try {
        const s = this.host?.s;
        known = s && typeof s.playerKnownSpells === "function" ? Array.from(s.playerKnownSpells() || []).map(Number) : [];
      } catch {
        known = [];
      }
      const candidates = this.recallSpells.filter((sp) => known.includes(sp.id));
      let gc = null;
      try {
        gc = await import(new URL("./goto_compose.js", import.meta.url));
      } catch {
        gc = null;
      }
      if (typeof gc?.attemptRecallCast === "function") {
        for (const sp of candidates) {
          if (this.state !== "RECALL") return; // a teleport already finished us
          this._journal(`[unwedge] casting ${sp.name} (recall to sanctuary — last-resort extraction)`);
          const r = await gc.attemptRecallCast(
            { host: this.host },
            { meta: { spellId: sp.id, spellName: sp.name } },
            this.recallTune,
          );
          if (r && r.ok) {
            this.recalls += 1;
            if (this.state === "RECALL") this._finish(true, `recalled to sanctuary via ${sp.name}`);
            return;
          }
          this._journal(`[unwedge] ${sp.name} failed: ${r?.error ?? "?"}`);
        }
      }
      if (!candidates.length) {
        // Honest blocked fact — the character simply cannot self-recall.
        this._journal(
          `[unwedge] recall-unavailable: no recall spell in the spellbook (tried ids ${this.recallSpells
            .map((sp) => sp.id)
            .join(", ")}) — cannot self-teleport out`,
        );
      }
      // Absolute last resort: admin-teleport to the OLDEST breadcrumb — open
      // ground this character physically stood on this session. Refused
      // server-side on a non-admin character (recovery then ends FAILED).
      if (this.adminTeleFallback && this._crumbs.length) {
        const c = this._crumbs[0];
        const cmd = `@teleloc 0x${(c.cell >>> 0).toString(16).toUpperCase()} ${c.x.toFixed(2)} ${c.y.toFixed(2)} ${c.z.toFixed(2)}`;
        this._journal(`[unwedge] LAST RESORT: admin teleport to the oldest breadcrumb (${cmd})`);
        let sent = false;
        try {
          sent = this.host.InvokeChatParser?.(cmd) !== false;
        } catch {
          sent = false;
        }
        if (sent) {
          const deadline = Date.now() + (this.recallTune.adminTeleWaitMs ?? 8_000);
          while (Date.now() < deadline) {
            await sleep(this.recallTune.teleportPollMs ?? 500);
            const p = this._pose();
            if (p && typeof p.objCellId === "number") {
              const pwx = worldX(p.objCellId >>> 0, p.x);
              const pwy = worldY(p.objCellId >>> 0, p.y);
              if (Math.hypot(pwx - c.wx, pwy - c.wy) <= this.retreatArriveM) {
                if (this.state === "RECALL") this._finish(true, "admin-teleported to the oldest breadcrumb");
                return;
              }
            }
            if (this.state !== "RECALL") return; // teleport branch already finished us
          }
        }
      }
      if (this.state === "RECALL") this._finish(false, "recovery exhausted (retreat failed; recall unavailable or failed)");
    } finally {
      if (wasRunning) {
        try {
          kernel?.start?.();
        } catch { /* restore is best-effort */ }
      }
    }
  }

  _finish(ok, why) {
    const now = this.now();
    this.state = "MONITOR";
    this._retreat = null;
    this._wedge = null;
    this._fails = [];
    this._commandedAt = null;
    this._anchor = this._last ? { wx: this._last.wx, wy: this._last.wy } : null;
    this._lastProgressAt = now;
    this._cooldownUntil = now + this.cooldownMs;
    if (ok) this.freedCount += 1;
    this.lastResult = { ok, why, at: now };
    this.log(ok ? `freed — ${why}` : `recovery FAILED — ${why}`);
    this._journal(`[unwedge] ${ok ? "FREED" : "recovery FAILED"} — ${why}`);
    try {
      this.bot?.ai?.director?.requestEarlyCheck?.(
        ok ? `unwedged: ${why}` : `unwedge recovery FAILED: ${why} — avoid this spot`,
        { minGapSeconds: 30 },
      );
    } catch { /* event wiring must not break recovery */ }
  }

  get status() {
    return {
      enabled: this.enabled,
      state: this.state,
      crumbs: this._crumbs.length,
      wedges: this.wedges,
      freed: this.freedCount,
      recalls: this.recalls,
      cooldownUntil: this._cooldownUntil,
      lastResult: this.lastResult,
    };
  }
}

export default UnwedgeReflex;
