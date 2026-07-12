// =============================================================================
// WS14 (2026-07-12) — cast-busy cooldown duration mapping (DAT-grounded)
// =============================================================================
//
// Locks the duration math the combat-bar cast-busy sweep (patch A) relies on:
// the busy window (== the on-screen cast) is totalDurationS*1000/CAST_SPEED,
// floored at 400ms, fallback 2000ms. Uses the REAL shipped helpers —
// getCastSequence (ui/ac_spell_cast_sequence.js) + castCooldownMs
// (ui/ac_cast_ui_logic.js) — against the DAT-grounded §1.2 durations
// (SpellComponentTable _time bytes, verified via the WB.Terminal oracle).
//
// Run from apps/holtburger-web/:
//   node tests/test_ws14_cast_cooldown.test.mjs
// =============================================================================

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { _loadSequenceSync, getCastSequence, _resetSequenceTable } =
  await import("file://" + resolvePath(__dirname, "..", "ui", "ac_spell_cast_sequence.js"));
const { castCooldownMs } =
  await import("file://" + resolvePath(__dirname, "..", "ui", "ac_cast_ui_logic.js"));

// The sweep's per-spell duration: getCastSequence(id) → totalDurationS →
// castCooldownMs. Mirrors combat-bar.js installCastBusySweep()._durationMsFor.
const sweepMs = (id, speed = 2.0) => castCooldownMs(getCastSequence(id)?.totalDurationS, speed);

_resetSequenceTable();
_loadSequenceSync({
  "57":   { school: "War", shape: "Bolt", level: 1, totalDurationS: 6.4825,
            windupGestures: [{ durationS: 4.4407897 }], castGesture: { durationS: 2.0416667 } },
  "59":   { school: "War", shape: "Bolt", level: 2, totalDurationS: 3.1212,
            windupGestures: [{ durationS: 1.0795455 }], castGesture: { durationS: 2.0416667 } },
  "1708": { school: "Life", shape: "Self", level: 1, totalDurationS: 14.3497,
            windupGestures: [{ durationS: 3.676 }, { durationS: 4.441 }, { durationS: 4.441 }],
            castGesture: { durationS: 1.79 } },
  // A malformed entry with no castGesture → getCastSequence returns null →
  // castCooldownMs(undefined) → 2000ms fallback.
  "999":  {},
});

const cases = [
  ["57 @2.0", sweepMs(57), 3241],
  ["59 @2.0", sweepMs(59), 1561],
  ["1708 @2.0", sweepMs(1708), 7175],
  ["57 @1.0 (legacy castSpeed=off)", sweepMs(57, 1.0), 6483],
  ["missing spell → fallback", sweepMs(999), 2000],
  ["unknown spell id → fallback", sweepMs(424242), 2000],
];

let fail = 0;
for (const [name, got, want] of cases) {
  const ok = Math.abs(got - want) <= 1; // ±1ms absorbs rounding
  if (!ok) { fail += 1; console.error(`  [FAIL] ${name}: got ${got} want ${want}`); }
  else console.log(`  [PASS] ${name}: ${got}ms`);
}

console.log(`\nWS14 cast-cooldown: ${cases.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
