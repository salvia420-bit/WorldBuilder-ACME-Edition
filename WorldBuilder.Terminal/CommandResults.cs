using System.Numerics;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.Validation;

namespace WorldBuilder.Terminal;

// ── Transact (batched stage / validate / commit-or-rollback) ─
public record TransactOpOutcome(
    int Index,
    string Command,
    bool Success,
    string ResponseJson,
    string? Error = null);

public record TransactJournal(
    Guid TransactionId,
    DateTime StartedAt,
    DateTime FinishedAt,
    List<string> DocumentsTouched,
    List<string> DocumentsCreated,
    int OpsApplied,
    int OpsRolledBack);

public record TransactResult(
    bool Success,
    string Status,
    string Reason,
    List<TransactOpOutcome> Ops,
    List<ValidationReport>? Validation,
    TransactJournal Journal,
    string? Error = null);

// ── Transact-Diff (structured before/after report) ──────────
public record TransactDiffObject(
    int? Wcid,
    string Model,
    Vector3 Position,
    string[] Ontology);

public record TransactDiffMove(
    int? Wcid,
    string Model,
    Vector3 From,
    Vector3 To,
    double DeltaXY,
    double DeltaZ);

public record TransactDiffStructure(
    string Model,
    Vector3 Origin,
    string? Architecture,
    string FootprintShape);

public record TransactDiffValidationEntry(
    string Code,
    string Severity,
    string Msg,
    string? Context = null);

public record TransactDiffSpawn(
    int Wcid,
    string Name,
    Vector3 Position);

public record TransactDiffPoi(
    string Title,
    string[] Categories);

public record TransactDiffPerLandblock(
    uint LbX,
    uint LbY,
    string LbHex,
    DiffSet<TransactDiffObject> Objects,
    TransactDiffMoves Moves,
    DiffSet<TransactDiffStructure> Structures,
    DiffSet<TransactDiffValidationEntry> Validation,
    DiffSet<TransactDiffSpawn> Spawns,
    DiffSet<TransactDiffPoi> Pois,
    TransactDiffCategorical Categorical,
    bool CreatedByBatch);

public record DiffSet<T>(List<T> Added, List<T> Removed);
public record TransactDiffMoves(List<TransactDiffMove> Moved);
public record TransactDiffCategorical(
    string? BiomeBefore, string? BiomeAfter,
    bool RoadBefore, bool RoadAfter,
    int CliffsBefore, int CliffsAfter);

public record TransactDiffSummary(
    int DocumentsTouched,
    int ObjectsAdded, int ObjectsRemoved, int ObjectsMoved,
    int StructuresAdded, int StructuresRemoved,
    int ValidationErrorsDelta, int ValidationWarningsDelta, int ValidationInfoDelta,
    int SpawnsAdded, int SpawnsRemoved,
    int PoisAdded, int PoisRemoved,
    bool BiomeShift, bool RoadShift, bool CliffShift);

public record TransactDiffTerrainSummary(
    Dictionary<int, int> BiomeBefore,
    Dictionary<int, int> BiomeAfter,
    int VertexHeightChanged,
    int VertexTypeChanged,
    int VertexRoadChanged);

public record TransactDiffVisual(
    string Mode,
    byte[]? PngBytes,
    int Width,
    int Height,
    string? Note,
    string? OutPath);

public record TransactDiffResult(
    bool Success,
    Guid TxId,
    string? ErrorCode,
    string? Error,
    TransactDiffSummary? Summary,
    List<TransactDiffPerLandblock>? PerLandblock,
    TransactDiffTerrainSummary? TerrainSummary,
    TransactDiffVisual? Visual);

// ═══════════════════════════════════════════════════════════
//  Result records returned by CommandEngine.
//  Both TerminalRepl (console formatting) and
//  JsonCommandProcessor (JSON serialization) consume these.
// ═══════════════════════════════════════════════════════════

// ── Project Management ─────────────────────────────────────
public record LoadResult(
    string ProjectName, string ProjectFile,
    string ProjectDir, string DatDirectory,
    LoadAutoRestoreReport AutoRestore);

// Per-loader status for the six side-channel restores Load() performs
// (ontology cache, building pairings, town/POI/wcid/spawn/region gazetteers).
// Surfaced through LoadResult so JSON callers can detect partial-load
// instead of guessing from the absence of stderr lines.
public record LoadAutoRestoreEntry(
    string Source,
    bool FilePresent,
    bool Loaded,
    int Count,
    string? Error = null);

public record LoadAutoRestoreReport(
    LoadAutoRestoreEntry Ontology,
    LoadAutoRestoreEntry Pairings,
    LoadAutoRestoreEntry TownGazetteer,
    LoadAutoRestoreEntry PoiGazetteer,
    LoadAutoRestoreEntry WcidAcpedia,
    LoadAutoRestoreEntry SpawnGazetteer,
    LoadAutoRestoreEntry Regions,
    LoadAutoRestoreEntry WeenieIndex);

public record ExportResult(bool Success, string Directory, int? Iteration);

public record ExportWithRepositionResult(
    bool ExportSuccess, string Directory, int? Iteration,
    bool RepositionAttempted, bool RepositionSuccess,
    int InstancesChecked, int InstancesUpdated,
    int LandblocksProcessed,
    string? RepositionError = null);

public record ProjectInfoResult(
    bool Loaded,
    string? ProjectName = null, string? ProjectFile = null,
    string? ProjectDir = null, string? DatDirectory = null,
    string? DatabasePath = null, int? PortalIteration = null);

// ── Terrain Editing ────────────────────────────────────────
// Success is true when at least one vertex was modified. A "successful"
// command with VerticesModified=0 (e.g. radius too small, area already at
// target) returns Success=false so JSON callers can distinguish no-op from
// effect without having to inspect the count themselves.
public record TerrainEditResult(
    int VerticesModified, HashSet<ushort> ModifiedLandblocks) {
    public bool Success => VerticesModified > 0;
}

