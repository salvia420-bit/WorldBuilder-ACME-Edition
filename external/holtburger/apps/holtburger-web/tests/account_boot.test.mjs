// tests/account_boot.test.mjs — inventory-session-6 (2026-10-13): ACE's
// AccountBoot (0xF7DC) as retail shows it.
//
// Retail CPlayerSystem::Handle_AccountBooted (acclient.c:400213) formats
// "You have been booted from Asheron's Call%s." and drops to the disconnected
// screen. The wasm recv loop (src/session/messages/login.rs) ends the session
// with ONE kind=4 Disconnected: stringPayload = that line (formatted and
// unit-tested in src/account_boot.rs), u32Payload = 0xF7DC. This pins the JS
// side:
//
//   1. app/account_boot.js — the marker test and accountBootSince() (the
//      kind=4 stash, or start_session's rejection in __bootStateHistory).
//   2. app/client_events.js kind=4 with the marker — the boot line (escaped)
//      in loginStatus + the banner, __lastDisconnect.booted, no bot/agent
//      auto-reload.
//   3. NEGATIVE CONTROL: a plain kind=4 keeps "Disconnected: …", booted=false
//      and still schedules the bot/agent auto-reload.
//   4. source pins: auto_login.js stops on a boot after both waits; the wasm
//      routes AccountBoot to login.rs, which emits the marker and exits; the
//      JS marker is the protocol's AccountBoot opcode.
//
// Run from apps/holtburger-web/:  node tests/account_boot.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOLT = path.resolve(APP, "..", "..");

// Minimal browser globals: the kind=4 arm touches only these.
const created = [];
globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
const storageWrites = [];
globalThis.sessionStorage = { getItem: () => null, setItem(k, v) { storageWrites.push([k, v]); } };
globalThis.document = {
  getElementById: () => null,
  createElement: () => {
    const el = { style: {}, textContent: "" };
    created.push(el);
    return el;
  },
  body: { appendChild() {} },
};

const AB = await import("../app/account_boot.js");
const { dispatchClientEvent, STOP_PUMP } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

const PASSWORD_LINE =
  "You have been booted from Asheron's Call because the password entered for this account was not correct.";

function makeEvt(kind, extra = {}) {
  const evt = { kind, u32Payload: undefined, u32Payload2: undefined, stringPayload: "", freed: 0, ...extra };
  evt.free = () => { evt.freed += 1; };
  return evt;
}

function makeDeps() {
  const state = { spawningCharId: null, spawnedPlayerGuid: null, enteredWorld: true, lastPredictionTime: 0 };
  const D = {
    loginStatus: { innerHTML: "" },
    __resetEntDrainPending() {},
    setLocalPlayerGuid() {},
    getLocalPlayerGuid: () => null,
    setBootState() {},
    EVT_GUARD_ON: true,
    CMD_INTERP_ON: false,
    CAST_MOVE_ON: false,
  };
  for (const k of Object.keys(state)) {
    Object.defineProperty(D, k, { get: () => state[k], set: (v) => { state[k] = v; }, enumerable: true });
  }
  return D;
}

// Run one kind=4 with setTimeout / console.warn captured.
function dispatchDisconnect(evt, search) {
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realWarn = console.warn;
  globalThis.location.search = search;
  globalThis.setTimeout = (fn, ms) => { timers.push(ms); return 0; };
  console.warn = () => {};
  created.length = 0;
  storageWrites.length = 0;
  window.__bootState = "in-world";
  const D = makeDeps();
  let r;
  try {
    r = dispatchClientEvent(evt, D);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    console.warn = realWarn;
    globalThis.location.search = "";
  }
  return { r, D, timers, banner: created[0]?.textContent ?? null };
}

console.log("account_boot — AccountBoot (0xF7DC) → retail boot line, terminal");

