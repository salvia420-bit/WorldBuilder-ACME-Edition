using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace AcmeLauncher {
    /// <summary>
    /// The Wine checklist from INSTALL-LINUX-WINE.md as code — ONE implementation with two
    /// surfaces: the Fix tab's Wine rows (GUI) and the headless <c>--fix-wine</c> command.
    /// The CLI surface is the one that matters in practice: the WPF GUI does not run under
    /// Wine (wine 8.0, WPF stack overflow — fleet-tested 2026-08-24), while the headless
    /// paths run cleanly, so a Linux user reaches these fixes via
    /// <c>wine zzpatcher.exe --fix-wine [--apply]</c>.
    ///
    /// Check = read-only. Apply = only the fixes that are a local file/registry write the
    /// doc prescribes verbatim. Every row reports one of OK | MISSING | WRONG (the CLI's
    /// machine-greppable verdict); <see cref="Row.Advisory"/> marks rows whose non-OK state
    /// is situational (dxvk.conf without DXVK; the plugin temp dir when not using plugins).
    /// </summary>
    internal static class WineFixes {
        internal sealed class Row {
            public string Name = "";      // stable, kebab-case (the CLI grep key)
            public string Verdict = "";   // OK | MISSING | WRONG
            public string Detail = "";    // one line, no newlines
            public bool Advisory;         // non-OK but situational (GUI shows amber, not red)
            public bool Ok => Verdict == "OK";
        }

        public static List<Row> CheckAll(Settings s) => new List<Row> {
            CheckVideoMemory(), CheckDxvkConf(s), CheckChoriziteTemp(), CheckLiveSky(),
        };

        /// <summary>Apply every safe fix whose check is non-OK; returns the re-checked rows.
        /// Successes log as "applied: …", failures as "apply-FAILED: …". dxvk.conf is only
        /// PATCHED when it already exists — CREATION needs <paramref name="createDxvk"/>
        /// (the CLI's explicit --dxvk flag; creating it unasked would flip an advisory
        /// signal to OK for non-DXVK users). Rows that cannot be fixed from here (an unset
        /// install dir) stay non-OK with the Detail saying what to do.</summary>
        public static List<Row> ApplyAll(Settings s, bool createDxvk, Action<string>? log = null) {
            void Run(string success, Func<string?> fix) {
                var err = fix();
                log?.Invoke(err == null ? "applied: " + success : "apply-FAILED: " + err);
            }
            if (!CheckVideoMemory().Ok) Run("VideoMemorySize=2048", FixVideoMemory);
            if (!CheckDxvkConf(s).Ok && !string.IsNullOrEmpty(s.InstallDir)) {
                bool exists = File.Exists(Path.Combine(s.InstallDir!, "dxvk.conf"));
                if (exists || createDxvk) Run("dxvk.conf d3d9.textureMemory = 0", () => FixDxvkConf(s));
            }
            if (!CheckChoriziteTemp().Ok) Run("created " + ChoriziteTempPath(), FixChoriziteTemp);
            if (!CheckLiveSky().Ok) Run("sky live=0", FixLiveSky);
            return CheckAll(s);
        }

        // ---- 1. VideoMemorySize (INSTALL-LINUX-WINE.md:200-216) --------------------------
        // "The single most important Wine setting for this game": unset, the 2005-era client
        // mishandles a modern card's VRAM figure (4 MiB memset overrun → faults at world
        // entry) and thrashes the texture-purge path outdoors. Must be exactly 2048; every
        // fresh prefix needs it; takes effect on the next client launch.
        public static Row CheckVideoMemory() {
            try {
                using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Wine\Direct3D");
                var v = k?.GetValue("VideoMemorySize") as string;
                if (v == "2048") return new Row { Name = "videomemorysize", Verdict = "OK", Detail = "HKCU\\Software\\Wine\\Direct3D VideoMemorySize=2048" };
                if (v == null) return new Row { Name = "videomemorysize", Verdict = "MISSING", Detail = "VideoMemorySize not set — crash at world entry + outdoor texture-purge thrash; set exactly 2048 (every fresh prefix needs it)" };
                return new Row { Name = "videomemorysize", Verdict = "WRONG", Detail = $"VideoMemorySize={v} — must be exactly 2048 (unset and absurdly-high both re-expose the overrun)" };
            }
            catch (Exception ex) { return new Row { Name = "videomemorysize", Verdict = "WRONG", Detail = "registry unreadable: " + ex.Message, Advisory = true }; }
        }
        /// <returns>null on success, else the error message.</returns>
        public static string? FixVideoMemory() {
            try {
                using var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Wine\Direct3D");
                k.SetValue("VideoMemorySize", "2048", Microsoft.Win32.RegistryValueKind.String);
                return null;
            }
            catch (Exception ex) { return "VideoMemorySize write failed: " + ex.Message; }
        }

        // ---- 2. dxvk.conf (INSTALL-LINUX-WINE.md:371-379) --------------------------------
        // Required when DXVK's native d3d9.dll is in use; without it the game crashes
        // outdoors (32-bit texture-paging exhaustion). Harmless when not using DXVK.
        private const string DxvkKey = "d3d9.textureMemory";
        public static Row CheckDxvkConf(Settings s) {
            var dir = s.InstallDir;
            if (string.IsNullOrEmpty(dir))
                return new Row { Name = "dxvk-conf", Verdict = "MISSING", Advisory = true, Detail = "install folder not set (Settings.InstallDir in %APPDATA%\\zzpatcher\\settings.json) — cannot locate dxvk.conf" };
            var p = Path.Combine(dir!, "dxvk.conf");
            if (!File.Exists(p))
                return new Row { Name = "dxvk-conf", Verdict = "MISSING", Advisory = true, Detail = p + " absent — only needed with DXVK's native d3d9.dll, but WITH DXVK and without \"d3d9.textureMemory = 0\" the game crashes outdoors" };
            try {
                foreach (var raw in File.ReadAllLines(p)) {
                    var line = raw.Trim();
                    if (line.StartsWith("#") || !line.Contains('=')) continue;
                    if (!line.Substring(0, line.IndexOf('=')).Trim().Equals(DxvkKey, StringComparison.OrdinalIgnoreCase)) continue;
                    var val = line.Substring(line.IndexOf('=') + 1).Trim();
                    return val == "0"
                        ? new Row { Name = "dxvk-conf", Verdict = "OK", Detail = p + ": d3d9.textureMemory = 0" }
                        : new Row { Name = "dxvk-conf", Verdict = "WRONG", Detail = $"{p}: d3d9.textureMemory = {val} — must be 0 or the game crashes outdoors under DXVK" };
                }
                return new Row { Name = "dxvk-conf", Verdict = "WRONG", Detail = p + " exists but lacks \"d3d9.textureMemory = 0\" — required under DXVK" };
            }
            catch (Exception ex) { return new Row { Name = "dxvk-conf", Verdict = "WRONG", Detail = "unreadable: " + ex.Message, Advisory = true }; }
        }
        public static string? FixDxvkConf(Settings s) {
            var dir = s.InstallDir;
            if (string.IsNullOrEmpty(dir)) return "install folder not set — cannot write dxvk.conf";
            var p = Path.Combine(dir!, "dxvk.conf");
            try {
                if (!File.Exists(p)) { File.WriteAllText(p, DxvkKey + " = 0\n"); return null; }
                // Patch/append the one key, preserving the file's other lines, the replaced
                // line's leading whitespace, and the file's DOMINANT line ending.
                var text = File.ReadAllText(p);
                int crlf = 0, lfAll = 0;
                for (int i = 0; i < text.Length; i++)
                    if (text[i] == '\n') { lfAll++; if (i > 0 && text[i - 1] == '\r') crlf++; }
                string eol = crlf > 0 && crlf >= lfAll - crlf ? "\r\n" : "\n";
                var lines = new List<string>(text.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None));
                bool found = false;
                for (int i = 0; i < lines.Count; i++) {
                    var t = lines[i].Trim();
                    if (t.StartsWith("#") || !t.Contains('=')) continue;
                    if (t.Substring(0, t.IndexOf('=')).Trim().Equals(DxvkKey, StringComparison.OrdinalIgnoreCase)) {
                        string lead = lines[i].Substring(0, lines[i].Length - lines[i].TrimStart().Length);
                        lines[i] = lead + DxvkKey + " = 0"; found = true; break;
                    }
                }
                if (!found) {
                    if (lines.Count > 0 && lines[lines.Count - 1].Length == 0) lines.Insert(lines.Count - 1, DxvkKey + " = 0");
                    else lines.Add(DxvkKey + " = 0");
                }
                File.WriteAllText(p, string.Join(eol, lines));
                return null;
            }
            catch (Exception ex) { return "dxvk.conf write failed: " + ex.Message; }
        }

        // ---- 3. plugin temp dir (INSTALL-LINUX-WINE.md:407-408) --------------------------
        // Wine-only plugin prerequisite #1: the runtime's temp dir must exist or every
        // plugin fails to load. Plain client (the supported posture) doesn't need it.
        public static string ChoriziteTempPath() {
            var temp = Environment.GetEnvironmentVariable("TEMP");
            if (string.IsNullOrEmpty(temp)) temp = Path.Combine(@"C:\users", Environment.UserName, "Temp");
            return Path.Combine(temp!, "chorizite");
        }
        public static Row CheckChoriziteTemp() {
            var p = ChoriziteTempPath();
            return Directory.Exists(p)
                ? new Row { Name = "chorizite-temp", Verdict = "OK", Detail = p }
                : new Row { Name = "chorizite-temp", Verdict = "MISSING", Advisory = true, Detail = p + " — every plugin fails to load without it (plugins are experimental under Wine; the plain client doesn't need this)" };
        }
        public static string? FixChoriziteTemp() {
            try { Directory.CreateDirectory(ChoriziteTempPath()); return null; }
            catch (Exception ex) { return "mkdir failed: " + ex.Message; }
        }

        // ---- 4. live-sky guard (INSTALL-LINUX-WINE.md:413-415) ---------------------------
        // AcmeSky's LIVE volumetric compositor's D3D11→D3D9 readback faults under Wine/DXVK;
        // the baked sky (live=0) is the proven configuration. Precedence mirrors the plugin
        // EXACTLY (SkyConfig.FromDefaultsAndEnv + Reload): code default live=1 → ACMESKY_LIVE
        // env (EnvBool) → the first existing candidate file's `live` key wins over BOTH.
        // A cfg write therefore cures the env case too — the file is the last word.
        public static Row CheckLiveSky() {
            bool live = true;                       // SkyConfig.LiveMode code default = 1
            string src = "code default (live=1)";
            bool? env = EnvBoolTri("ACMESKY_LIVE"); // plugin EnvBool semantics; null = keep default
            if (env != null) { live = env.Value; src = "ACMESKY_LIVE env"; }
            var path = Cfgs.ResolvePath("sky", forWrite: false);
            var cfg = Cfgs.Read(path);
            if (File.Exists(path) && cfg.TryGetValue("live", out var v) &&
                float.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var f)) {
                live = f >= 0.5f; src = path + " live=" + v;
            }
            if (!live) return new Row { Name = "live-sky", Verdict = "OK", Detail = $"baked sky ({src}) — the proven Wine configuration" };
            return new Row { Name = "live-sky", Verdict = "WRONG", Detail = $"live volumetric sky enabled ({src}) — its D3D11→D3D9 readback faults under Wine/DXVK; writing live=0 to the cfg fixes it (the file outranks the env in the plugin)" };
        }

        /// <summary>The plugin's EnvBool (SkyConfig.cs:116-123), tri-state: 0/off/false/no →
        /// false, 1/on/true/yes → true, unset/unrecognised → null (keep default). Trimmed,
        /// case-insensitive.</summary>
        private static bool? EnvBoolTri(string name) {
            var s = Environment.GetEnvironmentVariable(name);
            if (string.IsNullOrEmpty(s)) return null;
            s = s.Trim().ToLowerInvariant();
            if (s is "0" or "off" or "false" or "no") return false;
            if (s is "1" or "on" or "true" or "yes") return true;
            return null;
        }
        public static string? FixLiveSky() {
            try { Cfgs.WriteKnob(Cfgs.ResolvePath("sky", forWrite: true), "live", "0"); return null; }
            catch (Exception ex) { return "sky.cfg write failed: " + ex.Message; }
        }
    }
}
