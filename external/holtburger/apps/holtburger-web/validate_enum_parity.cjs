// Wave 2.C — Cross-port enum parity validator.
//
// **What this tool does:** drives WorldBuilder.Terminal's
// `enum-parity-report` command, captures the structured report, and emits a
// per-run JSON artifact under
// `/mnt/wbterminal1/holtburger-validator-reports/enum-parity/<ISO-ts>/`.
//
// **Contract:** for every Chorizite enum we curate, every variant should
// have a same-name same-value counterpart on the Rust side. Drift surfaces
// as a "fail" row. Cases where a Chorizite enum has no Rust counterpart
// (e.g. flags enums Chorizite ships as `enum [Flags]` but Rust ships as
// `bitflags!` structs) are MISSING-RUST / "gap" rows and DO NOT fail the
// validator — they're diagnostic.
//
// **Exit codes:**
//   - 0 : all enums PASS (no FAIL rows; GAP rows are non-blocking)
//   - 1 : at least one FAIL row (true parity drift)
//   - 2 : infra error (WB.Terminal subprocess crashed; JSON parse failed)
//
// **Run:**  `node validate_enum_parity.cjs`
//
// **Layout:**
//   - Subprocess: `$DOTNET_ROOT/dotnet ../../../../WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin`
//   - Report dir: `/mnt/wbterminal1/holtburger-validator-reports/enum-parity/<ts>/report.json`
//   - NODE_PATH:  `/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules`
//     (matches capture-script convention per reference_external_drive_layout)
//
// **Why subprocess instead of pure-function (the entity-classification path):**
// the C# side has the Chorizite assembly loaded already + the Rust source
// files on disk. Re-implementing the dump + diff in Node would mean
// duplicating the reflection logic and the Rust-enum regex parser. Cheaper to
// drive the C# command and let it produce the canonical JSON.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const mkdir = promisify(fs.mkdir);

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
  : "dotnet";

const REPORT_ROOT = "/mnt/wbterminal1/holtburger-validator-reports/enum-parity";

function isoSlug(date = new Date()) {
  return date
    .toISOString()
    .replace(/\.[0-9]{3}Z$/, "Z")
    .replace(/:/g, "-");
}

function ensureWbtDll() {
  if (!fs.existsSync(WBT_DLL)) {
    throw new Error(
      `WorldBuilder.Terminal.dll not found at ${WBT_DLL}\n` +
        `Build it first:  dotnet build WorldBuilder.Terminal -c Release`
    );
  }
}

/**
 * Drive WB.Terminal stdin loop. Sends one command; collects all JSON lines
 * emitted until the subprocess exits or the response for the command shows
 * up. Returns the parsed JSON object.
 */
function runWbtCommand(commandObj, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOTNET, [WBT_DLL, "--stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    let resolved = false;
    const expectedCmd = commandObj.command;
    const settled = (handler) => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch (_) {}
      handler();
    };
    const timer = setTimeout(() => {
      settled(() =>
        reject(
          new Error(
            `WB.Terminal subprocess timeout after ${timeoutMs}ms\nstderr: ${stderrBuf}\nstdout: ${stdoutBuf}`
          )
        )
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        if (obj.command === expectedCmd) {
          // The dispatch is wired AND the command produced a response.
          // If success=false, surface it as an infra error (e.g. the
          // splice from WAVE2C_DISPATCH_PENDING.patch hasn't landed yet,
          // so WB.Terminal reports "Unknown command").
          if (obj.success === false) {
            clearTimeout(timer);
            settled(() =>
              reject(
                new Error(
                  `WB.Terminal reported failure on "${expectedCmd}": ${obj.error ?? JSON.stringify(obj)}\n` +
                    `If the message is "Unknown command", the WAVE2C_DISPATCH_PENDING.patch ` +
                    `splice hasn't been applied to JsonCommandProcessor.cs yet.`
                )
              )
            );
            return;
          }
          clearTimeout(timer);
          settled(() => resolve(obj));
          return;
        }
        // Look for the error-shape response which contains no command field
        // when ProcessCommand fails outright.
        if (obj.success === false && (obj.error || obj.command === "unknown")) {
          clearTimeout(timer);
          settled(() =>
            reject(new Error(`WB.Terminal returned error: ${JSON.stringify(obj)}`))
          );
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      settled(() => reject(err));
    });
    child.on("exit", (code) => {
      if (resolved) return;
      clearTimeout(timer);
      settled(() =>
        reject(
          new Error(
            `WB.Terminal subprocess exited (code=${code}) without emitting "${expectedCmd}" response.\nstderr: ${stderrBuf}\nstdout buffered: ${stdoutBuf}`
          )
        )
      );
    });
    child.stdin.write(JSON.stringify(commandObj) + "\n");
    // Don't close stdin yet — let the subprocess emit its response, then we kill on settle.
  });
}

