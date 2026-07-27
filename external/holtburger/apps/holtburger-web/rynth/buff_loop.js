// RynthBuffLoop — Phase-3 self-buff maintenance on the RynthWebHost seam.
//
// A faithful subset of RynthAi's BuffManager contract as extracted in
// docs/rynth-integration/workflow-reports/11.md §buffs (B-rules). Implemented:
//   B1  login-stabilization gate (registry count stable across two
//       consecutive 1 s reads, or 20 s max wait) — never buff a
//       half-streamed registry.
//   B2  expiry truth = player enchantment registry keyed by FAMILY
//       (spell_category), remaining = (duration + start_time) − elapsed
//       since receipt (start_time is RELATIVE ≤ 0: 0 at cast, −age when
//       re-sent aged — ACE EnchantmentManager.cs:188).
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
//   B7  item enchants (Impen/Banes): live on the item, absent from the
//       player registry, duration not client-readable — recast on an
//       interval, confirmed ONLY by the "You cast <spell> on <item>" chat
//       line off the push-event plane (never optimistic).
// B15/B16 vital policy lives in vitals.js. The report-11 buff contract is
// complete.
//
// netwasm-parity fixes (b5.md, 2026-07-16) — each cites C# BuffManager.cs:
//   finding 1  B11: _anyBelowThreshold now SKIPS parked families (:824-827)
//              so a can't-land parked buff no longer livelocks the batch.
//   finding 2  B13/B3: families store ABSOLUTE expiry timestamps (live
//              remaining, :1216) + kernel-driven heartbeat() re-sync, so the
//              kernel gate no longer starves rebuffs on expiry/death.
//   finding 3  B4: _isActiveReal upgrade-recasts an active LOWER-tier family
//              (:1207-1215).
//   finding 4  B8: pending casts confirm by FAMILY, not spell id (:555-556) —
//              a skill-capped incantation landing lower no longer no-shows.
//   finding 5  B9: a silent no-show tier-WALKS-DOWN to the next known tier
//              (:566-573) instead of parking unbuffed.
//   finding 9  B8×B3: a sub-threshold-duration buff confirms (no false
//              no-show) and is held active (no infinite rebatch).
//   finding 10 B2: same-family wire rows keep the LATER expiry (JS-defensible;
//              C# keeps last, :1374) — CONFIRMED no change.

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
// Magic-mode entry give-up valve (02 C1 / synthesis #11) — see vitals.js's
// matching comment: toggleCombatMode() never yields Magic(8) for a
// melee/archer character, so entering Magic to self-buff is now an
// EXPLICIT ChangeCombatMode(8), bounded by attempts so a genuine non-caster
// (refused locally by the wasm's own is_wielding_caster gate, lib.rs:45179)
// parks instead of retrying forever.
const MAGIC_MODE_ATTEMPT_LIMIT = 5;
const MAGIC_MODE_PARK_MS = 15_000;

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
    // B9 tier-walk-down (finding 5): spell ids that silently no-showed are
    // marked unresolvable and excluded from the ladder, so the family
    // re-resolves to the next lower known tier instead of parking unbuffed.
    this._unresolvable = new Set();
    // B8×B3 (finding 9): families whose buff confirmed landing but whose
    // natural duration is below the rebuff threshold — held "active" while
    // present so the batch doesn't rebatch them forever.
    this._shortDurationFamilies = new Set();
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
    // B7 item enchants — [{ spellId, itemGuid }]. Item buffs live on the
    // item, are ABSENT from the player enchantment registry, and their true
    // duration is not client-readable (VTank couldn't read it either), so
    // they are recast on an interval and confirmed ONLY by chat ("You cast
    // <spell> on <item>") — never optimistically (an optimistic timer left a
    // phantom "active" buff whenever a cast silently failed).
    this.itemBuffs = (opts.itemBuffs || []).slice();
    this.itemRecastMs = opts.itemRecastMs ?? 25 * 60_000; // conservative
    this._itemLastCast = new Map(); // "spellId:itemGuid" -> confirmed ts
    this._itemPending = null; // { spellId, itemGuid, issuedAt }
    this._running = false;
  }

  startOn(host) {
    this._running = true;
    this.startedAt = Date.now();
    if (this.tierLadders) loadSpellLadders(); // kick off the ladder fetch
    // B7 — chat-confirm item enchants off the push-event plane.
    if (host.onEvent) host.onEvent((e) => this._onChat(e));
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

  // B7 — confirm an item enchant by the server's "You cast <spell> on
  // <target>" line (kind=2 Magic chat). The "on <target>" form is the
  // item/other-target cast; the self form is "You cast X and ...". Only a
  // matching confirmation stamps the timer — never optimistic.
  _onChat(e) {
    if (e.kind !== 2 || !e.text || !this._itemPending) return;
    if (/^You cast .+ on /.test(e.text)) {
      const key = `${this._itemPending.spellId}:${this._itemPending.itemGuid}`;
      this._itemLastCast.set(key, Date.now());
      this.log(`item enchant confirmed: ${e.text.slice(0, 60)}`);
      this._itemPending = null;
      if (typeof this.host.releaseCast === "function") this.host.releaseCast("buff"); // C3 shared serializer
    }
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
      if (this._unresolvable.has(id)) continue; // finding 5: skip blacklisted tiers
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
    // wire start_time is RELATIVE and ≤ 0 (0 at cast, decremented per
    // 5 s heartbeat — ACE PropertiesEnchantmentRegistryExtensions.cs:251
    // — so an aged re-send arrives as −age), NOT epoch seconds of any
    // kind. ACE's remaining formula (EnchantmentManager.cs:188):
    //   ExpiresAt = duration < 0 ? forever
    //             : receivedAt + duration + startTime
    // with receivedAt = OUR wall clock stamped when a given
    // (spellId, startTime) pair first appears; carried forward while
    // startTime is unchanged (recast re-stamps). (P4.2 follow-up F1:
    // the previous `− startTime` sign error made an aged buff's expiry
    // estimate 2×age late.)
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
      // Finding 2: store an ABSOLUTE expiry timestamp (wall-clock ms), NOT a
      // remaining-seconds SNAPSHOT. _isActiveReal/status recompute remaining
      // live against Date.now() every read, so expiry is detected even when
      // the loop hasn't ticked/refreshed in a while (the kernel-gate
      // starvation this fixes: once all-active the loop stops ticking, and a
      // frozen remainingS never crossed the rebuff threshold — BuffManager
      // stores expiry timestamps, BuffManager.cs:1216 `timer.Expiration`).
      let expiresAtMs;
      let permanent = false;
      if (duration < 0 || duration > PERMANENT_SENTINEL_S) {
        expiresAtMs = Infinity; // B6 presence-only
        permanent = true;
      } else {
        const key = `${spellId}`;
        const prior = this._receivedAt.get(key);
        const receivedAt =
          prior && prior.start === start ? prior.at : nowS;
        this._receivedAt.set(key, { start, at: receivedAt });
        // F1: `+ start` per ACE (start ≤ 0; clamp guards synthetic > 0).
        expiresAtMs = (receivedAt + duration + Math.min(0, start)) * 1000;
        if (expiresAtMs - nowS * 1000 <= 0) continue; // B2: drop expired
      }
      const prev = out.get(family);
      // B2 last-wins quirk (finding 10): C# keeps the LAST wire row for a
      // family (BuffManager.cs:1374); JS deliberately keeps the entry with the
      // LATER expiry (max-remaining) — more defensible against reordered/stale
      // rows. CONFIRMED-no-change: the JS choice stands.
      if (!prev || expiresAtMs > prev.expiresAtMs) {
        out.set(family, { spellId, expiresAtMs, permanent });
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
    // finding 9 cleanup: a short-duration family that has fully dropped from
    // the registry is eligible to recast again — forget its "held active" mark.
    if (reg) {
      for (const fam of this._shortDurationFamilies) {
        const entry = reg.get(fam);
        if (!entry || this._remainingS(entry) <= 0) this._shortDurationFamilies.delete(fam);
      }
    }
    return reg;
  }

  // Finding 2 — UNCONDITIONAL heartbeat driven by the kernel EVERY tick,
  // independent of whether "Buffing" is the selected action. It runs only the
  // B13 death/dispel re-sync (self-throttled to the 30 s cadence), so a death
  // that silently empties the enchantment registry is detected even while the
  // kernel is busy with combat/loot and never routes to Buffing. Without it,
  // once all buffs read active the kernel's _buffNeeded gate goes false,
  // buff.tick() (which owns the periodic refresh) never runs, and the bot
  // fights on unbuffed forever. Buff EXPIRY is handled separately by the live
  // expiry timestamps in _isActiveReal, so this only closes the "registry
  // emptied while our timers still say active" gap.
  heartbeat() {
    if (!this.registryReady) return; // login gate owns the pre-ready window
    if (Date.now() - this.lastRefreshAt > PERIODIC_REFRESH_INTERVAL_MS) this._refresh();
  }

  _familyForSpell(spellId) {
    if (this.spellFamily.has(spellId)) return this.spellFamily.get(spellId);
    const meta = this._spellMeta(spellId);
    return meta ? meta.category : undefined;
  }

  _tierOf(id) {
    if (this._spellTier.has(id)) return this._spellTier.get(id);
    const m = this._spellMeta(id);
    return m ? m.tier : null;
  }

  // Live remaining seconds from the stored absolute expiry (finding 2).
  _remainingS(entry) {
    return entry.permanent ? Infinity : (entry.expiresAtMs - Date.now()) / 1000;
  }

  // Resolve the registry entry backing a desired spell id: by family first
  // (so a skill-capped Incantation that landed as a lower-tier id in the SAME
  // family still resolves — finding 4), else by exact spell id.
  _entryForSpell(spellId) {
    const family = this._familyForSpell(spellId);
    if (family !== undefined && this.families.has(family)) return { family, entry: this.families.get(family) };
    for (const [fam, entry] of this.families) if (entry.spellId === spellId) return { family: fam, entry };
    return { family, entry: null };
  }

  // B3 real-timer test (ignores the force-rebuff view). Remaining is computed
  // live from the absolute expiry (finding 2), so this is correct even if the
  // registry hasn't been refreshed recently.
  _isActiveReal(spellId) {
    const { family, entry } = this._entryForSpell(spellId);
    if (!entry) return false;
    const remainingS = this._remainingS(entry);
    if (remainingS <= 0) return false;
    // B4 tier-upgrade (BuffManager.cs:1207-1215): a family holding a LOWER
    // tier than desired (capped by the highest tier we've seen land — B5) is
    // treated inactive so it upgrade-recasts regardless of time left. Was
    // absent — a friend-cast / older lower tier never upgraded (finding 3).
    const desiredTier = this._tierOf(spellId);
    const landedTier = this._tierOf(entry.spellId);
    if (family !== undefined && desiredTier != null && landedTier != null) {
      const cap = this._familyAchievedTier.get(family);
      const effectiveTarget = cap != null ? Math.min(desiredTier, cap) : desiredTier;
      if (landedTier < effectiveTarget) return false; // upgrade
    }
    if (entry.permanent) return true;
    // B8×B3 (finding 9): a family confirmed landing below the rebuff threshold
    // is held active while present so the batch doesn't rebatch it forever;
    // it's recast only once it fully drops from the registry.
    if (family !== undefined && this._shortDurationFamilies.has(family)) return true;
    return remainingS > REBUFF_SECONDS_REMAINING;
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

  // A desired buff is "parked" if the spell itself is in the no-show park
  // (B9) or its family is in the hard-reject/no-show cooldown (B10).
  _isParked(spellId, now) {
    const sp = this.parkedUntil.get(spellId);
    if (sp && now < sp) return true;
    const fam = this._familyForSpell(spellId);
    return fam !== undefined && (this._rejectParkedUntil.get(fam) ?? 0) > now;
  }

  // B11 — any desired buff below threshold (real timers) means the set has
  // drifted; recast everything so the timers realign. PARKED families are
  // SKIPPED (finding 1): C# AnyBuffBelowThreshold ignores families in the
  // fail cooldown (BuffManager.cs:824-827), otherwise a can't-land parked
  // buff keeps re-triggering the batch forever (batch -> cast -> no-show ->
  // re-park -> batch, the /god loop). The prior code counted parked buffs as
  // "below threshold" and livelocked the healthy set into perpetual recasts.
  _anyBelowThreshold() {
    const now = Date.now();
    return this.desired.some((id) => !this._isParked(id, now) && !this._isActiveReal(id));
  }

  get status() {
    const active = this.desired.filter((id) => this._isActive(id));
    return {
      ready: this.registryReady,
      desired: this.desired.length,
      active: active.length,
      parked: [...this.parkedUntil.keys()],
      pending: this.pending ? this.pending.spellId : 0,
      itemBuffs: this.itemBuffs.length,
      itemConfirmed: this._itemLastCast.size,
      itemPending: this._itemPending ? this._itemPending.spellId : 0,
    };
  }

  // ── netBrain (D1 path A′) — .NET-wasm BuffScheduling shadow ─────────────
  // SNAPSHOT mode (the dto-map ruling): SchedulerState is rebuilt from this
  // loop's live fields on every shadowed tick — a threaded C#-side mirror
  // would drift into pure noise after the first differing decision (its
  // PendingSpellId would track a cast that never physically happened).
  // Comparison is EVENT-level only: "would C# cast the same spell right
  // now" — cadence actions (login-wait/interval-wait/idle/mode-switch/...)
  // never count as divergence. Item-enchant ticks are skipped entirely
  // (JS B7 is a chat-confirmed mechanism the slice deliberately excludes).
  attachNetBrain(brain, mode, nbModule, opts = {}) {
    this._nb = { brain, mode, m: nbModule };
    this._nbVitals = opts.vitals || null;
    this._nbCombat = opts.combat || null;
    this._nbLastAt = 0;
    this._nbMinIntervalMs = opts.minIntervalMs ?? 250;
  }

  _nbRoman(t) {
    return ["I", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"][Math.max(1, Math.min(8, t || 1))];
  }

  // C# drops registry rows with an empty Name and parses the trailing roman
  // numeral for the tier — resolve via the live catalog when present, else
  // synthesize from the ladder meta (headless has no SpellCatalog).
  _nbSpellName(id, famHint) {
    const s = this.host.s;
    if (s.getSpellRecord) {
      try {
        const r = s.getSpellRecord(id >>> 0);
        if (r?.name) return r.name;
      } catch (_) { /* fall through */ }
    }
    const meta = this._spellMeta(id);
    const fam = meta?.category ?? famHint;
    return `Fam${fam ?? 0} Self ${this._nbRoman(meta?.tier)}`;
  }

  _nbBuildInput(now) {
    const h = this.host;
    const s = h.s;
    const v = this._nbVitals;
    const nowS = now / 1000;
    // RAW wire rows (C# does its own last-wins family collapse), reusing the
    // exact _readRegistry receivedAt bookkeeping (the Derethian-epoch trap).
    const registry = [];
    if (typeof s.playerEnchantments === "function") {
      if (!this._receivedAt) this._receivedAt = new Map();
      for (const e of s.playerEnchantments() || []) {
        const spellId = Number(e.spellId ?? e.spell_id);
        const family = Number(e.spellCategory ?? e.spell_category);
        const start = Number(e.startTime ?? e.start_time);
        const duration = Number(e.duration);
        const permanent = duration < 0 || duration > PERMANENT_SENTINEL_S;
        let remainingS = 0;
        if (!permanent) {
          const prior = this._receivedAt.get(`${spellId}`);
          const receivedAt = prior && prior.start === start ? prior.at : nowS;
          this._receivedAt.set(`${spellId}`, { start, at: receivedAt });
          // F1: `+ start` per ACE EnchantmentManager.cs:188 (start ≤ 0).
          remainingS = receivedAt + duration + Math.min(0, start) - nowS;
          if (remainingS <= 0) continue;
        }
        registry.push({
          SpellId: spellId, Name: this._nbSpellName(spellId, family),
          Family: family, RemainingS: permanent ? 0 : remainingS, Permanent: permanent,
        });
      }
    }
    // Desired ladders from the known book (same source as _buildLadders).
    const known = s.playerKnownSpells ? Array.from(s.playerKnownSpells() || []).map(Number) : [];
    const desired = [];
    for (const rawId of this.rawDesired) {
      const meta = this._spellMeta(rawId);
      const fam = meta?.category ?? this._familyOfSpell.get(rawId);
      const ladder = [];
      for (const id of known) {
        const m = this._spellMeta(id);
        if (!m || m.category !== fam) continue;
        ladder.push({
          Id: id, Name: this._nbSpellName(id, fam), Family: fam, Tier: m.tier,
          Known: !this._unresolvable.has(id), // folds the B9 walk-down blacklist
        });
      }
      desired.push({
        BaseName: this._nbSpellName(rawId, fam), SkillUsable: true,
        MaxTier: 8, Ladder: ladder, // no GetHighestBuffSpellTier live (documented gap)
      });
    }
    const fr = v && typeof v._fractions === "function" ? v._fractions() : null;
    const vid = (id) => (v && id && (!v._known || v._known(id)) ? id : 0);
    return {
      NowMs: now,
      Config: {
        EnableBuffing: true,
        RebuffSecondsRemaining: REBUFF_SECONDS_REMAINING,
        SpellCastIntervalMs: SPELL_CAST_INTERVAL_MS,
        HealAt: v?.cfg?.healAtCombat ?? 60, RestamAt: v?.cfg?.restamAtCombat ?? 30,
        GetManaAt: v?.cfg?.getManaAtCombat ?? 40,
        TopOffHP: v?.cfg?.topOffHp ?? 95, TopOffStam: v?.cfg?.topOffStam ?? 95,
        TopOffMana: v?.cfg?.topOffMana ?? 95,
      },
      Vitals: {
        HealthPct: fr ? Math.round(fr.hp * 100) : 100,
        StaminaPct: fr ? Math.round(fr.stam * 100) : 100,
        ManaPct: fr ? Math.round(fr.mana * 100) : 100,
        // Approximation of C#'s HasCloseThreat (a full _scanTargets here
        // would double the scan cost) — threshold-band ticks are cadence.
        InCombat: !!(this._nbCombat && this._nbCombat.locked !== 0),
        HasHealthKit: false, // no JS kit plane (documented gap)
        StamToHealthId: vid(v?.spells?.stamToHealth), HealSelfId: vid(v?.spells?.healSelf),
        StamToManaId: vid(v?.spells?.stamToMana), RevitalizeId: vid(v?.spells?.revitalize),
      },
      HasRegistryApi: typeof s.playerEnchantments === "function",
      Registry: registry,
      KnownSnapshotWarm: true,
      Desired: desired,
      InMagicMode: h.GetCurrentCombatMode() === 8,
      CanCastNow: h.GetCastBusyState() === 0,
      BusyCount: h.GetBusyState(),
      State: {
        RegistryReady: this.registryReady,
        LoginStartAtMs: this.startedAt || -1,
        LastLoginCount: this.lastCount,
        LastLiveRefreshAttemptMs: this.lastCountAt || -1e15,
        LastPeriodicRefreshMs: this.lastRefreshAt || -1e15,
        LastCastAttemptMs: this.lastCastAt || -1e15,
        LastSelfBuffPollAtMs: -1e15, // no JS mirror (cadence-only)
        PendingSpellId: this.pending?.spellId ?? 0,
        PendingSpellName: this.pending ? this._nbSpellName(this.pending.spellId) : "",
        PendingFamily: this.pending ? this._familyForSpell(this.pending.spellId) ?? 0 : 0,
        PendingKnown: true,
        ForceRebuffing: this._forceRebuffing,
        ForceRebuffCastFamilies: [...this._forceRebuffCast],
        NoShowCounts: [...this.noShows].map(([id, n]) => ({ Family: this._familyForSpell(id) ?? 0, Value: n })),
        FailCooldownUntil: [...this._rejectParkedUntil].map(([f, t]) => ({ Family: f, UntilMs: t })),
        AchievedTier: [...this._familyAchievedTier].map(([f, t]) => ({ Family: f, Value: t })),
        UnresolvableIds: [...this._unresolvable],
        RamTimers: [...this.families].map(([f, e]) => ({
          Family: f, SpellName: this._nbSpellName(e.spellId, f),
          Level: this._tierOf(e.spellId) ?? 0,
          // Infinity is not JSON — a permanent timer rides the flag + a far
          // finite expiry.
          ExpiresAtMs: e.permanent ? now + 1e12 : e.expiresAtMs,
          Permanent: !!e.permanent,
        })),
        ItemTimers: [], // JS B7 is out of the slice's scope by design
      },
    };
  }

  // C# actions that are pure cadence — never a divergence when JS is quiet.
  static _NB_CADENCE = new Set([
    "login-wait", "login-ready", "interval-wait", "gate-blocked", "hold-pending",
    "idle", "buffing-disabled", "confirmed", "no-show-retry", "no-show-parked",
    "no-chat-timeout", "mode-switch",
  ]);

  tick() {
    const nb = this._nb;
    const now = Date.now();
    const doShadow = !!nb?.brain && now - this._nbLastAt >= this._nbMinIntervalMs;
    let input = null;
    if (doShadow) {
      this._nbLastAt = now;
      try {
        input = this._nbBuildInput(now); // PRE-tick snapshot (both sides decide from it)
      } catch (_) {
        nb.m.diag().errors.buff++;
      }
    }
    const prePending = this.pending;
    const preItemPending = this._itemPending;
    this._tickJs();
    if (!input) return;
    // JS event this tick, classified by WHICH pending was newly set — an
    // outstanding item confirm can coexist with a fresh self-buff cast, so
    // "_itemPending is non-null" is not an item-cast marker (review finding).
    if (this._itemPending && this._itemPending !== preItemPending) return; // item cast: out of slice scope
    const jsCast = this.pending && this.pending !== prePending ? this.pending.spellId : 0;
    nb.m.shadowTick(nb.brain, "buff", () => input, (out) => {
      const csCast = out.Action === "cast-buff" || out.Action === "vital-cast" ? out.SpellId : 0;
      const agree = jsCast
        ? csCast === jsCast
        : csCast === 0 && (RynthBuffLoop._NB_CADENCE.has(out.Action) || out.Action === "");
      return {
        agree,
        jsVal: jsCast ? `cast:${jsCast}` : "quiet",
        csVal: `${out.Action}${out.SpellId ? ":" + out.SpellId : ""}`,
      };
    });
  }

  _tickJs() {
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
      const spellId = this.pending.spellId;
      const fam = this._familyForSpell(spellId);
      // B8 confirm by FAMILY, not spell id (BuffManager.cs:555-556): a
      // skill-capped Incantation lands as a LOWER-tier spell in the SAME
      // family, so confirming by the exact cast id phantom-no-shows every
      // incantation (finding 4). Confirm = the family is present in the live
      // registry with remaining > 0 (C# tests `st.Expiration > now`, NOT the
      // rebuff threshold — so a short-duration buff still confirms, finding 9).
      const famEntry = fam !== undefined ? this.families.get(fam) : null;
      const landed = famEntry ? this._remainingS(famEntry) > 0 : this._isActiveReal(spellId);
      if (landed) {
        this.noShows.delete(spellId);
        // B12 — mark the family recast this cycle so the force-rebuff pass
        // stops re-selecting it.
        if (fam !== undefined) {
          this._forceRebuffCast.add(fam);
          // finding 9: landed BELOW the rebuff threshold -> hold it active so
          // the batch doesn't rebatch this short-duration buff forever (the
          // deliberate improvement over C#, which rebatches endlessly here).
          if (famEntry && !famEntry.permanent && this._remainingS(famEntry) <= REBUFF_SECONDS_REMAINING) {
            if (!this._shortDurationFamilies.has(fam)) {
              this.log(`family ${fam} lands below rebuff threshold — holding active (finding 9, no rebatch)`);
            }
            this._shortDurationFamilies.add(fam);
          }
        }
        this.log(`confirmed ${spellId}`);
        this.pending = null;
        if (typeof h.releaseCast === "function") h.releaseCast("buff"); // C3 shared serializer
      } else if (age > SELF_BUFF_GIVE_UP_MS) {
        // B9 tier-walk-down FIRST (finding 5): a silently-dropped cast means
        // this tier won't land (skill-capped / unknown real tier). Mark it
        // unresolvable and re-resolve the family to the next lower KNOWN tier
        // so the bot ends up buffed at a reachable tier instead of parking
        // unbuffed for 30 min (BuffManager.cs:566-573 cold-snapshot
        // MarkSpellUnresolvable + FindBestSpellId tier-drop). Only when NO
        // lower tier remains do we fall through to the silent-no-show park.
        let walked = false;
        if (this.tierLadders && fam !== undefined && !this._unresolvable.has(spellId)) {
          this._unresolvable.add(spellId);
          this._buildLadders(); // re-resolve desired excluding unresolvable ids
          walked = this.desired.some(
            (id) => id !== spellId && !this._unresolvable.has(id) && this._familyForSpell(id) === fam
          );
          if (!walked) this._unresolvable.delete(spellId); // no lower tier — undo, let B9 park
        }
        if (walked) {
          this.log(`tier-down ${spellId} unresolvable -> family ${fam} walking to a lower tier`);
          this.pending = null;
          if (typeof h.releaseCast === "function") h.releaseCast("buff"); // C3 shared serializer
          return;
        }
        // B9 — silent no-show valve.
        const n = (this.noShows.get(spellId) || 0) + 1;
        this.noShows.set(spellId, n);
        this.log(`no-show ${spellId} (${n}/${SILENT_NO_SHOW_THRESHOLD})`);
        if (n >= SILENT_NO_SHOW_THRESHOLD) {
          this.parkedUntil.set(spellId, now + this.noShowCooldownMs);
          // B10/B12 — also park the FAMILY and mark it "done this cycle" so
          // a can't-land buff doesn't respin the whole batch forever.
          if (fam !== undefined) {
            this._rejectParkedUntil.set(fam, now + 120_000);
            this._forceRebuffCast.add(fam);
          }
          this.log(`parked ${spellId}`);
        }
        this.pending = null;
        if (typeof h.releaseCast === "function") h.releaseCast("buff"); // C3 shared serializer
      }
      return;
    }

    // Casting requires Magic combat mode (ACE Player_Magic mismatch gate —
    // the untargeted arm at :279 mirrors the targeted one; B14's
    // BotAction="Buffing" stance pin is this rule's native-side shadow).
    // Enter Magic EXPLICITLY (ChangeCombatMode(8)) rather than
    // toggleCombatMode() — the equipment-derived toggle never reaches
    // Magic for a non-caster (02 C1). This is ONLY the Magic-entry path
    // for self-buffing; combat's own equipment-derived toggle for its
    // Melee/Missile ENGAGE stance (the bow/wand mode-revert trap, README
    // "Live-verified traps") is untouched — never blind-set THAT one.
    if (h.GetCurrentCombatMode() !== 8) {
      const now0 = now;
      if (this._magicParkedUntil && now0 < this._magicParkedUntil) return; // gave up — don't retry-storm
      if (now0 - (this._modeRequestedAt || 0) > 3000) {
        h.ChangeCombatMode(8);
        this._modeRequestedAt = now0;
        this._magicAttempts = (this._magicAttempts || 0) + 1;
        if (this._magicAttempts > MAGIC_MODE_ATTEMPT_LIMIT) {
          this._magicParkedUntil = now0 + MAGIC_MODE_PARK_MS;
          this._magicAttempts = 0;
          this.log(
            `give up entering Magic mode after ${MAGIC_MODE_ATTEMPT_LIMIT} attempts (no caster wielded?) — parked ${MAGIC_MODE_PARK_MS / 1000}s`
          );
        }
      }
      return;
    }
    this._magicAttempts = 0; // mode established — reset the guard

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
      // C3 shared serializer: another module (combat/vitals) may hold a
      // still-open cast claim (gesture done, resolution not yet seen) —
      // wait rather than overlap it. Degrade-open if the host predates
      // the token (contract 0.1).
      if (typeof h.tryClaimCast === "function" && !h.tryClaimCast("buff")) return;
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

    // B7 — item enchants after self-buffs are settled.
    if (this._maintainItemBuffs(now, h)) return;

    if (!this.allActiveSince) {
      this.allActiveSince = now;
      this.log(`all ${this.desired.length} desired buffs active`);
    }
  }

  // B7 — returns true if it issued/awaits an item-enchant cast this tick.
  _maintainItemBuffs(now, h) {
    if (!this.itemBuffs.length) return false;
    // Awaiting chat confirmation? Time it out (no-chat = retry next pass).
    if (this._itemPending) {
      if (now - this._itemPending.issuedAt > 5000) {
        this.log(`item enchant no-chat timeout (${this._itemPending.spellId})`);
        this._itemPending = null;
        if (typeof h.releaseCast === "function") h.releaseCast("buff"); // C3 shared serializer
      }
      return true;
    }
    for (const ib of this.itemBuffs) {
      const key = `${ib.spellId}:${ib.itemGuid}`;
      const last = this._itemLastCast.get(key) ?? 0;
      if (now - last < this.itemRecastMs) continue; // still fresh (by interval)
      // C3 shared serializer — see the self-buff cast site above.
      if (typeof h.tryClaimCast === "function" && !h.tryClaimCast("buff")) return true;
      h.CastSpell(ib.itemGuid, ib.spellId); // targeted at the item
      this._itemPending = { spellId: ib.spellId, itemGuid: ib.itemGuid, issuedAt: now };
      this.lastCastAt = now;
      return true;
    }
    return false;
  }
}

export default RynthBuffLoop;
