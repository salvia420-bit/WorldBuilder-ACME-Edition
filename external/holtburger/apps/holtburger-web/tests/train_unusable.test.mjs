// tests/train_unusable.test.mjs — round-4 training findings (2026-10-08).
//
//   training-1: retail gmSkillUI::UpdateSelection (acclient.c:213626) shows
//     DisplaySelectionFooter_Untrained (:212913) for EVERY SAC < 2 skill —
//     the Unusable section (SAC 0, or SAC 1 behind min_level > 1: magic
//     schools, Healing, Lockpick, …) is only a list grouping. Train is
//     enabled when `trained_cost && credits >= cost`. `?trainUnusable=off`
//     restores the old "Cannot be trained" footer.
//   training-2: gmSkillUI::TrainSkill (:213989) confirmation text
//     "Are you sure you want to spend %d credits to train %s?".
//   training-3: gmAttributeUI::GetCostToRaise{,10} (:214308 / :214364)
//     price a raise from the REAL level_from_cp / cp_spent — now carried by
//     the stats snapshot's stride-5 attributeXp / vitalXp rows; a pkg
//     without them (or `?realStatXp=off`) keeps the old reconstruction.
//
// NEGATIVE CONTROLS: the flag-off cases must reproduce the pre-fix
// behaviour, and the spent-xp case uses spent ≠ table[ranks] so the
// reconstructed cost differs from the retail one.
//
// Run from apps/holtburger-web/:
//   node tests/train_unusable.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spliceModule } from "../harness/lib/splice_module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  __pluginClient: { events: { on() {}, off() {} }, player: { stats: null, skillCredits: 0 } },
  __sessionHandle: null,
};
function setSearch(search) {
  globalThis.location = { search };
}
setSearch("");

const TS = await import(pathToFileURL(path.join(APP, "plugins", "train-skills.js")).href);
globalThis.__TS = TS;
// pk-5 (round 5): the header's PK status line (real helper).
globalThis.__EF = await import(pathToFileURL(path.join(APP, "plugins", "examine_format.js")).href);

const src = readFileSync(path.join(APP, "plugins", "character-info.js"), "utf8");
function load() {
  const body = spliceModule(src, {
    label: "plugins/character-info.js",
    provided: [],
    stubs: {
      setAcText: "() => {}",
      COMPACT_FONT_ID: "0x4000001C",
      HEADING_FONT_ID: "0x40000019",
      TRAINING: "globalThis.__TS.TRAINING",
      decideTrainAction: "globalThis.__TS.decideTrainAction",
      statRaiseCost: "globalThis.__TS.statRaiseCost",
      skillSpentXp: "globalThis.__TS.skillSpentXp",
      estimateVitalRanks: "globalThis.__TS.estimateVitalRanks",
      levelProgress: "globalThis.__TS.levelProgress",
      skillGroupFor: "globalThis.__TS.skillGroupFor",
      vitaeModifier: "globalThis.__TS.vitaeModifier",
      pkStatusText: "globalThis.__EF.pkStatusText",
    },
  });
  // eslint-disable-next-line no-new-func
  return new Function(body + "\nreturn { footerModel, trainConfirmText, trainUnusableEnabled, __test };\n")();
}

const SKILL_TABLE = {
  skills: [
    { skillIdInt: 34, name: "War Magic", trainedCost: 16, minLevel: 2 },
    { skillIdInt: 21, name: "Healing", trainedCost: 6, minLevel: 2 },
    { skillIdInt: 20, name: "Deception", trainedCost: 4, minLevel: 1 },
  ],
};
const TRAINED = [0, 10, 30, 60, 100, 150, 210, 280, 360, 450, 550, 660, 780];
const XP = { trainedSkills: TRAINED, specializedSkills: TRAINED, attributes: TRAINED, vitals: TRAINED };

/* ── training-1 ───────────────────────────────────────────────────────── */

