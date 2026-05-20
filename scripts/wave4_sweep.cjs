#!/usr/bin/env node
// wave4_sweep.cjs — Wave 4.E parallel sweep orchestrator.
//
// **What this tool does:** drives the four W4 chunk commands shipped by
// sibling agents (`chorizite-decode-surface-chunk`,
// `chorizite-decode-texture-chain-chunk`, `mesh-vs-obj-export-chunk`,
// `env-cell-vs-setup-model-chunk`) across the whole-DAT record space.
// Splits each target's record range into ~30 chunks of ~500 IDs and
// dispatches them 4-wide in parallel through a long-lived
// `WorldBuilder.Terminal --stdin` subprocess.
//
// **Why this exists:** plan §6 Wave 4 W4.E. Per-record validation of every
// retail Surface / Texture / GfxObj / EnvCell is multi-hour the first time;
// the sha-keyed result cache at
// `/mnt/wbterminal1/holtburger-validator-fixtures/wave4/<chunk-id>/progress.json`
// makes warm runs ~O(0). Operators kick this off via the
// `wave4-sweep` WB.Terminal JSON command (or directly via `node`).
//
// **Architecture decisions** (per plan §6 W4.E row):
//   - Sha-keyed cache lives on /mnt/wbterminal1 (NOT /, which is at ~94%).
//   - 4-wide concurrency by default; bounded so we don't trash the WB.Terminal
//     stdin loop or oversubscribe the GTX 1070.
//   - Chunked execution: per-chunk progress.json lets us resume after kill.
//   - Reports per-chunk INFRA gracefully if the sibling chunk command is
//     not yet implemented in WB.Terminal. The orchestrator never fakes
//     PASS — it returns INFRA + an explanatory message so the operator
//     can see "Wave 4 isn't all the way live yet" at a glance.
//
// **Exit codes:**
//   - 0 : all chunks across all targets PASS (or were cached hits)
//   - 1 : at least one chunk FAIL (real drift surfaced)
//   - 2 : infra error (driver itself broke; no chunks completed cleanly,
//         or the WB.Terminal binary can't be found, or all chunks are
//         INFRA because the chunk commands aren't wired yet)
//
// **Run:**
//   node scripts/wave4_sweep.cjs                          # fast mode, all targets, 4-wide
//   node scripts/wave4_sweep.cjs --mode=full              # whole-DAT sweep
//   node scripts/wave4_sweep.cjs --target=surface         # one validator
//   node scripts/wave4_sweep.cjs --reset                  # rebuild cache from scratch
//   node scripts/wave4_sweep.cjs --resume                 # default; explicit flag
//   node scripts/wave4_sweep.cjs --concurrency=2          # back off if box is busy
//   node scripts/wave4_sweep.cjs --chunk-size=250         # finer chunking
//   node scripts/wave4_sweep.cjs --report-dir=/tmp/x      # override aggregate dir
//
// **See also:**
//   - Plan: docs/diagnostic-toolset-plan-2026-05-19.md §6 Wave 4 W4.E
//   - Cache layout: /mnt/wbterminal1/holtburger-validator-fixtures/wave4/
//     <target>/<startId>-<endId>/progress.json
//   - Aggregate: /mnt/wbterminal1/holtburger-validator-reports/wave4/<ts>/
//     sweep-report.json + summary.md + logs/<target>-<chunk>.log

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// ─── Constants ──────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURES_ROOT = "/mnt/wbterminal1/holtburger-validator-fixtures/wave4";
const REPORTS_ROOT = "/mnt/wbterminal1/holtburger-validator-reports/wave4";

