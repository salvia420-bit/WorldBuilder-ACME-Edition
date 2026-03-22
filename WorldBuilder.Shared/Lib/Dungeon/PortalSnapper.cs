using DatReaderWriter.Types;
using System.Numerics;

namespace WorldBuilder.Shared.Lib.Dungeon;

/// <summary>
/// Higher-level portal snapping API built on top of <see cref="PortalSnapAlgorithms"/>.
/// Moved from WorldBuilder.Editors.Dungeon into the shared layer so that both
/// the UI project and the headless Terminal can use it.
///
/// This class provides the same API surface that existed in
/// WorldBuilder.Editors.Dungeon.PortalSnapper, but with a WorldBuilder.Shared namespace.
/// The UI project's PortalSnapper.cs remains as a backward-compatibility shim.
/// </summary>
public static class PortalSnapper {

    public struct PortalGeometry {
        public Vector3 Centroid;
        public Vector3 Normal;
        public List<Vector3> Vertices;
    }

    /// <summary>
    /// Extract portal polygon geometry from a CellStruct in local space.
    /// </summary>
    public static PortalGeometry? GetPortalGeometry(CellStruct cellStruct, ushort polygonId) {
        var result = PortalSnapAlgorithms.GetPortalGeometry(cellStruct, polygonId);
        if (result == null) return null;
        var r = result.Value;
        return new PortalGeometry { Centroid = r.Centroid, Normal = r.Normal, Vertices = r.Vertices };
    }

    /// <summary>
    /// Find all portal polygon IDs in a CellStruct.
    /// </summary>
    public static List<ushort> GetPortalPolygonIds(CellStruct cellStruct)
        => PortalSnapAlgorithms.GetPortalPolygonIds(cellStruct);

    /// <summary>
    /// Compute the world transform for a new cell so that its source portal
    /// aligns with a target portal on an existing cell.
    /// </summary>
    public static (Vector3 origin, Quaternion orientation) ComputeSnapTransform(
        Vector3 targetCentroidWorld,
        Vector3 targetNormalWorld,
        PortalGeometry sourceGeometryLocal) {

        var sharedGeom = new PortalSnapAlgorithms.PortalGeometry {
            Centroid = sourceGeometryLocal.Centroid,
            Normal = sourceGeometryLocal.Normal,
            Vertices = sourceGeometryLocal.Vertices
        };
        return PortalSnapAlgorithms.ComputeSnapTransform(targetCentroidWorld, targetNormalWorld, sharedGeom);
    }

    /// <summary>
    /// Transform a portal's local-space geometry to world space.
    /// </summary>
    public static (Vector3 centroid, Vector3 normal) TransformPortalToWorld(
        PortalGeometry localGeometry, Vector3 cellOrigin, Quaternion cellOrientation) {

        var sharedGeom = new PortalSnapAlgorithms.PortalGeometry {
            Centroid = localGeometry.Centroid,
            Normal = localGeometry.Normal,
            Vertices = localGeometry.Vertices
        };
        return PortalSnapAlgorithms.TransformPortalToWorld(sharedGeom, cellOrigin, cellOrientation);
    }

    /// <summary>
    /// Pick the source portal that best aligns with the target normal.
    /// </summary>
    public static ushort? PickBestSourcePortal(CellStruct sourceCellStruct, Vector3 targetNormalWorld)
        => PortalSnapAlgorithms.PickBestSourcePortal(sourceCellStruct, targetNormalWorld);
}
