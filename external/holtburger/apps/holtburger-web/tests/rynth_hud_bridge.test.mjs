// tests/rynth_hud_bridge.test.mjs — rynth/hud_bridge.js (2026-10-12).
//
// The RynthSuite HUD's one adapter to the bot. Drives buildViewModel and
// every bridge command against a fake bot (kernel / combat / loot / buff /
// vitals / router / director shaped like rynth/*.js) with the REAL
// rynth/ai/operator_stop.js OperatorControl behind start/stop/AI/subsystems,
// so the HUD is pinned to the authoritative stop/resume contract, not to a
// mock of it.
//
// Run from apps/holtburger-web/:  node tests/rynth_hud_bridge.test.mjs

import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

// One in-memory Storage for the bridge AND operator_stop.js (it defaults to
// globalThis.localStorage when no storage is passed).
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
  };
}
const storage = memStorage();
globalThis.localStorage = storage;

const bridgeMod = await import("../rynth/hud_bridge.js");
const opStop = await import("../rynth/ai/operator_stop.js");
const { buildViewModel, createHudBridge, describeNavError, VITALS_FIELDS } = bridgeMod;

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

const NOW = 1_800_000_000_000;
const names = { 0x80001234: "Drudge Skulker", 0x80005678: "Mosswart", 0x50000001: "Torval" };

function fakeHandle({ ready = true, vitals = [1, 75, 100, 150, 3, 180, 200, 200, 5, 40, 90, 120] } = {}) {
  return {
    isPlayerReady: () => ready,
    playerStats: () => ({ vitals }),
    objectName: (g) => names[g] ?? null,
    objectHealthFraction: (g) => (g === 0x80005678 ? 0.5 : -1),
    playerKnownSpells: () => [2, 24, 1664, 27],
  };
}

function fakeBot(o = {}) {
  const calls = [];
  const combat = { enabled: true, priorities: { olthoi: 10, drudge: 3 }, locked: 0, kills: 0 };
  const loot = { enabled: true, minValue: 0, state: "SCAN", lootedCount: 0 };
  const buff = {
    enabled: true,
    pending: null,
    _forceRebuffing: false,
    status: { ready: true, desired: 2, active: 1, pending: 0 },
    forceRebuff() { calls.push("forceRebuff"); this._forceRebuffing = true; },
    cancelForceRebuff() { calls.push("cancelForceRebuff"); this._forceRebuffing = false; },
    setDesired(ids) { calls.push(["setDesired", ids]); },
  };
  const vitals = { cfg: { healAtCombat: 60, getManaAtCombat: 40, restamAtCombat: 30, emergencyHp: 30, topOffHp: 95, topOffStam: 95, topOffMana: 95 }, lastReason: null };
  const kernel = {
    action: "Idle",
    running: true,
    operatorHeld: false,
    combat,
    loot,
    buff,
    vitals,
    start() { if (this.operatorHeld) return false; this.running = true; calls.push("kernel.start"); return true; },
    stop() { this.running = false; calls.push("kernel.stop"); },
    holdForOperator() { this.operatorHeld = true; this.stop(); calls.push("holdForOperator"); },
    releaseOperatorHold() { this.operatorHeld = false; calls.push("releaseOperatorHold"); },
    get status() {
      return {
        action: this.action, running: this.running, operatorHeld: this.operatorHeld,
        kills: combat.kills, looted: loot.lootedCount,
        // like rynth/kernel.js: the CURRENT loops' status (bot.setBuffs swaps kernel.buff)
        buffs: this.buff ? this.buff.status : null, vitals: this.vitals ? this.vitals.status ?? null : null,
        combat: { state: combat.locked ? "ENGAGE" : "IDLE", enabled: combat.enabled, locked: combat.locked, kills: combat.kills, mode: 2 },
      };
    },
  };
  const director = {
    enabled: true,
    start() { this.enabled = true; calls.push("director.start"); },
    stop() { this.enabled = false; calls.push("director.stop"); },
    isBusy() { return false; },
    get status() {
      return { enabled: this.enabled, running: false, nextCheckAt: NOW + 90_000, lastCheckAt: NOW - 30_000, calls: 3, consecutiveErrors: 0, lastSummary: "hunting drudges near Holtburg" };
    },
  };
  const router = {
    status: { state: "IDLE" },
    cancel() { calls.push("router.cancel"); this.status = { state: "IDLE" }; },
  };
  const host = {
    // The character guid scopes the persisted operator stop (operator_stop.js).
    GetPlayerId: () => o.guid ?? 0x50000001,
    TryGetObjectName: (g) => names[g] ?? null,
    TryGetTargetHealthFraction: (g) => (g === 0x80001234 ? 0.73 : -1),
    StopStick: () => calls.push("StopStick"),
    StopCompletely: () => calls.push("StopCompletely"),
  };
  const bot = {
    host, kernel, combat, loot, buff, vitals, router,
    globalRouter: o.noNav ? null : { busy: false },
    unwedge: null,
    startedAt: NOW - 3_600_000,
    mission: null,
    lastMission: null,
    ai: o.noAi ? undefined : { director, journal: { tail: (n) => [{ kind: "plan", text: "hunt drudges" }].slice(0, n) } },
    goto: async (to) => { calls.push(["goto", to]); return o.gotoResult ?? { ok: true, legsWalked: 4 }; },
    egress: async () => { calls.push("egress"); return { ok: true }; },
    followRoute: async (legs, opts) => { calls.push(["followRoute", legs.length, opts.label]); return { ok: true }; },
    calls,
  };
  return bot;
}

