using System.Numerics;
using DatReaderWriter.DBObjs;

namespace WorldBuilder.Shared.Lib.Geometry;

/// <summary>
/// Result of footprint extraction: the 2D corner ring (in model-local XY,
/// CCW-ordered), the lowest Z among bottom-storey vertices, and the
/// classified footprint shape.
/// </summary>
public readonly record struct FootprintExtraction(
    Vector2[] Corners,
    float FoundationZ,
    FootprintShape Shape);

/// <summary>
/// Extracts a building's bottom-storey footprint from raw model geometry
/// and classifies its shape. Used by the ontology builder to populate
/// <see cref="OntologyEntry.FootprintShape"/> / <see cref="OntologyEntry.FootprintCorners"/>,
/// and by the validator to sample terrain at the actual perimeter rather
/// than at a single centre point or a circular radius.
/// </summary>
public static class FootprintExtractor {
    // Vertices within this many world units of the lowest vertex are treated
    // as the "bottom storey" and projected to XY. Tuned to capture stair
    // bases, foundation rims, and porches without picking up the second
    // storey of small houses.
    private const float BottomBandAbsolute = 0.5f;
    private const float BottomBandRelative = 0.05f;

    // Hull-classification thresholds.
    private const float CollinearAngleDeg = 8f;     // collapse near-collinear pts
    private const float DegenerateEdgeLength = 0.05f;
    private const float RectangleAngleTolDeg = 12f;
    private const float RegularPolygonAngleTolDeg = 12f;
    private const float SideLengthRegularityTol = 0.30f; // max stddev / mean

    /// <summary>
    /// Extracts the footprint from a Setup by walking its parts (with
    /// placement-frame offsets) and gathering bottom-storey XY positions.
    /// Returns an Unknown-shape, empty-ring extraction if the Setup has no
    /// resolvable geometry.
    /// </summary>
    public static FootprintExtraction FromSetup(Setup setup, IDatReaderWriter dats) {
        if (setup?.Parts == null || setup.Parts.Count == 0) {
            return new FootprintExtraction(Array.Empty<Vector2>(), 0f, FootprintShape.Unknown);
        }

        var verts = new List<Vector3>(capacity: 256);
        for (int i = 0; i < setup.Parts.Count; i++) {
            uint partId = setup.Parts[i];
            if (!dats.TryGet<GfxObj>(partId, out var gfx) || gfx.VertexArray?.Vertices == null)
                continue;

            Vector3 partOffset = Vector3.Zero;
            if (setup.PlacementFrames != null && setup.PlacementFrames.Count > 0) {
                var placement = setup.PlacementFrames.Values.FirstOrDefault();
                if (placement?.Frames != null && i < placement.Frames.Count) {
                    partOffset = placement.Frames[i].Origin;
                }
            }

            foreach (var v in gfx.VertexArray.Vertices.Values) {
                verts.Add(v.Origin + partOffset);
            }
        }

        return FromVertices(verts);
    }

    /// <summary>
    /// Extracts the footprint from a single GfxObj — used for standalone
    /// 0x01 ids that aren't part of a Setup.
    /// </summary>
    public static FootprintExtraction FromGfxObj(GfxObj gfx) {
        if (gfx?.VertexArray?.Vertices == null) {
            return new FootprintExtraction(Array.Empty<Vector2>(), 0f, FootprintShape.Unknown);
        }
        var verts = gfx.VertexArray.Vertices.Values.Select(v => v.Origin).ToList();
        return FromVertices(verts);
    }

    /// <summary>
    /// Pure-geometry entry point: classify the footprint of an arbitrary
    /// vertex cloud. Exposed so tests and the validator can drive it
    /// without DAT access.
    /// </summary>
    public static FootprintExtraction FromVertices(IReadOnlyList<Vector3> vertices) {
        if (vertices == null || vertices.Count == 0) {
            return new FootprintExtraction(Array.Empty<Vector2>(), 0f, FootprintShape.Unknown);
        }

        // ── 1. Find Z_min and the bottom-storey band ──
        float zMin = float.MaxValue;
        float zMax = float.MinValue;
        foreach (var v in vertices) {
            if (v.Z < zMin) zMin = v.Z;
            if (v.Z > zMax) zMax = v.Z;
        }
        float band = MathF.Max(BottomBandAbsolute, (zMax - zMin) * BottomBandRelative);
        float zCutoff = zMin + band;

        var bottom = new List<Vector2>(capacity: vertices.Count / 4);
        foreach (var v in vertices) {
            if (v.Z <= zCutoff) bottom.Add(new Vector2(v.X, v.Y));
        }
        if (bottom.Count < 3) {
            // Not enough bottom-storey vertices to define a 2D hull.
            return new FootprintExtraction(Array.Empty<Vector2>(), zMin, FootprintShape.Unknown);
        }

        // ── 2. Convex hull (Andrew's monotone chain) ──
        var hull = ConvexHull(bottom);
        if (hull.Length < 3) {
            return new FootprintExtraction(Array.Empty<Vector2>(), zMin, FootprintShape.Unknown);
        }

        // ── 3. Simplify: drop near-collinear and degenerate corners ──
        var simplified = SimplifyHull(hull);
        if (simplified.Length < 3) {
            return new FootprintExtraction(hull, zMin, FootprintShape.Polygon);
        }

        // ── 4. Classify shape ──
        var shape = ClassifyShape(simplified);
        return new FootprintExtraction(simplified, zMin, shape);
    }

