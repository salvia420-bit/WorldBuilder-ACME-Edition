// tests/character_info_report.test.mjs — examine-text-8 (2026-10-13).
//
// Retail gmCharacterInfoUI (acclient.c:237658 Update → UpdatePlayerBirth
// AgeDeaths :236632, UpdateEnduranceInfo :236715, UpdateInnateAttributeInfo
// :236475, UpdateFakeSkills :236506, UpdateAugmentations :236813,
// UpdateLoad :236530) — the "Character Information" text the web client
// never showed. plugins/character_info_report.js rebuilds it from a fixture
// property map:
//   - resistance / regeneration tiers from RAW Str+End and Str+2·End
//     (> 200 / 260 / 320 / 380 / 440 and > 200 / 346 / 470 / 580 / 690);
//   - deaths None / One / Two / Many; born / played only when present;
//   - innate values in Str / End / Coord / Quick / Focus / Self order;
//   - chess 1400 / fishing 0 defaults (always shown);
//   - masteries, the always-on luminance header, base ≤ 5 + Seer spec split,
//     ×5 mana and ×2 skilled-spec auras;
//   - gem augmentations in the decomp's emit order with {time[1]|times};
//   - the load line from the BUFFED strength (EncumbranceCapacity / Load /
//     LoadMod) and the Might of the Seventh Mule line.
// The embedded templates are StringTable 0x23000001 (client_local_English.dat)
// verbatim; a few spot checks pin them.
//
// Run: node tests/character_info_report.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";

const R = await import(new URL("../plugins/character_info_report.js", import.meta.url).href);

/** Fixture source: `ints` by PropertyInt id; attrs [raw, innate, buffed] by attribute id. */
function source({ ints = {}, raw = {}, innate = {}, buffed = {}, ...rest } = {}) {
  return {
    int: (id) => (id in ints ? ints[id] : undefined),
    rawAttr: (id) => raw[id] ?? 100,
    innateAttr: (id) => innate[id] ?? 10,
    attr: (id) => buffed[id] ?? raw[id] ?? 100,
    ...rest,
  };
}
const text = (src) => R.characterInfoText(src);
const tokens = (src) => R.buildCharacterInfoReport(src).map((e) => e.token);

/* ── UpdateEnduranceInfo ──────────────────────────────────────────────── */

test("resistance tiers: > 200 / 260 / 320 / 380 / 440 (acclient.c:236715)", () => {
  const cases = [[200, "None"], [201, "Poor"], [260, "Poor"], [261, "Mediocre"], [320, "Mediocre"],
    [321, "Hardy"], [380, "Hardy"], [381, "Resilient"], [440, "Resilient"], [441, "Indomitable"]];
  for (const [sum, want] of cases) assert.equal(R.resistTier(sum), want, `Str+End ${sum}`);
});

test("regeneration tiers: > 200 / 346 / 470 / 580 / 690 — 690 itself is Resilient", () => {
  const cases = [[200, "None"], [201, "Poor"], [346, "Poor"], [347, "Mediocre"], [470, "Mediocre"],
    [471, "Hardy"], [580, "Hardy"], [581, "Resilient"], [690, "Resilient"], [691, "Indomitable"]];
  for (const [sum, want] of cases) assert.equal(R.regenTier(sum), want, `Str+2·End ${sum}`);
});

test("Str 100 / End 100: resistances None, regeneration Poor (300 ≤ 346)", () => {
  assert.match(text(source({ raw: { 1: 100, 2: 100 } })),
    /Natural Resistances: None\nDrain Resistances: None\nRegeneration Bonus: Poor\n/);
});

test("Str 200 / End 245: Indomitable resistances; Str+2·End = 690 stays Resilient, 691 is Indomitable", () => {
  assert.match(text(source({ raw: { 1: 200, 2: 245 } })),
    /Natural Resistances: Indomitable\nDrain Resistances: Indomitable\nRegeneration Bonus: Resilient\n/);
  assert.match(text(source({ raw: { 1: 201, 2: 245 } })), /Regeneration Bonus: Indomitable\n/);
});

