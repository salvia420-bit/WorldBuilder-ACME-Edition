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
  constructor(host, { combat, buff, loot }, opts = {}) {
    this.host = host;
    this.combat = combat;
    this.buff = buff;
    this.loot = loot;
    this.log = opts.log || ((m) => console.log(`[kernel] ${m}`));
    this.action = "Idle"; // the B14 BotAction pin, observable
    this._running = false;
  }

  start() {
    this._running = true;
    if (this.buff && !this.buff.startedAt) this.buff.startedAt = Date.now();
    this.host.onTick(() => {
      if (this._running) {
        try {
          this.tick();
        } catch (e) {
          this.log(`tick threw: ${e.message}`);
        }
      }
    });
    this.log("started");
  }
  stop() {
    this._running = false;
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
    };
  }
}

export default RynthBotKernel;
