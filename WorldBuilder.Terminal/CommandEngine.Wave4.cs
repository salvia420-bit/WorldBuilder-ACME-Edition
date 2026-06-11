using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace WorldBuilder.Terminal;

/// <summary>
/// Wave 4.E of the retail-correctness diagnostic toolset. Hosts the
/// <c>wave4-status</c> + <c>wave4-sweep</c> JSON commands that drive the
/// sibling W4.A–W4.D chunked validators
/// (<c>chorizite-decode-surface-chunk</c>,
/// <c>chorizite-decode-texture-chain-chunk</c>,
/// <c>mesh-vs-obj-export-chunk</c>,
/// <c>env-cell-vs-setup-model-chunk</c>) through the
/// <c>scripts/wave4_sweep.cjs</c> Node orchestrator.
///
/// <para>
/// **Why we subprocess instead of re-implementing in C#:** the orchestrator
/// needs to fan out 4-wide across long-lived <c>WorldBuilder.Terminal --stdin</c>
/// subprocesses, drain pipes asynchronously, and write a result cache to
/// <c>/mnt/wbterminal1/holtburger-validator-fixtures/wave4/</c>. Node's
/// child_process API is the cleanest fit for that pattern. We mirror the
/// <c>diag-run-all</c> wrapper at <c>Diagnostics/RunAll.cs:529 RunNode</c>:
/// same async stdout/stderr drain, same SIGKILL-on-timeout discipline.
/// </para>
///
/// <para>
/// **Commands:**
/// <list type="bullet">
///   <item>
///     <c>wave4-status</c> — read-only. Inspects the sha-keyed cache root
///     + the most-recent sweep-report (if any) and returns chunk-count,
///     completed, in-flight, last-failure, cache-hit-rate. Does NOT spawn
///     a subprocess.
///   </item>
///   <item>
///     <c>wave4-sweep</c> — subprocesses the Node orchestrator, waits for
///     completion, parses the aggregate JSON. Long-running.
///   </item>
/// </list>
/// </para>
///
/// <para>
/// **Layout:**
/// <list type="bullet">
///   <item>Driver: <c>scripts/wave4_sweep.cjs</c></item>
///   <item>Cache root: <c>/mnt/wbterminal1/holtburger-validator-fixtures/wave4/&lt;target&gt;/&lt;startId&gt;-&lt;endId&gt;/progress.json</c></item>
///   <item>Aggregate root: <c>/mnt/wbterminal1/holtburger-validator-reports/wave4/&lt;ts&gt;/sweep-report.json</c></item>
/// </list>
/// </para>
///
/// <para>
/// **See also:**
/// <list type="bullet">
///   <item>Plan: <c>docs/diagnostic-toolset-plan-2026-05-19.md</c> §6 Wave 4 W4.E</item>
///   <item>Sibling agent partials: <c>CommandEngine.TextureParity.cs</c> + <c>CommandEngine.MeshParity.cs</c></item>
///   <item>Diag-run-all integration: <c>Diagnostics/RunAll.cs</c>; future hook documented in <c>docs/wave4o-status-pending.md</c></item>
/// </list>
/// </para>
/// </summary>
public partial class CommandEngine {

