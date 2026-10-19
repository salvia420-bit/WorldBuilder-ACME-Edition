// tests/rynth_vt_bridge.test.mjs — rynth/vt/bridge/ (PLAN W1-10 UI, §3.16).
//
// The VTank panel's one adapter to the VT layer. Drives snapshot(tab) and
// every command namespace against FAKE layer services (C2: no other vt
// package is imported here — the fakes stand in for SET/NAV/META/CMB/SUP and
// the INT-2 library):
//   • never throws on a broken bot surface; commands always resolve {ok,…};
//   • opt/profiles work with no bot (win.__rynthVt.session());
//   • run.* delegates to the HUD bridge, else bot.control;
//   • items.addSelected: GetSelectedItemId → world selection → clean failure;
//   • consumables.addSelected("BuffItem"): appraise first, refuse < 300 s
//     (and < RebuffSecondsRemaining), pass spellIds/durationS on success;
//   • snapshot reads bot.vt exactly once per call, for every tab;
//   • meta rule edits go through engine.replaceMeta(clone, {keepState}) and
//     never engine.load; ids "r<n>"; move stays within a state;
//   • loot.* and meta import/export go through bot.vt.library;
//   • buffs.setItemSpell / resetItemSpells write lists.buffs.itemSpells
//     (defaults from the item kind; No-Buffs refused); setEnabled/setAuto
//     project the enabled set as lists.buffs.spec (real buff_loop ladder too);
//   • navProfiles.saveAs → nav.save; route.add honours insert mode + selection;
//   • Monsters: DEFAULT pinned, add/update/move/remove, HUD + RynthAi import.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_bridge.test.mjs

import assert from "node:assert/strict";

const bridgeMod = await import("../rynth/vt/bridge/vt_bridge.js");
const lists = await import("../rynth/vt/bridge/bridge_lists.js");
const rm = await import("../rynth/vt/bridge/bridge_route_meta.js");
const { createVtBridge, normalizeTab, VT_TABS } = bridgeMod;

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
// v2 tabs + the v1 names `/rs ui` still accepts
const ALL_TABS = [...VT_TABS, "options", "vitals", "profiles", "consumables"];
const clone = (v) => JSON.parse(JSON.stringify(v));

// ── fakes ──────────────────────────────────────────────────────────────
const ROWS = [
  { key: "EnableCombat", vt: ["EnableCombat"], type: "bool", dflt: true, page: "options", group: "Subsystems", label: "Enable Combat", consumer: "combat" },
  { key: "MonsterRange", vt: ["AttackDistance"], type: "float", unit: "m", vtUnit: "lbf", dflt: 40, min: 1, max: 200, page: "options", group: "Ranges", label: "Monster Range", consumer: "combat" },
  { key: "EnableNavigation", vt: ["EnableNav"], type: "bool", dflt: false, page: "profiles", group: "Subsystems", label: "Enable Auto-Navigation", consumer: "nav" },
  { key: "EnableLooting", vt: ["EnableLooting"], type: "bool", dflt: true, page: "profiles", group: "Subsystems", label: "Enable Looting", consumer: "loot" },
  { key: "ShowEditor", vt: ["ShowEditor"], type: "bool", dflt: false, page: "profiles", group: "Profiles", label: "Show Editor", consumer: "inert" },
  { key: "EnableMeta", vt: ["EnableMeta"], type: "bool", dflt: false, page: "meta", group: "Subsystems", label: "Enable Meta", consumer: "meta" },
  { key: "HealAt", vt: ["Recharge-Norm-HitP"], type: "int", unit: "pct", dflt: 60, min: 0, max: 100, page: "vitals", group: "Vitals", label: "Heal at", consumer: "vitals" },
  { key: "TopOffHP", vt: ["Recharge-NoTarg-HitP"], type: "int", unit: "pct", dflt: 95, min: 0, max: 100, page: "vitals", group: "Vitals", label: "Top off HP", consumer: "vitals" },
  { key: "EmergencyHP", vt: [], type: "int", unit: "pct", dflt: 30, min: 0, max: 100, page: "vitals", group: "Vitals", label: "Emergency HP", consumer: "vitals" },
  { key: "RebuffSecondsRemaining", vt: ["RebufTimeRemainingSeconds"], type: "int", unit: "s", dflt: 300, min: 30, max: 1800, page: "advanced", group: "Buffing", label: "Rebuff below", consumer: "buff" },
  { key: "AttackHeight", vt: ["AttackHeight"], type: "enum", values: [1, 2, 3], dflt: 2, page: "advanced", group: "Combat", label: "Attack height", consumer: "combat" },
  { key: "DoJiggle", vt: ["DoJiggle"], type: "bool", dflt: false, page: "advanced", group: "Not on web", label: "Jiggle", consumer: "inert" },
];

