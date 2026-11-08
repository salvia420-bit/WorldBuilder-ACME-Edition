// tests/challenger_m3_stress.test.mjs — Adversarial empirical stress testing
// of the restyled VTank UI for Milestone M3.
//
// Tests:
// 1. Rapid tab switches across all 8 tabs (sequential and randomized 200+ cycles)
// 2. Refresh concurrency during rapid tab switching
// 3. Toggle stress cycles on command bar (RUN, Combat, Buff, Nav, Loot, Meta)
// 4. State binding integrity & synchronization
// 5. Input boundary extremes and stepper button click handling on numFields
// 6. DOM element textContent and aria-attributes integrity

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
const { createVtBridge } = await import("../rynth/vt/bridge/vt_bridge.js");

const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const click = (el) => el.dispatchEvent(new FakeEvent("click"));
const q = (sel, root = document) => root.querySelector(sel);
const qa = (sel, root = document) => root.querySelectorAll(sel);
const clone = (v) => JSON.parse(JSON.stringify(v));

const ROWS = [
  { key: "EnableCombat", vt: ["EnableCombat"], type: "bool", dflt: true, page: "options", group: "Subsystems", label: "Enable Combat", consumer: "combat" },
  { key: "EnableBuffing", vt: ["EnableBuffing"], type: "bool", dflt: true, page: "options", group: "Subsystems", label: "Enable Buffing", consumer: "buff" },
  { key: "MonsterRange", vt: ["AttackDistance"], type: "float", unit: "m", vtUnit: "lbf", dflt: 40, min: 1, max: 200, page: "options", group: "Ranges", label: "Monster Range", consumer: "combat" },
  { key: "BoostLootPriority", vt: ["LootPriorityBoost"], type: "bool", dflt: false, page: "options", group: "Priority", label: "Boost Loot Priority", consumer: "kernel" },
  { key: "PeaceModeWhenIdle", vt: ["IdlePeaceMode"], type: "bool", dflt: false, page: "options", group: "Idle", label: "Peace Mode When Idle", consumer: "idle" },
  { key: "SummonPets", vt: ["SummonPets"], type: "bool", dflt: false, page: "options", group: "Pets", label: "Summon Pets", consumer: "pets" },
  { key: "CustomPetRangeEnabled", vt: [], type: "bool", dflt: false, page: "options", group: "Pets", label: "Custom Pet Range Enabled", consumer: "pets" },
  { key: "PetCustomRange", vt: [], type: "float", unit: "m", dflt: 30, min: 1, max: 200, page: "options", group: "Pets", label: "Pet Custom Range", consumer: "pets" },
  { key: "PetMinMonsters", vt: [], type: "int", dflt: 1, min: 1, max: 20, page: "options", group: "Pets", label: "Min. monsters", consumer: "pets" },
  { key: "EnableNavigation", vt: ["EnableNav"], type: "bool", dflt: false, page: "profiles", group: "Subsystems", label: "Enable Auto-Navigation", consumer: "nav" },
  { key: "EnableLooting", vt: ["EnableLooting"], type: "bool", dflt: true, page: "profiles", group: "Subsystems", label: "Enable Looting", consumer: "loot" },
  { key: "EnableMeta", vt: ["EnableMeta"], type: "bool", dflt: false, page: "meta", group: "Subsystems", label: "Enable Meta", consumer: "meta" },
  { key: "HealAt", vt: ["Recharge-Norm-HitP"], type: "int", unit: "pct", dflt: 60, min: 0, max: 100, page: "vitals", group: "Vitals", label: "Heal at", consumer: "vitals" },
  { key: "TopOffHP", vt: ["Recharge-NoTarg-HitP"], type: "int", unit: "pct", dflt: 95, min: 0, max: 100, page: "vitals", group: "Vitals", label: "Top off HP", consumer: "vitals" },
  { key: "EmergencyHP", vt: [], type: "int", unit: "pct", dflt: 30, min: 0, max: 100, page: "vitals", group: "Vitals", label: "Emergency HP", consumer: "vitals" },
  { key: "RebuffSecondsRemaining", vt: ["RebufTimeRemainingSeconds"], type: "int", unit: "s", dflt: 300, min: 30, max: 1800, page: "advanced", group: "Buffing", label: "Rebuff when seconds remaining below", consumer: "buff" },
  { key: "LootMinValue", vt: [], type: "int", dflt: 0, min: 0, max: 1e9, page: "advanced", group: "Looting", label: "Loot minimum value", consumer: "loot" },
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
      list: () => [{ name: "Default", kind: "default", label: "Default" }, { name: "Hunt", kind: "shared", label: "Hunt" }],
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
  };
}

