// test_move_telemetry.mjs — the `?moveTelemetry=1` oracle surface.
//
// The BEHAVIOUR half (what the snapshot contains) is Rust and is covered by
// `cargo test -p holtburger-core`. What this file pins is the WIRING, which
// is exactly what silently rots: the flag parse shape, the wasm exports, the
// index.html rider, the docs row, and the fact that the dump site is inside
// the flag guard so the shipped default lane pays nothing.
//
// It also round-trips a synthetic telemetry record through the differ's
// normalizer, so the two halves of the oracle cannot drift apart in shape
// without a test going red.
//
// Run:
//   cd apps/holtburger-web/
//   node test_move_telemetry.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

const libSrc = readFileSync(path.join(here, "src", "lib.rs"), "utf8");
const systemSrc = readFileSync(
  path.join(here, "..", "..", "crates", "holtburger-core", "src", "client", "movement", "system.rs"),
  "utf8",
);
const handleSrc = readFileSync(
  path.join(here, "..", "..", "crates", "holtburger-core", "src", "client", "movement", "handle.rs"),
  "utf8",
);
const indexSrc = readFileSync(path.join(here, "index.html"), "utf8");
const docsSrc = readFileSync(path.join(here, "docs", "url-flags.md"), "utf8");

console.log("PART 1 — flag parse is a strict `=1` opt-in (default OFF)");
check(
  "parse_move_telemetry_flag exists and matches exactly `moveTelemetry=1`",
  /fn parse_move_telemetry_flag\(search: &str\) -> bool/.test(libSrc) &&
    /kv == "moveTelemetry=1"/.test(libSrc),
);
check(
  "flag is NOT a `!= off` shape (which would read ON when absent)",
  !/moveTelemetry.*!=\s*"off"/.test(libSrc),
);
check(
  "flag is stored into an atomic at recv-loop init from flag_search()",
  /MOVE_TELEMETRY_ON\.store\(\s*parse_move_telemetry_flag\(&flag_search\(\)\)/.test(libSrc),
);

console.log("PART 2 — wasm exports the drain + status");
check(
  "moveTelemetryDrain export",
  /js_name = moveTelemetryDrain/.test(libSrc) &&
    /pub fn move_telemetry_drain\(\) -> String/.test(libSrc),
);
check(
  "moveTelemetryStatus export (lo16 buffered / hi16 dropped)",
  /js_name = moveTelemetryStatus/.test(libSrc) &&
    /pub fn move_telemetry_status\(\) -> u32/.test(libSrc),
);
check(
  "ring is bounded (a forgotten flag cannot grow without limit)",
  /const MOVE_TELEMETRY_CAP: usize = \d+;/.test(libSrc) &&
    /ring\.pop_front\(\)/.test(libSrc),
);
check(
  "dropping to the cap is counted, not silent",
  /MOVE_TELEMETRY_DROPPED/.test(libSrc),
);

console.log("PART 3 — the dump site is inside the flag guard");
check(
  "per-tick dump is guarded by move_telemetry_enabled()",
  /if move_telemetry_enabled\(\) \{/.test(libSrc),
);
check(
  "dump lives in the TickMovement arm beside the existing diag stores",
  /CAST_ARBITRATION_DIAG\.store\([\s\S]{0,1200}?if move_telemetry_enabled\(\)/.test(libSrc),
);
check(
  "gait is taken from the interpreter hold_run, not re-derived in JS",
  /"gait": tele\.hold_run\.map/.test(libSrc),
);

console.log("PART 4 — the core snapshot forwarder");
check(
  "MovementTelemetry struct is serializable and Option-typed",
  /pub struct MovementTelemetry \{/.test(systemSrc) &&
    /derive\(Clone, Debug, Default, serde::Serialize\)/.test(systemSrc) &&
    /pub hold_run: Option<bool>,/.test(systemSrc),
);
check(
  "MovementSystem::movement_telemetry reads hold_run + run_rate + cast window",
  /fn movement_telemetry\(&self, local_guid: Guid\) -> MovementTelemetry/.test(systemSrc) &&
    /hold_run: interp\.map\(\|i\| i\.hold_run\)/.test(systemSrc) &&
    /cast_window_active: self\.local_cast_window_active/.test(systemSrc),
);
check(
  "handle forwards it and stamps tick_count (which lives on the handle)",
  /pub fn movement_telemetry\(&self, local_guid: Guid\)/.test(handleSrc) &&
    /t\.tick_count = self\.tick_count;/.test(handleSrc),
);

console.log("PART 5 — JS rider + docs row");
check(
  "index.html exposes the drain, typeof-guarded against a stale pkg/",
  /typeof __hbWasmNs\?\.moveTelemetryDrain === "function"/.test(indexSrc) &&
    /moveTelemetryDrain: \(\) => __hbWasmNs\.moveTelemetryDrain\(\)/.test(indexSrc),
);
const docRow = docsSrc.split("\n").find((l) => l.startsWith("| `moveTelemetry`"));
check("url-flags.md carries a row", Boolean(docRow));
if (docRow) {
  const cells = docRow.split(/(?<!\\)\|/);
  check(
    "docs Default cell reads `off` (what audit-flag-defaults keys polarity on)",
    /^\s*off\b/.test(cells[3] ?? ""),
    `default cell = ${JSON.stringify((cells[3] ?? "").trim())}`,
  );
  check("docs Values cell is `1`", /`1`/.test(cells[2] ?? ""));
}

console.log("PART 6 — record shape round-trips through the differ");
const { normalize, derive, steadySpeed, alignToFirstMotion } = await import(
  "./harness/oracle-diff.mjs"
);
// A record shaped exactly as the lib.rs dump site emits.
const recs = [];
for (let i = 0; i <= 60; i++) {
  const t = i * 50;
  recs.push({
    source: "holt",
    t,
    pos: { lb: "0x00A90106", x: (t / 1000) * 3, y: 0, z: 10, heading_deg: 0 },
    vel: { x: 3, y: 0, z: 0 },
    speed: 3,
    grounded: true,
    airborne_secs: 0,
    is_jumping: false,
    gait: "run",
    cast: false,
    movement: { hold_run: true, run_rate: 1.0, forward_command: "run", pending_motions: 0 },
  });
}
const { samples } = normalize(recs);
derive(samples);
const aligned = alignToFirstMotion(samples).samples;
check("differ normalizes the dump record", aligned.length === recs.length, `${aligned.length} samples`);
check("differ reads the gait through", aligned[0]?.gait === "run");
const sp = steadySpeed(aligned, [500, 2000]);
check("differ recovers the 3 m/s speed", Math.abs(sp - 3) < 0.05, `got ${sp?.toFixed(3)}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
