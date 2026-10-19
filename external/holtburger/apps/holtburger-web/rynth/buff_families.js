// rynth/buff_families.js — the self-buff FAMILIES the bot maintains, how a
// player sees them, and the spell_ladders.json row flags that say which
// spells are a family's normal scroll ladder (2026-10-19). Pure; no imports.
//
// A family is a SpellCategory (the B2/B4 family key, spell_ladders.json
// row[0]). The four tables are RynthAi BuffManager's own
// (CreatureSkillBuffs :250-289 and BuildDynamicBuffList :1607-1660), moved
// here from buff_loop.js (which re-exports them) so the ladder generator
// (rynth_spell_ladders_test.cjs), the bot and both pickers (HUD Settings, VT
// Buffs tab) share ONE list. One family is ours, not RynthAi's: Missile Weapon
// Mastery (2026-10-19, below) — RynthAi's AcSkillType enum has no
// MissileWeapons, so archers got no missile mastery from the dynamic list:
//   BASE_CREATURE_BUFFS [base name, category]
//   SKILL_BUFFS         [SkillType, base name, category]
//   LIFE_BUFFS          [base name, category]
//   AURA_BUFFS          [base name, category]
// The base name is the stem of the family's scroll ladder ("Strength Self" →
// "Strength Self I" … "Incantation of Strength Self"); the generator derives
// the canonical ladder from it (LADDER_FLAG_CANONICAL below).
//
// Display — buffFamilyInfo(category) → { category, base, label, group,
// groupOrder, order, school }: label "Strength" / "Heavy Weapon Mastery" /
// "Blood Drinker aura"; group one of BUFF_GROUPS (groupOrder = its index);
// order = the bot's own buff order (BUFF_FAMILY_ORDER — BuildDynamicBuffList
// with every skill usable); school = MagicSchool (4 Creature, 2 Life, 3 Item;
// tests/rynth_buff_canonical.test.mjs checks it against skill_cap.js
// buffSchoolOf).
//
// Ladder row flags (spell_ladders.json row[2]; rynth_spell_ladders_test.cjs
// documents and generates them):
//   1 SELF_TARGETED  SpellFlags 0x8 (DAT bitfield)
//   2 ENCHANTMENT    MetaSpellType 1 (lands in the enchantment registry)
//   4 CANONICAL      the family's normal scroll ladder, tiers I–VIII. Set
//                    only on rows of the families above; quest / NPC /
//                    potion / fellowship spells sharing a category (Zongo's
//                    Fist, Tusker Might, Combat Medication, Aerbax's Melee
//                    Shield, …) never carry it.
//   8 SCROLL         taught by a Scroll weenie in the ACE world database
//                    (weenie type 34, PropertyDataId 28 = Spell).
// A family with no CANONICAL row in the table (any category outside the four
// tables, or a table baked before 2026-10-19) has NO canonical data: callers
// get null from rowCanonical() and keep their pre-ladder behaviour.

// SkillType ids the dynamic list gates masteries on (ACE Skill enum).
export const SKILL = Object.freeze({
  MeleeDefense: 6, MissileDefense: 7, ArcaneLore: 14, MagicDefense: 15, ManaConversion: 16,
  ItemTinkering: 18, AssessPerson: 19, Deception: 20, Healing: 21, Jump: 22, Lockpick: 23, Run: 24,
  AssessCreature: 27, WeaponTinkering: 28, ArmorTinkering: 29, MagicItemTinkering: 30,
  CreatureEnchantment: 31, ItemEnchantment: 32, LifeMagic: 33, WarMagic: 34, Leadership: 35,
  Loyalty: 36, Fletching: 37, Alchemy: 38, Cooking: 39, Salvaging: 40, TwoHandedCombat: 41,
  VoidMagic: 43, HeavyWeapons: 44, LightWeapons: 45, FinesseWeapons: 46, MissileWeapons: 47, Shield: 48,
  DualWield: 49, Recklessness: 50, SneakAttack: 51, DirtyFighting: 52, Summoning: 54,
});

