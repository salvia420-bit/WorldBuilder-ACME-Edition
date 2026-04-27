using System.Collections.Concurrent;
using System.Globalization;
using System.Numerics;
using System.Text;
using DatReaderWriter;
using DatReaderWriter.DBObjs;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.Geometry;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Terminal;

// Pure derivation. Given the documents that already exist for this landblock,
// produce a description by interpreting current state — never by reading a
// stored description field. Run this fresh whenever the world mutates; it is
// cheap CPU work over a few hundred objects + an 81-vertex grid.
public static class LandblockDescriber {
    // A vertical cluster of objects within some scope (a structure's contents
    // or the loose-objects pool). Bands are a viewing convenience derived from
    // current Z positions; nothing is stored on the objects themselves.
    public record ZBand(float Min, float Max, int Count);

    public record TerrainTypeShare(int Type, string? Name, int VertexCount, double Share);

    public record ContextBlock(
        string? Biome,
        double BiomeConfidence,
        List<TerrainTypeShare> DominantTerrainTypes,
        bool HasRoad,
        string? SettlementHint,
        string? DominantArchitecture,
        int StructureCount,
        // Parent zoom data (gazetteer): town name + culture override the describer's
        // local biome/architecture inference when available. Null when this LB isn't
        // a known town center.
        string? TownName,
        string? Culture,
        string? GazetteerNotes,
        // POI listings from a wiki gazetteer (Acpedia): named entities the wiki
        // places at this LB. Populated only when caller injects them.
        List<NamedPoi>? KnownPois,
        // Region (parent zoom above LB). When set, region biome/culture takes
        // precedence over per-LB inference; LB verbal stops repeating biome since
        // the region already established it.
        string? RegionName,
        string? RegionDescription);

    // Parent zoom override; injected by caller (typically from a town gazetteer).
    public record TownContext(string Name, string? Culture, string? Notes);

    // Region override (broader than town, ~13 regions cover all populated LBs).
    public record RegionContext(string Name, string? Culture, string? Biome, string? Description);

    public record NamedPoi(string Title, string[] Categories, string? Description);

    // Acpedia annotation for a single object: keyed by its weenie wcid.
    // Tier: HIGH (name+category aligned), MED (name match, weak/no cats), LOW (ambiguous), NONE (no match).
    public record AcpediaMatch(string Title, string[] Categories, string? Description, string Tier);

    // Server-spawn record from LSD spawnMaps. These are weenies the AC server
    // generates dynamically (NPCs, creatures, quest objects), not static DAT
    // placements. Player-visible only — server-managed weenies (doors, chests,
    // generators, etc.) are filtered out at gazetteer build time.
    public record SpawnEntry(
        int Wcid,
        string Name,
        string? Placement,            // "Overworld", "Indoors", "Respawn" — placement system hint
        int? WeenieType,
        string? AcpediaTitle,
        string[]? AcpediaCategories,
        string? AcpediaTier,
        float X, float Y, float Z,
        int Cell);

    // Validation overlay: ValidationEngine.ValidateAll output, structured for atlas use.
    public record ValidationOverlay(
        bool IsValid,
        int ErrorCount,
        int WarningCount,
        int InfoCount,
        List<ValidationDiagnosticEntry> Diagnostics);

    public record ValidationDiagnosticEntry(
        string Severity,    // "error" | "warning" | "info"
        string Code,        // e.g. "LBK003", "TRN002"
        string Message,
        string? Context);

    public record TerrainBlock(
        double HeightMin, double HeightMax, double HeightRange,
        int CliffCount, int VertexCount,
        string Summary);

    public record StructureBlock(
        int Index,
        string ModelId,
        Vector3 Origin,
        string FootprintShape,
        Vector2[] FootprintWorld,
        double FloorZ, double TopZ,
        List<int> ContainedIndices,
        List<ZBand> ZBands,
        string? Architecture,
        string? NameHint,
        string[]? Tags,
        // Type-level (model-derived) features — stable across instances.
        int? Stories,             // visual floor count from model vertex Z-histogram
        int? PlayableFloors,      // interior cell Z-clusters attributed to this building
        string? RoofShape,
        int AttributedCellCount,
        string[]? MaterialTags,
        string TypeDescription);

    public record InteriorBlock(
        int CellCount,
        double ZMin, double ZMax, double ZRange,
        int ZBandCount,
        int CellGraphEdges,    // sum of inter-cell portal links — internal connectivity, not in-game travel portals
        int ExteriorPortals,   // cell-portal endpoints pointing to a cell not in this dungeon's set (entry/exit)
        int StaticObjectCount);

    public record ObjectCount(string Category, int Count);

    public record LandblockBody(
        int ObjectTotal,
        List<ObjectCount> ByCategory,
        List<StructureBlock> Structures,
        int LooseObjectCount,
        List<ZBand> LooseZBands,
        List<int> UntaggedIndices,
        InteriorBlock? Interior,
        List<NamedObject> NamedObjects,
        List<SpawnEntry> Spawns);

    public record NamedObject(
        int Index,
        string ModelId,
        int Wcid,
        string WeenieName,
        string AcpediaTitle,
        string[] AcpediaCategories,
        string? AcpediaDescription,
        string Tier);

    public record LandblockDescriptionResult(
        string Landblock,
        uint LbX,
        uint LbY,
        ContextBlock Context,
        TerrainBlock Terrain,
        LandblockBody Body,
        List<string> Relations,
        string Verbal,
        ValidationOverlay? Validation);

    private const float ZBandGap = 3.0f;            // object-Z band split: 1 floor of headroom = ~3 world units
    private const float CellZBandGap = 2.0f;        // cell-Z band split: tighter, since AC inter-floor cell-origin spacing is ~3m
    private const int CliffHeightByteDelta = 6;     // ≈ noticeable wall in retail
    private const float ContainmentZMargin = 1.0f;  // soft buffer above/below structure bounds

