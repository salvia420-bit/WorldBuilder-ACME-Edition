// tests/appraisal_text.test.mjs — examine-text-5 (2026-10-13).
//
// The EoR stat lines the examine panel never printed, each re-derived from
// acclient.c (plugins/appraisal_text.js):
//   - ItemExamineUI::Appraisal_ShowWeaponAndArmorData (:231171): "Skill: X
//     (Sword)", "Damage" / launcher "Damage Bonus", "Elemental Damage
//     Bonus", the launcher-only "Damage Modifier", "Speed", "Range: N yds."
//     (MISSILE_RANGE_CAP 85), "Bonus to Attack Skill" (weapon bit 0x1, not
//     for ammo launchers), ammunition lines, shield levels, "Covers …";
//   - ::Appraisal_ShowDefenseModData (:231730): Melee (weapon bit 0x2) /
//     Missile / Magic Defense, SmallModifierToString "%c%.1lf%%";
//   - ::Appraisal_ShowCasterData (:231613): Mana Conversion, "Damage bonus
//     for X spells:" + vs. Monsters / vs. Players ((m − 1) × 0.25 + 1),
//     resist bits 0x1000 / 0x2000;
//   - ::Appraisal_ShowActivationRequirements (:232724).
// The examine panel renders them (fake DOM, real mountExamineBody); the
// Skill row lost the WeaponOffense tint and the any-weapon "Damage bonus"
// row is gone.
//
// Run: node tests/appraisal_text.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installFakeDom, visibleText } from "./helpers/fake_dom_items.mjs";

const A = await import(new URL("../plugins/appraisal_text.js", import.meta.url).href);

const texts = (lines) => lines.map((l) => l.text);
const byKey = (lines, key) => lines.find((l) => l.key === key);

// IdentifyResponseFlags: INT 0x1, FLOAT 0x4, WEAPON_PROFILE 0x20,
// ARMOR_PROFILE 0x80, ARMOR_ENCH 0x200, RESIST_ENCH 0x400, WEAPON_ENCH 0x800.
const SWORD = Object.freeze({
  identifySuccess: true,
  identifyFlags: 0x1 | 0x4 | 0x20 | 0x800,
  properties: {
    ints: { ValidLocations: 0x100000, WeaponType: 2 },
    floats: { WeaponDefense: 1.2, WeaponMissileDefense: 1.05, WeaponMagicDefense: 1.0 },
    bools: {}, strings: {},
  },
  weaponProfile: {
    damage_type: 1, weapon_time: 35, weapon_skill: 44, damage: 27, damage_variance: 0.5,
    damage_mod: 1.0, weapon_length: 1.0, max_velocity: 1.0, weapon_offense: 1.15,
    max_velocity_estimated: 0,
  },
  // WeaponOffense raised (green), WeaponDefense lowered (red).
  weaponHighlight: 0x1 | 0x2, weaponColor: 0x1,
});

const BOW = Object.freeze({
  identifySuccess: true,
  identifyFlags: 0x1 | 0x20 | 0x800,
  properties: { ints: { ValidLocations: 0x400000, AmmoType: 1, WeaponType: 8, ElementalDamageBonus: 10 }, floats: {}, bools: {}, strings: {} },
  weaponProfile: {
    damage_type: 0x10, weapon_time: 30, weapon_skill: 47, damage: 4, damage_variance: 0,
    damage_mod: 1.4, weapon_length: 1.0, max_velocity: 50, weapon_offense: 1.1,
    max_velocity_estimated: 1,
  },
  weaponHighlight: 0x20, weaponColor: 0x20,
});

const WAND = Object.freeze({
  identifySuccess: true,
  identifyFlags: 0x1 | 0x4 | 0x400,
  properties: {
    ints: { ValidLocations: 0x1000000, DamageType: 0x10 },
    floats: { ManaConversionMod: 0.08, ElementalDamageMod: 1.1, WeaponDefense: 1.15 },
    bools: {}, strings: {},
  },
  resistHighlight: 0x2000, resistColor: 0x2000,
});

