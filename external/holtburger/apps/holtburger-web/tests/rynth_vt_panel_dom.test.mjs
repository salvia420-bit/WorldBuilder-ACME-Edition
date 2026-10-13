// tests/rynth_vt_panel_dom.test.mjs — the VTank panel DOM (PLAN W1-10 UI,
// §3.16; plugins/rynth-vt/).
//
// Mounts plugins/rynth-vt/panel.js on the small fake DOM
// (tests/helpers/social_fake_dom.mjs) with the REAL bridge
// (rynth/vt/bridge/vt_bridge.js) over a FAKE VT layer on window.__bot (C2: no
// other vt package is imported here) and drives the real handlers:
//   • 9 tabs in two rows; kit classes on every input / select / textarea;
//   • refresh ≤ 2 Hz, only while open AND visible; no list rebuild under a
//     focused input;
//   • Options: Run Macro + Advanced sub-view (every row, inert greyed);
//   • Monsters: columns incl. WC/FC/Cp/DC/Cs and P −1..4;
//   • Route: the VTank buttons, insert mode, green arrow;
//   • Meta: fired rows red, state dropdown, rule editor, windowed list;
//   • meta view windows built/updated/removed by meta_views.js;
//   • Profiles: Nav profile select + Save route, the loot-rule editor;
//   • Buffs: item families per Items entry, No-Buffs greyed;
//   • Escape closes; dispose removes everything.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_panel_dom.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installFakeDom, FakeEvent } from "./helpers/social_fake_dom.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);
globalThis.location = { href: pathToFileURL(path.join(APP, "index.html")).href, search: "" };

