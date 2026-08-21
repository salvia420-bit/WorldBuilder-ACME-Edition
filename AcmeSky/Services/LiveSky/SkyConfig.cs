using System;
using System.Globalization;
using System.IO;

namespace AcmeSky.Services.LiveSky {
    /// <summary>
    /// MILESTONE 1 tuning knobs, read from a plain-text file so they can be changed on the live
    /// client WITHOUT a rebuild and WITHOUT environment variables (the injected acclient process does
    /// not reliably inherit the launcher .bat's `set` vars). The file is re-read once per second, so
    /// edits take effect live in-game.
    ///
    /// File location (first that exists, checked each reload):
    ///   C:\Temp\acdt\sky.cfg   then   C:\Temp\acdt\skyaxis.txt
    /// (also honoured on the dev box via the ACMESKY_SKY_CONFIG path, or ~/.acdt/sky.cfg).
    ///
    /// Format: `key = value`, one per line, '#' or ';' comments. Keys (case-insensitive):
    ///   raymode   0..3   ray reconstruction convention (see AtmosphereShader):
    ///                    0 row-vector both, 1 transpose invProj [default], 2 transpose invView, 3 both
    ///   axis      e.g. x,z,-y   AC(E,N,U)->shader map (each of 3 out comps = +/-{x,y,z})
    ///   output    0 AgX+sRGB, 1 AgX linear, 2 raw exposure, 3 exposure+sRGB no-AgX,
    ///             4 ray-dir(AC) debug, 5 ray-dir(shader) debug   [default 4 this diagnostic build]
    ///   exposure  float (default 5)
    ///   time      0..1 forced time-of-day, or &lt;0 to use the game clock (noon fallback)  [default -1]
    ///   sunang / moonang / lunar / lutflipv   disc + LUT knobs
    ///
    /// Defaults are the corrected out-of-the-box values; env vars (ACMESKY_SKY_*) still override
    /// defaults on the dev box, and the file overrides everything.
    /// </summary>
    internal sealed class SkyConfig {
        public float RayMode;
        public string Axis = "x,z,-y";
        public float Output;
        public float Exposure;
        public float SunAng, MoonAng, Lunar, LutFlipV;
        public float ForcedTime;   // <0 => use game clock

        private static readonly string[] CandidatePaths = BuildCandidatePaths();
        public string? LoadedFrom;

        /// <summary>Seed from the corrected defaults, then env-var overrides (dev box only).</summary>
        public static SkyConfig FromDefaultsAndEnv() {
            var c = new SkyConfig {
                // raymode 0 = row-vector both, the convention AcmeRedline/Lib/Projection.cs VERIFIES for
                // AC's forward transform (clip = [x y z 1]*WorldToView*ViewToClip). The 90-degrees-rolled
                // sky is NOT a matrix transpose -- it is the acToShader up-axis (below). Keep raymode 0.
                RayMode = 0f,
                Axis = Environment.GetEnvironmentVariable("ACMESKY_SKY_AXIS") ?? "x,z,-y",
                Output = 4f,              // ray-dir debug: default for this diagnostic build
                Exposure = SkySunModel.EnvFloat("ACMESKY_SKY_EXPOSURE", 5f, 0.01f, 100f),
                SunAng = SkySunModel.EnvFloat("ACMESKY_SKY_SUNANG", 0.03f, 0.0005f, 0.5f),
                MoonAng = SkySunModel.EnvFloat("ACMESKY_SKY_MOONANG", 0.025f, 0.0005f, 0.5f),
                Lunar = SkySunModel.EnvFloat("ACMESKY_SKY_LUNAR", 1f, 0f, 100f),
                LutFlipV = SkySunModel.EnvFloat("ACMESKY_SKY_LUTFLIPV", 0f, 0f, 1f),
                ForcedTime = SkySunModel.EnvFloat("ACMESKY_SKY_TIME", -1f, -1f, 1f),
            };
            c.RayMode = SkySunModel.EnvFloat("ACMESKY_SKY_RAYMODE", c.RayMode, 0f, 9f);
            c.Output = SkySunModel.EnvFloat("ACMESKY_SKY_OUTPUT", c.Output, 0f, 5f);
            return c;
        }

        private static string[] BuildCandidatePaths() {
            string? envPath = Environment.GetEnvironmentVariable("ACMESKY_SKY_CONFIG");
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return new[] {
                envPath ?? "",
                @"C:\Temp\acdt\sky.cfg",
                @"C:\Temp\acdt\skyaxis.txt",
                Path.Combine(home, ".acdt", "sky.cfg"),
            };
        }

        /// <summary>Re-read the config file over the current values. Returns true if a file was read
        /// (whether or not values changed). Never throws.</summary>
        public bool Reload() {
            foreach (var path in CandidatePaths) {
                if (string.IsNullOrEmpty(path)) continue;
                try {
                    if (!File.Exists(path)) continue;
                    foreach (var line in File.ReadAllLines(path)) {
                        var s = line.Trim();
                        if (s.Length == 0 || s[0] == '#' || s[0] == ';') continue;
                        int eq = s.IndexOf('=');
                        if (eq <= 0) continue;
                        string key = s.Substring(0, eq).Trim().ToLowerInvariant();
                        string val = s.Substring(eq + 1).Trim();
                        Apply(key, val);
                    }
                    LoadedFrom = path;
                    return true;
                }
                catch { /* keep current values */ }
            }
            return false;
        }

        private void Apply(string key, string val) {
            switch (key) {
                case "axis": Axis = val; break;
                case "raymode": if (F(val, out var rm)) RayMode = Math.Clamp(rm, 0f, 9f); break;
                case "output": if (F(val, out var o)) Output = Math.Clamp(o, 0f, 5f); break;
                case "exposure": if (F(val, out var e)) Exposure = Math.Clamp(e, 0.01f, 100f); break;
                case "time": if (F(val, out var t)) ForcedTime = Math.Clamp(t, -1f, 1f); break;
                case "sunang": if (F(val, out var sa)) SunAng = Math.Clamp(sa, 0.0005f, 0.5f); break;
                case "moonang": if (F(val, out var ma)) MoonAng = Math.Clamp(ma, 0.0005f, 0.5f); break;
                case "lunar": if (F(val, out var l)) Lunar = Math.Clamp(l, 0f, 100f); break;
                case "lutflipv": if (F(val, out var lf)) LutFlipV = Math.Clamp(lf, 0f, 1f); break;
            }
        }

        private static bool F(string s, out float v) =>
            float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v);
    }
}