// 1. pure helpers
{
  check("marker is 0xF7DC", AB.ACCOUNT_BOOT_MARKER === 0xf7dc);
  check("a kind=4 carrying 0xF7DC is a boot", AB.isAccountBootDisconnect({ u32Payload: 0xf7dc }));
  check("a kind=4 with no u32Payload is not a boot",
    !AB.isAccountBootDisconnect({ u32Payload: undefined }) && !AB.isAccountBootDisconnect({}) &&
    !AB.isAccountBootDisconnect({ u32Payload: null }) && !AB.isAccountBootDisconnect(null));
  check("a kind=4 with another u32Payload is not a boot",
    !AB.isAccountBootDisconnect({ u32Payload: 0 }) && !AB.isAccountBootDisconnect({ u32Payload: 0xf7c1 }));

  const t0 = 1_000_000;
  check("accountBootSince: a booted __lastDisconnect after `since` gives its line",
    AB.accountBootSince({ ts: t0 + 5, reason: PASSWORD_LINE, booted: true }, [], t0) === PASSWORD_LINE);
  check("accountBootSince: a booted __lastDisconnect before `since` is ignored",
    AB.accountBootSince({ ts: t0 - 5, reason: PASSWORD_LINE, booted: true }, [], t0) === null);
  check("accountBootSince: a plain disconnect is not a boot",
    AB.accountBootSince({ ts: t0 + 5, reason: "recv_message: closed", booted: false }, [], t0) === null);
  const history = [
    { state: "connecting", message: "127.0.0.1:9000 as acct", ts: t0 + 1 },
    { state: "error", message: `start_session: ${PASSWORD_LINE}`, ts: t0 + 2 },
  ];
  check("accountBootSince: start_session's rejection in __bootStateHistory gives the line",
    AB.accountBootSince(null, history, t0) === PASSWORD_LINE, AB.accountBootSince(null, history, t0));
  check("accountBootSince: the same rejection from an earlier attempt is ignored",
    AB.accountBootSince(null, history, t0 + 3) === null);
  check("accountBootSince: an ordinary connect error is not a boot",
    AB.accountBootSince(null, [{ state: "error", message: "start_session: no CharacterList within 60s", ts: t0 + 2 }], t0) === null);
  check("accountBootSince: a non-error entry carrying the text is ignored",
    AB.accountBootSince(null, [{ state: "connecting", message: PASSWORD_LINE, ts: t0 + 2 }], t0) === null);
}

// 2. kind=4 with the boot marker, bot context
{
  const evt = makeEvt(ClientEventKind.DISCONNECTED, { stringPayload: PASSWORD_LINE, u32Payload: 0xf7dc });
  const { r, D, timers, banner } = dispatchDisconnect(evt, "?bot=1");
  const html = D.loginStatus.innerHTML;
  check("boot: returns STOP_PUMP", r === STOP_PUMP);
  check("boot: the event is freed once", evt.freed === 1, `freed=${evt.freed}`);
  check("boot: loginStatus shows retail's line (escaped)",
    html.includes("You have been booted from Asheron&#39;s Call because the password entered for this account was not correct."), html);
  check("boot: loginStatus drops the transport wording", !html.includes("Disconnected:") && !html.includes("Reload the page to retry."), html);
  check("boot: __lastDisconnect.booted is set, reason raw",
    window.__lastDisconnect?.booted === true && window.__lastDisconnect?.reason === PASSWORD_LINE,
    JSON.stringify(window.__lastDisconnect));
  check("boot: the banner carries the line", banner === `DISCONNECTED — ${PASSWORD_LINE}`, String(banner));
  check("boot: no bot/agent auto-reload is scheduled", timers.length === 0 && storageWrites.length === 0,
    `timers=${JSON.stringify(timers)} writes=${storageWrites.length}`);
  check("boot: auto_login sees it as terminal",
    AB.accountBootSince(window.__lastDisconnect, [], window.__lastDisconnect.ts) === PASSWORD_LINE);
}

// 2b. a boot line with markup is escaped in loginStatus (admin @boot reason)
{
  const line = "You have been booted from Asheron's Call - <b>x</b>.";
  const evt = makeEvt(ClientEventKind.DISCONNECTED, { stringPayload: line, u32Payload: 0xf7dc });
  const { D } = dispatchDisconnect(evt, "");
  check("boot: server markup is escaped",
    D.loginStatus.innerHTML.includes("&lt;b&gt;x&lt;/b&gt;") && !D.loginStatus.innerHTML.includes("<b>x"), D.loginStatus.innerHTML);
}

// 3. NEGATIVE CONTROL: plain kind=4 unchanged, auto-reload still armed
{
  const evt = makeEvt(ClientEventKind.DISCONNECTED, { stringPayload: "recv_message: closed" });
  const { r, D, timers, banner } = dispatchDisconnect(evt, "?bot=1");
  check("plain: returns STOP_PUMP", r === STOP_PUMP);
  check("plain: loginStatus keeps the Disconnected wording",
    D.loginStatus.innerHTML.includes("Disconnected: <code>recv_message: closed</code>") &&
    D.loginStatus.innerHTML.includes("Reload the page to retry."), D.loginStatus.innerHTML);
  check("plain: __lastDisconnect.booted is false", window.__lastDisconnect?.booted === false);
  check("plain: the banner keeps its wording",
    banner === "DISCONNECTED — session dead, reload to reconnect (recv_message: closed)", String(banner));
  check("plain: the bot/agent auto-reload is still scheduled", timers.length === 1 && timers[0] === 10000,
    JSON.stringify(timers));
}

