using System.Globalization;
using System.Numerics;
using DatReaderWriter.DBObjs;
using SkiaSharp;
using DatReaderWriter.Options;
using DatReaderWriter.Types;
using DatReaderWriter.Extensions.DBObjs;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.AceDb;
using WorldBuilder.Shared.Lib.Dungeon;
using WorldBuilder.Shared.Lib.Noise;
using WorldBuilder.Shared.Lib.Spawn;
using WorldBuilder.Shared.Lib.Terrain;
using WorldBuilder.Shared.Lib.Validation;
using WorldBuilder.Shared.Lib.WorldGen;
using WorldBuilder.Shared.Models;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Terminal;

/// <summary>
/// Shared command engine that contains all WorldBuilder business logic.
/// Both <see cref="TerminalRepl"/> and <see cref="JsonCommandProcessor"/>
/// delegate to this class. The engine operates on parsed parameters and
/// returns structured result records â€” it never touches Console or JSON directly.
/// </summary>
public partial class CommandEngine {
    /// <summary>
    /// Active log file path when --log-file was passed at startup. Null otherwise.
    /// Set by Program.cs after constructing FileLoggerProvider so commands like
    /// `open-log-folder` can surface it to agents without folder-opening side effects.
    /// </summary>
    public static string? ActiveLogPath { get; set; }

    private readonly HeadlessProjectManager _projectManager;
    private readonly ITerrainService _terrainService;
    private readonly IObjectPlacementService _objectPlacementService;
    private readonly IDungeonService _dungeonService;
    private readonly IOntologyService _ontologyService;
    private readonly IStampService _stampService;

    // Cached terrain helpers (lazily initialised, invalidated on project load)
    private TerrainDocument? _terrainDocCache;
    private float[]? _heightTableCache;
    private bool _heightTableSynthetic;

    // Building-pairings registry. Auto-loaded on project load when a sibling
    // building_pairings.json exists. Used by RemapBuildingsV2 to share a
    // single targetGroundZ across grouped buildings (fortress walls, etc.).
    private WorldBuilder.Shared.Lib.Pairings.BuildingPairings _buildingPairings = new();

    // Town gazetteer keyed by lbKey: maps a known landblock to its town name + culture.
    // Loaded from project-directory `town_gazetteer.json` if present. Acts as the
    // "parent zoom" parent context the describer uses to override per-LB inference
    // — see the atlas inheritance rule in the brief.
    private Dictionary<ushort, LandblockDescriber.TownContext> _townGazetteer = new();

    // Acpedia-derived POI index keyed by lbKey: maps each landblock to wiki POIs
    // (NPCs, landmarks, objects, etc.) the wiki places there. Loaded from project-
    // directory `poi_gazetteer.json` if present.
    private Dictionary<ushort, List<LandblockDescriber.NamedPoi>> _poiGazetteer = new();

    // wcid → Acpedia page; built offline from LSD weenies × Acpedia by name match.
    // Used to attribute placed creatures/NPCs/items to wiki pages so the describer
    // can surface "Buckminster the Barkeeper" instead of just "Creature index 47".
    private Dictionary<int, LandblockDescriber.AcpediaMatch> _wcidToAcpedia = new();

    // Server-spawn gazetteer: per-LB spawn records sourced from either the
    // LSD-Partial spawnMap dump or the ACE world DB's `landblock_instance`
    // table (resolved at load time via `SpawnGazetteerBuilder`). Distinct
    // from `_wcidToAcpedia` (which annotates DAT-placed objects). The
    // canonical type is now `SpawnRecord` from Shared/Lib/AceDb so the
    // describer, renderer, and ACE-DB ingest commands all share one schema.
    private Dictionary<ushort, List<SpawnRecord>> _spawnGazetteer = new();

    // Canonical wcid → identity index. Populated from the ACE DB via
    // `ace-db ingest-weenie-index` and persisted as `weenie_index.jsonl`
    // in the project directory. Step 1 of the WeenieIndex migration —
    // additive, no consumers wired yet (see Step 2 for the resolver hookup).
    private WorldBuilder.Shared.Lib.WeenieIndex _weenieIndex = WorldBuilder.Shared.Lib.WeenieIndex.Empty;

    // Region gazetteer (parent zoom above LB). Maps each LB to a named region
    // via nearest-town assignment using anchor points loaded from JSON.
    private record RegionAnchor(int LbX, int LbY, string Region);
    private Dictionary<string, LandblockDescriber.RegionContext> _regions = new();
    private List<RegionAnchor> _regionAnchors = new();
    private Dictionary<ushort, LandblockDescriber.RegionContext> _lbToRegionCache = new();

    // Tile cache + generator (lazy-init on first tile call). The cache backs to
    // disk under projects/<name>/atlas_tiles; the generator uses render-preview.
    private TileCache? _tileCache;
    private TileGenerator? _tileGenerator;
    private double _tileBudgetGB = 2.0;

    public CommandEngine(
        HeadlessProjectManager projectManager,
        ITerrainService terrainService,
        IObjectPlacementService objectPlacementService,
        IDungeonService dungeonService,
        IOntologyService ontologyService,
        IStampService stampService) {
        _projectManager = projectManager;
        _terrainService = terrainService;
        _objectPlacementService = objectPlacementService;
        _dungeonService = dungeonService;
        _ontologyService = ontologyService;
        _stampService = stampService;
    }

    // ─── Internal accessors used by TransactDiffEngine. ───────────────────
    // The diff engine needs the same ontology / pairings / height-table
    // wiring the live render-preview path uses; exposing them here keeps
    // the diff engine from re-deriving any of this state.
    internal IOntologyService Ontology => _ontologyService;
    internal Func<uint, uint> PairingsGroupKey => id => _buildingPairings.GroupKey(id);
    internal HeadlessProjectManager ProjectManager => _projectManager;
    internal float[] GetHeightTableForDiff() => GetHeightTable();

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Project management
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public LoadResult Load(string projectPath) {
        _projectManager.LoadProject(projectPath);
        InvalidateCaches();
        var p = _projectManager.CurrentProject!;

        var ontology = AutoRestoreOntology(p.ProjectDirectory);
        var pairings = AutoRestorePairings(p.ProjectDirectory);
        var towns    = AutoRestoreTownGazetteer(p.ProjectDirectory);
        var pois     = AutoRestorePoiGazetteer(p.ProjectDirectory);
        var wcid     = AutoRestoreWcidAcpedia(p.ProjectDirectory);
        var spawns   = AutoRestoreSpawnGazetteer(p.ProjectDirectory);
        var regions  = AutoRestoreRegions(p.ProjectDirectory);
        var weenieIx = AutoRestoreWeenieIndex(p.ProjectDirectory);

        var report = new LoadAutoRestoreReport(
            ontology, pairings, towns, pois, wcid, spawns, regions, weenieIx);
        return new LoadResult(p.Name, p.FilePath, p.ProjectDirectory,
            p.BaseDatDirectory, report);
    }

    private LoadAutoRestoreEntry AutoRestoreOntology(string projectDir) {
        var path = Path.Combine(projectDir, "ontology_cache.jsonl");
        if (!File.Exists(path)) {
            // Drop the previous project's ontology so it doesn't bleed into
            // the new one. LoadFromCache replaces the index, but when there's
            // nothing to load we have to clear explicitly.
            _ontologyService.Clear();
            return new LoadAutoRestoreEntry(path, FilePresent: false, Loaded: false, Count: 0);
        }
        try {
            int restored = _ontologyService.LoadFromCache(path);
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: true, Count: restored);
        } catch (Exception ex) {
            _ontologyService.Clear();
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: false, Count: 0, Error: ex.Message);
        }
    }

    private LoadAutoRestoreEntry AutoRestorePairings(string projectDir) {
        var path = Path.Combine(projectDir, "building_pairings.json");
        if (!File.Exists(path)) {
            _buildingPairings = new WorldBuilder.Shared.Lib.Pairings.BuildingPairings();
            return new LoadAutoRestoreEntry(path, FilePresent: false, Loaded: false, Count: 0);
        }
        try {
            _buildingPairings = WorldBuilder.Shared.Lib.Pairings.BuildingPairings.LoadFromJsonFile(path);
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: true, Count: _buildingPairings.EdgeCount);
        } catch (Exception ex) {
            _buildingPairings = new WorldBuilder.Shared.Lib.Pairings.BuildingPairings();
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: false, Count: 0, Error: ex.Message);
        }
    }

    private LoadAutoRestoreEntry AutoRestoreTownGazetteer(string projectDir) {
        var path = Path.Combine(projectDir, "town_gazetteer.json");
        if (!File.Exists(path)) {
            _townGazetteer = new();
            return new LoadAutoRestoreEntry(path, FilePresent: false, Loaded: false, Count: 0);
        }
        try {
            _townGazetteer = LoadTownGazetteer(path);
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: true, Count: _townGazetteer.Count);
        } catch (Exception ex) {
            _townGazetteer = new();
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: false, Count: 0, Error: ex.Message);
        }
    }

    private LoadAutoRestoreEntry AutoRestorePoiGazetteer(string projectDir) {
        var path = Path.Combine(projectDir, "poi_gazetteer.json");
        if (!File.Exists(path)) {
            _poiGazetteer = new();
            return new LoadAutoRestoreEntry(path, FilePresent: false, Loaded: false, Count: 0);
        }
        try {
            _poiGazetteer = LoadPoiGazetteer(path);
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: true, Count: _poiGazetteer.Count);
        } catch (Exception ex) {
            _poiGazetteer = new();
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: false, Count: 0, Error: ex.Message);
        }
    }

    private LoadAutoRestoreEntry AutoRestoreWcidAcpedia(string projectDir) {
        var path = Path.Combine(projectDir, "wcid_acpedia_join.jsonl");
        if (!File.Exists(path)) {
            _wcidToAcpedia = new();
            return new LoadAutoRestoreEntry(path, FilePresent: false, Loaded: false, Count: 0);
        }
        try {
            _wcidToAcpedia = LoadWcidAcpedia(path);
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: true, Count: _wcidToAcpedia.Count);
        } catch (Exception ex) {
            _wcidToAcpedia = new();
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: false, Count: 0, Error: ex.Message);
        }
    }

    private LoadAutoRestoreEntry AutoRestoreSpawnGazetteer(string projectDir) {
        // Prefer the ACE-DB-sourced JSONL when present: it includes the
        // server-managed weenies (doors, statues, generators, fences) that
        // the LSD JSON dump filters out, plus orientation. Fall back to
        // spawn_gazetteer.json (LSD format) when only that exists.
        var acePath = Path.Combine(projectDir, "ace_spawn_records.jsonl");
        if (File.Exists(acePath)) {
            try {
                _spawnGazetteer = LoadSpawnGazetteerJsonl(acePath);
                return new LoadAutoRestoreEntry(acePath, FilePresent: true, Loaded: true, Count: _spawnGazetteer.Count);
            } catch (Exception ex) {
                _spawnGazetteer = new();
                return new LoadAutoRestoreEntry(acePath, FilePresent: true, Loaded: false, Count: 0, Error: ex.Message);
            }
        }
        var path = Path.Combine(projectDir, "spawn_gazetteer.json");
        if (!File.Exists(path)) {
            _spawnGazetteer = new();
            return new LoadAutoRestoreEntry(path, FilePresent: false, Loaded: false, Count: 0);
        }
        try {
            _spawnGazetteer = LoadSpawnGazetteer(path);
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: true, Count: _spawnGazetteer.Count);
        } catch (Exception ex) {
            _spawnGazetteer = new();
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: false, Count: 0, Error: ex.Message);
        }
    }

    private LoadAutoRestoreEntry AutoRestoreRegions(string projectDir) {
        // Reset before attempting load so a re-load can't keep stale region
        // assignments from the previous project even if the new file is absent.
        _regions = new();
        _regionAnchors = new();
        _lbToRegionCache = new();
        var path = Path.Combine(projectDir, "region_gazetteer.json");
        if (!File.Exists(path)) {
            return new LoadAutoRestoreEntry(path, FilePresent: false, Loaded: false, Count: 0);
        }
        try {
            LoadRegionGazetteer(path);
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: true, Count: _regions.Count);
        } catch (Exception ex) {
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: false, Count: 0, Error: ex.Message);
        }
    }

    private LoadAutoRestoreEntry AutoRestoreWeenieIndex(string projectDir) {
        var path = Path.Combine(projectDir, "weenie_index.jsonl");
        if (!File.Exists(path)) {
            _weenieIndex = WorldBuilder.Shared.Lib.WeenieIndex.Empty;
            return new LoadAutoRestoreEntry(path, FilePresent: false, Loaded: false, Count: 0);
        }
        try {
            _weenieIndex = WorldBuilder.Shared.Lib.WeenieIndex.LoadJsonl(path);
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: true, Count: _weenieIndex.Count);
        } catch (Exception ex) {
            _weenieIndex = WorldBuilder.Shared.Lib.WeenieIndex.Empty;
            return new LoadAutoRestoreEntry(path, FilePresent: true, Loaded: false, Count: 0, Error: ex.Message);
        }
    }

    private static Dictionary<ushort, LandblockDescriber.TownContext> LoadTownGazetteer(string path) {
        var result = new Dictionary<ushort, LandblockDescriber.TownContext>();
        using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(path));
        foreach (var entry in doc.RootElement.EnumerateObject()) {
            var name = entry.Name;
            var v = entry.Value;
            if (!v.TryGetProperty("lb_key", out var lbEl) || lbEl.ValueKind != System.Text.Json.JsonValueKind.Number)
                continue;
            int lbInt = lbEl.GetInt32();
            if (lbInt <= 0 || lbInt > 0xFFFF) continue;
            ushort lbKey = (ushort)lbInt;
            string? culture = v.TryGetProperty("culture", out var cEl) && cEl.ValueKind == System.Text.Json.JsonValueKind.String
                ? cEl.GetString() : null;
            string? notes = v.TryGetProperty("notes", out var nEl) && nEl.ValueKind == System.Text.Json.JsonValueKind.String
                ? nEl.GetString() : null;
            // First write wins so the canonical town name (typically the first
            // primary entry per LB) takes precedence over secondary entries.
            if (!result.ContainsKey(lbKey)) {
                result[lbKey] = new LandblockDescriber.TownContext(name, culture, notes);
            }
        }
        return result;
    }

    public ExportResult Export(string directory, int? iteration) {
        RequireProject();
        var result = _projectManager.ExportDats(directory, iteration);
        // F59: report the EFFECTIVE iteration actually stamped onto entries (never
        // null), not the raw request arg — so an agent that omitted `iteration`
        // can still learn the current+1 value that was written.
        return new ExportResult(result.Success, directory, result.EffectiveIteration,
            result.TerrainWritten, result.TerrainSaveFailures, result.DocsSaved, result.DocSaveFailures);
    }

    public async Task<ExportWithRepositionResult> ExportWithRepositionAsync(
        string directory, int? iteration) {
        RequireProject();
        var project = _projectManager.CurrentProject!;

        // Check if ace-db settings exist BEFORE exporting so we can decide whether
        // to wire the reposition hook at all.
        var settings = project.AceDb;
        bool haveAceDb = settings != null && !string.IsNullOrEmpty(settings.Host);

        // F60: previously this method re-derived oldTerrain/newTerrain from the raw
        // terrain doc AFTER ExportDats returned — ignoring export-layer composition,
        // so the reposition saw pre-layer heights (and skipped layer-only-modified
        // LBs entirely) while the DAT got layer-composited heights. The instances
        // then floated/sank relative to the exported terrain. Fix: run reposition
        // through Project.ExportDats's OnExportReposition hook, which fires with the
        // SAME composited oldTerrain/newTerrain/modifiedLandblocks it wrote to the DAT.
        InstanceRepositionService.RepositionResult? repoResult = null;
        Exception? repoException = null;
        bool repositionAttempted = false;

        Func<RepositionContext, Task>? previousHook = project.OnExportReposition;
        if (haveAceDb) {
            project.OnExportReposition = async ctx => {
                repositionAttempted = true;
                try {
                    var repoSettings = new AceDbSettings {
                        Host = settings!.Host, Port = settings.Port,
                        Database = settings.Database, User = settings.User,
                        Password = settings.Password,
                        EnableReposition = true,
                        ApplyDirectly = true,
                        Threshold = settings.Threshold
                    };
                    var service = new InstanceRepositionService();
                    repoResult = await service.RunAsync(repoSettings, ctx);
                } catch (Exception ex) {
                    repoException = ex;
                }
            };
        }

        ExportDatsResult exportResult;
        try {
            exportResult = _projectManager.ExportDats(directory, iteration);
        } finally {
            project.OnExportReposition = previousHook;
        }

        int effIteration = exportResult.EffectiveIteration;

        if (!exportResult.Success) {
            return new ExportWithRepositionResult(false, directory, effIteration,
                false, false, 0, 0, 0,
                $"DAT export failed: {exportResult.TerrainSaveFailures} terrain + {exportResult.DocSaveFailures} document write(s) failed");
        }

        if (!haveAceDb) {
            return new ExportWithRepositionResult(true, directory, effIteration,
                false, false, 0, 0, 0, "No ACE database settings configured. Use 'ace-db connect' first.");
        }

        if (repoException != null) {
            return new ExportWithRepositionResult(true, directory, effIteration,
                true, false, 0, 0, 0, repoException.Message);
        }

        if (!repositionAttempted || repoResult == null) {
            // ExportDats only fires OnExportReposition when there are composited
            // terrain deltas (oldTerrain/newTerrain non-empty) and a height table.
            return new ExportWithRepositionResult(true, directory, effIteration,
                true, true, 0, 0, 0, "No modified landblocks detected — nothing to reposition");
        }

        await Task.CompletedTask;
        return new ExportWithRepositionResult(true, directory, effIteration,
            true, repoResult.Error == null,
            repoResult.InstancesChecked, repoResult.InstancesUpdated,
            repoResult.LandblocksProcessed,
            repoResult.Error);
    }

    public TerrainSampleHeightResult SampleHeight(float worldX, float worldY) {
        RequireProject();
        var (_, terrainLookup, _) = GetTerrainHelpers();
        var heightTable = GetHeightTable();

        uint lbX = (uint)Math.Floor(worldX / 192f);
        uint lbY = (uint)Math.Floor(worldY / 192f);

        if (lbX >= 254 || lbY >= 254) {
            return new TerrainSampleHeightResult(worldX, worldY, 0, 0, 0, 0, 0, 0,
                "Position out of map bounds");
        }

        ushort lbId = (ushort)((lbX << 8) | lbY);
        var data = terrainLookup(lbId);
        if (data == null) {
            return new TerrainSampleHeightResult(worldX, worldY, 0, 0, 0, lbId, 0, 0,
                $"No terrain data for landblock 0x{lbId:X4}");
        }

        float localX = worldX - lbX * 192f;
        float localY = worldY - lbY * 192f;

        // Triangle-interpolated height (AC-accurate)
        float triHeight = TerrainAlgorithms.SampleHeightTriangle(
            data, heightTable, localX, localY, lbX, lbY);

        // Nearest-vertex height (quantized)
        int cellX = (int)Math.Round(localX / 24f);
        int cellY = (int)Math.Round(localY / 24f);
        cellX = Math.Clamp(cellX, 0, 8);
        cellY = Math.Clamp(cellY, 0, 8);
        int vIdx = cellX * 9 + cellY;
        float vertexHeight = vIdx < data.Length ? heightTable[data[vIdx].Height] : 0f;

        return new TerrainSampleHeightResult(worldX, worldY,
            triHeight, vertexHeight, triHeight - vertexHeight,
            lbId, localX, localY);
    }

    public ProjectInfoResult GetInfo() {
        var p = _projectManager.CurrentProject;
        if (p == null) return new ProjectInfoResult(false);
        int? portalIter = null;
        try { portalIter = p.DocumentManager.Dats.Dats.Portal.Iteration.CurrentIteration; } catch { }
        return new ProjectInfoResult(true, p.Name, p.FilePath, p.ProjectDirectory,
            p.BaseDatDirectory, p.DatabasePath, portalIter);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Terrain editing
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public TerrainEditResult Smooth(float x, float y, float radius, float strength = 0.5f) =>
        ApplyTerrainEdit(new SmoothEdit(x, y, radius, strength));

    public TerrainEditResult Raise(float x, float y, float radius, int delta = 5) {
        // Reject negative input rather than silently flipping it to positive
        // (the old behavior). Callers wanting to lower terrain should call Lower.
        if (delta < 0)
            throw new ArgumentException(
                $"raise requires delta >= 0; got {delta}. Use 'lower' for negative deltas.");
        return ApplyTerrainEdit(new RaiseEdit(x, y, radius, delta));
    }

    public TerrainEditResult Lower(float x, float y, float radius, int delta = 5) {
        if (delta < 0)
            throw new ArgumentException(
                $"lower requires delta >= 0; got {delta}. Use 'raise' for the opposite direction.");
        return ApplyTerrainEdit(new LowerEdit(x, y, radius, delta));
    }

    public TerrainEditResult SetHeight(float x, float y, float radius, byte targetHeight) =>
        ApplyTerrainEdit(new SetHeightEdit(x, y, radius, targetHeight));

    public TerrainEditResult Paint(float x, float y, float radius, byte terrainType) =>
        ApplyTerrainEdit(new PaintEdit(x, y, radius, terrainType));

    /// <summary>
    /// Single entry point for every terrain-edit op. New ops (ridge, erode,
    /// slope, etc.) get added by extending the TerrainEditOp record hierarchy
    /// and a switch arm here, not by copy-pasting the prelude. Validation,
    /// affected-vertex selection, and batching live here exactly once.
    /// </summary>
    public TerrainEditResult ApplyTerrainEdit(TerrainEditOp op) {
        RequireProject();
        ValidateBrush(op.X, op.Y, op.Radius);
        var (doc, tl, hl) = GetTerrainHelpers();
        var affected = _terrainService.GetAffectedVertices(new Vector3(op.X, op.Y, 0), op.Radius, hl);

        return op switch {
            SmoothEdit s    => ApplyHeightEdit(doc, _terrainService.ComputeSmooth(affected, s.Strength, tl)),
            RaiseEdit r     => ApplyHeightEdit(doc, _terrainService.ComputeRaiseLower(affected,  r.Delta, tl)),
            LowerEdit l     => ApplyHeightEdit(doc, _terrainService.ComputeRaiseLower(affected, -l.Delta, tl)),
            SetHeightEdit h => ApplyHeightEdit(doc, _terrainService.ComputeSetHeight(affected, h.HeightIndex, tl)),
            PaintEdit p     => ApplyPaintEdit(doc, affected, p.TerrainType, tl),
            _ => throw new ArgumentOutOfRangeException(nameof(op), op.GetType().Name, "Unknown terrain edit op")
        };
    }

    private static void ValidateBrush(float x, float y, float radius) {
        if (!float.IsFinite(x))      throw new ArgumentException($"x must be finite; got {x}");
        if (!float.IsFinite(y))      throw new ArgumentException($"y must be finite; got {y}");
        if (!float.IsFinite(radius)) throw new ArgumentException($"radius must be finite; got {radius}");
        if (radius <= 0f)            throw new ArgumentException($"radius must be > 0; got {radius}");
    }

    private static TerrainEditResult ApplyPaintEdit(
        TerrainDocument doc,
        List<(ushort LandblockId, int VertexIndex, Vector3 Position)> affected,
        byte terrainType,
        Func<ushort, TerrainEntry[]?> tl) {
        int estimatedLandblocks = Math.Min(affected.Count, 256);
        var batchChanges = new Dictionary<ushort, Dictionary<byte, uint>>(estimatedLandblocks);
        var terrainCache = new Dictionary<ushort, TerrainEntry[]?>(estimatedLandblocks);
        int changeCount = 0;
        foreach (var (lbId, vIndex, _) in affected) {
            if (!terrainCache.TryGetValue(lbId, out var data)) {
                data = tl(lbId);
                terrainCache[lbId] = data;
            }

            if (data == null || data[vIndex].Type == terrainType) continue;
            if (!batchChanges.TryGetValue(lbId, out var lbChanges)) {
                lbChanges = new Dictionary<byte, uint>(16);
                batchChanges[lbId] = lbChanges;
            }
            var current = data[vIndex];
            lbChanges[(byte)vIndex] = (current with { Type = terrainType }).ToUInt();
            changeCount++;
        }

        if (changeCount == 0) return new TerrainEditResult(0, new HashSet<ushort>());
        doc.UpdateLandblocksBatchInternal(batchChanges, out var modifiedLbs);
        return new TerrainEditResult(changeCount, modifiedLbs);
    }

    public TerrainEditResult Fill(float x, float y, byte newType) {
        RequireProject();
        var (doc, tl, _) = GetTerrainHelpers();

        // World bounds: landblock X/Y indices are 0..254, each 192 units wide, so
        // valid world coordinates are [0, 255*192). A negative or over-range seed
        // wraps when cast to uint and seeds the flood-fill into a landblock the
        // caller never named, mutating and persisting unrelated terrain.
        const float worldMax = 255f * 192f; // 48960
        if (x < 0f || x >= worldMax)
            throw new ArgumentException($"'x' must be within [0, {worldMax}); got {x}", nameof(x));
        if (y < 0f || y >= worldMax)
            throw new ArgumentException($"'y' must be within [0, {worldMax}); got {y}", nameof(y));

        uint lbX = (uint)Math.Floor(x / 192f);
        uint lbY = (uint)Math.Floor(y / 192f);
        float localX = x - lbX * 192f;
        float localY = y - lbY * 192f;
        uint cellX = Math.Min((uint)Math.Round(localX / 24f), 8);
        uint cellY = Math.Min((uint)Math.Round(localY / 24f), 8);

        var fillResult = _terrainService.FloodFill(lbX, lbY, cellX, cellY, newType, tl);
        if (fillResult.Count == 0) return new TerrainEditResult(0, new HashSet<ushort>());

        int estimatedLandblocks = Math.Min(fillResult.Count, 256);
        var batchChanges = new Dictionary<ushort, Dictionary<byte, uint>>(estimatedLandblocks);
        var terrainCache = new Dictionary<ushort, TerrainEntry[]?>(estimatedLandblocks);
        foreach (var (lbId, vIndex, _) in fillResult) {
            if (!terrainCache.TryGetValue(lbId, out var data)) {
                data = tl(lbId);
                terrainCache[lbId] = data;
            }

            if (data == null) continue;
            if (!batchChanges.TryGetValue(lbId, out var lbChanges)) {
                lbChanges = new Dictionary<byte, uint>(16);
                batchChanges[lbId] = lbChanges;
            }
            var current = data[vIndex];
            lbChanges[(byte)vIndex] = (current with { Type = newType }).ToUInt();
        }

        doc.UpdateLandblocksBatchInternal(batchChanges, out var modifiedLbs);
        return new TerrainEditResult(fillResult.Count, modifiedLbs);
    }

    public RoadResult DrawRoad(float x1, float y1, float x2, float y2, byte roadValue = 1) {
        RequireProject();
        var (doc, tl, hl) = GetTerrainHelpers();
        var path = _terrainService.GenerateRoadPath(
            new Vector3(x1, y1, 0), new Vector3(x2, y2, 0), hl);

        if (path.Count == 0) return new RoadResult(0, 0, roadValue, new HashSet<ushort>());

        int estimatedLandblocks = Math.Min(path.Count, 256);
        var batchChanges = new Dictionary<ushort, Dictionary<byte, uint>>(estimatedLandblocks);
        var terrainCache = new Dictionary<ushort, TerrainEntry[]?>(estimatedLandblocks);
        int changeCount = 0;

        // Writes roadValue to a single (landblock, vertex) cell, batching the change.
        // Returns true if it actually changed the cell. Used both for the primary
        // vertex and for the duplicated seam vertices of edge/corner neighbors.
        bool WriteRoad(ushort lbId, int vIndex) {
            if (!terrainCache.TryGetValue(lbId, out var data)) {
                data = tl(lbId);
                terrainCache[lbId] = data;
            }
            if (data == null || vIndex < 0 || vIndex >= data.Length) return false;
            if (data[vIndex].Road == roadValue) return false;
            if (!batchChanges.TryGetValue(lbId, out var lbChanges)) {
                lbChanges = new Dictionary<byte, uint>(16);
                batchChanges[lbId] = lbChanges;
            }
            var current = data[vIndex];
            lbChanges[(byte)vIndex] = (current with { Road = roadValue }).ToUInt();
            return true;
        }

        const int mapSize = (int)TerrainAlgorithms.MapSize; // 254 — last valid LB index
        foreach (var wp in path) {
            var vi = _terrainService.WorldToVertex(wp.X, wp.Y);
            if (!vi.HasValue) continue;
            var (lbId, vIndex) = vi.Value;

            if (WriteRoad(lbId, vIndex)) changeCount++;

            // AC terrain duplicates each landblock-edge vertex onto the neighbor's
            // mirrored row/column (col/row 8 of LB N == col/row 0 of LB N+1). A road
            // crossing an LB boundary must set the same Road byte on every duplicate,
            // else the exported DATs disagree across the seam and the client renders a
            // gap. Mirror exactly as TerrainAlgorithms.AddEdgeNeighbors does.
            int lbX = lbId >> 8, lbY = lbId & 0xFF;
            int localVX = vIndex / 9, localVY = vIndex % 9;

            if (localVX == 0 && lbX > 0)
                WriteRoad((ushort)(((lbX - 1) << 8) | lbY), 8 * 9 + localVY);
            if (localVX == 8 && lbX < mapSize - 1)
                WriteRoad((ushort)(((lbX + 1) << 8) | lbY), 0 * 9 + localVY);
            if (localVY == 0 && lbY > 0)
                WriteRoad((ushort)((lbX << 8) | (lbY - 1)), localVX * 9 + 8);
            if (localVY == 8 && lbY < mapSize - 1)
                WriteRoad((ushort)((lbX << 8) | (lbY + 1)), localVX * 9 + 0);

            // Corners are shared by four landblocks: mirror onto the diagonal too.
            if (localVX == 0 && localVY == 0 && lbX > 0 && lbY > 0)
                WriteRoad((ushort)(((lbX - 1) << 8) | (lbY - 1)), 8 * 9 + 8);
            if (localVX == 8 && localVY == 0 && lbX < mapSize - 1 && lbY > 0)
                WriteRoad((ushort)(((lbX + 1) << 8) | (lbY - 1)), 0 * 9 + 8);
            if (localVX == 0 && localVY == 8 && lbX > 0 && lbY < mapSize - 1)
                WriteRoad((ushort)(((lbX - 1) << 8) | (lbY + 1)), 8 * 9 + 0);
            if (localVX == 8 && localVY == 8 && lbX < mapSize - 1 && lbY < mapSize - 1)
                WriteRoad((ushort)(((lbX + 1) << 8) | (lbY + 1)), 0 * 9 + 0);
        }

        if (changeCount == 0) return new RoadResult(path.Count, 0, roadValue, new HashSet<ushort>());
        doc.UpdateLandblocksBatchInternal(batchChanges, out var modifiedLbs);
        return new RoadResult(path.Count, changeCount, roadValue, modifiedLbs);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Terrain queries
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public HeightQueryResult GetHeight(float x, float y) {
        RequireProject();
        var (_, tl, hl) = GetTerrainHelpers();
        float height = hl(x, y);

        var vi = _terrainService.WorldToVertex(x, y);
        byte? hIdx = null, type = null, road = null, scenery = null;
        ushort? lbId = null;
        int? vIdx = null;

        if (vi.HasValue) {
            lbId = vi.Value.LandblockKey;
            vIdx = vi.Value.VertexIndex;
            var data = tl(vi.Value.LandblockKey);
            if (data != null) {
                var entry = data[vi.Value.VertexIndex];
                hIdx = entry.Height;
                type = entry.Type;
                road = entry.Road;
                scenery = entry.Scenery;
            }
        }

        return new HeightQueryResult(x, y, height, hIdx, type, road, scenery, lbId, vIdx);
    }

    public TerrainInfoResult GetTerrainInfo(uint lbX, uint lbY) {
        var (lbKey, data) = TryGetLandblockTerrain(lbX, lbY);

        if (data == null) return new TerrainInfoResult(lbKey, lbX, lbY, false);

        int minH = 255, maxH = 0;
        double avgH = 0;
        var typeCounts = new Dictionary<byte, int>();
        for (int i = 0; i < data.Length; i++) {
            var e = data[i];
            if (e.Height < minH) minH = e.Height;
            if (e.Height > maxH) maxH = e.Height;
            avgH += e.Height;
            typeCounts.TryGetValue(e.Type, out var c);
            typeCounts[e.Type] = c + 1;
        }
        avgH /= data.Length;

        return new TerrainInfoResult(lbKey, lbX, lbY, true, data.Length, minH, maxH, avgH,
            typeCounts.OrderByDescending(kv => kv.Value)
                .Select(kv => new TerrainTypeCount(kv.Key, kv.Value)).ToList());
    }

    public HeightmapResult GetHeightmap(uint lbX, uint lbY) {
        var (lbKey, data) = TryGetLandblockTerrain(lbX, lbY);
        if (data == null) return new HeightmapResult(lbKey, lbX, lbY, false);

        var ht = GetHeightTable();
        var grid = new double[9][];
        var idxGrid = new int[9][];
        for (int x = 0; x < 9; x++) {
            grid[x] = new double[9];
            idxGrid[x] = new int[9];
            for (int y = 0; y < 9; y++) {
                int idx = x * 9 + y;
                var entry = data[idx];
                grid[x][y] = Math.Round(
                    entry.Height < ht.Length ? ht[entry.Height] : entry.Height * 2.0, 2);
                idxGrid[x][y] = entry.Height;
            }
        }
        return new HeightmapResult(lbKey, lbX, lbY, true, grid, idxGrid);
    }

    public TerrainDataResult GetTerrainData(uint lbX, uint lbY) {
        var (lbKey, data) = TryGetLandblockTerrain(lbX, lbY);
        if (data == null) return new TerrainDataResult(lbKey, lbX, lbY, false);

        var ht = GetHeightTable();
        var vertices = new List<TerrainVertexInfo>(data.Length);
        for (int i = 0; i < data.Length; i++) {
            var e = data[i];
            vertices.Add(new TerrainVertexInfo(i, i / 9, i % 9, e.Height,
                Math.Round(e.Height < ht.Length ? ht[e.Height] : e.Height * 2.0, 2),
                e.Type, e.Road, e.Scenery));
        }
        return new TerrainDataResult(lbKey, lbX, lbY, true, vertices);
    }

    // ---------------------------------------------------------------------
    //  Region render
    // ---------------------------------------------------------------------

    public RenderPreviewResult RenderPreview(
        uint centerLbX, uint centerLbY,
        int radius, int resolution, bool overlay,
        string? outputPath, bool useSprites = false,
        RenderPreviewRenderer.LayerMode layer = RenderPreviewRenderer.LayerMode.Combined) {

        RequireProject();
        if (radius < 0) throw new ArgumentException("radius must be >= 0");
        if (radius > 16) throw new ArgumentException("radius must be <= 16 (33x33 LBs)");
        if (resolution < 64 || resolution > 8192)
            throw new ArgumentException("resolution must be in [64, 8192]");
        if (centerLbX > 255 || centerLbY > 255)
            throw new ArgumentException("centerLb must have lbX, lbY in [0, 255]");

        int gridSize = 2 * radius + 1;
        int lbPx = Math.Max(8, resolution / gridSize);
        int finalRes = lbPx * gridSize;

        var terrainDoc = GetTerrainDoc();
        var ht = GetHeightTable();

        var terrainByCell = new Dictionary<(int col, int row), TerrainEntry[]?>();
        var objectsByCell = new Dictionary<(int col, int row), List<StaticObject>>();
        var spawnsByCell = new Dictionary<(int col, int row), List<RenderPreviewRenderer.SpawnGlyph>>();
        int lbCount = 0, objCount = 0;

        for (int row = 0; row < gridSize; row++) {
            for (int col = 0; col < gridSize; col++) {
                long absX = (long)centerLbX - radius + col;
                long absY = (long)centerLbY - radius + row;
                if (absX < 0 || absX > 255 || absY < 0 || absY > 255) {
                    terrainByCell[(col, row)] = null;
                    objectsByCell[(col, row)] = new List<StaticObject>();
                    spawnsByCell[(col, row)] = new List<RenderPreviewRenderer.SpawnGlyph>();
                    continue;
                }
                ushort lbKey = (ushort)((absX << 8) | absY);
                var data = terrainDoc.GetLandblockInternal(lbKey);
                terrainByCell[(col, row)] = data;
                if (data != null) lbCount++;

                List<StaticObject> objs;
                try {
                    var lbDoc = GetLandblockDoc(lbKey);
                    objs = lbDoc.GetStaticObjects().ToList();
                } catch {
                    objs = new List<StaticObject>();
                }
                objectsByCell[(col, row)] = objs;
                objCount += objs.Count;

                // Spawn-gazetteer entries for this LB. Category is now
                // resolved at gazetteer-build time and stored on the record,
                // so the renderer just dispatches on it without re-deriving
                // anything per tile. Indoor spawns (cell ≥ 0x100) are
                // excluded from the surface tile so dungeon-interior
                // creatures don't render on top of the outdoor map; they're
                // surfaced via the per-LB description and (later) the floor
                // tile when its renderer also accepts spawn glyphs.
                if (_spawnGazetteer.TryGetValue(lbKey, out var spawns) && spawns is { Count: > 0 }) {
                    var glyphs = new List<RenderPreviewRenderer.SpawnGlyph>(spawns.Count);
                    foreach (var sp in spawns) {
                        if (sp.Cell >= 0x100) continue;  // indoor / dungeon
                        // Pass world coords (not LB-local). The renderer's
                        // bounds check subtracts worldOriginX, which only
                        // works on world coords; sp.X / sp.Y are LB-local
                        // (0..192) so used directly they all fail the
                        // negative-coord check and silently drop.
                        glyphs.Add(new RenderPreviewRenderer.SpawnGlyph(
                            X: sp.WorldX, Y: sp.WorldY, Z: sp.Z,
                            Category: MapToRendererCategory(sp.Category),
                            Scale: ScaleForSpawn(sp),
                            Wcid: sp.Wcid,
                            Orientation: sp.OrientationOrIdentity));
                    }
                    spawnsByCell[(col, row)] = glyphs;
                } else {
                    spawnsByCell[(col, row)] = new List<RenderPreviewRenderer.SpawnGlyph>();
                }
            }
        }

        SpriteAtlasLoader? atlas = useSprites ? GetOrLoadSpriteAtlas() : null;

        var input = new RenderPreviewRenderer.Input {
            CenterLbX = centerLbX,
            CenterLbY = centerLbY,
            Radius = radius,
            GridSize = gridSize,
            LbPx = lbPx,
            FinalRes = finalRes,
            Overlay = overlay,
            Terrain = terrainByCell,
            Objects = objectsByCell,
            HeightTable = ht,
            Ontology = id => _ontologyService.GetEntry(id),
            PairingsGroupKey = id => _buildingPairings.GroupKey(id),
            CliffThreshold = WorldBuilder.Shared.Lib.Validation.ValidationEngine.DefaultCliffThreshold,
            UseSprites = useSprites && atlas != null,
            Sprites = atlas == null ? null : id => atlas.TryLookup(id, out var rect)
                ? new RenderPreviewRenderer.SpriteInfo(atlas.Atlas, rect.X, rect.Y, rect.W, rect.H, rect.WorldWidth, rect.WorldHeight)
                : null,
            WcidToSetup = GetWcidToSetupResolver(),
            WcidToInscription = _weenieIndex.Count > 0
                ? wcid => _weenieIndex.Get(wcid)?.Inscription
                : null,
            Layer = layer,
            Spawns = spawnsByCell,
            // Real AC terrain tiles (Region 0x13000000) replace the procedural
            // palette during the per-pixel raster. Loader is best-effort —
            // when a tile fails to decode the palette is still used.
            TerrainTextures = (layer == RenderPreviewRenderer.LayerMode.Objects)
                ? null  // Objects layer doesn't run the terrain raster
                : GetOrLoadTerrainTextures(),
            // Scene decorations ride alongside the terrain raster — both
            // are skipped on Objects-only renders so the layer composites
            // cleanly over the separate terrain layer.
            Scenes = (layer == RenderPreviewRenderer.LayerMode.Objects)
                ? null
                : GetOrLoadSceneDecorations(),
        };

        var renderOut = RenderPreviewRenderer.Render(input);

        if (!string.IsNullOrEmpty(outputPath)) {
            var dir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);
            File.WriteAllBytes(outputPath, renderOut.PngBytes);
        }

        ushort centerKey = LbKey(centerLbX, centerLbY);
        // Report the count actually drawn (renderer's bounds-clipped value)
        // rather than the pre-clip total — objects whose origin lies outside
        // the rendered region drop out of the visual but used to inflate the
        // count, masking real density signal in the JSON channel.
        return new RenderPreviewResult(
            centerLbX, centerLbY, centerKey,
            radius, finalRes, lbPx,
            lbCount, renderOut.RenderedObjectCount, renderOut.CliffCount,
            overlay,
            renderOut.PngBytes,
            outputPath,
            renderOut.GlyphCount);
    }


    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Object management
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public ListObjectsResult ListObjects(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        if (!TryGetLandblockDoc(lbKey, out var lbDoc))
            return new ListObjectsResult(lbKey, new List<StaticObject>(), Found: false);
        return new ListObjectsResult(lbKey, lbDoc!.GetStaticObjects().ToList(), Found: true);
    }

    public LandblockDescriber.LandblockDescriptionResult DescribeLandblock(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var lbDoc = GetLandblockDoc(lbKey);
        var terrainDoc = GetTerrainDoc();
        var dungeonDoc = GetDungeonDoc(lbKey);
        return DescribeLandblockFromDocs(lbX, lbY, lbDoc, terrainDoc, dungeonDoc, includeValidation: true);
    }

    /// <summary>
    /// Describer entry point that accepts caller-supplied document instances rather than
    /// pulling the live ones from the project. Used by transact-diff to describe a pre-state
    /// projection: the caller hydrates ephemeral documents from snapshot bytes and passes
    /// them in, so the describer can run unchanged against pre- or post-batch worlds.
    /// </summary>
    internal LandblockDescriber.LandblockDescriptionResult DescribeLandblockFromDocs(
            uint lbX, uint lbY,
            LandblockDocument lbDoc, TerrainDocument terrainDoc, DungeonDocument? dungeonDoc,
            bool includeValidation) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var heightTable = GetHeightTable();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        Dictionary<int, string>? terrainTypeNames = null;
        try {
            if (dats.TryGet<DatReaderWriter.DBObjs.Region>(0x13000000, out var region)) {
                var types = region.TerrainInfo?.TerrainTypes;
                if (types != null) {
                    terrainTypeNames = new Dictionary<int, string>();
                    for (int i = 0; i < types.Count; i++) {
                        try { terrainTypeNames[i] = types[i].TerrainName; } catch { }
                    }
                }
            }
        } catch { }

        var regionContext = ResolveRegionForLb(lbKey, lbX, lbY);
        _townGazetteer.TryGetValue(lbKey, out var townContext);
        _poiGazetteer.TryGetValue(lbKey, out var pois);
        _spawnGazetteer.TryGetValue(lbKey, out var spawns);

        // Validation overlay — call ValidateAll with whatever docs we have. This
        // is per-LB structural correctness (cliffs, below-terrain objects, broken
        // portals, etc.); ~45 codes across DNG/LBK/TRN/BSH/BLD categories. Soft-
        // fail to null on any error so describe never breaks on validation issues.
        // The diff engine sets includeValidation=false when describing ephemeral
        // pre-state docs — running the live ValidationEngine against pre-state
        // would require swapping live docs in and out, which the diff engine
        // handles separately with explicit pre/post validation passes.
        LandblockDescriber.ValidationOverlay? validation = null;
        if (includeValidation) {
            try {
                var report = ValidateAll(lbX, lbY);
                validation = new LandblockDescriber.ValidationOverlay(
                    IsValid: report.IsValid,
                    ErrorCount: report.ErrorCount,
                    WarningCount: report.WarningCount,
                    InfoCount: report.InfoCount,
                    Diagnostics: report.Diagnostics.Select(d => new LandblockDescriber.ValidationDiagnosticEntry(
                        Severity: d.Severity.ToString().ToLowerInvariant(),
                        Code: d.Code,
                        Message: d.Message,
                        Context: d.Context)).ToList());
            } catch (Exception ex) {
                Console.Error.WriteLine($"[Validation] Skipped for 0x{lbKey:X4}: {ex.Message}");
            }
        }

        return LandblockDescriber.Describe(lbKey, lbDoc, terrainDoc, dungeonDoc,
            _ontologyService, heightTable, terrainTypeNames, dats, townContext, pois,
            _wcidToAcpedia.Count > 0 ? _wcidToAcpedia : null,
            spawns, validation, regionContext);
    }

    private void LoadRegionGazetteer(string path) {
        using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(path));
        var root = doc.RootElement;
        if (root.TryGetProperty("regions", out var regionsEl) && regionsEl.ValueKind == System.Text.Json.JsonValueKind.Object) {
            foreach (var r in regionsEl.EnumerateObject()) {
                string? culture = r.Value.TryGetProperty("culture", out var cEl) && cEl.ValueKind == System.Text.Json.JsonValueKind.String ? cEl.GetString() : null;
                string? biome = r.Value.TryGetProperty("biome", out var bEl) && bEl.ValueKind == System.Text.Json.JsonValueKind.String ? bEl.GetString() : null;
                string? desc = r.Value.TryGetProperty("description", out var dEl) && dEl.ValueKind == System.Text.Json.JsonValueKind.String ? dEl.GetString() : null;
                _regions[r.Name] = new LandblockDescriber.RegionContext(r.Name, culture, biome, desc);
            }
        }
        if (root.TryGetProperty("town_anchors", out var anchorsEl) && anchorsEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
            foreach (var a in anchorsEl.EnumerateArray()) {
                int x = a.TryGetProperty("lb_x", out var xEl) ? xEl.GetInt32() : -1;
                int y = a.TryGetProperty("lb_y", out var yEl) ? yEl.GetInt32() : -1;
                string? region = a.TryGetProperty("region", out var rEl) && rEl.ValueKind == System.Text.Json.JsonValueKind.String ? rEl.GetString() : null;
                if (x < 0 || y < 0 || string.IsNullOrEmpty(region)) continue;
                _regionAnchors.Add(new RegionAnchor(x, y, region));
            }
        }
    }

    // ── Tile pipeline ──────────────────────────────────────────

    private (TileCache cache, TileGenerator gen) GetOrCreateTilePipeline() {
        RequireProject();
        if (_tileCache != null && _tileGenerator != null) return (_tileCache, _tileGenerator);
        var p = _projectManager.CurrentProject!;
        _tileCache = new TileCache(p.ProjectDirectory, _tileBudgetGB);
        _tileGenerator = new TileGenerator(this, _tileCache);
        // Compute per-region anchor lists for region tiles.
        var byRegion = new Dictionary<string, List<(uint x, uint y)>>();
        foreach (var anchor in _regionAnchors) {
            if (!byRegion.ContainsKey(anchor.Region)) byRegion[anchor.Region] = new List<(uint, uint)>();
            byRegion[anchor.Region].Add(((uint)anchor.LbX, (uint)anchor.LbY));
        }
        _tileGenerator.SetRegionAnchors(byRegion);
        return (_tileCache, _tileGenerator);
    }

    public TileEntry GetLbTile(uint lbX, uint lbY) {
        var (_, gen) = GetOrCreateTilePipeline();
        var entry = gen.GetOrGenerateLbTile(lbX, lbY);
        _tileCache!.SaveManifest();
        return entry;
    }

    public TileEntry GetRegionTile(string regionName) {
        var (_, gen) = GetOrCreateTilePipeline();
        var entry = gen.GetOrGenerateRegionTile(regionName);
        _tileCache!.SaveManifest();
        return entry;
    }

    public TileEntry GetWorldTile() {
        var (_, gen) = GetOrCreateTilePipeline();
        var entry = gen.GetOrGenerateWorldTile();
        _tileCache!.SaveManifest();
        return entry;
    }

    public TileStats GetTileStats() {
        var (cache, _) = GetOrCreateTilePipeline();
        return cache.Stats();
    }

    public PruneResult PruneTiles(int? keepNewest, DateTime? olderThan) {
        var (cache, _) = GetOrCreateTilePipeline();
        return cache.Prune(keepNewest, olderThan);
    }

    public (int regenerated, long bytes, List<string> errors) RegenerateDirtyTiles() {
        var (_, gen) = GetOrCreateTilePipeline();
        return gen.RegenerateDirty();
    }

    public List<(ushort lbKey, string hex)> ListDirtyTiles() {
        var (cache, _) = GetOrCreateTilePipeline();
        return cache.ListDirty();
    }

    public void MarkTilesClean() {
        var (cache, _) = GetOrCreateTilePipeline();
        cache.ClearDirty();
        cache.SaveManifest();
    }

    public string TileCachePathOrEmpty() => _tileCache?.Root ?? "";

    public IEnumerable<string> ListRegionNames() => _regions.Keys;

    public (int generated, int skipped, long bytes, List<string> errors)
            GenerateBulkLbTiles(List<(uint x, uint y)> lbs) {
        var (_, gen) = GetOrCreateTilePipeline();
        return gen.GenerateBulkLbTiles(lbs);
    }

    /// <summary>
    /// Called by JsonCommandProcessor after a successful transact. Walks the
    /// journal's DocumentsTouched and marks affected tiles dirty.
    /// `landblock_HEX` and `dungeon_HEX` → that LB's tile dirty.
    /// `terrain` → every LB tile dirty (terrain edits affect rendering globally).
    /// </summary>
    public void OnTransactCommitted(List<string> documentsTouched) {
        if (_tileCache == null) return; // No tile pipeline initialized; nothing to invalidate.
        bool terrainTouched = false;
        foreach (var docId in documentsTouched) {
            if (docId == "terrain") { terrainTouched = true; continue; }
            // landblock_XXXX or dungeon_XXXX
            var idx = docId.IndexOf('_');
            if (idx <= 0) continue;
            var hex = docId.Substring(idx + 1);
            if (!ushort.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out var lbKey)) continue;
            _tileCache.MarkLbDirty(lbKey);
            // Also mark the region tile dirty if we know which region this LB belongs to.
            uint lbX = (uint)((lbKey >> 8) & 0xFF), lbY = (uint)(lbKey & 0xFF);
            var rc = ResolveRegionForLb(lbKey, lbX, lbY);
            if (rc != null) _tileCache.MarkRegionDirty(rc.Name);
        }
        if (terrainTouched) _tileCache.MarkAllLbTilesDirty();
        _tileCache.SaveManifest();
    }

    /// <summary>
    /// Invalidates the tile cache for a single landblock after a direct (non-transact)
    /// object/terrain mutation. Tiles are rendered from terrain + objects, so a direct
    /// edit must mark the LB (and its region tile) dirty — mirroring
    /// <see cref="OnTransactCommitted"/> — else get-tile keeps serving the pre-edit tile.
    /// </summary>
    private void InvalidateLbTile(ushort lbKey) {
        if (_tileCache == null) return;
        _tileCache.MarkLbDirty(lbKey);
        uint lbX = (uint)((lbKey >> 8) & 0xFF), lbY = (uint)(lbKey & 0xFF);
        var rc = ResolveRegionForLb(lbKey, lbX, lbY);
        if (rc != null) _tileCache.MarkRegionDirty(rc.Name);
        _tileCache.SaveManifest();
    }

    /// <summary>
    /// Per-region centroids in world coordinates, computed by averaging the
    /// town anchors loaded from <c>region_gazetteer.json</c>. One centroid
    /// per region — multiple anchors aggregate. Used by the static-site
    /// emitter to seed a Voronoi tessellation of named zones.
    /// </summary>
    public IReadOnlyList<(string Region, float WorldX, float WorldY)> GetRegionCentroids() {
        if (_regionAnchors.Count == 0)
            return Array.Empty<(string, float, float)>();
        var sums = new Dictionary<string, (double X, double Y, int Count)>();
        foreach (var a in _regionAnchors) {
            sums.TryGetValue(a.Region, out var acc);
            // Town anchors are stored at LB precision; +96 (=192/2) lifts to
            // the LB centre so each anchor contributes its centre, not its
            // SW corner. Without this, regions cluster slightly toward the
            // SW which warps the Voronoi cells.
            acc.X += a.LbX * 192.0 + 96.0;
            acc.Y += a.LbY * 192.0 + 96.0;
            acc.Count++;
            sums[a.Region] = acc;
        }
        var result = new List<(string, float, float)>(sums.Count);
        foreach (var kv in sums) {
            if (kv.Value.Count == 0) continue;
            result.Add((kv.Key,
                (float)(kv.Value.X / kv.Value.Count),
                (float)(kv.Value.Y / kv.Value.Count)));
        }
        return result;
    }

    private LandblockDescriber.RegionContext? ResolveRegionForLb(ushort lbKey, uint lbX, uint lbY) {
        if (_regionAnchors.Count == 0) return null;
        if (_lbToRegionCache.TryGetValue(lbKey, out var cached)) return cached;
        // Find nearest anchor by squared Euclidean distance (avoid sqrt). 58 anchors,
        // O(n) per lookup is fine; cache results so repeated describes are O(1).
        int bestDistSq = int.MaxValue;
        string? bestRegion = null;
        int ix = (int)lbX, iy = (int)lbY;
        foreach (var a in _regionAnchors) {
            int dx = a.LbX - ix, dy = a.LbY - iy;
            int d = dx * dx + dy * dy;
            if (d < bestDistSq) { bestDistSq = d; bestRegion = a.Region; }
        }
        if (bestRegion == null || !_regions.TryGetValue(bestRegion, out var rc)) return null;
        _lbToRegionCache[lbKey] = rc;
        return rc;
    }

    // Map the gazetteer-resolved Category ("Creature"|"Npc"|"Object"|"Surface")
    // to the renderer's ontology-style category strings ("Creature", "NPC",
    // "Interactive_Door", "Prop", …). The renderer's glyph dispatch already
    // keys on those, so we keep the wire shape and just translate.
    private static string MapToRendererCategory(string spawnCategory) => spawnCategory switch {
        "Creature" => "Creature",
        "Npc" => "NPC",
        "Surface" => "Prop",
        _ => "Prop",
    };

    // Pick a render scale ("Massive"|"Large"|"Medium"|"Small"|"Tiny") for a
    // spawn glyph. Order of preference:
    //   1. Atlas hit on the wcid-resolved setupId — derive from the sprite's
    //      true world bounds. Statues/towers/portals come out at their actual
    //      visual size instead of the previous flat "Small" for everything
    //      that wasn't a Creature/NPC.
    //   2. Ontology entry on the resolved setupId — use its declared Scale.
    //   3. Weenie-type heuristic — door=Small, portal=Large, statue=Medium,
    //      generic generators=Tiny. Stable defaults so an absent atlas
    //      still gives sensible visuals.
    //   4. Category-only fallback — Creature/Npc=Medium, anything else=Small.
    private string ScaleForSpawn(SpawnRecord sp) {
        SpriteAtlasLoader? atlas = GetOrLoadSpriteAtlas();
        // Variant-aware lookup so NPCs with ClothingTable variants land on
        // their own atlas entry. Falls back to bare setup when the atlas
        // wasn't built with variant ingest, courtesy of TryLookup's
        // bare-fallback path.
        Func<int, SpriteKey>? wcidToKey = GetWcidToSpriteKeyResolver();
        if (atlas != null && wcidToKey != null && sp.Wcid > 0) {
            var key = wcidToKey(sp.Wcid);
            if (key.Setup != 0 && atlas.TryLookup(key, out var rect)) {
                float maxDim = MathF.Max(rect.WorldWidth, rect.WorldHeight);
                if (maxDim >= 8f)  return "Massive";
                if (maxDim >= 4f)  return "Large";
                if (maxDim >= 1.5f) return "Medium";
                if (maxDim >= 0.5f) return "Small";
                return "Tiny";
            }
            if (key.Setup != 0) {
                var entry = _ontologyService.GetEntry(key.Setup);
                if (!string.IsNullOrEmpty(entry?.Scale)) return entry.Scale;
            }
        }
        if (sp.WeenieType is int wt) {
            return wt switch {
                19 => "Small",   // Door
                 7 => "Large",   // Portal
                10 => "Medium",  // Creature
                20 => "Medium",  // Vendor
                 4 => "Medium",  // Talker NPC
                 1 => "Tiny",    // Generic / item / generator
                _  => ScaleForCategory(sp.Category),
            };
        }
        return ScaleForCategory(sp.Category);
    }

    // Category-only fallback when a more specific signal isn't available.
    private static string ScaleForCategory(string spawnCategory) => spawnCategory switch {
        "Creature" => "Medium",
        "Npc" => "Medium",
        _ => "Small",
    };

    // Build the in-memory spawn gazetteer from the LSD spawnmap_summary.jsonl
    // dump. Delegates to the shared SpawnGazetteerBuilder so the same parsing
    // + filtering rules apply to ACE-DB-sourced spawns (see
    // SpawnGazetteerBuilder.BuildFromAceLandblockInstances).
    private static Dictionary<ushort, List<SpawnRecord>> LoadSpawnGazetteer(string path) =>
        SpawnGazetteerBuilder.BuildFromLsdJson(path);

    public sealed record SpawnSpriteCoverage(
        int TotalSpawns,
        int ResolvedWithSprite,
        int ResolvedNoSprite,
        int UnresolvedWcid,
        IReadOnlyList<int> TopMissingWcids);

    /// <summary>
    /// Walks the in-memory spawn gazetteer for the requested LBs and counts
    /// how many spawns resolve to a sprite atlas hit, how many resolve to
    /// a setup with no sprite (the renderer will glyph-fallback), and how
    /// many have a wcid the ontology can't resolve at all. <see cref="StaticSiteEmitter"/>
    /// surfaces the result through the diagnostics overlay so silent
    /// drops show up in the frontend.
    /// </summary>
    public SpawnSpriteCoverage AnalyzeSpawnSpriteCoverage(IReadOnlyCollection<ushort> lbKeys) {
        if (_spawnGazetteer.Count == 0)
            return new SpawnSpriteCoverage(0, 0, 0, 0, Array.Empty<int>());
        var atlas = GetOrLoadSpriteAtlas();
        var wcidToSetup = GetWcidToSetupResolver();
        int total = 0, resolvedSprite = 0, resolvedNoSprite = 0, unresolved = 0;
        var missingCounts = new Dictionary<int, int>();
        foreach (var lb in lbKeys) {
            if (!_spawnGazetteer.TryGetValue(lb, out var spawns)) continue;
            foreach (var sp in spawns) {
                if (sp.Cell >= 0x100) continue;  // indoor, not on the surface tile
                total++;
                uint setup = wcidToSetup?.Invoke(sp.Wcid) ?? 0u;
                if (setup == 0) {
                    unresolved++;
                    missingCounts[sp.Wcid] = missingCounts.GetValueOrDefault(sp.Wcid) + 1;
                    continue;
                }
                if (atlas != null && atlas.TryLookup(setup, out _)) {
                    resolvedSprite++;
                } else {
                    resolvedNoSprite++;
                    missingCounts[sp.Wcid] = missingCounts.GetValueOrDefault(sp.Wcid) + 1;
                }
            }
        }
        var topMissing = missingCounts
            .OrderByDescending(kv => kv.Value)
            .Take(10)
            .Select(kv => kv.Key)
            .ToList();
        return new SpawnSpriteCoverage(total, resolvedSprite, resolvedNoSprite, unresolved, topMissing);
    }

    // Read a SpawnRecord JSONL file (one record per line) into the per-LB
    // gazetteer shape. This is the on-disk output of ace-db ingest-spawns
    // — already in the canonical SpawnRecord shape with orientation and
    // the IsServerManaged flag, so we deserialize directly without going
    // through SpawnGazetteerBuilder.
    private static Dictionary<ushort, List<SpawnRecord>> LoadSpawnGazetteerJsonl(string path) {
        var result = new Dictionary<ushort, List<SpawnRecord>>();
        var opts = new System.Text.Json.JsonSerializerOptions {
            PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = true,
        };
        foreach (var line in File.ReadLines(path)) {
            if (string.IsNullOrWhiteSpace(line)) continue;
            SpawnRecord? rec;
            try {
                rec = System.Text.Json.JsonSerializer.Deserialize<SpawnRecord>(line, opts);
            } catch {
                continue;  // skip malformed lines; the loader is best-effort
            }
            if (rec == null) continue;
            if (!result.TryGetValue(rec.LandblockId, out var list)) {
                list = new List<SpawnRecord>();
                result[rec.LandblockId] = list;
            }
            list.Add(rec);
        }
        return result;
    }

    private static Dictionary<int, LandblockDescriber.AcpediaMatch> LoadWcidAcpedia(string path) {
        var result = new Dictionary<int, LandblockDescriber.AcpediaMatch>();
        // JSONL — one record per line. Skip records without a match (tier=NONE) to
        // keep memory tight; the describer treats missing entries as no-match.
        foreach (var line in File.ReadLines(path)) {
            if (string.IsNullOrWhiteSpace(line)) continue;
            using var doc = System.Text.Json.JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (!root.TryGetProperty("wcid", out var wcidEl) || wcidEl.ValueKind != System.Text.Json.JsonValueKind.Number) continue;
            if (!root.TryGetProperty("tier", out var tierEl) || tierEl.ValueKind != System.Text.Json.JsonValueKind.String) continue;
            string tier = tierEl.GetString()!;
            if (tier == "NONE") continue;
            string? title = root.TryGetProperty("acpedia_title", out var tEl) && tEl.ValueKind == System.Text.Json.JsonValueKind.String ? tEl.GetString() : null;
            if (string.IsNullOrEmpty(title)) continue;
            string[] cats = root.TryGetProperty("acpedia_cats", out var cEl) && cEl.ValueKind == System.Text.Json.JsonValueKind.Array
                ? cEl.EnumerateArray().Select(e => e.GetString() ?? "").Where(s => !string.IsNullOrEmpty(s)).ToArray()
                : Array.Empty<string>();
            string? desc = root.TryGetProperty("acpedia_description", out var dEl) && dEl.ValueKind == System.Text.Json.JsonValueKind.String ? dEl.GetString() : null;
            result[wcidEl.GetInt32()] = new LandblockDescriber.AcpediaMatch(title, cats, desc, tier);
        }
        return result;
    }

    private static Dictionary<ushort, List<LandblockDescriber.NamedPoi>> LoadPoiGazetteer(string path) {
        var result = new Dictionary<ushort, List<LandblockDescriber.NamedPoi>>();
        using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(path));
        foreach (var entry in doc.RootElement.EnumerateObject()) {
            // Keys are hex strings like "0xA9B4"
            var keyStr = entry.Name.StartsWith("0x") || entry.Name.StartsWith("0X")
                ? entry.Name.Substring(2) : entry.Name;
            if (!ushort.TryParse(keyStr, System.Globalization.NumberStyles.HexNumber, null, out var lbKey)) continue;
            var pois = new List<LandblockDescriber.NamedPoi>();
            foreach (var item in entry.Value.EnumerateArray()) {
                string? title = item.TryGetProperty("title", out var tEl) && tEl.ValueKind == System.Text.Json.JsonValueKind.String
                    ? tEl.GetString() : null;
                if (string.IsNullOrEmpty(title)) continue;
                string[] cats = item.TryGetProperty("categories", out var cEl) && cEl.ValueKind == System.Text.Json.JsonValueKind.Array
                    ? cEl.EnumerateArray().Select(e => e.GetString() ?? "").Where(s => !string.IsNullOrEmpty(s)).ToArray()
                    : Array.Empty<string>();
                string? desc = item.TryGetProperty("description", out var dEl) && dEl.ValueKind == System.Text.Json.JsonValueKind.String
                    ? dEl.GetString() : null;
                pois.Add(new LandblockDescriber.NamedPoi(title, cats, desc));
            }
            if (pois.Count > 0) result[lbKey] = pois;
        }
        return result;
    }

    public AddObjectResult AddObject(uint lbX, uint lbY, uint modelId,
        float x, float y, float z,
        Quaternion? orientation = null, Vector3? scale = null,
        bool snapToCell = false) {
        RequireProject();
        ValidateLbLocalCoord(lbX, lbY, x, y, "add-object");
        ushort lbKey = LbKey(lbX, lbY);

        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        uint didType = modelId >> 24;
        if (didType != 0x01 && didType != 0x02)
            throw new ArgumentException(
                $"add-object: modelId 0x{modelId:X8} is neither a GfxObj (0x01...) nor a Setup (0x02...)");
        bool isSetup = didType == 0x02;
        bool exists = isSetup
            ? dats.TryGet<Setup>(modelId, out _)
            : dats.TryGet<GfxObj>(modelId, out _);
        if (!exists)
            throw new ArgumentException(
                $"add-object: modelId 0x{modelId:X8} is not a {(isSetup ? "Setup" : "GfxObj")} in the loaded DAT.");

        var lbDoc = GetLandblockDocOrCreate(lbKey);

        // Optionally snap position to the nearest outdoor cell center,
        // matching the behaviour of the UI's building placement tool.
        float finalX = x, finalY = y;
        if (snapToCell) {
            (finalX, finalY) = _objectPlacementService.SnapToNearestCellCenter(x, y);
        }

        var obj = new StaticObject {
            Id = modelId,
            IsSetup = isSetup,
            Origin = new Vector3(finalX, finalY, z),
            Orientation = orientation ?? Quaternion.Identity,
            Scale = scale ?? Vector3.One
        };
        int index = lbDoc.AddStaticObject(obj);
        InvalidateLbTile(lbKey);
        return new AddObjectResult(lbKey, index, obj);
    }

    public RemoveObjectResult RemoveObject(uint lbX, uint lbY, int index) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        if (!TryGetLandblockDoc(lbKey, out var lbDoc))
            throw new ArgumentException($"No landblock 0x{lbKey:X4} in project or DAT");
        ValidateObjectIndex(lbDoc!, index, "remove-object");
        var obj = lbDoc!.GetStaticObject(index);
        bool removed = lbDoc.RemoveStaticObject(index);
        if (removed) InvalidateLbTile(lbKey);
        return new RemoveObjectResult(removed, lbKey, index, obj.Id, obj.Origin);
    }

    public MoveObjectResult MoveObject(uint lbX, uint lbY, int index,
        float x, float y, float z) {
        RequireProject();
        ValidateLbLocalCoord(lbX, lbY, x, y, "move-object");
        ushort lbKey = LbKey(lbX, lbY);
        if (!TryGetLandblockDoc(lbKey, out var lbDoc))
            throw new ArgumentException($"No landblock 0x{lbKey:X4} in project or DAT");
        ValidateObjectIndex(lbDoc!, index, "move-object");
        var obj = lbDoc!.GetStaticObject(index);
        var oldPos = obj.Origin;
        obj.Origin = new Vector3(x, y, z);
        lbDoc.UpdateStaticObject(index, obj);
        InvalidateLbTile(lbKey);
        return new MoveObjectResult(lbKey, index, obj.Id, oldPos, obj.Origin);
    }

    public RotateObjectResult RotateObject(uint lbX, uint lbY, int index,
        Quaternion newOrientation) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        if (!TryGetLandblockDoc(lbKey, out var lbDoc))
            throw new ArgumentException($"No landblock 0x{lbKey:X4} in project or DAT");
        ValidateObjectIndex(lbDoc!, index, "rotate-object");
        var obj = lbDoc!.GetStaticObject(index);
        var oldQ = obj.Orientation;
        obj.Orientation = newOrientation;
        lbDoc.UpdateStaticObject(index, obj);
        InvalidateLbTile(lbKey);
        return new RotateObjectResult(lbKey, index, obj.Id, oldQ, newOrientation);
    }

    /// <summary>
    /// Clears all static objects from a single landblock.
    /// </summary>
    public ClearObjectsResult ClearObjects(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        if (!TryGetLandblockDoc(lbKey, out var lbDoc))
            return new ClearObjectsResult(true, 0, 0, new List<ushort>(), Found: false);
        int removed = lbDoc!.ClearStaticObjects();
        if (removed > 0) InvalidateLbTile(lbKey);
        var affected = removed > 0 ? new List<ushort> { lbKey } : new List<ushort>();
        return new ClearObjectsResult(true, removed, 1, affected, Found: true);
    }

    /// <summary>
    /// Clears all static objects from every landblock in the world (255Ã—255 grid).
    /// Only processes landblocks that have a LandBlockInfo in the DAT.
    /// </summary>
    public ClearObjectsResult ClearAllObjects() {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        int totalRemoved = 0;
        int landblocksProcessed = 0;
        var affected = new List<ushort>();

        for (int bx = 0; bx < 255; bx++) {
            for (int by = 0; by < 255; by++) {
                ushort lbKey = (ushort)((bx << 8) | by);
                uint infoId = (uint)(lbKey << 16) | 0xFFFE;

                // Only load landblocks that actually exist in the DAT
                if (!dats.TryGet<LandBlockInfo>(infoId, out var lbi)) continue;
                if (lbi.Objects.Count == 0 && lbi.Buildings.Count == 0) continue;

                var lbDoc = GetLandblockDoc(lbKey);
                int removed = lbDoc.ClearStaticObjects();
                if (removed > 0) {
                    totalRemoved += removed;
                    affected.Add(lbKey);
                }
                landblocksProcessed++;
            }
        }

        // Also sweep staged-only landblock documents that have no DAT LandBlockInfo
        // record (e.g. add-object into a virgin LB) — these never appear above.
        var processed = new HashSet<ushort>(affected);
        foreach (var (docId, doc) in _projectManager.CurrentProject!.DocumentManager.ActiveDocs) {
            if (doc is not LandblockDocument stagedDoc) continue;
            if (!docId.StartsWith("landblock_") ||
                !ushort.TryParse(docId.Substring("landblock_".Length), System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var stagedKey))
                continue;
            if (!processed.Add(stagedKey)) continue;
            int removed = stagedDoc.ClearStaticObjects();
            if (removed > 0) {
                totalRemoved += removed;
                affected.Add(stagedKey);
            }
            landblocksProcessed++;
        }

        foreach (var lbKey in affected) InvalidateLbTile(lbKey);
        return new ClearObjectsResult(true, totalRemoved, landblocksProcessed, affected);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Spatial queries
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public QueryRadiusResult QueryRadius(float cx, float cy, float radius,
        float cz = 0, bool? includeZ = null) {
        RequireProject();
        bool useZ = includeZ ?? (cz != 0f);
        var center = new Vector3(cx, cy, cz);

        int lbMinX = Math.Max(0, (int)MathF.Floor((cx - radius) / 192f));
        int lbMinY = Math.Max(0, (int)MathF.Floor((cy - radius) / 192f));
        int lbMaxX = Math.Min(254, (int)MathF.Floor((cx + radius) / 192f));
        int lbMaxY = Math.Min(254, (int)MathF.Floor((cy + radius) / 192f));

        var found = new List<FoundObject>();

        for (int bx = lbMinX; bx <= lbMaxX; bx++) {
            for (int by = lbMinY; by <= lbMaxY; by++) {
                ushort lbKey = (ushort)((bx << 8) | by);
                // Skip LBs with no LandBlockInfo and no in-memory doc — avoids creating
                // phantom LandblockDocuments for empty cells of the bounding box. ActiveDocs
                // are still picked up so add-object'd LBs without DAT-side LBI are scanned.
                if (!TryGetLandblockDoc(lbKey, out var lbDoc) || lbDoc == null) continue;

                int i = 0;
                foreach (var obj in lbDoc.GetStaticObjects()) {
                    float dist = useZ
                        ? Vector3.Distance(center, obj.Origin)
                        : MathF.Sqrt((obj.Origin.X - cx) * (obj.Origin.X - cx) +
                                     (obj.Origin.Y - cy) * (obj.Origin.Y - cy));
                    if (dist <= radius) found.Add(new FoundObject(dist, lbKey, i, obj));
                    i++;
                }
            }
        }

        found.Sort((a, b) => a.Distance.CompareTo(b.Distance));

        var modelCounts = new Dictionary<uint, int>();
        foreach (var f in found) {
            modelCounts.TryGetValue(f.Object.Id, out var c);
            modelCounts[f.Object.Id] = c + 1;
        }

        return new QueryRadiusResult(cx, cy, cz, radius, useZ, found, modelCounts);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Dungeon tools
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public (DungeonRoomAnalyzer.AnalysisReport Report, string? SavedTo) AnalyzeDungeons(string? outputPath = null) {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        List<string> ResolveDungeonNames(List<ushort> lbKeys) {
            var names = new List<string>();
            foreach (var lbKey in lbKeys) {
                if (_townGazetteer.TryGetValue(lbKey, out var town) && !string.IsNullOrEmpty(town.Name))
                    names.Add(town.Name);
            }
            return names;
        }
        var report = _dungeonService.AnalyzeRooms(dats, ResolveDungeonNames);
        if (!string.IsNullOrEmpty(outputPath)) _dungeonService.SaveAnalysisReport(report, outputPath);
        return (report, outputPath);
    }

    public DungeonInfoResult GetDungeonInfo(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        // Read-only probe: must not persist a phantom dungeon doc for surface LBs.
        if (!TryGetDungeonDoc(lbKey, out var dungeonDoc) || dungeonDoc == null || dungeonDoc.Cells.Count == 0)
            return new DungeonInfoResult(lbKey, false, 0, null);
        return new DungeonInfoResult(lbKey, true, dungeonDoc.Cells.Count, dungeonDoc);
    }

    /// <summary>
    /// Extracts full dungeon room catalog from the DAT files.
    /// Produces detailed room templates with bounding boxes, portal geometry,
    /// room dimensions, classification, and static object data.
    /// </summary>
    public AnalyzeDungeonCatalogResult AnalyzeDungeonCatalog(string? outputPath = null) {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        try {
            var catalog = DungeonRoomAnalyzer.ExtractCatalog(dats);

            if (!string.IsNullOrEmpty(outputPath)) {
                DungeonRoomAnalyzer.SaveCatalog(catalog, outputPath);
                Console.Error.WriteLine($"[AnalyzeDungeonCatalog] Saved catalog to: {outputPath}");
            }

            return new AnalyzeDungeonCatalogResult(
                true,
                catalog.TotalLandblocksScanned,
                catalog.TotalCellsScanned,
                catalog.UniqueRoomTemplates,
                catalog.Errors,
                catalog.ClassificationCounts,
                outputPath);
        } catch (Exception ex) {
            return new AnalyzeDungeonCatalogResult(
                false, 0, 0, 0, 0,
                new Dictionary<string, int>(),
                outputPath, ex.Message);
        }
    }

    /// <summary>
    /// Extracts dungeon topology (portal graph) from the DAT files.
    /// For each dungeon landblock, builds the cell adjacency graph, computes
    /// depth via BFS, branching factor, dimensions, and classification.
    /// </summary>
    public AnalyzeDungeonTopologyResult AnalyzeDungeonTopology(string? outputPath = null) {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        try {
            var report = DungeonTopologyAnalyzer.ExtractTopology(dats);

            if (!string.IsNullOrEmpty(outputPath)) {
                DungeonTopologyAnalyzer.SaveReport(report, outputPath);
                Console.Error.WriteLine($"[AnalyzeDungeonTopology] Saved topology to: {outputPath}");
            }

            return new AnalyzeDungeonTopologyResult(
                true,
                report.TotalDungeonsAnalyzed,
                report.TotalCellsAnalyzed,
                report.ClassificationCounts,
                outputPath, null,
                report.Errors,
                report.BuildingInteriorLandblocks);
        } catch (Exception ex) {
            return new AnalyzeDungeonTopologyResult(
                false, 0, 0,
                new Dictionary<string, int>(),
                outputPath, ex.Message);
        }
    }

    /// <summary>
    /// Generates a complete dungeon from graph grammar â†’ portal snap placement.
    /// 1. Generate abstract graph via DungeonGrammar.Generate()
    /// 2. Validate the graph
    /// 3. Extract room catalog and map GrammarNodeType â†’ Classification
    /// 4. Walk graph in BFS order, placing cells via snap-portal logic
    /// 5. Return summary
    /// </summary>
    public GenerateDungeonResult GenerateDungeon(
        uint lbX, uint lbY,
        int targetDepth = 8,
        float branchingFactor = 2.0f,
        int minRooms = 5,
        int maxRooms = 40,
        string theme = "default",
        int seed = 0,
        bool validate = true) {

        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        var warnings = new List<string>();

        try {
            // â”€â”€ Step 1: Generate abstract graph â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            var grammarParams = new GrammarParams(targetDepth, branchingFactor, minRooms, maxRooms, theme, seed);
            var graph = DungeonGrammar.Generate(grammarParams);
            var graphWarnings = DungeonGrammar.Validate(graph);
            warnings.AddRange(graphWarnings);

            string graphSummary = DungeonGrammar.FormatSummary(graph);

            // â”€â”€ Step 2: Extract room catalog â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            Console.Error.WriteLine("[GenerateDungeon] Extracting room catalog...");
            var catalog = DungeonRoomAnalyzer.ExtractCatalog(dats);

            if (catalog.Templates.Count == 0) {
                return new GenerateDungeonResult(false, lbKey, graph.Nodes.Count, graph.Edges.Count,
                    0, graph.MaxDepthReached, graph.Seed, warnings,
                    graphSummary, "No room templates found in DAT catalog");
            }

            // â”€â”€ Step 3: Build lookup tables â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            // Map GrammarNodeType â†’ preferred catalog classifications + portal count preference
            var rng = new Random(graph.Seed);

            // Build adjacency: for each node, how many children does it have?
            var childCounts = new Dictionary<int, int>();
            var parentOf = new Dictionary<int, int>();  // child â†’ parent
            foreach (var edge in graph.Edges) {
                childCounts[edge.FromId] = childCounts.GetValueOrDefault(edge.FromId) + 1;
                parentOf[edge.ToId] = edge.FromId;
            }

            // â”€â”€ Step 4: Get or create dungeon document â”€â”€â”€â”€â”€â”€â”€
            var dungeonDoc = GetDungeonDoc(lbKey)
                ?? throw new InvalidOperationException($"Could not create dungeon document for landblock 0x{lbKey:X4}");

            // Re-running on a populated LB must REPLACE, not append: clear any
            // existing cells so iterating on seed/depth/theme doesn't accumulate
            // overlapping dungeons sharing the same origin.
            if (dungeonDoc.Cells.Count > 0) {
                warnings.Add($"Cleared {dungeonDoc.Cells.Count} existing cell(s) before regenerating");
                dungeonDoc.Cells.Clear();
            }

            // Track placed cells: nodeId â†’ (cellNumber, envId, cellStructIdx, CellStruct from DAT)
            var placedCells = new Dictionary<int, (ushort cellNum, ushort envId, ushort cellStructIdx)>();
            // Track consumed portals per cell: cellNumber â†’ set of consumed portal polygon IDs
            var consumedPortals = new Dictionary<ushort, HashSet<ushort>>();

            int cellsPlaced = 0;

            // â”€â”€ Step 5: BFS walk â€” place cells â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            var entrance = graph.Nodes.FirstOrDefault(n => n.Type == GrammarNodeType.Entrance);
            if (entrance == null) {
                return new GenerateDungeonResult(false, lbKey, graph.Nodes.Count, graph.Edges.Count,
                    0, graph.MaxDepthReached, graph.Seed, warnings,
                    graphSummary, "No Entrance node in graph");
            }

            // Place Entrance at dungeon origin
            int entranceChildCount = childCounts.GetValueOrDefault(entrance.Id);
            int entrancePortalsNeeded = entranceChildCount + 1;  // +1 for potential external entry
            var entranceTemplate = PickTemplate(catalog.Templates, entrance.Type, entrancePortalsNeeded, rng);
            if (entranceTemplate == null) {
                warnings.Add("No suitable template for Entrance â€” using first available");
                entranceTemplate = catalog.Templates[0];
            }

            var entranceCellNum = dungeonDoc.AddCell(
                entranceTemplate.EnvironmentId, entranceTemplate.CellStructIndex,
                Vector3.Zero, Quaternion.Identity, new List<ushort>());
            placedCells[entrance.Id] = (entranceCellNum, entranceTemplate.EnvironmentId, entranceTemplate.CellStructIndex);
            consumedPortals[entranceCellNum] = new HashSet<ushort>();
            cellsPlaced++;

            // BFS queue
            var bfsQueue = new Queue<int>();
            bfsQueue.Enqueue(entrance.Id);
            var visited = new HashSet<int> { entrance.Id };

            // Build edge lookup: parent â†’ list of children
            var childEdges = new Dictionary<int, List<int>>();
            foreach (var edge in graph.Edges) {
                if (!childEdges.ContainsKey(edge.FromId))
                    childEdges[edge.FromId] = new List<int>();
                childEdges[edge.FromId].Add(edge.ToId);
            }

            // Count the descendants dropped when a node can't be placed — a skipped
            // node silently takes its whole subtree with it (it never gets enqueued).
            int OrphanedSubtreeSize(int nodeId) {
                int count = 0;
                var stack = new Stack<int>();
                stack.Push(nodeId);
                var seen = new HashSet<int>();
                while (stack.Count > 0) {
                    int n = stack.Pop();
                    if (!childEdges.TryGetValue(n, out var kids)) continue;
                    foreach (var k in kids) {
                        if (seen.Add(k)) { count++; stack.Push(k); }
                    }
                }
                return count;
            }
            string OrphanSuffix(int nodeId) {
                int orphans = OrphanedSubtreeSize(nodeId);
                return orphans > 0 ? $" (drops {orphans} descendant cell(s))" : "";
            }

            while (bfsQueue.Count > 0) {
                int currentNodeId = bfsQueue.Dequeue();

                if (!childEdges.TryGetValue(currentNodeId, out var children)) continue;
                if (!placedCells.TryGetValue(currentNodeId, out var parentPlacement)) continue;

                foreach (int childNodeId in children) {
                    if (!visited.Add(childNodeId)) continue;

                    var childNode = graph.Nodes.FirstOrDefault(n => n.Id == childNodeId);
                    if (childNode == null) { warnings.Add($"Node #{childNodeId} not found in graph"); continue; }

                    // Find an unused portal on the parent cell
                    var parentEnvFileId = (uint)(parentPlacement.envId | 0x0D000000);
                    if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(parentEnvFileId, out var parentEnv)) {
                        warnings.Add($"Could not load Environment 0x{parentEnvFileId:X8} for parent node #{currentNodeId}");
                        continue;
                    }

                    if (!parentEnv.Cells.TryGetValue(parentPlacement.cellStructIdx, out var parentCellStruct)) {
                        warnings.Add($"CellStruct {parentPlacement.cellStructIdx} not found in Environment 0x{parentEnvFileId:X8}");
                        continue;
                    }

                    var parentPortalIds = PortalSnapAlgorithms.GetPortalPolygonIds(parentCellStruct);
                    var parentConsumed = consumedPortals.GetValueOrDefault(parentPlacement.cellNum) ?? new HashSet<ushort>();

                    // Find an available portal
                    ushort? availablePortalId = null;
                    foreach (var pid in parentPortalIds) {
                        if (!parentConsumed.Contains(pid)) {
                            availablePortalId = pid;
                            break;
                        }
                    }

                    if (availablePortalId == null) {
                        warnings.Add($"No available portals on parent cell 0x{parentPlacement.cellNum:X4} for child node #{childNodeId} ({childNode.Type}){OrphanSuffix(childNodeId)}");
                        // Marked visited above, so this node and its entire subtree are dropped.
                        continue;
                    }

                    // Pick template for child
                    int childChildCount = childCounts.GetValueOrDefault(childNodeId);
                    int childPortalsNeeded = childChildCount + 1;  // +1 for connection to parent
                    var childTemplate = PickTemplate(catalog.Templates, childNode.Type, childPortalsNeeded, rng);
                    if (childTemplate == null) {
                        warnings.Add($"No suitable template for node #{childNodeId} ({childNode.Type}) â€” skipping{OrphanSuffix(childNodeId)}");
                        continue;
                    }

                    // Load child CellStruct
                    uint childEnvFileId = (uint)(childTemplate.EnvironmentId | 0x0D000000);
                    if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(childEnvFileId, out var childEnv)) {
                        warnings.Add($"Could not load Environment 0x{childEnvFileId:X8} for child node #{childNodeId}{OrphanSuffix(childNodeId)}");
                        continue;
                    }

                    if (!childEnv.Cells.TryGetValue(childTemplate.CellStructIndex, out var childCellStruct)) {
                        warnings.Add($"CellStruct {childTemplate.CellStructIndex} not found in child Environment 0x{childEnvFileId:X8}{OrphanSuffix(childNodeId)}");
                        continue;
                    }

                    // Get parent portal geometry in world space
                    var parentCell = dungeonDoc.GetCell(parentPlacement.cellNum);
                    if (parentCell == null) {
                        warnings.Add($"Parent cell 0x{parentPlacement.cellNum:X4} not found in dungeon document");
                        continue;
                    }

                    var targetLocalGeom = PortalSnapAlgorithms.GetPortalGeometry(parentCellStruct, availablePortalId.Value);
                    if (targetLocalGeom == null) {
                        warnings.Add($"Could not compute geometry for portal 0x{availablePortalId.Value:X4} on parent cell");
                        continue;
                    }

                    var (targetCentroidWorld, targetNormalWorld) = PortalSnapAlgorithms.TransformPortalToWorld(
                        targetLocalGeom.Value, parentCell.Origin, parentCell.Orientation);

                    // Pick best source portal on the child cell
                    var bestSourcePortalId = PortalSnapAlgorithms.PickBestSourcePortal(childCellStruct, targetNormalWorld);
                    if (bestSourcePortalId == null) {
                        warnings.Add($"Child cell has no portals to snap for node #{childNodeId}");
                        continue;
                    }

                    var sourceLocalGeom = PortalSnapAlgorithms.GetPortalGeometry(childCellStruct, bestSourcePortalId.Value);
                    if (sourceLocalGeom == null) {
                        warnings.Add($"Could not compute geometry for source portal 0x{bestSourcePortalId.Value:X4}");
                        continue;
                    }

                    // Compute snap transform
                    var (newOrigin, newOrientation) = PortalSnapAlgorithms.ComputeSnapTransform(
                        targetCentroidWorld, targetNormalWorld, sourceLocalGeom.Value);

                    // Add cell to dungeon
                    var newCellNum = dungeonDoc.AddCell(
                        childTemplate.EnvironmentId, childTemplate.CellStructIndex,
                        newOrigin, newOrientation, new List<ushort>());

                    // Connect portals
                    dungeonDoc.ConnectPortals(
                        parentPlacement.cellNum, availablePortalId.Value,
                        newCellNum, bestSourcePortalId.Value);

                    // Update tracking
                    parentConsumed.Add(availablePortalId.Value);
                    consumedPortals[parentPlacement.cellNum] = parentConsumed;

                    placedCells[childNodeId] = (newCellNum, childTemplate.EnvironmentId, childTemplate.CellStructIndex);
                    consumedPortals[newCellNum] = new HashSet<ushort> { bestSourcePortalId.Value };
                    cellsPlaced++;

                    bfsQueue.Enqueue(childNodeId);
                }
            }

            // â”€â”€ Step 6: Optionally validate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            if (validate && cellsPlaced > 0) {
                try {
                    var valReport = ValidationEngine.ValidateDungeon(dungeonDoc, dats);
                    foreach (var diag in valReport.Diagnostics) {
                        if (diag.Severity != Shared.Lib.Validation.ValidationSeverity.Info)
                            warnings.Add($"[{diag.Severity}] {diag.Code}: {diag.Message}");
                    }
                } catch (Exception vex) {
                    warnings.Add($"Validation error: {vex.Message}");
                }
            }

            return new GenerateDungeonResult(
                true, lbKey,
                graph.Nodes.Count, graph.Edges.Count,
                cellsPlaced, graph.MaxDepthReached, graph.Seed,
                warnings, graphSummary);

        } catch (Exception ex) {
            return new GenerateDungeonResult(
                false, lbKey, 0, 0, 0, 0, seed,
                warnings, null, ex.Message);
        }
    }

    /// <summary>
    /// Pick a room template from the catalog that matches the grammar node type.
    /// Maps GrammarNodeType â†’ preferred Classification(s) and portal count.
    /// </summary>
    private static DungeonRoomAnalyzer.RoomTemplate? PickTemplate(
        List<DungeonRoomAnalyzer.RoomTemplate> templates,
        GrammarNodeType nodeType,
        int minPortals,
        Random rng) {

        // Map grammar type to preferred classifications
        var (preferredClassifications, preferredPortalMin, preferredPortalMax) = nodeType switch {
            GrammarNodeType.Entrance  => (new[] { "Room", "Passage" },        2, 4),
            GrammarNodeType.Corridor  => (new[] { "Corridor" },               2, 2),
            GrammarNodeType.Room      => (new[] { "Room" },                   2, 3),
            GrammarNodeType.Hub       => (new[] { "Hub" },                    3, 8),
            GrammarNodeType.DeadEnd   => (new[] { "DeadEnd" },                1, 1),
            GrammarNodeType.Boss      => (new[] { "Room" },                   1, 2),
            GrammarNodeType.SidePath  => (new[] { "Corridor", "Passage" },    2, 2),
            _                         => (new[] { "Room" },                   1, 4),
        };

        // Ensure we request at least minPortals
        int portalMin = Math.Max(minPortals, preferredPortalMin);
        int portalMax = Math.Max(portalMin, preferredPortalMax);

        // First pass: exact classification match with enough portals
        var candidates = templates
            .Where(t => preferredClassifications.Contains(t.Classification)
                     && t.PortalCount >= portalMin
                     && t.PortalCount <= portalMax)
            .ToList();

        if (candidates.Count > 0)
            return candidates[rng.Next(candidates.Count)];

        // Second pass: relax portal count â€” just match classification with enough portals
        candidates = templates
            .Where(t => preferredClassifications.Contains(t.Classification)
                     && t.PortalCount >= minPortals)
            .ToList();

        if (candidates.Count > 0)
            return candidates[rng.Next(candidates.Count)];

        // Third pass: any template with enough portals
        candidates = templates
            .Where(t => t.PortalCount >= minPortals)
            .ToList();

        if (candidates.Count > 0)
            return candidates[rng.Next(candidates.Count)];

        // Last resort: any template at all
        return templates.Count > 0 ? templates[rng.Next(templates.Count)] : null;
    }


    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Validation
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public ValidationReport ValidateDungeon(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        // Read-only: never lazy-create+persist a phantom dungeon_XXXX doc for a
        // landblock that has no interior cells. TryGetDungeonDoc returns false for
        // a virgin/surface LB — report DNG001 Info (not-applicable) without
        // planting a row. (F225)
        if (!TryGetDungeonDoc(lbKey, out var dungeonDoc) || dungeonDoc == null)
            return ValidationEngine.NotApplicableReport(
                "dungeon", $"dungeon_{lbKey:X4}", "DNG001",
                "Landblock has no interior cells (surface landblock — not a dungeon).");
        return ValidationEngine.ValidateDungeon(dungeonDoc,
            _projectManager.CurrentProject!.DocumentManager.Dats);
    }

    public ValidationReport ValidateLandblock(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        // Read-only: don't lazy-create+persist a phantom landblock_XXXX doc for a
        // never-touched LB. TryGetLandblockDoc returns false when neither a doc
        // nor a DAT LandBlockInfo exists — report LBK001 Info instead. (F225)
        if (!TryGetLandblockDoc(lbKey, out var lbDoc) || lbDoc == null)
            return ValidationEngine.NotApplicableReport(
                "landblock", $"landblock_{lbKey:X4}", "LBK001",
                "Landblock has no static objects.");
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        Func<float, float, float>? heightLookup = null;
        try { (_, _, heightLookup) = GetTerrainHelpers(); } catch { }
        var ontoLookup = OntologyLookupOrNull();
        return ValidationEngine.ValidateLandblock(lbDoc, lbKey, heightLookup, dats, ontoLookup);
    }

    /// <summary>
    /// Cross-checks per-building footprint corners using the validator's
    /// full-quaternion math against a yaw-only rotation, so we can flag
    /// any LB whose buildings would diverge under emit-dynamic-site's
    /// top-down (yaw-only) sprite renderer.
    /// </summary>
    public ValidationEngine.CornerDiffReport CompareRenderCorners(
        uint lbX, uint lbY, float toleranceMetres = 0.05f) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var lbDoc = GetLandblockDoc(lbKey);
        var ontoLookup = OntologyLookupOrNull();
        if (ontoLookup == null)
            throw new InvalidOperationException("Ontology has not been scanned yet. Run 'scan-ontology' first.");
        return ValidationEngine.CompareRenderCorners(lbDoc, lbKey, ontoLookup, toleranceMetres);
    }

    public ValidationReport ValidateTerrain(uint lbX, uint lbY, float cliffThreshold = ValidationEngine.DefaultCliffThreshold) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        return ValidationEngine.ValidateTerrain(
            GetTerrainDoc(), lbKey, GetHeightTable(), cliffThreshold);
    }

    public ValidationReport ValidateBuildingShells(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        return ValidationEngine.ValidateBuildingShells(lbKey,
            _projectManager.CurrentProject!.DocumentManager.Dats,
            PairingsGroupKeyOrNull());
    }

    public ValidationReport ValidateBuildingPortals(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        return ValidationEngine.ValidateBuildingPortals(lbKey,
            _projectManager.CurrentProject!.DocumentManager.Dats);
    }

    public ValidationReport ValidateAll(uint lbX, uint lbY, float cliffThreshold = ValidationEngine.DefaultCliffThreshold) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var project = _projectManager.CurrentProject!;
        var dats = project.DocumentManager.Dats;

        // Read-only validators: use the no-create accessors so validate-all over a
        // never-touched LB doesn't plant phantom dungeon_/landblock_ rows in
        // storage (the lazy-create accessors persist on first fetch). A false
        // result leaves the doc null and the validator skips that family. (F225)
        DungeonDocument? dungeonDoc = null;
        try { TryGetDungeonDoc(lbKey, out dungeonDoc); } catch { }

        LandblockDocument? lbDoc = null;
        try { TryGetLandblockDoc(lbKey, out lbDoc); } catch { }

        TerrainDocument? terrainDoc = null;
        float[]? heightTable = null;
        Func<float, float, float>? heightLookup = null;
        try {
            var (td, _, hl) = GetTerrainHelpers();
            terrainDoc = td;
            heightTable = GetHeightTable();
            heightLookup = hl;
        } catch { }

        return ValidationEngine.ValidateAll(
            lbKey, dungeonDoc, lbDoc, terrainDoc, heightTable, heightLookup, dats, cliffThreshold,
            OntologyLookupOrNull(), PairingsGroupKeyOrNull());
    }

    /// <summary>
    /// Returns a lookup that resolves an object id to its OntologyEntry, or
    /// null if no ontology has been scanned yet. The validator uses this to
    /// drive the LBK010 footprint-flushness check; absence is silent.
    /// </summary>
    private Func<uint, WorldBuilder.Shared.Lib.OntologyEntry?>? OntologyLookupOrNull() {
        if (_ontologyService == null || !_ontologyService.IsScanned) return null;
        return id => _ontologyService.GetEntry(id);
    }

    /// <summary>
    /// Returns a group-key resolver from the pairings registry, or null when
    /// no pairings are loaded. Drives the BSH009 group-Z divergence check.
    /// </summary>
    private Func<uint, uint>? PairingsGroupKeyOrNull() {
        if (_buildingPairings == null || _buildingPairings.EdgeCount == 0) return null;
        return id => _buildingPairings.GroupKey(id);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  World observation
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public ListLandblocksResult ListLandblocks(
        uint minX = 0, uint minY = 0, uint maxX = 254, uint maxY = 254, int limit = 500) {
        RequireProject();
        var terrainDoc = GetTerrainDoc();
        var results = new List<LandblockSummary>();

        bool sawMore = false;
        for (uint x = minX; x <= maxX && !sawMore; x++) {
            for (uint y = minY; y <= maxY; y++) {
                ushort lbKey = (ushort)((x << 8) | y);
                var data = terrainDoc.GetLandblockInternal(lbKey);
                if (data == null) continue;
                if (results.Count >= limit) { sawMore = true; break; }
                int hMin = 255, hMax = 0;
                for (int i = 0; i < data.Length; i++) {
                    if (data[i].Height < hMin) hMin = data[i].Height;
                    if (data[i].Height > hMax) hMax = data[i].Height;
                }
                results.Add(new LandblockSummary(lbKey, x, y, hMin, hMax));
            }
        }

        return new ListLandblocksResult(results.Count, minX, minY, maxX, maxY,
            sawMore, results);
    }

    public WorldInfoResult GetWorldInfo() {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        var terrainDoc = GetTerrainDoc();
        var ht = GetHeightTable();

        int? portalIter = null;
        try { portalIter = project.DocumentManager.Dats.Dats.Portal.Iteration.CurrentIteration; } catch { }

        var activeDocs = new List<ActiveDocInfo>();
        foreach (var (docId, doc) in project.DocumentManager.ActiveDocs) {
            activeDocs.Add(new ActiveDocInfo(docId, doc.Type, doc.IsDirty));
        }

        return new WorldInfoResult(
            project.Name,
            terrainDoc.TerrainData.Landblocks.Count,
            ht.Length,
            ht.Length > 0 ? Math.Round(ht.Min(), 2) : 0,
            ht.Length > 0 ? Math.Round(ht.Max(), 2) : 0,
            portalIter,
            activeDocs);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Ontology
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public OntologyScanResult ScanOntology(bool scanGfxObjs = true) {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        var report = _ontologyService.Scan(dats, scanGfxObjs);
        return new OntologyScanResult(report);
    }

    public OntologyQueryResult QueryOntology(
        string? category = null, string? scale = null,
        string? keyword = null, uint? objectId = null, int limit = 50) {

        if (!_ontologyService.IsScanned)
            throw new InvalidOperationException(
                "Ontology has not been scanned yet. Run 'scan-ontology' first.");

        // Single ID lookup
        if (objectId.HasValue) {
            var entry = _ontologyService.GetEntry(objectId.Value);
            return new OntologyQueryResult(
                entry != null ? new[] { entry } : Array.Empty<OntologyEntry>(),
                _ontologyService.Count);
        }

        // Search
        var results = _ontologyService.Search(category, scale, keyword, limit).ToArray();
        return new OntologyQueryResult(results, _ontologyService.Count);
    }

    public OntologyStatsResult GetOntologyStats() {
        if (!_ontologyService.IsScanned)
            throw new InvalidOperationException(
                "Ontology has not been scanned yet. Run 'scan-ontology' first.");

        // Compute coverage metrics from all ontology entries
        int withName = 0, withWcid = 0, withLevel = 0, withCreatureType = 0;
        var weenieTypeCounts = new Dictionary<int, int>();

        foreach (var entry in _ontologyService.GetAllEntries()) {
            if (!string.IsNullOrEmpty(entry.Name)) withName++;
            if (entry.WeenieClassId.HasValue) withWcid++;
            if (entry.Level.HasValue) withLevel++;
            if (entry.CreatureType.HasValue) withCreatureType++;
            if (entry.WeenieType.HasValue) {
                int wt = entry.WeenieType.Value;
                weenieTypeCounts[wt] = weenieTypeCounts.GetValueOrDefault(wt) + 1;
            }
        }

        return new OntologyStatsResult(
            _ontologyService.Count,
            _ontologyService.GetCategoryCounts(),
            _ontologyService.GetScaleCounts(),
            WithName: withName,
            WithWeenieClassId: withWcid,
            WithLevel: withLevel,
            WithCreatureType: withCreatureType,
            WeenieTypeCounts: weenieTypeCounts.Count > 0 ? weenieTypeCounts : null);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Stamp operations
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public PasteStampResult PasteStamp(
        float srcMinX, float srcMinY, float srcMaxX, float srcMaxY,
        float destX, float destY,
        bool includeObjects = false, bool blendEdges = true, float zOffset = 0f) {

        RequireProject();
        var (doc, tl, _) = GetTerrainHelpers();
        var ht = GetHeightTable();

        // Validate world coordinates before capture/paste. Landblocks are 192 units
        // wide and lbX/lbY are bytes (0..254 are valid; 0xFF is sentinel), so the
        // valid world range is [0, 254*192 + 192) = [0, 49152). Out-of-range values
        // would otherwise wrap through the (ushort)((lbX<<8)|lbY) cast and silently
        // rewrite terrain/objects in landblocks the caller never named.
        const float MaxWorldCoord = 254f * 192f + 192f; // exclusive upper bound
        static void ValidateCoord(float v, string name) {
            if (v < 0f || v >= MaxWorldCoord)
                throw new ArgumentOutOfRangeException(name,
                    $"{name}={v} is out of range; must be in [0, {MaxWorldCoord}).");
        }
        ValidateCoord(srcMinX, nameof(srcMinX));
        ValidateCoord(srcMinY, nameof(srcMinY));
        ValidateCoord(srcMaxX, nameof(srcMaxX));
        ValidateCoord(srcMaxY, nameof(srcMaxY));
        ValidateCoord(destX, nameof(destX));
        ValidateCoord(destY, nameof(destY));
        if (srcMinX > srcMaxX || srcMinY > srcMaxY)
            throw new ArgumentException(
                $"Source minimum must not exceed source maximum (got min=({srcMinX},{srcMinY}), max=({srcMaxX},{srcMaxY})).");

        // Step 1: Capture source terrain into a stamp
        int objectsSkipped = 0;
        var skipMessages = new List<string>();
        Func<ushort, IEnumerable<StaticObject>>? objLookup = null;
        if (includeObjects) {
            objLookup = lbKey => {
                try { return GetLandblockDoc(lbKey).GetStaticObjects(); }
                catch (Exception ex) {
                    skipMessages.Add($"capture LB 0x{lbKey:X4}: {ex.Message}");
                    return Enumerable.Empty<StaticObject>();
                }
            };
        }
        var stamp = _stampService.CaptureRegion(
            srcMinX, srcMinY, srcMaxX, srcMaxY, tl, ht, includeObjects, objLookup);

        if (stamp == null || !stamp.IsValid())
            throw new InvalidOperationException(
                "Could not capture terrain in the specified source region (area may be empty).");

        // Step 2: Compute paste changes
        var pasteResult = _stampService.ComputePaste(
            stamp, new Vector2(destX, destY), includeObjects, blendEdges, zOffset, tl, ht);

        // Step 3: Apply terrain changes
        if (pasteResult.TerrainChanges.Count > 0) {
            doc.UpdateLandblocksBatchInternal(pasteResult.TerrainChanges, out _);
        }

        // Step 4: Place objects
        int objectsPlaced = 0;
        var objectLbs = new HashSet<ushort>();
        if (includeObjects) {
            foreach (var (lbKey, obj) in pasteResult.ObjectsToPlace) {
                try {
                    var lbDoc = GetLandblockDoc(lbKey);
                    lbDoc.AddStaticObject(obj);
                    objectsPlaced++;
                    objectLbs.Add(lbKey);
                } catch (Exception ex) {
                    objectsSkipped++;
                    skipMessages.Add($"place LB 0x{lbKey:X4}: {ex.Message}");
                }
            }
        }

        // Step 5: Invalidate tile cache for every touched landblock (direct paste,
        // not via transact), mirroring OnTransactCommitted — else get-tile keeps
        // serving the pre-edit tile.
        foreach (var lbKey in pasteResult.TerrainChanges.Keys) InvalidateLbTile(lbKey);
        foreach (var lbKey in objectLbs) InvalidateLbTile(lbKey);

        int terrainChanges = pasteResult.TerrainChanges.Values.Sum(d => d.Count);
        var modifiedLbs = new HashSet<ushort>(pasteResult.TerrainChanges.Keys);
        return new PasteStampResult(terrainChanges, objectsPlaced, modifiedLbs,
            objectsSkipped, skipMessages.Count > 0 ? skipMessages : null);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Portal snap operations
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public SnapPortalResult SnapPortal(
        uint lbX, uint lbY, ushort targetCellNumber, ushort targetPortalPolyId,
        ushort sourceEnvId, ushort sourceCellStruct,
        List<ushort>? surfaceOverride = null) {

        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var dungeonDoc = GetDungeonDoc(lbKey)
            ?? throw new InvalidOperationException($"No dungeon for landblock 0x{lbKey:X4}");

        // Find the target cell
        var targetCell = dungeonDoc.GetCell(targetCellNumber)
            ?? throw new InvalidOperationException($"Cell 0x{targetCellNumber:X4} not found");

        // Load target cell's CellStruct from DAT to get portal geometry
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        uint targetEnvFileId = (uint)(targetCell.EnvironmentId | 0x0D000000);
        if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(targetEnvFileId, out var targetEnv))
            throw new InvalidOperationException($"Could not load Environment 0x{targetEnvFileId:X8}");

        CellStruct? targetCellStruct = null;
        if (targetEnv.Cells != null && targetEnv.Cells.TryGetValue(targetCell.CellStructure, out var tcs))
            targetCellStruct = tcs;
        if (targetCellStruct == null)
            throw new InvalidOperationException($"Could not find CellStruct {targetCell.CellStructure} in Environment 0x{targetEnvFileId:X8}");

        // Get target portal geometry in local space, then transform to world
        var targetLocalGeom = PortalSnapAlgorithms.GetPortalGeometry(targetCellStruct, targetPortalPolyId)
            ?? throw new InvalidOperationException($"Could not compute geometry for portal polygon 0x{targetPortalPolyId:X4}");

        var (targetCentroidWorld, targetNormalWorld) = PortalSnapAlgorithms.TransformPortalToWorld(
            targetLocalGeom, targetCell.Origin, targetCell.Orientation);

        // Load source cell's CellStruct from DAT
        uint sourceEnvFileId = (uint)(sourceEnvId | 0x0D000000);
        if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(sourceEnvFileId, out var sourceEnv))
            throw new InvalidOperationException($"Could not load source Environment 0x{sourceEnvFileId:X8}");

        CellStruct? sourceCellStructObj = null;
        if (sourceEnv.Cells != null && sourceEnv.Cells.TryGetValue(sourceCellStruct, out var scs))
            sourceCellStructObj = scs;
        if (sourceCellStructObj == null)
            throw new InvalidOperationException($"Could not find CellStruct {sourceCellStruct} in source Environment 0x{sourceEnvFileId:X8}");

        // Pick the best source portal to align with the target
        var bestSourcePortalId = PortalSnapAlgorithms.PickBestSourcePortal(sourceCellStructObj, targetNormalWorld)
            ?? throw new InvalidOperationException("Source cell has no portals to snap.");

        var sourceLocalGeom = PortalSnapAlgorithms.GetPortalGeometry(sourceCellStructObj, bestSourcePortalId)
            ?? throw new InvalidOperationException($"Could not compute geometry for source portal 0x{bestSourcePortalId:X4}");

        // Compute snap transform
        var (newOrigin, newOrientation) = PortalSnapAlgorithms.ComputeSnapTransform(
            targetCentroidWorld, targetNormalWorld, sourceLocalGeom);

        // Inherit the target cell's surface list so the snapped cell shares the
        // neighboring material set. An Environment(0x0D) defines geometry, not a
        // surface list, so nothing populates surfaces "from the environment" — a
        // cell created with zero surfaces is invisible in-game (and is flagged by
        // validate-dungeon). The optional surfaceOverride lets the caller supply an
        // explicit list instead.
        var surfaces = (surfaceOverride != null && surfaceOverride.Count > 0)
            ? new List<ushort>(surfaceOverride)
            : new List<ushort>(targetCell.Surfaces);

        // Add the new cell to the dungeon
        var newCellNum = dungeonDoc.AddCell(sourceEnvId, sourceCellStruct, newOrigin, newOrientation, surfaces);

        // Connect the portals between target and new cell
        dungeonDoc.ConnectPortals(targetCellNumber, targetPortalPolyId, newCellNum, bestSourcePortalId);

        int totalPortals = 0;
        var newCell = dungeonDoc.GetCell(newCellNum);
        if (newCell != null) totalPortals = newCell.CellPortals.Count;

        string? warning = surfaces.Count == 0
            ? "cell created with 0 surfaces — assign surfaces before export or it will be invisible in-game"
            : null;

        return new SnapPortalResult(
            lbKey, targetCellNumber, targetPortalPolyId,
            sourceEnvId, sourceCellStruct, newCellNum,
            newOrigin, newOrientation, totalPortals, surfaces.Count, warning);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Bulk query
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public BulkHeightmapResult GetBulkHeightmap(
        uint minX, uint minY, uint maxX, uint maxY) {
        RequireProject();
        var results = new List<HeightmapResult>();
        int total = 0;
        for (uint x = minX; x <= maxX; x++) {
            for (uint y = minY; y <= maxY; y++) {
                total++;
                var r = GetHeightmap(x, y);
                if (r.Found) results.Add(r);
            }
        }
        return new BulkHeightmapResult(total, results.Count, results);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Object detail (DAT model inspection)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public ObjectDetailResult GetObjectDetail(uint objectId) {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        bool isSetup = (objectId >> 24) == 0x02;
        bool isGfxObj = (objectId >> 24) == 0x01;
        string datType = isSetup ? "Setup" : isGfxObj ? "GfxObj" : "Unknown";
        string hexId = $"0x{objectId:X8}";

        int partCount = 0, polyCount = 0, vertexCount = 0;
        float maxDimension = 0f;
        float[]? bMin = null, bMax = null, bSize = null;
        var surfaceIds = new List<string>();

        if (isSetup) {
            if (!dats.TryGet<Setup>(objectId, out var setup))
                return new ObjectDetailResult(objectId, hexId, datType, false);

            partCount = setup.Parts?.Count ?? 0;

            // Aggregate geometry stats from each part
            var minV = new Vector3(float.MaxValue);
            var maxV = new Vector3(float.MinValue);
            bool anyVertex = false;

            for (int i = 0; i < (setup.Parts?.Count ?? 0); i++) {
                uint partId = setup.Parts![i];
                if (dats.TryGet<GfxObj>(partId, out var gfx)) {
                    polyCount += gfx.Polygons?.Count ?? 0;
                    vertexCount += gfx.VertexArray?.Vertices?.Count ?? 0;
                    if (gfx.Surfaces != null)
                        foreach (var sid in gfx.Surfaces) surfaceIds.Add($"0x{sid:X8}");

                    // Compute bounds from vertices, applying the part's full
                    // placement frame (rotation + translation). Select the
                    // placement frame deterministically: default placement id 0,
                    // falling back to the first sorted key.
                    Vector3 partOffset = Vector3.Zero;
                    Quaternion partRot = Quaternion.Identity;
                    if (setup.PlacementFrames != null && setup.PlacementFrames.Count > 0) {
                        var placementKey = setup.PlacementFrames.ContainsKey(default)
                            ? default
                            : setup.PlacementFrames.Keys.Min();
                        var dp = setup.PlacementFrames[placementKey];
                        if (dp?.Frames != null && i < dp.Frames.Count) {
                            partOffset = dp.Frames[i].Origin;
                            partRot = dp.Frames[i].Orientation;
                        }
                    }
                    if (gfx.VertexArray?.Vertices != null) {
                        foreach (var v in gfx.VertexArray.Vertices.Values) {
                            var wpos = Vector3.Transform(v.Origin, partRot) + partOffset;
                            minV = Vector3.Min(minV, wpos);
                            maxV = Vector3.Max(maxV, wpos);
                            anyVertex = true;
                        }
                    }
                }
            }

            if (anyVertex) {
                bMin = new[] { minV.X, minV.Y, minV.Z };
                bMax = new[] { maxV.X, maxV.Y, maxV.Z };
                var s = maxV - minV;
                bSize = new[] { s.X, s.Y, s.Z };
                maxDimension = Math.Max(s.X, Math.Max(s.Y, s.Z));
            }
        } else if (isGfxObj) {
            if (!dats.TryGet<GfxObj>(objectId, out var gfx))
                return new ObjectDetailResult(objectId, hexId, datType, false);

            partCount = 1;
            polyCount = gfx.Polygons?.Count ?? 0;
            vertexCount = gfx.VertexArray?.Vertices?.Count ?? 0;
            if (gfx.Surfaces != null)
                foreach (var sid in gfx.Surfaces) surfaceIds.Add($"0x{sid:X8}");

            var minV = new Vector3(float.MaxValue);
            var maxV = new Vector3(float.MinValue);
            bool anyVertex = false;
            if (gfx.VertexArray?.Vertices != null) {
                foreach (var v in gfx.VertexArray.Vertices.Values) {
                    minV = Vector3.Min(minV, v.Origin);
                    maxV = Vector3.Max(maxV, v.Origin);
                    anyVertex = true;
                }
            }
            if (anyVertex) {
                bMin = new[] { minV.X, minV.Y, minV.Z };
                bMax = new[] { maxV.X, maxV.Y, maxV.Z };
                var s = maxV - minV;
                bSize = new[] { s.X, s.Y, s.Z };
                maxDimension = Math.Max(s.X, Math.Max(s.Y, s.Z));
            }
        } else {
            return new ObjectDetailResult(objectId, hexId, datType, false);
        }

        // Optionally enrich with ontology data
        string? ontCat = null, ontScale = null;
        List<string>? ontTags = null;
        if (_ontologyService.IsScanned) {
            var oe = _ontologyService.GetEntry(objectId);
            if (oe != null) {
                ontCat = oe.Category;
                ontScale = oe.Scale;
                ontTags = oe.Tags?.ToList();
            }
        }

        return new ObjectDetailResult(objectId, hexId, datType, true,
            partCount, polyCount, vertexCount, maxDimension,
            bMin, bMax, bSize,
            surfaceIds.Distinct().ToList(),
            ontCat, ontScale, ontTags);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Terrain diff (change detection)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public TerrainDiffResult DiffTerrain(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var terrainDoc = GetTerrainDoc();

        var currentData = terrainDoc.GetLandblockInternal(lbKey);
        if (currentData == null)
            return new TerrainDiffResult(lbKey, lbX, lbY, false, false);

        var baseData = terrainDoc.GetBaseLandblockInternal(lbKey);
        if (baseData == null)
            // F48: no base-DAT terrain for this LB — every vertex is "changed vs base"
            // by definition; report BaseFound=false so the change counters aren't read
            // as a pristine (no-changes) landblock.
            return new TerrainDiffResult(lbKey, lbX, lbY, true, false, 81, BaseFound: false);

        var changes = new List<TerrainDiffEntry>();
        int heightChanges = 0, typeChanges = 0, roadChanges = 0;

        for (int i = 0; i < 81; i++) {
            var b = baseData[i];
            var c = currentData[i];
            if (!b.Equals(c)) {
                changes.Add(new TerrainDiffEntry(
                    i / 9, i % 9, i,
                    b.Height, c.Height,
                    b.Type, c.Type,
                    b.Road, c.Road));
                if (b.Height != c.Height) heightChanges++;
                if (b.Type != c.Type) typeChanges++;
                if (b.Road != c.Road) roadChanges++;
            }
        }

        return new TerrainDiffResult(lbKey, lbX, lbY, true,
            changes.Count > 0, 81, changes.Count,
            heightChanges, typeChanges, roadChanges, changes);
    }

    public RegionResult GetRegion() {
        RequireProject();
        var ht = GetHeightTable();
        List<TerrainTypeNameInfo>? terrainTypes = null;
        // T-1: widen get-region to faithfully expose Region 0x13 — LandDefs scalars,
        // GameTime, PartsMask + Sky/Sound/Scene/RegionMisc presence, and per-type
        // {TerrainColor, SceneType count}. Previously only the type names were emitted,
        // which is the "EMPTY LandDefs/GameTime/Sky/Sound/Scene" the user observed.
        uint regionNumber = 0, version = 0, partsMask = 0;
        string? regionName = null;
        RegionLandDefsInfo? landDefs = null;
        RegionGameTimeInfo? gameTime = null;
        bool hasSky = false, hasSound = false, hasScene = false, hasMisc = false;
        int? dayGroupCount = null, soundStbCount = null, sceneTypeCount = null;
        List<TerrainTypeDetail>? terrainDetails = null;
        try {
            if (_projectManager.CurrentProject!.DocumentManager.Dats
                .TryGet<DatReaderWriter.DBObjs.Region>(0x13000000, out var region)) {
                regionNumber = region.RegionNumber;
                version = region.Version;
                regionName = region.RegionName?.ToString();
                partsMask = (uint)region.PartsMask;

                var ld = region.LandDefs;
                if (ld != null) {
                    landDefs = new RegionLandDefsInfo(
                        ld.NumBlockLength, ld.NumBlockWidth, ld.SquareLength, ld.LBlockLength,
                        ld.VertexPerCell, ld.MaxObjHeight, ld.SkyHeight, ld.RoadWidth);
                }

                var gt = region.GameTime;
                if (gt != null) {
                    gameTime = new RegionGameTimeInfo(
                        Present: true,
                        ZeroTimeOfYear: gt.ZeroTimeOfYear, ZeroYear: gt.ZeroYear,
                        DayLength: gt.DayLength, DaysPerYear: gt.DaysPerYear,
                        YearSpec: gt.YearSpec?.ToString() ?? "",
                        TimesOfDayCount: gt.TimesOfDay?.Count ?? 0,
                        SeasonsCount: gt.Seasons?.Count ?? 0);
                }

                hasSky = region.SkyInfo != null;
                hasSound = region.SoundInfo != null;
                hasScene = region.SceneInfo != null;
                hasMisc = region.RegionMisc != null;
                dayGroupCount = region.SkyInfo?.DayGroups?.Count;
                soundStbCount = region.SoundInfo?.STBDesc?.Count;
                sceneTypeCount = region.SceneInfo?.SceneTypes?.Count;

                var types = region.TerrainInfo?.TerrainTypes;
                if (types != null) {
                    terrainTypes = types.Select((tt, i) => {
                        try { return new TerrainTypeNameInfo(i, tt.TerrainName); }
                        catch { return new TerrainTypeNameInfo(i, "(unavailable)"); }
                    }).ToList();
                    terrainDetails = types.Select((tt, i) => {
                        try {
                            return new TerrainTypeDetail(
                                i, tt.TerrainName?.ToString() ?? "(unavailable)",
                                ColorToUint(tt.TerrainColor), tt.SceneTypes?.Count ?? 0);
                        } catch {
                            return new TerrainTypeDetail(i, "(unavailable)", 0, 0);
                        }
                    }).ToList();
                }
            }
        } catch (Exception ex) {
            Console.Error.WriteLine($"[GetRegion] Failed to read Region 0x13000000: {ex.Message}");
        }
        return new RegionResult(
            ht, terrainTypes,
            RegionNumber: regionNumber, Version: version, RegionName: regionName,
            PartsMask: partsMask, LandDefs: landDefs, GameTime: gameTime,
            HasSkyInfo: hasSky, HasSoundInfo: hasSound, HasSceneInfo: hasScene,
            HasRegionMisc: hasMisc, DayGroupCount: dayGroupCount,
            SoundStbCount: soundStbCount, SceneTypeCount: sceneTypeCount,
            TerrainTypeDetails: terrainDetails);
    }

    // Pack a DatReaderWriter ColorARGB (a.r.g.b bytes) into 0xAARRGGBB.
    private static uint ColorToUint(DatReaderWriter.Types.ColorARGB c) =>
        ((uint)c.Alpha << 24) | ((uint)c.Red << 16) | ((uint)c.Green << 8) | c.Blue;

    // ─────────────────────────────────────────────────────────────────
    //  T-2: painting / TexMerge texture chain (get-terrain-textures)
    //  Exposes region.TerrainInfo.LandSurfaces.TexMerge so client-vs-DAT
    //  painting fidelity is auditable through the terminal. Resolves
    //  TexGID -> SurfaceTexture(0x05) -> highest-res RenderSurface(0x06)
    //  using the same pattern as CalibrateWorldMap.
    // ─────────────────────────────────────────────────────────────────
    public TerrainTexturesResult GetTerrainTextures() {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        try {
            if (!dats.TryGet<DatReaderWriter.DBObjs.Region>(0x13000000, out var region) || region == null) {
                return new TerrainTexturesResult(false, "Failed to load Region 0x13000000 from DATs",
                    0, new(), new(), new(), new());
            }
            var tm = region.TerrainInfo?.LandSurfaces?.TexMerge;
            if (tm == null) {
                return new TerrainTexturesResult(false, "Region has no TerrainInfo.LandSurfaces.TexMerge",
                    0, new(), new(), new(), new());
            }

            var descs = new List<TerrainTexDescInfo>();
            var terrainDescs = tm.TerrainDesc;
            if (terrainDescs != null) {
                for (int i = 0; i < terrainDescs.Count; i++) {
                    var d = terrainDescs[i];
                    var tex = d.TerrainTex;
                    uint texGid = tex?.TextureId ?? 0;
                    // Resolve TexGID -> SurfaceTexture -> highest-res RenderSurface.
                    uint resolved = 0;
                    try {
                        if (texGid != 0 &&
                            dats.TryGet<DatReaderWriter.DBObjs.SurfaceTexture>(texGid, out var st) &&
                            st.Textures != null && st.Textures.Count > 0) {
                            resolved = st.Textures[^1];
                        }
                    } catch { /* leave resolved = 0 */ }

                    string typeName;
                    try { typeName = d.TerrainType.ToString(); } catch { typeName = $"Type{i}"; }

                    descs.Add(new TerrainTexDescInfo(
                        Index: i,
                        TerrainType: typeName,
                        TexGID: texGid,
                        ResolvedTextureId: resolved,
                        TexTiling: tex?.TexTiling ?? 0,
                        DetailTexGID: tex?.DetailTextureId ?? 0,
                        DetailTexTiling: tex?.DetailTexTiling ?? 0,
                        MinVertBright: tex?.MinVertBright ?? 0, MaxVertBright: tex?.MaxVertBright ?? 0,
                        MinVertSaturate: tex?.MinVertSaturate ?? 0, MaxVertSaturate: tex?.MaxVertSaturate ?? 0,
                        MinVertHue: tex?.MinVertHue ?? 0, MaxVertHue: tex?.MaxVertHue ?? 0));
                }
            }

            var corner = (tm.CornerTerrainMaps ?? new())
                .Select(m => new TerrainAlphaMapInfo(m.TCode, m.TextureId)).ToList();
            var side = (tm.SideTerrainMaps ?? new())
                .Select(m => new TerrainAlphaMapInfo(m.TCode, m.TextureId)).ToList();
            var road = (tm.RoadMaps ?? new())
                .Select(m => new TerrainAlphaMapInfo(m.RCode, m.TextureId)).ToList();

            return new TerrainTexturesResult(true, null, tm.BaseTexSize, descs, corner, side, road);
        } catch (Exception ex) {
            return new TerrainTexturesResult(false, $"Failed to read TexMerge: {ex.Message}",
                0, new(), new(), new(), new());
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Terrain layers (texture distribution per landblock)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public TerrainLayersResult GetTerrainLayers(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var data = GetTerrainDoc().GetLandblockInternal(lbKey);
        if (data == null) return new TerrainLayersResult(lbKey, lbX, lbY, false);

        // Count vertices per terrain type
        var typeCounts = new Dictionary<byte, int>();
        for (int i = 0; i < data.Length; i++) {
            typeCounts.TryGetValue(data[i].Type, out var c);
            typeCounts[data[i].Type] = c + 1;
        }

        // Resolve terrain type names from Region
        Dictionary<int, string>? typeNames = null;
        try {
            if (_projectManager.CurrentProject!.DocumentManager.Dats
                .TryGet<DatReaderWriter.DBObjs.Region>(0x13000000, out var region)) {
                var types = region.TerrainInfo?.TerrainTypes;
                if (types != null) {
                    typeNames = new Dictionary<int, string>();
                    for (int i = 0; i < types.Count; i++) {
                        try { typeNames[i] = types[i].TerrainName; }
                        catch { typeNames[i] = "(unavailable)"; }
                    }
                }
            }
        } catch { }

        var layers = typeCounts.OrderByDescending(kv => kv.Value)
            .Select(kv => new TerrainLayerInfo(
                kv.Key,
                typeNames?.GetValueOrDefault(kv.Key),
                kv.Value,
                Math.Round(100.0 * kv.Value / data.Length, 1)))
            .ToList();

        return new TerrainLayersResult(lbKey, lbX, lbY, true, data.Length, layers);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  DAT extension commands (via DatReaderWriter.Extensions)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public ExportTexturesResult ExportTextures(string outputDirectory, uint? minId = null, uint? maxId = null) {
        RequireProject();
        Directory.CreateDirectory(outputDirectory);
        var project = _projectManager.CurrentProject!;
        var datDir = project.BaseDatDirectory;

        // RenderSurface IDs are in the 0x06xxxxxx range
        uint rangeMin = minId ?? 0x06000000;
        uint rangeMax = maxId ?? 0x06FFFFFF;

        int exported = 0, failed = 0;
        var errors = new List<string>();

        // Open a separate read-write DatEasyWriter for palette resolution during export
        using var writer = new DatReaderWriter.Extensions.DatEasyWriter(datDir);

        // Retail applies the index-<8 transparent clip range only to RenderSurfaces whose
        // owning Surface (0x08) carries Base1ClipMap (0x4): CSurface::SetTextureAndPalette
        // (acclient.c:357833) passes (type >> 2) & 1 into ImgTex::CreateCombinedTexture.
        // Clip-ness is NOT recorded on the RenderSurface, so resolve the ownership map up
        // front: Surface(0x08).OrigTextureId -> SurfaceTexture(0x05).Textures[] -> 0x06.
        // Every entry in Textures[] counts — they are resolution variants of the same
        // clip-map art, picked at runtime by ImgTex::fClipmapTextureScale.
        //
        // 89 RenderSurfaces are owned by BOTH a clip-map and an image Surface, and one PNG
        // cannot represent both readings. "Any owner is a clip-map" wins: a clip-map
        // consumer handed an opaque texture draws a solid box, whereas an image consumer
        // handed a clipped one loses only the pixels mapping to palette colour 0, which is
        // normally the reserved key colour. Retail is itself ambiguous here — its
        // texture_table key is __PAIR__(textureDID, paletteDID) with no clip-map bit
        // (acclient.c:367712), so whichever surface loads first wins.
        var clipMapRenderSurfaces = new HashSet<uint>();
        foreach (var sEntry in writer.Dats.Portal.Tree) {
            if ((sEntry.Id & 0xFF000000u) != 0x08000000u) continue;
            if (!writer.Dats.TryGet<DatReaderWriter.DBObjs.Surface>(sEntry.Id, out var surf)) continue;
            if ((surf.Type & DatReaderWriter.Enums.SurfaceType.Base1ClipMap) == 0) continue;
            if (surf.OrigTextureId == 0) continue;
            if (!writer.Dats.TryGet<DatReaderWriter.DBObjs.SurfaceTexture>(
                    surf.OrigTextureId, out var st)) continue;
            if (st.Textures == null) continue;
            foreach (var rsId in st.Textures) clipMapRenderSurfaces.Add(rsId);
        }

        // Iterate Portal tree for RenderSurface entries
        foreach (var entry in writer.Dats.Portal.Tree) {
            if (entry.Id < rangeMin || entry.Id > rangeMax) continue;

            try {
                if (writer.Dats.TryGet<DatReaderWriter.DBObjs.RenderSurface>(entry.Id, out var rs)) {
                    var outPath = Path.Combine(outputDirectory, $"0x{entry.Id:X8}.png");
                    var result = rs.SaveToImageFile(outPath, writer,
                        clipMap: clipMapRenderSurfaces.Contains(entry.Id));
                    if (result.Success) exported++;
                    else { failed++; errors.Add($"0x{entry.Id:X8}: {result.Error}"); }
                }
            } catch (Exception ex) {
                failed++;
                errors.Add($"0x{entry.Id:X8}: {ex.Message}");
            }
        }

        // Also check HighRes
        foreach (var entry in writer.Dats.HighRes.Tree) {
            if (entry.Id < rangeMin || entry.Id > rangeMax) continue;

            try {
                if (writer.Dats.HighRes.TryGet<DatReaderWriter.DBObjs.RenderSurface>(entry.Id, out var rs)) {
                    var outPath = Path.Combine(outputDirectory, $"0x{entry.Id:X8}_hires.png");
                    var result = rs.SaveToImageFile(outPath, writer,
                        clipMap: clipMapRenderSurfaces.Contains(entry.Id));
                    if (result.Success) exported++;
                    else { failed++; errors.Add($"0x{entry.Id:X8}_hires: {result.Error}"); }
                }
            } catch (Exception ex) {
                failed++;
                errors.Add($"0x{entry.Id:X8}_hires: {ex.Message}");
            }
        }

        return new ExportTexturesResult(failed == 0, exported, failed,
            outputDirectory, errors.Count > 0 ? errors : null);
    }

    public ImportTextureResult ImportTexture(uint textureId, string imageFilePath) {
        RequireProject();
        if (!File.Exists(imageFilePath))
            return new ImportTextureResult(false, textureId, imageFilePath, "File not found");

        try {
            var project = _projectManager.CurrentProject!;
            var datDir = project.BaseDatDirectory;
            DatReaderWriter.Lib.Result<bool, string> result;
            // NOTE: import-texture writes the BASE client_portal.dat in place — the change is
            // immediate and permanent, unlike import-render-surface which defers via CustomTextureStore
            // until export. Dispose the short-lived ReadWrite handle before refreshing the project's
            // read handles so the readers don't observe a torn/stale surface.
            using (var writer = new DatReaderWriter.Extensions.DatEasyWriter(datDir)) {
                result = writer.UpdateRenderSurface(textureId, imageFilePath, shouldResize: true);
            }
            if (result.Success) {
                project.ReloadDatReadersAfterExternalWrite();
                return new ImportTextureResult(true, textureId, imageFilePath);
            }
            return new ImportTextureResult(false, textureId, imageFilePath, result.Error);
        } catch (Exception ex) {
            return new ImportTextureResult(false, textureId, imageFilePath, ex.Message);
        }
    }

    public CloneDatResult CloneDat(string outputPath) {
        RequireProject();
        try {
            var project = _projectManager.CurrentProject!;
            var portalPath = Path.Combine(project.BaseDatDirectory, "client_portal.dat");
            if (!File.Exists(portalPath))
                return new CloneDatResult(false, portalPath, outputPath, "Portal DAT not found");

            File.Copy(portalPath, outputPath, overwrite: true);
            return new CloneDatResult(true, portalPath, outputPath);
        } catch (Exception ex) {
            return new CloneDatResult(false, "", outputPath, ex.Message);
        }
    }

    public DefragmentDatResult DefragmentDat(string datType, string outputPath) {
        RequireProject();
        try {
            var project = _projectManager.CurrentProject!;
            var datDir = project.BaseDatDirectory;
            string datLabel = datType.ToLowerInvariant();

            if (datLabel != "portal" && datLabel != "cell" && datLabel != "local")
                return new DefragmentDatResult(false, datType, outputPath,
                    Error: $"Unknown DAT type '{datType}'. Use 'portal', 'cell', or 'local'.");

            // The Defragment extension method needs a DatDatabase.
            // Build the appropriate dat file path and open directly.
            string datFileName = datLabel switch {
                "portal" => "client_portal.dat",
                "cell" => "client_cell_1.dat",
                "local" => "client_local_English.dat",
                _ => throw new InvalidOperationException("unreachable")
            };

            var datPath = Path.Combine(datDir, datFileName);
            if (!File.Exists(datPath))
                return new DefragmentDatResult(false, datLabel, outputPath,
                    Error: $"DAT file not found: {datPath}");

            using var db = new DatReaderWriter.DatDatabase(opt => {
                opt.FilePath = datPath;
                opt.AccessType = DatReaderWriter.Options.DatAccessType.Read;
            });

            int bytesFreed = DatReaderWriter.Extensions.DatDatabaseExtensions.Defragment(db, outputPath, out int skipped);
            // F55: a defragment that silently dropped unreadable entries is NOT a clean
            // result — fail it so the lossy output DAT is never mistaken for a complete copy.
            if (skipped > 0)
                return new DefragmentDatResult(false, datLabel, outputPath, bytesFreed,
                    Error: $"Defragment dropped {skipped} unreadable source entr{(skipped == 1 ? "y" : "ies")}; output DAT is incomplete and bytesFreed includes the lost bytes.",
                    FilesSkipped: skipped);
            return new DefragmentDatResult(true, datLabel, outputPath, bytesFreed);
        } catch (Exception ex) {
            return new DefragmentDatResult(false, datType, outputPath, Error: ex.Message);
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Ontology export (CSV)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public ExportOntologyResult ExportOntology(string outputPath) {
        if (!_ontologyService.IsScanned)
            throw new InvalidOperationException(
                "Ontology has not been scanned yet. Run 'scan-ontology' first.");

        int count = 0;
        using (var writer = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8)) {
            writer.WriteLine(
                "ObjectId,DatType,Category,Scale,MaxDimension,AspectRatio,PartCount,PolyCount," +
                "Tags,ClassificationSource,Name,Architecture,Biome,Behavior,CreatureFamilyName," +
                "WeenieClassId,WeenieType,Level,DifficultyTier,MaterialTags,SurfaceIds,VertexCount");
            foreach (var entry in _ontologyService.GetAllEntries()) {
                writer.WriteLine(string.Join(",", new string[] {
                    $"0x{entry.ObjectId:X8}",
                    entry.DatType,
                    Csv(entry.Category),
                    Csv(entry.Scale),
                    entry.MaxDimension.ToString("F2"),
                    entry.AspectRatio.ToString("F2"),
                    entry.PartCount.ToString(),
                    entry.PolyCount.ToString(),
                    Csv(string.Join(";", entry.Tags ?? Array.Empty<string>())),
                    Csv(entry.ClassificationSource),
                    Csv(entry.Name),
                    Csv(entry.Architecture),
                    Csv(string.Join(";", entry.Biome ?? Array.Empty<string>())),
                    Csv(entry.Behavior),
                    Csv(entry.CreatureFamilyName),
                    entry.WeenieClassId?.ToString() ?? "",
                    entry.WeenieType?.ToString() ?? "",
                    entry.Level?.ToString() ?? "",
                    Csv(entry.DifficultyTier),
                    Csv(string.Join(";", entry.MaterialTags ?? Array.Empty<string>())),
                    Csv(string.Join(";", entry.SurfaceIds ?? new List<string>())),
                    entry.VertexCount.ToString(),
                }));
                count++;
            }
        }

        return new ExportOntologyResult(true, count, outputPath);
    }

    public CacheOntologyResult CacheOntology(string outputPath) {
        if (!_ontologyService.IsScanned)
            throw new InvalidOperationException(
                "Ontology has not been scanned yet. Run 'scan-ontology' first.");
        try {
            int count = _ontologyService.CacheToFile(outputPath);
            return new CacheOntologyResult(true, count, outputPath);
        } catch (Exception ex) {
            return new CacheOntologyResult(false, 0, outputPath, ex.Message);
        }
    }

    public LoadOntologyCacheResult LoadOntologyCache(string inputPath) {
        try {
            int count = _ontologyService.LoadFromCache(inputPath, out int skipped);
            return new LoadOntologyCacheResult(true, count, inputPath, LinesSkipped: skipped);
        } catch (Exception ex) {
            return new LoadOntologyCacheResult(false, 0, inputPath, ex.Message);
        }
    }

    /// <summary>
    /// Default location for the per-project ontology cache. Lets the REPL
    /// auto-restore enriched ontology state across sessions without needing
    /// to re-run scan-ontology + enrich-unified each time.
    /// </summary>
    public string DefaultOntologyCachePath() {
        var p = _projectManager.CurrentProject
            ?? throw new InvalidOperationException("No project loaded.");
        return Path.Combine(p.ProjectDirectory, "ontology_cache.jsonl");
    }

    private static string Csv(string? val) =>
        val == null ? "" : val.Contains(',') || val.Contains('"') || val.Contains('\n') || val.Contains('\r') ? $"\"{val.Replace("\"", "\"\"")}\"" : val;

    public ExportClassificationSignalsResult ExportClassificationSignals(string outputPath) {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        var buildingIds = new HashSet<uint>();
        int lbiScanned = 0;
        try {
            var allLbiIds = dats.Dats.Cell.GetAllIdsOfType<LandBlockInfo>().ToArray();
            if (allLbiIds.Length == 0) {
                for (uint x = 0; x < 255; x++) {
                    for (uint y = 0; y < 255; y++) {
                        var infoId = (uint)(((x << 8) | y) << 16 | 0xFFFE);
                        if (dats.TryGet<LandBlockInfo>(infoId, out var lbi)) {
                            lbiScanned++;
                            foreach (var b in lbi.Buildings) buildingIds.Add(b.ModelId);
                        }
                    }
                }
            } else {
                foreach (var infoId in allLbiIds) {
                    if (dats.TryGet<LandBlockInfo>(infoId, out var lbi)) {
                        lbiScanned++;
                        foreach (var b in lbi.Buildings) buildingIds.Add(b.ModelId);
                    }
                }
            }
        } catch (Exception ex) {
            return new ExportClassificationSignalsResult(false, 0, lbiScanned, 0, 0, outputPath, ex.Message);
        }

        var scenerySetupIds = new HashSet<uint>();
        int scenesScanned = 0;
        try {
            var sceneIds = dats.Dats.Portal.GetAllIdsOfType<Scene>().ToArray();
            foreach (var sceneId in sceneIds) {
                if (dats.TryGet<Scene>(sceneId, out var scene)) {
                    scenesScanned++;
                    foreach (var obj in scene.Objects) scenerySetupIds.Add(obj.ObjectId);
                }
            }
        } catch (Exception ex) {
            return new ExportClassificationSignalsResult(false, buildingIds.Count, lbiScanned, 0, scenesScanned, outputPath, ex.Message);
        }

        var dir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        using (var w = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8)) {
            w.Write("{\"buildingCount\":");
            w.Write(buildingIds.Count);
            w.Write(",\"landBlockInfoScanned\":");
            w.Write(lbiScanned);
            w.Write(",\"sceneryCount\":");
            w.Write(scenerySetupIds.Count);
            w.Write(",\"scenesScanned\":");
            w.Write(scenesScanned);

            w.Write(",\"buildingModelIds\":[");
            bool first = true;
            foreach (var id in buildingIds.OrderBy(i => i)) {
                if (!first) w.Write(',');
                first = false;
                w.Write("\"0x");
                w.Write(id.ToString("X8"));
                w.Write('"');
            }
            w.Write("]");

            w.Write(",\"scenerySetupIds\":[");
            first = true;
            foreach (var id in scenerySetupIds.OrderBy(i => i)) {
                if (!first) w.Write(',');
                first = false;
                w.Write("\"0x");
                w.Write(id.ToString("X8"));
                w.Write('"');
            }
            w.Write("]}");
        }

        return new ExportClassificationSignalsResult(true,
            buildingIds.Count, lbiScanned, scenerySetupIds.Count, scenesScanned, outputPath);
    }

    public ExportSetupPartsResult ExportSetupParts(string outputPath) {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        uint[] setupIds;
        try {
            setupIds = dats.Dats.Portal.GetAllIdsOfType<Setup>().ToArray();
        } catch (Exception ex) {
            return new ExportSetupPartsResult(false, 0, 0, 0, 0, outputPath, ex.Message);
        }

        int exported = 0;
        int failed = 0;
        var failedSample = new List<string>();
        long totalParts = 0;
        var uniqueParts = new HashSet<uint>();

        var dir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        using var writer = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);
        var sb = new System.Text.StringBuilder();

        foreach (var id in setupIds) {
            try {
                if (!dats.TryGet<Setup>(id, out var setup)) continue;

                int partCount = setup.Parts?.Count ?? 0;
                sb.Clear();
                sb.Append("{\"setupId\":\"0x");
                sb.Append(id.ToString("X8"));
                sb.Append("\",\"setupIdInt\":");
                sb.Append(id);
                sb.Append(",\"partCount\":");
                sb.Append(partCount);
                sb.Append(",\"parts\":[");
                if (partCount > 0) {
                    for (int i = 0; i < partCount; i++) {
                        uint partId = setup.Parts![i];
                        if (i > 0) sb.Append(',');
                        sb.Append("\"0x");
                        sb.Append(partId.ToString("X8"));
                        sb.Append('"');
                        uniqueParts.Add(partId);
                        totalParts++;
                    }
                }
                sb.Append("],\"partsInt\":[");
                if (partCount > 0) {
                    for (int i = 0; i < partCount; i++) {
                        if (i > 0) sb.Append(',');
                        sb.Append(setup.Parts![i]);
                    }
                }
                sb.Append("]}");
                writer.WriteLine(sb.ToString());
                exported++;
            } catch (Exception ex) {
                failed++;
                if (failedSample.Count < 5)
                    failedSample.Add($"0x{id:X8}: {ex.Message}");
            }
        }

        return new ExportSetupPartsResult(true, setupIds.Length, exported,
            (int)totalParts, uniqueParts.Count, outputPath,
            SetupsFailed: failed, FailedSample: failedSample);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  StringTable mining (DAT string extraction)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public MineStringsResult MineStrings(string? outputPath = null, string? tableFilter = null) {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        var datDir = project.BaseDatDirectory;

        var allStrings = new List<StringTableEntry>();
        int tablesScanned = 0;
        int tablesFailed = 0;
        string? lastTableError = null;

        try {
            // Open a DatEasyWriter to access the language DAT
            using var writer = new DatReaderWriter.Extensions.DatEasyWriter(datDir);

            // Scan all known StringTable types
            var tableTypes = new[] {
                (DatReaderWriter.Extensions.DBObjs.StringTableType.UI,                 "UI"),
                (DatReaderWriter.Extensions.DBObjs.StringTableType.UI_Pregame,         "UI_Pregame"),
                (DatReaderWriter.Extensions.DBObjs.StringTableType.Preference,         "Preference"),
                (DatReaderWriter.Extensions.DBObjs.StringTableType.UI_Options,         "UI_Options"),
                (DatReaderWriter.Extensions.DBObjs.StringTableType.ActionDescription,  "ActionDescription"),
                (DatReaderWriter.Extensions.DBObjs.StringTableType.Calendar,           "Calendar"),
                (DatReaderWriter.Extensions.DBObjs.StringTableType.KeyMap,             "KeyMap"),
                (DatReaderWriter.Extensions.DBObjs.StringTableType.KeyNameOverride,    "KeyNameOverride"),
                (DatReaderWriter.Extensions.DBObjs.StringTableType.MetakeyNameOverride,"MetakeyNameOverride"),
                (DatReaderWriter.Extensions.DBObjs.StringTableType.CommandSetup,       "CommandSetup"),
                (DatReaderWriter.Extensions.DBObjs.StringTableType.Options,            "Options"),
                (DatReaderWriter.Extensions.DBObjs.StringTableType.CharacterTitle,     "CharacterTitle"),
                (DatReaderWriter.Extensions.DBObjs.StringTableType.ServerEngine,       "ServerEngine"),
            };

            foreach (var (tableType, tableName) in tableTypes) {
                // Apply filter if specified
                if (!string.IsNullOrEmpty(tableFilter) &&
                    !tableName.Contains(tableFilter, StringComparison.OrdinalIgnoreCase))
                    continue;

                try {
                    var result = writer.GetStringTable(tableType);
                    if (result.Success && result.Value != null) {
                        tablesScanned++;
                        var st = result.Value;
                        foreach (var kvp in st.Strings) {
                            foreach (var s in kvp.Value.Strings) {
                                var text = s?.ToString();
                                if (!string.IsNullOrWhiteSpace(text)) {
                                    allStrings.Add(new StringTableEntry(kvp.Key, text, tableName));
                                }
                            }
                        }
                    }
                } catch (Exception ex) {
                    // Distinguish a table that THREW (corrupt DAT / unpack error) from
                    // one simply absent. Count and log so a half-corrupt dataset isn't
                    // silently reported as a clean, smaller scan.
                    tablesFailed++;
                    lastTableError = ex.Message;
                    Console.Error.WriteLine($"[MineStrings] Table '{tableName}' failed to load: {ex.Message}");
                }
            }
            if (tablesFailed > 0)
                Console.Error.WriteLine($"[MineStrings] {tablesFailed} table(s) failed to load (last: {lastTableError}).");

            // Optionally write to CSV
            if (!string.IsNullOrEmpty(outputPath)) {
                using var sw = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);
                sw.WriteLine("Hash,TableType,Text");
                foreach (var entry in allStrings) {
                    sw.WriteLine($"0x{entry.Hash:X8},{Csv(entry.TableType)},{Csv(entry.Text)}");
                }
            }

            return new MineStringsResult(true, tablesScanned, allStrings.Count, allStrings, outputPath,
                tablesFailed > 0 ? $"{tablesFailed} table(s) failed to load (last: {lastTableError})" : null,
                tablesFailed);
        } catch (Exception ex) {
            return new MineStringsResult(false, tablesScanned, 0,
                new List<StringTableEntry>(), outputPath, ex.Message);
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Ontology enrichment (LSD creature families)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public EnrichOntologyResult EnrichOntology() {
        if (!_ontologyService.IsScanned)
            throw new InvalidOperationException(
                "Ontology has not been scanned yet. Run 'scan-ontology' first.");

        // Load the hand-curated ontology schema from embedded resources
        var assembly = typeof(WorldBuilder.Shared.Lib.OntologyEntry).Assembly;
        var resourceName = assembly.GetManifestResourceNames()
            .FirstOrDefault(n => n.Contains("object_ontology_schema"));

        string? schemaJson = null;
        if (resourceName != null) {
            using var stream = assembly.GetManifestResourceStream(resourceName);
            if (stream != null)
                using (var reader = new StreamReader(stream))
                    schemaJson = reader.ReadToEnd();
        }

        // Fall back to file system if not embedded
        if (string.IsNullOrEmpty(schemaJson)) {
            var schemaPath = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..",
                "WorldBuilder.Shared", "Lib", "Resources", "object_ontology_schema.json");
            if (!File.Exists(schemaPath)) {
                // Try relative from project directory
                var projDir = _projectManager.CurrentProject?.ProjectDirectory ?? "";
                schemaPath = Path.Combine(projDir, "..", "WorldBuilder.Shared", "Lib", "Resources", "object_ontology_schema.json");
            }
            if (File.Exists(schemaPath))
                schemaJson = File.ReadAllText(schemaPath);
        }

        if (string.IsNullOrEmpty(schemaJson))
            return new EnrichOntologyResult(false, 0, _ontologyService.Count,
                "Could not find object_ontology_schema.json");

        int enriched = 0;

        try {
            using var doc = System.Text.Json.JsonDocument.Parse(schemaJson);
            var root = doc.RootElement;

            // Build a WeenieClassId -> entries lookup. Ontology entries are keyed by DAT
            // ObjectId, but each may carry an optional WeenieClassId (populated by
            // enrich-weenies / import-catalog). The shipped schema matches game-logic
            // wcids, not Setup IDs, so this index is the join key.
            var byWeenie = new Dictionary<int, List<OntologyEntry>>();
            foreach (var ontEntry in _ontologyService.GetAllEntries()) {
                if (ontEntry.WeenieClassId is int wcid) {
                    if (!byWeenie.TryGetValue(wcid, out var list))
                        byWeenie[wcid] = list = new List<OntologyEntry>();
                    list.Add(ontEntry);
                }
            }

            // Local helper: add a lowercase tag to an entry if not already present.
            static bool AddTag(OntologyEntry e, string tag) {
                var t = tag.ToLowerInvariant();
                var tags = e.Tags ?? Array.Empty<string>();
                if (Array.IndexOf(tags, t) >= 0) return false;
                var newTags = new List<string>(tags) { t };
                e.Tags = newTags.Distinct().ToArray();
                return true;
            }

            // Extract entries from the schema
            if (root.TryGetProperty("entries", out var entries)) {
                foreach (var entry in entries.EnumerateArray()) {
                    // Skip comment entries
                    if (entry.TryGetProperty("_comment", out _)) continue;

                    string? name = null;
                    string? entryType = null;

                    if (entry.TryGetProperty("name", out var nameEl))
                        name = nameEl.GetString();

                    // creature_family lives at the top level on family entries.
                    string? creatureFamily = null;
                    if (entry.TryGetProperty("creature_family", out var cfTop))
                        creatureFamily = cfTop.GetString();

                    // tags.type carries the functional taxonomy on weenie entries.
                    if (entry.TryGetProperty("tags", out var tags)) {
                        if (creatureFamily == null && tags.TryGetProperty("creature_family", out var cf))
                            creatureFamily = cf.GetString();
                        if (tags.TryGetProperty("type", out var typeEl))
                            entryType = typeEl.GetString();
                    }

                    // ── Creature-family entry: match each wcid in wcid_pool[] against
                    //    ontology entries carrying that WeenieClassId.
                    if (entry.TryGetProperty("wcid_pool", out var wcidPool)
                            && wcidPool.ValueKind == System.Text.Json.JsonValueKind.Array) {
                        var familyName = creatureFamily ?? name ?? "Unknown";
                        string? behavior = entry.TryGetProperty("behavior", out var behEl)
                            ? behEl.GetString() : null;

                        foreach (var pooled in wcidPool.EnumerateArray()) {
                            if (!pooled.TryGetProperty("wcid", out var wEl)
                                    || wEl.ValueKind != System.Text.Json.JsonValueKind.Number)
                                continue;
                            if (!byWeenie.TryGetValue(wEl.GetInt32(), out var matches))
                                continue;

                            foreach (var ontEntry in matches) {
                                bool changed = false;
                                changed |= AddTag(ontEntry, familyName);
                                changed |= AddTag(ontEntry, "creature");
                                if (behavior != null) changed |= AddTag(ontEntry, behavior);

                                if (string.IsNullOrEmpty(ontEntry.CreatureFamilyName)) {
                                    ontEntry.CreatureFamilyName = familyName;
                                    changed = true;
                                }
                                if (behavior != null && string.IsNullOrEmpty(ontEntry.Behavior)) {
                                    ontEntry.Behavior = behavior;
                                    changed = true;
                                }
                                if (changed) enriched++;
                            }
                        }
                    }

                    // ── Regular weenie entry: match the top-level weenieClassId against
                    //    ontology entries carrying that WeenieClassId.
                    if (entry.TryGetProperty("weenieClassId", out var wcidEl)
                            && wcidEl.ValueKind == System.Text.Json.JsonValueKind.Number
                            && byWeenie.TryGetValue(wcidEl.GetInt32(), out var weenieMatches)) {
                        foreach (var ontEntry in weenieMatches) {
                            bool changed = false;
                            if (name != null) changed |= AddTag(ontEntry, name);
                            if (entryType != null) changed |= AddTag(ontEntry, entryType);
                            if (creatureFamily != null) changed |= AddTag(ontEntry, creatureFamily);

                            // Override category from curated data when it differs.
                            if (entryType != null) {
                                var topLevel = entryType.Split('_')[0];
                                if (topLevel != ontEntry.Category) {
                                    ontEntry.Category = topLevel;
                                    ontEntry.ClassificationSource = "Schema";
                                    changed = true;
                                }
                            }
                            if (changed) enriched++;
                        }
                    }

                    // ── Optional model_prefix path (not in the current shipped schema,
                    //    kept for forward compatibility). A prefix with <=4 hex digits
                    //    selects on the high 16 bits; a full 8-digit prefix is exact.
                    if (entry.TryGetProperty("model_prefix", out var modelPrefix)) {
                        var prefix = modelPrefix.GetString();
                        if (prefix != null
                                && prefix.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
                            var prefixHex = prefix.AsSpan(2);
                            if (uint.TryParse(prefixHex,
                                    System.Globalization.NumberStyles.HexNumber,
                                    null, out var prefixVal)) {
                                var familyName = creatureFamily ?? name ?? "Unknown";
                                bool shortPrefix = prefixHex.Length <= 4;
                                foreach (var ontEntry in _ontologyService.GetAllEntries()) {
                                    bool match = shortPrefix
                                        ? (ontEntry.ObjectId >> 16) == prefixVal
                                        : ontEntry.ObjectId == prefixVal;
                                    if (!match) continue;
                                    bool changed = false;
                                    changed |= AddTag(ontEntry, familyName);
                                    changed |= AddTag(ontEntry, "creature");
                                    if (changed) enriched++;
                                }
                            }
                        }
                    }
                }
            }

            if (enriched == 0)
                return new EnrichOntologyResult(false, 0, _ontologyService.Count,
                    "No ontology entries matched the schema. Run 'enrich-weenies' or "
                    + "'import-catalog' first so entries carry WeenieClassIds for the "
                    + "schema's wcid/weenieClassId join to hit.");

            return new EnrichOntologyResult(true, enriched, _ontologyService.Count);
        } catch (Exception ex) {
            return new EnrichOntologyResult(false, enriched, _ontologyService.Count, ex.Message);
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Catalog import (Ontology â† Catalog index.json)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public ImportCatalogResult ImportCatalog(string indexJsonPath) {
        if (!_ontologyService.IsScanned)
            throw new InvalidOperationException(
                "Ontology has not been scanned yet. Run 'scan-ontology' first.");

        try {
            int enriched = _ontologyService.ImportCatalog(indexJsonPath, out int failed);
            return new ImportCatalogResult(true, enriched, _ontologyService.Count, indexJsonPath,
                EntriesFailed: failed);
        } catch (Exception ex) {
            return new ImportCatalogResult(false, 0, _ontologyService.Count, indexJsonPath, ex.Message);
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  LLM Classification (string-table auto-tagging)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public ClassifyOntologyResult ClassifyOntology() {
        if (!_ontologyService.IsScanned)
            throw new InvalidOperationException(
                "Ontology has not been scanned yet. Run 'scan-ontology' first.");

        RequireProject();

        try {
            // First, mine all strings from the DAT
            var mineResult = MineStrings();
            if (!mineResult.Success || mineResult.Strings.Count == 0)
                return new ClassifyOntologyResult(false, 0, 0, _ontologyService.Count,
                    mineResult.Error ?? "No strings found in DAT StringTables.");

            // Convert to the tuple format expected by EnrichFromStrings
            var stringTuples = mineResult.Strings
                .Select(s => (s.Hash, s.Text, s.TableType))
                .ToList();

            // Feed to ontology service for classification
            int enriched = _ontologyService.EnrichFromStrings(stringTuples);

            return new ClassifyOntologyResult(true, mineResult.TotalStrings, enriched, _ontologyService.Count);
        } catch (Exception ex) {
            return new ClassifyOntologyResult(false, 0, 0, _ontologyService.Count, ex.Message);
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Texture-driven material enrichment
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public EnrichMaterialsResult EnrichMaterials() {
        if (!_ontologyService.IsScanned)
            throw new InvalidOperationException(
                "Ontology has not been scanned yet. Run 'scan-ontology' first.");

        RequireProject();

        try {
            var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
            int enriched = _ontologyService.EnrichMaterials(dats);
            return new EnrichMaterialsResult(true, enriched, _ontologyService.Count);
        } catch (Exception ex) {
            return new EnrichMaterialsResult(false, 0, _ontologyService.Count, ex.Message);
        }
    }


    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  LSD Data Ingestion Pipeline
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// <summary>
    /// Batch-processes all weenie JSON files from the LSD dataset directory,
    /// extracts key properties, and writes a JSON-lines summary file.
    /// </summary>
    public IngestWeeniesResult IngestWeenies(string lsdPath, string? outputPath = null) {
        var weeniesDir = Path.Combine(lsdPath, "weenies");
        if (!Directory.Exists(weeniesDir))
            return new IngestWeeniesResult(false, 0, 0, 0, 0, 0, 0, null,
                $"Weenies directory not found: {weeniesDir}");

        // Default output path next to the LSD directory
        if (string.IsNullOrEmpty(outputPath))
            outputPath = Path.Combine(lsdPath, "weenie_summary.jsonl");

        string[] files;
        try {
            files = Directory.GetFiles(weeniesDir, "*.json");
        } catch (Exception ex) {
            return new IngestWeeniesResult(false, 0, 0, 0, 0, 0, 0, null,
                $"Failed to enumerate weenie files: {ex.Message}");
        }

        int total = files.Length;
        int processed = 0, creatures = 0, npcs = 0, items = 0, other = 0, withSetup = 0;
        int errors = 0;

        Console.Error.WriteLine($"[IngestWeenies] Found {total} weenie files in {weeniesDir}");

        try {
            using var writer = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);

            foreach (var filePath in files) {
                try {
                    var json = File.ReadAllText(filePath);
                    using var doc = System.Text.Json.JsonDocument.Parse(json);
                    var root = doc.RootElement;

                    // Extract top-level fields
                    int wcid = root.TryGetProperty("wcid", out var wcidEl) ? wcidEl.GetInt32() : 0;
                    string? name = root.TryGetProperty("name", out var nameEl) ? nameEl.GetString() : null;
                    int weenieType = root.TryGetProperty("weenieType", out var wtEl) ? wtEl.GetInt32() : 0;

                    // Extract from top-level stat arrays (actual LSD format uses
                    // didStats, intStats, stringStats at root â€” NOT nested under "properties")
                    uint? setupDid = null;
                    int? level = null;
                    int? creatureType = null;
                    int? itemType = null;
                    int? weaponType = null;    // PropertyInt.WeaponType (353) — Sword/Axe/Mace/Spear/Staff…
                    int? materialType = null;  // PropertyInt.MaterialType (131) — Iron/Steel/Silver…

                    // didStats â†’ key 1 = SetupDID
                    if (root.TryGetProperty("didStats", out var didStats)) {
                        foreach (var dp in didStats.EnumerateArray()) {
                            int key = dp.TryGetProperty("key", out var kEl) ? kEl.GetInt32() : -1;
                            if (key == 1 && dp.TryGetProperty("value", out var vEl)) {
                                setupDid = vEl.GetUInt32();
                                break;
                            }
                        }
                    }

                    // intStats â†’ key 1 = ItemType, key 2 = CreatureType, key 25 = Level
                    if (root.TryGetProperty("intStats", out var intStats)) {
                        foreach (var ip in intStats.EnumerateArray()) {
                            int key = ip.TryGetProperty("key", out var kEl) ? kEl.GetInt32() : -1;
                            if (key == 1 && ip.TryGetProperty("value", out var vEl))
                                itemType = vEl.GetInt32();
                            else if (key == 2 && ip.TryGetProperty("value", out var vEl2))
                                creatureType = vEl2.GetInt32();
                            else if (key == 25 && ip.TryGetProperty("value", out var vEl3))
                                level = vEl3.GetInt32();
                            else if (key == 353 && ip.TryGetProperty("value", out var vEl4))
                                weaponType = vEl4.GetInt32();   // PropertyInt.WeaponType
                            else if (key == 131 && ip.TryGetProperty("value", out var vEl5))
                                materialType = vEl5.GetInt32(); // PropertyInt.MaterialType
                        }
                    }

                    // Fallback: extract name from stringStats[key=1] if not at root
                    if (string.IsNullOrEmpty(name) && root.TryGetProperty("stringStats", out var strStats)) {
                        foreach (var sp in strStats.EnumerateArray()) {
                            int key = sp.TryGetProperty("key", out var kEl) ? kEl.GetInt32() : -1;
                            if (key == 1 && sp.TryGetProperty("value", out var vEl)) {
                                name = vEl.GetString();
                                break;
                            }
                        }
                    }

                    // Classify by type
                    switch (weenieType) {
                        case 7: creatures++; break;    // Creature
                        case 12: npcs++; break;        // Vendor/NPC
                        case 1: case 5: case 6: case 10: case 18: case 35: case 36:
                            items++; break;
                        default: other++; break;
                    }

                    if (setupDid.HasValue) withSetup++;

                    // Write JSON-line
                    writer.Write("{\"wcid\":");
                    writer.Write(wcid);
                    writer.Write(",\"name\":");
                    writer.Write(System.Text.Json.JsonSerializer.Serialize(name));
                    writer.Write(",\"weenieType\":");
                    writer.Write(weenieType);
                    writer.Write(",\"setupDid\":");
                    writer.Write(setupDid.HasValue ? setupDid.Value.ToString() : "null");
                    writer.Write(",\"level\":");
                    writer.Write(level.HasValue ? level.Value.ToString() : "null");
                    writer.Write(",\"creatureType\":");
                    writer.Write(creatureType.HasValue ? creatureType.Value.ToString() : "null");
                    writer.Write(",\"itemType\":");
                    writer.Write(itemType.HasValue ? itemType.Value.ToString() : "null");
                    writer.Write(",\"weaponType\":");
                    writer.Write(weaponType.HasValue ? weaponType.Value.ToString() : "null");
                    writer.Write(",\"materialType\":");
                    writer.Write(materialType.HasValue ? materialType.Value.ToString() : "null");
                    writer.WriteLine("}");

                    processed++;
                } catch {
                    errors++;
                    // Skip individual file failures
                }

                if ((processed + errors) % 1000 == 0)
                    Console.Error.WriteLine($"[IngestWeenies] ...{processed + errors}/{total} files processed ({errors} errors)");
            }

            Console.Error.WriteLine($"[IngestWeenies] Complete: {processed}/{total} files processed, {errors} errors");
            Console.Error.WriteLine($"[IngestWeenies]   Creatures: {creatures}, NPCs: {npcs}, Items: {items}, Other: {other}");
            Console.Error.WriteLine($"[IngestWeenies]   With SetupDID: {withSetup} ({(total > 0 ? 100.0 * withSetup / total : 0):F1}%)");
            Console.Error.WriteLine($"[IngestWeenies]   Output: {outputPath}");

            return new IngestWeeniesResult(true, processed, creatures, npcs, items, other, withSetup, outputPath, null, errors);
        } catch (Exception ex) {
            return new IngestWeeniesResult(false, processed, creatures, npcs, items, other, withSetup, outputPath, ex.Message, errors);
        }
    }

    /// <summary>
    /// Takes the JSON-lines output from ingest-weenies and merges it into the live ontology.
    /// Maps setupDid â†’ OntologyEntry, populating Name, WeenieClassId, WeenieType, Level, etc.
    /// </summary>
    public EnrichWeeniesResult EnrichWeenies(string weenieSummaryPath) {
        if (!_ontologyService.IsScanned)
            throw new InvalidOperationException(
                "Ontology has not been scanned yet. Run 'scan-ontology' first.");

        try {
            int enriched = _ontologyService.EnrichFromWeenies(weenieSummaryPath);
            return new EnrichWeeniesResult(true, enriched, _ontologyService.Count);
        } catch (Exception ex) {
            return new EnrichWeeniesResult(false, 0, _ontologyService.Count, ex.Message);
        }
    }

    /// <summary>
    /// Enriches the live ontology from the canonical_enrichment.json file produced by
    /// build_ontology_enrichment.py. Applies architecture, biome, behavior, creature family,
    /// difficulty tier, and merged tags to matching ontology entries.
    /// </summary>
    public EnrichCanonicalResult EnrichCanonical(string canonicalJsonPath) {
        if (!_ontologyService.IsScanned)
            throw new InvalidOperationException(
                "Ontology has not been scanned yet. Run 'scan-ontology' first.");

        try {
            int enriched = _ontologyService.EnrichFromCanonical(canonicalJsonPath);
            return new EnrichCanonicalResult(true, enriched, _ontologyService.Count, canonicalJsonPath);
        } catch (Exception ex) {
            return new EnrichCanonicalResult(false, 0, _ontologyService.Count, canonicalJsonPath, ex.Message);
        }
    }

    /// <summary>
    /// Enriches the live ontology from unified_ontology.json (built by
    /// scripts/build_unified_ontology.py). Applies the full ontology stack
    /// — canonical + ACE world DB + Setup→Parts inheritance + DAT building/
    /// scenery signals + geometry — keyed by both setup_did and gfx_obj_id.
    /// </summary>
    public EnrichUnifiedResult EnrichUnified(string unifiedJsonPath) {
        if (!_ontologyService.IsScanned)
            throw new InvalidOperationException(
                "Ontology has not been scanned yet. Run 'scan-ontology' first.");

        try {
            int enriched = _ontologyService.EnrichFromUnified(unifiedJsonPath);
            return new EnrichUnifiedResult(true, enriched, _ontologyService.Count, unifiedJsonPath);
        } catch (Exception ex) {
            return new EnrichUnifiedResult(false, 0, _ontologyService.Count, unifiedJsonPath, ex.Message);
        }
    }

    /// <summary>
    /// Scans all 255Ã—255 retail landblocks from the DAT and extracts every building's
    /// Setup ID + world XY position. Writes building_placements.jsonl for the Python
    /// geocoder (scan_building_cultures.py) to map models to cultural architectures.
    /// </summary>
    public ScanBuildingPlacementsResult ScanBuildingPlacements(string? outputPath = null) {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        if (string.IsNullOrEmpty(outputPath)) {
            var projDir = _projectManager.CurrentProject.ProjectDirectory;
            outputPath = Path.Combine(projDir, "..", "building_placements.jsonl");
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();
        int totalBuildings = 0;
        int landblocksWithBuildings = 0;
        var uniqueSetupIds = new HashSet<uint>();

        try {
            using var writer = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);

            for (uint x = 0; x < 255; x++) {
                for (uint y = 0; y < 255; y++) {
                    var infoId = (uint)(((x << 8) | y) << 16 | 0xFFFE);
                    if (!dats.TryGet<DatReaderWriter.DBObjs.LandBlockInfo>(infoId, out var lbi))
                        continue;

                    if (lbi.Buildings == null || lbi.Buildings.Count == 0)
                        continue;

                    landblocksWithBuildings++;

                    foreach (var building in lbi.Buildings) {
                        // World position = landblock origin + building frame origin
                        float worldX = x * 192f + building.Frame.Origin.X;
                        float worldY = y * 192f + building.Frame.Origin.Y;
                        float worldZ = building.Frame.Origin.Z;

                        writer.Write("{\"setupId\":");
                        writer.Write(building.ModelId);
                        writer.Write(",\"setupIdHex\":\"0x");
                        writer.Write(building.ModelId.ToString("X8"));
                        writer.Write("\",\"lbX\":");
                        writer.Write(x);
                        writer.Write(",\"lbY\":");
                        writer.Write(y);
                        writer.Write(",\"worldX\":");
                        writer.Write(Math.Round(worldX, 1).ToString(CultureInfo.InvariantCulture));
                        writer.Write(",\"worldY\":");
                        writer.Write(Math.Round(worldY, 1).ToString(CultureInfo.InvariantCulture));
                        writer.Write(",\"worldZ\":");
                        writer.Write(Math.Round(worldZ, 1).ToString(CultureInfo.InvariantCulture));
                        writer.Write(",\"numLeaves\":");
                        writer.Write(building.NumLeaves);
                        writer.Write(",\"portalCount\":");
                        writer.Write(building.Portals?.Count ?? 0);
                        writer.WriteLine("}");

                        totalBuildings++;
                        uniqueSetupIds.Add(building.ModelId);
                    }
                }

                if ((x + 1) % 50 == 0)
                    Console.Error.WriteLine($"[ScanBuildings] ...{x + 1}/255 rows scanned, {totalBuildings} buildings found");
            }

            sw.Stop();
            Console.Error.WriteLine($"[ScanBuildings] Complete: {totalBuildings} buildings, {uniqueSetupIds.Count} unique models, {landblocksWithBuildings} landblocks");
            Console.Error.WriteLine($"[ScanBuildings] Output: {outputPath}");

            return new ScanBuildingPlacementsResult(true, totalBuildings, uniqueSetupIds.Count,
                landblocksWithBuildings, sw.Elapsed.TotalMilliseconds, outputPath);
        } catch (Exception ex) {
            return new ScanBuildingPlacementsResult(false, totalBuildings, uniqueSetupIds.Count,
                landblocksWithBuildings, sw.Elapsed.TotalMilliseconds, outputPath, ex.Message);
        }
    }

    /// <summary>
    /// Loads a difficulty gradient JSON (produced by build_difficulty_gradient.py)
    /// and reports the tier distribution. Also validates that the gradient is ready
    /// for use by PopulateEmptyAreas.
    /// </summary>
    public DifficultyGradientResult LoadDifficultyGradient(string? gradientPath = null) {
        if (string.IsNullOrEmpty(gradientPath)) {
            var projDir = _projectManager.CurrentProject?.ProjectDirectory ?? ".";
            gradientPath = Path.Combine(projDir, "..", "difficulty_gradient.json");
        }

        if (!File.Exists(gradientPath))
            return new DifficultyGradientResult(false, gradientPath, new Dictionary<string, int>(),
                $"Gradient file not found: {gradientPath}. Run: python scripts/build_difficulty_gradient.py");

        try {
            var json = File.ReadAllText(gradientPath);
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;

            var tierDist = new Dictionary<string, int>();
            if (root.TryGetProperty("tier_distribution", out var distEl)) {
                foreach (var prop in distEl.EnumerateObject()) {
                    tierDist[prop.Name] = prop.Value.GetInt32();
                }
            }

            // Validate grid
            int gridSize = root.TryGetProperty("grid_size", out var gsEl) ? gsEl.GetInt32() : 0;
            if (gridSize != 255)
                return new DifficultyGradientResult(false, gradientPath, tierDist,
                    $"Invalid grid size: {gridSize} (expected 255)");

            return new DifficultyGradientResult(true, gradientPath, tierDist);
        } catch (Exception ex) {
            return new DifficultyGradientResult(false, gradientPath, new Dictionary<string, int>(), ex.Message);
        }
    }

    /// <summary>
    /// World-space origin (in metres) of a landblock's south-west corner, used to
    /// convert population-plan LB-local coordinates to the world-frame coordinates
    /// stored in <see cref="StaticObject.Origin"/>. Each landblock is 192m square.
    /// Exposed (internal) so the apply-population coordinate invariant is unit-testable
    /// without a fully loaded project.
    /// </summary>
    internal static (float worldOffsetX, float worldOffsetY) PopulationWorldOffset(int lbX, int lbY)
        => (lbX * 192f, lbY * 192f);

    /// <summary>
    /// Applies a population plan (produced by build_population_plan.py) to the current world.
    /// Places static objects (scenery, structures) into landblock documents.
    /// Creatures are logged but not placed as static objects â€” they need server-side
    /// weenie spawn entries (a separate step).
    /// </summary>
    public ApplyPopulationResult ApplyPopulation(string planPath, bool dryRun = false) {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        var dats = project.DocumentManager.Dats;
        var sw = System.Diagnostics.Stopwatch.StartNew();

        if (!File.Exists(planPath))
            return new ApplyPopulationResult(false, 0, 0, 0, 0, planPath,
                $"Plan file not found: {planPath}");

        // Get terrain height lookup for Z-snapping (same function validators use)
        Func<float, float, float>? heightLookup = null;
        try { (_, _, heightLookup) = GetTerrainHelpers(); } catch { }

        try {
            var json = File.ReadAllText(planPath);
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (!root.TryGetProperty("placements", out var placements))
                return new ApplyPopulationResult(false, 0, 0, 0, 0, planPath, "No 'placements' in plan");

            int landblocksModified = 0;
            int objectsPlaced = 0;
            int objectsSkipped = 0;

            foreach (var placement in placements.EnumerateArray()) {
                int lbX = placement.GetProperty("lbX").GetInt32();
                int lbY = placement.GetProperty("lbY").GetInt32();

                // Reject out-of-range landblock coords (the (lbX<<8)|lbY pack wraps > 254)
                if (lbX < 0 || lbX > 254 || lbY < 0 || lbY > 254) {
                    if (placement.TryGetProperty("objects", out var skipObjs))
                        objectsSkipped += skipObjs.GetArrayLength();
                    continue;
                }
                uint lbId = (uint)((lbX << 8) | lbY);

                // World-space offset for this landblock
                var (worldOffsetX, worldOffsetY) = PopulationWorldOffset(lbX, lbY);

                if (!placement.TryGetProperty("objects", out var objects))
                    continue;

                bool modified = false;

                foreach (var obj in objects.EnumerateArray()) {
                    var category = obj.TryGetProperty("category", out var catEl)
                        ? catEl.GetString() ?? "" : "";

                    // Skip creatures â€” they need server-side weenie spawns, not static DAT objects
                    if (category == "Creature") {
                        objectsSkipped++;
                        continue;
                    }

                    var setupId = obj.TryGetProperty("setupId", out var sidEl)
                        ? sidEl.GetUInt32() : 0u;
                    if (setupId == 0) {
                        objectsSkipped++;
                        continue;
                    }

                    // Classify by DID type byte (0x01 GfxObj, 0x02 Setup) and verify it
                    // resolves in the loaded DAT — mirror add-object's existence check.
                    byte typeByte = (byte)(setupId >> 24);
                    if (typeByte != 0x01 && typeByte != 0x02) {
                        objectsSkipped++;
                        continue;
                    }
                    bool didExists = typeByte == 0x02
                        ? dats.TryGet<Setup>(setupId, out _)
                        : dats.TryGet<GfxObj>(setupId, out _);
                    if (!didExists) {
                        objectsSkipped++;
                        continue;
                    }

                    float localX = obj.TryGetProperty("localX", out var lxEl) ? lxEl.GetSingle() : 96f;
                    float localY = obj.TryGetProperty("localY", out var lyEl) ? lyEl.GetSingle() : 96f;
                    float localZ = 0f;

                    // Convert local to world coords (the doc model / exporter treat
                    // StaticObject.Origin as world-space and reverse via ReverseOffset).
                    float worldX = worldOffsetX + localX;
                    float worldY = worldOffsetY + localY;

                    // Height-snap: sample terrain at the world position.
                    if (heightLookup != null) {
                        try {
                            localZ = heightLookup(worldX, worldY);
                        } catch {
                            // Height lookup can fail at edges or ocean â€” fall back to 0
                        }
                    }

                    if (!dryRun) {
                        // Get or create the landblock document via existing helper
                        var lbDoc = GetLandblockDoc((ushort)lbId);

                        bool isSetup = typeByte == 0x02;
                        var staticObj = new StaticObject {
                            Id = setupId,
                            IsSetup = isSetup,
                            // Mirror AddObject: store world-space coordinates.
                            Origin = new System.Numerics.Vector3(worldX, worldY, localZ),
                            Orientation = System.Numerics.Quaternion.Identity,
                            Scale = System.Numerics.Vector3.One,
                        };

                        lbDoc.AddStaticObject(staticObj);
                    }

                    objectsPlaced++;
                    modified = true;
                }

                if (modified)
                    landblocksModified++;
            }

            sw.Stop();

            return new ApplyPopulationResult(true, landblocksModified, objectsPlaced,
                objectsSkipped, sw.Elapsed.TotalMilliseconds, planPath);
        } catch (Exception ex) {
            return new ApplyPopulationResult(false, 0, 0, 0, sw.Elapsed.TotalMilliseconds, planPath, ex.Message);
        }
    }

    /// <summary>
    /// Batch-processes all spawn map JSON files from the LSD dataset directory,
    /// extracts spatial placement data (weenie WCIDs, positions, links).
    /// </summary>
    public IngestSpawnMapsResult IngestSpawnMaps(string lsdPath, string? outputPath = null) {
        var mapsDir = Path.Combine(lsdPath, "spawnMaps");
        if (!Directory.Exists(mapsDir))
            return new IngestSpawnMapsResult(false, 0, 0, 0, 0, null,
                $"Spawn maps directory not found: {mapsDir}");

        if (string.IsNullOrEmpty(outputPath))
            outputPath = Path.Combine(lsdPath, "spawnmap_summary.jsonl");

        string[] files;
        try {
            files = Directory.GetFiles(mapsDir, "*.json");
        } catch (Exception ex) {
            return new IngestSpawnMapsResult(false, 0, 0, 0, 0, null,
                $"Failed to enumerate spawn map files: {ex.Message}");
        }

        int total = files.Length;
        int processed = 0, totalWeenies = 0, totalLinks = 0;
        var allWcids = new HashSet<int>();
        int errors = 0;

        Console.Error.WriteLine($"[IngestSpawnMaps] Found {total} spawn map files in {mapsDir}");

        try {
            using var writer = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);

            foreach (var filePath in files) {
                try {
                    var json = File.ReadAllText(filePath);
                    using var doc = System.Text.Json.JsonDocument.Parse(json);
                    var root = doc.RootElement;

                    // Extract key from top level (landblock IDs are uint32, can exceed int32 max)
                    long mapKey = root.TryGetProperty("key", out var keyEl) ? keyEl.GetInt64() : 0;
                    string? desc = root.TryGetProperty("desc", out var descEl) ? descEl.GetString() : null;

                    int weenieCount = 0;
                    int linkCount = 0;
                    var wcidList = new List<int>();

                    // Extract weenies from value.weenies
                    if (root.TryGetProperty("value", out var valueEl)) {
                        if (valueEl.TryGetProperty("weenies", out var weeniesEl)) {
                            foreach (var w in weeniesEl.EnumerateArray()) {
                                weenieCount++;
                                if (w.TryGetProperty("wcid", out var wcidEl)) {
                                    int wcid = wcidEl.GetInt32();
                                    wcidList.Add(wcid);
                                    allWcids.Add(wcid);
                                }
                            }
                        }
                        if (valueEl.TryGetProperty("links", out var linksEl)) {
                            linkCount = linksEl.GetArrayLength();
                        }
                    }

                    totalWeenies += weenieCount;
                    totalLinks += linkCount;

                    // Write summary line
                    writer.Write("{\"key\":");
                    writer.Write(mapKey);
                    writer.Write(",\"desc\":");
                    writer.Write(System.Text.Json.JsonSerializer.Serialize(desc));
                    writer.Write(",\"weenieCount\":");
                    writer.Write(weenieCount);
                    writer.Write(",\"linkCount\":");
                    writer.Write(linkCount);
                    writer.Write(",\"wcids\":[");
                    writer.Write(string.Join(",", wcidList));
                    writer.WriteLine("]}");

                    processed++;
                } catch {
                    errors++;
                }

                if ((processed + errors) % 200 == 0)
                    Console.Error.WriteLine($"[IngestSpawnMaps] ...{processed + errors}/{total} files processed ({errors} errors)");
            }

            Console.Error.WriteLine($"[IngestSpawnMaps] Complete: {processed}/{total} files, {totalWeenies} weenies, {totalLinks} links, {allWcids.Count} unique WCIDs");
            Console.Error.WriteLine($"[IngestSpawnMaps]   Output: {outputPath}");

            return new IngestSpawnMapsResult(true, processed, totalWeenies, totalLinks, allWcids.Count, outputPath, null, errors);
        } catch (Exception ex) {
            return new IngestSpawnMapsResult(false, processed, totalWeenies, totalLinks, allWcids.Count, outputPath, ex.Message, errors);
        }
    }


    /// <summary>
    /// Parses the LSD spells.json file, extracts spell properties, and writes a JSON-lines summary.
    /// </summary>
    public IngestSpellsResult IngestSpells(string lsdPath, string? outputPath = null) {
        var spellsFile = Path.Combine(lsdPath, "spells.json");
        if (!File.Exists(spellsFile))
            return new IngestSpellsResult(false, 0, new Dictionary<int, int>(), null,
                $"Spells file not found: {spellsFile}");

        if (string.IsNullOrEmpty(outputPath))
            outputPath = Path.Combine(lsdPath, "spell_summary.jsonl");

        int processed = 0;
        var schoolCounts = new Dictionary<int, int>();
        int errors = 0;

        Console.Error.WriteLine($"[IngestSpells] Reading spells from: {spellsFile}");

        try {
            var json = File.ReadAllText(spellsFile);
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;

            // The actual structure is: { "table": { "spellBaseHash": [ {key:..., value:...}, ... ] } }
            System.Text.Json.JsonElement spellArray;
            if (root.TryGetProperty("table", out var tableEl) &&
                tableEl.TryGetProperty("spellBaseHash", out var hashEl)) {
                spellArray = hashEl;
            } else if (root.ValueKind == System.Text.Json.JsonValueKind.Array) {
                // Fallback: top-level array
                spellArray = root;
            } else {
                return new IngestSpellsResult(false, 0, schoolCounts, null,
                    "Cannot find spell data. Expected 'table.spellBaseHash' array or top-level array.");
            }

            int total = spellArray.GetArrayLength();
            Console.Error.WriteLine($"[IngestSpells] Found {total} spell entries");

            using var writer = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);

            foreach (var entry in spellArray.EnumerateArray()) {
                try {
                    int spellId = entry.TryGetProperty("key", out var keyEl) ? keyEl.GetInt32() : 0;

                    if (!entry.TryGetProperty("value", out var valueEl)) {
                        errors++;
                        continue;
                    }

                    string? spellName = valueEl.TryGetProperty("name", out var nameEl) ? nameEl.GetString() : null;
                    int school = valueEl.TryGetProperty("school", out var schoolEl) ? schoolEl.GetInt32() : 0;
                    int power = valueEl.TryGetProperty("power", out var powerEl) ? powerEl.GetInt32() : 0;
                    int baseMana = valueEl.TryGetProperty("base_mana", out var manaEl) ? manaEl.GetInt32() : 0;

                    // Track school distribution
                    schoolCounts[school] = schoolCounts.GetValueOrDefault(school) + 1;

                    // Write JSON-line
                    writer.Write("{\"spellId\":");
                    writer.Write(spellId);
                    writer.Write(",\"name\":");
                    writer.Write(System.Text.Json.JsonSerializer.Serialize(spellName));
                    writer.Write(",\"school\":");
                    writer.Write(school);
                    writer.Write(",\"power\":");
                    writer.Write(power);
                    writer.Write(",\"baseMana\":");
                    writer.Write(baseMana);
                    writer.WriteLine("}");

                    processed++;
                } catch {
                    errors++;
                }

                if ((processed + errors) % 1000 == 0)
                    Console.Error.WriteLine($"[IngestSpells] ...{processed + errors}/{total} entries processed ({errors} errors)");
            }

            Console.Error.WriteLine($"[IngestSpells] Complete: {processed} spells processed, {errors} errors");
            Console.Error.WriteLine($"[IngestSpells]   Schools: {string.Join(", ", schoolCounts.OrderBy(kv => kv.Key).Select(kv => $"{kv.Key}={kv.Value}"))}");
            Console.Error.WriteLine($"[IngestSpells]   Output: {outputPath}");

            return new IngestSpellsResult(true, processed, schoolCounts, outputPath, null, errors);
        } catch (Exception ex) {
            return new IngestSpellsResult(false, processed, schoolCounts, outputPath, ex.Message, errors);
        }
    }

    /// <summary>
    /// Batch-processes all recipe JSON files from the LSD dataset directory,
    /// extracts crafting data (skill, difficulty, ingredients, results), and writes a JSON-lines summary.
    /// </summary>
    public IngestRecipesResult IngestRecipes(string lsdPath, string? outputPath = null) {
        var recipesDir = Path.Combine(lsdPath, "recipes");
        if (!Directory.Exists(recipesDir))
            return new IngestRecipesResult(false, 0, 0, 0, 0, new Dictionary<int, int>(), null,
                $"Recipes directory not found: {recipesDir}");

        if (string.IsNullOrEmpty(outputPath))
            outputPath = Path.Combine(lsdPath, "recipe_summary.jsonl");

        var files = Directory.GetFiles(recipesDir, "*.json");
        int total = files.Length;
        int processed = 0, errors = 0, withPrecursors = 0;
        var skillCounts = new Dictionary<int, int>();
        var sourceWcids = new HashSet<int>();
        var resultWcids = new HashSet<int>();

        Console.Error.WriteLine($"[IngestRecipes] Found {total} recipe files in: {recipesDir}");

        try {
            using var writer = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);

            foreach (var file in files) {
                try {
                    var json = File.ReadAllText(file);
                    using var doc = System.Text.Json.JsonDocument.Parse(json);
                    var root = doc.RootElement;

                    int recipeId = root.TryGetProperty("key", out var keyEl) ? keyEl.GetInt32() : 0;
                    string? desc = root.TryGetProperty("desc", out var descEl) ? descEl.GetString() : null;

                    int skill = 0, difficulty = 0, successWcid = 0, failWcid = 0;
                    if (root.TryGetProperty("recipe", out var recipeEl)) {
                        skill = recipeEl.TryGetProperty("Skill", out var skillEl) ? skillEl.GetInt32() : 0;
                        difficulty = recipeEl.TryGetProperty("Difficulty", out var diffEl) ? diffEl.GetInt32() : 0;
                        successWcid = recipeEl.TryGetProperty("SuccessWcid", out var swEl) ? swEl.GetInt32() : 0;
                        failWcid = recipeEl.TryGetProperty("FailWcid", out var fwEl) ? fwEl.GetInt32() : 0;
                    }

                    // Track skill distribution
                    skillCounts[skill] = skillCounts.GetValueOrDefault(skill) + 1;

                    // Track result WCID
                    if (successWcid > 0) resultWcids.Add(successWcid);

                    // Parse precursors (tool + target = the items you combine)
                    var precursorList = new List<int[]>();
                    if (root.TryGetProperty("precursors", out var precEl) &&
                        precEl.ValueKind == System.Text.Json.JsonValueKind.Array) {
                        foreach (var p in precEl.EnumerateArray()) {
                            int tool = p.TryGetProperty("tool", out var tEl) ? tEl.GetInt32() : 0;
                            int target = p.TryGetProperty("target", out var targEl) ? targEl.GetInt32() : 0;
                            if (tool > 0 || target > 0) {
                                precursorList.Add(new[] { tool, target });
                                if (tool > 0) sourceWcids.Add(tool);
                                if (target > 0) sourceWcids.Add(target);
                            }
                        }
                    }

                    if (precursorList.Count > 0) withPrecursors++;

                    // Write JSON-line
                    writer.Write("{\"recipeId\":");
                    writer.Write(recipeId);
                    writer.Write(",\"name\":");
                    writer.Write(System.Text.Json.JsonSerializer.Serialize(desc));
                    writer.Write(",\"skill\":");
                    writer.Write(skill);
                    writer.Write(",\"difficulty\":");
                    writer.Write(difficulty);
                    writer.Write(",\"successWcid\":");
                    writer.Write(successWcid);
                    writer.Write(",\"failWcid\":");
                    writer.Write(failWcid);
                    writer.Write(",\"precursors\":[");
                    for (int i = 0; i < precursorList.Count; i++) {
                        if (i > 0) writer.Write(",");
                        writer.Write($"[{precursorList[i][0]},{precursorList[i][1]}]");
                    }
                    writer.WriteLine("]}");

                    processed++;
                } catch {
                    errors++;
                }

                if ((processed + errors) % 1000 == 0)
                    Console.Error.WriteLine($"[IngestRecipes] ...{processed + errors}/{total} files processed ({errors} errors)");
            }

            Console.Error.WriteLine($"[IngestRecipes] Complete: {processed} recipes processed, {errors} errors");
            Console.Error.WriteLine($"[IngestRecipes]   Skills: {string.Join(", ", skillCounts.OrderBy(kv => kv.Key).Select(kv => $"{kv.Key}={kv.Value}"))}");
            Console.Error.WriteLine($"[IngestRecipes]   With precursors: {withPrecursors}");
            Console.Error.WriteLine($"[IngestRecipes]   Unique source WCIDs (tools+targets): {sourceWcids.Count}");
            Console.Error.WriteLine($"[IngestRecipes]   Unique result WCIDs: {resultWcids.Count}");
            Console.Error.WriteLine($"[IngestRecipes]   Output: {outputPath}");

            return new IngestRecipesResult(true, processed, withPrecursors,
                sourceWcids.Count, resultWcids.Count, skillCounts, outputPath, null, errors);
        } catch (Exception ex) {
            return new IngestRecipesResult(false, processed, withPrecursors,
                sourceWcids.Count, resultWcids.Count, skillCounts, outputPath, ex.Message, errors);
        }
    }


    /// <summary>
    /// Maps a heightmap byte to a retail <c>TerrainTextureType</c> index using the same
    /// height bands shared by <see cref="GenerateTerrain"/> and <see cref="AutoPaintTerrain"/>.
    /// Uses the retail enum values (matching the BiomeMapper worldgen convention) so both
    /// generators produce semantically identical worlds.
    /// </summary>
    private static byte PaintBandTerrainType(byte height,
        ref int waterVerts, ref int sandVerts, ref int grassVerts, ref int rockVerts, ref int snowVerts) {
        if (height < 10)       { waterVerts++; return 0x14; } // WaterDeepSea
        else if (height < 25)  { sandVerts++;  return 0x0A; } // SandYellow
        else if (height < 80)  { grassVerts++; return 0x01; } // Grassland
        else if (height < 180) { rockVerts++;  return 0x00; } // BarrenRock
        else                   { snowVerts++;  return 0x0F; } // Snow
    }

    /// <summary>
    /// Generates procedural terrain for all 255Ã—255 landblocks using Simplex fBm noise.
    /// Optionally applies coastline masking and auto-painting.
    /// </summary>
    public GenerateTerrainResult GenerateTerrain(
        int seed, int octaves = 6, float lacunarity = 2f, float persistence = 0.5f,
        float amplitude = 128f, List<(float X, float Y)>? coastlinePolygon = null,
        bool autoPaint = true) {

        RequireProject();
        var terrainDoc = GetTerrainDoc();
        var noise = new SimplexNoise(seed);
        CoastlineMask? coastline = null;
        if (coastlinePolygon != null && coastlinePolygon.Count >= 3)
            coastline = new CoastlineMask(coastlinePolygon);

        // Base frequency scaled so the noise looks natural across the 255Ã—255 world
        // World is 255*192 = 48960 units wide. A frequency of ~0.0003 gives continent-scale features.
        float baseFrequency = 1f / 1024f;

        var sw = new System.Diagnostics.Stopwatch();
        sw.Start();

        int landblocksWritten = 0;
        long verticesWritten = 0;

        // Auto-paint accumulators
        int waterVerts = 0, sandVerts = 0, grassVerts = 0, rockVerts = 0, snowVerts = 0, cliffOverrides = 0;

        terrainDoc.BenchmarkMode = true;
        try {
            for (uint lbX = 0; lbX <= 254; lbX++) {
                for (uint lbY = 0; lbY <= 254; lbY++) {
                    byte[] heights = new byte[81];
                    byte[] types = autoPaint ? new byte[81] : Array.Empty<byte>();

                    for (int vx = 0; vx < 9; vx++) {
                        for (int vy = 0; vy < 9; vy++) {
                            float worldX = lbX * 192f + vx * 24f;
                            float worldY = lbY * 192f + vy * 24f;

                            // Generate noise value in [-1, 1], then map to [0, amplitude]
                            float n = noise.FBm(worldX * baseFrequency, worldY * baseFrequency,
                                octaves, lacunarity, persistence);
                            float h = (n + 1f) * 0.5f * amplitude; // Map [-1,1] to [0, amplitude]

                            // Apply coastline mask if provided
                            if (coastline != null) {
                                float mask = coastline.GetMask(worldX, worldY);
                                h *= mask;
                            }

                            // Clamp to byte range
                            byte heightByte = (byte)Math.Clamp((int)Math.Round(h), 0, 255);
                            int idx = vx * 9 + vy;
                            heights[idx] = heightByte;

                            if (autoPaint) {
                                // Assign retail TerrainTextureType based on height bands.
                                types[idx] = PaintBandTerrainType(heightByte,
                                    ref waterVerts, ref sandVerts, ref grassVerts, ref rockVerts, ref snowVerts);
                            }
                        }
                    }

                    // Slope-based cliff override (auto-paint only)
                    if (autoPaint) {
                        for (int vx = 0; vx < 9; vx++) {
                            for (int vy = 0; vy < 9; vy++) {
                                int idx = vx * 9 + vy;
                                int h = heights[idx];

                                // Check delta with adjacent vertices
                                bool steep = false;
                                if (vx > 0 && Math.Abs(h - heights[(vx - 1) * 9 + vy]) > 3) steep = true;
                                if (vx < 8 && Math.Abs(h - heights[(vx + 1) * 9 + vy]) > 3) steep = true;
                                if (vy > 0 && Math.Abs(h - heights[vx * 9 + (vy - 1)]) > 3) steep = true;
                                if (vy < 8 && Math.Abs(h - heights[vx * 9 + (vy + 1)]) > 3) steep = true;

                                if (steep && heights[idx] >= 10) { // Don't override water
                                    types[idx] = 0x00; // BarrenRock (cliff/rocky)
                                    cliffOverrides++;
                                }
                            }
                        }
                    }

                    // Write heightmap
                    SetLandblockHeightmap(lbX, lbY, heights);

                    // Write terrain types if auto-painting
                    if (autoPaint) {
                        SetLandblockTerrain(lbX, lbY, types);
                    }

                    landblocksWritten++;
                    verticesWritten += 81;
                }
            }
        } finally {
            terrainDoc.BenchmarkMode = false;
            terrainDoc.ForceSave();
        }

        sw.Stop();
        double elapsedMs = sw.Elapsed.TotalMilliseconds;
        double lbPerSec = landblocksWritten / (elapsedMs / 1000.0);

        return new GenerateTerrainResult(
            Success: true,
            Seed: seed,
            Octaves: octaves,
            Lacunarity: lacunarity,
            Persistence: persistence,
            Amplitude: amplitude,
            LandblocksWritten: landblocksWritten,
            VerticesWritten: verticesWritten,
            ElapsedMs: Math.Round(elapsedMs, 1),
            LandblocksPerSec: Math.Round(lbPerSec, 1),
            HasCoastline: coastline != null,
            AutoPainted: autoPaint);
    }

    /// <summary>
    /// Auto-paints terrain types based on existing heightmap data.
    /// Can be run standalone after terrain generation or manual editing.
    /// </summary>
    public AutoPaintResult AutoPaintTerrain() {
        RequireProject();
        var terrainDoc = GetTerrainDoc();
        var sw = new System.Diagnostics.Stopwatch();
        sw.Start();

        int landblocksWritten = 0;
        long verticesPainted = 0;
        int waterVerts = 0, sandVerts = 0, grassVerts = 0, rockVerts = 0, snowVerts = 0, cliffOverrides = 0;

        terrainDoc.BenchmarkMode = true;
        try {
            for (uint lbX = 0; lbX <= 254; lbX++) {
                for (uint lbY = 0; lbY <= 254; lbY++) {
                    ushort lbKey = LbKey(lbX, lbY);
                    var data = terrainDoc.GetLandblockInternal(lbKey);
                    if (data == null) continue;

                    byte[] heights = new byte[81];
                    byte[] types = new byte[81];
                    bool anyChange = false;

                    // Read current heights
                    for (int i = 0; i < 81; i++) heights[i] = data[i].Height;

                    // Assign retail TerrainTextureType based on height bands.
                    // (Band counters are tallied from FINAL types below, only for written
                    // landblocks — pass throwaway refs here.)
                    int dW = 0, dS = 0, dG = 0, dR = 0, dN = 0;
                    for (int i = 0; i < 81; i++) {
                        types[i] = PaintBandTerrainType(heights[i],
                            ref dW, ref dS, ref dG, ref dR, ref dN);
                    }

                    // Slope-based cliff overrides
                    for (int vx = 0; vx < 9; vx++) {
                        for (int vy = 0; vy < 9; vy++) {
                            int idx = vx * 9 + vy;
                            int h = heights[idx];
                            bool steep = false;
                            if (vx > 0 && Math.Abs(h - heights[(vx - 1) * 9 + vy]) > 3) steep = true;
                            if (vx < 8 && Math.Abs(h - heights[(vx + 1) * 9 + vy]) > 3) steep = true;
                            if (vy > 0 && Math.Abs(h - heights[vx * 9 + (vy - 1)]) > 3) steep = true;
                            if (vy < 8 && Math.Abs(h - heights[vx * 9 + (vy + 1)]) > 3) steep = true;
                            if (steep && heights[idx] >= 10) {
                                types[idx] = 0x00; // BarrenRock (cliff/rocky)
                            }
                        }
                    }

                    // Check if types actually changed
                    for (int i = 0; i < 81; i++) {
                        if (data[i].Type != types[i]) { anyChange = true; break; }
                    }

                    if (anyChange) {
                        SetLandblockTerrain(lbX, lbY, types);
                        landblocksWritten++;
                        verticesPainted += 81;

                        // Tally FINAL post-override types per band, only for written LBs,
                        // and record cliff overrides as a separate informational counter.
                        for (int vx = 0; vx < 9; vx++) {
                            for (int vy = 0; vy < 9; vy++) {
                                int idx = vx * 9 + vy;
                                if (types[idx] == 0x00) {
                                    bool steep = false;
                                    if (vx > 0 && Math.Abs(heights[idx] - heights[(vx - 1) * 9 + vy]) > 3) steep = true;
                                    if (vx < 8 && Math.Abs(heights[idx] - heights[(vx + 1) * 9 + vy]) > 3) steep = true;
                                    if (vy > 0 && Math.Abs(heights[idx] - heights[vx * 9 + (vy - 1)]) > 3) steep = true;
                                    if (vy < 8 && Math.Abs(heights[idx] - heights[vx * 9 + (vy + 1)]) > 3) steep = true;
                                    if (steep && heights[idx] >= 10) cliffOverrides++;
                                }
                                switch (types[idx]) {
                                    case 0x14: waterVerts++; break;  // WaterDeepSea
                                    case 0x0A: sandVerts++;  break;  // SandYellow
                                    case 0x01: grassVerts++; break;  // Grassland
                                    case 0x00: rockVerts++;  break;  // BarrenRock (incl. cliff override)
                                    case 0x0F: snowVerts++;  break;  // Snow
                                }
                            }
                        }
                    }
                }
            }
        } finally {
            terrainDoc.BenchmarkMode = false;
            terrainDoc.ForceSave();
        }

        sw.Stop();
        return new AutoPaintResult(
            Success: true,
            LandblocksWritten: landblocksWritten,
            VerticesPainted: verticesPainted,
            ElapsedMs: Math.Round(sw.Elapsed.TotalMilliseconds, 1),
            WaterVertices: waterVerts,
            SandVertices: sandVerts,
            GrassVertices: grassVerts,
            RockVertices: rockVerts,
            SnowVertices: snowVerts,
            CliffOverrides: cliffOverrides);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Benchmark
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public BenchmarkResult RunBenchmark() {
        RequireProject();

        var tests = new List<BenchmarkSubTest>();
        var memory = new List<BenchmarkMemorySnapshot>();
        var sw = new System.Diagnostics.Stopwatch();

        // Snapshot GC before
        var gcBefore = new BenchmarkGcCounts("Before",
            GC.CollectionCount(0), GC.CollectionCount(1), GC.CollectionCount(2));
        memory.Add(new BenchmarkMemorySnapshot("Before", GC.GetTotalMemory(false)));

        // Find populated landblocks for benchmark
        var terrainDoc = GetTerrainDoc();
        terrainDoc.BenchmarkMode = true; // Suppress per-edit logging & persistence queue

        // Snapshots of the touched landblocks so the benchmark is non-destructive.
        // Declared outside the try so the finally can always restore them, even if
        // the run throws midway through after mutating some landblocks.
        var terrainSnapshots = new Dictionary<ushort, TerrainEntry[]>();
        var staticObjSnapshots = new Dictionary<ushort, List<StaticObject>>();
        bool restored = false;

        try {

        var populatedLbs = new List<(uint x, uint y, ushort key)>();
        for (uint x = 0; x <= 254 && populatedLbs.Count < 50; x++) {
            for (uint y = 0; y <= 254 && populatedLbs.Count < 50; y++) {
                ushort key = (ushort)((x << 8) | y);
                if (terrainDoc.GetLandblockInternal(key) != null)
                    populatedLbs.Add((x, y, key));
            }
        }

        if (populatedLbs.Count == 0)
            throw new InvalidOperationException("No populated landblocks found to benchmark against.");

        // â”€â”€â”€ Snapshot the touched landblocks so the benchmark is non-destructive â”€â”€â”€
        // The benchmark mutates terrain heights/types and appends static objects to
        // every populated landblock it touches. Snapshot that state here and restore
        // it in the finally so the speed test leaves the project unchanged.
        foreach (var lb in populatedLbs) {
            var entries = terrainDoc.GetLandblockInternal(lb.key); // returns a copy
            if (entries != null)
                terrainSnapshots[lb.key] = entries;
            // Snapshot the static-object list so appended benchmark objects can be removed.
            var lbDoc = GetLandblockDoc(lb.key);
            staticObjSnapshots[lb.key] = lbDoc.GetStaticObjects().ToList();
        }

        // â”€â”€â”€ Test 1: Terrain edit throughput (2000 set-height calls) â”€â”€â”€
        const int TERRAIN_OPS = 2000;
        const int SEGMENT_SIZE = 500;
        var segmentTimes = new List<double>();
        int segmentStart = 0;

        sw.Restart();
        var segmentSw = new System.Diagnostics.Stopwatch();
        segmentSw.Start();

        for (int i = 0; i < TERRAIN_OPS; i++) {
            var lb = populatedLbs[i % populatedLbs.Count];
            int vx = (i / populatedLbs.Count) % 9;
            int vy = ((i / populatedLbs.Count) / 9) % 9;
            float worldX = lb.x * 192f + vx * 24f;
            float worldY = lb.y * 192f + vy * 24f;
            byte height = (byte)(i % 256);
            SetHeight(worldX, worldY, 0.1f, height);

            if ((i + 1 - segmentStart) >= SEGMENT_SIZE) {
                segmentSw.Stop();
                segmentTimes.Add(segmentSw.Elapsed.TotalMilliseconds);
                segmentStart = i + 1;
                segmentSw.Restart();
            }
        }
        sw.Stop();

        double terrainElapsed = sw.Elapsed.TotalMilliseconds;
        double terrainOpsPerSec = TERRAIN_OPS / (terrainElapsed / 1000.0);
        double? firstSegOps = segmentTimes.Count > 0 ? SEGMENT_SIZE / (segmentTimes[0] / 1000.0) : null;
        double? lastSegOps = segmentTimes.Count > 1 ? SEGMENT_SIZE / (segmentTimes[^1] / 1000.0) : null;
        double? degradation = firstSegOps.HasValue && lastSegOps.HasValue && firstSegOps.Value > 0
            ? Math.Round(100.0 * (1.0 - lastSegOps.Value / firstSegOps.Value), 1)
            : null;

        tests.Add(new BenchmarkSubTest("set-height", TERRAIN_OPS, Math.Round(terrainElapsed, 1),
            Math.Round(terrainOpsPerSec, 1),
            firstSegOps.HasValue ? Math.Round(firstSegOps.Value, 1) : null,
            lastSegOps.HasValue ? Math.Round(lastSegOps.Value, 1) : null,
            degradation));

        memory.Add(new BenchmarkMemorySnapshot("After terrain edits", GC.GetTotalMemory(false)));

        // â”€â”€â”€ Test 2: Object placement throughput (2000 add-object calls) â”€â”€â”€
        const int OBJECT_OPS = 2000;
        int objFailures = 0;
        segmentTimes.Clear();
        segmentStart = 0;

        sw.Restart();
        segmentSw.Restart();

        for (int i = 0; i < OBJECT_OPS; i++) {
            var lb = populatedLbs[i % populatedLbs.Count];
            float ox = lb.x * 192f + (i % 180) + 6f;
            float oy = lb.y * 192f + ((i / 180) % 180) + 6f;
            try {
                AddObject(lb.x, lb.y, 0x020000A7, ox, oy, 0f);
            } catch { objFailures++; /* count, don't credit toward throughput */ }

            if ((i + 1 - segmentStart) >= SEGMENT_SIZE) {
                segmentSw.Stop();
                segmentTimes.Add(segmentSw.Elapsed.TotalMilliseconds);
                segmentStart = i + 1;
                segmentSw.Restart();
            }
        }
        sw.Stop();

        // Exclude failed placements from the throughput denominator so opsPerSec
        // reflects successful work, not swallowed exceptions.
        int objSuccesses = OBJECT_OPS - objFailures;
        double objElapsed = sw.Elapsed.TotalMilliseconds;
        double objOpsPerSec = objSuccesses / (objElapsed / 1000.0);
        double? objFirstSeg = segmentTimes.Count > 0 ? SEGMENT_SIZE / (segmentTimes[0] / 1000.0) : null;
        double? objLastSeg = segmentTimes.Count > 1 ? SEGMENT_SIZE / (segmentTimes[^1] / 1000.0) : null;
        double? objDeg = objFirstSeg.HasValue && objLastSeg.HasValue && objFirstSeg.Value > 0
            ? Math.Round(100.0 * (1.0 - objLastSeg.Value / objFirstSeg.Value), 1)
            : null;

        tests.Add(new BenchmarkSubTest("add-object", objSuccesses, Math.Round(objElapsed, 1),
            Math.Round(objOpsPerSec, 1),
            objFirstSeg.HasValue ? Math.Round(objFirstSeg.Value, 1) : null,
            objLastSeg.HasValue ? Math.Round(objLastSeg.Value, 1) : null,
            objDeg));

        memory.Add(new BenchmarkMemorySnapshot("After object placement", GC.GetTotalMemory(false)));

        // â”€â”€â”€ Test 3: Validation throughput (50 validate-all calls) â”€â”€â”€
        const int VALIDATE_OPS = 50;
        var valLb = populatedLbs[0];

        sw.Restart();
        for (int i = 0; i < VALIDATE_OPS; i++) {
            ValidateAll(valLb.x, valLb.y);
        }
        sw.Stop();

        double valElapsed = sw.Elapsed.TotalMilliseconds;
        double valOpsPerSec = VALIDATE_OPS / (valElapsed / 1000.0);
        tests.Add(new BenchmarkSubTest("validate-all", VALIDATE_OPS, Math.Round(valElapsed, 1),
            Math.Round(valOpsPerSec, 1)));

        memory.Add(new BenchmarkMemorySnapshot("After validation", GC.GetTotalMemory(false)));

        // â”€â”€â”€ Test 4: Bulk heightmap throughput (500 set-landblock-heightmap calls) â”€â”€â”€
        // Segment size is smaller than the per-op tests so first/last comparisons
        // remain meaningful at this lower op count.
        const int BULK_OPS = 500;
        const int BULK_SEGMENT_SIZE = 100;
        var bulkHeights = new byte[81];
        for (int i = 0; i < 81; i++) bulkHeights[i] = 128;

        segmentTimes.Clear();
        segmentStart = 0;

        sw.Restart();
        segmentSw.Restart();

        for (int i = 0; i < BULK_OPS; i++) {
            var lb = populatedLbs[i % populatedLbs.Count];
            // Vary heights slightly per iteration
            for (int v = 0; v < 81; v++) bulkHeights[v] = (byte)((128 + i + v) % 256);
            SetLandblockHeightmap(lb.x, lb.y, bulkHeights);

            if ((i + 1 - segmentStart) >= BULK_SEGMENT_SIZE) {
                segmentSw.Stop();
                segmentTimes.Add(segmentSw.Elapsed.TotalMilliseconds);
                segmentStart = i + 1;
                segmentSw.Restart();
            }
        }
        sw.Stop();

        double bulkElapsed = sw.Elapsed.TotalMilliseconds;
        double bulkOpsPerSec = BULK_OPS / (bulkElapsed / 1000.0);
        double? bulkFirstSeg = segmentTimes.Count > 0 ? BULK_SEGMENT_SIZE / (segmentTimes[0] / 1000.0) : null;
        double? bulkLastSeg = segmentTimes.Count > 1 ? BULK_SEGMENT_SIZE / (segmentTimes[^1] / 1000.0) : null;
        double? bulkDeg = bulkFirstSeg.HasValue && bulkLastSeg.HasValue && bulkFirstSeg.Value > 0
            ? Math.Round(100.0 * (1.0 - bulkLastSeg.Value / bulkFirstSeg.Value), 1)
            : null;

        tests.Add(new BenchmarkSubTest("set-landblock-heightmap (bulk)", BULK_OPS,
            Math.Round(bulkElapsed, 1), Math.Round(bulkOpsPerSec, 1),
            bulkFirstSeg.HasValue ? Math.Round(bulkFirstSeg.Value, 1) : null,
            bulkLastSeg.HasValue ? Math.Round(bulkLastSeg.Value, 1) : null,
            bulkDeg));

        memory.Add(new BenchmarkMemorySnapshot("After bulk heightmap", GC.GetTotalMemory(false)));
        memory.Add(new BenchmarkMemorySnapshot("Final", GC.GetTotalMemory(false)));

        // Snapshot GC after
        var gcAfter = new BenchmarkGcCounts("After",
            GC.CollectionCount(0), GC.CollectionCount(1), GC.CollectionCount(2));

        // â”€â”€â”€ Extrapolation â”€â”€â”€
        const long TOTAL_LANDBLOCKS = 65025;  // 255 Ã— 255
        const long TOTAL_VERTEX_WRITES = 5267025; // 65025 Ã— 81
        const long TOTAL_OBJECT_PLACEMENTS = 500000;

        double estTerrainSec = TOTAL_VERTEX_WRITES / terrainOpsPerSec;
        double? estBulkSec = bulkOpsPerSec > 0 ? TOTAL_LANDBLOCKS / bulkOpsPerSec : null;
        double estObjectSec = TOTAL_OBJECT_PLACEMENTS / objOpsPerSec;

        // Determine feasibility based on bulk terrain pass (the realistic path)
        double effectiveTerrainSec = estBulkSec ?? estTerrainSec;
        string feasibility;
        if (effectiveTerrainSec < 7200 && estObjectSec < 7200 && (degradation ?? 0) < 20)
            feasibility = "GREEN â€” Full-scale generation is feasible on commodity hardware";
        else if (effectiveTerrainSec < 86400 && estObjectSec < 86400)
            feasibility = "YELLOW â€” Full-scale feasible but slow; optimization recommended";
        else
            feasibility = "RED â€” Full-scale has fundamental bottlenecks; pivot to smaller scale or architectural changes needed";

        var extrapolation = new BenchmarkExtrapolation(
            Math.Round(terrainOpsPerSec, 1),
            TOTAL_VERTEX_WRITES,
            Math.Round(estTerrainSec, 1),
            FormatDuration(estTerrainSec),
            Math.Round(bulkOpsPerSec, 1),
            TOTAL_LANDBLOCKS,
            estBulkSec.HasValue ? Math.Round(estBulkSec.Value, 1) : null,
            estBulkSec.HasValue ? FormatDuration(estBulkSec.Value) : null,
            Math.Round(objOpsPerSec, 1),
            TOTAL_OBJECT_PLACEMENTS,
            Math.Round(estObjectSec, 1),
            FormatDuration(estObjectSec),
            feasibility);

        // â”€â”€â”€ Restore the touched landblocks so the benchmark is non-destructive â”€â”€â”€
        restored = RestoreBenchmarkSnapshots(terrainDoc, terrainSnapshots, staticObjSnapshots);

        return new BenchmarkResult(tests, memory, gcBefore, gcAfter, extrapolation,
            FailedObjectPlacements: objFailures, LandblocksRestored: restored);

        } finally {
            // Guarantee restoration even if the run threw after mutating landblocks.
            if (!restored)
                RestoreBenchmarkSnapshots(terrainDoc, terrainSnapshots, staticObjSnapshots);
            terrainDoc.BenchmarkMode = false;
        }
    }

    /// <summary>
    /// Restores the terrain entries and static-object lists snapshotted before a
    /// benchmark run, so the speed test leaves the project documents unchanged.
    /// Returns true if every snapshot was restored without error.
    /// </summary>
    private bool RestoreBenchmarkSnapshots(
        TerrainDocument terrainDoc,
        Dictionary<ushort, TerrainEntry[]> terrainSnapshots,
        Dictionary<ushort, List<StaticObject>> staticObjSnapshots) {
        bool ok = true;
        foreach (var kv in terrainSnapshots) {
            try {
                terrainDoc.UpdateLandblockInternal(kv.Key, kv.Value, out _);
            } catch { ok = false; }
        }
        foreach (var kv in staticObjSnapshots) {
            try {
                var lbDoc = GetLandblockDoc(kv.Key);
                lbDoc.ClearStaticObjects();
                foreach (var obj in kv.Value)
                    lbDoc.AddStaticObject(obj);
            } catch { ok = false; }
        }
        return ok;
    }

    private static string FormatDuration(double seconds) {
        if (seconds < 60) return $"{seconds:F1}s";
        if (seconds < 3600) return $"{seconds / 60:F1} min";
        return $"{seconds / 3600:F1} hours";
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Bulk operations
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public SetLandblockHeightmapResult SetLandblockHeightmap(uint lbX, uint lbY, byte[] heights) {
        RequireProject();
        if (heights.Length != 81)
            throw new ArgumentException("heights must contain exactly 81 values.");

        ushort lbKey = LbKey(lbX, lbY);
        var doc = GetTerrainDoc();
        var currentData = doc.GetLandblockInternal(lbKey);
        if (currentData == null)
            throw new InvalidOperationException($"No terrain data for landblock 0x{lbKey:X4}.");

        var newEntries = new TerrainEntry[81];
        int changed = 0;
        for (int i = 0; i < 81; i++) {
            newEntries[i] = currentData[i] with { Height = heights[i] };
            if (currentData[i].Height != heights[i]) changed++;
        }

        if (changed == 0)
            return new SetLandblockHeightmapResult(lbKey, 0, new HashSet<ushort>());

        doc.UpdateLandblockInternal(lbKey, newEntries, out var modifiedLbs);
        return new SetLandblockHeightmapResult(lbKey, changed, modifiedLbs);
    }

    public SetLandblockTerrainResult SetLandblockTerrain(uint lbX, uint lbY, byte[] types) {
        RequireProject();
        if (types.Length != 81)
            throw new ArgumentException("types must contain exactly 81 values.");
        // Valid AC terrain type indices are 0..31 (LandDefs.TerrainType); reject any
        // out-of-range value before writing so a bad call can't poison vertices.
        for (int i = 0; i < types.Length; i++) {
            if (types[i] > 31)
                throw new ArgumentException(
                    $"types[{i}] = {types[i]} is out of range; terrain type must be 0..31.");
        }

        ushort lbKey = LbKey(lbX, lbY);
        var doc = GetTerrainDoc();
        var currentData = doc.GetLandblockInternal(lbKey);
        if (currentData == null)
            throw new InvalidOperationException($"No terrain data for landblock 0x{lbKey:X4}.");

        var newEntries = new TerrainEntry[81];
        int changed = 0;
        for (int i = 0; i < 81; i++) {
            newEntries[i] = currentData[i] with { Type = types[i] };
            if (currentData[i].Type != types[i]) changed++;
        }

        if (changed == 0)
            return new SetLandblockTerrainResult(lbKey, 0, new HashSet<ushort>());

        doc.UpdateLandblockInternal(lbKey, newEntries, out var modifiedLbs);
        return new SetLandblockTerrainResult(lbKey, changed, modifiedLbs);
    }

    public BulkPlaceObjectsResult BulkPlaceObjects(uint lbX, uint lbY,
        List<(uint modelId, float x, float y, float z)> objects) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var lbDoc = GetLandblockDoc(lbKey);
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        int placed = 0;
        int errors = 0;
        var errorMsgs = new List<string>();

        foreach (var (modelId, x, y, z) in objects) {
            try {
                if (!float.IsFinite(x) || !float.IsFinite(y) || !float.IsFinite(z)) {
                    errors++;
                    if (errorMsgs.Count < 10)
                        errorMsgs.Add($"Object 0x{modelId:X8}: non-finite coordinate ({x},{y},{z})");
                    continue;
                }

                // Validate the model type byte (0x01 = GfxObj, 0x02 = Setup) and that
                // the model actually exists in the loaded DAT — same contract as add-object.
                byte typeByte = (byte)((modelId >> 24) & 0xFF);
                bool isSetup = typeByte == 0x02;
                if (typeByte != 0x01 && typeByte != 0x02) {
                    errors++;
                    if (errorMsgs.Count < 10)
                        errorMsgs.Add($"Object 0x{modelId:X8}: type byte 0x{typeByte:X2} is not a GfxObj (0x01) or Setup (0x02).");
                    continue;
                }
                bool exists = isSetup
                    ? dats.TryGet<Setup>(modelId, out _)
                    : dats.TryGet<GfxObj>(modelId, out _);
                if (!exists) {
                    errors++;
                    if (errorMsgs.Count < 10)
                        errorMsgs.Add($"Object 0x{modelId:X8} is not a {(isSetup ? "Setup" : "GfxObj")} in the loaded DAT.");
                    continue;
                }

                // Validate the (world-frame) x/y are inside this landblock's 192m square.
                try {
                    ValidateLbLocalCoord(lbX, lbY, x, y, "bulk-place-objects");
                } catch (ArgumentException vex) {
                    errors++;
                    if (errorMsgs.Count < 10)
                        errorMsgs.Add(vex.Message);
                    continue;
                }

                var obj = new StaticObject {
                    Id = modelId,
                    IsSetup = isSetup,
                    Origin = new Vector3(x, y, z),
                    Orientation = Quaternion.Identity,
                    Scale = Vector3.One
                };
                lbDoc.AddStaticObject(obj);
                placed++;
            } catch (Exception ex) {
                errors++;
                if (errorMsgs.Count < 10)
                    errorMsgs.Add($"Object 0x{modelId:X8} at ({x},{y},{z}): {ex.Message}");
            }
        }

        // When messages were truncated at 10, append a marker so callers know.
        if (errors > 10 && errorMsgs.Count == 10)
            errorMsgs.Add($"(+{errors - 10} more)");

        return new BulkPlaceObjectsResult(lbKey, placed, errors,
            errorMsgs.Count > 0 ? errorMsgs : null);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Phase 10 â€” Landblock Pattern Analysis
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// <summary>
    /// Analyzes spatial design patterns from populated vanilla landblocks.
    /// Extracts: adjacency frequencies, terrain slope, building orientation,
    /// object clustering, and ontology cross-references.
    /// </summary>
    public AnalyzeLandblockPatternsResult AnalyzeLandblockPatterns(
        uint minX = 0, uint minY = 0, uint maxX = 254, uint maxY = 254,
        string? outputPath = null) {

        RequireProject();
        var sw = new System.Diagnostics.Stopwatch();
        sw.Start();

        var terrainDoc = GetTerrainDoc();
        var ht = GetHeightTable();

        // â”€â”€â”€ Collect all static objects across requested landblocks â”€â”€â”€
        // Store as (lbKey, worldPos, objectId, orientation) tuples
        var allObjects = new List<(ushort LbKey, System.Numerics.Vector3 Pos, uint ObjectId, System.Numerics.Quaternion Orientation)>();
        int landblocksAnalyzed = 0;

        for (uint lbX = minX; lbX <= maxX; lbX++) {
            for (uint lbY = minY; lbY <= maxY; lbY++) {
                ushort lbKey = LbKey(lbX, lbY);
                LandblockDocument lbDoc;
                try { lbDoc = GetLandblockDoc(lbKey); } catch { continue; }

                bool hasObjects = false;
                foreach (var obj in lbDoc.GetStaticObjects()) {
                    hasObjects = true;
                    allObjects.Add((lbKey, obj.Origin, obj.Id, obj.Orientation));
                }
                if (!hasObjects) continue;
                landblocksAnalyzed++;
            }

            if ((lbX - minX) % 50 == 0 && lbX > minX)
                Console.Error.WriteLine($"[AnalyzeLandblockPatterns] ...row {lbX}/{maxX}, {allObjects.Count} objects so far");
        }

        int totalObjects = allObjects.Count;
        Console.Error.WriteLine($"[AnalyzeLandblockPatterns] Found {totalObjects} objects across {landblocksAnalyzed} populated landblocks");

        if (totalObjects == 0) {
            sw.Stop();
            return new AnalyzeLandblockPatternsResult(true, landblocksAnalyzed, 0,
                new List<AdjacencyPair>(),
                new SlopeDistribution(0, 0, 0, 0),
                new ClusterSummary(0, 0, 0),
                new OrientationBias(0, 0, 0, 0, null),
                Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath);
        }

        // â”€â”€â”€ 1. Object adjacency frequencies â”€â”€â”€
        Console.Error.WriteLine("[AnalyzeLandblockPatterns] Computing adjacency frequencies...");
        // Key: (min(idA,idB), max(idA,idB))  Value: (count5, count10, count25, totalDist, totalCount)
        var adjacency = new Dictionary<(uint, uint), (int c5, int c10, int c25, double totalDist, int totalCount)>();

        // Use spatial bucketing to avoid O(NÂ²) for the full set
        // Bucket size = 25 units (max radius)
        const float BUCKET_SIZE = 25f;
        var buckets = new Dictionary<(int, int), List<int>>();
        for (int i = 0; i < allObjects.Count; i++) {
            int bx = (int)MathF.Floor(allObjects[i].Pos.X / BUCKET_SIZE);
            int by = (int)MathF.Floor(allObjects[i].Pos.Y / BUCKET_SIZE);
            var key = (bx, by);
            if (!buckets.TryGetValue(key, out var list)) {
                list = new List<int>();
                buckets[key] = list;
            }
            list.Add(i);
        }

        // Check each object against neighbors in adjacent buckets
        const float MAX_DIST_SQ = 25f * 25f;
        foreach (var (bkey, indices) in buckets) {
            var (bx, by) = bkey;
            foreach (int i in indices) {
                var posA = allObjects[i].Pos;
                var idA = allObjects[i].ObjectId;
                for (int dx = -1; dx <= 1; dx++) {
                    for (int dy = -1; dy <= 1; dy++) {
                        if (!buckets.TryGetValue((bx + dx, by + dy), out var neighborIndices))
                            continue;

                        foreach (int j in neighborIndices) {
                            if (j <= i) continue; // avoid double-counting
                            var posB = allObjects[j].Pos;
                            var idB = allObjects[j].ObjectId;

                            float deltaX = posA.X - posB.X;
                            float deltaY = posA.Y - posB.Y;
                            float distSq = deltaX * deltaX + deltaY * deltaY;
                            if (distSq > MAX_DIST_SQ) continue;

                            float dist = MathF.Sqrt(distSq);
                            var pairKey = idA <= idB ? (idA, idB) : (idB, idA);
                            adjacency.TryGetValue(pairKey, out var cur);

                            int c5 = cur.c5 + (dist <= 5f ? 1 : 0);
                            int c10 = cur.c10 + (dist <= 10f ? 1 : 0);
                            int c25 = cur.c25 + 1;
                            adjacency[pairKey] = (c5, c10, c25, cur.totalDist + dist, cur.totalCount + 1);
                        }
                    }
                }
            }
        }

        // Build top adjacency pairs sorted by count25 descending
        var topAdjacency = adjacency
            .OrderByDescending(kv => kv.Value.c25)
            .Take(100)
            .Select(kv => {
                string nameA = $"0x{kv.Key.Item1:X8}";
                string nameB = $"0x{kv.Key.Item2:X8}";

                // Try ontology lookup for human-readable names
                if (_ontologyService.IsScanned) {
                    var entryA = _ontologyService.GetEntry(kv.Key.Item1);
                    var entryB = _ontologyService.GetEntry(kv.Key.Item2);
                    if (entryA?.Name != null) nameA = $"{entryA.Name} (0x{kv.Key.Item1:X8})";
                    if (entryB?.Name != null) nameB = $"{entryB.Name} (0x{kv.Key.Item2:X8})";
                }

                double avgDist = kv.Value.totalCount > 0 ? kv.Value.totalDist / kv.Value.totalCount : 0;
                return new AdjacencyPair(nameA, nameB, kv.Value.c5, kv.Value.c10, kv.Value.c25,
                    Math.Round(avgDist, 2));
            })
            .ToList();

        Console.Error.WriteLine($"[AnalyzeLandblockPatterns] Found {adjacency.Count} unique adjacency pairs");

        // â”€â”€â”€ 2. Terrain slope under each object â”€â”€â”€
        Console.Error.WriteLine("[AnalyzeLandblockPatterns] Computing terrain slope distribution...");
        int slopeFlat = 0, slopeGentle = 0, slopeModerate = 0, slopeSteep = 0;

        foreach (var (lbKey, pos, _, _) in allObjects) {
            try {
                // Get the vertex for this position
                var vi = _terrainService.WorldToVertex(pos.X, pos.Y);
                if (!vi.HasValue) { slopeFlat++; continue; }

                var data = terrainDoc.GetLandblockInternal(vi.Value.LandblockKey);
                if (data == null) { slopeFlat++; continue; }

                int vIdx = vi.Value.VertexIndex;
                int vx = vIdx / 9;
                int vy = vIdx % 9;
                byte hCenter = data[vIdx].Height;

                // Compute slope as max world-space height delta to any adjacent vertex,
                // resolving byte indices through the region height table.
                float zCenter = ht[hCenter];
                float maxDelta = 0f;
                if (vx > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(zCenter - ht[data[(vx - 1) * 9 + vy].Height]));
                if (vx < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(zCenter - ht[data[(vx + 1) * 9 + vy].Height]));
                if (vy > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(zCenter - ht[data[vx * 9 + (vy - 1)].Height]));
                if (vy < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(zCenter - ht[data[vx * 9 + (vy + 1)].Height]));

                // Each vertex is 24 world units apart; height table maps index to world height
                float heightDeltaWorld = maxDelta;
                float slopeDeg = MathF.Atan2(heightDeltaWorld, 24f) * (180f / MathF.PI);

                if (slopeDeg < 5f) slopeFlat++;
                else if (slopeDeg < 15f) slopeGentle++;
                else if (slopeDeg < 30f) slopeModerate++;
                else slopeSteep++;
            } catch {
                slopeFlat++; // default to flat on error
            }
        }

        var slopeDist = new SlopeDistribution(slopeFlat, slopeGentle, slopeModerate, slopeSteep);
        Console.Error.WriteLine($"[AnalyzeLandblockPatterns] Slope: flat={slopeFlat} gentle={slopeGentle} moderate={slopeModerate} steep={slopeSteep}");

        // â”€â”€â”€ 3. Building orientation conventions â”€â”€â”€
        Console.Error.WriteLine("[AnalyzeLandblockPatterns] Analyzing building orientations...");
        int orientN = 0, orientE = 0, orientS = 0, orientW = 0;

        foreach (var (_, _, objId, orient) in allObjects) {
            // Only analyze building/structure objects (Setup IDs starting with 0x02)
            if ((objId & 0xFF000000) != 0x02000000) continue;

            // Extract yaw angle from quaternion
            // Yaw = atan2(2*(qw*qz + qx*qy), 1 - 2*(qyÂ² + qzÂ²))
            float yaw = MathF.Atan2(
                2f * (orient.W * orient.Z + orient.X * orient.Y),
                1f - 2f * (orient.Y * orient.Y + orient.Z * orient.Z));

            // Normalize to [0, 360)
            float yawDeg = yaw * (180f / MathF.PI);
            if (yawDeg < 0) yawDeg += 360f;

            // Bin into compass quadrants (N=315-45, E=45-135, S=135-225, W=225-315)
            if (yawDeg >= 315f || yawDeg < 45f) orientN++;
            else if (yawDeg < 135f) orientE++;
            else if (yawDeg < 225f) orientS++;
            else orientW++;
        }

        string? dominantDir = null;
        int maxOrient = Math.Max(Math.Max(orientN, orientE), Math.Max(orientS, orientW));
        int totalOrient = orientN + orientE + orientS + orientW;
        if (totalOrient > 0 && maxOrient > totalOrient * 0.35) { // >35% dominance
            if (maxOrient == orientN) dominantDir = "North";
            else if (maxOrient == orientE) dominantDir = "East";
            else if (maxOrient == orientS) dominantDir = "South";
            else dominantDir = "West";
        }

        var orientBias = new OrientationBias(orientN, orientE, orientS, orientW, dominantDir);
        Console.Error.WriteLine($"[AnalyzeLandblockPatterns] Orientation: N={orientN} E={orientE} S={orientS} W={orientW} dominant={dominantDir ?? "none"}");

        // â”€â”€â”€ 4. Object clustering analysis â”€â”€â”€
        Console.Error.WriteLine("[AnalyzeLandblockPatterns] Computing object clusters...");
        const float CLUSTER_RADIUS = 50f;

        // Simple union-find clustering
        int[] parent = new int[allObjects.Count];
        int[] rank = new int[allObjects.Count];
        for (int i = 0; i < allObjects.Count; i++) parent[i] = i;

        int Find(int x) {
            while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        }
        void Union(int a, int b) {
            int ra = Find(a), rb = Find(b);
            if (ra == rb) return;
            if (rank[ra] < rank[rb]) (ra, rb) = (rb, ra);
            parent[rb] = ra;
            if (rank[ra] == rank[rb]) rank[ra]++;
        }

        // Use the same spatial buckets, but with CLUSTER_RADIUS
        const float CLUSTER_BUCKET = 50f;
        var clusterBuckets = new Dictionary<(int, int), List<int>>();
        for (int i = 0; i < allObjects.Count; i++) {
            int cbx = (int)MathF.Floor(allObjects[i].Pos.X / CLUSTER_BUCKET);
            int cby = (int)MathF.Floor(allObjects[i].Pos.Y / CLUSTER_BUCKET);
            var key = (cbx, cby);
            if (!clusterBuckets.TryGetValue(key, out var list)) {
                list = new List<int>();
                clusterBuckets[key] = list;
            }
            list.Add(i);
        }

        foreach (var (bkey, indices) in clusterBuckets) {
            var (cbx, cby) = bkey;
            var neighborIndices = new List<int>();
            for (int dx = -1; dx <= 1; dx++) {
                for (int dy = -1; dy <= 1; dy++) {
                    if (clusterBuckets.TryGetValue((cbx + dx, cby + dy), out var nlist))
                        neighborIndices.AddRange(nlist);
                }
            }

            foreach (int i in indices) {
                var posA = allObjects[i].Pos;
                foreach (int j in neighborIndices) {
                    if (j <= i) continue;
                    var posB = allObjects[j].Pos;
                    float dist = MathF.Sqrt(
                        (posA.X - posB.X) * (posA.X - posB.X) +
                        (posA.Y - posB.Y) * (posA.Y - posB.Y));
                    if (dist <= CLUSTER_RADIUS) Union(i, j);
                }
            }
        }

        // Count cluster sizes
        var clusterCounts = new Dictionary<int, int>();
        for (int i = 0; i < allObjects.Count; i++) {
            int root = Find(i);
            clusterCounts[root] = clusterCounts.GetValueOrDefault(root) + 1;
        }

        int totalClusters = clusterCounts.Count;
        int largestCluster = clusterCounts.Count > 0 ? clusterCounts.Values.Max() : 0;
        double avgClusterSize = totalClusters > 0 ? (double)totalObjects / totalClusters : 0;

        var clusterSummary = new ClusterSummary(totalClusters, Math.Round(avgClusterSize, 2), largestCluster);
        Console.Error.WriteLine($"[AnalyzeLandblockPatterns] Clusters: {totalClusters} total, avg size={avgClusterSize:F1}, largest={largestCluster}");

        // â”€â”€â”€ 5. Ontology cross-reference (if scanned) â”€â”€â”€
        // This enriches the adjacency pairs with ontology data (already done in step 1)
        // Additionally, compute per-category cluster statistics
        Dictionary<string, int>? categoryCounts = null;
        if (_ontologyService.IsScanned) {
            Console.Error.WriteLine("[AnalyzeLandblockPatterns] Cross-referencing with ontology...");
            categoryCounts = new Dictionary<string, int>();
            foreach (var (_, _, objId, _) in allObjects) {
                var entry = _ontologyService.GetEntry(objId);
                string cat = entry?.Category ?? "Unknown";
                categoryCounts[cat] = categoryCounts.GetValueOrDefault(cat) + 1;
            }
        }

        sw.Stop();
        double elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Console.Error.WriteLine($"[AnalyzeLandblockPatterns] Complete in {elapsedMs}ms");

        // â”€â”€â”€ Write JSON output if path specified â”€â”€â”€
        if (!string.IsNullOrEmpty(outputPath)) {
            try {
                var outputData = new {
                    landblocksAnalyzed,
                    totalObjectsAnalyzed = totalObjects,
                    elapsedMs,
                    adjacencyPairs = topAdjacency.Select(a => new {
                        objectA = a.ObjectA, objectB = a.ObjectB,
                        count5 = a.Count5, count10 = a.Count10, count25 = a.Count25,
                        avgDistance = a.AvgDistance
                    }).ToArray(),
                    slopeDistribution = new {
                        flat = slopeDist.Flat, gentle = slopeDist.Gentle,
                        moderate = slopeDist.Moderate, steep = slopeDist.Steep
                    },
                    clusterSummary = new {
                        totalClusters = clusterSummary.TotalClusters,
                        avgClusterSize = clusterSummary.AvgClusterSize,
                        largestCluster = clusterSummary.LargestCluster
                    },
                    orientationBias = new {
                        north = orientBias.North, east = orientBias.East,
                        south = orientBias.South, west = orientBias.West,
                        dominantDirection = orientBias.DominantDirection
                    },
                    categoryCounts
                };

                var json = System.Text.Json.JsonSerializer.Serialize(outputData,
                    WorldBuilder.Shared.Lib.JsonOpts.CamelCaseIndented);
                File.WriteAllText(outputPath, json);
                Console.Error.WriteLine($"[AnalyzeLandblockPatterns] Results saved to: {outputPath}");
            } catch (Exception ex) {
                Console.Error.WriteLine($"[AnalyzeLandblockPatterns] Warning: failed to write output file: {ex.Message}");
            }
        }

        return new AnalyzeLandblockPatternsResult(
            Success: true,
            LandblocksAnalyzed: landblocksAnalyzed,
            TotalObjectsAnalyzed: totalObjects,
            TopAdjacencyPairs: topAdjacency,
            SlopeDistribution: slopeDist,
            ClusterSummary: clusterSummary,
            OrientationBias: orientBias,
            ElapsedMs: elapsedMs,
            OutputPath: outputPath);
    }

    /// <summary>
    /// Mines building pairings from retail co-occurrence data: walks every
    /// landblock, finds Structure-classified Setups within 5 m of each
    /// other, and records the pair when the encounter count meets the
    /// threshold. Writes <c>building_pairings.json</c> in the project dir
    /// (or the given path) and loads it into the live registry.
    /// </summary>
    public ExtractBuildingPairingsResult ExtractBuildingPairings(
        int minCount5 = 3, string? outputPath = null) {
        RequireProject();
        if (!_ontologyService.IsScanned) {
            return new ExtractBuildingPairingsResult(false, 0, 0, 0,
                Error: "Ontology not scanned. Run scan-ontology first.");
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var terrainDoc = GetTerrainDoc();
        // Collect Structure positions across the world.
        var structures = new List<(ushort lb, System.Numerics.Vector3 pos, uint id)>();
        for (uint lbX = 0; lbX <= 254; lbX++) {
            for (uint lbY = 0; lbY <= 254; lbY++) {
                ushort lbKey = LbKey(lbX, lbY);
                LandblockDocument lbDoc;
                try { lbDoc = GetLandblockDoc(lbKey); } catch { continue; }
                foreach (var obj in lbDoc.GetStaticObjects()) {
                    var entry = _ontologyService.GetEntry(obj.Id);
                    if (entry?.Category == "Structure") {
                        structures.Add((lbKey, obj.Origin, obj.Id));
                    }
                }
            }
        }

        // Spatial bucket (5 m) and count pair encounters at ≤ 5 m.
        const float pairRadius = 5f;
        var buckets = new Dictionary<(int, int), List<int>>();
        for (int i = 0; i < structures.Count; i++) {
            int bx = (int)MathF.Floor(structures[i].pos.X / pairRadius);
            int by = (int)MathF.Floor(structures[i].pos.Y / pairRadius);
            var key = (bx, by);
            if (!buckets.TryGetValue(key, out var list)) { list = new(); buckets[key] = list; }
            list.Add(i);
        }

        var pairCounts = new Dictionary<(uint, uint), int>();
        float r2 = pairRadius * pairRadius;
        foreach (var (bkey, indices) in buckets) {
            // Iterate the full 3x3 neighborhood and rely on the global j<=i dedup
            // (matching the cluster-detection pattern). A half-plane offset set
            // combined with j<=i drops ~half of all cross-bucket adjacencies.
            for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) {
                if (!buckets.TryGetValue((bkey.Item1 + dx, bkey.Item2 + dy), out var nbrs)) continue;
                foreach (int i in indices) foreach (int j in nbrs) {
                    if (j <= i) continue;
                    var pi = structures[i].pos; var pj = structures[j].pos;
                    if ((pi - pj).LengthSquared() > r2) continue;
                    uint a = structures[i].id, b = structures[j].id;
                    if (a == b) continue;
                    var k = a < b ? (a, b) : (b, a);
                    pairCounts.TryGetValue(k, out int c);
                    pairCounts[k] = c + 1;
                }
            }
        }

        var registry = new WorldBuilder.Shared.Lib.Pairings.BuildingPairings();
        int pairsKept = 0;
        foreach (var (k, c) in pairCounts) {
            if (c >= minCount5) {
                registry.AddPair(k.Item1, k.Item2);
                pairsKept++;
            }
        }

        outputPath ??= Path.Combine(_projectManager.CurrentProject!.ProjectDirectory, "building_pairings.json");
        registry.SaveToJsonFile(outputPath, minCount5);
        _buildingPairings = registry;

        sw.Stop();
        return new ExtractBuildingPairingsResult(
            Success: true,
            StructuresScanned: structures.Count,
            PairsKept: pairsKept,
            GroupCount: registry.GroupCount,
            OutputPath: outputPath,
            ElapsedMs: sw.ElapsedMilliseconds);
    }

    /// <summary>
    /// Loads <c>building_pairings.json</c> from disk into the live registry.
    /// Used to restore a pairing dataset without re-running extraction.
    /// </summary>
    public LoadBuildingPairingsResult LoadBuildingPairings(string path) {
        RequireProject();
        if (!File.Exists(path)) {
            return new LoadBuildingPairingsResult(false, 0, 0, Error: $"File not found: {path}");
        }
        try {
            _buildingPairings = WorldBuilder.Shared.Lib.Pairings.BuildingPairings.LoadFromJsonFile(path);
        } catch (Exception ex) {
            _buildingPairings = new WorldBuilder.Shared.Lib.Pairings.BuildingPairings();
            return new LoadBuildingPairingsResult(false, 0, 0, Error: $"Failed to parse {path}: {ex.Message}");
        }
        return new LoadBuildingPairingsResult(true,
            _buildingPairings.EdgeCount, _buildingPairings.GroupCount);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Phase 10 â€” Export Training Data
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// <summary>
    /// Exports placement examples as JSON-lines, one per line,
    /// with full context for each placed object. Each line is a
    /// self-contained training example for the constraint-based
    /// settlement generator.
    /// </summary>
    public ExportTrainingDataResult ExportTrainingData(
        uint minX = 0, uint minY = 0, uint maxX = 254, uint maxY = 254,
        string? outputPath = null, int nearbyLimit = 5) {

        RequireProject();
        var sw = new System.Diagnostics.Stopwatch();
        sw.Start();

        if (string.IsNullOrEmpty(outputPath))
            outputPath = "training_data.jsonl";

        var terrainDoc = GetTerrainDoc();
        var ht = GetHeightTable();
        bool ontologyScanned = _ontologyService.IsScanned;

        // â”€â”€â”€ Pass 1: Collect all static objects across requested landblocks â”€â”€â”€
        var allObjects = new List<(ushort LbKey, System.Numerics.Vector3 Pos, uint ObjectId,
            System.Numerics.Quaternion Orientation, System.Numerics.Vector3 Scale)>();
        int landblocksProcessed = 0;

        for (uint lbX = minX; lbX <= maxX; lbX++) {
            for (uint lbY = minY; lbY <= maxY; lbY++) {
                ushort lbKey = LbKey(lbX, lbY);
                LandblockDocument lbDoc;
                try { lbDoc = GetLandblockDoc(lbKey); } catch { continue; }

                bool hasObjects = false;
                foreach (var obj in lbDoc.GetStaticObjects()) {
                    hasObjects = true;
                    allObjects.Add((lbKey, obj.Origin, obj.Id, obj.Orientation, obj.Scale));
                }
                if (!hasObjects) continue;
                landblocksProcessed++;
            }

            if ((lbX - minX) % 50 == 0 && lbX > minX)
                Console.Error.WriteLine($"[ExportTrainingData] ...row {lbX}/{maxX}, {allObjects.Count} objects so far");
        }

        int totalObjects = allObjects.Count;
        Console.Error.WriteLine($"[ExportTrainingData] Found {totalObjects} objects across {landblocksProcessed} populated landblocks");

        if (totalObjects == 0) {
            sw.Stop();
            return new ExportTrainingDataResult(true, 0, landblocksProcessed, 0,
                Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath);
        }

        // â”€â”€â”€ Build spatial buckets for fast nearby-object lookup (reuse pattern from AnalyzeLandblockPatterns) â”€â”€â”€
        const float BUCKET_SIZE = 25f;
        var buckets = new Dictionary<(int, int), List<int>>();
        for (int i = 0; i < allObjects.Count; i++) {
            int bx = (int)MathF.Floor(allObjects[i].Pos.X / BUCKET_SIZE);
            int by = (int)MathF.Floor(allObjects[i].Pos.Y / BUCKET_SIZE);
            var key = (bx, by);
            if (!buckets.TryGetValue(key, out var list)) {
                list = new List<int>();
                buckets[key] = list;
            }
            list.Add(i);
        }

        // â”€â”€â”€ Pass 2: Write one JSON line per object â”€â”€â”€
        int exported = 0;
        int withOntology = 0;
        var categoryCache = ontologyScanned ? new Dictionary<uint, string?>() : null;

        try {
            using var writer = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);

            for (int idx = 0; idx < allObjects.Count; idx++) {
                var (lbKey, pos, objectId, orientation, scale) = allObjects[idx];

                try {
                    // â”€â”€ Object identity â”€â”€
                    string objectIdHex = $"0x{objectId:X8}";
                    string? name = null;
                    string? category = null;
                    string? scaleLabel = null;
                    List<string>? tags = null;

                    // Ontology data
                    int? weenieType = null;
                    int? weenieClassId = null;
                    int? creatureType = null;
                    string? difficultyTier = null;
                    int? level = null;

                    if (ontologyScanned) {
                        var entry = _ontologyService.GetEntry(objectId);
                        if (entry != null) {
                            name = entry.Name;
                            category = entry.Category;
                            scaleLabel = entry.Scale;
                            tags = entry.Tags.Length > 0 ? entry.Tags.ToList() : null;
                            weenieType = entry.WeenieType;
                            weenieClassId = entry.WeenieClassId;
                            creatureType = entry.CreatureType;
                            difficultyTier = entry.DifficultyTier;
                            level = entry.Level;
                            if (name != null || weenieType != null)
                                withOntology++;
                        }
                    }

                    // â”€â”€ Terrain context â”€â”€
                    int? terrainTypeIdx = null;
                    int? heightIndex = null;
                    int? road = null;
                    double slopeDeg = 0;

                    try {
                        var vi = _terrainService.WorldToVertex(pos.X, pos.Y);
                        if (vi.HasValue) {
                            var data = terrainDoc.GetLandblockInternal(vi.Value.LandblockKey);
                            if (data != null) {
                                int vIdx = vi.Value.VertexIndex;
                                int vx = vIdx / 9;
                                int vy = vIdx % 9;

                                terrainTypeIdx = data[vIdx].Type;
                                heightIndex = data[vIdx].Height;
                                road = data[vIdx].Road;

                                // Compute slope (reuse pattern from AnalyzeLandblockPatterns)
                                byte hCenter = data[vIdx].Height;
                                float zCenter = ht[hCenter];
                                float maxDelta = 0f;
                                if (vx > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(zCenter - ht[data[(vx - 1) * 9 + vy].Height]));
                                if (vx < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(zCenter - ht[data[(vx + 1) * 9 + vy].Height]));
                                if (vy > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(zCenter - ht[data[vx * 9 + (vy - 1)].Height]));
                                if (vy < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(zCenter - ht[data[vx * 9 + (vy + 1)].Height]));

                                float heightDeltaWorld = maxDelta;
                                slopeDeg = Math.Round(MathF.Atan2(heightDeltaWorld, 24f) * (180f / MathF.PI), 1);
                            }
                        }
                    } catch { /* terrain lookup failure is non-fatal */ }

                    // â”€â”€ Orientation â”€â”€
                    float yaw = MathF.Atan2(
                        2f * (orientation.W * orientation.Z + orientation.X * orientation.Y),
                        1f - 2f * (orientation.Y * orientation.Y + orientation.Z * orientation.Z));
                    float yawDeg = yaw * (180f / MathF.PI);
                    if (yawDeg < 0) yawDeg += 360f;

                    // â”€â”€ Nearby objects (within 25 units) â”€â”€
                    int bxCenter = (int)MathF.Floor(pos.X / BUCKET_SIZE);
                    int byCenter = (int)MathF.Floor(pos.Y / BUCKET_SIZE);

                    var nearbyList = new List<(float dist, uint nearId, string? nearCat)>();
                    const float maxNearbyDistSq = 25f * 25f;
                    for (int dx = -1; dx <= 1; dx++) {
                        for (int dy = -1; dy <= 1; dy++) {
                            if (!buckets.TryGetValue((bxCenter + dx, byCenter + dy), out var nlist))
                                continue;
                            foreach (int j in nlist) {
                                if (j == idx) continue;
                                var posB = allObjects[j].Pos;
                                float deltaX = pos.X - posB.X;
                                float deltaY = pos.Y - posB.Y;
                                float distSq = deltaX * deltaX + deltaY * deltaY;
                                if (distSq > maxNearbyDistSq) continue;
                                float dist = MathF.Sqrt(distSq);

                                string? nearCat = null;
                                if (ontologyScanned) {
                                    uint nearId = allObjects[j].ObjectId;
                                    if (!categoryCache!.TryGetValue(nearId, out nearCat)) {
                                        nearCat = _ontologyService.GetEntry(nearId)?.Category;
                                        categoryCache[nearId] = nearCat;
                                    }
                                }
                                nearbyList.Add((dist, allObjects[j].ObjectId, nearCat));
                            }
                        }
                    }

                    // Sort by distance, take top N
                    var nearby = nearbyList
                        .OrderBy(n => n.dist)
                        .Take(nearbyLimit)
                        .Select(n => new {
                            objectId = $"0x{n.nearId:X8}",
                            distance = Math.Round(n.dist, 1),
                            category = n.nearCat
                        })
                        .ToArray();

                    // â”€â”€ Build JSON line â”€â”€
                    var line = new {
                        objectId = objectIdHex,
                        name,
                        category,
                        scale = scaleLabel,
                        x = Math.Round(pos.X, 1),
                        y = Math.Round(pos.Y, 1),
                        z = Math.Round(pos.Z, 1),
                        lbKey = $"0x{lbKey:X4}",
                        terrainType = terrainTypeIdx,
                        heightIndex,
                        road,
                        slopeDeg,
                        yawDeg = Math.Round(yawDeg, 1),
                        qw = Math.Round(orientation.W, 4),
                        qx = Math.Round(orientation.X, 4),
                        qy = Math.Round(orientation.Y, 4),
                        qz = Math.Round(orientation.Z, 4),
                        nearby = nearby.Length > 0 ? nearby : null,
                        weenieClassId,
                        weenieType,
                        creatureType,
                        difficultyTier,
                        level,
                        tags
                    };

                    writer.WriteLine(System.Text.Json.JsonSerializer.Serialize(line, WorldBuilder.Shared.Lib.JsonOpts.CamelCaseCompactIgnoreNull));
                    exported++;
                } catch (Exception ex) {
                    Console.Error.WriteLine($"[ExportTrainingData] Warning: skipped object 0x{objectId:X8}: {ex.Message}");
                }

                if (exported > 0 && exported % 5000 == 0)
                    Console.Error.WriteLine($"[ExportTrainingData] ...{exported}/{totalObjects} exported");
            }
        } catch (Exception ex) {
            sw.Stop();
            return new ExportTrainingDataResult(false, exported, landblocksProcessed, withOntology,
                Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath, ex.Message);
        }

        sw.Stop();
        double elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Console.Error.WriteLine($"[ExportTrainingData] Complete: {exported} examples exported in {elapsedMs}ms â†’ {outputPath}");

        return new ExportTrainingDataResult(true, exported, landblocksProcessed, withOntology,
            elapsedMs, outputPath);
    }

    private sealed class EnvCellComponentAnchorInfo {
        public required string SourceTable { get; init; }
        public required int SourceIndex { get; init; }
        public required uint ClassId { get; init; }
        public required Vector3 LocalPosition { get; init; }
        public required Quaternion Orientation { get; init; }
        public required ushort[] EntryCellIds { get; init; }
    }

    private static double ComputeYawDeg(Quaternion orientation) {
        var q = Quaternion.Normalize(orientation);
        var sinyCosp = 2.0 * (q.W * q.Z + q.X * q.Y);
        var cosyCosp = 1.0 - 2.0 * (q.Y * q.Y + q.Z * q.Z);
        return Math.Round(Math.Atan2(sinyCosp, cosyCosp) * (180.0 / Math.PI), 3);
    }

    private static bool TryBuildModelLocalBounds(
        IDatReaderWriter dats,
        uint modelId,
        out Vector3 min,
        out Vector3 max) {
        min = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
        max = new Vector3(float.MinValue, float.MinValue, float.MinValue);
        bool anyVertex = false;

        if ((modelId & 0xFF000000) == 0x02000000 && dats.TryGet<Setup>(modelId, out var setup)) {
            int partCount = setup.Parts?.Count ?? 0;
            for (int i = 0; i < partCount; i++) {
                uint partId = setup.Parts![i];
                if (!dats.TryGet<GfxObj>(partId, out var gfx) || gfx.VertexArray?.Vertices == null)
                    continue;

                Vector3 partOffset = Vector3.Zero;
                if (setup.PlacementFrames != null && setup.PlacementFrames.Count > 0) {
                    var placement = setup.PlacementFrames.Values.FirstOrDefault();
                    if (placement?.Frames != null && i < placement.Frames.Count)
                        partOffset = placement.Frames[i].Origin;
                }

                foreach (var vertex in gfx.VertexArray.Vertices.Values) {
                    var p = vertex.Origin + partOffset;
                    min = Vector3.Min(min, p);
                    max = Vector3.Max(max, p);
                    anyVertex = true;
                }
            }
        } else if ((modelId & 0xFF000000) == 0x01000000 &&
                   dats.TryGet<GfxObj>(modelId, out var singleGfx) &&
                   singleGfx.VertexArray?.Vertices != null) {
            foreach (var vertex in singleGfx.VertexArray.Vertices.Values) {
                var p = vertex.Origin;
                min = Vector3.Min(min, p);
                max = Vector3.Max(max, p);
                anyVertex = true;
            }
        }

        if (!anyVertex) {
            min = Vector3.Zero;
            max = Vector3.Zero;
            return false;
        }

        return true;
    }

    private static object[]? BuildSupportSurfaceHints(Vector3 boundsMin, Vector3 boundsMax) {
        float width = MathF.Max(0f, boundsMax.X - boundsMin.X);
        float depth = MathF.Max(0f, boundsMax.Y - boundsMin.Y);
        float height = MathF.Max(0f, boundsMax.Z - boundsMin.Z);
        if (width < 0.25f || depth < 0.2f || height < 0.2f)
            return null;

        string supportClass = "unknown_support";
        double confidence = 0.42;
        if (height >= 1.05f && MathF.Max(width, depth) >= 0.45f) {
            supportClass = "shelf_like";
            confidence = 0.58;
        } else if (height >= 0.45f && height <= 1.25f && width >= 0.35f && depth >= 0.2f) {
            supportClass = "table_like";
            confidence = 0.62;
        } else if (height >= 0.2f && height <= 0.85f && width >= 1.1f && depth >= 0.45f) {
            supportClass = "bed_like";
            confidence = 0.54;
        }

        return new object[] {
            new {
                surfaceClass = "top_plane",
                supportClass,
                originLocal = new {
                    x = Math.Round((boundsMin.X + boundsMax.X) * 0.5f, 3),
                    y = Math.Round((boundsMin.Y + boundsMax.Y) * 0.5f, 3),
                    z = Math.Round(boundsMax.Z, 3)
                },
                normalLocal = new { x = 0.0, y = 0.0, z = 1.0 },
                extentLocal = new {
                    x = Math.Round(width * 0.5f, 3),
                    y = Math.Round(depth * 0.5f, 3)
                },
                confidence,
                inferenceMode = "model_bounds_top_plane"
            }
        };
    }

    private static ushort[] CollectAnchorEntryCellIds(BuildingInfo building) {
        var entryCellIds = new HashSet<ushort>();
        foreach (var portal in building.Portals) {
            if (portal.OtherCellId >= 0x0100 && portal.OtherCellId <= 0xFFFD)
                entryCellIds.Add(portal.OtherCellId);

            foreach (var stab in portal.StabList) {
                if (stab >= 0x0100 && stab <= 0xFFFD)
                    entryCellIds.Add(stab);
            }
        }

        return entryCellIds.OrderBy(v => v).ToArray();
    }

    private static HashSet<ushort> CollectConnectedEnvCellComponent(
        ushort startCellId,
        IReadOnlyDictionary<ushort, EnvCell> envCells,
        HashSet<ushort>? allowedCellIds = null) {
        var component = new HashSet<ushort>();
        var toVisit = new Queue<ushort>();

        component.Add(startCellId);
        toVisit.Enqueue(startCellId);

        while (toVisit.Count > 0) {
            var cellId = toVisit.Dequeue();
            if (!envCells.TryGetValue(cellId, out var envCell))
                continue;

            foreach (var portal in envCell.CellPortals) {
                ushort other = portal.OtherCellId;
                if (other < 0x0100 || other > 0xFFFD)
                    continue;
                if (!envCells.ContainsKey(other))
                    continue;
                if (allowedCellIds != null && !allowedCellIds.Contains(other))
                    continue;
                if (component.Add(other))
                    toVisit.Enqueue(other);
            }
        }

        return component;
    }

    private static object BuildEnvCellComponentJson(
        IDatReaderWriter dats,
        ushort lbKey,
        string componentKind,
        ulong componentId,
        IReadOnlyDictionary<ushort, EnvCell> envCells,
        IReadOnlyCollection<ushort> componentCellIds,
        EnvCellComponentAnchorInfo? anchor = null) {
        float lbWorldX = (lbKey >> 8) * 192f;
        float lbWorldY = (lbKey & 0xFF) * 192f;
        Vector3? anchorLocal = anchor?.LocalPosition;

        var sortedCellIds = componentCellIds.OrderBy(v => v).ToArray();
        var componentStaticObjects = new List<object>();
        float minX = float.PositiveInfinity, minY = float.PositiveInfinity, minZ = float.PositiveInfinity;
        float maxX = float.NegativeInfinity, maxY = float.NegativeInfinity, maxZ = float.NegativeInfinity;

        var cells = new List<object>(sortedCellIds.Length);
        foreach (var cellId in sortedCellIds) {
            if (!envCells.TryGetValue(cellId, out var envCell))
                continue;

            var cellOrigin = envCell.Position.Origin;
            minX = MathF.Min(minX, cellOrigin.X);
            minY = MathF.Min(minY, cellOrigin.Y);
            minZ = MathF.Min(minZ, cellOrigin.Z);
            maxX = MathF.Max(maxX, cellOrigin.X);
            maxY = MathF.Max(maxY, cellOrigin.Y);
            maxZ = MathF.Max(maxZ, cellOrigin.Z);

            var staticObjects = envCell.StaticObjects.Select(stab => {
                var local = stab.Frame.Origin;
                var localOrientation = Quaternion.Normalize(stab.Frame.Orientation);
                var hasBounds = TryBuildModelLocalBounds(dats, stab.Id, out var boundsMin, out var boundsMax);
                var supportSurfaceHints = hasBounds ? BuildSupportSurfaceHints(boundsMin, boundsMax) : null;
                minX = MathF.Min(minX, local.X);
                minY = MathF.Min(minY, local.Y);
                minZ = MathF.Min(minZ, local.Z);
                maxX = MathF.Max(maxX, local.X);
                maxY = MathF.Max(maxY, local.Y);
                maxZ = MathF.Max(maxZ, local.Z);

                var obj = new {
                    classId = stab.Id,
                    classIdSpace = "model_id",
                    x = Math.Round(local.X, 3),
                    y = Math.Round(local.Y, 3),
                    z = Math.Round(local.Z, 3),
                    worldX = Math.Round(lbWorldX + local.X, 3),
                    worldY = Math.Round(lbWorldY + local.Y, 3),
                    worldZ = Math.Round(local.Z, 3),
                    qw = Math.Round(localOrientation.W, 6),
                    qx = Math.Round(localOrientation.X, 6),
                    qy = Math.Round(localOrientation.Y, 6),
                    qz = Math.Round(localOrientation.Z, 6),
                    yawDeg = ComputeYawDeg(localOrientation),
                    relX = anchorLocal.HasValue ? (double?)Math.Round(local.X - anchorLocal.Value.X, 3) : null,
                    relY = anchorLocal.HasValue ? (double?)Math.Round(local.Y - anchorLocal.Value.Y, 3) : null,
                    relZ = anchorLocal.HasValue ? (double?)Math.Round(local.Z - anchorLocal.Value.Z, 3) : null,
                    aabbLocal = hasBounds ? new {
                        minX = Math.Round(boundsMin.X, 3),
                        minY = Math.Round(boundsMin.Y, 3),
                        minZ = Math.Round(boundsMin.Z, 3),
                        maxX = Math.Round(boundsMax.X, 3),
                        maxY = Math.Round(boundsMax.Y, 3),
                        maxZ = Math.Round(boundsMax.Z, 3)
                    } : null,
                    supportSurfaceHints
                };
                componentStaticObjects.Add(obj);
                return obj;
            }).ToArray();

            cells.Add(new {
                cellId = $"0x{lbKey:X4}{cellId:X4}",
                cellNumber = $"0x{cellId:X4}",
                environmentId = $"0x{envCell.EnvironmentId:X4}",
                cellStructure = envCell.CellStructure,
                x = Math.Round(cellOrigin.X, 3),
                y = Math.Round(cellOrigin.Y, 3),
                z = Math.Round(cellOrigin.Z, 3),
                worldX = Math.Round(lbWorldX + cellOrigin.X, 3),
                worldY = Math.Round(lbWorldY + cellOrigin.Y, 3),
                worldZ = Math.Round(cellOrigin.Z, 3),
                relX = anchorLocal.HasValue ? (double?)Math.Round(cellOrigin.X - anchorLocal.Value.X, 3) : null,
                relY = anchorLocal.HasValue ? (double?)Math.Round(cellOrigin.Y - anchorLocal.Value.Y, 3) : null,
                relZ = anchorLocal.HasValue ? (double?)Math.Round(cellOrigin.Z - anchorLocal.Value.Z, 3) : null,
                qw = Math.Round(envCell.Position.Orientation.W, 6),
                qx = Math.Round(envCell.Position.Orientation.X, 6),
                qy = Math.Round(envCell.Position.Orientation.Y, 6),
                qz = Math.Round(envCell.Position.Orientation.Z, 6),
                portalRefs = envCell.CellPortals.Select(p => new {
                    otherCellId = $"0x{p.OtherCellId:X4}",
                    polygonId = p.PolygonId,
                    otherPortalId = p.OtherPortalId,
                    flags = (ushort)p.Flags
                }).ToArray(),
                visibleCellRefs = envCell.VisibleCells.Select(v => $"0x{v:X4}").ToArray(),
                staticObjectCount = staticObjects.Length,
                staticObjects
            });
        }

        object? anchorJson = null;
        if (anchor != null) {
            anchorJson = new {
                sourceTable = anchor.SourceTable,
                sourceIndex = anchor.SourceIndex,
                classId = anchor.ClassId,
                classIdSpace = "model_id",
                x = Math.Round(anchor.LocalPosition.X, 3),
                y = Math.Round(anchor.LocalPosition.Y, 3),
                z = Math.Round(anchor.LocalPosition.Z, 3),
                worldX = Math.Round(lbWorldX + anchor.LocalPosition.X, 3),
                worldY = Math.Round(lbWorldY + anchor.LocalPosition.Y, 3),
                worldZ = Math.Round(anchor.LocalPosition.Z, 3),
                qw = Math.Round(anchor.Orientation.W, 6),
                qx = Math.Round(anchor.Orientation.X, 6),
                qy = Math.Round(anchor.Orientation.Y, 6),
                qz = Math.Round(anchor.Orientation.Z, 6),
                entryCellIds = anchor.EntryCellIds.Select(v => $"0x{v:X4}").ToArray()
            };
        }

        if (!float.IsFinite(minX)) {
            minX = minY = minZ = maxX = maxY = maxZ = 0f;
        }

        return new {
            componentKind,
            componentId,
            landblockId = $"0x{lbKey:X4}",
            landblockX = lbKey >> 8,
            landblockY = lbKey & 0xFF,
            anchor = anchorJson,
            cellCount = sortedCellIds.Length,
            cellIds = sortedCellIds.Select(v => $"0x{v:X4}").ToArray(),
            staticObjectCount = componentStaticObjects.Count,
            boundsLocal = new {
                minX = Math.Round(minX, 3),
                minY = Math.Round(minY, 3),
                minZ = Math.Round(minZ, 3),
                maxX = Math.Round(maxX, 3),
                maxY = Math.Round(maxY, 3),
                maxZ = Math.Round(maxZ, 3)
            },
            cells
        };
    }

    public ExportEnvCellComponentsResult ExportEnvCellComponents(
        uint minX = 0, uint minY = 0, uint maxX = 254, uint maxY = 254,
        string? outputPath = null) {

        RequireProject();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        if (string.IsNullOrWhiteSpace(outputPath))
            outputPath = "envcell_components.jsonl";

        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        int anchoredCount = 0;
        int unanchoredCount = 0;
        int totalExported = 0;
        int landblocksProcessed = 0;

        try {
            using var writer = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);
            for (uint lbX = minX; lbX <= maxX; lbX++) {
                for (uint lbY = minY; lbY <= maxY; lbY++) {
                    ushort lbKey = LbKey(lbX, lbY);
                    landblocksProcessed++;
                    uint lbiId = ((uint)lbKey << 16) | 0xFFFE;

                    if (!dats.TryGet<LandBlockInfo>(lbiId, out var lbi) || lbi.NumCells == 0)
                        continue;

                    var envCells = new Dictionary<ushort, EnvCell>();
                    for (uint i = 0; i < lbi.NumCells; i++) {
                        ushort cellNum = (ushort)(0x0100 + i);
                        uint fullCellId = ((uint)lbKey << 16) | cellNum;
                        if (dats.TryGet<EnvCell>(fullCellId, out var envCell))
                            envCells[cellNum] = envCell;
                    }

                    if (envCells.Count == 0)
                        continue;

                    var claimedCellIds = new HashSet<ushort>();
                    for (int buildingIndex = 0; buildingIndex < lbi.Buildings.Count; buildingIndex++) {
                        var building = lbi.Buildings[buildingIndex];
                        var componentCellIds = CollectBuildingCellIdsExternal(building, dats, lbKey)
                            .Where(envCells.ContainsKey)
                            .OrderBy(v => v)
                            .ToArray();

                        if (componentCellIds.Length == 0)
                            continue;

                        foreach (var cellId in componentCellIds)
                            claimedCellIds.Add(cellId);

                        var anchor = new EnvCellComponentAnchorInfo {
                            SourceTable = "landblock_info_building",
                            SourceIndex = buildingIndex,
                            ClassId = building.ModelId,
                            LocalPosition = building.Frame.Origin,
                            Orientation = building.Frame.Orientation,
                            EntryCellIds = CollectAnchorEntryCellIds(building)
                        };

                        ulong componentId = ((ulong)lbKey << 32) | (uint)buildingIndex;
                        writer.WriteLine(System.Text.Json.JsonSerializer.Serialize(
                            BuildEnvCellComponentJson(dats, lbKey, "surface_anchor_component", componentId, envCells, componentCellIds, anchor),
                            WorldBuilder.Shared.Lib.JsonOpts.CamelCaseCompactIgnoreNull));
                        anchoredCount++;
                        totalExported++;
                    }

                    var unclaimed = new HashSet<ushort>(envCells.Keys.Where(cellId => !claimedCellIds.Contains(cellId)));
                    while (unclaimed.Count > 0) {
                        ushort startCellId = unclaimed.Min();
                        var componentCellIds = CollectConnectedEnvCellComponent(startCellId, envCells, unclaimed);
                        foreach (var cellId in componentCellIds)
                            unclaimed.Remove(cellId);

                        ulong componentId = ((ulong)lbKey << 32) | (uint)startCellId;
                        writer.WriteLine(System.Text.Json.JsonSerializer.Serialize(
                            BuildEnvCellComponentJson(dats, lbKey, "unanchored_envcell_component", componentId, envCells, componentCellIds),
                            WorldBuilder.Shared.Lib.JsonOpts.CamelCaseCompactIgnoreNull));
                        unanchoredCount++;
                        totalExported++;
                    }
                }
            }
        } catch (Exception ex) {
            sw.Stop();
            return new ExportEnvCellComponentsResult(
                false, 0, anchoredCount, unanchoredCount, landblocksProcessed,
                Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath, ex.Message);
        }

        sw.Stop();
        return new ExportEnvCellComponentsResult(
            true, totalExported, anchoredCount, unanchoredCount, landblocksProcessed,
            Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath);
    }

    private sealed class RawFactObjectInfo {
        public required string SourceDb { get; init; }
        public required string SourceTable { get; init; }
        public ulong? SourceRecordId { get; init; }
        public required ushort LandblockId { get; init; }
        public ushort? CellId { get; init; }
        public uint? Guid { get; init; }
        public uint? Wcid { get; init; }
        public int? WeenieType { get; set; }
        public uint? ModelId { get; init; }
        public required Vector3 Position { get; init; }
        public required Quaternion Orientation { get; init; }
        public required Vector3 Scale { get; init; }
        public ulong? EnvCellComponentId { get; set; }
        public string? EnvCellComponentKind { get; set; }
        public List<RawFactGeneratorProfile>? GeneratorProfiles { get; set; }
        public List<RawFactCreateListEntry>? CreateListEntries { get; set; }
        public List<uint>? ParentGuids { get; set; }
        public List<uint>? ChildGuids { get; set; }
    }

    private sealed class RawFactGeneratorProfile {
        public required uint ObjectId { get; init; }
        public required float Probability { get; init; }
        public required uint WeenieClassId { get; init; }
        public float? Delay { get; init; }
        public required int InitCreate { get; init; }
        public required int MaxCreate { get; init; }
        public required uint WhenCreate { get; init; }
        public required uint WhereCreate { get; init; }
        public int? StackSize { get; init; }
        public uint? PaletteId { get; init; }
        public float? Shade { get; init; }
        public uint? ObjCellId { get; init; }
        public float? OriginX { get; init; }
        public float? OriginY { get; init; }
        public float? OriginZ { get; init; }
        public float? AnglesW { get; init; }
        public float? AnglesX { get; init; }
        public float? AnglesY { get; init; }
        public float? AnglesZ { get; init; }
    }

    private sealed class RawFactCreateListEntry {
        public required uint ObjectId { get; init; }
        public required sbyte DestinationType { get; init; }
        public required uint WeenieClassId { get; init; }
        public required int StackSize { get; init; }
        public required sbyte Palette { get; init; }
        public required float Shade { get; init; }
        public required bool TryToBond { get; init; }
    }

    public ExportRawWorldFactsResult ExportRawWorldFacts(
        uint minX = 0, uint minY = 0, uint maxX = 254, uint maxY = 254,
        string? outputPath = null, bool includeAceDb = false, bool includeLinks = false) {

        RequireProject();
        var sw = System.Diagnostics.Stopwatch.StartNew();

        if (string.IsNullOrWhiteSpace(outputPath))
            outputPath = "raw_world_facts.jsonl";

        var terrainDoc = GetTerrainDoc();
        var heightTable = GetHeightTable();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        const float bucketSize = 48f;
        int[] radii = new[] { 6, 12, 24, 48 };

        var landblockIds = new List<ushort>();
        var objects = new List<RawFactObjectInfo>();
        var objectsByGuid = new Dictionary<uint, RawFactObjectInfo>();
        int datStaticCount = 0;
        int aceInstanceCount = 0;
        int aceEncounterCount = 0;
        int aceHousePortalCount = 0;

        for (uint lbX = minX; lbX <= maxX; lbX++) {
            for (uint lbY = minY; lbY <= maxY; lbY++) {
                ushort lbKey = LbKey(lbX, lbY);
                landblockIds.Add(lbKey);

                try {
                    uint infoId = ((uint)lbKey << 16) | 0xFFFE;
                    if (!dats.TryGet<LandBlockInfo>(infoId, out var lbi))
                        continue;

                    float lbWorldX = (lbKey >> 8) * 192f;
                    float lbWorldY = (lbKey & 0xFF) * 192f;

                    for (int objectIndex = 0; objectIndex < lbi.Objects.Count; objectIndex++) {
                        var obj = lbi.Objects[objectIndex];
                        objects.Add(new RawFactObjectInfo {
                            SourceDb = "dat",
                            SourceTable = "landblock_info_object",
                            SourceRecordId = (ulong)objectIndex,
                            LandblockId = lbKey,
                            Position = new Vector3(lbWorldX + obj.Frame.Origin.X, lbWorldY + obj.Frame.Origin.Y, obj.Frame.Origin.Z),
                            Orientation = obj.Frame.Orientation,
                            Scale = Vector3.One,
                            ModelId = obj.Id
                        });
                        datStaticCount++;
                    }

                    for (int buildingIndex = 0; buildingIndex < lbi.Buildings.Count; buildingIndex++) {
                        var building = lbi.Buildings[buildingIndex];
                        var componentCellIds = CollectBuildingCellIdsExternal(building, dats, lbKey)
                            .Where(cellId => cellId >= 0x0100 && cellId <= 0xFFFD)
                            .OrderBy(v => v)
                            .ToArray();
                        objects.Add(new RawFactObjectInfo {
                            SourceDb = "dat",
                            SourceTable = "landblock_info_building",
                            SourceRecordId = (ulong)buildingIndex,
                            LandblockId = lbKey,
                            Position = new Vector3(lbWorldX + building.Frame.Origin.X, lbWorldY + building.Frame.Origin.Y, building.Frame.Origin.Z),
                            Orientation = building.Frame.Orientation,
                            Scale = Vector3.One,
                            ModelId = building.ModelId,
                            EnvCellComponentId = componentCellIds.Length > 0 ? ((ulong)lbKey << 32) | (uint)buildingIndex : null,
                            EnvCellComponentKind = componentCellIds.Length > 0 ? "surface_anchor_component" : null
                        });
                        datStaticCount++;
                    }
                } catch {
                    // Missing or unreadable landblock data is non-fatal here.
                }
            }
        }

        string? aceError = null;
        if (includeAceDb) {
            var settings = _projectManager.CurrentProject?.AceDb;
            if (settings == null) {
                aceError = "ACE DB export requested but no ACE database settings are configured.";
            } else {
                try {
                    using var conn = new MySqlConnector.MySqlConnection(settings.ConnectionString);
                    conn.Open();

                    var weenieTypesByWcid = new Dictionary<uint, int>();
                    var generatorProfilesByObjectId = new Dictionary<uint, List<RawFactGeneratorProfile>>();
                    var createListEntriesByObjectId = new Dictionary<uint, List<RawFactCreateListEntry>>();
                    var envCellComponentsByLandblock = new Dictionary<ushort, Dictionary<ushort, (ulong ComponentId, string ComponentKind)>>();

                    foreach (var lbKey in landblockIds) {
                        var envCellComponentByCellId = new Dictionary<ushort, (ulong ComponentId, string ComponentKind)>();
                        uint infoId = ((uint)lbKey << 16) | 0xFFFE;
                        if (dats.TryGet<LandBlockInfo>(infoId, out var lbiForComponents) && lbiForComponents.NumCells > 0) {
                            var envCellIdsPresent = new HashSet<ushort>();
                            for (uint i = 0; i < lbiForComponents.NumCells; i++) {
                                ushort cellNum = (ushort)(0x0100 + i);
                                uint fullCellId = ((uint)lbKey << 16) | cellNum;
                                if (dats.TryGet<EnvCell>(fullCellId, out _))
                                    envCellIdsPresent.Add(cellNum);
                            }

                            var claimedCellIds = new HashSet<ushort>();
                            for (int buildingIndex = 0; buildingIndex < lbiForComponents.Buildings.Count; buildingIndex++) {
                                var building = lbiForComponents.Buildings[buildingIndex];
                                var componentCellIds = CollectBuildingCellIdsExternal(building, dats, lbKey)
                                    .Where(envCellIdsPresent.Contains)
                                    .ToArray();
                                if (componentCellIds.Length == 0)
                                    continue;

                                ulong componentId = ((ulong)lbKey << 32) | (uint)buildingIndex;
                                foreach (var cellId in componentCellIds) {
                                    envCellComponentByCellId[cellId] = (componentId, "surface_anchor_component");
                                    claimedCellIds.Add(cellId);
                                }
                            }

                            var unclaimed = new HashSet<ushort>(envCellIdsPresent.Where(cellId => !claimedCellIds.Contains(cellId)));
                            while (unclaimed.Count > 0) {
                                ushort startCellId = unclaimed.Min();
                                var envCells = new Dictionary<ushort, EnvCell>();
                                foreach (var cellId in unclaimed.ToArray()) {
                                    uint fullCellId = ((uint)lbKey << 16) | cellId;
                                    if (dats.TryGet<EnvCell>(fullCellId, out var envCell))
                                        envCells[cellId] = envCell;
                                }
                                var componentCellIds = CollectConnectedEnvCellComponent(startCellId, envCells, unclaimed);
                                ulong componentId = ((ulong)lbKey << 32) | (uint)startCellId;
                                foreach (var cellId in componentCellIds) {
                                    envCellComponentByCellId[cellId] = (componentId, "unanchored_envcell_component");
                                    unclaimed.Remove(cellId);
                                }
                            }
                        }

                        envCellComponentsByLandblock[lbKey] = envCellComponentByCellId;
                    }

                    const string rangePredicate = @"
                        (((`obj_Cell_Id` >> 24) >= @minX) AND ((`obj_Cell_Id` >> 24) <= @maxX))
                        AND ((((`obj_Cell_Id` >> 16) & 255)) >= @minY)
                        AND ((((`obj_Cell_Id` >> 16) & 255)) <= @maxY)";

                    const string instanceSql = @"
                        SELECT li.`guid`, li.`weenie_Class_Id`, li.`obj_Cell_Id`,
                               li.`origin_X`, li.`origin_Y`, li.`origin_Z`,
                               li.`angles_W`, li.`angles_X`, li.`angles_Y`, li.`angles_Z`,
                               w.`type`
                        FROM `landblock_instance` li
                        LEFT JOIN `weenie` w ON w.`class_Id` = li.`weenie_Class_Id`
                        WHERE " + rangePredicate;

                    using (var cmd = new MySqlConnector.MySqlCommand(instanceSql, conn)) {
                        cmd.Parameters.AddWithValue("@minX", minX);
                        cmd.Parameters.AddWithValue("@maxX", maxX);
                        cmd.Parameters.AddWithValue("@minY", minY);
                        cmd.Parameters.AddWithValue("@maxY", maxY);
                        using var reader = cmd.ExecuteReader();
                        while (reader.Read()) {
                            uint objCellId = reader.GetUInt32("obj_Cell_Id");
                            ushort objectLandblockId = (ushort)(objCellId >> 16);
                            ushort objectCellId = (ushort)(objCellId & 0xFFFF);
                            float localX = reader.GetFloat("origin_X");
                            float localY = reader.GetFloat("origin_Y");
                            (ulong ComponentId, string ComponentKind)? instanceComponent = null;
                            if (envCellComponentsByLandblock.TryGetValue(objectLandblockId, out var instanceComponentsByCell)
                                && instanceComponentsByCell.TryGetValue(objectCellId, out var resolvedInstanceComponent))
                                instanceComponent = resolvedInstanceComponent;
                            var fact = new RawFactObjectInfo {
                                SourceDb = "ace",
                                SourceTable = "landblock_instance",
                                SourceRecordId = reader.GetUInt32("guid"),
                                LandblockId = objectLandblockId,
                                CellId = objectCellId,
                                Guid = reader.GetUInt32("guid"),
                                Wcid = reader.GetUInt32("weenie_Class_Id"),
                                WeenieType = reader.IsDBNull(reader.GetOrdinal("type"))
                                    ? null
                                    : reader.GetInt32("type"),
                                Position = new Vector3(
                                    ((objectLandblockId >> 8) * 192f) + localX,
                                    ((objectLandblockId & 0xFF) * 192f) + localY,
                                    reader.GetFloat("origin_Z")),
                                Orientation = new Quaternion(
                                    reader.GetFloat("angles_X"),
                                    reader.GetFloat("angles_Y"),
                                    reader.GetFloat("angles_Z"),
                                    reader.GetFloat("angles_W")),
                                Scale = Vector3.One,
                                EnvCellComponentId = instanceComponent?.ComponentId,
                                EnvCellComponentKind = instanceComponent?.ComponentKind
                            };
                            objects.Add(fact);
                            if (fact.Guid.HasValue)
                                objectsByGuid[fact.Guid.Value] = fact;
                            if (fact.Wcid.HasValue && fact.WeenieType.HasValue)
                                weenieTypesByWcid[fact.Wcid.Value] = fact.WeenieType.Value;
                            aceInstanceCount++;
                        }
                    }

                    const string encounterSql = @"
                        SELECT e.`landblock`, e.`weenie_Class_Id`, e.`cell_X`, e.`cell_Y`, w.`type`
                        FROM `encounter` e
                        LEFT JOIN `weenie` w ON w.`class_Id` = e.`weenie_Class_Id`
                        WHERE ((e.`landblock` >> 8) >= @minX) AND ((e.`landblock` >> 8) <= @maxX)
                          AND ((e.`landblock` & 255) >= @minY) AND ((e.`landblock` & 255) <= @maxY)";

                    using (var encounterCmd = new MySqlConnector.MySqlCommand(encounterSql, conn)) {
                        encounterCmd.Parameters.AddWithValue("@minX", minX);
                        encounterCmd.Parameters.AddWithValue("@maxX", maxX);
                        encounterCmd.Parameters.AddWithValue("@minY", minY);
                        encounterCmd.Parameters.AddWithValue("@maxY", maxY);
                        using var encounterReader = encounterCmd.ExecuteReader();
                        while (encounterReader.Read()) {
                            ushort lbKey = encounterReader.GetUInt16("landblock");
                            int cellX = encounterReader.GetInt32("cell_X");
                            int cellY = encounterReader.GetInt32("cell_Y");
                            float localX = Math.Clamp(cellX * 24.0f, 0.5f, 191.5f);
                            float localY = Math.Clamp(cellY * 24.0f, 0.5f, 191.5f);
                            float worldX = ((lbKey >> 8) * 192f) + localX;
                            float worldY = ((lbKey & 0xFF) * 192f) + localY;
                            float terrainZ = _terrainService.GetHeightAtWorldPosition(
                                worldX, worldY, terrainDoc.GetLandblockInternal, heightTable);

                            var encounter = new RawFactObjectInfo {
                                SourceDb = "ace",
                                SourceTable = "encounter",
                                SourceRecordId = ((ulong)lbKey << 32)
                                    | ((ulong)(ushort)cellX << 16)
                                    | (ushort)cellY,
                                LandblockId = lbKey,
                                CellId = 0x0001,
                                Wcid = encounterReader.GetUInt32("weenie_Class_Id"),
                                WeenieType = encounterReader.IsDBNull(encounterReader.GetOrdinal("type"))
                                    ? null
                                    : encounterReader.GetInt32("type"),
                                Position = new Vector3(worldX, worldY, terrainZ),
                                Orientation = Quaternion.Identity,
                                Scale = Vector3.One
                            };
                            objects.Add(encounter);
                            if (encounter.Wcid.HasValue && encounter.WeenieType.HasValue)
                                weenieTypesByWcid[encounter.Wcid.Value] = encounter.WeenieType.Value;
                            aceEncounterCount++;
                        }
                    }

                    const string housePortalSql = @"
                        SELECT hp.`id`, hp.`obj_Cell_Id`,
                               hp.`origin_X`, hp.`origin_Y`, hp.`origin_Z`,
                               hp.`angles_W`, hp.`angles_X`, hp.`angles_Y`, hp.`angles_Z`
                        FROM `house_portal` hp
                        WHERE " + rangePredicate;

                    using (var housePortalCmd = new MySqlConnector.MySqlCommand(housePortalSql, conn)) {
                        housePortalCmd.Parameters.AddWithValue("@minX", minX);
                        housePortalCmd.Parameters.AddWithValue("@maxX", maxX);
                        housePortalCmd.Parameters.AddWithValue("@minY", minY);
                        housePortalCmd.Parameters.AddWithValue("@maxY", maxY);
                        using var housePortalReader = housePortalCmd.ExecuteReader();
                        while (housePortalReader.Read()) {
                            uint objCellId = housePortalReader.GetUInt32("obj_Cell_Id");
                            ushort objectLandblockId = (ushort)(objCellId >> 16);
                            ushort objectCellId = (ushort)(objCellId & 0xFFFF);
                            float localX = housePortalReader.GetFloat("origin_X");
                            float localY = housePortalReader.GetFloat("origin_Y");
                            (ulong ComponentId, string ComponentKind)? houseComponent = null;
                            if (envCellComponentsByLandblock.TryGetValue(objectLandblockId, out var houseComponentsByCell)
                                && houseComponentsByCell.TryGetValue(objectCellId, out var resolvedHouseComponent))
                                houseComponent = resolvedHouseComponent;
                            objects.Add(new RawFactObjectInfo {
                                SourceDb = "ace",
                                SourceTable = "house_portal",
                                SourceRecordId = housePortalReader.GetUInt32("id"),
                                LandblockId = objectLandblockId,
                                CellId = objectCellId,
                                Position = new Vector3(
                                    ((objectLandblockId >> 8) * 192f) + localX,
                                    ((objectLandblockId & 0xFF) * 192f) + localY,
                                    housePortalReader.GetFloat("origin_Z")),
                                Orientation = new Quaternion(
                                    housePortalReader.GetFloat("angles_X"),
                                    housePortalReader.GetFloat("angles_Y"),
                                    housePortalReader.GetFloat("angles_Z"),
                                    housePortalReader.GetFloat("angles_W")),
                                Scale = Vector3.One,
                                EnvCellComponentId = houseComponent?.ComponentId,
                                EnvCellComponentKind = houseComponent?.ComponentKind
                            });
                            aceHousePortalCount++;
                        }
                    }

                    if (includeLinks) {
                        string linkSql = @"
                            SELECT lil.`parent_GUID`, lil.`child_GUID`
                            FROM `landblock_instance_link` lil
                            INNER JOIN `landblock_instance` p ON p.`guid` = lil.`parent_GUID`
                            WHERE " + rangePredicate.Replace("`obj_Cell_Id`", "p.`obj_Cell_Id`");

                        using var linkCmd = new MySqlConnector.MySqlCommand(linkSql, conn);
                        linkCmd.Parameters.AddWithValue("@minX", minX);
                        linkCmd.Parameters.AddWithValue("@maxX", maxX);
                        linkCmd.Parameters.AddWithValue("@minY", minY);
                        linkCmd.Parameters.AddWithValue("@maxY", maxY);
                        using var linkReader = linkCmd.ExecuteReader();
                        while (linkReader.Read()) {
                            uint parentGuid = linkReader.GetUInt32("parent_GUID");
                            uint childGuid = linkReader.GetUInt32("child_GUID");

                            if (objectsByGuid.TryGetValue(parentGuid, out var parent)) {
                                parent.ChildGuids ??= new List<uint>();
                                parent.ChildGuids.Add(childGuid);
                            }

                            if (objectsByGuid.TryGetValue(childGuid, out var child)) {
                                child.ParentGuids ??= new List<uint>();
                                child.ParentGuids.Add(parentGuid);
                            }
                        }
                    }

                    const string allGeneratorSql = @"
                        SELECT `object_Id`, `probability`, `weenie_Class_Id`, `delay`,
                               `init_Create`, `max_Create`, `when_Create`, `where_Create`,
                               `stack_Size`, `palette_Id`, `shade`, `obj_Cell_Id`,
                               `origin_X`, `origin_Y`, `origin_Z`,
                               `angles_W`, `angles_X`, `angles_Y`, `angles_Z`
                        FROM `weenie_properties_generator`";
                    using (var generatorCmd = new MySqlConnector.MySqlCommand(allGeneratorSql, conn))
                    using (var generatorReader = generatorCmd.ExecuteReader()) {
                        while (generatorReader.Read()) {
                            uint objectId = generatorReader.GetUInt32("object_Id");
                            if (!generatorProfilesByObjectId.TryGetValue(objectId, out var list)) {
                                list = new List<RawFactGeneratorProfile>();
                                generatorProfilesByObjectId[objectId] = list;
                            }

                            list.Add(new RawFactGeneratorProfile {
                                ObjectId = objectId,
                                Probability = generatorReader.GetFloat("probability"),
                                WeenieClassId = generatorReader.GetUInt32("weenie_Class_Id"),
                                Delay = generatorReader.IsDBNull(generatorReader.GetOrdinal("delay")) ? null : generatorReader.GetFloat("delay"),
                                InitCreate = generatorReader.GetInt32("init_Create"),
                                MaxCreate = generatorReader.GetInt32("max_Create"),
                                WhenCreate = generatorReader.GetUInt32("when_Create"),
                                WhereCreate = generatorReader.GetUInt32("where_Create"),
                                StackSize = generatorReader.IsDBNull(generatorReader.GetOrdinal("stack_Size")) ? null : generatorReader.GetInt32("stack_Size"),
                                PaletteId = generatorReader.IsDBNull(generatorReader.GetOrdinal("palette_Id")) ? null : generatorReader.GetUInt32("palette_Id"),
                                Shade = generatorReader.IsDBNull(generatorReader.GetOrdinal("shade")) ? null : generatorReader.GetFloat("shade"),
                                ObjCellId = generatorReader.IsDBNull(generatorReader.GetOrdinal("obj_Cell_Id")) ? null : generatorReader.GetUInt32("obj_Cell_Id"),
                                OriginX = generatorReader.IsDBNull(generatorReader.GetOrdinal("origin_X")) ? null : generatorReader.GetFloat("origin_X"),
                                OriginY = generatorReader.IsDBNull(generatorReader.GetOrdinal("origin_Y")) ? null : generatorReader.GetFloat("origin_Y"),
                                OriginZ = generatorReader.IsDBNull(generatorReader.GetOrdinal("origin_Z")) ? null : generatorReader.GetFloat("origin_Z"),
                                AnglesW = generatorReader.IsDBNull(generatorReader.GetOrdinal("angles_W")) ? null : generatorReader.GetFloat("angles_W"),
                                AnglesX = generatorReader.IsDBNull(generatorReader.GetOrdinal("angles_X")) ? null : generatorReader.GetFloat("angles_X"),
                                AnglesY = generatorReader.IsDBNull(generatorReader.GetOrdinal("angles_Y")) ? null : generatorReader.GetFloat("angles_Y"),
                                AnglesZ = generatorReader.IsDBNull(generatorReader.GetOrdinal("angles_Z")) ? null : generatorReader.GetFloat("angles_Z")
                            });
                        }
                    }

                    const string allCreateListSql = @"
                        SELECT `object_Id`, `destination_Type`, `weenie_Class_Id`,
                               `stack_Size`, `palette`, `shade`, `try_To_Bond`
                        FROM `weenie_properties_create_list`";
                    using (var createListCmd = new MySqlConnector.MySqlCommand(allCreateListSql, conn))
                    using (var createListReader = createListCmd.ExecuteReader()) {
                        while (createListReader.Read()) {
                            uint objectId = createListReader.GetUInt32("object_Id");
                            if (!createListEntriesByObjectId.TryGetValue(objectId, out var list)) {
                                list = new List<RawFactCreateListEntry>();
                                createListEntriesByObjectId[objectId] = list;
                            }

                            list.Add(new RawFactCreateListEntry {
                                ObjectId = objectId,
                                DestinationType = createListReader.GetSByte("destination_Type"),
                                WeenieClassId = createListReader.GetUInt32("weenie_Class_Id"),
                                StackSize = createListReader.GetInt32("stack_Size"),
                                Palette = createListReader.GetSByte("palette"),
                                Shade = createListReader.GetFloat("shade"),
                                TryToBond = createListReader.GetBoolean("try_To_Bond")
                            });
                        }
                    }

                    foreach (var obj in objects) {
                        if (!obj.Wcid.HasValue)
                            continue;

                        if (!obj.WeenieType.HasValue && weenieTypesByWcid.TryGetValue(obj.Wcid.Value, out var resolvedWeenieType))
                            obj.WeenieType = resolvedWeenieType;

                        if (generatorProfilesByObjectId.TryGetValue(obj.Wcid.Value, out var generatorProfiles))
                            obj.GeneratorProfiles = generatorProfiles;

                        if (createListEntriesByObjectId.TryGetValue(obj.Wcid.Value, out var createListEntries))
                            obj.CreateListEntries = createListEntries;
                    }
                } catch (Exception ex) {
                    aceError = ex.Message;
                }
            }
        }

        if (objects.Count == 0) {
            sw.Stop();
            return new ExportRawWorldFactsResult(
                Success: string.IsNullOrEmpty(aceError),
                TotalExported: 0,
                DatStaticCount: datStaticCount,
                AceInstanceCount: aceInstanceCount,
                AceEncounterCount: aceEncounterCount,
                AceHousePortalCount: aceHousePortalCount,
                LandblocksProcessed: landblockIds.Count,
                IncludedAceDb: includeAceDb && string.IsNullOrEmpty(aceError),
                IncludedLinks: includeAceDb && includeLinks && string.IsNullOrEmpty(aceError),
                ElapsedMs: Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                OutputPath: outputPath,
                Error: aceError);
        }

        var buckets = new Dictionary<(int, int), List<int>>();
        for (int i = 0; i < objects.Count; i++) {
            int bx = (int)MathF.Floor(objects[i].Position.X / bucketSize);
            int by = (int)MathF.Floor(objects[i].Position.Y / bucketSize);
            var key = (bx, by);
            if (!buckets.TryGetValue(key, out var list)) {
                list = new List<int>();
                buckets[key] = list;
            }
            list.Add(i);
        }

        try {
            using var writer = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);
            for (int idx = 0; idx < objects.Count; idx++) {
                var obj = objects[idx];
                var pos = obj.Position;

                var terrainSampleZ = _terrainService.GetHeightAtWorldPosition(
                    pos.X, pos.Y, terrainDoc.GetLandblockInternal, heightTable);

                int? terrainType = null;
                int? heightIndex = null;
                double slopeDeg = 0;
                var vertexInfo = _terrainService.WorldToVertex(pos.X, pos.Y);
                if (vertexInfo.HasValue) {
                    var data = terrainDoc.GetLandblockInternal(vertexInfo.Value.LandblockKey);
                    if (data != null) {
                        int vIdx = vertexInfo.Value.VertexIndex;
                        int vx = vIdx / 9;
                        int vy = vIdx % 9;
                        terrainType = data[vIdx].Type;
                        heightIndex = data[vIdx].Height;

                        byte hCenter = data[vIdx].Height;
                        float zCenter = heightTable[hCenter];
                        float maxDelta = 0f;
                        if (vx > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(zCenter - heightTable[data[(vx - 1) * 9 + vy].Height]));
                        if (vx < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(zCenter - heightTable[data[(vx + 1) * 9 + vy].Height]));
                        if (vy > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(zCenter - heightTable[data[vx * 9 + (vy - 1)].Height]));
                        if (vy < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(zCenter - heightTable[data[vx * 9 + (vy + 1)].Height]));
                        float heightDeltaWorld = maxDelta;
                        slopeDeg = Math.Round(MathF.Atan2(heightDeltaWorld, 24f) * (180f / MathF.PI), 1);
                    }
                }

                float yaw = MathF.Atan2(
                    2f * (obj.Orientation.W * obj.Orientation.Z + obj.Orientation.X * obj.Orientation.Y),
                    1f - 2f * (obj.Orientation.Y * obj.Orientation.Y + obj.Orientation.Z * obj.Orientation.Z));
                float yawDeg = yaw * (180f / MathF.PI);
                if (yawDeg < 0) yawDeg += 360f;

                int bxCenter = (int)MathF.Floor(pos.X / bucketSize);
                int byCenter = (int)MathF.Floor(pos.Y / bucketSize);
                float maxRadiusSq = radii[^1] * radii[^1];
                var neighborIndexes = new List<(int Index, float Dist)>();

                for (int dx = -1; dx <= 1; dx++) {
                    for (int dy = -1; dy <= 1; dy++) {
                        if (!buckets.TryGetValue((bxCenter + dx, byCenter + dy), out var bucket))
                            continue;
                        foreach (var otherIdx in bucket) {
                            if (otherIdx == idx) continue;
                            var otherPos = objects[otherIdx].Position;
                            float deltaX = pos.X - otherPos.X;
                            float deltaY = pos.Y - otherPos.Y;
                            float distSq = deltaX * deltaX + deltaY * deltaY;
                            if (distSq > maxRadiusSq) continue;
                            neighborIndexes.Add((otherIdx, MathF.Sqrt(distSq)));
                        }
                    }
                }

                var neighborhoods = new List<object>(radii.Length);
                foreach (var radius in radii) {
                    int totalCount = 0;
                    int sameModelIdCount = 0;
                    int sameWcidCount = 0;
                    int sameWeenieTypeCount = 0;
                    float? nearestSameModelId = null;
                    float? nearestSameWcid = null;
                    float? nearestSameWeenieType = null;
                    var sourceDbCounts = new Dictionary<string, int>(StringComparer.Ordinal);
                    var modelCounts = new Dictionary<uint, int>();
                    var wcidCounts = new Dictionary<uint, int>();
                    var weenieTypeCounts = new Dictionary<int, int>();

                    foreach (var (otherIdx, dist) in neighborIndexes) {
                        if (dist > radius)
                            continue;

                        totalCount++;
                        var other = objects[otherIdx];
                        sourceDbCounts[other.SourceDb] = sourceDbCounts.GetValueOrDefault(other.SourceDb) + 1;

                        if (other.ModelId.HasValue) {
                            modelCounts[other.ModelId.Value] = modelCounts.GetValueOrDefault(other.ModelId.Value) + 1;
                            if (obj.ModelId.HasValue && other.ModelId.Value == obj.ModelId.Value) {
                                sameModelIdCount++;
                                nearestSameModelId = !nearestSameModelId.HasValue || dist < nearestSameModelId.Value ? dist : nearestSameModelId;
                            }
                        }

                        if (other.Wcid.HasValue) {
                            wcidCounts[other.Wcid.Value] = wcidCounts.GetValueOrDefault(other.Wcid.Value) + 1;
                            if (obj.Wcid.HasValue && other.Wcid.Value == obj.Wcid.Value) {
                                sameWcidCount++;
                                nearestSameWcid = !nearestSameWcid.HasValue || dist < nearestSameWcid.Value ? dist : nearestSameWcid;
                            }
                        }

                        if (other.WeenieType.HasValue) {
                            weenieTypeCounts[other.WeenieType.Value] = weenieTypeCounts.GetValueOrDefault(other.WeenieType.Value) + 1;
                            if (obj.WeenieType.HasValue && other.WeenieType.Value == obj.WeenieType.Value) {
                                sameWeenieTypeCount++;
                                nearestSameWeenieType = !nearestSameWeenieType.HasValue || dist < nearestSameWeenieType.Value ? dist : nearestSameWeenieType;
                            }
                        }
                    }

                    neighborhoods.Add(new {
                        radius,
                        totalCount,
                        sourceDbCounts = sourceDbCounts.Count == 0 ? null : sourceDbCounts
                            .OrderBy(kv => kv.Key)
                            .Select(kv => new { sourceDb = kv.Key, count = kv.Value })
                            .ToArray(),
                        sameModelIdCount = obj.ModelId.HasValue ? sameModelIdCount : (int?)null,
                        nearestSameModelId = nearestSameModelId.HasValue ? (double?)Math.Round(nearestSameModelId.Value, 2) : null,
                        sameWcidCount = obj.Wcid.HasValue ? sameWcidCount : (int?)null,
                        nearestSameWcid = nearestSameWcid.HasValue ? (double?)Math.Round(nearestSameWcid.Value, 2) : null,
                        sameWeenieTypeCount = obj.WeenieType.HasValue ? sameWeenieTypeCount : (int?)null,
                        nearestSameWeenieType = nearestSameWeenieType.HasValue ? (double?)Math.Round(nearestSameWeenieType.Value, 2) : null,
                        topModelIds = modelCounts.Count == 0 ? null : modelCounts
                            .OrderByDescending(kv => kv.Value)
                            .ThenBy(kv => kv.Key)
                            .Take(8)
                            .Select(kv => new { modelId = $"0x{kv.Key:X8}", count = kv.Value })
                            .ToArray(),
                        topWcids = wcidCounts.Count == 0 ? null : wcidCounts
                            .OrderByDescending(kv => kv.Value)
                            .ThenBy(kv => kv.Key)
                            .Take(8)
                            .Select(kv => new { wcid = kv.Key, count = kv.Value })
                            .ToArray(),
                        topWeenieTypes = weenieTypeCounts.Count == 0 ? null : weenieTypeCounts
                            .OrderByDescending(kv => kv.Value)
                            .ThenBy(kv => kv.Key)
                            .Take(8)
                            .Select(kv => new { weenieType = kv.Key, count = kv.Value })
                            .ToArray()
                    });
                }

                writer.WriteLine(System.Text.Json.JsonSerializer.Serialize(new {
                    sourceDb = obj.SourceDb,
                    sourceTable = obj.SourceTable,
                    sourceRecordId = obj.SourceRecordId,
                    landblockId = $"0x{obj.LandblockId:X4}",
                    landblockX = obj.LandblockId >> 8,
                    landblockY = obj.LandblockId & 0xFF,
                    cellId = obj.CellId.HasValue ? $"0x{obj.CellId.Value:X4}" : null,
                    guid = obj.Guid,
                    classId = obj.Wcid ?? obj.ModelId,
                    classIdSpace = obj.Wcid.HasValue ? "wcid" : (obj.ModelId.HasValue ? "model_id" : null),
                    typeId = obj.WeenieType,
                    envCellComponentId = obj.EnvCellComponentId,
                    envCellComponentKind = obj.EnvCellComponentKind,
                    wcid = obj.Wcid,
                    modelId = obj.ModelId.HasValue ? $"0x{obj.ModelId.Value:X8}" : null,
                    weenieType = obj.WeenieType,
                    x = Math.Round(pos.X, 3),
                    y = Math.Round(pos.Y, 3),
                    z = Math.Round(pos.Z, 3),
                    localX = Math.Round(pos.X - ((obj.LandblockId >> 8) * 192f), 3),
                    localY = Math.Round(pos.Y - ((obj.LandblockId & 0xFF) * 192f), 3),
                    terrainSampleZ = Math.Round(terrainSampleZ, 3),
                    terrainDeltaZ = Math.Round(pos.Z - terrainSampleZ, 3),
                    terrainType,
                    heightIndex,
                    slopeDeg,
                    yawDeg = Math.Round(yawDeg, 2),
                    qw = Math.Round(obj.Orientation.W, 6),
                    qx = Math.Round(obj.Orientation.X, 6),
                    qy = Math.Round(obj.Orientation.Y, 6),
                    qz = Math.Round(obj.Orientation.Z, 6),
                    scaleX = Math.Round(obj.Scale.X, 4),
                    scaleY = Math.Round(obj.Scale.Y, 4),
                    scaleZ = Math.Round(obj.Scale.Z, 4),
                    generatorProfiles = obj.GeneratorProfiles?.Select(profile => new {
                        objectId = profile.ObjectId,
                        probability = Math.Round(profile.Probability, 6),
                        weenieClassId = profile.WeenieClassId,
                        delay = profile.Delay.HasValue ? (double?)Math.Round(profile.Delay.Value, 6) : null,
                        initCreate = profile.InitCreate,
                        maxCreate = profile.MaxCreate,
                        whenCreate = profile.WhenCreate,
                        whereCreate = profile.WhereCreate,
                        stackSize = profile.StackSize,
                        paletteId = profile.PaletteId,
                        shade = profile.Shade.HasValue ? (double?)Math.Round(profile.Shade.Value, 6) : null,
                        objCellId = profile.ObjCellId.HasValue ? $"0x{profile.ObjCellId.Value:X8}" : null,
                        originX = profile.OriginX.HasValue ? (double?)Math.Round(profile.OriginX.Value, 3) : null,
                        originY = profile.OriginY.HasValue ? (double?)Math.Round(profile.OriginY.Value, 3) : null,
                        originZ = profile.OriginZ.HasValue ? (double?)Math.Round(profile.OriginZ.Value, 3) : null,
                        anglesW = profile.AnglesW.HasValue ? (double?)Math.Round(profile.AnglesW.Value, 6) : null,
                        anglesX = profile.AnglesX.HasValue ? (double?)Math.Round(profile.AnglesX.Value, 6) : null,
                        anglesY = profile.AnglesY.HasValue ? (double?)Math.Round(profile.AnglesY.Value, 6) : null,
                        anglesZ = profile.AnglesZ.HasValue ? (double?)Math.Round(profile.AnglesZ.Value, 6) : null
                    }).ToArray(),
                    createListEntries = obj.CreateListEntries?.Select(entry => new {
                        objectId = entry.ObjectId,
                        destinationType = entry.DestinationType,
                        weenieClassId = entry.WeenieClassId,
                        stackSize = entry.StackSize,
                        palette = entry.Palette,
                        shade = Math.Round(entry.Shade, 6),
                        tryToBond = entry.TryToBond
                    }).ToArray(),
                    parentGuids = obj.ParentGuids?.Distinct().OrderBy(v => v).ToArray(),
                    childGuids = obj.ChildGuids?.Distinct().OrderBy(v => v).ToArray(),
                    neighborhoods
                }, WorldBuilder.Shared.Lib.JsonOpts.CamelCaseCompactIgnoreNull));
            }
        } catch (Exception ex) {
            sw.Stop();
            return new ExportRawWorldFactsResult(
                Success: false,
                TotalExported: 0,
                DatStaticCount: datStaticCount,
                AceInstanceCount: aceInstanceCount,
                AceEncounterCount: aceEncounterCount,
                AceHousePortalCount: aceHousePortalCount,
                LandblocksProcessed: landblockIds.Count,
                IncludedAceDb: includeAceDb && string.IsNullOrEmpty(aceError),
                IncludedLinks: includeAceDb && includeLinks && string.IsNullOrEmpty(aceError),
                ElapsedMs: Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                OutputPath: outputPath,
                Error: ex.Message);
        }

        sw.Stop();
        return new ExportRawWorldFactsResult(
            Success: string.IsNullOrEmpty(aceError),
            TotalExported: objects.Count,
            DatStaticCount: datStaticCount,
            AceInstanceCount: aceInstanceCount,
            AceEncounterCount: aceEncounterCount,
            AceHousePortalCount: aceHousePortalCount,
            LandblocksProcessed: landblockIds.Count,
            IncludedAceDb: includeAceDb && string.IsNullOrEmpty(aceError),
            IncludedLinks: includeAceDb && includeLinks && string.IsNullOrEmpty(aceError),
            ElapsedMs: Math.Round(sw.Elapsed.TotalMilliseconds, 1),
            OutputPath: outputPath,
            Error: aceError);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Phase 10 â€” Constraint-Based Settlement Generator
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// <summary>
    /// Internal settlement template definition, referencing the 9 constraint presets
    /// in object_ontology_schema.json.
    /// </summary>
    private class SettlementTemplate {
        public string Name { get; init; } = "";
        public string Description { get; init; } = "";
        public string LayoutPattern { get; init; } = "clustered"; // clustered, linear, circular, grid
        public float SpacingMin { get; init; } = 5f;
        public float SpacingMax { get; init; } = 25f;
        public float MinDistFromCenter { get; init; } = 3f;
        public string[] AllowedBiomeTags { get; init; } = Array.Empty<string>();
        public string[] ForbiddenBiomeTags { get; init; } = Array.Empty<string>();
        public string[] PreferredCategories { get; init; } = Array.Empty<string>();
        public List<ObjectSlot> Slots { get; init; } = new();
    }

    private class ObjectSlot {
        public string Category { get; init; } = "";
        public int CountMin { get; init; }
        public int CountMax { get; init; }
        public bool FaceCenter { get; init; }
        public string? PreferredTag { get; init; }
    }

    private static readonly SettlementTemplate[] SettlementTemplates = {
        // Template 1: Aluvian Village â€” based on Aluvian_Village preset
        new SettlementTemplate {
            Name = "Aluvian_Village",
            Description = "Medium-sized temperate farming village with Aluvian architecture",
            LayoutPattern = "clustered",
            SpacingMin = 8f, SpacingMax = 30f, MinDistFromCenter = 5f,
            AllowedBiomeTags = new[] { "temperate", "coastal", "grass" },
            ForbiddenBiomeTags = new[] { "desert", "snowy", "volcanic", "snow", "sand" },
            PreferredCategories = new[] { "Structure", "Scenery", "Furniture", "Prop" },
            Slots = new List<ObjectSlot> {
                new() { Category = "Structure", CountMin = 3, CountMax = 6, FaceCenter = true, PreferredTag = "building" },
                new() { Category = "Scenery", CountMin = 4, CountMax = 10, FaceCenter = false, PreferredTag = "tree" },
                new() { Category = "Furniture", CountMin = 2, CountMax = 4, FaceCenter = false, PreferredTag = "light" },
                new() { Category = "Prop", CountMin = 1, CountMax = 3, FaceCenter = false, PreferredTag = "sign" },
            }
        },
        // Template 2: Sho Outpost â€” based on Sho_Settlement preset
        new SettlementTemplate {
            Name = "Sho_Outpost",
            Description = "Sho-style settlement with pagodas and paper lanterns",
            LayoutPattern = "circular",
            SpacingMin = 6f, SpacingMax = 22f, MinDistFromCenter = 4f,
            AllowedBiomeTags = new[] { "temperate", "grass" },
            ForbiddenBiomeTags = new[] { "desert", "snowy", "snow", "sand" },
            PreferredCategories = new[] { "Structure", "Scenery", "Furniture" },
            Slots = new List<ObjectSlot> {
                new() { Category = "Structure", CountMin = 2, CountMax = 5, FaceCenter = true, PreferredTag = "building" },
                new() { Category = "Scenery", CountMin = 3, CountMax = 8, FaceCenter = false, PreferredTag = "tree" },
                new() { Category = "Furniture", CountMin = 1, CountMax = 3, FaceCenter = false, PreferredTag = "light" },
            }
        },
        // Template 3: Gharu'ndim Camp â€” based on Desert_Outpost preset
        new SettlementTemplate {
            Name = "Gharundim_Camp",
            Description = "Small desert settlement with Gharu'ndim architecture",
            LayoutPattern = "linear",
            SpacingMin = 5f, SpacingMax = 18f, MinDistFromCenter = 3f,
            AllowedBiomeTags = new[] { "desert", "sand", "dry" },
            ForbiddenBiomeTags = new[] { "snowy", "snow" },
            PreferredCategories = new[] { "Structure", "Furniture", "Scenery" },
            Slots = new List<ObjectSlot> {
                new() { Category = "Structure", CountMin = 1, CountMax = 3, FaceCenter = true, PreferredTag = "building" },
                new() { Category = "Furniture", CountMin = 2, CountMax = 4, FaceCenter = false, PreferredTag = "light" },
                new() { Category = "Scenery", CountMin = 1, CountMax = 3, FaceCenter = false, PreferredTag = "rock" },
            }
        },
        // Template 4: Wilderness Camp â€” based on Monster_Camp + Banderling_Camp presets
        new SettlementTemplate {
            Name = "Wilderness_Camp",
            Description = "Creature spawn camp with campfire and ambient decoration",
            LayoutPattern = "circular",
            SpacingMin = 3f, SpacingMax = 15f, MinDistFromCenter = 2f,
            AllowedBiomeTags = new[] { "temperate", "grass", "forest", "snowy", "snow" },
            ForbiddenBiomeTags = Array.Empty<string>(),
            PreferredCategories = new[] { "Scenery", "Furniture", "Prop" },
            Slots = new List<ObjectSlot> {
                new() { Category = "Furniture", CountMin = 1, CountMax = 2, FaceCenter = false, PreferredTag = "light" },
                new() { Category = "Scenery", CountMin = 2, CountMax = 6, FaceCenter = false, PreferredTag = "rock" },
                new() { Category = "Prop", CountMin = 0, CountMax = 2, FaceCenter = false, PreferredTag = "crate" },
            }
        },
        // Template 5: Fortress Outpost â€” based on Dungeon_Entrance + Starter_Zone presets
        new SettlementTemplate {
            Name = "Fortress_Outpost",
            Description = "Fortified outpost with walls, towers, and defensive structures",
            LayoutPattern = "grid",
            SpacingMin = 10f, SpacingMax = 35f, MinDistFromCenter = 8f,
            AllowedBiomeTags = new[] { "temperate", "grass", "coastal", "rock" },
            ForbiddenBiomeTags = new[] { "volcanic" },
            PreferredCategories = new[] { "Structure", "Scenery", "Furniture", "Prop" },
            Slots = new List<ObjectSlot> {
                new() { Category = "Structure", CountMin = 4, CountMax = 8, FaceCenter = true, PreferredTag = "building" },
                new() { Category = "Scenery", CountMin = 2, CountMax = 5, FaceCenter = false, PreferredTag = "tree" },
                new() { Category = "Furniture", CountMin = 2, CountMax = 4, FaceCenter = false, PreferredTag = "light" },
                new() { Category = "Prop", CountMin = 1, CountMax = 3, FaceCenter = false, PreferredTag = "sign" },
            }
        },
    };

    /// <summary>
    /// Generates a constraint-based settlement at the given center position.
    /// Uses one of the 5 settlement templates, enforces biome constraints,
    /// computes spatial layout, and places objects using AddObject.
    /// </summary>
    public GenerateSettlementResult GenerateSettlement(
        string templateName, float centerX, float centerY,
        int seed = 0) {

        RequireProject();
        var sw = new System.Diagnostics.Stopwatch();
        sw.Start();

        var warnings = new List<string>();
        var placedObjects = new List<PlacedSettlementObject>();
        int constraintViolations = 0;

        // â”€â”€â”€ 1. Resolve template â”€â”€â”€
        var template = SettlementTemplates.FirstOrDefault(
            t => t.Name.Equals(templateName, StringComparison.OrdinalIgnoreCase));
        if (template == null) {
            sw.Stop();
            var available = string.Join(", ", SettlementTemplates.Select(t => t.Name));
            return new GenerateSettlementResult(false, templateName, 0, 0, warnings, placedObjects,
                Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                $"Unknown template '{templateName}'. Available: {available}");
        }

        // Reject out-of-world centers up front. The world spans 255 landblocks of
        // 192m = 48960m; a center beyond the edge would wrap through (uint)(p/192f)
        // -> ushort LbKey and place the settlement in the WRONG landblock.
        const float WorldEdge = 255f * 192f; // 48960
        if (!float.IsFinite(centerX) || !float.IsFinite(centerY) ||
            centerX < 0f || centerX >= WorldEdge || centerY < 0f || centerY >= WorldEdge) {
            sw.Stop();
            return new GenerateSettlementResult(false, template.Name, 0, 0, warnings, placedObjects,
                Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                $"Center ({centerX:F1}, {centerY:F1}) is outside the world [0..{WorldEdge:F0}).");
        }

        Console.Error.WriteLine($"[GenerateSettlement] Template: {template.Name} â€” {template.Description}");
        Console.Error.WriteLine($"[GenerateSettlement] Center: ({centerX}, {centerY})  Layout: {template.LayoutPattern}");

        // Derive an effective seed when 0 so the run is reproducible (mirror
        // generate-dungeon's 0 -> Environment.TickCount mapping).
        int effectiveSeed = seed != 0 ? seed : System.Environment.TickCount;
        var rng = new Random(effectiveSeed);
        Console.Error.WriteLine($"[GenerateSettlement] Effective seed: {effectiveSeed}");

        // â”€â”€â”€ 2. Determine landblock for center position â”€â”€â”€
        uint lbX = (uint)(centerX / 192f);
        uint lbY = (uint)(centerY / 192f);
        ushort lbKey = LbKey(lbX, lbY);

        // â”€â”€â”€ 3. Validate biome constraints via terrain type at center â”€â”€â”€
        int? terrainTypeAtCenter = null;
        try {
            var vi = _terrainService.WorldToVertex(centerX, centerY);
            if (vi.HasValue) {
                var data = GetTerrainDoc().GetLandblockInternal(vi.Value.LandblockKey);
                if (data != null)
                    terrainTypeAtCenter = data[vi.Value.VertexIndex].Type;
            }
        } catch { /* non-fatal */ }

        if (terrainTypeAtCenter.HasValue) {
            // Infer biome from the authoritative ACE LandDefs.TerrainType table
            // (see BiomeToTerrainType for the full 0x00-0x14 listing).
            //   0x00 BarrenRock        0x08 PatchyDirt        0x10 WaterRunning
            //   0x01 Grassland         0x09 PatchyGrassland   0x11 WaterStandingFresh
            //   0x02 Ice               0x0A SandYellow        0x12 WaterShallowSea
            //   0x03 LushGrass         0x0B SandGrey          0x13 WaterShallowStillSea
            //   0x04 MarshSparseSwamp  0x0C SandRockStrewn    0x14 WaterDeepSea
            //   0x05 MudRichDirt       0x0D SedimentaryRock
            //   0x06 ObsidianPlain     0x0E SemiBarrenRock
            //   0x07 PackedDirt        0x0F Snow
            string inferredBiome = terrainTypeAtCenter.Value switch {
                0x00 => "rock",                 // BarrenRock
                0x01 => "temperate",            // Grassland
                0x02 => "snow",                 // Ice
                0x03 => "temperate",            // LushGrass
                0x04 => "swamp",                // MarshSparseSwamp
                0x05 => "temperate",            // MudRichDirt
                0x06 => "obsidian",             // ObsidianPlain
                0x07 => "temperate",            // PackedDirt
                0x08 => "temperate",            // PatchyDirt
                0x09 => "temperate",            // PatchyGrassland
                0x0A or 0x0B or 0x0C => "desert", // Sand*
                0x0D => "rock",                 // SedimentaryRock
                0x0E => "rock",                 // SemiBarrenRock
                0x0F => "snow",                 // Snow
                >= 0x10 and <= 0x14 => "water", // Water*
                _ => "temperate"
            };

            // Check forbidden biomes
            foreach (var forbidden in template.ForbiddenBiomeTags) {
                if (inferredBiome.Contains(forbidden, StringComparison.OrdinalIgnoreCase)) {
                    constraintViolations++;
                    warnings.Add($"Biome constraint violation: terrain type {terrainTypeAtCenter.Value} " +
                                 $"(inferred '{inferredBiome}') conflicts with forbidden tag '{forbidden}'");
                }
            }

            // Check allowed biomes (soft constraint â€” warn but don't fail)
            if (template.AllowedBiomeTags.Length > 0) {
                bool biomeMatch = template.AllowedBiomeTags.Any(
                    t => inferredBiome.Contains(t, StringComparison.OrdinalIgnoreCase));
                if (!biomeMatch) {
                    constraintViolations++;
                    warnings.Add($"Biome preference mismatch: terrain type {terrainTypeAtCenter.Value} " +
                                 $"(inferred '{inferredBiome}') does not match allowed tags [{string.Join(", ", template.AllowedBiomeTags)}]");
                }
            }
        } else {
            warnings.Add("Could not determine terrain type at center position");
        }

        // â”€â”€â”€ 4. Query ontology for candidate objects per slot â”€â”€â”€
        bool ontologyAvailable = _ontologyService.IsScanned;
        if (!ontologyAvailable) {
            warnings.Add("Ontology not scanned â€” using fallback object selection.");
        }

        var slotObjectLists = new List<List<(uint objectId, string category, string? name)>>();

        foreach (var slot in template.Slots) {
            var candidates = new List<(uint objectId, string category, string? name)>();

            if (ontologyAvailable) {
                // Query by category
                var entries = _ontologyService.Search(category: slot.Category, limit: 200).ToList();

                // If preferred tag is specified, prefer entries matching that tag
                if (!string.IsNullOrEmpty(slot.PreferredTag)) {
                    var tagged = entries.Where(e =>
                        e.Tags.Any(t => t.Contains(slot.PreferredTag, StringComparison.OrdinalIgnoreCase)) ||
                        (e.Name != null && e.Name.Contains(slot.PreferredTag, StringComparison.OrdinalIgnoreCase))
                    ).ToList();

                    if (tagged.Count > 0) entries = tagged;
                }

                // Reject objects with forbidden biome tags (semantic constraint enforcement)
                if (template.ForbiddenBiomeTags.Length > 0) {
                    var before = entries.Count;
                    entries = entries.Where(e => {
                        foreach (var forbidden in template.ForbiddenBiomeTags) {
                            if (e.Tags.Any(t => t.Contains(forbidden, StringComparison.OrdinalIgnoreCase)))
                                return false;
                            if (e.MaterialTags != null &&
                                e.MaterialTags.Any(t => t.Contains(forbidden, StringComparison.OrdinalIgnoreCase)))
                                return false;
                        }
                        return true;
                    }).ToList();

                    int rejected = before - entries.Count;
                    if (rejected > 0) {
                        Console.Error.WriteLine($"[GenerateSettlement]   Rejected {rejected} objects from {slot.Category} " +
                                          $"due to biome constraints");
                    }
                }

                // Prefer classified objects over "Unknown" heuristic classification
                var classified = entries.Where(e =>
                    e.ClassificationSource != "Heuristic" || e.Name != null).ToList();
                if (classified.Count >= slot.CountMin) entries = classified;

                // Prefer Setup objects (0x02) over standalone GfxObj
                var setups = entries.Where(e => e.DatType == "Setup").ToList();
                if (setups.Count >= slot.CountMin) entries = setups;

                foreach (var e in entries)
                    candidates.Add((e.ObjectId, e.Category, e.Name));
            }

            if (candidates.Count == 0) {
                warnings.Add($"No ontology candidates for slot '{slot.Category}' " +
                             $"(tag: {slot.PreferredTag ?? "none"}) â€” slot will be skipped");
            }

            slotObjectLists.Add(candidates);
        }

        // â”€â”€â”€ 5. Compute layout positions â”€â”€â”€
        Console.Error.WriteLine($"[GenerateSettlement] Computing {template.LayoutPattern} layout positions...");

        // First determine total object count
        int totalToPlace = 0;
        var slotCounts = new List<int>();
        for (int s = 0; s < template.Slots.Count; s++) {
            int count = slotObjectLists[s].Count > 0
                ? rng.Next(template.Slots[s].CountMin,
                    Math.Min(template.Slots[s].CountMax + 1, slotObjectLists[s].Count + 1))
                : 0;
            count = Math.Max(count, Math.Min(template.Slots[s].CountMin, slotObjectLists[s].Count));
            slotCounts.Add(count);
            totalToPlace += count;
        }

        if (totalToPlace == 0) {
            sw.Stop();
            return new GenerateSettlementResult(false, template.Name, 0, constraintViolations,
                warnings, placedObjects, Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                "No objects could be selected for any slot â€” check ontology or template constraints");
        }

        // Generate positions based on layout pattern
        var positions = new List<(float x, float y)>();
        float spacing = template.SpacingMin +
            (float)rng.NextDouble() * (template.SpacingMax - template.SpacingMin) * 0.5f;

        switch (template.LayoutPattern) {
            case "clustered": {
                // Gaussian-ish distribution around center
                for (int i = 0; i < totalToPlace; i++) {
                    float angle = (float)rng.NextDouble() * MathF.PI * 2f;
                    float dist = template.MinDistFromCenter +
                        (float)(rng.NextDouble() + rng.NextDouble()) * 0.5f * spacing;
                    float jitterX = ((float)rng.NextDouble() - 0.5f) * 4f;
                    float jitterY = ((float)rng.NextDouble() - 0.5f) * 4f;
                    positions.Add((
                        centerX + MathF.Cos(angle) * dist + jitterX,
                        centerY + MathF.Sin(angle) * dist + jitterY));
                }
                break;
            }
            case "linear": {
                // Objects arranged along a line (like along a road)
                float lineAngle = (float)rng.NextDouble() * MathF.PI;
                for (int i = 0; i < totalToPlace; i++) {
                    float t = (i - totalToPlace / 2f) * spacing * 0.6f;
                    float perpJitter = ((float)rng.NextDouble() - 0.5f) * spacing * 0.3f;
                    float alongJitter = ((float)rng.NextDouble() - 0.5f) * 3f;
                    positions.Add((
                        centerX + MathF.Cos(lineAngle) * (t + alongJitter) +
                            MathF.Sin(lineAngle) * perpJitter,
                        centerY + MathF.Sin(lineAngle) * (t + alongJitter) -
                            MathF.Cos(lineAngle) * perpJitter));
                }
                break;
            }
            case "circular": {
                // Objects arranged in a ring
                for (int i = 0; i < totalToPlace; i++) {
                    float angle = (float)i / totalToPlace * MathF.PI * 2f;
                    float radius = template.MinDistFromCenter + spacing * 0.5f;
                    float jitterR = ((float)rng.NextDouble() - 0.5f) * spacing * 0.2f;
                    float jitterA = ((float)rng.NextDouble() - 0.5f) * 0.3f;
                    positions.Add((
                        centerX + MathF.Cos(angle + jitterA) * (radius + jitterR),
                        centerY + MathF.Sin(angle + jitterA) * (radius + jitterR)));
                }
                break;
            }
            case "grid": {
                // Regular grid with jitter
                int gridSide = (int)MathF.Ceiling(MathF.Sqrt(totalToPlace));
                float gridSpacing = spacing * 0.8f;
                float gridOffset = -gridSide * gridSpacing / 2f;
                for (int gx = 0; gx < gridSide && positions.Count < totalToPlace; gx++) {
                    for (int gy = 0; gy < gridSide && positions.Count < totalToPlace; gy++) {
                        float jitterX = ((float)rng.NextDouble() - 0.5f) * gridSpacing * 0.3f;
                        float jitterY = ((float)rng.NextDouble() - 0.5f) * gridSpacing * 0.3f;
                        positions.Add((
                            centerX + gridOffset + gx * gridSpacing + jitterX,
                            centerY + gridOffset + gy * gridSpacing + jitterY));
                    }
                }
                break;
            }
        }

        // â”€â”€â”€ 6. Place objects with collision detection + Z-snap â”€â”€â”€
        Console.Error.WriteLine($"[GenerateSettlement] Placing {totalToPlace} objects...");

        // Check for existing objects in the area using QueryRadius
        var existingObjects = new List<(float x, float y)>();
        try {
            var nearby = QueryRadius(centerX, centerY, template.SpacingMax * 2f);
            foreach (var obj in nearby.Objects)
                existingObjects.Add((obj.Object.Origin.X, obj.Object.Origin.Y));
        } catch { /* non-fatal */ }

        // Track placed positions for collision avoidance
        var placedPositions = new List<(float x, float y)>(existingObjects);
        var (terrainDoc, terrainLookup, heightLookup) = GetTerrainHelpers();

        int posIdx = 0;
        for (int s = 0; s < template.Slots.Count; s++) {
            var slot = template.Slots[s];
            var candidates = slotObjectLists[s];
            int count = slotCounts[s];

            for (int i = 0; i < count && posIdx < positions.Count; i++) {
                var (px, py) = positions[posIdx++];

                // â”€â”€ Collision detection: ensure minimum spacing from all placed objects â”€â”€
                float minCollisionDist = template.SpacingMin * 0.5f;
                bool collision = false;
                int attempts = 0;
                while (attempts < 5) {
                    collision = false;
                    foreach (var (ex, ey) in placedPositions) {
                        float dist = MathF.Sqrt((px - ex) * (px - ex) + (py - ey) * (py - ey));
                        if (dist < minCollisionDist) {
                            collision = true;
                            break;
                        }
                    }
                    if (!collision) break;

                    // Nudge position and retry
                    px += ((float)rng.NextDouble() - 0.5f) * template.SpacingMin;
                    py += ((float)rng.NextDouble() - 0.5f) * template.SpacingMin;
                    attempts++;
                }

                if (collision) {
                    constraintViolations++;
                    warnings.Add($"Collision at ({px:F1}, {py:F1}) after 5 tries â€” placing anyway");
                }

                // â”€â”€ Snap Z to terrain height â”€â”€
                float pz = 0f;
                try {
                    pz = heightLookup(px, py);
                } catch {
                    warnings.Add($"Could not snap Z to terrain at ({px:F1}, {py:F1})");
                }

                // â”€â”€ Compute orientation â”€â”€
                float yawDeg;
                if (slot.FaceCenter) {
                    // Face toward settlement center
                    float dx = centerX - px;
                    float dy = centerY - py;
                    yawDeg = MathF.Atan2(dy, dx) * (180f / MathF.PI);
                } else {
                    // Random rotation for scenery/props
                    yawDeg = (float)rng.NextDouble() * 360f;
                }
                var orientation = Quaternion.CreateFromAxisAngle(
                    Vector3.UnitZ, yawDeg * MathF.PI / 180f);

                // â”€â”€ Select random object from candidates â”€â”€
                var (objectId, category, name) = candidates[rng.Next(candidates.Count)];

                // â”€â”€ Determine which landblock this goes into â”€â”€
                uint objLbX = (uint)(px / 192f);
                uint objLbY = (uint)(py / 192f);

                // Skip positions that fall outside the world grid (e.g. a collision
                // nudge pushed them past the edge) so AddObject can't wrap the LbKey.
                if (objLbX > 254 || objLbY > 254) {
                    constraintViolations++;
                    warnings.Add($"Skipped object at ({px:F1}, {py:F1}) â€” outside the world grid.");
                    continue;
                }

                // â”€â”€ Place the object â”€â”€
                try {
                    var r = AddObject(objLbX, objLbY, objectId, px, py, pz,
                        orientation, Vector3.One, false);

                    placedObjects.Add(new PlacedSettlementObject(
                        objectId, $"0x{objectId:X8}",
                        px, py, pz,
                        category, name,
                        MathF.Round(yawDeg, 1)));

                    placedPositions.Add((px, py));
                } catch (Exception ex) {
                    constraintViolations++;
                    warnings.Add($"Failed to place 0x{objectId:X8} at ({px:F1}, {py:F1}): {ex.Message}");
                }
            }
        }

        // â”€â”€â”€ 7. Validate terrain slope at placement points â”€â”€â”€
        var ht = GetHeightTable();
        int steepPlacements = 0;
        foreach (var po in placedObjects) {
            try {
                var vi = _terrainService.WorldToVertex(po.X, po.Y);
                if (vi.HasValue) {
                    var data = terrainDoc.GetLandblockInternal(vi.Value.LandblockKey);
                    if (data != null) {
                        int vIdx = vi.Value.VertexIndex;
                        int vx = vIdx / 9, vy = vIdx % 9;
                        float hCenter = ht[data[vIdx].Height];
                        float maxDelta = 0f;
                        if (vx > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - ht[data[(vx - 1) * 9 + vy].Height]));
                        if (vx < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - ht[data[(vx + 1) * 9 + vy].Height]));
                        if (vy > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - ht[data[vx * 9 + (vy - 1)].Height]));
                        if (vy < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - ht[data[vx * 9 + (vy + 1)].Height]));
                        float slopeDeg = MathF.Atan2(maxDelta, 24f) * (180f / MathF.PI);
                        if (slopeDeg > 25f) steepPlacements++;
                    }
                }
            } catch { /* non-fatal */ }
        }

        if (steepPlacements > 0) {
            constraintViolations += steepPlacements;
            warnings.Add($"{steepPlacements} object(s) placed on steep terrain (slope > 25Â°)");
        }

        sw.Stop();
        double totalMs = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Console.Error.WriteLine($"[GenerateSettlement] Complete: {placedObjects.Count} objects placed, " +
                          $"{constraintViolations} violations, {totalMs}ms");

        return new GenerateSettlementResult(
            Success: placedObjects.Count > 0,
            TemplateName: template.Name,
            ObjectsPlaced: placedObjects.Count,
            ConstraintViolations: constraintViolations,
            Warnings: warnings,
            PlacedObjects: placedObjects,
            ElapsedMs: totalMs);
    }

    /// <summary>
    /// Returns the list of available settlement template names.
    /// </summary>
    public string[] GetSettlementTemplateNames() =>
        SettlementTemplates.Select(t => t.Name).ToArray();

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Phase 10.5a â€” Extract Retail Heightmaps
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// <summary>
    /// Dumps all landblock heightmaps (9Ã—9 vertex grid) as JSONL for GPU terrain model training.
    /// Each line contains height indices, world heights, terrain types, and road flags.
    /// </summary>
    public ExtractHeightmapsResult ExtractRetailHeightmaps(string outputPath) {
        RequireProject();
        var sw = new System.Diagnostics.Stopwatch();
        sw.Start();

        if (string.IsNullOrEmpty(outputPath))
            outputPath = "pipeline_data/heightmaps/retail_heightmaps.jsonl";

        var terrainDoc = GetTerrainDoc();
        var ht = GetHeightTable();

        int totalScanned = 0;
        int populated = 0;

        try {
            var outDir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(outDir))
                Directory.CreateDirectory(outDir);
            using var writer = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);

            for (uint lbX = 0; lbX <= 254; lbX++) {
                for (uint lbY = 0; lbY <= 254; lbY++) {
                    totalScanned++;
                    ushort lbKey = LbKey(lbX, lbY);
                    var data = terrainDoc.GetLandblockInternal(lbKey);
                    if (data == null) continue;

                    // Extract 81 vertices: height indices, world heights, terrain types, road flags
                    var heightIndices = new int[81];
                    var heightsWorld = new double[81];
                    var terrainTypes = new int[81];
                    var roadFlags = new int[81];

                    for (int i = 0; i < 81; i++) {
                        heightIndices[i] = data[i].Height;
                        heightsWorld[i] = Math.Round(ht[data[i].Height], 2);
                        terrainTypes[i] = data[i].Type;
                        roadFlags[i] = data[i].Road;
                    }

                    var line = new {
                        lbX = (int)lbX,
                        lbY = (int)lbY,
                        lbKey = $"0x{lbKey:X4}",
                        heightIndices,
                        heightsWorld,
                        terrainTypes,
                        roadFlags
                    };

                    writer.WriteLine(System.Text.Json.JsonSerializer.Serialize(line, WorldBuilder.Shared.Lib.JsonOpts.CamelCaseCompactIgnoreNull));
                    populated++;
                }

                if (lbX % 50 == 0 && lbX > 0)
                    Console.Error.WriteLine($"[ExtractRetailHeightmaps] ...row {lbX}/254, {populated} landblocks exported");
            }
        } catch (Exception ex) {
            sw.Stop();
            return new ExtractHeightmapsResult(false, totalScanned, populated,
                Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath, ex.Message);
        }

        sw.Stop();
        double elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Console.Error.WriteLine($"[ExtractRetailHeightmaps] Complete: {populated} landblocks exported in {elapsedMs}ms â†’ {outputPath}");

        return new ExtractHeightmapsResult(true, totalScanned, populated, elapsedMs, outputPath);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Phase 10.5a â€” Compute Vanilla Baseline
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// <summary>
    /// Computes reference quality metrics from the retail data for use as quality gates
    /// during procedural generation. Scans all 255Ã—255 landblocks for object density,
    /// category breakdown, macro-region statistics, terrain distribution, height histogram,
    /// and road coverage.
    /// </summary>
    public VanillaBaselineResult ComputeVanillaBaseline(string outputPath) {
        RequireProject();
        var sw = new System.Diagnostics.Stopwatch();
        sw.Start();

        if (string.IsNullOrEmpty(outputPath))
            outputPath = "pipeline_data/enrichment/retail_baseline.json";

        var terrainDoc = GetTerrainDoc();
        var ht = GetHeightTable();
        bool ontologyScanned = _ontologyService.IsScanned;

        // â”€â”€â”€ Accumulators â”€â”€â”€
        var objectCounts = new List<int>();           // per-landblock object count (populated only)
        var categoryCounts = new Dictionary<string, int> {
            ["Scenery"] = 0, ["Prop"] = 0, ["Structure"] = 0,
            ["Furniture"] = 0, ["Creature"] = 0, ["NPC"] = 0, ["Portal"] = 0,
            ["Unknown"] = 0
        };

        // Macro-region accumulators (8Ã—8 grid, each ~32Ã—32 landblocks)
        int macroGridSize = 8;
        int regionLbSize = 32; // ~255 / 8
        var regionObjectTotals = new int[macroGridSize, macroGridSize];
        var regionLbCounts = new int[macroGridSize, macroGridSize];

        // Terrain type frequency across all vertices
        var terrainTypeFreq = new Dictionary<int, long>();
        // Height histogram: 16 buckets (each covers 16 height index values: 0-15, 16-31, ...)
        var heightHistogram = new long[16];
        long totalVertices = 0;
        long roadVertices = 0;

        int totalScanned = 0;
        int populatedLandblocks = 0;
        int totalObjects = 0;

        for (uint lbX = 0; lbX <= 254; lbX++) {
            for (uint lbY = 0; lbY <= 254; lbY++) {
                totalScanned++;
                ushort lbKey = LbKey(lbX, lbY);

                // â”€â”€ Terrain metrics â”€â”€
                var data = terrainDoc.GetLandblockInternal(lbKey);
                if (data != null) {
                    for (int i = 0; i < 81; i++) {
                        totalVertices++;

                        int tt = data[i].Type;
                        if (!terrainTypeFreq.ContainsKey(tt)) terrainTypeFreq[tt] = 0;
                        terrainTypeFreq[tt]++;

                        int bucket = data[i].Height / 16;
                        if (bucket > 15) bucket = 15;
                        heightHistogram[bucket]++;

                        if (data[i].Road > 0) roadVertices++;
                    }
                }

                // â”€â”€ Object metrics â”€â”€
                int objectCount = 0;
                try {
                    var lbDoc = GetLandblockDoc(lbKey);
                    var objects = lbDoc.GetStaticObjects().ToList();
                    objectCount = objects.Count;

                    if (objectCount > 0) {
                        totalObjects += objectCount;
                        objectCounts.Add(objectCount);
                        populatedLandblocks++;

                        // Macro-region tracking
                        int rx = Math.Min((int)(lbX / regionLbSize), macroGridSize - 1);
                        int ry = Math.Min((int)(lbY / regionLbSize), macroGridSize - 1);
                        regionObjectTotals[rx, ry] += objectCount;
                        regionLbCounts[rx, ry]++;

                        // Category breakdown
                        if (ontologyScanned) {
                            foreach (var obj in objects) {
                                var entry = _ontologyService.GetEntry(obj.Id);
                                string cat = entry?.Category ?? "Unknown";
                                if (categoryCounts.ContainsKey(cat))
                                    categoryCounts[cat]++;
                                else
                                    categoryCounts["Unknown"]++;
                            }
                        }
                    }
                } catch { /* not all landblocks have associated documents */ }
            }

            if (lbX % 50 == 0 && lbX > 0)
                Console.Error.WriteLine($"[ComputeVanillaBaseline] ...row {lbX}/254, {populatedLandblocks} populated, {totalObjects} objects");
        }

        // â”€â”€â”€ Compute statistics â”€â”€â”€
        double mean = 0, median = 0, stddev = 0;
        int minCount = 0, maxCount = 0;

        if (objectCounts.Count > 0) {
            objectCounts.Sort();
            mean = objectCounts.Average();
            median = objectCounts.Count % 2 == 0
                ? (objectCounts[objectCounts.Count / 2 - 1] + objectCounts[objectCounts.Count / 2]) / 2.0
                : objectCounts[objectCounts.Count / 2];
            minCount = objectCounts[0];
            maxCount = objectCounts[^1];
            double sumSqDiff = objectCounts.Sum(c => (c - mean) * (c - mean));
            stddev = Math.Sqrt(sumSqDiff / objectCounts.Count);
        }

        // Build macro-region data
        var regionStats = new List<object>();
        for (int rx = 0; rx < macroGridSize; rx++) {
            for (int ry = 0; ry < macroGridSize; ry++) {
                int lbCount = regionLbCounts[rx, ry];
                double avgDensity = lbCount > 0 ? (double)regionObjectTotals[rx, ry] / lbCount : 0;
                regionStats.Add(new {
                    regionX = rx,
                    regionY = ry,
                    lbRangeX = $"{rx * regionLbSize}-{Math.Min((rx + 1) * regionLbSize - 1, 254)}",
                    lbRangeY = $"{ry * regionLbSize}-{Math.Min((ry + 1) * regionLbSize - 1, 254)}",
                    populatedLandblocks = lbCount,
                    totalObjects = regionObjectTotals[rx, ry],
                    avgObjectDensity = Math.Round(avgDensity, 2)
                });
            }
        }

        // Build terrain type distribution
        var terrainDist = terrainTypeFreq.OrderBy(kv => kv.Key)
            .Select(kv => new {
                typeIndex = kv.Key,
                count = kv.Value,
                percentage = totalVertices > 0 ? Math.Round(100.0 * kv.Value / totalVertices, 2) : 0
            }).ToArray();

        // Build height histogram
        var heightBuckets = new object[16];
        for (int b = 0; b < 16; b++) {
            heightBuckets[b] = new {
                bucketIndex = b,
                rangeMin = b * 16,
                rangeMax = Math.Min((b + 1) * 16 - 1, 255),
                count = heightHistogram[b],
                percentage = totalVertices > 0 ? Math.Round(100.0 * heightHistogram[b] / totalVertices, 2) : 0
            };
        }

        double roadCoverage = totalVertices > 0 ? Math.Round(100.0 * roadVertices / totalVertices, 4) : 0;

        // â”€â”€â”€ Build final JSON output â”€â”€â”€
        var baseline = new {
            metadata = new {
                generatedAt = DateTime.UtcNow.ToString("o"),
                baseDatDirectory = _projectManager.CurrentProject!.BaseDatDirectory,
                projectName = _projectManager.CurrentProject!.Name,
                warning = "computes from the loaded project — run against an unmodified vanilla project for a true retail baseline.",
                landblocksScanned = totalScanned,
                populatedLandblocks,
                totalObjects,
                totalVertices
            },
            objectDensity = new {
                mean = Math.Round(mean, 2),
                median,
                stddev = Math.Round(stddev, 2),
                min = minCount,
                max = maxCount,
                populatedLandblocks
            },
            objectDensityByCategory = categoryCounts.Where(kv => kv.Value > 0)
                .OrderByDescending(kv => kv.Value)
                .Select(kv => new { category = kv.Key, count = kv.Value })
                .ToArray(),
            macroRegions = regionStats,
            terrainTypeDistribution = terrainDist,
            heightDistribution = heightBuckets,
            roadCoverage = new {
                totalVertices,
                roadVertices,
                coveragePercent = roadCoverage
            }
        };

        try {
            var json = System.Text.Json.JsonSerializer.Serialize(baseline,
                WorldBuilder.Shared.Lib.JsonOpts.CamelCaseIndented);

            // Ensure output directory exists for non-simple filenames
            var dir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);

            File.WriteAllText(outputPath, json, System.Text.Encoding.UTF8);
        } catch (Exception ex) {
            sw.Stop();
            return new VanillaBaselineResult(false, totalScanned, populatedLandblocks, totalObjects,
                Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath, ex.Message);
        }

        sw.Stop();
        double elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Console.Error.WriteLine($"[ComputeVanillaBaseline] Complete: {populatedLandblocks} populated landblocks, " +
                          $"{totalObjects} objects, {elapsedMs}ms â†’ {outputPath}");

        return new VanillaBaselineResult(true, totalScanned, populatedLandblocks, totalObjects,
            elapsedMs, outputPath);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Calibrate World Map â€” Build Colorâ†’Terrain Codebook
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// <summary>
    /// Builds a calibration codebook by reading terrain base colors from the DAT
    /// textures (replicating Mapper.cs GetMapColors logic) and scanning all retail
    /// terrain data to build per-terrain-type brightnessâ†’height lookup tables.
    ///
    /// The codebook encodes the deterministic relationship between the world map
    /// renderer's pixel colors and the underlying terrain data, enabling reverse
    /// engineering of new world map images.
    /// </summary>
    public CalibrateWorldMapResult CalibrateWorldMap(string outputPath) {
        RequireProject();
        var sw = new System.Diagnostics.Stopwatch();
        sw.Start();

        if (string.IsNullOrEmpty(outputPath))
            outputPath = "pipeline_data/enrichment/terrain_codebook.json";

        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        // â”€â”€â”€ 1. Extract terrain base colors from DAT textures â”€â”€â”€
        // This replicates ACViewer Mapper.cs GetMapColors() using DatReaderWriter
        Console.WriteLine("[CalibrateWorldMap] Extracting terrain base colors from DAT textures...");

        if (!dats.TryGet<DatReaderWriter.DBObjs.Region>(0x13000000, out var region)) {
            sw.Stop();
            return new CalibrateWorldMapResult(false, 0, 0, 0,
                Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath,
                "Failed to load Region 0x13000000 from DATs");
        }

        var terrainDescs = region.TerrainInfo?.LandSurfaces?.TexMerge?.TerrainDesc;
        if (terrainDescs == null || terrainDescs.Count == 0) {
            sw.Stop();
            return new CalibrateWorldMapResult(false, 0, 0, 0,
                Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath,
                "No TerrainDesc entries found in Region");
        }

        // Build terrain base colors (average color per texture, matching Mapper.cs)
        var baseColors = new Dictionary<int, (int r, int g, int b, string name)>();
        // Road type (index 32 in the Mapper) is special
        int roadTypeIndex = 32;

        for (int i = 0; i < terrainDescs.Count; i++) {
            var tmDesc = terrainDescs[i];
            int typeIndex = (int)tmDesc.TerrainType;
            // Road type maps to index 32 in the Mapper
            if (tmDesc.TerrainType == DatReaderWriter.Enums.TerrainTextureType.RoadType)
                typeIndex = roadTypeIndex;

            string typeName;
            try { typeName = tmDesc.TerrainType.ToString(); }
            catch { typeName = $"Type{typeIndex}"; }

            if (!dats.TryGet<DatReaderWriter.DBObjs.SurfaceTexture>(tmDesc.TerrainTex.TextureId, out var st) ||
                st.Textures.Count == 0) {
                Console.WriteLine($"[CalibrateWorldMap] Warning: failed to load SurfaceTexture for type {typeIndex} ({typeName})");
                continue;
            }

            var textureId = st.Textures[^1]; // Last (highest-res) mip
            if (!dats.TryGet<DatReaderWriter.DBObjs.RenderSurface>(textureId, out var rs) || rs.SourceData == null) {
                Console.WriteLine($"[CalibrateWorldMap] Warning: failed to load RenderSurface 0x{textureId:X8} for type {typeIndex}");
                continue;
            }

            // Compute average color from texture (matching Mapper.cs GetAverageColor)
            // RenderSurface SourceData is BGRA format
            long totalR = 0, totalG = 0, totalB = 0;
            int pixelCount = rs.Width * rs.Height;
            var srcData = rs.SourceData;

            for (int p = 0; p < pixelCount; p++) {
                int offset = p * 4;
                // BGRA layout in SourceData â€” note: Mapper.cs has a documented
                // R/B swap quirk. We replicate the same swap so our colors match
                // the rendered world_map.png pixels exactly.
                totalR += srcData[offset + 0]; // B channel â†’ treated as R by Mapper
                totalG += srcData[offset + 1]; // G
                totalB += srcData[offset + 2]; // R channel â†’ treated as B by Mapper
            }

            int avgR = (int)(totalR / pixelCount);
            int avgG = (int)(totalG / pixelCount);
            int avgB = (int)(totalB / pixelCount);

            baseColors[typeIndex] = (avgR, avgG, avgB, typeName);
            Console.WriteLine($"[CalibrateWorldMap]   Type {typeIndex,2} {typeName,-24} â†’ RGB({avgR,3},{avgG,3},{avgB,3})");
        }

        Console.WriteLine($"[CalibrateWorldMap] Extracted {baseColors.Count} terrain base colors");

        // â”€â”€â”€ 2. Scan retail terrain data: build brightnessâ†’height lookup per type â”€â”€â”€
        Console.WriteLine("[CalibrateWorldMap] Scanning retail terrain data for height calibration...");

        var terrainDoc = GetTerrainDoc();
        var ht = GetHeightTable();

        // For each terrain type, collect all observed (heightIndex) values
        // This lets us build a height distribution that can be queried by brightness
        var heightsByType = new Dictionary<int, List<byte>>();

        int landblocksProcessed = 0;
        int verticesCalibrated = 0;

        for (uint lbX = 0; lbX <= 254; lbX++) {
            for (uint lbY = 0; lbY <= 254; lbY++) {
                ushort lbKey = LbKey(lbX, lbY);
                var data = terrainDoc.GetLandblockInternal(lbKey);
                if (data == null) continue;

                landblocksProcessed++;

                for (int ii = 0; ii < 81; ii++) {
                    int terrainType = data[ii].Type;
                    byte heightIdx = data[ii].Height;

                    if (!heightsByType.TryGetValue(terrainType, out var list)) {
                        list = new List<byte>(8192);
                        heightsByType[terrainType] = list;
                    }
                    list.Add(heightIdx);
                    verticesCalibrated++;
                }
            }

            if (lbX % 50 == 0 && lbX > 0)
                Console.WriteLine($"[CalibrateWorldMap]   ...row {lbX}/254, {landblocksProcessed} landblocks, {verticesCalibrated} vertices");
        }

        // â”€â”€â”€ 3. Build brightnessâ†’height mapping per terrain type â”€â”€â”€
        Console.WriteLine("[CalibrateWorldMap] Building brightnessâ†’height mappings...");

        var brightnessToHeight = new Dictionary<int, object>();
        foreach (var (typeIdx, heights) in heightsByType) {
            if (heights.Count == 0) continue;

            heights.Sort();
            double mean = heights.Average(h => (double)h);
            byte median = heights[heights.Count / 2];
            byte min = heights[0];
            byte max = heights[^1];

            // Build a percentile table for efficient lookup
            // 101 entries: percentile 0, 1, 2, ..., 100
            var percentiles = new byte[101];
            for (int p = 0; p <= 100; p++) {
                int idx = Math.Min((int)(p / 100.0 * (heights.Count - 1)), heights.Count - 1);
                percentiles[p] = heights[idx];
            }

            brightnessToHeight[typeIdx] = new {
                samples = heights.Count,
                mean = Math.Round(mean, 2),
                median,
                min,
                max,
                percentiles
            };
        }

        // â”€â”€â”€ 4. Also record the Mapper.cs lighting constants for documentation â”€â”€â”€
        var lightingConstants = new {
            colorCorrection = 0.7,
            lightCorrection = 2.25,
            ambientLight = 0.25,
            lightVector = new[] { -1.0, -1.0, 0.0 },
            note = "These are the constants used by ACViewer Mapper.cs to shade the world map"
        };

        // â”€â”€â”€ 5. Write codebook JSON â”€â”€â”€
        Console.WriteLine($"[CalibrateWorldMap] Writing codebook to {outputPath}...");

        try {
            var baseColorsList = baseColors.OrderBy(kv => kv.Key).Select(kv => new {
                typeIndex = kv.Key,
                typeName = kv.Value.name,
                baseR = kv.Value.r,
                baseG = kv.Value.g,
                baseB = kv.Value.b,
                // Pre-compute brightness for easier lookup during application
                brightness = Math.Round((kv.Value.r + kv.Value.g + kv.Value.b) / (3.0 * 255.0), 4)
            }).ToArray();

            var codebook = new {
                metadata = new {
                    generatedAt = DateTime.UtcNow.ToString("o"),
                    description = "Terrain colorâ†’height codebook for reverse-engineering world map images",
                    terrainTypesFound = baseColors.Count,
                    verticesCalibrated,
                    landblocksProcessed
                },
                terrainBaseColors = baseColorsList,
                heightDistributions = brightnessToHeight.OrderBy(kv => kv.Key)
                    .Select(kv => new { typeIndex = kv.Key, data = kv.Value })
                    .ToArray(),
                lightingConstants,
                heightTable = ht
            };

            var dir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);

            var json = System.Text.Json.JsonSerializer.Serialize(codebook,
                WorldBuilder.Shared.Lib.JsonOpts.CamelCaseIndented);
            File.WriteAllText(outputPath, json, System.Text.Encoding.UTF8);
        } catch (Exception ex) {
            sw.Stop();
            return new CalibrateWorldMapResult(false, baseColors.Count, verticesCalibrated,
                landblocksProcessed, Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath, ex.Message);
        }

        sw.Stop();
        double elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Console.WriteLine($"[CalibrateWorldMap] Complete: {baseColors.Count} types, {verticesCalibrated} vertices " +
                          $"in {elapsedMs}ms â†’ {outputPath}");

        return new CalibrateWorldMapResult(true, baseColors.Count, verticesCalibrated,
            landblocksProcessed, elapsedMs, outputPath);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Quick World â€” Reverse-Engineer World from Map Image
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// <summary>
    /// Fallback scenery table used when the loaded codebook does not declare a
    /// <c>scenery</c> block. These are the retail Setup IDs the original POC shipped with.
    /// New codebooks should populate <see cref="QuickWorldHelpers.Codebook.SceneryByType"/>
    /// instead so scenery is data-driven end-to-end.
    /// </summary>
    private static readonly IReadOnlyDictionary<int, uint[]> DefaultSceneryByType = new Dictionary<int, uint[]> {
        [0x03] = new uint[] { 0x02000B53, 0x02000B57, 0x02000BE0, 0x02000BDE, 0x02000B5B }, // LushGrass
        [0x01] = new uint[] { 0x02000B53, 0x02000B5B, 0x02000BD7, 0x02000BD8 },              // Grassland
        [0x0E] = new uint[] { 0x02000B95, 0x02000B97, 0x02000B99 },                           // SemiBarrenRock
        [0x00] = new uint[] { 0x02000B95, 0x02000B97 },                                       // BarrenRock
        [0x0A] = new uint[] { 0x02000B95, 0x02000BD7 },                                       // SandYellow
        [0x0F] = new uint[] { 0x02000BDE, 0x02000B95 },                                       // Snow
        [0x04] = new uint[] { 0x02000B53, 0x02000BD7 },                                       // MarshSparseSwamp
        [0x06] = new uint[] { 0x02000B95, 0x02000B97 },                                       // ObsidianPlain
    };

    /// <summary>
    /// Reverse-engineers terrain from a world map image using a calibration codebook.
    ///
    /// For each pixel/vertex in the new image:
    ///   1. Classifies terrain type by matching the pixel's color ratios to the
    ///      codebook's base terrain colors (nearest Euclidean distance in RGB).
    ///   2. Estimates height by comparing the pixel's brightness to the terrain
    ///      type's height distribution from the calibration data.
    ///   3. Writes 81 TerrainEntry values per landblock (9Ã—9 vertex grid).
    ///
    /// If the image is 2041Ã—2041, resolution is 1 pixel per vertex (exact).
    /// Other sizes are bilinearly scaled to match the vertex grid.
    /// </summary>
    public QuickWorldResult QuickWorld(string biomeMapPath, string worldMapImagePath,
        int? seed = null) {
        RequireProject();
        var sw = new System.Diagnostics.Stopwatch();
        sw.Start();

        // Magic numbers from this method, hoisted to named constants.
        const int VERTEX_GRID = 2041;                  // 255 landblocks × 8 cells + 1 edge pixel
        const float LANDBLOCK_SIZE = 192f;
        const float CELL_SIZE = 24f;
        const float SCENERY_EDGE_MARGIN = CELL_SIZE;   // Keep one cell of margin from landblock edges

        // noiseSeed drives both the coherent height jitter (Phase 1) and the per-landblock
        // scenery PRNG (Phase 3). Pinned at the top of the method so unseeded runs are still
        // internally consistent — every vertex and every LB sees the same noise key.
        int noiseSeed = seed ?? new Random().Next();

        // â”€â”€â”€ 1. Load codebook (terrain_codebook.json) â”€â”€â”€
        Console.WriteLine($"[QuickWorld] Loading codebook: {biomeMapPath}");
        if (!File.Exists(biomeMapPath)) {
            sw.Stop();
            return new QuickWorldResult(false, 0, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                $"Codebook not found: {biomeMapPath}");
        }

        QuickWorldHelpers.Codebook codebook;
        try {
            var jsonText = File.ReadAllText(biomeMapPath);
            codebook = QuickWorldHelpers.ParseCodebook(jsonText,
                warning => Console.WriteLine($"[QuickWorld] Warning: {warning}"));
        } catch (Exception ex) {
            sw.Stop();
            return new QuickWorldResult(false, 0, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                $"Failed to parse codebook: {ex.Message}");
        }

        if (codebook.Colors.Count == 0) {
            sw.Stop();
            return new QuickWorldResult(false, 0, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                "Codebook contains no terrain base colors");
        }

        Console.WriteLine($"[QuickWorld] Codebook: {codebook.Colors.Count} terrain types, " +
                          $"{codebook.HeightPercentiles.Count} height distributions");

        // â”€â”€â”€ 2. Load world map image â”€â”€â”€
        Console.WriteLine($"[QuickWorld] Loading world map image: {worldMapImagePath}");
        if (!File.Exists(worldMapImagePath)) {
            sw.Stop();
            return new QuickWorldResult(false, 0, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                $"World map image not found: {worldMapImagePath}");
        }

        // Read all pixels into a managed array up front: SKBitmap.GetPixel is a per-call native
        // interop hop (~5.3M calls in the loop below), whereas Pixels copies once and lets us
        // index directly. After this block we no longer need the bitmap.
        SkiaSharp.SKColor[] pixels;
        int imgW, imgH;
        try {
            using var imgData = SkiaSharp.SKData.Create(worldMapImagePath);
            using var bitmap = SkiaSharp.SKBitmap.Decode(imgData);
            if (bitmap == null) throw new Exception("Failed to decode image");
            imgW = bitmap.Width;
            imgH = bitmap.Height;
            pixels = bitmap.Pixels;
        } catch (Exception ex) {
            sw.Stop();
            return new QuickWorldResult(false, 0, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                $"Failed to load image: {ex.Message}");
        }

        // The AC world map is 2041 pixels (255*8+1) â€” one pixel per terrain vertex.
        // Scale factor for non-standard image sizes (VERTEX_GRID is declared at the top of the method):
        double scaleX = (double)imgW / VERTEX_GRID;
        double scaleY = (double)imgH / VERTEX_GRID;
        bool isExact = (imgW == VERTEX_GRID && imgH == VERTEX_GRID);

        Console.WriteLine($"[QuickWorld] Image: {imgW}Ã—{imgH}, scale: {scaleX:F3}Ã—{scaleY:F3}" +
                          (isExact ? " (exact vertex resolution)" : " (scaled)"));

        // â”€â”€â”€ 3. Stamp each landblock (parallel in-memory pass) â”€â”€â”€
        var terrainDoc = GetTerrainDoc();
        int stamped = 0;
        int skipped = 0;
        int objectsPlaced = 0;
        int approximateMatches = 0;
        var terrainTypesCounted = new Dictionary<string, int>();

        // Codebook already pre-computes the filtered classification list and typeIndex → name lookup.
        var classificationColors = codebook.ClassificationColors;
        if (classificationColors.Count == 0) {
            sw.Stop();
            return new QuickWorldResult(false, 0, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                $"Codebook contains no usable terrain colors (all entries are excluded type {QuickWorldHelpers.EXCLUDED_TERRAIN_TYPE})");
        }
        var typeNameById = codebook.NameByTypeIndex;

        // Phase 1 writes to these from many threads; ConcurrentDictionary handles the contention.
        var allChanges = new System.Collections.Concurrent.ConcurrentDictionary<ushort, Dictionary<byte, uint>>();
        var newEntriesMap = new System.Collections.Concurrent.ConcurrentDictionary<ushort, TerrainEntry[]>();
        var dominantTypes = new System.Collections.Concurrent.ConcurrentDictionary<ushort, int>();
        var terrainTypesConc = new System.Collections.Concurrent.ConcurrentDictionary<string, int>();

        const int LANDBLOCK_VERTEX_COUNT = 81;
        // Cap at physical cores. Empirically, Phase 3 with per-thread DAT readers peaks at
        // parallelism = physical-core-count and degrades past that (cache thrash + scheduling
        // overhead exceed any IO parallelism gain). Phase 1 is CPU-bound and benefits similarly
        // from staying within physical cores. Environment.ProcessorCount returns *logical* cores
        // (2× on hyperthreaded systems), which used to over-subscribe both phases.
        int physicalCores = WorldBuilder.Shared.Lib.HardwareInfo.PhysicalCoreCount;
        int parallelism = Math.Max(1, physicalCores);
        Console.WriteLine($"[QuickWorld] Phase 1: Parallelizing across {parallelism} threads " +
                          $"(physical cores: {physicalCores}, logical cores: {System.Environment.ProcessorCount}, " +
                          $"255×255 landblocks)...");

        // Counters shared across worker threads; only touched via Interlocked.
        int skippedCounter = 0;
        int stampedCounter = 0;
        int approxMatchCounter = 0;
        int reportedSkipMessages = 0;

        System.Threading.Tasks.Parallel.ForEach(
            System.Collections.Concurrent.Partitioner.Create(0, 255),
            new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = parallelism },
            // localInit: each thread gets its own typeCounts buffer. Height jitter is now derived
            // from CoherentJitter(noiseSeed, globalVertexX, globalVertexY) so it's both deterministic
            // and identical for the seam vertex shared by adjacent landblocks — no per-thread or
            // per-LB Random needed in Phase 1.
            () => new {
                TypeCounts = new Dictionary<int, int>(classificationColors.Count),
            },
            (range, _, threadCtx) => {
                Span<TerrainEntry> currentData = stackalloc TerrainEntry[LANDBLOCK_VERTEX_COUNT];

                for (int lbX = range.Item1; lbX < range.Item2; lbX++) {
                    for (int lbY = 0; lbY < 255; lbY++) {
                        try {
                            ushort lbKey = LbKey((uint)lbX, (uint)lbY);
                            if (!terrainDoc.TryGetLandblockInternal(lbKey, currentData)) {
                                System.Threading.Interlocked.Increment(ref skippedCounter);
                                continue;
                            }

                            var newEntries = new TerrainEntry[LANDBLOCK_VERTEX_COUNT];

                            int dominantType = 0;
                            threadCtx.TypeCounts.Clear();

                            for (int vx = 0; vx < 9; vx++) {
                                for (int vy = 0; vy < 9; vy++) {
                                    int vi = vx * 9 + vy;

                                    // Global vertex coordinates: identical for the seam vertex shared
                                    // between (lbX,*,vx=8) and (lbX+1,*,vx=0), so CoherentJitter below
                                    // returns the same value on both sides. No more boundary discontinuity.
                                    int gx = lbX * 8 + vx;
                                    int gy = lbY * 8 + vy;

                                    int pixX, pixY;
                                    if (isExact) {
                                        pixX = gx;
                                        pixY = VERTEX_GRID - 1 - gy;
                                    } else {
                                        pixX = (int)Math.Round(gx * scaleX);
                                        pixY = (int)Math.Round((VERTEX_GRID - 1 - gy) * scaleY);
                                    }
                                    pixX = Math.Clamp(pixX, 0, imgW - 1);
                                    pixY = Math.Clamp(pixY, 0, imgH - 1);

                                    var pixel = pixels[pixY * imgW + pixX];
                                    int pr = pixel.Red, pg = pixel.Green, pb = pixel.Blue;

                                    int bestType = QuickWorldHelpers.ClassifyPixel(pr, pg, pb, classificationColors, out var bestDist);
                                    if (bestDist > QuickWorldHelpers.APPROX_MATCH_DIST_SQ)
                                        System.Threading.Interlocked.Increment(ref approxMatchCounter);

                                    threadCtx.TypeCounts.TryGetValue(bestType, out var tc);
                                    threadCtx.TypeCounts[bestType] = tc + 1;

                                    double brightness = (pr + pg + pb) / (3.0 * 255.0);
                                    int jitter = QuickWorldHelpers.CoherentJitter(noiseSeed, gx, gy);
                                    byte heightIdx = QuickWorldHelpers.EstimateHeight(bestType, brightness, codebook, jitter);

                                    newEntries[vi] = currentData[vi] with {
                                        Height = heightIdx,
                                        Type = (byte)bestType
                                    };
                                }
                            }

                            var lbChanges = new Dictionary<byte, uint>();
                            for (byte i = 0; i < 81; i++) {
                                if (!currentData[i].Equals(newEntries[i])) {
                                    lbChanges[i] = newEntries[i].ToUInt();
                                }
                            }
                            if (lbChanges.Count > 0) {
                                allChanges[lbKey] = lbChanges;
                                newEntriesMap[lbKey] = newEntries;
                            }
                            System.Threading.Interlocked.Increment(ref stampedCounter);

                            int maxCount = 0;
                            foreach (var (tt, cnt) in threadCtx.TypeCounts) {
                                if (cnt > maxCount) { maxCount = cnt; dominantType = tt; }
                            }
                            dominantTypes[lbKey] = dominantType;
                            string typeName = typeNameById.TryGetValue(dominantType, out var n) ? n : $"Type{dominantType}";
                            terrainTypesConc.AddOrUpdate(typeName, 1, (_, existing) => existing + 1);

                        } catch (Exception ex) {
                            System.Threading.Interlocked.Increment(ref skippedCounter);
                            if (System.Threading.Interlocked.Increment(ref reportedSkipMessages) <= 5)
                                Console.WriteLine($"[QuickWorld] Warning: ({lbX},{lbY}) skipped: {ex.Message}");
                        }
                    }
                }
                return threadCtx;
            },
            _ => { /* no merge needed — concurrent dicts collected everything */ });

        // Hand the per-counter values back to the names the rest of the method already uses.
        skipped = skippedCounter;
        stamped = stampedCounter;
        approximateMatches = approxMatchCounter;
        foreach (var kv in terrainTypesConc) terrainTypesCounted[kv.Key] = kv.Value;

        Console.WriteLine($"[QuickWorld] Phase 1 complete: {allChanges.Count} landblocks with changes computed in memory.");

        // â”€â”€â”€ 4. Bulk-write all terrain changes at once â”€â”€â”€
        Console.WriteLine($"[QuickWorld] Phase 2: Writing {allChanges.Count} landblocks to terrain document (single batch)...");
        // UpdateLandblocksBatchInternal expects a plain Dictionary, so flatten the ConcurrentDictionary at the boundary.
        var allChangesPlain = new Dictionary<ushort, Dictionary<byte, uint>>(allChanges.Count);
        foreach (var kv in allChanges) allChangesPlain[kv.Key] = kv.Value;
        terrainDoc.UpdateLandblocksBatchInternal(allChangesPlain, out _);
        Console.WriteLine($"[QuickWorld] Phase 2 complete: terrain written.");

        // â”€â”€â”€ 5. Scatter scenery objects â”€â”€â”€
        // Scenery models come from the codebook's optional `scenery` block when present
        // (see QuickWorldHelpers.ParseCodebook); the legacy hardcoded retail-ID table is the
        // fallback so older terrain_codebook.json files still produce sensible scenery.
        Console.WriteLine($"[QuickWorld] Phase 3: Scattering scenery objects...");
        IReadOnlyDictionary<int, uint[]> sceneryByType = codebook.SceneryByType.Count > 0
            ? codebook.SceneryByType
            : DefaultSceneryByType;
        Console.WriteLine($"[QuickWorld] Scenery source: " +
            (codebook.SceneryByType.Count > 0 ? $"codebook ({codebook.SceneryByType.Count} types)"
                                              : "built-in retail defaults"));

        // [0, LANDBLOCK_SIZE - 2*SCENERY_EDGE_MARGIN) range for the random offset, centered with the margin.
        const float SCENERY_RANGE = LANDBLOCK_SIZE - 2 * SCENERY_EDGE_MARGIN;
        var heightTable = GetHeightTable();

        // Phase 3 used to be single-threaded, then was parallelized but bottlenecked on the DAT
        // reader's coarse global lock (one shared instance, ~1ms held per TryGet). To remove that
        // bottleneck we hand each worker thread its OWN DefaultDatReaderWriter via Parallel.ForEach's
        // localInit/localFinally — independent file streams, independent internal locks, no
        // cross-thread serialization at the DAT layer. The override flows into LandblockDocument's
        // InitAsync(datreader) so the per-thread reader is used during init.
        //
        // Storage layer: FileStorageService.GetDocumentAsync uses FileShare.Read; concurrent reads
        // of distinct landblock files are safe. Each lbKey maps to a unique LandblockDocument, so
        // AddStaticObject mutations on different LBs touch disjoint state.
        //
        // Per-LB PRNG is seeded from (noiseSeed, lbKey) so output is independent of thread ordering.
        var sceneryKeys = newEntriesMap.Keys.ToArray();
        Array.Sort(sceneryKeys);

        int objectsPlacedCounter = 0;
        int sceneryFailureCounter = 0;
        int sceneryFailMessages = 0;
        int datReaderInitFailures = 0;
        var phase3Sw = System.Diagnostics.Stopwatch.StartNew();
        string baseDatDir = _projectManager.CurrentProject!.BaseDatDirectory;

        System.Threading.Tasks.Parallel.ForEach(
            System.Collections.Concurrent.Partitioner.Create(0, sceneryKeys.Length),
            new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = parallelism },
            // localInit: mint a per-thread read-only DAT reader. If construction fails (e.g.
            // upstream library can't open the DATs concurrently), fall back to the shared
            // manager.Dats so Phase 3 still completes — just at the previous lock-bound speed.
            localInit: () => {
                try { return (IDatReaderWriter?)new DefaultDatReaderWriter(baseDatDir, DatAccessType.Read); }
                catch (Exception ex) {
                    System.Threading.Interlocked.Increment(ref datReaderInitFailures);
                    if (datReaderInitFailures <= 1)
                        Console.WriteLine($"[QuickWorld] Warning: per-thread DAT reader unavailable, falling back to shared reader: {ex.Message}");
                    return null;
                }
            },
            body: (range, _, threadDats) => {
                for (int i = range.Item1; i < range.Item2; i++) {
                    ushort lbKey = sceneryKeys[i];
                    if (!newEntriesMap.TryGetValue(lbKey, out var entries)) continue;
                    if (!dominantTypes.TryGetValue(lbKey, out var domType)) continue;
                    if (!sceneryByType.TryGetValue(domType, out var models) || models.Length == 0) continue;

                    int lbX = (lbKey >> 8) & 0xFF;
                    int lbY = lbKey & 0xFF;

                    try {
                        // Per-LB PRNG: stack-only, deterministic in (noiseSeed, lbKey), no allocations.
                        var lbRng = new QuickWorldHelpers.XorShift32(unchecked((uint)(noiseSeed ^ (lbKey * 0x9E3779B1))));
                        int numScenery = lbRng.Next(1, 5);
                        float worldMinX = lbX * LANDBLOCK_SIZE;
                        float worldMinY = lbY * LANDBLOCK_SIZE;

                        // overrideDats=null falls back to the shared manager.Dats inside GetLandblockDoc.
                        var lbDoc = GetLandblockDoc(lbKey, threadDats);
                        for (int s = 0; s < numScenery; s++) {
                            uint modelId = models[lbRng.Next(models.Length)];
                            float ox = worldMinX + SCENERY_EDGE_MARGIN + (float)lbRng.NextDouble() * SCENERY_RANGE;
                            float oy = worldMinY + SCENERY_EDGE_MARGIN + (float)lbRng.NextDouble() * SCENERY_RANGE;

                            // ox-worldMinX is in [SCENERY_EDGE_MARGIN, LANDBLOCK_SIZE - SCENERY_EDGE_MARGIN);
                            // dividing by CELL_SIZE gives [1, 7) so the resulting vertex index is always
                            // valid â€” the clamp is purely defensive against floating-point rounding at the edges.
                            int gx = Math.Clamp((int)((ox - worldMinX) / CELL_SIZE), 0, 8);
                            int gy = Math.Clamp((int)((oy - worldMinY) / CELL_SIZE), 0, 8);
                            int vi = gx * 9 + gy;
                            float z = heightTable[entries[vi].Height];

                            var obj = new StaticObject {
                                Id = modelId,
                                // AC type prefix is the high byte (0xPPNNNNNN). 0x02 = Setup.
                                IsSetup = (modelId & 0xFF000000u) == 0x02000000u,
                                Origin = new Vector3(ox, oy, z),
                                Orientation = Quaternion.CreateFromAxisAngle(
                                    Vector3.UnitZ, (float)(lbRng.NextDouble() * Math.PI * 2)),
                                Scale = Vector3.One
                            };
                            lbDoc.AddStaticObject(obj);
                            System.Threading.Interlocked.Increment(ref objectsPlacedCounter);
                        }
                    } catch (Exception ex) when (ex is not OutOfMemoryException && ex is not StackOverflowException) {
                        System.Threading.Interlocked.Increment(ref sceneryFailureCounter);
                        if (System.Threading.Interlocked.Increment(ref sceneryFailMessages) <= 3)
                            Console.WriteLine($"[QuickWorld] Warning: scenery scatter failed for ({lbX},{lbY}): {ex.Message}");
                    }
                }
                return threadDats;
            },
            localFinally: threadDats => {
                if (threadDats is IDisposable d) {
                    try { d.Dispose(); } catch { /* swallowed — reader already faulted, nothing to do */ }
                }
            });

        phase3Sw.Stop();
        objectsPlaced = objectsPlacedCounter;
        int sceneryFailures = sceneryFailureCounter;

        if (sceneryFailures > 3)
            Console.WriteLine($"[QuickWorld] Warning: {sceneryFailures - 3} additional scenery-scatter failures (suppressed).");
        Console.WriteLine($"[QuickWorld] Phase 3 complete: {objectsPlaced} objects placed across " +
                          $"{sceneryKeys.Length} candidate landblocks in {phase3Sw.Elapsed.TotalMilliseconds:F0}ms " +
                          $"({parallelism} threads" +
                          (datReaderInitFailures > 0 ? $", {datReaderInitFailures} per-thread reader init failures (fell back to shared reader)" : ", per-thread DAT readers") +
                          ").");

        sw.Stop();
        double elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Console.WriteLine($"[QuickWorld] Complete: {stamped} stamped, " +
                          $"{skipped} skipped, {objectsPlaced} objects, " +
                          $"{approximateMatches} approximate color matches, " +
                          $"{sceneryFailures} scenery failures, {elapsedMs}ms");

        return new QuickWorldResult(true, stamped, skipped, objectsPlaced,
            approximateMatches, sceneryFailures, terrainTypesCounted, elapsedMs);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Image-Driven Terrain â€” Analyze Map Image
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•





    /// <summary>
    /// Analyzes a world map PNG image to produce a 255Ã—255 biome classification grid.
    /// The image (rendered by ACViewer --map) is 2041Ã—2041 pixels where each landblock
    /// occupies an 8Ã—8 pixel region. Each block's average color is classified into
    /// a biome category (ocean, grassland, forest, snow, desert, etc.).
    /// Output: biome_map.json with the full grid, per-cell data, and summary statistics.
    /// </summary>
    public AnalyzeMapImageResult AnalyzeMapImage(string imagePath, string outputPath) {
        var sw = new System.Diagnostics.Stopwatch();
        sw.Start();

        if (string.IsNullOrEmpty(outputPath))
            outputPath = "pipeline_data/enrichment/biome_map.json";

        // â”€â”€â”€ 1. Load the image via SkiaSharp â”€â”€â”€
        if (!File.Exists(imagePath)) {
            sw.Stop();
            return new AnalyzeMapImageResult(false, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                outputPath, $"Image file not found: {imagePath}");
        }

        // Read pixels into a managed array so the inner loop avoids the per-call
        // native interop hop of SKBitmap.GetPixel (255*255*8*8 ≈ 4.2M calls at
        // 1:1 resolution). Mirrors the QuickWorld load path.
        SkiaSharp.SKColor[] pixels;
        int imgW, imgH;
        try {
            using var imgData = SkiaSharp.SKData.Create(imagePath);
            using var bitmap = SkiaSharp.SKBitmap.Decode(imgData);
            if (bitmap == null) throw new Exception("Failed to decode image");
            imgW = bitmap.Width;
            imgH = bitmap.Height;
            pixels = bitmap.Pixels;
        } catch (Exception ex) {
            sw.Stop();
            return new AnalyzeMapImageResult(false, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                outputPath, $"Failed to load image: {ex.Message}");
        }

        Console.WriteLine($"[AnalyzeMapImage] Loaded image: {imgW}Ã—{imgH}");

        // The Mapper creates images at LANDSIZE = 255*8+1 = 2041 pixels.
        // But the screenshot may be at a different resolution (e.g., 1280x720 with auto-scaling).
        // We need to handle arbitrary image sizes by scaling pixel coordinates.

        // â”€â”€â”€ 2. Sample each landblock's 8Ã—8 pixel region â”€â”€â”€
        // The map image coordinate system:
        //   - X axis = landblock X direction (left â†’ right), pixel (startX..startX+7)
        //   - Y axis = INVERTED (top = high lbY, bottom = low lbY) â€” the Mapper draws lbY=254 at top
        // Pixel coordinate for landblock (lbX, lbY):
        //   startX = lbX * 8  (but scaled to image size)
        //   startY = (254 - lbY) * 8  (inverted Y)

        const int GRID = 255;
        var cells = new List<BiomeCellInfo>();
        var biomeCounts = new Dictionary<string, int>();
        int landCells = 0, oceanCells = 0;

        // Scale factors to handle images not exactly 2041Ã—2041
        double scaleX = (double)imgW / 2041.0;
        double scaleY = (double)imgH / 2041.0;

        Console.WriteLine($"[AnalyzeMapImage] Scale factors: X={scaleX:F3}, Y={scaleY:F3}");

        for (int lbX = 0; lbX < GRID; lbX++) {
            for (int lbY = 0; lbY < GRID; lbY++) {
                // Compute the 8Ã—8 pixel region for this landblock
                int pixStartX = (int)Math.Round(lbX * 8 * scaleX);
                int pixStartY = (int)Math.Round((254 - lbY) * 8 * scaleY);

                // Sample pixels in the region
                int totalR = 0, totalG = 0, totalB = 0;
                int sampleCount = 0;

                int sampleSize = Math.Max(1, (int)Math.Round(8 * Math.Min(scaleX, scaleY)));
                for (int dx = 0; dx < sampleSize && pixStartX + dx < imgW; dx++) {
                    int px = pixStartX + dx;
                    for (int dy = 0; dy < sampleSize && pixStartY + dy < imgH; dy++) {
                        var pixel = pixels[(pixStartY + dy) * imgW + px];
                        totalR += pixel.Red;
                        totalG += pixel.Green;
                        totalB += pixel.Blue;
                        sampleCount++;
                    }
                }

                if (sampleCount == 0) {
                    cells.Add(new BiomeCellInfo(lbX, lbY, "ocean", false, 0, 0, 0, 0));
                    oceanCells++;
                    if (!biomeCounts.ContainsKey("ocean")) biomeCounts["ocean"] = 0;
                    biomeCounts["ocean"]++;
                    continue;
                }

                int avgR = totalR / sampleCount;
                int avgG = totalG / sampleCount;
                int avgB = totalB / sampleCount;
                double brightness = (avgR + avgG + avgB) / (3.0 * 255.0);

                // â”€â”€â”€ 3. Classify color â†’ biome â”€â”€â”€
                string biome = ClassifyBiome(avgR, avgG, avgB, brightness);
                // Both ocean and impassable_water are non-land â€” cannot be modified
                bool isLand = biome != "ocean" && biome != "impassable_water";

                // â”€â”€â”€ 4. Map biome â†’ DAT terrain type â”€â”€â”€
                var (terrainId, terrainName) = BiomeToTerrainType(biome);

                cells.Add(new BiomeCellInfo(lbX, lbY, biome, isLand,
                    avgR, avgG, avgB, Math.Round(brightness, 4), terrainId, terrainName));

                if (isLand) landCells++; else oceanCells++;

                if (!biomeCounts.ContainsKey(biome)) biomeCounts[biome] = 0;
                biomeCounts[biome]++;
            }

            if (lbX % 50 == 0 && lbX > 0)
                Console.WriteLine($"[AnalyzeMapImage] ...column {lbX}/254, {landCells} land, {oceanCells} ocean");
        }

        // â”€â”€â”€ 4. Write output JSON â”€â”€â”€
        Console.WriteLine($"[AnalyzeMapImage] Classification complete. Building output...");

        try {
            // Build the biome grid as a 2D array of biome IDs for easy lookup
            var biomeGrid = new string[GRID][];
            for (int x = 0; x < GRID; x++) {
                biomeGrid[x] = new string[GRID];
                for (int y = 0; y < GRID; y++) {
                    biomeGrid[x][y] = cells[x * GRID + y].BiomeId;
                }
            }

            var output = new {
                metadata = new {
                    generatedAt = DateTime.UtcNow.ToString("o"),
                    sourceImage = Path.GetFileName(imagePath),
                    imageWidth = imgW,
                    imageHeight = imgH,
                    gridSize = GRID,
                    scaleFactorX = Math.Round(scaleX, 4),
                    scaleFactorY = Math.Round(scaleY, 4)
                },
                summary = new {
                    totalCells = GRID * GRID,
                    landCells,
                    oceanCells,
                    landPercent = Math.Round(100.0 * landCells / (GRID * GRID), 2),
                    biomeCounts = biomeCounts.OrderByDescending(kv => kv.Value)
                        .Select(kv => new { biome = kv.Key, count = kv.Value,
                            percent = Math.Round(100.0 * kv.Value / (GRID * GRID), 2) })
                        .ToArray()
                },
                // â”€â”€ Biome â†’ DAT terrain type mapping (for compose-world) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                // Grounded in retail_baseline.json (65,025 landblocks scanned):
                //   Type 1 = Grassland   (24.7% of all vertices)
                //   Type 2 = Ice         (74.5% of all vertices) â€” base Dereth terrain
                //   Type 3 = LushGrass   (0.09% â€” rare meadow pockets)
                //   Type 8 = PatchyDirt  (0.70% â€” paths, barren ground)
                // Ocean / impassable_water are skipped â€” cells are excluded from output.
                terrainTypeMapping = new[] {
                    new { biome = "forest",           terrainTypeId = 0x03, terrainTypeName = "LushGrass",        notes = "Dense teal ACViewer terrain; LushGrass is the rendered surface" },
                    new { biome = "grassland",         terrainTypeId = 0x01, terrainTypeName = "Grassland",        notes = "Lighter green ACViewer areas â†’ Grassland" },
                    new { biome = "snow",              terrainTypeId = 0x0F, terrainTypeName = "Snow",             notes = "White/bright high-latitude terrain â†’ Snow" },
                    new { biome = "swamp",             terrainTypeId = 0x04, terrainTypeName = "MarshSparseSwamp", notes = "Blackmire dark blue terrain (LB 192,95) â†’ MarshSparseSwamp" },
                    new { biome = "water",             terrainTypeId = 0x10, terrainTypeName = "WaterRunning",     notes = "Modifiable river/lake pixels â†’ WaterRunning" },
                    new { biome = "desert",            terrainTypeId = 0x0A, terrainTypeName = "SandYellow",       notes = "Sandy/warm desert areas â†’ SandYellow" },
                    new { biome = "barren",            terrainTypeId = 0x0D, terrainTypeName = "SedimentaryRock",  notes = "Grey/rocky barren ground â†’ SedimentaryRock" },
                    new { biome = "obsidian",          terrainTypeId = 0x06, terrainTypeName = "ObsidianPlain",    notes = "SW volcanic dark terrain â†’ ObsidianPlain" },
                    new { biome = "mountain",          terrainTypeId = 0x0E, terrainTypeName = "SemiBarrenRock",   notes = "High bright peaks â†’ SemiBarrenRock" },
                    new { biome = "road",              terrainTypeId = 0x07, terrainTypeName = "PackedDirt",       notes = "Road surface base â†’ PackedDirt" },
                    new { biome = "ocean",             terrainTypeId = 0xFF, terrainTypeName = "(skip)",           notes = "Impassable ocean void â€” excluded from compose-world" },
                    new { biome = "impassable_water",  terrainTypeId = 0xFF, terrainTypeName = "(skip)",           notes = "Impassable inland water â€” excluded from compose-world" },
                },
                biomeGrid,
                cells = cells.Where(c => c.IsLand).Select(c => new {
                    lbX = c.LbX, lbY = c.LbY,
                    biome = c.BiomeId,
                    terrainTypeId = c.TerrainTypeId,
                    terrainTypeName = c.TerrainTypeName,
                    avgR = c.AvgR, avgG = c.AvgG, avgB = c.AvgB,
                    brightness = c.AvgBrightness
                }).ToArray()
            };


            var dir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);

            var json = System.Text.Json.JsonSerializer.Serialize(output,
                WorldBuilder.Shared.Lib.JsonOpts.CamelCaseIndented);
            File.WriteAllText(outputPath, json, System.Text.Encoding.UTF8);
        } catch (Exception ex) {
            sw.Stop();
            return new AnalyzeMapImageResult(false, imgW, imgH, landCells, oceanCells,
                biomeCounts, Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath, ex.Message);
        }

        sw.Stop();
        double elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Console.WriteLine($"[AnalyzeMapImage] Complete: {landCells} land, {oceanCells} ocean, " +
                          $"{biomeCounts.Count} biomes in {elapsedMs}ms â†’ {outputPath}");

        return new AnalyzeMapImageResult(true, imgW, imgH, landCells, oceanCells,
            biomeCounts, elapsedMs, outputPath);
    }

    /// <summary>
    /// Maps a biome label (from ClassifyBiome) to the DAT terrain type index and name,
    /// using the authoritative ACE enum: ACE.Server.Physics.Common.LandDefs.TerrainType
    /// (ACE-master/Source/ACE.Server/Physics/Common/LandDefs.cs).
    ///
    /// Full retail type table (0x00-0x14 used, 0x15-0x1F reserved, 0x20 = RoadType):
    ///   0x00 BarrenRock          0x08 PatchyDirt          0x10 WaterRunning
    ///   0x01 Grassland           0x09 PatchyGrassland     0x11 WaterStandingFresh
    ///   0x02 Ice                 0x0A SandYellow          0x12 WaterShallowSea
    ///   0x03 LushGrass           0x0B SandGrey            0x13 WaterShallowStillSea
    ///   0x04 MarshSparseSwamp    0x0C SandRockStrewn      0x14 WaterDeepSea
    ///   0x05 MudRichDirt         0x0D SedimentaryRock     0x20 RoadType
    ///   0x06 ObsidianPlain       0x0E SemiBarrenRock
    ///   0x07 PackedDirt          0x0F Snow
    ///
    /// retail_baseline.json (65,025 lb scan): type 1=24.7%, type 2=74.5%, type 3=0.09%, type 8=0.70%.
    /// NOTE: "Ice" (type 2) is the engine name for the generic base Dereth terrain â€” it renders as
    /// teal/forest in ACViewer because its texture IS the forest surface, not literal ice.
    /// </summary>
    private static (byte TypeId, string TypeName) BiomeToTerrainType(string biome) => biome switch {
        // â”€â”€ Passable land biomes â†’ semantically matched ACE terrain types â”€â”€â”€â”€â”€â”€â”€â”€
        "forest"           => (0x03, "LushGrass"),          // Dense teal terrain â†’ LushGrass
        "grassland"        => (0x01, "Grassland"),          // Open lighter green â†’ Grassland
        "snow"             => (0x0F, "Snow"),               // White/bright regions â†’ Snow
        "swamp"            => (0x04, "MarshSparseSwamp"),   // Blackmire dark terrain â†’ MarshSparseSwamp
        "water"            => (0x10, "WaterRunning"),       // Modifiable rivers â†’ WaterRunning
        "desert"           => (0x0A, "SandYellow"),         // Sandy/warm areas â†’ SandYellow
        "barren"           => (0x0D, "SedimentaryRock"),    // Grey rocky barren â†’ SedimentaryRock
        "obsidian"         => (0x06, "ObsidianPlain"),      // SW volcanic dark â†’ ObsidianPlain
        "mountain"         => (0x0E, "SemiBarrenRock"),     // High peaks â†’ SemiBarrenRock
        "road"             => (0x07, "PackedDirt"),         // Road surface base â†’ PackedDirt
        // â”€â”€ Impassable (excluded from compose-world output) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        "ocean"            => (0xFF, "(skip)"),             // Impassable void â€” not written
        "impassable_water" => (0xFF, "(skip)"),             // Impassable inland water â€” not written
        _                  => (0x03, "LushGrass"),          // Safe default: base terrain
    };


    /// <summary>
    /// Classifies an average RGB color into a biome category.
    ///
    /// IMPASSABLE CELLS (returned as non-land, cannot be modified):
    ///   "ocean"            â€” #3B211D (R=59,G=33,B=29, H=8Â°)  exterior + interior ocean voids
    ///   "impassable_water" â€” #363C1D (R=54,G=60,B=29, H=72Â°) standing lakes/inland impassable water
    ///
    /// PASSABLE LAND BIOMES:
    ///   "swamp"   â€” #132D40 (R=19,G=45,B=64, H=205Â°, S=0.70) dark blue swamp terrain (Blackmire area)
    ///   "water"   â€” #6395CE / #82C4FF rivers and modifiable inland water
    ///   "forest", "grassland", "desert", "snow", "barren", "mountain", "obsidian", "road"
    ///
    /// Ocean and impassable_water are both flagged IsLand=false in the output.
    /// All impassable checks are done first via exact RGB match before HSB logic.
    /// </summary>
    private static string ClassifyBiome(int r, int g, int b, double brightness) {
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        // STEP 1: Exact impassable color matches â€” before ANY HSB logic.
        //
        // These colors are unique renderer artifacts that map 1:1 to
        // impassable tile types. Matched with tight Â±8 tolerance to absorb
        // PNG compression at block boundaries.
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

        // â”€â”€ Impassable ocean void: R=59 G=33 B=29 (#3B211D, Hâ‰ˆ8Â°)
        //    Exterior ocean and interior ocean bays. Confirmed dominant color
        //    comprising ~83% of all pixels in the world_map.png.
        const int OCEAN_R = 59, OCEAN_G = 33, OCEAN_B = 29, OCEAN_TOL = 8;
        if (Math.Abs(r - OCEAN_R) <= OCEAN_TOL &&
            Math.Abs(g - OCEAN_G) <= OCEAN_TOL &&
            Math.Abs(b - OCEAN_B) <= OCEAN_TOL)
            return "ocean";

        // â”€â”€ Impassable inland water: R=54 G=60 B=29 (#363C1D, Hâ‰ˆ72Â°)
        //    Olive-dark-green: standing lakes and inland impassable water bodies.
        //    Confirmed at pixel (1550,840) â€” LB(194,149) and surrounding area.
        //    CANNOT be modified â€” must be preserved exactly like ocean.
        const int IW_R = 54, IW_G = 60, IW_B = 29, IW_TOL = 10;
        if (Math.Abs(r - IW_R) <= IW_TOL &&
            Math.Abs(g - IW_G) <= IW_TOL &&
            Math.Abs(b - IW_B) <= IW_TOL)
            return "impassable_water";

        // Also catch pure black void pixels at image padding edges
        if (r < 20 && g < 20 && b < 20) return "ocean";

        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        // STEP 2: HSB classification for all passable land biomes.
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        float hue, sat, bri;
        RgbToHsb(r, g, b, out hue, out sat, out bri);

        // â”€â”€ Snow/Ice: Very bright, low saturation (white/light gray)
        if (bri > 0.80 && sat < 0.15) return "snow";
        if (bri > 0.72 && sat < 0.25) return "snow";
        if (bri > 0.65 && sat < 0.15) return "snow";

        // â”€â”€ Roads: Orange/gold lines â€” high saturation, warm hue (15-55Â°)
        if (hue >= 15 && hue <= 55 && sat > 0.5 && bri > 0.4) return "road";

        // â”€â”€ Ocean coastal boundary grey: desaturated blue pixels at ocean/land edges
        //    (#455562 H=207Â° S=0.30 B=0.38, #667C8E H=207Â° S=0.28 B=0.56,
        //     #537491 H=208Â° S=0.43 B=0.57)
        //    Low saturation (< 0.45) distinguishes these from true rivers.
        if (hue >= 170 && hue <= 250 && sat < 0.45 && bri < 0.75) return "ocean";

        // â”€â”€ Swamp (passable land): dark blue-tinted terrain â€” Blackmire/swamp region
        //    Confirmed at pixel (1540,1275) â€” LB(192,95). Color #132D40.
        //    Hâ‰ˆ205Â°, Sâ‰ˆ0.70, Bâ‰ˆ0.25. High saturation distinguishes it from ocean
        //    coastal grey (S<0.45). It IS land â€” modifiable terrain.
        if (hue >= 185 && hue <= 225 && sat > 0.55 && bri < 0.35) return "swamp";

        // â”€â”€ River/Lake water (passable/modifiable): bright blue river pixels
        //    #6395CE (H=212Â° S=0.52 B=0.81), #82C4FF (H=208Â° S=0.49 B=1.00)
        //    High saturation AND high brightness distinguishes from all above.
        if (hue >= 170 && hue <= 250 && sat > 0.45 && bri > 0.75) return "water";

        // â”€â”€ Desert/Sand: Warm olive/sandy tones
        if (hue >= 25 && hue <= 70 && sat > 0.15 && bri > 0.35 && bri < 0.7) return "desert";

        // â”€â”€ Obsidian/Volcanic: Very dark with slight tint (SW volcanic region)
        if (bri < 0.25 && sat < 0.35 && bri > 0.10) return "obsidian";

        // â”€â”€ Forest: Teal/dark green â€” dominant land color in Dereth
        if (hue >= 130 && hue <= 210 && sat > 0.12 && bri > 0.20 && bri <= 0.60) return "forest";

        // â”€â”€ Grassland: Lighter greens and brighter teal areas
        if (hue >= 100 && hue <= 210 && sat > 0.08 && bri > 0.45) return "grassland";

        // â”€â”€ Barren/Rock: Low saturation, mid-brightness (gray, rocky terrain)
        if (sat < 0.18 && bri > 0.28 && bri < 0.70) return "barren";

        // â”€â”€ Mountain: High elevation â€” bright but desaturated (not quite snow)
        if (bri > 0.55 && sat < 0.30) return "mountain";

        // â”€â”€ Fallbacks
        if (bri > 0.50) return "grassland";
        if (bri > 0.25) return "forest";
        return "barren";
    }

    /// <summary>
    /// Convert RGB (0-255) to HSB (Hue 0-360, Saturation 0-1, Brightness 0-1).
    /// </summary>
    private static void RgbToHsb(int r, int g, int b, out float hue, out float sat, out float bri) {
        float rf = r / 255f, gf = g / 255f, bf = b / 255f;
        float max = Math.Max(rf, Math.Max(gf, bf));
        float min = Math.Min(rf, Math.Min(gf, bf));
        float delta = max - min;

        bri = max;

        if (max == 0) { sat = 0; hue = 0; return; }
        sat = delta / max;

        if (delta == 0) { hue = 0; return; }

        if (max == rf)
            hue = 60f * (((gf - bf) / delta) % 6f);
        else if (max == gf)
            hue = 60f * (((bf - rf) / delta) + 2f);
        else
            hue = 60f * (((rf - gf) / delta) + 4f);

        if (hue < 0) hue += 360f;
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  ACE Database Commands
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// <summary>
    /// Tests connection to an ACE MariaDB database and saves the settings to the project JSON.
    /// </summary>
    public async Task<AceDbConnectResult> AceDbConnectAsync(
        string host, int port, string database, string user, string password) {

        var settings = new AceDbSettings {
            Host = host, Port = port, Database = database,
            User = user, Password = password
        };

        try {
            using var connector = new AceDbConnector(settings);
            var error = await connector.TestConnectionAsync();
            if (error != null)
                return new AceDbConnectResult(false, host, port, database, user, false, error);

            // Save settings to project if one is loaded
            bool saved = false;
            if (_projectManager.CurrentProject != null) {
                _projectManager.CurrentProject.AceDb = settings;
                _projectManager.CurrentProject.Save();
                saved = true;
            }

            return new AceDbConnectResult(true, host, port, database, user, saved);
        } catch (Exception ex) {
            return new AceDbConnectResult(false, host, port, database, user, false, ex.Message);
        }
    }

    /// <summary>
    /// Shows current ACE database connection settings and tests connectivity.
    /// </summary>
    public async Task<AceDbStatusResult> AceDbStatusAsync() {
        var settings = _projectManager.CurrentProject?.AceDb;
        if (settings == null)
            return new AceDbStatusResult(false);

        try {
            using var connector = new AceDbConnector(settings);
            var error = await connector.TestConnectionAsync();
            return new AceDbStatusResult(true, settings.Host, settings.Port,
                settings.Database, settings.User,
                error == null, error);
        } catch (Exception ex) {
            return new AceDbStatusResult(true, settings.Host, settings.Port,
                settings.Database, settings.User, false, ex.Message);
        }
    }

    /// <summary>
    /// E1 (wave-2) PR3 — tests + saves the ACE SHARD database connection (separate from the WORLD
    /// <see cref="WorldBuilder.Shared.Models.Project.AceDb"/>). Required for the Option B per-placement
    /// biota override apply path. <paramref name="database"/> defaults to
    /// <see cref="AceDbConnector.ShardDbName"/> (ace_shard) when blank — NOT ace_world — so a biota
    /// write never lands in the world DB (HARD CONSTRAINT 3). Rejects pointing the shard at the same
    /// Server+Port+Database as the configured world DB.
    /// </summary>
    private static string CanonHost(string host) {
        if (string.IsNullOrWhiteSpace(host)) return "";
        var h = host.Trim().ToLowerInvariant();
        if (h == "localhost" || h == "127.0.0.1" || h == "::1") return "@loopback";
        return h;
    }

    private static bool HostsResolveSame(string a, string b) {
        if (CanonHost(a) == CanonHost(b)) return true;
        try {
            var addrsA = System.Net.Dns.GetHostAddresses(a).Select(x => x.ToString());
            var addrsB = new HashSet<string>(System.Net.Dns.GetHostAddresses(b).Select(x => x.ToString()));
            return addrsA.Any(addrsB.Contains);
        } catch {
            return string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
        }
    }

    public async Task<AceDbConnectResult> AceShardDbConnectAsync(
        string host, int port, string database, string user, string password) {

        if (string.IsNullOrWhiteSpace(database)) database = AceDbConnector.ShardDbName;

        var world = _projectManager.CurrentProject?.AceDb;
        if (world != null
            && HostsResolveSame(world.Host, host)
            && world.Port == port
            && string.Equals(world.Database, database, StringComparison.OrdinalIgnoreCase)) {
            return new AceDbConnectResult(false, host, port, database, user, false,
                "Shard DB resolves to the SAME Server+Database as the configured world DB (ace-db). " +
                "Point ace-shard-db at a distinct shard database (e.g. ace_shard) so biota overrides are not written to the world DB.");
        }

        var settings = new AceDbSettings {
            Host = host, Port = port, Database = database,
            User = user, Password = password
        };

        try {
            using var connector = new AceDbConnector(settings);
            var error = await connector.TestConnectionAsync();
            if (error != null)
                return new AceDbConnectResult(false, host, port, database, user, false, error);

            bool saved = false;
            if (_projectManager.CurrentProject != null) {
                _projectManager.CurrentProject.AceShardDb = settings;
                _projectManager.CurrentProject.Save();
                saved = true;
            }

            return new AceDbConnectResult(true, host, port, database, user, saved);
        } catch (Exception ex) {
            return new AceDbConnectResult(false, host, port, database, user, false, ex.Message);
        }
    }

    /// <summary>Shows current ACE SHARD database connection settings and tests connectivity.</summary>
    public async Task<AceDbStatusResult> AceShardDbStatusAsync() {
        var settings = _projectManager.CurrentProject?.AceShardDb;
        if (settings == null)
            return new AceDbStatusResult(false);

        try {
            using var connector = new AceDbConnector(settings);
            var error = await connector.TestConnectionAsync();
            return new AceDbStatusResult(true, settings.Host, settings.Port,
                settings.Database, settings.User,
                error == null, error);
        } catch (Exception ex) {
            return new AceDbStatusResult(true, settings.Host, settings.Port,
                settings.Database, settings.User, false, ex.Message);
        }
    }

    /// <summary>
    /// Queries all landblock_instance records for a given landblock ID.
    /// </summary>
    public async Task<AceDbQueryInstancesResult> AceDbQueryInstancesAsync(ushort landblockId) {
        var settings = _projectManager.CurrentProject?.AceDb;
        if (settings == null)
            return new AceDbQueryInstancesResult(false, landblockId, 0,
                new List<AceDbInstanceInfo>(), "No ACE database settings configured. Use 'ace-db connect' first.");

        try {
            using var connector = new AceDbConnector(settings);
            var records = await connector.GetOutdoorInstancesAsync(new[] { landblockId });

            // Also query indoor instances for a complete picture
            uint lbIdShifted = (uint)landblockId << 16;
            var allInstances = new List<AceDbInstanceInfo>();

            // Re-query for ALL instances (outdoor + indoor)
            await using var conn = new MySqlConnector.MySqlConnection(settings.ConnectionString);
            await conn.OpenAsync();

            const string sql = @"
                SELECT `guid`, `weenie_Class_Id`, `obj_Cell_Id`,
                       `origin_X`, `origin_Y`, `origin_Z`
                FROM `landblock_instance`
                WHERE `obj_Cell_Id` >= @minCell AND `obj_Cell_Id` <= @maxCell";

            uint minCellId = lbIdShifted | 0x0001;
            uint maxCellId = lbIdShifted | 0xFFFF;

            await using var cmd = new MySqlConnector.MySqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("@minCell", minCellId);
            cmd.Parameters.AddWithValue("@maxCell", maxCellId);

            await using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync()) {
                var objCellId = reader.GetUInt32("obj_Cell_Id");
                var cellId = (ushort)(objCellId & 0xFFFF);
                allInstances.Add(new AceDbInstanceInfo(
                    reader.GetUInt32("guid"),
                    reader.GetUInt32("weenie_Class_Id"),
                    objCellId,
                    reader.GetFloat("origin_X"),
                    reader.GetFloat("origin_Y"),
                    reader.GetFloat("origin_Z"),
                    landblockId,
                    cellId >= 1 && cellId <= 64));
            }

            return new AceDbQueryInstancesResult(true, landblockId, allInstances.Count, allInstances);
        } catch (Exception ex) {
            return new AceDbQueryInstancesResult(false, landblockId, 0,
                new List<AceDbInstanceInfo>(), ex.Message);
        }
    }

    /// <summary>
    /// After terrain changes, computes height deltas and generates/applies SQL to reposition instances.
    /// Requires a project with terrain change data captured during export.
    /// </summary>
    public async Task<AceDbRepositionResult> AceDbRepositionAsync() {
        RequireProject();
        var settings = _projectManager.CurrentProject!.AceDb;
        if (settings == null)
            return new AceDbRepositionResult(false, 0, 0, 0,
                Error: "No ACE database settings configured. Use 'ace-db connect' first.");

        try {
            // Build the reposition context from current terrain vs base DAT terrain
            var terrainDoc = GetTerrainDoc();
            var heightTable = GetHeightTable();
            var modifiedLbs = new HashSet<ushort>(terrainDoc.TerrainData.Landblocks.Keys);

            if (modifiedLbs.Count == 0)
                return new AceDbRepositionResult(true, 0, 0, 0, Error: "No modified landblocks found.");

            // Capture old terrain from base DATs
            var oldTerrain = new Dictionary<ushort, TerrainEntry[]>();
            var newTerrain = new Dictionary<ushort, TerrainEntry[]>();
            var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

            foreach (var lbKey in modifiedLbs) {
                var baseLbId = (uint)(lbKey << 16) | 0xFFFF;
                if (dats.TryGet<LandBlock>(baseLbId, out var baseLb)) {
                    var entries = new TerrainEntry[81];
                    for (int i = 0; i < 81; i++) {
                        entries[i] = new TerrainEntry(
                            baseLb.Terrain[i].Road,
                            baseLb.Terrain[i].Scenery,
                            (byte)baseLb.Terrain[i].Type,
                            baseLb.Height[i]);
                    }
                    oldTerrain[lbKey] = entries;
                }

                var currentEntries = terrainDoc.GetLandblockInternal(lbKey);
                if (currentEntries != null) {
                    var snapshot = new TerrainEntry[81];
                    Array.Copy(currentEntries, snapshot, 81);
                    newTerrain[lbKey] = snapshot;
                }
            }

            var projectDir = _projectManager.CurrentProject!.ProjectDirectory;
            var ctx = new RepositionContext {
                ModifiedLandblocks = modifiedLbs.ToArray(),
                OldTerrain = oldTerrain,
                NewTerrain = newTerrain,
                LandHeightTable = heightTable,
                ExportDirectory = projectDir
            };

            // Run reposition with apply enabled
            var repoSettings = new AceDbSettings {
                Host = settings.Host, Port = settings.Port,
                Database = settings.Database, User = settings.User,
                Password = settings.Password,
                EnableReposition = true,
                ApplyDirectly = true,
                Threshold = settings.Threshold
            };

            var service = new InstanceRepositionService();
            var result = await service.RunAsync(repoSettings, ctx);

            return new AceDbRepositionResult(
                result.Error == null,
                result.InstancesChecked,
                result.InstancesUpdated,
                result.LandblocksProcessed,
                result.SqlFilePath,
                result.AppliedDirectly,
                result.Error);
        } catch (Exception ex) {
            return new AceDbRepositionResult(false, 0, 0, 0, Error: ex.Message);
        }
    }

    /// <summary>
    /// Exports reposition SQL without applying it â€” for review or manual execution.
    /// </summary>
    public async Task<AceDbExportSqlResult> AceDbExportSqlAsync(string outputPath) {
        RequireProject();
        var settings = _projectManager.CurrentProject!.AceDb;
        if (settings == null)
            return new AceDbExportSqlResult(false, 0, 0, 0,
                Error: "No ACE database settings configured. Use 'ace-db connect' first.");

        try {
            var terrainDoc = GetTerrainDoc();
            var heightTable = GetHeightTable();
            var modifiedLbs = new HashSet<ushort>(terrainDoc.TerrainData.Landblocks.Keys);

            if (modifiedLbs.Count == 0)
                return new AceDbExportSqlResult(true, 0, 0, 0, Error: "No modified landblocks found.");

            var oldTerrain = new Dictionary<ushort, TerrainEntry[]>();
            var newTerrain = new Dictionary<ushort, TerrainEntry[]>();
            var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

            foreach (var lbKey in modifiedLbs) {
                var baseLbId = (uint)(lbKey << 16) | 0xFFFF;
                if (dats.TryGet<LandBlock>(baseLbId, out var baseLb)) {
                    var entries = new TerrainEntry[81];
                    for (int i = 0; i < 81; i++) {
                        entries[i] = new TerrainEntry(
                            baseLb.Terrain[i].Road,
                            baseLb.Terrain[i].Scenery,
                            (byte)baseLb.Terrain[i].Type,
                            baseLb.Height[i]);
                    }
                    oldTerrain[lbKey] = entries;
                }

                var currentEntries = terrainDoc.GetLandblockInternal(lbKey);
                if (currentEntries != null) {
                    var snapshot = new TerrainEntry[81];
                    Array.Copy(currentEntries, snapshot, 81);
                    newTerrain[lbKey] = snapshot;
                }
            }

            // Use outputPath's directory, or project directory
            var exportDir = Path.GetDirectoryName(Path.GetFullPath(outputPath))
                ?? _projectManager.CurrentProject!.ProjectDirectory;

            var ctx = new RepositionContext {
                ModifiedLandblocks = modifiedLbs.ToArray(),
                OldTerrain = oldTerrain,
                NewTerrain = newTerrain,
                LandHeightTable = heightTable,
                ExportDirectory = exportDir
            };

            // Run reposition without applying (export only)
            var repoSettings = new AceDbSettings {
                Host = settings.Host, Port = settings.Port,
                Database = settings.Database, User = settings.User,
                Password = settings.Password,
                EnableReposition = true,
                ApplyDirectly = false,
                Threshold = settings.Threshold
            };

            var service = new InstanceRepositionService();
            var result = await service.RunAsync(repoSettings, ctx);

            // If a custom output path was given and the file was written to the default location, move it
            if (result.SqlFilePath != null && result.SqlFilePath != outputPath) {
                if (File.Exists(result.SqlFilePath)) {
                    Directory.CreateDirectory(Path.GetDirectoryName(outputPath) ?? ".");
                    File.Move(result.SqlFilePath, outputPath, overwrite: true);
                    result = new InstanceRepositionService.RepositionResult {
                        InstancesChecked = result.InstancesChecked,
                        InstancesUpdated = result.InstancesUpdated,
                        LandblocksProcessed = result.LandblocksProcessed,
                        SqlFilePath = outputPath,
                        AppliedDirectly = false,
                        Error = result.Error
                    };
                }
            }

            return new AceDbExportSqlResult(
                result.Error == null,
                result.InstancesChecked,
                result.InstancesUpdated,
                result.LandblocksProcessed,
                result.SqlFilePath,
                result.Error);
        } catch (Exception ex) {
            return new AceDbExportSqlResult(false, 0, 0, 0, Error: ex.Message);
        }
    }

    /// <summary>
    /// Shows instance counts per landblock, finds dense/empty areas, total world object count.
    /// </summary>
    public async Task<AceDbStatsResult> AceDbStatsAsync() {
        var settings = _projectManager.CurrentProject?.AceDb;
        if (settings == null)
            return new AceDbStatsResult(false, 0, 0,
                Error: "No ACE database settings configured. Use 'ace-db connect' first.");

        try {
            await using var conn = new MySqlConnector.MySqlConnection(settings.ConnectionString);
            await conn.OpenAsync();

            // Get total count
            int totalInstances;
            await using (var cmd = new MySqlConnector.MySqlCommand(
                "SELECT COUNT(*) FROM `landblock_instance`", conn)) {
                totalInstances = Convert.ToInt32(await cmd.ExecuteScalarAsync());
            }

            // Get per-landblock counts (group by high 16 bits of obj_Cell_Id)
            var lbCounts = new Dictionary<ushort, int>();
            await using (var cmd = new MySqlConnector.MySqlCommand(@"
                SELECT (`obj_Cell_Id` >> 16) AS lb, COUNT(*) AS cnt
                FROM `landblock_instance`
                GROUP BY lb
                ORDER BY cnt DESC", conn)) {
                await using var reader = await cmd.ExecuteReaderAsync();
                while (await reader.ReadAsync()) {
                    var lb = (ushort)reader.GetUInt32("lb");
                    var cnt = reader.GetInt32("cnt");
                    lbCounts[lb] = cnt;
                }
            }

            var densest = lbCounts
                .OrderByDescending(kv => kv.Value)
                .Take(10)
                .Select(kv => new AceDbLandblockStats(kv.Key, kv.Value))
                .ToList();

            return new AceDbStatsResult(
                true, totalInstances, lbCounts.Count,
                densest);
        } catch (Exception ex) {
            return new AceDbStatsResult(false, 0, 0, Error: ex.Message);
        }
    }

    /// <summary>
    /// Deletes all landblock_instance and landblock_instance_link records from the ACE database.
    /// This removes all server-side spawns (NPCs, portals, vendors, monsters, etc.).
    /// </summary>
    public async Task<AceDbClearInstancesResult> AceDbClearInstancesAsync() {
        var settings = _projectManager.CurrentProject?.AceDb;
        if (settings == null)
            return new AceDbClearInstancesResult(false, 0, 0,
                "No ACE database settings configured. Use 'ace-db connect' first.");

        try {
            await using var conn = new MySqlConnector.MySqlConnection(settings.ConnectionString);
            await conn.OpenAsync();

            // Count before deleting so we can report
            int instanceCount, linkCount;
            await using (var cmd = new MySqlConnector.MySqlCommand(
                "SELECT COUNT(*) FROM `landblock_instance`", conn)) {
                instanceCount = Convert.ToInt32(await cmd.ExecuteScalarAsync());
            }
            await using (var cmd = new MySqlConnector.MySqlCommand(
                "SELECT COUNT(*) FROM `landblock_instance_link`", conn)) {
                linkCount = Convert.ToInt32(await cmd.ExecuteScalarAsync());
            }

            // Delete links first (FK constraint), then instances
            await using (var cmd = new MySqlConnector.MySqlCommand(
                "DELETE FROM `landblock_instance_link`", conn)) {
                await cmd.ExecuteNonQueryAsync();
            }
            await using (var cmd = new MySqlConnector.MySqlCommand(
                "DELETE FROM `landblock_instance`", conn)) {
                await cmd.ExecuteNonQueryAsync();
            }

            return new AceDbClearInstancesResult(true, instanceCount, linkCount);
        } catch (Exception ex) {
            return new AceDbClearInstancesResult(false, 0, 0, ex.Message);
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Building Remap (cluster shuffle)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// <summary>
    /// Reads a landblock remap JSON (from cluster_shuffle_populate.py) and moves
    /// buildings in the DAT from their retail positions to the remapped Vanquish
    /// positions. When inPlace=false, copies base DATs to outputDir first.
    /// When inPlace=true, operates on existing DATs in outputDir (e.g. from a prior export).
    /// Also generates SQL to remap interior DB instances.
    /// </summary>
    public RemapBuildingsResult RemapBuildings(string remapJsonPath, string outputDir,
        bool apply = false, bool inPlace = false) {
        // V1 is deprecated â€” use RemapBuildingsV2 instead
        return new RemapBuildingsResult(false, 0, 0, 0, 0, 0, 0,
            Error: "V1 RemapBuildings is deprecated. Use remap-buildings-v2 instead.");
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Building Remap V2 (layer-based pipeline)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// <summary>
    /// V2: Remap buildings through the LandblockDocument layer system.
    /// Instead of directly writing to DATs, this adds buildings as StaticObjects
    /// to destination LandblockDocuments, then relies on export â†’ SaveToDatsInternal()
    /// to create proper EnvCells via InstantiateBlueprint.
    /// Also optionally flattens terrain under building footprints.
    /// </summary>
    public RemapBuildingsV2Result RemapBuildingsV2(string remapJsonPath,
        bool flattenTerrain = true, float flattenRadius = 30f, float flattenStrength = 0.85f,
        bool runPlacementValidators = true, bool preserveRetailZProfile = false) {
        RequireProject();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var warnings = new List<string>();

        try {
            flattenStrength = Math.Clamp(flattenStrength, 0f, 1f);
            BuildingBlueprintCache.ClearPlacementDonorHints();

            const float foundationAutoFixThresholdMeters = 0.75f;
            const float foundationResidualWarnThresholdMeters = 1.0f;

            // 1. Load lb_remap.json
            if (!File.Exists(remapJsonPath))
                return new RemapBuildingsV2Result(false, 0, 0, 0, 0, 0, 0,
                    Error: $"Remap file not found: {remapJsonPath}");

            var remapJson = File.ReadAllText(remapJsonPath);
            var rawRemap = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(remapJson);
            if (rawRemap == null || rawRemap.Count == 0)
                return new RemapBuildingsV2Result(false, 0, 0, 0, 0, 0, 0,
                    Error: "Empty or invalid remap JSON");

            // Parse "oldX,oldY" -> "newX,newY" into structured form
            var lbRemap = new Dictionary<ushort, ushort>();
            foreach (var (key, val) in rawRemap) {
                var oldParts = key.Split(',');
                var newParts = val.Split(',');
                if (oldParts.Length != 2 || newParts.Length != 2) continue;
                int oldX = int.Parse(oldParts[0]), oldY = int.Parse(oldParts[1]);
                int newX = int.Parse(newParts[0]), newY = int.Parse(newParts[1]);
                ushort oldKey = (ushort)((oldX << 8) | oldY);
                ushort newKey = (ushort)((newX << 8) | newY);
                lbRemap[oldKey] = newKey;
            }

            Console.WriteLine($"  Loaded {lbRemap.Count} landblock remap entries");

            // 2. Access base DATs (read-only) and terrain
            var project = _projectManager.CurrentProject!;
            var dats = project.DocumentManager.Dats;
            var terrainDoc = GetTerrainDoc();
            var heightTable = GetHeightTable();

            int landblocksScanned = 0;
            int lbsWithBuildings = 0;
            int buildingShellsCopied = 0;
            int staticObjectsCopied = 0;
            int terrainVerticesFlattened = 0;
            int terrainAutoFixPasses = 0;

            // Track old cell IDs for post-export SQL generation
            var oldCellIdMap = new Dictionary<string, object>();

            // Track destination landblocks touched by placements
            var touchedDestinationLbs = new HashSet<ushort>();

            // Accumulated terrain changes applied once at end
            var terrainBatchChanges = new Dictionary<ushort, Dictionary<byte, uint>>();
            var terrainPendingHeights = new Dictionary<ushort, Dictionary<byte, byte>>();
            var modelFootprintRadiusCache = new Dictionary<uint, float>();

            // Helper: find closest height index for a world Z
            byte FindClosestHeightIdx(float worldZ) {
                byte best = 0;
                float bestDist = float.MaxValue;
                for (int i = 0; i < heightTable.Length && i < 256; i++) {
                    float dist = Math.Abs(heightTable[i] - worldZ);
                    if (dist < bestDist) { bestDist = dist; best = (byte)i; }
                }
                return best;
            }

            bool TryGetCurrentHeightIndex(ushort lbKey, byte vertexIndex, TerrainEntry[] terrainData, out byte heightIndex) {
                if (terrainPendingHeights.TryGetValue(lbKey, out var pending) &&
                    pending.TryGetValue(vertexIndex, out var pendingHeight)) {
                    heightIndex = pendingHeight;
                    return true;
                }

                if (vertexIndex < terrainData.Length) {
                    heightIndex = terrainData[vertexIndex].Height;
                    return true;
                }

                heightIndex = 0;
                return false;
            }

            float SampleFoundationMismatch(float worldX, float worldY, float radius, float targetGroundZ) {
                if (radius <= 0f) return 0f;

                float radiusSq = radius * radius;
                float maxAbsDiff = 0f;
                int sampleCount = 0;

                uint baseLbX = (uint)(worldX / 192f);
                uint baseLbY = (uint)(worldY / 192f);

                for (int dlx = -1; dlx <= 1; dlx++) {
                    for (int dly = -1; dly <= 1; dly++) {
                        uint checkLbX = (uint)((int)baseLbX + dlx);
                        uint checkLbY = (uint)((int)baseLbY + dly);
                        if (checkLbX > 254 || checkLbY > 254) continue;

                        ushort checkLbKey = (ushort)((checkLbX << 8) | checkLbY);
                        var terrainData = terrainDoc.GetLandblockInternal(checkLbKey);
                        if (terrainData == null) continue;

                        for (int vx = 0; vx <= 8; vx++) {
                            for (int vy = 0; vy <= 8; vy++) {
                                float vertWorldX = checkLbX * 192f + vx * 24f;
                                float vertWorldY = checkLbY * 192f + vy * 24f;
                                float dx = vertWorldX - worldX;
                                float dy = vertWorldY - worldY;
                                if (dx * dx + dy * dy > radiusSq) continue;

                                byte vertexIndex = (byte)(vx * 9 + vy);
                                if (!TryGetCurrentHeightIndex(checkLbKey, vertexIndex, terrainData, out var hIdx))
                                    continue;

                                float terrainZ = heightTable[hIdx];
                                maxAbsDiff = MathF.Max(maxAbsDiff, MathF.Abs(terrainZ - targetGroundZ));
                                sampleCount++;
                            }
                        }
                    }
                }

                return sampleCount > 0 ? maxAbsDiff : 0f;
            }

            // Sample destination terrain at every footprint corner + perimeter
            // midpoint and return the maximum. AC buildings have flat bottoms,
            // so taking the max corner means no part of the foundation can stick
            // out — any sinking happens at the lower corners and is invisible
            // (under the surface). Returns null when no ontology footprint is
            // available (caller falls back to a single centre sample).
            float? SampleFootprintMaxGroundZ(
                uint modelId, ushort lbKey, float localX, float localY,
                System.Numerics.Quaternion orientation) {
                var entry = _ontologyService.IsScanned ? _ontologyService.GetEntry(modelId) : null;
                var corners = entry?.FootprintCorners;
                if (corners == null || corners.Length < 3) return null;

                var terrainData = terrainDoc.GetLandblockInternal(lbKey);
                if (terrainData == null) return null;

                uint lbX = (uint)(lbKey >> 8) & 0xFF;
                uint lbY = (uint)lbKey & 0xFF;

                float maxZ = float.NegativeInfinity;
                bool any = false;

                void SampleAt(float lx, float ly) {
                    // SampleHeightTriangle clamps to [0,192] internally; for
                    // corners that spill past the landblock edge this gives the
                    // edge value, which is acceptable.
                    float clx = Math.Clamp(lx, 0f, 192f);
                    float cly = Math.Clamp(ly, 0f, 192f);
                    float z = TerrainHeightSampler.SampleHeightTriangle(
                        terrainData, heightTable, clx, cly, lbX, lbY);
                    if (z > maxZ) maxZ = z;
                    any = true;
                }

                // Corners
                for (int i = 0; i < corners.Length; i++) {
                    var rotated = System.Numerics.Vector3.Transform(
                        new System.Numerics.Vector3(corners[i].X, corners[i].Y, 0f), orientation);
                    SampleAt(localX + rotated.X, localY + rotated.Y);
                }
                // Perimeter midpoints — catches walls crossing slopes between corners
                for (int i = 0; i < corners.Length; i++) {
                    var mid = (corners[i] + corners[(i + 1) % corners.Length]) * 0.5f;
                    var rotated = System.Numerics.Vector3.Transform(
                        new System.Numerics.Vector3(mid.X, mid.Y, 0f), orientation);
                    SampleAt(localX + rotated.X, localY + rotated.Y);
                }

                return any ? maxZ : (float?)null;
            }

            float EstimateModelFootprintRadius(uint modelId) {
                if (modelFootprintRadiusCache.TryGetValue(modelId, out var cached))
                    return cached;

                float radius = 0f;
                bool anyVertex = false;
                var min = new Vector2(float.MaxValue, float.MaxValue);
                var max = new Vector2(float.MinValue, float.MinValue);

                if ((modelId & 0xFF000000) == 0x02000000 && dats.TryGet<Setup>(modelId, out var setup)) {
                    int partCount = setup.Parts?.Count ?? 0;
                    for (int i = 0; i < partCount; i++) {
                        uint partId = setup.Parts![i];
                        if (!dats.TryGet<GfxObj>(partId, out var gfx) || gfx.VertexArray?.Vertices == null)
                            continue;

                        Vector3 partOffset = Vector3.Zero;
                        if (setup.PlacementFrames != null && setup.PlacementFrames.Count > 0) {
                            var placement = setup.PlacementFrames.Values.FirstOrDefault();
                            if (placement?.Frames != null && i < placement.Frames.Count)
                                partOffset = placement.Frames[i].Origin;
                        }

                        foreach (var vertex in gfx.VertexArray.Vertices.Values) {
                            var p = vertex.Origin + partOffset;
                            min = Vector2.Min(min, new Vector2(p.X, p.Y));
                            max = Vector2.Max(max, new Vector2(p.X, p.Y));
                            anyVertex = true;
                        }
                    }
                } else if ((modelId & 0xFF000000) == 0x01000000 &&
                           dats.TryGet<GfxObj>(modelId, out var singleGfx) &&
                           singleGfx.VertexArray?.Vertices != null) {
                    foreach (var vertex in singleGfx.VertexArray.Vertices.Values) {
                        var p = vertex.Origin;
                        min = Vector2.Min(min, new Vector2(p.X, p.Y));
                        max = Vector2.Max(max, new Vector2(p.X, p.Y));
                        anyVertex = true;
                    }
                }

                if (anyVertex) {
                    var size = max - min;
                    radius = 0.5f * MathF.Sqrt(size.X * size.X + size.Y * size.Y);
                }

                modelFootprintRadiusCache[modelId] = radius;
                return radius;
            }

            // Flatten terrain vertices within radius of world position to target ground Z.
            // Uses flat inner core and blended outer ring to avoid hard edges.
            void FlattenTerrainAt(float worldX, float worldY, float targetGroundZ, float radius) {
                if (radius <= 0f) return;
                float innerRadius = radius * flattenStrength;
                float radiusSq = radius * radius;

                uint baseLbX = (uint)(worldX / 192f);
                uint baseLbY = (uint)(worldY / 192f);

                for (int dlx = -1; dlx <= 1; dlx++) {
                    for (int dly = -1; dly <= 1; dly++) {
                        uint checkLbX = (uint)((int)baseLbX + dlx);
                        uint checkLbY = (uint)((int)baseLbY + dly);
                        if (checkLbX > 254 || checkLbY > 254) continue;

                        ushort checkLbKey = (ushort)((checkLbX << 8) | checkLbY);
                        var terrainData = terrainDoc.GetLandblockInternal(checkLbKey);
                        if (terrainData == null) continue;

                        for (int vx = 0; vx <= 8; vx++) {
                            for (int vy = 0; vy <= 8; vy++) {
                                float vertWorldX = checkLbX * 192f + vx * 24f;
                                float vertWorldY = checkLbY * 192f + vy * 24f;
                                float dx = vertWorldX - worldX;
                                float dy = vertWorldY - worldY;

                                float distSq = dx * dx + dy * dy;
                                if (distSq > radiusSq) continue;

                                int idx = vx * 9 + vy;
                                byte vertexIndex = (byte)idx;
                                if (!TryGetCurrentHeightIndex(checkLbKey, vertexIndex, terrainData, out var currentHeightIdx))
                                    continue;

                                float currentZ = heightTable[currentHeightIdx];
                                float dist = MathF.Sqrt(distSq);
                                float targetVertexZ;
                                if (dist <= innerRadius || radius <= innerRadius) {
                                    targetVertexZ = targetGroundZ;
                                } else {
                                    float t = (dist - innerRadius) / (radius - innerRadius);
                                    targetVertexZ = targetGroundZ + (currentZ - targetGroundZ) * t;
                                }

                                byte targetHeight = FindClosestHeightIdx(targetVertexZ);
                                if (currentHeightIdx == targetHeight) continue;

                                if (!terrainBatchChanges.TryGetValue(checkLbKey, out var lbChanges)) {
                                    lbChanges = new Dictionary<byte, uint>();
                                    terrainBatchChanges[checkLbKey] = lbChanges;
                                }
                                lbChanges[vertexIndex] = (terrainData[idx] with { Height = targetHeight }).ToUInt();

                                if (!terrainPendingHeights.TryGetValue(checkLbKey, out var pending)) {
                                    pending = new Dictionary<byte, byte>();
                                    terrainPendingHeights[checkLbKey] = pending;
                                }
                                pending[vertexIndex] = targetHeight;
                                terrainVerticesFlattened++;
                            }
                        }
                    }
                }
            }

            // 2b. Pre-compute fallback Z delta per source landblock.
            // Primary placement uses per-position terrain sampling (src vs dst).
            // This map only provides a center-sample fallback when terrain data is missing.
            var perLbDelta = new Dictionary<ushort, float>();
            var warnedMissingTerrain = new HashSet<ushort>();

            (float deltaZ, float? sourceGroundZ, float? destinationGroundZ, bool usedFallback)
                ComputePlacementDeltaDetailed(ushort oldLbKey, ushort newLbKey, float localX, float localY, float fallbackDelta) {
                var srcTerrainAtPos = terrainDoc.GetLandblockInternal(oldLbKey);
                var dstTerrainAtPos = terrainDoc.GetLandblockInternal(newLbKey);

                float? srcGroundZ = null;
                float? dstGroundZ = null;

                if (srcTerrainAtPos != null) {
                    uint oldLbX = (uint)(oldLbKey >> 8) & 0xFF;
                    uint oldLbY = (uint)oldLbKey & 0xFF;
                    srcGroundZ = TerrainHeightSampler.SampleHeightTriangle(
                        srcTerrainAtPos, heightTable, localX, localY, oldLbX, oldLbY);
                }

                if (dstTerrainAtPos != null) {
                    uint newLbX = (uint)(newLbKey >> 8) & 0xFF;
                    uint newLbY = (uint)newLbKey & 0xFF;
                    dstGroundZ = TerrainHeightSampler.SampleHeightTriangle(
                        dstTerrainAtPos, heightTable, localX, localY, newLbX, newLbY);
                }

                if (srcGroundZ.HasValue && dstGroundZ.HasValue) {
                    return (dstGroundZ.Value - srcGroundZ.Value, srcGroundZ, dstGroundZ, false);
                }

                if (!warnedMissingTerrain.Contains(oldLbKey)) {
                    warnings.Add($"Using fallback Z delta for LB 0x{oldLbKey:X4} (missing source/destination terrain sample)");
                    warnedMissingTerrain.Add(oldLbKey);
                }

                if (!srcGroundZ.HasValue && dstGroundZ.HasValue) srcGroundZ = dstGroundZ.Value - fallbackDelta;
                if (srcGroundZ.HasValue && !dstGroundZ.HasValue) dstGroundZ = srcGroundZ.Value + fallbackDelta;

                return (fallbackDelta, srcGroundZ, dstGroundZ, true);
            }

            foreach (var (oldLbKey, newLbKey) in lbRemap) {
                if (oldLbKey == newLbKey) continue;

                uint srcLbX = (uint)(oldLbKey >> 8) & 0xFF;
                uint srcLbY = (uint)oldLbKey & 0xFF;
                uint destLbX = (uint)(newLbKey >> 8) & 0xFF;
                uint destLbY = (uint)newLbKey & 0xFF;

                var srcTerrain = terrainDoc.GetLandblockInternal(oldLbKey);
                var destTerrain = terrainDoc.GetLandblockInternal(newLbKey);

                float fallbackDelta = 0f;
                if (srcTerrain != null && destTerrain != null) {
                    float srcCenterZ = TerrainHeightSampler.SampleHeightTriangle(
                        srcTerrain, heightTable, 96f, 96f, srcLbX, srcLbY);
                    float dstCenterZ = TerrainHeightSampler.SampleHeightTriangle(
                        destTerrain, heightTable, 96f, 96f, destLbX, destLbY);
                    fallbackDelta = dstCenterZ - srcCenterZ;
                } else {
                    if (srcTerrain == null)
                        warnings.Add($"No source terrain at LB 0x{oldLbKey:X4}");
                    if (destTerrain == null)
                        warnings.Add($"No destination terrain at LB 0x{newLbKey:X4}");
                }

                perLbDelta[oldLbKey] = fallbackDelta;
            }

            Console.WriteLine($"  Pre-computed Z deltas for {perLbDelta.Count} source landblocks");
            if (perLbDelta.Count > 0) {
                var deltas = perLbDelta.Values.ToList();
                Console.WriteLine($"    Range: {deltas.Min():+0.0;-0.0} to {deltas.Max():+0.0;-0.0}, avg={deltas.Average():+0.0;-0.0}");
            }

            // 3. Place objects/buildings and optionally flatten terrain under each one.
            foreach (var (oldLbKey, newLbKey) in lbRemap) {
                if (oldLbKey == newLbKey) continue;
                landblocksScanned++;

                uint oldInfoId = (uint)(oldLbKey << 16) | 0xFFFE;
                if (!dats.TryGet<LandBlockInfo>(oldInfoId, out var oldLbi)) continue;
                if (oldLbi.Objects.Count == 0 && oldLbi.Buildings.Count == 0) continue;

                touchedDestinationLbs.Add(newLbKey);
                lbsWithBuildings++;

                uint newLbX = (uint)(newLbKey >> 8) & 0xFF;
                uint newLbY = (uint)newLbKey & 0xFF;
                float fallbackDeltaZ = perLbDelta.GetValueOrDefault(oldLbKey, 0f);

                var destDoc = GetLandblockDoc(newLbKey);

                // 3a. Copy buildings FIRST. Buildings define footprints that
                // doors/decorations ride on, so they must be placed before
                // Objects so we can test object containment against the
                // freshly-computed building polygons.
                //
                // For each building we record:
                //   sourceFootprint: 4–N corner polygon in source-LB-local
                //                    coords, used to test obj containment;
                //   buildingDeltaZ:  newZ - sourceOriginZ, applied to any
                //                    Object/door whose XY falls inside.
                var sourceBuildingFootprints =
                    new List<(System.Numerics.Vector2[] poly, float deltaZ, uint modelId)>();

                // 3a-pre. Group resolution: every building whose model id
                // pairs (transitively) with another model id on this landblock
                // shares a single targetGroundZ. This is what stops a fortress
                // wall from stair-stepping across a slope — all members sit
                // flush at the union-max of every member's corner samples.
                var groupTargetZ = new Dictionary<uint, float>();
                if (_buildingPairings.EdgeCount > 0) {
                    var pendingByGroup = new Dictionary<uint, List<float>>();
                    for (int gIdx = 0; gIdx < oldLbi.Buildings.Count; gIdx++) {
                        var b = oldLbi.Buildings[gIdx];
                        uint groupKey = _buildingPairings.GroupKey(b.ModelId);
                        if (!_buildingPairings.HasPairs(b.ModelId)) continue;
                        float? gMax = SampleFootprintMaxGroundZ(
                            b.ModelId, newLbKey,
                            b.Frame.Origin.X, b.Frame.Origin.Y, b.Frame.Orientation);
                        if (!gMax.HasValue) continue;
                        if (!pendingByGroup.TryGetValue(groupKey, out var list)) {
                            list = new List<float>(); pendingByGroup[groupKey] = list;
                        }
                        list.Add(gMax.Value);
                    }
                    foreach (var (gk, samples) in pendingByGroup) {
                        if (samples.Count >= 2) {
                            // Only commit a shared group Z when 2+ members
                            // contributed; a singleton on this landblock is
                            // not a group worth coordinating.
                            groupTargetZ[gk] = samples.Max();
                        }
                    }
                }

                for (int bIdx = 0; bIdx < oldLbi.Buildings.Count; bIdx++) {
                    var building = oldLbi.Buildings[bIdx];

                    float worldX = newLbX * 192f + building.Frame.Origin.X;
                    float worldY = newLbY * 192f + building.Frame.Origin.Y;

                    // Centre-sample fallback (used when no ontology footprint
                    // is available, or to fill in source-side ground Z).
                    var placement = ComputePlacementDeltaDetailed(
                        oldLbKey, newLbKey,
                        building.Frame.Origin.X, building.Frame.Origin.Y, fallbackDeltaZ);
                    float sourceGroundZ = placement.sourceGroundZ
                        ?? (building.Frame.Origin.Z - fallbackDeltaZ);
                    float sourceOriginToGroundOffset = building.Frame.Origin.Z - sourceGroundZ;

                    // Footprint-aware destination ground sample (max of
                    // corner+midpoint heights). AC buildings have flat
                    // bottoms, so raising the foundation to the highest
                    // corner means nothing sticks out; the lower corners
                    // sink invisibly under the surface, which is fine.
                    float? footprintMaxZ = SampleFootprintMaxGroundZ(
                        building.ModelId, newLbKey,
                        building.Frame.Origin.X, building.Frame.Origin.Y,
                        building.Frame.Orientation);
                    // Group override: when this building belongs to a
                    // multi-member group on this landblock, use the shared
                    // group Z so all members are coplanar.
                    uint myGroupKey = _buildingPairings.GroupKey(building.ModelId);
                    float? groupZ = groupTargetZ.TryGetValue(myGroupKey, out var gz)
                        ? gz : (float?)null;
                    float targetGroundZ = groupZ
                        ?? footprintMaxZ
                        ?? placement.destinationGroundZ
                        ?? (sourceGroundZ + fallbackDeltaZ);

                    // Z policy:
                    //  - preserveRetailZProfile=true: keep the retail
                    //    origin-to-ground offset exactly (legacy path).
                    //  - default (flush): place the origin AT targetGroundZ.
                    //    AC's flat-bottom buildings sit cleanly on the
                    //    raised-corner ground; the offset is implicitly 0.
                    float retainedOriginToGroundOffset = preserveRetailZProfile
                        ? sourceOriginToGroundOffset
                        : 0f;
                    float newZ = targetGroundZ + retainedOriginToGroundOffset;
                    float placedZ = flattenTerrain ? heightTable[FindClosestHeightIdx(newZ)] : newZ;

                    if (!preserveRetailZProfile &&
                        Math.Abs(sourceOriginToGroundOffset) > 1.0f) {
                        warnings.Add(
                            $"Building 0x{building.ModelId:X8} in LB 0x{newLbKey:X4}: " +
                            $"retail Z profile differed from ground by {sourceOriginToGroundOffset:F2}m " +
                            $"(replaced with flush placement; doors/NPCs ride the same shift)");
                    }

                    destDoc.AddStaticObject(new StaticObject {
                        Id = building.ModelId,
                        IsSetup = (building.ModelId & 0x02000000) != 0,
                        Origin = new Vector3(worldX, worldY, placedZ),
                        Orientation = building.Frame.Orientation,
                        Scale = Vector3.One
                    });

                    var destinationLocalOrigin = new Vector3(
                        building.Frame.Origin.X, building.Frame.Origin.Y, placedZ);
                    BuildingBlueprintCache.RegisterPlacementDonorHint(
                        building.ModelId, newLbKey, destinationLocalOrigin, oldLbKey, bIdx);
                    _ = BuildingBlueprintCache.GetBlueprintFromDonor(
                        building.ModelId, oldLbKey, bIdx, dats);

                    // Build a source-LB-local footprint polygon for door
                    // containment tests below. Falls back to None when the
                    // ontology has no footprint — those buildings still
                    // place correctly, but their doors will use per-position
                    // sampling (legacy behaviour).
                    System.Numerics.Vector2[] sourcePoly = Array.Empty<System.Numerics.Vector2>();
                    var ontEntry = _ontologyService.IsScanned
                        ? _ontologyService.GetEntry(building.ModelId) : null;
                    if (ontEntry?.FootprintCorners is { Length: >= 3 } modelCorners) {
                        sourcePoly = WorldBuilder.Shared.Lib.Geometry.FootprintGeometry.WorldFootprint(
                            modelCorners, building.Frame.Orientation,
                            building.Frame.Origin.X, building.Frame.Origin.Y);
                    }
                    float buildingDeltaZ = placedZ - building.Frame.Origin.Z;
                    if (sourcePoly.Length >= 3) {
                        sourceBuildingFootprints.Add((sourcePoly, buildingDeltaZ, building.ModelId));
                    }

                    // Flatten terrain under the building. We still use the
                    // circumradius for the carve area itself (the carve is
                    // just an approximation of where to flatten); the Z we
                    // flatten TO is now the corner-max targetGroundZ.
                    if (flattenTerrain) {
                        float modelRadius = EstimateModelFootprintRadius(building.ModelId);
                        float effectiveFlattenRadius = Math.Clamp(
                            MathF.Max(flattenRadius, modelRadius),
                            flattenRadius,
                            96f);

                        FlattenTerrainAt(worldX, worldY, targetGroundZ, effectiveFlattenRadius);

                        float sampleRadius = MathF.Max(8f, effectiveFlattenRadius * 0.75f);
                        float mismatch = SampleFoundationMismatch(worldX, worldY, sampleRadius, targetGroundZ);
                        if (mismatch > foundationAutoFixThresholdMeters) {
                            float correctiveRadius = MathF.Min(96f, effectiveFlattenRadius + 10f);
                            FlattenTerrainAt(worldX, worldY, targetGroundZ, correctiveRadius);
                            terrainAutoFixPasses++;

                            float mismatchAfterFix = SampleFoundationMismatch(
                                worldX, worldY, MathF.Max(8f, correctiveRadius * 0.75f), targetGroundZ);
                            if (mismatchAfterFix > foundationResidualWarnThresholdMeters) {
                                warnings.Add(
                                    $"Foundation mismatch remains for model 0x{building.ModelId:X8} in LB 0x{newLbKey:X4} (max delta {mismatchAfterFix:F1}m)");
                            }
                        }
                    }

                    var oldCellIds = CollectBuildingCellIdsExternal(building, dats, oldLbKey);
                    oldCellIdMap[$"{oldLbKey:X4}_{bIdx}"] = new {
                        modelId = building.ModelId,
                        oldLbKey,
                        oldBuildingIndex = bIdx,
                        newLbKey,
                        sourceLocalOrigin = new {
                            x = building.Frame.Origin.X,
                            y = building.Frame.Origin.Y,
                            z = building.Frame.Origin.Z
                        },
                        destinationLocalOrigin = new {
                            x = destinationLocalOrigin.X,
                            y = destinationLocalOrigin.Y,
                            z = destinationLocalOrigin.Z
                        },
                        // Per-building Z delta. Indoor NPC reposition uses
                        // this to apply the same shift to every weenie that
                        // lives in this building's interior cells.
                        deltaZ = buildingDeltaZ,
                        oldCells = oldCellIds.OrderBy(c => c).ToArray()
                    };

                    buildingShellsCopied++;
                }

                // 3b. Copy objects. Doors and decorations whose XY falls
                // inside any building's footprint ride that building's Z
                // delta — they were retail-aligned to the building, not to
                // the underlying terrain, so independent terrain-sampling
                // would re-introduce the half-metre door-too-high bug.
                foreach (var obj in oldLbi.Objects) {
                    float worldX = newLbX * 192f + obj.Frame.Origin.X;
                    float worldY = newLbY * 192f + obj.Frame.Origin.Y;

                    float? rideDeltaZ = null;
                    var objLocalXY = new System.Numerics.Vector2(
                        obj.Frame.Origin.X, obj.Frame.Origin.Y);
                    foreach (var (poly, dz, _) in sourceBuildingFootprints) {
                        if (WorldBuilder.Shared.Lib.Geometry.FootprintGeometry.PointInPolygon(
                                objLocalXY, poly)) {
                            rideDeltaZ = dz;
                            break;
                        }
                    }

                    float newZ;
                    if (rideDeltaZ.HasValue) {
                        // Inside a building footprint — preserve retail
                        // relative-to-building Z exactly. No terrain sample,
                        // no clamp.
                        newZ = obj.Frame.Origin.Z + rideDeltaZ.Value;
                    } else {
                        // Outside any footprint — terrain-relative object
                        // (statue, post, well). Use per-position sampling.
                        var placement = ComputePlacementDeltaDetailed(
                            oldLbKey, newLbKey,
                            obj.Frame.Origin.X, obj.Frame.Origin.Y, fallbackDeltaZ);
                        float sourceGroundZ = placement.sourceGroundZ
                            ?? (obj.Frame.Origin.Z - fallbackDeltaZ);
                        float sourceOriginToGroundOffset = obj.Frame.Origin.Z - sourceGroundZ;
                        float retainedOriginToGroundOffset = preserveRetailZProfile
                            ? sourceOriginToGroundOffset
                            : Math.Clamp(sourceOriginToGroundOffset, -3f, 4f);
                        float targetGroundZ = placement.destinationGroundZ
                            ?? (sourceGroundZ + fallbackDeltaZ);
                        newZ = targetGroundZ + retainedOriginToGroundOffset;
                    }
                    float placedZ = flattenTerrain ? heightTable[FindClosestHeightIdx(newZ)] : newZ;

                    destDoc.AddStaticObject(new StaticObject {
                        Id = obj.Id,
                        IsSetup = (obj.Id & 0x02000000) != 0,
                        Origin = new Vector3(worldX, worldY, placedZ),
                        Orientation = obj.Frame.Orientation,
                        Scale = Vector3.One
                    });

                    staticObjectsCopied++;
                }

                var totalCopied = staticObjectsCopied + buildingShellsCopied;
                if (totalCopied % 500 == 0 && totalCopied > 0)
                    Console.WriteLine($"  ... {totalCopied} placements copied");
            }

            // 4. Apply all accumulated terrain changes in one batch.
            if (terrainBatchChanges.Count > 0) {
                terrainDoc.UpdateLandblocksBatchInternal(terrainBatchChanges, out _);
                Console.WriteLine($"  Flattened {terrainVerticesFlattened} terrain vertices under {terrainBatchChanges.Count} landblocks");
                if (terrainAutoFixPasses > 0)
                    Console.WriteLine($"  Terrain auto-fix passes applied: {terrainAutoFixPasses}");
            }

            // 4b. Run placement validators on touched destination landblocks.
            if (runPlacementValidators && touchedDestinationLbs.Count > 0) {
                int validatedCount = 0;
                int validationErrors = 0;
                int validationWarnings = 0;
                var errorLandblocks = new List<ushort>();

                var (_, _, heightLookup) = GetTerrainHelpers();
                foreach (var lbKey in touchedDestinationLbs.OrderBy(k => k)) {
                    var lbDoc = GetLandblockDoc(lbKey);
                    var lbReport = ValidationEngine.ValidateLandblock(lbDoc, lbKey, heightLookup, dats);
                    var terrainReport = ValidationEngine.ValidateTerrain(terrainDoc, lbKey, heightTable);

                    validatedCount++;
                    validationErrors += lbReport.ErrorCount + terrainReport.ErrorCount;
                    validationWarnings += lbReport.WarningCount + terrainReport.WarningCount;

                    if (lbReport.ErrorCount + terrainReport.ErrorCount > 0)
                        errorLandblocks.Add(lbKey);
                }

                Console.WriteLine($"  Validators checked {validatedCount} destination landblocks ({validationErrors} errors, {validationWarnings} warnings)");
                if (errorLandblocks.Count > 0) {
                    warnings.Add("Placement validator errors in destination landblocks: " +
                                 string.Join(", ", errorLandblocks.Take(12).Select(k => $"0x{k:X4}")) +
                                 (errorLandblocks.Count > 12 ? " ..." : ""));
                }
            }

            Console.WriteLine($"  Copied {buildingShellsCopied} building shells + {staticObjectsCopied} static objects from {lbsWithBuildings} landblocks");

            // 5. Save old cell ID map for post-export SQL generation.
            string? mapPath = null;
            if (oldCellIdMap.Count > 0) {
                mapPath = Path.Combine(project.ProjectDirectory, "building_old_cells.json");
                var json = System.Text.Json.JsonSerializer.Serialize(oldCellIdMap,
                    WorldBuilder.Shared.Lib.JsonOpts.Indented);
                File.WriteAllText(mapPath, json, new System.Text.UTF8Encoding(false));
                Console.WriteLine($"  Saved old cell ID map -> {mapPath}");
            }

            sw.Stop();
            return new RemapBuildingsV2Result(
                true, landblocksScanned, lbsWithBuildings,
                buildingShellsCopied, staticObjectsCopied, terrainVerticesFlattened,
                sw.ElapsedMilliseconds, mapPath, warnings);
        } catch (Exception ex) {
            sw.Stop();
            return new RemapBuildingsV2Result(false, 0, 0, 0, 0, 0,
                sw.ElapsedMilliseconds, Error: ex.Message, Warnings: warnings);
        }
    }

    /// <summary>
    /// Flattens terrain vertices within a given radius of a world position
    /// to the height of the center vertex. Returns number of vertices modified.
    /// </summary>
    private int FlattenTerrainUnderBuilding(TerrainDocument terrainDoc, float[] heightTable,
        float worldX, float worldY, float radius, ushort lbKey) {

        uint lbX = (uint)(lbKey >> 8) & 0xFF;
        uint lbY = (uint)lbKey & 0xFF;

        var terrainData = terrainDoc.GetLandblockInternal(lbKey);
        if (terrainData == null) return 0;

        // Find the center vertex height index
        float localX = worldX - lbX * 192f;
        float localY = worldY - lbY * 192f;
        int centerVx = Math.Clamp((int)Math.Round(localX / 24f), 0, 8);
        int centerVy = Math.Clamp((int)Math.Round(localY / 24f), 0, 8);
        byte centerHeight = terrainData[centerVx * 9 + centerVy].Height;

        float radiusSq = radius * radius;
        int modified = 0;

        var changes = new Dictionary<ushort, Dictionary<byte, uint>>();

        // Check vertices in this landblock (and potentially adjacent ones)
        for (int vx = 0; vx <= 8; vx++) {
            for (int vy = 0; vy <= 8; vy++) {
                float vertWorldX = lbX * 192f + vx * 24f;
                float vertWorldY = lbY * 192f + vy * 24f;
                float dx = vertWorldX - worldX;
                float dy = vertWorldY - worldY;

                if (dx * dx + dy * dy <= radiusSq) {
                    int idx = vx * 9 + vy;
                    if (terrainData[idx].Height != centerHeight) {
                        if (!changes.TryGetValue(lbKey, out var lbChanges)) {
                            lbChanges = new Dictionary<byte, uint>();
                            changes[lbKey] = lbChanges;
                        }
                        var entry = terrainData[idx] with { Height = centerHeight };
                        lbChanges[(byte)idx] = entry.ToUInt();
                        modified++;
                    }
                }
            }
        }

        if (changes.Count > 0) {
            terrainDoc.UpdateLandblocksBatchInternal(changes, out _);
        }

        return modified;
    }

    /// <summary>
    /// Collects all EnvCell IDs belonging to a building (BFS through portals).
    /// Static version for use outside LandblockDocument.
    /// </summary>
    private static HashSet<ushort> CollectBuildingCellIdsExternal(
        BuildingInfo building, IDatReaderWriter dats, uint lbId) {
        var cellIds = new HashSet<ushort>();
        var toVisit = new Queue<ushort>();

        foreach (var portal in building.Portals) {
            if (portal.OtherCellId >= 0x0100 && portal.OtherCellId <= 0xFFFD
                && cellIds.Add(portal.OtherCellId))
                toVisit.Enqueue(portal.OtherCellId);

            foreach (var stab in portal.StabList) {
                if (stab >= 0x0100 && stab <= 0xFFFD && cellIds.Add(stab))
                    toVisit.Enqueue(stab);
            }
        }

        while (toVisit.Count > 0) {
            var cellNum = toVisit.Dequeue();
            uint fullCellId = (lbId << 16) | cellNum;

            if (dats.TryGet<EnvCell>(fullCellId, out var envCell)) {
                foreach (var cp in envCell.CellPortals) {
                    if (cp.OtherCellId >= 0x0100 && cp.OtherCellId <= 0xFFFD
                        && cellIds.Add(cp.OtherCellId))
                        toVisit.Enqueue(cp.OtherCellId);
                }
            }
        }

        return cellIds;
    }

    private sealed class BuildingOldCellsMapEntry {
        public uint modelId { get; set; }
        public ushort oldLbKey { get; set; }
        public int oldBuildingIndex { get; set; }
        public ushort newLbKey { get; set; }
        public BuildingOldCellsMapLocalOrigin? destinationLocalOrigin { get; set; }
        public ushort[] oldCells { get; set; } = Array.Empty<ushort>();
    }

    private sealed class BuildingOldCellsMapLocalOrigin {
        public float x { get; set; }
        public float y { get; set; }
        public float z { get; set; }
    }

    /// <summary>
    /// Post-export: compares retail base DATs with exported DATs to find oldâ†’new
    /// cell ID mappings, then generates (and optionally applies) SQL to update
    /// interior instance obj_Cell_Id values.
    /// </summary>
    public RemapBuildingsSqlResult GenerateBuildingRemapSql(
        string remapJsonPath, string exportedDatDir, string outputSqlPath,
        bool apply = false) {
        RequireProject();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var warnings = new List<string>();

        try {
            // â”€â”€ 1. Load lb_remap.json â”€â”€
            if (!File.Exists(remapJsonPath))
                return new RemapBuildingsSqlResult(false, 0, 0, 0,
                    Error: $"Remap file not found: {remapJsonPath}");

            var remapJson = File.ReadAllText(remapJsonPath);
            var rawRemap = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(remapJson);
            if (rawRemap == null || rawRemap.Count == 0)
                return new RemapBuildingsSqlResult(false, 0, 0, 0,
                    Error: "Empty or invalid remap JSON");

            var lbRemap = new Dictionary<ushort, ushort>();
            foreach (var (key, val) in rawRemap) {
                var oldParts = key.Split(',');
                var newParts = val.Split(',');
                if (oldParts.Length != 2 || newParts.Length != 2) continue;
                int oldX = int.Parse(oldParts[0]), oldY = int.Parse(oldParts[1]);
                int newX = int.Parse(newParts[0]), newY = int.Parse(newParts[1]);
                ushort oldKey = (ushort)((oldX << 8) | oldY);
                ushort newKey = (ushort)((newX << 8) | newY);
                lbRemap[oldKey] = newKey;
            }

            // â”€â”€ 2. Open both sets of DATs â”€â”€
            var project = _projectManager.CurrentProject!;
            var retailDats = project.DocumentManager.Dats; // base DATs (read-only)

            string exportedCellPath = Path.Combine(exportedDatDir, "client_cell_1.dat");
            if (!File.Exists(exportedCellPath))
                return new RemapBuildingsSqlResult(false, 0, 0, 0,
                    Error: $"Exported DATs not found in {exportedDatDir}");

            string oldCellMapPath = Path.Combine(project.ProjectDirectory, "building_old_cells.json");
            if (File.Exists(oldCellMapPath)) {
                // Some copy/export paths preserve legacy LastWriteTime values from source DATs.
                // Use the newer of creation/write times to avoid false stale-export failures.
                var exportWriteTimeUtc = File.GetLastWriteTimeUtc(exportedCellPath);
                var exportCreateTimeUtc = File.GetCreationTimeUtc(exportedCellPath);
                var effectiveExportTimeUtc = exportWriteTimeUtc > exportCreateTimeUtc
                    ? exportWriteTimeUtc
                    : exportCreateTimeUtc;
                var mapWriteTimeUtc = File.GetLastWriteTimeUtc(oldCellMapPath);
                if (effectiveExportTimeUtc < mapWriteTimeUtc) {
                    string staleMsg =
                        $"Exported DAT appears stale (client_cell_1.dat effective time {effectiveExportTimeUtc:O}; " +
                        $"last-write {exportWriteTimeUtc:O}, creation {exportCreateTimeUtc:O} " +
                        $"older than building_old_cells.json {mapWriteTimeUtc:O}). " +
                        "Run export after remap-buildings-v2, then rerun remap-buildings-sql.";
                    if (apply) {
                        return new RemapBuildingsSqlResult(false, 0, 0, 0,
                            Error: staleMsg, Warnings: warnings);
                    }
                    warnings.Add(staleMsg);
                }
            }

            using var exportedDats = new DefaultDatReaderWriter(exportedDatDir, DatAccessType.Read);

            // â”€â”€ 3. For each remap, match old cells to new cells â”€â”€
            var cellIdRemap = new Dictionary<uint, (
                uint newCellId,
                bool applyFrameAdjust,
                float r11, float r12, float r13,
                float r21, float r22, float r23,
                float r31, float r32, float r33,
                float tx, float ty, float tz,
                float qW, float qX, float qY, float qZ)>();
            int buildingsMatched = 0;

            // Group by destination landblock to handle multi-building destinations.
            // Prefer explicit donor/building-index hints from building_old_cells.json.
            var destGrouped = new Dictionary<ushort, List<(
                ushort oldLbKey,
                int oldBuildingIndex,
                Vector3? destinationLocalOrigin,
                BuildingInfo oldBuilding,
                ushort[] oldCells)>>();
            var hintedOldBuildings = new HashSet<(ushort oldLbKey, int oldBuildingIndex)>();

            if (File.Exists(oldCellMapPath)) {
                try {
                    var mapJson = File.ReadAllText(oldCellMapPath);
                    var oldCellMap = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, BuildingOldCellsMapEntry>>(mapJson);
                    if (oldCellMap != null) {
                        int hintCount = 0;
                        foreach (var (_, entry) in oldCellMap) {
                            if (entry == null || entry.oldCells == null || entry.oldCells.Length == 0)
                                continue;

                            uint oldInfoId = ((uint)entry.oldLbKey << 16) | 0xFFFE;
                            if (!retailDats.TryGet<LandBlockInfo>(oldInfoId, out var oldLbi)) {
                                warnings.Add($"Hint skipped: source LB 0x{entry.oldLbKey:X4} missing for building idx {entry.oldBuildingIndex}");
                                continue;
                            }
                            if (entry.oldBuildingIndex < 0 || entry.oldBuildingIndex >= oldLbi.Buildings.Count) {
                                warnings.Add($"Hint skipped: invalid building index {entry.oldBuildingIndex} in LB 0x{entry.oldLbKey:X4}");
                                continue;
                            }

                            var oldBuilding = oldLbi.Buildings[entry.oldBuildingIndex];
                            if (oldBuilding.ModelId != entry.modelId) {
                                warnings.Add($"Hint model mismatch in LB 0x{entry.oldLbKey:X4} idx {entry.oldBuildingIndex}: map=0x{entry.modelId:X8}, dat=0x{oldBuilding.ModelId:X8}");
                            }

                            var oldCells = entry.oldCells
                                .Where(c => c >= 0x0100 && c <= 0xFFFD)
                                .Distinct()
                                .OrderBy(c => c)
                                .ToArray();
                            if (oldCells.Length == 0)
                                continue;

                            Vector3? destinationLocalOrigin = entry.destinationLocalOrigin == null
                                ? null
                                : new Vector3(
                                    entry.destinationLocalOrigin.x,
                                    entry.destinationLocalOrigin.y,
                                    entry.destinationLocalOrigin.z);

                            if (!destGrouped.TryGetValue(entry.newLbKey, out var list)) {
                                list = new();
                                destGrouped[entry.newLbKey] = list;
                            }
                            list.Add((entry.oldLbKey, entry.oldBuildingIndex, destinationLocalOrigin, oldBuilding, oldCells));
                            hintedOldBuildings.Add((entry.oldLbKey, entry.oldBuildingIndex));
                            hintCount++;
                        }

                        if (hintCount > 0) {
                            Console.WriteLine($"  Loaded {hintCount} building hint entries from {oldCellMapPath}");
                        }
                    }
                } catch (Exception ex) {
                    warnings.Add($"Failed to parse building_old_cells.json ({ex.Message}); falling back to heuristic grouping");
                }
            }

            // Fallback for any old building not covered by explicit hints.
            foreach (var (oldLbKey, newLbKey) in lbRemap) {
                if (oldLbKey == newLbKey) continue;

                uint oldInfoId = (uint)(oldLbKey << 16) | 0xFFFE;
                if (!retailDats.TryGet<LandBlockInfo>(oldInfoId, out var oldLbi)) continue;
                if (oldLbi.Buildings.Count == 0) continue;

                for (int oldBuildingIndex = 0; oldBuildingIndex < oldLbi.Buildings.Count; oldBuildingIndex++) {
                    if (hintedOldBuildings.Contains((oldLbKey, oldBuildingIndex)))
                        continue;

                    var oldBuilding = oldLbi.Buildings[oldBuildingIndex];
                    var oldCells = CollectBuildingCellIdsExternal(oldBuilding, retailDats, oldLbKey)
                        .OrderBy(c => c).ToArray();
                    if (oldCells.Length == 0) continue;

                    if (!destGrouped.TryGetValue(newLbKey, out var list)) {
                        list = new();
                        destGrouped[newLbKey] = list;
                    }
                    list.Add((oldLbKey, oldBuildingIndex, null, oldBuilding, oldCells));
                }
            }

            // Now look at exported DATs to find matching buildings
            foreach (var (newLbKey, entries) in destGrouped) {
                uint newInfoId = (uint)(newLbKey << 16) | 0xFFFE;
                if (!exportedDats.TryGet<LandBlockInfo>(newInfoId, out var newLbi)) {
                    warnings.Add($"Dest LB 0x{newLbKey:X4} has no LandBlockInfo in exported DATs");
                    continue;
                }

                // Match buildings by ModelId + nearest hinted destination origin when available.
                var usedNewBuildings = new HashSet<int>();
                foreach (var (oldLbKey, oldBuildingIndex, destinationLocalOrigin, oldBuilding, oldCells) in entries) {
                    uint modelId = oldBuilding.ModelId;
                    bool hasDestinationHint = destinationLocalOrigin.HasValue;
                    float targetLocalX = destinationLocalOrigin?.X ?? oldBuilding.Frame.Origin.X;
                    float targetLocalY = destinationLocalOrigin?.Y ?? oldBuilding.Frame.Origin.Y;
                    float targetLocalZ = destinationLocalOrigin?.Z ?? oldBuilding.Frame.Origin.Z;

                    // Find nearest matching model in destination LBI.
                    int matchIdx = -1;
                    float bestDist2 = float.MaxValue;
                    for (int i = 0; i < newLbi.Buildings.Count; i++) {
                        if (usedNewBuildings.Contains(i)) continue;
                        if (newLbi.Buildings[i].ModelId != modelId) continue;
                        float dx = newLbi.Buildings[i].Frame.Origin.X - targetLocalX;
                        float dy = newLbi.Buildings[i].Frame.Origin.Y - targetLocalY;
                        float dz = hasDestinationHint
                            ? (newLbi.Buildings[i].Frame.Origin.Z - targetLocalZ)
                            : 0f;
                        float dist2 = dx * dx + dy * dy + dz * dz;
                        if (dist2 < bestDist2) {
                            bestDist2 = dist2;
                            matchIdx = i;
                        }
                    }

                    if (matchIdx < 0) {
                        warnings.Add($"Building 0x{modelId:X8} from LB 0x{oldLbKey:X4} idx {oldBuildingIndex} not found in dest LB 0x{newLbKey:X4}");
                        continue;
                    }

                    float suspiciousDelta = hasDestinationHint ? 6f : 24f;
                    if (bestDist2 > suspiciousDelta * suspiciousDelta) {
                        warnings.Add($"Building 0x{modelId:X8} in LB 0x{newLbKey:X4}: large match delta " +
                            $"sqrt({bestDist2:F2})={MathF.Sqrt(bestDist2):F2}m (target=({targetLocalX:F2},{targetLocalY:F2},{targetLocalZ:F2}), " +
                            $"new=({newLbi.Buildings[matchIdx].Frame.Origin.X:F2},{newLbi.Buildings[matchIdx].Frame.Origin.Y:F2},{newLbi.Buildings[matchIdx].Frame.Origin.Z:F2}))");
                    }

                    usedNewBuildings.Add(matchIdx);
                    var newBuilding = newLbi.Buildings[matchIdx];
                    var newCells = CollectBuildingCellIdsExternal(newBuilding, exportedDats, newLbKey)
                        .OrderBy(c => c).ToArray();

                    // Build old/new cell metadata for spatial matching.
                    var oldCellMeta = new List<(ushort cellNum, ushort env, ushort cs, Vector3 pos, Quaternion orientation)>();
                    foreach (var oldCellNum in oldCells) {
                        uint fullId = ((uint)oldLbKey << 16) | oldCellNum;
                        if (retailDats.TryGet<EnvCell>(fullId, out var ec)) {
                            oldCellMeta.Add((oldCellNum, ec.EnvironmentId, ec.CellStructure, ec.Position.Origin, Quaternion.Normalize(ec.Position.Orientation)));
                        }
                    }

                    var newCellMeta = new List<(ushort cellNum, ushort env, ushort cs, Vector3 pos, Quaternion orientation)>();
                    foreach (var newCellNum in newCells) {
                        uint fullId = ((uint)newLbKey << 16) | newCellNum;
                        if (exportedDats.TryGet<EnvCell>(fullId, out var ec)) {
                            newCellMeta.Add((newCellNum, ec.EnvironmentId, ec.CellStructure, ec.Position.Origin, Quaternion.Normalize(ec.Position.Orientation)));
                        }
                    }

                    // Defensive pruning:
                    // Some BuildingPortal StabList references can resolve to unrelated EnvCells after
                    // relocation, creating spurious BFS expansion. Keep only destination cells that are
                    // spatially near the matched building origin.
                    if (oldCellMeta.Count > 0 && newCellMeta.Count > 0) {
                        float oldMaxRadius = oldCellMeta
                            .Max(c => Vector3.Distance(c.pos, oldBuilding.Frame.Origin));
                        float allowedRadius = Math.Max(24f, oldMaxRadius + 12f);

                        var pruned = newCellMeta
                            .Where(c => Vector3.Distance(c.pos, newBuilding.Frame.Origin) <= allowedRadius)
                            .ToList();

                        if (pruned.Count > 0 && pruned.Count < newCellMeta.Count) {
                            warnings.Add($"Building 0x{modelId:X8} LB 0x{newLbKey:X4}: " +
                                $"pruned {newCellMeta.Count - pruned.Count} outlier EnvCells " +
                                $"beyond {allowedRadius:F1}m from building origin");
                            newCellMeta = pruned;
                        }
                    }

                    if (oldCellMeta.Count == 0 || newCellMeta.Count == 0) {
                        warnings.Add($"Building 0x{modelId:X8} in LB 0x{newLbKey:X4}: missing EnvCell metadata (old={oldCellMeta.Count}, new={newCellMeta.Count})");
                        continue;
                    }

                    if (oldCellMeta.Count != newCellMeta.Count) {
                        warnings.Add($"Building 0x{modelId:X8}: cell count mismatch " +
                            $"(old={oldCellMeta.Count}, new={newCellMeta.Count})");
                    }

                    var oldRotInv = Quaternion.Inverse(oldBuilding.Frame.Orientation);
                    var rotationDelta = Quaternion.Normalize(newBuilding.Frame.Orientation * oldRotInv);
                    Vector3 ExpectedNewPos(Vector3 oldPos) {
                        var relative = oldPos - oldBuilding.Frame.Origin;
                        var rotated = Vector3.Transform(relative, rotationDelta);
                        return newBuilding.Frame.Origin + rotated;
                    }

                    int cellsMatched = 0;
                    const float strictMatchMaxErrorMeters = 24f;
                    const float fallbackMatchMaxErrorMeters = 12f;
                    var usedNewCells = new HashSet<int>();
                    foreach (var oldMeta in oldCellMeta) {
                        var expected = ExpectedNewPos(oldMeta.pos);

                        int FindBestCandidate(bool requireTemplateMatch, float maxErrorMeters) {
                            int bestIndex = -1;
                            float bestScore = float.MaxValue;
                            float maxErrorSq = maxErrorMeters * maxErrorMeters;
                            for (int i = 0; i < newCellMeta.Count; i++) {
                                if (usedNewCells.Contains(i)) continue;
                                var candidate = newCellMeta[i];
                                bool templateMatches = candidate.env == oldMeta.env && candidate.cs == oldMeta.cs;
                                if (requireTemplateMatch && !templateMatches) continue;

                                float d2 = Vector3.DistanceSquared(candidate.pos, expected);
                                if (d2 > maxErrorSq) continue;
                                if (!requireTemplateMatch && !templateMatches) {
                                    // Strongly discourage cross-template matches but allow fallback.
                                    d2 += 1_000_000f;
                                }

                                if (d2 < bestScore) {
                                    bestScore = d2;
                                    bestIndex = i;
                                }
                            }
                            return bestIndex;
                        }

                        int bestIdx = FindBestCandidate(requireTemplateMatch: true, strictMatchMaxErrorMeters);
                        bool strictTemplateMatch = true;
                        if (bestIdx < 0) {
                            bestIdx = FindBestCandidate(requireTemplateMatch: false, fallbackMatchMaxErrorMeters);
                            strictTemplateMatch = false;
                        }
                        if (bestIdx < 0) {
                            warnings.Add($"Building 0x{modelId:X8} LB 0x{newLbKey:X4}: no candidate within thresholds " +
                                $"for old=0x{oldMeta.cellNum:X4} (strict<={strictMatchMaxErrorMeters:F1}m, fallback<={fallbackMatchMaxErrorMeters:F1}m)");
                            continue;
                        }

                        var chosen = newCellMeta[bestIdx];
                        usedNewCells.Add(bestIdx);

                        uint oldFullCellId = ((uint)oldLbKey << 16) | oldMeta.cellNum;
                        uint newFullCellId = ((uint)newLbKey << 16) | chosen.cellNum;
                        float spatialError = Vector3.Distance(chosen.pos, expected);
                        float rawDeltaX = chosen.pos.X - oldMeta.pos.X;
                        float rawDeltaY = chosen.pos.Y - oldMeta.pos.Y;
                        float rawDeltaZ = chosen.pos.Z - oldMeta.pos.Z;
                        bool confidentFrameAdjust = strictTemplateMatch && spatialError <= 6f;

                        if (confidentFrameAdjust) {
                            // Convert old world-space instance frames into the new cell frame:
                            // R = newCellQ * inverse(oldCellQ)
                            // p' = R * p + (newCellPos - R * oldCellPos)
                            var frameDelta = Quaternion.Normalize(chosen.orientation * Quaternion.Inverse(oldMeta.orientation));
                            var translation = chosen.pos - Vector3.Transform(oldMeta.pos, frameDelta);

                            // Build a row-major linear transform for SQL:
                            // newLocal = R * oldLocal + t
                            var basisX = Vector3.Transform(Vector3.UnitX, frameDelta);
                            var basisY = Vector3.Transform(Vector3.UnitY, frameDelta);
                            var basisZ = Vector3.Transform(Vector3.UnitZ, frameDelta);

                            cellIdRemap[oldFullCellId] = (
                                newFullCellId,
                                true,
                                basisX.X, basisY.X, basisZ.X,
                                basisX.Y, basisY.Y, basisZ.Y,
                                basisX.Z, basisY.Z, basisZ.Z,
                                translation.X, translation.Y, translation.Z,
                                frameDelta.W, frameDelta.X, frameDelta.Y, frameDelta.Z);
                        } else {
                            cellIdRemap[oldFullCellId] = (
                                newFullCellId,
                                false,
                                1f, 0f, 0f,
                                0f, 1f, 0f,
                                0f, 0f, 1f,
                                0f, 0f, 0f,
                                1f, 0f, 0f, 0f);
                        }
                        cellsMatched++;

                        if (!strictTemplateMatch) {
                            warnings.Add($"Building 0x{modelId:X8} LB 0x{newLbKey:X4}: fallback cell match old=0x{oldMeta.cellNum:X4} -> new=0x{chosen.cellNum:X4} (spatialError={spatialError:F2}m)");
                        } else if (spatialError > 6f) {
                            warnings.Add($"Building 0x{modelId:X8} LB 0x{newLbKey:X4}: large cell spatial error old=0x{oldMeta.cellNum:X4} -> new=0x{chosen.cellNum:X4} ({spatialError:F2}m)");
                        }
                        if (!confidentFrameAdjust &&
                            (Math.Abs(rawDeltaX) > 0.01f || Math.Abs(rawDeltaY) > 0.01f || Math.Abs(rawDeltaZ) > 0.01f)) {
                            warnings.Add($"Building 0x{modelId:X8} LB 0x{newLbKey:X4}: keeping origin/angles unchanged for old=0x{oldMeta.cellNum:X4} " +
                                $"(uncertain match, rawDelta=({rawDeltaX:F2},{rawDeltaY:F2},{rawDeltaZ:F2}))");
                        }
                    }

                    if (cellsMatched < oldCells.Length && cellsMatched < newCells.Length) {
                        warnings.Add($"Building 0x{modelId:X8} in LB 0x{newLbKey:X4}: " +
                            $"only {cellsMatched}/{oldCells.Length} cells matched");
                    }

                    buildingsMatched++;
                }
            }

            Console.WriteLine($"  Matched {buildingsMatched} buildings, {cellIdRemap.Count} cell ID remaps");

            // â”€â”€ 4. Generate SQL â”€â”€
            string? sqlFilePath = null;
            if (cellIdRemap.Count > 0) {
                var sb = new System.Text.StringBuilder();
                sb.AppendLine("-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
                sb.AppendLine("-- Vanquish World â€” Interior Instance Remap V2 (Layer Pipeline)");
                sb.AppendLine($"-- Generated: {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
                sb.AppendLine($"-- Buildings matched: {buildingsMatched}");
                sb.AppendLine($"-- Cell ID remaps: {cellIdRemap.Count}");
                sb.AppendLine("-- NOTE: Adjusts origin_X/Y/Z + angles_W/X/Y/Z only for confident cell matches");
                sb.AppendLine("-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
                sb.AppendLine();
                sb.AppendLine("USE `ace_world`;");
                sb.AppendLine();

                static string SqlFloat(float value) =>
                    value.ToString("0.######", CultureInfo.InvariantCulture);

                foreach (var (oldFullCellId, remap) in cellIdRemap) {
                    uint newFullCellId = remap.newCellId;
                    bool applyFrameAdjust = remap.applyFrameAdjust;
                    ushort oldLbXc = (ushort)((oldFullCellId >> 24) & 0xFF);
                    ushort oldLbYc = (ushort)((oldFullCellId >> 16) & 0xFF);
                    ushort oldCellIdx = (ushort)(oldFullCellId & 0xFFFF);
                    ushort newLbXc = (ushort)((newFullCellId >> 24) & 0xFF);
                    ushort newLbYc = (ushort)((newFullCellId >> 16) & 0xFF);
                    ushort newCellIdx = (ushort)(newFullCellId & 0xFFFF);

                    sb.AppendLine(
                        $"-- LB({oldLbXc},{oldLbYc}) cell 0x{oldCellIdx:X4} â†’ LB({newLbXc},{newLbYc}) cell 0x{newCellIdx:X4}");
                    if (applyFrameAdjust) {
                        sb.AppendLine("UPDATE `landblock_instance` li");
                        sb.AppendLine($"JOIN `landblock_instance` src ON src.`guid` = li.`guid` AND li.`obj_Cell_Id` = {oldFullCellId}");
                        sb.AppendLine("SET");
                        sb.AppendLine($"  li.`obj_Cell_Id` = {newFullCellId},");
                        sb.AppendLine($"  li.`origin_X` = {SqlFloat(remap.r11)} * src.`origin_X` + {SqlFloat(remap.r12)} * src.`origin_Y` + {SqlFloat(remap.r13)} * src.`origin_Z` + {SqlFloat(remap.tx)},");
                        sb.AppendLine($"  li.`origin_Y` = {SqlFloat(remap.r21)} * src.`origin_X` + {SqlFloat(remap.r22)} * src.`origin_Y` + {SqlFloat(remap.r23)} * src.`origin_Z` + {SqlFloat(remap.ty)},");
                        sb.AppendLine($"  li.`origin_Z` = {SqlFloat(remap.r31)} * src.`origin_X` + {SqlFloat(remap.r32)} * src.`origin_Y` + {SqlFloat(remap.r33)} * src.`origin_Z` + {SqlFloat(remap.tz)},");
                        sb.AppendLine($"  li.`angles_W` = {SqlFloat(remap.qW)} * src.`angles_W` - {SqlFloat(remap.qX)} * src.`angles_X` - {SqlFloat(remap.qY)} * src.`angles_Y` - {SqlFloat(remap.qZ)} * src.`angles_Z`,");
                        sb.AppendLine($"  li.`angles_X` = {SqlFloat(remap.qW)} * src.`angles_X` + {SqlFloat(remap.qX)} * src.`angles_W` + {SqlFloat(remap.qY)} * src.`angles_Z` - {SqlFloat(remap.qZ)} * src.`angles_Y`,");
                        sb.AppendLine($"  li.`angles_Y` = {SqlFloat(remap.qW)} * src.`angles_Y` - {SqlFloat(remap.qX)} * src.`angles_Z` + {SqlFloat(remap.qY)} * src.`angles_W` + {SqlFloat(remap.qZ)} * src.`angles_X`,");
                        sb.AppendLine($"  li.`angles_Z` = {SqlFloat(remap.qW)} * src.`angles_Z` + {SqlFloat(remap.qX)} * src.`angles_Y` - {SqlFloat(remap.qY)} * src.`angles_X` + {SqlFloat(remap.qZ)} * src.`angles_W");
                    } else {
                        sb.AppendLine($"UPDATE `landblock_instance` SET `obj_Cell_Id` = {newFullCellId}");
                    }
                    if (applyFrameAdjust) {
                        sb.AppendLine(";");
                    } else {
                        sb.AppendLine($"  WHERE `obj_Cell_Id` = {oldFullCellId};");
                    }
                }

                sqlFilePath = outputSqlPath;
                File.WriteAllText(sqlFilePath, sb.ToString(), new System.Text.UTF8Encoding(false));
                Console.WriteLine($"  Generated SQL â†’ {sqlFilePath}");

                // Apply if requested
                if (apply && project.AceDb != null) {
                    try {
                        var connStr = project.AceDb.ConnectionString;
                        if (!connStr.Contains("Allow User Variables", StringComparison.OrdinalIgnoreCase)) {
                            connStr += ";Allow User Variables=true";
                        }
                        using var conn = new MySqlConnector.MySqlConnection(connStr);
                        conn.Open();
                        using var tx = conn.BeginTransaction();

                        using var remapCellOnlyCmd = new MySqlConnector.MySqlCommand(
                            "UPDATE `landblock_instance` SET `obj_Cell_Id` = @newCell WHERE `obj_Cell_Id` = @oldCell;",
                            conn, tx);
                        remapCellOnlyCmd.Parameters.Add("@newCell", MySqlConnector.MySqlDbType.UInt32);
                        remapCellOnlyCmd.Parameters.Add("@oldCell", MySqlConnector.MySqlDbType.UInt32);

                        using var selectCellInstancesCmd = new MySqlConnector.MySqlCommand(
                            "SELECT `guid`, `origin_X`, `origin_Y`, `origin_Z`, `angles_W`, `angles_X`, `angles_Y`, `angles_Z` " +
                            "FROM `landblock_instance` WHERE `obj_Cell_Id` = @oldCell;",
                            conn, tx);
                        selectCellInstancesCmd.Parameters.Add("@oldCell", MySqlConnector.MySqlDbType.UInt32);

                        using var remapByGuidCmd = new MySqlConnector.MySqlCommand(
                            "UPDATE `landblock_instance` SET " +
                            "`obj_Cell_Id` = @newCell, `origin_X` = @x, `origin_Y` = @y, `origin_Z` = @z, " +
                            "`angles_W` = @w, `angles_X` = @qx, `angles_Y` = @qy, `angles_Z` = @qz " +
                            "WHERE `guid` = @guid;",
                            conn, tx);
                        remapByGuidCmd.Parameters.Add("@newCell", MySqlConnector.MySqlDbType.UInt32);
                        remapByGuidCmd.Parameters.Add("@x", MySqlConnector.MySqlDbType.Float);
                        remapByGuidCmd.Parameters.Add("@y", MySqlConnector.MySqlDbType.Float);
                        remapByGuidCmd.Parameters.Add("@z", MySqlConnector.MySqlDbType.Float);
                        remapByGuidCmd.Parameters.Add("@w", MySqlConnector.MySqlDbType.Float);
                        remapByGuidCmd.Parameters.Add("@qx", MySqlConnector.MySqlDbType.Float);
                        remapByGuidCmd.Parameters.Add("@qy", MySqlConnector.MySqlDbType.Float);
                        remapByGuidCmd.Parameters.Add("@qz", MySqlConnector.MySqlDbType.Float);
                        remapByGuidCmd.Parameters.Add("@guid", MySqlConnector.MySqlDbType.UInt32);

                        foreach (var (oldFullCellId, remap) in cellIdRemap) {
                            uint newFullCellId = remap.newCellId;

                            if (!remap.applyFrameAdjust) {
                                remapCellOnlyCmd.Parameters["@newCell"].Value = newFullCellId;
                                remapCellOnlyCmd.Parameters["@oldCell"].Value = oldFullCellId;
                                remapCellOnlyCmd.ExecuteNonQuery();
                                continue;
                            }

                            selectCellInstancesCmd.Parameters["@oldCell"].Value = oldFullCellId;
                            var instances = new List<(uint guid, float ox, float oy, float oz, float aw, float ax, float ay, float az)>();
                            using (var reader = selectCellInstancesCmd.ExecuteReader()) {
                                while (reader.Read()) {
                                    instances.Add((
                                        reader.GetFieldValue<uint>(0),
                                        reader.GetFieldValue<float>(1),
                                        reader.GetFieldValue<float>(2),
                                        reader.GetFieldValue<float>(3),
                                        reader.GetFieldValue<float>(4),
                                        reader.GetFieldValue<float>(5),
                                        reader.GetFieldValue<float>(6),
                                        reader.GetFieldValue<float>(7)));
                                }
                            }

                            foreach (var instance in instances) {
                                float nx = remap.r11 * instance.ox + remap.r12 * instance.oy + remap.r13 * instance.oz + remap.tx;
                                float ny = remap.r21 * instance.ox + remap.r22 * instance.oy + remap.r23 * instance.oz + remap.ty;
                                float nz = remap.r31 * instance.ox + remap.r32 * instance.oy + remap.r33 * instance.oz + remap.tz;

                                float nw = remap.qW * instance.aw - remap.qX * instance.ax - remap.qY * instance.ay - remap.qZ * instance.az;
                                float nqx = remap.qW * instance.ax + remap.qX * instance.aw + remap.qY * instance.az - remap.qZ * instance.ay;
                                float nqy = remap.qW * instance.ay - remap.qX * instance.az + remap.qY * instance.aw + remap.qZ * instance.ax;
                                float nqz = remap.qW * instance.az + remap.qX * instance.ay - remap.qY * instance.ax + remap.qZ * instance.aw;
                                float qNorm = MathF.Sqrt(nw * nw + nqx * nqx + nqy * nqy + nqz * nqz);
                                if (qNorm > 1e-6f) {
                                    nw /= qNorm;
                                    nqx /= qNorm;
                                    nqy /= qNorm;
                                    nqz /= qNorm;
                                } else {
                                    nw = 1f;
                                    nqx = 0f;
                                    nqy = 0f;
                                    nqz = 0f;
                                }

                                remapByGuidCmd.Parameters["@newCell"].Value = newFullCellId;
                                remapByGuidCmd.Parameters["@x"].Value = nx;
                                remapByGuidCmd.Parameters["@y"].Value = ny;
                                remapByGuidCmd.Parameters["@z"].Value = nz;
                                remapByGuidCmd.Parameters["@w"].Value = nw;
                                remapByGuidCmd.Parameters["@qx"].Value = nqx;
                                remapByGuidCmd.Parameters["@qy"].Value = nqy;
                                remapByGuidCmd.Parameters["@qz"].Value = nqz;
                                remapByGuidCmd.Parameters["@guid"].Value = instance.guid;
                                remapByGuidCmd.ExecuteNonQuery();
                            }
                        }

                        tx.Commit();
                        Console.WriteLine("  Applied SQL to database");
                    } catch (Exception ex) {
                        warnings.Add($"SQL apply failed: {ex.Message}");
                    }
                }
            }

            sw.Stop();
            return new RemapBuildingsSqlResult(
                true, cellIdRemap.Count, buildingsMatched,
                sw.ElapsedMilliseconds, sqlFilePath,
                apply && cellIdRemap.Count > 0,
                warnings);
        } catch (Exception ex) {
            sw.Stop();
            return new RemapBuildingsSqlResult(false, 0, 0,
                sw.ElapsedMilliseconds, Error: ex.Message, Warnings: warnings);
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Dungeon Document Operations
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public DungeonAddCellResult DungeonAddCell(uint lbX, uint lbY,
        ushort environmentId, ushort cellStructure,
        float x, float y, float z, List<ushort>? surfaces = null) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null) return new DungeonAddCellResult(false, lbKey, 0, 0, 0, 0,
                $"Could not load dungeon document for 0x{lbKey:X4}");

            var origin = new System.Numerics.Vector3(x, y, z);
            var cellNum = doc.AddCell(environmentId, cellStructure, origin,
                System.Numerics.Quaternion.Identity, surfaces ?? new List<ushort>());

            return new DungeonAddCellResult(true, lbKey, cellNum, environmentId,
                cellStructure, doc.Cells.Count);
        } catch (Exception ex) {
            return new DungeonAddCellResult(false, lbKey, 0, 0, 0, 0, ex.Message);
        }
    }

    public DungeonRemoveCellResult DungeonRemoveCell(uint lbX, uint lbY, ushort cellNumber) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null) return new DungeonRemoveCellResult(false, lbKey, cellNumber, 0,
                $"Could not load dungeon document for 0x{lbKey:X4}");

            if (doc.GetCell(cellNumber) == null)
                return new DungeonRemoveCellResult(false, lbKey, cellNumber, doc.Cells.Count,
                    $"Cell 0x{cellNumber:X4} not found");

            doc.RemoveCell(cellNumber);
            return new DungeonRemoveCellResult(true, lbKey, cellNumber, doc.Cells.Count);
        } catch (Exception ex) {
            return new DungeonRemoveCellResult(false, lbKey, cellNumber, 0, ex.Message);
        }
    }

    public DungeonConnectResult DungeonConnect(uint lbX, uint lbY,
        ushort cellA, ushort polyA, ushort cellB, ushort polyB) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null) return new DungeonConnectResult(false, lbKey, cellA, cellB, polyA, polyB,
                $"Could not load dungeon document for 0x{lbKey:X4}");

            if (doc.GetCell(cellA) == null)
                return new DungeonConnectResult(false, lbKey, cellA, cellB, polyA, polyB,
                    $"Cell 0x{cellA:X4} not found");
            if (doc.GetCell(cellB) == null)
                return new DungeonConnectResult(false, lbKey, cellA, cellB, polyA, polyB,
                    $"Cell 0x{cellB:X4} not found");

            doc.ConnectPortals(cellA, polyA, cellB, polyB);
            return new DungeonConnectResult(true, lbKey, cellA, cellB, polyA, polyB);
        } catch (Exception ex) {
            return new DungeonConnectResult(false, lbKey, cellA, cellB, polyA, polyB, ex.Message);
        }
    }

    public DungeonDisconnectResult DungeonDisconnect(uint lbX, uint lbY,
        ushort cellA, ushort cellB) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null) return new DungeonDisconnectResult(false, lbKey, cellA, cellB, 0,
                $"Could not load dungeon document for 0x{lbKey:X4}");

            var ca = doc.GetCell(cellA);
            var cb = doc.GetCell(cellB);
            int removed = 0;

            if (ca != null) removed += ca.CellPortals.RemoveAll(p => p.OtherCellId == cellB);
            if (cb != null) removed += cb.CellPortals.RemoveAll(p => p.OtherCellId == cellA);

            if (removed > 0) doc.MarkDirty();
            return new DungeonDisconnectResult(true, lbKey, cellA, cellB, removed);
        } catch (Exception ex) {
            return new DungeonDisconnectResult(false, lbKey, cellA, cellB, 0, ex.Message);
        }
    }

    public DungeonValidateResult DungeonValidateDoc(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null || doc.Cells.Count == 0)
                return new DungeonValidateResult(true, lbKey, 0, 0, 0, 0,
                    new List<DungeonValidationIssue>(), "No dungeon data found");

            var results = doc.ValidateComprehensive();
            var issues = results.Select(r => new DungeonValidationIssue(
                r.Severity.ToString(), r.Message, r.CellNumber)).ToList();

            int errors = results.Count(r => r.Severity == DungeonDocument.ValidationSeverity.Error);
            int warnings = results.Count(r => r.Severity == DungeonDocument.ValidationSeverity.Warning);
            int infos = results.Count(r => r.Severity == DungeonDocument.ValidationSeverity.Info);

            return new DungeonValidateResult(true, lbKey, doc.Cells.Count,
                errors, warnings, infos, issues);
        } catch (Exception ex) {
            return new DungeonValidateResult(false, lbKey, 0, 0, 0, 0,
                new List<DungeonValidationIssue>(), ex.Message);
        }
    }

    public DungeonAutoFixResult DungeonAutoFix(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null || doc.Cells.Count == 0)
                return new DungeonAutoFixResult(false, lbKey, 0, "No dungeon data found");

            int fixes = doc.AutoFixPortals();
            return new DungeonAutoFixResult(true, lbKey, fixes);
        } catch (Exception ex) {
            return new DungeonAutoFixResult(false, lbKey, 0, ex.Message);
        }
    }

    public DungeonRecomputeResult DungeonRecompute(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null || doc.Cells.Count == 0)
                return new DungeonRecomputeResult(false, lbKey, 0, 0, "No dungeon data found");

            int visUpdated = doc.ComputeVisibleCells();
            var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
            int flagsUpdated = doc.RecomputePortalFlags(dats);

            return new DungeonRecomputeResult(true, lbKey, visUpdated, flagsUpdated);
        } catch (Exception ex) {
            return new DungeonRecomputeResult(false, lbKey, 0, 0, ex.Message);
        }
    }

    public DungeonReloadResult DungeonReload(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null)
                return new DungeonReloadResult(false, lbKey, 0, $"Could not load dungeon document for 0x{lbKey:X4}");

            var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
            doc.ReloadFromDat(dats);
            return new DungeonReloadResult(true, lbKey, doc.Cells.Count);
        } catch (Exception ex) {
            return new DungeonReloadResult(false, lbKey, 0, ex.Message);
        }
    }

    public DungeonCopyCellsResult DungeonCopyCells(uint srcLbX, uint srcLbY,
        uint destLbX, uint destLbY, ushort startCellNum = 0x0100) {
        RequireProject();
        ushort srcKey = LbKey(srcLbX, srcLbY);
        ushort destKey = LbKey(destLbX, destLbY);
        try {
            var srcDoc = GetDungeonDoc(srcKey);
            if (srcDoc == null || srcDoc.Cells.Count == 0)
                return new DungeonCopyCellsResult(false, srcKey, destKey, 0,
                    $"No dungeon data in source 0x{srcKey:X4}");

            var destDoc = GetDungeonDoc(destKey);
            if (destDoc == null)
                return new DungeonCopyCellsResult(false, srcKey, destKey, 0,
                    $"Could not load destination dungeon document for 0x{destKey:X4}");

            destDoc.CopyFrom(srcDoc, startCellNum);
            return new DungeonCopyCellsResult(true, srcKey, destKey, destDoc.Cells.Count);
        } catch (Exception ex) {
            return new DungeonCopyCellsResult(false, srcKey, destKey, 0, ex.Message);
        }
    }

    public DungeonMoveCellResult DungeonMoveCell(uint lbX, uint lbY, ushort cellNumber,
        float deltaX, float deltaY, float deltaZ) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null)
                return new DungeonMoveCellResult(false, lbKey, cellNumber, deltaX, deltaY, deltaZ,
                    $"Could not load dungeon document for 0x{lbKey:X4}");

            bool moved = doc.MoveCell(cellNumber, new Vector3(deltaX, deltaY, deltaZ));
            if (!moved)
                return new DungeonMoveCellResult(false, lbKey, cellNumber, deltaX, deltaY, deltaZ,
                    $"Cell 0x{cellNumber:X4} not found");

            return new DungeonMoveCellResult(true, lbKey, cellNumber, deltaX, deltaY, deltaZ);
        } catch (Exception ex) {
            return new DungeonMoveCellResult(false, lbKey, cellNumber, deltaX, deltaY, deltaZ, ex.Message);
        }
    }

    public DungeonRotateCellResult DungeonRotateCell(uint lbX, uint lbY, ushort cellNumber,
        float degrees, float axisX, float axisY, float axisZ) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null)
                return new DungeonRotateCellResult(false, lbKey, cellNumber, degrees, axisX, axisY, axisZ,
                    $"Could not load dungeon document for 0x{lbKey:X4}");

            bool rotated = doc.RotateCell(cellNumber, degrees, new Vector3(axisX, axisY, axisZ));
            if (!rotated)
                return new DungeonRotateCellResult(false, lbKey, cellNumber, degrees, axisX, axisY, axisZ,
                    $"Cell 0x{cellNumber:X4} not found or axis was zero");

            return new DungeonRotateCellResult(true, lbKey, cellNumber, degrees, axisX, axisY, axisZ);
        } catch (Exception ex) {
            return new DungeonRotateCellResult(false, lbKey, cellNumber, degrees, axisX, axisY, axisZ, ex.Message);
        }
    }

    public DungeonMoveObjectResult DungeonMoveObject(uint lbX, uint lbY, ushort cellNumber, int objectIndex,
        float deltaX, float deltaY, float deltaZ) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null)
                return new DungeonMoveObjectResult(false, lbKey, cellNumber, objectIndex, deltaX, deltaY, deltaZ,
                    $"Could not load dungeon document for 0x{lbKey:X4}");

            bool moved = doc.MoveStaticObject(cellNumber, objectIndex, new Vector3(deltaX, deltaY, deltaZ));
            if (!moved)
                return new DungeonMoveObjectResult(false, lbKey, cellNumber, objectIndex, deltaX, deltaY, deltaZ,
                    $"Cell 0x{cellNumber:X4} or object index {objectIndex} not found");

            return new DungeonMoveObjectResult(true, lbKey, cellNumber, objectIndex, deltaX, deltaY, deltaZ);
        } catch (Exception ex) {
            return new DungeonMoveObjectResult(false, lbKey, cellNumber, objectIndex, deltaX, deltaY, deltaZ, ex.Message);
        }
    }

    public DungeonRotateObjectResult DungeonRotateObject(uint lbX, uint lbY, ushort cellNumber, int objectIndex,
        float degrees) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null)
                return new DungeonRotateObjectResult(false, lbKey, cellNumber, objectIndex, degrees,
                    $"Could not load dungeon document for 0x{lbKey:X4}");

            bool rotated = doc.RotateStaticObject(cellNumber, objectIndex, degrees);
            if (!rotated)
                return new DungeonRotateObjectResult(false, lbKey, cellNumber, objectIndex, degrees,
                    $"Cell 0x{cellNumber:X4} or object index {objectIndex} not found");

            return new DungeonRotateObjectResult(true, lbKey, cellNumber, objectIndex, degrees);
        } catch (Exception ex) {
            return new DungeonRotateObjectResult(false, lbKey, cellNumber, objectIndex, degrees, ex.Message);
        }
    }

    public DungeonSetCellPositionResult DungeonSetCellPosition(uint lbX, uint lbY, ushort cellNumber,
        float x, float y, float z) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null)
                return new DungeonSetCellPositionResult(false, lbKey, cellNumber, x, y, z,
                    $"Could not load dungeon document for 0x{lbKey:X4}");

            bool updated = doc.SetCellPosition(cellNumber, new Vector3(x, y, z));
            if (!updated)
                return new DungeonSetCellPositionResult(false, lbKey, cellNumber, x, y, z,
                    $"Cell 0x{cellNumber:X4} not found");

            return new DungeonSetCellPositionResult(true, lbKey, cellNumber, x, y, z);
        } catch (Exception ex) {
            return new DungeonSetCellPositionResult(false, lbKey, cellNumber, x, y, z, ex.Message);
        }
    }

    public DungeonSetCellRotationResult DungeonSetCellRotation(uint lbX, uint lbY, ushort cellNumber,
        float rotX, float rotY, float rotZ) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null)
                return new DungeonSetCellRotationResult(false, lbKey, cellNumber, rotX, rotY, rotZ,
                    $"Could not load dungeon document for 0x{lbKey:X4}");

            bool updated = doc.SetCellRotationEuler(cellNumber, new Vector3(rotX, rotY, rotZ));
            if (!updated)
                return new DungeonSetCellRotationResult(false, lbKey, cellNumber, rotX, rotY, rotZ,
                    $"Cell 0x{cellNumber:X4} not found");

            return new DungeonSetCellRotationResult(true, lbKey, cellNumber, rotX, rotY, rotZ);
        } catch (Exception ex) {
            return new DungeonSetCellRotationResult(false, lbKey, cellNumber, rotX, rotY, rotZ, ex.Message);
        }
    }

    public DungeonSetObjectPositionResult DungeonSetObjectPosition(uint lbX, uint lbY, ushort cellNumber, int objectIndex,
        float x, float y, float z) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null)
                return new DungeonSetObjectPositionResult(false, lbKey, cellNumber, objectIndex, x, y, z,
                    $"Could not load dungeon document for 0x{lbKey:X4}");

            bool updated = doc.SetStaticObjectPosition(cellNumber, objectIndex, new Vector3(x, y, z));
            if (!updated)
                return new DungeonSetObjectPositionResult(false, lbKey, cellNumber, objectIndex, x, y, z,
                    $"Cell 0x{cellNumber:X4} or object index {objectIndex} not found");

            return new DungeonSetObjectPositionResult(true, lbKey, cellNumber, objectIndex, x, y, z);
        } catch (Exception ex) {
            return new DungeonSetObjectPositionResult(false, lbKey, cellNumber, objectIndex, x, y, z, ex.Message);
        }
    }

    public DungeonSetObjectRotationResult DungeonSetObjectRotation(uint lbX, uint lbY, ushort cellNumber, int objectIndex,
        float degrees) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        try {
            var doc = GetDungeonDoc(lbKey);
            if (doc == null)
                return new DungeonSetObjectRotationResult(false, lbKey, cellNumber, objectIndex, degrees,
                    $"Could not load dungeon document for 0x{lbKey:X4}");

            bool updated = doc.SetStaticObjectRotationDegrees(cellNumber, objectIndex, degrees);
            if (!updated)
                return new DungeonSetObjectRotationResult(false, lbKey, cellNumber, objectIndex, degrees,
                    $"Cell 0x{cellNumber:X4} or object index {objectIndex} not found");

            return new DungeonSetObjectRotationResult(true, lbKey, cellNumber, objectIndex, degrees);
        } catch (Exception ex) {
            return new DungeonSetObjectRotationResult(false, lbKey, cellNumber, objectIndex, degrees, ex.Message);
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Internal helpers
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public void RequireProject() {
        if (_projectManager.CurrentProject == null)
            throw new InvalidOperationException("No project loaded.");
    }

    public bool HasProject => _projectManager.CurrentProject != null;

    public void InvalidateCaches() {
        _terrainDocCache = null;
        _heightTableCache = null;
        // Drop the tile pipeline too: it bakes the project's atlas_tiles dir,
        // manifest, dirty set, and region anchors in at creation. Loading a
        // different project must rebuild it lazily against the new directory.
        _tileCache = null;
        _tileGenerator = null;
    }

    internal static ushort LbKey(uint lbX, uint lbY) {
        // Guard against out-of-range coords wrapping through the ushort cast
        // (lbX=256 -> row 0x00, lbY>255 bleeding into the X byte).
        if (lbX > 254) throw new ArgumentException($"lbX must be 0..254; got {lbX}");
        if (lbY > 254) throw new ArgumentException($"lbY must be 0..254; got {lbY}");
        return (ushort)((lbX << 8) | lbY);
    }

    private TerrainDocument GetTerrainDoc() {
        if (_terrainDocCache != null) return _terrainDocCache;
        var doc = _projectManager.CurrentProject!.DocumentManager
            .GetOrCreateDocumentAsync<TerrainDocument>("terrain")
            .GetAwaiter().GetResult();
        _terrainDocCache = doc ?? throw new InvalidOperationException("Could not load terrain document.");
        return _terrainDocCache;
    }

    public float[] GetHeightTable() {
        if (_heightTableCache != null) return _heightTableCache;
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        if (dats.TryGet<DatReaderWriter.DBObjs.Region>(0x13000000, out var region)) {
            _heightTableCache = region.LandDefs.LandHeightTable;
            _heightTableSynthetic = false;
        } else {
            // No Region 0x13000000 — fall back to a synthetic linear ramp. This is
            // NOT real region data; callers that need ground truth must check
            // HeightTableIsSynthetic.
            Console.Error.WriteLine("[GetHeightTable] WARNING: Region 0x13000000 absent — " +
                "using synthetic linear (i*2) height table; values are NOT retail.");
            _heightTableCache = new float[256];
            for (int i = 0; i < 256; i++) _heightTableCache[i] = i * 2f;
            _heightTableSynthetic = true;
        }
        return _heightTableCache;
    }

    /// <summary>True when the last <see cref="GetHeightTable"/> fell back to the
    /// synthetic i*2 ramp because Region 0x13000000 was absent.</summary>
    public bool HeightTableIsSynthetic { get { GetHeightTable(); return _heightTableSynthetic; } }

    /// <summary>
    /// Resolves a landblock's TerrainEntry[] via the terrain doc. Returns
    /// (lbKey, null) when the LB has no terrain data — query callers propagate
    /// that as Found=false to the JSON layer.
    /// </summary>
    private (ushort LbKey, TerrainEntry[]? Data) TryGetLandblockTerrain(uint lbX, uint lbY) {
        RequireProject();
        var lbKey = LbKey(lbX, lbY);
        return (lbKey, GetTerrainDoc().GetLandblockInternal(lbKey));
    }

    private (TerrainDocument doc,
             Func<ushort, TerrainEntry[]?> terrainLookup,
             Func<float, float, float> heightLookup) GetTerrainHelpers() {
        var doc = GetTerrainDoc();
        var ht = GetHeightTable();
        Func<ushort, TerrainEntry[]?> tl = lbId => doc.GetLandblockInternal(lbId);
        Func<float, float, float> hl = (wx, wy) =>
            _terrainService.GetHeightAtWorldPosition(wx, wy, tl, ht);
        return (doc, tl, hl);
    }

    private LandblockDocument GetLandblockDocOrCreate(ushort lbKey, IDatReaderWriter? overrideDats = null) {
        var docId = $"landblock_{lbKey:X4}";
        var docMgr = _projectManager.CurrentProject!.DocumentManager;
        var doc = overrideDats is null
            ? docMgr.GetOrCreateDocumentAsync<LandblockDocument>(docId).GetAwaiter().GetResult()
            : docMgr.GetOrCreateDocumentAsync<LandblockDocument>(docId, overrideDats).GetAwaiter().GetResult();
        return doc ?? throw new InvalidOperationException($"Could not load landblock 0x{lbKey:X4}.");
    }

    /// <summary>
    /// Read-only-shaped landblock-doc fetch. Returns false when the DAT has
    /// no <see cref="LandBlockInfo"/> for this key AND no doc has been
    /// explicitly created via add-object — so query/mutate ops don't lazy-create
    /// phantom docs. (clear-objects all=true additionally sweeps ActiveDocs to
    /// catch staged-only landblocks with no DAT LandBlockInfo record.)
    /// </summary>
    private bool TryGetLandblockDoc(ushort lbKey, out LandblockDocument? doc) {
        var docId = $"landblock_{lbKey:X4}";
        var docMgr = _projectManager.CurrentProject!.DocumentManager;
        if (docMgr.ActiveDocs.TryGetValue(docId, out var cached) && cached is LandblockDocument cachedLb) {
            doc = cachedLb;
            return true;
        }
        var dats = docMgr.Dats;
        uint infoId = (uint)(lbKey << 16) | 0xFFFE;
        if (!dats.TryGet<LandBlockInfo>(infoId, out _)) {
            doc = null;
            return false;
        }
        doc = GetLandblockDocOrCreate(lbKey);
        return true;
    }

    // Back-compat shim — sites we deliberately keep as lazy-create (sample-neighbor handlers
    // outside the read-only contract: render-preview, validate-all, transact, and the
    // WorldGen apply pipeline). Routes to the create-or-fetch path explicitly so callers
    // grepping for the old name are still wired up.
    // The optional <paramref name="overrideDats"/> is used by parallel pipelines (QuickWorld
    // Phase 3) that own per-thread DAT readers — it bypasses the shared-reader global lock.
    private LandblockDocument GetLandblockDoc(ushort lbKey, IDatReaderWriter? overrideDats = null) =>
        GetLandblockDocOrCreate(lbKey, overrideDats);

    private DungeonDocument? GetDungeonDoc(ushort lbKey) {
        var docId = $"dungeon_{lbKey:X4}";
        return _projectManager.CurrentProject!.DocumentManager
            .GetOrCreateDocumentAsync<DungeonDocument>(docId)
            .GetAwaiter().GetResult();
    }

    /// <summary>
    /// Read-only-shaped dungeon-doc fetch. Returns false (and never persists a
    /// phantom dungeon_XXXX doc) when no doc is cached, no doc is persisted, and
    /// the DAT has no dungeon cells (LandBlockInfo.NumCells == 0) for this key.
    /// Mirrors <see cref="TryGetLandblockDoc"/>.
    /// </summary>
    private bool TryGetDungeonDoc(ushort lbKey, out DungeonDocument? doc) {
        var docId = $"dungeon_{lbKey:X4}";
        var docMgr = _projectManager.CurrentProject!.DocumentManager;
        if (docMgr.ActiveDocs.TryGetValue(docId, out var cached) && cached is DungeonDocument cachedDun) {
            doc = cachedDun;
            return true;
        }
        // Persisted (previously generated) doc?
        var persisted = docMgr.DocumentStorageService.GetDocumentAsync(docId).GetAwaiter().GetResult();
        if (persisted != null) {
            doc = GetDungeonDoc(lbKey);
            return doc != null;
        }
        // DAT-resident dungeon cells?
        uint lbiId = ((uint)lbKey << 16) | 0xFFFE;
        if (docMgr.Dats.TryGet<LandBlockInfo>(lbiId, out var lbi) && lbi.NumCells > 0) {
            doc = GetDungeonDoc(lbKey);
            return doc != null;
        }
        doc = null;
        return false;
    }

    private static TerrainEditResult ApplyHeightEdit(TerrainDocument terrainDoc,
        List<(ushort LbId, int VertexIndex, byte Original, byte NewHeight)> changes) {
        if (changes.Count == 0) return new TerrainEditResult(0, new HashSet<ushort>());

        int estimatedLandblocks = Math.Min(changes.Count, 256);
        var batchChanges = new Dictionary<ushort, Dictionary<byte, uint>>(estimatedLandblocks);
        var terrainCache = new Dictionary<ushort, TerrainEntry[]?>(estimatedLandblocks);
        foreach (var (lbId, vIndex, _, newHeight) in changes) {
            if (!terrainCache.TryGetValue(lbId, out var data)) {
                data = terrainDoc.GetLandblockInternal(lbId);
                terrainCache[lbId] = data;
            }

            if (data == null) continue;
            if (!batchChanges.TryGetValue(lbId, out var lbChanges)) {
                lbChanges = new Dictionary<byte, uint>(16);
                batchChanges[lbId] = lbChanges;
            }
            lbChanges[(byte)vIndex] = (data[vIndex] with { Height = newHeight }).ToUInt();
        }

        terrainDoc.UpdateLandblocksBatchInternal(batchChanges, out var modifiedLbs);
        return new TerrainEditResult(changes.Count, modifiedLbs);
    }

    private static void ValidateLbLocalCoord(uint lbX, uint lbY, float x, float y, string command) {
        // Reject out-of-range landblock coords first, so a caller passing lbX/lbY>254
        // with "consistent" world coords can't pass validation and then wrap the LbKey.
        if (lbX > 254 || lbY > 254)
            throw new ArgumentException(
                $"{command}: landblock ({lbX}, {lbY}) is out of range — lbX/lbY must be 0..254.");
        float lbMinX = lbX * (float)WorldBuilder.Shared.Lib.Terrain.TerrainAlgorithms.LandblockLength;
        float lbMinY = lbY * (float)WorldBuilder.Shared.Lib.Terrain.TerrainAlgorithms.LandblockLength;
        float edge = (float)WorldBuilder.Shared.Lib.Terrain.TerrainAlgorithms.LandblockLength;
        if (x < lbMinX || x >= lbMinX + edge || y < lbMinY || y >= lbMinY + edge)
            throw new ArgumentException(
                $"{command}: ({x:F1}, {y:F1}) is outside landblock 0x{((lbX << 8) | lbY):X4} " +
                $"[{lbMinX:F0}..{lbMinX + edge:F0}, {lbMinY:F0}..{lbMinY + edge:F0}].");
    }

    private static void ValidateObjectIndex(LandblockDocument lbDoc, int index, string command) {
        var objects = lbDoc.GetStaticObjects();
        int count = objects switch {
            ICollection<StaticObject> c => c.Count,
            IReadOnlyCollection<StaticObject> c => c.Count,
            _ => objects.Count()
        };
        if (index < 0 || index >= count)
            throw new ArgumentException(
                $"Invalid index {index}. Landblock has {count} objects.");
    }

    // ═══════════════════════════════════════════════════════════
    //  WorldGen (slice 3 of f26345e port)
    // ═══════════════════════════════════════════════════════════

    /// <summary>
    /// Runs the WorldGenerator pipeline (terrain + biomes + towns + roads + buildings) and
    /// returns a summary. Does NOT mutate the project documents — results are dry-run only.
    /// Optionally writes the full <see cref="WorldGeneratorResult"/> to JSON for later inspection.
    /// </summary>
    public WorldGenResult WorldGenDryRun(WorldGeneratorParams p, string? outputJsonPath = null)
        => RunWorldGenInternal(p, applyChanges: false, outputJsonPath);

    /// <summary>
    /// Runs the WorldGenerator pipeline AND applies the result to project documents:
    ///   - <see cref="TerrainDocument.UpdateLandblocksBatchInternal"/> for vertex/road/scenery/type packed entries.
    ///   - <see cref="LandblockDocument.AddStaticObject"/> for planned buildings (per landblock).
    ///   - <see cref="LandblockDocument.AddStaticObject"/> for placed decorations (per landblock).
    /// Existing terrain entries at affected vertices are overwritten; existing static objects are preserved
    /// (buildings/decorations are appended). Save the project afterwards to persist.
    /// </summary>
    public WorldGenResult WorldGenApply(WorldGeneratorParams p, string? outputJsonPath = null)
        => RunWorldGenInternal(p, applyChanges: true, outputJsonPath);

    private WorldGenResult RunWorldGenInternal(WorldGeneratorParams p, bool applyChanges, string? outputJsonPath) {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        if (!dats.TryGet<DatReaderWriter.DBObjs.Region>(0x13000000, out var region) || region == null) {
            return new WorldGenResult(false, p.Seed, 0, 0, 0, 0, 0, 0,
                new List<TownSummary>(), Error: "Failed to load Region 0x13000000 from DATs.");
        }

        var result = WorldGenerator.Generate(p, dats, region);
        if (result == null) {
            return new WorldGenResult(false, p.Seed, 0, 0, 0, 0, 0, 0,
                new List<TownSummary>(), Error: "WorldGenerator.Generate returned null.");
        }

        bool applied = false;
        if (applyChanges) {
            try { ApplyWorldGenResult(result); applied = true; }
            catch (Exception ex) {
                return new WorldGenResult(false, p.Seed,
                    result.TerrainChanges.Count, result.TotalVerticesModified,
                    result.Towns.Count, result.TotalBuildingsPlaced,
                    result.TotalDecorationsPlaced, result.TotalRoadVertices,
                    BuildTownSummaries(result), Applied: false, Error: $"Apply failed: {ex.Message}");
            }
        }

        var towns = BuildTownSummaries(result);

        if (!string.IsNullOrEmpty(outputJsonPath)) {
            try {
                var dir = Path.GetDirectoryName(outputJsonPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                var serialized = System.Text.Json.JsonSerializer.Serialize(new {
                    seed = p.Seed,
                    applied = applyChanges,
                    bounds = new { p.StartX, p.StartY, p.Width, p.Height, p.FullWorld },
                    towns = result.Towns,
                    plannedBuildings = result.BuildingPlacements
                        .ToDictionary(kvp => $"0x{kvp.Key:X4}", kvp => kvp.Value),
                    decorationCounts = result.DecorationPlacements
                        .ToDictionary(kvp => $"0x{kvp.Key:X4}", kvp => kvp.Value.Count),
                    terrainLandblocksAffected = result.TerrainChanges.Count,
                    totalVerticesModified = result.TotalVerticesModified,
                    totalBuildingsPlaced = result.TotalBuildingsPlaced,
                    totalDecorationsPlaced = result.TotalDecorationsPlaced,
                    totalRoadVertices = result.TotalRoadVertices,
                    // WorldGenResult opts carry IncludeFields=true so Vector3/Quaternion fields
                    // (TownSite.WorldCenter, PlannedBuilding.WorldPosition/Orientation) survive the
                    // round-trip; JsonOpts.Indented would emit {} and lose every position.
                }, WorldBuilder.Shared.Lib.JsonOpts.WorldGenResult);
                File.WriteAllText(outputJsonPath, serialized);
            }
            catch (Exception ex) {
                // F240: when apply already mutated the project documents, the
                // generation+apply DID succeed — report success:true with a
                // warning so a naive retry doesn't double-append every static.
                if (applied) {
                    return new WorldGenResult(true, p.Seed,
                        result.TerrainChanges.Count, result.TotalVerticesModified,
                        result.Towns.Count, result.TotalBuildingsPlaced,
                        result.TotalDecorationsPlaced, result.TotalRoadVertices,
                        towns, outputJsonPath, Applied: applied,
                        Warnings: new[] { $"Applied OK, but JSON write failed: {ex.Message} — do not retry with apply:true (statics would be duplicated)" });
                }
                return new WorldGenResult(false, p.Seed,
                    result.TerrainChanges.Count, result.TotalVerticesModified,
                    result.Towns.Count, result.TotalBuildingsPlaced,
                    result.TotalDecorationsPlaced, result.TotalRoadVertices,
                    towns, Applied: applied, Error: $"Generated OK, but JSON write failed: {ex.Message}");
            }
        }

        return new WorldGenResult(true, p.Seed,
            result.TerrainChanges.Count, result.TotalVerticesModified,
            result.Towns.Count, result.TotalBuildingsPlaced,
            result.TotalDecorationsPlaced, result.TotalRoadVertices,
            towns, outputJsonPath, Applied: applied);
    }

    private static List<TownSummary> BuildTownSummaries(WorldGeneratorResult result) {
        var towns = new List<TownSummary>(result.Towns.Count);
        foreach (var t in result.Towns) {
            towns.Add(new TownSummary(t.Name, t.SizeLabel,
                t.CenterLbX, t.CenterLbY,
                t.WorldCenter.X, t.WorldCenter.Y, t.WorldCenter.Z,
                t.Radius, t.BuildingCount));
        }
        return towns;
    }

    /// <summary>
    /// Writes a generated <see cref="WorldGeneratorResult"/> through to the project's
    /// terrain + landblock documents. Buildings and decorations are <em>appended</em> to
    /// existing static-object lists; terrain vertices are overwritten in place.
    /// </summary>
    private void ApplyWorldGenResult(WorldGeneratorResult result) {
        // 1. Terrain (packed road/scenery/type/height per vertex). UpdateLandblocksBatchInternal
        //    handles edge sync between adjacent landblocks, so we can pass the dict whole.
        if (result.TerrainChanges.Count > 0) {
            var terrainDoc = GetTerrainDoc();
            terrainDoc.UpdateLandblocksBatchInternal(result.TerrainChanges, out _);
        }

        // 2. Buildings: planned model + world position + orientation, per landblock.
        foreach (var (lbKey, plans) in result.BuildingPlacements) {
            if (plans.Count == 0) continue;
            var lbDoc = GetLandblockDoc(lbKey);
            foreach (var pb in plans) {
                lbDoc.AddStaticObject(new StaticObject {
                    Id = pb.ModelId,
                    IsSetup = (pb.ModelId & 0x02000000) != 0,
                    Origin = pb.WorldPosition,
                    Orientation = pb.Orientation,
                    Scale = Vector3.One
                });
            }
        }

        // 3. Decorations: already StaticObject records; append as-is.
        foreach (var (lbKey, decs) in result.DecorationPlacements) {
            if (decs.Count == 0) continue;
            var lbDoc = GetLandblockDoc(lbKey);
            foreach (var d in decs) lbDoc.AddStaticObject(d);
        }
    }

    /// <summary>
    /// Scans the loaded project's DATs for "complete" building models — used by the WorldGen pipeline
    /// to pick what to place in towns. Read-only; clears the upstream cache first to force a fresh scan.
    /// </summary>
    public AnalyzeBuildingsResult WorldGenAnalyzeBuildings(string? outputJsonPath = null) {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        try {
            BuildingAnalyzer.ClearCache();
            var profiles = BuildingAnalyzer.AnalyzeAll(dats);
            int withInterior = 0, paired = 0;
            var summaries = new List<BuildingProfileSummary>(profiles.Count);
            foreach (var b in profiles) {
                if (b.HasInterior) withInterior++;
                if (b.IsPairedHalf) paired++;
                summaries.Add(new BuildingProfileSummary(
                    b.ModelId, $"0x{b.ModelId:X8}", b.NumLeaves,
                    b.CellCount, b.PortalCount, b.TotalStatics,
                    b.OccurrenceCount, b.UniqueLandblocks,
                    b.HasInterior, b.IsPairedHalf));
            }

            if (!string.IsNullOrEmpty(outputJsonPath)) {
                var dir = Path.GetDirectoryName(outputJsonPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(outputJsonPath, System.Text.Json.JsonSerializer.Serialize(
                    summaries, WorldBuilder.Shared.Lib.JsonOpts.Indented));
            }

            return new AnalyzeBuildingsResult(true, summaries.Count, withInterior, paired, summaries, outputJsonPath);
        }
        catch (Exception ex) {
            return new AnalyzeBuildingsResult(false, 0, 0, 0,
                new List<BuildingProfileSummary>(), Error: ex.Message);
        }
    }

    /// <summary>
    /// Scans the loaded project's DATs for retail-style town buildings. Pairs well with
    /// <see cref="WorldGenAnalyzeBuildings"/> when building a stricter town-building catalog.
    /// </summary>
    public ScanRetailTownsResult WorldGenScanRetailTowns(string? outputJsonPath = null) {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        try {
            var stats = RetailTownBuildingScanner.Scan(dats);
            var rows = new List<RetailTownStat>(stats.Count);
            foreach (var (modelId, s) in stats) {
                rows.Add(new RetailTownStat(modelId, $"0x{modelId:X8}",
                    s.TownLandblockHits, s.SingletonTownHits,
                    s.MaxCopiesInOneTownLb, s.SingletonRatio));
            }

            if (!string.IsNullOrEmpty(outputJsonPath)) {
                var dir = Path.GetDirectoryName(outputJsonPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(outputJsonPath, System.Text.Json.JsonSerializer.Serialize(
                    rows, WorldBuilder.Shared.Lib.JsonOpts.Indented));
            }

            return new ScanRetailTownsResult(true, rows.Count, rows, outputJsonPath);
        }
        catch (Exception ex) {
            return new ScanRetailTownsResult(false, 0, new List<RetailTownStat>(), Error: ex.Message);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  Weenie / ACE DB (slice 2 of f26345e port)
    // ═══════════════════════════════════════════════════════════

    /// <summary>
    /// Loads scalar weenie properties (and complex-table counts) from ACE DB. Read-only.
    /// </summary>
    public async Task<WeenieSnapshotResult> WeenieSnapshotAsync(uint classId) {
        var settings = _projectManager.CurrentProject?.AceDb;
        if (settings == null)
            return new WeenieSnapshotResult(false, classId,
                Error: "No ACE database settings configured. Use 'ace-db connect' first.");

        try {
            using var connector = new AceDbConnector(settings);
            var snap = await connector.LoadWeenieSnapshotAsync(classId);
            if (snap == null)
                return new WeenieSnapshotResult(false, classId, Error: $"Weenie {classId} not found.");

            string? name = null;
            foreach (var s in snap.Strings) {
                if (s.Type == 1) { name = s.Value; break; } // PropertyString.Name = 1
            }

            return new WeenieSnapshotResult(
                Success: true,
                ClassId: snap.ClassId,
                WeenieType: snap.WeenieType,
                Name: name,
                SetupDid: snap.SetupDid,
                IconDid: snap.IconDid,
                IntCount: snap.Ints.Count,
                Int64Count: snap.Int64s.Count,
                BoolCount: snap.Bools.Count,
                FloatCount: snap.Floats.Count,
                StringCount: snap.Strings.Count,
                DataIdCount: snap.DataIds.Count,
                InstanceIdCount: snap.InstanceIds.Count,
                SpellBookCount: snap.SpellBookCount,
                CreateListCount: snap.CreateListCount,
                EmoteCount: snap.EmoteCount,
                BookCount: snap.BookCount,
                PositionCount: snap.PositionCount,
                AttributeCount: snap.AttributeCount,
                Attribute2ndCount: snap.Attribute2ndCount,
                SkillCount: snap.SkillCount,
                LastModified: snap.LastModified,
                Snapshot: snap);
        }
        catch (Exception ex) {
            return new WeenieSnapshotResult(false, classId, Error: ex.Message);
        }
    }

    /// <summary>
    /// Parses a JSON template bundle and lists the templates inside.
    /// Bundle may be a single object or an array of templates.
    /// </summary>
    public WeenieTemplateListResult WeenieTemplateList(string bundlePath) {
        if (!File.Exists(bundlePath))
            return new WeenieTemplateListResult(false, bundlePath, 0, new List<WeenieTemplateInfo>(),
                $"Bundle file not found: {bundlePath}");
        try {
            var defs = WeenieTemplateJson.ParseBundle(File.ReadAllText(bundlePath), out var warnings);
            var infos = new List<WeenieTemplateInfo>(defs.Count);
            foreach (var d in defs) {
                infos.Add(new WeenieTemplateInfo(d.Id, d.Title, d.Description, d.WeenieType,
                    d.Ints.Count, d.Int64s.Count, d.Bools.Count, d.Floats.Count,
                    d.Strings.Count, d.DataIds.Count, d.InstanceIds.Count));
            }
            return new WeenieTemplateListResult(true, bundlePath, infos.Count, infos,
                Warnings: warnings.Count > 0 ? warnings : null);
        }
        catch (Exception ex) {
            return new WeenieTemplateListResult(false, bundlePath, 0, new List<WeenieTemplateInfo>(), ex.Message);
        }
    }

    /// <summary>
    /// MERGES a template's scalar properties into a weenie classId. The existing snapshot is loaded,
    /// the template's rows overlay it by (table, property-type) key (overwriting same-keyed rows,
    /// adding new ones), and the union is saved. Existing scalars NOT named in the template are left
    /// untouched. The weenie's existing <c>type</c> is preserved unless the template explicitly sets
    /// <c>weenieType</c>. (F234)
    /// </summary>
    public async Task<WeenieTemplateApplyResult> WeenieTemplateApplyAsync(string bundlePath, string templateId, uint classId) {
        var settings = _projectManager.CurrentProject?.AceDb;
        if (settings == null)
            return new WeenieTemplateApplyResult(false, bundlePath, templateId, classId, 0,
                "No ACE database settings configured. Use 'ace-db connect' first.");

        if (!File.Exists(bundlePath))
            return new WeenieTemplateApplyResult(false, bundlePath, templateId, classId, 0,
                $"Bundle file not found: {bundlePath}");

        WeenieTemplateDefinition? def;
        IReadOnlyList<string>? bundleWarnings = null;
        try {
            var defs = WeenieTemplateJson.ParseBundle(File.ReadAllText(bundlePath), out var warnings);
            bundleWarnings = warnings.Count > 0 ? warnings : null;
            def = null;
            foreach (var d in defs) {
                if (string.Equals(d.Id, templateId, StringComparison.OrdinalIgnoreCase)) {
                    def = d; break;
                }
            }
            if (def == null)
                return new WeenieTemplateApplyResult(false, bundlePath, templateId, classId, 0,
                    $"Template '{templateId}' not found in bundle.", Warnings: bundleWarnings);
        }
        catch (Exception ex) {
            return new WeenieTemplateApplyResult(false, bundlePath, templateId, classId, 0, ex.Message);
        }

        // Count of rows the template carries (the rows we'll write/overwrite).
        int scalarCount = def.Ints.Count + def.Int64s.Count + def.Bools.Count
            + def.Floats.Count + def.Strings.Count + def.DataIds.Count + def.InstanceIds.Count;

        try {
            using var connector = new AceDbConnector(settings);

            // F234: load the EXISTING snapshot so we merge instead of replacing. A null result here
            // means the weenie row is absent (LoadWeenieSnapshotAsync throws on DB failure, so null is
            // unambiguous); refuse rather than create a property-less weenie via SaveWeenieScalarsAsync.
            var snap = await connector.LoadWeenieSnapshotAsync(classId);
            if (snap == null)
                return new WeenieTemplateApplyResult(false, bundlePath, templateId, classId, scalarCount,
                    $"Weenie {classId} not found — cannot apply template to a non-existent weenie.");

            // Preserve the weenie's existing type unless the template explicitly set weenieType.
            uint originalType = snap.WeenieType;
            if (def.WeenieTypeExplicit)
                snap.WeenieType = def.WeenieType;
            bool typeChanged = snap.WeenieType != originalType;

            // Overlay each template row onto the existing list, keyed by property-type: replace a row
            // with the same type if present, otherwise add it. Existing rows not named by the template
            // survive untouched.
            foreach (var (t, v) in def.Ints)
                Overlay(snap.Ints, t, () => new AceWeenieRowInt { Type = t, Value = v }, r => r.Value = v);
            foreach (var (t, v) in def.Int64s)
                Overlay(snap.Int64s, t, () => new AceWeenieRowInt64 { Type = t, Value = v }, r => r.Value = v);
            foreach (var (t, v) in def.Bools)
                Overlay(snap.Bools, t, () => new AceWeenieRowBool { Type = t, Value = v }, r => r.Value = v);
            foreach (var (t, v) in def.Floats)
                Overlay(snap.Floats, t, () => new AceWeenieRowFloat { Type = t, Value = v }, r => r.Value = v);
            foreach (var (t, v) in def.Strings)
                Overlay(snap.Strings, t, () => new AceWeenieRowString { Type = t, Value = v }, r => r.Value = v);
            foreach (var (t, v) in def.DataIds)
                Overlay(snap.DataIds, t, () => new AceWeenieRowDid { Type = t, Value = v }, r => r.Value = v);
            foreach (var (t, v) in def.InstanceIds)
                Overlay(snap.InstanceIds, t, () => new AceWeenieRowIid { Type = t, Value = v }, r => r.Value = v);

            int totalAfter = snap.Ints.Count + snap.Int64s.Count + snap.Bools.Count
                + snap.Floats.Count + snap.Strings.Count + snap.DataIds.Count + snap.InstanceIds.Count;

            var ok = await connector.SaveWeenieScalarsAsync(snap);
            return new WeenieTemplateApplyResult(ok, bundlePath, templateId, classId, scalarCount,
                ok ? null : "SaveWeenieScalarsAsync returned false (weenie row vanished mid-apply).",
                Merged: true, TotalScalarsAfter: totalAfter, WeenieTypeChanged: ok && typeChanged,
                Warnings: bundleWarnings);
        }
        catch (Exception ex) {
            return new WeenieTemplateApplyResult(false, bundlePath, templateId, classId, scalarCount, ex.Message);
        }
    }

    /// <summary>Replaces the row matching <paramref name="type"/> in <paramref name="rows"/> (via
    /// <paramref name="update"/>), or appends a fresh one (via <paramref name="create"/>). (F234)</summary>
    static void Overlay<TRow>(List<TRow> rows, ushort type, Func<TRow> create, Action<TRow> update)
        where TRow : class {
        for (int i = 0; i < rows.Count; i++) {
            if (TypeOf(rows[i]) == type) { update(rows[i]); return; }
        }
        rows.Add(create());
    }

    /// <summary>Reads the <c>Type</c> property of any AceWeenieRow* via the shared shape. (F234)</summary>
    static ushort TypeOf(object row) => row switch {
        AceWeenieRowInt r => r.Type,
        AceWeenieRowInt64 r => r.Type,
        AceWeenieRowBool r => r.Type,
        AceWeenieRowFloat r => r.Type,
        AceWeenieRowString r => r.Type,
        AceWeenieRowDid r => r.Type,
        AceWeenieRowIid r => r.Type,
        _ => throw new ArgumentException($"Unsupported weenie row type {row.GetType().Name}", nameof(row)),
    };

    // ═══════════════════════════════════════════════════════════
    //  Mesh I/O & BSP (slice 1 of f26345e port)
    // ═══════════════════════════════════════════════════════════

    /// <summary>
    /// Writes a Setup (0x02xxxxxx) or GfxObj (0x01xxxxxx) to a Wavefront .obj file.
    /// Reads from project DATs (no mutation).
    /// </summary>
    public ObjExportResult ObjExport(uint datId, string outputPath) {
        RequireProject();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        bool isSetup = (datId >> 24) == 0x02;
        bool isGfxObj = (datId >> 24) == 0x01;
        string datType = isSetup ? "Setup" : isGfxObj ? "GfxObj" : "Unknown";
        string hexId = $"0x{datId:X8}";

        if (!isSetup && !isGfxObj)
            return new ObjExportResult(datId, hexId, datType, false, Error: "ID must be 0x01xxxxxx (GfxObj) or 0x02xxxxxx (Setup).");

        var dir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        if (isSetup) {
            if (!dats.TryGet<Setup>(datId, out var setup) || setup == null)
                return new ObjExportResult(datId, hexId, datType, false, Error: "Setup not found in DATs.");
        } else {
            if (!dats.TryGet<GfxObj>(datId, out _))
                return new ObjExportResult(datId, hexId, datType, false, Error: "GfxObj not found in DATs.");
        }

        try {
            using var w = new StreamWriter(outputPath);
            if (isSetup) {
                if (!WavefrontMeshExport.TryWriteSetup(dats, datId, w, out var error))
                    return new ObjExportResult(datId, hexId, datType, false, Error: error);
                if (!dats.TryGet<Setup>(datId, out var setup) || setup == null)
                    return new ObjExportResult(datId, hexId, datType, false, Error: "Setup vanished mid-export.");
                int parts = setup.Parts?.Count ?? 0;
                return new ObjExportResult(datId, hexId, datType, true, outputPath, parts);
            }
            else {
                if (!dats.TryGet<GfxObj>(datId, out var gfx) || gfx == null)
                    return new ObjExportResult(datId, hexId, datType, false, Error: "GfxObj not found in DATs.");
                WavefrontMeshExport.WriteGfxObj(gfx, datId, w);
                return new ObjExportResult(datId, hexId, datType, true, outputPath, 1, gfx.Polygons?.Count ?? 0);
            }
        }
        catch (Exception ex) {
            return new ObjExportResult(datId, hexId, datType, false, Error: ex.Message);
        }
    }

    /// <summary>
    /// Reads a Wavefront .obj and stores the resulting GfxObj+Setup in <see cref="PortalDatDocument"/>.
    /// They get persisted on the next project export. If <paramref name="gfxObjId"/> or
    /// <paramref name="setupId"/> is 0 the engine allocates a free ID in the 0x01FF.. / 0x02FF.. custom range.
    /// </summary>
    public ObjImportResult ObjImport(string objPath, uint surfaceDid, uint gfxObjId = 0, uint setupId = 0,
            bool overwrite = false) {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        var dats = project.DocumentManager.Dats;

        if (!File.Exists(objPath))
            return new ObjImportResult(false, 0, 0, 0, 0, $"OBJ file not found: {objPath}");

        // Validate surfaceDid resolves to a Surface (0x08 prefix) in the loaded DAT —
        // a typo'd id otherwise yields an invisible mesh referencing nothing.
        if (!dats.TryGet<DatReaderWriter.DBObjs.Surface>(surfaceDid, out _))
            return new ObjImportResult(false, gfxObjId, setupId, 0, 0,
                $"surfaceDid 0x{surfaceDid:X8} does not resolve to a Surface in the loaded DAT.");

        // Enforce the DID type-byte namespace for caller-supplied ids.
        if (gfxObjId != 0 && (gfxObjId >> 24) != 0x01)
            return new ObjImportResult(false, gfxObjId, setupId, 0, 0,
                $"gfxObjId 0x{gfxObjId:X8} must be in the GfxObj namespace (0x01xxxxxx).");
        if (setupId != 0 && (setupId >> 24) != 0x02)
            return new ObjImportResult(false, gfxObjId, setupId, 0, 0,
                $"setupId 0x{setupId:X8} must be in the Setup namespace (0x02xxxxxx).");

        var portalDoc = project.DocumentManager
            .GetOrCreateDocumentAsync<PortalDatDocument>(PortalDatDocument.DocumentId)
            .GetAwaiter().GetResult()
            ?? throw new InvalidOperationException("Could not load portal-dat document.");

        // Allocate IDs in the custom 0xXXFFxxxx range when not specified, considering both
        // existing portal entries and prior-imported entries we've stashed in PortalDatDocument.
        if (gfxObjId == 0) {
            var existing = CollectExistingIds<GfxObj>(dats, portalDoc, 0x01000000);
            gfxObjId = ObjSingleMeshImporter.AllocateNextId(0x01000000, existing);
        }
        if (setupId == 0) {
            var existing = CollectExistingIds<Setup>(dats, portalDoc, 0x02000000);
            setupId = ObjSingleMeshImporter.AllocateNextId(0x02000000, existing);
        }

        string objText;
        try { objText = File.ReadAllText(objPath); }
        catch (Exception ex) { return new ObjImportResult(false, 0, 0, 0, 0, ex.Message); }

        if (!ObjSingleMeshImporter.TryBuild(objText, surfaceDid, gfxObjId, setupId,
                out var gfx, out var setup, out var error) || gfx == null || setup == null) {
            return new ObjImportResult(false, gfxObjId, setupId, 0, 0, error ?? "OBJ build failed.");
        }

        // Refuse to silently overwrite an existing record (DAT-resident or already
        // staged in the portal document) unless the caller opted in.
        if (!overwrite) {
            if (dats.TryGet<GfxObj>(gfxObjId, out _) || portalDoc.HasEntry(gfxObjId))
                return new ObjImportResult(false, gfxObjId, setupId, 0, 0,
                    $"gfxObjId 0x{gfxObjId:X8} already exists; pass overwrite:true to replace it.");
            if (dats.TryGet<Setup>(setupId, out _) || portalDoc.HasEntry(setupId))
                return new ObjImportResult(false, gfxObjId, setupId, 0, 0,
                    $"setupId 0x{setupId:X8} already exists; pass overwrite:true to replace it.");
        }

        // ObjSingleMeshImporter.BuildGfxObj already built the BSP (physics +
        // drawing trees); no second build here.

        portalDoc.SetEntry(gfxObjId, gfx);
        portalDoc.SetEntry(setupId, setup);

        int triCount = gfx.Polygons?.Count ?? 0;
        int vtxCount = gfx.VertexArray?.Vertices?.Count ?? 0;
        return new ObjImportResult(true, gfxObjId, setupId, triCount, vtxCount);
    }

    /// <summary>
    /// Rebuilds Physics+Drawing BSP trees on a GfxObj (project portal override or DAT-resident).
    /// The result is stored in <see cref="PortalDatDocument"/> so the next export persists it.
    /// </summary>
    public BspBuildResult BspBuild(uint gfxObjId) {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        string hexId = $"0x{gfxObjId:X8}";

        if ((gfxObjId >> 24) != 0x01)
            return new BspBuildResult(gfxObjId, hexId, false, false, Error: "ID must be 0x01xxxxxx (GfxObj).");

        var portalDoc = project.DocumentManager
            .GetOrCreateDocumentAsync<PortalDatDocument>(PortalDatDocument.DocumentId)
            .GetAwaiter().GetResult()
            ?? throw new InvalidOperationException("Could not load portal-dat document.");

        // Project override wins; otherwise read from DATs.
        GfxObj? gfx = null;
        if (portalDoc.TryGetEntry<GfxObj>(gfxObjId, out var pendingGfx) && pendingGfx != null) {
            gfx = pendingGfx;
        }
        else if (project.DocumentManager.Dats.TryGet<GfxObj>(gfxObjId, out var datGfx) && datGfx != null) {
            gfx = datGfx;
        }

        if (gfx == null)
            return new BspBuildResult(gfxObjId, hexId, false, false, Error: "GfxObj not found.");

        int polyCount = gfx.Polygons?.Count ?? 0;
        if (polyCount == 0 || gfx.VertexArray?.Vertices == null || gfx.VertexArray.Vertices.Count == 0)
            return new BspBuildResult(gfxObjId, hexId, true, false, polyCount,
                $"GfxObj {hexId} has no polygons/vertices to build a BSP from.");

        try {
            BspGenerator.Build(gfx);
        }
        catch (Exception ex) {
            return new BspBuildResult(gfxObjId, hexId, true, false, gfx.Polygons?.Count ?? 0, ex.Message);
        }

        if (gfx.PhysicsBSP == null && gfx.DrawingBSP == null)
            return new BspBuildResult(gfxObjId, hexId, true, false, gfx.Polygons?.Count ?? 0,
                $"GfxObj {hexId} produced no BSP (all polygon planes degenerate); not staged.");

        portalDoc.SetEntry(gfxObjId, gfx);
        return new BspBuildResult(gfxObjId, hexId, true, true, gfx.Polygons?.Count ?? 0);
    }

    // ═══════════════════════════════════════════════════════════
    //  compare-to-retail: subprocesses the Python comparator so the
    //  train → place → score → tune loop can run hot inside one process.
    //  We subprocess (rather than re-implement in C#) for two reasons:
    //  (1) the retail JSONL parser doesn't exist in the terminal — only
    //  generated DATs are loaded; (2) re-implementation risks silent
    //  numeric drift from prior offline runs. Caching the region-filtered
    //  retail snapshot inside the Python script keeps tight loops fast.
    // ═══════════════════════════════════════════════════════════

    private string? _compareRetailDefaultBaseline;
    private string? _compareCacheDir;

    public CompareToRetailResult CompareToRetail(
        string generated,
        string? retailBaseline = null,
        int topK = 30,
        int anomalyMinModel = 20,
        bool perLandblock = true,
        string? cacheDirOverride = null) {

        var sw = System.Diagnostics.Stopwatch.StartNew();
        if (string.IsNullOrWhiteSpace(generated))
            return new CompareToRetailResult(false, generated ?? "", retailBaseline ?? "",
                Error: "Missing generated JSONL path");
        if (!File.Exists(generated))
            return new CompareToRetailResult(false, generated, retailBaseline ?? "",
                Error: $"Generated JSONL not found: {generated}");

        var retailPath = retailBaseline
            ?? _compareRetailDefaultBaseline
            ?? ResolveDefaultRetailBaseline();
        if (retailPath == null)
            return new CompareToRetailResult(false, generated, "",
                Error: "Retail baseline not specified and default not found "
                     + "(pipeline_data/reference/raw_world_facts_full_with_components_v2.jsonl). "
                     + "Pass 'retailBaseline'.");
        if (!File.Exists(retailPath))
            return new CompareToRetailResult(false, generated, retailPath,
                Error: $"Retail baseline not found: {retailPath}");
        // Persist the resolved retail path for subsequent calls in this session.
        _compareRetailDefaultBaseline = retailPath;

        var scriptPath = ResolveCompareScript();
        if (scriptPath == null)
            return new CompareToRetailResult(false, generated, retailPath,
                Error: "compare_world_to_retail.py not found. "
                     + "Set WORLDBUILDER_COMPARATOR_PY or run from a worldbuilder checkout.");

        var cacheDir = cacheDirOverride
            ?? _compareCacheDir
            ?? Path.Combine(Path.GetTempPath(), "wb_compare_cache");
        _compareCacheDir = cacheDir;
        try { Directory.CreateDirectory(cacheDir); } catch { /* fall through; cache is best-effort */ }

        var args = new List<string> {
            scriptPath,
            "--generated", generated,
            "--retail", retailPath,
            "--top-k", topK.ToString(CultureInfo.InvariantCulture),
            "--anomaly-min-model", anomalyMinModel.ToString(CultureInfo.InvariantCulture),
            "--retail-cache-dir", cacheDir,
            "--stdout-json",
            "--no-md",
            // Skip the side-effect disk write — we already consume stdout JSON,
            // so a hot tuning loop shouldn't pay extra disk I/O per iteration.
            "--no-out-json",
            "--quiet",
        };
        if (!perLandblock) args.Add("--no-per-lb");

        string stdoutText;
        string stderrText;
        int exitCode;
        bool timedOut;
        try {
            (stdoutText, stderrText, exitCode, timedOut) = RunPython(args, CompareTimeout);
        } catch (Exception ex) {
            return new CompareToRetailResult(false, generated, retailPath,
                Error: $"Failed to launch python: {ex.Message}");
        }
        if (timedOut) {
            return new CompareToRetailResult(false, generated, retailPath,
                Error: $"compare_world_to_retail.py exceeded {CompareTimeout.TotalMinutes:F0}-minute timeout and was killed.");
        }
        if (exitCode != 0) {
            return new CompareToRetailResult(false, generated, retailPath,
                Error: $"compare_world_to_retail.py exited {exitCode}: "
                     + (string.IsNullOrWhiteSpace(stderrText) ? stdoutText : stderrText).Trim());
        }
        if (string.IsNullOrWhiteSpace(stdoutText)) {
            return new CompareToRetailResult(false, generated, retailPath,
                Error: "compare_world_to_retail.py produced no stdout JSON");
        }

        CompareToRetailResult parsed;
        try {
            parsed = ParseCompareReport(stdoutText, generated, retailPath);
        } catch (Exception ex) {
            return new CompareToRetailResult(false, generated, retailPath,
                Error: $"Failed to parse comparator JSON: {ex.Message}");
        }

        return parsed with {
            ElapsedSeconds = Math.Round(sw.Elapsed.TotalSeconds, 3),
        };
    }

    // 10-minute timeout for the comparator. Real runs land in seconds even
    // for full-world regions; this is a runaway guard, not a budget.
    private static readonly TimeSpan CompareTimeout = TimeSpan.FromMinutes(10);

    /// <summary>
    /// Locates compare_world_to_retail.py. Resolution order:
    ///   1. WORLDBUILDER_COMPARATOR_PY env var
    ///   2. Walk up from the current directory looking for scripts/PopulationPipeline/Validation/
    ///   3. Walk up from the assembly location
    /// </summary>
    private static string? ResolveCompareScript() {
        var envPath = System.Environment.GetEnvironmentVariable("WORLDBUILDER_COMPARATOR_PY");
        if (!string.IsNullOrEmpty(envPath) && File.Exists(envPath)) return envPath;

        const string rel = "scripts/PopulationPipeline/Validation/compare_world_to_retail.py";
        foreach (var anchor in new[] { System.Environment.CurrentDirectory, AppContext.BaseDirectory }) {
            string? dir = anchor;
            for (int i = 0; i < 8 && dir != null; i++) {
                var candidate = Path.Combine(dir, rel);
                if (File.Exists(candidate)) return candidate;
                dir = Path.GetDirectoryName(dir);
            }
        }
        return null;
    }

    private static string? ResolveDefaultRetailBaseline() {
        const string rel = "pipeline_data/reference/raw_world_facts_full_with_components_v2.jsonl";
        foreach (var anchor in new[] { System.Environment.CurrentDirectory, AppContext.BaseDirectory }) {
            string? dir = anchor;
            for (int i = 0; i < 8 && dir != null; i++) {
                var candidate = Path.Combine(dir, rel);
                if (File.Exists(candidate)) return candidate;
                dir = Path.GetDirectoryName(dir);
            }
        }
        return null;
    }

    private static (string Stdout, string Stderr, int ExitCode, bool TimedOut) RunPython(
            IEnumerable<string> args, TimeSpan timeout) {
        var pythonExe = System.Environment.GetEnvironmentVariable("WORLDBUILDER_PYTHON")
            ?? (OperatingSystem.IsWindows() ? "python" : "python3");
        var psi = new System.Diagnostics.ProcessStartInfo(pythonExe) {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var proc = System.Diagnostics.Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start python process");

        // Read both streams concurrently to avoid deadlock when the child
        // fills one pipe while we're blocked reading the other.
        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();
        bool exited = proc.WaitForExit((int)timeout.TotalMilliseconds);
        if (!exited) {
            try { proc.Kill(entireProcessTree: true); } catch { /* best effort */ }
            // Drain pipes after kill so the tasks complete and don't leak.
            try { proc.WaitForExit(2000); } catch { /* best effort */ }
            string outSoFar = ""; string errSoFar = "";
            try { outSoFar = stdoutTask.Result; } catch { /* swallow */ }
            try { errSoFar = stderrTask.Result; } catch { /* swallow */ }
            return (outSoFar, errSoFar, -1, true);
        }
        return (stdoutTask.Result, stderrTask.Result, proc.ExitCode, false);
    }

    private static CompareToRetailResult ParseCompareReport(
        string stdoutJson, string generated, string retail) {
        // Run with --quiet --stdout-json, so stdout is a single JSON object on
        // a single line. No need to extract — just trim and parse.
        using var doc = System.Text.Json.JsonDocument.Parse(stdoutJson.Trim());
        var root = doc.RootElement;

        var region = root.TryGetProperty("region", out var regionEl)
            ? new CompareRegionBbox(
                regionEl.GetProperty("n_landblocks").GetInt32(),
                regionEl.GetProperty("x_min").GetInt32(),
                regionEl.GetProperty("x_max").GetInt32(),
                regionEl.GetProperty("y_min").GetInt32(),
                regionEl.GetProperty("y_max").GetInt32())
            : null;

        var volumes = root.GetProperty("volumes");
        int generatedCount = volumes.GetProperty("generated").GetInt32();
        int retailCount = volumes.GetProperty("retail").GetInt32();
        double densityDeltaPct = volumes.GetProperty("density_delta_pct").GetDouble();

        var density = root.GetProperty("density");
        var modelDensity = ParseDensity(density.GetProperty("model"));
        var retailDensity = ParseDensity(density.GetProperty("retail"));

        var coverageEl = root.GetProperty("coverage");
        var coverage = new CompareCoverage(
            coverageEl.GetProperty("model_unique").GetInt32(),
            coverageEl.GetProperty("retail_unique").GetInt32(),
            coverageEl.GetProperty("both").GetInt32(),
            coverageEl.GetProperty("novel").GetInt32(),
            coverageEl.GetProperty("missing").GetInt32());

        var siEl = root.GetProperty("surface_interior");
        var si = new CompareSurfaceInterior(
            siEl.GetProperty("model_surface").GetInt32(),
            siEl.GetProperty("model_interior").GetInt32(),
            siEl.GetProperty("model_surface_pct").GetDouble(),
            siEl.GetProperty("model_interior_pct").GetDouble(),
            siEl.GetProperty("retail_surface").GetInt32(),
            siEl.GetProperty("retail_interior").GetInt32(),
            siEl.GetProperty("retail_surface_pct").GetDouble(),
            siEl.GetProperty("retail_interior_pct").GetDouble());

        var jaccEl = root.GetProperty("lb_jaccard");
        var jaccard = new CompareLbJaccard(
            jaccEl.GetProperty("n").GetInt32(),
            ReadNullableDouble(jaccEl, "mean"),
            ReadNullableDouble(jaccEl, "p50"),
            ReadNullableDouble(jaccEl, "p10"));

        var anomEl = root.GetProperty("anomalies");
        var anomalies = new CompareAnomalySummary(
            anomEl.GetProperty("frac").GetDouble(),
            anomEl.GetProperty("novel_unique").GetInt32(),
            anomEl.GetProperty("emitted_unique").GetInt32());

        CompareClassSpace? classSpace = null;
        if (root.TryGetProperty("class_space", out var csEl)) {
            classSpace = new CompareClassSpace(
                ParseStringIntDict(csEl.GetProperty("retail")),
                csEl.GetProperty("retailTotal").GetInt32(),
                ParseStringDoubleDict(csEl.GetProperty("retailFractions")),
                ParseStringIntDict(csEl.GetProperty("modelEmitted")),
                csEl.GetProperty("modelTotal").GetInt32(),
                ReadNullableDouble(csEl, "coverageOfRetailWcid"),
                csEl.GetProperty("coverageOfRetailAll").GetDouble());
        }

        var wcidsEl = root.GetProperty("wcids");
        var wcids = new CompareWcidAnomalies(
            ParseWcidRows(wcidsEl.GetProperty("over")),
            ParseWcidRows(wcidsEl.GetProperty("under")),
            ParseWcidSimpleRows(wcidsEl.GetProperty("novel")),
            ParseWcidSimpleRows(wcidsEl.GetProperty("missing")));

        List<ComparePerLbRow>? perLb = null;
        if (root.TryGetProperty("per_landblock", out var perLbEl)) {
            perLb = new List<ComparePerLbRow>(perLbEl.GetArrayLength());
            foreach (var r in perLbEl.EnumerateArray()) {
                perLb.Add(new ComparePerLbRow(
                    r.GetProperty("lbX").GetInt32(),
                    r.GetProperty("lbY").GetInt32(),
                    r.GetProperty("modelCount").GetInt32(),
                    r.GetProperty("retailCount").GetInt32(),
                    r.GetProperty("densityDelta").GetInt32(),
                    r.GetProperty("modelWcidUnique").GetInt32(),
                    r.GetProperty("retailWcidUnique").GetInt32(),
                    ReadNullableDouble(r, "wcidJaccard"),
                    r.GetProperty("novelInLb").GetInt32(),
                    r.GetProperty("missingInLb").GetInt32()));
            }
        }

        // The Python comparator reports its cache state authoritatively in the
        // JSON. Older cache-by-file-count heuristics in the C# wrapper would
        // false-positive when a snapshot store silently failed; trusting the
        // script's own bookkeeping is the only reliable signal.
        bool retailCacheHit = false;
        if (root.TryGetProperty("cache", out var cacheEl)
                && cacheEl.ValueKind == System.Text.Json.JsonValueKind.Object
                && cacheEl.TryGetProperty("retail_hit", out var hitEl)
                && hitEl.ValueKind is System.Text.Json.JsonValueKind.True
                                  or System.Text.Json.JsonValueKind.False) {
            retailCacheHit = hitEl.GetBoolean();
        }

        // The C# wrapper passes --no-out-json, so the script no longer writes
        // <generated>.comparison.json on the hot path. Leave OutJsonPath null
        // unless we wired the disk write back on (e.g., manual offline runs go
        // through the script directly, not through this engine).
        return new CompareToRetailResult(
            Success: true,
            Generated: generated,
            Retail: retail,
            Region: region,
            GeneratedCount: generatedCount,
            RetailCount: retailCount,
            DensityDeltaPct: densityDeltaPct,
            ModelDensity: modelDensity,
            RetailDensity: retailDensity,
            Coverage: coverage,
            SurfaceInterior: si,
            LbJaccard: jaccard,
            Anomalies: anomalies,
            ClassSpace: classSpace,
            Wcids: wcids,
            PerLandblock: perLb,
            OutJsonPath: null,
            RetailCacheHit: retailCacheHit);
    }

    private static CompareDensityStats ParseDensity(System.Text.Json.JsonElement el) =>
        new(el.GetProperty("n").GetInt32(),
            el.GetProperty("min").GetInt32(),
            el.GetProperty("p50").GetInt32(),
            el.GetProperty("mean").GetDouble(),
            el.GetProperty("p95").GetInt32(),
            el.GetProperty("max").GetInt32(),
            el.GetProperty("total").GetInt32());

    private static double? ReadNullableDouble(System.Text.Json.JsonElement el, string name) {
        if (!el.TryGetProperty(name, out var v)) return null;
        return v.ValueKind == System.Text.Json.JsonValueKind.Null ? null : v.GetDouble();
    }

    private static Dictionary<string, int> ParseStringIntDict(System.Text.Json.JsonElement el) {
        var d = new Dictionary<string, int>();
        foreach (var p in el.EnumerateObject()) d[p.Name] = p.Value.GetInt32();
        return d;
    }

    private static Dictionary<string, double> ParseStringDoubleDict(System.Text.Json.JsonElement el) {
        var d = new Dictionary<string, double>();
        foreach (var p in el.EnumerateObject()) d[p.Name] = p.Value.GetDouble();
        return d;
    }

    private static List<CompareWcidRow> ParseWcidRows(System.Text.Json.JsonElement arr) {
        var rows = new List<CompareWcidRow>(arr.GetArrayLength());
        foreach (var r in arr.EnumerateArray()) {
            rows.Add(new CompareWcidRow(
                r[0].GetInt32(), r[1].GetInt32(), r[2].GetInt32(), r[3].GetDouble()));
        }
        return rows;
    }

    private static List<CompareWcidSimpleRow> ParseWcidSimpleRows(System.Text.Json.JsonElement arr) {
        var rows = new List<CompareWcidSimpleRow>(arr.GetArrayLength());
        foreach (var r in arr.EnumerateArray()) {
            rows.Add(new CompareWcidSimpleRow(r[0].GetInt32(), r[1].GetInt32()));
        }
        return rows;
    }

    /// <summary>Collects already-allocated IDs in <paramref name="rangeBase"/>'s 0xXXFFxxxx custom band — both DAT-resident and project-overridden.</summary>
    private static IEnumerable<uint> CollectExistingIds<T>(IDatReaderWriter dats, PortalDatDocument portalDoc, uint rangeBase)
        where T : DatReaderWriter.Lib.IO.IDBObj, new() {
        uint customBase = rangeBase | 0x00FF0000;
        uint customEnd = rangeBase | 0x00FFFFFF;
        // Pending project entries first (cheap).
        foreach (var id in portalDoc.GetEntryIds())
            if ((id & 0xFF000000) == rangeBase && id >= customBase && id <= customEnd)
                yield return id;
        // DAT-resident IDs in the custom range — DatReaderWriter doesn't expose enumeration here,
        // so we let AllocateNextId start from customBase if nothing is found. Prior imports persisted
        // to disk get rediscovered when the project reopens (they live in PortalDatDocument again).
    }

    // ═══════════════════════════════════════════════════════════════════
    //  DerethMapsEnhanced: Phase 1 extraction commands.
    //  Produce per-cell footprint cache and per-model sprite cache used
    //  later by render-dungeon, emit-tile-pyramid, and emit-static-site.
    // ═══════════════════════════════════════════════════════════════════

    public record CellFootprintsResult(
        int CellsExtracted,
        int Synthetic,
        int DungeonsScanned,
        string CachePath);

    public record ObjectSpritesResult(
        int ModelsCollected,
        int ModelsRendered,
        int ModelsFailed,
        int AtlasWidth,
        int AtlasHeight,
        string SpritesDir,
        string AtlasPath,
        string ManifestPath,
        bool Cached = false,
        long? AtlasMtimeUnix = null);

    public record DungeonRenderResult(
        ushort LbKey,
        int FloorIndexRendered,        // -1 = all
        int FloorCount,
        int CellsRendered,
        float FloorZMin,
        float FloorZMax,
        byte[] PngBytes,
        string? OutputPath);

    public record TilePyramidResult(
        int MaxZoom,
        int MinZoom,
        int LbsProcessed,
        int ExteriorTilesAtMaxZoom,
        int ObjectTilesAtMaxZoom,
        int FloorTilesWritten,
        int DownsampledTiles,
        string OutDir,
        int FailedLandblocks = 0,
        List<(ushort lbKey, string message)>? FirstFailures = null,
        bool DirtyTrackingInitialized = true,
        int DirtyTilesRemaining = 0);

    // Sprite-atlas cache keyed by LOD level. Each project pins one entry
    // per LOD so the per-zoom selector in TilePyramidEmitter can switch
    // between LOD-0 (deep zoom, full detail) and LOD-2 (low zoom, low
    // detail) without rebuilding the loader on each tile.
    private readonly Dictionary<int, SpriteAtlasLoader> _spriteAtlasByLod = new();
    private string? _spriteAtlasDir;

    /// <summary>
    /// Load the project's sprite atlas for the requested LOD. Falls back
    /// to the bare LOD-0 atlas (atlas.png + manifest.jsonl) when the
    /// requested LOD-N pair isn't on disk so callers can blindly request
    /// the LOD their zoom prefers without first checking the file system.
    /// </summary>
    private SpriteAtlasLoader? GetOrLoadSpriteAtlas(int lodLevel = 0) {
        var p = _projectManager.CurrentProject!;
        var dir = Path.Combine(p.ProjectDirectory, "sprites");
        // Project switch invalidates every cached LOD — clean them up first.
        if (_spriteAtlasDir != null
                && !string.Equals(_spriteAtlasDir, dir, StringComparison.Ordinal)) {
            foreach (var l in _spriteAtlasByLod.Values) l.Dispose();
            _spriteAtlasByLod.Clear();
        }
        _spriteAtlasDir = dir;
        if (_spriteAtlasByLod.TryGetValue(lodLevel, out var hit)) return hit;
        var loader = SpriteAtlasLoader.TryLoad(dir, lodLevel);
        if (loader == null && lodLevel > 0) {
            // Fall back to LOD-0 when the requested LOD pair is missing —
            // a partial sprite-gen run shouldn't break the renderer.
            loader = SpriteAtlasLoader.TryLoad(dir, 0);
        }
        if (loader != null) _spriteAtlasByLod[lodLevel] = loader;
        return loader;
    }

    // wcid → setupId fallback index, lazily built from the ontology's
    // WeenieClassId field. Slated for removal one cycle after the
    // WeenieIndex migration lands (Step 6 — see weenie_index.md). The
    // canonical wcid → identity map now lives in WeenieIndex; this map
    // covers a small remainder where a wcid appears in DAT data (spell
    // tables, building blueprints) without an ACE-DB row, and is a
    // safety net for projects that haven't ingested WeenieIndex yet.
    //
    // Removal blocker: confirm via spawnSpriteCoverage that the WeenieIndex
    // hits exclusively across one full release cycle. Once the fallback
    // contributes 0 hits in steady state, delete this field, the lazy
    // build inside GetWcidToSetupResolver, and the writes to
    // OntologyEntry.WeenieClassId in OntologyService.
    private Dictionary<int, uint>? _wcidToSetup;

    private Func<int, uint>? GetWcidToSetupResolver() {
        if (_wcidToSetup == null) {
            var map = new Dictionary<int, uint>();
            foreach (var e in _ontologyService.GetAllEntries()) {
                if (e.WeenieClassId is int wcid && wcid > 0 && e.ObjectId != 0) {
                    // First entry per wcid wins. Multiple entries per wcid
                    // are possible (cultural variants); the first one we
                    // see is good enough — render quality differences
                    // between variants are below the visual threshold of
                    // the static-site tile renderer.
                    map.TryAdd(wcid, e.ObjectId);
                }
            }
            _wcidToSetup = map;
        }
        var ontIdx = _wcidToSetup;
        var weenieIdx = _weenieIndex;
        if (ontIdx.Count == 0 && weenieIdx.Count == 0) return null;
        return (int wcid) => {
            // WeenieIndex is canonical (ACE DB), consult first.
            if (weenieIdx.TryGetSetup(wcid, out var setup)) return setup;
            // Ontology fallback (DAT-derived, partial coverage).
            return ontIdx.TryGetValue(wcid, out var id) ? id : 0u;
        };
    }

    /// <summary>
    /// Variant-aware sprite-key resolver: builds a SpriteKey including
    /// ClothingBase + PaletteTemplate when the WeenieIndex carries those
    /// fields. Bare-setup callers can keep using GetWcidToSetupResolver;
    /// callers that look the key up in a variant-aware atlas should call
    /// this one. SpriteAtlasLoader.TryLookup falls back to the bare-setup
    /// entry when the requested variant isn't packed, so an atlas built
    /// without variant ingest still services these calls correctly.
    /// </summary>
    private Func<int, SpriteKey>? GetWcidToSpriteKeyResolver() {
        var bare = GetWcidToSetupResolver();
        if (bare == null) return null;
        var weenieIdx = _weenieIndex;
        return (int wcid) => {
            uint setup = bare(wcid);
            if (setup == 0) return default;
            var entry = weenieIdx.Get(wcid);
            if (entry == null) return SpriteKey.Bare(setup);
            uint cb = entry.ClothingBaseDid ?? 0u;
            int pt = entry.PaletteTemplate ?? 0;
            if (cb == 0 && pt == 0) return SpriteKey.Bare(setup);
            return new SpriteKey(setup, cb, pt);
        };
    }

    // Cached AC terrain texture tile set, loaded once per project from
    // Region (0x13000000) → TerrainInfo → LandSurfaces → TexMerge.
    private TerrainTextureLoader? _terrainTextures;
    private string? _terrainTexturesProjectDir;

    private TerrainTextureLoader? GetOrLoadTerrainTextures() {
        var p = _projectManager.CurrentProject!;
        if (_terrainTextures != null &&
            string.Equals(_terrainTexturesProjectDir, p.ProjectDirectory, StringComparison.Ordinal))
            return _terrainTextures;
        try {
            _terrainTextures = TerrainTextureLoader.Load(p.DocumentManager.Dats);
            _terrainTexturesProjectDir = p.ProjectDirectory;
        } catch {
            _terrainTextures = null;
        }
        return _terrainTextures;
    }

    // Cached scene-decoration loader, paired with the terrain textures.
    // Resolves Region.SceneInfo per terrain type; the renderer uses it to
    // drop deterministic foliage / clutter sprites on each cell.
    private SceneDecorationLoader? _sceneDecorations;
    private string? _sceneDecorationsProjectDir;

    private SceneDecorationLoader? GetOrLoadSceneDecorations() {
        var p = _projectManager.CurrentProject!;
        if (_sceneDecorations != null &&
            string.Equals(_sceneDecorationsProjectDir, p.ProjectDirectory, StringComparison.Ordinal))
            return _sceneDecorations;
        try {
            _sceneDecorations = SceneDecorationLoader.Load(p.DocumentManager.Dats);
            _sceneDecorationsProjectDir = p.ProjectDirectory;
        } catch {
            _sceneDecorations = null;
        }
        return _sceneDecorations;
    }

    public DungeonRenderResult RenderDungeon(uint lbX, uint lbY, int? floor, int resolution,
            string? outputPath, bool useLbExtent = false) {
        RequireProject();
        if (resolution < 64 || resolution > 8192)
            throw new ArgumentException("resolution must be in [64, 8192]");
        ushort lbKey = LbKey(lbX, lbY);
        var p = _projectManager.CurrentProject!;
        var dungeon = GetDungeonDoc(lbKey)
            ?? throw new InvalidOperationException($"No dungeon document for landblock 0x{lbKey:X4}.");
        var lb = GetLandblockDoc(lbKey);
        var footprints = LoadCellFootprintsForLb(p, lbKey);
        if (footprints.Count == 0) {
            // Auto-extract on demand if cache missing — saves the user a step.
            ExtractCellFootprints(new[] { lbKey }, force: true);
            footprints = LoadCellFootprintsForLb(p, lbKey);
        }

        var input = new DungeonRenderer.Input {
            LbKey = lbKey,
            FloorIndex = floor,
            Resolution = resolution,
            CellFootprints = footprints,
            Dungeon = dungeon,
            Lb = lb,
            SpriteAtlas = GetOrLoadSpriteAtlas(),
            Ontology = id => _ontologyService.GetEntry(id),
            UseLbExtent = useLbExtent,
        };
        var output = DungeonRenderer.Render(input);

        if (floor is int fi && (fi < 0 || fi >= output.FloorCount))
            throw new ArgumentException($"'floor' must be 0..{output.FloorCount - 1} for 0x{lbKey:X4}; got {fi}");

        if (!string.IsNullOrEmpty(outputPath)) {
            var dir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);
            File.WriteAllBytes(outputPath, output.PngBytes);
        }
        return new DungeonRenderResult(
            lbKey, output.FloorIndexRendered, output.FloorCount, output.CellsRendered,
            output.FloorZMin, output.FloorZMax, output.PngBytes, outputPath);
    }

    private List<CellFootprintExtractor.CellFootprint> LoadCellFootprintsForLb(
            WorldBuilder.Shared.Models.Project p, ushort lbKey) {
        var path = Path.Combine(p.ProjectDirectory, "cell_footprints.jsonl");
        if (!File.Exists(path)) return new List<CellFootprintExtractor.CellFootprint>();
        // Why: filter on the qualified cellId field so we don't false-match
        // on envCellId / cellStructure / portal toCellId values that happen
        // to share the same hex prefix as a different LB's id. Earlier loose
        // substring matching caused render-dungeon to compose footprints
        // from entirely unrelated landblocks.
        string lbPrefix = $"\"cellId\":\"0x{lbKey:X4}";
        var result = new List<CellFootprintExtractor.CellFootprint>();
        foreach (var line in File.ReadLines(path)) {
            if (string.IsNullOrWhiteSpace(line)) continue;
            if (!line.Contains(lbPrefix, StringComparison.Ordinal)) continue;
            var fp = ParseCellFootprintLine(line);
            if (fp != null) result.Add(fp);
        }
        return result;
    }

    private static CellFootprintExtractor.CellFootprint? ParseCellFootprintLine(string line) {
        try {
            using var doc = System.Text.Json.JsonDocument.Parse(line);
            var root = doc.RootElement;
            uint cellId = ParseHexU32(root.GetProperty("cellId").GetString() ?? "0");
            ushort envCellId = ParseHexU16(root.GetProperty("envCellId").GetString() ?? "0");
            ushort cellStructure = ParseHexU16(root.GetProperty("cellStructure").GetString() ?? "0");
            var poly = root.GetProperty("polygon");
            var corners = new Vector2[poly.GetArrayLength()];
            for (int i = 0; i < corners.Length; i++) {
                var pt = poly[i];
                corners[i] = new Vector2(pt[0].GetSingle(), pt[1].GetSingle());
            }
            var zr = root.GetProperty("zRange");
            float zMin = zr[0].GetSingle();
            float zMax = zr[1].GetSingle();
            var portals = new List<CellFootprintExtractor.PortalSpan>();
            foreach (var portalEl in root.GetProperty("portals").EnumerateArray()) {
                ushort to = ParseHexU16(portalEl.GetProperty("toCellId").GetString() ?? "0");
                var span = portalEl.GetProperty("wallSpan");
                var a = new Vector2(span[0][0].GetSingle(), span[0][1].GetSingle());
                var b = new Vector2(span[1][0].GetSingle(), span[1][1].GetSingle());
                portals.Add(new CellFootprintExtractor.PortalSpan(to, a, b));
            }
            bool synthetic = root.TryGetProperty("synthetic", out var sx) && sx.GetBoolean();
            return new CellFootprintExtractor.CellFootprint(
                cellId, envCellId, cellStructure, corners, zMin, zMax, portals, synthetic);
        } catch {
            return null;
        }
    }

    private static uint ParseHexU32(string s) {
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s.Substring(2);
        return uint.TryParse(s, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var v) ? v : 0u;
    }

    private static ushort ParseHexU16(string s) {
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s.Substring(2);
        return ushort.TryParse(s, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var v) ? v : (ushort)0;
    }

    public CellFootprintsResult ExtractCellFootprints(IReadOnlyList<ushort>? lbFilter, bool force) {
        RequireProject();
        var p = _projectManager.CurrentProject!;
        var dats = p.DocumentManager.Dats;
        var outPath = Path.Combine(p.ProjectDirectory, "cell_footprints.jsonl");

        // A cache-hit short-circuit only applies to a FULL (no-filter) request:
        // an lbFilter-present request must always take the incremental path so the
        // documented incremental extract is not silently a no-op. force:true reserves
        // a full rebuild.
        bool hasFilter = lbFilter is { Count: > 0 };
        if (!force && !hasFilter && File.Exists(outPath)) {
            int existing = File.ReadAllLines(outPath).Length;
            return new CellFootprintsResult(existing, 0, 0, outPath);
        }

        // Filtered re-extract preserves entries for LBs not in the filter.
        // Why: render-dungeon auto-extracts on cache miss; without merge
        // semantics, a single render call would nuke the full 37k-line cache
        // and leave only the one LB just rendered.
        bool incremental = hasFilter && File.Exists(outPath);
        var keepLines = incremental ? PreserveCacheLinesExcluding(outPath, lbFilter!) : null;

        var dungeonIds = ListDungeonDocIds(p, lbFilter);
        int total = 0, synthetic = 0, scanned = 0;
        using (var sw = new StreamWriter(outPath, append: false)) {
            if (keepLines != null) {
                foreach (var line in keepLines) sw.WriteLine(line);
            }
            foreach (var lbKey in dungeonIds) {
                var dungeon = GetDungeonDoc(lbKey);
                if (dungeon == null || dungeon.Cells.Count == 0) continue;
                scanned++;
                foreach (var cell in dungeon.Cells) {
                    var fp = CellFootprintExtractor.Extract(cell, lbKey, dats);
                    sw.WriteLine(SerializeCellFootprint(fp));
                    total++;
                    if (fp.Synthetic) synthetic++;
                }
            }
        }
        if (keepLines != null) total += keepLines.Count;
        return new CellFootprintsResult(total, synthetic, scanned, outPath);
    }

    private static List<string> PreserveCacheLinesExcluding(string cachePath, IReadOnlyList<ushort> excluded) {
        var excludedPrefixes = new HashSet<string>(StringComparer.Ordinal);
        foreach (var lb in excluded) excludedPrefixes.Add($"\"cellId\":\"0x{lb:X4}");
        var kept = new List<string>();
        foreach (var line in File.ReadLines(cachePath)) {
            if (string.IsNullOrWhiteSpace(line)) continue;
            bool drop = false;
            foreach (var pref in excludedPrefixes) {
                if (line.Contains(pref, StringComparison.Ordinal)) { drop = true; break; }
            }
            if (!drop) kept.Add(line);
        }
        return kept;
    }

    public ObjectSpritesResult GenerateObjectSprites(IReadOnlyList<ushort>? lbFilter, int spritePx, bool force,
            int throttleMs = 0, int lodLevel = 0, bool nightMode = false) {
        RequireProject();
        // Co-exist with concurrent ML training.
        try {
            System.Diagnostics.Process.GetCurrentProcess().PriorityClass =
                System.Diagnostics.ProcessPriorityClass.BelowNormal;
        } catch { }
        var p = _projectManager.CurrentProject!;
        var dats = p.DocumentManager.Dats;
        var spritesDir = Path.Combine(p.ProjectDirectory, "sprites");
        Directory.CreateDirectory(spritesDir);
        // LOD-N atlases sit beside the LOD-0 atlas under the same sprites/
        // dir so the loader can pick a file pair by suffix without changing
        // the per-LB sprite PNG layout. lodLevel == 0 keeps the historical
        // unsuffixed paths so existing tooling and the bare-setup
        // SpriteAtlasLoader.TryLoad(spritesDir) path still work.
        // nightMode atlases live in parallel under a "_night" suffix so a
        // day + night render coexists in one sprites/ dir.
        string suffix = (lodLevel > 0 ? $"_lod{lodLevel}" : "")
                      + (nightMode ? "_night" : "");
        var manifestPath = Path.Combine(spritesDir, $"manifest{suffix}.jsonl");
        var atlasPath = Path.Combine(spritesDir, $"atlas{suffix}.png");

        if (!force && File.Exists(manifestPath) && File.Exists(atlasPath)) {
            int existing = File.ReadAllLines(manifestPath).Length;
            using var probe = SkiaSharp.SKBitmap.Decode(atlasPath);
            if (probe == null)
                throw new InvalidOperationException(
                    $"Cached atlas '{atlasPath}' is corrupt (failed to decode). Re-run with force:true to rebuild.");
            long mtime = new DateTimeOffset(File.GetLastWriteTimeUtc(atlasPath)).ToUnixTimeSeconds();
            // Cache hit — nothing was rendered this run; surface that explicitly
            // rather than fabricating a render-run shape (ModelsRendered = 0).
            return new ObjectSpritesResult(existing, 0, 0,
                probe.Width, probe.Height, spritesDir, atlasPath, manifestPath,
                Cached: true, AtlasMtimeUnix: mtime);
        }

        var modelIds = CollectPlacedModelIds(p, lbFilter);
        Console.Error.WriteLine($"[Sprites] Collected {modelIds.Count} model ids" +
            (modelIds.Count > 0 ? $" (sample: 0x{modelIds.First():X8})" : ""));

        // Seed the atlas with every model id referenced by a Region.SceneInfo
        // Scene. Without this, the renderer's scene-decoration pass picks
        // foliage / rocks whose sprites never made it into the atlas, so the
        // pass falls through silently. Cheap to ingest — Scene records are
        // shared across every cell of a given terrain type.
        var sceneLoader = GetOrLoadSceneDecorations();
        if (sceneLoader != null) {
            int beforeScene = modelIds.Count;
            foreach (var sceneObjId in sceneLoader.CollectAllSceneObjectIds()) {
                modelIds.Add(sceneObjId);
            }
            int added = modelIds.Count - beforeScene;
            if (added > 0) {
                Console.Error.WriteLine($"[Sprites] Added {added} scene-decoration model ids " +
                    "(Region.SceneInfo).");
            }
        }

        // Build the variant tuple set from the WeenieIndex. Each weenie with
        // both ClothingBase and PaletteTemplate set yields a (setup, cb, pt)
        // tuple in addition to the bare setup; the atlas packs both so the
        // renderer can pick the variant sprite for spawn placement and fall
        // back to bare for objects that don't use ClothingTable.
        var keys = new HashSet<SpriteKey>();
        foreach (var setup in modelIds) keys.Add(SpriteKey.Bare(setup));
        int variantCount = 0;
        var weenieIdx = _weenieIndex;
        if (weenieIdx != null && weenieIdx.Count > 0) {
            foreach (var entry in weenieIdx.Entries) {
                if (entry.SetupDid is not { } setupDid) continue;
                if (entry.ClothingBaseDid is not { } cb) continue;
                if (entry.PaletteTemplate is not { } pt) continue;
                if (cb == 0) continue;
                if (keys.Add(new SpriteKey(setupDid, cb, pt))) variantCount++;
            }
        }
        if (variantCount > 0) {
            Console.Error.WriteLine($"[Sprites] Added {variantCount} ClothingTable variant tuples " +
                $"(from {weenieIdx?.Count ?? 0} WeenieIndex entries)");
        }

        var (rendered, failed, atlasW, atlasH) = ObjectSpriteGenerator.Run(
            keys, spritePx, spritesDir, atlasPath, manifestPath, dats,
            id => _ontologyService.GetEntry(id), throttleMs, lodLevel, nightMode);
        return new ObjectSpritesResult(keys.Count, rendered, failed, atlasW, atlasH, spritesDir, atlasPath, manifestPath);
    }

    private List<ushort> ListDungeonDocIds(WorldBuilder.Shared.Models.Project p, IReadOnlyList<ushort>? lbFilter) {
        if (lbFilter is { Count: > 0 }) return new List<ushort>(lbFilter);
        var ids = p.DocumentManager.DocumentStorageService
            .ListDocumentIdsAsync("dungeon_").GetAwaiter().GetResult();
        var keys = new List<ushort>(ids.Count);
        foreach (var id in ids) {
            var hex = id.Substring("dungeon_".Length);
            if (ushort.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var k))
                keys.Add(k);
        }
        keys.Sort();
        return keys;
    }

    private HashSet<uint> CollectPlacedModelIds(WorldBuilder.Shared.Models.Project p, IReadOnlyList<ushort>? lbFilter) {
        var result = new HashSet<uint>();
        var storage = p.DocumentManager.DocumentStorageService;

        IEnumerable<ushort> lbKeys;
        if (lbFilter is { Count: > 0 }) {
            lbKeys = lbFilter;
        } else {
            var lbIds = storage.ListDocumentIdsAsync("landblock_").GetAwaiter().GetResult();
            var parsed = new List<ushort>(lbIds.Count);
            foreach (var id in lbIds) {
                var hex = id.Substring("landblock_".Length);
                if (ushort.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var k))
                    parsed.Add(k);
            }
            lbKeys = parsed;
        }

        int skippedLbs = 0;
        foreach (var lbKey in lbKeys) {
            LandblockDocument lbDoc;
            try {
                lbDoc = GetLandblockDoc(lbKey);
            } catch (Exception ex) {
                skippedLbs++;
                if (skippedLbs <= 10) {
                    Console.Error.WriteLine($"[Sprites] Skip LB 0x{lbKey:X4}: {ex.Message}");
                }
                continue;
            }
            foreach (var obj in lbDoc.GetStaticObjects()) {
                if (obj.IsParticleEmitter) continue;
                result.Add(obj.Id);
            }
        }
        if (skippedLbs > 0) {
            Console.Error.WriteLine($"[Sprites] Skipped {skippedLbs} unloadable landblocks total");
        }

        var dungeonKeys = lbFilter is { Count: > 0 }
            ? new List<ushort>(lbFilter)
            : ListDungeonDocIds(p, null);
        int skippedDungeons = 0;
        foreach (var lbKey in dungeonKeys) {
            DungeonDocument? dungeon;
            try {
                dungeon = GetDungeonDoc(lbKey);
            } catch (Exception ex) {
                skippedDungeons++;
                if (skippedDungeons <= 10) {
                    Console.Error.WriteLine($"[Sprites] Skip dungeon 0x{lbKey:X4}: {ex.Message}");
                }
                continue;
            }
            if (dungeon == null) continue;
            foreach (var cell in dungeon.Cells) {
                foreach (var stab in cell.StaticObjects) result.Add(stab.Id);
            }
        }
        if (skippedDungeons > 0) {
            Console.Error.WriteLine($"[Sprites] Skipped {skippedDungeons} unloadable dungeons total");
        }

        // Also collect setupIds reachable from spawn_gazetteer entries via
        // the wcid → setupId resolver. Without this, spawn-only objects
        // (NPCs, totems, mobs, props placed by server-side spawners) have
        // no atlas entry and the renderer's spawn-glyph dispatch has
        // nothing to look up — they fall to category-color glyphs even
        // when the wcid resolver works at render time. Adding them here
        // means a single sprite-gen pass produces top-down renders for
        // every wcid the world references.
        var resolver = GetWcidToSetupResolver();
        if (resolver != null && _spawnGazetteer.Count > 0) {
            int beforeSpawn = result.Count;
            var lbSet = lbFilter is { Count: > 0 } ? new HashSet<ushort>(lbFilter) : null;
            foreach (var kv in _spawnGazetteer) {
                if (lbSet != null && !lbSet.Contains(kv.Key)) continue;
                foreach (var sp in kv.Value) {
                    if (sp.Wcid <= 0) continue;
                    var setupId = resolver(sp.Wcid);
                    if (setupId != 0) result.Add(setupId);
                }
            }
            Console.Error.WriteLine($"[Sprites] Added {result.Count - beforeSpawn} spawn-derived setupIds " +
                $"(from {_spawnGazetteer.Count} LBs of spawn data)");
        }

        return result;
    }

    private static string SerializeCellFootprint(CellFootprintExtractor.CellFootprint fp) {
        var poly = new object[fp.Polygon.Length];
        for (int i = 0; i < fp.Polygon.Length; i++)
            poly[i] = new[] { Math.Round(fp.Polygon[i].X, 4), Math.Round(fp.Polygon[i].Y, 4) };
        var portals = new object[fp.Portals.Count];
        for (int i = 0; i < fp.Portals.Count; i++) {
            var ps = fp.Portals[i];
            portals[i] = new {
                toCellId = $"0x{ps.ToCellId:X4}",
                wallSpan = new object[] {
                    new[] { Math.Round(ps.A.X, 4), Math.Round(ps.A.Y, 4) },
                    new[] { Math.Round(ps.B.X, 4), Math.Round(ps.B.Y, 4) },
                },
            };
        }
        return System.Text.Json.JsonSerializer.Serialize(new {
            cellId = $"0x{fp.CellId:X8}",
            envCellId = $"0x{fp.EnvCellId:X4}",
            cellStructure = $"0x{fp.CellStructure:X4}",
            polygon = poly,
            zRange = new[] { Math.Round(fp.ZMin, 4), Math.Round(fp.ZMax, 4) },
            portals,
            synthetic = fp.Synthetic,
        }, CellFootprintJsonOpts);
    }

    private static readonly System.Text.Json.JsonSerializerOptions CellFootprintJsonOpts = new() {
        PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public int GetDungeonFloorCount(ushort lbKey) {
        RequireProject();
        var dungeon = GetDungeonDoc(lbKey);
        if (dungeon == null || dungeon.Cells.Count == 0) return 0;
        return LandblockDescriber.ClusterByCellZ(dungeon.Cells.Select(c => c.Origin.Z)).Count;
    }

    /// <summary>
    /// Per-floor cell counts for an indoor LB. Index 0 is the top floor —
    /// matches LandblockDescriber.ClusterByCellZ's z-descending order and
    /// the floor-selector convention in the frontend ("top" / "bot"). Empty
    /// array when the LB has no dungeon document or no cells.
    /// </summary>
    public IReadOnlyList<int> GetDungeonFloorCellCounts(ushort lbKey) {
        RequireProject();
        var dungeon = GetDungeonDoc(lbKey);
        if (dungeon == null || dungeon.Cells.Count == 0) return Array.Empty<int>();
        // ZBand.Count is already the number of cells in the band; ClusterByCellZ
        // returns ascending order. The frontend treats index 0 as "top floor"
        // (z descending), so reverse to match its convention.
        var bandsAsc = LandblockDescriber.ClusterByCellZ(dungeon.Cells.Select(c => c.Origin.Z));
        var counts = new int[bandsAsc.Count];
        for (int i = 0; i < bandsAsc.Count; i++) {
            counts[bandsAsc.Count - 1 - i] = bandsAsc[i].Count;
        }
        return counts;
    }

    public StaticSiteEmitter.EmissionStats EmitStaticSite(string projectSlug, string outDir,
            IReadOnlyList<ushort>? lbFilter, int maxZoom, int minZoom,
            bool emitObjectTier, bool emitFloorTier, int throttleMs = 0,
            string tileFormat = "png") {
        RequireProject();
        return StaticSiteEmitter.Emit(this, projectSlug, outDir, lbFilter, maxZoom, minZoom,
            emitObjectTier, emitFloorTier, throttleMs, tileFormat);
    }

    public LandblockDescriber.FloorDescriptionResult DescribeFloor(uint lbX, uint lbY, int floorIndex) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var lbDoc = GetLandblockDoc(lbKey);
        var dungeonDoc = GetDungeonDoc(lbKey)
            ?? throw new InvalidOperationException($"No dungeon document for landblock 0x{lbKey:X4}.");
        return LandblockDescriber.DescribeFloor(lbKey, floorIndex, lbDoc, dungeonDoc, _wcidToAcpedia);
    }

    public TilePyramidResult EmitTilePyramid(IReadOnlyList<ushort>? lbFilter, string outDir,
            int maxZoom, int minZoom, bool dirtyOnly, bool emitObjectLayer, bool emitFloorLayer,
            int throttleMs = 0, bool multiLodEmit = false, string tileFormat = "png") {
        TilePyramidEmitter.TileFormat fmt = string.Equals(tileFormat, "webp",
            StringComparison.OrdinalIgnoreCase)
            ? TilePyramidEmitter.TileFormat.Webp
            : TilePyramidEmitter.TileFormat.Png;
        RequireProject();
        if (maxZoom < 8 || maxZoom > 12) throw new ArgumentException("maxZoom must be in [8, 12]");
        if (minZoom < 1 || minZoom > maxZoom) throw new ArgumentException("minZoom must be in [1, maxZoom]");

        // Reset the glyph-fallback counter at the start of each emit so
        // the report at the bottom is per-emit (not cumulative across
        // multiple commands in one stdin session).
        GlyphFallbackDiag.Reset();

        var p = _projectManager.CurrentProject!;
        // Three Leaflet tile layers, separated so the frontend's floor-mode
        // can hide objects + sprites while keeping terrain visible:
        //   terrain/  — terrain raster + roads only (opaque)
        //   objects/  — object glyphs only, transparent everywhere else
        //   object/   — sprite-mode rendering for z>=11 (existing convention)
        var terrainDir = Path.Combine(outDir, "terrain");
        var objectsGlyphDir = Path.Combine(outDir, "objects");
        var objectDir = Path.Combine(outDir, "object");
        var floorDir = Path.Combine(outDir, "floor");
        Directory.CreateDirectory(terrainDir);
        Directory.CreateDirectory(objectsGlyphDir);
        if (emitObjectLayer) Directory.CreateDirectory(objectDir);
        if (emitFloorLayer) Directory.CreateDirectory(floorDir);

        // Throttle: keep heavy raster work from contending with concurrent
        // ML training. BelowNormal yields the core to higher-priority work
        // when the scheduler decides to preempt.
        try {
            System.Diagnostics.Process.GetCurrentProcess().PriorityClass =
                System.Diagnostics.ProcessPriorityClass.BelowNormal;
        } catch { /* not all platforms expose PriorityClass; non-fatal */ }

        IReadOnlyList<ushort> targetLbs = ResolveTargetLbs(lbFilter, dirtyOnly);

        // Each LB is rendered at LbPx = TilePx * 2^(maxZoom - 8). For maxZoom=8
        // that's 256px (one tile per LB); for 12, 4096px.
        int lbPx = TilePyramidEmitter.TilePx * (1 << (maxZoom - 8));

        int terrainTiles = 0, objectsGlyphTiles = 0, objectTiles = 0, floorTiles = 0, processed = 0;
        int skippedLbs = 0;
        var firstFailures = new List<(ushort, string)>();
        SpriteAtlasLoader? atlas = emitObjectLayer ? GetOrLoadSpriteAtlas() : null;

        foreach (var lbKey in targetLbs) {
            uint lbX = (uint)((lbKey >> 8) & 0xFF);
            uint lbY = (uint)(lbKey & 0xFF);

            // Skip-tolerance: a few project landblock docs throw on load
            // (e.g. 0x2380, 0x2581 in RetailSmoke). Without this guard, one
            // bad LB would abort the entire emit. Pre-check by attempting
            // to load the doc; if it throws, log and skip.
            try { _ = GetLandblockDoc(lbKey); }
            catch (Exception ex) {
                skippedLbs++;
                if (firstFailures.Count < 5) firstFailures.Add((lbKey, ex.Message));
                Console.Error.WriteLine($"[Emit] Skip LB 0x{lbKey:X4}: {ex.Message}");
                continue;
            }

            // Layer 1: terrain (terrain + roads, opaque background).
            var terrainPng = RenderLbForPyramid(lbX, lbY, lbPx,
                useSprites: false, layer: RenderPreviewRenderer.LayerMode.Terrain);
            if (terrainPng != null) {
                using var bmp = SKBitmap.Decode(terrainPng);
                if (bmp != null && bmp.Width == lbPx && bmp.Height == lbPx) {
                    terrainTiles += TilePyramidEmitter.SliceLbRender(bmp, lbKey, maxZoom, terrainDir, fmt);
                }
            }

            // Layer 2: object glyphs only (transparent terrain). Hidden by
            // the frontend in floor mode so building footprints don't bleed
            // through over the dungeon floor plan.
            var glyphPng = RenderLbForPyramid(lbX, lbY, lbPx,
                useSprites: false, layer: RenderPreviewRenderer.LayerMode.Objects);
            if (glyphPng != null) {
                using var bmp = SKBitmap.Decode(glyphPng);
                if (bmp != null && bmp.Width == lbPx && bmp.Height == lbPx) {
                    objectsGlyphTiles += TilePyramidEmitter.SliceLbRender(bmp, lbKey, maxZoom, objectsGlyphDir, fmt);
                }
            }

            if (emitObjectLayer && atlas != null) {
                if (multiLodEmit) {
                    // Render the sprite layer once per LOD bucket so each
                    // zoom uses an atlas tuned to its pixel density. Each
                    // bucket's "topZoom" is the deepest zoom that bucket
                    // serves; the LB is rendered at the lbPx for that
                    // zoom, sliced, and downsampled within the bucket
                    // after the LB loop completes.
                    foreach (var bucket in EnumerateLodBuckets(maxZoom, minZoom)) {
                        var lodAtlas = GetOrLoadSpriteAtlas(bucket.Lod);
                        if (lodAtlas == null) continue;
                        int bucketLbPx = TilePyramidEmitter.TilePx * (1 << (bucket.TopZoom - 8));
                        var spritePng = RenderLbForPyramid(lbX, lbY, bucketLbPx,
                            useSprites: true, layer: RenderPreviewRenderer.LayerMode.Objects,
                            lodLevel: bucket.Lod);
                        if (spritePng == null) continue;
                        using var bmp = SKBitmap.Decode(spritePng);
                        if (bmp != null && bmp.Width == bucketLbPx && bmp.Height == bucketLbPx) {
                            objectTiles += TilePyramidEmitter.SliceLbRender(bmp, lbKey,
                                bucket.TopZoom, objectDir, fmt);
                        }
                    }
                } else {
                    var spritePng = RenderLbForPyramid(lbX, lbY, lbPx,
                        useSprites: true, layer: RenderPreviewRenderer.LayerMode.Objects);
                    if (spritePng != null) {
                        using var bmp = SKBitmap.Decode(spritePng);
                        if (bmp != null && bmp.Width == lbPx && bmp.Height == lbPx) {
                            objectTiles += TilePyramidEmitter.SliceLbRender(bmp, lbKey, maxZoom, objectDir, fmt);
                        }
                    }
                }
            }

            if (emitFloorLayer) {
                var dungeon = GetDungeonDoc(lbKey);
                if (dungeon != null && dungeon.Cells.Count > 0) {
                    var bands = LandblockDescriber.ClusterByCellZ(dungeon.Cells.Select(c => c.Origin.Z));
                    int floorCount = bands.Count;
                    for (int f = 0; f < floorCount; f++) {
                        // Tile-pyramid floor PNGs MUST anchor to the LB extent
                        // — the frontend overlays them at the LB's full 192×192
                        // wu footprint, so a tight-bounds dungeon render would
                        // visibly stretch and shift the cells off their actual
                        // world positions.
                        var dungeonResult = RenderDungeon(lbX, lbY, f, lbPx,
                            outputPath: null, useLbExtent: true);
                        using var dbmp = SKBitmap.Decode(dungeonResult.PngBytes);
                        if (dbmp != null) {
                            TilePyramidEmitter.WriteFloorTile(dbmp, lbKey, f, floorDir, maxZoom, fmt);
                            floorTiles++;
                        }
                    }
                }
            }
            processed++;
            // Inter-LB throttle so the renderer yields the core back to a
            // concurrent ML run. 0 = disabled.
            if (throttleMs > 0) System.Threading.Thread.Sleep(throttleMs);
        }
        if (skippedLbs > 0) {
            Console.Error.WriteLine($"[Emit] Skipped {skippedLbs} unloadable landblocks total");
        }

        int downsampled = TilePyramidEmitter.Downsample(terrainDir, maxZoom, minZoom, fmt);
        downsampled += TilePyramidEmitter.Downsample(objectsGlyphDir, maxZoom, minZoom, fmt);
        if (emitObjectLayer && atlas != null) {
            if (multiLodEmit) {
                // Per-bucket downsample so each LOD's tiles cover only the
                // zooms its render targeted. Without this, the LOD-0
                // tiles at maxZoom would downsample over the LOD-1/2
                // bucket tiles at lower zooms and overwrite them.
                foreach (var bucket in EnumerateLodBuckets(maxZoom, minZoom)) {
                    if (bucket.TopZoom > bucket.BottomZoom) {
                        downsampled += TilePyramidEmitter.Downsample(objectDir,
                            bucket.TopZoom, bucket.BottomZoom, fmt);
                    }
                }
            } else {
                // Pyramid the sprite tier down to minZoom too (was z=11 floor).
                // Why: the user reported building textures missing at moderate
                // zooms — that's because the sprite layer simply wasn't being
                // emitted below z=11. Downsampling preserves the textured
                // appearance into the low-zoom view; sub-pixel sprites already
                // gracefully fall back to glyphs inside RenderPreviewRenderer.
                downsampled += TilePyramidEmitter.Downsample(objectDir, maxZoom, minZoom, fmt);
            }
        }

        // Glyph-fallback diagnostic: write the per-bucket report to
        // <outDir>/glyph_fallback.txt so the static-site dist carries
        // it next to the tile pyramid, and echo a summary line to
        // stderr for log-tailing during long emits. The file is text
        // (not JSON) because the report is for humans / agents to read,
        // not for the frontend to parse.
        try {
            var report = GlyphFallbackDiag.Report();
            File.WriteAllText(Path.Combine(outDir, "glyph_fallback.txt"), report);
            // Print only the first ~12 lines to stderr (header + a few
            // top buckets) so the stdin-mode JSON response stays clean.
            var lines = report.Split('\n').Take(12).ToArray();
            foreach (var ln in lines) Console.Error.WriteLine(ln);
        } catch (Exception ex) {
            Console.Error.WriteLine($"[GlyphFallback] write failed: {ex.Message}");
        }

        // On a successful dirtyOnly emit, drop the rendered LBs from the dirty
        // set so the next dirtyOnly emit converges instead of re-rendering them.
        bool dirtyTrackingInitialized = _tileCache != null;
        int dirtyTilesRemaining = 0;
        if (dirtyOnly && _tileCache != null) {
            _tileCache.ClearDirtyForLbs(targetLbs);
            dirtyTilesRemaining = _tileCache.DirtyLbCount;
        }

        // exteriorTiles in TilePyramidResult preserves wire compat — return
        // terrain + objects-glyph as the combined "exterior" count.
        return new TilePyramidResult(maxZoom, minZoom, processed,
            terrainTiles + objectsGlyphTiles, objectTiles, floorTiles, downsampled, outDir,
            skippedLbs, firstFailures, dirtyTrackingInitialized, dirtyTilesRemaining);
    }

    private byte[]? RenderLbForPyramid(uint lbX, uint lbY, int lbPx, bool useSprites,
            RenderPreviewRenderer.LayerMode layer = RenderPreviewRenderer.LayerMode.Combined,
            int lodLevel = 0) {
        try {
            // RenderPreview consumes whichever atlas the cache currently
            // holds. For LOD-bucketed emit we pre-warm the cache for the
            // requested LOD before each render — cheap because the cache
            // is keyed on LOD and reused across LBs.
            if (useSprites && lodLevel > 0) GetOrLoadSpriteAtlas(lodLevel);
            var r = RenderPreview(lbX, lbY, radius: 0, resolution: lbPx, overlay: false,
                outputPath: null, useSprites: useSprites, layer: layer);
            return r.PngBytes;
        } catch {
            return null;
        }
    }

    /// <summary>
    /// LOD bucket for the per-zoom render schedule. <c>TopZoom</c> is the
    /// deepest zoom rendered at this LOD (the LB is rendered at its lbPx);
    /// <c>BottomZoom</c> is the shallowest zoom served (downsample fills
    /// in between). Buckets that fall outside the requested [minZoom,
    /// maxZoom] are skipped by EnumerateLodBuckets.
    /// </summary>
    private readonly record struct LodBucket(int Lod, int TopZoom, int BottomZoom);

    /// <summary>
    /// Per-LOD render buckets clipped to [minZoom, maxZoom]. Yielded
    /// deepest-first so the renderer naturally layers detail at the most
    /// important zooms before degrading.
    /// </summary>
    private static IEnumerable<LodBucket> EnumerateLodBuckets(int maxZoom, int minZoom) {
        // Bucket schedule mirrors TilePyramidEmitter.LodForZoom:
        //   z >= 11 → LOD 0,  z == 10 → LOD 1,  z <= 9 → LOD 2.
        // Each bucket renders at its TopZoom and downsamples to BottomZoom.
        var schedule = new (int Lod, int Top, int Bottom)[] {
            (0, maxZoom, Math.Max(11, minZoom)),
            (1, 10,      10),
            (2, 9,       minZoom),
        };
        foreach (var (lod, top, bottom) in schedule) {
            int t = Math.Min(top, maxZoom);
            int b = Math.Max(bottom, minZoom);
            if (t < b) continue;       // bucket entirely above maxZoom or below minZoom
            if (b > maxZoom) continue; // bucket bottom outside range
            if (t < minZoom) continue;
            yield return new LodBucket(lod, t, b);
        }
    }

    private IReadOnlyList<ushort> ResolveTargetLbs(IReadOnlyList<ushort>? lbFilter, bool dirtyOnly) {
        if (lbFilter is { Count: > 0 }) return lbFilter;
        var p = _projectManager.CurrentProject!;
        if (dirtyOnly) {
            // The tile pipeline must be initialized (a prior get-tile or full emit)
            // before dirty-tracking is meaningful. When it isn't, render NOTHING
            // rather than silently falling through to a full-world bake.
            if (_tileCache == null) return Array.Empty<ushort>();
            var dirty = new List<ushort>();
            foreach (var hex in _tileCache.DirtyLbs) {
                if (ushort.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var k))
                    dirty.Add(k);
            }
            return dirty;
        }
        var ids = p.DocumentManager.DocumentStorageService
            .ListDocumentIdsAsync().GetAwaiter().GetResult();
        var keys = new HashSet<ushort>();
        foreach (var id in ids) {
            string? hex = id.StartsWith("landblock_", StringComparison.Ordinal) ? id.Substring("landblock_".Length)
                : id.StartsWith("dungeon_", StringComparison.Ordinal) ? id.Substring("dungeon_".Length)
                : null;
            if (hex == null) continue;
            if (ushort.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var k))
                keys.Add(k);
        }
        return keys.OrderBy(k => k).ToList();
    }
}
