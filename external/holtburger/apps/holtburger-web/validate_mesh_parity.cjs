// Wave 4.C + 4.D — Mesh-parity validator.
//
// **What this tool does:** drives WB.Terminal's `mesh-vs-obj-export-chunk`
// and `env-cell-vs-setup-model-chunk` JSON commands to validate that the
// Chorizite (DRW) GfxObj/Setup/EnvCell parsers agree with the
// holtburger-dat (Rust) parsers across the whole DAT — or, in fast mode,
// across the 81-model Holtburg subset for per-commit feedback.
//
// **Two phases:**
//
// **Phase A — Mesh chunk** (`mesh-vs-obj-export-chunk`).
//   For each (start, end) sub-range across the GfxObj + Setup ID space
//   (0x01000000 – 0x02FFFFFF):
//     1. Drive the chunk command. Counts surfaces, vertices, polygons,
//        physics-polys, BSP presence per record.
//     2. Validate `parseErrorCount` is zero (parser is sound).
//     3. Validate `failCount / recordCount` ≤ 0.005 (≥99.5% PASS bar
//        per `docs/diagnostic-toolset-plan-2026-05-19.md` §6 W4.C
//        acceptance, allowing ~76 known-degenerate-triangle filter
//        cases per [[project_emit_dynamic_site]]).
//     4. Verify `datSha256` matches the canonical base-DAT bake oracle.
//
// **Phase B — EnvCell chunk** (`env-cell-vs-setup-model-chunk`).
//   For each (start, end) sub-range across the EnvCell ID space:
//     1. Drive the chunk command. Counts portals, surfaces,
//        visible-cells, restrictions, stabs per record.
//     2. Validate `parseErrorCount` is zero.
//     3. Validate `failCount / recordCount` ≤ 0.01 (≥99% PASS bar
//        per §6 W4.D).
//     4. Record `knownDriftCount` as informational (the 0x72040335
//        visibleCells[] ordering hit per W2.D — Rust vs Chorizite
//        disagree; documented in `docs/mesh-parity-method.md`).
//     5. Verify `datSha256` matches the canonical base-DAT bake oracle.
//
// **Modes:**
//   --mode=fast (default): Holtburg 81-model subset (sub-second).
//     For GfxObj: walk the first 100 IDs by enumeration of the
//     0x01xxxxxx prefix (the Holtburg subset is dominated by these).
//     For EnvCell: walk the Academy LB 0x86020000 (568 cells).
//   --mode=full: whole-DAT sweep.
//     For GfxObj: 0x01000000 → 0x03000000 in 1024-record chunks (≈
//     21 chunks); 15,318 GfxObjs + 5,935 Setups ≈ 21,253 records.
//     For EnvCell: 734,976 records — chunked aggressively (256 IDs per
//     chunk = 2,872 chunks) since each TryGet is ≤ 0.5ms; full pass
//     estimated 25-45 minutes. Cache-keyed by record sha so re-runs
//     against unchanged base DATs are O(0).
//
// **Exit codes:**
//   0 : Phase A + B both within acceptance bars.
//   1 : One or more chunks exceed FAIL budget; or knownDriftCount > 5
//       (the documented drift allowlist size — sentinel for new drift).
//   2 : Infra (WB.Terminal crash; dispatch missing; DAT sha mismatch).
//
// **Run:**
//   `node validate_mesh_parity.cjs`                         # fast (default)
//   `node validate_mesh_parity.cjs --mode=fast`             # explicit fast
//   `node validate_mesh_parity.cjs --mode=full`             # whole-DAT
//   `WBT_DLL=/path/to/WorldBuilder.Terminal.dll node validate_mesh_parity.cjs`
//
// **Layout:**
//   - C# subprocess: `$DOTNET_ROOT/dotnet ../../../../WorldBuilder.Terminal.dll --stdin`
//   - Cache root: `/mnt/wbterminal1/holtburger-validator-fixtures/wave4/`
//   - Report dir: `/mnt/wbterminal1/holtburger-validator-reports/mesh-parity/<ts>/`
//
// **See also:**
//   - Method doc: `docs/mesh-parity-method.md`
//   - Memory: `project_w4_mesh_done_2026-05-20.md`
//   - Sibling: `validate_dat_parity.cjs` (Phase B field-tree diff),
//              `validate_cell_portal_graph.cjs` (Wave 5.A)
//   - Source-of-truth: `acclient.c::CGfxObj::*`, `acclient.c::CEnvCell::*`
//                      at ~/ac-headers/acclient.c

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// ─── Paths + env ──────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const WBT_DLL = process.env.WBT_DLL
  || path.join(REPO_ROOT, "WorldBuilder.Terminal", "bin", "Release", "net8.0", "WorldBuilder.Terminal.dll");
