// RynthCombatLoop — Phase-2 combat brain on the RynthWebHost seam.
//
// A faithful minimal subset of RynthAi's combat contract as extracted in
// docs/rynth-integration/workflow-reports/11.md. Constants are lifted
// verbatim (report 11 §constants table); rule tags reference its numbering.
// Degrade-open (contract 0.1): absent gates fall back to interval pacing,
// never block.
//
// Live-confirmed traps this encodes:
// - ACE silently reverts Melee mode when a bow/wand is wielded — use the
//   equipment-derived suggested-mode toggle, never a blind SetCombatMode.
// - objectHealthFraction is QueryHealth-fed — poll the locked target.

const TARGET_SWITCH_STICKINESS = 25.0; // T9 — alt must beat locked+25
const TARGET_SCAN_GRACE_MS = 1500; // T10 — keep lock through scan gaps
const CAST_RESOLUTION_TIMEOUT_MS = 2500; // P2/E4 — UseDone fallback
const RECENTLY_KILLED_TTL_MS = 30_000; // T2 — corpse re-engage guard
const QUERY_HEALTH_INTERVAL_MS = 1000;
const MELEE_SWING_PATIENCE_MS = 9000; // melee has no UseDone; re-issue window
const WAR_BOLTS = [27, 28, 58, 64, 75, 86, 92]; // level-1 war spells

const ITEM_TYPE_CREATURE = 16;
const PLAYER_GUID_MIN = 0x50000000;
const PLAYER_GUID_MAX = 0x5fffffff;

export class RynthCombatLoop {
  constructor(host, opts = {}) {
    this.host = host;
    this.log = opts.log || ((m) => console.log(`[combat] ${m}`));
    this.state = "IDLE"; // IDLE | ACQUIRE | ENGAGE | ATTACK
    this.locked = 0; // T9 lock
    this.lockedScore = -1;
    this.lastSeenLockedAt = 0; // T10
    this.recentlyKilled = new Map(); // guid -> diedAt (T2)
    this.kills = 0;
    this.mode = 1;
    this.modeRequestedAt = 0;
    // P5 mark-on-issue
    this.awaitingCast = false;
    this.castIssuedAt = 0;
    this.useDoneAtIssue = 0;
    this.lastQueryAt = 0;
    this.lastSwingAt = 0;
    this.warSpell = null;
    this._running = false;
  }

