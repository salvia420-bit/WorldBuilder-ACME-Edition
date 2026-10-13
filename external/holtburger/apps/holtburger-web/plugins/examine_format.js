// Examine-panel text formatting — pure helpers (no DOM, no wasm, no
// imports) shared by plugins/examine-target.js and pinned by
// test_examine_format.mjs. HUD overhaul 2026-10-05.
//
// Everything here turns wire numbers into the player-facing strings
// retail's ItemExamineUI / BasicCreatureExamineUI printed, so the examine
// panel never shows enum ids, bitmasks or hex where retail showed words.
// Retail citations are the acclient.c function each rule mirrors.

// ── Enum name tables (ACE.Entity.Enum, vanilla ACE a8ff29f) ────────────

/** HeritageGroup (ACE HeritageGroup.cs). */
export const HERITAGE_NAMES = Object.freeze([
  null, "Aluvian", "Gharu'ndim", "Sho", "Viamontian", "Umbraen",
  "Gear Knight", "Tumerok", "Lugian", "Empyrean", "Penumbraen",
  "Undead", "Olthoi", "Olthoi",
]);

/** AppraisalSystem::InqHeritageGroupDisplayName — number or the string
 *  PropertyString.HeritageGroup ACE sometimes sends. */
export function heritageName(v) {
  if (typeof v === "string" && v.trim()) return v.trim();
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? (HERITAGE_NAMES[n] ?? null) : null;
}

/** Gender (PropertyInt.Gender = 113: 1 Male, 2 Female) or the
 *  PropertyString.Sex text. */
export function genderName(sexString, genderInt) {
  if (typeof sexString === "string" && sexString.trim()) return sexString.trim();
  const n = Number(genderInt);
  return n === 1 ? "Male" : n === 2 ? "Female" : null;
}

/** CreatureType (ACE CreatureType.cs, sequential from 0 = Invalid). */
export const CREATURE_TYPE_NAMES = Object.freeze([
  null, "Olthoi", "Banderling", "Drudge", "Mosswart", "Lugian", "Tumerok", "Mite",
  "Tusker", "Phyntos Wasp", "Rat", "Auroch", "Cow", "Golem", "Undead", "Gromnie",
  "Reedshark", "Armoredillo", "Fae", "Virindi", "Wisp", "Knathtead", "Shadow",
  "Mattekar", "Mumiyah", "Rabbit", "Sclavus", "Shallows Shark", "Monouga", "Zefir",
  "Skeleton", "Human", "Shreth", "Chittick", "Moarsman", "Olthoi Larvae", "Slithis",
  "Deru", "Fire Elemental", "Snowman", "Unknown", "Bunny", "Lightning Elemental",
  "Rockslide", "Grievver", "Niffis", "Ursuin", "Crystal", "Hollow Minion", "Scarecrow",
  "Idol", "Empyrean", "Hopeslayer", "Doll", "Marionette", "Carenzi", "Siraluun",
  "Aun Tumerok", "Hea Tumerok", "Simulacrum", "Acid Elemental", "Frost Elemental",
  "Elemental", "Statue", "Wall", "Altered Human", "Device", "Harbinger",
  "Dark Sarcophagus", "Chicken", "Gotrok Lugian", "Margul", "Bleached Rabbit",
  "Nasty Rabbit", "Grimacing Rabbit", "Burun", "Target", "Ghost", "Fiun", "Eater",
  "Penguin", "Ruschk", "Thrungus", "Viamontian Knight", "Remoran", "Swarm", "Moar",
  "Enchanted Arms", "Sleech", "Mukkir", "Merwart", "Food", "Paradox Olthoi",
  "Harvest", "Energy", "Apparition", "Aerbax", "Touched", "Blighted Moarsman",
  "Gear Knight", "Gurog", "Anekshay",
]);

/** AppraisalSystem::InqCreatureDisplayName (PropertyInt.CreatureType = 2). */
export function creatureTypeName(n) {
  const i = Number(n);
  return Number.isInteger(i) && i > 0 ? (CREATURE_TYPE_NAMES[i] ?? null) : null;
}

/** ItemType bits (ACE ItemType.cs) → player-facing category, most
 *  specific first so a magic sword reads "Melee Weapon", not "Magic". */
export const ITEM_TYPE_NAMES = Object.freeze([
  [0x00000001, "Melee Weapon"],
  [0x00000100, "Missile Weapon"],
  [0x00008000, "Caster"],
  [0x00000002, "Armor"],
  [0x00000004, "Clothing"],
  [0x00000008, "Jewelry"],
  [0x00000200, "Container"],
  [0x00000800, "Gem"],
  [0x00000020, "Food"],
  [0x00000040, "Money"],
  [0x00001000, "Spell Component"],
  [0x00002000, "Book or Scroll"],
  [0x00004000, "Key"],
  [0x00080000, "Mana Stone"],
  [0x00040000, "Trade Note"],
  [0x20000000, "Tinkering Tool"],
  [0x40000000, "Salvage"],
  [0x00400000, "Cooking Ingredient"],
  [0x00800000, "Alchemy Ingredient"],
  [0x04000000, "Alchemy Ingredient"],
  [0x02000000, "Fletching Supply"],
  [0x08000000, "Fletching Supply"],
  [0x00010000, "Portal"],
  [0x10000000, "Lifestone"],
  [0x00100000, "Service"],
  [0x80000000, "Game Board"],
  [0x00000010, "Creature"],
  [0x00020000, "Lockable"],
  [0x00200000, "Magic Item"],
  [0x00000080, "Miscellaneous"],
  [0x00000400, "Miscellaneous"],
]);

export function itemTypeLabel(mask) {
  const m = Number(mask) >>> 0;
  if (!m) return null;
  for (const [bit, name] of ITEM_TYPE_NAMES) {
    if ((m & bit) >>> 0) return name;
  }
  return null;
}

/** EquipMask bits (ACE EquipMask.cs) → body-location words. Wear/Armor
 *  twins share a word so "Chest, Abdomen" never reads twice. */
