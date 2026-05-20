#!/usr/bin/env node
// run-all-validators.cjs — Wave 5.C top-level orchestrator.
//
// **What this tool does:** invokes every `validate_*.cjs` validator currently
// in tree, aggregates each one's `report.json` into a single top-level
// envelope, and emits the aggregate to
// `/mnt/wbterminal1/holtburger-validator-reports/diag-run-all/<ts>/`.
//
// **Why this exists:** Wave 5.C of the retail-correctness diagnostic toolset
// plan at `docs/diagnostic-toolset-plan-2026-05-19.md` §6. The plan calls
// for a single entry point that runs the per-surface validators shipped in
// Waves 1-3 + W5.A + W5.B and emits a CI-style rollup. Operators run this
// before declaring "the build is retail-correct" — without it, each
// validator has to be invoked by hand and the operator has to glue the
// 9-11 individual reports together.
//
// **Architecture decisions** (per plan §6 W5.C row):
//   - `--wave4-mode=fast|full` default `fast`. Wave 4 (texture/mesh whole-
//      DAT sweep) has not shipped yet; `fast` mode falls through to a
//      documented SKIP for those rows. `full` is the multi-hour out-of-
//      band sweep meant for a scheduled job. The flag is propagated
//      forward; today both modes SKIP Wave 4 since it has not shipped.
//   - Sequential execution by default (one validator at a time) so the
//     per-surface logs are intelligible. `--parallel` flips to Promise.all.
//   - `--skip=<surface>` repeatable; skips a validator outright.
//   - Validator `report.json` is read by surface→latest-mtime convention.
//     Three validators don't follow the §4.4 envelope (landblock-
//     completeness writes `completeness-report.json` in scenery-bake dir;
//     event-completeness writes `event-completeness-report.json` in
//     event-completeness dir; entity-classification just prints to
//     stdout). For those, we record exit-code-driven status only.
//
// **Exit codes:**
//   - 0 : all required surfaces PASS (skipped + not-yet-shipped are not
//         failures)
//   - 1 : any required surface FAIL (real drift surfaced)
//   - 2 : infra error (driver itself broke; partial aggregate written)
//
// **Run:**
//   node run-all-validators.cjs
//   node run-all-validators.cjs --wave4-mode=full
//   node run-all-validators.cjs --skip=physics-replay --skip=cell-portal-graph
//   node run-all-validators.cjs --report-dir=/tmp/custom/
//   node run-all-validators.cjs --parallel
//
// **See also:**
//   - Plan: docs/diagnostic-toolset-plan-2026-05-19.md §6 Wave 5.C
//   - Method: docs/diagnostic-toolset-method.md (umbrella over the 9-11
//     surface-specific *-method.md docs)
//   - C# wrapper: WorldBuilder.Terminal/Diagnostics/RunAll.cs

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

// ─── Constants ──────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const HOLTBURGER_WEB = __dirname;
const SHARED_REPORTS_ROOT = "/mnt/wbterminal1/holtburger-validator-reports";