const SHIELD = Object.freeze({
  identifySuccess: true,
  identifyFlags: 0x1 | 0x80 | 0x200,
  properties: { ints: { ValidLocations: 0x200000, ArmorLevel: 220 }, floats: {}, bools: {}, strings: {} },
  armorProfile: { slashing: 1, piercing: 1, bludgeoning: 1, cold: 1, fire: 1, acid: 1, nether: 1, lightning: 1 },
  armorHighlight: 0x1, armorColor: 0x1,
});

// ── Formatters ────────────────────────────────────────────────────────

test("ModifierToString '%c%d%%' and SmallModifierToString '%c%.1lf%%'", () => {
  assert.equal(A.modifierToString(1.15), "+15%");
  assert.equal(A.modifierToString(1.4), "+40%");
  assert.equal(A.modifierToString(0.95), "-5%");
  assert.equal(A.modifierToString(1.0), "+0%");
  assert.equal(A.modifierToString(0.08 + 1), "+8%");
  assert.equal(A.smallModifierToString(1.2), "+20.0%");
  assert.equal(A.smallModifierToString(1.025), "+2.5%");
  assert.equal(A.smallModifierToString(0.9), "-10.0%");
  assert.equal(A.modifierToString(undefined), null);
});

test("formatG is C's %.<p>g", () => {
  assert.equal(A.formatG(13.5, 4), "13.5");
  assert.equal(A.formatG(12.190000000000001, 4), "12.19");
  assert.equal(A.formatG(5.8500000000000005, 3), "5.85");
  assert.equal(A.formatG(6, 3), "6");
  assert.equal(A.formatG(9.9996, 4), "10");
  assert.equal(A.formatG(12345.6, 4), "1.235e+04");
  assert.equal(A.formatG(0, 3), "0");
});

test("missile range: pow(v,2) × 0.10204 × 1.094, cap 85, ≥10 floors to a multiple of 5, <10 ceils", () => {
  assert.equal(A.missileRangeYards(50), 85);
  assert.equal(A.missileRangeYards(20), 40); // 44.65 → 40
  assert.equal(A.missileRangeYards(5), 3);   // 2.79 → 3
  assert.equal(A.missileRangeYards(0), 0);
});

test("ClothingPriorityToString: 'Covers' + parts in retail order, under/outerwear share a word", () => {
  assert.equal(A.clothingPriorityText(0x400 | 0x800 | 0x1000), "Covers Chest, Abdomen, Upper Arms");
  assert.equal(A.clothingPriorityText(0x8 | 0x400), "Covers Chest");
  assert.equal(A.clothingPriorityText(0x10000 | 0x4000 | 0x8000), "Covers Head, Hands, Feet");
  assert.equal(A.clothingPriorityText(0x2 | 0x200), "Covers Upper Legs, Lower Legs");
  assert.equal(A.clothingPriorityText(0), null);
  assert.equal(A.clothingPriorityText(0x1), null);
});

// ── Appraisal_ShowWeaponAndArmorData ──────────────────────────────────

test("melee sword: Skill with WeaponType suffix (untinted), Damage, Speed, Bonus to Attack Skill in bit 0x1", () => {
  const lines = A.weaponAndArmorLines(SWORD);
  assert.deepEqual(texts(lines), [
    "Skill: Heavy Weapons (Sword)",
    "Damage: 13.5 - 27, Slashing",
    "Speed: Average (35)",
    "Bonus to Attack Skill: +15%.",
  ]);
  assert.equal(byKey(lines, "skill").tone, null, "the Skill line is never tinted");
  assert.equal(byKey(lines, "attackSkill").tone, "buffed");
  assert.equal(byKey(lines, "attackSkill").label, "Bonus to Attack Skill");
  assert.equal(byKey(lines, "attackSkill").value, "+15%");
  assert.ok(lines.every((l) => l.group === "weapon"));
  assert.ok(!lines.some((l) => /Damage Modifier|Damage bonus/.test(l.text)), "no damage-mod line on a melee weapon");
});

