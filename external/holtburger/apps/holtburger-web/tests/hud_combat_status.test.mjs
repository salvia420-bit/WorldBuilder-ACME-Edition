// tests/hud_combat_status.test.mjs — HUD overhaul 2026-10-05, combat + status
// panels. Pure-logic coverage for the pieces the overhaul added:
//
//   [1] combat-hud computeDockBottom — the panel docks just above the
//       bottom-centre toolbar stack, in its OWN zoomed HUD px, ignoring
//       top/side HUD, transient tooltips and full-viewport overlays.
//   [2] combat-hud keyboard — PgDn/End/Del attack High/Medium/Low (retail
//       ATTACK_HEIGHT 1/2/3) — press starts the power bar, release attacks
//       (hold to charge, ui/attack_power_bar.js) — Ins/PgUp step the power by
//       10%, only in a melee/missile stance, and Delete stands down while the
//       spellbook's "forget spell" action owns it.
//   [3] vitae-detail vitaeSummary — gmVitaeUI::Update: penalty %, threshold
//       from DeathLevel (fallback Level), experience still owed = threshold −
//       VitaeCpPool.
//   [4] buffs-hud sortEffects / tooltipLines — retail gmEffectsUI keeps the
//       list sorted by spell name; the tooltip never shows a raw hex guid.
//
// Run from apps/holtburger-web/:  node tests/hud_combat_status.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spliceModule } from "../harness/lib/splice_module.mjs";
import { createAttackCharge } from "../ui/attack_power_bar.js";

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

/* ── combat-hud, spliced with explicit inert stubs ─────────────────────── */

const fired = [];      // heights of the PRIMARY attack requests
const firedFull = [];  // [height, power, followUp] for every request
let funnelActions = [];
let clockMs = 0;
globalThis.window = {
  __combatBarState: { powerLevel: 0.5, attackHeight: 2 },
  __getCurrentStanceLow: () => 0x3c, // a melee stance
  __fireAttackOnTarget: (h, p, o) => {
    firedFull.push([h, p, !!o?.followUp]);
    if (!o?.followUp) fired.push(h);
  },
  innerWidth: 1600,
  innerHeight: 900,
};
// The REAL hold-to-charge controller on a fake clock (no rAF: the tests
// drive release / tick explicitly).
const testCharge = createAttackCharge({
  now: () => clockMs,
  fire: (h, p, o) => window.__fireAttackOnTarget(h, p, o),
  getSlider: () => window.__combatBarState.powerLevel,
});
testCharge.onChange = () => () => {};
globalThis.__testCharge = testCharge;
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
const bodyChildren = [];
globalThis.document = {
  getElementById: () => null,
  head: { appendChild() {} },
  body: { children: bodyChildren },
};

const src = readFileSync(path.join(APP, "plugins", "combat-hud.js"), "utf8");
const body = spliceModule(src, {
  label: "plugins/combat-hud.js",
  provided: [],
  stubs: {
    setAcText: "(el, text) => { if (el) el.__text = text; }",
    readTrainingLevel: "() => null",
    SKILL_RECKLESSNESS: "50",
    TRAINING_TRAINED: "2",
    TRAINING_SPECIALIZED: "3",
    RECKLESSNESS_BAND_MIN: "0.10",
    RECKLESSNESS_BAND_MAX: "0.90",
    attachWindowPosition: "() => ({ getState: () => ({ x: null, y: null }) })",
    WINDOW_ID: "Object.freeze({ COMBAT_HUD: 0x1000004B })",
    setAutoRepeatAttacks: "() => {}",
    isCharacterOptionEnabled: "() => null",
    CHARACTER_OPTION: "Object.freeze({ AutoRepeatAttacks: 0 })",
    getInputFunnel: "() => ({ actions: globalThis.__testFunnelActions() })",
    inputFunnelV2On: "() => false",
    getAttackCharge: "() => globalThis.__testCharge",
  },
});
globalThis.__testFunnelActions = () => funnelActions;
// eslint-disable-next-line no-new-func
const hud = new Function(body + "\nreturn { computeDockBottom, onCombatKey, onCombatKeyUp, state, HEIGHTS };\n")();

function rectEl(id, r) {
  return {
    id,
    getBoundingClientRect: () => ({
      left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height,
      width: r.width, height: r.height,
    }),
  };
}

console.log("\n[1] combat-hud dock above the toolbar");

check("no bottom-centre HUD → the fallback bottom", () => {
  bodyChildren.length = 0;
  assert.equal(hud.computeDockBottom({ currentCSSZoom: 1 }), 124);
});

check("docks 6 HUD px above the tallest bottom-centre root, in the panel's own zoom", () => {
  bodyChildren.length = 0;
  // 1600×900 at HUD zoom 1.25: toolbar 390 screen-px wide centred, top at
  // screen y 760 (140 screen px tall) → (900-760)/1.25 + 6 = 118.
  bodyChildren.push(rectEl("hb-hotbar", { left: 605, top: 760, width: 390, height: 130 }));
  assert.equal(hud.computeDockBottom({ currentCSSZoom: 1.25 }), 118);
  // A target bar stacked above it (top 700) wins: (900-700)/1.25 + 6 = 166.
  bodyChildren.push(rectEl("hb-target-bar", { left: 640, top: 700, width: 320, height: 40 }));
  assert.equal(hud.computeDockBottom({ currentCSSZoom: 1.25 }), 166);
});

