using System.Numerics;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.Terrain;

namespace WorldBuilder.Shared.Services;

/// <summary>
/// Default implementation of <see cref="IObjectPlacementService"/>.
/// Contains the pure logic extracted from SelectSubToolViewModel —
/// building cell-center snapping, terrain flattening, and static-object
/// height adjustment — with no UI or rendering dependencies.
/// </summary>
public class ObjectPlacementService : IObjectPlacementService {

    private readonly ITerrainService _terrainService;

    public ObjectPlacementService(ITerrainService terrainService) {
        _terrainService = terrainService ?? throw new ArgumentNullException(nameof(terrainService));
    }

    /// <inheritdoc />
    public (float X, float Y) SnapToNearestCellCenter(float worldX, float worldY) {
        int lbX = (int)MathF.Floor(worldX / 192f);
        int lbY = (int)MathF.Floor(worldY / 192f);

        float lbOriginX = lbX * 192f;
        float lbOriginY = lbY * 192f;

        float localX = worldX - lbOriginX;
        float localY = worldY - lbOriginY;

        // Snap to the center of the nearest outdoor cell (24×24 grid).
        // Edge cells 0 and 7 are excluded to maintain ~36-unit landblock
        // edge clearance (matching original AC building placement).
        int cellX = Math.Clamp((int)(localX / 24f), 1, 6);
        int cellY = Math.Clamp((int)(localY / 24f), 1, 6);

        float snappedX = lbOriginX + cellX * 24f + 12f;
        float snappedY = lbOriginY + cellY * 24f + 12f;

        return (snappedX, snappedY);
    }

    /// <inheritdoc />
    public byte FindClosestHeightByte(float[] heightTable, float targetZ) {
        return _terrainService.FindClosestHeightByte(heightTable, targetZ);
    }

    /// <inheritdoc />
    public FlattenResult? ComputeFlattenChanges(
        float buildingMinX, float buildingMinY,
        float buildingMaxX, float buildingMaxY,
        float buildingZ,
        float[] heightTable,
        Func<ushort, TerrainEntry[]?> terrainLookup,
        Func<float, float, float>? heightLookup = null) {

        // Get all terrain vertices in the rectangular footprint
        var vertices = _terrainService.GetVerticesInRect(
            buildingMinX, buildingMinY, buildingMaxX, buildingMaxY, heightLookup);
        if (vertices.Count == 0) return null;

        // Find the MAXIMUM height byte among all vertices in the footprint.
        // Flattening to the max ensures terrain is only raised, never lowered,
        // so the building sits ON the terrain without its base going below ground.
        var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();
        byte maxHeight = 0;

        foreach (var (lbId, vIndex, _) in vertices) {
            if (!landblockDataCache.TryGetValue(lbId, out var data)) {
                data = terrainLookup(lbId);
                if (data == null) continue;
                landblockDataCache[lbId] = data;
            }
            byte h = data[vIndex].Height;
            if (h > maxHeight) maxHeight = h;
        }

        // Use the higher of: the max vertex height or the placement click height.
        // This handles both slopes (use max vertex) and valleys (use click height).
        byte clickHeight = FindClosestHeightByte(heightTable, buildingZ);
        byte targetHeight = Math.Max(maxHeight, clickHeight);

        // Build change set
        var changes = new Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>>();

        foreach (var (lbId, vIndex, _) in vertices) {
            if (!landblockDataCache.TryGetValue(lbId, out var data)) continue;

            if (!changes.TryGetValue(lbId, out var list)) {
                list = new List<(int, byte, byte)>();
                changes[lbId] = list;
            }

            if (list.Any(c => c.VertexIndex == vIndex)) continue;

            byte original = data[vIndex].Height;
            if (original == targetHeight) continue;
            list.Add((vIndex, original, targetHeight));
        }

        if (changes.Count == 0 && heightTable.Length > targetHeight) {
            return new FlattenResult(changes, targetHeight, heightTable[targetHeight]);
        }

        if (changes.Count == 0) return null;

        return new FlattenResult(changes, targetHeight,
            heightTable.Length > targetHeight ? heightTable[targetHeight] : 0f);
    }

    /// <inheritdoc />
    public List<(ushort LandblockKey, int ObjectIndex, float NewZ)> ComputeObjectHeightAdjustments(
        Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> changes,
        Dictionary<ushort, TerrainEntry[]> originalDataSnapshots,
        Func<ushort, TerrainEntry[]?> newTerrainLookup,
        float[] heightTable,
        uint skipObjectId,
        Vector3 skipObjectOrigin,
        Func<ushort, List<(int Index, uint ObjectId, Vector3 Origin)>> objectsLookup) {

        var adjustments = new List<(ushort, int, float)>();

        foreach (var lbId in changes.Keys) {
            if (!originalDataSnapshots.TryGetValue(lbId, out var originalData)) continue;

            var newData = newTerrainLookup(lbId);
            if (newData == null) continue;

            uint landblockX = (uint)(lbId >> 8) & 0xFF;
            uint landblockY = (uint)(lbId & 0xFF);
            float baseLbX = landblockX * 192f;
            float baseLbY = landblockY * 192f;

            var objects = objectsLookup(lbId);

            foreach (var (idx, objId, origin) in objects) {
                // Skip the building we are placing right now
                if (objId == skipObjectId &&
                    Vector3.Distance(origin, skipObjectOrigin) < 1.0f) {
                    continue;
                }

                float localX = origin.X - baseLbX;
                float localY = origin.Y - baseLbY;

                // Skip objects outside this landblock's bounds
                if (localX < 0 || localX > 192f || localY < 0 || localY > 192f) continue;

                // Sample terrain height at object position using original and new data
                float oldTerrainZ = _terrainService.SampleHeightTriangle(
                    originalData, heightTable, localX, localY, landblockX, landblockY);
                float newTerrainZ = _terrainService.SampleHeightTriangle(
                    newData, heightTable, localX, localY, landblockX, landblockY);

                float delta = newTerrainZ - oldTerrainZ;
                if (Math.Abs(delta) < 0.001f) continue;

                adjustments.Add((lbId, idx, origin.Z + delta));
            }
        }

        return adjustments;
    }
}
