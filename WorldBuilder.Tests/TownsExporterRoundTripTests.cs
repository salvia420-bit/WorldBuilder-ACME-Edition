using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text.Json;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.WorldGen;

namespace WorldBuilder.Tests;

/// <summary>
/// Regression guard for F72: System.Numerics.Vector3/Quaternion expose X/Y/Z/W as public
/// FIELDS, so System.Text.Json without IncludeFields=true serializes them as {} and round-trips
/// every position to (0,0,0). The `worldgen --output` producer and the `export-towns-csv`
/// consumer must share JsonOpts.WorldGenResult so anchors survive the JSON round-trip.
/// </summary>
public class TownsExporterRoundTripTests {
    private static WorldGeneratorResult MakeResult() {
        var result = new WorldGeneratorResult();
        result.Towns.Add(new TownSite {
            Name = "Holtburg",
            CenterLbX = 0xA9, CenterLbY = 0xB4,
            WorldCenter = new Vector3(32500f, 34600f, 84.5f),
            Radius = 250f,
            Size = 2,
            BuildingCount = 3,
        });
        result.Towns.Add(new TownSite {
            Name = "Eastw\"ind", // embed a quote to exercise CSV escaping
            CenterLbX = 0x10, CenterLbY = 0x20,
            WorldCenter = new Vector3(3100f, 6200f, 12.25f),
            Radius = 80f,
            Size = 0,
            BuildingCount = 0,
        });

        result.BuildingPlacements[(ushort)0xA9B4] = new List<PlannedBuilding> {
            new() { ModelId = 0x020000A7, WorldPosition = new Vector3(32490f, 34590f, 84f), Orientation = Quaternion.Identity, TownName = "Holtburg" },
            new() { ModelId = 0x020000A8, WorldPosition = new Vector3(32510f, 34610f, 85f), Orientation = Quaternion.Identity, TownName = "Holtburg" },
        };
        return result;
    }

    /// <summary>
    /// Reproduces the exact JSON shape RunWorldGenInternal writes to outputJsonPath, using the
    /// shared WorldGenResult options.
    /// </summary>
    private static string SerializeLikeProducer(WorldGeneratorResult result) {
        return JsonSerializer.Serialize(new {
            seed = 12345,
            applied = false,
            bounds = new { StartX = 0, StartY = 0, Width = 8, Height = 8, FullWorld = false },
            towns = result.Towns,
            plannedBuildings = result.BuildingPlacements
                .ToDictionary(kvp => $"0x{kvp.Key:X4}", kvp => kvp.Value),
            decorationCounts = result.DecorationPlacements
                .ToDictionary(kvp => $"0x{kvp.Key:X4}", kvp => kvp.Value.Count),
            terrainLandblocksAffected = result.TerrainChanges.Count,
            totalVerticesModified = result.TotalVerticesModified,
            totalBuildingsPlaced = result.TotalBuildingsPlaced,
            totalDecorationsPlaced = result.TotalDecorationsPlaced,
            totalRoadVertices = result.TotalRoadVertices,
        }, JsonOpts.WorldGenResult);
    }

    /// <summary>
    /// Reproduces the deserialization path ExportTownsCsv uses to rebuild the stub result.
    /// </summary>
    private static WorldGeneratorResult DeserializeLikeConsumer(string json) {
        using var doc = JsonDocument.Parse(json);
        var towns = doc.RootElement.TryGetProperty("towns", out var townsEl)
            ? JsonSerializer.Deserialize<List<TownSite>>(townsEl.GetRawText(), JsonOpts.WorldGenResult) ?? new()
            : new List<TownSite>();

        var placements = new Dictionary<ushort, List<PlannedBuilding>>();
        if (doc.RootElement.TryGetProperty("plannedBuildings", out var pbEl)) {
            foreach (var prop in pbEl.EnumerateObject()) {
                ushort lbKey = ushort.Parse(prop.Name[2..], System.Globalization.NumberStyles.HexNumber);
                placements[lbKey] = JsonSerializer.Deserialize<List<PlannedBuilding>>(prop.Value.GetRawText(), JsonOpts.WorldGenResult) ?? new();
            }
        }

        var stub = new WorldGeneratorResult();
        stub.Towns.AddRange(towns);
        foreach (var kv in placements) stub.BuildingPlacements[kv.Key] = kv.Value;
        return stub;
    }

    [Fact]
    public void RoundTrip_PreservesTownAnchorPositions() {
        var result = MakeResult();
        var json = SerializeLikeProducer(result);
        var stub = DeserializeLikeConsumer(json);

        // Positions must survive — NOT collapse to (0,0,0).
        Assert.Equal(result.Towns.Count, stub.Towns.Count);
        for (int i = 0; i < result.Towns.Count; i++) {
            Assert.Equal(result.Towns[i].WorldCenter, stub.Towns[i].WorldCenter);
        }

        var origAnchor = TownsExporter.GetTownTelelocAnchor(result.Towns[0], result.BuildingPlacements);
        var rtAnchor = TownsExporter.GetTownTelelocAnchor(stub.Towns[0], stub.BuildingPlacements);
        Assert.Equal(origAnchor, rtAnchor);
        Assert.NotEqual(Vector3.Zero, rtAnchor);
    }

    [Fact]
    public void RoundTrip_CsvMatchesInMemoryWrite() {
        var result = MakeResult();
        var json = SerializeLikeProducer(result);
        var stub = DeserializeLikeConsumer(json);

        var inMemoryPath = Path.GetTempFileName();
        var roundTripPath = Path.GetTempFileName();
        try {
            int inMemoryRows = TownsExporter.Write(result, inMemoryPath);
            int roundTripRows = TownsExporter.Write(stub, roundTripPath);

            Assert.Equal(inMemoryRows, roundTripRows);
            Assert.Equal(File.ReadAllText(inMemoryPath), File.ReadAllText(roundTripPath));
        }
        finally {
            File.Delete(inMemoryPath);
            File.Delete(roundTripPath);
        }
    }

    [Fact]
    public void IndentedOptions_LosePositions_ProvingTheBug() {
        // Sanity-check that the OLD options (no IncludeFields) really do collapse positions,
        // so this test fails loudly if someone "simplifies" WorldGenResult back to Indented.
        var result = MakeResult();
        var brokenJson = JsonSerializer.Serialize(new { towns = result.Towns }, JsonOpts.Indented);
        using var doc = JsonDocument.Parse(brokenJson);
        var townsEl = doc.RootElement.GetProperty("towns");
        var towns = JsonSerializer.Deserialize<List<TownSite>>(townsEl.GetRawText(), JsonOpts.CaseInsensitive)!;
        Assert.All(towns, t => Assert.Equal(Vector3.Zero, t.WorldCenter));
    }
}
