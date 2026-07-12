// =============================================================================
// WS14 (2026-07-12) — cast-UI feedback + pre-check reducer unit tests
// =============================================================================
//
// The combat-bar cast-busy sweep (patch A) and the armed wrong-stance cue
// (patch B) are DOM-coupled, so the DECISION logic is factored into pure
// modules (ui/ac_cast_ui_logic.js) that combat-bar.js imports and uses. These
// tests lock that shipped logic, plus the ?castPrecheck (patch F) pure helpers
// (ui/ac_cast_precheck.js), with no jsdom / wasm.
//
// Run from apps/holtburger-web/:
//   node tests/test_ws14_ui_feedback.test.cjs
// =============================================================================

const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

const LOGIC_URL = pathToFileURL(
  path.join(__dirname, "..", "ui", "ac_cast_ui_logic.js"),
).href;
const PRECHECK_URL = pathToFileURL(
  path.join(__dirname, "..", "ui", "ac_cast_precheck.js"),
).href;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

(async () => {
  const {
    STANCE_MAGIC_LOW,
    wrongStanceForArmed,
    castCooldownMs,
    castSweepReducer,
  } = await import(LOGIC_URL);

  const {
    parsePrecheckMode,
    evalComponentPrecheck,
    evalManaPrecheck,
    MSG_MISSING_COMPONENTS,
    MSG_NOT_ENOUGH_MANA,
  } = await import(PRECHECK_URL);

  // ── patch B — wrongStanceForArmed ─────────────────────────────────────
  check("wrongStance: targeted armed + non-magic stance → true", () => {
    assert.equal(wrongStanceForArmed(57, false, 0x0000), true);
    assert.equal(wrongStanceForArmed(57, false, 0x0006), true); // melee-ish
  });
  check("wrongStance: targeted armed IN magic stance → false", () => {
    assert.equal(wrongStanceForArmed(57, false, STANCE_MAGIC_LOW), false);
    assert.equal(wrongStanceForArmed(57, false, 0x0049), false);
  });
  check("wrongStance: no spell armed → false regardless of stance", () => {
    assert.equal(wrongStanceForArmed(0, false, 0x0000), false);
    assert.equal(wrongStanceForArmed(-1, false, 0x0000), false);
  });
  check("wrongStance: untargeted (self) spell → never wrong-stance", () => {
    // self-spells cast immediately on click, any stance
    assert.equal(wrongStanceForArmed(59, true, 0x0000), false);
    assert.equal(wrongStanceForArmed(59, true, 0x0049), false);
  });

  // ── patch A — castCooldownMs (busy window = totalDurationS*1000/speed) ──
  check("cooldown: DAT-grounded durations @2.0", () => {
    assert.equal(castCooldownMs(6.4825, 2.0), 3241); // spell 57 war bolt
    assert.equal(castCooldownMs(3.1212, 2.0), 1561); // spell 59
    assert.equal(castCooldownMs(14.3497, 2.0), 7175); // 1708 Wedding Bliss
  });
  check("cooldown: speed=1.0 doubles", () => {
    assert.equal(castCooldownMs(6.4825, 1.0), 6483);
  });
  check("cooldown: floored at 400ms for very fast casts", () => {
    assert.equal(castCooldownMs(0.1, 2.0), 400); // 50ms → floor 400
  });
  check("cooldown: missing/zero duration → 2000ms fallback", () => {
    assert.equal(castCooldownMs(0, 2.0), 2000);
    assert.equal(castCooldownMs(undefined, 2.0), 2000);
    assert.equal(castCooldownMs(NaN, 2.0), 2000);
  });
  check("cooldown: non-finite speed defaults to 2.0", () => {
    assert.equal(castCooldownMs(6.4825, 0), 3241);
    assert.equal(castCooldownMs(6.4825, undefined), 3241);
  });

  // ── patch A — castSweepReducer ────────────────────────────────────────
  check("sweep: local initiated → casting on with estDurationMs", () => {
    const r = castSweepReducer({
      type: "spellCastInitiated", attackerGuid: 0x50000001,
      localGuid: 0x50000001, estDurationMs: 3241,
    });
    assert.deepEqual(r, { casting: true, ms: 3241 });
  });
  check("sweep: remote initiated → ignored (no sweep)", () => {
    const r = castSweepReducer({
      type: "spellCastInitiated", attackerGuid: 0x50000099,
      localGuid: 0x50000001, estDurationMs: 3241,
    });
    assert.equal(r.casting, false);
    assert.equal(r.ignored, true);
  });
  check("sweep: initiated missing estDurationMs → fallbackMs", () => {
    const r = castSweepReducer({
      type: "spellCastInitiated", attackerGuid: 1, localGuid: 1,
      fallbackMs: 2000,
    });
    assert.deepEqual(r, { casting: true, ms: 2000 });
  });
  check("sweep: initiated with no attackerGuid → treated as local", () => {
    const r = castSweepReducer({
      type: "spellCastInitiated", localGuid: 1, estDurationMs: 500,
    });
    assert.deepEqual(r, { casting: true, ms: 500 });
  });
  check("sweep: resolved / rejected → casting off", () => {
    assert.deepEqual(castSweepReducer({ type: "spellCastResolved" }), { casting: false, ms: 0 });
    assert.deepEqual(castSweepReducer({ type: "spellCastRejected" }), { casting: false, ms: 0 });
  });
  check("sweep: unknown event → ignored, off", () => {
    const r = castSweepReducer({ type: "somethingElse" });
    assert.equal(r.casting, false);
    assert.equal(r.ignored, true);
  });

  // ── patch F — parsePrecheckMode (strict opt-in) ───────────────────────
  check("precheck mode: strict opt-in parsing", () => {
    assert.equal(parsePrecheckMode("components"), "components");
    assert.equal(parsePrecheckMode("on"), "on");
    assert.equal(parsePrecheckMode("COMPONENTS"), "components"); // case-insensitive
    assert.equal(parsePrecheckMode("off"), "off");
    assert.equal(parsePrecheckMode(""), "off");
    assert.equal(parsePrecheckMode(null), "off");
    assert.equal(parsePrecheckMode(undefined), "off");
    assert.equal(parsePrecheckMode("1"), "off"); // footgun: only exact strings enable
    assert.equal(parsePrecheckMode("true"), "off");
    assert.equal(parsePrecheckMode("all"), "off");
  });

  // ── patch F — evalComponentPrecheck (fail-open ownership) ─────────────
  check("components: all owned → no reject (false)", () => {
    const owned = new Set(["iron scarab", "prismatic taper", "lead scarab"]);
    assert.equal(evalComponentPrecheck(["Iron Scarab", "Lead Scarab"], owned), false);
  });
  check("components: a required component missing → reject (true)", () => {
    const owned = new Set(["iron scarab"]);
    assert.equal(evalComponentPrecheck(["Iron Scarab", "Prismatic Taper"], owned), true);
  });
  check("components: fail-open when required list empty", () => {
    assert.equal(evalComponentPrecheck([], new Set(["iron scarab"])), false);
    assert.equal(evalComponentPrecheck(null, new Set(["iron scarab"])), false);
  });
  check("components: fail-open when no inventory snapshot", () => {
    // empty owned → couldn't determine a miss → allow the send
    assert.equal(evalComponentPrecheck(["Iron Scarab"], new Set()), false);
    assert.equal(evalComponentPrecheck(["Iron Scarab"], []), false);
  });
  check("components: array of owned names accepted", () => {
    assert.equal(evalComponentPrecheck(["iron scarab"], ["iron scarab", "bread"]), false);
    assert.equal(evalComponentPrecheck(["mana scarab"], ["iron scarab", "bread"]), true);
  });
  check("components: blank required entry (unresolved id) is skipped, not rejected", () => {
    // an unresolved component id maps to "" → don't reject on it (fail-open)
    assert.equal(evalComponentPrecheck(["", "Iron Scarab"], new Set(["iron scarab"])), false);
  });

  // ── patch F — evalManaPrecheck (non-retail, fail-open) ────────────────
  check("mana: base > current → reject (true)", () => {
    assert.equal(evalManaPrecheck(50, 10), true);
  });
  check("mana: base <= current → no reject (false)", () => {
    assert.equal(evalManaPrecheck(10, 50), false);
    assert.equal(evalManaPrecheck(50, 50), false);
  });
  check("mana: fail-open on missing/zero base or non-finite current", () => {
    assert.equal(evalManaPrecheck(0, 10), false);
    assert.equal(evalManaPrecheck(undefined, 10), false);
    assert.equal(evalManaPrecheck(NaN, 10), false);
    assert.equal(evalManaPrecheck(50, NaN), false);
    assert.equal(evalManaPrecheck(50, undefined), false);
  });

  // ── retail string constants (verbatim decomp) ─────────────────────────
  check("retail strings are the client pre-check strings", () => {
    assert.equal(MSG_MISSING_COMPONENTS, "You do not have all of this spell's components");
    assert.equal(MSG_NOT_ENOUGH_MANA, "You don't have enough Mana to cast this spell.");
  });

  console.log(`\nWS14 UI-feedback: ${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.error(`  ${f.name}: ${f.err.stack || f.err}`);
    process.exit(1);
  }
})();
