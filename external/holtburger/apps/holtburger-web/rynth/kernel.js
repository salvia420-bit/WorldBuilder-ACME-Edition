// RynthBotKernel — the orchestrator from report 12's "BotKernel" concept:
// construction + tick routing + arbitration, replacing RynthAiPlugin's
// god-class plumbing for the web port. One kernel tick runs ONE loop's
// tick — the loops never share a tick, so the cast/busy gates are never
// contended (report 11 B14's BotAction pinning, kernel-shaped).
//
// Priority ladder (per tick, unless an owner is pinned):
//   1. COMBAT  — an attackable threat is in scan range
//   2. LOOT    — an unlooted corpse is available
//   3. BUFF    — a desired buff is missing/expiring
//   4. IDLE
//
// Ownership pinning: a loop mid-transaction keeps the tick —
//   combat: target locked;  loot: mid OPEN/LOOT/CONFIRM/APPROACH;
//   buff: cast pending confirmation. COMBAT preempts loot/buff pins the
// moment a threat appears (survival beats inventory).
//
// Body handoff (2026-10-12): the combat loop drives the body through the
// local stick and ACE's server-side attack loop (charge + auto-repeat), and
// neither stops on its own when the kernel moves on. So leaving Combat
// releases the stick and — unless Vitals is only borrowing the tick for a
// heal — cancels a live attack loop (combat.disengage); stop() does the same
// for every mover/pause that halts the kernel; and a Loot -> Combat preempt
// cancels loot's in-flight corpse walk (a JS-installed MoveToPosition would
// otherwise keep dragging the body to the corpse while combat runs up to the
// mob — cancelPursuit ends only JS-installed pursuits, never ACE's charge).
// A combat loop that can't fight right now (combat.canEngage() false: no war
// spell, no combat mode) is not picked for Combat, so loot/buff aren't
// starved behind it; Vitals still counts its threats as "in combat".
//
// VTank layer slots (`aux`, PLAN §3.13; rynth/vt/index.js createAuxShell):
// optional extra owners of the tick — `{ slots, idleHooks, policy, status }`.
// Without `aux` (the layer absent, ?botVt=off, flat-copy harnesses) tick()
// runs the literal ladder below and nothing else. With `aux` the ladder is
//   Vitals > [afterVitals: pinned, else wanting] > Unwedge > [afterUnwedge:
//   pinned] > [beforeCombatPinned] > pinned Combat > (boostLoot: loot/corpse
//   unless under attack) > [beforeCombat] > threat Combat > lootPinned >
//   buffPinned > corpse > buffNeeded > [beforeIdle] > Idle (+ idle hooks),
// so an empty shell (no slot enabled, boostLoot false) picks exactly what the
// literal ladder picks (rynth_vt_kernel_aux.test.mjs, T-K1/T-K2). A slot whose
// enabled() is false is invisible; no slot or hook runs while the kernel is
// not running (operator hold, a mover's stop). Leaving a slot calls its
// onLeave(next); a `keepsCombatLoop` slot borrows the tick from Combat the
// way Vitals does (ACE's attack loop is kept).

// Action names the kernel owns; an aux slot may not shadow one.
const KERNEL_ACTIONS = new Set(["Idle", "Combat", "Loot", "Buffing", "Vitals", "Unwedge", "Stopped"]);
const AUX_RANKS = new Set(["afterVitals", "afterUnwedge", "beforeCombatPinned", "beforeCombat", "beforeIdle"]);
const AUX_WARN_MS = 10_000; // one log line per slot+method per 10 s

