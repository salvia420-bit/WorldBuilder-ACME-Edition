// tests/status_indicators_logoff.test.mjs — inventory-session-5 (2026-10-13).
//
// Retail's HUD has two ways to log off and holtburger had neither (only the
// /logout chat command): the indicator strip's seventh button, LogoffButton
// 0x100000FA (gmFloatyIndicatorsUI::ListenToElementMessage,
// acclient.c:259108), and Options → Gameplay "Exit to Character Selection",
// 0x10000203 (gmGameplayOptionsUI::ListenToElementMessage, :215373). Both
// raise CM_UI::SendNotice_EndCharacterSession(1) → the Yes / No dialog
// ID_Client_EndCharacterSessionConfirm (gmGamePlayUI::
// RecvNotice_EndCharacterSession :280799, table enum 0x10000001 =
// StringTable 0x23000001) → the log-off.
//
// CONTRACT
//   [a] layout: LogoffButton at retail x=125, y=5, 20×20 with Normal
//       0x060074B1 / Normal_pressed 0x060074B2 (cross-checked against the
//       committed layout dump); retail frame 150 wide; our strip = retail
//       frame + the 2-px gutters; the six indicators are unchanged.
//   [b] requestEndCharacterSession: no log-off path → nothing; asks via
//       __modalConfirm with the DAT text (English fallback); logs off only
//       on Yes; one dialog at a time (m_logoutContext).
//   [c] mounted strip: the button is hidden (frame back to six slots) and
//       inert while window.__logOutToCharacterSelect is absent; shown once it
//       appears; a click asks first and logs off only on Yes.
//   [d] options-panel.js: the Gameplay page's first control is "Exit to
//       Character Selection", gated on the log-off path, same handler.
//
// Run from apps/holtburger-web/:  node tests/status_indicators_logoff.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

// ─── DOM shim (after test_status_indicators.mjs, plus listener capture) ───
const intervals = [];
function installDomShim() {
  function mkClassList() {
    const set = new Set();
    return {
      add(c) { set.add(c); },
      remove(c) { set.delete(c); },
      contains(c) { return set.has(c); },
      toggle(c, force) {
        const want = force === undefined ? !set.has(c) : !!force;
        if (want) set.add(c); else set.delete(c);
        return want;
      },
    };
  }
  const proto = {
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    remove() { this.parentNode?.removeChild(this); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const l = this.listeners[type];
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    },
    fire(type, ev = {}) { for (const fn of [...(this.listeners[type] || [])]) fn(ev); },
    querySelector() { return null; },
    get isConnected() { return true; },
  };
  const mkEl = () => Object.assign(Object.create(proto), {
    children: [], attrs: {}, style: {}, dataset: {}, listeners: {},
    classList: mkClassList(), parentNode: null, ownerDocument: null,
  });
  globalThis.document = {
    head: mkEl(),
    body: mkEl(),
    createElement() { const el = mkEl(); el.ownerDocument = globalThis.document; return el; },
    getElementById() { return null; },
  };
  globalThis.window = globalThis;
  globalThis.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0;
  globalThis.clearTimeout = () => {};
}
installDomShim();

const ECS = await import("../ui/end_character_session.js");
const { computeStrHash } = await import("../app/login_ui_rules.js");
const SI = await import("../plugins/status-indicators.js");
const T = SI.__test;

// ── [a] ────────────────────────────────────────────────────────────────
test("[a] LogoffButton sits at retail x=125, y=5, 20×20 with its own sprites", () => {
  const b = T.LOGOFF_BUTTON;
  assert.equal(b.elementId, 0x100000FA);
  assert.deepEqual([b.x, b.y, b.width, b.height], [125, 5, 20, 20]);
  assert.equal(b.normal, "0x060074B1");
  assert.equal(b.pressed, "0x060074B2");
  // Seventh slot (read_order 23) of the edge-to-edge retail row.
  assert.equal(T.retailSlotX(T.INDICATORS.length), 125);
  assert.equal(T.retailSlotX(0), 5, "LinkStatus at x=5");
  for (const id of [b.normal, b.pressed]) {
    assert.ok(existsSync(new URL(`../data/ui-sprites/${id}.png`, import.meta.url)), `${id}.png exported`);
  }
});