export const EQUIP_SLOT_NAMES = Object.freeze([
  [0x00000001, "Head"],
  [0x00000002, "Chest"], [0x00000200, "Chest"],
  [0x00000004, "Abdomen"], [0x00000400, "Abdomen"],
  [0x00000008, "Upper Arms"], [0x00000800, "Upper Arms"],
  [0x00000010, "Lower Arms"], [0x00001000, "Lower Arms"],
  [0x00000020, "Hands"],
  [0x00000040, "Upper Legs"], [0x00002000, "Upper Legs"],
  [0x00000080, "Lower Legs"], [0x00004000, "Lower Legs"],
  [0x00000100, "Feet"],
  [0x00008000, "Neck"],
  [0x00010000, "Left Wrist"], [0x00020000, "Right Wrist"],
  [0x00040000, "Left Finger"], [0x00080000, "Right Finger"],
  [0x00100000, "Melee Weapon"], [0x00200000, "Shield"],
  [0x00400000, "Missile Weapon"], [0x00800000, "Ammunition"],
  [0x01000000, "Held"], [0x02000000, "Two-Handed"],
  [0x04000000, "Trinket"], [0x08000000, "Cloak"],
  [0x10000000, "Blue Aetheria"], [0x20000000, "Yellow Aetheria"],
  [0x40000000, "Red Aetheria"],
]);

export function equipSlotsLabel(mask) {
  const m = Number(mask) >>> 0;
  if (!m) return null;
  const out = [];
  for (const [bit, name] of EQUIP_SLOT_NAMES) {
    if ((m & bit) >>> 0 && !out.includes(name)) out.push(name);
  }
  return out.length ? out.join(", ") : null;
}

/** ACE Skill.cs order (index = wire skill id). */
export const SKILL_NAMES = Object.freeze([
  "None", "Axe", "Bow", "Crossbow", "Dagger", "Mace", "Melee Defense",
  "Missile Defense", "Sling", "Spear", "Staff", "Sword", "Thrown Weapon",
  "Unarmed Combat", "Arcane Lore", "Magic Defense", "Mana Conversion",
  "Spellcraft", "Item Tinkering", "Assess Person", "Deception", "Healing",
  "Jump", "Lockpick", "Run", "Awareness", "Arms and Armor Repair",
  "Assess Creature", "Weapon Tinkering", "Armor Tinkering",
  "Magic Item Tinkering", "Creature Enchantment", "Item Enchantment",
  "Life Magic", "War Magic", "Leadership", "Loyalty", "Fletching",
  "Alchemy", "Cooking", "Salvaging", "Two Handed Combat", "Gearcraft",
  "Void Magic", "Heavy Weapons", "Light Weapons", "Finesse Weapons",
  "Missile Weapons", "Shield", "Dual Wield", "Recklessness",
  "Sneak Attack", "Dirty Fighting", "Challenge", "Summoning",
]);

export function skillName(id) {
  const n = Number(id);
  return SKILL_NAMES[n] || null;
}

/** SkillSystem::InqAttributeName (acclient.c:499678), attribute id 1..6. */
export const ATTRIBUTE_NAMES = Object.freeze([
  null, "Strength", "Endurance", "Quickness", "Coordination", "Focus", "Self",
]);

/** SkillSystem::InqAttribute2ndName (acclient.c:499716), vital id 1..6. */
export const VITAL_NAMES = Object.freeze([
  null, "Maximum Health", "Health", "Maximum Stamina", "Stamina", "Maximum Mana", "Mana",
]);

// ── Requirements (ItemExamineUI::Appraisal_ShowLevelLimitInfo /
//    ::Appraisal_ShowWieldRequirements) — examine-text-1 (2026-10-13) ──

