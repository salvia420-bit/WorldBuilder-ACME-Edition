// tests/shell_logout_endpoint.test.mjs — 2026-10-18 review, SHELL-3.
//
// `/logout` returns to the character screen by reloading into
// `?autoLogin=1&autoSpawn=select`. The reload URL kept only the current query
// plus autoLogin / autoSpawn / account, and nothing persists the bridge /
// server fields, so a player who picked a community shard (or typed one, or
// changed a URL-param server) came back to the HTML defaults
// (ws://127.0.0.1:8080/, 127.0.0.1:9000) and auto_login sent the shard's
// account + password there.
//
// Runs three pieces of the shipped index.html, lifted and executed:
//   1. the login submit prologue (form read → window.__hbLoginKey /
//      __hbLoginEndpoint → the "Connecting to …" status line);
//   2. window.__logOutToCharacterSelect (the reload URL);
//   3. the boot pre-fill of bridge_url / server_host / server_port.
// The round trip must log back in where the session was.
//
// Also (review extra): the "Connecting to …" line escapes the host and bridge
// URL — the host comes from the community serverslist or a URL param.
//
// NEGATIVE CONTROL: without a recorded endpoint the reload URL keeps the
// old behaviour (no server params added).
//
// Run from apps/holtburger-web/:  node tests/shell_logout_endpoint.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { escapeHtml } = await import("../app/dom_utils.js");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}

const HTML = readFileSync(path.join(APP, "index.html"), "utf8");
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
/** Source from `startAnchor` to the end of the line holding `endAnchor`. */
function liftLines(src, startAnchor, endAnchor) {
  const start = src.indexOf(startAnchor);
  if (start < 0) throw new Error(`anchor drifted: ${startAnchor}`);
  const e = src.indexOf(endAnchor, start);
  if (e < 0) throw new Error(`anchor drifted: ${endAnchor}`);
  return src.slice(start, src.indexOf("\n", e));
}
function runLifted(code, scope) {
  // eslint-disable-next-line no-new-func
  return new Function("__scope", `with (__scope) {\n${code}\n}`)(scope);
}

const SUBMIT_PROLOGUE = "(() => {\n" +
  liftLines(HTML, "const fd = new FormData(loginForm);", "and sending LoginRequest…`;") + "\n})();";
const LOGOUT = liftBlock(HTML, "window.__logOutToCharacterSelect = async () => {") + ";";
const PREFILL = (() => {
  const head = 'const bridgeUrlParam = bootParams.get("bridge_url");';
  const tail = liftBlock(HTML, "if (serverPortParam) {", HTML.indexOf(head));
  return HTML.slice(HTML.indexOf(head), HTML.indexOf(tail) + tail.length);
})();

/** A login form whose named fields hold `values`. */
function makeForm(values) {
  const fields = {};
  for (const [k, v] of Object.entries(values)) fields[k] = { value: v };
  const submitBtn = { dataset: {}, textContent: "Connect" };
  return {
    fields,
    submitBtn,
    querySelector(sel) {
      if (sel === "button[type=submit]") return submitBtn;
      const m = /^\[name="([a-z_]+)"\]$/.exec(sel);
      return m ? fields[m[1]] ?? null : null;
    },
  };
}
class FakeFormData {
  constructor(form) { this.form = form; }
  get(name) { return this.form.fields[name]?.value ?? null; }
}