function makeOptions({ active = { name: "Default", kind: "default" } } = {}) {
  const values = new Map(ROWS.map((r) => [r.key, r.dflt]));
  const lsts = { monsters: [], items: [], consumables: [], buffs: { spec: null, disabled: [], itemSpells: {} }, legacyPriorities: {} };
  const refs = {};
  const calls = [];
  let act = { ...active, writable: active.kind !== "default" };
  const profiles = [
    { name: "Default", kind: "default", label: "Default" },
    { name: "[By char]", kind: "bychar", label: "[By char]" },
    { name: "Hunt", kind: "shared", label: "Hunt" },
  ];
  const find = (name) => {
    const n = String(name).toLowerCase();
    return ROWS.find((r) => r.key.toLowerCase() === n || r.vt.some((v) => v.toLowerCase() === n)) || null;
  };
  return {
    calls,
    values,
    lists: lsts,
    refs,
    profiles: {
      list: () => profiles.slice(),
      active: () => ({ ...act }),
      remove: (n, k) => {
        calls.push(["profiles.remove", n, k]);
        return { ok: true };
      },
    },
    list() {
      return ROWS.map((row) => ({ key: row.key, vtName: row.vt[0] ?? row.key, value: values.get(row.key), dflt: row.dflt, inert: row.consumer === "inert", row }));
    },
    get(name) {
      const row = find(name);
      return row ? { ok: true, value: values.get(row.key), row, key: row.key } : { ok: false, error: `unknown option ${name}` };
    },
    set(name, v, { source } = {}) {
      calls.push(["set", name, v, source]);
      const row = find(name);
      if (!row) return { ok: false, error: `unknown option ${name}` };
      values.set(row.key, v);
      return { ok: true, value: v, row, echo: `[RynthSuite] Set option ${name} = ${v}` };
    },
    getValue: (k) => values.get(k),
    getList: (n) => (n in lsts ? clone(lsts[n]) : null),
    setList(n, v, { source } = {}) {
      calls.push(["setList", n, clone(v), source]);
      lsts[n] = clone(v);
      return { ok: true, value: v };
    },
    getRef: (n) => refs[n] ?? null,
    setRef(n, v) {
      refs[n] = v;
      return { ok: true };
    },
    selectProfile(name, kind) {
      calls.push(["selectProfile", name, kind]);
      act = { name, kind, writable: kind !== "default" };
      return { ok: true, active: act };
    },
    saveAs(name, { mineOnly = false } = {}) {
      calls.push(["saveAs", name, mineOnly]);
      if (!/^[A-Za-z0-9_'-]{1,40}$/.test(name)) return { ok: false, error: `invalid profile name "${name}"` };
      act = { name, kind: mineOnly ? "char" : "shared", writable: true };
      return { ok: true, active: act };
    },
    setMineOnly(on) {
      calls.push(["setMineOnly", on]);
      return act.kind === "default" ? { ok: false, error: "Default is read-only — Save As first" } : { ok: true };
    },
    applyPreset(n) {
      calls.push(["applyPreset", n]);
      return act.kind === "default" ? { ok: false, error: "Default is read-only — Save As first" } : { ok: true, applied: ["EnableAutostack"] };
    },
    importHud() {
      calls.push(["importHud"]);
      return { ok: true, imported: ["LootMinValue"] };
    },
  };
}

function makeEngine(meta = null) {
  const counts = { load: 0, replaceMeta: 0, enterState: [] };
  let cur = meta ? clone(meta) : null;
  let enabled = false;
  const replaced = [];
  return {
    counts,
    replaced,
    meta: () => cur,
    load(m) {
      counts.load++;
      cur = clone(m);
      return { ok: true, warnings: [] };
    },
    replaceMeta(m, opts) {
      counts.replaceMeta++;
      replaced.push({ meta: clone(m), opts: { ...opts } });
      cur = clone(m);
      return { ok: true, warnings: [] };
    },
    get enabled() {
      return enabled;
    },
    set enabled(v) {
      enabled = !!v;
    },
    setDebug(on) {
      this.debug = on;
    },
    enterState(s, why) {
      counts.enterState.push([s, why]);
      return true;
    },
    snapshot() {
      return {
        enabled, running: true, name: "hunt", loaded: !!cur, state: "Default", secondsInState: 3, secondsInStateP: 3, stackDepth: 0, stack: [],
        ruleCount: cur ? cur.rules.length : 0, stateCount: 1, states: ["Default", "dead"], fired: cur && cur.rules[0] ? [cur.rules[0].id] : [],
        watchdog: null, lastFired: null, lastError: null, debug: false,
      };
    },
  };
}

function makeLibrary() {
  const calls = [];
  const rec = (name) => (...a) => {
    calls.push([name, ...a]);
    return { ok: true, warnings: [] };
  };
  return {
    calls,
    listMetas: () => [{ name: "hunt", savedAt: 1, bytes: 10 }],
    loadMeta: rec("loadMeta"),
    importMeta: rec("importMeta"),
    exportMeta: (name, kind) => {
      calls.push(["exportMeta", name, kind]);
      return { ok: true, data: kind === "met" ? new Uint8Array([1, 2]) : "text", warnings: [] };
    },
    saveMeta: rec("saveMeta"),
    removeMeta: rec("removeMeta"),
    listLoot: () => [{ name: "basic", savedAt: 1, bytes: 5 }],
    loadLoot: rec("loadLoot"),
    clearLoot: rec("clearLoot"),
    importLoot: rec("importLoot"),
    exportLoot: (name) => {
      calls.push(["exportLoot", name]);
      return { ok: true, text: "UTL" };
    },
    getLoot: (name) => (name === "basic" ? { version: 1, rules: [{ name: "keep", enabled: true, priority: 0, action: "Keep", conditions: [] }] } : null),
    putLoot: (name, p) => {
      calls.push(["putLoot", name, clone(p)]);
      return p.rules.every((r) => r.name) ? { ok: true } : { ok: false, errors: ["rule 1: no name"] };
    },
    newLoot: () => ({ version: 1, rules: [] }),
    lootNodeTypes: () => [{ id: 1, name: "SpellNameMatch", arity: 1 }, { id: 2, name: "StringValueMatch", arity: 2 }],
    removeLoot: rec("removeLoot"),
  };
}

function makeNav() {
  const calls = [];
  const route = { name: "loop", routeType: 1, points: [{ type: 0, ew: 1, ns: 2, z: 0 }, { type: 3, ew: 0, ns: 0, z: 0, pauseMs: 5000 }], activeIndex: 0, reversed: false, followTarget: null };
  return {
    calls,
    route: () => clone(route),
    status: () => ({ name: "loop", type: 1, typeName: "circular", i: 0, n: route.points.length, exec: null, lastResult: null, reversed: false, followTarget: null, enabled: false, paused: null, blockedBy: "disabled" }),
    addHere(type, fields, opts) {
      calls.push(["addHere", type, { ...fields }, { ...opts }]);
      const sel = opts.selected;
      return { ok: true, index: opts.mode === "above" && sel != null ? sel : opts.mode === "below" && sel != null ? sel + 1 : route.points.length };
    },
    save(name) {
      calls.push(["save", name]);
      return { ok: true };
    },
    loadByName(name) {
      calls.push(["loadByName", name]);
      return { ok: true, warnings: [] };
    },
    setActive: (i) => (calls.push(["setActive", i]), { ok: true, index: i }),
    step: (d) => (calls.push(["step", d]), { ok: true }),
    removeAt: (i) => (calls.push(["removeAt", i]), { ok: true }),
    setType: (t) => (calls.push(["setType", t]), { ok: true, routeType: t }),
    reverse: (f) => (calls.push(["reverse", f]), true),
    setEnabled: (on) => (calls.push(["setEnabled", on]), { ok: true, enabled: on }),
    resume: () => (calls.push(["resume"]), { ok: true }),
    clear: () => (calls.push(["clear"]), { ok: true }),
    updatePoint: (i, p) => (calls.push(["updatePoint", i, p]), { ok: true }),
  };
}
function makeNavProfiles() {
  const calls = [];
  return {
    calls,
    list: () => [{ name: "loop", savedAt: 1, bytes: 100 }],
    remove: (n) => (calls.push(["remove", n]), { ok: true }),
    importText: (n, t) => (calls.push(["importText", n, t]), { ok: true, warnings: [] }),
    exportText: (n) => (calls.push(["exportText", n]), { ok: true, text: "uTank2 NAV 1.2", warnings: [] }),
  };
}

function makeItems(options) {
  const calls = [];
  return {
    calls,
    list: () => (options.getList("items") || []),
    find: (g) => (options.getList("items") || []).find((e) => e.guid === g) || null,
    add(entry) {
      calls.push(["add", { ...entry }]);
      const e = { guid: entry.guid || 0x5001, name: entry.name || "Wand", wcid: 1, kind: "caster", element: null, noBuffs: !!entry.noBuffs };
      options.setList("items", [...(options.getList("items") || []), e]);
      return { ok: true, entry: e };
    },
    update: (g, p) => (calls.push(["update", g, p]), { ok: true }),
    remove: (g) => {
      calls.push(["remove", g]);
      options.setList("items", (options.getList("items") || []).filter((e) => e.guid !== g));
      return { ok: true };
    },
    resolveGuid: (e) => e.guid,
  };
}
function makeConsumables() {
  const calls = [];
  return {
    calls,
    list: () => [],
    add: (e) => (calls.push(["add", clone(e)]), { ok: true, entry: { ...e, name: "Ale", type: e.type ?? "General" } }),
    update: (g, p) => (calls.push(["update", g, p]), { ok: true }),
    remove: (g) => (calls.push(["remove", g]), { ok: true }),
  };
}

function makeWorld({ options = makeOptions(), host = {}, hud = null, layer = {}, control = null, kernelHeld = false } = {}) {
  const items = makeItems(options);
  const vt = {
    options,
    session: { options },
    items,
    consumables: makeConsumables(),
    nav: makeNav(),
    navProfiles: makeNavProfiles(),
    meta: makeEngine({ v: 1, name: "hunt", rules: [
      { id: "r1", state: "Default", enabled: true, cond: { t: "Death" }, act: { t: "SetState", state: "dead" } },
      { id: "r2", state: "dead", enabled: true, cond: { t: "Always" }, act: { t: "Chat", text: "/vt nav load runback" } },
      { id: "r3", state: "Default", enabled: true, cond: { t: "NavEmpty" }, act: { t: "None" } },
    ], navs: {}, warnings: [] }),
    library: makeLibrary(),
    views: { list: () => ["v1"], renderer: null, setRenderer(r) { this.renderer = r; }, click: (v, c) => ({ ok: true, v, c }) },
    statusLine: () => "VT: Default",
    parseExpr: (t) => (/>\s*$/.test(t) ? { ok: false, error: "unexpected end", pos: t.length } : { ok: true, dynamic: /range/.test(t) }),
    ...layer,
  };
  const calls = [];
  const bot = {
    vt,
    host: { TryGetObjectName: (g) => ({ 0x80000001: "Drudge Skulker", 0x5001: "Wand", 0x6001: "Ale" })[g] ?? null, ...host },
    kernel: { operatorHeld: kernelHeld },
    combat: { locked: 0 },
    buff: { forceRebuff: () => calls.push("forceRebuff"), cancelForceRebuff: () => calls.push("cancelForceRebuff") },
    control: control ?? {
      stop: (o) => (calls.push(["stop", o]), { ok: true }),
      resume: () => (calls.push(["resume"]), { ok: true }),
      isStopped: () => kernelHeld,
    },
    calls,
  };
  const win = { __bot: bot, __rynthHud: hud ? { bridge: hud } : undefined };
  return { win, bot, vt, options, calls };
}

// ── tests ──────────────────────────────────────────────────────────────
await check("normalizeTab: ids, aliases, advanced", () => {
  assert.equal(normalizeTab("Route"), "route");
  assert.equal(normalizeTab("nav"), "route");
  assert.equal(normalizeTab("ADVANCED"), "advanced");
  assert.equal(normalizeTab("settings"), "main");
  assert.equal(normalizeTab("vitals"), "main", "v1 Vitals joined Main");
  assert.equal(normalizeTab("options"), "main");
  assert.equal(normalizeTab("profiles"), "main");
  assert.equal(normalizeTab("Consumables"), "items", "v1 Consumables joined Items");
  assert.equal(normalizeTab("loot"), "loot");
  assert.equal(normalizeTab("bogus"), null);
  assert.deepStrictEqual([...VT_TABS], ["main", "monsters", "items", "buffs", "route", "loot", "meta", "advanced"]);
});

await check("never throws on a broken bot surface (throwing getters and services)", async () => {
  const boom = () => {
    throw new Error("boom");
  };
  const evil = new Proxy({}, { get: (_, k) => (k === "then" ? undefined : boom) });
  const variants = [
    { get vt() { throw new Error("vt getter"); } },
    { vt: evil, host: evil, kernel: evil, buff: evil, control: evil, combat: evil },
    { vt: { options: evil, items: evil, nav: evil, meta: evil, library: evil, consumables: evil, navProfiles: evil, views: evil, statusLine: boom } },
    { vt: null },
  ];
  for (const bot of variants) {
    const win = { get __bot() { return bot; }, __rynthVt: { session: boom }, __rynthHud: { get bridge() { throw new Error("hud"); } } };
    const b = createVtBridge({ win });
    for (const t of ALL_TABS) {
      const s = b.snapshot(t);
      assert.equal(typeof s, "object");
      assert.ok(s.view && typeof s.view === "object", `view for ${t}`);
    }
    const calls = [
      b.run.start(), b.run.stop(), b.run.toggle(), b.run.forceBuff(), b.run.cancelForceBuff(),
      b.opt.list(), b.opt.get("x"), b.opt.set("x", 1), b.opt.applyPreset("vtank"),
      b.profiles.list(), b.profiles.select("a", "shared"), b.profiles.saveAs("a"), b.profiles.remove("a", "shared"), b.profiles.setMineOnly(true), b.profiles.importHud(),
      b.monsters.list(), b.monsters.add("x"), b.monsters.update(1, {}), b.monsters.remove(1), b.monsters.move(1, 1), b.monsters.addSelectedTarget(), b.monsters.importHudPriorities(), b.monsters.importRynthAiJson("[]"),
      b.items.list(), b.items.addSelected({}), b.items.addByName("x"), b.items.update(1, {}), b.items.remove(1),
      b.consumables.list(), b.consumables.addSelected("BuffItem"), b.consumables.addByName("x", "General"), b.consumables.update(1, {}), b.consumables.remove(1),
      b.buffs.setItemSpell(1, "impen", true), b.buffs.resetItemSpells(1),
      b.loot.list(), b.loot.load("a"), b.loot.clear(), b.loot.importText("a", ""), b.loot.exportText("a"), b.loot.get("a"), b.loot.put("a", {}), b.loot.remove("a"), b.loot.newProfile(),
      b.navProfiles.list(), b.navProfiles.select("a"), b.navProfiles.saveAs("a"),
      b.route.status(), b.route.list(), b.route.load("a"), b.route.save("a"), b.route.remove("a"), b.route.setType(1), b.route.add(0, {}), b.route.setInsertMode("x"),
      b.route.setActive(0), b.route.step(1), b.route.removeAt(0), b.route.reverse(), b.route.enable(true), b.route.importText("a", "x"), b.route.exportText("a"),
      b.meta.status(), b.meta.list(), b.meta.load("a"), b.meta.importFile("a", "x", "af"), b.meta.exportFile("a", "met"), b.meta.setEnabled(true), b.meta.setDebug(true),
      b.meta.setState("x"), b.meta.addRule({}), b.meta.updateRule("r1", {}), b.meta.deleteRule("r1"), b.meta.moveRule("r1", 1), b.meta.save("a"),
    ];
    for (const p of calls) {
      assert.ok(p && typeof p.then === "function", "every command returns a Promise");
      const r = await p;
      assert.equal(typeof r, "object");
      assert.equal(typeof r.ok, "boolean");
      if (!r.ok) assert.equal(typeof r.error, "string");
    }
    assert.equal(b.ensureViewRenderer(() => ({ render() {} })), false);
  }
});

await check("works with NO bot: opt/profiles go to win.__rynthVt.session().options", async () => {
  const options = makeOptions();
  const win = { __bot: null, __rynthVt: { session: () => ({ options }) } };
  const b = createVtBridge({ win });
  const snap = b.snapshot("options");
  assert.equal(snap.tab, "main", "v1 name → Main");
  assert.equal(snap.present, false);
  assert.equal(snap.settings, true);
  assert.equal(snap.run.phase, "no-bot");
  assert.deepStrictEqual(snap.view.ranges.map((r) => r.key), ["MonsterRange"]);
  // the command bar: five switches from the options, the profile list
  const hdr = snap.header;
  assert.deepStrictEqual(Object.keys(hdr.switches), ["combat", "buff", "nav", "loot", "meta"]);
  assert.equal(hdr.switches.combat.on, true);
  assert.equal(hdr.switches.nav.on, false);
  assert.equal(hdr.switches.buff.available, true, "EnableBuffing has no row here: off, still switchable");
  assert.deepStrictEqual(hdr.profiles.map((p) => p.name), ["Default", "[By char]", "Hunt"]);
  assert.equal(hdr.active.readOnly, true);
  const mr = snap.view.ranges[0];
  assert.equal(mr.key, "MonsterRange");
  assert.equal(mr.lbf, true);
  assert.equal(mr.unitText, "m");
  assert.equal(snap.banner, "Default is read-only — Save As to keep changes");
  let r = await b.opt.set("AttackDistance", 0.0833);
  assert.equal(r.ok, true);
  assert.match(r.echo, /Set option AttackDistance/);
  assert.deepStrictEqual(options.calls.at(-1), ["set", "AttackDistance", 0.0833, "ui"]);
  r = await b.opt.get("monsterrange");
  assert.equal(r.ok, true);
  assert.equal(r.key, "MonsterRange");
  r = await b.opt.set("NoSuchOption", 1);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown option/);
  r = await b.opt.list("jiggle");
  assert.deepStrictEqual(r.rows.map((x) => x.key), ["DoJiggle"]);
  assert.equal(r.rows[0].inert, true);
  r = await b.opt.applyPreset("vtank");
  assert.equal(r.ok, false, "Default refuses the preset");
  r = await b.profiles.saveAs("My Hunt", true);
  assert.equal(r.ok, false, "spaces refused (G:54)");
  r = await b.profiles.saveAs("MyHunt", true);
  assert.equal(r.ok, true);
  assert.deepStrictEqual(options.calls.at(-1), ["saveAs", "MyHunt", true]);
  r = await b.opt.applyPreset("vtank");
  assert.equal(r.ok, true);
  r = await b.profiles.list();
  assert.equal(r.active.name, "MyHunt");
  assert.equal(r.active.label, "[Char] MyHunt");
  assert.equal((await b.profiles.setMineOnly(false)).ok, true);
  assert.equal((await b.profiles.importHud()).ok, true);
  // removing the ACTIVE profile selects Default first, through the authority
  r = await b.profiles.remove("MyHunt", "char");
  assert.equal(r.ok, true);
  const tail = options.calls.slice(-2);
  assert.deepStrictEqual(tail, [["selectProfile", "Default", "default"], ["profiles.remove", "MyHunt", "char"]]);
  // Main (vitals) + Advanced + Loot snapshots also work bot-less
  const v = b.snapshot("vitals").view;
  assert.equal(v.vitals.topOff.hp.key, "TopOffHP");
  assert.equal(v.vitals.combat.hp.key, "HealAt");
  assert.equal(v.vitals.combat.st, null, "no RestamAt row in this schema");
  assert.equal(v.vitals.emergencyHp.web, true);
  assert.deepStrictEqual(v.vitals.live, { hp: null, st: null, mn: null }, "no session handle: no live vitals");
  const adv = b.snapshot("advanced").view;
  assert.deepStrictEqual(adv.groups.flatMap((g) => g.rows.map((x) => x.key)), ["AttackHeight"], "only what no other tab shows");
  assert.deepStrictEqual(adv.inert.flatMap((g) => g.rows.map((x) => x.key)), ["DoJiggle"], "inert rows apart (ShowEditor is never drawn)");
  assert.equal(adv.total, ROWS.length);
  await b.opt.setFilter("height");
  assert.deepStrictEqual(b.snapshot("advanced").view.groups.flatMap((g) => g.rows.map((x) => x.key)), ["AttackHeight"]);
  await b.opt.setFilter("range");
  const found = b.snapshot("advanced").view.groups.flatMap((g) => g.rows);
  assert.deepStrictEqual(found.map((x) => [x.key, x.home]), [["MonsterRange", "main"]], "the filter searches every row and names its home");
  await b.opt.setFilter("");
  assert.deepStrictEqual(b.snapshot("buffs").view.rows.map((x) => x.key), ["RebuffSecondsRemaining"], "the Buffs tab's own knobs");
  const lt = b.snapshot("loot").view;
  assert.equal(lt.available, false);
  assert.deepStrictEqual(lt.rows, [], "no LootMinValue row in this schema");
  // Monsters list edits work without a bot (profile list)
  assert.equal((await b.monsters.add("Drudge Skulker")).ok, true);
  assert.equal(options.lists.monsters.length, 2, "DEFAULT row + entry stored");
});

await check("run.* delegates to the HUD bridge when mounted, else bot.control", async () => {
  const hudCalls = [];
  const hud = {
    start: async () => (hudCalls.push("start"), { ok: true, booted: true }),
    stop: async () => (hudCalls.push("stop"), { ok: true }),
    toggleRun: async () => (hudCalls.push("toggleRun"), { ok: true }),
    forceRebuff: () => (hudCalls.push("forceRebuff"), { ok: true }),
    cancelForceRebuff: () => (hudCalls.push("cancelForceRebuff"), { ok: true }),
  };
  let w = makeWorld({ hud });
  let b = createVtBridge({ win: w.win });
  for (const k of ["start", "stop", "toggle", "forceBuff", "cancelForceBuff"]) assert.equal((await b.run[k]()).ok, true, k);
  assert.deepStrictEqual(hudCalls, ["start", "stop", "toggleRun", "forceRebuff", "cancelForceRebuff"]);
  assert.deepStrictEqual(w.calls, [], "the bot itself was not touched");
  // no HUD: OperatorControl (never kernel.start/stop) + buff loop
  w = makeWorld({ kernelHeld: true });
  b = createVtBridge({ win: w.win });
  assert.equal((await b.run.toggle()).ok, true);
  assert.deepStrictEqual(w.calls.at(-1), ["resume"], "held → resume");
  assert.equal((await b.run.stop()).ok, true);
  assert.deepStrictEqual(w.calls.at(-1), ["stop", { persist: true, reason: "VT panel" }]);
  await b.run.forceBuff();
  await b.run.cancelForceBuff();
  assert.deepStrictEqual(w.calls.slice(-2), ["forceRebuff", "cancelForceRebuff"]);
  // no bot, no HUD → clean failure
  b = createVtBridge({ win: {} });
  const r = await b.run.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /HUD|\?bot=1/);
});

