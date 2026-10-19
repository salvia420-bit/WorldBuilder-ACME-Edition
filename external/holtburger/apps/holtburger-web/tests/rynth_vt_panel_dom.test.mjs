// tests/rynth_vt_panel_dom.test.mjs — the VTank panel DOM (PLAN W1-10 UI,
// §3.16; plugins/rynth-vt/; v2 layout 2026-10-19).
//
// Mounts plugins/rynth-vt/panel.js on the small fake DOM
// (tests/helpers/social_fake_dom.mjs) with the REAL bridge
// (rynth/vt/bridge/vt_bridge.js) over a FAKE VT layer on window.__bot (C2: no
// other vt package is imported here) and drives the real handlers:
//   • one tab row (Main · Monsters · Items · Buffs · Route · Loot · Meta ·
//     Advanced); the command bar (RUN, five switches, profile select, the
//     read-only chip, the profile drawer); the v1 tab names still open;
//   • kit classes on every input / select / textarea;
//   • refresh ≤ 2 Hz, only while open AND visible; no list rebuild under a
//     focused input;
//   • Main: ranges, the vitals matrix with live bars + marks, behaviour rows;
//   • Advanced: only the rows no other tab shows; the filter searches all;
//   • Monsters: columns incl. WC/FC/Cp/DC/Cs and P −1..4, filter-as-you-type,
//     the row governing the target, the [E] editor;
//   • Items: the selection preview and one Add that routes by kind;
//   • Buffs: grouped rows, per-group box, the item-buff matrix;
//   • Route: Add here, the kind picker, insert mode, green arrow, distances;
//   • Loot: the profile select and the rule editor;
//   • Meta: fired rows red, state dropdown, rule editor, windowed list;
//   • meta view windows built/updated/removed by meta_views.js;
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
/** A two-step confirm button: arm, let the double-click guard pass, confirm. */
const confirmClick = (btn) => {
  click(btn);
  const realNow = Date.now;
  Date.now = () => realNow() + 1000;
  try {
    click(btn);
  } finally {
    Date.now = realNow;
  }
};
const clone = (v) => JSON.parse(JSON.stringify(v));

// ── fake VT layer (stands in for SET / NAV / META / CMB / SUP / INT-2) ──
const ROWS = [
  { key: "EnableCombat", vt: ["EnableCombat"], type: "bool", dflt: true, page: "options", group: "Subsystems", label: "Enable Combat", consumer: "combat" },
  { key: "EnableBuffing", vt: ["EnableBuffing"], type: "bool", dflt: true, page: "options", group: "Subsystems", label: "Enable Buffing", consumer: "buff" },
  { key: "MonsterRange", vt: ["AttackDistance"], type: "float", unit: "m", vtUnit: "lbf", dflt: 40, min: 1, max: 200, page: "options", group: "Ranges", label: "Monster Range", consumer: "combat" },
  { key: "BoostLootPriority", vt: ["LootPriorityBoost"], type: "bool", dflt: false, page: "options", group: "Priority", label: "Boost Loot Priority", consumer: "kernel" },
  { key: "PeaceModeWhenIdle", vt: ["IdlePeaceMode"], type: "bool", dflt: false, page: "options", group: "Idle", label: "Peace Mode When Idle", consumer: "idle" },
  { key: "SummonPets", vt: ["SummonPets"], type: "bool", dflt: false, page: "options", group: "Pets", label: "Summon Pets", consumer: "pets" },
  { key: "EnableNavigation", vt: ["EnableNav"], type: "bool", dflt: false, page: "profiles", group: "Subsystems", label: "Enable Auto-Navigation", consumer: "nav" },
  { key: "EnableLooting", vt: ["EnableLooting"], type: "bool", dflt: true, page: "profiles", group: "Subsystems", label: "Enable Looting", consumer: "loot" },
  { key: "ShowEditor", vt: ["ShowEditor"], type: "bool", dflt: false, page: "profiles", group: "Profiles", label: "Show Editor", consumer: "inert" },
  { key: "EnableMeta", vt: ["EnableMeta"], type: "bool", dflt: false, page: "meta", group: "Subsystems", label: "Enable Meta", consumer: "meta" },
  { key: "HealAt", vt: ["Recharge-Norm-HitP"], type: "int", unit: "pct", dflt: 60, min: 0, max: 100, page: "vitals", group: "Vitals", label: "Heal at", consumer: "vitals" },
  { key: "TopOffHP", vt: ["Recharge-NoTarg-HitP"], type: "int", unit: "pct", dflt: 95, min: 0, max: 100, page: "vitals", group: "Vitals", label: "Top off HP", consumer: "vitals" },
  { key: "EmergencyHP", vt: [], type: "int", unit: "pct", dflt: 30, min: 0, max: 100, page: "vitals", group: "Vitals", label: "Emergency HP", consumer: "vitals" },
  { key: "RebuffSecondsRemaining", vt: ["RebufTimeRemainingSeconds"], type: "int", unit: "s", dflt: 300, min: 30, max: 1800, page: "advanced", group: "Buffing", label: "Rebuff when seconds remaining below", consumer: "buff" },
  { key: "LootMinValue", vt: [], type: "int", dflt: 0, min: 0, max: 1e9, page: "advanced", group: "Looting", label: "Loot minimum value", consumer: "loot" },
  ...[35, 85, 135, 185].map((d, i) => ({ key: `BuffMinSkillLevelTier${i + 1}`, vt: [], type: "int", dflt: d, min: 1, max: 500, page: "advanced", group: "Buffing", label: `Min skill for buff tier ${i + 1}`, consumer: "buff" })),
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
      remove: (n, k) => (calls.push(["profiles.remove", n, k]), { ok: true }),
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

function makeEngine(rules, options = null) {
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
    get enabled() {
      return !!options?.getValue("EnableMeta");
    },
    set enabled(v) {
      options?.set("EnableMeta", !!v, { source: "meta" });
    },
    setDebug() {},
    enterState: (s, why) => (counts.enterState.push([s, why]), true),
    snapshot: () => ({
      enabled: true, running: true, name: "hunt", loaded: true, state: "Default", secondsInState: 12, secondsInStateP: 40, stackDepth: 0, stack: [],
      ruleCount: cur.rules.length, stateCount: 2, states: ["Default", "dead"], fired: ["r1"], watchdog: null, lastFired: { ruleId: "r1" }, lastError: null, debug: false,
    }),
  };
}