test("damage line: %.3g below 10, a flat value without variance, ', unknown type' without a type", () => {
  const snap = {
    ...SWORD,
    weaponProfile: { ...SWORD.weaponProfile, damage: 9, damage_variance: 0.35, damage_type: 0x4 },
  };
  assert.equal(byKey(A.weaponAndArmorLines(snap), "damage").text, "Damage: 5.85 - 9, Bludgeoning");
  const flat = { ...SWORD, weaponProfile: { ...SWORD.weaponProfile, damage: 12, damage_variance: 0, damage_type: 0 } };
  assert.equal(byKey(A.weaponAndArmorLines(flat), "damage").text, "Damage: 12, unknown type");
  const multi = { ...SWORD, weaponProfile: { ...SWORD.weaponProfile, damage_type: 0x1 | 0x2 } };
  assert.equal(byKey(A.weaponAndArmorLines(multi), "damage").value, "13.5 - 27, Slashing/Piercing");
  const unknown = { ...SWORD, weaponProfile: { ...SWORD.weaponProfile, damage: 0xFFFFFFFF, weapon_time: 0xFFFFFFFF } };
  const u = A.weaponAndArmorLines(unknown);
  assert.equal(byKey(u, "damage").text, "Damage: Unknown");
  assert.equal(byKey(u, "speed").text, "Speed:  Unknown");
});

test("damage line tint: Damage bit 0x8 first, else DamageVariance bit 0x10", () => {
  const dmgUp = { ...SWORD, weaponHighlight: 0x8, weaponColor: 0x8 };
  assert.equal(byKey(A.weaponAndArmorLines(dmgUp), "damage").tone, "buffed");
  const varDown = { ...SWORD, weaponHighlight: 0x10, weaponColor: 0 };
  assert.equal(byKey(A.weaponAndArmorLines(varDown), "damage").tone, "debuffed");
});

test("enchantment tints need the WEAPON_ENCH identify flag (or no flags at all)", () => {
  const unflagged = { ...SWORD, identifyFlags: 0x1 | 0x20 };
  assert.equal(byKey(A.weaponAndArmorLines(unflagged), "attackSkill").tone, null);
  const noFlags = { ...SWORD, identifyFlags: 0 };
  assert.equal(byKey(A.weaponAndArmorLines(noFlags), "attackSkill").tone, "buffed");
  // A response without the WEAPON_PROFILE flag carries no weapon lines.
  const noProfile = { ...SWORD, identifyFlags: 0x1 };
  assert.deepEqual(A.weaponAndArmorLines(noProfile), []);
});

test("bow: Damage Bonus (no types), Elemental Damage Bonus, Damage Modifier, Range, ammo — no Attack Skill", () => {
  const lines = A.weaponAndArmorLines(BOW);
  assert.deepEqual(texts(lines), [
    "Skill: Missile Weapons (Bow)",
    "Damage Bonus: 4",
    "Elemental Damage Bonus: 10, Fire.",
    "Damage Modifier: +40%.",
    "Speed: Fast (30)",
    "Range: 85 yds. (based on STRENGTH 100)",
    "Uses arrows as ammunition.",
  ]);
  assert.equal(byKey(lines, "damageModifier").tone, "buffed");
  assert.equal(byKey(lines, "damageModifier").value, "+40%");
  assert.equal(byKey(lines, "attackSkill"), undefined, "ammo launchers suppress Bonus to Attack Skill (:231563)");
  const exact = { ...BOW, weaponProfile: { ...BOW.weaponProfile, max_velocity: 20, max_velocity_estimated: 0 } };
  assert.equal(byKey(A.weaponAndArmorLines(exact), "range").text, "Range: 40 yds.");
  const crossbow = { ...BOW, properties: { ...BOW.properties, ints: { ValidLocations: 0x400000, AmmoType: 2 } } };
  assert.ok(texts(A.weaponAndArmorLines(crossbow)).includes("Uses quarrels as ammunition."));
});

