// tests/combat_bar_skill_stride.test.mjs — round-9 review, finding R9-7.
//
// `SessionHandle.playerStats().skills` is a FLAT stride-SIX u32 array —
// `[type, current, base, ranks, training, next_rank_cost]` per skill, sorted
// by SkillType — per the getter's own doc:
//
//     src/lib.rs:26594-26600
//       /// Flat `[type, current, base, ranks, training, next_rank_cost, ...]`
//       /// per skill (stride 6).
//
// `plugins/combat-bar.js` had TWO walkers over it and they disagreed:
//
//   * readRecklessnessTrainingLevel (:533)   `i += 6`, training at `i + 4`  ✅
//   * renderRows' Mana-Conversion probe      `s += 5`, training at `s + 3`  ❌
//         for (let s = 0; s + 4 < skills.length; s += 5)
//           if (skills[s] === 16) manaConvTrained = skills[s + 3] >= 2;
//
// With stride 5 over a stride-6 array the `=== 16` test lands on a rotating
// field (type, then current, then base, …), so it matches by coincidence or
// not at all — and `+3` is `ranks`, not `training`. The spell tooltip's
// "(Mana Conversion may reduce)" suffix was therefore noise. The same stride-5
// mistake is documented in the file's own comment ("[id, current, base,
// trained_state, xp]"), which is what made it look deliberate.
//
// CONTRACT: one stride-6 walker, `readSkillTrainingLevel(skillType)`, used by
// every caller.
//
// NEGATIVE CONTROLS
//   * a stride-5 walker => the "reads Mana Conversion, not its neighbour"
//     case fails (the fixture is built so stride 5 lands on a DIFFERENT
//     skill's row and returns a different training value).
//   * reading `+3` instead of `+4` => the "returns training, not ranks" case
//     fails (ranks and training are distinct values in the fixture).
//
// Run from apps/holtburger-web/:
//   node tests/combat_bar_skill_stride.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spliceModule } from "../harness/lib/splice_module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

/* ── fixture: a realistic stride-6 skills array ───────────────────────── */
//
// ACE.Entity/Enum/Skill.cs ordinals: MeleeDefense=6, MagicDefense=15,
// ManaConversion=16, Recklessness=50.
// Layout per row: [type, current, base, ranks, training, next_rank_cost]
// `ranks` and `training` are deliberately DIFFERENT so a `+3` read is caught.
const SKILLS = [
  6,  210, 180, 145,  3, 12000,  // MeleeDefense   ranks=145 training=3
  15, 190, 160, 132,  1,  9000,  // MagicDefense   ranks=132 training=1 (untrained)
  16, 175, 150, 121,  2,  8000,  // ManaConversion ranks=121 training=2 (TRAINED)
  50,  55,  40,  33,  0,  4000,  // Recklessness   ranks=33  training=0
];

globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  location: { search: "" },
  localStorage: undefined,
  __sessionHandle: { playerStats: () => ({ skills: SKILLS }) },
};
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, addEventListener() {}, querySelector: () => null,
    querySelectorAll: () => [],
  }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {}, removeEventListener() {},
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

/* ── load the plugin ──────────────────────────────────────────────────── */
//
// Every stub below is EXPLICIT and returns an inert value; none of them is
// consulted by readSkillTrainingLevel, which reads only
// window.__sessionHandle.playerStats().skills.
const INERT = "() => undefined";
const src = readFileSync(path.join(APP, "plugins", "combat-bar.js"), "utf8");
const body = spliceModule(src, {
  label: "plugins/combat-bar.js",
  provided: [],
  stubs: {
    // DEC-12 (2026-08-13, PARITY-B): `plugins/combat-bar.js` now imports
    // `noteCombatModeRequest` from `../ui/ac_combat_mode_intent.js` to record
    // the player's combat-mode intent before a cast. This test never drives
    // that path (it exercises `readSkillTrainingLevel` only), so an explicit
    // inert stub is correct — a catch-all proxy would make the assertions
    // unfalsifiable, which is exactly what spliceModule refuses.
    noteCombatModeRequest: INERT,
    getSpellBarSlots: "() => []",
    setSpellBarSlot: INERT,
    getActiveSpellBar: "() => 0",
    setActiveSpellBar: INERT,
    addToFirstEmptySlot: "() => false",
    SPELL_BAR_TABS: "1",
    SPELL_BAR_SLOTS: "8",
    loadCatalog: "() => Promise.resolve({})",
    resolveBindingIcon: "() => null",
    attachWindowPosition: INERT,
    resolveLocalBinding: "() => null",
    matchesBinding: "() => false",
    LOCAL_ACTION_IDS: "Object.freeze({})",
    getInputFunnel: "() => null",
    inputFunnelV2On: "() => false",
    setAcText: "(el, text) => { if (el) el.textContent = String(text ?? ''); }",
    classifySpell: "() => null",
    isShapeTableLoaded: "() => false",
    SPELL_SHAPE: "Object.freeze({ Undef: 0, Ball: 1, Bolt: 2, Arc: 3, Streak: 4, Volley: 5, Wall: 6, Ring: 7, Blast: 8, Self: 9 })",
    setUseFastMissiles: INERT,
    setAutoRepeatAttacks: INERT,
    isCharacterOptionEnabled: "() => false",
    CHARACTER_OPTION: "Object.freeze({})",
    castSpellViaHandle: INERT,
    getCastSequence: "() => null",
    wrongStanceForArmed: "() => false",
    castCooldownMs: "() => 0",
    castSweepReducer: "() => 0",
    suggestedCombatModeFromInventory: "() => 2",
  },
});
// eslint-disable-next-line no-new-func
const mod = new Function(
  body + "\nreturn { readSkillTrainingLevel, readRecklessnessTrainingLevel, SKILL_TYPE_MANA_CONVERSION, SKILL_TYPE_RECKLESSNESS };\n",
)();

