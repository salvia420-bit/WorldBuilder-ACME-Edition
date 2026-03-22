using DatReaderWriter.DBObjs;
using DatReaderWriter.Types;
using System.Numerics;
using System.Text.Json;

namespace WorldBuilder.Shared.Lib.Dungeon;

/// <summary>
/// Analyzes dungeon cells in the DAT to find the most-used room types.
/// Extracted from WorldBuilder.Editors.Dungeon.DungeonRoomAnalyzer — no UI dependencies.
///
/// NOTE: The original used LocationDatabase (an embedded resource from the UI project).
/// This version accepts a dungeon name resolver as a delegate, making it UI-free.
/// </summary>
public static class DungeonRoomAnalyzer {

    public record RoomUsage(
        uint EnvFileId,
        ushort CellStructIndex,
        ushort EnvironmentId,
        int PortalCount,
        int UsageCount,
        List<ushort> SampleLandblockIds,
        List<string> SampleDungeonNames);

    public record AnalysisReport(
        DateTime AnalyzedAt,
        int TotalLandblocksScanned,
        int TotalCellsScanned,
        int UniqueRoomTypes,
        Dictionary<int, List<RoomUsage>> ByPortalCount,
        List<RoomUsage> TopStarterCandidates);

    // ════════════════════════════════════════════════════
    //  Room Catalog types (Phase 9)
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Portal connection point geometry for a single portal polygon.
    /// </summary>
    public record PortalInfo(
        ushort PolygonId,
        float CentroidX, float CentroidY, float CentroidZ,
        float NormalX, float NormalY, float NormalZ);

    /// <summary>
    /// A static object placed inside a dungeon room.
    /// </summary>
    public record StaticObjectInfo(
        uint ObjectId,
        float X, float Y, float Z);

    /// <summary>
    /// Full room template data for a single (EnvironmentId, CellStructure) pair.
    /// </summary>
    public record RoomTemplate(
        uint EnvFileId,
        ushort EnvironmentId,
        ushort CellStructIndex,
        // Bounding box
        float BoundsMinX, float BoundsMinY, float BoundsMinZ,
        float BoundsMaxX, float BoundsMaxY, float BoundsMaxZ,
        // Dimensions derived from bounding box
        float Width, float Depth, float Height,
        // Portal data
        int PortalCount,
        List<PortalInfo> Portals,
        // Classification
        string Classification,
        // Static objects (from sample cells)
        int StaticObjectCount,
        List<StaticObjectInfo>? SampleStaticObjects,
        // Usage info
        int UsageCount,
        int VertexCount);

    /// <summary>
    /// Full dungeon room catalog extracted from the DAT.
    /// </summary>
    public record CatalogReport(
        DateTime AnalyzedAt,
        int TotalLandblocksScanned,
        int TotalCellsScanned,
        int UniqueRoomTemplates,
        int Errors,
        Dictionary<string, int> ClassificationCounts,
        List<RoomTemplate> Templates);

