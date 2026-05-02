using System.Text.Json;

namespace WorldBuilder.Shared.Lib.Pairings;

/// <summary>
/// Registry of "these models are part of the same compound structure."
/// Mined from retail-data adjacency frequencies (see <c>analyze-landblock-patterns</c>):
/// when two Structure-classified Setups appear within 5 m of each other in
/// vanilla AC many times, they're treated as members of a building group.
///
/// At placement time the group resolves to a single shared foundation Z so
/// a fortress wall doesn't stair-step across a slope; instead every piece
/// sits flush at the union-max of all members' footprint corners.
///
/// Group membership is transitive via union-find: if A pairs with B and
/// B pairs with C, then {A, B, C} share a group, even without an explicit
/// A↔C edge.
/// </summary>
public class BuildingPairings {
    private readonly Dictionary<uint, uint> _parent = new();
    private readonly Dictionary<uint, int> _rank = new();
    private readonly List<(uint A, uint B)> _edges = new();

    /// <summary>
    /// Number of registered pair edges (before transitive expansion). Useful
    /// for telemetry; group counts come from <see cref="GroupCount"/>.
    /// </summary>
    public int EdgeCount => _edges.Count;

    /// <summary>Number of distinct groups (single-member groups not counted).</summary>
    public int GroupCount {
        get {
            var roots = new HashSet<uint>();
            foreach (var id in _parent.Keys) roots.Add(Find(id));
            // Filter out singletons (no edges contributed).
            int multi = 0;
            var counts = new Dictionary<uint, int>();
            foreach (var id in _parent.Keys) {
                var r = Find(id);
                counts.TryGetValue(r, out int c);
                counts[r] = c + 1;
            }
            foreach (var (_, c) in counts) if (c >= 2) multi++;
            return multi;
        }
    }

    /// <summary>
    /// Records that the two models pair. Order doesn't matter; duplicates
    /// are idempotent. Self-pairs are ignored.
    /// </summary>
    public void AddPair(uint modelA, uint modelB) {
        if (modelA == modelB) return;
        Ensure(modelA);
        Ensure(modelB);
        _edges.Add((modelA, modelB));
        Union(modelA, modelB);
    }

    /// <summary>
    /// True if both models are registered and share the same group root.
    /// Returns false for either id that hasn't been seen.
    /// </summary>
    public bool AreInSameGroup(uint a, uint b) {
        if (!_parent.ContainsKey(a) || !_parent.ContainsKey(b)) return false;
        return Find(a) == Find(b);
    }

    /// <summary>
    /// Returns the group's representative root for <paramref name="modelId"/>,
    /// or <paramref name="modelId"/> itself if it's not registered. Used as
    /// a fast group key for placement-time grouping.
    /// </summary>
    public uint GroupKey(uint modelId) =>
        _parent.ContainsKey(modelId) ? Find(modelId) : modelId;

    /// <summary>
    /// Returns true if at least one pair edge is registered for <paramref name="modelId"/>.
    /// Singleton models (no pairs) return false; placement-time grouping treats
    /// them as their own group of one.
    /// </summary>
    public bool HasPairs(uint modelId) => _parent.ContainsKey(modelId);

    // ─────────────────────────── JSON I/O ───────────────────────────
    private class PairingsJson {
        public string? Version { get; set; }
        public string? GeneratedAtUtc { get; set; }
        public int MinCount5 { get; set; }
        public List<uint[]> Pairs { get; set; } = new();
    }

    /// <summary>
    /// Loads pairings from a JSON file produced by <c>extract-building-pairings</c>.
    /// Returns the loaded instance. If the file is missing or malformed the
    /// registry is empty (callers degrade gracefully — placement falls back
    /// to per-building corner sampling).
    /// </summary>
    public static BuildingPairings LoadFromJsonFile(string path) {
        var inst = new BuildingPairings();
        if (!File.Exists(path)) return inst;
        try {
            var doc = JsonSerializer.Deserialize<PairingsJson>(File.ReadAllText(path));
            if (doc?.Pairs == null) return inst;
            foreach (var pair in doc.Pairs) {
                if (pair.Length >= 2) inst.AddPair(pair[0], pair[1]);
            }
        } catch {
            // Treat as empty; caller can warn via a higher layer.
        }
        return inst;
    }

    /// <summary>
    /// Persists the current pair edges to JSON.
    /// </summary>
    public void SaveToJsonFile(string path, int minCount5) {
        var doc = new PairingsJson {
            Version = "1",
            GeneratedAtUtc = DateTime.UtcNow.ToString("o"),
            MinCount5 = minCount5,
            Pairs = _edges.Select(e => new[] { e.A, e.B }).ToList(),
        };
        File.WriteAllText(path,
            JsonSerializer.Serialize(doc, JsonOpts.Indented),
            new System.Text.UTF8Encoding(false));
    }

    // ─────────────────────────── Union-find ───────────────────────────
    private void Ensure(uint id) {
        if (_parent.ContainsKey(id)) return;
        _parent[id] = id;
        _rank[id] = 0;
    }

    private uint Find(uint id) {
        uint root = id;
        while (_parent[root] != root) root = _parent[root];
        // Path compression
        uint cur = id;
        while (_parent[cur] != root) {
            uint next = _parent[cur];
            _parent[cur] = root;
            cur = next;
        }
        return root;
    }

    private void Union(uint a, uint b) {
        uint ra = Find(a), rb = Find(b);
        if (ra == rb) return;
        if (_rank[ra] < _rank[rb]) (ra, rb) = (rb, ra);
        _parent[rb] = ra;
        if (_rank[ra] == _rank[rb]) _rank[ra]++;
    }
}

