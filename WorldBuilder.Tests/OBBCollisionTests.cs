using System.Numerics;
using WorldBuilder.Shared.Lib.Geometry;
using Xunit;

public class OBBCollisionTests
{
    [Fact]
    public void TestPointInsideOBB()
    {
        var axes = new Vector3[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ };
        var obb = new OBB(Vector3.Zero, new Vector3(1, 1, 1), axes);
        
        Assert.True(OBBCollision.PointInOBB(new Vector3(0, 0, 0), obb));
        Assert.True(OBBCollision.PointInOBB(new Vector3(0.5f, 0.5f, 0.5f), obb));
        Assert.False(OBBCollision.PointInOBB(new Vector3(1.1f, 0, 0), obb));
    }

    [Fact]
    public void TestOBBIntersection()
    {
        var axes = new Vector3[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ };
        var a = new OBB(Vector3.Zero, new Vector3(1, 1, 1), axes);
        var b = new OBB(new Vector3(1.5f, 0, 0), new Vector3(1, 1, 1), axes);
        
        Assert.True(OBBCollision.Intersects(a, b));
        
        var c = new OBB(new Vector3(2.5f, 0, 0), new Vector3(1, 1, 1), axes);
        Assert.False(OBBCollision.Intersects(a, c));
    }
}