// The player stands 12 m east of route point 0 (ew 10, ns 20): world
// (26868, 29268) → landblock 0x8B98, local (180, 84); +12 m east.
const POSE = { objCellId: ((139 << 24) | (152 << 16) | 0x0001) >>> 0, x: 192, y: 84, z: 0 };

function makeWorld() {
  const options = makeOptions();
  options.lists.items = [
    { guid: 0x7001, name: "Kite Shield", wcid: 1, kind: "shield", element: null, noBuffs: false },
    { guid: 0x7002, name: "Buckler", wcid: 2, kind: "shield", element: null, noBuffs: true },
    { guid: 0x7003, name: "Wand", wcid: 3, kind: "caster", element: "Fire", noBuffs: false },
  ];
  const navCalls = [];
  const itemCalls = [];
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
  const inventory = [
    { guid: 0x7004, name: "Heavy Axe", wcid: 4, itemType: 1 },
    { guid: 0x7005, name: "Healing Kit", wcid: 5, itemType: 128 },
  ];
  let selectedItem = 0x7004;
  const vt = {
    options,
    session: { options },
    items: {
      list: () => options.getList("items"),
      find: (g) => options.getList("items").find((e) => e.guid === g) || null,
      classify: (row) => (/axe|sword|wand|shield/i.test(row.name) ? "melee" : null),
      update: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      add: (e) => (itemCalls.push(["items.add", clone(e)]), { ok: true, entry: { name: "Heavy Axe", kind: e.kind, noBuffs: !!e.noBuffs } }),
      resolveGuid: (e) => e.guid,
    },
    consumables: {
      list: () => [{ guid: 0x6001, name: "Pea", wcid: 9, type: "PeaComponent", keepAtLeast: 5 }],
      add: (e) => (itemCalls.push(["consumables.add", clone(e)]), { ok: true, entry: { name: "Healing Kit", type: e.type || "HealthKit" } }),
      update: () => ({ ok: true }),
      remove: () => ({ ok: true }),
    },
    monsters: { resolve: (g) => (g === 0x5001 ? { entry: { text: options.lists.monsters[1]?.text ?? "" }, index: options.lists.monsters.length > 1 ? 1 : 0 } : { entry: null, index: 0 }) },
    nav: {
      route: () => ({ name: "loop", routeType: 1, points: [{ type: 0, ew: 10, ns: 20, z: 0 }, { type: 3, pauseMs: 4000, ew: 10, ns: 20, z: 0 }, { type: 4, chat: "/ls", ew: 0, ns: 0, z: 0 }], activeIndex: 1, reversed: false, followTarget: null }),
      status: () => ({ name: "loop", type: 1, typeName: "circular", i: 1, n: 3, exec: "pause 4 s", lastResult: null, reversed: false, enabled: !!options.getValue("EnableNavigation"), paused: null, blockedBy: null, dirty: true }),
      addHere: (t, f, o) => (navCalls.push(["addHere", t, { ...f }, { ...o }]), { ok: true, index: 0 }),
      save: (n) => (navCalls.push(["save", n]), { ok: true }),
      loadByName: (n) => (navCalls.push(["loadByName", n]), { ok: true }),
      setActive: (i) => (navCalls.push(["setActive", i]), { ok: true }),
      step: (d) => (navCalls.push(["step", d]), { ok: true }),
      removeAt: (i) => (navCalls.push(["removeAt", i]), { ok: true }),
      setType: (t) => (navCalls.push(["setType", t]), { ok: true }),
      setEnabled: (on) => (navCalls.push(["setEnabled", on]), options.set("EnableNavigation", on, { source: "ui" })),
      resume: () => (navCalls.push(["resume"]), { ok: true }),
      reverse: () => true,
      clear: () => (navCalls.push(["clear"]), { ok: true }),
      updatePoint: (i, p) => (navCalls.push(["updatePoint", i, p]), { ok: true }),
    },
    navProfiles: { list: () => [{ name: "loop" }, { name: "runback" }], remove: (n) => (navCalls.push(["remove", n]), { ok: true }), importText: () => ({ ok: true }), exportText: () => ({ ok: true, text: "" }) },
    meta: null,
    library: lib,
    views: { renderer: null, list: () => [], setRenderer(r) { this.renderer = r; }, click: (v, c) => ({ ok: true, v, c }) },
    statusLine: () => "VT: Default · nav 2/3",
    parseExpr: (t) => (/>\s*$/.test(t) ? { ok: false, error: "unexpected end", pos: t.length } : { ok: true, dynamic: /range/.test(t) }),
  };
  vt.meta = makeEngine([
    { id: "r1", state: "Default", enabled: true, cond: { t: "Death" }, act: { t: "SetState", state: "dead" } },
    { id: "r2", state: "Default", enabled: true, cond: { t: "NavEmpty" }, act: { t: "Chat", text: "/vt nav load fighting" } },
    { id: "r3", state: "dead", enabled: true, cond: { t: "Always" }, act: { t: "Chat", text: "/vt nav load runback" } },
  ], options);
  const ctl = [];
  const bot = {
    vt,
    host: {
      TryGetObjectName: (g) => (g === 0x7004 ? "Heavy Axe" : g === 0x5001 ? "Drudge Skulker" : null),
      TryGetKnownSpells: () => [1635, 2, 18],
      TryGetSpellRecord: (id) => ({ id, name: `Spell ${id}`, school: 4 }),
      TryGetPlayerPose: () => ({ ...POSE }),
      GetSelectedItemId: () => selectedItem,
      TryGetPlayerInventory: () => inventory,
      TryGetSelfEnchantments: () => [{ spellId: 2, family: 1, remainingS: 200 }],
    },
    kernel: { operatorHeld: false },
    combat: { locked: 0 },
    buff: { forceRebuff() {}, cancelForceRebuff() {} },
    control: { stop: (o) => (ctl.push(["stop", o]), { ok: true }), resume: () => (ctl.push(["resume"]), { ok: true }), isStopped: () => false },
  };
  return { bot, vt, options, navCalls, itemCalls, lib, ctl, setSelectedItem: (g) => { selectedItem = g; } };
}

