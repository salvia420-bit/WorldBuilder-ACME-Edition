using System.Numerics;
using WorldBuilder.Shared.Lib.Geometry;
using Xunit;

public class OBBCollisionBrokenTests
{
    [Fact]
    public void TestOBBIntersectionNonOrthonormal()
    {
        // Axes are not orthonormal
        var axes = new Vector3[] { Vector3.UnitX, new Vector3(1, 1, 0), Vector3.UnitZ };
        var a = new OBB(Vector3.Zero, new Vector3(1, 1, 1), axes);
        var b = new OBB(new Vector3(1.5f, 0, 0), new Vector3(1, 1, 1), axes);
        
        // This should pass if the fix is implemented, 
        // currently it might fail or behave unexpectedly.
        Assert.True(OBBCollision.Intersects(a, b));
    }
}
