// tests/character_info_tab_labels.test.mjs — character pane contract.
//
// History: round-9 review finding R9-9 — setTab() re-derived tab labels
// from live DOM text, which <ac-text>._render() empties, so clicking a tab
// relabelled the strip with lowercase ids. HUD overhaul 2026-10-05 moved
// the tabs to kit `hbk-tab` buttons with plain text labels written ONCE,
// and fixed the "+Tester — Attributes" title over a highlighted SKILLS tab
// (nameFor defaulted to Attributes while mount defaulted to Skills).
//
// This suite pins:
//   1. labels survive any number of tab switches (R9-9 regression);
//   2. the selected tab ALWAYS matches the main-panel title — at mount
//      (nameFor(ctx) vs the aria-selected tab, with and without ctx.tab)
//      and after clicks (setTitle is called with the clicked tab's title);
//   3. F1 with no ctx reopens the last-used tab;
//   4. the Skills model groups like retail gmSkillUI::RebuildSkillList
//      (Specialized / Trained / Untrained / Unusable, alphabetical) and
//      prices +10 from the ExperienceTable like GetCostToRaise10;
//   5. footerModel mirrors DisplayDefaultFooter / DisplaySelectionFooter_*.
//
// NEGATIVE CONTROL: (2) is asserted for every tab id, so a hard-coded
// title or a hard-coded default tab fails at least one case.
//
// Run from apps/holtburger-web/:
//   node tests/character_info_tab_labels.test.mjs

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

/* ── DOM shim ─────────────────────────────────────────────────────────── */

function makeEl(tag = "div") {
  const attrs = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], parentNode: null,
    style: { setProperty(k, v) { this[k] = v; } },
    dataset: {}, className: "", id: "", type: "", title: "",
    _text: "",
    get textContent() {
      if (el.children.length) return el.children.map((c) => c.textContent).join("");
      return el._text;
    },
    set textContent(v) { el._text = String(v ?? ""); el.children.length = 0; },
    innerHTML: "", value: "", disabled: false, scrollTop: 0,
    get isConnected() { return true; },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on ?? !this._s.has(c)) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { if (c) { c.parentNode = el; el.children.push(c); } return c; },
    append(...cs) { for (const c of cs) el.appendChild(c); },
    replaceChildren(...cs) { el.children.length = 0; for (const c of cs) el.appendChild(c); },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    addEventListener(n, fn) { (el._h ??= {})[n] = fn; },
    removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: (k) => attrs[k] ?? null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    focus() {},
    ownerDocument: null,
  };
  return el;
}

globalThis.document = {
  createElement: makeEl,
  getElementById: () => null,
  head: makeEl("head"),
  body: makeEl("body"),
  addEventListener() {}, removeEventListener() {},
};
const titleCalls = [];
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  location: { search: "" },
  __pluginClient: { events: { on() {}, off() {} }, player: { stats: null, skillCredits: 0 } },
  __sessionHandle: null,
  __mainPanel: { setTitle: (t) => { titleCalls.push(t); return true; } },
};
globalThis.performance = { now: () => 0 };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.fetch = () => Promise.resolve({ ok: false, json: async () => null });

/* ── load the plugin with the REAL pure helpers ───────────────────────── */

const TS = await import(pathToFileURL(path.join(APP, "plugins", "train-skills.js")).href);
globalThis.__TS = TS;
globalThis.__lastAcText = new Map();

const src = readFileSync(path.join(APP, "plugins", "character-info.js"), "utf8");
function load() {
  const body = spliceModule(src, {
    label: "plugins/character-info.js",
    provided: [],
    stubs: {
      setAcText: "(el, text) => { if (el) globalThis.__lastAcText.set(el, String(text ?? '')); }",
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
    },
  });
  // eslint-disable-next-line no-new-func
  return new Function(body + "\nreturn { view, footerModel, __test };\n")();
}

function tabButtons(parent) {
  const btns = [];
  (function walk(n) {
    for (const c of n.children ?? []) {
      if (c.dataset?.tab) btns.push(c);
      walk(c);
    }
  })(parent);
  return btns;
}
const selectedTab = (btns) => btns.find((b) => b.getAttribute("aria-selected") === "true")?.dataset.tab;
const TITLES = { attributes: "Attributes", skills: "Skills", titles: "Character Titles" };

/* ── 1. labels ────────────────────────────────────────────────────────── */

