// tests/spellbar_endowment_strip.test.mjs — hud-ui-8 (2026-10-13).
//
// The endowment cell wired into the REAL spell strip: plugins/combat-bar.js
// spliced (harness/lib/splice_module.mjs, explicit stubs for its static
// imports) onto the fake DOM in tests/helpers/fake_dom_items.mjs, with the
// real ui/ac_spell_endowment.js loaded by the strip's own lazy import and a
// recording fake SessionHandle. Drives the strip the way the MagicCombat
// keys do (window-level __stripApi: selectDelta / selectEdge / castCurrent)
// plus the cell's click / dblclick / contextmenu, and checks:
//   - a held caster with a built-in spell shows the cell ahead of slot 1,
//     auto-selected (UpdateEndowmentIcon), with retail's tooltip;
//   - Cast with it selected = UseWithTarget(item, target), or the 0x1A
//     "Select your target before using the %s" line;
//   - the walks run [endowment, 0..N-1] and wrap; a bar pick deselects it;
//   - unwielding hides it and Cast falls back to the old "No spell selected";
//   - `?spellbarEndowment=off` = no cell, old selection / Cast.
// Layout / art are the 1070 eye-test's job.
//
// Run from apps/holtburger-web/:  node tests/spellbar_endowment_strip.test.mjs
// (~3 s: the strip refreshes on its 500 ms visibility poll.)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeDom, FakeEvent } from "./helpers/fake_dom_items.mjs";
import { spliceModule } from "../harness/lib/splice_module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL = 650; // > one 500 ms strip poll

// ── fake session ────────────────────────────────────────────────────────
const ME = 0x50000001;
const WAND = 0x60000010;
const TARGET = 0x50000099;
const SPELL = 1785;
const HELD = 0x01000000;
const inv = [
  { guid: 0x60000001, name: "Bread", itemType: 0x80, equipMask: 0, iconId: 0 },
  { guid: WAND, name: "Wand of Testing", itemType: 0x8000, equipMask: HELD, iconId: 0, uiEffects: 0 },
];
const calls = [];
window.__sessionHandle = {
  playerInventory: () => inv.map((r) => ({ ...r, free() {} })),
  objectDataIdProperty: (g, k) => ((g >>> 0) === WAND && k === 28 ? SPELL : undefined),
  objectIntProperty: (g, k) => ((g >>> 0) === WAND && k === 16 ? 0x600004 : undefined),
  getSpellRecord: (id) => (id === SPELL ? new Map([["name", "Flame Bolt I"]]) : null),
  useWithTarget: (a, b) => calls.push(["useWithTarget", a >>> 0, b >>> 0]),
  useObject: (g) => calls.push(["useObject", g >>> 0]),
};
window.getLocalPlayerGuid = () => ME;
window.__getCurrentStanceLow = () => 0x49; // magic stance → strip visible
let selectedTarget = 0;
window.liveScene3d = { entityManager: { getSelectedTarget: () => selectedTarget } };
const chat = [];
window.__appendChatLine = (text, category) => chat.push([String(text), category]);
const examined = [];
window.__showExamineFor = (g, opts) => examined.push([g >>> 0, opts?.name]);
const bus = new Map();
window.__pluginClient = {
  events: {
    on(name, fn) { if (!bus.has(name)) bus.set(name, []); bus.get(name).push(fn); },
    off() {},
    emit(name, detail) { for (const fn of bus.get(name) ?? []) fn(detail); },
  },
};

// The open tab: slot 0 = a self spell, slot 2 = a targeted spell.
globalThis.__T = {
  slots: [101, 0, 102, ...Array(15).fill(0)],
  catalog: {
    101: { name: "Strength Self I", untargeted: true },
    102: { name: "Flame Bolt II", untargeted: false },
  },
  casts: [],
  refusals: [],
};

