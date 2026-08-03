#!/usr/bin/env node
// validate_texture_decode.cjs — Wave 4.A + 4.B Surface chain / texture
// decode parity end-to-end driver.
//
// **What this tool does:** decodes every Surface in the half-open range
// `[startId, endId)` via Chorizite's DBObj chain (Surface → SurfaceTexture
// → RenderSurface → Palette → RGBA8) and tracks pass / fail per record.
// Two sub-modes:
//   - `--mode=fast` (default; ~81 Holtburg subset, sub-second; suitable for
//     diag-run-all CI signal): ≥80/81 PASS bar.
//   - `--mode=full` (whole portal-DAT sweep, ~6,152 Surface records;
//     out-of-band): ≥99.5% PASS bar (76 tolerance budget per plan §6 W4.A
//     palette-edge cases).
//
// Acceptance bars:
//   - PNG sha256: emitted into the sha-keyed cache; recomputed only when
//     `<surface_sha>.json` is missing (immutable-base-DAT discipline per
//     [[feedback_base_dats_only_for_bake]] means steady-state warm runs
//     are O(0) on the C# side).
//   - Mean RGBA: 4-channel float mean of the decoded pixels — the
//     textured-mean reduction the JS material decoder uses as a tint
//     fallback (see `phase-3-renderer.md` §4.5). Tolerance is ≤0.01 per
//     channel against the cached value for cached records.
//
// **Exit codes:**
//   - 0 : ≥80/81 PASS (fast) OR ≥99.5% PASS (full).
//   - 1 : Below acceptance bar (failures clustered into ≤5 root-cause
//         buckets per plan §6 Wave 4 expectations).
//   - 2 : Infra (WB.Terminal crash; build failure; cache root missing).
//
// **Run:**
//   `node validate_texture_decode.cjs`                  (fast mode)
//   `node validate_texture_decode.cjs --mode=full`      (whole DAT)
//   `node validate_texture_decode.cjs --emit-png`       (also write PNGs)
//   `WBT_DLL=/path node validate_texture_decode.cjs`    (custom dll path)
//   `WAVE4T_CACHE_ROOT=/tmp/foo node validate_texture_decode.cjs`
//
// **Layout:**
//   - C# subprocess: `$DOTNET_ROOT/dotnet ../../../../WorldBuilder.Terminal.dll --stdin`
//   - Cache root: `/mnt/wbterminal1/holtburger-validator-fixtures/wave4/`
//     under `surface/`, `png/`, `progress/` (per plan §6 Wave 4).
//   - Report dir: `/mnt/wbterminal1/holtburger-validator-reports/texture-decode/<ts>/`
//
// **Dispatch splice:** the JSON-stdin dispatch entries for
// `chorizite-decode-surface-chunk` + `chorizite-decode-texture-chain-chunk`
// are documented in `WorldBuilder.Terminal/WAVE4T_DISPATCH_PENDING.patch`.
// The dispatch may or may not be applied on the running build — this
// validator auto-detects via a `help` probe and:
//   1. If dispatch IS wired: runs end-to-end.
//   2. If dispatch is NOT wired AND the patch file exists AND the user
//      passed `--auto-splice`: transiently applies the patch, rebuilds,
//      runs, then reverts JsonCommandProcessor.cs. The build artifact is
//      left in place to support re-runs.
//   3. Otherwise: exits 2 (INFRA) with a clear "patch pending" message.
//
// **See also:**
//   - Method doc: `docs/texture-parity-method.md`
//   - Sibling validators: `validate_cell_portal_graph.cjs`, `validate_dat_parity.cjs`
//   - Engine partial: `WorldBuilder.Terminal/CommandEngine.TextureParity.cs`
//   - Dispatch patch: `WorldBuilder.Terminal/WAVE4T_DISPATCH_PENDING.patch`

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// ─── Paths + env ────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const WBT_DLL = process.env.WBT_DLL
  || path.join(REPO_ROOT, "WorldBuilder.Terminal", "bin", "Release", "net8.0", "WorldBuilder.Terminal.dll");
