using System.Numerics;
using DatReaderWriter.Types;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.Dungeon;

namespace WorldBuilder.Shared.Services;

/// <summary>
/// Abstraction over dungeon operations.
/// Wraps PortalSnapper, PortalSnapAlgorithms, and DungeonRoomAnalyzer
/// so that higher-level code (Terminal REPL, agent processor, ViewModels)
/// can depend on an injectable service rather than calling statics directly.
///
/// Phase 1 roadmap: "Extract the internal room/cell linking logic and
/// PortalSnapper into an isolated IDungeonService."
/// </summary>
public interface IDungeonService {
    // ── Portal snapping ──────────────────────────────────

    /// <summary>
    /// Extract portal polygon geometry from a CellStruct in local space.
    /// </summary>
    PortalSnapper.PortalGeometry? GetPortalGeometry(CellStruct cellStruct, ushort polygonId);

    /// <summary>
    /// Find all portal polygon IDs in a CellStruct.
    /// </summary>
    List<ushort> GetPortalPolygonIds(CellStruct cellStruct);

    /// <summary>
    /// Compute the world transform for a new cell so that its source portal
    /// aligns with a target portal on an existing cell.
    /// Returns (origin, orientation) for the new cell.
    /// </summary>
    (Vector3 Origin, Quaternion Orientation) ComputeSnapTransform(
        Vector3 targetCentroidWorld,
        Vector3 targetNormalWorld,
        PortalSnapper.PortalGeometry sourceGeometryLocal);

    /// <summary>
    /// Transform a portal's local-space geometry to world space.
    /// </summary>
    (Vector3 Centroid, Vector3 Normal) TransformPortalToWorld(
        PortalSnapper.PortalGeometry localGeometry,
        Vector3 cellOrigin,
        Quaternion cellOrientation);

    /// <summary>
    /// Pick the source portal that best aligns with the target normal.
    /// </summary>
    ushort? PickBestSourcePortal(CellStruct sourceCellStruct, Vector3 targetNormalWorld);

    // ── Analysis ─────────────────────────────────────────

    /// <summary>
    /// Run dungeon room analysis on the DAT.
    /// Scans LandBlockInfo entries, counts room type usage, and returns a structured report.
    /// </summary>
    DungeonRoomAnalyzer.AnalysisReport AnalyzeRooms(
        IDatReaderWriter dats,
        Func<List<ushort>, List<string>>? dungeonNameResolver = null);

    /// <summary>
    /// Save an analysis report to JSON and human-readable summary files.
    /// </summary>
    void SaveAnalysisReport(DungeonRoomAnalyzer.AnalysisReport report, string outputPath);

    // ── Validation helpers ───────────────────────────────

    /// <summary>
    /// Validates that two connecting portal transforms are perfectly inverse.
    /// Returns the alignment error (0 = perfectly aligned).
    /// </summary>
    float ComputePortalAlignmentError(
        Vector3 portalACentroid, Vector3 portalANormal,
        Vector3 portalBCentroid, Vector3 portalBNormal);
}
