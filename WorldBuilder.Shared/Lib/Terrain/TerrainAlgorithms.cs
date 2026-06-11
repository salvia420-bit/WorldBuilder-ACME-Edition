using System.Numerics;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Shared.Lib.Terrain;

/// <summary>
/// Pure algorithmic utilities for terrain vertex lookup, coordinate mapping,
/// and height sampling. These are the "brains" extracted from the UI-layer
/// TerrainDataManager, PaintCommand, and HeightSmoothSubToolViewModel.
///
/// All methods are static and UI-free — they operate on raw terrain data arrays,
/// height tables, and coordinate math. No rendering, no GPU, no mouse state.
/// </summary>
public static class TerrainAlgorithms {

    public const uint MapSize = 254;
    public const uint LandblockLength = 192;
    public const uint LandblockEdgeCellCount = 8;
    public const float CellSize = 24.0f;
    public const int VerticesPerLandblock = 81; // 9 × 9

    // ────────────────────────────────────────────
    //  Vertex lookup — circular brush
    // ────────────────────────────────────────────

    /// <summary>
    /// Gets all terrain vertices within a circular brush of the given radius
    /// around a world-space position. Handles landblock-edge neighbor syncing.
    /// </summary>
    /// <param name="position">World-space center position.</param>
    /// <param name="brushRadius">Brush radius in brush units (will be scaled: radius*12+1).</param>
    /// <param name="heightLookup">
    /// Optional callback to resolve the Z height at a world (X,Y). Pass null to leave Z as 0.
    /// </param>
    public static List<(ushort LandblockId, int VertexIndex, Vector3 Position)> GetAffectedVertices(
        Vector3 position, float brushRadius, Func<float, float, float>? heightLookup = null) {

        float radius = (brushRadius * 12f) + 1f;
        var affected = new List<(ushort, int, Vector3)>();
        Vector2 center2D = new(position.X, position.Y);
        float gridRadius = radius / CellSize + 0.5f;

        int centerGX = (int)Math.Round(center2D.X / CellSize);
        int centerGY = (int)Math.Round(center2D.Y / CellSize);
        int minGX = centerGX - (int)Math.Ceiling(gridRadius);
        int maxGX = centerGX + (int)Math.Ceiling(gridRadius);
        int minGY = centerGY - (int)Math.Ceiling(gridRadius);
        int maxGY = centerGY + (int)Math.Ceiling(gridRadius);

        for (int gx = minGX; gx <= maxGX; gx++) {
            for (int gy = minGY; gy <= maxGY; gy++) {
                if (gx < 0 || gy < 0) continue;

                Vector2 vert2D = new(gx * CellSize, gy * CellSize);
                if ((vert2D - center2D).Length() > radius) continue;

                int lbX = gx / 8;
                int lbY = gy / 8;
                if (lbX > 254 || lbY > 254) continue;

                int localVX = gx - lbX * 8;
                int localVY = gy - lbY * 8;
                if (localVX < 0 || localVX > 8 || localVY < 0 || localVY > 8) continue;

                int vertexIndex = localVX * 9 + localVY;
                ushort lbId = (ushort)((lbX << 8) | lbY);
                float z = heightLookup?.Invoke(vert2D.X, vert2D.Y) ?? 0f;
                Vector3 vertPos = new(vert2D.X, vert2D.Y, z);
                affected.Add((lbId, vertexIndex, vertPos));

                // Edge neighbor syncing
                AddEdgeNeighbors(affected, lbX, lbY, localVX, localVY, vertPos);
            }
        }

        return affected.Distinct().ToList();
    }

    // ────────────────────────────────────────────
    //  Vertex lookup — rectangular region
    // ────────────────────────────────────────────

    /// <summary>
    /// Gets all terrain vertices within a world-space axis-aligned rectangle.
    /// Handles landblock-edge neighbor syncing.
    /// </summary>
    public static List<(ushort LandblockId, int VertexIndex, Vector3 Position)> GetVerticesInRect(
        float minX, float minY, float maxX, float maxY, Func<float, float, float>? heightLookup = null) {

        var affected = new List<(ushort, int, Vector3)>();

        int minGX = (int)Math.Floor(minX / CellSize);
        int maxGX = (int)Math.Ceiling(maxX / CellSize);
        int minGY = (int)Math.Floor(minY / CellSize);
        int maxGY = (int)Math.Ceiling(maxY / CellSize);

        for (int gx = minGX; gx <= maxGX; gx++) {
            for (int gy = minGY; gy <= maxGY; gy++) {
                if (gx < 0 || gy < 0) continue;

                int lbX = gx / 8;
                int lbY = gy / 8;
                if (lbX > 254 || lbY > 254) continue;

                int localVX = gx - lbX * 8;
                int localVY = gy - lbY * 8;
                if (localVX < 0 || localVX > 8 || localVY < 0 || localVY > 8) continue;

                int vertexIndex = localVX * 9 + localVY;
                ushort lbId = (ushort)((lbX << 8) | lbY);
                Vector2 vert2D = new(gx * CellSize, gy * CellSize);
                float z = heightLookup?.Invoke(vert2D.X, vert2D.Y) ?? 0f;
                Vector3 vertPos = new(vert2D.X, vert2D.Y, z);
                affected.Add((lbId, vertexIndex, vertPos));

                AddEdgeNeighbors(affected, lbX, lbY, localVX, localVY, vertPos);
            }
        }

        return affected.Distinct().ToList();
    }

