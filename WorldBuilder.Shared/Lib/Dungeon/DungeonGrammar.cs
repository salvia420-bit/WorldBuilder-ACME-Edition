using System.Text;
using System.Text.Json;

namespace WorldBuilder.Shared.Lib.Dungeon;

// ════════════════════════════════════════════════════════════════════
//  Graph Grammar Engine for Procedural Dungeon Generation
// ════════════════════════════════════════════════════════════════════
//
//  L-System–style production rules that expand an axiom into a dungeon
//  layout graph. Each node = a room type; each edge = a portal connection.
//
//  Axiom:   Entrance
//  Expand:  Entrance → Corridor → MainPath
//           MainPath → Corridor + Corridor + Branch?
//           Hub      → Room + N×SidePath
//           SidePath → 1–3 Corridor + DeadEnd
//           Boss     placed when depth reaches TargetDepth
//
//  Depth pacing:  D_current / D_max controls probability of branching
//  Room clamping: total rooms clamped between MinRooms and MaxRooms
//
//  This engine produces ABSTRACT graphs only — no geometry, no AABB
//  collision, no portal snapping. Those belong to the `generate-dungeon`
//  command (Phase 9, task 4).
// ════════════════════════════════════════════════════════════════════

/// <summary>
/// The type of room a grammar node represents.
/// These map loosely to DungeonRoomAnalyzer classification strings.
/// </summary>
public enum GrammarNodeType {
    /// <summary>Dungeon entrance / starting room (always depth 0).</summary>
    Entrance,
    /// <summary>Narrow passageway connecting rooms.</summary>
    Corridor,
    /// <summary>General-purpose room (wider than a corridor).</summary>
    Room,
    /// <summary>Multi-portal junction room (≥3 exits).</summary>
    Hub,
    /// <summary>Terminal room with a single exit.</summary>
    DeadEnd,
    /// <summary>Final boss encounter room (always at max depth).</summary>
    Boss,
    /// <summary>Optional branching path off the main route.</summary>
    SidePath
}

/// <summary>
/// A single node in the expanded dungeon graph.
/// </summary>
/// <param name="Id">Unique node identifier (0-based).</param>
/// <param name="Type">Room type from the grammar.</param>
/// <param name="Depth">BFS depth from entrance (0 = entrance).</param>
/// <param name="Label">Optional human-readable label for debugging.</param>
public record DungeonGraphNode(int Id, GrammarNodeType Type, int Depth, string? Label = null);

/// <summary>
/// A directed edge representing a portal connection between two rooms.
/// </summary>
/// <param name="FromId">Source node ID.</param>
/// <param name="ToId">Target node ID.</param>
public record DungeonGraphEdge(int FromId, int ToId);

/// <summary>
/// The fully expanded dungeon layout graph — the output of grammar expansion.
/// </summary>
/// <param name="Nodes">All rooms in the dungeon.</param>
/// <param name="Edges">All portal connections.</param>
/// <param name="MaxDepthReached">Maximum depth achieved during expansion.</param>
/// <param name="Seed">Random seed used for this generation.</param>
public record DungeonGraph(
    List<DungeonGraphNode> Nodes,
    List<DungeonGraphEdge> Edges,
    int MaxDepthReached,
    int Seed);

/// <summary>
/// Parameters controlling dungeon graph grammar expansion.
/// </summary>
/// <param name="TargetDepth">Max depth from entrance to boss room (default 8).</param>
/// <param name="BranchingFactor">Target average connections per room (default 2.0).</param>
/// <param name="MinRooms">Minimum rooms in the generated dungeon (default 5).</param>
/// <param name="MaxRooms">Maximum rooms in the generated dungeon (default 40).</param>
/// <param name="Theme">Theme tag for future room-type selection (default "default").</param>
/// <param name="Seed">Random seed for reproducibility (0 = non-deterministic).</param>
public record GrammarParams(
    int TargetDepth = 8,
    float BranchingFactor = 2.0f,
    int MinRooms = 5,
    int MaxRooms = 40,
    string Theme = "default",
    int Seed = 0);

/// <summary>
/// Graph Grammar engine for procedural dungeon generation.
/// Expands an axiom into a dungeon layout graph through L-System production rules.
/// </summary>
public static class DungeonGrammar {

