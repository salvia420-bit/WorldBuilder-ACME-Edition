using System.Numerics;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.Terrain;
using WorldBuilder.Shared.Models;

namespace WorldBuilder.Shared.Services;

/// <summary>
/// Abstraction over terrain stamp (capture/paste/clone) operations.
/// Wraps the pure-algorithmic StampAlgorithms so that higher-level code
/// can depend on an injectable service.
///
/// Phase 1 roadmap: "Move the terrain stamp logic into an IStampService
/// capable of accepting mathematical bounding boxes and serializing the
/// captured height/texture data into memory streams for terminal manipulation."
/// </summary>
public interface IStampService {
    /// <summary>
    /// Captures a rectangular region of terrain into a TerrainStamp.
    /// The bounding box is in world-space coordinates.
    /// </summary>
    /// <param name="minX">World-space minimum X.</param>
    /// <param name="minY">World-space minimum Y.</param>
    /// <param name="maxX">World-space maximum X.</param>
    /// <param name="maxY">World-space maximum Y.</param>
    /// <param name="terrainLookup">Resolves landblock key → terrain data array.</param>
    /// <param name="heightTable">The region's land height table.</param>
    /// <param name="includeObjects">Whether to capture static objects in the region.</param>
    /// <param name="objectLookup">Returns objects for a landblock key (only used if includeObjects is true).</param>
    /// <returns>A TerrainStamp containing the captured data, or null if the region is empty.</returns>
    TerrainStamp? CaptureRegion(
        float minX, float minY, float maxX, float maxY,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        float[] heightTable,
        bool includeObjects = false,
        Func<ushort, IEnumerable<StaticObject>>? objectLookup = null);

    /// <summary>
    /// Computes all terrain changes and object placements for pasting a stamp,
    /// without actually applying them. The caller is responsible for committing.
    /// </summary>
    StampAlgorithms.StampPasteResult ComputePaste(
        TerrainStamp stamp,
        Vector2 pastePosition,
        bool includeObjects,
        bool blendEdges,
        float zOffset,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        float[]? heightTable = null);

    /// <summary>
    /// Serializes a TerrainStamp to a byte array for storage or transmission.
    /// </summary>
    byte[] SerializeStamp(TerrainStamp stamp);

    /// <summary>
    /// Deserializes a TerrainStamp from a byte array.
    /// </summary>
    TerrainStamp? DeserializeStamp(byte[] data);
}