// ── load the strip ──────────────────────────────────────────────────────
const INERT = "() => undefined";
const STUBS = {
  getSpellBarSlots: "() => globalThis.__T.slots",
  setSpellBarSlot: INERT,
  getActiveSpellBar: "() => 0",
  setActiveSpellBar: INERT,
  addToFirstEmptySlot: "() => false",
  SPELL_BAR_TABS: "8",
  SPELL_BAR_SLOTS: "18",
  loadCatalog: "() => Promise.resolve(globalThis.__T.catalog)",
  resolveBindingIcon: "() => Promise.resolve(null)",
  attachWindowPosition: "() => null",
  resolveLocalBinding: "() => null",
  matchesBinding: "() => false",
  LOCAL_ACTION_IDS: "Object.freeze({})",
  getInputFunnel: "() => null",
  inputFunnelV2On: "() => false",
  setAcText: "(el, text) => { if (el) el.textContent = String(text ?? ''); }",
  classifySpell: "() => null",
  isShapeTableLoaded: "() => false",
  SPELL_SHAPE: "Object.freeze({ Bolt: 'Bolt', Arc: 'Arc', Streak: 'Streak', Volley: 'Volley', Wall: 'Wall', Ring: 'Ring', Blast: 'Blast', Self: 'Self' })",
  setUseFastMissiles: INERT,
  setAutoRepeatAttacks: INERT,
  isCharacterOptionEnabled: "() => false",
  CHARACTER_OPTION: "Object.freeze({})",
  castSpellViaHandle: "(id, tgt) => { globalThis.__T.casts.push([id, tgt]); return true; }",
  spellTargetClass: "() => 'target'",
  announceCastRefusal: "(msg) => { globalThis.__T.refusals.push(msg); }",
  MSG_NO_SELECTION: "'You must select a suitable target before casting this spell'",
  noteCombatModeRequest: INERT,
  refuseCombatModeInPortalSpace: "() => false",
  getCastSequence: "() => null",
  wrongStanceForArmed: "() => false",
  castCooldownMs: "() => 0",
  castSweepReducer: "() => ({ ignored: true })",
  suggestedCombatModeFromInventory: "() => 2",
  getAttackCharge: "() => null",
};
const SRC = readFileSync(path.join(APP, "plugins", "combat-bar.js"), "utf8");
function loadStrip() {
  const body = spliceModule(SRC, { label: "plugins/combat-bar.js", provided: [], stubs: STUBS });
  // eslint-disable-next-line no-new-func
  return new Function(body + "\nreturn { api: () => __stripApi };\n")();
}

const q = (sel) => document.querySelector(sel);
const endowCell = () => q("#hb-spell-strip .hb-ss-endow");
const slotCell = (i) => q(`#hb-spell-strip .hb-ss-slot[data-slot="${i}"]`);
const nameLine = () => q("#hb-spell-strip .hb-ss-name")?.textContent ?? "";
const armed = () => (window.__combatBarState?.armedSpellId | 0);

let mod = loadStrip();
const api = () => mod.api();
await sleep(POLL);

console.log("\n[1] UpdateEndowmentIcon — the cell appears for the held caster");
await check("the endowment cell is the bank's first child and shown", () => {
  const cell = endowCell();
  assert.ok(cell, "cell exists");
  assert.equal(q("#hb-spell-strip .hb-ss-slots").firstElementChild, cell, "ahead of slot 1");
  assert.equal(cell.style.display, "");
  assert.ok(cell.classList.contains("bound"));
});
await check("retail tooltip: 'Wand of Testing (Flame Bolt I)\\nDouble-click to cast this spell'", () => {
  assert.equal(endowCell().title, "Wand of Testing (Flame Bolt I)\nDouble-click to cast this spell");
});
await check("no spell selected → the endowment is the selection (ring + name line + well)", () => {
  assert.ok(endowCell().classList.contains("selected"));
  assert.equal(nameLine(), "Wand of Testing (Flame Bolt I)");
  assert.ok(q("#hb-spell-strip .hb-ss-current").classList.contains("has-spell"));
});

console.log("\n[2] Cast with the endowment selected — ItemHolder::UseObject");
await check("no target → 0x1A 'Select your target before using the Wand of Testing', nothing sent", () => {
  selectedTarget = 0;
  api().castCurrent();
  assert.deepEqual(calls, []);
  assert.deepEqual(chat.at(-1), ["Select your target before using the Wand of Testing", 9]);
  assert.equal(globalThis.__T.casts.length, 0, "no bar-spell cast");
});
await check("with a target → UseWithTarget(wand, target)", async () => {
  await sleep(250); // retail's 0.2 s m_timeLastUsed gate
  selectedTarget = TARGET;
  api().castCurrent();
  assert.deepEqual(calls, [["useWithTarget", WAND, TARGET]]);
  assert.equal(nameLine(), "Wand of Testing (Flame Bolt I)");
});

