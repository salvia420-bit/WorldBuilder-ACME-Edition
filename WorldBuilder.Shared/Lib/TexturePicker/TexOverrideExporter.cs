using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorldBuilder.Shared.Lib.TexturePicker {
    /// <summary>One exported override: retail RenderSurface DID + the source PNG to ship for it.</summary>
    public readonly record struct TexOverrideEntry(string Did, string SourcePngPath);

    /// <summary>Outcome of an export, for the panel status line.</summary>
    public sealed record TexOverrideExportResult(string Directory, int OverrideCount, string ManifestPath);

    /// <summary>
    /// Writes a holtburger <c>statTexOverride</c> bundle — a directory of diffuse PNGs plus a
    /// <c>manifest.json</c>, byte-shape identical to the reference bundle at
    /// <c>external/holtburger/apps/holtburger-web/data/tex-overrides/</c>:
    ///
    ///   { "version": 1, "note": "...", "overrides": [ { "did": "0x06003C25", "src": "0x06003C25.png" } ] }
    ///
    /// <c>src</c> is always a bundle-relative filename (<c>&lt;did&gt;.png</c>), never an absolute
    /// path, so the bundle can be dropped anywhere the client serves it from.
    ///
    /// DIFFUSE ONLY. Normal/roughness planes are intentionally out of scope for the X-track picker;
    /// <see cref="NormalRoughTodoNote"/> is appended to every exported note so the gap is visible in
    /// the artifact itself.
    /// </summary>
    public static class TexOverrideExporter {
        public const string ManifestFileName = "manifest.json";

        /// <summary>Appended to every exported note — diffuse-only bundle, planes still to come.</summary>
        public const string NormalRoughTodoNote = "normal/rough planes TODO(X5 wiring)";

        private static readonly JsonSerializerOptions ManifestOptions = new() {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = true,
        };

        /// <summary>
        /// Copies each entry's PNG into <paramref name="destinationDirectory"/> as
        /// <c>&lt;did&gt;.png</c> and writes the manifest. Existing files are overwritten.
        /// </summary>
        public static TexOverrideExportResult Export(
            IEnumerable<TexOverrideEntry> entries,
            string destinationDirectory,
            string? note = null) {
            if (entries == null) throw new ArgumentNullException(nameof(entries));
            if (string.IsNullOrWhiteSpace(destinationDirectory))
                throw new ArgumentException("destination directory is required", nameof(destinationDirectory));

            Directory.CreateDirectory(destinationDirectory);

            var overrides = new List<TexOverrideManifestEntry>();
            foreach (var entry in entries) {
                if (string.IsNullOrWhiteSpace(entry.Did)) continue;
                if (string.IsNullOrWhiteSpace(entry.SourcePngPath) || !File.Exists(entry.SourcePngPath))
                    throw new FileNotFoundException(
                        $"Texture override source missing for {entry.Did}", entry.SourcePngPath);

                var fileName = entry.Did + ".png";
                File.Copy(entry.SourcePngPath, Path.Combine(destinationDirectory, fileName), overwrite: true);
                overrides.Add(new TexOverrideManifestEntry { Did = entry.Did, Src = fileName });
            }

            var manifest = new TexOverrideManifest {
                Version = 1,
                Note = ComposeNote(note),
                Overrides = overrides,
            };

            var manifestPath = Path.Combine(destinationDirectory, ManifestFileName);
            var tmp = manifestPath + ".tmp-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            try {
                File.WriteAllText(tmp, JsonSerializer.Serialize(manifest, ManifestOptions));
                File.Move(tmp, manifestPath, overwrite: true);
            }
            finally {
                if (File.Exists(tmp)) {
                    try { File.Delete(tmp); } catch { /* best effort */ }
                }
            }

            return new TexOverrideExportResult(destinationDirectory, overrides.Count, manifestPath);
        }

        /// <summary>Prefixes the caller's note and always terminates with the diffuse-only TODO.</summary>
        public static string ComposeNote(string? note) {
            var head = string.IsNullOrWhiteSpace(note)
                ? "WorldBuilder Texture Picker export (diffuse only)."
                : note!.Trim();
            if (head.Contains(NormalRoughTodoNote, StringComparison.Ordinal)) return head;
            if (!head.EndsWith(".", StringComparison.Ordinal)) head += ".";
            return head + " " + NormalRoughTodoNote;
        }

        /// <summary>Reads a bundle manifest back — used by tests and by re-import.</summary>
        public static TexOverrideManifest? LoadManifest(string manifestPath) {
            if (!File.Exists(manifestPath)) return null;
            return JsonSerializer.Deserialize<TexOverrideManifest>(
                File.ReadAllText(manifestPath),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
    }

    public sealed class TexOverrideManifest {
        public int Version { get; set; } = 1;
        public string? Note { get; set; }
        public List<TexOverrideManifestEntry> Overrides { get; set; } = new();
    }

    public sealed class TexOverrideManifestEntry {
        public string Did { get; set; } = "";
        public string Src { get; set; } = "";
    }
}
