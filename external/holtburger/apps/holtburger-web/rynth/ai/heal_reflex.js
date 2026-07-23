// heal_reflex.js — WP-14 A1-3: a DARK, flag-off out-of-combat heal reflex.
//
// Defense-in-depth for the death spiral (root fix lives in the vital-spell
// loop / director; §D6). Where rynth/vitals.js handles IN-combat survival with
// self-cast recovery spells, this reflex handles the complementary OUT-of-
// combat case with CONSUMABLES: on a health deficit it uses the best available
// healing kit on self (UseWithTarget), and if no usable kit is on hand it eats
// food as a fallback. It is a mechanism, not a policy — the kit/food/skill
// heuristics below are DEFAULTS you can override via opts (the same stance
// vitals.js takes with its spell ladder).
//
// NON-CASTER NOTE (review 02 C1/C4 context): this reflex is ITEM-based
// (UseItemOnTarget / UseObject), so — unlike vitals.js/buff_loop.js — it is
// NOT gated behind the wasm's Magic-combat-mode arm, and the wasm's
// `is_wielding_caster` refusal (mirrors ACE: no caster item wielded => no
// Magic mode, ever) never applies to it. That is exactly why it is the one
// mechanism that could rescue a non-caster from the C1 death spiral. But be
// honest about the OTHER limitation this reflex has of its own: it heals
// only for as long as a usable kit or food item is actually in the pack — a
// character carrying neither is just as unhealable by this reflex as a true
// non-caster (no known recovery spell) is by vitals.js. Do NOT "fix" that by
// teaching this reflex to cast a self-heal spell as a further fallback —
// that would walk straight back into the identical wasm caster-mode gate
// vitals.js/buff_loop.js already had to build a give-up valve around (see
// below); this module stays consumable-only by design.
//
// Survival invariants (operator, binding):
//   * FLAG-OFF ⇒ NO-OP. Constructed with {enabled:false} (the default) step()
//     touches nothing and returns {acted:false,reason:"disabled"} — it does not
//     even read the host, so it costs ~0 director/observation tokens.
//   * NEVER THROWS into the caller. Every host read/write is guarded; any error
//     degrades to {acted:false,reason:"error"} so a director loop cannot wedge.
//   * NO teleports, no content-specific ids in the mechanism (see the enum-
//     derived constants below; the only heuristic is a generic item-category
//     name/type match, fully overridable).
//   * NOT registered into the live kernel yet (deferred) — this file only
//     defines the controller; wiring is a later, gated step.
//
// No-op conditions (all three per the WP): full HP, host busy, or combat-lock
// (the in-combat spell loop owns healing while locked; the reflex defers).
//
// ACCESSOR FIX (review 02 D2): reads HP/skill straight off
// `host.s.playerStats()` — the SAME raw stride-4 (vitals) / stride-6 (skills)
// arrays rynth/vitals.js's own `_fractions()` parses — instead of the
// higher-level `host.TryGetPlayerStats()` normalization. Both were verified
// numerically identical (TryGetPlayerStats is itself built from the same raw
// array), but the review flagged two independent copies of the same stride
// layout as a sync hazard; since vitals.js can't be touched here, this
// module converges onto vitals.js's own pattern rather than the other way
// around, so there is exactly one parsing convention to keep correct.
//
// GIVE-UP VALVE (review 02 C4 fix): mirrors vitals.js's NO_PROGRESS/PARK
// pattern — if HP isn't actually climbing after repeated heals (a weak kit
// vs. a huge health pool, or a fight this reflex can't out-heal), stop
// spending consumables and park for a cooldown instead of burning the whole
// kit/food stack on a 3s timer with no cutoff (the exact unbounded loop
// vitals' valve was built to close — 02 C4 warned this reflex would reopen
// it if ever wired without one).
//
// SHARED CAST TOKEN (webhost.js tryClaimCast/releaseCast, review 02 C3):
// a kit/food UseItemOnTarget/UseObject occupies the same busy/cast-resolution
// window a spell gesture does, so this reflex claims the token before acting,
// exactly like vitals.js/buff_loop.js do before CastSpell — a still-open
// vitals/buff cast wins the tick instead of being stomped by a kit use.

// VitalType.Health = 1 (holtburger-common stats::VitalType; mirrors
// rynth/vitals.js VITAL_HEALTH).
const VITAL_HEALTH = 1;
// ItemType.FOOD = 0x20 (holtburger-common properties::inventory::ItemType).
const ITEM_TYPE_FOOD = 0x00000020;
// SkillType.Healing = 21 (holtburger-common stats::SkillType) — kit efficacy
// is gated on this skill in retail; a character with no Healing skill wastes
// the kit, so we fall back to food.
const SKILL_HEALING = 21;

const DEFAULTS = {
  enabled: false, // dark by default (operator invariant)
  healAtPct: 75, // act below this HP%; at/above ⇒ no-op ("full HP")
  minHealingSkill: 1, // kit is "skill-sufficient" iff Healing.current >= this
  cooldownMs: 3000, // min spacing between consumable uses (kit/food have a use timer)
};

