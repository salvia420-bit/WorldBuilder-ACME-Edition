using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;

namespace AcmeLauncher {
    internal enum KnobType { Float, Integer, Toggle, Color, String }

    /// <summary>One tunable variable. Metadata is GENERATED from the plugin source by
    /// tools/gen_knobs.py (Knobs.Generated.cs) so it never drifts — do not hand-edit knobs.
    /// Default = the plugin's field default (the code default), NOT the reference-machine
    /// override (those ship as the loadable "Recommended" profile).</summary>
    internal sealed class KnobDef {
        public readonly string Plugin, Cfg, Group, Name, Default, Min, Max, Desc;
        public readonly KnobType Type;
        public KnobDef(string plugin, string cfg, string group, string name, KnobType type,
                       string def, string min, string max, string desc) {
            Plugin = plugin; Cfg = cfg; Group = group; Name = name; Type = type;
            Default = def; Min = min; Max = max; Desc = desc;
        }
        static float P(string s, float fb) =>
            float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : fb;
        public float MinF => P(Min, 0f);
        public float MaxF => P(Max, 1f);
        public float DefaultF => P(Default, 0f);
        public bool HasRange => !string.IsNullOrEmpty(Min) && !string.IsNullOrEmpty(Max);
    }

    /// <summary>The three plugin config files: path resolution (matching each plugin) +
    /// non-destructive read/write. The knob catalogue is GeneratedKnobs.All.</summary>
    internal static class Cfgs {
        public static IReadOnlyList<KnobDef> All => GeneratedKnobs.All;

        /// <summary>Reference-machine overrides — the tuned deployed posture — offered as a
        /// loadable "Recommended" profile rather than baked into the per-knob defaults.</summary>
        public static readonly (string cfg, string key, string val)[] Recommended = {
            ("lights", "diet", "3"),
            ("lights", "memlowmb", "1300"), ("lights", "memhighmb", "1200"),
            ("lights", "memcritmb", "1700"), ("lights", "memcritfragmb", "5"),
            ("lights", "bloomday", "1"), ("lights", "bloomdaythreshold", "0.45"),
            ("lights", "bloomdayintensity", "2.6"), ("lights", "bloomdayradius", "3"),
        };

        static string EnvVar(string cfg) => cfg switch {
            "lights" => "ACMELIGHTS_CONFIG",
            "sky" => "ACMESKY_SKY_CONFIG",
            "ragdoll" => "ACMERAGDOLL_CONFIG",
            _ => "",
        };

        /// <summary>Same order each plugin uses: env override → C:\Temp\acdt\&lt;cfg&gt;.cfg →
        /// %USERPROFILE%\.acdt\&lt;cfg&gt;.cfg. Read = first existing; write = first existing else
        /// the env override (if set) else the user-profile path (always writable).</summary>
        public static string ResolvePath(string cfg, bool forWrite) {
            var env = EnvVar(cfg) is var ev && ev.Length > 0 ? Environment.GetEnvironmentVariable(ev) : null;
            string file = cfg + ".cfg";
            var candidates = new List<string>();
            if (!string.IsNullOrEmpty(env)) candidates.Add(env!);
            candidates.Add(Path.Combine(@"C:\Temp\acdt", file));
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            candidates.Add(Path.Combine(home, ".acdt", file));
            foreach (var c in candidates) if (File.Exists(c)) return c;
            if (forWrite) return !string.IsNullOrEmpty(env) ? env! : candidates[candidates.Count - 1];
            return candidates[0];
        }

        /// <summary>Parse a cfg into key→raw-string-value (last wins, like the plugin).</summary>
        public static Dictionary<string, string> Read(string path) {
            var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            try {
                foreach (var raw in File.ReadAllLines(path)) {
                    var line = raw.Trim();
                    if (line.Length == 0 || line[0] == '#' || line[0] == ';') continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    d[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
                }
            }
            catch { }
            return d;
        }

        /// <summary>Set one key (create/update its line), preserving every other line and
        /// comment — non-destructive to a hand-edited cfg, so live tuning is safe.</summary>
        public static void WriteKnob(string path, string key, string val) {
            var lines = new List<string>();
            try { if (File.Exists(path)) lines.AddRange(File.ReadAllLines(path)); } catch { }
            bool found = false;
            for (int i = 0; i < lines.Count; i++) {
                var t = lines[i].Trim();
                if (t.Length == 0 || t[0] == '#' || t[0] == ';') continue;
                int eq = t.IndexOf('=');
                if (eq <= 0) continue;
                if (string.Equals(t.Substring(0, eq).Trim(), key, StringComparison.OrdinalIgnoreCase)) {
                    lines[i] = key + "=" + val; found = true; break;
                }
            }
            if (!found) lines.Add(key + "=" + val);
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllLines(path, lines);
        }

        public static string FormatFloat(float v) =>
            v == Math.Floor(v) ? ((long)v).ToString(CultureInfo.InvariantCulture)
                               : v.ToString("0.####", CultureInfo.InvariantCulture);
    }

    /// <summary>Player preferences the tool remembers between runs
    /// (%APPDATA%\zzpatcher\settings.json). Holds only local paths — never a server,
    /// account, or password (the tool does no login).</summary>
    internal sealed class Settings {
        public string? InstallDir { get; set; }     // holds acclient.exe + the dats
        public string? ChoriziteDir { get; set; }   // holds AcmeInject.exe + the runtime
        public string? InjectorPath { get; set; }   // explicit AcmeInject.exe override

        private static string Dir =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "zzpatcher");
        private static string FilePath => Path.Combine(Dir, "settings.json");

        public static Settings Load() {
            try {
                if (File.Exists(FilePath))
                    return JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? new Settings();
            }
            catch { }
            return new Settings();
        }
        public void Save() {
            try {
                Directory.CreateDirectory(Dir);
                File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch { }
        }
    }
}