await check("training-1: SAC 1 War Magic (min_level 2) lists under Unusable but trains", () => {
  setSearch("");
  const mod = load();
  const stats = { skills: [34, 0, 0, 0, 1, 0, 21, 0, 0, 0, 0, 0, 20, 5, 5, 0, 1, 0] };
  const items = mod.__test.buildSkillModel(stats, SKILL_TABLE, XP);
  const war = items.find((i) => i.key === "skill:34");
  assert.equal(war.group, "unusable", "retail RebuildSkillList grouping kept");
  assert.equal(war.trainedCost, 16);
  const rich = mod.footerModel("skills", war, { availableXp: 0, credits: 20 });
  assert.deepEqual(rich.line1, ["Credits to Train:", "16"]);
  assert.deepEqual(rich.line2, ["Skill Credits:", "20"]);
  assert.deepEqual(rich.raise1, { enabled: true, hidden: false, cost: 16, ranks: 0, action: "train" });
  assert.equal(rich.raise10.hidden, true, "+10 hidden like DisplaySelectionFooter_Untrained");
  const poor = mod.footerModel("skills", war, { availableXp: 0, credits: 10 });
  assert.equal(poor.raise1.enabled, false, "credits < cost → disabled");
  assert.equal(poor.raise1.action, "train");
});

await check("training-1: SAC 0 (inactive) row also gets the train footer (retail SAC < 2)", () => {
  setSearch("");
  const mod = load();
  const stats = { skills: [21, 0, 0, 0, 0, 0] };
  const items = mod.__test.buildSkillModel(stats, SKILL_TABLE, XP);
  const heal = items.find((i) => i.key === "skill:21");
  assert.equal(heal.group, "unusable");
  const f = mod.footerModel("skills", heal, { availableXp: 0, credits: 6 });
  assert.equal(f.raise1.enabled, true);
  assert.equal(f.raise1.cost, 6);
});

await check("training-1: zero trained_cost never enables Train", () => {
  setSearch("");
  const mod = load();
  const rec = { kind: "skill", group: "unusable", training: 1, name: "X", trainedCost: 0 };
  const f = mod.footerModel("skills", rec, { availableXp: 0, credits: 99 });
  assert.equal(f.raise1.enabled, false);
  assert.deepEqual(f.line1, ["Credits to Train:", "—"]);
});

await check("training-1 negative control: ?trainUnusable=off → 'Cannot be trained'", () => {
  setSearch("?trainUnusable=off");
  const mod = load();
  assert.equal(mod.trainUnusableEnabled(), false);
  const rec = { kind: "skill", group: "unusable", training: 1, name: "War Magic", trainedCost: 16 };
  const f = mod.footerModel("skills", rec, { availableXp: 0, credits: 99 });
  assert.deepEqual(f.line1, ["Cannot be trained", ""]);
  assert.equal(f.raise1.enabled, false);
  // the Untrained section is unaffected by the flag
  const u = mod.footerModel("skills", { ...rec, group: "untrained" }, { availableXp: 0, credits: 99 });
  assert.equal(u.raise1.enabled, true);
  setSearch("?trainUnusable=0");
  assert.equal(load().trainUnusableEnabled(), false);
  setSearch("?trainUnusable=false");
  assert.equal(load().trainUnusableEnabled(), false);
  setSearch("");
});

/* ── training-2 ───────────────────────────────────────────────────────── */

await check("training-2: retail TrainSkill confirmation text", () => {
  const mod = load();
  assert.equal(mod.trainConfirmText("War Magic", 16),
    "Are you sure you want to spend 16 credits to train War Magic?");
  assert.equal(mod.trainConfirmText("Healing", 1),
    "Are you sure you want to spend 1 credits to train Healing?", "retail never singularises");
  // fire() must route through it with Yes / No.
  assert.match(src, /confirmAction\("Train Skill", trainConfirmText\(rec\.name, spec\.cost\), "Yes", "No"\)/);
});

/* ── training-3 ───────────────────────────────────────────────────────── */

const ATTRS = [1, 50, 50, 3, 2, 60, 60, 4, 3, 10, 10, 0, 4, 10, 10, 0, 5, 10, 10, 0, 6, 10, 10, 0];
const VITALS = [1, 30, 35, 35, 3, 60, 70, 70, 5, 10, 12, 12];

