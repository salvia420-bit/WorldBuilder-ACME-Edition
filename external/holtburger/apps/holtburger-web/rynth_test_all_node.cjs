#!/usr/bin/env node
// rynth_test_all_node.cjs — single runner for the plain-node rynth test suite.
//
// Discovers every `rynth_*_test.cjs` in this directory (that glob already covers
// rynth_navsim_test.cjs and the *_coverage_test.cjs files) and runs each as an
// isolated child `node <file>` process, collecting exit codes. Prints a per-file
// PASS/FAIL/SKIP table + totals and exits nonzero if any file failed.
//
// What is NOT run, and why — THE BAR (rynth-review 14 #1/#16, 17-SYNTHESIS
// #16, fixed 2026-07-23): every `rynth_*_smoke.cjs`/`rynth_*.cjs` file in this
// directory must show up in this command's own output, either run or as a
// named, reasoned SKIP row — nothing silently absent, even though this
// runner itself only ever executes plain-node `*_test.cjs` files:
//   - Browser / playwright smokes (`rynth_*_smoke.cjs`): these need a real
//     browser + ACE session (rynth_boot_helper.cjs's bootInWorld), so none
//     of them can run node-only. ALL of them (not just the ones playwright
//     itself would refuse) are rendered as a SKIP row below, each with its
//     OWN infra requirement pulled from rynth_test_all.cjs's exported
//     SMOKE_REQUIRES map (that runner — or `--full` on it — is where they
//     actually run). This closes the orphan gap: 9 of these used to be
//     referenced by NEITHER runner (incl. rynth_ai_smoke.cjs, SPEC.md's
//     named director verification bar, and rynth_bot_boot_smoke.cjs); all 9
//     are now in rynth_test_all.cjs's FAST/FULL/AI_INFRA lists AND named
//     here, so a smoke's existence is never invisible from either runner.
//   - Other `rynth_*.cjs` files matching neither `_test.cjs` nor `_smoke.cjs`
//     (manual live-soak / demo / verification tools — rynth_ai_livesoak.cjs,
//     rynth_guildmoot.cjs, rynth_fullmap_verify.cjs, rynth_portalcheck.cjs):
//     intentionally not part of any automated gate (they need a live LLM key,
//     multiple fresh ACE accounts, or a live sidecar bake to mean anything),
//     but still named here with a reason rather than left for a reader to
//     wonder whether they were forgotten.
//   - Live-infra `*_test.cjs` files (need the rynthnav sidecar / ACE /
//     serve.py running): opt out by carrying a `// requires: <reason>`
//     header comment. Discovered but skip-listed with the reason instead of
//     run. Currently: rynth_arwic_coverage_test.cjs.
//
// Per-file stdout/stderr is suppressed unless the file FAILS, in which case the tail
// (~30 lines) is dumped so a failure is diagnosable without re-running by hand.
//
// Run:  node rynth_test_all_node.cjs
// Exit: 0 iff every discovered, non-skipped file exited 0 (SKIP rows never affect the exit code).

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DIR = __dirname;
const TAIL_LINES = 30;
const PER_FILE_TIMEOUT_MS = 180_000; // generous; the slowest plain-node file is well under this

// Harness/runner files that are neither gated content nor a discoverable
// *_test.cjs — excluded from the "other rynth_*.cjs" accounting below so the
// SKIP table isn't cluttered with the very scripts producing it.
const HARNESS_FILES = new Set([
  "rynth_test_all.cjs",
  "rynth_test_all_node.cjs",
  "rynth_boot_helper.cjs",
]);