    public static LandblockDescriptionResult Describe(
            ushort lbKey,
            LandblockDocument lbDoc,
            TerrainDocument terrainDoc,
            DungeonDocument? dungeonDoc,
            IOntologyService ontology,
            float[] heightTable,
            IReadOnlyDictionary<int, string>? terrainTypeNames,
            IDatReaderWriter? dats = null,
            TownContext? townContext = null,
            List<NamedPoi>? knownPois = null,
            IReadOnlyDictionary<int, AcpediaMatch>? wcidToAcpedia = null,
            List<SpawnEntry>? spawns = null,
            ValidationOverlay? validation = null,
            RegionContext? regionContext = null) {

        uint lbX = (uint)((lbKey >> 8) & 0xFF);
        uint lbY = (uint)(lbKey & 0xFF);
        var landblock = $"0x{lbKey:X4}";

        var objects = lbDoc.GetStaticObjects().ToList();
        var terrain = terrainDoc.GetLandblockInternal(lbKey);

        // Each object enriched with its ontology entry. Untagged objects keep null.
        var enriched = objects.Select((obj, idx) => (
            Index: idx,
            Object: obj,
            Entry: ontology.IsScanned ? ontology.GetEntry(obj.Id) : null
        )).ToList();

        var (terrainBlock, dominantTypes, hasRoad) = SummariseTerrain(terrain, heightTable, terrainTypeNames);

        // Structures = objects whose ontology marks them as Structure category.
        // Without that tag we cannot reliably identify a building, so containment
        // simply doesn't happen for those objects — they land in "loose".
        var structureSeeds = enriched
            .Where(e => string.Equals(e.Entry?.Category, "Structure", StringComparison.OrdinalIgnoreCase))
            .ToList();

        var assigned = new HashSet<int>();
        var structureBlocks = new List<StructureBlock>(structureSeeds.Count);
        foreach (var s in structureSeeds) {
            var entry = s.Entry!;
            var worldFootprint = TransformFootprintToWorld(entry.FootprintCorners, s.Object.Origin, s.Object.Orientation);
            FootprintShape effectiveShape = entry.FootprintShape;
            // Many retail buildings are GfxObj-classified and were promoted to
            // Structure by Unified enrichment AFTER ClassifyGfxObj ran, so they
            // never got footprint extraction. Run it on-demand here using the same
            // FootprintExtractor the validator uses — gives us real Hexagon/
            // Octagon classification (mage tower wedge) instead of a degenerate AABB.
            if ((worldFootprint.Length < 3 || effectiveShape == FootprintShape.Unknown) && dats != null) {
                var extracted = ExtractFootprint(s.Object.Id, dats);
                if (extracted.HasValue && extracted.Value.Corners.Length >= 3) {
                    worldFootprint = TransformFootprintToWorld(extracted.Value.Corners, s.Object.Origin, s.Object.Orientation);
                    effectiveShape = extracted.Value.Shape;
                }
            }
            // Final fallback: AABB from bounds.
            if (worldFootprint.Length < 3) {
                worldFootprint = SyntheticFootprintFromBounds(entry.BoundsMin, entry.BoundsMax, s.Object.Origin, s.Object.Orientation);
            }
            float floorZ = s.Object.Origin.Z + entry.FoundationZ;
            float topZ = s.Object.Origin.Z + entry.BoundsMax.Z;

            var contained = new List<int>();
            if (worldFootprint.Length >= 3) {
                for (int i = 0; i < enriched.Count; i++) {
                    if (i == s.Index || assigned.Contains(i)) continue;
                    // Don't absorb other Structures into this one — they each get their own block.
                    if (string.Equals(enriched[i].Entry?.Category, "Structure", StringComparison.OrdinalIgnoreCase)) continue;
                    var p = enriched[i].Object.Origin;
                    if (p.Z < floorZ - ContainmentZMargin || p.Z > topZ + ContainmentZMargin) continue;
                    if (PointInPolygon(new Vector2(p.X, p.Y), worldFootprint)) {
                        contained.Add(i);
                        assigned.Add(i);
                    }
                }
            }

            var bands = ClusterByZ(contained.Select(i => enriched[i].Object.Origin.Z));

            // Cell attribution. cell.Origin is the BUILDING's ground origin (not the
            // per-cell position) — all of a building's cells share one Origin point.
            // So we attribute by matching that single point against the building's
            // footprint. Cell count = interior room count; per-cell Z-clustering is
            // NOT derivable from this data and would require reading CellStruct
            // geometry from the Environment DAT object (separate investigation).
            var attributedCells = new List<DungeonCellData>();
            if (dungeonDoc != null && worldFootprint.Length >= 3) {
                float lbWorldOffsetX = lbX * 192f;
                float lbWorldOffsetY = lbY * 192f;
                foreach (var cell in dungeonDoc.Cells) {
                    if (cell.Origin.Z < floorZ - ContainmentZMargin || cell.Origin.Z > topZ + 5f) continue;
                    var worldXY = new Vector2(lbWorldOffsetX + cell.Origin.X, lbWorldOffsetY + cell.Origin.Y);
                    if (PointInPolygon(worldXY, worldFootprint))
                        attributedCells.Add(cell);
                }
            }

            // Model geometry: vertex Z-histogram → story peaks; top/base XY ratio → roof.
            BuildingShapeFeatures? shape = dats != null
                ? AnalyzeShape(s.Object.Id, dats)
                : null;

            // Stories: derived from the model's vertex Z-histogram (visual feature).
            // Interior cell count comes from attributed dungeon cells; cells ≠ rooms
            // in AC parlance (cell ≈ 5-6m, a "room" in player terms = 1-N connected cells).
            int? visualStories = shape?.Stories;
            string? roofShape = shape?.RoofShape;
            int? cellCount = attributedCells.Count > 0 ? attributedCells.Count : (int?)null;
            float? footprintArea = worldFootprint.Length >= 3 ? PolygonArea(worldFootprint) : (float?)null;
            string typeDesc = ComposeTypeDescription(entry, effectiveShape, visualStories, roofShape, cellCount, footprintArea, shape?.Height);

            structureBlocks.Add(new StructureBlock(
                Index: s.Index,
                ModelId: $"0x{s.Object.Id:X8}",
                Origin: s.Object.Origin,
                FootprintShape: effectiveShape.ToString(),
                FootprintWorld: worldFootprint,
                FloorZ: floorZ,
                TopZ: topZ,
                ContainedIndices: contained,
                ZBands: bands,
                Architecture: entry.Architecture,
                NameHint: ResolveNameHint(entry),
                Tags: entry.Tags,
                Stories: visualStories,
                PlayableFloors: null,
                RoofShape: roofShape,
                AttributedCellCount: attributedCells.Count,
                MaterialTags: entry.MaterialTags,
                TypeDescription: typeDesc));
            assigned.Add(s.Index);
        }

        // Loose = anything not absorbed into a structure (and not itself a structure).
        var looseIndices = enriched
            .Where(e => !assigned.Contains(e.Index)
                     && !string.Equals(e.Entry?.Category, "Structure", StringComparison.OrdinalIgnoreCase))
            .Select(e => e.Index)
            .ToList();
        var looseZBands = ClusterByZ(looseIndices.Select(i => enriched[i].Object.Origin.Z));

        var untagged = enriched.Where(e => e.Entry == null).Select(e => e.Index).ToList();

        var byCategory = enriched
            .GroupBy(e => e.Entry?.Category ?? "Untagged", StringComparer.OrdinalIgnoreCase)
            .Select(g => new ObjectCount(g.Key, g.Count()))
            .OrderByDescending(c => c.Count)
            .ToList();

        InteriorBlock? interior = null;
        if (dungeonDoc != null && dungeonDoc.Cells.Count > 0) {
            var cells = dungeonDoc.Cells;
            float zMin = cells.Min(c => c.Origin.Z);
            float zMax = cells.Max(c => c.Origin.Z);
            int cellEdges = cells.Sum(c => c.CellPortals?.Count ?? 0);
            // An "exterior" portal is a CellPortal whose OtherCellId points outside
            // this dungeon's cell set — typically the entry/exit doorway. The wiki
            // calls these "portals" in the player-facing sense.
            var ourCells = new HashSet<ushort>(cells.Select(c => c.CellNumber));
            int exteriorPortals = cells.Sum(c => c.CellPortals?.Count(p => !ourCells.Contains(p.OtherCellId)) ?? 0);
            int staticInside = cells.Sum(c => c.StaticObjects?.Count ?? 0);
            int bandCount = ClusterByZ(cells.Select(c => c.Origin.Z)).Count;
            interior = new InteriorBlock(cells.Count, zMin, zMax, zMax - zMin, bandCount, cellEdges, exteriorPortals, staticInside);
        }

        // Settlement / culture inference. With the Region zoom unimplemented, this
        // is the best parent-context the LB can produce on its own; it migrates to
        // the Region zoom verbatim once that lands and is dropped here as redundant.
        string? dominantArchitecture = structureBlocks
            .Where(s => !string.IsNullOrEmpty(s.Architecture))
            .GroupBy(s => s.Architecture!)
            .OrderByDescending(g => g.Count())
            .FirstOrDefault()?.Key;

        string? settlementHint = structureBlocks.Count switch {
            >= 3 when dominantArchitecture != null => $"settlement (≥3 {dominantArchitecture} structures)",
            >= 3 => "settlement (≥3 structures)",
            >= 1 => "isolated structure(s)",
            _ => null
        };

        var (biome, biomeConfidence) = InferBiome(dominantTypes);

        // Gazetteer parent context overrides per-LB inference when available.
        // Priority: town culture > region culture > per-LB DominantArchitecture
        // (Setup-only, often null for GfxObj towns).
        string? finalCulture = townContext?.Culture ?? regionContext?.Culture ?? dominantArchitecture;
        // Region biome takes precedence over per-LB terrain inference. The brief's
        // inheritance rule: parent zoom names biome; LB doesn't repeat.
        string? finalBiome = regionContext?.Biome ?? biome;

        var context = new ContextBlock(
            Biome: finalBiome,
            BiomeConfidence: regionContext?.Biome != null ? 1.0 : biomeConfidence,
            DominantTerrainTypes: dominantTypes,
            HasRoad: hasRoad,
            SettlementHint: settlementHint,
            DominantArchitecture: finalCulture,
            StructureCount: structureBlocks.Count,
            TownName: townContext?.Name,
            Culture: townContext?.Culture,
            GazetteerNotes: townContext?.Notes,
            KnownPois: knownPois,
            RegionName: regionContext?.Name,
            RegionDescription: regionContext?.Description);

        // Acpedia annotation per object: only for objects whose ontology entry
        // carries a WeenieClassId AND whose wcid resolves to a HIGH or MED Acpedia
        // match. LOW (ambiguous) is excluded by default — too risky for atlas use.
        //
        // Sanity gate: setupDid collisions (multiple weenies sharing one Setup)
        // can cause EnrichFromWeenies to assign entry.Name from one weenie but
        // entry.WeenieClassId from another. The join was built name→title, so an
        // entry whose Name doesn't match the resolved Acpedia Title is a collision
        // signal — skip it rather than surface a wrong entity ("Renald's Old Mug"
        // resolving to a "Cutters Cup" page is the canonical failure mode).
        var namedObjects = new List<NamedObject>();
        if (wcidToAcpedia != null) {
            foreach (var e in enriched) {
                var wcid = e.Entry?.WeenieClassId;
                var entryName = e.Entry?.Name;
                if (wcid == null || string.IsNullOrEmpty(entryName)) continue;
                if (!wcidToAcpedia.TryGetValue(wcid.Value, out var acp)) continue;
                if (acp.Tier == "LOW" || acp.Tier == "NONE") continue;
                // Name consistency check — required for HIGH/MED (the join's
                // contract is that title == weenie name).
                if (!string.Equals(entryName.Trim(), acp.Title.Trim(), StringComparison.OrdinalIgnoreCase)) continue;
                namedObjects.Add(new NamedObject(
                    Index: e.Index,
                    ModelId: $"0x{e.Object.Id:X8}",
                    Wcid: wcid.Value,
                    WeenieName: entryName,
                    AcpediaTitle: acp.Title,
                    AcpediaCategories: acp.Categories,
                    AcpediaDescription: acp.Description,
                    Tier: acp.Tier));
            }
        }

        var body = new LandblockBody(
            ObjectTotal: objects.Count,
            ByCategory: byCategory,
            Structures: structureBlocks,
            LooseObjectCount: looseIndices.Count,
            LooseZBands: looseZBands,
            UntaggedIndices: untagged,
            Interior: interior,
            NamedObjects: namedObjects,
            Spawns: spawns ?? new List<SpawnEntry>());

        var relations = SurfaceRelationsWithPois(structureBlocks, looseZBands, untagged, interior, knownPois, namedObjects, spawns);
        var verbal = ComposeVerbal(landblock, lbX, lbY, context, terrainBlock, body);

        return new LandblockDescriptionResult(landblock, lbX, lbY, context, terrainBlock, body, relations, verbal, validation);
    }