export const BASE_CREATURE_BUFFS = Object.freeze([
  ["Strength Self", 1], ["Endurance Self", 3], ["Coordination Self", 7], ["Quickness Self", 5],
  ["Focus Self", 9], ["Willpower Self", 11], ["Magic Resistance Self", 41],
  ["Invulnerability Self", 37], ["Impregnability Self", 39],
]);
// C# CreatureSkillBuffs (:250-289), insertion order: [skill, base name, category].
// + Missile Weapon Mastery (2026-10-19), after the other three weapon skills as
// ACE numbers them (Heavy 44, Light 45, Finesse 46, Missile 47): SpellCategory
// 19 (ACE SpellCategory BowRaising — the pre-2013 Bow/Crossbow/Thrown Weapon
// Mastery ladders merged; LSD spells.json category 19, StatMod key 47 =
// Skill.MissileWeapons, "Increases the caster's Missile Weapons skill") —
// Missile Weapon Mastery Self I–VII + Incantation, every tier scroll-taught.
export const SKILL_BUFFS = Object.freeze([
  [SKILL.MeleeDefense, "Invulnerability Self", 37], [SKILL.MissileDefense, "Impregnability Self", 39],
  [SKILL.MagicDefense, "Magic Resistance Self", 41], [SKILL.HeavyWeapons, "Heavy Weapon Mastery", 31],
  [SKILL.LightWeapons, "Light Weapon Mastery", 17], [SKILL.FinesseWeapons, "Finesse Weapon Mastery", 23],
  [SKILL.MissileWeapons, "Missile Weapon Mastery", 19],
  [SKILL.TwoHandedCombat, "Two Handed Combat Mastery", 593], [SKILL.Shield, "Shield Mastery", 674],
  [SKILL.DualWield, "Dual Wield Mastery", 668], [SKILL.Recklessness, "Recklessness Mastery", 671],
  [SKILL.SneakAttack, "Sneak Attack Mastery", 677], [SKILL.DirtyFighting, "Dirty Fighting Mastery", 665],
  [SKILL.AssessCreature, "Monster Attunement", 63], [SKILL.AssessPerson, "Person Attunement", 205],
  [SKILL.ArcaneLore, "Arcane Enlightenment", 53], [SKILL.ArmorTinkering, "Armor Tinkering Expertise", 55],
  [SKILL.ItemTinkering, "Item Tinkering Expertise", 57], [SKILL.MagicItemTinkering, "Magic Item Tinkering Expertise", 59],
  [SKILL.WeaponTinkering, "Weapon Tinkering Expertise", 61], [SKILL.Salvaging, "Arcanum Salvaging", 435],
  [SKILL.Run, "Sprint", 77], [SKILL.Jump, "Jumping Mastery", 69], [SKILL.Loyalty, "Fealty", 75],
  [SKILL.Leadership, "Leadership Mastery", 71], [SKILL.Deception, "Deception Mastery", 65],
  [SKILL.Healing, "Healing Mastery", 67], [SKILL.Lockpick, "Lockpick Mastery", 73],
  [SKILL.Cooking, "Cooking Mastery", 216], [SKILL.Fletching, "Fletching Mastery", 218],
  [SKILL.Alchemy, "Alchemy Mastery", 221], [SKILL.ManaConversion, "Mana Conversion Mastery", 51],
  [SKILL.CreatureEnchantment, "Creature Enchantment Mastery", 43], [SKILL.ItemEnchantment, "Item Enchantment Mastery", 45],
  [SKILL.LifeMagic, "Life Magic Mastery", 47], [SKILL.WarMagic, "War Magic Mastery", 49],
  [SKILL.VoidMagic, "Void Magic Mastery", 645], [SKILL.Summoning, "Summoning Mastery", 696],
]);
export const LIFE_BUFFS = Object.freeze([
  ["Regeneration Self", 93], ["Rejuvenation Self", 95], ["Mana Renewal Self", 97], ["Armor Self", 115],
  ["Acid Protection Self", 101], ["Fire Protection Self", 109], ["Cold Protection Self", 105],
  ["Lightning Protection Self", 107], ["Blade Protection Self", 113], ["Piercing Protection Self", 111],
  ["Bludgeoning Protection Self", 103],
]);
export const AURA_BUFFS = Object.freeze([
  ["Aura of Blood Drinker Self", 154], ["Aura of Hermetic Link Self", 195], ["Aura of Heart Seeker Self", 152],
  ["Aura of Spirit Drinker Self", 695], ["Aura of Swift Killer Self", 158], ["Aura of Defender Self", 156],
]);

