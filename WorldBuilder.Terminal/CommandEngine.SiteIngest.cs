using System.Text.Json;
using System.Text.Json.Serialization;
using WorldBuilder.Shared.Lib.AceDb;
using WorldBuilder.Shared.Lib.Spawn;

namespace WorldBuilder.Terminal;

public partial class CommandEngine {
    // ─────────────────────────────────────────────────────────────────
    //  Real Map of Dereth: bulk ingest from the local ACE world DB into
    //  per-project gazetteer JSON files. The static-site emitter copies
    //  these files into the dist as overlays/<name>.js (creatures, npcs,
    //  housing). All writes go to the active project's directory; pass
    //  --out to override.
    // ─────────────────────────────────────────────────────────────────

    private static readonly JsonSerializerOptions GazetteerJsonOpts = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public async Task<IngestCreatureRosterResult> IngestCreatureRosterAsync(string? outPath = null) {
        RequireProject();
        try {
            using var connector = RequireAceDbConnector();
            var roster = await connector.IngestCreatureRosterAsync();
            string targetPath = outPath ?? Path.Combine(
                _projectManager.CurrentProject!.ProjectDirectory, "creature_gazetteer.json");
            File.WriteAllText(targetPath,
                JsonSerializer.Serialize(roster.Values, GazetteerJsonOpts));
            return new IngestCreatureRosterResult(true, roster.Count, targetPath);
        } catch (Exception ex) {
            return new IngestCreatureRosterResult(false, 0, null, ex.Message);
        }
    }

    public async Task<IngestNpcRosterResult> IngestNpcRosterAsync(string? outPath = null) {
        RequireProject();
        try {
            using var connector = RequireAceDbConnector();
            var roster = await connector.IngestNpcRosterAsync();
            string targetPath = outPath ?? Path.Combine(
                _projectManager.CurrentProject!.ProjectDirectory, "npc_gazetteer.json");
            File.WriteAllText(targetPath,
                JsonSerializer.Serialize(roster.Values, GazetteerJsonOpts));
            int vendorCount = roster.Values.Count(r => r.WeenieType == 20);
            int talkerCount = roster.Values.Count(r => r.WeenieType == 4);
            return new IngestNpcRosterResult(true, roster.Count, vendorCount, talkerCount, targetPath);
        } catch (Exception ex) {
            return new IngestNpcRosterResult(false, 0, 0, 0, null, ex.Message);
        }
    }

    public async Task<IngestHousingRosterResult> IngestHousingRosterAsync(string? outPath = null) {
        RequireProject();
        try {
            using var connector = RequireAceDbConnector();
            var roster = await connector.IngestHousingRosterAsync();
            string targetPath = outPath ?? Path.Combine(
                _projectManager.CurrentProject!.ProjectDirectory, "housing_gazetteer.json");
            // Flatten houses → array of portals with the parent house id, so
            // the frontend can render each portal as a marker without
            // needing to traverse a nested object.
            var flat = roster.SelectMany(kv => kv.Value.Select(h => new {
                houseId = h.HouseId,
                objCellId = h.ObjCellId,
                landblock = $"0x{(ushort)(h.ObjCellId >> 16):X4}",
                cell = (int)(h.ObjCellId & 0xFFFF),
                x = h.OriginX, y = h.OriginY, z = h.OriginZ,
            })).ToList();
            File.WriteAllText(targetPath,
                JsonSerializer.Serialize(flat, GazetteerJsonOpts));
            return new IngestHousingRosterResult(true, roster.Count, flat.Count, targetPath);
        } catch (Exception ex) {
            return new IngestHousingRosterResult(false, 0, 0, null, ex.Message);
        }
    }

    /// <summary>
    /// Compare the project's loaded spawn gazetteer against the canonical
    /// rosters ingested from the ACE DB. Returns Jaccard similarity +
    /// novel/missing wcid lists per category dimension (creatures, npcs,
    /// housing). When the local rosters are absent, all dimensions report
    /// retailCount=0 so the caller can still read a structured response.
    /// </summary>
    public CompareCreaturesResult CompareCreaturesToRetail() {
        RequireProject();
        try {
            string projectDir = _projectManager.CurrentProject!.ProjectDirectory;

            // Generated side: every wcid that appears in the loaded spawn
            // gazetteer, partitioned by the resolved Category.
            var genCreatures = new HashSet<int>();
            var genNpcs = new HashSet<int>();
            foreach (var spawns in _spawnGazetteer.Values) {
                foreach (var sp in spawns) {
                    if (sp.Category == "Creature") genCreatures.Add(sp.Wcid);
                    else if (sp.Category == "Npc") genNpcs.Add(sp.Wcid);
                }
            }

            // Retail side: read the ACE-DB-ingested gazetteer JSON files.
            // Missing files → empty sets (creators surface as novelInLb).
            var retailCreatures = LoadWcidSetFromGazetteer(
                Path.Combine(projectDir, "creature_gazetteer.json"));
            var retailNpcs = LoadWcidSetFromGazetteer(
                Path.Combine(projectDir, "npc_gazetteer.json"));

            // Housing isn't a wcid set; we report the raw counts and a
            // zero-Jaccard placeholder. Future wave can decide on a
            // sensible per-LB housing comparison.
            var housingPath = Path.Combine(projectDir, "housing_gazetteer.json");
            int housingRetail = File.Exists(housingPath)
                ? CountTopLevelArray(housingPath) : 0;

            return new CompareCreaturesResult(
                Success: true,
                Creatures: BuildDimension(genCreatures, retailCreatures),
                Npcs: BuildDimension(genNpcs, retailNpcs),
                Housing: new CompareCategoryDimension(0, housingRetail, 0.0,
                    new List<int>(), new List<int>()));
        } catch (Exception ex) {
            return new CompareCreaturesResult(false,
                new CompareCategoryDimension(0, 0, 0, new(), new()),
                new CompareCategoryDimension(0, 0, 0, new(), new()),
                new CompareCategoryDimension(0, 0, 0, new(), new()),
                ex.Message);
        }
    }

