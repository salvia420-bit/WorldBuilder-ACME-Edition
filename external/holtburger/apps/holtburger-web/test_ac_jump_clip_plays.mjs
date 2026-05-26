// Wave 6 / Phase 6.2 (2026-05-26) — Jump clip data-presence regression.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_jump_clip_plays.mjs
//
// ## What this test does
//
// Regression guard for the Wave 1 / Phase 1.2 fix that deleted the
// airborne-overlay tween in `apps/holtburger-web/scene3d/entities.js`.
// Pre-fix, the real motion-table Jump clip was fetched but the
// AnimationMixer was paused (`entities.js:2806` in the pre-Wave-1
// code), so `mixer.time` never advanced and the rig sat frozen at
// frame 0 with the tween's arms-spread pose layered on top.
//
// A truly runtime-tight test would assert `mixer.time > 0` after
// `mixer.update(dt)` is called following `setMotion(guid, Jump,
// stance)`. That requires a Three.js scene + skeleton + WebGL
// context, which is deferred to Phase 6.3 (1070 Ti Playwright capture
// — see plan §"Phase 6.3 — DEFERRED").
//
// This test covers the NECESSARY (but not sufficient) precondition:
// the MotionTable data shape supports the runtime path. If the data
// is missing for a stance, the renderer's `_tryPlayLink` fetch silently
// returns null and the rig stays at idle (the same visible symptom as
// the original bug, root-caused differently).
//
// Thin .mjs wrapper that shells out to the Rust example
// `cargo run -p holtburger-dat --example jump_clip_data_check` — which
// loads `~/ac_base_dats/client_portal.dat`, opens the player MotionTable
// (DID 0x09000001), and for each of the 12 player stances asserts at
// least one of:
//
//   cycles[(stance, Jump=0x2500003B)] non-empty
//   links[(stance, Ready=0x41000003)][Jump=0x2500003B] non-empty
//
// Parses the example's structured `KEY=VALUE` summary block.
//
// ## Why both paths are checked
//
// The renderer's `entities.js` routes Jump through `_tryPlayLink` with
// `from = Ready = 0x41000003` (see `entities.js:2842-2856` and the
// comment block at 2820-2841). That maps to the LINK path on the wire,
// not the CYCLE path. But some retail data variations have used the
// cycle path historically (motion-table v2 dumps from acpedia mention
// both); the test accepts either presence as a pass to avoid
// false-negatives on alternative DATs while still failing on TOTAL
// absence — which IS the runtime-visible regression we want to catch.
//
// ## Failure modes
//
// - STANCES_MISSING_JUMP > 0: at least one stance has no Jump entry
//   anywhere. The renderer's link fetch returns null for that stance;
//   spacebar plays nothing. Indicates a DAT corruption or a parser
//   regression (e.g. an off-by-one mask in `make_key`).
//
// - NEITHER_HITS > 0: equivalent to STANCES_MISSING_JUMP > 0, but
//   surfaces the counter the example also tracks.
//
// - OVERALL=FAIL (exit code 1): rolled-up signal.

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
console.log("Wave 6 / Phase 6.2 — Jump clip data-presence regression");
console.log("===========================================================");

// Shell out to the Rust example. Path resolves portal.dat via
// `holtburger_dat::utils::get_portal_dat_path()` → env
// `HOLTBURGER_PORTAL_DAT` → `~/ac_base_dats/client_portal.dat`.
let raw;
try {
  raw = execSync(
    "cargo run --quiet -p holtburger-dat --example jump_clip_data_check",
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, RUST_LOG: "warn" },
      // Cargo can spend a few seconds on first run; cap at 5 min.
      timeout: 5 * 60 * 1000,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
} catch (e) {
  // exit code 1 = OVERALL=FAIL (the example detected a missing stance);
  // exit code 2 = setup error (DAT not found, parse failed). Either
  // way we want the stdout/stderr to feed the asserts below.
  raw = (e.stdout ?? "") + (e.stderr ?? "");
}

// Print the raw report so a human can inspect failures without
// re-running cargo.
console.log("--- jump_clip_data_check report ---");
console.log(raw);
console.log("--- end report ---");
console.log("");

