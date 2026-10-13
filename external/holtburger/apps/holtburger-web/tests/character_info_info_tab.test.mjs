// tests/character_info_info_tab.test.mjs — examine-text-8 (2026-10-13).
//
// The character pane's fourth "Info" tab shows retail gmCharacterInfoUI's
// text (plugins/character_info_report.js) in place of the StatManagement
// template. This suite mounts the real plugin (fake DOM, spliced like
// tests/character_info_tab_labels.test.mjs) and pins:
//   1. the strip keeps its three data-tab stat tabs and adds one Info button
//      (data-pane="info"), labelled "Info";
//   2. clicking Info retitles the panel "Character Information", selects only
//      that button, and switches the root to data-pane="info"; a stat tab
//      switches it back;
//   3. the pane's text is the report built from the LOCAL player's ints
//      (objectIntProperty(playerGuid, id)) and the stats stride — raw
//      attributes for the tiers, attributeXp `start` for the innate values,
//      base − ranks without that stride;
//   4. F1 (no ctx) reopens Info; ctx.tab "info" names the panel.
//
// Run: node tests/character_info_info_tab.test.mjs   (from apps/holtburger-web/)

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

// Local player 0x50000001: three deaths, two Strength augs, a 7-point
// Damage Rating aura, 22500 burden (Str 100 → capacity 15000 → load 1.5).
const PLAYER = 0x50000001;
const INTS = { 43: 3, 218: 2, 333: 7, 5: 22500 };
const intReads = [];
const handle = {
  playerGuid: () => PLAYER,
  objectIntProperty: (guid, id) => {
    intReads.push([guid >>> 0, id]);
    return guid >>> 0 === PLAYER && id in INTS ? INTS[id] : undefined;
  },
  objectDescFlags: () => 0,
};
// attributes [type, current, base, ranks]; attributeXp [type, ranks, start, spent, next].
const STATS = {
  name: "Tester",
  attributes: [1, 100, 100, 10, 2, 245, 245, 0, 3, 50, 50, 0, 4, 60, 60, 0, 5, 70, 70, 0, 6, 80, 80, 0],
  vitals: [],
  skills: [],
  levelInfo: [1, 0, 0, 0, 0, 0, 0],
  attributeXp: [1, 10, 90, 0, 0, 2, 0, 245, 0, 0, 3, 0, 50, 0, 0, 4, 0, 60, 0, 0, 5, 0, 70, 0, 0, 6, 0, 80, 0, 0],
};
const titleCalls = [];
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  location: { search: "" },
  __pluginClient: { events: { on() {}, off() {} }, player: { stats: STATS, skillCredits: 0 } },
  __sessionHandle: handle,
  __mainPanel: { setTitle: (t) => { titleCalls.push(t); return true; } },
};
globalThis.performance = { now: () => 0 };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.fetch = () => Promise.resolve({ ok: false, json: async () => null });

/* ── load the plugin with the REAL pure helpers ───────────────────────── */

const TS = await import(pathToFileURL(path.join(APP, "plugins", "train-skills.js")).href);
globalThis.__TS = TS;
globalThis.__EF = await import(pathToFileURL(path.join(APP, "plugins", "examine_format.js")).href);
const REPORT_URL = pathToFileURL(path.join(APP, "plugins", "character_info_report.js")).href;
const REPORT = await import(REPORT_URL);

const rawSrc = readFileSync(path.join(APP, "plugins", "character-info.js"), "utf8");
// The plugin lazy-loads the builder with a module-relative import(); inside
// new Function() that must be absolute.
assert.ok(rawSrc.includes('import("./character_info_report.js")'), "plugin lazy-imports the report builder");
const src = rawSrc.replace('import("./character_info_report.js")', `import(${JSON.stringify(REPORT_URL)})`);
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
  return new Function(body + "\nreturn { view, __test };\n")();
}

function walk(n, pred, out = []) {
  for (const c of n.children ?? []) {
    if (pred(c)) out.push(c);
    walk(c, pred, out);
  }
  return out;
}
const statTabs = (p) => walk(p, (c) => !!c.dataset?.tab);
const infoBtn = (p) => walk(p, (c) => c.dataset?.pane === "info" && String(c.className).includes("hbk-tab"))[0];
const infoPane = (p) => walk(p, (c) => String(c.className).includes("hb-ci-info"))[0];
const rootOf = (p) => p.children[0];

async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

const cleanups = [];
function mount(ctx) {
  const mod = load();
  const parent = makeEl("div");
  cleanups.push(mod.view.mount(parent, ctx));
  return { mod, parent };
}

/* ── 1. the strip ─────────────────────────────────────────────────────── */