export class RynthBotKernel {
  constructor(host, { combat, buff, loot, vitals, unwedge, aux }, opts = {}) {
    this.host = host;
    this.combat = combat;
    this.buff = buff;
    this.loot = loot;
    this.vitals = vitals; // B15/B16 vital-emergency policy (optional)
    this.unwedge = unwedge; // wedge self-recovery reflex (unwedge.js, optional)
    // VTank aux slots (header; PLAN §3.13). null = the literal ladder.
    this.aux = aux || null;
    this._auxCurrent = null; // the aux slot that holds the tick (this.action === its name)
    this._auxWarnAt = new Map(); // "slot.method" -> last warning ts
    this.log = opts.log || ((m) => console.log(`[kernel] ${m}`));
    this.action = "Idle"; // the B14 BotAction pin, observable
    this._running = false;
    this._tickInstalled = false;
    // Operator-hold latch (report 01 C1 / 13 C3, the single-stop-authority
    // fix): while true, start() is refused for EVERY caller — including the
    // director's own `resume` action (actions.js) and its idle-guard
    // (director.js _idleGuard) — not just the plain running/stopped flag.
    // Previously any start() call silently un-paused an operator's
    // `!bot pause` within one AI check-in; now only releaseOperatorHold()
    // (control_channel `!bot resume`) can lift it. Distinct from the
    // director-side durable operator_stop.js latch (that one gates the AI
    // loop across reconnects via localStorage); this one gates the grind
    // kernel itself, in-memory, for the life of this bot instance.
    this._operatorHeld = false;
    // A Vitals heal borrowed the tick MID-FIGHT: _leaveCombat("Vitals") kept
    // ACE's attack loop on purpose (the heal returns the tick to Combat). If
    // the kernel then goes anywhere BUT Combat — stop(), Unwedge, Loot,
    // Buffing, Idle — that loop is still swinging/charging at the old target
    // and must be cancelled (2026-10-12 review #5).
    this._combatHeld = false;
    // WHO deliberately paused the kernel (pauseFor) — distinct from a mover's
    // temporary stop (goto/route/approach restore it when their walk ends).
    // "ai" = the director's `pause` action: an operator STOP/RESUME must not
    // restart a kernel the AI chose to keep off (2026-10-12 review-2 #4).
    // Cleared by any successful start().
    this._pausedBy = null;
  }

  start() {
    if (this._operatorHeld) {
      this.log("start refused: operator hold is active (resume via the control channel)");
      return false;
    }
    this._running = true;
    this._pausedBy = null;
    if (this.buff && !this.buff.startedAt) this.buff.startedAt = Date.now();
    this._installTick();
    this.log("started");
    return true;
  }
  /** Register the host closure ONCE — host.onTick has no removal API, so a
   *  per-start() registration would stack one extra kernel tick per
   *  stop/start cycle (goto and pause/resume both cycle). The single
   *  closure gates on _running, so stop() makes it inert. Called by start()
   *  AND holdForOperator(): a bot booted under a persisted operator STOP
   *  (bot.js config.startHeld) holds where it would have started, so the
   *  closure keeps its boot position — before the VT layer's post-tick
   *  closure — instead of being appended after it by the later RESUME's
   *  start() (§3.3 kernel → postTick order, V-22; 2026-10-13 review
   *  wiring-2). Never from the constructor: the router/unwedge/VT pre-tick
   *  closures must come first (V-9). */
  _installTick() {
    if (this._tickInstalled) return;
    this._tickInstalled = true;
    this.host.onTick(() => {
      if (this._running) {
        try {
          this.tick();
        } catch (e) {
          this.log(`tick threw: ${e.message}`);
        }
      }
    });
  }
  stop() {
    this._running = false;
    // An aux slot holding the tick lets go of the body too (its router leg,
    // a dwell's movement claim, …) — onLeave("Stopped").
    if (this._auxCurrent) {
      const slot = this._auxCurrent;
      this._auxCurrent = null;
      this._auxCall(slot, "onLeave", "Stopped");
      this.action = "Idle";
    }
    // Every caller (goto/travel/followRoute/egress, operator pause, the AI
    // `pause`, bot.stop) hands the body to something else: release combat's
    // stick and its live attack loop so neither drags the character back
    // toward the old target.
    if (this.action === "Combat" || this._combatHeld) {
      this._leaveCombat("Stopped");
      this.action = "Idle";
    }
  }
  get running() {
    return this._running;
  }

  /** A deliberate pause by `who` (e.g. "ai" — the director's `pause`
   *  action): stop() plus the intent, so OperatorControl.resume() leaves the
   *  kernel off. A later successful start() clears it. */
  pauseFor(who = "pause") {
    this._pausedBy = String(who || "pause");
    this.stop();
  }
  get pausedBy() {
    return this._pausedBy;
  }