// Extract the structured summary lines.
function readSummary(key) {
  const m = raw.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

const stancesChecked = Number(readSummary("STANCES_CHECKED"));
const stancesWithJump = Number(readSummary("STANCES_WITH_JUMP"));
const stancesMissingJump = Number(readSummary("STANCES_MISSING_JUMP"));
const linkHits = Number(readSummary("LINK_HITS"));
const bothHits = Number(readSummary("BOTH_HITS"));
const neitherHits = Number(readSummary("NEITHER_HITS"));
const animsNonempty = Number(readSummary("ANIMS_NONEMPTY"));
const tablesScanned = Number(readSummary("TABLES_SCANNED"));
const tablesWithJump = Number(readSummary("TABLES_WITH_JUMP"));
const firstWithJump = readSummary("FIRST_WITH_JUMP");
const overall = readSummary("OVERALL");

// Assertions.

check(
  "Rust example emitted a summary block",
  Number.isFinite(stancesChecked)
    && Number.isFinite(stancesWithJump)
    && Number.isFinite(neitherHits)
    && (overall === "PASS" || overall === "FAIL"),
  `checked=${stancesChecked} with=${stancesWithJump} missing=${stancesMissingJump} overall=${overall}`,
);

// 12 player stances per `ACE.Entity.Enum.MotionStance`.
check(
  "12 player stances checked (per MotionStance.cs)",
  stancesChecked === 12,
  `stancesChecked=${stancesChecked}`,
);

check(
  "Every stance has a Jump entry (cycle OR link)",
  stancesWithJump === stancesChecked && stancesMissingJump === 0,
  `with=${stancesWithJump}/${stancesChecked} missing=${stancesMissingJump}`,
);

check(
  "No stance reports NEITHER cycle nor link path populated",
  neitherHits === 0,
  `neitherHits=${neitherHits}`,
);

// The Wave-1 fix relies on the link path firing (entities.js
// _tryPlayLink with from=Ready). At least one stance must hit it.
check(
  "At least one stance uses the link-from-Ready path (renderer's actual fetch)",
  (linkHits + bothHits) > 0,
  `link_hits=${linkHits} both_hits=${bothHits}`,
);

// Where the link path is used, the link entry must have ≥1 anim.
// `animsNonempty` already counts those; the assertion is that it
// matches the link+both total.
check(
  "Link entries with anims = link_hits + both_hits (no empty-anim entries)",
  animsNonempty === (linkHits + bothHits),
  `anims_nonempty=${animsNonempty} expected=${linkHits + bothHits}`,
);

check(
  "Cross-check: ≥1 motion table in 0x09000000-0x0900FFFF has Jump",
  tablesWithJump > 0,
  `scanned=${tablesScanned} with_jump=${tablesWithJump} first=${firstWithJump}`,
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
  // If every assertion under the per-stance + cross-DAT block failed
  // identically, surface the headline finding so the operator doesn't
  // have to scroll the wall of FAILs to interpret them. This pattern
  // (zero jump anywhere in 436 MTs) is the Wave 6 regression-guard's
  // intended trigger — it means the Wave 1 / Phase 1.2 fix removed
  // the airborne overlay but the runtime now has NO clip to play in
  // its place.
  if (stancesMissingJump === stancesChecked
      && tablesWithJump === 0
      && tablesScanned > 0) {
    console.log("");
    console.log("==============================================================");
    console.log("FINDING — Jump clip is ABSENT from every motion table in the");
    console.log("retail client_portal.dat (0 of " + tablesScanned + " tables in 0x09000000–");
    console.log("0x0900FFFF contain a `cmd_low == 0x003B` entry).");
    console.log("");
    console.log("This contradicts the Wave 1 / Phase 1.2 plan claim that");
    console.log("\"the real motion-table Jump clip does the work\" once the");
    console.log("airborne overlay tween was deleted. The Z-arc still plays");
    console.log("via physics (acclient.c-style ballistic integration), but");
    console.log("the AnimationMixer has no clip to advance — the rig holds");
    console.log("its idle pose during the entire jump arc.");
    console.log("");
    console.log("Follow-up work: re-investigate how retail produces the");
    console.log("Jump clip. Possible answers (in order of likelihood):");
    console.log("  1. The Jump clip lives in a NON-MotionTable source");
    console.log("     (a standalone Animation DAT, hard-bound to a");
    console.log("     specific anim_did in code).");
    console.log("  2. The renderer should be reading from a DIFFERENT");
    console.log("     MotionTable (e.g. an outfit-specific override).");
    console.log("  3. The plan was wrong; retail's Jump never plays a");
    console.log("     dedicated clip and the original `setAirborne`");
    console.log("     overlay was the only visual cue.");
    console.log("==============================================================");
  }
} else {
  console.log("All Phase 6.2 Jump-clip data-presence tests PASS.");
  console.log("");
  console.log("Note: This test asserts the DATA shape is correct. The");
  console.log("runtime mixer-advance assertion (that the AnimationMixer's");
  console.log("`mixer.time` actually increments under setMotion(Jump))");
  console.log("requires a Three.js scene + WebGL context and is deferred");
  console.log("to Phase 6.3 (1070 Ti Playwright capture).");
}
