// vendored from /mnt/wbterminal1/ac-refs/rynthsuite/Shared/RynthCore.TerrainData/Vector3Helper.cs @ bf1fb52 on 2026-07-16; upstream is read-only reference
using System;

namespace RynthCore.Plugin.RynthAi.Raycasting
{
    /// <summary>
    /// Custom Vector3 for the raycasting system.
    /// 
    /// IMPORTANT: This replaces System.Numerics.Vector3 in the Raycasting namespace.
    /// All Raycasting/*.cs files must NOT import System.Numerics to avoid type conflicts.
    /// </summary>
    public struct Vector3
    {
        public float X { get; set; }
        public float Y { get; set; }
        public float Z { get; set; }

        public static readonly Vector3 Zero = new Vector3(0, 0, 0);
        public static readonly Vector3 One = new Vector3(1, 1, 1);
        public static readonly Vector3 Up = new Vector3(0, 0, 1);

        public Vector3(float x, float y, float z)
        {
            X = x;
            Y = y;
            Z = z;
        }

        // --- Conversion ---

        public static Vector3 FromNumerics(System.Numerics.Vector3 v)
            => new Vector3(v.X, v.Y, v.Z);

        public System.Numerics.Vector3 ToNumerics()
            => new System.Numerics.Vector3(X, Y, Z);

        public float[] ToArray()
            => new float[] { X, Y, Z };

        public static Vector3 FromArray(float[] arr)
        {
            if (arr == null || arr.Length < 3) return Zero;
            return new Vector3(arr[0], arr[1], arr[2]);
        }

        // --- Arithmetic operators ---

        public static Vector3 operator +(Vector3 a, Vector3 b)
            => new Vector3(a.X + b.X, a.Y + b.Y, a.Z + b.Z);

        public static Vector3 operator -(Vector3 a, Vector3 b)
            => new Vector3(a.X - b.X, a.Y - b.Y, a.Z - b.Z);

        public static Vector3 operator -(Vector3 v)
            => new Vector3(-v.X, -v.Y, -v.Z);

        public static Vector3 operator *(Vector3 v, float s)
            => new Vector3(v.X * s, v.Y * s, v.Z * s);

        public static Vector3 operator *(float s, Vector3 v)
            => new Vector3(v.X * s, v.Y * s, v.Z * s);

        public static Vector3 operator /(Vector3 v, float s)
        {
            float inv = 1.0f / s;
            return new Vector3(v.X * inv, v.Y * inv, v.Z * inv);
        }

        // --- Vector math ---

        public static float Dot(Vector3 a, Vector3 b)
            => a.X * b.X + a.Y * b.Y + a.Z * b.Z;

        public static Vector3 Cross(Vector3 a, Vector3 b)
            => new Vector3(
                a.Y * b.Z - a.Z * b.Y,
                a.Z * b.X - a.X * b.Z,
                a.X * b.Y - a.Y * b.X
            );

        public float Length()
            => (float)Math.Sqrt(X * X + Y * Y + Z * Z);

        public float LengthSquared()
            => X * X + Y * Y + Z * Z;

        public Vector3 Normalize()
        {
            float len = Length();
            if (len < 1e-8f) return Zero;
            return this * (1.0f / len);
        }

        public float Distance(Vector3 other)
            => (this - other).Length();

        public static Vector3 Min(Vector3 a, Vector3 b)
            => new Vector3(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Min(a.Z, b.Z));

        public static Vector3 Max(Vector3 a, Vector3 b)
            => new Vector3(Math.Max(a.X, b.X), Math.Max(a.Y, b.Y), Math.Max(a.Z, b.Z));

        public static Vector3 Lerp(Vector3 a, Vector3 b, float t)
            => a + (b - a) * t;

        public float Length2D()
            => (float)Math.Sqrt(X * X + Y * Y);

        // --- Equality ---

        public override bool Equals(object obj)
        {
            if (obj is Vector3 other)
                return X == other.X && Y == other.Y && Z == other.Z;
            return false;
        }

        public override int GetHashCode()
            => X.GetHashCode() ^ (Y.GetHashCode() << 8) ^ (Z.GetHashCode() << 16);

        public static bool operator ==(Vector3 a, Vector3 b)
            => a.X == b.X && a.Y == b.Y && a.Z == b.Z;

        public static bool operator !=(Vector3 a, Vector3 b)
            => !(a == b);

        public override string ToString()
            => $"({X:F3}, {Y:F3}, {Z:F3})";

        public float this[int i]
        {
            get
            {
                switch (i)
                {
                    case 0: return X;
                    case 1: return Y;
                    case 2: return Z;
                    default: throw new IndexOutOfRangeException();
                }
            }
        }
    }
}