const W = makeWorld();
window.__bot = W.bot;
// live vitals (SessionHandle.playerStats: stride-4 [type, current, base, max])
window.__sessionHandle = { playerStats: () => ({ vitals: [1, 180, 0, 360, 3, 150, 0, 200, 5, 90, 0, 100], free() {} }) };
const LADDER = { 2: [1, 1, 3, 1], 18: [37, 1, 3, 1], 1635: [100, 1, 3, 1] };
const realBridge = createVtBridge({
  win: window,
  importer: async () => ({
    buildDynamicBuffList: ({ knownIds }) => knownIds.filter((id) => LADDER[id] && id !== 1635),
    loadSpellLadders: async () => LADDER,
    BASE_CREATURE_BUFFS: [["Strength Self", 1], ["Invulnerability Self", 37]],
  }),
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
const sw = (id) => q(`.rvt-tgl[data-switch='${id}']`, root());
const openTab = async (id) => {
  click(tabBtn(id));
  await flush();
};

// ── tests ──────────────────────────────────────────────────────────────
await check("opens with ONE tab row (Main · Monsters · Items · Buffs · Route · Loot · Meta · Advanced) and the command bar", async () => {
  await panel.openVtPanel({ tab: "main" });
  assert.equal(panel.isVtPanelOpen(), true);
  const r = root();
  assert.ok(r && r.classList.contains("hbk-window"));
  assert.ok(q(".hbk-titlebar", r) && q(".hbk-close", r));
  const rows = qa(".rvt-tabs", r);
  assert.equal(rows.length, 1, "one tab row");
  assert.deepStrictEqual(qa(".hbk-tab", rows[0]).map((b) => b.textContent), ["Main", "Monsters", "Items", "Buffs", "Route", "Loot", "Meta", "Advanced"]);
  assert.equal(tabBtn("main").getAttribute("aria-selected"), "true");
  assert.equal(r.dataset.open, "1");
  assert.deepStrictEqual(qa(".rvt-tgl", r).map((b) => b.textContent), ["Combat", "Buff", "Nav", "Loot", "Meta"]);
  assert.equal(sw("combat").getAttribute("aria-pressed"), "true", "EnableCombat default on");
  assert.equal(sw("nav").getAttribute("aria-pressed"), "false");
  assert.equal(q(".rvt-run", r).textContent, "RUNNING");
  assert.equal(q(".rvt-ro", r).hidden, false, "Default: the read-only chip shows");
  assert.equal(q(".rvt-banner", r), null, "no banner row");
  assert.deepStrictEqual(qa(".rvt-profile-select option", r).map((o) => o.value), ["default:Default", "bychar:[By char]", "shared:Hunt"]);
  assert.equal(q(".rvt-status", r).textContent, "VT: Default · nav 2/3");
});

await check("command bar: RUN pauses through bot.control; the switches write their options (NAV / META through their services)", async () => {
  const r = root();
  click(q(".rvt-run", r));
  await flush();
  assert.deepStrictEqual(W.ctl.at(-1), ["stop", { persist: true, reason: "VT panel" }]);
  click(sw("combat"));
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["set", "EnableCombat", false, "ui"]);
  assert.equal(sw("combat").getAttribute("aria-pressed"), "false", "refreshed off");
  click(sw("loot"));
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["set", "EnableLooting", false, "ui"]);
  click(sw("nav"));
  await flush();
  assert.deepStrictEqual(W.navCalls.slice(-2), [["setEnabled", true], ["resume"]], "NAV on = ActiveNav.setEnabled + resume");
  assert.equal(sw("nav").getAttribute("aria-pressed"), "true");
  click(sw("meta"));
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["set", "EnableMeta", true, "meta"], "META through the engine's enabled setter");
});

