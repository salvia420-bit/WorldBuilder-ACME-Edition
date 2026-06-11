using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text.Json;
using System.Threading.Tasks;
using DatReaderWriter.DBObjs;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.WorldGen;

namespace WorldBuilder.Terminal;

public partial class CommandEngine {
    // ─────────────────────────────────────────────────────────────────
    //  O8: FreshStart + GenerateWorld + Towns CSV (parity with GUI)
    // ─────────────────────────────────────────────────────────────────

    private const byte WATER_DEEP_SEA = 0x14;
    private const int FRESH_START_MAP_SIZE = 255;
    private const int FRESH_START_LB_VERTS = 81;

    public async Task<FreshStartResult> FreshStartAsync() {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        var doc = GetTerrainDoc();

        var waterEntry = new TerrainEntry(road: 0, scenery: 0, type: WATER_DEEP_SEA, height: 0).ToUInt();

        var allChanges = new Dictionary<ushort, Dictionary<byte, uint>>();
        for (int x = 0; x <= FRESH_START_MAP_SIZE - 1; x++) {
            for (int y = 0; y <= FRESH_START_MAP_SIZE - 1; y++) {
                var lbKey = (ushort)((x << 8) | y);
                var existing = doc.GetLandblockInternal(lbKey);
                if (existing == null) continue;

                var changes = new Dictionary<byte, uint>();
                for (byte i = 0; i < FRESH_START_LB_VERTS; i++) {
                    if (existing[i].ToUInt() != waterEntry) {
                        changes[i] = waterEntry;
                    }
                }
                if (changes.Count > 0) allChanges[lbKey] = changes;
            }
        }

        doc.ApplyBulkImport(allChanges);

        try {
            project.DocumentManager.SkipDatStatics = true;
            await project.DocumentManager.ResetWorldDocumentsAsync();
        } finally {
            project.DocumentManager.SkipDatStatics = false;
        }

        return new FreshStartResult(true, allChanges.Count,
            allChanges.Values.Sum(v => v.Count));
    }

    /// <summary>
    /// Mirrors the GUI's GenerateWorld flow: ResetWorldDocs → bulk-import terrain →
    /// place buildings → place decorations → optionally export towns CSV.
    /// </summary>
    public async Task<GenerateWorldResult> GenerateWorldAsync(
        WorldGeneratorParams p, bool apply, string? exportTownsCsvPath) {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        var dats = project.DocumentManager.Dats;

        if (!dats.TryGet<Region>(0x13000000, out var region) || region == null)
            throw new InvalidOperationException("Failed to load Region 0x13000000 from DATs.");

        var result = WorldGenerator.Generate(p, dats, region);
        if (result == null)
            throw new InvalidOperationException("WorldGenerator.Generate returned null.");

        bool applied = false;
        if (apply) {
            try {
                project.DocumentManager.SkipDatStatics = true;
                await project.DocumentManager.ResetWorldDocumentsAsync();
                ApplyWorldGenResult(result);
            } finally {
                project.DocumentManager.SkipDatStatics = false;
            }
            applied = true;
        }

        int csvRows = 0;
        if (!string.IsNullOrEmpty(exportTownsCsvPath)) {
            var dir = Path.GetDirectoryName(exportTownsCsvPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            csvRows = TownsExporter.Write(result, exportTownsCsvPath);
        }

        return new GenerateWorldResult(
            Success: true,
            Seed: p.Seed,
            Applied: applied,
            LandblocksAffected: result.TerrainChanges.Count,
            VerticesModified: result.TotalVerticesModified,
            Towns: result.Towns.Count,
            BuildingsPlaced: result.TotalBuildingsPlaced,
            DecorationsPlaced: result.TotalDecorationsPlaced,
            RoadVertices: result.TotalRoadVertices,
            TownsCsvPath: !string.IsNullOrEmpty(exportTownsCsvPath) ? exportTownsCsvPath : null,
            TownsCsvRows: csvRows,
            TownSummaries: BuildTownSummaries(result));
    }

    public ExportTownsCsvResult ExportTownsCsv(string fromResultJson, string outPath) {
        if (string.IsNullOrEmpty(fromResultJson) || !File.Exists(fromResultJson))
            throw new FileNotFoundException(
                $"Worldgen result JSON not found: '{fromResultJson}'. Run 'worldgen-analyze-buildings' (or 'worldgen' with outputPath) first, then pass its outputPath as 'fromResult'.",
                fromResultJson);

        // The JSON written by `worldgen --output` has towns + buildingPlacements; rebuild
        // the minimal WorldGeneratorResult shape TownsExporter needs.
        // MUST use JsonOpts.WorldGenResult (IncludeFields=true) — the SAME options the producer
        // serialized with — or Vector3/Quaternion fields (WorldCenter/WorldPosition) deserialize
        // to (0,0,0) and every CSV anchor becomes garbage.
        var json = JsonDocument.Parse(File.ReadAllText(fromResultJson));
        var towns = json.RootElement.TryGetProperty("towns", out var townsEl)
            ? JsonSerializer.Deserialize<List<TownSite>>(townsEl.GetRawText(),
                JsonOpts.WorldGenResult) ?? new()
            : new List<TownSite>();

        var placements = new Dictionary<ushort, List<PlannedBuilding>>();
        if (json.RootElement.TryGetProperty("plannedBuildings", out var pbEl)) {
            foreach (var prop in pbEl.EnumerateObject()) {
                ushort lbKey = ushort.Parse(prop.Name[2..], System.Globalization.NumberStyles.HexNumber);
                var list = JsonSerializer.Deserialize<List<PlannedBuilding>>(prop.Value.GetRawText(),
                    JsonOpts.WorldGenResult) ?? new();
                placements[lbKey] = list;
            }
        }

        var stub = new WorldGeneratorResult();
        stub.Towns.AddRange(towns);
        foreach (var kv in placements) stub.BuildingPlacements[kv.Key] = kv.Value;

        // Guard against the classic "Vector3 serialized as {}" corruption: if towns exist but
        // every resolved anchor is exactly (0,0,0), the result JSON carried no positions — almost
        // always because it was produced by a build that wrote positions without IncludeFields.
        // Emitting a CSV of identical garbage rows + success:true is worse than failing loudly.
        if (stub.Towns.Count > 0) {
            bool anyNonZeroAnchor = false;
            foreach (var t in stub.Towns) {
                var anchor = TownsExporter.GetTownTelelocAnchor(t, stub.BuildingPlacements);
                if (anchor != Vector3.Zero) { anyNonZeroAnchor = true; break; }
            }
            if (!anyNonZeroAnchor)
                throw new InvalidOperationException(
                    "result JSON carries no positions — re-export with a current build " +
                    $"('{fromResultJson}' has {stub.Towns.Count} town(s) but every anchor is (0,0,0)).");
        }

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath)) ?? ".");
        var rows = TownsExporter.Write(stub, outPath);
        return new ExportTownsCsvResult(true, outPath, rows);
    }
}
