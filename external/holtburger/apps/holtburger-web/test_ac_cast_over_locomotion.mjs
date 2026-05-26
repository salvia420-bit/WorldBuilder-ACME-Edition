// Wave 4 / Phase 4.3 (2026-05-26) — magic cast over locomotion smoke test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_cast_over_locomotion.mjs
//
// Thin .mjs wrapper that shells out to the Rust example
// `cargo run -p holtburger-dat --example cast_over_locomotion` — which
// loads `~/ac_base_dats/client_portal.dat`, opens the player MotionTable
// (DID 0x09000001), and asserts the data shape supports layered cast-
// over-locomotion playback:
//
//   Layer 1: `cycles[(Magic stance, WalkForward)]` exists with non-
//            empty `anims`. Drives leg motion via `setMotion(Walk)`.
//
//   Layer 2: `modifiers[MagicPowerUpNN]` (at least one) AND
//            `modifiers[MagicBlast / MagicSelf / etc]` (at least one)
//            exist with non-empty `anims`. Drive arm gestures via
//            the `_tryPlayLink` overlay path in `playCastSequence`.
//
//   Distinctness: every cast modifier anim DID differs from the
//                 Magic walk anim DID (so the two layers don't touch
//                 the same clip).
//
// This is a DATA-level assertion. It does NOT exercise the runtime
// `playCastSequence` JS function or the AnimationMixer — that's
// already shipped (Wave 14 / Phase 45) and would require a browser
// + WebGL context. This test confirms the underlying motion-table
// data shape supports what the JS runtime does at line ~2300 of
// `scene3d/entities.js`.
//
// ## Why both layers must exist + be distinct
//
// Per `~/ac-headers/acclient.c:332778-332779`, retail's combat path
// overlays the cast modifier ON TOP of the active forward command:
//
// ```c
// // cast_command holds the active cast gesture (modifier-class).
// // forward_command holds the active locomotion (cycle-class).
// // ApplyMotion writes both independently; the runtime composes them.
// ```
//
// In our JS port (Wave 14 / Phase 45 in entities.js:2300), the
// locomotion cycle plays at action weight 1.0 via setMotion(Walk),
// and the cast modifier overlays at weight 1.0 via setSwingMotion
// (which routes through `_tryPlayLink`). Three.js AnimationMixer
// blends per-bone weights; the modifier targets arm bones, the
// cycle targets leg bones. If both layers reference the SAME anim
// DID, the mixer would double-bind the same clip's tracks and
// produce undefined per-bone behaviour.
//
// ## Failure modes
//
// - LOCOMOTION_FAIL: no `cycles[(Magic, WalkForward)]` entry, or empty
//   anims. The legs would stop animating during cast in Magic stance.
//   Surface a data bug in the source DAT (or our parser).
//
// - CAST_LAYERS_FAIL: no powerups or no cast gestures present in
//   `modifiers`. The arms wouldn't gesture during cast. Magic stance
//   would still walk, but no incant pose.
//
// - OVERLAPPING_LAYERS: at least one cast modifier's anim DID equals
//   the Magic walk anim DID. Indicates a content bug where the same
//   clip is wired into both layers — the mixer would double-bind and
//   produce incorrect blended output.

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
console.log("Wave 4 / Phase 4.3 — cast over locomotion data-shape smoke");
console.log("===========================================================");

// Shell out to the Rust example. Path resolves portal.dat via
// `holtburger_dat::utils::get_portal_dat_path()` → env
// `HOLTBURGER_PORTAL_DAT` → `~/ac_base_dats/client_portal.dat`.
let raw;
try {
  raw = execSync(
    "cargo run --quiet -p holtburger-dat --example cast_over_locomotion",
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
  // exit code 1 = OVERALL=FAIL (the example detected a data-shape
  // violation); exit code 2 = setup error (DAT not found, parse
  // failed). Either way we want the stdout/stderr to feed the
  // asserts below.
  raw = (e.stdout ?? "") + (e.stderr ?? "");
}

// Print the raw report so a human can inspect failures without
// re-running cargo.
console.log("--- cast_over_locomotion report ---");
console.log(raw);
console.log("--- end report ---");
console.log("");

// Extract the structured summary lines.
function readSummary(key) {
  const m = raw.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

const locomotionPass = Number(readSummary("LOCOMOTION_PASS"));
const locomotionFail = Number(readSummary("LOCOMOTION_FAIL"));
const castLayersPass = Number(readSummary("CAST_LAYERS_PASS"));
const castLayersFail = Number(readSummary("CAST_LAYERS_FAIL"));
const overlappingLayers = Number(readSummary("OVERLAPPING_LAYERS"));
const distinctLayers = Number(readSummary("DISTINCT_LAYERS"));
const magicWalkAnim = readSummary("MAGIC_WALK_ANIM");
const overall = readSummary("OVERALL");

// Assertions.

check(
  "Rust example emitted a summary block",
  Number.isFinite(locomotionPass)
    && Number.isFinite(locomotionFail)
    && Number.isFinite(castLayersPass)
    && Number.isFinite(castLayersFail)
    && (overall === "PASS" || overall === "FAIL"),
  `locPass=${locomotionPass} locFail=${locomotionFail} castPass=${castLayersPass} ` +
    `castFail=${castLayersFail} overall=${overall}`,
);

check(
  "Layer 1: Magic + WalkForward cycle PRESENT with non-empty anims",
  locomotionPass === 1 && locomotionFail === 0,
  `pass=${locomotionPass} fail=${locomotionFail} walk_anim=${magicWalkAnim ?? "?"}`,
);

// Layer 2 has 2 sub-cases (powerups + gestures); both must pass.
check(
  "Layer 2: ≥1 MagicPowerUp AND ≥1 cast gesture present in modifiers",
  castLayersPass === 2 && castLayersFail === 0,
  `pass=${castLayersPass}/2 fail=${castLayersFail}`,
);

check(
  "Layer 1+2 distinctness: no cast modifier shares the Magic walk anim DID",
  overlappingLayers === 0 && distinctLayers > 0,
  `distinct=${distinctLayers} overlapping=${overlappingLayers}`,
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
  console.log("All Phase 4.3 cast-over-locomotion data-shape tests PASS.");
}
