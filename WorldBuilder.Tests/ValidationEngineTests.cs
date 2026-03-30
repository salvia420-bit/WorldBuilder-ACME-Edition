using Microsoft.Extensions.Logging.Abstractions;
using System.Collections.Concurrent;
using System.Reflection;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.Validation;

namespace WorldBuilder.Tests;

public class ValidationEngineTests {
    [Fact]
    public void ValidateTerrain_DefaultThreshold_FlagsSmallHeightDelta() {
        var terrainDoc = CreateTerrainDocument(CreateTerrainEntries((x, y) => x == 1 && y == 0 ? (byte)20 : (byte)0));

        var report = ValidationEngine.ValidateTerrain(terrainDoc, 0x0101, CreateHeightTable());

        Assert.Contains(report.Diagnostics, d => d.Code == "TRN002");
    }

    [Fact]
    public void ValidateTerrain_ExplicitThreshold_AllowsSameDeltaWhenRequested() {
        var terrainDoc = CreateTerrainDocument(CreateTerrainEntries((x, y) => x == 1 && y == 0 ? (byte)20 : (byte)0));

        var report = ValidationEngine.ValidateTerrain(terrainDoc, 0x0101, CreateHeightTable(), cliffThreshold: 25f);

        Assert.DoesNotContain(report.Diagnostics, d => d.Code == "TRN002");
    }

    private static TerrainDocument CreateTerrainDocument(TerrainEntry[] entries) {
        var doc = new TerrainDocument(NullLogger.Instance) {
            TerrainData = new TerrainData {
                Landblocks = new Dictionary<ushort, uint[]> {
                    [0x0101] = entries.Select(e => e.ToUInt()).ToArray()
                }
            }
        };

        typeof(TerrainDocument)
            .GetField("_baseTerrainCache", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(doc, new ConcurrentDictionary<ushort, uint[]>());

        return doc;
    }

    private static TerrainEntry[] CreateTerrainEntries(Func<int, int, byte> heightAt) {
        var entries = new TerrainEntry[81];
        for (int x = 0; x < 9; x++) {
            for (int y = 0; y < 9; y++) {
                entries[x * 9 + y] = new TerrainEntry(road: 0, scenery: 0, type: (byte)((x + y) % 2), height: heightAt(x, y));
            }
        }

        return entries;
    }

    private static float[] CreateHeightTable() {
        var heights = new float[256];
        for (int i = 0; i < heights.Length; i++) {
            heights[i] = i;
        }

        return heights;
    }
}
