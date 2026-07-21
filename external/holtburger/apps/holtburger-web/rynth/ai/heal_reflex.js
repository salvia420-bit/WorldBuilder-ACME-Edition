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
  }

  _defaultSkillOk(h) {
    try {
      const stats = h?.TryGetPlayerStats?.();
      const sk = stats?.skills?.[SKILL_HEALING];
      const cur = Number(sk?.current ?? 0);
      return cur >= this.cfg.minHealingSkill;
    } catch {
      return false; // unknown skill ⇒ treat as insufficient (fall to food)
    }
  }

  /** Current HP percent from the normalized stats plane, or null if unknown. */
  _hpPct() {
    try {
      const stats = this.host?.TryGetPlayerStats?.();
      const v = stats?.vitals?.[VITAL_HEALTH];
      if (!v) return null;
      const cur = Number(v.current);
      const max = Number(v.max);
      if (!(max > 0) || !Number.isFinite(cur)) return null;
      return (cur / max) * 100;
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
      if (this._busy()) return { acted: false, reason: "busy" };

      const now = this.now();
      if (now - this.lastUseAt < this.cfg.cooldownMs) return { acted: false, reason: "cooldown" };

      const h = this.host;
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
        this.log(`heal food ${food.name} (hp=${Math.round(hp)}%${kit ? ", kit skill-insufficient" : ""})`);
        return { acted: true, action: "food", item: food };
      }

      return { acted: false, reason: "no-consumable" };
    } catch (e) {
      return { acted: false, reason: "error", error: String((e && e.message) || e) };
    }
  }

  get status() {
    return { enabled: this.cfg.enabled, uses: this.uses, lastAction: this.lastAction };
  }
}

export default HealReflex;