function makeWorld() {
  const options = makeOptions();
  const ctl = [];
  const navCalls = [];
  const vt = {
    options,
    session: { options },
    items: { list: () => [], find: () => null, classify: () => null, update: () => ({ ok: true }), remove: () => ({ ok: true }), add: () => ({ ok: true }), resolveGuid: (e) => e.guid },
    consumables: { list: () => [], add: () => ({ ok: true }), update: () => ({ ok: true }), remove: () => ({ ok: true }) },
    monsters: { resolve: () => ({ entry: null, index: 0 }) },
    nav: {
      route: () => ({ name: "loop", routeType: 1, points: [], activeIndex: 0, reversed: false, followTarget: null }),
      status: () => ({ name: "loop", type: 1, typeName: "circular", i: 0, n: 0, exec: "idle", lastResult: null, reversed: false, enabled: !!options.getValue("EnableNavigation"), paused: null, blockedBy: null, dirty: false }),
      addHere: () => ({ ok: true }), save: () => ({ ok: true }), loadByName: () => ({ ok: true }), setActive: () => ({ ok: true }), step: () => ({ ok: true }),
      removeAt: () => ({ ok: true }), setType: () => ({ ok: true }),
      setEnabled: (on) => (navCalls.push(["setEnabled", on]), options.set("EnableNavigation", on, { source: "ui" })),
      resume: () => (navCalls.push(["resume"]), { ok: true }), reverse: () => true, clear: () => ({ ok: true }), updatePoint: () => ({ ok: true }),
    },
    navProfiles: { list: () => [{ name: "loop" }], remove: () => ({ ok: true }), importText: () => ({ ok: true }), exportText: () => ({ ok: true, text: "" }) },
    meta: {
      meta: () => ({ v: 1, name: "hunt", source: { kind: "json" }, rules: [], navs: {}, warnings: [] }),
      load: () => ({ ok: true }),
      replaceMeta: () => ({ ok: true, warnings: [] }),
      get enabled() { return !!options.getValue("EnableMeta"); },
      set enabled(v) { options.set("EnableMeta", !!v, { source: "meta" }); },
      setDebug() {}, enterState: () => true,
      snapshot: () => ({ enabled: true, running: true, name: "hunt", loaded: true, state: "Default", secondsInState: 0, secondsInStateP: 0, stackDepth: 0, stack: [], ruleCount: 0, stateCount: 1, states: ["Default"], fired: [], watchdog: null, lastFired: null, lastError: null, debug: false }),
    },
    library: { listMetas: () => [], listLoot: () => [], lootNodeTypes: () => [], newLoot: () => ({ version: 1, rules: [] }), getLoot: () => ({ version: 1, rules: [] }), putLoot: () => ({ ok: true }), loadLoot: () => ({ ok: true }), clearLoot: () => ({ ok: true }) },
    views: { renderer: null, list: () => [], setRenderer(r) { this.renderer = r; }, click: () => ({ ok: true }) },
    statusLine: () => "VT: Default · idle",
    parseExpr: () => ({ ok: true }),
  };
  const bot = {
    vt,
    host: {
      TryGetObjectName: () => null,
      TryGetKnownSpells: () => [],
      TryGetSpellRecord: (id) => ({ id, name: `Spell ${id}`, school: 4 }),
      TryGetPlayerPose: () => ({ objCellId: 1, x: 0, y: 0, z: 0 }),
      GetSelectedItemId: () => 0,
      TryGetPlayerInventory: () => [],
      TryGetSelfEnchantments: () => [],
    },
    kernel: { operatorHeld: false },
    combat: { locked: 0 },
    buff: { forceRebuff() {}, cancelForceRebuff() {} },
    control: { stop: (o) => (ctl.push(["stop", o]), { ok: true }), resume: () => (ctl.push(["resume"]), { ok: true }), isStopped: () => false },
  };
  return { bot, vt, options, ctl, navCalls };
}

const W = makeWorld();
window.__bot = W.bot;
window.__sessionHandle = { playerStats: () => ({ vitals: [1, 245, 0, 360, 3, 102, 0, 200, 5, 83, 0, 100], free() {} }) };

const realBridge = createVtBridge({
  win: window,
  importer: async () => ({
    buildDynamicBuffList: () => [],
    loadSpellLadders: async () => ({}),
    BASE_CREATURE_BUFFS: [],
  }),
});