    // ── Terrain ────────────────────────────────────────────────

    private static (TerrainBlock Block, List<TerrainTypeShare> DominantTypes, bool HasRoad)
            SummariseTerrain(TerrainEntry[]? terrain, float[] heightTable,
                             IReadOnlyDictionary<int, string>? terrainTypeNames) {
        if (terrain == null || terrain.Length == 0) {
            return (new TerrainBlock(0, 0, 0, 0, 0, "no terrain data"), new List<TerrainTypeShare>(), false);
        }

        // Heights: heightTable[byte] gives world Z; min/max + cliff count via 4-neighbour scan.
        double zMin = double.PositiveInfinity, zMax = double.NegativeInfinity;
        int cliffs = 0;
        var typeCounts = new Dictionary<byte, int>();
        bool anyRoad = false;
        int side = (int)Math.Sqrt(terrain.Length); // expected 9
        if (side * side != terrain.Length) side = 9;

        for (int i = 0; i < terrain.Length; i++) {
            var t = terrain[i];
            float h = heightTable[t.Height];
            if (h < zMin) zMin = h;
            if (h > zMax) zMax = h;
            typeCounts.TryGetValue(t.Type, out var c); typeCounts[t.Type] = c + 1;
            if (t.Road != 0) anyRoad = true;
        }

        // Cliff count: adjacent vertex height-byte delta > threshold.
        for (int gx = 0; gx < side; gx++) {
            for (int gy = 0; gy < side; gy++) {
                int idx = gx * side + gy;
                byte h = terrain[idx].Height;
                if (gx + 1 < side && Math.Abs(terrain[(gx + 1) * side + gy].Height - h) > CliffHeightByteDelta) cliffs++;
                if (gy + 1 < side && Math.Abs(terrain[gx * side + (gy + 1)].Height - h) > CliffHeightByteDelta) cliffs++;
            }
        }

        var dominant = typeCounts
            .Select(kv => new TerrainTypeShare(
                kv.Key,
                terrainTypeNames != null && terrainTypeNames.TryGetValue(kv.Key, out var n) ? n : null,
                kv.Value,
                (double)kv.Value / terrain.Length))
            .OrderByDescending(s => s.VertexCount)
            .Take(3)
            .ToList();

        double range = zMax - zMin;
        string reliefWord = range < 2 ? "flat" : range < 8 ? "rolling" : range < 20 ? "uneven" : "rugged";
        string typeWord = dominant.Count == 0
            ? "untyped terrain"
            : dominant[0].Name?.ToLowerInvariant() ?? $"type {dominant[0].Type}";
        string roadWord = anyRoad ? "road present" : "no road";
        string cliffWord = cliffs == 0 ? "" : cliffs < 4 ? ", a few cliffs" : ", cliff-heavy";
        var summary = $"{reliefWord}, mostly {typeWord}, {roadWord}{cliffWord}";

        return (new TerrainBlock(zMin, zMax, range, cliffs, terrain.Length, summary), dominant, anyRoad);
    }

