using System.Numerics;
using System.Text.Json;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.Terrain;
using WorldBuilder.Shared.Models;

namespace WorldBuilder.Shared.Services;

/// <summary>
/// Default implementation of <see cref="IStampService"/>.
/// Provides terrain region capture, paste computation, and serialization.
/// </summary>
public class StampService : IStampService {

    /// <summary>
    /// Captures a rectangular region of terrain into a TerrainStamp.
    /// Converts world-space bounding box to vertex grid coordinates.
    /// </summary>
    public TerrainStamp? CaptureRegion(
        float minX, float minY, float maxX, float maxY,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        float[] heightTable,
        bool includeObjects = false,
        Func<ushort, IEnumerable<StaticObject>>? objectLookup = null) {

        // Convert world coordinates to vertex coordinates
        // Each vertex is spaced 24 units apart, landblocks are 192 units wide
        int vMinX = (int)MathF.Floor(minX / 24f);
        int vMinY = (int)MathF.Floor(minY / 24f);
        int vMaxX = (int)MathF.Ceiling(maxX / 24f);
        int vMaxY = (int)MathF.Ceiling(maxY / 24f);

        int widthV = vMaxX - vMinX + 1;
        int heightV = vMaxY - vMinY + 1;

        if (widthV <= 0 || heightV <= 0) return null;

        var stamp = new TerrainStamp {
            Name = $"Capture_{DateTime.UtcNow:yyyyMMdd_HHmmss}",
            Description = $"Region ({minX},{minY})-({maxX},{maxY})",
            WidthInVertices = widthV,
            HeightInVertices = heightV,
            Heights = new byte[widthV * heightV],
            TerrainTypes = new ushort[widthV * heightV],
            OriginalWorldPosition = new Vector2(vMinX * 24f, vMinY * 24f)
        };

        for (int vx = 0; vx < widthV; vx++) {
            for (int vy = 0; vy < heightV; vy++) {
                float worldX = (vMinX + vx) * 24f;
                float worldY = (vMinY + vy) * 24f;

                int lbX = (int)MathF.Floor(worldX / 192f);
                int lbY = (int)MathF.Floor(worldY / 192f);
                ushort lbKey = (ushort)((lbX << 8) | lbY);

                float localX = worldX - (lbX * 192f);
                float localY = worldY - (lbY * 192f);
                int localVX = (int)MathF.Round(localX / 24f);
                int localVY = (int)MathF.Round(localY / 24f);

                if (localVX < 0 || localVX > 8 || localVY < 0 || localVY > 8)
                    continue;

                int vertexIndex = localVX * 9 + localVY;
                int stampIndex = vx * heightV + vy;

                var data = terrainLookup(lbKey);
                if (data == null) continue;

                var entry = data[vertexIndex];
                stamp.Heights[stampIndex] = entry.Height;

                // Pack terrain type: road(2) | type(5) | scenery(5)
                ushort packed = (ushort)(
                    (entry.Road & 0x3) |
                    ((entry.Type & 0x1F) << 2) |
                    ((entry.Scenery & 0x1F) << 11));
                stamp.TerrainTypes[stampIndex] = packed;
            }
        }

        // Capture objects within the bounding box
        if (includeObjects && objectLookup != null) {
            int lbStartX = (int)MathF.Floor(minX / 192f);
            int lbStartY = (int)MathF.Floor(minY / 192f);
            int lbEndX = (int)MathF.Floor(maxX / 192f);
            int lbEndY = (int)MathF.Floor(maxY / 192f);

            for (int bx = lbStartX; bx <= lbEndX; bx++) {
                for (int by = lbStartY; by <= lbEndY; by++) {
                    ushort lbKey = (ushort)((bx << 8) | by);
                    foreach (var obj in objectLookup(lbKey)) {
                        if (obj.Origin.X >= minX && obj.Origin.X <= maxX &&
                            obj.Origin.Y >= minY && obj.Origin.Y <= maxY) {
                            // Store with origin relative to stamp origin
                            stamp.Objects.Add(new StaticObject {
                                Id = obj.Id,
                                IsSetup = obj.IsSetup,
                                Origin = new Vector3(
                                    obj.Origin.X - stamp.OriginalWorldPosition.X,
                                    obj.Origin.Y - stamp.OriginalWorldPosition.Y,
                                    obj.Origin.Z),
                                Orientation = obj.Orientation,
                                Scale = obj.Scale
                            });
                        }
                    }
                }
            }
        }

        // Determine source landblock from the center of the capture region
        float centerX = (minX + maxX) / 2f;
        float centerY = (minY + maxY) / 2f;
        stamp.SourceLandblockId = (ushort)(((int)(centerX / 192f) << 8) | (int)(centerY / 192f));

        return stamp;
    }

    public StampAlgorithms.StampPasteResult ComputePaste(
        TerrainStamp stamp,
        Vector2 pastePosition,
        bool includeObjects,
        bool blendEdges,
        float zOffset,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        float[]? heightTable = null)
        => StampAlgorithms.ComputePaste(stamp, pastePosition, includeObjects, blendEdges, zOffset, terrainLookup, heightTable);

    /// <summary>
    /// Serializes a TerrainStamp to JSON bytes for storage or agent transmission.
    /// </summary>
    public byte[] SerializeStamp(TerrainStamp stamp) {
        return JsonSerializer.SerializeToUtf8Bytes(stamp, new JsonSerializerOptions {
            WriteIndented = false,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });
    }

    /// <summary>
    /// Deserializes a TerrainStamp from JSON bytes.
    /// </summary>
    public TerrainStamp? DeserializeStamp(byte[] data) {
        return JsonSerializer.Deserialize<TerrainStamp>(data, new JsonSerializerOptions {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });
    }
}
