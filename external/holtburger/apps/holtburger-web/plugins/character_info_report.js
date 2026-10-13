// Character Information report — the text of retail gmCharacterInfoUI
// (element class 0x1000001A, one scrolling UIElement_Text 0x1000011D),
// re-derived from acclient.c. Pure: no DOM, no wasm — the character pane
// (plugins/character-info.js, "Info" tab) supplies the reads.
//
// gmCharacterInfoUI::Update (acclient.c:237658) clears the text, then
// appends, with a literal "\n" StringInfo between each section:
//   UpdatePlayerBirthAgeDeaths (:236632) — "born on" (PropertyInt 98
//     CreationTimestamp, strftime "%c" under setlocale(0, "English")),
//     "played for" (125 Age, TimeUtils::QueryDuration), deaths (43:
//     None / One / Two / Many). Born and played only when the int is present.
//   UpdateEnduranceInfo (:236715) — Natural / Drain Resistances from RAW
//     (InqAttribute(.., raw=1)) Str+End, Regeneration Bonus from Str+2·End.
//   UpdateInnateAttributeInfo (:236475) — the six Attribute._init_level
//     values, Str / End / Coord / Quick / Focus / Self.
//   UpdateFakeSkills (:236506) — Chess Rank (181, default 1400) and Fishing
//     Skill (192, default 0), always shown.
//   UpdateAugmentations (:236813) — melee / ranged / summoning mastery (354 /
//     355 / 362, client literals), the Luminance header (always), the
//     luminance auras, then every gem augmentation the player owns.
//   UpdateLoad (:236530) — not overburdened, or "N burden units … by P%"
//     (EncumbranceSystem::EncumbranceCapacity :296731 / Load / LoadMod with
//     the BUFFED strength, as CACQualities::InqLoad), plus the Might of the
//     Seventh Mule line when PropertyInt 230 > 0.
//
// Every line is a StringInfo template in StringTable 0x23000001 (table enum
// 0x10000001, client_local_English.dat). The wasm `fetch_string_table`
// export keeps only a template's FIRST fragment, so the English templates are
// embedded below verbatim: the fragments as the DAT stores them (`\n` is the
// DAT's literal two-character escape) and, per token, the values in the
// order the template's variable list names them.

/** StringTable holding the ID_CharacterInfo_* templates (table enum 0x10000001). */
export const CHARACTER_INFO_STRING_TABLE = 0x23000001;

// ─── Templates (StringTable 0x23000001, client_local_English.dat) ────────

const AUG_TIMES = " {time[1]|times}.\\n\\n";

/**
 * token → fragments. frag[0] + v[0] + frag[1] + v[1] + … + frag[n]; a
 * `{a[1]|b}` selector picks `a` when the value before it is 1.
 */
