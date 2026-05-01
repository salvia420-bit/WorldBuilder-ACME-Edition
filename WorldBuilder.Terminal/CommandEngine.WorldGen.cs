using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text.Json;
using System.Threading.Tasks;
using DatReaderWriter.DBObjs;
using WorldBuilder.Shared.Documents;
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

        project.DocumentManager.SkipDatStatics = true;
        await project.DocumentManager.ResetWorldDocumentsAsync();
        project.DocumentManager.SkipDatStatics = false;

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
            project.DocumentManager.SkipDatStatics = true;
            await project.DocumentManager.ResetWorldDocumentsAsync();
            ApplyWorldGenResult(result);
            project.DocumentManager.SkipDatStatics = false;
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
            TownsCsvPath: csvRows > 0 ? exportTownsCsvPath : null,
            TownsCsvRows: csvRows,
            TownSummaries: BuildTownSummaries(result));
    }

    public ExportTownsCsvResult ExportTownsCsv(string fromResultJson, string outPath) {
        if (string.IsNullOrEmpty(fromResultJson) || !File.Exists(fromResultJson))
            throw new FileNotFoundException("--from-result <path> JSON file not found.", fromResultJson);

        // The JSON written by `worldgen --output` has towns + buildingPlacements; rebuild
        // the minimal WorldGeneratorResult shape TownsExporter needs.
        var json = JsonDocument.Parse(File.ReadAllText(fromResultJson));
        var towns = json.RootElement.TryGetProperty("towns", out var townsEl)
            ? JsonSerializer.Deserialize<List<TownSite>>(townsEl.GetRawText(),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new()
            : new List<TownSite>();

        var placements = new Dictionary<ushort, List<PlannedBuilding>>();
        if (json.RootElement.TryGetProperty("plannedBuildings", out var pbEl)) {
            foreach (var prop in pbEl.EnumerateObject()) {
                ushort lbKey = ushort.Parse(prop.Name[2..], System.Globalization.NumberStyles.HexNumber);
                var list = JsonSerializer.Deserialize<List<PlannedBuilding>>(prop.Value.GetRawText(),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
                placements[lbKey] = list;
            }
        }

        var stub = new WorldGeneratorResult();
        stub.Towns.AddRange(towns);
        foreach (var kv in placements) stub.BuildingPlacements[kv.Key] = kv.Value;

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath)) ?? ".");
        var rows = TownsExporter.Write(stub, outPath);
        return new ExportTownsCsvResult(true, outPath, rows);
    }
}
