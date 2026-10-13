// tests/rynth_vt_hud_integration.test.mjs — PLAN INT-3 (§4.5 rules 5-6, §5
// rows for rynth/hud_bridge.js and plugins/rynth-hud.js; P2, P7, D20, V-17,
// V-21): the RynthSuite HUD's hooks into the VTank layer.
//
// Part A — rynth/hud_bridge.js against fake bots, the REAL
// rynth/ai/operator_stop.js and the REAL rynth/vt/rs_entry.js page provider:
//   • no provider: start()/restart(), the setters, the Nav toggle and the HUD
//     "stop moving" behave exactly as before;
//   • a Default-profile provider: the same boot overrides; HUD edits land in
//     the page session's Default overlay (never in storage);
//   • a USER profile: start()/restart() boot with hudBootOverrides() (+ the
//     HUD persona), which boot.js applyHudOverrides accepts; the setters call
//     noteLegacyEdit(field, the blob field's new full value) and the profile
//     saves at once;
//   • a loaded VTank route: the Nav toggle drives bot.vt.nav (EnableNavigation
//     + resume), "stop moving" leaves it paused until Nav is clicked again;
//   • vm.vt is the layer's status line; openVt opens the VTank panel.
// Part B — plugins/rynth-hud.js on the fake DOM (tests/helpers/
// social_fake_dom.mjs): the VT button sits LAST in the selectors row (the
// pins of tests/rynth_hud_dom.test.mjs still hold: 6 `.rhud-tgl`, 5 launcher
// buttons, the 4 titlebar buttons, `.rhud-selectors input` = loot floor,
// `select[1]` = route), mount installs window.__rynthVt lazily (the real
// rs_entry.js), the VT button opens the REAL VTank panel, a persisted open
// panel reopens on mount, and dispose removes everything — the panel too.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_hud_integration.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

function memStorage() {
  const m = new Map();
  const writes = [];
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { writes.push(k); m.set(k, String(v)); },
    removeItem: (k) => { writes.push(k); m.delete(k); },
    _m: m,
    writes,
  };
}
// operator_stop.js falls back to globalThis.localStorage.
globalThis.localStorage = memStorage();

const bridgeMod = await import("../rynth/hud_bridge.js");
const opStop = await import("../rynth/ai/operator_stop.js");
const boot = await import("../rynth/boot.js");
const RS = await import("../rynth/vt/rs_entry.js");
const SET = await import("../rynth/vt/settings/index.js");
const { buildViewModel, createHudBridge } = bridgeMod;

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
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await tick(5);
  }
  return true;
}
const quiet = () => {};
const NOW = 1_800_000_000_000;
const ME = 0x50000001;

// ── fakes (shaped like tests/rynth_hud_bridge.test.mjs) ─────────────────────
function fakeHandle({ guid = ME } = {}) {
  return {
    isPlayerReady: () => true,
    playerGuid: () => guid,
    playerStats: () => ({ vitals: [1, 75, 100, 150, 3, 180, 200, 200, 5, 40, 90, 120] }),
    objectName: () => null,
    objectHealthFraction: () => -1,
    playerKnownSpells: () => [2, 24],
  };
}
function fakeBot({ guid = ME, vt = undefined } = {}) {
  const calls = [];
  const combat = { enabled: true, priorities: { olthoi: 10 }, locked: 0, kills: 0 };
  const loot = { enabled: true, minValue: 0, state: "SCAN", lootedCount: 0 };
  const buff = { enabled: true, pending: null, status: { ready: true, desired: 1, active: 1, pending: 0 } };
  const vitals = { cfg: { healAtCombat: 60, getManaAtCombat: 40, restamAtCombat: 30, emergencyHp: 30, topOffHp: 95, topOffStam: 95, topOffMana: 95 } };
  const kernel = {
    action: "Idle", running: true, operatorHeld: false, combat, loot, buff, vitals,
    start() { if (this.operatorHeld) return false; this.running = true; return true; },
    stop() { this.running = false; },
    holdForOperator() { this.operatorHeld = true; this.stop(); },
    releaseOperatorHold() { this.operatorHeld = false; },
    get status() { return { action: this.action, running: this.running, operatorHeld: this.operatorHeld, kills: 0, looted: 0, buffs: buff.status, combat: { locked: 0, mode: 1 } }; },
  };
  const router = { status: { state: "IDLE" }, cancel() { calls.push("router.cancel"); this.status = { state: "IDLE" }; } };
  const bot = {
    host: { GetPlayerId: () => guid, TryGetObjectName: () => null, StopStick: () => calls.push("StopStick"), StopCompletely: () => calls.push("StopCompletely") },
    kernel, combat, loot, buff, vitals, router,
    globalRouter: { busy: false },
    unwedge: null,
    startedAt: NOW - 60_000,
    mission: null,
    followRoute: async (legs, o) => { calls.push(["followRoute", legs.length, o.label]); return { ok: true }; },
    calls,
  };
  if (vt !== undefined) bot.vt = vt;
  return bot;
}
/** A VTank ActiveNav stand-in (the members hud_bridge / operator_stop read). */
function fakeNav({ route = true } = {}) {
  const calls = [];
  return {
    calls,
    _enabled: false,
    paused: null,
    get enabled() { return this._enabled; },
    set enabled(v) { calls.push(["enabled", !!v]); this._enabled = !!v; },
    hasRoute() { return route; },
    resume() { calls.push("resume"); this.paused = null; return { ok: true }; },
    pause(reason) { calls.push(["pause", reason]); this.paused = { reason, at: NOW }; return { ok: true }; },
    ownsRouterWalk() { return false; },
  };
}
const ATLAS_ROUTE = { id: "r1", name: "Holtburg loop", legs: [{ lb: 1 }, { lb: 1 }] };
class Atlas { listRoutes() { return [ATLAS_ROUTE]; } getRoute(k) { return k === "r1" ? ATLAS_ROUTE : null; } }