test("[a] the geometry matches data/retail-layouts/0x21000071.json", () => {
  const dump = JSON.parse(src("data/retail-layouts/0x21000071.json"));
  const all = [];
  const walk = (e) => {
    if (Array.isArray(e)) { e.forEach(walk); return; }
    if (!e || typeof e !== "object") return;
    if (e.elementIdHex) all.push(e);
    walk(e.children);
  };
  walk(dump.elements);
  const root = all.find((e) => e.elementIdHex === "0x10000610");
  const logoff = all.find((e) => e.elementIdHex === "0x100000FA");
  assert.equal(logoff?.elementIdName, "LogoffButton");
  const sd = logoff.stateDesc;
  assert.deepEqual([sd.x, sd.y, sd.width, sd.height], [125, 5, 20, 20]);
  const file = (state) => logoff.states[state].media[0].fields.File;
  const hex = (n) => `0x${n.toString(16).toUpperCase().padStart(8, "0")}`;
  assert.equal(hex(file("Normal")), T.LOGOFF_BUTTON.normal);
  assert.equal(hex(file("Normal_pressed")), T.LOGOFF_BUTTON.pressed);
  assert.equal(root.stateDesc.width, 150, "retail RootFloatyIndicators_Field");
  assert.equal(T.RETAIL_FRAME_WIDTH, root.stateDesc.width);
});

test("[a] strip width = retail 150 + the 2-px gutters; six indicators unchanged", () => {
  assert.equal(T.RETAIL_FRAME_WIDTH, 150);
  // Six gutters between seven buttons (HUD overhaul 2026-10-05 liberty).
  assert.equal(T.stripWidth(7), 150 + 6 * 2);
  // Without the button the frame is exactly the old six-slot strip.
  assert.equal(T.stripWidth(6), 5 * 2 + 6 * 20 + 5 * 2);
  assert.equal(T.INDICATORS.length, 6, "LogoffButton is a button, not an indicator");
  assert.ok(!T.INDICATORS.some((i) => i.id === "logoff"));
  const js = src("plugins/status-indicators.js");
  assert.match(js, /const width = stripWidth\(INDICATORS\.length \+ 1\);/);
  assert.match(js, /\.no-logoff \{ width: \$\{stripWidth\(INDICATORS\.length\)\}px; \}/);
  assert.doesNotMatch(js, /NOT ported: the wasm session has no/, "stale header reason removed");
});

// ── [b] ────────────────────────────────────────────────────────────────
function rig({ answer = true, logout = async () => true, text = null } = {}) {
  const calls = { confirm: [], logout: 0, load: [] };
  const win = {
    __logOutToCharacterSelect: async () => { calls.logout += 1; return logout(); },
    __modalConfirm: async (opts) => { calls.confirm.push(opts); return typeof answer === "function" ? answer() : answer; },
  };
  const opts = {
    win,
    lookup: (tableId, key) => (tableId === 0x23000001 && key === 0x0EB1C41D ? text : null),
    load: async (id) => { calls.load.push(id); },
  };
  return { calls, win, opts };
}

test("[b] the confirm key is compute_str_hash of the retail token", () => {
  assert.equal(ECS.END_CHARACTER_SESSION_CONFIRM_TOKEN, "ID_Client_EndCharacterSessionConfirm");
  assert.equal(computeStrHash(ECS.END_CHARACTER_SESSION_CONFIRM_TOKEN), ECS.END_CHARACTER_SESSION_CONFIRM_KEY);
  assert.equal(ECS.END_CHARACTER_SESSION_STRING_TABLE, 0x23000001);
});

test("[b] no log-off path → no dialog, no log-off", async () => {
  const { calls, win, opts } = rig();
  delete win.__logOutToCharacterSelect;
  assert.equal(ECS.logOffAvailable(win), false);
  assert.equal(await ECS.requestEndCharacterSession(opts), false);
  assert.equal(calls.confirm.length, 0);
});

test("[b] Yes → asks with the DAT text, then logs off", async () => {
  const { calls, opts } = rig({ text: "This will exit your character from the game world.\\n\\nAre you sure?" });
  assert.equal(await ECS.requestEndCharacterSession(opts), true);
  assert.equal(calls.confirm.length, 1);
  assert.equal(calls.confirm[0].message, "This will exit your character from the game world.\n\nAre you sure?",
    "the DAT's literal \\n escapes become newlines");
  assert.equal(calls.confirm[0].confirmLabel, "Yes");
  assert.equal(calls.confirm[0].cancelLabel, "No");
  assert.deepEqual(calls.load, [0x23000001], "loads StringTable 0x23000001 first");
  assert.equal(calls.logout, 1);
});

test("[b] No → no log-off; the table miss uses the English value", async () => {
  const { calls, opts } = rig({ answer: false });
  assert.equal(await ECS.requestEndCharacterSession(opts), false);
  assert.equal(calls.confirm[0].message, ECS.END_CHARACTER_SESSION_CONFIRM_TEXT);
  assert.equal(calls.logout, 0);
});