  /** Release what the combat loop is driving (stick + ACE attack loop).
   *  `next === "Vitals"` keeps the attack loop: a heal preempt borrows the
   *  tick, it doesn't abandon the fight (and a non-caster's heal attempt
   *  must not cost it its swing). So does an aux slot that declares
   *  `keepsCombatLoop` (a kit/potion between swings, PLAN §3.13). */
  _leaveCombat(next, nextSlot = null) {
    const c = this.combat;
    const keepLoop = next === "Vitals" || !!(nextSlot && nextSlot.keepsCombatLoop === true);
    if (c && typeof c.disengage === "function") c.disengage({ cancelAttack: !keepLoop });
    else this.host.StopStick();
    this._combatHeld = keepLoop;
  }

  /** Loot -> Combat: cancel the corpse walk's JS-installed MoveToPosition. */
  _cancelLootApproach() {
    if (!this.loot || this.loot.state !== "APPROACH") return;
    if (typeof this.host.StopCompletely === "function") this.host.StopCompletely();
  }

  /** Operator-only hard hold (control_channel `!bot pause`): stops the
   * kernel and latches start() refused until releaseOperatorHold(). This is
   * the single stop authority — a plain stop() (AI `pause` action, goto,
   * followRoute) never sets this, so only an explicit operator pause can
   * arm it, and only an explicit operator resume can clear it. */
  holdForOperator() {
    this._operatorHeld = true;
    this.stop();
    // Inert while held (_running false); see _installTick. A host without
    // onTick (a bare test fake) keeps today's lazy install in start().
    if (this.host && typeof this.host.onTick === "function") this._installTick();
  }
  /** Explicit operator resume (control_channel `!bot resume`): lifts the
   * hold so a subsequent start() can succeed. Does not itself start() —
   * callers decide. */
  releaseOperatorHold() {
    this._operatorHeld = false;
  }
  get operatorHeld() {
    return this._operatorHeld;
  }

  _threatPresent() {
    // Reuse combat's own scanner — same filters, same truth (memoized per
    // host snapshot inside combat_loop, so the several reads a tick are one
    // scan).
    return this.combat ? this.combat._scanTargets().length > 0 : false;
  }
  _threatAvailable() {
    // A threat Combat can actually work on: a stood-down combat loop
    // (canEngage() false) leaves the tick to loot/buff/idle.
    if (!this.combat) return false;
    if (typeof this.combat.canEngage === "function" && !this.combat.canEngage()) return false;
    return this._threatPresent();
  }
  _corpseAvailable() {
    return this.loot ? !!this.loot._findCorpse() : false;
  }
  _buffNeeded() {
    if (!this.buff || this.buff.enabled === false) return false;
    const st = this.buff.status;
    // A held buff loop (missing components, no caster, …: buff_loop status
    // `blocked`) with nothing in flight can't make progress — don't park the
    // kernel on "Buffing" behind it.
    if (st.blocked && st.pending === 0) return false;
    return !st.ready || st.active < st.desired || st.pending !== 0;
  }

  // ── VTank aux slots (PLAN §3.13) ─────────────────────────────────────
  /** Log a slot failure at most once per AUX_WARN_MS per slot+method. */
  _auxWarn(key, e) {
    const now = Date.now();
    const last = this._auxWarnAt.get(key);
    if (last !== undefined && now - last < AUX_WARN_MS) return;
    if (this._auxWarnAt.size > 64) this._auxWarnAt.clear();
    this._auxWarnAt.set(key, now);
    this.log(`aux ${key} threw: ${(e && e.message) || e}`);
  }

  /** Call slot[method](arg) — a throw is logged and reads as `undefined`, so
   *  one broken slot can never take the kernel tick down with it. */
  _auxCall(slot, method, arg) {
    const f = slot && slot[method];
    if (typeof f !== "function") return undefined;
    try {
      return f.call(slot, arg);
    } catch (e) {
      this._auxWarn(`${slot.name}.${method}`, e);
      return undefined;
    }
  }

  /** The enabled slots with their rank for this tick — [] while the kernel
   *  is not running (operator hold / mover stop: no slot ever runs then). */
  _auxLive() {
    const aux = this.aux;
    if (!aux || !this._running || this._operatorHeld || !Array.isArray(aux.slots) || !aux.slots.length) return [];
    const live = [];
    for (const slot of aux.slots) {
      if (!slot || typeof slot.name !== "string" || KERNEL_ACTIONS.has(slot.name)) continue;
      if (this._auxCall(slot, "enabled") !== true) continue;
      let rank = slot.rank;
      if (typeof rank === "function") {
        try {
          rank = rank.call(slot);
        } catch (e) {
          this._auxWarn(`${slot.name}.rank`, e);
          continue;
        }
      }
      if (!AUX_RANKS.has(rank)) continue;
      live.push({ slot, rank });
    }
    return live;
  }