const panel = await import("../plugins/rynth-vt/panel.js");
const { createViewRenderer } = await import("../plugins/rynth-vt/meta_views.js");
const { createVtBridge } = await import("../rynth/vt/bridge/vt_bridge.js");
const { META_VIRTUAL_THRESHOLD } = await import("../plugins/rynth-vt/tab_meta.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}
const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const click = (el) => el.dispatchEvent(new FakeEvent("click"));
const change = (el, value) => {
  if (value !== undefined) {
    if (el.type === "checkbox") el.checked = !!value;
    else el.value = String(value);
  }
  el.dispatchEvent(new FakeEvent("change"));
};
const q = (sel, root = document) => root.querySelector(sel);
const qa = (sel, root = document) => root.querySelectorAll(sel);
const byText = (root, sel, text) => qa(sel, root).find((b) => b.textContent === text) || null;
const clone = (v) => JSON.parse(JSON.stringify(v));

// ── fake VT layer (stands in for SET / NAV / META / CMB / SUP / INT-2) ──
const ROWS = [
  { key: "EnableCombat", vt: ["EnableCombat"], type: "bool", dflt: true, page: "options", group: "Subsystems", label: "Enable Combat", consumer: "combat" },
  { key: "MonsterRange", vt: ["AttackDistance"], type: "float", unit: "m", vtUnit: "lbf", dflt: 40, min: 1, max: 200, page: "options", group: "Ranges", label: "Monster Range", consumer: "combat" },
  { key: "EnableNavigation", vt: ["EnableNav"], type: "bool", dflt: false, page: "profiles", group: "Subsystems", label: "Enable Auto-Navigation", consumer: "nav" },
  { key: "EnableLooting", vt: ["EnableLooting"], type: "bool", dflt: true, page: "profiles", group: "Subsystems", label: "Enable Looting", consumer: "loot" },
  { key: "ShowEditor", vt: ["ShowEditor"], type: "bool", dflt: false, page: "profiles", group: "Profiles", label: "Show Editor", consumer: "inert" },
  { key: "HealAt", vt: ["Recharge-Norm-HitP"], type: "int", unit: "pct", dflt: 60, min: 0, max: 100, page: "vitals", group: "Vitals", label: "Heal at", consumer: "vitals" },
  { key: "TopOffHP", vt: ["Recharge-NoTarg-HitP"], type: "int", unit: "pct", dflt: 95, min: 0, max: 100, page: "vitals", group: "Vitals", label: "Top off HP", consumer: "vitals" },
  { key: "EmergencyHP", vt: [], type: "int", unit: "pct", dflt: 30, min: 0, max: 100, page: "vitals", group: "Vitals", label: "Emergency HP", consumer: "vitals" },
  { key: "AttackHeight", vt: ["AttackHeight"], type: "enum", values: [1, 2, 3], dflt: 2, page: "advanced", group: "Combat", label: "Attack height", consumer: "combat" },
  { key: "BuffProfileBanes", vt: ["BuffProfile_Banes"], type: "string", dflt: "", page: "advanced", group: "Not on web", label: "Bane buff profile", consumer: "inert" },
  { key: "DoJiggle", vt: ["DoJiggle"], type: "bool", dflt: false, page: "advanced", group: "Not on web", label: "Jiggle", consumer: "inert" },
];

function makeOptions() {
  const values = new Map(ROWS.map((r) => [r.key, r.dflt]));
  const lists = { monsters: [], items: [], consumables: [], buffs: { spec: null, disabled: [], itemSpells: {} }, legacyPriorities: {} };
  const refs = { navProfile: "loop" };
  const calls = [];
  let act = { name: "Default", kind: "default", writable: false };
  const find = (n) => ROWS.find((r) => r.key.toLowerCase() === String(n).toLowerCase() || r.vt.some((v) => v.toLowerCase() === String(n).toLowerCase()));
  return {
    calls, values, lists, refs,
    profiles: {
      list: () => [{ name: "Default", kind: "default", label: "Default" }, { name: "[By char]", kind: "bychar", label: "[By char]" }, { name: "Hunt", kind: "shared", label: "Hunt" }],
      active: () => ({ ...act }),
      remove: () => ({ ok: true }),
    },
    list: () => ROWS.map((row) => ({ key: row.key, vtName: row.vt[0] ?? row.key, value: values.get(row.key), dflt: row.dflt, inert: row.consumer === "inert", row })),
    get: (n) => (find(n) ? { ok: true, value: values.get(find(n).key), row: find(n), key: find(n).key } : { ok: false, error: "unknown" }),
    set(n, v, o = {}) {
      calls.push(["set", n, v, o.source]);
      const row = find(n);
      if (!row) return { ok: false, error: `unknown option ${n}` };
      values.set(row.key, v);
      return { ok: true, value: v, echo: `[RynthSuite] Set option ${n} = ${v}` };
    },
    getValue: (k) => values.get(k),
    getList: (n) => (n in lists ? clone(lists[n]) : null),
    setList(n, v, o = {}) {
      calls.push(["setList", n, clone(v), o.source]);
      lists[n] = clone(v);
      return { ok: true };
    },
    getRef: (n) => refs[n] ?? null,
    setRef: (n, v) => ((refs[n] = v), { ok: true }),
    selectProfile(name, kind) {
      calls.push(["selectProfile", name, kind]);
      act = { name, kind, writable: kind !== "default" };
      return { ok: true };
    },
    saveAs: (name, o = {}) => (calls.push(["saveAs", name, !!o.mineOnly]), { ok: true }),
    setMineOnly: (on) => (calls.push(["setMineOnly", on]), { ok: true }),
    applyPreset: () => ({ ok: false, error: "Default is read-only — Save As first" }),
    importHud: () => ({ ok: true, imported: [] }),
  };
}

function makeEngine(rules) {
  let cur = { v: 1, name: "hunt", source: { kind: "json" }, rules: clone(rules), navs: {}, warnings: [] };
  const counts = { load: 0, replaceMeta: 0, enterState: [] };
  return {
    counts,
    meta: () => cur,
    load: () => (counts.load++, { ok: true }),
    replaceMeta(m, o) {
      counts.replaceMeta++;
      assert.equal(o.keepState, true);
      cur = clone(m);
      return { ok: true, warnings: [] };
    },
    enabled: true,
    setDebug() {},
    enterState: (s, why) => (counts.enterState.push([s, why]), true),
    snapshot: () => ({
      enabled: true, running: true, name: "hunt", loaded: true, state: "Default", secondsInState: 12, secondsInStateP: 40, stackDepth: 0, stack: [],
      ruleCount: cur.rules.length, stateCount: 2, states: ["Default", "dead"], fired: ["r1"], watchdog: null, lastFired: { ruleId: "r1" }, lastError: null, debug: false,
    }),
  };
}

function makeWorld() {
  const options = makeOptions();
  options.lists.items = [
    { guid: 0x7001, name: "Kite Shield", wcid: 1, kind: "shield", element: null, noBuffs: false },
    { guid: 0x7002, name: "Buckler", wcid: 2, kind: "shield", element: null, noBuffs: true },
    { guid: 0x7003, name: "Wand", wcid: 3, kind: "caster", element: "Fire", noBuffs: false },
  ];
  const navCalls = [];
  const lib = { calls: [] };
  Object.assign(lib, {
    listMetas: () => [{ name: "hunt" }],
    listLoot: () => [{ name: "basic" }],
    lootNodeTypes: () => [{ id: 1, name: "SpellNameMatch", arity: 1 }, { id: 2, name: "StringValueMatch", arity: 2, label: "String Value Match", fields: ["pattern", "key"] }],
    newLoot: () => ({ version: 1, rules: [] }),
    getLoot: () => ({ version: 1, rules: [] }),
    putLoot: (n, p) => (lib.calls.push(["putLoot", n, clone(p)]), { ok: true }),
    loadLoot: (n) => (lib.calls.push(["loadLoot", n]), { ok: true }),
    clearLoot: () => (lib.calls.push(["clearLoot"]), { ok: true }),
  });
  const vt = {
    options,
    session: { options },
    items: {
      list: () => options.getList("items"),
      find: (g) => options.getList("items").find((e) => e.guid === g) || null,
      update: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      add: () => ({ ok: true }),
      resolveGuid: (e) => e.guid,
    },
    consumables: { list: () => [{ guid: 0x6001, name: "Pea", wcid: 9, type: "PeaComponent", keepAtLeast: 5 }], add: () => ({ ok: true }), update: () => ({ ok: true }), remove: () => ({ ok: true }) },
    nav: {
      route: () => ({ name: "loop", routeType: 1, points: [{ type: 0, ew: 10, ns: 20, z: 0 }, { type: 3, pauseMs: 4000, ew: 10, ns: 20, z: 0 }, { type: 4, chat: "/ls", ew: 0, ns: 0, z: 0 }], activeIndex: 1, reversed: false, followTarget: null }),
      status: () => ({ name: "loop", type: 1, typeName: "circular", i: 1, n: 3, exec: "pause 4 s", lastResult: null, reversed: false, enabled: true, paused: null, blockedBy: null }),
      addHere: (t, f, o) => (navCalls.push(["addHere", t, { ...f }, { ...o }]), { ok: true, index: 0 }),
      save: (n) => (navCalls.push(["save", n]), { ok: true }),
      loadByName: (n) => (navCalls.push(["loadByName", n]), { ok: true }),
      setActive: (i) => (navCalls.push(["setActive", i]), { ok: true }),
      step: (d) => (navCalls.push(["step", d]), { ok: true }),
      removeAt: (i) => (navCalls.push(["removeAt", i]), { ok: true }),
      setType: (t) => (navCalls.push(["setType", t]), { ok: true }),
      setEnabled: (on) => (navCalls.push(["setEnabled", on]), { ok: true }),
      resume: () => ({ ok: true }),
      reverse: () => true,
      clear: () => ({ ok: true }),
      updatePoint: (i, p) => (navCalls.push(["updatePoint", i, p]), { ok: true }),
    },
    navProfiles: { list: () => [{ name: "loop" }, { name: "runback" }], remove: () => ({ ok: true }), importText: () => ({ ok: true }), exportText: () => ({ ok: true, text: "" }) },
    meta: makeEngine([
      { id: "r1", state: "Default", enabled: true, cond: { t: "Death" }, act: { t: "SetState", state: "dead" } },
      { id: "r2", state: "Default", enabled: true, cond: { t: "NavEmpty" }, act: { t: "Chat", text: "/vt nav load fighting" } },
      { id: "r3", state: "dead", enabled: true, cond: { t: "Always" }, act: { t: "Chat", text: "/vt nav load runback" } },
    ]),
    library: lib,
    views: { renderer: null, list: () => [], setRenderer(r) { this.renderer = r; }, click: (v, c) => ({ ok: true, v, c }) },
    statusLine: () => "VT: Default · nav 2/3",
    parseExpr: (t) => (/>\s*$/.test(t) ? { ok: false, error: "unexpected end", pos: t.length } : { ok: true, dynamic: /range/.test(t) }),
  };
  const ctl = [];
  const bot = {
    vt,
    host: {
      TryGetObjectName: () => null,
      TryGetKnownSpells: () => [1635],
      TryGetSpellRecord: (id) => ({ id, name: `Spell ${id}`, school: 4 }),
    },
    kernel: { operatorHeld: false },
    combat: { locked: 0 },
    buff: { forceRebuff() {}, cancelForceRebuff() {} },
    control: { stop: (o) => (ctl.push(["stop", o]), { ok: true }), resume: () => (ctl.push(["resume"]), { ok: true }), isStopped: () => false },
  };
  return { bot, vt, options, navCalls, lib, ctl };
}

const W = makeWorld();
window.__bot = W.bot;
const realBridge = createVtBridge({
  win: window,
  importer: async () => ({ buildDynamicBuffList: ({ knownIds }) => knownIds, loadSpellLadders: async () => ({ 1635: [100, 1, 3, 1] }) }),
});
let snaps = 0;
const bridge = new Proxy(realBridge, {
  get(t, k) {
    if (k === "snapshot") return (tab) => (snaps++, t.snapshot(tab));
    return t[k];
  },
});
const timers = [];
let cleared = [];
let hidden = false;
panel.configureVtPanel({
  bridge,
  setInterval: (fn, ms) => (timers.push({ fn, ms, id: timers.length + 1 }), timers.length),
  clearInterval: (id) => cleared.push(id),
  hidden: () => hidden,
});
const root = () => document.getElementById("hb-rynth-vt");
const tabBtn = (id) => q(`.hbk-tab[data-tab='${id}']`, root());
const body = (id) => q(`.rvt-tab-body[data-tab='${id}']`, root());
const openTab = async (id) => {
  click(tabBtn(id));
  await flush();
};

// ── tests ──────────────────────────────────────────────────────────────
await check("opens with 9 tabs in two rows (Options · Profiles · Vitals · Monsters · Items / Consumables · Buffs · Route · Meta)", async () => {
  await panel.openVtPanel({ tab: "options" });
  assert.equal(panel.isVtPanelOpen(), true);
  const r = root();
  assert.ok(r && r.classList.contains("hbk-window"));
  assert.ok(q(".hbk-titlebar", r) && q(".hbk-close", r));
  const rows = qa(".rvt-tabs", r);
  assert.equal(rows.length, 2);
  assert.deepStrictEqual(qa(".hbk-tab", rows[0]).map((b) => b.textContent), ["Options", "Profiles", "Vitals", "Monsters", "Items"]);
  assert.deepStrictEqual(qa(".hbk-tab", rows[1]).map((b) => b.textContent), ["Consumables", "Buffs", "Route", "Meta"]);
  assert.equal(tabBtn("options").getAttribute("aria-selected"), "true");
  assert.equal(r.dataset.open, "1");
  assert.match(q(".rvt-banner", r).textContent, /Default is read-only/);
  assert.equal(q(".rvt-status", r).textContent, "VT: Default · nav 2/3");
});

await check("Options: Run Macro toggles through bot.control; Advanced lists every row, inert greyed", async () => {
  const b = body("options");
  const run = q(".rvt-run", b);
  assert.equal(run.textContent, "RUNNING");
  click(run);
  await flush();
  assert.deepStrictEqual(W.ctl.at(-1), ["stop", { persist: true, reason: "VT panel" }]);
  const mr = q(".rvt-opt[data-key='MonsterRange'] input", b);
  assert.equal(mr.value, "40");
  change(mr, "25");
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["set", "MonsterRange", 25, "ui"]);
  click(byText(b, "button", "Advanced Options…"));
  await flush();
  const adv = q(".rvt-options-advanced", b);
  assert.equal(adv.hidden, false);
  assert.equal(qa(".rvt-opt", adv).length, ROWS.length, "every schema row");
  assert.equal(qa(".rvt-opt.is-inert", adv).length, 3, "inert rows greyed");
  const ah = q(".rvt-opt[data-key='AttackHeight'] select", adv);
  change(ah, "3");
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["set", "AttackHeight", 3, "ui"], "enum value typed");
  assert.equal(JSON.parse(localStorage.getItem("rynth.vt.ui.v1")).sub, "advanced");
  click(byText(b, "button", "◂ Options"));
  await flush();
  assert.equal(q(".rvt-options-main", b).hidden, false);
});