test("thrown weapon (missile, no ammo type): Damage with type, Range, Attack Skill, no ammo line", () => {
  const darts = {
    identifySuccess: true, identifyFlags: 0,
    properties: { ints: { ValidLocations: 0x400000, WeaponType: 10 }, floats: {}, bools: {}, strings: {} },
    weaponProfile: {
      damage_type: 0x2, weapon_time: 20, weapon_skill: 47, damage: 20, damage_variance: 0.5,
      damage_mod: 1.0, weapon_length: 1, max_velocity: 20, weapon_offense: 1.05, max_velocity_estimated: 0,
    },
  };
  assert.deepEqual(texts(A.weaponAndArmorLines(darts)), [
    "Skill: Missile Weapons (Thrown)",
    "Damage: 10 - 20, Piercing",
    "Speed: Fast (20)",
    "Range: 40 yds.",
    "Bonus to Attack Skill: +5%.",
  ]);
});

test("arrows: no Speed (lm & 0x2500000), 'Used as ammunition by bows.'", () => {
  const arrows = {
    identifySuccess: true, identifyFlags: 0,
    properties: { ints: { ValidLocations: 0x800000, AmmoType: 1 }, floats: {}, bools: {}, strings: {} },
    weaponProfile: {
      damage_type: 0x2, weapon_time: 0, weapon_skill: 47, damage: 8, damage_variance: 0.25,
      damage_mod: 1.0, weapon_length: 1, max_velocity: 1, weapon_offense: 1.0, max_velocity_estimated: 0,
    },
  };
  assert.deepEqual(texts(A.weaponAndArmorLines(arrows)), [
    "Skill: Missile Weapons",
    "Damage: 6 - 8, Piercing",
    "Used as ammunition by bows.",
  ]);
});

test("shield: Base Shield Level (armor bit 0x1) + Effective Shield Level from the viewer's Shield skill", () => {
  const spec = A.weaponAndArmorLines(SHIELD, { shieldSkill: { current: 300, training: 3 } });
  assert.deepEqual(texts(spec), [
    "Base Shield Level: 220",
    "Effective Shield Level : 220 (with Shield skill)",
  ]);
  assert.equal(byKey(spec, "baseShieldLevel").tone, "buffed");
  assert.ok(spec.every((l) => l.group === "armor"));
  // Trained (SAC < 3): halved; capped at the shield level.
  const trained = A.weaponAndArmorLines(SHIELD, { shieldSkill: () => ({ current: 181, training: 2 }) });
  assert.equal(byKey(trained, "effectiveShieldLevel").text, "Effective Shield Level : 90 (with Shield skill)");
  assert.equal(byKey(trained, "effectiveShieldLevel").value, "90 (with Shield skill)");
  // No skill known → retail's zeroed out-params.
  assert.equal(byKey(A.weaponAndArmorLines(SHIELD), "effectiveShieldLevel").text, "Effective Shield Level : 0 (with Shield skill)");
  const unknown = { ...SHIELD, properties: { ...SHIELD.properties, ints: { ValidLocations: 0x200000 } } };
  assert.deepEqual(texts(A.weaponAndArmorLines(unknown)), ["Shield Level: Unknown"]);
});

test("armor / clothing (not wieldable): 'Covers …' from ClothingPriority", () => {
  const coat = {
    identifySuccess: true, identifyFlags: 0,
    properties: { ints: { ValidLocations: 0x600, ClothingPriority: 0x400 | 0x800 | 0x1000 }, floats: {}, bools: {}, strings: {} },
  };
  const lines = A.weaponAndArmorLines(coat);
  assert.deepEqual(texts(lines), ["Covers Chest, Abdomen, Upper Arms"]);
  assert.equal(lines[0].label, undefined, "a sentence, rendered as prose");
  assert.equal(lines[0].group, "armor");
  // A known ValidLocations of 0 prints nothing, as in retail.
  const none = { ...coat, properties: { ...coat.properties, ints: { ValidLocations: 0, ClothingPriority: 0x400 } } };
  assert.deepEqual(A.weaponAndArmorLines(none), []);
});

