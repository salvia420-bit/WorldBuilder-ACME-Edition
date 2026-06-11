using DatReaderWriter.DBObjs;
using DatReaderWriter.Types;
using System.Numerics;
using System.Text.Json;

namespace WorldBuilder.Shared.Lib.Dungeon;

/// <summary>
/// Extracts dungeon topology (portal graph) from the DAT files.
/// For each dungeon landblock, builds the cell adjacency graph and computes
/// structural metrics: room count, branching factor, depth, dimensions, classification.
/// This data trains the graph grammar generator (Phase 9, task 3).
/// </summary>
public static class DungeonTopologyAnalyzer {

    // ════════════════════════════════════════════════════
    //  Output records
    // ════════════════════════════════════════════════════

    /// <summary>
    /// A single portal connection between two cells in a dungeon.
    /// </summary>
    public record CellConnection(uint FromCellId, uint ToCellId, ushort PortalPolyId);

    /// <summary>
    /// Full topology metrics for a single dungeon landblock.
    /// </summary>
    public record DungeonTopology(
        ushort LandblockId,
        int RoomCount,
        float BranchingFactor,
        int MaxDepth,
        float AvgWidth, float AvgDepth, float AvgHeight,
        string Classification,
        List<CellConnection> Connections);

    /// <summary>
    /// Aggregated topology report across all dungeon landblocks in the DAT.
    /// </summary>
    public record TopologyReport(
        DateTime AnalyzedAt,
        int TotalDungeonsAnalyzed,
        int TotalCellsAnalyzed,
        Dictionary<string, int> ClassificationCounts,
        List<DungeonTopology> Dungeons,
        int Errors = 0,
        int BuildingInteriorLandblocks = 0);