await check("profile drawer: Mine only under Default is the Save As flag; Save As; select; read-only chip opens the drawer", async () => {
  const r = root();
  const drawer = q(".rvt-drawer", r);
  assert.equal(drawer.hidden, true);
  click(q(".rvt-ro", r));
  await flush();
  assert.equal(drawer.hidden, false, "chip → drawer");
  const mineCb = qa("input.hbk-check", drawer).find((i) => i.parentNode && /Mine only/.test(i.parentNode.textContent));
  const nCalls = W.options.calls.length;
  change(mineCb, true);
  await flush();
  assert.equal(W.options.calls.slice(nCalls).some((c) => c[0] === "setMineOnly"), false, "Default: no setMineOnly");
  panel.refreshVtPanel();
  assert.equal(mineCb.checked, true, "the flag survives a refresh");
  q(".rvt-saveas-name", drawer).value = "Solo";
  click(byText(drawer, "button", "Save As"));
  await flush();
  assert.deepStrictEqual(W.options.calls.find((c) => c[0] === "saveAs"), ["saveAs", "Solo", true], "Save As → a [Char] profile");
  assert.equal(drawer.hidden, true, "drawer closes after Save As");
  change(q(".rvt-profile-select", r), "shared:Hunt");
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["selectProfile", "Hunt", "shared"]);
  assert.equal(q(".rvt-ro", r).hidden, true, "a user profile: no chip");
  // Delete asks twice
  click(q(".rvt-more", r));
  const del = byText(q(".rvt-drawer", r), "button", "Delete");
  click(del);
  assert.equal(W.options.calls.some((c) => c[0] === "profiles.remove"), false, "first click only arms");
  assert.equal(del.textContent, "Delete it?");
  click(del);
  assert.equal(W.options.calls.some((c) => c[0] === "profiles.remove"), false, "a double-click is not a confirmation");
  confirmClick(del);
  await flush();
  assert.deepStrictEqual(W.options.calls.find((c) => c[0] === "profiles.remove"), ["profiles.remove", "Hunt", "shared"]);
  W.options.selectProfile("Default", "default");
  click(q(".rvt-more", r));
  panel.refreshVtPanel({ force: true });
});