test("tiers read the RAW attributes, not the buffed ones", () => {
  const t = text(source({ raw: { 1: 100, 2: 100 }, buffed: { 1: 300, 2: 300 } }));
  assert.match(t, /Natural Resistances: None\n/);
  assert.match(t, /Regeneration Bonus: Poor\n/);
});

/* ── UpdatePlayerBirthAgeDeaths ───────────────────────────────────────── */

test("NumDeaths 0 (or absent) → the never-died line; 1 / 2 / many", () => {
  assert.match(text(source()), /^You have never died!\n/);
  assert.match(text(source({ ints: { 43: 0 } })), /You have never died!\n/);
  assert.match(text(source({ ints: { 43: 1 } })), /You have died only once!\n/);
  assert.match(text(source({ ints: { 43: 2 } })), /You have died twice\.\n/);
  assert.match(text(source({ ints: { 43: 7 } })), /You have died 7 times\.\n/);
});

test("born / played only when the int is present; played uses QueryDuration units", () => {
  assert.doesNotMatch(text(source()), /born|played/);
  const t = text(source({ ints: { 98: 1_700_000_000, 125: 90061 }, formatDate: () => "DATE" }));
  assert.match(t, /^You were born on DATE\.\nYou have played for 1 day 1 hour 1 minute 1 second\.\nYou have never died!/);
});

test("formatDuration: years (365 d), months (30 d), weeks, plurals, zero units dropped", () => {
  assert.equal(R.formatDuration(3 * 86400 + 2 * 3600), "3 days 2 hours");
  assert.equal(R.formatDuration(400 * 86400), "1 year 1 month 5 days");
  assert.equal(R.formatDuration(15 * 86400 + 59), "2 weeks 1 day 59 seconds");
  assert.equal(R.formatDuration(0), "");
});

test("formatRetailDateTime: English %c — M/d/yyyy h:mm:ss AM/PM on the local clock", () => {
  const at = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).getTime() / 1000;
  assert.equal(R.formatRetailDateTime(at(2026, 10, 12, 16, 48, 8)), "10/12/2026 4:48:08 PM");
  assert.equal(R.formatRetailDateTime(at(2001, 1, 2, 0, 5, 0)), "1/2/2001 12:05:00 AM");
  assert.equal(R.formatRetailDateTime(at(2001, 1, 2, 12, 0, 9)), "1/2/2001 12:00:09 PM");
});

/* ── UpdateInnateAttributeInfo / UpdateFakeSkills ─────────────────────── */

test("innates print Str, End, Coord (id 4), Quick (id 3), Focus, Self", () => {
  const t = text(source({ innate: { 1: 11, 2: 22, 3: 33, 4: 44, 5: 55, 6: 66 } }));
  assert.match(t, /Innate Strength: 11\nInnate Endurance: 22\nInnate Coordination: 44\nInnate Quickness: 33\nInnate Focus: 55\nInnate Self: 66\n/);
});

test("chess rank defaults to 1400 and fishing to 0; both always shown", () => {
  assert.match(text(source()), /Chess Rank: 1400\nFishing Skill: 0\n/);
  assert.match(text(source({ ints: { 181: 1625, 192: 12 } })), /Chess Rank: 1625\nFishing Skill: 12\n/);
});

/* ── UpdateAugmentations ──────────────────────────────────────────────── */

test("AugmentationInnateStrength 2 → 'times'; 1 → 'time' ({time[1]|times})", () => {
  assert.match(text(source({ ints: { 218: 2 } })), /You have augmented your Innate Strength 2 times\.\n/);
  assert.match(text(source({ ints: { 218: 1 } })), /You have augmented your Innate Strength 1 time\.\n/);
  assert.doesNotMatch(text(source()), /augmented your Innate/);
});

