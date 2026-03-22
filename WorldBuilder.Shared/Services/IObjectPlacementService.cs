using System.Numerics;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Shared.Services;

/// <summary>
/// Abstraction over object placement operations.
/// Encapsulates building snapping, terrain flattening under buildings,
/// and object height adjustment — the "brains" extracted from
/// SelectSubToolViewModel so that headless/agent code can reuse them.
/// </summary>
public interface IObjectPlacementService {
    /// <summary>
    /// Snaps a placement position to the center of the nearest outdoor cell
    /// (24×24 grid), clamping to inner cells (1–6) to maintain landblock-edge clearance.
    /// </summary>
    /// <param name="worldX">Clicked world X.</param>
    /// <param name="worldY">Clicked world Y.</param>
    /// <returns>Snapped (worldX, worldY).</returns>
    (float X, float Y) SnapToNearestCellCenter(float worldX, float worldY);

    /// <summary>
    /// Finds the height byte (0–255) whose height table value is closest to
    /// a target Z height.
    /// </summary>
    byte FindClosestHeightByte(float[] heightTable, float targetZ);

    /// <summary>
    /// Computes the terrain flattening change set for a building footprint.
    /// Returns the set of vertex changes and the snapped target height byte.
    /// Does NOT apply the changes — the caller is responsible for committing them.
    /// </summary>
    /// <param name="buildingMinX">World-space minimum X of the building footprint (with margin).</param>
    /// <param name="buildingMinY">World-space minimum Y.</param>
    /// <param name="buildingMaxX">World-space maximum X.</param>
    /// <param name="buildingMaxY">World-space maximum Y.</param>
    /// <param name="buildingZ">The Z at which the building is being placed.</param>
    /// <param name="heightTable">The region's land height table.</param>
    /// <param name="terrainLookup">Resolves landblock key → terrain data.</param>
    /// <param name="heightLookup">Resolves world (X,Y) → terrain Z (for vertex gathering).</param>
    /// <returns>
    /// A dictionary of landblock changes and the target height byte, or null
    /// if no flattening was needed.
    /// </returns>
    FlattenResult? ComputeFlattenChanges(
        float buildingMinX, float buildingMinY,
        float buildingMaxX, float buildingMaxY,
        float buildingZ,
        float[] heightTable,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        Func<float, float, float>? heightLookup = null);

    /// <summary>
    /// Computes Z adjustments for static objects on affected landblocks after terrain
    /// has been flattened. Each object's offset from the terrain surface is preserved.
    /// </summary>
    /// <param name="changes">The height changes applied during flattening.</param>
    /// <param name="originalDataSnapshots">Pre-flattening terrain data per landblock.</param>
    /// <param name="newTerrainLookup">Post-flattening terrain data lookup.</param>
    /// <param name="heightTable">The region's land height table.</param>
    /// <param name="skipObjectId">Object ID to skip (the building being placed).</param>
    /// <param name="skipObjectOrigin">Origin of the object to skip.</param>
    /// <param name="objectsLookup">
    /// Returns all static objects for a landblock key as
    /// (index, objectId, origin) tuples.
    /// </param>
    /// <returns>List of (landblockKey, objectIndex, newZ) adjustments.</returns>
    List<(ushort LandblockKey, int ObjectIndex, float NewZ)> ComputeObjectHeightAdjustments(
        Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> changes,
        Dictionary<ushort, TerrainEntry[]> originalDataSnapshots,
        Func<ushort, TerrainEntry[]?> newTerrainLookup,
        float[] heightTable,
        uint skipObjectId,
        Vector3 skipObjectOrigin,
        Func<ushort, List<(int Index, uint ObjectId, Vector3 Origin)>> objectsLookup);
}

/// <summary>
/// Result of computing terrain flattening changes.
/// </summary>
public record FlattenResult(
    Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> Changes,
    byte TargetHeight,
    float TargetHeightWorld);