await check("Main: ranges, the vitals matrix (live bars + marks), the emergency rule, behaviour rows", async () => {
  const b = body("main");
  const mr = q("input[data-key='MonsterRange']", b);
  assert.equal(mr.value, "40");
  change(mr, "25");
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["set", "MonsterRange", 25, "ui"]);
  const top = q("input[data-key='topOff.hp']", b);
  assert.equal(top.value, "95");
  change(top, "90");
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["set", "TopOffHP", 90, "ui"]);
  assert.equal(q("input[data-key='combat.hp']", b).value, "60");
  assert.equal(q("input[data-key='combat.st']", b).disabled, true, "no RestamAt row in this schema → disabled");
  change(q("input[data-key='EmergencyHP']", b), "25");
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["set", "EmergencyHP", 25, "ui"]);
  const hp = q(".rvt-vbar.is-hp", b);
  assert.equal(q(".rvt-vbar-text", hp).textContent, "50%", "180 / 360");
  assert.equal(q(".rvt-vbar-fill", hp).style.width, "50.0%");
  assert.equal(q(".rvt-vmark.is-idle", hp).style.left, "90%", "top-off mark at 90");
  assert.equal(q(".rvt-vmark.is-combat", hp).style.left, "60%", "combat mark at 60");
  assert.match(hp.title, /180 \/ 360/);
  const beh = qa(".rvt-checks .rvt-opt", b).map((x) => x.dataset.key);
  assert.deepStrictEqual(beh, ["BoostLootPriority", "PeaceModeWhenIdle"], "behaviour rows from the schema");
  change(q(".rvt-checks input[data-key='PeaceModeWhenIdle']", b), true);
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["set", "PeaceModeWhenIdle", true, "ui"]);
  assert.ok(q(".rvt-opt[data-key='PeaceModeWhenIdle']", b).classList.contains("is-changed"), "changed → gold");
  change(q("input[data-key='SummonPets']", b), true);
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["set", "SummonPets", true, "ui"]);
});

