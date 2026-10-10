using WorldBuilder.Terminal;
using Xunit;

namespace WorldBuilder.Tests;

/// <summary>success for smooth/raise/lower/set-height/paint/fill/road = the edit reached terrain.</summary>
public class TerrainEditResultTests {
    [Fact]
    public void BrushOverTerrainThatNeededNoChange_IsASuccessfulNoOp() =>
        Assert.True(new TerrainEditResult(0, new HashSet<ushort>()) { VerticesInBrush = 81 }.Success);

    [Fact]
    public void BrushCoveringNoTerrain_Fails() =>
        Assert.False(new TerrainEditResult(0, new HashSet<ushort>()).Success);

    [Fact]
    public void ModifiedVertices_AlwaysSucceed() =>
        Assert.True(new TerrainEditResult(12, new HashSet<ushort> { 0x6464 }).Success);

    [Fact]
    public void RoadAlreadyThere_IsASuccessfulNoOp() =>
        Assert.True(new RoadResult(9, 0, 1, new HashSet<ushort>()) { VerticesOnTerrain = 9 }.Success);

    [Fact]
    public void RoadOffTheWorld_Fails() =>
        Assert.False(new RoadResult(9, 0, 1, new HashSet<ushort>()).Success);
}
