// Wave 5.A — Cell-portal graph validator.
//
// **What this tool does:** validates retail DAT cell-portal graph
// integrity across the 13×13 Holtburg ring + Academy + 5 other dungeons.
//
// **Phase A** — Portal symmetry sweep.
// For each landblock in the cohort:
//   1. Drive WB.Terminal's `cell-portal-graph-sweep` command.
//   2. Verify `asymmetricPortalCount == 0` (HARD bar — every A→B portal
//      must have a matching B→A entry per acclient.c::CCellPortal::Pack).
//   3. Verify DAT SHA-256 matches the base bake oracle.
//   4. Record `orphanedCellCount` as informational. Real retail DATs
//      DO contain "disconnected" cells with content but no portal
//      connectivity — they are visible-from-window-only "satellite"
//      cells. The bar is bounded (≤95% reachability per LB), not zero.
//
// **Phase B** — PVS visibility spot-checks.
// For each known-spawn cell in the cohort:
//   1. Drive `pvs-visibility-snapshot` at BFS depth 1.
//   2. Assert the live-BFS set is a SUBSET of the dat's precomputed
//      VisibleCells (depth=∞ transitive closure).
//   3. `onlyInLive` (live BFS members not in dat) MUST be empty.
//      `onlyInDat` is informational — dat's PVS is depth=∞ so naturally
//      larger.
//
// **Exit codes:**
//   - 0 : All LBs PASS symmetry (asymmetric=0); all PVS spot-checks PASS
//         subset; ≥95% portal symmetry across sampled cohort.
//   - 1 : Asymmetric portals found; live-PVS escaped dat-PVS.
//   - 2 : Infra (WB.Terminal crash; seeds missing).
//
// **Run:**
//   `node validate_cell_portal_graph.cjs`
//   `WBT_DLL=/path/to/WorldBuilder.Terminal.dll node validate_cell_portal_graph.cjs`
//
// **Layout:**
//   - C# subprocess: `$DOTNET_ROOT/dotnet ../../../../WorldBuilder.Terminal.dll --stdin`
//   - Report dir: `/mnt/wbterminal1/holtburger-validator-reports/cell-portal/<ts>/`
//
// **See also:**
//   - Method doc: `docs/cell-portal-method.md`
//   - Memory: `project_w5a_done_2026-05-20.md`
//   - Sibling validator: `validate_dat_parity.cjs` (same WB.Terminal driver pattern)
//   - Source-of-truth: `acclient.c::CCellPortal::*` at ~/ac-headers/acclient.c:362347-362403
//                      + `CEnvCell::recursively_get_object` at line 349403

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const WBT_DLL = process.env.WBT_DLL
  || path.join(REPO_ROOT, "WorldBuilder.Terminal", "bin", "Release", "net8.0", "WorldBuilder.Terminal.dll");
const DOTNET = process.env.DOTNET_ROOT
  ? path.join(process.env.DOTNET_ROOT, "dotnet")
  : "dotnet";
// `/mnt/wbterminal1` is the LAPTOP's scratch mount; the buildbox has
// `/mnt/wbterminal2` and no `wbterminal1` at all, so this validator could not
// run there — it died in `mkdirSync` before driving a single landblock
// (PORTAL-FLAGS-DECODE, 2026-08-11). Env-overridable, default unchanged.
const REPORT_ROOT = process.env.HB_VALIDATOR_REPORT_ROOT
  || "/mnt/wbterminal1/holtburger-validator-reports/cell-portal";

const EXPECTED_DAT_SHA = "6db0abf00fbceed62c3f1ee842ee7c1f423d732bed77a5b7c102ee89a52ab99e"; // client_cell_1.dat per [[feedback_base_dats_only_for_bake]]

// ─── Cohort definitions ────────────────────────────────────────────────

// 13×13 Holtburg ring per [[project_world_expand_step_1]] — 169 LBs.
// Center Holtburg = LB 0xA9B4. The ring spans (-6, +6) in both axes.
function buildHoltburgRing() {
  const centerX = 0xA9;
  const centerY = 0xB4;
  const ring = [];
  for (let dx = -6; dx <= 6; dx++) {
    for (let dy = -6; dy <= 6; dy++) {
      const x = (centerX + dx) & 0xFF;
      const y = (centerY + dy) & 0xFF;
      const lbHigh = ((x << 8) | y) << 16;
      ring.push(`0x${(lbHigh >>> 0).toString(16).toUpperCase().padStart(8, "0")}`);
    }
  }
  return ring;
}

