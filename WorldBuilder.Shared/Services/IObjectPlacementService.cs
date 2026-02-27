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
            out Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue, uint OriginalEntryValue, uint NewEntryValue)>> terrainChanges,
            out Dictionary<ushort, TerrainEntry[]> originalDataSnapshots);

        int AdjustNearbyObjectHeights(
            ITerrainService terrainService, TerrainDocument terrainDoc,
            DocumentManager docManager, float[] heightTable,
            Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue, uint OriginalEntryValue, uint NewEntryValue)>> changes,
            Dictionary<ushort, TerrainEntry[]> originalDataSnapshots,
            StaticObject placedBuilding);

        float? PlaceBuildingAndFlattenTerrain(
            ITerrainService terrainService, TerrainDocument terrainDoc,
            DocumentManager docManager, float[] heightTable,
            StaticObject obj, (Vector3 Min, Vector3 Max)? modelBounds,
            out Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue, uint OriginalEntryValue, uint NewEntryValue)>> terrainChanges);

        void MoveObjects(
            ITerrainService terrainService, TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable,
            IEnumerable<(ushort LbKey, int Index, Vector3 OriginalPos)> objects, Vector3 delta);

        void RotateObjects(
            ITerrainService terrainService, TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable,
            IEnumerable<(ushort LbKey, int Index, Vector3 OriginalPos, Quaternion OriginalOrientation)> objects, Vector3 groupCentroid, Quaternion rotation);
    }
}