test("LumAugDamageRating 7 splits base 5 / Seer spec 2; 3 shows the base line only", () => {
  const t = text(source({ ints: { 333: 7 } }));
  assert.match(t, /Aura of Valor\. Your Damage Rating is increased by 5\.\n/);
  assert.match(t, /Aura of Destruction\. Your Seer grants you an increase to Damage Rating of 2\.\n/);
  const t3 = text(source({ ints: { 333: 3 } }));
  assert.match(t3, /Aura of Valor\. Your Damage Rating is increased by 3\./);
  assert.doesNotMatch(t3, /Aura of Destruction/);
});

test("mana auras ×5, skilled spec ×2, the luminance header is always there", () => {
  const t = text(source({ ints: { 339: 2, 340: 1, 344: 3 } }));
  assert.match(t, /Aura of Mana Flow\. The mana consumption of your items is decreased by a rating of 10\./);
  assert.match(t, /Aura of Mana Infusion\. The mana provide by Mana Stones is increased by a rating of 5\./);
  assert.match(t, /Aura of the Specialist\. Your Seer grants you an increase to all Specialized skills of 6\./);
  assert.match(text(source()), /Luminance Augmentations:\n/);
});

test("masteries use the client's literals; an unknown value prints Unknown", () => {
  const t = text(source({ ints: { 354: 2, 355: 12, 362: 3 } }));
  assert.match(t, /Your melee mastery is Swords\.\nYour ranged mastery is Magical Spells\.\n\nYour summoning mastery is Naturalist\.\n\nLuminance Augmentations:/);
  assert.match(text(source({ ints: { 354: 99 } })), /Your melee mastery is Unknown\./);
  assert.doesNotMatch(text(source()), /mastery/);
});

test("gem augmentations follow the decomp's emit order (Nether between Acid and Fire)", () => {
  const ints = { 244: 1, 327: 2, 243: 1, 293: 1, 228: 1, 326: 1, 229: 1, 230: 1 };
  const augs = tokens(source({ ints })).filter((t) => t?.startsWith("ID_CharacterInfo_Augmentation_"));
  assert.deepEqual(augs, [
    "ID_CharacterInfo_Augmentation_Resist_Acid",
    "ID_CharacterInfo_Augmentation_Resist_Nether",
    "ID_CharacterInfo_Augmentation_Resist_Fire",
    "ID_CharacterInfo_Augmentation_Spec_WeaponTinkering",
    "ID_CharacterInfo_Augmentation_Spec_Gearcraft",
    "ID_CharacterInfo_Augmentation_ExtraPackSlot",
    "ID_CharacterInfo_Augmentation_IncreasedCarryingCapacity",
    "ID_CharacterInfo_Augmentation_JackOfAllTrades",
  ]);
  assert.match(text(source({ ints })), /You have augmented your Nether Resistance 2 times\./);
});

test("every gem augmentation with a value renders fully (no raw selector or \\n escape left)", () => {
  const ints = {};
  for (const [id] of R.GEM_AUGMENTATIONS) ints[id] = 2;
  for (const id of [333, 334, 335, 336, 338, 339, 340, 342, 343, 344, 365, 354, 355, 362]) ints[id] = 7;
  const entries = R.buildCharacterInfoReport(source({ ints, formatDate: () => "D" }));
  for (const e of entries) {
    assert.ok(e.token === null || R.CHARACTER_INFO_TEMPLATES[e.token], `template for ${e.token}`);
    assert.doesNotMatch(e.text, /[{}]|\\n/, `${e.token}: ${JSON.stringify(e.text)}`);
  }
  assert.equal(entries.filter((e) => e.token?.startsWith("ID_CharacterInfo_Augmentation_")).length, R.GEM_AUGMENTATIONS.length);
});

/* ── UpdateLoad ───────────────────────────────────────────────────────── */

test("EncumbranceCapacity: 150·Str + Str·min(30·augs, 150); Load 3.0 with no capacity", () => {
  assert.equal(R.encumbranceCapacity(100, 0), 15000);
  assert.equal(R.encumbranceCapacity(100, 2), 21000);
  assert.equal(R.encumbranceCapacity(100, 6), 30000);
  assert.equal(R.encumbranceCapacity(0, 3), 0);
  assert.equal(R.encumbranceLoad(0, 10), 3.0);
  assert.equal(R.loadMod(0.5), 1.0);
  assert.equal(R.loadMod(1.25), 0.75);
  assert.equal(R.loadMod(2.5), 0.0);
});

