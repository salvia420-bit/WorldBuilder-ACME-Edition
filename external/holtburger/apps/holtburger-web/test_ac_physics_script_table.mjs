// test_ac_physics_script_table.mjs — runs `ui/ac_physics_script_table.js`'s
// inline self-tests (cache sharing, DAT-miss / parse-failure null caching,
// and — 2026-10-07 — transient failures NOT being cached: a lookup made before
// the wasm is up, or one whose prefetch threw, must retry on the next call
// instead of leaving every effect keyed on that table dead for the session).
//
// Run: cd apps/holtburger-web && node test_ac_physics_script_table.mjs
import { _runSelfTests } from "./ui/ac_physics_script_table.js";

try {
  const r = await _runSelfTests();
  console.log(`ac-pst: ${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed === 0 ? 0 : 1);
} catch (e) {
  console.error("ac-pst: FAILED —", e?.message ?? e);
  process.exit(1);
}
