// tests/combat_hud_power_ownership.test.mjs — round-9 review, finding R9-4.
//
// `window.__combatBarState.powerLevel` is the swing power scene3d/picking.js
// actually uses (picking.js:1243-1244). TWO widgets write it:
//
//   * combat-bar.js — the panel slider (`powerSlider` input handler,
//     combat-bar.js:1692) -> syncWindowState(); ALSO the value persisted in
//     localStorage `holtburger_combat_bar_v1` and seeded at import time.
//   * combat-hud.js — the HUD strip slider, via `syncPowerFill()`.
//
// combat-hud's `state.power` is a module local initialised to 1.0
// (combat-hud.js:404) that NOTHING ever seeded from the shared state, and
// `syncPowerFill()` wrote it into `__combatBarState.powerLevel`
// unconditionally. `syncPowerFill()` runs from `recomputeVisible`, which is
// wired to BOTH a 1 Hz `setInterval` (combat-hud.js:1138) and every
// `playerStatsUpdated` event (:1130) — and combat-hud is mounted at boot.
//
// Net effect: set the combat-bar power slider to 30%, and within one second
// the shared powerLevel is silently back at 1.0 and every swing fires at full
// power. The persisted value is defeated on boot for the same reason.
//
// CONTRACT (adopt-then-publish)
//   [1] an EXTERNAL write to __combatBarState.powerLevel survives a
//       syncPowerFill() — including the very first one after mount, so the
//       combat-bar's persisted seed is not stomped;
//   [2] combat-hud's OWN slider still wins (state.power -> shared);
//   [3] repeated syncs with nobody touching anything are stable.
//
// NEGATIVE CONTROLS
//   * "just stop writing the shared value" => [2] fails: the HUD slider
//     becomes inert.
//   * "always adopt the shared value" => [2] fails as well: the HUD's own
//     drag is overwritten on the next tick.
//
// Run from apps/holtburger-web/:
//   node tests/combat_hud_power_ownership.test.mjs

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

globalThis.window = {
  // What combat-bar.js seeds at import time from localStorage: the user's
  // persisted 30% power. combat-hud must not clobber it.
  __combatBarState: { powerLevel: 0.3 },
  __getCurrentStanceLow: () => 0,
};
globalThis.document = { getElementById: () => null, head: { appendChild() {} } };
globalThis.performance = { now: () => 0 };

const src = readFileSync(path.join(APP, "plugins", "combat-hud.js"), "utf8");
const body = spliceModule(src, {
  label: "plugins/combat-hud.js",
  provided: [],
  stubs: {
    setAcText: "(el, text) => { if (el) el.__text = text; }",
    loadLayout: "() => Promise.resolve(null)",
    findElementById: "() => null",
    getCachedLayout: "() => null",
    // Not exercised by this suite (it never calls updateDamageRating);
    // throwing stub so a future change that reaches it fails loudly.
    computeDamageRatingRollup: "() => { throw new Error('computeDamageRatingRollup must not be reached'); }",
    attachDefaultTopDragHandle: "() => {}",
    WINDOW_ID: "Object.freeze({ COMBAT_HUD: 'combat-hud' })",
  },
});
// eslint-disable-next-line no-new-func
const mod = new Function(body + "\nreturn { syncPowerFill, state };\n")();

// syncPowerFill early-returns without an overlay; a querySelector that finds
// nothing keeps every DOM branch inert so only the shared-state write runs.
mod.state.overlayEl = { querySelector: () => null };

/* ── [1] the persisted / externally-set value survives ────────────────── */

mod.syncPowerFill();
check("first sync after mount does NOT stomp the combat-bar's persisted 30%", () => {
  assert.equal(
    window.__combatBarState.powerLevel,
    0.3,
    `combat-hud reset the shared powerLevel to ${window.__combatBarState.powerLevel} ` +
    `(its module-local default) — every swing would fire at that power`,
  );
});

check("... and combat-hud's own slider position adopted it", () => {
  assert.equal(mod.state.power, 0.3);
});

// The 1 Hz recomputeVisible tick + every playerStatsUpdated call this again.
for (let i = 0; i < 5; i += 1) mod.syncPowerFill();
check("repeated 1 Hz syncs keep the value stable", () => {
  assert.equal(window.__combatBarState.powerLevel, 0.3);
});

/* ── [2] the HUD's own slider still wins ──────────────────────────────── */

// This is verbatim what combat-hud's `setFromEv` does (combat-hud.js:703-704)
// when the user drags the HUD strip slider.
mod.state.power = 0.7;
mod.syncPowerFill();
check("combat-hud's own slider drag publishes to the shared state", () => {
  assert.equal(
    window.__combatBarState.powerLevel,
    0.7,
    "NEGATIVE CONTROL: a fix that merely stops writing makes the HUD slider inert",
  );
});
for (let i = 0; i < 3; i += 1) mod.syncPowerFill();
check("NEGATIVE CONTROL: the HUD's value is not re-adopted away on the next tick", () => {
  assert.equal(
    window.__combatBarState.powerLevel,
    0.7,
    "a fix that ALWAYS adopts the shared value would revert the HUD drag here",
  );
  assert.equal(mod.state.power, 0.7);
});

/* ── [3] a later combat-bar panel change wins again ───────────────────── */

window.__combatBarState.powerLevel = 0.5; // user moves the PANEL slider
mod.syncPowerFill();
check("a later combat-bar panel change is adopted, not overwritten", () => {
  assert.equal(window.__combatBarState.powerLevel, 0.5);
  assert.equal(mod.state.power, 0.5);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