  /** First live slot of `rank` with pinned(); unless `pinnedOnly`, else the
   *  first one that wants(ctx). Array order within a rank. */
  _auxPick(live, rank, ctx, pinnedOnly = false) {
    for (const e of live) if (e.rank === rank && this._auxCall(e.slot, "pinned") === true) return e.slot;
    if (pinnedOnly) return null;
    for (const e of live) if (e.rank === rank && this._auxCall(e.slot, "wants", ctx) === true) return e.slot;
    return null;
  }

  /** Optional policy `pinnedFirst()` (default off = PLAN §3.13 literal): a
   *  pinned slot of ANY rank (a nav recall/portal/jump in flight) keeps the
   *  tick right after Unwedge, ahead of Combat/Loot/Buffing. */
  _auxPinnedAnyRank(live) {
    const p = this.aux && this.aux.policy;
    if (!p || typeof p.pinnedFirst !== "function") return null;
    let on = false;
    try {
      on = p.pinnedFirst() === true;
    } catch (e) {
      this._auxWarn("policy.pinnedFirst", e);
    }
    if (!on) return null;
    for (const e of live) if (this._auxCall(e.slot, "pinned") === true) return e.slot;
    return null;
  }

  _auxBoostLoot() {
    const p = this.aux && this.aux.policy;
    if (!p || typeof p.boostLoot !== "function") return false;
    try {
      return p.boostLoot() === true;
    } catch (e) {
      this._auxWarn("policy.boostLoot", e);
      return false;
    }
  }

  /** The aux ladder (PLAN §3.13). With no live slot and boostLoot false it
   *  returns what the literal ladder returns for every pin combination. */
  _auxLadder(ctx, live) {
    let s = this._auxPick(live, "beforeCombatPinned", ctx);
    if (s) return s;
    if (ctx.combatPinned) return "Combat";
    if (this._auxBoostLoot() && (ctx.lootPinned || ctx.corpse) && !ctx.underAttack) return "Loot";
    s = this._auxPick(live, "beforeCombat", ctx);
    if (s) return s;
    if (ctx.threat) return "Combat";
    if (ctx.lootPinned) return "Loot";
    if (ctx.buffPinned) return "Buffing";
    if (ctx.corpse) return "Loot";
    if (ctx.buffNeeded) return "Buffing";
    s = this._auxPick(live, "beforeIdle", ctx);
    if (s) return s;
    return "Idle";
  }

  /** Is any slot or idle hook switched on? (status shape, critic B7) */
  _auxAnyEnabled() {
    const aux = this.aux;
    if (!aux) return false;
    for (const list of [aux.slots, aux.idleHooks]) {
      if (!Array.isArray(list)) continue;
      for (const x of list) if (x && this._auxCall(x, "enabled") === true) return true;
    }
    return false;
  }

  /** The ONE action-change helper (Vitals, Unwedge, aux slots, the ladder).
   *  Without aux it does exactly what the three pre-aux transition blocks
   *  did (`_combatHeld` is only ever set while the action is Vitals or a
   *  keepsCombatLoop slot). */
  _switchTo(next, nextSlot = null) {
    if (next === this.action) {
      // Same name, different object (the slot list was rebuilt): hand over.
      if (nextSlot && this._auxCurrent && this._auxCurrent !== nextSlot) {
        const left = this._auxCurrent;
        this._auxCurrent = nextSlot;
        this._auxCall(left, "onLeave", next);
      }
      return;
    }
    this.log(`${this.action} -> ${next}`);
    if (this._auxCurrent) {
      const left = this._auxCurrent;
      this._auxCurrent = null;
      this._auxCall(left, "onLeave", next);
    }
    // Leaving combat mid-stick would leave the player glued to a corpse
    // (and a live attack loop swinging at a target we've walked away from).
    // Back from a mid-fight heal (or a keepsCombatLoop slot) to something
    // other than the fight: the attack loop it kept is now orphaned — cancel
    // it (unless the next owner borrows it too).
    if (next !== "Combat" && (this.action === "Combat" || this._combatHeld)) this._leaveCombat(next, nextSlot);
    if (next === "Combat") this._combatHeld = false; // the fight resumes its own loop
    // Combat preempting a corpse walk: stop the walk before the run-up.
    if (next === "Combat" && this.action === "Loot") this._cancelLootApproach();
    this.action = next;
    if (nextSlot) this._auxCurrent = nextSlot;
  }

