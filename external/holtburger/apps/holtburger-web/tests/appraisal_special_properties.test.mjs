// tests/appraisal_special_properties.test.mjs — examine-text-6 (2026-10-13),
// phase 1.
//
// The EoR item lines the examine panel never printed, each re-derived from
// acclient.c (plugins/appraisal_text.js):
//   - ItemExamineUI::Appraisal_ShowSet (:229498): "Set: <name>" from the
//     InqInt(0x109) switch;
//   - ::Appraisal_ShowRatings (:229906): "Ratings: Dam N, …." in retail's
//     order (Crit Dam before Crit Resist) + "This item adds N Vitality.";
//   - ::Appraisal_ShowSpecialProperties (:230639): Unique, "Cooldown When
//     Used" (ClientUISystem::DeltaTimeToString, :403033), "Cleave", the
//     comma-joined "Properties: …" line, "This item cannot be further
//     imbued." and "This item is tethered to the left side.";
//   - ::Appraisal_ShowItemLevelInfo (:233065): "Item Level: L / Max" and
//     "Item XP: a / b" (ExperienceSystem::ItemTotalXPToLevel /
//     ItemLevelToTotalXP, :499244 / :499191) + the cloak proc sentence.
// The examine panel renders them (fake DOM, real mountExamineBody): a
// "Set & Ratings" block above the Weapon section, the retail Properties
// lines ahead of Requirements, Item Level in Requirements.
//
// Run: node tests/appraisal_special_properties.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installFakeDom, visibleText } from "./helpers/fake_dom_items.mjs";

const A = await import(new URL("../plugins/appraisal_text.js", import.meta.url).href);

const texts = (lines) => lines.map((l) => l.text);
const byKey = (lines, key) => lines.find((l) => l.key === key);

// An EoR loot sword: Slash Rending + Melee Defense imbue, Olthoi slayer,
// Soldier's set, Dam 3 / Crit 2, cleave 2, a 90 s cooldown.
const EOR_SWORD = Object.freeze({
  identifySuccess: true,
  identifyFlags: 0x1 | 0x4 | 0x20,
  properties: {
    ints: {
      ValidLocations: 0x100000, WeaponType: 2,
      ImbuedEffect: 0x8 | 0x400, SlayerCreatureType: 1, EquipmentSetId: 13,
      GearCrit: 2, GearDamage: 3, Cleaving: 2,
    },
    floats: { CooldownDuration: 90 },
    bools: {}, strings: {}, int64s: {}, dids: {},
  },
  weaponProfile: {
    damage_type: 1, weapon_time: 35, weapon_skill: 44, damage: 27, damage_variance: 0.5,
    damage_mod: 1.0, weapon_length: 1.0, max_velocity: 1.0, weapon_offense: 1.0,
    max_velocity_estimated: 0,
  },
});

// Every Properties word at once, to pin AppendHelper's order.
const EVERYTHING = Object.freeze({
  properties: {
    ints: {
      SlayerCreatureType: 19, AttackType: 0x20, ImbuedEffect: 0x8, ImbuedEffect2: 0x400,
      ResistMagic: 9999, Attuned: 1, Bonded: 1, ResistanceModifierType: 0x10, Unique: 1,
    },
    floats: {
      AbsorbMagicDamage: 0.25, CriticalMultiplier: 3, CriticalFrequency: 0.15,
      IgnoreArmor: 0.2, ResistanceModifier: 1.5,
    },
    bools: { Retained: true, Ivoryable: true, Dyable: true, AutowieldLeft: true },
    strings: {},
    dids: { ProcSpell: 0x0000081C },
  },
});

const AETHERIA = Object.freeze({
  identifySuccess: true,
  identifyFlags: 0x1 | 0x2000,
  properties: {
    ints: { ItemMaxLevel: 5, ItemXpStyle: 2, EquipmentSetId: 36 },
    int64s: { ItemBaseXp: 1000000000, ItemTotalXp: 3500000000 },
    floats: {}, bools: {}, strings: {}, dids: {},
  },
});