check("chat (bottom-left), radar (top-right), tooltips and overlays are ignored", () => {
  bodyChildren.length = 0;
  bodyChildren.push(rectEl("hb-hotbar", { left: 605, top: 760, width: 390, height: 130 }));
  bodyChildren.push(rectEl("hb-chat-panel", { left: 8, top: 600, width: 420, height: 290 }));
  bodyChildren.push(rectEl("hb-radar", { left: 1450, top: 10, width: 140, height: 140 }));
  bodyChildren.push(rectEl("hb-hover-tooltip", { left: 700, top: 500, width: 200, height: 250 }));
  bodyChildren.push(rectEl("hb-thought-overlay", { left: 0, top: 0, width: 1600, height: 900 }));
  bodyChildren.push(rectEl("not-hud", { left: 600, top: 300, width: 400, height: 600 }));
  bodyChildren.push(rectEl("hb-spell-strip", { left: 500, top: 600, width: 600, height: 90 }));
  assert.equal(hud.computeDockBottom({ currentCSSZoom: 1.25 }), 118);
});

check("never climbs above mid-screen", () => {
  bodyChildren.length = 0;
  bodyChildren.push(rectEl("hb-loot-window", { left: 500, top: 300, width: 600, height: 450 }));
  // height 450 ≤ 0.5×900 and bottom 750 ≥ 0.7×900 → counted; capped at vh/2.
  assert.equal(hud.computeDockBottom({ currentCSSZoom: 1 }), 450);
});

console.log("\n[2] combat-hud keyboard (melee / missile)");

// A full key press: keydown, `holdMs` of holding, keyup (the bar's build).
const key = (code, extra = {}, holdMs = 1000) => {
  let prevented = false;
  hud.onCombatKey({ code, repeat: false, preventDefault() { prevented = true; }, ...extra });
  clockMs += holdMs;
  hud.onCombatKeyUp({ code });
  return prevented;
};

check("PgDn / End / Del → High (1) / Medium (2) / Low (3)", () => {
  hud.state.visible = true;
  fired.length = 0;
  assert.equal(key("PageDown"), true);
  key("End");
  key("Delete");
  assert.deepEqual(fired, [1, 2, 3]);
  assert.equal(window.__combatBarState.attackHeight, 3, "the requested height follows the last attack");
});

check("press only starts the bar — the attack goes out on release (hold to charge)", () => {
  fired.length = 0;
  firedFull.length = 0;
  hud.onCombatKey({ code: "End", repeat: false, preventDefault() {} });
  assert.deepEqual(fired, [], "nothing fires while the key is held");
  assert.equal(window.__combatBarState.attackHeight, 2, "the height is requested on press");
  clockMs += 800; // charged to 80 % — past the 50 % selector
  hud.onCombatKeyUp({ code: "End" });
  assert.deepEqual(firedFull, [[2, 0.8, false], [2, 0.5, true]],
    "the charged swing at 80 %, then the selector power for the repeats");
});

check("a quick tap attacks at the selector once the bar reaches it", () => {
  firedFull.length = 0;
  hud.onCombatKey({ code: "PageDown", repeat: false, preventDefault() {} });
  clockMs += 50;
  hud.onCombatKeyUp({ code: "PageDown" });
  assert.deepEqual(firedFull, [], "a 50 ms tap waits for the bar");
  clockMs += 450; // bar at the 50 % selector
  testCharge.tick();
  assert.deepEqual(firedFull, [[1, 0.5, false]]);
});

check("held-key auto-repeat does not spam attacks", () => {
  fired.length = 0;
  hud.onCombatKey({ code: "End", repeat: false, preventDefault() {} });
  hud.onCombatKey({ code: "End", repeat: true, preventDefault() {} });
  hud.onCombatKey({ code: "End", repeat: true, preventDefault() {} });
  clockMs += 1000;
  hud.onCombatKeyUp({ code: "End" });
  assert.deepEqual(fired, [2], "one attack per press, however long the OS repeats");
});

check("Ins / PgUp step the power by 10% and publish it", () => {
  window.__combatBarState.powerLevel = 0.5;
  hud.state.lastPublishedPower = null;
  key("PageUp");
  assert.equal(window.__combatBarState.powerLevel, 0.6);
  key("Insert");
  key("Insert");
  assert.equal(window.__combatBarState.powerLevel, 0.4);
  assert.equal(JSON.parse(localStorage.getItem("holtburger_combat_bar_v1")).powerLevel, 0.4,
    "a HUD power change persists to combat-bar's record");
});

check("modifier combos and non-combat stances are ignored", () => {
  fired.length = 0;
  key("End", { ctrlKey: true });
  window.__getCurrentStanceLow = () => 0x3d; // peace
  key("End");
  window.__getCurrentStanceLow = () => 0x49; // magic — the spell strip owns End
  key("End");
  window.__getCurrentStanceLow = () => 0x3c;
  assert.deepEqual(fired, []);
});

