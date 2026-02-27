using System.Collections.Generic;
using System.Numerics;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Shared.Services {
    public interface ITerrainService {
        float GetHeightAtPosition(TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable, float worldX, float worldY);

        TerrainEntry[]? GetLandblockTerrain(TerrainDocument terrainDoc, DocumentManager docManager, ushort lbKey);

        List<(ushort LandblockId, int VertexIndex, Vector3 Position)> GetAffectedVertices(
            TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable,
            Vector3 position, float radius);

        List<(ushort LandblockId, int VertexIndex, Vector3 Position)> GetVerticesInRect(
            TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable,
            float minX, float minY, float maxX, float maxY);

        float SampleHeightTriangle(TerrainEntry[] data, float[] heightTable,
            float localX, float localY, uint landblockX, uint landblockY);

        bool IsSWtoNEcut(uint globalCellX, uint globalCellY);

        Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> SmoothTerrain(
            TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable,
            Vector3 centerPosition, float brushRadius, float strength,
            Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> pendingChanges);

        List<(ushort LbID, int VertexIndex, byte OldType)> FloodFillVertices(
            TerrainDocument terrainDoc, DocumentManager docManager,
            uint startLbX, uint startLbY, uint startCellX, uint startCellY,
            byte newType, HashSet<ushort>? allowedLandblocks = null);
    }
}