const DOTNET = process.env.DOTNET_ROOT
  ? path.join(process.env.DOTNET_ROOT, "dotnet")
  : "dotnet";
const JSON_DISPATCHER = path.join(REPO_ROOT, "WorldBuilder.Terminal", "JsonCommandProcessor.cs");
const REPORT_ROOT = "/mnt/wbterminal1/holtburger-validator-reports/mesh-parity";
const CACHE_ROOT = "/mnt/wbterminal1/holtburger-validator-fixtures/wave4";
const MESH_CACHE = path.join(CACHE_ROOT, "mesh");
const ENV_CACHE = path.join(CACHE_ROOT, "envcell");
const FIXTURES_ROOT = path.join(__dirname, "fixtures", "mesh");

const EXPECTED_PORTAL_DAT_SHA = "dc6e500ba22e6b186db7171e3f3345238b6444c85d798adc85e550973b8d12e4";
const EXPECTED_CELL_DAT_SHA = "6db0abf00fbceed62c3f1ee842ee7c1f423d732bed77a5b7c102ee89a52ab99e";

// Phase A — GfxObj+Setup chunking. Whole range 0x01000000 .. 0x03000000
// (exclusive). 21,253 records total. Smoke confirmed 15,318 GfxObjs
// in ~5s + 5,935 Setups in ~13s as a single combined sweep. The actual
// chunking happens at the wave4-sweep orchestrator layer (see
// scripts/wave4_sweep.cjs); this validator drives one combined sweep
// per phase rather than enumerating the chunks itself.

// Phase B — EnvCell chunking. 734,976 records across cell DAT. The
// DRW BTree walks are very fast (~30k cells/s). Full sweep ≈ 30s.
const ENV_RANGE_START = 0x00010000;  // first cell DAT LB
const ENV_RANGE_END   = 0xFFFE0000;

// Fast mode: Holtburg subset.
// GfxObj fast-mode: walk 0x01000000..0x01001000 (≈2,081 GfxObjs) +
// 0x02000000..0x02000100 (≈85 Setups) to exercise both parsers under
// the same ≤30s smoke budget. The 81-model Holtburg subset would
// reduce this further if pre-baked into a fixture; this range-based
// approach is cache-friendly and deterministic.
const FAST_GFX_START = 0x01000000;
const FAST_GFX_END   = 0x01001000;
const FAST_SETUP_START = 0x02000000;
const FAST_SETUP_END   = 0x02000100;

// EnvCell fast-mode: AC Training Academy LB 0x86020000.
// 568 EnvCells per [[project_holtburger_academy_landblock]].
const FAST_ENV_START = 0x86020100;
const FAST_ENV_END   = 0x8602FFFD;

// Acceptance bars per `docs/diagnostic-toolset-plan-2026-05-19.md` §6 W4:
const GFX_FAIL_BUDGET = 0.005;   // ≥99.5% PASS on GfxObj
const ENV_FAIL_BUDGET = 0.01;    // ≥99% PASS on EnvCell
const ENV_DRIFT_BUDGET = 5;      // allowlist size = 1 (0x72040335);
                                 // budget 5 = sentinel for new drift

// ─── WB.Terminal stdin driver ─────────────────────────────────────────

function isoSlug(date = new Date()) {
  return date.toISOString().replace(/\.[0-9]{3}Z$/, "Z").replace(/:/g, "-");
}

function ensureWbtDll() {
  if (!fs.existsSync(WBT_DLL)) {
    throw new Error(`WorldBuilder.Terminal.dll not found at ${WBT_DLL}\n  Build: dotnet build WorldBuilder.Terminal -c Release`);
  }
}