/** The Settings / Buffs-tab group headings, in display order (groupOrder = index). */
export const BUFF_GROUPS = Object.freeze(["Attributes", "Defenses", "Masteries", "Regeneration", "Protections", "Weapon auras"]);
const DEFENSE_CATS = new Set([37, 39, 41]); // Invulnerability, Impregnability, Magic Resistance
const REGEN_CATS = new Set([93, 95, 97]); // Regeneration, Rejuvenation, Mana Renewal
const GROUP_SCHOOL = Object.freeze({ Attributes: 4, Defenses: 4, Masteries: 4, Regeneration: 2, Protections: 2, "Weapon auras": 3 });

// "Strength Self" → "Strength"; "Aura of Blood Drinker Self" → "Blood Drinker aura".
function labelOf(base) {
  const s = String(base).replace(/ Self$/, "");
  const m = /^Aura of (.+)$/.exec(s);
  return m ? `${m[1]} aura` : s;
}

/** Every family category in the bot's own buff order: BuildDynamicBuffList
 *  with every skill usable — Creature Enchantment Mastery, Focus, Willpower,
 *  the other creature buffs, the masteries, life, weapon auras. */
export const BUFF_FAMILY_ORDER = (() => {
  const out = [];
  const push = (c) => {
    if (!out.includes(c)) out.push(c);
  };
  push(43);
  push(9);
  push(11);
  for (const [, c] of BASE_CREATURE_BUFFS) push(c);
  for (const [, , c] of SKILL_BUFFS) push(c);
  for (const [, c] of LIFE_BUFFS) push(c);
  for (const [, c] of AURA_BUFFS) push(c);
  return Object.freeze(out);
})();

const FAMILY_INFO = (() => {
  const m = new Map();
  const add = (category, base, group) => {
    if (m.has(category)) return; // base tables first: 37/39/41 stay Defenses
    m.set(category, Object.freeze({
      category,
      base,
      label: labelOf(base),
      group,
      groupOrder: BUFF_GROUPS.indexOf(group),
      order: BUFF_FAMILY_ORDER.indexOf(category),
      school: GROUP_SCHOOL[group],
    }));
  };
  for (const [base, c] of BASE_CREATURE_BUFFS) add(c, base, DEFENSE_CATS.has(c) ? "Defenses" : "Attributes");
  for (const [, base, c] of SKILL_BUFFS) add(c, base, "Masteries");
  for (const [base, c] of LIFE_BUFFS) add(c, base, REGEN_CATS.has(c) ? "Regeneration" : "Protections");
  for (const [base, c] of AURA_BUFFS) add(c, base, "Weapon auras");
  return m;
})();

/** One family's display info, or null for a category the bot doesn't maintain:
 *  { category, base, label, group, groupOrder, order, school }. */
export function buffFamilyInfo(category) {
  return FAMILY_INFO.get(Number(category)) ?? null;
}

/** Every family the bot maintains, in BUFF_FAMILY_ORDER (info objects). */
export function buffFamilies() {
  return BUFF_FAMILY_ORDER.map((c) => FAMILY_INFO.get(c));
}

// ── spell_ladders.json rows ────────────────────────────────────────────────
export const LADDER_FLAG_SELF_TARGETED = 1;
export const LADDER_FLAG_ENCHANTMENT = 2;
export const LADDER_FLAG_CANONICAL = 4;
export const LADDER_FLAG_SCROLL = 8;
export const ROMAN = Object.freeze(["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"]);

const flagsOf = (row) => (Array.isArray(row) && row.length > 2 ? Number(row[2]) || 0 : null);

