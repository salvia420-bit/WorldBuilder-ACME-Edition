using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using AcmeSky.Model;
using Microsoft.Extensions.Logging;

namespace AcmeSky.Services {
    /// <summary>
    /// Loads the six buildbox skytime_&lt;class&gt;.json palettes (clear/scattered/broken/overcast/
    /// rain/storm) and hands out the interpolated atmosphere <see cref="SkyPaletteData.Sample"/> for
    /// the current time-of-day and weather class. Drives the atmosphere dome's gradient and the
    /// per-layer cloud tint.
    /// </summary>
    public sealed class SkyPalette {
        private readonly ILogger _log;
        private readonly Dictionary<string, SkyPaletteData> _byClass =
            new(StringComparer.OrdinalIgnoreCase);
        private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

        public const string DefaultClass = "clear";
        public IReadOnlyCollection<string> Classes => _byClass.Keys;
        public bool Loaded => _byClass.Count > 0;

        public SkyPalette(ILogger log) { _log = log; }

        /// <summary>Load every skytime_*.json in <paramref name="skyAssetDir"/>.</summary>
        public void Load(string skyAssetDir) {
            try {
                if (!Directory.Exists(skyAssetDir)) {
                    _log.LogWarning("acmesky: sky asset dir not found: {Dir}", skyAssetDir);
                    return;
                }
                foreach (var f in Directory.EnumerateFiles(skyAssetDir, "skytime_*.json")) {
                    try {
                        var data = JsonSerializer.Deserialize<SkyPaletteData>(File.ReadAllText(f), JsonOpts);
                        if (data is { Keyframes.Count: > 0 }) {
                            string cls = data.Class ?? Path.GetFileNameWithoutExtension(f).Replace("skytime_", "");
                            _byClass[cls] = data;
                        }
                    }
                    catch (Exception ex) { _log.LogWarning(ex, "acmesky: bad palette {File}", f); }
                }
                _log.LogInformation("acmesky: loaded {N} sky palettes: {Classes}",
                    _byClass.Count, string.Join(",", _byClass.Keys));
            }
            catch (Exception ex) { _log.LogWarning(ex, "acmesky: palette load failed"); }
        }

        /// <summary>The interpolated sample for a class at 0..1 time-of-day; falls back to any class.</summary>
        public SkyPaletteData.Sample Sample(string className, float time) {
            if (_byClass.TryGetValue(className, out var d)) return d.At(time);
            if (_byClass.TryGetValue(DefaultClass, out var def)) return def.At(time);
            foreach (var v in _byClass.Values) return v.At(time);
            return default;
        }
    }
}