function env(win, extra = {}) {
  const importer = async (url) => {
    if (url.endsWith("rynth/ai/operator_stop.js")) return opStop;
    if (url.endsWith("rynth/boot.js")) return extra.boot;
    if (url.endsWith("rynth/atlas.js")) return { Atlas };
    if (url.endsWith("rynth/vt/rs_entry.js")) {
      if (extra.rsEntry) return extra.rsEntry;
      throw new Error("no VTank layer on this page");
    }
    throw new Error(`unexpected import ${url}`);
  };
  return { win, storage: extra.storage ?? memStorage(), now: () => NOW, importer, moduleUrl: (rel) => `http://h/apps/holtburger-web/${rel}`, fetchJson: async () => ({ spells: {} }) };
}
/** A boot.js stand-in recording what bootBotFromHud received. */
function recordingBoot(makeNext = () => fakeBot()) {
  const seen = [];
  return {
    seen,
    bootBotFromHud: async (h, overrides, opts) => {
      seen.push(JSON.parse(JSON.stringify(overrides)));
      const nb = makeNext();
      opts.win.__bot = nb;
      return nb;
    },
  };
}
/** HUD blob edits every test starts from (no bot ⇒ saved for the next start). */
async function seedBlob(br) {
  assert.equal(br.setPriority("olthoi", 12).ok, true);
  assert.equal(br.setLootMin(100).ok, true);
  assert.equal((await br.setBuffs([2])).ok, true);
}
const BLOB_OVERRIDES = { buffs: [2], priorities: { olthoi: 12 }, lootMin: 100 };

// ═══════════════════════════ Part A — the bridge ═══════════════════════════

await check("no provider: START / Restart boot with exactly the HUD blob overrides; the view model has no VT fields set", async () => {
  const win = { __sessionHandle: fakeHandle() };
  const b = recordingBoot();
  const br = createHudBridge(env(win, { boot: b }));
  await seedBlob(br);
  assert.equal((await br.start()).ok, true);
  assert.equal((await br.restart()).ok, true);
  assert.deepEqual(b.seen, [BLOB_OVERRIDES, BLOB_OVERRIDES]);
  const vm = br.snapshot();
  assert.equal(vm.vt, null);
  assert.equal(vm.toggles.nav.vtRoute, false);
  assert.equal(vm.toggles.nav.on, false);
});

await check("no provider: the Nav toggle is the legacy atlas follow / cancel; HUD 'stop moving' → OperatorControl.cancelTravel", async () => {
  const bot = fakeBot();
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  br.selectRoute("r1");
  assert.equal((await br.setSubsystem("nav", true)).ok, true);
  await tick();
  assert.deepEqual(bot.calls.find((c) => Array.isArray(c) && c[0] === "followRoute"), ["followRoute", 2, "Holtburg loop"]);
  bot.calls.length = 0;
  assert.equal((await br.setSubsystem("nav", false)).ok, true);
  assert.ok(bot.calls.includes("router.cancel") && bot.calls.includes("StopCompletely"), JSON.stringify(bot.calls));
  bot.calls.length = 0;
  assert.equal((await br.cancelTravel()).ok, true);
  assert.ok(bot.calls.includes("router.cancel"));
  // a bot WITH a layer but no loaded route: still the legacy path
  const nav = fakeNav({ route: false });
  const bot2 = fakeBot({ vt: { nav, statusLine: () => "VT · profile Default" } });
  const br2 = createHudBridge(env({ __bot: bot2, __sessionHandle: fakeHandle() }));
  br2.selectRoute("r1");
  await br2.setSubsystem("nav", true);
  await tick();
  assert.ok(bot2.calls.some((c) => Array.isArray(c) && c[0] === "followRoute"), "no VT route ⇒ the atlas follow");
  assert.deepEqual(nav.calls, [], "VT nav untouched");
});

