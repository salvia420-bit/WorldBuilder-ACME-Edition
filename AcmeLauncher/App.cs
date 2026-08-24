using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows;

namespace AcmeLauncher {
    /// <summary>
    /// z-z patcher entry point. No arguments opens the window; any command below runs
    /// headless and exits with a code — the FULL GUI surface is scriptable (owner directive
    /// 2026-08-24: every action/query the tabs offer must work identically from the command
    /// line, on Windows and under Wine — where the WPF GUI does not run at all, the CLI is
    /// the ONLY surface). Run <c>--help</c> for the command table. The tool never launches
    /// the game and never handles a login — players start Asheron's Call with their own
    /// launcher; this only manages the ACME plugin layer on already-running clients, tunes
    /// the cfgs, and checks/patches the install.
    ///
    /// ONE command per invocation: passing two commands is an error (exit 2, naming both) —
    /// silently discarding one would be the worst outcome for a batch file. Modifiers:
    /// --yes, --apply, --dxvk. Exit codes: 0 ok · 1 check ran, something non-OK · 2 usage /
    /// bad argument · 3 unsupported on this platform (Wine's powershell/dotnet are stubs) ·
    /// 4 destructive command needs --yes · plus AcmeInject's own codes passed through by
    /// --attach[-all] (23 already-injected · 24 no-clients · 25 partial · 26
    /// unknown-state-refused · 27 enumerate-failed).
    /// </summary>
    public sealed class App : Application {
        [DllImport("kernel32.dll")] private static extern bool AttachConsole(int pid);
        private const int ATTACH_PARENT_PROCESS = -1;
        [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int n);
        [DllImport("kernel32.dll")] private static extern uint GetFileType(IntPtr h);
        private const int STD_OUTPUT_HANDLE = -11;
        private const uint FILE_TYPE_UNKNOWN = 0;

        /// <summary>Every command flag (NOT the modifiers) — the one-command-per-run guard
        /// scans argv against this list.</summary>
        private static readonly string[] Verbs = {
            "--list", "--attach", "--attach-all", "--status", "--plugins",
            "--enable-plugin", "--disable-plugin", "--install-plugin", "--uninstall-plugin",
            "--knobs", "--get", "--tune", "--reset", "--reset-all", "--recommended",
            "--save-profile", "--load-profile",
            "--verify-exe", "--patch-exe", "--check-dats", "--check-prefs", "--tail-log",
            "--rollback", "--fix-wine",
            "--paths", "--set-install-dir", "--set-chorizite-dir", "--check-dotnet",
        };

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

            // ---- scriptable, headless paths (one command per run; modifiers --yes/--apply/--dxvk) ----
            if (HasFlag(argv, "--help") || HasFlag(argv, "-h") || HasFlag(argv, "/?")) { PrintHelp(); return 0; }

            // One-command guard: two verbs in one argv is ambiguous — refuse, naming both.
            // (Verb-looking VALUES can't reach here: every value-taking flag rejects a
            // "--…" value below, so e.g. `--save-profile --recommended` errors on the
            // missing value / this guard, never writes a file named "--recommended".)
            {
                string? first = null;
                foreach (var a in argv) {
                    if (Array.IndexOf(Verbs, a) < 0) continue;
                    if (first == null) { first = a; continue; }
                    if (a != first) { Console.Error.WriteLine($"one command per run: got both {first} and {a} — run --help"); return 2; }
                }
            }