await check("refresh ≤ 2 Hz, only while open AND visible", async () => {
  assert.equal(timers.length >= 1, true);
  const t = timers.at(-1);
  assert.ok(t.ms >= 500, `interval ${t.ms} ms ≤ 2 Hz`);
  snaps = 0;
  t.fn();
  assert.equal(snaps, 1, "open + visible → one snapshot");
  hidden = true;
  t.fn();
  assert.equal(snaps, 1, "hidden page → none");
  hidden = false;
  panel.closeVtPanel();
  assert.ok(cleared.includes(t.id), "timer stopped on close");
  t.fn();
  assert.equal(snaps, 1, "closed → none");
  assert.equal(panel.refreshVtPanel(), false);
  await panel.openVtPanel();
  assert.equal(snaps, 2, "re-open refreshes once");
});

await check("Monsters: columns incl. WC/FC/Cp/DC/Cs, P −1..4, Add / [E] editor with parse errors", async () => {
  await openTab("monsters");
  const b = body("monsters");
  const head = qa("th", b).map((x) => x.textContent);
  for (const c of ["F", "B", "G", "I", "Y", "V", "A", "R", "S", "WC", "FC", "Cp", "DC", "Cs", "P", "Dmg Type", "Ex. Vuln", "Weapon", "Offhand", "PetDmg", "E"]) assert.ok(head.includes(c), `column ${c}`);
  const def = q("tr.rvt-mon-row.is-default", b);
  assert.ok(def, "DEFAULT row");
  assert.deepStrictEqual(qa(".rvt-prio option", def).map((o) => o.value), ["-1", "0", "1", "2", "3", "4"]);
  assert.equal(qa("button", def).filter((x) => ["↑", "↓", "✕", "E"].includes(x.textContent)).every((x) => x.disabled), true, "DEFAULT undeletable/unmovable");
  const add = q(".rvt-mon-add", b);
  add.value = "range>5 && species==drudge";
  click(byText(b, "button", "Add"));
  await flush();
  assert.equal(W.options.lists.monsters.length, 2);
  const row1 = q("tr.rvt-mon-row[data-index='1']", b);
  assert.ok(row1, "new row rendered");
  const wc = q(".rvt-col[data-col='WC']", row1);
  change(wc, true);
  await flush();
  assert.equal(W.options.lists.monsters[1].WC, true);
  const weapon = q(".rvt-weapon", row1);
  assert.deepStrictEqual(qa("option", weapon).map((o) => o.textContent), ["AUTO", "Kite Shield", "Wand"].filter((n) => n !== "Kite Shield"), "weapons = caster/melee/missile items");
  click(qa("button", row1).find((x) => x.textContent === "E"));
  await flush();
  const ed = q(".rvt-expr", b);
  assert.equal(ed.hidden, false);
  const ta = q("textarea", ed);
  ta.value = "range>";
  ta.dispatchEvent(new FakeEvent("input"));
  await flush();
  assert.match(q(".rvt-expr-status", b).textContent, /Parse error at 6: unexpected end/);
  assert.ok(ta.classList.contains("is-error"));
});

