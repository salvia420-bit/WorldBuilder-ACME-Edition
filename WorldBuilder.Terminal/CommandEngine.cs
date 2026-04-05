using System.Globalization;
using System.Numerics;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Options;
using DatReaderWriter.Types;
using DatReaderWriter.Extensions.DBObjs;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.AceDb;
using WorldBuilder.Shared.Lib.Dungeon;
using WorldBuilder.Shared.Lib.Noise;
using WorldBuilder.Shared.Lib.Terrain;
using WorldBuilder.Shared.Lib.Validation;
using WorldBuilder.Shared.Models;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Terminal;

/// <summary>
/// Shared command engine that contains all WorldBuilder business logic.
/// Both <see cref="TerminalRepl"/> and <see cref="JsonCommandProcessor"/>
/// delegate to this class. The engine operates on parsed parameters and
/// returns structured result records â€” it never touches Console or JSON directly.
/// </summary>
public class CommandEngine {
    private readonly HeadlessProjectManager _projectManager;
    private readonly ITerrainService _terrainService;
    private readonly IObjectPlacementService _objectPlacementService;
    private readonly IDungeonService _dungeonService;
    private readonly IOntologyService _ontologyService;
    private readonly IStampService _stampService;

    // Cached terrain helpers (lazily initialised, invalidated on project load)
    private TerrainDocument? _terrainDocCache;
    private float[]? _heightTableCache;

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

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Project management
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public LoadResult Load(string projectPath) {
        _projectManager.LoadProject(projectPath);
        InvalidateCaches();
        var p = _projectManager.CurrentProject!;
        return new LoadResult(p.Name, p.FilePath, p.ProjectDirectory, p.BaseDatDirectory);
    }

    public ExportResult Export(string directory, int? iteration) {
        RequireProject();
        var success = _projectManager.ExportDats(directory, iteration);
        return new ExportResult(success, directory, iteration);
    }

    public async Task<ExportWithRepositionResult> ExportWithRepositionAsync(
        string directory, int? iteration) {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        var success = _projectManager.ExportDats(directory, iteration);

        if (!success) {
            return new ExportWithRepositionResult(false, directory, iteration,
                false, false, 0, 0, 0, "DAT export failed");
        }

        // Check if ace-db settings exist
        var settings = project.AceDb;
        if (settings == null || string.IsNullOrEmpty(settings.Host)) {
            return new ExportWithRepositionResult(true, directory, iteration,
                false, false, 0, 0, 0, "No ACE database settings configured. Use 'ace-db connect' first.");
        }

        try {
            // Build the reposition context â€” same pattern as AceDbRepositionAsync
            var terrainDoc = GetTerrainDoc();
            var heightTable = GetHeightTable();
            var modifiedLbs = new HashSet<ushort>(terrainDoc.TerrainData.Landblocks.Keys);

            if (modifiedLbs.Count == 0) {
                return new ExportWithRepositionResult(true, directory, iteration,
                    true, true, 0, 0, 0, "No modified landblocks detected â€” nothing to reposition");
            }

            // Capture old terrain from base DATs, new from current document state
            var oldTerrain = new Dictionary<ushort, TerrainEntry[]>(modifiedLbs.Count);
            var newTerrain = new Dictionary<ushort, TerrainEntry[]>(modifiedLbs.Count);
            var dats = project.DocumentManager.Dats;

            foreach (var lbKey in modifiedLbs) {
                var baseLbId = (uint)(lbKey << 16) | 0xFFFF;
                if (dats.TryGet<LandBlock>(baseLbId, out var baseLb)) {
                    var entries = new TerrainEntry[81];
                    for (int i = 0; i < 81; i++) {
                        var terrainVertex = baseLb.Terrain[i];
                        entries[i] = new TerrainEntry(
                            terrainVertex.Road,
                            terrainVertex.Scenery,
                            (byte)terrainVertex.Type,
                            baseLb.Height[i]);
                    }
                    oldTerrain[lbKey] = entries;
                }

                var currentEntries = terrainDoc.GetLandblockInternal(lbKey);
                if (currentEntries != null) {
                    var snapshot = new TerrainEntry[81];
                    currentEntries.AsSpan(0, 81).CopyTo(snapshot);
                    newTerrain[lbKey] = snapshot;
                }
            }

            var ctx = new RepositionContext {
                ModifiedLandblocks = modifiedLbs.ToArray(),
                OldTerrain = oldTerrain,
                NewTerrain = newTerrain,
                LandHeightTable = heightTable,
                ExportDirectory = directory
            };

            // Run with apply enabled
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

            return new ExportWithRepositionResult(true, directory, iteration,
                true, result.Error == null,
                result.InstancesChecked, result.InstancesUpdated,
                result.LandblocksProcessed,
                result.Error);
        } catch (Exception ex) {
            return new ExportWithRepositionResult(true, directory, iteration,
                true, false, 0, 0, 0, ex.Message);
        }
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

    public TerrainEditResult Smooth(float x, float y, float radius, float strength = 0.5f) {
        RequireProject();
        var (doc, tl, hl) = GetTerrainHelpers();
        var affected = _terrainService.GetAffectedVertices(new Vector3(x, y, 0), radius, hl);
        var changes = _terrainService.ComputeSmooth(affected, strength, tl);
        return ApplyHeightEdit(doc, changes);
    }

    public TerrainEditResult Raise(float x, float y, float radius, int delta = 5) {
        RequireProject();
        var (doc, tl, hl) = GetTerrainHelpers();
        var affected = _terrainService.GetAffectedVertices(new Vector3(x, y, 0), radius, hl);
        var changes = _terrainService.ComputeRaiseLower(affected, Math.Abs(delta), tl);
        return ApplyHeightEdit(doc, changes);
    }

    public TerrainEditResult Lower(float x, float y, float radius, int delta = 5) {
        RequireProject();
        var (doc, tl, hl) = GetTerrainHelpers();
        var affected = _terrainService.GetAffectedVertices(new Vector3(x, y, 0), radius, hl);
        var changes = _terrainService.ComputeRaiseLower(affected, -Math.Abs(delta), tl);
        return ApplyHeightEdit(doc, changes);
    }

    public TerrainEditResult SetHeight(float x, float y, float radius, byte targetHeight) {
        RequireProject();
        var (doc, tl, hl) = GetTerrainHelpers();
        var affected = _terrainService.GetAffectedVertices(new Vector3(x, y, 0), radius, hl);
        var changes = _terrainService.ComputeSetHeight(affected, targetHeight, tl);
        return ApplyHeightEdit(doc, changes);
    }

    public TerrainEditResult Paint(float x, float y, float radius, byte terrainType) {
        RequireProject();
        var (doc, tl, hl) = GetTerrainHelpers();
        var affected = _terrainService.GetAffectedVertices(new Vector3(x, y, 0), radius, hl);

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
        foreach (var wp in path) {
            var vi = _terrainService.WorldToVertex(wp.X, wp.Y);
            if (!vi.HasValue) continue;
            var (lbId, vIndex) = vi.Value;
            if (!terrainCache.TryGetValue(lbId, out var data)) {
                data = tl(lbId);
                terrainCache[lbId] = data;
            }

            if (data == null || data[vIndex].Road == roadValue) continue;
            if (!batchChanges.TryGetValue(lbId, out var lbChanges)) {
                lbChanges = new Dictionary<byte, uint>(16);
                batchChanges[lbId] = lbChanges;
            }
            var current = data[vIndex];
            lbChanges[(byte)vIndex] = (current with { Road = roadValue }).ToUInt();
            changeCount++;
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
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var data = GetTerrainDoc().GetLandblockInternal(lbKey);

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
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var data = GetTerrainDoc().GetLandblockInternal(lbKey);
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
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var data = GetTerrainDoc().GetLandblockInternal(lbKey);
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

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Object management
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public ListObjectsResult ListObjects(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var lbDoc = GetLandblockDoc(lbKey);
        return new ListObjectsResult(lbKey, lbDoc.GetStaticObjects().ToList());
    }

    public AddObjectResult AddObject(uint lbX, uint lbY, uint modelId,
        float x, float y, float z,
        Quaternion? orientation = null, Vector3? scale = null,
        bool snapToCell = false) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var lbDoc = GetLandblockDoc(lbKey);

        // Optionally snap position to the nearest outdoor cell center,
        // matching the behaviour of the UI's building placement tool.
        float finalX = x, finalY = y;
        if (snapToCell) {
            (finalX, finalY) = _objectPlacementService.SnapToNearestCellCenter(x, y);
        }

        var obj = new StaticObject {
            Id = modelId,
            IsSetup = (modelId & 0x02000000) != 0,
            Origin = new Vector3(finalX, finalY, z),
            Orientation = orientation ?? Quaternion.Identity,
            Scale = scale ?? Vector3.One
        };
        int index = lbDoc.AddStaticObject(obj);
        return new AddObjectResult(lbKey, index, obj);
    }

    public RemoveObjectResult RemoveObject(uint lbX, uint lbY, int index) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var lbDoc = GetLandblockDoc(lbKey);
        ValidateObjectIndex(lbDoc, index, "remove-object");
        var obj = lbDoc.GetStaticObject(index);
        bool removed = lbDoc.RemoveStaticObject(index);
        return new RemoveObjectResult(removed, lbKey, index, obj.Id, obj.Origin);
    }

    public MoveObjectResult MoveObject(uint lbX, uint lbY, int index,
        float x, float y, float z) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var lbDoc = GetLandblockDoc(lbKey);
        ValidateObjectIndex(lbDoc, index, "move-object");
        var obj = lbDoc.GetStaticObject(index);
        var oldPos = obj.Origin;
        obj.Origin = new Vector3(x, y, z);
        lbDoc.UpdateStaticObject(index, obj);
        return new MoveObjectResult(lbKey, index, obj.Id, oldPos, obj.Origin);
    }

