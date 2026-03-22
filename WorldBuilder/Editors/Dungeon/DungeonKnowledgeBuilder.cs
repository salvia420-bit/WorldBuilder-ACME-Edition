using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text.Json;
using DatReaderWriter.DBObjs;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Editors.Dungeon {

    public static class DungeonKnowledgeBuilder {
        private static readonly string KnowledgePath = Path.Combine(
            System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),
            "ACME WorldBuilder", "dungeon_knowledge.json");

        public static DungeonKnowledgeBase? LoadCached() {
            try {
                if (!File.Exists(KnowledgePath)) return null;
                var json = File.ReadAllText(KnowledgePath);
                var kb = JsonSerializer.Deserialize<DungeonKnowledgeBase>(json, new JsonSerializerOptions {
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                });
                if (kb != null && kb.Version < DungeonKnowledgeBase.CurrentVersion) {
                    Console.WriteLine($"[DungeonKnowledge] Stale knowledge base (v{kb.Version}, need v{DungeonKnowledgeBase.CurrentVersion}) — deleting for rebuild");
                    try { File.Delete(KnowledgePath); } catch { }
                    return null;
                }
                return kb;
            }
            catch { return null; }
        }

        /// <summary>True if the cached KB exists and is up to date.</summary>
        public static bool IsCachedValid() {
            try {
                if (!File.Exists(KnowledgePath)) return false;
                var json = File.ReadAllText(KnowledgePath);
                var kb = JsonSerializer.Deserialize<DungeonKnowledgeBase>(json, new JsonSerializerOptions {
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                });
                return kb != null && kb.Version >= DungeonKnowledgeBase.CurrentVersion && kb.Prefabs.Count >= 100;
            }
            catch { return false; }
        }

        public static void Save(DungeonKnowledgeBase kb) {
            try {
                var dir = Path.GetDirectoryName(KnowledgePath);
                if (dir != null) Directory.CreateDirectory(dir);
                var json = JsonSerializer.Serialize(kb, new JsonSerializerOptions {
                    WriteIndented = true,
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                });
                File.WriteAllText(KnowledgePath, json);
            }
            catch (Exception ex) {
                Console.WriteLine($"[DungeonKnowledge] Save error: {ex.Message}");
            }
        }

        public static DungeonKnowledgeBase Build(IDatReaderWriter dats) {
            Console.WriteLine("[DungeonKnowledge] Building knowledge base from DAT...");

            var edgeCounts = new Dictionary<string, (AdjacencyEdge edge, int count)>();
            var allPrefabs = new List<DungeonPrefab>();
            var prefabSignatures = new Dictionary<string, int>();
            var roomUsage = new Dictionary<(ushort envId, ushort cs), (int count, HashSet<string> dungeonNames, List<ushort> sampleSurfaces)>();

            var lbiIds = GetDungeonLandblockIds(dats);
            Console.WriteLine($"[DungeonKnowledge] Scanning {lbiIds.Length} dungeon landblocks...");

            var dungeonNameLookup = new Dictionary<ushort, string>();
            foreach (var entry in Lib.LocationDatabase.Dungeons) {
                if (!dungeonNameLookup.ContainsKey(entry.LandblockId) && !string.IsNullOrEmpty(entry.Name?.Trim()))
                    dungeonNameLookup[entry.LandblockId] = entry.Name.Trim();
            }

            int dungeonsScanned = 0;
            int totalLbiIds = lbiIds.Length;
            for (int li = 0; li < totalLbiIds; li++) {
                var lbiId = lbiIds[li];
                if (!dats.TryGet<LandBlockInfo>(lbiId, out var lbi) || lbi.NumCells == 0) continue;
                if (lbi.Buildings != null && lbi.Buildings.Count > 0) continue;

                uint lbId = lbiId >> 16;

                var cells = new Dictionary<ushort, EnvCell>();
                for (uint i = 0; i < lbi.NumCells; i++) {
                    ushort cellNum = (ushort)(0x0100 + i);
                    uint cellId = (lbId << 16) | cellNum;
                    if (dats.TryGet<EnvCell>(cellId, out var ec))
                        cells[cellNum] = ec;
                }

                if (cells.Count < 2) continue;
                dungeonsScanned++;

                var lbKey = (ushort)(lbId & 0xFFFF);
                dungeonNameLookup.TryGetValue(lbKey, out var dungeonName);
                foreach (var (_, ec) in cells) {
                    var rk = ((ushort)ec.EnvironmentId, (ushort)ec.CellStructure);
                    if (!roomUsage.TryGetValue(rk, out var ru)) {
                        ru = (0, new HashSet<string>(), new List<ushort>());
                    }
                    ru.count++;
                    if (!string.IsNullOrEmpty(dungeonName)) ru.dungeonNames.Add(dungeonName);
                    var ecSurfaces = ec.Surfaces?.ToList() ?? new List<ushort>();
                    if (ecSurfaces.Count > ru.sampleSurfaces.Count && ecSurfaces.Count > 0)
                        ru.sampleSurfaces = ecSurfaces;
                    roomUsage[rk] = (ru.count, ru.dungeonNames, ru.sampleSurfaces);
                }

                ExtractAdjacencyEdges(cells, edgeCounts);

                if (cells.Count <= 80) {
                    ExtractPrefabs(cells, dats, lbKey, dungeonName ?? "", allPrefabs, prefabSignatures);
                }

                if (dungeonsScanned % 500 == 0)
                    Console.WriteLine($"[DungeonKnowledge] Progress: {dungeonsScanned} dungeons, {edgeCounts.Count} edges, {allPrefabs.Count} prefabs");
            }

            var edges = edgeCounts.Values
                .Select(v => { v.edge.Count = v.count; return v.edge; })
                .OrderByDescending(e => e.Count)
                .ToList();

            var uniquePrefabs = allPrefabs
                .GroupBy(p => p.Signature)
                .Select(g => {
                    var best = g.OrderByDescending(x => x.Cells.Count).First();
                    best.UsageCount = g.Count();
                    return best;
                })
                .OrderByDescending(p => p.UsageCount)
                .Take(2000)
                .ToList();

            var catalog = BuildCatalog(roomUsage, dats);

            PrefabNamer.NameAll(uniquePrefabs, catalog);

            Console.WriteLine($"[DungeonKnowledge] Done: {dungeonsScanned} dungeons, {edges.Count} edges, {uniquePrefabs.Count} prefabs, {catalog.Count} catalog rooms");

            var kb = new DungeonKnowledgeBase {
                Version = DungeonKnowledgeBase.CurrentVersion,
                AnalyzedAt = DateTime.UtcNow,
                DungeonsScanned = dungeonsScanned,
                TotalEdges = edges.Count,
                TotalPrefabs = uniquePrefabs.Count,
                TotalCatalogRooms = catalog.Count,
                Edges = edges,
                Prefabs = uniquePrefabs,
                Catalog = catalog
            };

            Save(kb);
            return kb;
        }

        private static uint[] GetDungeonLandblockIds(IDatReaderWriter dats) {
            var lbiIds = dats.Dats.GetAllIdsOfType<LandBlockInfo>().ToArray();
            if (lbiIds.Length == 0)
                lbiIds = dats.Dats.Cell.GetAllIdsOfType<LandBlockInfo>().ToArray();
            if (lbiIds.Length == 0) {
                var brute = new List<uint>();
                for (uint x = 0; x < 256; x++) {
                    for (uint y = 0; y < 256; y++) {
                        var infoId = ((x << 8) | y) << 16 | 0xFFFE;
                        if (dats.TryGet<LandBlockInfo>(infoId, out var lbi) && lbi.NumCells > 0)
                            brute.Add(infoId);
                    }
                }
                lbiIds = brute.ToArray();
            }
            return lbiIds;
        }

        private static List<CatalogRoom> BuildCatalog(
            Dictionary<(ushort envId, ushort cs), (int count, HashSet<string> dungeonNames, List<ushort> sampleSurfaces)> roomUsage,
            IDatReaderWriter dats) {

            var catalog = new List<CatalogRoom>();
            foreach (var (key, data) in roomUsage) {
                uint envFileId = (uint)(key.envId | 0x0D000000);
                if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) continue;
                if (!env.Cells.TryGetValue(key.cs, out var cellStruct)) continue;

                var portalIds = PortalSnapper.GetPortalPolygonIds(cellStruct);
                int portalCount = portalIds.Count;

                float minX = float.MaxValue, maxX = float.MinValue;
                float minY = float.MaxValue, maxY = float.MinValue;
                float minZ = float.MaxValue, maxZ = float.MinValue;
                if (cellStruct.VertexArray?.Vertices != null) {
                    foreach (var v in cellStruct.VertexArray.Vertices.Values) {
                        if (v.Origin.X < minX) minX = v.Origin.X; if (v.Origin.X > maxX) maxX = v.Origin.X;
                        if (v.Origin.Y < minY) minY = v.Origin.Y; if (v.Origin.Y > maxY) maxY = v.Origin.Y;
                        if (v.Origin.Z < minZ) minZ = v.Origin.Z; if (v.Origin.Z > maxZ) maxZ = v.Origin.Z;
                    }
                }
                float width = maxX - minX, depth = maxY - minY, height = maxZ - minZ;
                if (!float.IsFinite(width)) width = 0;
                if (!float.IsFinite(depth)) depth = 0;
                if (!float.IsFinite(height)) height = 0;

                string category = portalCount switch {
                    0 => "Sealed Room", 1 => "Dead End", 2 => "Corridor",
                    3 => "T-Junction", 4 => "Crossroads", _ => $"{portalCount}-Way Hub"
                };
                float maxDim = MathF.Max(width, depth);
                string size = maxDim < 10 ? "Small" : maxDim < 25 ? "Medium" : "Large";
                string style = PrefabNamer.InferStyle(string.Join(" ", data.dungeonNames));

                catalog.Add(new CatalogRoom {
                    EnvId = key.envId, CellStruct = key.cs,
                    Category = category, Size = size, Style = style,
                    DisplayName = $"{size} {style} {category}",
                    PortalCount = portalCount, UsageCount = data.count,
                    BoundsWidth = width, BoundsDepth = depth, BoundsHeight = height,
                    SourceDungeons = data.dungeonNames.Take(5).OrderBy(n => n).ToList(),
                    SampleSurfaces = data.sampleSurfaces.Take(10).ToList()
                });
            }
            return catalog.OrderByDescending(r => r.UsageCount).ToList();
        }

        private static void ExtractAdjacencyEdges(
            Dictionary<ushort, EnvCell> cells,
            Dictionary<string, (AdjacencyEdge edge, int count)> edgeCounts) {

            foreach (var (cellNum, cell) in cells) {
                if (cell.CellPortals == null) continue;
                foreach (var portal in cell.CellPortals) {
                    if (!cells.TryGetValue(portal.OtherCellId, out var otherCell)) continue;
                    var envA = (ushort)cell.EnvironmentId;
                    var csA = (ushort)cell.CellStructure;
                    var envB = (ushort)otherCell.EnvironmentId;
                    var csB = (ushort)otherCell.CellStructure;

                    string key = envA < envB || (envA == envB && csA <= csB)
                        ? $"{envA:X4}_{csA}_{portal.PolygonId:X4}->{envB:X4}_{csB}_{portal.OtherPortalId:X4}"
                        : $"{envB:X4}_{csB}_{portal.OtherPortalId:X4}->{envA:X4}_{csA}_{portal.PolygonId:X4}";

                    if (!edgeCounts.TryGetValue(key, out var existing)) {
                        var invCellRot = Quaternion.Conjugate(cell.Position.Orientation);
                        var relOffset = Vector3.Transform(otherCell.Position.Origin - cell.Position.Origin, invCellRot);
                        var relRot = Quaternion.Normalize(invCellRot * otherCell.Position.Orientation);
                        existing = (new AdjacencyEdge {
                            EnvIdA = envA, CellStructA = csA, PolyIdA = (ushort)portal.PolygonId,
                            EnvIdB = envB, CellStructB = csB, PolyIdB = (ushort)portal.OtherPortalId,
                            RelOffsetX = relOffset.X, RelOffsetY = relOffset.Y, RelOffsetZ = relOffset.Z,
                            RelRotX = relRot.X, RelRotY = relRot.Y, RelRotZ = relRot.Z, RelRotW = relRot.W,
                        }, 0);
                    }
                    edgeCounts[key] = (existing.edge, existing.count + 1);
                }
            }
        }

        private static void ExtractPrefabs(
            Dictionary<ushort, EnvCell> cells,
            IDatReaderWriter dats,
            ushort sourceLandblock,
            string dungeonName,
            List<DungeonPrefab> allPrefabs,
            Dictionary<string, int> prefabSignatures) {

            if (cells.Count < 2 || cells.Count > 80) return;
            if (allPrefabs.Count > 200000) return;

            var adj = new Dictionary<ushort, List<(ushort neighbor, ushort myPoly, ushort theirPoly)>>();
            foreach (var (cellNum, cell) in cells) {
                adj[cellNum] = new List<(ushort, ushort, ushort)>();
                if (cell.CellPortals == null) continue;
                foreach (var portal in cell.CellPortals) {
                    if (cells.ContainsKey(portal.OtherCellId))
                        adj[cellNum].Add((portal.OtherCellId, (ushort)portal.PolygonId, (ushort)portal.OtherPortalId));
                }
            }

            int perDungeonCount = 0;
            int perDungeonCap = 50;

            foreach (var (startCell, _) in cells) {
                if (!adj.TryGetValue(startCell, out var neighbors)) continue;
                if (perDungeonCount >= perDungeonCap) break;

                foreach (var (n1, _, _) in neighbors) {
                    if (perDungeonCount >= perDungeonCap) break;
                    TryAddPrefab(cells, dats, adj, new[] { startCell, n1 }, sourceLandblock, dungeonName,
                        allPrefabs, prefabSignatures, 20, ref perDungeonCount);

                    if (!adj.TryGetValue(n1, out var n1Neighbors)) continue;
                    foreach (var (n2, _, _) in n1Neighbors) {
                        if (n2 == startCell) continue;
                        if (perDungeonCount >= perDungeonCap) break;
                        TryAddPrefab(cells, dats, adj, new[] { startCell, n1, n2 }, sourceLandblock, dungeonName,
                            allPrefabs, prefabSignatures, 10, ref perDungeonCount);
                    }
                }
            }

            foreach (var (startCell, _) in cells) {
                if (!adj.TryGetValue(startCell, out var neighbors)) continue;
                if (perDungeonCount >= perDungeonCap) break;

                foreach (var (n1, _, _) in neighbors) {
                    if (perDungeonCount >= perDungeonCap) break;
                    var chain = new List<ushort> { startCell, n1 };
                    var visited = new HashSet<ushort> { startCell, n1 };

                    for (int step = 0; step < 4 && perDungeonCount < perDungeonCap; step++) {
                        var last = chain[^1];
                        if (!adj.TryGetValue(last, out var lastNeighbors)) break;

                        var next = lastNeighbors.FirstOrDefault(n => !visited.Contains(n.neighbor));
                        if (next.neighbor == 0 && !cells.ContainsKey(0)) break;
                        if (visited.Contains(next.neighbor)) break;

                        chain.Add(next.neighbor);
                        visited.Add(next.neighbor);

                        if (chain.Count >= 4) {
                            TryAddPrefab(cells, dats, adj, chain.ToArray(), sourceLandblock, dungeonName,
                                allPrefabs, prefabSignatures, 5, ref perDungeonCount);
                        }
                    }
                }
            }

            if (cells.Count >= 5 && cells.Count <= 15) {
                var allCellNums = cells.Keys.ToArray();
                TryAddPrefab(cells, dats, adj, allCellNums, sourceLandblock, dungeonName,
                    allPrefabs, prefabSignatures, 1, ref perDungeonCount);
            }
        }

        private static void TryAddPrefab(
            Dictionary<ushort, EnvCell> cells, IDatReaderWriter dats,
            Dictionary<ushort, List<(ushort neighbor, ushort myPoly, ushort theirPoly)>> adj,
            ushort[] cellNums, ushort sourceLandblock, string dungeonName,
            List<DungeonPrefab> allPrefabs, Dictionary<string, int> prefabSignatures,
            int maxSigCount, ref int perDungeonCount) {

            if (allPrefabs.Count > 200000) return;
            var prefab = BuildPrefab(cells, dats, adj, cellNums, sourceLandblock);
            if (prefab == null) return;
            prefab.SourceDungeonName = dungeonName;

            prefabSignatures.TryGetValue(prefab.Signature, out var sigCount);
            if (sigCount < maxSigCount) {
                allPrefabs.Add(prefab);
                prefabSignatures[prefab.Signature] = sigCount + 1;
                perDungeonCount++;
            }
        }

        private static DungeonPrefab? BuildPrefab(
            Dictionary<ushort, EnvCell> allCells,
            IDatReaderWriter dats,
            Dictionary<ushort, List<(ushort neighbor, ushort myPoly, ushort theirPoly)>> adj,
            ushort[] cellNums,
            ushort sourceLandblock) {

            var cellSet = new HashSet<ushort>(cellNums);
            var firstCell = allCells[cellNums[0]];
            var originPos = firstCell.Position.Origin;
            var originRot = firstCell.Position.Orientation;
            var invRot = Quaternion.Conjugate(originRot);

            var prefab = new DungeonPrefab { SourceLandblock = sourceLandblock };
            var cellIndexMap = new Dictionary<ushort, int>();

            for (int i = 0; i < cellNums.Length; i++) {
                var cn = cellNums[i];
                var ec = allCells[cn];
                cellIndexMap[cn] = i;

                var relPos = Vector3.Transform(ec.Position.Origin - originPos, invRot);
                var relRot = Quaternion.Normalize(invRot * ec.Position.Orientation);
                int portalCount = ec.CellPortals?.Count ?? 0;

                prefab.Cells.Add(new PrefabCell {
                    LocalIndex = i,
                    EnvId = (ushort)ec.EnvironmentId,
                    CellStruct = (ushort)ec.CellStructure,
                    PortalCount = portalCount,
                    OffsetX = relPos.X, OffsetY = relPos.Y, OffsetZ = relPos.Z,
                    RotX = relRot.X, RotY = relRot.Y, RotZ = relRot.Z, RotW = relRot.W,
                    Surfaces = ec.Surfaces != null ? ec.Surfaces.ToList() : new List<ushort>()
                });
            }

            foreach (var cn in cellNums) {
                if (!adj.TryGetValue(cn, out var neighbors)) continue;
                int myIdx = cellIndexMap[cn];
                var ec = allCells[cn];

                foreach (var (neighbor, myPoly, theirPoly) in neighbors) {
                    if (cellSet.Contains(neighbor)) {
                        int otherIdx = cellIndexMap[neighbor];
                        if (myIdx < otherIdx) {
                            prefab.InternalPortals.Add(new PrefabPortal {
                                CellIndexA = myIdx, PolyIdA = myPoly,
                                CellIndexB = otherIdx, PolyIdB = theirPoly
                            });
                        }
                    }
                    else {
                        float nx = 0, ny = 0, nz = 0;
                        uint envFileId = (uint)(ec.EnvironmentId | 0x0D000000);
                        if (dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env) &&
                            env.Cells.TryGetValue((ushort)ec.CellStructure, out var cs)) {
                            var geom = PortalSnapper.GetPortalGeometry(cs, myPoly);
                            if (geom != null) {
                                var cellRot = Quaternion.Normalize(new Quaternion(
                                    prefab.Cells[myIdx].RotX, prefab.Cells[myIdx].RotY,
                                    prefab.Cells[myIdx].RotZ, prefab.Cells[myIdx].RotW));
                                var worldNormal = Vector3.Transform(geom.Value.Normal, cellRot);
                                nx = worldNormal.X; ny = worldNormal.Y; nz = worldNormal.Z;
                            }
                        }

                        prefab.OpenFaces.Add(new PrefabOpenFace {
                            CellIndex = myIdx, PolyId = myPoly,
                            EnvId = (ushort)ec.EnvironmentId,
                            CellStruct = (ushort)ec.CellStructure,
                            NormalX = nx, NormalY = ny, NormalZ = nz
                        });
                    }
                }
            }

            var sig = string.Join("|",
                prefab.Cells.OrderBy(c => c.EnvId).ThenBy(c => c.CellStruct)
                    .Select(c => $"{c.EnvId:X4}_{c.CellStruct}")) +
                $"_P{prefab.InternalPortals.Count}_O{prefab.OpenFaces.Count}";
            prefab.Signature = sig;

            if (prefab.Cells.Count < 2) return null;
            return prefab;
        }
    }
}
