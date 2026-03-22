using System.Numerics;
using DatReaderWriter.Types;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.Dungeon;

namespace WorldBuilder.Shared.Services;

/// <summary>
/// Default implementation of <see cref="IDungeonService"/>.
/// Delegates to PortalSnapper (which wraps PortalSnapAlgorithms) and DungeonRoomAnalyzer.
/// </summary>
public class DungeonService : IDungeonService {

    // ── Portal snapping ──────────────────────────────────

    public PortalSnapper.PortalGeometry? GetPortalGeometry(CellStruct cellStruct, ushort polygonId)
        => PortalSnapper.GetPortalGeometry(cellStruct, polygonId);

    public List<ushort> GetPortalPolygonIds(CellStruct cellStruct)
        => PortalSnapper.GetPortalPolygonIds(cellStruct);

    public (Vector3 Origin, Quaternion Orientation) ComputeSnapTransform(
        Vector3 targetCentroidWorld,
        Vector3 targetNormalWorld,
        PortalSnapper.PortalGeometry sourceGeometryLocal)
        => PortalSnapper.ComputeSnapTransform(targetCentroidWorld, targetNormalWorld, sourceGeometryLocal);

    public (Vector3 Centroid, Vector3 Normal) TransformPortalToWorld(
        PortalSnapper.PortalGeometry localGeometry,
        Vector3 cellOrigin,
        Quaternion cellOrientation)
        => PortalSnapper.TransformPortalToWorld(localGeometry, cellOrigin, cellOrientation);

    public ushort? PickBestSourcePortal(CellStruct sourceCellStruct, Vector3 targetNormalWorld)
        => PortalSnapper.PickBestSourcePortal(sourceCellStruct, targetNormalWorld);

    // ── Analysis ─────────────────────────────────────────

    public DungeonRoomAnalyzer.AnalysisReport AnalyzeRooms(
        IDatReaderWriter dats,
        Func<List<ushort>, List<string>>? dungeonNameResolver = null)
        => DungeonRoomAnalyzer.Run(dats, dungeonNameResolver);

    public void SaveAnalysisReport(DungeonRoomAnalyzer.AnalysisReport report, string outputPath)
        => DungeonRoomAnalyzer.SaveReport(report, outputPath);

    // ── Validation helpers ───────────────────────────────

    /// <summary>
    /// Validates portal alignment by computing the geometric error between
    /// two connecting portals. A perfect alignment yields 0.
    ///
    /// The check is based on two conditions:
    /// 1. Centroid distance (should be near 0 for a seamless connection).
    /// 2. Normal opposition (normals should be antiparallel, dot product ≈ -1).
    ///
    /// Returns a combined error metric. Values < 0.1 are considered well-aligned.
    /// </summary>
    public float ComputePortalAlignmentError(
        Vector3 portalACentroid, Vector3 portalANormal,
        Vector3 portalBCentroid, Vector3 portalBNormal) {

        float centroidDistance = Vector3.Distance(portalACentroid, portalBCentroid);

        // Perfect inverse normals have a dot product of -1.0
        float normalDot = Vector3.Dot(
            Vector3.Normalize(portalANormal),
            Vector3.Normalize(portalBNormal));

        // normalError: 0 when perfectly antiparallel, 2 when parallel
        float normalError = 1.0f + normalDot;

        return centroidDistance + normalError;
    }
}