function env(win, extra = {}) {
  const importer = async (url) => {
    if (url.endsWith("rynth/ai/operator_stop.js")) return opStop;
    if (url.endsWith("rynth/boot.js")) return extra.boot;
    if (url.endsWith("rynth/atlas.js")) return extra.atlasMod;
    throw new Error(`unexpected import ${url}`);
  };
  return {
    win,
    storage,
    now: () => NOW,
    importer,
    moduleUrl: (rel) => `http://h/apps/holtburger-web/${rel}`,
    fetchJson: async () => ({
      spells: {
        2: { name: "Strength Self I", untargeted: true, duration: 1800, level: 1, school: 4 },
        24: { name: "Invulnerability Self I", untargeted: true, duration: 1800, level: 1, school: 4 },
        1664: { name: "Stamina to Health Self I", untargeted: true, duration: 0, level: 1, school: 2 },
        27: { name: "Flame Bolt I", untargeted: false, duration: 0, level: 1, school: 1 },
      },
    }),
    ...extra,
  };
}
const resetStorage = () => storage._m.clear();

// ── buildViewModel ─────────────────────────────────────────────────────
await check("no session → no-session, START disabled; ready session → not-started, START enabled", () => {
  let vm = buildViewModel({ now: NOW });
  assert.equal(vm.phase, "no-session");
  assert.equal(vm.canStart, false);
  assert.equal(vm.stateLine, "Not logged in");
  vm = buildViewModel({ handle: fakeHandle({ ready: false }), now: NOW });
  assert.equal(vm.phase, "not-started");
  assert.equal(vm.canStart, false);
  assert.equal(vm.stateLine, "Waiting for world");
  vm = buildViewModel({ handle: fakeHandle(), now: NOW });
  assert.equal(vm.canStart, true);
  assert.equal(vm.stateLine, "Not started");
  for (const k of ["combat", "buff", "nav", "loot", "ai"]) assert.equal(vm.toggles[k].on, false);
});

await check("player vitals read off the stride-4 playerStats array (HP/ST/MN = type 1/3/5)", () => {
  const vm = buildViewModel({ handle: fakeHandle(), now: NOW });
  assert.deepStrictEqual(vm.vitals, { hp: { cur: 75, max: 150 }, st: { cur: 180, max: 200 }, mn: { cur: 40, max: 120 } });
});

await check("running bot: state = kernel action, activity = the fight, target + kill rate", () => {
  const bot = fakeBot();
  bot.kernel.action = "Combat";
  bot.combat.locked = 0x80001234;
  bot.combat.kills = 12;
  const vm = buildViewModel({ bot, handle: fakeHandle(), now: NOW });
  assert.equal(vm.phase, "running");
  assert.equal(vm.stateLine, "Combat");
  assert.equal(vm.activityLine, "Fighting Drudge Skulker (73%)");
  assert.deepStrictEqual(vm.target, { guid: 0x80001234, name: "Drudge Skulker", hp: 0.73, source: "bot" });
  assert.equal(vm.stats.kills, 12);
  assert.equal(vm.stats.killsPerHour, 12); // one hour of uptime
  assert.deepStrictEqual(vm.stats.buffs, { active: 1, desired: 2, ready: true });
  assert.equal(vm.toggles.combat.on, true);
  assert.equal(vm.toggles.ai.on, true);
  assert.equal(vm.forceRebuff.available, true);
  assert.deepStrictEqual(vm.priorities, [["olthoi", 10], ["drudge", 3]]);
  assert.equal(vm.vitalsCfg.healAtCombat, 60);
  assert.equal(vm.gotoAvailable, true);
});