await check("Default-profile provider (real rs_entry + page session): same boot overrides; HUD edits land in the Default overlay, storage untouched", async () => {
  const vtStorage = memStorage();
  const win = { __sessionHandle: fakeHandle({ guid: 0x50000011 }), localStorage: vtStorage };
  const api = RS.installRsEntry(win);
  const b = recordingBoot();
  const br = createHudBridge(env(win, { boot: b }));
  await seedBlob(br);
  assert.equal(br.setVitalsThreshold("topOffHp", 88).ok, true);
  assert.equal((await br.start()).ok, true);
  assert.deepEqual(b.seen[0], { ...BLOB_OVERRIDES, vitals: { topOffHp: 88 } }, "Default ⇒ botOverrides()");
  const s = api.session(String(0x50000011));
  assert.ok(s, "the character's page session");
  assert.equal(s.profiles.isUserProfileActive(), false);
  assert.equal(s.options.storedValue("LootMinValue"), 100, "loot floor noted");
  assert.equal(s.options.storedValue("TopOffHP"), 88, "vitals noted");
  assert.deepEqual(s.options.getList("legacyPriorities"), { olthoi: 12 });
  assert.deepEqual(s.options.getList("buffs").spec, [2]);
  assert.deepEqual(vtStorage.writes, [], "Default is never written");
});

await check("user profile: START / Restart boot with hudBootOverrides() + the HUD persona (accepted by boot.js applyHudOverrides); edits save into the profile at once", async () => {
  const vtStorage = memStorage();
  const G = 0x50000022;
  const win = { __sessionHandle: fakeHandle({ guid: G }), localStorage: vtStorage };
  const api = RS.installRsEntry(win);
  const s = SET.getVtSession(win, String(G), { storage: vtStorage, log: quiet });
  assert.equal(s.options.saveAs("Hunter").ok, true);
  for (const [k, v] of [["HealAt", 70], ["LootMinValue", 5000]]) assert.equal(s.options.set(k, v, { source: "ui" }).ok, true, k);
  assert.equal(s.options.setList("legacyPriorities", { drudge: 9 }, { source: "ui" }).ok, true);
  assert.equal(s.options.setList("buffs", { spec: [24] }, { source: "ui" }).ok, true);
  const b = recordingBoot();
  const br = createHudBridge(env(win, { boot: b }));
  await seedBlob(br); // the HUD blob says olthoi 12 / loot 100 / buffs [2] …
  await br.setPersona("explorer");
  assert.equal((await br.start()).ok, true);
  const want = { buffs: [2], priorities: { olthoi: 12 }, lootMin: 100, vitals: { healAtCombat: 70 }, persona: "explorer" };
  // … and the blob edits above were noted into the ACTIVE profile (noteLegacyEdit), so the profile now carries them:
  assert.deepEqual(b.seen[0], want, "the profile's legacy values + the HUD persona");
  const cfg = boot.applyHudOverrides({}, b.seen[0], { hasAiKey: false });
  assert.deepEqual(cfg, { buffs: [2], priorities: { olthoi: 12 }, loot: { minValue: 100 }, vitals: { healAtCombat: 70 } }, "passes the boot validators");
  assert.equal((await br.restart()).ok, true);
  assert.deepEqual(b.seen[1], want, "Restart uses the same rule");
  // A profile value the HUD never edited stays the profile's (not the blob's):
  assert.equal(s.options.set("HealAt", 66, { source: "ui" }).ok, true);
  assert.equal(s.options.set("LootMinValue", 7000, { source: "ui" }).ok, true);
  await br.restart(); // a bot exists now (START would only resume it)
  assert.equal(b.seen[2].lootMin, 7000, "profile wins over the HUD blob (100)");
  assert.deepEqual(b.seen[2].vitals, { healAtCombat: 66 });
  // HUD edits under the user profile are saved immediately (G:48):
  win.__bot = null;
  assert.equal(br.setLootMin(250).ok, true);
  assert.equal(br.setVitalsThreshold("topOffHp", 90).ok, true);
  assert.equal(br.setPriority("mosswart", 4).ok, true);
  const key = vtStorage.writes.find((k) => /profile/.test(k) && /Hunter/.test(k));
  assert.ok(key, `the Hunter profile was written (${vtStorage.writes.join(", ")})`);
  const rec = JSON.parse(vtStorage.getItem(key));
  assert.equal(rec.settings.LootMinValue, 250);
  assert.equal(rec.settings.TopOffHP, 90);
  assert.deepEqual(rec.lists.legacyPriorities, { olthoi: 12, mosswart: 4 }, "the blob field's new full value");
  assert.equal(api.hudProvider(win.__sessionHandle).isUserProfileActive(), true);
});