// Give-up valve (mirrors rynth/vitals.js's NO_PROGRESS_LIMIT/VITAL_PARK_MS —
// 02 C4 fix): if HP hasn't improved by MIN_PROGRESS_PCT across
// NO_PROGRESS_LIMIT consecutive uses, the consumable is too weak against
// whatever is draining HP — park this reflex for GIVE_UP_PARK_MS so it stops
// spending kit/food stock and yields to whatever else is running.
const NO_PROGRESS_LIMIT = 6;
const MIN_PROGRESS_PCT = 0.5;
const GIVE_UP_PARK_MS = 60_000;

// A healing kit exposes no dedicated ItemType bit in the streamed inventory
// row, so the default identifier is a generic English CATEGORY match (not a
// wcid) — override opts.isKit for a stricter/DAT-driven signal. Food, by
// contrast, has a clean ItemType.FOOD bit, so isFood defaults to that.
const DEFAULT_IS_KIT = (it) => /heal(?:ing)?\s*kit|\bkit\b/i.test(String(it?.name || ""));
const DEFAULT_IS_FOOD = (it) => ((it?.itemType >>> 0) & ITEM_TYPE_FOOD) !== 0;
// Kit tiers (crude→plain→…→platinum) climb in Value, so higher Value is the
// better kit as a default rank. Override opts.rankKit for a real tier table.
const DEFAULT_RANK_KIT = (it) => Number(it?.value || 0);

export class HealReflex {
  constructor(host, opts = {}) {
    this.host = host;
    this.cfg = {
      enabled: opts.enabled ?? DEFAULTS.enabled,
      healAtPct: opts.healAtPct ?? DEFAULTS.healAtPct,
      minHealingSkill: opts.minHealingSkill ?? DEFAULTS.minHealingSkill,
      cooldownMs: opts.cooldownMs ?? DEFAULTS.cooldownMs,
    };
    this.isKit = opts.isKit || DEFAULT_IS_KIT;
    this.isFood = opts.isFood || DEFAULT_IS_FOOD;
    this.rankKit = opts.rankKit || DEFAULT_RANK_KIT;
    // Skill-sufficiency is injectable; the default reads the Healing skill.
    this.skillOk = opts.skillOk || ((h) => this._defaultSkillOk(h));
    this.now = opts.now || (() => Date.now());
    this.log = opts.log || (() => {});
    // -Infinity so the FIRST use is never spuriously gated by the cooldown,
    // regardless of the absolute clock value the host/injected now() returns.
    this.lastUseAt = -Infinity;
    this.uses = 0;
    this.lastAction = null;
    // Give-up valve state (single axis: HP).
    this._noProgress = 0;
    this._lastHpPct = -1;
    this._parkedUntil = 0;
  }

  /** Raw playerStats() snapshot (vitals.js's own read path) or null. */
  _stats() {
    try {
      const s = this.host?.s;
      if (!s || typeof s.playerStats !== "function") return null;
      return s.playerStats() || null;
    } catch {
      return null;
    }
  }

  _defaultSkillOk() {
    try {
      const ps = this._stats();
      const sk = Array.from(ps?.skills || []).map(Number);
      // Skill snapshot stride 6: [id, current, base, ranks, training, nextCost]
      // — same layout webhost.js's TryGetPlayerStats parses; mirrored here so
      // this module has exactly one parsing convention (vitals.js's), not two.
      for (let i = 0; i + 5 < sk.length; i += 6) {
        if (sk[i] === SKILL_HEALING) return sk[i + 1] >= this.cfg.minHealingSkill;
      }
      return false; // Healing skill row absent ⇒ treat as insufficient (fall to food)
    } catch {
      return false; // unknown skill ⇒ treat as insufficient (fall to food)
    }
  }

  /** Current HP percent from the raw vitals stride array, or null if unknown.
   *  Mirrors rynth/vitals.js's `_fractions()` read exactly (same source,
   *  same stride-4 [type,current,base,max] layout, same VitalType ids) —
   *  see the ACCESSOR FIX header note. */
  _hpPct() {
    try {
      const ps = this._stats();
      const v = Array.from(ps?.vitals || []).map(Number);
      for (let i = 0; i + 3 < v.length; i += 4) {
        if (v[i] !== VITAL_HEALTH) continue;
        const cur = v[i + 1];
        const max = v[i + 3];
        if (!(max > 0) || !Number.isFinite(cur)) return null;
        return (cur / max) * 100;
      }
      return null; // Health row absent from the snapshot
    } catch {
      return null;
    }
  }

  _busy() {
    try {
      const h = this.host;
      if (typeof h?.IsPlayerReady === "function" && !h.IsPlayerReady()) return true;
      if (typeof h?.GetBusyState === "function" && h.GetBusyState() !== 0) return true;
      if (typeof h?.GetCastBusyState === "function" && h.GetCastBusyState() !== 0) return true;
      return false;
    } catch {
      return true; // if we can't tell, assume busy and defer
    }
  }

