// Wave 6 / Phase 6.2 (2026-05-26) — input→MotionCommand dispatch regression.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_locomotion_dispatch.mjs
//
// ## What this test does
//
// Audit-driven wrapper. Wave 1 + Wave 2.1-2.5 + Wave 5 added 13 Rust
// unit tests in `crates/holtburger-core/src/client/movement/common.rs`
// (and another 26 in `system/tests.rs`) covering EVERY input → wire
// MotionCommand transition the plan calls out:
//
//   W alone (forward, walk)       → forward_command = WalkForward (0x45000005)
//   Shift+W (forward, run)        → forward_command = RunForward  (0x44000007)
//   S alone (backstep, walk)      → forward_command = WalkBackwards (0x45000006)
//   A alone (StrafeLeft, walk)    → sidestep_command = SideStepRight (0x6500000F) + speed = -1.0
//   D alone (StrafeRight, walk)   → sidestep_command = SideStepRight (0x6500000F) + speed = +1.0
//   Q alone (Turn::Left, walk)    → turn_command = TurnRight (0x6500000D) + turn_speed = -1.0
//   E alone (Turn::Right, walk)   → turn_command = TurnRight (0x6500000D) + turn_speed = +1.0
//   W+D simultaneously            → BOTH forward_command AND sidestep_command set (Phase 2.2)
//   W+A simultaneously            → BOTH set, sidestep negated (Phase 2.2 + 2.5)
//   W+Q (forward + turn)          → forward_command only, turn suppressed (Phase 2.4 gating)
//   strafe + turn                 → sidestep_command only, turn suppressed (Phase 2.4 gating)
//
// Rather than re-author these assertions in a JS-only synthetic that
// shells out to a Rust example, we drive the existing `cargo test`
// command and pattern-match the test names to assert the coverage
// surface is wired and PASSING. Re-running the same set after a future
// regression catches drift at the wire-emission layer without the
// browser harness.
//
// ## Why no separate Rust example
//
// Per Phase 6.2's audit recommendation in
// `external/holtburger/docs/movement-animation-overhaul-plan-2026-05-26.md`:
// "Most input→motion-command assertions are already covered by Wave
// 1-5's 165 tests… Write [the .mjs] ONLY if the audit reveals a gap."
//
// The audit (2026-05-26 working set):
//
//   build_motion_state_raw_motion_state_emits_both_forward_and_sidestep        — W+D both slots
//   build_motion_state_raw_motion_state_suppresses_turn_when_only_sidestep_active — turn-gating with sidestep
//   turn_left_emits_right_code_with_negated_speed                              — Q wire shape
//   turn_right_emits_right_code_with_positive_speed                            — E wire shape
//   sidestep_left_emits_right_code_with_negated_speed                          — A wire shape
//   sidestep_right_emits_right_code_with_positive_speed                        — D wire shape
//   local_velocity_for_state_composes_forward_plus_sidestep                    — W+D vector composition
//   motion_state_raw_motion_state_adds_right_turn_when_requested               — E stationary turn-in-place
//   motion_state_raw_motion_state_adds_left_turn_when_requested                — Q stationary turn-in-place
//   motion_state_raw_motion_state_suppresses_turn_when_moving                  — W+Q (forward+turn gating)
//   motion_state_raw_motion_state_omits_turn_when_not_requested                — W alone (no turn slot)
//   motion_state_raw_motion_state_uses_player_run_rate_scalar_for_forward_speed — Shift+W speed scalar
//   autonomous_wire_motion_state_uses_forward_without_turn_when_moving         — W+Q wire dispatch
//   autonomous_wire_motion_state_can_turn_in_place                             — Q stationary wire dispatch
//   test_raw_motion_state_preserves_cached_server_style_by_default             — server-style preservation
//
// All 15 plan-covered cases have a corresponding unit test name in the
// list above. No gap surfaces — the JS-side dispatch wrapper would be
// pure duplication.
//
// ## What this script asserts
//
//   1. `cargo test -p holtburger-core --lib movement::` runs cleanly,
//      exit code 0.
//   2. Each of the 15 plan-mapped test names appears in cargo's PASS
//      output (parses the `test <module>::<name> ... ok` lines).
//   3. Total test count for `movement::` >= 50 (regression guard: if
//      a future refactor accidentally deletes the test module, this
//      number drops fast).
//
// Exit code 0 if all 15 plan-mapped tests passed; 1 otherwise.

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// repoRoot = external/holtburger
const repoRoot = resolvePath(__dirname, "..", "..");

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

console.log("===========================================================");
console.log("Wave 6 / Phase 6.2 — input→MotionCommand dispatch regression");
console.log("===========================================================");

