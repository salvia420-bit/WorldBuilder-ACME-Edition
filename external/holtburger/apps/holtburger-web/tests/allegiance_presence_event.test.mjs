// tests/allegiance_presence_event.test.mjs — round-9 review, finding R9-6.
//
// The plugin event bus is an EventTarget (plugins/api.js:463-474):
//
//     on(name, handler)  { bus.addEventListener(name, handler); }
//     emit(name, payload){ bus.dispatchEvent(new CustomEvent(name, { detail: payload })); }
//
// so a handler receives the EVENT and the payload lives on `.detail`.
//
// `subscribeAllegiancePresence` (plugins/allegiance-panel.js:670-695) read the
// payload straight off its first argument:
//
//     const listener = (payload) => {
//       const guid = (payload?.characterGuid >>> 0) || 0;   // always 0
//       ...
//       if (!guid) return;                                   // always taken
//
// index.html:8992 emits `allegiancePresence` with
// `{ characterGuid, isLoggedIn }` on Allegiance_AllegianceLoginNotification
// (opcode 0x027A). Because `characterGuid` is read off the CustomEvent rather
// than its `.detail`, `guid` was always 0 and the handler bailed on every
// event: the retail "X has logged in / out" allegiance chat line has never
// been emitted. A default-ON producer with an unreachable consumer.
//
// This suite drives the REAL bus from plugins/api.js — not a hand-rolled
// pub/sub — so the wrapping is the shipped wrapping.
//
// NEGATIVE CONTROL
//   Reading `ev.detail` ONLY (dropping the `?? ev` fallback) still passes the
//   main case; the "raw payload emitter" case pins the fallback. And the
//   "unknown guid" case proves the handler is not simply emitting for
//   everything (a detector that cannot fail).
//
// Run from apps/holtburger-web/:
//   node tests/allegiance_presence_event.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spliceModule } from "../harness/lib/splice_module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

/* ── the REAL api.js bus shape (EventTarget + CustomEvent) ────────────── */

const target = new EventTarget();
const bus = {
  on(name, handler) { target.addEventListener(name, handler); },
  off(name, handler) { target.removeEventListener(name, handler); },
  once(name, handler) { target.addEventListener(name, handler, { once: true }); },
  emit(name, payload) { target.dispatchEvent(new CustomEvent(name, { detail: payload })); },
};

/* ── DOM: only #chat-log matters (emit() appends an <li> to it) ───────── */

const chatLines = [];
const chatLog = {
  appendChild(li) { chatLines.push(li); },
};
function makeEl() {
  return {
    className: "", dataset: {}, textContent: "", style: {},
    appendChild() {}, addEventListener() {},
  };
}
globalThis.document = {
  getElementById: (id) => (id === "chat-log" ? chatLog : null),
  createElement: makeEl,
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {}, removeEventListener() {},
};

/* ── a playerAllegiance() snapshot with one known vassal ──────────────── */

const MONARCH_GUID = 0x50000001;
const VASSAL_GUID = 0x50000009;

globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  __pluginClient: { events: bus },
  __sessionHandle: {
    playerAllegiance: () => ({
      monarch: { guid: MONARCH_GUID, name: "Ealdrith" },
      patron: null,
      myself: null,
      vassals: [{ guid: VASSAL_GUID, name: "Tarrek" }],
    }),
  },
};

/* ── load the plugin ──────────────────────────────────────────────────── */

const src = readFileSync(path.join(APP, "plugins", "allegiance-panel.js"), "utf8");
const body = spliceModule(src, {
  label: "plugins/allegiance-panel.js",
  provided: [],
  stubs: {
    setAcText: "(el, text) => { if (el) el.textContent = String(text ?? ''); }",
    escapeHtml: "(s) => String(s ?? '')",
    loadLayout: "() => Promise.resolve(null)",
    findElementById: "() => null",
    getCachedLayout: "() => null",
    // Not reachable from the presence path; throwing stub so a future
    // change that DOES reach it fails loudly rather than silently passing.
    modalConfirmCallback: "() => { throw new Error('modalConfirmCallback must not be reached'); }",
  },
});
// eslint-disable-next-line no-new-func
const mod = new Function(body + "\nreturn { subscribeAllegiancePresence };\n")();

const unsubscribe = mod.subscribeAllegiancePresence();

/* ── [1] the shipped emit shape reaches the handler ───────────────────── */

chatLines.length = 0;
bus.emit("allegiancePresence", { characterGuid: VASSAL_GUID, isLoggedIn: true });

check("a vassal login emits the retail chat line", () => {
  assert.equal(
    chatLines.length,
    1,
    "no chat line emitted — the handler read the payload off the CustomEvent " +
    "instead of its .detail, so characterGuid was undefined and it bailed",
  );
  assert.equal(chatLines[0].textContent, "Tarrek has logged in.");
});

chatLines.length = 0;
bus.emit("allegiancePresence", { characterGuid: MONARCH_GUID, isLoggedIn: false });
check("a monarch logout emits the logout line", () => {
  assert.equal(chatLines.length, 1);
  assert.equal(chatLines[0].textContent, "Ealdrith has logged out.");
});

/* ── [2] a guid not in the hierarchy falls back to the hex form ───────── */

chatLines.length = 0;
bus.emit("allegiancePresence", { characterGuid: 0x5000BEEF, isLoggedIn: true });
check("an unknown member falls back to the hex guid, not a blank name", () => {
  assert.equal(chatLines.length, 1);
  assert.equal(chatLines[0].textContent, "0x5000BEEF has logged in.");
});

/* ── [3] the handler is not a rubber stamp ────────────────────────────── */

chatLines.length = 0;
bus.emit("allegiancePresence", { characterGuid: 0, isLoggedIn: true });
check("guid 0 emits nothing (the detector can still fail)", () => {
  assert.equal(chatLines.length, 0);
});

chatLines.length = 0;
bus.emit("allegiancePresence", undefined);
check("an empty payload emits nothing", () => {
  assert.equal(chatLines.length, 0);
});

/* ── [4] NEGATIVE CONTROL: a raw-payload emitter still works ──────────── */

chatLines.length = 0;
// A hypothetical emitter that passes the payload directly (no CustomEvent).
// The `?? ev` fallback is what keeps this working; a `.detail`-only read
// fails here.
target.dispatchEvent(Object.assign(new Event("allegiancePresence"), {
  characterGuid: VASSAL_GUID,
  isLoggedIn: true,
}));
check("NEGATIVE CONTROL: a raw-payload emit still resolves the member", () => {
  assert.equal(chatLines.length, 1);
  assert.equal(chatLines[0].textContent, "Tarrek has logged in.");
});

/* ── [5] unsubscribe really detaches ──────────────────────────────────── */

unsubscribe();
chatLines.length = 0;
bus.emit("allegiancePresence", { characterGuid: VASSAL_GUID, isLoggedIn: true });
check("unsubscribe detaches the listener", () => {
  assert.equal(chatLines.length, 0);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
