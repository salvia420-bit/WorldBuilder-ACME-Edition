using System;
using System.Collections.Generic;
using System.Linq;
using WorldBuilder.Terminal;

namespace WorldBuilder.Tests;

public class QuickWorldHelpersTests {
    // ── ParseCodebook ─────────────────────────────────────────────

    [Fact]
    public void ParseCodebook_WithBasicColorsAndDistributions_PopulatesEverything() {
        var json = """
        {
          "terrainBaseColors": [
            { "typeIndex": 1, "typeName": "Grassland", "baseR": 100, "baseG": 200, "baseB": 50 },
            { "typeIndex": 15, "typeName": "Snow",      "baseR": 240, "baseG": 240, "baseB": 250 }
          ],
          "heightDistributions": [
            { "typeIndex": 1,  "data": { "min": 10, "max": 80, "percentiles": [10, 20, 30, 80] } },
            { "typeIndex": 15, "data": { "min": 200, "max": 250 } }
          ]
        }
        """;

        var book = QuickWorldHelpers.ParseCodebook(json);

        Assert.Equal(2, book.Colors.Count);
        Assert.Equal("Grassland", book.NameByTypeIndex[1]);
        Assert.Equal("Snow", book.NameByTypeIndex[15]);
        Assert.Equal(new byte[] { 10, 20, 30, 80 }, book.HeightPercentiles[1]);
        Assert.False(book.HeightPercentiles.ContainsKey(15));
        Assert.Equal((byte)200, book.HeightMinMax[15].Min);
        Assert.Equal((byte)250, book.HeightMinMax[15].Max);
    }

    [Fact]
    public void ParseCodebook_FiltersExcludedTypeFromClassificationColors() {
        var json = $$"""
        {
          "terrainBaseColors": [
            { "typeIndex": 1, "typeName": "A", "baseR": 0, "baseG": 0, "baseB": 0 },
            { "typeIndex": {{QuickWorldHelpers.EXCLUDED_TERRAIN_TYPE}}, "typeName": "Excluded", "baseR": 0, "baseG": 0, "baseB": 0 },
            { "typeIndex": 5, "typeName": "B", "baseR": 0, "baseG": 0, "baseB": 0 }
          ]
        }
        """;

        var book = QuickWorldHelpers.ParseCodebook(json);

        Assert.Equal(3, book.Colors.Count);
        Assert.Equal(2, book.ClassificationColors.Count);
        Assert.DoesNotContain(book.ClassificationColors, c => c.TypeIndex == QuickWorldHelpers.EXCLUDED_TERRAIN_TYPE);
        Assert.True(book.NameByTypeIndex.ContainsKey(QuickWorldHelpers.EXCLUDED_TERRAIN_TYPE));
    }

    [Fact]
    public void ParseCodebook_WarnsAndSkipsTypeIndexOutsideByteRange() {
        var json = """
        {
          "terrainBaseColors": [
            { "typeIndex": 1,   "typeName": "ok",  "baseR": 0, "baseG": 0, "baseB": 0 },
            { "typeIndex": 300, "typeName": "bad", "baseR": 0, "baseG": 0, "baseB": 0 }
          ],
          "heightDistributions": [
            { "typeIndex": 999, "data": { "min": 0, "max": 5 } }
          ]
        }
        """;
        var warnings = new List<string>();

        var book = QuickWorldHelpers.ParseCodebook(json, warnings.Add);

        Assert.Single(book.Colors);
        Assert.Equal(1, book.Colors[0].TypeIndex);
        Assert.Empty(book.HeightMinMax);
        Assert.Equal(2, warnings.Count);
        Assert.Contains(warnings, w => w.Contains("300"));
        Assert.Contains(warnings, w => w.Contains("999"));
    }

    [Fact]
    public void ParseCodebook_AcceptsBase64EncodedPercentiles() {
        // Three bytes (10, 20, 30) → "ChQe"
        var b64 = Convert.ToBase64String(new byte[] { 10, 20, 30 });
        var json = $$"""
        {
          "terrainBaseColors": [],
          "heightDistributions": [
            { "typeIndex": 1, "data": { "min": 10, "max": 30, "percentiles": "{{b64}}" } }
          ]
        }
        """;

        var book = QuickWorldHelpers.ParseCodebook(json);

        Assert.Equal(new byte[] { 10, 20, 30 }, book.HeightPercentiles[1]);
    }

    [Fact]
    public void ParseCodebook_MissingTerrainBaseColors_ReturnsEmptyColors() {
        var book = QuickWorldHelpers.ParseCodebook("{}");
        Assert.Empty(book.Colors);
        Assert.Empty(book.ClassificationColors);
    }

    // ── ClassifyPixel ─────────────────────────────────────────────

    [Fact]
    public void ClassifyPixel_ExactMatch_ReturnsZeroDistance() {
        var palette = new[] {
            new QuickWorldHelpers.TerrainColor(1, "red",   255, 0, 0),
            new QuickWorldHelpers.TerrainColor(2, "green", 0, 255, 0),
            new QuickWorldHelpers.TerrainColor(3, "blue",  0, 0, 255),
        };

        var t = QuickWorldHelpers.ClassifyPixel(0, 255, 0, palette, out var dist);

        Assert.Equal(2, t);
        Assert.Equal(0.0, dist);
    }