await check("Advanced: only the rows no other tab shows; inert folded; the filter searches every row and says where it lives", async () => {
  await openTab("advanced");
  const b = body("advanced");
  const shown = qa(".rvt-adv-groups .rvt-opt", b).map((x) => x.dataset.key);
  assert.deepStrictEqual(shown, ["buffTiers", "AttackHeight"], "MonsterRange / HealAt / RebuffSecondsRemaining / LootMinValue / switches live elsewhere");
  // the tier rows draw as one strip of I … IV fields, each bound to its own row
  const strip = q(".rvt-tierstrip", b);
  assert.deepStrictEqual(qa(".rvt-tiercell .rvt-faint", strip).map((x) => x.textContent), ["I", "II", "III", "IV"]);
  const t3 = q("input[data-key='BuffMinSkillLevelTier3']", strip);
  assert.equal(t3.value, "135");
  change(t3, "150");
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["set", "BuffMinSkillLevelTier3", 150, "ui"]);
  assert.equal(q(".rvt-adv-inert", b).hidden, true, "Not on web folded");
  assert.deepStrictEqual(qa(".rvt-adv-inert .rvt-opt.is-inert", b).map((x) => x.dataset.key), ["BuffProfileBanes", "DoJiggle"]);
  const ah = q(".rvt-opt[data-key='AttackHeight'] select", b);
  change(ah, "3");
  await flush();
  assert.deepStrictEqual(W.options.calls.at(-1), ["set", "AttackHeight", 3, "ui"], "enum value typed");
  const f = q(".rvt-adv-filter", b);
  f.value = "range";
  f.dispatchEvent(new FakeEvent("input"));
  await flush();
  const hit = q(".rvt-opt[data-key='MonsterRange']", b);
  assert.ok(hit, "search finds a Main-tab row");
  assert.equal(q(".rvt-home", hit).textContent, "Main tab");
  f.value = "";
  f.dispatchEvent(new FakeEvent("input"));
  await flush();
  assert.equal(q(".rvt-opt[data-key='MonsterRange']", b), null);
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

await check("Monsters: columns incl. WC/FC/Cp/DC/Cs, P −1..4, Add, filter-as-you-type, the target's row, the [E] editor", async () => {
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
  assert.equal(add.value, "", "field cleared after Add");
  const row1 = q("tr.rvt-mon-row[data-index='1']", b);
  assert.ok(row1, "new row rendered");
  const wc = q(".rvt-col[data-col='WC']", row1);
  change(wc, true);
  await flush();
  assert.equal(W.options.lists.monsters[1].WC, true);
  const weapon = q(".rvt-weapon", row1);
  assert.deepStrictEqual(qa("option", weapon).map((o) => o.textContent), ["AUTO", "Wand"], "weapons = caster/melee/missile items");
  // filter-as-you-type
  add.value = "mosswart";
  add.dispatchEvent(new FakeEvent("input"));
  assert.equal(q("tr.rvt-mon-row[data-index='1']", b).hidden, true, "a non-matching row hides");
  assert.equal(q("tr.rvt-mon-row.is-default", b).hidden, false, "DEFAULT always shows");
  assert.equal(q(".rvt-mon-filtered", b).hidden, false);
  add.value = "";
  add.dispatchEvent(new FakeEvent("input"));
  assert.equal(q("tr.rvt-mon-row[data-index='1']", b).hidden, false);
  // the row governing the locked target
  W.bot.combat.locked = 0x5001;
  panel.refreshVtPanel();
  assert.ok(q("tr.rvt-mon-row[data-index='1']", b).classList.contains("is-target"), "row 1 governs the target");
  assert.match(q("tr.rvt-mon-row[data-index='1'] td.rvt-name", b).title, /current target \(Drudge Skulker\)/);
  W.bot.combat.locked = 0;
  panel.refreshVtPanel();
  assert.equal(qa("tr.is-target", b).length, 0);
  click(qa("button", q("tr.rvt-mon-row[data-index='1']", b)).find((x) => x.textContent === "E"));
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

await check("Items: the selection preview; one Add routes by kind (Auto → combat item / consumable; explicit type); both lists", async () => {
  await openTab("items");
  const b = body("items");
  assert.equal(q(".rvt-selname", b).textContent, "Heavy Axe");
  assert.match(q(".rvt-selname", b).title, /combat item: Melee weapon/);
  click(byText(b, "button", "Add"));
  await flush();
  assert.deepStrictEqual(W.itemCalls.at(-1), ["items.add", { guid: 0x7004, kind: "melee", noBuffs: false }], "Auto: a weapon → the Items list");
  W.setSelectedItem(0x7005);
  panel.refreshVtPanel({ force: true });
  assert.equal(q(".rvt-selname", b).textContent, "Healing Kit");
  click(byText(b, "button", "Add"));
  await flush();
  assert.deepStrictEqual(W.itemCalls.at(-1), ["consumables.add", { guid: 0x7005 }], "Auto: anything else → the Consumables list (type detected there)");
  change(q(".rvt-add-as", b), "HealthKit");
  assert.equal(qa("input.hbk-check", q(".rvt-addbar", b))[0].disabled, true, "No Buffs is for combat items only");
  click(byText(b, "button", "Add"));
  await flush();
  assert.deepStrictEqual(W.itemCalls.at(-1), ["consumables.add", { guid: 0x7005, type: "HealthKit" }]);
  assert.equal(q(".rvt-add-as", b).value, "auto", "a successful add resets Add as");
  change(q(".rvt-add-as", b), "shield");
  const nb = qa("input.hbk-check", q(".rvt-addbar", b))[0];
  assert.equal(nb.disabled, false);
  change(nb, true);
  const before = W.itemCalls.length;
  click(byText(b, "button", "Add"));
  await flush();
  assert.equal(W.itemCalls.length, before, "a healing kit is never added as a shield");
  assert.match(q(".rvt-msg", root()).textContent, /Healing Kit is not a weapon, shield/);
  W.setSelectedItem(0x7004);
  panel.refreshVtPanel({ force: true });
  click(byText(b, "button", "Add"));
  await flush();
  assert.deepStrictEqual(W.itemCalls.at(-1), ["items.add", { guid: 0x7004, kind: "shield", noBuffs: true }], "explicit kind + No Buffs");
  assert.equal(nb.checked, false, "No Buffs resets after the add");
  // by name: No Buffs works without a selection; an empty name is refused
  W.setSelectedItem(0);
  panel.refreshVtPanel({ force: true });
  assert.equal(byText(b, "button", "Add").disabled, true, "nothing selected: Add is off");
  assert.equal(nb.disabled, false, "…but No Buffs still applies to Add by name");
  const n0 = W.itemCalls.length;
  click(byText(b, "button", "Add by name"));
  await flush();
  assert.equal(W.itemCalls.length, n0, "an empty name adds nothing");
  assert.match(q(".rvt-msg", root()).textContent, /type the item's name/);
  W.setSelectedItem(0x7004);
  assert.equal(qa(".rvt-item-row", b).length, 3, "combat items");
  assert.ok(q(".rvt-item-row[data-guid='" + 0x7002 + "']", b).classList.contains("is-nobuffs"));
  assert.equal(qa(".rvt-cons-row", b).length, 1, "consumables");
  assert.equal(q(".rvt-cons-keep", b).value, "5", "pea keep-at-least");
});

await check("Buffs: grouped rows with tier + time, the per-group box, the item-buff matrix (No-Buffs greyed)", async () => {
  await openTab("buffs");
  await flush(5);
  panel.refreshVtPanel({ force: true });
  const b = body("buffs");
  assert.deepStrictEqual(qa(".rvt-bgroup-head", b).map((h) => h.dataset.group), ["Attributes", "Defenses"]);
  const str = q(".rvt-buff-row[data-spell='2']", b);
  assert.equal(q(".rvt-grow", str).textContent, "Strength");
  assert.equal(q(".rvt-tier", str).textContent, "I");
  assert.equal(str.dataset.state, "low", "200 s left < the 300 s rebuff threshold");
  assert.equal(q(".rvt-buff-rem", str).textContent, "3m 20s");
  assert.equal(q(".rvt-buff-row[data-spell='18']", b).dataset.state, "missing");
  // a group folds (and stays folded across a rebuild: a per-viewer pref)
  const head = q(".rvt-bgroup-head[data-group='Defenses']", b);
  click(head);
  const gridOf = (h) => h.parentNode.childNodes[h.parentNode.childNodes.indexOf(h) + 1];
  assert.equal(gridOf(head).hidden, true, "folded");
  assert.equal(q(".rvt-fold", head).textContent, "▸");
  panel.refreshVtPanel({ force: true });
  const head2 = q(".rvt-bgroup-head[data-group='Defenses']", b);
  assert.equal(gridOf(head2).hidden, true, "still folded after a rebuild");
  click(head2);
  assert.equal(gridOf(head2).hidden, false, "unfolded");
  assert.match(q(".rvt-bgroup-head[data-group='Defenses'] .rvt-sec-meta", b).textContent, /^1\/1 · 1 due$/, "on/total · due");
  const all = q(".rvt-bgroup-head[data-group='Attributes'] .rvt-bgroup-all", b);
  change(all, false);
  await flush(5);
  assert.deepStrictEqual(W.options.lists.buffs.disabled, [2], "group off → one write");
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
  assert.equal(q("input[data-key='RebuffSecondsRemaining']", b).value, "300", "the rebuff knob");
  assert.ok(byText(b, "button", "Force Buff"));
});

await check("Route: Add here, the kind picker, insert mode, green arrow, distances, pause edit", async () => {
  await openTab("route");
  const b = body("route");
  assert.deepStrictEqual(qa(".rvt-route-type .rvt-seg-btn", b).map((o) => o.textContent), ["Circular", "Linear", "Once", "Follow"]);
  assert.ok(q(".rvt-route-type .rvt-seg-btn[data-value='1']", b).classList.contains("is-on"));
  assert.deepStrictEqual(qa(".rvt-insert-mode option", b).map((o) => o.value), ["end", "above", "below"]);
  const active = q(".rvt-point.is-active", b);
  assert.equal(active.dataset.index, "1", "green arrow on the current waypoint");
  assert.equal(q(".rvt-arrow", active).textContent, "➜");
  assert.equal(q(".rvt-point[data-index='0'] .rvt-dist", b).textContent, "12 m", "you stand 12 m from waypoint 1");
  assert.equal(q(".rvt-point[data-index='2'] .rvt-dist", b).textContent, "", "chat points have no position");
  assert.equal(q(".rvt-dirty", b).hidden, false, "unsaved route");
  click(byText(b, "button", "Add here"));
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["addHere", 0, {}, { mode: "end", selected: null }]);
  change(q(".rvt-insert-mode", b), "above");
  await flush();
  click(q(".rvt-point[data-index='2']", b));
  await flush();
  change(q(".rvt-add-kind", b), "3");
  const addKind = qa("button", q(".rvt-route-add", b)).at(-1);
  assert.equal(addKind.textContent, "Add Pause");
  q(".rvt-pause-s", b).value = "7";
  click(addKind);
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["addHere", 3, { seconds: 7 }, { mode: "above", selected: 2 }]);
  change(q(".rvt-add-kind", b), "2");
  assert.equal(addKind.textContent, "Add Recall");
  assert.deepStrictEqual(qa(".rvt-recall-select option", b).map((o) => o.value), ["1635"], "known recalls only");
  click(q(".rvt-point[data-index='0'] .rvt-arrow", b));
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["setActive", 0]);
  click(byText(b, "button", "▼"));
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["step", 1]);
  change(q(".rvt-point[data-index='1'] .rvt-point-pause", b), "9");
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["updatePoint", 1, { pauseMs: 9000 }]);
  click(q(".rvt-route-type .rvt-seg-btn[data-value='2']", b));
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["setType", 2]);
  const clear = byText(b, "button", "Clear");
  click(clear);
  assert.notDeepEqual(W.navCalls.at(-1), ["clear"], "Clear asks twice");
  confirmClick(clear);
  await flush();
  assert.deepStrictEqual(W.navCalls.at(-1), ["clear"]);
  assert.match(q(".rvt-status", root()).textContent, /^Nav: 2\/3 circular · pause 4 s/);
});

