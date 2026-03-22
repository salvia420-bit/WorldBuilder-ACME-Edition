using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Types;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Editors.Dungeon {

    public record GeneratorParams {
        /// <summary>Target number of prefabs (multi-cell pieces) to place, not individual cells.</summary>
        public int PrefabCount { get; init; } = 10;
        public string Style { get; init; } = "All";
        public int Seed { get; init; } = 0;
        public bool RequireRoof { get; init; } = true;
        public bool AllowVertical { get; init; } = false;
        public bool LockStyle { get; init; } = true;
    }

    /// <summary>
    /// Generates dungeons by chaining prefabs using proven portal transforms from real game data.
    /// Connections use the exact relative offsets/rotations observed in actual AC dungeons,
    /// falling back to geometric snap only when no proven data exists.
    /// </summary>
    public static class DungeonGenerator {

        private const float OverlapMinDist = 3.0f;

        public static DungeonDocument? Generate(
            GeneratorParams p,
            List<RoomEntry> availableRooms,
            IDatReaderWriter dats,
            ushort landblockKey) {

            var rng = p.Seed != 0 ? new Random(p.Seed) : new Random();
            int targetPrefabs = p.PrefabCount;

            var kb = DungeonKnowledgeBuilder.LoadCached();
            if (kb == null || kb.Prefabs.Count == 0) {
                Console.WriteLine("[DungeonGen] No knowledge base — run Analyze Rooms first");
                return null;
            }

            var portalIndex = PortalCompatibilityIndex.Build(kb);
            var geoCache = new PortalGeometryCache(dats);

            // Vertical direction labels to exclude when AllowVertical is false
            var verticalDirs = new HashSet<string> { "Up", "Down" };

            bool PassesFilters(DungeonPrefab pf) {
                if (pf.OpenFaces.Count < 1) return false;
                if (p.RequireRoof && pf.HasNoRoof) return false;
                if (!p.AllowVertical && pf.OpenFaceDirections.Any(d => verticalDirs.Contains(d))) return false;
                return true;
            }

            var candidates = kb.Prefabs
                .Where(pf => p.Style == "All" || pf.Style.Equals(p.Style, StringComparison.OrdinalIgnoreCase))
                .Where(PassesFilters)
                .OrderByDescending(pf => pf.UsageCount)
                .Take(500)
                .ToList();

            // If RequireRoof was too strict, relax to allow partial roof
            if (candidates.Count < 20 && p.RequireRoof) {
                candidates = kb.Prefabs
                    .Where(pf => p.Style == "All" || pf.Style.Equals(p.Style, StringComparison.OrdinalIgnoreCase))
                    .Where(pf => pf.OpenFaces.Count >= 1 && !pf.HasNoRoof)
                    .Where(pf => p.AllowVertical || !pf.OpenFaceDirections.Any(d => verticalDirs.Contains(d)))
                    .OrderByDescending(pf => pf.UsageCount)
                    .Take(500)
                    .ToList();
            }

            if (candidates.Count == 0) {
                candidates = kb.Prefabs
                    .Where(pf => pf.OpenFaces.Count >= 1)
                    .OrderByDescending(pf => pf.UsageCount)
                    .Take(500)
                    .ToList();
            }

            if (candidates.Count == 0) {
                Console.WriteLine("[DungeonGen] No suitable prefabs");
                return null;
            }

            // When style is "All" and LockStyle is on, pick the starter first then
            // lock candidates to its style so the dungeon looks consistent.
            string? lockedStyle = null;

            var connectors = candidates.Where(pf => pf.OpenFaces.Count >= 2).ToList();
            var caps = candidates.Where(pf => pf.OpenFaces.Count == 1).ToList();

            var starter = connectors.Count > 0
                ? connectors[rng.Next(connectors.Count)]
                : candidates[rng.Next(candidates.Count)];

            if (p.LockStyle && p.Style == "All" && !string.IsNullOrEmpty(starter.Style)) {
                lockedStyle = starter.Style;
                candidates = candidates.Where(pf =>
                    pf.Style.Equals(lockedStyle, StringComparison.OrdinalIgnoreCase) ||
                    string.IsNullOrEmpty(pf.Style)).ToList();
                connectors = candidates.Where(pf => pf.OpenFaces.Count >= 2).ToList();
                caps = candidates.Where(pf => pf.OpenFaces.Count == 1).ToList();

                // If locking cut candidates too aggressively, pull from full pool
                if (candidates.Count < 10) {
                    lockedStyle = null;
                    candidates = kb.Prefabs
                        .Where(PassesFilters)
                        .OrderByDescending(pf => pf.UsageCount)
                        .Take(500)
                        .ToList();
                    connectors = candidates.Where(pf => pf.OpenFaces.Count >= 2).ToList();
                    caps = candidates.Where(pf => pf.OpenFaces.Count == 1).ToList();
                }
            }

            var prefabsByRoomType = new Dictionary<(ushort envId, ushort cs), List<DungeonPrefab>>();
            foreach (var pf in candidates) {
                foreach (var of in pf.OpenFaces) {
                    var key = (of.EnvId, of.CellStruct);
                    if (!prefabsByRoomType.TryGetValue(key, out var list)) {
                        list = new List<DungeonPrefab>();
                        prefabsByRoomType[key] = list;
                    }
                    if (!list.Contains(pf)) list.Add(pf);
                }
            }

            Console.WriteLine($"[DungeonGen] Starter: {starter.DisplayName} ({starter.Cells.Count} cells, {starter.OpenFaces.Count} exits), style={lockedStyle ?? "mixed"}, candidates={candidates.Count}, index has {portalIndex.PortalFaceCount} portal faces");

            var doc = new DungeonDocument(new Microsoft.Extensions.Logging.Abstractions.NullLogger<DungeonDocument>());
            doc.SetLandblockKey(landblockKey);

            var placedCellNums = PlacePrefabAtOrigin(doc, dats, starter);
            int totalCells = placedCellNums.Count;

            // Track placed cell positions for overlap detection
            var placedPositions = new List<Vector3>();
            foreach (var cn in placedCellNums) {
                var c = doc.GetCell(cn);
                if (c != null) placedPositions.Add(c.Origin);
            }

            var frontier = new List<(ushort cellNum, ushort polyId, ushort envId, ushort cellStruct)>();
            CollectOpenFaces(doc, dats, frontier, p.AllowVertical ? null : geoCache);

            int maxAttempts = targetPrefabs * 20;
            int attempts = 0;
            int prefabsPlaced = 1;
            int indexedPlacements = 0;
            int overlapRejects = 0;
            int geoRejects = 0;

            while (prefabsPlaced < targetPrefabs && frontier.Count > 0 && attempts < maxAttempts) {
                attempts++;

                int fi = rng.Next(frontier.Count);
                var (existingCellNum, existingPolyId, existingEnvId, existingCS) = frontier[fi];

                bool wantCap = prefabsPlaced >= targetPrefabs - 2;

                // Edge-guided: find prefabs proven to connect at this portal face
                DungeonPrefab? chosen = null;
                CompatibleRoom? matchedRoom = null;

                var compatible = portalIndex.GetCompatible(existingEnvId, existingCS, existingPolyId);
                if (compatible.Count > 0) {
                    var matchingPrefabs = new List<(DungeonPrefab prefab, CompatibleRoom room, int weight)>();
                    foreach (var cr in compatible) {
                        if (!geoCache.AreCompatible(existingEnvId, existingCS, existingPolyId,
                                cr.EnvId, cr.CellStruct, cr.PolyId)) {
                            continue;
                        }

                        var roomKey = (cr.EnvId, cr.CellStruct);
                        if (prefabsByRoomType.TryGetValue(roomKey, out var pfs)) {
                            foreach (var pf in pfs) {
                                if (wantCap && pf.OpenFaces.Count > 1) continue;
                                bool hasFace = pf.OpenFaces.Any(of =>
                                    of.EnvId == cr.EnvId && of.CellStruct == cr.CellStruct);
                                if (!hasFace) continue;
                                matchingPrefabs.Add((pf, cr, cr.Count));
                            }
                        }
                    }

                    if (matchingPrefabs.Count > 0) {
                        int totalWeight = matchingPrefabs.Sum(m => m.weight);
                        int roll = rng.Next(totalWeight);
                        int acc = 0;
                        foreach (var (pf, cr, w) in matchingPrefabs) {
                            acc += w;
                            if (roll < acc) {
                                chosen = pf;
                                matchedRoom = cr;
                                break;
                            }
                        }
                    }
                }

                if (chosen == null) {
                    // No edge-guided match found. Try a few random candidates
                    // before giving up on this frontier entry.
                    var pool = (wantCap && caps.Count > 0) ? caps :
                               (connectors.Count > 0 ? connectors : candidates);
                    int retries = Math.Min(5, pool.Count);
                    List<ushort>? fallbackResult = null;
                    for (int r = 0; r < retries; r++) {
                        var candidate = pool[rng.Next(pool.Count)];
                        fallbackResult = TryAttachPrefab(doc, dats, portalIndex, geoCache,
                            existingCellNum, existingPolyId, candidate, null, placedPositions);
                        if (fallbackResult != null && fallbackResult.Count > 0) {
                            chosen = candidate;
                            break;
                        }
                    }
                    if (fallbackResult == null || fallbackResult.Count == 0) {
                        frontier.RemoveAt(fi);
                        continue;
                    }

                    totalCells += fallbackResult.Count;
                    prefabsPlaced++;
                    foreach (var cn in fallbackResult) {
                        var c = doc.GetCell(cn);
                        if (c != null) placedPositions.Add(c.Origin);
                    }
                    frontier.Clear();
                    CollectOpenFaces(doc, dats, frontier, p.AllowVertical ? null : geoCache);
                    continue;
                }

                var result = TryAttachPrefab(doc, dats, portalIndex, geoCache,
                    existingCellNum, existingPolyId, chosen, matchedRoom, placedPositions);

                if (result == null || result.Count == 0) {
                    frontier.RemoveAt(fi);
                    continue;
                }

                totalCells += result.Count;
                prefabsPlaced++;
                if (matchedRoom != null) indexedPlacements++;

                foreach (var cn in result) {
                    var c = doc.GetCell(cn);
                    if (c != null) placedPositions.Add(c.Origin);
                }

                frontier.Clear();
                CollectOpenFaces(doc, dats, frontier, p.AllowVertical ? null : geoCache);
            }

            Console.WriteLine($"[DungeonGen] Placed {prefabsPlaced} prefabs, {totalCells} total cells " +
                $"({frontier.Count} open exits, {attempts} attempts, {indexedPlacements} edge-guided, " +
                $"{overlapRejects} overlap rejects, {geoRejects} geo rejects)");

            // Post-generation: retexture cells to match the target style
            string retextureStyle = lockedStyle ?? (p.Style != "All" ? p.Style : null);
            if (retextureStyle != null) {
                int retextured = RetextureCells(doc, dats, kb, retextureStyle);
                Console.WriteLine($"[DungeonGen] Retextured {retextured}/{doc.Cells.Count} cells for style '{retextureStyle}'");
            }

            doc.ComputeVisibleCells();
            return doc;
        }

        private static List<ushort> PlacePrefabAtOrigin(DungeonDocument doc, IDatReaderWriter dats, DungeonPrefab prefab) {
            var cellMap = new Dictionary<int, ushort>();

            var first = prefab.Cells[0];
            var firstCellNum = doc.AddCell(first.EnvId, first.CellStruct,
                Vector3.Zero, Quaternion.Identity, first.Surfaces.ToList());
            cellMap[0] = firstCellNum;

            PlaceRemainingCells(doc, dats, prefab, cellMap);

            return cellMap.Values.ToList();
        }

        /// <summary>
        /// Try to attach a prefab to an existing cell's open portal.
        /// Uses proven transforms from real game data when available.
        /// </summary>
        private static List<ushort>? TryAttachPrefab(
            DungeonDocument doc, IDatReaderWriter dats,
            PortalCompatibilityIndex portalIndex, PortalGeometryCache geoCache,
            ushort existingCellNum, ushort existingPolyId,
            DungeonPrefab prefab, CompatibleRoom? matchedRoom,
            List<Vector3> placedPositions) {

            var existingCell = doc.GetCell(existingCellNum);
            if (existingCell == null) return null;

            // Strategy 1: Use proven transform from the compatibility index
            if (matchedRoom != null) {
                var result = TryAttachWithProvenTransform(doc, dats, geoCache,
                    existingCell, existingCellNum, existingPolyId,
                    prefab, matchedRoom, placedPositions);
                if (result != null) return result;
            }

            // Strategy 2: Search the compatibility index for ANY matching open face
            foreach (var openFace in prefab.OpenFaces) {
                var match = portalIndex.FindMatch(
                    existingCell.EnvironmentId, existingCell.CellStructure, existingPolyId,
                    openFace.EnvId, openFace.CellStruct);

                if (match != null) {
                    if (!geoCache.AreCompatible(
                        existingCell.EnvironmentId, existingCell.CellStructure, existingPolyId,
                        openFace.EnvId, openFace.CellStruct, match.PolyId))
                        continue;

                    var newOrigin = existingCell.Origin + Vector3.Transform(match.RelOffset, existingCell.Orientation);
                    var newRot = Quaternion.Normalize(existingCell.Orientation * match.RelRot);

                    if (WouldOverlap(newOrigin, placedPositions, prefab, openFace.CellIndex, newRot))
                        continue;

                    var cellMap = new Dictionary<int, ushort>();
                    var connectCellNum = doc.AddCell(openFace.EnvId, openFace.CellStruct,
                        newOrigin, newRot,
                        prefab.Cells[openFace.CellIndex].Surfaces.ToList());
                    cellMap[openFace.CellIndex] = connectCellNum;
                    doc.ConnectPortals(existingCellNum, existingPolyId, connectCellNum, match.PolyId);
                    PlaceRemainingCells(doc, dats, prefab, cellMap);
                    return cellMap.Values.ToList();
                }
            }

            // Strategy 3: Geometric snap fallback (only for portals with matching geometry)
            return TryAttachWithGeometricSnap(doc, dats, geoCache,
                existingCell, existingCellNum, existingPolyId,
                prefab, placedPositions);
        }

        /// <summary>
        /// Attach using a proven cell-to-cell transform from the PortalCompatibilityIndex.
        /// This uses the exact relative offset and rotation observed in real game dungeons.
        /// </summary>
        private static List<ushort>? TryAttachWithProvenTransform(
            DungeonDocument doc, IDatReaderWriter dats, PortalGeometryCache geoCache,
            DungeonCellData existingCell, ushort existingCellNum, ushort existingPolyId,
            DungeonPrefab prefab, CompatibleRoom matchedRoom,
            List<Vector3> placedPositions) {

            // Find the open face on the prefab that matches the proven room type
            PrefabOpenFace? connectingFace = null;
            foreach (var of in prefab.OpenFaces) {
                if (of.EnvId == matchedRoom.EnvId && of.CellStruct == matchedRoom.CellStruct) {
                    connectingFace = of;
                    break;
                }
            }
            if (connectingFace == null) return null;

            var newOrigin = existingCell.Origin + Vector3.Transform(matchedRoom.RelOffset, existingCell.Orientation);
            var newRot = Quaternion.Normalize(existingCell.Orientation * matchedRoom.RelRot);

            if (WouldOverlap(newOrigin, placedPositions, prefab, connectingFace.CellIndex, newRot))
                return null;

            var cellMap = new Dictionary<int, ushort>();
            var prefabCell = prefab.Cells[connectingFace.CellIndex];
            var connectCellNum = doc.AddCell(prefabCell.EnvId, prefabCell.CellStruct,
                newOrigin, newRot, prefabCell.Surfaces.ToList());
            cellMap[connectingFace.CellIndex] = connectCellNum;

            doc.ConnectPortals(existingCellNum, existingPolyId, connectCellNum, matchedRoom.PolyId);

            PlaceRemainingCells(doc, dats, prefab, cellMap);
            return cellMap.Values.ToList();
        }

        /// <summary>
        /// Fallback: use geometric portal snap when no proven transform exists.
        /// Only used for connections not found in the knowledge base.
        /// </summary>
        private static List<ushort>? TryAttachWithGeometricSnap(
            DungeonDocument doc, IDatReaderWriter dats, PortalGeometryCache geoCache,
            DungeonCellData existingCell, ushort existingCellNum, ushort existingPolyId,
            DungeonPrefab prefab, List<Vector3> placedPositions) {

            uint existingEnvFileId = (uint)(existingCell.EnvironmentId | 0x0D000000);
            if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(existingEnvFileId, out var existingEnv)) return null;
            if (!existingEnv.Cells.TryGetValue(existingCell.CellStructure, out var existingCS)) return null;

            var targetGeom = PortalSnapper.GetPortalGeometry(existingCS, existingPolyId);
            if (targetGeom == null) return null;

            var (targetCentroid, targetNormal) = PortalSnapper.TransformPortalToWorld(
                targetGeom.Value, existingCell.Origin, existingCell.Orientation);

            foreach (var openFace in prefab.OpenFaces) {
                var prefabCell = prefab.Cells[openFace.CellIndex];
                uint prefabEnvFileId = (uint)(prefabCell.EnvId | 0x0D000000);
                if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(prefabEnvFileId, out var prefabEnv)) continue;
                if (!prefabEnv.Cells.TryGetValue(prefabCell.CellStruct, out var prefabCS)) continue;

                if (!geoCache.AreCompatible(
                    existingCell.EnvironmentId, existingCell.CellStructure, existingPolyId,
                    prefabCell.EnvId, prefabCell.CellStruct, openFace.PolyId))
                    continue;

                var sourceGeom = PortalSnapper.GetPortalGeometry(prefabCS, openFace.PolyId);
                if (sourceGeom == null) continue;

                var (snapOrigin, snapRot) = PortalSnapper.ComputeSnapTransform(
                    targetCentroid, targetNormal, sourceGeom.Value);

                if (WouldOverlap(snapOrigin, placedPositions, prefab, openFace.CellIndex, snapRot))
                    continue;

                var cellMap = new Dictionary<int, ushort>();
                var connectCellNum = doc.AddCell(prefabCell.EnvId, prefabCell.CellStruct,
                    snapOrigin, snapRot, prefabCell.Surfaces.ToList());
                cellMap[openFace.CellIndex] = connectCellNum;

                doc.ConnectPortals(existingCellNum, existingPolyId, connectCellNum, openFace.PolyId);
                PlaceRemainingCells(doc, dats, prefab, cellMap);

                return cellMap.Values.ToList();
            }

            return null;
        }

        /// <summary>
        /// Check if placing a prefab at the given position would overlap existing cells.
        /// Uses a distance check on cell origins to detect gross overlaps.
        /// </summary>
        private static bool WouldOverlap(Vector3 connectOrigin, List<Vector3> existing,
            DungeonPrefab prefab, int connectCellIdx, Quaternion connectRot) {

            if (existing.Count == 0) return false;

            var connectPC = prefab.Cells[connectCellIdx];
            var connectOffset = new Vector3(connectPC.OffsetX, connectPC.OffsetY, connectPC.OffsetZ);
            var connectRelRot = Quaternion.Normalize(new Quaternion(connectPC.RotX, connectPC.RotY, connectPC.RotZ, connectPC.RotW));

            Quaternion invRelRot = connectRelRot.LengthSquared() > 0.01f ? Quaternion.Inverse(connectRelRot) : Quaternion.Identity;
            var worldBaseRot = Quaternion.Normalize(connectRot * invRelRot);
            var worldBaseOrigin = connectOrigin - Vector3.Transform(connectOffset, worldBaseRot);

            for (int i = 0; i < prefab.Cells.Count; i++) {
                var pc = prefab.Cells[i];
                Vector3 cellWorldPos;
                if (i == connectCellIdx) {
                    cellWorldPos = connectOrigin;
                }
                else {
                    var offset = new Vector3(pc.OffsetX, pc.OffsetY, pc.OffsetZ);
                    cellWorldPos = worldBaseOrigin + Vector3.Transform(offset, worldBaseRot);
                }

                foreach (var ep in existing) {
                    float dist = (cellWorldPos - ep).Length();
                    if (dist < OverlapMinDist) return true;
                }
            }

            return false;
        }

        private static void PlaceRemainingCells(
            DungeonDocument doc, IDatReaderWriter dats,
            DungeonPrefab prefab, Dictionary<int, ushort> cellMap) {

            int baseIdx = cellMap.Keys.First();
            var baseCellNum = cellMap[baseIdx];
            var baseDoc = doc.GetCell(baseCellNum);
            if (baseDoc == null) return;

            var basePC = prefab.Cells[baseIdx];
            var baseOffset = new Vector3(basePC.OffsetX, basePC.OffsetY, basePC.OffsetZ);
            var baseRelRot = Quaternion.Normalize(new Quaternion(basePC.RotX, basePC.RotY, basePC.RotZ, basePC.RotW));

            Quaternion invBaseRelRot = baseRelRot.LengthSquared() > 0.01f ? Quaternion.Inverse(baseRelRot) : Quaternion.Identity;
            var worldBaseRot = Quaternion.Normalize(baseDoc.Orientation * invBaseRelRot);
            var worldBaseOrigin = baseDoc.Origin - Vector3.Transform(baseOffset, worldBaseRot);

            for (int i = 0; i < prefab.Cells.Count; i++) {
                if (cellMap.ContainsKey(i)) continue;

                var pc = prefab.Cells[i];
                var offset = new Vector3(pc.OffsetX, pc.OffsetY, pc.OffsetZ);
                var relRot = Quaternion.Normalize(new Quaternion(pc.RotX, pc.RotY, pc.RotZ, pc.RotW));

                var worldOrigin = worldBaseOrigin + Vector3.Transform(offset, worldBaseRot);
                var worldRot = Quaternion.Normalize(worldBaseRot * relRot);

                var newCellNum = doc.AddCell(pc.EnvId, pc.CellStruct,
                    worldOrigin, worldRot, pc.Surfaces.ToList());
                cellMap[i] = newCellNum;
            }

            foreach (var ip in prefab.InternalPortals) {
                if (cellMap.TryGetValue(ip.CellIndexA, out var cellA) && cellMap.TryGetValue(ip.CellIndexB, out var cellB)) {
                    doc.ConnectPortals(cellA, ip.PolyIdA, cellB, ip.PolyIdB);
                }
            }
        }

        /// <param name="geoCache">When non-null, skip portals with vertical normals (Up/Down).</param>
        private static void CollectOpenFaces(
            DungeonDocument doc, IDatReaderWriter dats,
            List<(ushort cellNum, ushort polyId, ushort envId, ushort cellStruct)> frontier,
            PortalGeometryCache? skipVerticalGeoCache = null) {

            foreach (var dc in doc.Cells) {
                uint envFileId = (uint)(dc.EnvironmentId | 0x0D000000);
                if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) continue;
                if (!env.Cells.TryGetValue(dc.CellStructure, out var cs)) continue;

                var allPortals = PortalSnapper.GetPortalPolygonIds(cs);
                var connected = new HashSet<ushort>(dc.CellPortals.Select(cp => cp.PolygonId));

                foreach (var pid in allPortals) {
                    if (connected.Contains(pid)) continue;

                    if (skipVerticalGeoCache != null) {
                        var geom = PortalSnapper.GetPortalGeometry(cs, pid);
                        if (geom != null) {
                            var worldNormal = Vector3.Transform(geom.Value.Normal, dc.Orientation);
                            if (MathF.Abs(worldNormal.Z) > 0.7f) continue;
                        }
                    }

                    frontier.Add((dc.CellNumber, pid, dc.EnvironmentId, dc.CellStructure));
                }
            }
        }

        /// <summary>
        /// Retexture all cells in the document to use surfaces matching the target style.
        /// For each cell, looks up the catalog for a room of the same geometry + style.
        /// If found and surface slot count matches, replaces the cell's surfaces.
        /// Falls back to a style-wide "dominant palette" for cells without a direct match.
        /// </summary>
        private static int RetextureCells(DungeonDocument doc, IDatReaderWriter dats,
            DungeonKnowledgeBase kb, string style) {

            // Build lookup: (envId, cellStruct) → surfaces for the target style
            var styleSurfaces = new Dictionary<(ushort, ushort), List<ushort>>();
            foreach (var cr in kb.Catalog) {
                if (!cr.Style.Equals(style, StringComparison.OrdinalIgnoreCase)) continue;
                if (cr.SampleSurfaces.Count == 0) continue;
                var key = (cr.EnvId, cr.CellStruct);
                if (!styleSurfaces.ContainsKey(key))
                    styleSurfaces[key] = cr.SampleSurfaces;
            }

            // Build a fallback palette: for each required slot count, collect
            // the most common surface ID at each slot position across the style.
            var surfacesBySlotCount = new Dictionary<int, List<List<ushort>>>();
            foreach (var surfaces in styleSurfaces.Values) {
                int count = surfaces.Count;
                if (!surfacesBySlotCount.TryGetValue(count, out var lists)) {
                    lists = new List<List<ushort>>();
                    surfacesBySlotCount[count] = lists;
                }
                lists.Add(surfaces);
            }

            var fallbackPalette = new Dictionary<int, List<ushort>>();
            foreach (var (slotCount, surfaceLists) in surfacesBySlotCount) {
                var palette = new List<ushort>();
                for (int i = 0; i < slotCount; i++) {
                    var freqs = new Dictionary<ushort, int>();
                    foreach (var sl in surfaceLists) {
                        if (i < sl.Count) {
                            freqs.TryGetValue(sl[i], out int f);
                            freqs[sl[i]] = f + 1;
                        }
                    }
                    palette.Add(freqs.Count > 0 ? freqs.OrderByDescending(kv => kv.Value).First().Key : (ushort)0x032A);
                }
                fallbackPalette[slotCount] = palette;
            }

            int retextured = 0;
            foreach (var dc in doc.Cells) {
                if (dc.Surfaces.Count == 0) continue;
                int needed = dc.Surfaces.Count;

                // Direct match: same room type exists in the style
                var roomKey = (dc.EnvironmentId, dc.CellStructure);
                if (styleSurfaces.TryGetValue(roomKey, out var directMatch) && directMatch.Count == needed) {
                    dc.Surfaces.Clear();
                    dc.Surfaces.AddRange(directMatch);
                    retextured++;
                    continue;
                }

                // Fallback: use the dominant palette for this slot count
                if (fallbackPalette.TryGetValue(needed, out var palette)) {
                    dc.Surfaces.Clear();
                    dc.Surfaces.AddRange(palette);
                    retextured++;
                    continue;
                }

                // Last resort: find the closest slot count palette and stretch/shrink
                if (fallbackPalette.Count > 0) {
                    var closest = fallbackPalette.OrderBy(kv => Math.Abs(kv.Key - needed)).First().Value;
                    dc.Surfaces.Clear();
                    for (int i = 0; i < needed; i++)
                        dc.Surfaces.Add(closest[i % closest.Count]);
                    retextured++;
                }
            }

            return retextured;
        }
    }
}