export const CHARACTER_INFO_TEMPLATES = Object.freeze({
  ID_CharacterInfo_Birth: ["You were born on ", ".\\n"],
  ID_CharacterInfo_Played: ["You have played for ", ".\\n"],
  ID_CharacterInfo_Deaths_None: ["You have never died!\\n"],
  ID_CharacterInfo_Deaths_One: ["You have died only once!\\n"],
  ID_CharacterInfo_Deaths_Two: ["You have died twice.\\n"],
  ID_CharacterInfo_Deaths_Many: ["You have died ", " times.\\n"],
  // Variables RESIST, RESIST, REGEN — both resistance lines show one tier.
  ID_CharacterInfo_Resists: ["Natural Resistances: ", "\\nDrain Resistances: ", "\\nRegeneration Bonus: ", "\\n"],
  ID_CharacterInfo_Innates: [
    "Innate Strength: ", "\\nInnate Endurance: ", "\\nInnate Coordination: ",
    "\\nInnate Quickness: ", "\\nInnate Focus: ", "\\nInnate Self: ", "\\n",
  ],
  ID_CharacterInfo_Chess: ["Chess Rank: ", "\\n"],
  ID_CharacterInfo_Fishing: ["Fishing Skill: ", "\\n"],
  ID_CharacterInfo_Mastery_Melee: ["Your melee mastery is ", ".\\n"],
  ID_CharacterInfo_Mastery_Ranged: ["Your ranged mastery is ", ".\\n\\n"],
  ID_CharacterInfo_Mastery_Summoning: ["Your summoning mastery is ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Header: ["Luminance Augmentations:\\n\\n"],
  ID_CharacterInfo_Luminance_Base_Damage: ["Aura of Valor. Your Damage Rating is increased by ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Spec_Damage: ["Aura of Destruction. Your Seer grants you an increase to Damage Rating of ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Base_Reduction: ["Aura of Protection. Your Damage Reduction Rating is increased by ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Spec_Reduction: ["Aura of Invulnerability. Your Seer grants you an increase to Damage Reduction Rating of ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Base_Crit_Damage: ["Aura of Glory. Your Critical Damage Rating is increased by ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Spec_Crit_Damage: ["Aura of Retribution. Your Seer grants you an increase to Critical Damage Rating of ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Base_Crit_Reduction: ["Aura of Temperance. Your Critical Damage Reduction Rating is increased by ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Spec_Crit_Reduction: ["Aura of Hardening. Your Seer grants you an increase to Critical Damage Reduction Rating of ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Base_Surge_Chance: ["Aura of Aetheric Vision. Your Aetheria's chance to surge is increased by a rating of ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Base_Mana_Use: ["Aura of Mana Flow. The mana consumption of your items is decreased by a rating of ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Base_Mana_Gain: ["Aura of Mana Infusion. The mana provide by Mana Stones is increased by a rating of ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Base_Healing: ["Aura of Purity. Healing effects upon you are increased by a rating of ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Base_Skilled_Craft: ["Aura of the Craftsman. The skill level of your tinkering skills when crafting is increased by ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Spec_Skilled_Spec: ["Aura of the Specialist. Your Seer grants you an increase to all Specialized skills of ", ".\\n\\n"],
  ID_CharacterInfo_Luminance_Base_All_Skills: ["Aura of the World. The base values of all your skills are increased by ", ".\\n\\n"],
  ID_CharacterInfo_Augmentation_Attribute_Strength: ["You have augmented your Innate Strength ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Attribute_Endurance: ["You have augmented your Innate Endurance ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Attribute_Coordination: ["You have augmented your Innate Coordination ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Attribute_Quickness: ["You have augmented your Innate Quickness ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Attribute_Focus: ["You have augmented your Innate Focus ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Attribute_Self: ["You have augmented your Innate Self ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Resist_Slash: ["You have augmented your Slashing Resistance ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Resist_Pierce: ["You have augmented your Piercing Resistance ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Resist_Blunt: ["You have augmented your Bludgeoning Resistance ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Resist_Acid: ["You have augmented your Acid Resistance ", AUG_TIMES],
  // Not in the EoR DAT (the client asks for it, the table has no entry);
  // worded like its siblings so a Nether augmentation still shows.
  ID_CharacterInfo_Augmentation_Resist_Nether: ["You have augmented your Nether Resistance ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Resist_Fire: ["You have augmented your Fire Resistance ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Resist_Frost: ["You have augmented your Cold Resistance ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Resist_Lightning: ["You have augmented your Electric Resistance ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Spec_Salvaging: ["You have specialized Salvaging using the Ciandra's Essence Augmentation Gem.\\n\\n"],
  ID_CharacterInfo_Augmentation_Spec_ItemTinkering: ["You have specialized Item Tinkering using the Yoshi's Essence Augmentation Gem.\\n\\n"],
  ID_CharacterInfo_Augmentation_Spec_ArmorTinkering: ["You have specialized Armor Tinkering using the Jibril's Essence Augmentation Gem.\\n\\n"],
  ID_CharacterInfo_Augmentation_Spec_MagicItemTinkering: ["You have specialized Magic Item Tinkering using the Celdiseth's Essence Augmentation Gem.\\n\\n"],
  ID_CharacterInfo_Augmentation_Spec_WeaponTinkering: ["You have specialized Weapon Tinkering using the Koga's Essence Augmentation Gem.\\n\\n"],
  ID_CharacterInfo_Augmentation_Spec_Gearcraft: ["You have specialized Gearcraft using the Tristra's Essence Augmentation Gem.\\n\\n"],
  ID_CharacterInfo_Augmentation_ExtraPackSlot: ["You have augmented your pack-carrying capacity.\\n\\n"],
  ID_CharacterInfo_Augmentation_IncreasedCarryingCapacity: ["You have augmented your burden-bearing ability ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_LessDeathItemLoss: ["You drop fewer items on death than normal. You have augmented yourself in this way ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_SpellsRemainPastDeath: ["You have augmented your ability to maintain spells through death. Spells that were cast on you prior to death will remain in effect when you resurrect at your Lifestone. Spells will still expire on death if you are killed in a PK battle. Spells will remain if you are killed in PKLite.\\n\\n"],
  ID_CharacterInfo_Augmentation_CriticalDefense: ["You have augmented your ability to avoid critical hits. With this augmentation, 25% of critical hits from creatures and 5% of critical hits from players will strike you for normal damage.\\n\\n"],
  ID_CharacterInfo_Augmentation_BonusXP: ["You have augmented your ability to learn from your experiences. You earn 5% extra experience for each creature you kill. This does not affect experience received from quests or killing other players. This extra experience is shared with Fellowships and Allegiances as normal.\\n\\n"],
  ID_CharacterInfo_Augmentation_BonusSalvage: ["You have augmented your ability to salvage items ", " {time[1]|times}. You now receive more material each time you salvage an item.\\n\\n"],
  ID_CharacterInfo_Augmentation_BonusImbueChance: ["You have augmented your ability to perform imbues. You now have a 5% better chance to succeed on imbue craft interactions.\\n\\n"],
  ID_CharacterInfo_Augmentation_FasterRegen: ["You have augmented your Health, Stamina, and Mana regeneration rate ", " {time[1]|times}. Your secondary attributes regenerate much faster while lying down.\\n\\n"],
  ID_CharacterInfo_Augmentation_IncreasedSpellDuration: ["You have augmented the duration of the spells you cast ", AUG_TIMES],
  ID_CharacterInfo_Augmentation_Infused_CreatureMagic: ["You earned the Infused Creature Magic augmentation. You no longer need foci to cast Creature Magic spells.\\n\\n"],
  ID_CharacterInfo_Augmentation_Infused_ItemMagic: ["You earned the Infused Item Magic augmentation. You no longer need foci to cast Item Magic spells.\\n\\n"],
  ID_CharacterInfo_Augmentation_Infused_LifeMagic: ["You earned the Infused Life Magic augmentation. You no longer need foci to cast Life Magic spells.\\n\\n"],
  ID_CharacterInfo_Augmentation_Infused_WarMagic: ["You earned the Infused War Magic augmentation. You no longer need foci to cast War Magic spells.\\n\\n"],
  ID_CharacterInfo_Augmentation_Infused_VoidMagic: ["You earned the Infused Void Magic augmentation. You no longer need foci to cast Void Magic spells.\\n\\n"],
  ID_CharacterInfo_Augmentation_SkilledMelee: ["You earned the Master of the Steel Circle augmentation. Your effective melee weapon skills are increased by 10.\\n\\n"],
  ID_CharacterInfo_Augmentation_SkilledMissile: ["You earned the Master of the Focused Eye augmentation. Your effective missile weapon skills are increased by 10.\\n\\n"],
  ID_CharacterInfo_Augmentation_SkilledMagic: ["You earned the Master of the Five Fold Path augmentation. Your effective magic skills are increased by 10.\\n\\n"],
  ID_CharacterInfo_Augmentation_DamageBonus: ["You earned the Frenzy of the Slayer augmentation. Your damage rating with weapons and spells is increased by 3.\\n\\n"],
  ID_CharacterInfo_Augmentation_DamageResist: ["You earned the Iron Skin of the Invincible augmentation. Your damage resistance rating is increased by 3.\\n\\n"],
  ID_CharacterInfo_Augmentation_CriticalExpertise: ["You earned the Eye of the Remorseless augmentation. Your chance to deliver a critical strike with weapons and spells is increased by 1%.\\n\\n"],
  ID_CharacterInfo_Augmentation_CriticalPower: ["You earned the Hand of the Remorseless augmentation. The damage rating of your critical strikes with weapons and spells is increased by 3.\\n\\n"],
  ID_CharacterInfo_Augmentation_JackOfAllTrades: ["You earned the Jack of All Trades augmentation. All your effective skills are increased by 5.\\n\\n"],
  ID_CharacterInfo_Load_None: ["You are not overburdened at this time.\\n"],
  ID_CharacterInfo_Load_Burdened: ["You are currently overburdened by ", " burden units. This is reducing your Run, Jump, Melee Defense and Missile Defense skills by ", "%.\\n"],
  ID_CharacterInfo_Load_Augmentations: ["You have been augmented ", " times with the Might of the Seventh Mule. This has increased your carrying capacity by ", "%.\\n"],
});

// ─── PropertyInt ids (ACE PropertyInt / holtburger-common ints.rs) ───────

const P = Object.freeze({
  EncumbranceVal: 5,
  NumDeaths: 43,
  CreationTimestamp: 98,
  Age: 125,
  ChessRank: 181,
  FakeFishingSkill: 192,
  AugmentationIncreasedCarryingCapacity: 230,
  MeleeMastery: 354,
  RangedMastery: 355,
  SummoningMastery: 362,
});

// UpdateAugmentations' own literals (its mastery switch tables; any other
// value prints "Unknown").
const MELEE_MASTERY = Object.freeze({
  1: "Unarmed Weapons", 2: "Swords", 3: "Axes", 4: "Maces", 5: "Spears",
  6: "Daggers", 7: "Staves", 11: "Two Handed Weapons",
});
const RANGED_MASTERY = Object.freeze({ 8: "Bows", 9: "Crossbows", 10: "Thrown Weapons", 12: "Magical Spells" });
const SUMMONING_MASTERY = Object.freeze({ 1: "Primalist", 2: "Necromancer", 3: "Naturalist" });

// Luminance auras, in emit order. `split`: a rating above 5 shows the base
// line with 5 and the Seer "spec" line with the remainder. `mult`: the value
// the line prints is rating × mult.
const LUMINANCE_AURAS = Object.freeze([
  { id: 333, base: "ID_CharacterInfo_Luminance_Base_Damage", spec: "ID_CharacterInfo_Luminance_Spec_Damage" },
  { id: 334, base: "ID_CharacterInfo_Luminance_Base_Reduction", spec: "ID_CharacterInfo_Luminance_Spec_Reduction" },
  { id: 335, base: "ID_CharacterInfo_Luminance_Base_Crit_Damage", spec: "ID_CharacterInfo_Luminance_Spec_Crit_Damage" },
  { id: 336, base: "ID_CharacterInfo_Luminance_Base_Crit_Reduction", spec: "ID_CharacterInfo_Luminance_Spec_Crit_Reduction" },
  { id: 338, base: "ID_CharacterInfo_Luminance_Base_Surge_Chance" },
  { id: 339, base: "ID_CharacterInfo_Luminance_Base_Mana_Use", mult: 5 },
  { id: 340, base: "ID_CharacterInfo_Luminance_Base_Mana_Gain", mult: 5 },
  { id: 342, base: "ID_CharacterInfo_Luminance_Base_Healing" },
  { id: 343, base: "ID_CharacterInfo_Luminance_Base_Skilled_Craft" },
  { id: 344, base: "ID_CharacterInfo_Luminance_Spec_Skilled_Spec", mult: 2 },
  { id: 365, base: "ID_CharacterInfo_Luminance_Base_All_Skills" },
].map((a) => Object.freeze(a)));

// Gem augmentations [PropertyInt, token], in UpdateAugmentations' emit order
// (note Nether 327 between Acid and Fire, Gearcraft 293 after the four
// tinkering specs, Void 328 after War).
export const GEM_AUGMENTATIONS = Object.freeze([
  [218, "ID_CharacterInfo_Augmentation_Attribute_Strength"],
  [219, "ID_CharacterInfo_Augmentation_Attribute_Endurance"],
  [220, "ID_CharacterInfo_Augmentation_Attribute_Coordination"],
  [221, "ID_CharacterInfo_Augmentation_Attribute_Quickness"],
  [222, "ID_CharacterInfo_Augmentation_Attribute_Focus"],
  [223, "ID_CharacterInfo_Augmentation_Attribute_Self"],
  [240, "ID_CharacterInfo_Augmentation_Resist_Slash"],
  [241, "ID_CharacterInfo_Augmentation_Resist_Pierce"],
  [242, "ID_CharacterInfo_Augmentation_Resist_Blunt"],
  [243, "ID_CharacterInfo_Augmentation_Resist_Acid"],
  [327, "ID_CharacterInfo_Augmentation_Resist_Nether"],
  [244, "ID_CharacterInfo_Augmentation_Resist_Fire"],
  [245, "ID_CharacterInfo_Augmentation_Resist_Frost"],
  [246, "ID_CharacterInfo_Augmentation_Resist_Lightning"],
  [224, "ID_CharacterInfo_Augmentation_Spec_Salvaging"],
  [225, "ID_CharacterInfo_Augmentation_Spec_ItemTinkering"],
  [226, "ID_CharacterInfo_Augmentation_Spec_ArmorTinkering"],
  [227, "ID_CharacterInfo_Augmentation_Spec_MagicItemTinkering"],
  [228, "ID_CharacterInfo_Augmentation_Spec_WeaponTinkering"],
  [293, "ID_CharacterInfo_Augmentation_Spec_Gearcraft"],
  [229, "ID_CharacterInfo_Augmentation_ExtraPackSlot"],
  [230, "ID_CharacterInfo_Augmentation_IncreasedCarryingCapacity"],
  [231, "ID_CharacterInfo_Augmentation_LessDeathItemLoss"],
  [232, "ID_CharacterInfo_Augmentation_SpellsRemainPastDeath"],
  [233, "ID_CharacterInfo_Augmentation_CriticalDefense"],
  [234, "ID_CharacterInfo_Augmentation_BonusXP"],
  [235, "ID_CharacterInfo_Augmentation_BonusSalvage"],
  [236, "ID_CharacterInfo_Augmentation_BonusImbueChance"],
  [237, "ID_CharacterInfo_Augmentation_FasterRegen"],
  [238, "ID_CharacterInfo_Augmentation_IncreasedSpellDuration"],
  [294, "ID_CharacterInfo_Augmentation_Infused_CreatureMagic"],
  [295, "ID_CharacterInfo_Augmentation_Infused_ItemMagic"],
  [296, "ID_CharacterInfo_Augmentation_Infused_LifeMagic"],
  [297, "ID_CharacterInfo_Augmentation_Infused_WarMagic"],
  [328, "ID_CharacterInfo_Augmentation_Infused_VoidMagic"],
  [300, "ID_CharacterInfo_Augmentation_SkilledMelee"],
  [301, "ID_CharacterInfo_Augmentation_SkilledMissile"],
  [302, "ID_CharacterInfo_Augmentation_SkilledMagic"],
  [309, "ID_CharacterInfo_Augmentation_DamageBonus"],
  [310, "ID_CharacterInfo_Augmentation_DamageResist"],
  [298, "ID_CharacterInfo_Augmentation_CriticalExpertise"],
  [299, "ID_CharacterInfo_Augmentation_CriticalPower"],
  [326, "ID_CharacterInfo_Augmentation_JackOfAllTrades"],
].map((r) => Object.freeze(r)));

// ─── StringInfo rendering ────────────────────────────────────────────────

/** `{a[1]|b}` → a when `value` is exactly 1, else b. */
function applyPlural(text, value) {
  return text.replace(/\{([^{}[\]|]*)\[1\]\|([^{}]*)\}/g, (_m, one, many) => (Number(value) === 1 ? one : many));
}

/**
 * Minimal StringInfo substitution: frag[0] + v[0] + frag[1] + … + frag[n],
 * each fragment's plural selector resolved against the value before it, and
 * the DAT's literal `\n` turned into a newline. A template with no variables
 * ignores `values`.
 */
export function renderTemplate(fragments, values = []) {
  if (!Array.isArray(fragments) || fragments.length === 0) return "";
  let out = "";
  for (let i = 0; i < fragments.length; i++) {
    let frag = String(fragments[i] ?? "");
    if (i > 0) frag = applyPlural(frag, values[i - 1]);
    out += frag;
    if (i < fragments.length - 1 && i < values.length) out += String(values[i]);
  }
  return out.replace(/\\n/g, "\n");
}

// ─── Retail helpers ──────────────────────────────────────────────────────

/** UpdateEnduranceInfo resistance tier from RAW Str + End. */
export function resistTier(sum) {
  const v = Number(sum) >>> 0;
  if (v > 0x1B8) return "Indomitable";
  if (v > 0x17C) return "Resilient";
  if (v > 0x140) return "Hardy";
  if (v > 0x104) return "Mediocre";
  if (v > 0xC8) return "Poor";
  return "None";
}

/** UpdateEnduranceInfo regeneration tier from RAW Str + 2·End (690 itself is Resilient). */
export function regenTier(sum) {
  const v = Number(sum) >>> 0;
  if (v > 0x2B2) return "Indomitable";
  if (v > 0x244) return "Resilient";
  if (v > 0x1D6) return "Hardy";
  if (v > 0x15A) return "Mediocre";
  if (v > 0xC8) return "Poor";
  return "None";
}

/** EncumbranceSystem::EncumbranceCapacity (acclient.c:296731): 150·Str + Str·min(30·augs, 150). */
export function encumbranceCapacity(strength, augs) {
  const s = Math.trunc(Number(strength) || 0);
  if (s <= 0) return 0;
  const bonus = 30 * Math.trunc(Number(augs) || 0);
  return bonus >= 0 ? 150 * s + s * Math.min(bonus, 150) : 150 * s;
}

/** EncumbranceSystem::Load (:296758) — 3.0 with no capacity, kept as the retail float. */
export function encumbranceLoad(capacity, encumbVal) {
  if (!(capacity > 0)) return 3.0;
  return Math.fround(encumbVal >= 0 ? encumbVal / capacity : 0.0);
}

/** EncumbranceSystem::LoadMod (:296777). */
export function loadMod(load) {
  if (load < 1.0) return 1.0;
  return load >= 2.0 ? 0.0 : 2.0 - load;
}

/**
 * TimeUtils::QueryDuration (acclient.c:667510) through ID_DurationFormat
 * (StringTable 0x23000006): years (365 d), months (30 d), weeks, days,
 * hours, minutes, seconds; zero units are blank, the rest "N unit(s)". The
 * template's separators leave a leading space when the year is blank; it is
 * trimmed here.
 */
export function formatDuration(seconds) {
  let t = Number(seconds) >>> 0;
  const units = [[31536000, "year"], [2592000, "month"], [604800, "week"],
    [86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]];
  const parts = [];
  for (const [size, name] of units) {
    const n = Math.floor(t / size);
    t -= n * size;
    if (n) parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
  }
  return parts.join(" ");
}

/**
 * strftime("%c") under the client's setlocale(0, "English") (acclient.c:63404)
 * — the English (United States) short date + long time, local clock:
 * "10/12/2026 4:48:08 PM" (cross-checked with WebAC
 * packages/renderer/src/utils/formatAcTime.ts, AGPL-3.0).
 */
export function formatRetailDateTime(unixSeconds) {
  const d = new Date(Number(unixSeconds) * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  const h = d.getHours();
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h % 12 || 12}:${two(d.getMinutes())}:${two(d.getSeconds())} ${h < 12 ? "AM" : "PM"}`;
}

// ─── Report ──────────────────────────────────────────────────────────────

function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The report as retail appends it: `[{ token, text }]`, one entry per
 * AppendStringInfo (`token: null` for the "\n" between sections).
 *
 * `src`:
 *   int(id)        local-player PropertyInt, null/undefined when absent
 *   rawAttr(id)    unbuffed attribute (init + ranks), id 1..6
 *   innateAttr(id) the creation value (_init_level)
 *   attr(id)       buffed attribute (load uses the buffed Strength)
 *   str?(token, values) optional resolver → rendered text, or null to use
 *                  the embedded template
 *   formatDate?(unixSeconds) optional, defaults to formatRetailDateTime
 */
export function buildCharacterInfoReport(src = {}) {
  const int = (id) => num(typeof src.int === "function" ? src.int(id) : null);
  const rawAttr = (id) => num(typeof src.rawAttr === "function" ? src.rawAttr(id) : null) ?? 0;
  const innateAttr = (id) => num(typeof src.innateAttr === "function" ? src.innateAttr(id) : null) ?? 0;
  const out = [];
  const addLine = (token, values = []) => {
    let text = null;
    if (typeof src.str === "function") {
      try { text = src.str(token, values); } catch (_) { text = null; }
    }
    if (typeof text !== "string") text = renderTemplate(CHARACTER_INFO_TEMPLATES[token], values);
    out.push({ token, text });
  };
  const space = () => out.push({ token: null, text: "\n" });

  // UpdatePlayerBirthAgeDeaths.
  const born = int(P.CreationTimestamp);
  if (born !== null) {
    const fmt = typeof src.formatDate === "function" ? src.formatDate : formatRetailDateTime;
    addLine("ID_CharacterInfo_Birth", [fmt(born)]);
  }
  const age = int(P.Age);
  if (age !== null) addLine("ID_CharacterInfo_Played", [formatDuration(age)]);
  const deaths = (int(P.NumDeaths) ?? 0) >>> 0;
  if (deaths === 0) addLine("ID_CharacterInfo_Deaths_None");
  else if (deaths === 1) addLine("ID_CharacterInfo_Deaths_One");
  else if (deaths === 2) addLine("ID_CharacterInfo_Deaths_Two");
  else addLine("ID_CharacterInfo_Deaths_Many", [deaths]);
  space();

  // UpdateEnduranceInfo — RAW (unbuffed) Strength / Endurance.
  const str = rawAttr(1) >>> 0;
  const end = rawAttr(2) >>> 0;
  const resist = resistTier(str + end);
  addLine("ID_CharacterInfo_Resists", [resist, resist, regenTier(str + 2 * end)]);
  space();

  // UpdateInnateAttributeInfo — Str, End, Coord (4), Quick (3), Focus, Self.
  addLine("ID_CharacterInfo_Innates", [1, 2, 4, 3, 5, 6].map(innateAttr));
  space();

  // UpdateFakeSkills.
  addLine("ID_CharacterInfo_Chess", [int(P.ChessRank) ?? 1400]);
  addLine("ID_CharacterInfo_Fishing", [int(P.FakeFishingSkill) ?? 0]);
  space();

  // UpdateAugmentations — masteries, the luminance block, gem augmentations.
  const melee = int(P.MeleeMastery) ?? 0;
  if (melee > 0) addLine("ID_CharacterInfo_Mastery_Melee", [MELEE_MASTERY[melee] ?? "Unknown"]);
  const ranged = int(P.RangedMastery) ?? 0;
  if (ranged > 0) addLine("ID_CharacterInfo_Mastery_Ranged", [RANGED_MASTERY[ranged] ?? "Unknown"]);
  const summoning = int(P.SummoningMastery) ?? 0;
  if (summoning > 0) addLine("ID_CharacterInfo_Mastery_Summoning", [SUMMONING_MASTERY[summoning] ?? "Unknown"]);
  addLine("ID_CharacterInfo_Luminance_Header");
  for (const aura of LUMINANCE_AURAS) {
    const rating = int(aura.id) ?? 0;
    if (rating <= 0) continue;
    if (aura.spec) {
      addLine(aura.base, [Math.min(rating, 5)]);
      if (rating > 5) addLine(aura.spec, [rating - 5]);
    } else {
      addLine(aura.base, [rating * (aura.mult ?? 1)]);
    }
  }
  for (const [id, token] of GEM_AUGMENTATIONS) {
    const n = int(id) ?? 0;
    if (n > 0) addLine(token, [n]);
  }
  space();

  // UpdateLoad — the BUFFED strength (CACQualities::InqLoad, default 10).
  const strength = num(typeof src.attr === "function" ? src.attr(1) : null) ?? 10;
  const encumbVal = int(P.EncumbranceVal) ?? 0;
  const loadAugs = int(P.AugmentationIncreasedCarryingCapacity) ?? 0;
  const capacity = encumbranceCapacity(strength, loadAugs);
  const load = encumbranceLoad(capacity, encumbVal);
  if (load >= 1.0) {
    addLine("ID_CharacterInfo_Load_Burdened", [
      encumbVal - capacity,
      10 * (10 - Math.trunc(loadMod(load) * 10.0)),
    ]);
  } else {
    addLine("ID_CharacterInfo_Load_None");
  }
  if (loadAugs > 0) addLine("ID_CharacterInfo_Load_Augmentations", [loadAugs, 20 * loadAugs]);
  return out;
}

/** The report as one block of text (what the panel's text element shows). */
export function characterInfoText(src) {
  return buildCharacterInfoReport(src).map((e) => e.text).join("").replace(/\s+$/, "");
}