    // ────────────────────────────────────────────
    //  Flood fill (bucket fill)
    // ────────────────────────────────────────────

    /// <summary>
    /// Performs a read-only flood fill from a starting landblock cell, collecting all
    /// contiguous vertices with the same terrain texture type.
    /// </summary>
    /// <param name="startLbX">Landblock X of the starting cell.</param>
    /// <param name="startLbY">Landblock Y of the starting cell.</param>
    /// <param name="startCellX">Cell X within the landblock (0-8).</param>
    /// <param name="startCellY">Cell Y within the landblock (0-8).</param>
    /// <param name="newType">The new terrain type (fill stops if it matches the start type).</param>
    /// <param name="terrainLookup">Resolves a landblock key to its terrain data array, or null if unavailable.</param>
    /// <param name="allowedLandblocks">Optional constraint set to limit the fill scope.</param>
    public static List<(ushort LbID, int VertexIndex, byte OldType)> FloodFill(
        uint startLbX, uint startLbY, uint startCellX, uint startCellY,
        byte newType,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        HashSet<ushort>? allowedLandblocks = null) {

        // Landblock X/Y indices must fit a single byte (0..254). A larger value
        // would corrupt the packed key below and seed the fill into an unrelated
        // landblock, so reject it rather than silently mutating wrong terrain.
        if (startLbX > 254)
            throw new ArgumentOutOfRangeException(nameof(startLbX), startLbX, "Landblock X must be 0..254.");
        if (startLbY > 254)
            throw new ArgumentOutOfRangeException(nameof(startLbY), startLbY, "Landblock Y must be 0..254.");

        var result = new List<(ushort, int, byte)>();
        ushort startLbID = (ushort)((startLbX << 8) | startLbY);

        if (allowedLandblocks != null && !allowedLandblocks.Contains(startLbID))
            return result;

        var startData = terrainLookup(startLbID);
        if (startData == null) return result;

        int startIndex = (int)(startCellX * 9 + startCellY);
        if (startIndex >= startData.Length) return result;

        byte oldType = startData[startIndex].Type;
        if (oldType == newType) return result;

        var visited = new HashSet<(uint lbX, uint lbY, uint cellX, uint cellY)>();
        var queue = new Queue<(uint lbX, uint lbY, uint cellX, uint cellY)>();
        queue.Enqueue((startLbX, startLbY, startCellX, startCellY));

        var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();

        while (queue.Count > 0) {
            var (lbX, lbY, cellX, cellY) = queue.Dequeue();

            if (!visited.Add((lbX, lbY, cellX, cellY))) continue;

            var lbID = (ushort)((lbX << 8) | lbY);
            if (allowedLandblocks != null && !allowedLandblocks.Contains(lbID)) continue;

            if (!landblockDataCache.TryGetValue(lbID, out var data)) {
                data = terrainLookup(lbID);
                if (data == null) continue;
                landblockDataCache[lbID] = data;
            }

            int index = (int)(cellX * 9 + cellY);
            if (index >= data.Length || data[index].Type != oldType) continue;

            result.Add((lbID, index, oldType));

            // Queue neighbors
            if (cellX > 0) queue.Enqueue((lbX, lbY, cellX - 1, cellY));
            else if (lbX > 0) queue.Enqueue((lbX - 1, lbY, 8, cellY));

            if (cellX < 8) queue.Enqueue((lbX, lbY, cellX + 1, cellY));
            else if (lbX < 255) queue.Enqueue((lbX + 1, lbY, 0, cellY));

            if (cellY > 0) queue.Enqueue((lbX, lbY, cellX, cellY - 1));
            else if (lbY > 0) queue.Enqueue((lbX, lbY - 1, cellX, 8));

            if (cellY < 8) queue.Enqueue((lbX, lbY, cellX, cellY + 1));
            else if (lbY < 255) queue.Enqueue((lbX, lbY + 1, cellX, 0));
        }

        return result;
    }