class WbtDriver {
  constructor() {
    this.child = null;
    this.buf = "";
    this.queue = [];
    this.current = null;
    this.stderrBuf = "";
    this.exited = false;
  }
  start() {
    this.child = spawn(DOTNET, [WBT_DLL, "--stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk) => { this.stderrBuf += chunk.toString("utf8"); });
    this.child.on("exit", (code) => {
      this.exited = true;
      if (this.current) {
        const { reject } = this.current;
        this.current = null;
        reject(new Error(`WB.Terminal exited (code=${code}) mid-command. stderr:\n${this.stderrBuf}`));
      }
    });
  }
  onData(data) {
    this.buf += data;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      if (obj.command === "ready") continue;
      if (this.current) {
        // Accept the response whose command matches the request OR a
        // success=false response (e.g. unknown-command) — that's our
        // dispatch-pending signal.
        if (obj.command === this.current.expected || obj.success === false) {
          const { resolve } = this.current;
          this.current = null;
          resolve(obj);
          this.drain();
        }
      }
    }
  }
  send(commandObj, timeoutMs = 300_000) {
    return new Promise((resolve, reject) => {
      this.queue.push({ commandObj, resolve, reject, expected: commandObj.command, timeoutMs });
      this.drain();
    });
  }
  drain() {
    if (this.current || this.queue.length === 0) return;
    const next = this.queue.shift();
    this.current = next;
    const timer = setTimeout(() => {
      if (this.current === next) {
        this.current = null;
        next.reject(new Error(`Timeout ${next.timeoutMs}ms for ${next.expected}`));
        this.drain();
      }
    }, next.timeoutMs);
    const origResolve = next.resolve;
    next.resolve = (val) => { clearTimeout(timer); origResolve(val); };
    const origReject = next.reject;
    next.reject = (err) => { clearTimeout(timer); origReject(err); };
    this.child.stdin.write(JSON.stringify(next.commandObj) + "\n");
  }
  stop() {
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
  }
}

// ─── Phase A — Mesh (GfxObj + Setup) chunks ───────────────────────────

async function runPhaseA(driver, mode, results) {
  console.log(`\n=== Phase A — Mesh (GfxObj + Setup) chunks (${mode}) ===`);
  const chunkPlan = buildGfxChunkPlan(mode);
  console.log(`  ${chunkPlan.length} chunks queued`);

  const phase = {
    mode,
    chunkCount: chunkPlan.length,
    aggregate: {
      recordCount: 0,
      passCount: 0,
      failCount: 0,
      cachedCount: 0,
      parseErrorCount: 0,
    },
    perChunk: [],
    datSha256: null,
    dispatchPending: false,
  };

  let dispatchPendingDetected = false;

  for (let i = 0; i < chunkPlan.length; i++) {
    const c = chunkPlan[i];
    const t0 = Date.now();
    const resp = await driver.send({
      command: "mesh-vs-obj-export-chunk",
      startId: hex(c.start),
      endId: hex(c.end),
      cacheRoot: MESH_CACHE,
    }, 600_000);
    const dtMs = Date.now() - t0;

    if (resp.success === false && /Unknown command/i.test(resp.error || "")) {
      dispatchPendingDetected = true;
      phase.dispatchPending = true;
      console.log(`  [SKIP_CLI] dispatch pending for mesh-vs-obj-export-chunk — see WAVE4M_DISPATCH_PENDING.patch`);
      break;
    }
    if (resp.error) {
      throw new Error(`mesh-vs-obj-export-chunk failed at ${hex(c.start)}: ${resp.error}`);
    }
    if (!phase.datSha256) phase.datSha256 = resp.datSha256;
    if (resp.datSha256 !== EXPECTED_PORTAL_DAT_SHA) {
      throw new Error(`Portal DAT sha drift! got=${resp.datSha256} expected=${EXPECTED_PORTAL_DAT_SHA}. Re-bake from base DATs per [[feedback_base_dats_only_for_bake]].`);
    }
    phase.aggregate.recordCount += resp.recordCount;
    phase.aggregate.passCount += resp.passCount;
    phase.aggregate.failCount += resp.failCount;
    phase.aggregate.cachedCount += resp.cachedCount;
    phase.aggregate.parseErrorCount += resp.parseErrorCount;
    phase.perChunk.push({
      start: hex(c.start),
      end: hex(c.end),
      recordCount: resp.recordCount,
      passCount: resp.passCount,
      failCount: resp.failCount,
      cachedCount: resp.cachedCount,
      parseErrorCount: resp.parseErrorCount,
      progressJsonPath: resp.progressJsonPath,
      dtMs,
    });

    if ((i + 1) % 5 === 0 || i + 1 === chunkPlan.length) {
      process.stdout.write(`  chunk ${i + 1}/${chunkPlan.length}: ${resp.recordCount} records, ${resp.passCount} pass, ${resp.failCount} fail (${dtMs} ms)\n`);
    }
  }

  results.phaseA = phase;
  if (dispatchPendingDetected) return phase;

  console.log(`  total: ${phase.aggregate.recordCount} records, ${phase.aggregate.passCount} pass, ${phase.aggregate.failCount} fail, ${phase.aggregate.cachedCount} cached, ${phase.aggregate.parseErrorCount} parse-error`);
  return phase;
}

function buildGfxChunkPlan(mode) {
  const plan = [];
  if (mode === "fast") {
    // Fast-mode: two chunks — Holtburg-density GfxObj window + a
    // small Setup window. Both run sub-3s on a warm cache.
    plan.push({ start: FAST_GFX_START, end: FAST_GFX_END });
    plan.push({ start: FAST_SETUP_START, end: FAST_SETUP_END });
  } else {
    // Full-mode: two chunks — full GfxObj range (15,318 records,
    // ~5s) + full Setup range (5,935 records, ~13s). DRW BTree walk
    // is internal to the engine; one TryGet per record. No benefit
    // from sub-chunking at this scale.
    plan.push({ start: 0x01000000, end: 0x02000000 });
    plan.push({ start: 0x02000000, end: 0x03000000 });
  }
  return plan;
}

// ─── Phase B — EnvCell chunks ─────────────────────────────────────────

async function runPhaseB(driver, mode, results) {
  console.log(`\n=== Phase B — EnvCell chunks (${mode}) ===`);
  const chunkPlan = buildEnvChunkPlan(mode);
  console.log(`  ${chunkPlan.length} chunks queued`);

  const phase = {
    mode,
    chunkCount: chunkPlan.length,
    aggregate: {
      recordCount: 0,
      passCount: 0,
      failCount: 0,
      cachedCount: 0,
      parseErrorCount: 0,
      knownDriftCount: 0,
    },
    perChunk: [],
    datSha256: null,
    dispatchPending: false,
  };

  let dispatchPendingDetected = false;

  for (let i = 0; i < chunkPlan.length; i++) {
    const c = chunkPlan[i];
    const t0 = Date.now();
    const resp = await driver.send({
      command: "env-cell-vs-setup-model-chunk",
      startId: hex(c.start),
      endId: hex(c.end),
      cacheRoot: ENV_CACHE,
    }, 600_000);
    const dtMs = Date.now() - t0;

    if (resp.success === false && /Unknown command/i.test(resp.error || "")) {
      dispatchPendingDetected = true;
      phase.dispatchPending = true;
      console.log(`  [SKIP_CLI] dispatch pending for env-cell-vs-setup-model-chunk — see WAVE4M_DISPATCH_PENDING.patch`);
      break;
    }
    if (resp.error) {
      throw new Error(`env-cell-vs-setup-model-chunk failed at ${hex(c.start)}: ${resp.error}`);
    }
    if (!phase.datSha256) phase.datSha256 = resp.datSha256;
    if (resp.datSha256 !== EXPECTED_CELL_DAT_SHA) {
      throw new Error(`Cell DAT sha drift! got=${resp.datSha256} expected=${EXPECTED_CELL_DAT_SHA}. Re-bake from base DATs per [[feedback_base_dats_only_for_bake]].`);
    }
    phase.aggregate.recordCount += resp.recordCount;
    phase.aggregate.passCount += resp.passCount;
    phase.aggregate.failCount += resp.failCount;
    phase.aggregate.cachedCount += resp.cachedCount;
    phase.aggregate.parseErrorCount += resp.parseErrorCount;
    phase.aggregate.knownDriftCount += resp.knownDriftCount || 0;
    phase.perChunk.push({
      start: hex(c.start),
      end: hex(c.end),
      recordCount: resp.recordCount,
      passCount: resp.passCount,
      failCount: resp.failCount,
      cachedCount: resp.cachedCount,
      parseErrorCount: resp.parseErrorCount,
      knownDriftCount: resp.knownDriftCount || 0,
      progressJsonPath: resp.progressJsonPath,
      dtMs,
    });

    if ((i + 1) % 10 === 0 || i + 1 === chunkPlan.length) {
      process.stdout.write(`  chunk ${i + 1}/${chunkPlan.length}: ${resp.recordCount} records (${dtMs} ms)\n`);
    }
  }

  results.phaseB = phase;
  if (dispatchPendingDetected) return phase;

  console.log(`  total: ${phase.aggregate.recordCount} cells, ${phase.aggregate.passCount} pass, ${phase.aggregate.failCount} fail, ${phase.aggregate.cachedCount} cached, drift hits: ${phase.aggregate.knownDriftCount}`);
  return phase;
}

function buildEnvChunkPlan(mode) {
  const plan = [];
  if (mode === "fast") {
    // Academy LB 0x86020000 — 568 EnvCells.
    // Single chunk over the full LB sub-range; the engine walks the
    // BTree once and TryGet's only the present records, so a 64-Ki-wide
    // chunk completes sub-second.
    plan.push({ start: FAST_ENV_START, end: FAST_ENV_END });
  } else {
    // Full-mode: 734,976 records. DRW's BTree walk is fast enough
    // (~30k cells/s) that one giant chunk over the whole range
    // completes in ≤30s. Smaller chunks pay too much round-trip
    // overhead for the empty-landblock case (most of the 0xXXYY high
    // bytes contain no cells). One chunk = one BTree walk.
    plan.push({ start: ENV_RANGE_START, end: ENV_RANGE_END });
  }
  return plan;
}

// ─── Summary + acceptance bar ─────────────────────────────────────────

function summarize(results) {
  const a = results.phaseA?.aggregate || { recordCount: 0, passCount: 0, failCount: 0, parseErrorCount: 0 };
  const b = results.phaseB?.aggregate || { recordCount: 0, passCount: 0, failCount: 0, parseErrorCount: 0, knownDriftCount: 0 };

  const aRecords = a.recordCount;
  const bRecords = b.recordCount;
  const aFailRate = aRecords > 0 ? a.failCount / aRecords : 0;
  const bFailRate = bRecords > 0 ? b.failCount / bRecords : 0;

  const aDispatchPending = results.phaseA?.dispatchPending === true;
  const bDispatchPending = results.phaseB?.dispatchPending === true;

  // Dispatch pending is INFRA, not FAIL — until the splice agent lands
  // the canonical patch from WAVE4M_DISPATCH_PENDING.patch, fast-mode
  // returns SKIP_CLI.
  const dispatchPending = aDispatchPending || bDispatchPending;

  const aAccept = !aDispatchPending && a.parseErrorCount === 0 && aFailRate <= GFX_FAIL_BUDGET;
  const bAccept = !bDispatchPending && b.parseErrorCount === 0 && bFailRate <= ENV_FAIL_BUDGET
                  && b.knownDriftCount <= ENV_DRIFT_BUDGET;

  const overallPass = aAccept && bAccept;
  return {
    phaseAGfxRecords: aRecords,
    phaseAGfxFail: a.failCount,
    phaseAGfxParseErrors: a.parseErrorCount,
    phaseAGfxFailRate: aFailRate,
    phaseAAccept: aAccept,
    phaseAGfxBudget: GFX_FAIL_BUDGET,
    phaseADispatchPending: aDispatchPending,

    phaseBEnvRecords: bRecords,
    phaseBEnvFail: b.failCount,
    phaseBEnvParseErrors: b.parseErrorCount,
    phaseBEnvFailRate: bFailRate,
    phaseBEnvDrift: b.knownDriftCount,
    phaseBAccept: bAccept,
    phaseBEnvBudget: ENV_FAIL_BUDGET,
    phaseBEnvDriftBudget: ENV_DRIFT_BUDGET,
    phaseBDispatchPending: bDispatchPending,

    dispatchPending,
    overallPass,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function hex(n) { return "0x" + (n >>> 0).toString(16).padStart(8, "0").toUpperCase(); }

function parseArgs(argv) {
  const args = { mode: "fast", autoSplice: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--mode=")) args.mode = a.slice("--mode=".length);
    else if (a === "--auto-splice") args.autoSplice = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node validate_mesh_parity.cjs [--mode=fast|full] [--auto-splice]");
      console.log("");
      console.log("  --mode=fast (default): Holtburg-density GfxObj + Setup + Academy EnvCells. ≤30s.");
      console.log("  --mode=full          : whole-DAT walk (15,318 GfxObj + 5,935 Setup + 734,976 EnvCell). ≤60s.");
      console.log("  --auto-splice        : transiently splice WAVE4M_DISPATCH_PENDING.patch into");
      console.log("                         JsonCommandProcessor.cs + rebuild, revert on exit.");
      console.log("                         Use when dispatch is not yet permanently spliced.");
      process.exit(0);
    }
  }
  if (!["fast", "full"].includes(args.mode)) {
    console.error(`Unknown --mode=${args.mode}; must be fast or full`);
    process.exit(2);
  }
  return args;
}

// ─── Dispatch probe + (optional) auto-splice ──────────────────────────

async function probeDispatch() {
  return new Promise((resolve) => {
    const child = spawn(DOTNET, [WBT_DLL, "--stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stdin.write(JSON.stringify({
      command: "mesh-vs-obj-export-chunk",
      startId: "0x01000000",
      endId: "0x01000001",
    }) + "\n");
    setTimeout(() => {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    }, 4000);
    child.on("exit", () => {
      const unknown =
        /Unknown command:\s*['"\\u0027]\s*mesh-vs-obj-export-chunk/i.test(stdout)
        || /Unknown command:\s*\\u0027mesh-vs-obj-export-chunk/.test(stdout);
      resolve(!unknown);
    });
  });
}

/**
 * Idempotent splice of the WAVE4M dispatch lines into JsonCommandProcessor.cs.
 * Mirrors validate_texture_decode.cjs::autoSplice. Returns the original-file
 * content so the caller can restore it post-run.
 */
function autoSplice() {
  const original = fs.readFileSync(JSON_DISPATCHER, "utf8");
  if (original.includes('"mesh-vs-obj-export-chunk"')) {
    return null; // Already wired.
  }

  // Locate the Wave-5.B skybox dispatch block; insert before it (it's
  // immediately after the Wave-5.A block; Wave-4 conceptually lands
  // between Wave-3 motion and Wave-5.A cell-portal — the texture
  // sibling uses the same pattern).
  const marker = '// Wave-5.B skybox parity diagnostic — see CommandEngine.Skybox.cs';
  const idx = original.indexOf(marker);
  if (idx < 0) {
    throw new Error("Could not locate Wave-5.B marker in JsonCommandProcessor.cs (API drift).");
  }
  const lines = original.split("\n");
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(marker)) {
      insertAt = i;
      break;
    }
  }
  if (insertAt < 0) {
    throw new Error("Could not locate insertion point at Wave-5.B marker.");
  }
  lines.splice(insertAt, 0,
    '            // Wave-4.C + 4.D mesh-parity diagnostic — see CommandEngine.MeshParity.cs',
    '            ["mesh-vs-obj-export-chunk"]       = CmdMeshVsObjExportChunk,',
    '            ["env-cell-vs-setup-model-chunk"]  = CmdEnvCellVsSetupModelChunk,');

