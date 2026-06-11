using System.Numerics;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Models;

namespace WorldBuilder.Shared.Lib.Terrain;

/// <summary>
/// Pure algorithmic computation for stamp pasting operations.
/// Extracted from WorldBuilder.Editors.Landscape.Commands.PasteStampCommand.
///
/// Computes terrain changes and object placements without any UI/GPU coupling.
/// The caller is responsible for applying the changes to the document layer.
/// </summary>
public static class StampAlgorithms {

    /// <summary>
    /// Result of computing a stamp paste operation.
    /// </summary>
    public record StampPasteResult {
        /// <summary>
        /// Terrain vertex changes keyed by landblock: { lbKey → { vertexIndex → packedTerrainEntry } }.
        /// </summary>
        public Dictionary<ushort, Dictionary<byte, uint>> TerrainChanges { get; init; } = new();

        /// <summary>
        /// Original terrain data for undo: { lbKey → { vertexIndex → originalPackedEntry } }.
        /// </summary>
        public Dictionary<ushort, Dictionary<byte, uint>> OriginalTerrain { get; init; } = new();

        /// <summary>
        /// Static objects to place, in world coordinates.
        /// </summary>
        public List<(ushort LandblockKey, StaticObject Object)> ObjectsToPlace { get; init; } = new();
    }

    /// <summary>
    /// Computes all terrain changes and object placements for a stamp paste,
    /// without actually applying them.
    /// </summary>
    /// <param name="stamp">The terrain stamp to paste.</param>
    /// <param name="pastePosition">World-space XY position for the paste origin.</param>
    /// <param name="includeObjects">Whether to include stamp objects in the result.</param>
    /// <param name="blendEdges">Whether to blend edge vertices with existing terrain.</param>
    /// <param name="zOffset">Height offset to apply.</param>
    /// <param name="terrainLookup">Resolves a landblock key to its terrain data array.</param>
    /// <param name="heightTable">The land height lookup table from Region.LandDefs.</param>
    public static StampPasteResult ComputePaste(
        TerrainStamp stamp,
        Vector2 pastePosition,
        bool includeObjects,
        bool blendEdges,
        float zOffset,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        float[]? heightTable = null) {

        var result = new StampPasteResult();

        for (int vx = 0; vx < stamp.WidthInVertices; vx++) {
            for (int vy = 0; vy < stamp.HeightInVertices; vy++) {
                float worldX = pastePosition.X + (vx * 24f);
                float worldY = pastePosition.Y + (vy * 24f);

                int lbX = (int)MathF.Floor(worldX / 192f);
                int lbY = (int)MathF.Floor(worldY / 192f);

                // Skip (do not wrap) vertices that fall outside the valid landblock
                // grid. Landblock indices are bytes 0..254 (0xFF is a sentinel); a
                // (ushort) cast of an out-of-range lbX/lbY would silently land the
                // paste in an unrelated landblock.
                if (lbX < 0 || lbX > 254 || lbY < 0 || lbY > 254)
                    continue;

                ushort lbKey = (ushort)((lbX << 8) | lbY);

                float localX = worldX - (lbX * 192f);
                float localY = worldY - (lbY * 192f);

                int localVX = (int)MathF.Round(localX / 24f);
                int localVY = (int)MathF.Round(localY / 24f);

                if (localVX < 0 || localVX > 8 || localVY < 0 || localVY > 8)
                    continue;

                int vertexIndex = localVX * 9 + localVY;
                int stampIndex = vx * stamp.HeightInVertices + vy;

                var data = terrainLookup(lbKey);
                if (data == null) continue;

                // Store original for undo
                if (!result.OriginalTerrain.TryGetValue(lbKey, out var lbOriginals)) {
                    lbOriginals = new Dictionary<byte, uint>();
                    result.OriginalTerrain[lbKey] = lbOriginals;
                }
                if (!lbOriginals.ContainsKey((byte)vertexIndex)) {
                    lbOriginals[(byte)vertexIndex] = data[vertexIndex].ToUInt();
                }

                // Unpack stamp terrain data
                ushort terrainWord = stamp.TerrainTypes[stampIndex];
                byte road = (byte)(terrainWord & 0x3);
                byte type = (byte)((terrainWord >> 2) & 0x1F);
                byte scenery = (byte)((terrainWord >> 11) & 0x1F);
                byte height = stamp.Heights[stampIndex];

                // Apply Z offset
                if (zOffset != 0 && heightTable != null) {
                    float heightUnits = heightTable[height];
                    heightUnits += zOffset;
                    height = FindNearestHeightIndex(heightUnits, heightTable);
                }

                // Blend edges if requested
                if (blendEdges && IsEdgeVertex(vx, vy, stamp.WidthInVertices, stamp.HeightInVertices)) {
                    height = BlendHeight(height, data[vertexIndex].Height);
                }

                var newEntry = new TerrainEntry(road, scenery, type, height);

                if (!result.TerrainChanges.TryGetValue(lbKey, out var lbChanges)) {
                    lbChanges = new Dictionary<byte, uint>();
                    result.TerrainChanges[lbKey] = lbChanges;
                }
                lbChanges[(byte)vertexIndex] = newEntry.ToUInt();
            }
        }

        // Compute object placements
        if (includeObjects) {
            foreach (var obj in stamp.Objects) {
                float worldX = pastePosition.X + obj.Origin.X;
                float worldY = pastePosition.Y + obj.Origin.Y;
                float worldZ = obj.Origin.Z + zOffset;

                int lbX = (int)MathF.Floor(worldX / 192f);
                int lbY = (int)MathF.Floor(worldY / 192f);

                // Skip objects that fall outside the valid landblock grid (0..254);
                // see the vertex loop above for rationale.
                if (lbX < 0 || lbX > 254 || lbY < 0 || lbY > 254)
                    continue;

                ushort lbKey = (ushort)((lbX << 8) | lbY);

                var worldObj = new StaticObject {
                    Id = obj.Id,
                    IsSetup = obj.IsSetup,
                    Origin = new Vector3(worldX, worldY, worldZ),
                    Orientation = obj.Orientation,
                    Scale = obj.Scale
                };

                result.ObjectsToPlace.Add((lbKey, worldObj));
            }
        }

        return result;
    }

    private static bool IsEdgeVertex(int vx, int vy, int width, int height) {
        return vx == 0 || vx == width - 1 || vy == 0 || vy == height - 1;
    }

    private static byte BlendHeight(byte stampHeight, byte existingHeight) {
        return (byte)((stampHeight + existingHeight) / 2);
    }

    /// <summary>
    /// Finds the height table index whose value is closest to the target.
    /// </summary>
    public static byte FindNearestHeightIndex(float height, float[] heightTable) {
        byte bestIndex = 0;
        float bestDiff = float.MaxValue;

        for (int i = 0; i < heightTable.Length; i++) {
            float diff = MathF.Abs(heightTable[i] - height);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestIndex = (byte)i;
            }
        }
        return bestIndex;
    }
}
