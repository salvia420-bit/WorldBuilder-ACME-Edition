// tests/examine_character_misc.test.mjs — examine-text-7 (2026-10-13).
//
// The examine panel dropped retail's misc-info list under the attribute
// block, and routed only PLAYER-flagged objects to the character page.
// Re-derived from acclient.c:
//   - gmExaminationUI::SetAppraiseInfo (:228878) sends a creature appraisal
//     with PropertyString Template (5) or PropertyInt CharacterTitleId
//     (0x105) to CharExamineUI — templated NPCs included;
//   - CharExamineUI::SetAppraiseInfo (:233437): "Society:" (own / rival
//     colour from the viewer's Faction1Bits), the allegiance rows
//     ("Alleg. Monarch:" / "Monarch:" / "Patron:" / "Monarch/Patron:"),
//     the "Head/Chest/Groin  AL: a/b/c" rows with "*%d" of value − 9999 for
//     an unenchantable location, the rating block, "Fellowship:",
//     "Arrived in Dereth:", "Time in Dereth:" (ClientUISystem::
//     DeltaTimeToString :403033), "Chess Rank:", "Fishing Skill:",
//     "Deaths:" / "Has never died", "Titles Earned:", "* = Unenchantable";
//   - CreatureExamineUI::SetAppraiseInfo (:233213): the rating block only.
//
// Run: node tests/examine_character_misc.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installFakeDom, visibleText } from "./helpers/fake_dom_items.mjs";

const F = await import(new URL("../plugins/examine_format.js", import.meta.url).href);

const rowsOf = (rows) => rows.map((r) => (r.blank ? "" : r.note ? r.label : `${r.label} | ${r.value}`));

// ── armorCell / DeltaTimeToString / society suffix ─────────────────────

test("armorCell: ≥ 9999 prints '*' + (value − 9999) like retail's \"*%d\"", () => {
  assert.equal(F.armorCell(10000), "*1");
  assert.equal(F.armorCell(9999), "*0");
  assert.equal(F.armorCell(10099), "*100");
  assert.equal(F.armorCell(9998), "9998");
  assert.equal(F.armorCell(250), "250");
  assert.equal(F.armorCell(0), "0");
  assert.equal(F.armorCell("x"), null);
});

test("deltaTimeToString: 30-day months, zero units skipped, seconds always", () => {
  assert.equal(F.deltaTimeToString(2592000 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5), "1mo 2d 3h 4m 5s");
  assert.equal(F.deltaTimeToString(0), "0s");
  assert.equal(F.deltaTimeToString(59), "59s");
  assert.equal(F.deltaTimeToString(3605), "1h 5s");
  assert.equal(F.deltaTimeToString(86400), "1d 0s");
  assert.equal(F.deltaTimeToString(2592000 * 14 + 60), "14mo 1m 0s");
  assert.equal(F.deltaTimeToString(90.9), "1m 30s");
  assert.equal(F.deltaTimeToString(undefined), null);
});

test("societyRankSuffix: retail's rank bands", () => {
  assert.equal(F.societyRankSuffix(0), "");
  assert.equal(F.societyRankSuffix(1), " ~ Initiate");
  assert.equal(F.societyRankSuffix(100), " ~ Initiate");
  assert.equal(F.societyRankSuffix(101), " ~ Adept");
  assert.equal(F.societyRankSuffix(300), " ~ Adept");
  assert.equal(F.societyRankSuffix(301), " ~ Knight");
  assert.equal(F.societyRankSuffix(601), " ~ Lord");
  assert.equal(F.societyRankSuffix(1001), " ~ Master");
  assert.equal(F.societyRankSuffix(1500), " ~ Master");
  assert.equal(F.societyRankSuffix(1501), "");
});

// ── Society ────────────────────────────────────────────────────────────

