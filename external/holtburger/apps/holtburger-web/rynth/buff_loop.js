// RynthBuffLoop — Phase-3 self-buff maintenance on the RynthWebHost seam.
//
// A faithful subset of RynthAi's BuffManager contract as extracted in
// docs/rynth-integration/workflow-reports/11.md §buffs (B-rules). Implemented:
//   B1  login-stabilization gate (registry count stable across two
//       consecutive 1 s reads, or 20 s max wait) — never buff a
//       half-streamed registry.
//   B2  expiry truth = player enchantment registry keyed by FAMILY
//       (spell_category), remaining = (start_time + duration) − serverNow.
//   B3  rebuff threshold: active while remaining > 300 s (uniform — the
//       1200 s batch override in the source is a stale comment).
//   B6  permanent enchants (remaining > 1 year) = presence-only.
//   B8  self-buff confirmation by registry re-read at 600 ms; give up at
//       2500 ms (then B9).
//   B9  silent-no-show valve: 2 consecutive no-shows parks the family
//       (30 min contract value; configurable for tests).
//   B13 30 s periodic full re-sync (death/dispel recovery).
//   B14 pacing: 400 ms cast interval + the cast/busy gates.
// Omitted for now (documented, not forgotten): B4/B5 tier ladders (needs a
// spell-family tier table), B7 item enchants (chat confirmation), B10-B12
// batch semantics, B15/B16 vital policy.

const LOGIN_REFRESH_MAX_WAIT_MS = 20_000; // B1
const REBUFF_SECONDS_REMAINING = 300; // B3
const SELF_BUFF_CONFIRM_MS = 600; // B8
const SELF_BUFF_GIVE_UP_MS = 2500; // B8
const SILENT_NO_SHOW_THRESHOLD = 2; // B9
const SILENT_NO_SHOW_COOLDOWN_MS = 30 * 60_000; // B9
const PERIODIC_REFRESH_INTERVAL_MS = 30_000; // B13
const SPELL_CAST_INTERVAL_MS = 400; // B14 (buffing is faster than combat)
const PERMANENT_SENTINEL_S = 86_400 * 365; // B6

export class RynthBuffLoop {
  /**
   * @param host RynthWebHost
   * @param desiredSpellIds self-buff spell ids to maintain (filtered to the
   *        known-spell book at start)
   */
  constructor(host, desiredSpellIds, opts = {}) {
    this.host = host;
    this.desired = desiredSpellIds.slice();
    this.log = opts.log || ((m) => console.log(`[buff] ${m}`));
    this.noShowCooldownMs = opts.noShowCooldownMs ?? SILENT_NO_SHOW_COOLDOWN_MS;
    // B1 state
    this.registryReady = false;
    this.startedAt = 0;
    this.lastCount = -1;
    this.lastCountAt = 0;
    // B2 state: family -> { spellId, remainingS, permanent } (refreshed)
    this.families = new Map();
    this.spellFamily = new Map(); // spellId -> family (learned from landings)
    this.lastRefreshAt = 0;
    // B8/B9 state
    this.pending = null; // { spellId, issuedAt }
    this.noShows = new Map(); // spellId -> consecutive count
    this.parkedUntil = new Map(); // spellId -> ts
    this.lastCastAt = 0;
    this.allActiveSince = 0;
    this._running = false;
  }

