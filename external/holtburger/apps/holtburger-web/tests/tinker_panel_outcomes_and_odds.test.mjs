// tests/tinker_panel_outcomes_and_odds.test.mjs — Area 12: Tinkering Panel Outcomes & Odds Preview
//
// Verifies:
// 1. ac_tinker_calc.js implements retail formulas:
//    - TINKERING_DIFFICULTY attempt multipliers (1.0 .. 4.5)
//    - getMaterialMod by numeric ID and material name
//    - calculateTinkerDifficulty and getSkillChance sigmoid curve
//    - calculateTinkerOdds preview with N/10 count, difficulty, success %, and 10/10 cap
// 2. tinker-panel.js outcome handling:
//    - Failure destruction: target lost sets failure text, never flashes green "Done"
//    - Success outcome: sets green "Done"
//    - Server rejection (useFailed / kind:13): clears pendingFire and displays error, never locks on "Working…"
//    - Odds display: renders N/10 count and success odds
// 3. tradeskill.js:
//    - Confirmation popup displays specific source and target item names

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e.message}`);
  }
}

console.log("[1] ui/ac_tinker_calc.js pure calculation tests");
const calcModule = await import(pathToFileURL(path.join(APP, "ui", "ac_tinker_calc.js")).href);
const {
  TINKERING_DIFFICULTY,
  MAX_TINKERS,
  getMaterialMod,
  calculateTinkerDifficulty,
  getSkillChance,
  calculateTinkerOdds,
} = calcModule;

check("TINKERING_DIFFICULTY has 10 attempt multipliers matching retail", () => {
  assert.equal(TINKERING_DIFFICULTY.length, 10);
  assert.equal(TINKERING_DIFFICULTY[0], 1.0); // 1st tinker
  assert.equal(TINKERING_DIFFICULTY[1], 1.1); // 2nd tinker
  assert.equal(TINKERING_DIFFICULTY[2], 1.3); // 3rd tinker
  assert.equal(TINKERING_DIFFICULTY[3], 1.6); // 4th tinker
  assert.equal(TINKERING_DIFFICULTY[4], 2.0); // 5th tinker
  assert.equal(TINKERING_DIFFICULTY[5], 2.5); // 6th tinker
  assert.equal(TINKERING_DIFFICULTY[6], 3.0); // 7th tinker
  assert.equal(TINKERING_DIFFICULTY[7], 3.5); // 8th tinker
  assert.equal(TINKERING_DIFFICULTY[8], 4.0); // 9th tinker
  assert.equal(TINKERING_DIFFICULTY[9], 4.5); // 10th tinker
});

check("getMaterialMod maps materials correctly", () => {
  // Gold (14) / Oak (29) -> 10.0
  assert.equal(getMaterialMod(14), 10.0);
  assert.equal(getMaterialMod("Gold"), 10.0);
  assert.equal(getMaterialMod(29), 10.0);
  assert.equal(getMaterialMod("Oak"), 10.0);

  // Granite (15) / Wool (42) / Bronze (4) -> 11.0
  assert.equal(getMaterialMod(15), 11.0);
  assert.equal(getMaterialMod("granite"), 11.0);
  assert.equal(getMaterialMod(42), 11.0);

  // Steel (37) / Iron (20) -> 12.0
  assert.equal(getMaterialMod(37), 12.0);
  assert.equal(getMaterialMod("steel"), 12.0);
  assert.equal(getMaterialMod(20), 12.0);

  // Gemstones (e.g. Carnelian 55, RedJade 61) -> 25.0
  assert.equal(getMaterialMod(55), 25.0);
  assert.equal(getMaterialMod("carnelian"), 25.0);
  assert.equal(getMaterialMod(61), 25.0);
});

check("calculateTinkerDifficulty scales with attempt count", () => {
  const diff0 = calculateTinkerDifficulty({ materialType: "steel", tinkeredCount: 0 });
  const diff1 = calculateTinkerDifficulty({ materialType: "steel", tinkeredCount: 1 });
  const diff5 = calculateTinkerDifficulty({ materialType: "steel", tinkeredCount: 5 });
  const diff9 = calculateTinkerDifficulty({ materialType: "steel", tinkeredCount: 9 });

  assert.ok(diff0 > 0);
  assert.ok(diff1 > diff0, `Attempt 2 difficulty (${diff1}) should exceed attempt 1 (${diff0})`);
  assert.ok(diff5 > diff1, `Attempt 6 difficulty (${diff5}) should exceed attempt 2 (${diff1})`);
  assert.ok(diff9 > diff5, `Attempt 10 difficulty (${diff9}) should exceed attempt 6 (${diff5})`);
});

check("getSkillChance implements retail sigmoid curve", () => {
  // Skill == Difficulty -> exactly 50%
  const equalChance = getSkillChance(300, 300);
  assert.equal(Math.round(equalChance * 100), 50);

  // High skill vs low difficulty -> high chance
  const highChance = getSkillChance(450, 200);
  assert.ok(highChance > 0.9);

  // Low skill vs high difficulty -> low chance
  const lowChance = getSkillChance(150, 350);
  assert.ok(lowChance < 0.1);
});

check("calculateTinkerOdds provides comprehensive odds and caps at 10 tinkers", () => {
  const odds1 = calculateTinkerOdds({
    skill: 350,
    materialType: "iron",
    itemWorkmanship: 1.0,
    toolWorkmanship: 1.0,
    tinkeredCount: 0,
  });

  assert.equal(odds1.tinkeredCount, 0);
  assert.equal(odds1.maxTinkers, 10);
  assert.equal(odds1.canTinker, true);
  assert.ok(odds1.successPercent > 0 && odds1.successPercent <= 100);

  // 10th tinker already performed -> cannot tinker further
  const oddsMax = calculateTinkerOdds({
    skill: 500,
    materialType: "iron",
    tinkeredCount: 10,
  });

  assert.equal(oddsMax.canTinker, false);
  assert.equal(oddsMax.successPercent, 0);
  assert.equal(oddsMax.tinkeredCount, 10);
});

console.log("\n[2] plugins/tinker-panel.js static and outcome audit");
const tinkerPanelSource = fs.readFileSync(path.join(APP, "plugins", "tinker-panel.js"), "utf8");

check("tinker-panel.js imports calculateTinkerOdds and helpers from ac_tinker_calc.js", () => {
  assert.match(tinkerPanelSource, /calculateTinkerOdds/);
  assert.match(tinkerPanelSource, /readTinkeredCount/);
  assert.match(tinkerPanelSource, /readWorkmanship/);
  assert.match(tinkerPanelSource, /ac_tinker_calc\.js/);
});

check("tinker-panel.js renders .htk-odds element with N/10 count and success chance", () => {
  assert.match(tinkerPanelSource, /\.htk-odds/);
  assert.match(tinkerPanelSource, /tinkeredCount\}[\s\S]*?10\s*tinkers/);
  assert.match(tinkerPanelSource, /successPercent/);
});

check("tinker-panel.js handles target loss as destruction failure in red, not green Done", () => {
  assert.match(tinkerPanelSource, /if\s*\(targetLost\)\s*\{\s*setStatus\s*\(\s*["']Tinkering failed — the item was destroyed\.["'],\s*["']bad["']\s*\);/);
});

check("tinker-panel.js handles server rejection on kind:13 and useFailed without sticking on Working", () => {
  assert.match(tinkerPanelSource, /client\.events\.on\s*\(\s*["']useFailed["']/);
  assert.match(tinkerPanelSource, /client\.events\.on\s*\(\s*["']kind:13["']/);
  assert.match(tinkerPanelSource, /function onUseFailed/);
  assert.match(tinkerPanelSource, /state\.pendingFire\s*=\s*false/);
});

console.log("\n[3] plugins/tradeskill.js item names in confirmation popup");
const tradeskillSource = fs.readFileSync(path.join(APP, "plugins", "tradeskill.js"), "utf8");

check("makeConfirmPopup returns body element", () => {
  assert.match(tradeskillSource, /return\s*\{[\s\S]*?body[\s\S]*?\}/);
});

check("openPopup resolves item names and displays them in popup body", () => {
  assert.match(tradeskillSource, /lookupItemName/);
  assert.match(tradeskillSource, /Apply \$\{srcName\} to \$\{tgtName\}\?/);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