await check("no bot lock → the player's selection is the target (labelled selection)", () => {
  const bot = fakeBot();
  const vm = buildViewModel({ bot, handle: fakeHandle(), now: NOW, selectedGuid: 0x80005678 });
  assert.deepStrictEqual(vm.target, { guid: 0x80005678, name: "Mosswart", hp: null, source: "selection" });
  const vm2 = buildViewModel({ handle: fakeHandle(), now: NOW, selectedGuid: 0x80005678 });
  assert.equal(vm2.target.hp, 0.5, "no bot: the handle's health read");
});

await check("travel, portal hold, looting, buffing and recovering read as RynthAi state/activity lines", () => {
  const bot = fakeBot();
  bot.mission = { kind: "route", label: "Holtburg loop", startedAt: NOW - 65_000 };
  bot.router.status = { state: "WALK", leg: 2, legs: 9 };
  let vm = buildViewModel({ bot, handle: fakeHandle(), now: NOW, portalSpace: false });
  assert.equal(vm.stateLine, "Travelling");
  assert.equal(vm.activityLine, "route: Holtburg loop · leg 3/9");
  assert.equal(vm.toggles.nav.on, true);
  bot.router.status = { state: "WALK", leg: 2, legs: 9, portalHold: true, ticks: 4 };
  vm = buildViewModel({ bot, handle: fakeHandle(), now: NOW, portalSpace: true });
  assert.equal(vm.stateLine, "Holding: portal space");
  assert.equal(vm.portalHold, true);
  bot.mission = null;
  bot.router.status = { state: "IDLE" };
  bot.loot.state = "APPROACH";
  bot.kernel.action = "Loot";
  vm = buildViewModel({ bot, handle: fakeHandle(), now: NOW, portalSpace: false });
  assert.equal(vm.activityLine, "Looting (approach)");
  bot.loot.state = "SCAN";
  bot.kernel.action = "Buffing";
  bot.buff.pending = { spellId: 2, issuedAt: NOW };
  vm = buildViewModel({ bot, handle: fakeHandle(), now: NOW, portalSpace: false, spellName: (id) => (id === 2 ? "Strength Self I" : null) });
  assert.equal(vm.activityLine, "Casting Strength Self I");
  bot.buff.pending = null;
  bot.kernel.action = "Vitals";
  bot.vitals.lastReason = "heal (hp 41%)";
  vm = buildViewModel({ bot, handle: fakeHandle(), now: NOW, portalSpace: false });
  assert.equal(vm.activityLine, "Recovering — heal (hp 41%)");
});

await check("missing loops disable their toggles with a reason (no dead buttons)", () => {
  const bot = fakeBot({ noAi: true });
  bot.buff = null;
  bot.loot = null;
  const vm = buildViewModel({ bot, handle: fakeHandle(), now: NOW, hasAiKey: false });
  assert.equal(vm.toggles.buff.available, false);
  assert.match(vm.toggles.buff.hint, /No buffs configured/);
  assert.equal(vm.toggles.loot.available, false);
  assert.equal(vm.toggles.ai.available, false);
  assert.match(vm.toggles.ai.hint, /OpenRouter key/);
  assert.equal(vm.forceRebuff.available, false);
  assert.equal(vm.lootMin, null);
  const vm2 = buildViewModel({ bot, handle: fakeHandle(), now: NOW, hasAiKey: true });
  assert.match(vm2.toggles.ai.hint, /restart the bot/);
});

await check("describeNavError: the 20 s sidecar abort reads as 'nav sidecar timed out'", () => {
  assert.equal(describeNavError({ ok: false, error: "sidecar timed out after 20000ms at http://127.0.0.1:8767" }), "nav sidecar timed out");
  assert.equal(describeNavError({ ok: false, error: "nav not configured" }), "nav sidecar not configured");
  assert.equal(describeNavError({ ok: false, state: "FAILED" }), "FAILED");
  assert.equal(describeNavError("boom"), "boom");
});

