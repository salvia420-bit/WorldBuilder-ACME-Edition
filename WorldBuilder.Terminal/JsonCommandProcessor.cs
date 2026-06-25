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
    private readonly HeadlessProjectManager _projectManager;
    private readonly Dictionary<string, Func<System.Text.Json.Nodes.JsonNode, string>> _commandHandlers;
    private readonly TransactionEngine _transactionEngine;
    private readonly TransactDiffEngine _transactDiffEngine;

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
        IStampService stampService,
        int transactDiffRetention = 32,
        int transactDiffMemCapMb = 256) {
        _projectManager = projectManager;
        _engine = new CommandEngine(projectManager, terrainService, objectPlacementService, dungeonService, ontologyService, stampService);
        _commandHandlers = BuildCommandHandlers();
        _transactionEngine = new TransactionEngine(this, projectManager, transactDiffRetention, transactDiffMemCapMb);
        _transactDiffEngine = new TransactDiffEngine(_transactionEngine, _engine);
    }

    /// <summary>Exposes the transaction engine to the REPL/dispatch wiring of transact-diff.</summary>
    internal TransactionEngine Transactions => _transactionEngine;

    /// <summary>
    /// Pre-load a project through the same path the JSON `load` command uses, so the
    /// CLI `--project` flag exercises every auto-loader in <see cref="CommandEngine.Load"/>
    /// (ontology cache, building pairings, town gazetteer). Without this, stdin-mode
    /// `--project` would call <c>HeadlessProjectManager.LoadProject</c> directly and
    /// skip the auto-loaders, surfacing as silently empty fields in describe-landblock.
    /// </summary>
    public LoadResult Preload(string projectPath) => _engine.Load(projectPath);

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

    /// <summary>
    /// Re-entrant dispatch: invoke a registered handler with an already-parsed JSON node.
    /// Used by <see cref="TransactionEngine"/> to run staged sub-ops through the same
    /// handler dictionary as a top-level stdin command, without re-parsing a stdin line.
    /// </summary>
    internal string DispatchInternal(string commandName, System.Text.Json.Nodes.JsonNode node) {
        if (string.IsNullOrWhiteSpace(commandName))
            return Serialize(new { success = false, command = "parse_error", error = "Missing 'command'" });
        var command = commandName.Trim();
        try {
            if (_commandHandlers.TryGetValue(command, out var handler)) {
                return handler(node);
            }
            return Serialize(new { success = false, command, error = $"Unknown command: '{command}'" });
        } catch (Exception ex) {
            return Serialize(new { success = false, command, error = ex.Message });
        }
    }

    /// <summary>Exposes the command engine to <see cref="TransactionEngine"/>.</summary>
    internal CommandEngine Engine => _engine;

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
            ["describe-landblock"] = CmdDescribeLandblock,
            ["dump-lb-expectations"] = CmdDumpLbExpectations,
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
            ["compare-render-corners"] = CmdCompareRenderCorners,
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
            ["get-terrain-textures"] = _ => CmdGetTerrainTextures(),
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
            ["ace-db-ingest-creatures"] = CmdAceDbIngestCreatures,
            ["ace-db-ingest-npcs"] = CmdAceDbIngestNpcs,
            ["ace-db-ingest-housing"] = CmdAceDbIngestHousing,
            ["ace-db-ingest-spawns"] = CmdAceDbIngestSpawns,
            ["ace-db-ingest-encounters"] = CmdAceDbIngestEncounters,
            ["ace-db-ingest-weenie-index"] = CmdAceDbIngestWeenieIndex,
            ["compare-creatures-to-retail"] = _ => CmdCompareCreaturesToRetail(),
            ["benchmark"] = _ => CmdBenchmark(),
            ["set-landblock-heightmap"] = CmdSetLandblockHeightmap,
            ["set-landblock-terrain"] = CmdSetLandblockTerrain,
            ["import-heightmap"] = CmdImportHeightmap,
            ["import-render-surface"] = CmdImportRenderSurface,
            ["open-log-folder"] = _ => CmdOpenLogFolder(),
            ["creature-get"] = CmdCreatureGet,
            ["creature-save"] = CmdCreatureSave,
            ["creature-export-sql"] = CmdCreatureExportSql,
            ["layout-list"] = CmdLayoutList,
            ["layout-get"] = CmdLayoutGet,
            ["layout-save"] = CmdLayoutSave,
            ["layout-delete-overlay"] = CmdLayoutDeleteOverlay,
            ["spell-list"] = CmdSpellList,
            ["spell-get"] = CmdSpellGet,
            ["spell-save"] = CmdSpellSave,
            ["spell-copy"] = CmdSpellCopy,
            ["spell-delete"] = CmdSpellDelete,
            ["weenie-save"] = CmdWeenieSave,
            ["weenie-insert"] = CmdWeenieInsert,
            ["weenie-delete"] = CmdWeenieDelete,
            ["weenie-list-property-keys"] = CmdWeenieListPropertyKeys,
            ["placement-list"] = CmdPlacementList,
            ["placement-add-outdoor"] = CmdPlacementAddOutdoor,
            ["placement-add-dungeon"] = CmdPlacementAddDungeon,
            ["placement-remove"] = CmdPlacementRemove,
            ["placement-set-scope"] = CmdPlacementSetScope,
            ["placement-export-sql"] = CmdPlacementExportSql,
            ["ace-db-connect"] = CmdAceDbConnect,
            ["ace-db-status"] = CmdAceDbStatus,
            ["ace-shard-db-connect"] = CmdAceShardDbConnect,
            ["ace-shard-db-status"] = CmdAceShardDbStatus,
            ["fresh-start"] = CmdFreshStart,
            ["generate-world"] = CmdGenerateWorld,
            ["export-towns-csv"] = CmdExportTownsCsv,
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
            ["transact"] = CmdTransact,
            ["transact-diff"] = CmdTransactDiff,
            ["get-tile"] = CmdGetTile,
            ["tile-stats"] = _ => CmdTileStats(),
            ["regenerate-dirty-tiles"] = _ => CmdRegenerateDirtyTiles(),
            ["list-dirty-tiles"] = _ => CmdListDirtyTiles(),
            ["mark-tiles-clean"] = _ => CmdMarkTilesClean(),
            ["prune-tiles"] = CmdPruneTiles,
            ["generate-atlas-tiles"] = CmdGenerateAtlasTiles,
            ["extract-cell-footprints"] = CmdExtractCellFootprints,
            ["generate-object-sprites"] = CmdGenerateObjectSprites,
            ["render-dungeon"] = CmdRenderDungeon,
            ["emit-tile-pyramid"] = CmdEmitTilePyramid,
            ["describe-floor"] = CmdDescribeFloor,
            ["emit-static-site"] = CmdEmitStaticSite,
            ["emit-render-gallery"] = CmdEmitRenderGallery,
            ["serve-render-gallery"] = CmdServeRenderGallery,
            // Visual-Behavior Suite (build-spec §12.2) — see CommandEngine.Vfx.cs
            ["vfx-classify"] = CmdVfxClassify,
            ["vfx-emit-allowlist"] = CmdVfxEmitAllowlist,
            ["vfx-emit-catalog"] = CmdVfxEmitCatalog,
            ["vfx-gauge"] = CmdVfxGauge,
            ["chorizite-dump-enum-values"] = CmdChoriziteDumpEnumValues,
            ["chorizite-dump-world-object-taxonomy"] = CmdChoriziteDumpWorldObjectTaxonomy,
            ["chorizite-hash-string"] = CmdChoriziteHashString,
            ["chorizite-classify"] = CmdChoriziteClassify,
            ["chorizite-dump-opcodes"] = CmdChoriziteDumpOpcodes,
            ["chorizite-resolve-sound"] = CmdChoriziteResolveSound,
            // Wave-1 UI-port commands — see CommandEngine.UiSpriteExtract.cs
            ["chorizite-dump-layout-tree"]      = CmdChoriziteDumpLayoutTree,
            ["chorizite-extract-ui-textures"]   = CmdChoriziteExtractUiTextures,
            // PR-V Skills view backing dump — see CommandEngine.SkillTableDump.cs
            ["chorizite-dump-skill-table"]      = CmdChoriziteDumpSkillTable,
            // Wave-1 wire-conformance diagnostic commands — see CommandEngine.WireConformance.cs
            ["chorizite-wire-pack-message"]   = CmdChoriziteWirePackMessage,
            ["chorizite-wire-unpack-message"] = CmdChoriziteWireUnpackMessage,
            ["chorizite-wire-list-message-types"] = _ => CmdChoriziteWireListMessageTypes(),
            // Wave-2.C enum-parity diagnostic — see CommandEngine.EnumParity.cs
            ["enum-parity-report"] = CmdEnumParityReport,
            // Wave-2.A + 2.B DAT-parity diagnostic — see CommandEngine.DatParity.cs
            ["chorizite-list-dat-records"] = CmdChoriziteListDatRecords,
            ["chorizite-parse-dat-record"] = CmdChoriziteParseDatRecord,
            ["chorizite-list-dat-types"] = _ => CmdChoriziteListDatTypes(),
            // Wave-3.B physics-jump-formula diagnostic — see CommandEngine.PhysicsParity.cs
            ["physics-jump-formula"]       = CmdPhysicsJumpFormula,
            ["physics-jump-formula-sweep"] = CmdPhysicsJumpFormulaSweep,
            // Wave-3.A physics-replay-trace diagnostic — see CommandEngine.PhysicsParity.cs
            ["physics-replay-trace"]       = CmdPhysicsReplayTrace,
            // Wave-3.C motion-classify-swing diagnostic — see CommandEngine.MotionParity.cs
            ["motion-classify-swing"]      = CmdMotionClassifySwing,
            ["motion-inventory"]           = CmdMotionInventory,
            // Wave-3.D motion-table-anim-hooks (follow-on bundle) — see CommandEngine.MotionParity.cs
            ["motion-table-anim-hooks"]    = CmdMotionTableAnimHooks,
            // Wave-5.A cell-portal graph diagnostic — see CommandEngine.CellPortalGraph.cs
            ["cell-portal-graph-sweep"]   = CmdCellPortalGraphSweep,
            ["pvs-visibility-snapshot"]   = CmdPvsVisibilitySnapshot,
            // Wave-4.A + 4.B texture-parity diagnostic — see CommandEngine.TextureParity.cs
            ["chorizite-decode-surface-chunk"]       = CmdChoriziteDecodeSurfaceChunk,
            ["chorizite-decode-texture-chain-chunk"] = CmdChoriziteDecodeTextureChainChunk,
            // Wave-4.C + 4.D mesh-parity diagnostic — see CommandEngine.MeshParity.cs
            ["mesh-vs-obj-export-chunk"]       = CmdMeshVsObjExportChunk,
            ["env-cell-vs-setup-model-chunk"]  = CmdEnvCellVsSetupModelChunk,
            // Wave-4.E sweep orchestrator — see CommandEngine.Wave4.cs
            ["wave4-status"]               = _ => CmdWave4Status(),
            ["wave4-sweep"]                = CmdWave4Sweep,
            // Wave-5.B skybox parity diagnostic — see CommandEngine.Skybox.cs
            ["region-skybox-snapshot"]    = CmdRegionSkyboxSnapshot,
            ["region-day-night-curve"]    = CmdRegionDayNightCurve,
            // Melt-integration Phase R — Region 0x13 JSON round-trip; see CommandEngine.Region.cs
            ["region-export-json"]        = CmdRegionExportJson,
            ["region-import-json"]        = CmdRegionImportJson,
            ["region-diff"]               = CmdRegionDiff,
            // Melt-integration Phase X.1 — secondary DAT handles; see CommandEngine.DatHandles.cs
            ["dat-open"]                  = CmdDatOpen,
            ["dat-close"]                 = CmdDatClose,
            ["dat-list"]                  = _ => CmdDatList(),
            // Melt-integration Phase S — Scene 0x12 inspection; see CommandEngine.Scene.cs
            ["scene-export-json"]         = CmdSceneExportJson,
            ["scene-diff"]                = CmdSceneDiff,
            ["scene-where-used"]          = CmdSceneWhereUsed,
            ["scene-edit"]                = CmdSceneEdit,
            // Melt-integration Phase G — asset-reference graph; see CommandEngine.AssetGraph.cs
            ["asset-refs"]                = CmdAssetRefs,
            ["asset-used-by"]             = CmdAssetUsedBy,
            ["surface-fingerprint"]       = CmdSurfaceFingerprint,
            // Melt deferred-functionality briefing; see CommandEngine.MeltReference.cs
            ["melt-reference"]            = CmdMeltReference,
            // Melt-integration Phase X.2 — cross-DAT transplant; see CommandEngine.Transplant.cs
            ["copy-landblock"]            = CmdCopyLandblock,
            ["copy-building"]             = CmdCopyBuilding,
            ["remove-building"]           = CmdRemoveBuilding,
            ["bulk-paint-replace"]        = CmdBulkPaintReplace,
            // Wave-5.C diag-run-all meta-command — see Diagnostics/RunAll.cs
            ["diag-run-all"]              = CmdDiagRunAll,
            ["diag-status"]               = _ => CmdDiagStatus(),
            ["help"] = _ => CmdHelp(),
        };

    private string CmdChoriziteDumpEnumValues(System.Text.Json.Nodes.JsonNode node) {
        string? enumName = node["enumName"]?.GetValue<string>();
        var dumps = _engine.ChoriziteDumpEnumValues(enumName, out var missing);
        return Serialize(new {
            success = true,
            command = "chorizite-dump-enum-values",
            requestedEnum = enumName,
            count = dumps.Count,
            missing = missing.ToArray(),
            enums = dumps.Select(d => new {
                name = d.EnumName,
                underlyingType = d.UnderlyingType,
                isFlags = d.IsFlags,
                memberCount = d.Members.Count,
                members = d.Members.Select(m => new {
                    name = m.Name,
                    valueHex = m.ValueHex,
                    valueDecimal = m.ValueDecimal
                })
            })
        });
    }

    private string CmdChoriziteDumpWorldObjectTaxonomy(System.Text.Json.Nodes.JsonNode node) {
        string? sourceRoot = node["sourceRoot"]?.GetValue<string>();
        var tax = _engine.ChoriziteDumpWorldObjectTaxonomy(sourceRoot);
        return Serialize(new {
            success = true,
            command = "chorizite-dump-world-object-taxonomy",
            sourceRoot = tax.SourceRoot,
            vendoredHead = tax.VendoredHead,
            count = tax.Classes.Count,
            classes = tax.Classes.Select(c => new {
                name = c.Name,
                baseClass = c.BaseClass,
                relativePath = c.RelativePath,
                itemTypeTags = c.ItemTypeTags,
                objectClassTags = c.ObjectClassTags
            })
        });
    }

    private string CmdChoriziteHashString(System.Text.Json.Nodes.JsonNode node) {
        string s = node["input"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'input' field");
        var r = _engine.ChoriziteHashString(s);
        return Serialize(new {
            success = true,
            command = "chorizite-hash-string",
            input = r.Input,
            hashHex = r.HashHex,
            hashDecimal = r.HashDecimal
        });
    }

    private string CmdChoriziteClassify(System.Text.Json.Nodes.JsonNode node) {
        // Accept input as either hex strings or decimal numbers.
        uint ParseField(string name) {
            var v = node[name] ?? throw new ArgumentException($"Missing '{name}' field");
            if (v.GetValueKind() == System.Text.Json.JsonValueKind.String) {
                var s = v.GetValue<string>();
                return s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                    ? Convert.ToUInt32(s.Substring(2), 16)
                    : Convert.ToUInt32(s);
            }
            return v.GetValue<uint>();
        }
        uint itemType     = ParseField("itemType");
        uint objDescFlags = ParseField("objDescFlags");
        uint weenieFlags  = ParseField("weenieFlags");
        var r = _engine.ChoriziteClassify(itemType, objDescFlags, weenieFlags);
        return Serialize(new {
            success = true,
            command = "chorizite-classify",
            itemType = $"0x{r.ItemType:X8}",
            objDescFlags = $"0x{r.ObjDescFlags:X8}",
            weenieFlags = $"0x{r.WeenieFlags:X8}",
            objectClass = r.ObjectClass
        });
    }

    private string CmdChoriziteDumpOpcodes(System.Text.Json.Nodes.JsonNode node) {
        string? sourceRoot = node["sourceRoot"]?.GetValue<string>();
        string? outputPath = node["outputPath"]?.GetValue<string>();
        var r = _engine.ChoriziteDumpOpcodes(sourceRoot, outputPath);
        return Serialize(new {
            success = true,
            command = "chorizite-dump-opcodes",
            sourceRoot = r.SourceRoot,
            vendoredHead = r.VendoredHead,
            outputPath = r.OutputPath,
            fileSizeBytes = r.FileSizeBytes,
            enumCount = r.Enums.Count,
            enumCounts = r.Enums.ToDictionary(kv => kv.Key, kv => kv.Value.Count)
        });
    }

    private string CmdChoriziteResolveSound(System.Text.Json.Nodes.JsonNode node) {
        // Accept soundTableDid as hex (0x…) or decimal, either as string or integer JSON node.
        uint ParseDid(string fieldName) {
            var v = node[fieldName] ?? throw new ArgumentException($"Missing '{fieldName}' field");
            if (v.GetValueKind() == System.Text.Json.JsonValueKind.String) {
                var s = v.GetValue<string>();
                if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
                    return Convert.ToUInt32(s.Substring(2), 16);
                }
                return Convert.ToUInt32(s);
            }
            return v.GetValue<uint>();
        }
        uint soundTableDid = ParseDid("soundTableDid");
        // sound can be a name string or an integer.
        var soundNode = node["sound"] ?? throw new ArgumentException("Missing 'sound' field");
        string soundInput;
        if (soundNode.GetValueKind() == System.Text.Json.JsonValueKind.String) {
            soundInput = soundNode.GetValue<string>();
        } else {
            soundInput = soundNode.GetValue<uint>().ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        string? datPath = node["datPath"]?.GetValue<string>();
        var r = _engine.ChoriziteResolveSound(soundTableDid, soundInput, datPath);
        return Serialize(new {
            success = true,
            command = "chorizite-resolve-sound",
            input = new {
                soundTableDid = $"0x{r.SoundTableDid:X8}",
                soundEnumValue = $"0x{r.SoundEnumValue:X2}",
                soundEnumName = r.SoundEnumName,
            },
            waveDid = r.WaveDid.HasValue ? $"0x{r.WaveDid.Value:X8}" : null,
            priority = r.Priority,
            probability = r.Probability,
            volume = r.Volume,
            entryCount = r.EntryCount,
            source = r.Source,
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Wave-1 UI-port dispatch — see CommandEngine.UiSpriteExtract.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdChoriziteDumpLayoutTree(System.Text.Json.Nodes.JsonNode node) {
        // layoutId accepts hex string ("0x21000000"), decimal string, or
        // an integer JSON value. Default = 0x21000000 (the retail
        // 800×600 root UI tree).
        uint layoutId = 0x21000000u;
        var layoutIdNode = node["layoutId"];
        if (layoutIdNode != null && layoutIdNode.GetValueKind() != System.Text.Json.JsonValueKind.Null) {
            if (layoutIdNode.GetValueKind() == System.Text.Json.JsonValueKind.String) {
                var s = layoutIdNode.GetValue<string>().Trim();
                layoutId = s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                    ? Convert.ToUInt32(s.Substring(2), 16)
                    : Convert.ToUInt32(s);
            } else {
                layoutId = layoutIdNode.GetValue<uint>();
            }
        }
        string? outPath = node["outPath"]?.GetValue<string>();
        string? datPath = node["datPath"]?.GetValue<string>();
        // resolveSymbols (default false): when true, fills ElementIdName /
        // StateIdName / IncorporationFlags-as-list using retail enum names
        // (AcClient.UIElementId, DRW.Enums.UIStateId/IncorporationFlags).
        // Hex fields stay populated either way — opt-in adds, never replaces.
        bool resolveSymbols = node["resolveSymbols"]?.GetValue<bool>() ?? false;
        var r = _engine.ChoriziteDumpLayoutTree(layoutId, outPath, datPath, resolveSymbols);

        // Wrap the dump result. We inline the full tree when no outPath
        // was given so the caller can pipe it; when outPath is set we
        // still return the full body so the caller can confirm shape.
        return Serialize(new {
            success = true,
            command = "chorizite-dump-layout-tree",
            datPath = r.DatPath,
            outPath = string.IsNullOrEmpty(r.OutPath) ? null : r.OutPath,
            summary = new {
                layoutId = r.LayoutIdHex,
                width = r.Width,
                height = r.Height,
                elementCount = r.ElementCount,
                imageDidCount = r.ImageDidCount,
                allImageDids = r.AllImageDids,
            },
            layout = new {
                layoutId = r.LayoutIdHex,
                width = r.Width,
                height = r.Height,
                elements = r.Elements,
            },
        });
    }

    private string CmdChoriziteExtractUiTextures(System.Text.Json.Nodes.JsonNode node) {
        var didsArr = node["dids"] as System.Text.Json.Nodes.JsonArray
            ?? throw new ArgumentException("Missing 'dids' array");
        var dids = new List<uint>();
        foreach (var entry in didsArr) {
            if (entry == null) continue;
            uint did;
            if (entry.GetValueKind() == System.Text.Json.JsonValueKind.String) {
                var s = entry.GetValue<string>().Trim();
                did = s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                    ? Convert.ToUInt32(s.Substring(2), 16)
                    : Convert.ToUInt32(s);
            } else {
                did = entry.GetValue<uint>();
            }
            dids.Add(did);
        }
        string outDir = node["outDir"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outDir' field");
        string? datPath = node["datPath"]?.GetValue<string>();

        var r = _engine.ChoriziteExtractUiTextures(dids, outDir, datPath);
        return Serialize(new {
            success = true,
            command = "chorizite-extract-ui-textures",
            outDir = r.OutDir,
            datPath = r.DatPath,
            requestedCount = r.RequestedCount,
            distinctCount = r.DistinctCount,
            pngCount = r.PngCount,
            failCount = r.FailCount,
            indexJson = r.IndexJsonPath,
            records = r.Records.Select(rec => new {
                did = rec.DidHex,
                status = rec.Status,
                width = rec.Width,
                height = rec.Height,
                sha256 = rec.Sha256,
                pixelFormat = rec.PixelFormat,
                pngPath = rec.PngPath,
                failureReason = rec.FailureReason,
            }),
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // PR-V Skills view dispatch — see CommandEngine.SkillTableDump.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdChoriziteDumpSkillTable(System.Text.Json.Nodes.JsonNode node) {
        // skillTableId accepts hex string ("0x0E000004"), decimal string,
        // or an integer JSON value. Default = 0xE000004u (the only retail
        // SkillTable DID per dats.xml — first=0xE000004 last=0xE000004).
        uint skillTableId = 0x0E000004u;
        var idNode = node["skillTableId"];
        if (idNode != null && idNode.GetValueKind() != System.Text.Json.JsonValueKind.Null) {
            if (idNode.GetValueKind() == System.Text.Json.JsonValueKind.String) {
                var s = idNode.GetValue<string>().Trim();
                skillTableId = s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                    ? Convert.ToUInt32(s.Substring(2), 16)
                    : Convert.ToUInt32(s);
            } else {
                skillTableId = idNode.GetValue<uint>();
            }
        }
        string? outPath = node["outPath"]?.GetValue<string>();
        string? datPath = node["datPath"]?.GetValue<string>();

        var r = _engine.ChoriziteDumpSkillTable(skillTableId, outPath, datPath);
        return Serialize(new {
            success = true,
            command = "chorizite-dump-skill-table",
            skillTableIdHex = r.SkillTableIdHex,
            datPath = r.DatPath,
            outPath = string.IsNullOrEmpty(r.OutPath) ? null : r.OutPath,
            skillCount = r.SkillCount,
            skills = r.Skills,
            summary = r.Summary,
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Wave-1 wire-conformance dispatch — see CommandEngine.WireConformance.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdChoriziteWirePackMessage(System.Text.Json.Nodes.JsonNode node) {
        string typeName = node["typeName"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'typeName' field");
        var fields = node["fields"];
        string? headerMode = node["headerMode"]?.GetValue<string>();
        var r = _engine.ChoriziteWirePackMessage(typeName, fields, headerMode);
        return Serialize(new {
            success = true,
            command = "chorizite-wire-pack-message",
            messageType = r.MessageType,
            fullName = r.FullName,
            headerMode = r.HeaderMode,
            opCode = r.OpCode.HasValue ? $"0x{r.OpCode.Value:X4}" : null,
            hexBytes = r.HexBytes,
            byteLen = r.ByteLen,
            sha256 = r.Sha256,
        });
    }

    private string CmdChoriziteWireUnpackMessage(System.Text.Json.Nodes.JsonNode node) {
        string hexBytes = node["hexBytes"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'hexBytes' field");
        string? typeName = node["typeName"]?.GetValue<string>();
        string? headerMode = node["headerMode"]?.GetValue<string>();
        var r = _engine.ChoriziteWireUnpackMessage(hexBytes, typeName, headerMode);
        return Serialize(new {
            success = true,
            command = "chorizite-wire-unpack-message",
            messageType = r.MessageType,
            fullName = r.FullName,
            headerMode = r.HeaderMode,
            fields = r.Fields,
            roundtrip = r.Roundtrip,
            roundtripDiff = r.RoundtripDiff,
        });
    }

    private string CmdChoriziteWireListMessageTypes() {
        var r = _engine.ChoriziteWireListMessageTypes();
        return Serialize(new {
            success = true,
            command = "chorizite-wire-list-message-types",
            count = r.Count,
            types = r.Types.Select(t => new {
                typeName = t.TypeName,
                fullName = t.FullName,
                direction = t.Direction,
                opCode = t.OpCode.HasValue ? $"0x{t.OpCode.Value:X4}" : null,
            }),
        });
    }

    private string CmdEnumParityReport(System.Text.Json.Nodes.JsonNode node) {
        string? sourceRoot = node["sourceRoot"]?.GetValue<string>();
        string? rustCrateRoot = node["rustCrateRoot"]?.GetValue<string>();
        var report = _engine.EnumParityReportCommand(sourceRoot, rustCrateRoot);
        return Serialize(new {
            success = true,
            command = "enum-parity-report",
            choriziteSourceRoot = report.ChoriziteSourceRoot,
            choriziteAssembly = report.ChoriziteAssembly,
            rustCrateRoot = report.RustCrateRoot,
            checkedEnums = report.CheckedEnums,
            passEnums = report.PassEnums,
            failEnums = report.FailEnums,
            gapEnums = report.GapEnums,
            rows = report.Rows.Select(r => new {
                choriziteName = r.ChoriziteName,
                rustName = r.RustName,
                rustRelativePath = r.RustRelativePath,
                status = r.Status,
                checkedMembers = r.CheckedMembers,
                passMembers = r.PassMembers,
                failMembers = r.FailMembers,
                mismatches = r.Mismatches.Select(mm => new {
                    kind = mm.Kind,
                    name = mm.Name,
                    choriziteValue = mm.ChoriziteValue,
                    rustValue = mm.RustValue,
                    note = mm.Note,
                })
            })
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Wave-2.A + 2.B DAT-parity dispatch — see CommandEngine.DatParity.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdChoriziteListDatRecords(System.Text.Json.Nodes.JsonNode node) {
        string? datPath = node["datPath"]?.GetValue<string>();
        string? typeName = node["typeName"]?.GetValue<string>();
        var r = _engine.ChoriziteListDatRecords(datPath ?? "", typeName);
        return Serialize(new {
            success = true,
            command = "chorizite-list-dat-records",
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            recordCount = r.RecordCount,
            source = r.Source,
            records = r.Records.Select(s => new {
                idHex = s.IdHex,
                id = s.Id,
                typeName = s.TypeName,
                sizeBytes = s.SizeBytes,
            }),
            enumerationErrors = r.EnumerationErrors.Select(e => new {
                typeName = e.TypeName,
                error = e.Error,
            })
        });
    }

    private string CmdChoriziteParseDatRecord(System.Text.Json.Nodes.JsonNode node) {
        string? datPath = node["datPath"]?.GetValue<string>();
        string idHex = node["idHex"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'idHex' field");
        string? typeName = node["typeName"]?.GetValue<string>();
        var r = _engine.ChoriziteParseDatRecord(datPath ?? "", idHex, typeName);
        return Serialize(new {
            success = r.ErrorMessage == null,
            command = "chorizite-parse-dat-record",
            idHex = r.IdHex,
            id = r.Id,
            typeName = r.TypeName,
            fields = r.Fields,
            errorMessage = r.ErrorMessage,
            source = r.Source,
        });
    }

    private string CmdChoriziteListDatTypes() {
        var r = _engine.ChoriziteListDatTypes();
        return Serialize(new {
            success = true,
            command = "chorizite-list-dat-types",
            count = r.Count,
            types = r.Select(row => new {
                typeName = row.TypeName,
                datFile = row.DatFile,
                firstIdHex = row.FirstIdHex,
                lastIdHex = row.LastIdHex,
                isSingular = row.IsSingular,
                hasRangeData = row.HasRangeData,
            })
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Wave-3.B physics-jump-formula — see CommandEngine.PhysicsParity.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdPhysicsJumpFormula(System.Text.Json.Nodes.JsonNode node) {
        float jumpExtent = ParseFloatField(node, "jumpExtent");
        float? weenieFallback = node["weenieFallback"] switch {
            null => null,
            var v when v.GetValueKind() == System.Text.Json.JsonValueKind.Null => null,
            var v when v.GetValueKind() == System.Text.Json.JsonValueKind.String &&
                       string.Equals(v.GetValue<string>(), "NaN", StringComparison.OrdinalIgnoreCase)
                => float.NaN,
            var v when v.GetValueKind() == System.Text.Json.JsonValueKind.String &&
                       string.Equals(v.GetValue<string>(), "null", StringComparison.OrdinalIgnoreCase)
                => (float?)null,
            var v => (float?)ParseFloatField(node, "weenieFallback"),
        };
        var r = _engine.PhysicsJumpFormula(jumpExtent, weenieFallback);
        return Serialize(new {
            success = true,
            command = "physics-jump-formula",
            jumpExtent = r.JumpExtent,
            weenieFallback = r.WeenieFallback.HasValue
                ? (float.IsNaN(r.WeenieFallback.Value) ? "NaN" : (object)r.WeenieFallback.Value)
                : null,
            verticalVelocity = r.VerticalVelocity,
            branch = r.Branch,
            source = r.Source,
        });
    }

    private string CmdPhysicsJumpFormulaSweep(System.Text.Json.Nodes.JsonNode node) {
        int caseCount = node["caseCount"]?.GetValue<int>() ?? 1000;
        var sweep = _engine.PhysicsJumpFormulaSweep(caseCount);
        return Serialize(new {
            success = true,
            command = "physics-jump-formula-sweep",
            caseCount = sweep.CaseCount,
            branchHistogram = sweep.BranchHistogram,
            notes = sweep.Notes,
            cases = sweep.Cases.Select(c => new {
                index = c.Index,
                jumpExtent = c.JumpExtent,
                weenieFallback = c.WeenieFallback.HasValue
                    ? (float.IsNaN(c.WeenieFallback.Value) ? "NaN" : (object)c.WeenieFallback.Value)
                    : null,
                verticalVelocity = c.VerticalVelocity,
                branch = c.Branch,
            }),
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Wave-3.A physics-replay-trace — see CommandEngine.PhysicsParity.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdPhysicsReplayTrace(System.Text.Json.Nodes.JsonNode node) {
        string traceSubjectPath = node["traceSubjectPath"]?.GetValue<string>()
            ?? throw new ArgumentException("traceSubjectPath is required");
        string probeScenarioPath = node["probeScenarioPath"]?.GetValue<string>()
            ?? throw new ArgumentException("probeScenarioPath is required");
        float? maxDriftOverride = node["maxDriftOverride"]?.GetValue<float?>();
        // Wave 3.F: subjectSignal selects pure-prediction vs legacy pose.
        // Default is "prediction" — the W3.F path closes the W3.A gap.
        string subjectSignal = node["subjectSignal"]?.GetValue<string>() ?? "prediction";
        var r = _engine.PhysicsReplayTrace(traceSubjectPath, probeScenarioPath, maxDriftOverride, subjectSignal);
        return Serialize(new {
            success = true,
            command = "physics-replay-trace",
            comparedTickCount = r.TickCount,
            traceRowCount = r.TraceRowCount,
            skippedComparisons = r.SkippedComparisons,
            maxPositionDriftTick = r.MaxPositionDriftTick,
            maxPositionDriftMeters = r.MaxPositionDriftMeters,
            meanDriftMeters = r.MeanDriftMeters,
            onGroundMismatchCount = r.OnGroundMismatchCount,
            onGroundSubjectMissingCount = r.OnGroundSubjectMissingCount,
            mismatches = r.Mismatches.Select(m => new {
                tick = m.Tick,
                subjectPos = m.SubjectPos,
                oraclePos = m.OraclePos,
                driftMeters = m.DriftMeters,
                subjectOnGround = m.SubjectOnGround,
                oracleOnGround = m.OracleOnGround,
            }),
            passed = r.Passed,
            notes = r.Notes,
            subjectSignal = r.SubjectSignal,
            predictionRowCount = r.PredictionRowCount,
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Wave-3.C motion-classify-swing — see CommandEngine.MotionParity.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdMotionClassifySwing(System.Text.Json.Nodes.JsonNode node) {
        uint motionTableId = ParseUIntField(node, "motionTableId");
        uint stance = ParseUIntField(node, "stance");
        uint attackHeight = ParseUIntField(node, "attackHeight");
        string? datPath = node["datPath"]?.GetValue<string>();
        var r = _engine.MotionClassifySwing(motionTableId, stance, attackHeight, datPath);
        return Serialize(new {
            success = r.FailureReason == null,
            command = "motion-classify-swing",
            motionTableId = $"0x{r.MotionTableId:X8}",
            stance = $"0x{r.Stance:X8}",
            attackHeight = r.AttackHeight,
            resolvedMotionCmd = r.ResolvedMotionCmd.HasValue ? $"0x{r.ResolvedMotionCmd.Value:X8}" : null,
            linkClass = r.LinkClass.ToString(),
            animId = r.AnimId.HasValue ? $"0x{r.AnimId.Value:X8}" : null,
            lowFrame = r.LowFrame,
            highFrame = r.HighFrame,
            framerate = r.Framerate,
            outerLinkCount = r.OuterLinkCount,
            innerLinkCount = r.InnerLinkCount,
            failureReason = r.FailureReason,
            source = r.Source,
        });
    }

    private string CmdMotionInventory(System.Text.Json.Nodes.JsonNode node) {
        string? datPath = node["datPath"]?.GetValue<string>();
        var inv = _engine.MotionInventory(datPath);
        return Serialize(new {
            success = true,
            command = "motion-inventory",
            count = inv.Count,
            entries = inv.Select(e => new {
                id = $"0x{e.Id:X8}",
                cycleCount = e.CycleCount,
                linkCount = e.LinkCount,
                modifierCount = e.ModifierCount,
            }),
        });
    }

    // Shared helpers for Wave 3 dispatch — JsonNode → float / uint with hex
    // + string fallback. Mirrors the inline ParseField pattern inside
    // CmdChoriziteClassify; broken out here so both PhysicsParity +
    // MotionParity wrappers reuse one definition.
    private static float ParseFloatField(System.Text.Json.Nodes.JsonNode node, string name) {
        var v = node[name] ?? throw new ArgumentException($"Missing '{name}' field");
        if (v.GetValueKind() == System.Text.Json.JsonValueKind.String) {
            return float.Parse(v.GetValue<string>(), System.Globalization.CultureInfo.InvariantCulture);
        }
        return (float)v.GetValue<double>();
    }

    private static uint ParseUIntField(System.Text.Json.Nodes.JsonNode node, string name) {
        var v = node[name] ?? throw new ArgumentException($"Missing '{name}' field");
        if (v.GetValueKind() == System.Text.Json.JsonValueKind.String) {
            var s = v.GetValue<string>();
            return s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? Convert.ToUInt32(s.Substring(2), 16)
                : Convert.ToUInt32(s);
        }
        return v.GetValue<uint>();
    }

    // F24: 'id' DID fields accept either a 0x-hex string or a JSON number,
    // matching the numeric tolerance of ParseUIntField / ParseLbIdScalar.
    private static string ParseIdFieldToHex(System.Text.Json.Nodes.JsonNode? idNode, string name = "id") {
        if (idNode == null)
            throw new ArgumentException($"Missing '{name}' field");
        if (idNode.GetValueKind() == System.Text.Json.JsonValueKind.String)
            return idNode.GetValue<string>();
        try {
            return $"0x{(uint)idNode.GetValue<long>():X8}";
        } catch (Exception) {
            throw new ArgumentException($"'{name}' must be a hex string like \"0x02000306\" or a non-negative integer");
        }
    }

    private string CmdEmitStaticSite(System.Text.Json.Nodes.JsonNode node) {
        string slug = node["projectSlug"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'projectSlug' field");
        string outDir = node["outDir"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outDir' field");
        // Why default 12: the README example, the agent_api_reference
        // response example, and emit-tile-pyramid's own default all use 12.
        // The previous default of 10 silently shipped a coarser pyramid than
        // every documented invocation requested.
        int maxZoom = node["maxZoom"]?.GetValue<int>() ?? 12;
        int minZoom = node["minZoom"]?.GetValue<int>() ?? 3;
        bool emitObject = node["emitObject"]?.GetValue<bool>() ?? false;
        bool emitFloor = node["emitFloor"]?.GetValue<bool>() ?? false;
        int throttleMs = node["throttleMs"]?.GetValue<int>() ?? 0;
        bool gallery = node["gallery"]?.GetValue<bool>() ?? false;
        // tileFormat: "png" (default) | "webp". WebP shrinks the tile
        // pyramid ~35% with no perceptible quality loss at the deeper
        // zooms; PNG stays the default for browsers without WebP support
        // (caller can verify via meta.js's tileFormat field).
        string tileFormat = node["tileFormat"]?.GetValue<string>() ?? "png";
        var lbFilter = ParseLbFilter(node);

        var r = _engine.EmitStaticSite(slug, outDir, lbFilter, maxZoom, minZoom,
            emitObject, emitFloor, throttleMs, tileFormat);

        // Optional gallery sidecar: bundle a curated Tailwind gallery into
        // <outDir>/gallery/ and let the Leaflet view link across. The
        // gallery emit reads the same project state, so calling it after
        // the static site emits keeps both views in sync.
        RenderGalleryResult? galleryResult = null;
        if (gallery) {
            string galleryDir = Path.Combine(outDir, "gallery");
            galleryResult = _engine.EmitRenderGallery(galleryDir);
        }

        return Serialize(new {
            success = true,
            command = "emit-static-site",
            projectSlug = r.ProjectSlug,
            outDir = r.OutDir,
            lbsDescribed = r.LbsDescribed,
            dungeonsEmitted = r.DungeonsEmitted,
            overlaysEmitted = r.OverlaysEmitted,
            // tilesAtMaxZoom is the terrain+objects-glyph "exterior" count for
            // wire-compat with earlier emitter responses. The two new fields
            // surface the object-sprite and floor tiers, which are also
            // written when the corresponding tier flags are set.
            tilesAtMaxZoom = r.TilesAtMaxZoom,
            objectTilesAtMaxZoom = r.ObjectTilesAtMaxZoom,
            floorTilesWritten = r.FloorTilesWritten,
            frontendFilesCopied = r.FrontendFilesCopied,
            manifestProjectCount = r.ManifestProjectCount,
            // Non-zero means inspect <outDir>/projects/<slug>/overlays/diagnostics.js
            // for the per-issue list. Stays 0 on a clean emit.
            diagnosticCount = r.DiagnosticCount,
            gallery = galleryResult is null ? null : new {
                emitted = galleryResult.Success,
                picksRendered = galleryResult.PicksRendered,
                lbsCovered = galleryResult.LbsCovered,
                indexPath = galleryResult.IndexPath,
                error = galleryResult.Error,
            },
        });
    }

    private string CmdEmitRenderGallery(System.Text.Json.Nodes.JsonNode node) {
        string outDir = node["outDir"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outDir' field");
        int autoTowns = node["autoTowns"]?.GetValue<int>() ?? 5;
        int autoZones = node["autoZones"]?.GetValue<int>() ?? 5;
        int autoDungeons = node["autoDungeons"]?.GetValue<int>() ?? 5;
        int autoRegions = node["autoRegions"]?.GetValue<int>() ?? 5;
        int radius = node["radius"]?.GetValue<int>() ?? 1;
        int resolution = node["resolution"]?.GetValue<int>() ?? 1536;
        bool useSprites = node["useSprites"]?.GetValue<bool>() ?? true;
        bool overlay = node["overlay"]?.GetValue<bool>() ?? true;
        var lbFilter = ParseLbFilter(node);
        var r = _engine.EmitRenderGallery(outDir, lbFilter,
            autoTowns, autoZones, autoDungeons, autoRegions,
            radius, resolution, useSprites, overlay);
        if (!r.Success) {
            return Serialize(new {
                success = false,
                command = "emit-render-gallery",
                error = r.Error,
                outDir = r.OutDir,
            });
        }
        return Serialize(new {
            success = true,
            command = "emit-render-gallery",
            picksRendered = r.PicksRendered,
            lbsCovered = r.LbsCovered,
            totalSpawnCount = r.TotalSpawnCount,
            outDir = r.OutDir,
            indexPath = r.IndexPath,
            manifestPath = r.ManifestPath,
            picks = r.Picks,
            failures = r.Failures?.Select(f => new {
                slug = f.Slug,
                lbHex = f.LbHex,
                error = f.Error,
            }),
        });
    }

    // ── Visual-Behavior Suite (build-spec §12.2) — see CommandEngine.Vfx.cs ──

    private string CmdVfxClassify(System.Text.Json.Nodes.JsonNode node) {
        var didNode = node["did"] ?? throw new ArgumentException("Missing 'did' field");
        uint did = didNode.GetValueKind() == System.Text.Json.JsonValueKind.String
            ? WorldBuilder.Shared.Lib.HexDidJsonConverter.ParseDid(didNode.GetValue<string>())
            : didNode.GetValue<uint>();
        var r = _engine.VfxClassify(did);
        if (!r.Success) {
            return Serialize(new { success = false, command = "vfx-classify", did = $"0x{did:X8}", error = r.Error });
        }
        return Serialize(new {
            success = true,
            command = "vfx-classify",
            did = $"0x{r.Did:X8}",
            archetype = r.Archetype,
            confidence = r.Confidence,
            source = r.Source,
            mech = r.Mech,
            components = r.Components.Select(c => new {
                name = c.Name,
                channel = c.Channel,
                config = c.Config,
            }),
            signals = r.Signals.Select(s => new { name = s.Name, value = s.Value, weight = s.Weight }),
        });
    }

    private string CmdVfxEmitAllowlist(System.Text.Json.Nodes.JsonNode node) {
        string archetype = node["archetype"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'archetype' field");
        var r = _engine.VfxEmitAllowlist(archetype);
        if (!r.Success) {
            return Serialize(new { success = false, command = "vfx-emit-allowlist", archetype, error = r.Error });
        }
        return Serialize(new {
            success = true,
            command = "vfx-emit-allowlist",
            archetype = r.Archetype,
            count = r.Dids.Length,
            selectorOnly = r.SelectorOnly,
            dids = r.Dids.Select(d => $"0x{d:X8}"),
        });
    }

    private string CmdVfxEmitCatalog(System.Text.Json.Nodes.JsonNode node) {
        string outputPath = node["outputPath"]?.GetValue<string>()
            ?? node["out"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outputPath' field");
        var r = _engine.VfxEmitCatalog(outputPath);
        return Serialize(new {
            success = r.Success,
            command = "vfx-emit-catalog",
            scannedSetups = r.ScannedSetups,
            withEffect = r.WithEffect,
            written = r.Written,
            archetypeBreakdown = r.ArchetypeBreakdown,
            outputPath = r.OutputPath,
            error = r.Error,
        });
    }

    private string CmdVfxGauge(System.Text.Json.Nodes.JsonNode node) {
        string reference = node["ref"]?.GetValue<string>() ?? "holtburg";
        var r = _engine.VfxGauge(reference);
        if (r.Error != null) {
            return Serialize(new { success = false, command = "vfx-gauge", reference, error = r.Error, verdict = r.Verdict });
        }
        // success=false / withinBudget=false when a structural gate trips (the gate, build-spec §12.2).
        return Serialize(new {
            success = r.Success,
            command = "vfx-gauge",
            reference = r.Reference,
            uniqueModels = r.UniqueModels,
            totalPlacements = r.TotalPlacements,
            drawcallsDelta = r.DrawcallsDelta,
            programsDelta = r.ProgramsDelta,
            vramMB = r.VramMB,
            particleEmitters = r.ParticleEmitters,
            lightsDelta = r.LightsDelta,
            headroomPct = r.HeadroomPct,
            withinBudget = r.WithinBudget,
            verdict = r.Verdict,
            timingMeter = r.TimingMeter,
            archetypeBreakdown = r.ArchetypeBreakdown,
            gates = r.Gates.Select(g => new { id = g.Id, name = g.Name, pass = g.Pass, detail = g.Detail }),
        });
    }

    private string CmdServeRenderGallery(System.Text.Json.Nodes.JsonNode node) {
        string outDir = node["outDir"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outDir' field");
        int port = node["port"]?.GetValue<int>() ?? 8090;
        string bind = node["bind"]?.GetValue<string>() ?? "0.0.0.0";
        var r = _engine.ServeRenderGallery(outDir, port, bind);
        if (!r.Success) {
            return Serialize(new {
                success = false,
                command = "serve-render-gallery",
                error = r.Error,
                outDir = r.OutDir, port = r.Port, bind = r.Bind,
            });
        }
        return Serialize(new {
            success = true,
            command = "serve-render-gallery",
            url = r.Url,
            tailscaleUrl = r.TailscaleUrl,
            pid = r.Pid,
            port = r.Port,
            bind = r.Bind,
            outDir = r.OutDir,
        });
    }

    private string CmdDescribeFloor(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        int floor = node["floor"]?.GetValue<int>() ?? 0;
        var r = _engine.DescribeFloor(lbX, lbY, floor);
        return Serialize(new {
            success = true,
            command = "describe-floor",
            landblock = r.Landblock,
            floorIndex = r.FloorIndex,
            floorCount = r.FloorCount,
            zMin = r.ZMin,
            zMax = r.ZMax,
            cellCount = r.CellCount,
            cellResidentObjects = r.CellResidentObjects,
            looseObjectsInFloor = r.LooseObjectsInFloor,
            verbal = r.Verbal,
        });
    }

    private string CmdEmitTilePyramid(System.Text.Json.Nodes.JsonNode node) {
        var outDir = node["outDir"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'outDir' field");
        int maxZoom = node["maxZoom"]?.GetValue<int>() ?? 12;
        int minZoom = node["minZoom"]?.GetValue<int>() ?? 3;
        bool dirtyOnly = node["dirtyOnly"]?.GetValue<bool>() ?? false;
        bool emitObject = node["emitObject"]?.GetValue<bool>() ?? true;
        bool emitFloor = node["emitFloor"]?.GetValue<bool>() ?? true;
        // Throttle for ML coexistence: number of ms to sleep between LBs.
        // 0 disables. Pair with BelowNormal process priority (set inside
        // EmitTilePyramid) to keep the renderer off the ML run's cores.
        int throttleMs = node["throttleMs"]?.GetValue<int>() ?? 0;
        var lbFilter = ParseLbFilter(node);

        var r = _engine.EmitTilePyramid(lbFilter, outDir, maxZoom, minZoom,
            dirtyOnly, emitObject, emitFloor, throttleMs);
        return Serialize(new {
            success = r.FailedLandblocks == 0,
            command = "emit-tile-pyramid",
            maxZoom = r.MaxZoom,
            minZoom = r.MinZoom,
            lbsProcessed = r.LbsProcessed,
            exteriorTilesAtMaxZoom = r.ExteriorTilesAtMaxZoom,
            objectTilesAtMaxZoom = r.ObjectTilesAtMaxZoom,
            floorTilesWritten = r.FloorTilesWritten,
            downsampledTiles = r.DownsampledTiles,
            failedLandblocks = r.FailedLandblocks,
            firstFailures = (r.FirstFailures ?? new List<(ushort, string)>())
                .Select(f => new { landblock = $"0x{f.lbKey:X4}", message = f.message }).ToArray(),
            dirtyTrackingInitialized = r.DirtyTrackingInitialized,
            dirtyTilesRemaining = r.DirtyTilesRemaining,
            outDir = r.OutDir,
        });
    }

    private string CmdRenderDungeon(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        int? floor = node["floor"]?.GetValue<int>();
        int resolution = node["resolution"]?.GetValue<int>() ?? 1024;
        bool includePng = node["includePng"]?.GetValue<bool>() ?? false;
        string? outPath = node["outputPath"]?.GetValue<string>();

        var r = _engine.RenderDungeon(lbX, lbY, floor, resolution, outPath);
        return Serialize(new {
            success = true,
            command = "render-dungeon",
            landblock = $"0x{r.LbKey:X4}",
            floorIndex = r.FloorIndexRendered < 0 ? (int?)null : r.FloorIndexRendered,
            floorCount = r.FloorCount,
            cellsRendered = r.CellsRendered,
            floorZMin = r.FloorZMin,
            floorZMax = r.FloorZMax,
            outputPath = r.OutputPath,
            pngBytes = r.PngBytes.Length,
            pngBase64 = includePng ? Convert.ToBase64String(r.PngBytes) : null,
        });
    }

    private string CmdExtractCellFootprints(System.Text.Json.Nodes.JsonNode node) {
        bool force = node["force"]?.GetValue<bool>() ?? false;
        var lbFilter = ParseLbFilter(node);
        var r = _engine.ExtractCellFootprints(lbFilter, force);
        return Serialize(new {
            success = true,
            command = "extract-cell-footprints",
            cellsExtracted = r.CellsExtracted,
            synthetic = r.Synthetic,
            dungeonsScanned = r.DungeonsScanned,
            cachePath = r.CachePath,
        });
    }

    private string CmdGenerateObjectSprites(System.Text.Json.Nodes.JsonNode node) {
        bool force = node["force"]?.GetValue<bool>() ?? false;
        int spritePx = node["spritePx"]?.GetValue<int>() ?? 512;
        int throttleMs = node["throttleMs"]?.GetValue<int>() ?? 0;
        // lodLevel: 0 keeps the historical atlas/manifest paths; >0 produces
        // a parallel atlas_lodN.png + manifest_lodN.jsonl pair using
        // GfxObjDegradeInfo substitutions for low-zoom tile rendering.
        int lodLevel = node["lodLevel"]?.GetValue<int>() ?? 0;
        // nightMode: when true the renderer dims the mesh + overlays
        // Setup.Lights as glow discs, and writes to a parallel
        // atlas_night.png + manifest_night.jsonl (or atlas_lodN_night.png).
        bool nightMode = node["nightMode"]?.GetValue<bool>() ?? false;
        var lbFilter = ParseLbFilter(node);
        var r = _engine.GenerateObjectSprites(lbFilter, spritePx, force, throttleMs, lodLevel, nightMode);
        return Serialize(new {
            success = true,
            command = "generate-object-sprites",
            lodLevel = lodLevel,
            nightMode = nightMode,
            modelsCollected = r.ModelsCollected,
            modelsRendered = r.ModelsRendered,
            modelsFailed = r.ModelsFailed,
            atlasWidth = r.AtlasWidth,
            atlasHeight = r.AtlasHeight,
            spritesDir = r.SpritesDir,
            atlasPath = r.AtlasPath,
            manifestPath = r.ManifestPath,
        });
    }

    private static List<ushort>? ParseLbFilter(System.Text.Json.Nodes.JsonNode node) {
        if (node["lbFilter"] is not System.Text.Json.Nodes.JsonArray arr) return null;
        var result = new List<ushort>(arr.Count);
        foreach (var item in arr) {
            if (item is null) continue;
            // Accept "0xA9B4", "A9B4", or numeric.
            if (item.GetValueKind() == System.Text.Json.JsonValueKind.String) {
                var raw = item.GetValue<string>().Trim();
                var s = raw;
                if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s.Substring(2);
                if (!ushort.TryParse(s, System.Globalization.NumberStyles.HexNumber,
                        System.Globalization.CultureInfo.InvariantCulture, out var k))
                    throw new ArgumentException($"lbFilter entry \"{raw}\" is not a valid landblock id.");
                result.Add(k);
            } else {
                var v = item.GetValue<long>();
                if (v < 0 || v > 0xFFFF)
                    throw new ArgumentException($"lbFilter entry {v} is out of range (0..0xFFFF).");
                result.Add((ushort)v);
            }
        }
        return result;
    }

    private string CmdCompareToRetail(System.Text.Json.Nodes.JsonNode node) {
        // Defensive readers: a wrong-typed field (e.g. topK as a string,
        // perLandblock as a number) would otherwise throw inside GetValue<T>()
        // and tear down the whole stdin loop. Match the transact-diff dispatch
        // hardening pattern and return a clean error response instead.
        string? generated = TryReadString(node["generated"]);
        if (string.IsNullOrWhiteSpace(generated)) {
            return Serialize(new { success = false, command = "compare-to-retail",
                error = "Missing or non-string 'generated' field (expected a JSONL path)." });
        }
        string? retailBaseline = TryReadString(node["retailBaseline"]);
        int topK = TryReadIntDefault(node["topK"], 30);
        int anomalyMin = TryReadIntDefault(node["anomalyMinModel"], 20);
        bool perLb = node["perLandblock"] == null ? true : TryReadBool(node["perLandblock"]);
        string? cacheDir = TryReadString(node["cacheDir"]);

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
        bool useSprites = node["useSprites"]?.GetValue<bool>() ?? false;
        string? outPath = node["outputPath"]?.GetValue<string>();

        var r = _engine.RenderPreview(lbX, lbY, radius, resolution, overlay, outPath, useSprites);
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
            glyphCount = r.GlyphCount,
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
            projectDir = r.ProjectDir, datDirectory = r.DatDirectory,
            autoRestore = SerializeAutoRestore(r.AutoRestore) });
    }

    private static object SerializeAutoRestore(LoadAutoRestoreReport ar) => new {
        ontology       = ToAutoRestoreView(ar.Ontology),
        pairings       = ToAutoRestoreView(ar.Pairings),
        townGazetteer  = ToAutoRestoreView(ar.TownGazetteer),
        poiGazetteer   = ToAutoRestoreView(ar.PoiGazetteer),
        wcidAcpedia    = ToAutoRestoreView(ar.WcidAcpedia),
        spawnGazetteer = ToAutoRestoreView(ar.SpawnGazetteer),
        regions        = ToAutoRestoreView(ar.Regions),
        weenieIndex    = ToAutoRestoreView(ar.WeenieIndex),
    };

    private static object ToAutoRestoreView(LoadAutoRestoreEntry e) => new {
        source = e.Source,
        filePresent = e.FilePresent,
        loaded = e.Loaded,
        count = e.Count,
        error = e.Error,
    };

    private string CmdExport(System.Text.Json.Nodes.JsonNode node) {
        var dir = node["directory"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'directory' field");
        var iteration = node["iteration"]?.GetValue<int>();
        bool reposition = node["reposition"]?.GetValue<bool>() ?? false;

        if (!reposition) {
            var r = _engine.Export(dir, iteration);
            // success:false + counts replaces the old unconditional true so a JSON caller (or the
            // transplant pipeline) can detect a PARTIAL export where some DAT writes failed.
            return Serialize(new { success = r.Success, command = "export",
                directory = r.Directory, iteration = r.Iteration,
                terrainWritten = r.TerrainWritten,
                terrainSaveFailures = r.TerrainSaveFailures,
                docsSaved = r.DocsSaved,
                docSaveFailures = r.DocSaveFailures });
        }

        var rr = _engine.ExportWithRepositionAsync(dir, iteration).GetAwaiter().GetResult();
        // Composite success: export must succeed AND, if reposition was attempted,
        // it must have succeeded too. A "reposition attempted but failed" must not
        // be reported as success — that's how a JSON caller detects the case the
        // REPL surfaces in yellow.
        bool success = rr.ExportSuccess && (!rr.RepositionAttempted || rr.RepositionSuccess);
        return Serialize(new {
            success,
            command = "export",
            directory = rr.Directory,
            iteration = rr.Iteration,
            exportSuccess = rr.ExportSuccess,
            repositionAttempted = rr.RepositionAttempted,
            repositionSuccess = rr.RepositionSuccess,
            instancesChecked = rr.InstancesChecked,
            instancesUpdated = rr.InstancesUpdated,
            landblocksProcessed = rr.LandblocksProcessed,
            repositionError = rr.RepositionError,
        });
    }

    private string CmdInfo() {
        var r = _engine.GetInfo();
        if (!r.Loaded) return Serialize(new { success = false, command = "info", loaded = false });
        return Serialize(new { success = true, command = "info", loaded = true,
            projectName = r.ProjectName, projectFile = r.ProjectFile, projectDir = r.ProjectDir,
            datDirectory = r.DatDirectory, databasePath = r.DatabasePath, portalIteration = r.PortalIteration });
    }

    // ════════════════════════════════════════════════════
    //  Terrain editing
    // ════════════════════════════════════════════════════

    private string CmdSmooth(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y"), radius = F(node, "radius");
        float strength = FloatInRange(node, "strength", 0f, 1f, 0.5f);
        var r = _engine.ApplyTerrainEdit(new SmoothEdit(x, y, radius, strength));
        return Serialize(new { success = r.Success, command = "smooth",
            verticesModified = r.VerticesModified, landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdRaise(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y"), radius = F(node, "radius");
        int delta = OptionalInt(node, "delta", 5);
        var r = _engine.Raise(x, y, radius, delta);
        return Serialize(new { success = r.Success, command = "raise",
            verticesModified = r.VerticesModified, delta, landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdLower(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y"), radius = F(node, "radius");
        int delta = OptionalInt(node, "delta", 5);
        var r = _engine.Lower(x, y, radius, delta);
        return Serialize(new { success = r.Success, command = "lower",
            verticesModified = r.VerticesModified, delta, landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdSetHeight(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y"), radius = F(node, "radius");
        // The parameter is an index into the LandHeightTable (~Z/2 in meters),
        // not a Z coordinate. Accept "heightIndex" as the canonical name; keep
        // "height" as a deprecated alias for backwards compatibility.
        var raw = node["heightIndex"] ?? node["height"]
            ?? throw new ArgumentException("Missing 'heightIndex' field");
        var rawInt = raw.GetValue<int>();
        if (rawInt < 0 || rawInt > 255)
            throw new ArgumentException($"'heightIndex' must be 0..255; got {rawInt}");
        byte heightIndex = (byte)rawInt;
        var r = _engine.ApplyTerrainEdit(new SetHeightEdit(x, y, radius, heightIndex));
        return Serialize(new { success = r.Success, command = "set-height",
            verticesModified = r.VerticesModified, heightIndex,
            landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdPaint(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y"), radius = F(node, "radius");
        byte terrainType = ByteInRange(node, "type");
        if (terrainType > 32)
            throw new ArgumentException($"'type' must be 0..32 (the region table's defined terrain types); got {terrainType}");
        var r = _engine.ApplyTerrainEdit(new PaintEdit(x, y, radius, terrainType));
        return Serialize(new { success = r.Success, command = "paint",
            verticesModified = r.VerticesModified, terrainType,
            landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdFill(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y");
        // World bounds: landblock X/Y indices are 0..254, each 192 units wide, so
        // valid world coordinates are [0, 255*192). Without this guard a negative or
        // out-of-range seed wraps when cast to uint and lands the flood-fill in an
        // unrelated landblock (e.g. x=-500 -> uint 4294967293 -> LB row 0xFD).
        const float worldMax = 255f * 192f; // 48960
        if (x < 0f || x >= worldMax)
            throw new ArgumentException($"'x' must be within [0, {worldMax}); got {x}");
        if (y < 0f || y >= worldMax)
            throw new ArgumentException($"'y' must be within [0, {worldMax}); got {y}");
        byte newType = ByteInRange(node, "type");
        var r = _engine.Fill(x, y, newType);
        return Serialize(new { success = r.Success, command = "fill",
            verticesModified = r.VerticesModified, terrainType = newType,
            landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdRoad(System.Text.Json.Nodes.JsonNode node) {
        float x1 = F(node, "x1"), y1 = F(node, "y1"), x2 = F(node, "x2"), y2 = F(node, "y2");
        byte roadValue = node["value"] is null ? (byte)1 : ByteInRange(node, "value");
        if (roadValue > 3)
            throw new ArgumentException($"'value' must be 0..3 (only 2 road bits survive DAT export); got {roadValue}");
        var r = _engine.DrawRoad(x1, y1, x2, y2, roadValue);
        return Serialize(new { success = r.VerticesModified > 0, command = "road",
            waypoints = r.Waypoints, verticesModified = r.VerticesModified,
            roadValue = r.RoadValue, landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    // ════════════════════════════════════════════════════
    //  Terrain queries
    // ════════════════════════════════════════════════════

    private string CmdGetHeight(System.Text.Json.Nodes.JsonNode node) {
        float x = F(node, "x"), y = F(node, "y");
        var r = _engine.GetHeight(x, y);
        return Serialize(new { success = r.LandblockId.HasValue, command = "get-height",
            r.X, r.Y, height = Math.Round(r.Height, 2),
            heightIndex = r.HeightIndex, terrainType = r.TerrainType, road = r.Road, scenery = r.Scenery,
            landblock = r.LandblockId.HasValue ? $"0x{r.LandblockId:X4}" : null,
            vertexIndex = r.VertexIndex });
    }

    private string CmdTerrainInfo(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        var r = _engine.GetTerrainInfo(lbX, lbY);
        if (!r.Found) return Serialize(new { success = false, command = "terrain-info", landblock = $"0x{r.LbKey:X4}", found = false });
        return Serialize(new { success = true, command = "terrain-info", landblock = $"0x{r.LbKey:X4}", found = true,
            lbX, lbY, worldOriginX = lbX * 192, worldOriginY = lbY * 192,
            vertexCount = r.VertexCount, heightMin = r.HeightMin, heightMax = r.HeightMax, heightAvg = Math.Round(r.HeightAvg, 1),
            terrainTypes = r.TerrainTypes!.Select(tc => new { type = (int)tc.Type, count = tc.Count, percent = Math.Round(100.0 * tc.Count / r.VertexCount) }).ToArray() });
    }

    private string CmdGetHeightmap(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        var r = _engine.GetHeightmap(lbX, lbY);
        if (!r.Found) return Serialize(new { success = false, command = "get-heightmap", landblock = $"0x{r.LbKey:X4}", found = false });
        return Serialize(new { success = true, command = "get-heightmap", landblock = $"0x{r.LbKey:X4}", found = true,
            lbX, lbY, worldOriginX = lbX * 192, worldOriginY = lbY * 192,
            gridSize = 9, cellSize = 24, heightsWorld = r.HeightsWorld, heightIndices = r.HeightIndices });
    }

    private string CmdGetTerrainData(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        var r = _engine.GetTerrainData(lbX, lbY);
        if (!r.Found) return Serialize(new { success = false, command = "get-terrain-data", landblock = $"0x{r.LbKey:X4}", found = false });
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
        var (lbX, lbY) = Lb(node);
        var r = _engine.ListObjects(lbX, lbY);
        return Serialize(new { success = r.Found, command = "list-objects", landblock = $"0x{r.LbKey:X4}", found = r.Found, count = r.Objects.Count,
            objects = r.Objects.Select((obj, i) => new {
                index = i, modelId = $"0x{obj.Id:X8}", type = obj.IsSetup ? "Setup" : "GfxObj",
                x = Math.Round(obj.Origin.X, 2), y = Math.Round(obj.Origin.Y, 2), z = Math.Round(obj.Origin.Z, 2),
                orientation = FmtQ(obj.Orientation), scale = new { x = Math.Round(obj.Scale.X, 3), y = Math.Round(obj.Scale.Y, 3), z = Math.Round(obj.Scale.Z, 3) }
            }).ToArray() });
    }

    private string CmdDescribeLandblock(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        bool includeFootprints = node["includeFootprints"]?.GetValue<bool>() ?? false;
        var r = _engine.DescribeLandblock(lbX, lbY);
        return Serialize(new {
            success = true,
            command = "describe-landblock",
            landblock = r.Landblock,
            lbX = r.LbX,
            lbY = r.LbY,
            context = new {
                regionName = r.Context.RegionName,
                regionDescription = r.Context.RegionDescription,
                townName = r.Context.TownName,
                culture = r.Context.Culture,
                gazetteerNotes = r.Context.GazetteerNotes,
                knownPoiCount = r.Context.KnownPois?.Count ?? 0,
                knownPois = r.Context.KnownPois?.Select(p => new {
                    title = p.Title, categories = p.Categories, description = p.Description
                }).ToArray(),
                biome = r.Context.Biome,
                biomeConfidence = Math.Round(r.Context.BiomeConfidence, 3),
                hasRoad = r.Context.HasRoad,
                settlementHint = r.Context.SettlementHint,
                dominantArchitecture = r.Context.DominantArchitecture,
                structureCount = r.Context.StructureCount,
                dominantTerrainTypes = r.Context.DominantTerrainTypes.Select(t => new {
                    type = t.Type, name = t.Name, vertexCount = t.VertexCount, share = Math.Round(t.Share, 3)
                }).ToArray()
            },
            terrain = new {
                heightMin = Math.Round(r.Terrain.HeightMin, 2),
                heightMax = Math.Round(r.Terrain.HeightMax, 2),
                heightRange = Math.Round(r.Terrain.HeightRange, 2),
                cliffCount = r.Terrain.CliffCount,
                vertexCount = r.Terrain.VertexCount,
                summary = r.Terrain.Summary
            },
            body = new {
                objectTotal = r.Body.ObjectTotal,
                byCategory = r.Body.ByCategory.Select(c => new { category = c.Category, count = c.Count }).ToArray(),
                structures = r.Body.Structures.Select(s => new {
                    index = s.Index,
                    modelId = s.ModelId,
                    typeDescription = s.TypeDescription,
                    origin = new { x = Math.Round(s.Origin.X, 2), y = Math.Round(s.Origin.Y, 2), z = Math.Round(s.Origin.Z, 2) },
                    footprintShape = s.FootprintShape,
                    floorZ = Math.Round(s.FloorZ, 2),
                    topZ = Math.Round(s.TopZ, 2),
                    architecture = s.Architecture,
                    stories = s.Stories,
                    playableFloors = s.PlayableFloors,
                    roofShape = s.RoofShape,
                    attributedCellCount = s.AttributedCellCount,
                    materialTags = s.MaterialTags,
                    nameHint = s.NameHint,
                    tags = s.Tags,
                    containedIndices = s.ContainedIndices,
                    zBands = s.ZBands.Select(b => new { min = Math.Round(b.Min, 2), max = Math.Round(b.Max, 2), count = b.Count }).ToArray(),
                    footprintWorld = includeFootprints
                        ? s.FootprintWorld.Select(p => new { x = Math.Round(p.X, 2), y = Math.Round(p.Y, 2) }).ToArray()
                        : null
                }).ToArray(),
                looseObjectCount = r.Body.LooseObjectCount,
                looseZBands = r.Body.LooseZBands.Select(b => new { min = Math.Round(b.Min, 2), max = Math.Round(b.Max, 2), count = b.Count }).ToArray(),
                untaggedIndices = r.Body.UntaggedIndices,
                interior = r.Body.Interior == null ? null : new {
                    cellCount = r.Body.Interior.CellCount,
                    zMin = Math.Round(r.Body.Interior.ZMin, 2),
                    zMax = Math.Round(r.Body.Interior.ZMax, 2),
                    zRange = Math.Round(r.Body.Interior.ZRange, 2),
                    zBandCount = r.Body.Interior.ZBandCount,
                    cellGraphEdges = r.Body.Interior.CellGraphEdges,
                    exteriorPortals = r.Body.Interior.ExteriorPortals,
                    staticObjectCount = r.Body.Interior.StaticObjectCount
                },
                namedObjects = r.Body.NamedObjects.Select(n => new {
                    index = n.Index, modelId = n.ModelId, wcid = n.Wcid,
                    weenieName = n.WeenieName, acpediaTitle = n.AcpediaTitle,
                    acpediaCategories = n.AcpediaCategories,
                    acpediaDescription = n.AcpediaDescription, tier = n.Tier
                }).ToArray(),
                spawnCount = r.Body.Spawns.Count,
                spawns = r.Body.Spawns.Select(s => new {
                    wcid = s.Wcid, name = s.Name,
                    category = s.Category, generator = s.Generator,
                    landblockId = $"0x{s.LandblockId:X4}", cell = s.Cell,
                    weenieType = s.WeenieType,
                    acpediaTitle = s.AcpediaTitle, acpediaTier = s.AcpediaTier,
                    x = Math.Round(s.X, 2), y = Math.Round(s.Y, 2), z = Math.Round(s.Z, 2),
                    isSynthetic = s.IsSynthetic
                }).ToArray()
            },
            relations = r.Relations,
            verbal = r.Verbal,
            validation = r.Validation == null ? null : new {
                isValid = r.Validation.IsValid,
                errorCount = r.Validation.ErrorCount,
                warningCount = r.Validation.WarningCount,
                infoCount = r.Validation.InfoCount,
                diagnostics = r.Validation.Diagnostics.Select(d => new {
                    severity = d.Severity, code = d.Code, message = d.Message, context = d.Context
                }).ToArray()
            }
        });
    }

    // 2026-05-23 — compact landblock-expectations export for the
    // holtburger-web wire-agent diagnostic layer. Reuses DescribeLandblock
    // but emits only the fields the in-browser oracle needs (npcs +
    // buildings + scenery counts + dungeon cells), keyed by the full
    // 32-bit landblockId (e.g. "0xA9B40000") so it matches the wire's
    // spawn-meta high-16-bits convention. Consumer:
    //   window.__diag.setExpected(await (await fetch(url)).json())
    //   window.__diag.diff(0xA9B40000)
    //
    // Wave-2 extension (2026-05-23): also folds in pre-baked scenery
    // placements + pre-baked event trigger sources from the
    // holtburger-scenery-bake / holtburger-event-bake JSONL artifacts.
    // - `bakedScenery: [...]` — direct copies of scenery.jsonl records;
    //   LB-LOCAL coords (0-192). The diff layer handles LB→world conversion.
    // - `events: [...]` — flattened expected-event entries from
    //   events.jsonl. Ambient records explode into one entry per
    //   ambient_sounds[] slot. Physics/sky particle records pass through
    //   with light field renaming so `type + emitter_did + source`
    //   match-keys hold.
    // - `bakeWarnings: [...]` — soft errors (missing file, bad JSON line,
    //   unrecognized source). Empty when both bake files load clean.
    //
    // Optional command fields:
    //   sceneryBakeDir — default /mnt/wbterminal1/holtburger-dist-v2/scenery/
    //   eventsBakeDir — default /mnt/wbterminal1/holtburger-dist-v2/events/
    // Filenames are composed as `0x{lbX:X2}{lbY:X2}.{scenery,events}.jsonl`.
    private string CmdDumpLbExpectations(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        var r = _engine.DescribeLandblock(lbX, lbY);
        uint lbKey32 = (uint)((lbX & 0xff) << 24) | (uint)((lbY & 0xff) << 16);
        // Optional `--out` (or "out") path. When set, the oracle payload is
        // ALSO written to disk so the wire-agent diag harness can fetch by
        // URL (`./oracles/<lbHex>.json`). Convention used by the
        // holtburger-web Wave-1 diagnostic layer: write to
        // `apps/holtburger-web/oracles/0xLLLL0000.json`. Caller passes the
        // ABSOLUTE path; we don't infer.
        string outPath = node["out"]?.GetValue<string>() ?? "";

        // Pre-bake artifact directories. Filenames use 16-bit LB form
        // (0xLLLL), NOT the 32-bit landblockId (0xLLLL0000).
        string sceneryDir = node["sceneryBakeDir"]?.GetValue<string>()
                            ?? "/mnt/wbterminal1/holtburger-dist-v2/scenery/";
        string eventsDir = node["eventsBakeDir"]?.GetValue<string>()
                           ?? "/mnt/wbterminal1/holtburger-dist-v2/events/";
        string lbHex16 = $"0x{lbX:X2}{lbY:X2}";
        var bakeWarnings = new List<string>();
        var bakedScenery = LoadBakedScenery(
            System.IO.Path.Combine(sceneryDir, $"{lbHex16}.scenery.jsonl"),
            bakeWarnings);
        var events = LoadBakedEvents(
            System.IO.Path.Combine(eventsDir, $"{lbHex16}.events.jsonl"),
            bakeWarnings);

        bool outWritten = false;
        string? outError = null;
        var payload = new {
            success = true,
            command = "dump-lb-expectations",
            landblockId = $"0x{lbKey32:X8}",
            lbX = r.LbX,
            lbY = r.LbY,
            timestamp = DateTime.UtcNow.ToString("O"),
            npcs = r.Body.Spawns.Select(s => new {
                wcid = s.Wcid,
                name = s.Name,
                category = s.Category,
                generator = s.Generator,
                cell = s.Cell,
                weenieType = s.WeenieType,
                x = Math.Round(s.X, 2),
                y = Math.Round(s.Y, 2),
                z = Math.Round(s.Z, 2),
                isSynthetic = s.IsSynthetic,
            }).ToArray(),
            buildings = r.Body.Structures.Select(s => new {
                index = s.Index,
                modelId = s.ModelId,
                typeDescription = s.TypeDescription,
                origin = new {
                    x = Math.Round(s.Origin.X, 2),
                    y = Math.Round(s.Origin.Y, 2),
                    z = Math.Round(s.Origin.Z, 2),
                },
                floorZ = Math.Round(s.FloorZ, 2),
                topZ = Math.Round(s.TopZ, 2),
                stories = s.Stories,
                attributedCellCount = s.AttributedCellCount,
                nameHint = s.NameHint,
            }).ToArray(),
            sceneryCount = r.Body.LooseObjectCount,
            bakedScenery,
            events,
            bakeWarnings,
            interior = r.Body.Interior == null ? null : new {
                cellCount = r.Body.Interior.CellCount,
                zMin = Math.Round(r.Body.Interior.ZMin, 2),
                zMax = Math.Round(r.Body.Interior.ZMax, 2),
                cellGraphEdges = r.Body.Interior.CellGraphEdges,
                exteriorPortals = r.Body.Interior.ExteriorPortals,
                staticObjectCount = r.Body.Interior.StaticObjectCount,
            },
            counts = new {
                npcs = r.Body.Spawns.Count,
                buildings = r.Body.Structures.Count,
                sceneryLandblockInfo = r.Body.LooseObjectCount,
                sceneryBaked = bakedScenery.Count,
                events = events.Count,
                envCells = r.Body.Interior?.CellCount ?? 0,
            },
        };

        // Write the oracle file (if requested) and thread the outcome into the
        // response so a bad dir / permissions / full disk is visible.
        if (!string.IsNullOrEmpty(outPath)) {
            try {
                System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(outPath) ?? ".");
                System.IO.File.WriteAllText(outPath, Serialize(payload));
                outWritten = true;
            } catch (Exception ex) {
                outError = ex.Message;
                Console.Error.WriteLine($"[dump-lb-expectations] out write failed ({outPath}): {ex.Message}");
            }
        }

        return Serialize(new {
            payload.success,
            payload.command,
            payload.landblockId,
            payload.lbX,
            payload.lbY,
            payload.timestamp,
            payload.npcs,
            payload.buildings,
            payload.sceneryCount,
            payload.bakedScenery,
            payload.events,
            payload.bakeWarnings,
            payload.interior,
            payload.counts,
            outPath = string.IsNullOrEmpty(outPath) ? null : outPath,
            outWritten,
            outError,
        });
    }

    // Read scenery.jsonl as one JsonNode per line. Tolerates missing file
    // (returns empty + warning) and corrupt lines (skips + warning). Records
    // are passed through unchanged — coord conversion lives in the diff layer.
    private static List<System.Text.Json.Nodes.JsonNode?> LoadBakedScenery(
        string path, List<string> warnings) {
        var records = new List<System.Text.Json.Nodes.JsonNode?>();
        if (!System.IO.File.Exists(path)) {
            warnings.Add($"scenery file missing at {path}");
            return records;
        }
        try {
            foreach (var line in System.IO.File.ReadAllLines(path)) {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try {
                    var rec = System.Text.Json.Nodes.JsonNode.Parse(line);
                    if (rec != null) records.Add(rec);
                } catch (Exception ex) {
                    warnings.Add($"scenery bad json line in {path}: {ex.Message}");
                }
            }
        } catch (Exception ex) {
            warnings.Add($"scenery read failed at {path}: {ex.Message}");
        }
        return records;
    }

    // Read events.jsonl and flatten into the diff-layer's expected-event
    // schema. Ambient records explode (one entry per ambient_sounds[]
    // slot). Physics/sky particle records pass through with light field
    // renaming (emitter_id → emitter_did, normalized type+source). Unknown
    // sources are passed through with `_passthrough: true` so the diff
    // surfaces the coverage gap rather than silently dropping records.
    private static List<object> LoadBakedEvents(string path, List<string> warnings) {
        var events = new List<object>();
        if (!System.IO.File.Exists(path)) {
            warnings.Add($"events file missing at {path}");
            return events;
        }
        try {
            foreach (var line in System.IO.File.ReadAllLines(path)) {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try {
                    var rec = System.Text.Json.Nodes.JsonNode.Parse(line);
                    if (rec == null) continue;
                    FlattenEventRecord(rec, events, warnings);
                } catch (Exception ex) {
                    warnings.Add($"events bad json line in {path}: {ex.Message}");
                }
            }
        } catch (Exception ex) {
            warnings.Add($"events read failed at {path}: {ex.Message}");
        }
        return events;
    }

    private static void FlattenEventRecord(
        System.Text.Json.Nodes.JsonNode rec,
        List<object> events,
        List<string> warnings) {
        string source = rec["source"]?.GetValue<string>() ?? "";
        if (source == "ambient") {
            // One expected-event entry per ambient_sounds[] slot.
            int terrainType = rec["terrain_type"]?.GetValue<int>() ?? -1;
            string stbId = rec["stb_id"]?.GetValue<string>() ?? "";
            var vertexIndices = (rec["vertex_indices"] as System.Text.Json.Nodes.JsonArray)
                ?.Select(v => v?.GetValue<int>() ?? -1).ToArray()
                ?? Array.Empty<int>();
            var sounds = rec["ambient_sounds"] as System.Text.Json.Nodes.JsonArray;
            if (sounds == null) return;
            foreach (var s in sounds) {
                if (s == null) continue;
                bool continuous = s["continuous"]?.GetValue<bool>() ?? false;
                events.Add(new {
                    type = "sound",
                    source = "AmbientRuntime",
                    trigger = continuous ? "continuous" : "probabilistic",
                    terrain_type = terrainType,
                    stb_id = stbId,
                    s_type = s["s_type"]?.GetValue<int>() ?? -1,
                    vertex_indices = vertexIndices,
                    volume = s["volume"]?.GetValue<double>() ?? 0.0,
                    base_chance = s["base_chance"]?.GetValue<double>() ?? 0.0,
                    min_rate = s["min_rate"]?.GetValue<double>() ?? 0.0,
                    max_rate = s["max_rate"]?.GetValue<double>() ?? 0.0,
                });
            }
            return;
        }
        // Recognized particle sources: pass through with normalized
        // emitter_did + type so the diff's `type + emitter_did + source`
        // match-key works. `physics_script_particle` is the actual bake
        // value; `physics_particle` is the spec-doc alias. Accept both.
        if (source == "physics_script_particle" || source == "physics_particle") {
            events.Add(new {
                type = "physics_particle",
                source,
                trigger = rec["trigger"]?.GetValue<string>() ?? source,
                emitter_did = rec["emitter_id"]?.GetValue<string>() ?? "",
                default_script_id = rec["default_script_id"]?.GetValue<string>() ?? "",
                start_time_s = rec["start_time_s"]?.GetValue<double>() ?? 0.0,
                part_index = rec["part_index"]?.GetValue<int>() ?? 0,
                blocking = rec["blocking"]?.GetValue<bool>() ?? false,
                anchor = rec["anchor"]?.GetValue<string>() ?? "",
            });
            return;
        }
        if (source == "sky_particle") {
            events.Add(new {
                type = "sky_particle",
                source,
                trigger = rec["trigger"]?.GetValue<string>() ?? source,
                emitter_did = rec["emitter_id"]?.GetValue<string>()
                              ?? rec["emitter_did"]?.GetValue<string>() ?? "",
                raw = rec.DeepClone(),
            });
            return;
        }
        if (source == "anim_hook") {
            events.Add(new {
                type = "anim_sound",
                source = "AnimationHook",
                trigger = rec["trigger"]?.GetValue<string>() ?? source,
                wave_did = rec["wave_did"]?.GetValue<string>() ?? "",
                raw = rec.DeepClone(),
            });
            return;
        }
        // Unknown source — preserve the record verbatim with a passthrough
        // marker. The diff layer will report this as a coverage gap.
        warnings.Add($"unrecognized event source: {source}");
        events.Add(new {
            _passthrough = true,
            source,
            raw = rec.DeepClone(),
        });
    }

    // Serialize wrapper that ALSO writes the JSON to outPath when set,
    // mirroring the existing static Serialize call shape. The on-disk
    // write is best-effort — diagnostic errors land in stderr but don't
    // block the stdout response (so callers parsing stdin loops aren't
    // disrupted).
    private static string Serialize(object payload, string outPath) {
        string json = Serialize(payload);
        if (!string.IsNullOrEmpty(outPath)) {
            try {
                System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(outPath) ?? ".");
                System.IO.File.WriteAllText(outPath, json);
            } catch (Exception ex) {
                Console.Error.WriteLine($"[dump-lb-expectations] out write failed ({outPath}): {ex.Message}");
            }
        }
        return json;
    }

    private string CmdAddObject(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        uint modelId = Hex32(node, "modelId");
        float x = F(node, "x"), y = F(node, "y"), z = F(node, "z");

        var orientation = ParseQuaternion(node) ?? Quaternion.Identity;

        float sx = node["scaleX"]?.GetValue<float>() ?? node["scale"]?.GetValue<float>() ?? 1f;
        float sy = node["scaleY"]?.GetValue<float>() ?? node["scale"]?.GetValue<float>() ?? 1f;
        float sz = node["scaleZ"]?.GetValue<float>() ?? node["scale"]?.GetValue<float>() ?? 1f;

        bool snap = node["snap"]?.GetValue<bool>() ?? false;

        var r = _engine.AddObject(lbX, lbY, modelId, x, y, z, orientation, new Vector3(sx, sy, sz), snap);
        return Serialize(new { success = r.Success, command = "add-object", landblock = $"0x{r.LbKey:X4}",
            index = r.Index, modelId = $"0x{r.Object.Id:X8}", type = r.Object.IsSetup ? "Setup" : "GfxObj",
            x = Math.Round(r.Object.Origin.X, 2), y = Math.Round(r.Object.Origin.Y, 2), z = Math.Round(r.Object.Origin.Z, 2),
            snapped = snap, orientation = FmtQ(r.Object.Orientation),
            scale = new { x = Math.Round(r.Object.Scale.X, 3), y = Math.Round(r.Object.Scale.Y, 3), z = Math.Round(r.Object.Scale.Z, 3) } });
    }

    private string CmdRemoveObject(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        int index = RequiredInt(node, "index");
        var r = _engine.RemoveObject(lbX, lbY, index);
        return Serialize(new { success = r.Success, command = "remove-object", landblock = $"0x{r.LbKey:X4}",
            index = r.Index, removedModelId = $"0x{r.RemovedModelId:X8}",
            removedPosition = new { x = Math.Round(r.RemovedPosition.X, 1), y = Math.Round(r.RemovedPosition.Y, 1), z = Math.Round(r.RemovedPosition.Z, 1) } });
    }

    private string CmdMoveObject(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        int index = RequiredInt(node, "index");
        float x = F(node, "x"), y = F(node, "y"), z = F(node, "z");
        var r = _engine.MoveObject(lbX, lbY, index, x, y, z);
        return Serialize(new { success = r.Success, command = "move-object", landblock = $"0x{r.LbKey:X4}",
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

        var (lbX, lbY) = Lb(node);
        var result = _engine.ClearObjects(lbX, lbY);
        ushort lbKey = (ushort)((lbX << 8) | lbY);
        return Serialize(new {
            success = result.Success,
            command = "clear-objects",
            all = false,
            landblock = $"0x{lbKey:X4}",
            found = result.Found,
            objectsRemoved = result.ObjectsRemoved
        });
    }

    private string CmdRotateObject(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        int index = RequiredInt(node, "index");

        var qParsed = ParseQuaternion(node);
        bool hasYaw = node["yaw"] != null;
        Quaternion newQ;
        if (qParsed.HasValue) {
            // Absolute quaternion — sets orientation directly (does not compose)
            newQ = qParsed.Value;
        } else if (hasYaw) {
            // Yaw shorthand — sets Z-axis rotation to this angle (does not add to existing)
            float yawDeg = node["yaw"]!.GetValue<float>();
            newQ = Quaternion.CreateFromAxisAngle(Vector3.UnitZ, yawDeg * MathF.PI / 180f);
        } else {
            return Serialize(new { success = false, command = "rotate-object",
                error = "Provide quaternion (qw,qx,qy,qz) or yaw (degrees). Note: this SETS the orientation, it does not add to existing rotation." });
        }

        var r = _engine.RotateObject(lbX, lbY, index, newQ);
        return Serialize(new { success = r.Success, command = "rotate-object", landblock = $"0x{r.LbKey:X4}",
            index = r.Index, modelId = $"0x{r.ModelId:X8}",
            oldOrientation = FmtQ(r.OldOrientation), newOrientation = FmtQ(r.NewOrientation) });
    }

    // ════════════════════════════════════════════════════
    //  Spatial queries
    // ════════════════════════════════════════════════════

    private string CmdQueryRadius(System.Text.Json.Nodes.JsonNode node) {
        float cx = F(node, "x"), cy = F(node, "y"), radius = F(node, "radius");
        if (radius < 0f)
            throw new ArgumentException($"'radius' must be non-negative; got {radius}");
        float cz = 0f;
        if (node["z"] is { } zNode) {
            cz = zNode.GetValue<float>();
            if (!float.IsFinite(cz))
                throw new ArgumentException($"'z' must be finite; got {cz}");
        }
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
        try {
            var (report, savedTo) = _engine.AnalyzeDungeons(outputPath);
            return Serialize(new { success = true, command = "analyze-dungeons",
                totalLandblocksScanned = report.TotalLandblocksScanned,
                totalCellsScanned = report.TotalCellsScanned,
                uniqueRoomTypes = report.UniqueRoomTypes,
                topStarterCandidates = report.TopStarterCandidates.Select(c => new {
                    envFileId = $"0x{c.EnvFileId:X8}", cellStructIndex = c.CellStructIndex,
                    portalCount = c.PortalCount, usageCount = c.UsageCount,
                    sampleDungeonNames = c.SampleDungeonNames }).ToArray(),
                savedTo = string.IsNullOrEmpty(savedTo) ? null : savedTo });
        } catch (Exception ex) {
            return Serialize(new { success = false, command = "analyze-dungeons", error = ex.Message });
        }
    }

    private string CmdGetDungeonInfo(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
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
            errors = r.Errors,
            buildingInteriorLandblocks = r.BuildingInteriorLandblocks,
            outputPath = r.OutputPath });
    }

    // ════════════════════════════════════════════════════
    //  Validation
    // ════════════════════════════════════════════════════

    private string CmdValidateDungeon(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        return FormatValidation("validate-dungeon", lbX, lbY, _engine.ValidateDungeon(lbX, lbY));
    }

    private string CmdValidateLandblock(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        return FormatValidation("validate-landblock", lbX, lbY, _engine.ValidateLandblock(lbX, lbY));
    }

    private string CmdCompareRenderCorners(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        float tol = node["toleranceMetres"]?.GetValue<float>() ?? 0.05f;
        bool includeAll = node["includeAll"]?.GetValue<bool>() ?? false;
        var r = _engine.CompareRenderCorners(lbX, lbY, tol);
        // Always emit failures; emit all entries only when caller asks
        // — full corner dumps for an LB with hundreds of buildings
        // bloat the response.
        object MapBuilding(WorldBuilder.Shared.Lib.Validation.ValidationEngine.CornerDiffBuilding b) => new {
            modelId = $"0x{b.ObjectId:X8}",
            origin = new { x = b.Origin.X, y = b.Origin.Y, z = b.Origin.Z },
            orientation = new { w = b.Orientation.W, x = b.Orientation.X, y = b.Orientation.Y, z = b.Orientation.Z },
            yawRadians = b.YawRadians,
            cornerCount = b.LocalCorners.Length,
            maxCornerDeltaMetres = b.MaxCornerDeltaMetres,
            localCorners = b.LocalCorners.Select(c => new[] { c.X, c.Y }).ToArray(),
            worldCornersFullQuat = b.WorldCornersFullQuat.Select(c => new[] { c.X, c.Y }).ToArray(),
            worldCornersYawOnly = b.WorldCornersYawOnly.Select(c => new[] { c.X, c.Y }).ToArray(),
        };
        return Serialize(new {
            success = true,
            command = "compare-render-corners",
            landblock = $"0x{r.LandblockKey:X4}",
            toleranceMetres = r.ToleranceMetres,
            buildingCount = r.BuildingCount,
            passedCount = r.PassedCount,
            failedCount = r.FailedCount,
            isClean = r.FailedCount == 0,
            failures = r.Failures.Select(MapBuilding).ToArray(),
            buildings = includeAll ? r.Buildings.Select(MapBuilding).ToArray() : null,
        });
    }

    private string CmdValidateTerrain(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        float threshold = PositiveFiniteFloat(node, "cliffThreshold", ValidationEngine.DefaultCliffThreshold);
        return FormatValidation("validate-terrain", lbX, lbY, _engine.ValidateTerrain(lbX, lbY, threshold));
    }

    private string CmdValidateBuildingShells(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        return FormatValidation("validate-building-shells", lbX, lbY, _engine.ValidateBuildingShells(lbX, lbY));
    }

    private string CmdValidateBuildingPortals(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        return FormatValidation("validate-building-portals", lbX, lbY, _engine.ValidateBuildingPortals(lbX, lbY));
    }

    private string CmdValidateAll(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        float threshold = PositiveFiniteFloat(node, "cliffThreshold", ValidationEngine.DefaultCliffThreshold);
        return FormatValidation("validate-all", lbX, lbY, _engine.ValidateAll(lbX, lbY, threshold));
    }

    // ════════════════════════════════════════════════════
    //  World observation
    // ════════════════════════════════════════════════════

    private string CmdListLandblocks(System.Text.Json.Nodes.JsonNode node) {
        uint minX = node["minX"]?.GetValue<uint>() ?? 0, minY = node["minY"]?.GetValue<uint>() ?? 0;
        uint maxX = node["maxX"]?.GetValue<uint>() ?? 254, maxY = node["maxY"]?.GetValue<uint>() ?? 254;
        int limit = node["limit"]?.GetValue<int>() ?? 500;
        if (minX > 254) throw new ArgumentException($"'minX' must be 0..254; got {minX}");
        if (minY > 254) throw new ArgumentException($"'minY' must be 0..254; got {minY}");
        if (maxX > 254) throw new ArgumentException($"'maxX' must be 0..254; got {maxX}");
        if (maxY > 254) throw new ArgumentException($"'maxY' must be 0..254; got {maxY}");
        if (minX > maxX) throw new ArgumentException($"'minX' ({minX}) must be ≤ 'maxX' ({maxX})");
        if (minY > maxY) throw new ArgumentException($"'minY' ({minY}) must be ≤ 'maxY' ({maxY})");
        if (limit <= 0) throw new ArgumentException($"'limit' must be > 0; got {limit}");
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
            portalIteration = r.PortalIteration,
            activeDocumentCount = r.ActiveDocuments?.Count ?? 0,
            activeDocuments = r.ActiveDocuments?.Select(d => new {
                id = d.Id, type = d.Type, isDirty = d.IsDirty
            }).ToArray() });
    }

    private string CmdGetRegion() {
        var r = _engine.GetRegion();
        return Serialize(new { success = true, command = "get-region",
            // T-1: full Region 0x13 projection (was: heightTable + names only).
            regionNumber = r.RegionNumber,
            version = r.Version,
            regionName = r.RegionName,
            partsMask = $"0x{r.PartsMask:X8}",
            landDefs = r.LandDefs == null ? null : new {
                numBlockLength = r.LandDefs.NumBlockLength,
                numBlockWidth = r.LandDefs.NumBlockWidth,
                squareLength = r.LandDefs.SquareLength,
                lBlockLength = r.LandDefs.LBlockLength,
                vertexPerCell = r.LandDefs.VertexPerCell,
                maxObjHeight = r.LandDefs.MaxObjHeight,
                skyHeight = r.LandDefs.SkyHeight,
                roadWidth = r.LandDefs.RoadWidth,
            },
            gameTime = r.GameTime == null ? null : new {
                present = r.GameTime.Present,
                zeroTimeOfYear = r.GameTime.ZeroTimeOfYear,
                zeroYear = r.GameTime.ZeroYear,
                dayLength = r.GameTime.DayLength,
                daysPerYear = r.GameTime.DaysPerYear,
                yearSpec = r.GameTime.YearSpec,
                timesOfDayCount = r.GameTime.TimesOfDayCount,
                seasonsCount = r.GameTime.SeasonsCount,
            },
            hasSkyInfo = r.HasSkyInfo,
            hasSoundInfo = r.HasSoundInfo,
            hasSceneInfo = r.HasSceneInfo,
            hasRegionMisc = r.HasRegionMisc,
            dayGroupCount = r.DayGroupCount,
            soundStbCount = r.SoundStbCount,
            sceneTypeCount = r.SceneTypeCount,
            heightTable = r.HeightTable.Select(h => Math.Round(h, 2)).ToArray(),
            heightTableSize = r.HeightTable.Length,
            terrainTypeCount = r.TerrainTypes?.Count,
            terrainTypes = r.TerrainTypes?.Select(tt => new { index = tt.Index, name = tt.Name }).ToArray(),
            terrainTypeDetails = r.TerrainTypeDetails?.Select(td => new {
                index = td.Index, name = td.Name,
                terrainColor = $"0x{td.TerrainColor:X8}",
                sceneTypeCount = td.SceneTypeCount,
            }).ToArray() });
    }

    private string CmdGetTerrainTextures() {
        var r = _engine.GetTerrainTextures();
        if (!r.Found)
            return Serialize(new { success = false, command = "get-terrain-textures", error = r.Error });
        return Serialize(new { success = true, command = "get-terrain-textures",
            baseTexSize = r.BaseTexSize,
            terrainDescCount = r.TerrainDesc.Count,
            terrainDesc = r.TerrainDesc.Select(d => new {
                index = d.Index,
                terrainType = d.TerrainType,
                texGID = $"0x{d.TexGID:X8}",
                resolvedTextureId = $"0x{d.ResolvedTextureId:X8}",
                texTiling = d.TexTiling,
                detailTexGID = $"0x{d.DetailTexGID:X8}",
                detailTexTiling = d.DetailTexTiling,
                minVertBright = d.MinVertBright, maxVertBright = d.MaxVertBright,
                minVertSaturate = d.MinVertSaturate, maxVertSaturate = d.MaxVertSaturate,
                minVertHue = d.MinVertHue, maxVertHue = d.MaxVertHue,
            }).ToArray(),
            cornerTerrainMaps = r.CornerTerrainMaps.Select(m => new { code = m.Code, textureId = $"0x{m.TextureId:X8}" }).ToArray(),
            sideTerrainMaps = r.SideTerrainMaps.Select(m => new { code = m.Code, textureId = $"0x{m.TextureId:X8}" }).ToArray(),
            roadMaps = r.RoadMaps.Select(m => new { code = m.Code, textureId = $"0x{m.TextureId:X8}" }).ToArray() });
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
            classifiedAsBuilding = rpt.ClassifiedAsBuilding,
            classifiedAsScenery = rpt.ClassifiedAsScenery,
            classifiedAsFurniture = rpt.ClassifiedAsFurniture,
            classifiedAsProp = rpt.ClassifiedAsProp,
            classifiedAsUnknown = rpt.ClassifiedAsUnknown,
            failedCount = rpt.FailedEntries.Count,
            failures = rpt.FailedEntries.Take(20)
                .Select(f => new { id = $"0x{f.Id:X8}", reason = f.Reason }).ToArray(),
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
        if (limit <= 0) throw new ArgumentException($"'limit' must be > 0; got {limit}");

        uint? objectId = null;
        if (node["objectId"] != null) {
            objectId = Hex32(node, "objectId");
        }

        var r = _engine.QueryOntology(category, scale, keyword, objectId, limit);
        return Serialize(new { success = true, command = "query-ontology",
            totalIndexed = r.TotalIndexed, returned = r.Entries.Length,
            entries = r.Entries.Select(e => new {
                objectId = $"0x{e.ObjectId:X8}", datType = e.DatType,
                category = e.Category, scale = e.Scale,
                source = e.ClassificationSource,
                name = e.Name,
                weenieClassId = e.WeenieClassId,
                level = e.Level,
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
        return Serialize(new { success = r.TerrainChanges > 0 || r.ObjectsPlaced > 0, command = "paste-stamp",
            terrainChanges = r.TerrainChanges, objectsPlaced = r.ObjectsPlaced,
            objectsSkipped = r.ObjectsSkipped, skipMessages = r.SkipMessages,
            landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdGetBulkHeightmap(System.Text.Json.Nodes.JsonNode node) {
        uint minX = U(node, "minX"), minY = U(node, "minY");
        uint maxX = U(node, "maxX"), maxY = U(node, "maxY");
        ValidateLbCoord("minX", minX); ValidateLbCoord("minY", minY);
        ValidateLbCoord("maxX", maxX); ValidateLbCoord("maxY", maxY);
        if (minX > maxX) throw new ArgumentException($"'minX' ({minX}) must be <= 'maxX' ({maxX})");
        if (minY > maxY) throw new ArgumentException($"'minY' ({minY}) must be <= 'maxY' ({maxY})");
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
        uint objectId = Hex32(node, "objectId");
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
        var (lbX, lbY) = Lb(node);
        var r = _engine.DiffTerrain(lbX, lbY);
        if (!r.Found) return Serialize(new { success = true, command = "diff-terrain",
            landblock = $"0x{r.LbKey:X4}", found = false });
        if (!r.BaseFound) return Serialize(new { success = true, command = "diff-terrain",
            landblock = $"0x{r.LbKey:X4}", found = true, baseFound = false,
            hasChanges = false, totalVertices = r.TotalVertices,
            note = $"No base-DAT terrain for 0x{r.LbKey:X4}; cannot diff — change counters are not meaningful." });
        return Serialize(new { success = true, command = "diff-terrain",
            landblock = $"0x{r.LbKey:X4}", found = true, baseFound = true,
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
        var (lbX, lbY) = Lb(node);
        ushort targetCellNum = HexOrDecU16(node, "targetCellNumber");
        ushort targetPolyId = HexOrDecU16(node, "targetPortalPolyId");
        ushort sourceEnvId = HexOrDecU16(node, "sourceEnvId");
        ushort sourceCellStruct = node["sourceCellStruct"]?.GetValue<ushort>() ?? 0;

        // Optional explicit surface list; when omitted the new cell inherits the
        // target cell's surfaces (so it is not invisible in-game).
        List<ushort>? surfaceOverride = null;
        if (node["surfaces"] is System.Text.Json.Nodes.JsonArray surfArr) {
            surfaceOverride = new List<ushort>(surfArr.Count);
            foreach (var s in surfArr)
                if (s != null) surfaceOverride.Add(s.GetValue<ushort>());
        }

        var r = _engine.SnapPortal(lbX, lbY, targetCellNum, targetPolyId, sourceEnvId, sourceCellStruct, surfaceOverride);
        return Serialize(new { success = true, command = "snap-portal",
            landblock = $"0x{r.LbKey:X4}",
            targetCellNumber = $"0x{r.TargetCellNumber:X4}",
            targetPortalPolygonId = $"0x{r.TargetPortalPolygonId:X4}",
            newCellNumber = $"0x{r.NewCellNumber:X4}",
            sourceEnvironmentId = $"0x{r.SourceEnvironmentId:X4}",
            sourceCellStructure = r.SourceCellStructure,
            newOrigin = new { x = Math.Round(r.NewOrigin.X, 2), y = Math.Round(r.NewOrigin.Y, 2), z = Math.Round(r.NewOrigin.Z, 2) },
            newOrientation = FmtQ(r.NewOrientation),
            portalCount = r.PortalCount,
            surfaceCount = r.SurfaceCount,
            warning = r.Warning });
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
            new { name = "set-height",       args = "x, y, radius, heightIndex (height = deprecated alias)", description = "Set terrain height index (0..255, an index into the LandHeightTable, ~Z/2 m)" },
            new { name = "paint",            args = "x, y, radius, type",                    description = "Paint terrain texture" },
            new { name = "fill",             args = "x, y, type",                            description = "Flood-fill terrain" },
            new { name = "road",             args = "x1, y1, x2, y2, value?",                description = "Draw road path" },
            new { name = "get-height",       args = "x, y",                                  description = "Query terrain height at point" },
            new { name = "terrain-info",     args = "lbX, lbY",                              description = "Landblock statistics" },
            new { name = "get-heightmap",    args = "lbX, lbY",                              description = "Full 9×9 heightmap grid" },
            new { name = "get-terrain-data", args = "lbX, lbY",                              description = "All vertex data" },
            new { name = "list-objects",     args = "lbX, lbY",                              description = "List static objects" },
            new { name = "add-object",       args = "lbX, lbY, modelId, x, y, z, qw?+qx?+qy?+qz? (all or none), scale?|scaleX?+scaleY?+scaleZ?, snap?", description = "Place object" },
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
            new { name = "get-region",       args = "",                                      description = "Full Region 0x13: LandDefs, GameTime, PartsMask + Sky/Sound/Scene presence, height table, per-type color/sceneTypes" },
            new { name = "scan-ontology",    args = "scanGfxObjs?",                             description = "Scan DAT to classify all models" },
            new { name = "query-ontology",   args = "category?, scale?, keyword?, objectId?, limit?", description = "Query the ontology index" },
            new { name = "ontology-stats",   args = "",                                      description = "Ontology category/scale breakdown" },
            new { name = "paste-stamp",      args = "srcMinX, srcMinY, srcMaxX, srcMaxY, destX, destY, includeObjects?, blendEdges?, zOffset?", description = "Copy & paste terrain" },
            new { name = "snap-portal",      args = "lbX, lbY, targetCellNumber, targetPortalPolyId, sourceEnvId, sourceCellStruct?, surfaces?", description = "Snap dungeon cell to portal" },
            new { name = "get-bulk-heightmap", args = "minX, minY, maxX, maxY",               description = "Multi-landblock heightmaps in one call" },
            new { name = "get-object-detail", args = "objectId",                              description = "DAT model geometry & ontology info" },
            new { name = "diff-terrain",     args = "lbX, lbY",                              description = "Compare current terrain vs base DAT" },
            new { name = "get-terrain-layers", args = "lbX, lbY",                              description = "Terrain type distribution per landblock" },
            new { name = "get-terrain-textures", args = "",                                    description = "Region TexMerge painting chain: per-type base/detail TexGID + tiling + vert-mod, corner/side/road alpha maps" },
            new { name = "export-textures",  args = "outputDir, minId?, maxId?",               description = "Export RenderSurface textures to PNG" },
            new { name = "import-texture",   args = "textureId, imagePath",                    description = "Replace a texture from image file (IMMEDIATE + PERMANENT in-place write to the base client_portal.dat; not undoable. Use import-render-surface for a deferred, export-time replacement)" },
            new { name = "clone-dat",        args = "outputPath",                              description = "Clone portal DAT to a new file" },
            new { name = "defragment-dat",   args = "datType, outputPath",                     description = "Defragment DAT (portal/cell/local)" },
            new { name = "export-ontology",  args = "outputPath",                              description = "Export ontology to CSV" },
            new { name = "export-setup-parts", args = "outputPath",                            description = "Export Setup -> Parts (GfxObj) JSONL" },
            new { name = "export-classification-signals", args = "outputPath",                 description = "Export building/scenery setup IDs (JSON)" },
            new { name = "mine-strings",     args = "outputPath?, filter?",                     description = "Extract strings from DAT StringTables" },
            new { name = "enrich-ontology",  args = "",                                      description = "Enrich ontology with schema names & creature families" },
            new { name = "import-catalog",   args = "indexPath",                                description = "Import ACViewer catalog into ontology" },
            new { name = "classify-ontology", args = "",                                      description = "Auto-tag ontology from StringTable names" },
            new { name = "enrich-materials", args = "",                                       description = "Tag entries that reference Surface (0x08) records with 'textured'" },
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
            new { name = "ace-db-ingest-creatures", args = "out?",                              description = "Pull creature roster from ACE DB → creature_gazetteer.json" },
            new { name = "ace-db-ingest-npcs",      args = "out?",                              description = "Pull NPC roster from ACE DB → npc_gazetteer.json" },
            new { name = "ace-db-ingest-housing",   args = "out?",                              description = "Pull housing portal roster from ACE DB → housing_gazetteer.json" },
            new { name = "ace-db-ingest-spawns",    args = "out?",                              description = "Pull every landblock_instance row (+ generator children) → ace_spawn_records.jsonl (SpawnRecord shape)" },
            new { name = "ace-db-ingest-encounters", args = "out? append?",                      description = "Pull every encounter row (+ generator children) → SpawnRecords; append:true merges into the spawns file" },
            new { name = "ace-db-ingest-weenie-index", args = "out?",                           description = "Pull canonical wcid → identity (setup, name, type) → weenie_index.jsonl" },
            new { name = "compare-creatures-to-retail", args = "",                              description = "Jaccard similarity of project's spawn gazetteer vs. ACE creature/NPC rosters (global wcid sets; housing = counts only, jaccard not computed; novelWcids/missingWcids capped at 50 with novelTotal/missingTotal pre-truncation counts)" },
            new { name = "benchmark",        args = "",                                         description = "Run speed test suite (terrain, objects, validation, bulk). Non-destructive: snapshots the first 50 populated landblocks and restores them afterward (landblocksRestored). Reports failedObjectPlacements (excluded from opsPerSec)." },
            new { name = "set-landblock-heightmap", args = "lbX, lbY, heights",                  description = "Set all 81 heights in one call" },
            new { name = "set-landblock-terrain", args = "lbX, lbY, types",                      description = "Set all 81 terrain types in one call" },
            new { name = "import-heightmap", args = "imagePath, startLbX? (default 0), startLbY? (default 0), lbCountX, lbCountY, apply?", description = "Import grayscale+colormap PNG; height from luminance, type from nearest texture color" },
            new { name = "import-render-surface", args = "imagePath, renderSurfaceId, ui?, name?", description = "Import a PNG to replace a RenderSurface (default: register in CustomTextureStore; --ui: deferred portal write)" },
            new { name = "open-log-folder", args = "",                                            description = "Returns the active --log-file path so the agent can ingest it (no folder-opening side effects)" },
            new { name = "creature-get", args = "objectId",                                       description = "Loads ACE-DB creature visual overrides (texture map, anim part, palette)" },
            new { name = "creature-save", args = "objectId, fromJson",                            description = "Replaces texture-map + anim-part rows for the given object_Id (transactional)" },
            new { name = "creature-export-sql", args = "objectId, out?",                          description = "Generates idempotent DELETE+INSERT SQL for the creature's overrides" },
            new { name = "layout-list",         args = "overlayOnly?",                            description = "Lists every LayoutDesc id from the local DAT (or only ones with a project overlay)" },
            new { name = "layout-get",          args = "layoutId",                                description = "Returns a LayoutDesc as JSON; preferred from project overlay if present" },
            new { name = "layout-save",         args = "layoutId, fromJson",                      description = "Saves a LayoutDesc into the project's LayoutDatDocument overlay (fromJson = inline JSON if it starts with '{', else a JSON file path)" },
            new { name = "layout-delete-overlay", args = "layoutId",                              description = "Removes the project overlay for a LayoutDesc id (DAT original is untouched)" },
            new { name = "spell-list",          args = "limit?, source?",                          description = "Lists newest spell ids by source (\"dat\" default, \"db\" for ace-db); annotates rows that have a project overlay" },
            new { name = "spell-get",           args = "id",                                       description = "Returns a SpellRecord JSON; project overlay wins, falls back to ace-db" },
            new { name = "spell-save",          args = "id, fromJson",                             description = "Writes a SpellRecord into the project overlay; if ace-db is connected also UPSERTs the row" },
            new { name = "spell-copy",          args = "fromId, newId?",                           description = "Clones a spell with a new id (auto-allocates max+1 if newId is omitted)" },
            new { name = "spell-delete",        args = "id",                                       description = "Removes a spell from the project overlay; if ace-db is connected also DELETEs the row" },
            new { name = "weenie-save",         args = "classId, fromJson",                        description = "Replaces all scalar weenie_properties_* rows for an existing class_Id" },
            new { name = "weenie-insert",       args = "className, fromJson",                      description = "Creates a new weenie row (auto-class-id ≥100000) and saves the snapshot scalars" },
            new { name = "weenie-delete",       args = "classId",                                  description = "Deletes a weenie + every weenie_properties_* row that points at its class_Id" },
            new { name = "weenie-list-property-keys", args = "family",                             description = "Enumerates AcePropertyXxx names by family (int|int64|bool|float|string|did|iid)" },
            new { name = "placement-list",      args = "lbX?, lbY?, kind?",                        description = "Lists outdoor/dungeon instance placements (filtered by lb + kind)" },
            new { name = "placement-add-outdoor", args = "lbX, lbY, wcid, cellNumber? (1..64), originX?, originY?, originZ? (default 0), anglesW?, anglesX?, anglesY?, anglesZ?", description = "Appends an outdoor instance placement to Project.OutdoorInstancePlacements" },
            new { name = "placement-add-dungeon", args = "lbX, lbY, wcid, cellNumber? (0x100..0xFFFD), originX?, originY?, originZ? (default 0), anglesW?, anglesX?, anglesY?, anglesZ?", description = "Appends a dungeon instance placement to the dungeon document for the given lb" },
            new { name = "placement-remove",    args = "kind, index",                              description = "Removes an outdoor or dungeon placement by index in its respective list" },
            new { name = "placement-set-scope", args = "kind, index, scope",                       description = "Sets a placement's enrichment scope: classDefault (Option A, world weenie_properties_*) or placementOverride (Option B, shard biota_properties_*)" },
            new { name = "ace-db-connect",       args = "host, port?, database?, user?, password?",  description = "Tests + saves the ACE WORLD DB connection; database defaults to ace_world" },
            new { name = "ace-db-status",        args = "",                                         description = "Shows the ACE WORLD DB connection settings + tests connectivity" },
            new { name = "ace-shard-db-connect", args = "host, port?, database? (alias db), user?, password? (alias pass)",  description = "Tests + saves the ACE SHARD DB connection (separate from world ace-db); db defaults to ace_shard; rejects a target matching the world DB (host aliases localhost/127.0.0.1/::1 + DNS resolution normalized)" },
            new { name = "ace-shard-db-status",  args = "",                                         description = "Shows the ACE SHARD DB connection settings + tests connectivity" },
            new { name = "placement-export-sql", args = "out?, apply?, dryRun?, force?, validate?",   description = "Writes landblock_instances.sql + dungeon_instances.sql + per-class weenie_properties_*.sql (world) + per-placement biota_properties_*.sql (shard) + validation_report.jsonl; E6 validation gate blocks on errors unless force; apply writes world to ace-db + biota to ace-shard-db; dryRun emits files only (no DB)" },
            new { name = "fresh-start",         args = "confirm",                                  description = "Clears terrain (to deep sea), dungeon, AND landblock (static-object) documents — all staged placements are discarded (requires confirm:true)" },
            new { name = "generate-world",      args = "params?, apply?, exportTownsCsv?",         description = "GUI-parity world generation: ResetWorldDocs → terrain → buildings → decorations; optional CSV emit" },
            new { name = "export-towns-csv",    args = "fromResult, out",                          description = "Renders the GUI's towns CSV from a worldgen result JSON written by 'worldgen-analyze-buildings' (or 'worldgen' with outputPath)" },
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
            new { name = "extract-retail-heightmaps", args = "outputPath?", description = "Dump all 255×255 landblock heightmaps as JSONL (source = live project terrain, reflects in-session edits — see 'source' field; not raw retail DAT)" },
            new { name = "compute-vanilla-baseline", args = "outputPath?", description = "Compute retail quality baseline metrics (density, terrain dist, etc.) — computes from the loaded project; run against an unmodified vanilla project for a true retail baseline." },
            new { name = "render-preview",   args = "lbX, lbY, radius?, resolution?, overlay?, includePng?, outputPath?", description = "Top-down PNG of an N×N landblock region (terrain + objects + cliff/pairing overlays). Returns base64 PNG." },
            new { name = "compare-to-retail", args = "generated, retailBaseline?, topK?, anomalyMinModel?, perLandblock?, cacheDir?", description = "Subprocess the Python comparator; score generated world vs retail with per-LB drilldown and class-space ratio. Caches retail snapshot for tight tuning loops." },
            new { name = "transact",         args = "ops[] | opsFile, rollback_on_fail?, validate?, diff?", description = "Stage N mutating ops, validate the staged delta, atomically commit or rollback. Allow-list: terrain edits, object placement, generate-dungeon. validate=auto|all|none|{landblocks:[...]}. diff=true|\"structured\"|\"visual\"|\"both\" inlines the transact-diff response." },
            new { name = "transact-diff",    args = "txId, render?, renderMode?, lbs?, resolution?, out?",        description = "Structured before/after report for a committed transaction. renderMode=overlay|side-by-side|after-only-with-diff. Returns TXDIFF-EXPIRED or TXDIFF-ROLLED-BACK if the snapshot is unavailable." },
            new { name = "describe-landblock", args = "lbX, lbY",                            description = "Living Atlas: verbal + deeply structured per-LB description (terrain, structures, spawns, POIs, validation). Composes ontology + region/town gazetteer + Acpedia + LSD spawnMap." },
            new { name = "dump-lb-expectations", args = "lbX, lbY",                          description = "Compact landblock oracle for holtburger-web wire-agent diagnostic layer — npcs (wcid+name+pos) + buildings (modelId+origin) + scenery count + interior cells. Consumer: window.__diag.setExpected(json); window.__diag.diff(0xLLLL0000)." },
            new { name = "get-tile",         args = "zoom? (default \"lb\"), lbX?, lbY?, region?, includeBase64?", description = "Tile pyramid (sourced from render-preview). zoom=lb (LB-keyed), region (region name), or world. Returns path + size + optional base64 PNG." },
            new { name = "tile-stats",       args = "",                                      description = "Tile-cache totals, dirty counts, disk used vs. budget" },
            new { name = "regenerate-dirty-tiles", args = "",                                description = "Rebuild every dirty LB tile and clear only the LBs that succeeded (failed LBs stay dirty for retry; success=false when any LB failed). World/region composite tiles are NOT rebuilt here — they regenerate lazily on next request." },
            new { name = "list-dirty-tiles", args = "",                                      description = "Enumerate LBs whose tiles need regeneration." },
            new { name = "mark-tiles-clean", args = "",                                      description = "Force-clear all dirty bits without regenerating." },
            new { name = "prune-tiles",      args = "keepNewest?, olderThan?",               description = "LRU-prune the LB-tile layer; region+world tiles are pinned." },
            new { name = "generate-atlas-tiles", args = "mode, lbList?",                     description = "Bulk-generate tiles. mode=lbs|regions|world|all. mode=lbs requires lbList[{lbX,lbY}]; mode=all sweeps every LB and may take many minutes." },
            new { name = "emit-render-gallery", args = "outDir, autoTowns?, autoZones?, autoDungeons?, autoRegions?, radius?, resolution?, useSprites?, overlay?, lbFilter?", description = "Curate N landblocks (5 towns + 5 creature zones + 5 dungeons + 5 region anchors by default), render-preview + describe-landblock per pick, bundle into a Tailwind gallery dir. Per-pick render faults are reported in 'failures':[{slug,lbHex,error}]." },
            new { name = "serve-render-gallery",       args = "outDir, port?, bind?",                  description = "Serve a gallery (or any) directory over HTTP via a built-in C# HttpListener. Detects Tailscale IPs and reports a tailnet-reachable URL when one is available." },
            new { name = "region-export-json", args = "out?, parts?, datPath?",              description = "Export Region 0x13000000 (LandDefs/GameTime/Sky/Sound/Scene/Terrain/Misc) as a stable JSON document. parts filters to sky|sound|scene|terrain|misc (comma list). Prefers staged PortalDatDocument edits, then project DATs, then base portal DAT." },
            new { name = "region-import-json", args = "path, apply?",                        description = "Validate a region JSON document, rebuild the Region DBObj, verify pack/unpack self-parity; apply:true stages it into PortalDatDocument so 'export' writes it to the export DATs." },
            new { name = "region-diff",        args = "otherDat?, otherJson?, maxRows?",     description = "Deep field-by-field Region diff vs a second DAT (path or portal/cell alias) or a previously exported region JSON. Emits {path, ours, theirs} rows." },
            new { name = "dat-open",           args = "path, alias",                         description = "Open an external DAT (directory with the 4 EoR dats, or a single .dat file) read-only under a named alias. Aliases are accepted wherever a second DAT is consumed (region-diff otherDat, future scene-diff / transplant fromDat)." },
            new { name = "dat-close",          args = "alias",                               description = "Dispose and unregister an external DAT handle." },
            new { name = "dat-list",           args = "",                                    description = "Enumerate open external DAT handles ({alias, path, kind})." },
            new { name = "scene-export-json",  args = "sceneId|all, out?, datPath?",         description = "Dump Scene 0x12 ObjectDescs (full retail field set incl. freq/displace/scale/slope/align/orient) as JSON; all:true sweeps every scene to 'out'." },
            new { name = "scene-diff",         args = "sceneId, otherDat, maxRows?",         description = "Per-object field diff of a Scene vs a second DAT (dat-open alias or path)." },
            new { name = "scene-where-used",   args = "sceneId",                             description = "Reverse map via Region 0x13: which SceneDesc scene-type indices carry this scene and which TerrainTypes reference them." },
            new { name = "scene-edit",         args = "sceneId, index, fields, apply?",      description = "Mutate one ObjectDesc (fields: objectId, origin, orientation, frequency, displaceX, displaceY, minScale, maxScale, maxRotation, minSlope, maxSlope, align, orient, weenieObj) and stage the Scene for export (apply:true)." },
            new { name = "asset-refs",         args = "id, datPath?",                        description = "Forward asset-chain edges for a DID: Scene→placed objects, Setup→GfxObj parts, GfxObj→Surfaces, Surface→SurfaceTexture/Palette, SurfaceTexture→RenderSurfaces." },
            new { name = "asset-used-by",      args = "id, transitive?, datPath?",           description = "Reverse lookup: who references this DID. First call builds a session-cached portal-DAT reverse index; transitive:true walks the closure up to Setups/Scenes ('which models show this surface')." },
            new { name = "surface-fingerprint", args = "id?, match?, datPath?",              description = "Fingerprint a Surface (Type, OrigTexture/Palette, ColorValue, Translucency, Luminosity, Diffuse) and find all surfaces sharing it, or query by partial match spec — locates the same material under different IDs." },
            new { name = "copy-landblock",     args = "fromDat, srcLbX, srcLbY, dstLbX?, dstLbY?, heightmap?, textures?, objects?, buildings?, clearExisting?", description = "Copy a landblock from an external DAT (dat-open alias or directory): terrain heights and/or texture bytes, exterior objects, buildings incl. interior EnvCells (cell-ID remap at export). dst defaults to src. Validate + export afterwards." },
            new { name = "copy-building",      args = "fromDat, srcLbX, srcLbY, buildingIndex, dstLbX, dstLbY, x, y, z, qw?/qx?/qy?/qz?", description = "Transplant one building + interior cells from an external DAT to a world position (donor-blueprint pipeline handles cell-ID remap + VisibleCells fixup at export)." },
            new { name = "remove-building",    args = "lbX, lbY, buildingIndex",             description = "Remove a building's shell from the staged landblock; export drops the BuildingInfo and decrements NumCells (interior cells orphaned)." },
            new { name = "bulk-paint-replace", args = "lbList|minLbX..maxLbY, fromType?, toType", description = "Bulk terrain-type substitution across many LBs (melt bucket-fill): replace fromType with toType, or repaint all 81 vertices when fromType omitted." },
            new { name = "melt-reference",     args = "topic?",                              description = "Agent briefing for DEFERRED melt functionality (not implemented): topics dm-textures, id-migration, cache-converters, acedb-recipes. No topic = list; topic = full markdown section with melt file:line pointers. Read-only knowledge surface." },
            new { name = "compare-render-corners", args = "lbX, lbY, toleranceMetres?, includeAll?", description = "Compares full-quat vs yaw-only building corner placement for a landblock; failures[] when divergence > tolerance (default 0.05m); buildings[] null unless includeAll" },
            new { name = "obj-export",         args = "datId, outputPath",                     description = "Exports a GfxObj/Setup (datId accepts 0x hex or decimal) to a Wavefront .obj" },
            new { name = "obj-import",         args = "objPath, surfaceDid, gfxObjId?, setupId?", description = "Imports a Wavefront .obj as a GfxObj/Setup (ids accept 0x hex or decimal)" },
            new { name = "physics-jump-formula", args = "(jump inputs)",                        description = "Diagnostic: evaluates the jump-height formula for given inputs" },
            new { name = "physics-jump-formula-sweep", args = "caseCount?",                     description = "Diagnostic: sweeps the jump-height formula across caseCount cases (default 1000)" },
            new { name = "physics-replay-trace", args = "traceSubjectPath, probeScenarioPath, maxDriftOverride?", description = "Diagnostic: replays a recorded physics trace against a probe scenario and reports drift" },
            new { name = "pvs-visibility-snapshot", args = "cellId, bfsDepth?, datPath?, out?", description = "Diagnostic: PVS oracle — BFS visible-cell set from a cell (see docs/cell-portal-method.md)" },
            new { name = "region-skybox-snapshot", args = "gameTimeSec, datPath?",              description = "Diagnostic: skybox state at a game time (see docs/skybox-parity-method.md)" },
            new { name = "region-day-night-curve", args = "hours?, datPath?",                   description = "Diagnostic: day/night light curve sampled over hours (default 24)" },
            new { name = "weenie-snapshot",    args = "(weenie ids)",                           description = "Snapshots weenie definitions to a bundle" },
            new { name = "weenie-template-list", args = "bundlePath",                            description = "Lists templates in a weenie bundle" },
            new { name = "weenie-template-apply", args = "bundlePath, templateId, classId",      description = "Applies a weenie template (classId accepts 0x hex or decimal) to the world DB" },
            new { name = "worldgen",           args = "seed?, fullWorld?, startX?, startY?, …, outputPath?", description = "Runs the world generator (WorldGeneratorParams fields); writes a result JSON consumed by export-towns-csv/worldgen-analyze-buildings" },
            new { name = "worldgen-analyze-buildings", args = "(worldgen inputs), outputPath?",  description = "Analyzes building placements from a worldgen pass; its outputPath feeds export-towns-csv" },
            new { name = "worldgen-scan-retail-towns", args = "(scan roots)",                    description = "Scans retail town layouts for worldgen reference data" },
            new { name = "wave4-status",       args = "",                                      description = "Reports the cached wave4 parity sweep status (no run); cache root under /mnt/wbterminal1" },
            new { name = "wave4-sweep",        args = "mode?, target?, concurrency?, reset?",  description = "Runs the wave4 parity sweep driver (WORLDBUILDER_WAVE4_SWEEP/WORLDBUILDER_NODE env overrides; 6h timeout; report/cache roots under /mnt/wbterminal1). success requires exitCode 0 + no failed/infra chunks" },
            new { name = "diag-run-all",       args = "wave4Mode?, reportDir?, skipSurfaces?, parallel?", description = "Runs the full diagnostics driver (WORLDBUILDER_DIAG_DRIVER/WORLDBUILDER_NODE env overrides; 2h timeout); success gated on required-failures" },
            new { name = "diag-status",        args = "",                                      description = "Reports the last diagnostics run status (no run)" },
            new { name = "quit",             args = "",                                      description = "Exit terminal" }
        };
        return Serialize(new { success = true, command = "help", protocol = "json-line", version = "1.5",
            description = "Send one JSON object per line. Each must have a 'command' field.", commands });
    }

    // ════════════════════════════════════════════════════
    //  Terrain layers
    // ════════════════════════════════════════════════════

    private string CmdGetTerrainLayers(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
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
        uint? minId = node["minId"] != null ? ParseUintField(node, "minId") : null;
        uint? maxId = node["maxId"] != null ? ParseUintField(node, "maxId") : null;
        var r = _engine.ExportTextures(outputDir, minId, maxId);
        return Serialize(new { success = r.Success, command = "export-textures",
            exported = r.Exported, failed = r.Failed,
            outputDirectory = r.OutputDirectory,
            errors = (r.Errors ?? new List<string>()).Take(20).ToArray(),
            totalErrors = r.Failed,
            truncated = r.Failed > 20 });
    }

    private string CmdImportTexture(System.Text.Json.Nodes.JsonNode node) {
        uint textureId = ParseUintField(node, "textureId");
        var imagePath = node["imagePath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'imagePath' field");
        var r = _engine.ImportTexture(textureId, imagePath);
        return Serialize(new { success = r.Success, command = "import-texture",
            textureId = $"0x{r.TextureId:X8}", inputFile = r.InputFile,
            mode = r.Mode, error = r.Error });
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
            bytesFreed = r.BytesFreed, filesSkipped = r.FilesSkipped,
            warning = r.Warning, error = r.Error });
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
            setupsFailed = r.SetupsFailed, failedSample = r.FailedSample,
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
            tablesScanned = r.TablesScanned, tablesSkipped = r.TablesSkipped,
            errorCount = r.TablesSkipped,
            totalStrings = r.TotalStrings,
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
            entriesEnriched = r.EntriesEnriched, entriesFailed = r.EntriesFailed,
            totalEntries = r.TotalEntries,
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
            withSetupDid = r.WithSetupDid, errorCount = r.ErrorCount, outputPath = r.OutputPath,
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
            entriesLoaded = r.EntriesLoaded, linesSkipped = r.LinesSkipped,
            inputPath = r.InputPath, error = r.Error,
        });
    }

    private string CmdEnrichUnified(System.Text.Json.Nodes.JsonNode node) {
        var path = node["path"]?.GetValue<string>()
            ?? node["unifiedJsonPath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'path' field");
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("'path' must not be empty");
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
            errorCount = r.ErrorCount, outputPath = r.OutputPath, error = r.Error });
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
            errorCount = r.ErrorCount, outputPath = r.OutputPath, error = r.Error });
    }

    private string CmdAceDbIngestCreatures(System.Text.Json.Nodes.JsonNode node) {
        var outPath = node["out"]?.GetValue<string>();
        var r = _engine.IngestCreatureRosterAsync(outPath).GetAwaiter().GetResult();
        return Serialize(new { success = r.Success, command = "ace-db-ingest-creatures",
            totalProcessed = r.TotalProcessed, outputPath = r.OutputPath, error = r.Error });
    }

    private string CmdAceDbIngestNpcs(System.Text.Json.Nodes.JsonNode node) {
        var outPath = node["out"]?.GetValue<string>();
        var r = _engine.IngestNpcRosterAsync(outPath).GetAwaiter().GetResult();
        return Serialize(new { success = r.Success, command = "ace-db-ingest-npcs",
            totalProcessed = r.TotalProcessed, vendorCount = r.VendorCount, otherNpcCount = r.OtherNpcCount,
            outputPath = r.OutputPath, error = r.Error });
    }

    private string CmdAceDbIngestHousing(System.Text.Json.Nodes.JsonNode node) {
        var outPath = node["out"]?.GetValue<string>();
        var r = _engine.IngestHousingRosterAsync(outPath).GetAwaiter().GetResult();
        return Serialize(new { success = r.Success, command = "ace-db-ingest-housing",
            houseCount = r.HouseCount, portalCount = r.PortalCount,
            outputPath = r.OutputPath, error = r.Error });
    }

    private string CmdAceDbIngestSpawns(System.Text.Json.Nodes.JsonNode node) {
        var outPath = node["out"]?.GetValue<string>();
        var r = _engine.IngestAceSpawnsAsync(outPath).GetAwaiter().GetResult();
        return Serialize(new { success = r.Success, command = "ace-db-ingest-spawns",
            landblocksTouched = r.LandblocksTouched, recordsWritten = r.RecordsWritten,
            syntheticRecords = r.SyntheticRecords, generatorChildren = r.GeneratorChildren,
            outputPath = r.OutputPath, error = r.Error });
    }

    private string CmdAceDbIngestEncounters(System.Text.Json.Nodes.JsonNode node) {
        var outPath = node["out"]?.GetValue<string>();
        var append = node["append"]?.GetValue<bool>() ?? false;
        var r = _engine.IngestAceEncountersAsync(outPath, append).GetAwaiter().GetResult();
        return Serialize(new { success = r.Success, command = "ace-db-ingest-encounters",
            landblocksTouched = r.LandblocksTouched, recordsWritten = r.RecordsWritten,
            syntheticRecords = r.SyntheticRecords, zeroZRecords = r.ZeroZRecords,
            outputPath = r.OutputPath, error = r.Error });
    }

    private string CmdAceDbIngestWeenieIndex(System.Text.Json.Nodes.JsonNode node) {
        var outPath = node["out"]?.GetValue<string>();
        var r = _engine.IngestWeenieIndexAsync(outPath).GetAwaiter().GetResult();
        return Serialize(new { success = r.Success, command = "ace-db-ingest-weenie-index",
            totalEntries = r.TotalEntries, withSetupDid = r.WithSetupDid,
            serverManaged = r.ServerManaged,
            outputPath = r.OutputPath, error = r.Error });
    }

    private string CmdCompareCreaturesToRetail() {
        var r = _engine.CompareCreaturesToRetail();
        static object Dim(CompareCategoryDimension d) => new {
            generated = d.GeneratedCount, retail = d.RetailCount,
            jaccard = d.JaccardComputed ? (double?)d.Jaccard : null,
            jaccardNote = d.JaccardComputed ? null : "counts only — jaccard not implemented",
            retailSource = d.RetailSource,
            novelWcids = d.NovelInLb, missingWcids = d.MissingInLb,
            novelTotal = d.NovelTotal, missingTotal = d.MissingTotal,
        };
        return Serialize(new {
            success = r.Success, command = "compare-creatures-to-retail",
            creatures = Dim(r.Creatures),
            npcs = Dim(r.Npcs),
            housing = Dim(r.Housing),
            error = r.Error,
        });
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
            errorCount = r.ErrorCount, outputPath = r.OutputPath, error = r.Error });
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
            },
            failedObjectPlacements = r.FailedObjectPlacements,
            landblocksRestored = r.LandblocksRestored
        });
    }

    private string CmdSetLandblockHeightmap(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        var heightsNode = node["heights"] ?? throw new ArgumentException("Missing 'heights' field");
        byte[] heights = ParseByteArrayField(heightsNode, "heights");
        var r = _engine.SetLandblockHeightmap(lbX, lbY, heights);
        return Serialize(new { success = true, command = "set-landblock-heightmap",
            landblock = $"0x{r.LbKey:X4}", verticesModified = r.VerticesModified,
            landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdFreshStart(System.Text.Json.Nodes.JsonNode node) {
        bool confirm = node["confirm"]?.GetValue<bool>() ?? false;
        if (!confirm) {
            return Serialize(new {
                success = false, command = "fresh-start",
                error = "fresh-start is destructive. Re-run with \"confirm\":true."
            });
        }
        var r = _engine.FreshStartAsync().GetAwaiter().GetResult();
        return Serialize(new {
            success = r.Success, command = "fresh-start",
            landblocksReset = r.LandblocksReset,
            verticesReset = r.VerticesReset
        });
    }

    private string CmdGenerateWorld(System.Text.Json.Nodes.JsonNode node) {
        var paramsNode = node["params"];
        var p = paramsNode != null
            ? System.Text.Json.JsonSerializer.Deserialize<WorldBuilder.Shared.Lib.WorldGen.WorldGeneratorParams>(
                paramsNode.ToJsonString(),
                WorldBuilder.Shared.Lib.JsonOpts.CaseInsensitive)
            : new WorldBuilder.Shared.Lib.WorldGen.WorldGeneratorParams();
        if (p == null) throw new ArgumentException("Could not parse 'params'.");

        bool apply = node["apply"]?.GetValue<bool>() ?? false;
        string? csvPath = node["exportTownsCsv"]?.GetValue<string>();

        var r = _engine.GenerateWorldAsync(p, apply, csvPath).GetAwaiter().GetResult();
        return Serialize(new {
            success = r.Success, command = "generate-world",
            seed = r.Seed, applied = r.Applied,
            landblocksAffected = r.LandblocksAffected,
            verticesModified = r.VerticesModified,
            towns = r.Towns, buildingsPlaced = r.BuildingsPlaced,
            decorationsPlaced = r.DecorationsPlaced, roadVertices = r.RoadVertices,
            townsCsvPath = r.TownsCsvPath, townsCsvRows = r.TownsCsvRows,
            townSummaries = r.TownSummaries
        });
    }

    private string CmdExportTownsCsv(System.Text.Json.Nodes.JsonNode node) {
        string fromResult = node["fromResult"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'fromResult' field");
        string outPath = node["out"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'out' field");
        var r = _engine.ExportTownsCsv(fromResult, outPath);
        return Serialize(new {
            success = r.Success, command = "export-towns-csv",
            outPath = r.OutPath, rows = r.Rows
        });
    }

    private string CmdPlacementList(System.Text.Json.Nodes.JsonNode node) {
        bool hasX = node["lbX"] != null, hasY = node["lbY"] != null;
        // Filtering by landblock requires BOTH coords; a lone lbX/lbY would otherwise
        // silently disable the filter (F162). Reject it explicitly.
        if (hasX != hasY)
            throw new ArgumentException("placement-list landblock filter needs both 'lbX' and 'lbY' (or neither).");
        int? lbX = null, lbY = null;
        if (hasX && hasY) {
            var (lx, ly) = Lb(node);   // range-checks 0..254 (F162)
            lbX = (int)lx;
            lbY = (int)ly;
        }
        string kind = node["kind"]?.GetValue<string>() ?? "all";
        var r = _engine.PlacementList(lbX, lbY, kind);
        return Serialize(new {
            success = true, command = "placement-list",
            count = r.Count, filter = r.Filter,
            placements = r.Placements.Select(p => new {
                kind = p.Kind, index = p.Index, landblock = p.Landblock,
                wcid = p.Wcid, cellNumber = p.CellNumber,
                origin = new { x = p.OriginX, y = p.OriginY, z = p.OriginZ },
                angles = new { w = p.AnglesW, x = p.AnglesX, y = p.AnglesY, z = p.AnglesZ }
            })
        });
    }

    private string CmdPlacementAddOutdoor(System.Text.Json.Nodes.JsonNode node) {
        var (lbXu, lbYu) = Lb(node);   // required + range-checked 0..254 (F162)
        uint wcid = ParseUintField(node, "wcid");
        int cellNumberRaw = node["cellNumber"]?.GetValue<int>() ?? 1;
        if (cellNumberRaw < 1 || cellNumberRaw > 64)
            throw new ArgumentException($"outdoor 'cellNumber' must be in 1..64; got {cellNumberRaw}");
        ushort cellNumber = (ushort)cellNumberRaw;
        float ox = node["originX"]?.GetValue<float>() ?? 0f;
        float oy = node["originY"]?.GetValue<float>() ?? 0f;
        float oz = node["originZ"]?.GetValue<float>() ?? 0f;
        var (aw, ax, ay, az) = ReadPlacementAngles(node);   // all-or-none + normalize (F166)
        var r = _engine.PlacementAddOutdoor((int)lbXu, (int)lbYu, wcid, cellNumber, ox, oy, oz,
            aw, ax, ay, az);
        return Serialize(new { success = r.Success, command = "placement-add-outdoor",
            kind = r.Kind, index = r.Index, landblock = r.Landblock });
    }

    private string CmdPlacementAddDungeon(System.Text.Json.Nodes.JsonNode node) {
        var (lbXu, lbYu) = Lb(node);   // required + range-checked 0..254 (F162)
        uint wcid = ParseUintField(node, "wcid");
        int cellNumberRaw = node["cellNumber"]?.GetValue<int>() ?? 0x100;
        if (cellNumberRaw < 0x100 || cellNumberRaw > 0xFFFD)
            throw new ArgumentException($"dungeon 'cellNumber' must be in 0x100..0xFFFD; got {cellNumberRaw}");
        ushort cellNumber = (ushort)cellNumberRaw;
        float ox = node["originX"]?.GetValue<float>() ?? 0f;
        float oy = node["originY"]?.GetValue<float>() ?? 0f;
        float oz = node["originZ"]?.GetValue<float>() ?? 0f;
        var (aw, ax, ay, az) = ReadPlacementAngles(node);   // all-or-none + normalize (F166)
        var r = _engine.PlacementAddDungeon((int)lbXu, (int)lbYu, wcid, cellNumber, ox, oy, oz,
            aw, ax, ay, az);
        return Serialize(new { success = r.Success, command = "placement-add-dungeon",
            kind = r.Kind, index = r.Index, landblock = r.Landblock });
    }

    /// <summary>
    /// F166 — read the four optional placement angle fields with all-or-none semantics. Supplying
    /// SOME (e.g. only anglesW) yields an unnormalized garbage quaternion, so we require either all
    /// four or none. When all four are supplied they are normalized on input (like add-object). When
    /// none are supplied we return (null,null,null,null) so the engine applies the identity default
    /// (w=1, x=y=z=0).
    /// </summary>
    private static (float? w, float? x, float? y, float? z) ReadPlacementAngles(
        System.Text.Json.Nodes.JsonNode node) {
        var wN = node["anglesW"]; var xN = node["anglesX"];
        var yN = node["anglesY"]; var zN = node["anglesZ"];
        int supplied = (wN != null ? 1 : 0) + (xN != null ? 1 : 0)
                     + (yN != null ? 1 : 0) + (zN != null ? 1 : 0);
        if (supplied == 0) return (null, null, null, null);
        if (supplied != 4)
            throw new ArgumentException(
                "Placement angles are all-or-none: supply all of anglesW/anglesX/anglesY/anglesZ or none.");
        var q = System.Numerics.Quaternion.Normalize(new System.Numerics.Quaternion(
            xN!.GetValue<float>(), yN!.GetValue<float>(), zN!.GetValue<float>(), wN!.GetValue<float>()));
        return (q.W, q.X, q.Y, q.Z);
    }

    private string CmdPlacementRemove(System.Text.Json.Nodes.JsonNode node) {
        string kind = node["kind"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'kind' field (outdoor|dungeon)");
        int index = node["index"]?.GetValue<int>() ?? throw new ArgumentException("Missing 'index'");
        var r = _engine.PlacementRemove(kind, index);
        return Serialize(new { success = r.Removed, command = "placement-remove",
            kind = r.Kind, index = r.Index, landblock = r.Landblock });
    }

    private string CmdPlacementSetScope(System.Text.Json.Nodes.JsonNode node) {
        string kind = node["kind"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'kind' field (outdoor|dungeon)");
        int index = node["index"]?.GetValue<int>() ?? throw new ArgumentException("Missing 'index'");
        string scope = node["scope"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'scope' field (classDefault|placementOverride)");
        var r = _engine.PlacementSetScope(kind, index, scope);
        return Serialize(new { success = r.Success, command = "placement-set-scope",
            kind = r.Kind, index = r.Index, scope = r.Scope });
    }

    private string CmdAceDbConnect(System.Text.Json.Nodes.JsonNode node) {
        string host = node["host"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'host'");
        int port = node["port"]?.GetValue<int>() ?? 3306;
        string database = node["database"]?.GetValue<string>() ?? "ace_world";
        string user = node["user"]?.GetValue<string>() ?? "root";
        string password = node["password"]?.GetValue<string>() ?? "";
        var r = _engine.AceDbConnectAsync(host, port, database, user, password).GetAwaiter().GetResult();
        return Serialize(new { success = r.Success, command = "ace-db-connect",
            host = r.Host, port = r.Port, database = r.Database, user = r.User,
            settingsSaved = r.SettingsSaved, error = r.Error });
    }

    private string CmdAceDbStatus(System.Text.Json.Nodes.JsonNode node) {
        var r = _engine.AceDbStatusAsync().GetAwaiter().GetResult();
        return Serialize(new { success = true, command = "ace-db-status",
            hasSettings = r.HasSettings, host = r.Host, port = r.Port,
            database = r.Database, user = r.User, connectionOk = r.ConnectionOk, error = r.Error });
    }

    private string CmdAceShardDbConnect(System.Text.Json.Nodes.JsonNode node) {
        string host = node["host"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'host'");
        int port = node["port"]?.GetValue<int>() ?? 3306;
        string database = node["database"]?.GetValue<string>() ?? node["db"]?.GetValue<string>() ?? "";
        string user = node["user"]?.GetValue<string>() ?? "root";
        string password = node["password"]?.GetValue<string>() ?? node["pass"]?.GetValue<string>() ?? "";
        var r = _engine.AceShardDbConnectAsync(host, port, database, user, password).GetAwaiter().GetResult();
        return Serialize(new { success = r.Success, command = "ace-shard-db-connect",
            host = r.Host, port = r.Port, database = r.Database, user = r.User,
            settingsSaved = r.SettingsSaved, error = r.Error });
    }

    private string CmdAceShardDbStatus(System.Text.Json.Nodes.JsonNode node) {
        var r = _engine.AceShardDbStatusAsync().GetAwaiter().GetResult();
        return Serialize(new { success = true, command = "ace-shard-db-status",
            hasSettings = r.HasSettings, host = r.Host, port = r.Port,
            database = r.Database, user = r.User, connectionOk = r.ConnectionOk, error = r.Error });
    }

    private string CmdPlacementExportSql(System.Text.Json.Nodes.JsonNode node) {
        string outDir = node["out"]?.GetValue<string>()
            ?? _projectManager.CurrentProject?.ProjectDirectory
            ?? Directory.GetCurrentDirectory();
        bool apply = node["apply"]?.GetValue<bool>() ?? false;
        bool dryRun = node["dryRun"]?.GetValue<bool>() ?? node["dry-run"]?.GetValue<bool>() ?? false;
        bool force = node["force"]?.GetValue<bool>() ?? false;
        bool validate = node["validate"]?.GetValue<bool>() ?? true;
        var r = _engine.PlacementExportSqlAsync(outDir, apply, dryRun, force, validate).GetAwaiter().GetResult();
        return Serialize(new { success = r.Success, command = "placement-export-sql",
            outdoorPath = r.OutdoorPath, outdoorCount = r.OutdoorCount,
            dungeonPath = r.DungeonPath, dungeonCount = r.DungeonCount,
            enrichedJsonlPath = r.EnrichedJsonlPath, enrichedCount = r.EnrichedCount,
            dryRun = r.DryRun,
            enrichmentSqlPaths = r.EnrichmentSqlPaths,
            enrichmentManifestPath = r.EnrichmentManifestPath,
            enrichmentConflictCount = r.EnrichmentConflictCount,
            placementOverrideSkipped = r.PlacementOverrideSkipped,
            // E1 (wave-2) PR3 — Option B biota override + E6 validation gate.
            biotaSqlPaths = r.BiotaSqlPaths,
            biotaManifestPath = r.BiotaManifestPath,
            biotaCount = r.BiotaCount,
            biotaMintedGuids = r.BiotaMintedGuids,
            biotaWarningCount = r.BiotaWarningCount,
            biotaSkipped = r.BiotaSkipped,
            validationReportPath = r.ValidationReportPath,
            validationErrorCount = r.ValidationErrorCount,
            validationWarningCount = r.ValidationWarningCount,
            validationBlocked = r.ValidationBlocked,
            rowsAppliedToDb = r.RowsAppliedToDb,
            shardRowsAppliedToDb = r.ShardRowsAppliedToDb });
    }

    private string CmdWeenieSave(System.Text.Json.Nodes.JsonNode node) {
        uint classId = ParseUintField(node, "classId");
        string? jsonPath = node["fromJson"]?.GetValue<string>();
        bool force = node["force"]?.GetValue<bool>() ?? false;   // F233: force a row-wiping save
        var r = _engine.WeenieSaveScalarsAsync(classId, jsonPath, force).GetAwaiter().GetResult();
        return Serialize(new {
            success = r.Success, command = "weenie-save",
            classId = $"0x{r.ClassId:X8}",
            ints = r.IntRows, int64s = r.Int64Rows, bools = r.BoolRows, floats = r.FloatRows,
            strings = r.StringRows, dataIds = r.DataIdRows, instanceIds = r.InstanceIdRows,
            error = r.Error
        });
    }

    private string CmdWeenieInsert(System.Text.Json.Nodes.JsonNode node) {
        string className = node["className"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'className' field");
        string? jsonPath = node["fromJson"]?.GetValue<string>();
        var r = _engine.WeenieInsertAsync(className, jsonPath ?? "").GetAwaiter().GetResult();
        return Serialize(new {
            success = r.Success, command = "weenie-insert",
            newClassId = $"0x{r.NewClassId:X8}",
            className = r.ClassName,
            totalScalarRows = r.TotalScalarRows,
            error = r.Error
        });
    }

    private string CmdWeenieDelete(System.Text.Json.Nodes.JsonNode node) {
        uint classId = ParseUintField(node, "classId");
        var r = _engine.WeenieDeleteAsync(classId).GetAwaiter().GetResult();
        return Serialize(new {
            success = r.Success, command = "weenie-delete",
            classId = $"0x{r.ClassId:X8}",
            error = r.Error
        });
    }

    private string CmdWeenieListPropertyKeys(System.Text.Json.Nodes.JsonNode node) {
        string family = node["family"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'family' field (int|int64|bool|float|string|did|iid)");
        var r = _engine.WeenieListPropertyKeys(family);
        return Serialize(new {
            success = true, command = "weenie-list-property-keys",
            family = r.Family, count = r.Count,
            keys = r.Keys.Select(k => new { type = k.Type, name = k.Name })
        });
    }

    private string CmdSpellList(System.Text.Json.Nodes.JsonNode node) {
        int limit = node["limit"]?.GetValue<int>() ?? 500;
        string source = node["source"]?.GetValue<string>() ?? "dat";
        var r = _engine.SpellListAsync(limit, source).GetAwaiter().GetResult();
        return Serialize(new {
            success = true, command = "spell-list",
            count = r.Count, source = r.Source,
            spells = r.Spells.Select(s => new { spellId = s.SpellId, name = s.Name, hasOverlay = s.HasOverlay })
        });
    }

    private string CmdSpellGet(System.Text.Json.Nodes.JsonNode node) {
        uint id = ParseUintField(node, "id");
        var r = _engine.SpellGetAsync(id).GetAwaiter().GetResult();
        return Serialize(new {
            success = r.Success, command = "spell-get",
            spellId = r.SpellId, source = r.Source, spell = r.Spell
        });
    }

    private string CmdSpellSave(System.Text.Json.Nodes.JsonNode node) {
        uint id = ParseUintField(node, "id");
        string? jsonPath = node["fromJson"]?.GetValue<string>();
        var r = _engine.SpellSaveAsync(id, jsonPath).GetAwaiter().GetResult();
        return Serialize(new {
            success = r.Success, command = "spell-save",
            spellId = r.SpellId,
            savedToOverlay = r.SavedToOverlay,
            savedToDb = r.SavedToDb
        });
    }

    private string CmdSpellCopy(System.Text.Json.Nodes.JsonNode node) {
        uint fromId = ParseUintField(node, "fromId");
        uint? newId = node["newId"] != null ? ParseUintField(node, "newId") : null;
        var r = _engine.SpellCopyAsync(fromId, newId).GetAwaiter().GetResult();
        return Serialize(new {
            success = r.Success, command = "spell-copy",
            fromSpellId = r.FromSpellId, newSpellId = r.NewSpellId,
            savedToOverlay = r.SavedToOverlay, savedToDb = r.SavedToDb,
            // F206: distinguish a fresh insert from an overwrite of a pre-existing destination id.
            replacedExisting = r.ReplacedExisting
        });
    }

    private string CmdSpellDelete(System.Text.Json.Nodes.JsonNode node) {
        uint id = ParseUintField(node, "id");
        var r = _engine.SpellDeleteAsync(id).GetAwaiter().GetResult();
        return Serialize(new {
            success = r.Success, command = "spell-delete",
            spellId = r.SpellId,
            removedFromOverlay = r.RemovedFromOverlay,
            deletedFromDb = r.DeletedFromDb
        });
    }

    private string CmdLayoutList(System.Text.Json.Nodes.JsonNode node) {
        bool overlayOnly = node["overlayOnly"]?.GetValue<bool>() ?? false;
        var r = _engine.LayoutList(overlayOnly);
        return Serialize(new {
            success = true, command = "layout-list",
            count = r.Count,
            overlayOnly = overlayOnly,
            layouts = r.Layouts.Select(l => new { layoutId = l.LayoutId, hasOverlay = l.HasOverlay })
        });
    }

    private string CmdLayoutGet(System.Text.Json.Nodes.JsonNode node) {
        uint id = ParseUintField(node, "layoutId");
        var r = _engine.LayoutGet(id);
        return Serialize(new {
            success = r.Success, command = "layout-get",
            layoutId = r.LayoutId,
            hasOverlay = r.HasOverlay,
            layout = r.Layout
        });
    }

    private string CmdLayoutSave(System.Text.Json.Nodes.JsonNode node) {
        uint id = ParseUintField(node, "layoutId");
        string fromJson = node["fromJson"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'fromJson' field");
        var r = _engine.LayoutSave(id, fromJson);
        return Serialize(new {
            success = r.Success, command = "layout-save",
            layoutId = r.LayoutId
        });
    }

    private string CmdLayoutDeleteOverlay(System.Text.Json.Nodes.JsonNode node) {
        uint id = ParseUintField(node, "layoutId");
        var r = _engine.LayoutDeleteOverlay(id);
        return Serialize(new {
            success = true, command = "layout-delete-overlay",
            layoutId = r.LayoutId, removed = r.Removed
        });
    }

    private string CmdCreatureGet(System.Text.Json.Nodes.JsonNode node) {
        uint objectId = ParseUintField(node, "objectId");
        var r = _engine.CreatureGetAsync(objectId).GetAwaiter().GetResult();
        return Serialize(new {
            success = r.Success, command = "creature-get",
            objectId = $"0x{r.ObjectId:X8}", overrides = r.Overrides,
            // Set only on DB failure — lets an agent distinguish "no overrides" from "DB down".
            error = r.Error
        });
    }

    private string CmdCreatureSave(System.Text.Json.Nodes.JsonNode node) {
        uint objectId = ParseUintField(node, "objectId");
        string? jsonPath = node["fromJson"]?.GetValue<string>();
        var r = _engine.CreatureSaveAsync(objectId, jsonPath).GetAwaiter().GetResult();
        return Serialize(new {
            success = r.Success, command = "creature-save",
            objectId = $"0x{r.ObjectId:X8}",
            textureMapRows = r.TextureMapRows,
            animPartRows = r.AnimPartRows,
            error = r.Error
        });
    }

    private string CmdCreatureExportSql(System.Text.Json.Nodes.JsonNode node) {
        uint objectId = ParseUintField(node, "objectId");
        string? outPath = node["out"]?.GetValue<string>();
        var r = _engine.CreatureExportSql(objectId, outPath);
        return Serialize(new {
            success = r.Success, command = "creature-export-sql",
            objectId = $"0x{r.ObjectId:X8}",
            sqlBytes = r.Sql.Length,
            sql = r.Sql,
            outPath = r.OutPath,
            // Set only on DB failure — no file is written and sql is empty in that case.
            error = r.Error
        });
    }

    private string CmdOpenLogFolder() {
        var path = CommandEngine.ActiveLogPath;
        if (string.IsNullOrEmpty(path)) {
            return Serialize(new {
                success = false,
                command = "open-log-folder",
                error = "No log file is active. Start the terminal with --log-file <path>."
            });
        }
        var folder = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path)) ?? path;
        return Serialize(new {
            success = true,
            command = "open-log-folder",
            logPath = path,
            folder = folder
        });
    }

    private string CmdImportRenderSurface(System.Text.Json.Nodes.JsonNode node) {
        string imagePath = node["imagePath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'imagePath' field");
        uint renderSurfaceId = ParseUintField(node, "renderSurfaceId");
        bool ui = node["ui"]?.GetValue<bool>() ?? false;
        string? name = node["name"]?.GetValue<string>();

        var r = _engine.ImportRenderSurface(imagePath, renderSurfaceId, ui, name);
        return Serialize(new {
            success = r.Success,
            command = "import-render-surface",
            renderSurfaceId = $"0x{r.RenderSurfaceId:X8}",
            name = r.Name,
            mode = r.Mode,
            deferred = r.Deferred,
            error = r.Error
        });
    }

    private static uint ParseUintField(System.Text.Json.Nodes.JsonNode node, string field) {
        var n = node[field] ?? throw new ArgumentException($"Missing '{field}' field");
        // Accept either int (JSON number) or "0x06000123" string.
        if (n.GetValueKind() == System.Text.Json.JsonValueKind.String) {
            var s = n.GetValue<string>();
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                return Convert.ToUInt32(s, 16);
            return uint.Parse(s);
        }
        return n.GetValue<uint>();
    }

    private string CmdImportHeightmap(System.Text.Json.Nodes.JsonNode node) {
        string imagePath = node["imagePath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'imagePath' field");
        int startLbX = node["startLbX"]?.GetValue<int>() ?? 0;
        int startLbY = node["startLbY"]?.GetValue<int>() ?? 0;
        int lbCountX = node["lbCountX"]?.GetValue<int>()
            ?? throw new ArgumentException("Missing 'lbCountX' field");
        int lbCountY = node["lbCountY"]?.GetValue<int>()
            ?? throw new ArgumentException("Missing 'lbCountY' field");
        bool apply = node["apply"]?.GetValue<bool>() ?? false;

        var r = _engine.ImportHeightmap(imagePath, startLbX, startLbY, lbCountX, lbCountY, apply);
        return Serialize(new {
            success = true,
            command = "import-heightmap",
            applied = r.Applied,
            imagePath = r.ImagePath,
            startLbX = r.StartLbX, startLbY = r.StartLbY,
            lbCountX = r.LbCountX, lbCountY = r.LbCountY,
            landblocksConsidered = r.LandblocksConsidered,
            landblocksChanged = r.LandblocksChanged,
            verticesChanged = r.VerticesChanged,
            perLandblock = r.PerLandblock.Select(p => new { landblock = p.Landblock, vertices = p.Vertices }),
            modifiedLandblocks = FormatLbs(r.ModifiedLandblocks)
        });
    }

    private string CmdSetLandblockTerrain(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        var typesNode = node["types"] ?? throw new ArgumentException("Missing 'types' field");
        byte[] types = ParseByteArrayField(typesNode, "types");
        var r = _engine.SetLandblockTerrain(lbX, lbY, types);
        return Serialize(new { success = true, command = "set-landblock-terrain",
            landblock = $"0x{r.LbKey:X4}", verticesModified = r.VerticesModified,
            landblocks = FormatLbs(r.ModifiedLandblocks) });
    }

    private string CmdBulkPlaceObjects(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        var objectsArr = node["objects"] as System.Text.Json.Nodes.JsonArray
            ?? throw new ArgumentException("Missing 'objects' array");
        var objects = new List<(uint modelId, float x, float y, float z)>(objectsArr.Count);
        for (int i = 0; i < objectsArr.Count; i++) {
            var obj = objectsArr[i] ?? throw new ArgumentException($"objects[{i}] is null");
            uint mid = Hex32(obj, "modelId");
            float x = obj["x"]?.GetValue<float>() ?? throw new ArgumentException($"objects[{i}]: missing 'x'");
            float y = obj["y"]?.GetValue<float>() ?? throw new ArgumentException($"objects[{i}]: missing 'y'");
            float z = obj["z"]?.GetValue<float>() ?? throw new ArgumentException($"objects[{i}]: missing 'z'");
            if (!float.IsFinite(x) || !float.IsFinite(y) || !float.IsFinite(z))
                throw new ArgumentException($"objects[{i}]: coordinates must be finite; got ({x},{y},{z})");
            objects.Add((mid, x, y, z));
        }
        var r = _engine.BulkPlaceObjects(lbX, lbY, objects);
        return Serialize(new { success = r.Errors == 0, command = "bulk-place-objects",
            landblock = $"0x{r.LbKey:X4}", placed = r.Placed, errors = r.Errors,
            allPlaced = r.Errors == 0, errorMessages = r.ErrorMessages });
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
        if (coastlineNode is System.Text.Json.Nodes.JsonArray coastArr) {
            coastline = new List<(float, float)>();
            foreach (var pt in coastArr) {
                if (pt is not System.Text.Json.Nodes.JsonArray pair || pair.Count < 2)
                    throw new ArgumentException("Each coastline entry must be a 2+-element numeric array [x, y].");
                coastline.Add((pair[0]!.GetValue<float>(), pair[1]!.GetValue<float>()));
            }
            if (coastline.Count < 3)
                throw new ArgumentException("coastline requires at least 3 valid points.");
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
        var (lbX, lbY) = Lb(node);
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
        var (minX, minY, maxX, maxY) = LbWindow(node);
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
        var (minX, minY, maxX, maxY) = LbWindow(node);
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
        var (minX, minY, maxX, maxY) = LbWindow(node);
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
        var (minX, minY, maxX, maxY) = LbWindow(node);
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
            source = r.Source,
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

    private static float F(System.Text.Json.Nodes.JsonNode node, string field) {
        var v = node[field]?.GetValue<float>()
            ?? throw new ArgumentException($"Missing '{field}' field");
        if (!float.IsFinite(v))
            throw new ArgumentException($"'{field}' must be finite; got {v}");
        return v;
    }

    private static uint U(System.Text.Json.Nodes.JsonNode node, string field) =>
        node[field]?.GetValue<uint>() ?? throw new ArgumentException($"Missing '{field}'");

    /// <summary>
    /// Reads a required landblock-coordinate field and rejects values above 254 with a
    /// field-named error, so out-of-range coords can't wrap through the ushort LbKey cast.
    /// </summary>
    private static uint U254(System.Text.Json.Nodes.JsonNode node, string field) {
        uint v = U(node, field);
        if (v > 254) throw new ArgumentException($"'{field}' must be 0..254; got {v}");
        return v;
    }

    // Extracts a 0..max integer field and returns it as a byte. Replaces
    // raw GetValue<byte>() which throws an opaque InvalidOperationException
    // for values outside 0..255 with no mention of the field.
    private static byte ByteInRange(System.Text.Json.Nodes.JsonNode node, string field, int max = 255) {
        var raw = node[field]?.GetValue<int>()
            ?? throw new ArgumentException($"Missing '{field}' field");
        if (raw < 0 || raw > max)
            throw new ArgumentException($"'{field}' must be 0..{max}; got {raw}");
        return (byte)raw;
    }

    private static float FloatInRange(System.Text.Json.Nodes.JsonNode node, string field,
            float min, float max, float fallback) {
        var raw = node[field]?.GetValue<float>();
        if (raw is null) return fallback;
        if (!float.IsFinite(raw.Value))
            throw new ArgumentException($"'{field}' must be finite; got {raw}");
        if (raw < min || raw > max)
            throw new ArgumentException($"'{field}' must be in [{min}, {max}]; got {raw}");
        return raw.Value;
    }

    // Reads an int field with a per-field fallback. Just here so the
    // terrain-edit handlers can stop repeating the ?.GetValue<int>() ?? N pattern.
    private static int OptionalInt(System.Text.Json.Nodes.JsonNode node, string field, int fallback) =>
        node[field]?.GetValue<int>() ?? fallback;

    // Reads an optional float that must be a positive finite number when present.
    private static float PositiveFiniteFloat(System.Text.Json.Nodes.JsonNode node, string field, float fallback) {
        var raw = node[field]?.GetValue<float>();
        if (raw is null) return fallback;
        if (!float.IsFinite(raw.Value) || raw.Value <= 0f)
            throw new ArgumentException($"'{field}' must be a positive finite number; got {raw}");
        return raw.Value;
    }

    /// <summary>Reads a required int field; matches the F-helper "Missing 'field' field" convention.</summary>
    private static int RequiredInt(System.Text.Json.Nodes.JsonNode node, string field) =>
        node[field]?.GetValue<int>() ?? throw new ArgumentException($"Missing '{field}' field");

    /// <summary>Reads a paired lbX/lbY field, rejecting values above 254 with field-named errors.</summary>
    private static (uint lbX, uint lbY) Lb(System.Text.Json.Nodes.JsonNode node) {
        uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
        if (lbX > 254) throw new ArgumentException($"'lbX' must be 0..254; got {lbX}");
        if (lbY > 254) throw new ArgumentException($"'lbY' must be 0..254; got {lbY}");
        return (lbX, lbY);
    }

    /// <summary>Validates a single landblock coordinate field is in 0..254 (rejects ushort LbKey wrap).</summary>
    private static void ValidateLbCoord(string field, uint value) {
        if (value > 254) throw new ArgumentException($"'{field}' must be 0..254; got {value}");
    }

    /// <summary>Reads + validates a minX/minY/maxX/maxY landblock window (each 0..254, min &lt;= max).</summary>
    private static (uint minX, uint minY, uint maxX, uint maxY) LbWindow(
        System.Text.Json.Nodes.JsonNode node, uint defMinX = 0, uint defMinY = 0, uint defMaxX = 254, uint defMaxY = 254) {
        uint minX = node["minX"]?.GetValue<uint>() ?? defMinX;
        uint minY = node["minY"]?.GetValue<uint>() ?? defMinY;
        uint maxX = node["maxX"]?.GetValue<uint>() ?? defMaxX;
        uint maxY = node["maxY"]?.GetValue<uint>() ?? defMaxY;
        ValidateLbCoord("minX", minX); ValidateLbCoord("minY", minY);
        ValidateLbCoord("maxX", maxX); ValidateLbCoord("maxY", maxY);
        if (minX > maxX) throw new ArgumentException($"'minX' ({minX}) must be <= 'maxX' ({maxX})");
        if (minY > maxY) throw new ArgumentException($"'minY' ({minY}) must be <= 'maxY' ({maxY})");
        return (minX, minY, maxX, maxY);
    }

    /// <summary>Reads a 32-bit hex field, accepting case-insensitive 0x prefix and trimming whitespace.</summary>
    private static uint Hex32(System.Text.Json.Nodes.JsonNode node, string field) {
        var jv = node[field] ?? throw new ArgumentException($"Missing '{field}' field");
        string raw;
        try { raw = jv.GetValue<string>(); }
        catch (InvalidOperationException) {
            throw new ArgumentException($"'{field}' must be a hex string like \"0x12345678\"; got a JSON number");
        }
        var trimmed = raw.Trim();
        if (trimmed.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            trimmed = trimmed.Substring(2);
        if (!uint.TryParse(trimmed, System.Globalization.NumberStyles.HexNumber,
                System.Globalization.CultureInfo.InvariantCulture, out var v))
            throw new ArgumentException($"'{field}' is not a valid 32-bit hex value; got \"{raw}\"");
        return v;
    }

    /// <summary>Reads a ushort field: 0x-prefixed string is hex, plain string is decimal, JSON number is decimal. Names the field on error.</summary>
    private static ushort HexOrDecU16(System.Text.Json.Nodes.JsonNode node, string field) {
        var jv = node[field] ?? throw new ArgumentException($"Missing '{field}' field");
        if (jv.GetValueKind() == System.Text.Json.JsonValueKind.Number) {
            var n = jv.GetValue<long>();
            if (n < 0 || n > 0xFFFF)
                throw new ArgumentException($"'{field}' must be in 0..0xFFFF; got {n}");
            return (ushort)n;
        }
        string raw;
        try { raw = jv.GetValue<string>(); }
        catch (InvalidOperationException) {
            throw new ArgumentException($"'{field}' must be a number or hex string like \"0x0100\"");
        }
        var trimmed = raw.Trim();
        bool hex = trimmed.StartsWith("0x", StringComparison.OrdinalIgnoreCase);
        var body = hex ? trimmed.Substring(2) : trimmed;
        var style = hex ? System.Globalization.NumberStyles.HexNumber : System.Globalization.NumberStyles.Integer;
        if (!ushort.TryParse(body, style, System.Globalization.CultureInfo.InvariantCulture, out var v))
            throw new ArgumentException($"'{field}' is not a valid 16-bit value; got \"{raw}\"");
        return v;
    }

    /// <summary>Parses an all-or-nothing quaternion (qw,qx,qy,qz); returns null when no Q field is present.</summary>
    private static Quaternion? ParseQuaternion(System.Text.Json.Nodes.JsonNode node) {
        bool any = node["qw"] != null || node["qx"] != null
                || node["qy"] != null || node["qz"] != null;
        if (!any) return null;
        bool all = node["qw"] != null && node["qx"] != null
                && node["qy"] != null && node["qz"] != null;
        if (!all) throw new ArgumentException(
            "Quaternion requires all of qw, qx, qy, qz (or none for identity).");
        float qw = node["qw"]!.GetValue<float>(), qx = node["qx"]!.GetValue<float>();
        float qy = node["qy"]!.GetValue<float>(), qz = node["qz"]!.GetValue<float>();
        if (!float.IsFinite(qw) || !float.IsFinite(qx) || !float.IsFinite(qy) || !float.IsFinite(qz))
            throw new ArgumentException("Quaternion components must be finite.");
        if (qw * qw + qx * qx + qy * qy + qz * qz < 1e-12f)
            throw new ArgumentException("Quaternion magnitude is zero — provide a non-zero quaternion.");
        return Quaternion.Normalize(new Quaternion(qx, qy, qz, qw));
    }

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
                int? v = arr[i]?.GetValue<int>();
                if (v is null || v < 0 || v > 255)
                    throw new ArgumentException(
                        $"'{fieldName}[{i}]' must be 0..255; got {(v.HasValue ? v.Value.ToString() : "null")}");
                result[i] = (byte)v.Value;
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
            outputPath = r.OutputPath, error = r.Error, warnings = r.Warnings });
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
        uint classId = ParseUintField(node, "classId");
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
            warnings = r.Warnings,
            error = r.Error });
    }

    private string CmdWeenieTemplateApply(System.Text.Json.Nodes.JsonNode node) {
        var bundlePath = node["bundlePath"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'bundlePath' field");
        var templateId = node["templateId"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'templateId' field");
        uint classId = ParseUintField(node, "classId");
        var r = _engine.WeenieTemplateApplyAsync(bundlePath, templateId, classId).GetAwaiter().GetResult();
        return Serialize(new { success = r.Success, command = "weenie-template-apply",
            bundlePath = r.BundlePath, templateId = r.TemplateId, classId = r.ClassId,
            scalarsApplied = r.ScalarsApplied,
            merged = r.Merged, totalScalarsAfter = r.TotalScalarsAfter, weenieTypeChanged = r.WeenieTypeChanged,
            warnings = r.Warnings,
            error = r.Error });
    }

    // ════════════════════════════════════════════════════
    //  Mesh I/O & BSP (slice 1 of f26345e port)
    // ════════════════════════════════════════════════════

    private string CmdObjExport(System.Text.Json.Nodes.JsonNode node) {
        uint datId = ParseUintField(node, "datId");
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
        uint surfaceDid = ParseUintField(node, "surfaceDid");
        uint gfxObjId = node["gfxObjId"] != null ? ParseUintField(node, "gfxObjId") : 0;
        uint setupId = node["setupId"] != null ? ParseUintField(node, "setupId") : 0;
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

    // ════════════════════════════════════════════════════
    //  Transact — batched stage / validate / commit-or-rollback.
    //  Reuses the JSON handler dictionary as the op alphabet.
    // ════════════════════════════════════════════════════

    private string CmdTransact(System.Text.Json.Nodes.JsonNode node) {
        // Two ways to supply ops: inline `ops` array, or `opsFile` pointing at a JSON
        // file whose top-level is `{ "ops": [...] }` (or just an array). The file form
        // dodges stdin line-buffer corner cases for large batches.
        System.Text.Json.Nodes.JsonArray? opsArray = node["ops"] as System.Text.Json.Nodes.JsonArray;
        var opsFile = node["opsFile"]?.GetValue<string>();
        if (opsArray == null && !string.IsNullOrEmpty(opsFile)) {
            try {
                var raw = File.ReadAllText(opsFile);
                var parsed = System.Text.Json.Nodes.JsonNode.Parse(raw);
                opsArray = parsed switch {
                    System.Text.Json.Nodes.JsonArray arr => arr,
                    System.Text.Json.Nodes.JsonObject obj => obj["ops"] as System.Text.Json.Nodes.JsonArray,
                    _ => null,
                };
                if (opsArray == null) {
                    return Serialize(new { success = false, command = "transact",
                        error = $"opsFile '{opsFile}' did not contain an ops array" });
                }
            } catch (Exception ex) {
                return Serialize(new { success = false, command = "transact",
                    error = $"Failed to read opsFile '{opsFile}': {ex.Message}" });
            }
        }
        if (opsArray == null) {
            return Serialize(new { success = false, command = "transact",
                error = "Provide either 'ops' (array) or 'opsFile' (path)" });
        }

        bool rollbackOnFail = node["rollback_on_fail"]?.GetValue<bool>() ?? true;
        var validateNode = node["validate"];
        var result = _transactionEngine.Run(opsArray, rollbackOnFail, validateNode);

        // Serialize the response. Each op outcome embeds the inner handler's full
        // response JSON under `response` so callers can inspect placed counts, ids, etc.
        var opsOut = result.Ops.Select(o => new {
            index = o.Index,
            command = o.Command,
            success = o.Success,
            response = TryParseJson(o.ResponseJson),
            error = o.Error,
        }).ToArray();

        var validationOut = result.Validation?.Select(v => new {
            checkType = v.CheckType, target = v.Target,
            isValid = v.IsValid,
            errorCount = v.ErrorCount, warningCount = v.WarningCount, infoCount = v.InfoCount,
            diagnostics = v.Diagnostics.Select(d => new {
                severity = d.Severity.ToString().ToLowerInvariant(),
                code = d.Code, message = d.Message, context = d.Context,
            }).ToArray(),
        }).ToArray();

        // Tile-cache invalidation hook: when a transact actually committed,
        // notify the tile pipeline so its manifest reflects the dirty LBs.
        // No-op if the tile pipeline hasn't been initialized yet.
        // Touched-only is not enough — a batch that creates a new dungeon doc
        // (no pre-snapshot, so it lands in DocumentsCreated, not DocumentsTouched)
        // would otherwise leave that LB's tile stale.
        // F219: gate on Status=="committed" && OpsApplied>0, NOT result.Success.
        // With rollback_on_fail:false, a batch that fails partway leaves Status
        // "committed" / Success false while the ops that ran before the failure ARE
        // permanently applied (and their diffs retained). Keying off Success skipped
        // tile invalidation for those real mutations, so get-tile served stale,
        // pre-edit imagery. Any committed batch that actually applied ops must dirty
        // its tiles.
        if (result.Status == "committed" && result.Journal.OpsApplied > 0) {
            try {
                var dirtyDocs = result.Journal.DocumentsTouched
                    .Concat(result.Journal.DocumentsCreated)
                    .Distinct(StringComparer.Ordinal)
                    .ToList();
                _engine.OnTransactCommitted(dirtyDocs);
            }
            catch (Exception ex) { Console.Error.WriteLine($"[Tiles] Invalidation skipped: {ex.Message}"); }
        }

        // Inline diff: when the caller sets "diff", piggy-back the transact-diff
        // response on this transact response. Three forms — true/"both" yield
        // structured + visual; "structured" omits the visual; "visual" only
        // requests the visual block (still emits the summary as cheap context).
        // Falsy values (false, null, 0, "false", "none") skip the inline diff.
        var diffNode = node["diff"];
        System.Text.Json.Nodes.JsonNode? inlineDiff = null;
        if (TryReadDiffMode(diffNode, out var mode)) {
            bool wantVisual = mode is "true" or "both" or "visual";
            bool wantStructured = mode is "true" or "both" or "structured" or "visual";   // visual still wants summary
            string renderMode = TryReadStringLower(node["renderMode"]) ?? "overlay";
            int resolution = ReadResolution(node["resolution"], 1024);
            string txIdString = result.Journal.TransactionId.ToString();
            if (result.Status == "rejected") {
                inlineDiff = new System.Text.Json.Nodes.JsonObject {
                    ["success"] = false,
                    ["txId"] = txIdString,
                    ["errorCode"] = "TXDIFF-REJECTED",
                    ["error"] = "Transaction was rejected before any op ran — no diff is retained for it.",
                };
            } else if (result.Status != "committed") {
                inlineDiff = new System.Text.Json.Nodes.JsonObject {
                    ["success"] = false,
                    ["txId"] = txIdString,
                    ["errorCode"] = "TXDIFF-ROLLED-BACK",
                    ["error"] = "Transaction was rolled back — no diff is retained for it.",
                };
            } else {
                var diffResult = _transactDiffEngine.Run(
                    result.Journal.TransactionId, wantVisual, renderMode, lbFilter: null,
                    resolution: resolution, outPath: null);
                inlineDiff = SerializeTransactDiffToNode(diffResult, wantStructured, wantVisual);
            }
        }

        return Serialize(new {
            success = result.Success,
            command = "transact",
            status = result.Status,
            reason = result.Reason,
            ops = opsOut,
            validation = validationOut,
            journal = new {
                transactionId = result.Journal.TransactionId.ToString(),
                startedAt = result.Journal.StartedAt.ToString("o"),
                finishedAt = result.Journal.FinishedAt.ToString("o"),
                documentsTouched = result.Journal.DocumentsTouched,
                documentsCreated = result.Journal.DocumentsCreated,
                opsApplied = result.Journal.OpsApplied,
                opsRolledBack = result.Journal.OpsRolledBack,
            },
            error = result.Error,
            diff = inlineDiff,
        });
    }

    private static System.Text.Json.Nodes.JsonNode? TryParseJson(string s) {
        try { return System.Text.Json.Nodes.JsonNode.Parse(s); }
        catch { return null; }
    }

    // ─────────────────────────────────────────────────────
    //  Defensive node readers shared by transact + transact-diff dispatch.
    //  GetValue<T>() throws NotSupportedException on type mismatch — these
    //  wrappers turn that into a quiet default so one malformed field can't
    //  crash the whole call.
    // ─────────────────────────────────────────────────────
    private static string? TryReadString(System.Text.Json.Nodes.JsonNode? node) {
        if (node == null) return null;
        if (node.GetValueKind() != JsonValueKind.String) return null;
        try { return node.GetValue<string>(); } catch { return null; }
    }

    private static string? TryReadStringLower(System.Text.Json.Nodes.JsonNode? node) {
        var s = TryReadString(node);
        return s?.ToLowerInvariant();
    }

    private static bool TryReadBool(System.Text.Json.Nodes.JsonNode? node) {
        if (node == null) return false;
        var k = node.GetValueKind();
        if (k == JsonValueKind.True) return true;
        if (k == JsonValueKind.False) return false;
        // Be lenient with string forms so REPL-style inputs ("true"/"false") work.
        if (k == JsonValueKind.String) {
            var s = TryReadString(node);
            return string.Equals(s, "true", StringComparison.OrdinalIgnoreCase);
        }
        return false;
    }

    private static int ReadResolution(System.Text.Json.Nodes.JsonNode? node, int fallback) {
        if (node?.GetValueKind() != JsonValueKind.Number) return fallback;
        int n;
        try { n = node.GetValue<int>(); } catch { return fallback; }
        // Mirror the REPL clamp range so an agent can't request a 0×0 or
        // 100,000×100,000 PNG that would either crash SkiaSharp or OOM.
        if (n < 64) return 64;
        if (n > 8192) return 8192;
        return n;
    }

    // Generic int reader — returns fallback for missing or wrong-typed nodes
    // instead of throwing inside GetValue<int>(). No clamping; the caller's
    // own arg semantics decide what's reasonable.
    private static int TryReadIntDefault(System.Text.Json.Nodes.JsonNode? node, int fallback) {
        if (node?.GetValueKind() != JsonValueKind.Number) return fallback;
        try { return node.GetValue<int>(); } catch { return fallback; }
    }

    // Returns true and the requested mode if `diff` was set to a truthy form.
    // Falsy: missing, false, null, the strings "false" / "none" / unknown,
    //        any number (including 0). Truthy: bool true, "true"/"both"/
    //        "structured"/"visual".
    private static bool TryReadDiffMode(System.Text.Json.Nodes.JsonNode? node, out string mode) {
        mode = "both";
        if (node == null) return false;
        var k = node.GetValueKind();
        if (k == JsonValueKind.True) { mode = "both"; return true; }
        if (k == JsonValueKind.False || k == JsonValueKind.Null) return false;
        if (k == JsonValueKind.String) {
            var s = TryReadString(node)?.ToLowerInvariant() ?? "";
            switch (s) {
                case "true": case "both": case "structured": case "visual":
                    mode = s; return true;
                case "false": case "none": case "":
                    return false;
                default:
                    return false;
            }
        }
        return false;
    }

    // ════════════════════════════════════════════════════
    //  Transact-Diff — structured before/after report.
    // ════════════════════════════════════════════════════

    private string CmdTransactDiff(System.Text.Json.Nodes.JsonNode node) {
        // Defensive: GetValue<string>() throws NotSupportedException if txId is
        // a non-string node. Read the kind first so a malformed input returns
        // a clean error instead of crashing the whole stdin loop.
        string? txIdRaw = TryReadString(node["txId"]);
        if (string.IsNullOrWhiteSpace(txIdRaw) || !Guid.TryParse(txIdRaw, out var txId)) {
            return Serialize(new { success = false, command = "transact-diff",
                error = "Missing or invalid 'txId' (expected a transaction GUID from a prior transact response)." });
        }

        bool render = TryReadBool(node["render"]);
        string renderMode = TryReadStringLower(node["renderMode"]) ?? "overlay";
        int resolution = ReadResolution(node["resolution"], 1024);
        string? outPath = TryReadString(node["out"]);

        HashSet<ushort>? lbFilter = null;
        if (node["lbs"] is System.Text.Json.Nodes.JsonArray lbArr && lbArr.Count > 0) {
            lbFilter = new HashSet<ushort>();
            foreach (var item in lbArr.OfType<System.Text.Json.Nodes.JsonNode>()) {
                if (item is not System.Text.Json.Nodes.JsonArray pair || pair.Count != 2) continue;
                // GetValue<uint>() throws on non-numeric entries — skip malformed pairs
                // rather than crashing the whole transact-diff response.
                if (pair[0] == null || pair[1] == null) continue;
                if (pair[0]!.GetValueKind() != JsonValueKind.Number ||
                    pair[1]!.GetValueKind() != JsonValueKind.Number) continue;
                uint lbX, lbY;
                try {
                    lbX = pair[0]!.GetValue<uint>();
                    lbY = pair[1]!.GetValue<uint>();
                } catch { continue; }
                // LB coords are 0..255 inclusive — out-of-range pairs would silently
                // truncate into the wrong landblock, so reject them outright.
                if (lbX > 0xFF || lbY > 0xFF) continue;
                lbFilter.Add((ushort)((lbX << 8) | lbY));
            }
        }

        var result = _transactDiffEngine.Run(txId, render, renderMode, lbFilter, resolution, outPath);
        var body = SerializeTransactDiffToNode(result, includeStructured: true, includeVisual: render);
        if (body is System.Text.Json.Nodes.JsonObject obj) {
            obj["command"] = "transact-diff";
        }
        return body?.ToJsonString(JsonOpts) ?? Serialize(new { success = false, command = "transact-diff", error = "Diff serialization failed." });
    }

    /// <summary>
    /// Serialize a TransactDiffResult to the spec wire shape. The transact inline
    /// path and the standalone transact-diff path both consume this.
    /// </summary>
    private static System.Text.Json.Nodes.JsonNode SerializeTransactDiffToNode(
            TransactDiffResult r, bool includeStructured, bool includeVisual) {
        var obj = new System.Text.Json.Nodes.JsonObject {
            ["success"] = r.Success,
            ["txId"] = r.TxId.ToString(),
        };
        if (!r.Success) {
            obj["errorCode"] = r.ErrorCode;
            obj["error"] = r.Error;
            return obj;
        }
        if (includeStructured && r.Summary != null) {
            obj["summary"] = new System.Text.Json.Nodes.JsonObject {
                ["documentsTouched"] = r.Summary.DocumentsTouched,
                ["objectsAdded"] = r.Summary.ObjectsAdded,
                ["objectsRemoved"] = r.Summary.ObjectsRemoved,
                ["objectsMoved"] = r.Summary.ObjectsMoved,
                ["structuresAdded"] = r.Summary.StructuresAdded,
                ["structuresRemoved"] = r.Summary.StructuresRemoved,
                ["validationDelta"] = new System.Text.Json.Nodes.JsonObject {
                    ["errors"] = r.Summary.ValidationErrorsDelta,
                    ["warnings"] = r.Summary.ValidationWarningsDelta,
                    ["info"] = r.Summary.ValidationInfoDelta,
                },
                ["spawnsAdded"] = r.Summary.SpawnsAdded,
                ["spawnsRemoved"] = r.Summary.SpawnsRemoved,
                ["poisAdded"] = r.Summary.PoisAdded,
                ["poisRemoved"] = r.Summary.PoisRemoved,
                ["biomeShift"] = r.Summary.BiomeShift,
                ["roadShift"] = r.Summary.RoadShift,
                ["cliffShift"] = r.Summary.CliffShift,
            };
        }
        if (includeStructured && r.PerLandblock != null && r.PerLandblock.Count > 0) {
            var arr = new System.Text.Json.Nodes.JsonArray();
            foreach (var lb in r.PerLandblock) {
                arr.Add(SerializePerLandblock(lb));
            }
            obj["perLandblock"] = arr;
        }
        if (includeStructured && r.TerrainSummary != null) {
            var ts = r.TerrainSummary;
            obj["terrainSummary"] = new System.Text.Json.Nodes.JsonObject {
                ["biomeBefore"] = HistogramToNode(ts.BiomeBefore),
                ["biomeAfter"] = HistogramToNode(ts.BiomeAfter),
                ["vertexHeightChanged"] = ts.VertexHeightChanged,
                ["vertexTypeChanged"] = ts.VertexTypeChanged,
                ["vertexRoadChanged"] = ts.VertexRoadChanged,
            };
        }
        if (includeVisual && r.Visual != null) {
            var v = new System.Text.Json.Nodes.JsonObject {
                ["mode"] = r.Visual.Mode,
                ["width"] = r.Visual.Width,
                ["height"] = r.Visual.Height,
            };
            if (r.Visual.PngBytes != null && r.Visual.PngBytes.Length > 0
                    && string.IsNullOrEmpty(r.Visual.OutPath)) {
                v["pngBase64"] = Convert.ToBase64String(r.Visual.PngBytes);
            }
            if (!string.IsNullOrEmpty(r.Visual.OutPath)) v["outPath"] = r.Visual.OutPath;
            if (!string.IsNullOrEmpty(r.Visual.Note)) v["note"] = r.Visual.Note;
            obj["visual"] = v;
        }
        return obj;
    }

    private static System.Text.Json.Nodes.JsonObject SerializePerLandblock(TransactDiffPerLandblock lb) {
        return new System.Text.Json.Nodes.JsonObject {
            ["lbX"] = lb.LbX,
            ["lbY"] = lb.LbY,
            ["lbHex"] = lb.LbHex,
            ["createdByBatch"] = lb.CreatedByBatch,
            ["objects"] = new System.Text.Json.Nodes.JsonObject {
                ["added"] = ObjectsToArray(lb.Objects.Added),
                ["removed"] = ObjectsToArray(lb.Objects.Removed),
                ["moved"] = MovesToArray(lb.Moves.Moved),
            },
            ["structures"] = new System.Text.Json.Nodes.JsonObject {
                ["added"] = StructuresToArray(lb.Structures.Added),
                ["removed"] = StructuresToArray(lb.Structures.Removed),
            },
            ["validation"] = new System.Text.Json.Nodes.JsonObject {
                ["added"] = ValidationToArray(lb.Validation.Added),
                ["cleared"] = ValidationToArray(lb.Validation.Removed),
            },
            ["spawns"] = new System.Text.Json.Nodes.JsonObject {
                ["added"] = SpawnsToArray(lb.Spawns.Added),
                ["removed"] = SpawnsToArray(lb.Spawns.Removed),
            },
            ["pois"] = new System.Text.Json.Nodes.JsonObject {
                ["added"] = PoisToArray(lb.Pois.Added),
                ["removed"] = PoisToArray(lb.Pois.Removed),
            },
            ["categorical"] = new System.Text.Json.Nodes.JsonObject {
                ["biomeBefore"] = lb.Categorical.BiomeBefore,
                ["biomeAfter"] = lb.Categorical.BiomeAfter,
                ["roadBefore"] = lb.Categorical.RoadBefore,
                ["roadAfter"] = lb.Categorical.RoadAfter,
                ["cliffsBefore"] = lb.Categorical.CliffsBefore,
                ["cliffsAfter"] = lb.Categorical.CliffsAfter,
            },
        };
    }

    private static System.Text.Json.Nodes.JsonArray ObjectsToArray(IEnumerable<TransactDiffObject> xs) {
        var arr = new System.Text.Json.Nodes.JsonArray();
        foreach (var o in xs) {
            var oo = new System.Text.Json.Nodes.JsonObject {
                ["wcid"] = o.Wcid,
                ["model"] = o.Model,
                ["position"] = Vector3ToArray(o.Position),
                ["ontology"] = StringArray(o.Ontology),
            };
            arr.Add(oo);
        }
        return arr;
    }

    private static System.Text.Json.Nodes.JsonArray MovesToArray(IEnumerable<TransactDiffMove> xs) {
        var arr = new System.Text.Json.Nodes.JsonArray();
        foreach (var m in xs) {
            arr.Add(new System.Text.Json.Nodes.JsonObject {
                ["wcid"] = m.Wcid,
                ["model"] = m.Model,
                ["from"] = Vector3ToArray(m.From),
                ["to"] = Vector3ToArray(m.To),
                ["deltaXY"] = m.DeltaXY,
                ["deltaZ"] = m.DeltaZ,
            });
        }
        return arr;
    }

    private static System.Text.Json.Nodes.JsonArray StructuresToArray(IEnumerable<TransactDiffStructure> xs) {
        var arr = new System.Text.Json.Nodes.JsonArray();
        foreach (var s in xs) {
            arr.Add(new System.Text.Json.Nodes.JsonObject {
                ["model"] = s.Model,
                ["origin"] = Vector3ToArray(s.Origin),
                ["architecture"] = s.Architecture,
                ["footprintShape"] = s.FootprintShape,
            });
        }
        return arr;
    }

    private static System.Text.Json.Nodes.JsonArray ValidationToArray(IEnumerable<TransactDiffValidationEntry> xs) {
        var arr = new System.Text.Json.Nodes.JsonArray();
        foreach (var v in xs) {
            arr.Add(new System.Text.Json.Nodes.JsonObject {
                ["code"] = v.Code,
                ["severity"] = v.Severity,
                ["msg"] = v.Msg,
                ["context"] = v.Context,
            });
        }
        return arr;
    }

    private static System.Text.Json.Nodes.JsonArray SpawnsToArray(IEnumerable<TransactDiffSpawn> xs) {
        var arr = new System.Text.Json.Nodes.JsonArray();
        foreach (var s in xs) {
            arr.Add(new System.Text.Json.Nodes.JsonObject {
                ["wcid"] = s.Wcid,
                ["name"] = s.Name,
                ["position"] = Vector3ToArray(s.Position),
            });
        }
        return arr;
    }

    private static System.Text.Json.Nodes.JsonArray PoisToArray(IEnumerable<TransactDiffPoi> xs) {
        var arr = new System.Text.Json.Nodes.JsonArray();
        foreach (var p in xs) {
            arr.Add(new System.Text.Json.Nodes.JsonObject {
                ["title"] = p.Title,
                ["categories"] = StringArray(p.Categories),
            });
        }
        return arr;
    }

    private static System.Text.Json.Nodes.JsonArray Vector3ToArray(System.Numerics.Vector3 v) {
        return new System.Text.Json.Nodes.JsonArray((double)v.X, (double)v.Y, (double)v.Z);
    }

    private static System.Text.Json.Nodes.JsonArray StringArray(string[] xs) {
        var arr = new System.Text.Json.Nodes.JsonArray();
        foreach (var s in xs) arr.Add(s);
        return arr;
    }

    private static System.Text.Json.Nodes.JsonObject HistogramToNode(Dictionary<int, int> hist) {
        var obj = new System.Text.Json.Nodes.JsonObject();
        foreach (var (k, v) in hist) obj[k.ToString()] = v;
        return obj;
    }

    // ════════════════════════════════════════════════════
    //  Tile pipeline (atlas tile pyramid)
    // ════════════════════════════════════════════════════

    private string CmdGetTile(System.Text.Json.Nodes.JsonNode node) {
        var zoom = node["zoom"]?.GetValue<string>() ?? "lb";
        bool includeBase64 = node["includeBase64"]?.GetValue<bool>() ?? false;
        TileEntry entry;
        if (string.Equals(zoom, "lb", StringComparison.OrdinalIgnoreCase)) {
            var (lbX, lbY) = Lb(node);
            entry = _engine.GetLbTile(lbX, lbY);
        } else if (string.Equals(zoom, "region", StringComparison.OrdinalIgnoreCase)) {
            var region = node["region"]?.GetValue<string>()
                ?? throw new ArgumentException("Missing 'region' field for zoom=region");
            entry = _engine.GetRegionTile(region);
        } else if (string.Equals(zoom, "world", StringComparison.OrdinalIgnoreCase)) {
            entry = _engine.GetWorldTile();
        } else {
            return Serialize(new { success = false, command = "get-tile",
                error = $"Unknown zoom '{zoom}'; expected 'lb', 'region', or 'world'" });
        }
        return Serialize(new {
            success = true, command = "get-tile",
            zoom, key = entry.Key, path = entry.Path,
            sizeBytes = entry.SizeBytes,
            generatedAt = entry.GeneratedAt.ToString("o"),
            base64 = includeBase64 ? Convert.ToBase64String(File.ReadAllBytes(
                Path.Combine(_engine.TileCachePathOrEmpty(), entry.Path))) : null,
        });
    }

    private string CmdTileStats() {
        var s = _engine.GetTileStats();
        return Serialize(new {
            success = true, command = "tile-stats",
            totalCount = s.TotalCount, lbCount = s.LbCount,
            regionCount = s.RegionCount, worldCount = s.WorldCount,
            dirtyTileCount = s.DirtyTileCount, dirtyLbCount = s.DirtyLbCount,
            bytesUsed = s.BytesUsed, bytesBudget = s.BytesBudget,
            percentFull = Math.Round(100.0 * s.BytesUsed / Math.Max(1, s.BytesBudget), 2),
        });
    }

    private string CmdRegenerateDirtyTiles() {
        var (n, bytes, errors) = _engine.RegenerateDirtyTiles();
        return Serialize(new {
            success = errors.Count == 0, command = "regenerate-dirty-tiles",
            regenerated = n, bytesWritten = bytes,
            errorCount = errors.Count, errors = errors.Take(10).ToArray(),
        });
    }

    private string CmdListDirtyTiles() {
        var dirty = _engine.ListDirtyTiles();
        return Serialize(new {
            success = true, command = "list-dirty-tiles",
            count = dirty.Count,
            lbs = dirty.Select(d => new { lbKey = $"0x{d.hex}", lbX = (d.lbKey >> 8) & 0xFF, lbY = d.lbKey & 0xFF }).ToArray(),
        });
    }

    private string CmdMarkTilesClean() {
        _engine.MarkTilesClean();
        return Serialize(new { success = true, command = "mark-tiles-clean" });
    }

    private string CmdPruneTiles(System.Text.Json.Nodes.JsonNode node) {
        int? keepNewest = node["keepNewest"]?.GetValue<int>();
        DateTime? olderThan = null;
        var olderStr = node["olderThan"]?.GetValue<string>();
        if (!string.IsNullOrEmpty(olderStr)) {
            if (!DateTime.TryParse(olderStr, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                    out var dt))
                throw new ArgumentException("olderThan must be an ISO-8601 timestamp");
            olderThan = dt;
        }
        var r = _engine.PruneTiles(keepNewest, olderThan);
        return Serialize(new {
            success = true, command = "prune-tiles",
            olderThanResolved = olderThan?.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
            evicted = r.Evicted, bytesFreed = r.BytesFreed,
            remainingCount = r.RemainingCount, remainingBytes = r.RemainingBytes,
        });
    }

    private string CmdGenerateAtlasTiles(System.Text.Json.Nodes.JsonNode node) {
        // Modes: lb-list (specific LBs), region-list (specific regions), world (single tile),
        //        all (everything). Defaults to listed LBs only — eager full-world generation
        //        is opt-in to avoid surprise disk usage.
        var mode = node["mode"]?.GetValue<string>() ?? "lbs";
        if (mode != "lbs" && mode != "regions" && mode != "world" && mode != "all")
            throw new ArgumentException($"'mode' must be one of lbs, regions, world, all; got '{mode}'");
        int generated = 0, skipped = 0;
        long bytes = 0;
        var errors = new List<string>();
        if (mode == "world" || mode == "all") {
            try { var w = _engine.GetWorldTile(); generated++; bytes += w.SizeBytes; }
            catch (Exception ex) { errors.Add($"world: {ex.Message}"); }
        }
        if (mode == "regions" || mode == "all") {
            // Iterate all known regions
            foreach (var r in _engine.ListRegionNames()) {
                try { var t = _engine.GetRegionTile(r); generated++; bytes += t.SizeBytes; }
                catch (Exception ex) { errors.Add($"region {r}: {ex.Message}"); }
            }
        }
        if (mode == "lbs" || mode == "all") {
            // For 'all', fall back to a sweep of the world (every 1 LB) — caller-beware,
            // this can take many minutes. For 'lbs', expect explicit lbList.
            var lbList = node["lbList"] as System.Text.Json.Nodes.JsonArray;
            List<(uint, uint)> lbs;
            if (lbList != null) {
                lbs = new List<(uint, uint)>(lbList.Count);
                for (int i = 0; i < lbList.Count; i++) {
                    if (lbList[i] is not System.Text.Json.Nodes.JsonObject obj)
                        throw new ArgumentException($"'lbList[{i}]' must be an object with lbX/lbY");
                    int lx = obj["lbX"]?.GetValue<int>() ?? throw new ArgumentException($"'lbList[{i}].lbX' is required");
                    int ly = obj["lbY"]?.GetValue<int>() ?? throw new ArgumentException($"'lbList[{i}].lbY' is required");
                    if (lx < 0 || lx > 254) throw new ArgumentException($"'lbList[{i}].lbX' must be 0..254; got {lx}");
                    if (ly < 0 || ly > 254) throw new ArgumentException($"'lbList[{i}].lbY' must be 0..254; got {ly}");
                    lbs.Add(((uint)lx, (uint)ly));
                }
            } else if (mode == "all") {
                lbs = new List<(uint, uint)>();
                for (uint x = 0; x < 256; x++) for (uint y = 0; y < 256; y++) lbs.Add((x, y));
            } else {
                return Serialize(new { success = false, command = "generate-atlas-tiles",
                    error = "mode=lbs requires 'lbList' (array of {lbX,lbY})" });
            }
            var (g, s, b, e) = _engine.GenerateBulkLbTiles(lbs);
            generated += g; skipped += s; bytes += b; errors.AddRange(e);
        }
        return Serialize(new {
            success = errors.Count == 0,
            command = "generate-atlas-tiles",
            mode, generated, skipped, bytesWritten = bytes,
            errorCount = errors.Count, errors = errors.Take(10).ToArray(),
        });
    }

    private static string Serialize(object obj) => JsonSerializer.Serialize(obj, JsonOpts);

    private void WriteResponse(object obj) {
        Console.WriteLine(Serialize(obj));
        Console.Out.Flush();
    }

    // ─────────────────────────────────────────────────────────────────
    // Wave-5.A cell-portal-graph-sweep + pvs-visibility-snapshot
    // see CommandEngine.CellPortalGraph.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdCellPortalGraphSweep(System.Text.Json.Nodes.JsonNode node) {
        string? datPath = node["datPath"]?.GetValue<string>();
        // Accept either an array of LB IDs (preferred) or a single lbId.
        var lbIds = new System.Collections.Generic.List<uint>();
        var lbArr = node["lbIds"]?.AsArray();
        if (lbArr != null) {
            foreach (var entry in lbArr) {
                if (entry == null) continue;
                lbIds.Add(ParseLbIdScalar(entry));
            }
        } else {
            var single = node["lbId"];
            if (single != null) lbIds.Add(ParseLbIdScalar(single));
        }
        if (lbIds.Count == 0)
            throw new ArgumentException("Missing 'lbIds' (array) or 'lbId' (scalar)");
        var r = _engine.CellPortalGraphSweep(datPath, lbIds);
        // `success` = the sweep RAN to completion (a reflection/DRW-drift
        // failure throws and is reported via the error envelope). `clean` =
        // the graph has no orphans / asymmetric / unresolved findings, so
        // callers can distinguish "command worked" from "content is clean".
        return Serialize(new {
            success = true,
            clean = r.OrphanedCellCount == 0 && r.AsymmetricPortalCount == 0 && r.UnresolvedTargetCount == 0,
            command = "cell-portal-graph-sweep",
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            lbCount = r.LbCount,
            envCellCount = r.EnvCellCount,
            portalCount = r.PortalCount,
            orphanedCellCount = r.OrphanedCellCount,
            asymmetricPortalCount = r.AsymmetricPortalCount,
            unresolvedTargetCount = r.UnresolvedTargetCount,
            source = r.Source,
            perLb = r.PerLb.Select(lb => new {
                lbHex = lb.LbHex,
                cellCount = lb.CellCount,
                portalCount = lb.PortalCount,
                orphanedCellCount = lb.OrphanedCellCount,
                asymmetricPortalCount = lb.AsymmetricPortalCount,
                unresolvedTargetCount = lb.UnresolvedTargetCount,
                orphanedCells = lb.OrphanedCells,
                asymmetricPortals = lb.AsymmetricPortals.Select(a => new {
                    fromCellHex = a.FromCellHex,
                    toCellHex = a.ToCellHex,
                    polyId = a.PolyId,
                    otherPortalId = a.OtherPortalId,
                    reason = a.Reason,
                })
            })
        });
    }

    private string CmdPvsVisibilitySnapshot(System.Text.Json.Nodes.JsonNode node) {
        string? datPath = node["datPath"]?.GetValue<string>();
        var cellNode = node["cellId"] ?? throw new ArgumentException("Missing 'cellId'");
        uint cellId = ParseCellIdScalarStrict(cellNode);
        int bfsDepth = node["bfsDepth"]?.GetValue<int>() ?? 1;
        // Wave-5.A — optional `out` writes the oracle JSON to disk for
        // the wire-agent's __diag.pvs.diff() consumption. Convention:
        // apps/holtburger-web/oracles/pvs-<cellHex>.json. Same pattern
        // as dump-lb-expectations.
        string outPath = node["out"]?.GetValue<string>() ?? "";
        var r = _engine.PvsVisibilitySnapshot(datPath, cellId, bfsDepth);
        if (!r.Found) {
            return Serialize(new {
                success = false,
                found = false,
                command = "pvs-visibility-snapshot",
                cellHex = r.CellHex,
                cellId = r.CellId,
                bfsDepth = r.BfsDepth,
                error = $"cell {r.CellHex} not found in cell DAT; the BFS root is absent (a typo'd or short-form cellId would land here)",
                source = r.Source,
            });
        }
        return Serialize(new {
            success = true,
            found = true,
            command = "pvs-visibility-snapshot",
            cellHex = r.CellHex,
            cellId = r.CellId,
            bfsDepth = r.BfsDepth,
            liveVisibleCount = r.LiveVisibleCount,
            datVisibleCount = r.DatVisibleCount,
            liveVisibleCells = r.LiveVisibleCells,
            datVisibleCells = r.DatVisibleCells,
            onlyInLive = r.OnlyInLive,
            onlyInDat = r.OnlyInDat,
            source = r.Source,
        }, outPath);
    }

    /// <summary>
    /// Permissively parse an LB-high ID from a JSON scalar. Accepts
    /// "0xA9B40000" hex strings (full), "0xa9b4" short LB hex, the
    /// zero-padded "0x0000A9B4" form, and decimal numbers (e.g. 43444).
    /// Any value with <c>0 &lt; v &lt;= 0xFFFF</c> is treated as a short
    /// LB-high word and widened by &lt;&lt;16, regardless of how it was
    /// spelled; values &gt; 0xFFFF are already full IDs. Used for the
    /// <c>cell-portal-graph-sweep</c> lbIds and the chunk-command ranges.
    /// NOTE: per F173 the pvs <c>cellId</c> argument does NOT use this
    /// widening — see <see cref="ParseCellIdScalarStrict"/>.
    /// </summary>
    private static uint ParseLbIdScalar(System.Text.Json.Nodes.JsonNode entry) {
        uint v = ParseUInt32Scalar(entry);
        if (v != 0u && v <= 0xFFFFu) v <<= 16;
        return v;
    }

    /// <summary>
    /// Parse a full 32-bit cell ID from a JSON scalar WITHOUT the short-form
    /// &lt;&lt;16 widening (F173). The pvs snapshot needs a precise cell ID:
    /// a typo'd or short-form value must fail loudly rather than silently
    /// widen into a bogus LB id. Rejects ≤4-digit hex strings, negative
    /// numerics, and any value whose low word is 0x0000/0xFFFE/0xFFFF
    /// (LandBlock/LandBlockInfo/landblock suffixes, never an EnvCell).
    /// </summary>
    private static uint ParseCellIdScalarStrict(System.Text.Json.Nodes.JsonNode entry) {
        var kind = entry.GetValueKind();
        if (kind == System.Text.Json.JsonValueKind.String) {
            var s = entry.GetValue<string>().Trim();
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
                var hex = s.Substring(2);
                if (hex.Length <= 4)
                    throw new ArgumentException($"cellId '{s}' is a short-form hex word; supply a full 32-bit cell ID (e.g. 0xA9B40100)");
                var hv = Convert.ToUInt32(hex, 16);
                ValidateCellLowWord(hv);
                return hv;
            }
            long parsed = long.Parse(s);
            if (parsed < 0) throw new ArgumentException($"cellId '{s}' must be non-negative");
            uint dv = checked((uint)parsed);
            ValidateCellLowWord(dv);
            return dv;
        }
        long lv = entry.GetValue<long>();
        if (lv < 0) throw new ArgumentException("cellId must be non-negative");
        uint v = checked((uint)lv);
        ValidateCellLowWord(v);
        return v;
    }

    private static void ValidateCellLowWord(uint cellId) {
        ushort low = (ushort)(cellId & 0xFFFFu);
        if (low == 0x0000 || low == 0xFFFE || low == 0xFFFF)
            throw new ArgumentException($"cellId 0x{cellId:X8} has low word 0x{low:X4}, which is a LandBlock/LandBlockInfo suffix, never an EnvCell; supply a full cell ID (suffix 0x0100..0xFFFD)");
    }

    /// <summary>
    /// Parse a uint32 from a JSON scalar (hex string, decimal string, or
    /// numeric) with no LB widening. Shared by <see cref="ParseLbIdScalar"/>.
    /// </summary>
    private static uint ParseUInt32Scalar(System.Text.Json.Nodes.JsonNode entry) {
        var kind = entry.GetValueKind();
        if (kind == System.Text.Json.JsonValueKind.String) {
            var s = entry.GetValue<string>().Trim();
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                return Convert.ToUInt32(s.Substring(2), 16);
            return uint.Parse(s);
        }
        return (uint)entry.GetValue<long>();
    }

    // ─────────────────────────────────────────────────────────────────
    // Wave-5.B region-skybox-snapshot + region-day-night-curve
    // see CommandEngine.Skybox.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdRegionSkyboxSnapshot(System.Text.Json.Nodes.JsonNode node) {
        double gameTimeSec = ParseDoubleField(node, "gameTimeSec");
        string? datPath = node["datPath"]?.GetValue<string>();
        var r = _engine.RegionSkyboxSnapshot(gameTimeSec, datPath);
        return Serialize(new {
            success = true,
            command = "region-skybox-snapshot",
            gameTimeSec = r.GameTimeSec,
            normalizedDayPosition = r.NormalizedDayPosition,
            dayGroupIndex = r.DayGroupIndex,
            dayGroupName = r.DayGroupName,
            uniforms = new {
                skyTop = r.Uniforms.SkyTop,
                skyBottom = r.Uniforms.SkyBottom,
                sunPosition = r.Uniforms.SunPosition,
                ambient = r.Uniforms.Ambient,
                fog = r.Uniforms.Fog,
            },
            rawSkyState = new {
                dirColorArgb = $"0x{r.RawSkyState.DirColorArgb:X8}",
                dirBright = r.RawSkyState.DirBright,
                dirHeading = r.RawSkyState.DirHeading,
                dirPitch = r.RawSkyState.DirPitch,
                ambColorArgb = $"0x{r.RawSkyState.AmbColorArgb:X8}",
                ambBright = r.RawSkyState.AmbBright,
                fogColorArgb = $"0x{r.RawSkyState.FogColorArgb:X8}",
                fogMin = r.RawSkyState.FogMin,
                fogMax = r.RawSkyState.FogMax,
                worldFog = r.RawSkyState.WorldFog,
                timeOfDayNormalized = r.RawSkyState.TimeOfDayNormalized,
                dayGroupIndex = r.RawSkyState.DayGroupIndex,
            },
            activeSkyObjects = r.ActiveSkyObjects.Select(s => new {
                did = $"0x{s.Did:X8}",
                brightness = s.Brightness,
                alpha = s.Alpha,
                propertyFlags = s.PropertyFlags,
                beginTime = s.BeginTime,
                endTime = s.EndTime,
                beginAngleDeg = s.BeginAngleDeg,
                endAngleDeg = s.EndAngleDeg,
                visible = s.Visible,
            }),
            weatherStateName = r.WeatherStateName,
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            source = r.Source,
        });
    }

    private string CmdRegionDayNightCurve(System.Text.Json.Nodes.JsonNode node) {
        int hours = node["hours"]?.GetValue<int>() ?? 24;
        string? datPath = node["datPath"]?.GetValue<string>();
        var r = _engine.RegionDayNightCurve(hours, datPath);
        return Serialize(new {
            success = true,
            command = "region-day-night-curve",
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            hours = r.Hours,
            dayLengthSeconds = r.DayLengthSeconds,
            source = r.Source,
            samples = r.Samples.Select(s => new {
                gameTimeSec = s.GameTimeSec,
                normalizedDayPosition = s.NormalizedDayPosition,
                dayGroupIndex = s.DayGroupIndex,
                dayGroupName = s.DayGroupName,
                uniforms = new {
                    skyTop = s.Uniforms.SkyTop,
                    skyBottom = s.Uniforms.SkyBottom,
                    sunPosition = s.Uniforms.SunPosition,
                    ambient = s.Uniforms.Ambient,
                    fog = s.Uniforms.Fog,
                },
                rawSkyState = new {
                    dirColorArgb = $"0x{s.RawSkyState.DirColorArgb:X8}",
                    dirBright = s.RawSkyState.DirBright,
                    dirHeading = s.RawSkyState.DirHeading,
                    dirPitch = s.RawSkyState.DirPitch,
                    ambColorArgb = $"0x{s.RawSkyState.AmbColorArgb:X8}",
                    ambBright = s.RawSkyState.AmbBright,
                    fogColorArgb = $"0x{s.RawSkyState.FogColorArgb:X8}",
                    fogMin = s.RawSkyState.FogMin,
                    fogMax = s.RawSkyState.FogMax,
                    worldFog = s.RawSkyState.WorldFog,
                    timeOfDayNormalized = s.RawSkyState.TimeOfDayNormalized,
                    dayGroupIndex = s.RawSkyState.DayGroupIndex,
                },
                weatherStateName = s.WeatherStateName,
            }),
        });
    }

    /// <summary>
    /// Parse a JSON field as a double; accepts JSON number or numeric
    /// string. Mirrors ParseFloatField but returns double for the
    /// SkyEvalState time-driver f64 arithmetic.
    /// </summary>
    private static double ParseDoubleField(System.Text.Json.Nodes.JsonNode node, string name) {
        var v = node[name] ?? throw new ArgumentException($"Missing '{name}' field");
        if (v.GetValueKind() == System.Text.Json.JsonValueKind.String) {
            return double.Parse(v.GetValue<string>(), System.Globalization.CultureInfo.InvariantCulture);
        }
        return v.GetValue<double>();
    }

    // ─────────────────────────────────────────────────────────────────
    // Melt-integration Phase R — Region 0x13 JSON round-trip
    // see CommandEngine.Region.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdRegionExportJson(System.Text.Json.Nodes.JsonNode node) {
        string? outPath = node["out"]?.GetValue<string>();
        string? parts = node["parts"]?.GetValue<string>();
        string? datPath = node["datPath"]?.GetValue<string>();
        var r = _engine.RegionExportJson(outPath, parts, datPath);
        return Serialize(new {
            success = true,
            command = "region-export-json",
            source = r.Source,
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            outPath = r.OutPath,
            partsMask = r.PartsMask,
            counts = new {
                dayGroups = r.DayGroups,
                soundStbs = r.SoundStbs,
                sceneTypes = r.SceneTypes,
                terrainTypes = r.TerrainTypes,
            },
            // Inline only when no 'out' was given; large (~1 MB pretty-printed).
            json = r.InlineJson,
        });
    }

    private string CmdRegionImportJson(System.Text.Json.Nodes.JsonNode node) {
        string path = node["path"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'path' field");
        bool apply = node["apply"]?.GetValue<bool>() ?? false;
        var r = _engine.RegionImportJson(path, apply);
        return Serialize(new {
            success = r.Problems.Count == 0,
            command = "region-import-json",
            applied = r.Applied,
            staged = r.Staged,
            path = r.Path,
            problems = r.Problems,
            packedBytes = r.PackedBytes,
            packParity = r.PackParity,
            packSha256 = r.PackSha256,
            note = r.Staged
                ? "Region staged in PortalDatDocument; run 'export' to write it into the export DATs."
                : (r.Problems.Count == 0 ? "Dry-run OK (apply:false) — nothing staged." : "Validation failed — nothing staged."),
        });
    }

    private string CmdRegionDiff(System.Text.Json.Nodes.JsonNode node) {
        string? otherDat = node["otherDat"]?.GetValue<string>();
        string? otherJson = node["otherJson"]?.GetValue<string>();
        int maxRows = node["maxRows"]?.GetValue<int>() ?? 500;
        var r = _engine.RegionDiff(otherDat, otherJson, maxRows);
        return Serialize(new {
            success = true,
            command = "region-diff",
            oursSource = r.OursSource,
            theirsSource = r.TheirsSource,
            diffCount = r.DiffCount,
            truncated = r.Truncated,
            rows = r.Rows.Select(row => new { path = row.Path, ours = row.Ours, theirs = row.Theirs }),
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Melt-integration Phase X.1 — secondary DAT handles
    // see CommandEngine.DatHandles.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdDatOpen(System.Text.Json.Nodes.JsonNode node) {
        string path = node["path"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'path' field");
        string alias = node["alias"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'alias' field");
        var r = _engine.DatOpen(path, alias);
        return Serialize(new {
            success = true,
            command = "dat-open",
            alias = r.Alias,
            path = r.Path,
            kind = r.Kind,
            files = r.Files,
        });
    }

    private string CmdDatClose(System.Text.Json.Nodes.JsonNode node) {
        string alias = node["alias"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'alias' field");
        var r = _engine.DatClose(alias);
        return Serialize(new { success = true, command = "dat-close", alias = r.Alias, path = r.Path });
    }

    private string CmdDatList() {
        var r = _engine.DatList();
        return Serialize(new {
            success = true,
            command = "dat-list",
            count = r.Count,
            handles = r.Rows.Select(h => new { alias = h.Alias, path = h.Path, kind = h.Kind }),
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Melt-integration Phase S — Scene 0x12 inspection
    // see CommandEngine.Scene.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdSceneExportJson(System.Text.Json.Nodes.JsonNode node) {
        string? sceneId = node["sceneId"]?.GetValue<string>();
        bool all = node["all"]?.GetValue<bool>() ?? false;
        string? outPath = node["out"]?.GetValue<string>();
        string? datPath = node["datPath"]?.GetValue<string>();
        var r = _engine.SceneExportJson(sceneId, all, outPath, datPath);
        return Serialize(new {
            success = true,
            command = "scene-export-json",
            sceneId = r.SceneId,
            source = r.Source,
            outPath = r.OutPath,
            sceneCount = r.SceneCount,
            objectCount = r.ObjectCount,
            json = r.InlineJson,
        });
    }

    private string CmdSceneDiff(System.Text.Json.Nodes.JsonNode node) {
        string sceneId = node["sceneId"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'sceneId' field");
        string otherDat = node["otherDat"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'otherDat' field");
        int maxRows = node["maxRows"]?.GetValue<int>() ?? 500;
        var r = _engine.SceneDiff(sceneId, otherDat, maxRows);
        return Serialize(new {
            success = true,
            command = "scene-diff",
            sceneId = r.SceneId,
            oursSource = r.OursSource,
            theirsSource = r.TheirsSource,
            diffCount = r.DiffCount,
            truncated = r.Truncated,
            rows = r.Rows.Select(row => new { path = row.Path, ours = row.Ours, theirs = row.Theirs }),
        });
    }

    private string CmdSceneWhereUsed(System.Text.Json.Nodes.JsonNode node) {
        string sceneId = node["sceneId"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'sceneId' field");
        var r = _engine.SceneWhereUsed(sceneId);
        return Serialize(new {
            success = true,
            command = "scene-where-used",
            sceneId = r.SceneId,
            regionSource = r.RegionSource,
            hitCount = r.HitCount,
            hits = r.Hits.Select(h => new {
                sceneTypeIndex = h.SceneTypeIndex,
                stbIndex = h.StbIndex,
                sceneSlot = h.SceneSlot,
                sceneCountInType = h.SceneCountInType,
                terrainTypes = h.TerrainTypes,
            }),
        });
    }

    private string CmdSceneEdit(System.Text.Json.Nodes.JsonNode node) {
        string sceneId = node["sceneId"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'sceneId' field");
        int index = node["index"]?.GetValue<int>()
            ?? throw new ArgumentException("Missing 'index' field");
        var fields = node["fields"] as System.Text.Json.Nodes.JsonObject
            ?? throw new ArgumentException("Missing 'fields' object");
        bool apply = node["apply"]?.GetValue<bool>() ?? false;
        var r = _engine.SceneEdit(sceneId, index, fields, apply);
        return Serialize(new {
            success = true,
            command = "scene-edit",
            sceneId = r.SceneId,
            index = r.Index,
            source = r.Source,
            changedFields = r.ChangedFields,
            applied = r.Applied,
            staged = r.Staged,
            objectAfter = r.ObjectAfter,
            note = r.Staged
                ? "Scene staged in PortalDatDocument; run 'export' to write it into the export DATs."
                : "Dry-run (apply:false) — nothing staged.",
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Melt-integration Phase G — asset-reference graph
    // see CommandEngine.AssetGraph.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdAssetRefs(System.Text.Json.Nodes.JsonNode node) {
        string id = ParseIdFieldToHex(node["id"]);
        string? datPath = node["datPath"]?.GetValue<string>();
        var r = _engine.AssetRefs(id, datPath);
        return Serialize(new {
            success = true,
            command = "asset-refs",
            id = r.Id,
            kind = r.Kind,
            source = r.Source,
            edgeCount = r.EdgeCount,
            edges = r.Edges.Select(e => new { kind = e.Kind, id = e.Id, relation = e.Relation }),
        });
    }

    private string CmdAssetUsedBy(System.Text.Json.Nodes.JsonNode node) {
        string id = ParseIdFieldToHex(node["id"]);
        bool transitive = node["transitive"]?.GetValue<bool>() ?? false;
        string? datPath = node["datPath"]?.GetValue<string>();
        var r = _engine.AssetUsedBy(id, transitive, datPath);
        return Serialize(new {
            success = true,
            command = "asset-used-by",
            id = r.Id,
            kind = r.Kind,
            source = r.Source,
            indexBuildMs = r.IndexBuildMs,
            indexCounts = new {
                gfxObjs = r.IndexCounts.GfxObjs,
                setups = r.IndexCounts.Setups,
                scenes = r.IndexCounts.Scenes,
                surfaces = r.IndexCounts.Surfaces,
                surfaceTextures = r.IndexCounts.SurfaceTextures,
            },
            directCount = r.DirectCount,
            direct = r.Direct.Select(e => new { kind = e.Kind, id = e.Id }),
            transitiveCount = r.TransitiveCount,
            transitive = r.Transitive?.Select(e => new { kind = e.Kind, id = e.Id }),
        });
    }

    private string CmdSurfaceFingerprint(System.Text.Json.Nodes.JsonNode node) {
        string? id = node["id"] != null ? ParseIdFieldToHex(node["id"]) : null;
        Dictionary<string, string>? match = null;
        if (node["match"] is System.Text.Json.Nodes.JsonObject matchObj) {
            match = new Dictionary<string, string>();
            foreach (var (k, v) in matchObj) {
                if (v == null) continue;
                match[k] = v.GetValueKind() == System.Text.Json.JsonValueKind.String
                    ? v.GetValue<string>()
                    : v.ToJsonString();
            }
        }
        string? datPath = node["datPath"]?.GetValue<string>();
        var r = _engine.SurfaceFingerprint(id, match, datPath);
        return Serialize(new {
            success = true,
            command = "surface-fingerprint",
            probe = r.Probe,
            source = r.Source,
            matchCount = r.MatchCount,
            matches = r.Matches,
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Melt deferred-functionality briefing — see CommandEngine.MeltReference.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdMeltReference(System.Text.Json.Nodes.JsonNode node) {
        string? topic = node["topic"]?.GetValue<string>();
        var r = _engine.MeltReference(topic);
        return Serialize(new {
            success = true,
            command = "melt-reference",
            topic = r.Topic,
            docPath = r.DocPath,
            topics = r.Topics?.Select(t => new { key = t.Key, title = t.Title, summary = t.Summary }),
            markdown = r.Markdown,
            note = r.Note,
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Melt-integration Phase X.2 — cross-DAT transplant
    // see CommandEngine.Transplant.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdCopyLandblock(System.Text.Json.Nodes.JsonNode node) {
        string fromDat = node["fromDat"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'fromDat' field");
        uint srcLbX = U254(node, "srcLbX"), srcLbY = U254(node, "srcLbY");
        uint? dstLbX = node["dstLbX"] != null ? U254(node, "dstLbX") : null;
        uint? dstLbY = node["dstLbY"] != null ? U254(node, "dstLbY") : null;
        bool heightmap = node["heightmap"]?.GetValue<bool>() ?? true;
        bool textures = node["textures"]?.GetValue<bool>() ?? true;
        bool objects = node["objects"]?.GetValue<bool>() ?? true;
        bool buildings = node["buildings"]?.GetValue<bool>() ?? true;
        bool clearExisting = node["clearExisting"]?.GetValue<bool>() ?? (objects && buildings);
        var r = _engine.CopyLandblock(fromDat, srcLbX, srcLbY, dstLbX, dstLbY,
            heightmap, textures, objects, buildings, clearExisting);
        return Serialize(new {
            success = true,
            command = "copy-landblock",
            source = r.SourceKey,
            srcLb = r.SrcLb,
            dstLb = r.DstLb,
            terrainVertices = r.TerrainVertices,
            heightmapCopied = r.HeightmapCopied,
            texturesCopied = r.TexturesCopied,
            objectsCopied = r.ObjectsCopied,
            buildingsCopied = r.BuildingsCopied,
            interiorCellsStaged = r.InteriorCellsStaged,
            clearedExisting = r.ClearedExisting,
            warnings = r.Warnings,
            note = "Staged in documents — validate-landblock the destination, then 'export'.",
        });
    }

    private string CmdCopyBuilding(System.Text.Json.Nodes.JsonNode node) {
        string fromDat = node["fromDat"]?.GetValue<string>()
            ?? throw new ArgumentException("Missing 'fromDat' field");
        uint srcLbX = U254(node, "srcLbX"), srcLbY = U254(node, "srcLbY");
        int buildingIndex = node["buildingIndex"]?.GetValue<int>()
            ?? throw new ArgumentException("Missing 'buildingIndex' field");
        uint dstLbX = U254(node, "dstLbX"), dstLbY = U254(node, "dstLbY");
        float x = node["x"]?.GetValue<float>() ?? throw new ArgumentException("Missing 'x'");
        float y = node["y"]?.GetValue<float>() ?? throw new ArgumentException("Missing 'y'");
        float z = node["z"]?.GetValue<float>() ?? throw new ArgumentException("Missing 'z'");
        var orientation = ParseQuaternion(node);
        var r = _engine.CopyBuilding(fromDat, srcLbX, srcLbY, buildingIndex, dstLbX, dstLbY, x, y, z, orientation);
        return Serialize(new {
            success = true,
            command = "copy-building",
            source = r.SourceKey,
            srcLb = r.SrcLb,
            buildingIndex = r.BuildingIndex,
            modelId = r.ModelId,
            dstLb = r.DstLb,
            staticObjectIndex = r.StaticObjectIndex,
            interiorCells = r.InteriorCells,
            warnings = r.Warnings,
            note = "Staged — interior cells are instantiated (with cell-ID remap + VisibleCells fixup) at 'export'.",
        });
    }

    private string CmdRemoveBuilding(System.Text.Json.Nodes.JsonNode node) {
        var (lbX, lbY) = Lb(node);
        int buildingIndex = node["buildingIndex"]?.GetValue<int>()
            ?? throw new ArgumentException("Missing 'buildingIndex' field");
        var r = _engine.RemoveBuilding(lbX, lbY, buildingIndex);
        return Serialize(new {
            success = true,
            command = "remove-building",
            lb = r.Lb,
            buildingIndex = r.BuildingIndex,
            modelId = r.ModelId,
            removedStaticIndex = r.RemovedStaticIndex,
            matchDistance = r.MatchDistance,
            note = r.Note,
        });
    }

    private string CmdBulkPaintReplace(System.Text.Json.Nodes.JsonNode node) {
        int toType = node["toType"]?.GetValue<int>()
            ?? throw new ArgumentException("Missing 'toType' field");
        int? fromType = node["fromType"]?.GetValue<int>();
        var lbs = new List<(uint, uint)>();
        if (node["lbList"] is System.Text.Json.Nodes.JsonArray arr) {
            int idx = 0;
            foreach (var item in arr) {
                if (item == null) { idx++; continue; }
                uint ex = U(item, "lbX"), ey = U(item, "lbY");
                if (ex > 254) throw new ArgumentException($"'lbList[{idx}].lbX' must be 0..254; got {ex}");
                if (ey > 254) throw new ArgumentException($"'lbList[{idx}].lbY' must be 0..254; got {ey}");
                lbs.Add((ex, ey));
                idx++;
            }
        }
        else if (node["minLbX"] != null) {
            uint minX = U(node, "minLbX"), minY = U(node, "minLbY");
            uint maxX = U(node, "maxLbX"), maxY = U(node, "maxLbY");
            if (minX > 254) throw new ArgumentException($"'minLbX' must be 0..254; got {minX}");
            if (minY > 254) throw new ArgumentException($"'minLbY' must be 0..254; got {minY}");
            if (maxX > 254) throw new ArgumentException($"'maxLbX' must be 0..254; got {maxX}");
            if (maxY > 254) throw new ArgumentException($"'maxLbY' must be 0..254; got {maxY}");
            if (minX > maxX) throw new ArgumentException($"'minLbX' ({minX}) must be <= 'maxLbX' ({maxX})");
            if (minY > maxY) throw new ArgumentException($"'minLbY' ({minY}) must be <= 'maxLbY' ({maxY})");
            for (uint xx = minX; xx <= maxX; xx++)
                for (uint yy = minY; yy <= maxY; yy++)
                    lbs.Add((xx, yy));
        }
        var r = _engine.BulkPaintReplace(lbs, fromType, toType);
        return Serialize(new {
            success = true,
            command = "bulk-paint-replace",
            landblocksRequested = r.LandblocksRequested,
            landblocksChanged = r.LandblocksChanged,
            landblocksMissing = r.LandblocksMissing,
            verticesChanged = r.VerticesChanged,
            fromType = r.FromType,
            toType = r.ToType,
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Wave-5.C diag-run-all + diag-status — see Diagnostics/RunAll.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdDiagRunAll(System.Text.Json.Nodes.JsonNode node) {
        string? wave4Mode = node["wave4Mode"]?.GetValue<string>();
        string? reportDir = node["reportDir"]?.GetValue<string>();
        bool parallel = node["parallel"]?.GetValue<bool>() ?? false;
        List<string>? skipSurfaces = null;
        if (node["skipSurfaces"] is System.Text.Json.Nodes.JsonArray skipArr) {
            skipSurfaces = new List<string>();
            foreach (var v in skipArr) {
                var s = v?.GetValue<string>();
                if (!string.IsNullOrWhiteSpace(s)) skipSurfaces.Add(s);
            }
        }
        var r = _engine.DiagRunAll(wave4Mode, reportDir, skipSurfaces, parallel);
        return Serialize(new {
            success = string.IsNullOrEmpty(r.DriverError) && r.RequiredFailures == 0,
            command = "diag-run-all",
            aggregateJsonPath = r.AggregateJsonPath,
            summaryMarkdownPath = r.SummaryMarkdownPath,
            wave4Mode = r.Wave4Mode,
            elapsedMs = r.ElapsedMs,
            driverExitCode = r.DriverExitCode,
            driverError = r.DriverError,
            summary = new {
                checkedCount = r.CheckedSurfaces,
                pass = r.PassedSurfaces,
                fail = r.FailedSurfaces,
                skipped = r.SkippedSurfaces,
                skippedNotShipped = r.SkippedNotShipped,
                skippedCli = r.SkippedCli,
                infra = r.InfraSurfaces,
                requiredFailures = r.RequiredFailures,
            },
            surfaces = r.Surfaces.Select(s => new {
                surface = s.Surface,
                status = s.Status,
                exitCode = s.ExitCode,
                reportJsonPath = s.ReportJsonPath,
                durationMs = s.DurationMs,
                mismatchCount = s.MismatchCount,
                script = s.Script,
                args = s.Args,
                logPath = s.LogPath,
                notes = s.Notes,
                infraError = s.InfraError,
            }),
        });
    }

    private string CmdDiagStatus() {
        try {
            var r = _engine.DiagStatus();
            if (!string.IsNullOrEmpty(r.DriverError)) {
                return Serialize(new {
                    success = false,
                    command = "diag-status",
                    aggregateJsonPath = r.AggregateJsonPath,
                    error = r.DriverError,
                });
            }
            return Serialize(new {
                success = true,
                command = "diag-status",
                aggregateJsonPath = r.AggregateJsonPath,
                summaryMarkdownPath = r.SummaryMarkdownPath,
                wave4Mode = r.Wave4Mode,
                elapsedMs = r.ElapsedMs,
                summary = new {
                    checkedCount = r.CheckedSurfaces,
                    pass = r.PassedSurfaces,
                    fail = r.FailedSurfaces,
                    skipped = r.SkippedSurfaces,
                    skippedNotShipped = r.SkippedNotShipped,
                    skippedCli = r.SkippedCli,
                    infra = r.InfraSurfaces,
                    requiredFailures = r.RequiredFailures,
                },
                surfaces = r.Surfaces.Select(s => new {
                    surface = s.Surface,
                    status = s.Status,
                    exitCode = s.ExitCode,
                    reportJsonPath = s.ReportJsonPath,
                    durationMs = s.DurationMs,
                    mismatchCount = s.MismatchCount,
                    notes = s.Notes,
                }),
            });
        } catch (Exception ex) {
            return Serialize(new {
                success = false,
                command = "diag-status",
                error = ex.Message,
            });
        }
    }


    // ─────────────────────────────────────────────────────────────────
    // Wave-4.C mesh-vs-obj-export-chunk + Wave-4.D env-cell-vs-setup-model-chunk
    // (auto-spliced by validate_mesh_parity.cjs from WAVE4M_DISPATCH_PENDING.patch)
    // ─────────────────────────────────────────────────────────────────

    private string CmdMeshVsObjExportChunk(System.Text.Json.Nodes.JsonNode node) {
        // F136: startId/endId are FILE ids (0x01/0x02 prefixes), not landblock
        // keys — parse without the ParseLbIdScalar <<16 short-form widening.
        uint startId = ParseUIntField(node, "startId");
        uint endId = ParseUIntField(node, "endId");
        string? datPath = node["datPath"]?.GetValue<string>();
        string? cacheRoot = node["cacheRoot"]?.GetValue<string>();
        bool fastMode = node["fastMode"]?.GetValue<bool>() ?? false;
        System.Collections.Generic.List<uint>? fastIds = null;
        var idsArr = node["fastModeIds"]?.AsArray();
        if (idsArr != null) {
            fastIds = new System.Collections.Generic.List<uint>(idsArr.Count);
            foreach (var entry in idsArr) {
                if (entry == null) continue;
                fastIds.Add(ParseUInt32Scalar(entry));
            }
        }
        var r = _engine.MeshVsObjExportChunk(startId, endId, datPath, cacheRoot, fastMode, fastIds);
        return Serialize(new {
            success = r.FailCount == 0,
            command = "mesh-vs-obj-export-chunk",
            chunkLabel = r.ChunkLabel,
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            startId = $"0x{r.StartId:X8}",
            endId = $"0x{r.EndId:X8}",
            recordCount = r.RecordCount,
            passCount = r.PassCount,
            failCount = r.FailCount,
            cachedCount = r.CachedCount,
            parseErrorCount = r.ParseErrorCount,
            cacheRoot = r.CacheRoot,
            progressJsonPath = r.ProgressJsonPath,
            source = r.Source,
            failures = r.Failures.Select(f => new {
                idHex = f.IdHex,
                typeName = f.TypeName,
                status = f.Status,
                failureReason = f.FailureReason,
            }),
        });
    }

    private string CmdEnvCellVsSetupModelChunk(System.Text.Json.Nodes.JsonNode node) {
        uint startId = ParseLbIdScalar(node["startId"]
            ?? throw new ArgumentException("Missing 'startId' field"));
        uint endId = ParseLbIdScalar(node["endId"]
            ?? throw new ArgumentException("Missing 'endId' field"));
        string? datPath = node["datPath"]?.GetValue<string>();
        string? cacheRoot = node["cacheRoot"]?.GetValue<string>();
        bool fastMode = node["fastMode"]?.GetValue<bool>() ?? false;
        System.Collections.Generic.List<uint>? fastIds = null;
        var idsArr = node["fastModeIds"]?.AsArray();
        if (idsArr != null) {
            fastIds = new System.Collections.Generic.List<uint>(idsArr.Count);
            foreach (var entry in idsArr) {
                if (entry == null) continue;
                fastIds.Add(ParseLbIdScalar(entry));
            }
        }
        var r = _engine.EnvCellVsSetupModelChunk(startId, endId, datPath, cacheRoot, fastMode, fastIds);
        return Serialize(new {
            success = r.FailCount == 0,
            command = "env-cell-vs-setup-model-chunk",
            chunkLabel = r.ChunkLabel,
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            startId = $"0x{r.StartId:X8}",
            endId = $"0x{r.EndId:X8}",
            recordCount = r.RecordCount,
            passCount = r.PassCount,
            failCount = r.FailCount,
            cachedCount = r.CachedCount,
            parseErrorCount = r.ParseErrorCount,
            knownDriftCount = r.KnownDriftCount,
            cacheRoot = r.CacheRoot,
            progressJsonPath = r.ProgressJsonPath,
            source = r.Source,
            failures = r.Failures.Select(f => new {
                idHex = f.IdHex,
                typeName = f.TypeName,
                status = f.Status,
                failureReason = f.FailureReason,
            }),
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Wave-3.D motion-table-anim-hooks (follow-on) — see CommandEngine.MotionParity.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdMotionTableAnimHooks(System.Text.Json.Nodes.JsonNode node) {
        uint motionTableId = ParseUIntField(node, "motionTableId");
        string? datPath = node["datPath"]?.GetValue<string>();
        var r = _engine.MotionTableAnimHooks(motionTableId, datPath);
        return Serialize(new {
            success = r.Found,
            command = "motion-table-anim-hooks",
            motionTableId = $"0x{r.MotionTableId:X8}",
            found = r.Found,
            failureReason = r.FailureReason,
            cycleCount = r.CycleCount,
            modifierCount = r.ModifierCount,
            linkCount = r.LinkCount,
            animationCount = r.AnimationCount,
            hookCount = r.Hooks.Count,
            hooks = r.Hooks.Select(h => new {
                animId = $"0x{h.AnimId:X8}",
                frameNumber = h.FrameNumber,
                hookType = h.HookType,
                soundDid = h.SoundDid.HasValue ? $"0x{h.SoundDid.Value:X8}" : null,
                emitterDid = h.EmitterDid.HasValue ? $"0x{h.EmitterDid.Value:X8}" : null,
                emitterId = h.EmitterId,
                pesDid = h.PesDid.HasValue ? $"0x{h.PesDid.Value:X8}" : null,
            }),
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Wave-4.A + 4.B texture-parity dispatch — see CommandEngine.TextureParity.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdChoriziteDecodeSurfaceChunk(System.Text.Json.Nodes.JsonNode node) {
        uint startId = ParseUIntField(node, "startId");
        uint endId = ParseUIntField(node, "endId");
        string? datPath = node["datPath"]?.GetValue<string>();
        string? cacheRoot = node["cacheRoot"]?.GetValue<string>();
        bool fastMode = node["fastMode"]?.GetValue<bool>() ?? false;
        bool emitPng = node["emitPng"]?.GetValue<bool>() ?? false;
        var r = _engine.ChoriziteDecodeSurfaceChunk(startId, endId, datPath, cacheRoot, fastMode, emitPng);
        return Serialize(new {
            success = r.FailCount == 0,
            command = "chorizite-decode-surface-chunk",
            chunkLabel = r.ChunkLabel,
            startId = $"0x{r.StartId:X8}",
            endId = $"0x{r.EndId:X8}",
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            cacheRoot = r.CacheRoot,
            progressJsonPath = r.ProgressJsonPath,
            recordCount = r.RecordCount,
            passCount = r.PassCount,
            failCount = r.FailCount,
            cachedCount = r.CachedCount,
            source = r.Source,
            failures = r.Failures.Select(f => new {
                idHex = f.IdHex,
                status = f.Status,
                failureReason = f.FailureReason,
                pixelFormat = f.PixelFormat,
            }),
        });
    }

    private string CmdChoriziteDecodeTextureChainChunk(System.Text.Json.Nodes.JsonNode node) {
        uint startId = ParseUIntField(node, "startId");
        uint endId = ParseUIntField(node, "endId");
        string? datPath = node["datPath"]?.GetValue<string>();
        string? cacheRoot = node["cacheRoot"]?.GetValue<string>();
        bool fastMode = node["fastMode"]?.GetValue<bool>() ?? false;
        bool emitPng = node["emitPng"]?.GetValue<bool>() ?? false;
        var r = _engine.ChoriziteDecodeTextureChainChunk(startId, endId, datPath, cacheRoot, fastMode, emitPng);
        return Serialize(new {
            success = r.FailCount == 0,
            command = "chorizite-decode-texture-chain-chunk",
            chunkLabel = r.ChunkLabel,
            startId = $"0x{r.StartId:X8}",
            endId = $"0x{r.EndId:X8}",
            datPath = r.DatPath,
            datSha256 = r.DatSha256,
            cacheRoot = r.CacheRoot,
            progressJsonPath = r.ProgressJsonPath,
            recordCount = r.RecordCount,
            passCount = r.PassCount,
            failCount = r.FailCount,
            cachedCount = r.CachedCount,
            source = r.Source,
            failures = r.Failures.Select(f => new {
                idHex = f.IdHex,
                status = f.Status,
                failureReason = f.FailureReason,
                pixelFormat = f.PixelFormat,
            }),
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Wave-4.E sweep orchestrator — see CommandEngine.Wave4.cs
    // ─────────────────────────────────────────────────────────────────

    private string CmdWave4Status() {
        try {
            var r = _engine.Wave4Status();
            return Serialize(new {
                success = true,
                command = "wave4-status",
                cacheRoot = r.CacheRoot,
                chunkCount = r.ChunkCount,
                completedChunks = r.CompletedChunks,
                inFlightChunks = r.InFlightChunks,
                unreadableChunks = r.UnreadableChunks,
                failedChunks = r.FailedChunks,
                cacheHitCount = r.CacheHitCount,
                cacheMissCount = r.CacheMissCount,
                lastFailureChunkLabel = r.LastFailureChunkLabel,
                lastFailureMessage = r.LastFailureMessage,
                lastSweepStartUtc = r.LastSweepStartUtc,
                lastSweepFinishUtc = r.LastSweepFinishUtc,
                lastSweepReportPath = r.LastSweepReportPath,
            });
        } catch (Exception ex) {
            return Serialize(new {
                success = false,
                command = "wave4-status",
                error = ex.Message,
            });
        }
    }

    private string CmdWave4Sweep(System.Text.Json.Nodes.JsonNode node) {
        string? mode = node["mode"]?.GetValue<string>();
        string? target = node["target"]?.GetValue<string>();
        int concurrency = node["concurrency"]?.GetValue<int>() ?? 4;
        bool reset = node["reset"]?.GetValue<bool>() ?? false;
        var r = _engine.Wave4Sweep(mode, target, concurrency, reset);
        return Serialize(new {
            success = string.IsNullOrEmpty(r.DriverError) && r.ExitCode == 0
                && r.FailedChunks == 0 && r.InfraChunks == 0,
            command = "wave4-sweep",
            sweepReportJsonPath = r.SweepReportJsonPath,
            summaryMarkdownPath = r.SummaryMarkdownPath,
            exitCode = r.ExitCode,
            elapsedMs = r.ElapsedMs,
            driverError = r.DriverError,
            summary = new {
                chunkCount = r.ChunkCount,
                passed = r.PassedChunks,
                failed = r.FailedChunks,
                infra = r.InfraChunks,
                cached = r.CachedChunks,
            },
        });
    }

}
