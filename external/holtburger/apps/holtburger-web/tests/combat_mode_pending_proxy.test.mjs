// tests/combat_mode_pending_proxy.test.mjs — combat-magic-5 review fix C-R1
// (2026-10-13).
//
// plugins/rejection_feedback.js replaces window.__sessionHandle with a Proxy
// over the raw wasm handle ~100 ms after login, while index.html's combat key
// parks its request with the RAW `handle` ({ handle }). The park's logout
// check compared the two objects, saw them differ, and silently dropped the
// parked toggle as a "logout": the key pressed mid-windup never sent.
//
// This runs the REAL rejection_feedback.js proxy (not a hand-made one): the
// parked toggle made with the raw handle must still go out once the player is
// ready, and a genuine logout (a different session, or none) must still drop
// it.
//
// Run: node tests/combat_mode_pending_proxy.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";

// ── minimal DOM + bus stubs (installed BEFORE rejection_feedback evaluates) ──
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ remove() {}, classList: { add() {}, remove() {} } }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  querySelectorAll: () => [],
};
const bus = new EventTarget();
const client = {
  events: {
    on: (n, h) => bus.addEventListener(n, h),
    off: (n, h) => bus.removeEventListener(n, h),
    emit: (n, p) => bus.dispatchEvent(new CustomEvent(n, { detail: p })),
  },
  attachHandle() {},
};

const state = { pending: 0, mode: 8 /* Magic */, busy: 0, toggles: 0 };
// The raw wasm SessionHandle stand-in (index.html's `handle`).
const raw = {
  combatMode: () => state.mode,
  getBusyState: () => state.busy,
  playerGuid: () => 0x50000001,
  toggleCombatMode() { state.toggles += 1; },
  moveItem() {},
};
globalThis.window = {
  __pluginClient: client,
  __sessionHandle: raw,
  __hbWasm: { movementPendingMotionsDiag: () => state.pending, castArbitrationDiag: () => 0 },
};

await import("../plugins/rejection_feedback.js");
const {
  COMBAT_MODE_TOGGLE, RAW_SESSION_HANDLE, sessionIdentity,
  requestCombatModeChange, pollParkedCombatMode, parkedCombatMode,
  _configureCombatModeParkForTests,
} = await import("../ui/combat_mode_pending.js");

let t = 0;
_configureCombatModeParkForTests({ now: () => t, schedule: () => 1, cancel: () => {} });

test("rejection_feedback.js wrapped the global in a Proxy that unwraps to the raw handle", () => {
  assert.notEqual(window.__sessionHandle, raw, "the global is the Proxy, not the raw handle");
  assert.equal(window.__sessionHandle[RAW_SESSION_HANDLE], raw);
  assert.equal(sessionIdentity(window.__sessionHandle), raw);
  assert.equal(sessionIdentity(raw), raw, "a raw handle is its own identity");
  assert.equal(sessionIdentity(null), null);
});

test("the combat key's toggle parked with the RAW handle is sent once the player is ready", () => {
  state.pending = 2; // mid-windup: the stomp is on the minterp queue
  state.toggles = 0;
  const sendToggle = () => raw.toggleCombatMode();
  assert.equal(requestCombatModeChange(COMBAT_MODE_TOGGLE, sendToggle, { handle: raw }), false, "parked");
  t += 33;
  assert.equal(pollParkedCombatMode(), 0, "still not ready");
  assert.equal(parkedCombatMode(), COMBAT_MODE_TOGGLE, "the Proxy global is NOT read as a logout");
  state.pending = 0;
  t += 33;
  assert.equal(pollParkedCombatMode(), COMBAT_MODE_TOGGLE);
  assert.equal(state.toggles, 1, "sent exactly once");
  assert.equal(parkedCombatMode(), 0);
});

test("a parked request made through the Proxy global is sent too", () => {
  state.pending = 1;
  state.toggles = 0;
  requestCombatModeChange(COMBAT_MODE_TOGGLE, () => window.__sessionHandle.toggleCombatMode());
  state.pending = 0;
  t += 33;
  assert.equal(pollParkedCombatMode(), COMBAT_MODE_TOGGLE);
  assert.equal(state.toggles, 1);
});

test("a genuine logout / relog still drops the parked request", () => {
  const proxied = window.__sessionHandle;
  try {
    for (const next of [null, { combatMode: () => 8 }]) {
      state.pending = 1;
      state.toggles = 0;
      requestCombatModeChange(COMBAT_MODE_TOGGLE, () => raw.toggleCombatMode(), { handle: raw });
      window.__sessionHandle = next;
      state.pending = 0;
      t += 33;
      assert.equal(pollParkedCombatMode(), 0);
      assert.equal(state.toggles, 0, "not sent on the new session");
      assert.equal(parkedCombatMode(), 0, "dropped");
      window.__sessionHandle = proxied;
    }
  } finally {
    window.__sessionHandle = proxied;
    _configureCombatModeParkForTests();
  }
});