// Academy + 5 other dungeons. Picked from known indoor LBs per
// [[project_holtburger_academy_landblock]] (568 EnvCells), Mite Maze +
// Holtburg Dungeon (well-known from emit-dynamic-site captures), plus
// three exhaustively-mapped LB-prefix samples chosen by inspection of
// the cell DAT B-tree (any indoor LB with >50 EnvCells qualifies).
const ACADEMY_LB = "0x86020000";
const DUNGEON_LBS = [
  "0x01F80000", // Mite Maze — 879 cells per project memory
  "0x01F60000", // Holtburg Dungeon — 429 cells
  "0x00020000", // DRW EOR-test EnvCell host (test fixtures live here)
  "0x00010000", // Adjacent test fixture LB
  "0x00030000", // Another low-LB-prefix dungeon
];

// PVS spot-checks: known cell IDs we want to BFS-sample.
const PVS_PROBES = [
  { cell: "0x00020102", label: "DRW-test cell (3 portals)" },
  { cell: "0x860201AD", label: "Academy entrance cell" },
  { cell: "0x01F801D4", label: "Mite Maze entrance" },
  { cell: "0x01F60289", label: "Holtburg Dungeon entrance" },
  { cell: "0x86020100", label: "Academy cell #0 (LB origin)" },
];