test("a weapon profile without a known ValidLocations still reads as a melee weapon", () => {
  const bare = { ...SWORD, properties: { ...SWORD.properties, ints: { WeaponType: 2 } } };
  assert.deepEqual(texts(A.weaponAndArmorLines(bare)), texts(A.weaponAndArmorLines(SWORD)));
});

// ── Appraisal_ShowDefenseModData ──────────────────────────────────────

test("defense mods: SmallModifierToString, melee tinted by weapon bit 0x2, 1.0 skipped", () => {
  const lines = A.defenseModLines(SWORD);
  assert.deepEqual(texts(lines), [
    "Bonus to Melee Defense: +20.0%.",
    "Bonus to Missile Defense: +5.0%.",
  ]);
  assert.equal(byKey(lines, "meleeDefense").tone, "debuffed");
  assert.equal(byKey(lines, "meleeDefense").value, "+20.0%");
  assert.equal(byKey(lines, "missileDefense").tone, null);
  const magic = { properties: { floats: { WeaponMagicDefense: 1.12 } } };
  assert.deepEqual(texts(A.defenseModLines(magic)), ["Bonus to Magic Defense: +12.0%."]);
  assert.deepEqual(A.defenseModLines({ properties: { floats: {} } }), []);
});

// ── Appraisal_ShowCasterData ──────────────────────────────────────────

test("wand: Mana Conversion, elemental spell damage vs. Monsters / vs. Players ((m − 1) × 0.25 + 1)", () => {
  const lines = A.casterLines(WAND);
  assert.deepEqual(texts(lines), [
    "Bonus to Mana Conversion: +8%.",
    "Damage bonus for Fire spells:",
    " vs. Monsters: +10.0%.",
    " vs. Players: +2.5%.",
  ]);
  assert.equal(byKey(lines, "manaConversion").tone, null);
  assert.equal(byKey(lines, "elementalSpells").tone, "buffed");
  assert.equal(byKey(lines, "elementalSpells").label, undefined);
  assert.equal(byKey(lines, "vsMonsters").tone, "buffed");
  assert.equal(byKey(lines, "vsMonsters").label, "vs. Monsters");
  assert.equal(byKey(lines, "vsPlayers").value, "+2.5%");
  assert.equal(A.ELEMENTAL_MOD_PK_MODIFIER, 0.25);
  // The wand's melee defense is the defense-mod builder's.
  assert.deepEqual(texts(A.defenseModLines(WAND)), ["Bonus to Melee Defense: +15.0%."]);
  // No weapon profile, held slot: no weapon / ammo lines.
  assert.deepEqual(A.weaponAndArmorLines(WAND), []);
});

test("caster: resist tints need RESIST_ENCH; elemental lines need DamageType", () => {
  const unflagged = { ...WAND, identifyFlags: 0x1 | 0x4 };
  assert.equal(byKey(A.casterLines(unflagged), "vsPlayers").tone, null);
  const manaUp = { ...WAND, resistHighlight: 0x1000, resistColor: 0 };
  assert.equal(byKey(A.casterLines(manaUp), "manaConversion").tone, "debuffed");
  const noType = { ...WAND, properties: { ...WAND.properties, ints: { ValidLocations: 0x1000000 } } };
  assert.deepEqual(texts(A.casterLines(noType)), ["Bonus to Mana Conversion: +8%."]);
  const negative = { properties: { floats: { ManaConversionMod: -0.05 } } };
  assert.deepEqual(texts(A.casterLines(negative)), ["Bonus to Mana Conversion: -5%."]);
});

// ── Appraisal_ShowActivationRequirements ──────────────────────────────

test("activation: 'Activation requires Arcane Lore: N, <skill>: N'", () => {
  const item = { properties: { ints: { ItemDifficulty: 250, ItemSkillLevelLimit: 200, AppraisalItemSkill: 34 } } };
  assert.deepEqual(texts(A.activationRequirementLines(item)), ["Activation requires Arcane Lore: 250, War Magic: 200"]);
});