    // ────────────────────────────────────────────
    //  Height smoothing
    // ────────────────────────────────────────────

    /// <summary>
    /// Computes smoothed height values for a set of affected vertices.
    /// Each vertex is blended toward the average height of the set.
    /// Returns a list of (landblockId, vertexIndex, originalHeight, newHeight) changes.
    /// </summary>
    /// <param name="affectedVertices">Vertices to smooth (from GetAffectedVertices).</param>
    /// <param name="strength">Blend strength 0.0 – 1.0.</param>
    /// <param name="terrainLookup">Resolves a landblock key to its terrain data array.</param>
    public static List<(ushort LbId, int VertexIndex, byte Original, byte NewHeight)> ComputeSmooth(
        List<(ushort LandblockId, int VertexIndex, Vector3 Position)> affectedVertices,
        float strength,
        Func<ushort, TerrainEntry[]?> terrainLookup) {

        var result = new List<(ushort, int, byte, byte)>();
        var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();

        // First pass: compute average height
        double heightSum = 0;
        int heightCount = 0;

        foreach (var (lbId, vIndex, _) in affectedVertices) {
            if (!landblockDataCache.TryGetValue(lbId, out var data)) {
                data = terrainLookup(lbId);
                if (data == null) continue;
                landblockDataCache[lbId] = data;
            }
            heightSum += data[vIndex].Height;
            heightCount++;
        }

        if (heightCount == 0) return result;
        double avgHeight = heightSum / heightCount;

        // Second pass: blend toward average
        foreach (var (lbId, vIndex, _) in affectedVertices) {
            if (!landblockDataCache.TryGetValue(lbId, out var data)) continue;

            byte original = data[vIndex].Height;
            double blended = original + (avgHeight - original) * strength;
            byte newHeight = (byte)Math.Clamp((int)Math.Round(blended), 0, 255);

            if (original != newHeight) {
                result.Add((lbId, vIndex, original, newHeight));
            }
        }

        return result;
    }

    // ────────────────────────────────────────────
    //  Height raise / lower
    // ────────────────────────────────────────────

    /// <summary>
    /// Computes height changes for raising or lowering terrain by a delta.
    /// Returns a list of (landblockId, vertexIndex, originalHeight, newHeight) changes.
    /// </summary>
    public static List<(ushort LbId, int VertexIndex, byte Original, byte NewHeight)> ComputeRaiseLower(
        List<(ushort LandblockId, int VertexIndex, Vector3 Position)> affectedVertices,
        int delta,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        HashSet<(ushort, int)>? alreadyProcessed = null) {

        var result = new List<(ushort, int, byte, byte)>();
        var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();

        foreach (var (lbId, vIndex, _) in affectedVertices) {
            if (alreadyProcessed != null && !alreadyProcessed.Add((lbId, vIndex)))
                continue;

            if (!landblockDataCache.TryGetValue(lbId, out var data)) {
                data = terrainLookup(lbId);
                if (data == null) continue;
                landblockDataCache[lbId] = data;
            }

            byte original = data[vIndex].Height;
            byte newHeight = (byte)Math.Clamp(original + delta, 0, 255);
            if (original != newHeight) {
                result.Add((lbId, vIndex, original, newHeight));
            }
        }

        return result;
    }

    // ────────────────────────────────────────────
    //  Height set (flatten)
    // ────────────────────────────────────────────

    /// <summary>
    /// Computes height changes for setting all affected vertices to a target height.
    /// </summary>
    public static List<(ushort LbId, int VertexIndex, byte Original, byte NewHeight)> ComputeSetHeight(
        List<(ushort LandblockId, int VertexIndex, Vector3 Position)> affectedVertices,
        byte targetHeight,
        Func<ushort, TerrainEntry[]?> terrainLookup) {

        var result = new List<(ushort, int, byte, byte)>();
        var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();

        foreach (var (lbId, vIndex, _) in affectedVertices) {
            if (!landblockDataCache.TryGetValue(lbId, out var data)) {
                data = terrainLookup(lbId);
                if (data == null) continue;
                landblockDataCache[lbId] = data;
            }

            byte original = data[vIndex].Height;
            if (original != targetHeight) {
                result.Add((lbId, vIndex, original, targetHeight));
            }
        }

        return result;
    }

    // ────────────────────────────────────────────
    //  Height sampling (AC-accurate triangle interpolation)
    // ────────────────────────────────────────────

