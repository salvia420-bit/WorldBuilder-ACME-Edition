using System.Numerics;
using WorldBuilder.Shared.Lib.Geometry;
using WorldBuilder.Shared.Lib.Container;
using Xunit;

public class PalletLogisticsBestFitTests
{
    [Fact]
    public void TestCanDeployPallet_ValidatesAllBays()
    {
        var deployable = new IsoContainerDeployable();
        
        // Bay 1: Obstructed
        var bay1 = new IsoContainerDeployable.ContainerBay {
            Bounds = new OBB(Vector3.Zero, new Vector3(1, 1, 1), new Vector3[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ }),
            SillHeight = 1.0f, // Sill higher than pallet
            HeaderHeight = 2.0f
        };
        deployable.Bays.Add(bay1);
        
        // Bay 2: Valid
        var bay2 = new IsoContainerDeployable.ContainerBay {
            Bounds = new OBB(new Vector3(5, 0, 0), new Vector3(1, 1, 1), new Vector3[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ }),
            SillHeight = -1.0f,
            HeaderHeight = 2.0f
        };
        deployable.Bays.Add(bay2);
        
        var pallet = new OBB(new Vector3(5, 0, 0), new Vector3(0.5f, 0.5f, 0.5f), new Vector3[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ });
        
        // Should find fit in Bay 2, even though Bay 1 was checked first
        Assert.True(deployable.CanDeployPallet(pallet, out var reason, out var selectedBay));
        Assert.Equal(string.Empty, reason);
        Assert.NotNull(selectedBay);
        Assert.Equal(bay2.Bounds.Center, selectedBay.Value.Bounds.Center);
    }
}