    // ─────────────────────────────────────────────────────────────────────
    // Result records — surfaced via the JsonCommandProcessor dispatch
    // wrappers in WAVE4O_DISPATCH_PENDING.patch (this agent does not edit
    // JsonCommandProcessor.cs; another agent splices the patch in).
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Read-only inspection of the sweep cache + most-recent aggregate
    /// without spawning anything. Drives the <c>wave4-status</c> command.
    /// </summary>
    /// <param name="CacheRoot">Sha-keyed result cache root.</param>
    /// <param name="ChunkCount">Total chunk dirs currently under the cache root.</param>
    /// <param name="CompletedChunks">Chunks with a readable progress.json whose status != INFLIGHT.</param>
    /// <param name="InFlightChunks">Chunks whose progress.json marks status=INFLIGHT.</param>
    /// <param name="UnreadableChunks">Chunks whose progress.json could not be read or parsed; counted in ChunkCount but in neither CompletedChunks nor InFlightChunks.</param>
    /// <param name="FailedChunks">Chunks with status=FAIL in progress.json.</param>
    /// <param name="CacheHitCount">Sum of cacheHit counters across chunk progress.json files.</param>
    /// <param name="CacheMissCount">Sum of cacheMiss counters across chunk progress.json files.</param>
    /// <param name="LastFailureChunkLabel">Most-recent failing chunk label, or null.</param>
    /// <param name="LastFailureMessage">Most-recent failure message, or null.</param>
    /// <param name="LastSweepStartUtc">Started-at of the most-recent sweep, or null.</param>
    /// <param name="LastSweepFinishUtc">Finished-at of the most-recent sweep, or null.</param>
    /// <param name="LastSweepReportPath">Path to the most-recent sweep-report.json, or null.</param>
    public sealed record Wave4StatusResult(
        string CacheRoot,
        int ChunkCount,
        int CompletedChunks,
        int InFlightChunks,
        int UnreadableChunks,
        int FailedChunks,
        long CacheHitCount,
        long CacheMissCount,
        string? LastFailureChunkLabel,
        string? LastFailureMessage,
        DateTime? LastSweepStartUtc,
        DateTime? LastSweepFinishUtc,
        string? LastSweepReportPath);

    /// <summary>
    /// Top-level summary for the <c>wave4-sweep</c> command. Mirrors the
    /// per-run aggregate JSON written by <c>scripts/wave4_sweep.cjs</c>.
    /// </summary>
    /// <param name="SweepReportJsonPath">Path to the freshly written sweep-report.json (may be empty on driver failure).</param>
    /// <param name="SummaryMarkdownPath">Sibling summary.md path.</param>
    /// <param name="ExitCode">Exit code of the orchestrator subprocess (0=PASS, 1=FAIL, 2=INFRA).</param>
    /// <param name="ChunkCount">Total chunks dispatched.</param>
    /// <param name="PassedChunks">Chunks with status=PASS.</param>
    /// <param name="FailedChunks">Chunks with status=FAIL.</param>
    /// <param name="InfraChunks">Chunks with status=INFRA (sibling not live, IO error, etc).</param>
    /// <param name="CachedChunks">Chunks served from the sha cache (no re-dispatch).</param>
    /// <param name="ElapsedMs">Wall-clock of the orchestrator subprocess.</param>
    /// <param name="DriverError">Non-null when the orchestrator itself crashed.</param>
    public sealed record Wave4SweepResult(
        string SweepReportJsonPath,
        string SummaryMarkdownPath,
        int ExitCode,
        int ChunkCount,
        int PassedChunks,
        int FailedChunks,
        int InfraChunks,
        int CachedChunks,
        long ElapsedMs,
        string? DriverError);

    // ─────────────────────────────────────────────────────────────────────
    // Constants.
    // ─────────────────────────────────────────────────────────────────────

    // ~6 hour budget for the whole-DAT first-pass run on the GTX 1070 box
    // per the plan §6 W4.E acceptance ("First-pass completes in ≤6 hours").
    // Fast-mode runs land in seconds; we use the long timeout for full-mode
    // and let the operator hit Ctrl-C if they need to abort early.
    private static readonly TimeSpan Wave4SweepTimeout = TimeSpan.FromHours(6);

    /// <summary>Cache root for chunk progress.json files. Must live on /mnt/wbterminal1 (/ is at 94%).</summary>
    private const string Wave4CacheRoot =
        "/mnt/wbterminal1/holtburger-validator-fixtures/wave4";

    /// <summary>Aggregate report root: one timestamped subdir per sweep.</summary>
    private const string Wave4ReportRoot =
        "/mnt/wbterminal1/holtburger-validator-reports/wave4";

    /// <summary>Relative path to the Node orchestrator from the repo root.</summary>
    private const string Wave4SweepScriptRelative = "scripts/wave4_sweep.cjs";