const DOTNET = process.env.DOTNET_ROOT
  ? path.join(process.env.DOTNET_ROOT, "dotnet")
  : (process.env.DOTNET
    || (fs.existsSync(path.join(process.env.HOME || "/", ".local/bin/dotnet"))
        ? path.join(process.env.HOME, ".local/bin/dotnet")
        : "dotnet"));
const DISPATCH_PATCH = path.join(
  REPO_ROOT, "WorldBuilder.Terminal", "WAVE4T_DISPATCH_PENDING.patch");
const JSON_DISPATCHER = path.join(
  REPO_ROOT, "WorldBuilder.Terminal", "JsonCommandProcessor.cs");
const REPORT_ROOT = "/mnt/wbterminal1/holtburger-validator-reports/texture-decode";
const CACHE_ROOT_DEFAULT = "/mnt/wbterminal1/holtburger-validator-fixtures/wave4";

const EXPECTED_DAT_SHA = "dc6e500ba22e6b186db7171e3f3345238b6444c85d798adc85e550973b8d12e4";
// client_portal.dat (per [[feedback_base_dats_only_for_bake]] sha; matches W2.B
// seeds.json fixture for cross-validator consistency).

// Surface range — the entire 0x08……  portal-DAT prefix per dats.xml:3692.
const SURFACE_FIRST_ID = 0x08000000;
const SURFACE_END_ID = 0x08010000;

// ─── CLI args ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    mode: "fast",
    emitPng: false,
    autoSplice: false,
    startId: SURFACE_FIRST_ID,
    endId: SURFACE_END_ID,
    chunkSize: 500,
    cacheRoot: process.env.WAVE4T_CACHE_ROOT || CACHE_ROOT_DEFAULT,
    // Count CACHED records toward the acceptance bar (the O(0) warm-replay
    // documented in the header). OFF by default: a replay decodes nothing, so
    // it cannot substantiate a PASS. See summarizeChunks().
    allowCached: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--emit-png") out.emitPng = true;
    else if (arg === "--allow-cached") out.allowCached = true;
    else if (arg === "--auto-splice") out.autoSplice = true;
    else if (arg === "--mode=fast") out.mode = "fast";
    else if (arg === "--mode=full") out.mode = "full";
    else if (arg.startsWith("--mode=")) out.mode = arg.substring("--mode=".length);
    else if (arg.startsWith("--start-id=")) out.startId = parseUInt(arg.split("=")[1]);
    else if (arg.startsWith("--end-id=")) out.endId = parseUInt(arg.split("=")[1]);
    else if (arg.startsWith("--chunk-size=")) out.chunkSize = parseInt(arg.split("=")[1], 10);
    else if (arg.startsWith("--cache-root=")) out.cacheRoot = arg.split("=")[1];
    else if (arg === "-h" || arg === "--help") {
      console.log(`validate_texture_decode.cjs — Wave 4.A + 4.B parity driver
Usage:
  node validate_texture_decode.cjs [--mode=fast|full] [--emit-png] [--auto-splice]
       [--start-id=0x08000000] [--end-id=0x08010000] [--chunk-size=500]
       [--cache-root=/mnt/wbterminal1/...] [--allow-cached]

  --allow-cached  Count CACHED records toward the bar. A cache hit returns
                  BEFORE the Chorizite decode, so it verifies nothing; without
                  this flag a fully-cached run FAILS (use a fresh --cache-root
                  to force real decodes). Marks the report verified:false.`);
      process.exit(0);
    }
  }
  if (out.mode !== "fast" && out.mode !== "full") {
    throw new Error(`Unknown --mode '${out.mode}' (expected fast|full)`);
  }
  return out;
}

function parseUInt(s) {
  return s.startsWith("0x") || s.startsWith("0X")
    ? parseInt(s.substring(2), 16)
    : parseInt(s, 10);
}