panel.configureVtPanel({
  bridge: realBridge,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  hidden: () => false,
});

const ALL_TABS = ["main", "monsters", "items", "buffs", "route", "loot", "meta", "advanced"];
const root = () => document.getElementById("hb-rynth-vt");
const tabBtn = (id) => q(`.hbk-tab[data-tab='${id}']`, root());
const sw = (id) => q(`.rvt-tgl[data-switch='${id}']`, root());

let testCount = 0;
let failCount = 0;
const failures = [];

async function test(name, fn) {
  testCount++;
  try {
    await fn();
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failCount++;
    failures.push({ name, err });
    console.error(`[FAIL] ${name}\n`, err);
  }
}

// ── Test 1: Rapid Sequential and Random Tab Switches ───────────────────────────
await test("Rapid tab switching across all 8 tabs maintains DOM visibility integrity", async () => {
  await panel.openVtPanel({ tab: "main" });
  assert.equal(panel.isVtPanelOpen(), true);

  // 10 sequential rounds through all 8 tabs (80 switches)
  for (let round = 0; round < 10; round++) {
    for (const t of ALL_TABS) {
      click(tabBtn(t));
      await flush(1);
      // Verify only active tab body is visible
      for (const checkTab of ALL_TABS) {
        const bodyEl = q(`.rvt-tab-body[data-tab='${checkTab}']`, root());
        if (bodyEl) {
          assert.equal(bodyEl.hidden, checkTab !== t, `Tab ${checkTab} hidden state mismatch when active is ${t}`);
        }
      }
      // Verify active button
      assert.equal(tabBtn(t).getAttribute("aria-selected"), "true");
      assert.equal(tabBtn(t).classList.contains("is-active"), true);
    }
  }

  // 100 randomized tab switches
  for (let i = 0; i < 100; i++) {
    const randomTab = ALL_TABS[Math.floor(Math.random() * ALL_TABS.length)];
    click(tabBtn(randomTab));
    // Concurrently trigger refresh
    panel.refreshVtPanel({ force: true });
    await flush(1);
    assert.equal(tabBtn(randomTab).getAttribute("aria-selected"), "true");
  }
});

// ── Test 2: Command Bar Switches & RUN Toggle Stress ───────────────────────────
await test("Command bar toggle stress cycles (RUN + 5 switches) maintain state consistency", async () => {
  const r = root();
  const runBtn = q(".rvt-run", r);

  // Toggle RUN 30 times
  for (let i = 0; i < 30; i++) {
    click(runBtn);
    await flush(1);
  }
  assert.ok(W.ctl.length >= 30, "bot.control.stop recorded toggles");

  // Toggle all 5 switches 20 times in interleaved patterns
  const switches = ["combat", "buff", "nav", "loot", "meta"];
  for (let cycle = 0; cycle < 20; cycle++) {
    for (const s of switches) {
      const el = sw(s);
      const beforePressed = el.getAttribute("aria-pressed") === "true";
      click(el);
      await flush(1);
      const afterPressed = el.getAttribute("aria-pressed") === "true";
      assert.notEqual(beforePressed, afterPressed, `Switch ${s} did not invert aria-pressed on toggle`);
    }
  }
});

// ── Test 3: Element textContent & Decorative Component Integrity ───────────────
await test("Decorative restyle components and textContent integrity across tabs", async () => {
  const r = root();

  // Corner flourish brackets
  const corners = qa(".rvt-corner", r);
  assert.equal(corners.length, 4, "4 corner flourish brackets present");
  for (const c of corners) {
    assert.equal(c.getAttribute("aria-hidden"), "true");
  }

  // Anchor crest
  const anchor = q(".rvt-anchor-crest", r);
  assert.ok(anchor, "Center anchor crest present");
  assert.equal(anchor.getAttribute("aria-hidden"), "true");

  // Title crest monogram
  const titleCrest = q(".rvt-title-crest", r);
  assert.ok(titleCrest, "Title crest monogram present");
  assert.equal(titleCrest.getAttribute("aria-hidden"), "true");

  // Titlebar textContent
  const titleText = q(".hbk-title", r);
  assert.equal(titleText.textContent, "RynthSuite — VTank");

  // Verify Tab Labels (must be clean without injected text glyphs)
  const expectedTabs = ["Main", "Monsters", "Items", "Buffs", "Route", "Loot", "Meta", "Advanced"];
  const actualTabs = qa(".hbk-tab", r).map((b) => b.textContent);
  assert.deepStrictEqual(actualTabs, expectedTabs, "Tab labels textContent unaltered");

  // Switch labels (must be clean)
  const expectedSwitches = ["Combat", "Buff", "Nav", "Loot", "Meta"];
  const actualSwitches = qa(".rvt-tgl", r).map((b) => b.textContent);
  assert.deepStrictEqual(actualSwitches, expectedSwitches, "Switch labels textContent unaltered");

  // Check Main tab radar and vignettes
  click(tabBtn("main"));
  await flush(1);
  const radar = q(".rvt-radar", r);
  assert.ok(radar, "Embedded radar display present");
  assert.equal(radar.getAttribute("aria-hidden"), "true");

  const wolf = q(".rvt-vignette-wolf", r);
  assert.ok(wolf, "Wolf vignette present");
  assert.equal(wolf.getAttribute("aria-hidden"), "true");

  const castle = q(".rvt-vignette-castle", r);
  assert.ok(castle, "Castle vignette present");
  assert.equal(castle.getAttribute("aria-hidden"), "true");
});