await check("items.addSelected: GetSelectedItemId, then the world selection, then fails cleanly", async () => {
  let sel = 0x5001;
  let world = 0;
  const w = makeWorld({ host: { GetSelectedItemId: () => sel, GetSelectedId: () => world } });
  const b = createVtBridge({ win: w.win });
  let r = await b.items.addSelected({ noBuffs: true });
  assert.equal(r.ok, true);
  assert.deepStrictEqual(w.vt.items.calls.at(-1), ["add", { guid: 0x5001, noBuffs: true }]);
  sel = 0;
  world = 0x5002;
  r = await b.items.addSelected({});
  assert.deepStrictEqual(w.vt.items.calls.at(-1), ["add", { guid: 0x5002, noBuffs: false }], "fell back to the world selection");
  world = 0;
  w.win.liveScene3d = { entityManager: { getSelectedTarget: () => 0x5003 } };
  r = await b.items.addSelected({});
  assert.deepStrictEqual(w.vt.items.calls.at(-1), ["add", { guid: 0x5003, noBuffs: false }], "…or the scene selection without a host member");
  w.win.liveScene3d = null;
  const before = w.vt.items.calls.length;
  r = await b.items.addSelected({});
  assert.equal(r.ok, false);
  assert.match(r.error, /select an item/);
  assert.equal(w.vt.items.calls.length, before, "nothing added");
  // by name + no bot
  r = await b.items.addByName("Wand", { noBuffs: false });
  assert.deepStrictEqual(w.vt.items.calls.at(-1), ["add", { name: "Wand", noBuffs: false }]);
  r = await createVtBridge({ win: {} }).items.addSelected({});
  assert.equal(r.ok, false);
  assert.match(r.error, /start the bot/);
});

