using System;
using System.Numerics;
using WorldBuilder.Shared.Lib.Geometry;
using Xunit;

public class OBBDegenerateTests
{
    [Fact]
    public void TestConstructorThrowsOnDegenerateAxes()
    {
        var axes = new Vector3[] { Vector3.Zero, Vector3.Zero, Vector3.Zero };
        Assert.Throws<ArgumentException>(() => new OBB(Vector3.Zero, Vector3.One, axes));
    }

    [Fact]
    public void TestConstructorThrowsOnNonOrthonormalAxes()
    {
        var axes = new Vector3[] { Vector3.UnitX, Vector3.UnitX, Vector3.UnitY };
        Assert.Throws<ArgumentException>(() => new OBB(Vector3.Zero, Vector3.One, axes));
    }
}