    private static (string? Biome, double Confidence) InferBiome(List<TerrainTypeShare> dominant) {
        if (dominant.Count == 0) return (null, 0);
        var top = dominant[0];
        if (top.Name == null) return (null, top.Share);
        var n = top.Name.ToLowerInvariant();

        string? biome =
            n.Contains("snow") || n.Contains("ice") ? "snowy" :
            n.Contains("forest") || n.Contains("grass") ? "temperate" :
            n.Contains("sand") || n.Contains("desert") || n.Contains("dune") ? "desert" :
            n.Contains("lava") || n.Contains("volcan") ? "volcanic" :
            n.Contains("swamp") || n.Contains("marsh") ? "swamp" :
            n.Contains("water") || n.Contains("river") ? "watery" :
            n.Contains("barren") || n.Contains("rock") || n.Contains("mountain") ? "barren" :
            null;

        // If the top type only narrowly leads, soften to "mixed".
        if (dominant.Count >= 2 && top.Share - dominant[1].Share < 0.10) {
            return (biome == null ? "mixed" : $"mixed-{biome}", top.Share);
        }
        return (biome, top.Share);
    }

    // ── Geometry helpers ───────────────────────────────────────

    // Cache extracted footprints per model — extraction walks all vertices, so
    // memoize. Same lifecycle as _shapeCache.
    private static readonly ConcurrentDictionary<uint, FootprintExtraction> _footprintCache = new();

    private static FootprintExtraction? ExtractFootprint(uint modelId, IDatReaderWriter dats) {
        if (_footprintCache.TryGetValue(modelId, out var cached)) return cached;
        FootprintExtraction extracted;
        if ((modelId & 0xFF000000) == 0x02000000) {
            if (!dats.TryGet<Setup>(modelId, out var setup)) return null;
            extracted = FootprintExtractor.FromSetup(setup, dats);
        } else {
            if (!dats.TryGet<GfxObj>(modelId, out var gfx)) return null;
            extracted = FootprintExtractor.FromGfxObj(gfx);
        }
        _footprintCache[modelId] = extracted;
        return extracted;
    }

    // Shoelace formula for polygon area — sign-agnostic (CCW or CW input).
    private static float PolygonArea(Vector2[] poly) {
        float a = 0;
        for (int i = 0; i < poly.Length; i++) {
            var p1 = poly[i];
            var p2 = poly[(i + 1) % poly.Length];
            a += p1.X * p2.Y - p2.X * p1.Y;
        }
        return MathF.Abs(a) * 0.5f;
    }

    private static Vector2[] SyntheticFootprintFromBounds(Vector3 boundsMin, Vector3 boundsMax, Vector3 origin, Quaternion orientation) {
        float dx = boundsMax.X - boundsMin.X;
        float dy = boundsMax.Y - boundsMin.Y;
        if (dx <= 0.01f || dy <= 0.01f) return Array.Empty<Vector2>();
        var localCorners = new[] {
            new Vector2(boundsMin.X, boundsMin.Y),
            new Vector2(boundsMax.X, boundsMin.Y),
            new Vector2(boundsMax.X, boundsMax.Y),
            new Vector2(boundsMin.X, boundsMax.Y),
        };
        return TransformFootprintToWorld(localCorners, origin, orientation);
    }