  startOn(host) {
    this._running = true;
    this.startedAt = Date.now();
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

  _readRegistry() {
    // B2: registry truth via the seam's session handle.
    //
    // Time-domain trap (the buffs-hud "bug A1", already solved there):
    // wire start_time/duration are DERETHIAN-epoch seconds, not Unix.
    // Per ACE Enchantment.cs:100-104 the robust formula is
    //   ExpiresAt = duration < 0 ? forever
    //             : receivedAt + duration - startTime
    // with receivedAt = OUR wall clock stamped when a given
    // (spellId, startTime) pair first appears; carried forward while
    // startTime is unchanged (recast re-stamps).
    const s = this.host.s;
    if (!s.playerEnchantments) return null;
    const nowS = Date.now() / 1000;
    if (!this._receivedAt) this._receivedAt = new Map();
    const out = new Map();
    for (const e of s.playerEnchantments() || []) {
      const spellId = Number(e.spellId ?? e.spell_id);
      const family = Number(e.spellCategory ?? e.spell_category);
      const start = Number(e.startTime ?? e.start_time);
      const duration = Number(e.duration);
      let remainingS;
      let permanent = false;
      if (duration < 0 || duration > PERMANENT_SENTINEL_S) {
        remainingS = Infinity; // B6 presence-only
        permanent = true;
      } else {
        const key = `${spellId}`;
        const prior = this._receivedAt.get(key);
        const receivedAt =
          prior && prior.start === start ? prior.at : nowS;
        this._receivedAt.set(key, { start, at: receivedAt });
        remainingS = receivedAt + duration - start - nowS;
        if (remainingS <= 0) continue; // B2: drop expired
      }
      const prev = out.get(family);
      if (!prev || remainingS > prev.remainingS) {
        out.set(family, { spellId, remainingS, permanent });
      }
      this.spellFamily.set(spellId, family);
    }
    return out;
  }

  _refresh() {
    const reg = this._readRegistry();
    if (reg) this.families = reg;
    this.lastRefreshAt = Date.now();
    return reg;
  }

  _isActive(spellId) {
    // B3: active while remaining > threshold. Family-keyed when the
    // family is known (a landed cast teaches it); spell-id fallback.
    const family = this.spellFamily.get(spellId);
    if (family !== undefined) {
      const entry = this.families.get(family);
      return !!entry && (entry.permanent || entry.remainingS > REBUFF_SECONDS_REMAINING);
    }
    for (const entry of this.families.values()) {
      if (entry.spellId === spellId) {
        return entry.permanent || entry.remainingS > REBUFF_SECONDS_REMAINING;
      }
    }
    return false;
  }

  get status() {
    const active = this.desired.filter((id) => this._isActive(id));
    return {
      ready: this.registryReady,
      desired: this.desired.length,
      active: active.length,
      parked: [...this.parkedUntil.keys()],
      pending: this.pending ? this.pending.spellId : 0,
    };
  }

  tick() {
    const h = this.host;
    if (!h.IsPlayerReady()) return;
    const now = Date.now();

    // B1 — login stabilization: registry count stable on two consecutive
    // ~1 s reads, or the 20 s max wait.
    if (!this.registryReady) {
      if (now - this.lastCountAt >= 1000) {
        const reg = this._readRegistry();
        const count = reg ? reg.size : -1;
        if (count >= 0 && count === this.lastCount) {
          this.registryReady = true;
          this.families = reg;
          this.log(`registry stable (${count} families) — buffing enabled`);
        }
        this.lastCount = count;
        this.lastCountAt = now;
      }
      if (!this.registryReady && now - this.startedAt < LOGIN_REFRESH_MAX_WAIT_MS) return;
      if (!this.registryReady) {
        this.registryReady = true; // 20 s cap reached
        this._refresh();
        this.log("registry stabilization timed out — proceeding (B1 cap)");
      }
    }

    // B13 — periodic re-sync (death/dispel recovery).
    if (now - this.lastRefreshAt > PERIODIC_REFRESH_INTERVAL_MS) this._refresh();

    // B8 — confirm the pending cast by registry re-read.
    if (this.pending) {
      const age = now - this.pending.issuedAt;
      if (age < SELF_BUFF_CONFIRM_MS) return;
      this._refresh();
      if (this._isActive(this.pending.spellId)) {
        this.noShows.delete(this.pending.spellId);
        this.log(`confirmed ${this.pending.spellId}`);
        this.pending = null;
      } else if (age > SELF_BUFF_GIVE_UP_MS) {
        // B9 — silent no-show valve.
        const n = (this.noShows.get(this.pending.spellId) || 0) + 1;
        this.noShows.set(this.pending.spellId, n);
        this.log(`no-show ${this.pending.spellId} (${n}/${SILENT_NO_SHOW_THRESHOLD})`);
        if (n >= SILENT_NO_SHOW_THRESHOLD) {
          this.parkedUntil.set(this.pending.spellId, now + this.noShowCooldownMs);
          this.log(`parked ${this.pending.spellId}`);
        }
        this.pending = null;
      }
      return;
    }

    // Casting requires Magic combat mode (ACE Player_Magic mismatch gate —
    // the untargeted arm at :279 mirrors the targeted one; B14's
    // BotAction="Buffing" stance pin is this rule's native-side shadow).
    // Equipment-derived toggle, same trap as combat: never blind-set.
    if (h.GetCurrentCombatMode() !== 8) {
      if (now - (this._modeRequestedAt || 0) > 3000) {
        const s = h.s;
        if (s.toggleCombatMode) s.toggleCombatMode();
        this._modeRequestedAt = now;
      }
      return;
    }

    // B14 — pacing + gates.
    if (now - this.lastCastAt < SPELL_CAST_INTERVAL_MS) return;
    if (h.GetCastBusyState() !== 0) return;
    if (h.GetBusyState() !== 0) return;

    // Next needed buff.
    for (const spellId of this.desired) {
      const parked = this.parkedUntil.get(spellId);
      if (parked && now < parked) continue;
      if (parked) this.parkedUntil.delete(spellId);
      if (this._isActive(spellId)) continue;
      h.CastSpell(0, spellId); // untargeted = self
      this.lastCastAt = now;
      this.pending = { spellId, issuedAt: now };
      return;
    }
    if (!this.allActiveSince) {
      this.allActiveSince = now;
      this.log(`all ${this.desired.length} desired buffs active`);
    }
  }
}

export default RynthBuffLoop;