await check("training-3: attribute cost from the real spent xp (spent ≠ table[ranks])", () => {
  setSearch("");
  const mod = load();
  // Strength: rank 3, spent = TRAINED[3] + 15 = 75 (banked partial xp).
  const stats = {
    attributes: ATTRS, vitals: VITALS,
    attributeXp: [1, 3, 47, 75, TRAINED[4] - 75, 2, 4, 56, TRAINED[4], TRAINED[5] - TRAINED[4]],
    vitalXp: [],
  };
  const items = mod.__test.buildAttributeModel(stats, XP);
  const str = items.find((i) => i.key === "attribute:1");
  assert.deepEqual(str.cost1, { cost: TRAINED[4] - 75, ranks: 1 }, "+1 = table[r+1] − real spent");
  assert.deepEqual(str.cost10, { cost: TRAINED[12] - 75, ranks: 9 }, "+10 capped at table end");
  // Without the stride the old reconstruction prices from table[ranks].
  const legacy = mod.__test.buildAttributeModel({ attributes: ATTRS, vitals: VITALS }, XP);
  const strLegacy = legacy.find((i) => i.key === "attribute:1");
  assert.deepEqual(strLegacy.cost1, { cost: TRAINED[4] - TRAINED[3], ranks: 1 });
  assert.notDeepEqual(strLegacy.cost1, str.cost1, "negative control: estimate differs");
});

await check("training-3: vital cost uses the real rank, not the base-max back-solve", () => {
  setSearch("");
  const mod = load();
  // Health base 35, Endurance 60 → estimate = 35 − 30 = 5 ranks; real = 2
  // ranks (enlightenment / start bonus the client can't see).
  const stats = {
    attributes: ATTRS, vitals: VITALS,
    vitalXp: [1, 2, 3, TRAINED[2], TRAINED[3] - TRAINED[2]],
  };
  const items = mod.__test.buildAttributeModel(stats, XP);
  const hp = items.find((i) => i.key === "vital:1");
  assert.deepEqual(hp.cost1, { cost: TRAINED[3] - TRAINED[2], ranks: 1 });
  const legacy = mod.__test.buildAttributeModel({ attributes: ATTRS, vitals: VITALS }, XP);
  const hpLegacy = legacy.find((i) => i.key === "vital:1");
  assert.deepEqual(hpLegacy.cost1, { cost: TRAINED[6] - TRAINED[5], ranks: 1 }, "estimate = rank 5");
  // Stamina has no real row → estimate path still used for it.
  const st = items.find((i) => i.key === "vital:3");
  assert.deepEqual(st.cost1, { cost: TRAINED[11] - TRAINED[10], ranks: 1 }, "70 − End 60 = rank 10");
});

await check("training-3: no local xp table → the server marginal still prices +1", () => {
  setSearch("");
  const mod = load();
  const stats = { attributes: ATTRS, vitals: VITALS, attributeXp: [1, 3, 47, 75, 25] };
  const items = mod.__test.buildAttributeModel(stats, {});
  const str = items.find((i) => i.key === "attribute:1");
  assert.deepEqual(str.cost1, { cost: 25, ranks: 1 });
  assert.equal(str.cost10, null);
});

await check("training-3 negative control: ?realStatXp=off → reconstructed spent xp", () => {
  setSearch("?realStatXp=off");
  const mod = load();
  const stats = {
    attributes: ATTRS, vitals: VITALS,
    attributeXp: [1, 3, 47, 75, TRAINED[4] - 75],
    vitalXp: [1, 2, 3, TRAINED[2], TRAINED[3] - TRAINED[2]],
  };
  const items = mod.__test.buildAttributeModel(stats, XP);
  assert.deepEqual(items.find((i) => i.key === "attribute:1").cost1, { cost: TRAINED[4] - TRAINED[3], ranks: 1 });
  assert.deepEqual(items.find((i) => i.key === "vital:1").cost1, { cost: TRAINED[6] - TRAINED[5], ranks: 1 });
  setSearch("");
});

await check("training-3: plugin api + getStats carry the new strides", () => {
  const api = readFileSync(path.join(APP, "plugins", "api.js"), "utf8");
  assert.match(api, /attributeXp: box\.attributeXp/);
  assert.match(api, /vitalXp: box\.vitalXp/);
  assert.match(src, /attributeXp: toArray\(s\.attributeXp\)/);
  assert.match(src, /vitalXp: toArray\(s\.vitalXp\)/);
  const lib = readFileSync(path.join(APP, "src", "lib.rs"), "utf8");
  assert.match(lib, /js_name = attributeXp/);
  assert.match(lib, /js_name = vitalXp/);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