await check("no list rebuild under a focused input; rebuild after blur", async () => {
  const b = body("monsters");
  const input = q("tr.rvt-mon-row[data-index='1'] .rvt-mon-text", b);
  input.focus();
  const rowBefore = q("tr.rvt-mon-row[data-index='1']", b);
  W.options.lists.monsters.push({ text: "Blood Shreth", enabled: true, priority: 1, A: true });
  panel.refreshVtPanel();
  assert.equal(q("tr.rvt-mon-row[data-index='1']", b), rowBefore, "same row element while typing");
  assert.equal(q("tr.rvt-mon-row[data-index='2']", b), null, "new data waits");
  input.blur();
  panel.refreshVtPanel();
  assert.ok(q("tr.rvt-mon-row[data-index='2']", b), "rebuilt once the field lost focus");
  assert.notEqual(q("tr.rvt-mon-row[data-index='1']", b), rowBefore);
  // a FORCED refresh (every command ends with one) waits for the field too
  const input2 = q("tr.rvt-mon-row[data-index='2'] .rvt-mon-text", b);
  input2.focus();
  const row2 = q("tr.rvt-mon-row[data-index='2']", b);
  W.options.lists.monsters.push({ text: "Mosswart", enabled: true, priority: 1, A: true });
  panel.refreshVtPanel({ force: true });
  assert.equal(q("tr.rvt-mon-row[data-index='2']", b), row2, "forced, but the player is typing: deferred");
  assert.equal(document.activeElement, input2, "focus kept");
  input2.blur();
  panel.refreshVtPanel();
  assert.ok(q("tr.rvt-mon-row[data-index='3']", b), "the deferred rebuild runs after blur");
  // a refused edit re-renders the stored value once the field is left
  const input3 = q("tr.rvt-mon-row[data-index='1'] .rvt-mon-text", b);
  input3.focus();
  change(input3, "   ");
  await flush();
  assert.equal(input3.value, "   ", "still under the cursor");
  input3.blur();
  panel.refreshVtPanel();
  assert.equal(q("tr.rvt-mon-row[data-index='1'] .rvt-mon-text", b).value, W.options.lists.monsters[1].text, "stored text back");
  W.options.lists.monsters.splice(3);
  panel.refreshVtPanel();
});

