#!/usr/bin/env node
// validate_physics_replay.cjs — Wave 3.A end-to-end driver.
//
// Workflow:
//   1. Spawn capture_physics_replay.cjs as a subprocess. It owns the
//      Playwright session, drives the probe scenario, and writes
//      trace-subject.json to /mnt/wbterminal1/holtburger-validator-reports/
//      physics-replay/<ts>_<runId>/. We grep the trace path from stdout.
//   2. Spawn WorldBuilder.Terminal.dll --stdin. Send physics-replay-trace
//      with the captured trace + the probe scenario.
//   3. Parse the response; emit report.json conforming to the §4.4 envelope.
//   4. Exit:
//        0 — passed (maxPositionDriftMeters ≤ 0.10 AND onGroundMismatchCount == 0)
//        1 — drift or on-ground mismatch
//        2 — infra (capture or replay subprocess crashed)
//
// Pre-reqs:
//   - All capture pre-reqs (ACE, wsbridge, http server, dist baked).
//   - WorldBuilder.Terminal built (Release).
//
// Run: `node validate_physics_replay.cjs`
//   Env overrides:
//     RUN_ID            — passed through to capture (default: auto_<base36>).
//     PHASE4_*          — passed through to capture.
//     SKIP_CAPTURE      — if set, expects PHYSICS_REPLAY_SUBJECT_TRACE env
//                          to point at an existing trace-subject.json
//                          (skips Playwright; used for unit-testing the
//                          replay engine in isolation).
//
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// ── Constants ────────────────────────────────────────────────────────────
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const WBT_DLL = path.join(
  REPO_ROOT,
  "WorldBuilder.Terminal",
  "bin",
  "Release",
  "net8.0",
  "WorldBuilder.Terminal.dll"
);
const DOTNET = process.env.DOTNET_ROOT
  ? path.join(process.env.DOTNET_ROOT, "dotnet")
  : "/home/wbterminal/.dotnet/dotnet";

const CAPTURE_SCRIPT = path.resolve(__dirname, "capture_physics_replay.cjs");
const SCENARIO_PATH = process.env.PHYSICS_REPLAY_SCENARIO
  || path.resolve(__dirname, "fixtures/physics/probe-scenario.json");

// ── Subprocess helpers ───────────────────────────────────────────────────
function runCapture() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CAPTURE_SCRIPT)) {
      reject(new Error(`capture script missing: ${CAPTURE_SCRIPT}`));
      return;
    }
    console.log(`[w3a-val] spawning capture: node ${CAPTURE_SCRIPT}`);
    const child = spawn("node", [CAPTURE_SCRIPT], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    let lastTracePath = null;
    child.stdout.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      stdoutBuf += s;
      // Echo capture output prefixed so the driver log is readable.
      process.stdout.write(s.replace(/^/gm, "    "));
      const match = s.match(/TRACE_SUBJECT_PATH=(\S+)/);
      if (match) lastTracePath = match[1];
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      stderrBuf += s;
      process.stderr.write(s.replace(/^/gm, "    [stderr] "));
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && lastTracePath) {
        resolve(lastTracePath);
      } else {
        reject(new Error(
          `capture exited with code=${code}; lastTracePath=${lastTracePath ?? "(none)"}\n` +
          `stderr (tail): ${stderrBuf.split("\n").slice(-10).join("\n")}`
        ));
      }
    });
  });
}