// ── commands through the REAL OperatorControl ──────────────────────────
await check("STOP: hold + director off + movement halted + durable latch; START: resume restores both", async () => {
  resetStorage();
  const bot = fakeBot();
  const win = { __bot: bot, __sessionHandle: fakeHandle() };
  const br = createHudBridge(env(win));
  let r = await br.stop();
  assert.equal(r.ok, true);
  assert.equal(bot.kernel.operatorHeld, true);
  assert.equal(bot.kernel.running, false);
  assert.equal(bot.ai.director.enabled, false);
  assert.ok(bot.calls.includes("router.cancel") && bot.calls.includes("StopCompletely"));
  assert.equal(storage.getItem(opStop.botStopKey(0x50000001)), "1", "persisted under THIS character's key");
  assert.equal(storage.getItem(opStop.BOT_STOP_KEY), null, "never the bare origin-wide key");
  let vm = br.snapshot();
  assert.equal(vm.phase, "stopped");
  assert.equal(vm.hasControl, true);
  assert.match(vm.stateLine, /^Stopped — HUD/);
  assert.equal(vm.activityLine, "Hands off — you have control");
  r = await br.start();
  assert.equal(r.ok, true);
  assert.equal(bot.kernel.operatorHeld, false);
  assert.equal(bot.kernel.running, true);
  assert.equal(bot.ai.director.enabled, true);
  assert.equal(storage.getItem(opStop.botStopKey(0x50000001)), null);
  vm = br.snapshot();
  assert.equal(vm.phase, "running");
  const texts = vm.log.map((l) => l.text);
  assert.ok(texts.includes("STOP") && texts.includes("START (resume)"), `commands logged: ${texts.join(" | ")}`);
  assert.ok(texts.some((t) => /bot RUNNING/.test(t)), "the stopped→running transition is logged");
});

await check("toggleRun flips RUNNING ↔ STOPPED", async () => {
  resetStorage();
  const bot = fakeBot();
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  await br.toggleRun();
  assert.equal(bot.kernel.operatorHeld, true);
  await br.toggleRun();
  assert.equal(bot.kernel.operatorHeld, false);
  assert.equal(bot.kernel.running, true);
});

await check("subsystem toggles drive loop.enabled through OperatorControl.setEnabled", async () => {
  resetStorage();
  const bot = fakeBot();
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  assert.equal((await br.setSubsystem("combat", false)).ok, true);
  assert.equal(bot.combat.enabled, false);
  assert.equal((await br.setSubsystem("loot", false)).ok, true);
  assert.equal(bot.loot.enabled, false);
  assert.equal((await br.setSubsystem("buff", false)).ok, true);
  assert.equal(bot.buff.enabled, false);
  const vm = br.snapshot();
  assert.equal(vm.toggles.combat.on, false);
  assert.equal(vm.toggles.loot.on, false);
  assert.equal((await br.setSubsystem("bogus", true)).ok, false);
});

await check("AI toggle: off latches + stops; on clears + starts; on while stopped is deferred", async () => {
  resetStorage();
  const bot = fakeBot();
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  let r = await br.setAi(false);
  assert.equal(r.ok, true);
  assert.equal(bot.ai.director.enabled, false);
  assert.equal(storage.getItem(opStop.OPERATOR_STOP_KEY), "1");
  r = await br.setAi(true);
  assert.equal(r.ok, true);
  assert.equal(bot.ai.director.enabled, true);
  await br.stop();
  r = await br.setAi(true);
  assert.equal(r.ok, true);
  assert.equal(r.deferred, true, "a director must not drive a held bot");
  assert.equal(bot.ai.director.enabled, false);
  await br.start();
  assert.equal(bot.ai.director.enabled, true);
  const noAi = fakeBot({ noAi: true });
  const br2 = createHudBridge(env({ __bot: noAi, __sessionHandle: fakeHandle() }));
  assert.equal((await br2.setAi(true)).ok, false);
});

await check("force rebuff + cancel; unavailable on a buff loop without the method", async () => {
  resetStorage();
  const bot = fakeBot();
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  assert.equal(br.forceRebuff().ok, true);
  assert.equal(br.snapshot().forceRebuff.active, true);
  assert.equal(br.cancelForceRebuff().ok, true);
  assert.deepStrictEqual(bot.calls.filter((c) => typeof c === "string" && c.includes("Rebuff")), ["forceRebuff", "cancelForceRebuff"]);
  delete bot.buff.forceRebuff;
  assert.equal(br.forceRebuff().ok, false);
});

await check("monster priorities: live on combat.priorities + persisted; remove", async () => {
  resetStorage();
  const bot = fakeBot();
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  assert.equal(br.setPriority("  Olthoi Noble ", 15.4).ok, true);
  assert.equal(bot.combat.priorities["olthoi noble"], 15);
  assert.equal(br.setPriority("x", 99).ok, true);
  assert.equal(bot.combat.priorities.x, 20, "clamped to 20");
  assert.equal(br.setPriority("", 3).ok, false);
  assert.equal(br.setPriority("rat", "abc").ok, false);
  br.removePriority("x");
  assert.equal("x" in bot.combat.priorities, false);
  const saved = JSON.parse(storage.getItem(bridgeMod.HUD_SETTINGS_KEY));
  assert.deepStrictEqual(saved.priorities, { "olthoi noble": 15 });
});