    // ─────────────────────────────────────────────────────────────────────
    // Public commands — invoked from JsonCommandProcessor dispatch wrappers
    // (see WAVE4O_DISPATCH_PENDING.patch).
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Inspect the Wave 4 sweep cache + most-recent sweep-report without
    /// spawning anything. Returns chunk counts, in-flight count, last
    /// failure, cache-hit-rate.
    ///
    /// <para>
    /// Tolerant of an empty cache root — the very first time the operator
    /// asks "what's wave4 doing?" before any sweep has run, this returns a
    /// row of zeroes (not a hard error). That differs from
    /// <c>diag-status</c>, which throws when no aggregate exists; the
    /// rationale here is that wave4 status is a polled-progress UX, not a
    /// PASS/FAIL decision point — operators ask it during a long run.
    /// </para>
    /// </summary>
    public Wave4StatusResult Wave4Status() {
        int chunkCount = 0;
        int completedChunks = 0;
        int inFlightChunks = 0;
        int unreadableChunks = 0;
        int failedChunks = 0;
        long cacheHits = 0;
        long cacheMisses = 0;
        string? lastFailLabel = null;
        string? lastFailMessage = null;
        DateTime? lastFailWhen = null;
        bool sawAnyFail = false;

        if (Directory.Exists(Wave4CacheRoot)) {
            foreach (var targetDir in Directory.EnumerateDirectories(Wave4CacheRoot)) {
                foreach (var chunkDir in Directory.EnumerateDirectories(targetDir)) {
                    var progressPath = Path.Combine(chunkDir, "progress.json");
                    if (!File.Exists(progressPath)) continue;
                    chunkCount++;
                    string raw;
                    try {
                        raw = File.ReadAllText(progressPath);
                    } catch {
                        unreadableChunks++;
                        continue;
                    }
                    JsonDocument doc;
                    try {
                        doc = JsonDocument.Parse(raw);
                    } catch {
                        unreadableChunks++;
                        continue;
                    }
                    using var _doc = doc;
                    var root = doc.RootElement;
                    string status = root.TryGetProperty("status", out var stEl)
                        ? (stEl.GetString() ?? "") : "";
                    if (string.Equals(status, "INFLIGHT", StringComparison.OrdinalIgnoreCase)) {
                        inFlightChunks++;
                    } else {
                        completedChunks++;
                    }
                    if (string.Equals(status, "FAIL", StringComparison.OrdinalIgnoreCase)) {
                        failedChunks++;
                        var label = $"{Path.GetFileName(targetDir)}/{Path.GetFileName(chunkDir)}";
                        var msg =
                            root.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String
                                ? m.GetString()
                                : (root.TryGetProperty("infraError", out var ie) && ie.ValueKind == JsonValueKind.String
                                    ? ie.GetString()
                                    : null);
                        DateTime? finishedAt = null;
                        if (root.TryGetProperty("finishedAt", out var fa) && fa.ValueKind == JsonValueKind.String) {
                            if (DateTime.TryParse(fa.GetString(), System.Globalization.CultureInfo.InvariantCulture,
                                System.Globalization.DateTimeStyles.RoundtripKind, out var when)) {
                                finishedAt = when;
                            }
                        }
                        bool take;
                        if (finishedAt != null) {
                            // Timestamped failures always beat untimestamped ones,
                            // and otherwise win by recency.
                            take = lastFailWhen == null || finishedAt > lastFailWhen;
                        } else {
                            // No timestamp: only adopt while we have never seen a
                            // failure at all, so enumeration order is a last resort
                            // and a later timestamped failure can still override.
                            take = !sawAnyFail;
                        }
                        if (take) {
                            lastFailLabel = label;
                            lastFailMessage = msg;
                            lastFailWhen = finishedAt;
                        }
                        sawAnyFail = true;
                    }
                    if (root.TryGetProperty("cacheHit", out var ch) && ch.ValueKind == JsonValueKind.Number) {
                        cacheHits += ch.GetInt64();
                    }
                    if (root.TryGetProperty("cacheMiss", out var cm) && cm.ValueKind == JsonValueKind.Number) {
                        cacheMisses += cm.GetInt64();
                    }
                }
            }
        }

        // Most-recent sweep-report.json (if any) gives us the wall-clock
        // window of the last run.
        var latestReportPath = FindLatestSweepReportJson(Wave4ReportRoot);
        DateTime? lastSweepStart = null;
        DateTime? lastSweepFinish = null;
        if (latestReportPath != null) {
            try {
                using var rd = JsonDocument.Parse(File.ReadAllText(latestReportPath));
                var rr = rd.RootElement;
                if (rr.TryGetProperty("finishedAt", out var fa) &&
                    fa.ValueKind == JsonValueKind.String &&
                    DateTime.TryParse(fa.GetString(),
                        System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.RoundtripKind,
                        out var when)) {
                    lastSweepFinish = when;
                }
                if (rr.TryGetProperty("elapsedMs", out var em) &&
                    em.ValueKind == JsonValueKind.Number &&
                    lastSweepFinish != null) {
                    lastSweepStart = lastSweepFinish - TimeSpan.FromMilliseconds(em.GetInt64());
                }
            } catch {
                /* ignore — stale or partial file */
            }
        }

        return new Wave4StatusResult(
            CacheRoot: Wave4CacheRoot,
            ChunkCount: chunkCount,
            CompletedChunks: completedChunks,
            InFlightChunks: inFlightChunks,
            UnreadableChunks: unreadableChunks,
            FailedChunks: failedChunks,
            CacheHitCount: cacheHits,
            CacheMissCount: cacheMisses,
            LastFailureChunkLabel: lastFailLabel,
            LastFailureMessage: lastFailMessage,
            LastSweepStartUtc: lastSweepStart,
            LastSweepFinishUtc: lastSweepFinish,
            LastSweepReportPath: latestReportPath);
    }