// Per-surface validator inventory. Each entry:
//   surface       — canonical surface slug; matches the report-dir name where
//                   applicable
//   script        — file name in this dir
//   args          — extra CLI args appended to `node <script>`
//   required      — if true, FAIL contributes to non-zero exit code
//                   (false rows can SKIP-not-yet-shipped without failing)
//   reportPath    — function returning the expected report.json path. If
//                   the validator does NOT follow the §4.4 envelope, return
//                   null and we'll fall back to exit-code-driven status.
//   timeoutMs     — driver kills the child after this many ms
//
// **Reading the rows:**
//   landblock / event / entity-class don't write to the shared reports
//   tree — those three rows record `legacyReportPath` for the operator.
//   The other 7 rows read from
//   /mnt/wbterminal1/holtburger-validator-reports/<surface>/<latest-mtime>/report.json.
//
const VALIDATORS = [
  {
    surface: "placements",
    script: "validate_landblock_completeness.cjs",
    args: [],
    required: true,
    timeoutMs: 600_000,
    legacyReportPath: "/mnt/wbterminal1/tmp/claude-scratch/scenery-bake/e/completeness-report.json",
    notes: "Phase E. Needs live renderer + 169 LB ring; can take ~5 min.",
  },
  {
    surface: "events",
    script: "validate_event_completeness.cjs",
    args: [],
    required: true,
    timeoutMs: 300_000,
    legacyReportPath: "/mnt/wbterminal1/tmp/claude-scratch/event-completeness/d/event-completeness-report.json",
    notes: "Phase F.D. Drives the H2/H3 sound + particle probe.",
  },
  {
    surface: "entity-class",
    script: "validate_entity_classification.cjs",
    args: [],
    required: true,
    timeoutMs: 60_000,
    legacyReportPath: null,
    notes: "Phase E.D. Pure-function regression; no report.json (stdout only).",
  },
  {
    surface: "wire-conformance",
    script: "validate_wire_conformance.cjs",
    args: [],
    required: true,
    timeoutMs: 120_000,
    reportRoot: path.join(SHARED_REPORTS_ROOT, "wire-conformance"),
    notes: "Wave 1. 23 fixtures across ACProtocol pack/unpack.",
  },
  {
    surface: "dat-parity",
    script: "validate_dat_parity.cjs",
    args: ["--phase=both"],
    required: true,
    timeoutMs: 900_000,
    reportRoot: path.join(SHARED_REPORTS_ROOT, "dat-parity"),
    notes: "Wave 2.A+B+D. 24 DAT types; Phase B requires cargo example.",
  },
  {
    surface: "enum-parity",
    script: "validate_enum_parity.cjs",
    args: [],
    required: true,
    timeoutMs: 60_000,
    reportRoot: path.join(SHARED_REPORTS_ROOT, "enum-parity"),
    notes: "Wave 2.C. 66-enum allowlist diffed against Rust crates.",
  },
  {
    surface: "motion-pose",
    script: "validate_motion_pose.cjs",
    args: ["--js-vs-cs"],
    required: true,
    timeoutMs: 300_000,
    reportRoot: path.join(SHARED_REPORTS_ROOT, "motion-pose"),
    notes: "Wave 3.C+E. Swing classifier; --js-vs-cs adds the JS path.",
  },
  {
    surface: "physics-replay",
    script: "validate_physics_replay.cjs",
    args: ["--subject=prediction"],
    required: true,
    timeoutMs: 600_000,
    reportRoot: path.join(SHARED_REPORTS_ROOT, "physics-replay"),
    notes: "Wave 3.A+F. Live-ACE pure-prediction shadow; needs ACE up.",
  },
  {
    surface: "cell-portal-graph",
    script: "validate_cell_portal_graph.cjs",
    args: [],
    required: false, // Sibling W5.A; may not exist yet at run time
    timeoutMs: 300_000,
    // W5.A writes to .../cell-portal/<ts>/report.json (not cell-portal-graph)
    reportRoot: path.join(SHARED_REPORTS_ROOT, "cell-portal"),
    notes: "Wave 5.A. SKIP-not-yet-shipped if validator absent.",
  },
  {
    surface: "skybox-parity",
    script: "validate_skybox.cjs",
    args: [],
    required: false, // Sibling W5.B; may not exist yet at run time
    timeoutMs: 300_000,
    // W5.B writes to .../skybox/<ts>/report.json (not skybox-parity)
    reportRoot: path.join(SHARED_REPORTS_ROOT, "skybox"),
    notes: "Wave 5.B. SKIP-not-yet-shipped if validator absent.",
  },
];