await check("?botVt=off page + a USER profile: START / Restart boot with exactly the HUD blob overrides (V-1: no layer, today's HUD boot)", async () => {
  const vtStorage = memStorage();
  const G = 0x50000023;
  const win = {
    __sessionHandle: fakeHandle({ guid: G }),
    localStorage: vtStorage,
    location: { href: "http://h/apps/holtburger-web/index.html?botVt=off", search: "?botVt=off" },
  };
  const api = RS.installRsEntry(win);
  const s = SET.getVtSession(win, String(G), { storage: vtStorage, log: quiet });
  assert.equal(s.options.saveAs("Hunter2").ok, true);
  assert.equal(s.options.set("LootMinValue", 5000, { source: "ui" }).ok, true);
  assert.equal(s.options.set("HealAt", 70, { source: "ui" }).ok, true);
  assert.equal(api.hudProvider(win.__sessionHandle).isUserProfileActive(), true);
  // the boot stand-in carries the REAL URL reader bootBotFromHud uses
  const b = recordingBoot();
  b.readBotUrlParams = boot.readBotUrlParams;
  const br = createHudBridge(env(win, { boot: b }));
  await seedBlob(br);
  await br.setPersona("explorer");
  assert.equal((await br.start()).ok, true);
  assert.equal((await br.restart()).ok, true);
  const want = { ...BLOB_OVERRIDES, persona: "explorer" };
  assert.deepEqual(b.seen, [want, want], "the profile's LootMinValue 5000 / HealAt 70 never reach a no-layer boot");
  // the same page WITHOUT ?botVt=off boots with the profile (control)
  win.location = { href: "http://h/apps/holtburger-web/index.html", search: "" };
  assert.equal((await br.restart()).ok, true);
  assert.equal(b.seen[2].lootMin, 100, "the blob edit was noted into the profile (G:48)");
  assert.deepEqual(b.seen[2].vitals, { healAtCombat: 70 }, "…and the profile's own HealAt rides the boot");
});

await check("setters call noteLegacyEdit(field, the blob field's NEW full value) after their own write; bad input → no call; results unchanged", async () => {
  const notes = [];
  const liveAtNote = [];
  const bot = fakeBot();
  const provider = {
    isUserProfileActive: () => false,
    hudBootOverrides: () => null,
    noteLegacyEdit: (f, v) => {
      notes.push([f, JSON.parse(JSON.stringify(v))]);
      // what a bound VT cell would read at this moment (the profile saves it)
      liveAtNote.push(JSON.parse(JSON.stringify({ priorities: bot.combat.priorities, lootMin: bot.loot.minValue, vitals: bot.vitals.cfg })));
      return { ok: true };
    },
  };
  const win = { __sessionHandle: fakeHandle(), __rynthVt: { version: 1, hudProvider: () => provider } };
  win.__bot = bot;
  const br = createHudBridge(env(win));
  assert.deepEqual(br.setPriority("Drudge", 7), { ok: true, live: true });
  assert.deepEqual(br.setPriority("rat", 3), { ok: true, live: true });
  assert.deepEqual(br.removePriority("drudge"), { ok: true });
  assert.deepEqual(br.setLootMin(300), { ok: true, live: true });
  assert.deepEqual(br.setVitalsThreshold("healAtCombat", 72), { ok: true, live: true });
  assert.deepEqual(br.setVitalsThreshold("emergencyHp", 25), { ok: true, live: true });
  delete bot.setBuffs;
  assert.deepEqual(await br.setBuffs([24, 2, 2]), { ok: true, live: false });
  assert.deepEqual(await br.setBuffs("auto"), { ok: true, live: false });
  assert.equal(br.setPriority("", 3).ok, false);
  assert.equal(br.setLootMin(-1).ok, false);
  assert.equal(br.setVitalsThreshold("healAtCombat", 101).ok, false);
  assert.deepEqual(notes, [
    ["priorities", { drudge: 7 }],
    ["priorities", { drudge: 7, rat: 3 }],
    ["priorities", { rat: 3 }],
    ["lootMin", 300],
    ["vitals", { healAtCombat: 72 }],
    ["vitals", { healAtCombat: 72, emergencyHp: 25 }],
    ["buffs", [24, 2]],
    ["buffs", "auto"],
  ]);
  // the loops got the values FIRST (a bound VT cell is read live when the profile saves)
  assert.equal(liveAtNote[0].priorities.drudge, 7, "setPriority: live write before the note");
  assert.equal("drudge" in liveAtNote[2].priorities, false, "removePriority: live removal before the note");
  assert.equal(liveAtNote[3].lootMin, 300, "setLootMin: live write before the note");
  assert.equal(liveAtNote[4].vitals.healAtCombat, 72, "setVitalsThreshold: live write before the note");
});

