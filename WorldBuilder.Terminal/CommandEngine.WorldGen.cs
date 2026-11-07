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
using WorldBuilder.Shared.Lib.Noise;
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

    /// <summary>
    /// Synthesizes and manipulates the 2041x2041 Dericost continent heightmap, terrain types, and tree density grids
    /// using WorldBuilder.Shared.Lib.Noise.SimplexNoise (FBm + RidgedNoise + Domain Warping), TerrainAlgorithms-style
    /// Gaussian landform smoothing, town hillside/amphitheater sculpting, and slope-based cliff rock auto-painting.
    /// </summary>
    public GenerateDericostTerrainResult GenerateDericostTerrain(string outputDir) {
        if (string.IsNullOrWhiteSpace(outputDir))
            throw new ArgumentException("outputDir is required.", nameof(outputDir));

        const int gridSize = 255;
        const int dim = gridSize * 8 + 1; // 2041
        const int totalVerts = dim * dim; // 4,165,681
        const float cellSize = 24.0f;
        const float worldMeters = gridSize * 192.0f; // 48,960m
        const float dericostYMin = 68928.0f;
        const float dericostYMax = 117888.0f;

        float[] landHeightTable = {
            0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38,
            40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78,
            80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110, 112, 114, 116, 118,
            120, 122, 124, 126, 128, 130, 132, 134, 136, 138, 140, 142, 144, 146, 148, 150, 152, 154, 156, 158,
            160, 162, 164, 166, 168, 170, 172, 174, 176, 178, 180, 182, 184, 186, 188, 190, 192, 194, 196, 198,
            200, 202, 204, 206, 208, 210, 212, 214, 216, 218, 220, 222, 224, 226, 228, 230, 232, 234, 236, 238,
            240, 242, 244, 246, 248, 250, 252, 254, 256, 258, 260, 262, 264, 266, 268, 270, 272, 274, 276, 278,
            280, 282, 284, 286, 288, 290, 292, 294, 296, 298, 300, 302, 304, 306, 308, 310, 312, 314, 316, 318,
            320, 322, 324, 326, 328, 330, 332, 334, 336, 338, 340, 342, 344, 346, 348, 350, 352, 354, 356, 358,
            360, 362, 364, 366, 368, 370, 372, 374, 376, 378, 380, 382, 384, 386, 388, 390, 392, 394, 396, 398,
            400, 404, 408, 412, 416, 420, 424, 428, 432, 436, 440, 444, 448, 452, 456, 460, 464, 468, 472, 476,
            480, 484, 488, 492, 496, 500, 504, 508, 512, 516, 520, 524, 528, 532, 536, 540, 544, 548, 552, 556,
            560, 568, 576, 584, 592, 600, 608, 616, 624, 632, 640, 650, 660, 670, 680, 700
        };

        var sMain = new SimplexNoise(4242);
        var sRidge = new SimplexNoise(7777);
        var sWarp = new SimplexNoise(9001);
        var sDune = new SimplexNoise(1337);

        static float SmoothStep(float e0, float e1, float x) {
            float t = Math.Clamp((x - e0) / (e1 - e0), 0f, 1f);
            return t * t * (3f - 2f * t);
        }

        byte FindHeightIdx(float h) {
            if (h <= 0f) return 0;
            int low = 0, high = 255;
            while (low <= high) {
                int mid = (low + high) >> 1;
                float v = landHeightTable[mid];
                if (MathF.Abs(v - h) < 1e-4f) return (byte)mid;
                if (v < h) low = mid + 1;
                else high = mid - 1;
            }
            int idx = Math.Clamp(low, 0, 255);
            int prev = Math.Max(0, idx - 1);
            return MathF.Abs(landHeightTable[idx] - h) < MathF.Abs(landHeightTable[prev] - h) ? (byte)idx : (byte)prev;
        }

        float EvalElevation(float x, float yLocal) {
            float u = x / worldMeters;
            float v = yLocal / worldMeters;
            float yGlobal = dericostYMin + yLocal;
            float dx = (u - 0.50f) / 0.45f;
            float dy = (v - 0.52f) / 0.47f;
            float dist = MathF.Sqrt(dx * dx + dy * dy);
            float coastNoise = sMain.FBm(u * 3.2f, v * 3.2f, 3) * 0.20f + sDune.Evaluate(u * 7.5f, v * 7.5f) * 0.08f;
            float islandDist = dist + coastNoise;
            if (islandDist > 1.05f) return 0f;
            float landMask = Math.Clamp((1.05f - islandDist) / 0.16f, 0f, 1f);
            if (landMask <= 0f) return 0f;

            float wxMacro = x + sWarp.FBm(x / 2400f, yLocal / 2400f, 3) * 320f;
            float wyMacro = yLocal + sWarp.FBm((x + 9000f) / 2400f, (yLocal + 9000f) / 2400f, 3) * 320f;
            float wx = x + sWarp.FBm(x / 720f, yLocal / 720f, 3) * 110f;
            float wy = yLocal + sWarp.FBm((x + 3700f) / 720f, (yLocal + 3700f) / 720f, 3) * 110f;

            float rawH;
            if (yGlobal >= 102000f) {
                float gelidT = Math.Clamp((yGlobal - 102000f) / (dericostYMax - 102000f), 0f, 1f);
                rawH = 355f + gelidT * 90f
                     + sRidge.RidgedNoise(wxMacro / 2200f, wyMacro / 2200f, 4, 2.0f, 0.5f) * 145f
                     + sRidge.RidgedNoise(wx / 680f, wy / 680f, 3, 2.0f, 0.48f) * 95f
                     + (sMain.FBm(wx / 460f, wy / 460f, 3, 2.0f, 0.48f) + 0.35f) * 58f;
            } else if (yGlobal >= 88000f) {
                if (x < 22000f) {
                    rawH = 52f + Math.Max(0f, 1f - u / 0.45f) * 38f
                         + sRidge.RidgedNoise(wxMacro / 1500f, wyMacro / 1500f, 4, 2.0f, 0.5f) * 85f
                         + sRidge.RidgedNoise(wx / 560f, wy / 560f, 3, 2.0f, 0.48f) * 72f;
                } else {
                    rawH = 95f + MathF.Abs(u - 0.70f) * 70f
                         + sRidge.RidgedNoise(wxMacro / 1450f, wyMacro / 1450f, 4, 2.0f, 0.5f) * 105f
                         + sRidge.RidgedNoise(wx / 520f, wy / 520f, 3, 2.0f, 0.48f) * 82f;
                }
            } else if (yGlobal >= 76000f) {
                if (x < 24000f) {
                    float marshT = Math.Clamp((yGlobal - 76000f) / 12000f, 0f, 1f);
                    rawH = 16f + marshT * 24f
                         + sRidge.RidgedNoise(wx / 620f, wy / 620f, 3, 2.0f, 0.48f) * 52f
                         + (sMain.FBm(wx / 380f, wy / 380f, 3, 2.0f, 0.45f) + 0.45f) * 38f;
                } else {
                    float windPhase = (wx * 0.82f + wy * 0.57f) / 42f + sDune.FBm(wx / 520f, wy / 520f, 3) * 1.65f;
                    float skewed = MathF.Sin(windPhase + 0.65f * MathF.Sin(windPhase));
                    float ergDunes = MathF.Pow((skewed + 1f) * 0.5f, 1.55f) * 62f;
                    float barchan = sRidge.RidgedNoise(wx / 460f, wy / 460f, 3, 2.0f, 0.48f) * 56f;
                    float mesaRaw = (sMain.FBm(wxMacro / 1450f, wyMacro / 1450f, 3, 2.0f, 0.5f) + 1f) * 0.5f;
                    float mScaled = mesaRaw * 3.4f;
                    float mFloor = MathF.Floor(mScaled);
                    float mesas = (mFloor + SmoothStep(0.26f, 0.60f, mScaled - mFloor)) * 42f;
                    rawH = 135f + Math.Max(0f, u - 0.48f) * 85f + mesas + ergDunes + barchan;
                }
            } else {
                float coastT = Math.Clamp((yGlobal - dericostYMin) / 7072f, 0f, 1f);
                rawH = 16f + coastT * 36f
                     + sRidge.RidgedNoise(wx / 540f, wy / 540f, 3, 2.0f, 0.48f) * 64f
                     + (sMain.FBm(x / 360f, yLocal / 360f, 3, 2.0f, 0.45f) + 0.4f) * 42f;
            }

            float finalH = rawH * MathF.Pow(landMask, 0.55f);
            return finalH < 0.5f ? 0f : Math.Clamp(finalH, 0f, 700f);
        }

        var floatH = new float[totalVerts];
        var smoothedH = new float[totalVerts];
        var hIdx = new byte[totalVerts];
        var types = new byte[totalVerts];

        for (int gy = 0; gy < dim; gy++) {
            float yLocal = gy * cellSize;
            int row = gy * dim;
            for (int gx = 0; gx < dim; gx++) {
                floatH[row + gx] = EvalElevation(gx * cellSize, yLocal);
            }
        }

        for (int gy = 0; gy < dim; gy++) {
            int row = gy * dim;
            for (int gx = 0; gx < dim; gx++) {
                int i = row + gx;
                float c = floatH[i];
                if (c <= 0f || gx == 0 || gx == dim - 1 || gy == 0 || gy == dim - 1) {
                    smoothedH[i] = c;
                    continue;
                }
                float nAvg = (floatH[i - 1] + floatH[i + 1] + floatH[i - dim] + floatH[i + dim]
                    + 0.5f * (floatH[i - dim - 1] + floatH[i - dim + 1] + floatH[i + dim - 1] + floatH[i + dim + 1])) / 6.0f;
                smoothedH[i] = Math.Max(0.5f, c * 0.65f + nAvg * 0.35f);
            }
        }

        int dryCount = 0;
        double minH = 9999.0, maxH = 0.0;
        for (int i = 0; i < totalVerts; i++) {
            byte idx = FindHeightIdx(Math.Clamp(smoothedH[i], 0f, 700f));
            hIdx[i] = idx;
            float qz = landHeightTable[idx];
            if (qz > 0f) {
                dryCount++;
                if (qz < minH) minH = qz;
                if (qz > maxH) maxH = qz;
            }
            types[i] = qz <= 0f ? (byte)(20 | 0x80) : (byte)10;
        }

        int dryLbs = 0, cellCount = 0;
        double sumLbRelief = 0, sumCellDelta = 0;
        for (int lby = 0; lby < gridSize; lby++) {
            for (int lbx = 0; lbx < gridSize; lbx++) {
                float lbMin = 9999f, lbMax = -9999f;
                int dry = 0;
                for (int vy = 0; vy < 9; vy++) {
                    for (int vx = 0; vx < 9; vx++) {
                        int idx = (lby * 8 + vy) * dim + (lbx * 8 + vx);
                        float z = landHeightTable[hIdx[idx]];
                        if (z > 0f) dry++;
                        if (z < lbMin) lbMin = z;
                        if (z > lbMax) lbMax = z;
                        if (vx < 8 && z > 0f) {
                            sumCellDelta += MathF.Abs(landHeightTable[hIdx[idx + 1]] - z);
                            cellCount++;
                        }
                    }
                }
                if (dry > 40) {
                    dryLbs++;
                    sumLbRelief += (lbMax - lbMin);
                }
            }
        }

        Directory.CreateDirectory(outputDir);
        File.WriteAllBytes(Path.Combine(outputDir, "dericost_height.u8"), hIdx);
        File.WriteAllBytes(Path.Combine(outputDir, "dericost_types.u8"), types);

        double dryLandAreaKm2 = (dryCount / (double)totalVerts) * ((worldMeters / 1000.0) * (worldMeters / 1000.0));
        return new GenerateDericostTerrainResult(
            Success: true,
            OutputDir: outputDir,
            Width: dim,
            Height: dim,
            DryLandVertices: dryCount,
            DryLandAreaKm2: Math.Round(dryLandAreaKm2, 2),
            AvgLandblockReliefM: Math.Round(sumLbRelief / Math.Max(1, dryLbs), 2),
            AvgCellDeltaM: Math.Round(sumCellDelta / Math.Max(1, cellCount), 2),
            MinHeightM: Math.Round(minH, 1),
            MaxHeightM: Math.Round(maxH, 1));
    }
}
