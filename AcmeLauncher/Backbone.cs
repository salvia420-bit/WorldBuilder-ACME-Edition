using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace AcmeLauncher {
    /// <summary>
    /// The ONLY bridge to the injector. Everything process-related — enumerating
    /// clients, spawn-injecting, attaching — goes through AcmeInject.exe so the
    /// launcher carries no injection code of its own. Locates AcmeInject.exe next
    /// to us, then in a few well-known spots, then a saved path.
    /// </summary>
    internal sealed class Backbone {
        public sealed class Client {
            public int Pid;
            public bool? Injected;   // true = injected, false = plain, null = state unknown (scan failed)
            public string ExePath = "";
            public string WindowTitle = "";
            public string InstallDir => string.IsNullOrEmpty(ExePath) ? "" : (Path.GetDirectoryName(ExePath) ?? "");
        }

        public sealed class RunResult {
            public int ExitCode;
            public string StdOut = "";
            public string StdErr = "";
            public bool Ran;             // false = we couldn't even start the process
            public string Message => Ran ? (StdErr.Length > 0 ? StdErr : StdOut) : StdOut;
        }

        private readonly Settings _settings;
        public Backbone(Settings settings) { _settings = settings; }

        /// <summary>Absolute path to AcmeInject.exe, or null if we can't find it.
        /// Order: saved path → beside the launcher → C:\Games\Chorizite → the
        /// install dir the player configured.</summary>
        public string? FindInjector() {
            var candidates = new List<string?> {
                _settings.InjectorPath,
                Path.Combine(AppContext.BaseDirectory, "AcmeInject.exe"),
                @"C:\Games\Chorizite\AcmeInject.exe",
            };
            if (!string.IsNullOrEmpty(_settings.ChoriziteDir))
                candidates.Add(Path.Combine(_settings.ChoriziteDir!, "AcmeInject.exe"));
            foreach (var c in candidates)
                if (!string.IsNullOrEmpty(c) && File.Exists(c)) return c;
            return null;
        }

        /// <summary>Run AcmeInject with args, capturing output. workDir defaults to
        /// the injector's folder (so its CWD-relative Chorizite.Injector.dll
        /// resolves). Never throws.</summary>
        public RunResult RunInjector(string args, string? workDir = null) {
            var exe = FindInjector();
            if (exe == null)
                return new RunResult { Ran = false, StdOut = "AcmeInject.exe not found — set its location on the Install tab." };
            return Run(exe, args, workDir ?? Path.GetDirectoryName(exe));
        }

        /// <summary>`--list` → parsed clients. Empty list on any failure (the UI
        /// shows "no clients"); check LastListError for the reason.</summary>
        public string? LastListError { get; private set; }
        public List<Client> ListClients() {
            LastListError = null;
            var res = RunInjector("--list");
            var outp = new List<Client>();
            if (!res.Ran) { LastListError = res.Message; return outp; }
            foreach (var raw in res.StdOut.Split('\n')) {
                var line = raw.TrimEnd('\r');
                if (!line.StartsWith("CLIENT\t")) continue;
                var f = line.Split('\t');
                // CLIENT \t pid \t injected \t exePath \t windowTitle
                if (f.Length < 5) continue;
                if (!int.TryParse(f[1], out int pid)) continue;
                outp.Add(new Client {
                    Pid = pid,
                    // Field 3 is 1|0|? — preserve the tri-state; ? = AcmeInject couldn't
                    // determine the injection state (its deliberate fail-safe), NOT "plain".
                    Injected = f[2] == "1" ? true : f[2] == "0" ? false : (bool?)null,
                    ExePath = f[3],
                    WindowTitle = f[4],
                });
            }
            return outp;
        }

        public RunResult AttachPid(int pid) => RunInjector($"--attach {pid}");
        public RunResult AttachAll() => RunInjector("--attach-all");

        // ---- process helpers ----

        /// <summary>Result of a stream read that may not have finished (timeout/kill path);
        /// waits briefly, returns what's there, never hangs.</summary>
        private static string SafeResult(System.Threading.Tasks.Task<string> t) {
            try { return t.Wait(1000) ? t.Result : ""; } catch { return ""; }
        }

        private static RunResult Run(string exe, string args, string? workDir) {
            try {
                var psi = new ProcessStartInfo {
                    FileName = exe, Arguments = args,
                    UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    WorkingDirectory = workDir ?? Environment.CurrentDirectory,
                };
                using var p = Process.Start(psi);
                if (p == null) return new RunResult { Ran = false, StdOut = "could not start " + exe };
                // Read both streams concurrently (async) so neither pipe buffer can fill and
                // deadlock the sequential-ReadToEnd pattern.
                var soT = p.StandardOutput.ReadToEndAsync();
                var seT = p.StandardError.ReadToEndAsync();
                if (!p.WaitForExit(120_000)) {
                    try { p.Kill(); } catch { }
                    return new RunResult { Ran = true, ExitCode = -1, StdOut = SafeResult(soT), StdErr = SafeResult(seT) + "\n(timed out)" };
                }
                string so = soT.GetAwaiter().GetResult();
                string se = seT.GetAwaiter().GetResult();
                return new RunResult { Ran = true, ExitCode = p.ExitCode, StdOut = so, StdErr = se };
            }
            catch (Exception ex) {
                return new RunResult { Ran = false, StdOut = ex.Message };
            }
        }

    }
}