test("societyRow: own society reads 'ok' (font 1), a rival 'warn' (font 2), an outsider plain", () => {
  const ints = { Faction1Bits: 4, SocietyRankRadblo: 350 };
  assert.deepEqual(F.societyRow(ints, 4), { key: "society", label: "Society:", value: "Radiant Blood ~ Knight", tone: "ok" });
  assert.equal(F.societyRow(ints, 1).tone, "warn", "Celestial Hand viewer → rival");
  assert.equal(F.societyRow(ints, 2).tone, "warn", "Eldrytch Web viewer → rival");
  assert.equal(F.societyRow(ints, 0).tone, null, "no society → plain");
  assert.equal(F.societyRow({ Faction1Bits: 1, SocietyRankCelhan: 50 }, 1).value, "Celestial Hand ~ Initiate");
  assert.equal(F.societyRow({ Faction1Bits: 2, SocietyRankEldweb: 1200 }, 0).value, "Eldrytch Web ~ Master");
  assert.equal(F.societyRow({ Faction1Bits: 2 }, 0).value, "Eldrytch Web", "no rank int → no suffix");
});

test("societyRow: Faction1Bits with no society bit reads '???'; no Faction1Bits, no row", () => {
  assert.deepEqual(F.societyRow({ Faction1Bits: 0 }, 4), { key: "society", label: "Society:", value: "???", tone: null });
  assert.equal(F.societyRow({}, 4), null);
  assert.equal(F.societyRow({ "281": 1, "287": 101 }, 1).value, "Celestial Hand ~ Adept", "wire-id keys work too");
});

// ── Allegiance ─────────────────────────────────────────────────────────

test("allegianceRows: a monarch with AllegianceFollowers 12 gives 'Alleg. Monarch: | 12 Followers'", () => {
  assert.deepEqual(rowsOf(F.allegianceRows({ AllegianceRank: 5, AllegianceFollowers: 12 }, {})), ["Alleg. Monarch: | 12 Followers"]);
  assert.deepEqual(rowsOf(F.allegianceRows({ AllegianceRank: 1, AllegianceFollowers: 1 }, {})), ["Alleg. Monarch: | 1 Follower"]);
  assert.deepEqual(rowsOf(F.allegianceRows({ AllegianceRank: 1, AllegianceFollowers: -3 }, {})), ["Alleg. Monarch: | 0 Followers"]);
  assert.deepEqual(rowsOf(F.allegianceRows({ AllegianceRank: 1 }, {})), ["Alleg. Monarch: | 0 Followers"]);
});

test("allegianceRows: a vassal with distinct titles gives two rows; equal titles fold into 'Monarch/Patron:'", () => {
  const ints = { AllegianceRank: 2 };
  assert.deepEqual(
    rowsOf(F.allegianceRows(ints, { MonarchsTitle: "Lord Asheron", PatronsTitle: "Knight Bob" })),
    ["Monarch: | Lord Asheron", "Patron: | Knight Bob"],
  );
  assert.deepEqual(
    rowsOf(F.allegianceRows(ints, { MonarchsTitle: "Lord Asheron", PatronsTitle: "Lord Asheron" })),
    ["Monarch/Patron: | Lord Asheron"],
  );
  assert.deepEqual(rowsOf(F.allegianceRows(ints, { MonarchsTitle: "Lord Asheron" })), ["Monarch: | Lord Asheron"]);
});

test("allegianceRows / allegianceNameText: nothing below AllegianceRank 1", () => {
  assert.deepEqual(F.allegianceRows({ AllegianceRank: 0, AllegianceFollowers: 4 }, { MonarchsTitle: "X" }), []);
  assert.deepEqual(F.allegianceRows({}, { MonarchsTitle: "X" }), []);
  assert.equal(F.allegianceNameText({ AllegianceRank: 0 }, { AllegianceName: "Order of Dereth" }), null);
  assert.equal(F.allegianceNameText({ AllegianceRank: 3 }, { AllegianceName: "Order of Dereth" }), "Order of Dereth");
  assert.equal(F.allegianceNameText({ AllegianceRank: 3 }, {}), null);
});

// ── Armor + ratings ────────────────────────────────────────────────────

const AL = { head: 10100, chest: 250, abdomen: 240, upper_arm: 230, lower_arm: 220, hand: 9999, upper_leg: 210, lower_leg: 200, foot: 190 };

test("characterArmorRows: a blank line then three 'AL: a/b/c' rows; none when every location is 0", () => {
  assert.deepEqual(rowsOf(F.characterArmorRows(AL)), [
    "",
    "Head/Chest/Groin | AL: *101/250/240",
    "Bicep/Wrist/Hand | AL: 230/220/*0",
    "Thigh/Shin/Foot | AL: 210/200/190",
  ]);
  const zero = Object.fromEntries(Object.keys(AL).map((k) => [k, 0]));
  assert.deepEqual(F.characterArmorRows(zero), []);
  assert.deepEqual(F.characterArmorRows(null), []);
});