    [Fact]
    public void ClassifyPixel_PicksNearestNeighbor() {
        var palette = new[] {
            new QuickWorldHelpers.TerrainColor(1, "darkred", 200, 0, 0),
            new QuickWorldHelpers.TerrainColor(2, "lime",    0, 200, 0),
        };

        // 220,5,5 is much closer to (200,0,0) than to (0,200,0)
        var t = QuickWorldHelpers.ClassifyPixel(220, 5, 5, palette, out var dist);

        Assert.Equal(1, t);
        // dist = 20² + 5² + 5² = 400 + 25 + 25 = 450
        Assert.Equal(450.0, dist);
    }

    [Fact]
    public void ClassifyPixel_DistanceCrossesApproxThreshold_WhenFarFromAllPalettes() {
        var palette = new[] { new QuickWorldHelpers.TerrainColor(1, "black", 0, 0, 0) };

        // Bright white is 195075 squared distance (255² × 3) — well above APPROX_MATCH_DIST_SQ.
        QuickWorldHelpers.ClassifyPixel(255, 255, 255, palette, out var dist);
        Assert.True(dist > QuickWorldHelpers.APPROX_MATCH_DIST_SQ);
    }

    [Fact]
    public void ClassifyPixel_EmptyPalette_Throws() {
        Assert.Throws<ArgumentException>(() =>
            QuickWorldHelpers.ClassifyPixel(0, 0, 0, Array.Empty<QuickWorldHelpers.TerrainColor>(), out _));
    }

    // ── EstimateHeight ────────────────────────────────────────────

    private static QuickWorldHelpers.Codebook MakeCodebook(
        IReadOnlyDictionary<int, byte[]>? percentiles = null,
        IReadOnlyDictionary<int, (byte Min, byte Max)>? minMax = null) {
        return new QuickWorldHelpers.Codebook(
            Colors: Array.Empty<QuickWorldHelpers.TerrainColor>(),
            ClassificationColors: Array.Empty<QuickWorldHelpers.TerrainColor>(),
            HeightPercentiles: percentiles ?? new Dictionary<int, byte[]>(),
            HeightMinMax: minMax ?? new Dictionary<int, (byte, byte)>(),
            NameByTypeIndex: new Dictionary<int, string>());
    }

    [Fact]
    public void EstimateHeight_PercentilesPath_PicksPercentileByBrightness() {
        // 101 entries: pArr[i] = i. Then brightness 0.5 → index 50 → value 50.
        var pArr = Enumerable.Range(0, 101).Select(i => (byte)i).ToArray();
        var book = MakeCodebook(percentiles: new Dictionary<int, byte[]> { [3] = pArr });
        var rng = new Random(0);

        // Run several samples; jitter is ±2, so all returned values should be within [48, 52].
        for (int i = 0; i < 20; i++) {
            byte h = QuickWorldHelpers.EstimateHeight(3, 0.5, book, rng);
            Assert.InRange(h, (byte)48, (byte)52);
        }
    }

    [Fact]
    public void EstimateHeight_MinMaxPath_LinearWithinRange() {
        var book = MakeCodebook(minMax: new Dictionary<int, (byte Min, byte Max)> { [7] = (100, 200) });
        var rng = new Random(42);

        // brightness 0 → ~100 ± 2;  brightness 1 → ~200 ± 2
        byte low  = QuickWorldHelpers.EstimateHeight(7, 0.0, book, rng);
        byte high = QuickWorldHelpers.EstimateHeight(7, 1.0, book, rng);

        Assert.InRange(low,  (byte)98,  (byte)102);
        Assert.InRange(high, (byte)198, (byte)202);
    }

    [Fact]
    public void EstimateHeight_NoCodebookData_FallsBackToLinear0to255() {
        var book = MakeCodebook();
        var rng = new Random(7);

        byte mid = QuickWorldHelpers.EstimateHeight(99, 0.5, book, rng);
        // linear: round(0.5 * 255) = 128, ± 2 jitter
        Assert.InRange(mid, (byte)126, (byte)130);
    }

    [Fact]
    public void EstimateHeight_ClampsBrightnessAndOutput() {
        var book = MakeCodebook(minMax: new Dictionary<int, (byte Min, byte Max)> { [1] = (250, 255) });
        var rng = new Random(0);

        // Out-of-range brightness must not throw, and output stays a valid byte.
        byte over  = QuickWorldHelpers.EstimateHeight(1, 5.0,  book, rng);
        byte under = QuickWorldHelpers.EstimateHeight(1, -1.0, book, rng);
        Assert.InRange(over,  (byte)0, (byte)255);
        Assert.InRange(under, (byte)0, (byte)255);
    }

    [Fact]
    public void EstimateHeight_DeterministicWithSameSeed() {
        var pArr = Enumerable.Range(0, 101).Select(i => (byte)i).ToArray();
        var book = MakeCodebook(percentiles: new Dictionary<int, byte[]> { [1] = pArr });

        var a = new Random(12345);
        var b = new Random(12345);

        for (int i = 0; i < 50; i++) {
            double brightness = i / 49.0;
            byte ha = QuickWorldHelpers.EstimateHeight(1, brightness, book, a);
            byte hb = QuickWorldHelpers.EstimateHeight(1, brightness, book, b);
            Assert.Equal(ha, hb);
        }
    }
}