// Discriminated union of brush-style terrain-edit operations consumed by
// CommandEngine.ApplyTerrainEdit. New ops (ridge, erode, slope, ...) extend
// this hierarchy rather than copy-pasting the engine prelude.
public abstract record TerrainEditOp(float X, float Y, float Radius);
public sealed record SmoothEdit(float X, float Y, float Radius, float Strength = 0.5f)
    : TerrainEditOp(X, Y, Radius);
public sealed record RaiseEdit(float X, float Y, float Radius, int Delta = 5)
    : TerrainEditOp(X, Y, Radius);
public sealed record LowerEdit(float X, float Y, float Radius, int Delta = 5)
    : TerrainEditOp(X, Y, Radius);
public sealed record SetHeightEdit(float X, float Y, float Radius, byte HeightIndex)
    : TerrainEditOp(X, Y, Radius);
public sealed record PaintEdit(float X, float Y, float Radius, byte TerrainType)
    : TerrainEditOp(X, Y, Radius);

public record RoadResult(
    int Waypoints, int VerticesModified,
    byte RoadValue, HashSet<ushort> ModifiedLandblocks);

// ── Terrain Queries ────────────────────────────────────────
public record HeightQueryResult(
    float X, float Y, float Height,
    byte? HeightIndex = null, byte? TerrainType = null,
    byte? Road = null, byte? Scenery = null,
    ushort? LandblockId = null, int? VertexIndex = null);

public record TerrainSampleHeightResult(
    float WorldX, float WorldY,
    float TriangleHeight,
    float VertexHeight,
    float Difference,
    ushort LandblockId,
    float LocalX, float LocalY,
    string? Error = null);

public record TerrainTypeCount(byte Type, int Count);

public record TerrainInfoResult(
    ushort LbKey, uint LbX, uint LbY, bool Found,
    int VertexCount = 0, int HeightMin = 0, int HeightMax = 0,
    double HeightAvg = 0,
    List<TerrainTypeCount>? TerrainTypes = null);

public record HeightmapResult(
    ushort LbKey, uint LbX, uint LbY, bool Found,
    double[][]? HeightsWorld = null, int[][]? HeightIndices = null);

public record TerrainVertexInfo(
    int Index, int GridX, int GridY,
    byte HeightIndex, double HeightWorld,
    byte TerrainType, byte Road, byte Scenery);

public record TerrainDataResult(
    ushort LbKey, uint LbX, uint LbY, bool Found,
    List<TerrainVertexInfo>? Vertices = null);

// ── Object Management ──────────────────────────────────────
public record ListObjectsResult(ushort LbKey, List<StaticObject> Objects, bool Found = true);

public record AddObjectResult(ushort LbKey, int Index, StaticObject Object) {
    public bool Success => true;
}

public record RemoveObjectResult(
    bool Success, ushort LbKey, int Index,
    uint RemovedModelId, Vector3 RemovedPosition);

public record ClearObjectsResult(
    bool Success, int ObjectsRemoved, int LandblocksProcessed,
    List<ushort> AffectedLandblocks, bool Found = true);

public record MoveObjectResult(
    ushort LbKey, int Index, uint ModelId,
    Vector3 From, Vector3 To) {
    public bool Success => true;
}

public record RotateObjectResult(
    ushort LbKey, int Index, uint ModelId,
    Quaternion OldOrientation, Quaternion NewOrientation) {
    public bool Success => true;
}

// ── Region Render ──────────────────────────────────────────
public record RenderPreviewResult(
    uint CenterLbX, uint CenterLbY, ushort CenterLbKey,
    int Radius, int Resolution, int LbPixelSize,
    int LandblockCount, int ObjectCount, int CliffCount,
    bool OverlayApplied,
    byte[] PngBytes,
    string? OutputPath);

// ── Spatial Queries ────────────────────────────────────────
public record FoundObject(
    float Distance, ushort LbKey, int Index, StaticObject Object);

public record QueryRadiusResult(
    float CenterX, float CenterY, float CenterZ,
    float Radius, bool IncludeZ,
    List<FoundObject> Objects,
    Dictionary<uint, int> ModelCounts);

// ── Dungeon ────────────────────────────────────────────────
public record DungeonInfoResult(
    ushort LbKey, bool HasDungeon, int CellCount,
    DungeonDocument? Document);

// ── World Observation ──────────────────────────────────────
public record LandblockSummary(
    ushort LbKey, uint LbX, uint LbY,
    int HeightMin, int HeightMax);

public record ListLandblocksResult(
    int Count, uint MinX, uint MinY, uint MaxX, uint MaxY,
    bool Truncated, List<LandblockSummary> Landblocks);

public record ActiveDocInfo(string Id, string Type, bool IsDirty);

public record WorldInfoResult(
    string ProjectName, int ModifiedLandblocks,
    int HeightTableSize, double HeightMin, double HeightMax,
    int? PortalIteration,
    List<ActiveDocInfo> ActiveDocuments);

public record TerrainTypeNameInfo(int Index, string Name);

public record RegionResult(
    float[] HeightTable,
    List<TerrainTypeNameInfo>? TerrainTypes = null);

// ── Ontology ───────────────────────────────────────────────
public record OntologyScanResult(OntologyScanReport Report);

public record OntologyQueryResult(
    OntologyEntry[] Entries,
    int TotalIndexed);

public record OntologyStatsResult(
    int TotalEntries,
    Dictionary<string, int> CategoryCounts,
    Dictionary<string, int> ScaleCounts,
    // Coverage fields (populated after weenie enrichment)
    int WithName = 0,
    int WithWeenieClassId = 0,
    int WithLevel = 0,
    int WithCreatureType = 0,
    Dictionary<int, int>? WeenieTypeCounts = null);

// ── Stamp ─────────────────────────────────────────────────
public record PasteStampResult(
    int TerrainChanges,
    int ObjectsPlaced,
    HashSet<ushort> ModifiedLandblocks);

// ── Portal Snap ───────────────────────────────────────────
public record SnapPortalResult(
    ushort LbKey, ushort TargetCellNumber, ushort TargetPortalPolygonId,
    ushort SourceEnvironmentId, ushort SourceCellStructure,
    ushort NewCellNumber,
    System.Numerics.Vector3 NewOrigin, System.Numerics.Quaternion NewOrientation,
    int PortalCount);

