using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace WorldBuilder.Terminal;

/// <summary>
/// Wave 5.C of the retail-correctness diagnostic toolset. Wraps the
/// <c>external/holtburger/apps/holtburger-web/run-all-validators.cjs</c>
/// Node driver. The driver invokes every shipped per-surface validator
/// (Waves 1-3 + W5.A + W5.B) and aggregates each one's
/// <c>report.json</c> into a single top-level envelope at
/// <c>/mnt/wbterminal1/holtburger-validator-reports/diag-run-all/&lt;ts&gt;/aggregate.json</c>.
///
/// <para>
/// **Why we subprocess instead of re-implementing in C#:** the Node
/// driver already lives next to all 8-10 <c>validate_*.cjs</c> validators
/// and knows their CLI conventions + report-dir conventions. Mirroring
/// that orchestration in C# would mean keeping two implementations in
/// sync. Mirror the <c>compare-to-retail</c> pattern at
/// <c>CommandEngine.cs:10933 RunPython</c> — same async stdout/stderr
/// drain, same timeout guard, but with <c>node</c> instead of <c>python</c>.
/// </para>
///
/// <para>
/// **Commands:**
/// <list type="bullet">
///   <item>
///     <c>diag-run-all</c> — single entry point. Spawns the Node driver,
///     waits for completion, parses the aggregate JSON, returns a
///     structured summary.
///   </item>
///   <item>
///     <c>diag-status</c> — read-only view of the most recent
///     <c>diag-run-all</c> aggregate without re-running anything.
///   </item>
/// </list>
/// </para>
///
/// <para>
/// **Layout:**
/// <list type="bullet">
///   <item>Driver: <c>external/holtburger/apps/holtburger-web/run-all-validators.cjs</c></item>
///   <item>Aggregate root: <c>/mnt/wbterminal1/holtburger-validator-reports/diag-run-all/&lt;ts&gt;/</c></item>
///   <item>Files in aggregate dir: <c>aggregate.json</c>, <c>summary.md</c>, <c>logs/&lt;surface&gt;.log</c></item>
/// </list>
/// </para>
///
/// <para>
/// **See also:**
/// <list type="bullet">
///   <item>Plan: <c>docs/diagnostic-toolset-plan-2026-05-19.md</c> §6 Wave 5.C</item>
///   <item>Umbrella method: <c>docs/diagnostic-toolset-method.md</c></item>
///   <item>Subprocess template: <c>CommandEngine.cs:10933 RunPython</c></item>
/// </list>
/// </para>
/// </summary>
public partial class CommandEngine {

    // ─────────────────────────────────────────────────────────────────────
    // Result records — surfaced via the JsonCommandProcessor wrappers in
    // WAVE5C_DISPATCH_PENDING.patch.
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// One row per surface in the aggregate. Mirrors the Node driver's
    /// per-surface object shape so the JSON round-trips cleanly.
    /// </summary>
    /// <param name="Surface">Canonical surface slug — e.g. "wire-conformance".</param>
    /// <param name="Status">"PASS" | "FAIL" | "SKIP_NOT_SHIPPED" | "INFRA".</param>
    /// <param name="ExitCode">Validator subprocess exit code, or null for skip.</param>
    /// <param name="ReportJsonPath">Path to the validator's own report.json, or null.</param>
    /// <param name="DurationMs">Wall-clock duration of the validator subprocess.</param>
    /// <param name="MismatchCount">If derivable from the validator's report; null otherwise.</param>
    /// <param name="Notes">Free-form note from the driver's row definition.</param>
    /// <param name="LogPath">Per-surface stdout/stderr capture path.</param>
    /// <param name="Script">Validator filename (without dir).</param>
    /// <param name="Args">Args passed to the validator subprocess.</param>
    /// <param name="InfraError">Set when status=INFRA; explains why.</param>
    public sealed record DiagSurfaceResult(
        string Surface,
        string Status,
        int? ExitCode,
        string? ReportJsonPath,
        long DurationMs,
        int? MismatchCount,
        string? Notes,
        string? LogPath,
        string? Script,
        IReadOnlyList<string>? Args,
        string? InfraError);

