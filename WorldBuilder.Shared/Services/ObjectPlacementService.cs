using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Shared.Services {
    public class ObjectPlacementService : IObjectPlacementService {
        public (Vector3 Origin, Quaternion Orientation) GetSnappedPlacementTransform(
            IDatReaderWriter dats, uint objectId, Vector3 terrainPos, Quaternion currentOrientation) {

            bool isBuilding = dats != null && BuildingBlueprintCache.IsBuildingModelId(objectId, dats);
            if (!isBuilding) return (terrainPos, currentOrientation);

            int lbX = (int)Math.Floor(terrainPos.X / 192f);
            int lbY = (int)Math.Floor(terrainPos.Y / 192f);
            float lbOriginX = lbX * 192f;
            float lbOriginY = lbY * 192f;
            float localX = terrainPos.X - lbOriginX;
            float localY = terrainPos.Y - lbOriginY;

            int cellX = Math.Clamp((int)(localX / 24f), 1, 6);
            int cellY = Math.Clamp((int)(localY / 24f), 1, 6);

            localX = cellX * 24f + 12f;
            localY = cellY * 24f + 12f;

            var placementPos = new Vector3(lbOriginX + localX, lbOriginY + localY, terrainPos.Z);
            var orientation = currentOrientation;

            var blueprint = BuildingBlueprintCache.GetBlueprint(objectId, dats);
            if (blueprint != null) {
                orientation = blueprint.DonorOrientation;
            }

            return (placementPos, orientation);
        }

        public float? FlattenTerrainUnderBuilding(
            ITerrainService terrainService, TerrainDocument terrainDoc,
            DocumentManager docManager, float[] heightTable,
            StaticObject obj, (Vector3 Min, Vector3 Max)? modelBounds,
            out Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> terrainChanges,
            out Dictionary<ushort, TerrainEntry[]> originalDataSnapshots) {

            terrainChanges = new Dictionary<ushort, List<(int, byte, byte)>>();
            originalDataSnapshots = new Dictionary<ushort, TerrainEntry[]>();

            if (!modelBounds.HasValue) return null;

            var (localMin, localMax) = modelBounds.Value;
            float worldMinX = obj.Origin.X + localMin.X;
            float worldMaxX = obj.Origin.X + localMax.X;
            float worldMinY = obj.Origin.Y + localMin.Y;
            float worldMaxY = obj.Origin.Y + localMax.Y;

            const float flattenMargin = 6f;
            worldMinX -= flattenMargin;
            worldMaxX += flattenMargin;
            worldMinY -= flattenMargin;
            worldMaxY += flattenMargin;

            var vertices = terrainService.GetVerticesInRect(terrainDoc, docManager, heightTable, worldMinX, worldMinY, worldMaxX, worldMaxY);
            if (vertices.Count == 0) return null;

            var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();
            byte maxHeight = 0;
            foreach (var (lbId, vIndex, _) in vertices) {
                if (!landblockDataCache.TryGetValue(lbId, out var data)) {
                    data = terrainService.GetLandblockTerrain(terrainDoc, docManager, lbId);
                    if (data == null) continue;
                    landblockDataCache[lbId] = data;
                }
                byte h = data[vIndex].Height;
                if (h > maxHeight) maxHeight = h;
            }

            byte clickHeight = FindClosestHeightByte(heightTable, obj.Origin.Z);
            byte targetHeight = Math.Max(maxHeight, clickHeight);

            foreach (var (lbId, vIndex, _) in vertices) {
                if (!landblockDataCache.TryGetValue(lbId, out var data)) continue;

                if (!terrainChanges.TryGetValue(lbId, out var list)) {
                    list = new List<(int, byte, byte)>();
                    terrainChanges[lbId] = list;
                }

                if (list.Any(c => c.VertexIndex == vIndex)) continue;

                byte original = data[vIndex].Height;
                if (original == targetHeight) continue;
                list.Add((vIndex, original, targetHeight));
            }

            if (terrainChanges.Count == 0) return heightTable[targetHeight];

            foreach (var (lbId, _) in terrainChanges) {
                if (landblockDataCache.TryGetValue(lbId, out var data)) {
                    originalDataSnapshots[lbId] = (TerrainEntry[])data.Clone();
                }
            }

            return null; // The caller will apply changes and re-sample Z
        }

        public int AdjustNearbyObjectHeights(
            ITerrainService terrainService, TerrainDocument terrainDoc,
            DocumentManager docManager, float[] heightTable,
            Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> changes,
            Dictionary<ushort, TerrainEntry[]> originalDataSnapshots,
            StaticObject placedBuilding) {

            int totalAdjusted = 0;

            foreach (var lbId in changes.Keys) {
                if (!originalDataSnapshots.TryGetValue(lbId, out var originalData)) continue;

                var newData = terrainService.GetLandblockTerrain(terrainDoc, docManager, lbId);
                if (newData == null) continue;

                var docId = $"landblock_{lbId:X4}";
                var doc = docManager.GetOrCreateDocumentAsync<LandblockDocument>(docId).GetAwaiter().GetResult();
                if (doc == null || doc.StaticObjectCount == 0) continue;

                uint landblockX = (uint)(lbId >> 8) & 0xFF;
                uint landblockY = (uint)(lbId & 0xFF);
                float baseLbX = landblockX * 192f;
                float baseLbY = landblockY * 192f;

                for (int i = 0; i < doc.StaticObjectCount; i++) {
                    var obj = doc.GetStaticObject(i);

                    if (obj.Id == placedBuilding.Id &&
                        Vector3.Distance(obj.Origin, placedBuilding.Origin) < 1.0f) {
                        continue;
                    }

                    float localX = obj.Origin.X - baseLbX;
                    float localY = obj.Origin.Y - baseLbY;

                    if (localX < 0 || localX > 192f || localY < 0 || localY > 192f) continue;

                    float oldTerrainZ = terrainService.SampleHeightTriangle(
                        originalData, heightTable, localX, localY, landblockX, landblockY);
                    float newTerrainZ = terrainService.SampleHeightTriangle(
                        newData, heightTable, localX, localY, landblockX, landblockY);

                    float delta = newTerrainZ - oldTerrainZ;
                    if (Math.Abs(delta) < 0.001f) continue;

                    doc.SetStaticObjectHeight(i, obj.Origin.Z + delta);
                    totalAdjusted++;
                }
            }

            return totalAdjusted;
        }

        private static byte FindClosestHeightByte(float[] heightTable, float targetZ) {
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
}