await check("three data-tab stat tabs plus one Info pane button", () => {
  const { parent } = mount({ tab: "attributes" });
  assert.deepEqual(statTabs(parent).map((b) => b.textContent), ["Attributes", "Skills", "Titles"]);
  const info = infoBtn(parent);
  assert.ok(info, "an Info button");
  assert.equal(info.textContent, "Info");
  assert.equal(info.dataset.tab, undefined, "the Info button is not a StatManagement tab");
  assert.equal(rootOf(parent).dataset.pane, "stats");
});

/* ── 2. switching ─────────────────────────────────────────────────────── */

await check("clicking Info retitles the panel and swaps the body; a stat tab swaps it back", () => {
  const { parent } = mount({ tab: "skills" });
  titleCalls.length = 0;
  infoBtn(parent)._h.click();
  assert.equal(titleCalls.at(-1), "Character Information");
  assert.equal(rootOf(parent).dataset.pane, "info");
  assert.equal(infoBtn(parent).getAttribute("aria-selected"), "true");
  for (const b of statTabs(parent)) assert.equal(b.getAttribute("aria-selected"), "false");
  statTabs(parent)[0]._h.click();
  assert.equal(rootOf(parent).dataset.pane, "stats");
  assert.equal(infoBtn(parent).getAttribute("aria-selected"), "false");
  assert.equal(titleCalls.at(-1), "Attributes");
});

/* ── 3. the text ──────────────────────────────────────────────────────── */

await check("the Info text is the report from the local player's ints and the stats stride", async () => {
  intReads.length = 0;
  const { parent } = mount({ tab: "info" });
  const pane = infoPane(parent);
  assert.ok(pane, "an info pane");
  assert.ok(await until(() => pane.textContent.includes("Natural Resistances")), `text: ${pane.textContent}`);
  const t = pane.textContent;
  assert.match(t, /You have died 3 times\./);
  // Raw Str 100 + End 245 = 345 → Hardy; 100 + 490 = 590 → Resilient.
  assert.match(t, /Natural Resistances: Hardy\nDrain Resistances: Hardy\nRegeneration Bonus: Resilient/);
  // Innate Strength is attributeXp start (90), not base 100.
  assert.match(t, /Innate Strength: 90\nInnate Endurance: 245\nInnate Coordination: 60\nInnate Quickness: 50/);
  assert.match(t, /You have augmented your Innate Strength 2 times\./);
  assert.match(t, /increased by 5\.\n\nAura of Destruction\. Your Seer grants you an increase to Damage Rating of 2\./);
  assert.match(t, /overburdened by 7500 burden units\..* by 50%\.$/);
  assert.equal(t, REPORT.characterInfoText({
    int: (id) => INTS[id], rawAttr: (id) => ({ 1: 100, 2: 245, 3: 50, 4: 60, 5: 70, 6: 80 })[id],
    innateAttr: (id) => ({ 1: 90, 2: 245, 3: 50, 4: 60, 5: 70, 6: 80 })[id],
    attr: (id) => ({ 1: 100, 2: 245 })[id],
  }));
  assert.ok(intReads.length > 0 && intReads.every(([g]) => g === PLAYER), "reads the local player's ints");
});

await check("innate falls back to base − ranks on a pkg without attributeXp", () => {
  const mod = load();
  const s = mod.__test.infoSource({ ...STATS, attributeXp: [] });
  assert.equal(s.innateAttr(1), 90);
  assert.equal(s.rawAttr(1), 100);
  assert.equal(s.attr(2), 245);
  assert.equal(s.innateAttr(9), null);
});

await check("no session handle → ints read as absent, the report still renders", () => {
  const mod = load();
  const saved = window.__sessionHandle;
  window.__sessionHandle = null;
  try {
    const s = mod.__test.infoSource(STATS);
    assert.equal(s.int(43), null);
    assert.match(REPORT.characterInfoText(s), /^You have never died!/);
  } finally {
    window.__sessionHandle = saved;
  }
});

/* ── 4. naming / F1 ───────────────────────────────────────────────────── */

await check("ctx.tab 'info' names the panel; F1 (no ctx) reopens Info", () => {
  const mod = load();
  assert.equal(mod.view.nameFor({ tab: "info" }), "Character Information");
  const a = makeEl("div");
  cleanups.push(mod.view.mount(a, { tab: "attributes" }));
  infoBtn(a)._h.click();
  assert.equal(mod.view.nameFor({}), "Character Information");
  const b = makeEl("div");
  cleanups.push(mod.view.mount(b, {}));
  assert.equal(rootOf(b).dataset.pane, "info");
});

for (const c of cleanups) { try { c?.(); } catch (_) {} }
console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
