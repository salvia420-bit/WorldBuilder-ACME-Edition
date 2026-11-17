using System.Numerics;
using System.Collections.Generic;
using WorldBuilder.Shared.Lib.Geometry;
using WorldBuilder.Shared.Lib.Container;
using Xunit;

public class PalletJackLogisticsTests
{
    [Fact]
    public void TestCanDeployPallet_Success()
    {
        var deployable = new IsoContainerDeployable();
        var bay = new IsoContainerDeployable.ContainerBay {
            Bounds = new OBB(Vector3.Zero, new Vector3(1, 1, 1), new Vector3[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ }),
            SillHeight = -2.0f,
            HeaderHeight = 2.0f
        };
        deployable.Bays.Add(bay);

        var pallet = new OBB(Vector3.Zero, new Vector3(0.5f, 0.5f, 0.5f), new Vector3[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ });
        
        Assert.True(deployable.CanDeployPallet(pallet, out var reason, out var _));
        Assert.Equal(string.Empty, reason);
    }

    [Fact]
    public void TestCanDeployPallet_SillObstruction()
    {
        var deployable = new IsoContainerDeployable();
        var bay = new IsoContainerDeployable.ContainerBay {
            Bounds = new OBB(Vector3.Zero, new Vector3(1, 1, 1), new Vector3[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ }),
            SillHeight = 0.5f,
            HeaderHeight = 2.0f
        };
        deployable.Bays.Add(bay);

        // Pallet spans from -0.5 to 0.5, sill is at 0.5. It *should* be obstructed?
        // Wait, palletBounds.Center.Y - palletBounds.Extents.Y < bay.SillHeight.
        // 0 - 0.5 < 0.5? Yes, -0.5 < 0.5. So obstructed.
        var pallet = new OBB(Vector3.Zero, new Vector3(0.5f, 0.5f, 0.5f), new Vector3[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ });
        
        Assert.False(deployable.CanDeployPallet(pallet, out var reason, out var _));
        Assert.Contains("Obstructed by sill", reason);
    }
}
