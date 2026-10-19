// tests/rynth_start_on_login.test.mjs — the VTank option StartMacroOnLogin
// (2026-10-19): rynth/boot.js maybeStartMacroOnLogin, called by
// app/client_events.js on kind=7 EnteredWorld right after maybeAutoBootBot.
//
//   • off (the default) changes nothing; never on a ?bot=1 or ?botVt=off page;
//   • once per login: a death respawn (same session handle) never re-fires, a
//     new login (new handle) does; an unknown character is retried later;
//   • it waits for the takeover rebind maybeAutoBootBot started;
//   • START is the HUD's: the REAL rynth/hud_bridge.js start() end to end
//     (the REAL operator_stop.js stored stop is cleared, the bot boots
//     unheld); without a HUD the same steps run in boot.js (clear the stop,
//     resume a held bot, or boot with the USER profile's hudBootOverrides());
//   • the profile is the REAL page session (rynth/vt/settings) — read without
//     installing window.__rynthVt when the HUD has not;
//   • it never rejects; client_events.js wires it as described.
//
// Run from apps/holtburger-web/:  node tests/rynth_start_on_login.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
// operator_stop.js falls back to globalThis.localStorage.
globalThis.localStorage = memStorage();

const boot = await import("../rynth/boot.js");
const opStop = await import("../rynth/ai/operator_stop.js");
const SET = await import("../rynth/vt/settings/index.js");
const { createHudBridge } = await import("../rynth/hud_bridge.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}
const ME = 0x50000001;
const OTHER = 0x50000002;
const HREF = "http://h/apps/holtburger-web/index.html";

function handle(guid = ME) {
  return { isPlayerReady: () => true, playerGuid: () => guid };
}
/** A page: the window globals boot.js reads, a recording importer, consoles. */
function page({ search = "", rsEntry = true, startOn = true, userProfile = null } = {}) {
  localStorage._m.clear();
  const win = { location: { href: `${HREF}${search}`, search }, localStorage, chat: [] };
  win.__appendChatLine = (t, c) => win.chat.push([t, c]);
  const sessions = new Map();
  const sessionOf = (scope) => {
    if (!sessions.has(scope)) sessions.set(scope, SET.getVtSession(win, scope, { storage: localStorage }));
    return sessions.get(scope);
  };
  const s = sessionOf(String(ME));
  if (userProfile) {
    assert.equal(s.options.saveAs(userProfile.name).ok, true);
    for (const [k, v] of Object.entries(userProfile.settings || {})) s.options.set(k, v);
  }
  if (startOn) s.options.set("StartMacroOnLogin", true);
  if (rsEntry) win.__rynthVt = { session: (scope) => sessionOf(String(scope)) };
  const made = [];
  const imports = [];
  let heldAtBoot = false;
  const importer = async (url) => {
    imports.push(url.replace(HREF.replace("index.html", ""), ""));
    if (url.endsWith("rynth/bot.js")) {
      return {
        createGrindBot: async (h, cfg) => {
          const bot = {
            h,
            cfg,
            resumes: 0,
            held: heldAtBoot || cfg.startHeld === true,
            stop() {},
            host: { dispose() {} },
          };
          bot.control = { state: () => ({ stopped: bot.held }), stop() { bot.held = true; }, resume() { bot.resumes++; bot.held = false; }, isStopped: () => bot.held };
          made.push(bot);
          return bot;
        },
      };
    }
    if (url.endsWith("rynth/ai/operator_stop.js")) return opStop;
    if (url.endsWith("rynth/vt/settings/index.js")) return SET;
    // the HUD bridge's START imports boot.js and boots without an importer
    // (the real import() of an http URL): hand it this page's
    if (url.endsWith("rynth/boot.js")) return { ...boot, bootBotFromHud: (h, o, opts) => boot.bootBotFromHud(h, o, { ...opts, importer }) };
    throw new Error(`unexpected import ${url}`);
  };
  return { win, s, sessionOf, made, imports, importer, setHeldAtBoot: (v) => (heldAtBoot = v) };
}
async function quiet(fn) {
  const ol = console.log;
  const ow = console.warn;
  const logs = [];
  const warns = [];
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => warns.push(a.map(String).join(" "));
  try {
    const r = await fn();
    return { r, logs, warns };
  } finally {
    console.log = ol;
    console.warn = ow;
  }
}
const params = (search) => {
  const p = boot.readBotUrlParams(search);
  return { bot: p.bot, botVt: p.botVt };
};
function fakeHud() {
  const hud = { starts: 0, result: { ok: true, booted: true }, start: async () => { hud.starts++; return hud.result; } };
  return hud;
}

await check("off (the default): nothing starts; ?bot=1 / ?botVt=off / no handle: not even read", async () => {
  const pg = page({ startOn: false });
  const hud = fakeHud();
  pg.win.__rynthHud = { bridge: hud };
  const H = handle();
  const { r, logs } = await quiet(() => boot.maybeStartMacroOnLogin(H, params(""), { win: pg.win, importer: pg.importer }));
  assert.equal(r, null);
  assert.equal(hud.starts, 0);
  assert.deepEqual(logs, []);
  const on = page();
  on.win.__rynthHud = { bridge: hud };
  for (const search of ["?bot=1", "?botVt=off", "?bot=1&botVt=off"]) {
    assert.equal(boot.maybeStartMacroOnLogin(handle(), params(search), { win: on.win, importer: on.importer }), null, search);
  }
  assert.equal(boot.maybeStartMacroOnLogin(null, params(""), { win: on.win, importer: on.importer }), null);
  assert.equal(on.win.__botLoginStartHandle, undefined, "nothing remembered");
  assert.deepEqual(on.imports, []);
  assert.equal(hud.starts, 0);
});

await check("on + the HUD mounted: the HUD's START, once per login (a respawn never re-fires, a new login does)", async () => {
  const pg = page();
  const hud = fakeHud();
  pg.win.__rynthHud = { bridge: hud };
  const H1 = handle();
  const { r, logs } = await quiet(() => boot.maybeStartMacroOnLogin(H1, params(""), { win: pg.win, importer: pg.importer }));
  assert.equal(r, "hud");
  assert.equal(hud.starts, 1);
  assert.deepEqual(logs, ["[rynth] StartMacroOnLogin: macro started (hud)"]);
  assert.deepEqual(pg.win.chat, [["[RynthSuite] Start on login: the macro is running (profile option StartMacroOnLogin).", 0]]);
  assert.equal(pg.win.__botLoginStartHandle, H1);
  assert.equal(boot.maybeStartMacroOnLogin(H1, params(""), { win: pg.win, importer: pg.importer }), null, "death respawn: same handle");
  const H2 = handle(); // a new Connect / takeover = a new login
  await quiet(() => boot.maybeStartMacroOnLogin(H2, params(""), { win: pg.win, importer: pg.importer }));
  assert.equal(hud.starts, 2);
  assert.deepEqual(pg.imports, [], "the page entry was there: no import");
});

await check("waits for the takeover rebind (opts.after) before START", async () => {
  const pg = page();
  const hud = fakeHud();
  pg.win.__rynthHud = { bridge: hud };
  let release;
  const after = new Promise((r) => (release = r));
  const pr = boot.maybeStartMacroOnLogin(handle(), params(""), { win: pg.win, importer: pg.importer, after });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(hud.starts, 0, "held until the rebind settles");
  release(null);
  await quiet(() => pr);
  assert.equal(hud.starts, 1);
  // a failed rebind still lets START run
  const pg2 = page();
  pg2.win.__rynthHud = { bridge: hud };
  await quiet(() => boot.maybeStartMacroOnLogin(handle(), params(""), { win: pg2.win, importer: pg2.importer, after: Promise.reject(new Error("rebind failed")) }));
  assert.equal(hud.starts, 2);
});

await check("end to end through the REAL HUD bridge: THIS character's stored stop is cleared, the bot boots unheld", async () => {
  const pg = page();
  const H = handle();
  pg.win.__sessionHandle = H;
  opStop.latchBotStop(undefined, ME); // STOP pressed last session
  opStop.latchBotStop(undefined, OTHER); // another character's tab
  const bridge = createHudBridge({ win: pg.win, storage: localStorage, importer: pg.importer, moduleUrl: (rel) => new URL(rel, HREF).href });
  pg.win.__rynthHud = { bridge };
  const { r } = await quiet(() => boot.maybeStartMacroOnLogin(H, params(""), { win: pg.win, importer: pg.importer }));
  assert.equal(r, "hud");
  assert.equal(pg.made.length, 1, "booted");
  assert.equal(pg.made[0].cfg.startHeld, undefined, "not held: the stop was cleared first");
  assert.equal(pg.win.__bot, pg.made[0]);
  assert.equal(opStop.isBotStopLatched(undefined, ME), false);
  assert.equal(opStop.isBotStopLatched(undefined, OTHER), true, "another character's stop is left alone");
  assert.equal(pg.win.__botBootSpec.source, "hud", "a takeover rebinds it the HUD way");
});

await check("no HUD: boot.js runs START's steps — clear the stop, boot with the USER profile's overrides, resume if held", async () => {
  const pg = page({ userProfile: { name: "Hunt", settings: { LootMinValue: 2500 } } });
  const H = handle();
  opStop.latchBotStop(undefined, ME);
  const { r, logs } = await quiet(() => boot.maybeStartMacroOnLogin(H, params(""), { win: pg.win, importer: pg.importer }));
  assert.equal(r, "booted");
  assert.equal(pg.made.length, 1);
  assert.equal(pg.made[0].h, H);
  assert.deepEqual(pg.made[0].cfg.loot, { minValue: 2500 }, "hudBootOverrides() of the active user profile");
  assert.equal(pg.made[0].cfg.startHeld, undefined);
  assert.equal(opStop.isBotStopLatched(undefined, ME), false);
  assert.ok(logs.includes("[rynth] StartMacroOnLogin: macro started (booted)"));
  // Default profile: the page URL's params only; a bot that still comes up held is resumed
  const pg2 = page();
  pg2.setHeldAtBoot(true);
  await quiet(() => boot.maybeStartMacroOnLogin(handle(), params(""), { win: pg2.win, importer: pg2.importer }));
  assert.equal(pg2.made.length, 1);
  assert.equal(pg2.made[0].cfg.loot, undefined, "Default: no overrides");
  assert.equal(pg2.made[0].resumes, 1, "START means go");
  assert.equal(pg2.made[0].held, false);
});

await check("no HUD, a bot already on this session: a held one is resumed, a running one left alone", async () => {
  const pg = page();
  const H = handle();
  const bot = { held: true, resumes: 0 };
  bot.control = { state: () => ({ stopped: bot.held }), stop() {}, resume() { bot.resumes++; bot.held = false; }, isStopped: () => bot.held };
  Object.assign(pg.win, { __bot: bot, __botHandle: H });
  let out = await quiet(() => boot.maybeStartMacroOnLogin(H, params(""), { win: pg.win, importer: pg.importer }));
  assert.equal(out.r, "resumed");
  assert.equal(bot.resumes, 1);
  pg.win.__botLoginStartHandle = null;
  out = await quiet(() => boot.maybeStartMacroOnLogin(H, params(""), { win: pg.win, importer: pg.importer }));
  assert.equal(out.r, "running");
  assert.equal(bot.resumes, 1);
  assert.deepEqual(out.logs, [], "nothing done, nothing said");
  assert.equal(pg.made.length, 0, "no second bot");
});

await check("no page entry yet: the profile is read from rynth/vt/settings without installing window.__rynthVt", async () => {
  const pg = page({ rsEntry: false });
  const hud = fakeHud();
  pg.win.__rynthHud = { bridge: hud };
  const { r } = await quiet(() => boot.maybeStartMacroOnLogin(handle(), params(""), { win: pg.win, importer: pg.importer }));
  assert.equal(r, "hud");
  assert.deepEqual(pg.imports, ["rynth/vt/settings/index.js"]);
  assert.equal(pg.win.__rynthVt, undefined, "the entry is still the HUD's to install");
  // the profile of ANOTHER character on the same page does not count
  const other = page({ rsEntry: false, startOn: false });
  other.sessionOf(String(OTHER)).options.set("StartMacroOnLogin", true);
  other.win.__rynthHud = { bridge: hud };
  const out = await quiet(() => boot.maybeStartMacroOnLogin(handle(ME), params(""), { win: other.win, importer: other.importer }));
  assert.equal(out.r, null);
  assert.equal(hud.starts, 1);
});

await check("never rejects: unknown character (retried later), a refused START, a broken session, no layer", async () => {
  const pg = page();
  const hud = fakeHud();
  pg.win.__rynthHud = { bridge: hud };
  const H0 = handle(0);
  let out = await quiet(() => boot.maybeStartMacroOnLogin(H0, params(""), { win: pg.win, importer: pg.importer }));
  assert.equal(out.r, null);
  assert.equal(pg.win.__botLoginStartHandle, null, "not remembered: its next EnteredWorld may try");
  hud.result = { ok: false, error: "not in the world yet" };
  out = await quiet(() => boot.maybeStartMacroOnLogin(handle(), params(""), { win: pg.win, importer: pg.importer }));
  assert.equal(out.r, null);
  assert.match(out.warns.join("\n"), /\[rynth\] StartMacroOnLogin failed: Error: not in the world yet/);
  const broken = page();
  broken.win.__rynthVt = { session: () => ({ options: { getValue() { throw new Error("x"); } } }) };
  broken.win.__rynthHud = { bridge: hud };
  out = await quiet(() => boot.maybeStartMacroOnLogin(handle(), params(""), { win: broken.win, importer: broken.importer }));
  assert.equal(out.r, null);
  const none = page({ rsEntry: false });
  none.win.__rynthHud = { bridge: hud };
  const starts = hud.starts;
  out = await quiet(() => boot.maybeStartMacroOnLogin(handle(), params(""), { win: none.win, importer: async () => { throw new Error("404"); } }));
  assert.equal(out.r, null);
  assert.equal(hud.starts, starts);
  assert.deepEqual(out.warns, [], "no layer is not an error");
});

await check("wiring: client_events.js calls it after maybeAutoBootBot, with that rebind as `after`; boot.js keeps no static import", () => {
  const src = readFileSync(path.join(APP, "app/client_events.js"), "utf8");
  assert.match(src, /import \{ maybeAutoBootBot \} from "\.\.\/rynth\/boot\.js";/, "the pinned import line is untouched");
  assert.match(src, /import \{ maybeStartMacroOnLogin \} from "\.\.\/rynth\/boot\.js";/);
  assert.match(src, /const botRebind = maybeAutoBootBot\(botTargetHandle, \{/);
  assert.match(src, /maybeStartMacroOnLogin\(botTargetHandle, \{ bot: botParams\.get\("bot"\), botVt: botParams\.get\("botVt"\) \}, \{ after: botRebind \}\);/);
  const bsrc = readFileSync(path.join(APP, "rynth/boot.js"), "utf8");
  assert.ok(!/^import\s/m.test(bsrc));
});

console.log(`\nrynth_start_on_login: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
