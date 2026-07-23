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

export class RynthBotKernel {
  constructor(host, { combat, buff, loot, vitals }, opts = {}) {
    this.host = host;
    this.combat = combat;
    this.buff = buff;
    this.loot = loot;
    this.vitals = vitals; // B15/B16 vital-emergency policy (optional)
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
  }

  start() {
    if (this._operatorHeld) {
      this.log("start refused: operator hold is active (resume via the control channel)");
      return false;
    }
    this._running = true;
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
  }
  get running() {
    return this._running;
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

  _threatAvailable() {
    // Reuse combat's own scanner — same filters, same truth.
    return this.combat ? this.combat._scanTargets().length > 0 : false;
  }
  _corpseAvailable() {
    return this.loot ? !!this.loot._findCorpse() : false;
  }
  _buffNeeded() {
    if (!this.buff) return false;
    const st = this.buff.status;
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
    if (this.buff && this.buff.heartbeat) this.buff.heartbeat();

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
    if (this.vitals) {
      const inCombat = (this.combat && this.combat.locked !== 0) || this._threatAvailable();
      if (this.vitals.step(inCombat)) {
        if (this.action !== "Vitals") {
          this.log(`${this.action} -> Vitals`);
          if (this.action === "Combat") this.host.StopStick();
          this.action = "Vitals";
        }
        return;
      }
    }

    // Ownership pins (mid-transaction loops keep the tick)…
    const combatPinned = this.combat && this.combat.locked !== 0;
    const lootPinned = this.loot && this.loot.state !== "SCAN";
    const buffPinned = this.buff && this.buff.pending !== null;

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
      // Leaving combat mid-stick would leave the player glued to a corpse.
      if (this.action === "Combat" && next !== "Combat") this.host.StopStick();
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
      kills: this.combat ? this.combat.kills : 0,
      looted: this.loot ? this.loot.lootedCount : 0,
      buffs: this.buff ? this.buff.status : null,
      vitals: this.vitals ? this.vitals.status : null,
    };
  }
}

export default RynthBotKernel;