// ── Bulk Heightmap ────────────────────────────────────────
public record BulkHeightmapResult(
    int TotalLandblocks,
    int FoundLandblocks,
    List<HeightmapResult> Heightmaps);

// ── Object Detail ─────────────────────────────────────────
public record ObjectDetailResult(
    uint ObjectId, string ObjectIdHex, string DatType,
    bool Found,
    int PartCount = 0, int PolyCount = 0, int VertexCount = 0,
    float MaxDimension = 0f,
    float[]? BoundsMin = null, float[]? BoundsMax = null, float[]? BoundsSize = null,
    List<string>? SurfaceIds = null,
    string? OntologyCategory = null, string? OntologyScale = null,
    List<string>? OntologyTags = null);

// ── Terrain Diff ──────────────────────────────────────────
public record TerrainDiffEntry(
    int GridX, int GridY, int VertexIndex,
    byte OldHeight, byte NewHeight,
    byte OldTerrainType, byte NewTerrainType,
    byte OldRoad, byte NewRoad);

public record TerrainDiffResult(
    ushort LbKey, uint LbX, uint LbY, bool Found,
    bool HasChanges,
    int TotalVertices = 81,
    int ChangedVertices = 0,
    int HeightChanges = 0,
    int TerrainTypeChanges = 0,
    int RoadChanges = 0,
    List<TerrainDiffEntry>? Changes = null);

// ── Terrain Layers ────────────────────────────────────────
public record TerrainLayerInfo(
    int TypeIndex, string? Name, int VertexCount, double Percentage);

public record TerrainLayersResult(
    ushort LbKey, uint LbX, uint LbY, bool Found,
    int TotalVertices = 0,
    List<TerrainLayerInfo>? Layers = null);

// ── DAT Extension Commands ────────────────────────────────
public record ExportTexturesResult(
    bool Success, int Exported, int Failed, string OutputDirectory,
    List<string>? Errors = null);

public record ImportTextureResult(
    bool Success, uint TextureId, string InputFile,
    string? Error = null);

public record CloneDatResult(
    bool Success, string SourcePath, string DestPath,
    string? Error = null);

public record DefragmentDatResult(
    bool Success, string DatType, string OutputPath,
    int BytesFreed = 0, string? Error = null);

// ── Ontology Export ───────────────────────────────────────
public record ExportOntologyResult(
    bool Success, int EntriesExported, string OutputPath);

// ── Setup → Parts Export ─────────────────────────────────
public record ExportSetupPartsResult(
    bool Success, int SetupsScanned, int SetupsExported,
    int TotalParts, int UniqueParts, string OutputPath,
    string? Error = null);

// ── Classification Signals Export ────────────────────────
public record ExportClassificationSignalsResult(
    bool Success,
    int BuildingModelCount,
    int LandBlockInfoScanned,
    int ScenerySetupCount,
    int ScenesScanned,
    string OutputPath,
    string? Error = null);

// ── StringTable Mining ───────────────────────────────────
public record StringTableEntry(uint Hash, string Text, string TableType);

public record MineStringsResult(
    bool Success, int TablesScanned, int TotalStrings,
    List<StringTableEntry> Strings,
    string? OutputPath = null,
    string? Error = null);

// ── Ontology Enrichment ──────────────────────────────────
public record EnrichOntologyResult(
    bool Success, int EntriesEnriched, int TotalEntries,
    string? Error = null);

// ── Catalog Import ───────────────────────────────────────
public record ImportCatalogResult(
    bool Success, int EntriesEnriched, int TotalEntries,
    string IndexPath,
    string? Error = null);

// ── LLM Classification (String-table) ────────────────────
public record ClassifyOntologyResult(
    bool Success, int StringsUsed, int EntriesEnriched,
    int TotalEntries,
    string? Error = null);

// ── Material Enrichment ──────────────────────────────────
public record EnrichMaterialsResult(
    bool Success, int EntriesEnriched, int TotalEntries,
    string? Error = null);

// ── Benchmark ────────────────────────────────────────────
public record BenchmarkSubTest(
    string Name, int Operations, double ElapsedMs,
    double OpsPerSec,
    double? FirstSegmentOpsPerSec = null,
    double? LastSegmentOpsPerSec = null,
    double? DegradationPercent = null);

public record BenchmarkMemorySnapshot(
    string Label, long Bytes);

public record BenchmarkGcCounts(
    string Label, int Gen0, int Gen1, int Gen2);

public record BenchmarkExtrapolation(
    double TerrainVertexOpsPerSec,
    long TotalVertexWrites,
    double EstimatedTerrainPassSeconds,
    string EstimatedTerrainPassFormatted,
    double? BulkLandblockOpsPerSec,
    long TotalLandblocks,
    double? EstimatedBulkTerrainPassSeconds,
    string? EstimatedBulkTerrainPassFormatted,
    double ObjectOpsPerSec,
    long TotalObjectPlacements,
    double EstimatedObjectPassSeconds,
    string EstimatedObjectPassFormatted,
    string Feasibility);

public record BenchmarkResult(
    List<BenchmarkSubTest> Tests,
    List<BenchmarkMemorySnapshot> Memory,
    BenchmarkGcCounts GcBefore,
    BenchmarkGcCounts GcAfter,
    BenchmarkExtrapolation Extrapolation);

// ── Bulk Operations ──────────────────────────────────────
public record SetLandblockHeightmapResult(
    ushort LbKey, int VerticesModified, HashSet<ushort> ModifiedLandblocks);

public record SetLandblockTerrainResult(
    ushort LbKey, int VerticesModified, HashSet<ushort> ModifiedLandblocks);

public record BulkPlaceObjectsResult(
    ushort LbKey, int Placed, int Errors, List<string>? ErrorMessages = null);

// ── Procedural Generation ────────────────────────────────
public record GenerateTerrainResult(
    bool Success,
    int Seed,
    int Octaves,
    float Lacunarity,
    float Persistence,
    float Amplitude,
    int LandblocksWritten,
    long VerticesWritten,
    double ElapsedMs,
    double LandblocksPerSec,
    bool HasCoastline,
    bool AutoPainted,
    string? Error = null);

