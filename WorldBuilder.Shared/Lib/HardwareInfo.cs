using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

namespace WorldBuilder.Shared.Lib;

/// <summary>
/// Cross-platform hardware introspection. The interesting bit today is
/// <see cref="PhysicalCoreCount"/>: <see cref="Environment.ProcessorCount"/> reports
/// *logical* cores, which on hyperthreaded systems is 2× physical. For IO-parallel
/// workloads (e.g. QuickWorld Phase 3 running with per-thread DAT readers) we measured
/// degradation past the physical-core count — so capping there is the right default.
/// </summary>
public static class HardwareInfo {
    private static int? _physicalCoreCountCache;

    /// <summary>
    /// Returns the number of physical cores on the host (not logical, not SMT siblings).
    /// Cached after first call. Always &gt;= 1.
    /// </summary>
    public static int PhysicalCoreCount {
        get {
            if (_physicalCoreCountCache.HasValue) return _physicalCoreCountCache.Value;
            int detected = DetectPhysicalCoreCount();
            _physicalCoreCountCache = detected;
            return detected;
        }
    }

    private static int DetectPhysicalCoreCount() {
        int logical = Math.Max(1, Environment.ProcessorCount);

        try {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux)) {
                if (TryParseLinuxCpuInfo(out var n) && n > 0) return Math.Min(n, logical);
            } else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX)) {
                if (TrySysctlPhysicalCpu(out var n) && n > 0) return Math.Min(n, logical);
            }
            // Windows: no built-in API without P/Invoke or System.Management. Fall through.
        } catch {
            // Any detection failure → fall back to the heuristic below.
        }

        // Heuristic fallback: assume 2-way SMT when there's room for it. Single-CPU systems
        // get 1; everything else halves logical count. This is correct for nearly every modern
        // Intel/AMD desktop and server, but degrades to "off by half" on rare non-HT chips.
        return logical >= 2 ? Math.Max(1, logical / 2) : 1;
    }

    /// <summary>
    /// Parses Linux <c>/proc/cpuinfo</c> and returns the number of distinct
    /// (physical id, core id) pairs — the canonical physical-core count.
    /// Public for testing.
    /// </summary>
    internal static bool TryParseLinuxCpuInfo(out int count) {
        count = 0;
        const string path = "/proc/cpuinfo";
        if (!File.Exists(path)) return false;
        string text;
        try { text = File.ReadAllText(path); }
        catch { return false; }
        return TryParseLinuxCpuInfoText(text, out count);
    }

    /// <summary>
    /// Pure-text overload exposed for unit tests. Counts unique
    /// (<c>physical id</c>, <c>core id</c>) pairs across all <c>processor</c> blocks.
    /// </summary>
    internal static bool TryParseLinuxCpuInfoText(string cpuInfoText, out int count) {
        count = 0;
        var seen = new HashSet<(int phys, int core)>();
        int? curPhys = null, curCore = null;

        foreach (var rawLine in cpuInfoText.Split('\n')) {
            var line = rawLine.Trim();
            if (line.Length == 0) {
                // Blank line ends a processor block. Record the pair if we saw both fields.
                if (curPhys.HasValue && curCore.HasValue) seen.Add((curPhys.Value, curCore.Value));
                curPhys = null;
                curCore = null;
                continue;
            }
            int colon = line.IndexOf(':');
            if (colon < 0) continue;
            var key = line.Substring(0, colon).Trim();
            var val = line.Substring(colon + 1).Trim();
            if (string.Equals(key, "physical id", StringComparison.OrdinalIgnoreCase)) {
                if (int.TryParse(val, out var p)) curPhys = p;
            } else if (string.Equals(key, "core id", StringComparison.OrdinalIgnoreCase)) {
                if (int.TryParse(val, out var c)) curCore = c;
            }
        }
        // Trailing block (file may not end with blank line).
        if (curPhys.HasValue && curCore.HasValue) seen.Add((curPhys.Value, curCore.Value));

        count = seen.Count;
        return count > 0;
    }

    private static bool TrySysctlPhysicalCpu(out int count) {
        count = 0;
        try {
            var psi = new ProcessStartInfo("sysctl", "-n hw.physicalcpu") {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var proc = Process.Start(psi);
            if (proc == null) return false;
            string output = proc.StandardOutput.ReadToEnd().Trim();
            if (!proc.WaitForExit(2000)) {
                try { proc.Kill(); } catch { }
                return false;
            }
            return int.TryParse(output, out count) && count > 0;
        } catch {
            return false;
        }
    }
}
