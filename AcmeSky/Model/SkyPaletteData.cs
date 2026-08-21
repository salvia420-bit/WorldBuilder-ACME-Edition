using System;
using System.Collections.Generic;
using System.Numerics;
using System.Text.Json.Serialization;

namespace AcmeSky.Model {
    /// <summary>
    /// One time-of-day keyframe from a skytime_&lt;class&gt;.json palette (buildbox Bruneton bake).
    /// dir_* / amb_* come from real Bruneton transmittance/irradiance LUTs; fog_color is the
    /// analytic Rayleigh+sun blend. Field names map to the JSON via [JsonPropertyName].
    /// </summary>
    public sealed class SkyKeyframe {
        [JsonPropertyName("time")] public float Time { get; set; }
        [JsonPropertyName("sun_elevation_deg")] public float SunElevationDeg { get; set; }
        [JsonPropertyName("dir_color")] public float[]? DirColor { get; set; }
        [JsonPropertyName("dir_bright")] public float DirBright { get; set; }
        [JsonPropertyName("amb_color")] public float[]? AmbColor { get; set; }
        [JsonPropertyName("amb_bright")] public float AmbBright { get; set; }
        [JsonPropertyName("fog_color")] public float[]? FogColor { get; set; }
        [JsonPropertyName("fog_min")] public float FogMin { get; set; }
        [JsonPropertyName("fog_max")] public float FogMax { get; set; }
    }

    /// <summary>A full skytime_&lt;class&gt;.json: an ordered list of keyframes over the 0..1 day.</summary>
    public sealed class SkyPaletteData {
        [JsonPropertyName("class")] public string? Class { get; set; }
        [JsonPropertyName("keyframes")] public List<SkyKeyframe> Keyframes { get; set; } = new();

        /// <summary>The interpolated atmosphere sample for a given 0..1 time-of-day.</summary>
        public readonly struct Sample {
            public readonly Vector3 DirColor;    // sun/directional tint
            public readonly float DirBright;
            public readonly Vector3 AmbColor;    // ambient/zenith tint
            public readonly float AmbBright;
            public readonly Vector3 FogColor;    // horizon/aerial haze tint
            public readonly float SunElevationDeg;
            public Sample(Vector3 dir, float dirB, Vector3 amb, float ambB, Vector3 fog, float sunEl) {
                DirColor = dir; DirBright = dirB; AmbColor = amb; AmbBright = ambB;
                FogColor = fog; SunElevationDeg = sunEl;
            }
        }

        /// <summary>Linear-interpolate the palette at 0..1 time-of-day (wraps across midnight).</summary>
        public Sample At(float t) {
            if (Keyframes.Count == 0) return default;
            if (Keyframes.Count == 1) return Of(Keyframes[0]);

            t = t - MathF.Floor(t); // wrap into [0,1)

            // Find bracketing keyframes; handle wrap between last and first.
            SkyKeyframe a = Keyframes[^1], b = Keyframes[0];
            float ta = a.Time, tb = b.Time + 1f, tt = t + (t < Keyframes[0].Time ? 1f : 0f);
            bool found = false;
            for (int i = 0; i < Keyframes.Count - 1; i++) {
                if (t >= Keyframes[i].Time && t <= Keyframes[i + 1].Time) {
                    a = Keyframes[i]; b = Keyframes[i + 1];
                    ta = a.Time; tb = b.Time; tt = t; found = true; break;
                }
            }
            if (!found) {
                // wrap segment: last -> first(+1)
                a = Keyframes[^1]; b = Keyframes[0];
                ta = a.Time; tb = b.Time + 1f; tt = t < Keyframes[0].Time ? t + 1f : t;
            }
            float span = MathF.Max(1e-6f, tb - ta);
            float f = Math.Clamp((tt - ta) / span, 0f, 1f);
            return Lerp(Of(a), Of(b), f);
        }

        private static Sample Of(SkyKeyframe k) => new(
            V(k.DirColor), k.DirBright, V(k.AmbColor), k.AmbBright, V(k.FogColor), k.SunElevationDeg);

        private static Sample Lerp(Sample a, Sample b, float f) => new(
            Vector3.Lerp(a.DirColor, b.DirColor, f), a.DirBright + (b.DirBright - a.DirBright) * f,
            Vector3.Lerp(a.AmbColor, b.AmbColor, f), a.AmbBright + (b.AmbBright - a.AmbBright) * f,
            Vector3.Lerp(a.FogColor, b.FogColor, f), a.SunElevationDeg + (b.SunElevationDeg - a.SunElevationDeg) * f);

        private static Vector3 V(float[]? c) =>
            c is { Length: >= 3 } ? new Vector3(c[0], c[1], c[2]) : Vector3.Zero;
    }
}
