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

/** DamageType bits (ACE DamageType.cs) — AppraisalSystem::DamageTypeToString. */
const DAMAGE_TYPE_BITS = [
  [0x1, "Slashing"], [0x2, "Piercing"], [0x4, "Bludgeoning"], [0x8, "Cold"],
  [0x10, "Fire"], [0x20, "Acid"], [0x40, "Electric"], [0x400, "Nether"],
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
 * Armor protection line value — AppraisalSystem::DamageResistanceToString
 * (acclient.c 005B5490): the modifier picks an adjective, followed by the
 * effective protection `AL × modifier` as "  (%.0f)".
 *   m < −0.0002  → (negative: the armor HURTS you; retail prints a
 *                  per-type sentence — we print "Vulnerable")
 *   |m| ≤ 0.0002 → "No"
 *   (0, 0.4]     → "Poor"           (0.4, 0.8] → "Below Average"
 *   (0.8, 1.2)   → "Average"        [1.2, 1.6) → "Above Average"
 *   [1.6, 2.0)   → "Excellent"      ≥ 2.0      → "Unparalleled" (m := 2)
 */
export function protectionText(modifier, armorLevel) {
  let m = Number(modifier);
  if (!Number.isFinite(m)) return null;
  let word;
  if (m < -0.0002) word = "Vulnerable";
  else if (Math.abs(m) <= 0.0002) word = "No";
  else if (m <= 0.4) word = "Poor";
  else if (m <= 0.8) word = "Below Average";
  else if (m < 1.2) word = "Average";
  else if (m < 1.6) word = "Above Average";
  else if (m < 2.0) word = "Excellent";
  else { word = "Unparalleled"; m = 2.0; }
  const al = (armorLevel == null || armorLevel === "") ? NaN : Number(armorLevel);
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

// ── Header model ──────────────────────────────────────────────────────

/**
 * What the examine header shows (the name itself lives in the window
 * title, like retail's DisplayedNameText — never twice).
 *   item     → "Value: 1,234" / "Burden: 50 Burden Units"
 *              (ItemExamineUI::SetValueText / SetBurdenText; "???" until
 *              the appraisal says otherwise)
 *   creature → creature type (BasicCreatureExamineUI m_creatureDisplayName)
 *              + level box ("???" when unknown — SetLevelValueText)
 *   player   → heritage + gender, title, Player Killer
 *              (CharacterExam_Attributes Heritage/Profession/PlayerKiller)
 * @returns {{kind: string, lines: Array<{text: string, tone?: string}>, level: (string|null), levelLabel: (string|null)}}
 */
export function examineHeaderModel({ kind, ints = {}, strings = {}, item = null, meta = null, isPK = false } = {}) {
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
    const title = strings.Title || strings.CharacterTitle;
    if (title) lines.push({ text: String(title) });
    if (isPK) lines.push({ text: "Player Killer", tone: "warn" });
    const lvl = num(ints.Level) ?? num(meta?.level);
    level = lvl != null ? String(lvl) : "???";
    levelLabel = "Character Level";
  }
  return { kind, lines, level, levelLabel };
}
