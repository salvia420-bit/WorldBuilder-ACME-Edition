using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text.Json;

namespace AcmeLauncher {
    /// <summary>
    /// Plugin management by FOLDER PRESENCE — Chorizite loads every folder under
    /// <c>&lt;ChoriziteDir&gt;\plugins\</c> that has a manifest.json; there is no per-plugin enable
    /// flag. So "enabled" = the folder lives in <c>plugins\</c>, "disabled" = we've moved it aside to
    /// <c>plugins-disabled\</c>. Changes take effect on the NEXT injection (an already-injected client
    /// keeps whatever it loaded until it's relaunched). Install = drop a valid plugin folder/zip into
    /// <c>plugins\</c>; Uninstall = delete the folder.
    /// </summary>
    internal static class PluginMgmt {
        public sealed class Info {
            public string Folder = "";     // on-disk folder name
            public string Name = "";       // manifest "name" (falls back to folder)
            public bool Enabled;           // true = in plugins\, false = in plugins-disabled\
        }

        private const string EnabledSub = "plugins";
        private const string DisabledSub = "plugins-disabled";

        public static string EnabledDir(string choriziteDir) => Path.Combine(choriziteDir, EnabledSub);
        public static string DisabledDir(string choriziteDir) => Path.Combine(choriziteDir, DisabledSub);

        /// <summary>Every plugin folder in plugins\ (enabled) and plugins-disabled\ (disabled),
        /// each identified by its manifest.json. Empty list if the dir is unset/missing.</summary>
        public static List<Info> Enumerate(string? choriziteDir) {
            var list = new List<Info>();
            if (string.IsNullOrEmpty(choriziteDir) || !Directory.Exists(choriziteDir)) return list;
            Scan(EnabledDir(choriziteDir!), true, list);
            Scan(DisabledDir(choriziteDir!), false, list);
            list.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
            return list;
        }

        private static void Scan(string dir, bool enabled, List<Info> into) {
            if (!Directory.Exists(dir)) return;
            foreach (var folder in Directory.GetDirectories(dir)) {
                var manifest = Path.Combine(folder, "manifest.json");
                if (!File.Exists(manifest)) continue;   // not a plugin
                into.Add(new Info { Folder = Path.GetFileName(folder), Name = ReadName(manifest, Path.GetFileName(folder)), Enabled = enabled });
            }
        }

        private static string ReadName(string manifest, string fallback) {
            try {
                using var doc = JsonDocument.Parse(File.ReadAllText(manifest));
                if (doc.RootElement.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String)
                    return n.GetString() ?? fallback;
            } catch { }
            return fallback;
        }

        /// <summary>Enable/disable by moving the folder between plugins\ and plugins-disabled\.
        /// Throws on failure (caller shows the message).</summary>
        public static void SetEnabled(string choriziteDir, string folder, bool enable) {
            var from = Path.Combine(enable ? DisabledDir(choriziteDir) : EnabledDir(choriziteDir), folder);
            var to = Path.Combine(enable ? EnabledDir(choriziteDir) : DisabledDir(choriziteDir), folder);
            if (!Directory.Exists(from)) {
                if (Directory.Exists(to)) return;   // already in the desired state
                throw new DirectoryNotFoundException($"Plugin folder '{folder}' not found.");
            }
            Directory.CreateDirectory(Path.GetDirectoryName(to)!);
            if (Directory.Exists(to)) throw new IOException($"A '{folder}' already exists in the target — resolve it by hand.");
            Directory.Move(from, to);
        }

        /// <summary>Install a plugin from a folder OR a .zip into plugins\. The source must contain a
        /// manifest.json (at its root or one level down). Returns the installed folder name.</summary>
        public static string Install(string choriziteDir, string source) {
            var dest = EnabledDir(choriziteDir);
            Directory.CreateDirectory(dest);
            if (Directory.Exists(source)) {
                if (!File.Exists(Path.Combine(source, "manifest.json")))
                    throw new InvalidOperationException("That folder has no manifest.json — it isn't a Chorizite plugin.");
                var name = Path.GetFileName(source.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
                var target = Path.Combine(dest, name);
                if (Directory.Exists(target)) throw new IOException($"'{name}' is already installed — uninstall it first.");
                CopyDir(source, target);
                return name;
            }
            if (File.Exists(source) && source.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) {
                var tmp = Path.Combine(Path.GetTempPath(), "zzp_" + Guid.NewGuid().ToString("N"));
                ZipFile.ExtractToDirectory(source, tmp);
                try {
                    var root = FindManifestRoot(tmp) ?? throw new InvalidOperationException("The zip has no manifest.json — it isn't a Chorizite plugin.");
                    var name = Path.GetFileName(root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
                    if (string.IsNullOrEmpty(name) || root == tmp) name = Path.GetFileNameWithoutExtension(source);
                    var target = Path.Combine(dest, name);
                    if (Directory.Exists(target)) throw new IOException($"'{name}' is already installed — uninstall it first.");
                    CopyDir(root, target);
                    return name;
                }
                finally { try { Directory.Delete(tmp, true); } catch { } }
            }
            throw new InvalidOperationException("Pick a plugin folder or a .zip.");
        }

        /// <summary>Delete a plugin's folder from whichever of plugins\ / plugins-disabled\ holds it.</summary>
        public static void Uninstall(string choriziteDir, string folder) {
            foreach (var d in new[] { EnabledDir(choriziteDir), DisabledDir(choriziteDir) }) {
                var p = Path.Combine(d, folder);
                if (Directory.Exists(p)) { Directory.Delete(p, true); return; }
            }
            throw new DirectoryNotFoundException($"Plugin folder '{folder}' not found.");
        }

        /// <summary>Is this plugin the one that carries the memory-crash protection?
        /// Matched by folder identity only — a third-party plugin merely named "…Lights…"
        /// must not trigger the crash-protection warning.</summary>
        public static bool IsCrashProtection(Info p) =>
            p.Folder.Equals("AcmeLights", StringComparison.OrdinalIgnoreCase);

        private static string? FindManifestRoot(string dir) {
            if (File.Exists(Path.Combine(dir, "manifest.json"))) return dir;
            foreach (var sub in Directory.GetDirectories(dir))
                if (File.Exists(Path.Combine(sub, "manifest.json"))) return sub;
            return null;
        }

        private static void CopyDir(string from, string to) {
            Directory.CreateDirectory(to);
            foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
            foreach (var d in Directory.GetDirectories(from)) CopyDir(d, Path.Combine(to, Path.GetFileName(d)));
        }
    }
}
