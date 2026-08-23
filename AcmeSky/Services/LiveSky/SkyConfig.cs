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
    ///   live      0/1    MASTER PATH SELECT. 1 (default) = the takram volumetric compositor;
    ///                    0 = the primitive baked-dome fallback. This used to be an ENV-ONLY
    ///                    knob (ACMESKY_LIVE=1) which the injected client never inherited, so
    ///                    every deployed build silently ran the fallback.
    ///   testgradient 0/1 baked path only: 1 draws a hardcoded orange/blue diagnostic band
    ///                    instead of the palette. Default 0 (it used to default ON).
    ///   skytimeoverride  0..1 forced time-of-day, -1 = live game clock. Alias: `time`.
    ///                    Hot-reloaded on BOTH paths (the vanilla ACE clock cannot be set, so
    ///                    this is the only way to screenshot noon/dusk/night on demand).
    ///   skyweatheroverride  clear|scattered|broken|overcast|rain|storm, or `auto` (default).
    ///                    Picks the baked palette AND forces the live path's FAIR/STORM look.
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
    public sealed class SkyConfig {
        // --- master path select + diagnostics (were ENV-ONLY; see the class remarks) ---------
        /// <summary>1 = takram volumetric live compositor (the real sky), 0 = baked-dome fallback.</summary>
        public float LiveMode = 1f;
        /// <summary>1 = baked path draws the hardcoded diagnostic gradient instead of the palette.</summary>
        public float TestGradient;
        /// <summary>1 = throttled per-second frame logging.</summary>
        public float Diag = 1f;
        /// <summary>Weather-class override for the palette / FAIR-vs-STORM look; "" or "auto" = live.</summary>
        public string WeatherClass = "";

        public float RayMode;
        public string Axis = "x,z,-y";
        public float Output;
        public float Exposure;
        public float SunAng, MoonAng, Lunar, LutFlipV;
        public float ForcedTime;   // <0 => use game clock
        public float WorldSwizzle; // 1 = swizzle reconstructed ray/camera .xzy (render world is Y-up)
        public float TimeOfs;      // phase shift added to the CLOCK-derived time (mod 1); not applied to forced time
        public float Stars = 1f;   // star-field base intensity (0 = off); night fade applies on top
        public float Clouds = 1f;      // volumetric clouds on/off
        public float CloudCover = 0.5f; // takram coverage (holtburger FAIR = 0.5)
        public float CloudCoverStorm = 0.55f; // coverage under the STORM look (cloud_storm_look.js)
        public float CloudIters = 500f; // primary raymarch iteration cap (takram high preset)
        public float CloudRes = 1f;     // cloud RT resolution scale (of the main viewport)
        public float CloudMinStep = 10f;   // takram ULTRA (owner default 2026-08-22; measured free vs 50 on the 1070)
        public float CloudSunSteps = 2f;   // secondary sun march iterations
        public float CloudGroundSteps = 3f;// ground-bounce march iterations (0 = off)
        public float CloudAccurate = 1f;   // 1 = ACCURATE_SUN_SKY_LIGHT (per-sample irradiance)
        public float CloudTurb = 1f;       // 1 = TURBULENCE displacement
        public float CloudHaze = 1f;       // 1 = takram haze (3e-5 fair / 3e-4 storm)
        public float CloudTaa = 0f;        // 1 = temporal resolve (takram cloudsResolve TAA path).
                                           // DEFAULT OFF 2026-08-22: the resolve shows vertical slab
                                           // sections through cumulus (reprojection velocity bug, live
                                           // A/B vs the raw march) — fix the velocity before re-enabling.
        public float CloudTaaGamma = 1f;   // variance-clipping gamma (takram TAA default 1)
        public float CloudTaaAlpha = 0.1f; // current-frame blend weight (holtburger temporalAlpha)
        public string WxMap = "nasa";      // local weather map: default | nasa | dereth (init-time)
        public float Storm = -1f;          // -1 = auto (client weather flag), 0 = force fair, 1 = force storm
        public float Dump;                 // >0: write one skydump-N.bmp per second (rotating 8) to C:\Temp\acdt
        public float CamPitch;             // deg: extra camera pitch applied to the SKY matrices (capture aid; 0 = off)

        private static readonly string[] CandidatePaths = BuildCandidatePaths();
        public string? LoadedFrom;

        /// <summary>Seed from the corrected defaults, then env-var overrides (dev box only).</summary>
        public static SkyConfig FromDefaultsAndEnv() {
            var c = new SkyConfig {
                // raymode 0 = row-vector both — CORRECT (CPU-replica-verified 2026-08-21). The
                // 90-degrees-rolled sky + the "scattering seam" were BOTH the missing world
                // swizzle: the client's D3D render world is the AC world with y/z swapped
                // (PrimD3DRender::ScreenToViewTransform). worldswizzle=1 fixes both.
                RayMode = 0f,
                WorldSwizzle = 1f,
                Axis = Environment.GetEnvironmentVariable("ACMESKY_SKY_AXIS") ?? "x,z,-y",
                Output = 0f,              // real atmosphere (AgX + sRGB)
                Exposure = SkySunModel.EnvFloat("ACMESKY_SKY_EXPOSURE", 5f, 0.01f, 100f),
                SunAng = SkySunModel.EnvFloat("ACMESKY_SKY_SUNANG", 0.03f, 0.0005f, 0.5f),
                MoonAng = SkySunModel.EnvFloat("ACMESKY_SKY_MOONANG", 0.025f, 0.0005f, 0.5f),
                Lunar = SkySunModel.EnvFloat("ACMESKY_SKY_LUNAR", 1f, 0f, 100f),
                LutFlipV = SkySunModel.EnvFloat("ACMESKY_SKY_LUTFLIPV", 0f, 0f, 1f),
                ForcedTime = SkySunModel.EnvFloat("ACMESKY_SKY_TIME", -1f, -1f, 1f),
            };
            c.RayMode = SkySunModel.EnvFloat("ACMESKY_SKY_RAYMODE", c.RayMode, 0f, 9f);
            c.Output = SkySunModel.EnvFloat("ACMESKY_SKY_OUTPUT", c.Output, 0f, 9f);
            // Path/diag knobs: env is still honoured on the dev box, but the DEFAULTS are now the
            // shipping ones (live on, test gradient off) because the injected client inherits no env.
            c.LiveMode = EnvBool("ACMESKY_LIVE", c.LiveMode);
            c.TestGradient = EnvBool("ACMESKY_TESTGRADIENT", c.TestGradient);
            c.Diag = EnvBool("ACMESKY_DIAG", c.Diag);
            c.WeatherClass = Environment.GetEnvironmentVariable("ACMESKY_WEATHER") ?? c.WeatherClass;
            return c;
        }

        /// <summary>Env override for a 0/1 knob: "0"/"off"/"false" =&gt; 0, "1"/"on"/"true" =&gt; 1,
        /// anything else (including unset) keeps <paramref name="dflt"/>.</summary>
        private static float EnvBool(string name, float dflt) {
            var s = Environment.GetEnvironmentVariable(name);
            if (string.IsNullOrEmpty(s)) return dflt;
            s = s.Trim().ToLowerInvariant();
            if (s is "0" or "off" or "false" or "no") return 0f;
            if (s is "1" or "on" or "true" or "yes") return 1f;
            return dflt;
        }

        /// <summary>The six baked palette classes, in increasing overcast order.</summary>
        public static readonly string[] WeatherClasses =
            { "clear", "scattered", "broken", "overcast", "rain", "storm" };

        /// <summary>True when <paramref name="cls"/> is a recognised palette class name.</summary>
        public static bool IsWeatherClass(string cls) =>
            Array.IndexOf(WeatherClasses, cls) >= 0;

        /// <summary>
        /// Resolve the effective weather class. Priority: `skyweatheroverride` -&gt; the explicit
        /// `storm` knob -&gt; the client's own weather flag (GameSky::s_weatherEnabled, which the
        /// retail sky uses as its is_storm signal).
        /// </summary>
        public string ResolveWeatherClass(bool clientWeatherFlag) {
            if (IsWeatherClass(WeatherClass)) return WeatherClass;
            if (Storm > 0.5f) return "storm";
            if (Storm >= -0.5f) return "clear";        // storm = 0 forces fair
            return clientWeatherFlag ? "storm" : "clear";
        }

        /// <summary>The FAIR/STORM boolean the live cloud shader wants, from the resolved class.</summary>
        public bool ResolveStorm(bool clientWeatherFlag) {
            string cls = ResolveWeatherClass(clientWeatherFlag);
            return cls is "overcast" or "rain" or "storm";
        }

        /// <summary>
        /// The writable scratch dir the ACME plugins share on the client box
        /// (<c>C:\Temp\acdt</c>, the same place sky.cfg / ragdoll.cfg / skydump-N.bmp live).
        /// Falls back to the user profile when that path is not creatable (e.g. a dev-box run).
        /// </summary>
        public static string AcdtDir() {
            try {
                const string acdt = @"C:\Temp\acdt";
                if (Directory.Exists(acdt)) return acdt;
                Directory.CreateDirectory(acdt);
                return acdt;
            }
            catch {
                try {
                    string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                    string dir = Path.Combine(home, ".acdt");
                    Directory.CreateDirectory(dir);
                    return dir;
                }
                catch { return Path.GetTempPath(); }
            }
        }

        /// <summary>
        /// Crash sentinel for the LIVE path. The D3D11 -&gt; CPU readback -&gt; D3D9 upload sequence has a
        /// history of faulting NATIVELY under DXVK (2026-08-22: "page fault on write access ... at
        /// 656DB910"), which no managed catch can intercept -- the client just dies. Since `live` now
        /// defaults ON, an unfixed fault there would be a boot-crash LOOP. So the compositor drops
        /// this file before its first upload and removes it once it has survived a few hundred
        /// composites; if it is still present at the next startup, the previous run died inside the
        /// live path and we boot into the baked fallback instead. Delete it (or set `live = 1`
        /// explicitly after fixing the cause) to re-arm.
        /// </summary>
        public static string LiveProbePath() => Path.Combine(AcdtDir(), "acmesky-live-crashed.flag");

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

        // ── PACING (2026-08-23) ──────────────────────────────────────────────────────────────────
        // Reload() is File.Exists over the candidates + File.ReadAllLines + a Trim/Substring/
        // ToLowerInvariant per line, and LiveSkyCompositor calls it ONCE A SECOND ON THE RENDER
        // THREAD. That is a file read plus ~50 string allocations landing in one frame out of every
        // ~60-100 — i.e. it lands squarely in the 1% lows. Same 1 Hz responsiveness, but a second now
        // costs ONE stat unless sky.cfg actually changed.
        private string? _activePath;
        private DateTime _activeStamp;

        /// <summary>Re-read only if the loaded file's mtime moved. Returns true when values were
        /// actually re-applied (so the caller's rebuild work also stops running every second).
        /// Never throws.</summary>
        public bool ReloadIfChanged() {
            string? p = _activePath;
            if (p != null) {
                DateTime t;
                try { t = File.GetLastWriteTimeUtc(p); }
                catch { t = default; }
                if (t == _activeStamp) return false;
            }
            return Reload();
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
                        string val = StripInlineComment(s.Substring(eq + 1));
                        if (val.Length == 0) continue;
                        Apply(key, val);
                    }
                    LoadedFrom = path;
                    _activePath = path;
                    try { _activeStamp = File.GetLastWriteTimeUtc(path); } catch { _activeStamp = default; }
                    return true;
                }
                catch { /* keep current values */ }
            }
            _activePath = null;
            return false;
        }

        /// <summary>
        /// Trim a TRAILING '#' / ';' comment off a value.
        ///
        /// THE 2026-08-23 "sky.cfg does nothing" BUG. This used to be a bare <c>.Trim()</c>, so
        /// <c>skytimeoverride = 0.5    # 0..1 forced time of day</c> produced the value
        /// <c>"0.5    # 0..1 forced time of day"</c>; every numeric key runs through
        /// <see cref="F"/> =&gt; <c>float.TryParse</c>, which fails on that, and <see cref="Apply"/>
        /// then does NOTHING -- silently, with no log. Since sky.cfg.example documents every key
        /// with exactly that inline-comment style, a config copied from it had EVERY key ignored:
        /// the plugin ran on defaults while appearing to be configured. (It is why `live` came up
        /// 1 -- the new default -- rather than from the file, and why `skytimeoverride = 0.5` did
        /// not force noon.) String keys (`axis`, `wxmap`, `skyweatheroverride`) were corrupted the
        /// same way, just without a parse to fail loudly.
        /// </summary>
        private static string StripInlineComment(string raw) {
            int c = raw.IndexOfAny(CommentChars);
            return (c >= 0 ? raw.Substring(0, c) : raw).Trim();
        }
        private static readonly char[] CommentChars = { '#', ';' };

        /// <summary>The hot keys, as a compact string, so a caller can log ONLY when a reload
        /// actually changed something the viewer would see.</summary>
        public string HotSignature() =>
            $"live={LiveMode:0.##} testgradient={TestGradient:0.##} diag={Diag:0.##} " +
            $"time={ForcedTime:0.###} weather={(string.IsNullOrEmpty(WeatherClass) ? "auto" : WeatherClass)} " +
            $"storm={Storm:0.##} clouds={Clouds:0.##} cover={CloudCover:0.##} iters={CloudIters:0} " +
            $"res={CloudRes:0.##} minstep={CloudMinStep:0.#} exposure={Exposure:0.##} stars={Stars:0.##}";

        private void Apply(string key, string val) {
            switch (key) {
                // --- master path select / diagnostics ---
                case "live": if (F(val, out var lv)) LiveMode = Math.Clamp(lv, 0f, 1f); break;
                case "testgradient": if (F(val, out var tg)) TestGradient = Math.Clamp(tg, 0f, 1f); break;
                case "diag": if (F(val, out var dg)) Diag = Math.Clamp(dg, 0f, 1f); break;
                // --- screenshot overrides (the ACE clock cannot be set, so these are the only lever) ---
                case "skytimeoverride": if (F(val, out var sto)) ForcedTime = Math.Clamp(sto, -1f, 1f); break;
                case "skyweatheroverride":
                case "weather": {
                    // First whitespace-delimited token only, so a stray trailing word cannot turn
                    // the value into an unrecognised class that silently falls back to auto.
                    string v = val.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
                                  is { Length: > 0 } parts ? parts[0].ToLowerInvariant() : "";
                    WeatherClass = (v is "" or "auto" or "-1" or "live" or "off") ? "" : v;
                    break;
                }
                case "axis": Axis = val; break;
                case "raymode": if (F(val, out var rm)) RayMode = Math.Clamp(rm, 0f, 9f); break;
                case "output": if (F(val, out var o)) Output = Math.Clamp(o, 0f, 9f); break;   // 6 = clouds-only, 7 AP-inscatter, 8 AP-transmittance, 9 front-depth
                case "exposure": if (F(val, out var e)) Exposure = Math.Clamp(e, 0.01f, 100f); break;
                case "time": if (F(val, out var t)) ForcedTime = Math.Clamp(t, -1f, 1f); break;
                case "sunang": if (F(val, out var sa)) SunAng = Math.Clamp(sa, 0.0005f, 0.5f); break;
                case "moonang": if (F(val, out var ma)) MoonAng = Math.Clamp(ma, 0.0005f, 0.5f); break;
                case "lunar": if (F(val, out var l)) Lunar = Math.Clamp(l, 0f, 100f); break;
                case "lutflipv": if (F(val, out var lf)) LutFlipV = Math.Clamp(lf, 0f, 1f); break;
                case "worldswizzle": if (F(val, out var ws)) WorldSwizzle = Math.Clamp(ws, 0f, 1f); break;
                case "timeofs": if (F(val, out var to)) TimeOfs = Math.Clamp(to, -1f, 1f); break;
                case "stars": if (F(val, out var st)) Stars = Math.Clamp(st, 0f, 10f); break;
                case "clouds": if (F(val, out var cl)) Clouds = Math.Clamp(cl, 0f, 1f); break;
                case "cloudcover": if (F(val, out var cc)) CloudCover = Math.Clamp(cc, 0f, 1f); break;
                case "cloudcoverstorm": if (F(val, out var cs2)) CloudCoverStorm = Math.Clamp(cs2, 0f, 1f); break;
                case "clouditers": if (F(val, out var ci)) CloudIters = Math.Clamp(ci, 0f, 500f); break;
                case "cloudres": if (F(val, out var cr)) CloudRes = Math.Clamp(cr, 0.1f, 1f); break;
                case "cloudminstep": if (F(val, out var cm)) CloudMinStep = Math.Clamp(cm, 5f, 500f); break;
                case "cloudsunsteps": if (F(val, out var cu)) CloudSunSteps = Math.Clamp(cu, 0f, 4f); break;
                case "cloudgroundsteps": if (F(val, out var cg)) CloudGroundSteps = Math.Clamp(cg, 0f, 4f); break;
                case "cloudaccurate": if (F(val, out var ca)) CloudAccurate = Math.Clamp(ca, 0f, 1f); break;
                case "cloudturb": if (F(val, out var ct)) CloudTurb = Math.Clamp(ct, 0f, 1f); break;
                case "cloudhaze": if (F(val, out var ch)) CloudHaze = Math.Clamp(ch, 0f, 1f); break;
                case "cloudtaa": if (F(val, out var cta)) CloudTaa = Math.Clamp(cta, 0f, 1f); break;
                case "cloudtaagamma": if (F(val, out var ctg)) CloudTaaGamma = Math.Clamp(ctg, 0.1f, 64f); break;
                case "cloudtaaalpha": if (F(val, out var ctl)) CloudTaaAlpha = Math.Clamp(ctl, 0.01f, 1f); break;
                case "wxmap": WxMap = val.ToLowerInvariant(); break;   // default | nasa | dereth (init-time)
                case "storm": if (F(val, out var sm)) Storm = Math.Clamp(sm, -1f, 1f); break;
                case "dump": if (F(val, out var dp)) Dump = Math.Clamp(dp, 0f, 1f); break;
                case "campitch": if (F(val, out var cp)) CamPitch = Math.Clamp(cp, -89f, 89f); break;
            }
        }

        private static bool F(string s, out float v) =>
            float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v);
    }
}