  /** Hand the tick to an aux slot (switch first, then its tick). */
  _runSlot(slot, ctx) {
    this._switchTo(slot.name, slot);
    this._auxCall(slot, "tick", ctx);
  }

  _runIdleHooks(ctx) {
    const hooks = this.aux && this.aux.idleHooks;
    if (!Array.isArray(hooks) || !hooks.length || !this._running || this._operatorHeld) return;
    for (const h of hooks) {
      if (!h || this._auxCall(h, "enabled") !== true) continue;
      this._auxCall(h, "tick", ctx);
    }
  }

  tick() {
    if (!this.host.IsPlayerReady()) return;

    // Finding 2 (b5.md) — UNCONDITIONAL buff heartbeat. The kernel selects
    // ONE loop's tick per kernel-tick; buff.tick() (which owns the B13 30 s
    // death/dispel re-sync) only runs when "Buffing" is the selected action.
    // Once all buffs read active, _buffNeeded() below goes false, buff.tick()
    // never runs, the re-sync never fires, and a death that silently empties
    // the enchantment registry is never noticed -> the bot fights on unbuffed
    // forever (kernel-gate starvation). Pump a cheap self-throttled re-sync
    // EVERY tick, independent of the selected action, so death/dispel is
    // caught on the B13 cadence. Buff expiry is handled separately by
    // buff_loop's live expiry timestamps (_isActiveReal), so this only has to
    // catch the "registry emptied while our timers still say active" gap.
    // Per-loop `enabled` toggles (HUD / OperatorControl.setEnabled): a
    // disabled loop gets no tick, no heartbeat and no pin — the kernel
    // arbitrates as if it weren't there. (combat: its scan returns [] and a
    // live lock winds down through the T10 grace; loot: _findCorpse() is null
    // and the pin below is gated.)
    if (this.buff && this.buff.enabled !== false && this.buff.heartbeat) this.buff.heartbeat();

    // Vitals FIRST — survival preempts everything (B15/B16). inCombat =
    // combat currently has a locked target or a threat is present.
    //
    // Finding 8 (b5.md) — CONFIRMED-no-change, do NOT regress: C# CheckVitals
    // sits BEHIND the pending-cast hold in OnHeartbeat (BuffManager.cs:599),
    // so a self-buff in flight blocks even an emergency heal for up to ~2.5 s
    // (the SelfBuffGiveUp window). Running vitals FIRST here, ahead of the
    // buff/combat pins, means a dying character heals immediately regardless
    // of a pending buff. This is deliberately SAFER than the C# ordering
    // ("arguably fix C#, not JS"); the kernel's vitals-first placement is the
    // correct behavior and must not be reordered behind buffing.
    //
    // Raw threat presence, not canEngage(): a character that can't fight
    // back is still being fought, and should heal on the in-combat
    // thresholds. Computed at most once per tick (Vitals, then the aux ctx).
    let inCombat;
    const inCombatNow = () => {
      if (inCombat === undefined) inCombat = (this.combat && this.combat.locked !== 0) || this._threatPresent();
      return inCombat;
    };
    if (this.vitals && this.vitals.enabled !== false) {
      if (this.vitals.step(inCombatNow())) {
        this._switchTo("Vitals");
        return;
      }
    }

    // VTank aux slots (PLAN §3.13) — absent ⇒ none of this runs. afterVitals
    // and afterUnwedge slots see the partial ctx0 { now, inCombat, action }.
    const aux = this.aux;
    let live = null;
    let now = 0;
    let ctx0 = null;
    if (aux) {
      now = Date.now();
      live = this._auxLive();
      const action = this.action;
      ctx0 = {
        now,
        action,
        get inCombat() {
          return inCombatNow();
        },
      };
      const s = live.length ? this._auxPick(live, "afterVitals", ctx0) : null;
      if (s) {
        this._runSlot(s, ctx0);
        return;
      }
    }

    // Unwedge (wedge self-recovery, unwedge.js) — below Vitals (hard
    // survival still wins the tick) and above every grind pin: while the
    // reflex is actively extracting a physically wedged character, the
    // kernel yields the whole tick. The reflex drives its own retreat off
    // the host heartbeat; this yield just keeps combat/loot/buff from
    // issuing competing movement mid-extraction.
    if (this.unwedge && typeof this.unwedge.active === "function" && this.unwedge.active()) {
      this._switchTo("Unwedge");
      return;
    }

    // afterUnwedge slots run only while pinned (the `/rs jump` queue).
    if (live && live.length) {
      const s = this._auxPick(live, "afterUnwedge", ctx0, true);
      if (s) {
        this._runSlot(s, ctx0);
        return;
      }
    }

    // Ownership pins (mid-transaction loops keep the tick)…
    const combatPinned = this.combat && this.combat.locked !== 0;
    // A loot loop switched off mid-transaction would otherwise pin "Loot"
    // forever while its tick() is a no-op.
    const lootPinned = this.loot && this.loot.enabled !== false && this.loot.state !== "SCAN";
    const buffPinned = this.buff && this.buff.enabled !== false && this.buff.pending !== null;

    // …except COMBAT preempts everything when a threat exists.
    const threat = this._threatAvailable();

    let next;
    let ctx = null;
    if (!aux) {
      if (combatPinned || threat) next = "Combat";
      else if (lootPinned) next = "Loot";
      else if (buffPinned) next = "Buffing";
      else if (this._corpseAvailable()) next = "Loot";
      else if (this._buffNeeded()) next = "Buffing";
      else next = "Idle";
    } else {
      // The full KernelCtx (PLAN §3.2). corpse / buffNeeded / inCombat /
      // underAttack are read lazily, so they are evaluated exactly when — and
      // in the order — the literal ladder would evaluate them, unless a slot
      // (or boost loot) asks first.
      const k = this;
      let corpse;
      let buffNeeded;
      let underAttack;
      ctx = {
        now,
        threat: !!threat,
        combatPinned: !!combatPinned,
        lootPinned: !!lootPinned,
        buffPinned: !!buffPinned,
        action: this.action,
        get underAttack() {
          if (underAttack === undefined) underAttack = k._underAttack(now);
          return underAttack;
        },
        get inCombat() {
          return inCombatNow();
        },
        get corpse() {
          if (corpse === undefined) corpse = k._corpseAvailable();
          return corpse;
        },
        get buffNeeded() {
          if (buffNeeded === undefined) buffNeeded = k._buffNeeded();
          return buffNeeded;
        },
      };
      const pick = this._auxPinnedAnyRank(live) || this._auxLadder(ctx, live);
      if (typeof pick !== "string") {
        this._runSlot(pick, ctx);
        return;
      }
      next = pick;
    }

    this._switchTo(next);

    switch (next) {
      case "Combat":
        this.combat.tick();
        return;
      case "Loot":
        this.loot.tick();
        return;
      case "Buffing":
        this.buff.tick();
        return;
      default:
        if (ctx) this._runIdleHooks(ctx); // aux idle hooks run on Idle only
        return;
    }
  }

