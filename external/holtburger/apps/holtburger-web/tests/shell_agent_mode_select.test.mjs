// tests/shell_agent_mode_select.test.mjs — 2026-10-18 review follow-up,
// SHELL-3 residual.
//
// `/logout` returns to the retail character screen by reloading into
// `?autoLogin=1&autoSpawn=select`. Two readers took ANY `?autoLogin=1` to mean
// "an agent drives this page": index.html's inline toggle (html.agent-mode —
// chrome stripped, canvas full-bleed) and app/popup_string.js
// popupDialogAgentSession (PopupString as a chat line instead of retail's OK
// dialog). So a person who typed /logout came back in agent mode, while
// app/character_select.js characterSelectWanted already reads
// autoLogin=1 + autoSpawn=select as a person.
//
// CONTRACT
//   [1] the inline toggle (lifted from the shipped index.html and run) and
//       agentModeWanted() agree on every URL, and keep agent mode for the
//       agent / eye-test URLs (autoSpawn=first / Name / 0, ?agent=1) — and
//       drop it for autoSpawn=select (and a plain page);
//   [2] PopupString opens the dialog on the select page; agent / bot pages and
//       ?popupDialog=off keep the chat line;
//   [3] same rule as the character screen: on an autoLogin page without
//       ?agent=1, agent mode is on exactly when the screen is not wanted;
//   [4] the real /logout reload URL (window.__logOutToCharacterSelect, lifted)
//       keeps the layout of the page that logged out: from a manual-Connect
//       page it is a person's page; from an agent-mode page (the desktop
//       shortcut's autoLogin=1&autoSpawn=first, or ?agent=1) it stays agent
//       mode, through sessionStorage hbLogoutAgentReturn holding exactly the
//       return query — another select URL in the same tab is a person's page;
//   [5] no other module reads `?autoLogin` (the sweep this fix did).
//
// Run from apps/holtburger-web/:  node tests/shell_agent_mode_select.test.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const M = await import("../app/popup_string.js");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}