public record AutoPaintResult(
    bool Success,
    int LandblocksWritten,
    long VerticesPainted,
    double ElapsedMs,
    int WaterVertices,
    int SandVertices,
    int GrassVertices,
    int RockVertices,
    int SnowVertices,
    int CliffOverrides,
    string? Error = null);

// ── LSD Data Ingestion Pipeline ─────────────────────────
public record IngestWeeniesResult(
    bool Success, int TotalProcessed, int CreatureCount, int NpcCount,
    int ItemCount, int OtherCount, int WithSetupDid, string? OutputPath,
    string? Error = null);

public record EnrichWeeniesResult(
    bool Success, int EntriesEnriched, int TotalEntries,
    string? Error = null);

public record EnrichCanonicalResult(
    bool Success, int EntriesEnriched, int TotalEntries,
    string CanonicalPath,
    string? Error = null);

public record EnrichUnifiedResult(
    bool Success, int EntriesEnriched, int TotalEntries,
    string UnifiedPath,
    string? Error = null);

public record CacheOntologyResult(
    bool Success, int EntriesCached, string OutputPath,
    string? Error = null);

public record LoadOntologyCacheResult(
    bool Success, int EntriesLoaded, string InputPath,
    string? Error = null);

public record ScanBuildingPlacementsResult(
    bool Success, int TotalBuildings, int UniqueSetupIds,
    int LandblocksWithBuildings, double ElapsedMs,
    string? OutputPath = null,
    string? Error = null);

public record DifficultyGradientResult(
    bool Success, string GradientPath,
    Dictionary<string, int> TierDistribution,
    string? Error = null);

public record ApplyPopulationResult(
    bool Success, int LandblocksModified, int ObjectsPlaced,
    int ObjectsSkipped, double ElapsedMs,
    string? PlanPath = null,
    string? Error = null);

public record IngestSpawnMapsResult(
    bool Success, int TotalProcessed, int TotalWeenies, int TotalLinks,
    int UniqueWcids, string? OutputPath, string? Error = null);

public record IngestSpellsResult(
    bool Success, int TotalProcessed, Dictionary<int, int> SchoolCounts,
    string? OutputPath, string? Error = null);

public record IngestRecipesResult(
    bool Success, int TotalProcessed, int WithPrecursors,
    int UniqueSourceWcids, int UniqueResultWcids,
    Dictionary<int, int> SkillCounts,
    string? OutputPath, string? Error = null);

// ═══════════════════════════════════════════════════════
//  Phase 9 — Dungeon Catalog
// ═══════════════════════════════════════════════════════

public record AnalyzeDungeonCatalogResult(
    bool Success,
    int TotalLandblocksScanned,
    int TotalCellsScanned,
    int UniqueRoomTemplates,
    int Errors,
    Dictionary<string, int> ClassificationCounts,
    string? OutputPath, string? Error = null);

// ═══════════════════════════════════════════════════════
//  Phase 9 — Dungeon Topology
// ═══════════════════════════════════════════════════════

public record AnalyzeDungeonTopologyResult(
    bool Success,
    int TotalDungeonsAnalyzed,
    int TotalCellsAnalyzed,
    Dictionary<string, int> ClassificationCounts,
    string? OutputPath, string? Error = null);

// ═══════════════════════════════════════════════════════
//  Phase 9 — Generate Dungeon
// ═══════════════════════════════════════════════════════

public record GenerateDungeonResult(
    bool Success,
    ushort LbKey,
    int NodesInGraph,
    int EdgesInGraph,
    int CellsPlaced,
    int MaxDepth,
    int Seed,
    List<string> Warnings,
    string? GraphSummary = null,
    string? Error = null);

// ═══════════════════════════════════════════════════════
//  Phase 10 — Landblock Pattern Analysis
// ═══════════════════════════════════════════════════════

public record AdjacencyPair(
    string ObjectA, string ObjectB,
    int Count5, int Count10, int Count25,
    double AvgDistance);

public record SlopeDistribution(
    int Flat, int Gentle, int Moderate, int Steep);

public record ClusterSummary(
    int TotalClusters, double AvgClusterSize, int LargestCluster);

public record OrientationBias(
    int North, int East, int South, int West,
    string? DominantDirection);

public record AnalyzeLandblockPatternsResult(
    bool Success,
    int LandblocksAnalyzed,
    int TotalObjectsAnalyzed,
    List<AdjacencyPair> TopAdjacencyPairs,
    SlopeDistribution SlopeDistribution,
    ClusterSummary ClusterSummary,
    OrientationBias OrientationBias,
    double ElapsedMs,
    string? OutputPath = null,
    string? Error = null);

public record ExtractBuildingPairingsResult(
    bool Success,
    int StructuresScanned,
    int PairsKept,
    int GroupCount,
    string? OutputPath = null,
    long ElapsedMs = 0,
    string? Error = null);

public record LoadBuildingPairingsResult(
    bool Success,
    int EdgeCount,
    int GroupCount,
    string? Error = null);

// ═══════════════════════════════════════════════════════
//  Phase 10 — Export Training Data
// ═══════════════════════════════════════════════════════

public record ExportTrainingDataResult(
    bool Success,
    int TotalExported,
    int LandblocksProcessed,
    int WithOntology,
    double ElapsedMs,
    string? OutputPath = null,
    string? Error = null);

public record ExportRawWorldFactsResult(
    bool Success,
    int TotalExported,
    int DatStaticCount,
    int AceInstanceCount,
    int AceEncounterCount,
    int AceHousePortalCount,
    int LandblocksProcessed,
    bool IncludedAceDb,
    bool IncludedLinks,
    double ElapsedMs,
    string? OutputPath = null,
    string? Error = null);

public record ExportEnvCellComponentsResult(
    bool Success,
    int TotalExported,
    int AnchoredCount,
    int UnanchoredCount,
    int LandblocksProcessed,
    double ElapsedMs,
    string? OutputPath = null,
    string? Error = null);

// ═══════════════════════════════════════════════════════
//  Phase 10 — Generate Settlement
// ═══════════════════════════════════════════════════════