test("activation: every part in retail order + the allowed-activator line", () => {
  const item = {
    properties: {
      ints: {
        ItemDifficulty: 300, ItemAllegianceRankLimit: 2, HeritageGroup: 1,
        ItemSkillLevelLimit: 350, AppraisalItemSkill: 44,
        ItemAttributeLevelLimit: 150, ItemAttributeLimit: 1,
        ItemAttribute2ndLevelLimit: 200, ItemAttribute2ndLimit: 1,
      },
      bools: { AppraisalHasAllowedActivator: true },
      strings: { CraftsmanName: "Turbine" },
    },
  };
  const lines = A.activationRequirementLines(item);
  assert.deepEqual(texts(lines), [
    "Activation requires Arcane Lore: 300, Allegiance Rank: 2, Aluvian, Heavy Weapons: 350, Strength: 150, Maximum Health: 200",
    "This item can only be activated by Turbine.",
  ]);
  assert.ok(lines.every((l) => l.label === undefined && l.tone === null));
});

test("activation: zero / missing limits are skipped; a failed appraisal prints nothing", () => {
  assert.deepEqual(A.activationRequirementLines({ properties: { ints: { ItemDifficulty: 0 } } }), []);
  assert.deepEqual(A.activationRequirementLines({ properties: { ints: { ItemSkillLevelLimit: 200 } } }), []);
  assert.deepEqual(A.activationRequirementLines({ properties: { ints: { ItemAllegianceRankLimit: 0 } } }), []);
  assert.deepEqual(
    texts(A.activationRequirementLines({ properties: { bools: { AppraisalHasAllowedActivator: true } } })),
    ["This item can only be activated by the original owner."],
  );
  assert.deepEqual(
    A.activationRequirementLines({ identifySuccess: false, properties: { ints: { ItemDifficulty: 250 } } }),
    [],
  );
});

// ── examine-target.js wiring (source pins) ────────────────────────────

test("examine-target.js imports the builders and drops the old rows", () => {
  const src = readFileSync(new URL("../plugins/examine-target.js", import.meta.url), "utf8");
  assert.match(src, /weaponAndArmorLines, defenseModLines, casterLines, activationRequirementLines,\n\} from "\.\/appraisal_text\.js";/);
  assert.doesNotMatch(src, /row\("Damage bonus"/);
  assert.doesNotMatch(src, /row\("Arcane Lore to activate"/);
  assert.match(src, /for \(const line of activationLines\) appraisalLine\(wrapEl, line\);/);
  assert.doesNotMatch(src, /row\("Skill", skillName\(wp\.weapon_skill\), \{ tone: weaponTone\(0x0001\) \}\)/);
});

// ── examine panel DOM (fake DOM, real mountExamineBody) ────────────────

globalThis.window = globalThis;
installFakeDom(globalThis);

const ITEMS = [
  { guid: 0x50000011, name: "Tachi", value: 5000, stackSize: 1, itemType: 0x1, equipMask: 0, validLocations: 0x100000, iconId: 0 },
  { guid: 0x50000012, name: "Wand", value: 5000, stackSize: 1, itemType: 0x8000, equipMask: 0, validLocations: 0x1000000, iconId: 0 },
  { guid: 0x50000013, name: "Kite Shield", value: 500, stackSize: 1, itemType: 0x2, equipMask: 0, validLocations: 0x200000, iconId: 0 },
];
const APPRAISALS = new Map([
  [0x50000011, {
    ...SWORD,
    properties: {
      ...SWORD.properties,
      ints: { ...SWORD.properties.ints, ItemWorkmanship: 6, ItemDifficulty: 250, ItemSkillLevelLimit: 200, AppraisalItemSkill: 44, ItemSpellcraft: 120 },
    },
  }],
  [0x50000012, WAND],
  [0x50000013, SHIELD],
]);
window.__sessionHandle = {
  playerInventory: () => ITEMS,
  getObjectAppraisal: (g) => (APPRAISALS.has(g) ? JSON.stringify(APPRAISALS.get(g)) : undefined),
  requestAppraisal: () => {},
  getObjectInscription: () => undefined,
  getSpellRecord: () => null,
};
// Viewer: Shield skill 48 specialized at 300 (stride-6 playerStats skills).
window.__pluginClient = {
  events: { on() {}, off() {}, emit() {} },
  player: { stats: { skills: [48, 300, 250, 10, 3, 0] } },
};

const exa = await import(new URL("../plugins/examine-target.js", import.meta.url).href);

function mount(guid) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const cleanup = exa.mountExamineBody(host, { guid, fromInventory: true });
  const wrap = host.querySelector(".hb-exa-appraisal-wrap");
  return { wrap, done: () => { cleanup?.(); host.remove(); } };
}
function section(wrap, title) {
  const kids = wrap.children;
  const i = kids.findIndex((k) => k.classList.contains("hbk-section-title") && k.textContent === title);
  if (i < 0) return null;
  let j = i + 1;
  while (j < kids.length && !kids[j].classList.contains("hbk-section-title")) j++;
  return kids.slice(i + 1, j);
}
const rowFor = (els, label) => els.find((e) => e.classList.contains("hbk-kv") && e.children[0]?.textContent === label);