// Manual live-soak / demo / verification tools: `rynth_*.cjs` files that
// match neither `_test.cjs` nor `_smoke.cjs` and are deliberately NOT part of
// any automated gate (each needs something a CI box can't provide — a real
// LLM key, several fresh ACE accounts, or a live sidecar bake). Named here
// (with why) so "what exists vs. what runs" stays honest; if a NEW file like
// this appears without an entry, the generic fallback reason below still
// surfaces it rather than dropping it silently.
const OTHER_TOOL_REASONS = {
  rynth_ai_livesoak: "manual live soak vs. a REAL LLM (OPENROUTER_KEY) + live ACE — token-spend tool, not a gate test",
  rynth_guildmoot: "manual demo orchestrator — 4 fresh ACE accounts + a live LLM key, not a gate test",
  rynth_fullmap_verify: "manual sidecar full-map bake verifier — needs a live rynthnav sidecar serving the baked tile dir",
  rynth_portalcheck: "manual portals.tsv re-validator against live ACE worldgen — batch tool, not a gate test",
  rynth_netbrain_soak: "LONG-RUN (--minutes) live soak for netBrain default-on — needs ACE + serve.py + wsbridge + playwright + a built netbrain/AppBundle, not a gate test",
};
const DEFAULT_OTHER_REASON = "rynth_*.cjs matching neither _test.cjs nor _smoke.cjs — not a discovered gate test (see file header)";

// Pull the smoke lists + per-smoke infra requirements from rynth_test_all.cjs
// (single source of truth — see that file's header for the orphan-fold-in
// story) rather than hand-duplicating a skip list here that could itself
// drift out of sync with what actually exists on disk.
const { requiresFor } = require(path.join(DIR, "rynth_test_all.cjs"));

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

/** Every `rynth_*_smoke.cjs` at top level — all of them require a real
 * browser + live ACE session (bootInWorld), so none are ever run here; each
 * becomes a SKIP row with its specific infra requirement (see
 * rynth_test_all.cjs#requiresFor). */
function discoverSmokes() {
  return fs
    .readdirSync(DIR)
    .filter((f) => /^rynth_.*_smoke\.cjs$/.test(f))
    .sort();
}

/** `rynth_*.cjs` files that are neither a discovered `_test.cjs`, a
 * `_smoke.cjs`, nor this runner's own harness plumbing — manual soak/demo/
 * verification tools (see OTHER_TOOL_REASONS). Discovered generically (not
 * just the known 4) so a NEW file in this shape is still surfaced, never
 * silently absent, even before anyone documents a specific reason for it. */
function discoverOtherTools() {
  return fs
    .readdirSync(DIR)
    .filter((f) => /^rynth_.*\.cjs$/.test(f) && !/_test\.cjs$/.test(f) && !/_smoke\.cjs$/.test(f) && !HARNESS_FILES.has(f))
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
  const smokeFiles = discoverSmokes();
  const otherFiles = discoverOtherTools();
  const results = []; // { file, status: "PASS"|"FAIL"|"SKIP", ms, note }
  const failures = []; // { file, out }

  const totalRynthFiles = discovered.length + smokeFiles.length + otherFiles.length;
  console.log(
    `rynth_test_all_node — ${discovered.length} discovered rynth_*_test.cjs in ${DIR} ` +
      `(+ ${smokeFiles.length} rynth_*_smoke.cjs + ${otherFiles.length} other rynth_*.cjs tool(s), ` +
      `all accounted for below — ${totalRynthFiles} rynth_* files total)\n`
  );

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

  // Every *_smoke.cjs (browser+live-ACE only — see discoverSmokes' doc) and
  // every other non-test/non-smoke rynth_*.cjs tool, each a named SKIP row
  // with its own reason — THE BAR: nothing rynth_* is silently absent from
  // this command's output, whether or not it can ever run node-only.
  for (const file of discoverSmokes()) {
    results.push({ file, status: "SKIP", ms: 0, note: `browser smoke, needs ${requiresFor(file)}` });
  }
  for (const file of discoverOtherTools()) {
    const reason = OTHER_TOOL_REASONS[file.replace(/\.cjs$/, "")] || DEFAULT_OTHER_REASON;
    results.push({ file, status: "SKIP", ms: 0, note: reason });
  }

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