await check("a throwing provider never breaks a setter or a boot (falls back to botOverrides)", async () => {
  const throwing = { isUserProfileActive: () => { throw new Error("x"); }, hudBootOverrides: () => { throw new Error("y"); }, noteLegacyEdit: () => { throw new Error("z"); } };
  for (const rsVt of [{ hudProvider: () => throwing }, { hudProvider: () => { throw new Error("boom"); } }, new Proxy({}, { get() { throw new Error("evil"); } })]) {
    const win = { __sessionHandle: fakeHandle(), __rynthVt: rsVt };
    const b = recordingBoot();
    const br = createHudBridge(env(win, { boot: b }));
    await seedBlob(br);
    assert.equal((await br.start()).ok, true);
    assert.deepEqual(b.seen[0], BLOB_OVERRIDES);
  }
});

await check("a loaded VTank route: the Nav toggle drives bot.vt.nav (EnableNavigation via OperatorControl + resume), never the atlas follow", async () => {
  const nav = fakeNav();
  const bot = fakeBot({ vt: { nav, statusLine: () => "VT · profile Hunter · nav loop 1/3 (off)" } });
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  br.selectRoute("r1");
  let vm = br.snapshot();
  assert.equal(vm.toggles.nav.vtRoute, true);
  assert.equal(vm.toggles.nav.on, false);
  assert.equal(vm.vt, "VT · profile Hunter · nav loop 1/3 (off)");
  let r = await br.setSubsystem("nav", true);
  assert.deepEqual(r, { ok: true, vt: true });
  assert.deepEqual(nav.calls, [["enabled", true], "resume"]);
  assert.equal(bot.calls.some((c) => Array.isArray(c) && c[0] === "followRoute"), false, "no atlas follow");
  vm = br.snapshot();
  assert.equal(vm.toggles.nav.on, true);
  assert.equal(bot.control.state().subsystems.nav, true, "OperatorControl sees VT nav on");
  nav.calls.length = 0;
  r = await br.setSubsystem("nav", false);
  assert.deepEqual(r, { ok: true, vt: true });
  assert.deepEqual(nav.calls, [["enabled", false]]);
  assert.equal(bot.calls.includes("router.cancel"), false, "nothing else walking ⇒ no travel cancel");
  assert.equal(br.snapshot().toggles.nav.on, false);
  // A legacy goto is still walking: Nav OFF stops it too (as the legacy toggle did).
  await br.setSubsystem("nav", true);
  bot.mission = { kind: "goto", label: "42N 33W", startedAt: NOW };
  bot.router.status = { state: "WALK" };
  nav.calls.length = 0;
  await br.setSubsystem("nav", false);
  assert.ok(bot.calls.includes("router.cancel"), "the legacy walk was cancelled");
  assert.deepEqual(nav.calls.slice(0, 1), [["enabled", false]]);
});

await check("a refused VT Nav toggle (OperatorControl.setEnabled → ok:false) is reported and changes nothing else", async () => {
  const nav = fakeNav();
  const bot = fakeBot({ vt: { nav, statusLine: () => "VT" } });
  const seen = [];
  bot.control = {
    state: () => ({ stopped: false, running: true, subsystems: {} }),
    stop: () => ({ ok: true }),
    resume: () => ({ ok: true }),
    cancelTravel: () => { seen.push("cancelTravel"); },
    setEnabled: (name, on) => { seen.push([name, on]); return { ok: false, error: "nav locked" }; },
  };
  bot.mission = { kind: "goto", label: "x", startedAt: NOW };
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  assert.deepEqual(await br.setSubsystem("nav", true), { ok: false, error: "nav locked" });
  assert.deepEqual(await br.setSubsystem("nav", false), { ok: false, error: "nav locked" });
  assert.deepEqual(seen, [["nav", true], ["nav", false]], "no resume, no travel cancel after a refusal");
  assert.deepEqual(nav.calls, [], "VT nav untouched");
});

await check("HUD 'stop moving' pauses the VTank route (V-21): the toggle reads off until Nav is clicked, which resumes it", async () => {
  const nav = fakeNav();
  const bot = fakeBot({ vt: { nav, statusLine: () => "VT" } });
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  await br.setSubsystem("nav", true);
  assert.equal(br.snapshot().toggles.nav.on, true);
  assert.equal((await br.cancelTravel()).ok, true); // the Navigation section's "Stop moving"
  assert.deepEqual(nav.paused?.reason, "operator cancel", "operator_stop.js cancelTravel paused VT nav");
  assert.ok(bot.calls.includes("router.cancel") && bot.calls.includes("StopCompletely"));
  assert.equal(nav.enabled, true, "still enabled — only paused");
  assert.equal(br.snapshot().toggles.nav.on, false, "a paused route reads off");
  await br.setSubsystem("nav", true);
  assert.equal(nav.paused, null, "resumed");
  assert.equal(br.snapshot().toggles.nav.on, true);
});