    public RotateObjectResult RotateObject(uint lbX, uint lbY, int index,
        Quaternion newOrientation) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var lbDoc = GetLandblockDoc(lbKey);
        ValidateObjectIndex(lbDoc, index, "rotate-object");
        var obj = lbDoc.GetStaticObject(index);
        var oldQ = obj.Orientation;
        obj.Orientation = newOrientation;
        lbDoc.UpdateStaticObject(index, obj);
        return new RotateObjectResult(lbKey, index, obj.Id, oldQ, newOrientation);
    }

    /// <summary>
    /// Clears all static objects from a single landblock.
    /// </summary>
    public ClearObjectsResult ClearObjects(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var lbDoc = GetLandblockDoc(lbKey);
        int removed = lbDoc.ClearStaticObjects();
        var affected = removed > 0 ? new List<ushort> { lbKey } : new List<ushort>();
        return new ClearObjectsResult(true, removed, 1, affected);
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
                LandblockDocument lbDoc;
                try { lbDoc = GetLandblockDoc(lbKey); } catch { continue; }

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
        var report = _dungeonService.AnalyzeRooms(dats);
        if (!string.IsNullOrEmpty(outputPath)) _dungeonService.SaveAnalysisReport(report, outputPath);
        return (report, outputPath);
    }

    public DungeonInfoResult GetDungeonInfo(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var dungeonDoc = GetDungeonDoc(lbKey);
        if (dungeonDoc == null || dungeonDoc.Cells.Count == 0)
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
                Console.WriteLine($"[AnalyzeDungeonCatalog] Saved catalog to: {outputPath}");
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
                Console.WriteLine($"[AnalyzeDungeonTopology] Saved topology to: {outputPath}");
            }

            return new AnalyzeDungeonTopologyResult(
                true,
                report.TotalDungeonsAnalyzed,
                report.TotalCellsAnalyzed,
                report.ClassificationCounts,
                outputPath);
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
            Console.WriteLine("[GenerateDungeon] Extracting room catalog...");
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
                        warnings.Add($"No available portals on parent cell 0x{parentPlacement.cellNum:X4} for child node #{childNodeId} ({childNode.Type})");
                        // Still enqueue for BFS so we can process its children if it gets placed elsewhere
                        continue;
                    }

                    // Pick template for child
                    int childChildCount = childCounts.GetValueOrDefault(childNodeId);
                    int childPortalsNeeded = childChildCount + 1;  // +1 for connection to parent
                    var childTemplate = PickTemplate(catalog.Templates, childNode.Type, childPortalsNeeded, rng);
                    if (childTemplate == null) {
                        warnings.Add($"No suitable template for node #{childNodeId} ({childNode.Type}) â€” skipping");
                        continue;
                    }

                    // Load child CellStruct
                    uint childEnvFileId = (uint)(childTemplate.EnvironmentId | 0x0D000000);
                    if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(childEnvFileId, out var childEnv)) {
                        warnings.Add($"Could not load Environment 0x{childEnvFileId:X8} for child node #{childNodeId}");
                        continue;
                    }

                    if (!childEnv.Cells.TryGetValue(childTemplate.CellStructIndex, out var childCellStruct)) {
                        warnings.Add($"CellStruct {childTemplate.CellStructIndex} not found in child Environment 0x{childEnvFileId:X8}");
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
        var dungeonDoc = GetDungeonDoc(lbKey)
            ?? throw new InvalidOperationException($"Could not load dungeon for landblock 0x{lbKey:X4}");
        return ValidationEngine.ValidateDungeon(dungeonDoc,
            _projectManager.CurrentProject!.DocumentManager.Dats);
    }

    public ValidationReport ValidateLandblock(uint lbX, uint lbY) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var lbDoc = GetLandblockDoc(lbKey);
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        Func<float, float, float>? heightLookup = null;
        try { (_, _, heightLookup) = GetTerrainHelpers(); } catch { }
        return ValidationEngine.ValidateLandblock(lbDoc, lbKey, heightLookup, dats);
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
            _projectManager.CurrentProject!.DocumentManager.Dats);
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

        DungeonDocument? dungeonDoc = null;
        try { dungeonDoc = GetDungeonDoc(lbKey); } catch { }

        LandblockDocument? lbDoc = null;
        try { lbDoc = GetLandblockDoc(lbKey); } catch { }

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
            lbKey, dungeonDoc, lbDoc, terrainDoc, heightTable, heightLookup, dats, cliffThreshold);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  World observation
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public ListLandblocksResult ListLandblocks(
        uint minX = 0, uint minY = 0, uint maxX = 254, uint maxY = 254, int limit = 500) {
        RequireProject();
        var terrainDoc = GetTerrainDoc();
        var results = new List<LandblockSummary>();

        for (uint x = minX; x <= maxX && results.Count < limit; x++) {
            for (uint y = minY; y <= maxY && results.Count < limit; y++) {
                ushort lbKey = (ushort)((x << 8) | y);
                var data = terrainDoc.GetLandblockInternal(lbKey);
                if (data == null) continue;
                int hMin = 255, hMax = 0;
                for (int i = 0; i < data.Length; i++) {
                    if (data[i].Height < hMin) hMin = data[i].Height;
                    if (data[i].Height > hMax) hMax = data[i].Height;
                }
                results.Add(new LandblockSummary(lbKey, x, y, hMin, hMax));
            }
        }

        return new ListLandblocksResult(results.Count, minX, minY, maxX, maxY,
            results.Count >= limit, results);
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
            ht.Length > 0 ? Math.Round(ht[0], 2) : 0,
            ht.Length > 0 ? Math.Round(ht[ht.Length - 1], 2) : 0,
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

        // Step 1: Capture source terrain into a stamp
        Func<ushort, IEnumerable<StaticObject>>? objLookup = null;
        if (includeObjects) {
            objLookup = lbKey => {
                try { return GetLandblockDoc(lbKey).GetStaticObjects(); }
                catch { return Enumerable.Empty<StaticObject>(); }
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
        if (includeObjects) {
            foreach (var (lbKey, obj) in pasteResult.ObjectsToPlace) {
                try {
                    var lbDoc = GetLandblockDoc(lbKey);
                    lbDoc.AddStaticObject(obj);
                    objectsPlaced++;
                } catch { /* skip objects in unloaded landblocks */ }
            }
        }

        int terrainChanges = pasteResult.TerrainChanges.Values.Sum(d => d.Count);
        var modifiedLbs = new HashSet<ushort>(pasteResult.TerrainChanges.Keys);
        return new PasteStampResult(terrainChanges, objectsPlaced, modifiedLbs);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Portal snap operations
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public SnapPortalResult SnapPortal(
        uint lbX, uint lbY, ushort targetCellNumber, ushort targetPortalPolyId,
        ushort sourceEnvId, ushort sourceCellStruct) {

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

        // Get surfaces from source environment  
        var surfaces = new List<ushort>();
        if (sourceEnv.Cells != null && sourceEnv.Cells.ContainsKey(sourceCellStruct)) {
            // Use empty surfaces â€” they'll be populated from the environment
        }

        // Add the new cell to the dungeon
        var newCellNum = dungeonDoc.AddCell(sourceEnvId, sourceCellStruct, newOrigin, newOrientation, surfaces);

        // Connect the portals between target and new cell
        dungeonDoc.ConnectPortals(targetCellNumber, targetPortalPolyId, newCellNum, bestSourcePortalId);

        int totalPortals = 0;
        var newCell = dungeonDoc.GetCell(newCellNum);
        if (newCell != null) totalPortals = newCell.CellPortals.Count;

        return new SnapPortalResult(
            lbKey, targetCellNumber, targetPortalPolyId,
            sourceEnvId, sourceCellStruct, newCellNum,
            newOrigin, newOrientation, totalPortals);
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
                        foreach (var sid in gfx.Surfaces) surfaceIds.Add(sid.ToString());

                    // Compute bounds from vertices
                    Vector3 partOffset = Vector3.Zero;
                    if (setup.PlacementFrames != null && setup.PlacementFrames.Count > 0) {
                        var dp = setup.PlacementFrames.Values.FirstOrDefault();
                        if (dp?.Frames != null && i < dp.Frames.Count)
                            partOffset = dp.Frames[i].Origin;
                    }
                    if (gfx.VertexArray?.Vertices != null) {
                        foreach (var v in gfx.VertexArray.Vertices.Values) {
                            var wpos = v.Origin + partOffset;
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
                foreach (var sid in gfx.Surfaces) surfaceIds.Add(sid.ToString());

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
            return new TerrainDiffResult(lbKey, lbX, lbY, true, false, 81);

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
        try {
            if (_projectManager.CurrentProject!.DocumentManager.Dats
                .TryGet<DatReaderWriter.DBObjs.Region>(0x13000000, out var region)) {
                var types = region.TerrainInfo?.TerrainTypes;
                if (types != null) {
                    terrainTypes = types.Select((tt, i) => {
                        try { return new TerrainTypeNameInfo(i, tt.TerrainName); }
                        catch { return new TerrainTypeNameInfo(i, "(unavailable)"); }
                    }).ToList();
                }
            }
        } catch { }
        return new RegionResult(ht, terrainTypes);
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

        // Iterate Portal tree for RenderSurface entries
        foreach (var entry in writer.Dats.Portal.Tree) {
            if (entry.Id < rangeMin || entry.Id > rangeMax) continue;

            try {
                if (writer.Dats.TryGet<DatReaderWriter.DBObjs.RenderSurface>(entry.Id, out var rs)) {
                    var outPath = Path.Combine(outputDirectory, $"0x{entry.Id:X8}.png");
                    var result = rs.SaveToImageFile(outPath, writer);
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
                    var result = rs.SaveToImageFile(outPath, writer);
                    if (result.Success) exported++;
                    else { failed++; errors.Add($"0x{entry.Id:X8}_hires: {result.Error}"); }
                }
            } catch (Exception ex) {
                failed++;
                errors.Add($"0x{entry.Id:X8}_hires: {ex.Message}");
            }
        }

        return new ExportTexturesResult(failed == 0 || exported > 0, exported, failed,
            outputDirectory, errors.Count > 0 ? errors.Take(20).ToList() : null);
    }

    public ImportTextureResult ImportTexture(uint textureId, string imageFilePath) {
        RequireProject();
        if (!File.Exists(imageFilePath))
            return new ImportTextureResult(false, textureId, imageFilePath, "File not found");

        try {
            var datDir = _projectManager.CurrentProject!.BaseDatDirectory;
            using var writer = new DatReaderWriter.Extensions.DatEasyWriter(datDir);
            var result = writer.UpdateRenderSurface(textureId, imageFilePath, shouldResize: true);
            if (result.Success)
                return new ImportTextureResult(true, textureId, imageFilePath);
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

            int bytesFreed = DatReaderWriter.Extensions.DatDatabaseExtensions.Defragment(db, outputPath);
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
            writer.WriteLine("ObjectId,DatType,Category,Scale,MaxDimension,AspectRatio,PartCount,PolyCount,Tags,ClassificationSource");
            foreach (var entry in _ontologyService.GetAllEntries()) {
                writer.WriteLine($"0x{entry.ObjectId:X8},{entry.DatType},{Csv(entry.Category)},{Csv(entry.Scale)},{entry.MaxDimension:F2},{entry.AspectRatio:F2},{entry.PartCount},{entry.PolyCount},{Csv(string.Join(";", entry.Tags ?? Array.Empty<string>()))},{Csv(entry.ClassificationSource)}");
                count++;
            }
        }

        return new ExportOntologyResult(true, count, outputPath);
    }

    private static string Csv(string? val) =>
        val == null ? "" : val.Contains(',') || val.Contains('"') ? $"\"{val.Replace("\"", "\"\"")}\"" : val;

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  StringTable mining (DAT string extraction)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    public MineStringsResult MineStrings(string? outputPath = null, string? tableFilter = null) {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        var datDir = project.BaseDatDirectory;

        var allStrings = new List<StringTableEntry>();
        int tablesScanned = 0;

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
                } catch {
                    // Skip tables that fail to load â€” some may not exist in this DAT
                }
            }

            // Optionally write to CSV
            if (!string.IsNullOrEmpty(outputPath)) {
                using var sw = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);
                sw.WriteLine("Hash,TableType,Text");
                foreach (var entry in allStrings) {
                    sw.WriteLine($"0x{entry.Hash:X8},{Csv(entry.TableType)},{Csv(entry.Text)}");
                }
            }

            return new MineStringsResult(true, tablesScanned, allStrings.Count, allStrings, outputPath);
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

            // Extract creature_family entries from the schema
            if (root.TryGetProperty("entries", out var entries)) {
                foreach (var entry in entries.EnumerateArray()) {
                    // Skip comment entries
                    if (entry.TryGetProperty("_comment", out _)) continue;

                    // Get creature_family if present
                    string? creatureFamily = null;
                    string? name = null;
                    string? entryType = null;

                    if (entry.TryGetProperty("name", out var nameEl))
                        name = nameEl.GetString();

                    if (entry.TryGetProperty("tags", out var tags)) {
                        if (tags.TryGetProperty("creature_family", out var cf))
                            creatureFamily = cf.GetString();
                        if (tags.TryGetProperty("type", out var typeEl))
                            entryType = typeEl.GetString();
                    }

                    // Try to enrich by weenieClassId ranges (creature families have wcid_pool ranges)
                    if (entry.TryGetProperty("wcid_pool", out var wcidPool)) {
                        // This is a creature family entry
                        var familyName = name ?? creatureFamily ?? "Unknown";

                        // Extract model_prefix for DAT ID matching
                        if (entry.TryGetProperty("model_prefix", out var modelPrefix)) {
                            var prefix = modelPrefix.GetString();
                            if (prefix != null) {
                                // Try to parse as hex prefix (e.g., "0x0200" matches 0x020000xx)
                                if (prefix.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
                                    if (uint.TryParse(prefix.AsSpan(2),
                                            System.Globalization.NumberStyles.HexNumber,
                                            null, out var prefixVal)) {
                                        // Enrich matching entries with creature family tag
                                        foreach (var ontEntry in _ontologyService.GetAllEntries()) {
                                            if ((ontEntry.ObjectId >> 16) == (prefixVal >> 16)) {
                                                var newTags = new List<string>(ontEntry.Tags ?? Array.Empty<string>());
                                                if (!newTags.Contains(familyName.ToLowerInvariant()))
                                                    newTags.Add(familyName.ToLowerInvariant());
                                                if (!newTags.Contains("creature"))
                                                    newTags.Add("creature");
                                                ontEntry.Tags = newTags.Distinct().ToArray();
                                                enriched++;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // For weenie-based entries with Setup IDs, try to enrich the ontology
                    if (entry.TryGetProperty("setupId", out var setupEl)) {
                        uint setupId = 0;
                        var setupStr = setupEl.GetString();
                        if (setupStr != null && setupStr.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
                            uint.TryParse(setupStr.AsSpan(2),
                                System.Globalization.NumberStyles.HexNumber, null, out setupId);
                        } else if (setupEl.ValueKind == System.Text.Json.JsonValueKind.Number) {
                            setupId = setupEl.GetUInt32();
                        }

                        if (setupId != 0) {
                            var ontEntry = _ontologyService.GetEntry(setupId);
                            if (ontEntry != null && name != null) {
                                var newTags = new List<string>(ontEntry.Tags ?? Array.Empty<string>());
                                if (!newTags.Contains(name.ToLowerInvariant()))
                                    newTags.Add(name.ToLowerInvariant());
                                if (entryType != null && !newTags.Contains(entryType.ToLowerInvariant()))
                                    newTags.Add(entryType.ToLowerInvariant());
                                if (creatureFamily != null && !newTags.Contains(creatureFamily.ToLowerInvariant()))
                                    newTags.Add(creatureFamily.ToLowerInvariant());
                                ontEntry.Tags = newTags.Distinct().ToArray();

                                // Override category from curated data if it's more specific
                                if (entryType != null) {
                                    var topLevel = entryType.Split('_')[0];
                                    if (topLevel != ontEntry.Category)
                                        ontEntry.ClassificationSource = "Schema";
                                }
                                enriched++;
                            }
                        }
                    }
                }
            }

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
            int enriched = _ontologyService.ImportCatalog(indexJsonPath);
            return new ImportCatalogResult(true, enriched, _ontologyService.Count, indexJsonPath);
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

        Console.WriteLine($"[IngestWeenies] Found {total} weenie files in {weeniesDir}");

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
                    writer.WriteLine("}");

                    processed++;
                } catch {
                    errors++;
                    // Skip individual file failures
                }

                if ((processed + errors) % 1000 == 0)
                    Console.WriteLine($"[IngestWeenies] ...{processed + errors}/{total} files processed ({errors} errors)");
            }

            Console.WriteLine($"[IngestWeenies] Complete: {processed}/{total} files processed, {errors} errors");
            Console.WriteLine($"[IngestWeenies]   Creatures: {creatures}, NPCs: {npcs}, Items: {items}, Other: {other}");
            Console.WriteLine($"[IngestWeenies]   With SetupDID: {withSetup} ({(total > 0 ? 100.0 * withSetup / total : 0):F1}%)");
            Console.WriteLine($"[IngestWeenies]   Output: {outputPath}");

            return new IngestWeeniesResult(true, processed, creatures, npcs, items, other, withSetup, outputPath);
        } catch (Exception ex) {
            return new IngestWeeniesResult(false, processed, creatures, npcs, items, other, withSetup, outputPath, ex.Message);
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
                        writer.Write(Math.Round(worldX, 1));
                        writer.Write(",\"worldY\":");
                        writer.Write(Math.Round(worldY, 1));
                        writer.Write(",\"worldZ\":");
                        writer.Write(Math.Round(worldZ, 1));
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
                    Console.WriteLine($"[ScanBuildings] ...{x + 1}/255 rows scanned, {totalBuildings} buildings found");
            }

            sw.Stop();
            Console.WriteLine($"[ScanBuildings] Complete: {totalBuildings} buildings, {uniqueSetupIds.Count} unique models, {landblocksWithBuildings} landblocks");
            Console.WriteLine($"[ScanBuildings] Output: {outputPath}");

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
                uint lbId = (uint)((lbX << 8) | lbY);

                // World-space offset for this landblock
                float worldOffsetX = lbX * 192f;
                float worldOffsetY = lbY * 192f;

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

                    float localX = obj.TryGetProperty("localX", out var lxEl) ? lxEl.GetSingle() : 96f;
                    float localY = obj.TryGetProperty("localY", out var lyEl) ? lyEl.GetSingle() : 96f;
                    float localZ = 0f;

                    // Height-snap: convert local to world coords, sample terrain
                    if (heightLookup != null) {
                        try {
                            float worldX = worldOffsetX + localX;
                            float worldY = worldOffsetY + localY;
                            localZ = heightLookup(worldX, worldY);
                        } catch {
                            // Height lookup can fail at edges or ocean â€” fall back to 0
                        }
                    }

                    if (!dryRun) {
                        // Get or create the landblock document via existing helper
                        var lbDoc = GetLandblockDoc((ushort)lbId);

                        bool isSetup = setupId >= 0x02000000;
                        var staticObj = new StaticObject {
                            Id = setupId,
                            IsSetup = isSetup,
                            Origin = new System.Numerics.Vector3(localX, localY, localZ),
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

        Console.WriteLine($"[IngestSpawnMaps] Found {total} spawn map files in {mapsDir}");

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
                    Console.WriteLine($"[IngestSpawnMaps] ...{processed + errors}/{total} files processed ({errors} errors)");
            }

            Console.WriteLine($"[IngestSpawnMaps] Complete: {processed}/{total} files, {totalWeenies} weenies, {totalLinks} links, {allWcids.Count} unique WCIDs");
            Console.WriteLine($"[IngestSpawnMaps]   Output: {outputPath}");

            return new IngestSpawnMapsResult(true, processed, totalWeenies, totalLinks, allWcids.Count, outputPath);
        } catch (Exception ex) {
            return new IngestSpawnMapsResult(false, processed, totalWeenies, totalLinks, allWcids.Count, outputPath, ex.Message);
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

        Console.WriteLine($"[IngestSpells] Reading spells from: {spellsFile}");

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
            Console.WriteLine($"[IngestSpells] Found {total} spell entries");

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
                    Console.WriteLine($"[IngestSpells] ...{processed + errors}/{total} entries processed ({errors} errors)");
            }

            Console.WriteLine($"[IngestSpells] Complete: {processed} spells processed, {errors} errors");
            Console.WriteLine($"[IngestSpells]   Schools: {string.Join(", ", schoolCounts.OrderBy(kv => kv.Key).Select(kv => $"{kv.Key}={kv.Value}"))}");
            Console.WriteLine($"[IngestSpells]   Output: {outputPath}");

            return new IngestSpellsResult(true, processed, schoolCounts, outputPath);
        } catch (Exception ex) {
            return new IngestSpellsResult(false, processed, schoolCounts, outputPath, ex.Message);
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

        Console.WriteLine($"[IngestRecipes] Found {total} recipe files in: {recipesDir}");

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
                    Console.WriteLine($"[IngestRecipes] ...{processed + errors}/{total} files processed ({errors} errors)");
            }

            Console.WriteLine($"[IngestRecipes] Complete: {processed} recipes processed, {errors} errors");
            Console.WriteLine($"[IngestRecipes]   Skills: {string.Join(", ", skillCounts.OrderBy(kv => kv.Key).Select(kv => $"{kv.Key}={kv.Value}"))}");
            Console.WriteLine($"[IngestRecipes]   With precursors: {withPrecursors}");
            Console.WriteLine($"[IngestRecipes]   Unique source WCIDs (tools+targets): {sourceWcids.Count}");
            Console.WriteLine($"[IngestRecipes]   Unique result WCIDs: {resultWcids.Count}");
            Console.WriteLine($"[IngestRecipes]   Output: {outputPath}");

            return new IngestRecipesResult(true, processed, withPrecursors,
                sourceWcids.Count, resultWcids.Count, skillCounts, outputPath);
        } catch (Exception ex) {
            return new IngestRecipesResult(false, processed, withPrecursors,
                sourceWcids.Count, resultWcids.Count, skillCounts, outputPath, ex.Message);
        }
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
                                // Assign terrain type based on height bands
                                byte terrainType;
                                if (heightByte < 10)       { terrainType = 0; waterVerts++; }   // Water
                                else if (heightByte < 25)  { terrainType = 3; sandVerts++; }    // Sand/Dirt
                                else if (heightByte < 80)  { terrainType = 1; grassVerts++; }   // Grass
                                else if (heightByte < 180) { terrainType = 2; rockVerts++; }    // Rock
                                else                       { terrainType = 8; snowVerts++; }    // Snow
                                types[idx] = terrainType;
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
                                    types[idx] = 2; // Rocky/cliff
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

                    // Assign terrain types based on height bands
                    for (int i = 0; i < 81; i++) {
                        byte h = heights[i];
                        byte terrainType;
                        if (h < 10)       { terrainType = 0; waterVerts++; }
                        else if (h < 25)  { terrainType = 3; sandVerts++; }
                        else if (h < 80)  { terrainType = 1; grassVerts++; }
                        else if (h < 180) { terrainType = 2; rockVerts++; }
                        else              { terrainType = 8; snowVerts++; }
                        types[i] = terrainType;
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
                                types[idx] = 2; // Rocky/cliff
                                cliffOverrides++;
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
            } catch { /* ignore placement errors */ }

            if ((i + 1 - segmentStart) >= SEGMENT_SIZE) {
                segmentSw.Stop();
                segmentTimes.Add(segmentSw.Elapsed.TotalMilliseconds);
                segmentStart = i + 1;
                segmentSw.Restart();
            }
        }
        sw.Stop();

        double objElapsed = sw.Elapsed.TotalMilliseconds;
        double objOpsPerSec = OBJECT_OPS / (objElapsed / 1000.0);
        double? objFirstSeg = segmentTimes.Count > 0 ? SEGMENT_SIZE / (segmentTimes[0] / 1000.0) : null;
        double? objLastSeg = segmentTimes.Count > 1 ? SEGMENT_SIZE / (segmentTimes[^1] / 1000.0) : null;
        double? objDeg = objFirstSeg.HasValue && objLastSeg.HasValue && objFirstSeg.Value > 0
            ? Math.Round(100.0 * (1.0 - objLastSeg.Value / objFirstSeg.Value), 1)
            : null;

        tests.Add(new BenchmarkSubTest("add-object", OBJECT_OPS, Math.Round(objElapsed, 1),
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
        const int BULK_OPS = 500;
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

            if ((i + 1 - segmentStart) >= SEGMENT_SIZE) {
                segmentSw.Stop();
                segmentTimes.Add(segmentSw.Elapsed.TotalMilliseconds);
                segmentStart = i + 1;
                segmentSw.Restart();
            }
        }
        sw.Stop();

        double bulkElapsed = sw.Elapsed.TotalMilliseconds;
        double bulkOpsPerSec = BULK_OPS / (bulkElapsed / 1000.0);
        double? bulkFirstSeg = segmentTimes.Count > 0 ? SEGMENT_SIZE / (segmentTimes[0] / 1000.0) : null;
        double? bulkLastSeg = segmentTimes.Count > 1 ? SEGMENT_SIZE / (segmentTimes[^1] / 1000.0) : null;
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

        return new BenchmarkResult(tests, memory, gcBefore, gcAfter, extrapolation);

        } finally {
            terrainDoc.BenchmarkMode = false;
        }
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

        int placed = 0;
        int errors = 0;
        var errorMsgs = new List<string>();

        foreach (var (modelId, x, y, z) in objects) {
            try {
                var obj = new StaticObject {
                    Id = modelId,
                    IsSetup = (modelId & 0x02000000) != 0,
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
                Console.WriteLine($"[AnalyzeLandblockPatterns] ...row {lbX}/{maxX}, {allObjects.Count} objects so far");
        }

        int totalObjects = allObjects.Count;
        Console.WriteLine($"[AnalyzeLandblockPatterns] Found {totalObjects} objects across {landblocksAnalyzed} populated landblocks");

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
        Console.WriteLine("[AnalyzeLandblockPatterns] Computing adjacency frequencies...");
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

        Console.WriteLine($"[AnalyzeLandblockPatterns] Found {adjacency.Count} unique adjacency pairs");

        // â”€â”€â”€ 2. Terrain slope under each object â”€â”€â”€
        Console.WriteLine("[AnalyzeLandblockPatterns] Computing terrain slope distribution...");
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

                // Compute slope as max height delta to any adjacent vertex
                float maxDelta = 0f;
                if (vx > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[(vx - 1) * 9 + vy].Height));
                if (vx < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[(vx + 1) * 9 + vy].Height));
                if (vy > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[vx * 9 + (vy - 1)].Height));
                if (vy < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[vx * 9 + (vy + 1)].Height));

                // Convert height delta to approximate slope angle
                // Each vertex is 24 world units apart; height table maps index to world height
                float heightDeltaWorld = maxDelta * 2f; // approximate: 2 world units per height index
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
        Console.WriteLine($"[AnalyzeLandblockPatterns] Slope: flat={slopeFlat} gentle={slopeGentle} moderate={slopeModerate} steep={slopeSteep}");

        // â”€â”€â”€ 3. Building orientation conventions â”€â”€â”€
        Console.WriteLine("[AnalyzeLandblockPatterns] Analyzing building orientations...");
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
        Console.WriteLine($"[AnalyzeLandblockPatterns] Orientation: N={orientN} E={orientE} S={orientS} W={orientW} dominant={dominantDir ?? "none"}");

        // â”€â”€â”€ 4. Object clustering analysis â”€â”€â”€
        Console.WriteLine("[AnalyzeLandblockPatterns] Computing object clusters...");
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
        Console.WriteLine($"[AnalyzeLandblockPatterns] Clusters: {totalClusters} total, avg size={avgClusterSize:F1}, largest={largestCluster}");

        // â”€â”€â”€ 5. Ontology cross-reference (if scanned) â”€â”€â”€
        // This enriches the adjacency pairs with ontology data (already done in step 1)
        // Additionally, compute per-category cluster statistics
        Dictionary<string, int>? categoryCounts = null;
        if (_ontologyService.IsScanned) {
            Console.WriteLine("[AnalyzeLandblockPatterns] Cross-referencing with ontology...");
            categoryCounts = new Dictionary<string, int>();
            foreach (var (_, _, objId, _) in allObjects) {
                var entry = _ontologyService.GetEntry(objId);
                string cat = entry?.Category ?? "Unknown";
                categoryCounts[cat] = categoryCounts.GetValueOrDefault(cat) + 1;
            }
        }

        sw.Stop();
        double elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Console.WriteLine($"[AnalyzeLandblockPatterns] Complete in {elapsedMs}ms");

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

                var jsonOpts = new System.Text.Json.JsonSerializerOptions {
                    WriteIndented = true,
                    PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase
                };
                var json = System.Text.Json.JsonSerializer.Serialize(outputData, jsonOpts);
                File.WriteAllText(outputPath, json);
                Console.WriteLine($"[AnalyzeLandblockPatterns] Results saved to: {outputPath}");
            } catch (Exception ex) {
                Console.WriteLine($"[AnalyzeLandblockPatterns] Warning: failed to write output file: {ex.Message}");
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
                Console.WriteLine($"[ExportTrainingData] ...row {lbX}/{maxX}, {allObjects.Count} objects so far");
        }

        int totalObjects = allObjects.Count;
        Console.WriteLine($"[ExportTrainingData] Found {totalObjects} objects across {landblocksProcessed} populated landblocks");

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
        var jsonOpts = new System.Text.Json.JsonSerializerOptions {
            PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false
        };

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
                                float maxDelta = 0f;
                                if (vx > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[(vx - 1) * 9 + vy].Height));
                                if (vx < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[(vx + 1) * 9 + vy].Height));
                                if (vy > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[vx * 9 + (vy - 1)].Height));
                                if (vy < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[vx * 9 + (vy + 1)].Height));

                                float heightDeltaWorld = maxDelta * 2f;
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

                    writer.WriteLine(System.Text.Json.JsonSerializer.Serialize(line, jsonOpts));
                    exported++;
                } catch (Exception ex) {
                    Console.WriteLine($"[ExportTrainingData] Warning: skipped object 0x{objectId:X8}: {ex.Message}");
                }

                if (exported > 0 && exported % 5000 == 0)
                    Console.WriteLine($"[ExportTrainingData] ...{exported}/{totalObjects} exported");
            }
        } catch (Exception ex) {
            sw.Stop();
            return new ExportTrainingDataResult(false, exported, landblocksProcessed, withOntology,
                Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath, ex.Message);
        }

        sw.Stop();
        double elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Console.WriteLine($"[ExportTrainingData] Complete: {exported} examples exported in {elapsedMs}ms â†’ {outputPath}");

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

        var jsonOpts = new System.Text.Json.JsonSerializerOptions {
            PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false
        };

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
                            jsonOpts));
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
                            jsonOpts));
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

        var jsonOpts = new System.Text.Json.JsonSerializerOptions {
            PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false
        };

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
                        float maxDelta = 0f;
                        if (vx > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[(vx - 1) * 9 + vy].Height));
                        if (vx < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[(vx + 1) * 9 + vy].Height));
                        if (vy > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[vx * 9 + (vy - 1)].Height));
                        if (vy < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[vx * 9 + (vy + 1)].Height));
                        float heightDeltaWorld = maxDelta * 2f;
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
                }, jsonOpts));
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

        Console.WriteLine($"[GenerateSettlement] Template: {template.Name} â€” {template.Description}");
        Console.WriteLine($"[GenerateSettlement] Center: ({centerX}, {centerY})  Layout: {template.LayoutPattern}");

        var rng = seed != 0 ? new Random(seed) : new Random();

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
            // Approximate biome from terrain type:
            // 0=Road, 1=Grass, 2=Rock, 3=Dirt/Sand, 4=Desert, 5=Snow, 6=Ice, ...
            string inferredBiome = terrainTypeAtCenter.Value switch {
                0 => "temperate",
                1 => "temperate",
                2 => "rock",
                3 => "desert",
                4 => "desert",
                5 or 6 => "snow",
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
                        Console.WriteLine($"[GenerateSettlement]   Rejected {rejected} objects from {slot.Category} " +
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
        Console.WriteLine($"[GenerateSettlement] Computing {template.LayoutPattern} layout positions...");

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
        Console.WriteLine($"[GenerateSettlement] Placing {totalToPlace} objects...");

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
        int steepPlacements = 0;
        foreach (var po in placedObjects) {
            try {
                var vi = _terrainService.WorldToVertex(po.X, po.Y);
                if (vi.HasValue) {
                    var data = terrainDoc.GetLandblockInternal(vi.Value.LandblockKey);
                    if (data != null) {
                        int vIdx = vi.Value.VertexIndex;
                        int vx = vIdx / 9, vy = vIdx % 9;
                        byte hCenter = data[vIdx].Height;
                        float maxDelta = 0f;
                        if (vx > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[(vx - 1) * 9 + vy].Height));
                        if (vx < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[(vx + 1) * 9 + vy].Height));
                        if (vy > 0) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[vx * 9 + (vy - 1)].Height));
                        if (vy < 8) maxDelta = MathF.Max(maxDelta, MathF.Abs(hCenter - data[vx * 9 + (vy + 1)].Height));
                        float slopeDeg = MathF.Atan2(maxDelta * 2f, 24f) * (180f / MathF.PI);
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
        Console.WriteLine($"[GenerateSettlement] Complete: {placedObjects.Count} objects placed, " +
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

        var jsonOpts = new System.Text.Json.JsonSerializerOptions {
            PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false
        };

        try {
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

                    writer.WriteLine(System.Text.Json.JsonSerializer.Serialize(line, jsonOpts));
                    populated++;
                }

                if (lbX % 50 == 0 && lbX > 0)
                    Console.WriteLine($"[ExtractRetailHeightmaps] ...row {lbX}/254, {populated} landblocks exported");
            }
        } catch (Exception ex) {
            sw.Stop();
            return new ExtractHeightmapsResult(false, totalScanned, populated,
                Math.Round(sw.Elapsed.TotalMilliseconds, 1), outputPath, ex.Message);
        }

        sw.Stop();
        double elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Console.WriteLine($"[ExtractRetailHeightmaps] Complete: {populated} landblocks exported in {elapsedMs}ms â†’ {outputPath}");

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
                Console.WriteLine($"[ComputeVanillaBaseline] ...row {lbX}/254, {populatedLandblocks} populated, {totalObjects} objects");
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
            var jsonOpts = new System.Text.Json.JsonSerializerOptions {
                PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
                WriteIndented = true
            };
            var json = System.Text.Json.JsonSerializer.Serialize(baseline, jsonOpts);

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
        Console.WriteLine($"[ComputeVanillaBaseline] Complete: {populatedLandblocks} populated landblocks, " +
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

            var jsonOpts = new System.Text.Json.JsonSerializerOptions {
                PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
                WriteIndented = true
            };

            var dir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);

            var json = System.Text.Json.JsonSerializer.Serialize(codebook, jsonOpts);
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
        int seed = 0) {
        RequireProject();
        var sw = new System.Diagnostics.Stopwatch();
        sw.Start();

        var rng = seed != 0 ? new Random(seed) : new Random();

        // â”€â”€â”€ 1. Load codebook (terrain_codebook.json) â”€â”€â”€
        Console.WriteLine($"[QuickWorld] Loading codebook: {biomeMapPath}");
        if (!File.Exists(biomeMapPath)) {
            sw.Stop();
            return new QuickWorldResult(false, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                $"Codebook not found: {biomeMapPath}");
        }

        // Parse the codebook: extract base colors and height percentiles
        var terrainBaseColors = new List<(int typeIndex, string name, int r, int g, int b)>();
        var heightPercentiles = new Dictionary<int, byte[]>(); // typeIndex â†’ 101-entry percentile array
        var heightMinMax = new Dictionary<int, (byte min, byte max)>(); // typeIndex â†’ (min, max) height

        try {
            var jsonText = File.ReadAllText(biomeMapPath);
            using var jsonDoc = System.Text.Json.JsonDocument.Parse(jsonText);
            var root = jsonDoc.RootElement;

            // Parse terrainBaseColors
            if (root.TryGetProperty("terrainBaseColors", out var colorsArray)) {
                foreach (var c in colorsArray.EnumerateArray()) {
                    int ti = c.GetProperty("typeIndex").GetInt32();
                    if (ti < byte.MinValue || ti > byte.MaxValue) {
                        Console.WriteLine($"[QuickWorld] Warning: skipping terrain type {ti} (outside byte range 0-255)");
                        continue;
                    }
                    string tn = c.GetProperty("typeName").GetString() ?? $"Type{ti}";
                    int r = c.GetProperty("baseR").GetInt32();
                    int g = c.GetProperty("baseG").GetInt32();
                    int b = c.GetProperty("baseB").GetInt32();
                    terrainBaseColors.Add((ti, tn, r, g, b));
                }
            }

            // Parse heightDistributions
            if (root.TryGetProperty("heightDistributions", out var distArray)) {
                foreach (var d in distArray.EnumerateArray()) {
                    int ti = d.GetProperty("typeIndex").GetInt32();
                    var data = d.GetProperty("data");
                    byte min = data.GetProperty("min").GetByte();
                    byte max = data.GetProperty("max").GetByte();
                    heightMinMax[ti] = (min, max);

                    if (data.TryGetProperty("percentiles", out var pArr)) {
                        if (pArr.ValueKind == System.Text.Json.JsonValueKind.String) {
                            // Base64-encoded byte array
                            var base64 = pArr.GetString()!;
                            heightPercentiles[ti] = Convert.FromBase64String(base64);
                        } else if (pArr.ValueKind == System.Text.Json.JsonValueKind.Array) {
                            var pList = new List<byte>();
                            foreach (var p in pArr.EnumerateArray())
                                pList.Add(p.GetByte());
                            heightPercentiles[ti] = pList.ToArray();
                        }
                    }
                }
            }
        } catch (Exception ex) {
            sw.Stop();
            return new QuickWorldResult(false, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                $"Failed to parse codebook: {ex.Message}");
        }

        if (terrainBaseColors.Count == 0) {
            sw.Stop();
            return new QuickWorldResult(false, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                "Codebook contains no terrain base colors");
        }

        Console.WriteLine($"[QuickWorld] Codebook: {terrainBaseColors.Count} terrain types, " +
                          $"{heightPercentiles.Count} height distributions");

        byte EstimateHeightFromCodebook(int terrainType, double brightness01) {
            int noise = rng.Next(-2, 3);

            if (heightPercentiles.TryGetValue(terrainType, out var pArr) && pArr.Length > 0) {
                int pIdx = pArr.Length == 101
                    ? Math.Clamp((int)Math.Round(brightness01 * 100.0), 0, 100)
                    : Math.Clamp((int)Math.Round(brightness01 * (pArr.Length - 1)), 0, pArr.Length - 1);
                int sampled = pArr[pIdx];
                return (byte)Math.Clamp(sampled + noise, 0, 255);
            }

            if (heightMinMax.TryGetValue(terrainType, out var minMax)) {
                int span = minMax.max - minMax.min;
                int baseH = minMax.min + (int)Math.Round(brightness01 * span);
                return (byte)Math.Clamp(baseH + noise, 0, 255);
            }

            int fallback = (int)Math.Round(brightness01 * 255.0);
            return (byte)Math.Clamp(fallback + noise, 0, 255);
        }

        // â”€â”€â”€ 2. Load world map image â”€â”€â”€
        Console.WriteLine($"[QuickWorld] Loading world map image: {worldMapImagePath}");
        if (!File.Exists(worldMapImagePath)) {
            sw.Stop();
            return new QuickWorldResult(false, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                $"World map image not found: {worldMapImagePath}");
        }

        SkiaSharp.SKBitmap? bitmap;
        int imgW, imgH;
        try {
            var imgData = SkiaSharp.SKData.Create(worldMapImagePath);
            bitmap = SkiaSharp.SKBitmap.Decode(imgData);
            if (bitmap == null) throw new Exception("Failed to decode image");
            imgW = bitmap.Width;
            imgH = bitmap.Height;
        } catch (Exception ex) {
            sw.Stop();
            return new QuickWorldResult(false, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                $"Failed to load image: {ex.Message}");
        }

        // The AC world map is 2041 pixels (255*8+1) â€” one pixel per terrain vertex.
        // Scale factor for non-standard image sizes:
        const int VERTEX_GRID = 2041; // 255 landblocks Ã— 8 cells + 1 edge pixel
        double scaleX = (double)imgW / VERTEX_GRID;
        double scaleY = (double)imgH / VERTEX_GRID;
        bool isExact = (imgW == VERTEX_GRID && imgH == VERTEX_GRID);

        Console.WriteLine($"[QuickWorld] Image: {imgW}Ã—{imgH}, scale: {scaleX:F3}Ã—{scaleY:F3}" +
                          (isExact ? " (exact vertex resolution)" : " (scaled)"));

        // â”€â”€â”€ 3. Stamp each landblock (in-memory pass) â”€â”€â”€
        Console.WriteLine($"[QuickWorld] Phase 1: Computing terrain for 255Ã—255 landblocks in memory...");

        var terrainDoc = GetTerrainDoc();
        int stamped = 0;
        int skipped = 0;
        int objectsPlaced = 0;
        int approximateMatches = 0;
        var terrainTypesCounted = new Dictionary<string, int>();

        // Pre-compute base color array for fast nearest-color search
        var baseColorArr = terrainBaseColors.ToArray();
        var classificationColors = baseColorArr.Where(c => c.typeIndex != 32).ToArray();
        if (classificationColors.Length == 0) {
            sw.Stop();
            return new QuickWorldResult(false, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                "Codebook contains no usable terrain colors (all entries are excluded type 32)");
        }

        // Collect ALL changes in memory before writing to avoid per-landblock I/O
        var allChanges = new Dictionary<ushort, Dictionary<byte, uint>>();
        // Also track new entries per-landblock for scenery placement later
        var newEntriesMap = new Dictionary<ushort, TerrainEntry[]>();
        // Track dominant types per landblock for scenery
        var dominantTypes = new Dictionary<ushort, int>();

        for (int lbX = 0; lbX < 255; lbX++) {
            for (int lbY = 0; lbY < 255; lbY++) {
                try {
                    ushort lbKey = LbKey((uint)lbX, (uint)lbY);
                    var currentData = terrainDoc.GetLandblockInternal(lbKey);
                    if (currentData == null) {
                        skipped++;
                        continue;
                    }

                    var newEntries = new TerrainEntry[81];

                    // â”€â”€â”€ Per-vertex terrain reconstruction â”€â”€â”€
                    int dominantType = -1;
                    var typeCounts = new Dictionary<int, int>();

                    for (int vx = 0; vx < 9; vx++) {
                        for (int vy = 0; vy < 9; vy++) {
                            int vi = vx * 9 + vy;

                            // Map vertex to pixel coordinate
                            int pixX, pixY;
                            if (isExact) {
                                pixX = lbX * 8 + vx;
                                pixY = VERTEX_GRID - 1 - (lbY * 8 + vy);
                            } else {
                                pixX = (int)Math.Round((lbX * 8 + vx) * scaleX);
                                pixY = (int)Math.Round((VERTEX_GRID - 1 - (lbY * 8 + vy)) * scaleY);
                            }

                            pixX = Math.Clamp(pixX, 0, imgW - 1);
                            pixY = Math.Clamp(pixY, 0, imgH - 1);

                            var pixel = bitmap.GetPixel(pixX, pixY);
                            int pr = pixel.Red, pg = pixel.Green, pb = pixel.Blue;

                            // â”€â”€ Classify terrain type: nearest RGB distance â”€â”€
                            int bestType = classificationColors[0].typeIndex;
                            double bestDist = double.MaxValue;

                            for (int t = 0; t < classificationColors.Length; t++) {
                                double dr = pr - classificationColors[t].r;
                                double dg = pg - classificationColors[t].g;
                                double db = pb - classificationColors[t].b;
                                double dist = dr * dr + dg * dg + db * db;

                                if (dist < bestDist) {
                                    bestDist = dist;
                                    bestType = classificationColors[t].typeIndex;
                                }
                            }

                            if (bestDist > 2500)
                                approximateMatches++;

                            typeCounts.TryGetValue(bestType, out var tc);
                            typeCounts[bestType] = tc + 1;

                            // â”€â”€ Estimate height from brightness â”€â”€
                            // Prefer terrain-specific codebook distributions (percentiles/min-max),
                            // fall back to linear mapping if distribution data is unavailable.
                            double brightness = (pr + pg + pb) / (3.0 * 255.0);
                            byte heightIdx = EstimateHeightFromCodebook(bestType, brightness);

                            newEntries[vi] = currentData[vi] with {
                                Height = heightIdx,
                                Type = (byte)bestType
                            };
                        }
                    }

                    // Collect changes for this landblock (diff against current)
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
                    stamped++;

                    // Track dominant terrain type
                    int maxCount = 0;
                    dominantType = 0;
                    foreach (var (tt, cnt) in typeCounts) {
                        if (cnt > maxCount) { maxCount = cnt; dominantType = tt; }
                    }
                    dominantTypes[lbKey] = dominantType;
                    string typeName = baseColorArr.FirstOrDefault(bc => bc.typeIndex == dominantType).name ?? $"Type{dominantType}";
                    terrainTypesCounted.TryGetValue(typeName, out var existing);
                    terrainTypesCounted[typeName] = existing + 1;

                } catch (Exception ex) {
                    skipped++;
                    if (skipped <= 5)
                        Console.WriteLine($"[QuickWorld] Warning: ({lbX},{lbY}) skipped: {ex.Message}");
                }
            }

            if (lbX % 20 == 0 && lbX > 0)
                Console.WriteLine($"[QuickWorld] ...computed row {lbX}/254, {stamped} landblocks, " +
                                  $"{approximateMatches} approximate matches");
        }

        bitmap?.Dispose();

        Console.WriteLine($"[QuickWorld] Phase 1 complete: {allChanges.Count} landblocks with changes computed in memory.");

        // â”€â”€â”€ 4. Bulk-write all terrain changes at once â”€â”€â”€
        Console.WriteLine($"[QuickWorld] Phase 2: Writing {allChanges.Count} landblocks to terrain document (single batch)...");
        terrainDoc.UpdateLandblocksBatchInternal(allChanges, out _);
        Console.WriteLine($"[QuickWorld] Phase 2 complete: terrain written.");

        // â”€â”€â”€ 5. Scatter scenery objects â”€â”€â”€
        Console.WriteLine($"[QuickWorld] Phase 3: Scattering scenery objects...");
        var sceneryByType = new Dictionary<int, uint[]> {
            [0x03] = new uint[] { 0x02000B53, 0x02000B57, 0x02000BE0, 0x02000BDE, 0x02000B5B }, // LushGrass
            [0x01] = new uint[] { 0x02000B53, 0x02000B5B, 0x02000BD7, 0x02000BD8 },              // Grassland
            [0x0E] = new uint[] { 0x02000B95, 0x02000B97, 0x02000B99 },                           // SemiBarrenRock
            [0x00] = new uint[] { 0x02000B95, 0x02000B97 },                                       // BarrenRock
            [0x0A] = new uint[] { 0x02000B95, 0x02000BD7 },                                       // SandYellow
            [0x0F] = new uint[] { 0x02000BDE, 0x02000B95 },                                       // Snow
            [0x04] = new uint[] { 0x02000B53, 0x02000BD7 },                                       // MarshSparseSwamp
            [0x06] = new uint[] { 0x02000B95, 0x02000B97 },                                       // ObsidianPlain
        };

        foreach (var (lbKey, entries) in newEntriesMap) {
            if (!dominantTypes.TryGetValue(lbKey, out var domType)) continue;
            if (!sceneryByType.TryGetValue(domType, out var models) || models.Length == 0) continue;

            int lbX = (lbKey >> 8) & 0xFF;
            int lbY = lbKey & 0xFF;

            try {
                int numScenery = rng.Next(1, 5);
                float worldMinX = lbX * 192f;
                float worldMinY = lbY * 192f;

                var lbDoc = GetLandblockDoc(lbKey);
                for (int s = 0; s < numScenery; s++) {
                    uint modelId = models[rng.Next(models.Length)];
                    float ox = worldMinX + 24f + (float)rng.NextDouble() * 144f;
                    float oy = worldMinY + 24f + (float)rng.NextDouble() * 144f;

                    int gx = Math.Clamp((int)((ox - worldMinX) / 24f), 0, 8);
                    int gy = Math.Clamp((int)((oy - worldMinY) / 24f), 0, 8);
                    int vi = gx * 9 + gy;
                    float z = GetHeightTable()[entries[vi].Height];

                    var obj = new StaticObject {
                        Id = modelId,
                        IsSetup = (modelId & 0x02000000) != 0,
                        Origin = new Vector3(ox, oy, z),
                        Orientation = Quaternion.CreateFromAxisAngle(
                            Vector3.UnitZ, (float)(rng.NextDouble() * Math.PI * 2)),
                        Scale = Vector3.One
                    };
                    lbDoc.AddStaticObject(obj);
                    objectsPlaced++;
                }
            } catch { /* non-fatal */ }
        }

        sw.Stop();
        double elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Console.WriteLine($"[QuickWorld] Complete: {stamped} stamped, " +
                          $"{skipped} skipped, {objectsPlaced} objects, " +
                          $"{approximateMatches} approximate color matches, {elapsedMs}ms");

        return new QuickWorldResult(true, stamped, skipped, objectsPlaced,
            0, terrainTypesCounted, elapsedMs);
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

        SkiaSharp.SKBitmap? bitmap;
        try {
            var data = SkiaSharp.SKData.Create(imagePath);
            bitmap = SkiaSharp.SKBitmap.Decode(data);
            if (bitmap == null) throw new Exception("Failed to decode image");
        } catch (Exception ex) {
            sw.Stop();
            return new AnalyzeMapImageResult(false, 0, 0, 0, 0,
                new Dictionary<string, int>(), Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                outputPath, $"Failed to load image: {ex.Message}");
        }

        Console.WriteLine($"[AnalyzeMapImage] Loaded image: {bitmap.Width}Ã—{bitmap.Height}");

        // The Mapper creates images at LANDSIZE = 255*8+1 = 2041 pixels.
        // But the screenshot may be at a different resolution (e.g., 1280x720 with auto-scaling).
        // We need to handle arbitrary image sizes by scaling pixel coordinates.
        int imgW = bitmap.Width;
        int imgH = bitmap.Height;

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
                    for (int dy = 0; dy < sampleSize && pixStartY + dy < imgH; dy++) {
                        var pixel = bitmap.GetPixel(pixStartX + dx, pixStartY + dy);
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

        bitmap.Dispose();

        // â”€â”€â”€ 4. Write output JSON â”€â”€â”€
        Console.WriteLine($"[AnalyzeMapImage] Classification complete. Building output...");

        try {
            var jsonOpts = new System.Text.Json.JsonSerializerOptions {
                PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
                WriteIndented = true
            };

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

            var json = System.Text.Json.JsonSerializer.Serialize(output, jsonOpts);
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

            const float maxBuildingBurialMeters = 0.1f;
            const float maxBuildingFloatMeters = 1.0f;
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

                // 3a. Copy objects (stabs).
                foreach (var obj in oldLbi.Objects) {
                    float worldX = newLbX * 192f + obj.Frame.Origin.X;
                    float worldY = newLbY * 192f + obj.Frame.Origin.Y;
                    var placement = ComputePlacementDeltaDetailed(oldLbKey, newLbKey, obj.Frame.Origin.X, obj.Frame.Origin.Y, fallbackDeltaZ);
                    float sourceGroundZ = placement.sourceGroundZ ?? (obj.Frame.Origin.Z - fallbackDeltaZ);
                    float sourceOriginToGroundOffset = obj.Frame.Origin.Z - sourceGroundZ;
                    float retainedOriginToGroundOffset = preserveRetailZProfile
                        ? sourceOriginToGroundOffset
                        : Math.Clamp(sourceOriginToGroundOffset, -3f, 4f);
                    float targetGroundZ = placement.destinationGroundZ ?? (sourceGroundZ + fallbackDeltaZ);
                    float newZ = targetGroundZ + retainedOriginToGroundOffset;
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

                // 3b. Copy buildings (shells; interiors handled later via blueprint export).
                for (int bIdx = 0; bIdx < oldLbi.Buildings.Count; bIdx++) {
                    var building = oldLbi.Buildings[bIdx];

                    float worldX = newLbX * 192f + building.Frame.Origin.X;
                    float worldY = newLbY * 192f + building.Frame.Origin.Y;
                    var placement = ComputePlacementDeltaDetailed(oldLbKey, newLbKey, building.Frame.Origin.X, building.Frame.Origin.Y, fallbackDeltaZ);
                    float sourceGroundZ = placement.sourceGroundZ ?? (building.Frame.Origin.Z - fallbackDeltaZ);
                    float sourceOriginToGroundOffset = building.Frame.Origin.Z - sourceGroundZ;
                    float retainedOriginToGroundOffset = preserveRetailZProfile
                        ? sourceOriginToGroundOffset
                        : Math.Clamp(sourceOriginToGroundOffset, -maxBuildingBurialMeters, maxBuildingFloatMeters);
                    float targetGroundZ = placement.destinationGroundZ ?? (sourceGroundZ + fallbackDeltaZ);
                    float newZ = targetGroundZ + retainedOriginToGroundOffset;
                    float placedZ = flattenTerrain ? heightTable[FindClosestHeightIdx(newZ)] : newZ;

                    if (!preserveRetailZProfile &&
                        Math.Abs(retainedOriginToGroundOffset - sourceOriginToGroundOffset) > 0.01f) {
                        warnings.Add(
                            $"Building 0x{building.ModelId:X8} in LB 0x{newLbKey:X4}: clamped retail ground offset " +
                            $"from {sourceOriginToGroundOffset:F2}m to {retainedOriginToGroundOffset:F2}m");
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
                    // Prime donor-specific blueprint cache from base DATs before export mutates donor landblocks.
                    _ = BuildingBlueprintCache.GetBlueprintFromDonor(
                        building.ModelId, oldLbKey, bIdx, dats);

                    // Flatten terrain to estimated ground level, not model-origin Z.
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
                        destinationLocalOrigin = new {
                            x = destinationLocalOrigin.X,
                            y = destinationLocalOrigin.Y,
                            z = destinationLocalOrigin.Z
                        },
                        oldCells = oldCellIds.OrderBy(c => c).ToArray()
                    };

                    buildingShellsCopied++;
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
                    new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
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
    }

    internal static ushort LbKey(uint lbX, uint lbY) => (ushort)((lbX << 8) | lbY);

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
        } else {
            _heightTableCache = new float[256];
            for (int i = 0; i < 256; i++) _heightTableCache[i] = i * 2f;
        }
        return _heightTableCache;
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

    private LandblockDocument GetLandblockDoc(ushort lbKey) {
        var docId = $"landblock_{lbKey:X4}";
        var doc = _projectManager.CurrentProject!.DocumentManager
            .GetOrCreateDocumentAsync<LandblockDocument>(docId)
            .GetAwaiter().GetResult();
        return doc ?? throw new InvalidOperationException($"Could not load landblock 0x{lbKey:X4}.");
    }

    private DungeonDocument? GetDungeonDoc(ushort lbKey) {
        var docId = $"dungeon_{lbKey:X4}";
        return _projectManager.CurrentProject!.DocumentManager
            .GetOrCreateDocumentAsync<DungeonDocument>(docId)
            .GetAwaiter().GetResult();
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
}
