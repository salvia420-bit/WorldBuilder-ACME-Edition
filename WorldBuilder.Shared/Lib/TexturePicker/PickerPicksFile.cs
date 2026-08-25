using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorldBuilder.Shared.Lib.TexturePicker {
    /// <summary>
    /// X-track texture-picker output contract — <c>picker-picks.json</c>, the human's decisions,
    /// written as <c>picker-picks.json</c> in the picker directory
    /// (<see cref="TexturePickerPaths.PickerDirectory"/>).
    ///
    /// Keyed by retail RenderSurface DID ("0x06003C25"). A SKIP is recorded as an entry with
    /// <see cref="PickerPick.Skipped"/> = true and a null <see cref="PickerPick.AssetId"/>, so the
    /// file carries the full three-way state (picked / skipped / absent = undecided) and the
    /// worklist progress survives a restart.
    ///
    /// All members are PROPERTIES — System.Text.Json drops public fields without IncludeFields.
    /// </summary>
    public sealed class PickerPicksFile {
        public int Version { get; set; } = 1;

        public Dictionary<string, PickerPick> Picks { get; set; } =
            new(StringComparer.OrdinalIgnoreCase);

        public static readonly JsonSerializerOptions SerializerOptions = new() {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            WriteIndented = true,
        };

        /// <summary>
        /// Loads the picks file, or returns a fresh empty one when the file is missing.
        /// A corrupt file throws — callers should surface that rather than silently discarding
        /// a human's accumulated taste decisions.
        /// </summary>
        public static PickerPicksFile Load(string path) {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return new PickerPicksFile();
            var json = File.ReadAllText(path);
            if (string.IsNullOrWhiteSpace(json)) return new PickerPicksFile();
            var loaded = JsonSerializer.Deserialize<PickerPicksFile>(json, SerializerOptions)
                         ?? new PickerPicksFile();
            // Deserialization builds a default-comparer dictionary; re-key case-insensitively so
            // "0x06003c25" and "0x06003C25" cannot both hold a decision for the same surface.
            var reKeyed = new Dictionary<string, PickerPick>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in loaded.Picks) reKeyed[kv.Key] = kv.Value;
            loaded.Picks = reKeyed;
            return loaded;
        }

        /// <summary>
        /// Atomic write: serialize to a sibling temp file in the SAME directory, then
        /// <see cref="File.Move(string,string,bool)"/> over the target. Same-directory temp keeps
        /// the rename on one filesystem so it is a real atomic replace — a crash mid-write can never
        /// leave a truncated picks file.
        /// </summary>
        public void Save(string path) {
            var dir = Path.GetDirectoryName(Path.GetFullPath(path));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            var tmp = path + ".tmp-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            try {
                File.WriteAllText(tmp, JsonSerializer.Serialize(this, SerializerOptions));
                File.Move(tmp, path, overwrite: true);
            }
            finally {
                if (File.Exists(tmp)) {
                    try { File.Delete(tmp); } catch { /* best effort */ }
                }
            }
        }
    }

    /// <summary>One decision. <see cref="AssetId"/> null + <see cref="Skipped"/> true = skipped.</summary>
    public sealed class PickerPick {
        /// <summary>Chosen CC0 asset id, or null when the surface was skipped.</summary>
        public string? AssetId { get; set; }

        /// <summary>Repeat factor the human settled on in the preview.</summary>
        public PickerVec2? RepeatFactor { get; set; }

        /// <summary>Optional brightness gain to apply at bake time. Null = untouched.</summary>
        public double? Gain { get; set; }

        /// <summary>Optional [r,g,b] tint (0..1) to apply at bake time. Null = untouched.</summary>
        public double[]? Tint { get; set; }

        public string? Note { get; set; }

        /// <summary>ISO-8601 UTC timestamp of the decision.</summary>
        public string? DecidedAt { get; set; }

        /// <summary>True when the human explicitly skipped this surface.</summary>
        public bool Skipped { get; set; }

        public static string NowStamp() => DateTime.UtcNow.ToString("O");
    }

    /// <summary>
    /// Parsing/formatting for <see cref="PickerPick.Tint"/> — an [r,g,b] MULTIPLIER triple, not a
    /// colour: 1,1,1 is "leave the texture alone". Two entry forms are accepted so the panel can get
    /// away with one narrow text box on a 280 px dock:
    ///
    ///   "#8fa0b4"      hex, read as byte/255 multipliers (what an eyedropper gives you)
    ///   "0.9 0.95 1"   three numbers, comma- or space-separated (what a bake note gives you)
    ///   "0.9"          one number, applied to all three channels
    ///
    /// Empty/whitespace parses to null — "untouched" — which is what gets persisted.
    /// </summary>
    public static class PickerTint {
        public const double MinChannel = 0.0;
        public const double MaxChannel = 4.0;

        /// <summary>
        /// True when <paramref name="text"/> is a valid tint (including empty = null tint).
        /// False leaves <paramref name="tint"/> null and means "the human is mid-typing / typo'd".
        /// </summary>
        public static bool TryParse(string? text, out double[]? tint) {
            tint = null;
            if (string.IsNullOrWhiteSpace(text)) return true;
            var s = text!.Trim();

            if (s.StartsWith("#", StringComparison.Ordinal)) {
                var hex = s.Substring(1);
                if (hex.Length == 3) hex = string.Concat(hex[0], hex[0], hex[1], hex[1], hex[2], hex[2]);
                if (hex.Length != 6) return false;
                var channels = new double[3];
                for (int i = 0; i < 3; i++) {
                    if (!byte.TryParse(hex.Substring(i * 2, 2),
                            System.Globalization.NumberStyles.HexNumber,
                            System.Globalization.CultureInfo.InvariantCulture, out var b)) return false;
                    channels[i] = Math.Round(b / 255.0, 4);
                }
                tint = channels;
                return true;
            }

            var parts = s.Split(new[] { ',', ' ', ';', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 1 && parts.Length != 3) return false;
            var parsed = new double[3];
            for (int i = 0; i < parts.Length; i++) {
                if (!double.TryParse(parts[i], System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out var v)) return false;
                if (!double.IsFinite(v) || v < MinChannel || v > MaxChannel) return false;
                parsed[i] = Math.Round(v, 4);
            }
            if (parts.Length == 1) { parsed[1] = parsed[2] = parsed[0]; }
            tint = parsed;
            return true;
        }

        /// <summary>Canonical text form ("0.9,0.95,1"), or "" for a null/short tint.</summary>
        public static string Format(double[]? tint) {
            if (tint == null || tint.Length < 3) return "";
            return string.Join(",", new[] { tint[0], tint[1], tint[2] }.Select(
                v => v.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture)));
        }

        /// <summary>"#rrggbb" for the swatch, clamping multipliers &gt; 1 to white.</summary>
        public static string ToHex(double[]? tint) {
            if (tint == null || tint.Length < 3) return "#FFFFFF";
            string Channel(double v) =>
                ((int)Math.Round(Math.Clamp(v, 0, 1) * 255)).ToString("X2",
                    System.Globalization.CultureInfo.InvariantCulture);
            return "#" + Channel(tint[0]) + Channel(tint[1]) + Channel(tint[2]);
        }
    }
}
