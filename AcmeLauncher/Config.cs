using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;

namespace AcmeLauncher {
    /// <summary>One tunable knob: how the Tune tab renders it and its clamp/range.
    /// Mirrors AcmeLights/Lib/LightsConfig.cs (defaults + Math.Clamp bounds).</summary>
    internal sealed class Knob {
        public string Name = "";        // cfg key, e.g. "diet"
        public string Label = "";       // human label
        public float Default;           // LightsConfig field default
        public float Min, Max;          // Math.Clamp range
        public bool Toggle;             // true = 0/1 checkbox
        public bool Integer;            // true = whole-number stepper (diet, selbudget, mem*)
        public string Group = "";       // section header
        public string Help = "";

        public Knob(string name, string label, float def, float min, float max, string group,
                    bool toggle = false, bool integer = false, string help = "") {
            Name = name; Label = label; Default = def; Min = min; Max = max;
            Group = group; Toggle = toggle; Integer = integer; Help = help;
        }
    }

    /// <summary>The load-bearing lights.cfg knobs (authoritative source:
    /// AcmeLights/Lib/LightsConfig.cs). Plus lights.cfg read/write and the same
    /// path-resolution the plugin uses.</summary>
    internal static class Knobs {
        public static readonly Knob[] All = new[] {
            // stability
            new Knob("diet",    "Mirror diet (memory)", 0f, 0f, 3f, "Stability", integer:true,
                     help:"0 off · 1 probe · 2 DAT textures · 3 everything (frees ~400MB in towns)"),
            new Knob("memgov",  "Memory governor",      1f, 0f, 1f, "Stability", toggle:true),
            new Knob("memlowmb","Trim watermark (MB)",  1100f, 256f, 3072f, "Stability", integer:true),
            new Knob("memhighmb","Calm re-arm (MB)",    950f, 256f, 3072f, "Stability", integer:true),
            new Knob("memcritmb","Emergency (MB)",      1350f, 256f, 3584f, "Stability", integer:true),
            new Knob("memcritfragmb","Emergency frag (MB)", 6f, 1f, 256f, "Stability", integer:true),
            new Knob("framelog","Frame-time log",       1f, 0f, 1f, "Stability", toggle:true),
            // lighting
            new Knob("bloom",   "Bloom (night)",        1f, 0f, 1f, "Lighting", toggle:true),
            new Knob("bloomthreshold","  night threshold", 0.55f, 0f, 2f, "Lighting"),
            new Knob("bloomintensity","  night intensity", 2.0f, 0f, 4f, "Lighting"),
            new Knob("bloomradius","  night radius",    3f, 1f, 4f, "Lighting", integer:true),
            new Knob("bloomday","Bloom (day)",          1f, 0f, 1f, "Lighting", toggle:true),
            new Knob("bloomdaythreshold","  day threshold", 0.38f, 0f, 2f, "Lighting"),
            new Knob("bloomdayintensity","  day intensity", 3.2f, 0f, 4f, "Lighting"),
            new Knob("bloomdayradius","  day radius",   4f, 1f, 4f, "Lighting", integer:true),
            new Knob("torchlights","Torch/lantern lights", 1f, 0f, 2f, "Lighting", integer:true),
            new Knob("glowlights","Glow lights",        1f, 0f, 1f, "Lighting", toggle:true),
            new Knob("selection","Importance light selection", 1f, 0f, 1f, "Lighting", toggle:true),
            new Knob("selbudget","  lights per draw",   8f, 1f, 8f, "Lighting", integer:true),
            new Knob("flicker", "Torch flicker",        1f, 0f, 1f, "Lighting", toggle:true),
            new Knob("ambientfix","Ambient red-bias fix", 1f, 0f, 1f, "Lighting", toggle:true),
            new Knob("dungeonambient","Dungeon ambient (-1=retail)", -1f, -1f, 1f, "Lighting"),
        };

        /// <summary>Same resolution order the plugin uses (LightsConfig +
        /// AsyncLog). For READING we take the first that exists; for WRITING we
        /// take the first that exists, else the user profile default (always
        /// writable), creating the directory.</summary>
        public static string ResolveCfgPath(bool forWrite) {
            var env = Environment.GetEnvironmentVariable("ACMELIGHTS_CONFIG");
            var candidates = new List<string>();
            if (!string.IsNullOrEmpty(env)) candidates.Add(env!);
            candidates.Add(@"C:\Temp\acdt\lights.cfg");
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            candidates.Add(Path.Combine(home, ".acdt", "lights.cfg"));
            foreach (var c in candidates) if (File.Exists(c)) return c;
            // None exist yet. For writes, honor an explicit ACMELIGHTS_CONFIG override (so a user
            // who pointed the plugin at a custom path gets their first write there); otherwise the
            // .acdt profile. Reads return the first candidate (env if set).
            if (forWrite) return !string.IsNullOrEmpty(env) ? env! : candidates[candidates.Count - 1];
            return candidates[0];
        }

        /// <summary>Parse a lights.cfg into key→value (last wins, like the plugin).</summary>
        public static Dictionary<string, float> Read(string path) {
            var d = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
            try {
                foreach (var raw in File.ReadAllLines(path)) {
                    var line = raw.Trim();
                    if (line.Length == 0 || line[0] == '#' || line[0] == ';') continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    var k = line.Substring(0, eq).Trim();
                    var v = line.Substring(eq + 1).Trim();
                    if (float.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var f))
                        d[k] = f;
                }
            }
            catch { }
            return d;
        }

        /// <summary>Write a single knob (create/update its line), preserving every
        /// other line and comment in the file. This is what makes live tuning
        /// non-destructive to a hand-edited cfg.</summary>
        public static void WriteKnob(string path, string key, float value) {
            var lines = new List<string>();
            try { if (File.Exists(path)) lines.AddRange(File.ReadAllLines(path)); } catch { }
            string val = FormatValue(value);
            bool found = false;
            for (int i = 0; i < lines.Count; i++) {
                var t = lines[i].Trim();
                if (t.Length == 0 || t[0] == '#' || t[0] == ';') continue;
                int eq = t.IndexOf('=');
                if (eq <= 0) continue;
                if (string.Equals(t.Substring(0, eq).Trim(), key, StringComparison.OrdinalIgnoreCase)) {
                    lines[i] = key + "=" + val;
                    found = true;
                    break;
                }
            }
            if (!found) lines.Add(key + "=" + val);
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllLines(path, lines);
        }

        public static string FormatValue(float v) =>
            v == Math.Floor(v) ? ((long)v).ToString(CultureInfo.InvariantCulture)
                               : v.ToString("0.###", CultureInfo.InvariantCulture);
    }

    /// <summary>Player preferences the launcher remembers between runs
    /// (%APPDATA%\AcmeLauncher\settings.json). Never contains dev defaults.</summary>
    internal sealed class Settings {
        public string? Server { get; set; }
        public string? Account { get; set; }
        public string? InstallDir { get; set; }     // holds acclient.exe + the dats
        public string? ChoriziteDir { get; set; }   // holds AcmeInject.exe + the runtime
        public string? InjectorPath { get; set; }   // explicit AcmeInject.exe override
        public bool Rodat { get; set; } = true;      // -rodat on (keep dats read-only)

        private static string Dir =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AcmeLauncher");
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