  const tail = lines.join("\n");
  const wrappers = `

    // ─────────────────────────────────────────────────────────────────
    // Wave-4.C mesh-vs-obj-export-chunk + Wave-4.D env-cell-vs-setup-model-chunk
    // (auto-spliced by validate_mesh_parity.cjs from WAVE4M_DISPATCH_PENDING.patch)
    // ─────────────────────────────────────────────────────────────────

    private string CmdMeshVsObjExportChunk(System.Text.Json.Nodes.JsonNode node) {
        uint startId = ParseLbIdScalar(node["startId"]
            ?? throw new ArgumentException("Missing 'startId' field"));
        uint endId = ParseLbIdScalar(node["endId"]
            ?? throw new ArgumentException("Missing 'endId' field"));
        string? datPath = node["datPath"]?.GetValue<string>();
        string? cacheRoot = node["cacheRoot"]?.GetValue<string>();
        bool fastMode = node["fastMode"]?.GetValue<bool>() ?? false;
        System.Collections.Generic.List<uint>? fastIds = null;
        var idsArr = node["fastModeIds"]?.AsArray();
        if (idsArr != null) {
            fastIds = new System.Collections.Generic.List<uint>(idsArr.Count);
            foreach (var entry in idsArr) {
                if (entry == null) continue;
                fastIds.Add(ParseLbIdScalar(entry));
            }
        }
        var r = _engine.MeshVsObjExportChunk(startId, endId, datPath, cacheRoot, fastMode, fastIds);
        return Serialize(new {
            success = r.FailCount == 0,
            command = "mesh-vs-obj-export-chunk",
            chunkLabel = r.ChunkLabel,
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            startId = $"0x{r.StartId:X8}",
            endId = $"0x{r.EndId:X8}",
            recordCount = r.RecordCount,
            passCount = r.PassCount,
            failCount = r.FailCount,
            cachedCount = r.CachedCount,
            parseErrorCount = r.ParseErrorCount,
            cacheRoot = r.CacheRoot,
            progressJsonPath = r.ProgressJsonPath,
            source = r.Source,
            failures = r.Failures.Select(f => new {
                idHex = f.IdHex,
                typeName = f.TypeName,
                status = f.Status,
                failureReason = f.FailureReason,
            }),
        });
    }

    private string CmdEnvCellVsSetupModelChunk(System.Text.Json.Nodes.JsonNode node) {
        uint startId = ParseLbIdScalar(node["startId"]
            ?? throw new ArgumentException("Missing 'startId' field"));
        uint endId = ParseLbIdScalar(node["endId"]
            ?? throw new ArgumentException("Missing 'endId' field"));
        string? datPath = node["datPath"]?.GetValue<string>();
        string? cacheRoot = node["cacheRoot"]?.GetValue<string>();
        bool fastMode = node["fastMode"]?.GetValue<bool>() ?? false;
        System.Collections.Generic.List<uint>? fastIds = null;
        var idsArr = node["fastModeIds"]?.AsArray();
        if (idsArr != null) {
            fastIds = new System.Collections.Generic.List<uint>(idsArr.Count);
            foreach (var entry in idsArr) {
                if (entry == null) continue;
                fastIds.Add(ParseLbIdScalar(entry));
            }
        }
        var r = _engine.EnvCellVsSetupModelChunk(startId, endId, datPath, cacheRoot, fastMode, fastIds);
        return Serialize(new {
            success = r.FailCount == 0,
            command = "env-cell-vs-setup-model-chunk",
            chunkLabel = r.ChunkLabel,
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            startId = $"0x{r.StartId:X8}",
            endId = $"0x{r.EndId:X8}",
            recordCount = r.RecordCount,
            passCount = r.PassCount,
            failCount = r.FailCount,
            cachedCount = r.CachedCount,
            parseErrorCount = r.ParseErrorCount,
            knownDriftCount = r.KnownDriftCount,
            cacheRoot = r.CacheRoot,
            progressJsonPath = r.ProgressJsonPath,
            source = r.Source,
            failures = r.Failures.Select(f => new {
                idHex = f.IdHex,
                typeName = f.TypeName,
                status = f.Status,
                failureReason = f.FailureReason,
            }),
        });
    }
`;
  // Insert wrappers before the final closing brace of the class.
  const lastBrace = tail.lastIndexOf("}");
  if (lastBrace < 0) {
    throw new Error("Could not locate final class brace in JsonCommandProcessor.cs (API drift).");
  }
  const spliced = tail.slice(0, lastBrace) + wrappers + "\n" + tail.slice(lastBrace);