    /// <summary>
    /// Top-level aggregate for <c>diag-run-all</c>. Carries enough state
    /// for a CI gate decision + a follow-up <c>diag-status</c> read.
    /// </summary>
    /// <param name="AggregateJsonPath">Full path to the written aggregate.json.</param>
    /// <param name="SummaryMarkdownPath">Full path to the written summary.md.</param>
    /// <param name="CheckedSurfaces">Total surfaces inventoried.</param>
    /// <param name="PassedSurfaces">Surfaces that returned exit 0.</param>
    /// <param name="FailedSurfaces">Surfaces that returned exit 1 (real drift).</param>
    /// <param name="SkippedSurfaces">Surfaces skipped (--skip OR not-yet-shipped) total.</param>
    /// <param name="SkippedNotShipped">Surfaces SKIP-not-yet-shipped subset.</param>
    /// <param name="SkippedCli">Surfaces skipped via --skip CLI flag subset.</param>
    /// <param name="InfraSurfaces">Surfaces in INFRA state (exit 2+, timeout, parse failure).</param>
    /// <param name="RequiredFailures">FAIL+INFRA count for required surfaces. Drives the gate.</param>
    /// <param name="Wave4Mode">"fast" or "full".</param>
    /// <param name="ElapsedMs">Wall-clock of the whole run.</param>
    /// <param name="DriverExitCode">Exit code of the Node driver itself.</param>
    /// <param name="DriverError">Non-null when the driver itself crashed.</param>
    /// <param name="Surfaces">Per-surface row list.</param>
    public sealed record DiagRunAllResult(
        string AggregateJsonPath,
        string SummaryMarkdownPath,
        int CheckedSurfaces,
        int PassedSurfaces,
        int FailedSurfaces,
        int SkippedSurfaces,
        int SkippedNotShipped,
        int SkippedCli,
        int InfraSurfaces,
        int RequiredFailures,
        string Wave4Mode,
        long ElapsedMs,
        int DriverExitCode,
        string? DriverError,
        IReadOnlyList<DiagSurfaceResult> Surfaces);

    // ─────────────────────────────────────────────────────────────────────
    // Constants.
    // ─────────────────────────────────────────────────────────────────────

    private static readonly TimeSpan DiagRunAllTimeout = TimeSpan.FromHours(2);
    private const string DiagAggregateReportRoot =
        "/mnt/wbterminal1/holtburger-validator-reports/diag-run-all";
    private const string DiagDriverScriptRelative =
        "external/holtburger/apps/holtburger-web/run-all-validators.cjs";