await check("Route: VTank buttons, insert mode, green arrow, pause/chat edit", async () => {
  await openTab("route");
  const b = body("route");
  for (const t of ["Add", "Open Vendor", "Add Portal/NPC", "Add NPC Talk", "Add Recall", "Add Pause", "Add Chat", "Add Checkpoint", "Add Jump", "▲", "▼", "Load", "Save", "Export .nav"]) {
    assert.ok(byText(b, "button", t), `button ${t}`);
  }
  assert.deepStrictEqual(qa(".rvt-insert-mode option", b).map((o) => o.textContent), ["Add to End", "Insert Above", "Insert Below"]);
  assert.deepStrictEqual(qa(".rvt-route-type option", b).map((o) => o.textContent), ["Circular", "Linear", "Follow", "Once"]);
  const active = q(".rvt-point.is-active", b);
  assert.equal(active.dataset.index, "1", "green arrow on the current waypoint");
  assert.equal(q(".rvt-arrow", active).textContent, "➜");
  assert.deepStrictEqual(qa(".rvt-recall-select option", b).map((o) => o.value), ["1635"], "known recalls only");
  change(q(".rvt-insert-mode", b), "above");
  await flush();
  click(q(".rvt-point[data-index='2']", b));
  await flush();
  q(".rvt-pause-s", b).value = "7";
  click(byText(b, "button", "Add Pause"));
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["addHere", 3, { seconds: 7 }, { mode: "above", selected: 2 }]);
  click(q(".rvt-point[data-index='0'] .rvt-arrow", b));
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["setActive", 0]);
  click(byText(b, "button", "▼"));
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["step", 1]);
  change(q(".rvt-point[data-index='1'] .rvt-point-pause", b), "9");
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["updatePoint", 1, { pauseMs: 9000 }]);
  assert.match(q(".rvt-status", root()).textContent, /^Nav: 2\/3 circular · pause 4 s/);
});

