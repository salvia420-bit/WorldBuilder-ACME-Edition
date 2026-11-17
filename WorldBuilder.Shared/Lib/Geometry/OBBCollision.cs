using System;
using System.Numerics;

namespace WorldBuilder.Shared.Lib.Geometry;

public struct OBB {
    public Vector3 Center;
    public Vector3 Extents; // Half-width, half-height, half-depth
    public Vector3[] Axes; // 3 orthonormal axes

    public OBB(Vector3 center, Vector3 extents, Vector3[] axes) {
        Center = center;
        Extents = extents;
        
        // Validate input
        if (axes.Length != 3) throw new ArgumentException("Must have 3 axes");
        if (axes[0].LengthSquared() < 0.1f || axes[1].LengthSquared() < 0.1f || axes[2].LengthSquared() < 0.1f) {
            throw new ArgumentException("Degenerate axes");
        }

        // Orthonormalize
        Vector3 a0 = Vector3.Normalize(axes[0]);
        Vector3 a1 = Vector3.Normalize(axes[1] - Vector3.Dot(axes[1], a0) * a0);
        Vector3 a2 = Vector3.Cross(a0, a1);
        
        // Validate orthonormal and lengths
        if (Math.Abs(a0.Length() - 1.0f) > 1e-3f || Math.Abs(a1.Length() - 1.0f) > 1e-3f || Math.Abs(a2.Length() - 1.0f) > 1e-3f ||
            Math.Abs(Vector3.Dot(a0, a1)) > 1e-4f || Math.Abs(Vector3.Dot(a0, a2)) > 1e-4f || Math.Abs(Vector3.Dot(a1, a2)) > 1e-4f) {
            throw new ArgumentException("Axes must be orthonormal");
        }
        
        Axes = new Vector3[] { a0, a1, a2 };
    }
}

public static class OBBCollision {
    /// <summary>
    /// Checks if a point is inside the OBB.
    /// </summary>
    public static bool PointInOBB(Vector3 point, OBB obb) {
        Vector3 t = point - obb.Center;
        
        // Project point onto OBB axes
        for (int i = 0; i < 3; i++) {
            float projection = Math.Abs(Vector3.Dot(t, obb.Axes[i]));
            if (projection > obb.Extents[i]) return false;
        }
        
        return true;
    }

    /// <summary>
    /// Performs Separating Axis Theorem (SAT) test for OBB collision.
    /// </summary>
    public static bool Intersects(OBB a, OBB b) {
        Vector3 t = b.Center - a.Center;

        // Test 15 axes: 3 from a, 3 from b, 9 from cross products
        
        // A's axes
        if (Math.Abs(Vector3.Dot(t, a.Axes[0])) > GetProjectionRadius(a, b, a.Axes[0])) return false;
        if (Math.Abs(Vector3.Dot(t, a.Axes[1])) > GetProjectionRadius(a, b, a.Axes[1])) return false;
        if (Math.Abs(Vector3.Dot(t, a.Axes[2])) > GetProjectionRadius(a, b, a.Axes[2])) return false;

        // B's axes
        if (Math.Abs(Vector3.Dot(t, b.Axes[0])) > GetProjectionRadius(a, b, b.Axes[0])) return false;
        if (Math.Abs(Vector3.Dot(t, b.Axes[1])) > GetProjectionRadius(a, b, b.Axes[1])) return false;
        if (Math.Abs(Vector3.Dot(t, b.Axes[2])) > GetProjectionRadius(a, b, b.Axes[2])) return false;

        // Cross product axes
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j < 3; j++) {
                Vector3 axis = Vector3.Cross(a.Axes[i], b.Axes[j]);
                if (axis.LengthSquared() < 1e-6f) continue;
                axis = Vector3.Normalize(axis);
                if (Math.Abs(Vector3.Dot(t, axis)) > GetProjectionRadius(a, b, axis)) return false;
            }
        }

        return true;
    }

    private static float GetProjectionRadius(OBB a, OBB b, Vector3 axis) {
        return Math.Abs(Vector3.Dot(a.Axes[0] * a.Extents.X, axis)) +
               Math.Abs(Vector3.Dot(a.Axes[1] * a.Extents.Y, axis)) +
               Math.Abs(Vector3.Dot(a.Axes[2] * a.Extents.Z, axis)) +
               Math.Abs(Vector3.Dot(b.Axes[0] * b.Extents.X, axis)) +
               Math.Abs(Vector3.Dot(b.Axes[1] * b.Extents.Y, axis)) +
               Math.Abs(Vector3.Dot(b.Axes[2] * b.Extents.Z, axis));
    }
}
