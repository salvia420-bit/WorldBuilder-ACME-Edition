using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace WorldBuilder.Shared.Lib.Noise;

/// <summary>
/// Coastline masking system using ray-casting algorithm for point-in-polygon tests.
/// Vertices outside the polygon → height = 0 (ocean/water).
/// Vertices near the edge → smooth falloff gradient to create natural coastlines.
/// </summary>
public sealed class CoastlineMask {
    private readonly (float X, float Y)[] _polygon;
    private readonly float _falloffWidth;

    // Pre-computed bounding box for early rejection
    private readonly float _minX, _minY, _maxX, _maxY;

    /// <summary>
    /// Creates a coastline mask from a polygon of world-space vertices.
    /// </summary>
    /// <param name="vertices">Polygon vertices in world coordinates (closed automatically)</param>
    /// <param name="falloffWidth">
    /// Width of the smooth falloff zone at the polygon edge, in world units.
    /// Default: 960 (5 landblocks × 192 units/landblock).
    /// </param>
    public CoastlineMask(IReadOnlyList<(float X, float Y)> vertices, float falloffWidth = 960f) {
        if (vertices.Count < 3)
            throw new ArgumentException("Coastline polygon requires at least 3 vertices.", nameof(vertices));

        _polygon = new (float, float)[vertices.Count];
        _falloffWidth = falloffWidth;

        float bMinX = float.MaxValue, bMinY = float.MaxValue;
        float bMaxX = float.MinValue, bMaxY = float.MinValue;

        for (int i = 0; i < vertices.Count; i++) {
            _polygon[i] = vertices[i];
            if (vertices[i].X < bMinX) bMinX = vertices[i].X;
            if (vertices[i].Y < bMinY) bMinY = vertices[i].Y;
            if (vertices[i].X > bMaxX) bMaxX = vertices[i].X;
            if (vertices[i].Y > bMaxY) bMaxY = vertices[i].Y;
        }

        // Expand bounding box by falloff width
        _minX = bMinX - _falloffWidth;
        _minY = bMinY - _falloffWidth;
        _maxX = bMaxX + _falloffWidth;
        _maxY = bMaxY + _falloffWidth;
    }

    /// <summary>
    /// Returns a mask value for the given world position:
    ///   1.0 = fully inside (beyond falloff zone)
    ///   0.0 = fully outside (ocean)
    ///   0.0–1.0 = within falloff zone (coastline blend)
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public float GetMask(float x, float y) {
        // Quick bounding-box reject
        if (x < _minX || x > _maxX || y < _minY || y > _maxY)
            return 0f;

        bool inside = PointInPolygon(x, y);
        if (inside) {
            // Inside: compute distance to nearest edge
            float dist = DistanceToPolygonEdge(x, y);
            if (dist >= _falloffWidth) return 1f;
            // Smooth falloff (Hermite/smoothstep for natural feel)
            float t = dist / _falloffWidth;
            return SmoothStep(t);
        } else {
            // Outside: always 0 (ocean)
            return 0f;
        }
    }

    /// <summary>
    /// Ray-casting algorithm for point-in-polygon test.
    /// Casts a ray from (x, y) in positive X direction, counts edge crossings.
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private bool PointInPolygon(float x, float y) {
        bool inside = false;
        int n = _polygon.Length;

        for (int i = 0, j = n - 1; i < n; j = i++) {
            float yi = _polygon[i].Y, yj = _polygon[j].Y;
            float xi = _polygon[i].X, xj = _polygon[j].X;

            if ((yi > y) != (yj > y)) {
                float xIntersect = xi + (y - yi) / (yj - yi) * (xj - xi);
                if (x < xIntersect)
                    inside = !inside;
            }
        }

        return inside;
    }

    /// <summary>
    /// Computes minimum distance from point to polygon edge (for falloff calculation).
    /// Uses point-to-line-segment distance for each edge.
    /// </summary>
    private float DistanceToPolygonEdge(float px, float py) {
        float minDist = float.MaxValue;
        int n = _polygon.Length;

        for (int i = 0, j = n - 1; i < n; j = i++) {
            float dist = PointToSegmentDistance(px, py,
                _polygon[j].X, _polygon[j].Y,
                _polygon[i].X, _polygon[i].Y);
            if (dist < minDist) minDist = dist;
        }

        return minDist;
    }

    /// <summary>
    /// Computes distance from point (px, py) to line segment (ax, ay) → (bx, by).
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static float PointToSegmentDistance(float px, float py,
        float ax, float ay, float bx, float by) {
        float dx = bx - ax, dy = by - ay;
        float lenSq = dx * dx + dy * dy;

        if (lenSq < 1e-12f) // degenerate segment
            return MathF.Sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));

        // Project point onto segment, clamping t to [0, 1]
        float t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        if (t < 0f) t = 0f;
        else if (t > 1f) t = 1f;

        float closestX = ax + t * dx;
        float closestY = ay + t * dy;

        float ddx = px - closestX, ddy = py - closestY;
        return MathF.Sqrt(ddx * ddx + ddy * ddy);
    }

    /// <summary>
    /// Hermite smoothstep for natural-looking falloff: 3t² - 2t³
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static float SmoothStep(float t) {
        t = Math.Clamp(t, 0f, 1f);
        return t * t * (3f - 2f * t);
    }
}
