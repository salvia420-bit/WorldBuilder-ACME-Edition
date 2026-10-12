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

export class RynthBotKernel {
  constructor(host, { combat, buff, loot, vitals, unwedge }, opts = {}) {
    this.host = host;
    this.combat = combat;
    this.buff = buff;
    this.loot = loot;
    this.vitals = vitals; // B15/B16 vital-emergency policy (optional)
    this.unwedge = unwedge; // wedge self-recovery reflex (unwedge.js, optional)
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
    // Register the host closure ONCE — host.onTick has no removal API, so a
    // per-start() registration would stack one extra kernel tick per
    // stop/start cycle (goto and pause/resume both cycle). The single
    // closure gates on _running, so stop() makes it inert.
    if (!this._tickInstalled) {
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
    this.log("started");
    return true;
  }
  stop() {
    this._running = false;
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
   *  must not cost it its swing). */
  _leaveCombat(next) {
    const c = this.combat;
    const keepLoop = next === "Vitals";
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
    if (this.vitals && this.vitals.enabled !== false) {
      // Raw threat presence, not canEngage(): a character that can't fight
      // back is still being fought, and should heal on the in-combat
      // thresholds.
      const inCombat = (this.combat && this.combat.locked !== 0) || this._threatPresent();
      if (this.vitals.step(inCombat)) {
        if (this.action !== "Vitals") {
          this.log(`${this.action} -> Vitals`);
          if (this.action === "Combat") this._leaveCombat("Vitals");
          this.action = "Vitals";
        }
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
      if (this.action !== "Unwedge") {
        this.log(`${this.action} -> Unwedge`);
        if (this.action === "Combat" || this._combatHeld) this._leaveCombat("Unwedge");
        this.action = "Unwedge";
      }
      return;
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
    if (combatPinned || threat) next = "Combat";
    else if (lootPinned) next = "Loot";
    else if (buffPinned) next = "Buffing";
    else if (this._corpseAvailable()) next = "Loot";
    else if (this._buffNeeded()) next = "Buffing";
    else next = "Idle";

    if (next !== this.action) {
      this.log(`${this.action} -> ${next}`);
      // Leaving combat mid-stick would leave the player glued to a corpse
      // (and a live attack loop swinging at a target we've walked away from).
      if (this.action === "Combat" && next !== "Combat") this._leaveCombat(next);
      // Back from a mid-fight heal to something other than the fight: the
      // attack loop Vitals deliberately kept is now orphaned — cancel it.
      else if (this._combatHeld && next !== "Combat") this._leaveCombat(next);
      if (next === "Combat") this._combatHeld = false; // the fight resumes its own loop
      // Combat preempting a corpse walk: stop the walk before the run-up.
      if (next === "Combat" && this.action === "Loot") this._cancelLootApproach();
      this.action = next;
    }

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
        return;
    }
  }

  get status() {
    return {
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
  }
}

export default RynthBotKernel;