async function main() {
  // ── Step 0: pre-flight ──────────────────────────────────────────────────
  try {
    ensureWbtDll();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  const startedAt = new Date();
  const reportDir = path.join(REPORT_ROOT, isoSlug(startedAt));
  await mkdir(reportDir, { recursive: true });

  console.log("validate_enum_parity — Wave 2.C");
  console.log("==============================");
  console.log(`Started:   ${startedAt.toISOString()}`);
  console.log(`Report:    ${reportDir}/report.json`);
  console.log("");

  // ── Step 1: ask WB.Terminal for the parity report ───────────────────────
  let parityReport;
  try {
    parityReport = await runWbtCommand({ command: "enum-parity-report" });
  } catch (e) {
    console.error("INFRA ERROR — could not run enum-parity-report:");
    console.error(e.message);
    // Emit a minimal failure-mode artifact so CI can still inspect the dir.
    const inf = {
      surface: "enum-parity",
      summary: { checked: 0, pass: 0, fail: 0, skipped: 0 },
      startedAt: startedAt.toISOString(),
      infraError: e.message,
    };
    fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(inf, null, 2));
    process.exit(2);
  }

  // ── Step 2: classify rows + emit summary ────────────────────────────────
  const rows = parityReport.rows ?? [];
  const passRows = rows.filter((r) => r.status === "pass");
  const failRows = rows.filter((r) => r.status === "fail");
  const gapRows = rows.filter((r) => r.status === "missing-rust" || r.status === "rust-file-gone");
  const otherRows = rows.filter(
    (r) => !["pass", "fail", "missing-rust", "rust-file-gone"].includes(r.status)
  );

  console.log(`Checked:   ${rows.length}`);
  console.log(`Pass:      ${passRows.length}`);
  console.log(`Fail:      ${failRows.length}  (true parity drift)`);
  console.log(`Gap:       ${gapRows.length}  (Chorizite-only — no Rust enum)`);
  if (otherRows.length > 0) {
    console.log(`Other:     ${otherRows.length}  (unexpected status; review)`);
  }
  console.log("");

  if (passRows.length > 0) {
    console.log("PASS rows:");
    for (const r of passRows) {
      console.log(
        `  ${r.choriziteName.padEnd(30)} → ${r.rustName ?? "?"}  (${r.checkedMembers} members)`
      );
    }
    console.log("");
  }

  if (failRows.length > 0) {
    console.log("FAIL rows (parity drift — fix the Rust side or update the mapping):");
    for (const r of failRows) {
      console.log(
        `  ✗ ${r.choriziteName.padEnd(30)} ↔ ${r.rustName} (${r.rustRelativePath})`
      );
      console.log(`      checked=${r.checkedMembers} pass=${r.passMembers} fail=${r.failMembers}`);
      for (const mm of r.mismatches.slice(0, 6)) {
        console.log(
          `      [${mm.kind}] ${mm.name}   chor=${fmtVal(mm.choriziteValue)}  rust=${fmtVal(mm.rustValue)}`
        );
      }
      if (r.mismatches.length > 6) {
        console.log(`      … and ${r.mismatches.length - 6} more`);
      }
    }
    console.log("");
  }

  if (gapRows.length > 0) {
    console.log("GAP rows (Chorizite-side enums with no Rust pub-enum counterpart):");
    console.log("  (these are diagnostic, not failures — most are bitflags! macro-backed Rust types)");
    for (const r of gapRows) {
      console.log(`  ⚠ ${r.choriziteName}  (${r.checkedMembers} members)`);
    }
    console.log("");
  }

  // ── Step 3: emit the canonical JSON report ──────────────────────────────
  const finishedAt = new Date();
  const envelope = {
    surface: "enum-parity",
    oracle: {
      kind: "chorizite-common-enums + chorizite-acprotocol-objectdescriptionflag",
      sourceRoot: parityReport.choriziteSourceRoot,
    },
    subject: {
      kind: "holtburger-rust-crates",
      cratesRoot: parityReport.rustCrateRoot,
    },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    summary: {
      checked: rows.length,
      pass: passRows.length,
      fail: failRows.length,
      skipped: gapRows.length,
    },
    mismatches: failRows.flatMap((r) =>
      r.mismatches.map((mm) => ({
        case: `${r.choriziteName}::${mm.name}`,
        rustName: r.rustName,
        rustPath: r.rustRelativePath,
        kind: mm.kind,
        choriziteValue: mm.choriziteValue,
        rustValue: mm.rustValue,
        note: mm.note,
      }))
    ),
    gaps: gapRows.map((r) => ({
      choriziteName: r.choriziteName,
      memberCount: r.checkedMembers,
      reason: "no Rust pub enum counterpart (most likely bitflags! macro or not-yet-ported)",
    })),
    rows: rows,
    outputPath: reportDir,
  };
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(envelope, null, 2));
  console.log(`Wrote ${path.join(reportDir, "report.json")}`);
  console.log("");

  // ── Exit ────────────────────────────────────────────────────────────────
  if (failRows.length > 0) {
    console.log("RESULT: FAIL (parity drift detected)");
    process.exit(1);
  }
  console.log(`RESULT: PASS (${passRows.length} enums matched; ${gapRows.length} GAP rows are diagnostic)`);
  process.exit(0);
}

function fmtVal(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    if (Math.abs(v) < 0x10000) return `0x${v.toString(16).padStart(4, "0")} (${v})`;
    return `0x${v.toString(16).padStart(8, "0")} (${v})`;
  }
  return String(v);
}

main().catch((e) => {
  console.error("validate_enum_parity crashed:", e);
  process.exit(2);
});
