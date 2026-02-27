using System.Collections.Generic;
using System.Numerics;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Shared.Services {
    public interface IObjectPlacementService {
        (Vector3 Origin, Quaternion Orientation) GetSnappedPlacementTransform(
            IDatReaderWriter dats, uint objectId, Vector3 terrainPos, Quaternion currentOrientation);

        float? FlattenTerrainUnderBuilding(
            ITerrainService terrainService, TerrainDocument terrainDoc,
            DocumentManager docManager, float[] heightTable,
            StaticObject obj, (Vector3 Min, Vector3 Max)? modelBounds,
            out Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> terrainChanges,
            out Dictionary<ushort, TerrainEntry[]> originalDataSnapshots);

        int AdjustNearbyObjectHeights(
            ITerrainService terrainService, TerrainDocument terrainDoc,
            DocumentManager docManager, float[] heightTable,
            Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> changes,
            Dictionary<ushort, TerrainEntry[]> originalDataSnapshots,
            StaticObject placedBuilding);
    }
}