    private static Vector2[] TransformFootprintToWorld(Vector2[] localCorners, Vector3 origin, Quaternion orientation) {
        if (localCorners.Length == 0) return Array.Empty<Vector2>();
        var world = new Vector2[localCorners.Length];
        for (int i = 0; i < localCorners.Length; i++) {
            var local3 = new Vector3(localCorners[i].X, localCorners[i].Y, 0f);
            var rotated = Vector3.Transform(local3, orientation);
            world[i] = new Vector2(rotated.X + origin.X, rotated.Y + origin.Y);
        }
        return world;
    }

    private static bool PointInPolygon(Vector2 p, Vector2[] poly) {
        bool inside = false;
        for (int i = 0, j = poly.Length - 1; i < poly.Length; j = i++) {
            var a = poly[i]; var b = poly[j];
            if ((a.Y > p.Y) != (b.Y > p.Y) &&
                p.X < (b.X - a.X) * (p.Y - a.Y) / (b.Y - a.Y + 1e-9f) + a.X) {
                inside = !inside;
            }
        }
        return inside;
    }

    // Spawn-cluster pattern detection. A cluster is ≥minMembers same-named spawns
    // whose mutual XY distance is within radiusM. Surfaced as a "creature pack"
    // or "encounter group" pattern for the relations layer.
    private record SpawnCluster(string Name, int Count, float Radius, float CenterX, float CenterY, string Pattern);

    private static List<SpawnCluster> FindSpawnClusters(List<SpawnEntry> spawns, float radiusM, int minMembers) {
        var clusters = new List<SpawnCluster>();
        // Group by name first; then within each name group, find dense clusters.
        var byName = spawns.GroupBy(s => s.Name);
        foreach (var grp in byName) {
            var members = grp.ToList();
            if (members.Count < minMembers) continue;
            // Greedy clustering: pick first un-assigned member as seed, gather
            // others within radiusM, repeat. Good enough for typical 3-15 member
            // packs without needing real DBSCAN.
            var assigned = new HashSet<int>();
            for (int i = 0; i < members.Count; i++) {
                if (assigned.Contains(i)) continue;
                var seed = members[i];
                var cluster = new List<SpawnEntry> { seed };
                assigned.Add(i);
                for (int j = i + 1; j < members.Count; j++) {
                    if (assigned.Contains(j)) continue;
                    var c = members[j];
                    float dx = c.X - seed.X, dy = c.Y - seed.Y;
                    if (dx * dx + dy * dy <= radiusM * radiusM) {
                        cluster.Add(c);
                        assigned.Add(j);
                    }
                }
                if (cluster.Count < minMembers) continue;
                float cx = cluster.Average(c => c.X), cy = cluster.Average(c => c.Y);
                float maxR = cluster.Max(c => MathF.Sqrt((c.X - cx) * (c.X - cx) + (c.Y - cy) * (c.Y - cy)));
                // Pattern label by Acpedia primary category if available
                string pattern = "encounter group";
                if (seed.AcpediaCategories != null && seed.AcpediaCategories.Length > 0) {
                    var cat = seed.AcpediaCategories[0].ToLowerInvariant();
                    pattern = cat.Contains("creature") || cat.Contains("monster") ? "creature pack"
                            : cat.Contains("npc") || cat.Contains("shopkeeper") ? "NPC group"
                            : cat.Contains("portal") ? "portal cluster"
                            : "encounter group";
                }
                clusters.Add(new SpawnCluster(grp.Key, cluster.Count, maxR, cx, cy, pattern));
            }
        }
        return clusters.OrderByDescending(c => c.Count).ToList();
    }

    private static List<ZBand> ClusterByZ(IEnumerable<float> zs, float gap = ZBandGap) {
        var sorted = zs.OrderBy(z => z).ToList();
        var bands = new List<ZBand>();
        if (sorted.Count == 0) return bands;
        float bandMin = sorted[0], bandMax = sorted[0];
        int count = 1;
        for (int i = 1; i < sorted.Count; i++) {
            if (sorted[i] - bandMax > gap) {
                bands.Add(new ZBand(bandMin, bandMax, count));
                bandMin = sorted[i]; count = 0;
            }
            bandMax = sorted[i]; count++;
        }
        bands.Add(new ZBand(bandMin, bandMax, count));
        return bands;
    }

    // ── Naming + relations ─────────────────────────────────────

    private static string? ResolveNameHint(OntologyEntry entry) {
        // Prefer curated Name if enriched, then a tag-based hint.
        if (!string.IsNullOrWhiteSpace(entry.Name)) return entry.Name;
        var tags = entry.Tags;
        if (tags == null || tags.Length == 0) return null;
        var lower = tags.Select(t => t?.ToLowerInvariant() ?? "").ToArray();
        foreach (var hint in new[] { "tavern", "house", "shop", "tower", "temple", "shrine", "wall", "gate", "fortress", "bridge", "well" }) {
            if (lower.Contains(hint)) return hint;
        }
        // Honest catch-all for confirmed buildings that lack a curated name.
        if (lower.Contains("dat:building")) return "building";
        return null;
    }