test("creatureRatingRows: blank-delimited Dmg/CritDmg Rating / Resist and DoT/Life lines", () => {
  assert.deepEqual(F.creatureRatingRows({}), []);
  assert.deepEqual(rowsOf(F.creatureRatingRows({ DamageRating: 10, CritDamageRating: 5 })), ["", "Dmg/CritDmg | Rating: 10/5", ""]);
  // CritRating alone still opens the rating line (retail's condition), which prints dr / cdr.
  assert.deepEqual(rowsOf(F.creatureRatingRows({ CritRating: 3 })), ["", "Dmg/CritDmg | Rating: 0/0", ""]);
  assert.deepEqual(
    rowsOf(F.creatureRatingRows({ DamageResistRating: 8, CritDamageResistRating: 2, DotResistRating: 4, LifeResistRating: 6 })),
    ["", "Dmg/CritDmg | Resist: 8/2", "DoT/Life: | Resist: 4/6", ""],
  );
  assert.deepEqual(
    rowsOf(F.creatureRatingRows({ DamageRating: 1, DamageResistRating: 2, LifeResistRating: 3 })),
    ["", "Dmg/CritDmg | Rating: 1/0", "Dmg/CritDmg | Resist: 2/0", "DoT/Life: | Resist: 0/3", ""],
  );
  // HealingBoostRating is read but never shown; negative ratings never open a line.
  assert.deepEqual(F.creatureRatingRows({ HealingBoostRating: 9, DamageRating: -5 }), []);
});

// ── characterMiscRows (CharExamineUI order) ────────────────────────────

test("characterMiscRows: retail order, every line, the legend last", () => {
  const ints = {
    Faction1Bits: 1, SocietyRankCelhan: 700,
    AllegianceRank: 4, AllegianceFollowers: 12,
    DamageRating: 12, CritDamageRating: 4,
    Age: 2592000 + 3600 + 7, ChessRank: 1450, FakeFishingSkill: 77, NumDeaths: 3, NumCharacterTitles: 9,
  };
  const strings = { AllegianceName: "Order of Dereth", Fellowship: "The Wanderers", DateOfBirth: "Saturday, November 2, 1999 ..." };
  assert.deepEqual(rowsOf(F.characterMiscRows(ints, strings, 6, { armorLevels: AL })), [
    "Society: | Celestial Hand ~ Lord",
    "Alleg. Monarch: | 12 Followers",
    "",
    "Head/Chest/Groin | AL: *101/250/240",
    "Bicep/Wrist/Hand | AL: 230/220/*0",
    "Thigh/Shin/Foot | AL: 210/200/190",
    "",
    "Dmg/CritDmg | Rating: 12/4",
    "",
    "Fellowship: | The Wanderers",
    "Arrived in Dereth: | Saturday, November 2, 1999 ...",
    "Time in Dereth: | 1mo 1h 7s",
    "Chess Rank: | 1450",
    "Fishing Skill: | 77",
    "Deaths: | 3",
    "Titles Earned: | 9",
    "* = Unenchantable",
  ]);
  assert.equal(F.characterMiscRows(ints, strings, 6)[0].tone, "warn", "viewer in the other two societies → rival");
});

test("characterMiscRows: NumDeaths 0 (or below) reads 'Has never died'; a withheld count leaves the line out", () => {
  const deaths = (ints) => F.characterMiscRows(ints, {}).find((r) => r.key === "deaths");
  assert.equal(deaths({ NumDeaths: 0 }).value, "Has never died");
  assert.equal(deaths({ NumDeaths: -1 }).value, "Has never died");
  assert.equal(deaths({ NumDeaths: 1 }).value, "1");
  // Retail prints the line only when InqInt(0x2B) succeeds; ACE drops
  // NumDeaths when AllowOthersToSeeYourNumberOfDeaths is off.
  assert.equal(deaths({}), undefined);
});