/* ── assertions ───────────────────────────────────────────────────────── */

check("SKILL_TYPE_MANA_CONVERSION matches ACE Skill.cs ordinal 16", () => {
  assert.equal(mod.SKILL_TYPE_MANA_CONVERSION, 16);
});

check("reads Mana Conversion's own row, not a neighbouring skill's field", () => {
  const v = mod.readSkillTrainingLevel(16);
  assert.equal(
    v,
    2,
    `expected ManaConversion training=2, got ${v} — a stride-5 walk over a ` +
    `stride-6 array lands on the wrong field entirely`,
  );
});

check("returns `training` (index +4), not `ranks` (index +3)", () => {
  // ManaConversion's ranks is 121; if the reader used +3 it would come back
  // as 121 (and the >= 2 test would be true for the wrong reason).
  assert.notEqual(mod.readSkillTrainingLevel(16), 121, "reader is at index +3 (ranks)");
  assert.equal(mod.readSkillTrainingLevel(15), 1, "MagicDefense training should be 1");
  assert.notEqual(mod.readSkillTrainingLevel(15), 132, "MagicDefense ranks leaked through");
});

check("an untrained skill reports < 2 (the tooltip gate stays honest)", () => {
  assert.ok((mod.readSkillTrainingLevel(15) ?? 0) < 2, "MagicDefense is untrained here");
  assert.ok((mod.readSkillTrainingLevel(50) ?? 0) < 2, "Recklessness is untrained here");
});

check("readRecklessnessTrainingLevel delegates to the same stride-6 walker", () => {
  assert.equal(mod.readRecklessnessTrainingLevel(), 0);
});

check("a skill absent from the snapshot returns null, not 0", () => {
  assert.equal(mod.readSkillTrainingLevel(7 /* MissileDefense, not present */), null);
});

check("no stats handle => null (pre-login) rather than a throw", () => {
  const saved = window.__sessionHandle;
  window.__sessionHandle = null;
  try {
    assert.equal(mod.readSkillTrainingLevel(16), null);
  } finally {
    window.__sessionHandle = saved;
  }
});

// The old renderRows() walk, verbatim, against the SAME fixture — so the
// defect is demonstrated here and not merely asserted in a comment.
check("NEGATIVE CONTROL: the old stride-5 walk gives a different answer", () => {
  let manaConvTrained = false;
  let hit = null;
  for (let s = 0; s + 4 < SKILLS.length; s += 5) {
    if (SKILLS[s] === 16) { hit = s; manaConvTrained = SKILLS[s + 3] >= 2; break; }
  }
  // Stride 5 over a stride-6 array never lands on ManaConversion's own row
  // (its type field is at index 12, which is not a multiple of 5).
  assert.equal(hit, null, "fixture must expose the stride mismatch");
  assert.equal(manaConvTrained, false,
    "the old walk reports Mana Conversion UNTRAINED for a player who has it trained");
  assert.equal(mod.readSkillTrainingLevel(16) >= 2, true,
    "the stride-6 walker reports it trained — the two disagree, which is the bug");
});

check("an empty skills array => null", () => {
  const saved = window.__sessionHandle;
  window.__sessionHandle = { playerStats: () => ({ skills: [] }) };
  try {
    assert.equal(mod.readSkillTrainingLevel(16), null);
  } finally {
    window.__sessionHandle = saved;
  }
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