function runWbtReplay(traceSubjectPath, probeScenarioPath, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(WBT_DLL)) {
      reject(new Error(`WorldBuilder.Terminal.dll missing at ${WBT_DLL} — build with: dotnet build WorldBuilder.Terminal -c Release`));
      return;
    }
    console.log(`[w3a-val] spawning WorldBuilder.Terminal --stdin`);
    const child = spawn(DOTNET, [WBT_DLL, "--stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    let resolved = false;
    const settled = (handler) => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch (_) {}
      handler();
    };
    const timer = setTimeout(() => {
      settled(() => reject(new Error(
        `WB.Terminal subprocess timeout after ${timeoutMs}ms\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`
      )));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (_) { continue; }
        if (obj.command === "physics-replay-trace") {
          clearTimeout(timer);
          if (obj.success === false) {
            settled(() => reject(new Error(`physics-replay-trace failed: ${obj.error ?? JSON.stringify(obj)}`)));
          } else {
            settled(() => resolve(obj));
          }
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timer); settled(() => reject(err)); });
    child.on("exit", (code) => {
      if (resolved) return;
      clearTimeout(timer);
      settled(() => reject(new Error(
        `WB.Terminal exited (code=${code}) without emitting physics-replay-trace response.\nstderr: ${stderrBuf}`
      )));
    });
    const cmd = {
      command: "physics-replay-trace",
      traceSubjectPath,
      probeScenarioPath,
    };
    child.stdin.write(JSON.stringify(cmd) + "\n");
  });
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  console.log("=== Wave 3.A physics-replay-trace validator ===");
  console.log(`scenario:  ${SCENARIO_PATH}`);
  console.log(`WBT dll:   ${WBT_DLL}`);
  if (!fs.existsSync(SCENARIO_PATH)) {
    console.error(`FATAL: scenario fixture missing: ${SCENARIO_PATH}`);
    process.exit(2);
  }
  if (!fs.existsSync(WBT_DLL)) {
    console.error(`FATAL: WorldBuilder.Terminal.dll missing at ${WBT_DLL}`);
    console.error(`Build: dotnet build WorldBuilder.Terminal -c Release`);
    process.exit(2);
  }

  let traceSubjectPath;
  if (process.env.SKIP_CAPTURE === "1") {
    traceSubjectPath = process.env.PHYSICS_REPLAY_SUBJECT_TRACE;
    if (!traceSubjectPath || !fs.existsSync(traceSubjectPath)) {
      console.error(`FATAL: SKIP_CAPTURE=1 but PHYSICS_REPLAY_SUBJECT_TRACE missing or invalid (${traceSubjectPath})`);
      process.exit(2);
    }
    console.log(`[w3a-val] SKIP_CAPTURE=1; using existing trace: ${traceSubjectPath}`);
  } else {
    try {
      traceSubjectPath = await runCapture();
      console.log(`[w3a-val] capture OK: ${traceSubjectPath}`);
    } catch (e) {
      console.error(`[w3a-val] CAPTURE FAILED: ${e.message}`);
      process.exit(2);
    }
  }

  const reportDir = path.dirname(traceSubjectPath);
  let replay;
  try {
    replay = await runWbtReplay(traceSubjectPath, SCENARIO_PATH);
  } catch (e) {
    console.error(`[w3a-val] REPLAY FAILED: ${e.message}`);
    // Emit a failure report so we have evidence.
    fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify({
      surface: "physics-replay",
      runId: process.env.RUN_ID ?? null,
      startedAt: new Date().toISOString(),
      infraError: e.message,
      traceSubjectPath,
      probeScenarioPath: SCENARIO_PATH,
    }, null, 2));
    process.exit(2);
  }

  // ─── Emit §4.4 envelope ───────────────────────────────────────
  const envelope = {
    surface: "physics-replay",
    oracle: {
      kind: "wb-terminal-cpysicsobj-cport",
      method: "physics-parity-method.md",
      citations: [
        "~/ac-headers/acclient.c:322719 CPhysicsObj::UpdateObjectInternal",
        "~/ac-headers/acclient.c:343373 CPhysicsObj::on_ground",
        "~/ac-headers/acclient.h:3688 enum TransientState (CONTACT_TS|ON_WALKABLE_TS)",
        "~/ace-server/Source/ACE.Server/Physics/PhysicsGlobals.cs (Gravity=-9.8, Epsilon=0.0002)",
      ],
    },
    subject: {
      kind: "holtburger-web-wasm-prediction",
      probeScenarioPath: SCENARIO_PATH,
      traceSubjectPath,
      runId: process.env.RUN_ID ?? null,
    },
    summary: {
      tickCount: replay.tickCount,
      maxPositionDriftMeters: replay.maxPositionDriftMeters,
      maxPositionDriftTick: replay.maxPositionDriftTick,
      meanDriftMeters: replay.meanDriftMeters,
      onGroundMismatchCount: replay.onGroundMismatchCount,
      onGroundSubjectMissingCount: replay.onGroundSubjectMissingCount,
      passed: replay.passed,
    },
    mismatchSampleCount: (replay.mismatches ?? []).length,
    mismatches: replay.mismatches ?? [],
    notes: replay.notes,
    finishedAt: new Date().toISOString(),
    outputPath: reportDir,
  };
  const reportPath = path.join(reportDir, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(envelope, null, 2));
  console.log(`[w3a-val] wrote ${reportPath}`);

  // ─── Console summary ──────────────────────────────────────────
  console.log("");
  console.log("=== Wave 3.A physics-replay-trace SUMMARY ===");
  console.log(`tickCount:                  ${replay.tickCount}`);
  console.log(`maxPositionDriftMeters:     ${replay.maxPositionDriftMeters.toFixed(4)} m  (tick ${replay.maxPositionDriftTick})`);
  console.log(`meanDriftMeters:            ${replay.meanDriftMeters.toFixed(4)} m`);
  console.log(`onGroundMismatchCount:      ${replay.onGroundMismatchCount}`);
  console.log(`onGroundSubjectMissingCount:${replay.onGroundSubjectMissingCount}`);
  console.log(`passed:                     ${replay.passed}`);
  console.log(`notes:                      ${replay.notes}`);
  console.log("");

  process.exit(replay.passed ? 0 : 1);
})().catch((err) => {
  console.error("[w3a-val] FATAL:", err?.stack || err?.message || err);
  process.exit(2);
});