test("characterMiscRows: an empty appraisal leaves only the legend", () => {
  assert.deepEqual(rowsOf(F.characterMiscRows({}, {})), ["* = Unenchantable"]);
  const legend = F.characterMiscRows({}, {}).at(-1);
  assert.equal(legend.note, true);
});

// ── Page dispatch + header ─────────────────────────────────────────────

test("examineSubPage: creature profile + Template or CharacterTitleId → character page", () => {
  const cp = { attributes: {} };
  assert.equal(F.examineSubPage({ creatureProfile: cp, properties: { strings: { Template: "Town Crier" }, ints: {} } }), "character");
  assert.equal(F.examineSubPage({ creatureProfile: cp, properties: { strings: {}, ints: { CharacterTitleId: 0 } } }), "character");
  assert.equal(F.examineSubPage({ creatureProfile: cp, properties: { strings: { "5": "Guard" } } }), "character");
  assert.equal(F.examineSubPage({ creatureProfile: cp, properties: { strings: {}, ints: { Level: 5 } } }), "creature");
  assert.equal(F.examineSubPage({ failedCreatureProfile: cp, properties: { strings: {}, ints: {} } }), "creature");
  assert.equal(F.examineSubPage({ properties: { strings: { Template: "Town Crier" } } }), null, "no creature profile → item page");
  assert.equal(F.examineSubPage(null), null);
});

test("examineHeaderModel player: Template is the title fallback; the allegiance name follows the PK line", () => {
  const m = F.examineHeaderModel({
    kind: "player",
    ints: { HeritageGroup: 1, AllegianceRank: 2, Level: 40 },
    strings: { Template: "Town Crier", AllegianceName: "Order of Dereth" },
    pkStatus: "Non-Player Killer",
  });
  assert.deepEqual(m.lines.map((l) => l.text), ["Aluvian", "Town Crier", "Non-Player Killer", "Order of Dereth"]);
  const titled = F.examineHeaderModel({ kind: "player", strings: { Title: "Master Archer", Template: "Guard" } });
  assert.equal(titled.lines[0].text, "Master Archer", "an explicit Title still wins");
  const noRank = F.examineHeaderModel({ kind: "player", ints: { AllegianceRank: 0 }, strings: { AllegianceName: "X" } });
  assert.ok(!noRank.lines.some((l) => l.text === "X"));
});

test("examineHeaderModel player: with CharacterTitleId the creation Template is NOT shown as the title (review R2)", () => {
  // ACE sends CharacterTitleId (0x105) and Template for every player; retail
  // shows the CharacterTitleTable name and reads Template only when 0x105 is
  // absent (CharExamineUI::SetAppraiseInfo, acclient.c:233606).
  const player = F.examineHeaderModel({
    kind: "player",
    ints: { HeritageGroup: 1, CharacterTitleId: 9, Level: 40 },
    strings: { Template: "Bow Hunter" },
    pkStatus: "Non-Player Killer",
  });
  assert.deepEqual(player.lines.map((l) => l.text), ["Aluvian", "Non-Player Killer"]);
  const byId = F.examineHeaderModel({ kind: "player", ints: { 261: 0 }, strings: { Template: "Bow Hunter" } });
  assert.ok(!byId.lines.some((l) => l.text === "Bow Hunter"), "numeric 0x105 key counts too");
  const npc = F.examineHeaderModel({ kind: "player", ints: {}, strings: { Template: "Town Crier" } });
  assert.deepEqual(npc.lines.map((l) => l.text), ["Town Crier"], "templated NPC keeps its Template");
});

// ── examine-target.js wiring (source pins) ─────────────────────────────