await check("labels survive repeated tab switches (R9-9)", () => {
  const mod = load();
  const parent = makeEl("div");
  mod.view.mount(parent, { tab: "skills" });
  const btns = tabButtons(parent);
  assert.equal(btns.length, 3, "expected three tab buttons");
  for (let i = 0; i < 7; i += 1) btns[i % 3]._h.click();
  assert.deepEqual(btns.map((b) => b.textContent), ["Attributes", "Skills", "Titles"]);
});

/* ── 2. title ⇔ selected tab ──────────────────────────────────────────── */

for (const tab of ["attributes", "skills", "titles"]) {
  await check(`mount ctx.tab=${tab}: nameFor title matches the selected tab`, () => {
    const mod = load();
    const parent = makeEl("div");
    const title = mod.view.nameFor({ tab });
    mod.view.mount(parent, { tab });
    const sel = selectedTab(tabButtons(parent));
    assert.equal(sel, tab);
    assert.equal(title, TITLES[sel]);
  });
}

await check("mount with NO ctx (F1): nameFor and the selected tab agree", () => {
  const mod = load();
  const parent = makeEl("div");
  const title = mod.view.nameFor({});
  mod.view.mount(parent, {});
  const sel = selectedTab(tabButtons(parent));
  assert.equal(title, TITLES[sel], `title "${title}" but "${sel}" tab highlighted`);
});

await check("clicking a tab retitles the panel with that tab's title", () => {
  const mod = load();
  const parent = makeEl("div");
  mod.view.mount(parent, { tab: "attributes" });
  const btns = tabButtons(parent);
  for (const b of btns) {
    titleCalls.length = 0;
    b._h.click();
    assert.equal(selectedTab(btns), b.dataset.tab);
    assert.equal(titleCalls.at(-1), TITLES[b.dataset.tab]);
  }
});

/* ── 3. F1 remembers the last tab ─────────────────────────────────────── */

await check("F1 (no ctx) reopens the last-used tab", () => {
  const mod = load();
  const a = makeEl("div");
  mod.view.mount(a, { tab: "attributes" });
  tabButtons(a).find((b) => b.dataset.tab === "titles")._h.click();
  assert.equal(mod.view.nameFor({}), "Character Titles");
  const b = makeEl("div");
  mod.view.mount(b, {});
  assert.equal(selectedTab(tabButtons(b)), "titles");
});

/* ── 4. skills model ──────────────────────────────────────────────────── */

const SKILL_TABLE = {
  skills: [
    { skillIdInt: 6, name: "Melee Defense", iconIdHex: "0x06000165", trainedCost: 10, minLevel: 1 },
    { skillIdInt: 15, name: "Magic Defense", iconIdHex: "0x06000168", trainedCost: 12, minLevel: 1 },
    { skillIdInt: 14, name: "Arcane Lore", iconIdHex: "0x06000167", trainedCost: 4, minLevel: 1 },
    { skillIdInt: 20, name: "Deception", iconIdHex: "0x0600016B", trainedCost: 6, minLevel: 1 },
    { skillIdInt: 54, name: "Summoning", iconIdHex: "0x06006A5C", trainedCost: 8, minLevel: 1 },
    { skillIdInt: 50, name: "Gearcraft", iconIdHex: "0x06006A00", trainedCost: 0, minLevel: 20 },
  ],
};
// trained curve: cumulative xp by rank
const TRAINED = [0, 10, 30, 60, 100, 150, 210, 280, 360, 450, 550, 660, 780];
const SPEC = [0, 5, 15, 30, 50, 75, 105, 140, 180, 225, 275, 330, 390];
const XP = { trainedSkills: TRAINED, specializedSkills: SPEC, attributes: TRAINED, vitals: TRAINED, levels: [0, 0, 1000, 2777] };
// stride-6 [id, cur, base, ranks, training, marginal]
const STATS = {
  name: "Tester",
  attributes: [1, 100, 100, 3, 2, 120, 110, 4],
  vitals: [1, 40, 55, 60],
  skills: [
    6, 200, 190, 4, 3, 25,     // Melee Defense — specialized, rank 4, spent 50 → +1 = 75-50
    15, 150, 150, 2, 2, 30,    // Magic Defense — trained, rank 2, spent 30
    14, 120, 120, 3, 2, 25,    // Arcane Lore — trained, rank 3, PARTIAL: spent 100-25 = 75
    20, 30, 30, 0, 1, 0,       // Deception — untrained
    54, 0, 0, 0, 0, 0,         // Summoning — inactive → unusable
    50, 10, 10, 0, 1, 0,       // Gearcraft — untrained but min_level 20 → unusable
  ],
  levelInfo: [1, 0, 0, 500, 0, 0, 0],
};