    /// <summary>
    /// Run the Wave 4 chunked sweep via the Node orchestrator.
    /// Subprocesses <c>scripts/wave4_sweep.cjs</c> with the given options and
    /// parses its sweep-report.json.
    ///
    /// <para>
    /// **Failure semantics:**
    /// <list type="bullet">
    ///   <item>If the orchestrator itself crashes (script missing, node missing,
    ///     timeout), <c>DriverError</c> carries the message.</item>
    ///   <item>If individual chunks return INFRA (sibling agents have not
    ///     wired their chunk command yet), those land in
    ///     <c>InfraChunks</c> and exit code is 2 only if no other progress
    ///     was made.</item>
    /// </list>
    /// </para>
    /// </summary>
    /// <param name="mode">"fast" (default, Holtburg subset) or "full" (whole-DAT).</param>
    /// <param name="target">"all" (default), "surface", "texture-chain", "mesh", or "env-cell".</param>
    /// <param name="concurrency">Number of parallel WB.Terminal worker subprocesses (default 4).</param>
    /// <param name="reset">When true, rebuild cache from scratch; default false (resume).</param>
    public Wave4SweepResult Wave4Sweep(
        string? mode = null,
        string? target = null,
        int concurrency = 4,
        bool reset = false) {

        var sw = Stopwatch.StartNew();
        var effectiveMode = string.IsNullOrWhiteSpace(mode) ? "fast" : mode!;
        if (effectiveMode != "fast" && effectiveMode != "full") {
            throw new ArgumentException(
                $"mode must be 'fast' or 'full'; got '{mode}'");
        }
        var effectiveTarget = string.IsNullOrWhiteSpace(target) ? "all" : target!;
        var validTargets = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "all", "surface", "texture-chain", "mesh", "env-cell",
        };
        if (!validTargets.Contains(effectiveTarget)) {
            throw new ArgumentException(
                $"target must be one of {string.Join("|", validTargets)}; got '{target}'");
        }
        if (concurrency < 1 || concurrency > 32) {
            throw new ArgumentException(
                $"concurrency must be in [1,32]; got {concurrency}");
        }