test("examine-target.js imports the helpers and routes templated NPCs", () => {
  const src = readFileSync(new URL("../plugins/examine-target.js", import.meta.url), "utf8");
  assert.match(src, /examineSubPage, characterMiscRows, creatureRatingRows, armorCell,\n/);
  assert.match(src, /if \(kind === "creature" && examineSubPage\(snapshot\) === "character"\) \{/);
  assert.match(src, /h\.objectIntProperty\(g, 281\)/);
  assert.match(src, /characterMiscRows\(ints, strings, viewerFaction1Bits\(\), \{ armorLevels: armorLevelsShown \}\)/);
  assert.match(src, /const cell = armorCell\(al\[key\]\);/);
  assert.doesNotMatch(src, /kvRow\(grid, label, formatThousands\(al\[key\]\)\)/);
});

// ── examine panel DOM (fake DOM, real mountExamineBody) ────────────────

globalThis.window = globalThis;
installFakeDom(globalThis);

const VIEWER = 0x50000099;
const PLAYER = 0x50000010;
const CRIER = 0x7A000001;
const DRUDGE = 0x7A000002;
const GUARD = 0x7A000003;
const cp = { health: 80, health_max: 100, attributes: { strength: 50, endurance: 40, coordination: 30, quickness: 30, focus: 20, self_attr: 20, stamina: 50, stamina_max: 60, mana: 10, mana_max: 20 } };
const bags = (ints = {}, strings = {}) => ({ ints, strings, floats: {}, bools: {}, int64s: {}, dids: {} });
const APPRAISALS = new Map([
  [PLAYER, {
    identifySuccess: true, identifyFlags: 0,
    creatureProfile: cp,
    armorLevels: AL,
    properties: bags(
      { HeritageGroup: 1, Gender: 1, Level: 126, CharacterTitleId: 1, Faction1Bits: 4, SocietyRankRadblo: 1001,
        AllegianceRank: 3, NumDeaths: 0, Age: 3605, DamageRating: 10, CritDamageRating: 5 },
      { Name: "Hero", AllegianceName: "Order of Dereth", MonarchsTitle: "Lord Asheron", PatronsTitle: "Knight Bob" },
    ),
    spellBook: [],
  }],
  [CRIER, {
    identifySuccess: true, identifyFlags: 0,
    creatureProfile: cp,
    properties: bags({ HeritageGroup: 1, Gender: 2, Level: 10 }, { Name: "Town Crier", Template: "Town Crier" }),
    spellBook: [],
  }],
  [DRUDGE, {
    identifySuccess: true, identifyFlags: 0,
    creatureProfile: cp,
    properties: bags({ CreatureType: 3, Level: 7, DamageRating: 4, DotResistRating: 2 }, { Name: "Drudge Skulker" }),
    spellBook: [],
  }],
  [GUARD, {
    identifySuccess: true, identifyFlags: 0,
    creatureProfile: cp,
    armorLevels: { ...AL, head: 300 },
    properties: bags({ CreatureType: 31, Level: 50 }, { Name: "Guard" }),
    spellBook: [],
  }],
]);
const ENTITIES = new Map([
  [PLAYER, { meta: { name: "Hero", itemType: 0x10, objDescFlags: 0x08, level: 126 } }],
  [CRIER, { meta: { name: "Town Crier", itemType: 0x10, objDescFlags: 0, level: 10 } }],
  [DRUDGE, { meta: { name: "Drudge Skulker", itemType: 0x10, objDescFlags: 0, level: 7 } }],
  [GUARD, { meta: { name: "Guard", itemType: 0x10, objDescFlags: 0, level: 50 } }],
]);
let viewerBits = 4;
window.liveScene3d = { entityManager: { entityMap: ENTITIES } };
window.getLocalPlayerGuid = () => VIEWER;
window.__sessionHandle = {
  playerInventory: () => [],
  getObjectAppraisal: (g) => (APPRAISALS.has(g >>> 0) ? JSON.stringify(APPRAISALS.get(g >>> 0)) : undefined),
  requestAppraisal: () => {},
  getObjectInscription: () => undefined,
  objectDescFlags: (g) => ENTITIES.get(g >>> 0)?.meta?.objDescFlags ?? 0,
  objectIntProperty: (g, stype) => ((g >>> 0) === VIEWER && stype === 281 ? viewerBits : undefined),
};
window.__pluginClient = { events: { on() {}, off() {}, emit() {} } };

const exa = await import(new URL("../plugins/examine-target.js", import.meta.url).href);

function mount(guid) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const cleanup = exa.mountExamineBody(host, { guid, fromEntity: true });
  const wrap = host.querySelector(".hb-exa-appraisal-wrap");
  return { host, wrap, done: () => { cleanup?.(); host.remove(); } };
}
const sectionTitles = (wrap) => wrap.children.filter((k) => k.classList.contains("hbk-section-title")).map((k) => k.textContent);
function sectionText(wrap, title) {
  const kids = wrap.children;
  const i = kids.findIndex((k) => k.classList.contains("hbk-section-title") && k.textContent === title);
  if (i < 0) return null;
  let j = i + 1;
  while (j < kids.length && !kids[j].classList.contains("hbk-section-title")) j++;
  return kids.slice(i + 1, j);
}

