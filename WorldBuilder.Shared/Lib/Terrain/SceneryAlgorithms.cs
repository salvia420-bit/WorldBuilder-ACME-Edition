using DatReaderWriter.Types;
using System.Numerics;

namespace WorldBuilder.Shared.Lib.Terrain;

/// <summary>
/// Pure algorithmic utilities for computing scenery object transforms.
/// Extracted from WorldBuilder.Lib.SceneryHelpers — no UI dependencies.
///
/// These functions replicate the AC client's pseudo-random placement,
/// scaling, and rotation algorithms for scenery objects.
/// </summary>
public static class SceneryAlgorithms {

    /// <summary>
    /// Displaces a scenery object into a pseudo-randomized location,
    /// matching the AC client's algorithm.
    /// </summary>
    public static Vector3 Displace(ObjectDesc obj, uint ix, uint iy, uint iq) {
        float x;
        float y;
        float z = obj.BaseLoc.Origin.Z;
        var loc = obj.BaseLoc;

        if (obj.DisplaceX <= 0)
            x = loc.Origin.X;
        else
            x = (float)((1813693831 * iy - (iq + 45773) * (1360117743 * iy * ix + 1888038839) - 1109124029 * ix)
                * 2.3283064e-10 * obj.DisplaceX + loc.Origin.X);

        if (obj.DisplaceY <= 0)
            y = loc.Origin.Y;
        else
            y = (float)((1813693831 * iy - (iq + 72719) * (1360117743 * iy * ix + 1888038839) - 1109124029 * ix)
                * 2.3283064e-10 * obj.DisplaceY + loc.Origin.Y);

        var quadrant = (1813693831 * iy - ix * (1870387557 * iy + 1109124029) - 402451965) * 2.3283064e-10f;

        if (quadrant >= 0.75) return new Vector3(y, -x, z);
        if (quadrant >= 0.5) return new Vector3(-x, -y, z);
        if (quadrant >= 0.25) return new Vector3(-y, x, z);
        return new Vector3(x, y, z);
    }

    /// <summary>
    /// Returns the scale for a scenery object using the AC client's pseudo-random algorithm.
    /// </summary>
    public static float ScaleObj(ObjectDesc obj, uint x, uint y, uint k) {
        var minScale = obj.MinScale;
        var maxScale = obj.MaxScale;

        if (minScale == maxScale)
            return maxScale;

        return (float)(Math.Pow(maxScale / minScale,
            (1813693831 * y - (k + 32593) * (1360117743 * y * x + 1888038839) - 1109124029 * x) * 2.3283064e-10) * minScale);
    }

    /// <summary>
    /// Returns the rotation for a scenery object as a Quaternion.
    /// Z-up coordinate system: rotation around Z-axis (heading).
    /// </summary>
    public static Quaternion RotateObj(ObjectDesc obj, uint x, uint y, uint k, Vector3 loc) {
        if (obj.MaxRotation <= 0.0f)
            return Quaternion.Identity;

        var degrees = (float)((1813693831 * y - (k + 63127) * (1360117743 * y * x + 1888038839) - 1109124029 * x)
            * 2.3283064e-10 * obj.MaxRotation);
        var radians = degrees * MathF.PI / 180f;

        return Quaternion.CreateFromAxisAngle(Vector3.UnitZ, radians);
    }

    /// <summary>
    /// Aligns an object to a terrain normal, returning a Quaternion.
    /// Z-up coordinate system: aligns object's Z-axis with terrain normal.
    /// </summary>
    public static Quaternion ObjAlign(ObjectDesc obj, Vector3 normal, float z, Vector3 loc) {
        var up = Vector3.UnitZ;

        if (Vector3.Dot(normal, up) > 0.9999f)
            return Quaternion.Identity;

        if (Vector3.Dot(normal, up) < -0.9999f)
            return Quaternion.CreateFromAxisAngle(Vector3.UnitX, MathF.PI);

        var axis = Vector3.Normalize(Vector3.Cross(up, normal));
        var angle = MathF.Acos(Vector3.Dot(up, normal));

        return Quaternion.CreateFromAxisAngle(axis, angle);
    }

    /// <summary>
    /// Returns true if floor slope is within bounds for this object.
    /// </summary>
    public static bool CheckSlope(ObjectDesc obj, float zNormal) {
        return zNormal >= obj.MinSlope && zNormal <= obj.MaxSlope;
    }
}
