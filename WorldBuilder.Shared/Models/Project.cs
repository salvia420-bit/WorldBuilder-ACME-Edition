using System.Collections.ObjectModel;
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml.Linq;
using CommunityToolkit.Mvvm.ComponentModel;
using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Options;
using Microsoft.Data.Sqlite;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.AceDb;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Shared.Models {
    public partial class Project : ObservableObject, IDisposable {
        private static JsonSerializerOptions _opts = new JsonSerializerOptions { WriteIndented = true };
        private string _filePath = string.Empty;

        [ObservableProperty] private string _name = string.Empty;

        [ObservableProperty] private Guid _guid;

        [ObservableProperty] private bool _isHosting = false;

        [ObservableProperty] private string _remoteUrl = string.Empty;

        public string ProjectDirectory => Path.GetDirectoryName(FilePath) ?? string.Empty;
        public string DatDirectory => Path.Combine(ProjectDirectory, "dats");
        public string BaseDatDirectory => Path.Combine(DatDirectory, "base");
        public string DatabasePath => Path.Combine(ProjectDirectory, "project.db");

        [JsonIgnore] public string FilePath { get => _filePath; set => SetProperty(ref _filePath, value); }

        [JsonIgnore] public DocumentManager DocumentManager { get; set; }

        [JsonIgnore] public IDatReaderWriter DatReaderWriter { get; set; }

        [JsonIgnore] public CustomTextureStore CustomTextures { get; private set; }

        public static Project? FromDisk(string projectFilePath) {
            if (!File.Exists(projectFilePath)) {
                return null;
            }

            var project = JsonSerializer.Deserialize<Project>(File.ReadAllText(projectFilePath), _opts);
            if (project != null) {
                project.FilePath = projectFilePath;
                project.InitializeDatReaderWriter();
            }

            return project;
        }

        public static Project? Create(string projectName, string projectFilePath, string baseDatDirectory) {
            var projectDir = Path.GetDirectoryName(projectFilePath);
            if (!Directory.Exists(projectDir)) {
                Directory.CreateDirectory(projectDir);
            }

            var datDir = Path.Combine(projectDir, "dats");
            var baseDatDir = Path.Combine(datDir, "base");

            if (!Directory.Exists(baseDatDir)) {
                Directory.CreateDirectory(baseDatDir);
            }

            // Copy base dat files
            var datFiles = new[] {
                "client_cell_1.dat", "client_portal.dat", "client_highres.dat", "client_local_English.dat"
            };


            if (Directory.Exists(baseDatDirectory)) {
                foreach (var datFile in datFiles) {
                    var sourcePath = Path.Combine(baseDatDirectory, datFile);
                    var destPath = Path.Combine(baseDatDir, datFile);

                    if (File.Exists(sourcePath)) {
                        File.Copy(sourcePath, destPath, true);
                    }
                }
            }

            var project = new Project() { Name = projectName, FilePath = projectFilePath, Guid = Guid.NewGuid() };

            project.InitializeDatReaderWriter();
            project.Save();
            return project;
        }

        public Project() {
        }

        private void InitializeDatReaderWriter() {
            if (Directory.Exists(BaseDatDirectory)) {
                DatReaderWriter = new DefaultDatReaderWriter(BaseDatDirectory, DatAccessType.Read);
            }
            else {
                throw new DirectoryNotFoundException($"Base dat directory not found: {BaseDatDirectory}");
            }
            CustomTextures = new CustomTextureStore(ProjectDirectory);
        }

        /// <summary>
        /// Recreates read-only DAT handles after another process (or a short-lived ReadWrite connection)
        /// wrote new portal files — e.g. OBJ import into <c>client_portal.dat</c>.
        /// </summary>
        public void ReloadDatReadersAfterExternalWrite() {
            var oldProj = DatReaderWriter;
            var oldDoc = DocumentManager?.Dats;
            var fresh = new DefaultDatReaderWriter(BaseDatDirectory, DatAccessType.Read);
            DatReaderWriter = fresh;
            if (DocumentManager != null)
                DocumentManager.Dats = fresh;
            if (!ReferenceEquals(oldProj, oldDoc)) {
                oldProj?.Dispose();
                oldDoc?.Dispose();
            }
            else {
                oldProj?.Dispose();
            }
        }

        public void Save() {
            var tmp = Path.GetTempFileName();
            try {
                File.WriteAllText(tmp, JsonSerializer.Serialize(this, _opts));
                File.Move(tmp, FilePath, overwrite: true);
            }
            finally {
                if (File.Exists(tmp)) {
                    File.Delete(tmp);
                }
            }
        }

        /// <summary>
        /// ACE database connection settings for instance repositioning on export.
        /// Persisted per-project in the project JSON.
        /// </summary>
        public AceDbSettings? AceDb { get; set; }

        /// <summary>
        /// E1 (wave-2) PR3 — ACE SHARD database connection (separate from <see cref="AceDb"/>, which
        /// is WORLD-only). Required for the Option B per-placement biota override apply path
        /// (<c>biota</c> + <c>biota_properties_*</c> rows live in the shard DB, SPEC §2.3 / open
        /// question 1). Null until configured; Option B <c>--apply</c> blocks rather than silently
        /// writing biota rows to the world DB (HARD CONSTRAINT 3). Persisted per-project.
        /// </summary>
        public AceDbSettings? AceShardDb { get; set; }

        /// <summary>
        /// Outdoor landblock instance placements (generators/items/portals) added from the Terrain editor.
        /// Exported to landblock_instances.sql when ACE DB is configured.
        /// </summary>
        public List<OutdoorInstancePlacement> OutdoorInstancePlacements { get; set; } = new();

        /// <summary>
        /// Called during export to write custom textures and update Region.
        /// Set by the UI layer (TextureImportService) since image decoding requires platform deps.
        /// </summary>
        [JsonIgnore]
        public Action<IDatReaderWriter, int?>? OnExportCustomTextures { get; set; }

        /// <summary>
        /// Called after DAT export with terrain change context so the UI layer can
        /// run the instance reposition workflow asynchronously.
        /// </summary>
        [JsonIgnore]
        public Func<RepositionContext, Task>? OnExportReposition { get; set; }

        /// <summary>
        /// Called after dungeon DAT export with any dungeon documents that have
        /// InstancePlacements (generators/items/portals for ACE landblock_instance).
        /// The UI layer can generate SQL and write dungeon_instances.sql (and optionally apply).
        /// </summary>
        [JsonIgnore]
        public Action<string, IReadOnlyList<DungeonDocument>>? OnExportDungeonInstances { get; set; }

        public ExportDatsResult ExportDats(string exportDirectory, int portalIteration, Action<string>? onProgress = null) {
            // Failure counters — every sub-save (terrain TrySave + per-document SaveToDats) is
            // checked so the caller can distinguish a clean export from a partial one. See
            // ExportDatsResult; the method returns Success=false when ANY write failed.
            int terrainSaveFailures = 0;
            int docSaveFailures = 0;
            int docsSaved = 0;

            if (!Directory.Exists(exportDirectory)) {
                Directory.CreateDirectory(exportDirectory);
            }

            // Copy base dats from project's base directory
            var datFiles = new[] {
                "client_cell_1.dat", "client_portal.dat", "client_highres.dat", "client_local_English.dat"
            };

            onProgress?.Invoke("Copying base DAT files...");
            foreach (var datFile in datFiles) {
                var sourcePath = Path.Combine(BaseDatDirectory, datFile);
                var destPath = Path.Combine(exportDirectory, datFile);

                if (File.Exists(sourcePath)) {
                    File.Copy(sourcePath, destPath, true);
                }
            }

            // Patch DAT headers to prevent Chorizite's block allocator from
            // reusing in-use blocks (retail DATs use a linked-list free chain
            // but Chorizite assumes contiguous allocation). See DatExportFixer.
            onProgress?.Invoke("Patching DAT free block headers...");
            foreach (var datFile in datFiles) {
                var destPath = Path.Combine(exportDirectory, datFile);
                DatExportFixer.PatchFreeBlocksBeforeExport(destPath);
            }

            var writer = new DefaultDatReaderWriter(exportDirectory, DatAccessType.ReadWrite);

            if (portalIteration == DatReaderWriter.Dats.Portal.Iteration.CurrentIteration) {
                portalIteration = 0;
            }

            var terrainDoc = DocumentManager.GetOrCreateDocumentAsync<TerrainDocument>("terrain").Result;

            // Collect all layers that are marked for export
            var exportLayers = new List<TerrainLayer>();
            if (terrainDoc.TerrainData.RootItems != null) {
                CollectExportLayers(terrainDoc.TerrainData.RootItems, exportLayers);
            }

            // No reverse -- iterate top-to-bottom for first-non-null per field
            // (CollectExportLayers already returns in tree order = top-to-bottom)

            // Identify all landblocks that need to be saved (modified in base OR any export layer)
            var modifiedLandblocks = new HashSet<ushort>(terrainDoc.TerrainData.Landblocks.Keys);
            var layerDocs = new Dictionary<string, LayerDocument>();

            foreach (var layer in exportLayers) {
                var layerDoc = DocumentManager.GetOrCreateDocumentAsync<LayerDocument>(layer.DocumentId).Result;
                if (layerDoc != null) {
                    layerDocs[layer.DocumentId] = layerDoc;
                    foreach (var lbKey in layerDoc.TerrainData.Landblocks.Keys) {
                        modifiedLandblocks.Add(lbKey);
                    }
                }
            }

            const int LANDBLOCK_SIZE = 81;

            onProgress?.Invoke($"Preparing {modifiedLandblocks.Count} terrain landblocks...");

            // Capture old terrain from base DATs for reposition delta calculation
            var oldTerrain = new Dictionary<ushort, TerrainEntry[]>();
            var newTerrain = new Dictionary<ushort, TerrainEntry[]>();

            foreach (var lbKey in modifiedLandblocks) {
                var baseLbId = (uint)(lbKey << 16) | 0xFFFF;
                if (DatReaderWriter.TryGet<LandBlock>(baseLbId, out var baseLb)) {
                    var entries = new TerrainEntry[LANDBLOCK_SIZE];
                    for (int i = 0; i < LANDBLOCK_SIZE; i++) {
                        entries[i] = new TerrainEntry(
                            baseLb.Terrain[i].Road,
                            baseLb.Terrain[i].Scenery,
                            (byte)baseLb.Terrain[i].Type,
                            baseLb.Height[i]);
                    }
                    oldTerrain[lbKey] = entries;
                }
            }

            // Process and save each modified landblock
            int terrainWritten = 0;
            foreach (var lbKey in modifiedLandblocks) {
                if (++terrainWritten % 1000 == 0) {
                    onProgress?.Invoke($"Writing terrain {terrainWritten} / {modifiedLandblocks.Count}...");
                }
                var lbId = (uint)(lbKey << 16) | 0xFFFF;

                var currentEntries = terrainDoc.GetLandblockInternal(lbKey);
                if (currentEntries == null) {
                    continue;
                }

                // Apply changes from each export layer using per-field masks (top-to-bottom)
                var resolved = new byte[LANDBLOCK_SIZE];
                foreach (var layer in exportLayers) {
                    if (!layerDocs.TryGetValue(layer.DocumentId, out var layerDoc)) continue;
                    if (!layerDoc.TerrainData.Landblocks.TryGetValue(lbKey, out var sparseCells)) continue;
                    layerDoc.TerrainData.FieldMasks.TryGetValue(lbKey, out var sparseMasks);

                    foreach (var (cellIdx, cellValue) in sparseCells) {
                        // Determine which fields this layer claims for this cell
                        byte layerMask = (sparseMasks != null && sparseMasks.TryGetValue(cellIdx, out var m))
                            ? m
                            : TerrainFieldMask.All; // No mask = legacy data

                        byte unclaimed = (byte)(layerMask & ~resolved[cellIdx]);
                        if (unclaimed == 0) continue;

                        var entry = new TerrainEntry(cellValue);
                        var current = currentEntries[cellIdx];

                        currentEntries[cellIdx] = new TerrainEntry(
                            road:    (unclaimed & TerrainFieldMask.Road) != 0    ? entry.Road    : current.Road,
                            scenery: (unclaimed & TerrainFieldMask.Scenery) != 0 ? entry.Scenery : current.Scenery,
                            type:    (unclaimed & TerrainFieldMask.Type) != 0    ? entry.Type    : current.Type,
                            height:  (unclaimed & TerrainFieldMask.Height) != 0  ? entry.Height  : current.Height
                        );

                        resolved[cellIdx] |= unclaimed;
                    }
                }

                // Snapshot the composited terrain for reposition
                var snapshot = new TerrainEntry[LANDBLOCK_SIZE];
                Array.Copy(currentEntries, snapshot, LANDBLOCK_SIZE);
                newTerrain[lbKey] = snapshot;

                if (!writer.TryGet<LandBlock>(lbId, out var lb)) {
                    continue;
                }

                for (var i = 0; i < LANDBLOCK_SIZE; i++) {
                    var entry = currentEntries[i];
                    lb.Terrain[i] = new() {
                        Road = entry.Road,
                        Scenery = entry.Scenery,
                        Type = (DatReaderWriter.Enums.TerrainTextureType)entry.Type
                    };
                    lb.Height[i] = entry.Height;
                }

                if (!writer.TrySave(lb, portalIteration)) {
                    // Terrain LandBlock write failed — record it so the export reports partial.
                    terrainSaveFailures++;
                    Console.Error.WriteLine($"[Export] FAILED to save LandBlock 0x{lbId:X8} terrain.");
                }
            }

            // Reposition DAT static objects (LandBlockInfo.Objects) to match new terrain heights.
            // Must happen BEFORE LandblockDocument.SaveToDats below, which may rewrite the
            // same LBI entries.
            float[]? repoHeightTable = null;
            if (DatReaderWriter.TryGet<Region>(0x13000000, out var repoRegion)) {
                repoHeightTable = repoRegion.LandDefs.LandHeightTable;
            }

            if (repoHeightTable != null && oldTerrain.Count > 0 && newTerrain.Count > 0) {
                onProgress?.Invoke("Repositioning DAT statics...");
                int repoCount = 0;
                foreach (var lbKey in modifiedLandblocks) {
                    if (!oldTerrain.TryGetValue(lbKey, out var oldEntries)) continue;
                    if (!newTerrain.TryGetValue(lbKey, out var newEntries2)) continue;

                    var infoId = (uint)(lbKey << 16) | 0xFFFE;
                    if (!writer.TryGet<LandBlockInfo>(infoId, out var lbi)) continue;
                    if (lbi.Objects == null || lbi.Objects.Count == 0) continue;

                    uint landblockX = (uint)(lbKey >> 8) & 0xFF;
                    uint landblockY = (uint)(lbKey & 0xFF);
                    bool anyMoved = false;

                    foreach (var stab in lbi.Objects) {
                        float localX = stab.Frame.Origin.X;
                        float localY = stab.Frame.Origin.Y;
                        if (localX < 0 || localX > 192f || localY < 0 || localY > 192f) continue;

                        float oldZ = TerrainHeightSampler.SampleHeightTriangle(
                            oldEntries, repoHeightTable, localX, localY, landblockX, landblockY);
                        float newZ = TerrainHeightSampler.SampleHeightTriangle(
                            newEntries2, repoHeightTable, localX, localY, landblockX, landblockY);

                        float delta = newZ - oldZ;
                        if (MathF.Abs(delta) < 0.01f) continue;

                        stab.Frame.Origin = new Vector3(
                            stab.Frame.Origin.X,
                            stab.Frame.Origin.Y,
                            stab.Frame.Origin.Z + delta);
                        anyMoved = true;
                    }

                    if (anyMoved) {
                        if (!writer.TrySave(lbi, portalIteration)) {
                            terrainSaveFailures++;
                            Console.Error.WriteLine($"[Export] FAILED to save repositioned LandBlockInfo 0x{infoId:X8}.");
                        }
                        repoCount++;
                    }
                }
                onProgress?.Invoke($"Repositioned statics in {repoCount} landblocks");
            }

            // Export static object changes from LandblockDocuments, dungeon data, and portal table edits.
            // Process LandblockDocuments separately with memory management â€” each building instantiation
            // creates EnvCells that consume significant memory. Release each doc after saving.
            var lbDocIds = DocumentManager.ActiveDocs
                .Where(kv => kv.Value is LandblockDocument)
                .Select(kv => kv.Key)
                .ToList();

            // Load donor-placement hints (if present) so export can instantiate interiors from
            // the same donor building variants selected during remap-buildings-v2.
            var donorHintsLoaded = 0;
            var donorBlueprintsPreloaded = 0;
            var donorMapPath = Path.Combine(ProjectDirectory, "building_old_cells.json");
            if (File.Exists(donorMapPath)) {
                try {
                    using var mapDoc = JsonDocument.Parse(File.ReadAllText(donorMapPath));
                    foreach (var entry in mapDoc.RootElement.EnumerateObject()) {
                        var value = entry.Value;

                        if (!value.TryGetProperty("modelId", out var modelIdProp) ||
                            !value.TryGetProperty("oldLbKey", out var oldLbKeyProp) ||
                            !value.TryGetProperty("oldBuildingIndex", out var oldBuildingIndexProp) ||
                            !value.TryGetProperty("newLbKey", out var newLbKeyProp) ||
                            !value.TryGetProperty("destinationLocalOrigin", out var destinationLocalOriginProp)) {
                            continue;
                        }

                        if (!modelIdProp.TryGetUInt32(out var modelId) ||
                            !oldLbKeyProp.TryGetInt32(out var oldLbKeyRaw) ||
                            !oldBuildingIndexProp.TryGetInt32(out var oldBuildingIndex) ||
                            !newLbKeyProp.TryGetInt32(out var newLbKeyRaw)) {
                            continue;
                        }
                        if (oldLbKeyRaw < 0 || oldLbKeyRaw > ushort.MaxValue ||
                            newLbKeyRaw < 0 || newLbKeyRaw > ushort.MaxValue) {
                            continue;
                        }
                        var oldLbKey = (ushort)oldLbKeyRaw;
                        var newLbKey = (ushort)newLbKeyRaw;

                        if (!destinationLocalOriginProp.TryGetProperty("x", out var xProp) ||
                            !destinationLocalOriginProp.TryGetProperty("y", out var yProp) ||
                            !destinationLocalOriginProp.TryGetProperty("z", out var zProp)) {
                            continue;
                        }
                        if (!xProp.TryGetSingle(out var localX) ||
                            !yProp.TryGetSingle(out var localY) ||
                            !zProp.TryGetSingle(out var localZ)) {
                            continue;
                        }

                        BuildingBlueprintCache.RegisterPlacementDonorHint(
                            modelId, newLbKey, new Vector3(localX, localY, localZ), oldLbKey, oldBuildingIndex);
                        donorHintsLoaded++;

                        var donorBlueprint = BuildingBlueprintCache.GetBlueprintFromDonor(
                            modelId, oldLbKey, oldBuildingIndex, DatReaderWriter);
                        if (donorBlueprint != null) donorBlueprintsPreloaded++;
                    }
                }
                catch (Exception ex) {
                    Console.Error.WriteLine($"[Export] Warning: failed to load donor map '{donorMapPath}': {ex.Message}");
                }
            }

            if (donorHintsLoaded > 0) {
                Console.Error.WriteLine(
                    $"[Export] Loaded {donorHintsLoaded} donor placement hints and preloaded {donorBlueprintsPreloaded} donor blueprints.");
            }

            // â”€â”€ Pre-extract all building blueprints from BASE DATs â”€â”€
            // During export, SaveToDatsInternal processes landblocks in arbitrary order.
            // Source landblocks (whose buildings were cleared) may be processed BEFORE
            // destination landblocks, deleting donor buildings from the export DAT.
            // When the destination landblock then tries to instantiate the building,
            // BuildingBlueprintCache.GetBlueprint() scans the export DAT for a donor â€”
            // but the donor was already deleted! This pre-extraction step caches all
            // needed blueprints from the read-only base DATs where donors always exist.
            {
                int preExtracted = 0;
                foreach (var docId in lbDocIds) {
                    if (DocumentManager.ActiveDocs.TryGetValue(docId, out var preDoc) && preDoc is LandblockDocument preLbDoc) {
                        foreach (var obj in preLbDoc.GetStaticObjects()) {
                            if (BuildingBlueprintCache.IsBuildingModelId(obj.Id, DatReaderWriter)) {
                                var bp = BuildingBlueprintCache.GetBlueprint(obj.Id, DatReaderWriter);
                                if (bp != null) preExtracted++;
                            }
                        }
                    }
                }
                if (preExtracted > 0) {
                    Console.Error.WriteLine($"[Export] Pre-extracted {preExtracted} building blueprints from base DATs.");
                }
            }

            onProgress?.Invoke("Writing static objects and dungeons...");

            int lbDocsSaved = 0;
            foreach (var docId in lbDocIds) {
                if (DocumentManager.ActiveDocs.TryGetValue(docId, out var doc) && doc is LandblockDocument lbDoc) {
                    // Streamed-in but unmodified docs must not overwrite the base DAT content
                    // (which may have been repositioned above).
                    if (!lbDoc.IsDirty) continue;
                    if (lbDoc.SaveToDats(writer, portalIteration).GetAwaiter().GetResult())
                        docsSaved++;
                    else {
                        docSaveFailures++;
                        Console.Error.WriteLine($"[Export] FAILED to save landblock document '{docId}'.");
                    }
                    lbDocsSaved++;

                    // Release the document from cache to free memory
                    DocumentManager.ActiveDocs.TryRemove(docId, out _);

                    // Periodic GC to prevent memory from growing unbounded
                    if (lbDocsSaved % 500 == 0) {
                        Console.Error.WriteLine($"[Export] {lbDocsSaved}/{lbDocIds.Count} landblock docs saved, releasing memory...");
                        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
                    }
                }
            }
            if (lbDocsSaved > 0) {
                Console.Error.WriteLine($"[Export] All {lbDocsSaved} landblock docs saved.");
                GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
            }

            // Process non-landblock documents normally
            foreach (var (docId, doc) in DocumentManager.ActiveDocs) {
                if (doc is DungeonDocument dungeonDoc) {
                    if (dungeonDoc.SaveToDats(writer, portalIteration).GetAwaiter().GetResult())
                        docsSaved++;
                    else {
                        docSaveFailures++;
                        Console.Error.WriteLine($"[Export] FAILED to save dungeon document '{docId}'.");
                    }
                }
                else if (doc is PortalDatDocument portalDoc) {
                    if (portalDoc.SaveToDats(writer, portalIteration).GetAwaiter().GetResult())
                        docsSaved++;
                    else {
                        docSaveFailures++;
                        Console.Error.WriteLine($"[Export] FAILED to save portal document '{docId}'.");
                    }
                }
                else if (doc is LayoutDatDocument layoutDoc) {
                    if (layoutDoc.SaveToDats(writer, portalIteration).GetAwaiter().GetResult())
                        docsSaved++;
                    else {
                        docSaveFailures++;
                        Console.Error.WriteLine($"[Export] FAILED to save layout document '{docId}'.");
                    }
                }
            }

            // Free blueprint cache memory after all buildings have been instantiated
            BuildingBlueprintCache.ClearCache();

            onProgress?.Invoke("Writing custom textures...");

            // Write custom imported textures and update Region for terrain replacements
            try {
                OnExportCustomTextures?.Invoke(writer, portalIteration);
            }
            catch (Exception ex) {
                Console.Error.WriteLine($"[Export] Error writing custom textures: {ex.Message}");
            }

            // TODO: all other dat iterations
            writer.Dats.Portal.Iteration.CurrentIteration = portalIteration;

            writer.Dispose();

            // Fix B-tree leaf node branch sentinels: Chorizite writes 0xCDCDCDCD
            // for unused slots but ACE expects 0x00000000 to identify leaf nodes.
            // Run before OnExportReposition so the reposition hook (which uses
            // ACE's DatLoader) sees fixed-up DATs.
            onProgress?.Invoke("Fixing DAT B-tree leaf nodes for ACE compatibility...");
            foreach (var datFile in datFiles) {
                var destPath = Path.Combine(exportDirectory, datFile);
                DatExportFixer.FixLeafBranchSentinels(destPath);
            }

            // Dungeon instance placements (generators/items/portals) for ACE DB
            var dungeonsWithPlacements = new List<DungeonDocument>();
            foreach (var (_, doc) in DocumentManager.ActiveDocs) {
                if (doc is DungeonDocument dng && dng.InstancePlacements.Count > 0)
                    dungeonsWithPlacements.Add(dng);
            }
            if (dungeonsWithPlacements.Count > 0)
                OnExportDungeonInstances?.Invoke(exportDirectory, dungeonsWithPlacements);

            onProgress?.Invoke("Running instance reposition...");

            // Instance reposition: build context and invoke hook if wired
            if (OnExportReposition != null && oldTerrain.Count > 0 && newTerrain.Count > 0) {
                float[]? heightTable = null;
                if (DatReaderWriter.TryGet<Region>(0x13000000, out var region)) {
                    heightTable = region.LandDefs.LandHeightTable;
                }

                if (heightTable != null) {
                    var ctx = new RepositionContext {
                        ModifiedLandblocks = modifiedLandblocks.ToArray(),
                        OldTerrain = oldTerrain,
                        NewTerrain = newTerrain,
                        LandHeightTable = heightTable,
                        ExportDirectory = exportDirectory
                    };
                    OnExportReposition(ctx).GetAwaiter().GetResult();
                }
            }

            int totalFailures = terrainSaveFailures + docSaveFailures;
            if (totalFailures > 0) {
                Console.Error.WriteLine(
                    $"[Export] Completed with {totalFailures} write failure(s): " +
                    $"{terrainSaveFailures} terrain, {docSaveFailures} document. Export is PARTIAL.");
            }
            return new ExportDatsResult(
                Success: totalFailures == 0,
                TerrainWritten: terrainWritten,
                TerrainSaveFailures: terrainSaveFailures,
                DocsSaved: docsSaved,
                DocSaveFailures: docSaveFailures);
        }

        private void CollectExportLayers(IEnumerable<TerrainLayerBase> items, List<TerrainLayer> result) {
            foreach (var item in items) {
                if (!item.IsExport) continue;

                if (item is TerrainLayerGroup group) {
                    CollectExportLayers(group.Children, result);
                }
                else if (item is TerrainLayer layer) {
                    result.Add(layer);
                }
            }
        }

        public void Dispose() {
            DatReaderWriter?.Dispose();
        }
    }

    /// <summary>
    /// Outcome of <see cref="Project.ExportDats(string, int, System.Action{string})"/>. The
    /// export writes DAT bytes for the highest-stakes command in the tool, so callers MUST be able
    /// to tell a fully-clean export from one where some terrain/EnvCell/LBI/dungeon/portal write
    /// silently failed. <see cref="Success"/> is true only when there were zero failures.
    /// </summary>
    /// <param name="Success">True iff <see cref="TerrainSaveFailures"/> and <see cref="DocSaveFailures"/> are both zero.</param>
    /// <param name="TerrainWritten">Number of terrain landblocks processed for writing.</param>
    /// <param name="TerrainSaveFailures">Number of LandBlock/LBI terrain writes that returned failure.</param>
    /// <param name="DocsSaved">Number of documents (landblock/dungeon/portal/layout) whose SaveToDats succeeded.</param>
    /// <param name="DocSaveFailures">Number of documents whose SaveToDats returned false.</param>
    public record ExportDatsResult(
        bool Success,
        int TerrainWritten,
        int TerrainSaveFailures,
        int DocsSaved,
        int DocSaveFailures);
}

