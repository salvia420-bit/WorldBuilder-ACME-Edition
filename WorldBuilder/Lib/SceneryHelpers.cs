using DatReaderWriter.Types;
using System;
using System.Collections.Generic;
using System.Numerics;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.Terrain;

namespace WorldBuilder.Lib {
    /// <summary>
    /// Thin wrapper delegating to SceneryAlgorithms in WorldBuilder.Shared.
    /// Kept for backward compatibility with existing UI code references.
    /// </summary>
    public static class SceneryHelpers {
        /// <summary>
        /// Displaces a scenery object into a pseudo-randomized location
        /// </summary>
        public static Vector3 Displace(ObjectDesc obj, uint ix, uint iy, uint iq)
            => SceneryAlgorithms.Displace(obj, ix, iy, iq);

        /// <summary>
        /// Returns the scale for a scenery object
        /// </summary>
        public static float ScaleObj(ObjectDesc obj, uint x, uint y, uint k)
            => SceneryAlgorithms.ScaleObj(obj, x, y, k);

        /// <summary>
        /// Returns the rotation for a scenery object as a Quaternion
        /// </summary>
        public static Quaternion RotateObj(ObjectDesc obj, uint x, uint y, uint k, Vector3 loc)
            => SceneryAlgorithms.RotateObj(obj, x, y, k, loc);

        /// <summary>
        /// Aligns an object to a plane normal, returning Quaternion
        /// </summary>
        public static Quaternion ObjAlign(ObjectDesc obj, Vector3 normal, float z, Vector3 loc)
            => SceneryAlgorithms.ObjAlign(obj, normal, z, loc);

        /// <summary>
        /// Returns true if floor slope is within bounds for this object
        /// </summary>
        public static bool CheckSlope(ObjectDesc obj, float zNormal)
            => SceneryAlgorithms.CheckSlope(obj, zNormal);
    }
}