await check("Meta: fired rows red, state dropdown, rule editor (replaceMeta, never load)", async () => {
  await openTab("meta");
  const b = body("meta");
  const fired = qa(".rvt-rule.is-fired", b);
  assert.deepStrictEqual(fired.map((x) => x.dataset.id), ["r1"], "fired rule shown red");
  assert.deepStrictEqual(qa(".rvt-state-head", b).map((x) => x.dataset.state), ["Default", "dead"]);
  const ss = q(".rvt-state-select", b);
  assert.deepStrictEqual(qa("option", ss).map((o) => o.value), ["Default", "dead"]);
  change(ss, "dead");
  await flush();
  assert.deepStrictEqual(W.vt.meta.counts.enterState.at(-1), ["dead", "manual"]);
  assert.match(q(".rvt-meta-strip", b).textContent, /State: Default · 12s in state/);
  click(byText(b, "button", "Add Rule"));
  await flush();
  const ed = q(".rvt-rule-editor", b);
  assert.equal(ed.hidden, false);
  const condSel = q(".rvt-kw-cond", ed);
  assert.equal(qa("option", condSel).length, 28, "every condition keyword");
  assert.equal(qa("option", q(".rvt-kw-act", ed)).length, 16, "every action keyword");
  change(condSel, "Any");
  await flush();
  click(byText(q(".rvt-editor-cond", b), "button", "+ condition"));
  await flush();
  const childSel = qa(".rvt-kw-cond", b)[1];
  change(childSel, "SecsInStateGE");
  await flush();
  const secs = q(".rvt-editor-cond input[data-field='secs']", b);
  change(secs, "30");
  const actSel = q(".rvt-kw-act", b);
  change(actSel, "CreateView");
  await flush();
  const xml = q(".rvt-editor-act textarea[data-field='xml']", b);
  assert.ok(xml && xml.classList.contains("hbk-input"));
  change(q(".rvt-editor-act input[data-field='view']", b), "panel");
  change(xml, "<view title='x'></view>");
  click(byText(b, "button", "Save rule"));
  await flush();
  const added = W.vt.meta.meta().rules.at(-1);
  assert.equal(added.id, "r4");
  assert.deepStrictEqual(added.cond, { t: "Any", children: [{ t: "SecsInStateGE", secs: 30 }] });
  assert.deepStrictEqual(added.act, { t: "CreateView", view: "panel", xml: "<view title='x'></view>" });
  assert.equal(W.vt.meta.counts.load, 0, "engine.load never");
  assert.ok(W.vt.meta.counts.replaceMeta >= 1);
  click(q(".rvt-rule[data-id='r2'] button", b).parentNode.querySelectorAll("button").find((x) => x.textContent === "✕"));
  await flush();
  assert.equal(W.vt.meta.meta().rules.some((r) => r.id === "r2"), false);
});

await check(`Meta: the rule list is windowed above ${META_VIRTUAL_THRESHOLD} rows`, async () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `r${i + 1}`, state: "Default", enabled: true, cond: { t: "Always" }, act: { t: "None" } }));
  const saved = W.vt.meta;
  W.vt.meta = makeEngine(many);
  panel.refreshVtPanel({ force: true });
  const b = body("meta");
  const n = qa(".rvt-rule", b).length;
  assert.ok(n > 0 && n < 100, `only the visible window is in the DOM (${n})`);
  assert.ok(q(".rvt-virtual-spacer", b));
  W.vt.meta = saved;
  panel.refreshVtPanel({ force: true });
  assert.equal(q(".rvt-virtual-spacer", b), null);
});

await check("meta views: windows built, updated and removed by meta_views.js; panel attaches the renderer", async () => {
  assert.ok(W.vt.views.renderer && typeof W.vt.views.renderer.render === "function", "panel attached a renderer to the ViewManager");
  const clicks = [];
  const r = createViewRenderer({ doc: document, onClick: (v, c) => clicks.push([v, c]) });
  const model = {
    title: "Rings", width: 200, height: 100,
    controls: [
      { type: "button", name: "go", text: "Go", left: 5, top: 5, width: 50, height: 20, actionexpr: "x" },
      { type: "label", name: "lab", text: "Hello <b>", left: 5, top: 30 },
      { type: "checkbox", name: "cb", text: "On", left: 5, top: 50, checked: "true" },
      { type: "textbox", name: "tb", text: "abc", left: 60, top: 50 },
      { type: "unsupported", name: "sl", origType: "slider", left: 5, top: 70 },
    ],
  };
  const h = r.render("ColRings", model);
  const win = q(".rvt-view[data-view='ColRings']");
  assert.ok(win && win.classList.contains("hbk-window"), "window created");
  assert.equal(q(".hbk-title", win).textContent, "Rings");
  assert.equal(q(".rvt-ctl-label", win).textContent, "Hello <b>", "text, never markup");
  assert.ok(q(".rvt-unsupported", win), "unsupported control as a disabled placeholder");
  const cb = q(".rvt-ctl-checkbox input", win);
  assert.equal(cb.checked, true);
  assert.ok(cb.classList.contains("hbk-check"));
  assert.ok(q("input.rvt-ctl-textbox", win).classList.contains("hbk-input"));
  click(q(".rvt-ctl-button", win));
  cb.click();
  assert.deepStrictEqual(clicks, [["ColRings", "go"], ["ColRings", "cb"]]);
  assert.equal(cb.checked, true, "the ViewManager owns checked (reverted until update)");
  r.update(h, { ...model, controls: model.controls.map((c) => (c.name === "go" ? { ...c, visible: false } : c.name === "cb" ? { ...c, checked: false } : c.name === "lab" ? { ...c, text: "Bye" } : c)) });
  assert.equal(q(".rvt-ctl-button", win).hidden, true, "visible:false hides");
  assert.equal(cb.checked, false);
  assert.equal(q(".rvt-ctl-label", win).textContent, "Bye");
  r.destroy(h);
  assert.equal(q(".rvt-view[data-view='ColRings']"), null, "window removed");
});