function isoSlug(date = new Date()) {
  return date.toISOString().replace(/\.[0-9]{3}Z$/, "Z").replace(/:/g, "-");
}

// ─── WB.Terminal subprocess driver (same shape as sibling validators) ──

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
  send(commandObj, timeoutMs = 600_000) {
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

// ─── Dispatch probe + (optional) auto-splice ────────────────────────────

async function probeDispatch() {
  // Try calling `chorizite-decode-surface-chunk` with a clearly-malformed
  // request. If dispatch is wired, we get a successful "command" echo
  // (even on error, the command field is set in the response). If
  // dispatch is missing, we get `"error":"Unknown command:'...'"`.
  return new Promise((resolve) => {
    const child = spawn(DOTNET, [WBT_DLL, "--stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stdin.write(JSON.stringify({ command: "chorizite-decode-surface-chunk", startId: "0x08000000", endId: "0x08000000" }) + "\n");
    setTimeout(() => {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    }, 4000);
    child.on("exit", () => {
      // Look for either the success envelope OR a non-"Unknown command" error.
      // Note: stdout is line-delimited JSON; the apostrophe in "Unknown command: '...'"
      // is JSON-encoded as ' so match against both renderings.
      const unknown =
        /Unknown command:\s*['"\\u0027]\s*chorizite-decode-surface-chunk/i.test(stdout)
        || /Unknown command:\s*\\u0027chorizite-decode-surface-chunk/.test(stdout);
      resolve(!unknown);
    });
  });
}

function autoSplice() {
  // Idempotent splice of TextureParity dispatch lines into
  // JsonCommandProcessor.cs. Returns the original-file content so the
  // caller can restore it post-run.
  const original = fs.readFileSync(JSON_DISPATCHER, "utf8");
  if (original.includes('"chorizite-decode-surface-chunk"')) {
    // Already wired (e.g. canonical commit landed). Nothing to do.
    return null;
  }
  // Locate the Wave-2 DAT-parity dispatch block; insert our two entries after it.
  const marker = '// Wave-2.A + 2.B DAT-parity diagnostic — see CommandEngine.DatParity.cs';
  const idx = original.indexOf(marker);
  if (idx < 0) {
    throw new Error("Could not locate Wave-2 DAT-parity marker in JsonCommandProcessor.cs (API drift).");
  }
  // Insert the two dispatch entries on the lines immediately after the
  // existing Wave-2 block (after "chorizite-list-dat-types"). Find the
  // next blank line / next comment-marker.
  const lines = original.split("\n");
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('["chorizite-list-dat-types"]')) {
      insertAt = i + 1;
      break;
    }
  }
  if (insertAt < 0) {
    throw new Error("Could not locate insertion point after chorizite-list-dat-types entry.");
  }
  lines.splice(insertAt, 0,
    '            // Wave-4.A + 4.B texture-parity diagnostic — see CommandEngine.TextureParity.cs',
    '            ["chorizite-decode-surface-chunk"]       = CmdChoriziteDecodeSurfaceChunk,',
    '            ["chorizite-decode-texture-chain-chunk"] = CmdChoriziteDecodeTextureChainChunk,');

  // Append the two Cmd wrappers at end of class (before final closing brace).
  const tail = lines.join("\n");
  const wrappers = `

    // ─────────────────────────────────────────────────────────────────
    // Wave-4.A + 4.B texture-parity dispatch — see CommandEngine.TextureParity.cs
    // (auto-spliced by validate_texture_decode.cjs from WAVE4T_DISPATCH_PENDING.patch)
    // ─────────────────────────────────────────────────────────────────

    private string CmdChoriziteDecodeSurfaceChunk(System.Text.Json.Nodes.JsonNode node) {
        uint startId = ParseUIntField(node, "startId");
        uint endId = ParseUIntField(node, "endId");
        string? datPath = node["datPath"]?.GetValue<string>();
        string? cacheRoot = node["cacheRoot"]?.GetValue<string>();
        bool fastMode = node["fastMode"]?.GetValue<bool>() ?? false;
        bool emitPng = node["emitPng"]?.GetValue<bool>() ?? false;
        var r = _engine.ChoriziteDecodeSurfaceChunk(startId, endId, datPath, cacheRoot, fastMode, emitPng);
        return Serialize(new {
            success = r.FailCount == 0,
            command = "chorizite-decode-surface-chunk",
            chunkLabel = r.ChunkLabel,
            startId = $"0x{r.StartId:X8}",
            endId = $"0x{r.EndId:X8}",
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            cacheRoot = r.CacheRoot,
            progressJsonPath = r.ProgressJsonPath,
            recordCount = r.RecordCount,
            passCount = r.PassCount,
            failCount = r.FailCount,
            cachedCount = r.CachedCount,
            source = r.Source,
            records = r.Records.Select(rec => new {
                idHex = rec.IdHex,
                surfaceSha256 = rec.SurfaceSha256,
                pixelSha256 = rec.PixelSha256,
                width = rec.Width,
                height = rec.Height,
                status = rec.Status,
                meanRgba = rec.MeanRgba,
                chainKind = rec.ChainKind,
                surfaceTextureIdHex = rec.SurfaceTextureId.HasValue ? $"0x{rec.SurfaceTextureId.Value:X8}" : null,
                renderSurfaceIdHex = rec.RenderSurfaceId.HasValue ? $"0x{rec.RenderSurfaceId.Value:X8}" : null,
                paletteIdHex = rec.PaletteId.HasValue ? $"0x{rec.PaletteId.Value:X8}" : null,
                pixelFormat = rec.PixelFormat,
                failureReason = rec.FailureReason,
            }),
            failures = r.Failures.Select(f => new {
                idHex = f.IdHex,
                status = f.Status,
                failureReason = f.FailureReason,
                pixelFormat = f.PixelFormat,
            }),
        });
    }

    private string CmdChoriziteDecodeTextureChainChunk(System.Text.Json.Nodes.JsonNode node) {
        uint startId = ParseUIntField(node, "startId");
        uint endId = ParseUIntField(node, "endId");
        string? datPath = node["datPath"]?.GetValue<string>();
        string? cacheRoot = node["cacheRoot"]?.GetValue<string>();
        bool fastMode = node["fastMode"]?.GetValue<bool>() ?? false;
        bool emitPng = node["emitPng"]?.GetValue<bool>() ?? false;
        var r = _engine.ChoriziteDecodeTextureChainChunk(startId, endId, datPath, cacheRoot, fastMode, emitPng);
        return Serialize(new {
            success = r.FailCount == 0,
            command = "chorizite-decode-texture-chain-chunk",
            chunkLabel = r.ChunkLabel,
            startId = $"0x{r.StartId:X8}",
            endId = $"0x{r.EndId:X8}",
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            cacheRoot = r.CacheRoot,
            progressJsonPath = r.ProgressJsonPath,
            recordCount = r.RecordCount,
            passCount = r.PassCount,
            failCount = r.FailCount,
            cachedCount = r.CachedCount,
            source = r.Source,
            records = r.Records.Select(rec => new {
                idHex = rec.IdHex,
                surfaceSha256 = rec.SurfaceSha256,
                pixelSha256 = rec.PixelSha256,
                width = rec.Width,
                height = rec.Height,
                status = rec.Status,
                meanRgba = rec.MeanRgba,
                chainKind = rec.ChainKind,
                surfaceTextureIdHex = rec.SurfaceTextureId.HasValue ? $"0x{rec.SurfaceTextureId.Value:X8}" : null,
                renderSurfaceIdHex = rec.RenderSurfaceId.HasValue ? $"0x{rec.RenderSurfaceId.Value:X8}" : null,
                paletteIdHex = rec.PaletteId.HasValue ? $"0x{rec.PaletteId.Value:X8}" : null,
                pixelFormat = rec.PixelFormat,
                failureReason = rec.FailureReason,
            }),
            failures = r.Failures.Select(f => new {
                idHex = f.IdHex,
                status = f.Status,
                failureReason = f.FailureReason,
                pixelFormat = f.PixelFormat,
            }),
        });
    }
`;
  // Insert wrappers before the final class closing brace. The file uses
  // file-scoped namespace (per the top-of-file `namespace WorldBuilder.Terminal;`),
  // so the final `}` is the JsonCommandProcessor class close. Insert
  // right before that single trailing brace.
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

// ─── Result aggregation ────────────────────────────────────────────────

// CACHED IS NOT VERIFIED (2026-08-03 review, finding F1).
//
// `CommandEngine.TextureParity.cs` returns a CACHED record at "Step 2 — Cache
// hit?", which is BEFORE "Step 3 — Parse the Surface via Chorizite TryGet<T>".
// A cache hit therefore replays a stored record and performs no decode and no
// mean-RGBA comparison this run. The old bar summed `passCount + cachedCount`,
// so a 100%-cached run reported `pass rate: 100.000%` / `acceptance: PASS` /
// exit 0 having compared zero pixels — which is exactly the regression this
// validator exists to catch (break the decoder, every record is still a cache
// hit, still "PASS").
//
// The bar now counts only `passCount` — records decoded AND compared THIS run.
// `--allow-cached` restores the old warm-replay semantics for the deliberate
// O(0) case documented in the header, but marks the report `verified: false`
// and prints a banner, so a replay can never be mistaken for a verification.
//
// Acceptance is also per-ID-RANGE rather than pooled over all chunks. Pooling
// let a range that was never verified ride over the bar on a different range's
// passes. Grouping by range (rather than by chunk) is deliberate: the W4.B
// chain-walk spot-check re-runs the SAME range as the W4.A sweep, and the C#
// `_textureCacheRam` is process-wide, so W4.B is ALWAYS a replay (pass=0) —
// that is redundancy, not a defect, and a range counts as verified if ANY
// chunk covering it did real decodes. A range covered only by replays fails.
function summarizeChunks(chunks, mode, allowCached = false) {
  let recordCount = 0, passCount = 0, failCount = 0, cachedCount = 0;
  const failureBuckets = {};
  const chainKindHist = {};
  const formatHist = {};
  let datSha = null;
  let recordsDetailChunks = 0;
  const perChunk = [];
  for (const c of chunks) {
    recordCount += c.recordCount;
    passCount += c.passCount;
    failCount += c.failCount;
    cachedCount += c.cachedCount;
    datSha = datSha || c.datSha256;
    if (Array.isArray(c.records)) recordsDetailChunks += 1;
    for (const r of c.records || []) {
      if (r.status === "FAIL") {
        const reason = (r.failureReason || "unknown").substring(0, 80);
        failureBuckets[reason] = (failureBuckets[reason] || 0) + 1;
      } else if (r.chainKind) {
        chainKindHist[r.chainKind] = (chainKindHist[r.chainKind] || 0) + 1;
      }
      if (r.pixelFormat) {
        formatHist[r.pixelFormat] = (formatHist[r.pixelFormat] || 0) + 1;
      }
    }
    // Accumulate per ID-RANGE (see the block comment above).
    const key = `${c.startId}..${c.endId}`;
    let g = perChunk.find((p) => p.range === key);
    if (!g) {
      g = { range: key, chunkLabels: [], recordCount: 0, passCount: 0,
            cachedCount: 0, failCount: 0, credited: 0, accept: false };
      perChunk.push(g);
    }
    g.chunkLabels.push(c.chunkLabel);
    // recordCount for a range is its widest chunk, not the sum — re-running
    // the same range does not enlarge it.
    g.recordCount = Math.max(g.recordCount, c.recordCount);
    g.passCount += c.passCount;
    g.cachedCount += c.cachedCount;
    g.failCount += c.failCount;
  }
  for (const g of perChunk) {
    g.credited = allowCached ? g.passCount + g.cachedCount : g.passCount;
    g.accept = mode === "fast"
      ? g.recordCount >= 1 && g.credited >= Math.min(g.recordCount, 80)
      : (g.recordCount > 0 ? g.credited / g.recordCount : 0) >= 0.995;
  }
  // `verifiedCount` is the honest coverage number: decoded + compared this run.
  const verifiedCount = passCount;
  const credited = allowCached ? passCount + cachedCount : verifiedCount;
  const passRate = recordCount > 0 ? credited / recordCount : 0;
  // Per-record detail is what feeds the failure buckets + chain/format
  // histograms. The live JsonCommandProcessor wrapper omits `records` (it
  // serialises only `failures`), so those stay empty and the per-record
  // ≤0.01 mean-RGBA tolerance promised in the header is never applied
  // JS-side. Surface it instead of letting empty histograms read as "clean".
  const recordsDetailAvailable = recordsDetailChunks > 0;
  // NB: no global `failCount === 0` term — the per-range bar already accounts
  // for failures (a failed record is not in passCount, so `credited` drops),
  // and a hard zero would silently revoke the documented full-mode tolerance
  // budget. An empty run (no chunks / no records) can never pass.
  const accept =
    chunks.length > 0 &&
    recordCount >= 1 &&
    perChunk.length > 0 &&
    perChunk.every((p) => p.accept);
  return {
    mode,
    recordCount,
    passCount,
    failCount,
    cachedCount,
    verifiedCount,
    verified: verifiedCount > 0,
    allowCached,
    recordsDetailAvailable,
    perChunk,
    passRate,
    accept,
    datSha256: datSha,
    failureBuckets,
    chainKindHist,
    formatHist,
  };
}

// ─── Main flow ──────────────────────────────────────────────────────────

async function main() {
  const cli = parseArgs(process.argv);
  console.log(`validate_texture_decode.cjs (mode=${cli.mode}; emitPng=${cli.emitPng})`);

  // Pre-flight: WBT_DLL exists.
  if (!fs.existsSync(WBT_DLL)) {
    console.error(`INFRA: WorldBuilder.Terminal.dll not found at ${WBT_DLL}`);
    console.error(`  build first: dotnet build WorldBuilder.Terminal -c Release`);
    process.exit(2);
  }
  // Pre-flight: dat sha cache parent exists.
  try { fs.mkdirSync(cli.cacheRoot, { recursive: true }); }
  catch (e) {
    console.error(`INFRA: cannot create cacheRoot ${cli.cacheRoot}: ${e.message}`);
    process.exit(2);
  }

  // Probe dispatch.
  let dispatchWired = await probeDispatch();
  let preSpliceOriginal = null;
  if (!dispatchWired) {
    console.log(`  dispatch not wired; pending patch at ${DISPATCH_PATCH}`);
    if (cli.autoSplice) {
      try {
        preSpliceOriginal = autoSplice();
        if (preSpliceOriginal) rebuildTerminal();
        dispatchWired = await probeDispatch();
      } catch (e) {
        console.error(`INFRA: auto-splice failed: ${e.message}`);
        if (preSpliceOriginal) restoreJsonDispatcher(preSpliceOriginal);
        process.exit(2);
      }
    } else {
      console.error(`INFRA: dispatch entries not wired. Either:`);
      console.error(`  - apply ${DISPATCH_PATCH} to JsonCommandProcessor.cs and rebuild`);
      console.error(`  - re-run with --auto-splice for transient splice (will revert on exit)`);
      process.exit(2);
    }
  }
  if (!dispatchWired) {
    console.error(`INFRA: dispatch still not wired after auto-splice attempt`);
    if (preSpliceOriginal) restoreJsonDispatcher(preSpliceOriginal);
    process.exit(2);
  }
  console.log(`  dispatch wired; proceeding`);

  const t0 = Date.now();
  const slug = isoSlug();
  const reportDir = path.join(REPORT_ROOT, slug);
  fs.mkdirSync(reportDir, { recursive: true });

  const driver = new WbtDriver();
  driver.start();
  await new Promise((res) => setTimeout(res, 1200)); // ready

  const results = {
    runId: slug,
    reportDir,
    mode: cli.mode,
    emitPng: cli.emitPng,
    cacheRoot: cli.cacheRoot,
    expectedDatSha: EXPECTED_DAT_SHA,
    startedAt: new Date().toISOString(),
    chunks: [],
    summary: null,
  };

  let exit = 0;
  try {
    if (cli.mode === "fast") {
      // Fast mode: one chunk over the entire Surface range, with the
      // C#-side `fastMode=true` filter (engine resolves Holtburg subset).
      console.log(`  fast-mode chunk: 0x${cli.startId.toString(16)} - 0x${cli.endId.toString(16)}`);
      const resp = await driver.send({
        command: "chorizite-decode-surface-chunk",
        startId: `0x${cli.startId.toString(16).toUpperCase().padStart(8, "0")}`,
        endId: `0x${cli.endId.toString(16).toUpperCase().padStart(8, "0")}`,
        cacheRoot: cli.cacheRoot,
        fastMode: true,
        emitPng: cli.emitPng,
      }, 60_000);
      if (resp.error) throw new Error(`fast-mode chunk failed: ${resp.error}`);
      validateDatSha(resp);
      results.chunks.push(resp);
      console.log(`    records=${resp.recordCount} pass=${resp.passCount} cached=${resp.cachedCount} fail=${resp.failCount}`);
    } else {
      // Full mode: stride the range in chunkSize-record buckets.
      let chunkIdx = 0;
      for (let s = cli.startId; s < cli.endId; s += cli.chunkSize) {
        const e = Math.min(s + cli.chunkSize, cli.endId);
        chunkIdx++;
        process.stdout.write(`  chunk ${chunkIdx}: 0x${s.toString(16).padStart(8, "0")}-0x${e.toString(16).padStart(8, "0")}... `);
        const resp = await driver.send({
          command: "chorizite-decode-surface-chunk",
          startId: `0x${s.toString(16).toUpperCase().padStart(8, "0")}`,
          endId: `0x${e.toString(16).toUpperCase().padStart(8, "0")}`,
          cacheRoot: cli.cacheRoot,
          fastMode: false,
          emitPng: cli.emitPng,
        }, 600_000);
        if (resp.error) throw new Error(`chunk ${chunkIdx} failed: ${resp.error}`);
        validateDatSha(resp);
        results.chunks.push(resp);
        console.log(`records=${resp.recordCount} pass=${resp.passCount} cached=${resp.cachedCount} fail=${resp.failCount}`);
      }
    }

    // Wave 4.B chain-walk for spot-check (always on fast-mode; sampled on full).
    if (cli.mode === "fast" || cli.mode === "spot") {
      console.log(`  W4.B chain-walk spot-check: ${cli.startId.toString(16)}-${cli.endId.toString(16)}`);
      const respChain = await driver.send({
        command: "chorizite-decode-texture-chain-chunk",
        startId: `0x${cli.startId.toString(16).toUpperCase().padStart(8, "0")}`,
        endId: `0x${cli.endId.toString(16).toUpperCase().padStart(8, "0")}`,
        cacheRoot: cli.cacheRoot,
        fastMode: true,
        emitPng: false,
      }, 60_000);
      if (respChain.error) {
        console.warn(`  W4.B chain-walk failed: ${respChain.error} — non-fatal, recorded as INFRA`);
      } else {
        validateDatSha(respChain);
        results.chunks.push(respChain);
        console.log(`    records=${respChain.recordCount} pass=${respChain.passCount} cached=${respChain.cachedCount} fail=${respChain.failCount}`);
      }
    }

    results.finishedAt = new Date().toISOString();
    results.summary = summarizeChunks(results.chunks, cli.mode, cli.allowCached);
    const reportPath = path.join(reportDir, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));

    console.log(`\n=== Final ===`);
    const s = results.summary;
    console.log(`  mode: ${s.mode}`);
    console.log(`  records: ${s.recordCount}  pass: ${s.passCount}  cached: ${s.cachedCount}  fail: ${s.failCount}`);
    console.log(`  VERIFIED this run: ${s.verifiedCount}/${s.recordCount} (decoded + compared; CACHED returns before the decode)`);
    for (const p of s.perChunk) {
      console.log(`    ${p.accept ? "ok  " : "BAR!"} ${p.range}: records=${p.recordCount} pass=${p.passCount} cached=${p.cachedCount} fail=${p.failCount} credited=${p.credited}  [${p.chunkLabels.join(", ")}]`);
    }
    console.log(`  pass rate: ${(s.passRate * 100).toFixed(3)}%${s.allowCached ? " (--allow-cached: CACHED credited)" : ""}`);
    console.log(`  dat sha256: ${s.datSha256?.slice(0, 16)}…`);
    console.log(`  chain kinds: ${JSON.stringify(s.chainKindHist)}`);
    console.log(`  pixel formats: ${JSON.stringify(s.formatHist)}`);
    if (!s.recordsDetailAvailable && s.recordCount > 0) {
      console.log(`  WARNING: no chunk returned a 'records' array — the live`);
      console.log(`           JsonCommandProcessor wrapper serialises only 'failures', so the`);
      console.log(`           per-record chain/format histograms above are EMPTY BY OMISSION,`);
      console.log(`           not because the DAT is clean, and the ≤0.01 mean-RGBA tolerance`);
      console.log(`           in this file's header is never applied JS-side. (C# side; fix in`);
      console.log(`           WorldBuilder.Terminal/JsonCommandProcessor.cs CmdChoriziteDecode*.)`);
    }
    if (!s.verified && !s.allowCached) {
      console.log(`  CACHE REPLAY: 0 records were decoded this run — nothing was verified.`);
      console.log(`           Use a fresh --cache-root=<empty dir> to force real decodes, or`);
      console.log(`           --allow-cached to accept a warm replay (reported verified:false).`);
    }
    if (s.failCount > 0) {
      console.log(`  failure clusters (top 5):`);
      const top = Object.entries(s.failureBuckets)
        .sort((a, b) => b[1] - a[1]).slice(0, 5);
      for (const [reason, n] of top) {
        console.log(`    ${n}× ${reason}`);
      }
    }
    console.log(`  acceptance: ${s.accept ? "PASS" : "FAIL"} (${cli.mode === "fast" ? "≥80/81 PASS" : "≥99.5% PASS"})`);
    console.log(`  report: ${reportPath}`);
    console.log(`  total time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    exit = s.accept ? 0 : 1;
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`);
    results.error = e.message;
    fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(results, null, 2));
    exit = 2;
  } finally {
    driver.stop();
    if (preSpliceOriginal) restoreJsonDispatcher(preSpliceOriginal);
  }
  process.exit(exit);
}

function validateDatSha(resp) {
  if (!resp.datSha256) return;
  if (resp.datSha256 !== EXPECTED_DAT_SHA) {
    throw new Error(
      `DAT sha drift! got=${resp.datSha256}\n  expected=${EXPECTED_DAT_SHA}\n` +
      `  Re-bake from base DATs per [[feedback_base_dats_only_for_bake]].`);
  }
}

main().catch((e) => {
  console.error(`UNCAUGHT: ${e.message}\n${e.stack}`);
  process.exit(2);
});