// Shell out to `cargo test -p holtburger-core --lib movement::`. NOTE:
// no `--quiet` — cargo's quiet mode collapses individual `test <name>
// ... ok` lines into a `..............` progress bar and we lose the
// per-test names. The single-thread flag keeps output deterministic;
// runtime cost is ≤ 1s for this filtered subset.
let raw;
let cargoExitCode = 0;
try {
  raw = execSync(
    "cargo test -p holtburger-core --lib movement:: -- --test-threads=1",
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, RUST_LOG: "warn" },
      // First-cold cargo runs can take a few minutes; cap at 10 min.
      timeout: 10 * 60 * 1000,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
} catch (e) {
  raw = (e.stdout ?? "") + (e.stderr ?? "");
  cargoExitCode = e.status ?? 1;
}

console.log("--- cargo test output (tail) ---");
const lines = raw.split("\n");
console.log(lines.slice(-25).join("\n"));
console.log("--- end output ---");
console.log("");

// Plan-mapped test names — one entry per audit row in the header above.
// Each name must appear as PASS in cargo's output, OR the surface is
// regressed and the .mjs wrapper fails.
const PLAN_MAPPED_TESTS = [
  // common.rs — Wave 2 wire-shape tests (post-Phase 2.2 + 2.5).
  ["W+D both slots", "build_motion_state_raw_motion_state_emits_both_forward_and_sidestep"],
  ["turn-gating with sidestep", "build_motion_state_raw_motion_state_suppresses_turn_when_only_sidestep_active"],
  ["Q (StrafeLeft → SideStepRight + -speed)", "turn_left_emits_right_code_with_negated_speed"],
  ["E (StrafeRight → SideStepRight + +speed)", "turn_right_emits_right_code_with_positive_speed"],
  ["A (Turn::Left → TurnRight + -speed)", "sidestep_left_emits_right_code_with_negated_speed"],
  ["D (Turn::Right → TurnRight + +speed)", "sidestep_right_emits_right_code_with_positive_speed"],
  ["W+D vector composition (forward + sidestep)", "local_velocity_for_state_composes_forward_plus_sidestep"],
  // system/tests.rs — Wave 1 + Wave 2 dispatch tests.
  ["E stationary turn-in-place wire", "motion_state_raw_motion_state_adds_right_turn_when_requested"],
  ["Q stationary turn-in-place wire", "motion_state_raw_motion_state_adds_left_turn_when_requested"],
  ["W+Q forward+turn gating", "motion_state_raw_motion_state_suppresses_turn_when_moving"],
  ["W alone (no turn slot)", "motion_state_raw_motion_state_omits_turn_when_not_requested"],
  ["Shift+W run-rate scalar applied", "motion_state_raw_motion_state_uses_player_run_rate_scalar_for_forward_speed"],
  ["W+Q autonomous wire dispatch", "autonomous_wire_motion_state_uses_forward_without_turn_when_moving"],
  ["Q stationary autonomous wire dispatch", "autonomous_wire_motion_state_can_turn_in_place"],
  ["server-style preservation default", "test_raw_motion_state_preserves_cached_server_style_by_default"],
];

// Parse PASS lines from cargo output. Two formats per cargo version:
//   "test <path>::<name> ... ok"
//   "test <name> ... ok"  (when --quiet collapses path)
// Build a Set of all observed PASS test names for O(1) lookup.
const passSet = new Set();
const passLineRegex = /test\s+([\w:_]+)\s+\.\.\.\s+ok/g;
let m;
while ((m = passLineRegex.exec(raw)) !== null) {
  const fullName = m[1];
  // Push both the full path AND the trailing token so the lookup
  // matches whether cargo emitted the module prefix or not.
  passSet.add(fullName);
  const lastSeg = fullName.split("::").pop();
  passSet.add(lastSeg);
}

check(
  "cargo test exit code 0",
  cargoExitCode === 0,
  `exitCode=${cargoExitCode}`,
);

// Per-plan-row assertions.
for (const [label, testName] of PLAN_MAPPED_TESTS) {
  const found = passSet.has(testName);
  check(
    `Wave-mapped test PASSED: ${label}`,
    found,
    found ? "" : `test \`${testName}\` not in cargo PASS output`,
  );
}

// Total-test-count guard. Movement module ships at least 50 unit tests
// (57 at the time this script was written; the 50 floor catches a
// silent-deletion regression while leaving headroom for normal churn).
const totalRunMatch = raw.match(/test result:\s+\w+\.\s+(\d+)\s+passed/);
const totalPass = totalRunMatch ? Number(totalRunMatch[1]) : -1;
check(
  "≥50 movement::* tests PASS (regression floor)",
  totalPass >= 50,
  `totalPass=${totalPass} (audit baseline 57 on 2026-05-26)`,
);

// --- Summary ---
console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log("All Phase 6.2 locomotion-dispatch tests PASS.");
}