    // ════════════════════════════════════════════════════
    //  Public API
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Generate a dungeon layout graph from grammar parameters.
    /// The algorithm:
    ///   1. Place Entrance node at depth 0
    ///   2. Expand via MainPath: Corridor chains with probabilistic branching
    ///   3. Introduce Hub at ~60% of TargetDepth
    ///   4. Hub expands with N×SidePath (N from BranchingFactor)
    ///   5. Place Boss at TargetDepth
    ///   6. If under MinRooms, pad with extra side paths
    ///   7. If over MaxRooms, stop expanding early
    /// </summary>
    /// <param name="p">Grammar parameters controlling expansion.</param>
    /// <returns>The expanded dungeon graph.</returns>
    public static DungeonGraph Generate(GrammarParams p) {
        int seed = p.Seed != 0 ? p.Seed : Environment.TickCount;
        var rng = new Random(seed);

        var nodes = new List<DungeonGraphNode>();
        var edges = new List<DungeonGraphEdge>();
        int nextId = 0;

        // ── Step 1: Place Entrance ──────────────────────
        var entrance = new DungeonGraphNode(nextId++, GrammarNodeType.Entrance, 0, "Entrance");
        nodes.Add(entrance);

        // ── Step 2: Expand MainPath from Entrance ───────
        int currentDepth = 0;
        int lastNodeId = entrance.Id;
        bool hubPlaced = false;
        bool bossPlaced = false;
        int hubDepthThreshold = (int)(p.TargetDepth * 0.6f);

        // First corridor after entrance
        var firstCorridor = AddNode(nodes, ref nextId, GrammarNodeType.Corridor, 1, "Entry Corridor");
        AddEdge(edges, lastNodeId, firstCorridor.Id);
        lastNodeId = firstCorridor.Id;
        currentDepth = 1;

        // ── Step 3: Main expansion loop ─────────────────
        while (currentDepth < p.TargetDepth && nodes.Count < p.MaxRooms - 1) {  // -1 to reserve room for Boss

            float depthRatio = (float)currentDepth / p.TargetDepth;

            // Check if we should place a Hub
            if (!hubPlaced && currentDepth >= hubDepthThreshold) {
                // Place Hub
                var hub = AddNode(nodes, ref nextId, GrammarNodeType.Hub, currentDepth + 1, "Hub");
                AddEdge(edges, lastNodeId, hub.Id);
                lastNodeId = hub.Id;
                currentDepth++;
                hubPlaced = true;

                // Expand Hub: add N side paths based on BranchingFactor
                int sidePathCount = Math.Max(1, (int)MathF.Round(p.BranchingFactor) - 1);  // -1 for the main path
                for (int sp = 0; sp < sidePathCount && nodes.Count < p.MaxRooms - 2; sp++) {
                    ExpandSidePath(nodes, edges, ref nextId, hub.Id, currentDepth, rng, p.MaxRooms);
                }

                continue;
            }

            // MainPath expansion: Corridor + Corridor + Branch?
            // Add a corridor
            var corridor = AddNode(nodes, ref nextId, GrammarNodeType.Corridor, currentDepth + 1, null);
            AddEdge(edges, lastNodeId, corridor.Id);
            lastNodeId = corridor.Id;
            currentDepth++;

            if (nodes.Count >= p.MaxRooms - 1) break;

            // Probability of branching increases with depth ratio but modulated by BranchingFactor
            float branchProbability = depthRatio * (p.BranchingFactor - 1.0f) * 0.5f;
            branchProbability = Math.Clamp(branchProbability, 0.05f, 0.6f);

            if (rng.NextSingle() < branchProbability && nodes.Count < p.MaxRooms - 2) {
                ExpandSidePath(nodes, edges, ref nextId, corridor.Id, currentDepth, rng, p.MaxRooms);
            }

            // Sometimes add a Room node instead of pure corridors for variety
            float roomProbability = depthRatio > 0.3f ? 0.35f : 0.15f;
            if (rng.NextSingle() < roomProbability && currentDepth < p.TargetDepth - 1 && nodes.Count < p.MaxRooms - 1) {
                var room = AddNode(nodes, ref nextId, GrammarNodeType.Room, currentDepth + 1, null);
                AddEdge(edges, lastNodeId, room.Id);
                lastNodeId = room.Id;
                currentDepth++;
            }
        }

        // ── Step 4: Place Boss at end of main path ──────
        if (nodes.Count < p.MaxRooms) {
            var boss = AddNode(nodes, ref nextId, GrammarNodeType.Boss, currentDepth + 1, "Boss Chamber");
            AddEdge(edges, lastNodeId, boss.Id);
            currentDepth++;
            bossPlaced = true;
        }

        // ── Step 5: If under MinRooms, pad with extra content ──
        if (nodes.Count < p.MinRooms && nodes.Count < p.MaxRooms) {
            PadToMinimum(nodes, edges, ref nextId, p.MinRooms, p.MaxRooms, rng);
        }

        // ── Step 6: If no hub was placed (short dungeons), ensure variety ──
        if (!hubPlaced && nodes.Count >= 7) {
            // Find last corridor before boss and upgrade it to Hub
            for (int i = nodes.Count - 1; i >= 0; i--) {
                if (nodes[i].Type == GrammarNodeType.Corridor) {
                    nodes[i] = nodes[i] with { Type = GrammarNodeType.Hub, Label = "Hub (promoted)" };
                    break;
                }
            }
        }

        // ── Step 7: If no boss was placed (room cap hit early), force it ──
        if (!bossPlaced) {
            // Replace the last non-entrance node as boss
            var lastNode = nodes[^1];
            if (lastNode.Type != GrammarNodeType.Entrance) {
                nodes[^1] = lastNode with { Type = GrammarNodeType.Boss, Label = "Boss (forced)" };
            }
        }

        int maxDepthReached = nodes.Count > 0 ? nodes.Max(n => n.Depth) : 0;

        return new DungeonGraph(nodes, edges, maxDepthReached, seed);
    }

