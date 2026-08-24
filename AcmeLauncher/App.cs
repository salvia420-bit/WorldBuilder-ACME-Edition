using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows;

namespace AcmeLauncher {
    /// <summary>
    /// z-z patcher entry point. No arguments opens the window; a scriptable action
    /// (<c>--list</c>, <c>--attach &lt;pid&gt;</c>, <c>--attach-all</c>, <c>--tune k=v …</c>)
    /// runs headless and exits with a code. The tool never launches the game and never
    /// handles a login — players start Asheron's Call with their own launcher; this only
    /// manages the ACME plugin layer on already-running clients, and tunes the cfgs.
    /// </summary>
    public sealed class App : Application {
        [DllImport("kernel32.dll")] private static extern bool AttachConsole(int pid);
        private const int ATTACH_PARENT_PROCESS = -1;
        [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int n);
        [DllImport("kernel32.dll")] private static extern uint GetFileType(IntPtr h);
        private const int STD_OUTPUT_HANDLE = -11;
        private const uint FILE_TYPE_UNKNOWN = 0;

        [STAThread]
        public static int Main(string[] argv) {
            var settings = Settings.Load();
            var back = new Backbone(settings);

            if (argv.Length > 0) {
                // WinExe has no console. If output is REDIRECTED (> file / pipe), stdout is already a
                // real handle — do NOT AttachConsole (it would clobber it). Only attach the parent's
                // console for an interactive run. Then rebind Console to the OS handles either way.
                IntPtr outH = GetStdHandle(STD_OUTPUT_HANDLE);
                bool redirected = outH != IntPtr.Zero && outH != new IntPtr(-1) && GetFileType(outH) != FILE_TYPE_UNKNOWN;
                if (!redirected) { try { AttachConsole(ATTACH_PARENT_PROCESS); } catch { } }
                try {
                    Console.SetOut(new System.IO.StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true });
                    Console.SetError(new System.IO.StreamWriter(Console.OpenStandardError()) { AutoFlush = true });
                } catch { }
            }

            // ---- scriptable, headless paths ----
            if (HasFlag(argv, "--list")) {
                foreach (var c in back.ListClients())
                    Console.WriteLine($"{c.Pid}\t{(c.Injected == true ? "injected" : c.Injected == false ? "plain" : "unknown")}\t{c.WindowTitle}\t{c.ExePath}");
                if (back.LastListError != null) { Console.Error.WriteLine(back.LastListError); return 2; }
                return 0;
            }
            if (HasFlag(argv, "--attach-all")) return Report(back.AttachAll());
            var attach = ArgVal(argv, "--attach");
            if (attach != null) {
                if (!int.TryParse(attach, out int pid)) { Console.Error.WriteLine("bad --attach pid"); return 2; }
                return Report(back.AttachPid(pid));
            }
            var tuneIdx = IndexOf(argv, "--tune");
            if (tuneIdx >= 0) {
                int n = 0, bad = 0;
                for (int i = tuneIdx + 1; i < argv.Length; i++) {
                    var kv = argv[i];
                    int eq = kv.IndexOf('=');
                    if (eq <= 0) break;   // stop at the first non key=val token
                    var key = kv.Substring(0, eq).Trim();
                    var rawVal = kv.Substring(eq + 1).Trim();
                    var knob = FindKnob(key, out string? findErr);
                    if (knob == null) { Console.Error.WriteLine("--tune: " + findErr); bad++; continue; }
                    string outVal = rawVal;
                    if (knob.Type == KnobType.Float || knob.Type == KnobType.Integer || knob.Type == KnobType.Toggle) {
                        if (!float.TryParse(rawVal, NumberStyles.Float, CultureInfo.InvariantCulture, out var v)) {
                            Console.Error.WriteLine($"--tune: bad value in '{kv}'"); bad++; continue;
                        }
                        if (knob.HasRange) {
                            float cv = Math.Clamp(v, knob.MinF, knob.MaxF);
                            if (cv != v) Console.Error.WriteLine($"--tune: {key} {v} clamped to {cv} (range {knob.Min}..{knob.Max})");
                            v = cv;
                        }
                        outVal = Cfgs.FormatFloat(v);
                    }
                    var path = Cfgs.ResolvePath(knob.Cfg, forWrite: true);
                    Cfgs.WriteKnob(path, knob.Name, outVal);
                    n++;
                }
                Console.WriteLine($"wrote {n} knob(s)");
                return bad == 0 && n > 0 ? 0 : 2;
            }

            if (argv.Length > 0) {
                Console.Error.WriteLine("Unknown option. Usage: zzpatcher "
                    + "[--list | --attach <pid> | --attach-all | --tune k=v ...]  "
                    + "(no arguments launches the GUI). This tool does not log in or launch the game.");
                return 2;
            }

            // ---- GUI ----
            var app = new App();
            var win = Ui.Build(settings, back);
            return app.Run(win);
        }

        /// <summary>Resolve a --tune key, accepting a cfg-qualified form "cfg.knob" (e.g.
        /// "sky.dump") to disambiguate a name that exists in more than one cfg (only "dump" today,
        /// in both lights.cfg and sky.cfg). A bare ambiguous name is refused rather than silently
        /// writing the wrong file.</summary>
        private static KnobDef? FindKnob(string key, out string? err) {
            err = null;
            string? cfg = null, name = key;
            int dot = key.IndexOf('.');
            if (dot > 0) { cfg = key.Substring(0, dot); name = key.Substring(dot + 1); }
            var matches = new System.Collections.Generic.List<KnobDef>();
            foreach (var k in Cfgs.All)
                if (k.Name.Equals(name, StringComparison.OrdinalIgnoreCase)
                    && (cfg == null || k.Cfg.Equals(cfg, StringComparison.OrdinalIgnoreCase)))
                    matches.Add(k);
            if (matches.Count == 0) { err = $"unknown knob '{key}'"; return null; }
            if (matches.Count > 1) {
                var cfgs = string.Join(", ", System.Array.ConvertAll(matches.ToArray(), m => m.Cfg + "." + m.Name));
                err = $"'{name}' exists in more than one cfg — qualify it (e.g. {cfgs})";
                return null;
            }
            return matches[0];
        }

        private static int Report(Backbone.RunResult r) {
            if (r.StdOut.Length > 0) Console.WriteLine(r.StdOut.TrimEnd());
            if (r.StdErr.Length > 0) Console.Error.WriteLine(r.StdErr.TrimEnd());
            return r.Ran ? r.ExitCode : 2;
        }

        private static bool HasFlag(string[] a, string f) { foreach (var x in a) if (x == f) return true; return false; }
        private static int IndexOf(string[] a, string f) { for (int i = 0; i < a.Length; i++) if (a[i] == f) return i; return -1; }
        private static string? ArgVal(string[] a, string f) {
            for (int i = 0; i < a.Length - 1; i++) if (a[i] == f) return a[i + 1];
            return null;
        }
    }
}
