// Wave 3 / Phase 3.2 (2026-05-26) — per-stance locomotion regression test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_locomotion_per_stance.mjs
//
// Thin .mjs wrapper that shells out to the Rust example
// `cargo run -p holtburger-dat --example player_mt_stance_coverage` —
// which loads `~/ac_base_dats/client_portal.dat`, opens the player
// MotionTable (DID 0x09000001), and asserts per-(stance, cmd) coverage
// against the canonical ACE MotionCommand enum at
// `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:11-23`. Parses
// the example's `CELL_PASS / CELL_FAIL / DISTINCT_PASS / DISTINCT_FAIL
// / OPTIONAL_PRESENT / OPTIONAL_ABSENT / OVERALL` summary block to
// produce a node-side exit code.
//
// Stances tested (per `MotionCommand.cs:67-80`):
//   NonCombat            0x8000003D
//   HandCombat           0x8000003C
//   SwordCombat          0x8000003E
//   BowCombat            0x8000003F
//   SwordShieldCombat    0x80000040
//   DualWieldCombat      0x80000046
//   ThrownWeaponCombat   0x80000047
//   Magic                0x80000049
//
// Required MotionCommands (per stance):
//   WalkForward   0x45000005
//   RunForward    0x44000007
//   SideStepRight 0x6500000F
//   TurnRight     0x6500000D
//
// Optional (retail folds Left → Right with signed speed per
// `~/ac-headers/acclient.c:332761-332775`):
//   SideStepLeft  0x65000010
//   TurnLeft      0x6500000E
//
// We assert REQUIRED cells exist + WalkForward distinctness across
// stances. OPTIONAL absence is informational only — see report log
// for the retail-folding rationale.

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
console.log("Wave 3 / Phase 3.2 — per-stance locomotion regression");
console.log("===========================================================");

// Shell out to the Rust example. Path resolves portal.dat via
// `holtburger_dat::utils::get_portal_dat_path()` → env
// `HOLTBURGER_PORTAL_DAT` → `~/ac_base_dats/client_portal.dat`.
let raw;
try {
  raw = execSync(
    "cargo run --quiet -p holtburger-dat --example player_mt_stance_coverage",
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, RUST_LOG: "warn" },
      // Cargo can spend a few seconds on first run; cap at 5 min.
      timeout: 5 * 60 * 1000,
      // Pipe stderr to stdout so cargo's compile chatter doesn't make
      // node throw on stderr writes. The example itself only writes
      // to stdout.
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
} catch (e) {
  // exit code 1 = OVERALL=FAIL (the example detected missing cells);
  // exit code 2 = setup error (DAT not found, parse failed). Either
  // way we want the stdout/stderr to feed the asserts below.
  raw = (e.stdout ?? "") + (e.stderr ?? "");
}

// Print the raw report so a human can inspect failures without
// re-running cargo.
console.log("--- player_mt_stance_coverage report ---");
console.log(raw);
console.log("--- end report ---");
console.log("");

// Extract the structured summary lines.
function readSummary(key) {
  const m = raw.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

const cellPass = Number(readSummary("CELL_PASS"));
const cellFail = Number(readSummary("CELL_FAIL"));
const optionalPresent = Number(readSummary("OPTIONAL_PRESENT"));
const optionalAbsent = Number(readSummary("OPTIONAL_ABSENT"));
const distinctPass = Number(readSummary("DISTINCT_PASS"));
const distinctFail = Number(readSummary("DISTINCT_FAIL"));
const requiredCells = Number(readSummary("REQUIRED_CELLS"));
const optionalCells = Number(readSummary("OPTIONAL_CELLS"));
const overall = readSummary("OVERALL");

// Assertions.

check(
  "Rust example emitted a summary block",
  Number.isFinite(cellPass)
    && Number.isFinite(cellFail)
    && Number.isFinite(distinctPass)
    && Number.isFinite(distinctFail)
    && Number.isFinite(requiredCells)
    && (overall === "PASS" || overall === "FAIL"),
  `cellPass=${cellPass} cellFail=${cellFail} distinctPass=${distinctPass} ` +
    `distinctFail=${distinctFail} overall=${overall}`,
);

// 8 stances × 4 required cmds = 32 required cells.
check(
  "32 required cells covered (8 stances × {Walk, Run, SideStepRight, TurnRight})",
  requiredCells === 32,
  `requiredCells=${requiredCells}`,
);
// 8 stances × 2 optional cmds = 16 optional cells.
check(
  "16 optional cells inspected (8 stances × {SideStepLeft, TurnLeft})",
  optionalCells === 16,
  `optionalCells=${optionalCells}`,
);

check(
  `All ${requiredCells} REQUIRED cells PASS (no missing cycle entries)`,
  cellPass === requiredCells && cellFail === 0,
  `pass=${cellPass} fail=${cellFail}`,
);

// 7 combat stances vs NonCombat for WalkForward.
check(
  "All 7 combat stances have a distinct WalkForward anim DID vs NonCombat",
  distinctPass === 7 && distinctFail === 0,
  `distinctPass=${distinctPass} distinctFail=${distinctFail}`,
);

// Retail-canonical: SideStepLeft / TurnLeft cycles ABSENT in MT
// 0x09000001 — folded into the Right command with signed speed at
// `~/ac-headers/acclient.c:332761-332775`. The test surfaces this as
// an informational diag, not a failure.
check(
  "Retail SideStepLeft / TurnLeft folding: all optional cells ABSENT (informational)",
  optionalAbsent === 16 && optionalPresent === 0,
  `present=${optionalPresent} absent=${optionalAbsent} (per acclient.c:332761-332775)`,
);

check(
  "OVERALL=PASS from Rust example",
  overall === "PASS",
  `overall=${overall}`,
);

// --- Summary ---
console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log("All Phase 3.2 per-stance locomotion tests PASS.");
}
