using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;

namespace AcmeLauncher {
    /// <summary>
    /// THE ONE IMPLEMENTATION of every launcher action that both surfaces share: the WPF
    /// tabs call these, and the headless CLI (App.cs verb table) calls these — so the GUI
    /// and `zzpatcher --whatever` can never drift apart. Owner directive (2026-08-24):
    /// every action/query the GUI offers must be reachable headlessly, identically on
    /// Windows and under Wine (where the WPF GUI does not run at all).
    ///
    /// RULES for this file: no WPF types, no dialogs, no Console — output goes through the
    /// caller's <c>Action&lt;string&gt;</c> log and return codes; confirmation prompts are the
    /// caller's job (MessageBox in the GUI, the <c>--yes</c> gate in the CLI). Exit-code
    /// taxonomy (shared with App.cs): 0 ok · 1 check-ran-something-non-OK · 2 usage/bad
    /// arg/bad path. Platform gating (Wine's powershell/dotnet are stubs → exit 3) lives in
    /// App.cs/Ui.cs, not here.
    /// </summary>
    internal static class Actions {

        // ────────────────────────────── knobs ──────────────────────────────

        /// <summary>The named cfgs read from their RESOLVED paths (the plugins' own
        /// first-existing-candidate order) — key→raw value, empty dict when no file. Read
        /// verbs pass only the cfg(s) they need (Wine matrix 2026-08-24: touch nothing you
        /// don't have to on the read path).</summary>
        public static Dictionary<string, Dictionary<string, string>> ReadCfgs(IEnumerable<string> cfgs) {
            var cur = new Dictionary<string, Dictionary<string, string>>();
            foreach (var c in cfgs) cur[c] = Cfgs.Read(Cfgs.ResolvePath(c, forWrite: false));
            return cur;
        }
        /// <summary>All three (profile save needs the whole catalogue).</summary>
        public static Dictionary<string, Dictionary<string, string>> ReadAllCfgs() => ReadCfgs(CfgNames);
        public static readonly string[] CfgNames = { "lights", "sky", "ragdoll" };

        /// <summary>The value the plugin would see right now: the resolved cfg file's entry,
        /// else the knob's code default.</summary>
        public static string ResolvedValue(KnobDef k, Dictionary<string, Dictionary<string, string>> cur) =>
            cur.TryGetValue(k.Cfg, out var d) && d.TryGetValue(k.Name, out var v) ? v : k.Default;

        /// <summary>One greppable catalogue line: <c>KNOB cfg name current default min..max type</c>.
        /// Values are quoted only when empty or containing whitespace, so awk/grep columns hold
        /// for every real knob value.</summary>
        public static string KnobLine(KnobDef k, Dictionary<string, Dictionary<string, string>> cur) {
            static string Q(string v) => v.Length == 0 ? "''" : v.IndexOf(' ') >= 0 ? "'" + v + "'" : v;
            string range = k.HasRange ? $"{k.Min}..{k.Max}" : "-";
            return $"KNOB {k.Cfg} {k.Name} {Q(ResolvedValue(k, cur))} {Q(k.Default)} {range} {k.Type.ToString().ToLowerInvariant()}";
        }

        public enum WriteVerdict { Ok, BadValue }

        /// <summary>Validate/clamp/format one raw value for a knob and write it through the
        /// plugins' resolve chain — the single write path every surface uses. Structured
        /// result so each caller keeps ITS OWN message wording (--tune's stderr lines are
        /// byte-compatible with the pre-parity build; --load-profile and the GUI word theirs
        /// differently): BadValue = nothing written; a clamp is reported in
        /// <paramref name="clampedFrom"/>/<paramref name="clampedTo"/> (when
        /// <paramref name="clamped"/>) and IS written.</summary>
        public static WriteVerdict TryWriteKnob(KnobDef knob, string rawVal, out string written,
                                                out bool clamped, out float clampedFrom, out float clampedTo) {
            written = rawVal; clamped = false; clampedFrom = clampedTo = 0f;
            if (knob.Type == KnobType.Float || knob.Type == KnobType.Integer || knob.Type == KnobType.Toggle) {
                if (!float.TryParse(rawVal, NumberStyles.Float, CultureInfo.InvariantCulture, out var v))
                    return WriteVerdict.BadValue;
                if (knob.HasRange) {
                    float cv = Math.Clamp(v, knob.MinF, knob.MaxF);
                    if (cv != v) { clamped = true; clampedFrom = v; clampedTo = cv; }
                    v = cv;
                }
                written = Cfgs.FormatFloat(v);
            }
            Cfgs.WriteKnob(Cfgs.ResolvePath(knob.Cfg, forWrite: true), knob.Name, written);
            return WriteVerdict.Ok;
        }