/** Does the row land in the enchantment registry? A pre-2026-10-12 two-field
 *  row (no flags) counts as one. */
export function rowIsEnchantment(row) {
  const f = flagsOf(row);
  return f == null ? Array.isArray(row) : (f & LADDER_FLAG_ENCHANTMENT) !== 0;
}

// Per-table index (the table object is loaded once and never mutated):
// families with canonical data, and each family's canonical rows.
const INDEX = new WeakMap();
const EMPTY_INDEX = Object.freeze({ canonFamilies: new Set(), ladders: new Map() });
function ladderIndex(ladder) {
  if (!ladder || typeof ladder !== "object") return EMPTY_INDEX;
  let ix = INDEX.get(ladder);
  if (ix) return ix;
  const ladders = new Map(); // category -> [{ id, tier, power, scroll }]
  for (const [key, row] of Object.entries(ladder)) {
    const f = flagsOf(row);
    if (f == null || !(f & LADDER_FLAG_CANONICAL)) continue;
    if (!ladders.has(row[0])) ladders.set(row[0], []);
    ladders.get(row[0]).push({ id: Number(key) >>> 0, tier: Number(row[1]) || 0, power: Number(row[3]) || 0, scroll: (f & LADDER_FLAG_SCROLL) !== 0 });
  }
  for (const list of ladders.values()) list.sort((a, b) => a.tier - b.tier || rungOrder(a, b));
  ix = { canonFamilies: new Set(ladders.keys()), ladders };
  INDEX.set(ladder, ix);
  return ix;
}

/** Same-tier preference: higher Power (ACE's stacking winner), then the copy
 *  a scroll teaches, then the lower id — deterministic for the same-name
 *  duplicates (five "Light Weapon Mastery Self VII" ids). */
export function rungOrder(a, b) {
  return (b.power || 0) - (a.power || 0) || (b.scroll ? 1 : 0) - (a.scroll ? 1 : 0) || a.id - b.id;
}

/** true / false: is this row on its family's normal scroll ladder? null when
 *  the table has no canonical data for the row's family (outside the four
 *  tables, or an older table) — callers then keep their old behaviour. */
export function rowCanonical(row, ladder) {
  const f = flagsOf(row);
  if (f == null || !ladderIndex(ladder).canonFamilies.has(row[0])) return null;
  return (f & LADDER_FLAG_CANONICAL) !== 0;
}

/** Does the table carry canonical data for `category`? */
export function familyHasCanonical(category, ladder) {
  return ladderIndex(ladder).canonFamilies.has(Number(category));
}

/** A family's canonical rows, ascending by tier ([{ id, tier, power, scroll }],
 *  same-tier copies in rungOrder); [] without canonical data. A copy. */
export function canonicalLadderOf(category, ladder) {
  const list = ladderIndex(ladder).ladders.get(Number(category));
  return list ? list.map((r) => ({ ...r })) : [];
}

/** category -> the best KNOWN canonical row of each family ({ id, tier, power,
 *  scroll }: highest tier, then rungOrder). Families without canonical data
 *  (an older table) fall back to their best known enchantment, as before
 *  2026-10-19; a family with canonical data but none of it known is absent. */
export function bestKnownByFamily(knownIds, ladder) {
  const out = new Map();
  if (!ladder || typeof ladder !== "object") return out;
  for (const raw of knownIds || []) {
    const id = Number(raw) >>> 0;
    const row = ladder[String(id)];
    if (!row || !rowIsEnchantment(row)) continue;
    if (rowCanonical(row, ladder) === false) continue; // off the scroll ladder
    const f = flagsOf(row) ?? 0;
    const cand = { id, tier: Number(row[1]) || 0, power: Number(row[3]) || 0, scroll: (f & LADDER_FLAG_SCROLL) !== 0 };
    const cur = out.get(row[0]);
    if (!cur || cand.tier > cur.tier || (cand.tier === cur.tier && rungOrder(cand, cur) < 0)) out.set(row[0], cand);
  }
  return out;
}
