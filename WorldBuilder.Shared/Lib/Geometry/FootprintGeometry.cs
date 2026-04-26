using System.Numerics;

namespace WorldBuilder.Shared.Lib.Geometry;

/// <summary>
/// Pure-geometry helpers used by the placer and validator to reason about
/// a building's footprint in world (or landblock-local) space: rotating the
/// model-local corner ring into place, testing point-in-polygon, sampling
/// terrain at the corners + perimeter midpoints.
///
/// Kept separate from <see cref="FootprintExtractor"/> (which only produces
/// the model-local ring) so callers don't need a DAT reader to use it.
/// </summary>
public static class FootprintGeometry {

    /// <summary>
    /// Project a building's model-local footprint corners into landblock-local
    /// (or world) coordinates by applying the placement orientation and
    /// translating to the placement origin's XY. Z is dropped — this is a
    /// 2D footprint.
    /// </summary>
    public static Vector2[] WorldFootprint(
        Vector2[] modelCorners, Quaternion orientation, float originX, float originY) {
        if (modelCorners == null || modelCorners.Length == 0) return Array.Empty<Vector2>();
        var pts = new Vector2[modelCorners.Length];
        for (int i = 0; i < modelCorners.Length; i++) {
            var rotated = Vector3.Transform(
                new Vector3(modelCorners[i].X, modelCorners[i].Y, 0f), orientation);
            pts[i] = new Vector2(originX + rotated.X, originY + rotated.Y);
        }
        return pts;
    }

    /// <summary>
    /// Standard ray-casting point-in-polygon. Polygon is treated as a closed
    /// ring; vertex order doesn't matter. Points exactly on an edge return
    /// implementation-defined; that's acceptable for our use cases (we only
    /// test door/object centres, not vertices).
    /// </summary>
    public static bool PointInPolygon(Vector2 p, Vector2[] polygon) {
        if (polygon == null || polygon.Length < 3) return false;
        bool inside = false;
        for (int i = 0, j = polygon.Length - 1; i < polygon.Length; j = i++) {
            var pi = polygon[i];
            var pj = polygon[j];
            bool intersects = ((pi.Y > p.Y) != (pj.Y > p.Y)) &&
                (p.X < (pj.X - pi.X) * (p.Y - pi.Y) / (pj.Y - pi.Y) + pi.X);
            if (intersects) inside = !inside;
        }
        return inside;
    }

    /// <summary>
    /// Returns the centroid of a polygon (simple average of vertices). Used
    /// by the validator to push corners outward into the basement halo.
    /// </summary>
    public static Vector2 Centroid(Vector2[] polygon) {
        if (polygon == null || polygon.Length == 0) return Vector2.Zero;
        var sum = Vector2.Zero;
        foreach (var p in polygon) sum += p;
        return sum / polygon.Length;
    }
}