public record PlacedSettlementObject(
    uint ModelId,
    string ModelIdHex,
    float X, float Y, float Z,
    string Category,
    string? Name,
    float YawDegrees);

public record GenerateSettlementResult(
    bool Success,
    string TemplateName,
    int ObjectsPlaced,
    int ConstraintViolations,
    List<string> Warnings,
    List<PlacedSettlementObject> PlacedObjects,
    double ElapsedMs,
    string? Error = null);

// ═══════════════════════════════════════════════════════
//  Phase 10.5a — Extract Retail Heightmaps
// ═══════════════════════════════════════════════════════

public record ExtractHeightmapsResult(
    bool Success,
    int TotalLandblocks,
    int PopulatedLandblocks,
    double ElapsedMs,
    string? OutputPath = null,
    string? Error = null);

// ═══════════════════════════════════════════════════════
//  Phase 10.5a — Compute Vanilla Baseline
// ═══════════════════════════════════════════════════════

public record VanillaBaselineResult(
    bool Success,
    int LandblocksScanned,
    int PopulatedLandblocks,
    int TotalObjects,
    double ElapsedMs,
    string? OutputPath = null,
    string? Error = null);

// ═══════════════════════════════════════════════════════
//  Calibrate World Map — Color→Terrain Codebook
// ═══════════════════════════════════════════════════════

public record CalibrateWorldMapResult(
    bool Success,
    int TerrainTypesFound,
    int VerticesCalibrated,
    int LandblocksProcessed,
    double ElapsedMs,
    string OutputPath,
    string? Error = null);

// ═══════════════════════════════════════════════════════
//  Image-Driven Terrain — Analyze Map Image
// ═══════════════════════════════════════════════════════

public record BiomeCellInfo(
    int LbX, int LbY, string BiomeId, bool IsLand,
    int AvgR, int AvgG, int AvgB,
    double AvgBrightness,
    byte TerrainTypeId = 0,
    string TerrainTypeName = "Ice");

public record AnalyzeMapImageResult(
    bool Success,
    int ImageWidth, int ImageHeight,
    int LandCells, int OceanCells,
    Dictionary<string, int> BiomeCounts,
    double ElapsedMs,
    string? OutputPath = null,
    string? Error = null);

// ═══════════════════════════════════════════════════════
//  Quick World — POC World Generation
// ═══════════════════════════════════════════════════════

public record QuickWorldResult(
    bool Success,
    int LandblocksStamped,
    int LandblocksSkipped,
    int ObjectsPlaced,
    int ApproximateColorMatches,
    int SceneryFailures,
    Dictionary<string, int> TerrainTypesStamped,
    double ElapsedMs,
    string? Error = null);

// ═══════════════════════════════════════════════════════
//  ACE Database Commands
// ═══════════════════════════════════════════════════════

public record AceDbConnectResult(
    bool Success,
    string Host, int Port, string Database, string User,
    bool SettingsSaved,
    string? Error = null);

public record AceDbStatusResult(
    bool HasSettings,
    string? Host = null, int? Port = null,
    string? Database = null, string? User = null,
    bool? ConnectionOk = null,
    string? Error = null);

public record AceDbInstanceInfo(
    uint Guid, uint WeenieClassId, uint ObjCellId,
    float OriginX, float OriginY, float OriginZ,
    ushort LandblockId, bool IsOutdoor);

public record AceDbQueryInstancesResult(
    bool Success,
    ushort LandblockId,
    int InstanceCount,
    List<AceDbInstanceInfo> Instances,
    string? Error = null);

public record AceDbRepositionResult(
    bool Success,
    int InstancesChecked,
    int InstancesUpdated,
    int LandblocksProcessed,
    string? SqlFilePath = null,
    bool AppliedDirectly = false,
    string? Error = null);

public record AceDbExportSqlResult(
    bool Success,
    int InstancesChecked,
    int InstancesUpdated,
    int LandblocksProcessed,
    string? SqlFilePath = null,
    string? Error = null);

public record AceDbLandblockStats(ushort LandblockId, int InstanceCount);

public record AceDbStatsResult(
    bool Success,
    int TotalInstances,
    int TotalLandblocks,
    List<AceDbLandblockStats>? DensestLandblocks = null,
    List<AceDbLandblockStats>? EmptySampledLandblocks = null,
    string? Error = null);

public record AceDbClearInstancesResult(
    bool Success,
    int InstancesDeleted,
    int LinksDeleted,
    string? Error = null);

// ═══════════════════════════════════════════════════════
//  Dungeon Document Operations
// ═══════════════════════════════════════════════════════

public record DungeonAddCellResult(
    bool Success,
    ushort LbKey,
    ushort CellNumber,
    ushort EnvironmentId,
    ushort CellStructure,
    int TotalCells,
    string? Error = null);

public record DungeonRemoveCellResult(
    bool Success,
    ushort LbKey,
    ushort CellNumber,
    int TotalCells,
    string? Error = null);

public record DungeonConnectResult(
    bool Success,
    ushort LbKey,
    ushort CellA, ushort CellB,
    ushort PolyA, ushort PolyB,
    string? Error = null);

public record DungeonDisconnectResult(
    bool Success,
    ushort LbKey,
    ushort CellA, ushort CellB,
    int PortalsRemoved,
    string? Error = null);

public record DungeonValidationIssue(string Severity, string Message, ushort? CellNumber);

public record DungeonValidateResult(
    bool Success,
    ushort LbKey,
    int CellCount,
    int Errors, int Warnings, int Infos,
    List<DungeonValidationIssue> Issues,
    string? Error = null);

public record DungeonAutoFixResult(
    bool Success,
    ushort LbKey,
    int FixesApplied,
    string? Error = null);

public record DungeonRecomputeResult(
    bool Success,
    ushort LbKey,
    int VisibleCellsUpdated,
    int PortalFlagsUpdated,
    string? Error = null);

public record DungeonReloadResult(
    bool Success,
    ushort LbKey,
    int CellCount,
    string? Error = null);

public record DungeonCopyCellsResult(
    bool Success,
    ushort SourceLbKey,
    ushort DestLbKey,
    int CellsCopied,
    string? Error = null);

