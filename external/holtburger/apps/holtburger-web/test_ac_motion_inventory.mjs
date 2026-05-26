// Wave 8 / Phase 8.4 (2026-05-26) — MotionCommand inventory data-presence smoke.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_motion_inventory.mjs
//
// Thin .mjs wrapper that shells out to the Rust example
// `cargo run -p holtburger-dat --example wave_8_motion_inventory` — which
// loads `~/ac_base_dats/client_portal.dat`, opens the player MotionTable
// (DID 0x09000001), and probes each new Wave 8 classifier category against
// `links[(stance, Ready)][cmd]` / `cycles[(stance, cmd)]`.
//
// **Pass bar:** ≥20 emote commands wired in player MT
// `links[(NonCombat, Ready)][emote_cmd]` (matches the brief's "player MT
// expected to have emotes + sitting/sleeping/resting"). Loose threshold
// because exact count depends on the source DAT version; 20 is well below
// the observed retail count of 53.
//
// Also reports NPC MT sample to confirm the classifier isn't player-MT-
// specific (3 NPC MTs with ≥100 cycles, picked deterministically by ID
// ascending).

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
console.log("Wave 8 / Phase 8.4 — MotionCommand inventory data-presence smoke");
console.log("===========================================================");

// Shell out to the Rust example. Path resolves portal.dat via
// `holtburger_dat::utils::get_portal_dat_path()` → env
// `HOLTBURGER_PORTAL_DAT` → `~/ac_base_dats/client_portal.dat`.
let raw;
try {
  raw = execSync(
    "cargo run --quiet -p holtburger-dat --example wave_8_motion_inventory",
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, RUST_LOG: "warn" },
      timeout: 5 * 60 * 1000,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
} catch (e) {
  raw = (e.stdout ?? "") + (e.stderr ?? "");
}

console.log("--- wave_8_motion_inventory report ---");
console.log(raw);
console.log("--- end report ---");
console.log("");

// Extract the structured summary lines.
function readSummary(key) {
  const m = raw.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

const emotesPresent = Number(readSummary("EMOTES_PRESENT"));
const emotesTotal = Number(readSummary("EMOTES_TOTAL"));
const reactionsNoncombat = Number(readSummary("REACTIONS_NONCOMBAT"));
const reactionsHandcombat = Number(readSummary("REACTIONS_HANDCOMBAT"));
const stationaryAny = Number(readSummary("STATIONARY_ANY"));
const stationaryTotal = Number(readSummary("STATIONARY_TOTAL"));
const interactionsPresent = Number(readSummary("INTERACTIONS_PRESENT"));
const interactionsTotal = Number(readSummary("INTERACTIONS_TOTAL"));
const idlePresent = Number(readSummary("IDLE_PRESENT"));
const idleTotal = Number(readSummary("IDLE_TOTAL"));
const overall = readSummary("OVERALL");

// Assertions.

check(
  "Rust example emitted a summary block",
  Number.isFinite(emotesPresent)
    && Number.isFinite(emotesTotal)
    && (overall === "PASS" || overall === "FAIL"),
  `emotes=${emotesPresent}/${emotesTotal} overall=${overall}`,
);

check(
  "Player MT 0x09000001 has ≥20 emotes in links[(NonCombat, Ready)][cmd]",
  emotesPresent >= 20,
  `present=${emotesPresent}/${emotesTotal}`,
);

check(
  "Player MT 0x09000001 has all 40 stationary poses in cycles (any stance)",
  stationaryAny === stationaryTotal,
  `present=${stationaryAny}/${stationaryTotal}`,
);

check(
  "Player MT 0x09000001 has ≥10 interactions in links[(NonCombat, Ready)][cmd]",
  interactionsPresent >= 10,
  `present=${interactionsPresent}/${interactionsTotal} (Pickup, Eat, Drink, etc. expected)`,
);

// Reactions are EXPECTED to be 0 in player MT — they live on creature MTs
// only (per Wave 8 audit. The classifier still wires them so a creature
// receiving an UpdateMotion(Twitch1) plays the clip from ITS MT).
check(
  "Player MT 0x09000001 reactions are 0 in NonCombat links — EXPECTED (creature-only)",
  reactionsNoncombat === 0 && reactionsHandcombat === 0,
  `noncombat=${reactionsNoncombat} handcombat=${reactionsHandcombat} (Twitch+Stagger only present on creature MTs)`,
);

// Idle ambient — only LogOut typically; other entries are state-change
// flashes that may or may not exist in the player table.
check(
  "Player MT 0x09000001 has ≥1 idle-ambient entry (LogOut at minimum)",
  idlePresent >= 1,
  `present=${idlePresent}/${idleTotal}`,
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
  console.log("All Phase 8.4 motion-inventory data-presence tests PASS.");
}