  startOn(host) {
    this._running = true;
    host.onTick(() => {
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
  }

  // ── target selection (T2 filter subset + natural scoring + T8 hook) ──
  _scanTargets() {
    const h = this.host;
    const me = h.TryGetPlayerPose();
    if (!me) return [];
    const now = Date.now();
    const out = [];
    for (const g of h.NearbyGuids()) {
      // T2 exclusion classes, in order:
      if (h.ObjectIsPlayer(g) || (g >= PLAYER_GUID_MIN && g <= PLAYER_GUID_MAX)) continue;
      const killedAt = this.recentlyKilled.get(g);
      if (killedAt && now - killedAt < RECENTLY_KILLED_TTL_MS) continue;
      const itemType = h.TryGetObjectIntProperty(g, 1);
      if (itemType !== ITEM_TYPE_CREATURE) continue; // not Monster class
      if (!h.ObjectIsAttackable(g)) continue; // T2: vendors/NPCs are creatures too
      const hf = h.TryGetTargetHealthFraction(g);
      if (hf === 0) continue; // dead-not-corpse
      const pos = h.TryGetObjectPosition(g);
      if (!pos || pos.objCellId >>> 16 !== me.objCellId >>> 16) continue; // same LB only (v1 distance gate)
      const d = Math.hypot(pos.x - me.x, pos.y - me.y, pos.z - me.z);
      if (d > 40) continue;
      // Natural "fastest-to-attack" scoring: nearer = higher (T8's
      // priority term is 0 for default rules — omitted until monster
      // rules exist).
      out.push({ guid: g, score: 100 - d, dist: d });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  _selectTarget() {
    const now = Date.now();
    const targets = this._scanTargets();
    const lockedEntry = targets.find((t) => t.guid === this.locked);
    if (lockedEntry) {
      this.lastSeenLockedAt = now;
      this.lockedScore = lockedEntry.score;
    }
    if (this.locked && !lockedEntry) {
      // T10 scan grace: keep the lock briefly through a scan gap.
      if (now - this.lastSeenLockedAt < TARGET_SCAN_GRACE_MS) return this.locked;
      this.log(`drop target ${this.locked.toString(16)} (scan grace expired)`);
      this.locked = 0;
      this.lockedScore = -1;
    }
    const best = targets[0];
    if (!best) return this.locked;
    if (!this.locked) {
      this.locked = best.guid;
      this.lockedScore = best.score;
      this.lastSeenLockedAt = now;
      this.log(`lock ${best.guid.toString(16)} (${this.host.TryGetObjectName(best.guid)}) d=${best.dist.toFixed(1)}`);
    } else if (
      best.guid !== this.locked &&
      best.score > this.lockedScore + TARGET_SWITCH_STICKINESS // T9
    ) {
      this.log(`switch ${this.locked.toString(16)} -> ${best.guid.toString(16)}`);
      this.locked = best.guid;
      this.lockedScore = best.score;
      this.lastSeenLockedAt = now;
    }
    return this.locked;
  }

  // ── cast serializer (P2/P5/E4) ───────────────────────────────────────
  _castResolved() {
    if (!this.awaitingCast) return true;
    const h = this.host;
    // E4: UseDoneSeq advance OR the hard deadline — never wedge.
    if (h.has("GetUseDoneSeq") && h.GetUseDoneSeq() !== this.useDoneAtIssue) {
      this.awaitingCast = false;
      return true;
    }
    if (Date.now() - this.castIssuedAt > CAST_RESOLUTION_TIMEOUT_MS) {
      this.awaitingCast = false;
      return true;
    }
    return false;
  }
  _markCastIssued() {
    // P5: arm resolution tracking at issue time.
    this.awaitingCast = true;
    this.castIssuedAt = Date.now();
    this.useDoneAtIssue = this.host.has("GetUseDoneSeq") ? this.host.GetUseDoneSeq() : 0;
  }

  _pickWarSpell() {
    if (this.warSpell) return this.warSpell;
    const s = this.host.s;
    const known = s.playerKnownSpells ? Array.from(s.playerKnownSpells() || []).map(Number) : [];
    this.warSpell = WAR_BOLTS.find((id) => known.includes(id)) || null;
    return this.warSpell;
  }

  tick() {
    const h = this.host;
    if (!h.IsPlayerReady()) return;
    const now = Date.now();
    const target = this._selectTarget();

    if (!target) {
      this.state = "ACQUIRE";
      return;
    }

    // Kill / disappearance detection.
    const pos = h.TryGetObjectPosition(target);
    const hf = h.TryGetTargetHealthFraction(target);
    if (!pos || hf === 0) {
      this.log(`kill confirmed ${target.toString(16)} (${this.kills + 1})`);
      this.kills++;
      this.recentlyKilled.set(target, now);
      this.locked = 0;
      this.lockedScore = -1;
      h.StopStick();
      this.state = "ACQUIRE";
      return;
    }

    // ENGAGE: equipment-derived combat mode (the live-confirmed trap) +
    // stick for melee-range hold.
    this.mode = h.GetCurrentCombatMode();
    if (this.mode <= 1) {
      if (now - this.modeRequestedAt > 3000) {
        const s = h.s;
        if (s.toggleCombatMode) s.toggleCombatMode();
        this.modeRequestedAt = now;
        this.state = "ENGAGE";
      }
      return; // wait for the mode to complete before attacking
    }
    if (this.state !== "ATTACK") {
      h.StickToObject(target);
      this.state = "ATTACK";
    }

    // Health polling (QueryHealth-fed health fraction).
    if (now - this.lastQueryAt > QUERY_HEALTH_INTERVAL_MS) {
      h.QueryHealth(target);
      this.lastQueryAt = now;
    }

    // ATTACK, paced per mode.
    if (this.mode === 8) {
      if (!this._castResolved()) return; // P2: one cast in flight
      if (h.GetCastBusyState() !== 0) return; // local cast gesture gate
      const spell = this._pickWarSpell();
      if (!spell) {
        this.log("no war spell known — cannot fight in magic mode");
        this.stop();
        return;
      }
      h.CastSpell(target, spell);
      this._markCastIssued();
    } else {
      // Melee/missile: no UseDone per swing — patience-window pacing.
      if (now - this.lastSwingAt < MELEE_SWING_PATIENCE_MS) return;
      if (this.mode === 4 && h.s.missileAttack) h.s.missileAttack(target, 2, 0.6);
      else h.MeleeAttack(target, 2, 0.6);
      this.lastSwingAt = now;
    }
  }
}

export default RynthCombatLoop;
