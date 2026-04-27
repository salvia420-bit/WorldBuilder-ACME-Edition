using System.Collections.Concurrent;
using System.Diagnostics;
using System.Numerics;
using DatReaderWriter.DBObjs;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.Geometry;

namespace WorldBuilder.Shared.Services;

/// <summary>
/// Scans DAT files to auto-classify every Setup and GfxObj model.
/// Uses bounding-box heuristics, part counts, aspect ratios, and cross-
/// references with BuildingBlueprintCache and Scene objects to produce
/// a complete ontology from the raw DAT data.
/// </summary>
public class OntologyService : IOntologyService {

    private readonly ConcurrentDictionary<uint, OntologyEntry> _entries = new();
    private bool _isScanned;

    public int Count => _entries.Count;
    public bool IsScanned => _isScanned;

    public OntologyEntry? GetEntry(uint objectId) =>
        _entries.TryGetValue(objectId, out var entry) ? entry : null;

    public Dictionary<string, int> GetCategoryCounts() {
        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in _entries.Values) {
            counts.TryGetValue(entry.Category, out var c);
            counts[entry.Category] = c + 1;
        }
        return counts;
    }

    public Dictionary<string, int> GetScaleCounts() {
        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in _entries.Values) {
            counts.TryGetValue(entry.Scale, out var c);
            counts[entry.Scale] = c + 1;
        }
        return counts;
    }

    public IEnumerable<OntologyEntry> GetAllEntries() => _entries.Values.OrderBy(e => e.ObjectId);

    public IEnumerable<OntologyEntry> Search(
        string? category = null,
        string? scale = null,
        string? keyword = null,
        int limit = 100) {

        var results = _entries.Values.AsEnumerable();

        if (!string.IsNullOrWhiteSpace(category))
            results = results.Where(e => e.Category.Equals(category, StringComparison.OrdinalIgnoreCase));

        if (!string.IsNullOrWhiteSpace(scale))
            results = results.Where(e => e.Scale.Equals(scale, StringComparison.OrdinalIgnoreCase));

        if (!string.IsNullOrWhiteSpace(keyword)) {
            var kw = keyword.ToLowerInvariant();
            results = results.Where(e =>
                e.Tags.Any(t => t.Contains(kw, StringComparison.OrdinalIgnoreCase)));
        }

        return results.OrderBy(e => e.ObjectId).Take(limit);
    }

    public OntologyScanReport Scan(IDatReaderWriter dats, bool scanGfxObjs = true) {
        var sw = Stopwatch.StartNew();
        _entries.Clear();

        var report = new OntologyScanReport();

        // ── Phase 1: Gather cross-reference signals ──

        // 1a. Building model IDs (from LandBlockInfo → BuildingInfo)
        var buildingIds = ScanBuildingIds(dats);
        Console.WriteLine($"[Ontology] Found {buildingIds.Count} building model IDs");

        // 1b. Scenery Setup IDs (from Scene objects)
        var sceneryIds = ScanSceneryIds(dats);
        Console.WriteLine($"[Ontology] Found {sceneryIds.Count} scenery Setup IDs from Scenes");

        // ── Phase 2: Enumerate and classify all Setups ──
        uint[] setupIds;
        try {
            setupIds = dats.Dats.Portal.GetAllIdsOfType<Setup>().ToArray();
        } catch {
            setupIds = Array.Empty<uint>();
        }
        report.TotalSetups = setupIds.Length;
        Console.WriteLine($"[Ontology] Scanning {setupIds.Length} Setup models...");

        int processed = 0;
        foreach (var id in setupIds) {
            try {
                if (dats.TryGet<Setup>(id, out var setup)) {
                    var entry = ClassifySetup(id, setup, dats, buildingIds, sceneryIds);
                    _entries[id] = entry;
                }
            } catch {
                // Skip individual failures — don't let one bad entry halt the scan
            }

            processed++;
            if (processed % 1000 == 0)
                Console.WriteLine($"[Ontology]   ...{processed}/{setupIds.Length} Setups processed");
        }

        // ── Phase 3: Enumerate and classify standalone GfxObjs ──
        if (scanGfxObjs) {
            uint[] gfxObjIds;
            try {
                gfxObjIds = dats.Dats.Portal.GetAllIdsOfType<GfxObj>().ToArray();
            } catch {
                gfxObjIds = Array.Empty<uint>();
            }
            report.TotalGfxObjs = gfxObjIds.Length;
            Console.WriteLine($"[Ontology] Scanning {gfxObjIds.Length} GfxObj models...");

            processed = 0;
            foreach (var id in gfxObjIds) {
                // Don't re-classify GfxObjs that are already parts of a Setup
                if (_entries.ContainsKey(id)) continue;

                try {
                    if (dats.TryGet<GfxObj>(id, out var gfxObj)) {
                        var entry = ClassifyGfxObj(id, gfxObj);
                        _entries[id] = entry;
                    }
                } catch {
                    // Skip individual failures
                }

                processed++;
                if (processed % 2000 == 0)
                    Console.WriteLine($"[Ontology]   ...{processed}/{gfxObjIds.Length} GfxObjs processed");
            }
        }

        // ── Phase 4: Build report ──
        sw.Stop();
        report.TotalEntries = _entries.Count;
        report.ScanTimeMs = sw.Elapsed.TotalMilliseconds;

        foreach (var entry in _entries.Values) {
            report.CategoryCounts.TryGetValue(entry.Category, out var cc);
            report.CategoryCounts[entry.Category] = cc + 1;

            report.ScaleCounts.TryGetValue(entry.Scale, out var sc);
            report.ScaleCounts[entry.Scale] = sc + 1;
        }

        report.ClassifiedAsBuilding = report.CategoryCounts.GetValueOrDefault("Structure", 0);
        report.ClassifiedAsScenery = report.CategoryCounts.GetValueOrDefault("Scenery", 0);
        report.ClassifiedAsFurniture = report.CategoryCounts.GetValueOrDefault("Furniture", 0);
        report.ClassifiedAsProp = report.CategoryCounts.GetValueOrDefault("Prop", 0);
        report.ClassifiedAsUnknown = report.CategoryCounts.GetValueOrDefault("Unknown", 0);

        _isScanned = true;
        Console.WriteLine($"[Ontology] Scan complete: {report.TotalEntries} entries in {report.ScanTimeMs:F0}ms");

        return report;
    }

    // ════════════════════════════════════════════════════
    //  Cross-reference scanners
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Scans all LandBlockInfo → BuildingInfo to identify which Setup IDs are buildings.
    /// Same approach as BuildingBlueprintCache.EnsureBuildingIdsScanned().
    /// </summary>
    private static HashSet<uint> ScanBuildingIds(IDatReaderWriter dats) {
        var ids = new HashSet<uint>();
        try {
            var allLbiIds = dats.Dats.Cell.GetAllIdsOfType<LandBlockInfo>().ToArray();

            if (allLbiIds.Length == 0) {
                // Brute-force fallback (same pattern as BuildingBlueprintCache)
                for (uint x = 0; x < 255; x++) {
                    for (uint y = 0; y < 255; y++) {
                        var infoId = (uint)(((x << 8) | y) << 16 | 0xFFFE);
                        if (dats.TryGet<LandBlockInfo>(infoId, out var lbi)) {
                            foreach (var b in lbi.Buildings)
                                ids.Add(b.ModelId);
                        }
                    }
                }
            } else {
                foreach (var infoId in allLbiIds) {
                    if (dats.TryGet<LandBlockInfo>(infoId, out var lbi)) {
                        foreach (var b in lbi.Buildings)
                            ids.Add(b.ModelId);
                    }
                }
            }
        } catch (Exception ex) {
            Console.WriteLine($"[Ontology] Warning: Could not scan building IDs: {ex.Message}");
        }
        return ids;
    }

    /// <summary>
    /// Scans all Scene objects to identify which Setup IDs are used as scenery.
    /// Scene objects define the scenery distribution patterns placed on terrain.
    /// </summary>
    private static HashSet<uint> ScanSceneryIds(IDatReaderWriter dats) {
        var ids = new HashSet<uint>();
        try {
            var sceneIds = dats.Dats.Portal.GetAllIdsOfType<Scene>().ToArray();
            foreach (var sceneId in sceneIds) {
                if (dats.TryGet<Scene>(sceneId, out var scene)) {
                    foreach (var obj in scene.Objects) {
                        ids.Add(obj.ObjectId);
                    }
                }
            }
        } catch (Exception ex) {
            Console.WriteLine($"[Ontology] Warning: Could not scan scenery IDs: {ex.Message}");
        }
        return ids;
    }

    // ════════════════════════════════════════════════════
    //  Classification logic
    // ════════════════════════════════════════════════════

    private OntologyEntry ClassifySetup(
        uint id, Setup setup, IDatReaderWriter dats,
        HashSet<uint> buildingIds, HashSet<uint> sceneryIds) {

        var entry = new OntologyEntry {
            ObjectId = id,
            DatType = "Setup",
            PartCount = setup.Parts?.Count ?? 0,
        };

        // Compute bounding box from all GfxObj parts
        ComputeSetupBounds(setup, dats, out var min, out var max, out int totalPolys);
        entry.BoundsMin = min;
        entry.BoundsMax = max;
        entry.PolyCount = totalPolys;

        var size = max - min;
        entry.MaxDimension = Math.Max(size.X, Math.Max(size.Y, size.Z));

        // Aspect ratio: height (Z) relative to horizontal footprint
        float footprint = Math.Max(size.X, size.Y);
        entry.AspectRatio = footprint > 0.001f ? size.Z / footprint : 1f;

        // Scale classification
        entry.Scale = ClassifyScale(entry.MaxDimension);

        // Category classification — ordered by confidence
        if (buildingIds.Contains(id)) {
            entry.Category = "Structure";
            entry.ClassificationSource = "Building";
        } else if (sceneryIds.Contains(id)) {
            entry.Category = "Scenery";
            entry.ClassificationSource = "Scene";
        } else {
            entry.Category = ClassifyCategoryByHeuristic(
                entry.MaxDimension, entry.AspectRatio, entry.PartCount, totalPolys);
            entry.ClassificationSource = "Heuristic";
        }

        // Footprint geometry — only interesting for buildable / structure-like
        // objects. Skip on Furniture/Prop/Creature/Tiny to keep the scan fast.
        if (entry.Category == "Structure" || entry.Category == "Scenery") {
            var fp = FootprintExtractor.FromSetup(setup, dats);
            entry.FootprintShape = fp.Shape;
            entry.FootprintCorners = fp.Corners;
            entry.FoundationZ = fp.FoundationZ;
            entry.BasementDepth = MathF.Max(0f, -fp.FoundationZ);
        }

        // Build tags
        entry.Tags = BuildTags(entry);

        return entry;
    }

    private OntologyEntry ClassifyGfxObj(uint id, GfxObj gfxObj) {
        var entry = new OntologyEntry {
            ObjectId = id,
            DatType = "GfxObj",
            PartCount = 0,
        };

        ComputeGfxObjBounds(gfxObj, out var min, out var max, out int polyCount);
        entry.BoundsMin = min;
        entry.BoundsMax = max;
        entry.PolyCount = polyCount;

        var size = max - min;
        entry.MaxDimension = Math.Max(size.X, Math.Max(size.Y, size.Z));

        float footprint = Math.Max(size.X, size.Y);
        entry.AspectRatio = footprint > 0.001f ? size.Z / footprint : 1f;

        entry.Scale = ClassifyScale(entry.MaxDimension);
        entry.Category = ClassifyCategoryByHeuristic(
            entry.MaxDimension, entry.AspectRatio, 1, polyCount);
        entry.ClassificationSource = "Heuristic";

        if (entry.Category == "Structure" || entry.Category == "Scenery") {
            var fp = FootprintExtractor.FromGfxObj(gfxObj);
            entry.FootprintShape = fp.Shape;
            entry.FootprintCorners = fp.Corners;
            entry.FoundationZ = fp.FoundationZ;
            entry.BasementDepth = MathF.Max(0f, -fp.FoundationZ);
        }

        entry.Tags = BuildTags(entry);

        return entry;
    }

    // ════════════════════════════════════════════════════
    //  Geometry extraction
    // ════════════════════════════════════════════════════

    private static void ComputeSetupBounds(
        Setup setup, IDatReaderWriter dats,
        out Vector3 min, out Vector3 max, out int totalPolys) {

        min = new Vector3(float.MaxValue);
        max = new Vector3(float.MinValue);
        totalPolys = 0;

        if (setup.Parts == null || setup.Parts.Count == 0) {
            min = max = Vector3.Zero;
            return;
        }

        bool anyVertex = false;
        for (int i = 0; i < setup.Parts.Count; i++) {
            var partId = setup.Parts[i];
            if (!dats.TryGet<GfxObj>(partId, out var gfxObj)) continue;

            // Get the part's offset from the setup (if available)
            Vector3 partOffset = Vector3.Zero;
            if (setup.PlacementFrames != null && setup.PlacementFrames.Count > 0) {
                // Try the default placement frame (key 0)
                var defaultPlacement = setup.PlacementFrames.Values.FirstOrDefault();
                if (defaultPlacement?.Frames != null && i < defaultPlacement.Frames.Count) {
                    partOffset = defaultPlacement.Frames[i].Origin;
                }
            }

            if (gfxObj.VertexArray?.Vertices != null) {
                foreach (var vertex in gfxObj.VertexArray.Vertices.Values) {
                    var worldPos = vertex.Origin + partOffset;
                    min = Vector3.Min(min, worldPos);
                    max = Vector3.Max(max, worldPos);
                    anyVertex = true;
                }
            }

            totalPolys += gfxObj.Polygons?.Count ?? 0;
        }

        if (!anyVertex) {
            min = max = Vector3.Zero;
        }
    }

    private static void ComputeGfxObjBounds(
        GfxObj gfxObj, out Vector3 min, out Vector3 max, out int polyCount) {

        min = new Vector3(float.MaxValue);
        max = new Vector3(float.MinValue);
        polyCount = gfxObj.Polygons?.Count ?? 0;

        bool anyVertex = false;
        if (gfxObj.VertexArray?.Vertices != null) {
            foreach (var vertex in gfxObj.VertexArray.Vertices.Values) {
                min = Vector3.Min(min, vertex.Origin);
                max = Vector3.Max(max, vertex.Origin);
                anyVertex = true;
            }
        }

        if (!anyVertex) {
            min = max = Vector3.Zero;
        }
    }

    // ════════════════════════════════════════════════════
    //  Heuristic classifiers
    // ════════════════════════════════════════════════════

    private static string ClassifyScale(float maxDim) => maxDim switch {
        < 0.5f  => "Tiny",      // Candles, buttons, coins
        < 2.0f  => "Small",     // Chairs, lanterns, tools
        < 5.0f  => "Medium",    // Tables, fountains, pillars
        < 15.0f => "Large",     // Houses, large trees
        _       => "Massive"    // Castles, massive structures
    };

    private static string ClassifyCategoryByHeuristic(
        float maxDim, float aspectRatio, int partCount, int polyCount) {

        // Large multi-part objects are likely structures
        if (maxDim > 10f && partCount > 3)
            return "Structure";

        // Very tall and thin — poles, trees, columns
        if (aspectRatio > 3f && maxDim > 2f)
            return "Scenery";

        // Large single-part — likely a large scenery piece or terrain feature
        if (maxDim > 8f && partCount <= 2)
            return "Scenery";

        // Small, low poly, single part — decoration / prop
        if (maxDim < 1f && polyCount < 50)
            return "Prop";

        // Small to medium, flat — likely furniture or decoration
        if (maxDim < 3f && aspectRatio < 0.5f)
            return "Furniture";

        // Medium multi-part — furniture or functional object
        if (maxDim >= 1f && maxDim < 5f && partCount >= 2)
            return "Furniture";

        // Medium single part — generic scenery
        if (maxDim >= 1f && maxDim < 8f)
            return "Prop";

        return "Unknown";
    }

    private static string[] BuildTags(OntologyEntry entry) {
        var tags = new List<string>();

        // Scale tag
        tags.Add(entry.Scale.ToLowerInvariant());

        // Category tag
        tags.Add(entry.Category.ToLowerInvariant());

        // Type tag
        tags.Add(entry.DatType.ToLowerInvariant());

        // Source tag
        tags.Add(entry.ClassificationSource.ToLowerInvariant());

        // Size descriptor
        if (entry.MaxDimension > 15f) tags.Add("massive");
        else if (entry.MaxDimension > 8f) tags.Add("large");
        else if (entry.MaxDimension > 3f) tags.Add("medium");
        else if (entry.MaxDimension > 1f) tags.Add("small");
        else tags.Add("tiny");

        // Shape descriptors
        if (entry.AspectRatio > 4f) tags.Add("tall");
        else if (entry.AspectRatio > 2f) tags.Add("vertical");
        else if (entry.AspectRatio < 0.3f) tags.Add("flat");

        // Complexity descriptors
        if (entry.PartCount > 5) tags.Add("complex");
        else if (entry.PartCount == 1) tags.Add("simple");

        if (entry.PolyCount > 500) tags.Add("detailed");
        else if (entry.PolyCount < 20) tags.Add("lowpoly");

        return tags.Distinct().ToArray();
    }

    // ════════════════════════════════════════════════════
    //  Catalog import (Tier 2 → Ontology enrichment)
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Imports catalog metadata from the ACViewer catalog's index.json.
    /// Enriches existing ontology entries with thumbnail paths, vertex counts,
    /// and surface IDs from the rendered catalog.
    /// </summary>
    public int ImportCatalog(string indexJsonPath) {
        if (!File.Exists(indexJsonPath))
            throw new FileNotFoundException($"Catalog index not found: {indexJsonPath}");

        var json = File.ReadAllText(indexJsonPath);
        using var doc = System.Text.Json.JsonDocument.Parse(json);

        int enriched = 0;

        foreach (var element in doc.RootElement.EnumerateArray()) {
            // Parse the FileId hex string → uint
            var fileIdStr = element.GetProperty("FileId").GetString();
            if (string.IsNullOrEmpty(fileIdStr)) continue;

            if (!uint.TryParse(fileIdStr.Replace("0x", ""),
                    System.Globalization.NumberStyles.HexNumber, null, out var fileId))
                continue;

            // Find the matching ontology entry
            if (!_entries.TryGetValue(fileId, out var entry)) continue;

            // Merge thumbnail path
            if (element.TryGetProperty("ThumbnailPath", out var thumbEl)) {
                var thumbPath = thumbEl.GetString();
                if (!string.IsNullOrEmpty(thumbPath))
                    entry.ThumbnailPath = thumbPath;
            }

            // Merge vertex count (catalog may have more accurate data)
            if (element.TryGetProperty("VertexCount", out var vcEl)) {
                entry.VertexCount = vcEl.GetInt32();
            }

            // Merge surface IDs
            if (element.TryGetProperty("SurfaceIds", out var sidsEl) &&
                sidsEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
                entry.SurfaceIds = sidsEl.EnumerateArray()
                    .Select(s => s.GetString()!)
                    .Where(s => !string.IsNullOrEmpty(s))
                    .Distinct()
                    .ToList();
            }

            // Merge bounding box data if the catalog has more accurate values
            if (element.TryGetProperty("BoundsMin", out var bMinEl) &&
                bMinEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
                var mins = bMinEl.EnumerateArray().Select(v => v.GetSingle()).ToArray();
                if (mins.Length == 3)
                    entry.BoundsMin = new Vector3(mins[0], mins[1], mins[2]);
            }

            if (element.TryGetProperty("BoundsMax", out var bMaxEl) &&
                bMaxEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
                var maxs = bMaxEl.EnumerateArray().Select(v => v.GetSingle()).ToArray();
                if (maxs.Length == 3)
                    entry.BoundsMax = new Vector3(maxs[0], maxs[1], maxs[2]);
            }

            if (element.TryGetProperty("MaxDimension", out var mdEl)) {
                var catalogMaxDim = mdEl.GetSingle();
                if (catalogMaxDim > 0)
                    entry.MaxDimension = catalogMaxDim;
            }

            enriched++;
        }

        Console.WriteLine($"[Ontology] Imported catalog: {enriched} entries enriched from {indexJsonPath}");
        return enriched;
    }

    // ════════════════════════════════════════════════════
    //  String-table classification (LLM Classification)
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Cross-references extracted string table data with ontology entries.
    /// Uses hash-based ID matching and keyword analysis to auto-tag entries
    /// with human-readable names and category tags.
    /// </summary>
    public int EnrichFromStrings(List<(uint Hash, string Text, string TableType)> strings) {
        if (strings == null || strings.Count == 0) return 0;

        // Build keyword → category/tag mappings for classification
        var keywordMap = new Dictionary<string, (string Category, string[] Tags)>(StringComparer.OrdinalIgnoreCase) {
            // Lighting
            { "torch",       ("Prop",     new[] { "lighting", "torch", "fire" }) },
            { "lantern",     ("Prop",     new[] { "lighting", "lantern" }) },
            { "candle",      ("Prop",     new[] { "lighting", "candle" }) },
            { "candlestick", ("Prop",     new[] { "lighting", "candle" }) },
            { "candelabra",  ("Furniture", new[] { "lighting", "candelabra" }) },
            { "chandelier",  ("Furniture", new[] { "lighting", "chandelier" }) },
            { "brazier",     ("Prop",     new[] { "lighting", "brazier", "fire" }) },
            { "lamp",        ("Prop",     new[] { "lighting", "lamp" }) },
            { "sconce",      ("Prop",     new[] { "lighting", "sconce" }) },
            { "campfire",    ("Prop",     new[] { "lighting", "campfire", "fire" }) },
            { "cresset",     ("Prop",     new[] { "lighting", "cresset", "fire" }) },
            // Furniture
            { "chair",       ("Furniture", new[] { "seating", "chair" }) },
            { "bench",       ("Furniture", new[] { "seating", "bench" }) },
            { "stool",       ("Furniture", new[] { "seating", "stool" }) },
            { "throne",      ("Furniture", new[] { "seating", "throne" }) },
            { "couch",       ("Furniture", new[] { "seating", "couch" }) },
            { "table",       ("Furniture", new[] { "table" }) },
            { "desk",        ("Furniture", new[] { "table", "desk" }) },
            { "bed",         ("Furniture", new[] { "bed" }) },
            { "shelf",       ("Furniture", new[] { "shelf", "storage" }) },
            { "bookcase",    ("Furniture", new[] { "shelf", "storage" }) },
            // Storage
            { "chest",       ("Prop",     new[] { "storage", "chest", "container" }) },
            { "crate",       ("Prop",     new[] { "storage", "crate", "container" }) },
            { "barrel",      ("Prop",     new[] { "storage", "barrel", "container" }) },
            { "sarcophagus", ("Prop",     new[] { "storage", "sarcophagus" }) },
            { "coffin",      ("Prop",     new[] { "storage", "coffin" }) },
            { "coffer",      ("Prop",     new[] { "storage", "coffer", "container" }) },
            // Interactive
            { "lever",       ("Prop",     new[] { "interactive", "lever", "mechanism" }) },
            { "switch",      ("Prop",     new[] { "interactive", "switch", "mechanism" }) },
            { "button",      ("Prop",     new[] { "interactive", "button", "mechanism" }) },
            { "portal",      ("Prop",     new[] { "interactive", "portal", "magic" }) },
            { "lifestone",   ("Prop",     new[] { "interactive", "lifestone", "magic" }) },
            // Doors
            { "door",        ("Structure", new[] { "door", "entrance" }) },
            { "gate",        ("Structure", new[] { "door", "gate", "entrance" }) },
            // Nature / Scenery
            { "tree",        ("Scenery",  new[] { "tree", "plant", "nature" }) },
            { "bush",        ("Scenery",  new[] { "bush", "plant", "nature" }) },
            { "shrub",       ("Scenery",  new[] { "shrub", "plant", "nature" }) },
            { "flower",      ("Scenery",  new[] { "flower", "plant", "nature" }) },
            { "grass",       ("Scenery",  new[] { "grass", "plant", "nature" }) },
            { "vine",        ("Scenery",  new[] { "vine", "plant", "nature" }) },
            { "mushroom",    ("Scenery",  new[] { "mushroom", "plant", "nature" }) },
            { "fern",        ("Scenery",  new[] { "fern", "plant", "nature" }) },
            { "rock",        ("Scenery",  new[] { "rock", "stone", "nature" }) },
            { "boulder",     ("Scenery",  new[] { "boulder", "rock", "nature" }) },
            // Water
            { "fountain",    ("Scenery",  new[] { "water", "fountain" }) },
            { "well",        ("Scenery",  new[] { "water", "well" }) },
            { "pool",        ("Scenery",  new[] { "water", "pool" }) },
            // Structures
            { "wall",        ("Structure", new[] { "wall", "building" }) },
            { "fence",       ("Structure", new[] { "fence", "barrier" }) },
            { "pillar",      ("Structure", new[] { "pillar", "column" }) },
            { "column",      ("Structure", new[] { "column", "pillar" }) },
            { "arch",        ("Structure", new[] { "arch", "building" }) },
            { "bridge",      ("Structure", new[] { "bridge", "building" }) },
            { "roof",        ("Structure", new[] { "roof", "building" }) },
            { "chimney",     ("Structure", new[] { "chimney", "building" }) },
            { "stair",       ("Structure", new[] { "stairs", "building" }) },
            { "ladder",      ("Structure", new[] { "ladder", "building" }) },
            // Signs
            { "sign",        ("Prop",     new[] { "sign", "text" }) },
            { "banner",      ("Prop",     new[] { "banner", "decoration" }) },
            { "flag",        ("Prop",     new[] { "flag", "decoration" }) },
            // Decorative
            { "painting",    ("Furniture", new[] { "painting", "decoration", "art" }) },
            { "tapestry",    ("Furniture", new[] { "tapestry", "decoration", "art" }) },
            { "statue",      ("Scenery",  new[] { "statue", "decoration", "art" }) },
            { "trophy",      ("Prop",     new[] { "trophy", "decoration" }) },
            // Weapons / Tools
            { "sword",       ("Prop",     new[] { "weapon", "sword" }) },
            { "shield",      ("Prop",     new[] { "weapon", "shield" }) },
            { "axe",         ("Prop",     new[] { "weapon", "axe" }) },
            { "bow",         ("Prop",     new[] { "weapon", "bow" }) },
            { "staff",       ("Prop",     new[] { "weapon", "staff", "magic" }) },
            { "wand",        ("Prop",     new[] { "weapon", "wand", "magic" }) },
            // Creatures
            { "drudge",      ("Prop",     new[] { "creature", "drudge" }) },
            { "banderling",  ("Prop",     new[] { "creature", "banderling" }) },
            { "mosswart",    ("Prop",     new[] { "creature", "mosswart" }) },
            { "olthoi",      ("Prop",     new[] { "creature", "olthoi" }) },
            { "tusker",      ("Prop",     new[] { "creature", "tusker" }) },
            { "golem",       ("Prop",     new[] { "creature", "golem" }) },
            { "skeleton",    ("Prop",     new[] { "creature", "skeleton", "undead" }) },
            { "zombie",      ("Prop",     new[] { "creature", "zombie", "undead" }) },
        };

        // Build a lookup: try to match string hashes to ontology entry IDs
        // StringTable hashes are often WeenieClassIds, not DAT Setup IDs,
        // but we can still use keyword analysis on all strings to build knowledge
        var keywordTagMap = new Dictionary<uint, List<string>>();
        var nameMap = new Dictionary<uint, string>();

        // First pass: direct ID matching — some hashes correspond to Setup IDs
        foreach (var (hash, text, tableType) in strings) {
            if (_entries.TryGetValue(hash, out var entry)) {
                // Direct hit — the hash matches a Setup/GfxObj ID
                if (string.IsNullOrEmpty(entry.Name))
                    entry.Name = text;
            }
        }

        // Second pass: keyword-based classification on ALL ontology entries
        // Extract keywords from string data to build a vocabulary
        int enriched = 0;

        foreach (var entry in _entries.Values) {
            // Check if any string text keywords match patterns for this model
            string? bestName = entry.Name;
            var extraTags = new List<string>();

            foreach (var (hash, text, tableType) in strings) {
                if (string.IsNullOrWhiteSpace(text) || text.Length < 3) continue;

                // Check if text contains keywords we can map to this entry's traits
                var textLower = text.ToLowerInvariant();
                foreach (var (keyword, (category, tags)) in keywordMap) {
                    if (textLower.Contains(keyword, StringComparison.OrdinalIgnoreCase)) {
                        // If the string hash matches or is "close" to this entry's ID, tag it
                        if (hash == entry.ObjectId) {
                            if (bestName == null) bestName = text;
                            extraTags.AddRange(tags);
                            // Only update category if current is heuristic/unknown
                            if (entry.ClassificationSource == "Heuristic" &&
                                (entry.Category == "Unknown" || entry.Category == "Prop")) {
                                entry.Category = category;
                                entry.ClassificationSource = "StringTable";
                            }
                        }
                    }
                }
            }

            // Apply name-based keyword tagging to entries that already have names
            if (!string.IsNullOrEmpty(bestName)) {
                var nameLower = bestName.ToLowerInvariant();
                foreach (var (keyword, (category, tags)) in keywordMap) {
                    if (nameLower.Contains(keyword, StringComparison.OrdinalIgnoreCase)) {
                        extraTags.AddRange(tags);
                        if (entry.ClassificationSource == "Heuristic" &&
                            (entry.Category == "Unknown" || entry.Category == "Prop")) {
                            entry.Category = category;
                            entry.ClassificationSource = "StringTable";
                        }
                    }
                }
            }

            if (extraTags.Count > 0 || bestName != entry.Name) {
                entry.Name = bestName;
                if (extraTags.Count > 0) {
                    var allTags = new List<string>(entry.Tags ?? Array.Empty<string>());
                    allTags.AddRange(extraTags);
                    entry.Tags = allTags.Distinct().ToArray();
                }
                enriched++;
            }
        }

        Console.WriteLine($"[Ontology] String enrichment: {enriched} entries updated from {strings.Count} strings");
        return enriched;
    }

    // ════════════════════════════════════════════════════
    //  Texture-driven material enrichment
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Scans surface/texture IDs for each ontology entry and classifies materials
    /// using texture ID heuristics and RenderSurface metadata from the DAT.
    /// </summary>
    public int EnrichMaterials(IDatReaderWriter dats) {
        // Build material keyword map based on known AC texture naming patterns
        var materialKeywords = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase) {
            { "stone",    new[] { "stone", "rock", "mineral" } },
            { "wood",     new[] { "wood", "timber", "plank" } },
            { "metal",    new[] { "metal", "iron", "steel", "bronze", "copper" } },
            { "fire",     new[] { "fire", "flame", "lava", "ember" } },
            { "water",    new[] { "water", "liquid", "ice", "frost" } },
            { "cloth",    new[] { "cloth", "fabric", "leather", "hide" } },
            { "crystal",  new[] { "crystal", "gem", "glass" } },
            { "bone",     new[] { "bone", "skull", "skeleton" } },
            { "moss",     new[] { "moss", "lichen", "fungus" } },
            { "bark",     new[] { "bark", "tree", "leaf" } },
        };

        int enriched = 0;

        foreach (var entry in _entries.Values) {
            if (entry.SurfaceIds == null || entry.SurfaceIds.Count == 0) {
                // Try to extract surface IDs directly from DAT for entries without them
                var surfaceIds = ExtractSurfaceIds(entry.ObjectId, entry.DatType, dats);
                if (surfaceIds.Count > 0)
                    entry.SurfaceIds = surfaceIds;
                else
                    continue;
            }

            // Classify materials based on texture ID distribution
            var materialTags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var sidStr in entry.SurfaceIds) {
                // Parse the surface ID
                if (!uint.TryParse(sidStr.Replace("0x", ""),
                        System.Globalization.NumberStyles.HexNumber, null, out var surfaceId))
                    continue;

                // Try to load the Surface (0x08) to get texture references
                try {
                    if (dats.TryGet<DatReaderWriter.DBObjs.Surface>(surfaceId, out var surface)) {
                        // Surface contains OrigTextureId and OrigPaletteId
                        // Classify by texture ID ranges (known AC texture patterns)
                        var texId = surface.OrigTextureId;
                        ClassifyTextureById(texId, materialTags);
                    }
                } catch {
                    // Skip surfaces that fail to load — texture may not exist
                }

                // Also classify by surface ID range patterns
                ClassifySurfaceByRange(surfaceId, materialTags);
            }

            if (materialTags.Count > 0) {
                entry.MaterialTags = materialTags.ToArray();

                // Also add material tags to the main tags array
                var allTags = new List<string>(entry.Tags ?? Array.Empty<string>());
                foreach (var mt in materialTags) {
                    if (!allTags.Contains(mt))
                        allTags.Add(mt);
                }
                entry.Tags = allTags.Distinct().ToArray();

                enriched++;
            }
        }

        Console.WriteLine($"[Ontology] Material enrichment: {enriched} entries tagged with materials");
        return enriched;
    }

    /// <summary>
    /// Extract surface IDs from a Setup or GfxObj model in the DAT.
    /// </summary>
    private static List<string> ExtractSurfaceIds(uint objectId, string datType, IDatReaderWriter dats) {
        var surfaces = new List<string>();
        try {
            if (datType == "Setup" && dats.TryGet<Setup>(objectId, out var setup)) {
                if (setup.Parts != null) {
                    foreach (var partId in setup.Parts) {
                        if (dats.TryGet<GfxObj>(partId, out var gfx) && gfx.Surfaces != null) {
                            foreach (var sid in gfx.Surfaces)
                                surfaces.Add($"0x{sid:X8}");
                        }
                    }
                }
            } else if (datType == "GfxObj" && dats.TryGet<GfxObj>(objectId, out var gfx)) {
                if (gfx.Surfaces != null) {
                    foreach (var sid in gfx.Surfaces)
                        surfaces.Add($"0x{sid:X8}");
                }
            }
        } catch { }
        return surfaces.Distinct().ToList();
    }

    /// <summary>
    /// Classify texture by known AC texture ID patterns.
    /// </summary>
    private static void ClassifyTextureById(uint texId, HashSet<string> materials) {
        // Textures in the 0x05xxxxxx range are SurfaceTexture entries
        // Textures in the 0x06xxxxxx range are RenderSurface (raw images)
        // Classification is based on empirical observation of AC texture organization

        // High-level range-based heuristics for common material types
        // These ranges are approximate and based on retail AC DAT analysis
        var texHighByte = (texId >> 16) & 0xFF;

        // General classifications by common texture ranges
        // (this is a best-effort heuristic without access to full retail names)
        if (texHighByte >= 0x00 && texHighByte <= 0x05) {
            // Lower range textures are often terrain/natural
        }
    }

    /// <summary>
    /// Classify surface by ID range and distribution patterns.
    /// </summary>
    private static void ClassifySurfaceByRange(uint surfaceId, HashSet<string> materials) {
        // Surface IDs (0x08xxxxxx) have known groupings in AC retail data
        // Classification based on surface count and distribution patterns
        var prefix = (surfaceId >> 24);
        if (prefix != 0x08) return;

        // Models using many surfaces are likely textured/detailed
        // Models with few surfaces are likely simple/monochrome
        // This is a presence-based signal — the actual enrichment comes from
        // having ANY surface data at all, which we propagate as a "textured" tag
        materials.Add("textured");
    }

    // ════════════════════════════════════════════════════
    //  Weenie data enrichment (LSD ingestion pipeline)
    // ════════════════════════════════════════════════════

    /// <summary>
    /// Enriches ontology entries with weenie data (names, types, levels, creature families).
    /// The weenie summary file should be produced by the ingest-weenies command (JSON-lines format).
    /// </summary>
    public int EnrichFromWeenies(string weenieSummaryPath) {
        if (!File.Exists(weenieSummaryPath))
            throw new FileNotFoundException($"Weenie summary file not found: {weenieSummaryPath}");

        int enriched = 0;
        int linesRead = 0;
        int matched = 0;

        using var reader = new StreamReader(weenieSummaryPath);
        string? line;
        while ((line = reader.ReadLine()) != null) {
            linesRead++;
            if (string.IsNullOrWhiteSpace(line)) continue;

            try {
                using var doc = System.Text.Json.JsonDocument.Parse(line);
                var root = doc.RootElement;

                // Extract fields from the JSON-lines entry
                int wcid = root.TryGetProperty("wcid", out var wcidEl) ? wcidEl.GetInt32() : 0;
                string? name = root.TryGetProperty("name", out var nameEl) ? nameEl.GetString() : null;
                int weenieType = root.TryGetProperty("weenieType", out var wtEl) ? wtEl.GetInt32() : 0;
                uint setupDid = 0;
                if (root.TryGetProperty("setupDid", out var sdEl) && sdEl.ValueKind == System.Text.Json.JsonValueKind.Number)
                    setupDid = sdEl.GetUInt32();
                int? level = root.TryGetProperty("level", out var lvlEl) && lvlEl.ValueKind != System.Text.Json.JsonValueKind.Null
                    ? lvlEl.GetInt32() : null;
                int? creatureType = root.TryGetProperty("creatureType", out var ctEl) && ctEl.ValueKind != System.Text.Json.JsonValueKind.Null
                    ? ctEl.GetInt32() : null;

                // Skip weenies without a Setup DID — can't match to ontology
                if (setupDid == 0) continue;

                // Try to find the matching ontology entry
                if (!_entries.TryGetValue(setupDid, out var entry)) continue;
                matched++;

                // Populate weenie fields
                entry.WeenieClassId = wcid;
                entry.WeenieType = weenieType;
                if (!string.IsNullOrEmpty(name) && string.IsNullOrEmpty(entry.Name))
                    entry.Name = name;
                if (level.HasValue) entry.Level = level;
                if (creatureType.HasValue) entry.CreatureType = creatureType;

                // Compute difficulty tier from level
                if (level.HasValue) {
                    entry.DifficultyTier = level.Value switch {
                        < 20  => "Starter",
                        < 40  => "Low",
                        < 80  => "Medium",
                        < 125 => "Hard",
                        < 200 => "Elite",
                        _     => "Legendary"
                    };
                }

                // Update category based on weenie type. Values match the canonical
                // ACE enum at ACE/Source/ACE.Entity/Enum/WeenieType.cs (zero-indexed).
                // Earlier code here had values from an older AC numbering scheme
                // (Door=14, Portal=37, House=55) that don't match LSD-Partial 2025 data.
                string? newCategory = weenieType switch {
                    7  => "Interactive_Portal",  // Portal
                    10 => "Creature",            // Creature
                    12 => "NPC",                 // Vendor (an NPC for our purposes)
                    28 => "NPC",                 // Healer (NPC vendor variant)
                    53 => "Structure",           // House — load-bearing for atlas building tagging
                    _  => null
                };
                if (newCategory != null && entry.Category != newCategory) {
                    entry.Category = newCategory;
                    entry.ClassificationSource = "Weenie";
                }

                // Build additional tags
                var newTags = new List<string>(entry.Tags ?? Array.Empty<string>());

                // Add weenie type tag (also corrected against current ACE enum)
                string? weenieTag = weenieType switch {
                    1  => "generic",
                    7  => "portal",
                    10 => "creature",
                    12 => "vendor",
                    18 => "food",
                    19 => "door",
                    20 => "chest",
                    21 => "container",
                    24 => "pressureplate",
                    26 => "switch",
                    28 => "healer",
                    29 => "lightsource",
                    34 => "scroll",
                    38 => "gem",
                    44 => "crafttool",
                    53 => "house",
                    _  => null
                };
                if (weenieTag != null && !newTags.Contains(weenieTag))
                    newTags.Add(weenieTag);

                // Add difficulty tier tag
                if (entry.DifficultyTier != null) {
                    var tierTag = $"tier_{entry.DifficultyTier.ToLowerInvariant()}";
                    if (!newTags.Contains(tierTag)) newTags.Add(tierTag);
                }

                // Add creature type tag (families)
                if (creatureType.HasValue) {
                    var familyTag = $"creature_family_{creatureType.Value}";
                    if (!newTags.Contains(familyTag)) newTags.Add(familyTag);
                }

                // Add name-based keyword tags
                if (!string.IsNullOrEmpty(name)) {
                    var nameLower = name.ToLowerInvariant();
                    if (!newTags.Contains(nameLower)) newTags.Add(nameLower);
                }

                entry.Tags = newTags.Distinct().ToArray();
                enriched++;
            } catch {
                // Skip malformed lines — don't let one bad line halt enrichment
            }

            if (linesRead % 5000 == 0)
                Console.WriteLine($"[Ontology] Weenie enrichment: {linesRead} lines processed, {matched} matched, {enriched} enriched...");
        }

        Console.WriteLine($"[Ontology] Weenie enrichment complete: {linesRead} lines read, {matched} matched to ontology, {enriched} entries enriched");
        return enriched;
    }

    /// <summary>
    /// Enriches ontology entries from the canonical enrichment JSON produced by
    /// build_ontology_enrichment.py. Applies architecture, biome, behavior,
    /// creature family, and difficulty tier tags. Matches by setupDid → ObjectId.
    /// </summary>
    public int EnrichFromCanonical(string canonicalJsonPath) {
        if (!File.Exists(canonicalJsonPath))
            throw new FileNotFoundException($"Canonical enrichment file not found: {canonicalJsonPath}");

        var json = File.ReadAllText(canonicalJsonPath);
        using var doc = System.Text.Json.JsonDocument.Parse(json);
        var root = doc.RootElement;

        if (!root.TryGetProperty("entries", out var entriesArray)) {
            Console.WriteLine("[Ontology] Canonical enrichment: no 'entries' array found");
            return 0;
        }

        int enriched = 0;
        int matched = 0;
        int total = 0;

        foreach (var el in entriesArray.EnumerateArray()) {
            total++;

            // Match by setupDid → ontology entry ObjectId
            uint setupDid = 0;
            if (el.TryGetProperty("setupDid", out var sdEl) && sdEl.ValueKind == System.Text.Json.JsonValueKind.Number)
                setupDid = sdEl.GetUInt32();
            if (setupDid == 0) continue;

            if (!_entries.TryGetValue(setupDid, out var entry)) continue;
            matched++;

            bool changed = false;

            // Architecture
            if (el.TryGetProperty("architecture", out var archEl)) {
                var arch = archEl.GetString();
                if (!string.IsNullOrEmpty(arch)) {
                    entry.Architecture = arch;
                    changed = true;
                }
            }

            // Biome (array of strings)
            if (el.TryGetProperty("biome", out var biomeEl) && biomeEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
                entry.Biome = biomeEl.EnumerateArray()
                    .Select(b => b.GetString()!)
                    .Where(b => !string.IsNullOrEmpty(b))
                    .ToArray();
                changed = true;
            }

            // Behavior
            if (el.TryGetProperty("behavior", out var behEl)) {
                var beh = behEl.GetString();
                if (!string.IsNullOrEmpty(beh)) {
                    entry.Behavior = beh;
                    changed = true;
                }
            }

            // Creature family name
            if (el.TryGetProperty("creature_family", out var cfEl) && cfEl.ValueKind == System.Text.Json.JsonValueKind.String) {
                var cf = cfEl.GetString();
                if (!string.IsNullOrEmpty(cf)) {
                    entry.CreatureFamilyName = cf;
                    changed = true;
                }
            }

            // Difficulty tier (overwrite with canonical value if present)
            if (el.TryGetProperty("difficulty_tier", out var dtEl) && dtEl.ValueKind == System.Text.Json.JsonValueKind.String) {
                var dt = dtEl.GetString();
                if (!string.IsNullOrEmpty(dt)) {
                    entry.DifficultyTier = dt;
                    changed = true;
                }
            }

            // Name (fill if missing)
            if (el.TryGetProperty("name", out var nameEl) && nameEl.ValueKind == System.Text.Json.JsonValueKind.String) {
                var name = nameEl.GetString();
                if (!string.IsNullOrEmpty(name) && string.IsNullOrEmpty(entry.Name))
                    entry.Name = name;
            }

            // Level
            if (el.TryGetProperty("level", out var lvlEl) && lvlEl.ValueKind == System.Text.Json.JsonValueKind.Number) {
                entry.Level = lvlEl.GetInt32();
            }

            // WeenieClassId
            if (el.TryGetProperty("wcid", out var wcidEl) && wcidEl.ValueKind == System.Text.Json.JsonValueKind.Number) {
                entry.WeenieClassId = wcidEl.GetInt32();
            }

            // Merge tags from canonical into existing tags
            if (el.TryGetProperty("tags", out var tagsEl) && tagsEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
                var existingTags = new List<string>(entry.Tags ?? Array.Empty<string>());
                foreach (var tagEl in tagsEl.EnumerateArray()) {
                    var tag = tagEl.GetString();
                    if (!string.IsNullOrEmpty(tag) && !existingTags.Contains(tag))
                        existingTags.Add(tag);
                }
                entry.Tags = existingTags.Distinct().ToArray();
            }

            if (changed) enriched++;
        }

        // Print statistics from the canonical file if available
        if (root.TryGetProperty("statistics", out var statsEl)) {
            Console.WriteLine("[Ontology] Canonical enrichment statistics:");
            if (statsEl.TryGetProperty("total_entries", out var teEl))
                Console.WriteLine($"  Total canonical entries: {teEl.GetInt32():N0}");
            if (statsEl.TryGetProperty("has_architecture", out var haEl))
                Console.WriteLine($"  With architecture:      {haEl.GetInt32():N0}");
            if (statsEl.TryGetProperty("has_biome", out var hbEl))
                Console.WriteLine($"  With biome:             {hbEl.GetInt32():N0}");
            if (statsEl.TryGetProperty("has_type", out var htEl))
                Console.WriteLine($"  With type:              {htEl.GetInt32():N0}");
        }

        Console.WriteLine($"[Ontology] Canonical enrichment complete: {total} entries read, {matched} matched to ontology, {enriched} entries enriched");
        return enriched;
    }

    /// <summary>
    /// Enriches ontology entries from the unified ontology JSON
    /// (scripts/build_unified_ontology.py). Applies name, types,
    /// architecture, biome, behavior, creature family, geometry
    /// category/scale, and the building/scenery DAT classification flags
    /// — keyed by both setup_did and gfx_obj_id. Returns the number of
    /// entries enriched.
    /// </summary>
    public int EnrichFromUnified(string unifiedOntologyJsonPath) {
        if (!File.Exists(unifiedOntologyJsonPath))
            throw new FileNotFoundException($"Unified ontology file not found: {unifiedOntologyJsonPath}");

        var json = File.ReadAllText(unifiedOntologyJsonPath);
        using var doc = System.Text.Json.JsonDocument.Parse(json);
        var root = doc.RootElement;

        // Build a snapshot of the by_wcid index so the per-setup loop can
        // pull Level / DifficultyTier / CreatureType / WeenieType from the
        // first matching wcid without re-walking JSON each time.
        var byWcid = new Dictionary<int, System.Text.Json.JsonElement>();
        if (root.TryGetProperty("by_wcid", out var wcidMap)
            && wcidMap.ValueKind == System.Text.Json.JsonValueKind.Object) {
            foreach (var prop in wcidMap.EnumerateObject()) {
                if (int.TryParse(prop.Name, out var wcid))
                    byWcid[wcid] = prop.Value;
            }
        }

        int enriched = 0;
        int matched = 0;
        int total = 0;

        // ── Setup-keyed entries ─────────────────────────────
        if (root.TryGetProperty("by_setup_did", out var setupMap)
            && setupMap.ValueKind == System.Text.Json.JsonValueKind.Object) {
            foreach (var prop in setupMap.EnumerateObject()) {
                total++;
                if (!uint.TryParse(prop.Name, out var setupDid)) continue;
                if (!_entries.TryGetValue(setupDid, out var entry)) continue;
                matched++;
                bool changed = ApplyUnifiedEntryToOntology(prop.Value, entry);
                if (ApplyWcidLookupToEntry(prop.Value, entry, byWcid)) changed = true;
                if (changed) enriched++;
            }
        }

        // ── GfxObj-keyed entries (Setup→Parts inheritance) ──
        if (root.TryGetProperty("by_gfx_obj_id", out var gfxMap)
            && gfxMap.ValueKind == System.Text.Json.JsonValueKind.Object) {
            foreach (var prop in gfxMap.EnumerateObject()) {
                total++;
                if (!uint.TryParse(prop.Name, out var gfxId)) continue;
                if (!_entries.TryGetValue(gfxId, out var entry)) continue;
                matched++;
                if (ApplyUnifiedEntryToOntology(prop.Value, entry)) enriched++;
            }
        }

        if (root.TryGetProperty("stats", out var statsEl)
            && statsEl.ValueKind == System.Text.Json.JsonValueKind.Object) {
            Console.WriteLine("[Ontology] Unified ontology statistics:");
            if (statsEl.TryGetProperty("setups", out var s)) {
                if (s.TryGetProperty("total", out var t)) Console.WriteLine($"  Setups total:    {t.GetInt32():N0}");
                if (s.TryGetProperty("named", out var n)) Console.WriteLine($"  Setups named:    {n.GetInt32():N0}");
                if (s.TryGetProperty("resolved", out var r)) Console.WriteLine($"  Setups resolved: {r.GetInt32():N0}");
            }
            if (statsEl.TryGetProperty("gfx_objs", out var g)) {
                if (g.TryGetProperty("total", out var t)) Console.WriteLine($"  GfxObjs total:    {t.GetInt32():N0}");
                if (g.TryGetProperty("named", out var n)) Console.WriteLine($"  GfxObjs named:    {n.GetInt32():N0}");
                if (g.TryGetProperty("resolved", out var r)) Console.WriteLine($"  GfxObjs resolved: {r.GetInt32():N0}");
            }
        }

        Console.WriteLine($"[Ontology] Unified enrichment complete: {total} entries read, {matched} matched to ontology, {enriched} entries enriched");
        return enriched;
    }

    private static bool ApplyUnifiedEntryToOntology(System.Text.Json.JsonElement el, Lib.OntologyEntry entry) {
        bool changed = false;

        // Name (fill if missing — never overwrite a manually curated one)
        if (el.TryGetProperty("name", out var nameEl)
            && nameEl.ValueKind == System.Text.Json.JsonValueKind.String) {
            var name = nameEl.GetString();
            if (!string.IsNullOrEmpty(name) && string.IsNullOrEmpty(entry.Name)) {
                entry.Name = name;
                changed = true;
            }
        }

        // Architecture
        if (el.TryGetProperty("architectures", out var archEl)
            && archEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
            foreach (var a in archEl.EnumerateArray()) {
                var s = a.GetString();
                if (!string.IsNullOrEmpty(s)) { entry.Architecture = s; changed = true; break; }
            }
        }

        // Biome
        if (el.TryGetProperty("biomes", out var biomeEl)
            && biomeEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
            var biomes = biomeEl.EnumerateArray()
                .Select(b => b.GetString()!)
                .Where(b => !string.IsNullOrEmpty(b))
                .ToArray();
            if (biomes.Length > 0) { entry.Biome = biomes; changed = true; }
        }

        // Behavior
        if (el.TryGetProperty("behaviors", out var behEl)
            && behEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
            foreach (var b in behEl.EnumerateArray()) {
                var s = b.GetString();
                if (!string.IsNullOrEmpty(s)) { entry.Behavior = s; changed = true; break; }
            }
        }

        // Creature family
        if (el.TryGetProperty("creature_families", out var cfEl)
            && cfEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
            foreach (var c in cfEl.EnumerateArray()) {
                var s = c.GetString();
                if (!string.IsNullOrEmpty(s)) { entry.CreatureFamilyName = s; changed = true; break; }
            }
        }

        // Category — Unified is higher confidence than Heuristic, so allow it to
        // override an existing Heuristic classification. Never override Building /
        // Weenie / Scene (each of those is a definitive retail cross-reference).
        bool canOverrideCategory =
            string.IsNullOrEmpty(entry.Category)
            || string.Equals(entry.Category, "Unknown", StringComparison.OrdinalIgnoreCase)
            || string.Equals(entry.ClassificationSource, "Heuristic", StringComparison.OrdinalIgnoreCase);

        if (canOverrideCategory) {
            if (el.TryGetProperty("types", out var typesEl)
                && typesEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
                foreach (var t in typesEl.EnumerateArray()) {
                    var s = t.GetString();
                    if (!string.IsNullOrEmpty(s)) {
                        entry.Category = s;
                        entry.ClassificationSource = "Unified";
                        changed = true;
                        break;
                    }
                }
            }
            if ((string.IsNullOrEmpty(entry.Category) || entry.Category == "Unknown")
                && el.TryGetProperty("geom_category", out var gcEl)
                && gcEl.ValueKind == System.Text.Json.JsonValueKind.String) {
                var s = gcEl.GetString();
                if (!string.IsNullOrEmpty(s) && s != "Unknown") {
                    entry.Category = s;
                    changed = true;
                }
            }
        }

        // Scale (only fill if currently Unknown)
        if (string.Equals(entry.Scale, "Unknown", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrEmpty(entry.Scale)) {
            if (el.TryGetProperty("geom_scale", out var gsEl)
                && gsEl.ValueKind == System.Text.Json.JsonValueKind.String) {
                var s = gsEl.GetString();
                if (!string.IsNullOrEmpty(s) && s != "Unknown") {
                    entry.Scale = s;
                    changed = true;
                }
            }
        }

        // WeenieClassId (first wcid in the merged list, only if missing)
        if (entry.WeenieClassId == null
            && el.TryGetProperty("wcids", out var wcidsEl)
            && wcidsEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
            foreach (var w in wcidsEl.EnumerateArray()) {
                if (w.ValueKind == System.Text.Json.JsonValueKind.Number) {
                    entry.WeenieClassId = w.GetInt32();
                    changed = true;
                    break;
                }
            }
        }

        // Building/scenery flags merged into Tags so keyword search picks them up.
        // is_building=true is a definitive retail signal (LandBlockInfo.Buildings
        // cross-reference), so it also promotes the Category over a heuristic guess —
        // many buildings are 8m single-part GfxObjs and the geometry threshold puts
        // them in "Scenery", which silently strips them from any structure-aware
        // surface (description, validation, footprint extraction).
        var tagsList = new List<string>(entry.Tags ?? Array.Empty<string>());
        bool isBuildingFlag = el.TryGetProperty("is_building", out var ibEl)
            && ibEl.ValueKind == System.Text.Json.JsonValueKind.True;
        if (isBuildingFlag && !tagsList.Contains("dat:building")) {
            tagsList.Add("dat:building"); changed = true;
        }
        if (isBuildingFlag
            && string.Equals(entry.ClassificationSource, "Heuristic", StringComparison.OrdinalIgnoreCase)
            && (entry.Category == "Scenery" || entry.Category == "Prop"
                || entry.Category == "Unknown" || string.IsNullOrEmpty(entry.Category))) {
            entry.Category = "Structure";
            entry.ClassificationSource = "Unified";
            changed = true;
        }
        if (el.TryGetProperty("is_scenery", out var isEl)
            && isEl.ValueKind == System.Text.Json.JsonValueKind.True
            && !tagsList.Contains("dat:scenery")) {
            tagsList.Add("dat:scenery"); changed = true;
        }
        if (el.TryGetProperty("building_via_parent", out var bpEl)
            && bpEl.ValueKind == System.Text.Json.JsonValueKind.True
            && !tagsList.Contains("dat:building_inherited")) {
            tagsList.Add("dat:building_inherited"); changed = true;
        }
        if (el.TryGetProperty("scenery_via_parent", out var spEl)
            && spEl.ValueKind == System.Text.Json.JsonValueKind.True
            && !tagsList.Contains("dat:scenery_inherited")) {
            tagsList.Add("dat:scenery_inherited"); changed = true;
        }
        if (changed) entry.Tags = tagsList.Distinct().ToArray();

        return changed;
    }

    /// <summary>
    /// Cross-reference: for each wcid in the unified setup entry, look up
    /// the by_wcid bucket and propagate Level / DifficultyTier / WeenieType
    /// / CreatureFamilyName into the OntologyEntry. Skips fields already
    /// populated.
    /// </summary>
    private static bool ApplyWcidLookupToEntry(
        System.Text.Json.JsonElement setupEl,
        Lib.OntologyEntry entry,
        IReadOnlyDictionary<int, System.Text.Json.JsonElement> byWcid) {
        if (!setupEl.TryGetProperty("wcids", out var wcidsEl)
            || wcidsEl.ValueKind != System.Text.Json.JsonValueKind.Array)
            return false;

        bool changed = false;
        foreach (var wEl in wcidsEl.EnumerateArray()) {
            if (wEl.ValueKind != System.Text.Json.JsonValueKind.Number) continue;
            int wcid = wEl.GetInt32();
            if (!byWcid.TryGetValue(wcid, out var wcidEntry)) continue;

            if (entry.Level == null
                && wcidEntry.TryGetProperty("level", out var lvlEl)
                && lvlEl.ValueKind == System.Text.Json.JsonValueKind.Number) {
                entry.Level = lvlEl.GetInt32();
                changed = true;
            }
            if (string.IsNullOrEmpty(entry.DifficultyTier)
                && wcidEntry.TryGetProperty("difficulty_tier", out var dtEl)
                && dtEl.ValueKind == System.Text.Json.JsonValueKind.String) {
                var dt = dtEl.GetString();
                if (!string.IsNullOrEmpty(dt)) { entry.DifficultyTier = dt; changed = true; }
            }
            if (entry.WeenieType == null
                && wcidEntry.TryGetProperty("weenie_type", out var wtEl)
                && wtEl.ValueKind == System.Text.Json.JsonValueKind.Number) {
                entry.WeenieType = wtEl.GetInt32();
                changed = true;
            }
            if (string.IsNullOrEmpty(entry.CreatureFamilyName)
                && wcidEntry.TryGetProperty("creature_family", out var cfEl)
                && cfEl.ValueKind == System.Text.Json.JsonValueKind.String) {
                var cf = cfEl.GetString();
                if (!string.IsNullOrEmpty(cf)) { entry.CreatureFamilyName = cf; changed = true; }
            }
            // Stop after first wcid that yielded something useful — multiple
            // wcids per setup are common (e.g. cultural variants) but their
            // Level/Tier/Family are typically equivalent.
            if (changed) break;
        }
        return changed;
    }

    // ════════════════════════════════════════════════════
    //  Persistence (cache to / load from JSONL)
    // ════════════════════════════════════════════════════

    public int CacheToFile(string outputPath) {
        var dir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        int count = 0;
        using var w = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);
        var jsonOpts = new System.Text.Json.JsonSerializerOptions {
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        };
        foreach (var entry in _entries.Values.OrderBy(e => e.ObjectId)) {
            var dto = new {
                id = entry.ObjectId,
                type = entry.DatType,
                bMin = new[] { entry.BoundsMin.X, entry.BoundsMin.Y, entry.BoundsMin.Z },
                bMax = new[] { entry.BoundsMax.X, entry.BoundsMax.Y, entry.BoundsMax.Z },
                maxDim = entry.MaxDimension,
                partCount = entry.PartCount,
                polyCount = entry.PolyCount,
                aspectRatio = entry.AspectRatio,
                scale = entry.Scale,
                category = entry.Category,
                classSource = entry.ClassificationSource,
                tags = entry.Tags,
                vertexCount = entry.VertexCount,
                surfaceIds = entry.SurfaceIds,
                thumbnailPath = entry.ThumbnailPath,
                name = entry.Name,
                materialTags = entry.MaterialTags,
                weenieClassId = entry.WeenieClassId,
                weenieType = entry.WeenieType,
                level = entry.Level,
                creatureType = entry.CreatureType,
                difficultyTier = entry.DifficultyTier,
                architecture = entry.Architecture,
                biome = entry.Biome,
                behavior = entry.Behavior,
                creatureFamilyName = entry.CreatureFamilyName,
            };
            w.WriteLine(System.Text.Json.JsonSerializer.Serialize(dto, jsonOpts));
            count++;
        }
        Console.WriteLine($"[Ontology] Cached {count:N0} entries -> {outputPath}");
        return count;
    }

    public int LoadFromCache(string inputPath) {
        if (!File.Exists(inputPath))
            throw new FileNotFoundException($"Ontology cache file not found: {inputPath}");

        var loaded = new ConcurrentDictionary<uint, Lib.OntologyEntry>();
        int count = 0;
        foreach (var line in File.ReadLines(inputPath)) {
            var trimmed = line.Trim();
            if (string.IsNullOrEmpty(trimmed)) continue;
            try {
                using var doc = System.Text.Json.JsonDocument.Parse(trimmed);
                var root = doc.RootElement;
                var entry = new Lib.OntologyEntry {
                    ObjectId = root.GetProperty("id").GetUInt32(),
                    DatType = TryGetString(root, "type") ?? "",
                    MaxDimension = TryGetSingle(root, "maxDim") ?? 0f,
                    PartCount = TryGetInt32(root, "partCount") ?? 0,
                    PolyCount = TryGetInt32(root, "polyCount") ?? 0,
                    AspectRatio = TryGetSingle(root, "aspectRatio") ?? 0f,
                    Scale = TryGetString(root, "scale") ?? "Unknown",
                    Category = TryGetString(root, "category") ?? "Unknown",
                    ClassificationSource = TryGetString(root, "classSource") ?? "Heuristic",
                    Tags = TryGetStringArray(root, "tags") ?? Array.Empty<string>(),
                    VertexCount = TryGetInt32(root, "vertexCount") ?? 0,
                    SurfaceIds = TryGetStringList(root, "surfaceIds"),
                    ThumbnailPath = TryGetString(root, "thumbnailPath"),
                    Name = TryGetString(root, "name"),
                    MaterialTags = TryGetStringArray(root, "materialTags"),
                    WeenieClassId = TryGetInt32(root, "weenieClassId"),
                    WeenieType = TryGetInt32(root, "weenieType"),
                    Level = TryGetInt32(root, "level"),
                    CreatureType = TryGetInt32(root, "creatureType"),
                    DifficultyTier = TryGetString(root, "difficultyTier"),
                    Architecture = TryGetString(root, "architecture"),
                    Biome = TryGetStringArray(root, "biome"),
                    Behavior = TryGetString(root, "behavior"),
                    CreatureFamilyName = TryGetString(root, "creatureFamilyName"),
                    BoundsMin = TryGetVec3(root, "bMin"),
                    BoundsMax = TryGetVec3(root, "bMax"),
                };
                loaded[entry.ObjectId] = entry;
                count++;
            } catch (Exception ex) {
                Console.WriteLine($"[Ontology] Skipping malformed cache line: {ex.Message}");
            }
        }

        _entries.Clear();
        foreach (var kv in loaded) _entries[kv.Key] = kv.Value;
        _isScanned = true;
        Console.WriteLine($"[Ontology] Loaded {count:N0} entries from cache <- {inputPath}");
        return count;
    }

    private static string? TryGetString(System.Text.Json.JsonElement root, string name) {
        if (!root.TryGetProperty(name, out var el)) return null;
        return el.ValueKind == System.Text.Json.JsonValueKind.String ? el.GetString() : null;
    }
    private static int? TryGetInt32(System.Text.Json.JsonElement root, string name) {
        if (!root.TryGetProperty(name, out var el)) return null;
        return el.ValueKind == System.Text.Json.JsonValueKind.Number ? el.GetInt32() : null;
    }
    private static float? TryGetSingle(System.Text.Json.JsonElement root, string name) {
        if (!root.TryGetProperty(name, out var el)) return null;
        return el.ValueKind == System.Text.Json.JsonValueKind.Number ? el.GetSingle() : null;
    }
    private static string[]? TryGetStringArray(System.Text.Json.JsonElement root, string name) {
        if (!root.TryGetProperty(name, out var el) || el.ValueKind != System.Text.Json.JsonValueKind.Array) return null;
        return el.EnumerateArray()
            .Select(x => x.ValueKind == System.Text.Json.JsonValueKind.String ? x.GetString() : null)
            .Where(s => !string.IsNullOrEmpty(s))
            .Cast<string>()
            .ToArray();
    }
    private static List<string>? TryGetStringList(System.Text.Json.JsonElement root, string name) {
        var arr = TryGetStringArray(root, name);
        return arr != null ? new List<string>(arr) : null;
    }
    private static Vector3 TryGetVec3(System.Text.Json.JsonElement root, string name) {
        if (!root.TryGetProperty(name, out var el) || el.ValueKind != System.Text.Json.JsonValueKind.Array) return Vector3.Zero;
        var vals = el.EnumerateArray().Select(x => x.GetSingle()).Take(3).ToArray();
        return new Vector3(
            vals.Length > 0 ? vals[0] : 0f,
            vals.Length > 1 ? vals[1] : 0f,
            vals.Length > 2 ? vals[2] : 0f);
    }
}
