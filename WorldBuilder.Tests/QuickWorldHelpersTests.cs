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
        IReadOnlyDictionary<int, (byte Min, byte Max)>? minMax = null,
        IReadOnlyDictionary<int, uint[]>? scenery = null) {
        return new QuickWorldHelpers.Codebook(
            Colors: Array.Empty<QuickWorldHelpers.TerrainColor>(),
            ClassificationColors: Array.Empty<QuickWorldHelpers.TerrainColor>(),
            HeightPercentiles: percentiles ?? new Dictionary<int, byte[]>(),
            HeightMinMax: minMax ?? new Dictionary<int, (byte, byte)>(),
            NameByTypeIndex: new Dictionary<int, string>(),
            SceneryByType: scenery ?? new Dictionary<int, uint[]>());
    }

    [Fact]
    public void EstimateHeight_PercentilesPath_PicksPercentileByBrightness() {
        // 101 entries: pArr[i] = i. Then brightness 0.5 → index 50 → value 50.
        var pArr = Enumerable.Range(0, 101).Select(i => (byte)i).ToArray();
        var book = MakeCodebook(percentiles: new Dictionary<int, byte[]> { [3] = pArr });

        // Sweep all five legal jitter values and confirm each lands in [48, 52].
        for (int j = -2; j <= 2; j++) {
            byte h = QuickWorldHelpers.EstimateHeight(3, 0.5, book, j);
            Assert.Equal((byte)(50 + j), h);
        }
    }

    [Fact]
    public void EstimateHeight_MinMaxPath_LinearWithinRange() {
        var book = MakeCodebook(minMax: new Dictionary<int, (byte Min, byte Max)> { [7] = (100, 200) });

        byte low  = QuickWorldHelpers.EstimateHeight(7, 0.0, book, jitter: 0);
        byte high = QuickWorldHelpers.EstimateHeight(7, 1.0, book, jitter: 0);
        Assert.Equal((byte)100, low);
        Assert.Equal((byte)200, high);

        // Jitter is added before clamping.
        Assert.Equal((byte)98,  QuickWorldHelpers.EstimateHeight(7, 0.0, book, jitter: -2));
        Assert.Equal((byte)202, QuickWorldHelpers.EstimateHeight(7, 1.0, book, jitter: 2));
    }

    [Fact]
    public void EstimateHeight_NoCodebookData_FallsBackToLinear0to255() {
        var book = MakeCodebook();
        // linear: round(0.5 * 255) = 128, with explicit jitter.
        Assert.Equal((byte)128, QuickWorldHelpers.EstimateHeight(99, 0.5, book, jitter: 0));
        Assert.Equal((byte)126, QuickWorldHelpers.EstimateHeight(99, 0.5, book, jitter: -2));
        Assert.Equal((byte)130, QuickWorldHelpers.EstimateHeight(99, 0.5, book, jitter: 2));
    }

    [Fact]
    public void EstimateHeight_ClampsBrightnessAndOutput() {
        var book = MakeCodebook(minMax: new Dictionary<int, (byte Min, byte Max)> { [1] = (250, 255) });

        // Out-of-range brightness must not throw, and output stays a valid byte even with jitter overflow.
        byte over  = QuickWorldHelpers.EstimateHeight(1, 5.0,  book, jitter: 100);
        byte under = QuickWorldHelpers.EstimateHeight(1, -1.0, book, jitter: -100);
        Assert.Equal((byte)255, over);
        Assert.Equal((byte)150, under);
    }

    [Fact]
    public void EstimateHeight_DeterministicForSameInputs() {
        var pArr = Enumerable.Range(0, 101).Select(i => (byte)i).ToArray();
        var book = MakeCodebook(percentiles: new Dictionary<int, byte[]> { [1] = pArr });

        for (int i = 0; i < 50; i++) {
            double brightness = i / 49.0;
            int jitter = QuickWorldHelpers.CoherentJitter(noiseSeed: 7, gx: i, gy: i * 3);
            byte ha = QuickWorldHelpers.EstimateHeight(1, brightness, book, jitter);
            byte hb = QuickWorldHelpers.EstimateHeight(1, brightness, book, jitter);
            Assert.Equal(ha, hb);
        }
    }

    // ── CoherentJitter ────────────────────────────────────────────

    [Fact]
    public void CoherentJitter_StaysInRangeMinus2ToPlus2() {
        // Sweep a slice of the (gx,gy) grid for a couple of seeds; every value must be in [-2, 2].
        int[] seeds = { 0, 1, -1, 12345, int.MaxValue, int.MinValue };
        foreach (var s in seeds) {
            for (int gx = 0; gx < 64; gx++) {
                for (int gy = 0; gy < 64; gy++) {
                    int j = QuickWorldHelpers.CoherentJitter(s, gx, gy);
                    Assert.InRange(j, -2, 2);
                }
            }
        }
    }

    [Fact]
    public void CoherentJitter_SameInputs_AlwaysSameOutput() {
        // The whole point of "coherent" jitter — adjacent landblocks reading the same global
        // vertex coordinate must compute the same noise value, eliminating boundary seams.
        for (int i = 0; i < 100; i++) {
            int gx = i * 17;
            int gy = i * 13 + 5;
            int a = QuickWorldHelpers.CoherentJitter(42, gx, gy);
            int b = QuickWorldHelpers.CoherentJitter(42, gx, gy);
            Assert.Equal(a, b);
        }
    }

    [Fact]
    public void CoherentJitter_RoughlyUniformAcrossFiveBuckets() {
        // Sanity: with 16k samples we should hit each of the 5 buckets at least a few hundred times.
        var counts = new int[5];
        for (int gx = 0; gx < 128; gx++) {
            for (int gy = 0; gy < 128; gy++) {
                counts[QuickWorldHelpers.CoherentJitter(noiseSeed: 0xC0FFEE, gx, gy) + 2]++;
            }
        }
        // Each bucket should have at least 16384 / 5 / 4 = ~800 entries (very loose lower bound).
        foreach (var c in counts) Assert.True(c > 800, $"bucket count {c} too low — distribution looks broken");
    }

    [Fact]
    public void CoherentJitter_DiffersByGlobalCoordinate() {
        // Adjacent vertices should generally produce different jitter (not always — there are
        // only 5 possible outputs — but across many samples we expect plenty of variation).
        int distinct = 0;
        int prev = QuickWorldHelpers.CoherentJitter(99, 0, 0);
        for (int i = 1; i < 200; i++) {
            int cur = QuickWorldHelpers.CoherentJitter(99, i, 0);
            if (cur != prev) distinct++;
            prev = cur;
        }
        Assert.True(distinct > 100, $"only {distinct}/199 transitions — hash looks degenerate");
    }

    // ── XorShift32 ────────────────────────────────────────────────

    [Fact]
    public void XorShift32_DeterministicForSameSeed() {
        var a = new QuickWorldHelpers.XorShift32(0xDEADBEEF);
        var b = new QuickWorldHelpers.XorShift32(0xDEADBEEF);
        for (int i = 0; i < 100; i++) {
            Assert.Equal(a.NextUInt(), b.NextUInt());
        }
    }

    [Fact]
    public void XorShift32_NextRespectsRange() {
        var rng = new QuickWorldHelpers.XorShift32(1);
        for (int i = 0; i < 1000; i++) {
            int v = rng.Next(7, 13);
            Assert.InRange(v, 7, 12);
        }
        for (int i = 0; i < 1000; i++) {
            int v = rng.Next(5);
            Assert.InRange(v, 0, 4);
        }
        for (int i = 0; i < 1000; i++) {
            double d = rng.NextDouble();
            Assert.InRange(d, 0.0, 0.99999999);
        }
    }

    [Fact]
    public void XorShift32_ZeroSeedDoesNotDegenerate() {
        // xorshift32 on state 0 produces all zeros forever; constructor bumps it to 1.
        var rng = new QuickWorldHelpers.XorShift32(0);
        bool sawNonZero = false;
        for (int i = 0; i < 10; i++) if (rng.NextUInt() != 0) { sawNonZero = true; break; }
        Assert.True(sawNonZero);
    }

    // ── Scenery codebook block ────────────────────────────────────

    [Fact]
    public void ParseCodebook_LoadsSceneryWithNumericAndHexModelIds() {
        var json = """
        {
          "terrainBaseColors": [],
          "scenery": [
            { "typeIndex": 1,  "modelIds": [33557331, "0x02000B57"] },
            { "typeIndex": 14, "modelIds": ["0x02000B95", "0x02000B97"] }
          ]
        }
        """;

        var book = QuickWorldHelpers.ParseCodebook(json);

        Assert.Equal(2, book.SceneryByType.Count);
        Assert.Equal(new uint[] { 0x02000B53u, 0x02000B57u }, book.SceneryByType[1]);
        Assert.Equal(new uint[] { 0x02000B95u, 0x02000B97u }, book.SceneryByType[14]);
    }

    [Fact]
    public void ParseCodebook_NoSceneryBlock_LeavesSceneryByTypeEmpty() {
        var book = QuickWorldHelpers.ParseCodebook("{ \"terrainBaseColors\": [] }");
        Assert.Empty(book.SceneryByType);
    }

    [Fact]
    public void ParseCodebook_SceneryEntryWithNoValidModelIds_IsDropped() {
        var json = """
        {
          "terrainBaseColors": [],
          "scenery": [
            { "typeIndex": 1, "modelIds": ["not-a-hex"] },
            { "typeIndex": 2, "modelIds": [] }
          ]
        }
        """;
        var warnings = new List<string>();
        var book = QuickWorldHelpers.ParseCodebook(json, warnings.Add);

        Assert.Empty(book.SceneryByType);
        Assert.Contains(warnings, w => w.Contains("not-a-hex"));
    }

    [Fact]
    public void ParseCodebook_SceneryEntryOutsideByteRange_IsSkippedWithWarning() {
        var json = """
        {
          "terrainBaseColors": [],
          "scenery": [
            { "typeIndex": 999, "modelIds": ["0x02000B53"] }
          ]
        }
        """;
        var warnings = new List<string>();
        var book = QuickWorldHelpers.ParseCodebook(json, warnings.Add);

        Assert.Empty(book.SceneryByType);
        Assert.Contains(warnings, w => w.Contains("999"));
    }
}