    /// <summary>
    /// Run analysis on the DAT. Scans all LandBlockInfo entries in cell.dat,
    /// counts (EnvironmentId, CellStruct) usage, and returns a report.
    /// </summary>
    /// <param name="dats">DAT reader/writer to scan.</param>
    /// <param name="dungeonNameResolver">
    /// Optional callback to resolve landblock IDs to dungeon names.
    /// Accepts a list of landblock keys, returns a list of display names.
    /// Pass null to skip name resolution.
    /// </param>
    public static AnalysisReport Run(IDatReaderWriter dats,
        Func<List<ushort>, List<string>>? dungeonNameResolver = null) {

        var usageCount = new Dictionary<(ushort envId, ushort cellStruct), (int count, HashSet<ushort> landblocks)>();
        var portalCountCache = new Dictionary<(ushort envId, ushort cellStruct), int>();

        var lbiIds = dats.Dats.GetAllIdsOfType<LandBlockInfo>().ToArray();
        if (lbiIds.Length == 0) {
            lbiIds = dats.Dats.Cell.GetAllIdsOfType<LandBlockInfo>().ToArray();
        }
        if (lbiIds.Length == 0) {
            Console.WriteLine("[DungeonRoomAnalyzer] GetAllIdsOfType returned 0, brute-force scanning landblocks...");
            var brute = new List<uint>();
            for (uint x = 0; x < 256; x++) {
                for (uint y = 0; y < 256; y++) {
                    var infoId = ((x << 8) | y) << 16 | 0xFFFE;
                    if (dats.TryGet<LandBlockInfo>(infoId, out var lbi) && lbi.NumCells > 0)
                        brute.Add(infoId);
                }
            }
            lbiIds = brute.ToArray();
            Console.WriteLine($"[DungeonRoomAnalyzer] Found {lbiIds.Length} landblocks with cells");
        }

        int totalCells = 0;
        foreach (var lbiId in lbiIds) {
            if (!dats.TryGet<LandBlockInfo>(lbiId, out var lbi) || lbi.NumCells == 0) continue;

            uint lbId = lbiId >> 16;
            ushort lbKey = (ushort)(lbId & 0xFFFF);

            for (uint i = 0; i < lbi.NumCells; i++) {
                uint cellId = (lbId << 16) | (0x0100 + i);
                if (!dats.TryGet<EnvCell>(cellId, out var envCell)) continue;

                var key = ((ushort)envCell.EnvironmentId, (ushort)envCell.CellStructure);
                if (!usageCount.TryGetValue(key, out var entry)) {
                    entry = (0, new HashSet<ushort>());
                    usageCount[key] = entry;
                }
                entry.landblocks.Add(lbKey);
                usageCount[key] = (entry.count + 1, entry.landblocks);
                totalCells++;
            }
        }

        // Resolve portal counts from Environment
        foreach (var kvp in usageCount.Keys.ToList()) {
            uint envFileId = (uint)(kvp.envId | 0x0D000000);
            if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) continue;
            if (!env.Cells.TryGetValue(kvp.cellStruct, out var cellStruct)) continue;

            var portalIds = PortalSnapAlgorithms.GetPortalPolygonIds(cellStruct);
            portalCountCache[kvp] = portalIds.Count;
        }

        // Build RoomUsage entries
        var allUsages = new List<RoomUsage>();
        foreach (var kvp in usageCount) {
            var (key, (count, landblocks)) = (kvp.Key, kvp.Value);
            portalCountCache.TryGetValue(key, out var portals);
            var sampleLbs = landblocks.Take(10).OrderBy(x => x).ToList();
            var dungeonNames = dungeonNameResolver?.Invoke(sampleLbs) ?? new List<string>();
            allUsages.Add(new RoomUsage(
                (uint)(key.envId | 0x0D000000),
                key.cellStruct,
                key.envId,
                portals,
                count,
                sampleLbs,
                dungeonNames));
        }

        // Group by portal count
        var byPortalCount = allUsages
            .GroupBy(u => u.PortalCount)
            .OrderBy(g => g.Key)
            .ToDictionary(g => g.Key, g => g.OrderByDescending(u => u.UsageCount).ToList());

        // Top starter candidates: pick top 2-3 per portal count (1, 2, 3, 4)
        var topStarter = new List<RoomUsage>();
        foreach (var pc in new[] { 1, 2, 3, 4 }) {
            if (byPortalCount.TryGetValue(pc, out var list)) {
                topStarter.AddRange(list.Take(3));
            }
        }