        var script = ResolveWave4SweepScript();
        if (script == null) {
            return new Wave4SweepResult(
                SweepReportJsonPath: "",
                SummaryMarkdownPath: "",
                ExitCode: -1,
                ChunkCount: 0, PassedChunks: 0, FailedChunks: 0,
                InfraChunks: 0, CachedChunks: 0,
                ElapsedMs: sw.ElapsedMilliseconds,
                DriverError: $"Sweep script not found: {Wave4SweepScriptRelative}. " +
                             "Set WORLDBUILDER_WAVE4_SWEEP or run from a worldbuilder checkout.");
        }

        var args = new List<string> {
            script,
            $"--mode={effectiveMode}",
            $"--target={effectiveTarget}",
            $"--concurrency={concurrency}",
        };
        if (reset) args.Add("--reset");

        // Each run lives under a fresh timestamped subdir; the orchestrator
        // generates the slug itself, so we just give it the canonical root.

        // Bind the report we'll parse to THIS run. FindLatestSweepReportJson
        // returns the newest sweep-report.json by mtime regardless of which
        // run wrote it, so an orchestrator that crashes mid-run after an
        // earlier successful sweep would otherwise have us parse the OLD
        // report and (with failed==0) report success on a non-zero exit.
        // Snapshot the pre-run latest path + its mtime; afterwards accept a
        // report only if it is a different path or strictly newer.
        var preRunReport = FindLatestSweepReportJson(Wave4ReportRoot);
        DateTime preRunReportMtime = DateTime.MinValue;
        if (preRunReport != null && File.Exists(preRunReport)) {
            preRunReportMtime = File.GetLastWriteTimeUtc(preRunReport);
        }

        string stdoutText, stderrText;
        int exitCode;
        bool timedOut;
        try {
            (stdoutText, stderrText, exitCode, timedOut) =
                RunNodeOrchestrator(args, Wave4SweepTimeout);
        } catch (Exception ex) {
            return new Wave4SweepResult(
                SweepReportJsonPath: "",
                SummaryMarkdownPath: "",
                ExitCode: -1,
                ChunkCount: 0, PassedChunks: 0, FailedChunks: 0,
                InfraChunks: 0, CachedChunks: 0,
                ElapsedMs: sw.ElapsedMilliseconds,
                DriverError: $"Failed to launch node: {ex.Message}");
        }

        // Locate the sweep-report.json written by THIS run. A report counts
        // as ours only if it is a different file than the pre-run snapshot or
        // strictly newer by mtime — otherwise it is a leftover from an earlier
        // sweep that this orchestrator crashed before overwriting.
        var sweepReport = FindLatestSweepReportJson(Wave4ReportRoot);
        bool freshReport =
            sweepReport != null &&
            (!string.Equals(sweepReport, preRunReport, StringComparison.Ordinal) ||
             File.GetLastWriteTimeUtc(sweepReport) > preRunReportMtime);
        if (!freshReport) {
            return new Wave4SweepResult(
                SweepReportJsonPath: "",
                SummaryMarkdownPath: "",
                ExitCode: exitCode,
                ChunkCount: 0, PassedChunks: 0, FailedChunks: 0,
                InfraChunks: 0, CachedChunks: 0,
                ElapsedMs: sw.ElapsedMilliseconds,
                DriverError: timedOut
                    ? $"Sweep exceeded {Wave4SweepTimeout.TotalHours:F0}-hour timeout and was killed."
                    : $"Driver finished (exit={exitCode}) but no fresh sweep-report.json was found under {Wave4ReportRoot}.\n" +
                      $"stdout (tail): {Tail(stdoutText, 1500)}\n" +
                      $"stderr (tail): {Tail(stderrText, 1500)}");
        }