// Property bags are keyed by the Rust enum name; the wire id is a fallback
// (examine-target.js reads UiEffects the same way). "" counts as unset.
function bagValue(bag, name, id) {
  if (!bag) return undefined;
  const v = bag[name] ?? bag[String(id)];
  return v == null || v === "" ? undefined : v;
}
function bagInt(bag, name, id) {
  const v = bagValue(bag, name, id);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * ItemExamineUI::Appraisal_ShowLevelLimitInfo (acclient.c:232283):
 * PropertyInt.MinLevel (0x56) / MaxLevel (0x57), each unset when ≤ 0.
 * @returns {string|null}
 */
export function levelLimitLine(ints = {}) {
  const min = bagInt(ints, "MinLevel", 86) ?? -1;
  const max = bagInt(ints, "MaxLevel", 87) ?? -1;
  if (min <= 0) return max > 0 ? `Restricted to characters of Level ${max} or below.` : null;
  if (max <= 0) return `Restricted to characters of Level ${min} or greater.`;
  if (min === max) return `Restricted to characters of Level ${min}.`;
  return `Restricted to characters of Levels ${min} to ${max}.`;
}

/** WieldRequirement 9/10 society standing, keyed by the PropertyInt in the
 *  skill slot (287 SocietyRankCelhan, 288 SocietyRankEldweb, 289 SocietyRankRadblo). */
const SOCIETY_STANDING = Object.freeze({
  287: "Standing with the Celestial Hand",
  288: "Standing with the Eldrytch Web",
  289: "Standing with the Radiant Blood",
});

/**
 * ItemExamineUI::GetAppraisalStringFromRequirements (acclient.c:227877) —
 * the subject of a wield-requirement line. WieldRequirement (ACE
 * WieldRequirement.cs): 1 Skill, 2 RawSkill, 3 Attrib, 4 RawAttrib,
 * 5 SecondaryAttrib, 6 RawSecondaryAttrib, 7 Level, 8 Training,
 * 9 IntStat, 10 BoolStat, 11 CreatureType, 12 HeritageType. 2/4/6 get
 * "base "; 11/12 name the creature / heritage held in the DIFFICULTY slot.
 * @returns {string|null} null for a requirement type retail does not know
 */
export function wieldRequirementSubject(req, skill, diff) {
  const base = req === 2 || req === 4 || req === 6 ? "base " : "";
  switch (req) {
    case 1: case 2: case 8: return base + (skill > 0 ? (skillName(skill) ?? "") : "");
    case 3: case 4: return base + (ATTRIBUTE_NAMES[skill] ?? "");
    case 5: case 6: return base + (VITAL_NAMES[skill] ?? "");
    case 7: return "level";
    case 9: case 10: return SOCIETY_STANDING[skill] ?? "unknown quality";
    case 11: return creatureTypeName(diff) ?? "";
    case 12: return heritageName(diff) ?? "";
    default: return null;
  }
}

/** The four (requirement, skill, difficulty) PropertyInt triples, in the
 *  order retail reads them: 0x9E-0xA0, 0x10E-0x110, 0x111-0x113, 0x114-0x116. */
const WIELD_REQUIREMENT_SLOTS = Object.freeze([
  [["WieldRequirements", 158], ["WieldSkillType", 159], ["WieldDifficulty", 160]],
  [["WieldRequirements2", 270], ["WieldSkillType2", 271], ["WieldDifficulty2", 272]],
  [["WieldRequirements3", 273], ["WieldSkillType3", 274], ["WieldDifficulty3", 275]],
  [["WieldRequirements4", 276], ["WieldSkillType4", 277], ["WieldDifficulty4", 278]],
]);

/**
 * ItemExamineUI::Appraisal_ShowWieldRequirements (acclient.c:230357) — the
 * retail lines, in retail order:
 *   - "Wield requires <CraftsmanName | the original owner>" when
 *     PropertyBool.AppraisalHasAllowedWielder (0x55) is set;
 *   - "Use requires Throne of Destiny." for AccountRequirements (0x1A) == 1;
 *   - "Wield requires <heritage>" for HeritageSpecificArmor (0x144);
 *   - one line per requirement triple: "Wield requires %s %d" for 1-7/9/10,
 *     "Wield requires specialized|trained %s" for 8 (difficulty 3 =
 *     specialized), "Wield requires %s type" / "%s race" for 11 / 12.
 * A triple prints only when all three ints are present (retail's chained
 * InqInt); an unknown requirement type ends the list. Retail's fourth slot
 * spells "Specialized" / "Trained" with a capital (:230609).
 * @returns {string[]}
 */
export function wieldRequirementLines(ints = {}, bools = {}, strings = {}) {
  const lines = [];
  if (Number(bagValue(bools, "AppraisalHasAllowedWielder", 85)) === 1) {
    const owner = bagValue(strings, "CraftsmanName", 25);
    lines.push(`Wield requires ${owner !== undefined ? String(owner) : "the original owner"}`);
  }
  if (bagInt(ints, "AccountRequirements", 26) === 1) lines.push("Use requires Throne of Destiny.");
  const heritageSpecific = bagInt(ints, "HeritageSpecificArmor", 324);
  if (heritageSpecific !== undefined) {
    const h = heritageName(heritageSpecific);
    if (h) lines.push(`Wield requires ${h}`);
  }
  for (let slot = 0; slot < WIELD_REQUIREMENT_SLOTS.length; slot++) {
    const [r, s, d] = WIELD_REQUIREMENT_SLOTS[slot];
    const req = bagInt(ints, r[0], r[1]);
    const skill = bagInt(ints, s[0], s[1]);
    const diff = bagInt(ints, d[0], d[1]);
    if (req === undefined || skill === undefined || diff === undefined) continue;
    const what = wieldRequirementSubject(req, skill, diff);
    if (what === null) break;
    if (req === 8) {
      const capital = slot === 3;
      const training = diff === 3
        ? (capital ? "Specialized" : "specialized")
        : (capital ? "Trained" : "trained");
      lines.push(`Wield requires ${training} ${what}`);
    } else if (req === 11) lines.push(`Wield requires ${what} type`);
    else if (req === 12) lines.push(`Wield requires ${what} race`);
    else lines.push(`Wield requires ${what} ${diff}`);
  }
  return lines;
}

/** DamageType bits (ACE DamageType.cs) — AppraisalSystem::DamageTypeToString
 *  (acclient.c:479074): retail's literals are "Electrical" for 0x40 and
 *  "Prismatic" for BASE_DAMAGE_TYPE 0x10000000 (examine-text-3). */
const DAMAGE_TYPE_BITS = [
  [0x1, "Slashing"], [0x2, "Piercing"], [0x4, "Bludgeoning"], [0x8, "Cold"],
  [0x10, "Fire"], [0x20, "Acid"], [0x40, "Electrical"], [0x400, "Nether"],
  [0x10000000, "Prismatic"],
];
export function damageTypeLabel(mask) {
  const m = (Number(mask) >>> 0);
  if (!m) return null;
  const names = DAMAGE_TYPE_BITS.filter(([bit]) => (m & bit) !== 0).map(([, n]) => n);
  return names.length > 0 ? names.join("/") : null;
}

// ── Number formatting ─────────────────────────────────────────────────

/** 1234567 → "1,234,567" (retail Value/Burden lines group thousands). */
export function formatThousands(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  const neg = v < 0;
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${s}` : s;
}

/**
 * The sentence AppraisalSystem::DamageResistanceToString (acclient.c:480119,
 * negative branch) prints INSTEAD of "<Type>: <adjective>" when the armor
 * modifier is negative, keyed by the DAMAGE_TYPE bit. examine-text-3.
 */
export const NEGATIVE_PROTECTION_TEXT = Object.freeze({
  0x1: "Your armor will rend and slash you if hit.",
  0x2: "Your armor will cave in and pierce you if hit.",
  0x4: "Your armor will shatter and bruise you if hit.",
  0x8: "Your armor is unnaturally cold.",
  0x10: "Your armor is flammable.",
  0x20: "Your armor itches and burns your skin.",
  0x40: "Your armor is extremely conductive.",
  0x400: "Your armor is infused with shadow.",
});

/**
 * Armor protection line value — AppraisalSystem::DamageResistanceToString
 * (acclient.c 005B5490): the modifier picks an adjective, followed by the
 * effective protection `AL × modifier` as "  (%.0f)".
 *   m < −0.0002  → the armor HURTS you: with `damageBit` (the row's
 *                  DAMAGE_TYPE bit) retail's per-type sentence +
 *                  "  (%.0f)" (NEGATIVE_PROTECTION_TEXT); without it,
 *                  "Vulnerable"
 *   |m| ≤ 0.0002 → "No"
 *   (0, 0.4]     → "Poor"           (0.4, 0.8] → "Below Average"
 *   (0.8, 1.2)   → "Average"        [1.2, 1.6) → "Above Average"
 *   [1.6, 2.0)   → "Excellent"      ≥ 2.0      → "Unparalleled" (m := 2)
 */
export function protectionText(modifier, armorLevel, damageBit) {
  let m = Number(modifier);
  if (!Number.isFinite(m)) return null;
  const al = (armorLevel == null || armorLevel === "") ? NaN : Number(armorLevel);
  let word;
  if (m < -0.0002) {
    const sentence = damageBit != null ? NEGATIVE_PROTECTION_TEXT[Number(damageBit) >>> 0] : undefined;
    if (sentence) return Number.isFinite(al) ? `${sentence}  (${Math.round(al * m)})` : sentence;
    word = "Vulnerable";
  } else if (Math.abs(m) <= 0.0002) word = "No";
  else if (m <= 0.4) word = "Poor";
  else if (m <= 0.8) word = "Below Average";
  else if (m < 1.2) word = "Average";
  else if (m < 1.6) word = "Above Average";
  else if (m < 2.0) word = "Excellent";
  else { word = "Unparalleled"; m = 2.0; }
  return Number.isFinite(al) ? `${word} (${Math.round(al * m)})` : word;
}

/** AppraisalSystem::WeaponTimeToString (acclient.c 005B4970):
 *  <11 Very Fast, 11–30 Fast, 31–49 Average, 50–79 Slow, ≥80 Very Slow,
 *  printed as "%s (%d)". */
export function weaponSpeedText(weaponTime) {
  const t = Math.round(Number(weaponTime));
  if (!Number.isFinite(t)) return null;
  let word;
  if (t < 11) word = "Very Fast";
  else if (t < 31) word = "Fast";
  else if (t < 50) word = "Average";
  else if (t < 80) word = "Slow";
  else word = "Very Slow";
  return `${word} (${t})`;
}

/** ItemExamineUI::Appraisal_ShowWeaponAndArmorData damage line,
 *  "%.4g - %d": min = max × (1 − variance). */
export function damageRangeText(maxDamage, variance) {
  const max = Number(maxDamage);
  if (!Number.isFinite(max)) return null;
  const v = Number(variance);
  if (!Number.isFinite(v) || v <= 0) return String(Math.round(max));
  const min = max * (1 - v);
  return `${Number(min.toPrecision(4))} - ${Math.round(max)}`;
}

// ── Workmanship + Bonded/Attuned (examine-text-3, 2026-10-13) ─────────

/** rgWorkmanshipStrings (retail data 0x8215FC, 11 entries; [0] is ""). */
export const WORKMANSHIP_STRINGS = Object.freeze([
  "", "Poorly ", "Well-", "Finely ", "Exquisitely ", "Magnificent",
  "Nearly flawless", "Flawless", "Utterly flawless", "Incomparable", "Priceless",
]);

/** AppraisalSystem::InqWorkmanshipAdjective (acclient.c:479578): the
 *  unsigned level clamps to 10; levels 0..4 append "crafted" ("cut" for a
 *  gem), so 3 → "Finely crafted". */
export function workmanshipAdjective(level, gem = false) {
  const n = Number(level);
  if (!Number.isFinite(n)) return null;
  const u = n >>> 0;
  const i = u >= 11 ? 10 : u;
  return i <= 4 ? WORKMANSHIP_STRINGS[i] + (gem ? "cut" : "crafted") : WORKMANSHIP_STRINGS[i];
}

/**
 * ItemExamineUI::Appraisal_ShowTinkeringInfo (acclient.c:231087) workmanship
 * line. A plain item prints "Workmanship: %s (%d)". A salvage bag holds the
 * SUM of its items' workmanship in ItemWorkmanship (0x69) and the item count
 * in NumItemsInMaterial (0xAA) (ACE Player_Crafting.cs), so retail divides:
 * "Workmanship: %s (%0.2f)\n\nSalvaged from %d items.", adjective of
 * (int)(avg + 0.5). A count ≤ 0 is treated as absent (retail would divide
 * by zero).
 * @returns {{value: string, salvagedLine: (string|null)}|null} `value` is
 *   the text after "Workmanship: "; null when ItemWorkmanship is unset
 */
export function workmanshipText(itemWorkmanship, numItemsInMaterial) {
  if (itemWorkmanship == null || itemWorkmanship === "") return null;
  const work = Number(itemWorkmanship);
  if (!Number.isFinite(work)) return null;
  const n = (numItemsInMaterial == null || numItemsInMaterial === "") ? NaN : Number(numItemsInMaterial);
  if (Number.isInteger(n) && n > 0) {
    const avg = work / n;
    // fAvg is a float in retail; "%0.2f" prints it.
    const fAvg = Math.fround(avg);
    return {
      value: `${workmanshipAdjective(Math.trunc(avg + 0.5))} (${fAvg.toFixed(2)})`,
      salvagedLine: `Salvaged from ${n} items.`,
    };
  }
  const w = Math.trunc(work);
  return { value: `${workmanshipAdjective(w)} (${w})`, salvagedLine: null };
}

/** AppraisalSystem::BondedStatusToString (acclient.c:479552), PropertyInt
 *  Bonded (0x21): −2 "Destroyed on Death", −1 "Dropped on Death", 1 "Bonded". */
export function bondedText(v) {
  const n = Number(v);
  if (n === -2) return "Destroyed on Death";
  if (n === -1) return "Dropped on Death";
  if (n === 1) return "Bonded";
  return null;
}

/** AppraisalSystem::AttunedStatusToString (acclient.c:479535), PropertyInt
 *  Attuned (0x72): 1..2 → "Attuned". */
export function attunedText(v) {
  const n = Number(v);
  return n === 1 || n === 2 ? "Attuned" : null;
}

// ── Item magic (examine-text-4, 2026-10-13) ───────────────────────────

/** Bit 31 of an appraisal spell-book entry: ACE AppraiseInfo.AddEnchantments
 *  sends each enchantment on the item (and wielder auras) as
 *  `SpellId | 0x80000000`. */
export const SPELL_BOOK_ENCHANTMENT_BIT = 0x80000000;

/**
 * ItemExamineUI::Appraisal_ShowMagicInfo (acclient.c:232515) splits the
 * appraisal spell book on bit 31 (:232581): clear = a spell the item
 * carries ("Spell Descriptions:"), set = an enchantment currently on it
 * ("Enchantments:"), looked up as `id & 0x7FFFFFFF`.
 * Appraisal_ShowShortMagicInfo (:232412) lists only the clear ones.
 * @returns {{intrinsic: number[], enchantments: number[]}} spell ids in wire
 *   order; enchantment ids already masked
 */
export function splitSpellBook(ids) {
  const intrinsic = [];
  const enchantments = [];
  if (!Array.isArray(ids) && !ArrayBuffer.isView(ids)) return { intrinsic, enchantments };
  for (const raw of ids) {
    const id = Number(raw) >>> 0;
    if ((id & SPELL_BOOK_ENCHANTMENT_BIT) !== 0) enchantments.push((id & 0x7FFFFFFF) >>> 0);
    else intrinsic.push(id);
  }
  return { intrinsic, enchantments };
}

/**
 * Appraisal_ShowMagicInfo's mana-cost line (acclient.c:232660-232676):
 * when ManaRate (float 5) is present, "Mana Cost: 1 point per %d seconds."
 * with (unsigned)(|1/rate| + 0.5). Otherwise ItemManaCost (int 0x75) gives
 * "Mana Cost: %d.", plus "(Can be reduced by the Mana Conversion skill)"
 * when it is > 0. A ManaRate of 0 has no finite period, so it returns null
 * (retail printed garbage) and does not fall through to ItemManaCost.
 * @returns {{value: string, text: string, note: (string|null)}|null}
 *   `value` is the text after "Mana Cost: " without the period; `text` is
 *   retail's whole first line
 */
export function manaCostText(ints = {}, floats = {}) {
  const rateRaw = floats?.ManaRate;
  if (rateRaw != null && rateRaw !== "") {
    const period = Math.abs(1 / Number(rateRaw));
    if (!Number.isFinite(period)) return null;
    const value = `1 point per ${Math.trunc(period + 0.5)} seconds`;
    return { value, text: `Mana Cost: ${value}.`, note: null };
  }
  const costRaw = ints?.ItemManaCost;
  if (costRaw == null || costRaw === "") return null;
  const cost = Number(costRaw);
  if (!Number.isFinite(cost)) return null;
  const c = Math.trunc(cost);
  return {
    value: String(c),
    text: `Mana Cost: ${c}.`,
    note: c > 0 ? "(Can be reduced by the Mana Conversion skill)" : null,
  };
}

/**
 * Retail tints an examine line when an enchantment changes it: the
 * *Highlight mask says WHICH stats are enchanted, the matching *Color bit
 * says how (1 = green/raised, 0 = red/lowered) — protocol.xml
 * ArmorHighlightMask / WeaponHighlightMask "highlight enable bitmask" +
 * "highlight color bitmask: 0=red, 1=green".
 * @returns {"buffed"|"debuffed"|null}
 */
export function highlightState(highlightMask, colorMask, bit) {
  const h = Number(highlightMask) >>> 0;
  if (!(h & bit)) return null;
  return ((Number(colorMask) >>> 0) & bit) ? "buffed" : "debuffed";
}

/** Health meter model from whatever we know (exact cur/max beats a
 *  QueryHealth fraction). */
export function healthModel({ cur, max, fraction } = {}) {
  const c = Number(cur);
  const m = Number(max);
  if (Number.isFinite(c) && Number.isFinite(m) && m > 0) {
    const f = Math.max(0, Math.min(1, c / m));
    return { fraction: f, label: `${formatThousands(Math.max(0, c))} / ${formatThousands(m)}` };
  }
  const f = Number(fraction);
  if (Number.isFinite(f)) {
    const ff = Math.max(0, Math.min(1, f));
    return { fraction: ff, label: `${Math.round(ff * 100)}%` };
  }
  return null;
}

// ── Creature attribute block (BasicCreatureExamineUI) ─────────────────

/**
 * CreatureAppraisalProfile highlight bits (acclient.c
 * CreatureAppraisalProfile::InqAttributeEnchantmentMod :480644 for the six
 * attributes, InqAttribute2ndEnchantmentMod :480707 for the MAX vitals).
 * The wire splits the u32 into `buffs.highlights` / `buffs.colors` u16s, so
 * bit i lines up in both (colour bit 1 = raised / green, 0 = lowered / red).
 */
export const CREATURE_ATTRIBUTE_BITS = Object.freeze({
  Strength: 0x0001, Endurance: 0x0002, Quickness: 0x0004,
  Coordination: 0x0008, Focus: 0x0010, Self: 0x0020,
  Health: 0x0040, Stamina: 0x0080, Mana: 0x0100,
});

/**
 * Rows of the creature / player assess block — enchstats-4 (2026-10-08).
 *
 * Retail AttributeInfoRegion::Update(AppraisalProfile*) (acclient.c:285975)
 * prints `%d`, or `???` when the value is 0, in font
 * `success ? (raised ? 1 : 2) : 3` (3 = incomplete). Attribute2ndInfoRegion::
 * Update(AppraisalProfile*) (:286022) prints `cur/max` on success and only
 * the MulDiv percentage `N %` on failure. ACE's failed CreatureProfile
 * carries Health/HealthMax only, so Stamina/Mana read `???` there.
 *
 * `cp` is the wire CreatureProfile (`attributes.self_attr` — the Rust field
 * name; `self_` / `self` / `ints.Self` are tolerated fallbacks). `ints` is the
 * appraisal's PropertyInt bag, consulted on success only. A success row whose
 * value is unknown entirely is returned with `value: null` (the panel skips
 * it, as before).
 *
 * @returns {Array<{key: string, kind: "attribute"|"vital", label: string,
 *   value: (string|null), tone: ("buffed"|"debuffed"|"incomplete"|null)}>}
 */
export function creatureAttributeRows(cp, success = true, ints = {}) {
  const a = cp?.attributes || {};
  const buffs = cp?.buffs || null;
  const bag = ints || {};
  const tone = (bit) => (success ? highlightState(buffs?.highlights, buffs?.colors, bit) : "incomplete");
  const known = (v) => v != null && v !== "" && Number.isFinite(Number(v));
  const attrValue = (v) => {
    if (!success) return "???";
    if (!known(v)) return null;
    return Number(v) === 0 ? "???" : String(Number(v));
  };
  const rows = [];
  const attr = (label, v) => rows.push({
    key: label.toLowerCase(), kind: "attribute", label,
    value: attrValue(v), tone: tone(CREATURE_ATTRIBUTE_BITS[label]),
  });
  // Display order kept from the pre-2026-10-08 panel.
  attr("Strength", a.strength ?? bag.Strength);
  attr("Endurance", a.endurance ?? bag.Endurance);
  attr("Coordination", a.coordination ?? bag.Coordination);
  attr("Quickness", a.quickness ?? bag.Quickness);
  attr("Focus", a.focus ?? bag.Focus);
  attr("Self", a.self_attr ?? a.self_ ?? a.self ?? bag.Self);

  const pair = (cur, max) => {
    if (known(max)) return `${formatThousands(known(cur) ? cur : 0)} / ${formatThousands(max)}`;
    return known(cur) ? formatThousands(cur) : null;
  };
  const percent = (cur, max) => {
    const c = Number(cur);
    const m = Number(max);
    if (!Number.isFinite(c) || !Number.isFinite(m) || m <= 0) return "???";
    // Windows MulDiv(cur, 100, max): rounded, 4/7 → 57.
    return `${Math.round((100 * c) / m)} %`;
  };
  const vital = (label, cur, max, intFallback) => {
    let value;
    if (success) {
      value = pair(cur, max) ?? (known(intFallback) ? formatThousands(intFallback) : null);
    } else {
      value = label === "Health" ? percent(cur, max) : "???";
    }
    rows.push({
      key: label.toLowerCase(), kind: "vital", label,
      value, tone: tone(CREATURE_ATTRIBUTE_BITS[label]),
    });
  };
  vital("Health", cp?.health, cp?.health_max, bag.MaxHealth);
  vital("Stamina", a.stamina, a.stamina_max, bag.MaxStamina);
  vital("Mana", a.mana, a.mana_max, bag.MaxMana);
  return rows;
}

// ── Character / creature misc info (examine-text-7, 2026-10-13) ───────
//
// The list retail's BasicCreatureExamineUI::AddLineToMiscInfo fills under
// the attribute block (m_extraInfoList: a label column + a value column,
// both in the same font colour). Re-derived from acclient.c; WebAC
// packages/renderer/src/ui/examine/CreatureAppraisalText.ts (AGPL-3.0) was a
// cross-check only. Rows are
//   { key, label, value, tone }        a label / value line
//   { key: "blank", blank: true, … }   retail's empty separator line
//   { key, label, note: true, … }      a label-only line (the legend)
// `tone` is "ok" (font 1, the viewer's own society), "warn" (font 2, a rival
// society) or null.

const MISC_BLANK = Object.freeze({ key: "blank", label: "", value: "", tone: null, blank: true });
function miscRow(key, label, value, tone = null) {
  return { key, label, value: String(value), tone };
}
// InqInt / InqString succeed for any value the appraisal carries (0 and ""
// included), unlike bagValue's "unset" rule.
function bagHas(bag, name, id) {
  return bag != null && (bag[name] != null || bag[String(id)] != null);
}
function bagRawInt(bag, name, id) {
  if (!bagHas(bag, name, id)) return undefined;
  const n = Number(bag[name] ?? bag[String(id)]);
  return Number.isFinite(n) ? Math.trunc(n) | 0 : undefined;
}
function bagRawString(bag, name, id) {
  if (!bagHas(bag, name, id)) return undefined;
  return String(bag[name] ?? bag[String(id)]);
}

/**
 * gmExaminationUI::SetAppraiseInfo (acclient.c:228878) picks the sub-page:
 * an appraisal with a creature profile goes to CharExamineUI when it also
 * carries PropertyString Template (5) or PropertyInt CharacterTitleId
 * (0x105), else to CreatureExamineUI; without a creature profile it is
 * ItemExamineUI. Retail never looks at the PLAYER description bit here, so
 * a templated NPC gets the character page.
 * @returns {"character"|"creature"|null}
 */
export function examineSubPage(snapshot) {
  if (!snapshot || !(snapshot.creatureProfile || snapshot.failedCreatureProfile)) return null;
  const props = snapshot.properties || {};
  if (bagHas(props.strings, "Template", 5) || bagHas(props.ints, "CharacterTitleId", 261)) return "character";
  return "creature";
}

/**
 * ClientUISystem::DeltaTimeToString (acclient.c:403033) — "Time in
 * Dereth:" from PropertyInt Age (0x7D, seconds). 30-day months; mo / d /
 * h / m only when non-zero, seconds always: "1mo 2d 3h 4m 5s".
 */
export function deltaTimeToString(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return null;
  const t = Math.trunc(n) >>> 0; // (unsigned int)(unsigned __int64)time
  const mo = Math.floor(t / 2592000);
  const d = Math.floor((t % 2592000) / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const parts = [];
  if (mo) parts.push(`${mo}mo`);
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * One body-location armor value, CharExamineUI::SetAppraiseInfo
 * (acclient.c:233938): ACE ArmorLevel.cs adds 9999 when every layer on the
 * body part is unenchantable, and retail prints `"*%d"` of the value minus
 * 9999 (so 10099 → "*100"), else `"%d"`.
 */
export function armorCell(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n) | 0; // AppraisalProfile base_armor_* are ints
  return i >= 9999 ? `*${i - 9999}` : String(i);
}

/** CharExamineUI::SetAppraiseInfo society rank suffix (acclient.c:233746):
 *  1-100 Initiate, 101-300 Adept, 301-600 Knight, 601-1000 Lord,
 *  1001-1500 Master, anything else none. */
export function societyRankSuffix(rank) {
  const r = Number(rank);
  if (r >= 1 && r <= 100) return " ~ Initiate";
  if (r >= 101 && r <= 300) return " ~ Adept";
  if (r >= 301 && r <= 600) return " ~ Knight";
  if (r >= 601 && r <= 1000) return " ~ Lord";
  if (r >= 1001 && r <= 1500) return " ~ Master";
  return "";
}

/** FactionBits 1 / 2 / 4, their SocietyRank* PropertyInt (0x11F-0x121) and
 *  the bits of the two rival societies. */
const SOCIETIES = Object.freeze([
  { bit: 1, rivals: 6, rank: ["SocietyRankCelhan", 287], name: "Celestial Hand" },
  { bit: 2, rivals: 5, rank: ["SocietyRankEldweb", 288], name: "Eldrytch Web" },
  { bit: 4, rivals: 3, rank: ["SocietyRankRadblo", 289], name: "Radiant Blood" },
]);

/**
 * The "Society:" row, CharExamineUI::SetAppraiseInfo (acclient.c:233696):
 * only when the appraisal carries Faction1Bits (0x119). The first set bit
 * names the society and its rank int the " ~ <rank>" suffix; no society bit
 * reads "???". The colour comes from the VIEWER's own Faction1Bits
 * (PlayerDesc InqInt 0x119): the same society → font 1 ("ok"), a member of
 * a rival one → font 2 ("warn"), a viewer outside the societies → plain.
 * @returns {{key, label, value, tone}|null}
 */
export function societyRow(ints = {}, viewerFaction1Bits = 0) {
  const bits = bagRawInt(ints, "Faction1Bits", 281);
  if (bits === undefined) return null;
  const s = SOCIETIES.find((x) => (bits & x.bit) !== 0);
  if (!s) return miscRow("society", "Society:", "???");
  const rank = bagRawInt(ints, s.rank[0], s.rank[1]) ?? 0;
  const mine = (Number(viewerFaction1Bits) | 0);
  const tone = (mine & s.bit) !== 0 ? "ok" : (mine & s.rivals) !== 0 ? "warn" : null;
  return miscRow("society", "Society:", s.name + societyRankSuffix(rank), tone);
}

/**
 * The allegiance rows, CharExamineUI::SetAppraiseInfo (acclient.c:233826):
 * only for AllegianceRank (0x1E) ≥ 1. Without a MonarchsTitle (string 0x15)
 * the character IS the monarch: "Alleg. Monarch:" + "%d Follower" /
 * "%d Followers" (AllegianceFollowers 0x23, negative → 0). Otherwise
 * "Monarch:" + MonarchsTitle, then "Patron:" + PatronsTitle (string 0x23)
 * when that differs; an equal one folds into "Monarch/Patron:". ACE
 * AppraiseInfo.BuildProperties fills these for a player in an allegiance.
 */
export function allegianceRows(ints = {}, strings = {}) {
  const rank = bagRawInt(ints, "AllegianceRank", 30) ?? 0;
  if (rank < 1) return [];
  const monarch = bagRawString(strings, "MonarchsTitle", 21);
  if (monarch === undefined) {
    const n = Math.max(0, bagRawInt(ints, "AllegianceFollowers", 35) ?? 0);
    return [miscRow("allegianceMonarch", "Alleg. Monarch:", n === 1 ? "1 Follower" : `${n} Followers`)];
  }
  const patron = bagRawString(strings, "PatronsTitle", 35);
  if (patron === undefined) return [miscRow("monarch", "Monarch:", monarch)];
  if (patron === monarch) return [miscRow("monarchPatron", "Monarch/Patron:", monarch)];
  return [miscRow("monarch", "Monarch:", monarch), miscRow("patron", "Patron:", patron)];
}

/** CharExamineUI's m_displayText_AllegianceName header line: AllegianceName
 *  (string 0x2F) for AllegianceRank ≥ 1 (acclient.c:233846). */
export function allegianceNameText(ints = {}, strings = {}) {
  if ((bagRawInt(ints, "AllegianceRank", 30) ?? 0) < 1) return null;
  const name = bagRawString(strings, "AllegianceName", 47);
  return name ? name : null;
}

/**
 * CharExamineUI's armor block (acclient.c:233908): when any body-location
 * armor level (the ArmorLevels section, `snapshot.armorLevels`) is > 0, a
 * blank line and three "AL: a/b/c" rows — Head/Chest/Groin,
 * Bicep/Wrist/Hand, Thigh/Shin/Foot — with armorCell's "*N" for an
 * unenchantable location.
 */
export function characterArmorRows(al) {
  if (!al) return [];
  const g = (k) => Math.trunc(Number(al[k]) || 0) | 0;
  const keys = ["head", "chest", "abdomen", "upper_arm", "lower_arm", "hand", "upper_leg", "lower_leg", "foot"];
  if (!keys.some((k) => g(k) > 0)) return [];
  const cells = (a, b, c) => `AL: ${armorCell(g(a))}/${armorCell(g(b))}/${armorCell(g(c))}`;
  return [
    MISC_BLANK,
    miscRow("armorHeadChestGroin", "Head/Chest/Groin", cells("head", "chest", "abdomen")),
    miscRow("armorBicepWristHand", "Bicep/Wrist/Hand", cells("upper_arm", "lower_arm", "hand")),
    miscRow("armorThighShinFoot", "Thigh/Shin/Foot", cells("upper_leg", "lower_leg", "foot")),
  ];
}

/**
 * The rating block CreatureExamineUI::SetAppraiseInfo (acclient.c:233213)
 * and CharExamineUI::SetAppraiseInfo (:234053) both append. The format
 * strings are "%Rating: %d/%d" and "%Resist: %d/%d"; MSVC's printf prints
 * an unknown conversion character literally, so "%R" reads "R". The label
 * is "Dmg/CritDmg" for the rating AND the resist line, "DoT/Life:" for the
 * third; a blank line opens and closes the block. CritRating (0x139) and
 * CritResistRating (0x13B) only open their line; HealingBoostRating (0x143)
 * is read but never shown.
 */
export function creatureRatingRows(ints = {}) {
  const g = (name, id) => bagRawInt(ints, name, id) ?? 0;
  const dr = g("DamageRating", 307);
  const drr = g("DamageResistRating", 308);
  const cr = g("CritRating", 313);
  const cdr = g("CritDamageRating", 314);
  const crr = g("CritResistRating", 315);
  const cdrr = g("CritDamageResistRating", 316);
  const dot = g("DotResistRating", 350);
  const life = g("LifeResistRating", 351);
  const rows = [];
  if (dr > 0 || cr > 0 || cdr > 0) {
    rows.push(MISC_BLANK, miscRow("damageRating", "Dmg/CritDmg", `Rating: ${dr}/${cdr}`));
  }
  if (drr > 0 || crr > 0 || cdrr > 0) {
    if (!rows.length) rows.push(MISC_BLANK);
    rows.push(miscRow("damageResist", "Dmg/CritDmg", `Resist: ${drr}/${cdrr}`));
  }
  if (dot > 0 || life > 0) {
    if (!rows.length) rows.push(MISC_BLANK);
    rows.push(miscRow("dotLifeResist", "DoT/Life:", `Resist: ${dot}/${life}`));
  }
  if (rows.length) rows.push(MISC_BLANK);
  return rows;
}

/**
 * CharExamineUI::SetAppraiseInfo's misc-info list (acclient.c:233437), in
 * retail order: Society, the allegiance rows, the armor block, the rating
 * block, then each line whose property the appraisal carries —
 * "Fellowship:" (string 0xA), "Arrived in Dereth:" (DateOfBirth 0x2B),
 * "Time in Dereth:" (Age 0x7D, DeltaTimeToString), "Chess Rank:" (0xB5),
 * "Fishing Skill:" (0xC0), "Deaths:" (NumDeaths 0x2B; ≤ 0 reads "Has never
 * died"), "Titles Earned:" (NumCharacterTitles 0x106) — and always the
 * "* = Unenchantable" legend last. A property ACE withholds (the
 * AllowOthersToSee… character options) leaves its line out.
 * @param {object} [opts]
 * @param {object|null} [opts.armorLevels] the snapshot's `armorLevels`
 *   when the IdentifyResponse flagged them
 */
export function characterMiscRows(ints = {}, strings = {}, viewerFaction1Bits = 0, { armorLevels = null } = {}) {
  const rows = [];
  const society = societyRow(ints, viewerFaction1Bits);
  if (society) rows.push(society);
  rows.push(...allegianceRows(ints, strings));
  rows.push(...characterArmorRows(armorLevels));
  rows.push(...creatureRatingRows(ints));
  const str = (key, label, name, id) => {
    const v = bagRawString(strings, name, id);
    if (v !== undefined) rows.push(miscRow(key, label, v));
  };
  const int = (key, label, name, id, fmt = String) => {
    const v = bagRawInt(ints, name, id);
    if (v !== undefined) rows.push(miscRow(key, label, fmt(v)));
  };
  str("fellowship", "Fellowship:", "Fellowship", 10);
  str("dateOfBirth", "Arrived in Dereth:", "DateOfBirth", 43);
  int("age", "Time in Dereth:", "Age", 125, deltaTimeToString);
  int("chessRank", "Chess Rank:", "ChessRank", 181);
  int("fishingSkill", "Fishing Skill:", "FakeFishingSkill", 192);
  int("deaths", "Deaths:", "NumDeaths", 43, (n) => (n <= 0 ? "Has never died" : String(n)));
  int("titlesEarned", "Titles Earned:", "NumCharacterTitles", 262);
  rows.push({ key: "unenchantableLegend", label: "* = Unenchantable", value: "", tone: null, note: true });
  return rows;
}

// ── Header model ──────────────────────────────────────────────────────

/**
 * What the examine header shows (the name itself lives in the window
 * title, like retail's DisplayedNameText — never twice).
 *   item     → "Value: 1,234" / "Burden: 50 Burden Units"
 *              (ItemExamineUI::SetValueText / SetBurdenText; "???" until
 *              the appraisal says otherwise)
 *   creature → creature type (BasicCreatureExamineUI m_creatureDisplayName)
 *              + level box ("???" when unknown — SetLevelValueText)
 *   player   → heritage + gender, title, PK status (pk-5: every player),
 *              allegiance name (examine-text-7) (CharacterExam_Attributes
 *              Heritage/Profession/PlayerKiller/AllegianceName)
 * @returns {{kind: string, lines: Array<{text: string, tone?: string}>, level: (string|null), levelLabel: (string|null)}}
 */
/**
 * pk-5 (2026-10-08 round 5) — the PK status line retail shows for every
 * character: CharExamineUI::SetAppraiseInfo (acclient.c:233645-233668) and
 * gmStatManagementUI::UpdatePKStatus (:284375-284420) test IsPK (ODF 0x20),
 * then IsPKLite (0x2000000), else Non-Player Killer — on the LIVE bits.
 */
export function pkStatusText(odf) {
  const f = (odf >>> 0) || 0;
  if ((f & 0x20) !== 0) return "Player Killer";
  if ((f & 0x02000000) !== 0) return "Player Killer Lite";
  return "Non-Player Killer";
}

export function examineHeaderModel({
  kind, ints = {}, strings = {}, item = null, meta = null, isPK = false, pkStatus = null,
} = {}) {
  const lines = [];
  let level = null;
  let levelLabel = null;
  const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
  if (kind === "item") {
    const value = num(ints.Value) ?? num(item?.value);
    const burden = num(ints.EncumbranceVal) ?? num(item?.burden);
    lines.push({ text: `Value: ${value != null ? formatThousands(value) : "???"}` });
    lines.push({ text: `Burden: ${burden != null ? `${formatThousands(burden)} Burden Units` : "???"}` });
  } else if (kind === "creature") {
    const ct = creatureTypeName(ints.CreatureType);
    if (ct) lines.push({ text: ct });
    const lvl = num(ints.Level) ?? num(meta?.level);
    level = lvl != null ? String(lvl) : "???";
    levelLabel = "Level";
  } else if (kind === "player") {
    const her = heritageName(strings.HeritageGroup ?? ints.HeritageGroup);
    const sex = genderName(strings.Sex, ints.Gender);
    const hs = [her, sex].filter(Boolean).join(" ");
    if (hs) lines.push({ text: hs });
    // examine-text-7: retail's Profession line is the CharacterTitleId's
    // CharacterTitleTable name, else PropertyString Template (5) — what a
    // templated NPC shows (CharExamineUI::SetAppraiseInfo, acclient.c:233606:
    // Template is read only when InqInt(0x105) fails or the title lookup
    // does). The CharacterTitleTable is not wired, so an appraisal carrying
    // CharacterTitleId (every ACE player: it also sends the creation
    // Template) shows no Profession line rather than the wrong Template.
    const title = strings.Title || strings.CharacterTitle
      || (bagHas(ints, "CharacterTitleId", 261) ? null : strings.Template);
    if (title) lines.push({ text: String(title) });
    const pk = pkStatus ?? (isPK ? "Player Killer" : null);
    if (pk) lines.push(pk === "Player Killer" ? { text: pk, tone: "warn" } : { text: pk });
    // examine-text-7: m_displayText_AllegianceName, under the PK line.
    const allegiance = allegianceNameText(ints, strings);
    if (allegiance) lines.push({ text: allegiance });
    const lvl = num(ints.Level) ?? num(meta?.level);
    level = lvl != null ? String(lvl) : "???";
    levelLabel = "Character Level";
  }
  return { kind, lines, level, levelLabel };
}
