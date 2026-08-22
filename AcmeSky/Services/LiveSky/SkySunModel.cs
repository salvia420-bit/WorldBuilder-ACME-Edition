using System;
using System.Globalization;
using System.Numerics;

namespace AcmeSky.Services.LiveSky {
    /// <summary>
    /// MILESTONE 1 -- sun / moon direction model and the AC->shader axis mapping.
    ///
    /// SUN MODEL (reimplemented, approximating holtburger's sun_direction.js + night_ramp.js):
    ///   time-of-day t in [0,1] (0/1 = deep night, 0.5 = noon; from ClientState.GetTimeOfDay).
    ///   heading = t * 360 deg  (AC heading: 0 = north, CW; so t=.25 -> 90 = east sunrise,
    ///                           t=.5 -> 180 = south noon, t=.75 -> 270 = west sunset).
    ///   elevation01 = sin(2*pi*(t - 0.25))  (-1 at midnight, +1 at noon).
    ///   pitch = elevation01 >= 0 ? elevation01 * NoonPitchDeg
    ///                            : elevation01 * NightFloorDeg
    ///   -> pitch floors at -NightFloorDeg (-14 deg) so the sky can actually go dark at night,
    ///      matching the spec's nightRamp remap of pitch [0.9,20] -> [-14,20], and peaks near
    ///      the Dereth-noon value (~67 deg, per sun_direction.js).
    ///
    /// AC AXIS CONVENTION: AC world space is X=east, Y=north, Z=up. The shader wants a y-up
    /// vector (before the ECEF translate). The canonical AC->shader map is (x,y,z)->(x,z,-y).
    /// The host builds that as a matrix from an env spec so it is swappable at runtime.
    /// </summary>
    internal static class SkySunModel {
        public const float NoonPitchDeg = 67.35f;   // Dereth noon dir_pitch (sun_direction.js)
        public const float NightFloorDeg = 14.0f;   // night_ramp min (pitch floor -14 deg)
        private const float Deg2Rad = MathF.PI / 180f;

        /// <summary>Sun heading/pitch (degrees) for a time-of-day fraction. t &lt; 0 => midday.</summary>
        public static void SunHeadingPitch(float t, out float headingDeg, out float pitchDeg) {
            if (t < 0f) t = 0.5f;                    // no clock -> midday
            headingDeg = t * 360f;
            float elev01 = MathF.Sin(2f * MathF.PI * (t - 0.25f));
            pitchDeg = elev01 >= 0f ? elev01 * NoonPitchDeg : elev01 * NightFloorDeg;
        }

        /// <summary>AC-space unit direction (E,N,U) from heading+pitch (degrees).</summary>
        public static Vector3 DirAc(float headingDeg, float pitchDeg) {
            float h = headingDeg * Deg2Rad, p = pitchDeg * Deg2Rad;
            float cp = MathF.Cos(p), sp = MathF.Sin(p);
            return new Vector3(cp * MathF.Sin(h), cp * MathF.Cos(h), sp);   // (E, N, U)
        }

        /// <summary>
        /// Build the AC(E,N,U) -> shader mapping matrix from a spec like "x,z,-y" (the default,
        /// meaning shader.x=ac.x, shader.y=ac.z, shader.z=-ac.y). Returns identity-embedded 4x4
        /// so mul(float4(v,0), M) in HLSL (row-vector * matrix) yields the mapped vector.
        /// Falls back to the default on any parse error.
        /// </summary>
        public static Matrix4x4 BuildAcToShader(string? spec) {
            var m = new Matrix4x4();   // all zero
            m.M44 = 1f;
            try {
                var parts = (spec ?? "x,z,-y").Split(',');
                if (parts.Length != 3) throw new FormatException("need 3 components");
                for (int k = 0; k < 3; k++) {   // output component k
                    string tok = parts[k].Trim().ToLowerInvariant();
                    float sign = 1f;
                    if (tok.StartsWith("-")) { sign = -1f; tok = tok.Substring(1); }
                    else if (tok.StartsWith("+")) tok = tok.Substring(1);
                    int axis = tok switch { "x" => 0, "y" => 1, "z" => 2, _ => throw new FormatException(tok) };
                    // result.k = sign * ac[axis]  =>  column k of M has 'sign' at row 'axis'.
                    SetElem(ref m, axis, k, sign);
                }
                return m;
            }
            catch {
                // Default (x, z, -y): shader.x=ac.x, shader.y=ac.z, shader.z=-ac.y.
                var d = new Matrix4x4 { M11 = 1f, M23 = -1f, M32 = 1f, M44 = 1f };
                return d;
            }
        }