await check("Route: the path is drawn in the world on the Route tab, hidden elsewhere, kept with Show path pinned", async () => {
  await openTab("route");
  for (let i = 0; i < 20 && !window.__rynthRouteOverlay; i++) await flush();
  const ov = window.__rynthRouteOverlay;
  assert.ok(ov && typeof ov.setVisible === "function", "scene3d/route_overlay.js installed on the Route tab");
  assert.equal(ov.status().visible, true, "visible on the Route tab");
  assert.equal(ov.status().sceneReady, false, "no 3D scene in this page: it waits, nothing attached");
  await openTab("main");
  assert.equal(ov.status().visible, false, "hidden off the Route tab");
  await openTab("route");
  const pin = qa("input.hbk-check", body("route")).find((i) => i.parentNode && /Show path/.test(i.parentNode.textContent));
  change(pin, true);
  await openTab("main");
  assert.equal(ov.status().visible, true, "pinned: drawn from any tab");
  panel.closeVtPanel();
  assert.equal(ov.status().visible, true, "pinned: drawn with the panel closed");
  assert.equal(JSON.parse(localStorage.getItem("rynth.vt.ui.v1")).routeShowPath, true, "a per-viewer pref");
  await panel.openVtPanel({ tab: "route" });
  change(pin, false);
  await openTab("main");
  assert.equal(ov.status().visible, false, "unpinned and off the tab: hidden");
});

