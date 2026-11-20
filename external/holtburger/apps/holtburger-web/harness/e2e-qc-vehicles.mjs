#!/usr/bin/env node
// harness/e2e-qc-vehicles.mjs — Opaque-box 4-tier E2E QC test runner for
// Semi Truck, Articulated Trailers, Sidelifter, ISO Containers, Pallet Jack,
// 9-Unit Deployables / MicroGrid / AirDefense Combat, Dericost Continent & Security.
//
// Usage:
//   node harness/e2e-qc-vehicles.mjs --tier 1|2|3|4|1,2,3|all --mode offline|live [options]

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { QcLiveSession, QcSuiteCollector } from "./e2e_qc/common.mjs";
import { TIER1_METADATA, runTier1 } from "./e2e_qc/tier1_features.mjs";
import { TIER2_METADATA, runTier2 } from "./e2e_qc/tier2_boundaries.mjs";
import { TIER3_METADATA, runTier3 } from "./e2e_qc/tier3_pairwise.mjs";
import { TIER4_METADATA, runTier4 } from "./e2e_qc/tier4_scenarios.mjs";

function printHelp() {
  console.log(`e2e-qc-vehicles.mjs — 4-Tier Opaque-Box E2E QC Suite (98 Checks, HBV1 v7)

Usage:
  node harness/e2e-qc-vehicles.mjs [options]

Options:
  --tier <1|2|3|4|1,2,3|all>  Tiers to select (default: all)
  --mode <offline|live>       Execution mode (default: offline)
  --strict                    Fail if any check resolves to PENDING
  --json                      Print JSON report to stdout
  --filter <substr>           Filter test ids/features by substring
  --driver-url <url>          Attach to ingame-driver.mjs control server
  --page-url <url>            Override client URL in self-managed live mode
  --out-dir <dir>             Output directory for screenshots / JSON report (default: /tmp/e2e-qc-live)
  --bail                      Stop after first FAIL
  --quiet                     Suppress per-test status lines
  --list                      List matching tests and exit 0
  --help, -h                  Print this help`);
}

function parseTiers(raw) {
  if (raw === undefined || raw === null) throw new Error("Missing value for --tier");
  const s = String(raw).trim().toLowerCase();
  if (s === "") throw new Error("Empty --tier specification");
  if (s === "all") return new Set([1, 2, 3, 4]);
  const out = new Set();
  for (const part of s.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") throw new Error(`Invalid --tier value "${raw}" (empty segment)`);
    const t = Number(trimmed);
    if (!Number.isInteger(t) || t < 1 || t > 4) {
      throw new Error(`Invalid --tier value "${part}" (expected 1|2|3|4|all or comma-separated)`);
    }
    out.add(t);
  }
  if (out.size === 0) throw new Error("Empty --tier specification");
  return out;
}

function requireValue(argv, idx, flag, allowEmpty = false) {
  if (idx >= argv.length) throw new Error(`Missing value for ${flag}`);
  const val = argv[idx];
  if (val.startsWith("-")) throw new Error(`Missing value for ${flag} (got flag "${val}")`);
  if (!allowEmpty && val.trim() === "") throw new Error(`Empty value for ${flag}`);
  return val;
}