// 4. source pins
{
  const strip = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const auto = strip(readFileSync(path.join(APP, "app", "auto_login.js"), "utf8"));
  const connectAt = auto.indexOf("await waitForConnectOutcome(");
  const spawnAt = auto.indexOf("await waitForSpawnOutcome(");
  const bootAfterConnect = auto.indexOf("accountBootSince(", connectAt);
  const bootAfterSpawn = auto.indexOf("accountBootSince(", spawnAt);
  check("auto_login imports accountBootSince", /import \{ accountBootSince \} from "\.\/account_boot\.js";/.test(auto));
  check("auto_login checks for a boot after the connect wait, before the retry branches",
    connectAt > 0 && bootAfterConnect > connectAt && bootAfterConnect < auto.indexOf('connectOutcome === "kick"', connectAt));
  check("auto_login checks for a boot after the spawn wait",
    spawnAt > 0 && bootAfterSpawn > spawnAt && bootAfterSpawn < auto.indexOf('spawnOutcome === "char-in-world"', spawnAt));

  const mod = readFileSync(path.join(APP, "src", "session", "messages", "mod.rs"), "utf8");
  check("wasm dispatch routes AccountBoot to login.rs",
    /GameMessage::AccountBoot \{ \.\. \}\) => login::handle/.test(mod));
  const login = readFileSync(path.join(APP, "src", "session", "messages", "login.rs"), "utf8");
  const arm = login.slice(login.indexOf("GameMessage::AccountBoot(data) =>"));
  check("login.rs AccountBoot arm emits a marked kind=4 and exits",
    login.includes("GameMessage::AccountBoot(data) =>") &&
    /kind: CLIENT_EVENT_KIND_DISCONNECTED/.test(arm.slice(0, 2000)) &&
    /u32_payload: Some\(crate::account_boot::ACCOUNT_BOOT_DISCONNECT_MARKER\)/.test(arm.slice(0, 2000)) &&
    /return LoopFlow::Exit;/.test(arm.slice(0, 2000)));
  const opcodes = readFileSync(path.join(HOLT, "crates", "holtburger-protocol", "src", "opcodes.rs"), "utf8");
  check("the JS marker is the protocol's AccountBoot opcode",
    /AccountBoot = 0xF7DC,/.test(opcodes) && AB.ACCOUNT_BOOT_MARKER === 0xf7dc);
}

// 5. index.html's start_session catch (review N-inv-session-input-R1): a
//    pre-CharacterList boot rejects with the server's reason, so the catch
//    must escape it, and a boot line drops the wsbridge/ACE hint.
{
  const hostile =
    "You have been booted from Asheron's Call <img src=x onerror=alert(1)>.";
  const bootHtml = AB.loginFailedStatusHtml(hostile);
  check("catch: a boot line is escaped",
    !bootHtml.includes("<img") && bootHtml.includes("&lt;img src=x onerror=alert(1)&gt;"), bootHtml);
  const pwHtml = AB.loginFailedStatusHtml(PASSWORD_LINE);
  check("catch: a boot shows retail's line alone (no 'Login failed', no wsbridge hint)",
    pwHtml.includes("You have been booted from Asheron&#39;s Call because the password") &&
    !pwHtml.includes("Login failed") && !pwHtml.includes("wsbridge"), pwHtml);
  const plainHtml = AB.loginFailedStatusHtml("recv loop exited before CharacterList arrived");
  check("catch: a non-boot failure keeps 'Login failed' + the wsbridge hint",
    plainHtml.includes("Login failed: <code>recv loop exited before CharacterList arrived</code>") &&
    plainHtml.includes("Check that holtburger-wsbridge is listening"), plainHtml);
  const plainHostile = AB.loginFailedStatusHtml("<b>x</b>");
  check("catch: a non-boot failure is escaped too",
    plainHostile.includes("<code>&lt;b&gt;x&lt;/b&gt;</code>"), plainHostile);
  check("catch: null/undefined do not throw", typeof AB.loginFailedStatusHtml(undefined) === "string");

  const html = readFileSync(path.join(APP, "index.html"), "utf8");
  check("index.html imports loginFailedStatusHtml",
    /import \{ loginFailedStatusHtml \} from "\.\/app\/account_boot\.js";/.test(html));
  const catchAt = html.indexOf('setBootState("error", `start_session: ${msg}`)');
  const catchBody = catchAt > 0 ? html.slice(html.lastIndexOf("} catch (err) {", catchAt), catchAt) : "";
  check("index.html start_session catch renders through loginFailedStatusHtml(msg)",
    catchBody.includes("loginStatus.innerHTML = loginFailedStatusHtml(msg);") &&
    !/innerHTML[\s\S]*\$\{msg\}/.test(catchBody), catchBody.slice(0, 200));
}

console.log(`\naccount_boot: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
