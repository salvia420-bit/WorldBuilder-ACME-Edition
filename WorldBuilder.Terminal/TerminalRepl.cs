using System.Globalization;
using System.Numerics;
using System.Text;
using WorldBuilder.Shared.Lib.Dungeon;
using WorldBuilder.Shared.Lib.Validation;
using WorldBuilder.Shared.Lib.WorldGen;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Terminal;

/// <summary>
/// Interactive REPL for WorldBuilder.Terminal.
/// Handles user input parsing and console output formatting.
/// All business logic is delegated to <see cref="CommandEngine"/>.
/// </summary>
public class TerminalRepl {
    private readonly CommandEngine _engine;
    private readonly JsonCommandProcessor _jsonProcessor;
    private readonly Dictionary<string, Action<string[]>> _commandHandlers;

    public TerminalRepl(HeadlessProjectManager projectManager,
        ITerrainService terrainService,
        IObjectPlacementService objectPlacementService,
        IDungeonService dungeonService,
        IOntologyService ontologyService,
        IStampService stampService,
        int transactDiffRetention = 32,
        int transactDiffMemCapMb = 256) {
        _engine = new CommandEngine(projectManager, terrainService, objectPlacementService, dungeonService, ontologyService, stampService);
        // Used solely so the REPL `transact` command can re-enter the JSON dispatch
        // surface. Both processors share the same projectManager → same DocumentManager
        // → same singleton document instances, so mutations land in one place.
        _jsonProcessor = new JsonCommandProcessor(projectManager, terrainService, objectPlacementService, dungeonService, ontologyService, stampService,
            transactDiffRetention, transactDiffMemCapMb);
        _commandHandlers = BuildCommandHandlers();
    }

    /// <summary>
    /// Pre-load a project through the same path the REPL `load` command uses, so the
    /// CLI `--project` flag exercises every auto-loader in <see cref="CommandEngine.Load"/>
    /// instead of going around it via <c>HeadlessProjectManager.LoadProject</c>.
    /// </summary>
    public LoadResult Preload(string projectPath) => _engine.Load(projectPath);