await check("vm.vt: the layer status line; null without a layer; a throwing layer or an evil bot never throws", () => {
  const h = fakeHandle();
  assert.equal(buildViewModel({ bot: fakeBot(), handle: h, now: NOW }).vt, null);
  assert.equal(buildViewModel({ bot: fakeBot({ vt: { statusLine: () => "VT · profile Default" } }), handle: h, now: NOW }).vt, "VT · profile Default");
  const bad = fakeBot({ vt: { statusLine: () => { throw new Error("x"); }, nav: { hasRoute() { throw new Error("y"); } } } });
  const vm = buildViewModel({ bot: bad, handle: h, now: NOW });
  assert.equal(vm.vt, null);
  assert.equal(vm.toggles.nav.vtRoute, false);
  const evil = new Proxy({}, { get() { throw new Error("boom"); } });
  const ev = buildViewModel({ bot: evil, handle: evil, now: NOW });
  assert.equal(ev.vt, null);
  assert.equal(typeof ev.stateLine, "string");
});

await check("openVt(tab): window.__rynthVt.openPanel; installs rs_entry lazily when absent; failures are {ok:false}", async () => {
  const opened = [];
  const win = { __sessionHandle: fakeHandle(), __rynthVt: { version: 1, openPanel: async (t) => { opened.push(t); } } };
  const br = createHudBridge(env(win));
  assert.deepEqual(await br.openVt("route"), { ok: true });
  assert.deepEqual(await br.openVt(), { ok: true });
  assert.deepEqual(opened, ["route", undefined]);
  win.__rynthVt.openPanel = async () => { throw new Error("no document"); };
  const r = await br.openVt("meta");
  assert.equal(r.ok, false);
  assert.match(r.error, /VTank panel failed to open: no document/);
  // absent: the bridge imports rynth/vt/rs_entry.js and installs it
  const lazyOpened = [];
  const fakeEntry = { installRsEntry: (w) => { w.__rynthVt = { version: 1, openPanel: async (t) => { lazyOpened.push(t); } }; return w.__rynthVt; } };
  const win2 = { __sessionHandle: fakeHandle() };
  const br2 = createHudBridge(env(win2, { rsEntry: fakeEntry }));
  assert.deepEqual(await br2.openVt("items"), { ok: true });
  assert.deepEqual(lazyOpened, ["items"]);
  assert.equal(win2.__rynthVt.version, 1);
  const br3 = createHudBridge(env({ __sessionHandle: fakeHandle() })); // no layer on this page
  const r3 = await br3.openVt();
  assert.equal(r3.ok, false);
  assert.match(r3.error, /^VTank layer unavailable/);
});

await check("?botVt=off (rynth/boot.js): cfg.vt = false only for the exact 'off'; absent ⇒ cfg untouched; a HUD START on such a page boots without the layer", async () => {
  assert.equal(boot.BOT_URL_PARAM_NAMES.includes("botVt"), true);
  const cfgOf = (search) => boot.botConfigFromUrlParams(boot.readBotUrlParams(search));
  assert.equal(cfgOf("?bot=1&botVt=off").vt, false);
  for (const search of ["?bot=1", "?bot=1&botVt=on", "?bot=1&botVt=0", "?bot=1&botVt=OFF", "?bot=1&botVt="]) {
    assert.equal("vt" in cfgOf(search), false, search);
  }
  assert.deepEqual(cfgOf("?bot=1&botAi=off&botVt=off"), { ai: false, nav: { endpoint: "http://127.0.0.1:8767" }, vt: false }, "read outside the cfg.ai guard");
  assert.deepEqual(cfgOf("?bot=1&botVt=off&botKernel=off"), { nav: { endpoint: "http://127.0.0.1:8767" }, kernel: false, vt: false });
  // a HUD START (bootBotFromHud) on a ?botVt=off page
  const made = [];
  const win = { location: { href: "http://h/apps/holtburger-web/index.html?botVt=off", search: "?botVt=off" }, localStorage: null };
  const importer = async (url) => {
    if (url.endsWith("rynth/bot.js")) return { createGrindBot: async (h, cfg) => { made.push(cfg); return { stop() {}, host: {} }; } };
    if (url.endsWith("rynth/ai/operator_stop.js")) return { applyOperatorStopToCfg: () => false };
    throw new Error(`unexpected import ${url}`);
  };
  const logs = console.log;
  console.log = () => {};
  try {
    await boot.bootBotFromHud(fakeHandle(), { lootMin: 5 }, { win, importer });
  } finally {
    console.log = logs;
  }
  assert.equal(made.length, 1);
  assert.equal(made[0].vt, false, "the HUD boot honours ?botVt=off");
  assert.deepEqual(made[0].loot, { minValue: 5 });
});

// ═══════════════════════════ Part B — the HUD DOM ══════════════════════════