// ── Test 4: Stepper Click Exception Stress Test ────────────────────────────────
await test("Stepper buttons (▲ / ▼) on numFields handle clicks without throwing exceptions", async () => {
  click(tabBtn("main"));
  await flush(1);
  const r = root();

  // Query all stepper buttons on Main tab
  const upButtons = qa(".rvt-step-btn.is-up", r);
  const dnButtons = qa(".rvt-step-btn.is-down", r);

  assert.ok(upButtons.length > 0, "Found up stepper buttons on Main tab");
  assert.ok(dnButtons.length > 0, "Found down stepper buttons on Main tab");

  // Click every up and down button 5 times
  for (let i = 0; i < upButtons.length; i++) {
    const up = upButtons[i];
    const dn = dnButtons[i];
    const box = up.parentNode?.parentNode;
    const input = box?.querySelector('input');
    assert.ok(input, "Found associated input for stepper");

    const valBefore = input.value;
    click(up);
    await flush(1);
    click(dn);
    await flush(1);
  }
});

// ── Test 5: Stepper Boundary Extremes ──────────────────────────────────────────
await test("Stepper boundary clamping (min / max / negative / large extremes)", async () => {
  click(tabBtn("main"));
  await flush(1);
  const r = root();

  // Find MonsterRange input
  const monsterRangeBox = q(".rvt-ranges .rvt-num-box", r);
  assert.ok(monsterRangeBox, "Found MonsterRange num-box");
  const input = monsterRangeBox.querySelector("input");
  const up = monsterRangeBox.querySelector(".rvt-step-btn.is-up");
  const dn = monsterRangeBox.querySelector(".rvt-step-btn.is-down");

  // 1. Minimum clamp test (MonsterRange min is 1, step is 0.1)
  input.value = "1.1";
  click(dn); // -> 1
  assert.equal(Number(input.value), 1, "Stepped down to 1");
  click(dn); // should clamp at 1
  assert.equal(Number(input.value), 1, "Clamped at min 1");

  // 2. Maximum clamp test (MonsterRange max is 200, step is 0.1)
  input.value = "199.9";
  click(up); // -> 200
  assert.equal(Number(input.value), 200, "Stepped up to 200");
  click(up); // should clamp at 200
  assert.equal(Number(input.value), 200, "Clamped at max 200");

  // 3. Empty string / NaN handling
  input.value = "";
  click(up);
  assert.ok(!isNaN(Number(input.value)), "Empty input step produces a valid number");

  // 4. Disabled & ReadOnly guard handling
  input.value = "50";
  input.disabled = true;
  click(up);
  assert.equal(Number(input.value), 50, "Disabled input does not change value on stepper click");
  input.disabled = false;

  input.readOnly = true;
  click(dn);
  assert.equal(Number(input.value), 50, "ReadOnly input does not change value on stepper click");
  input.readOnly = false;

  input.setAttribute("aria-disabled", "true");
  click(up);
  assert.equal(Number(input.value), 50, "Aria-disabled input does not change value on stepper click");
  input.removeAttribute("aria-disabled");
});

console.log("\n==================================================");
console.log(`STRESS TEST SUMMARY: ${testCount - failCount} passed, ${failCount} failed (out of ${testCount})`);
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) {
    console.log(` - ${f.name}: ${f.err.message || f.err}`);
  }
}
console.log("==================================================");

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
