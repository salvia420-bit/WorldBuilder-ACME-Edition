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
        IReadOnlyDictionary<int, string> NameByTypeIndex,
        IReadOnlyDictionary<int, uint[]> SceneryByType);

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

        // Optional `scenery` block: array of { typeIndex, modelIds: [uint, ...] } entries.
        // Lets the codebook drive scenery scatter instead of the hardcoded retail-ID table
        // baked into CommandEngine.QuickWorld. Absence keeps callers on the legacy fallback.
        var sceneryByType = new Dictionary<int, uint[]>();
        if (root.TryGetProperty("scenery", out var sceneryArray) && sceneryArray.ValueKind == JsonValueKind.Array) {
            foreach (var entry in sceneryArray.EnumerateArray()) {
                if (!entry.TryGetProperty("typeIndex", out var tiProp)) continue;
                int ti = tiProp.GetInt32();
                if (ti < byte.MinValue || ti > byte.MaxValue) {
                    warn?.Invoke($"skipping scenery entry for type {ti} (outside byte range 0-255)");
                    continue;
                }
                if (!entry.TryGetProperty("modelIds", out var modelsArr) || modelsArr.ValueKind != JsonValueKind.Array)
                    continue;
                var ids = new List<uint>(modelsArr.GetArrayLength());
                foreach (var m in modelsArr.EnumerateArray()) {
                    // Accept numeric (decimal/uint) or hex string ("0x02000B53") forms.
                    if (m.ValueKind == JsonValueKind.Number && m.TryGetUInt32(out var u)) {
                        ids.Add(u);
                    } else if (m.ValueKind == JsonValueKind.String) {
                        var s = m.GetString();
                        if (string.IsNullOrEmpty(s)) continue;
                        var trimmed = s.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? s.Substring(2) : s;
                        if (uint.TryParse(trimmed, System.Globalization.NumberStyles.HexNumber,
                                System.Globalization.CultureInfo.InvariantCulture, out var hu)) {
                            ids.Add(hu);
                        } else {
                            warn?.Invoke($"unparseable scenery modelId '{s}' for type {ti}");
                        }
                    }
                }
                if (ids.Count > 0) sceneryByType[ti] = ids.ToArray();
            }
        }

        return new Codebook(colors, classificationColors, heightPercentiles, heightMinMax, nameByTypeIndex, sceneryByType);
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
    /// <paramref name="jitter"/> is added before clamping — callers should derive it from
    /// <see cref="CoherentJitter"/> so vertices shared between adjacent landblocks resolve to
    /// the same value (no micro-seams at landblock boundaries).
    /// </summary>
    public static byte EstimateHeight(int terrainType, double brightness01, Codebook codebook, int jitter) {
        if (brightness01 < 0) brightness01 = 0;
        else if (brightness01 > 1) brightness01 = 1;

        if (codebook.HeightPercentiles.TryGetValue(terrainType, out var pArr) && pArr.Length > 0) {
            int pIdx = pArr.Length == 101
                ? Math.Clamp((int)Math.Round(brightness01 * 100.0), 0, 100)
                : Math.Clamp((int)Math.Round(brightness01 * (pArr.Length - 1)), 0, pArr.Length - 1);
            return (byte)Math.Clamp(pArr[pIdx] + jitter, 0, 255);
        }

        if (codebook.HeightMinMax.TryGetValue(terrainType, out var minMax)) {
            int span = minMax.Max - minMax.Min;
            int baseH = minMax.Min + (int)Math.Round(brightness01 * span);
            return (byte)Math.Clamp(baseH + jitter, 0, 255);
        }

        int fallback = (int)Math.Round(brightness01 * 255.0);
        return (byte)Math.Clamp(fallback + jitter, 0, 255);
    }

    /// <summary>
    /// Coherent integer hash → [-2, +2] keyed on (noiseSeed, globalVertexX, globalVertexY).
    /// The same (gx,gy) always yields the same value, so the seam vertex shared by two adjacent
    /// landblocks (which both sample the same global coordinate) gets identical jitter — no
    /// height discontinuity at landblock boundaries.
    /// Implementation: splitmix32-style avalanche of the three inputs.
    /// </summary>
    public static int CoherentJitter(int noiseSeed, int gx, int gy) {
        unchecked {
            uint h = (uint)noiseSeed;
            h ^= (uint)gx * 0x9E3779B1u;
            h = ((h << 13) | (h >> 19));
            h ^= (uint)gy * 0x85EBCA77u;
            h = ((h << 17) | (h >> 15));
            h = (h ^ (h >> 16)) * 0x7FEB352Du;
            h = (h ^ (h >> 15)) * 0x846CA68Bu;
            h ^= (h >> 16);
            // Map uniformly to [-2..2] (5 buckets).
            return (int)(h % 5u) - 2;
        }
    }

    /// <summary>
    /// Stack-only xorshift32 PRNG. Avoids allocating <see cref="Random"/> per-landblock during
    /// Phase 3 scenery scatter while preserving per-LB determinism (state is seeded from
    /// <c>noiseSeed ⊕ lbKey</c>). Not cryptographic; just needs to be reproducible.
    /// </summary>
    public struct XorShift32 {
        private uint _state;

        public XorShift32(uint seed) {
            // xorshift32 is degenerate at state 0 — bump to 1 in that case.
            _state = seed == 0 ? 1u : seed;
        }

        public uint NextUInt() {
            uint x = _state;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            _state = x;
            return x;
        }

        /// <summary>Returns an int in [minInclusive, maxExclusive). Uses rejection-free modulo.</summary>
        public int Next(int minInclusive, int maxExclusive) {
            uint range = (uint)(maxExclusive - minInclusive);
            return minInclusive + (int)(NextUInt() % range);
        }

        /// <summary>Returns an int in [0, maxExclusive).</summary>
        public int Next(int maxExclusive) => (int)(NextUInt() % (uint)maxExclusive);

        /// <summary>Returns a double in [0, 1).</summary>
        public double NextDouble() => (NextUInt() & 0xFFFFFFu) / (double)(1u << 24);
    }
}
