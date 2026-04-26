using System.Numerics;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Terminal;

// ═══════════════════════════════════════════════════════════
//  Result records returned by CommandEngine.
//  Both TerminalRepl (console formatting) and
//  JsonCommandProcessor (JSON serialization) consume these.
// ═══════════════════════════════════════════════════════════

// ── Project Management ─────────────────────────────────────
public record LoadResult(
    string ProjectName, string ProjectFile,
    string ProjectDir, string DatDirectory);

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
public record TerrainEditResult(
    int VerticesModified, HashSet<ushort> ModifiedLandblocks);

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
public record ListObjectsResult(ushort LbKey, List<StaticObject> Objects);

public record AddObjectResult(ushort LbKey, int Index, StaticObject Object);

public record RemoveObjectResult(
    bool Success, ushort LbKey, int Index,
    uint RemovedModelId, Vector3 RemovedPosition);

public record ClearObjectsResult(
    bool Success, int ObjectsRemoved, int LandblocksProcessed,
    List<ushort> AffectedLandblocks);

public record MoveObjectResult(
    ushort LbKey, int Index, uint ModelId,
    Vector3 From, Vector3 To);

public record RotateObjectResult(
    ushort LbKey, int Index, uint ModelId,
    Quaternion OldOrientation, Quaternion NewOrientation);

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