console.log("\n[3] the selection walks include the endowment");
await check("next: endowment → slot 0 → slot 2 → endowment", () => {
  api().selectDelta(+1);
  assert.ok(slotCell(0).classList.contains("selected"));
  assert.equal(endowCell().classList.contains("selected"), false, "a bar pick deselects it");
  assert.equal(armed(), 0, "self spell → nothing armed");
  api().selectDelta(+1);
  assert.ok(slotCell(2).classList.contains("selected"));
  assert.equal(armed(), 102, "targeted spell armed");
  api().selectDelta(+1);
  assert.ok(endowCell().classList.contains("selected"), "wraps to the endowment");
  assert.equal(armed(), 0, "selecting the endowment disarms");
});
await check("prev: endowment → slot 2 → slot 0 → endowment", () => {
  api().selectDelta(-1);
  assert.ok(slotCell(2).classList.contains("selected"));
  api().selectDelta(-1);
  assert.ok(slotCell(0).classList.contains("selected"));
  api().selectDelta(-1);
  assert.ok(endowCell().classList.contains("selected"));
});
await check("last → slot 2, first → the endowment", () => {
  api().selectEdge("last");
  assert.ok(slotCell(2).classList.contains("selected"));
  api().selectEdge("first");
  assert.ok(endowCell().classList.contains("selected"));
});
await check("a bar spell selected → Cast casts the spell, not the item", () => {
  api().selectDelta(+1); // slot 0, self spell
  const before = calls.length;
  api().castCurrent();
  assert.deepEqual(globalThis.__T.casts.at(-1), [101, null]);
  assert.equal(calls.length, before, "no item use");
});

console.log("\n[4] the cell's own messages");
await check("click selects it (7); double-click casts (10)", async () => {
  endowCell().dispatchEvent(new FakeEvent("click"));
  assert.ok(endowCell().classList.contains("selected"));
  await sleep(250);
  api().selectDelta(+1); // move off it, then double-click straight back
  endowCell().dispatchEvent(new FakeEvent("dblclick"));
  assert.ok(endowCell().classList.contains("selected"));
  assert.deepEqual(calls.at(-1), ["useWithTarget", WAND, TARGET]);
});
await check("right-click examines the item (8)", () => {
  const ev = new FakeEvent("contextmenu");
  endowCell().dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(examined.at(-1), [WAND, "Wand of Testing"]);
});

console.log("\n[5] unwield → no endowment, the old Cast path");
await check("an inventory event re-reads it: hidden, deselected, Cast says 'No spell selected'", async () => {
  inv[1].equipMask = 0;
  window.__pluginClient.events.emit("playerInventoryChanged", {});
  await sleep(POLL);
  assert.equal(endowCell().style.display, "none");
  assert.equal(endowCell().classList.contains("selected"), false);
  const before = calls.length;
  api().castCurrent();
  assert.equal(calls.length, before, "no item use");
  assert.match(nameLine(), /^No spell selected/);
});
await check("no endowment → the walks are the old bound-cell wrap", () => {
  api().selectDelta(-1); // nothing selected → last bound
  assert.ok(slotCell(2).classList.contains("selected"));
  api().selectDelta(+1);
  assert.ok(slotCell(0).classList.contains("selected"));
});

console.log("\n[6] ?spellbarEndowment=off");
await check("off: a held caster shows no cell and Cast keeps the old path", async () => {
  document.getElementById("hb-spell-strip")?.remove();
  window.location.search = "?spellbarEndowment=off";
  inv[1].equipMask = HELD;
  try { localStorage.removeItem("holtburger_combat_bar_v1"); } catch (_) {}
  mod = loadStrip();
  await sleep(POLL);
  const cell = endowCell();
  assert.ok(cell, "the (inert) cell element exists");
  assert.equal(cell.style.display, "none");
  const before = calls.length;
  api().castCurrent();
  assert.equal(calls.length, before, "no item use");
  assert.match(nameLine(), /^No spell selected/);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