        return new AnalysisReport(
            DateTime.UtcNow,
            lbiIds.Length,
            totalCells,
            allUsages.Count,
            byPortalCount,
            topStarter);
    }

    // ════════════════════════════════════════════════════
    //  Room Catalog Extraction (Phase 9)
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Extracts full room template catalog from the DAT files.
    /// For each unique (EnvironmentId, CellStructure) pair, computes:
    /// - Bounding box from vertex positions
    /// - Room dimensions (Width × Depth × Height)
    /// - Portal positions and normals
    /// - Room classification (Corridor / Room / Hub / DeadEnd)
    /// - Static object positions from sample cells
    /// </summary>
    public static CatalogReport ExtractCatalog(IDatReaderWriter dats) {
        // Phase 1: Scan all landblocks for cell usage counts
        var usageCount = new Dictionary<(ushort envId, ushort cellStruct), int>();
        // Track one sample cellId per key for static object extraction
        var sampleCellIds = new Dictionary<(ushort envId, ushort cellStruct), uint>();

        var lbiIds = GetLandblockInfoIds(dats);
        int totalCells = 0;
        int errors = 0;

        Console.WriteLine($"[DungeonCatalog] Scanning {lbiIds.Length} landblock info entries...");

        foreach (var lbiId in lbiIds) {
            if (!dats.TryGet<LandBlockInfo>(lbiId, out var lbi) || lbi.NumCells == 0) continue;

            uint lbId = lbiId >> 16;
            for (uint i = 0; i < lbi.NumCells; i++) {
                uint cellId = (lbId << 16) | (0x0100 + i);
                if (!dats.TryGet<EnvCell>(cellId, out var envCell)) continue;

                var key = ((ushort)envCell.EnvironmentId, (ushort)envCell.CellStructure);
                usageCount[key] = usageCount.GetValueOrDefault(key) + 1;

                // Keep first sample cell for static objects
                if (!sampleCellIds.ContainsKey(key))
                    sampleCellIds[key] = cellId;

                totalCells++;
            }
        }

        Console.WriteLine($"[DungeonCatalog] Found {totalCells} total cells, {usageCount.Count} unique (env, struct) pairs");

        // Phase 2: For each unique key, load the Environment/CellStruct and extract geometry
        var templates = new List<RoomTemplate>();
        var classificationCounts = new Dictionary<string, int>();
        int processed = 0;

        foreach (var kvp in usageCount) {
            var (envId, cellStructIdx) = kvp.Key;
            int usage = kvp.Value;
            uint envFileId = (uint)(envId | 0x0D000000);

            try {
                if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) {
                    errors++;
                    continue;
                }
                if (!env.Cells.TryGetValue(cellStructIdx, out var cellStruct)) {
                    errors++;
                    continue;
                }

                // --- Bounding Box from vertex positions ---
                var (boundsMin, boundsMax, vertexCount) = ComputeBoundingBox(cellStruct);

                float width = boundsMax.X - boundsMin.X;
                float depth = boundsMax.Y - boundsMin.Y;
                float height = boundsMax.Z - boundsMin.Z;

                // --- Portal extraction ---
                var portalIds = PortalSnapAlgorithms.GetPortalPolygonIds(cellStruct);
                var portalInfos = new List<PortalInfo>();
                foreach (var pid in portalIds) {
                    var geom = PortalSnapAlgorithms.GetPortalGeometry(cellStruct, pid);
                    if (geom == null) continue;
                    var g = geom.Value;
                    portalInfos.Add(new PortalInfo(
                        pid,
                        g.Centroid.X, g.Centroid.Y, g.Centroid.Z,
                        g.Normal.X, g.Normal.Y, g.Normal.Z));
                }

                // --- Classification ---
                string classification = ClassifyRoom(width, depth, height, portalInfos.Count);
                classificationCounts[classification] = classificationCounts.GetValueOrDefault(classification) + 1;

                // --- Static objects from sample cell ---
                var staticObjs = new List<StaticObjectInfo>();
                int staticObjCount = 0;
                if (sampleCellIds.TryGetValue(kvp.Key, out var sampleCellId)) {
                    if (dats.TryGet<EnvCell>(sampleCellId, out var sampleCell)) {
                        if (sampleCell.StaticObjects != null) {
                            staticObjCount = sampleCell.StaticObjects.Count;
                            foreach (var stab in sampleCell.StaticObjects) {
                                staticObjs.Add(new StaticObjectInfo(
                                    stab.Id,
                                    stab.Frame.Origin.X,
                                    stab.Frame.Origin.Y,
                                    stab.Frame.Origin.Z));
                            }
                        }
                    }
                }

                templates.Add(new RoomTemplate(
                    envFileId,
                    envId,
                    cellStructIdx,
                    boundsMin.X, boundsMin.Y, boundsMin.Z,
                    boundsMax.X, boundsMax.Y, boundsMax.Z,
                    MathF.Round(width, 2),
                    MathF.Round(depth, 2),
                    MathF.Round(height, 2),
                    portalInfos.Count,
                    portalInfos,
                    classification,
                    staticObjCount,
                    staticObjs.Count > 0 ? staticObjs : null,
                    usage,
                    vertexCount));

                processed++;
            } catch (Exception ex) {
                errors++;
                if (errors <= 5)
                    Console.WriteLine($"[DungeonCatalog] Error processing Env=0x{envFileId:X8} Struct={cellStructIdx}: {ex.Message}");
            }

            if (processed % 100 == 0 && processed > 0)
                Console.WriteLine($"[DungeonCatalog] ...{processed}/{usageCount.Count} room types processed ({errors} errors)");
        }

        // Sort by usage descending
        templates.Sort((a, b) => b.UsageCount.CompareTo(a.UsageCount));

        Console.WriteLine($"[DungeonCatalog] Complete: {templates.Count} room templates extracted, {errors} errors");
        Console.WriteLine($"[DungeonCatalog]   Classifications: {string.Join(", ", classificationCounts.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Key}={kv.Value}"))}");

        return new CatalogReport(
            DateTime.UtcNow,
            lbiIds.Length,
            totalCells,
            templates.Count,
            errors,
            classificationCounts,
            templates);
    }

    /// <summary>
    /// Save catalog report to a JSON file.
    /// </summary>
    public static void SaveCatalog(CatalogReport report, string outputPath) {
        var dir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var json = JsonSerializer.Serialize(report, new JsonSerializerOptions {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });
        File.WriteAllText(outputPath, json);
    }

    /// <summary>
    /// Format catalog report as human-readable summary.
    /// </summary>
    public static string FormatCatalogSummary(CatalogReport report) {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine("=== Dungeon Room Catalog ===");
        sb.AppendLine($"Analyzed: {report.AnalyzedAt:yyyy-MM-dd HH:mm} UTC");
        sb.AppendLine($"Landblocks scanned: {report.TotalLandblocksScanned}");
        sb.AppendLine($"Total cells: {report.TotalCellsScanned}");
        sb.AppendLine($"Unique room templates: {report.UniqueRoomTemplates}");
        sb.AppendLine($"Errors: {report.Errors}");
        sb.AppendLine();

        sb.AppendLine("--- CLASSIFICATION BREAKDOWN ---");
        foreach (var kv in report.ClassificationCounts.OrderByDescending(kv => kv.Value))
            sb.AppendLine($"  {kv.Key,-12} {kv.Value,5}");
        sb.AppendLine();

        sb.AppendLine("--- TOP 20 ROOM TEMPLATES (by usage) ---");
        sb.AppendLine($"  {"Env",-12} {"Struct",-8} {"Portals",-8} {"Class",-12} {"W×D×H",-20} {"Verts",-7} {"Objects",-8} {"Uses"}");
        sb.AppendLine($"  {new string('─', 95)}");
        foreach (var t in report.Templates.Take(20)) {
            var dims = $"{t.Width:F0}×{t.Depth:F0}×{t.Height:F0}";
            sb.AppendLine($"  0x{t.EnvFileId:X8} {t.CellStructIndex,-8} {t.PortalCount,-8} {t.Classification,-12} {dims,-20} {t.VertexCount,-7} {t.StaticObjectCount,-8} {t.UsageCount}");
        }

        return sb.ToString();
    }

    // ════════════════════════════════════════════════════
    //  Original report helpers
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Save report to JSON and a human-readable summary.
    /// </summary>
    public static void SaveReport(AnalysisReport report, string outputPath) {
        var dir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var baseName = Path.GetFileNameWithoutExtension(outputPath);
        var jsonPath = string.IsNullOrEmpty(dir) ? baseName + ".json" : Path.Combine(dir, baseName + ".json");
        var json = JsonSerializer.Serialize(report, new JsonSerializerOptions {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });
        File.WriteAllText(jsonPath, json);

        var txtPath = string.IsNullOrEmpty(dir) ? baseName + ".txt" : Path.Combine(dir, baseName + ".txt");
        File.WriteAllText(txtPath, FormatSummary(report));
    }

    public static string FormatSummary(AnalysisReport report) {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine("=== Dungeon Room Analysis Report ===");
        sb.AppendLine($"Analyzed: {report.AnalyzedAt:yyyy-MM-dd HH:mm} UTC");
        sb.AppendLine($"Landblocks scanned: {report.TotalLandblocksScanned}");
        sb.AppendLine($"Total cells: {report.TotalCellsScanned}");
        sb.AppendLine($"Unique room types: {report.UniqueRoomTypes}");
        sb.AppendLine();

        sb.AppendLine("--- TOP STARTER CANDIDATES (for preset list) ---");
        foreach (var r in report.TopStarterCandidates) {
            var namePart = r.SampleDungeonNames.Count > 0
                ? $" e.g. {string.Join(", ", r.SampleDungeonNames.Take(2))}"
                : "";
            sb.AppendLine($"  {r.PortalCount}P: Env=0x{r.EnvFileId:X8} CellStruct={r.CellStructIndex}  (used {r.UsageCount}x){namePart}");
        }
        sb.AppendLine();

        sb.AppendLine("--- BY PORTAL COUNT ---");
        foreach (var kvp in report.ByPortalCount.OrderBy(x => x.Key)) {
            sb.AppendLine($"  {kvp.Key} portal(s): {kvp.Value.Count} room types");
            foreach (var r in kvp.Value.Take(5)) {
                sb.AppendLine($"    Env=0x{r.EnvFileId:X8} CellStruct={r.CellStructIndex}  (used {r.UsageCount}x)");
            }
        }

        return sb.ToString();
    }

    // ════════════════════════════════════════════════════
    //  Private helpers
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Compute axis-aligned bounding box from a CellStruct's vertex positions.
    /// </summary>
    private static (Vector3 min, Vector3 max, int vertexCount) ComputeBoundingBox(CellStruct cellStruct) {
        var min = new Vector3(float.MaxValue);
        var max = new Vector3(float.MinValue);
        int count = 0;

        if (cellStruct.VertexArray?.Vertices != null) {
            foreach (var vtx in cellStruct.VertexArray.Vertices.Values) {
                var p = vtx.Origin;
                min = Vector3.Min(min, p);
                max = Vector3.Max(max, p);
                count++;
            }
        }

        // If no vertices found, return zero bounds
        if (count == 0) {
            return (Vector3.Zero, Vector3.Zero, 0);
        }

        return (min, max, count);
    }

    /// <summary>
    /// Classify a room based on aspect ratio and portal count.
    /// </summary>
    private static string ClassifyRoom(float width, float depth, float height, int portalCount) {
        if (portalCount == 0) return "Isolated";
        if (portalCount == 1) return "DeadEnd";

        // Compute aspect ratio of the floor plane
        float maxFloor = MathF.Max(width, depth);
        float minFloor = MathF.Min(width, depth);
        float aspectRatio = minFloor > 0.01f ? maxFloor / minFloor : 1f;

        if (portalCount >= 4) return "Hub";
        if (portalCount == 3) {
            // 3 portals: T-junction or small hub
            return aspectRatio > 2.5f ? "Corridor" : "Hub";
        }
        // portalCount == 2
        if (aspectRatio > 3.0f) return "Corridor";
        if (aspectRatio > 1.8f) return "Passage";
        return "Room";
    }

    /// <summary>
    /// Get all LandBlockInfo IDs from the DAT, with fallback to brute-force scan.
    /// </summary>
    private static uint[] GetLandblockInfoIds(IDatReaderWriter dats) {
        var lbiIds = dats.Dats.GetAllIdsOfType<LandBlockInfo>().ToArray();
        if (lbiIds.Length == 0) {
            lbiIds = dats.Dats.Cell.GetAllIdsOfType<LandBlockInfo>().ToArray();
        }
        if (lbiIds.Length == 0) {
            Console.WriteLine("[DungeonCatalog] GetAllIdsOfType returned 0, brute-force scanning landblocks...");
            var brute = new List<uint>();
            for (uint x = 0; x < 256; x++) {
                for (uint y = 0; y < 256; y++) {
                    var infoId = ((x << 8) | y) << 16 | 0xFFFE;
                    if (dats.TryGet<LandBlockInfo>(infoId, out var lbi) && lbi.NumCells > 0)
                        brute.Add(infoId);
                }
            }
            lbiIds = brute.ToArray();
            Console.WriteLine($"[DungeonCatalog] Found {lbiIds.Length} landblocks with cells");
        }
        return lbiIds;
    }
}
