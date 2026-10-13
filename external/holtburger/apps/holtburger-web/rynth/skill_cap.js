// rynth/skill_cap.js — "which spell tiers can this character cast?", from its
// buffed magic skill (rynth-macro-nav-4, 2026-10-13). Pure; no imports.
//
// ACE rolls every cast against the school's CURRENT (buffed) skill: below
// Power − 50 it fails outright, otherwise chance = 1/(1+e^(−0.07·(skill −
// Power))), 50 % at skill = Power (Player_Magic.cs GetCastingPreCheckStatus,
// SkillCheck.cs GetMagicSkillChance). Any trained character can learn a level
// 7/8 scroll whatever its skill (Player_Skills.cs CanReadScroll), so the
// highest KNOWN tier is routinely one it can't cast. RynthAi gates every pick
// by buffed skill instead: SpellManager.cs GetHighestSpellTier (combat,
// MinSkillLevelTier1..8) and GetHighestBuffSpellTier (self buffs and vitals,
// BuffMinSkillLevelTier1..8), both ComputeTier over eight thresholds
// (LegacyUiSettings.cs defaults 35/85/135/185/235/285/335/435).
//
// One copy of that rule: the VT attack planner (_capFn) and the opt-in cap of
// the buff and vitals loops (opts.skillCap / setSkillCap) both use it.

/** MagicSchool (1 War, 2 Life, 3 Item, 4 Creature, 5 Void) → SkillType. */
export const SCHOOL_SKILL = Object.freeze({ 1: 34, 2: 33, 3: 32, 4: 31, 5: 43 });
export const SCHOOL = Object.freeze({ War: 1, Life: 2, Item: 3, Creature: 4, Void: 5 });
/** RynthAi's MinSkillLevelTier1..8 / BuffMinSkillLevelTier1..8 defaults. */
export const TIER_DEFAULTS = Object.freeze([35, 85, 135, 185, 235, 285, 335, 435]);
const SKILL_TRAINED = 2; // SkillAdvancementClass.Trained
/** How long a host-backed cap reuses one skills read (createHostSkillCap). */
export const SKILL_CAP_REFRESH_MS = 5_000;

/** Eight thresholds read through `get(key, dflt)` (`${prefix}1` … `${prefix}8`);
 *  a missing or non-numeric value keeps its default. */
export function readTierThresholds(get, prefix) {
  return TIER_DEFAULTS.map((d, i) => Number(get(`${prefix}${i + 1}`, d)) || d);
}

/** Highest spell level one skill row ({current, base, training}) reaches:
 *  untrained → 0, unreadable → Infinity, otherwise at least 1 (ComputeTier). */
export function tierForSkill(row, tiers = TIER_DEFAULTS) {
  if (!row) return Infinity;
  if (typeof row.training === "number" && row.training < SKILL_TRAINED) return 0;
  const v = Number(row.current ?? row.base);
  if (!Number.isFinite(v)) return Infinity;
  let lvl = 0;
  for (let t = 0; t < tiers.length; t++) if (v >= tiers[t]) lvl = t + 1;
  return Math.max(1, lvl);
}

/** (school) → highest castable level, over a TryGetPlayerStats().skills map
 *  ({skillId: {current, base, training}}). Infinity when skills are unreadable. */
export function skillCapFn(skills, tiers = TIER_DEFAULTS) {
  return (school) => {
    if (!skills) return Infinity;
    const row = skills[SCHOOL_SKILL[school]] ?? skills[String(SCHOOL_SKILL[school])];
    return tierForSkill(row, tiers);
  };
}

/** The player's skills map, or null: RynthWebHost.TryGetPlayerStats() when the
 *  host has it, else the raw playerStats() box (skills stride 6: [type,
 *  current, base, ranks, training, next_cost]; the box is freed). */
export function readSkills(host) {
  if (!host) return null;
  if (typeof host.TryGetPlayerStats === "function") {
    try {
      const st = host.TryGetPlayerStats();
      const sk = st && st.skills;
      return sk && typeof sk === "object" && Object.keys(sk).length ? sk : null;
    } catch (_) {
      return null;
    }
  }
  const s = host.s;
  if (!s || typeof s.playerStats !== "function") return null;
  let ps = null;
  try {
    ps = s.playerStats();
    const a = Array.from(ps?.skills || [], Number);
    if (!a.length) return null;
    const out = {};
    for (let i = 0; i + 5 < a.length; i += 6) out[a[i]] = { current: a[i + 1], base: a[i + 2], training: a[i + 4] };
    return out;
  } catch (_) {
    return null;
  } finally {
    try {
      ps?.free?.(); // wasm box — copy-then-free (webhost.js review F6 rule)
    } catch (_) {
      /* already freed */
    }
  }
}