// ── Appraisal_ShowSet ─────────────────────────────────────────────────

test("ShowSet: 'Set: <name>' from the decomp switch (no period), unnamed ids print nothing", () => {
  const lines = A.equipmentSetLines(EOR_SWORD);
  assert.deepEqual(texts(lines), ["Set: Soldier's"]);
  assert.equal(lines[0].label, "Set");
  assert.equal(lines[0].value, "Soldier's");
  assert.equal(lines[0].tone, null);
  const set = (id) => texts(A.equipmentSetLines({ properties: { ints: { EquipmentSetId: id } } }));
  assert.deepEqual(set(4), ["Set: Carraida's Benediction"]);
  assert.deepEqual(set(36), ["Set: Sigil of Destruction"]);
  assert.deepEqual(set(83), ["Set: Weave of Assess Creature"]);
  assert.deepEqual(set(91), ["Set: Shrouded Soul"]);
  assert.deepEqual(set(130), ["Set: Shimmering Shadows"]);
  // Retired Weave ids fold onto the merged skills.
  for (const id of [53, 67, 74, 75, 79]) assert.deepEqual(set(id), ["Set: Weave of Light Weapons"]);
  for (const id of [54, 57, 77]) assert.deepEqual(set(id), ["Set: Weave of Missile Weapons"]);
  // No case in the switch → nothing.
  for (const id of [0, 1, 2, 3, 34, 42, 48, 131, -1]) assert.deepEqual(set(id), [], `set ${id}`);
  assert.deepEqual(A.equipmentSetLines({ properties: {} }), []);
  assert.equal(Object.keys(A.EQUIPMENT_SET_NAMES).length, 119);
});

// ── Appraisal_ShowRatings ─────────────────────────────────────────────

test("ShowRatings: 'Ratings: Dam 3, Crit 2.' as a kv row", () => {
  const lines = A.ratingLines(EOR_SWORD);
  assert.deepEqual(texts(lines), ["Ratings: Dam 3, Crit 2."]);
  assert.equal(lines[0].label, "Ratings");
  assert.equal(lines[0].value, "Dam 3, Crit 2");
});

test("ShowRatings: retail order (Crit Dam before Crit Resist), > 0 only, then the Vitality sentence", () => {
  const all = {
    properties: {
      ints: {
        GearLifeResist: 9, GearNetherResist: 8, GearHealingBoost: 7, GearCritDamageResist: 6,
        GearCritResist: 5, GearCritDamage: 4, GearCrit: 3, GearDamageResist: 2, GearDamage: 1,
        GearMaxHealth: 10,
      },
    },
  };
  const lines = A.ratingLines(all);
  assert.deepEqual(texts(lines), [
    "Ratings: Dam 1, Dam Resist 2, Crit 3, Crit Dam 4, Crit Resist 5, Crit Dam Resist 6, "
      + "Heal Boost 7, Nether Resist 8, Life Resist 9.",
    "This item adds 10 Vitality.",
  ]);
  assert.equal(byKey(lines, "vitality").label, undefined, "the Vitality line is prose");
  const vitOnly = { properties: { ints: { GearMaxHealth: 25, GearDamage: 0, GearCrit: -1 } } };
  assert.deepEqual(texts(A.ratingLines(vitOnly)), ["This item adds 25 Vitality."]);
  assert.deepEqual(A.ratingLines({ properties: { ints: { GearDamage: 0 } } }), []);
});

// ── ClientUISystem::DeltaTimeToString ─────────────────────────────────

test("DeltaTimeToString: 30-day months, non-zero units, seconds always, no trailing space", () => {
  assert.equal(A.deltaTimeToString(90), "1m 30s");
  assert.equal(A.deltaTimeToString(0), "0s");
  assert.equal(A.deltaTimeToString(60), "1m 0s");
  assert.equal(A.deltaTimeToString(3600), "1h 0s");
  assert.equal(A.deltaTimeToString(86400 * 3 + 5), "3d 5s");
  assert.equal(A.deltaTimeToString(2592000 * 2 + 3661), "2mo 1h 1m 1s");
  assert.equal(A.deltaTimeToString(45.9), "45s", "truncated like the (unsigned __int64) cast");
  assert.equal(A.deltaTimeToString(undefined), "0s");
});