    private static List<string> SurfaceRelationsWithPois(List<StructureBlock> structures, List<ZBand> looseBands,
                                                 List<int> untagged, InteriorBlock? interior, List<NamedPoi>? pois,
                                                 List<NamedObject>? namedObjects,
                                                 List<SpawnEntry>? spawns) {
        var rels = SurfaceRelations(structures, looseBands, untagged, interior);
        // Named objects (placed weenies resolved to Acpedia pages) — group by primary
        // category so a worker scanning the LB can see what NPC types live here.
        if (namedObjects != null && namedObjects.Count > 0) {
            var byCat = new Dictionary<string, List<string>>();
            foreach (var n in namedObjects) {
                string cat = n.AcpediaCategories.Length > 0 ? n.AcpediaCategories[0] : "(uncategorized)";
                if (!byCat.ContainsKey(cat)) byCat[cat] = new List<string>();
                string label = $"{n.WeenieName} (idx {n.Index}, {n.Tier})";
                byCat[cat].Add(label);
            }
            foreach (var (cat, names) in byCat.OrderByDescending(kv => kv.Value.Count).Take(5)) {
                var sample = names.Take(4);
                string suffix = names.Count > 4 ? $" (+{names.Count - 4})" : "";
                rels.Add($"named placed [{cat}]: {string.Join("; ", sample)}{suffix}");
            }
        }
        // Spawn-cluster patterns: tight spatial groupings of same-named spawns
        // (e.g., 3 wolves within 10m at point P) — wilderness encounter signature
        // worth surfacing as a relation. Catches "creature pack" and "NPC group"
        // patterns without needing world-wide retail mining.
        if (spawns != null && spawns.Count > 0) {
            var clusters = FindSpawnClusters(spawns, radiusM: 10f, minMembers: 3);
            foreach (var c in clusters.Take(4)) {
                rels.Add($"spawn cluster: {c.Count}× {c.Name} within ~{c.Radius:F0}m at ({c.CenterX:F0},{c.CenterY:F0}) — {c.Pattern}");
            }
        }
        // Spawns (server-spawned weenies — NPCs, creatures, quest objects). These
        // come from LSD spawnMaps and are filtered to player-visible by the
        // gazetteer; show grouped by Acpedia category, dedup repeated names.
        if (spawns != null && spawns.Count > 0) {
            var byCat = new Dictionary<string, Dictionary<string, int>>();
            foreach (var s in spawns) {
                string cat = (s.AcpediaCategories != null && s.AcpediaCategories.Length > 0)
                    ? s.AcpediaCategories[0] : "(uncategorized)";
                if (!byCat.ContainsKey(cat)) byCat[cat] = new Dictionary<string, int>();
                byCat[cat].TryGetValue(s.Name, out var c);
                byCat[cat][s.Name] = c + 1;
            }
            foreach (var (cat, names) in byCat.OrderByDescending(kv => kv.Value.Values.Sum()).Take(6)) {
                var sample = names.OrderByDescending(kv => kv.Value).Take(5)
                    .Select(kv => kv.Value > 1 ? $"{kv.Key}×{kv.Value}" : kv.Key);
                int total = names.Values.Sum();
                int unique = names.Count;
                string label = unique > 5 ? $", +{unique - 5} more unique" : "";
                rels.Add($"spawns [{cat}] ({total} total, {unique} unique): {string.Join("; ", sample)}{label}");
            }
        }
        if (pois != null && pois.Count > 0) {
            // Categorize POIs to give a one-line summary instead of dumping all titles.
            var byCat = new Dictionary<string, List<string>>();
            foreach (var p in pois) {
                string cat = p.Categories.Length > 0 ? p.Categories[0] : "(uncategorized)";
                if (!byCat.ContainsKey(cat)) byCat[cat] = new List<string>();
                byCat[cat].Add(p.Title);
            }
            foreach (var (cat, titles) in byCat.OrderByDescending(kv => kv.Value.Count).Take(4)) {
                var sample = titles.Take(3).Select(t => t.Length > 40 ? t[..40] + "…" : t);
                string suffix = titles.Count > 3 ? $" (+{titles.Count - 3})" : "";
                rels.Add($"wiki POI [{cat}]: {string.Join(", ", sample)}{suffix}");
            }
        }
        return rels;
    }

    private static List<string> SurfaceRelations(List<StructureBlock> structures, List<ZBand> looseBands,
                                                 List<int> untagged, InteriorBlock? interior) {
        var rels = new List<string>();
        int emptyCount = 0;
        foreach (var s in structures) {
            if (s.ZBands.Count >= 2) {
                var bands = string.Join(", ", s.ZBands.Select(b => $"z={b.Min:F1}..{b.Max:F1}/n={b.Count}"));
                rels.Add($"structure {s.Index} ({(s.NameHint ?? s.FootprintShape.ToLowerInvariant())}) contents split into {s.ZBands.Count} Z-bands: {bands}");
            }
            if (s.ContainedIndices.Count == 0 && s.FootprintWorld.Length >= 3) {
                emptyCount++;
            }
        }
        // Collapse empty-building spam: report a count instead of one line per building.
        if (emptyCount == 1) {
            var s = structures.First(b => b.ContainedIndices.Count == 0 && b.FootprintWorld.Length >= 3);
            rels.Add($"structure {s.Index} ({(s.NameHint ?? s.FootprintShape.ToLowerInvariant())}) is empty — no contained objects");
        } else if (emptyCount > 1) {
            rels.Add($"{emptyCount} structures contain no objects (shells without props or staging)");
        }
        if (looseBands.Count >= 2) {
            rels.Add($"loose objects span {looseBands.Count} Z-bands ({string.Join(", ", looseBands.Select(b => $"z={b.Min:F1}..{b.Max:F1}/n={b.Count}"))}) — possible unmodelled vertical structure");
        }
        if (untagged.Count >= 5) {
            rels.Add($"{untagged.Count} untagged objects — ontology enrichment candidates (indices {string.Join(",", untagged.Take(8))}{(untagged.Count > 8 ? "…" : "")})");
        }
        if (interior != null && interior.ZBandCount >= 2) {
            rels.Add($"interior dungeon spans {interior.ZBandCount} Z-bands across {interior.CellCount} cells");
        }
        return rels;
    }

    // ── Building shape analysis (model geometry → type features) ──

    public record BuildingShapeFeatures(int? Stories, string? RoofShape, float Height, float BaseSpan);

    // Per-model cache. Geometry is immutable until DATs change at edit time, so a
    // process-wide memo is correct. Keyed by ObjectId; survives describe-landblock
    // calls within a session.
    private static readonly ConcurrentDictionary<uint, BuildingShapeFeatures> _shapeCache = new();

    public static BuildingShapeFeatures? AnalyzeShape(uint modelId, IDatReaderWriter dats) {
        if (_shapeCache.TryGetValue(modelId, out var cached)) return cached;
        var verts = GatherModelVertices(modelId, dats);
        if (verts.Length < 8) return null;
        var feat = AnalyzeVertices(verts);
        _shapeCache[modelId] = feat;
        return feat;
    }