    // ─────────────────────────────────────────────────────────────────────
    // Public commands — invoked from JsonCommandProcessor wrappers.
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Runs the full diagnostic suite. Subprocesses the Node driver and
    /// parses its aggregate.json. Returns a structured result.
    ///
    /// <para>
    /// **Failure semantics:**
    /// <list type="bullet">
    ///   <item>If the Node driver itself crashes (script missing, node missing,
    ///     subprocess timeout): <c>DriverExitCode</c> reflects the crash and
    ///     <c>DriverError</c> carries the message. The aggregate file may
    ///     still exist (driver may have written partial state before
    ///     crashing).</item>
    ///   <item>If individual validators FAIL/INFRA but the driver completes:
    ///     <c>DriverExitCode</c> is 1 (for required failure) or 0; the
    ///     per-surface rows carry the detail.</item>
    /// </list>
    /// </para>
    /// </summary>
    /// <param name="wave4Mode">"fast" (default) or "full".</param>
    /// <param name="reportDir">Override aggregate output dir; null = default.</param>
    /// <param name="skipSurfaces">Surfaces to pass to the driver via --skip=.</param>
    /// <param name="parallel">Run validators in parallel rather than sequential.</param>
    public DiagRunAllResult DiagRunAll(
        string? wave4Mode = null,
        string? reportDir = null,
        IReadOnlyList<string>? skipSurfaces = null,
        bool parallel = false) {

        var sw = Stopwatch.StartNew();
        var mode = string.IsNullOrWhiteSpace(wave4Mode) ? "fast" : wave4Mode;
        if (mode != "fast" && mode != "full") {
            throw new ArgumentException(
                $"wave4Mode must be 'fast' or 'full'; got '{wave4Mode}'");
        }

        // Locate the driver script. Walk up from CWD + AppContext.BaseDirectory.
        var driverScript = ResolveDiagDriverScript();
        if (driverScript == null) {
            return new DiagRunAllResult(
                AggregateJsonPath: "",
                SummaryMarkdownPath: "",
                CheckedSurfaces: 0,
                PassedSurfaces: 0,
                FailedSurfaces: 0,
                SkippedSurfaces: 0,
                SkippedNotShipped: 0,
                SkippedCli: 0,
                InfraSurfaces: 0,
                RequiredFailures: 0,
                Wave4Mode: mode,
                ElapsedMs: sw.ElapsedMilliseconds,
                DriverExitCode: -1,
                DriverError: $"Driver script not found: {DiagDriverScriptRelative}. " +
                             "Set WORLDBUILDER_DIAG_DRIVER or run from a worldbuilder checkout.",
                Surfaces: Array.Empty<DiagSurfaceResult>());
        }

        // Compose the driver command.
        var args = new List<string> { driverScript };
        args.Add($"--wave4-mode={mode}");
        if (!string.IsNullOrWhiteSpace(reportDir)) {
            args.Add($"--report-dir={reportDir}");
        }
        if (parallel) args.Add("--parallel");
        if (skipSurfaces != null) {
            foreach (var s in skipSurfaces) {
                if (!string.IsNullOrWhiteSpace(s)) args.Add($"--skip={s}");
            }
        }

        // Run the driver as `node <driverScript> ...`.
        string stdoutText;
        string stderrText;
        int exitCode;
        bool timedOut;
        try {
            (stdoutText, stderrText, exitCode, timedOut) = RunNode(args, DiagRunAllTimeout);
        } catch (Exception ex) {
            return new DiagRunAllResult(
                AggregateJsonPath: "",
                SummaryMarkdownPath: "",
                CheckedSurfaces: 0,
                PassedSurfaces: 0,
                FailedSurfaces: 0,
                SkippedSurfaces: 0,
                SkippedNotShipped: 0,
                SkippedCli: 0,
                InfraSurfaces: 0,
                RequiredFailures: 0,
                Wave4Mode: mode,
                ElapsedMs: sw.ElapsedMilliseconds,
                DriverExitCode: -1,
                DriverError: $"Failed to launch node: {ex.Message}",
                Surfaces: Array.Empty<DiagSurfaceResult>());
        }

        // Find the aggregate.json. Drivers write to either the explicit
        // reportDir or to the canonical timestamped dir. If the operator
        // overrode reportDir, use that; otherwise scan for the newest
        // <ts>/aggregate.json under the canonical root.
        var aggregateRoot = string.IsNullOrWhiteSpace(reportDir)
            ? DiagAggregateReportRoot
            : reportDir!;
        string? aggregateJsonPath;
        if (!string.IsNullOrWhiteSpace(reportDir)) {
            // Caller-provided dir: aggregate.json should land at the root.
            var candidate = Path.Combine(reportDir!, "aggregate.json");
            aggregateJsonPath = File.Exists(candidate) ? candidate : null;
        } else {
            aggregateJsonPath = FindLatestAggregateJson(aggregateRoot);
        }

        if (aggregateJsonPath == null) {
            return new DiagRunAllResult(
                AggregateJsonPath: "",
                SummaryMarkdownPath: "",
                CheckedSurfaces: 0,
                PassedSurfaces: 0,
                FailedSurfaces: 0,
                SkippedSurfaces: 0,
                SkippedNotShipped: 0,
                SkippedCli: 0,
                InfraSurfaces: 0,
                RequiredFailures: 0,
                Wave4Mode: mode,
                ElapsedMs: sw.ElapsedMilliseconds,
                DriverExitCode: exitCode,
                DriverError: timedOut
                    ? $"Driver exceeded {DiagRunAllTimeout.TotalMinutes:F0}-minute timeout and was killed."
                    : $"Driver finished (exit={exitCode}) but no aggregate.json was found under {aggregateRoot}.\n" +
                      $"stdout (tail): {Tail(stdoutText, 1500)}\n" +
                      $"stderr (tail): {Tail(stderrText, 1500)}",
                Surfaces: Array.Empty<DiagSurfaceResult>());
        }

        // Parse it.
        var parsed = ParseAggregateFile(aggregateJsonPath);
        return parsed with {
            ElapsedMs = sw.ElapsedMilliseconds,
            DriverExitCode = exitCode,
            DriverError = timedOut
                ? "Driver timed out — aggregate may reflect partial state."
                : null,
        };
    }