await check("Profiles: Nav profile select + Save route; loot select; the loot-rule editor", async () => {
  await openTab("profiles");
  const b = body("profiles");
  const navSel = q(".rvt-navprofile-select", b);
  assert.deepStrictEqual(qa("option", navSel).map((o) => o.value), ["", "loop", "runback"]);
  assert.equal(navSel.value, "loop", "current ref selected");
  change(navSel, "runback");
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["loadByName", "runback"]);
  q(".rvt-saveroute-name", b).value = "fighting";
  click(byText(b, "button", "Save route as…"));
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["save", "fighting"]);
  const lootSel = q(".rvt-lootprofile-select", b);
  assert.deepStrictEqual(qa("option", lootSel).map((o) => o.textContent), ["(Value floor)", "basic"]);
  change(lootSel, "basic");
  await flush();
  assert.deepStrictEqual(W.lib.calls.at(-1), ["loadLoot", "basic"]);
  const showEd = qa("input", b).find((i) => i.parentNode && /Show Editor/.test(i.parentNode.textContent));
  assert.equal(showEd.disabled, true, "Show Editor disabled (deprecated)");
  // loot rules: New → Add rule → Add condition (node type from lootNodeTypes) → Save
  click(byText(b, "button", "New"));
  await flush();
  q(".rvt-lootedit-name", b).value = "mine";
  click(byText(b, "button", "Add rule"));
  click(byText(b, "button", "Add condition"));
  await flush();
  const typeSel = q(".rvt-node-type", b);
  assert.deepStrictEqual(qa("option", typeSel).map((o) => o.textContent), ["SpellNameMatch", "StringValueMatch"]);
  change(typeSel, "2");
  await flush();
  const data = qa(".rvt-lootcond input", b);
  assert.equal(data.length, 2, "arity 2 → two data fields");
  assert.deepStrictEqual(data.map((i) => i.placeholder), ["pattern", "key"], "data-line names from the node type");
  change(data[0], "Name");
  change(data[1], "Pyreal");
  const act = qa(".rvt-lootrule select", b).find((s) => qa("option", s).some((o) => o.value === "KeepUpTo"));
  change(act, "KeepUpTo");
  const keep = qa(".rvt-lootrule input", b).find((i) => i.placeholder === "count");
  assert.equal(keep.hidden, false);
  change(keep, "3");
  click(byText(b, "button", "Save rules"));
  await flush();
  const put = W.lib.calls.find((c) => c[0] === "putLoot");
  assert.ok(put, "library.putLoot called");
  assert.equal(put[1], "mine");
  assert.deepStrictEqual(put[2].rules[0].conditions, [{ type: 2, typeName: "StringValueMatch", data: ["Name", "Pyreal"] }]);
  assert.equal(put[2].rules[0].action, "KeepUpTo");
  assert.equal(put[2].rules[0].keepCount, 3);
  // Mine Only while Default is active = the Save As flag (G:54-55), not a scope move
  const mineCb = qa("input.hbk-check", b).find((i) => i.parentNode && /Mine Only/.test(i.parentNode.textContent));
  assert.equal(mineCb.disabled, false, "usable under Default");
  const nCalls = W.options.calls.length;
  change(mineCb, true);
  await flush();
  assert.equal(W.options.calls.slice(nCalls).some((c) => c[0] === "setMineOnly"), false, "Default: no setMineOnly");
  panel.refreshVtPanel();
  assert.equal(mineCb.checked, true, "the flag survives a refresh");
  q(".rvt-saveas-name", b).value = "Solo";
  click(byText(b, "button", "Save As"));
  await flush();
  assert.deepStrictEqual(W.options.calls.find((c) => c[0] === "saveAs"), ["saveAs", "Solo", true], "Save As → a [Char] profile");
  W.options.selectProfile("Default", "default");
  // Enable Auto-Navigation with a live nav = the Route tab's path (setEnabled + resume)
  const navCb = qa("input.hbk-check", b).find((i) => i.parentNode && /Enable Auto-Navigation/.test(i.parentNode.textContent));
  change(navCb, false);
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["setEnabled", false]);
});