    // ───────────────────────────── Convex hull ─────────────────────────────
    private static Vector2[] ConvexHull(List<Vector2> points) {
        // Sort by X then Y. Andrew's monotone chain.
        var pts = points.Distinct().OrderBy(p => p.X).ThenBy(p => p.Y).ToArray();
        if (pts.Length < 3) return pts;

        var lower = new List<Vector2>();
        foreach (var p in pts) {
            while (lower.Count >= 2 && Cross(lower[^2], lower[^1], p) <= 0) lower.RemoveAt(lower.Count - 1);
            lower.Add(p);
        }
        var upper = new List<Vector2>();
        for (int i = pts.Length - 1; i >= 0; i--) {
            var p = pts[i];
            while (upper.Count >= 2 && Cross(upper[^2], upper[^1], p) <= 0) upper.RemoveAt(upper.Count - 1);
            upper.Add(p);
        }
        lower.RemoveAt(lower.Count - 1);
        upper.RemoveAt(upper.Count - 1);
        lower.AddRange(upper);
        return lower.ToArray();
    }

    private static float Cross(Vector2 o, Vector2 a, Vector2 b) =>
        (a.X - o.X) * (b.Y - o.Y) - (a.Y - o.Y) * (b.X - o.X);

    // ───────────────────────────── Simplification ─────────────────────────────
    private static Vector2[] SimplifyHull(Vector2[] hull) {
        if (hull.Length <= 3) return hull;
        var kept = new List<Vector2>(hull.Length);
        for (int i = 0; i < hull.Length; i++) {
            var prev = hull[(i - 1 + hull.Length) % hull.Length];
            var curr = hull[i];
            var next = hull[(i + 1) % hull.Length];

            var e1 = curr - prev;
            var e2 = next - curr;
            float l1 = e1.Length();
            float l2 = e2.Length();
            if (l1 < DegenerateEdgeLength || l2 < DegenerateEdgeLength) continue;

            float cosA = Vector2.Dot(e1, e2) / (l1 * l2);
            cosA = Math.Clamp(cosA, -1f, 1f);
            float turnDeg = MathF.Acos(cosA) * 180f / MathF.PI;
            // turn ≈ 0 means collinear; keep only meaningful corners
            if (turnDeg < CollinearAngleDeg) continue;
            kept.Add(curr);
        }
        return kept.Count >= 3 ? kept.ToArray() : hull;
    }

    // ───────────────────────────── Shape classifier ─────────────────────────────
    private static FootprintShape ClassifyShape(Vector2[] hull) {
        int n = hull.Length;
        if (n < 3) return FootprintShape.Unknown;

        // Compute interior angles (in degrees) and side lengths.
        var angles = new float[n];
        var sides = new float[n];
        for (int i = 0; i < n; i++) {
            var prev = hull[(i - 1 + n) % n];
            var curr = hull[i];
            var next = hull[(i + 1) % n];
            var e1 = prev - curr;
            var e2 = next - curr;
            float cosA = Vector2.Dot(e1, e2) / (e1.Length() * e2.Length());
            cosA = Math.Clamp(cosA, -1f, 1f);
            angles[i] = MathF.Acos(cosA) * 180f / MathF.PI;
            sides[i] = (next - curr).Length();
        }

        // Rectangle: 4 corners, all interior angles within tol of 90°.
        if (n == 4 && angles.All(a => MathF.Abs(a - 90f) <= RectangleAngleTolDeg))
            return FootprintShape.Rectangle;

        // Regular hexagon/octagon: each interior angle near (n-2)*180/n,
        // and side-length regularity within tolerance.
        float expected = (n - 2) * 180f / n;
        bool anglesRegular = angles.All(a => MathF.Abs(a - expected) <= RegularPolygonAngleTolDeg);
        bool sidesRegular = SideLengthsRegular(sides);

        if (n == 6 && anglesRegular && sidesRegular) return FootprintShape.Hexagon;
        if (n == 8 && anglesRegular && sidesRegular) return FootprintShape.Octagon;

        // Round: many sides, low side-length variance, AABB aspect close to 1.
        if (n >= 12 && sidesRegular && AabbAspectNearOne(hull, tol: 0.20f))
            return FootprintShape.Round;

        return FootprintShape.Polygon;
    }

    private static bool SideLengthsRegular(float[] sides) {
        if (sides.Length == 0) return false;
        float mean = sides.Average();
        if (mean <= 0f) return false;
        float variance = sides.Sum(s => (s - mean) * (s - mean)) / sides.Length;
        float stddev = MathF.Sqrt(variance);
        return stddev / mean <= SideLengthRegularityTol;
    }

    private static bool AabbAspectNearOne(Vector2[] hull, float tol) {
        float minX = hull.Min(p => p.X), maxX = hull.Max(p => p.X);
        float minY = hull.Min(p => p.Y), maxY = hull.Max(p => p.Y);
        float w = maxX - minX, h = maxY - minY;
        if (w <= 0f || h <= 0f) return false;
        float aspect = w > h ? w / h : h / w;
        return aspect <= 1f + tol;
    }
}