        // Merge — never clobber — DriverError. Keep any parse error surfaced
        // by ParseSweepReport, then append the timeout note when timed out, or
        // a non-zero-exit note otherwise. Folding exitCode!=0 into DriverError
        // makes the wrapper's `success = IsNullOrEmpty(driverError) && failed==0`
        // gate fail closed on a crashed-but-report-present orchestrator.
        var parsed = ParseSweepReport(sweepReport!);
        string? driverError = parsed.DriverError;
        if (timedOut) {
            driverError = AppendSweepError(driverError,
                "Sweep timed out — sweep-report.json may reflect partial state.");
        } else if (exitCode != 0) {
            driverError = AppendSweepError(driverError,
                $"Sweep orchestrator exited non-zero (exit={exitCode}) — sweep-report.json may be stale or partial.");
        }
        return parsed with {
            ExitCode = exitCode,
            ElapsedMs = sw.ElapsedMilliseconds,
            DriverError = driverError,
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Internals.
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Walks up from CWD + assembly location looking for the canonical
    /// orchestrator script path. Also honors <c>WORLDBUILDER_WAVE4_SWEEP</c>
    /// env var (mirrors <c>WORLDBUILDER_DIAG_DRIVER</c>).
    /// </summary>
    private static string? ResolveWave4SweepScript() {
        var envPath = System.Environment.GetEnvironmentVariable("WORLDBUILDER_WAVE4_SWEEP");
        if (!string.IsNullOrEmpty(envPath) && File.Exists(envPath)) return envPath;

        foreach (var anchor in new[] {
            System.Environment.CurrentDirectory,
            AppContext.BaseDirectory,
        }) {
            string? dir = anchor;
            for (int i = 0; i < 10 && dir != null; i++) {
                var candidate = Path.Combine(dir, Wave4SweepScriptRelative);
                if (File.Exists(candidate)) return candidate;
                dir = Path.GetDirectoryName(dir);
            }
        }
        return null;
    }

    /// <summary>
    /// Find the most-recently-modified <c>&lt;ts&gt;/sweep-report.json</c> under
    /// the canonical wave4 reports root. Returns null if none exist.
    /// </summary>
    private static string? FindLatestSweepReportJson(string root) {
        if (!Directory.Exists(root)) return null;
        string? best = null;
        DateTime bestMtime = DateTime.MinValue;
        foreach (var dir in Directory.EnumerateDirectories(root)) {
            var candidate = Path.Combine(dir, "sweep-report.json");
            if (!File.Exists(candidate)) continue;
            var mt = File.GetLastWriteTimeUtc(candidate);
            if (mt > bestMtime) {
                bestMtime = mt;
                best = candidate;
            }
        }
        return best;
    }

    /// <summary>
    /// Parse the sweep-report.json written by <c>scripts/wave4_sweep.cjs</c>
    /// into our typed result. Defensive against missing fields so the wrapper
    /// can survive driver-schema additions without re-deploying.
    /// </summary>
    private static Wave4SweepResult ParseSweepReport(string sweepReportPath) {
        string raw;
        try {
            raw = File.ReadAllText(sweepReportPath);
        } catch (Exception ex) {
            return new Wave4SweepResult(
                SweepReportJsonPath: sweepReportPath,
                SummaryMarkdownPath: "",
                ExitCode: -1,
                ChunkCount: 0, PassedChunks: 0, FailedChunks: 0,
                InfraChunks: 0, CachedChunks: 0,
                ElapsedMs: 0,
                DriverError: $"Failed to read sweep-report.json: {ex.Message}");
        }
        JsonDocument doc;
        try {
            doc = JsonDocument.Parse(raw);
        } catch (Exception ex) {
            return new Wave4SweepResult(
                SweepReportJsonPath: sweepReportPath,
                SummaryMarkdownPath: "",
                ExitCode: -1,
                ChunkCount: 0, PassedChunks: 0, FailedChunks: 0,
                InfraChunks: 0, CachedChunks: 0,
                ElapsedMs: 0,
                DriverError: $"Failed to parse sweep-report.json: {ex.Message}");
        }
        using var _doc = doc;
        var root = doc.RootElement;

        int chunkCount = 0, passed = 0, failed = 0, infra = 0, cached = 0;
        // A report that parses as JSON but lacks a 'summary' object must NOT
        // come back as all-zero with a null DriverError — that would let the
        // wrapper's `failed==0` success gate read true off an unparseable
        // report. Surface a parseError so the caller's merge keeps it.
        string? parseError = null;
        if (root.TryGetProperty("summary", out var s) && s.ValueKind == JsonValueKind.Object) {
            if (s.TryGetProperty("chunkCount", out var cc) && cc.ValueKind == JsonValueKind.Number) {
                chunkCount = cc.GetInt32();
            }
            if (s.TryGetProperty("passed", out var ps) && ps.ValueKind == JsonValueKind.Number) {
                passed = ps.GetInt32();
            }
            if (s.TryGetProperty("failed", out var fs) && fs.ValueKind == JsonValueKind.Number) {
                failed = fs.GetInt32();
            }
            if (s.TryGetProperty("infra", out var inf) && inf.ValueKind == JsonValueKind.Number) {
                infra = inf.GetInt32();
            }
            if (s.TryGetProperty("cached", out var ca) && ca.ValueKind == JsonValueKind.Number) {
                cached = ca.GetInt32();
            }
        } else {
            parseError =
                $"Malformed sweep-report.json: missing/invalid 'summary' object at {sweepReportPath}.";
        }

        long elapsedMs = 0;
        if (root.TryGetProperty("elapsedMs", out var em) && em.ValueKind == JsonValueKind.Number) {
            elapsedMs = em.GetInt64();
        }

        var summaryMdPath = Path.Combine(
            Path.GetDirectoryName(sweepReportPath) ?? "",
            "summary.md");

        return new Wave4SweepResult(
            SweepReportJsonPath: sweepReportPath,
            SummaryMarkdownPath: summaryMdPath,
            // ExitCode set by caller in Wave4Sweep.
            ExitCode: 0,
            ChunkCount: chunkCount,
            PassedChunks: passed,
            FailedChunks: failed,
            InfraChunks: infra,
            CachedChunks: cached,
            ElapsedMs: elapsedMs,
            DriverError: parseError); // null unless the report was malformed
    }

    /// <summary>
    /// Subprocess <c>node</c> with the given args. Mirrors
    /// <c>RunNode</c> at <c>Diagnostics/RunAll.cs:529</c> — same async
    /// read pattern, same SIGKILL-on-timeout discipline. We keep a private
    /// copy here instead of sharing with the RunAll partial so the two
    /// surfaces can evolve their timeout policies independently
    /// (diag-run-all = 2h, wave4-sweep = 6h).
    /// </summary>
    private static (string Stdout, string Stderr, int ExitCode, bool TimedOut) RunNodeOrchestrator(
        IEnumerable<string> args, TimeSpan timeout) {
        var nodeExe = System.Environment.GetEnvironmentVariable("WORLDBUILDER_NODE")
            ?? "node";
        var psi = new ProcessStartInfo(nodeExe) {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start node process");

        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();
        bool exited = proc.WaitForExit((int)timeout.TotalMilliseconds);
        if (!exited) {
            try { proc.Kill(entireProcessTree: true); } catch { /* best effort */ }
            try { proc.WaitForExit(2000); } catch { /* best effort */ }
            string outSoFar = ""; string errSoFar = "";
            try { outSoFar = stdoutTask.Result; } catch { /* swallow */ }
            try { errSoFar = stderrTask.Result; } catch { /* swallow */ }
            return (outSoFar, errSoFar, -1, true);
        }
        return (stdoutTask.Result, stderrTask.Result, proc.ExitCode, false);
    }

    // Note: the `Tail` helper used in ParseSweepReport is defined in the
    // sibling partial Diagnostics/RunAll.cs (private static string Tail).
    // Because this is the same partial class, we share it.

    /// <summary>
    /// Combine two DriverError fragments without dropping either: when the
    /// base is null/empty the addition stands alone, otherwise the addition is
    /// appended on a new line. Kept local to this partial so the wave4-sweep
    /// surface does not depend on a private helper in the RunAll partial.
    /// </summary>
    private static string AppendSweepError(string? baseError, string addition) {
        return string.IsNullOrEmpty(baseError) ? addition : $"{baseError}\n{addition}";
    }
}