// ── Appraisal_ShowSpecialProperties ───────────────────────────────────

test("EoR sword: Cooldown, Cleave, the Properties line in retail order, then the imbue sentence", () => {
  const lines = A.specialPropertyLines(EOR_SWORD);
  assert.deepEqual(texts(lines), [
    "Cooldown When Used: 1m 30s",
    "Cleave: 2 enemies in front arc.",
    "Properties: Olthoi slayer, Slash Rending, +1 Melee Defense",
    "This item cannot be further imbued.",
  ]);
  assert.equal(byKey(lines, "cooldown").label, "Cooldown When Used");
  assert.equal(byKey(lines, "cooldown").value, "1m 30s");
  assert.equal(byKey(lines, "cleave").value, "2 enemies in front arc");
  assert.equal(byKey(lines, "properties").label, undefined, "the Properties line is prose");
  assert.ok(lines.every((l) => l.tone === null));
});

test("Properties: every word in AppendHelper order + Unique + the tethered sentence", () => {
  const lines = A.specialPropertyLines(EVERYTHING);
  assert.deepEqual(texts(lines), [
    "You can only carry 1 of these items.",
    "Properties: Virindi slayer, Multi-Strike, Slash Rending, +1 Melee Defense, Magic Absorbing, "
      + "Unenchantable, Attuned, Bonded, Retained, Crushing Blow, Biting Strike, Armor Cleaving, "
      + "Resistance Cleaving: Fire, Cast on Strike, Ivoryable, Dyeable",
    "This item cannot be further imbued.",
    "This item is tethered to the left side.",
  ]);
});

test("imbue bits: OR of ImbuedEffect..5, Nether between Acid and Cold, 0x80000000 = Phantasmal", () => {
  const item = {
    properties: {
      ints: { ImbuedEffect: 0x1 | 0x80, ImbuedEffect3: 0x4000 | 0x40, ImbuedEffect5: 0x80000000 | 0 },
    },
  };
  assert.equal(
    byKey(A.specialPropertyLines(item), "properties").text,
    "Properties: Critical Strike, Acid Rending, Nether Rending, Cold Rending, Phantasmal",
  );
  const rest = { properties: { ints: { ImbuedEffect4: 0x2 | 0x4 | 0x10 | 0x20 | 0x100 | 0x200 | 0x800 | 0x1000 } } };
  assert.equal(
    byKey(A.specialPropertyLines(rest), "properties").text,
    "Properties: Crippling Blow, Armor Rending, Pierce Rending, Bludgeon Rending, Lightning Rending, "
      + "Fire Rending, +1 Missile Defense, +1 Magic Defense",
  );
  // A nameless bit (Spellbook 0x2000) still blocks further imbues.
  assert.deepEqual(texts(A.specialPropertyLines({ properties: { ints: { ImbuedEffect: 0x2000 } } })), [
    "This item cannot be further imbued.",
  ]);
  assert.equal(A.IMBUED_EFFECT_NAMES.length, 15);
});

test("slayer: Human (31) reads Bael'Zharon's Hate; an unknown creature type adds nothing", () => {
  const slayer = (ct) => byKey(A.specialPropertyLines({ properties: { ints: { SlayerCreatureType: ct } } }), "properties")?.text;
  assert.equal(slayer(31), "Properties: Bael'Zharon's Hate");
  assert.equal(slayer(14), "Properties: Undead slayer");
  assert.equal(slayer(9999), undefined);
  assert.equal(slayer(0), undefined);
});