await check("skills: retail sections in order, alphabetical inside", () => {
  const mod = load();
  const items = mod.__test.buildSkillModel(STATS, SKILL_TABLE, XP);
  const layout = items.map((i) => (i.kind === "header" ? `#${i.group}` : i.name));
  assert.deepEqual(layout, [
    "#specialized", "Melee Defense",
    "#trained", "Arcane Lore", "Magic Defense",
    "#untrained", "Deception",
    "#unusable", "Gearcraft", "Summoning",
  ]);
});

await check("skills: +1 uses the server marginal, +10 = table[r+10] − spent (GetCostToRaise10)", () => {
  const mod = load();
  const items = mod.__test.buildSkillModel(STATS, SKILL_TABLE, XP);
  const md = items.find((i) => i.key === "skill:6");
  assert.deepEqual(md.cost1, { cost: 25, ranks: 1 });
  assert.deepEqual(md.cost10, { cost: SPEC[12] - (SPEC[5] - 25), ranks: 8 }, "capped at the table end");
  const al = items.find((i) => i.key === "skill:14");
  // spent = TRAINED[4] − 25 = 75 (partial rank) → +10 = TRAINED[12] − 75
  assert.deepEqual(al.cost10, { cost: TRAINED[12] - 75, ranks: 9 });
  const dec = items.find((i) => i.key === "skill:20");
  assert.equal(dec.cost1, null, "untrained skills are trained, not raised");
});

await check("attributes: retail order Str/End/Coord/Quick/Focus/Self + vitals section", () => {
  const mod = load();
  const stats = {
    ...STATS,
    attributes: [1, 10, 10, 0, 2, 20, 20, 0, 3, 30, 30, 0, 4, 40, 40, 0, 5, 50, 50, 0, 6, 60, 60, 0],
    vitals: [1, 10, 15, 15, 3, 20, 25, 25, 5, 30, 70, 70],
  };
  const items = mod.__test.buildAttributeModel(stats, XP);
  assert.deepEqual(items.map((i) => i.name ?? `#${i.label}`), [
    "#Attributes", "Strength", "Endurance", "Coordination", "Quickness", "Focus", "Self",
    "#Vitals", "Health", "Stamina", "Mana",
  ]);
});

/* ── 5. footer ────────────────────────────────────────────────────────── */

await check("footer default (skills): retail DisplayDefaultFooter lines, buttons off", () => {
  const mod = load();
  const f = mod.footerModel("skills", null, { availableXp: 1234, credits: 3 });
  assert.equal(f.title, "Select a Skill to Improve");
  assert.deepEqual(f.line1, ["Skill Credits:", "3"]);
  assert.deepEqual(f.line2, ["Unassigned XP:", "1,234"]);
  assert.equal(f.raise1.enabled, false);
  assert.equal(f.raise10.enabled, false);
});

await check("footer untrained: train for credits, +10 hidden, gated on credits", () => {
  const mod = load();
  const rec = { kind: "skill", group: "untrained", name: "Deception", trainedCost: 6 };
  const poor = mod.footerModel("skills", rec, { availableXp: 0, credits: 5 });
  assert.equal(poor.raise1.enabled, false);
  assert.equal(poor.raise10.hidden, true);
  const rich = mod.footerModel("skills", rec, { availableXp: 0, credits: 6 });
  assert.equal(rich.raise1.enabled, true);
  assert.equal(rich.raise1.action, "train");
  assert.deepEqual(rich.line1, ["Credits to Train:", "6"]);
});

await check("footer trained: 'Name: value', +1/+10 gated on unassigned XP", () => {
  const mod = load();
  const rec = { kind: "skill", group: "trained", name: "Magic Defense", current: 150,
    cost1: { cost: 30, ranks: 1 }, cost10: { cost: 600, ranks: 10 } };
  const f = mod.footerModel("skills", rec, { availableXp: 100, credits: 0 });
  assert.equal(f.title, "Magic Defense: 150");
  assert.deepEqual(f.line1, ["XP to Raise:", "30"]);
  assert.equal(f.raise1.enabled, true);
  assert.equal(f.raise10.enabled, false, "600 > 100");
  const maxed = mod.footerModel("skills", { ...rec, cost1: null, cost10: null }, { availableXp: 1e9 });
  assert.deepEqual(maxed.line1, ["XP to Raise:", "Maximum"]);
  assert.equal(maxed.raise1.enabled, false);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
