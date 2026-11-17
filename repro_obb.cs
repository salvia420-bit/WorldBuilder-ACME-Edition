using System;
using System.Numerics;
using WorldBuilder.Shared.Lib.Geometry;

public class TestOBB {
    public static void Main() {
        try {
            // Test OBB orthonormalization vulnerability
            Vector3 center = Vector3.Zero;
            Vector3 extents = Vector3.One;
            Vector3[] axes = new Vector3[] { new Vector3(1, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0) };
            
            var obb = new OBB(center, extents, axes);
            Console.WriteLine("OBB created successfully (VULNERABILITY CONFIRMED)");
        } catch (Exception e) {
            Console.WriteLine("OBB creation failed: " + e.Message);
        }
    }
}