/** A page at `href`: submit the form, play, /logout; returns the reload URL. */
async function loginThenLogout(href, values, { recordEndpoint = true } = {}) {
  const loginForm = makeForm(values);
  const loginStatus = { innerHTML: "" };
  let replaced = null;
  const charlistWaiters = [];
  const win = {
    location: { href, replace: (u) => { replaced = u; } },
    addEventListener: (type, fn) => { if (type === "holtburger:charlist") charlistWaiters.push(fn); },
    removeEventListener() {},
    __appendChatLine() {},
  };
  const scope = {
    window: win, loginForm, loginStatus, escapeHtml, FormData: FakeFormData,
    setBootState() {},
  };
  if (recordEndpoint) runLifted(SUBMIT_PROLOGUE, scope);
  else win.__hbLoginKey = { server: `${values.server_host}:${values.server_port}`, account: values.account };
  // In the world; ACE answers the log-off with a CharacterList.
  win.__sessionHandle = { disconnect() {} };
  runLifted(LOGOUT, {
    ...scope,
    __readLocalPose: () => ({ landblockId: 0xa9b40019, x: 1, y: 2, z: 3, onGround: true }),
    __locRecorder: { flush() {} },
    requestLogOff: () => { queueMicrotask(() => { for (const fn of charlistWaiters.splice(0)) fn(); }); return true; },
    sessionStorage: { setItem() {} },
    setTimeout: (fn, ms) => { if (ms < 1000) fn(); return 0; },
  });
  assert.equal(await win.__logOutToCharacterSelect(), true);
  return { url: new URL(replaced), loginStatus, win };
}

/** The reloaded page's boot pre-fill: what the form shows for `url`. */
function prefill(url) {
  const form = makeForm({ bridge_url: "ws://127.0.0.1:8080/", server_host: "127.0.0.1", server_port: "9000" });
  runLifted(PREFILL, { bootParams: url.searchParams, loginForm: form });
  return Object.fromEntries(Object.entries(form.fields).map(([k, f]) => [k, f.value]));
}

const SHARD = { account: "Pilgrim", password: "pw", bridge_url: "wss://bridge.shard.example/ws", server_host: "play.shard.example", server_port: "9050" };

console.log("\nSHELL-3: /logout returns to the server the session used");
await check("a picked shard: the reload URL carries its bridge + host + port", async () => {
  const { url } = await loginThenLogout("http://h/apps/holtburger-web/index.html?nosw=1", SHARD);
  const p = url.searchParams;
  assert.equal(p.get("autoLogin"), "1");
  assert.equal(p.get("autoSpawn"), "select");
  assert.equal(p.get("account"), "Pilgrim");
  assert.equal(p.get("password"), null, "never in the URL");
  assert.equal(p.get("nosw"), "1", "the rest of the query is kept");
  assert.equal(p.get("bridge_url"), SHARD.bridge_url);
  assert.equal(p.get("server_host"), SHARD.server_host);
  assert.equal(p.get("server_port"), SHARD.server_port);
});
await check("round trip: the reloaded form logs in to that shard, not the defaults", async () => {
  const { url } = await loginThenLogout("http://h/apps/holtburger-web/index.html", SHARD);
  assert.deepEqual(prefill(url), { bridge_url: SHARD.bridge_url, server_host: SHARD.server_host, server_port: SHARD.server_port });
});
await check("a stale URL-param server is replaced by the one the player switched to", async () => {
  const { url } = await loginThenLogout(
    "http://h/apps/holtburger-web/index.html?server_host=old.example&server_port=9000&bridge_url=ws%3A%2F%2Fold%2F",
    SHARD,
  );
  assert.equal(url.searchParams.get("server_host"), SHARD.server_host);
  assert.equal(url.searchParams.get("server_port"), SHARD.server_port);
  assert.equal(url.searchParams.get("bridge_url"), SHARD.bridge_url);
});
await check("negative control: no recorded endpoint → no server params added", async () => {
  const { url } = await loginThenLogout("http://h/apps/holtburger-web/index.html", SHARD, { recordEndpoint: false });
  assert.equal(url.searchParams.get("autoSpawn"), "select");
  assert.equal(url.searchParams.get("server_host"), null);
  assert.equal(url.searchParams.get("bridge_url"), null);
});

console.log("\nextra: the Connecting line escapes serverslist / URL-param text");
await check("a hostile host from the picker lands escaped", async () => {
  const evil = `<img src=x onerror="window.__pwned=1">`;
  const { loginStatus } = await loginThenLogout("http://h/apps/holtburger-web/index.html",
    { ...SHARD, server_host: evil, bridge_url: `ws://"><b>x</b>` });
  assert.ok(loginStatus.innerHTML.includes(escapeHtml(evil)), loginStatus.innerHTML);
  assert.ok(!loginStatus.innerHTML.includes("<img") && !loginStatus.innerHTML.includes("<b>"), loginStatus.innerHTML);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