            // ── Plugins tab ──
            if (HasFlag(argv, "--list")) {
                foreach (var c in back.ListClients())
                    Console.WriteLine($"{c.Pid}\t{(c.Injected == true ? "injected" : c.Injected == false ? "plain" : "unknown")}\t{c.WindowTitle}\t{c.ExePath}");
                if (back.LastListError != null) { Console.Error.WriteLine(back.LastListError); return 2; }
                return 0;
            }
            if (HasFlag(argv, "--status")) {
                // The Plugins tab's per-client health line, headless. Light spelling is the
                // enum's: grey|green|amber|red (note "grey").
                var cs = back.ListClients();
                foreach (var c in cs) {
                    var h = Status.Read(settings, c.Pid, c.Injected);
                    Console.WriteLine($"STATUS\t{c.Pid}\t{h.Light.ToString().ToLowerInvariant()}\t{h.Summary}");
                }
                if (back.LastListError != null) { Console.Error.WriteLine(back.LastListError); return 2; }
                return cs.Count > 0 ? 0 : 1;
            }
            if (HasFlag(argv, "--attach-all")) return Report(back.AttachAll());
            switch (Val(argv, "--attach", out var attach)) {
                case ValGot.Err: return 2;
                case ValGot.Ok:
                    if (!int.TryParse(attach, out int pid)) { Console.Error.WriteLine("bad --attach pid"); return 2; }
                    return Report(back.AttachPid(pid));
            }
            if (HasFlag(argv, "--plugins")) {
                var dir = Actions.ChoriziteDirOrDefault(settings);
                if (!System.IO.Directory.Exists(dir)) { Console.Error.WriteLine($"Plugin runtime folder not found: {dir} — set it with --set-chorizite-dir."); return 2; }
                foreach (var p in PluginMgmt.Enumerate(dir)) {
                    var path = System.IO.Path.Combine(p.Enabled ? PluginMgmt.EnabledDir(dir) : PluginMgmt.DisabledDir(dir), p.Folder);
                    // Tab-separated like --list (folder names may contain spaces); optional
                    // 5th field flags a folder Chorizite will not load.
                    Console.WriteLine($"PLUGIN\t{p.Folder}\t{(p.Enabled ? "enabled" : "disabled")}\t{path}" + (p.HasManifest ? "" : "\tno-manifest"));
                }
                return 0;
            }
            switch (Val(argv, "--enable-plugin", out var enable)) { case ValGot.Err: return 2; case ValGot.Ok: return PluginSetEnabled(settings, enable!, true); }
            switch (Val(argv, "--disable-plugin", out var disable)) { case ValGot.Err: return 2; case ValGot.Ok: return PluginSetEnabled(settings, disable!, false); }
            switch (Val(argv, "--install-plugin", out var installP)) {
                case ValGot.Err: return 2;
                case ValGot.Ok:
                    if (!System.IO.Directory.Exists(installP) && !System.IO.File.Exists(installP)) { Console.Error.WriteLine($"no such file or folder: {installP}"); return 2; }
                    try {
                        var name = PluginMgmt.Install(Actions.ChoriziteDirOrDefault(settings), installP!);
                        Console.WriteLine($"installed {name} — enable plugins on a client to load it");
                        return 0;
                    }
                    catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 1; }
            }
            switch (Val(argv, "--uninstall-plugin", out var uninstallP)) {
                case ValGot.Err: return 2;
                case ValGot.Ok:
                    if (uninstallP!.Equals("AcmeLights", StringComparison.OrdinalIgnoreCase))
                        Console.Error.WriteLine("WARNING: " + Actions.LightsUninstallWarning);
                    if (!HasFlag(argv, "--yes")) {
                        Console.WriteLine($"would DELETE the plugin folder '{uninstallP}' from disk — add --yes to confirm");
                        return 4;
                    }
                    try { PluginMgmt.Uninstall(Actions.ChoriziteDirOrDefault(settings), uninstallP!); Console.WriteLine($"uninstalled {uninstallP}"); return 0; }
                    catch (System.IO.DirectoryNotFoundException ex) { Console.Error.WriteLine(ex.Message + " (see --plugins)"); return 2; }
                    catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 1; }
            }

            // ── Tune tab ──
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
                    // stderr wording is byte-compatible with the pre-parity build.
                    if (Actions.TryWriteKnob(knob, rawVal, out _, out bool cl, out float fromV, out float toV) != Actions.WriteVerdict.Ok) {
                        Console.Error.WriteLine($"--tune: bad value in '{kv}'"); bad++; continue;
                    }
                    if (cl) Console.Error.WriteLine($"--tune: {key} {fromV} clamped to {toV} (range {knob.Min}..{knob.Max})");
                    n++;
                }
                Console.WriteLine($"wrote {n} knob(s)");
                MaybeWineLiveSkyHint();
                return bad == 0 && n > 0 ? 0 : 2;
            }
            var knobsIdx = IndexOf(argv, "--knobs");
            if (knobsIdx >= 0) {
                string domain = knobsIdx + 1 < argv.Length && !argv[knobsIdx + 1].StartsWith("--") ? argv[knobsIdx + 1].ToLowerInvariant() : "all";
                if (domain != "all" && Array.IndexOf(Actions.CfgNames, domain) < 0) { Console.Error.WriteLine($"--knobs: unknown cfg '{domain}' (lights|sky|ragdoll|all)"); return 2; }
                // Read only the cfg(s) actually asked for (missing files are fine — the
                // resolve is guarded; Wine matrix 2026-08-24).
                var cur = Actions.ReadCfgs(domain == "all" ? Actions.CfgNames : new[] { domain });
                foreach (var k in Cfgs.All)
                    if (domain == "all" || k.Cfg == domain) Console.WriteLine(Actions.KnobLine(k, cur));
                return 0;
            }
            var getIdx = IndexOf(argv, "--get");
            if (getIdx >= 0) {
                var names = Trailing(argv, getIdx);
                if (names.Count == 0) { Console.Error.WriteLine("--get: name at least one knob (cfg-qualified 'sky.dump' allowed)"); return 2; }
                // Resolve every name FIRST — bad names (incl. the ambiguity error) exit
                // before any file IO happens.
                var knobs = new System.Collections.Generic.List<KnobDef>();
                int bad = 0;
                foreach (var key in names) {
                    var knob = FindKnob(key, out string? err);
                    if (knob == null) { Console.Error.WriteLine("--get: " + err); bad++; continue; }
                    knobs.Add(knob);
                }
                if (knobs.Count > 0) {
                    var cfgs = new System.Collections.Generic.HashSet<string>();
                    foreach (var k in knobs) cfgs.Add(k.Cfg);
                    var cur = Actions.ReadCfgs(cfgs);
                    foreach (var k in knobs) Console.WriteLine(Actions.KnobLine(k, cur));
                }
                return bad == 0 ? 0 : 2;
            }
            var resetIdx = IndexOf(argv, "--reset");
            if (resetIdx >= 0) {
                var names = Trailing(argv, resetIdx);
                if (names.Count == 0) { Console.Error.WriteLine("--reset: name at least one knob (or use --reset-all)"); return 2; }
                int bad = 0;
                foreach (var key in names) {
                    var knob = FindKnob(key, out string? err);
                    if (knob == null) { Console.Error.WriteLine("--reset: " + err); bad++; continue; }
                    Actions.ResetKnob(knob);
                    Console.WriteLine($"reset {knob.Cfg}.{knob.Name} -> {(knob.Default.Length == 0 ? "''" : knob.Default)}");
                }
                MaybeWineLiveSkyHint();
                return bad == 0 ? 0 : 2;
            }
            var raIdx = IndexOf(argv, "--reset-all");
            if (raIdx >= 0) {
                string domain = raIdx + 1 < argv.Length && !argv[raIdx + 1].StartsWith("--") ? argv[raIdx + 1] : "all";
                int n = Actions.ResetAll(domain);
                if (n < 0) { Console.Error.WriteLine($"--reset-all: unknown cfg '{domain}' (lights|sky|ragdoll|all)"); return 2; }
                Console.WriteLine($"reset {n} knob(s) to defaults ({domain})");
                MaybeWineLiveSkyHint();
                return 0;
            }
            if (HasFlag(argv, "--recommended")) {
                int n = Actions.LoadRecommended();
                Console.WriteLine($"applied the Recommended profile ({n} knob(s))");
                MaybeWineLiveSkyHint();
                return 0;
            }
            switch (Val(argv, "--save-profile", out var saveProf)) {
                case ValGot.Err: return 2;
                case ValGot.Ok:
                    try { Actions.SaveProfile(saveProf!); Console.WriteLine($"saved {Cfgs.All.Count} knob(s) to {saveProf}"); return 0; }
                    catch (Exception ex) { Console.Error.WriteLine("--save-profile: " + ex.Message); return 2; }
            }
            switch (Val(argv, "--load-profile", out var loadProf)) {
                case ValGot.Err: return 2;
                case ValGot.Ok:
                    if (!System.IO.File.Exists(loadProf)) { Console.Error.WriteLine($"--load-profile: no such file: {loadProf}"); return 2; }
                    try {
                        var (applied, skipped) = Actions.LoadProfile(loadProf!, w => Console.Error.WriteLine("--load-profile: " + w));
                        Console.WriteLine($"applied {applied}, skipped {skipped} from {loadProf}");
                        MaybeWineLiveSkyHint();
                        return 0;
                    }
                    catch (Exception ex) { Console.Error.WriteLine("--load-profile: " + ex.Message); return 2; }
            }

            // ── Fix tab ──
            if (HasFlag(argv, "--verify-exe")) {
                if (Platform.IsWine) { Console.Error.WriteLine("not available under Wine (powershell is a stub). Run natively instead: python3 acme-patch-client.py --verify   (or --check-kit for exe+dats)"); return 3; }
                return Actions.VerifyExe(settings, Console.WriteLine);
            }
            if (HasFlag(argv, "--patch-exe")) {
                if (Platform.IsWine) { Console.Error.WriteLine("not available under Wine (powershell is a stub). Run natively instead: python3 acme-patch-client.py"); return 3; }
                return Actions.PatchExe(settings, Console.WriteLine);
            }
            if (HasFlag(argv, "--check-dats")) return Actions.CheckDats(settings, Console.WriteLine);
            if (HasFlag(argv, "--check-prefs")) return Actions.CheckPrefs(settings, Console.WriteLine);
            var tlIdx = IndexOf(argv, "--tail-log");
            if (tlIdx >= 0) {
                int? pid = null;
                if (tlIdx + 1 < argv.Length && !argv[tlIdx + 1].StartsWith("--")) {
                    if (!int.TryParse(argv[tlIdx + 1], out int p)) { Console.Error.WriteLine("--tail-log: bad pid"); return 2; }
                    pid = p;
                }
                return Actions.TailLog(settings, Console.WriteLine, pid);
            }
            if (HasFlag(argv, "--rollback")) {
                if (!HasFlag(argv, "--yes")) {
                    Console.WriteLine("would restore acclient.exe.acme-orig.bak over acclient.exe (dat backups are yours to restore by hand) — add --yes to confirm");
                    return 4;
                }
                return Actions.Rollback(settings, Console.WriteLine);
            }
            if (HasFlag(argv, "--fix-wine")) {
                // The Wine checklist (INSTALL-LINUX-WINE.md), headless. This is the supported
                // Linux surface: the WPF GUI does not run under Wine (wine 8.0, WPF stack
                // overflow — fleet-tested 2026-08-24), the CLI does.
                if (!Platform.IsWine) { Console.WriteLine("not running under Wine — nothing to do"); return 0; }
                var rows = HasFlag(argv, "--apply")
                    ? WineFixes.ApplyAll(settings, createDxvk: HasFlag(argv, "--dxvk"), Console.WriteLine)
                    : WineFixes.CheckAll(settings);
                bool allOk = true;
                foreach (var r in rows) {
                    // Advisory rows (dxvk.conf without DXVK, the plugin temp dir on a plain-client
                    // install) are situational: visibly distinct, and NOT an exit-code failure.
                    var verdict = r.Ok || !r.Advisory ? r.Verdict : "ADVISORY-" + r.Verdict;
                    Console.WriteLine($"WINEFIX {r.Name} {verdict} {r.Detail}");
                    allOk &= r.Ok || r.Advisory;
                }
                return allOk ? 0 : 1;
            }

            // ── Install tab ──
            if (HasFlag(argv, "--paths")) {
                Console.WriteLine($"install-dir   {(string.IsNullOrEmpty(settings.InstallDir) ? "(not set)" : settings.InstallDir)}");
                Console.WriteLine($"chorizite-dir {(string.IsNullOrEmpty(settings.ChoriziteDir) ? $"(not set — defaulting to {Actions.ChoriziteDirOrDefault(settings)})" : settings.ChoriziteDir)}");
                Console.WriteLine($"settings      {Actions.SettingsFilePath}");
                return 0;
            }
            switch (Val(argv, "--set-install-dir", out var setInst)) {
                case ValGot.Err: return 2;
                case ValGot.Ok:
                    // Fail on a missing dir rather than saving it — a typo'd path silently saved is
                    // the worst outcome (every later check would report against the wrong folder).
                    if (!System.IO.Directory.Exists(setInst)) { Console.Error.WriteLine($"--set-install-dir: no such directory: {setInst} (not saved)"); return 2; }
                    settings.InstallDir = setInst; settings.Save();
                    Console.WriteLine($"install-dir = {setInst}");
                    return 0;
            }
            switch (Val(argv, "--set-chorizite-dir", out var setChz)) {
                case ValGot.Err: return 2;
                case ValGot.Ok:
                    if (!System.IO.Directory.Exists(setChz)) { Console.Error.WriteLine($"--set-chorizite-dir: no such directory: {setChz} (not saved)"); return 2; }
                    settings.ChoriziteDir = setChz; settings.Save();
                    Console.WriteLine($"chorizite-dir = {setChz}");
                    return 0;
            }
            if (HasFlag(argv, "--check-dotnet")) {
                // Platform-gated like --verify-exe: a script chaining `--check-dotnet && …`
                // must not read "n/a" as "passed".
                if (Platform.IsWine) { Console.Error.WriteLine("not available under Wine (dotnet is absent there; plugins are experimental — see INSTALL-LINUX-WINE.md)"); return 3; }
                return Actions.CheckDotnet(Console.WriteLine);
            }

            if (argv.Length > 0) {
                Console.Error.WriteLine("Unknown option — run --help for the command table. (No arguments launches the GUI. This tool does not log in or launch the game.)");
                return 2;
            }

            // ---- GUI ----
            var app = new App();
            var win = Ui.Build(settings, back);
            return app.Run(win);
        }

        private static int PluginSetEnabled(Settings settings, string folder, bool want) {
            var dir = Actions.ChoriziteDirOrDefault(settings);
            if (!want && folder.Equals("AcmeLights", StringComparison.OrdinalIgnoreCase))
                Console.Error.WriteLine("WARNING: " + Actions.LightsDisableWarning + " Proceeding (headless).");
            try { PluginMgmt.SetEnabled(dir, folder, want); }
            catch (System.IO.DirectoryNotFoundException ex) { Console.Error.WriteLine(ex.Message + " (see --plugins)"); return 2; }
            catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 1; }
            Console.WriteLine($"{(want ? "enabled" : "disabled")} {folder} — takes effect the next time plugins are enabled on a client");
            return 0;
        }

        /// <summary>After any bulk/write verb that can touch sky.live: under Wine, a reset
        /// to the code default (live=1) silently re-arms the crashing live-sky path — one
        /// stderr hint keeps the user out of it. (Resetting to defaults is CORRECT behavior;
        /// only the Wine consequence needs a voice.)</summary>
        private static void MaybeWineLiveSkyHint() {
            if (!Platform.IsWine) return;
            try {
                var r = WineFixes.CheckLiveSky();
                if (!r.Ok) Console.Error.WriteLine("note: sky live is ON after this write — under Wine re-run --fix-wine --apply (the live sky faults under Wine/DXVK)");
            } catch { }
        }

        private static void PrintHelp() {
            Console.WriteLine(@"z-z patcher — plugin control panel + tuner + patcher for Asheron's Call (ACME).
No arguments opens the GUI. Every GUI action is also a command below. ONE command
per run (two commands = exit 2); modifiers: --yes --apply --dxvk.
The tool never logs in and never launches the game.

Plugins   --list                       running clients, tab-separated: pid, injected|plain|unknown, title, exe
          --status                     per-client health: STATUS <pid> <grey|green|amber|red> <summary> (tab-separated)
          --attach <pid>               enable the ACME plugins on that client
          --attach-all                 enable on every plain client
          --plugins                    PLUGIN <folder> <enabled|disabled> <path> [no-manifest] (tab-separated)
          --enable-plugin <folder>     move into plugins\   (next injection picks it up)
          --disable-plugin <folder>    move into plugins-disabled\
          --install-plugin <zip|dir>   install into plugins\
          --uninstall-plugin <folder>  DELETE the plugin folder (needs --yes)

Tune      --knobs [lights|sky|ragdoll|all]   KNOB <cfg> <name> <current> <default> <min>..<max> <type>
          --get <knob> ...             the same line for named knobs ('sky.dump' form allowed)
          --tune <knob>=<val> ...      write knobs (validated + clamped, plugins re-read ~1s)
          --reset <knob> ...           write a knob's code default back
          --reset-all [cfg|all]        defaults for one cfg or everything
          --recommended                apply the reference-machine Recommended profile
          --save-profile <file>        write all current values as a .zzp profile
          --load-profile <file>        apply a .zzp profile, validated like --tune
                                       (GUI and CLI files are interchangeable)

Fix       --verify-exe                 kit patch state of acclient.exe   (Windows; Wine -> exit 3)
          --check-dats                 dat sizes vs kit-manifest.txt
          --check-prefs                UserPreferences.ini sanity (texture detail, FullScreen)
          --tail-log [pid]             tail the plugin log(s) of injected client(s)
          --rollback                   restore the pre-patch acclient.exe (needs --yes)
          --fix-wine [--apply [--dxvk]]  the Wine checklist (no-op on Windows)

Install   --paths                      show install/chorizite dirs + settings file
          --set-install-dir <dir>      remember the game install folder (must exist)
          --set-chorizite-dir <dir>    remember the plugin runtime folder (must exist)
          --patch-exe                  run the kit patcher on acclient.exe   (Windows; Wine -> exit 3)
          --check-dotnet               is the plugin runtime's .NET desktop runtime present (Wine -> exit 3)

Exit codes  0 ok · 1 a check found problems · 2 usage/bad argument · 3 not available on
this platform · 4 destructive command run without --yes · 23-27 injector statuses
(23 already-injected, 24 no clients, 25 partial, 26 unknown-state refused, 27 enumerate failed).");
        }

        /// <summary>Resolve a knob key, accepting a cfg-qualified form "cfg.knob" (e.g.
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

        /// <summary>Positional values after a flag, up to the next --flag token.</summary>
        private static System.Collections.Generic.List<string> Trailing(string[] a, int idx) {
            var list = new System.Collections.Generic.List<string>();
            for (int i = idx + 1; i < a.Length && !a[i].StartsWith("--"); i++) list.Add(a[i]);
            return list;
        }

        private enum ValGot { Absent = 0, Ok = 1, Err = 2 }
        /// <summary>Value-taking flag: absent, present-with-value, or present with a MISSING
        /// value (next token absent or itself a --flag) — the last prints the error and the
        /// caller exits 2 (`--save-profile --recommended` must never write a file named
        /// "--recommended").</summary>
        private static ValGot Val(string[] a, string f, out string? val) {
            val = null;
            int i = IndexOf(a, f);
            if (i < 0) return ValGot.Absent;
            if (i + 1 >= a.Length || a[i + 1].StartsWith("--")) { Console.Error.WriteLine($"missing value for {f}"); return ValGot.Err; }
            val = a[i + 1];
            return ValGot.Ok;
        }

        private static bool HasFlag(string[] a, string f) { foreach (var x in a) if (x == f) return true; return false; }
        private static int IndexOf(string[] a, string f) { for (int i = 0; i < a.Length; i++) if (a[i] == f) return i; return -1; }
    }
}
