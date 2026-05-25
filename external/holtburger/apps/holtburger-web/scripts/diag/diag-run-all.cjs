// Wire-agent diag-run-all aggregator (skeleton, 2026-05-25).
//
// Companion to the build-side `WorldBuilder.Terminal/Diagnostics/RunAll.cs`.
// Runs every registered wire-agent harness, captures exit codes, and
// prints a status matrix. Exits non-zero only on UNEXPECTED results
// (regression on a closed shortfall, OR unexpected closure of an open
// shortfall — flip `expectsPass` and re-run when the contract changes).
//
// V1 (this file): minimal — register a list of harnesses, run each
// in sequence, parse exit code, print matrix.
//
// V2 (future): structured JSON output, retry-on-flake budget,
// parallel runs where independent, HTML report, integration with
// build-side `RunAll.cs` for a unified report across all three
// diagnostic layers.
//
// Harness contract:
//   - exit 0 on PASS (`diff.ok === true`)
//   - exit 1 on FAIL (`diff.ok === false` — the documented gap)
//   - exit 2 on "couldn't reach the diff" (helper missing, oracle
//     unreadable, harness setup error)
//
// Adding a new harness:
//   - Drop a `run-diag-*.cjs` file in this dir
//   - Add an entry to HARNESSES below with the right `expectsPass`
//   - `expectsPass: false` documents an OPEN gap — failing is
//     consistent (DOC-GAP)
//   - When the gap closes, flip `expectsPass: true` and the same
//     test becomes a regression gate
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node scripts/diag/diag-run-all.cjs

const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");

const HARNESSES = [
  {
    name: "pvs-holtburg-cottage-outside",
    script: "run-diag-pvs-holtburg-cottage.cjs",
    surface: "__diag.pvs",
    methodDoc: "docs/cell-portal-method.md §Known scope gap",
    expectsPass: true,
    notes:
      "Validates the Phase 4 PView port (LandCell→EnvCell visibility bridge). " +
      "Player teleports to Holtburg, walks around outside; observed visible-cell " +
      "set should include at least one EnvCell because " +
      "getRenderSetWithFrustum iterates loaded EnvCell AABBs and keeps those " +
      "in the camera frustum. Pre-fix the count was always 0; post-fix it " +
      "depends on camera direction but must be > 0 when any cottage is in view.",
  },
  {
    name: "pvs-holtburg-cottage-inside",
    script: "run-diag-pvs-holtburg-cottage-inside.cjs",
    surface: "__diag.pvs",
    methodDoc: "docs/cell-portal-method.md §Known scope gap",
    expectsPass: true,
    notes:
      "Validates that inside a cottage, the observed visible set is a SUBSET " +
      "of the DAT-baked PVS (frustum-culled). Phase 3 (visible_cells in " +
      "cell_portal_graph) + Phase 4 (frustum cull) together: observedCount >= 1 " +
      "(current cell at minimum), extra == 0 (no over-render outside PVS).",
  },
  // Future:
  //   - clothing.cjs  → __diag.clothing
  //   - entity_lod.cjs → __diag.lod
  //   - dye_preview.cjs → __diag.clothing.dyePreview
];

const OUT_ROOT =
  process.env.HOLTBURGER_DIAG_OUT ||
  "/mnt/wbterminal1/tmp/claude-scratch/holtburger-diag-runs";

function runHarness(entry) {
  return new Promise((resolve) => {
    const start = Date.now();
    const scriptPath = path.join(__dirname, entry.script);
    const proc = spawn("node", [scriptPath], {
      cwd: path.resolve(__dirname, "..", ".."), // apps/holtburger-web/
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      resolve({
        name: entry.name,
        exitCode: code,
        elapsedMs: Date.now() - start,
        stdout,
        stderr,
        expectsPass: entry.expectsPass,
        passed: code === 0,
        surface: entry.surface,
        methodDoc: entry.methodDoc,
        notes: entry.notes,
      });
    });
  });
}

(async () => {
  const TS = new Date().toISOString().replace(/[:.]/g, "-");
  const OUT = path.join(OUT_ROOT, `diag-run-all-${TS}`);
  await mkdir(OUT, { recursive: true });

  console.log(`[diag-run-all] starting ${HARNESSES.length} harness(es)…\n`);

  const results = [];
  for (const entry of HARNESSES) {
    console.log(`▶ ${entry.name}`);
    const r = await runHarness(entry);
    console.log(`  exit=${r.exitCode} elapsed=${(r.elapsedMs / 1000).toFixed(1)}s expectsPass=${r.expectsPass}\n`);
    results.push(r);
    await writeFile(path.join(OUT, `${entry.name}.stdout.log`), r.stdout);
    if (r.stderr) await writeFile(path.join(OUT, `${entry.name}.stderr.log`), r.stderr);
  }

  const matrix = results.map((r) => ({
    name: r.name,
    surface: r.surface,
    methodDoc: r.methodDoc,
    exitCode: r.exitCode,
    expectsPass: r.expectsPass,
    actual: r.passed ? "PASS" : "FAIL",
    consistent: r.passed === r.expectsPass,
    elapsedMs: r.elapsedMs,
    notes: r.notes,
  }));
  await writeFile(path.join(OUT, "matrix.json"), JSON.stringify(matrix, null, 2));

  console.log("=".repeat(72));
  console.log("DIAG-RUN-ALL MATRIX");
  console.log("=".repeat(72));
  const w = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`${w("name", 32)} ${w("expects", 8)} ${w("actual", 7)} ${w("status", 12)}`);
  console.log("-".repeat(72));
  for (const m of matrix) {
    const status = m.consistent
      ? (m.actual === "PASS" ? "OK" : "DOC-GAP")
      : "UNEXPECTED";
    console.log(`${w(m.name, 32)} ${w(m.expectsPass ? "PASS" : "FAIL", 8)} ${w(m.actual, 7)} ${w(status, 12)}`);
  }
  console.log("-".repeat(72));
  const unexpected = matrix.filter((m) => !m.consistent);
  const documentedGaps = matrix.filter((m) => m.consistent && m.actual === "FAIL");
  const passes = matrix.filter((m) => m.consistent && m.actual === "PASS");
  console.log(`${passes.length} OK, ${documentedGaps.length} documented gap(s), ${unexpected.length} UNEXPECTED`);
  if (unexpected.length > 0) {
    console.log("\nUNEXPECTED — investigate:");
    for (const m of unexpected) {
      console.log(`  - ${m.name}: expected ${m.expectsPass ? "PASS" : "FAIL"}, got ${m.actual}`);
    }
  }
  console.log(`\nOUT=${OUT}`);

  process.exit(unexpected.length === 0 ? 0 : 1);
})();
