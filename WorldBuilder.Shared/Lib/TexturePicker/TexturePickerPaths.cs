using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace WorldBuilder.Shared.Lib.TexturePicker {
    /// <summary>
    /// Where the texture-picker data lives on THIS machine, resolved at run time.
    ///
    /// WHY THIS EXISTS. These four roots used to be <c>const string</c> absolute paths pointing at
    /// one developer's data mount. A C# <c>const</c> is not a private implementation detail: the
    /// literal is copied into every assembly that reads it and stored in the assembly string heap
    /// as UTF-16LE, so the shipped <c>WorldBuilder.Shared.dll</c> disclosed a dev box's directory
    /// layout to everyone who installed the editor, where <c>strings</c> — or this repo's own
    /// <c>tools/leak_scan.py</c> — would find it. Nothing in this file is a compile-time constant.
    ///
    /// RESOLUTION ORDER, per root, first match wins:
    ///   1. its own environment variable (see the <c>*EnvVar</c> constants below);
    ///   2. its key in a local config file (see <see cref="LocalConfigFileName"/>) — gitignored,
    ///      so a machine-specific layout never lands in a commit;
    ///   3. the workspace root (<see cref="RootEnvVar"/> / <c>root</c> config key) joined with the
    ///      conventional sub-path;
    ///   4. <see cref="DefaultRoot"/> joined with the conventional sub-path — a RELATIVE path that
    ///      names no machine, no user and no mount.
    ///
    /// Setting the single variable <c>WORLDBUILDER_PICKER_ROOT</c> to the directory that holds
    /// <c>picker/</c>, <c>cc0-pool/</c>, <c>statics-x1/</c> and <c>statics-x3/</c> restores the
    /// exact behaviour the old constants gave, because the sub-paths below are unchanged.
    ///
    /// Nothing here fails when a path is absent. The picker already treats a missing
    /// recommendations file as "show the design-time sample" and a missing image as "no preview",
    /// so an unconfigured checkout degrades the same way an unmounted volume always did.
    /// </summary>
    public static class TexturePickerPaths {
        /// <summary>Workspace root holding every picker sub-directory.</summary>
        public const string RootEnvVar = "WORLDBUILDER_PICKER_ROOT";

        /// <summary>Directory holding picker-recommendations.json / picker-picks.json.</summary>
        public const string PickerDirectoryEnvVar = "WORLDBUILDER_PICKER_DIR";

        /// <summary>Root of the locally downloaded full-resolution CC0 sets.</summary>
        public const string SetsRootEnvVar = "WORLDBUILDER_PICKER_SETS_ROOT";

        /// <summary>Root of the CC0 preview pool (flat colour maps + sphere thumbs).</summary>
        public const string PoolRootEnvVar = "WORLDBUILDER_PICKER_POOL_ROOT";

        /// <summary>Root of the extracted retail terrain PNGs used for the A-B compare.</summary>
        public const string RetailRootEnvVar = "WORLDBUILDER_PICKER_RETAIL_ROOT";

        /// <summary>Explicit path to the local config file, overriding the search below.</summary>
        public const string ConfigEnvVar = "WORLDBUILDER_PICKER_CONFIG";

        /// <summary>
        /// Optional machine-local JSON config: <c>{ "root": "...", "pickerDirectory": "...",
        /// "setsRoot": "...", "poolRoot": "...", "retailRoot": "..." }</c>. Every key is optional.
        /// Searched in <see cref="ConfigEnvVar"/>, then the current directory, then next to the
        /// executable, then <c>$XDG_CONFIG_HOME/worldbuilder/</c> (or <c>~/.config/worldbuilder/</c>).
        /// It is gitignored on purpose: this is the seam that keeps a real path out of the repo.
        /// </summary>
        public const string LocalConfigFileName = "texturepicker.local.json";

        /// <summary>
        /// Neutral relative fallback root. Relative, so it resolves against the process working
        /// directory and names nothing about the machine it was built on.
        /// </summary>
        public const string DefaultRoot = "pbr-terrain";

        // Conventional layout under the root. Unchanged from the old constants, which is what
        // makes a single WORLDBUILDER_PICKER_ROOT enough to restore the previous behaviour.
        private static readonly string[] PickerSubPath = { "picker" };
        private static readonly string[] SetsSubPath = { "statics-x3", "sets" };
        private static readonly string[] PoolSubPath = { "cc0-pool" };
        private static readonly string[] RetailSubPath = { "statics-x1", "x4-input" };

        private static Dictionary<string, string>? _config;
        private static bool _configLoaded;
        private static readonly object _configLock = new();

        /// <summary>Workspace root: env, else config, else <see cref="DefaultRoot"/>.</summary>
        public static string Root =>
            FirstNonEmpty(Env(RootEnvVar), Config("root"), DefaultRoot)!;

        /// <summary>Directory holding picker-recommendations.json and picker-picks.json.</summary>
        public static string PickerDirectory => Resolve(
            PickerDirectoryEnvVar, "pickerDirectory", PickerSubPath);

        /// <summary>Root of the locally downloaded full-resolution ambientCG sets.</summary>
        public static string SetsRoot => Resolve(SetsRootEnvVar, "setsRoot", SetsSubPath);

        /// <summary>Root of the CC0 preview pool (per-source <c>flat/</c> and <c>thumbs/</c>).</summary>
        public static string PoolRoot => Resolve(PoolRootEnvVar, "poolRoot", PoolSubPath);

        /// <summary>Root of the extracted retail terrain PNGs.</summary>
        public static string RetailRoot => Resolve(RetailRootEnvVar, "retailRoot", RetailSubPath);

        /// <summary>
        /// True when at least one root was explicitly configured, i.e. the picker is pointed at
        /// real data rather than at the neutral relative fallback. The panel can use this to say
        /// "not configured" instead of "file not found at pbr-terrain/picker".
        /// </summary>
        public static bool IsConfigured =>
            Env(RootEnvVar) != null || Env(PickerDirectoryEnvVar) != null ||
            Env(SetsRootEnvVar) != null || Env(PoolRootEnvVar) != null ||
            Env(RetailRootEnvVar) != null ||
            Config("root") != null || Config("pickerDirectory") != null ||
            Config("setsRoot") != null || Config("poolRoot") != null ||
            Config("retailRoot") != null;

        /// <summary>
        /// Drops the cached local config so the next read picks the file up again. Tests that
        /// write a config file call this; nothing in the app needs it.
        /// </summary>
        public static void Refresh() {
            lock (_configLock) {
                _config = null;
                _configLoaded = false;
            }
        }

        private static string Resolve(string envVar, string configKey, string[] subPath) {
            var direct = FirstNonEmpty(Env(envVar), Config(configKey));
            if (direct != null) return direct;
            var combined = Root;
            foreach (var part in subPath) combined = Path.Combine(combined, part);
            return combined;
        }

        private static string? Env(string name) {
            string? v;
            try { v = Environment.GetEnvironmentVariable(name); }
            catch (Exception) { return null; }   // a locked-down host can deny env reads
            return string.IsNullOrWhiteSpace(v) ? null : v.Trim();
        }

        private static string? Config(string key) {
            var cfg = LoadConfig();
            if (cfg == null) return null;
            return cfg.TryGetValue(key, out var v) && !string.IsNullOrWhiteSpace(v) ? v.Trim() : null;
        }

        private static string? FirstNonEmpty(params string?[] candidates) {
            foreach (var c in candidates) {
                if (!string.IsNullOrWhiteSpace(c)) return c;
            }
            return null;
        }

        private static Dictionary<string, string>? LoadConfig() {
            lock (_configLock) {
                if (_configLoaded) return _config;
                _configLoaded = true;
                _config = ReadFirstConfigFile();
                return _config;
            }
        }

        private static Dictionary<string, string>? ReadFirstConfigFile() {
            foreach (var path in ConfigSearchPaths()) {
                if (string.IsNullOrWhiteSpace(path)) continue;
                try {
                    if (!File.Exists(path)) continue;
                    using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
                    if (doc.RootElement.ValueKind != JsonValueKind.Object) continue;
                    var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var prop in doc.RootElement.EnumerateObject()) {
                        if (prop.Value.ValueKind == JsonValueKind.String) {
                            var s = prop.Value.GetString();
                            if (!string.IsNullOrWhiteSpace(s)) map[prop.Name] = s!;
                        }
                    }
                    return map;
                }
                // A malformed or unreadable local config must never take the editor down: fall
                // through to the next candidate and ultimately to the neutral default.
                catch (Exception) { }
            }
            return null;
        }

        private static IEnumerable<string?> ConfigSearchPaths() {
            yield return Env(ConfigEnvVar);
            yield return LocalConfigFileName;                       // current directory
            string? baseDir = null;
            try { baseDir = AppContext.BaseDirectory; } catch (Exception) { }
            if (!string.IsNullOrWhiteSpace(baseDir))
                yield return Path.Combine(baseDir!, LocalConfigFileName);
            var xdg = Env("XDG_CONFIG_HOME");
            if (xdg == null) {
                string? home = null;
                try {
                    home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                } catch (Exception) { }
                if (!string.IsNullOrWhiteSpace(home)) xdg = Path.Combine(home!, ".config");
            }
            if (!string.IsNullOrWhiteSpace(xdg))
                yield return Path.Combine(xdg!, "worldbuilder", LocalConfigFileName);
        }
    }
}