// Targets mirror the four sibling chunk commands listed in plan §5 rows
// 13-16. Each target points at:
//   - the WB.Terminal JSON command name (sibling agents own these)
//   - the DAT file + DBObj type to enumerate against
//     (used by `chorizite-list-dat-records` to discover the ID space)
//   - the holtburger-side fast subset (so --mode=fast can avoid the
//     whole-DAT scan)
const TARGETS = [
  {
    name: "surface",
    command: "chorizite-decode-surface-chunk",
    datPath: path.join(REPO_ROOT, "dats/base/client_portal.dat"),
    datFallback: "/home/wbterminal/ac_base_dats/client_portal.dat",
    typeName: "Surface",
    fastSubsetKey: "surfaces",
    notes: "W4.A — Surface→pixel decode parity (Chorizite oracle vs wasm fetch_surface_pixels).",
  },
  {
    name: "texture-chain",
    command: "chorizite-decode-texture-chain-chunk",
    datPath: path.join(REPO_ROOT, "dats/base/client_portal.dat"),
    datFallback: "/home/wbterminal/ac_base_dats/client_portal.dat",
    // DRW exposes textures as the `RenderTexture` DBObj type (the Surface
    // wrapper around a raw Texture). The plan talks about a
    // Surface→SurfaceTexture→Texture chain — the sibling chunk command
    // walks that chain internally; we enumerate on RenderTexture which
    // is the canonical ID-space DRW exposes.
    typeName: "RenderTexture",
    fastSubsetKey: "textures",
    notes: "W4.B — Surface→SurfaceTexture→Texture chain mean-RGBA parity.",
  },
  {
    name: "mesh",
    command: "mesh-vs-obj-export-chunk",
    datPath: path.join(REPO_ROOT, "dats/base/client_portal.dat"),
    datFallback: "/home/wbterminal/ac_base_dats/client_portal.dat",
    typeName: "GfxObj",
    fastSubsetKey: "gfxObjs",
    notes: "W4.C — GfxObj + SetupModel triangulation parity vs obj-export.",
  },
  {
    name: "env-cell",
    command: "env-cell-vs-setup-model-chunk",
    datPath: path.join(REPO_ROOT, "dats/base/client_cell_1.dat"),
    datFallback: "/home/wbterminal/ac_base_dats/client_cell_1.dat",
    typeName: "EnvCell",
    fastSubsetKey: "envCells",
    notes: "W4.D — EnvCell layout parity (acclient.c::CEnvCell oracle).",
  },
];

// Holtburg 81-model subset (per [[project_holtburg_h2_h3_done_2026-05-12]]).
// Used by --mode=fast to avoid the whole-DAT scan. Each list is the set of
// IDs to validate when fast-mode is on. Keys match TARGETS[*].fastSubsetKey.
//
// **Why hardcoded here:** the canonical 81-model list lives in the
// holtburger-web index.html ScenerySupport routine (per the grep hit
// `index.html:3273`). It changes rarely; we mirror the IDs the renderer
// touches at Holtburg-cottage and academy LBs. Empty lists fall through to
// a small head-of-DAT sample as a "least-bad" fast mode.
//
// Future enhancement: subprocess `chorizite-list-dat-records` first with a
// `--holtburg-subset` flag (when sibling adds one), instead of hardcoding.
const HOLTBURG_FAST_SUBSET = {
  // Surface IDs referenced by the Holtburger renderer's hot path. The
  // 81 figure refers to *models*; surfaces are higher-multiplicity. We
  // keep a small validating slice here; sibling agents may widen.
  surfaces: [], // empty → small head-of-DAT sample (see resolveTargetIds)
  textures: [],
  gfxObjs: [], // would be 81 entries once sibling agent populates
  envCells: [], // Academy has 568, Holtburg has 123; sibling owns the subset
};

// ─── CLI parsing ────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const out = {
    mode: "fast",
    target: "all",
    concurrency: 4,
    chunkSize: 500,
    resume: true,
    reset: false,
    reportDir: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a.startsWith("--mode=")) {
      const v = a.slice("--mode=".length);
      if (v !== "fast" && v !== "full") {
        console.error(`FAIL: --mode expects fast|full; got '${v}'`);
        process.exit(2);
      }
      out.mode = v;
    } else if (a.startsWith("--target=")) {
      const v = a.slice("--target=".length);
      const ok = new Set(["all", ...TARGETS.map((t) => t.name)]);
      if (!ok.has(v)) {
        console.error(`FAIL: --target expects one of ${[...ok].join("|")}; got '${v}'`);
        process.exit(2);
      }
      out.target = v;
    } else if (a.startsWith("--concurrency=")) {
      const n = parseInt(a.slice("--concurrency=".length), 10);
      if (!Number.isFinite(n) || n < 1 || n > 32) {
        console.error(`FAIL: --concurrency expects an int in [1,32]; got '${a}'`);
        process.exit(2);
      }
      out.concurrency = n;
    } else if (a.startsWith("--chunk-size=")) {
      const n = parseInt(a.slice("--chunk-size=".length), 10);
      if (!Number.isFinite(n) || n < 16 || n > 10000) {
        console.error(`FAIL: --chunk-size expects an int in [16,10000]; got '${a}'`);
        process.exit(2);
      }
      out.chunkSize = n;
    } else if (a === "--reset") {
      out.reset = true;
      out.resume = false;
    } else if (a === "--resume") {
      out.resume = true;
      out.reset = false;
    } else if (a.startsWith("--report-dir=")) {
      out.reportDir = a.slice("--report-dir=".length);
    } else {
      console.error(`FAIL: unknown argument '${a}'`);
      process.exit(2);
    }
  }
  return out;
}

