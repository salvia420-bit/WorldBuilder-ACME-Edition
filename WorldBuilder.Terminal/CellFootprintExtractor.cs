using System.Numerics;
using DatReaderWriter.DBObjs;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.Geometry;

namespace WorldBuilder.Terminal;

/// <summary>
/// Extracts a 2D wall polygon and portal-wall spans for a single dungeon
/// EnvCell, plus the cell's Z-range. Walks Environment → CellStruct →
/// VertexArray, transforms vertices through the cell's frame, and reuses
/// <see cref="FootprintExtractor.FromVertices"/> for the convex hull.
///
/// Output coordinates are landblock-local XY (same frame as
/// <see cref="DungeonCellData.Origin"/>) so callers can compose with the
/// LB origin themselves.
/// </summary>
internal static class CellFootprintExtractor {

    public sealed record PortalSpan(ushort ToCellId, Vector2 A, Vector2 B);

    public sealed record CellFootprint(
        uint CellId,
        ushort EnvCellId,
        ushort CellStructure,
        Vector2[] Polygon,
        float ZMin,
        float ZMax,
        IReadOnlyList<PortalSpan> Portals,
        bool Synthetic);

    // Synthetic AABB extent for cells whose Environment can't be resolved.
    // Why: AC interior cells fit comfortably within ~24u (one outdoor cell);
    // 12u half-extent gives a defensible square around the known origin.
    private const float SyntheticHalfExtent = 12f;

    public static CellFootprint Extract(DungeonCellData cell, ushort lbKey, IDatReaderWriter dats) {
        uint fullCellId = ((uint)lbKey << 16) | cell.CellNumber;
        ushort envCellId = cell.EnvironmentId;

        uint envFileId = (uint)envCellId | 0x0D000000;
        if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env) ||
            !env.Cells.TryGetValue(cell.CellStructure, out var cs) ||
            cs.VertexArray?.Vertices == null || cs.VertexArray.Vertices.Count == 0) {
            return SyntheticFallback(fullCellId, envCellId, cell);
        }

        // Transform every vertex through the cell's frame to landblock-local space.
        var local = new List<Vector3>(cs.VertexArray.Vertices.Count);
        float zMin = float.MaxValue, zMax = float.MinValue;
        foreach (var v in cs.VertexArray.Vertices.Values) {
            var w = Vector3.Transform(v.Origin, cell.Orientation) + cell.Origin;
            local.Add(w);
            if (w.Z < zMin) zMin = w.Z;
            if (w.Z > zMax) zMax = w.Z;
        }

        // Why: FootprintExtractor.FromVertices auto-selects a "bottom storey"
        // band, which is wrong for a single cell — we want the full XY extent.
        // Flatten Z to 0 so every vertex lands in the bottom band.
        var flattened = new List<Vector3>(local.Count);
        foreach (var v in local) flattened.Add(new Vector3(v.X, v.Y, 0f));
        var fp = FootprintExtractor.FromVertices(flattened);
        var polygon = fp.Corners.Length >= 3
            ? fp.Corners
            : SyntheticPolygonAroundOrigin(cell.Origin);

        var portals = new List<PortalSpan>(cell.CellPortals.Count);
        foreach (var portal in cell.CellPortals) {
            if (!cs.Polygons.TryGetValue(portal.PolygonId, out var poly) || poly.VertexIds.Count < 2)
                continue;

            // Project each portal-polygon vertex into landblock-local XY.
            var pts = new List<Vector2>(poly.VertexIds.Count);
            foreach (var rawId in poly.VertexIds) {
                if (rawId < 0) continue;
                if (!cs.VertexArray.Vertices.TryGetValue((ushort)rawId, out var pv)) continue;
                var w = Vector3.Transform(pv.Origin, cell.Orientation) + cell.Origin;
                pts.Add(new Vector2(w.X, w.Y));
            }
            if (pts.Count < 2) continue;

            // Wall-span = the longest chord of the projected polygon. For an
            // axis-aligned wall this collapses to the wall's two corners,
            // which is what the floor renderer wants to show as the gap.
            var (a, b) = LongestChord(pts);
            portals.Add(new PortalSpan(portal.OtherCellId, a, b));
        }

        return new CellFootprint(fullCellId, envCellId, cell.CellStructure,
            polygon, zMin, zMax, portals, Synthetic: false);
    }

    private static CellFootprint SyntheticFallback(uint fullCellId, ushort envCellId, DungeonCellData cell) {
        var poly = SyntheticPolygonAroundOrigin(cell.Origin);
        float z = cell.Origin.Z;
        return new CellFootprint(fullCellId, envCellId, cell.CellStructure,
            poly, z - 4f, z + 12f, Array.Empty<PortalSpan>(), Synthetic: true);
    }

    private static Vector2[] SyntheticPolygonAroundOrigin(Vector3 origin) {
        float x = origin.X, y = origin.Y, h = SyntheticHalfExtent;
        return new[] {
            new Vector2(x - h, y - h),
            new Vector2(x + h, y - h),
            new Vector2(x + h, y + h),
            new Vector2(x - h, y + h),
        };
    }

    private static (Vector2 A, Vector2 B) LongestChord(List<Vector2> pts) {
        Vector2 a = pts[0], b = pts[1];
        float bestSq = -1f;
        for (int i = 0; i < pts.Count; i++) {
            for (int j = i + 1; j < pts.Count; j++) {
                float dsq = (pts[i] - pts[j]).LengthSquared();
                if (dsq > bestSq) { bestSq = dsq; a = pts[i]; b = pts[j]; }
            }
        }
        return (a, b);
    }
}
