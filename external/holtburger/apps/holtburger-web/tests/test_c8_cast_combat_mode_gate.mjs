// tests/test_c8_cast_combat_mode_gate.mjs — ledger C8 (2026-08-13).
//
// ACE rejects a cast made out of Magic mode SILENTLY: `Player_Magic.cs:83-94`
// (targeted) / `:275-283` (untargeted) log a WARN and `SendUseDoneEvent()` —
// a bare UseDone, WeenieError None, no text, no motion. The melee/missile
// lanes already gate this client-side with visible feedback
// (`scene3d/picking.js` "You are not in melee or missile combat mode.");
// the cast lane did not, and `plugins/hotbar.js` fires spells at any stance,
// so a hotbar cast in Peace mode vanished with no feedback at all.
//
// THE TRAP THIS PINS. ACE's check has a second arm:
//     if (LastCombatMode == CombatMode.Magic) CombatMode = CombatMode.Magic;
// and `LastCombatMode` is stamped at REQUEST time (`Player_Combat.cs:762`,
// before the possibly-deferred `_Inner`). So the server accepts a cast that
// `CombatMode` says should fail, for the whole "toggle to Magic then
// immediately cast" window — the fastcast pattern. A gate that read only
// `combatMode()` would EAT those casts. Hence the intent mirror, and hence
// the fail-open cases below, which are the ones that actually matter.
//
// Run from apps/holtburger-web/:
//   node tests/test_c8_cast_combat_mode_gate.mjs

import assert from "node:assert/strict";
import {
  castWouldBeSilentlyRejected,
  noteCombatModeRequest,
  __resetCombatModeIntent,
  COMBAT_MODE_NON_COMBAT,
  COMBAT_MODE_MELEE,
  COMBAT_MODE_MAGIC,
  MAGIC_STANCE_LOW,
} from "../ui/ac_combat_mode_intent.js";

const NONCOMBAT_STANCE_LOW = 0x3d;

let passed = 0, failed = 0;
function t(name, fn) {
  __resetCombatModeIntent();
  try { fn(); passed += 1; console.log(`ok   ${name}`); }
  catch (e) { failed += 1; console.log(`FAIL ${name}\n     ${e.message}`); }
}

const opts = (mode, stanceLow) => ({
  handle: { combatMode: () => mode },
  getStanceLow: () => stanceLow,
});

// ── the case the fix exists for ──────────────────────────────────────────
t("blocks a cast in confirmed NonCombat with a NonCombat request on record", () => {
  noteCombatModeRequest(COMBAT_MODE_NON_COMBAT);
  assert.equal(castWouldBeSilentlyRejected(opts(COMBAT_MODE_NON_COMBAT, NONCOMBAT_STANCE_LOW)), true);
});
t("blocks a cast in confirmed Melee mode too (ACE checks == Magic, not != NonCombat)", () => {
  noteCombatModeRequest(COMBAT_MODE_MELEE);
  assert.equal(castWouldBeSilentlyRejected(opts(COMBAT_MODE_MELEE, 0x3e)), true);
});

// ── fail-open: never eat a cast ACE would accept ─────────────────────────
t("allows when combat mode is confirmed Magic", () => {
  noteCombatModeRequest(COMBAT_MODE_NON_COMBAT);
  assert.equal(castWouldBeSilentlyRejected(opts(COMBAT_MODE_MAGIC, MAGIC_STANCE_LOW)), false);
});
t("allows when the confirmed STANCE is Magic even if combatMode() lags", () => {
  noteCombatModeRequest(COMBAT_MODE_NON_COMBAT);
  assert.equal(castWouldBeSilentlyRejected(opts(COMBAT_MODE_NON_COMBAT, MAGIC_STANCE_LOW)), false);
});
t("allows the LastCombatMode window: Magic requested, not yet confirmed", () => {
  noteCombatModeRequest(COMBAT_MODE_MAGIC);
  assert.equal(castWouldBeSilentlyRejected(opts(COMBAT_MODE_NON_COMBAT, NONCOMBAT_STANCE_LOW)), false);
});
t("allows when no combat-mode request is on record (unknown => fail-open)", () => {
  assert.equal(castWouldBeSilentlyRejected(opts(COMBAT_MODE_NON_COMBAT, NONCOMBAT_STANCE_LOW)), false);
});
t("allows after an untyped toggleCombatMode() (server picks the mode)", () => {
  noteCombatModeRequest(COMBAT_MODE_NON_COMBAT);
  noteCombatModeRequest(null); // toggle
  assert.equal(castWouldBeSilentlyRejected(opts(COMBAT_MODE_NON_COMBAT, NONCOMBAT_STANCE_LOW)), false);
});
t("allows when the stance is unknown (0 = no confirmed UpdateMotion yet)", () => {
  noteCombatModeRequest(COMBAT_MODE_NON_COMBAT);
  assert.equal(castWouldBeSilentlyRejected(opts(COMBAT_MODE_NON_COMBAT, 0)), false);
});
t("allows when the combatMode getter throws or is missing", () => {
  noteCombatModeRequest(COMBAT_MODE_NON_COMBAT);
  assert.equal(castWouldBeSilentlyRejected({
    handle: { combatMode: () => { throw new Error("boom"); } },
    getStanceLow: () => NONCOMBAT_STANCE_LOW,
  }), false);
  assert.equal(castWouldBeSilentlyRejected({
    handle: {}, getStanceLow: () => NONCOMBAT_STANCE_LOW,
  }), false);
});

// ── DEC-2: the gate must never CHANGE combat mode ────────────────────────
t("DEC-2: the gate never calls setCombatMode / toggleCombatMode", () => {
  let touched = false;
  noteCombatModeRequest(COMBAT_MODE_NON_COMBAT);
  castWouldBeSilentlyRejected({
    handle: {
      combatMode: () => COMBAT_MODE_NON_COMBAT,
      setCombatMode: () => { touched = true; },
      toggleCombatMode: () => { touched = true; },
    },
    getStanceLow: () => NONCOMBAT_STANCE_LOW,
  });
  assert.equal(touched, false, "retail never touches SetCombatMode on the cast path (A5/DEC-2)");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
