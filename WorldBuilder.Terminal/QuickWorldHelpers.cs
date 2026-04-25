using System;
using System.Collections.Generic;
using System.Text.Json;

namespace WorldBuilder.Terminal;

/// <summary>
/// Pure helpers extracted from CommandEngine.QuickWorld so the codebook parser,
/// per-pixel classifier, and height estimator can be unit-tested without a project context.
/// Scenery scatter is intentionally left in CommandEngine until the data-driven scenery rework lands.
/// </summary>
public static class QuickWorldHelpers {
    /// <summary>Codebook sentinel index (legacy DAT marker, not a real terrain class).</summary>
    public const int EXCLUDED_TERRAIN_TYPE = 32;

    /// <summary>Squared RGB Euclidean distance above which a vertex is counted as a "fuzzy match".</summary>
    public const double APPROX_MATCH_DIST_SQ = 2500.0;

    public readonly record struct TerrainColor(int TypeIndex, string Name, int R, int G, int B);

    public sealed record Codebook(
        IReadOnlyList<TerrainColor> Colors,
        IReadOnlyList<TerrainColor> ClassificationColors,
        IReadOnlyDictionary<int, byte[]> HeightPercentiles,
        IReadOnlyDictionary<int, (byte Min, byte Max)> HeightMinMax,
        IReadOnlyDictionary<int, string> NameByTypeIndex);

    /// <summary>
    /// Parses a terrain codebook (output of calibrate-world-map) from JSON text.
    /// Skips entries whose typeIndex is outside the 0-255 byte range, surfacing each via the optional warn callback.
    /// </summary>
    public static Codebook ParseCodebook(string jsonText, Action<string>? warn = null) {
        using var doc = JsonDocument.Parse(jsonText);
        var root = doc.RootElement;

        var colors = new List<TerrainColor>();
        var heightPercentiles = new Dictionary<int, byte[]>();
        var heightMinMax = new Dictionary<int, (byte Min, byte Max)>();

        if (root.TryGetProperty("terrainBaseColors", out var colorsArray)) {
            foreach (var c in colorsArray.EnumerateArray()) {
                int ti = c.GetProperty("typeIndex").GetInt32();
                if (ti < byte.MinValue || ti > byte.MaxValue) {
                    warn?.Invoke($"skipping terrain color for type {ti} (outside byte range 0-255)");
                    continue;
                }
                string tn = c.GetProperty("typeName").GetString() ?? $"Type{ti}";
                int r = c.GetProperty("baseR").GetInt32();
                int g = c.GetProperty("baseG").GetInt32();
                int b = c.GetProperty("baseB").GetInt32();
                colors.Add(new TerrainColor(ti, tn, r, g, b));
            }
        }

        if (root.TryGetProperty("heightDistributions", out var distArray)) {
            foreach (var d in distArray.EnumerateArray()) {
                int ti = d.GetProperty("typeIndex").GetInt32();
                if (ti < byte.MinValue || ti > byte.MaxValue) {
                    warn?.Invoke($"skipping height distribution for type {ti} (outside byte range 0-255)");
                    continue;
                }
                var data = d.GetProperty("data");
                byte min = data.GetProperty("min").GetByte();
                byte max = data.GetProperty("max").GetByte();
                heightMinMax[ti] = (min, max);

                if (data.TryGetProperty("percentiles", out var pArr)) {
                    if (pArr.ValueKind == JsonValueKind.String) {
                        heightPercentiles[ti] = Convert.FromBase64String(pArr.GetString()!);
                    } else if (pArr.ValueKind == JsonValueKind.Array) {
                        var pList = new List<byte>(pArr.GetArrayLength());
                        foreach (var p in pArr.EnumerateArray()) pList.Add(p.GetByte());
                        heightPercentiles[ti] = pList.ToArray();
                    }
                }
            }
        }

        var classificationColors = new List<TerrainColor>(colors.Count);
        var nameByTypeIndex = new Dictionary<int, string>(colors.Count);
        foreach (var color in colors) {
            nameByTypeIndex[color.TypeIndex] = color.Name;
            if (color.TypeIndex != EXCLUDED_TERRAIN_TYPE) classificationColors.Add(color);
        }

        return new Codebook(colors, classificationColors, heightPercentiles, heightMinMax, nameByTypeIndex);
    }

    /// <summary>
    /// Returns the typeIndex of the closest classification color (squared Euclidean distance in RGB).
    /// <paramref name="bestDistSq"/> is set to the winning distance — callers compare against
    /// <see cref="APPROX_MATCH_DIST_SQ"/> to tally fuzzy matches.
    /// </summary>
    public static int ClassifyPixel(int r, int g, int b,
        IReadOnlyList<TerrainColor> classificationColors,
        out double bestDistSq) {
        if (classificationColors.Count == 0) throw new ArgumentException("classificationColors must be non-empty", nameof(classificationColors));

        int bestType = classificationColors[0].TypeIndex;
        bestDistSq = double.MaxValue;
        for (int t = 0; t < classificationColors.Count; t++) {
            var c = classificationColors[t];
            double dr = r - c.R;
            double dg = g - c.G;
            double db = b - c.B;
            double dist = dr * dr + dg * dg + db * db;
            if (dist < bestDistSq) {
                bestDistSq = dist;
                bestType = c.TypeIndex;
            }
        }
        return bestType;
    }

    /// <summary>
    /// Estimates a 0-255 height byte for a vertex of the given terrain type. Prefers the codebook's
    /// per-type percentile array, falls back to (min,max) linear mapping, and finally to a
    /// codebook-free linear mapping of <paramref name="brightness01"/> (clamped to 0..1).
    /// Adds ±2 jitter sampled from <paramref name="rng"/>; jitter is per-call by design (see notes in QuickWorld).
    /// </summary>
    public static byte EstimateHeight(int terrainType, double brightness01, Codebook codebook, Random rng) {
        if (brightness01 < 0) brightness01 = 0;
        else if (brightness01 > 1) brightness01 = 1;
        int noise = rng.Next(-2, 3);

        if (codebook.HeightPercentiles.TryGetValue(terrainType, out var pArr) && pArr.Length > 0) {
            int pIdx = pArr.Length == 101
                ? Math.Clamp((int)Math.Round(brightness01 * 100.0), 0, 100)
                : Math.Clamp((int)Math.Round(brightness01 * (pArr.Length - 1)), 0, pArr.Length - 1);
            return (byte)Math.Clamp(pArr[pIdx] + noise, 0, 255);
        }

        if (codebook.HeightMinMax.TryGetValue(terrainType, out var minMax)) {
            int span = minMax.Max - minMax.Min;
            int baseH = minMax.Min + (int)Math.Round(brightness01 * span);
            return (byte)Math.Clamp(baseH + noise, 0, 255);
        }

        int fallback = (int)Math.Round(brightness01 * 255.0);
        return (byte)Math.Clamp(fallback + noise, 0, 255);
    }
}