        private static void SetElem(ref Matrix4x4 m, int row, int col, float v) {
            switch (row * 4 + col) {
                case 0: m.M11 = v; break; case 1: m.M12 = v; break; case 2: m.M13 = v; break;
                case 4: m.M21 = v; break; case 5: m.M22 = v; break; case 6: m.M23 = v; break;
                case 8: m.M31 = v; break; case 9: m.M32 = v; break; case 10: m.M33 = v; break;
            }
        }

        // ==================================================================
        // M3 stars — synthetic game date + sidereal ECI->shader rotation.
        // ==================================================================

        /// <summary>AC launch, 1999-11-02 00:00:00 UTC (holtburger sky.rs AC_LAUNCH_UNIX_EPOCH).</summary>
        public const double AcLaunchUnixEpoch = 941_500_800.0;
        /// <summary>One game-day = 7620 real seconds; game time runs 86400/7620 ≈ 11.34× wall clock.</summary>
        public const double AcTimeCompression = 86400.0 / 7620.0;

        /// <summary>Unix seconds of the synthetic game date (holtburger gameDateNow): wall time
        /// re-anchored at AC launch and compressed 11.34× so the star sphere + moon stay visually
        /// correlated with the AC day instead of drifting at real pace.</summary>
        public static double GameDateUnix() {
            double nowUnix = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
            return AcLaunchUnixEpoch + (nowUnix - AcLaunchUnixEpoch) * AcTimeCompression;
        }

        /// <summary>Greenwich Mean Sidereal Time (IAU 1982) in radians for a unix time.
        /// Matches astronomy-engine's SiderealTime within ~0.004 deg over 2000-2026.</summary>
        public static double GmstRadians(double unixSeconds) {
            double jd = unixSeconds / 86400.0 + 2440587.5;
            double d = jd - 2451545.0;
            double t = d / 36525.0;
            double deg = 280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - t * t * t / 38710000.0;
            deg %= 360.0;
            if (deg < 0) deg += 360.0;
            return deg * Math.PI / 180.0;
        }

        /// <summary>ECI -> shader-space (three y-up) star rotation for the synthetic game date.
        /// Validated against @takram getECIToECEFRotationMatrix (astronomy-engine): the net vector
        /// map is Rz(-GMST) — precession (~0.003 rad here) deliberately dropped. Row-vector
        /// convention: HLSL <c>mul(float4(eci,0), eciToShader)</c>.</summary>
        public static Matrix4x4 EciToShader() {
            float theta = (float)GmstRadians(GameDateUnix());
            return Matrix4x4.CreateRotationZ(-theta);
        }

        /// <summary>Star-visibility fraction from the sky sun pitch (deg): 1 at full night, 0 at
        /// day, linear across sun-altitude [-0.10, +0.10] (holtburger nightFractionFromSunAltitude;
        /// our pitch is already night-ramped to the -14 deg floor).</summary>
        public static float NightFraction(float sunPitchDeg) {
            float sunAlt = MathF.Sin(sunPitchDeg * Deg2Rad);
            float t = (sunAlt + 0.10f) / 0.20f;
            return 1f - Math.Clamp(t, 0f, 1f);
        }

        /// <summary>Parse a float env var with a default and optional clamp.</summary>
        public static float EnvFloat(string name, float def, float lo = float.MinValue, float hi = float.MaxValue) {
            var s = Environment.GetEnvironmentVariable(name);
            if (!string.IsNullOrEmpty(s) &&
                float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v))
                return Math.Clamp(v, lo, hi);
            return def;
        }
    }
}