    /// <summary>
    /// Read-only: find the most recent diag-run-all aggregate and return
    /// its parsed shape. No subprocess invoked.
    ///
    /// <para>
    /// Throws if no aggregate exists yet — that's a hard signal that the
    /// operator hasn't run <c>diag-run-all</c> on this box at all.
    /// </para>
    /// </summary>
    public DiagRunAllResult DiagStatus() {
        var path = FindLatestAggregateJson(DiagAggregateReportRoot);
        if (path == null) {
            throw new InvalidOperationException(
                $"No diag-run-all aggregate found under {DiagAggregateReportRoot}. " +
                "Run `diag-run-all` first.");
        }
        return ParseAggregateFile(path);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Internals.
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Walks up from CWD + assembly location looking for the canonical
    /// driver script path. Also honors <c>WORLDBUILDER_DIAG_DRIVER</c>
    /// env var (mirrors <c>WORLDBUILDER_COMPARATOR_PY</c>).
    /// </summary>
    private static string? ResolveDiagDriverScript() {
        var envPath = System.Environment.GetEnvironmentVariable("WORLDBUILDER_DIAG_DRIVER");
        if (!string.IsNullOrEmpty(envPath) && File.Exists(envPath)) return envPath;

        foreach (var anchor in new[] {
            System.Environment.CurrentDirectory,
            AppContext.BaseDirectory,
        }) {
            string? dir = anchor;
            for (int i = 0; i < 10 && dir != null; i++) {
                var candidate = Path.Combine(dir, DiagDriverScriptRelative);
                if (File.Exists(candidate)) return candidate;
                dir = Path.GetDirectoryName(dir);
            }
        }
        return null;
    }

    /// <summary>
    /// Find the most-recently-modified <c>&lt;ts&gt;/aggregate.json</c> under
    /// the canonical diag-run-all root. Returns null if none exist.
    /// </summary>
    private static string? FindLatestAggregateJson(string root) {
        if (!Directory.Exists(root)) return null;
        string? best = null;
        DateTime bestMtime = DateTime.MinValue;
        foreach (var dir in Directory.EnumerateDirectories(root)) {
            var candidate = Path.Combine(dir, "aggregate.json");
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
    /// Parse the aggregate.json into our typed result.
    ///
    /// <para>
    /// **Defensive:** the aggregate is written by the Node driver, but we
    /// also want this to be reasonably robust against schema changes from
    /// future driver versions. Unknown fields are ignored; missing
    /// optional fields land as null.
    /// </para>
    /// </summary>
    private static DiagRunAllResult ParseAggregateFile(string aggregateJsonPath) {
        string raw;
        try {
            raw = File.ReadAllText(aggregateJsonPath);
        } catch (Exception ex) {
            return new DiagRunAllResult(
                AggregateJsonPath: aggregateJsonPath,
                SummaryMarkdownPath: "",
                CheckedSurfaces: 0,
                PassedSurfaces: 0,
                FailedSurfaces: 0,
                SkippedSurfaces: 0,
                SkippedNotShipped: 0,
                SkippedCli: 0,
                InfraSurfaces: 0,
                RequiredFailures: 0,
                Wave4Mode: "",
                ElapsedMs: 0,
                DriverExitCode: -1,
                DriverError: $"Failed to read aggregate.json: {ex.Message}",
                Surfaces: Array.Empty<DiagSurfaceResult>());
        }

        JsonDocument doc;
        try {
            doc = JsonDocument.Parse(raw);
        } catch (Exception ex) {
            return new DiagRunAllResult(
                AggregateJsonPath: aggregateJsonPath,
                SummaryMarkdownPath: "",
                CheckedSurfaces: 0,
                PassedSurfaces: 0,
                FailedSurfaces: 0,
                SkippedSurfaces: 0,
                SkippedNotShipped: 0,
                SkippedCli: 0,
                InfraSurfaces: 0,
                RequiredFailures: 0,
                Wave4Mode: "",
                ElapsedMs: 0,
                DriverExitCode: -1,
                DriverError: $"Failed to parse aggregate.json: {ex.Message}",
                Surfaces: Array.Empty<DiagSurfaceResult>());
        }
        using var _doc = doc;
        var root = doc.RootElement;

        var summaryMdPath = Path.Combine(
            Path.GetDirectoryName(aggregateJsonPath) ?? "",
            "summary.md");

        var summaryEl = root.GetProperty("summary");
        int checkedCount = summaryEl.TryGetProperty("checked", out var c) ? c.GetInt32() : 0;
        int passCount = summaryEl.TryGetProperty("pass", out var p) ? p.GetInt32() : 0;
        int failCount = summaryEl.TryGetProperty("fail", out var f) ? f.GetInt32() : 0;
        int skipCount = summaryEl.TryGetProperty("skipped", out var sk) ? sk.GetInt32() : 0;
        int skipShipCount = summaryEl.TryGetProperty("skippedShip", out var ss) ? ss.GetInt32() : 0;
        int skipCliCount = summaryEl.TryGetProperty("skippedCli", out var sc) ? sc.GetInt32() : 0;
        int infraCount = summaryEl.TryGetProperty("infra", out var inf) ? inf.GetInt32() : 0;
        int reqFailures = summaryEl.TryGetProperty("requiredFailures", out var rf) ? rf.GetInt32() : 0;

        string mode = "";
        if (root.TryGetProperty("options", out var opts) &&
            opts.TryGetProperty("wave4Mode", out var w4)) {
            mode = w4.GetString() ?? "";
        }

        long elapsedMs = 0;
        if (root.TryGetProperty("elapsedMs", out var em)) {
            elapsedMs = em.GetInt64();
        }

        var surfaces = new List<DiagSurfaceResult>();
        if (root.TryGetProperty("surfaces", out var sfArr) &&
            sfArr.ValueKind == JsonValueKind.Array) {
            foreach (var s in sfArr.EnumerateArray()) {
                surfaces.Add(ParseSurfaceRow(s));
            }
        }

        return new DiagRunAllResult(
            AggregateJsonPath: aggregateJsonPath,
            SummaryMarkdownPath: summaryMdPath,
            CheckedSurfaces: checkedCount,
            PassedSurfaces: passCount,
            FailedSurfaces: failCount,
            SkippedSurfaces: skipCount,
            SkippedNotShipped: skipShipCount,
            SkippedCli: skipCliCount,
            InfraSurfaces: infraCount,
            RequiredFailures: reqFailures,
            Wave4Mode: mode,
            ElapsedMs: elapsedMs,
            DriverExitCode: 0, // overwritten by caller in DiagRunAll
            DriverError: null,
            Surfaces: surfaces);
    }

    private static DiagSurfaceResult ParseSurfaceRow(JsonElement s) {
        string surface = s.TryGetProperty("surface", out var sv) ? (sv.GetString() ?? "") : "";
        string status = s.TryGetProperty("status", out var st) ? (st.GetString() ?? "") : "";
        int? exitCode = null;
        if (s.TryGetProperty("exitCode", out var ec) && ec.ValueKind == JsonValueKind.Number) {
            exitCode = ec.GetInt32();
        }
        string? reportJsonPath = null;
        if (s.TryGetProperty("reportJsonPath", out var rp) && rp.ValueKind == JsonValueKind.String) {
            reportJsonPath = rp.GetString();
        }
        long durationMs = 0;
        if (s.TryGetProperty("durationMs", out var dm) && dm.ValueKind == JsonValueKind.Number) {
            durationMs = dm.GetInt64();
        }
        int? mismatchCount = null;
        if (s.TryGetProperty("mismatchCount", out var mm) && mm.ValueKind == JsonValueKind.Number) {
            mismatchCount = mm.GetInt32();
        }
        string? notes = null;
        if (s.TryGetProperty("notes", out var nt) && nt.ValueKind == JsonValueKind.String) {
            notes = nt.GetString();
        }
        string? logPath = null;
        if (s.TryGetProperty("logPath", out var lp) && lp.ValueKind == JsonValueKind.String) {
            logPath = lp.GetString();
        }
        string? script = null;
        if (s.TryGetProperty("script", out var sc) && sc.ValueKind == JsonValueKind.String) {
            script = sc.GetString();
        }
        IReadOnlyList<string>? args = null;
        if (s.TryGetProperty("args", out var ar) && ar.ValueKind == JsonValueKind.Array) {
            var list = new List<string>();
            foreach (var a in ar.EnumerateArray()) {
                if (a.ValueKind == JsonValueKind.String) list.Add(a.GetString() ?? "");
            }
            args = list;
        }
        string? infraError = null;
        if (s.TryGetProperty("infraError", out var ie) && ie.ValueKind == JsonValueKind.String) {
            infraError = ie.GetString();
        }

        return new DiagSurfaceResult(
            Surface: surface,
            Status: status,
            ExitCode: exitCode,
            ReportJsonPath: reportJsonPath,
            DurationMs: durationMs,
            MismatchCount: mismatchCount,
            Notes: notes,
            LogPath: logPath,
            Script: script,
            Args: args,
            InfraError: infraError);
    }

    /// <summary>
    /// Subprocess <c>node</c> with the given args. Mirrors
    /// <c>RunPython</c> at <c>CommandEngine.cs:10933</c> — same async
    /// read pattern, same SIGKILL-on-timeout discipline.
    /// </summary>
    private static (string Stdout, string Stderr, int ExitCode, bool TimedOut) RunNode(
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

    private static string Tail(string s, int maxChars) {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Length <= maxChars ? s : s.Substring(s.Length - maxChars);
    }
}
