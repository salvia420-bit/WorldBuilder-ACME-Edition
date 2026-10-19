// tools/rynth-vt-preview/world.js — a scripted world for rynth_vt_preview.html
// (2026-10-19): the REAL VTank panel (plugins/rynth-vt/), the REAL bridge
// (rynth/vt/bridge/), the REAL settings authority (rynth/vt/settings/, over
// an in-memory storage) and the REAL buff ladder (rynth/buff_loop.js +
// spell_ladders.json, imported lazily by the bridge as in the client) over a
// fake bot — no client, no wasm, no server. For reviewing the panel's layout
// and wording without logging in (the 1070 eye-test box is not always up).
//
// The character is a developer who ran @addallspells — it "knows" every
// ladder spell, oddballs included — so the Buffs tab shows what the dynamic
// list really picks. Vitals, buff timers and the player's position drift
// once a second; the route is a loop around Holtburg.

import { getVtSession } from "../../rynth/vt/settings/index.js";
import { degToWorld } from "../../rynth/nav_file.js";

const CHAR = 0x50000001;
const HOLTBURG = { ew: 33.5, ns: 42.2 };

/** A Map-backed Storage (the preview never touches the page's real localStorage for profiles). */
function memStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

/** Host pose { objCellId, x, y, z } for a map position (degrees). */
function poseAt(ew, ns, z = 0) {
  const { wx, wy } = degToWorld(ew, ns);
  const lx = Math.floor(wx / 192);
  const ly = Math.floor(wy / 192);
  const x = wx - lx * 192;
  const y = wy - ly * 192;
  const cell = Math.min(7, Math.floor(x / 24)) * 8 + Math.min(7, Math.floor(y / 24)) + 1;
  return { objCellId: ((lx << 24) | (ly << 16) | cell) >>> 0, x, y, z };
}

const clone = (v) => JSON.parse(JSON.stringify(v));

