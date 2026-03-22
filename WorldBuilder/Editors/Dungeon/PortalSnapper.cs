using DatReaderWriter.Enums;
using DatReaderWriter.Types;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using SharedPortalSnapper = WorldBuilder.Shared.Lib.Dungeon.PortalSnapper;

namespace WorldBuilder.Editors.Dungeon {
    /// <summary>
    /// Backward-compatibility shim — delegates entirely to
    /// <see cref="WorldBuilder.Shared.Lib.Dungeon.PortalSnapper"/>.
    /// Existing UI code can continue to reference this class unchanged.
    /// New code should prefer the shared version directly.
    /// </summary>
    [Obsolete("Use WorldBuilder.Shared.Lib.Dungeon.PortalSnapper directly.")]
    public static class PortalSnapper {

        public struct PortalGeometry {
            public Vector3 Centroid;
            public Vector3 Normal;
            public List<Vector3> Vertices;
        }

        public static PortalGeometry? GetPortalGeometry(CellStruct cellStruct, ushort polygonId) {
            var result = SharedPortalSnapper.GetPortalGeometry(cellStruct, polygonId);
            if (result == null) return null;
            var r = result.Value;
            return new PortalGeometry { Centroid = r.Centroid, Normal = r.Normal, Vertices = r.Vertices };
        }

        public static List<ushort> GetPortalPolygonIds(CellStruct cellStruct)
            => SharedPortalSnapper.GetPortalPolygonIds(cellStruct);

        public static (Vector3 origin, Quaternion orientation) ComputeSnapTransform(
            Vector3 targetCentroidWorld,
            Vector3 targetNormalWorld,
            PortalGeometry sourceGeometryLocal) {

            var sharedGeom = new SharedPortalSnapper.PortalGeometry {
                Centroid = sourceGeometryLocal.Centroid,
                Normal = sourceGeometryLocal.Normal,
                Vertices = sourceGeometryLocal.Vertices
            };
            return SharedPortalSnapper.ComputeSnapTransform(targetCentroidWorld, targetNormalWorld, sharedGeom);
        }

        public static (Vector3 centroid, Vector3 normal) TransformPortalToWorld(
            PortalGeometry localGeometry, Vector3 cellOrigin, Quaternion cellOrientation) {

            var sharedGeom = new SharedPortalSnapper.PortalGeometry {
                Centroid = localGeometry.Centroid,
                Normal = localGeometry.Normal,
                Vertices = localGeometry.Vertices
            };
            return SharedPortalSnapper.TransformPortalToWorld(sharedGeom, cellOrigin, cellOrientation);
        }

        public static ushort? PickBestSourcePortal(CellStruct sourceCellStruct, Vector3 targetNormalWorld)
            => SharedPortalSnapper.PickBestSourcePortal(sourceCellStruct, targetNormalWorld);
    }
}