function printUsage() {
  console.log(`wave4_sweep.cjs — Wave 4.E parallel sweep orchestrator`);
  console.log(``);
  console.log(`Usage: node scripts/wave4_sweep.cjs [options]`);
  console.log(``);
  console.log(`Options:`);
  console.log(`  --mode=fast|full       Default: fast`);
  console.log(`                         fast = Holtburg 81-model subset (sub-sec)`);
  console.log(`                         full = whole-DAT sweep (multi-hour first pass)`);
  console.log(`  --target=NAME          Default: all`);
  console.log(`                         One of: ${TARGETS.map((t) => t.name).join("|")}|all`);
  console.log(`  --concurrency=N        Default: 4 (1-32 valid)`);
  console.log(`  --chunk-size=N         Default: 500`);
  console.log(`  --resume               Default behavior; reads chunk cache.`);
  console.log(`  --reset                Wipe cache; do not consult prior progress.`);
  console.log(`  --report-dir=PATH      Override aggregate output dir`);
  console.log(``);
  console.log(`Cache layout:`);
  console.log(`  ${FIXTURES_ROOT}/<target>/<startId>-<endId>/progress.json`);
  console.log(`Reports layout:`);
  console.log(`  ${REPORTS_ROOT}/<ts>/sweep-report.json`);
  console.log(``);
  console.log(`Exit codes: 0 = all PASS / cached, 1 = at least one FAIL, 2 = infra`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isoSlug(d = new Date()) {
  return d.toISOString().replace(/\.[0-9]{3}Z$/, "Z").replace(/:/g, "-");
}

function mkdirpSync(p) {
  fs.mkdirSync(p, { recursive: true });
}

function rmrfSync(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function resolveTerminalBinary() {
  // Prefer the .dll launched via `dotnet`. The native apphost requires a
  // matching .NET 8 shared runtime at a specific path; on this box the
  // dotnet SDK is v10 and the apphost resolver fails to find libhostfxr.
  // `dotnet WorldBuilder.Terminal.dll` rolls forward automatically.
  const env = process.env.WORLDBUILDER_TERMINAL;
  if (env && fs.existsSync(env)) return env;

  const releaseDll = path.join(
    REPO_ROOT,
    "WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll",
  );
  if (fs.existsSync(releaseDll)) return releaseDll;

  const debugDll = path.join(
    REPO_ROOT,
    "WorldBuilder.Terminal/bin/Debug/net8.0/WorldBuilder.Terminal.dll",
  );
  if (fs.existsSync(debugDll)) return debugDll;

  // Last-resort: the native apphost. Only useful on boxes where the .NET
  // 8 shared runtime is in a standard search location.
  const releaseExe = path.join(
    REPO_ROOT,
    "WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal",
  );
  if (fs.existsSync(releaseExe)) return releaseExe;

  return null;
}

function resolveTargetDatPath(target) {
  if (fs.existsSync(target.datPath)) return target.datPath;
  if (fs.existsSync(target.datFallback)) return target.datFallback;
  return null;
}

// ─── WB.Terminal stdin worker ──────────────────────────────────────────────
//
// Spawns one long-lived `WorldBuilder.Terminal --stdin` subprocess per
// worker. Each worker pulls a chunk off the shared queue, writes one
// JSON line, reads one JSON line, repeats. The line-pair pattern matches
// the protocol shape declared in JsonCommandProcessor.RunStdinLoop.
//
// **Why long-lived subprocesses instead of one-shot spawns:** WB.Terminal
// pays ~1-3 seconds of startup (project preload, Chorizite type index
// reflection, etc). For 30+ chunks per target, 4 workers × 1 startup is
// much cheaper than 120 × startup.

class TerminalWorker {
  constructor(workerId, binary, log) {
    this.workerId = workerId;
    this.binary = binary;
    this.log = log;
    this.proc = null;
    this.stdoutBuf = "";
    this.pendingResolve = null;
    this.pendingReject = null;
    this.stderrTail = [];
    this.startupReady = null;
    this.dead = false;
  }

  async start() {
    let cmd, args;
    if (this.binary.endsWith(".dll")) {
      cmd = "dotnet";
      args = [this.binary, "--stdin"];
    } else {
      cmd = this.binary;
      args = ["--stdin"];
    }
    this.proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: REPO_ROOT,
    });
    // Pre-attach EPIPE swallower; if the worker dies mid-write we'd
    // otherwise crash node with an unhandled "error" event on the
    // stdin Socket.
    this.proc.stdin.on("error", (err) => {
      // EPIPE is expected after child exit; everything else surfaces
      // via the exit handler.
      if (err && err.code === "EPIPE") return;
    });
    this.startupReady = new Promise((resolve, reject) => {
      const readyHandler = (line) => {
        try {
          const obj = JSON.parse(line);
          if (obj.command === "ready") {
            resolve();
            return true;
          }
        } catch (_) {
          /* not yet a JSON line; keep buffering */
        }
        return false;
      };
      // Hook up the first-line handler.
      this.firstLineHandler = readyHandler;
      this.startupReject = reject;
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk) => {
      this.stdoutBuf += chunk;
      while (true) {
        const idx = this.stdoutBuf.indexOf("\n");
        if (idx < 0) break;
        const line = this.stdoutBuf.slice(0, idx).trim();
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
        if (!line) continue;
        if (this.firstLineHandler) {
          if (this.firstLineHandler(line)) {
            this.firstLineHandler = null;
            continue;
          }
        }
        if (this.pendingResolve) {
          const r = this.pendingResolve;
          this.pendingResolve = null;
          this.pendingReject = null;
          r(line);
        }
        // Otherwise drop the line; unexpected output without a pending request.
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      this.stderrTail.push(String(chunk));
      // Keep the last ~8 KB.
      let total = this.stderrTail.reduce((s, x) => s + x.length, 0);
      while (total > 8192 && this.stderrTail.length > 1) {
        total -= this.stderrTail[0].length;
        this.stderrTail.shift();
      }
    });

    this.proc.on("exit", (code) => {
      this.dead = true;
      if (this.pendingReject) {
        this.pendingReject(
          new Error(
            `WB.Terminal worker ${this.workerId} exited with code=${code}; stderr-tail=${this.stderrTail.join("")}`,
          ),
        );
        this.pendingResolve = null;
        this.pendingReject = null;
      }
      if (this.startupReject) {
        this.startupReject(
          new Error(
            `WB.Terminal worker ${this.workerId} exited before "ready" (code=${code}); stderr-tail=${this.stderrTail.join("")}`,
          ),
        );
        this.startupReject = null;
      }
    });

    this.proc.on("error", (err) => {
      this.dead = true;
      if (this.startupReject) {
        this.startupReject(err);
        this.startupReject = null;
      }
    });

    // Wait for ready.
    await Promise.race([
      this.startupReady,
      new Promise((_, rej) =>
        setTimeout(
          () => rej(new Error(`WB.Terminal worker ${this.workerId} startup timed out at 30s`)),
          30_000,
        ),
      ),
    ]);
  }

  async invoke(command, fields, timeoutMs) {
    if (this.dead || !this.proc) {
      throw new Error(`WB.Terminal worker ${this.workerId} is dead; cannot dispatch ${command}`);
    }
    if (this.pendingResolve) {
      throw new Error(`worker ${this.workerId} double-dispatch`);
    }
    const payload = JSON.stringify({ command, ...fields });
    const responsePromise = new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
    });
    this.proc.stdin.write(payload + "\n");
    const reply = await Promise.race([
      responsePromise,
      new Promise((_, rej) =>
        setTimeout(
          () => rej(new Error(`worker ${this.workerId} ${command} timed out at ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
    try {
      return JSON.parse(reply);
    } catch (e) {
      throw new Error(`worker ${this.workerId} got non-JSON reply: ${reply.slice(0, 200)}`);
    }
  }

  async shutdown() {
    if (!this.proc || this.dead) return;
    // Silence the EPIPE that may arrive between "child has exited" and
    // "node has noticed" — the on('exit') handler is async.
    try {
      this.proc.stdin.on("error", () => { /* swallow EPIPE */ });
    } catch (_) {}
    try {
      if (this.proc.stdin && !this.proc.stdin.destroyed) {
        this.proc.stdin.write(JSON.stringify({ command: "quit" }) + "\n");
        this.proc.stdin.end();
      }
    } catch (_) {
      /* swallow */
    }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          this.proc.kill("SIGKILL");
        } catch (_) {}
        resolve();
      }, 5_000);
      this.proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

// ─── Chunk / target resolution ──────────────────────────────────────────────

// Note: a half-open chunkRange(start, end, chunkSize) helper was planned
// but replaced by inline range arithmetic in `enumerateChunksForTarget`.
// Re-introduce if a target ever needs non-uniform chunking.

function chunkLabel(target, chunk) {
  return `${target.name}/${chunk.startId.toString(16).padStart(8, "0")}-${chunk.endId.toString(16).padStart(8, "0")}`;
}

function chunkCacheDir(target, chunk) {
  return path.join(
    FIXTURES_ROOT,
    target.name,
    `${chunk.startId.toString(16).padStart(8, "0")}-${chunk.endId.toString(16).padStart(8, "0")}`,
  );
}

async function discoverTargetIds(worker, target, mode, _log) {
  // Mode=fast: prefer the Holtburg subset; fall back to a small
  // head-of-DAT sample to avoid scanning whole DATs.
  if (mode === "fast") {
    const subset = HOLTBURG_FAST_SUBSET[target.fastSubsetKey];
    if (subset && subset.length > 0) {
      return {
        ok: true,
        ids: subset.slice().sort((a, b) => a - b),
        rangeStart: subset[0],
        rangeEnd: subset[subset.length - 1] + 1,
        source: "holtburg-subset",
      };
    }
    // No hardcoded subset → small head-of-DAT scan via list-dat-records.
    // Falls through to the same path as full mode but we'll cap the list
    // to ~256 IDs total below.
  }

  const datPath = resolveTargetDatPath(target);
  if (!datPath) {
    return {
      ok: false,
      reason: `INFRA: DAT file not found at ${target.datPath} (fallback ${target.datFallback}).`,
    };
  }

  try {
    const reply = await worker.invoke(
      "chorizite-list-dat-records",
      { datPath, typeName: target.typeName },
      120_000,
    );
    if (!reply || reply.success !== true) {
      return {
        ok: false,
        reason: `INFRA: chorizite-list-dat-records failed: ${JSON.stringify(reply).slice(0, 240)}`,
      };
    }
    const records = (reply.records || []).map((r) => r.id).sort((a, b) => a - b);
    if (records.length === 0) {
      return {
        ok: false,
        reason: `INFRA: chorizite-list-dat-records returned 0 records for ${target.typeName} in ${datPath}.`,
      };
    }
    // Reject 0x__FFxxxx modder-range IDs per
    // [[feedback_base_dats_only_for_bake]] discipline.
    const baseOnly = records.filter((id) => ((id >>> 16) & 0xff) !== 0xff || id === 0xffff0000);
    let ids = baseOnly;
    if (mode === "fast") {
      // Small head-of-DAT cap so fast mode genuinely returns sub-second.
      ids = baseOnly.slice(0, 256);
    }
    return {
      ok: true,
      ids,
      rangeStart: ids[0],
      rangeEnd: ids[ids.length - 1] + 1,
      source: mode === "fast" ? "head-sample" : "whole-dat",
    };
  } catch (e) {
    return {
      ok: false,
      reason: `INFRA: list-dat-records threw: ${e.message}`,
    };
  }
}

function chunksFromIds(ids, chunkSize) {
  // Return half-open [startId, endId) chunks where each chunk contains
  // up to chunkSize IDs from the supplied list. We use sliced ranges so
  // chunk commands can take (startId, endId) per-record and skip
  // missing IDs internally.
  if (ids.length === 0) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize);
    out.push({ startId: slice[0], endId: slice[slice.length - 1] + 1, ids: slice });
  }
  return out;
}

// ─── Dispatching one chunk ──────────────────────────────────────────────────

async function dispatchOneChunk(worker, target, chunk, runOptions, _log) {
  const cacheDir = chunkCacheDir(target, chunk);
  const progressPath = path.join(cacheDir, "progress.json");

  if (runOptions.resume && fs.existsSync(progressPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(progressPath, "utf8"));
      if (cached && cached.status && cached.status !== "INFLIGHT") {
        return { ...cached, fromCache: true, cacheDir, progressPath };
      }
    } catch (_) {
      /* fall through and re-dispatch */
    }
  }

  if (runOptions.reset && fs.existsSync(cacheDir)) {
    try {
      rmrfSync(cacheDir);
    } catch (_) {}
  }
  mkdirpSync(cacheDir);

  // Mark in-flight on disk so a crashed sweep can be picked up.
  const inFlight = {
    target: target.name,
    command: target.command,
    startId: chunk.startId,
    endId: chunk.endId,
    status: "INFLIGHT",
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(progressPath, JSON.stringify(inFlight, null, 2));

  // Dispatch the chunk command. If the sibling agent hasn't shipped it
  // yet, the dispatch dictionary lookup returns "Unknown command: ..."
  // and we record INFRA gracefully.
  const t0 = Date.now();
  let reply;
  try {
    reply = await worker.invoke(
      target.command,
      {
        datPath: resolveTargetDatPath(target),
        startId: chunk.startId,
        endId: chunk.endId,
        cacheDir,
        mode: runOptions.mode,
      },
      // 10-minute per-chunk timeout — chunks are 500 records each;
      // even with disk-cold reads this should land in a minute or two.
      600_000,
    );
  } catch (e) {
    const out = {
      target: target.name,
      command: target.command,
      startId: chunk.startId,
      endId: chunk.endId,
      status: "INFRA",
      infraError: `Dispatch threw: ${e.message}`,
      elapsedMs: Date.now() - t0,
      finishedAt: new Date().toISOString(),
    };
    fs.writeFileSync(progressPath, JSON.stringify(out, null, 2));
    return { ...out, fromCache: false, cacheDir, progressPath };
  }
  const elapsedMs = Date.now() - t0;

  // Reply shape: WB.Terminal returns { success: bool, command: string, ... }
  // for known commands; { success: false, command: <name>, error: "Unknown
  // command: '<name>'" } for unknown ones.
  let status, infraError, mismatchCount, cacheHit, cacheMiss, message;
  if (!reply || typeof reply !== "object") {
    status = "INFRA";
    infraError = "Reply was not an object";
  } else if (reply.success === false) {
    const e = (reply.error || "").toString();
    if (/^Unknown command:/i.test(e)) {
      status = "INFRA";
      infraError = `Sibling chunk command '${target.command}' not yet wired into WB.Terminal dispatch table. Skipping target gracefully.`;
    } else {
      // The sibling's chunk command exists but errored out. Treat as
      // FAIL (real drift, will resolve via root-cause), not INFRA.
      status = "FAIL";
      message = e;
    }
  } else {
    // Success path. We accept either an explicit summary block or fall
    // through to "PASS" with no detail.
    status = (reply.status || "PASS").toString().toUpperCase();
    mismatchCount = reply.mismatchCount ?? reply.failedRecords ?? null;
    cacheHit = reply.cacheHits ?? null;
    cacheMiss = reply.cacheMisses ?? null;
    message = reply.message || null;
  }

  const out = {
    target: target.name,
    command: target.command,
    startId: chunk.startId,
    endId: chunk.endId,
    status,
    mismatchCount,
    cacheHit,
    cacheMiss,
    infraError,
    message,
    elapsedMs,
    startedAt: inFlight.startedAt,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(progressPath, JSON.stringify(out, null, 2));
  return { ...out, fromCache: false, cacheDir, progressPath };
}

// ─── Concurrency pool ───────────────────────────────────────────────────────

async function runPool(workQueue, workers, runOptions, log) {
  // Round-robin assignment, but with worker-affinity: a worker is freed
  // back into a pool array when it finishes; the dispatcher pops one off
  // and pushes it back when done.
  const idle = workers.slice();
  const inFlight = new Set();
  const completed = [];

  function nextWorker() {
    return idle.pop();
  }

  async function pump() {
    while (workQueue.length > 0 && idle.length > 0) {
      const job = workQueue.shift();
      const worker = nextWorker();
      const promise = (async () => {
        try {
          const result = await dispatchOneChunk(worker, job.target, job.chunk, runOptions, log);
          completed.push(result);
          log.line(
            `[chunk ${chunkLabel(job.target, job.chunk)}] ${result.status}` +
              (result.fromCache ? " (cache)" : "") +
              (result.mismatchCount != null ? ` mismatches=${result.mismatchCount}` : "") +
              ` in ${result.elapsedMs ?? 0}ms`,
          );
        } catch (e) {
          completed.push({
            target: job.target.name,
            command: job.target.command,
            startId: job.chunk.startId,
            endId: job.chunk.endId,
            status: "INFRA",
            infraError: `pool threw: ${e.message}`,
          });
          log.line(`[chunk ${chunkLabel(job.target, job.chunk)}] INFRA pool threw: ${e.message}`);
        } finally {
          inFlight.delete(promise);
          idle.push(worker);
          // Spin pump again — there may be more jobs queued.
          pump();
        }
      })();
      inFlight.add(promise);
    }
  }

  // Prime + drain.
  pump();
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
  }
  return completed;
}

// ─── Aggregate / report writer ──────────────────────────────────────────────

function summarizeChunks(results) {
  const summary = {
    chunkCount: results.length,
    passed: 0,
    failed: 0,
    infra: 0,
    cached: 0,
    cacheHits: 0,
    cacheMisses: 0,
    perTarget: {},
  };
  for (const r of results) {
    if (r.fromCache) summary.cached++;
    if (r.cacheHit != null) summary.cacheHits += r.cacheHit;
    if (r.cacheMiss != null) summary.cacheMisses += r.cacheMiss;
    const bucket =
      summary.perTarget[r.target] || (summary.perTarget[r.target] = {
        chunks: 0, passed: 0, failed: 0, infra: 0,
      });
    bucket.chunks++;
    if (r.status === "PASS") {
      summary.passed++;
      bucket.passed++;
    } else if (r.status === "FAIL") {
      summary.failed++;
      bucket.failed++;
    } else if (r.status === "INFRA") {
      summary.infra++;
      bucket.infra++;
    }
  }
  return summary;
}

function writeAggregateReport(reportDir, options, targets, results, elapsedMs) {
  mkdirpSync(reportDir);
  const summary = summarizeChunks(results);
  const aggregate = {
    schema: "wave4-sweep/1",
    options,
    targets: targets.map((t) => ({
      name: t.name,
      command: t.command,
      notes: t.notes,
      datPath: t.datPath,
    })),
    summary,
    chunks: results.map((r) => ({
      target: r.target,
      command: r.command,
      startId: r.startId,
      endId: r.endId,
      status: r.status,
      fromCache: !!r.fromCache,
      mismatchCount: r.mismatchCount ?? null,
      cacheHit: r.cacheHit ?? null,
      cacheMiss: r.cacheMiss ?? null,
      infraError: r.infraError ?? null,
      message: r.message ?? null,
      elapsedMs: r.elapsedMs ?? null,
    })),
    cacheRoot: FIXTURES_ROOT,
    reportDir,
    elapsedMs,
    finishedAt: new Date().toISOString(),
  };
  const aggregatePath = path.join(reportDir, "sweep-report.json");
  fs.writeFileSync(aggregatePath, JSON.stringify(aggregate, null, 2));

  const md = renderSummaryMarkdown(aggregate);
  const mdPath = path.join(reportDir, "summary.md");
  fs.writeFileSync(mdPath, md);
  return { aggregatePath, mdPath, summary };
}

function renderSummaryMarkdown(aggregate) {
  const s = aggregate.summary;
  const lines = [];
  lines.push("# Wave 4 Sweep Report");
  lines.push("");
  lines.push(`**Run finished:** ${aggregate.finishedAt}`);
  lines.push(`**Mode:** ${aggregate.options.mode}`);
  lines.push(`**Target:** ${aggregate.options.target}`);
  lines.push(`**Concurrency:** ${aggregate.options.concurrency}`);
  lines.push(`**Chunk size:** ${aggregate.options.chunkSize}`);
  lines.push(`**Elapsed:** ${aggregate.elapsedMs}ms`);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push(`- chunks:   ${s.chunkCount}`);
  lines.push(`- passed:   ${s.passed}`);
  lines.push(`- failed:   ${s.failed}`);
  lines.push(`- infra:    ${s.infra}`);
  lines.push(`- cached:   ${s.cached}`);
  lines.push(`- cacheHits:   ${s.cacheHits}`);
  lines.push(`- cacheMisses: ${s.cacheMisses}`);
  lines.push("");
  lines.push("## Per-target");
  lines.push("");
  lines.push("| target | chunks | passed | failed | infra |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const [name, t] of Object.entries(s.perTarget)) {
    lines.push(`| ${name} | ${t.chunks} | ${t.passed} | ${t.failed} | ${t.infra} |`);
  }
  lines.push("");
  lines.push("## Cache layout");
  lines.push("");
  lines.push(`Result cache: \`${aggregate.cacheRoot}/<target>/<startId>-<endId>/progress.json\``);
  return lines.join("\n") + "\n";
}

// ─── Logger ────────────────────────────────────────────────────────────────

function makeLogger(reportDir) {
  mkdirpSync(reportDir);
  const stream = fs.createWriteStream(path.join(reportDir, "sweep.log"), { flags: "a" });
  return {
    line(msg) {
      const ts = new Date().toISOString();
      const out = `[${ts}] ${msg}`;
      process.stdout.write(out + "\n");
      stream.write(out + "\n");
    },
    stream,
    close() {
      try { stream.end(); } catch (_) {}
    },
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const options = parseCliArgs(process.argv);
  if (options.help) {
    printUsage();
    process.exit(0);
  }

  const ts = isoSlug();
  const reportDir = options.reportDir || path.join(REPORTS_ROOT, ts);
  mkdirpSync(reportDir);
  const log = makeLogger(reportDir);
  log.line(`Wave 4 sweep starting (mode=${options.mode}, target=${options.target}, concurrency=${options.concurrency}, chunkSize=${options.chunkSize}, reset=${options.reset})`);

  const t0 = Date.now();
  // Pre-flight: locate WB.Terminal binary.
  const terminal = resolveTerminalBinary();
  if (!terminal) {
    log.line(`INFRA: WorldBuilder.Terminal binary not found. Set WORLDBUILDER_TERMINAL or run \`dotnet build WorldBuilder.Terminal -c Release\` first.`);
    const { aggregatePath } = writeAggregateReport(reportDir, options, [], [], Date.now() - t0);
    log.line(`Aggregate at: ${aggregatePath}`);
    log.close();
    process.exit(2);
  }
  log.line(`WB.Terminal binary: ${terminal}`);

  // Resolve targets.
  const targets =
    options.target === "all" ? TARGETS : TARGETS.filter((t) => t.name === options.target);
  if (targets.length === 0) {
    log.line(`INFRA: no targets matched '${options.target}'`);
    log.close();
    process.exit(2);
  }

  // Reset cache if requested.
  if (options.reset) {
    for (const t of targets) {
      const targetCacheDir = path.join(FIXTURES_ROOT, t.name);
      log.line(`reset: wiping cache at ${targetCacheDir}`);
      rmrfSync(targetCacheDir);
    }
  }

  // Spin up workers.
  const workerCount = Math.min(options.concurrency, 32);
  log.line(`Starting ${workerCount} WB.Terminal workers...`);
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    const w = new TerminalWorker(i, terminal, log);
    workers.push(w);
  }
  try {
    await Promise.all(workers.map((w) => w.start()));
  } catch (e) {
    log.line(`INFRA: worker startup failed: ${e.message}`);
    for (const w of workers) await w.shutdown();
    const { aggregatePath } = writeAggregateReport(reportDir, options, targets, [], Date.now() - t0);
    log.line(`Aggregate at: ${aggregatePath}`);
    log.close();
    process.exit(2);
  }

  // Build the work queue: discover IDs per target, then chunk.
  const queue = [];
  for (const target of targets) {
    log.line(`[target ${target.name}] discovering record IDs in ${target.datPath}...`);
    const disc = await discoverTargetIds(workers[0], target, options.mode, log);
    if (!disc.ok) {
      log.line(`[target ${target.name}] skipping: ${disc.reason}`);
      // Synthesize a chunk-shaped INFRA result so the report reflects
      // the skipped target.
      const chunk = { startId: 0, endId: 0, ids: [] };
      const cacheDir = chunkCacheDir(target, chunk);
      mkdirpSync(cacheDir);
      const out = {
        target: target.name,
        command: target.command,
        startId: 0,
        endId: 0,
        status: "INFRA",
        infraError: disc.reason,
        fromCache: false,
      };
      queue.push({ target, chunk, prefilled: out });
      continue;
    }
    const chunks = chunksFromIds(disc.ids, options.chunkSize);
    log.line(`[target ${target.name}] ${disc.ids.length} IDs / ${chunks.length} chunks (source=${disc.source})`);
    for (const chunk of chunks) {
      queue.push({ target, chunk });
    }
  }

  // Separate the prefilled INFRA entries from the actual dispatch jobs.
  const dispatchJobs = queue.filter((j) => !j.prefilled);
  const prefilled = queue.filter((j) => !!j.prefilled).map((j) => j.prefilled);
  log.line(`Dispatching ${dispatchJobs.length} chunks across ${workerCount} workers...`);

  const dispatched = await runPool(dispatchJobs, workers, options, log);
  const allResults = [...prefilled, ...dispatched];

  // Tear down.
  for (const w of workers) await w.shutdown();

  const elapsedMs = Date.now() - t0;
  const { aggregatePath, mdPath, summary } = writeAggregateReport(
    reportDir, options, targets, allResults, elapsedMs,
  );
  log.line(`Aggregate at: ${aggregatePath}`);
  log.line(`Summary at:   ${mdPath}`);
  log.line(
    `Result: chunks=${summary.chunkCount} pass=${summary.passed} fail=${summary.failed} infra=${summary.infra} cached=${summary.cached} in ${elapsedMs}ms`,
  );
  log.close();

  // Exit code:
  //   0 if everything PASS or cached
  //   1 if any FAIL
  //   2 if all chunks INFRA (driver itself broke or siblings not live)
  if (summary.failed > 0) process.exit(1);
  if (summary.passed === 0 && summary.cached === 0 && summary.infra > 0) process.exit(2);
  process.exit(0);
}

main().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message || e}`);
  process.exit(2);
});