await check("Buffs: item families per Items entry, No-Buffs greyed", async () => {
  await openTab("buffs");
  await flush(5);
  panel.refreshVtPanel({ force: true });
  const b = body("buffs");
  const blocks = qa(".rvt-itembuff", b);
  assert.equal(blocks.length, 3);
  const shield = blocks.find((x) => x.dataset.guid === String(0x7001));
  const fams = qa("input[data-family]", shield);
  assert.equal(fams.length, 8, "impen + 7 banes");
  assert.equal(fams.every((i) => i.checked), true, "shield default: all on");
  const buckler = blocks.find((x) => x.dataset.guid === String(0x7002));
  assert.ok(buckler.classList.contains("is-nobuffs"), "No-Buffs greyed");
  assert.equal(qa("input[data-family]", buckler).every((i) => i.disabled && !i.checked), true);
  const wand = blocks.find((x) => x.dataset.guid === String(0x7003));
  assert.equal(qa("input[data-family]", wand).some((i) => i.checked), false, "caster default: none");
  change(qa("input[data-family]", shield).find((i) => i.dataset.family === "bane:fire"), false);
  await flush();
  assert.equal(W.options.lists.buffs.itemSpells[String(0x7001)].includes("bane:fire"), false);
  assert.ok(qa(".rvt-buff-row", b).length >= 1, "self-buff rows from the dynamic list");
});

await check("kit classes on every input / select / textarea of every tab", async () => {
  for (const id of ["options", "profiles", "vitals", "monsters", "items", "consumables", "buffs", "route", "meta"]) await openTab(id);
  click(byText(body("options"), "button", "Advanced Options…"));
  click(byText(body("meta"), "button", "Add Rule"));
  await flush();
  const r = root();
  const inputs = qa("input", r);
  assert.ok(inputs.length > 40, `${inputs.length} inputs`);
  for (const i of inputs) assert.ok(i.classList.contains("hbk-input") || i.classList.contains("hbk-check"), `kit input (${i.className})`);
  const selects = qa("select", r);
  assert.ok(selects.length > 15);
  for (const s of selects) assert.ok(s.classList.contains("hbk-select"), `kit select (${s.className})`);
  for (const t of qa("textarea", r)) assert.ok(t.classList.contains("hbk-input"), `kit textarea (${t.className})`);
  assert.ok(qa("input", r).some((i) => i.type === "file"), "file import uses <input type=file>");
});

await check("Escape: inside a field only blurs; elsewhere closes", async () => {
  await openTab("route");
  const r = root();
  const field = q(".rvt-chat-text", r);
  field.focus();
  const ev = new FakeEvent("keydown", { key: "Escape" });
  field.dispatchEvent(ev);
  assert.equal(r.dataset.open, "1");
  assert.equal(document.activeElement, null, "left the field");
  r.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
  assert.equal(r.dataset.open, "0");
  assert.equal(panel.isVtPanelOpen(), false);
  assert.equal(JSON.parse(localStorage.getItem("rynth.vt.ui.v1")).open, false);
  await panel.toggleVtPanel("meta");
  assert.equal(panel.isVtPanelOpen(), true);
  assert.equal(tabBtn("meta").getAttribute("aria-selected"), "true");
  await panel.toggleVtPanel("meta");
  assert.equal(panel.isVtPanelOpen(), false, "toggle on the same tab closes");
});

await check("dispose removes the window, the stylesheet, the timers and the meta-view renderer", async () => {
  await panel.openVtPanel({ tab: "options" });
  const t = timers.at(-1);
  assert.ok(W.vt.views.renderer, "renderer attached while the panel exists");
  panel.disposeVtPanel();
  assert.equal(root(), null);
  assert.equal(document.getElementById("hb-rynth-vt-style"), null);
  assert.ok(cleared.includes(t.id));
  assert.equal(W.vt.views.renderer, null, "the panel's renderer is detached (its windows need the stylesheet)");
  assert.equal(panel.isVtPanelOpen(), false);
  assert.equal(panel.refreshVtPanel(), false);
  // re-open after dispose rebuilds from scratch, restoring the saved tab
  await panel.openVtPanel();
  assert.ok(root());
  assert.equal(tabBtn("options").getAttribute("aria-selected"), "true");
  assert.ok(W.vt.views.renderer, "re-attached on open");
  panel.disposeVtPanel();
  assert.equal(root(), null);
});

console.log(fail === 0 ? `rynth_vt_panel_dom: all ${pass} checks passed` : `rynth_vt_panel_dom: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
