using System;
using System.Numerics;
using WorldBuilder.Shared.Lib.Geometry;
using Xunit;

public class AdversarialTests
{
    [Fact]
    public void TestOBBOrthonormalizationVulnerability()
    {
        Vector3 center = Vector3.Zero;
        Vector3 extents = Vector3.One;
        // Parallel axes (1,0,0) and (1,0,0)
        Vector3[] axes = new Vector3[] { new Vector3(1, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0) };
        
        // This should throw an ArgumentException, but likely won't
        var obb = new OBB(center, extents, axes);
        
        // Verify axes are NOT orthonormal
        Assert.NotEqual(1.0f, Vector3.Dot(obb.Axes[0], obb.Axes[1]), 1e-4f);
    }
}