test("thresholds: Cleave needs > 1, Unenchantable ≥ 9999, Multi-Strike needs AttackType & 0x79E0", () => {
  assert.deepEqual(A.specialPropertyLines({ properties: { ints: { Cleaving: 1 } } }), []);
  assert.deepEqual(A.specialPropertyLines({ properties: { ints: { ResistMagic: 9998 } } }), []);
  assert.deepEqual(
    texts(A.specialPropertyLines({ properties: { ints: { ResistMagic: 10000 } } })),
    ["Properties: Unenchantable"],
  );
  // Thrust | Slash (0x6) is a plain weapon.
  assert.deepEqual(A.specialPropertyLines({ properties: { ints: { AttackType: 0x6 } } }), []);
  assert.deepEqual(
    texts(A.specialPropertyLines({ properties: { ints: { AttackType: 0x4000 } } })),
    ["Properties: Multi-Strike"],
  );
  // Resistance Cleaving needs both the float and the type.
  assert.deepEqual(A.specialPropertyLines({ properties: { floats: { ResistanceModifier: 1.5 } } }), []);
  assert.equal(
    A.specialPropertyLines({ properties: { floats: { ResistanceModifier: 2 }, ints: { ResistanceModifierType: 0x40 } } })[0].text,
    "Properties: Resistance Cleaving: Electrical",
  );
  // Bools must be true; Bonded 0 / Attuned 0 have no word.
  assert.deepEqual(
    A.specialPropertyLines({ properties: { bools: { Retained: false, Ivoryable: false }, ints: { Bonded: 0, Attuned: 0 } } }),
    [],
  );
  assert.equal(
    A.specialPropertyLines({ properties: { ints: { Bonded: -1 } } })[0].text,
    "Properties: Dropped on Death",
  );
  assert.equal(
    A.specialPropertyLines({ properties: { ints: { Unique: 1500 } } })[0].text,
    "You can only carry 1,500 of these items.",
  );
});

test("opts.attuned / opts.bonded replace the bag's words (the panel passes examine-text-3's)", () => {
  const item = { properties: { ints: { Attuned: 1, Bonded: 1 } } };
  assert.equal(A.specialPropertyLines(item)[0].text, "Properties: Attuned, Bonded");
  assert.equal(A.specialPropertyLines(item, { attuned: null, bonded: "Bonded" })[0].text, "Properties: Bonded");
  assert.equal(A.specialPropertyLines(item, null)[0].text, "Properties: Attuned, Bonded");
});

test("Cooldown Remaining: only with SharedCooldown and a positive opts.cooldownRemaining(id)", () => {
  const item = { properties: { ints: { SharedCooldown: 7 }, floats: { CooldownDuration: 300 } } };
  const seen = [];
  const lines = A.specialPropertyLines(item, { cooldownRemaining: (id) => { seen.push(id); return 125.7; } });
  assert.deepEqual(seen, [7]);
  assert.deepEqual(texts(lines), ["Cooldown When Used: 5m 0s", "Cooldown Remaining: 2m 5s"]);
  assert.equal(byKey(lines, "cooldownRemaining").value, "2m 5s");
  assert.deepEqual(texts(A.specialPropertyLines(item, { cooldownRemaining: () => 0 })), ["Cooldown When Used: 5m 0s"]);
  assert.deepEqual(texts(A.specialPropertyLines(item, { cooldownRemaining: () => null })), ["Cooldown When Used: 5m 0s"]);
  assert.deepEqual(texts(A.specialPropertyLines(item)), ["Cooldown When Used: 5m 0s"]);
  const noShared = { properties: { floats: { CooldownDuration: 10 } } };
  let called = false;
  A.specialPropertyLines(noShared, { cooldownRemaining: () => { called = true; return 5; } });
  assert.equal(called, false, "no SharedCooldown → no registry lookup");
});

// ── Appraisal_ShowItemLevelInfo ───────────────────────────────────────