test("burden over capacity → 'overburdened by N burden units … by P%'", () => {
  // Str 100 → capacity 15000; 22500 → load 1.5 → LoadMod 0.5 → 10·(10 − 5) = 50%.
  assert.match(text(source({ ints: { 5: 22500 } })),
    /You are currently overburdened by 7500 burden units\. This is reducing your Run, Jump, Melee Defense and Missile Defense skills by 50%\.$/);
  // 3 × capacity: LoadMod 0 → 100%.
  assert.match(text(source({ ints: { 5: 45000 } })), /overburdened by 30000 burden units\..* by 100%\.$/);
  assert.match(text(source({ ints: { 5: 14999 } })), /You are not overburdened at this time\.$/);
});

test("load uses the BUFFED strength (InqLoad), and prints the Seventh Mule line", () => {
  // Raw 100 would be 15000 capacity; buffed 150 → 22500, so 22500 is exactly 1.0.
  assert.match(text(source({ ints: { 5: 20000 }, raw: { 1: 100 }, buffed: { 1: 150 } })), /You are not overburdened at this time\.$/);
  const t = text(source({ ints: { 5: 1000, 230: 2 } }));
  assert.match(t, /You have augmented your burden-bearing ability 2 times\./);
  assert.match(t, /You are not overburdened at this time\.\nYou have been augmented 2 times with the Might of the Seventh Mule\. This has increased your carrying capacity by 40%\.$/);
});

/* ── Update — section order and separators ────────────────────────────── */

test("sections in gmCharacterInfoUI::Update order with a blank line between each", () => {
  assert.deepEqual(tokens(source({ ints: { 98: 1, 125: 60, 354: 1 }, formatDate: () => "D" })), [
    "ID_CharacterInfo_Birth", "ID_CharacterInfo_Played", "ID_CharacterInfo_Deaths_None", null,
    "ID_CharacterInfo_Resists", null,
    "ID_CharacterInfo_Innates", null,
    "ID_CharacterInfo_Chess", "ID_CharacterInfo_Fishing", null,
    "ID_CharacterInfo_Mastery_Melee", "ID_CharacterInfo_Luminance_Header", null,
    "ID_CharacterInfo_Load_None",
  ]);
  const t = text(source());
  assert.match(t, /You have never died!\n\nNatural Resistances:/);
  assert.match(t, /Innate Self: 10\n\nChess Rank:/);
  assert.match(t, /Fishing Skill: 0\n\nLuminance Augmentations:\n\n\nYou are not overburdened/);
});

test("a src.str resolver overrides a template; null falls back to the embedded one", () => {
  const t = text(source({
    str: (token, values) => (token === "ID_CharacterInfo_Chess" ? `CHESS=${values[0]}\n` : null),
  }));
  assert.match(t, /CHESS=1400\nFishing Skill: 0/);
  assert.match(t, /You have never died!/);
});

test("templates are the DAT's (StringTable 0x23000001) — spot checks", () => {
  assert.equal(R.CHARACTER_INFO_STRING_TABLE, 0x23000001);
  assert.deepEqual(R.CHARACTER_INFO_TEMPLATES.ID_CharacterInfo_Resists,
    ["Natural Resistances: ", "\\nDrain Resistances: ", "\\nRegeneration Bonus: ", "\\n"]);
  assert.deepEqual(R.CHARACTER_INFO_TEMPLATES.ID_CharacterInfo_Load_Burdened,
    ["You are currently overburdened by ", " burden units. This is reducing your Run, Jump, Melee Defense and Missile Defense skills by ", "%.\\n"]);
  assert.equal(R.renderTemplate(["a ", " {time[1]|times}\\n"], [1]), "a 1 time\n");
  assert.equal(R.renderTemplate(["a ", " {time[1]|times}\\n"], [3]), "a 3 times\n");
});