public record DungeonMoveCellResult(
    bool Success,
    ushort LbKey,
    ushort CellNumber,
    float DeltaX,
    float DeltaY,
    float DeltaZ,
    string? Error = null);

public record DungeonRotateCellResult(
    bool Success,
    ushort LbKey,
    ushort CellNumber,
    float Degrees,
    float AxisX,
    float AxisY,
    float AxisZ,
    string? Error = null);

public record DungeonMoveObjectResult(
    bool Success,
    ushort LbKey,
    ushort CellNumber,
    int ObjectIndex,
    float DeltaX,
    float DeltaY,
    float DeltaZ,
    string? Error = null);

public record DungeonRotateObjectResult(
    bool Success,
    ushort LbKey,
    ushort CellNumber,
    int ObjectIndex,
    float Degrees,
    string? Error = null);

public record DungeonSetCellPositionResult(
    bool Success,
    ushort LbKey,
    ushort CellNumber,
    float X,
    float Y,
    float Z,
    string? Error = null);

public record DungeonSetCellRotationResult(
    bool Success,
    ushort LbKey,
    ushort CellNumber,
    float RotX,
    float RotY,
    float RotZ,
    string? Error = null);

public record DungeonSetObjectPositionResult(
    bool Success,
    ushort LbKey,
    ushort CellNumber,
    int ObjectIndex,
    float X,
    float Y,
    float Z,
    string? Error = null);

public record DungeonSetObjectRotationResult(
    bool Success,
    ushort LbKey,
    ushort CellNumber,
    int ObjectIndex,
    float Degrees,
    string? Error = null);

// ═══════════════════════════════════════════════════════
//  Building Remap (cluster shuffle)
// ═══════════════════════════════════════════════════════

public record RemapBuildingsResult(
    bool Success,
    int LandblocksProcessed,
    int BuildingsMoved,
    int CellsCreated,
    int InteriorInstancesRemapped,
    int LandblocksWithBuildings,
    double ElapsedMs,
    string? SqlFilePath = null,
    List<string>? Warnings = null,
    string? Error = null);

// ═══════════════════════════════════════════════════════
//  Building Remap V2 (layer-based pipeline)
// ═══════════════════════════════════════════════════════

/// <summary>
/// Result for remap-buildings-v2:
/// - copies source landblock static objects (Stabs) to destination docs
/// - copies source building shells (BuildingInfo.ModelId) as placement anchors
/// Export then materializes shells/interiors through SaveToDatsInternal.
/// </summary>
public record RemapBuildingsV2Result(
    bool Success,
    int LandblocksScanned,
    int LandblocksWithBuildings,
    int BuildingShellsCopied,
    int StaticObjectsCopied,
    int TerrainVerticesFlattened,
    double ElapsedMs,
    string? OldCellIdMapPath = null,
    List<string>? Warnings = null,
    string? Error = null);

/// <summary>
/// Result for remap-buildings-sql: generates/applies SQL to remap
/// interior instance cell IDs after export.
/// </summary>
public record RemapBuildingsSqlResult(
    bool Success,
    int CellIdRemaps,
    int BuildingsMatched,
    double ElapsedMs,
    string? SqlFilePath = null,
    bool Applied = false,
    List<string>? Warnings = null,
    string? Error = null);

// ── WorldGen (slice 3 of f26345e) ──────────────────────────
public record TownSummary(string Name, string SizeLabel,
    int CenterLbX, int CenterLbY,
    float CenterX, float CenterY, float CenterZ,
    float Radius, int BuildingCount);

public record WorldGenResult(
    bool Success, int Seed,
    int TerrainLandblocksAffected, int TotalVerticesModified,
    int TownCount, int TotalBuildingsPlaced, int TotalDecorationsPlaced,
    int TotalRoadVertices,
    List<TownSummary> Towns,
    string? OutputPath = null,
    bool Applied = false,
    string? Error = null);

public record BuildingProfileSummary(
    uint ModelId, string HexId, uint NumLeaves,
    int CellCount, int PortalCount, int TotalStatics,
    int OccurrenceCount, int UniqueLandblocks,
    bool HasInterior, bool IsPairedHalf);

public record AnalyzeBuildingsResult(
    bool Success, int Total, int WithInterior, int Paired,
    List<BuildingProfileSummary> Buildings,
    string? OutputPath = null,
    string? Error = null);

public record RetailTownStat(uint ModelId, string HexId,
    int TownLandblockHits, int SingletonTownHits,
    int MaxCopiesInOneTownLb, float SingletonRatio);

public record ScanRetailTownsResult(
    bool Success, int ModelCount,
    List<RetailTownStat> Stats,
    string? OutputPath = null,
    string? Error = null);

// ── Weenie / ACE DB (slice 2 of f26345e) ───────────────────
public record WeenieSnapshotResult(
    bool Success,
    uint ClassId,
    uint WeenieType = 0,
    string? Name = null,
    uint SetupDid = 0,
    uint IconDid = 0,
    int IntCount = 0, int Int64Count = 0, int BoolCount = 0,
    int FloatCount = 0, int StringCount = 0,
    int DataIdCount = 0, int InstanceIdCount = 0,
    int SpellBookCount = 0, int CreateListCount = 0,
    int EmoteCount = 0, int BookCount = 0,
    int PositionCount = 0, int AttributeCount = 0,
    int Attribute2ndCount = 0, int SkillCount = 0,
    DateTime? LastModified = null,
    object? Snapshot = null,
    string? Error = null);

public record WeenieTemplateInfo(
    string Id, string Title, string? Description, uint WeenieType,
    int IntCount, int Int64Count, int BoolCount, int FloatCount,
    int StringCount, int DataIdCount, int InstanceIdCount);

public record WeenieTemplateListResult(
    bool Success, string? BundlePath,
    int TemplateCount,
    List<WeenieTemplateInfo> Templates,
    string? Error = null);

public record WeenieTemplateApplyResult(
    bool Success, string? BundlePath,
    string TemplateId, uint ClassId,
    int ScalarsApplied,
    string? Error = null);

