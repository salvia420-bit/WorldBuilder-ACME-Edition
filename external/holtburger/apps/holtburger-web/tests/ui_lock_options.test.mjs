// tests/ui_lock_options.test.mjs — input-options-4 (2026-10-13): the
// Options → Character "Lock UI" checkbox (CharacterOption 0x33) is retail's
// global LockUI, not a dead toggle.
//
// Retail PlayerModule::SetOption → SetLockUI and the radar lock button
// (gmRadarUI::ListenToElementMessage) / `@lockui` (DoLockUI) all flip the same
// PlayerModule::LockUI bit (acclient.c:511690). Pins:
//   • ticking "Lock UI" sends (0x33, true) ONCE and sets ui/ui_lock.js's
//     global lock at once (no wait for a stats event);
//   • a radar / `/lockui` toggle (toggleGlobalLock) moves the open checkbox;
//   • Cancel (revertSession) re-sends the original and restores the global
//     lock with it.
//
// Run from apps/holtburger-web/:
//   node tests/ui_lock_options.test.mjs

import assert from "node:assert/strict";
import { installFakeDom } from "./helpers/social_fake_dom.mjs";

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

const LOCK_UI = 0x33;
const opts = new Map([[LOCK_UI, false]]);
const calls = [];
globalThis.__sessionHandle = {
  isCharacterOptionEnabled: (i) => !!opts.get(i >>> 0),
  setCharacterOption: (i, v) => { calls.push([i >>> 0, !!v]); opts.set(i >>> 0, !!v); },
};
globalThis.__mainPanel = { closeView: () => {} };

const L = await import("../ui/ui_lock.js");
const panel = await import("../plugins/options-panel.js");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.stack || err.message}`); }
}

const host = document.createElement("div");
document.body.appendChild(host);
let cleanup = panel.view.mount(host, { tab: "character" });

function box(label) {
  const lbl = host.querySelectorAll("label").find((l) => l.textContent === label);
  assert.ok(lbl, `row "${label}" rendered`);
  const cb = lbl.parentNode.querySelector("input");
  assert.ok(cb, `checkbox for "${label}"`);
  return cb;
}
const button = (label) => host.querySelectorAll("button").find((b) => b.textContent === label);

console.log("── input-options-4: Options \"Lock UI\" = the global LockUI ──");

check("ticking Lock UI sends (0x33, true) once and locks the UI at once", () => {
  const cb = box("Lock UI");
  assert.equal(cb.checked, false);
  assert.equal(L.isGlobalLocked(), false);
  calls.length = 0;
  cb.click();
  assert.deepEqual(calls, [[LOCK_UI, true]], "one wire send — the panel's own");
  assert.equal(L.isGlobalLocked(), true, "every obeying floaty locks now");
});

check("a radar / /lockui toggle moves the open checkbox", () => {
  const cb = box("Lock UI");
  calls.length = 0;
  assert.equal(L.toggleGlobalLock(), false);
  assert.equal(cb.checked, false, "box follows the global lock");
  assert.deepEqual(calls, [[LOCK_UI, false]]);
  cb.click();
  assert.equal(L.isGlobalLocked(), true);
  assert.equal(cb.checked, true);
});

check("Cancel re-sends the original and restores the global lock", () => {
  calls.length = 0;
  button("Cancel").click();
  assert.deepEqual(calls, [[LOCK_UI, false]], "original (unlocked) re-sent");
  assert.equal(opts.get(LOCK_UI), false);
  assert.equal(L.isGlobalLocked(), false);
  cleanup?.();
  cleanup = null;
});

check("after unmount the panel no longer listens", () => {
  calls.length = 0;
  assert.doesNotThrow(() => L.toggleGlobalLock());
  assert.equal(L.isGlobalLocked(), true);
  assert.deepEqual(calls, [[LOCK_UI, true]]);
  L.toggleGlobalLock();
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