const { installFakeDom, FakeEvent } = await import("./helpers/social_fake_dom.mjs");
globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);
const PAGE_HREF = pathToFileURL(path.join(APP, "index.html")).href;
globalThis.location = { href: PAGE_HREF, search: "" };
// The VTank panel module the HUD's location.href import resolves to (one
// module instance per URL): give it a stand-in bridge and inert timers.
const panel = await import("../plugins/rynth-vt/panel.js");
const panelSnaps = [];
panel.configureVtPanel({ bridge: { snapshot: (id) => { panelSnaps.push(id); return {}; } }, setInterval: () => 1, clearInterval: () => {}, hidden: () => false });
const hud = await import("../plugins/rynth-hud.js");

const click = (el) => el.dispatchEvent(new FakeEvent("click"));
const q = (sel, root = document) => root.querySelector(sel);
const qa = (sel, root = document) => root.querySelectorAll(sel);
function makeHotbar() {
  document.getElementById("hb-hotbar")?.remove();
  const hb = document.createElement("div");
  hb.id = "hb-hotbar";
  const addons = document.createElement("div");
  addons.className = "hb-hotbar-addons";
  hb.appendChild(addons);
  document.body.appendChild(hb);
  window.__hotbar = { addonSlot: () => addons };
  return { hb, addons };
}
window.__sessionHandle = fakeHandle({ guid: 0x50000033 });
const domNav = fakeNav();
const domBot = fakeBot({ guid: 0x50000033, vt: { nav: domNav, statusLine: () => "VT · profile Default · nav farm 2/7 (off)" } });
opStop.getOperatorControl(domBot);
window.__bot = domBot;
makeHotbar();
let dispose = hud.mount();

await check("mount installs window.__rynthVt lazily — the REAL rs_entry.js from location.href", async () => {
  assert.ok(await until(() => window.__rynthVt && window.__rynthVt.version === 1), "installed");
  assert.equal(typeof window.__rynthVt.route, "function");
  assert.equal(typeof window.__rynthVt.hudProvider, "function");
  assert.equal(typeof window.__rynthVt.openPanel, "function");
});

await check("the VT button is LAST in the selectors row; every HUD DOM pin still holds", async () => {
  window.__toggleRynthHud();
  await tick(); // pins hold after the open settles, not only synchronously
  const root = document.getElementById("hb-rynth-hud");
  assert.equal(root.dataset.open, "1");
  assert.equal(qa(".rhud-tgl", root).length, 6, "Combat/Buff/Nav/Loot/AI + FR");
  assert.equal(qa(".rhud-launch .hbk-btn-brass", root).length, 5);
  const bar = q(".hbk-titlebar", root);
  const hdr = qa(".rhud-hdr-btn", bar);
  assert.deepEqual(hdr.map((b) => b.textContent), ["Lock", "−", "+", "_"], "the titlebar keeps exactly its four buttons");
  assert.equal(q(".rhud-vt", bar), null, "VT is not in the titlebar");
  const sel = q(".rhud-selectors", root);
  const vt = q(".rhud-vt", root);
  assert.ok(vt, "VT button");
  assert.equal(vt.tagName, "BUTTON");
  assert.equal(vt.textContent, "VT");
  assert.equal(vt.parentNode, sel);
  assert.equal(sel.childNodes[sel.childNodes.length - 1], vt, "appended last");
  assert.deepEqual(qa("label", sel).map((l) => l.textContent), ["Persona", "Route", "Loot ≥"], "Profile → Persona");
  const loot = q(".rhud-selectors input", root);
  assert.equal(loot.type, "number");
  assert.match(loot.title, /Minimum item value/, "the first selectors input is still the loot floor");
  const route = qa(".rhud-selectors select", root)[1];
  assert.match(route.title, /atlas routes/, "select[1] is still the route");
  for (const i of qa("input", root)) assert.ok(i.classList.contains("hbk-input") || i.classList.contains("hbk-check"), `kit input (${i.className})`);
});

await check("the VT button carries the layer status; the Nav toggle names and drives the loaded VTank route", async () => {
  const root = document.getElementById("hb-rynth-hud");
  const vt = q(".rhud-vt", root);
  assert.match(vt.title, /^VT · profile Default · nav farm 2\/7 \(off\)\n/);
  assert.match(vt.title, /\(\/rs ui\)$/);
  const navBtn = qa(".rhud-tgl", root)[2];
  assert.equal(navBtn.textContent, "Nav");
  assert.match(navBtn.title, /^Navigation \(the loaded VTank route\): off/);
  click(navBtn);
  assert.ok(await until(() => domNav.enabled === true), "Nav ON → EnableNavigation");
  assert.ok(domNav.calls.includes("resume"));
  assert.ok(await until(() => navBtn.classList.contains("is-on")), "the toggle lights");
  assert.equal(domBot.calls.some((c) => Array.isArray(c) && c[0] === "followRoute"), false);
  click(navBtn);
  assert.ok(await until(() => domNav.enabled === false), "Nav OFF");
});