// ─── CLI parsing ────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const out = {
    wave4Mode: "fast",
    reportDir: null,
    parallel: false,
    skipSurfaces: new Set(),
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a.startsWith("--wave4-mode=")) {
      const v = a.slice("--wave4-mode=".length);
      if (v !== "fast" && v !== "full") {
        console.error(`FAIL: --wave4-mode expects fast|full; got '${v}'`);
        process.exit(2);
      }
      out.wave4Mode = v;
    } else if (a.startsWith("--report-dir=")) {
      out.reportDir = a.slice("--report-dir=".length);
    } else if (a === "--parallel") {
      out.parallel = true;
    } else if (a.startsWith("--skip=")) {
      out.skipSurfaces.add(a.slice("--skip=".length));
    } else {
      console.error(`FAIL: unknown argument '${a}'`);
      process.exit(2);
    }
  }
  return out;
}

function printUsage() {
  console.log(`run-all-validators.cjs — Wave 5.C top-level diagnostic orchestrator`);
  console.log(``);
  console.log(`Usage:  node run-all-validators.cjs [options]`);
  console.log(``);
  console.log(`Options:`);
  console.log(`  --wave4-mode=fast|full     Wave 4 sweep mode (default: fast)`);
  console.log(`                             fast = 81-model Holtburg subset (sub-sec)`);
  console.log(`                             full = whole-DAT sweep (multi-hour)`);
  console.log(`                             (Wave 4 not yet shipped; both modes SKIP for now)`);
  console.log(`  --report-dir=PATH          Override aggregate output dir`);
  console.log(`                             default: /mnt/wbterminal1/holtburger-validator-reports/diag-run-all/<ts>/`);
  console.log(`  --parallel                 Run validators in parallel (default: sequential)`);
  console.log(`  --skip=<surface>           Skip a validator by surface name (repeatable)`);
  console.log(`  --help / -h                Show this message`);
  console.log(``);
  console.log(`Surfaces:`);
  for (const v of VALIDATORS) {
    const tag = v.required ? "req" : "opt";
    console.log(`  - ${v.surface.padEnd(20)} (${tag})  ${v.notes}`);
  }
  console.log(``);
  console.log(`Exit codes: 0 = all required PASS, 1 = any FAIL, 2 = infra`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isoSlug(d = new Date()) {
  return d.toISOString().replace(/\.[0-9]{3}Z$/, "Z").replace(/:/g, "-");
}

function mkdirpSync(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Find the most-recently-modified subdir under `reportRoot` and return the
 * path to its `report.json`. Returns null if no subdir exists.
 *
 * The convention (per validators' impl): each run creates a fresh
 * `<ISO-ts>/` directory and writes `report.json` inside. Time-ordering
 * via mtime works since the dirs sort by name too — but mtime is robust
 * against clock skew on multi-host setups.
 */
async function findLatestReport(reportRoot) {
  if (!fs.existsSync(reportRoot)) return null;
  let entries;
  try {
    entries = await readdir(reportRoot, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 0) return null;
  let best = null;
  let bestMtime = -Infinity;
  for (const d of dirs) {
    const candidate = path.join(reportRoot, d.name, "report.json");
    if (!fs.existsSync(candidate)) continue;
    try {
      const st = await stat(candidate);
      if (st.mtimeMs > bestMtime) {
        best = candidate;
        bestMtime = st.mtimeMs;
      }
    } catch (_) {
      // ignore
    }
  }
  return best;
}

/**
 * Run a single validator and return a structured result.
 *
 * **Why we capture exit code first, then read report.json:**
 *   - the validator IS the source of truth for PASS/FAIL — its exit code
 *     is the authoritative signal. We use the report.json only for
 *     additional structured detail (mismatch count, surface metadata).
 *   - if the report.json is malformed, we still record a result row with
 *     `infraError` set + the exit code.
 *
 * **Timeout handling:** SIGKILL after `timeoutMs`; result row records
 * `timedOut: true` so the operator can extend the timeout if needed.
 */
async function runValidator(v, logDir) {
  const scriptPath = path.join(HOLTBURGER_WEB, v.script);
  const surface = v.surface;
  const startedAt = new Date();
  const logPath = path.join(logDir, `${surface}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "w" });

  // Surface-not-yet-shipped: validator script doesn't exist on disk.
  // This is the W5.A/W5.B skip path — the script will appear once those
  // waves ship; until then we record a SKIP row.
  if (!fs.existsSync(scriptPath)) {
    logStream.write(
      `[skip] ${surface}: validator script not found at ${scriptPath}\n` +
      `       This wave hasn't shipped yet; recording SKIP and continuing.\n`,
    );
    logStream.end();
    return {
      surface,
      status: v.required ? "INFRA" : "SKIP_NOT_SHIPPED",
      exitCode: null,
      reportJsonPath: null,
      durationMs: 0,
      timedOut: false,
      mismatchCount: null,
      notes: v.notes,
      script: v.script,
      args: v.args,
      logPath,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      summary: null,
      infraError: null,
    };
  }

  // The validator's process. Stream stdout + stderr to the per-surface
  // log; also tee to a buffer so the driver console can show a tail on
  // failure.
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [scriptPath, ...v.args],
      {
        cwd: HOLTBURGER_WEB,
        env: {
          ...process.env,
          // Inherits NODE_PATH from the parent — validators reach into
          // /home/wbterminal/.npm/_npx/.../node_modules for playwright.
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const TAIL_LINES = 30;

    function appendTail(buf, chunk) {
      const lines = (buf.tail += chunk).split("\n");
      // keep only the last TAIL_LINES + the partial line
      if (lines.length > TAIL_LINES + 1) {
        buf.tail = lines.slice(-(TAIL_LINES + 1)).join("\n");
      }
    }

    const stdoutBuf = { tail: "" };
    const stderrBuf = { tail: "" };

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      logStream.write(s);
      appendTail(stdoutBuf, s);
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      logStream.write(`[stderr] ${s}`);
      appendTail(stderrBuf, s);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (_) {
        // ignore
      }
    }, v.timeoutMs);

    child.on("error", async (err) => {
      clearTimeout(timer);
      logStream.write(`[error] spawn error: ${err.message}\n`);
      logStream.end();
      resolve({
        surface,
        status: "INFRA",
        exitCode: null,
        reportJsonPath: null,
        durationMs: Date.now() - startedAt.getTime(),
        timedOut: false,
        mismatchCount: null,
        notes: v.notes,
        script: v.script,
        args: v.args,
        logPath,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        summary: null,
        infraError: `spawn error: ${err.message}`,
      });
    });

    child.on("exit", async (code) => {
      clearTimeout(timer);
      logStream.end();
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      // Find this surface's latest report.json (per §4.4 envelope shape).
      let reportJsonPath = null;
      let summary = null;
      let mismatchCount = null;
      let parseError = null;
      if (v.reportRoot) {
        try {
          reportJsonPath = await findLatestReport(v.reportRoot);
        } catch (e) {
          parseError = `findLatestReport: ${e.message}`;
        }
        if (reportJsonPath) {
          try {
            const raw = fs.readFileSync(reportJsonPath, "utf8");
            const obj = JSON.parse(raw);
            summary = obj.summary || obj.phaseA?.summary || null;
            if (summary) {
              mismatchCount = (summary.fail ?? 0) +
                (Array.isArray(obj.mismatches) ? obj.mismatches.length : 0);
            }
          } catch (e) {
            parseError = `report.json parse: ${e.message}`;
          }
        }
      } else if (v.legacyReportPath && fs.existsSync(v.legacyReportPath)) {
        // landblock + event use legacy paths; record presence but don't
        // parse — they don't follow the §4.4 envelope.
        reportJsonPath = v.legacyReportPath;
      }

      // Classification:
      //   exit 0  → PASS (regardless of report parseability)
      //   exit 1  → FAIL
      //   exit 2+ → INFRA
      //   timeout → INFRA (timedOut: true)
      //   null    → INFRA (signal)
      let status;
      if (timedOut) {
        status = "INFRA";
      } else if (code === 0) {
        status = "PASS";
      } else if (code === 1) {
        status = "FAIL";
      } else {
        status = "INFRA";
      }

      resolve({
        surface,
        status,
        exitCode: code,
        reportJsonPath,
        durationMs,
        timedOut,
        mismatchCount,
        notes: v.notes,
        script: v.script,
        args: v.args,
        logPath,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        summary,
        infraError: parseError,
        stdoutTail: stdoutBuf.tail,
        stderrTail: stderrBuf.tail,
      });
    });
  });
}

// ─── Aggregate + summary emit ───────────────────────────────────────────────

function aggregateOf(perSurface, opts, startedAt, finishedAt) {
  const checked = perSurface.length;
  const passed = perSurface.filter((r) => r.status === "PASS").length;
  const failed = perSurface.filter((r) => r.status === "FAIL").length;
  const skippedShip = perSurface.filter((r) => r.status === "SKIP_NOT_SHIPPED").length;
  const skippedCli = perSurface.filter((r) => r.status === "SKIP_CLI").length;
  const skipped = skippedShip + skippedCli;
  const infra = perSurface.filter((r) => r.status === "INFRA").length;
  const requiredFailures = perSurface.filter((r) => {
    const v = VALIDATORS.find((x) => x.surface === r.surface);
    return v && v.required && (r.status === "FAIL" || r.status === "INFRA");
  }).length;
  return {
    surface: "diag-run-all",
    oracle: {
      kind: "wb-terminal-diag-run-all",
      method: "diagnostic-toolset-method.md",
      via: "run-all-validators.cjs",
    },
    subject: {
      kind: "holtburger-web + wb-terminal",
      cwd: HOLTBURGER_WEB,
      repo: REPO_ROOT,
    },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs: finishedAt.getTime() - startedAt.getTime(),
    options: opts,
    summary: {
      checked,
      pass: passed,
      fail: failed,
      skipped,
      skippedShip,
      skippedCli,
      infra,
      requiredFailures,
    },
    surfaces: perSurface,
  };
}

function renderMarkdown(agg) {
  const lines = [];
  const s = agg.summary;
  lines.push(`# diag-run-all aggregate — ${agg.startedAt}`);
  lines.push(``);
  lines.push(`**Wave 5.C** capstone of the retail-correctness diagnostic toolset.`);
  lines.push(`Plan: [docs/diagnostic-toolset-plan-2026-05-19.md](../../diagnostic-toolset-plan-2026-05-19.md) §6 W5.C.`);
  lines.push(`Method: [docs/diagnostic-toolset-method.md](../../diagnostic-toolset-method.md).`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| Status | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| Checked | ${s.checked} |`);
  lines.push(`| PASS | ${s.pass} |`);
  lines.push(`| FAIL | ${s.fail} |`);
  lines.push(`| SKIP (not yet shipped) | ${s.skippedShip} |`);
  lines.push(`| SKIP (cli flag) | ${s.skippedCli} |`);
  lines.push(`| INFRA | ${s.infra} |`);
  lines.push(``);
  lines.push(`Required failures: **${s.requiredFailures}** (gate non-zero exit)`);
  lines.push(``);
  lines.push(`Wave 4 mode: \`${agg.options.wave4Mode}\` (not yet shipped — both modes SKIP)`);
  lines.push(`Elapsed: ${(agg.elapsedMs / 1000).toFixed(2)}s`);
  lines.push(``);
  lines.push(`## Per-surface results`);
  lines.push(``);
  lines.push(`| Surface | Status | Exit | Duration | Mismatches | Notes |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const r of agg.surfaces) {
    const dur = (r.durationMs / 1000).toFixed(2) + "s";
    const exitStr = r.exitCode === null ? "—" : String(r.exitCode);
    const mm = r.mismatchCount === null ? "—" : String(r.mismatchCount);
    let badge;
    switch (r.status) {
      case "PASS": badge = "PASS"; break;
      case "FAIL": badge = "**FAIL**"; break;
      case "SKIP_NOT_SHIPPED": badge = "SKIP (not shipped)"; break;
      case "SKIP_CLI": badge = "SKIP (cli)"; break;
      case "INFRA": badge = "**INFRA**"; break;
      default: badge = r.status;
    }
    lines.push(`| \`${r.surface}\` | ${badge} | ${exitStr} | ${dur} | ${mm} | ${r.notes ?? ""} |`);
  }
  lines.push(``);
  lines.push(`## Reports`);
  lines.push(``);
  for (const r of agg.surfaces) {
    if (r.reportJsonPath) {
      lines.push(`- \`${r.surface}\`: ${r.reportJsonPath}`);
    } else if (r.status === "SKIP_CLI") {
      lines.push(`- \`${r.surface}\`: skipped via --skip CLI flag`);
    } else if (r.status === "SKIP_NOT_SHIPPED") {
      lines.push(`- \`${r.surface}\`: not yet shipped — script absent (\`${r.script}\`)`);
    } else if (r.logPath) {
      lines.push(`- \`${r.surface}\`: no report.json (see ${r.logPath})`);
    } else {
      lines.push(`- \`${r.surface}\`: no report and no log`);
    }
  }
  lines.push(``);
  if (s.requiredFailures > 0 || s.fail > 0) {
    lines.push(`## Failure detail`);
    lines.push(``);
    for (const r of agg.surfaces) {
      if (r.status !== "FAIL" && r.status !== "INFRA") continue;
      const v = VALIDATORS.find((x) => x.surface === r.surface);
      const reqTag = v && v.required ? "**REQUIRED**" : "optional";
      lines.push(`### ${r.surface} — ${r.status} (${reqTag})`);
      lines.push(``);
      if (r.infraError) {
        lines.push(`Infra: ${r.infraError}`);
        lines.push(``);
      }
      if (r.stderrTail) {
        lines.push(`stderr tail:`);
        lines.push("```");
        lines.push(r.stderrTail.slice(-1500));
        lines.push("```");
      }
      if (r.stdoutTail) {
        lines.push(`stdout tail:`);
        lines.push("```");
        lines.push(r.stdoutTail.slice(-1500));
        lines.push("```");
      }
    }
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`*Generated by run-all-validators.cjs — diag-run-all subprocess driver.*`);
  return lines.join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const cli = parseCliArgs(process.argv);
  if (cli.help) {
    printUsage();
    process.exit(0);
  }

  const startedAt = new Date();
  const ts = isoSlug(startedAt);
  const outDir = cli.reportDir
    || path.join(SHARED_REPORTS_ROOT, "diag-run-all", ts);
  mkdirpSync(outDir);
  const logDir = path.join(outDir, "logs");
  mkdirpSync(logDir);

  console.log(`run-all-validators — Wave 5.C aggregate`);
  console.log(`========================================`);
  console.log(`Started:    ${startedAt.toISOString()}`);
  console.log(`Report dir: ${outDir}`);
  console.log(`Mode:       wave4=${cli.wave4Mode}  parallel=${cli.parallel}`);
  if (cli.skipSurfaces.size > 0) {
    console.log(`Skipping:   ${[...cli.skipSurfaces].join(", ")}`);
  }
  console.log(``);

  // Filter the validator list per --skip.
  // (Wave-4 surfaces aren't in the VALIDATORS list yet — when they ship,
  //  we'll add them with `args: ["--mode=<cli.wave4Mode>"]`.)
  const todo = VALIDATORS.filter((v) => !cli.skipSurfaces.has(v.surface));
  const skipped = VALIDATORS.filter((v) => cli.skipSurfaces.has(v.surface));

  for (const v of skipped) {
    console.log(`[skip-cli] ${v.surface} (${v.script})`);
  }

  // Execute.
  let perSurface;
  if (cli.parallel) {
    perSurface = await Promise.all(todo.map((v) => runValidator(v, logDir)));
  } else {
    perSurface = [];
    for (const v of todo) {
      const t0 = Date.now();
      console.log(`\n[run] ${v.surface}  (${v.script} ${v.args.join(" ")})`);
      const row = await runValidator(v, logDir);
      const tag = row.status === "PASS" ? "PASS" :
                  row.status === "FAIL" ? "FAIL" :
                  row.status === "SKIP_NOT_SHIPPED" ? "SKIP (not yet shipped)" :
                  row.status === "SKIP_CLI" ? "SKIP (cli)" :
                  `INFRA${row.timedOut ? " (TIMEOUT)" : ""}`;
      const dur = ((Date.now() - t0) / 1000).toFixed(1) + "s";
      console.log(`   → ${tag}  (${dur})`);
      if (row.reportJsonPath) console.log(`      report: ${row.reportJsonPath}`);
      if (row.infraError) console.log(`      infra:  ${row.infraError}`);
      perSurface.push(row);
    }
  }

  // Synthesize CLI-skipped rows so the aggregate inventory is complete.
  // Use SKIP_CLI to disambiguate operator-driven --skip from the
  // SKIP_NOT_SHIPPED case (Wave 4 / sibling validator missing).
  for (const v of skipped) {
    perSurface.push({
      surface: v.surface,
      status: "SKIP_CLI",
      exitCode: null,
      reportJsonPath: null,
      durationMs: 0,
      timedOut: false,
      mismatchCount: null,
      notes: `${v.notes} (skipped via --skip)`,
      script: v.script,
      args: v.args,
      logPath: null,
      startedAt: null,
      finishedAt: null,
      summary: null,
      infraError: null,
    });
  }

  // Re-order to match the canonical VALIDATORS order.
  perSurface.sort((a, b) => {
    const ia = VALIDATORS.findIndex((x) => x.surface === a.surface);
    const ib = VALIDATORS.findIndex((x) => x.surface === b.surface);
    return ia - ib;
  });

  const finishedAt = new Date();
  const aggregate = aggregateOf(perSurface, {
    wave4Mode: cli.wave4Mode,
    parallel: cli.parallel,
    reportDir: outDir,
    skip: [...cli.skipSurfaces],
  }, startedAt, finishedAt);

  const aggregateJsonPath = path.join(outDir, "aggregate.json");
  const summaryMdPath = path.join(outDir, "summary.md");
  fs.writeFileSync(aggregateJsonPath, JSON.stringify(aggregate, null, 2));
  fs.writeFileSync(summaryMdPath, renderMarkdown(aggregate));

  // Console rollup.
  const s = aggregate.summary;
  console.log(``);
  console.log(`Aggregate written:`);
  console.log(`  ${aggregateJsonPath}`);
  console.log(`  ${summaryMdPath}`);
  console.log(``);
  console.log(`Summary:`);
  console.log(`  Checked:        ${s.checked}`);
  console.log(`  PASS:           ${s.pass}`);
  console.log(`  FAIL:           ${s.fail}`);
  console.log(`  SKIP (not yet shipped): ${s.skippedShip}`);
  console.log(`  SKIP (cli):     ${s.skippedCli}`);
  console.log(`  INFRA:          ${s.infra}`);
  console.log(`  Required failures: ${s.requiredFailures}`);
  console.log(``);

  if (s.requiredFailures > 0) {
    console.log(`RESULT: FAIL (${s.requiredFailures} required surface(s) did not PASS)`);
    process.exit(1);
  }
  if (s.fail > 0) {
    // Non-required FAIL: don't fail the gate, but surface it.
    console.log(`RESULT: PASS (${s.fail} optional surface FAIL'd; ${s.pass} required PASS)`);
    process.exit(0);
  }
  if (s.pass === 0 && s.skipped === s.checked) {
    console.log(`RESULT: SKIP (all surfaces skipped)`);
    process.exit(0);
  }
  console.log(`RESULT: PASS (${s.pass} of ${s.checked} surfaces verified)`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`run-all-validators top-level error: ${err.message}`);
  console.error(err.stack);
  process.exit(2);
});