  fs.writeFileSync(JSON_DISPATCHER, spliced);
  console.log(`  [auto-splice] inserted dispatch + 2 wrappers into JsonCommandProcessor.cs`);
  return original;
}

function restoreJsonDispatcher(original) {
  if (original == null) return;
  fs.writeFileSync(JSON_DISPATCHER, original);
  console.log(`  [auto-splice] reverted JsonCommandProcessor.cs to pre-splice state`);
}

function rebuildTerminal() {
  console.log(`  [auto-splice] rebuilding WorldBuilder.Terminal -c Release ...`);
  const res = spawnSync(DOTNET, ["build", "WorldBuilder.Terminal", "-c", "Release", "--nologo"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
    env: { ...process.env },
  });
  if (res.status !== 0) {
    const out = (res.stdout?.toString() || "") + (res.stderr?.toString() || "");
    throw new Error("Rebuild failed. Last 500 chars of build output:\n" + out.slice(-500));
  }
  console.log(`  [auto-splice] rebuild OK`);
}

// ─── Main ──────────────────────────────────────────────────────────────

(async () => {
  const cliArgs = parseArgs(process.argv);
  ensureWbtDll();
  fs.mkdirSync(MESH_CACHE, { recursive: true });
  fs.mkdirSync(ENV_CACHE, { recursive: true });
  fs.mkdirSync(FIXTURES_ROOT, { recursive: true });

  // Optional dispatch auto-splice — useful when WAVE4M_DISPATCH_PENDING.patch
  // hasn't been applied yet (parallel sibling-agent dev loop).
  let splicedOriginal = null;
  if (cliArgs.autoSplice) {
    const dispatched = await probeDispatch();
    if (!dispatched) {
      console.log(`  [auto-splice] dispatch not detected — applying transient splice…`);
      splicedOriginal = autoSplice();
      try { rebuildTerminal(); } catch (e) {
        if (splicedOriginal != null) restoreJsonDispatcher(splicedOriginal);
        throw e;
      }
    } else {
      console.log(`  [auto-splice] dispatch already wired — no-op`);
    }
  }

  const slug = isoSlug();
  const reportDir = path.join(REPORT_ROOT, slug);
  fs.mkdirSync(reportDir, { recursive: true });

  const results = {
    runId: slug,
    mode: cliArgs.mode,
    reportDir,
    startedAt: new Date().toISOString(),
    expected: {
      portalDatSha: EXPECTED_PORTAL_DAT_SHA,
      cellDatSha: EXPECTED_CELL_DAT_SHA,
      gfxFailBudget: GFX_FAIL_BUDGET,
      envFailBudget: ENV_FAIL_BUDGET,
      envDriftBudget: ENV_DRIFT_BUDGET,
    },
    phaseA: null,
    phaseB: null,
    summary: null,
  };

  const driver = new WbtDriver();
  driver.start();

  // Wait for "ready" signal.
  await new Promise((res) => setTimeout(res, 1500));

  let exit = 0;
  try {
    await runPhaseA(driver, cliArgs.mode, results);
    await runPhaseB(driver, cliArgs.mode, results);
    results.summary = summarize(results);
    results.finishedAt = new Date().toISOString();

    const reportPath = path.join(reportDir, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
    console.log(`\nReport: ${reportPath}`);

    const s = results.summary;
    console.log(`\n=== Final ===`);
    console.log(`  Mode: ${cliArgs.mode}`);
    console.log(`  Phase A (GfxObj+Setup): ${s.phaseAGfxRecords} records, ${s.phaseAGfxFail} fail, ${s.phaseAGfxParseErrors} parse-err, rate ${(s.phaseAGfxFailRate * 100).toFixed(3)}% (budget ${(s.phaseAGfxBudget * 100).toFixed(1)}%)`);
    console.log(`  Phase B (EnvCell):      ${s.phaseBEnvRecords} cells, ${s.phaseBEnvFail} fail, ${s.phaseBEnvParseErrors} parse-err, rate ${(s.phaseBEnvFailRate * 100).toFixed(3)}% (budget ${(s.phaseBEnvBudget * 100).toFixed(1)}%); drift ${s.phaseBEnvDrift}/${s.phaseBEnvDriftBudget}`);
    if (s.dispatchPending) {
      console.log(`  Dispatch pending: see WorldBuilder.Terminal/WAVE4M_DISPATCH_PENDING.patch`);
      console.log(`  Overall: SKIP_CLI (dispatch not spliced yet)`);
      exit = 2;
    } else {
      console.log(`  Phase A accept: ${s.phaseAAccept ? "PASS" : "FAIL"}`);
      console.log(`  Phase B accept: ${s.phaseBAccept ? "PASS" : "FAIL"}`);
      console.log(`  Overall: ${s.overallPass ? "PASS" : "FAIL"}`);
      exit = s.overallPass ? 0 : 1;
    }
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`);
    if (e.stack) console.error(e.stack);
    exit = 2;
    results.error = e.message;
    fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(results, null, 2));
  } finally {
    driver.stop();
    if (splicedOriginal != null) {
      restoreJsonDispatcher(splicedOriginal);
      try { rebuildTerminal(); } catch (e) {
        console.error(`  [auto-splice] post-run rebuild failed: ${e.message}`);
      }
    }
  }

  process.exit(exit);
})();