    // ════════════════════════════════════════════════════
    //  Main extraction method
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Scans all dungeon landblocks in the DAT and extracts topology metrics.
    /// For each dungeon:
    ///   1. Loads all EnvCells
    ///   2. Builds adjacency graph from CellPortals
    ///   3. BFS from entrance to compute depth
    ///   4. Computes branching factor, dimensions, classification
    /// </summary>
    public static TopologyReport ExtractTopology(IDatReaderWriter dats) {
        var lbiIds = GetLandblockInfoIds(dats);
        var dungeons = new List<DungeonTopology>();
        var classificationCounts = new Dictionary<string, int>();
        int totalCells = 0;
        int processed = 0;
        int errors = 0;
        int buildingInteriorLandblocks = 0;

        Console.Error.WriteLine($"[DungeonTopology] Scanning {lbiIds.Length} landblock info entries for dungeons...");

        foreach (var lbiId in lbiIds) {
            if (!dats.TryGet<LandBlockInfo>(lbiId, out var lbi) || lbi.NumCells == 0) continue;

            // Outdoor towns implement cottage/shop interiors as EnvCells attached to outdoor Buildings;
            // those are not dungeons. Pure dungeons have cells but no outdoor buildings.
            if (lbi.Buildings != null && lbi.Buildings.Count > 0) {
                buildingInteriorLandblocks++;
                continue;
            }

            uint lbId = lbiId >> 16;
            ushort lbKey = (ushort)(lbId & 0xFFFF);

            try {
                var topology = AnalyzeSingleDungeon(dats, lbId, lbi.NumCells);
                if (topology == null) continue;

                dungeons.Add(topology);
                totalCells += topology.RoomCount;
                classificationCounts[topology.Classification] =
                    classificationCounts.GetValueOrDefault(topology.Classification) + 1;

                processed++;
            } catch (Exception ex) {
                errors++;
                if (errors <= 5)
                    Console.Error.WriteLine($"[DungeonTopology] Error processing LB 0x{lbKey:X4}: {ex.Message}");
            }

            if (processed % 100 == 0 && processed > 0)
                Console.Error.WriteLine($"[DungeonTopology] ...{processed} dungeons processed ({errors} errors)");
        }

        // Sort by room count descending (largest dungeons first)
        dungeons.Sort((a, b) => b.RoomCount.CompareTo(a.RoomCount));

        Console.Error.WriteLine($"[DungeonTopology] Complete: {dungeons.Count} dungeons analyzed, {totalCells} total cells, {errors} errors");
        Console.Error.WriteLine($"[DungeonTopology]   Classifications: {string.Join(", ", classificationCounts.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Key}={kv.Value}"))}");

        return new TopologyReport(
            DateTime.UtcNow,
            dungeons.Count,
            totalCells,
            classificationCounts,
            dungeons,
            errors,
            buildingInteriorLandblocks);
    }

    // ════════════════════════════════════════════════════
    //  Single dungeon analysis
    // ════════════════════════════════════════════════════

    private static DungeonTopology? AnalyzeSingleDungeon(IDatReaderWriter dats, uint lbId, uint numCells) {
        // Step 1: Load all EnvCells for this landblock
        var cells = new Dictionary<uint, EnvCell>();
        for (uint i = 0; i < numCells; i++) {
            uint cellId = (lbId << 16) | (0x0100 + i);
            if (dats.TryGet<EnvCell>(cellId, out var envCell))
                cells[cellId] = envCell;
        }

        if (cells.Count == 0) return null;

        ushort lbKey = (ushort)(lbId & 0xFFFF);

        // Step 2: Build adjacency graph and connection list
        var adjacency = new Dictionary<uint, List<(uint otherCellId, ushort polyId)>>();
        var connections = new List<CellConnection>();
        var seenEdges = new HashSet<(uint, uint)>();

        foreach (var (cellId, envCell) in cells) {
            if (!adjacency.ContainsKey(cellId))
                adjacency[cellId] = new List<(uint, ushort)>();

            if (envCell.CellPortals != null) {
                foreach (var portal in envCell.CellPortals) {
                    // CellPortals reference cell numbers (e.g. 0x0100), so build full ID
                    uint otherFullId = (lbId << 16) | portal.OtherCellId;

                    // Only count portals that reference cells within this dungeon
                    if (!cells.ContainsKey(otherFullId)) continue;

                    adjacency[cellId].Add((otherFullId, (ushort)portal.PolygonId));

                    // Track unique edges (avoid duplicates: A→B and B→A)
                    var edgeKey = cellId < otherFullId ? (cellId, otherFullId) : (otherFullId, cellId);
                    if (seenEdges.Add(edgeKey)) {
                        connections.Add(new CellConnection(cellId, otherFullId, (ushort)portal.PolygonId));
                    }
                }
            }
        }

        // Step 3: Compute branching factor (average portal connections per cell)
        float branchingFactor = cells.Count > 0
            ? (float)adjacency.Values.Sum(list => list.Count) / cells.Count
            : 0f;
        branchingFactor = MathF.Round(branchingFactor, 2);

        // Step 4: BFS from entrance cell (lowest cell index = 0x0100) to compute max depth
        uint entranceCellId = (lbId << 16) | 0x0100;
        if (!cells.ContainsKey(entranceCellId)) {
            // Fallback: pick the cell with the lowest ID
            entranceCellId = cells.Keys.Min();
        }

        int maxDepth = ComputeMaxDepth(adjacency, entranceCellId);

        // Step 5: Compute average room dimensions from CellStruct vertex data
        float totalWidth = 0, totalDepth = 0, totalHeight = 0;
        int dimensionCount = 0;

        foreach (var (cellId, envCell) in cells) {
            uint envFileId = (uint)(envCell.EnvironmentId | 0x0D000000);
            if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) continue;
            if (!env.Cells.TryGetValue(envCell.CellStructure, out var cellStruct)) continue;

            var (boundsMin, boundsMax, vertexCount) = ComputeBoundingBox(cellStruct);
            if (vertexCount == 0) continue;

            totalWidth += boundsMax.X - boundsMin.X;
            totalDepth += boundsMax.Y - boundsMin.Y;
            totalHeight += boundsMax.Z - boundsMin.Z;
            dimensionCount++;
        }

        float avgWidth = dimensionCount > 0 ? MathF.Round(totalWidth / dimensionCount, 2) : 0;
        float avgDepthVal = dimensionCount > 0 ? MathF.Round(totalDepth / dimensionCount, 2) : 0;
        float avgHeight = dimensionCount > 0 ? MathF.Round(totalHeight / dimensionCount, 2) : 0;

        // Step 6: Classify dungeon layout
        string classification = ClassifyDungeon(cells.Count, branchingFactor, maxDepth, adjacency);

        return new DungeonTopology(
            lbKey,
            cells.Count,
            branchingFactor,
            maxDepth,
            avgWidth, avgDepthVal, avgHeight,
            classification,
            connections);
    }

    // ════════════════════════════════════════════════════
    //  BFS depth computation
    // ════════════════════════════════════════════════════

    /// <summary>
    /// BFS from entrance cell to compute longest shortest-path distance (depth).
    /// </summary>
    private static int ComputeMaxDepth(Dictionary<uint, List<(uint otherCellId, ushort polyId)>> adjacency, uint entranceId) {
        if (!adjacency.ContainsKey(entranceId)) return 0;

        var visited = new HashSet<uint>();
        var queue = new Queue<(uint cellId, int depth)>();
        queue.Enqueue((entranceId, 0));
        visited.Add(entranceId);
        int maxDepth = 0;

        while (queue.Count > 0) {
            var (cellId, depth) = queue.Dequeue();
            if (depth > maxDepth) maxDepth = depth;

            if (!adjacency.TryGetValue(cellId, out var neighbors)) continue;
            foreach (var (neighbor, _) in neighbors) {
                if (visited.Add(neighbor)) {
                    queue.Enqueue((neighbor, depth + 1));
                }
            }
        }

        return maxDepth;
    }

    // ════════════════════════════════════════════════════
    //  Dungeon classification
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Classify a dungeon layout based on its graph structure.
    /// - Linear: branchingFactor ≤ 2.0 and maxDepth ≈ roomCount (mostly a chain)
    /// - Branching: branchingFactor > 2.0 and maxDepth < roomCount/2 (tree-like)
    /// - Hub-and-spoke: has a cell with 4+ portals and most cells have 1-2 portals
    /// - Complex: doesn't fit other patterns
    /// </summary>
    private static string ClassifyDungeon(int roomCount, float branchingFactor, int maxDepth,
        Dictionary<uint, List<(uint, ushort)>> adjacency) {

        if (roomCount <= 1) return "Single";

        // Check for hub-and-spoke: at least one hub cell with 4+ connections and
        // majority of cells have ≤ 2 connections
        int hubCells = 0;
        int lowConnCells = 0;
        foreach (var (_, neighbors) in adjacency) {
            if (neighbors.Count >= 4) hubCells++;
            if (neighbors.Count <= 2) lowConnCells++;
        }

        if (hubCells >= 1 && (float)lowConnCells / adjacency.Count >= 0.6f)
            return "HubAndSpoke";

        // Linear: mostly a chain — branching factor ≤ 2.0 and depth is most of the rooms
        if (branchingFactor <= 2.0f && maxDepth >= roomCount * 0.7f)
            return "Linear";

        // Branching: tree-like — branching factor > 2.0 and depth much less than room count
        if (branchingFactor > 2.0f && maxDepth < roomCount / 2)
            return "Branching";

        return "Complex";
    }

    // ════════════════════════════════════════════════════
    //  Save and format helpers
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Save topology report to a JSON file.
    /// </summary>
    public static void SaveReport(TopologyReport report, string outputPath) {
        var dir = Path.GetDirectoryName(outputPath);
    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var json = JsonSerializer.Serialize(report, JsonOpts.CamelCaseIndented);
        File.WriteAllText(outputPath, json);
    }

    /// <summary>
    /// Format topology report as human-readable summary.
    /// </summary>
    public static string FormatSummary(TopologyReport report) {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine("=== Dungeon Topology Report ===");
        sb.AppendLine($"Analyzed: {report.AnalyzedAt:yyyy-MM-dd HH:mm} UTC");
        sb.AppendLine($"Total dungeons: {report.TotalDungeonsAnalyzed}");
        sb.AppendLine($"Total cells: {report.TotalCellsAnalyzed}");
        sb.AppendLine();

        sb.AppendLine("--- CLASSIFICATION BREAKDOWN ---");
        foreach (var kv in report.ClassificationCounts.OrderByDescending(kv => kv.Value))
            sb.AppendLine($"  {kv.Key,-14} {kv.Value,5}");
        sb.AppendLine();

        // Statistics across all dungeons
        if (report.Dungeons.Count > 0) {
            var avgRooms = report.Dungeons.Average(d => d.RoomCount);
            var avgBranch = report.Dungeons.Average(d => d.BranchingFactor);
            var avgDepth = report.Dungeons.Average(d => d.MaxDepth);
            var maxRooms = report.Dungeons.Max(d => d.RoomCount);
            var maxBranch = report.Dungeons.Max(d => d.BranchingFactor);
            var maxDepthVal = report.Dungeons.Max(d => d.MaxDepth);

            sb.AppendLine("--- AGGREGATE STATISTICS ---");
            sb.AppendLine($"  Room count      : avg={avgRooms:F1}, max={maxRooms}");
            sb.AppendLine($"  Branching factor: avg={avgBranch:F2}, max={maxBranch:F2}");
            sb.AppendLine($"  Max depth       : avg={avgDepth:F1}, max={maxDepthVal}");
            sb.AppendLine();
        }

        sb.AppendLine("--- TOP 20 DUNGEONS (by room count) ---");
        sb.AppendLine($"  {"LB",-8} {"Rooms",-7} {"Branch",-8} {"Depth",-7} {"AvgW×D×H",-20} {"Class"}");
        sb.AppendLine($"  {new string('─', 70)}");
        foreach (var d in report.Dungeons.Take(20)) {
            var dims = $"{d.AvgWidth:F0}×{d.AvgDepth:F0}×{d.AvgHeight:F0}";
            sb.AppendLine($"  0x{d.LandblockId:X4}  {d.RoomCount,-7} {d.BranchingFactor,-8:F2} {d.MaxDepth,-7} {dims,-20} {d.Classification}");
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

        if (count == 0) {
            return (Vector3.Zero, Vector3.Zero, 0);
        }

        return (min, max, count);
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
            Console.Error.WriteLine("[DungeonTopology] GetAllIdsOfType returned 0, brute-force scanning landblocks...");
            var brute = new List<uint>();
            for (uint x = 0; x < 256; x++) {
                for (uint y = 0; y < 256; y++) {
                    var infoId = ((x << 8) | y) << 16 | 0xFFFE;
                    if (dats.TryGet<LandBlockInfo>(infoId, out var lbi) && lbi.NumCells > 0)
                        brute.Add(infoId);
                }
            }
            lbiIds = brute.ToArray();
            Console.Error.WriteLine($"[DungeonTopology] Found {lbiIds.Length} landblocks with cells");
        }
        return lbiIds;
    }
}
