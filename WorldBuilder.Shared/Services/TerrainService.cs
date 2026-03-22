using System.Numerics;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.Terrain;

namespace WorldBuilder.Shared.Services;

/// <summary>
/// Default implementation of <see cref="ITerrainService"/>.
/// Delegates all work to the pure-static <see cref="TerrainAlgorithms"/> class,
/// giving consumers an injectable, testable surface.
/// </summary>
public class TerrainService : ITerrainService {

    /// <inheritdoc />
    public List<(ushort LandblockId, int VertexIndex, Vector3 Position)> GetAffectedVertices(
        Vector3 center, float radius,
        Func<float, float, float>? heightLookup = null) {
        return TerrainAlgorithms.GetAffectedVertices(center, radius, heightLookup);
    }

    /// <inheritdoc />
    public List<(ushort LandblockId, int VertexIndex, Vector3 Position)> GetVerticesInRect(
        float minX, float minY, float maxX, float maxY,
        Func<float, float, float>? heightLookup = null) {
        return TerrainAlgorithms.GetVerticesInRect(minX, minY, maxX, maxY, heightLookup);
    }

    /// <inheritdoc />
    public List<(ushort LandblockId, int VertexIndex, byte Original, byte NewHeight)> ComputeSmooth(
        List<(ushort LandblockId, int VertexIndex, Vector3 Position)> affected,
        float strength,
        Func<ushort, TerrainEntry[]?> terrainLookup) {
        return TerrainAlgorithms.ComputeSmooth(affected, strength, terrainLookup);
    }

    /// <inheritdoc />
    public List<(ushort LandblockId, int VertexIndex, byte Original, byte NewHeight)> ComputeRaiseLower(
        List<(ushort LandblockId, int VertexIndex, Vector3 Position)> affected,
        int delta,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        HashSet<(ushort, int)>? alreadyProcessed = null) {
        return TerrainAlgorithms.ComputeRaiseLower(affected, delta, terrainLookup, alreadyProcessed);
    }

    /// <inheritdoc />
    public List<(ushort LandblockId, int VertexIndex, byte Original, byte NewHeight)> ComputeSetHeight(
        List<(ushort LandblockId, int VertexIndex, Vector3 Position)> affected,
        byte targetHeight,
        Func<ushort, TerrainEntry[]?> terrainLookup) {
        return TerrainAlgorithms.ComputeSetHeight(affected, targetHeight, terrainLookup);
    }

    /// <inheritdoc />
    public List<(ushort LbID, int VertexIndex, byte OldType)> FloodFill(
        uint startLbX, uint startLbY, uint startCellX, uint startCellY,
        byte newType,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        HashSet<ushort>? allowedLandblocks = null) {
        return TerrainAlgorithms.FloodFill(startLbX, startLbY, startCellX, startCellY,
            newType, terrainLookup, allowedLandblocks);
    }

    /// <inheritdoc />
    public List<Vector3> GenerateRoadPath(Vector3 start, Vector3 end,
        Func<float, float, float>? heightLookup = null) {
        return TerrainAlgorithms.GenerateGridPath(start, end, heightLookup);
    }

    /// <inheritdoc />
    public (ushort LandblockKey, int VertexIndex)? WorldToVertex(float worldX, float worldY) {
        return TerrainAlgorithms.WorldToVertex(worldX, worldY);
    }

    /// <inheritdoc />
    public float SampleHeightTriangle(
        TerrainEntry[] terrainData, float[] heightTable,
        float localX, float localY, uint landblockX, uint landblockY) {
        return TerrainAlgorithms.SampleHeightTriangle(terrainData, heightTable,
            localX, localY, landblockX, landblockY);
    }

    /// <inheritdoc />
    public float GetHeightAtWorldPosition(
        float worldX, float worldY,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        float[] heightTable) {
        return TerrainAlgorithms.GetHeightAtWorldPosition(worldX, worldY, terrainLookup, heightTable);
    }

    /// <inheritdoc />
    public byte FindClosestHeightByte(float[] heightTable, float targetZ) {
        byte best = 0;
        float bestDist = float.MaxValue;
        for (int i = 0; i < heightTable.Length && i < 256; i++) {
            float dist = Math.Abs(heightTable[i] - targetZ);
            if (dist < bestDist) {
                bestDist = dist;
                best = (byte)i;
            }
        }
        return best;
    }
}