  /** combat.underAttack() (a creature hit or swung at us within the
   *  attacker grace) — false when the loop predates the hook. */
  _underAttack(now) {
    const c = this.combat;
    if (!c || typeof c.underAttack !== "function") return false;
    try {
      return c.underAttack(now) === true;
    } catch (_) {
      return false;
    }
  }

  get status() {
    const st = {
      action: this.action,
      running: this._running,
      operatorHeld: this._operatorHeld,
      pausedBy: this._pausedBy,
      kills: this.combat ? this.combat.kills : 0,
      looted: this.loot ? this.loot.lootedCount : 0,
      buffs: this.buff ? this.buff.status : null,
      vitals: this.vitals ? this.vitals.status : null,
      // Combat detail for the HUD/observers: { state, enabled, locked, kills,
      // mode, engagedAt, incapable, warSpell } (combat_loop.js `status`).
      combat: this.combat && this.combat.status ? this.combat.status : null,
    };
    // VTank aux detail only while something in it is switched on: the shell
    // is always passed when the layer loads, so "present" alone would change
    // this shape (and the AI observation text) at the Default profile.
    if (this.aux && this._auxAnyEnabled()) {
      let a = null;
      try {
        a = typeof this.aux.status === "function" ? this.aux.status() : null;
      } catch (e) {
        this._auxWarn("status", e);
      }
      st.aux = a;
    }
    return st;
  }
}

export default RynthBotKernel;