    /// <summary>
    /// Runs the REPL loop until the user types quit/exit or presses Ctrl+C.
    /// </summary>
    public void Run() {
        PrintBanner();
        Console.WriteLine("Type 'help' for available commands.\n");

        while (true) {
            Console.Write("wb> ");
            var line = Console.ReadLine();

            if (line == null) break; // EOF / Ctrl+C
            var trimmed = line.Trim();
            if (string.IsNullOrEmpty(trimmed)) continue;

            var tokens = TokenizeLine(trimmed);
            var command = tokens[0];

            try {
                if (command.Equals("quit", StringComparison.OrdinalIgnoreCase) ||
                    command.Equals("exit", StringComparison.OrdinalIgnoreCase)) {
                    Console.WriteLine("Goodbye!");
                    return;
                }

                if (_commandHandlers.TryGetValue(command, out var handler)) {
                    handler(tokens);
                } else {
                    Console.WriteLine($"Unknown command: '{command}'. Type 'help' for available commands.");
                }
            } catch (Exception ex) {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"Error: {ex.Message}");
                Console.ResetColor();
            }
        }
    }

    private Dictionary<string, Action<string[]>> BuildCommandHandlers() =>
        new(StringComparer.OrdinalIgnoreCase) {
            ["load"] = HandleLoad,
            ["export"] = HandleExport,
            ["info"] = _ => HandleInfo(),
            ["smooth"] = HandleSmooth,
            ["raise"] = HandleRaise,
            ["lower"] = HandleLower,
            ["set-height"] = HandleSetHeight,
            ["paint"] = HandlePaint,
            ["fill"] = HandleFill,
            ["road"] = HandleRoad,
            ["get-height"] = HandleGetHeight,
            ["terrain-info"] = HandleTerrainInfo,
            ["get-heightmap"] = HandleGetHeightmap,
            ["get-terrain-data"] = HandleGetTerrainData,
            ["terrain"] = HandleTerrain,
            ["list-objects"] = HandleListObjects,
            ["describe-landblock"] = HandleDescribeLandblock,
            ["add-object"] = HandleAddObject,
            ["remove-object"] = HandleRemoveObject,
            ["clear-objects"] = HandleClearObjects,
            ["move-object"] = HandleMoveObject,
            ["rotate-object"] = HandleRotateObject,
            ["query-radius"] = HandleQueryRadius,
            ["analyze-dungeons"] = HandleAnalyzeDungeons,
            ["analyze-dungeon-catalog"] = HandleAnalyzeDungeonCatalog,
            ["analyze-dungeon-topology"] = HandleAnalyzeDungeonTopology,
            ["get-dungeon-info"] = HandleGetDungeonInfo,
            ["validate-dungeon"] = HandleValidateDungeon,
            ["validate-landblock"] = HandleValidateLandblock,
            ["validate-terrain"] = HandleValidateTerrain,
            ["validate-building-shells"] = HandleValidateBuildingShells,
            ["validate-building-portals"] = HandleValidateBuildingPortals,
            ["validate-all"] = HandleValidateAll,
            ["list-landblocks"] = HandleListLandblocks,
            ["get-world-info"] = _ => HandleGetWorldInfo(),
            ["get-region"] = _ => HandleGetRegion(),
            ["scan-ontology"] = HandleScanOntology,
            ["query-ontology"] = HandleQueryOntology,
            ["ontology-stats"] = _ => HandleOntologyStats(),
            ["paste-stamp"] = HandlePasteStamp,
            ["snap-portal"] = HandleSnapPortal,
            ["get-bulk-heightmap"] = HandleGetBulkHeightmap,
            ["get-object-detail"] = HandleGetObjectDetail,
            ["diff-terrain"] = HandleDiffTerrain,
            ["get-terrain-layers"] = HandleGetTerrainLayers,
            ["get-terrain-textures"] = _ => HandleGetTerrainTextures(),
            ["export-textures"] = HandleExportTextures,
            ["import-texture"] = HandleImportTexture,
            ["clone-dat"] = HandleCloneDat,
            ["defragment-dat"] = HandleDefragmentDat,
            ["export-ontology"] = HandleExportOntology,
            ["export-setup-parts"] = HandleExportSetupParts,
            ["export-classification-signals"] = HandleExportClassificationSignals,
            ["mine-strings"] = HandleMineStrings,
            ["enrich-ontology"] = _ => HandleEnrichOntology(),
            ["import-catalog"] = HandleImportCatalog,
            ["classify-ontology"] = _ => HandleClassifyOntology(),
            ["enrich-materials"] = _ => HandleEnrichMaterials(),
            ["ingest-weenies"] = HandleIngestWeenies,
            ["enrich-weenies"] = HandleEnrichWeenies,
            ["enrich-canonical"] = HandleEnrichCanonical,
            ["enrich-unified"] = HandleEnrichUnified,
            ["cache-ontology"] = HandleCacheOntology,
            ["load-ontology-cache"] = HandleLoadOntologyCache,
            ["scan-building-placements"] = HandleScanBuildingPlacements,
            ["difficulty-gradient"] = HandleDifficultyGradient,
            ["apply-population"] = HandleApplyPopulation,
            ["ingest-spawn-maps"] = HandleIngestSpawnMaps,
            ["ingest-spells"] = HandleIngestSpells,
            ["ingest-recipes"] = HandleIngestRecipes,
            ["benchmark"] = _ => HandleBenchmark(),
            ["set-landblock-heightmap"] = HandleSetLandblockHeightmap,
            ["set-landblock-terrain"] = HandleSetLandblockTerrain,
            ["import-heightmap"] = HandleImportHeightmap,
            ["import-render-surface"] = HandleImportRenderSurface,
            ["creature"] = HandleCreature,
            ["layout"] = HandleLayout,
            ["spell"] = HandleSpell,
            ["weenie"] = HandleWeenie,
            ["placement"] = HandlePlacement,
            ["surface-materials"] = HandleSurfaceMaterials,
            ["fresh-start"] = HandleFreshStart,
            ["generate-world"] = HandleGenerateWorld,
            ["export-towns-csv"] = HandleExportTownsCsv,
            ["bulk-place-objects"] = HandleBulkPlaceObjects,
            ["generate-terrain"] = HandleGenerateTerrain,
            ["generate-dungeon"] = HandleGenerateDungeon,
            ["auto-paint"] = _ => HandleAutoPaint(),
            ["analyze-landblock-patterns"] = HandleAnalyzeLandblockPatterns,
            ["extract-building-pairings"] = HandleExtractBuildingPairings,
            ["load-building-pairings"] = HandleLoadBuildingPairings,
            ["export-training-data"] = HandleExportTrainingData,
            ["export-raw-world-facts"] = HandleExportRawWorldFacts,
            ["export-envcell-components"] = HandleExportEnvCellComponents,
            ["generate-settlement"] = HandleGenerateSettlement,
            ["extract-retail-heightmaps"] = HandleExtractRetailHeightmaps,
            ["compute-vanilla-baseline"] = HandleComputeVanillaBaseline,
            ["analyze-map-image"] = HandleAnalyzeMapImage,
            ["calibrate-world-map"] = HandleCalibrateWorldMap,
            ["quick-world"] = HandleQuickWorld,
            ["remap-buildings"] = HandleRemapBuildings,
            ["remap-buildings-v2"] = HandleRemapBuildingsV2,
            ["remap-buildings-sql"] = HandleRemapBuildingsSql,
            ["ace-db"] = HandleAceDb,
            ["ace-shard-db"] = HandleAceShardDb,
            ["dungeon"] = HandleDungeon,
            ["obj-export"] = HandleObjExport,
            ["obj-import"] = HandleObjImport,
            ["bsp-build"] = HandleBspBuild,
            ["weenie-snapshot"] = HandleWeenieSnapshot,
            ["weenie-template-list"] = HandleWeenieTemplateList,
            ["weenie-template-apply"] = HandleWeenieTemplateApply,
            ["worldgen"] = HandleWorldGen,
            ["worldgen-analyze-buildings"] = HandleWorldGenAnalyzeBuildings,
            ["worldgen-scan-retail-towns"] = HandleWorldGenScanRetailTowns,
            ["render-preview"] = HandleRenderPreview,
            ["compare-to-retail"] = HandleCompareToRetail,
            ["compare-creatures-to-retail"] = _ => HandleCompareCreaturesToRetail(),
            ["transact"] = HandleTransact,
            ["transact-diff"] = HandleTransactDiff,
            ["get-tile"] = HandleGetTile,
            ["tile-stats"] = _ => HandleTileStats(),
            ["regenerate-dirty-tiles"] = _ => HandleRegenerateDirtyTiles(),
            ["list-dirty-tiles"] = _ => HandleListDirtyTiles(),
            ["mark-tiles-clean"] = _ => HandleMarkTilesClean(),
            ["prune-tiles"] = HandlePruneTiles,
            ["generate-atlas-tiles"] = HandleGenerateAtlasTiles,
            ["emit-render-gallery"] = HandleEmitRenderGallery,
            ["serve-render-gallery"] = HandleServeRenderGallery,
            ["help"] = _ => PrintHelp(),
        };

    private void HandleRenderPreview(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: render-preview <lbX> <lbY> [radius] [resolution] [--no-overlay] [--use-sprites] [--out <path>]");
            Console.WriteLine("  Examples:");
            Console.WriteLine("    render-preview 169 180                         # single LB (Holtburg) @1024");
            Console.WriteLine("    render-preview 169 180 2 1536                  # 5x5 grid @ 1536");
            Console.WriteLine("    render-preview 169 180 0 1024 --out hb.png");
            Console.WriteLine("    render-preview 169 180 0 2048 --use-sprites    # blit DAT sprites (atlas required)");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;

        int radius = 0;
        int resolution = 1024;
        bool overlay = true;
        bool useSprites = false;
        string? outPath = null;

        // Optional positional radius + resolution.
        int posIdx = 3;
        if (tokens.Length > posIdx && !tokens[posIdx].StartsWith("--") &&
            int.TryParse(tokens[posIdx], out var r)) { radius = r; posIdx++; }
        if (tokens.Length > posIdx && !tokens[posIdx].StartsWith("--") &&
            int.TryParse(tokens[posIdx], out var rs)) { resolution = rs; posIdx++; }

        for (int i = posIdx; i < tokens.Length; i++) {
            if (tokens[i] == "--no-overlay") overlay = false;
            else if (tokens[i] == "--overlay") overlay = true;
            else if (tokens[i] == "--use-sprites") useSprites = true;
            else if (tokens[i] == "--out" && i + 1 < tokens.Length) {
                outPath = tokens[++i];
            } else {
                Console.WriteLine($"Unknown flag: {tokens[i]}");
                return;
            }
        }

        // Default to a project-relative path if --out not specified.
        outPath ??= Path.Combine(Environment.CurrentDirectory,
            $"render_{lbX:X2}{lbY:X2}_r{radius}.png");

        var result = _engine.RenderPreview(lbX, lbY, radius, resolution, overlay, outPath, useSprites);
        Console.WriteLine();
        Console.WriteLine($"  Rendered 0x{result.CenterLbKey:X4} ({lbX},{lbY}) radius={result.Radius} → {result.Resolution}×{result.Resolution} px");
        Console.WriteLine($"  Landblocks  : {result.LandblockCount} populated of {(2*result.Radius+1)*(2*result.Radius+1)}");
        Console.WriteLine($"  Objects     : {result.ObjectCount}");
        Console.WriteLine($"  Cliffs      : {result.CliffCount} (overlay {(result.OverlayApplied ? "ON" : "OFF")})");
        Console.WriteLine($"  PNG size    : {result.PngBytes.Length / 1024.0:F1} KB");
        if (result.OutputPath != null) Console.WriteLine($"  Wrote       : {result.OutputPath}");
        Console.WriteLine();
    }

    // ═════════════════════════════════════════════════════════
    //  Living Atlas — tile pyramid (lb / region / world zooms)
    // ═════════════════════════════════════════════════════════

    private void HandleGetTile(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: get-tile <lb|region|world> [args] [--out <path>]");
            Console.WriteLine("  get-tile lb <lbX> <lbY>");
            Console.WriteLine("  get-tile region <region-name>     (e.g. \"Aluvian Heartlands\")");
            Console.WriteLine("  get-tile world");
            return;
        }
        string zoom = tokens[1].ToLowerInvariant();
        string? outPath = null;
        for (int i = 2; i < tokens.Length; i++) {
            if (tokens[i] == "--out" && i + 1 < tokens.Length) { outPath = tokens[++i]; }
        }

        WorldBuilder.Terminal.TileEntry entry;
        try {
            if (zoom == "lb") {
                if (tokens.Length < 4) { Console.WriteLine("Usage: get-tile lb <lbX> <lbY>"); return; }
                if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
                if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
                entry = _engine.GetLbTile(lbX, lbY);
            } else if (zoom == "region") {
                if (tokens.Length < 3) { Console.WriteLine("Usage: get-tile region <region-name>"); return; }
                entry = _engine.GetRegionTile(tokens[2]);
            } else if (zoom == "world") {
                entry = _engine.GetWorldTile();
            } else {
                Console.WriteLine($"Unknown zoom '{zoom}'; expected 'lb', 'region', or 'world'.");
                return;
            }
        } catch (Exception ex) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  get-tile failed: {ex.Message}");
            Console.ResetColor();
            return;
        }

        Console.WriteLine();
        Console.WriteLine($"  Tile        : {entry.Key}  ({zoom} zoom)");
        Console.WriteLine($"  Path        : {entry.Path}");
        Console.WriteLine($"  Size        : {entry.SizeBytes / 1024.0:F1} KB");
        Console.WriteLine($"  Generated   : {entry.GeneratedAt:O}");
        if (outPath != null) {
            var srcAbs = Path.Combine(_engine.TileCachePathOrEmpty(), entry.Path);
            File.Copy(srcAbs, outPath, overwrite: true);
            Console.WriteLine($"  Wrote       : {outPath}");
        }
        Console.WriteLine();
    }

    private void HandleTileStats() {
        if (!CheckProject()) return;
        var s = _engine.GetTileStats();
        long budget = Math.Max(1, s.BytesBudget);
        double percent = 100.0 * s.BytesUsed / budget;
        Console.WriteLine();
        Console.WriteLine($"  Tiles       : total={s.TotalCount}  lb={s.LbCount}  region={s.RegionCount}  world={s.WorldCount}");
        Console.WriteLine($"  Dirty       : tiles={s.DirtyTileCount}  lbs={s.DirtyLbCount}");
        Console.WriteLine($"  Disk        : {s.BytesUsed / (1024.0 * 1024):F1} MB / {s.BytesBudget / (1024.0 * 1024):F0} MB ({percent:F1}%)");
        Console.WriteLine();
    }

    private void HandleRegenerateDirtyTiles() {
        if (!CheckProject()) return;
        var (n, bytes, errors) = _engine.RegenerateDirtyTiles();
        Console.WriteLine();
        Console.WriteLine($"  Regenerated : {n} tile(s), {bytes / 1024.0:F1} KB written");
        if (errors.Count > 0) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"  Errors      : {errors.Count}");
            foreach (var e in errors.Take(10)) Console.WriteLine($"    • {e}");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    private void HandleListDirtyTiles() {
        if (!CheckProject()) return;
        var dirty = _engine.ListDirtyTiles();
        Console.WriteLine();
        if (dirty.Count == 0) { Console.WriteLine("  No dirty tiles."); Console.WriteLine(); return; }
        Console.WriteLine($"  Dirty landblocks ({dirty.Count}):");
        foreach (var d in dirty.Take(50)) {
            uint lbX = (uint)((d.lbKey >> 8) & 0xFF), lbY = (uint)(d.lbKey & 0xFF);
            Console.WriteLine($"    0x{d.hex}  ({lbX}, {lbY})");
        }
        if (dirty.Count > 50) Console.WriteLine($"    … +{dirty.Count - 50} more");
        Console.WriteLine();
    }

    private void HandleMarkTilesClean() {
        if (!CheckProject()) return;
        _engine.MarkTilesClean();
        Console.WriteLine("  All tiles marked clean.");
    }

    private void HandlePruneTiles(string[] tokens) {
        if (!CheckProject()) return;
        int? keepNewest = null;
        DateTime? olderThan = null;
        for (int i = 1; i < tokens.Length; i++) {
            if (tokens[i] == "--keep-newest" && i + 1 < tokens.Length) {
                if (!int.TryParse(tokens[++i], out int k)) {
                    Console.WriteLine($"Invalid --keep-newest value: {tokens[i]}"); return;
                }
                keepNewest = k;
            } else if (tokens[i] == "--older-than" && i + 1 < tokens.Length) {
                if (!DateTime.TryParse(tokens[++i], null, DateTimeStyles.RoundtripKind, out DateTime dt)) {
                    Console.WriteLine($"Invalid --older-than timestamp (expect ISO 8601): {tokens[i]}"); return;
                }
                olderThan = dt;
            } else {
                Console.WriteLine("Usage: prune-tiles [--keep-newest N] [--older-than ISO8601]");
                return;
            }
        }
        var r = _engine.PruneTiles(keepNewest, olderThan);
        Console.WriteLine();
        Console.WriteLine($"  Evicted     : {r.Evicted} tile(s), {r.BytesFreed / 1024.0:F1} KB freed");
        Console.WriteLine($"  Remaining   : {r.RemainingCount} tile(s), {r.RemainingBytes / (1024.0 * 1024):F1} MB");
        Console.WriteLine();
    }

    private void HandleGenerateAtlasTiles(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: generate-atlas-tiles <lbs|regions|world|all> [<lbX> <lbY> ...]");
            Console.WriteLine("  lbs:     specify LBs as space-separated lbX lbY pairs");
            Console.WriteLine("  regions: regenerates every known region tile");
            Console.WriteLine("  world:   single composite world tile");
            Console.WriteLine("  all:     world + every region + sweep all 255x255 LB tiles (slow!)");
            return;
        }
        string mode = tokens[1].ToLowerInvariant();
        if (mode != "lbs" && mode != "regions" && mode != "world" && mode != "all") {
            Console.WriteLine($"Unknown mode '{mode}'; expected 'lbs', 'regions', 'world', or 'all'.");
            return;
        }
        int generated = 0, skipped = 0;
        long bytes = 0;
        var errors = new List<string>();

        if (mode == "world" || mode == "all") {
            try { var w = _engine.GetWorldTile(); generated++; bytes += w.SizeBytes; }
            catch (Exception ex) { errors.Add($"world: {ex.Message}"); }
        }
        if (mode == "regions" || mode == "all") {
            foreach (var r in _engine.ListRegionNames()) {
                try { var t = _engine.GetRegionTile(r); generated++; bytes += t.SizeBytes; }
                catch (Exception ex) { errors.Add($"region {r}: {ex.Message}"); }
            }
        }
        if (mode == "lbs" || mode == "all") {
            List<(uint, uint)> lbs;
            if (mode == "lbs") {
                if ((tokens.Length - 2) < 2 || (tokens.Length - 2) % 2 != 0) {
                    Console.WriteLine("mode=lbs requires lbX lbY pair(s) after the mode."); return;
                }
                lbs = new List<(uint, uint)>();
                for (int i = 2; i < tokens.Length; i += 2) {
                    if (!TryParseUint(tokens[i], "lbX", out uint x)) return;
                    if (!TryParseUint(tokens[i + 1], "lbY", out uint y)) return;
                    lbs.Add((x, y));
                }
            } else {
                lbs = new List<(uint, uint)>(255 * 255);
                for (uint x = 0; x < 255; x++) for (uint y = 0; y < 255; y++) lbs.Add((x, y));
            }
            var (g, s, b, e) = _engine.GenerateBulkLbTiles(lbs);
            generated += g; skipped += s; bytes += b; errors.AddRange(e);
        }

        Console.WriteLine();
        Console.WriteLine($"  Mode        : {mode}");
        Console.WriteLine($"  Generated   : {generated} tile(s){(skipped > 0 ? $", {skipped} skipped" : "")}");
        Console.WriteLine($"  Disk        : {bytes / (1024.0 * 1024):F1} MB written");
        if (errors.Count > 0) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"  Errors      : {errors.Count}");
            foreach (var e in errors.Take(10)) Console.WriteLine($"    • {e}");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    //â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Project management
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    // ═════════════════════════════════════════════════════════
    //  Render Gallery — wirerender wave (2026-05-XX)
    // ═════════════════════════════════════════════════════════

    private void HandleEmitRenderGallery(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: emit-render-gallery <outDir> [--towns N] [--zones N] [--dungeons N] [--regions N] [--radius N] [--res N] [--no-sprites] [--no-overlay]");
            Console.WriteLine("  Examples:");
            Console.WriteLine("    emit-render-gallery /tmp/dereth-gallery");
            Console.WriteLine("    emit-render-gallery ./gallery --towns 10 --zones 10 --dungeons 0 --regions 0");
            Console.WriteLine("    emit-render-gallery ./gallery --radius 0 --res 1024 --no-sprites");
            return;
        }
        string outDir = tokens[1];
        int towns = 5, zones = 5, dungeons = 5, regions = 5;
        int radius = 1, resolution = 1536;
        bool useSprites = true, overlay = true;
        for (int i = 2; i < tokens.Length; i++) {
            switch (tokens[i]) {
                case "--towns": if (i + 1 < tokens.Length && int.TryParse(tokens[++i], out var t)) towns = t; break;
                case "--zones": if (i + 1 < tokens.Length && int.TryParse(tokens[++i], out var z)) zones = z; break;
                case "--dungeons": if (i + 1 < tokens.Length && int.TryParse(tokens[++i], out var d)) dungeons = d; break;
                case "--regions": if (i + 1 < tokens.Length && int.TryParse(tokens[++i], out var rg)) regions = rg; break;
                case "--radius": if (i + 1 < tokens.Length && int.TryParse(tokens[++i], out var r)) radius = r; break;
                case "--res": if (i + 1 < tokens.Length && int.TryParse(tokens[++i], out var rs)) resolution = rs; break;
                case "--no-sprites": useSprites = false; break;
                case "--no-overlay": overlay = false; break;
                default: Console.WriteLine($"Unknown flag: {tokens[i]}"); return;
            }
        }
        var r2 = _engine.EmitRenderGallery(outDir, null, towns, zones, dungeons, regions,
            radius, resolution, useSprites, overlay);
        Console.WriteLine();
        if (!r2.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  Failed: {r2.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine($"  Picks rendered : {r2.PicksRendered}");
        Console.WriteLine($"  LBs covered    : {r2.LbsCovered}");
        Console.WriteLine($"  Total spawns   : {r2.TotalSpawnCount}");
        Console.WriteLine($"  Out dir        : {r2.OutDir}");
        Console.WriteLine($"  Index          : {r2.IndexPath}");
        Console.WriteLine($"  Manifest       : {r2.ManifestPath}");
        Console.WriteLine();
        Console.WriteLine($"  Open in browser: file://{Path.GetFullPath(r2.IndexPath)}");
        Console.WriteLine($"  Or serve       : serve-render-gallery {r2.OutDir}");
        Console.WriteLine();
    }

    private void HandleServeRenderGallery(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: serve-render-gallery <outDir> [--port N] [--bind addr]");
            Console.WriteLine("  Examples:");
            Console.WriteLine("    serve-render-gallery /tmp/dereth-gallery");
            Console.WriteLine("    serve-render-gallery ./gallery --port 8091");
            return;
        }
        string outDir = tokens[1];
        int port = 8090;
        string bind = "0.0.0.0";
        for (int i = 2; i < tokens.Length; i++) {
            switch (tokens[i]) {
                case "--port": if (i + 1 < tokens.Length && int.TryParse(tokens[++i], out var p)) port = p; break;
                case "--bind": if (i + 1 < tokens.Length) bind = tokens[++i]; break;
                default: Console.WriteLine($"Unknown flag: {tokens[i]}"); return;
            }
        }
        var sr = _engine.ServeRenderGallery(outDir, port, bind);
        Console.WriteLine();
        if (!sr.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  Failed: {sr.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine($"  Serving        : {sr.OutDir}");
        Console.WriteLine($"  Local          : {sr.Url}");
        if (sr.TailscaleUrl != null) {
            Console.WriteLine($"  Tailscale      : {sr.TailscaleUrl}");
        } else {
            Console.WriteLine("  Tailscale      : (none — host has no 100.64.0.0/10 IP)");
        }
        Console.WriteLine($"  Bind           : {sr.Bind}:{sr.Port}");
        Console.WriteLine($"  Pid            : {sr.Pid} (server runs in background until terminal exits)");
        Console.WriteLine();
    }

    private void HandleLoad(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: load <path-to-.wbproj>");
            Console.WriteLine("  Example: load \"C:\\Projects\\My World\\demo.wbproj\"");
            return;
        }
        Console.WriteLine($"Loading project: {tokens[1]}");
        var r = _engine.Load(tokens[1]);
        Console.WriteLine($"Project '{r.ProjectName}' loaded successfully.");
        PrintAutoRestoreReport(r.AutoRestore);
    }

    private static void PrintAutoRestoreReport(LoadAutoRestoreReport ar) {
        PrintAutoRestoreLine("Ontology",       ar.Ontology,       countLabel: "entries");
        PrintAutoRestoreLine("Pairings",       ar.Pairings,       countLabel: "edges");
        PrintAutoRestoreLine("TownGazetteer",  ar.TownGazetteer,  countLabel: "towns");
        PrintAutoRestoreLine("PoiGazetteer",   ar.PoiGazetteer,   countLabel: "landblocks");
        PrintAutoRestoreLine("WcidAcpedia",    ar.WcidAcpedia,    countLabel: "wcids");
        PrintAutoRestoreLine("SpawnGazetteer", ar.SpawnGazetteer, countLabel: "landblocks");
        PrintAutoRestoreLine("Regions",        ar.Regions,        countLabel: "regions");
        PrintAutoRestoreLine("WeenieIndex",    ar.WeenieIndex,    countLabel: "weenies");
    }

    private static void PrintAutoRestoreLine(string label, LoadAutoRestoreEntry e, string countLabel) {
        if (!e.FilePresent) return;
        if (e.Loaded) {
            Console.WriteLine($"  [{label}] Auto-loaded {e.Count:N0} {countLabel}");
        } else {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"  [{label}] Auto-load failed: {e.Error}");
            Console.ResetColor();
        }
    }

    private void HandleExport(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: export <output-directory> [iteration] [--reposition]");
            Console.WriteLine("  Example: export \"C:\\Output\" 5");
            Console.WriteLine("  --reposition  After export, reposition DB instances to match new terrain");
            return;
        }

        bool reposition = false;
        var argTokens = new List<string>(tokens.Length);
        foreach (var token in tokens) {
            if (token.StartsWith("--", StringComparison.Ordinal)) {
                if (token.Equals("--reposition", StringComparison.OrdinalIgnoreCase)) {
                    reposition = true;
                }
                continue;
            }
            argTokens.Add(token);
        }

        int? iteration = null;
        if (argTokens.Count >= 3) {
            if (!TryParseInt(argTokens[2], "iteration", out var iter)) return;
            iteration = iter;
        }

        string dir = argTokens[1];
        Console.WriteLine($"Exporting to: {dir}");

        if (reposition) {
            Console.WriteLine("  â†’ Reposition mode: will update DB instances after export");
            var r = _engine.ExportWithRepositionAsync(dir, iteration).GetAwaiter().GetResult();
            Console.WriteLine();
            if (r.ExportSuccess) {
                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine("  âœ“ DAT export completed successfully.");
                Console.ResetColor();
            } else {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("  âœ— DAT export failed.");
                Console.ResetColor();
                Console.WriteLine();
                return;
            }

            if (r.RepositionAttempted) {
                if (r.RepositionSuccess) {
                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.WriteLine($"  âœ“ Reposition: {r.InstancesUpdated}/{r.InstancesChecked} instances updated across {r.LandblocksProcessed} landblocks");
                    Console.ResetColor();
                } else {
                    Console.ForegroundColor = ConsoleColor.Yellow;
                    Console.WriteLine($"  âš  Reposition note: {r.RepositionError}");
                    Console.ResetColor();
                }
            } else {
                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.WriteLine($"  â„¹ Reposition skipped: {r.RepositionError}");
                Console.ResetColor();
            }
        } else {
            var r = _engine.Export(dir, iteration);
            Console.WriteLine(r.Success ? "Export completed successfully." : "Export failed.");
        }
        Console.WriteLine();
    }

    private void HandleInfo() {
        var r = _engine.GetInfo();
        if (!r.Loaded) { Console.WriteLine("No project loaded."); return; }
        Console.WriteLine();
        Console.WriteLine($"  Project Name  : {r.ProjectName}");
        Console.WriteLine($"  Project File  : {r.ProjectFile}");
        Console.WriteLine($"  Project Dir   : {r.ProjectDir}");
        Console.WriteLine($"  DAT Directory : {r.DatDirectory}");
        Console.WriteLine($"  Database      : {r.DatabasePath}");
        Console.WriteLine($"  Portal Iter   : {r.PortalIteration?.ToString() ?? "(unavailable)"}");
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Terrain editing
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleSmooth(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: smooth <x> <y> <radius> [strength]");
            Console.WriteLine("  strength â€” blend strength 0.0-1.0 (default: 0.5)");
            Console.WriteLine("  Example: smooth 12000 12000 5 0.7");
            return;
        }
        if (!TryParseFloat(tokens[1], "x", out float x)) return;
        if (!TryParseFloat(tokens[2], "y", out float y)) return;
        if (!TryParseFloat(tokens[3], "radius", out float radius)) return;
        float strength = 0.5f;
        if (tokens.Length >= 5 && !TryParseFloat(tokens[4], "strength", out strength)) return;
        var r = _engine.Smooth(x, y, radius, strength);
        if (r.VerticesModified == 0) { Console.WriteLine("No terrain changes (area may be uniform already)."); return; }
        PrintLandblockChanges(r.ModifiedLandblocks);
        Console.WriteLine($"Smoothed {r.VerticesModified} vertices at ({x}, {y}) radius={radius} strength={strength}");
    }

    private void HandleRaise(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: raise <x> <y> <radius> [delta]");
            Console.WriteLine("  delta â€” height units to raise by (default: 5)");
            Console.WriteLine("  Example: raise 12000 12000 3 10");
            return;
        }
        if (!TryParseFloat(tokens[1], "x", out float x)) return;
        if (!TryParseFloat(tokens[2], "y", out float y)) return;
        if (!TryParseFloat(tokens[3], "radius", out float radius)) return;
        int delta = 5;
        if (tokens.Length >= 5 && !TryParseInt(tokens[4], "delta", out delta)) return;
        var r = _engine.Raise(x, y, radius, delta);
        if (r.VerticesModified == 0) { Console.WriteLine("No terrain changes (already at maximum height)."); return; }
        PrintLandblockChanges(r.ModifiedLandblocks);
        Console.WriteLine($"Raised {r.VerticesModified} vertices by {delta} at ({x}, {y}) radius={radius}");
    }

    private void HandleLower(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: lower <x> <y> <radius> [delta]");
            Console.WriteLine("  delta â€” height units to lower by (default: 5)");
            Console.WriteLine("  Example: lower 12000 12000 3 10");
            return;
        }
        if (!TryParseFloat(tokens[1], "x", out float x)) return;
        if (!TryParseFloat(tokens[2], "y", out float y)) return;
        if (!TryParseFloat(tokens[3], "radius", out float radius)) return;
        int delta = 5;
        if (tokens.Length >= 5 && !TryParseInt(tokens[4], "delta", out delta)) return;
        var r = _engine.Lower(x, y, radius, delta);
        if (r.VerticesModified == 0) { Console.WriteLine("No terrain changes (already at minimum height)."); return; }
        PrintLandblockChanges(r.ModifiedLandblocks);
        Console.WriteLine($"Lowered {r.VerticesModified} vertices by {delta} at ({x}, {y}) radius={radius}");
    }

    private void HandleSetHeight(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 5) {
            Console.WriteLine("Usage: set-height <x> <y> <radius> <height>");
            Console.WriteLine("  height â€” target height index 0-255");
            Console.WriteLine("  Example: set-height 12000 12000 5 128");
            return;
        }
        if (!TryParseFloat(tokens[1], "x", out float x)) return;
        if (!TryParseFloat(tokens[2], "y", out float y)) return;
        if (!TryParseFloat(tokens[3], "radius", out float radius)) return;
        if (!TryParseByte(tokens[4], "height", out byte targetHeight)) return;
        var r = _engine.SetHeight(x, y, radius, targetHeight);
        if (r.VerticesModified == 0) { Console.WriteLine("No terrain changes (already at target height)."); return; }
        PrintLandblockChanges(r.ModifiedLandblocks);
        Console.WriteLine($"Set {r.VerticesModified} vertices to height={targetHeight} at ({x}, {y}) radius={radius}");
    }

    private void HandlePaint(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 5) {
            Console.WriteLine("Usage: paint <x> <y> <radius> <terrain-type>");
            Console.WriteLine("  terrain-type â€” numeric terrain type index (0-31)");
            Console.WriteLine("  Example: paint 12000 12000 3 4");
            Console.WriteLine();
            Console.WriteLine("  Common types: 0=Road, 1=Grass, 2=Rock, 3=Dirt, ...");
            return;
        }
        if (!TryParseFloat(tokens[1], "x", out float x)) return;
        if (!TryParseFloat(tokens[2], "y", out float y)) return;
        if (!TryParseFloat(tokens[3], "radius", out float radius)) return;
        if (!TryParseByte(tokens[4], "terrain-type", out byte terrainType)) return;
        var r = _engine.Paint(x, y, radius, terrainType);
        if (r.VerticesModified == 0) { Console.WriteLine("No terrain changes (already painted with that type)."); return; }
        Console.WriteLine($"Painted {r.VerticesModified} vertices with type={terrainType} at ({x}, {y}) radius={radius}");
        Console.WriteLine($"  Modified {r.ModifiedLandblocks.Count} landblock(s): {string.Join(", ", r.ModifiedLandblocks.Select(lb => $"0x{lb:X4}"))}");
    }

    private void HandleFill(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: fill <x> <y> <terrain-type>");
            Console.WriteLine("  Flood fills contiguous terrain starting at (x,y) with new type.");
            Console.WriteLine("  Example: fill 12000 12000 3");
            return;
        }
        if (!TryParseFloat(tokens[1], "x", out float x)) return;
        if (!TryParseFloat(tokens[2], "y", out float y)) return;
        if (!TryParseByte(tokens[3], "terrain-type", out byte newType)) return;
        var r = _engine.Fill(x, y, newType);
        if (r.VerticesModified == 0) { Console.WriteLine("No fill needed (same type or empty terrain)."); return; }
        Console.WriteLine($"Flood-filled {r.VerticesModified} vertices from ({x}, {y}) with type={newType}");
        Console.WriteLine($"  Modified {r.ModifiedLandblocks.Count} landblock(s)");
    }

    private void HandleRoad(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 5) {
            Console.WriteLine("Usage: road <x1> <y1> <x2> <y2> [road-value]");
            Console.WriteLine("  road-value â€” road byte value 1-255 (default: 1). 0 = erase road.");
            Console.WriteLine("  Example: road 12000 12000 12200 12100");
            return;
        }
        if (!TryParseFloat(tokens[1], "x1", out float x1)) return;
        if (!TryParseFloat(tokens[2], "y1", out float y1)) return;
        if (!TryParseFloat(tokens[3], "x2", out float x2)) return;
        if (!TryParseFloat(tokens[4], "y2", out float y2)) return;
        byte roadValue = 1;
        if (tokens.Length >= 6 && !TryParseByte(tokens[5], "road-value", out roadValue)) return;
        var r = _engine.DrawRoad(x1, y1, x2, y2, roadValue);
        if (r.VerticesModified == 0) { Console.WriteLine("No road changes needed."); return; }
        Console.WriteLine($"Drew road with {r.Waypoints} waypoints, {r.VerticesModified} vertex changes");
        Console.WriteLine($"  From ({x1}, {y1}) to ({x2}, {y2}), road value={r.RoadValue}");
        Console.WriteLine($"  Modified {r.ModifiedLandblocks.Count} landblock(s)");
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Terrain queries
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleGetHeight(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: get-height <x> <y>");
            Console.WriteLine("  Example: get-height 12000 12000");
            return;
        }
        if (!TryParseFloat(tokens[1], "x", out float x)) return;
        if (!TryParseFloat(tokens[2], "y", out float y)) return;
        var r = _engine.GetHeight(x, y);
        Console.WriteLine();
        Console.WriteLine($"  Position     : ({r.X}, {r.Y})");
        Console.WriteLine($"  Height       : {r.Height:F2} units");
        if (r.LandblockId.HasValue) Console.WriteLine($"  Landblock    : 0x{r.LandblockId:X4}");
        if (r.VertexIndex.HasValue) Console.WriteLine($"  Vertex index : {r.VertexIndex}");
        if (r.HeightIndex.HasValue) Console.WriteLine($"  Height index : {r.HeightIndex}");
        if (r.TerrainType.HasValue) Console.WriteLine($"  Terrain type : {r.TerrainType}");
        if (r.Road.HasValue) Console.WriteLine($"  Road         : {r.Road}");
        if (r.Scenery.HasValue) Console.WriteLine($"  Scenery      : {r.Scenery}");
        Console.WriteLine();
    }

    private void HandleTerrainInfo(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: terrain-info <lbX> <lbY>");
            Console.WriteLine("  Example: terrain-info 63 63");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        var r = _engine.GetTerrainInfo(lbX, lbY);
        if (!r.Found) { Console.WriteLine($"  No terrain data for landblock 0x{r.LbKey:X4}"); return; }
        Console.WriteLine();
        Console.WriteLine($"  Landblock    : 0x{r.LbKey:X4} ({lbX}, {lbY})");
        Console.WriteLine($"  World origin : ({lbX * 192}, {lbY * 192})");
        Console.WriteLine($"  Vertices     : {r.VertexCount}");
        Console.WriteLine($"  Height range : [{r.HeightMin}, {r.HeightMax}] avg={r.HeightAvg:F1}");
        Console.WriteLine($"  Terrain types:");
        foreach (var tc in r.TerrainTypes!) {
            Console.WriteLine($"    Type {tc.Type,2}: {tc.Count} vertices ({100.0 * tc.Count / r.VertexCount:F0}%)");
        }
        Console.WriteLine();
    }

    private void HandleGetHeightmap(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: get-heightmap <lbX> <lbY>");
            Console.WriteLine("  Example: get-heightmap 63 63");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        var r = _engine.GetHeightmap(lbX, lbY);
        if (!r.Found) { Console.WriteLine($"  No terrain data for landblock 0x{r.LbKey:X4}"); return; }
        Console.WriteLine();
        Console.WriteLine($"  Landblock 0x{r.LbKey:X4} ({lbX}, {lbY}) â€” 9Ã—9 heightmap:");
        Console.WriteLine($"  World origin: ({lbX * 192}, {lbY * 192})");
        Console.WriteLine();
        Console.Write("       ");
        for (int y = 0; y < 9; y++) Console.Write($"Y{y,-7}");
        Console.WriteLine();
        Console.Write("       ");
        for (int y = 0; y < 9; y++) Console.Write("â”€â”€â”€â”€â”€â”€  ");
        Console.WriteLine();
        for (int x = 0; x < 9; x++) {
            Console.Write($"  X{x}  â”‚ ");
            for (int y = 0; y < 9; y++) Console.Write($"{r.HeightsWorld![x][y],6:F1}  ");
            Console.WriteLine();
        }
        Console.WriteLine();
    }

    private void HandleGetTerrainData(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: get-terrain-data <lbX> <lbY>");
            Console.WriteLine("  Example: get-terrain-data 63 63");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        var r = _engine.GetTerrainData(lbX, lbY);
        if (!r.Found) { Console.WriteLine($"  No terrain data for landblock 0x{r.LbKey:X4}"); return; }
        Console.WriteLine();
        Console.WriteLine($"  Landblock 0x{r.LbKey:X4} ({lbX}, {lbY}) â€” {r.Vertices!.Count} vertices:");
        Console.WriteLine($"  World origin: ({lbX * 192}, {lbY * 192})");
        Console.WriteLine();
        Console.WriteLine($"  {"Idx",-5} {"GX",-4} {"GY",-4} {"HIdx",-5} {"Height",-9} {"Type",-6} {"Road",-6} {"Scenery"}");
        Console.WriteLine($"  {new string('-', 50)}");
        foreach (var v in r.Vertices!) {
            Console.WriteLine($"  {v.Index,-5} {v.GridX,-4} {v.GridY,-4} {v.HeightIndex,-5} {v.HeightWorld,-9:F1} {v.TerrainType,-6} {v.Road,-6} {v.Scenery}");
        }
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Object management
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleDescribeLandblock(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: describe-landblock <lbX> <lbY>");
            Console.WriteLine("  Example: describe-landblock 169 180");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        var r = _engine.DescribeLandblock(lbX, lbY);

        Console.WriteLine();
        Console.WriteLine($"  {r.Verbal}");
        Console.WriteLine();
        Console.WriteLine($"  Context:    biome={r.Context.Biome ?? "?"}  conf={r.Context.BiomeConfidence:F2}  road={r.Context.HasRoad}  settlement={r.Context.SettlementHint ?? "—"}  arch={r.Context.DominantArchitecture ?? "—"}");
        Console.WriteLine($"  Terrain:    {r.Terrain.Summary}  cliffs={r.Terrain.CliffCount}  Z={r.Terrain.HeightMin:F1}..{r.Terrain.HeightMax:F1}");
        Console.WriteLine($"  Objects:    total={r.Body.ObjectTotal}  loose={r.Body.LooseObjectCount}  untagged={r.Body.UntaggedIndices.Count}");
        if (r.Body.ByCategory.Count > 0) {
            Console.WriteLine($"              by category: {string.Join(", ", r.Body.ByCategory.Select(c => $"{c.Category}={c.Count}"))}");
        }
        if (r.Body.Structures.Count > 0) {
            Console.WriteLine($"  Structures: {r.Body.Structures.Count}");
            foreach (var s in r.Body.Structures) {
                Console.WriteLine($"    [{s.Index,3}] {s.ModelId}  ({s.Origin.X,7:F1}, {s.Origin.Y,7:F1}, {s.Origin.Z,5:F1})  cells={s.AttributedCellCount}  contains={s.ContainedIndices.Count}");
                Console.WriteLine($"          → {s.TypeDescription}");
            }
        }
        if (r.Body.Interior != null) {
            Console.WriteLine($"  Interior:   {r.Body.Interior.CellCount} cells, Z={r.Body.Interior.ZMin:F1}..{r.Body.Interior.ZMax:F1}, bands={r.Body.Interior.ZBandCount}, cell-edges={r.Body.Interior.CellGraphEdges}, exterior-portals={r.Body.Interior.ExteriorPortals}");
        }
        if (r.Relations.Count > 0) {
            Console.WriteLine("  Relations:");
            foreach (var rel in r.Relations) Console.WriteLine($"    • {rel}");
        }
        Console.WriteLine();
    }

    private void HandleListObjects(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: list-objects <lbX> <lbY>");
            Console.WriteLine("  Example: list-objects 63 63");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        var r = _engine.ListObjects(lbX, lbY);
        if (r.Objects.Count == 0) { Console.WriteLine($"  No static objects in landblock 0x{r.LbKey:X4}"); return; }
        Console.WriteLine();
        Console.WriteLine($"  Landblock 0x{r.LbKey:X4} ({lbX}, {lbY}) â€” {r.Objects.Count} object(s):");
        Console.WriteLine($"  {"Idx",-5} {"Model ID",-12} {"Type",-7} {"X",-10} {"Y",-10} {"Z",-10} {"Scale"}");
        Console.WriteLine($"  {new string('-', 65)}");
        for (int i = 0; i < r.Objects.Count; i++) {
            var obj = r.Objects[i];
            Console.WriteLine($"  {i,-5} 0x{obj.Id:X8}   {(obj.IsSetup ? "Setup" : "GfxObj"),-7} {obj.Origin.X,-10:F1} {obj.Origin.Y,-10:F1} {obj.Origin.Z,-10:F1} {obj.Scale.X:F2}");
        }
        Console.WriteLine();
    }

    private void HandleAddObject(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 7) {
            Console.WriteLine("Usage: add-object <lbX> <lbY> <modelId> <x> <y> <z>");
            Console.WriteLine("  modelId â€” hex model/setup ID (e.g., 02001234)");
            Console.WriteLine("  Example: add-object 63 63 02001234 12096.5 12096.5 10.0");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[3], "modelId", out uint modelId)) return;
        if (!TryParseFloat(tokens[4], "x", out float x)) return;
        if (!TryParseFloat(tokens[5], "y", out float y)) return;
        if (!TryParseFloat(tokens[6], "z", out float z)) return;
        var r = _engine.AddObject(lbX, lbY, modelId, x, y, z);
        Console.WriteLine($"Added object 0x{r.Object.Id:X8} at ({x:F1}, {y:F1}, {z:F1})");
        Console.WriteLine($"  Landblock: 0x{r.LbKey:X4}, Index: {r.Index}");
        Console.WriteLine($"  Type: {(r.Object.IsSetup ? "Setup" : "GfxObj")}");
    }

    private void HandleRemoveObject(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: remove-object <lbX> <lbY> <index>");
            Console.WriteLine("  Example: remove-object 63 63 0");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        if (!TryParseInt(tokens[3], "index", out int index)) return;
        var r = _engine.RemoveObject(lbX, lbY, index);
        Console.WriteLine($"Removing object at index {r.Index}: 0x{r.RemovedModelId:X8} at ({r.RemovedPosition.X:F1}, {r.RemovedPosition.Y:F1}, {r.RemovedPosition.Z:F1})");
        Console.WriteLine(r.Success ? "Object removed successfully." : "Failed to remove object.");
    }

    private void HandleMoveObject(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 7) {
            Console.WriteLine("Usage: move-object <lbX> <lbY> <index> <x> <y> <z>");
            Console.WriteLine("  Example: move-object 63 63 0 12100 12100 15.5");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        if (!TryParseInt(tokens[3], "index", out int index)) return;
        if (!TryParseFloat(tokens[4], "x", out float x)) return;
        if (!TryParseFloat(tokens[5], "y", out float y)) return;
        if (!TryParseFloat(tokens[6], "z", out float z)) return;
        var r = _engine.MoveObject(lbX, lbY, index, x, y, z);
        Console.WriteLine($"Moved object 0x{r.ModelId:X8}:");
        Console.WriteLine($"  From: ({r.From.X:F1}, {r.From.Y:F1}, {r.From.Z:F1})");
        Console.WriteLine($"  To:   ({r.To.X:F1}, {r.To.Y:F1}, {r.To.Z:F1})");
    }

    private void HandleRotateObject(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 5) {
            Console.WriteLine("Usage: rotate-object <lbX> <lbY> <index> <yaw-degrees>");
            Console.WriteLine("  For precise quaternion: rotate-object <lbX> <lbY> <index> <qw> <qx> <qy> <qz>");
            Console.WriteLine("  Example: rotate-object 63 63 0 90");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        if (!TryParseInt(tokens[3], "index", out int index)) return;
        Quaternion newQ;
        if (tokens.Length >= 8) {
            if (!TryParseFloat(tokens[4], "qw", out float qw)) return;
            if (!TryParseFloat(tokens[5], "qx", out float qx)) return;
            if (!TryParseFloat(tokens[6], "qy", out float qy)) return;
            if (!TryParseFloat(tokens[7], "qz", out float qz)) return;
            newQ = Quaternion.Normalize(new Quaternion(qx, qy, qz, qw));
        } else {
            if (!TryParseFloat(tokens[4], "yaw", out float yawDeg)) return;
            newQ = Quaternion.CreateFromAxisAngle(Vector3.UnitZ, yawDeg * MathF.PI / 180f);
        }
        var r = _engine.RotateObject(lbX, lbY, index, newQ);
        Console.WriteLine($"Rotated object 0x{r.ModelId:X8} at index {r.Index}:");
        Console.WriteLine($"  Old: (W={r.OldOrientation.W:F4}, X={r.OldOrientation.X:F4}, Y={r.OldOrientation.Y:F4}, Z={r.OldOrientation.Z:F4})");
        Console.WriteLine($"  New: (W={r.NewOrientation.W:F4}, X={r.NewOrientation.X:F4}, Y={r.NewOrientation.Y:F4}, Z={r.NewOrientation.Z:F4})");
    }

    private void HandleClearObjects(string[] tokens) {
        if (!CheckProject()) return;

        bool clearAll = tokens.Any(t => t.Equals("--all", StringComparison.OrdinalIgnoreCase));

        if (!clearAll && tokens.Length < 3) {
            Console.WriteLine("Usage: clear-objects <lbX> <lbY>");
            Console.WriteLine("       clear-objects --all");
            Console.WriteLine();
            Console.WriteLine("  Removes all static objects (buildings, doors, decorations) from a landblock.");
            Console.WriteLine("  --all  Clear ALL objects from every landblock in the world.");
            Console.WriteLine();
            Console.WriteLine("  Note: EnvCells (dungeon interiors) and terrain are not affected.");
            Console.WriteLine("  Example: clear-objects 63 63");
            return;
        }

        if (clearAll) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("  âš  Clearing ALL objects from the entire world...");
            Console.ResetColor();
            var r = _engine.ClearAllObjects();
            Console.WriteLine();
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  âœ“ Cleared {r.ObjectsRemoved:N0} objects from {r.AffectedLandblocks.Count:N0} landblocks");
            Console.WriteLine($"    ({r.LandblocksProcessed:N0} landblocks scanned)");
            Console.ResetColor();
        } else {
            if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
            if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
            var r = _engine.ClearObjects(lbX, lbY);
            ushort lbKey = (ushort)((lbX << 8) | lbY);
            if (r.ObjectsRemoved == 0) {
                Console.WriteLine($"  No objects in landblock 0x{lbKey:X4} â€” nothing to clear.");
            } else {
                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine($"  âœ“ Cleared {r.ObjectsRemoved} objects from landblock 0x{lbKey:X4}");
                Console.ResetColor();
            }
        }
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Spatial queries
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleQueryRadius(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: query-radius <x> <y> <radius>");
            Console.WriteLine("  Example: query-radius 12096 12096 200");
            return;
        }
        if (!TryParseFloat(tokens[1], "x", out float cx)) return;
        if (!TryParseFloat(tokens[2], "y", out float cy)) return;
        if (!TryParseFloat(tokens[3], "radius", out float radius)) return;
        var r = _engine.QueryRadius(cx, cy, radius);
        Console.WriteLine();
        Console.WriteLine($"  Objects within {radius} units of ({cx}, {cy}): {r.Objects.Count} found");
        Console.WriteLine($"  Density: {(radius > 0 ? r.Objects.Count / (MathF.PI * radius * radius) : 0):F4} objects/unitÂ²");
        Console.WriteLine();
        if (r.Objects.Count > 0) {
            Console.WriteLine($"  {"Dist",-8} {"LB",-8} {"Idx",-5} {"Model ID",-12} {"Type",-7} {"X",-10} {"Y",-10} {"Z",-10}");
            Console.WriteLine($"  {new string('-', 75)}");
            foreach (var f in r.Objects.Take(50)) {
                Console.WriteLine($"  {f.Distance,-8:F1} 0x{f.LbKey:X4}   {f.Index,-5} 0x{f.Object.Id:X8}   {(f.Object.IsSetup ? "Setup" : "GfxObj"),-7} {f.Object.Origin.X,-10:F1} {f.Object.Origin.Y,-10:F1} {f.Object.Origin.Z,-10:F1}");
            }
            if (r.Objects.Count > 50) Console.WriteLine($"  ... and {r.Objects.Count - 50} more");
        }
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Dungeon tools
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleAnalyzeDungeons(string[] tokens) {
        if (!CheckProject()) return;
        string? outputPath = tokens.Length >= 2 ? tokens[1] : null;
        Console.WriteLine("Scanning dungeon cells in DAT files...");
        Console.WriteLine("(This may take a moment for large DAT sets)");
        var (report, savedTo) = _engine.AnalyzeDungeons(outputPath);
        Console.WriteLine();
        Console.WriteLine(DungeonRoomAnalyzer.FormatSummary(report));
        if (!string.IsNullOrEmpty(savedTo)) Console.WriteLine($"Report saved to: {savedTo}");
        else Console.WriteLine("Tip: Use 'analyze-dungeons <output-path>' to save the full report.");
    }

    private void HandleGetDungeonInfo(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: get-dungeon-info <lbX> <lbY>");
            Console.WriteLine("  Example: get-dungeon-info 1 217");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        var r = _engine.GetDungeonInfo(lbX, lbY);
        if (!r.HasDungeon) { Console.WriteLine($"  No dungeon cells in landblock 0x{r.LbKey:X4}"); return; }
        Console.WriteLine();
        Console.WriteLine($"  Landblock 0x{r.LbKey:X4} â€” {r.CellCount} dungeon cell(s):");
        Console.WriteLine();
        foreach (var cell in r.Document!.Cells) {
            Console.WriteLine($"  Cell 0x{cell.CellNumber:X4}  Env: 0x{cell.EnvironmentId:X4}  Struct: {cell.CellStructure}");
            Console.WriteLine($"    Origin: ({cell.Origin.X:F1}, {cell.Origin.Y:F1}, {cell.Origin.Z:F1})");
            Console.WriteLine($"    Portals: {cell.CellPortals.Count}  Objects: {cell.StaticObjects.Count}");
            foreach (var portal in cell.CellPortals) {
                Console.WriteLine($"      â†’ Cell 0x{portal.OtherCellId:X4} (poly {portal.PolygonId})");
            }
        }
        Console.WriteLine();
    }

    private void HandleAnalyzeDungeonCatalog(string[] tokens) {
        if (!CheckProject()) return;
        string? outputPath = tokens.Length >= 2 ? tokens[1] : null;
        Console.WriteLine("Extracting full dungeon room catalog from DAT files...");
        Console.WriteLine("(This scans all cells for bounding boxes, portal geometry, and dimensions)");
        var r = _engine.AnalyzeDungeonCatalog(outputPath);
        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine($"  Landblocks scanned    : {r.TotalLandblocksScanned}");
        Console.WriteLine($"  Total cells           : {r.TotalCellsScanned}");
        Console.WriteLine($"  Unique room templates : {r.UniqueRoomTemplates}");
        Console.WriteLine($"  Errors                : {r.Errors}");
        Console.WriteLine();
        Console.WriteLine("  Classifications:");
        foreach (var kv in r.ClassificationCounts.OrderByDescending(kv => kv.Value))
            Console.WriteLine($"    {kv.Key,-12} {kv.Value,5}");
        Console.WriteLine();
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Catalog saved to: {r.OutputPath}");
        else
            Console.WriteLine("  Tip: Use 'analyze-dungeon-catalog <output-path.json>' to save the full catalog.");
        Console.WriteLine();
    }

    private void HandleAnalyzeDungeonTopology(string[] tokens) {
        if (!CheckProject()) return;
        string? outputPath = tokens.Length >= 2 ? tokens[1] : null;
        Console.WriteLine("Extracting dungeon topology (portal graphs) from DAT files...");
        Console.WriteLine("(This scans all dungeon landblocks for adjacency, depth, and branching)");
        var r = _engine.AnalyzeDungeonTopology(outputPath);
        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine($"  Dungeons analyzed     : {r.TotalDungeonsAnalyzed}");
        Console.WriteLine($"  Total cells           : {r.TotalCellsAnalyzed}");
        Console.WriteLine();
        Console.WriteLine("  Classifications:");
        foreach (var kv in r.ClassificationCounts.OrderByDescending(kv => kv.Value))
            Console.WriteLine($"    {kv.Key,-14} {kv.Value,5}");
        Console.WriteLine();
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Topology saved to: {r.OutputPath}");
        else
            Console.WriteLine("  Tip: Use 'analyze-dungeon-topology <output-path.json>' to save the full report.");
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Validation
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleValidateDungeon(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) { Console.WriteLine("Usage: validate-dungeon <lbX> <lbY>"); return; }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        PrintValidationReport(_engine.ValidateDungeon(lbX, lbY));
    }

    private void HandleValidateLandblock(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) { Console.WriteLine("Usage: validate-landblock <lbX> <lbY>"); return; }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        PrintValidationReport(_engine.ValidateLandblock(lbX, lbY));
    }

    private void HandleValidateTerrain(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) { Console.WriteLine("Usage: validate-terrain <lbX> <lbY> [cliff-threshold]"); return; }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        float threshold = ValidationEngine.DefaultCliffThreshold;
        if (tokens.Length >= 4 && !TryParseFloat(tokens[3], "cliff-threshold", out threshold)) return;
        PrintValidationReport(_engine.ValidateTerrain(lbX, lbY, threshold));
    }

    private void HandleValidateBuildingShells(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) { Console.WriteLine("Usage: validate-building-shells <lbX> <lbY>"); return; }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        PrintValidationReport(_engine.ValidateBuildingShells(lbX, lbY));
    }

    private void HandleValidateBuildingPortals(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) { Console.WriteLine("Usage: validate-building-portals <lbX> <lbY>"); return; }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        PrintValidationReport(_engine.ValidateBuildingPortals(lbX, lbY));
    }

    private void HandleValidateAll(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) { Console.WriteLine("Usage: validate-all <lbX> <lbY> [cliff-threshold]"); return; }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        float threshold = ValidationEngine.DefaultCliffThreshold;
        if (tokens.Length >= 4 && !TryParseFloat(tokens[3], "cliff-threshold", out threshold)) return;
        PrintValidationReport(_engine.ValidateAll(lbX, lbY, threshold));
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  World observation
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleListLandblocks(string[] tokens) {
        if (!CheckProject()) return;
        uint minX = 0, minY = 0, maxX = 254, maxY = 254;
        if (tokens.Length >= 2 && !TryParseUint(tokens[1], "minX", out minX)) return;
        if (tokens.Length >= 3 && !TryParseUint(tokens[2], "minY", out minY)) return;
        if (tokens.Length >= 4 && !TryParseUint(tokens[3], "maxX", out maxX)) return;
        if (tokens.Length >= 5 && !TryParseUint(tokens[4], "maxY", out maxY)) return;
        var r = _engine.ListLandblocks(minX, minY, maxX, maxY, 200);
        Console.WriteLine();
        Console.WriteLine($"  Landblocks with terrain data in ({minX},{minY}) to ({maxX},{maxY}):");
        Console.WriteLine($"  {"LB",-10} {"lbX",-6} {"lbY",-6} {"WorldX",-10} {"WorldY",-10} {"HMin",-6} {"HMax"}");
        Console.WriteLine($"  {new string('-', 55)}");
        foreach (var lb in r.Landblocks) {
            Console.WriteLine($"  0x{lb.LbKey:X4}    {lb.LbX,-6} {lb.LbY,-6} {lb.LbX * 192,-10} {lb.LbY * 192,-10} {lb.HeightMin,-6} {lb.HeightMax}");
        }
        Console.WriteLine();
        Console.WriteLine($"  Found {r.Count} landblock(s)");
        if (r.Truncated) Console.WriteLine($"  (truncated at 200)");
        Console.WriteLine();
    }

    private void HandleGetWorldInfo() {
        if (!CheckProject()) return;
        var r = _engine.GetWorldInfo();
        Console.WriteLine();
        Console.WriteLine("  â•â•â• World Information â•â•â•");
        Console.WriteLine($"  Project        : {r.ProjectName}");
        Console.WriteLine($"  Map size       : 255 Ã— 255 landblocks");
        Console.WriteLine($"  Landblock size : 192 Ã— 192 world units (9Ã—9 vertex grid, 24u cells)");
        Console.WriteLine($"  Modified LBs   : {r.ModifiedLandblocks}");
        Console.WriteLine($"  Height table   : {r.HeightTableSize} entries");
        Console.WriteLine($"  Height range   : {r.HeightMin:F1} to {r.HeightMax:F1} world units");
        Console.WriteLine($"  Portal Iter    : {r.PortalIteration?.ToString() ?? "(unavailable)"}");
        Console.WriteLine();
    }

    private void HandleGetRegion() {
        if (!CheckProject()) return;
        var r = _engine.GetRegion();
        Console.WriteLine();
        Console.WriteLine("  === Region Data ===");
        Console.WriteLine($"  Region #{r.RegionNumber}  \"{r.RegionName}\"  v{r.Version}  partsMask=0x{r.PartsMask:X8}");
        if (r.LandDefs != null) {
            var ld = r.LandDefs;
            Console.WriteLine($"  LandDefs: blocks {ld.NumBlockLength}x{ld.NumBlockWidth}  square={ld.SquareLength}  lblock={ld.LBlockLength}  vertsPerCell={ld.VertexPerCell}");
            Console.WriteLine($"            maxObjHeight={ld.MaxObjHeight}  skyHeight={ld.SkyHeight}  roadWidth={ld.RoadWidth}");
        }
        if (r.GameTime is { Present: true } gt) {
            Console.WriteLine($"  GameTime: dayLength={gt.DayLength}  daysPerYear={gt.DaysPerYear}  yearSpec=\"{gt.YearSpec}\"  timesOfDay={gt.TimesOfDayCount}  seasons={gt.SeasonsCount}");
        }
        Console.WriteLine($"  Parts: sky={r.HasSkyInfo}({r.DayGroupCount})  sound={r.HasSoundInfo}({r.SoundStbCount})  scene={r.HasSceneInfo}({r.SceneTypeCount})  misc={r.HasRegionMisc}");
        Console.WriteLine($"  Height table ({r.HeightTable.Length} entries):");
        for (int i = 0; i < r.HeightTable.Length; i += 8) {
            Console.Write("    ");
            for (int j = i; j < Math.Min(i + 8, r.HeightTable.Length); j++)
                Console.Write($"[{j,3}]={r.HeightTable[j],7:F1}  ");
            Console.WriteLine();
        }
        if (r.TerrainTypeDetails != null && r.TerrainTypeDetails.Count > 0) {
            Console.WriteLine();
            Console.WriteLine($"  Terrain types ({r.TerrainTypeDetails.Count}):");
            foreach (var td in r.TerrainTypeDetails)
                Console.WriteLine($"    [{td.Index,2}] {td.Name,-24} color=0x{td.TerrainColor:X8}  sceneTypes={td.SceneTypeCount}");
        }
        else if (r.TerrainTypes != null && r.TerrainTypes.Count > 0) {
            Console.WriteLine();
            Console.WriteLine($"  Terrain types ({r.TerrainTypes.Count}):");
            foreach (var tt in r.TerrainTypes) Console.WriteLine($"    [{tt.Index,2}] {tt.Name}");
        }
        Console.WriteLine();
    }

    private void HandleGetTerrainTextures() {
        if (!CheckProject()) return;
        var r = _engine.GetTerrainTextures();
        Console.WriteLine();
        Console.WriteLine("  === Terrain Textures (TexMerge) ===");
        if (!r.Found) {
            Console.WriteLine($"  (unavailable) {r.Error}");
            Console.WriteLine();
            return;
        }
        Console.WriteLine($"  BaseTexSize={r.BaseTexSize}  terrainDesc={r.TerrainDesc.Count}  corner={r.CornerTerrainMaps.Count}  side={r.SideTerrainMaps.Count}  road={r.RoadMaps.Count}");
        foreach (var d in r.TerrainDesc) {
            Console.WriteLine($"    [{d.Index,2}] {d.TerrainType,-24} tex=0x{d.TexGID:X8}->0x{d.ResolvedTextureId:X8}  tiling={d.TexTiling}  detail=0x{d.DetailTexGID:X8}(t={d.DetailTexTiling})  bright[{d.MinVertBright},{d.MaxVertBright}]");
        }
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Ontology
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleScanOntology(string[] tokens) {
        if (!CheckProject()) return;
        bool scanGfxObjs = true;
        if (tokens.Length >= 2 && tokens[1].Equals("setups-only", StringComparison.OrdinalIgnoreCase))
            scanGfxObjs = false;
        Console.WriteLine("Scanning DAT files for object classification...");
        Console.WriteLine("(This may take 10-20 seconds for large DAT sets)");
        var r = _engine.ScanOntology(scanGfxObjs);
        var rpt = r.Report;
        Console.WriteLine();
        Console.WriteLine($"  â•â•â• Ontology Scan Complete â•â•â•");
        Console.WriteLine($"  Setups scanned  : {rpt.TotalSetups}");
        Console.WriteLine($"  GfxObjs scanned : {rpt.TotalGfxObjs}");
        Console.WriteLine($"  Total entries   : {rpt.TotalEntries}");
        Console.WriteLine($"  Scan time       : {rpt.ScanTimeMs:F0}ms");
        Console.WriteLine();
        Console.WriteLine("  Categories:");
        foreach (var kv in rpt.CategoryCounts.OrderByDescending(kv => kv.Value))
            Console.WriteLine($"    {kv.Key,-15} {kv.Value,6}");
        Console.WriteLine();
        Console.WriteLine("  Scales:");
        foreach (var kv in rpt.ScaleCounts.OrderByDescending(kv => kv.Value))
            Console.WriteLine($"    {kv.Key,-15} {kv.Value,6}");
        Console.WriteLine();
    }

    private void HandleQueryOntology(string[] tokens) {
        if (!CheckProject()) return;
        // Usage: query-ontology [category] [scale] [keyword] [limit]
        string? category = tokens.Length >= 2 ? tokens[1] : null;
        string? scale = tokens.Length >= 3 ? tokens[2] : null;
        string? keyword = tokens.Length >= 4 ? tokens[3] : null;
        // Treat "*" as wildcard (skip filter)
        if (category == "*") category = null;
        if (scale == "*") scale = null;
        if (keyword == "*") keyword = null;
        int limit = 20;
        if (tokens.Length >= 5 && int.TryParse(tokens[4], out var parsedLimit)) limit = parsedLimit;

        // Check if first arg is a hex ID
        uint? objectId = null;
        if (category != null && category.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
            if (uint.TryParse(category.Replace("0x", ""), System.Globalization.NumberStyles.HexNumber, null, out var id)) {
                objectId = id;
                category = null;
            }
        }

        try {
            var r = _engine.QueryOntology(category, scale, keyword, objectId, limit);
            Console.WriteLine();
            Console.WriteLine($"  Ontology: {r.Entries.Length} result(s) of {r.TotalIndexed} indexed");
            Console.WriteLine();
            if (r.Entries.Length == 0) {
                Console.WriteLine("  No matches found.");
            } else {
                Console.WriteLine($"  {"ID",-12} {"Type",-7} {"Category",-12} {"Scale",-9} {"MaxDim",-8} {"Parts",-6} {"Polys",-7} Source");
                Console.WriteLine($"  {new string('-', 75)}");
                foreach (var e in r.Entries) {
                    Console.WriteLine($"  0x{e.ObjectId:X8} {e.DatType,-7} {e.Category,-12} {e.Scale,-9} {e.MaxDimension,-8:F1} {e.PartCount,-6} {e.PolyCount,-7} {e.ClassificationSource}");
                }
            }
            Console.WriteLine();
        } catch (InvalidOperationException ex) {
            Console.WriteLine(ex.Message);
            Console.WriteLine("Tip: Run 'scan-ontology' first.");
        }
    }

    private void HandleOntologyStats() {
        try {
            var r = _engine.GetOntologyStats();
            Console.WriteLine();
            Console.WriteLine($"  â•â•â• Ontology Statistics â•â•â•");
            Console.WriteLine($"  Total entries: {r.TotalEntries}");
            Console.WriteLine();
            Console.WriteLine("  Categories:");
            foreach (var kv in r.CategoryCounts.OrderByDescending(kv => kv.Value))
                Console.WriteLine($"    {kv.Key,-15} {kv.Value,6} ({100.0 * kv.Value / r.TotalEntries:F1}%)");
            Console.WriteLine();
            Console.WriteLine("  Scales:");
            foreach (var kv in r.ScaleCounts.OrderByDescending(kv => kv.Value))
                Console.WriteLine($"    {kv.Key,-15} {kv.Value,6} ({100.0 * kv.Value / r.TotalEntries:F1}%)");
            Console.WriteLine();

            // Coverage metrics (populated after weenie enrichment)
            Console.WriteLine("  Coverage:");
            Console.WriteLine($"    With Name          {r.WithName,6} ({100.0 * r.WithName / Math.Max(r.TotalEntries, 1):F1}%)");
            Console.WriteLine($"    With WeenieClassId {r.WithWeenieClassId,6} ({100.0 * r.WithWeenieClassId / Math.Max(r.TotalEntries, 1):F1}%)");
            Console.WriteLine($"    With Level         {r.WithLevel,6} ({100.0 * r.WithLevel / Math.Max(r.TotalEntries, 1):F1}%)");
            Console.WriteLine($"    With CreatureType  {r.WithCreatureType,6} ({100.0 * r.WithCreatureType / Math.Max(r.TotalEntries, 1):F1}%)");
            Console.WriteLine();

            if (r.WeenieTypeCounts != null && r.WeenieTypeCounts.Count > 0) {
                Console.WriteLine("  Weenie Types:");
                foreach (var kv in r.WeenieTypeCounts.OrderByDescending(kv => kv.Value))
                    Console.WriteLine($"    Type {kv.Key,-5} {kv.Value,6}");
                Console.WriteLine();
            }
        } catch (InvalidOperationException ex) {
            Console.WriteLine(ex.Message);
            Console.WriteLine("Tip: Run 'scan-ontology' first.");
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Stamp & Portal
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandlePasteStamp(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 7) {
            Console.WriteLine("Usage: paste-stamp <srcMinX> <srcMinY> <srcMaxX> <srcMaxY> <destX> <destY> [blend] [zOffset]");
            Console.WriteLine("  Captures terrain from source bounding box and pastes at destination.");
            Console.WriteLine("  blend   â€” blend edges: true/false (default: true)");
            Console.WriteLine("  zOffset â€” height offset in world units (default: 0)");
            Console.WriteLine("  Example: paste-stamp 1344 3072 1536 3264 2000 2000");
            return;
        }
        if (!TryParseFloat(tokens[1], "srcMinX", out float srcMinX)) return;
        if (!TryParseFloat(tokens[2], "srcMinY", out float srcMinY)) return;
        if (!TryParseFloat(tokens[3], "srcMaxX", out float srcMaxX)) return;
        if (!TryParseFloat(tokens[4], "srcMaxY", out float srcMaxY)) return;
        if (!TryParseFloat(tokens[5], "destX", out float destX)) return;
        if (!TryParseFloat(tokens[6], "destY", out float destY)) return;
        bool blend = true;
        if (tokens.Length >= 8 && bool.TryParse(tokens[7], out var b)) blend = b;
        float zOffset = 0f;
        if (tokens.Length >= 9 && !TryParseFloat(tokens[8], "zOffset", out zOffset)) return;

        var r = _engine.PasteStamp(srcMinX, srcMinY, srcMaxX, srcMaxY, destX, destY,
            includeObjects: false, blendEdges: blend, zOffset: zOffset);
        Console.WriteLine();
        Console.WriteLine($"  Stamp pasted successfully:");
        Console.WriteLine($"  Source: ({srcMinX}, {srcMinY}) -> ({srcMaxX}, {srcMaxY})");
        Console.WriteLine($"  Destination: ({destX}, {destY})");
        Console.WriteLine($"  Terrain vertices changed: {r.TerrainChanges}");
        Console.WriteLine($"  Objects placed: {r.ObjectsPlaced}");
        Console.WriteLine($"  Modified {r.ModifiedLandblocks.Count} landblock(s): {string.Join(", ", r.ModifiedLandblocks.Select(lb => $"0x{lb:X4}"))}");
        Console.WriteLine();
    }

    private void HandleSnapPortal(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 7) {
            Console.WriteLine("Usage: snap-portal <lbX> <lbY> <targetCellNum> <targetPortalPolyId> <sourceEnvId> <sourceCellStruct>");
            Console.WriteLine("  Adds a new dungeon cell snapped to the target cell's portal.");
            Console.WriteLine("  targetCellNum      â€” hex cell number in the dungeon (e.g. 0100)");
            Console.WriteLine("  targetPortalPolyId â€” hex polygon ID of the target portal");
            Console.WriteLine("  sourceEnvId        â€” hex Environment ID for the new cell");
            Console.WriteLine("  sourceCellStruct   â€” CellStruct index within the Environment");
            Console.WriteLine("  Example: snap-portal 1 217 0100 0010 0D00 0");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[3], "targetCellNum", out uint targetCellNumU)) return;
        if (!TryParseHex(tokens[4], "targetPortalPolyId", out uint targetPortalPolyIdU)) return;
        if (!TryParseHex(tokens[5], "sourceEnvId", out uint sourceEnvIdU)) return;
        ushort sourceCellStruct = 0;
        if (ushort.TryParse(tokens[6], System.Globalization.NumberStyles.Integer,
            System.Globalization.CultureInfo.InvariantCulture, out var parsed)) {
            sourceCellStruct = parsed;
        } else if (TryParseHex(tokens[6], "sourceCellStruct", out uint cssU)) {
            sourceCellStruct = (ushort)cssU;
        }

        var r = _engine.SnapPortal(lbX, lbY,
            (ushort)targetCellNumU, (ushort)targetPortalPolyIdU,
            (ushort)sourceEnvIdU, sourceCellStruct);

        Console.WriteLine();
        Console.WriteLine($"  Portal snap successful:");
        Console.WriteLine($"  Landblock: 0x{r.LbKey:X4}");
        Console.WriteLine($"  Target cell: 0x{r.TargetCellNumber:X4}, portal poly: 0x{r.TargetPortalPolygonId:X4}");
        Console.WriteLine($"  New cell: 0x{r.NewCellNumber:X4}");
        Console.WriteLine($"    Env: 0x{r.SourceEnvironmentId:X4}, Struct: {r.SourceCellStructure}");
        Console.WriteLine($"    Origin: ({r.NewOrigin.X:F1}, {r.NewOrigin.Y:F1}, {r.NewOrigin.Z:F1})");
        Console.WriteLine($"    Orientation: (W={r.NewOrientation.W:F4}, X={r.NewOrientation.X:F4}, Y={r.NewOrientation.Y:F4}, Z={r.NewOrientation.Z:F4})");
        Console.WriteLine($"    Portals: {r.PortalCount}");
        Console.WriteLine($"    Surfaces: {r.SurfaceCount}");
        if (r.Warning != null)
            Console.WriteLine($"    WARNING: {r.Warning}");
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Bulk & detail queries
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleGetBulkHeightmap(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 5) {
            Console.WriteLine("Usage: get-bulk-heightmap <minX> <minY> <maxX> <maxY>");
            Console.WriteLine("  Returns heightmaps for all landblocks in range.");
            Console.WriteLine("  Example: get-bulk-heightmap 63 63 65 65");
            return;
        }
        if (!TryParseUint(tokens[1], "minX", out uint minX)) return;
        if (!TryParseUint(tokens[2], "minY", out uint minY)) return;
        if (!TryParseUint(tokens[3], "maxX", out uint maxX)) return;
        if (!TryParseUint(tokens[4], "maxY", out uint maxY)) return;
        var r = _engine.GetBulkHeightmap(minX, minY, maxX, maxY);
        Console.WriteLine();
        Console.WriteLine($"  Bulk heightmap: {r.FoundLandblocks} found of {r.TotalLandblocks} requested");
        Console.WriteLine();
        foreach (var h in r.Heightmaps) {
            Console.WriteLine($"  â”€â”€ Landblock 0x{h.LbKey:X4} ({h.LbX}, {h.LbY}) â”€â”€");
            Console.Write("       ");
            for (int y = 0; y < 9; y++) Console.Write($"Y{y,-7}");
            Console.WriteLine();
            for (int x = 0; x < 9; x++) {
                Console.Write($"  X{x}  â”‚ ");
                for (int y = 0; y < 9; y++) Console.Write($"{h.HeightsWorld![x][y],6:F1}  ");
                Console.WriteLine();
            }
            Console.WriteLine();
        }
    }

    private void HandleGetObjectDetail(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: get-object-detail <objectId>");
            Console.WriteLine("  Inspects a model/setup from the DAT file.");
            Console.WriteLine("  Example: get-object-detail 0x02001234");
            return;
        }
        if (!TryParseHex(tokens[1], "objectId", out uint objectId)) return;
        var r = _engine.GetObjectDetail(objectId);
        Console.WriteLine();
        if (!r.Found) {
            Console.WriteLine($"  Object {r.ObjectIdHex} ({r.DatType}): NOT FOUND in DAT");
            Console.WriteLine();
            return;
        }
        Console.WriteLine($"  â•â•â• Object Detail: {r.ObjectIdHex} â•â•â•");
        Console.WriteLine($"  DAT type       : {r.DatType}");
        Console.WriteLine($"  Parts          : {r.PartCount}");
        Console.WriteLine($"  Polygons       : {r.PolyCount}");
        Console.WriteLine($"  Vertices       : {r.VertexCount}");
        Console.WriteLine($"  Max dimension  : {r.MaxDimension:F2}");
        if (r.BoundsMin != null)
            Console.WriteLine($"  Bounds min     : ({r.BoundsMin[0]:F2}, {r.BoundsMin[1]:F2}, {r.BoundsMin[2]:F2})");
        if (r.BoundsMax != null)
            Console.WriteLine($"  Bounds max     : ({r.BoundsMax[0]:F2}, {r.BoundsMax[1]:F2}, {r.BoundsMax[2]:F2})");
        if (r.BoundsSize != null)
            Console.WriteLine($"  Bounds size    : ({r.BoundsSize[0]:F2}, {r.BoundsSize[1]:F2}, {r.BoundsSize[2]:F2})");
        Console.WriteLine($"  Surfaces       : {r.SurfaceIds?.Count ?? 0}");
        if (r.OntologyCategory != null)
            Console.WriteLine($"  Ontology cat   : {r.OntologyCategory}");
        if (r.OntologyScale != null)
            Console.WriteLine($"  Ontology scale : {r.OntologyScale}");
        if (r.OntologyTags != null && r.OntologyTags.Count > 0)
            Console.WriteLine($"  Ontology tags  : {string.Join(", ", r.OntologyTags)}");
        Console.WriteLine();
    }

    private void HandleDiffTerrain(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: diff-terrain <lbX> <lbY>");
            Console.WriteLine("  Compares current terrain state against base DAT data.");
            Console.WriteLine("  Example: diff-terrain 63 63");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;
        var r = _engine.DiffTerrain(lbX, lbY);
        if (!r.Found) { Console.WriteLine($"  No terrain data for landblock 0x{r.LbKey:X4}"); return; }
        Console.WriteLine();
        Console.WriteLine($"  â•â•â• Terrain Diff: 0x{r.LbKey:X4} ({lbX}, {lbY}) â•â•â•");
        if (!r.HasChanges) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("  No changes â€” terrain matches base DAT data.");
            Console.ResetColor();
        } else {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"  {r.ChangedVertices} of {r.TotalVertices} vertices changed");
            Console.ResetColor();
            Console.WriteLine($"  Height changes      : {r.HeightChanges}");
            Console.WriteLine($"  Terrain type changes: {r.TerrainTypeChanges}");
            Console.WriteLine($"  Road changes        : {r.RoadChanges}");
            Console.WriteLine();
            Console.WriteLine($"  {"GX",-4} {"GY",-4} {"Idx",-5} {"OldH",-6} {"NewH",-6} {"OldT",-6} {"NewT",-6} {"OldR",-6} {"NewR"}");
            Console.WriteLine($"  {new string('-', 50)}");
            foreach (var c in r.Changes!) {
                Console.Write("  ");
                Console.Write($"{c.GridX,-4} {c.GridY,-4} {c.VertexIndex,-5} ");
                if (c.OldHeight != c.NewHeight) {
                    Console.ForegroundColor = ConsoleColor.Cyan;
                    Console.Write($"{c.OldHeight,-6} {c.NewHeight,-6} ");
                    Console.ResetColor();
                } else Console.Write($"{c.OldHeight,-6} {c.NewHeight,-6} ");
                if (c.OldTerrainType != c.NewTerrainType) {
                    Console.ForegroundColor = ConsoleColor.Magenta;
                    Console.Write($"{c.OldTerrainType,-6} {c.NewTerrainType,-6} ");
                    Console.ResetColor();
                } else Console.Write($"{c.OldTerrainType,-6} {c.NewTerrainType,-6} ");
                if (c.OldRoad != c.NewRoad) {
                    Console.ForegroundColor = ConsoleColor.Yellow;
                    Console.Write($"{c.OldRoad,-6} {c.NewRoad}");
                    Console.ResetColor();
                } else Console.Write($"{c.OldRoad,-6} {c.NewRoad}");
                Console.WriteLine();
            }
        }
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Input parsing helpers (culture-invariant, user-friendly errors)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private static bool TryParseFloat(string input, string paramName, out float value) {
        if (float.TryParse(input, NumberStyles.Float | NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out value))
            return true;
        Console.WriteLine($"Error: Invalid number for <{paramName}>: '{input}'");
        return false;
    }

    private static bool TryParseUint(string input, string paramName, out uint value) {
        if (uint.TryParse(input, NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
            return true;
        Console.WriteLine($"Error: Invalid unsigned integer for <{paramName}>: '{input}'");
        return false;
    }

    private static bool TryParseInt(string input, string paramName, out int value) {
        if (int.TryParse(input, NumberStyles.Integer | NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out value))
            return true;
        Console.WriteLine($"Error: Invalid integer for <{paramName}>: '{input}'");
        return false;
    }

    private static bool TryParseByte(string input, string paramName, out byte value) {
        if (byte.TryParse(input, NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
            return true;
        Console.WriteLine($"Error: Invalid value for <{paramName}>: '{input}' (expected 0-255)");
        return false;
    }

    private static bool TryParseHex(string input, string paramName, out uint value) {
        // Strip optional 0x prefix
        var hex = input.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? input[2..] : input;
        if (uint.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out value))
            return true;
        Console.WriteLine($"Error: Invalid hex value for <{paramName}>: '{input}' (expected hex like 02001234 or 0x02001234)");
        return false;
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Display helpers
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private bool CheckProject() {
        if (!_engine.HasProject) {
            Console.WriteLine("No project loaded. Use 'load <path>' first.");
            return false;
        }
        return true;
    }

    private static void PrintLandblockChanges(HashSet<ushort> modifiedLbs) {
        Console.WriteLine($"  Modified {modifiedLbs.Count} landblock(s): {string.Join(", ", modifiedLbs.Select(lb => $"0x{lb:X4}"))}");
    }

    private static void PrintValidationReport(ValidationReport report) {
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine($"  â•â•â• Validation: {report.CheckType} â€” {report.Target} â•â•â•");
        Console.ResetColor();

        if (report.IsValid && report.WarningCount == 0 && report.InfoCount == 0) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("  âœ“ All checks passed â€” no issues found.");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }

        Console.Write("  Result: ");
        Console.ForegroundColor = report.IsValid ? ConsoleColor.Green : ConsoleColor.Red;
        Console.Write(report.IsValid ? "VALID" : "INVALID");
        Console.ResetColor();
        Console.WriteLine($"  ({report.ErrorCount} error(s), {report.WarningCount} warning(s), {report.InfoCount} info)");
        Console.WriteLine();

        foreach (var d in report.Diagnostics) {
            switch (d.Severity) {
                case ValidationSeverity.Error:
                    Console.ForegroundColor = ConsoleColor.Red; Console.Write("  ERROR "); break;
                case ValidationSeverity.Warning:
                    Console.ForegroundColor = ConsoleColor.Yellow; Console.Write("  WARN  "); break;
                default:
                    Console.ForegroundColor = ConsoleColor.DarkGray; Console.Write("  INFO  "); break;
            }
            Console.ResetColor();
            Console.Write($"[{d.Code}] ");
            Console.WriteLine(d.Message);
        }
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Help / Banner
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private static void PrintBanner() {
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine(@"
  â•¦ â•¦â”Œâ”€â”â”¬â”€â”â”¬  â”Œâ”¬â”â•”â•— â”¬ â”¬â”¬â”¬  â”Œâ”¬â”â”Œâ”€â”â”¬â”€â” â•”â•¦â•—â”Œâ”€â”â”¬â”€â”â”Œâ”¬â”â”¬â”Œâ”â”Œâ”Œâ”€â”â”¬  
  â•‘â•‘â•‘â”‚ â”‚â”œâ”¬â”˜â”‚   â”‚â”‚â• â•©â•—â”‚ â”‚â”‚â”‚   â”‚â”‚â”œâ”¤ â”œâ”¬â”˜  â•‘ â”œâ”¤ â”œâ”¬â”˜â”‚â”‚â”‚â”‚â”‚â”‚â”‚â”œâ”€â”¤â”‚  
  â•šâ•©â•â””â”€â”˜â”´â””â”€â”´â”€â”˜â”€â”´â”˜â•šâ•â•â””â”€â”˜â”´â”´â”€â”˜â”€â”´â”˜â””â”€â”˜â”´â””â”€  â•© â””â”€â”˜â”´â””â”€â”´ â”´â”´â”˜â””â”˜â”´ â”´â”´â”€â”˜
           Headless DAT Export Tool â€” ACME Edition
");
        Console.ResetColor();
    }

    private static void PrintHelp() {
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Project Management â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  load <path>                    Load a .wbproj project file");
        Console.WriteLine("  export <directory> [iter] [--reposition]  Export DATs (optionally reposition DB instances)");
        Console.WriteLine("  info                           Show loaded project information");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Terrain Editing â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  smooth <x> <y> <radius> [str]  Smooth terrain (str: 0.0-1.0, default 0.5)");
        Console.WriteLine("  raise <x> <y> <radius> [delta] Raise terrain height (default delta: 5)");
        Console.WriteLine("  lower <x> <y> <radius> [delta] Lower terrain height (default delta: 5)");
        Console.WriteLine("  set-height <x> <y> <r> <h>     Set terrain to exact height (0-255)");
        Console.WriteLine("  paint <x> <y> <radius> <type>  Paint terrain texture type (0-31)");
        Console.WriteLine("  fill <x> <y> <type>            Flood-fill contiguous terrain");
        Console.WriteLine("  road <x1> <y1> <x2> <y2> [val] Draw road between two points");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Terrain Queries â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  get-height <x> <y>             Query terrain height at position");
        Console.WriteLine("  terrain-info <lbX> <lbY>       Show landblock terrain statistics");
        Console.WriteLine("  get-heightmap <lbX> <lbY>      Full 9Ã—9 heightmap grid");
        Console.WriteLine("  get-terrain-data <lbX> <lbY>   All vertex data (height, type, road, scenery)");
        Console.WriteLine("  terrain sample-height <wX> <wY>  AC-accurate triangle-interpolated height");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Object Management â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  list-objects <lbX> <lbY>                  List objects (with quaternion)");
        Console.WriteLine("  add-object <lbX> <lbY> <id> <x> <y> <z>  Place a static object");
        Console.WriteLine("  remove-object <lbX> <lbY> <index>         Remove object by index");
        Console.WriteLine("  clear-objects <lbX> <lbY>                 Remove ALL objects from a landblock");
        Console.WriteLine("  clear-objects --all                       Remove ALL objects from entire world");
        Console.WriteLine("  move-object <lbX> <lbY> <idx> <x> <y> <z> Move object to new position");
        Console.WriteLine("  rotate-object <lbX> <lbY> <idx> <yawÂ°>    Set orientation (absolute, not incremental)");
        Console.WriteLine("     alt: rotate-object <lbX> <lbY> <idx> <qw> <qx> <qy> <qz>");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Spatial Queries â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  query-radius <x> <y> <radius>             Find objects within radius");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Dungeon Tools â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  analyze-dungeons [output-path]              Scan DAT for room types & usage");
        Console.WriteLine("  analyze-dungeon-catalog [output-path.json]  Extract full room catalog (bounds, portals, dims)");
        Console.WriteLine("  analyze-dungeon-topology [output-path.json] Extract portal graph topology (DAG, metrics)");
        Console.WriteLine("  get-dungeon-info <lbX> <lbY>                Show dungeon cell layout");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Validation â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  validate-dungeon <lbX> <lbY>           Validate dungeon structure/portals");
        Console.WriteLine("  validate-landblock <lbX> <lbY>         Validate landblock objects (LBK010 footprint flush check when ontology is scanned)");
        Console.WriteLine("  validate-terrain <lbX> <lbY> [thresh]  Validate terrain (cliffs, edges)");
        Console.WriteLine("  validate-building-shells <lbX> <lbY>   Validate exterior building shell data (BSH009 group-Z divergence when pairings are loaded)");
        Console.WriteLine("  validate-building-portals <lbX> <lbY>  Validate interior EnvCell portal links");
        Console.WriteLine("  validate-all <lbX> <lbY> [thresh]      Run ALL validators on a landblock (footprint flush + cliffs + portals)");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• World Observation â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  list-landblocks [minX minY maxX maxY]  List landblocks with terrain data");
        Console.WriteLine("  get-world-info                         World metadata and dimensions");
        Console.WriteLine("  get-region                             Height table and terrain types");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Ontology â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  scan-ontology [setups-only]             Scan DAT to classify all models");
        Console.WriteLine("  query-ontology [cat] [scale] [kw] [n]   Search the ontology index");
        Console.WriteLine("  query-ontology 0x02001234               Lookup a specific object ID");
        Console.WriteLine("  ontology-stats                          Category/scale breakdown");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Stamp & Portal â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  paste-stamp <sX1> <sY1> <sX2> <sY2> <dX> <dY>  Copy & paste terrain");
        Console.WriteLine("  snap-portal <lbX> <lbY> <cell> <poly> <env> <struct>  Snap dungeon cell to portal");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Bulk & Detail Queries â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  get-bulk-heightmap <minX> <minY> <maxX> <maxY>  Multi-landblock heightmaps");
        Console.WriteLine("  get-object-detail <objectId>                   DAT model geometry info");
        Console.WriteLine("  diff-terrain <lbX> <lbY>                       Compare terrain vs base DAT");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Terrain Layers â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  get-terrain-layers <lbX> <lbY>                 Terrain type distribution");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• DAT Extensions â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  export-textures <outputDir> [minId] [maxId]    Export textures to PNG");
        Console.WriteLine("  import-texture <textureId> <imagePath>         Replace texture from file (immediate, permanent in-place write to base client_portal.dat)");
        Console.WriteLine("  clone-dat <outputPath>                         Clone portal DAT");
        Console.WriteLine("  defragment-dat <portal|cell|local> <outPath>   Defragment a DAT file");
        Console.WriteLine("  obj-export <datId> <output.obj>                Setup/GfxObj → Wavefront .obj");
        Console.WriteLine("  obj-import <input.obj> <surfaceDid> [gfx] [setup]  .obj → GfxObj+Setup (staged in PortalDatDocument)");
        Console.WriteLine("  bsp-build <gfxObjId>                           Rebuild Physics+Drawing BSP for a GfxObj");
        Console.WriteLine("  weenie-snapshot <classId>                      Read scalar weenie properties from ACE DB");
        Console.WriteLine("  weenie-template-list <bundle.json>             List weenie templates in a JSON bundle");
        Console.WriteLine("  weenie-template-apply <bundle.json> <id> <classId>  Apply template scalars to a weenie");
        Console.WriteLine("  worldgen [--seed n] [--size w h] [--towns n] [--out plan.json] [--apply]  Run WorldGen pipeline");
        Console.WriteLine("  worldgen-analyze-buildings [--out catalog.json]                  Scan DATs for placeable building models");
        Console.WriteLine("  worldgen-scan-retail-towns [--out stats.json]                    Scan DATs for retail-style town models");
        Console.WriteLine("  compare-to-retail <generated.jsonl> [--retail-baseline path]     Score generated world vs retail (subprocess)");
        Console.WriteLine("  transact <ops.json>                            Stage/validate/commit a batch of mutating commands; rollback on failure");
        Console.WriteLine("  transact-diff <txId> [--render] [--mode overlay|side-by-side|after-only-with-diff] [--lb X,Y]... [--res N] [--out path]");
        Console.WriteLine("                                                Structured before/after report for a committed transaction (writes PNG with --out, returns base64 otherwise)");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Ontology Export & Enrichment â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  export-ontology <outputPath>                   Export ontology to CSV");
        Console.WriteLine("  export-setup-parts <outputPath>                Export Setup -> Parts (GfxObj) JSONL");
        Console.WriteLine("  export-classification-signals <outputPath>     Export building/scenery setup IDs (JSON)");
        Console.WriteLine("  mine-strings [outputPath] [filter]             Extract DAT StringTable strings");
        Console.WriteLine("  enrich-ontology                                Enrich ontology with schema data");
        Console.WriteLine("  import-catalog <index.json>                    Import ACViewer catalog into ontology");
        Console.WriteLine("  classify-ontology                              Auto-tag from StringTable names");
        Console.WriteLine("  enrich-materials                               Tag materials from textures");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• LSD Data Ingestion â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  ingest-weenies <lsd-path> [output]             Batch-extract weenie data to summary");
        Console.WriteLine("  enrich-weenies <summary-path>                  Merge weenie data into live ontology");
        Console.WriteLine("  enrich-canonical <json-path>                   Merge canonical enrichment (arch/biome/behavior)");
        Console.WriteLine("  enrich-unified <json-path>                     Merge unified ontology (full stack: canonical + ACE world + parts + DAT signals + geometry)");
        Console.WriteLine("  cache-ontology [outputPath]                    Persist live ontology to JSONL (default <project_dir>/ontology_cache.jsonl)");
        Console.WriteLine("  load-ontology-cache [inputPath]                Restore ontology from a JSONL cache (auto-runs on 'load' if cache file exists)");
        Console.WriteLine("  scan-building-placements [output]               Extract building positions for culture mapping");
        Console.WriteLine("  difficulty-gradient [json-path]                 Load & validate difficulty gradient");
        Console.WriteLine("  apply-population <plan-path> [--dry-run]        Apply population plan to world");
        Console.WriteLine("  ingest-spawn-maps <lsd-path> [output]          Extract spawn placement data");
        Console.WriteLine("  ingest-spells <lsd-path> [output]              Parse spells.json to summary");
        Console.WriteLine("  ingest-recipes <lsd-path> [output]             Batch-extract recipe data to summary");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Benchmark & Bulk Operations â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  benchmark                                        Run speed test suite");
        Console.WriteLine("  set-landblock-heightmap <lbX> <lbY> <h1,h2,...>   Set all 81 heights at once");
        Console.WriteLine("  set-landblock-terrain <lbX> <lbY> <t1,t2,...>     Set all 81 terrain types");
        Console.WriteLine("  import-heightmap <png> <sX> <sY> <cX> <cY> [--apply]  Import heightmap+colormap PNG to LB grid");
        Console.WriteLine("  import-render-surface <png> <0x06...>     Replace a RenderSurface (default: store; --ui: portal-doc)");
        Console.WriteLine("  bulk-place-objects <lbX> <lbY> <json-array>       Place multiple objects");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Procedural Generation â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  generate-terrain <seed> [oct] [lac] [per] [amp]  Generate full-world heightmap + auto-paint");
        Console.WriteLine("     coastline via JSON:  generate-terrain 42 6 2 0.5 128 \"[[x,y],[x,y],...]\"");
        Console.WriteLine("  generate-dungeon <lbX> <lbY> [depth] [branching] [seed]  Generate procedural dungeon");
        Console.WriteLine("     depth=8, branching=2.0, seed=0 (random). Full: generate-dungeon 1 217 8 2.0 42");
        Console.WriteLine("  auto-paint                                       Re-paint terrain types from heightmap");
        Console.WriteLine("  analyze-landblock-patterns [minX minY maxX maxY] [output]  Extract spatial design patterns");
        Console.WriteLine("  extract-building-pairings [minCount5=3] [output]  Mine retail Structure×Structure adjacency → building_pairings.json");
        Console.WriteLine("  load-building-pairings <path>          Load building_pairings.json into the live registry");
        Console.WriteLine("  export-training-data [minX minY maxX maxY] [output] [nearbyN]  Export placement examples as JSONL");
        Console.WriteLine("  export-raw-world-facts [minX minY maxX maxY] [output] [--ace-db] [--links]  Export raw DAT/SQL/spawn facts");
        Console.WriteLine("  export-envcell-components [minX minY maxX maxY] [output]  Export linked surface-anchor and EnvCell components");
        Console.WriteLine("  generate-settlement <template> <cx> <cy> [seed]  Place settlement from constraint templates");
        Console.WriteLine("  extract-retail-heightmaps [output.jsonl]           Dump all 255Ã—255 landblock heightmaps");
        Console.WriteLine("  compute-vanilla-baseline [output.json]             Compute retail quality baseline metrics");
        Console.WriteLine("  render-preview <lbX> <lbY> [r] [res] [--no-overlay] [--out path]   Top-down PNG of an N×N region (terrain + objects + cliff overlay)");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("=== Living Atlas ===");
        Console.ResetColor();
        Console.WriteLine("  describe-landblock <lbX> <lbY>                               Verbal + structured description (terrain, structures, spawns, POIs, validation)");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("=== Tile Pyramid (visual, sourced from render-preview) ===");
        Console.ResetColor();
        Console.WriteLine("  get-tile lb <lbX> <lbY> [--out path]                         Cached LB tile (PNG); generates on miss, JPEG q85 ~20 KB");
        Console.WriteLine("  get-tile region <region-name> [--out path]                   Region tile, e.g. \"Aluvian Heartlands\"");
        Console.WriteLine("  get-tile world [--out path]                                  Composite world tile (~150 KB JPEG)");
        Console.WriteLine("  tile-stats                                                   Tile-cache counts, dirty flags, disk used vs. budget");
        Console.WriteLine("  list-dirty-tiles                                             LBs whose tiles need regeneration after recent edits");
        Console.WriteLine("  regenerate-dirty-tiles                                       Rebuild every dirty tile and clear the dirty bits");
        Console.WriteLine("  mark-tiles-clean                                             Force-clear dirty bits without regenerating");
        Console.WriteLine("  prune-tiles [--keep-newest N] [--older-than ISO8601]         LRU prune the LB-tile layer (region+world pinned)");
        Console.WriteLine("  generate-atlas-tiles <lbs|regions|world|all> [lbX lbY ...]   Bulk-generate tiles; 'all' sweeps every LB (slow)");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Image-Driven Terrain â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  analyze-map-image <image.png> [output.json]         Classify world map into 255Ã—255 biome grid");
        Console.WriteLine("  calibrate-world-map [output.json]                   Build colorâ†’terrain codebook from retail DATs");
        Console.WriteLine("  quick-world <codebook.json> <map.png> [seed]                    Reverse-engineer world from image");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Building Remap â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  remap-buildings <lb_remap.json> <out_dir> [--apply]  Move buildings + SQL");
        Console.WriteLine("  remap-buildings-v2 <lb_remap.json> [--flatten-radius=N] [--flatten-strength=S] [--no-validate] [--preserve-retail-z]  Footprint-aware flush placement; doors ride buildings");
        Console.WriteLine("  remap-buildings-sql <lb_remap.json> <export_dir> <out.sql> [--apply]  Interior cell remap SQL");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• ACE Database â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  ace-db connect <host> <port> <db> <user> <pass>   Test + save DB connection");
        Console.WriteLine("  ace-db status                                      Show settings + test connectivity");
        Console.WriteLine("  ace-db query-instances <landblockId>                List instances in a landblock (hex)");
        Console.WriteLine("  ace-db reposition                                  Reposition instances after terrain edits");
        Console.WriteLine("  ace-db export-sql <path>                           Export reposition SQL (no apply)");
        Console.WriteLine("  ace-db stats                                       World instance count + dense landblocks");
        Console.WriteLine("  ace-db clear-instances                             Delete ALL instances + links");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• Dungeon Document Operations â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  dungeon add-cell <lbX> <lbY> <envId> <csId> <x> <y> <z>  Add cell to dungeon");
        Console.WriteLine("  dungeon remove-cell <lbX> <lbY> <cellNum>                Remove cell (hex)");
        Console.WriteLine("  dungeon connect <lbX> <lbY> <cellA> <polyA> <cellB> <polyB>  Connect two cells via portals");
        Console.WriteLine("  dungeon disconnect <lbX> <lbY> <cellA> <cellB>            Disconnect cells");
        Console.WriteLine("  dungeon validate <lbX> <lbY>                              Run comprehensive validation");
        Console.WriteLine("  dungeon autofix <lbX> <lbY>                               Auto-fix one-way portals");
        Console.WriteLine("  dungeon recompute <lbX> <lbY>                             Recompute visible cells + portal flags");
        Console.WriteLine("  dungeon reload <lbX> <lbY>                                Reload from DAT (discard edits)");
        Console.WriteLine("  dungeon copy-cells <srcX> <srcY> <destX> <destY>          Copy dungeon cells to another landblock");
        Console.WriteLine("  dungeon move-cell <lbX> <lbY> <cellNum> <dX> <dY> <dZ>    Translate a cell");
        Console.WriteLine("  dungeon rotate-cell <lbX> <lbY> <cellNum> <deg> <ax> <ay> <az>  Rotate a cell around axis");
        Console.WriteLine("  dungeon move-object <lbX> <lbY> <cellNum> <idx> <dX> <dY> <dZ>  Translate static object");
        Console.WriteLine("  dungeon rotate-object <lbX> <lbY> <cellNum> <idx> <deg>   Rotate static object around Z");
        Console.WriteLine("  dungeon set-cell-position <lbX> <lbY> <cellNum> <x> <y> <z>      Set absolute cell position");
        Console.WriteLine("  dungeon set-cell-rotation <lbX> <lbY> <cellNum> <rx> <ry> <rz>   Set absolute cell Euler rotation");
        Console.WriteLine("  dungeon set-object-position <lbX> <lbY> <cellNum> <idx> <x> <y> <z>   Set absolute object position");
        Console.WriteLine("  dungeon set-object-rotation <lbX> <lbY> <cellNum> <idx> <deg>    Set absolute object Z rotation");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("â•â•â• General â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  help                           Show this help message");
        Console.WriteLine("  quit / exit                    Exit the terminal");
        Console.WriteLine();
        Console.WriteLine("Paths with spaces should be wrapped in quotes:");
        Console.WriteLine("  load \"C:\\My Projects\\demo.wbproj\"");
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Tokenizer (handles quoted strings)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// <summary>
    /// Splits a command line into tokens, respecting double-quoted strings
    /// so that paths containing spaces are treated as a single argument.
    /// </summary>
    internal static string[] TokenizeLine(string line) {
        var tokens = new List<string>(8);
        var currentToken = new StringBuilder();
        bool inQuotes = false;
        // Mid-token quote pairs (e.g. JSON like [{"k":"v"}]) keep their quote
        // characters so the resulting token is still valid JSON. Boundary
        // quote pairs (e.g. "path with spaces") are stripped as before.
        bool preserveCurrentQuotes = false;
        // Track JSON bracket nesting so whitespace inside [...] / {...} stays
        // glued into a single token without forcing the user to wrap the whole
        // expression in shell quotes.
        int bracketDepth = 0;

        foreach (char c in line) {
            if (c == '"') {
                if (inQuotes) {
                    if (preserveCurrentQuotes) currentToken.Append(c);
                    inQuotes = false;
                    preserveCurrentQuotes = false;
                } else {
                    preserveCurrentQuotes = currentToken.Length > 0 || bracketDepth > 0;
                    if (preserveCurrentQuotes) currentToken.Append(c);
                    inQuotes = true;
                }
                continue;
            }

            if (!inQuotes) {
                if (c == '[' || c == '{') bracketDepth++;
                else if ((c == ']' || c == '}') && bracketDepth > 0) bracketDepth--;
            }

            if (char.IsWhiteSpace(c) && !inQuotes && bracketDepth == 0) {
                if (currentToken.Length > 0) {
                    tokens.Add(currentToken.ToString());
                    currentToken.Clear();
                }
                continue;
            }

            currentToken.Append(c);
        }

        if (currentToken.Length > 0) {
            tokens.Add(currentToken.ToString());
        }
        return tokens.ToArray();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  New command handlers
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleGetTerrainLayers(string[] tokens) {
        if (tokens.Length < 3) { Console.WriteLine("Usage: get-terrain-layers <lbX> <lbY>"); return; }
        uint lbX = uint.Parse(tokens[1]), lbY = uint.Parse(tokens[2]);
        var r = _engine.GetTerrainLayers(lbX, lbY);
        if (!r.Found) { Console.WriteLine($"No terrain data for landblock 0x{r.LbKey:X4}."); return; }
        Console.WriteLine($"Landblock 0x{r.LbKey:X4}: {r.TotalVertices} vertices");
        Console.WriteLine($"  {"Type",-6} {"Name",-20} {"Count",-8} {"Pct",6}");
        Console.WriteLine($"  {new string('-', 6)} {new string('-', 20)} {new string('-', 8)} {new string('-', 6)}");
        foreach (var l in r.Layers!) {
            Console.WriteLine($"  {l.TypeIndex,-6} {(l.Name ?? "?"),-20} {l.VertexCount,-8} {l.Percentage,5:F1}%");
        }
    }

    private void HandleExportTextures(string[] tokens) {
        if (tokens.Length < 2) { Console.WriteLine("Usage: export-textures <outputDir> [minId] [maxId]"); return; }
        string outputDir = tokens[1];
        uint? minId = tokens.Length > 2 ? Convert.ToUInt32(tokens[2], 16) : null;
        uint? maxId = tokens.Length > 3 ? Convert.ToUInt32(tokens[3], 16) : null;
        Console.WriteLine("Exporting textures... this may take a while.");
        var r = _engine.ExportTextures(outputDir, minId, maxId);
        Console.WriteLine($"Exported: {r.Exported}, Failed: {r.Failed}");
        Console.WriteLine($"Output: {r.OutputDirectory}");
        if (r.Errors != null) foreach (var e in r.Errors) Console.WriteLine($"  ERROR: {e}");
    }

    private void HandleImportTexture(string[] tokens) {
        if (tokens.Length < 3) { Console.WriteLine("Usage: import-texture <textureIdHex> <imagePath>"); return; }
        uint textureId = Convert.ToUInt32(tokens[1], 16);
        string imagePath = tokens[2];
        var r = _engine.ImportTexture(textureId, imagePath);
        if (r.Success) Console.WriteLine($"Texture 0x{r.TextureId:X8} updated from {r.InputFile}");
        else Console.WriteLine($"Failed: {r.Error}");
    }

    private void HandleCloneDat(string[] tokens) {
        if (tokens.Length < 2) { Console.WriteLine("Usage: clone-dat <outputPath>"); return; }
        var r = _engine.CloneDat(tokens[1]);
        if (r.Success) Console.WriteLine($"Cloned {r.SourcePath} â†’ {r.DestPath}");
        else Console.WriteLine($"Failed: {r.Error}");
    }

    private void HandleDefragmentDat(string[] tokens) {
        if (tokens.Length < 3) { Console.WriteLine("Usage: defragment-dat <portal|cell|local> <outputPath>"); return; }
        Console.WriteLine("Defragmenting... this may take a while.");
        var r = _engine.DefragmentDat(tokens[1], tokens[2]);
        if (r.Success) Console.WriteLine($"Defragmented {r.DatType} â†’ {r.OutputPath} ({r.BytesFreed:N0} bytes freed)");
        else Console.WriteLine($"Failed: {r.Error}");
    }

    private void HandleExportOntology(string[] tokens) {
        if (tokens.Length < 2) { Console.WriteLine("Usage: export-ontology <outputPath>"); return; }
        var r = _engine.ExportOntology(tokens[1]);
        Console.WriteLine($"Exported {r.EntriesExported} entries to {r.OutputPath}");
    }

    private void HandleExportSetupParts(string[] tokens) {
        if (tokens.Length < 2) { Console.WriteLine("Usage: export-setup-parts <outputPath>"); return; }
        var r = _engine.ExportSetupParts(tokens[1]);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Failed: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine($"Exported {r.SetupsExported}/{r.SetupsScanned} setups, {r.TotalParts} parts ({r.UniqueParts} unique GfxObj ids) to {r.OutputPath}");
    }

    private void HandleExportClassificationSignals(string[] tokens) {
        if (tokens.Length < 2) { Console.WriteLine("Usage: export-classification-signals <outputPath>"); return; }
        var r = _engine.ExportClassificationSignals(tokens[1]);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Failed: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine($"Exported {r.BuildingModelCount} building model ids ({r.LandBlockInfoScanned} LBI scanned), {r.ScenerySetupCount} scenery setup ids ({r.ScenesScanned} scenes scanned) to {r.OutputPath}");
    }

    private void HandleMineStrings(string[] tokens) {
        string? outputPath = tokens.Length >= 2 ? tokens[1] : null;
        string? filter = tokens.Length >= 3 ? tokens[2] : null;
        Console.WriteLine("Mining StringTable data from DAT files...");
        var r = _engine.MineStrings(outputPath, filter);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  â•â•â• StringTable Mining Results â•â•â•");
        Console.WriteLine($"  Tables scanned  : {r.TablesScanned}");
        Console.WriteLine($"  Strings found   : {r.TotalStrings}");
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Exported to     : {r.OutputPath}");
        Console.WriteLine();

        // Show a sample of strings grouped by table type
        var groups = r.Strings.GroupBy(s => s.TableType).OrderByDescending(g => g.Count());
        foreach (var g in groups) {
            Console.WriteLine($"  {g.Key}: {g.Count()} string(s)");
            foreach (var s in g.Take(5))
                Console.WriteLine($"    0x{s.Hash:X8}: {(s.Text.Length > 80 ? s.Text[..77] + "..." : s.Text)}");
            if (g.Count() > 5)
                Console.WriteLine($"    ... and {g.Count() - 5} more");
        }
        Console.WriteLine();
    }

    private void HandleEnrichOntology() {
        Console.WriteLine("Enriching ontology with curated schema data...");
        var r = _engine.EnrichOntology();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  â•â•â• Ontology Enrichment Complete â•â•â•");
        Console.WriteLine($"  Entries enriched : {r.EntriesEnriched}");
        Console.WriteLine($"  Total entries    : {r.TotalEntries}");
        Console.WriteLine();
    }

    private void HandleImportCatalog(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: import-catalog <path-to-index.json>");
            Console.WriteLine("  Imports ACViewer catalog metadata (thumbnails, surfaces) into ontology.");
            Console.WriteLine("  Requires: scan-ontology must be run first.");
            Console.WriteLine("  Example: import-catalog \"C:\\catalog\\index.json\"");
            return;
        }
        Console.WriteLine($"Importing catalog from: {tokens[1]}");
        var r = _engine.ImportCatalog(tokens[1]);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  â•â•â• Catalog Import Complete â•â•â•");
        Console.WriteLine($"  Entries enriched : {r.EntriesEnriched}");
        Console.WriteLine($"  Total entries    : {r.TotalEntries}");
        Console.WriteLine($"  Index path       : {r.IndexPath}");
        Console.WriteLine();
    }

    private void HandleClassifyOntology() {
        Console.WriteLine("Classifying ontology entries from StringTable data...");
        Console.WriteLine("(This mines strings then cross-references with ontology)");
        var r = _engine.ClassifyOntology();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  â•â•â• Ontology Classification Complete â•â•â•");
        Console.WriteLine($"  Strings used     : {r.StringsUsed}");
        Console.WriteLine($"  Entries enriched : {r.EntriesEnriched}");
        Console.WriteLine($"  Total entries    : {r.TotalEntries}");
        Console.WriteLine();
    }

    private void HandleEnrichMaterials() {
        Console.WriteLine("Analyzing textures to classify materials...");
        var r = _engine.EnrichMaterials();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  â•â•â• Material Enrichment Complete â•â•â•");
        Console.WriteLine($"  Entries enriched : {r.EntriesEnriched}");
        Console.WriteLine($"  Total entries    : {r.TotalEntries}");
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  LSD Data Ingestion Pipeline
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleIngestWeenies(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: ingest-weenies <lsd-path> [output-path]");
            Console.WriteLine("  Batch-extracts all weenie JSON files to a summary file.");
            Console.WriteLine("  Example: ingest-weenies LSD-Partial-2025-02-23_16-15");
            return;
        }
        string? outputPath = tokens.Length >= 3 ? tokens[2] : null;
        Console.WriteLine($"Ingesting weenies from: {tokens[1]}");
        var r = _engine.IngestWeenies(tokens[1], outputPath);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  â•â•â• Weenie Ingestion Complete â•â•â•");
        Console.WriteLine($"  Total processed  : {r.TotalProcessed}");
        Console.WriteLine($"  Creatures        : {r.CreatureCount}");
        Console.WriteLine($"  NPCs             : {r.NpcCount}");
        Console.WriteLine($"  Items            : {r.ItemCount}");
        Console.WriteLine($"  Other            : {r.OtherCount}");
        Console.WriteLine($"  With SetupDID    : {r.WithSetupDid}");
        Console.WriteLine($"  Output file      : {r.OutputPath}");
        Console.WriteLine();
    }

    private void HandleEnrichWeenies(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: enrich-weenies <summary-path>");
            Console.WriteLine("  Merges weenie summary data into the live ontology.");
            Console.WriteLine("  Prerequisite: scan-ontology + ingest-weenies must be run first.");
            return;
        }
        Console.WriteLine($"Enriching ontology from weenie data: {tokens[1]}");
        var r = _engine.EnrichWeenies(tokens[1]);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  â•â•â• Weenie Enrichment Complete â•â•â•");
        Console.WriteLine($"  Entries enriched : {r.EntriesEnriched}");
        Console.WriteLine($"  Total entries    : {r.TotalEntries}");
        Console.WriteLine();
    }

    private void HandleCacheOntology(string[] tokens) {
        string outputPath = tokens.Length >= 2 ? tokens[1] : _engine.DefaultOntologyCachePath();
        var r = _engine.CacheOntology(outputPath);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Failed: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine($"Cached {r.EntriesCached} ontology entries to {r.OutputPath}");
    }

    private void HandleLoadOntologyCache(string[] tokens) {
        string inputPath = tokens.Length >= 2 ? tokens[1] : _engine.DefaultOntologyCachePath();
        var r = _engine.LoadOntologyCache(inputPath);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Failed: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine($"Loaded {r.EntriesLoaded} ontology entries from {r.InputPath}");
    }

    private void HandleEnrichUnified(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: enrich-unified <unified-ontology-json>");
            Console.WriteLine("  Merges the unified ontology (canonical + ACE world DB +");
            Console.WriteLine("  Setup→Parts inheritance + DAT building/scenery signals + geometry)");
            Console.WriteLine("  produced by scripts/build_unified_ontology.py.");
            Console.WriteLine("  Prerequisite: scan-ontology must be run first.");
            Console.WriteLine("  Example: enrich-unified pipeline_data/enrichment/unified_ontology.json");
            return;
        }
        Console.WriteLine($"Enriching ontology from unified data: {tokens[1]}");
        var r = _engine.EnrichUnified(tokens[1]);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  === Unified Enrichment Complete ===");
        Console.WriteLine($"  Entries enriched : {r.EntriesEnriched}");
        Console.WriteLine($"  Total entries    : {r.TotalEntries}");
        Console.WriteLine();
    }

    private void HandleEnrichCanonical(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: enrich-canonical <canonical-json-path>");
            Console.WriteLine("  Merges canonical enrichment data (architecture, biome, behavior, etc.)");
            Console.WriteLine("  from build_ontology_enrichment.py into the live ontology.");
            Console.WriteLine("  Prerequisite: scan-ontology must be run first.");
            Console.WriteLine("  Example: enrich-canonical canonical_enrichment.json");
            return;
        }
        Console.WriteLine($"Enriching ontology from canonical data: {tokens[1]}");
        var r = _engine.EnrichCanonical(tokens[1]);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  === Canonical Enrichment Complete ===");
        Console.WriteLine($"  Entries enriched : {r.EntriesEnriched}");
        Console.WriteLine($"  Total entries    : {r.TotalEntries}");
        Console.WriteLine($"  Source file      : {r.CanonicalPath}");
        Console.WriteLine();
    }

    private void HandleScanBuildingPlacements(string[] tokens) {
        string? outputPath = tokens.Length >= 2 ? tokens[1] : null;
        Console.WriteLine("Scanning all retail landblocks for building placements...");
        Console.WriteLine("(This scans 255Ã—255 landblocks for BuildingInfo records)");
        var r = _engine.ScanBuildingPlacements(outputPath);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  === Building Placement Scan Complete ===");
        Console.WriteLine($"  Total buildings       : {r.TotalBuildings}");
        Console.WriteLine($"  Unique Setup IDs      : {r.UniqueSetupIds}");
        Console.WriteLine($"  Landblocks w/buildings: {r.LandblocksWithBuildings}");
        Console.WriteLine($"  Elapsed               : {r.ElapsedMs:F0} ms");
        Console.WriteLine($"  Output                : {r.OutputPath}");
        Console.WriteLine();
        Console.WriteLine("  Next step: run scripts/scan_building_cultures.py to geocode");
        Console.WriteLine("  buildings to cultural architectures.");
        Console.WriteLine();
    }

    private void HandleDifficultyGradient(string[] tokens) {
        string? gradientPath = tokens.Length >= 2 ? tokens[1] : null;
        var r = _engine.LoadDifficultyGradient(gradientPath);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  === Difficulty Gradient Loaded ===");
        Console.WriteLine($"  Source: {r.GradientPath}");
        Console.WriteLine();
        Console.WriteLine("  Tier Distribution:");
        foreach (var kv in r.TierDistribution)
            Console.WriteLine($"    {kv.Key,-12} {kv.Value,6} landblocks");
        Console.WriteLine();
    }

    private void HandleApplyPopulation(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: apply-population <plan-path> [--dry-run]");
            Console.WriteLine("  plan-path: path to population_plan.json");
            Console.WriteLine("  --dry-run: report what would be placed without modifying data");
            return;
        }
        string planPath = tokens[1];
        bool dryRun = tokens.Any(t => t == "--dry-run");

        if (dryRun)
            Console.WriteLine("DRY RUN: No data will be modified.");

        Console.WriteLine($"Applying population plan: {planPath}");
        var r = _engine.ApplyPopulation(planPath, dryRun);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  === Population {(dryRun ? "Plan Preview" : "Applied")} ===");
        Console.WriteLine($"  Landblocks modified: {r.LandblocksModified}");
        Console.WriteLine($"  Objects placed:      {r.ObjectsPlaced}");
        Console.WriteLine($"  Objects skipped:     {r.ObjectsSkipped} (creatures need server-side spawns)");
        Console.WriteLine($"  Elapsed:             {r.ElapsedMs:F0} ms");
        Console.WriteLine();
        if (r.ObjectsSkipped > 0)
            Console.WriteLine("  NOTE: Creature placements are in the plan but require ACE server");
            Console.WriteLine("  weenie spawn entries. Export the plan's creature entries to SQL.");
        Console.WriteLine();
    }

    private void HandleIngestSpawnMaps(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: ingest-spawn-maps <lsd-path> [output-path]");
            Console.WriteLine("  Extracts spatial placement data from spawn map files.");
            Console.WriteLine("  Example: ingest-spawn-maps LSD-Partial-2025-02-23_16-15");
            return;
        }
        string? outputPath = tokens.Length >= 3 ? tokens[2] : null;
        Console.WriteLine($"Ingesting spawn maps from: {tokens[1]}");
        var r = _engine.IngestSpawnMaps(tokens[1], outputPath);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  â•â•â• Spawn Map Ingestion Complete â•â•â•");
        Console.WriteLine($"  Total processed  : {r.TotalProcessed}");
        Console.WriteLine($"  Total weenies    : {r.TotalWeenies}");
        Console.WriteLine($"  Total links      : {r.TotalLinks}");
        Console.WriteLine($"  Unique WCIDs     : {r.UniqueWcids}");
        Console.WriteLine($"  Output file      : {r.OutputPath}");
        Console.WriteLine();
    }

    private void HandleIngestSpells(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: ingest-spells <lsd-path> [output-path]");
            Console.WriteLine("  Parses spells.json and extracts spell data.");
            Console.WriteLine("  Example: ingest-spells LSD-Partial-2025-02-23_16-15");
            return;
        }
        string? outputPath = tokens.Length >= 3 ? tokens[2] : null;
        Console.WriteLine($"Ingesting spells from: {tokens[1]}");
        var r = _engine.IngestSpells(tokens[1], outputPath);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  â•â•â• Spell Ingestion Complete â•â•â•");
        Console.WriteLine($"  Total processed  : {r.TotalProcessed}");
        Console.WriteLine($"  Schools:");
        foreach (var kv in r.SchoolCounts.OrderByDescending(kv => kv.Value))
            Console.WriteLine($"    School {kv.Key,-5} {kv.Value,6}");
        Console.WriteLine($"  Output file      : {r.OutputPath}");
        Console.WriteLine();
    }

    private void HandleIngestRecipes(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: ingest-recipes <lsd-path> [output-path]");
            Console.WriteLine("  Batch-extracts all recipe JSON files to a summary file.");
            Console.WriteLine("  Example: ingest-recipes LSD-Partial-2025-02-23_16-15");
            return;
        }
        string? outputPath = tokens.Length >= 3 ? tokens[2] : null;
        Console.WriteLine($"Ingesting recipes from: {tokens[1]}");
        var r = _engine.IngestRecipes(tokens[1], outputPath);
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {r.Error}");
            Console.ResetColor();
            return;
        }
        Console.WriteLine();
        Console.WriteLine($"  â•â•â• Recipe Ingestion Complete â•â•â•");
        Console.WriteLine($"  Total processed  : {r.TotalProcessed}");
        Console.WriteLine($"  With precursors  : {r.WithPrecursors}");
        Console.WriteLine($"  Unique sources   : {r.UniqueSourceWcids} WCIDs (tools+targets)");
        Console.WriteLine($"  Unique results   : {r.UniqueResultWcids} WCIDs");
        Console.WriteLine($"  Skills:");
        foreach (var kv in r.SkillCounts.OrderByDescending(kv => kv.Value))
            Console.WriteLine($"    Skill {kv.Key,-5} {kv.Value,6}");
        Console.WriteLine($"  Output file      : {r.OutputPath}");
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Benchmark & Bulk Operations
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleBenchmark() {
        if (!CheckProject()) return;
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• WorldBuilder Benchmark Suite â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  Running 2000Ã— set-height, 2000Ã— add-object, 50Ã— validate-all, 500Ã— bulk heightmap...");
        Console.WriteLine();

        var r = _engine.RunBenchmark();

        // Test results table
        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine($"  {"Test",-35} {"Ops",-8} {"Time (ms)",-12} {"Ops/sec",-12} {"First-500",-12} {"Last-500",-12} {"Degrad."}");
        Console.ResetColor();
        Console.WriteLine($"  {new string('-', 100)}");
        foreach (var t in r.Tests) {
            Console.Write($"  {t.Name,-35} {t.Operations,-8} {t.ElapsedMs,-12:F1} {t.OpsPerSec,-12:F1}");
            Console.Write(t.FirstSegmentOpsPerSec.HasValue ? $" {t.FirstSegmentOpsPerSec,-12:F1}" : $" {"â€”",-12}");
            Console.Write(t.LastSegmentOpsPerSec.HasValue ? $" {t.LastSegmentOpsPerSec,-12:F1}" : $" {"â€”",-12}");
            if (t.DegradationPercent.HasValue) {
                Console.ForegroundColor = Math.Abs(t.DegradationPercent.Value) > 20 ? ConsoleColor.Red : ConsoleColor.Green;
                Console.Write($" {t.DegradationPercent:F1}%");
                Console.ResetColor();
            } else {
                Console.Write(" â€”");
            }
            Console.WriteLine();
        }

        // Memory
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("  Memory Snapshots:");
        Console.ResetColor();
        foreach (var m in r.Memory) {
            Console.WriteLine($"    {m.Label,-25} {m.Bytes / 1024.0 / 1024.0:F1} MB ({m.Bytes:N0} bytes)");
        }

        // GC
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("  GC Collections:");
        Console.ResetColor();
        Console.WriteLine($"    Gen0: {r.GcAfter.Gen0 - r.GcBefore.Gen0}  Gen1: {r.GcAfter.Gen1 - r.GcBefore.Gen1}  Gen2: {r.GcAfter.Gen2 - r.GcBefore.Gen2}");

        // Extrapolation
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("  Full-Scale Extrapolation (65,025 landblocks):");
        Console.ResetColor();
        Console.WriteLine($"    Per-vertex terrain pass ({r.Extrapolation.TotalVertexWrites:N0} writes): {r.Extrapolation.EstimatedTerrainPassFormatted}");
        if (r.Extrapolation.EstimatedBulkTerrainPassFormatted != null)
            Console.WriteLine($"    Bulk terrain pass ({r.Extrapolation.TotalLandblocks:N0} landblocks): {r.Extrapolation.EstimatedBulkTerrainPassFormatted}");
        Console.WriteLine($"    Object placement ({r.Extrapolation.TotalObjectPlacements:N0} objects): {r.Extrapolation.EstimatedObjectPassFormatted}");

        Console.WriteLine();
        // Feasibility color
        if (r.Extrapolation.Feasibility.StartsWith("GREEN"))
            Console.ForegroundColor = ConsoleColor.Green;
        else if (r.Extrapolation.Feasibility.StartsWith("YELLOW"))
            Console.ForegroundColor = ConsoleColor.Yellow;
        else
            Console.ForegroundColor = ConsoleColor.Red;
        Console.WriteLine($"  Assessment: {r.Extrapolation.Feasibility}");
        Console.ResetColor();
        Console.WriteLine();
    }

    private void HandleSetLandblockHeightmap(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: set-landblock-heightmap <lbX> <lbY> <h1,h2,...h81>");
            Console.WriteLine("  81 comma-separated byte values (0-255)");
            Console.WriteLine("  Example: set-landblock-heightmap 7 16 128,128,128,...");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;

        var parts = tokens[3].Split(',');
        if (parts.Length != 81) {
            Console.WriteLine($"Error: Expected 81 height values, got {parts.Length}.");
            return;
        }
        var heights = new byte[81];
        for (int i = 0; i < 81; i++) {
            if (!byte.TryParse(parts[i].Trim(), out heights[i])) {
                Console.WriteLine($"Error: Invalid height value '{parts[i].Trim()}' at index {i}.");
                return;
            }
        }

        var r = _engine.SetLandblockHeightmap(lbX, lbY, heights);
        Console.WriteLine($"Set {r.VerticesModified} heights in landblock 0x{r.LbKey:X4}");
        if (r.ModifiedLandblocks.Count > 0)
            Console.WriteLine($"  Modified {r.ModifiedLandblocks.Count} landblock(s): {string.Join(", ", r.ModifiedLandblocks.Select(lb => $"0x{lb:X4}"))}");
    }

    private void HandleFreshStart(string[] tokens) {
        if (!CheckProject()) return;
        Console.Write("This will wipe all terrain to deep sea AND delete every dungeon. Type 'yes' to confirm: ");
        var input = Console.ReadLine();
        if (!string.Equals(input?.Trim(), "yes", StringComparison.OrdinalIgnoreCase)) {
            Console.WriteLine("Aborted.");
            return;
        }
        try {
            var r = _engine.FreshStartAsync().GetAwaiter().GetResult();
            Console.WriteLine($"Reset {r.LandblocksReset} landblock(s), {r.VerticesReset} vertices to WaterDeepSea.");
            Console.WriteLine("Dungeons deleted. SkipDatStatics restored to false.");
        }
        catch (Exception ex) {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }

    private void HandleGenerateWorld(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: generate-world [--params <json>] [--export-towns-csv <path>] [--apply]");
            Console.WriteLine("  Default is dry-run (returns counts only).");
            Console.WriteLine("  --params expects a JSON file matching WorldGeneratorParams.");
            return;
        }
        try {
            string? paramsPath = null, csvPath = null;
            bool apply = false;
            for (int i = 1; i < tokens.Length; i++) {
                if (tokens[i] == "--params" && i + 1 < tokens.Length) { paramsPath = tokens[i + 1]; i++; }
                else if (tokens[i] == "--export-towns-csv" && i + 1 < tokens.Length) { csvPath = tokens[i + 1]; i++; }
                else if (tokens[i] == "--apply") apply = true;
            }
            var p = paramsPath != null
                ? System.Text.Json.JsonSerializer.Deserialize<WorldBuilder.Shared.Lib.WorldGen.WorldGeneratorParams>(
                    System.IO.File.ReadAllText(paramsPath),
                    WorldBuilder.Shared.Lib.JsonOpts.CaseInsensitive)
                : new WorldBuilder.Shared.Lib.WorldGen.WorldGeneratorParams();
            if (p == null) { Console.WriteLine("Failed to parse --params JSON."); return; }

            var r = _engine.GenerateWorldAsync(p, apply, csvPath).GetAwaiter().GetResult();
            Console.WriteLine($"{(r.Applied ? "Applied" : "Dry-run")}: seed={r.Seed} {r.Towns} towns, {r.BuildingsPlaced} buildings, {r.DecorationsPlaced} decorations, {r.RoadVertices} road verts, {r.VerticesModified} terrain verts on {r.LandblocksAffected} LBs.");
            if (r.TownsCsvPath != null) Console.WriteLine($"  Towns CSV: {r.TownsCsvRows} rows → {r.TownsCsvPath}");
            int shown = 0;
            foreach (var t in r.TownSummaries) {
                Console.WriteLine($"  {t.Name} ({t.SizeLabel}) — LB ({t.CenterLbX},{t.CenterLbY}) — {t.BuildingCount} buildings");
                if (++shown >= 12 && r.TownSummaries.Count > 12) {
                    Console.WriteLine($"  … {r.TownSummaries.Count - shown} more");
                    break;
                }
            }
        }
        catch (Exception ex) {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }

    private void HandleExportTownsCsv(string[] tokens) {
        if (tokens.Length < 5) {
            Console.WriteLine("Usage: export-towns-csv --from-result <path> --out <path>");
            return;
        }
        try {
            string? fromResult = null, outPath = null;
            for (int i = 1; i < tokens.Length - 1; i++) {
                if (tokens[i] == "--from-result") fromResult = tokens[i + 1];
                else if (tokens[i] == "--out") outPath = tokens[i + 1];
            }
            if (fromResult == null || outPath == null) { Console.WriteLine("Both --from-result and --out are required."); return; }
            var r = _engine.ExportTownsCsv(fromResult, outPath);
            Console.WriteLine($"Wrote {r.Rows} rows → {r.OutPath}");
        }
        catch (Exception ex) {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }

    private void HandlePlacement(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: placement <list|add-outdoor|add-dungeon|remove|export-sql> ...");
            Console.WriteLine("  placement list [--lb <lbX> <lbY>] [--outdoor|--dungeon]");
            Console.WriteLine("  placement add-outdoor <lbX> <lbY> <wcid> <cellNum> <originX> <originY> <originZ> [--angles w x y z]");
            Console.WriteLine("  placement add-dungeon <lbX> <lbY> <wcid> <cellNum> <originX> <originY> <originZ> [--angles w x y z]");
            Console.WriteLine("  placement remove <outdoor|dungeon> <index>");
            Console.WriteLine("  placement export-sql [--out <dir>] [--apply] [--dry-run] [--force] [--no-validate]");
            return;
        }
        try {
            switch (tokens[1].ToLowerInvariant()) {
                case "list": {
                    int? lbX = null, lbY = null;
                    string kind = "all";
                    for (int i = 2; i < tokens.Length; i++) {
                        if (tokens[i] == "--lb" && i + 2 < tokens.Length
                            && int.TryParse(tokens[i + 1], out var x) && int.TryParse(tokens[i + 2], out var y))
                        { lbX = x; lbY = y; i += 2; }
                        else if (tokens[i] == "--outdoor") kind = "outdoor";
                        else if (tokens[i] == "--dungeon") kind = "dungeon";
                    }
                    var l = _engine.PlacementList(lbX, lbY, kind);
                    Console.WriteLine($"{l.Count} placement(s){(kind != "all" ? $" ({kind})" : "")}.");
                    int shown = 0;
                    foreach (var p in l.Placements) {
                        Console.WriteLine($"  [{p.Kind} #{p.Index}] {p.Landblock} wcid={p.Wcid} cell={p.CellNumber} @({p.OriginX:F2},{p.OriginY:F2},{p.OriginZ:F2})");
                        if (++shown >= 32 && l.Placements.Count > 32) {
                            Console.WriteLine($"  … {l.Placements.Count - shown} more");
                            break;
                        }
                    }
                    break;
                }
                case "add-outdoor":
                case "add-dungeon": {
                    if (tokens.Length < 9) {
                        Console.WriteLine($"Usage: placement {tokens[1]} <lbX> <lbY> <wcid> <cellNum> <originX> <originY> <originZ> [--angles w x y z]");
                        return;
                    }
                    if (!TryParseInt(tokens[2], "lbX", out var lbX)) return;
                    if (!TryParseInt(tokens[3], "lbY", out var lbY)) return;
                    if (!TryParseUint(tokens[4], "wcid", out var wcid)) return;
                    if (!ushort.TryParse(tokens[5], out var cell)) { Console.WriteLine("Bad cellNum"); return; }
                    if (!TryParseFloat(tokens[6], "originX", out var ox)) return;
                    if (!TryParseFloat(tokens[7], "originY", out var oy)) return;
                    if (!TryParseFloat(tokens[8], "originZ", out var oz)) return;
                    float? aw = null, ax = null, ay = null, az = null;
                    for (int i = 9; i < tokens.Length; i++) {
                        if (tokens[i] == "--angles" && i + 4 < tokens.Length
                            && float.TryParse(tokens[i + 1], out var w)
                            && float.TryParse(tokens[i + 2], out var x)
                            && float.TryParse(tokens[i + 3], out var y)
                            && float.TryParse(tokens[i + 4], out var z))
                        { aw = w; ax = x; ay = y; az = z; }
                    }
                    var r = tokens[1] == "add-outdoor"
                        ? _engine.PlacementAddOutdoor(lbX, lbY, wcid, cell, ox, oy, oz, aw, ax, ay, az)
                        : _engine.PlacementAddDungeon(lbX, lbY, wcid, cell, ox, oy, oz, aw, ax, ay, az);
                    Console.WriteLine($"{(r.Success ? "Added" : "Failed")}: {r.Kind} #{r.Index} on {r.Landblock}.");
                    break;
                }
                case "remove": {
                    if (tokens.Length < 4) { Console.WriteLine("Usage: placement remove <outdoor|dungeon> <index>"); return; }
                    if (!int.TryParse(tokens[3], out var idx)) { Console.WriteLine("Bad index"); return; }
                    var r = _engine.PlacementRemove(tokens[2], idx);
                    Console.WriteLine(r.Removed ? $"Removed {r.Kind} #{r.Index} from {r.Landblock}." : $"No {r.Kind} placement at index {r.Index}.");
                    break;
                }
                case "export-sql": {
                    string? outDir = null;
                    bool apply = false;
                    bool dryRun = false;
                    bool force = false;
                    bool validate = true;
                    for (int i = 2; i < tokens.Length; i++) {
                        if (tokens[i] == "--out" && i + 1 < tokens.Length) { outDir = tokens[i + 1]; i++; }
                        else if (tokens[i] == "--apply") apply = true;
                        else if (tokens[i] == "--dry-run") dryRun = true;
                        else if (tokens[i] == "--force") force = true;
                        else if (tokens[i] == "--no-validate") validate = false;
                    }
                    outDir ??= _engine.GetCurrentProjectDirectoryOrCwd();
                    var r = _engine.PlacementExportSqlAsync(outDir, apply, dryRun, force, validate).GetAwaiter().GetResult();
                    Console.WriteLine($"Wrote landblock_instances.sql ({r.OutdoorCount} rows) → {r.OutdoorPath}");
                    Console.WriteLine($"Wrote dungeon_instances.sql ({r.DungeonCount} rows) → {r.DungeonPath}");
                    if (r.EnrichedJsonlPath != null)
                        Console.WriteLine($"Wrote {WorldBuilder.Shared.Lib.AceDb.EnrichedPlacementStore.FileName} ({r.EnrichedCount} records) → {r.EnrichedJsonlPath}");
                    if (r.ValidationReportPath != null)
                        Console.WriteLine($"Validation: {r.ValidationErrorCount} error(s), {r.ValidationWarningCount} warning(s) → {r.ValidationReportPath}");
                    if (r.ValidationBlocked) {
                        Console.WriteLine($"BLOCKED: validation errors present. Fix them or re-run with --force to downgrade to warnings.");
                        break;
                    }
                    if (r.EnrichmentSqlPaths != null && r.EnrichmentSqlPaths.Count > 0) {
                        foreach (var ep in r.EnrichmentSqlPaths)
                            Console.WriteLine($"Wrote {System.IO.Path.GetFileName(ep)} → {ep}");
                        Console.WriteLine($"Wrote enrichment_manifest.json → {r.EnrichmentManifestPath}");
                    }
                    if (r.BiotaSqlPaths != null && r.BiotaSqlPaths.Count > 0) {
                        foreach (var bp in r.BiotaSqlPaths)
                            Console.WriteLine($"Wrote {System.IO.Path.GetFileName(bp)} → {bp}");
                        Console.WriteLine($"Wrote biota_manifest.json ({r.BiotaCount} biota override(s), {r.BiotaMintedGuids} guid(s) minted) → {r.BiotaManifestPath}");
                    }
                    if (r.EnrichmentConflictCount > 0)
                        Console.WriteLine($"WARN: {r.EnrichmentConflictCount} wcid(s) skipped for conflicting per-class enrichment (see manifest).");
                    if (r.PlacementOverrideSkipped > 0)
                        Console.WriteLine($"Note: {r.PlacementOverrideSkipped} ClassDefault-scope placement(s) carried no per-class rows; {r.BiotaCount} PlacementOverride emitted to biota.");
                    if (r.BiotaWarningCount > 0)
                        Console.WriteLine($"WARN: {r.BiotaWarningCount} biota override warning(s) (out-of-range guid / clamped PaletteTemplate — see biota_manifest.json).");
                    if (r.BiotaSkipped > 0)
                        Console.WriteLine($"WARN: {r.BiotaSkipped} biota override(s) skipped (guid outside the landblock static range).");
                    if (r.DryRun) Console.WriteLine("--dry-run: no DB connection was made.");
                    if (r.RowsAppliedToDb.HasValue) Console.WriteLine($"Applied {r.RowsAppliedToDb} row(s) to ace-db (world).");
                    if (r.ShardRowsAppliedToDb.HasValue) Console.WriteLine($"Applied {r.ShardRowsAppliedToDb} row(s) to ace-shard-db (biota overrides).");
                    break;
                }
                default:
                    Console.WriteLine($"Unknown placement subcommand: {tokens[1]}");
                    break;
            }
        }
        catch (Exception ex) {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }

    // E9b — round-trip an E9a scenery materials sidecar into synthetic Surface(0x08) DAT records.
    private void HandleSurfaceMaterials(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: surface-materials import <sidecar.json|dir> [--out <dat-dir>]");
            Console.WriteLine("  Reads E9a <lbHex>.scenery.materials.json and WRITES synthetic Surface(0x08) DAT");
            Console.WriteLine("  records into the target dat dir (additive override — NEVER a retail base DAT),");
            Console.WriteLine("  then re-reads each Surface and asserts round-trip fidelity to the sidecar.");
            return;
        }
        try {
            switch (tokens[1].ToLowerInvariant()) {
                case "import": {
                    if (tokens.Length < 3) {
                        Console.WriteLine("Usage: surface-materials import <sidecar.json|dir> [--out <dat-dir>]");
                        return;
                    }
                    string sidecar = tokens[2];
                    string? outDir = null;
                    for (int i = 3; i < tokens.Length; i++) {
                        if (tokens[i] == "--out" && i + 1 < tokens.Length) { outDir = tokens[i + 1]; i++; }
                    }
                    // Default target = a project-scoped synthetic dat dir (never the retail base DATs).
                    outDir ??= System.IO.Path.Combine(_engine.GetCurrentProjectDirectoryOrCwd(), "dats", "synthetic");
                    var r = _engine.SurfaceMaterialImport(sidecar, outDir);
                    if (r.Error != null) Console.WriteLine($"Error: {r.Error}");
                    Console.WriteLine($"Read {r.RecordCount} material record(s) from {r.SourceFileCount} sidecar file(s).");
                    Console.WriteLine($"Wrote {r.WrittenCount} Surface(0x08) record(s) → {r.DatDir}");
                    Console.WriteLine($"Round-trip OK: {r.RoundTripOkCount}/{r.RecordCount}");
                    int shown = 0;
                    foreach (var rec in r.Records) {
                        if (rec.RoundTripOk && shown >= 8) continue;
                        string kind = rec.Textured ? "textured" : "solid";
                        string status = !rec.Written ? "WRITE-FAILED" : (rec.RoundTripOk ? "ok" : "RT-MISMATCH");
                        Console.WriteLine($"  0x{rec.SurfaceDid:X8} type=0x{rec.SurfaceType:X} ({kind}) {status}"
                            + (rec.Error != null ? $" — {rec.Error}" : ""));
                        if (!rec.RoundTripOk) continue;
                        shown++;
                    }
                    if (r.Success && r.RecordCount == 0)
                        Console.WriteLine("surface-materials import: SUCCESS (empty sidecar — no-op for an empty landblock).");
                    else
                        Console.WriteLine(r.Success ? "surface-materials import: SUCCESS." : "surface-materials import: had failures.");
                    break;
                }
                default:
                    Console.WriteLine($"Unknown surface-materials subcommand: {tokens[1]}");
                    break;
            }
        }
        catch (Exception ex) {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }

    private void HandleWeenie(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: weenie <save|insert|delete|list-property-keys> ...");
            Console.WriteLine("  weenie save <classId> --from-json <path>");
            Console.WriteLine("  weenie insert <className> --from-json <path>");
            Console.WriteLine("  weenie delete <classId>");
            Console.WriteLine("  weenie list-property-keys <int|int64|bool|float|string|did|iid>");
            return;
        }
        try {
            switch (tokens[1].ToLowerInvariant()) {
                case "save": {
                    if (tokens.Length < 5 || tokens[3] != "--from-json") { Console.WriteLine("Usage: weenie save <classId> --from-json <path>"); return; }
                    if (!TryParseUint(tokens[2], "classId", out var cid)) return;
                    var s = _engine.WeenieSaveScalarsAsync(cid, tokens[4]).GetAwaiter().GetResult();
                    Console.WriteLine($"{(s.Success ? "Saved" : "Failed")}: 0x{s.ClassId:X8} ({s.IntRows} ints, {s.Int64Rows} i64, {s.BoolRows} bools, {s.FloatRows} floats, {s.StringRows} strs, {s.DataIdRows} dids, {s.InstanceIdRows} iids).");
                    break;
                }
                case "insert": {
                    if (tokens.Length < 5 || tokens[3] != "--from-json") { Console.WriteLine("Usage: weenie insert <className> --from-json <path>"); return; }
                    var i = _engine.WeenieInsertAsync(tokens[2], tokens[4]).GetAwaiter().GetResult();
                    Console.WriteLine($"{(i.Success ? "Inserted" : "Failed")}: '{i.ClassName}' as 0x{i.NewClassId:X8} ({i.TotalScalarRows} scalar rows).");
                    break;
                }
                case "delete": {
                    if (tokens.Length < 3) { Console.WriteLine("Usage: weenie delete <classId>"); return; }
                    if (!TryParseUint(tokens[2], "classId", out var did)) return;
                    var d = _engine.WeenieDeleteAsync(did).GetAwaiter().GetResult();
                    Console.WriteLine($"{(d.Success ? "Deleted" : "Failed")}: 0x{d.ClassId:X8}.");
                    break;
                }
                case "list-property-keys": {
                    if (tokens.Length < 3) { Console.WriteLine("Usage: weenie list-property-keys <int|int64|bool|float|string|did|iid>"); return; }
                    var l = _engine.WeenieListPropertyKeys(tokens[2]);
                    Console.WriteLine($"{l.Count} {l.Family} property key(s):");
                    int shown = 0;
                    foreach (var k in l.Keys) {
                        Console.WriteLine($"  {k.Type,5}  {k.Name}");
                        if (++shown >= 32 && l.Keys.Count > 32) {
                            Console.WriteLine($"  … {l.Keys.Count - shown} more");
                            break;
                        }
                    }
                    break;
                }
                default:
                    Console.WriteLine($"Unknown weenie subcommand: {tokens[1]}");
                    break;
            }
        }
        catch (Exception ex) {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }

    private void HandleSpell(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: spell <list|get|save|copy|delete> ...");
            Console.WriteLine("  spell list [--limit N] [--from-db|--from-dat]");
            Console.WriteLine("  spell get <id>");
            Console.WriteLine("  spell save <id> --from-json <path>");
            Console.WriteLine("  spell copy <fromId> [<newId>]");
            Console.WriteLine("  spell delete <id>");
            return;
        }
        try {
            switch (tokens[1].ToLowerInvariant()) {
                case "list": {
                    int limit = 500;
                    string source = "dat";
                    for (int i = 2; i < tokens.Length; i++) {
                        if (tokens[i] == "--limit" && i + 1 < tokens.Length && int.TryParse(tokens[i + 1], out var n)) { limit = n; i++; }
                        else if (tokens[i] == "--from-db") source = "db";
                        else if (tokens[i] == "--from-dat") source = "dat";
                    }
                    var l = _engine.SpellListAsync(limit, source).GetAwaiter().GetResult();
                    Console.WriteLine($"{l.Count} spell(s) from {l.Source}.");
                    int shown = 0;
                    foreach (var s in l.Spells) {
                        Console.WriteLine($"  {s.SpellId} {s.Name ?? "(no name)"}{(s.HasOverlay ? " [overlay]" : "")}");
                        if (++shown >= 32 && l.Spells.Count > 32) {
                            Console.WriteLine($"  … {l.Spells.Count - shown} more");
                            break;
                        }
                    }
                    break;
                }
                case "get": {
                    if (tokens.Length < 3) { Console.WriteLine("Usage: spell get <id>"); return; }
                    if (!TryParseUint(tokens[2], "id", out var id)) return;
                    var g = _engine.SpellGetAsync(id).GetAwaiter().GetResult();
                    Console.WriteLine($"Spell {g.SpellId} ({g.Source}): {g.Spell.Name}");
                    Console.WriteLine($"  Wcid={g.Spell.Wcid} EType={g.Spell.EType} StatModType={g.Spell.StatModType}");
                    break;
                }
                case "save": {
                    if (tokens.Length < 5 || tokens[3] != "--from-json") { Console.WriteLine("Usage: spell save <id> --from-json <path>"); return; }
                    if (!TryParseUint(tokens[2], "id", out var id)) return;
                    var s = _engine.SpellSaveAsync(id, tokens[4]).GetAwaiter().GetResult();
                    Console.WriteLine($"Saved {s.SpellId} (overlay={s.SavedToOverlay}, db={s.SavedToDb}).");
                    break;
                }
                case "copy": {
                    if (tokens.Length < 3) { Console.WriteLine("Usage: spell copy <fromId> [<newId>]"); return; }
                    if (!TryParseUint(tokens[2], "fromId", out var fromId)) return;
                    uint? newId = null;
                    if (tokens.Length >= 4 && uint.TryParse(tokens[3], out var nid)) newId = nid;
                    var c = _engine.SpellCopyAsync(fromId, newId).GetAwaiter().GetResult();
                    Console.WriteLine($"Copied {c.FromSpellId} → {c.NewSpellId} (overlay={c.SavedToOverlay}, db={c.SavedToDb}, replaced={c.ReplacedExisting}).");
                    break;
                }
                case "delete": {
                    if (tokens.Length < 3) { Console.WriteLine("Usage: spell delete <id>"); return; }
                    if (!TryParseUint(tokens[2], "id", out var id)) return;
                    var d = _engine.SpellDeleteAsync(id).GetAwaiter().GetResult();
                    Console.WriteLine($"Deleted {d.SpellId} (overlay={d.RemovedFromOverlay}, db={d.DeletedFromDb}).");
                    break;
                }
                default:
                    Console.WriteLine($"Unknown spell subcommand: {tokens[1]}");
                    break;
            }
        }
        catch (Exception ex) {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }

    private void HandleLayout(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: layout <list|get|save|delete-overlay> ...");
            Console.WriteLine("  layout list [--overlay-only]");
            Console.WriteLine("  layout get <0xLayoutId>");
            Console.WriteLine("  layout save <0xLayoutId> --from-json <path>");
            Console.WriteLine("  layout delete-overlay <0xLayoutId>");
            return;
        }
        try {
            switch (tokens[1].ToLowerInvariant()) {
                case "list":
                    bool overlayOnly = tokens.Skip(2).Any(t => t == "--overlay-only");
                    var l = _engine.LayoutList(overlayOnly);
                    Console.WriteLine($"{l.Count} LayoutDesc id(s){(overlayOnly ? " (overlay-only)" : "")}.");
                    int shown = 0;
                    foreach (var row in l.Layouts) {
                        Console.WriteLine($"  {row.LayoutId}{(row.HasOverlay ? "*" : "")}");
                        if (++shown >= 32 && l.Layouts.Count > 32) {
                            Console.WriteLine($"  … {l.Layouts.Count - shown} more");
                            break;
                        }
                    }
                    break;
                case "get":
                    if (tokens.Length < 3) { Console.WriteLine("Usage: layout get <0xLayoutId>"); return; }
                    if (!TryParseHex(tokens[2], "layoutId", out var gid)) return;
                    var g = _engine.LayoutGet(gid);
                    Console.WriteLine($"LayoutDesc {g.LayoutId}{(g.HasOverlay ? " (overlay)" : "")}: Width={g.Layout.Width} Height={g.Layout.Height}");
                    Console.WriteLine($"  Elements: {g.Layout.Elements?.Count ?? 0}");
                    break;
                case "save":
                    if (tokens.Length < 5 || tokens[3] != "--from-json") { Console.WriteLine("Usage: layout save <0xLayoutId> --from-json <path>"); return; }
                    if (!TryParseHex(tokens[2], "layoutId", out var sid)) return;
                    var s = _engine.LayoutSave(sid, tokens[4]);
                    Console.WriteLine($"Saved overlay for {s.LayoutId}.");
                    break;
                case "delete-overlay":
                    if (tokens.Length < 3) { Console.WriteLine("Usage: layout delete-overlay <0xLayoutId>"); return; }
                    if (!TryParseHex(tokens[2], "layoutId", out var did)) return;
                    var d = _engine.LayoutDeleteOverlay(did);
                    Console.WriteLine(d.Removed ? $"Removed overlay for {d.LayoutId}." : $"No overlay existed for {d.LayoutId}.");
                    break;
                default:
                    Console.WriteLine($"Unknown layout subcommand: {tokens[1]}");
                    break;
            }
        }
        catch (Exception ex) {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }

    private void HandleCreature(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: creature <get|save|export-sql> ...");
            Console.WriteLine("  creature get <objectId>");
            Console.WriteLine("  creature save <objectId> --from-json <path>");
            Console.WriteLine("  creature export-sql <objectId> [--out <path>]");
            return;
        }
        try {
            switch (tokens[1].ToLowerInvariant()) {
                case "get":
                    if (tokens.Length < 3) { Console.WriteLine("Usage: creature get <objectId>"); return; }
                    if (!TryParseHex(tokens[2], "objectId", out var oid)) return;
                    var g = _engine.CreatureGetAsync(oid).GetAwaiter().GetResult();
                    Console.WriteLine($"Loaded overrides for 0x{g.ObjectId:X8}: {g.Overrides.TextureMap.Count} texture-map, {g.Overrides.AnimParts.Count} anim-part, {g.Overrides.PaletteOverrides.Count} palette.");
                    Console.WriteLine($"  PaletteBase=0x{g.Overrides.PaletteBase:X8} ClothingBase=0x{g.Overrides.ClothingBase:X8} Template={g.Overrides.PaletteTemplate} Shade={g.Overrides.Shade}");
                    break;
                case "save":
                    if (tokens.Length < 5 || tokens[3] != "--from-json") { Console.WriteLine("Usage: creature save <objectId> --from-json <path>"); return; }
                    if (!TryParseHex(tokens[2], "objectId", out var sid)) return;
                    var s = _engine.CreatureSaveAsync(sid, tokens[4]).GetAwaiter().GetResult();
                    Console.WriteLine($"{(s.Success ? "Saved" : "Failed")}: 0x{s.ObjectId:X8} ({s.TextureMapRows} tex-map, {s.AnimPartRows} anim-part).");
                    break;
                case "export-sql":
                    if (tokens.Length < 3) { Console.WriteLine("Usage: creature export-sql <objectId> [--out <path>]"); return; }
                    if (!TryParseHex(tokens[2], "objectId", out var eid)) return;
                    string? outPath = null;
                    for (int i = 3; i < tokens.Length - 1; i++) {
                        if (tokens[i] == "--out") { outPath = tokens[i + 1]; break; }
                    }
                    var e = _engine.CreatureExportSql(eid, outPath);
                    Console.WriteLine($"Exported SQL ({e.Sql.Length} bytes){(outPath != null ? $" → {outPath}" : "")}.");
                    if (outPath == null) Console.WriteLine(e.Sql);
                    break;
                default:
                    Console.WriteLine($"Unknown creature subcommand: {tokens[1]}");
                    break;
            }
        }
        catch (Exception ex) {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }

    private void HandleImportRenderSurface(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: import-render-surface <imagePath> <renderSurfaceId> [--ui] [--name <name>]");
            Console.WriteLine("  Default: register in CustomTextureStore (written on next export).");
            Console.WriteLine("  --ui: deferred portal write through PortalDatDocument (preserves DAT until export).");
            Console.WriteLine("  Example: import-render-surface monster.png 0x06001234");
            return;
        }
        string imagePath = tokens[1];
        if (!TryParseHex(tokens[2], "renderSurfaceId", out uint renderSurfaceId)) return;
        bool ui = tokens.Skip(3).Any(t => t == "--ui");
        string? name = null;
        for (int i = 3; i < tokens.Length - 1; i++) {
            if (tokens[i] == "--name") { name = tokens[i + 1]; break; }
        }

        try {
            var r = _engine.ImportRenderSurface(imagePath, renderSurfaceId, ui, name);
            if (r.Success) {
                Console.WriteLine($"Imported '{r.Name}' for 0x{r.RenderSurfaceId:X8} via {r.Mode} (deferred until export).");
            } else {
                Console.WriteLine($"Failed: {r.Error}");
            }
        }
        catch (Exception ex) {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }

    private void HandleImportHeightmap(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 6) {
            Console.WriteLine("Usage: import-heightmap <imagePath> <startLbX> <startLbY> <lbCountX> <lbCountY> [--apply]");
            Console.WriteLine("  Default is dry-run; reports per-LB change counts only.");
            Console.WriteLine("  --apply writes via TerrainDocument.ApplyBulkImport.");
            Console.WriteLine("  Example: import-heightmap holtburg.png 169 178 4 4");
            return;
        }
        string imagePath = tokens[1];
        if (!TryParseInt(tokens[2], "startLbX", out int startLbX)) return;
        if (!TryParseInt(tokens[3], "startLbY", out int startLbY)) return;
        if (!TryParseInt(tokens[4], "lbCountX", out int lbCountX)) return;
        if (!TryParseInt(tokens[5], "lbCountY", out int lbCountY)) return;
        bool apply = tokens.Skip(6).Any(t => t == "--apply");

        try {
            var r = _engine.ImportHeightmap(imagePath, startLbX, startLbY, lbCountX, lbCountY, apply);
            Console.WriteLine($"{(r.Applied ? "Applied" : "Dry-run")}: {r.LandblocksChanged}/{r.LandblocksConsidered} LBs changed, {r.VerticesChanged} vertices.");
            int shown = 0;
            foreach (var p in r.PerLandblock) {
                Console.WriteLine($"  {p.Landblock}: {p.Vertices} vertex change(s)");
                if (++shown >= 16 && r.PerLandblock.Count > 16) {
                    Console.WriteLine($"  … {r.PerLandblock.Count - shown} more landblocks");
                    break;
                }
            }
            if (!r.Applied) Console.WriteLine("  (re-run with --apply to commit)");
        }
        catch (Exception ex) {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }

    private void HandleSetLandblockTerrain(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: set-landblock-terrain <lbX> <lbY> <t1,t2,...t81>");
            Console.WriteLine("  81 comma-separated byte values (terrain type 0-31)");
            Console.WriteLine("  Example: set-landblock-terrain 7 16 1,1,1,...");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;

        var parts = tokens[3].Split(',');
        if (parts.Length != 81) {
            Console.WriteLine($"Error: Expected 81 terrain type values, got {parts.Length}.");
            return;
        }
        var types = new byte[81];
        for (int i = 0; i < 81; i++) {
            if (!byte.TryParse(parts[i].Trim(), out types[i])) {
                Console.WriteLine($"Error: Invalid type value '{parts[i].Trim()}' at index {i}.");
                return;
            }
        }

        var r = _engine.SetLandblockTerrain(lbX, lbY, types);
        Console.WriteLine($"Set {r.VerticesModified} terrain types in landblock 0x{r.LbKey:X4}");
        if (r.ModifiedLandblocks.Count > 0)
            Console.WriteLine($"  Modified {r.ModifiedLandblocks.Count} landblock(s): {string.Join(", ", r.ModifiedLandblocks.Select(lb => $"0x{lb:X4}"))}");
    }

    private void HandleBulkPlaceObjects(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: bulk-place-objects <lbX> <lbY> <json-array>");
            Console.WriteLine("  json-array: [{\"modelId\":\"0x020000A7\",\"x\":100,\"y\":100,\"z\":0}, ...]");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;

        // The bracket-aware tokenizer keeps the JSON in a single token. Re-join
        // any trailing tokens defensively in case the user added stray args.
        var jsonStr = tokens.Length == 4 ? tokens[3] : string.Join(" ", tokens.Skip(3));
        try {
            using var doc = System.Text.Json.JsonDocument.Parse(jsonStr);
            var objects = new List<(uint modelId, float x, float y, float z)>();
            int badRows = 0;
            foreach (var elem in doc.RootElement.EnumerateArray()) {
                var midStr = elem.GetProperty("modelId").GetString();
                if (string.IsNullOrWhiteSpace(midStr) || !TryParseHex(midStr, "modelId", out uint mid)) {
                    badRows++;
                    continue;
                }
                float x = elem.GetProperty("x").GetSingle();
                float y = elem.GetProperty("y").GetSingle();
                float z = elem.GetProperty("z").GetSingle();
                if (!float.IsFinite(x) || !float.IsFinite(y) || !float.IsFinite(z)) {
                    Console.WriteLine($"  Skipping non-finite coordinate ({x},{y},{z})");
                    badRows++;
                    continue;
                }
                objects.Add((mid, x, y, z));
            }
            if (objects.Count == 0) {
                Console.WriteLine($"No valid objects to place ({badRows} skipped).");
                return;
            }
            var r = _engine.BulkPlaceObjects(lbX, lbY, objects);
            Console.WriteLine($"Placed {r.Placed} objects in landblock 0x{r.LbKey:X4}");
            int totalErrors = r.Errors + badRows;
            if (totalErrors > 0) Console.WriteLine($"  {totalErrors} error(s) ({badRows} input, {r.Errors} placement)");
            if (r.ErrorMessages != null)
                foreach (var e in r.ErrorMessages) Console.WriteLine($"    {e}");
        } catch (Exception ex) {
            Console.WriteLine($"Error parsing JSON: {ex.Message}");
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Procedural Generation
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleGenerateTerrain(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: generate-terrain <seed> [octaves] [lacunarity] [persistence] [amplitude] [coastline-json]");
            Console.WriteLine("  seed        â€” integer seed for deterministic noise");
            Console.WriteLine("  octaves     â€” fBm octave count (default: 6)");
            Console.WriteLine("  lacunarity  â€” frequency multiplier per octave (default: 2.0)");
            Console.WriteLine("  persistence â€” amplitude multiplier per octave (default: 0.5)");
            Console.WriteLine("  amplitude   â€” max height 0-255 (default: 128)");
            Console.WriteLine("  coastline   â€” optional JSON polygon: \"[[x1,y1],[x2,y2],...]\"");
            Console.WriteLine();
            Console.WriteLine("  Example: generate-terrain 42");
            Console.WriteLine("  Example: generate-terrain 42 6 2.0 0.5 128");
            return;
        }
        if (!TryParseInt(tokens[1], "seed", out int seed)) return;
        int octaves = 6;
        float lacunarity = 2f, persistence = 0.5f, amplitude = 128f;
        if (tokens.Length >= 3 && !TryParseInt(tokens[2], "octaves", out octaves)) return;
        if (tokens.Length >= 4 && !TryParseFloat(tokens[3], "lacunarity", out lacunarity)) return;
        if (tokens.Length >= 5 && !TryParseFloat(tokens[4], "persistence", out persistence)) return;
        if (tokens.Length >= 6 && !TryParseFloat(tokens[5], "amplitude", out amplitude)) return;

        List<(float X, float Y)>? coastline = null;
        if (tokens.Length >= 7) {
            try {
                var jsonStr = string.Join(" ", tokens.Skip(6));
                using var doc = System.Text.Json.JsonDocument.Parse(jsonStr);
                coastline = new List<(float, float)>();
                foreach (var elem in doc.RootElement.EnumerateArray()) {
                    float cx = elem[0].GetSingle();
                    float cy = elem[1].GetSingle();
                    coastline.Add((cx, cy));
                }
            } catch (Exception ex) {
                Console.WriteLine($"Error parsing coastline JSON: {ex.Message}");
                return;
            }
        }

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Procedural Terrain Generation â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Seed: {seed}  Octaves: {octaves}  Lacunarity: {lacunarity}  Persistence: {persistence}  Amplitude: {amplitude}");
        if (coastline != null) Console.WriteLine($"  Coastline polygon: {coastline.Count} vertices");
        Console.WriteLine("  Generating 255Ã—255 = 65,025 landblocks (5,267,025 vertices)...");
        Console.WriteLine();

        var r = _engine.GenerateTerrain(seed, octaves, lacunarity, persistence, amplitude, coastline);

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  âœ“ Generation complete!" : "  âœ— Generation failed!");
        Console.ResetColor();
        Console.WriteLine($"  Landblocks written : {r.LandblocksWritten:N0}");
        Console.WriteLine($"  Vertices written   : {r.VerticesWritten:N0}");
        Console.WriteLine($"  Elapsed time       : {r.ElapsedMs:F0} ms ({r.ElapsedMs / 1000.0:F1} sec)");
        Console.WriteLine($"  Throughput         : {r.LandblocksPerSec:F0} landblocks/sec");
        Console.WriteLine($"  Auto-painted       : {r.AutoPainted}");
        Console.WriteLine($"  Coastline mask     : {r.HasCoastline}");
        Console.WriteLine();
        Console.WriteLine("  Tip: Use 'validate-terrain <lbX> <lbY>' to verify, 'export <dir>' to save.");
        Console.WriteLine();
    }

    private void HandleAutoPaint() {
        if (!CheckProject()) return;
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Auto-Paint Terrain â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  Painting terrain types based on height bands and slope...");
        Console.WriteLine("  Height < 10 â†’ Water  |  < 25 â†’ Sand  |  < 80 â†’ Grass  |  < 180 â†’ Rock  |  >= 180 â†’ Snow");
        Console.WriteLine("  Steep slope (Î” > 3) â†’ Rocky/Cliff override");
        Console.WriteLine();

        var r = _engine.AutoPaintTerrain();

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  âœ“ Auto-paint complete!" : "  âœ— Auto-paint failed!");
        Console.ResetColor();
        Console.WriteLine($"  Landblocks painted : {r.LandblocksWritten:N0}");
        Console.WriteLine($"  Vertices painted   : {r.VerticesPainted:N0}");
        Console.WriteLine($"  Elapsed time       : {r.ElapsedMs:F0} ms ({r.ElapsedMs / 1000.0:F1} sec)");
        Console.WriteLine();
        Console.WriteLine($"  Distribution:");
        Console.WriteLine($"    Water  (< 10)  : {r.WaterVertices:N0}");
        Console.WriteLine($"    Sand   (< 25)  : {r.SandVertices:N0}");
        Console.WriteLine($"    Grass  (< 80)  : {r.GrassVertices:N0}");
        Console.WriteLine($"    Rock   (< 180) : {r.RockVertices:N0}");
        Console.WriteLine($"    Snow   (>= 180): {r.SnowVertices:N0}");
        Console.WriteLine($"    Cliff overrides: {r.CliffOverrides:N0}");
        Console.WriteLine();
    }

    private void HandleGenerateDungeon(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: generate-dungeon <lbX> <lbY> [depth] [branching] [seed] [minRooms] [maxRooms] [theme]");
            Console.WriteLine("  lbX, lbY       â€” landblock coordinates for the dungeon");
            Console.WriteLine("  depth          â€” target depth from entrance to boss (default: 8)");
            Console.WriteLine("  branching      â€” branching factor / avg exits per room (default: 2.0)");
            Console.WriteLine("  seed           â€” random seed, 0 = non-deterministic (default: 0)");
            Console.WriteLine("  minRooms       â€” minimum rooms (default: 5)");
            Console.WriteLine("  maxRooms       â€” maximum rooms (default: 40)");
            Console.WriteLine("  theme          â€” room theme tag (default: \"default\")");
            Console.WriteLine();
            Console.WriteLine("  Example: generate-dungeon 1 217");
            Console.WriteLine("  Example: generate-dungeon 1 217 8 2.0 42");
            Console.WriteLine("  Example: generate-dungeon 1 217 12 3.0 42 10 50 caves");
            return;
        }
        if (!TryParseUint(tokens[1], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[2], "lbY", out uint lbY)) return;

        int depth = 8;
        float branching = 2.0f;
        int seed = 0;
        int minRooms = 5;
        int maxRooms = 40;
        string theme = "default";

        if (tokens.Length >= 4 && !TryParseInt(tokens[3], "depth", out depth)) return;
        if (tokens.Length >= 5 && !TryParseFloat(tokens[4], "branching", out branching)) return;
        if (tokens.Length >= 6 && !TryParseInt(tokens[5], "seed", out seed)) return;
        if (tokens.Length >= 7 && !TryParseInt(tokens[6], "minRooms", out minRooms)) return;
        if (tokens.Length >= 8 && !TryParseInt(tokens[7], "maxRooms", out maxRooms)) return;
        if (tokens.Length >= 9) theme = tokens[8];

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Procedural Dungeon Generation â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Landblock: ({lbX}, {lbY})  Depth: {depth}  Branching: {branching:F1}  Seed: {seed}");
        Console.WriteLine($"  Rooms: {minRooms}â€“{maxRooms}  Theme: {theme}");
        Console.WriteLine();

        var r = _engine.GenerateDungeon(lbX, lbY, depth, branching, minRooms, maxRooms, theme, seed);

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  âœ“ Dungeon generated!" : "  âœ— Generation failed!");
        Console.ResetColor();

        if (!string.IsNullOrEmpty(r.Error)) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  Error: {r.Error}");
            Console.ResetColor();
        }

        Console.WriteLine($"  Landblock      : 0x{r.LbKey:X4}");
        Console.WriteLine($"  Seed used      : {r.Seed}");
        Console.WriteLine($"  Graph nodes    : {r.NodesInGraph}");
        Console.WriteLine($"  Graph edges    : {r.EdgesInGraph}");
        Console.WriteLine($"  Cells placed   : {r.CellsPlaced}");
        Console.WriteLine($"  Max depth      : {r.MaxDepth}");
        Console.WriteLine();

        if (r.Warnings.Count > 0) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"  Warnings ({r.Warnings.Count}):");
            Console.ResetColor();
            foreach (var w in r.Warnings.Take(20))
                Console.WriteLine($"    âš  {w}");
            if (r.Warnings.Count > 20)
                Console.WriteLine($"    ... and {r.Warnings.Count - 20} more");
            Console.WriteLine();
        }

        if (!string.IsNullOrEmpty(r.GraphSummary)) {
            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.WriteLine(r.GraphSummary);
            Console.ResetColor();
        }

        Console.WriteLine("  Tip: Use 'validate-dungeon {0} {1}' to verify, 'export <dir>' to save.",
            lbX, lbY);
        Console.WriteLine();
    }

    private void HandleAnalyzeLandblockPatterns(string[] tokens) {
        if (!CheckProject()) return;
        uint minX = 0, minY = 0, maxX = 254, maxY = 254;
        string? outputPath = null;

        // Parse optional range and output path
        if (tokens.Length >= 5) {
            if (!TryParseUint(tokens[1], "minX", out minX)) return;
            if (!TryParseUint(tokens[2], "minY", out minY)) return;
            if (!TryParseUint(tokens[3], "maxX", out maxX)) return;
            if (!TryParseUint(tokens[4], "maxY", out maxY)) return;
            if (tokens.Length >= 6) outputPath = tokens[5];
        } else if (tokens.Length >= 2) {
            outputPath = tokens[1];
        }

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Landblock Pattern Analysis â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Range: ({minX},{minY}) to ({maxX},{maxY})");
        Console.WriteLine("  Analyzing object adjacency, slope, orientation, clustering...");
        Console.WriteLine();

        var r = _engine.AnalyzeLandblockPatterns(minX, minY, maxX, maxY, outputPath);

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  âœ“ Analysis complete!" : "  âœ— Analysis failed!");
        Console.ResetColor();
        Console.WriteLine();

        Console.WriteLine($"  Landblocks analyzed  : {r.LandblocksAnalyzed}");
        Console.WriteLine($"  Total objects        : {r.TotalObjectsAnalyzed}");
        Console.WriteLine($"  Elapsed              : {r.ElapsedMs:F0} ms");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("  â”€â”€ Slope Distribution â”€â”€");
        Console.ResetColor();
        Console.WriteLine($"    Flat (0-5Â°)      : {r.SlopeDistribution.Flat}");
        Console.WriteLine($"    Gentle (5-15Â°)   : {r.SlopeDistribution.Gentle}");
        Console.WriteLine($"    Moderate (15-30Â°): {r.SlopeDistribution.Moderate}");
        Console.WriteLine($"    Steep (30Â°+)     : {r.SlopeDistribution.Steep}");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("  â”€â”€ Orientation Bias â”€â”€");
        Console.ResetColor();
        Console.WriteLine($"    North: {r.OrientationBias.North}  East: {r.OrientationBias.East}  South: {r.OrientationBias.South}  West: {r.OrientationBias.West}");
        Console.WriteLine($"    Dominant: {r.OrientationBias.DominantDirection ?? "none"}");
        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("  â”€â”€ Clustering â”€â”€");
        Console.ResetColor();
        Console.WriteLine($"    Total clusters   : {r.ClusterSummary.TotalClusters}");
        Console.WriteLine($"    Avg cluster size : {r.ClusterSummary.AvgClusterSize:F1}");
        Console.WriteLine($"    Largest cluster  : {r.ClusterSummary.LargestCluster}");
        Console.WriteLine();

        if (r.TopAdjacencyPairs.Count > 0) {
            Console.ForegroundColor = ConsoleColor.White;
            Console.WriteLine("  â”€â”€ Top Adjacency Pairs (within 25 units) â”€â”€");
            Console.ResetColor();
            Console.WriteLine($"  {"Object A",-35} {"Object B",-35} {"â‰¤5",-5} {"â‰¤10",-5} {"â‰¤25",-5} {"AvgDist"}");
            Console.WriteLine($"  {new string('-', 95)}");
            foreach (var pair in r.TopAdjacencyPairs.Take(20)) {
                string a = pair.ObjectA.Length > 33 ? pair.ObjectA[..33] + "â€¦" : pair.ObjectA;
                string b = pair.ObjectB.Length > 33 ? pair.ObjectB[..33] + "â€¦" : pair.ObjectB;
                Console.WriteLine($"  {a,-35} {b,-35} {pair.Count5,-5} {pair.Count10,-5} {pair.Count25,-5} {pair.AvgDistance:F1}");
            }
            if (r.TopAdjacencyPairs.Count > 20)
                Console.WriteLine($"  ... and {r.TopAdjacencyPairs.Count - 20} more pairs");
            Console.WriteLine();
        }

        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Results saved to: {r.OutputPath}");
        else
            Console.WriteLine("  Tip: Use 'analyze-landblock-patterns [minX minY maxX maxY] <output.json>' to save results.");
        Console.WriteLine();
    }

    private void HandleExtractBuildingPairings(string[] tokens) {
        if (!CheckProject()) return;
        int minCount5 = 3;
        string? outputPath = null;
        for (int i = 1; i < tokens.Length; i++) {
            if (int.TryParse(tokens[i], out int n)) minCount5 = n;
            else outputPath = tokens[i];
        }
        var r = _engine.ExtractBuildingPairings(minCount5, outputPath);
        if (!r.Success) {
            Console.WriteLine($"  Error: {r.Error}");
            return;
        }
        Console.WriteLine($"  Scanned {r.StructuresScanned:N0} structures, kept {r.PairsKept} pair edges " +
            $"(minCount5={minCount5}), {r.GroupCount} groups in {r.ElapsedMs}ms");
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Saved to: {r.OutputPath}");
    }

    private void HandleLoadBuildingPairings(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: load-building-pairings <path>");
            return;
        }
        var r = _engine.LoadBuildingPairings(tokens[1]);
        if (!r.Success) {
            Console.WriteLine($"  Error: {r.Error}");
            return;
        }
        Console.WriteLine($"  Loaded {r.EdgeCount} pair edges, {r.GroupCount} groups");
    }

    private void HandleExportTrainingData(string[] tokens) {
        if (!CheckProject()) return;
        uint minX = 0, minY = 0, maxX = 254, maxY = 254;
        string? outputPath = null;
        int nearbyLimit = 5;

        // Parse optional range, output path, and nearby limit
        if (tokens.Length >= 5) {
            if (!TryParseUint(tokens[1], "minX", out minX)) return;
            if (!TryParseUint(tokens[2], "minY", out minY)) return;
            if (!TryParseUint(tokens[3], "maxX", out maxX)) return;
            if (!TryParseUint(tokens[4], "maxY", out maxY)) return;
            if (tokens.Length >= 6) outputPath = tokens[5];
            if (tokens.Length >= 7 && !TryParseInt(tokens[6], "nearbyLimit", out nearbyLimit)) return;
        } else if (tokens.Length >= 2) {
            outputPath = tokens[1];
            if (tokens.Length >= 3 && !TryParseInt(tokens[2], "nearbyLimit", out nearbyLimit)) return;
        }

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Export Training Data â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Range: ({minX},{minY}) to ({maxX},{maxY})");
        Console.WriteLine($"  Nearby limit: {nearbyLimit}");
        Console.WriteLine($"  Output: {outputPath ?? "training_data.jsonl"}");
        Console.WriteLine("  Exporting placement examples as JSONL...");
        Console.WriteLine();

        var r = _engine.ExportTrainingData(minX, minY, maxX, maxY, outputPath, nearbyLimit);

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  âœ“ Export complete!" : $"  âœ— Export failed: {r.Error}");
        Console.ResetColor();
        Console.WriteLine();

        Console.WriteLine($"  Total exported       : {r.TotalExported}");
        Console.WriteLine($"  Landblocks processed : {r.LandblocksProcessed}");
        Console.WriteLine($"  With ontology data   : {r.WithOntology}");
        Console.WriteLine($"  Elapsed              : {r.ElapsedMs:F0} ms");
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Output file          : {r.OutputPath}");
        Console.WriteLine();
    }

    private void HandleExportRawWorldFacts(string[] tokens) {
        if (!CheckProject()) return;
        uint minX = 0, minY = 0, maxX = 254, maxY = 254;
        string? outputPath = null;
        bool includeAceDb = false;
        bool includeLinks = false;

        var positional = new List<string>();
        for (int i = 1; i < tokens.Length; i++) {
            var token = tokens[i];
            if (token.Equals("--ace-db", StringComparison.OrdinalIgnoreCase)) {
                includeAceDb = true;
                continue;
            }
            if (token.Equals("--links", StringComparison.OrdinalIgnoreCase)) {
                includeLinks = true;
                includeAceDb = true;
                continue;
            }
            positional.Add(token);
        }

        if (positional.Count >= 4) {
            if (!TryParseUint(positional[0], "minX", out minX)) return;
            if (!TryParseUint(positional[1], "minY", out minY)) return;
            if (!TryParseUint(positional[2], "maxX", out maxX)) return;
            if (!TryParseUint(positional[3], "maxY", out maxY)) return;
            if (positional.Count >= 5) outputPath = positional[4];
        } else if (positional.Count >= 1) {
            outputPath = positional[0];
        }

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  ═══ Export Raw World Facts ═══");
        Console.ResetColor();
        Console.WriteLine($"  Range: ({minX},{minY}) to ({maxX},{maxY})");
        Console.WriteLine($"  Include ACE DB: {includeAceDb}");
        Console.WriteLine($"  Include links : {includeLinks}");
        Console.WriteLine($"  Output: {outputPath ?? "raw_world_facts.jsonl"}");
        Console.WriteLine("  Exporting raw DAT/SQL/spawn facts...");
        Console.WriteLine();

        var r = _engine.ExportRawWorldFacts(minX, minY, maxX, maxY, outputPath, includeAceDb, includeLinks);

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  ✓ Export complete!" : $"  ✗ Export failed: {r.Error}");
        Console.ResetColor();
        Console.WriteLine();

        Console.WriteLine($"  Total exported       : {r.TotalExported}");
        Console.WriteLine($"  DAT static objects   : {r.DatStaticCount}");
        Console.WriteLine($"  ACE instances        : {r.AceInstanceCount}");
        Console.WriteLine($"  ACE encounters       : {r.AceEncounterCount}");
        Console.WriteLine($"  ACE house portals    : {r.AceHousePortalCount}");
        Console.WriteLine($"  Landblocks processed : {r.LandblocksProcessed}");
        Console.WriteLine($"  Included ACE DB      : {r.IncludedAceDb}");
        Console.WriteLine($"  Included links       : {r.IncludedLinks}");
        Console.WriteLine($"  Elapsed              : {r.ElapsedMs:F0} ms");
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Output file          : {r.OutputPath}");
        Console.WriteLine();
    }

    private void HandleExportEnvCellComponents(string[] tokens) {
        if (!CheckProject()) return;
        uint minX = 0, minY = 0, maxX = 254, maxY = 254;
        string? outputPath = null;

        if (tokens.Length >= 5) {
            if (!TryParseUint(tokens[1], "minX", out minX)) return;
            if (!TryParseUint(tokens[2], "minY", out minY)) return;
            if (!TryParseUint(tokens[3], "maxX", out maxX)) return;
            if (!TryParseUint(tokens[4], "maxY", out maxY)) return;
            if (tokens.Length >= 6) outputPath = tokens[5];
        } else if (tokens.Length >= 2) {
            outputPath = tokens[1];
        }

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  ═══ Export EnvCell Components ═══");
        Console.ResetColor();
        Console.WriteLine($"  Range: ({minX},{minY}) to ({maxX},{maxY})");
        Console.WriteLine($"  Output: {outputPath ?? "envcell_components.jsonl"}");
        Console.WriteLine("  Exporting linked surface-anchor and EnvCell components...");
        Console.WriteLine();

        var r = _engine.ExportEnvCellComponents(minX, minY, maxX, maxY, outputPath);

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  ✓ Export complete!" : $"  ✗ Export failed: {r.Error}");
        Console.ResetColor();
        Console.WriteLine();

        Console.WriteLine($"  Total exported       : {r.TotalExported}");
        Console.WriteLine($"  Anchored components  : {r.AnchoredCount}");
        Console.WriteLine($"  Unanchored components: {r.UnanchoredCount}");
        Console.WriteLine($"  Landblocks processed : {r.LandblocksProcessed}");
        Console.WriteLine($"  Elapsed              : {r.ElapsedMs:F0} ms");
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Output file          : {r.OutputPath}");
        Console.WriteLine();
    }

    private void HandleGenerateSettlement(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: generate-settlement <template> <centerX> <centerY> [seed]");
            Console.WriteLine("  template  â€” settlement template name");
            Console.WriteLine("  centerX/Y â€” world-space center position for the settlement");
            Console.WriteLine("  seed      â€” random seed, 0 = non-deterministic (default: 0)");
            Console.WriteLine();
            Console.WriteLine("  Available templates:");
            foreach (var name in _engine.GetSettlementTemplateNames())
                Console.WriteLine($"    {name}");
            Console.WriteLine();
            Console.WriteLine("  Example: generate-settlement Aluvian_Village 12096 12096");
            Console.WriteLine("  Example: generate-settlement Wilderness_Camp 12096 12096 42");
            return;
        }
        string template = tokens[1];
        if (!TryParseFloat(tokens[2], "centerX", out float cx)) return;
        if (!TryParseFloat(tokens[3], "centerY", out float cy)) return;
        int seed = 0;
        if (tokens.Length >= 5 && !TryParseInt(tokens[4], "seed", out seed)) return;

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Constraint-Based Settlement Generator â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Template: {template}   Center: ({cx}, {cy})   Seed: {seed}");
        Console.WriteLine();

        var r = _engine.GenerateSettlement(template, cx, cy, seed);

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  âœ“ Settlement generated!" : "  âœ— Generation failed!");
        Console.ResetColor();

        if (!string.IsNullOrEmpty(r.Error)) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  Error: {r.Error}");
            Console.ResetColor();
        }

        Console.WriteLine($"  Template             : {r.TemplateName}");
        Console.WriteLine($"  Objects placed       : {r.ObjectsPlaced}");
        Console.WriteLine($"  Constraint violations: {r.ConstraintViolations}");
        Console.WriteLine($"  Elapsed              : {r.ElapsedMs:F0} ms");
        Console.WriteLine();

        if (r.Warnings.Count > 0) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"  Warnings ({r.Warnings.Count}):");
            Console.ResetColor();
            foreach (var w in r.Warnings.Take(20))
                Console.WriteLine($"    âš  {w}");
            if (r.Warnings.Count > 20)
                Console.WriteLine($"    ... and {r.Warnings.Count - 20} more");
            Console.WriteLine();
        }

        if (r.PlacedObjects.Count > 0) {
            Console.ForegroundColor = ConsoleColor.White;
            Console.WriteLine("  â”€â”€ Placed Objects â”€â”€");
            Console.ResetColor();
            Console.WriteLine($"  {"Model ID",-14} {"Category",-12} {"X",-10} {"Y",-10} {"Z",-10} {"YawÂ°",-8} {"Name"}");
            Console.WriteLine($"  {new string('-', 80)}");
            foreach (var po in r.PlacedObjects.Take(50)) {
                string nm = po.Name != null && po.Name.Length > 25 ? po.Name[..25] + "â€¦" : po.Name ?? "";
                Console.WriteLine($"  {po.ModelIdHex,-14} {po.Category,-12} {po.X,-10:F1} {po.Y,-10:F1} {po.Z,-10:F1} {po.YawDegrees,-8:F1} {nm}");
            }
            if (r.PlacedObjects.Count > 50)
                Console.WriteLine($"  ... and {r.PlacedObjects.Count - 50} more");
            Console.WriteLine();
        }
    }

    private void HandleExtractRetailHeightmaps(string[] tokens) {
        if (!CheckProject()) return;
        string? outputPath = tokens.Length >= 2 ? tokens[1] : null;

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Extract Retail Heightmaps â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Output: {outputPath ?? "pipeline_data/heightmaps/retail_heightmaps.jsonl"}");
        Console.WriteLine("  Scanning all 255Ã—255 landblocks for terrain vertex data...");
        Console.WriteLine();

        var r = _engine.ExtractRetailHeightmaps(outputPath ?? "pipeline_data/heightmaps/retail_heightmaps.jsonl");

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  âœ“ Export complete!" : $"  âœ— Export failed: {r.Error}");
        Console.ResetColor();
        Console.WriteLine();

        Console.WriteLine($"  Total landblocks     : {r.TotalLandblocks}");
        Console.WriteLine($"  Populated (exported) : {r.PopulatedLandblocks}");
        Console.WriteLine($"  Elapsed              : {r.ElapsedMs:F0} ms");
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Output file          : {r.OutputPath}");
        Console.WriteLine();
    }

    private void HandleComputeVanillaBaseline(string[] tokens) {
        if (!CheckProject()) return;
        string? outputPath = tokens.Length >= 2 ? tokens[1] : null;

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Compute Vanilla Baseline â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Output: {outputPath ?? "pipeline_data/enrichment/retail_baseline.json"}");
        Console.WriteLine("  Computing quality metrics from retail data...");
        Console.WriteLine();

        var r = _engine.ComputeVanillaBaseline(outputPath ?? "pipeline_data/enrichment/retail_baseline.json");

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  âœ“ Baseline computed!" : $"  âœ— Computation failed: {r.Error}");
        Console.ResetColor();
        Console.WriteLine();

        Console.WriteLine($"  Landblocks scanned   : {r.LandblocksScanned}");
        Console.WriteLine($"  Populated landblocks : {r.PopulatedLandblocks}");
        Console.WriteLine($"  Total objects        : {r.TotalObjects}");
        Console.WriteLine($"  Elapsed              : {r.ElapsedMs:F0} ms");
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Output file          : {r.OutputPath}");
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Image-Driven Terrain Commands
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleAnalyzeMapImage(string[] tokens) {
        if (tokens.Length < 2) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine("  Usage: analyze-map-image <image.png> [output.json]");
            Console.ResetColor();
            return;
        }

        string imagePath = tokens[1];
        string? outputPath = tokens.Length >= 3 ? tokens[2] : null;

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Analyze Map Image â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Image:  {imagePath}");
        Console.WriteLine($"  Output: {outputPath ?? "pipeline_data/enrichment/biome_map.json"}");
        Console.WriteLine("  Classifying each landblock's pixel region into biome categories...");
        Console.WriteLine();

        var r = _engine.AnalyzeMapImage(imagePath, outputPath ?? "pipeline_data/enrichment/biome_map.json");

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  âœ“ Analysis complete!" : $"  âœ— Analysis failed: {r.Error}");
        Console.ResetColor();
        Console.WriteLine();

        Console.WriteLine($"  Image size           : {r.ImageWidth}Ã—{r.ImageHeight}");
        Console.WriteLine($"  Land cells           : {r.LandCells}");
        Console.WriteLine($"  Ocean cells          : {r.OceanCells}");
        Console.WriteLine($"  Elapsed              : {r.ElapsedMs:F0} ms");

        if (r.BiomeCounts.Count > 0) {
            Console.WriteLine();
            Console.ForegroundColor = ConsoleColor.White;
            Console.WriteLine("  Biome Breakdown:");
            Console.ResetColor();
            int totalCells = r.LandCells + r.OceanCells;
            foreach (var kv in r.BiomeCounts.OrderByDescending(kv => kv.Value)) {
                double pct = totalCells > 0 ? 100.0 * kv.Value / totalCells : 0;
                Console.WriteLine($"    {kv.Key,-14} : {kv.Value,6}  ({pct:F1}%)");
            }
        }

        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"\n  Output file          : {r.OutputPath}");
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Calibrate World Map â€” Build Colorâ†’Terrain Codebook
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleCalibrateWorldMap(string[] tokens) {
        if (!CheckProject()) return;
        string outputPath = tokens.Length >= 2 ? tokens[1] : "pipeline_data/enrichment/terrain_codebook.json";

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Calibrate World Map â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  Extracts terrain base colors from DAT textures and builds");
        Console.WriteLine("  per-terrain-type brightnessâ†’height lookup tables.");
        Console.WriteLine($"  Output: {outputPath}");
        Console.WriteLine();

        var r = _engine.CalibrateWorldMap(outputPath);

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  âœ“ Calibration complete!" : "  âœ— Calibration failed!");
        Console.ResetColor();

        if (!string.IsNullOrEmpty(r.Error)) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  Error: {r.Error}");
            Console.ResetColor();
        }

        Console.WriteLine($"  Terrain types found  : {r.TerrainTypesFound}");
        Console.WriteLine($"  Vertices calibrated  : {r.VerticesCalibrated:N0}");
        Console.WriteLine($"  Landblocks processed : {r.LandblocksProcessed:N0}");
        Console.WriteLine($"  Elapsed              : {r.ElapsedMs:F0} ms ({r.ElapsedMs / 1000.0:F1} sec)");
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Output file          : {r.OutputPath}");
        Console.WriteLine();
        Console.WriteLine("  Next step: quick-world <codebook.json> <new_image.png>");
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Quick World â€” Reverse-Engineer World from Map Image
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleQuickWorld(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: quick-world <codebook.json> <world_map.png> [seed]");
            Console.WriteLine("  Reverse-engineers terrain from a world map image using a calibrated codebook.");
            Console.WriteLine("  Per-vertex terrain type matching + height estimation from brightness.");
            Console.WriteLine();
            Console.WriteLine("  codebook.json   â€” output of calibrate-world-map (required)");
            Console.WriteLine("  world_map.png   â€” source image (2041Ã—2041 for exact, or any size) (required)");
            Console.WriteLine("  seed            â€” deterministic seed (any int incl. 0); omit for non-deterministic");
            Console.WriteLine();
            Console.WriteLine("  Example: quick-world pipeline_data/enrichment/terrain_codebook.json new_world.png");
            Console.WriteLine("  Example: quick-world pipeline_data/enrichment/terrain_codebook.json new_world.png 42");
            return;
        }

        string codebookPath = tokens[1];
        string worldMapPath = tokens[2];
        int? seed = null;
        if (tokens.Length >= 4) {
            if (!TryParseInt(tokens[3], "seed", out var s)) return;
            seed = s;
        }

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Quick World â€” Reverse-Engineer from Image â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Codebook:   {codebookPath}");
        Console.WriteLine($"  World map:  {worldMapPath}");
        Console.WriteLine($"  Seed:       {(seed.HasValue ? seed.Value.ToString() : "(non-deterministic)")}");
        Console.WriteLine();

        var r = _engine.QuickWorld(codebookPath, worldMapPath, seed);

        Console.ForegroundColor = r.Success ? ConsoleColor.Green : ConsoleColor.Red;
        Console.WriteLine(r.Success ? "  âœ“ World generated!" : "  âœ— Generation failed!");
        Console.ResetColor();

        if (!string.IsNullOrEmpty(r.Error)) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  Error: {r.Error}");
            Console.ResetColor();
        }

        Console.WriteLine($"  Landblocks stamped     : {r.LandblocksStamped:N0}");
        Console.WriteLine($"  Landblocks skipped     : {r.LandblocksSkipped:N0}");
        Console.WriteLine($"  Objects placed         : {r.ObjectsPlaced:N0}");
        Console.WriteLine($"  Approximate matches    : {r.ApproximateColorMatches:N0}");
        Console.WriteLine($"  Scenery failures       : {r.SceneryFailures:N0}");
        Console.WriteLine($"  Elapsed                : {r.ElapsedMs:F0} ms ({r.ElapsedMs / 1000.0:F1} sec)");
        Console.WriteLine();

        if (r.TerrainTypesStamped.Count > 0) {
            Console.ForegroundColor = ConsoleColor.White;
            Console.WriteLine("  Terrain Type Distribution:");
            Console.ResetColor();
            foreach (var kv in r.TerrainTypesStamped.OrderByDescending(kv => kv.Value)) {
                double pct = r.LandblocksStamped > 0 ? 100.0 * kv.Value / r.LandblocksStamped : 0;
                Console.WriteLine($"    {kv.Key,-24} : {kv.Value,6}  ({pct:F1}%)");
            }
            Console.WriteLine();
        }

        Console.WriteLine("  Tip: use 'export <dir>' to save the world to DAT files.");
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Building Remap
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleRemapBuildings(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: remap-buildings <lb_remap.json> <output_dir> [--apply] [--in-place]");
            Console.WriteLine("  Moves buildings in the DAT to remapped positions + generates interior SQL.");
            Console.WriteLine("  --apply     Apply the SQL directly to the database");
            Console.WriteLine("  --in-place  Use existing DATs in output_dir (from prior export) instead of copying base");
            Console.WriteLine();
            Console.WriteLine("  Typical workflow:");
            Console.WriteLine("    1. export D:\\ACE\\Dats                    (get correct terrain)");
            Console.WriteLine("    2. remap-buildings lb_remap.json D:\\ACE\\Dats --in-place --apply");
            return;
        }

        string remapPath = tokens[1];
        string outputDir = tokens[2];
        bool apply = tokens.Any(t => t.Equals("--apply", StringComparison.OrdinalIgnoreCase));
        bool inPlace = tokens.Any(t => t.Equals("--in-place", StringComparison.OrdinalIgnoreCase));

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Building Remap â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Remap file : {remapPath}");
        Console.WriteLine($"  Output dir : {outputDir}");
        Console.WriteLine($"  In-place   : {(inPlace ? "yes (using existing DATs)" : "no (copying base DATs)")}");
        Console.WriteLine($"  Apply SQL  : {(apply ? "yes" : "no (dry run)")}");
        Console.WriteLine();

        var r = _engine.RemapBuildings(remapPath, outputDir, apply, inPlace);

        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }

        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("  âœ“ Building remap complete!");
        Console.ResetColor();
        Console.WriteLine($"  Landblocks with buildings    : {r.LandblocksWithBuildings}");
        Console.WriteLine($"  Buildings moved              : {r.BuildingsMoved}");
        Console.WriteLine($"  EnvCells created             : {r.CellsCreated}");
        Console.WriteLine($"  Interior instances remapped  : {r.InteriorInstancesRemapped}");
        Console.WriteLine($"  Elapsed                      : {r.ElapsedMs:F0} ms");
        if (!string.IsNullOrEmpty(r.SqlFilePath))
            Console.WriteLine($"  SQL file                     : {r.SqlFilePath}");

        if (r.Warnings != null && r.Warnings.Count > 0) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"\n  Warnings ({r.Warnings.Count}):");
            Console.ResetColor();
            foreach (var w in r.Warnings.Take(20))
                Console.WriteLine($"    âš  {w}");
            if (r.Warnings.Count > 20)
                Console.WriteLine($"    ... and {r.Warnings.Count - 20} more");
        }

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  Next steps:");
        Console.ResetColor();
        Console.WriteLine("    1. export <dir>               â€” Write modified DATs with remapped buildings");
        Console.WriteLine("    2. ace-db reposition          â€” Reposition all outdoor instances to new Z heights");
        if (!apply && r.InteriorInstancesRemapped > 0)
            Console.WriteLine("    3. Apply building_remap.sql   â€” Run the SQL to remap interior instance cell IDs");
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Building Remap V2 (layer-based pipeline)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleRemapBuildingsV2(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: remap-buildings-v2 <lb_remap.json> [--no-flatten] [--flatten-radius=30] [--flatten-strength=0.85] [--no-validate] [--preserve-retail-z]");
            Console.WriteLine("  Adds retail buildings as StaticObjects into destination LandblockDocuments.");
            Console.WriteLine("  Uses the proven SaveToDatsInternal â†’ InstantiateBlueprint pipeline.");
            Console.WriteLine("  Requires 'export' afterwards to write the DATs.");
            Console.WriteLine();
            Console.WriteLine("  Options:");
            Console.WriteLine("    --no-flatten         Skip terrain flattening under buildings");
            Console.WriteLine("    --flatten-radius=N   Radius in world units for flattening (default: 30)");
            Console.WriteLine("    --flatten-strength=S Inner flat-core ratio in [0,1] (default: 0.85, 1.0 = fully flat)");
            Console.WriteLine("    --no-validate        Skip post-placement landblock/terrain validator checks");
            Console.WriteLine("    --preserve-retail-z  Keep retail origin-to-ground offsets (legacy behavior)");
            Console.WriteLine();
            Console.WriteLine("  Full pipeline:");
            Console.WriteLine("    1. remap-buildings-v2 pipeline_data/population_output/lb_remap.json");
            Console.WriteLine("    2. export D:\\ACE\\Dats");
            Console.WriteLine("    3. remap-buildings-sql pipeline_data/population_output/lb_remap.json D:\\ACE\\Dats building_remap_v2.sql --apply");
            Console.WriteLine("    4. ace-db reposition");
            return;
        }

        string remapPath = tokens[1];
        bool flatten = true;
        bool runValidators = true;
        bool preserveRetailZ = false;
        float flattenRadius = 30f;
        float flattenStrength = 0.85f;

        static bool TryParseFloatArg(string value, out float parsed) =>
            float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) ||
            float.TryParse(value, NumberStyles.Float, CultureInfo.CurrentCulture, out parsed);

        for (int i = 2; i < tokens.Length; i++) {
            var t = tokens[i];
            if (t.Equals("--no-flatten", StringComparison.OrdinalIgnoreCase)) {
                flatten = false;
            } else if (t.Equals("--no-validate", StringComparison.OrdinalIgnoreCase)) {
                runValidators = false;
            } else if (t.Equals("--preserve-retail-z", StringComparison.OrdinalIgnoreCase)) {
                preserveRetailZ = true;
            } else if (t.StartsWith("--flatten-radius=", StringComparison.OrdinalIgnoreCase)) {
                int equalsIndex = t.IndexOf('=');
                if (equalsIndex >= 0 &&
                    TryParseFloatArg(t[(equalsIndex + 1)..], out var parsedRadius)) {
                    flattenRadius = parsedRadius;
                }
            } else if (t.Equals("--flatten-radius", StringComparison.OrdinalIgnoreCase) && i + 1 < tokens.Length) {
                var val = tokens[++i];
                if (TryParseFloatArg(val, out var parsedRadius))
                    flattenRadius = parsedRadius;
            } else if (t.StartsWith("--flatten-strength=", StringComparison.OrdinalIgnoreCase)) {
                int equalsIndex = t.IndexOf('=');
                if (equalsIndex >= 0 &&
                    TryParseFloatArg(t[(equalsIndex + 1)..], out var parsedStrength)) {
                    flattenStrength = parsedStrength;
                }
            } else if (t.Equals("--flatten-strength", StringComparison.OrdinalIgnoreCase) && i + 1 < tokens.Length) {
                var val = tokens[++i];
                if (TryParseFloatArg(val, out var parsedStrength))
                    flattenStrength = parsedStrength;
            }
        }
        flattenStrength = Math.Clamp(flattenStrength, 0f, 1f);

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Building Remap V2 (Layer Pipeline) â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Remap file        : {remapPath}");
        Console.WriteLine($"  Flatten terrain   : {(flatten ? $"yes (radius={flattenRadius}, strength={flattenStrength:0.##})" : "no")}");
        Console.WriteLine($"  Validators        : {(runValidators ? "enabled" : "disabled")}");
        Console.WriteLine($"  Z profile         : {(preserveRetailZ ? "retail-preserved" : "terrain-integrated (default)")}");
        Console.WriteLine("  Pipeline          : StaticObject â†’ export â†’ SaveToDatsInternal â†’ InstantiateBlueprint");
        Console.WriteLine();

        var r = _engine.RemapBuildingsV2(remapPath, flatten, flattenRadius, flattenStrength, runValidators, preserveRetailZ);

        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }

        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("  âœ“ Buildings added to destination LandblockDocuments!");
        Console.ResetColor();
        Console.WriteLine($"  Landblocks scanned         : {r.LandblocksScanned}");
        Console.WriteLine($"  Landblocks with buildings  : {r.LandblocksWithBuildings}");
        Console.WriteLine($"  Building shells copied     : {r.BuildingShellsCopied}");
        Console.WriteLine($"  Static objects copied      : {r.StaticObjectsCopied}");
        Console.WriteLine($"  Terrain vertices flattened : {r.TerrainVerticesFlattened}");
        Console.WriteLine($"  Elapsed                    : {r.ElapsedMs:F0} ms");
        if (!string.IsNullOrEmpty(r.OldCellIdMapPath))
            Console.WriteLine($"  Old cell ID map            : {r.OldCellIdMapPath}");

        if (r.Warnings != null && r.Warnings.Count > 0) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"\n  Warnings ({r.Warnings.Count}):");
            Console.ResetColor();
            foreach (var w in r.Warnings.Take(20))
                Console.WriteLine($"    âš  {w}");
            if (r.Warnings.Count > 20)
                Console.WriteLine($"    ... and {r.Warnings.Count - 20} more");
        }

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  Next steps:");
        Console.ResetColor();
        Console.WriteLine("    1. export <dir>                    â€” Write DATs (triggers InstantiateBlueprint)");
        Console.WriteLine("    2. remap-buildings-sql <json> <dir> <sql> [--apply]  â€” Generate/apply cell ID SQL");
        Console.WriteLine("    3. ace-db reposition               â€” Reposition outdoor instances");
        Console.WriteLine();
    }

    private void HandleRemapBuildingsSql(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: remap-buildings-sql <lb_remap.json> <exported_dat_dir> <output.sql> [--apply]");
            Console.WriteLine("  Post-export: compares retail vs exported DATs to find cell ID mappings,");
            Console.WriteLine("  generates SQL to update interior instance obj_Cell_Id values.");
            Console.WriteLine();
            Console.WriteLine("  --apply   Apply the SQL directly to the database");
            Console.WriteLine();
            Console.WriteLine("  Example: remap-buildings-sql pipeline_data/population_output/lb_remap.json D:\\ACE\\Dats building_remap_v2.sql --apply");
            return;
        }

        string remapPath = tokens[1];
        string datDir = tokens[2];
        string sqlPath = tokens[3];
        bool apply = tokens.Any(t => t.Equals("--apply", StringComparison.OrdinalIgnoreCase));

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Building Remap SQL (Post-Export) â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Remap file   : {remapPath}");
        Console.WriteLine($"  Exported DATs: {datDir}");
        Console.WriteLine($"  Output SQL   : {sqlPath}");
        Console.WriteLine($"  Apply to DB  : {(apply ? "yes" : "no (dry run)")}");
        Console.WriteLine();

        var r = _engine.GenerateBuildingRemapSql(remapPath, datDir, sqlPath, apply);

        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }

        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("  âœ“ Cell ID remap SQL generated!");
        Console.ResetColor();
        Console.WriteLine($"  Buildings matched  : {r.BuildingsMatched}");
        Console.WriteLine($"  Cell ID remaps     : {r.CellIdRemaps}");
        Console.WriteLine($"  Elapsed            : {r.ElapsedMs:F0} ms");
        if (!string.IsNullOrEmpty(r.SqlFilePath))
            Console.WriteLine($"  SQL file           : {r.SqlFilePath}");
        if (r.Applied) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("  âš¡ SQL applied to database.");
            Console.ResetColor();
        }

        if (r.Warnings != null && r.Warnings.Count > 0) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"\n  Warnings ({r.Warnings.Count}):");
            Console.ResetColor();
            foreach (var w in r.Warnings.Take(20))
                Console.WriteLine($"    âš  {w}");
            if (r.Warnings.Count > 20)
                Console.WriteLine($"    ... and {r.Warnings.Count - 20} more");
        }

        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  ACE Database Commands
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleAceDb(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: ace-db <sub-command>");
            Console.WriteLine("  connect <host> <port> <db> <user> <pass>  Test + save connection");
            Console.WriteLine("  status                                     Show settings + test");
            Console.WriteLine("  query-instances <landblockId>              List instances (hex LB id)");
            Console.WriteLine("  reposition                                 Reposition after terrain edits");
            Console.WriteLine("  export-sql <path>                          Export reposition SQL only");
            Console.WriteLine("  stats                                      World instance counts");
            Console.WriteLine("  clear-instances                            Delete ALL instances + links");
            Console.WriteLine("  ingest-creatures [out]                     Pull creature roster → JSON");
            Console.WriteLine("  ingest-npcs [out]                          Pull NPC roster → JSON");
            Console.WriteLine("  ingest-housing [out]                       Pull housing portal roster → JSON");
            Console.WriteLine("  ingest-spawns [out]                        Pull every landblock_instance (+ gen children) → JSONL");
            Console.WriteLine("  ingest-encounters [out] [append]           Pull every encounter (+ gen children) → JSONL (append merges)");
            Console.WriteLine("  ingest-weenie-index [out]                  Pull canonical wcid → identity map → JSONL");
            return;
        }

        var sub = tokens[1].ToLowerInvariant();
        switch (sub) {
            case "connect":             HandleAceDbConnect(tokens); break;
            case "status":              HandleAceDbStatus(); break;
            case "query-instances":     HandleAceDbQueryInstances(tokens); break;
            case "reposition":          HandleAceDbReposition(); break;
            case "export-sql":          HandleAceDbExportSql(tokens); break;
            case "stats":               HandleAceDbStats(); break;
            case "clear-instances":     HandleAceDbClearInstances(); break;
            case "ingest-creatures":    HandleAceDbIngestCreatures(tokens); break;
            case "ingest-npcs":         HandleAceDbIngestNpcs(tokens); break;
            case "ingest-housing":      HandleAceDbIngestHousing(tokens); break;
            case "ingest-spawns":       HandleAceDbIngestSpawns(tokens); break;
            case "ingest-encounters":   HandleAceDbIngestEncounters(tokens); break;
            case "ingest-weenie-index": HandleAceDbIngestWeenieIndex(tokens); break;
            default:
                Console.WriteLine($"Unknown ace-db sub-command: '{sub}'");
                Console.WriteLine("  Available: connect, status, query-instances, reposition, export-sql, stats, clear-instances, ingest-creatures, ingest-npcs, ingest-housing, ingest-spawns, ingest-encounters, ingest-weenie-index");
                break;
        }
    }

    private void HandleAceDbIngestCreatures(string[] tokens) {
        string? outPath = tokens.Length > 2 ? tokens[2] : null;
        Console.WriteLine("Pulling creature roster from ACE DB...");
        var r = _engine.IngestCreatureRosterAsync(outPath).GetAwaiter().GetResult();
        if (r.Success) {
            Console.WriteLine($"  ✓ {r.TotalProcessed} creatures → {r.OutputPath}");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ {r.Error}");
            Console.ResetColor();
        }
    }

    private void HandleAceDbIngestNpcs(string[] tokens) {
        string? outPath = tokens.Length > 2 ? tokens[2] : null;
        Console.WriteLine("Pulling NPC roster from ACE DB...");
        var r = _engine.IngestNpcRosterAsync(outPath).GetAwaiter().GetResult();
        if (r.Success) {
            Console.WriteLine($"  ✓ {r.TotalProcessed} NPCs ({r.VendorCount} vendors, {r.OtherNpcCount} other) → {r.OutputPath}");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ {r.Error}");
            Console.ResetColor();
        }
    }

    private void HandleAceDbIngestHousing(string[] tokens) {
        string? outPath = tokens.Length > 2 ? tokens[2] : null;
        Console.WriteLine("Pulling housing roster from ACE DB...");
        var r = _engine.IngestHousingRosterAsync(outPath).GetAwaiter().GetResult();
        if (r.Success) {
            Console.WriteLine($"  ✓ {r.HouseCount} houses, {r.PortalCount} portals → {r.OutputPath}");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ {r.Error}");
            Console.ResetColor();
        }
    }

    private void HandleAceDbIngestSpawns(string[] tokens) {
        string? outPath = tokens.Length > 2 ? tokens[2] : null;
        Console.WriteLine("Pulling landblock_instance rows from ACE DB...");
        var r = _engine.IngestAceSpawnsAsync(outPath).GetAwaiter().GetResult();
        if (r.Success) {
            Console.WriteLine($"  ✓ {r.RecordsWritten} spawns across {r.LandblocksTouched} LBs ({r.SyntheticRecords} synthetic, {r.GeneratorChildren} generator children) → {r.OutputPath}");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ {r.Error}");
            Console.ResetColor();
        }
    }

    private void HandleAceDbIngestEncounters(string[] tokens) {
        string? outPath = tokens.Length > 2 ? tokens[2] : null;
        bool append = tokens.Length > 3
            && (tokens[3].Equals("append", StringComparison.OrdinalIgnoreCase)
                || tokens[3].Equals("true", StringComparison.OrdinalIgnoreCase));
        Console.WriteLine("Pulling encounter rows from ACE DB...");
        var r = _engine.IngestAceEncountersAsync(outPath, append).GetAwaiter().GetResult();
        if (r.Success) {
            Console.WriteLine($"  ✓ {r.RecordsWritten} encounter records across {r.LandblocksTouched} LBs ({r.SyntheticRecords} synthetic, {r.ZeroZRecords} zero-Z) → {r.OutputPath}");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ {r.Error}");
            Console.ResetColor();
        }
    }

    private void HandleAceDbIngestWeenieIndex(string[] tokens) {
        string? outPath = tokens.Length > 2 ? tokens[2] : null;
        Console.WriteLine("Pulling canonical wcid → identity map from ACE DB...");
        var r = _engine.IngestWeenieIndexAsync(outPath).GetAwaiter().GetResult();
        if (r.Success) {
            Console.WriteLine($"  ✓ {r.TotalEntries:N0} weenies ({r.WithSetupDid:N0} with setup, {r.ServerManaged:N0} server-managed) → {r.OutputPath}");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ {r.Error}");
            Console.ResetColor();
        }
    }

    private void HandleAceDbConnect(string[] tokens) {
        if (tokens.Length < 7) {
            Console.WriteLine("Usage: ace-db connect <host> <port> <database> <user> <password>");
            Console.WriteLine("  Example: ace-db connect localhost 3306 ace_world root mypassword");
            return;
        }

        string host = tokens[2];
        if (!TryParseInt(tokens[3], "port", out int port)) return;
        string database = tokens[4];
        string user = tokens[5];
        string password = tokens[6];

        Console.WriteLine($"Testing connection to {host}:{port}/{database} as {user}...");

        var r = _engine.AceDbConnectAsync(host, port, database, user, password)
            .GetAwaiter().GetResult();

        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("  âœ“ Connection successful!");
            Console.ResetColor();
            Console.WriteLine($"  Host     : {r.Host}:{r.Port}");
            Console.WriteLine($"  Database : {r.Database}");
            Console.WriteLine($"  User     : {r.User}");
            if (r.SettingsSaved) {
                Console.ForegroundColor = ConsoleColor.Cyan;
                Console.WriteLine("  Settings saved to project JSON.");
                Console.ResetColor();
            } else {
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine("  No project loaded â€” settings not saved.");
                Console.ResetColor();
            }
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Connection failed: {r.Error}");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    // E1 (wave-2) PR3 — ACE SHARD DB (separate from world ace-db; Option B biota override target).
    private void HandleAceShardDb(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: ace-shard-db <sub-command>");
            Console.WriteLine("  connect <host> <port> [db] <user> <pass>  Test + save SHARD connection (db defaults to ace_shard)");
            Console.WriteLine("  status                                     Show shard settings + test");
            return;
        }
        var sub = tokens[1].ToLowerInvariant();
        switch (sub) {
            case "connect": HandleAceShardDbConnect(tokens); break;
            case "status":  HandleAceShardDbStatus(); break;
            default:
                Console.WriteLine($"Unknown ace-shard-db sub-command: '{sub}'");
                Console.WriteLine("  Available: connect, status");
                break;
        }
    }

    private void HandleAceShardDbConnect(string[] tokens) {
        // ace-shard-db connect <host> <port> <database> <user> <password>
        if (tokens.Length < 7) {
            Console.WriteLine("Usage: ace-shard-db connect <host> <port> <database> <user> <password>");
            Console.WriteLine("  Example: ace-shard-db connect localhost 3306 ace_shard root mypassword");
            return;
        }
        string host = tokens[2];
        if (!TryParseInt(tokens[3], "port", out int port)) return;
        string database = tokens[4];
        string user = tokens[5];
        string password = tokens[6];

        Console.WriteLine($"Testing SHARD connection to {host}:{port}/{database} as {user}...");
        var r = _engine.AceShardDbConnectAsync(host, port, database, user, password).GetAwaiter().GetResult();
        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("  Shard connection successful!");
            Console.ResetColor();
            Console.WriteLine($"  Host     : {r.Host}:{r.Port}");
            Console.WriteLine($"  Database : {r.Database}");
            Console.WriteLine($"  User     : {r.User}");
            if (r.SettingsSaved) {
                Console.ForegroundColor = ConsoleColor.Cyan;
                Console.WriteLine("  Shard settings saved to project JSON.");
                Console.ResetColor();
            } else {
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine("  No project loaded - settings not saved.");
                Console.ResetColor();
            }
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  Shard connection failed: {r.Error}");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    private void HandleAceShardDbStatus() {
        var r = _engine.AceShardDbStatusAsync().GetAwaiter().GetResult();
        Console.WriteLine();
        if (!r.HasSettings) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("  No ACE SHARD database settings configured.");
            Console.WriteLine("  Use 'ace-shard-db connect <host> <port> <db> <user> <pass>' to set up.");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }
        Console.WriteLine("  === ACE Shard Database Status ===");
        Console.WriteLine($"  Host     : {r.Host}:{r.Port}");
        Console.WriteLine($"  Database : {r.Database}");
        Console.WriteLine($"  User     : {r.User}");
        Console.WriteLine($"  Connection: {(r.ConnectionOk == true ? "OK" : "FAILED")}");
        if (r.Error != null) Console.WriteLine($"  Error    : {r.Error}");
        Console.WriteLine();
    }

    private void HandleAceDbStatus() {
        var r = _engine.AceDbStatusAsync().GetAwaiter().GetResult();

        Console.WriteLine();
        if (!r.HasSettings) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("  No ACE database settings configured.");
            Console.WriteLine("  Use 'ace-db connect <host> <port> <db> <user> <pass>' to set up.");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("  â•â•â• ACE Database Status â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Host     : {r.Host}:{r.Port}");
        Console.WriteLine($"  Database : {r.Database}");
        Console.WriteLine($"  User     : {r.User}");

        if (r.ConnectionOk == true) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("  Status   : âœ“ Connected");
            Console.ResetColor();
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  Status   : âœ— {r.Error ?? "Connection failed"}");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    private void HandleAceDbQueryInstances(string[] tokens) {
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: ace-db query-instances <landblockId>");
            Console.WriteLine("  landblockId â€” hex landblock ID (e.g., 7D64 or 0x7D64)");
            Console.WriteLine("  Example: ace-db query-instances 7D64");
            return;
        }

        if (!TryParseHex(tokens[2], "landblockId", out uint lbIdRaw)) return;
        ushort landblockId = (ushort)lbIdRaw;

        Console.WriteLine($"Querying instances in landblock 0x{landblockId:X4}...");

        var r = _engine.AceDbQueryInstancesAsync(landblockId).GetAwaiter().GetResult();

        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }

        if (r.InstanceCount == 0) {
            Console.WriteLine($"  No instances found in landblock 0x{r.LandblockId:X4}");
            Console.WriteLine();
            return;
        }

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine($"  â•â•â• Landblock 0x{r.LandblockId:X4} â€” {r.InstanceCount} instance(s) â•â•â•");
        Console.ResetColor();
        Console.WriteLine();

        int outdoorCount = r.Instances.Count(i => i.IsOutdoor);
        int indoorCount = r.Instances.Count(i => !i.IsOutdoor);
        Console.WriteLine($"  Outdoor: {outdoorCount}  |  Indoor: {indoorCount}");
        Console.WriteLine();

        Console.WriteLine($"  {"Guid",-12} {"WCID",-8} {"CellId",-12} {"Type",-8} {"X",-10} {"Y",-10} {"Z",-10}");
        Console.WriteLine($"  {new string('-', 72)}");

        foreach (var inst in r.Instances.Take(50)) {
            Console.WriteLine($"  {inst.Guid,-12} {inst.WeenieClassId,-8} 0x{inst.ObjCellId:X8}   {(inst.IsOutdoor ? "Out" : "In"),-8} {inst.OriginX,-10:F2} {inst.OriginY,-10:F2} {inst.OriginZ,-10:F2}");
        }

        if (r.InstanceCount > 50) {
            Console.WriteLine($"  ... and {r.InstanceCount - 50} more");
        }
        Console.WriteLine();
    }

    private void HandleAceDbReposition() {
        if (!CheckProject()) return;

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• ACE DB Instance Reposition â•â•â•");
        Console.ResetColor();
        Console.WriteLine("  Comparing current terrain edits vs base DAT heights...");
        Console.WriteLine("  This will UPDATE the database directly.");
        Console.WriteLine();

        var r = _engine.AceDbRepositionAsync().GetAwaiter().GetResult();

        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }

        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("  âœ“ Reposition complete!");
        Console.ResetColor();
        Console.WriteLine($"  Landblocks processed : {r.LandblocksProcessed}");
        Console.WriteLine($"  Instances checked    : {r.InstancesChecked}");
        Console.WriteLine($"  Instances updated    : {r.InstancesUpdated}");
        if (!string.IsNullOrEmpty(r.SqlFilePath))
            Console.WriteLine($"  SQL file             : {r.SqlFilePath}");
        if (r.AppliedDirectly) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("  âš¡ Changes applied directly to database.");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    private void HandleAceDbExportSql(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: ace-db export-sql <output-path>");
            Console.WriteLine("  Example: ace-db export-sql reposition.sql");
            return;
        }

        string outputPath = tokens[2];

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  â•â•â• Export Reposition SQL â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Output: {outputPath}");
        Console.WriteLine("  Comparing current terrain edits vs base DAT heights...");
        Console.WriteLine();

        var r = _engine.AceDbExportSqlAsync(outputPath).GetAwaiter().GetResult();

        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }

        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("  âœ“ SQL exported!");
        Console.ResetColor();
        Console.WriteLine($"  Landblocks processed : {r.LandblocksProcessed}");
        Console.WriteLine($"  Instances checked    : {r.InstancesChecked}");
        Console.WriteLine($"  Instances updated    : {r.InstancesUpdated}");
        if (!string.IsNullOrEmpty(r.SqlFilePath))
            Console.WriteLine($"  SQL file             : {r.SqlFilePath}");
        Console.WriteLine();
    }

    private void HandleAceDbStats() {
        var r = _engine.AceDbStatsAsync().GetAwaiter().GetResult();

        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("  â•â•â• ACE Database Statistics â•â•â•");
        Console.ResetColor();
        Console.WriteLine($"  Total instances      : {r.TotalInstances:N0}");
        Console.WriteLine($"  Landblocks with data : {r.TotalLandblocks:N0}");
        Console.WriteLine();

        if (r.DensestLandblocks is { Count: > 0 }) {
            Console.ForegroundColor = ConsoleColor.White;
            Console.WriteLine("  Top 10 Densest Landblocks:");
            Console.ResetColor();
            Console.WriteLine($"  {"Landblock",-12} {"Instances",-12}");
            Console.WriteLine($"  {new string('-', 24)}");
            foreach (var lb in r.DensestLandblocks) {
                Console.WriteLine($"  0x{lb.LandblockId:X4}      {lb.InstanceCount,-12}");
            }
        }

        Console.WriteLine();
    }

    private void HandleAceDbClearInstances() {
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("  âš  This will DELETE all landblock_instance and landblock_instance_link records!");
        Console.ResetColor();
        Console.Write("  Are you sure? (y/N): ");
        var confirm = Console.ReadLine()?.Trim().ToLowerInvariant();
        if (confirm != "y" && confirm != "yes") {
            Console.WriteLine("  Cancelled.");
            Console.WriteLine();
            return;
        }

        var r = _engine.AceDbClearInstancesAsync().GetAwaiter().GetResult();
        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
        } else {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  âœ“ Deleted {r.InstancesDeleted:N0} instances and {r.LinksDeleted:N0} links");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Dungeon Document Operations
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleDungeon(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: dungeon <sub-command>");
            Console.WriteLine("  add-cell <lbX> <lbY> <envId> <csId> <x> <y> <z>");
            Console.WriteLine("  remove-cell <lbX> <lbY> <cellNum>");
            Console.WriteLine("  connect <lbX> <lbY> <cellA> <polyA> <cellB> <polyB>");
            Console.WriteLine("  disconnect <lbX> <lbY> <cellA> <cellB>");
            Console.WriteLine("  validate <lbX> <lbY>");
            Console.WriteLine("  autofix <lbX> <lbY>");
            Console.WriteLine("  recompute <lbX> <lbY>");
            Console.WriteLine("  reload <lbX> <lbY>");
            Console.WriteLine("  copy-cells <srcX> <srcY> <destX> <destY>");
            Console.WriteLine("  move-cell <lbX> <lbY> <cellNum> <dX> <dY> <dZ>");
            Console.WriteLine("  rotate-cell <lbX> <lbY> <cellNum> <degrees> <axisX> <axisY> <axisZ>");
            Console.WriteLine("  move-object <lbX> <lbY> <cellNum> <objIndex> <dX> <dY> <dZ>");
            Console.WriteLine("  rotate-object <lbX> <lbY> <cellNum> <objIndex> <degrees>");
            Console.WriteLine("  set-cell-position <lbX> <lbY> <cellNum> <x> <y> <z>");
            Console.WriteLine("  set-cell-rotation <lbX> <lbY> <cellNum> <rotX> <rotY> <rotZ>");
            Console.WriteLine("  set-object-position <lbX> <lbY> <cellNum> <objIndex> <x> <y> <z>");
            Console.WriteLine("  set-object-rotation <lbX> <lbY> <cellNum> <objIndex> <degrees>");
            return;
        }

        var sub = tokens[1].ToLowerInvariant();
        switch (sub) {
            case "add-cell":    HandleDungeonAddCell(tokens); break;
            case "remove-cell": HandleDungeonRemoveCell(tokens); break;
            case "connect":     HandleDungeonConnect(tokens); break;
            case "disconnect":  HandleDungeonDisconnect(tokens); break;
            case "validate":    HandleDungeonValidate(tokens); break;
            case "autofix":     HandleDungeonAutoFix(tokens); break;
            case "recompute":   HandleDungeonRecompute(tokens); break;
            case "reload":      HandleDungeonReload(tokens); break;
            case "copy-cells":  HandleDungeonCopyCells(tokens); break;
            case "move-cell":   HandleDungeonMoveCell(tokens); break;
            case "rotate-cell": HandleDungeonRotateCell(tokens); break;
            case "move-object": HandleDungeonMoveObject(tokens); break;
            case "rotate-object": HandleDungeonRotateObject(tokens); break;
            case "set-cell-position": HandleDungeonSetCellPosition(tokens); break;
            case "set-cell-rotation": HandleDungeonSetCellRotation(tokens); break;
            case "set-object-position": HandleDungeonSetObjectPosition(tokens); break;
            case "set-object-rotation": HandleDungeonSetObjectRotation(tokens); break;
            default:
                Console.WriteLine($"Unknown dungeon sub-command: '{sub}'");
                Console.WriteLine("  Available: add-cell, remove-cell, connect, disconnect, validate, autofix, recompute, reload, copy-cells, move-cell, rotate-cell, move-object, rotate-object, set-cell-position, set-cell-rotation, set-object-position, set-object-rotation");
                break;
        }
    }

    private void HandleDungeonAddCell(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 9) {
            Console.WriteLine("Usage: dungeon add-cell <lbX> <lbY> <envId> <csId> <x> <y> <z>");
            Console.WriteLine("  envId, csId â€” hex environment / cell-structure IDs");
            Console.WriteLine("  Example: dungeon add-cell 1 217 0x0001 0 0 0 0");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[4], "envId", out uint envIdU)) return;
        if (!TryParseHex(tokens[5], "csId", out uint csIdU)) return;
        if (!TryParseFloat(tokens[6], "x", out float x)) return;
        if (!TryParseFloat(tokens[7], "y", out float y)) return;
        if (!TryParseFloat(tokens[8], "z", out float z)) return;

        var r = _engine.DungeonAddCell(lbX, lbY, (ushort)envIdU, (ushort)csIdU, x, y, z);

        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  âœ“ Cell 0x{r.CellNumber:X4} added to landblock 0x{r.LbKey:X4}");
            Console.ResetColor();
            Console.WriteLine($"  Environment : 0x{r.EnvironmentId:X4}");
            Console.WriteLine($"  Structure   : {r.CellStructure}");
            Console.WriteLine($"  Origin      : ({x:F1}, {y:F1}, {z:F1})");
            Console.WriteLine($"  Total cells : {r.TotalCells}");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    private void HandleDungeonRemoveCell(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 5) {
            Console.WriteLine("Usage: dungeon remove-cell <lbX> <lbY> <cellNumber>");
            Console.WriteLine("  cellNumber â€” hex cell ID (e.g., 0x0100)");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[4], "cellNumber", out uint cellNumU)) return;

        var r = _engine.DungeonRemoveCell(lbX, lbY, (ushort)cellNumU);

        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  âœ“ Cell 0x{r.CellNumber:X4} removed from landblock 0x{r.LbKey:X4}");
            Console.ResetColor();
            Console.WriteLine($"  Remaining cells: {r.TotalCells}");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    private void HandleDungeonConnect(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 8) {
            Console.WriteLine("Usage: dungeon connect <lbX> <lbY> <cellA> <polyA> <cellB> <polyB>");
            Console.WriteLine("  All cell/poly args are hex (e.g., 0x0100 0x0001 0x0101 0x0002)");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[4], "cellA", out uint cellAU)) return;
        if (!TryParseHex(tokens[5], "polyA", out uint polyAU)) return;
        if (!TryParseHex(tokens[6], "cellB", out uint cellBU)) return;
        if (!TryParseHex(tokens[7], "polyB", out uint polyBU)) return;

        var r = _engine.DungeonConnect(lbX, lbY,
            (ushort)cellAU, (ushort)polyAU, (ushort)cellBU, (ushort)polyBU);

        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  âœ“ Connected 0x{r.CellA:X4} (poly 0x{r.PolyA:X4}) âŸ· 0x{r.CellB:X4} (poly 0x{r.PolyB:X4})");
            Console.ResetColor();
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    private void HandleDungeonDisconnect(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 6) {
            Console.WriteLine("Usage: dungeon disconnect <lbX> <lbY> <cellA> <cellB>");
            Console.WriteLine("  cellA, cellB â€” hex cell numbers");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[4], "cellA", out uint cellAU)) return;
        if (!TryParseHex(tokens[5], "cellB", out uint cellBU)) return;

        var r = _engine.DungeonDisconnect(lbX, lbY, (ushort)cellAU, (ushort)cellBU);

        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  âœ“ Disconnected 0x{r.CellA:X4} âŸ· 0x{r.CellB:X4}");
            Console.ResetColor();
            Console.WriteLine($"  Portals removed: {r.PortalsRemoved}");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    private void HandleDungeonValidate(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: dungeon validate <lbX> <lbY>");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;

        var r = _engine.DungeonValidateDoc(lbX, lbY);
        ushort lbKey = (ushort)((lbX << 8) | lbY);

        Console.WriteLine();
        if (r.CellCount == 0 && r.Error != null) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"  No dungeon data in landblock 0x{lbKey:X4}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine($"  â•â•â• Dungeon Validation â€” 0x{lbKey:X4} ({r.CellCount} cells) â•â•â•");
        Console.ResetColor();
        Console.WriteLine();

        foreach (var issue in r.Issues) {
            var color = issue.Severity switch {
                "Error" => ConsoleColor.Red,
                "Warning" => ConsoleColor.Yellow,
                _ => ConsoleColor.DarkGray
            };
            var icon = issue.Severity switch {
                "Error" => "âœ—",
                "Warning" => "âš ",
                _ => "â„¹"
            };
            Console.ForegroundColor = color;
            Console.Write($"  {icon} [{issue.Severity}]");
            Console.ResetColor();
            Console.WriteLine($" {issue.Message}");
        }

        Console.WriteLine();
        Console.WriteLine($"  Summary: {r.Errors} error(s), {r.Warnings} warning(s), {r.Infos} info(s)");
        Console.WriteLine();
    }

    private void HandleDungeonAutoFix(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: dungeon autofix <lbX> <lbY>");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;

        var r = _engine.DungeonAutoFix(lbX, lbY);
        ushort lbKey = (ushort)((lbX << 8) | lbY);

        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
        } else if (r.FixesApplied == 0) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  âœ“ No issues found in 0x{lbKey:X4} â€” all portals are bidirectional.");
            Console.ResetColor();
        } else {
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine($"  âœ“ Auto-fixed {r.FixesApplied} one-way portal(s) in 0x{lbKey:X4}");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    private void HandleDungeonRecompute(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: dungeon recompute <lbX> <lbY>");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;

        var r = _engine.DungeonRecompute(lbX, lbY);
        ushort lbKey = (ushort)((lbX << 8) | lbY);

        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
        } else {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  âœ“ Recomputed 0x{lbKey:X4}:");
            Console.ResetColor();
            Console.WriteLine($"  VisibleCells updated : {r.VisibleCellsUpdated}");
            Console.WriteLine($"  Portal flags updated : {r.PortalFlagsUpdated}");
        }
        Console.WriteLine();
    }

    private void HandleDungeonReload(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: dungeon reload <lbX> <lbY>");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;

        var r = _engine.DungeonReload(lbX, lbY);
        ushort lbKey = (ushort)((lbX << 8) | lbY);

        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine($"  âœ“ Reloaded dungeon 0x{lbKey:X4} from DAT â€” {r.CellCount} cell(s)");
            Console.ResetColor();
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    private void HandleDungeonCopyCells(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 6) {
            Console.WriteLine("Usage: dungeon copy-cells <srcLbX> <srcLbY> <destLbX> <destLbY>");
            Console.WriteLine("  Copies all cells from source dungeon to destination (renumbers automatically)");
            return;
        }
        if (!TryParseUint(tokens[2], "srcLbX", out uint srcX)) return;
        if (!TryParseUint(tokens[3], "srcLbY", out uint srcY)) return;
        if (!TryParseUint(tokens[4], "destLbX", out uint destX)) return;
        if (!TryParseUint(tokens[5], "destLbY", out uint destY)) return;

        ushort srcKey = (ushort)((srcX << 8) | srcY);
        ushort destKey = (ushort)((destX << 8) | destY);

        var r = _engine.DungeonCopyCells(srcX, srcY, destX, destY);

        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  âœ“ Copied dungeon from 0x{srcKey:X4} â†’ 0x{destKey:X4}");
            Console.ResetColor();
            Console.WriteLine($"  Cells copied: {r.CellsCopied}");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— Error: {r.Error}");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    private void HandleDungeonMoveCell(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 8) {
            Console.WriteLine("Usage: dungeon move-cell <lbX> <lbY> <cellNum> <dX> <dY> <dZ>");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[4], "cellNum", out uint cellNumU)) return;
        if (!TryParseFloat(tokens[5], "dX", out float dx)) return;
        if (!TryParseFloat(tokens[6], "dY", out float dy)) return;
        if (!TryParseFloat(tokens[7], "dZ", out float dz)) return;

        var r = _engine.DungeonMoveCell(lbX, lbY, (ushort)cellNumU, dx, dy, dz);
        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  ✓ Moved cell 0x{r.CellNumber:X4} by ({r.DeltaX:F2}, {r.DeltaY:F2}, {r.DeltaZ:F2})");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ Error: {r.Error}");
        }
        Console.ResetColor();
        Console.WriteLine();
    }

    private void HandleDungeonRotateCell(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 9) {
            Console.WriteLine("Usage: dungeon rotate-cell <lbX> <lbY> <cellNum> <degrees> <axisX> <axisY> <axisZ>");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[4], "cellNum", out uint cellNumU)) return;
        if (!TryParseFloat(tokens[5], "degrees", out float degrees)) return;
        if (!TryParseFloat(tokens[6], "axisX", out float axisX)) return;
        if (!TryParseFloat(tokens[7], "axisY", out float axisY)) return;
        if (!TryParseFloat(tokens[8], "axisZ", out float axisZ)) return;

        var r = _engine.DungeonRotateCell(lbX, lbY, (ushort)cellNumU, degrees, axisX, axisY, axisZ);
        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  ✓ Rotated cell 0x{r.CellNumber:X4} by {r.Degrees:F1}° around ({r.AxisX:F2}, {r.AxisY:F2}, {r.AxisZ:F2})");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ Error: {r.Error}");
        }
        Console.ResetColor();
        Console.WriteLine();
    }

    private void HandleDungeonMoveObject(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 9) {
            Console.WriteLine("Usage: dungeon move-object <lbX> <lbY> <cellNum> <objIndex> <dX> <dY> <dZ>");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[4], "cellNum", out uint cellNumU)) return;
        if (!TryParseInt(tokens[5], "objIndex", out int objectIndex)) return;
        if (!TryParseFloat(tokens[6], "dX", out float dx)) return;
        if (!TryParseFloat(tokens[7], "dY", out float dy)) return;
        if (!TryParseFloat(tokens[8], "dZ", out float dz)) return;

        var r = _engine.DungeonMoveObject(lbX, lbY, (ushort)cellNumU, objectIndex, dx, dy, dz);
        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  ✓ Moved object[{r.ObjectIndex}] in cell 0x{r.CellNumber:X4} by ({r.DeltaX:F2}, {r.DeltaY:F2}, {r.DeltaZ:F2})");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ Error: {r.Error}");
        }
        Console.ResetColor();
        Console.WriteLine();
    }

    private void HandleDungeonRotateObject(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 7) {
            Console.WriteLine("Usage: dungeon rotate-object <lbX> <lbY> <cellNum> <objIndex> <degrees>");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[4], "cellNum", out uint cellNumU)) return;
        if (!TryParseInt(tokens[5], "objIndex", out int objectIndex)) return;
        if (!TryParseFloat(tokens[6], "degrees", out float degrees)) return;

        var r = _engine.DungeonRotateObject(lbX, lbY, (ushort)cellNumU, objectIndex, degrees);
        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  ✓ Rotated object[{r.ObjectIndex}] in cell 0x{r.CellNumber:X4} by {r.Degrees:F1}° (Z axis)");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ Error: {r.Error}");
        }
        Console.ResetColor();
        Console.WriteLine();
    }

    private void HandleDungeonSetCellPosition(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 8) {
            Console.WriteLine("Usage: dungeon set-cell-position <lbX> <lbY> <cellNum> <x> <y> <z>");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[4], "cellNum", out uint cellNumU)) return;
        if (!TryParseFloat(tokens[5], "x", out float x)) return;
        if (!TryParseFloat(tokens[6], "y", out float y)) return;
        if (!TryParseFloat(tokens[7], "z", out float z)) return;

        var r = _engine.DungeonSetCellPosition(lbX, lbY, (ushort)cellNumU, x, y, z);
        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  ✓ Set cell 0x{r.CellNumber:X4} position to ({r.X:F2}, {r.Y:F2}, {r.Z:F2})");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ Error: {r.Error}");
        }
        Console.ResetColor();
        Console.WriteLine();
    }

    private void HandleDungeonSetCellRotation(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 8) {
            Console.WriteLine("Usage: dungeon set-cell-rotation <lbX> <lbY> <cellNum> <rotX> <rotY> <rotZ>");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[4], "cellNum", out uint cellNumU)) return;
        if (!TryParseFloat(tokens[5], "rotX", out float rotX)) return;
        if (!TryParseFloat(tokens[6], "rotY", out float rotY)) return;
        if (!TryParseFloat(tokens[7], "rotZ", out float rotZ)) return;

        var r = _engine.DungeonSetCellRotation(lbX, lbY, (ushort)cellNumU, rotX, rotY, rotZ);
        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  ✓ Set cell 0x{r.CellNumber:X4} rotation to ({r.RotX:F1}, {r.RotY:F1}, {r.RotZ:F1})");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ Error: {r.Error}");
        }
        Console.ResetColor();
        Console.WriteLine();
    }

    private void HandleDungeonSetObjectPosition(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 9) {
            Console.WriteLine("Usage: dungeon set-object-position <lbX> <lbY> <cellNum> <objIndex> <x> <y> <z>");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[4], "cellNum", out uint cellNumU)) return;
        if (!TryParseInt(tokens[5], "objIndex", out int objectIndex)) return;
        if (!TryParseFloat(tokens[6], "x", out float x)) return;
        if (!TryParseFloat(tokens[7], "y", out float y)) return;
        if (!TryParseFloat(tokens[8], "z", out float z)) return;

        var r = _engine.DungeonSetObjectPosition(lbX, lbY, (ushort)cellNumU, objectIndex, x, y, z);
        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  ✓ Set object[{r.ObjectIndex}] in cell 0x{r.CellNumber:X4} position to ({r.X:F2}, {r.Y:F2}, {r.Z:F2})");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ Error: {r.Error}");
        }
        Console.ResetColor();
        Console.WriteLine();
    }

    private void HandleDungeonSetObjectRotation(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 7) {
            Console.WriteLine("Usage: dungeon set-object-rotation <lbX> <lbY> <cellNum> <objIndex> <degrees>");
            return;
        }
        if (!TryParseUint(tokens[2], "lbX", out uint lbX)) return;
        if (!TryParseUint(tokens[3], "lbY", out uint lbY)) return;
        if (!TryParseHex(tokens[4], "cellNum", out uint cellNumU)) return;
        if (!TryParseInt(tokens[5], "objIndex", out int objectIndex)) return;
        if (!TryParseFloat(tokens[6], "degrees", out float degrees)) return;

        var r = _engine.DungeonSetObjectRotation(lbX, lbY, (ushort)cellNumU, objectIndex, degrees);
        Console.WriteLine();
        if (r.Success) {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  ✓ Set object[{r.ObjectIndex}] in cell 0x{r.CellNumber:X4} rotation to {r.Degrees:F1}°");
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  ✗ Error: {r.Error}");
        }
        Console.ResetColor();
        Console.WriteLine();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Terrain Sub-commands
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private void HandleTerrain(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: terrain <sub-command>");
            Console.WriteLine("  sample-height <worldX> <worldY>   AC-accurate triangle-interpolated height");
            return;
        }

        var sub = tokens[1].ToLowerInvariant();
        switch (sub) {
            case "sample-height": HandleTerrainSampleHeight(tokens); break;
            default:
                Console.WriteLine($"Unknown terrain sub-command: '{sub}'");
                Console.WriteLine("  Available: sample-height");
                break;
        }
    }

    private void HandleTerrainSampleHeight(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: terrain sample-height <worldX> <worldY>");
            Console.WriteLine("  Returns AC-accurate triangle-interpolated height and");
            Console.WriteLine("  nearest-vertex height for comparison.");
            Console.WriteLine("  Example: terrain sample-height 12000.5 12000.5");
            return;
        }
        if (!TryParseFloat(tokens[2], "worldX", out float wx)) return;
        if (!TryParseFloat(tokens[3], "worldY", out float wy)) return;

        var r = _engine.SampleHeight(wx, wy);

        Console.WriteLine();
        if (r.Error != null) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  âœ— {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine($"  â•â•â• Terrain Sample at ({r.WorldX:F1}, {r.WorldY:F1}) â•â•â•");
        Console.ResetColor();
        Console.WriteLine();
        Console.WriteLine($"  Landblock        : 0x{r.LandblockId:X4}");
        Console.WriteLine($"  Local position   : ({r.LocalX:F2}, {r.LocalY:F2})");
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine($"  Triangle height  : {r.TriangleHeight:F4}  (AC-accurate)");
        Console.ResetColor();
        Console.WriteLine($"  Vertex height    : {r.VertexHeight:F4}  (nearest grid point)");

        if (Math.Abs(r.Difference) > 0.01f) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"  Difference       : {r.Difference:+0.####;-0.####}");
            Console.ResetColor();
        } else {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"  Difference       : {r.Difference:F4} (on vertex)");
            Console.ResetColor();
        }
        Console.WriteLine();
    }

    // ═══════════════════════════════════════════════════════════
    //  Mesh I/O & BSP (slice 1 of f26345e port)
    // ═══════════════════════════════════════════════════════════

    private void HandleObjExport(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: obj-export <datId> <output.obj>");
            Console.WriteLine("  Exports a Setup (0x02xxxxxx) or GfxObj (0x01xxxxxx) to Wavefront .obj.");
            Console.WriteLine("  Example: obj-export 0x02001234 ./model.obj");
            return;
        }
        if (!TryParseHex(tokens[1], "datId", out uint datId)) return;
        var r = _engine.ObjExport(datId, tokens[2]);
        Console.WriteLine();
        if (!r.Found) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  obj-export {r.HexId} ({r.DatType}): FAILED — {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }
        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine($"  obj-export {r.HexId} ({r.DatType}) → {r.OutputPath}");
        Console.ResetColor();
        Console.WriteLine($"  Parts          : {r.PartCount}");
        if (r.TriangleCount > 0)
            Console.WriteLine($"  Polygons       : {r.TriangleCount}");
        Console.WriteLine();
    }

    private void HandleObjImport(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 3) {
            Console.WriteLine("Usage: obj-import <input.obj> <surfaceDid> [gfxObjId] [setupId]");
            Console.WriteLine("  Imports a Wavefront .obj as GfxObj+Setup into the project's portal-dat overrides.");
            Console.WriteLine("  Set gfxObjId/setupId to 0 (or omit) to auto-allocate in the 0x01FFxxxx / 0x02FFxxxx custom range.");
            Console.WriteLine("  Persisted on the next 'export'.");
            Console.WriteLine("  Example: obj-import ./tower.obj 0x08000123");
            return;
        }
        if (!TryParseHex(tokens[2], "surfaceDid", out uint surfaceDid)) return;
        uint gfxObjId = 0, setupId = 0;
        if (tokens.Length >= 4 && !TryParseHex(tokens[3], "gfxObjId", out gfxObjId)) return;
        if (tokens.Length >= 5 && !TryParseHex(tokens[4], "setupId", out setupId)) return;
        var r = _engine.ObjImport(tokens[1], surfaceDid, gfxObjId, setupId);
        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  obj-import: FAILED — {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }
        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine($"  obj-import: OK");
        Console.ResetColor();
        Console.WriteLine($"  GfxObj id      : 0x{r.GfxObjId:X8}");
        Console.WriteLine($"  Setup id       : 0x{r.SetupId:X8}");
        Console.WriteLine($"  Triangles      : {r.TriangleCount}");
        Console.WriteLine($"  Vertices       : {r.VertexCount}");
        Console.WriteLine("  Stored in PortalDatDocument; will persist on next 'export'.");
        Console.WriteLine();
    }

    // ═══════════════════════════════════════════════════════════
    //  WorldGen (slice 3 of f26345e port)
    // ═══════════════════════════════════════════════════════════

    private void HandleWorldGen(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2 || tokens[1] == "--help") {
            Console.WriteLine("Usage: worldgen [options]");
            Console.WriteLine("  Runs the WorldGenerator pipeline (terrain + biomes + towns + roads + buildings).");
            Console.WriteLine("  DRY-RUN by default. Add --apply to actually mutate project documents:");
            Console.WriteLine("    terrain → TerrainDocument.UpdateLandblocksBatchInternal (vertices overwritten)");
            Console.WriteLine("    buildings/decorations → LandblockDocument.AddStaticObject (appended)");
            Console.WriteLine("  Run 'export <dir>' afterwards to write to DATs.");
            Console.WriteLine();
            Console.WriteLine("  Options:");
            Console.WriteLine("    --seed <n>            (default 0 = random)");
            Console.WriteLine("    --start <x> <y>       (default 0 0)");
            Console.WriteLine("    --size <w> <h>        (default 20 20)");
            Console.WriteLine("    --full-world          override start/size; cover the entire 254×254 region");
            Console.WriteLine("    --continents <n>      (default 1)");
            Console.WriteLine("    --islands <n>         (default 0)");
            Console.WriteLine("    --land-coverage <0-1> (default 0.5)");
            Console.WriteLine("    --roughness <0-1>     (default 0.5)");
            Console.WriteLine("    --towns <n>           (default 5)");
            Console.WriteLine("    --town-spacing <f>    (default 30)");
            Console.WriteLine("    --no-roads");
            Console.WriteLine("    --no-buildings");
            Console.WriteLine("    --retail-only         restrict building catalog to retail-style town models");
            Console.WriteLine("    --out <path.json>     dump the full WorldGeneratorResult plan");
            Console.WriteLine("    --apply               write changes through to project documents");
            Console.WriteLine();
            Console.WriteLine("  Example: worldgen --seed 42 --size 40 40 --towns 10 --out /tmp/plan.json");
            Console.WriteLine("           worldgen --seed 42 --size 40 40 --towns 10 --apply");
            return;
        }

        if (!TryParseWorldGenParams(tokens, out var p, out var outPath, out var apply)) return;
        var r = apply ? _engine.WorldGenApply(p, outPath) : _engine.WorldGenDryRun(p, outPath);
        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  worldgen: FAILED — {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }
        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine($"  ═══ WorldGen {(r.Applied ? "APPLIED" : "plan")} (seed={r.Seed}) ═══");
        Console.ResetColor();
        Console.WriteLine($"  Terrain         : {r.TerrainLandblocksAffected} landblocks affected, {r.TotalVerticesModified:N0} vertices");
        Console.WriteLine($"  Roads           : {r.TotalRoadVertices:N0} vertices");
        Console.WriteLine($"  Towns           : {r.TownCount}");
        Console.WriteLine($"  Buildings       : {r.TotalBuildingsPlaced:N0}");
        Console.WriteLine($"  Decorations     : {r.TotalDecorationsPlaced:N0}");
        if (r.Towns.Count > 0) {
            Console.WriteLine();
            Console.WriteLine("  Towns:");
            foreach (var t in r.Towns)
                Console.WriteLine($"    {t.SizeLabel,-9} {t.Name,-24} lb=({t.CenterLbX,3},{t.CenterLbY,3}) world=({t.CenterX,7:F1},{t.CenterY,7:F1}) r={t.Radius:F1} bldgs={t.BuildingCount}");
        }
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Plan written to : {r.OutputPath}");
        if (r.Applied)
            Console.WriteLine("  Save the project (or run 'export <dir>') to persist these changes.");
        Console.WriteLine();
    }

    private bool TryParseWorldGenParams(string[] tokens, out WorldGeneratorParams p, out string? outPath, out bool apply) {
        p = new WorldGeneratorParams();
        outPath = null;
        apply = false;
        // Default values come from the record initializers
        int seed = p.Seed;
        bool fullWorld = p.FullWorld;
        int startX = p.StartX, startY = p.StartY;
        int width = p.Width, height = p.Height;
        int continents = p.ContinentCount, islands = p.IslandCount;
        float landCov = p.LandCoverage, rough = p.Roughness;
        int townCount = p.TownCount;
        float townSpacing = p.TownSpacing;
        bool roads = p.GenerateRoads, buildings = p.GenerateBuildings;
        bool retailOnly = p.RetailTownBuildingsOnly;

        for (int i = 1; i < tokens.Length; i++) {
            switch (tokens[i]) {
                case "--seed": if (!RequireNext(tokens, i, "--seed", out var v0)) return false; if (!int.TryParse(v0, out seed)) { Console.WriteLine("Invalid --seed value."); return false; } i++; break;
                case "--start":
                    if (!RequireNext(tokens, i, "--start (x)", out var sx)) return false;
                    if (!RequireNext(tokens, i + 1, "--start (y)", out var sy)) return false;
                    if (!int.TryParse(sx, out startX) || !int.TryParse(sy, out startY)) { Console.WriteLine("Invalid --start values."); return false; }
                    i += 2; break;
                case "--size":
                    if (!RequireNext(tokens, i, "--size (w)", out var sw)) return false;
                    if (!RequireNext(tokens, i + 1, "--size (h)", out var sh)) return false;
                    if (!int.TryParse(sw, out width) || !int.TryParse(sh, out height)) { Console.WriteLine("Invalid --size values."); return false; }
                    i += 2; break;
                case "--full-world":   fullWorld = true; break;
                case "--continents":   if (!RequireNext(tokens, i, "--continents", out var cv)) return false; if (!int.TryParse(cv, out continents)) { Console.WriteLine("Invalid --continents value."); return false; } i++; break;
                case "--islands":      if (!RequireNext(tokens, i, "--islands", out var iv)) return false; if (!int.TryParse(iv, out islands)) { Console.WriteLine("Invalid --islands value."); return false; } i++; break;
                case "--land-coverage": if (!RequireNext(tokens, i, "--land-coverage", out var lc)) return false; if (!float.TryParse(lc, NumberStyles.Float, CultureInfo.InvariantCulture, out landCov)) { Console.WriteLine("Invalid --land-coverage value."); return false; } i++; break;
                case "--roughness":    if (!RequireNext(tokens, i, "--roughness", out var rg)) return false; if (!float.TryParse(rg, NumberStyles.Float, CultureInfo.InvariantCulture, out rough)) { Console.WriteLine("Invalid --roughness value."); return false; } i++; break;
                case "--towns":        if (!RequireNext(tokens, i, "--towns", out var tv)) return false; if (!int.TryParse(tv, out townCount)) { Console.WriteLine("Invalid --towns value."); return false; } i++; break;
                case "--town-spacing": if (!RequireNext(tokens, i, "--town-spacing", out var ts)) return false; if (!float.TryParse(ts, NumberStyles.Float, CultureInfo.InvariantCulture, out townSpacing)) { Console.WriteLine("Invalid --town-spacing value."); return false; } i++; break;
                case "--no-roads":     roads = false; break;
                case "--no-buildings": buildings = false; break;
                case "--retail-only":  retailOnly = true; break;
                case "--out":          if (!RequireNext(tokens, i, "--out", out var op)) return false; outPath = op; i++; break;
                case "--apply":        apply = true; break;
                default:
                    Console.WriteLine($"Unknown option: {tokens[i]}. Run 'worldgen --help' for usage.");
                    return false;
            }
        }

        p = new WorldGeneratorParams {
            Seed = seed, FullWorld = fullWorld,
            StartX = startX, StartY = startY,
            Width = width, Height = height,
            ContinentCount = continents, IslandCount = islands,
            LandCoverage = landCov, Roughness = rough,
            TownCount = townCount, TownSpacing = townSpacing,
            GenerateRoads = roads, GenerateBuildings = buildings,
            RetailTownBuildingsOnly = retailOnly
        };
        return true;
    }

    private static bool RequireNext(string[] tokens, int i, string label, out string value) {
        if (i + 1 >= tokens.Length) {
            Console.WriteLine($"Missing value for {label}.");
            value = "";
            return false;
        }
        value = tokens[i + 1];
        return true;
    }

    private void HandleWorldGenAnalyzeBuildings(string[] tokens) {
        if (!CheckProject()) return;
        string? outPath = null;
        for (int i = 1; i < tokens.Length; i++) {
            if (tokens[i] == "--out" && i + 1 < tokens.Length) { outPath = tokens[i + 1]; i++; }
            else if (tokens[i] == "--help") {
                Console.WriteLine("Usage: worldgen-analyze-buildings [--out <path.json>]");
                Console.WriteLine("  Scans DATs for 'complete' building models (used by WorldGen for town placement).");
                Console.WriteLine("  Read-only. Pass --out to dump the full profile list to JSON.");
                return;
            }
        }
        var r = _engine.WorldGenAnalyzeBuildings(outPath);
        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  worldgen-analyze-buildings: FAILED — {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }
        Console.WriteLine($"  ═══ Building catalog ═══");
        Console.WriteLine($"  Total          : {r.Total}");
        Console.WriteLine($"  With interior  : {r.WithInterior}");
        Console.WriteLine($"  Paired halves  : {r.Paired}");
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Profiles JSON  : {r.OutputPath}");
        Console.WriteLine();
    }

    private void HandleWorldGenScanRetailTowns(string[] tokens) {
        if (!CheckProject()) return;
        string? outPath = null;
        for (int i = 1; i < tokens.Length; i++) {
            if (tokens[i] == "--out" && i + 1 < tokens.Length) { outPath = tokens[i + 1]; i++; }
            else if (tokens[i] == "--help") {
                Console.WriteLine("Usage: worldgen-scan-retail-towns [--out <path.json>]");
                Console.WriteLine("  Scans DATs for retail-style town building models. Read-only.");
                return;
            }
        }
        var r = _engine.WorldGenScanRetailTowns(outPath);
        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  worldgen-scan-retail-towns: FAILED — {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }
        Console.WriteLine($"  ═══ Retail-town building stats ═══");
        Console.WriteLine($"  Distinct models : {r.ModelCount}");
        if (r.Stats.Count > 0) {
            int show = Math.Min(15, r.Stats.Count);
            Console.WriteLine($"  Top {show} by town hits:");
            foreach (var s in r.Stats.OrderByDescending(s => s.TownLandblockHits).Take(show))
                Console.WriteLine($"    {s.HexId}  hits={s.TownLandblockHits,4}  singletons={s.SingletonTownHits,4}  ratio={s.SingletonRatio:F2}  maxCopies={s.MaxCopiesInOneTownLb}");
        }
        if (!string.IsNullOrEmpty(r.OutputPath))
            Console.WriteLine($"  Stats JSON     : {r.OutputPath}");
        Console.WriteLine();
    }

    // ═══════════════════════════════════════════════════════════
    //  Weenie / ACE DB (slice 2 of f26345e port)
    // ═══════════════════════════════════════════════════════════

    private void HandleWeenieSnapshot(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: weenie-snapshot <classId>");
            Console.WriteLine("  Reads scalar weenie properties from the configured ACE DB.");
            Console.WriteLine("  Requires 'ace-db connect' first. classId may be decimal or 0x-hex.");
            Console.WriteLine("  Example: weenie-snapshot 31226");
            return;
        }
        if (!TryParseUint(tokens[1], "classId", out uint classId)) return;
        var r = _engine.WeenieSnapshotAsync(classId).GetAwaiter().GetResult();
        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  weenie-snapshot {classId}: FAILED — {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }
        Console.WriteLine($"  ═══ Weenie {r.ClassId} ═══");
        if (!string.IsNullOrEmpty(r.Name))
            Console.WriteLine($"  Name           : {r.Name}");
        Console.WriteLine($"  WeenieType     : {r.WeenieType}");
        Console.WriteLine($"  Setup DID      : 0x{r.SetupDid:X8}");
        Console.WriteLine($"  Icon DID       : 0x{r.IconDid:X8}");
        Console.WriteLine($"  Scalars        : ints={r.IntCount} int64={r.Int64Count} bool={r.BoolCount} float={r.FloatCount} str={r.StringCount} did={r.DataIdCount} iid={r.InstanceIdCount}");
        Console.WriteLine($"  Complex tables : spellbook={r.SpellBookCount} createList={r.CreateListCount} emote={r.EmoteCount} book={r.BookCount} pos={r.PositionCount} attr={r.AttributeCount} attr2nd={r.Attribute2ndCount} skill={r.SkillCount}");
        if (r.LastModified != null)
            Console.WriteLine($"  Last modified  : {r.LastModified:yyyy-MM-dd HH:mm:ss}");
        Console.WriteLine();
    }

    private void HandleWeenieTemplateList(string[] tokens) {
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: weenie-template-list <bundle.json>");
            Console.WriteLine("  Parses a JSON bundle (single object or array) of weenie templates.");
            Console.WriteLine("  Example: weenie-template-list ./templates/weapons.json");
            return;
        }
        var r = _engine.WeenieTemplateList(tokens[1]);
        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  weenie-template-list: FAILED — {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }
        Console.WriteLine($"  ═══ {r.TemplateCount} template(s) in {r.BundlePath} ═══");
        foreach (var t in r.Templates) {
            int scalars = t.IntCount + t.Int64Count + t.BoolCount + t.FloatCount + t.StringCount + t.DataIdCount + t.InstanceIdCount;
            Console.WriteLine($"  {t.Id,-30} type={t.WeenieType,-3} scalars={scalars,3}  {t.Title}");
            if (!string.IsNullOrEmpty(t.Description))
                Console.WriteLine($"    {t.Description}");
        }
        Console.WriteLine();
    }

    private void HandleWeenieTemplateApply(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 4) {
            Console.WriteLine("Usage: weenie-template-apply <bundle.json> <templateId> <classId>");
            Console.WriteLine("  Applies a template's scalar properties to a weenie via ACE DB.");
            Console.WriteLine("  Requires 'ace-db connect' first. Existing scalars NOT in the template are left untouched.");
            Console.WriteLine("  Example: weenie-template-apply ./templates/weapons.json basic_sword 31226");
            return;
        }
        if (!TryParseUint(tokens[3], "classId", out uint classId)) return;
        var r = _engine.WeenieTemplateApplyAsync(tokens[1], tokens[2], classId).GetAwaiter().GetResult();
        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  weenie-template-apply: FAILED — {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }
        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine($"  weenie-template-apply: OK — applied template '{r.TemplateId}' ({r.ScalarsApplied} scalars) to weenie {r.ClassId}");
        Console.ResetColor();
        Console.WriteLine();
    }

    private void HandleBspBuild(string[] tokens) {
        if (!CheckProject()) return;
        if (tokens.Length < 2) {
            Console.WriteLine("Usage: bsp-build <gfxObjId>");
            Console.WriteLine("  Rebuilds Physics+Drawing BSP trees on a GfxObj (0x01xxxxxx).");
            Console.WriteLine("  Reads project portal override if present, else DAT-resident GfxObj. Result is staged in PortalDatDocument.");
            Console.WriteLine("  Example: bsp-build 0x01FF0001");
            return;
        }
        if (!TryParseHex(tokens[1], "gfxObjId", out uint gfxObjId)) return;
        var r = _engine.BspBuild(gfxObjId);
        Console.WriteLine();
        if (!r.Found) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  bsp-build {r.HexId}: NOT FOUND — {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }
        if (!r.Built) {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"  bsp-build {r.HexId}: build failed — {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }
        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine($"  bsp-build {r.HexId}: OK ({r.PolygonCount} polygons)");
        Console.ResetColor();
        Console.WriteLine();
    }

    // ═══════════════════════════════════════════════════════════
    //  compare-to-retail
    // ═══════════════════════════════════════════════════════════

    private void HandleCompareCreaturesToRetail() {
        var r = _engine.CompareCreaturesToRetail();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"compare-creatures-to-retail: FAILED — {r.Error}");
            Console.ResetColor();
            return;
        }
        static void PrintDim(string label, CompareCategoryDimension d) {
            Console.WriteLine($"  {label,-10} generated={d.GeneratedCount,5}  retail={d.RetailCount,5}  jaccard={d.Jaccard:F3}");
            if (d.NovelInLb.Count > 0)
                Console.WriteLine($"             novel: {string.Join(",", d.NovelInLb.Take(8))}{(d.NovelInLb.Count > 8 ? "…" : "")}");
            if (d.MissingInLb.Count > 0)
                Console.WriteLine($"             missing: {string.Join(",", d.MissingInLb.Take(8))}{(d.MissingInLb.Count > 8 ? "…" : "")}");
        }
        PrintDim("creatures", r.Creatures);
        PrintDim("npcs", r.Npcs);
        PrintDim("housing", r.Housing);
    }

    private void HandleCompareToRetail(string[] tokens) {
        if (tokens.Length < 2 || tokens[1] == "--help") {
            Console.WriteLine("Usage: compare-to-retail <generated.jsonl> [options]");
            Console.WriteLine("  Scores a generated world against retail by subprocessing");
            Console.WriteLine("  scripts/PopulationPipeline/Validation/compare_world_to_retail.py.");
            Console.WriteLine("  The 'region' is auto-derived from lb_x/lb_y in <generated.jsonl>;");
            Console.WriteLine("  retail is filtered to that landblock set before scoring.");
            Console.WriteLine();
            Console.WriteLine("  Options:");
            Console.WriteLine("    --retail-baseline <path>   override default retail JSONL");
            Console.WriteLine("    --top-k <N>                rows per anomaly table (default 30)");
            Console.WriteLine("    --anomaly-min-model <N>    threshold for over/under tables (default 20)");
            Console.WriteLine("    --no-per-lb                skip the per-landblock breakdown");
            Console.WriteLine("    --cache-dir <path>         retail snapshot cache (default: $TMP/wb_compare_cache)");
            Console.WriteLine();
            Console.WriteLine("  Env: WORLDBUILDER_COMPARATOR_PY overrides script path.");
            Console.WriteLine("       WORLDBUILDER_PYTHON       overrides python interpreter.");
            return;
        }

        string generated = tokens[1];
        string? retailBaseline = null;
        string? cacheDir = null;
        int topK = 30;
        int anomalyMin = 20;
        bool perLb = true;

        for (int i = 2; i < tokens.Length; i++) {
            switch (tokens[i]) {
                case "--retail-baseline":
                    if (i + 1 >= tokens.Length) { Console.WriteLine("Missing path after --retail-baseline"); return; }
                    retailBaseline = tokens[++i]; break;
                case "--cache-dir":
                    if (i + 1 >= tokens.Length) { Console.WriteLine("Missing path after --cache-dir"); return; }
                    cacheDir = tokens[++i]; break;
                case "--top-k":
                    if (i + 1 >= tokens.Length || !int.TryParse(tokens[i + 1], out topK)) {
                        Console.WriteLine("--top-k expects an integer"); return;
                    }
                    i++; break;
                case "--anomaly-min-model":
                    if (i + 1 >= tokens.Length || !int.TryParse(tokens[i + 1], out anomalyMin)) {
                        Console.WriteLine("--anomaly-min-model expects an integer"); return;
                    }
                    i++; break;
                case "--no-per-lb":
                    perLb = false; break;
                default:
                    Console.WriteLine($"Unknown flag: {tokens[i]}"); return;
            }
        }

        var r = _engine.CompareToRetail(generated, retailBaseline, topK, anomalyMin, perLb, cacheDir);
        Console.WriteLine();
        if (!r.Success) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  compare-to-retail: FAILED — {r.Error}");
            Console.ResetColor();
            Console.WriteLine();
            return;
        }

        Console.WriteLine($"  ═══ compare-to-retail ({r.ElapsedSeconds:F2}s, cache {(r.RetailCacheHit ? "HIT" : "miss")}) ═══");
        Console.WriteLine($"  Generated  : {r.Generated}");
        Console.WriteLine($"  Retail     : {r.Retail}");
        if (r.Region != null) {
            Console.WriteLine($"  Region     : {r.Region.NLandblocks} LBs  "
                + $"x∈[{r.Region.XMin},{r.Region.XMax}]  y∈[{r.Region.YMin},{r.Region.YMax}]");
        }
        Console.WriteLine($"  Volumes    : model={r.GeneratedCount:N0}  retail={r.RetailCount:N0}  "
            + $"density Δ={r.DensityDeltaPct:+0.0;-0.0;0.0}%");
        if (r.ModelDensity != null && r.RetailDensity != null) {
            Console.WriteLine($"  Density/LB : model mean={r.ModelDensity.Mean:F2} p50={r.ModelDensity.P50} p95={r.ModelDensity.P95}");
            Console.WriteLine($"               retail mean={r.RetailDensity.Mean:F2} p50={r.RetailDensity.P50} p95={r.RetailDensity.P95}");
        }
        if (r.Coverage != null) {
            Console.WriteLine($"  Coverage   : model={r.Coverage.ModelUnique} unique  retail={r.Coverage.RetailUnique} unique  "
                + $"both={r.Coverage.Both}  novel={r.Coverage.Novel}  missing={r.Coverage.Missing}");
        }
        if (r.SurfaceInterior != null) {
            Console.WriteLine($"  Surface/Int: model {r.SurfaceInterior.ModelSurfacePct:F1}/{r.SurfaceInterior.ModelInteriorPct:F1}%  "
                + $"retail {r.SurfaceInterior.RetailSurfacePct:F1}/{r.SurfaceInterior.RetailInteriorPct:F1}%");
        }
        if (r.LbJaccard != null && r.LbJaccard.Mean.HasValue) {
            Console.WriteLine($"  LB Jaccard : n={r.LbJaccard.N}  mean={r.LbJaccard.Mean:F4}  p50={r.LbJaccard.P50:F4}  p10={r.LbJaccard.P10:F4}");
        }
        if (r.Anomalies != null) {
            Console.WriteLine($"  Out-of-ctx : {100 * r.Anomalies.Frac:F1}% of LB-wcid pairs are novel "
                + $"({r.Anomalies.NovelUnique}/{r.Anomalies.EmittedUnique})");
        }
        if (r.ClassSpace != null) {
            var spaces = string.Join("  ", r.ClassSpace.Retail
                .OrderByDescending(kv => kv.Value)
                .Select(kv => $"{kv.Key}={kv.Value:N0}"));
            Console.WriteLine($"  ClassSpace : retail {spaces}");
            Console.Write($"               model emits wcid only; coverage(wcid)=");
            Console.Write(r.ClassSpace.CoverageOfRetailWcid.HasValue
                ? $"{r.ClassSpace.CoverageOfRetailWcid:F4}" : "n/a");
            Console.WriteLine($"  coverage(all)={r.ClassSpace.CoverageOfRetailAll:F4}");
        }
        if (r.Wcids != null) {
            int over = r.Wcids.Over.Count, under = r.Wcids.Under.Count,
                novel = r.Wcids.Novel.Count, missing = r.Wcids.Missing.Count;
            Console.WriteLine($"  Wcid bands : over={over} under={under} novel={novel} missing={missing}");
            if (over > 0) {
                Console.WriteLine($"    top over-rep:");
                foreach (var w in r.Wcids.Over.Take(5))
                    Console.WriteLine($"      wcid={w.Wcid,-7} model={w.ModelCount,-6} retail={w.RetailCount,-6} ratio={w.Ratio:F2}");
            }
            if (under > 0) {
                Console.WriteLine($"    top under-rep:");
                foreach (var w in r.Wcids.Under.Take(5))
                    Console.WriteLine($"      wcid={w.Wcid,-7} model={w.ModelCount,-6} retail={w.RetailCount,-6} ratio={w.Ratio:F2}");
            }
        }
        if (r.PerLandblock != null && r.PerLandblock.Count > 0) {
            Console.WriteLine($"  Per-LB rows: {r.PerLandblock.Count} (top 5 by |density delta|):");
            foreach (var lb in r.PerLandblock.Take(5)) {
                // Composite-format `+N` is alignment-only (no forced sign).
                // Use the conditional form to actually render Δ as ±.
                Console.WriteLine($"      ({lb.LbX,3},{lb.LbY,3})  Δ={lb.DensityDelta:+0;-0;0}  "
                    + $"model={lb.ModelCount,-4} retail={lb.RetailCount,-4} "
                    + $"jaccard={(lb.WcidJaccard?.ToString("F3") ?? "n/a"),-6} "
                    + $"novel={lb.NovelInLb}");
            }
        }
        if (!string.IsNullOrEmpty(r.OutJsonPath)) {
            Console.WriteLine($"  JSON       : {r.OutJsonPath}");
        }
        Console.WriteLine();
    }

    // ════════════════════════════════════════════════════
    //  transact — batched stage / validate / commit-or-rollback.
    //  REPL form takes a JSON file path; the file holds the same
    //  payload as the JSON-agent `{ "command": "transact", ops: [...] }`.
    // ════════════════════════════════════════════════════

    private void HandleTransact(string[] tokens) {
        if (tokens.Length < 2 || tokens[1] == "--help") {
            Console.WriteLine("Usage: transact <path-to-ops.json>");
            Console.WriteLine("  The file may be either a top-level array of ops, or a full payload");
            Console.WriteLine("  object: { \"ops\": [...], \"rollback_on_fail\": true, \"validate\": \"auto\" }.");
            Console.WriteLine("  Each op has the same shape as a normal JSON-agent command:");
            Console.WriteLine("    { \"command\": \"bulk-place-objects\", \"lbX\": 169, \"lbY\": 180, \"objects\": [...] }");
            Console.WriteLine();
            Console.WriteLine("  Validation modes: \"auto\" (default), \"all\", \"none\", or { \"landblocks\": [...] }.");
            return;
        }
        var path = tokens[1];
        if (!File.Exists(path)) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"File not found: {path}");
            Console.ResetColor();
            return;
        }

        string json;
        try {
            json = File.ReadAllText(path);
        } catch (Exception ex) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Failed to read {path}: {ex.Message}");
            Console.ResetColor();
            return;
        }

        // Normalize: a top-level array is shorthand for { "ops": [...] }.
        // Either way, prepend `command: "transact"` so the JSON dispatcher routes here.
        System.Text.Json.Nodes.JsonNode? parsed;
        try {
            parsed = System.Text.Json.Nodes.JsonNode.Parse(json);
        } catch (Exception ex) {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Invalid JSON in {path}: {ex.Message}");
            Console.ResetColor();
            return;
        }

        System.Text.Json.Nodes.JsonObject payload;
        if (parsed is System.Text.Json.Nodes.JsonArray arr) {
            payload = new System.Text.Json.Nodes.JsonObject {
                ["command"] = "transact",
                ["ops"] = arr.DeepClone(),
            };
        } else if (parsed is System.Text.Json.Nodes.JsonObject obj) {
            payload = (System.Text.Json.Nodes.JsonObject)obj.DeepClone();
            payload["command"] = "transact";
        } else {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine("Top-level JSON must be an object or array.");
            Console.ResetColor();
            return;
        }

        var response = _jsonProcessor.ProcessCommand(payload.ToJsonString());
        Console.WriteLine(response);
    }

    // ════════════════════════════════════════════════════
    //  transact-diff — structured before/after report.
    //  Composes against the JSON dispatcher so the wire format and the
    //  REPL share one implementation; only the argument parsing differs.
    // ════════════════════════════════════════════════════

    private void HandleTransactDiff(string[] tokens) {
        if (tokens.Length < 2 || tokens[1] == "--help") {
            Console.WriteLine("Usage: transact-diff <txId> [--render] [--mode overlay|side-by-side|after-only-with-diff] [--lb X,Y]... [--res N] [--out path]");
            Console.WriteLine("  --render            Also produce a visual diff PNG.");
            Console.WriteLine("  --mode <m>          overlay (default), side-by-side, or after-only-with-diff.");
            Console.WriteLine("  --lb X,Y            Restrict the diff to a specific landblock; repeatable.");
            Console.WriteLine("  --res N             Render resolution in pixels (default 1024).");
            Console.WriteLine("  --out <path>        Write the visual PNG to disk instead of returning base64.");
            return;
        }

        string txIdRaw = tokens[1];
        bool render = false;
        string mode = "overlay";
        int resolution = 1024;
        string? outPath = null;
        var lbs = new System.Text.Json.Nodes.JsonArray();

        for (int i = 2; i < tokens.Length; i++) {
            var t = tokens[i];
            if (t.Equals("--render", StringComparison.OrdinalIgnoreCase)) { render = true; continue; }
            if (t.Equals("--mode", StringComparison.OrdinalIgnoreCase) && i + 1 < tokens.Length) {
                mode = tokens[++i].ToLowerInvariant(); continue;
            }
            if (t.Equals("--lb", StringComparison.OrdinalIgnoreCase) && i + 1 < tokens.Length) {
                var raw = tokens[++i];
                var pair = raw.Split(',');
                if (pair.Length != 2 || !uint.TryParse(pair[0], out var lbX) || !uint.TryParse(pair[1], out var lbY)) {
                    Console.ForegroundColor = ConsoleColor.Red;
                    Console.WriteLine($"Invalid --lb value '{raw}' — expected 'X,Y'.");
                    Console.ResetColor();
                    return;
                }
                // LB coords are 0..255 inclusive. Catching it here is friendlier
                // than letting the JSON layer silently drop the entry.
                if (lbX > 0xFF || lbY > 0xFF) {
                    Console.ForegroundColor = ConsoleColor.Red;
                    Console.WriteLine($"--lb value '{raw}' out of range — landblock coords are 0..255.");
                    Console.ResetColor();
                    return;
                }
                lbs.Add(new System.Text.Json.Nodes.JsonArray((int)lbX, (int)lbY));
                continue;
            }
            if (t.Equals("--res", StringComparison.OrdinalIgnoreCase) && i + 1 < tokens.Length) {
                if (int.TryParse(tokens[++i], out var n) && n >= 64 && n <= 8192) resolution = n;
                continue;
            }
            if (t.Equals("--out", StringComparison.OrdinalIgnoreCase) && i + 1 < tokens.Length) {
                outPath = tokens[++i]; continue;
            }
        }

        var payload = new System.Text.Json.Nodes.JsonObject {
            ["command"] = "transact-diff",
            ["txId"] = txIdRaw,
            ["render"] = render,
            ["renderMode"] = mode,
            ["resolution"] = resolution,
        };
        if (lbs.Count > 0) payload["lbs"] = lbs;
        if (outPath != null) payload["out"] = outPath;

        var response = _jsonProcessor.ProcessCommand(payload.ToJsonString());
        Console.WriteLine(response);
    }
}
