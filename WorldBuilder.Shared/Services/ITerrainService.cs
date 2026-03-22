using System.Numerics;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Shared.Services;

/// <summary>
/// Abstraction over terrain manipulation operations.
/// Wraps the pure-algorithmic TerrainAlgorithms so that higher-level code
/// (Terminal REPL, agent processor, ViewModels) can depend on an injectable
/// service rather than calling statics directly.
/// </summary>
public interface ITerrainService {
    /// <summary>
    /// Gets all terrain vertices within a circular brush centered at the given
    /// world-space position.
    /// </summary>
    List<(ushort LandblockId, int VertexIndex, Vector3 Position)> GetAffectedVertices(
        Vector3 center, float radius,
        Func<float, float, float>? heightLookup = null);

    /// <summary>
    /// Gets all terrain vertices inside an axis-aligned world-space rectangle.
    /// </summary>
    List<(ushort LandblockId, int VertexIndex, Vector3 Position)> GetVerticesInRect(
        float minX, float minY, float maxX, float maxY,
        Func<float, float, float>? heightLookup = null);

    /// <summary>
    /// Computes smoothed height values for a set of affected vertices.
    /// Returns (landblockId, vertexIndex, originalHeight, newHeight) changes.
    /// </summary>
    List<(ushort LandblockId, int VertexIndex, byte Original, byte NewHeight)> ComputeSmooth(
        List<(ushort LandblockId, int VertexIndex, Vector3 Position)> affected,
        float strength,
        Func<ushort, TerrainEntry[]?> terrainLookup);

    /// <summary>
    /// Computes raise/lower height changes by a delta amount.
    /// </summary>
    List<(ushort LandblockId, int VertexIndex, byte Original, byte NewHeight)> ComputeRaiseLower(
        List<(ushort LandblockId, int VertexIndex, Vector3 Position)> affected,
        int delta,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        HashSet<(ushort, int)>? alreadyProcessed = null);

    /// <summary>
    /// Computes set-height changes to a target height byte.
    /// </summary>
    List<(ushort LandblockId, int VertexIndex, byte Original, byte NewHeight)> ComputeSetHeight(
        List<(ushort LandblockId, int VertexIndex, Vector3 Position)> affected,
        byte targetHeight,
        Func<ushort, TerrainEntry[]?> terrainLookup);

    /// <summary>
    /// Flood-fills terrain from a starting cell, collecting contiguous vertices
    /// with the same terrain texture type.
    /// </summary>
    List<(ushort LbID, int VertexIndex, byte OldType)> FloodFill(
        uint startLbX, uint startLbY, uint startCellX, uint startCellY,
        byte newType,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        HashSet<ushort>? allowedLandblocks = null);

    /// <summary>
    /// Generates a grid-aligned waypoint path for road drawing between two world positions.
    /// </summary>
    List<Vector3> GenerateRoadPath(Vector3 start, Vector3 end,
        Func<float, float, float>? heightLookup = null);

    /// <summary>
    /// Converts a world position to a landblock key and local vertex index.
    /// Returns null if the position is outside the map bounds.
    /// </summary>
    (ushort LandblockKey, int VertexIndex)? WorldToVertex(float worldX, float worldY);

    /// <summary>
    /// Triangle-based height sampling at a local position within a landblock.
    /// </summary>
    float SampleHeightTriangle(
        TerrainEntry[] terrainData, float[] heightTable,
        float localX, float localY, uint landblockX, uint landblockY);

    /// <summary>
    /// World-space height lookup using triangle interpolation.
    /// </summary>
    float GetHeightAtWorldPosition(
        float worldX, float worldY,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        float[] heightTable);

    /// <summary>
    /// Finds the height byte (0–255) whose height table value is closest to a target Z.
    /// </summary>
    byte FindClosestHeightByte(float[] heightTable, float targetZ);
}