  /** Best usable kit for self, or null. */
  _bestKit(rows) {
    let best = null;
    let bestRank = -Infinity;
    for (const it of rows) {
      try {
        if (it.equipMask) continue; // must be a pack item, not worn
        if (!this.isKit(it)) continue;
        const r = this.rankKit(it);
        if (r > bestRank) { bestRank = r; best = it; }
      } catch { /* one bad row must not drop the pick */ }
    }
    return best;
  }

  _firstFood(rows) {
    for (const it of rows) {
      try {
        if (it.equipMask) continue;
        if (this.isFood(it)) return it;
      } catch { /* skip bad row */ }
    }
    return null;
  }

  /** Give-up-valve bookkeeping: call once per successful heal attempt with
   *  the PRE-heal hp% (the value the decision was made on) and now(). Parks
   *  the reflex for GIVE_UP_PARK_MS once NO_PROGRESS_LIMIT uses in a row
   *  failed to move HP by MIN_PROGRESS_PCT (mirrors vitals.js's valve). */
  _trackProgress(hp, now) {
    if (this._lastHpPct >= 0 && hp <= this._lastHpPct + MIN_PROGRESS_PCT) {
      this._noProgress += 1;
      if (this._noProgress >= NO_PROGRESS_LIMIT) {
        this._parkedUntil = now + GIVE_UP_PARK_MS;
        this._noProgress = 0;
        this.log(`give up — no progress after ${NO_PROGRESS_LIMIT} uses (kit/food too weak vs. drain); parked ${GIVE_UP_PARK_MS / 1000}s`);
      }
    } else {
      this._noProgress = 0; // real progress resets the counter
    }
    this._lastHpPct = hp;
  }

  /**
   * One decision tick. `inCombat` (caller-supplied) is the combat-lock signal:
   * while locked the reflex defers to the in-combat spell loop.
   * @returns {{acted:boolean, reason?:string, action?:string, item?:object}}
   * NEVER throws — degrades to {acted:false,...} on any error.
   */
  step(inCombat = false) {
    try {
      if (!this.cfg.enabled) return { acted: false, reason: "disabled" };
      if (inCombat) return { acted: false, reason: "combat-lock" };

      const hp = this._hpPct();
      if (hp == null) return { acted: false, reason: "hp-unknown" };
      if (hp >= this.cfg.healAtPct) return { acted: false, reason: "full-hp" };

      const now = this.now();
      if (this._parkedUntil > now) return { acted: false, reason: "parked" };
      if (this._busy()) return { acted: false, reason: "busy" };

      if (now - this.lastUseAt < this.cfg.cooldownMs) return { acted: false, reason: "cooldown" };

      const h = this.host;
      // C3 shared serializer: a kit/food use occupies the same busy/cast-
      // resolution window a spell gesture does — claim the token vitals.js/
      // buff_loop.js already use before CastSpell, so an in-flight vitals or
      // buff cast is never stomped by a consumable use this tick. Degrade
      // open if the host predates the token (mirrors vitals.js/buff_loop.js).
      if (typeof h?.tryClaimCast === "function" && !h.tryClaimCast("heal_reflex")) {
        return { acted: false, reason: "cast-claimed" };
      }

      const rows = (typeof h?.TryGetPlayerInventory === "function" ? h.TryGetPlayerInventory() : null) || [];
      if (!rows.length) return { acted: false, reason: "no-inventory" };

      // Best kit first (skill-gated), else food.
      const kit = this._bestKit(rows);
      if (kit && this.skillOk(h, kit)) {
        const self = (typeof h?.GetPlayerId === "function" ? h.GetPlayerId() : 0) >>> 0;
        if (typeof h?.UseItemOnTarget !== "function") return { acted: false, reason: "unavailable" };
        const ok = h.UseItemOnTarget((kit.guid ?? 0) >>> 0, self);
        if (!ok) return { acted: false, reason: "kit-send-failed" };
        this.lastUseAt = now;
        this.uses += 1;
        this.lastAction = "kit";
        this._trackProgress(hp, now);
        this.log(`heal kit ${kit.name} (hp=${Math.round(hp)}%)`);
        return { acted: true, action: "kit", item: kit };
      }

      const food = this._firstFood(rows);
      if (food) {
        if (typeof h?.UseObject !== "function") return { acted: false, reason: "unavailable" };
        const ok = h.UseObject((food.guid ?? 0) >>> 0);
        if (!ok) return { acted: false, reason: "food-send-failed" };
        this.lastUseAt = now;
        this.uses += 1;
        this.lastAction = "food";
        this._trackProgress(hp, now);
        this.log(`heal food ${food.name} (hp=${Math.round(hp)}%${kit ? ", kit skill-insufficient" : ""})`);
        return { acted: true, action: "food", item: food };
      }

      return { acted: false, reason: "no-consumable" };
    } catch (e) {
      return { acted: false, reason: "error", error: String((e && e.message) || e) };
    }
  }

  get status() {
    const now = this.now();
    return {
      enabled: this.cfg.enabled,
      uses: this.uses,
      lastAction: this.lastAction,
      parked: this._parkedUntil > now,
    };
  }
}

export default HealReflex;