await check("loot floor + vitals thresholds apply live and validate", async () => {
  resetStorage();
  const bot = fakeBot();
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  assert.deepStrictEqual(br.setLootMin(250), { ok: true, live: true });
  assert.equal(bot.loot.minValue, 250);
  assert.equal(br.setLootMin(-1).ok, false);
  assert.equal(br.setVitalsThreshold("healAtCombat", 70).ok, true);
  assert.equal(bot.vitals.cfg.healAtCombat, 70);
  assert.equal(br.setVitalsThreshold("healAtCombat", 101).ok, false);
  assert.equal(br.setVitalsThreshold("nope", 5).ok, false);
  assert.equal(VITALS_FIELDS.length, 7);
});

await check("buff list: live via buff.setDesired, else saved for the next start", async () => {
  resetStorage();
  const bot = fakeBot();
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  assert.deepStrictEqual(await br.setBuffs([24, 2, 2, -1, "x"]), { ok: true, live: true });
  assert.deepStrictEqual(bot.calls.find((c) => Array.isArray(c) && c[0] === "setDesired"), ["setDesired", [24, 2]]);
  delete bot.buff.setDesired;
  assert.deepStrictEqual(await br.setBuffs([2]), { ok: true, live: false });
  assert.deepStrictEqual(br.getSettings().buffs, [2]);
});

await check("bot.setBuffs: Apply/Auto go through it; the Buff toggle builds a loop when none exists", async () => {
  resetStorage();
  const bot = fakeBot();
  const made = [];
  const newBuff = () => ({ enabled: true, pending: null, status: { ready: true, desired: 3, active: 0, pending: 0 } });
  bot.buff = null;
  bot.kernel.buff = null;
  bot.setBuffs = (v) => { made.push(v); bot.buff = newBuff(); bot.kernel.buff = bot.buff; };
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  let vm = br.snapshot();
  assert.equal(vm.toggles.buff.available, true, "live even with no loop");
  assert.equal(vm.toggles.buff.on, false);
  assert.equal((await br.setSubsystem("buff", true)).ok, true);
  assert.deepStrictEqual(made, ["auto"], "no saved list → auto");
  vm = br.snapshot();
  assert.equal(vm.toggles.buff.on, true);
  assert.equal((await br.setSubsystem("buff", false)).ok, true);
  assert.equal(bot.buff.enabled, false, "OFF pauses the existing loop (OperatorControl.setEnabled)");
  assert.deepStrictEqual(await br.setBuffs([24, 2]), { ok: true, live: true });
  assert.deepStrictEqual(await br.setBuffs("auto"), { ok: true, live: true });
  assert.deepStrictEqual(made.slice(1), [[24, 2], "auto"]);
  assert.equal(br.getSettings().buffs, "auto");
  // A saved fixed list is what the toggle restores.
  await br.setBuffs([2]);
  bot.buff.status.desired = 0;
  await br.setSubsystem("buff", true);
  assert.deepStrictEqual(made[made.length - 1], [2]);
  // No setBuffs and no loop: the toggle is unavailable, with the reason.
  const bare = fakeBot();
  bare.buff = null;
  const vm2 = buildViewModel({ bot: bare, handle: fakeHandle(), now: NOW });
  assert.equal(vm2.toggles.buff.available, false);
});

await check("held casts: buff/vitals status.blocked + the last refusal, in player words", () => {
  const bot = fakeBot();
  bot.buff.status = { ...bot.buff.status, blocked: "components", lastRefusal: { code: 0x400, cls: "components", spellId: 2, at: NOW - 60_000 } };
  bot.vitals.status = { blocked: "no-caster", spells: { healSelf: 6, stamToMana: 1676, revitalize: 0 }, lastRefusal: null };
  const vm = buildViewModel({ bot, handle: fakeHandle(), now: NOW });
  assert.equal(vm.castHold.buffs, "missing spell components");
  assert.equal(vm.castHold.combat, null);
  assert.equal(vm.castHold.vitals, "no wand, orb or staff wielded");
  assert.deepStrictEqual(vm.castHold.buffRefusal, { cls: "components", spellId: 2, agoS: 60 });
  assert.deepStrictEqual(vm.recoverySpells, { healSelf: 6, stamToMana: 1676 });
  assert.equal(bridgeMod.describeBlock("weird"), "weird");
  assert.equal(bridgeMod.describeBlock(null), null);
});

await check("known self-buffs: untargeted spells with a duration, from the catalog", async () => {
  const br = createHudBridge(env({ __sessionHandle: fakeHandle() }));
  const list = await br.knownSelfBuffs();
  assert.deepStrictEqual(list.map((s) => s.id), [24, 2]); // sorted by name; 1664 (no duration) + 27 (targeted) excluded
});

