#!/usr/bin/env node
// rynth_test_all_node.cjs — single runner for the plain-node rynth test suite.
//
// Discovers every `rynth_*_test.cjs` in this directory (that glob already covers
// rynth_navsim_test.cjs and the *_coverage_test.cjs files) and runs each as an
// isolated child `node <file>` process, collecting exit codes. Prints a per-file
// PASS/FAIL/SKIP table + totals and exits nonzero if any file failed.
//
// What is NOT run (and why):
//   - Browser / playwright smokes (e.g. rynth_router_smoke.cjs -> `require("playwright")`,
//     which is not installed): these are *_smoke.cjs, not *_test.cjs, so the glob never
//     picks them up. The known ones are listed in the SKIP table below for transparency.
//   - Live-infra tests (need the rynthnav sidecar / ACE / serve.py running): a *_test.cjs
//     file opts out by carrying a `// requires: <reason>` header comment. Such files are
//     discovered but skip-listed (with the reason) instead of run — they would fail on a
//     box without that service. Currently: rynth_arwic_coverage_test.cjs.
//
// Per-file stdout/stderr is suppressed unless the file FAILS, in which case the tail
// (~30 lines) is dumped so a failure is diagnosable without re-running by hand.
//
// Run:  node rynth_test_all_node.cjs
// Exit: 0 iff every discovered, non-skipped file exited 0.

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DIR = __dirname;
const TAIL_LINES = 30;
const PER_FILE_TIMEOUT_MS = 180_000; // generous; the slowest plain-node file is well under this

// Browser/playwright (or otherwise un-discoverable) files we deliberately do not run,
// surfaced in the SKIP table so the exclusion is visible rather than silent.
const KNOWN_SKIPS = [
  { file: "rynth_router_smoke.cjs", reason: "requires playwright (not installed) — browser smoke" },
];

// A discovered *_test.cjs opts out of running by declaring a `// requires:` header.
// Returns the reason text (everything after "requires:") or null if absent. Only the
// file head is scanned so a stray match deep in the body can't accidentally skip a test.
function requiresReason(file) {
  let head;
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.toString("utf8", 0, n);
  } catch {
    return null;
  }
  const m = head.match(/^\s*\/\/\s*requires:\s*(.+)$/im);
  return m ? m[1].trim() : null;
}

function discover() {
  return fs
    .readdirSync(DIR)
    .filter((f) => /^rynth_.*_test\.cjs$/.test(f))
    .sort();
}

function runOne(file) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [file], {
    cwd: DIR,
    timeout: PER_FILE_TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  let ok = res.status === 0 && !res.error;
  let note = "";
  if (res.error) note = res.error.code === "ETIMEDOUT" ? `timeout >${PER_FILE_TIMEOUT_MS}ms` : res.error.message;
  else if (res.status !== 0) note = `exit ${res.status}${res.signal ? ` (signal ${res.signal})` : ""}`;
  return { ok, ms, out, note };
}

function tail(text, n) {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

(function main() {
  const discovered = discover();
  const results = []; // { file, status: "PASS"|"FAIL"|"SKIP", ms, note }
  const failures = []; // { file, out }

  console.log(`rynth_test_all_node — ${discovered.length} discovered rynth_*_test.cjs in ${DIR}\n`);

  for (const file of discovered) {
    const reason = requiresReason(path.join(DIR, file));
    if (reason) {
      results.push({ file, status: "SKIP", ms: 0, note: reason });
      continue;
    }
    process.stdout.write(`  running ${file} ... `);
    const { ok, ms, out, note } = runOne(file);
    console.log(ok ? `ok (${ms}ms)` : `FAIL (${note})`);
    results.push({ file, status: ok ? "PASS" : "FAIL", ms, note: ok ? "" : note });
    if (!ok) failures.push({ file, out });
  }

  // Known non-discovered skips (browser/playwright) — listed for transparency, never run.
  for (const s of KNOWN_SKIPS) results.push({ file: s.file, status: "SKIP", ms: 0, note: s.reason });

  // Failure tails first (so they're not scrolled off by the table).
  for (const f of failures) {
    console.log(`\n──── FAIL: ${f.file} (last ${TAIL_LINES} lines) ────`);
    console.log(tail(f.out, TAIL_LINES));
    console.log("────────────────────────────────────────────────");
  }

  // Table.
  const w = Math.max(...results.map((r) => r.file.length), 4);
  console.log("\n" + "FILE".padEnd(w) + "  RESULT  DETAIL");
  console.log("-".repeat(w) + "  ------  ------");
  for (const r of results) {
    const detail = r.status === "PASS" ? `${r.ms}ms` : r.note;
    console.log(`${r.file.padEnd(w)}  ${r.status.padEnd(6)}  ${detail}`);
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  const totalMs = results.reduce((a, r) => a + r.ms, 0);
  console.log(`\nTOTAL: ${pass} passed, ${fail} failed, ${skip} skipped (${(totalMs / 1000).toFixed(1)}s)`);
  process.exit(fail > 0 ? 1 : 0);
})();
