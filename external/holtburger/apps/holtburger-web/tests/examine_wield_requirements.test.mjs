// tests/examine_wield_requirements.test.mjs — examine-text-1 (2026-10-13).
//
// The examine panel decoded PropertyInt.WieldRequirements with a guessed
// table (1=RawSkill ... 4=Level, 7=Heritage, 8=Faction), so ACE loot with a
// Level requirement (7, LootGenerationFactory.cs) read "Wield (Heritage)
// 180+", base attributes read "Level N+", slots 2-4 were mostly dropped and
// MinLevel was read under a property name that does not exist.
//
// plugins/examine_format.js now ports the retail text:
//   ItemExamineUI::GetAppraisalStringFromRequirements (acclient.c:227877)
//   ItemExamineUI::Appraisal_ShowWieldRequirements    (acclient.c:230357)
//   ItemExamineUI::Appraisal_ShowLevelLimitInfo       (acclient.c:232283)
//
// Run: node tests/examine_wield_requirements.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const F = await import(new URL("../plugins/examine_format.js", import.meta.url).href);
const { wieldRequirementLines: lines, levelLimitLine } = F;

const slot1 = (req, skill, diff) => ({ WieldRequirements: req, WieldSkillType: skill, WieldDifficulty: diff });
const slot2 = (req, skill, diff) => ({ WieldRequirements2: req, WieldSkillType2: skill, WieldDifficulty2: diff });
const slot3 = (req, skill, diff) => ({ WieldRequirements3: req, WieldSkillType3: skill, WieldDifficulty3: diff });
const slot4 = (req, skill, diff) => ({ WieldRequirements4: req, WieldSkillType4: skill, WieldDifficulty4: diff });

test("Level (7) in slot 1 reads 'Wield requires level N' (ACE loot sets WieldSkillType 1)", () => {
  assert.deepEqual(lines(slot1(7, 1, 180)), ["Wield requires level 180"]);
});

test("a Level requirement in slot 2 adds a second line (covenant / olthoi armor)", () => {
  assert.deepEqual(lines({ ...slot1(2, 44, 375), ...slot2(7, 1, 150) }),
    ["Wield requires base Heavy Weapons 375", "Wield requires level 150"]);
});

test("slots 3 and 4 are read too", () => {
  assert.deepEqual(lines({ ...slot1(7, 1, 100), ...slot3(4, 1, 200), ...slot4(6, 1, 300) }), [
    "Wield requires level 100",
    "Wield requires base Strength 200",
    "Wield requires base Maximum Health 300",
  ]);
});

test("attributes and vitals use the retail names; 2/4/6 get 'base '", () => {
  assert.deepEqual(lines(slot1(4, 1, 250)), ["Wield requires base Strength 250"]);
  assert.deepEqual(lines(slot1(3, 6, 100)), ["Wield requires Self 100"]);
  assert.deepEqual(lines(slot1(3, 3, 90)), ["Wield requires Quickness 90"]);
  assert.deepEqual(lines(slot1(5, 5, 120)), ["Wield requires Maximum Mana 120"]);
  assert.deepEqual(lines(slot1(6, 4, 80)), ["Wield requires base Stamina 80"]);
});

test("skills: Skill (1) and RawSkill (2)", () => {
  assert.deepEqual(lines(slot1(2, 34, 310)), ["Wield requires base War Magic 310"]);
  assert.deepEqual(lines(slot1(1, 41, 200)), ["Wield requires Two Handed Combat 200"]);
});

test("Training (8): difficulty 3 is specialized, anything else trained", () => {
  assert.deepEqual(lines(slot1(8, 44, 3)), ["Wield requires specialized Heavy Weapons"]);
  assert.deepEqual(lines(slot1(8, 44, 2)), ["Wield requires trained Heavy Weapons"]);
  // Retail's fourth slot has its own capitalised literals (acclient.c:230609).
  assert.deepEqual(lines(slot4(8, 44, 3)), ["Wield requires Specialized Heavy Weapons"]);
  assert.deepEqual(lines(slot4(8, 44, 2)), ["Wield requires Trained Heavy Weapons"]);
});

test("society standing (9/10) names the society from the skill slot", () => {
  assert.deepEqual(lines(slot1(9, 287, 1)), ["Wield requires Standing with the Celestial Hand 1"]);
  assert.deepEqual(lines(slot1(10, 288, 1)), ["Wield requires Standing with the Eldrytch Web 1"]);
  assert.deepEqual(lines(slot1(9, 289, 101)), ["Wield requires Standing with the Radiant Blood 101"]);
  assert.deepEqual(lines(slot1(9, 5, 1)), ["Wield requires unknown quality 1"]);
});

test("CreatureType (11) / HeritageType (12) read the name from the difficulty slot", () => {
  assert.deepEqual(lines(slot1(11, 0, 3)), ["Wield requires Drudge type"]);
  assert.deepEqual(lines(slot1(12, 0, 2)), ["Wield requires Gharu'ndim race"]);
});