        /// <summary>Exact-match knob lookup by cfg+name (both case-insensitive), for
        /// profile lines whose cfg is explicit.</summary>
        public static KnobDef? FindExact(string cfg, string name) {
            foreach (var k in Cfgs.All)
                if (k.Cfg.Equals(cfg, StringComparison.OrdinalIgnoreCase) && k.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                    return k;
            return null;
        }

        /// <summary>Write a knob's code default back — the GUI's per-row "reset" and the CLI's
        /// <c>--reset</c> land here.</summary>
        public static void ResetKnob(KnobDef k) =>
            Cfgs.WriteKnob(Cfgs.ResolvePath(k.Cfg, forWrite: true), k.Name, k.Default);

        /// <summary>Reset every knob of one cfg ("lights"/"sky"/"ragdoll") or "all". Returns
        /// how many were written, -1 for an unknown domain.</summary>
        public static int ResetAll(string domain) {
            bool all = domain.Equals("all", StringComparison.OrdinalIgnoreCase);
            if (!all && Array.IndexOf(CfgNames, domain.ToLowerInvariant()) < 0) return -1;
            int n = 0;
            foreach (var k in Cfgs.All)
                if (all || k.Cfg.Equals(domain, StringComparison.OrdinalIgnoreCase)) { ResetKnob(k); n++; }
            return n;
        }

        /// <summary>The GUI's "Load Recommended": the reference-machine overrides from
        /// <see cref="Cfgs.Recommended"/>, written through the same resolve chain.</summary>
        public static int LoadRecommended() {
            foreach (var (cfg, key, val) in Cfgs.Recommended)
                Cfgs.WriteKnob(Cfgs.ResolvePath(cfg, forWrite: true), key, val);
            return Cfgs.Recommended.Length;
        }

        public const string ProfileHeader = "# z-z patcher tuning profile (cfg.knob=value)";

        /// <summary>Write the GUI's .zzp profile format (one <c>cfg.knob=value</c> per knob,
        /// current resolved values) — files are interchangeable between GUI and CLI.</summary>
        public static void SaveProfile(string file) {
            var cur = ReadAllCfgs();
            var lines = new List<string> { ProfileHeader };
            foreach (var k in Cfgs.All) lines.Add($"{k.Cfg}.{k.Name}={ResolvedValue(k, cur)}");
            File.WriteAllLines(file, lines);
        }

        /// <summary>Apply a .zzp profile with the SAME validation as --tune (known key +
        /// clamp) — a profile is user-editable text, so a raw write would be a validation
        /// hole. Unknown keys / bad values are reported through <paramref name="warn"/> and
        /// skipped; comments/blank lines ignored. Both surfaces share this (the GUI shows
        /// the skips in a dialog, the CLI on stderr) so .zzp files stay interchangeable.</summary>
        public static (int applied, int skipped) LoadProfile(string file, Action<string> warn) {
            int applied = 0, skipped = 0;
            foreach (var raw in File.ReadAllLines(file)) {
                var line = raw.Trim(); if (line.Length == 0 || line[0] == '#') continue;
                int dot = line.IndexOf('.'), eq = line.IndexOf('=');
                if (dot <= 0 || eq <= dot) continue;
                var cfg = line.Substring(0, dot); var key = line.Substring(dot + 1, eq - dot - 1).Trim(); var val = line.Substring(eq + 1).Trim();
                var knob = FindExact(cfg, key);
                if (knob == null) { warn($"unknown knob '{cfg}.{key}' — skipped"); skipped++; continue; }
                if (TryWriteKnob(knob, val, out _, out bool cl, out float from, out float to) != WriteVerdict.Ok) {
                    warn($"bad value '{val}' for {cfg}.{key} — skipped"); skipped++; continue;
                }
                if (cl) warn($"{cfg}.{key} {from} clamped to {to} (range {knob.Min}..{knob.Max})");
                applied++;
            }
            return (applied, skipped);
        }

        // ───────────────────────────── plugins ─────────────────────────────

        /// <summary>The GUI's fallback when no runtime folder is configured yet.</summary>
        public static string ChoriziteDirOrDefault(Settings s) =>
            string.IsNullOrEmpty(s.ChoriziteDir) ? @"C:\Games\Chorizite" : s.ChoriziteDir!;

        /// <summary>Shown by the GUI as a Yes/No dialog and by the CLI on stderr before
        /// proceeding — one wording, two surfaces.</summary>
        public const string LightsDisableWarning =
            "'AcmeLights' also carries the memory-crash protection (the governor + mirror diet). " +
            "Disabling it removes that protection and towns may crash on the high-res dats.";
        public const string LightsUninstallWarning =
            "AcmeLights carries the memory-crash protection (the governor + mirror diet). " +
            "Deleting it removes that protection permanently.";

        // ─────────────────────────────── fix ───────────────────────────────

        /// <summary>Kit dat-size check against kit-manifest.txt. 0 = all present at manifest
        /// sizes · 1 = something missing/wrong (incl. no manifest — the kit wasn't copied) ·
        /// 2 = install folder not set.</summary>
        public static int CheckDats(Settings s, Action<string> log) {
            var dir = s.InstallDir;
            if (string.IsNullOrEmpty(dir)) { log("Install folder not set (Install tab / --set-install-dir)."); return 2; }
            var manifest = Path.Combine(dir!, "kit-manifest.txt");
            if (!File.Exists(manifest)) { log("kit-manifest.txt not found — can't verify dat sizes (copy the kit files to the install folder)."); return 1; }
            bool ok = true;
            foreach (var raw in File.ReadAllLines(manifest)) {
                var line = raw.Trim(); if (line.Length == 0) continue;
                var parts = line.Split('|');
                if (parts.Length < 2) continue;
                var name = parts[0]; var want = parts[1];
                var p = Path.Combine(dir!, name);
                if (!File.Exists(p)) { log($"MISSING  {name}"); ok = false; continue; }
                var have = new FileInfo(p).Length.ToString(CultureInfo.InvariantCulture);
                if (have != want) { log($"WRONG    {name}  have {have}  want {want}"); ok = false; }
                else log($"ok       {name}  {have}");
            }
            log(ok ? "\nAll dats present at their manifest sizes." : "\nSome dats are wrong/missing — re-copy the kit. A missing highres silently renders untextured surfaces.");
            return ok ? 0 : 1;
        }

        /// <summary>UserPreferences.ini sanity (INSTALL-WINDOWS.md §8): the numeric
        /// texture-detail trap and the FullScreen posture. 0 = clean · 1 = warned or file
        /// not found.</summary>
        public static int CheckPrefs(Settings s, Action<string> log) {
            var dir = s.InstallDir;
            string? ini = null;
            if (!string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir!, "UserPreferences.ini"))) ini = Path.Combine(dir!, "UserPreferences.ini");
            else {
                var docs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Asheron's Call", "UserPreferences.ini");
                if (File.Exists(docs)) ini = docs;
            }
            if (ini == null) { log("UserPreferences.ini not found (install folder or Documents\\Asheron's Call)."); return 1; }
            log("ini: " + ini);
            // Track which expected keys were actually SEEN: an ini without them is
            // unverifiable, not fine (Wine matrix 2026-08-24: a keyless ini got a clean
            // bill of health).
            bool warned = false;
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var raw in File.ReadAllLines(ini)) {
                var line = raw.Trim();
                foreach (var key in new[] { "EnvironmentTextureDetail", "LandscapeTextureDetail" }) {
                    if (line.StartsWith(key, StringComparison.OrdinalIgnoreCase) && line.Contains('=')) {
                        seen.Add(key);
                        var v = line.Substring(line.IndexOf('=') + 1).Trim();
                        bool numeric = float.TryParse(v, out _);
                        if (numeric) { log($"⚠ {key}={v} — NUMERIC values are a worst-first index; =0 means VeryLow (quarter detail). Use =VeryHigh."); warned = true; }
                        else log($"ok {key}={v}");
                    }
                }
                if (line.Contains('=') &&
                    line.Substring(0, line.IndexOf('=')).Trim().Equals("FullScreen", StringComparison.OrdinalIgnoreCase)) {
                    seen.Add("FullScreen");
                    var v = line.Substring(line.IndexOf('=') + 1).Trim();
                    if (v.Equals("False", StringComparison.OrdinalIgnoreCase)) log("ok FullScreen=False (windowed — the best-tested configuration; avoids alt-tab device-loss).");
                    else { log($"note FullScreen={v} — windowed (False) is the best-tested configuration and avoids device-loss on alt-tab entirely."); warned = true; }
                }
            }
            foreach (var key in new[] { "EnvironmentTextureDetail", "LandscapeTextureDetail", "FullScreen" })
                if (!seen.Contains(key)) { log($"⚠ {key} not present in this ini — can't confirm it (is this the right UserPreferences.ini?)."); warned = true; }
            if (!warned) log("\nUserPreferences looks fine (spelled-out texture detail, windowed). VeryHigh = full detail.");
            return warned ? 1 : 0;
        }

        /// <summary>Tail the plugin log of one pid, or of every confirmed-injected client
        /// when <paramref name="pid"/> is null. Highlights the §10 "lines that matter".
        /// 0 = tailed at least one log · 1 = no clients / pid not found / not injected.</summary>
        public static int TailLog(Settings s, Action<string> log, int? pid) {
            var back = new Backbone(s);
            var clients = back.ListClients();
            if (clients.Count == 0) { log("No running clients to read a log from."); return 1; }
            int shown = 0;
            foreach (var c in clients) {
                if (pid != null && c.Pid != pid.Value) continue;
                if (c.Injected != true) {
                    if (pid != null) { log($"pid {c.Pid} has no plugins loaded (not injected) — no plugin log."); return 1; }
                    continue;   // only confirmed-injected clients have a plugin log
                }
                var path = Status.LogPath(s, c.Pid);
                log($"── pid {c.Pid}: {path} ──");
                try {
                    using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    using var sr = new StreamReader(fs);
                    var all = sr.ReadToEnd().Split('\n');
                    int start = Math.Max(0, all.Length - 40);
                    for (int i = start; i < all.Length; i++) {
                        var l = all[i].TrimEnd('\r');
                        if (l.Length == 0) continue;
                        // The §10 "lines that matter": diet FAULT (self-disabled), memgov CRIT,
                        // hook FAILED, plus generic errors.
                        if (l.Contains("FAULT") || l.Contains("Error") || l.Contains("CRIT") || l.Contains("hook FAILED")) log("!! " + l);
                        else log("   " + l);
                    }
                    shown++;
                }
                catch (Exception ex) { log("  (unreadable: " + ex.Message + ")"); }
            }
            if (shown == 0) { log(pid != null ? $"pid {pid} not found among running clients." : "No injected clients (plain clients have no plugin log)."); return 1; }
            return 0;
        }

        /// <summary>Restore the pre-patch acclient.exe backup. NO confirmation here — the GUI
        /// asks with a MessageBox, the CLI gates on --yes. 0 = restored · 1 = nothing to
        /// restore / failed · 2 = install folder unset.</summary>
        public static int Rollback(Settings s, Action<string> log) {
            var dir = s.InstallDir;
            if (string.IsNullOrEmpty(dir)) { log("Install folder not set."); return 2; }
            var bak = Path.Combine(dir!, "acclient.exe.acme-orig.bak");
            if (!File.Exists(bak)) { log("No acclient.exe.acme-orig.bak found — nothing to restore."); return 1; }
            try { File.Copy(bak, Path.Combine(dir!, "acclient.exe"), true); log("Restored original acclient.exe. Restore your backed-up dats manually to go fully stock."); return 0; }
            catch (Exception ex) { log("Restore failed: " + ex.Message); return 1; }
        }

        /// <summary>Shell the kit's PowerShell patcher in -Verify mode (Windows only — Wine's
        /// powershell is a stub; App/Ui gate on Platform before calling). 0 = fully patched ·
        /// 1 = not patched / prereq missing · 2 = install folder unset.</summary>
        public static int VerifyExe(Settings s, Action<string> log) {
            var dir = s.InstallDir;
            if (string.IsNullOrEmpty(dir)) { log("Install folder not set (Install tab / --set-install-dir)."); return 2; }
            var ps1 = Path.Combine(dir!, "acme-patch-client.ps1");
            if (!File.Exists(ps1)) { log("acme-patch-client.ps1 not in the install folder — copy the kit files there."); return 1; }
            var r = RunCapture("powershell", $"-NoProfile -ExecutionPolicy Bypass -File \"{ps1}\" -Verify -Exe \"{Path.Combine(dir!, "acclient.exe")}\"", dir);
            log(r.output.Trim());
            log(r.code == 0 ? "\nOK: exe is fully patched." : "\nNOT fully patched — run the patcher (Install tab / --patch-exe). Without it, most textures won't load.");
            return r.code == 0 ? 0 : 1;
        }

        /// <summary>Shell the kit's PowerShell patcher (Windows only; see VerifyExe).
        /// 0 = patched · 1 = patcher refused / prereq missing · 2 = install folder unset.</summary>
        public static int PatchExe(Settings s, Action<string> log) {
            var dir = s.InstallDir;
            if (string.IsNullOrEmpty(dir)) { log("Install folder not set (Install tab / --set-install-dir)."); return 2; }
            var ps1 = Path.Combine(dir!, "acme-patch-client.ps1");
            if (!File.Exists(ps1)) { log("acme-patch-client.ps1 not in the install folder."); return 1; }
            var r = RunCapture("powershell", $"-NoProfile -ExecutionPolicy Bypass -File \"{ps1}\" -Exe \"{Path.Combine(dir!, "acclient.exe")}\"", dir);
            log(r.output.Trim());
            log(r.code == 0 ? "Patched." : "Patcher refused — see message above.");
            return r.code == 0 ? 0 : 1;
        }

        // ───────────────────────────── install ─────────────────────────────

        /// <summary>Where the tool's own settings live — printed by <c>--paths</c> and named
        /// in error details.</summary>
        public static string SettingsFilePath =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "zzpatcher", "settings.json");

        /// <summary>Report whether a .NET desktop runtime is present for the PLUGIN runtime
        /// (zzpatcher itself is self-contained). Report-only, never downloads (the GUI
        /// additionally offers to open the official page). 0 = found · 1 = not found.
        /// Windows only — Wine's dotnet is absent/stub; App/Ui gate on Platform.</summary>
        public static int CheckDotnet(Action<string> log) {
            log("(This check is about the PLUGIN runtime that loads inside the game client — " +
                "z-z patcher itself is self-contained and needs nothing.)");
            var r = RunCapture("dotnet", "--list-runtimes", null);
            if (r.code == 0 && r.output.Contains("Microsoft.WindowsDesktop.App")) {
                log("Found a .NET desktop runtime:\n" + r.output.Trim());
                return 0;
            }
            log(".NET desktop runtime not detected.");
            log("The plugin pack needs the .NET 8 Desktop Runtime.");
            log("Download it from Microsoft's official page:");
            log("  https://dotnet.microsoft.com/download/dotnet/8.0");
            return 1;
        }

        // ───────────────────────────── helpers ─────────────────────────────

        public static (int code, string output) RunCapture(string exe, string args, string? workDir) {
            try {
                var psi = new ProcessStartInfo {
                    FileName = exe, Arguments = args, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    WorkingDirectory = workDir ?? Environment.CurrentDirectory,
                };
                using var p = Process.Start(psi);
                if (p == null) return (-1, "could not start " + exe);
                // Async concurrent reads — avoids the both-streams-ReadToEnd deadlock (the patcher
                // can be chatty on both stdout and stderr).
                var oT = p.StandardOutput.ReadToEndAsync();
                var eT = p.StandardError.ReadToEndAsync();
                p.WaitForExit(120_000);
                string o = oT.GetAwaiter().GetResult() + eT.GetAwaiter().GetResult();
                return (p.ExitCode, o);
            }
            catch (Exception ex) { return (-1, ex.Message); }
        }
    }
}