test("panel: a player gets the Character section in retail order and no Armor by Location grid", () => {
  viewerBits = 4;
  const { host, wrap, done } = mount(PLAYER);
  try {
    assert.deepEqual(sectionTitles(wrap), ["Attributes", "Character"]);
    const text = sectionText(wrap, "Character").map((k) => visibleText(k)).filter(Boolean);
    assert.deepEqual(text, [
      "Society: Radiant Blood ~ Master",
      "Monarch: Lord Asheron",
      "Patron: Knight Bob",
      "Head/Chest/Groin AL: *101/250/240",
      "Bicep/Wrist/Hand AL: 230/220/*0",
      "Thigh/Shin/Foot AL: 210/200/190",
      "Dmg/CritDmg Rating: 10/5",
      "Time in Dereth: 1h 5s",
      "Deaths: Has never died",
      "* = Unenchantable",
    ]);
    const block = sectionText(wrap, "Character");
    const gapAt = block.map((k, i) => (k.classList.contains("hb-exa-gap") ? i : -1)).filter((i) => i >= 0);
    // Retail's blank lines: before the armor rows, before the ratings, after
    // the ratings — never leading, never doubled.
    assert.deepEqual(gapAt, [3, 7, 9]);
    const society = wrap.querySelectorAll(".hbk-kv").find((r) => /Society:/.test(r.textContent));
    assert.ok(society.classList.contains("is-ok"), "own society → is-ok");
    assert.equal(society.title, "Your society");
    assert.match(visibleText(host.querySelector(".hb-exa-headtext")), /Non-Player Killer Order of Dereth$/);
  } finally { done(); }
});

test("panel: a rival viewer sees the Society row in the warn colour", () => {
  viewerBits = 1;
  const { wrap, done } = mount(PLAYER);
  try {
    const society = wrap.querySelectorAll(".hbk-kv").find((r) => /Society:/.test(r.textContent));
    assert.ok(society.classList.contains("is-warn"));
    assert.ok(!society.classList.contains("is-ok"));
  } finally { done(); viewerBits = 4; }
});

test("panel: a templated NPC (no PLAYER bit) is routed to the character page", () => {
  const { host, wrap, done } = mount(CRIER);
  try {
    assert.equal(host.querySelector(".hb-exa-levellabel").textContent, "Character Level");
    const head = visibleText(host.querySelector(".hb-exa-headtext"));
    assert.equal(head, "Aluvian Female Town Crier Non-Player Killer");
    assert.deepEqual(sectionTitles(wrap), ["Attributes", "Character"]);
    assert.deepEqual(sectionText(wrap, "Character").map((k) => visibleText(k)), ["* = Unenchantable"]);
    assert.ok(!host.querySelector(".hb-exa-body").classList.contains("is-creature"), "the paperdoll leads, like a player");
  } finally { done(); }
});

test("panel: a plain creature gets the rating block only", () => {
  const { host, wrap, done } = mount(DRUDGE);
  try {
    assert.equal(host.querySelector(".hb-exa-levellabel").textContent, "Level");
    assert.deepEqual(sectionTitles(wrap), ["Attributes", "Ratings"]);
    assert.deepEqual(sectionText(wrap, "Ratings").map((k) => visibleText(k)), ["Dmg/CritDmg Rating: 4/0", "DoT/Life: Resist: 2/0"]);
    assert.doesNotMatch(visibleText(wrap), /Society|Deaths|Unenchantable/);
  } finally { done(); }
});

test("panel: a non-character NPC with ArmorLevels keeps the grid, with '*' cells and the legend", () => {
  const { wrap, done } = mount(GUARD);
  try {
    assert.deepEqual(sectionTitles(wrap), ["Attributes", "Armor by Location"]);
    const block = sectionText(wrap, "Armor by Location").map((k) => visibleText(k));
    assert.match(block[0], /^Head 300 Chest 250 .* Hands \*0 /);
    assert.equal(block.at(-1), "* = Unenchantable");
  } finally { done(); }
});