await check("consumables.addSelected('BuffItem'): appraise first, refuse < 300 s / < RebuffSecondsRemaining", async () => {
  let appraisal = null;
  const requested = [];
  const durations = { 3001: 120, 3002: 1800 };
  const host = {
    GetSelectedItemId: () => 0x6001,
    TryGetObjectAppraisal: () => appraisal,
    HasAppraisalData: () => appraisal != null,
    RequestId: (g) => requested.push(g),
    TryGetSpellRecord: (id) => (durations[id] ? { id, name: `Spell ${id}`, duration: durations[id] } : null),
  };
  const w = makeWorld({ host });
  const b = createVtBridge({ win: w.win });
  let r = await b.consumables.addSelected("BuffItem");
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);
  assert.deepStrictEqual(requested, [0x6001], "RequestId before deciding");
  assert.equal(w.vt.consumables.calls.length, 0);
  appraisal = { spellBook: [3001] };
  r = await b.consumables.addSelected("BuffItem");
  assert.equal(r.ok, false);
  assert.match(r.error, /lasts 120 s; buff items under 300 s are not allowed/);
  assert.equal(w.vt.consumables.calls.length, 0, "a short buff item never reaches the model");
  appraisal = { spellBook: [3002] };
  r = await b.consumables.addSelected("BuffItem");
  assert.equal(r.ok, true);
  assert.deepStrictEqual(w.vt.consumables.calls.at(-1), ["add", { guid: 0x6001, type: "BuffItem", spellIds: [3002], durationS: 1800 }]);
  w.options.values.set("RebuffSecondsRemaining", 1900);
  r = await b.consumables.addSelected("BuffItem");
  assert.equal(r.ok, false, "the floor follows RebuffSecondsRemaining");
  assert.match(r.error, /under 1900 s/);
  appraisal = { spellBook: [] };
  r = await b.consumables.addSelected("BuffItem");
  assert.match(r.error, /no buff spell/);
  // other types pass straight to the model (it classifies / validates)
  r = await b.consumables.addSelected("HealthKit");
  assert.deepStrictEqual(w.vt.consumables.calls.at(-1), ["add", { guid: 0x6001, type: "HealthKit" }]);
  r = await b.consumables.addSelected("auto");
  assert.deepStrictEqual(w.vt.consumables.calls.at(-1), ["add", { guid: 0x6001 }]);
  r = await b.consumables.addSelected("Bogus");
  assert.equal(r.ok, false);
  // direct helper
  assert.equal(lists.buffItemPrecheck({ TryGetObjectAppraisal: () => ({ spellBook: [3002] }), TryGetSpellRecord: () => ({ duration: 299 }) }, null, 1, "Ale").ok, false);
});

await check("snapshot reads bot.vt exactly ONCE per call, for every tab", async () => {
  const w = makeWorld();
  let reads = 0;
  const bot = { ...w.bot };
  delete bot.vt;
  Object.defineProperty(bot, "vt", { get() { reads++; return w.vt; } });
  const b = createVtBridge({ win: { __bot: bot }, importer: async () => ({ buildDynamicBuffList: () => [], loadSpellLadders: async () => ({}) }) });
  for (const t of ALL_TABS) {
    reads = 0;
    const s = b.snapshot(t);
    assert.equal(reads, 1, `tab ${t} read bot.vt ${reads}×`);
    assert.equal(s.layer, true);
    assert.equal(s.statusLine, "VT: Default");
  }
});