/**
 * A cap over the live host: `(school) → highest castable level`, re-reading the
 * skills at most every `maxAgeMs` (Focus / Willpower / a mastery landing or
 * lapsing moves them). Each read is a snapshot of the five school levels, so a
 * host handing back a live (mutated-later) stats object can't change it under
 * the loops. Infinity while the stats plane is unreadable — the loops then
 * resolve exactly as without a cap. `cap.refresh()` drops the read.
 */
export function createHostSkillCap(host, { tiers = TIER_DEFAULTS, maxAgeMs = SKILL_CAP_REFRESH_MS } = {}) {
  const t = TIER_DEFAULTS.map((d, i) => Number(tiers && tiers[i]) || d);
  let at = 0;
  let caps = null;
  const cap = (school) => {
    const now = Date.now();
    if (!caps || now - at >= maxAgeMs || now < at) {
      caps = capsBySchool(skillCapFn(readSkills(host), t));
      at = now;
    }
    const v = caps[school - 1];
    return v === undefined ? Infinity : v;
  };
  cap.refresh = () => {
    caps = null;
  };
  return cap;
}

/** [War, Life, Item, Creature, Void] caps of `cap` (index = school − 1); a
 *  throwing or non-numeric answer reads Infinity (no cap). */
export function capsBySchool(cap) {
  const out = [];
  for (let school = 1; school <= 5; school++) {
    let v = Infinity;
    try {
      const n = Number(cap(school));
      if (!Number.isNaN(n)) v = n;
    } catch (_) {
      /* no cap for this school */
    }
    out.push(v);
  }
  return out;
}

/** Did `school` (1..5) rise between two capsBySchool() reads? Only a finite →
 *  higher finite move counts: skills becoming readable is not a rise. */
export function capRose(before, after, school) {
  const a = before && before[school - 1];
  const b = after && after[school - 1];
  return Number.isFinite(a) && Number.isFinite(b) && b > a;
}

// Self-buff school by SpellCategory, for sessions without the live catalog
// (getSpellRecord). Derived from data/spells-catalog.json over the enchantment
// rows of rynth/spell_ladders.json, where every category holds ONE school
// (67 mixes Life boosts with Creature enchantments; only the enchantments are
// laddered). tests/rynth_skill_cap.test.mjs re-derives both sets. Everything
// else laddered is Creature — RynthAi BuffManager.SkillForBuff's default too.
const ITEM_CATEGORIES = new Set([152, 154, 156, 158, 195, 695]); // the Aura of … Self weapon buffs
const LIFE_CATEGORIES = new Set([
  81, 93, 95, 97, 101, 103, 105, 107, 109, 111, 113, 115, 257, 259, 273, 275, 277, 279, 281, 283, 284, 407, 448, 457,
  463, 466, 476, 479, 484, 493, 497, 502, 506, 528, 572, 573, 574, 610, 611, 612, 613, 614, 615, 620, 621, 623, 624,
  625, 626, 627, 628, 629, 633, 634, 635, 650, 651, 652, 653, 657, 658, 694, 703, 728, 729, 730, 731, 732, 733,
]);
export const BUFF_SCHOOL_CATEGORIES = Object.freeze({
  item: Object.freeze([...ITEM_CATEGORIES]),
  life: Object.freeze([...LIFE_CATEGORIES]),
});

/** MagicSchool of a self buff: the catalog record's own school (1..5) when
 *  known, else by its SpellCategory (Life / Item table, Creature otherwise). */
export function buffSchoolOf(category, recordSchool = null) {
  const r = Number(recordSchool);
  if (Number.isInteger(r) && r >= 1 && r <= 5) return r;
  const c = Number(category);
  if (ITEM_CATEGORIES.has(c)) return SCHOOL.Item;
  if (LIFE_CATEGORIES.has(c)) return SCHOOL.Life;
  return SCHOOL.Creature;
}