test("item XP curves: style 1 linear, 2 doubling, 3 arithmetic; capped at the max level", () => {
  const B = 1000;
  assert.equal(A.itemTotalXpToLevel(2500, B, 10, 1), 2);
  assert.equal(A.itemTotalXpToLevel(999, B, 10, 2), 0);
  assert.equal(A.itemTotalXpToLevel(1000, B, 10, 2), 1);
  assert.equal(A.itemTotalXpToLevel(2999, B, 10, 2), 1);
  assert.equal(A.itemTotalXpToLevel(3000, B, 10, 2), 2);
  assert.equal(A.itemTotalXpToLevel(7000, B, 10, 2), 3);
  assert.equal(A.itemTotalXpToLevel(3000, B, 10, 3), 2); // 1000 + 2000
  assert.equal(A.itemTotalXpToLevel(5999, B, 10, 3), 2);
  assert.equal(A.itemTotalXpToLevel(6000, B, 10, 3), 3); // + 3000
  assert.equal(A.itemTotalXpToLevel(1e12, B, 5, 2), 5, "capped");
  assert.equal(A.itemTotalXpToLevel(1e9, B, 5, 1), 5, "capped");
  assert.equal(A.itemTotalXpToLevel(5000, B, 5, 4), 0, "unknown style");
  assert.equal(A.itemLevelToTotalXp(0, B, 5, 2), 0);
  assert.equal(A.itemLevelToTotalXp(1, B, 5, 2), 1000);
  assert.equal(A.itemLevelToTotalXp(3, B, 5, 2), 7000);
  assert.equal(A.itemLevelToTotalXp(9, B, 5, 2), 31000, "clamped to the max level");
  assert.equal(A.itemLevelToTotalXp(3, B, 5, 1), 3000);
  assert.equal(A.itemLevelToTotalXp(3, B, 5, 3), 6000);
  assert.equal(A.itemLevelToTotalXp(3, B, 5, 4), 0, "unknown style");
  // Round trip: the total for level L reads back as L.
  for (const style of [1, 2, 3]) {
    for (let l = 1; l <= 8; l++) {
      assert.equal(A.itemTotalXpToLevel(A.itemLevelToTotalXp(l, B, 8, style), B, 8, style), l, `style ${style} L${l}`);
    }
  }
});

test("Aetheria: 'Item Level: 2 / 5' + 'Item XP: 3,500,000,000 / 7,000,000,000' as kv rows", () => {
  const lines = A.itemLevelLines(AETHERIA);
  assert.deepEqual(texts(lines), ["Item Level: 2 / 5", "Item XP: 3,500,000,000 / 7,000,000,000"]);
  assert.equal(byKey(lines, "itemLevel").label, "Item Level");
  assert.equal(byKey(lines, "itemLevel").value, "2 / 5");
  assert.equal(byKey(lines, "itemXp").value, "3,500,000,000 / 7,000,000,000");
  // At the cap the second number is the max level's total.
  const maxed = { properties: { ...AETHERIA.properties, int64s: { ItemBaseXp: 1000000000, ItemTotalXp: 40000000000 } } };
  assert.deepEqual(texts(A.itemLevelLines(maxed)), ["Item Level: 5 / 5", "Item XP: 40,000,000,000 / 31,000,000,000"]);
  // No XP yet: level 0, the first level's cost.
  const fresh = { properties: { ...AETHERIA.properties, int64s: { ItemBaseXp: 1000000000 } } };
  assert.deepEqual(texts(A.itemLevelLines(fresh)), ["Item Level: 0 / 5", "Item XP: 0 / 1,000,000,000"]);
});

test("item level: needs ItemBaseXp, ItemMaxLevel and ItemXpStyle > 0; the cloak proc sentence", () => {
  const p = AETHERIA.properties;
  assert.deepEqual(A.itemLevelLines({ properties: { ...p, int64s: {} } }), []);
  assert.deepEqual(A.itemLevelLines({ properties: { ...p, ints: { ItemXpStyle: 2 } } }), []);
  assert.deepEqual(A.itemLevelLines({ properties: { ...p, ints: { ItemMaxLevel: 5, ItemXpStyle: 0 } } }), []);
  const cloak = {
    properties: {
      ints: { ItemMaxLevel: 3, ItemXpStyle: 3, CloakWeaveProc: 2 },
      int64s: { ItemBaseXp: 1000, ItemTotalXp: 3500 },
    },
  };
  const lines = A.itemLevelLines(cloak);
  assert.deepEqual(texts(lines), [
    "Item Level: 2 / 3",
    "Item XP: 3,500 / 6,000",
    "This cloak has a chance to reduce an incoming attack by 200 damage.",
  ]);
  assert.equal(byKey(lines, "cloakProc").label, undefined);
  assert.deepEqual(A.itemLevelLines({ properties: { ints: { CloakWeaveProc: 1 } } }), []);
});

