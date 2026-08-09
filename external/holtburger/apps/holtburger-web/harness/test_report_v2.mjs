// harness/test_report_v2.mjs — Tier-1 test for the RESULTS-v2 report writer
// (harness/lib/report.mjs; pass-10 D-10.1/S12; T01 deliverable).
//
// Pure Node. Run: node harness/test_report_v2.mjs — exit 0/1.
//
// Also covers moving-bench's v2 emission path (toResultsV2) against a
// synthetic rep so the conversion is testable without a browser.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReport, assertMetricKey, assertMetricValue, VERDICTS, SCHEMA } from "./lib/report.mjs";
import { toResultsV2 } from "./moving-bench.mjs";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL ${label}`); }
};
const throwsWith = (fn, needle, label) => {
  try { fn(); ok(false, `${label} (expected throw containing "${needle}")`); }
  catch (e) { ok(String(e.message).includes(needle), `${label} (got: ${String(e.message).slice(0, 100)})`); }
};

const HEADER = { bench: "MOVE-FIX", protocol: "PC-3", url: "http://127.0.0.1:8765/x?nosw=1" };

// ── metric-key enforcement (the writer REFUSES untagged figures) ───────────
{
  ok(assertMetricKey("draws@submitted").tags.join() === "submitted", "single-axis key parses");
  ok(assertMetricKey("bytes@wire@preview-complete").tags.join(",") === "wire,preview-complete", "multi-axis key parses");
  throwsWith(() => assertMetricKey("draws"), "untagged metric key", "untagged key refused");
  throwsWith(() => assertMetricKey("bytes@total"), 'unknown scale tag "total"', "off-vocabulary tag refused");
  throwsWith(() => assertMetricKey("@wire"), "bad metric name", "empty name refused");
  throwsWith(() => assertMetricValue("frameMs@moving", 16.7), "implicit p50 claim", "bare number on a *Ms metric refused");
  throwsWith(() => assertMetricValue("frameMs@moving", { p50: 16.7, median: 17 }), 'unknown key "median"', "alien stat key refused");
  // legal values
  assertMetricValue("frameMs@moving", { p50: 16.7, p95: 22, p99: 41, mean: 17.2, max: 60, min: 12, n: 600 });
  assertMetricValue("instances@resident", 5400);
  assertMetricValue("draws@submitted", { p50: 457, mean: 457.8 });
  ok(true, "legal metric values accepted");
}

// ── report assembly rules ──────────────────────────────────────────────────
{
  throwsWith(() => createReport({ protocol: "PC-3", url: "u" }), "header.bench", "missing bench refused");
  const r = createReport(HEADER);
  throwsWith(
    () => r.addArm({ arm: "on", verdict: "USABLE", metrics: { draws: 400 } }),
    "untagged metric key", "arm with untagged metric refused",
  );
  throwsWith(
    () => r.addArm({ arm: "on", verdict: "REJECT", metrics: {} }),
    "must name its reasons", "reason-less REJECT arm refused (PR-10)",
  );
  throwsWith(
    () => r.addArm({ arm: "on", verdict: "OK", metrics: {} }),
    "arm.verdict", "off-vocabulary arm verdict refused",
  );
  throwsWith(() => r.toJSON(), "at least one arm", "armless report refused (verdict check ordering)");

  r.addArm({ arm: "drawPools=on", verdict: "USABLE", metrics: { "frameMs@moving": { p50: 16.1, n: 600 } } });
  throwsWith(() => r.toJSON(), "setVerdict", "verdict-less report refused");
  throwsWith(() => r.setVerdict("MAYBE"), "verdict must be", "off-vocabulary verdict refused");

  // comparative PASS without controlSpread is refused…
  r.addArm({ arm: "drawPools=off", verdict: "USABLE", metrics: { "frameMs@moving": { p50: 17.4, n: 600 } } });
  r.setVerdict("PASS");
  throwsWith(() => r.toJSON(), "controlSpread", "comparative PASS without controlSpread refused (D-10.7)");
  // …and legal with it.
  r.setControlSpread("frameMs@moving.p50", 0.9);
  const obj = r.toJSON();
  ok(obj.schema === SCHEMA, "schema stamp");
  ok(obj.arms.length === 2 && obj.controlSpread.value === 0.9, "two arms + controlSpread serialized");
  ok(Array.isArray(obj.taint) && obj.wasmProfile === "unknown", "run-validity fields recorded");

  // EXPLORATORY single-arm needs no controlSpread.
  const r2 = createReport(HEADER)
    .addArm({ arm: "(default)", verdict: "USABLE", metrics: { "instances@resident": 5400 } })
    .setVerdict("EXPLORATORY");
  ok(r2.toJSON().controlSpread === null, "single-arm EXPLORATORY needs no controlSpread");

  // delta keys are metrics too.
  throwsWith(() => r2.setDelta({ frameMs: 1.2 }), "untagged metric key", "untagged delta key refused");

  // write() round-trips.
  const dir = mkdtempSync(path.join(tmpdir(), "hb-results-"));
  const out = path.join(dir, "r.json");
  r.write(out);
  const back = JSON.parse(readFileSync(out, "utf8"));
  ok(back.schema === SCHEMA && back.arms[1].arm === "drawPools=off", "write() round-trips");
  rmSync(dir, { recursive: true, force: true });

  ok(VERDICTS.join() === "PASS,FAIL,EXPLORATORY,INVALID", "verdict vocabulary is S12's");
}

// ── moving-bench conversion (behavior-preserving emission path) ────────────
{
  // A synthetic rep in the exact shape main() builds (moving-bench.mjs).
  const rep = {
    ts: "2026-08-08T00:00:00.000Z",
    arm: "statBatchSphere=on",
    url: "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1",
    spec: { mode: "orbit", frames: 600 },
    pathChecksum: "abc123",
    realisedChecksum: "abc123",
    frames: { requested: 600, measured: 600, warm: 600 },
    cpuMs: { n: 600, p50: 8.1, p95: 12.2, p99: 19.9, mean: 8.7, min: 5.5, max: 40.1 },
    rafMs: { n: 600, p50: 16.7, p95: 22.1, p99: 41.0, mean: 17.4, min: 12.0, max: 61.2 },
    missedGauge: 0,
    workload: {
      draws: { n: 600, p50: 457, p95: 470, p99: 481, mean: 457.8, min: 440, max: 483 },
      ktris: { n: 600, p50: 812, p95: 850, p99: 861, mean: 815.2, min: 790, max: 865 },
      residentInstances: 5400,
      batchedMeshes: 29,
      staticBatchC: 17,
    },
    lb: { churnFrames: 0, countFirst: 121, countLast: 121, hashFirst: "h1", hashLast: "h1" },
    walkDelta: { calls: 10, hitsExact: 9, hitsSlack: 1, rebuilds: 0 },
    errors: [],
    verdict: "USABLE",
    rejectReasons: [],
  };
  const series = { cpuMs: [1, 2], rafMs: [3, 4], draws: [5, 6] };

  const v2 = toResultsV2(rep, { series });
  ok(v2.schema === SCHEMA, "moving-bench emits hb-results-v2");
  ok(v2.bench === "MOVE-FIX" && v2.protocol === "PC-3", "bench/protocol stamped");
  ok(v2.verdict === "EXPLORATORY", "USABLE single-arm run lands EXPLORATORY (not a scored budget by itself)");
  const arm = v2.arms[0];
  ok(arm.arm === "statBatchSphere=on" && arm.verdict === "USABLE", "arm label + judge verdict carried");
  ok(arm.metrics["frameMs@moving"].p50 === 16.7, "rafMs -> frameMs@moving stat object");
  ok(arm.metrics["cpuMs@moving"].p50 === 8.1, "cpuMs -> cpuMs@moving");
  ok(arm.metrics["draws@submitted"].mean === 457.8, "draws tagged @submitted");
  ok(arm.metrics["ktris@submitted"].p50 === 812, "ktris tagged @submitted");
  ok(arm.metrics["instances@resident"] === 5400, "resident census tagged @resident (never priced as drawn)");
  ok(arm.metrics["batchedMeshes@resident"] === 29 && arm.metrics["staticBatchBuckets@resident"] === 17, "bucket census tagged");
  // Legacy fields ride along on the arm (nothing an operator read is lost).
  ok(arm.pathChecksum === "abc123" && arm.realisedChecksum === "abc123", "checksums preserved");
  ok(arm.frames.measured === 600 && arm.lb.churnFrames === 0, "frames + lb churn preserved");
  ok(arm.walkDelta.hitsExact === 9 && arm.missedGauge === 0, "walkDelta + gauge preserved");
  ok(arm.series.draws.length === 2, "raw series preserved");
  ok(arm.frameMsSource === "raf-interval", "frameMs provenance noted");

  // A REJECT run lands INVALID and keeps its reasons (kept on disk as
  // evidence, never scored).
  const bad = { ...rep, verdict: "REJECT", rejectReasons: ["SHORT (10/600 frames)"] };
  const v2bad = toResultsV2(bad, { series });
  ok(v2bad.verdict === "INVALID" && v2bad.arms[0].rejectReasons.length === 1, "REJECT run -> INVALID with reasons");
}

console.log(`report-v2: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("REPORT-V2 ✅");
  process.exit(0);
} else {
  console.error("REPORT-V2 ❌");
  process.exit(1);
}