    private static CompareCategoryDimension BuildDimension(HashSet<int> generated, HashSet<int> retail) {
        if (generated.Count == 0 && retail.Count == 0) {
            return new CompareCategoryDimension(0, 0, 0, new(), new());
        }
        var union = new HashSet<int>(generated);
        union.UnionWith(retail);
        var intersection = new HashSet<int>(generated);
        intersection.IntersectWith(retail);
        double jaccard = union.Count == 0 ? 0 : (double)intersection.Count / union.Count;
        var novel = generated.Where(w => !retail.Contains(w)).OrderBy(w => w).Take(50).ToList();
        var missing = retail.Where(w => !generated.Contains(w)).OrderBy(w => w).Take(50).ToList();
        return new CompareCategoryDimension(generated.Count, retail.Count, jaccard, novel, missing);
    }

    private static HashSet<int> LoadWcidSetFromGazetteer(string path) {
        var result = new HashSet<int>();
        if (!File.Exists(path)) return result;
        try {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return result;
            foreach (var item in doc.RootElement.EnumerateArray()) {
                if (item.TryGetProperty("wcid", out var wEl)
                        && wEl.ValueKind == JsonValueKind.Number) {
                    result.Add(wEl.GetInt32());
                }
            }
        } catch { /* malformed → empty set */ }
        return result;
    }

    private static int CountTopLevelArray(string path) {
        try {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.ValueKind == JsonValueKind.Array)
                return doc.RootElement.GetArrayLength();
        } catch { }
        return 0;
    }

    /// <summary>
    /// Pull every <c>landblock_instance</c> row in the DB, join against
    /// the cached creature roster (so each spawn carries a name + type),
    /// and write the resulting <see cref="SpawnRecord"/> set as JSONL.
    /// Distinct from <c>ingest-spawn-maps</c> (which reads the LSD JSON
    /// dump) — this is the ACE-DB-grounded equivalent.
    /// </summary>
    public async Task<IngestAceSpawnsResult> IngestAceSpawnsAsync(string? outPath = null) {
        RequireProject();
        try {
            using var connector = RequireAceDbConnector();
            // Pull every outdoor + indoor row in one pass via a raw bulk
            // query rather than the per-LB shaped helpers — this method
            // walks the entire DB.
            var rows = await connector.GetAllInstancesAsync();
            var weenieIndex = new Dictionary<int, AceWeenieDescriptor>();
            try {
                var creatures = await connector.IngestCreatureRosterAsync();
                foreach (var c in creatures.Values) {
                    weenieIndex[c.Wcid] = new AceWeenieDescriptor(c.Wcid, c.DisplayName, 10);
                }
                var npcs = await connector.IngestNpcRosterAsync();
                foreach (var n in npcs.Values) {
                    weenieIndex[n.Wcid] = new AceWeenieDescriptor(n.Wcid, n.DisplayName, n.WeenieType);
                }
            } catch { /* roster failure → records flagged synthetic */ }

            var spawnsByLb = SpawnGazetteerBuilder.BuildFromAceLandblockInstances(rows, weenieIndex);
            int total = spawnsByLb.Values.Sum(v => v.Count);
            int synthetic = spawnsByLb.Values.SelectMany(v => v).Count(s => s.IsSynthetic);

            string targetPath = outPath ?? Path.Combine(
                _projectManager.CurrentProject!.ProjectDirectory, "ace_spawn_records.jsonl");
            using (var w = new StreamWriter(targetPath, append: false)) {
                foreach (var (lbId, spawns) in spawnsByLb) {
                    foreach (var sp in spawns) {
                        w.WriteLine(JsonSerializer.Serialize(sp, GazetteerJsonOpts));
                    }
                }
            }
            return new IngestAceSpawnsResult(true, spawnsByLb.Count, total, synthetic, targetPath);
        } catch (Exception ex) {
            return new IngestAceSpawnsResult(false, 0, 0, 0, null, ex.Message);
        }
    }
}