    /// <summary>
    /// Format a dungeon graph as a human-readable summary string.
    /// </summary>
    public static string FormatSummary(DungeonGraph graph) {
        var sb = new StringBuilder();
        sb.AppendLine("=== Dungeon Graph Grammar Output ===");
        sb.AppendLine($"Seed: {graph.Seed}");
        sb.AppendLine($"Total nodes: {graph.Nodes.Count}");
        sb.AppendLine($"Total edges: {graph.Edges.Count}");
        sb.AppendLine($"Max depth reached: {graph.MaxDepthReached}");
        sb.AppendLine();

        // Node type breakdown
        var typeCounts = graph.Nodes
            .GroupBy(n => n.Type)
            .OrderBy(g => g.Key)
            .ToDictionary(g => g.Key, g => g.Count());

        sb.AppendLine("--- NODE TYPE BREAKDOWN ---");
        foreach (var kv in typeCounts)
            sb.AppendLine($"  {kv.Key,-12} {kv.Value,4}");
        sb.AppendLine();

        // Graph statistics
        var avgDepth = graph.Nodes.Count > 0 ? graph.Nodes.Average(n => n.Depth) : 0;

        // Compute actual branching factor from edges
        var outDegree = new Dictionary<int, int>();
        foreach (var edge in graph.Edges) {
            outDegree[edge.FromId] = outDegree.GetValueOrDefault(edge.FromId) + 1;
        }
        float actualBranching = outDegree.Count > 0
            ? (float)outDegree.Values.Sum() / outDegree.Count
            : 0f;

        sb.AppendLine("--- STATISTICS ---");
        sb.AppendLine($"  Average depth    : {avgDepth:F1}");
        sb.AppendLine($"  Avg out-degree   : {actualBranching:F2}");
        sb.AppendLine($"  Leaf nodes       : {CountLeaves(graph)}");
        sb.AppendLine();

        // Node list
        sb.AppendLine("--- NODE LIST ---");
        sb.AppendLine($"  {"ID",-5} {"Type",-12} {"Depth",-7} {"Label"}");
        sb.AppendLine($"  {new string('─', 50)}");
        foreach (var node in graph.Nodes) {
            sb.AppendLine($"  {node.Id,-5} {node.Type,-12} {node.Depth,-7} {node.Label ?? ""}");
        }
        sb.AppendLine();

        // Edge list
        sb.AppendLine("--- EDGE LIST ---");
        sb.AppendLine($"  {"From",-6} → {"To",-6}  ({"FromType",-12} → {"ToType"})");
        sb.AppendLine($"  {new string('─', 50)}");
        foreach (var edge in graph.Edges) {
            var fromNode = graph.Nodes.FirstOrDefault(n => n.Id == edge.FromId);
            var toNode = graph.Nodes.FirstOrDefault(n => n.Id == edge.ToId);
            sb.AppendLine($"  {edge.FromId,-6} → {edge.ToId,-6}  ({fromNode?.Type,-12} → {toNode?.Type})");
        }

        return sb.ToString();
    }

