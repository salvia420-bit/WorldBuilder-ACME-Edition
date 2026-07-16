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
//   B4  tier-upgrade: a desired buff is resolved to the highest-tier spell
//       in its family the character knows (via spell_ladders.json).
//   B5  incantation tier-cap: cap the target at the highest tier OBSERVED
//       landing for the family (skill-capped incantations don't recast
//       forever chasing their nominal tier).
//   B10 hard-reject cooldown: a family that can't land is parked 120s and
//       the batch respects it. B11 auto batch-rebuff: any buff below
//       threshold recasts ALL buffs in one pass (aligned timers). B12 force
//       rebuff ignores live timers (recast everything to a common start).
// Omitted (documented): B7 item enchants (chat confirmation). B15/B16 vital
// policy lives in vitals.js.

// Lazy-loaded family tier ladder (id -> [category, tier], self-beneficial
// buffs, baked from the spell DAT). Shared across all buff-loop instances.
let LADDER_TABLE = null;
let LADDER_PROMISE = null;
export function loadSpellLadders(base = "/apps/holtburger-web/rynth") {
  if (LADDER_TABLE) return Promise.resolve(LADDER_TABLE);
  if (!LADDER_PROMISE) {
    LADDER_PROMISE = fetch(`${base}/spell_ladders.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((t) => (LADDER_TABLE = t))
      .catch(() => (LADDER_TABLE = {}));
  }
  return LADDER_PROMISE;
}

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
    // The caller names a buff by ANY spell in its family (e.g. "Strength
    // Self I"); B4/B5 upgrade it to the highest known+castable tier at
    // start. `tierLadders` OFF (opts.tierLadders===false) keeps the exact
    // ids (pre-B4 behavior).
    this.rawDesired = desiredSpellIds.slice();
    this.tierLadders = opts.tierLadders !== false;
    this.desired = desiredSpellIds.slice(); // resolved lazily on first tick
    this._laddersBuilt = false;
    this._familyOfSpell = new Map(); // spellId -> category
    this._familyAchievedTier = new Map(); // category -> highest landed tier (B5)
    this._spellTier = new Map(); // spellId -> roughLevel
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
    // B10-B12 batch rebuff state.
    this.batchRebuff = opts.batchRebuff !== false; // on by default
    this._forceRebuffing = false; // B11 — recast everything this pass
    this._forceRebuffCast = new Set(); // B12 — families recast this cycle
    this._rejectParkedUntil = new Map(); // family -> ts (B10, 120s)
    this._running = false;
  }

  startOn(host) {
    this._running = true;
    this.startedAt = Date.now();
    if (this.tierLadders) loadSpellLadders(); // kick off the ladder fetch
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

  // Resolve a spell to { category, tier }. Prefers the static ladder table
  // (spell_ladders.json — id -> [category, tier], self-beneficial buffs,
  // baked from the spell DAT) because the live SpellCatalog (getSpellRecord)
  // is NOT loaded in a lightweight headless session. Falls back to
  // getSpellRecord when the catalog IS present (full render session).
  _spellMeta(id) {
    const key = String(id >>> 0);
    const t = LADDER_TABLE;
    if (t && t[key]) return { category: t[key][0], tier: t[key][1] };
    const s = this.host.s;
    if (s.getSpellRecord) {
      try {
        const r = s.getSpellRecord(id >>> 0);
        if (r && r.category != null) return { category: r.category, tier: Number(r.roughLevel) || 0 };
      } catch (_) {
        /* fall through */
      }
    }
    return null;
  }

  // B4/B5 — build family tier ladders from the known-spell book. For each
  // raw desired buff, find its family (category) and the highest-tier spell
  // in that family the character actually knows; that becomes the target.
  // B5: cap at the highest tier we've OBSERVED landing for the family (an
  // Incantation nominally tier 8 that lands skill-capped at 6 must not
  // recast forever chasing 8).
  _buildLadders() {
    this._laddersBuilt = true;
    const s = this.host.s;
    const known = s.playerKnownSpells ? Array.from(s.playerKnownSpells() || []).map(Number) : [];
    // Index every known spell by family with its tier.
    const byFamily = new Map(); // category -> [{id, tier}]
    for (const id of known) {
      const meta = this._spellMeta(id);
      if (!meta || meta.category == null) continue;
      this._familyOfSpell.set(id, meta.category);
      this._spellTier.set(id, meta.tier);
      if (!byFamily.has(meta.category)) byFamily.set(meta.category, []);
      byFamily.get(meta.category).push({ id, tier: meta.tier });
    }
    // Resolve each raw desired buff to the best known tier in its family.
    const resolved = [];
    for (const rawId of this.rawDesired) {
      const meta = this._spellMeta(rawId);
      const fam = meta ? meta.category : this._familyOfSpell.get(rawId);
      if (fam == null || !byFamily.has(fam)) {
        resolved.push(rawId); // no ladder data — keep as-is
        continue;
      }
      const cap = this._familyAchievedTier.get(fam) ?? 8;
      const ladder = byFamily
        .get(fam)
        .filter((e) => e.tier <= cap)
        .sort((a, b) => b.tier - a.tier);
      const best = ladder[0] ? ladder[0].id : rawId;
      if (best !== rawId) {
        this.log(`ladder: ${rawId} -> ${best} (family ${fam}, tier ${this._spellTier.get(best)})`);
      }
      resolved.push(best);
    }
    this.desired = resolved;
  }

  // B5 — record the tier a family actually landed at (from the registry),
  // and if a capped tier changes, rebuild ladders.
  _recordAchievedTiers(reg) {
    if (!reg) return;
    let changed = false;
    for (const [family, entry] of reg) {
      const tier = this._spellTier.get(entry.spellId);
      if (tier == null) continue;
      const prev = this._familyAchievedTier.get(family) ?? 0;
      if (tier > prev) {
        this._familyAchievedTier.set(family, tier);
        changed = true;
      }
    }
    if (changed && this.tierLadders) this._buildLadders();
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
    this._recordAchievedTiers(reg); // B5
    return reg;
  }

  _familyForSpell(spellId) {
    if (this.spellFamily.has(spellId)) return this.spellFamily.get(spellId);
    const meta = this._spellMeta(spellId);
    return meta ? meta.category : undefined;
  }

  // B3 real-timer test (ignores the force-rebuff view).
  _isActiveReal(spellId) {
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

  _isActive(spellId) {
    // B12: during a force-rebuff pass, a buff counts "active" ONLY if its
    // family was already recast THIS cycle — live timers are ignored so the
    // whole set recasts to a common start (aligned timers).
    if (this._forceRebuffing) {
      const fam = this._familyForSpell(spellId);
      return fam !== undefined && this._forceRebuffCast.has(fam);
    }
    return this._isActiveReal(spellId);
  }

  // B11 — any desired buff below threshold (real timers) means the set has
  // drifted; recast everything so the timers realign.
  _anyBelowThreshold() {
    return this.desired.some((id) => !this._isActiveReal(id));
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

    // B4/B5 — resolve desired buffs to their best known+castable tier once
    // the ladder table has loaded (or the live catalog is available).
    if (this.tierLadders && !this._laddersBuilt && (LADDER_TABLE || this.host.s.getSpellRecord)) {
      this._buildLadders();
    }

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
      if (this._isActiveReal(this.pending.spellId)) {
        this.noShows.delete(this.pending.spellId);
        // B12 — mark the family recast this cycle so the force-rebuff pass
        // stops re-selecting it.
        const fam = this._familyForSpell(this.pending.spellId);
        if (fam !== undefined) this._forceRebuffCast.add(fam);
        this.log(`confirmed ${this.pending.spellId}`);
        this.pending = null;
      } else if (age > SELF_BUFF_GIVE_UP_MS) {
        // B9 — silent no-show valve.
        const n = (this.noShows.get(this.pending.spellId) || 0) + 1;
        this.noShows.set(this.pending.spellId, n);
        this.log(`no-show ${this.pending.spellId} (${n}/${SILENT_NO_SHOW_THRESHOLD})`);
        if (n >= SILENT_NO_SHOW_THRESHOLD) {
          this.parkedUntil.set(this.pending.spellId, now + this.noShowCooldownMs);
          // B10/B12 — also park the FAMILY and mark it "done this cycle" so
          // a can't-land buff doesn't respin the whole batch forever.
          const fam = this._familyForSpell(this.pending.spellId);
          if (fam !== undefined) {
            this._rejectParkedUntil.set(fam, now + 120_000);
            this._forceRebuffCast.add(fam);
          }
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

    // B11 — start a force-rebuff pass when any buff drops below threshold, so
    // the whole set recasts to a common start (aligned timers) instead of a
    // staggered one-buff-every-few-minutes drip.
    if (this.batchRebuff && !this._forceRebuffing && this._anyBelowThreshold()) {
      this._forceRebuffing = true;
      this._forceRebuffCast = new Set();
      this.allActiveSince = 0;
      this.log("batch rebuff: recasting all buffs to align timers");
    }

    // Next needed buff.
    for (const spellId of this.desired) {
      const spellParked = this.parkedUntil.get(spellId);
      if (spellParked && now < spellParked) continue;
      if (spellParked) this.parkedUntil.delete(spellId);
      // B10 — respect family-level reject parks during the batch.
      const fam = this._familyForSpell(spellId);
      if (fam !== undefined && (this._rejectParkedUntil.get(fam) ?? 0) > now) continue;
      if (this._isActive(spellId)) continue;
      h.CastSpell(0, spellId); // untargeted = self
      this.lastCastAt = now;
      this.pending = { spellId, issuedAt: now };
      return;
    }
    // Nothing left to cast this pass.
    if (this._forceRebuffing) {
      // B11 complete — every family got its one recast; back to timer mode.
      this._forceRebuffing = false;
      this.log("batch rebuff complete");
    }
    if (!this.allActiveSince) {
      this.allActiveSince = now;
      this.log(`all ${this.desired.length} desired buffs active`);
    }
  }
}

export default RynthBuffLoop;