await check("Loot: the profile select loads; the rule editor (New → rule → condition → Save)", async () => {
  await openTab("loot");
  const b = body("loot");
  const lootSel = q(".rvt-lootprofile-select", b);
  assert.deepStrictEqual(qa("option", lootSel).map((o) => o.textContent), ["(Value floor)", "basic"]);
  change(lootSel, "basic");
  await flush();
  assert.deepStrictEqual(W.lib.calls.at(-1), ["loadLoot", "basic"]);
  assert.equal(q("input[data-key='LootMinValue']", b).value, "0", "the Value floor knob");
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
  assert.equal(qa("input", b).some((i) => i.parentNode && /Enable Meta/.test(i.parentNode.textContent)), false, "Enable Meta lives on the command bar");
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
  click(qa("button", q(".rvt-rule[data-id='r2']", b)).find((x) => x.textContent === "✕"));
  await flush();
  assert.equal(W.vt.meta.meta().rules.some((r) => r.id === "r2"), false);
});

await check(`Meta: the rule list is windowed above ${META_VIRTUAL_THRESHOLD} rows`, async () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `r${i + 1}`, state: "Default", enabled: true, cond: { t: "Always" }, act: { t: "None" } }));
  const saved = W.vt.meta;
  W.vt.meta = makeEngine(many, W.options);
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

await check("the v1 tab names still open the right tab (/rs ui vitals | consumables | profiles | options)", async () => {
  for (const [old, now] of [["vitals", "main"], ["consumables", "items"], ["profiles", "main"], ["options", "main"], ["nav", "route"], ["advanced", "advanced"]]) {
    await panel.openVtPanel({ tab: old });
    assert.equal(tabBtn(now).getAttribute("aria-selected"), "true", `${old} → ${now}`);
  }
});

await check("kit classes on every input / select / textarea of every tab", async () => {
  for (const id of ["main", "monsters", "items", "buffs", "route", "loot", "meta", "advanced"]) await openTab(id);
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
  change(q(".rvt-add-kind", r), "4");
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
  await panel.openVtPanel({ tab: "main" });
  const t = timers.at(-1);
  assert.ok(W.vt.views.renderer, "renderer attached while the panel exists");
  panel.disposeVtPanel();
  assert.equal(root(), null);
  assert.equal(document.getElementById("hb-rynth-vt-style"), null);
  assert.ok(cleared.includes(t.id));
  assert.equal(W.vt.views.renderer, null, "the panel's renderer is detached (its windows need the stylesheet)");
  assert.equal(window.__rynthRouteOverlay, undefined, "the route overlay went with the panel");
  assert.equal(panel.isVtPanelOpen(), false);
  assert.equal(panel.refreshVtPanel(), false);
  // re-open after dispose rebuilds from scratch, restoring the saved tab
  await panel.openVtPanel();
  assert.ok(root());
  assert.equal(tabBtn("main").getAttribute("aria-selected"), "true");
  assert.ok(W.vt.views.renderer, "re-attached on open");
  panel.disposeVtPanel();
  assert.equal(root(), null);
});

console.log(fail === 0 ? `rynth_vt_panel_dom: all ${pass} checks passed` : `rynth_vt_panel_dom: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