/** The balanced `{…}` block whose head starts at `anchor` (strings/comments skipped). */
function liftBlock(src, anchor, from = 0) {
  const start = src.indexOf(anchor, from);
  if (start < 0) throw new Error(`anchor drifted: ${anchor}`);
  let i = src.indexOf("{", start + anchor.length - 1);
  let depth = 0;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < src.length && src[i] !== c; i += 1) if (src[i] === "\\") i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced block at: ${anchor}`);
}
function runLifted(code, scope) {
  // eslint-disable-next-line no-new-func
  return new Function("__scope", `with (__scope) {\n${code}\n}`)(scope);
}

const HTML = readFileSync(path.join(APP, "index.html"), "utf8");
// The inline <script> right after <body> (it must run before first paint).
const TOGGLE = liftBlock(HTML, "(() => {", HTML.indexOf("// Agent mode toggle")) + ")();";
/** A sessionStorage stand-in. */
function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    has: (k) => m.has(k),
  };
}
/** The root classes the shipped toggle sets for `search` (tab storage `storage`). */
function toggleClasses(search, storage = memStorage()) {
  const classes = new Set();
  runLifted(TOGGLE, {
    window: { location: { search } },
    document: { documentElement: { classList: { add: (c) => classes.add(c) } } },
    sessionStorage: storage,
  });
  return classes;
}
const toggleAgent = (search, storage) => toggleClasses(search, storage).has("agent-mode");

// app/character_select.js characterSelectWanted (+ isOff), lifted as source.
const CS_SRC = readFileSync(path.join(APP, "app", "character_select.js"), "utf8");
const characterSelectWanted = new Function(
  `${liftBlock(CS_SRC, "function isOff(v) {")}\n` +
  `${liftBlock(CS_SRC, "export function characterSelectWanted(search) {").replace(/^export /, "")}\n` +
  "return characterSelectWanted;",
)();

// Agent / eye-test / harness URLs: agent mode exactly as before.
const AGENT = [
  "?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first",
  "?autoLogin=1&account=a&autoSpawn=Tester",
  "?nosw=1&renderer=3d&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=%2BTester2&agent=1",
  "?autoLogin=1&autoSpawn=0",
  "?autoLogin=1&autoSpawn=",
  "?autoLogin=1",
  "?autoLogin=1&autoSpawn=SELECT", // auto_login.js matches `select` exactly: a character name here
  "?agent=1",
  "?agent=1&autoLogin=1&autoSpawn=select", // an explicit agent keeps it
  "?agent=1&hud=none&plugins=none&filmMode=on&autoLogin=1",
];
// A person: the /logout return, an invite link, a plain page.
const HUMAN = [
  "",
  "?nosw=1",
  "?autoLogin=1&autoSpawn=select",
  "?nosw=1&autoLogin=1&autoSpawn=select&account=Pilgrim&bridge_url=wss%3A%2F%2Fb%2Fws&server_host=play.example&server_port=9050",
  "?autoLogin=0&autoSpawn=first",
  "?agent=0",
  "?charSelect=off",
];

console.log("\n[1] index.html's inline toggle == agentModeWanted()");
await check("the toggle keeps agent mode for agent / eye-test URLs", () => {
  for (const q of AGENT) assert.equal(toggleAgent(q), true, q);
});
await check("the toggle leaves autoSpawn=select and plain pages alone", () => {
  for (const q of HUMAN) assert.equal(toggleAgent(q), false, q);
});
await check("agentModeWanted() gives the same answer on every URL", () => {
  for (const q of AGENT) assert.equal(M.agentModeWanted(q), true, q);
  for (const q of HUMAN) assert.equal(M.agentModeWanted(q), false, q);
  for (const q of [...AGENT, ...HUMAN]) assert.equal(M.agentModeWanted(q), toggleAgent(q), q);
});
await check("?hud=none still sets no-hud on its own", () => {
  assert.deepEqual([...toggleClasses("?autoLogin=1&autoSpawn=select&hud=none")], ["no-hud"]);
  assert.deepEqual([...toggleClasses("?autoLogin=1&hud=none")].sort(), ["agent-mode", "no-hud"]);
});

console.log("\n[2] PopupString on the select page");
await check("the /logout return opens retail's OK dialog", () => {
  const q = "?autoLogin=1&autoSpawn=select&account=Pilgrim";
  assert.equal(M.popupDialogAgentSession(q), false);
  assert.equal(M.popupDialogActive(q), true);
  const calls = [];
  assert.equal(M.routePopupString("[Popup] Welcome", 10, { search: q, open: (o) => calls.push(o) }), true);
  assert.deepEqual(calls, [{ message: "Welcome", hideCancel: true, confirmLabel: "OK" }]);
});
await check("agent pages, ?bot=1 and ?popupDialog=off keep the chat line", () => {
  for (const q of [...AGENT, "?bot=1", "?autoLogin=1&autoSpawn=select&bot=1"]) {
    assert.equal(M.popupDialogAgentSession(q), true, q);
    assert.equal(M.popupDialogActive(q), false, q);
  }
  assert.equal(M.popupDialogActive("?autoLogin=1&autoSpawn=select&popupDialog=off"), false);
  assert.equal(M.popupDialogActive("?autoLogin=1&popupDialog=on"), true, "eye-test force still works");
});

console.log("\n[3] same rule as app/character_select.js");
await check("autoLogin pages: agent mode exactly when the character screen is not wanted", () => {
  for (const q of [...AGENT, ...HUMAN]) {
    const p = new URLSearchParams(q);
    if (p.get("autoLogin") !== "1" || p.get("agent") === "1") continue;
    assert.equal(M.agentModeWanted(q), !characterSelectWanted(q), q);
  }
});

console.log("\n[4] the real /logout reload URL");
const LOGOUT = liftBlock(HTML, "window.__logOutToCharacterSelect = async () => {") + ";";
/** /logout on a page at `href` (its layout from the shipped toggle); returns the reload query. */
async function logoutFrom(href, storage) {
  let replaced = null;
  const charlistWaiters = [];
  const agentPage = toggleAgent(new URL(href).search, storage);
  const win = {
    location: { href, replace: (u) => { replaced = u; } },
    addEventListener: (type, fn) => { if (type === "holtburger:charlist") charlistWaiters.push(fn); },
    removeEventListener() {},
    __appendChatLine() {},
    __sessionHandle: { disconnect() {} },
    __hbLoginKey: { server: "127.0.0.1:9000", account: "Pilgrim" },
  };
  runLifted(LOGOUT, {
    window: win,
    document: { documentElement: { classList: { contains: (c) => c === "agent-mode" && agentPage } } },
    loginForm: { querySelector: () => ({ value: "pw" }) },
    __readLocalPose: () => ({ landblockId: 0xa9b40019, x: 1, y: 2, z: 3, onGround: true }),
    __locRecorder: { flush() {} },
    requestLogOff: () => { queueMicrotask(() => { for (const fn of charlistWaiters.splice(0)) fn(); }); return true; },
    sessionStorage: storage,
    setTimeout: (fn, ms) => { if (ms < 1000) fn(); return 0; },
  });
  assert.equal(await win.__logOutToCharacterSelect(), true);
  return new URL(replaced).search;
}
/** popupDialogActive with this tab's storage as globalThis.sessionStorage. */
function popupActiveIn(storage, q) {
  const had = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true, writable: true });
  try { return M.popupDialogActive(q); }
  finally { if (had) Object.defineProperty(globalThis, "sessionStorage", had); else delete globalThis.sessionStorage; }
}
await check("from a manual-Connect page: back as a person (no agent mode, dialogs on)", async () => {
  const tab = memStorage({ [M.LOGOUT_AGENT_RETURN_KEY]: "?stale" });
  const q = await logoutFrom("http://h/apps/holtburger-web/index.html?nosw=1", tab);
  assert.equal(new URLSearchParams(q).get("autoSpawn"), "select");
  assert.equal(tab.has(M.LOGOUT_AGENT_RETURN_KEY), false, "a stale carrier is cleared");
  assert.equal(toggleAgent(q, tab), false, q);
  assert.equal(M.agentModeWanted(q, tab), false, q);
  assert.equal(popupActiveIn(tab, q), true, q);
});
await check("from the desktop shortcut (autoLogin=1&autoSpawn=first): the return stays full-bleed", async () => {
  const tab = memStorage();
  const from = "http://h/apps/holtburger-web/index.html?autoLogin=1&account=Pilgrim&autoSpawn=first";
  assert.equal(toggleAgent(new URL(from).search, tab), true, "agent mode before the /logout");
  const q = await logoutFrom(from, tab);
  assert.equal(new URLSearchParams(q).get("autoSpawn"), "select");
  assert.equal(toggleAgent(q, tab), true, q);
  assert.equal(M.agentModeWanted(q, tab), true, q);
  assert.equal(popupActiveIn(tab, q), false, "the chat line, as before the /logout");
  // The same tab opening another select URL (an invite link) is a person's page.
  const invite = "?autoLogin=1&autoSpawn=select&account=Guest";
  assert.equal(toggleAgent(invite, tab), false);
  assert.equal(M.agentModeWanted(invite, tab), false);
  // Blocked storage: a person's page.
  const blocked = { getItem() { throw new Error("SecurityError"); } };
  assert.equal(toggleAgent(q, blocked), false);
  assert.equal(M.agentModeWanted(q, blocked), false);
});
await check("from an ?agent=1 page: still an agent page", async () => {
  const tab = memStorage();
  const q = await logoutFrom("http://h/apps/holtburger-web/index.html?agent=1&autoLogin=1&autoSpawn=first", tab);
  assert.equal(toggleAgent(q, tab), true, q);
  assert.equal(popupActiveIn(tab, q), false, q);
});

console.log("\n[5] sweep: who reads ?autoLogin");
await check("only the toggle, auto_login.js mechanics, character_select.js and popup_string.js", () => {
  const SKIP = new Set(["node_modules", "pkg", "dist", "shell", "docs", "tests", "harness", "vendor", "legacy", "src"]);
  const readers = new Set();
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) {
        if (!SKIP.has(name) && !name.startsWith("pkg-")) walk(abs, r);
      } else if (/\.(m?js)$/.test(name) && rel) {
        if (/\.get\(\s*["']autoLogin["']\s*\)/.test(readFileSync(abs, "utf8"))) readers.add(r);
      }
    }
  };
  for (const d of ["app", "scene3d", "plugins", "ui", "rynth"]) walk(path.join(APP, d), d);
  if (/\.get\(\s*["']autoLogin["']\s*\)/.test(HTML)) readers.add("index.html");
  assert.deepEqual([...readers].sort(),
    ["app/auto_login.js", "app/character_select.js", "app/popup_string.js", "index.html"]);
  const htmlReads = HTML.match(/\.get\(\s*["']autoLogin["']\s*\)/g) ?? [];
  assert.equal(htmlReads.length, 1, "index.html reads it once (the toggle)");
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