await check("the VT button opens the REAL VTank panel through window.__rynthVt.openPanel", async () => {
  const root = document.getElementById("hb-rynth-hud");
  click(q(".rhud-vt", root));
  assert.ok(await until(() => panel.isVtPanelOpen()), "panel open");
  assert.ok(document.getElementById("hb-rynth-vt"), "the panel window is in the page");
  assert.ok(panelSnaps.length > 0, "the panel rendered through its bridge");
  assert.equal(q(".rhud-msg", root).textContent, "", "no error reported");
});

await check("dispose removes the HUD, the launcher, the globals AND the VTank panel (UI review §4.5)", async () => {
  dispose();
  assert.equal(document.getElementById("hb-rynth-hud"), null);
  assert.equal(document.getElementById("hb-rynth-hud-launcher"), null);
  assert.equal(window.__toggleRynthHud, undefined);
  assert.ok(await until(() => !document.getElementById("hb-rynth-vt")), "panel window removed");
  assert.equal(panel.isVtPanelOpen(), false);
  assert.equal(document.getElementById("hb-rynth-vt-style"), null, "panel stylesheet removed");
  assert.equal(window.__rynthVt?.version, 1, "the page-level command entry stays (the bot layer and /rs use it)");
});

await check("a panel left open (rynth.vt.ui.v1) reopens on HUD mount; dispose closes it again", async () => {
  assert.equal(JSON.parse(localStorage.getItem("rynth.vt.ui.v1")).open, true, "the panel persisted its open state");
  makeHotbar();
  dispose = hud.mount();
  assert.ok(await until(() => panel.isVtPanelOpen()), "reopened");
  dispose();
  assert.ok(await until(() => !document.getElementById("hb-rynth-vt")), "closed with the HUD");
});

await check("a panel opened with /rs ui (not the VT button) is closed with the HUD too", async () => {
  localStorage.setItem("rynth.vt.ui.v1", JSON.stringify({ open: false }));
  makeHotbar();
  dispose = hud.mount();
  await tick(20);
  assert.equal(panel.isVtPanelOpen(), false, "not reopened (persisted closed)");
  await window.__rynthVt.openPanel("route"); // what `/rs ui route` does
  assert.ok(document.getElementById("hb-rynth-vt"), "panel open");
  dispose();
  assert.ok(await until(() => !document.getElementById("hb-rynth-vt")), "closed with the HUD");
});

await check("a HUD disposed before its lazy rs_entry import settles never reopens a persisted panel afterwards", async () => {
  localStorage.setItem("rynth.vt.ui.v1", JSON.stringify({ open: true }));
  makeHotbar();
  try {
    const d = hud.mount();
    d(); // synchronously, before installVtEntry's import resolves
    await tick(50);
    assert.equal(panel.isVtPanelOpen(), false, "no orphan panel after the HUD is gone");
    assert.equal(document.getElementById("hb-rynth-vt"), null);
  } finally {
    try { panel.disposeVtPanel(); } catch { /* ignore */ }
  }
});

await check("no VTank layer on the page: the HUD works as before and the VT button reports it", async () => {
  localStorage.removeItem("rynth.vt.ui.v1");
  const prevVt = window.__rynthVt;
  delete window.__rynthVt;
  globalThis.location = { href: pathToFileURL(path.join(APP, "rynth/testdata/vt/__no_page__/index.html")).href, search: "" };
  try {
    makeHotbar();
    dispose = hud.mount();
    window.__openRynthHud();
    const root = document.getElementById("hb-rynth-hud");
    await tick(20);
    assert.equal(window.__rynthVt, undefined, "nothing installed");
    click(q(".rhud-vt", root));
    assert.ok(await until(() => /VTank layer unavailable/.test(q(".rhud-msg", root).textContent)), q(".rhud-msg", root).textContent);
    assert.equal(panel.isVtPanelOpen(), false);
    const combat = qa(".rhud-tgl", root)[0];
    click(combat);
    assert.ok(await until(() => domBot.combat.enabled === false), "the HUD still drives the bot");
    dispose();
    assert.equal(document.getElementById("hb-rynth-hud"), null);
  } finally {
    globalThis.location = { href: PAGE_HREF, search: "" };
    if (prevVt) window.__rynthVt = prevVt;
  }
});

await check("I-27: the HUD files gained no static import (rs_entry / panel load lazily from location.href)", () => {
  const statics = (rel) => [...readFileSync(path.join(APP, rel), "utf8").matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(statics("plugins/rynth-hud.js"), ["../ui/hud_kit.js", "../ui/ac_window_position.js", "../ui/keymap.js", "../rynth/hud_bridge.js"]);
  assert.deepEqual(statics("rynth/hud_bridge.js"), ["./portal_gate.js"]);
  assert.deepEqual(statics("rynth/boot.js"), []);
});

console.log(fail === 0 ? `rynth_vt_hud_integration: all ${pass} checks passed` : `rynth_vt_hud_integration: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
