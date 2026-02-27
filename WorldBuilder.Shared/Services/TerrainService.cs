using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Shared.Services {
    public class TerrainService : ITerrainService {
        public const uint MapSize = 254;
        public const uint LandblockLength = 192;
        public const uint LandblockEdgeCellCount = 8;
        public const float CellSize = 24.0f;

        public float GetHeightAtPosition(TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable, float worldX, float worldY) {
            uint landblockX = (uint)Math.Floor(worldX / LandblockLength);
            uint landblockY = (uint)Math.Floor(worldY / LandblockLength);

            if (landblockX >= MapSize || landblockY >= MapSize) return 0f;

            var landblockID = landblockX << 8 | landblockY;
            var landblockData = GetLandblockTerrain(terrainDoc, docManager, (ushort)landblockID);
            if (landblockData == null) return 0f;

            float localX = worldX - landblockX * LandblockLength;
            float localY = worldY - landblockY * LandblockLength;

            return SampleHeightTriangle(landblockData, heightTable, localX, localY, landblockX, landblockY);
        }

        public TerrainEntry[]? GetLandblockTerrain(TerrainDocument terrainDoc, DocumentManager docManager, ushort lbKey) {
            // Start with base terrain
            var baseTerrain = terrainDoc.GetLandblockInternal(lbKey);
            var result = new TerrainEntry[81];

            if (baseTerrain != null) {
                Array.Copy(baseTerrain, result, 81);
            }
            else {
                for (int i = 0; i < 81; i++) {
                    result[i] = new TerrainEntry(0);
                }
            }

            // Get all visible layers in order (Top -> Bottom for first-non-null per field)
            var layers = GetVisibleLayers(terrainDoc);

            bool hasContent = baseTerrain != null;

            // Track which fields have been claimed per cell
            var resolved = new byte[81];

            foreach (var layer in layers) {
                var doc = docManager.GetOrCreateDocumentAsync<LayerDocument>(layer.DocumentId).GetAwaiter()
                    .GetResult();
                if (doc is null) continue;

                // Check if this layer has data and masks for this landblock
                if (!doc.TerrainData.Landblocks.TryGetValue(lbKey, out var sparseCells)) continue;
                doc.TerrainData.FieldMasks.TryGetValue(lbKey, out var sparseMasks);

                hasContent = true;
                foreach (var (cellIndex, cellValue) in sparseCells) {
                    // Determine which fields this layer claims for this cell
                    byte layerMask = (sparseMasks != null && sparseMasks.TryGetValue(cellIndex, out var m))
                        ? m
                        : TerrainFieldMask.All; // No mask = legacy data, treat as all fields

                    // Only apply fields not yet claimed by a higher layer
                    byte unclaimed = (byte)(layerMask & ~resolved[cellIndex]);
                    if (unclaimed == 0) continue;

                    var entry = new TerrainEntry(cellValue);
                    var current = result[cellIndex];

                    result[cellIndex] = new TerrainEntry(
                        road:    (unclaimed & TerrainFieldMask.Road) != 0    ? entry.Road    : current.Road,
                        scenery: (unclaimed & TerrainFieldMask.Scenery) != 0 ? entry.Scenery : current.Scenery,
                        type:    (unclaimed & TerrainFieldMask.Type) != 0    ? entry.Type    : current.Type,
                        height:  (unclaimed & TerrainFieldMask.Height) != 0  ? entry.Height  : current.Height
                    );

                    resolved[cellIndex] |= unclaimed;
                }
            }

            return hasContent ? result : null;
        }

        private List<TerrainLayer> GetVisibleLayers(TerrainDocument terrainDoc) {
            var result = new List<TerrainLayer>();
            var items = terrainDoc.TerrainData.RootItems ?? [];
            CollectVisibleLayers(items, result);
            return result;
        }

        private void CollectVisibleLayers(IEnumerable<TerrainLayerBase> items, List<TerrainLayer> result) {
            foreach (var item in items) {
                if (!item.IsVisible) continue;

                if (item is TerrainLayer layer) {
                    result.Add(layer);
                }
                else if (item is TerrainLayerGroup group) {
                    CollectVisibleLayers(group.Children, result);
                }
            }
        }

        public List<(ushort LandblockId, int VertexIndex, Vector3 Position)> GetAffectedVertices(
            TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable,
            Vector3 position, float radius) {

            radius = (radius * 12f) + 1f;
            var affected = new List<(ushort, int, Vector3)>();
            const float gridSpacing = 24f;
            Vector2 center2D = new Vector2(position.X, position.Y);
            float gridRadius = radius / gridSpacing + 0.5f;
            int centerGX = (int)Math.Round(center2D.X / gridSpacing);
            int centerGY = (int)Math.Round(center2D.Y / gridSpacing);
            int minGX = centerGX - (int)Math.Ceiling(gridRadius);
            int maxGX = centerGX + (int)Math.Ceiling(gridRadius);
            int minGY = centerGY - (int)Math.Ceiling(gridRadius);
            int maxGY = centerGY + (int)Math.Ceiling(gridRadius);
            int mapSize = 255;

            for (int gx = minGX; gx <= maxGX; gx++) {
                for (int gy = minGY; gy <= maxGY; gy++) {
                    if (gx < 0 || gy < 0) continue;
                    Vector2 vert2D = new Vector2(gx * gridSpacing, gy * gridSpacing);
                    if ((vert2D - center2D).Length() > radius) continue;
                    int lbX = gx / 8;
                    int lbY = gy / 8;
                    if (lbX >= mapSize || lbY >= mapSize) continue;
                    int localVX = gx - lbX * 8;
                    int localVY = gy - lbY * 8;
                    if (localVX < 0 || localVX > 8 || localVY < 0 || localVY > 8) continue;
                    int vertexIndex = localVX * 9 + localVY;
                    ushort lbId = (ushort)((lbX << 8) | lbY);
                    float z = GetHeightAtPosition(terrainDoc, docManager, heightTable, vert2D.X, vert2D.Y);
                    Vector3 vertPos = new Vector3(vert2D.X, vert2D.Y, z);
                    affected.Add((lbId, vertexIndex, vertPos));

                    // Edge neighbor handling
                    if (localVX == 0 && lbX > 0) {
                        ushort leftLbId = (ushort)(((lbX - 1) << 8) | lbY);
                        int leftVertexIndex = 8 * 9 + localVY;
                        affected.Add((leftLbId, leftVertexIndex, vertPos));
                    }

                    if (localVX == 8 && lbX < mapSize - 1) {
                        ushort rightLbId = (ushort)(((lbX + 1) << 8) | lbY);
                        int rightVertexIndex = 0 * 9 + localVY;
                        affected.Add((rightLbId, rightVertexIndex, vertPos));
                    }

                    if (localVY == 0 && lbY > 0) {
                        ushort bottomLbId = (ushort)((lbX << 8) | (lbY - 1));
                        int bottomVertexIndex = localVX * 9 + 8;
                        affected.Add((bottomLbId, bottomVertexIndex, vertPos));
                    }

                    if (localVY == 8 && lbY < mapSize - 1) {
                        ushort topLbId = (ushort)((lbX << 8) | (lbY + 1));
                        int topVertexIndex = localVX * 9 + 0;
                        affected.Add((topLbId, topVertexIndex, vertPos));
                    }

                    if (localVX == 0 && localVY == 0 && lbX > 0 && lbY > 0) {
                        ushort diagLbId = (ushort)(((lbX - 1) << 8) | (lbY - 1));
                        int diagVertexIndex = 8 * 9 + 8;
                        affected.Add((diagLbId, diagVertexIndex, vertPos));
                    }

                    if (localVX == 8 && localVY == 0 && lbX < mapSize - 1 && lbY > 0) {
                        ushort diagLbId = (ushort)(((lbX + 1) << 8) | (lbY - 1));
                        int diagVertexIndex = 0 * 9 + 8;
                        affected.Add((diagLbId, diagVertexIndex, vertPos));
                    }

                    if (localVX == 0 && localVY == 8 && lbX > 0 && lbY < mapSize - 1) {
                        ushort diagLbId = (ushort)(((lbX - 1) << 8) | (lbY + 1));
                        int diagVertexIndex = 8 * 9 + 0;
                        affected.Add((diagLbId, diagVertexIndex, vertPos));
                    }

                    if (localVX == 8 && localVY == 8 && lbX < mapSize - 1 && lbY < mapSize - 1) {
                        ushort diagLbId = (ushort)(((lbX + 1) << 8) | (lbY + 1));
                        int diagVertexIndex = 0 * 9 + 0;
                        affected.Add((diagLbId, diagVertexIndex, vertPos));
                    }
                }
            }

            return affected.Distinct().ToList();
        }

        public List<(ushort LandblockId, int VertexIndex, Vector3 Position)> GetVerticesInRect(
            TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable,
            float minX, float minY, float maxX, float maxY) {

            var affected = new List<(ushort, int, Vector3)>();
            const float gridSpacing = 24f;
            int mapSize = 255;

            int minGX = (int)Math.Floor(minX / gridSpacing);
            int maxGX = (int)Math.Ceiling(maxX / gridSpacing);
            int minGY = (int)Math.Floor(minY / gridSpacing);
            int maxGY = (int)Math.Ceiling(maxY / gridSpacing);

            for (int gx = minGX; gx <= maxGX; gx++) {
                for (int gy = minGY; gy <= maxGY; gy++) {
                    if (gx < 0 || gy < 0) continue;
                    int lbX = gx / 8;
                    int lbY = gy / 8;
                    if (lbX >= mapSize || lbY >= mapSize) continue;
                    int localVX = gx - lbX * 8;
                    int localVY = gy - lbY * 8;
                    if (localVX < 0 || localVX > 8 || localVY < 0 || localVY > 8) continue;
                    int vertexIndex = localVX * 9 + localVY;
                    ushort lbId = (ushort)((lbX << 8) | lbY);
                    Vector2 vert2D = new Vector2(gx * gridSpacing, gy * gridSpacing);
                    float z = GetHeightAtPosition(terrainDoc, docManager, heightTable, vert2D.X, vert2D.Y);
                    Vector3 vertPos = new Vector3(vert2D.X, vert2D.Y, z);
                    affected.Add((lbId, vertexIndex, vertPos));

                    // Edge neighbor handling
                    if (localVX == 0 && lbX > 0) {
                        ushort leftLbId = (ushort)(((lbX - 1) << 8) | lbY);
                        affected.Add((leftLbId, 8 * 9 + localVY, vertPos));
                    }
                    if (localVX == 8 && lbX < mapSize - 1) {
                        ushort rightLbId = (ushort)(((lbX + 1) << 8) | lbY);
                        affected.Add((rightLbId, 0 * 9 + localVY, vertPos));
                    }
                    if (localVY == 0 && lbY > 0) {
                        ushort bottomLbId = (ushort)((lbX << 8) | (lbY - 1));
                        affected.Add((bottomLbId, localVX * 9 + 8, vertPos));
                    }
                    if (localVY == 8 && lbY < mapSize - 1) {
                        ushort topLbId = (ushort)((lbX << 8) | (lbY + 1));
                        affected.Add((topLbId, localVX * 9 + 0, vertPos));
                    }
                    if (localVX == 0 && localVY == 0 && lbX > 0 && lbY > 0) {
                        affected.Add(((ushort)(((lbX - 1) << 8) | (lbY - 1)), 8 * 9 + 8, vertPos));
                    }
                    if (localVX == 8 && localVY == 0 && lbX < mapSize - 1 && lbY > 0) {
                        affected.Add(((ushort)(((lbX + 1) << 8) | (lbY - 1)), 0 * 9 + 8, vertPos));
                    }
                    if (localVX == 0 && localVY == 8 && lbX > 0 && lbY < mapSize - 1) {
                        affected.Add(((ushort)(((lbX - 1) << 8) | (lbY + 1)), 8 * 9 + 0, vertPos));
                    }
                    if (localVX == 8 && localVY == 8 && lbX < mapSize - 1 && lbY < mapSize - 1) {
                        affected.Add(((ushort)(((lbX + 1) << 8) | (lbY + 1)), 0 * 9 + 0, vertPos));
                    }
                }
            }

            return affected.Distinct().ToList();
        }

        public float SampleHeightTriangle(TerrainEntry[] data, float[] heightTable,
            float localX, float localY, uint landblockX, uint landblockY) {

            float cellX = localX / CellSize;
            float cellY = localY / CellSize;

            uint cellIndexX = Math.Min((uint)Math.Floor(cellX), LandblockEdgeCellCount - 1);
            uint cellIndexY = Math.Min((uint)Math.Floor(cellY), LandblockEdgeCellCount - 1);

            float fracX = cellX - cellIndexX;
            float fracY = cellY - cellIndexY;

            // Get the four corner heights
            float hSW = GetHeightFromData(data, heightTable, cellIndexX, cellIndexY);
            float hSE = GetHeightFromData(data, heightTable, cellIndexX + 1, cellIndexY);
            float hNW = GetHeightFromData(data, heightTable, cellIndexX, cellIndexY + 1);
            float hNE = GetHeightFromData(data, heightTable, cellIndexX + 1, cellIndexY + 1);

            // Determine triangle split direction using AC's pseudo-random algorithm
            uint globalCellX = landblockX * LandblockEdgeCellCount + cellIndexX;
            uint globalCellY = landblockY * LandblockEdgeCellCount + cellIndexY;
            bool isSWtoNE = IsSWtoNEcut(globalCellX, globalCellY);

            if (isSWtoNE) {
                if (fracX > fracY) {
                    return hSW + fracX * (hSE - hSW) + fracY * (hNE - hSE);
                }
                else {
                    return hSW + fracX * (hNE - hNW) + fracY * (hNW - hSW);
                }
            }
            else {
                if (fracX + fracY <= 1.0f) {
                    return hSW + fracX * (hSE - hSW) + fracY * (hNW - hSW);
                }
                else {
                    return hNE + (1.0f - fracX) * (hNW - hNE) + (1.0f - fracY) * (hSE - hNE);
                }
            }
        }

        public bool IsSWtoNEcut(uint globalCellX, uint globalCellY) {
            uint magicA = (uint)unchecked((int)globalCellX * 214614067 + 1813693831);
            uint magicB = (uint)unchecked((int)globalCellX * 1109124029);
            uint splitDir = unchecked((uint)((int)globalCellY * (int)magicA - (int)magicB - 1369149221));
            return splitDir * 2.3283064e-10 >= 0.5;
        }

        private static float GetHeightFromData(TerrainEntry[] data, float[] heightTable, uint vx, uint vy) {
            vx = Math.Min(vx, 8);
            vy = Math.Min(vy, 8);
            var idx = (int)(vx * 9 + vy);
            return idx < data.Length ? heightTable[data[idx].Height] : 0f;
        }

        public Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> SmoothTerrain(
            TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable,
            Vector3 centerPosition, float brushRadius, float strength,
            Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> pendingChanges) {

            var affected = GetAffectedVertices(terrainDoc, docManager, heightTable, centerPosition, brushRadius);
            var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();

            // First pass: compute the average height of all affected vertices
            double heightSum = 0;
            int heightCount = 0;

            foreach (var (lbId, vIndex, _) in affected) {
                if (!landblockDataCache.TryGetValue(lbId, out var data)) {
                    data = GetLandblockTerrain(terrainDoc, docManager, lbId);
                    if (data == null) continue;
                    landblockDataCache[lbId] = data;
                }

                heightSum += data[vIndex].Height;
                heightCount++;
            }

            if (heightCount == 0) return new Dictionary<ushort, List<(int, byte, byte)>>();

            double avgHeight = heightSum / heightCount;

            // Second pass: blend each vertex toward the average
            var results = new Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>>();

            foreach (var (lbId, vIndex, _) in affected) {
                if (!landblockDataCache.TryGetValue(lbId, out var data)) continue;

                if (pendingChanges.TryGetValue(lbId, out var list) && list.Any(c => c.VertexIndex == vIndex)) continue;

                if (!results.TryGetValue(lbId, out var resultList)) {
                    resultList = new List<(int, byte, byte)>();
                    results[lbId] = resultList;
                }

                byte original = data[vIndex].Height;
                double blended = original + (avgHeight - original) * strength;
                byte newHeight = (byte)Math.Clamp((int)Math.Round(blended), 0, 255);

                if (original == newHeight) continue;

                resultList.Add((vIndex, original, newHeight));
            }

            return results;
        }

        public List<(ushort LbID, int VertexIndex, byte OldType)> FloodFillVertices(
            TerrainDocument terrainDoc, DocumentManager docManager,
            uint startLbX, uint startLbY, uint startCellX, uint startCellY,
            byte newType, HashSet<ushort>? allowedLandblocks = null) {

            var result = new List<(ushort, int, byte)>();
            ushort startLbID = (ushort)((startLbX << 8) | startLbY);

            if (allowedLandblocks != null && !allowedLandblocks.Contains(startLbID))
                return result;

            var startData = GetLandblockTerrain(terrainDoc, docManager, startLbID);
            if (startData == null) return result;

            int startIndex = (int)(startCellX * 9 + startCellY);
            if (startIndex >= startData.Length) return result;

            byte oldType = startData[startIndex].Type;
            if (oldType == newType) return result;

            var visited = new HashSet<(uint lbX, uint lbY, uint cellX, uint cellY)>();
            var queue = new Queue<(uint lbX, uint lbY, uint cellX, uint cellY)>();
            queue.Enqueue((startLbX, startLbY, startCellX, startCellY));

            var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();

            while (queue.Count > 0) {
                var (lbX, lbY, cellX, cellY) = queue.Dequeue();

                if (visited.Contains((lbX, lbY, cellX, cellY))) continue;
                visited.Add((lbX, lbY, cellX, cellY));

                var lbID = (ushort)((lbX << 8) | lbY);

                if (allowedLandblocks != null && !allowedLandblocks.Contains(lbID)) continue;

                if (!landblockDataCache.TryGetValue(lbID, out var data)) {
                    data = GetLandblockTerrain(terrainDoc, docManager, lbID);
                    if (data == null) continue;
                    landblockDataCache[lbID] = data;
                }

                int index = (int)(cellX * 9 + cellY);
                if (index >= data.Length || data[index].Type != oldType) continue;

                result.Add((lbID, index, oldType));

                // Queue neighbors
                if (cellX > 0) queue.Enqueue((lbX, lbY, cellX - 1, cellY));
                else if (lbX > 0) queue.Enqueue((lbX - 1, lbY, 8, cellY));

                if (cellX < 8) queue.Enqueue((lbX, lbY, cellX + 1, cellY));
                else if (lbX < 255) queue.Enqueue((lbX + 1, lbY, 0, cellY));

                if (cellY > 0) queue.Enqueue((lbX, lbY, cellX, cellY - 1));
                else if (lbY > 0) queue.Enqueue((lbX, lbY - 1, cellX, 8));

                if (cellY < 8) queue.Enqueue((lbX, lbY, cellX, cellY + 1));
                else if (lbY < 255) queue.Enqueue((lbX, lbY + 1, cellX, 0));
            }

            return result;
        }

        public Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue, uint OriginalEntryValue, uint NewEntryValue)>> RaiseLowerHeight(
            TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable,
            Vector3 centerPosition, float brushRadius, int strength, bool isLowering,
            Dictionary<ushort, HashSet<int>> processedVertices,
            Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> pendingChanges) {

            var affected = GetAffectedVertices(terrainDoc, docManager, heightTable, centerPosition, brushRadius);
            var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();
            var results = new Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue, uint OriginalEntryValue, uint NewEntryValue)>>();

            int delta = isLowering ? -strength : strength;

            foreach (var (lbId, vIndex, _) in affected) {
                if (!landblockDataCache.TryGetValue(lbId, out var data)) {
                    data = GetLandblockTerrain(terrainDoc, docManager, lbId);
                    if (data == null) continue;
                    landblockDataCache[lbId] = data;
                }

                if (!processedVertices.TryGetValue(lbId, out var processed)) {
                    processed = new HashSet<int>();
                    processedVertices[lbId] = processed;
                }
                if (!processed.Add(vIndex)) continue;

                if (pendingChanges.TryGetValue(lbId, out var list) && list.Any(c => c.VertexIndex == vIndex)) continue;

                if (!results.TryGetValue(lbId, out var resultList)) {
                    resultList = new List<(int, byte, byte, uint, uint)>();
                    results[lbId] = resultList;
                }

                byte original = data[vIndex].Height;
                byte newHeight = (byte)Math.Clamp(original + delta, 0, 255);
                if (original == newHeight) continue;

                var newEntry = data[vIndex] with { Height = newHeight };
                resultList.Add((vIndex, original, newHeight, data[vIndex].ToUInt(), newEntry.ToUInt()));
            }

            return results;
        }

        public Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue, uint OriginalEntryValue, uint NewEntryValue)>> SetHeight(
            TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable,
            Vector3 centerPosition, float brushRadius, byte targetHeight,
            Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> pendingChanges) {

            var affected = GetAffectedVertices(terrainDoc, docManager, heightTable, centerPosition, brushRadius);
            var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();
            var results = new Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue, uint OriginalEntryValue, uint NewEntryValue)>>();

            foreach (var (lbId, vIndex, _) in affected) {
                if (!landblockDataCache.TryGetValue(lbId, out var data)) {
                    data = GetLandblockTerrain(terrainDoc, docManager, lbId);
                    if (data == null) continue;
                    landblockDataCache[lbId] = data;
                }

                if (pendingChanges.TryGetValue(lbId, out var list) && list.Any(c => c.VertexIndex == vIndex)) continue;

                if (!results.TryGetValue(lbId, out var resultList)) {
                    resultList = new List<(int, byte, byte, uint, uint)>();
                    results[lbId] = resultList;
                }

                byte original = data[vIndex].Height;
                if (original == targetHeight) continue;

                var newEntry = data[vIndex] with { Height = targetHeight };
                resultList.Add((vIndex, original, targetHeight, data[vIndex].ToUInt(), newEntry.ToUInt()));
            }

            return results;
        }

        public Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue, uint OriginalEntryValue, uint NewEntryValue)>> PaintTexture(
            TerrainDocument terrainDoc, DocumentManager docManager, float[] heightTable,
            Vector3 centerPosition, float brushRadius, byte newType,
            Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> pendingChanges) {

            var affected = GetAffectedVertices(terrainDoc, docManager, heightTable, centerPosition, brushRadius);
            var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();
            var results = new Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue, uint OriginalEntryValue, uint NewEntryValue)>>();

            foreach (var (lbId, vIndex, _) in affected) {
                if (!landblockDataCache.TryGetValue(lbId, out var data)) {
                    data = GetLandblockTerrain(terrainDoc, docManager, lbId);
                    if (data == null) continue;
                    landblockDataCache[lbId] = data;
                }

                if (pendingChanges.TryGetValue(lbId, out var list) && list.Any(c => c.VertexIndex == vIndex)) continue;

                if (!results.TryGetValue(lbId, out var resultList)) {
                    resultList = new List<(int, byte, byte, uint, uint)>();
                    results[lbId] = resultList;
                }

                byte original = data[vIndex].Type;
                if (original == newType) continue;

                var newEntry = data[vIndex] with { Type = newType };
                resultList.Add((vIndex, original, newType, data[vIndex].ToUInt(), newEntry.ToUInt()));
            }

            return results;
        }

        public Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue, uint OriginalEntryValue, uint NewEntryValue)>> FloodFillPaint(
            TerrainDocument terrainDoc, DocumentManager docManager,
            uint startLbX, uint startLbY, uint startCellX, uint startCellY,
            byte newType, HashSet<ushort>? allowedLandblocks = null) {

            var vertices = FloodFillVertices(terrainDoc, docManager, startLbX, startLbY, startCellX, startCellY, newType, allowedLandblocks);
            var results = new Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue, uint OriginalEntryValue, uint NewEntryValue)>>();
            var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();

            foreach (var (lbId, vIndex, oldType) in vertices) {
                if (!landblockDataCache.TryGetValue(lbId, out var data)) {
                    data = GetLandblockTerrain(terrainDoc, docManager, lbId);
                    if (data == null) continue;
                    landblockDataCache[lbId] = data;
                }

                if (!results.TryGetValue(lbId, out var resultList)) {
                    resultList = new List<(int, byte, byte, uint, uint)>();
                    results[lbId] = resultList;
                }
                var newEntry = data[vIndex] with { Type = newType };
                resultList.Add((vIndex, oldType, newType, data[vIndex].ToUInt(), newEntry.ToUInt()));
            }

            return results;
        }
    }
}
