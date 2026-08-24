using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows;

namespace AcmeLauncher {
    /// <summary>
    /// Entry point. With no action flags it opens the window; with a scriptable
    /// action (<c>--list</c>, <c>--play</c>, <c>--play-plugins</c>,
    /// <c>--attach &lt;pid&gt;</c>, <c>--attach-all</c>, <c>--tune k=v …</c>) it
    /// runs headless and exits with a code — so the same program automates as
    /// well as it clicks. Every action is a thin wrapper over the same backbone
    /// the GUI uses.
    /// </summary>
    public sealed class App : Application {
        [DllImport("kernel32.dll")] private static extern bool AttachConsole(int pid);
        private const int ATTACH_PARENT_PROCESS = -1;

        [STAThread]
        public static int Main(string[] argv) {
            var settings = Settings.Load();
            var back = new Backbone(settings);

            // This is a WinExe, so it isn't attached to the caller's console by
            // default — a CLI invocation would print nowhere. Attach to the parent
            // console for the scriptable paths so `AcmeLauncher.exe --list` etc.
            // actually print. Harmless if there is no parent console.
            if (argv.Length > 0) { try { AttachConsole(ATTACH_PARENT_PROCESS); } catch { } }

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
            if (HasFlag(argv, "--play") || HasFlag(argv, "--play-plugins")) {
                var exe = AcclientPath(settings);
                if (exe == null) { Console.Error.WriteLine("install folder / acclient.exe not set"); return 2; }
                var args = ClientArgs(settings);
                return Report(HasFlag(argv, "--play-plugins") ? back.PlayWithPlugins(exe, args) : back.PlayPlain(exe, args));
            }
            var tuneIdx = IndexOf(argv, "--tune");
            if (tuneIdx >= 0) {
                var path = Knobs.ResolveCfgPath(forWrite: true);
                int n = 0, bad = 0;
                for (int i = tuneIdx + 1; i < argv.Length; i++) {
                    var kv = argv[i];
                    int eq = kv.IndexOf('=');
                    if (eq <= 0) break;   // stop at the first non key=val token
                    var key = kv.Substring(0, eq);
                    if (!float.TryParse(kv.Substring(eq + 1), NumberStyles.Float, CultureInfo.InvariantCulture, out var v)) {
                        Console.Error.WriteLine($"--tune: bad value in '{kv}'"); bad++; continue;
                    }
                    // Validate against the known knobs and clamp to the plugin's own range, so the
                    // scriptable path keeps the "clamped to the plugin's ranges" promise the UI makes.
                    var knob = System.Array.Find(Knobs.All, k => k.Name.Equals(key, StringComparison.OrdinalIgnoreCase));
                    if (knob == null) { Console.Error.WriteLine($"--tune: unknown knob '{key}'"); bad++; continue; }
                    float cv = Math.Clamp(v, knob.Min, knob.Max);
                    if (cv != v) Console.Error.WriteLine($"--tune: {key} {v} clamped to {cv} (range {knob.Min}..{knob.Max})");
                    Knobs.WriteKnob(path, knob.Name, cv);
                    n++;
                }
                Console.WriteLine($"wrote {n} knob(s) to {path}");
                return bad == 0 && n > 0 ? 0 : 2;
            }

            // Any leftover args didn't match a headless verb — don't silently pop the GUI.
            if (argv.Length > 0) {
                Console.Error.WriteLine("Unknown option. Usage: AcmeLauncher "
                    + "[--list | --play | --play-plugins | --attach <pid> | --attach-all | --tune k=v ...]  "
                    + "(no arguments launches the GUI)");
                return 2;
            }

            // ---- GUI ----
            var app = new App();
            var win = Ui.Build(settings, back);
            return app.Run(win);
        }

        internal static string? AcclientPath(Settings s) {
            if (!string.IsNullOrEmpty(s.InstallDir)) {
                var p = System.IO.Path.Combine(s.InstallDir!, "acclient.exe");
                if (System.IO.File.Exists(p)) return p;
            }
            return null;
        }

        internal static string ClientArgs(Settings s) {
            var server = s.Server ?? "";
            var acct = s.Account ?? "";
            var rodat = s.Rodat ? "on" : "off";
            // Match the ACE convention: -h <server> -a <account> -rodat on. Password
            // is deliberately NOT persisted; the login screen takes it (or the
            // player types it). This mirrors what ThwargLauncher generates.
            var a = "";
            if (server.Length > 0) a += $"-h {server} ";
            if (acct.Length > 0) a += $"-a {acct} ";
            a += $"-rodat {rodat}";
            return a.Trim();
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