    private static Vector3[] GatherModelVertices(uint modelId, IDatReaderWriter dats) {
        // Setups are 0x02xxxxxx; iterate parts. GfxObjs are 0x01xxxxxx; read directly.
        if ((modelId & 0xFF000000) == 0x02000000) {
            if (!dats.TryGet<Setup>(modelId, out var setup) || setup.Parts == null)
                return Array.Empty<Vector3>();
            var list = new List<Vector3>();
            // Setups can have placement frames offsetting parts; use default frame
            // (key 0) when present so the assembled model is in a consistent space.
            var defaultFrame = setup.PlacementFrames?.Values.FirstOrDefault()?.Frames;
            for (int i = 0; i < setup.Parts.Count; i++) {
                if (!dats.TryGet<GfxObj>(setup.Parts[i], out var part)) continue;
                if (part.VertexArray?.Vertices == null) continue;
                Vector3 offset = Vector3.Zero;
                if (defaultFrame != null && i < defaultFrame.Count) offset = defaultFrame[i].Origin;
                foreach (var v in part.VertexArray.Vertices.Values)
                    list.Add(v.Origin + offset);
            }
            return list.ToArray();
        }
        if (!dats.TryGet<GfxObj>(modelId, out var gfx)) return Array.Empty<Vector3>();
        if (gfx.VertexArray?.Vertices == null) return Array.Empty<Vector3>();
        return gfx.VertexArray.Vertices.Values.Select(v => v.Origin).ToArray();
    }

    private static BuildingShapeFeatures AnalyzeVertices(Vector3[] verts) {
        float zMin = float.PositiveInfinity, zMax = float.NegativeInfinity;
        foreach (var v in verts) { if (v.Z < zMin) zMin = v.Z; if (v.Z > zMax) zMax = v.Z; }
        float h = zMax - zMin;
        if (h < 0.5f) return new BuildingShapeFeatures(null, "flat", h, 0);

        // Story count via 1m-bin Z-histogram peak detection. A floor plane shows
        // up as a Z-bin with a local-max vertex density (eaves, sills, doorframes
        // cluster vertices at their Z). Each storey contributes one peak; the
        // topmost peak is the roof line, so storey count = peaks - 1 (clamped ≥1).
        int binCount = Math.Max(2, (int)Math.Ceiling(h / 1.0f));
        int[] bins = new int[binCount];
        foreach (var v in verts) {
            int b = Math.Min((int)((v.Z - zMin) / 1.0f), binCount - 1);
            bins[b]++;
        }
        float avg = (float)verts.Length / binCount;
        int peaks = 0;
        for (int i = 0; i < binCount; i++) {
            if (bins[i] < avg * 1.5f) continue;
            bool localMax =
                (i == 0 || bins[i] >= bins[i - 1]) &&
                (i == binCount - 1 || bins[i] >= bins[i + 1]);
            if (localMax) peaks++;
        }
        int? stories = peaks > 0 ? Math.Max(1, peaks - 1) : (int?)null;

        // Roof shape: span ratio of top quartile to bottom quartile in XY.
        float topQ = zMin + 0.75f * h, botQ = zMin + 0.25f * h;
        float topMinX = float.PositiveInfinity, topMaxX = float.NegativeInfinity;
        float topMinY = float.PositiveInfinity, topMaxY = float.NegativeInfinity;
        float botMinX = float.PositiveInfinity, botMaxX = float.NegativeInfinity;
        float botMinY = float.PositiveInfinity, botMaxY = float.NegativeInfinity;
        int topN = 0, botN = 0;
        foreach (var v in verts) {
            if (v.Z >= topQ) {
                topN++;
                if (v.X < topMinX) topMinX = v.X; if (v.X > topMaxX) topMaxX = v.X;
                if (v.Y < topMinY) topMinY = v.Y; if (v.Y > topMaxY) topMaxY = v.Y;
            } else if (v.Z <= botQ) {
                botN++;
                if (v.X < botMinX) botMinX = v.X; if (v.X > botMaxX) botMaxX = v.X;
                if (v.Y < botMinY) botMinY = v.Y; if (v.Y > botMaxY) botMaxY = v.Y;
            }
        }
        string? roof = null;
        float baseSpan = 0;
        if (topN > 0 && botN > 0) {
            float topSpan = MathF.Max(topMaxX - topMinX, topMaxY - topMinY);
            baseSpan = MathF.Max(botMaxX - botMinX, botMaxY - botMinY);
            if (baseSpan > 0.1f) {
                float r = topSpan / baseSpan;
                roof = r switch {
                    < 0.15f => "spire",
                    < 0.50f => "tapered",
                    < 0.85f => "pitched",
                    _       => "flat"
                };
            }
        }
        return new BuildingShapeFeatures(stories, roof, h, baseSpan);
    }

    private static string ComposeTypeDescription(OntologyEntry entry, FootprintShape fpShape,
            int? stories, string? roofShape, int? cellCount, float? footprintArea, float? height) {

        // Tower wedge: hexagonal/octagonal footprint + few cells + tall geometry =
        // hollow tower (mage tower pattern). One cell + large per-cell volume = a
        // single-room hollow interior.
        bool isPolygonalFootprint = fpShape == FootprintShape.Hexagon
            || fpShape == FootprintShape.Octagon
            || fpShape == FootprintShape.Round;
        bool isTallNarrow = height.HasValue && footprintArea.HasValue
            && height.Value > 8f
            && footprintArea.Value < 200f
            && height.Value > MathF.Sqrt(footprintArea.Value);  // taller than square root of base area
        bool fewCells = cellCount.HasValue && cellCount.Value <= 3;
        bool isTowerLike = (isPolygonalFootprint || isTallNarrow) && fewCells;

        // Hall wedge: many cells but average per-cell area is large (open space
        // tiled with several cells, perceived as one room).
        float? avgCellArea = (cellCount.HasValue && cellCount.Value > 0 && footprintArea.HasValue)
            ? footprintArea.Value / cellCount.Value
            : (float?)null;
        bool isHall = avgCellArea.HasValue && avgCellArea.Value > 80f && cellCount > 1;

        // Base noun
        string noun = isTowerLike ? "tower" : isHall ? "hall" : "building";

        var basePhrase = new List<string>();

        if (!string.IsNullOrWhiteSpace(entry.Architecture) && entry.Architecture != "Neutral") {
            basePhrase.Add(entry.Architecture.ToLowerInvariant());
        }

        if (stories.HasValue) {
            basePhrase.Add(stories.Value switch {
                1 => "single-story",
                2 => "two-story",
                3 => "three-story",
                4 => "four-story",
                _ => $"{stories}-story"
            });
        } else if (!string.IsNullOrEmpty(entry.Scale) && entry.Scale != "Unknown") {
            basePhrase.Add(entry.Scale.ToLowerInvariant());
        }

        // Footprint adjective — only mention when it's distinctive (rectangle is
        // the boring default and is implicit).
        if (isPolygonalFootprint) basePhrase.Add(fpShape.ToString().ToLowerInvariant());

        basePhrase.Add(noun);

        // Suffix clauses, comma-joined.
        var suffixes = new List<string>();
        if (!string.IsNullOrEmpty(roofShape) && roofShape != "flat") {
            suffixes.Add($"{roofShape} roof");
        }
        if (isTowerLike && cellCount == 1) {
            suffixes.Add("hollow interior");
        } else if (cellCount.HasValue && cellCount.Value > 1 && !isHall) {
            suffixes.Add($"{cellCount.Value} interior cells");
        } else if (isHall && cellCount.HasValue) {
            suffixes.Add($"{cellCount.Value}-cell open layout");
        }
        if (entry.MaterialTags is { Length: > 0 } mats) {
            var picked = mats.Take(2).ToArray();
            if (picked.Length > 0) suffixes.Add(string.Join("/", picked));
        }

        var result = string.Join(" ", basePhrase);
        if (suffixes.Count > 0) result += " with " + string.Join(", ", suffixes);
        return result;
    }

