// tests/login_retail_rules.test.mjs — round-4 login-2 / login-3 (2026-10-08).
//
//   login-2: kind 20 CharacterError → retail gmUIFlow::RecvNotice_
//     CharacterError (acclient.c:183837) sentence; fatal codes hide the
//     character list ("back to logon"); 2 / 7 / 22 print nothing; the
//     __lastCharacterError stash auto_login.js reads keeps code + raw name.
//   login-3: pending-deletion rows (ACE secondsGreyedOut = 1) sort last with
//     their server slot kept, no 1970 date; the delete confirmation is the
//     retail DELETE-typed text.
//
// NEGATIVE CONTROLS: ?retailCharErrors=off restores the raw
// "[ACE] CharacterError: <code>" line; a list without greyed rows keeps its
// order.
//
// Run from apps/holtburger-web/:  node tests/login_retail_rules.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const selection = { hidden: false };
globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.document = {
  getElementById: (id) => (id === "selection" ? selection : null),
  createElement: () => ({ style: {} }),
  body: { appendChild() {} },
};

const R = await import("../app/login_ui_rules.js");
const { dispatchClientEvent } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (e) { failed += 1; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

function deps() {
  return {
    loginStatus: { innerHTML: "(list banner)" },
    __resetEntDrainPending() {}, setLocalPlayerGuid() {}, getLocalPlayerGuid: () => null,
    setBootState() {}, EVT_GUARD_ON: true, CMD_INTERP_ON: false, CAST_MOVE_ON: false,
  };
}
function charError(code, name = "X") {
  const evt = { kind: ClientEventKind.CHARACTER_ERROR, u32Payload: code, u32Payload2: 0, stringPayload: name, free() {} };
  const D = deps();
  const warn = console.warn;
  console.warn = () => {};
  try { dispatchClientEvent(evt, D); } finally { console.warn = warn; }
  return D;
}

console.log("login-2: CharacterError");

check("code 0x0D (in world) → retail sentence, list kept", () => {
  selection.hidden = false;
  const D = charError(0x0D, "EnterGameCharacterInWorld");
  assert.match(D.loginStatus.innerHTML, /One of your characters is still in the world\. Please try again in a few minutes\./);
  assert.doesNotMatch(D.loginStatus.innerHTML, /CharacterError/);
  assert.equal(selection.hidden, false);
  assert.equal(window.__lastCharacterError.code, 0x0D, "auto_login stash keeps the code");
  assert.equal(window.__lastCharacterError.name, "EnterGameCharacterInWorld", "and the raw name");
  assert.equal(window.__lastCharacterError.mode, "select");
});

check("code 6 (delete failed) → stays on the list", () => {
  selection.hidden = false;
  const D = charError(6);
  assert.match(D.loginStatus.innerHTML, /Server could not delete your character\./);
  assert.equal(selection.hidden, false);
});

check("fatal codes (1, 0x15, 0x18, …) → retail text + list hidden", () => {
  for (const code of [1, 3, 4, 8, 9, 10, 0x0E, 0x15, 0x18]) {
    selection.hidden = false;
    const D = charError(code);
    assert.equal(R.characterErrorInfo(code).mode, "fatal", `0x${code.toString(16)}`);
    assert.ok(D.loginStatus.innerHTML.includes(R.characterErrorInfo(code).text.replace(/'/g, "&#39;"))
      || D.loginStatus.innerHTML.includes(R.characterErrorInfo(code).text), `0x${code.toString(16)} text`);
    assert.equal(selection.hidden, true, `0x${code.toString(16)} hides the list`);
  }
  assert.match(charError(0x15).loginStatus.innerHTML, /server is full currently/);
});

check("codes 2 / 7 / 22 print nothing (stash still updated)", () => {
  for (const code of [2, 7, 22]) {
    selection.hidden = false;
    const D = charError(code, `C${code}`);
    assert.equal(D.loginStatus.innerHTML, "(list banner)", `0x${code.toString(16)}`);
    assert.equal(selection.hidden, false);
    assert.equal(window.__lastCharacterError.code, code);
    assert.equal(window.__lastCharacterError.mode, "ignore");
  }
});

check("retail mode table matches RecvNotice_CharacterError", () => {
  const fatal = [1, 3, 4, 8, 9, 10, 14, 21, 24];
  const select = [5, 6, 11, 12, 13, 15, 16, 17, 18, 19, 20, 23];
  for (const c of fatal) assert.equal(R.characterErrorInfo(c).mode, "fatal", String(c));
  for (const c of select) assert.equal(R.characterErrorInfo(c).mode, "select", String(c));
  for (const c of [0, 2, 7, 22, 25, 99]) assert.equal(R.characterErrorInfo(c).mode, "ignore", String(c));
});

check("negative control: ?retailCharErrors=off → raw label line", () => {
  location.search = "?retailCharErrors=off";
  try {
    selection.hidden = false;
    const D = charError(0x0D, "EnterGameCharacterInWorld");
    assert.match(D.loginStatus.innerHTML, /CharacterError: <code>EnterGameCharacterInWorld<\/code> \(0xd\)/);
    assert.equal(selection.hidden, false);
  } finally {
    location.search = "";
  }
});

console.log("login-3: character list");

check("greyed (pending deletion) rows sort last and keep their server slot", () => {
  const list = [
    { id: 1, name: "Ann", deleteTime: 0 },
    { id: 2, name: "Bob", deleteTime: 1 },
    { id: 3, name: "Cy", deleteTime: 0 },
  ];
  const rows = R.orderCharacterRows(list);
  assert.deepEqual(rows.map((r) => [r.c.name, r.slot, r.greyed]), [["Ann", 0, false], ["Cy", 2, false], ["Bob", 1, true]]);
  const plain = R.orderCharacterRows(list.map((c) => ({ ...c, deleteTime: 0 })));
  assert.deepEqual(plain.map((r) => r.slot), [0, 1, 2], "negative control: order unchanged");
});

check("delete confirmation is retail's and needs DELETE typed", () => {
  const t = R.deleteConfirmationText("Bob");
  assert.match(t, /^WARNING! Bob will be deleted\. Restoration can be attempted only within one hour of deletion/);
  assert.match(t, /type 'DELETE' in the box below/);
  assert.equal(R.deleteConfirmationAccepted("DELETE"), true);
  assert.equal(R.deleteConfirmationAccepted(" delete "), true);
  assert.equal(R.deleteConfirmationAccepted("yes"), false);
  assert.equal(R.deleteConfirmationAccepted(null), false);
});

check("index.html wires the rules (no epoch date, prompt gate, slot kept)", () => {
  const html = readFileSync(path.join(APP, "index.html"), "utf8");
  assert.match(html, /import \{\s*orderCharacterRows, retailCharListEnabled, deleteConfirmationText, deleteConfirmationAccepted,\s*requestLogOff, logOffOnUnloadEnabled,\s*\} from "\.\/app\/login_ui_rules\.js";/);
  assert.match(html, /\? orderCharacterRows\(list\)/);
  assert.match(html, /\[pending deletion\]/);
  assert.match(html, /deleteConfirmationAccepted\(typed\)/);
  assert.match(html, /data-delete-slot="\$\{slot\}"/, "delete still uses the server slot");
});

console.log("login-1: log off on page teardown");

check("requestLogOff prints retail's line and sends 0xF653 via logOffCharacter", () => {
  const lines = [];
  let sent = 0;
  assert.equal(R.requestLogOff({ logOffCharacter: () => { sent += 1; } }, (t) => lines.push(t)), true);
  assert.equal(sent, 1);
  assert.deepEqual(lines, ["Logging off..."]);
  assert.equal(R.requestLogOff({}, (t) => lines.push(t)), false, "pre-round-4 pkg: no export, nothing printed");
  assert.equal(lines.length, 1);
  assert.equal(R.requestLogOff({ logOffCharacter: () => { throw new Error("closed"); } }), false);
});

check("pagehide logs an in-world character off before freeing the handle", () => {
  const html = readFileSync(path.join(APP, "index.html"), "utf8");
  const i = html.indexOf('window.addEventListener("pagehide"');
  // The whole handler (to its last statement), not a fixed window: the
  // 2026-10-09 location flush + disconnect pushed free() past 900 chars.
  const end = html.indexOf("window.__sessionHandle = null;", i);
  const body = html.slice(i, end);
  assert.ok(i > 0 && end > i);
  assert.ok(body.indexOf("requestLogOff(h") > 0 && body.indexOf("requestLogOff(h") < body.indexOf("h.free()"),
    "log-off is requested before free()");
  assert.match(body, /logOffOnUnloadEnabled\(\)/);
  assert.equal(R.logOffOnUnloadEnabled("?logOffOnUnload=off"), false);
  assert.equal(R.logOffOnUnloadEnabled(""), true);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