export async function installPreviewWorld(win = globalThis) {
  const [catalog, ladder] = await Promise.all([
    fetch(new URL("../../data/spells-catalog.json", import.meta.url)).then((r) => (r.ok ? r.json() : { spells: {} })).catch(() => ({ spells: {} })),
    fetch(new URL("../../rynth/spell_ladders.json", import.meta.url)).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]);
  const spells = catalog.spells || {};
  // the dev character: every ladder enchantment + the recall spells
  const known = [
    ...Object.entries(ladder).filter(([, row]) => (row.length < 3 || Number(row[2]) & 2)).map(([id]) => Number(id)),
    1635, 2645, 48, 157, 158, 1636, 2023, 2041, 2931,
  ];

  // ── settings: the real VtOptions, a "Hunt" profile with some edits ───────
  const storage = memStorage();
  const session = getVtSession(win, CHAR, { storage, charName: "Preview Tank" });
  const options = session.options;
  options.saveAs("Hunt", { mineOnly: false });
  options.saveAs("Runback", { mineOnly: true });
  options.selectProfile("Hunt", "shared");
  for (const [k, v] of [["MonsterRange", 35], ["HealAt", 65], ["BoostLootPriority", true], ["PeaceModeWhenIdle", true], ["EnableNavigation", true], ["EnableMeta", true], ["SummonPets", true]]) {
    options.set(k, v, { source: "ui" });
  }
  options.setList("monsters", [
    { text: "DEFAULT", priority: 1, A: true, V: true, damageType: "Auto" },
    { text: "Drudge Skulker", priority: 3, A: true, I: true, Y: true },
    { text: "Blood Shreth", priority: 4, S: true, A: true, damageType: "Fire" },
    { text: "range>5 && species==drudge", priority: 2, Y: true, A: false },
    { text: "Mosswart Mudstomper", priority: -1 },
  ], { source: "ui" });
  options.setList("items", [
    { guid: 0x7001, name: "Kite Shield", wcid: 91, kind: "shield", element: null, noBuffs: false },
    { guid: 0x7002, name: "Buckler", wcid: 44, kind: "shield", element: null, noBuffs: true },
    { guid: 0x7003, name: "Fire Baton", wcid: 2547, kind: "caster", element: "Fire", noBuffs: false },
    { guid: 0x7006, name: "Acid Spear", wcid: 3812, kind: "melee", element: "Acid", noBuffs: false },
  ], { source: "ui" });

  // ── the route: a loop around Holtburg ────────────────────────────────────
  const P = (type, dEw, dNs, extra = {}) => ({ type, ew: HOLTBURG.ew + dEw, ns: HOLTBURG.ns + dNs, z: 0.06, ...extra });
  const navStore = new Map([
    ["loop", { routeType: 1, points: [P(0, 0, 0), P(0, 0.12, 0.05), P(0, 0.22, -0.04), P(3, 0.22, -0.04, { pauseMs: 4000 }), P(0, 0.18, -0.16), P(6, 0.08, -0.2, { name: "Holtburg Outpost Portal", guid: 0x7a001 }), P(0, -0.04, -0.12), P(4, -0.04, -0.12, { chat: "/f buffs in 30s" })] }],
    ["runback", { routeType: 4, points: [P(2, 0, 0, { spellId: 1635 }), P(0, 0.1, 0.1), P(0, 0.2, 0.2)] }],
  ]);
  let route = { name: "loop", ...clone(navStore.get("loop")), activeIndex: 2, reversed: false, followTarget: null, paused: null };
  let dirty = false;
  let gen = 1;
  const setRoute = (r) => { route = r; dirty = true; gen++; };
  let player = { ew: HOLTBURG.ew + 0.19, ns: HOLTBURG.ns - 0.02 };
  let selectedWorld = 0x80001234; // a Drudge Skulker
  let selectedItem = 0x7104; // Heavy Axe in the pack
  let held = false;
  let insertAt = (mode, sel, n) => (mode === "above" && sel != null ? sel : mode === "below" && sel != null ? sel + 1 : n);

  const nav = {
    get enabled() { return !!options.getValue("EnableNavigation"); },
    route: () => clone(route),
    status: () => ({
      name: route.name, type: route.routeType, typeName: ({ 1: "circular", 2: "linear", 3: "follow", 4: "once" })[route.routeType], i: route.activeIndex, n: route.points.length,
      exec: options.getValue("EnableNavigation") ? `walk to waypoint ${route.activeIndex + 1}` : null, lastResult: "DONE:0", reversed: route.reversed,
      followTarget: route.followTarget, enabled: !!options.getValue("EnableNavigation"), paused: route.paused, blockedBy: null, finished: false, dirty, generation: gen,
    }),
    addHere(type, fields, { mode, selected }) {
      const p = { type, ew: player.ew, ns: player.ns, z: 0.06 };
      if (type === 3) p.pauseMs = Math.max(0, Number(fields.seconds || 0)) * 1000;
      if (type === 4) p.chat = String(fields.chat || "");
      if (type === 2) p.spellId = fields.spellId;
      if (type === 5 || type === 6 || type === 7) p.name = fields.name || (selectedWorld ? objName(selectedWorld) : "?");
      if (type === 9) Object.assign(p, { headingDeg: fields.headingDeg ?? 90, holdShift: !!fields.holdShift, delayMs: fields.delayMs || 0, ext: { direction: fields.direction } });
      if (route.routeType === 3) {
        route = { ...route, followTarget: { guid: selectedWorld, name: objName(selectedWorld) } };
        return { ok: true, follow: route.followTarget };
      }
      const points = route.points.slice();
      const i = insertAt(mode, selected, points.length);
      points.splice(i, 0, p);
      setRoute({ ...route, points });
      return { ok: true, index: i };
    },
    setActive: (i) => ((route = { ...route, activeIndex: i }), { ok: true, index: i }),
    step: (d) => ((route = { ...route, activeIndex: (route.activeIndex + d + route.points.length) % Math.max(1, route.points.length) }), { ok: true }),
    removeAt: (i) => (setRoute({ ...route, points: route.points.filter((_, k) => k !== i), activeIndex: Math.min(route.activeIndex, Math.max(0, route.points.length - 2)) }), { ok: true }),
    setType: (t) => ((route = { ...route, routeType: Number(t) }), { ok: true, routeType: Number(t) }),
    reverse: (f) => ((route = { ...route, reversed: f === undefined ? !route.reversed : !!f, points: route.points.slice().reverse() }), route.reversed),
    setEnabled: (on) => options.set("EnableNavigation", !!on, { source: "ui" }),
    resume: () => ((route = { ...route, paused: null }), { ok: true }),
    clear: () => (setRoute({ ...route, points: [], activeIndex: 0 }), { ok: true }),
    updatePoint: (i, patch) => {
      const points = route.points.slice();
      points[i] = { ...points[i], ...patch };
      setRoute({ ...route, points });
      return { ok: true };
    },
    save: (n) => (navStore.set(n, { routeType: route.routeType, points: clone(route.points) }), (dirty = false), options.setRef?.("navProfile", n), { ok: true }),
    loadByName: (n) => {
      const r = navStore.get(n);
      if (!r) return { ok: false, error: `no route named "${n}"` };
      route = { name: n, ...clone(r), activeIndex: 0, reversed: false, followTarget: null, paused: null };
      dirty = false;
      options.setRef?.("navProfile", n);
      return { ok: true };
    },
  };
  options.setRef?.("navProfile", "loop");

  const objName = (g) => ({ 0x80001234: "Drudge Skulker", 0x7a001: "Holtburg Outpost Portal", 0x7104: "Heavy Axe", 0x7105: "Healing Kit", 0x7001: "Kite Shield", 0x7002: "Buckler", 0x7003: "Fire Baton", 0x7006: "Acid Spear" })[g] ?? null;
  const inventory = [
    { guid: 0x7104, name: "Heavy Axe", wcid: 301, itemType: 1 },
    { guid: 0x7105, name: "Healing Kit", wcid: 628, itemType: 128 },
  ];
  let consumables = [
    { guid: 0x6001, name: "Healing Kit", wcid: 628, type: "HealthKit" },
    { guid: 0x6002, name: "Stamina Elixir", wcid: 2457, type: "StaminaPotion" },
    { guid: 0x6003, name: "Mana Stone", wcid: 2434, type: "ManaStone" },
    { guid: 0x6004, name: "Granite Pea", wcid: 8897, type: "PeaComponent", keepAtLeast: 20, toolGuid: 0x6010 },
    { guid: 0x6005, name: "Honeyed Mead", wcid: 4746, type: "BuffItem", durationS: 3600 },
  ];

  const metaRules = [
    { id: "r1", state: "Default", enabled: true, cond: { t: "Death" }, act: { t: "SetState", state: "dead" } },
    { id: "r2", state: "Default", enabled: true, cond: { t: "MainSlotsLE", n: 2 }, act: { t: "CallState", state: "sell", ret: "Default" } },
    { id: "r3", state: "Default", enabled: true, cond: { t: "Not", children: [{ t: "NoMobsInDist", dist: 30 }] }, act: { t: "None" } },
    { id: "r4", state: "dead", enabled: true, cond: { t: "Always" }, act: { t: "DoAll", children: [{ t: "Chat", text: "/vt nav load runback" }, { t: "Chat", text: "/vt opt set enablebuffing true" }] } },
    { id: "r5", state: "dead", enabled: true, cond: { t: "NavEmpty" }, act: { t: "SetState", state: "Default" } },
    { id: "r6", state: "sell", enabled: false, cond: { t: "VendorOpen" }, act: { t: "Chat", text: "/ub autosell" } },
  ];
  let metaState = "Default";
  let metaCur = { v: 1, name: "hunt", source: { kind: "json" }, rules: clone(metaRules), navs: {}, warnings: [] };
  const lootStore = new Map([["salvage", { version: 1, rules: [{ name: "Keep pyreals", enabled: true, priority: 0, action: "Keep", conditions: [{ type: 2, typeName: "StringValueMatch", data: ["Pyreal", "Name"] }] }] }], ["basic", { version: 1, rules: [] }]]);
  let lootCurrent = "salvage";

  const vt = {
    options,
    session,
    items: {
      list: () => options.getList("items") || [],
      find: (g) => (options.getList("items") || []).find((e) => e.guid === g) || null,
      classify: (row) => (/axe|sword|spear|baton|wand|shield|bow/i.test(row.name) ? (/shield/i.test(row.name) ? "shield" : /baton|wand/i.test(row.name) ? "caster" : "melee") : null),
      add: (e) => {
        const row = inventory.find((i) => i.guid === e.guid || i.name.toLowerCase() === String(e.name || "").toLowerCase());
        if (!row) return { ok: false, error: "not in your inventory" };
        const list = options.getList("items") || [];
        if (list.some((x) => x.guid === row.guid)) return { ok: false, error: `${row.name} is already on the Items list` };
        const entry = { guid: row.guid, name: row.name, wcid: row.wcid, kind: e.kind || "melee", element: null, noBuffs: !!e.noBuffs };
        options.setList("items", [...list, entry], { source: "ui" });
        return { ok: true, entry };
      },
      update: (g, p) => {
        options.setList("items", (options.getList("items") || []).map((e) => (e.guid === g ? { ...e, ...p } : e)), { source: "ui" });
        return { ok: true };
      },
      remove: (g) => (options.setList("items", (options.getList("items") || []).filter((e) => e.guid !== g), { source: "ui" }), { ok: true }),
      resolveGuid: (e) => (e.guid === 0x7002 ? 0 : e.guid),
    },
    consumables: {
      list: () => clone(consumables),
      add: (e) => {
        const row = inventory.find((i) => i.guid === e.guid || i.name.toLowerCase() === String(e.name || "").toLowerCase());
        if (!row) return { ok: false, error: "not in your inventory" };
        const entry = { guid: row.guid, name: row.name, wcid: row.wcid, type: e.type || "HealthKit" };
        consumables = [...consumables, entry];
        return { ok: true, entry };
      },
      update: (g, p) => ((consumables = consumables.map((e) => (e.guid === g ? { ...e, ...p } : e))), { ok: true }),
      remove: (g) => ((consumables = consumables.filter((e) => e.guid !== g)), { ok: true }),
    },
    monsters: {
      resolve: (g) => {
        const list = options.getList("monsters") || [];
        const name = objName(g);
        const i = list.findIndex((e, k) => k > 0 && name && String(e.text).toLowerCase() === name.toLowerCase());
        return i > 0 ? { entry: list[i], index: i } : { entry: list[0] || null, index: 0 };
      },
    },
    nav,
    navProfiles: {
      list: () => [...navStore.keys()].map((name) => ({ name, savedAt: 0 })),
      remove: (n) => (navStore.delete(n), { ok: true }),
      importText: (n, text) => (navStore.set(n, { routeType: 1, points: [P(0, 0, 0)] }), { ok: true, warnings: text ? [] : ["empty file"] }),
      exportText: (n) => (navStore.has(n) ? { ok: true, text: `uTank2 NAV 1.2\n1\n${navStore.get(n).points.length}\n`, warnings: [] } : { ok: false, error: `no route ${n}` }),
    },
    meta: {
      meta: () => metaCur,
      replaceMeta: (m) => ((metaCur = clone(m)), { ok: true, warnings: [] }),
      load: () => ({ ok: true }),
      get enabled() { return !!options.getValue("EnableMeta"); },
      set enabled(v) { options.set("EnableMeta", !!v, { source: "meta" }); },
      setDebug() {},
      enterState: (s) => ((metaState = s), true),
      snapshot: () => ({
        enabled: !!options.getValue("EnableMeta"), running: !held, name: metaCur.name, loaded: true, state: metaState, secondsInState: Math.floor((Date.now() / 1000) % 600),
        secondsInStateP: Math.floor((Date.now() / 1000) % 1800), stackDepth: 0, stack: [], ruleCount: metaCur.rules.length, states: ["Default", "dead", "sell"],
        fired: metaState === "Default" ? ["r3"] : [], watchdog: null, lastFired: { ruleId: "r3" }, lastError: null, debug: false,
      }),
    },
    library: {
      listMetas: () => [{ name: "hunt" }, { name: "colo" }],
      loadMeta: () => ({ ok: true }),
      saveMeta: () => ({ ok: true }),
      exportMeta: (n, kind) => ({ ok: true, data: kind === "met" ? new Uint8Array([0]) : "STATE: {Default}", warnings: [] }),
      importMeta: () => ({ ok: true, warnings: [] }),
      listLoot: () => [...lootStore.keys()].map((name) => ({ name })),
      lootNodeTypes: () => [
        { id: 0, name: "SpellNameMatch", arity: 1, label: "Spell name matches", fields: ["regex"] },
        { id: 2, name: "StringValueMatch", arity: 2, label: "String value matches", fields: ["regex", "property"] },
        { id: 5, name: "LongValKeyGE", arity: 2, label: "Int property ≥", fields: ["value", "property"] },
        { id: 7, name: "ObjectClass", arity: 1, label: "Object class", fields: ["class"] },
      ],
      getLoot: (n) => (lootStore.has(n) ? clone(lootStore.get(n)) : null),
      putLoot: (n, p) => (lootStore.set(n, clone(p)), { ok: true }),
      newLoot: () => ({ version: 1, rules: [] }),
      loadLoot: (n) => ((lootCurrent = n), options.setRef?.("lootProfile", n), { ok: true }),
      clearLoot: () => ((lootCurrent = null), options.setRef?.("lootProfile", null), { ok: true }),
      importLoot: (n) => (lootStore.set(n, { version: 1, rules: [] }), { ok: true, warnings: [] }),
      exportLoot: () => ({ ok: true, text: "UTL" }),
      removeLoot: (n) => (lootStore.delete(n), { ok: true }),
    },
    views: { renderer: null, list: () => [], setRenderer(r) { this.renderer = r; }, click: () => ({ ok: true }) },
    statusLine: () => `VT: ${metaState} · nav ${route.activeIndex + 1}/${route.points.length} ${({ 1: "circular", 2: "linear", 3: "follow", 4: "once" })[route.routeType]} · ${held ? "paused" : "hunting"}`,
    parseExpr: (t) => (/(&&|\|\||[<>=!]=?|[-+*/%#])\s*$/.test(t) ? { ok: false, error: "unexpected end of expression", pos: t.length } : { ok: true, dynamic: /\b(range|hasshield|setting_|metastate)\b/.test(t) }),
  };
  options.setRef?.("lootProfile", lootCurrent);

  // ── the host and the page globals ────────────────────────────────────────
  const remaining = new Map();
  for (const id of known) remaining.set(id, Math.random() < 0.08 ? null : Math.floor(200 + Math.random() * 5000));
  const vitals = { hp: [270, 360], st: [310, 420], mn: [380, 410] };
  const host = {
    TryGetObjectName: (g) => objName(g),
    TryGetKnownSpells: () => known,
    TryGetSpellRecord: (id) => {
      const s = spells[String(id)];
      return s ? { id, name: s.name, school: s.school, duration: s.duration } : null;
    },
    TryGetPlayerPose: () => poseAt(player.ew, player.ns),
    GetSelectedItemId: () => selectedItem,
    GetSelectedId: () => selectedWorld,
    TryGetPlayerInventory: () => inventory,
    TryGetSelfEnchantments: () => {
      const out = [];
      for (const [id, rem] of remaining) {
        const row = ladder[String(id)];
        if (rem != null && row) out.push({ spellId: id, family: row[0], remainingS: rem });
      }
      return out;
    },
  };
  const bot = {
    vt,
    host,
    get kernel() { return { operatorHeld: held }; },
    combat: { locked: 0 },
    buff: { forceRebuff() {}, cancelForceRebuff() {} },
    control: { stop: () => ((held = true), { ok: true }), resume: () => ((held = false), { ok: true }), isStopped: () => held },
  };
  win.__bot = bot;
  win.__sessionHandle = {
    playerStats: () => ({ vitals: [1, vitals.hp[0], 0, vitals.hp[1], 3, vitals.st[0], 0, vitals.st[1], 5, vitals.mn[0], 0, vitals.mn[1]], skills: [], free() {} }),
    playerKnownSpells: () => known,
    objectName: (g) => objName(g),
  };
  win.__rynthVt = { version: 1, session: () => session };

  // once a second: timers run down, vitals and the player drift
  const drift = (v, lo, hi, step) => Math.max(lo, Math.min(hi, v + (Math.random() - 0.5) * step));
  const timer = setInterval(() => {
    for (const [id, rem] of remaining) if (rem != null) remaining.set(id, Math.max(0, rem - 1));
    vitals.hp[0] = drift(vitals.hp[0], 90, vitals.hp[1], 40);
    vitals.st[0] = drift(vitals.st[0], 60, vitals.st[1], 50);
    vitals.mn[0] = drift(vitals.mn[0], 80, vitals.mn[1], 30);
    player = { ew: drift(player.ew, HOLTBURG.ew - 0.1, HOLTBURG.ew + 0.3, 0.01), ns: drift(player.ns, HOLTBURG.ns - 0.25, HOLTBURG.ns + 0.1, 0.01) };
  }, 1000);

  return {
    bot,
    select: ({ world, item } = {}) => {
      if (world !== undefined) selectedWorld = world;
      if (item !== undefined) selectedItem = item;
    },
    dispose: () => clearInterval(timer),
  };
}