test("panel: the sword's Weapon section reads retail's lines, Attack Skill tinted, Skill not", () => {
  const { wrap, done } = mount(0x50000011);
  try {
    const weapon = section(wrap, "Weapon");
    assert.ok(weapon, "Weapon section");
    const text = weapon.map((e) => visibleText(e)).join(" | ");
    assert.match(text, /Skill Heavy Weapons \(Sword\)/);
    assert.match(text, /Damage 13\.5 - 27, Slashing/);
    assert.match(text, /Speed Average \(35\)/);
    assert.match(text, /Bonus to Attack Skill \+15%/);
    assert.match(text, /Bonus to Melee Defense \+20\.0%/);
    assert.match(text, /Bonus to Missile Defense \+5\.0%/);
    assert.doesNotMatch(text, /Damage bonus/);
    assert.ok(rowFor(weapon, "Bonus to Attack Skill").classList.contains("is-buffed"));
    assert.ok(rowFor(weapon, "Bonus to Melee Defense").classList.contains("is-debuffed"));
    const skill = rowFor(weapon, "Skill");
    assert.ok(!skill.classList.contains("is-buffed") && !skill.classList.contains("is-debuffed"));
    const magic = section(wrap, "Magic").map((e) => visibleText(e)).join(" | ");
    assert.match(magic, /Activation requires Arcane Lore: 250, Heavy Weapons: 200/);
    assert.doesNotMatch(visibleText(wrap), /Arcane Lore to activate/);
  } finally { done(); }
});

test("panel: the wand's caster lines sit under Weapon, tinted by resist bit 0x2000", () => {
  const { wrap, done } = mount(0x50000012);
  try {
    const weapon = section(wrap, "Weapon");
    assert.ok(weapon, "Weapon section for a caster");
    const text = weapon.map((e) => visibleText(e)).join(" | ");
    assert.match(text, /Bonus to Melee Defense \+15\.0%/);
    assert.match(text, /Bonus to Mana Conversion \+8%/);
    assert.match(text, /Damage bonus for Fire spells:/);
    assert.match(text, /vs\. Monsters \+10\.0%/);
    assert.match(text, /vs\. Players \+2\.5%/);
    assert.ok(rowFor(weapon, "vs. Players").classList.contains("is-buffed"));
    assert.ok(!rowFor(weapon, "Bonus to Mana Conversion").classList.contains("is-buffed"));
  } finally { done(); }
});

test("panel: the shield's Armor section has both shield levels (viewer's Shield skill) and Armor Level", () => {
  const { wrap, done } = mount(0x50000013);
  try {
    const armor = section(wrap, "Armor");
    assert.ok(armor, "Armor section");
    const text = armor.map((e) => visibleText(e)).join(" | ");
    assert.match(text, /Base Shield Level 220/);
    assert.match(text, /Effective Shield Level 220 \(with Shield skill\)/);
    assert.match(text, /Armor Level 220/);
    assert.ok(rowFor(armor, "Base Shield Level").classList.contains("is-buffed"));
    assert.equal(section(wrap, "Weapon"), null);
  } finally { done(); }
});