    // ── Verbal composition ─────────────────────────────────────

    private static string ComposeVerbal(string landblock, uint lbX, uint lbY,
            ContextBlock ctx, TerrainBlock terrain, LandblockBody body) {
        var sb = new StringBuilder();

        // Lead with town name when known, otherwise region name, otherwise LB key.
        // The brief's inheritance rule: parent zoom names the place, LB doesn't
        // repeat what the parent already established.
        if (!string.IsNullOrEmpty(ctx.TownName)) {
            sb.Append($"{ctx.TownName}");
            if (!string.IsNullOrEmpty(ctx.RegionName)) sb.Append($", {ctx.RegionName}");
            sb.Append($" (LB {landblock}, {lbX},{lbY}). ");
        } else if (!string.IsNullOrEmpty(ctx.RegionName)) {
            sb.Append($"{ctx.RegionName} (LB {landblock}, {lbX},{lbY}). ");
        } else {
            sb.Append($"Landblock {landblock} ({lbX},{lbY}). ");
        }

        // Context line. When a region or culture is established by parent zoom, the
        // biome is implicit and we don't repeat it. Just say the local LB role.
        var ctxParts = new List<string>();
        bool parentZoomEstablishedBiome = !string.IsNullOrEmpty(ctx.RegionName) || !string.IsNullOrEmpty(ctx.Culture);
        if (!string.IsNullOrEmpty(ctx.Culture)) {
            // Settlement hint piggybacks on culture: "Aluvian settlement" not "Aluvian; settlement (≥3 structures)"
            if (ctx.StructureCount >= 3) ctxParts.Add($"{ctx.Culture} settlement");
            else if (ctx.StructureCount >= 1) ctxParts.Add($"{ctx.Culture} structure(s)");
            // No "X territory" when a region has already established the cultural area
        } else if (!parentZoomEstablishedBiome) {
            // No parent context at all — fall back to per-LB inference
            if (ctx.Biome != null) ctxParts.Add($"{ctx.Biome} biome");
            if (ctx.SettlementHint != null) ctxParts.Add(ctx.SettlementHint);
        } else {
            // Region exists but no town/culture override — surface the LB-local hint
            if (ctx.SettlementHint != null) ctxParts.Add(ctx.SettlementHint);
        }
        if (ctxParts.Count > 0) sb.Append(string.Join("; ", ctxParts)).Append(". ");

        // Terrain
        sb.Append(char.ToUpperInvariant(terrain.Summary[0]) + terrain.Summary[1..]);
        sb.Append($" (Z {terrain.HeightMin:F1}..{terrain.HeightMax:F1}). ");

        // Object body
        if (body.ObjectTotal == 0) {
            sb.Append("Empty: no static objects. ");
        } else {
            sb.Append($"{body.ObjectTotal} objects");
            if (body.Structures.Count > 0) sb.Append($" ({body.Structures.Count} structure{(body.Structures.Count == 1 ? "" : "s")})");
            sb.Append(". ");

            foreach (var s in body.Structures.Take(3)) {
                var label = !string.IsNullOrEmpty(s.TypeDescription) ? s.TypeDescription
                            : s.NameHint ?? s.FootprintShape.ToLowerInvariant();
                sb.Append($"{char.ToUpperInvariant(label[0])}{label[1..]} at ({s.Origin.X:F0},{s.Origin.Y:F0}) z={s.Origin.Z:F1}");
                if (s.ContainedIndices.Count > 0) {
                    sb.Append($" containing {s.ContainedIndices.Count} object{(s.ContainedIndices.Count == 1 ? "" : "s")}");
                    if (s.ZBands.Count >= 2) sb.Append($" across {s.ZBands.Count} Z-bands");
                }
                sb.Append(". ");
            }
            if (body.Structures.Count > 3) sb.Append($"(+{body.Structures.Count - 3} more structures.) ");

            if (body.LooseObjectCount > 0) {
                sb.Append($"{body.LooseObjectCount} loose object{(body.LooseObjectCount == 1 ? "" : "s")}");
                if (body.LooseZBands.Count >= 2) sb.Append($" in {body.LooseZBands.Count} Z-bands");
                sb.Append(". ");
            }

            if (body.UntaggedIndices.Count > 0) sb.Append($"{body.UntaggedIndices.Count} untagged. ");
        }

        if (body.Interior != null) {
            sb.Append($"Interior cells: {body.Interior.CellCount}, Z {body.Interior.ZMin:F1}..{body.Interior.ZMax:F1}");
            if (body.Interior.ZBandCount >= 2) sb.Append($" ({body.Interior.ZBandCount} bands)");
            sb.Append($", {body.Interior.CellGraphEdges} interior edges");
            if (body.Interior.ExteriorPortals > 0) sb.Append($", {body.Interior.ExteriorPortals} exterior portal{(body.Interior.ExteriorPortals == 1 ? "" : "s")}");
            sb.Append('.');
        } else {
            sb.Append("No interior cells.");
        }

        return sb.ToString();
    }
}
