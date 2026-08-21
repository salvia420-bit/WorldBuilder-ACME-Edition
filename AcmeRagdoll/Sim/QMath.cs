using System;

namespace AcmeRagdoll.Sim {
    /// <summary>
    /// Quaternion + small-vector helpers, ported 1:1 from the reference sim
    /// (tools/dat-patch/ragdoll_bake.py: qmul / qnorm / quat_from_unit_vectors, which
    /// themselves mirror external/holtburger/apps/holtburger-web/scene3d/ragdoll.js).
    ///
    /// CONVENTION, verified and kept identical across all three implementations:
    ///   * quaternions are (w, x, y, z);
    ///   * <see cref="QMath.Mul"/> is the Hamilton product and applies <c>b</c> first, then <c>a</c>
    ///     (so a composed world orientation is <c>Mul(objectQuat, modelQuat)</c>);
    ///   * AC model space is +Z up, so gravity is along model -Z.
    ///
    /// These are pure managed value-type math with no allocation, safe to call from inside a
    /// native detour on the client's simulation thread.
    /// </summary>
    internal struct Quat {
        public float W, X, Y, Z;
        public Quat(float w, float x, float y, float z) { W = w; X = x; Y = y; Z = z; }
        public static readonly Quat Identity = new(1f, 0f, 0f, 0f);
    }

    internal static class QMath {
        /// <summary>Hamilton product. Result applies <paramref name="b"/> first, then <paramref name="a"/>.</summary>
        public static Quat Mul(in Quat a, in Quat b) => new(
            a.W * b.W - a.X * b.X - a.Y * b.Y - a.Z * b.Z,
            a.W * b.X + a.X * b.W + a.Y * b.Z - a.Z * b.Y,
            a.W * b.Y - a.X * b.Z + a.Y * b.W + a.Z * b.X,
            a.W * b.Z + a.X * b.Y - a.Y * b.X + a.Z * b.W);

        public static Quat Norm(in Quat q) {
            double n = Math.Sqrt((double)q.W * q.W + (double)q.X * q.X + (double)q.Y * q.Y + (double)q.Z * q.Z);
            if (n < 1e-12) return Quat.Identity;
            float inv = (float)(1.0 / n);
            return new Quat(q.W * inv, q.X * inv, q.Y * inv, q.Z * inv);
        }

        public static Quat Conjugate(in Quat q) => new(q.W, -q.X, -q.Y, -q.Z);

        public static float Dot(in Quat a, in Quat b) => a.W * b.W + a.X * b.X + a.Y * b.Y + a.Z * b.Z;

        /// <summary>Rotate vector (vx,vy,vz) by unit quaternion q: v' = q * v * q^-1.</summary>
        public static void Rotate(in Quat q, float vx, float vy, float vz,
                                  out float ox, out float oy, out float oz) {
            // t = 2 * cross(q.xyz, v)
            float tx = 2f * (q.Y * vz - q.Z * vy);
            float ty = 2f * (q.Z * vx - q.X * vz);
            float tz = 2f * (q.X * vy - q.Y * vx);
            // v' = v + q.w * t + cross(q.xyz, t)
            ox = vx + q.W * tx + (q.Y * tz - q.Z * ty);
            oy = vy + q.W * ty + (q.Z * tx - q.X * tz);
            oz = vz + q.W * tz + (q.X * ty - q.Y * tx);
        }

        /// <summary>Inverse of <see cref="Rotate"/> for a unit quaternion: rotate by the conjugate.</summary>
        public static void RotateInverse(in Quat q, float vx, float vy, float vz,
                                         out float ox, out float oy, out float oz) {
            Quat c = Conjugate(q);
            Rotate(c, vx, vy, vz, out ox, out oy, out oz);
        }

        /// <summary>
        /// Shortest-arc rotation taking unit vector a -&gt; unit vector b, as (w,x,y,z).
        /// Ported from ragdoll_bake.quat_from_unit_vectors.
        /// </summary>
        public static Quat FromUnitVectors(float ax, float ay, float az, float bx, float by, float bz) {
            float d = ax * bx + ay * by + az * bz;
            if (d < -0.999999f) {
                // 180 deg: pick any perpendicular axis.
                float px, py, pz;
                if (Math.Abs(ax) < 0.9f) { px = 1f; py = 0f; pz = 0f; }
                else { px = 0f; py = 1f; pz = 0f; }
                float cx = ay * pz - az * py;
                float cy = az * px - ax * pz;
                float cz = ax * py - ay * px;
                return Norm(new Quat(0f, cx, cy, cz));
            }
            float wx = ay * bz - az * by;
            float wy = az * bx - ax * bz;
            float wz = ax * by - ay * bx;
            return Norm(new Quat(1f + d, wx, wy, wz));
        }
    }
}