    /// <summary>
    /// Triangle-based terrain height interpolation matching the AC client.
    /// localX/localY are in [0, 192] within the landblock.
    /// </summary>
    public static float SampleHeightTriangle(TerrainEntry[] data, float[] heightTable,
        float localX, float localY, uint landblockX, uint landblockY) {

        float cellX = localX / CellSize;
        float cellY = localY / CellSize;

        uint cellIndexX = Math.Min((uint)Math.Floor(cellX), LandblockEdgeCellCount - 1);
        uint cellIndexY = Math.Min((uint)Math.Floor(cellY), LandblockEdgeCellCount - 1);

        float fracX = cellX - cellIndexX;
        float fracY = cellY - cellIndexY;

        float hSW = GetHeightFromData(data, heightTable, cellIndexX, cellIndexY);
        float hSE = GetHeightFromData(data, heightTable, cellIndexX + 1, cellIndexY);
        float hNW = GetHeightFromData(data, heightTable, cellIndexX, cellIndexY + 1);
        float hNE = GetHeightFromData(data, heightTable, cellIndexX + 1, cellIndexY + 1);

        uint globalCellX = landblockX * LandblockEdgeCellCount + cellIndexX;
        uint globalCellY = landblockY * LandblockEdgeCellCount + cellIndexY;
        bool isSWtoNE = IsSWtoNEcut(globalCellX, globalCellY);

        if (isSWtoNE) {
            if (fracX > fracY) {
                return hSW + fracX * (hSE - hSW) + fracY * (hNE - hSE);
            } else {
                return hSW + fracX * (hNE - hNW) + fracY * (hNW - hSW);
            }
        } else {
            if (fracX + fracY <= 1.0f) {
                return hSW + fracX * (hSE - hSW) + fracY * (hNW - hSW);
            } else {
                return hNE + (1.0f - fracX) * (hNW - hNE) + (1.0f - fracY) * (hSE - hNE);
            }
        }
    }

    /// <summary>
    /// Determines the triangle split direction for a terrain cell, matching the
    /// AC client's pseudo-random algorithm from LandblockStruct.ConstructPolygons.
    /// </summary>
    public static bool IsSWtoNEcut(uint globalCellX, uint globalCellY) {
        uint magicA = (uint)unchecked((int)globalCellX * 214614067 + 1813693831);
        uint magicB = (uint)unchecked((int)globalCellX * 1109124029);
        uint splitDir = unchecked((uint)((int)globalCellY * (int)magicA - (int)magicB - 1369149221));
        return splitDir * 2.3283064e-10 >= 0.5;
    }

    /// <summary>
    /// World-space height lookup using triangle interpolation.
    /// </summary>
    public static float GetHeightAtWorldPosition(float worldX, float worldY,
        Func<ushort, TerrainEntry[]?> terrainLookup, float[] heightTable) {

        // Negative world coords would cast to 0 (or wrap) below and sample LB 0.
        if (worldX < 0 || worldY < 0) return 0f;

        uint landblockX = (uint)Math.Floor(worldX / LandblockLength);
        uint landblockY = (uint)Math.Floor(worldY / LandblockLength);

        if (landblockX > 254 || landblockY > 254) return 0f;

        ushort lbId = (ushort)((landblockX << 8) | landblockY);
        var data = terrainLookup(lbId);
        if (data == null) return 0f;

        float localX = worldX - landblockX * LandblockLength;
        float localY = worldY - landblockY * LandblockLength;

        return SampleHeightTriangle(data, heightTable, localX, localY, landblockX, landblockY);
    }

    // ────────────────────────────────────────────
    //  Road line path generation
    // ────────────────────────────────────────────

    /// <summary>
    /// Generates an optimal grid-aligned path between two world positions,
    /// returning grid-snapped waypoints. Used by road drawing.
    /// </summary>
    public static List<Vector3> GenerateGridPath(
        Vector3 start, Vector3 end, Func<float, float, float>? heightLookup = null) {

        var path = new List<Vector3>();

        int startGX = (int)Math.Round(start.X / CellSize);
        int startGY = (int)Math.Round(start.Y / CellSize);
        int endGX = (int)Math.Round(end.X / CellSize);
        int endGY = (int)Math.Round(end.Y / CellSize);

        int currentX = startGX;
        int currentY = startGY;

        float z = heightLookup?.Invoke(currentX * CellSize, currentY * CellSize) ?? 0f;
        path.Add(new Vector3(currentX * CellSize, currentY * CellSize, z));

        while (currentX != endGX || currentY != endGY) {
            int deltaX = Math.Sign(endGX - currentX);
            int deltaY = Math.Sign(endGY - currentY);

            if (deltaX != 0 && deltaY != 0) {
                currentX += deltaX;
                currentY += deltaY;
            } else if (deltaX != 0) {
                currentX += deltaX;
            } else {
                currentY += deltaY;
            }

            z = heightLookup?.Invoke(currentX * CellSize, currentY * CellSize) ?? 0f;
            path.Add(new Vector3(currentX * CellSize, currentY * CellSize, z));
        }

        return path;
    }

