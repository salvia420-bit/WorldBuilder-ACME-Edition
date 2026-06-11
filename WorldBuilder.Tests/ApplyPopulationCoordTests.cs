using System.Numerics;
using WorldBuilder.Terminal;
using Xunit;

namespace WorldBuilder.Tests;

/// <summary>
/// Regression guard for F12: ApplyPopulation must store WORLD-frame coordinates in
/// <c>StaticObject.Origin</c>, not the raw LB-local values from the population plan.
///
/// The document model and DAT exporter treat <c>Origin</c> as world-space (DAT load
/// does <c>Offset(obj.Frame.Origin, lbId)</c>; export reverses with <c>ReverseOffset</c>).
/// Before the fix, objects placed into any landblock other than 0x0000 were staged with
/// LB-local coordinates, clustering them near the map origin in the doc model and driving
/// them out-of-range on export.
///
/// This test exercises the exact local->world transform the apply path uses
/// (<see cref="CommandEngine.PopulationWorldOffset"/> + the per-object local add) without
/// requiring a fully loaded project (DATs + database), so it stays hermetic.
/// </summary>
public class ApplyPopulationCoordTests {
    private const float LandblockEdge = 192f;

    /// <summary>
    /// Mirrors the staging math in <c>CommandEngine.ApplyPopulation</c>:
    /// <c>Origin = new Vector3(worldOffsetX + localX, worldOffsetY + localY, localZ)</c>.
    /// </summary>
    private static Vector3 StageOrigin(int lbX, int lbY, float localX, float localY, float localZ) {
        var (worldOffsetX, worldOffsetY) = CommandEngine.PopulationWorldOffset(lbX, lbY);
        return new Vector3(worldOffsetX + localX, worldOffsetY + localY, localZ);
    }

    [Fact]
    public void OneObjectPlan_StagesWorldFrameOrigin_InsideTargetLandblock() {
        // 1-object plan placed at lbX=169 / lbY=180 with a mid-cell local position.
        const int lbX = 169, lbY = 180;
        const float localX = 96f, localY = 96f, localZ = 0f;

        var origin = StageOrigin(lbX, lbY, localX, localY, localZ);

        float minX = lbX * LandblockEdge;           // 169 * 192 = 32448
        float minY = lbY * LandblockEdge;           // 180 * 192 = 34560

        // The staged Origin.X must be the WORLD coordinate, inside this landblock's
        // 192m square [minX, minX+192) — NOT the raw local 96f (which would land in
        // landblock 0x0000) and NOT a mixed/out-of-range value.
        Assert.True(origin.X >= minX && origin.X < minX + LandblockEdge,
            $"Origin.X {origin.X} must be in [{minX}, {minX + LandblockEdge}).");
        Assert.Equal((double)(minX + localX), origin.X, 3);

        Assert.True(origin.Y >= minY && origin.Y < minY + LandblockEdge,
            $"Origin.Y {origin.Y} must be in [{minY}, {minY + LandblockEdge}).");
        Assert.Equal((double)(minY + localY), origin.Y, 3);
    }

    [Fact]
    public void Landblock0000_LocalEqualsWorld() {
        // The one landblock where the old (buggy) behaviour was accidentally correct:
        // world offset is zero, so local == world.
        var origin = StageOrigin(0, 0, 50f, 60f, 1f);
        Assert.Equal(50d, origin.X, 3);
        Assert.Equal(60d, origin.Y, 3);
    }
}