// ── examine-target.js wiring (source pins) ────────────────────────────

test("examine-target.js imports the builders, drops the ' · ' list and keeps creatures out", () => {
  const src = readFileSync(new URL("../plugins/examine-target.js", import.meta.url), "utf8");
  assert.match(src, /equipmentSetLines, ratingLines, specialPropertyLines, itemLevelLines,\n/);
  assert.doesNotMatch(src, /special\.join\(" · "\)/);
  assert.doesNotMatch(src, /\.push\("Cannot be sold"\)/);
  assert.match(src, /if \(notSellable\) prose\(wrapEl, "This item cannot be sold\."\);/);
  assert.match(src, /const specialLines = isItem\n/);
  assert.match(src, /const setRatingLines = isItem \?/);
  assert.match(src, /const itemLevel = isItem \? itemLevelLines\(snapshot\) : \[\];/);
  const props = src.indexOf("// === Properties (Appraisal_ShowSpecialProperties");
  const reqs = src.indexOf("// === Requirements (Appraisal_ShowLevelLimitInfo");
  assert.ok(props > 0 && reqs > props, "Properties ahead of Requirements (SetAppraiseInfo order)");
});

// ── examine panel DOM (fake DOM, real mountExamineBody) ────────────────

globalThis.window = globalThis;
installFakeDom(globalThis);

const ITEMS = [
  { guid: 0x50000021, name: "Olthoi Tachi", value: 9000, stackSize: 1, itemType: 0x1, equipMask: 0, validLocations: 0x100000, iconId: 0 },
  { guid: 0x50000022, name: "Coalesced Aetheria", value: 1000, stackSize: 1, itemType: 0x8, equipMask: 0, validLocations: 0x40000000, iconId: 0 },
  { guid: 0x50000023, name: "Quest Token", value: 0, stackSize: 1, itemType: 0x80, equipMask: 0, validLocations: 0, iconId: 0 },
  { guid: 0x50000024, name: "Old Charm", value: 10, stackSize: 1, itemType: 0x8, equipMask: 0, validLocations: 0, iconId: 0 },
];
const APPRAISALS = new Map([
  [0x50000021, {
    ...EOR_SWORD,
    properties: {
      ...EOR_SWORD.properties,
      ints: { ...EOR_SWORD.properties.ints, Attuned: 1, Bonded: 1, WieldRequirements: 7, WieldSkillType: 1, WieldDifficulty: 150 },
    },
  }],
  [0x50000022, AETHERIA],
  [0x50000023, { properties: { ints: {}, bools: { IsSellable: false, Retained: true }, floats: {}, strings: {} } }],
  // ItemMaxLevel without an XP curve keeps the old fallback row.
  [0x50000024, { properties: { ints: { ItemMaxLevel: 3 }, bools: {}, floats: {}, strings: {} } }],
]);
window.__sessionHandle = {
  playerInventory: () => ITEMS,
  getObjectAppraisal: (g) => (APPRAISALS.has(g) ? JSON.stringify(APPRAISALS.get(g)) : undefined),
  requestAppraisal: () => {},
  getObjectInscription: () => undefined,
  getSpellRecord: () => null,
};
window.__pluginClient = {
  events: { on() {}, off() {}, emit() {} },
  player: { stats: { skills: [] } },
};

const exa = await import(new URL("../plugins/examine-target.js", import.meta.url).href);