    // ────────────────────────────────────────────
    //  Coordinate helpers
    // ────────────────────────────────────────────

    /// <summary>
    /// Converts a world position to landblock key + local vertex index.
    /// </summary>
    public static (ushort LandblockId, int VertexIndex)? WorldToVertex(float worldX, float worldY) {
        // Reject negatives before truncating: (int) truncates toward zero, so a
        // worldX in (−192, 0) would yield lbX=0 and slip past the `lbX < 0` guard,
        // stamping onto landblock 0's column 0 instead of being rejected.
        if (worldX < 0 || worldY < 0) return null;

        int lbX = (int)(worldX / LandblockLength);
        int lbY = (int)(worldY / LandblockLength);

        // Valid landblock indices are 0..254 (MapSize); the old `>= MapSize`
        // wrongly excluded the world's last row/column (index 254). 254 still
        // fits the single-byte packed key below, so allow it.
        if (lbX < 0 || lbY < 0 || lbX > MapSize || lbY > MapSize) return null;

        float localX = worldX - lbX * LandblockLength;
        float localY = worldY - lbY * LandblockLength;

        int cellX = (int)Math.Round(localX / CellSize);
        int cellY = (int)Math.Round(localY / CellSize);

        cellX = Math.Max(0, Math.Min(8, cellX));
        cellY = Math.Max(0, Math.Min(8, cellY));

        int vertexIndex = cellX * 9 + cellY;
        ushort lbId = (ushort)((lbX << 8) | lbY);

        return (lbId, vertexIndex);
    }

    /// <summary>
    /// Converts a landblock key to X/Y components.
    /// </summary>
    public static (uint X, uint Y) LandblockKeyToXY(ushort key) => ((uint)(key >> 8), (uint)(key & 0xFF));

    /// <summary>
    /// Creates a landblock key from X/Y components.
    /// </summary>
    public static ushort XYToLandblockKey(uint x, uint y) => (ushort)((x << 8) | y);

    // ────────────────────────────────────────────
    //  Edge neighbor syncing (shared helper)
    // ────────────────────────────────────────────

    private static void AddEdgeNeighbors(
        List<(ushort, int, Vector3)> affected,
        int lbX, int lbY, int localVX, int localVY, Vector3 vertPos) {

        if (localVX == 0 && lbX > 0)
            affected.Add(((ushort)(((lbX - 1) << 8) | lbY), 8 * 9 + localVY, vertPos));

        if (localVX == 8 && lbX < 254)
            affected.Add(((ushort)(((lbX + 1) << 8) | lbY), 0 * 9 + localVY, vertPos));

        if (localVY == 0 && lbY > 0)
            affected.Add(((ushort)((lbX << 8) | (lbY - 1)), localVX * 9 + 8, vertPos));

        if (localVY == 8 && lbY < 254)
            affected.Add(((ushort)((lbX << 8) | (lbY + 1)), localVX * 9 + 0, vertPos));

        // Diagonal corners
        if (localVX == 0 && localVY == 0 && lbX > 0 && lbY > 0)
            affected.Add(((ushort)(((lbX - 1) << 8) | (lbY - 1)), 8 * 9 + 8, vertPos));

        if (localVX == 8 && localVY == 0 && lbX < 254 && lbY > 0)
            affected.Add(((ushort)(((lbX + 1) << 8) | (lbY - 1)), 0 * 9 + 8, vertPos));

        if (localVX == 0 && localVY == 8 && lbX > 0 && lbY < 254)
            affected.Add(((ushort)(((lbX - 1) << 8) | (lbY + 1)), 8 * 9 + 0, vertPos));

        if (localVX == 8 && localVY == 8 && lbX < 254 && lbY < 254)
            affected.Add(((ushort)(((lbX + 1) << 8) | (lbY + 1)), 0 * 9 + 0, vertPos));
    }

    // ────────────────────────────────────────────
    //  Height table helper
    // ────────────────────────────────────────────

    private static float GetHeightFromData(TerrainEntry[] data, float[] heightTable, uint vx, uint vy) {
        vx = Math.Min(vx, 8);
        vy = Math.Min(vy, 8);
        var idx = (int)(vx * 9 + vy);
        return idx < data.Length ? heightTable[data[idx].Height] : 0f;
    }
}