test("a triple prints only when requirement, skill and difficulty are all present", () => {
  assert.deepEqual(lines({ WieldRequirements: 7, WieldDifficulty: 180 }), []);
  assert.deepEqual(lines({ WieldRequirements: 2, WieldSkillType: 44 }), []);
  assert.deepEqual(lines({ WieldSkillType: 44, WieldDifficulty: 250 }), []);
  // A missing slot 1 does not stop slot 2.
  assert.deepEqual(lines(slot2(7, 1, 50)), ["Wield requires level 50"]);
});

test("an unknown requirement type ends the list (retail breaks out of the chain)", () => {
  assert.deepEqual(lines({ ...slot1(13, 1, 5), ...slot2(7, 1, 150) }), []);
  assert.deepEqual(lines({ ...slot1(0, 1, 5), ...slot2(7, 1, 150) }), []);
  assert.deepEqual(lines({ ...slot1(7, 1, 100), ...slot2(13, 1, 5), ...slot3(7, 1, 150) }),
    ["Wield requires level 100"]);
});

test("the wire-id keys work as a fallback", () => {
  assert.deepEqual(lines({ 158: 7, 159: 1, 160: 180 }), ["Wield requires level 180"]);
});

test("allowed wielder, Throne of Destiny and heritage-specific armor come first", () => {
  assert.deepEqual(lines({}, { AppraisalHasAllowedWielder: true }, {}), ["Wield requires the original owner"]);
  assert.deepEqual(lines({}, { AppraisalHasAllowedWielder: true }, { CraftsmanName: "Aerfalle" }),
    ["Wield requires Aerfalle"]);
  assert.deepEqual(lines({}, { AppraisalHasAllowedWielder: false }, { CraftsmanName: "Aerfalle" }), []);
  assert.deepEqual(lines({ AccountRequirements: 1 }), ["Use requires Throne of Destiny."]);
  assert.deepEqual(lines({ AccountRequirements: 0 }), []);
  assert.deepEqual(lines({ HeritageSpecificArmor: 3 }), ["Wield requires Sho"]);
  assert.deepEqual(lines({ HeritageSpecificArmor: 0 }), []);
  assert.deepEqual(
    lines({ HeritageSpecificArmor: 1, AccountRequirements: 1, ...slot1(7, 1, 180) },
      { AppraisalHasAllowedWielder: true }, {}),
    [
      "Wield requires the original owner",
      "Use requires Throne of Destiny.",
      "Wield requires Aluvian",
      "Wield requires level 180",
    ]);
});

test("no requirement properties → no lines", () => {
  assert.deepEqual(lines(), []);
  assert.deepEqual(lines({ Value: 100 }, {}, {}), []);
});

test("wieldRequirementSubject is GetAppraisalStringFromRequirements", () => {
  assert.equal(F.wieldRequirementSubject(7, 1, 180), "level");
  assert.equal(F.wieldRequirementSubject(2, 44, 250), "base Heavy Weapons");
  assert.equal(F.wieldRequirementSubject(13, 1, 1), null);
  assert.equal(F.ATTRIBUTE_NAMES[4], "Coordination");
  assert.equal(F.VITAL_NAMES[1], "Maximum Health");
});

test("levelLimitLine (Appraisal_ShowLevelLimitInfo)", () => {
  assert.equal(levelLimitLine({ MinLevel: 30 }), "Restricted to characters of Level 30 or greater.");
  assert.equal(levelLimitLine({ MaxLevel: 15 }), "Restricted to characters of Level 15 or below.");
  assert.equal(levelLimitLine({ MinLevel: 50, MaxLevel: 50 }), "Restricted to characters of Level 50.");
  assert.equal(levelLimitLine({ MinLevel: 20, MaxLevel: 40 }), "Restricted to characters of Levels 20 to 40.");
  assert.equal(levelLimitLine({ MinLevel: 0, MaxLevel: 0 }), null);
  assert.equal(levelLimitLine({ MinLevel: 30, MaxLevel: 0 }), "Restricted to characters of Level 30 or greater.");
  assert.equal(levelLimitLine({}), null);
  assert.equal(levelLimitLine(), null);
});

test("examine-target.js renders the helpers and drops the guessed table", () => {
  const src = readFileSync(new URL("../plugins/examine-target.js", import.meta.url), "utf8");
  assert.match(src, /levelLimitLine, wieldRequirementLines,\n\} from "\.\/examine_format\.js";/);
  assert.doesNotMatch(src, /WIELD_REQ_LABELS/);
  assert.doesNotMatch(src, /ItemMinLevel/);
  const block = src.slice(src.indexOf("// === Requirements (Appraisal_ShowLevelLimitInfo"));
  assert.match(block.slice(0, 1400), /reqLines\.push\(\.\.\.wieldRequirementLines\(ints, props\.bools \|\| \{\}, strings\)\);/);
  assert.match(block.slice(0, 1400), /for \(const line of reqLines\) prose\(wrapEl, line\);/);
  assert.match(block.slice(0, 1400), /row\("Item level cap", itemLevelCap\)/);
});