function mount(guid) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const cleanup = exa.mountExamineBody(host, { guid, fromInventory: true });
  const wrap = host.querySelector(".hb-exa-appraisal-wrap");
  return { wrap, done: () => { cleanup?.(); host.remove(); } };
}
const titles = (wrap) => wrap.children.filter((k) => k.classList.contains("hbk-section-title")).map((k) => k.textContent);
function section(wrap, title) {
  const kids = wrap.children;
  const i = kids.findIndex((k) => k.classList.contains("hbk-section-title") && k.textContent === title);
  if (i < 0) return null;
  let j = i + 1;
  while (j < kids.length && !kids[j].classList.contains("hbk-section-title")) j++;
  return kids.slice(i + 1, j);
}
const rowFor = (els, label) => els.find((e) => e.classList.contains("hbk-kv") && e.children[0]?.textContent === label);
const proseTexts = (els) => els.filter((e) => e.classList.contains("hb-exa-prose")).map((e) => e.textContent);

test("panel: the EoR sword's Set & Ratings block sits above Weapon, Properties above Requirements", () => {
  const { wrap, done } = mount(0x50000021);
  try {
    const order = titles(wrap);
    assert.ok(order.indexOf("Set & Ratings") >= 0, `sections: ${order.join(", ")}`);
    assert.ok(order.indexOf("Set & Ratings") < order.indexOf("Weapon"));
    assert.ok(order.indexOf("Properties") < order.indexOf("Requirements"));
    const sr = section(wrap, "Set & Ratings");
    assert.equal(rowFor(sr, "Set").children[1].textContent, "Soldier's");
    assert.equal(rowFor(sr, "Ratings").children[1].textContent, "Dam 3, Crit 2");
    const props = section(wrap, "Properties");
    assert.equal(rowFor(props, "Cooldown When Used").children[1].textContent, "1m 30s");
    assert.equal(rowFor(props, "Cleave").children[1].textContent, "2 enemies in front arc");
    assert.deepEqual(proseTexts(props), [
      "Properties: Olthoi slayer, Slash Rending, +1 Melee Defense, Attuned, Bonded",
      "This item cannot be further imbued.",
    ]);
    assert.doesNotMatch(visibleText(wrap), / · /);
    const reqs = section(wrap, "Requirements").map((e) => visibleText(e)).join(" | ");
    assert.match(reqs, /Wield requires level 150/);
  } finally { done(); }
});

test("panel: the Aetheria's Item Level / Item XP rows replace 'Item level cap'", () => {
  const { wrap, done } = mount(0x50000022);
  try {
    const sr = section(wrap, "Set & Ratings");
    assert.equal(rowFor(sr, "Set").children[1].textContent, "Sigil of Destruction");
    const reqs = section(wrap, "Requirements");
    assert.ok(reqs, "Requirements section");
    assert.equal(rowFor(reqs, "Item Level").children[1].textContent, "2 / 5");
    assert.equal(rowFor(reqs, "Item XP").children[1].textContent, "3,500,000,000 / 7,000,000,000");
    assert.equal(rowFor(reqs, "Item level cap"), undefined);
  } finally { done(); }
});

test("panel: 'This item cannot be sold.' closes the Properties block; Retained is in the list", () => {
  const { wrap, done } = mount(0x50000023);
  try {
    const props = section(wrap, "Properties");
    assert.deepEqual(proseTexts(props), ["Properties: Retained", "This item cannot be sold."]);
    assert.equal(section(wrap, "Set & Ratings"), null);
  } finally { done(); }
});

test("panel: an ItemMaxLevel without an XP curve keeps the 'Item level cap' row", () => {
  const { wrap, done } = mount(0x50000024);
  try {
    const reqs = section(wrap, "Requirements");
    assert.equal(rowFor(reqs, "Item level cap").children[1].textContent, "3");
    assert.equal(rowFor(reqs, "Item Level"), undefined);
    assert.equal(section(wrap, "Properties"), null);
  } finally { done(); }
});