check("Delete stands down while the spellbook's forget-spell action is armed", () => {
  fired.length = 0;
  funnelActions = [{ labelHash: "0xFF000011", when: () => true }];
  key("Delete");
  assert.deepEqual(fired, []);
  funnelActions = [{ labelHash: "0xFF000011", when: () => false }];
  key("Delete");
  assert.deepEqual(fired, [3]);
  funnelActions = [];
});

check("hidden panel → keys pass through untouched", () => {
  hud.state.visible = false;
  fired.length = 0;
  assert.equal(key("End"), false);
  assert.deepEqual(fired, []);
});

/* ── vitae-detail ─────────────────────────────────────────────────────── */

console.log("\n[3] vitae-detail (gmVitaeUI::Update)");
// vitae-detail.js touches `window` only behind typeof guards at import time.
const savedWindow = globalThis.window;
delete globalThis.window;
const vitae = await import(pathToFileURL(path.join(APP, "plugins", "vitae-detail.js")).href);
globalThis.window = savedWindow;
const { vitaeSummary, vitaeCpPoolThreshold } = vitae.__test;

check("full vitae → no penalty block", () => {
  const s = vitaeSummary({ vitae: 1.0, level: 50 });
  assert.equal(s.full, true);
  assert.equal(s.pct, 0);
});

check("penalty % = 100 − round(vitae × 100) (retail rounding)", () => {
  assert.equal(vitaeSummary({ vitae: 0.95, level: 50 }).pct, 5);
  assert.equal(vitaeSummary({ vitae: 0.904, level: 50 }).pct, 10);
  assert.equal(vitaeSummary({ vitae: 0.906, level: 50 }).pct, 9);
});

check("threshold uses DeathLevel, falling back to Level", () => {
  const t = vitaeCpPoolThreshold(0.95, 40);
  assert.equal(vitaeSummary({ vitae: 0.95, level: 99, deathLevel: 40 }).threshold, t);
  assert.equal(vitaeSummary({ vitae: 0.95, level: 40 }).threshold, t);
  // ACE Player_Xp.cs VitaeCPPoolThreshold: (40^2.5 × 2.5 + 20) × 0.95^5 + 0.5
  assert.equal(t, Math.floor((Math.pow(40, 2.5) * 2.5 + 20) * Math.pow(0.95, 5) + 0.5));
});

check("experience owed = threshold − VitaeCpPool, with progress", () => {
  const s = vitaeSummary({ vitae: 0.95, level: 40, cpPool: 1000 });
  assert.equal(s.cpLeft, s.threshold - 1000);
  assert.ok(s.progress > 0 && s.progress < 1);
  const unknownPool = vitaeSummary({ vitae: 0.95, level: 40 });
  assert.equal(unknownPool.cpLeft, unknownPool.threshold, "unknown pool → the whole threshold");
  assert.equal(unknownPool.progress, null);
});

/* ── buffs-hud ────────────────────────────────────────────────────────── */

console.log("\n[4] buffs-hud (gmEffectsUI)");
window.__sessionHandle = {
  getSpellRecord: (id) => ({
    1: { name: "Strength Self I", iconId: 0, isBeneficial: true, schoolName: "Creature Enchantment" },
    2: { name: "Armor Self I", iconId: 0, isBeneficial: true, schoolName: "Life Magic" },
    3: { name: "Weakness Other I", iconId: 0, isBeneficial: false, schoolName: "Creature Enchantment" },
  })[id] ?? null,
};
window.getLocalPlayerGuid = () => 0x50000001;
const buffs = await import(pathToFileURL(path.join(APP, "plugins", "buffs-hud.js")).href);
const { sortEffects, tooltipLines, state: buffsState } = buffs.__test;

check("effects sort by spell name (gmEffectsUI::GetSortedInsertionPlace strcmp)", () => {
  const list = [
    { spellId: 3, layeredId: 3 << 16, duration: 60, startTime: 0 },
    { spellId: 1, layeredId: 1 << 16, duration: 600, startTime: 0 },
    { spellId: 2, layeredId: 2 << 16, duration: 30, startTime: 0 },
  ];
  assert.deepEqual(sortEffects(list).map((e) => e.spellId), [2, 1, 3]);
});

check("tooltip names the caster in words — never a hex guid", () => {
  buffsState.getCasterName = () => null;
  const self = tooltipLines({ spellId: 1, casterGuid: 0x50000001, duration: -1, type: 0, statKey: 0, statValue: 0 }, "buff");
  assert.ok(self.lines.some((l) => l.text === "Cast by You"), JSON.stringify(self.lines));
  const unknown = tooltipLines({ spellId: 1, casterGuid: 0x80001234, duration: 600, startTime: 0, type: 0 }, "buff");
  assert.ok(!unknown.lines.some((l) => /0x|Cast by/.test(l.text)), JSON.stringify(unknown.lines));
  assert.equal(unknown.name, "Strength Self I");
  assert.equal(unknown.kind, "Positive effect");
  assert.ok(self.lines.some((l) => l.text === "Permanent"));
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