// ── Mesh / BSP (slice 1 of f26345e) ────────────────────────
public record ObjExportResult(
    uint DatId, string HexId, string DatType,
    bool Found, string? OutputPath = null,
    int PartCount = 0, int TriangleCount = 0,
    string? Error = null);

public record ObjImportResult(
    bool Success,
    uint GfxObjId, uint SetupId,
    int TriangleCount, int VertexCount,
    string? Error = null);

public record BspBuildResult(
    uint GfxObjId, string HexId,
    bool Found, bool Built,
    int PolygonCount = 0,
    string? Error = null);

// ── compare-to-retail (subprocesses scripts/.../compare_world_to_retail.py) ──
public record CompareRegionBbox(
    int NLandblocks, int XMin, int XMax, int YMin, int YMax);

public record CompareDensityStats(
    int N, int Min, int P50, double Mean, int P95, int Max, int Total);

public record CompareCoverage(
    int ModelUnique, int RetailUnique, int Both, int Novel, int Missing);

public record CompareSurfaceInterior(
    int ModelSurface, int ModelInterior,
    double ModelSurfacePct, double ModelInteriorPct,
    int RetailSurface, int RetailInterior,
    double RetailSurfacePct, double RetailInteriorPct);

public record CompareLbJaccard(int N, double? Mean, double? P50, double? P10);

public record CompareAnomalySummary(double Frac, int NovelUnique, int EmittedUnique);

public record CompareClassSpace(
    Dictionary<string, int> Retail,
    int RetailTotal,
    Dictionary<string, double> RetailFractions,
    Dictionary<string, int> ModelEmitted,
    int ModelTotal,
    double? CoverageOfRetailWcid,
    double CoverageOfRetailAll);

public record CompareWcidRow(int Wcid, int ModelCount, int RetailCount, double Ratio);

public record CompareWcidSimpleRow(int Wcid, int Count);

public record CompareWcidAnomalies(
    List<CompareWcidRow> Over,
    List<CompareWcidRow> Under,
    List<CompareWcidSimpleRow> Novel,
    List<CompareWcidSimpleRow> Missing);

public record ComparePerLbRow(
    int LbX, int LbY,
    int ModelCount, int RetailCount, int DensityDelta,
    int ModelWcidUnique, int RetailWcidUnique,
    double? WcidJaccard,
    int NovelInLb, int MissingInLb);

public record CompareToRetailResult(
    bool Success,
    string Generated,
    string Retail,
    CompareRegionBbox? Region = null,
    int GeneratedCount = 0,
    int RetailCount = 0,
    double DensityDeltaPct = 0,
    CompareDensityStats? ModelDensity = null,
    CompareDensityStats? RetailDensity = null,
    CompareCoverage? Coverage = null,
    CompareSurfaceInterior? SurfaceInterior = null,
    CompareLbJaccard? LbJaccard = null,
    CompareAnomalySummary? Anomalies = null,
    CompareClassSpace? ClassSpace = null,
    CompareWcidAnomalies? Wcids = null,
    List<ComparePerLbRow>? PerLandblock = null,
    string? OutJsonPath = null,
    string? OutMdPath = null,
    bool RetailCacheHit = false,
    double ElapsedSeconds = 0,
    string? Error = null);

// ── O8: FreshStart + GenerateWorld + Towns CSV ─────────────
public record FreshStartResult(bool Success, int LandblocksReset, int VerticesReset);

public record GenerateWorldResult(
    bool Success,
    int Seed,
    bool Applied,
    int LandblocksAffected,
    int VerticesModified,
    int Towns,
    int BuildingsPlaced,
    int DecorationsPlaced,
    int RoadVertices,
    string? TownsCsvPath,
    int TownsCsvRows,
    List<TownSummary> TownSummaries);

public record ExportTownsCsvResult(bool Success, string OutPath, int Rows);

// ── O6: Outdoor + Dungeon Instance Placements ──────────────
public record PlacementListRow(
    string Kind,
    int Index,
    string Landblock,
    uint Wcid,
    ushort CellNumber,
    float OriginX, float OriginY, float OriginZ,
    float AnglesW, float AnglesX, float AnglesY, float AnglesZ);

public record PlacementListResult(int Count, string Filter, List<PlacementListRow> Placements);

public record PlacementAddResult(bool Success, string Kind, int Index, string Landblock);

public record PlacementRemoveResult(bool Removed, string Kind, int Index, string? Landblock);

// E1 (wave-2) PR3 — sets the enrichment export scope (Option A class-default vs Option B placement-override).
public record PlacementSetScopeResult(bool Success, string Kind, int Index, string Scope);

public record PlacementExportSqlResult(
    bool Success,
    string OutdoorPath, int OutdoorCount,
    string DungeonPath, int DungeonCount,
    int? RowsAppliedToDb,
    string? EnrichedJsonlPath = null, int EnrichedCount = 0,
    // E1 (wave-2) PR2 — per-class enrichment SQL emission (Option A).
    bool DryRun = false,
    System.Collections.Generic.IReadOnlyList<string>? EnrichmentSqlPaths = null,
    string? EnrichmentManifestPath = null,
    int EnrichmentConflictCount = 0,
    int PlacementOverrideSkipped = 0,
    // E1 (wave-2) PR3 — Option B per-placement biota override (shard DB) + E6 validation gate.
    System.Collections.Generic.IReadOnlyList<string>? BiotaSqlPaths = null,
    string? BiotaManifestPath = null,
    int BiotaCount = 0,
    int BiotaMintedGuids = 0,
    int BiotaWarningCount = 0,
    int BiotaSkipped = 0,
    string? ValidationReportPath = null,
    int ValidationErrorCount = 0,
    int ValidationWarningCount = 0,
    bool ValidationBlocked = false,
    int? ShardRowsAppliedToDb = null);

// ── E9b: scenery material sidecar → synthetic Surface(0x08) DAT round-trip ─
//
// Per-surface outcome of importing one E9a `<lbHex>.scenery.materials.json` record into the
// target (synthetic/project) DAT. Keyed by the addressable surface_did (0x08 DID) — never a
// list index. RoundTripOk asserts the re-read Surface fields equal the sidecar values.
public record SurfaceMaterialImportRecord(
    uint SurfaceDid,            // 0x08xxxxxx Surface DataId (the addressable key)
    uint SurfaceType,           // SurfaceType bitfield (raw u32)
    bool Textured,              // true → orig_texture_id/orig_palette_id; false → solid color_value
    bool Written,               // DatEasyWriter.Save succeeded
    bool RoundTripOk,           // re-read Surface(0x08) fields == sidecar values
    string? Error = null);