function parseArgs(argv) {
  const opts = {
    tierRaw: "all",
    mode: "offline",
    strict: false,
    json: false,
    filter: "",
    driverUrl: null,
    pageUrl: null,
    outDir: "/tmp/e2e-qc-live",
    bail: false,
    quiet: false,
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--bail") opts.bail = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--tier") opts.tierRaw = requireValue(argv, ++i, "--tier");
    else if (a.startsWith("--tier=")) opts.tierRaw = a.slice(7);
    else if (a === "--mode") opts.mode = requireValue(argv, ++i, "--mode");
    else if (a.startsWith("--mode=")) opts.mode = a.slice(7);
    else if (a === "--filter") opts.filter = requireValue(argv, ++i, "--filter", true);
    else if (a.startsWith("--filter=")) opts.filter = a.slice(9);
    else if (a === "--driver-url") opts.driverUrl = requireValue(argv, ++i, "--driver-url");
    else if (a.startsWith("--driver-url=")) {
      const v = a.slice(13);
      if (v.trim() === "") throw new Error("Empty value for --driver-url");
      opts.driverUrl = v;
    } else if (a === "--page-url") opts.pageUrl = requireValue(argv, ++i, "--page-url");
    else if (a.startsWith("--page-url=")) {
      const v = a.slice(11);
      if (v.trim() === "") throw new Error("Empty value for --page-url");
      opts.pageUrl = v;
    } else if (a === "--out-dir") opts.outDir = requireValue(argv, ++i, "--out-dir");
    else if (a.startsWith("--out-dir=")) {
      const v = a.slice(10);
      if (v.trim() === "") throw new Error("Empty value for --out-dir");
      opts.outDir = v;
    } else throw new Error(`Unknown option: ${a}`);
  }
  if (opts.mode !== "offline" && opts.mode !== "live") {
    throw new Error(`Invalid --mode "${opts.mode}" (expected offline|live)`);
  }
  opts.tiers = parseTiers(opts.tierRaw);
  if (opts.mode === "live") {
    opts.strict = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const allMeta = [
    ...TIER1_METADATA,
    ...TIER2_METADATA,
    ...TIER3_METADATA,
    ...TIER4_METADATA,
  ].filter((m) => {
    if (!opts.tiers.has(m.tier)) return false;
    if (!opts.filter) return true;
    const f = opts.filter.toLowerCase();
    return m.id.toLowerCase().includes(f) || m.feature.toLowerCase().includes(f);
  });

  if (opts.list) {
    if (opts.json) {
      console.log(JSON.stringify({ total: allMeta.length, tests: allMeta }, null, 2));
    } else {
      for (const m of allMeta) {
        console.log(`T${m.tier}  ${m.id.padEnd(11)} [${m.mode.padEnd(7)}] ${m.feature}`);
      }
      console.log(`\nTotal listed: ${allMeta.length}`);
    }
    process.exit(0);
  }

  const suppressText = opts.json || opts.quiet;
  const origLog = console.log;
  const origWarn = console.warn;
  if (opts.json) {
    console.log = () => {};
    console.warn = () => {};
  }
  let liveSession = null;
  let liveFatalError = null;
  let consoleSummary = { failing: [], allowed: [] };

  if (opts.mode === "live") {
    liveSession = new QcLiveSession({
      driverUrl: opts.driverUrl,
      pageUrl: opts.pageUrl,
      outDir: opts.outDir,
    });
    try {
      await liveSession.connect();
    } catch (err) {
      liveFatalError = err?.message || String(err);
      await liveSession.close().catch(() => {});
      liveSession = null;
    }
  }

  const collector = new QcSuiteCollector({
    mode: opts.mode,
    strict: opts.strict,
    filter: opts.filter,
    bail: opts.bail,
    quiet: suppressText,
    liveSession,
    outDir: opts.outDir,
  });

  const tStart = Date.now();
  try {
    if (liveFatalError) {
      collector.results.push({
        id: "LIVE.BOOT",
        tier: 0,
        feature: "QcLiveSession:Connect",
        mode: "live",
        status: "FAIL",
        durationMs: 0,
        detail: liveFatalError,
      });
    } else {
      if (opts.tiers.has(1)) {
        if (!suppressText) console.log("\n=== Tier 1: Feature Coverage ===");
        await runTier1(collector);
      }
      if (opts.tiers.has(2) && !(opts.bail && collector.results.some((r) => r.status === "FAIL"))) {
        if (!suppressText) console.log("\n=== Tier 2: Boundary & Corner Cases ===");
        await runTier2(collector);
      }
      if (opts.tiers.has(3) && !(opts.bail && collector.results.some((r) => r.status === "FAIL"))) {
        if (!suppressText) console.log("\n=== Tier 3: Cross-Feature Pairwise ===");
        await runTier3(collector);
      }
      if (opts.tiers.has(4) && !(opts.bail && collector.results.some((r) => r.status === "FAIL"))) {
        if (!suppressText) console.log("\n=== Tier 4: Real-World Scenarios ===");
        await runTier4(collector);
      }
    }

    if (liveSession) {
      consoleSummary = await liveSession.checkConsoleErrors().catch((err) => ({
        failing: [err?.message || String(err)],
        allowed: [],
      }));
    }
  } finally {
    if (liveSession) {
      await liveSession.close().catch(() => {});
    }
  }

  const counts = {
    total: collector.results.length,
    PASS: collector.results.filter((r) => r.status === "PASS").length,
    FAIL: collector.results.filter((r) => r.status === "FAIL").length,
    PENDING: collector.results.filter((r) => r.status === "PENDING").length,
  };

  const consoleFailingCount = consoleSummary.failing.length;
  const ok =
    counts.FAIL === 0 &&
    consoleFailingCount === 0 &&
    (!(opts.strict || opts.mode === "live") || counts.PENDING === 0);

  const report = {
    suite: "e2e-qc-vehicles",
    mode: opts.mode,
    strict: opts.strict,
    tiers: [...opts.tiers].sort((a, b) => a - b),
    durationMs: Date.now() - tStart,
    ok,
    summary: counts,
    consoleErrors: consoleSummary,
    results: collector.results,
  };

  if (opts.outDir && opts.mode === "live") {
    try {
      mkdirSync(opts.outDir, { recursive: true });
      writeFileSync(path.join(opts.outDir, "e2e-qc-report.json"), JSON.stringify(report, null, 2));
    } catch (_) {}
  }

  if (opts.json) {
    console.log = origLog;
    console.warn = origWarn;
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `\nSummary (mode=${opts.mode}, strict=${opts.strict}): ` +
        `PASS=${counts.PASS} FAIL=${counts.FAIL} PENDING=${counts.PENDING} TOTAL=${counts.total} (${report.durationMs} ms)`
    );
    if (consoleFailingCount > 0) {
      console.log(`Console/Page Errors (non-allowlisted): ${consoleFailingCount}`);
      for (const e of consoleSummary.failing.slice(0, 10)) console.log(`  [FAIL] console: ${e}`);
    }
  }

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