test("[b] a refused log-off (mid-air) or a throwing dialog resolves false", async () => {
  const refused = rig({ logout: async () => false });
  assert.equal(await ECS.requestEndCharacterSession(refused.opts), false);
  assert.equal(refused.calls.logout, 1);
  const broken = rig({ answer: () => { throw new Error("dialog gone"); } });
  assert.equal(await ECS.requestEndCharacterSession(broken.opts), false);
  assert.equal(broken.calls.logout, 0);
  assert.equal(ECS.endCharacterSessionDialogOpen(), false, "the context is released");
});

test("[b] one confirmation at a time (MakeLogoutConfirmationDialog m_logoutContext)", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { calls, opts } = rig({ answer: () => gate });
  const first = ECS.requestEndCharacterSession(opts);
  await flush();
  assert.equal(ECS.endCharacterSessionDialogOpen(), true);
  assert.equal(await ECS.requestEndCharacterSession(opts), false, "second request refused");
  assert.equal(calls.confirm.length, 1);
  release(true);
  assert.equal(await first, true);
  assert.equal(calls.logout, 1);
  assert.equal(ECS.endCharacterSessionDialogOpen(), false);
});

// ── [c] ────────────────────────────────────────────────────────────────
test("[c] mounted strip: hidden and inert without the log-off path, live once it appears", async () => {
  delete globalThis.__logOutToCharacterSelect;
  const asked = [];
  let answer = false;
  let loggedOff = 0;
  globalThis.__modalConfirm = async (o) => { asked.push(o); return answer; };
  const unmount = SI.mount({});
  const overlay = document.body.children.find((c) => c.id === "hb-status-indicators")
    ?? document.body.children[document.body.children.length - 1];
  const btn = overlay.children.find((c) => c.dataset?.button === "logoff");
  assert.ok(btn, "LogoffButton element rendered");
  assert.equal(btn.dataset.elementId, "0x100000FA");
  assert.equal(btn.getAttribute("role"), "button");
  const kids = overlay.children.filter((c) => c.dataset?.indicator || c.dataset?.button);
  assert.equal(kids.indexOf(btn), 6, "seventh slot, after the six indicators");

  // Absent: hidden, out of the tab order, frame back to six slots, click inert.
  assert.equal(btn.hidden, true);
  assert.equal(btn.tabIndex, -1);
  assert.equal(btn.getAttribute("aria-disabled"), "true");
  assert.equal(overlay.classList.contains("no-logoff"), true);
  btn.fire("click", { detail: 1 });
  await flush();
  assert.equal(asked.length, 0, "no dialog without the log-off path");

  // The page grows the log-off path → the 1 Hz poll shows the button.
  globalThis.__logOutToCharacterSelect = async () => { loggedOff += 1; return true; };
  for (const fn of intervals) fn();
  assert.equal(btn.hidden, false);
  assert.equal(btn.tabIndex, 0);
  assert.equal(btn.getAttribute("aria-disabled"), "false");
  assert.equal(overlay.classList.contains("no-logoff"), false);

  // No → no log-off.
  btn.fire("click", { detail: 1 });
  await flush();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].message, ECS.END_CHARACTER_SESSION_CONFIRM_TEXT);
  assert.equal(loggedOff, 0);

  // Yes → log-off.
  answer = true;
  btn.fire("click", { detail: 1 });
  await flush();
  assert.equal(asked.length, 2);
  assert.equal(loggedOff, 1);

  // Keyboard activation goes through hudKeyActivates.
  btn.fire("keydown", { key: "Enter", repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  await flush();
  assert.equal(asked.length, 3);
  assert.equal(loggedOff, 2);

  unmount();
  delete globalThis.__logOutToCharacterSelect;
  delete globalThis.__modalConfirm;
});

// ── [d] ────────────────────────────────────────────────────────────────
test("[d] Options → Gameplay leads with 'Exit to Character Selection', gated + same handler", () => {
  const js = src("plugins/options-panel.js");
  assert.match(js, /import \{ logOffAvailable, requestEndCharacterSession \} from "\.\.\/ui\/end_character_session\.js";/);
  const start = js.indexOf("function renderGameplayTab(bodyEl, env) {");
  assert.ok(start > 0, "renderGameplayTab present");
  const body = js.slice(start, js.indexOf("renderInterfaceSection(bodyEl, env);", start));
  assert.match(body, /if \(logOffAvailable\(window\)\) \{/);
  assert.match(body, /leaveBtn\.textContent = "Exit to Character Selection";/);
  assert.match(body, /requestEndCharacterSession\(\{ win: window \}\)/);
  // The strip uses the same entry point.
  assert.match(src("plugins/status-indicators.js"), /requestEndCharacterSession\(\{ win: window \}\)/);
});