public record SurfaceMaterialImportResult(
    bool Success,
    string DatDir,                                       // target DAT directory written to
    int SourceFileCount,                                 // sidecar JSON files read
    int RecordCount,                                     // total material records across sidecars
    int WrittenCount,                                    // Surfaces written to the DAT
    int RoundTripOkCount,                                // Surfaces that round-tripped faithfully
    System.Collections.Generic.IReadOnlyList<SurfaceMaterialImportRecord> Records,
    string? Error = null);

// ── O4: ACE DB Weenie CRUD ─────────────────────────────────
public record WeenieSaveScalarsResult(
    bool Success,
    uint ClassId,
    int IntRows, int Int64Rows, int BoolRows, int FloatRows,
    int StringRows, int DataIdRows, int InstanceIdRows);

public record WeenieInsertResult(
    bool Success,
    uint NewClassId,
    string ClassName,
    int TotalScalarRows);

public record WeenieDeleteResult(bool Success, uint ClassId);

public record WeeniePropertyKey(ushort Type, string Name);

public record WeeniePropertyKeysResult(string Family, int Count, List<WeeniePropertyKey> Keys);

// ── O3: Spell DB CRUD ──────────────────────────────────────
public record SpellListRow(string SpellId, string? Name, bool HasOverlay);

public record SpellListResult(int Count, string Source, List<SpellListRow> Spells);

public record SpellGetResult(
    bool Success,
    string SpellId,
    string Source,
    WorldBuilder.Shared.Lib.AceDb.SpellRecord Spell);

public record SpellSaveResult(
    bool Success,
    string SpellId,
    bool SavedToOverlay,
    bool SavedToDb);

public record SpellCopyResult(
    bool Success,
    string FromSpellId,
    string NewSpellId,
    bool SavedToOverlay,
    bool SavedToDb);

public record SpellDeleteResult(
    bool Success,
    string SpellId,
    bool RemovedFromOverlay,
    bool DeletedFromDb);

// ── O7: Layout viewer / overlay ────────────────────────────
public record LayoutListRow(string LayoutId, bool HasOverlay);

public record LayoutListResult(int Count, List<LayoutListRow> Layouts);

public record LayoutGetResult(
    bool Success,
    string LayoutId,
    bool HasOverlay,
    DatReaderWriter.DBObjs.LayoutDesc Layout);

public record LayoutSaveResult(bool Success, string LayoutId);

public record LayoutDeleteOverlayResult(bool Removed, string LayoutId);

// ── O5: ACE DB Creature overrides ──────────────────────────
public record CreatureGetResult(
    bool Success,
    uint ObjectId,
    WorldBuilder.Shared.Lib.AceDb.AceCreatureOverrides Overrides);

public record CreatureSaveResult(
    bool Success,
    uint ObjectId,
    int TextureMapRows,
    int AnimPartRows);

public record CreatureExportSqlResult(
    bool Success,
    uint ObjectId,
    string Sql,
    string? OutPath);

// ── O1: RenderSurface texture import ───────────────────────
public record ImportRenderSurfaceResult(
    bool Success,
    uint RenderSurfaceId,
    string Name,
    bool Deferred,
    string Mode,
    string? Error);

// ── Real Map of Dereth (sync wave 2026-05) ──────────────────
public record IngestCreatureRosterResult(
    bool Success,
    int TotalProcessed,
    string? OutputPath,
    string? Error = null);

public record IngestNpcRosterResult(
    bool Success,
    int TotalProcessed,
    int VendorCount,
    int TalkerCount,
    string? OutputPath,
    string? Error = null);

public record IngestHousingRosterResult(
    bool Success,
    int HouseCount,
    int PortalCount,
    string? OutputPath,
    string? Error = null);

public record IngestAceSpawnsResult(
    bool Success,
    int LandblocksTouched,
    int RecordsWritten,
    int SyntheticRecords,
    string? OutputPath,
    string? Error = null);

public record IngestWeenieIndexResult(
    bool Success,
    int TotalEntries,
    int WithSetupDid,
    int ServerManaged,
    string? OutputPath,
    string? Error = null);

public record CompareCategoryDimension(
    int GeneratedCount,
    int RetailCount,
    double Jaccard,
    List<int> NovelInLb,
    List<int> MissingInLb);

public record CompareCreaturesResult(
    bool Success,
    CompareCategoryDimension Creatures,
    CompareCategoryDimension Npcs,
    CompareCategoryDimension Housing,
    string? Error = null);

// ── Render Gallery (sync wave 2026-05-XX wirerender) ─────────
public record RenderGalleryPickInfo(
    string Slug,
    string Title,
    string Category,
    string LbHex,
    int LbX, int LbY,
    string Render,
    string Desc,
    int? SpawnCount,
    int? CellCount,
    int RenderObjectCount,
    string Note);

public record RenderGalleryResult(
    bool Success,
    int PicksRendered,
    int LbsCovered,
    int TotalSpawnCount,
    string OutDir,
    string IndexPath,
    string ManifestPath,
    List<RenderGalleryPickInfo> Picks,
    string? Error = null);

public record ServeRenderGalleryResult(
    bool Success,
    string Url,
    string? TailscaleUrl,
    int Pid,
    int Port,
    string Bind,
    string OutDir,
    string? Error = null);

// ── O2: Heightmap import ───────────────────────────────────
public record ImportHeightmapPerLb(string Landblock, int Vertices);

public record ImportHeightmapResult(
    bool Applied,
    string ImagePath,
    int StartLbX, int StartLbY,
    int LbCountX, int LbCountY,
    int LandblocksConsidered,
    int LandblocksChanged,
    int VerticesChanged,
    List<ImportHeightmapPerLb> PerLandblock,
    HashSet<ushort> ModifiedLandblocks);
