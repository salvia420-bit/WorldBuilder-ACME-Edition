// tests/options_fellowship_exclusion.test.mjs — charopt-1 (2026-10-08).
//
// Retail CPlayerModule::OnChanged (acclient.c 452957) keeps
// IgnoreFellowshipRequests (PlayerOption 2) and FellowshipAutoAcceptRequests
// (0x12) mutually exclusive: turning one ON first clears the other, and both
// being auto-save options, the wire carries (pair, false) THEN
// (option, true). ACE has no server-side exclusion and checks Ignore first,
// so on a default character (Ignore ON) ticking "Automatically accept
// fellowship requests" used to do nothing.
//
// Pins the Options → Character page behaviour:
//   • fellowshipPairToClear — the pure pair rule;
//   • ticking AutoAccept with Ignore on sends (0x02,false) then (0x12,true)
//     and unticks the Ignore box;
//   • Cancel (revertSession) restores BOTH options;
//   • unticking never touches the pair; unrelated options are one send.
//
// Run from apps/holtburger-web/:
//   node tests/options_fellowship_exclusion.test.mjs

import assert from "node:assert/strict";
import { installFakeDom } from "./helpers/social_fake_dom.mjs";

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

const IGNORE = 0x02;
const AUTO = 0x12;
const SHARE_XP = 0x0F;
const opts = new Map([[IGNORE, true], [AUTO, false], [SHARE_XP, true]]);
const calls = [];
globalThis.__sessionHandle = {
  isCharacterOptionEnabled: (i) => !!opts.get(i >>> 0),
  // Raw single-bit setter (an older wasm without the Rust-side exclusion):
  // the JS must still produce the retail wire order on its own.
  setCharacterOption: (i, v) => { calls.push([i >>> 0, !!v]); opts.set(i >>> 0, !!v); },
};
let closed = 0;
globalThis.__mainPanel = { closeView: () => { closed += 1; } };

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

console.log("── charopt-1: fellowship Ignore ↔ AutoAccept ──────────────");

check("fellowshipPairToClear: only when turning ON with the pair set", () => {
  const on = (set) => (i) => set.has(i);
  assert.equal(panel.fellowshipPairToClear(AUTO, true, on(new Set([IGNORE]))), IGNORE);
  assert.equal(panel.fellowshipPairToClear(IGNORE, true, on(new Set([AUTO]))), AUTO);
  assert.equal(panel.fellowshipPairToClear(AUTO, true, on(new Set())), null, "pair already off");
  assert.equal(panel.fellowshipPairToClear(AUTO, false, on(new Set([IGNORE]))), null, "turning OFF");
  assert.equal(panel.fellowshipPairToClear(SHARE_XP, true, on(new Set([IGNORE, AUTO]))), null, "unrelated");
});

check("default character: ticking AutoAccept sends (Ignore,false) then (AutoAccept,true)", () => {
  const ignore = box("Ignore fellowship requests");
  const auto = box("Automatically accept fellowship requests");
  assert.equal(ignore.checked, true);
  assert.equal(auto.checked, false);
  calls.length = 0;
  auto.click();
  assert.deepEqual(calls, [[IGNORE, false], [AUTO, true]], "retail OnChanged wire order");
  assert.equal(ignore.checked, false, "the Ignore box unticks at once");
  assert.equal(auto.checked, true);
});

check("Cancel restores both options", () => {
  calls.length = 0;
  button("Cancel").click();
  assert.equal(closed, 1);
  assert.equal(opts.get(IGNORE), true);
  assert.equal(opts.get(AUTO), false);
  assert.deepEqual(calls.map((c) => c[0]).sort(), [IGNORE, AUTO].sort(), "both originals re-sent");
  cleanup?.();
});

check("unticking never touches the pair; unrelated options are one send", () => {
  opts.set(IGNORE, true);
  opts.set(AUTO, true);
  host.textContent = "";
  cleanup = panel.view.mount(host, { tab: "character" });
  calls.length = 0;
  box("Ignore fellowship requests").click(); // ON → OFF
  assert.deepEqual(calls, [[IGNORE, false]]);
  calls.length = 0;
  box("Share fellowship XP and luminance").click();
  assert.deepEqual(calls, [[SHARE_XP, false]]);
  cleanup?.();
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