    /// <summary>
    /// Serialize a dungeon graph to JSON.
    /// </summary>
    public static string ToJson(DungeonGraph graph, bool indented = true) {
        return JsonSerializer.Serialize(graph, new JsonSerializerOptions {
            WriteIndented = indented,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
        });
    }

    /// <summary>
    /// Count leaf nodes (nodes with no outgoing edges) in the graph.
    /// </summary>
    public static int CountLeaves(DungeonGraph graph) {
        var nodesWithOutgoing = new HashSet<int>(graph.Edges.Select(e => e.FromId));
        return graph.Nodes.Count(n => !nodesWithOutgoing.Contains(n.Id));
    }

    /// <summary>
    /// Validate that the dungeon graph is well-formed:
    /// - Has exactly one Entrance node at depth 0
    /// - Has at least one Boss node
    /// - All nodes are reachable from Entrance via edges
    /// - No orphan edges (referencing non-existent nodes)
    /// </summary>
    /// <returns>List of validation warnings (empty = valid).</returns>
    public static List<string> Validate(DungeonGraph graph) {
        var warnings = new List<string>();

        if (graph.Nodes.Count == 0) {
            warnings.Add("Graph has no nodes.");
            return warnings;
        }

        // Check entrance
        var entrances = graph.Nodes.Where(n => n.Type == GrammarNodeType.Entrance).ToList();
        if (entrances.Count == 0)
            warnings.Add("No Entrance node found.");
        else if (entrances.Count > 1)
            warnings.Add($"Multiple Entrance nodes found: {entrances.Count}");
        if (entrances.Any(e => e.Depth != 0))
            warnings.Add("Entrance node is not at depth 0.");

        // Check boss
        var bosses = graph.Nodes.Where(n => n.Type == GrammarNodeType.Boss).ToList();
        if (bosses.Count == 0)
            warnings.Add("No Boss node found.");

        // Check edge references
        var nodeIds = new HashSet<int>(graph.Nodes.Select(n => n.Id));
        foreach (var edge in graph.Edges) {
            if (!nodeIds.Contains(edge.FromId))
                warnings.Add($"Edge references non-existent FromId={edge.FromId}");
            if (!nodeIds.Contains(edge.ToId))
                warnings.Add($"Edge references non-existent ToId={edge.ToId}");
        }

        // Check reachability via BFS from entrance
        if (entrances.Count > 0) {
            var adjacency = new Dictionary<int, List<int>>();
            foreach (var edge in graph.Edges) {
                if (!adjacency.ContainsKey(edge.FromId))
                    adjacency[edge.FromId] = new List<int>();
                adjacency[edge.FromId].Add(edge.ToId);

                // Also add reverse for reachability (undirected reachability check)
                if (!adjacency.ContainsKey(edge.ToId))
                    adjacency[edge.ToId] = new List<int>();
                adjacency[edge.ToId].Add(edge.FromId);
            }

            var visited = new HashSet<int>();
            var queue = new Queue<int>();
            queue.Enqueue(entrances[0].Id);
            visited.Add(entrances[0].Id);

            while (queue.Count > 0) {
                var current = queue.Dequeue();
                if (adjacency.TryGetValue(current, out var neighbors)) {
                    foreach (var neighbor in neighbors) {
                        if (visited.Add(neighbor))
                            queue.Enqueue(neighbor);
                    }
                }
            }

            var unreachable = graph.Nodes.Where(n => !visited.Contains(n.Id)).ToList();
            if (unreachable.Count > 0)
                warnings.Add($"{unreachable.Count} node(s) unreachable from Entrance: [{string.Join(", ", unreachable.Select(n => $"#{n.Id} {n.Type}"))}]");
        }

        return warnings;
    }

    // ════════════════════════════════════════════════════
    //  Private expansion helpers
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Add a new node to the graph and return it.
    /// </summary>
    private static DungeonGraphNode AddNode(List<DungeonGraphNode> nodes, ref int nextId,
        GrammarNodeType type, int depth, string? label) {
        var node = new DungeonGraphNode(nextId++, type, depth, label);
        nodes.Add(node);
        return node;
    }

    /// <summary>
    /// Add an edge connecting two nodes.
    /// </summary>
    private static void AddEdge(List<DungeonGraphEdge> edges, int fromId, int toId) {
        edges.Add(new DungeonGraphEdge(fromId, toId));
    }

    /// <summary>
    /// Expand a SidePath production from a parent node:
    ///   SidePath → 1–3 Corridor + DeadEnd
    /// Side paths are optional exploration branches that terminate in dead ends.
    /// </summary>
    private static void ExpandSidePath(List<DungeonGraphNode> nodes, List<DungeonGraphEdge> edges,
        ref int nextId, int parentId, int parentDepth, Random rng, int maxRooms) {

        int sideCorridors = rng.Next(1, 4);  // 1–3 corridors
        int lastId = parentId;
        int depth = parentDepth;

        for (int i = 0; i < sideCorridors && nodes.Count < maxRooms - 1; i++) {
            depth++;

            // Occasionally use a Room instead of a Corridor in side paths
            GrammarNodeType type = (rng.NextSingle() < 0.25f)
                ? GrammarNodeType.Room
                : GrammarNodeType.Corridor;

            var node = AddNode(nodes, ref nextId, type, depth, null);
            AddEdge(edges, lastId, node.Id);
            lastId = node.Id;
        }

        // Terminate with DeadEnd
        if (nodes.Count < maxRooms) {
            var deadEnd = AddNode(nodes, ref nextId, GrammarNodeType.DeadEnd, depth + 1, null);
            AddEdge(edges, lastId, deadEnd.Id);
        }
    }

    /// <summary>
    /// Pad the graph to meet MinRooms by adding extra side paths to existing
    /// corridor and room nodes. Finds nodes with only one outgoing edge and
    /// adds a small branch.
    /// </summary>
    private static void PadToMinimum(List<DungeonGraphNode> nodes, List<DungeonGraphEdge> edges,
        ref int nextId, int minRooms, int maxRooms, Random rng) {

        // Find candidate nodes that could sprout a side path
        // (corridors or rooms that aren't entrance or boss)
        var outDegree = new Dictionary<int, int>();
        foreach (var edge in edges)
            outDegree[edge.FromId] = outDegree.GetValueOrDefault(edge.FromId) + 1;

        var candidates = nodes
            .Where(n => n.Type == GrammarNodeType.Corridor || n.Type == GrammarNodeType.Room || n.Type == GrammarNodeType.Hub)
            .Where(n => outDegree.GetValueOrDefault(n.Id) <= 1)
            .OrderBy(_ => rng.Next())
            .ToList();

        foreach (var candidate in candidates) {
            if (nodes.Count >= minRooms || nodes.Count >= maxRooms) break;
            ExpandSidePath(nodes, edges, ref nextId, candidate.Id, candidate.Depth, rng, Math.Min(maxRooms, minRooms + 2));
        }

        // If still under minimum after side paths, just add corridors to existing dead ends
        if (nodes.Count < minRooms) {
            var deadEnds = nodes
                .Where(n => n.Type == GrammarNodeType.DeadEnd)
                .OrderBy(_ => rng.Next())
                .ToList();

            foreach (var de in deadEnds) {
                if (nodes.Count >= minRooms || nodes.Count >= maxRooms) break;

                // Convert dead-end to corridor and add a new dead-end after it
                int idx = nodes.FindIndex(n => n.Id == de.Id);
                if (idx >= 0) {
                    nodes[idx] = de with { Type = GrammarNodeType.Corridor };
                    var newDeadEnd = AddNode(nodes, ref nextId, GrammarNodeType.DeadEnd, de.Depth + 1, null);
                    AddEdge(edges, de.Id, newDeadEnd.Id);
                }
            }
        }
    }
}
