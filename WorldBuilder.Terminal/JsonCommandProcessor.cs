using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization;
using WorldBuilder.Shared.Lib.Validation;
using WorldBuilder.Shared.Lib.WorldGen;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Terminal;

/// <summary>
/// Processes JSON command objects and returns structured JSON responses.
/// Designed for agent ↔ terminal communication via stdin/stdout.
/// All business logic is delegated to <see cref="CommandEngine"/>.
///
/// Protocol:
///   Input:  One JSON object per line on stdin
///   Output: One JSON response per line on stdout
///
/// Every response contains at minimum:
///   { "success": true/false, "command": "...", ... }
///
/// On failure:
///   { "success": false, "command": "...", "error": "..." }
/// </summary>
public class JsonCommandProcessor {
    private readonly CommandEngine _engine;
    private readonly Dictionary<string, Func<System.Text.Json.Nodes.JsonNode, string>> _commandHandlers;

    private static readonly JsonSerializerOptions JsonOpts = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };

    public JsonCommandProcessor(HeadlessProjectManager projectManager,
        ITerrainService terrainService,
        IObjectPlacementService objectPlacementService,
        IDungeonService dungeonService,
        IOntologyService ontologyService,
        IStampService stampService) {
        _engine = new CommandEngine(projectManager, terrainService, objectPlacementService, dungeonService, ontologyService, stampService);
        _commandHandlers = BuildCommandHandlers();
    }

    /// <summary>
    /// Runs the stdin loop: reads one JSON line at a time, processes it, writes one JSON line response.
    /// Exits on EOF (stdin closed) or the "quit"/"exit" command.
    /// </summary>
    public void RunStdinLoop() {
        var version = typeof(JsonCommandProcessor).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
        WriteResponse(new { success = true, command = "ready", version, message = "WorldBuilder.Terminal JSON mode ready" });

        while (true) {
            var line = Console.ReadLine();
            if (line == null) break; // EOF
            if (string.IsNullOrWhiteSpace(line)) continue;

            try {
                var (result, isQuit) = ProcessCommandInternal(line);
                Console.WriteLine(result);
                if (isQuit) break;
            } catch (Exception ex) {
                WriteResponse(new { success = false, command = "unknown", error = ex.Message });
            }
        }
    }

    /// <summary>
    /// Processes a single JSON command string and returns a JSON response string.
    /// This is the main entry point — can also be called directly for testing.
    /// </summary>
    public string ProcessCommand(string jsonLine) => ProcessCommandInternal(jsonLine).Result;

    private (string Result, bool IsQuit) ProcessCommandInternal(string jsonLine) {
        System.Text.Json.Nodes.JsonNode? node;
        try {
            node = System.Text.Json.Nodes.JsonNode.Parse(jsonLine);
        } catch (JsonException ex) {
            return (Serialize(new { success = false, command = "parse_error", error = $"Invalid JSON: {ex.Message}" }), false);
        }

        if (node == null)
            return (Serialize(new { success = false, command = "parse_error", error = "Null JSON input" }), false);

        if (node["command"] is not System.Text.Json.Nodes.JsonValue commandValue ||
            !commandValue.TryGetValue<string>(out var commandRaw) ||
            string.IsNullOrWhiteSpace(commandRaw)) {
            return (Serialize(new { success = false, command = "parse_error", error = "Missing or invalid 'command' field" }), false);
        }

        var command = commandRaw.Trim();

        try {
            if (command.Equals("quit", StringComparison.OrdinalIgnoreCase) ||
                command.Equals("exit", StringComparison.OrdinalIgnoreCase)) {
                return (Serialize(new { success = true, command }), true);
            }

            if (_commandHandlers.TryGetValue(command, out var handler)) {
                return (handler(node), false);
            }

            return (Serialize(new { success = false, command, error = $"Unknown command: '{command}'" }), false);
        } catch (Exception ex) {
            return (Serialize(new { success = false, command, error = ex.Message }), false);
        }
    }

    private Dictionary<string, Func<System.Text.Json.Nodes.JsonNode, string>> BuildCommandHandlers() =>
        new(StringComparer.OrdinalIgnoreCase) {
            ["load"] = CmdLoad,
            ["export"] = CmdExport,
            ["info"] = _ => CmdInfo(),
            ["smooth"] = CmdSmooth,
            ["raise"] = CmdRaise,
            ["lower"] = CmdLower,
            ["set-height"] = CmdSetHeight,
            ["paint"] = CmdPaint,
            ["fill"] = CmdFill,
            ["road"] = CmdRoad,
            ["get-height"] = CmdGetHeight,
            ["terrain-info"] = CmdTerrainInfo,
            ["get-heightmap"] = CmdGetHeightmap,
            ["get-terrain-data"] = CmdGetTerrainData,
            ["list-objects"] = CmdListObjects,
            ["add-object"] = CmdAddObject,
            ["remove-object"] = CmdRemoveObject,
            ["clear-objects"] = CmdClearObjects,
            ["move-object"] = CmdMoveObject,
            ["rotate-object"] = CmdRotateObject,
            ["query-radius"] = CmdQueryRadius,
            ["analyze-dungeons"] = CmdAnalyzeDungeons,
            ["analyze-dungeon-catalog"] = CmdAnalyzeDungeonCatalog,
            ["analyze-dungeon-topology"] = CmdAnalyzeDungeonTopology,
            ["get-dungeon-info"] = CmdGetDungeonInfo,
            ["validate-dungeon"] = CmdValidateDungeon,
            ["validate-landblock"] = CmdValidateLandblock,
            ["validate-terrain"] = CmdValidateTerrain,
            ["validate-building-shells"] = CmdValidateBuildingShells,
            ["validate-building-portals"] = CmdValidateBuildingPortals,
            ["validate-all"] = CmdValidateAll,
            ["list-landblocks"] = CmdListLandblocks,
            ["get-world-info"] = _ => CmdGetWorldInfo(),
            ["get-region"] = _ => CmdGetRegion(),
            ["scan-ontology"] = CmdScanOntology,
            ["query-ontology"] = CmdQueryOntology,
            ["ontology-stats"] = _ => CmdOntologyStats(),
            ["paste-stamp"] = CmdPasteStamp,
            ["snap-portal"] = CmdSnapPortal,
            ["get-bulk-heightmap"] = CmdGetBulkHeightmap,
            ["get-object-detail"] = CmdGetObjectDetail,
            ["diff-terrain"] = CmdDiffTerrain,
            ["get-terrain-layers"] = CmdGetTerrainLayers,
            ["export-textures"] = CmdExportTextures,
            ["import-texture"] = CmdImportTexture,
            ["clone-dat"] = CmdCloneDat,
            ["defragment-dat"] = CmdDefragmentDat,
            ["export-ontology"] = CmdExportOntology,
            ["export-setup-parts"] = CmdExportSetupParts,
            ["export-classification-signals"] = CmdExportClassificationSignals,
            ["mine-strings"] = CmdMineStrings,
            ["enrich-ontology"] = _ => CmdEnrichOntology(),
            ["import-catalog"] = CmdImportCatalog,
            ["classify-ontology"] = _ => CmdClassifyOntology(),
            ["enrich-materials"] = _ => CmdEnrichMaterials(),
            ["ingest-weenies"] = CmdIngestWeenies,
            ["enrich-weenies"] = CmdEnrichWeenies,
            ["enrich-canonical"] = CmdEnrichCanonical,
            ["enrich-unified"] = CmdEnrichUnified,
            ["cache-ontology"] = CmdCacheOntology,
            ["load-ontology-cache"] = CmdLoadOntologyCache,
            ["scan-building-placements"] = CmdScanBuildingPlacements,
            ["difficulty-gradient"] = CmdDifficultyGradient,
            ["apply-population"] = CmdApplyPopulation,
            ["ingest-spawn-maps"] = CmdIngestSpawnMaps,
            ["ingest-spells"] = CmdIngestSpells,
            ["ingest-recipes"] = CmdIngestRecipes,
            ["benchmark"] = _ => CmdBenchmark(),
            ["set-landblock-heightmap"] = CmdSetLandblockHeightmap,
            ["set-landblock-terrain"] = CmdSetLandblockTerrain,
            ["bulk-place-objects"] = CmdBulkPlaceObjects,
            ["generate-terrain"] = CmdGenerateTerrain,
            ["generate-dungeon"] = CmdGenerateDungeon,
            ["auto-paint"] = _ => CmdAutoPaint(),
            ["analyze-landblock-patterns"] = CmdAnalyzeLandblockPatterns,
            ["extract-building-pairings"] = CmdExtractBuildingPairings,
            ["load-building-pairings"] = CmdLoadBuildingPairings,
            ["export-training-data"] = CmdExportTrainingData,
            ["export-raw-world-facts"] = CmdExportRawWorldFacts,
            ["export-envcell-components"] = CmdExportEnvCellComponents,
            ["generate-settlement"] = CmdGenerateSettlement,
            ["extract-retail-heightmaps"] = CmdExtractRetailHeightmaps,
            ["compute-vanilla-baseline"] = CmdComputeVanillaBaseline,
            ["obj-export"] = CmdObjExport,
            ["obj-import"] = CmdObjImport,
            ["bsp-build"] = CmdBspBuild,
            ["weenie-snapshot"] = CmdWeenieSnapshot,
            ["weenie-template-list"] = CmdWeenieTemplateList,
            ["weenie-template-apply"] = CmdWeenieTemplateApply,
            ["worldgen"] = CmdWorldGen,
            ["worldgen-analyze-buildings"] = CmdWorldGenAnalyzeBuildings,
            ["worldgen-scan-retail-towns"] = CmdWorldGenScanRetailTowns,
            ["render-preview"] = CmdRenderPreview,
            ["compare-to-retail"] = CmdCompareToRetail,
            ["help"] = _ => CmdHelp(),
        };

    private string CmdCompareToRetail(System.Text.Json.Nodes.JsonNode node) {
        var generated = node["generated"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'generated' field");
        string? retailBaseline = node["retailBaseline"]?.GetValue<string>();
        int topK = node["topK"]?.GetValue<int>() ?? 30;
        int anomalyMin = node["anomalyMinModel"]?.GetValue<int>() ?? 20;
        bool perLb = node["perLandblock"]?.GetValue<bool>() ?? true;
        string? cacheDir = node["cacheDir"]?.GetValue<string>();

        var r = _engine.CompareToRetail(generated, retailBaseline, topK, anomalyMin, perLb, cacheDir);
        if (!r.Success)
            return Serialize(new { success = false, command = "compare-to-retail",
                generated = r.Generated, retail = r.Retail, error = r.Error });

        return Serialize(new {
            success = true,
            command = "compare-to-retail",
            generated = r.Generated,
            retail = r.Retail,
            elapsedSeconds = r.ElapsedSeconds,
            retailCacheHit = r.RetailCacheHit,
            region = r.Region,
            volumes = new {
                generated = r.GeneratedCount,
                retail = r.RetailCount,
                densityDeltaPct = r.DensityDeltaPct,
            },
            density = new { model = r.ModelDensity, retail = r.RetailDensity },
            coverage = r.Coverage,
            surfaceInterior = r.SurfaceInterior,
            lbJaccard = r.LbJaccard,
            anomalies = r.Anomalies,
            classSpace = r.ClassSpace,
            wcids = r.Wcids,
            perLandblock = r.PerLandblock,
            outJsonPath = r.OutJsonPath,
        });
    }

    private string CmdRenderPreview(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        int radius = node["radius"]?.GetValue<int>() ?? 0;
        int resolution = node["resolution"]?.GetValue<int>() ?? 1024;
        bool overlay = node["overlay"]?.GetValue<bool>() ?? true;
        bool includePng = node["includePng"]?.GetValue<bool>() ?? true;
        string? outPath = node["outputPath"]?.GetValue<string>();

        var r = _engine.RenderPreview(lbX, lbY, radius, resolution, overlay, outPath);
        return Serialize(new {
            success = true,
            command = "render-preview",
            landblock = $"0x{r.CenterLbKey:X4}",
            centerLbX = r.CenterLbX, centerLbY = r.CenterLbY,
            radius = r.Radius,
            resolution = r.Resolution,
            lbPixelSize = r.LbPixelSize,
            landblockCount = r.LandblockCount,
            objectCount = r.ObjectCount,
            cliffCount = r.CliffCount,
            overlayApplied = r.OverlayApplied,
            outputPath = r.OutputPath,
            pngBytes = r.PngBytes.Length,
            pngBase64 = includePng ? Convert.ToBase64String(r.PngBytes) : null,
        });
    }

    // ════════════════════════════════════════════════════
    //  Project management
    // ════════════════════════════════════════════════════

    private string CmdLoad(System.Text.Json.Nodes.JsonNode node) {
        var path = node["path"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'path' field");
        var r = _engine.Load(path);
        return Serialize(new { success = true, command = "load",
            projectName = r.ProjectName, projectFile = r.ProjectFile,
            projectDir = r.ProjectDir, datDirectory = r.DatDirectory });
    }

    private string CmdExport(System.Text.Json.Nodes.JsonNode node) {
        var dir = node["directory"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'directory' field");
        var iteration = node["iteration"]?.GetValue<int>();
        var r = _engine.Export(dir, iteration);
        return Serialize(new { success = r.Success, command = "export", directory = r.Directory, iteration = r.Iteration });
    }

    private string CmdInfo() {
        var r = _engine.GetInfo();
        if (!r.Loaded) return Serialize(new { success = true, command = "info", loaded = false });
        return Serialize(new { success = true, command = "info", loaded = true,
            projectName = r.ProjectName, projectFile = r.ProjectFile, projectDir = r.ProjectDir,
            datDirectory = r.DatDirectory, databasePath = r.DatabasePath, portalIteration = r.PortalIteration });
    }

    // ════════════════════════════════════════════════════
    //  Terrain editing
    // ════════════════════════════════════════════════════

    private string CmdSmooth(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y"), radius = F(node, "radius");
        float strength = node["strength"]?.GetValue<float>() ?? 0.5f;
        var r = _engine.Smooth(x, y, radius, strength);
        return Serialize(new { success = true, command = "smooth",
            verticesModified = r.VerticesModified, landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdRaise(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y"), radius = F(node, "radius");
        int delta = node["delta"]?.GetValue<int>() ?? 5;
        var r = _engine.Raise(x, y, radius, delta);
        return Serialize(new { success = true, command = "raise",
            verticesModified = r.VerticesModified, delta, landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdLower(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y"), radius = F(node, "radius");
        int delta = node["delta"]?.GetValue<int>() ?? 5;
        var r = _engine.Lower(x, y, radius, delta);
        return Serialize(new { success = true, command = "lower",
            verticesModified = r.VerticesModified, delta, landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdSetHeight(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y"), radius = F(node, "radius");
        byte height = node["height"]?.GetValue<byte>() ?? throw new ArgumentException("Missing 'height' field");
        var r = _engine.SetHeight(x, y, radius, height);
        return Serialize(new { success = true, command = "set-height",
            verticesModified = r.VerticesModified, targetHeight = height, landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdPaint(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y"), radius = F(node, "radius");
        byte terrainType = node["type"]?.GetValue<byte>() ?? throw new ArgumentException("Missing 'type' field");
        var r = _engine.Paint(x, y, radius, terrainType);
        return Serialize(new { success = true, command = "paint",
            verticesModified = r.VerticesModified, terrainType, landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdFill(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y");
        byte newType = node["type"]?.GetValue<byte>() ?? throw new ArgumentException("Missing 'type' field");
        var r = _engine.Fill(x, y, newType);
        return Serialize(new { success = true, command = "fill",
            verticesModified = r.VerticesModified, terrainType = newType, landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdRoad(System.Text.Json.Nodes.JsonNode node) {
        float x1 = F(node, "x1"), y1 = F(node, "y1"), x2 = F(node, "x2"), y2 = F(node, "y2");
        byte roadValue = node["value"]?.GetValue<byte>() ?? 1;
        var r = _engine.DrawRoad(x1, y1, x2, y2, roadValue);
        return Serialize(new { success = true, command = "road",
            waypoints = r.Waypoints, verticesModified = r.VerticesModified,
            roadValue = r.RoadValue, landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    // ════════════════════════════════════════════════════
    //  Terrain queries
    // ════════════════════════════════════════════════════

    private string CmdGetHeight(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y");
        var r = _engine.GetHeight(x, y);
        return Serialize(new { success = true, command = "get-height",
            r.X, r.Y, height = Math.Round(r.Height, 2),
            heightIndex = r.HeightIndex, terrainType = r.TerrainType, road = r.Road, scenery = r.Scenery,
            landblock = r.LandblockId.HasValue ? $"0x{r.LandblockId:X4}" : null,
            vertexIndex = r.VertexIndex });
    }

    private string CmdTerrainInfo(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var r = _engine.GetTerrainInfo(lbX, lbY);
        if (!r.Found) return Serialize(new { success = true, command = "terrain-info", landblock = $"0x{r.LbKey:X4}", found = false });
        return Serialize(new { success = true, command = "terrain-info", landblock = $"0x{r.LbKey:X4}", found = true,
            lbX, lbY, worldOriginX = lbX * 192, worldOriginY = lbY * 192,
            vertexCount = r.VertexCount, heightMin = r.HeightMin, heightMax = r.HeightMax, heightAvg = Math.Round(r.HeightAvg, 1),
            terrainTypes = r.TerrainTypes!.Select(tc => new { type = (int)tc.Type, count = tc.Count, percent = Math.Round(100.0 * tc.Count / r.VertexCount) }).ToArray() });
    }

    private string CmdGetHeightmap(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var r = _engine.GetHeightmap(lbX, lbY);
        if (!r.Found) return Serialize(new { success = true, command = "get-heightmap", landblock = $"0x{r.LbKey:X4}", found = false });
        return Serialize(new { success = true, command = "get-heightmap", landblock = $"0x{r.LbKey:X4}", found = true,
            lbX, lbY, worldOriginX = lbX * 192, worldOriginY = lbY * 192,
            gridSize = 9, cellSize = 24, heightsWorld = r.HeightsWorld, heightIndices = r.HeightIndices });
    }

    private string CmdGetTerrainData(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var r = _engine.GetTerrainData(lbX, lbY);
        if (!r.Found) return Serialize(new { success = true, command = "get-terrain-data", landblock = $"0x{r.LbKey:X4}", found = false });
        return Serialize(new { success = true, command = "get-terrain-data", landblock = $"0x{r.LbKey:X4}", found = true,
            lbX, lbY, worldOriginX = lbX * 192, worldOriginY = lbY * 192,
            vertexCount = r.Vertices!.Count, gridSize = 9, cellSize = 24,
            vertices = r.Vertices!.Select(v => new { index = v.Index, gridX = v.GridX, gridY = v.GridY,
                heightIndex = (int)v.HeightIndex, heightWorld = v.HeightWorld,
                terrainType = (int)v.TerrainType, road = (int)v.Road, scenery = (int)v.Scenery }).ToArray() });
    }

    // ════════════════════════════════════════════════════
    //  Object management
    // ════════════════════════════════════════════════════

    private string CmdListObjects(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var r = _engine.ListObjects(lbX, lbY);
        return Serialize(new { success = true, command = "list-objects", landblock = $"0x{r.LbKey:X4}", count = r.Objects.Count,
            objects = r.Objects.Select((obj, i) => new {
                index = i, modelId = $"0x{obj.Id:X8}", type = obj.IsSetup ? "Setup" : "GfxObj",
                x = Math.Round(obj.Origin.X, 2), y = Math.Round(obj.Origin.Y, 2), z = Math.Round(obj.Origin.Z, 2),
                orientation = FmtQ(obj.Orientation), scale = new { x = Math.Round(obj.Scale.X, 3), y = Math.Round(obj.Scale.Y, 3), z = Math.Round(obj.Scale.Z, 3) }
            }).ToArray() });
    }

    private string CmdAddObject(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var modelIdStr = node["modelId"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'modelId'");
        uint modelId = uint.Parse(modelIdStr.Replace("0x", ""), System.Globalization.NumberStyles.HexNumber);
        float x = F(node, "x"), y = F(node, "y"), z = F(node, "z");

        float qw = node["qw"]?.GetValue<float>() ?? 1f, qx = node["qx"]?.GetValue<float>() ?? 0f;
        float qy = node["qy"]?.GetValue<float>() ?? 0f, qz = node["qz"]?.GetValue<float>() ?? 0f;
        var orientation = Quaternion.Normalize(new Quaternion(qx, qy, qz, qw));

        float sx = node["scaleX"]?.GetValue<float>() ?? node["scale"]?.GetValue<float>() ?? 1f;
        float sy = node["scaleY"]?.GetValue<float>() ?? node["scale"]?.GetValue<float>() ?? 1f;
        float sz = node["scaleZ"]?.GetValue<float>() ?? node["scale"]?.GetValue<float>() ?? 1f;

        bool snap = node["snap"]?.GetValue<bool>() ?? false;

        var r = _engine.AddObject(lbX, lbY, modelId, x, y, z, orientation, new Vector3(sx, sy, sz), snap);
        return Serialize(new { success = true, command = "add-object", landblock = $"0x{r.LbKey:X4}",
            index = r.Index, modelId = $"0x{r.Object.Id:X8}", type = r.Object.IsSetup ? "Setup" : "GfxObj",
            x = Math.Round(r.Object.Origin.X, 2), y = Math.Round(r.Object.Origin.Y, 2), z = Math.Round(r.Object.Origin.Z, 2),
            snapped = snap, orientation = FmtQ(r.Object.Orientation), scale = new { x = sx, y = sy, z = sz } });
    }

    private string CmdRemoveObject(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        int index = node["index"]?.GetValue<int>() ?? throw new ArgumentException("Missing 'index'");
        var r = _engine.RemoveObject(lbX, lbY, index);
        return Serialize(new { success = r.Success, command = "remove-object", landblock = $"0x{r.LbKey:X4}",
            index = r.Index, removedModelId = $"0x{r.RemovedModelId:X8}",
            removedPosition = new { x = Math.Round(r.RemovedPosition.X, 1), y = Math.Round(r.RemovedPosition.Y, 1), z = Math.Round(r.RemovedPosition.Z, 1) } });
    }

    private string CmdMoveObject(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        int index = node["index"]?.GetValue<int>() ?? throw new ArgumentException("Missing 'index'");
        float x = F(node, "x"), y = F(node, "y"), z = F(node, "z");
        var r = _engine.MoveObject(lbX, lbY, index, x, y, z);
        return Serialize(new { success = true, command = "move-object", landblock = $"0x{r.LbKey:X4}",
            index = r.Index, modelId = $"0x{r.ModelId:X8}",
            from = new { x = Math.Round(r.From.X, 2), y = Math.Round(r.From.Y, 2), z = Math.Round(r.From.Z, 2) },
            to = new { x, y, z } });
    }

    private string CmdClearObjects(System.Text.Json.Nodes.JsonNode node) {
        bool clearAll = node["all"]?.GetValue<bool>() ?? false;

        if (clearAll) {
            var allResult = _engine.ClearAllObjects();
            return Serialize(new {
                success = allResult.Success,
                command = "clear-objects",
                all = true,
                objectsRemoved = allResult.ObjectsRemoved,
                landblocksProcessed = allResult.LandblocksProcessed,
                affectedLandblocks = allResult.AffectedLandblocks.Select(lb => $"0x{lb:X4}").ToArray()
            });
        }

        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var result = _engine.ClearObjects(lbX, lbY);
        ushort lbKey = (ushort)((lbX << 8) | lbY);
        return Serialize(new {
            success = result.Success,
            command = "clear-objects",
            all = false,
            landblock = $"0x{lbKey:X4}",
            objectsRemoved = result.ObjectsRemoved
        });
    }

    private string CmdRotateObject(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        int index = node["index"]?.GetValue<int>() ?? throw new ArgumentException("Missing 'index'");

        Quaternion newQ;
        if (node["qw"] != null || node["qx"] != null || node["qy"] != null || node["qz"] != null) {
            // Absolute quaternion — sets orientation directly (does not compose)
            float qw = node["qw"]?.GetValue<float>() ?? 1f, qx = node["qx"]?.GetValue<float>() ?? 0f;
            float qy = node["qy"]?.GetValue<float>() ?? 0f, qz = node["qz"]?.GetValue<float>() ?? 0f;
            newQ = Quaternion.Normalize(new Quaternion(qx, qy, qz, qw));
        } else if (node["yaw"] != null) {
            // Yaw shorthand — sets Z-axis rotation to this angle (does not add to existing)
            float yawDeg = node["yaw"]!.GetValue<float>();
            newQ = Quaternion.CreateFromAxisAngle(Vector3.UnitZ, yawDeg * MathF.PI / 180f);
        } else {
            return Serialize(new { success = false, command = "rotate-object",
                error = "Provide quaternion (qw,qx,qy,qz) or yaw (degrees). Note: this SETS the orientation, it does not add to existing rotation." });
        }

        var r = _engine.RotateObject(lbX, lbY, index, newQ);
        return Serialize(new { success = true, command = "rotate-object", landblock = $"0x{r.LbKey:X4}",
            index = r.Index, modelId = $"0x{r.ModelId:X8}",
            oldOrientation = FmtQ(r.OldOrientation), newOrientation = FmtQ(r.NewOrientation) });
    }

    // ════════════════════════════════════════════════════
    //  Spatial queries
    // ════════════════════════════════════════════════════

    private string CmdQueryRadius(System.Text.Json.Nodes.JsonNode node) {
        float cx = F(node, "x"), cy = F(node, "y"), radius = F(node, "radius");
        float cz = node["z"]?.GetValue<float>() ?? 0f;
        bool? includeZ = node["includeZ"]?.GetValue<bool>();

        var r = _engine.QueryRadius(cx, cy, radius, cz, includeZ);
        return Serialize(new { success = true, command = "query-radius",
            center = new { x = cx, y = cy, z = cz }, radius, includeZ = r.IncludeZ,
            totalFound = r.Objects.Count, uniqueModels = r.ModelCounts.Count,
            density = radius > 0 ? Math.Round(r.Objects.Count / (MathF.PI * radius * radius), 4) : 0,
            objects = r.Objects.Select(f => new {
                distance = Math.Round(f.Distance, 2), landblock = $"0x{f.LbKey:X4}",
                index = f.Index, modelId = $"0x{f.Object.Id:X8}", type = f.Object.IsSetup ? "Setup" : "GfxObj",
                x = Math.Round(f.Object.Origin.X, 2), y = Math.Round(f.Object.Origin.Y, 2), z = Math.Round(f.Object.Origin.Z, 2),
                orientation = FmtQ(f.Object.Orientation)
            }).ToArray(),
            modelFrequency = r.ModelCounts.OrderByDescending(kv => kv.Value)
                .Select(kv => new { modelId = $"0x{kv.Key:X8}", count = kv.Value }).ToArray() });
    }

    // ════════════════════════════════════════════════════
    //  Dungeon tools
    // ════════════════════════════════════════════════════

    private string CmdAnalyzeDungeons(System.Text.Json.Nodes.JsonNode node) {
        string? outputPath = node["outputPath"]?.GetValue<string>();
        var (report, savedTo) = _engine.AnalyzeDungeons(outputPath);
        return Serialize(new { success = true, command = "analyze-dungeons",
            totalLandblocksScanned = report.TotalLandblocksScanned,
            totalCellsScanned = report.TotalCellsScanned,
            uniqueRoomTypes = report.UniqueRoomTypes,
            topStarterCandidates = report.TopStarterCandidates.Select(c => new {
                envFileId = $"0x{c.EnvFileId:X8}", cellStructIndex = c.CellStructIndex,
                portalCount = c.PortalCount, usageCount = c.UsageCount,
                sampleDungeonNames = c.SampleDungeonNames }).ToArray(),
            savedTo });
    }

    private string CmdGetDungeonInfo(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var r = _engine.GetDungeonInfo(lbX, lbY);
        if (!r.HasDungeon) return Serialize(new { success = true, command = "get-dungeon-info", landblock = $"0x{r.LbKey:X4}", hasDungeon = false, cellCount = 0 });
        return Serialize(new { success = true, command = "get-dungeon-info", landblock = $"0x{r.LbKey:X4}",
            hasDungeon = true, cellCount = r.CellCount,
            cells = r.Document!.Cells.Select(c => new {
                cellNumber = $"0x{c.CellNumber:X4}", environmentId = $"0x{c.EnvironmentId:X4}",
                cellStructure = c.CellStructure,
                origin = new { x = Math.Round(c.Origin.X, 2), y = Math.Round(c.Origin.Y, 2), z = Math.Round(c.Origin.Z, 2) },
                portalCount = c.CellPortals.Count,
                portals = c.CellPortals.Select(p => new { otherCellId = $"0x{p.OtherCellId:X4}", polygonId = p.PolygonId }).ToArray(),
                staticObjectCount = c.StaticObjects.Count,
                staticObjects = c.StaticObjects.Select(s => new { id = $"0x{s.Id:X8}",
                    x = Math.Round(s.Origin.X, 2), y = Math.Round(s.Origin.Y, 2), z = Math.Round(s.Origin.Z, 2) }).ToArray()
            }).ToArray() });
    }

    private string CmdAnalyzeDungeonCatalog(System.Text.Json.Nodes.JsonNode node) {
        string? outputPath = node["outputPath"]?.GetValue<string>();
        var r = _engine.AnalyzeDungeonCatalog(outputPath);
        if (!r.Success)
            return Serialize(new { success = false, command = "analyze-dungeon-catalog", error = r.Error });
        return Serialize(new { success = true, command = "analyze-dungeon-catalog",
            totalLandblocksScanned = r.TotalLandblocksScanned,
            totalCellsScanned = r.TotalCellsScanned,
            uniqueRoomTemplates = r.UniqueRoomTemplates,
            errors = r.Errors,
            classificationCounts = r.ClassificationCounts.OrderByDescending(kv => kv.Value)
                .Select(kv => new { classification = kv.Key, count = kv.Value }).ToArray(),
            outputPath = r.OutputPath });
    }

    private string CmdAnalyzeDungeonTopology(System.Text.Json.Nodes.JsonNode node) {
        string? outputPath = node["outputPath"]?.GetValue<string>();
        var r = _engine.AnalyzeDungeonTopology(outputPath);
        if (!r.Success)
            return Serialize(new { success = false, command = "analyze-dungeon-topology", error = r.Error });
        return Serialize(new { success = true, command = "analyze-dungeon-topology",
            totalDungeonsAnalyzed = r.TotalDungeonsAnalyzed,
            totalCellsAnalyzed = r.TotalCellsAnalyzed,
            classificationCounts = r.ClassificationCounts.OrderByDescending(kv => kv.Value)
                .Select(kv => new { classification = kv.Key, count = kv.Value }).ToArray(),
            outputPath = r.OutputPath });
    }

    // ════════════════════════════════════════════════════
    //  Validation
    // ════════════════════════════════════════════════════

    private string CmdValidateDungeon(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        return FormatValidation("validate-dungeon", lbX, lbY, _engine.ValidateDungeon(lbX, lbY));
    }

    private string CmdValidateLandblock(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        return FormatValidation("validate-landblock", lbX, lbY, _engine.ValidateLandblock(lbX, lbY));
    }

    private string CmdValidateTerrain(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        float threshold = node["cliffThreshold"]?.GetValue<float>() ?? ValidationEngine.DefaultCliffThreshold;
        return FormatValidation("validate-terrain", lbX, lbY, _engine.ValidateTerrain(lbX, lbY, threshold));
    }

    private string CmdValidateBuildingShells(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        return FormatValidation("validate-building-shells", lbX, lbY, _engine.ValidateBuildingShells(lbX, lbY));
    }

    private string CmdValidateBuildingPortals(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        return FormatValidation("validate-building-portals", lbX, lbY, _engine.ValidateBuildingPortals(lbX, lbY));
    }

    private string CmdValidateAll(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        float threshold = node["cliffThreshold"]?.GetValue<float>() ?? ValidationEngine.DefaultCliffThreshold;
        return FormatValidation("validate-all", lbX, lbY, _engine.ValidateAll(lbX, lbY, threshold));
    }

    // ════════════════════════════════════════════════════
    //  World observation
    // ════════════════════════════════════════════════════

    private string CmdListLandblocks(System.Text.Json.Nodes.JsonNode node) {
        uint minX = node["minX"]?.GetValue<uint>() ?? 0, minY = node["minY"]?.GetValue<uint>() ?? 0;
        uint maxX = node["maxX"]?.GetValue<uint>() ?? 254, maxY = node["maxY"]?.GetValue<uint>() ?? 254;
        int limit = node["limit"]?.GetValue<int>() ?? 500;
        var r = _engine.ListLandblocks(minX, minY, maxX, maxY, limit);
        return Serialize(new { success = true, command = "list-landblocks", count = r.Count,
            range = new { minX = r.MinX, minY = r.MinY, maxX = r.MaxX, maxY = r.MaxY },
            truncated = r.Truncated,
            landblocks = r.Landblocks.Select(lb => new {
                landblock = $"0x{lb.LbKey:X4}", lbX = lb.LbX, lbY = lb.LbY,
                worldOriginX = lb.LbX * 192, worldOriginY = lb.LbY * 192,
                heightMin = lb.HeightMin, heightMax = lb.HeightMax }).ToArray() });
    }

    private string CmdGetWorldInfo() {
        var r = _engine.GetWorldInfo();
        return Serialize(new { success = true, command = "get-world-info",
            projectName = r.ProjectName, mapWidth = 255, mapHeight = 255,
            landblockSize = 192, cellSize = 24, gridPerLandblock = 9, verticesPerLandblock = 81,
            totalLandblocks = 255 * 255, modifiedLandblocks = r.ModifiedLandblocks,
            heightTableSize = r.HeightTableSize, heightMin = r.HeightMin, heightMax = r.HeightMax,
            portalIteration = r.PortalIteration });
    }

    private string CmdGetRegion() {
        var r = _engine.GetRegion();
        return Serialize(new { success = true, command = "get-region",
            heightTable = r.HeightTable.Select(h => Math.Round(h, 2)).ToArray(),
            heightTableSize = r.HeightTable.Length,
            terrainTypeCount = r.TerrainTypes?.Count,
            terrainTypes = r.TerrainTypes?.Select(tt => new { index = tt.Index, name = tt.Name }).ToArray() });
    }

    // ════════════════════════════════════════════════════
    //  Ontology
    // ════════════════════════════════════════════════════

    private string CmdScanOntology(System.Text.Json.Nodes.JsonNode node) {
        bool scanGfxObjs = node["scanGfxObjs"]?.GetValue<bool>() ?? true;
        var r = _engine.ScanOntology(scanGfxObjs);
        var rpt = r.Report;
        return Serialize(new { success = true, command = "scan-ontology",
            totalSetups = rpt.TotalSetups, totalGfxObjs = rpt.TotalGfxObjs,
            totalEntries = rpt.TotalEntries, scanTimeMs = Math.Round(rpt.ScanTimeMs, 0),
            categories = rpt.CategoryCounts.OrderByDescending(kv => kv.Value)
                .Select(kv => new { category = kv.Key, count = kv.Value }).ToArray(),
            scales = rpt.ScaleCounts.OrderByDescending(kv => kv.Value)
                .Select(kv => new { scale = kv.Key, count = kv.Value }).ToArray() });
    }

    private string CmdQueryOntology(System.Text.Json.Nodes.JsonNode node) {
        string? category = node["category"]?.GetValue<string>();
        string? scale = node["scale"]?.GetValue<string>();
        string? keyword = node["keyword"]?.GetValue<string>();
        int limit = node["limit"]?.GetValue<int>() ?? 50;

        uint? objectId = null;
        var idStr = node["objectId"]?.GetValue<string>();
        if (!string.IsNullOrEmpty(idStr)) {
            objectId = uint.Parse(idStr.Replace("0x", ""), System.Globalization.NumberStyles.HexNumber);
        }

        var r = _engine.QueryOntology(category, scale, keyword, objectId, limit);
        return Serialize(new { success = true, command = "query-ontology",
            totalIndexed = r.TotalIndexed, returned = r.Entries.Length,
            entries = r.Entries.Select(e => new {
                objectId = $"0x{e.ObjectId:X8}", datType = e.DatType,
                category = e.Category, scale = e.Scale,
                source = e.ClassificationSource,
                maxDimension = Math.Round(e.MaxDimension, 2),
                aspectRatio = Math.Round(e.AspectRatio, 2),
                partCount = e.PartCount, polyCount = e.PolyCount,
                tags = e.Tags
            }).ToArray() });
    }

    private string CmdOntologyStats() {
        var r = _engine.GetOntologyStats();
        return Serialize(new { success = true, command = "ontology-stats",
            totalEntries = r.TotalEntries,
            categories = r.CategoryCounts.OrderByDescending(kv => kv.Value)
                .Select(kv => new { category = kv.Key, count = kv.Value }).ToArray(),
            scales = r.ScaleCounts.OrderByDescending(kv => kv.Value)
                .Select(kv => new { scale = kv.Key, count = kv.Value }).ToArray(),
            coverage = new {
                withName = r.WithName,
                withWeenieClassId = r.WithWeenieClassId,
                withLevel = r.WithLevel,
                withCreatureType = r.WithCreatureType
            },
            weenieTypes = r.WeenieTypeCounts?.OrderByDescending(kv => kv.Value)
                .Select(kv => new { type = kv.Key, count = kv.Value }).ToArray() });
    }

    // ════════════════════════════════════════════════════
    //  Stamp & Portal
    // ════════════════════════════════════════════════════

    private string CmdPasteStamp(System.Text.Json.Nodes.JsonNode node) {
        float srcMinX = F(node, "srcMinX"), srcMinY = F(node, "srcMinY");
        float srcMaxX = F(node, "srcMaxX"), srcMaxY = F(node, "srcMaxY");
        float destX = F(node, "destX"), destY = F(node, "destY");
        bool includeObjects = node["includeObjects"]?.GetValue<bool>() ?? false;
        bool blendEdges = node["blendEdges"]?.GetValue<bool>() ?? true;
        float zOffset = node["zOffset"]?.GetValue<float>() ?? 0f;
        var r = _engine.PasteStamp(srcMinX, srcMinY, srcMaxX, srcMaxY, destX, destY, includeObjects, blendEdges, zOffset);
        return Serialize(new { success = true, command = "paste-stamp",
            terrainChanges = r.TerrainChanges, objectsPlaced = r.ObjectsPlaced,
            landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdGetBulkHeightmap(System.Text.Json.Nodes.JsonNode node) {
        uint minX = U(node, "minX"), minY = U(node, "minY");
        uint maxX = U(node, "maxX"), maxY = U(node, "maxY");
        var r = _engine.GetBulkHeightmap(minX, minY, maxX, maxY);
        return Serialize(new { success = true, command = "get-bulk-heightmap",
            totalLandblocks = r.TotalLandblocks, foundLandblocks = r.FoundLandblocks,
            heightmaps = r.Heightmaps.Select(h => new {
                landblock = $"0x{h.LbKey:X4}", lbX = h.LbX, lbY = h.LbY,
                worldOriginX = h.LbX * 192, worldOriginY = h.LbY * 192,
                gridSize = 9, cellSize = 24,
                heightsWorld = h.HeightsWorld, heightIndices = h.HeightIndices
            }).ToArray() });
    }

    private string CmdGetObjectDetail(System.Text.Json.Nodes.JsonNode node) {
        var idStr = node["objectId"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'objectId'");
        uint objectId = uint.Parse(idStr.Replace("0x", ""), System.Globalization.NumberStyles.HexNumber);
        var r = _engine.GetObjectDetail(objectId);
        if (!r.Found) return Serialize(new { success = true, command = "get-object-detail",
            objectId = r.ObjectIdHex, datType = r.DatType, found = false });
        return Serialize(new { success = true, command = "get-object-detail",
            objectId = r.ObjectIdHex, datType = r.DatType, found = true,
            partCount = r.PartCount, polyCount = r.PolyCount, vertexCount = r.VertexCount,
            maxDimension = Math.Round(r.MaxDimension, 2),
            boundsMin = r.BoundsMin?.Select(v => Math.Round(v, 2)).ToArray(),
            boundsMax = r.BoundsMax?.Select(v => Math.Round(v, 2)).ToArray(),
            boundsSize = r.BoundsSize?.Select(v => Math.Round(v, 2)).ToArray(),
            surfaceCount = r.SurfaceIds?.Count ?? 0, surfaceIds = r.SurfaceIds,
            ontologyCategory = r.OntologyCategory, ontologyScale = r.OntologyScale,
            ontologyTags = r.OntologyTags });
    }

    private string CmdDiffTerrain(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var r = _engine.DiffTerrain(lbX, lbY);
        if (!r.Found) return Serialize(new { success = true, command = "diff-terrain",
            landblock = $"0x{r.LbKey:X4}", found = false });
        return Serialize(new { success = true, command = "diff-terrain",
            landblock = $"0x{r.LbKey:X4}", found = true,
            hasChanges = r.HasChanges, totalVertices = r.TotalVertices,
            changedVertices = r.ChangedVertices,
            heightChanges = r.HeightChanges, terrainTypeChanges = r.TerrainTypeChanges,
            roadChanges = r.RoadChanges,
            changes = r.Changes?.Select(c => new {
                gridX = c.GridX, gridY = c.GridY, vertexIndex = c.VertexIndex,
                oldHeight = (int)c.OldHeight, newHeight = (int)c.NewHeight,
                oldTerrainType = (int)c.OldTerrainType, newTerrainType = (int)c.NewTerrainType,
                oldRoad = (int)c.OldRoad, newRoad = (int)c.NewRoad
            }).ToArray() });
    }

    private string CmdSnapPortal(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var targetCellStr = node["targetCellNumber"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'targetCellNumber'");
        ushort targetCellNum = ushort.Parse(targetCellStr.Replace("0x", ""), System.Globalization.NumberStyles.HexNumber);
        var targetPolyStr = node["targetPortalPolyId"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'targetPortalPolyId'");
        ushort targetPolyId = ushort.Parse(targetPolyStr.Replace("0x", ""), System.Globalization.NumberStyles.HexNumber);
        var sourceEnvStr = node["sourceEnvId"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'sourceEnvId'");
        ushort sourceEnvId = ushort.Parse(sourceEnvStr.Replace("0x", ""), System.Globalization.NumberStyles.HexNumber);
        ushort sourceCellStruct = node["sourceCellStruct"]?.GetValue<ushort>() ?? 0;
        var r = _engine.SnapPortal(lbX, lbY, targetCellNum, targetPolyId, sourceEnvId, sourceCellStruct);
        return Serialize(new { success = true, command = "snap-portal",
            landblock = $"0x{r.LbKey:X4}",
            targetCellNumber = $"0x{r.TargetCellNumber:X4}",
            targetPortalPolygonId = $"0x{r.TargetPortalPolygonId:X4}",
            newCellNumber = $"0x{r.NewCellNumber:X4}",
            sourceEnvironmentId = $"0x{r.SourceEnvironmentId:X4}",
            sourceCellStructure = r.SourceCellStructure,
            newOrigin = new { x = Math.Round(r.NewOrigin.X, 2), y = Math.Round(r.NewOrigin.Y, 2), z = Math.Round(r.NewOrigin.Z, 2) },
            newOrientation = FmtQ(r.NewOrientation),
            portalCount = r.PortalCount });
    }

    // ════════════════════════════════════════════════════
    //  Help
    // ════════════════════════════════════════════════════

    private string CmdHelp() {
        var commands = new[] {
            new { name = "load",             args = "path",                                  description = "Load a .wbproj project" },
            new { name = "export",           args = "directory, iteration?",                 description = "Export DATs" },
            new { name = "info",             args = "",                                      description = "Show project info" },
            new { name = "smooth",           args = "x, y, radius, strength?",               description = "Smooth terrain" },
            new { name = "raise",            args = "x, y, radius, delta?",                  description = "Raise terrain" },
            new { name = "lower",            args = "x, y, radius, delta?",                  description = "Lower terrain" },
            new { name = "set-height",       args = "x, y, radius, height",                  description = "Set terrain height" },
            new { name = "paint",            args = "x, y, radius, type",                    description = "Paint terrain texture" },
            new { name = "fill",             args = "x, y, type",                            description = "Flood-fill terrain" },
            new { name = "road",             args = "x1, y1, x2, y2, value?",                description = "Draw road path" },
            new { name = "get-height",       args = "x, y",                                  description = "Query terrain height at point" },
            new { name = "terrain-info",     args = "lbX, lbY",                              description = "Landblock statistics" },
            new { name = "get-heightmap",    args = "lbX, lbY",                              description = "Full 9×9 heightmap grid" },
            new { name = "get-terrain-data", args = "lbX, lbY",                              description = "All vertex data" },
            new { name = "list-objects",     args = "lbX, lbY",                              description = "List static objects" },
            new { name = "add-object",       args = "lbX, lbY, modelId, x, y, z, qw?, qx?, qy?, qz?, scale?", description = "Place object" },
            new { name = "remove-object",    args = "lbX, lbY, index",                       description = "Remove object by index" },
            new { name = "clear-objects",    args = "lbX, lbY | all=true",                   description = "Clear all objects from one landblock or whole world" },
            new { name = "move-object",      args = "lbX, lbY, index, x, y, z",              description = "Move object" },
            new { name = "rotate-object",    args = "lbX, lbY, index, qw/qx/qy/qz | yaw",   description = "Set object orientation (absolute, not incremental)" },
            new { name = "query-radius",     args = "x, y, radius, z?, includeZ?",            description = "Find objects within radius" },
            new { name = "analyze-dungeons", args = "outputPath?",                            description = "Scan dungeon rooms" },
            new { name = "analyze-dungeon-catalog", args = "outputPath?",                     description = "Extract full room catalog (bounds, portals, dims, classification)" },
            new { name = "analyze-dungeon-topology", args = "outputPath?",                    description = "Extract portal graph topology (DAG, depth, branching, classification)" },
            new { name = "get-dungeon-info", args = "lbX, lbY",                              description = "Dungeon cell layout" },
            new { name = "validate-dungeon", args = "lbX, lbY",                              description = "Validate dungeon" },
            new { name = "validate-landblock", args = "lbX, lbY",                            description = "Validate landblock objects (LBK010 footprint flush check fires when ontology is scanned)" },
            new { name = "validate-terrain", args = "lbX, lbY, cliffThreshold?",             description = "Validate terrain" },
            new { name = "validate-building-shells", args = "lbX, lbY",                      description = "Validate building shells (BSH009 group-Z divergence when pairings are loaded)" },
            new { name = "validate-building-portals", args = "lbX, lbY",                     description = "Validate building portals" },
            new { name = "validate-all",     args = "lbX, lbY, cliffThreshold?",             description = "Run all validators (footprint flush + cliffs + portals)" },
            new { name = "list-landblocks",  args = "minX?, minY?, maxX?, maxY?, limit?",    description = "List landblocks" },
            new { name = "get-world-info",   args = "",                                      description = "World metadata" },
            new { name = "get-region",       args = "",                                      description = "Height table and terrain types" },
            new { name = "scan-ontology",    args = "scanGfxObjs?",                             description = "Scan DAT to classify all models" },
            new { name = "query-ontology",   args = "category?, scale?, keyword?, objectId?, limit?", description = "Query the ontology index" },
            new { name = "ontology-stats",   args = "",                                      description = "Ontology category/scale breakdown" },
            new { name = "paste-stamp",      args = "srcMinX, srcMinY, srcMaxX, srcMaxY, destX, destY, includeObjects?, blendEdges?, zOffset?", description = "Copy & paste terrain" },
            new { name = "snap-portal",      args = "lbX, lbY, targetCellNumber, targetPortalPolyId, sourceEnvId, sourceCellStruct", description = "Snap dungeon cell to portal" },
            new { name = "get-bulk-heightmap", args = "minX, minY, maxX, maxY",               description = "Multi-landblock heightmaps in one call" },
            new { name = "get-object-detail", args = "objectId",                              description = "DAT model geometry & ontology info" },
            new { name = "diff-terrain",     args = "lbX, lbY",                              description = "Compare current terrain vs base DAT" },
            new { name = "get-terrain-layers", args = "lbX, lbY",                              description = "Terrain type distribution per landblock" },
            new { name = "export-textures",  args = "outputDir, minId?, maxId?",               description = "Export RenderSurface textures to PNG" },
            new { name = "import-texture",   args = "textureId, imagePath",                    description = "Replace a texture from image file" },
            new { name = "clone-dat",        args = "outputPath",                              description = "Clone portal DAT to a new file" },
            new { name = "defragment-dat",   args = "datType, outputPath",                     description = "Defragment DAT (portal/cell/local)" },
            new { name = "export-ontology",  args = "outputPath",                              description = "Export ontology to CSV" },
            new { name = "export-setup-parts", args = "outputPath",                            description = "Export Setup -> Parts (GfxObj) JSONL" },
            new { name = "export-classification-signals", args = "outputPath",                 description = "Export building/scenery setup IDs (JSON)" },
            new { name = "mine-strings",     args = "outputPath?, filter?",                     description = "Extract strings from DAT StringTables" },
            new { name = "enrich-ontology",  args = "",                                      description = "Enrich ontology with schema names & creature families" },
            new { name = "import-catalog",   args = "indexPath",                                description = "Import ACViewer catalog into ontology" },
            new { name = "classify-ontology", args = "",                                      description = "Auto-tag ontology from StringTable names" },
            new { name = "enrich-materials", args = "",                                       description = "Tag materials from texture analysis" },
            new { name = "ingest-weenies",  args = "lsdPath, outputPath?",                     description = "Batch-extract weenie data to summary file" },
            new { name = "enrich-weenies",  args = "summaryPath",                               description = "Merge weenie data into live ontology" },
            new { name = "enrich-canonical", args = "path",                                      description = "Merge canonical enrichment (architecture, biome, behavior)" },
            new { name = "enrich-unified",   args = "path",                                      description = "Merge unified ontology (canonical + ACE world + Setup->Parts + DAT signals + geometry)" },
            new { name = "cache-ontology",   args = "outputPath?",                              description = "Persist live ontology to JSONL (default <project_dir>/ontology_cache.jsonl)" },
            new { name = "load-ontology-cache", args = "inputPath?",                            description = "Restore ontology from JSONL cache" },
            new { name = "scan-building-placements", args = "outputPath?",                         description = "Extract building positions for culture mapping" },
            new { name = "difficulty-gradient", args = "gradientPath?",                             description = "Load & validate difficulty gradient" },
            new { name = "apply-population", args = "planPath, dryRun?",                            description = "Apply population plan to world" },
            new { name = "ingest-spawn-maps", args = "lsdPath, outputPath?",                   description = "Extract spawn placement data" },
            new { name = "ingest-spells",   args = "lsdPath, outputPath?",                     description = "Parse spells.json to summary file" },
            new { name = "ingest-recipes",  args = "lsdPath, outputPath?",                     description = "Batch-extract recipe data to summary file" },
            new { name = "benchmark",        args = "",                                         description = "Run speed test suite (terrain, objects, validation, bulk)" },
            new { name = "set-landblock-heightmap", args = "lbX, lbY, heights",                  description = "Set all 81 heights in one call" },
            new { name = "set-landblock-terrain", args = "lbX, lbY, types",                      description = "Set all 81 terrain types in one call" },
            new { name = "bulk-place-objects", args = "lbX, lbY, objects[]",                      description = "Place multiple objects in one call" },
            new { name = "generate-terrain", args = "seed, octaves?, lacunarity?, persistence?, amplitude?, coastline?", description = "Generate full-world procedural terrain" },
            new { name = "generate-dungeon", args = "lbX, lbY, depth?, branching?, seed?, minRooms?, maxRooms?, theme?", description = "Generate procedural dungeon from graph grammar" },
            new { name = "auto-paint",       args = "",                                            description = "Re-paint all terrain types from heightmap" },
            new { name = "analyze-landblock-patterns", args = "minX?, minY?, maxX?, maxY?, outputPath?", description = "Extract spatial design patterns from populated landblocks" },
            new { name = "extract-building-pairings", args = "minCount5?, outputPath?", description = "Mine retail Structure×Structure adjacency at 5m → building_pairings.json (drives group-aware placement)" },
            new { name = "load-building-pairings", args = "path", description = "Load building_pairings.json into the live registry" },
            new { name = "export-training-data", args = "minX?, minY?, maxX?, maxY?, outputPath?, nearbyLimit?", description = "Export placement examples as JSONL (one per object with terrain + neighbors + ontology)" },
            new { name = "export-raw-world-facts", args = "minX?, minY?, maxX?, maxY?, outputPath?, includeAceDb?, includeLinks?", description = "Export raw DAT/SQL/spawn facts as JSONL" },
            new { name = "export-envcell-components", args = "minX?, minY?, maxX?, maxY?, outputPath?", description = "Export linked surface-anchor and EnvCell components as JSONL" },
            new { name = "generate-settlement", args = "template, centerX, centerY, seed?", description = "Generate constraint-based settlement from template" },
            new { name = "extract-retail-heightmaps", args = "outputPath?", description = "Dump all 255×255 landblock heightmaps as JSONL" },
            new { name = "compute-vanilla-baseline", args = "outputPath?", description = "Compute retail quality baseline metrics (density, terrain dist, etc.)" },
            new { name = "render-preview",   args = "lbX, lbY, radius?, resolution?, overlay?, includePng?, outputPath?", description = "Top-down PNG of an N×N landblock region (terrain + objects + cliff/pairing overlays). Returns base64 PNG." },
            new { name = "compare-to-retail", args = "generated, retailBaseline?, topK?, anomalyMinModel?, perLandblock?, cacheDir?", description = "Subprocess the Python comparator; score generated world vs retail with per-LB drilldown and class-space ratio. Caches retail snapshot for tight tuning loops." },
            new { name = "quit",             args = "",                                      description = "Exit terminal" }
        };
        return Serialize(new { success = true, command = "help", protocol = "json-line", version = "1.5",
            description = "Send one JSON object per line. Each must have a 'command' field.", commands });
    }

    // ════════════════════════════════════════════════════
    //  Terrain layers
    // ════════════════════════════════════════════════════

    private string CmdGetTerrainLayers(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var r = _engine.GetTerrainLayers(lbX, lbY);
        return Serialize(new { success = true, command = "get-terrain-layers",
            landblock = $"0x{r.LbKey:X4}",
            found = r.Found, totalVertices = r.TotalVertices,
            layers = r.Layers?.Select(l => new {
                typeIndex = l.TypeIndex, name = l.Name,
                vertexCount = l.VertexCount, percentage = l.Percentage
            }).ToArray() });
    }

    // ════════════════════════════════════════════════════
    //  DAT extension commands
    // ════════════════════════════════════════════════════

    private string CmdExportTextures(System.Text.Json.Nodes.JsonNode node) {
        var outputDir = node["outputDir"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outputDir' field");
        uint? minId = node["minId"]?.GetValue<uint>();
        uint? maxId = node["maxId"]?.GetValue<uint>();
        var r = _engine.ExportTextures(outputDir, minId, maxId);
        return Serialize(new { success = r.Success, command = "export-textures",
            exported = r.Exported, failed = r.Failed,
            outputDirectory = r.OutputDirectory, errors = r.Errors });
    }

    private string CmdImportTexture(System.Text.Json.Nodes.JsonNode node) {
        uint textureId = U(node, "textureId");
        var imagePath = node["imagePath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'imagePath' field");
        var r = _engine.ImportTexture(textureId, imagePath);
        return Serialize(new { success = r.Success, command = "import-texture",
            textureId = $"0x{r.TextureId:X8}", inputFile = r.InputFile,
            error = r.Error });
    }

    private string CmdCloneDat(System.Text.Json.Nodes.JsonNode node) {
        var outputPath = node["outputPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outputPath' field");
        var r = _engine.CloneDat(outputPath);
        return Serialize(new { success = r.Success, command = "clone-dat",
            sourcePath = r.SourcePath, destPath = r.DestPath, error = r.Error });
    }

    private string CmdDefragmentDat(System.Text.Json.Nodes.JsonNode node) {
        var datType = node["datType"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'datType' field");
        var outputPath = node["outputPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outputPath' field");
        var r = _engine.DefragmentDat(datType, outputPath);
        return Serialize(new { success = r.Success, command = "defragment-dat",
            datType = r.DatType, outputPath = r.OutputPath,
            bytesFreed = r.BytesFreed, error = r.Error });
    }

    // ════════════════════════════════════════════════════
    //  Ontology export
    // ════════════════════════════════════════════════════

    private string CmdExportOntology(System.Text.Json.Nodes.JsonNode node) {
        var outputPath = node["outputPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outputPath' field");
        var r = _engine.ExportOntology(outputPath);
        return Serialize(new { success = r.Success, command = "export-ontology",
            entriesExported = r.EntriesExported, outputPath = r.OutputPath });
    }

    private string CmdExportSetupParts(System.Text.Json.Nodes.JsonNode node) {
        var outputPath = node["outputPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outputPath' field");
        var r = _engine.ExportSetupParts(outputPath);
        return Serialize(new {
            success = r.Success, command = "export-setup-parts",
            setupsScanned = r.SetupsScanned, setupsExported = r.SetupsExported,
            totalParts = r.TotalParts, uniqueParts = r.UniqueParts,
            outputPath = r.OutputPath, error = r.Error
        });
    }

    private string CmdExportClassificationSignals(System.Text.Json.Nodes.JsonNode node) {
        var outputPath = node["outputPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outputPath' field");
        var r = _engine.ExportClassificationSignals(outputPath);
        return Serialize(new {
            success = r.Success, command = "export-classification-signals",
            buildingModelCount = r.BuildingModelCount,
            landBlockInfoScanned = r.LandBlockInfoScanned,
            scenerySetupCount = r.ScenerySetupCount,
            scenesScanned = r.ScenesScanned,
            outputPath = r.OutputPath, error = r.Error
        });
    }

    private string CmdMineStrings(System.Text.Json.Nodes.JsonNode node) {
        var outputPath = node["outputPath"]?.GetValue<string>();
        var filter = node["filter"]?.GetValue<string>();
        var r = _engine.MineStrings(outputPath, filter);
        return Serialize(new { success = r.Success, command = "mine-strings",
            tablesScanned = r.TablesScanned, totalStrings = r.TotalStrings,
            outputPath = r.OutputPath,
            error = r.Error,
            strings = r.Strings.Take(100).Select(s => new {
                hash = $"0x{s.Hash:X8}", text = s.Text, tableType = s.TableType
            }).ToArray(),
            truncated = r.TotalStrings > 100 });
    }

    private string CmdEnrichOntology() {
        var r = _engine.EnrichOntology();
        return Serialize(new { success = r.Success, command = "enrich-ontology",
            entriesEnriched = r.EntriesEnriched, totalEntries = r.TotalEntries,
            error = r.Error });
    }

    private string CmdImportCatalog(System.Text.Json.Nodes.JsonNode node) {
        var indexPath = node["indexPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'indexPath' field");
        var r = _engine.ImportCatalog(indexPath);
        return Serialize(new { success = r.Success, command = "import-catalog",
            entriesEnriched = r.EntriesEnriched, totalEntries = r.TotalEntries,
            indexPath = r.IndexPath, error = r.Error });
    }

    private string CmdClassifyOntology() {
        var r = _engine.ClassifyOntology();
        return Serialize(new { success = r.Success, command = "classify-ontology",
            stringsUsed = r.StringsUsed, entriesEnriched = r.EntriesEnriched,
            totalEntries = r.TotalEntries, error = r.Error });
    }

    private string CmdEnrichMaterials() {
        var r = _engine.EnrichMaterials();
        return Serialize(new { success = r.Success, command = "enrich-materials",
            entriesEnriched = r.EntriesEnriched, totalEntries = r.TotalEntries,
            error = r.Error });
    }

    // ════════════════════════════════════════════════════
    //  LSD Data Ingestion Pipeline
    // ════════════════════════════════════════════════════

    private string CmdIngestWeenies(System.Text.Json.Nodes.JsonNode node) {
        var lsdPath = node["lsdPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'lsdPath' field");
        var outputPath = node["outputPath"]?.GetValue<string>();
        var r = _engine.IngestWeenies(lsdPath, outputPath);
        return Serialize(new { success = r.Success, command = "ingest-weenies",
            totalProcessed = r.TotalProcessed, creatureCount = r.CreatureCount,
            npcCount = r.NpcCount, itemCount = r.ItemCount, otherCount = r.OtherCount,
            withSetupDid = r.WithSetupDid, outputPath = r.OutputPath,
            error = r.Error });
    }

    private string CmdEnrichWeenies(System.Text.Json.Nodes.JsonNode node) {
        var summaryPath = node["summaryPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'summaryPath' field");
        var r = _engine.EnrichWeenies(summaryPath);
        return Serialize(new { success = r.Success, command = "enrich-weenies",
            entriesEnriched = r.EntriesEnriched, totalEntries = r.TotalEntries,
            error = r.Error });
    }

    private string CmdCacheOntology(System.Text.Json.Nodes.JsonNode node) {
        var outputPath = node["outputPath"]?.GetValue<string>() ?? node["path"]?.GetValue<string>()
            ?? _engine.DefaultOntologyCachePath();
        var r = _engine.CacheOntology(outputPath);
        return Serialize(new {
            success = r.Success, command = "cache-ontology",
            entriesCached = r.EntriesCached, outputPath = r.OutputPath, error = r.Error,
        });
    }

    private string CmdLoadOntologyCache(System.Text.Json.Nodes.JsonNode node) {
        var inputPath = node["inputPath"]?.GetValue<string>() ?? node["path"]?.GetValue<string>()
            ?? _engine.DefaultOntologyCachePath();
        var r = _engine.LoadOntologyCache(inputPath);
        return Serialize(new {
            success = r.Success, command = "load-ontology-cache",
            entriesLoaded = r.EntriesLoaded, inputPath = r.InputPath, error = r.Error,
        });
    }

    private string CmdEnrichUnified(System.Text.Json.Nodes.JsonNode node) {
        var path = node["path"]?.GetValue<string>()
            ?? node["unifiedJsonPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'path' field");
        var r = _engine.EnrichUnified(path);
        return Serialize(new {
            success = r.Success, command = "enrich-unified",
            entriesEnriched = r.EntriesEnriched, totalEntries = r.TotalEntries,
            unifiedPath = r.UnifiedPath, error = r.Error,
        });
    }

    private string CmdEnrichCanonical(System.Text.Json.Nodes.JsonNode node) {
        var canonicalPath = node["path"]?.GetValue<string>()
            ?? node["canonicalPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'path' or 'canonicalPath' field");
        var r = _engine.EnrichCanonical(canonicalPath);
        return Serialize(new { success = r.Success, command = "enrich-canonical",
            entriesEnriched = r.EntriesEnriched, totalEntries = r.TotalEntries,
            canonicalPath = r.CanonicalPath,
            error = r.Error });
    }

    private string CmdScanBuildingPlacements(System.Text.Json.Nodes.JsonNode node) {
        var outputPath = node["outputPath"]?.GetValue<string>();
        var r = _engine.ScanBuildingPlacements(outputPath);
        return Serialize(new { success = r.Success, command = "scan-building-placements",
            totalBuildings = r.TotalBuildings, uniqueSetupIds = r.UniqueSetupIds,
            landblocksWithBuildings = r.LandblocksWithBuildings,
            elapsedMs = Math.Round(r.ElapsedMs, 0),
            outputPath = r.OutputPath,
            error = r.Error });
    }

    private string CmdDifficultyGradient(System.Text.Json.Nodes.JsonNode node) {
        var gradientPath = node["path"]?.GetValue<string>()
            ?? node["gradientPath"]?.GetValue<string>();
        var r = _engine.LoadDifficultyGradient(gradientPath);
        return Serialize(new { success = r.Success, command = "difficulty-gradient",
            gradientPath = r.GradientPath,
            tierDistribution = r.TierDistribution,
            error = r.Error });
    }

    private string CmdApplyPopulation(System.Text.Json.Nodes.JsonNode node) {
        var planPath = node["path"]?.GetValue<string>()
            ?? node["planPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'path' or 'planPath' field");
        var dryRun = node["dryRun"]?.GetValue<bool>() ?? false;
        var r = _engine.ApplyPopulation(planPath, dryRun);
        return Serialize(new { success = r.Success, command = "apply-population",
            landblocksModified = r.LandblocksModified, objectsPlaced = r.ObjectsPlaced,
            objectsSkipped = r.ObjectsSkipped, elapsedMs = Math.Round(r.ElapsedMs, 0),
            planPath = r.PlanPath, dryRun,
            error = r.Error });
    }

    private string CmdIngestSpawnMaps(System.Text.Json.Nodes.JsonNode node) {
        var lsdPath = node["lsdPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'lsdPath' field");
        var outputPath = node["outputPath"]?.GetValue<string>();
        var r = _engine.IngestSpawnMaps(lsdPath, outputPath);
        return Serialize(new { success = r.Success, command = "ingest-spawn-maps",
            totalProcessed = r.TotalProcessed, totalWeenies = r.TotalWeenies,
            totalLinks = r.TotalLinks, uniqueWcids = r.UniqueWcids,
            outputPath = r.OutputPath, error = r.Error });
    }

    private string CmdIngestSpells(System.Text.Json.Nodes.JsonNode node) {
        var lsdPath = node["lsdPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'lsdPath' field");
        var outputPath = node["outputPath"]?.GetValue<string>();
        var r = _engine.IngestSpells(lsdPath, outputPath);
        return Serialize(new { success = r.Success, command = "ingest-spells",
            totalProcessed = r.TotalProcessed,
            schools = r.SchoolCounts.OrderBy(kv => kv.Key)
                .Select(kv => new { school = kv.Key, count = kv.Value }).ToArray(),
            outputPath = r.OutputPath, error = r.Error });
    }

    private string CmdIngestRecipes(System.Text.Json.Nodes.JsonNode node) {
        var lsdPath = node["lsdPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'lsdPath' field");
        var outputPath = node["outputPath"]?.GetValue<string>();
        var r = _engine.IngestRecipes(lsdPath, outputPath);
        return Serialize(new { success = r.Success, command = "ingest-recipes",
            totalProcessed = r.TotalProcessed, withPrecursors = r.WithPrecursors,
            uniqueSourceWcids = r.UniqueSourceWcids, uniqueResultWcids = r.UniqueResultWcids,
            skills = r.SkillCounts.OrderBy(kv => kv.Key)
                .Select(kv => new { skill = kv.Key, count = kv.Value }).ToArray(),
            outputPath = r.OutputPath, error = r.Error });
    }

    // ════════════════════════════════════════════════════
    //  Benchmark & Bulk Operations
    // ════════════════════════════════════════════════════

    private string CmdBenchmark() {
        var r = _engine.RunBenchmark();
        return Serialize(new { success = true, command = "benchmark",
            tests = r.Tests.Select(t => new {
                name = t.Name, operations = t.Operations,
                elapsedMs = t.ElapsedMs, opsPerSec = t.OpsPerSec,
                firstSegmentOpsPerSec = t.FirstSegmentOpsPerSec,
                lastSegmentOpsPerSec = t.LastSegmentOpsPerSec,
                degradationPercent = t.DegradationPercent
            }).ToArray(),
            memory = r.Memory.Select(m => new {
                label = m.Label, bytes = m.Bytes,
                megabytes = Math.Round(m.Bytes / 1024.0 / 1024.0, 1)
            }).ToArray(),
            gcCollections = new {
                gen0 = r.GcAfter.Gen0 - r.GcBefore.Gen0,
                gen1 = r.GcAfter.Gen1 - r.GcBefore.Gen1,
                gen2 = r.GcAfter.Gen2 - r.GcBefore.Gen2
            },
            extrapolation = new {
                terrainVertexOpsPerSec = r.Extrapolation.TerrainVertexOpsPerSec,
                totalVertexWrites = r.Extrapolation.TotalVertexWrites,
                estimatedTerrainPassSeconds = r.Extrapolation.EstimatedTerrainPassSeconds,
                estimatedTerrainPassFormatted = r.Extrapolation.EstimatedTerrainPassFormatted,
                bulkLandblockOpsPerSec = r.Extrapolation.BulkLandblockOpsPerSec,
                totalLandblocks = r.Extrapolation.TotalLandblocks,
                estimatedBulkTerrainPassSeconds = r.Extrapolation.EstimatedBulkTerrainPassSeconds,
                estimatedBulkTerrainPassFormatted = r.Extrapolation.EstimatedBulkTerrainPassFormatted,
                objectOpsPerSec = r.Extrapolation.ObjectOpsPerSec,
                totalObjectPlacements = r.Extrapolation.TotalObjectPlacements,
                estimatedObjectPassSeconds = r.Extrapolation.EstimatedObjectPassSeconds,
                estimatedObjectPassFormatted = r.Extrapolation.EstimatedObjectPassFormatted,
                feasibility = r.Extrapolation.Feasibility
            }
        });
    }

    private string CmdSetLandblockHeightmap(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var heightsNode = node["heights"] ?? throw new ArgumentException("Missing 'heights' field");
        byte[] heights = ParseByteArrayField(heightsNode, "heights");
        var r = _engine.SetLandblockHeightmap(lbX, lbY, heights);
        return Serialize(new { success = true, command = "set-landblock-heightmap",
            landblock = $"0x{r.LbKey:X4}", verticesModified = r.VerticesModified,
            landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdSetLandblockTerrain(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var typesNode = node["types"] ?? throw new ArgumentException("Missing 'types' field");
        byte[] types = ParseByteArrayField(typesNode, "types");
        var r = _engine.SetLandblockTerrain(lbX, lbY, types);
        return Serialize(new { success = true, command = "set-landblock-terrain",
            landblock = $"0x{r.LbKey:X4}", verticesModified = r.VerticesModified,
            landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdBulkPlaceObjects(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        var objectsArr = node["objects"] as System.Text.Json.Nodes.JsonArray
            ?? throw new ArgumentException("Missing 'objects' array");
        var objects = new List<(uint modelId, float x, float y, float z)>(objectsArr.Count);
        foreach (var obj in objectsArr) {
            if (obj == null) continue;
            var midStr = obj["modelId"]?.GetValue<string>() ?? "0";
            uint mid = uint.Parse(midStr.Replace("0x", ""), System.Globalization.NumberStyles.HexNumber);
            float x = obj["x"]?.GetValue<float>() ?? 0;
            float y = obj["y"]?.GetValue<float>() ?? 0;
            float z = obj["z"]?.GetValue<float>() ?? 0;
            objects.Add((mid, x, y, z));
        }
        var r = _engine.BulkPlaceObjects(lbX, lbY, objects);
        return Serialize(new { success = true, command = "bulk-place-objects",
            landblock = $"0x{r.LbKey:X4}", placed = r.Placed, errors = r.Errors,
            errorMessages = r.ErrorMessages });
    }

    // ════════════════════════════════════════════════════
    //  Procedural Generation
    // ════════════════════════════════════════════════════

    private string CmdGenerateTerrain(System.Text.Json.Nodes.JsonNode node) {
        int seed = node["seed"]?.GetValue<int>() ?? throw new ArgumentException("Missing 'seed' field");
        int octaves = node["octaves"]?.GetValue<int>() ?? 6;
        float lacunarity = node["lacunarity"]?.GetValue<float>() ?? 2f;
        float persistence = node["persistence"]?.GetValue<float>() ?? 0.5f;
        float amplitude = node["amplitude"]?.GetValue<float>() ?? 128f;
        bool autoPaint = node["autoPaint"]?.GetValue<bool>() ?? true;

        List<(float X, float Y)>? coastline = null;
        var coastlineNode = node["coastline"];
        if (coastlineNode is System.Text.Json.Nodes.JsonArray coastArr && coastArr.Count >= 3) {
            coastline = new List<(float, float)>();
            foreach (var pt in coastArr) {
                if (pt is System.Text.Json.Nodes.JsonArray pair && pair.Count >= 2) {
                    coastline.Add((pair[0]!.GetValue<float>(), pair[1]!.GetValue<float>()));
                }
            }
        }

        var r = _engine.GenerateTerrain(seed, octaves, lacunarity, persistence, amplitude, coastline, autoPaint);
        return Serialize(new { success = r.Success, command = "generate-terrain",
            seed = r.Seed, octaves = r.Octaves, lacunarity = r.Lacunarity,
            persistence = r.Persistence, amplitude = r.Amplitude,
            landblocksWritten = r.LandblocksWritten,
            verticesWritten = r.VerticesWritten,
            elapsedMs = r.ElapsedMs,
            landblocksPerSec = r.LandblocksPerSec,
            hasCoastline = r.HasCoastline,
            autoPainted = r.AutoPainted,
            error = r.Error });
    }

    private string CmdAutoPaint() {
        var r = _engine.AutoPaintTerrain();
        return Serialize(new { success = r.Success, command = "auto-paint",
            landblocksWritten = r.LandblocksWritten,
            verticesPainted = r.VerticesPainted,
            elapsedMs = r.ElapsedMs,
            waterVertices = r.WaterVertices,
            sandVertices = r.SandVertices,
            grassVertices = r.GrassVertices,
            rockVertices = r.RockVertices,
            snowVertices = r.SnowVertices,
            cliffOverrides = r.CliffOverrides,
            error = r.Error });
    }

    private string CmdGenerateDungeon(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        int depth = node["depth"]?.GetValue<int>() ?? 8;
        float branching = node["branching"]?.GetValue<float>() ?? 2.0f;
        int seed = node["seed"]?.GetValue<int>() ?? 0;
        int minRooms = node["minRooms"]?.GetValue<int>() ?? 5;
        int maxRooms = node["maxRooms"]?.GetValue<int>() ?? 40;
        string theme = node["theme"]?.GetValue<string>() ?? "default";
        bool validate = node["validate"]?.GetValue<bool>() ?? true;

        var r = _engine.GenerateDungeon(lbX, lbY, depth, branching, minRooms, maxRooms, theme, seed, validate);
        return Serialize(new { success = r.Success, command = "generate-dungeon",
            lbKey = $"0x{r.LbKey:X4}",
            nodesInGraph = r.NodesInGraph,
            edgesInGraph = r.EdgesInGraph,
            cellsPlaced = r.CellsPlaced,
            maxDepth = r.MaxDepth,
            seed = r.Seed,
            warnings = r.Warnings,
            graphSummary = r.GraphSummary,
            error = r.Error });
    }

    private string CmdAnalyzeLandblockPatterns(System.Text.Json.Nodes.JsonNode node) {
        uint minX = node["minX"]?.GetValue<uint>() ?? 0;
        uint minY = node["minY"]?.GetValue<uint>() ?? 0;
        uint maxX = node["maxX"]?.GetValue<uint>() ?? 254;
        uint maxY = node["maxY"]?.GetValue<uint>() ?? 254;
        string? outputPath = node["outputPath"]?.GetValue<string>();

        var r = _engine.AnalyzeLandblockPatterns(minX, minY, maxX, maxY, outputPath);
        return Serialize(new { success = r.Success, command = "analyze-landblock-patterns",
            landblocksAnalyzed = r.LandblocksAnalyzed,
            totalObjectsAnalyzed = r.TotalObjectsAnalyzed,
            elapsedMs = r.ElapsedMs,
            slopeDistribution = new {
                flat = r.SlopeDistribution.Flat, gentle = r.SlopeDistribution.Gentle,
                moderate = r.SlopeDistribution.Moderate, steep = r.SlopeDistribution.Steep
            },
            orientationBias = new {
                north = r.OrientationBias.North, east = r.OrientationBias.East,
                south = r.OrientationBias.South, west = r.OrientationBias.West,
                dominantDirection = r.OrientationBias.DominantDirection
            },
            clusterSummary = new {
                totalClusters = r.ClusterSummary.TotalClusters,
                avgClusterSize = r.ClusterSummary.AvgClusterSize,
                largestCluster = r.ClusterSummary.LargestCluster
            },
            topAdjacencyPairs = r.TopAdjacencyPairs.Take(50).Select(p => new {
                objectA = p.ObjectA, objectB = p.ObjectB,
                count5 = p.Count5, count10 = p.Count10, count25 = p.Count25,
                avgDistance = p.AvgDistance
            }).ToArray(),
            outputPath = r.OutputPath,
            error = r.Error });
    }

    private string CmdExtractBuildingPairings(System.Text.Json.Nodes.JsonNode node) {
        int minCount5 = node["minCount5"]?.GetValue<int>() ?? 3;
        string? outputPath = node["outputPath"]?.GetValue<string>();
        var r = _engine.ExtractBuildingPairings(minCount5, outputPath);
        return Serialize(new {
            success = r.Success, command = "extract-building-pairings",
            structuresScanned = r.StructuresScanned,
            pairsKept = r.PairsKept,
            groupCount = r.GroupCount,
            outputPath = r.OutputPath,
            elapsedMs = r.ElapsedMs,
            error = r.Error,
        });
    }

    private string CmdLoadBuildingPairings(System.Text.Json.Nodes.JsonNode node) {
        string path = node["path"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'path' field");
        var r = _engine.LoadBuildingPairings(path);
        return Serialize(new {
            success = r.Success, command = "load-building-pairings",
            edgeCount = r.EdgeCount,
            groupCount = r.GroupCount,
            error = r.Error,
        });
    }

    private string CmdExportTrainingData(System.Text.Json.Nodes.JsonNode node) {
        uint minX = node["minX"]?.GetValue<uint>() ?? 0;
        uint minY = node["minY"]?.GetValue<uint>() ?? 0;
        uint maxX = node["maxX"]?.GetValue<uint>() ?? 254;
        uint maxY = node["maxY"]?.GetValue<uint>() ?? 254;
        string? outputPath = node["outputPath"]?.GetValue<string>();
        int nearbyLimit = node["nearbyLimit"]?.GetValue<int>() ?? 5;

        var r = _engine.ExportTrainingData(minX, minY, maxX, maxY, outputPath, nearbyLimit);
        return Serialize(new { success = r.Success, command = "export-training-data",
            totalExported = r.TotalExported,
            landblocksProcessed = r.LandblocksProcessed,
            withOntology = r.WithOntology,
            elapsedMs = r.ElapsedMs,
            outputPath = r.OutputPath,
            error = r.Error });
    }

    private string CmdExportRawWorldFacts(System.Text.Json.Nodes.JsonNode node) {
        uint minX = node["minX"]?.GetValue<uint>() ?? 0;
        uint minY = node["minY"]?.GetValue<uint>() ?? 0;
        uint maxX = node["maxX"]?.GetValue<uint>() ?? 254;
        uint maxY = node["maxY"]?.GetValue<uint>() ?? 254;
        string? outputPath = node["outputPath"]?.GetValue<string>();
        bool includeAceDb = node["includeAceDb"]?.GetValue<bool>() ?? false;
        bool includeLinks = node["includeLinks"]?.GetValue<bool>() ?? false;

        var r = _engine.ExportRawWorldFacts(minX, minY, maxX, maxY, outputPath, includeAceDb, includeLinks);
        return Serialize(new {
            success = r.Success,
            command = "export-raw-world-facts",
            totalExported = r.TotalExported,
            datStaticCount = r.DatStaticCount,
            aceInstanceCount = r.AceInstanceCount,
            aceEncounterCount = r.AceEncounterCount,
            aceHousePortalCount = r.AceHousePortalCount,
            landblocksProcessed = r.LandblocksProcessed,
            includedAceDb = r.IncludedAceDb,
            includedLinks = r.IncludedLinks,
            elapsedMs = r.ElapsedMs,
            outputPath = r.OutputPath,
            error = r.Error
        });
    }

    private string CmdExportEnvCellComponents(System.Text.Json.Nodes.JsonNode node) {
        uint minX = node["minX"]?.GetValue<uint>() ?? 0;
        uint minY = node["minY"]?.GetValue<uint>() ?? 0;
        uint maxX = node["maxX"]?.GetValue<uint>() ?? 254;
        uint maxY = node["maxY"]?.GetValue<uint>() ?? 254;
        string? outputPath = node["outputPath"]?.GetValue<string>();

        var r = _engine.ExportEnvCellComponents(minX, minY, maxX, maxY, outputPath);
        return Serialize(new {
            success = r.Success,
            command = "export-envcell-components",
            totalExported = r.TotalExported,
            anchoredCount = r.AnchoredCount,
            unanchoredCount = r.UnanchoredCount,
            landblocksProcessed = r.LandblocksProcessed,
            elapsedMs = r.ElapsedMs,
            outputPath = r.OutputPath,
            error = r.Error
        });
    }

    private string CmdGenerateSettlement(System.Text.Json.Nodes.JsonNode node) {
        var templateName = node["template"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'template' field");
        float cx = F(node, "centerX");
        float cy = F(node, "centerY");
        int seed = node["seed"]?.GetValue<int>() ?? 0;

        var r = _engine.GenerateSettlement(templateName, cx, cy, seed);
        return Serialize(new { success = r.Success, command = "generate-settlement",
            templateName = r.TemplateName,
            objectsPlaced = r.ObjectsPlaced,
            constraintViolations = r.ConstraintViolations,
            warnings = r.Warnings,
            placedObjects = r.PlacedObjects.Select(po => new {
                modelId = po.ModelIdHex,
                category = po.Category,
                name = po.Name,
                x = Math.Round(po.X, 2), y = Math.Round(po.Y, 2), z = Math.Round(po.Z, 2),
                yawDegrees = po.YawDegrees
            }).ToArray(),
            elapsedMs = r.ElapsedMs,
            error = r.Error });
    }

    private string CmdExtractRetailHeightmaps(System.Text.Json.Nodes.JsonNode node) {
        string outputPath = node["outputPath"]?.GetValue<string>() ?? "pipeline_data/heightmaps/retail_heightmaps.jsonl";

        var r = _engine.ExtractRetailHeightmaps(outputPath);
        return Serialize(new { success = r.Success, command = "extract-retail-heightmaps",
            totalLandblocks = r.TotalLandblocks,
            populatedLandblocks = r.PopulatedLandblocks,
            elapsedMs = r.ElapsedMs,
            outputPath = r.OutputPath,
            error = r.Error });
    }

    private string CmdComputeVanillaBaseline(System.Text.Json.Nodes.JsonNode node) {
        string outputPath = node["outputPath"]?.GetValue<string>() ?? "pipeline_data/enrichment/retail_baseline.json";

        var r = _engine.ComputeVanillaBaseline(outputPath);
        return Serialize(new { success = r.Success, command = "compute-vanilla-baseline",
            landblocksScanned = r.LandblocksScanned,
            populatedLandblocks = r.PopulatedLandblocks,
            totalObjects = r.TotalObjects,
            elapsedMs = r.ElapsedMs,
            outputPath = r.OutputPath,
            error = r.Error });
    }

    // ════════════════════════════════════════════════════
    //  Helpers
    // ════════════════════════════════════════════════════

    private static float F(System.Text.Json.Nodes.JsonNode node, string field) =>
        node[field]?.GetValue<float>() ?? throw new ArgumentException($"Missing '{field}' field");

    private static uint U(System.Text.Json.Nodes.JsonNode node, string field) =>
        node[field]?.GetValue<uint>() ?? throw new ArgumentException($"Missing '{field}'");

    private static string[] FormatLbs(HashSet<ushort> lbs) =>
        lbs.Count == 0 ? Array.Empty<string>() : FormatLbsArray(lbs);

    private static string[] FormatLbsArray(HashSet<ushort> lbs) {
        var result = new string[lbs.Count];
        int i = 0;
        foreach (var lb in lbs) {
            result[i++] = $"0x{lb:X4}";
        }
        return result;
    }

    private static byte[] ParseByteArrayField(System.Text.Json.Nodes.JsonNode fieldNode, string fieldName) {
        if (fieldNode is System.Text.Json.Nodes.JsonArray arr) {
            int count = arr.Count;
            if (count == 0) return Array.Empty<byte>();
            var result = new byte[count];
            for (int i = 0; i < count; i++) {
                result[i] = (byte)(arr[i]?.GetValue<int>() ?? 0);
            }
            return result;
        }

        var csv = fieldNode.GetValue<string>();
        return ParseCsvByteArray(csv.AsSpan(), fieldName);
    }

    private static byte[] ParseCsvByteArray(ReadOnlySpan<char> csv, string fieldName) {
        if (csv.IsEmpty) return Array.Empty<byte>();

        int count = 1;
        for (int i = 0; i < csv.Length; i++) {
            if (csv[i] == ',') count++;
        }

        var result = new byte[count];
        int index = 0;
        int start = 0;

        for (int i = 0; i <= csv.Length; i++) {
            if (i != csv.Length && csv[i] != ',') continue;

            var segment = csv[start..i].Trim();
            if (!byte.TryParse(segment, out result[index])) {
                throw new ArgumentException($"Invalid byte value in '{fieldName}' at position {index}");
            }

            index++;
            start = i + 1;
        }

        return result;
    }

    private static object FmtQ(Quaternion q) => new {
        w = Math.Round(q.W, 6), x = Math.Round(q.X, 6),
        y = Math.Round(q.Y, 6), z = Math.Round(q.Z, 6) };

    private static string FormatValidation(string command, uint lbX, uint lbY, WorldBuilder.Shared.Lib.Validation.ValidationReport report) {
        ushort lbKey = CommandEngine.LbKey(lbX, lbY);
        return Serialize(new { success = true, command, landblock = $"0x{lbKey:X4}",
            isValid = report.IsValid, errorCount = report.ErrorCount,
            warningCount = report.WarningCount, infoCount = report.InfoCount,
            diagnostics = report.Diagnostics.Select(d => new {
                severity = d.Severity.ToString().ToLowerInvariant(),
                code = d.Code, message = d.Message, context = d.Context }).ToArray() });
    }

    // ════════════════════════════════════════════════════
    //  WorldGen (slice 3 of f26345e port)
    // ════════════════════════════════════════════════════

    private string CmdWorldGen(System.Text.Json.Nodes.JsonNode node) {
        // All params are optional; missing fields fall back to WorldGeneratorParams defaults.
        var p = new WorldGeneratorParams {
            Seed = node["seed"]?.GetValue<int>() ?? 0,
            FullWorld = node["fullWorld"]?.GetValue<bool>() ?? false,
            StartX = node["startX"]?.GetValue<int>() ?? 0,
            StartY = node["startY"]?.GetValue<int>() ?? 0,
            Width = node["width"]?.GetValue<int>() ?? 20,
            Height = node["height"]?.GetValue<int>() ?? 20,
            ContinentCount = node["continentCount"]?.GetValue<int>() ?? 1,
            IslandCount = node["islandCount"]?.GetValue<int>() ?? 0,
            LandCoverage = node["landCoverage"]?.GetValue<float>() ?? 0.5f,
            Roughness = node["roughness"]?.GetValue<float>() ?? 0.5f,
            TownCount = node["townCount"]?.GetValue<int>() ?? 5,
            TownSpacing = node["townSpacing"]?.GetValue<float>() ?? 30f,
            GenerateRoads = node["generateRoads"]?.GetValue<bool>() ?? true,
            GenerateBuildings = node["generateBuildings"]?.GetValue<bool>() ?? true,
            RetailTownBuildingsOnly = node["retailTownBuildingsOnly"]?.GetValue<bool>() ?? false,
        };
        var outPath = node["outputPath"]?.GetValue<string>();
        bool apply = node["apply"]?.GetValue<bool>() ?? false;
        var r = apply ? _engine.WorldGenApply(p, outPath) : _engine.WorldGenDryRun(p, outPath);
        return Serialize(new { success = r.Success, command = "worldgen",
            seed = r.Seed, applied = r.Applied,
            terrainLandblocksAffected = r.TerrainLandblocksAffected,
            totalVerticesModified = r.TotalVerticesModified,
            townCount = r.TownCount,
            totalBuildingsPlaced = r.TotalBuildingsPlaced,
            totalDecorationsPlaced = r.TotalDecorationsPlaced,
            totalRoadVertices = r.TotalRoadVertices,
            towns = r.Towns,
            outputPath = r.OutputPath, error = r.Error });
    }

    private string CmdWorldGenAnalyzeBuildings(System.Text.Json.Nodes.JsonNode node) {
        var outPath = node["outputPath"]?.GetValue<string>();
        var r = _engine.WorldGenAnalyzeBuildings(outPath);
        return Serialize(new { success = r.Success, command = "worldgen-analyze-buildings",
            total = r.Total, withInterior = r.WithInterior, paired = r.Paired,
            buildings = r.Buildings, outputPath = r.OutputPath, error = r.Error });
    }

    private string CmdWorldGenScanRetailTowns(System.Text.Json.Nodes.JsonNode node) {
        var outPath = node["outputPath"]?.GetValue<string>();
        var r = _engine.WorldGenScanRetailTowns(outPath);
        return Serialize(new { success = r.Success, command = "worldgen-scan-retail-towns",
            modelCount = r.ModelCount, stats = r.Stats,
            outputPath = r.OutputPath, error = r.Error });
    }

    // ════════════════════════════════════════════════════
    //  Weenie / ACE DB (slice 2 of f26345e port)
    // ════════════════════════════════════════════════════

    private string CmdWeenieSnapshot(System.Text.Json.Nodes.JsonNode node) {
        uint classId = U(node, "classId");
        bool full = node["full"]?.GetValue<bool>() ?? false;
        var r = _engine.WeenieSnapshotAsync(classId).GetAwaiter().GetResult();
        if (!r.Success)
            return Serialize(new { success = false, command = "weenie-snapshot", classId = r.ClassId, error = r.Error });
        return Serialize(new { success = true, command = "weenie-snapshot",
            classId = r.ClassId, weenieType = r.WeenieType, name = r.Name,
            setupDid = $"0x{r.SetupDid:X8}", iconDid = $"0x{r.IconDid:X8}",
            counts = new {
                ints = r.IntCount, int64s = r.Int64Count, bools = r.BoolCount,
                floats = r.FloatCount, strings = r.StringCount,
                dataIds = r.DataIdCount, instanceIds = r.InstanceIdCount,
                spellBook = r.SpellBookCount, createList = r.CreateListCount,
                emote = r.EmoteCount, book = r.BookCount,
                position = r.PositionCount, attribute = r.AttributeCount,
                attribute2nd = r.Attribute2ndCount, skill = r.SkillCount },
            lastModified = r.LastModified,
            snapshot = full ? r.Snapshot : null });
    }

    private string CmdWeenieTemplateList(System.Text.Json.Nodes.JsonNode node) {
        var bundlePath = node["bundlePath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'bundlePath' field");
        var r = _engine.WeenieTemplateList(bundlePath);
        return Serialize(new { success = r.Success, command = "weenie-template-list",
            bundlePath = r.BundlePath, templateCount = r.TemplateCount,
            templates = r.Templates.Select(t => new {
                id = t.Id, title = t.Title, description = t.Description,
                weenieType = t.WeenieType,
                counts = new { ints = t.IntCount, int64s = t.Int64Count, bools = t.BoolCount,
                    floats = t.FloatCount, strings = t.StringCount,
                    dataIds = t.DataIdCount, instanceIds = t.InstanceIdCount } }).ToArray(),
            error = r.Error });
    }

    private string CmdWeenieTemplateApply(System.Text.Json.Nodes.JsonNode node) {
        var bundlePath = node["bundlePath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'bundlePath' field");
        var templateId = node["templateId"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'templateId' field");
        uint classId = U(node, "classId");
        var r = _engine.WeenieTemplateApplyAsync(bundlePath, templateId, classId).GetAwaiter().GetResult();
        return Serialize(new { success = r.Success, command = "weenie-template-apply",
            bundlePath = r.BundlePath, templateId = r.TemplateId, classId = r.ClassId,
            scalarsApplied = r.ScalarsApplied, error = r.Error });
    }

    // ════════════════════════════════════════════════════
    //  Mesh I/O & BSP (slice 1 of f26345e port)
    // ════════════════════════════════════════════════════

    private string CmdObjExport(System.Text.Json.Nodes.JsonNode node) {
        uint datId = U(node, "datId");
        var outputPath = node["outputPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outputPath' field");
        var r = _engine.ObjExport(datId, outputPath);
        return Serialize(new { success = r.Found, command = "obj-export",
            datId = r.HexId, datType = r.DatType, found = r.Found,
            outputPath = r.OutputPath, partCount = r.PartCount,
            triangleCount = r.TriangleCount, error = r.Error });
    }

    private string CmdObjImport(System.Text.Json.Nodes.JsonNode node) {
        var objPath = node["objPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'objPath' field");
        uint surfaceDid = U(node, "surfaceDid");
        uint gfxObjId = node["gfxObjId"] != null ? U(node, "gfxObjId") : 0;
        uint setupId = node["setupId"] != null ? U(node, "setupId") : 0;
        var r = _engine.ObjImport(objPath, surfaceDid, gfxObjId, setupId);
        return Serialize(new { success = r.Success, command = "obj-import",
            gfxObjId = $"0x{r.GfxObjId:X8}", setupId = $"0x{r.SetupId:X8}",
            triangleCount = r.TriangleCount, vertexCount = r.VertexCount,
            error = r.Error });
    }

    private string CmdBspBuild(System.Text.Json.Nodes.JsonNode node) {
        uint gfxObjId = U(node, "gfxObjId");
        var r = _engine.BspBuild(gfxObjId);
        return Serialize(new { success = r.Built, command = "bsp-build",
            gfxObjId = r.HexId, found = r.Found, built = r.Built,
            polygonCount = r.PolygonCount, error = r.Error });
    }

    private static string Serialize(object obj) => JsonSerializer.Serialize(obj, JsonOpts);

    private void WriteResponse(object obj) {
        Console.WriteLine(Serialize(obj));
        Console.Out.Flush();
    }
}