await check("meta rule edits: replaceMeta(clone, {keepState:true}), never load; ids r<n>; move within a state", async () => {
  const w = makeWorld();
  const b = createVtBridge({ win: w.win });
  const eng = w.vt.meta;
  const before = clone(eng.meta());
  let r = await b.meta.addRule({ state: "back", cond: { t: "Always" }, act: { t: "SetState", state: "Default" } });
  assert.equal(r.ok, true);
  assert.equal(r.id, "r4", "1 + the highest r<n>");
  assert.equal(eng.counts.replaceMeta, 1);
  assert.deepStrictEqual(eng.replaced[0].opts, { keepState: true });
  assert.deepStrictEqual(before.rules.length, 3, "the engine's own object was not mutated in place");
  r = await b.meta.updateRule("r2", { enabled: false, act: { t: "Chat", text: "/vt opt set enablenav true" } });
  assert.equal(r.ok, true);
  assert.equal(eng.meta().rules.find((x) => x.id === "r2").enabled, false);
  r = await b.meta.moveRule("r3", -1);
  assert.equal(r.ok, true);
  assert.deepStrictEqual(eng.meta().rules.map((x) => x.id), ["r3", "r2", "r1", "r4"], "r3 swapped with r1 (same state), skipping r2 (dead)");
  r = await b.meta.moveRule("r3", -1);
  assert.equal(r.unchanged, true, "already first in its state");
  r = await b.meta.duplicateRule("r1");
  assert.equal(r.id, "r5");
  r = await b.meta.deleteRule("r5");
  assert.equal(r.ok, true);
  r = await b.meta.deleteRule("r1");
  assert.equal(r.ok, true);
  r = await b.meta.addRule({ state: "Default", cond: { t: "Always" }, act: { t: "None" } });
  assert.equal(r.id, "r5", "a deleted rule's id (r1) is never reused (= formats newRuleId)");
  r = await b.meta.deleteRule("nope");
  assert.equal(r.ok, false);
  r = await b.meta.setState("dead");
  assert.deepStrictEqual(eng.counts.enterState.at(-1), ["dead", "manual"]);
  await b.meta.setEnabled(true);
  assert.equal(eng.enabled, true);
  assert.equal(eng.counts.load, 0, "engine.load NEVER called by an edit");
  // an engine with no meta yet: a new rule creates one through replaceMeta
  const w2 = makeWorld({ layer: { meta: makeEngine(null) } });
  const b2 = createVtBridge({ win: w2.win });
  r = await b2.meta.addRule({ cond: { t: "Death" }, act: { t: "SetState", state: "dead" } });
  assert.equal(r.id, "r1");
  assert.equal(w2.vt.meta.meta().rules[0].state, "Default", "state defaults to Default");
  assert.equal(w2.vt.meta.counts.load, 0);
  // snapshot: grouped by state, fired flag, keyword tables
  const v = b.snapshot("meta").view;
  assert.deepStrictEqual(v.groups.map((g) => g.state), ["Default", "dead", "back"]);
  assert.equal(v.groups[0].current, true);
  assert.equal(v.groups[0].rules[0].fired, true, "the engine's fired ids are flagged");
  assert.ok(v.condKeywords.some((k) => k.kw === "ChatCapture" && k.met === 28));
  assert.ok(v.actKeywords.some((k) => k.kw === "CreateView" && k.fields.some((f) => f.name === "xml")));
  assert.equal(rm.COND_KEYWORDS.length, 28);
  assert.equal(rm.ACT_KEYWORDS.length, 16);
  // edited rules carry every Appendix-B field, typed as formats validateMeta wants
  const w3 = makeWorld({ layer: { meta: makeEngine({ v: 1, name: "m", rules: [
    { id: "r1", state: "Default", enabled: true, cond: { t: "Not", children: [] }, act: { t: "None" } },
  ], navs: { runback: { displayName: "runback", routeType: 1, navText: "" } }, warnings: [] }) } });
  const b3 = createVtBridge({ win: w3.win });
  r = await b3.meta.addRule({ cond: { t: "All", children: [{ t: "SecsInStateGE" }, { t: "BlockE", value: "0xA9B40000" }, { t: "MobsInDist_Priority", dist: "12.5", count: 2.7 }] },
    act: { t: "DoAll", children: [{ t: "Chat" }, { t: "SetWatchdog", state: "x" }, { t: "EmbedNav", tag: "RunBack" }] } });
  assert.equal(r.ok, true, r.error);
  const nr = w3.vt.meta.meta().rules.find((x) => x.id === r.id);
  assert.deepStrictEqual(nr.cond, { t: "All", children: [{ t: "SecsInStateGE", secs: 0 }, { t: "BlockE", value: 0xA9B40000 }, { t: "MobsInDist_Priority", priority: 0, dist: 12.5, count: 2 }] });
  assert.deepStrictEqual(nr.act, { t: "DoAll", children: [{ t: "Chat", text: "" }, { t: "SetWatchdog", state: "x", dist: 0, secs: 0 }, { t: "EmbedNav", tag: "RunBack", displayName: "" }] });
  r = await b3.meta.addRule({ cond: { t: "Not", children: [] }, act: { t: "None" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /Not needs exactly one condition/);
  r = await b3.meta.addRule({ cond: { t: "Always" }, act: { t: "EmbedNav", tag: "nowhere" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /no embedded route "nowhere" \(routes: runback\)/);
  assert.equal((await b3.meta.updateRule("r1", { enabled: false })).ok, true, "an enable toggle never re-validates a loaded rule");
  assert.equal((await b3.meta.updateRule("r1", { cond: { t: "Not", children: [] } })).ok, false, "an edited condition is checked");
  assert.equal(rm.newRuleId(new Set(["r1", "r2", "r4"])), "r5", "max + 1, gaps are not refilled");
  assert.equal(rm.newRuleId([{ id: "r9" }, { id: "x" }]), "r10", "array of rules");
  assert.equal(rm.newRuleId([]), "r1");
});

await check("loot.* and meta import/export/load/save go through bot.vt.library", async () => {
  const w = makeWorld();
  const b = createVtBridge({ win: w.win });
  const lib = w.vt.library;
  assert.equal((await b.loot.load("basic")).ok, true);
  assert.equal((await b.loot.clear()).ok, true);
  assert.equal((await b.loot.importText("basic", "UTL text")).ok, true);
  let r = await b.loot.exportText("basic");
  assert.equal(r.text, "UTL");
  r = await b.loot.get("basic");
  assert.equal(r.profile.rules[0].name, "keep");
  r = await b.loot.newProfile();
  assert.deepStrictEqual(r.profile, { version: 1, rules: [] });
  r = await b.loot.put("basic", { version: 1, rules: [{ name: "", conditions: [] }] });
  assert.equal(r.ok, false, "library validation errors surface");
  assert.deepStrictEqual(r.errors, ["rule 1: no name"]);
  assert.equal(r.error, "the loot profile is not valid", "errors[] without an error get a readable error");
  assert.equal((await b.loot.remove("basic")).ok, true);
  assert.equal((await b.meta.load("hunt")).ok, true);
  assert.equal((await b.meta.importFile("hunt", new Uint8Array([1]), "met")).ok, true);
  assert.equal((await b.meta.importFile("hunt", "x", "doc")).ok, false, "only met/af/json");
  r = await b.meta.exportFile("hunt", "met");
  assert.ok(r.data instanceof Uint8Array);
  assert.equal((await b.meta.save("hunt2")).ok, true);
  assert.deepStrictEqual(lib.calls.map((c) => c[0]), [
    "loadLoot", "clearLoot", "importLoot", "exportLoot", "putLoot", "removeLoot", "loadMeta", "importMeta", "exportMeta", "saveMeta",
  ]);
  assert.equal(lib.calls.at(-1)[1], "hunt2");
  assert.equal(lib.calls.at(-1)[2].rules.length, 3, "saveMeta gets the engine's current meta");
  const pv = b.snapshot("loot").view;
  assert.deepStrictEqual(pv.nodeTypes.map((t) => t.name), ["SpellNameMatch", "StringValueMatch"]);
  assert.equal(pv.available, true);
  // without a library: a clean refusal
  const w2 = makeWorld({ layer: { library: null } });
  r = await createVtBridge({ win: w2.win }).loot.list();
  assert.equal(r.ok, true);
  r = await createVtBridge({ win: w2.win }).loot.load("x");
  assert.equal(r.ok, false);
});

await check("buffs.setItemSpell / resetItemSpells write lists.buffs.itemSpells (D38)", async () => {
  const w = makeWorld();
  w.options.lists.items = [
    { guid: 0x7001, name: "Shield", wcid: 1, kind: "shield", element: null, noBuffs: false },
    { guid: 0x7002, name: "Sword", wcid: 2, kind: "melee", element: "Slash", noBuffs: false },
    { guid: 0x7003, name: "Buckler", wcid: 3, kind: "shield", element: null, noBuffs: true },
  ];
  const b = createVtBridge({ win: w.win, importer: async () => ({ buildDynamicBuffList: () => [], loadSpellLadders: async () => ({}) }) });
  let r = await b.buffs.setItemSpell(0x7001, "bane:fire", false);
  assert.equal(r.ok, true);
  assert.deepStrictEqual(w.options.lists.buffs.itemSpells[String(0x7001)], ["impen", "bane:slash", "bane:pierce", "bane:bludgeon", "bane:cold", "bane:lightning", "bane:acid"], "shield default minus fire");
  r = await b.buffs.setItemSpell(0x7002, "impen", true);
  assert.deepStrictEqual(w.options.lists.buffs.itemSpells[String(0x7002)], ["impen"], "melee default (none) plus impen");
  r = await b.buffs.setItemSpell(0x7003, "impen", true);
  assert.equal(r.ok, false, "No-Buffs items cannot get item buffs");
  r = await b.buffs.setItemSpell(0x7001, "bogus", true);
  assert.equal(r.ok, false);
  r = await b.buffs.resetItemSpells(0x7001);
  assert.equal(r.ok, true);
  assert.equal(String(0x7001) in w.options.lists.buffs.itemSpells, false, "override dropped → defaults again");
  const v = b.snapshot("buffs").view;
  const shield = v.items.find((x) => x.guid === 0x7001);
  assert.equal(shield.families.filter((f) => f.on).length, 8, "shield: impen + 7 banes by default");
  const sword = v.items.find((x) => x.guid === 0x7002);
  assert.deepStrictEqual(sword.families.filter((f) => f.on).map((f) => f.family), ["impen"]);
  assert.equal(sword.overridden, true);
  const buckler = v.items.find((x) => x.guid === 0x7003);
  assert.equal(buckler.noBuffs, true);
  assert.equal(buckler.families.some((f) => f.on), false);
  // removing an item drops its override
  await b.items.remove(0x7002);
  assert.equal(String(0x7002) in w.options.lists.buffs.itemSpells, false);
});

await check("buffs.setEnabled / setAuto project the enabled set as lists.buffs.spec (fake ladder)", async () => {
  const ladder = { 10: [1, 7, 3, 300], 11: [1, 8, 3, 400], 20: [9, 6, 3, 250], 30: [11, 7, 3, 300] };
  const lib = { buildDynamicBuffList: ({ knownIds }) => knownIds.filter((x) => x !== 10), loadSpellLadders: async () => ladder };
  const w = makeWorld({ host: { TryGetKnownSpells: () => [10, 11, 20, 30], TryGetSpellRecord: (id) => ({ id, name: `S${id}`, school: 4 }), TryGetSelfEnchantments: () => [{ spellId: 11, family: 1, remainingS: 120, permanent: false }] } });
  const b = createVtBridge({ win: w.win, importer: async () => lib });
  let v = b.snapshot("buffs").view;
  assert.equal(v.loading, true, "first snapshot kicks off the lazy ladder load");
  await b.buffs.list();
  v = b.snapshot("buffs").view;
  assert.equal(v.loading, false);
  assert.deepStrictEqual(v.buffs.map((r) => [r.spellId, r.tier, r.schoolName, r.remainingS, r.enabled, r.state]), [[11, 8, "Creature", 120, true, "low"], [20, 6, "Creature", null, true, "missing"], [30, 7, "Creature", null, true, "missing"]]);
  assert.deepStrictEqual(v.summary, { total: 3, enabled: 3, active: 1, low: 1, soon: 0, missing: 2 });
  assert.equal(v.buffs[0].tierText, "VIII");
  assert.equal(v.auto, true, "no buff config = auto");
  let r = await b.buffs.setEnabled(20, false);
  assert.equal(r.ok, true);
  assert.deepStrictEqual(w.options.lists.buffs.spec, [11, 30]);
  assert.deepStrictEqual(w.options.lists.buffs.disabled, [20]);
  v = b.snapshot("buffs").view;
  assert.deepStrictEqual(v.buffs.map((x) => x.enabled), [true, false, true]);
  assert.equal(v.buffs[1].state, "off");
  r = await b.buffs.setEnabled(20, true);
  assert.deepStrictEqual(w.options.lists.buffs.spec, [11, 20, 30], "back in dynamic order");
  r = await b.buffs.setAuto(true);
  assert.equal(w.options.lists.buffs.spec, "auto");
  r = await b.buffs.setAuto(false);
  assert.deepStrictEqual(w.options.lists.buffs.spec, [11, 20, 30]);
  r = await b.buffs.setEnabled(11, false);
  assert.deepStrictEqual(w.options.lists.buffs.spec, [20, 30]);
  // a whole group in ONE write (the Buffs tab's group box)
  const writes = w.options.calls.filter((c) => c[0] === "setList").length;
  r = await b.buffs.setEnabledMany([20, 30], false);
  assert.equal(r.ok, true);
  assert.equal(w.options.calls.filter((c) => c[0] === "setList").length, writes + 1, "one write");
  assert.deepStrictEqual(w.options.lists.buffs.spec, []);
  r = await b.buffs.setEnabledMany([11, 20, 30], true);
  assert.deepStrictEqual(w.options.lists.buffs.spec, [11, 20, 30]);
  assert.equal((await b.buffs.setEnabledMany([], true)).ok, false);
  // nothing known yet (not logged in / unreadable spellbook): an explicit
  // projection would store spec [] = buff nothing → refused, list untouched
  const w2 = makeWorld({ host: { TryGetKnownSpells: () => [] } });
  const b2 = createVtBridge({ win: w2.win, importer: async () => lib });
  const before = clone(w2.options.lists.buffs);
  r = await b2.buffs.setAuto(false);
  assert.equal(r.ok, false);
  assert.match(r.error, /no known self buffs/);
  r = await b2.buffs.setEnabled(20, false);
  assert.equal(r.ok, false);
  assert.deepStrictEqual(w2.options.lists.buffs, before, "no empty explicit spec written");
  assert.equal((await b2.buffs.setAuto(true)).ok, true, "Auto needs no list");
  assert.equal(w2.options.lists.buffs.spec, "auto");
});

await check("Buffs tab with the REAL buff_loop.js ladder (default importer)", async () => {
  // 2 = Strength Self I, 2087 = Strength Self VII (category 1), 1450 = Willpower Self VI (category 11)
  const w = makeWorld({ host: { TryGetKnownSpells: () => [2, 2087, 1450] } });
  const b = createVtBridge({ win: w.win });
  const r = await b.buffs.list();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.loading, false);
  const ids = r.buffs.map((x) => x.spellId);
  assert.ok(ids.includes(2087) && ids.includes(1450), `best tier per family: ${ids}`);
  assert.ok(!ids.includes(2), "Strength I collapses into its family's best tier");
  const str = r.buffs.find((x) => x.spellId === 2087);
  assert.equal(str.tier, 7);
  assert.equal(str.familyLabel, "Strength");
  assert.equal(str.group, "Attributes");
  assert.deepStrictEqual(r.groups.map((g) => g.group), ["Attributes"], "Strength + Willpower are both attributes");
});

await check("navProfiles.saveAs → nav.save; select → nav.loadByName; route.add uses insert mode + selection", async () => {
  const w = makeWorld({ host: { GetSelectedId: () => 0x80000001 } });
  const b = createVtBridge({ win: w.win });
  const nav = w.vt.nav;
  assert.equal((await b.navProfiles.saveAs("loop2")).ok, true);
  assert.deepStrictEqual(nav.calls.at(-1), ["save", "loop2"]);
  assert.equal((await b.navProfiles.select("loop")).ok, true);
  assert.deepStrictEqual(nav.calls.at(-1), ["loadByName", "loop"]);
  let r = await b.route.add(0, {});
  assert.deepStrictEqual(nav.calls.at(-1), ["addHere", 0, { targetGuid: 0x80000001 }, { mode: "end", selected: null }], "Add picks up the selection (portal ⇒ Portal/NPC, G:199)");
  assert.equal((await b.route.setInsertMode("sideways")).ok, false);
  await b.route.setInsertMode("above");
  await b.route.select(1);
  r = await b.route.add(3, { seconds: 5 });
  assert.deepStrictEqual(nav.calls.at(-1), ["addHere", 3, { seconds: 5 }, { mode: "above", selected: 1 }]);
  r = await b.route.add(4, { chat: "/ls" });
  assert.deepStrictEqual(nav.calls.at(-1)[3], { mode: "above", selected: 2 }, "Insert Above stays on the original row (now one lower)");
  await b.route.setInsertMode("below");
  r = await b.route.add(8, {});
  assert.deepStrictEqual(nav.calls.at(-1)[3], { mode: "below", selected: 3 });
  r = await b.route.add(8, {});
  assert.deepStrictEqual(nav.calls.at(-1)[3], { mode: "below", selected: nav.calls.at(-2)[3].selected + 1 }, "Insert Below follows the new row");
  await b.route.setInsertMode("above");
  await b.route.add(2, { spellId: 1635 }, "end");
  assert.deepStrictEqual(nav.calls.at(-1), ["addHere", 2, { spellId: 1635 }, { mode: "end", selected: null }]);
  await b.route.add(5, { name: "Lark the Grocer" }, "end");
  assert.deepStrictEqual(nav.calls.at(-1), ["addHere", 5, { name: "Lark the Grocer" }, { mode: "end", selected: null }], "a typed vendor name wins over the selection");
  await b.route.add(5, {}, "end");
  assert.deepStrictEqual(nav.calls.at(-1)[2], { targetGuid: 0x80000001 }, "no name → the selected vendor");
  await b.route.enable(true);
  assert.deepStrictEqual(nav.calls.slice(-2), [["setEnabled", true], ["resume"]]);
  await b.route.reverse(true);
  assert.deepStrictEqual(nav.calls.at(-1), ["reverse", true]);
  r = await b.route.exportText("loop");
  assert.equal(r.text, "uTank2 NAV 1.2");
  r = await b.route.importText("x", "uTank2 NAV 1.2\r\n1\r\n0\r\n");
  assert.equal(r.ok, true);
  const v = b.snapshot("route").view;
  assert.equal(v.points.length, 2);
  assert.equal(v.points[0].active, true);
  assert.match(v.points[1].label, /^Pause 5 s/);
  assert.equal(v.insertMode, "above");
  assert.match(v.statusLine, /^Nav: 1\/2 circular/);
  assert.deepStrictEqual(v.types.map((t) => t.name), ["Circular", "Linear", "Follow", "Once"]);
});

await check("recall picker = RECALL_SPELL_NAMES ∩ known spells", () => {
  const w = makeWorld({ host: { TryGetKnownSpells: () => [1635, 48, 999999] } });
  const b = createVtBridge({ win: w.win });
  const v = b.snapshot("route").view;
  assert.deepStrictEqual(v.recalls.map((x) => x.id).sort((a, c) => a - c), [48, 1635]);
});

await check("Monsters: DEFAULT pinned; add / update / move / remove; Add Sel; parse check", async () => {
  const w = makeWorld({ host: { GetSelectedId: () => 0x80000001 } });
  const b = createVtBridge({ win: w.win });
  assert.equal((await b.monsters.add("DEFAULT")).ok, false);
  assert.equal((await b.monsters.add("  ")).ok, false);
  assert.equal((await b.monsters.add("range>5 && species==drudge")).ok, true);
  assert.equal((await b.monsters.add("Blood Shreth")).ok, true);
  let r = await b.monsters.addSelectedTarget();
  assert.equal(r.name, "Drudge Skulker");
  r = await b.monsters.addSelectedTarget();
  assert.equal(r.ok, false, "duplicates refused");
  r = await b.monsters.list();
  assert.deepStrictEqual(r.entries.map((e) => e.text), ["DEFAULT", "range>5 && species==drudge", "Blood Shreth", "Drudge Skulker"]);
  assert.equal((await b.monsters.remove(0)).ok, false, "DEFAULT cannot be deleted");
  assert.equal((await b.monsters.move(0, 1)).ok, false, "DEFAULT stays on top");
  r = await b.monsters.move(3, -5);
  assert.equal(r.index, 1, "clamped below DEFAULT");
  r = await b.monsters.update(1, { S: true, priority: 9, damageType: "electric", WC: true, Cs: true });
  assert.equal(r.ok, true);
  const e1 = (await b.monsters.list()).entries[1];
  assert.equal(e1.priority, 4, "P clamped to 4");
  assert.equal(e1.damageType, "Lightning", "Electric ⇄ Lightning");
  assert.equal(e1.WC && e1.Cs && e1.S, true);
  r = await b.monsters.update(0, { text: "nope", enabled: false, priority: -1, F: true });
  const d = (await b.monsters.list()).entries[0];
  assert.deepStrictEqual([d.text, d.enabled, d.priority, d.F], ["DEFAULT", true, -1, true], "DEFAULT keeps its name, is always enabled");
  assert.equal((await b.monsters.remove(3)).ok, true);
  r = await b.monsters.check("range>");
  assert.equal(r.parse.ok, false);
  const v = b.snapshot("monsters").view;
  assert.deepStrictEqual(v.columns, ["F", "B", "G", "I", "Y", "V", "A", "R", "S", "WC", "FC", "Cp", "DC", "Cs"]);
  assert.deepStrictEqual(v.priorities, [-1, 0, 1, 2, 3, 4]);
  assert.equal(v.selectedName, "Drudge Skulker");
  assert.equal(v.entries[2].parse.dynamic, true, "range ⇒ DYNAMIC");
  // without layer.parseExpr (INT-2 hook) the editor is told why
  const wNo = makeWorld({ layer: { parseExpr: undefined } });
  r = await createVtBridge({ win: wNo.win }).monsters.check("range>5");
  assert.deepStrictEqual([r.ok, r.parse, r.unavailable], [true, null, true]);
  assert.match(r.reason, /no expression parser/);
  assert.equal(createVtBridge({ win: wNo.win }).snapshot("monsters").view.syntaxCheck, false);
  r = await createVtBridge({ win: {} }).monsters.check("range>5");
  assert.match(r.reason, /start the bot/);
  // a stock DEFAULT-only list is stored as [] (the model's own DEFAULT-only list)
  const w2 = makeWorld();
  const b2 = createVtBridge({ win: w2.win });
  await b2.monsters.add("x");
  await b2.monsters.remove(1);
  assert.deepStrictEqual(w2.options.lists.monsters, []);
});

await check("Monsters imports: HUD priorities and RynthAi JSON", async () => {
  const w = makeWorld();
  w.options.lists.legacyPriorities = { olthoi: 10, drudge: 2 };
  const b = createVtBridge({ win: w.win });
  let r = await b.monsters.importHudPriorities();
  assert.equal(r.added, 2);
  r = await b.monsters.importHudPriorities();
  assert.equal(r.added, 0, "idempotent");
  let es = (await b.monsters.list()).entries;
  assert.deepStrictEqual(es.slice(1).map((e) => [e.text, e.priority]), [["olthoi", 4], ["drudge", 2]]);
  const json = JSON.stringify({ MonsterRules: [
    { Name: "Default", Priority: 2, UseStreak: true },
    { Name: "Shreth", MatchExpression: "range<10", Priority: 3, Imperil: true, DamageType: "Cold", UseBolt: false, UseArc: false },
  ] });
  r = await b.monsters.importRynthAiJson(json);
  assert.equal(r.ok, true);
  assert.equal(r.added, 1);
  assert.equal(r.defaultSet, true);
  es = (await b.monsters.list()).entries;
  assert.equal(es[0].S, true);
  assert.equal(es[0].priority, 2);
  const sh = es.at(-1);
  assert.equal(sh.text, "(range<10) && name==`Shreth`");
  assert.equal(sh.A, false);
  assert.equal(sh.I, true);
  assert.equal(sh.damageType, "Cold");
  assert.equal((await b.monsters.importRynthAiJson("{nope")).ok, false);
  // HUD fallback: the HUD bridge's saved priorities when the profile has none
  const w2 = makeWorld({ hud: { getSettings: () => ({ priorities: { mosswart: 3 } }) } });
  r = await createVtBridge({ win: w2.win }).monsters.importHudPriorities();
  assert.equal(r.added, 1);
});

await check("ensureViewRenderer attaches only when the ViewManager has none", () => {
  const w = makeWorld();
  const b = createVtBridge({ win: w.win });
  let made = 0;
  const f = () => (made++, { render() {}, update() {}, destroy() {} });
  assert.equal(b.ensureViewRenderer(f), true);
  assert.equal(b.ensureViewRenderer(f), false);
  assert.equal(made, 1);
  const mine = w.vt.views.renderer;
  assert.equal(b.releaseViewRenderer({ render() {} }), false, "someone else's renderer is left alone");
  assert.equal(w.vt.views.renderer, mine);
  assert.equal(b.releaseViewRenderer(mine), true);
  assert.equal(w.vt.views.renderer, null, "detached (panel dispose)");
  assert.equal(b.releaseViewRenderer(mine), false);
  assert.equal(b.ensureViewRenderer(f), true, "the next open attaches again");
  assert.equal(createVtBridge({ win: {} }).releaseViewRenderer(mine), false, "no layer: no-op");
});

await check("v2 switches: NAV / META through their live services, the rest straight to the option", async () => {
  const w = makeWorld();
  const b = createVtBridge({ win: w.win });
  let r = await b.switches.set("nav", true);
  assert.equal(r.ok, true);
  assert.deepStrictEqual(w.vt.nav.calls.slice(-2), [["setEnabled", true], ["resume"]], "a paused route resumes");
  r = await b.switches.set("meta", true);
  assert.equal(r.ok, true);
  assert.equal(w.vt.meta.enabled, true, "the engine's own switch");
  r = await b.switches.set("combat", false);
  assert.deepStrictEqual(w.options.calls.at(-1), ["set", "EnableCombat", false, "ui"]);
  r = await b.switches.set("loot", false);
  assert.deepStrictEqual(w.options.calls.at(-1), ["set", "EnableLooting", false, "ui"]);
  assert.equal((await b.switches.set("bogus", true)).ok, false);
  // the same switches edited as options (Advanced search) take the bar's path
  const navCalls = w.vt.nav.calls.length;
  assert.equal((await b.opt.set("EnableNav", false)).ok, true);
  assert.deepStrictEqual(w.vt.nav.calls.slice(navCalls), [["setEnabled", false]], "the VTank name too, through ActiveNav");
  assert.equal((await b.opt.set("enablemeta", false)).ok, true);
  assert.equal(w.vt.meta.enabled, false);
  // no bot: NAV / META write the profile's options
  const options = makeOptions();
  const nb = createVtBridge({ win: { __bot: null, __rynthVt: { session: () => ({ options }) } } });
  assert.equal((await nb.switches.set("nav", true)).ok, true);
  assert.deepStrictEqual(options.calls.at(-1), ["set", "EnableNavigation", true, "ui"]);
  assert.equal((await nb.switches.set("meta", true)).ok, true);
  assert.deepStrictEqual(options.calls.at(-1), ["set", "EnableMeta", true, "ui"]);
  assert.equal(nb.snapshot("main").header.switches.nav.on, true);
});

await check("v2 items.addAs: Auto routes a weapon to the Items list and anything else to Consumables; explicit kinds/types; by name", async () => {
  const inv = [{ guid: 0x7004, name: "Heavy Axe", wcid: 4 }, { guid: 0x7005, name: "Healing Kit", wcid: 5 }];
  let sel = 0x7004;
  const w = makeWorld({ host: { GetSelectedItemId: () => sel, TryGetPlayerInventory: () => inv } });
  w.vt.items.classify = (row) => (/axe/i.test(row.name) ? "melee" : null);
  const b = createVtBridge({ win: w.win });
  let r = await b.items.addAs({ as: "auto" });
  assert.equal(r.ok, true);
  assert.deepStrictEqual(w.vt.items.calls.at(-1), ["add", { guid: 0x7004, kind: "melee", noBuffs: false }]);
  sel = 0x7005;
  r = await b.items.addAs({ as: "auto" });
  assert.equal(r.ok, true);
  assert.deepStrictEqual(w.vt.consumables.calls.at(-1), ["add", { guid: 0x7005 }], "the SUP model detects the type");
  r = await b.items.addAs({ as: "StaminaKit" });
  assert.deepStrictEqual(w.vt.consumables.calls.at(-1), ["add", { guid: 0x7005, type: "StaminaKit" }]);
  r = await b.items.addAs({ as: "shield", noBuffs: true });
  assert.equal(r.ok, false, "an explicit combat kind never makes a healing kit a shield");
  assert.match(r.error, /Healing Kit is not a weapon, shield/);
  sel = 0x7004;
  r = await b.items.addAs({ as: "shield", noBuffs: true });
  assert.deepStrictEqual(w.vt.items.calls.at(-1), ["add", { guid: 0x7004, kind: "shield", noBuffs: true }], "a weapon may be filed under another combat kind");
  sel = 0x7005;
  assert.equal((await b.items.addAs({ as: "auto", name: "  " })).ok, false, "an empty name is refused, not read as the selection");
  r = await b.items.addAs({ as: "auto", name: "heavy axe" });
  assert.deepStrictEqual(w.vt.items.calls.at(-1), ["add", { name: "heavy axe", kind: "melee", noBuffs: false }], "by name: classified from the inventory row");
  r = await b.items.addAs({ as: "auto", name: "Healing Kit" });
  assert.deepStrictEqual(w.vt.consumables.calls.at(-1), ["add", { name: "Healing Kit" }]);
  assert.equal((await b.items.addAs({ as: "bogus" })).ok, false);
  sel = 0;
  assert.equal((await b.items.addAs({ as: "melee" })).ok, false, "nothing selected");
  // a second copy of a monster entry is refused (the first match wins, G:103)
  assert.equal((await b.monsters.add("Drudge Skulker")).ok, true);
  const dup = await b.monsters.add("drudge skulker");
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already on the list/);
  // the Items tab's view: both lists + the selection preview
  sel = 0x7004;
  const v = b.snapshot("items").view;
  assert.deepStrictEqual(v.selection, { guid: 0x7004, name: "Heavy Axe", owned: true, kind: "melee" });
  assert.equal(v.combatAvailable && v.consumablesAvailable, true);
  assert.ok(Array.isArray(v.combat) && Array.isArray(v.consumables));
  assert.equal(v.kindLabels.caster, "Wand/Staff/Orb");
});

await check("v2 route view: distances (positional points only), the selection, dirty; overlay data", async () => {
  // waypoint 0 is at ew 1, ns 2 → world (24708, 24948); stand 30 m north of it
  const lbX = Math.floor(24708 / 192);
  const lbY = Math.floor(24948 / 192);
  const pose = { objCellId: ((lbX << 24) | (lbY << 16) | 1) >>> 0, x: 24708 - lbX * 192, y: 24948 - lbY * 192 + 30, z: 0 };
  const w = makeWorld({ host: { TryGetPlayerPose: () => pose, GetSelectedId: () => 0x80000001 } });
  const b = createVtBridge({ win: w.win });
  const v = b.snapshot("route").view;
  assert.equal(Math.round(v.points[0].distM), 30);
  assert.equal(v.points[1].distM, null, "a Pause has no position");
  assert.equal(v.points[0].detail, "2.00N, 1.00E");
  assert.deepStrictEqual(v.selection, { guid: 0x80000001, name: "Drudge Skulker" });
  assert.equal(v.dirty, false);
  const o = b.routeOverlay();
  assert.deepStrictEqual(o, { routeType: 1, activeIndex: 0, reversed: false, finished: false, paused: false, enabled: true, points: [{ type: 0, ew: 1, ns: 2, z: 0 }, { type: 3, ew: 0, ns: 0, z: 0 }] });
  assert.deepStrictEqual(b.routeOverlayStyle(), { navLineThickness: 6, navRingThickness: 6, ringRadiusM: 3 }, "no thickness rows here: VTank's defaults; rings at the arrival radius");
  assert.equal(createVtBridge({ win: { __bot: null } }).routeOverlay(), null, "no layer: null");
});

await check("v2 monsters view: the row governing the selected / locked monster (MonsterList.resolve)", async () => {
  const w = makeWorld({ host: { GetSelectedId: () => 0x80000001 } });
  w.options.lists.monsters = [{ text: "DEFAULT" }, { text: "Drudge Skulker", priority: 3 }];
  w.vt.monsters = { resolve: (g) => (g === 0x80000001 ? { entry: { text: "drudge skulker" }, index: 1 } : null) };
  const b = createVtBridge({ win: w.win });
  let v = b.snapshot("monsters").view;
  assert.equal(v.targetIndex, 1);
  assert.equal(v.targetSource, "selection");
  w.vt.monsters = { resolve: () => ({ entry: { text: "Something Else" }, index: 1 }) };
  v = b.snapshot("monsters").view;
  assert.equal(v.targetIndex, null, "the live list disagrees with the stored one → no marker");
  // a selected NPC / door / player is not governed by any row (not even DEFAULT)
  w.vt.monsters = { resolve: () => ({ entry: { text: "DEFAULT" }, index: 0 }) };
  w.bot.host.ObjectIsAttackable = () => false;
  assert.equal(b.snapshot("monsters").view.targetIndex, null);
  w.bot.host.ObjectIsAttackable = () => true;
  assert.equal(b.snapshot("monsters").view.targetIndex, 0, "a monster no entry names: DEFAULT");
});

console.log(fail === 0 ? `rynth_vt_bridge: all ${pass} checks passed` : `rynth_vt_bridge: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
