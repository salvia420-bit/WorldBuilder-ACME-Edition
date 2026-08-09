// harness/test_frame_phase_census.mjs — T21: the GATE-PHASE census reducer
// (harness/frame-phase-census.mjs) + its RESULTS-v2 round trip.
//
//   PART 1 — reduction math: cumulative deltas / frame deltas, window means,
//            stat objects, idle/reload windows rejected not averaged (PR-10).
//   PART 2 — CLI round trip: synthetic samples file -> hb-results-v2 with
//            tagged stat-object metrics, EXPLORATORY verdict, framePhase on
//            the taint list.
//
// Run:  node harness/test_frame_phase_census.mjs        (exit 0/1)

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reduceCensusSamples, S1_ASSUMED_MS } from "./frame-phase-census.mjs";

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${msg}`); }
}

// Build a cumulative snapshot from per-frame phase means and a frame count.
function snap(frames, means) {
  return {
    tMs: frames * 16.7,
    phase: {
      p0Ms: means.p0 * frames, p1Ms: means.p1 * frames, p2Ms: means.p2 * frames,
      p3Ms: means.p3 * frames, p4Ms: means.p4 * frames, frames,
    },
  };
}

console.log("PART 1 — reduction");
{
  const m = { p0: 1.5, p1: 0.3, p2: 4.0, p3: 8.0, p4: 0.05 };
  const samples = [snap(0, m), snap(60, m), snap(120, m), snap(180, m)];
  const red = reduceCensusSamples(samples);
  check(red.windows === 3, `3 windows (got ${red.windows})`);
  check(red.framesTotal === 180, `180 frames (got ${red.framesTotal})`);
  for (const [p, want] of Object.entries(m)) {
    const st = red.perPhase[p];
    check(Math.abs(st.mean - want) < 1e-9, `${p} mean ${want} (got ${st?.mean})`);
    check(st.n === 3 && st.p50 === want && st.max === want, `${p} stat object populated`);
  }
  check(red.invalid.length === 0, "no rejects on clean input");
}
{
  // Idle window (frames unchanged) contributes nothing; a reload (frames
  // backwards) is rejected with a reason, never averaged.
  const m = { p0: 1, p1: 1, p2: 1, p3: 1, p4: 1 };
  const samples = [snap(0, m), snap(0, m), snap(50, m), snap(10, m), snap(60, m)];
  const red = reduceCensusSamples(samples);
  check(red.invalid.length === 1 && /backwards/.test(red.invalid[0]), "reload window rejected with reason");
  check(red.windows === 2, `idle window skipped, reload rejected (windows=${red.windows})`);
  check(reduceCensusSamples([]).windows === 0, "empty input -> zero windows");
  check(reduceCensusSamples([snap(0, m)]).windows === 0, "single snapshot -> zero windows");
}
{
  check(S1_ASSUMED_MS.p4 === 6.0 && S1_ASSUMED_MS.p0 === 1.0, "S1 [A] anchors carried for the re-class table");
}

console.log("PART 2 — CLI round trip");
{
  const dir = mkdtempSync(join(tmpdir(), "fp-census-"));
  try {
    const m = { p0: 1.2, p1: 0.2, p2: 5.5, p3: 9.1, p4: 0.4 };
    const file = join(dir, "samples.json");
    writeFileSync(file, JSON.stringify({
      meta: { url: "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&framePhase=on" },
      samples: [snap(0, m), snap(60, m), snap(120, m)],
    }));
    const out = join(dir, "results.json");
    const stdout = execFileSync(process.execPath, [
      new URL("./frame-phase-census.mjs", import.meta.url).pathname,
      "--in", file, "--out", out, "--regime", "parked", "--arm", "legacy",
    ], { encoding: "utf8" });
    check(/re-?class|S1-assumed/i.test(stdout) || /phase\s+S1/.test(stdout), "prints the re-class table");
    const r = JSON.parse(readFileSync(out, "utf8"));
    check(r.schema === "hb-results-v2", "writes hb-results-v2");
    check(r.bench === "FRAME-PHASE-CENSUS" && r.gate === "GATE-PHASE", "bench/gate stamped");
    check(r.verdict === "EXPLORATORY", "census is EXPLORATORY, never a gate score");
    check(r.taint.includes("framePhase"), "instrument flag rides the taint list");
    const arm = r.arms[0];
    const p2 = arm.metrics["framePhaseP2Ms@parked"];
    check(p2 && Math.abs(p2.mean - m.p2) < 1e-9, "tagged stat-object metric round-trips");
    check(arm.metrics["frames@parked"] === 120, "frame count tagged with the regime");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nframe-phase-census test: ${passed} passed, ${failed} failed`);
if (failed === 0) { console.log("FRAME-PHASE-CENSUS ✅"); process.exit(0); }
console.log("FRAME-PHASE-CENSUS ❌");
process.exit(1);