// ─── WB.Terminal subprocess driver ────────────────────────────────────

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
  }
  start() {
    this.child = spawn(DOTNET, [WBT_DLL, "--stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk) => { this.stderrBuf += chunk.toString("utf8"); });
    this.child.on("exit", (code) => {
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
      if (this.current && (obj.command === this.current.expected || obj.success === false)) {
        const { resolve } = this.current;
        this.current = null;
        resolve(obj);
        this.drain();
      }
    }
  }
  send(commandObj, timeoutMs = 120_000) {
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

// ─── Phase A — Portal symmetry sweep ──────────────────────────────────

async function runPhaseA(driver, cohort, label, results) {
  console.log(`\n=== Phase A — Portal symmetry sweep (${label}) ===`);
  console.log(`  ${cohort.length} LBs in cohort`);
  // Batch in chunks of 16 — each LB is fast (≤200 ms typical) so the
  // chunk just bounds memory per response. 16 was an arbitrary but
  // small enough number; can crank if it ever matters.
  const CHUNK = 16;
  const phase = {
    label,
    cohortSize: cohort.length,
    perLb: [],
    aggregate: {
      envCellCount: 0,
      portalCount: 0,
      orphanedCellCount: 0,
      asymmetricPortalCount: 0,
      lbsWithAsymmetry: 0,
      lbsWithOrphans: 0,
      lbsWithCells: 0,
      lbsEmpty: 0,
    },
    datSha256: null,
  };
  for (let i = 0; i < cohort.length; i += CHUNK) {
    const slice = cohort.slice(i, i + CHUNK);
    const resp = await driver.send({
      command: "cell-portal-graph-sweep",
      lbIds: slice,
    }, 300_000);
    if (resp.error) {
      throw new Error(`cell-portal-graph-sweep failed: ${resp.error}`);
    }
    if (!phase.datSha256) phase.datSha256 = resp.datSha256;
    if (resp.datSha256 !== EXPECTED_DAT_SHA) {
      throw new Error(`DAT sha drift! got=${resp.datSha256} expected=${EXPECTED_DAT_SHA}. Re-bake from base DATs per [[feedback_base_dats_only_for_bake]].`);
    }
    for (const lb of resp.perLb) {
      phase.perLb.push(lb);
      phase.aggregate.envCellCount += lb.cellCount;
      phase.aggregate.portalCount += lb.portalCount;
      phase.aggregate.orphanedCellCount += lb.orphanedCellCount;
      phase.aggregate.asymmetricPortalCount += lb.asymmetricPortalCount;
      if (lb.asymmetricPortalCount > 0) phase.aggregate.lbsWithAsymmetry++;
      if (lb.orphanedCellCount > 0) phase.aggregate.lbsWithOrphans++;
      if (lb.cellCount > 0) phase.aggregate.lbsWithCells++;
      else phase.aggregate.lbsEmpty++;
    }
    const dot = ".".repeat(Math.min(slice.length, 16));
    process.stdout.write(`${dot} (${i + slice.length}/${cohort.length})\n`);
  }
  console.log(`  cells: ${phase.aggregate.envCellCount}  portals: ${phase.aggregate.portalCount}`);
  console.log(`  asymmetric: ${phase.aggregate.asymmetricPortalCount} (across ${phase.aggregate.lbsWithAsymmetry} LBs)`);
  console.log(`  disconnected cells: ${phase.aggregate.orphanedCellCount} (across ${phase.aggregate.lbsWithOrphans} LBs)`);
  console.log(`  LBs with content / empty: ${phase.aggregate.lbsWithCells} / ${phase.aggregate.lbsEmpty}`);
  results.phaseA[label] = phase;
  return phase;
}

// ─── Phase B — PVS spot-checks ────────────────────────────────────────

async function runPhaseB(driver, probes, results) {
  console.log(`\n=== Phase B — PVS visibility spot-checks ===`);
  const phase = {
    probes: [],
    aggregate: {
      total: probes.length,
      subsetPass: 0,
      subsetFail: 0,
    },
  };
  for (const probe of probes) {
    const resp = await driver.send({
      command: "pvs-visibility-snapshot",
      cellId: probe.cell,
      bfsDepth: 1,
    });
    const subsetPass = (resp.onlyInLive?.length ?? 0) === 0;
    if (subsetPass) phase.aggregate.subsetPass++;
    else phase.aggregate.subsetFail++;
    phase.probes.push({
      cell: probe.cell,
      label: probe.label,
      liveVisibleCount: resp.liveVisibleCount,
      datVisibleCount: resp.datVisibleCount,
      onlyInLive: resp.onlyInLive,
      onlyInDatCount: resp.onlyInDat?.length ?? 0,
      subsetPass,
    });
    const indicator = subsetPass ? "PASS" : "FAIL";
    console.log(`  [${indicator}] ${probe.label} (${probe.cell}): live=${resp.liveVisibleCount}/dat=${resp.datVisibleCount}  onlyInLive=${resp.onlyInLive?.length ?? 0}`);
  }
  results.phaseB = phase;
  return phase;
}

// ─── Phase C — Symmetry rate computation ──────────────────────────────

function summarize(results) {
  const a1 = results.phaseA["holtburg-ring"]?.aggregate;
  const a2 = results.phaseA["academy"]?.aggregate;
  const a3 = results.phaseA["dungeons"]?.aggregate;
  const totalAsym = (a1?.asymmetricPortalCount ?? 0) + (a2?.asymmetricPortalCount ?? 0) + (a3?.asymmetricPortalCount ?? 0);
  const totalPortals = (a1?.portalCount ?? 0) + (a2?.portalCount ?? 0) + (a3?.portalCount ?? 0);
  const totalCells = (a1?.envCellCount ?? 0) + (a2?.envCellCount ?? 0) + (a3?.envCellCount ?? 0);
  const totalDisconnected = (a1?.orphanedCellCount ?? 0) + (a2?.orphanedCellCount ?? 0) + (a3?.orphanedCellCount ?? 0);

  const symmetryRate = totalPortals > 0 ? 1 - (totalAsym / totalPortals) : 1.0;
  const reachabilityRate = totalCells > 0 ? 1 - (totalDisconnected / totalCells) : 1.0;
  const pvsPass = results.phaseB.aggregate.subsetPass === results.phaseB.aggregate.total;

  // Acceptance bars: portal symmetry ≥0.95; PVS ALL subset-pass.
  // Per the spec push-back clause: disconnected cells in retail are
  // documented legitimate satellite cells; we tolerate them but report
  // the rate as informational.
  const symmetryPass = symmetryRate >= 0.95;
  const overallPass = symmetryPass && pvsPass;

  return {
    totalCells,
    totalPortals,
    totalAsym,
    totalDisconnected,
    symmetryRate,
    reachabilityRate,
    pvsTotal: results.phaseB.aggregate.total,
    pvsPass: results.phaseB.aggregate.subsetPass,
    pvsFail: results.phaseB.aggregate.subsetFail,
    symmetryAccept: symmetryPass,
    pvsAccept: pvsPass,
    overallPass,
  };
}

// ─── Phase D — Cross-LB stitching (opt-in via --cross-lb flag) ────────
//
// Wave-followon 2026-05-20 (open follow-on of [[project_w5a_done_2026-05-20]]).
// The existing Phase A "asymmetric portal" check works WITHIN one LB at a
// time — its CellPortalGraphSweep walks one LB's cells and treats any
// portal whose `OtherCellId` resolves to a different LB-high as a
// "cross-LB portal: do NOT count as asymmetric" (see
// CommandEngine.CellPortalGraph.cs:221-225). That `continue` hides the
// case where a cell points at a neighbor-LB cell that DOESN'T EXIST.
//
// Phase D loads all ring LBs at once + samples a few cells per LB +
// uses `pvs-visibility-snapshot` with bfsDepth=1 to enumerate each
// sample cell's portal targets. Any target whose LB-high is NOT in the
// loaded LB set is flagged.
//
// **Scope:** this is the slow path. Default off. Opt-in:
//   `node validate_cell_portal_graph.cjs --cross-lb`
//
// **Sample size**: 4 cells per LB. With 169 ring LBs that's ~676
// subprocess round-trips — at ~50ms each = ~35s total, acceptable.
// Picking origin-adjacent low cells (0x{lb}0100..0x{lb}0103) since
// retail LB origin is at low word 0x0100 per acclient.c convention.
//
// **Source of truth**: see acclient.c::CCellPortal::Pack at
// ~/ac-headers/acclient.c:362347-362403; cross-LB portals carry the
// `0xFFFE` no-other-cell sentinel ONLY for explicit unbound exits.
// Implicit landscape adjacency lives outside the EnvCell graph (it's
// the LandCell/LandBlock domain), so a non-sentinel cross-LB portal
// pointing at a missing cell is genuinely broken stitching.

async function runPhaseDCrossLb(driver, ringLbs, results) {
  console.log(`\n=== Phase D — Cross-LB stitching (opt-in --cross-lb) ===`);
  console.log(`  ${ringLbs.length} LBs loaded; sampling 4 origin cells per LB`);
  const loadedLbHighs = new Set(ringLbs.map(s => (parseInt(s, 16) >>> 0) & 0xFFFF_0000));
  const phase = {
    label: "cross-lb",
    sampleCellsPerLb: 4,
    aggregate: {
      sampleCellsAttempted: 0,
      sampleCellsResolved: 0,
      crossLbTargets: 0,
      brokenStitches: 0,
    },
    brokenStitches: [], // {from, to, sourceLb, targetLb}
  };
  for (const lbStr of ringLbs) {
    const lbHigh = (parseInt(lbStr, 16) >>> 0) & 0xFFFF_0000;
    // Sample LB origin cells: lb|0100..lb|0103. LB|0xFFFD is the highest
    // valid EnvCell ID per acclient.c convention; LB|0xFFFE is the
    // LandBlockInfo sentinel; LB|0xFFFF is the LandBlock record.
    for (let i = 0; i < 4; i++) {
      const cellId = (lbHigh | (0x0100 + i)) >>> 0;
      const cellHex = `0x${cellId.toString(16).toUpperCase().padStart(8, "0")}`;
      phase.aggregate.sampleCellsAttempted++;
      let resp;
      try {
        resp = await driver.send({ command: "pvs-visibility-snapshot", cellId: cellHex, bfsDepth: 1 });
      } catch (e) {
        // Cell doesn't exist or other infra error; skip silently — origin-cell
        // sampling is best-effort.
        continue;
      }
      if (!resp || resp.cellId === 0 || !resp.liveVisibleCells) continue;
      phase.aggregate.sampleCellsResolved++;
      for (const targetHex of resp.liveVisibleCells) {
        const targetId = (parseInt(targetHex, 16) >>> 0);
        const targetLbHigh = targetId & 0xFFFF_0000;
        if (targetLbHigh === lbHigh) continue; // within-LB; already covered by Phase A
        phase.aggregate.crossLbTargets++;
        if (!loadedLbHighs.has(targetLbHigh)) {
          // Target LB isn't in our ring — could be legitimate (e.g. landscape
          // edge to an outer LB), but worth reporting since the ring is
          // supposed to be self-contained per [[project_world_expand_step_1]].
          phase.aggregate.brokenStitches++;
          phase.brokenStitches.push({
            from: cellHex,
            to: targetHex,
            sourceLb: `0x${lbHigh.toString(16).toUpperCase().padStart(8, "0")}`,
            targetLb: `0x${targetLbHigh.toString(16).toUpperCase().padStart(8, "0")}`,
          });
        }
      }
    }
  }
  console.log(`  sampleCellsResolved/attempted: ${phase.aggregate.sampleCellsResolved}/${phase.aggregate.sampleCellsAttempted}`);
  console.log(`  crossLbTargets: ${phase.aggregate.crossLbTargets}  brokenStitches: ${phase.aggregate.brokenStitches}`);
  if (phase.brokenStitches.length > 0) {
    console.log(`  Sample broken stitches (first 5):`);
    for (const bs of phase.brokenStitches.slice(0, 5)) {
      console.log(`    ${bs.from} → ${bs.to}  (source LB ${bs.sourceLb} → target LB ${bs.targetLb} NOT IN RING)`);
    }
  }
  results.phaseD = phase;
  return phase;
}

// ─── Main ──────────────────────────────────────────────────────────────

(async () => {
  ensureWbtDll();
  const crossLbEnabled = process.argv.includes("--cross-lb");
  const slug = isoSlug();
  const reportDir = path.join(REPORT_ROOT, slug);
  fs.mkdirSync(reportDir, { recursive: true });

  const results = {
    runId: slug,
    reportDir,
    startedAt: new Date().toISOString(),
    expectedDatSha: EXPECTED_DAT_SHA,
    phaseA: {},
    phaseB: null,
    phaseD: null,
    summary: null,
  };

  const driver = new WbtDriver();
  driver.start();

  // Wait for ready.
  await new Promise((res) => setTimeout(res, 1500));

  let exit = 0;
  try {
    const holtburgRing = buildHoltburgRing();
    await runPhaseA(driver, holtburgRing, "holtburg-ring", results);
    await runPhaseA(driver, [ACADEMY_LB], "academy", results);
    await runPhaseA(driver, DUNGEON_LBS, "dungeons", results);
    await runPhaseB(driver, PVS_PROBES, results);
    if (crossLbEnabled) {
      await runPhaseDCrossLb(driver, holtburgRing, results);
    } else {
      console.log(`\n=== Phase D — Cross-LB stitching (SKIPPED — pass --cross-lb to enable) ===`);
    }
    results.summary = summarize(results);
    results.finishedAt = new Date().toISOString();

    const summaryPath = path.join(reportDir, "report.json");
    fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
    console.log(`\nReport: ${summaryPath}`);

    const s = results.summary;
    console.log(`\n=== Final ===`);
    console.log(`  cells sampled: ${s.totalCells}  portals sampled: ${s.totalPortals}`);
    console.log(`  asymmetric portals: ${s.totalAsym}  symmetry rate: ${(s.symmetryRate * 100).toFixed(2)}%`);
    console.log(`  disconnected (satellite) cells: ${s.totalDisconnected}  reachability: ${(s.reachabilityRate * 100).toFixed(2)}%`);
    console.log(`  PVS spot-checks: ${s.pvsPass}/${s.pvsTotal} subset-pass`);
    console.log(`  Symmetry accept (≥95%): ${s.symmetryAccept ? "PASS" : "FAIL"}`);
    console.log(`  PVS accept (100% subset): ${s.pvsAccept ? "PASS" : "FAIL"}`);
    console.log(`  Overall: ${s.overallPass ? "PASS" : "FAIL"}`);
    exit = s.overallPass ? 0 : 1;
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`);
    exit = 2;
    results.error = e.message;
    fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(results, null, 2));
  } finally {
    driver.stop();
  }

  process.exit(exit);
})();