await check("routes: list + follow through the shared atlas; goto validates and reports a sidecar timeout", async () => {
  resetStorage();
  const bot = fakeBot({ gotoResult: { ok: false, error: "sidecar timed out after 20000ms at http://127.0.0.1:8767" } });
  const legs = [{ lb: 1, x: 0, y: 0, z: 0 }, { lb: 1, x: 5, y: 5, z: 0 }];
  class Atlas {
    listRoutes() { return [{ id: "r1", name: "Holtburg loop", legs, portalsUsed: 0 }, { id: "bad", name: "empty", legs: [] }]; }
    getRoute(k) { return k === "r1" || k === "Holtburg loop" ? this.listRoutes()[0] : null; }
  }
  const win = { __bot: bot, __sessionHandle: fakeHandle() };
  const br = createHudBridge(env(win, { atlasMod: { Atlas } }));
  const routes = await br.listRoutes();
  assert.deepStrictEqual(routes, [{ id: "r1", name: "Holtburg loop", legs: 2, portals: 0 }]);
  assert.ok(win.__atlas instanceof Atlas, "publishes THE shared atlas on window.__atlas");
  assert.equal((await br.followRoute(null)).ok, false, "no route picked yet");
  assert.equal((await br.followRoute("r1")).ok, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(bot.calls.find((c) => Array.isArray(c) && c[0] === "followRoute"), ["followRoute", 2, "Holtburg loop"]);
  assert.equal((await br.gotoLoc(200, 0)).ok, false);
  assert.equal((await br.gotoLoc("42.1", "-33.5")).ok, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(bot.calls.find((c) => Array.isArray(c) && c[0] === "goto"), ["goto", { ns: 42.1, ew: -33.5 }]);
  const vm = br.snapshot();
  assert.equal(vm.lastNav.text, "goto failed: nav sidecar timed out");
  assert.equal(vm.lastNav.ok, false);
  const noNav = fakeBot({ noNav: true });
  const br2 = createHudBridge(env({ __bot: noNav, __sessionHandle: fakeHandle() }));
  assert.match((await br2.gotoLoc(1, 1)).error, /sidecar not configured/);
  assert.equal((await br.cancelTravel()).ok, true);
  assert.ok(bot.calls.includes("router.cancel"));
});

await check("START with no bot: clears a persisted bot stop, boots with the HUD settings, resumes if held", async () => {
  resetStorage();
  storage.setItem(opStop.BOT_STOP_KEY, "1"); // the operator stopped the last bot
  const win = { __sessionHandle: fakeHandle() };
  let bootArgs = null;
  const boot = {
    bootBotFromHud: async (h, overrides, opts) => {
      bootArgs = { latchAtBoot: storage.getItem(opStop.BOT_STOP_KEY), overrides, h };
      const nb = fakeBot();
      opts.win.__bot = nb;
      return nb;
    },
  };
  const br = createHudBridge(env(win, { boot }));
  br.setPriority("olthoi", 12);
  br.setLootMin(100);
  await br.setBuffs([2]);
  const r = await br.start();
  assert.equal(r.ok, true);
  assert.equal(r.booted, true);
  assert.equal(bootArgs.latchAtBoot, null, "latch cleared BEFORE the boot");
  assert.deepStrictEqual(bootArgs.overrides, { buffs: [2], priorities: { olthoi: 12 }, lootMin: 100 });
  assert.equal(win.__bot.kernel.running, true);
});

await check("START refuses cleanly: no session / not in world / already booting", async () => {
  const br1 = createHudBridge(env({}));
  assert.match((await br1.start()).error, /not logged in/);
  const br2 = createHudBridge(env({ __sessionHandle: fakeHandle({ ready: false }) }));
  assert.match((await br2.start()).error, /not in the world/);
  const br3 = createHudBridge(env({ __sessionHandle: fakeHandle(), __botBooting: true }));
  assert.match((await br3.start()).error, /already starting/);
});

await check("explorer profile turns combat + looting off live; grind turns them back on", async () => {
  resetStorage();
  const bot = fakeBot();
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  await br.setPersona("explorer");
  assert.equal(bot.combat.enabled, false);
  assert.equal(bot.loot.enabled, false);
  await br.setPersona("grind");
  assert.equal(bot.combat.enabled, true);
  assert.equal(bot.loot.enabled, true);
  assert.equal(br.getSettings().persona, "grind");
});

await check("the log notes kills (with the target), loot and AI summaries between snapshots", async () => {
  resetStorage();
  const bot = fakeBot();
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  bot.kernel.action = "Combat";
  bot.combat.locked = 0x80001234;
  br.snapshot();
  bot.combat.kills = 1;
  bot.combat.locked = 0;
  bot.loot.lootedCount = 3;
  const vm = br.snapshot();
  const texts = vm.log.map((l) => l.text);
  assert.ok(texts.includes("kill #1 — Drudge Skulker"), texts.join(" | "));
  assert.ok(texts.includes("looted (3 total)"));
  assert.deepStrictEqual(vm.journal, [{ kind: "plan", text: "hunt drudges" }]);
});

// ── 2026-10-12 review fixes (#6 / #10 / #12 / #4) ──────────────────────
await check("playerStats() boxes are freed after the vitals copy (no wasm-heap growth at 4 Hz)", () => {
  let freed = 0;
  const handle = {
    ...fakeHandle(),
    playerStats: () => ({ vitals: [1, 75, 100, 150], free() { freed++; } }),
  };
  const v = bridgeMod.readPlayerVitals(handle);
  assert.deepStrictEqual(v.hp, { cur: 75, max: 150 });
  assert.equal(freed, 1);
  buildViewModel({ handle, now: NOW });
  assert.equal(freed, 2, "the view-model path frees too");
  // A box whose read throws is still freed.
  const bad = { playerStats: () => ({ get vitals() { throw new Error("x"); }, free() { freed++; } }) };
  bridgeMod.readPlayerVitals(bad);
  assert.equal(freed, 3);
});

await check("setBuffs awaits bot.setBuffs (bot.js serializes — the HUD keeps no second queue), errors reported", async () => {
  resetStorage();
  const bot = fakeBot();
  const reached = [];
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  // bot.js's own serialization, as createGrindBot implements it.
  let chain = Promise.resolve();
  bot.setBuffs = (v) => {
    reached.push(v);
    const run = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (v === "auto") await gate; // the first call is slow (ladder load)
      active--;
      return Array.isArray(v) ? v : [2, 24];
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  let settled = false;
  const p1 = br.setBuffs("auto").then((r) => { settled = true; return r; });
  const p2 = br.setBuffs([24]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, "not ok before bot.setBuffs resolves");
  assert.deepStrictEqual(reached, ["auto", [24]], "both calls go straight to bot.setBuffs (no HUD-side queue)");
  release();
  assert.deepStrictEqual(await p1, { ok: true, live: true });
  assert.deepStrictEqual(await p2, { ok: true, live: true });
  assert.equal(maxActive, 1, "bot.js's chain keeps them from overlapping (no double buff loop)");
  bot.setBuffs = async () => { throw new Error("ladder table failed to load"); };
  const r = await br.setBuffs([2]);
  assert.equal(r.ok, false);
  assert.match(r.error, /ladder table failed to load/);
  // The Buff toggle path awaits and reports too.
  bot.buff = null;
  bot.kernel.buff = null;
  const t = await br.setSubsystem("buff", true);
  assert.equal(t.ok, false);
  assert.match(t.error, /ladder table failed to load/);
});

await check("one snapshot = one kernel.status and one director.status (the control's), one vitals.status", async () => {
  resetStorage();
  const bot = fakeBot();
  const count = { kernel: 0, director: 0, vitals: 0, buff: 0 };
  const kDesc = Object.getOwnPropertyDescriptor(bot.kernel, "status");
  Object.defineProperty(bot.kernel, "status", { get() { count.kernel++; return kDesc.get.call(this); }, configurable: true });
  const d = bot.ai.director;
  const dDesc = Object.getOwnPropertyDescriptor(d, "status");
  Object.defineProperty(d, "status", { get() { count.director++; return dDesc.get.call(this); }, configurable: true });
  const bStatus = bot.buff.status;
  Object.defineProperty(bot.buff, "status", { get() { count.buff++; return bStatus; }, configurable: true });
  Object.defineProperty(bot.vitals, "status", { get() { count.vitals++; return { blocked: null, spells: { heal: 6 } }; }, configurable: true });
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  br.snapshot(); // first snapshot loads operator_stop.js (async) — measure the next one
  await new Promise((r) => setTimeout(r, 0));
  for (const k of Object.keys(count)) count[k] = 0;
  const vm = br.snapshot();
  assert.equal(vm.hasControl, true, "the control is in play");
  assert.equal(count.kernel, 1, `kernel.status ${count.kernel}× per snapshot`);
  assert.equal(count.director, 1, `director.status ${count.director}× per snapshot`);
  assert.equal(count.vitals, 1, `vitals.status ${count.vitals}× per snapshot`);
  assert.equal(count.buff, 1, `buff.status ${count.buff}× per snapshot (the control's kernel.status read is reused)`);
  // Same answers as before the single-read change.
  assert.equal(vm.stats.buffs.desired, 2);
  assert.deepStrictEqual(vm.recoverySpells, { heal: 6 });
  assert.equal(vm.ai.lastSummary, "hunting drudges near Holtburg");
});

await check("START clears only THIS character's persisted stop (scope = player guid)", async () => {
  resetStorage();
  const seen = [];
  const op = { ...opStop, clearBotStop: (st, scope) => { seen.push(scope); return opStop.clearBotStop(st, scope); } };
  const win = { __sessionHandle: { ...fakeHandle(), playerGuid: () => 0x50000007 } };
  const boot = {
    bootBotFromHud: async (h, overrides, opts) => {
      const nb = fakeBot();
      opts.win.__bot = nb;
      return nb;
    },
  };
  const e = env(win, { boot });
  const baseImporter = e.importer;
  e.importer = async (url) => (url.endsWith("rynth/ai/operator_stop.js") ? op : baseImporter(url));
  // Two characters' persisted stops (two bot tabs on one origin).
  opStop.latchBotStop(storage, 0x50000007);
  opStop.latchBotStop(storage, 0x50000008);
  const br = createHudBridge(e);
  assert.equal((await br.start()).ok, true);
  assert.deepStrictEqual(seen, [0x50000007]);
  if (typeof opStop.botStopKey === "function") {
    assert.equal(opStop.isBotStopLatched(storage, 0x50000007), false, "this character's stop cleared");
    assert.equal(opStop.isBotStopLatched(storage, 0x50000008), true, "the other character's stop untouched");
  }
});

await check("never throws on a broken bot surface", async () => {
  const evil = new Proxy({}, { get() { throw new Error("boom"); } });
  const vm = buildViewModel({ bot: evil, ctl: null, handle: evil, now: NOW });
  assert.equal(typeof vm.stateLine, "string");
  const br = createHudBridge(env({ __bot: evil, __sessionHandle: evil }));
  assert.equal(typeof br.snapshot().stateLine, "string");
});

await check("Buff toggle with nothing castable: reports it and stays OFF (review-2 #11)", async () => {
  resetStorage();
  const bot = fakeBot();
  bot.buff = null;
  bot.kernel.buff = null;
  bot.setBuffs = async () => []; // bot.js resolved "auto" to no castable self-buff
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  const r = await br.setSubsystem("buff", true);
  assert.equal(r.ok, false);
  assert.equal(r.error, "no castable self-buffs known for this character");
  assert.equal(bot.buff, null, "no loop was built");
  const vm = br.snapshot();
  assert.equal(vm.toggles.buff.on, false, "the toggle stays off");
  assert.ok(!vm.log.some((l) => /buffs on/.test(l.text)), "no 'buffs on' note");
});

await check("Activity names the spell from the live handle's getSpellRecord (Map/object record), cached; catalog/id fallback", async () => {
  resetStorage();
  const bot = fakeBot();
  bot.kernel.action = "Buffing";
  bot.buff.pending = { spellId: 4299 };
  const lookups = [];
  const handle = {
    ...fakeHandle(),
    getSpellRecord: (id) => {
      lookups.push(id);
      if (id === 4299) return new Map([["name", "Incantation of Endurance Self"], ["level", 8]]);
      if (id === 4311) return { name: "Incantation of Heal Self" };
      return undefined;
    },
  };
  const br = createHudBridge(env({ __bot: bot, __sessionHandle: handle }));
  let vm = br.snapshot();
  assert.equal(vm.activityLine, "Casting Incantation of Endurance Self");
  br.snapshot();
  br.snapshot();
  assert.deepStrictEqual(lookups, [4299], "one getSpellRecord per id (cached)");
  bot.buff.pending = { spellId: 4311 };
  vm = br.snapshot();
  assert.equal(vm.activityLine, "Casting Incantation of Heal Self", "object-shaped record");
  bot.buff.pending = { spellId: 9999 };
  vm = br.snapshot();
  assert.equal(vm.activityLine, "Casting spell 9999", "no record, no catalog -> the id");
  // No getSpellRecord on the handle at all: still the id, nothing cached that
  // would hide a later handle.
  const br2 = createHudBridge(env({ __bot: bot, __sessionHandle: fakeHandle() }));
  bot.buff.pending = { spellId: 4299 };
  assert.equal(br2.snapshot().activityLine, "Casting spell 4299");
});

console.log(fail === 0 ? `rynth_hud_bridge: all ${pass} checks passed` : `rynth_hud_bridge: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
