using System;
using System.Globalization;
using System.IO;

namespace AcmeLights.Lib {
    /// <summary>
    /// Live tuning knobs, re-read once per second from a plain-text file (same mechanism as
    /// AcmeSky's sky.cfg — the injected acclient does not inherit launcher env vars).
    ///
    /// File: first existing of  C:\Temp\acdt\lights.cfg  ·  %USERPROFILE%\.acdt\lights.cfg.
    /// Format `key = value`, '#'/';' comments. Keys are documented next to their fields.
    /// </summary>
    internal sealed class LightsConfig {
        // --- Phase 1: pool caps + global knobs (0 = leave the retail value alone) ---
        public float MaxStatic = 60f;     // maxstatic: 40..60 (hard array bound 60; retail default 40)
        public float MaxDynamic = 10f;    // maxdynamic: 7..10 (hard array bound 10; retail default 7)
        public float RangeAdjust = 0f;    // rangeadjust: light reach multiplier (retail 1.5; 0 = leave)
        public float AmbientBoost = 0f;   // ambientboost: global ambient multiplier (retail 1.0; 0 = leave)

        // --- Phase 1: viewer headlamp (retail's own dormant viewer_light) ---
        public float Headlamp = 0f;         // headlamp: intensity (holtburger parity 2.25; 0 = off)
        public float HeadlampFalloff = 10f; // headlampfalloff: metres (retail source constant 10.0)
        public uint HeadlampColor = 0xFFFFFF; // headlampcolor: hex RGB

        // --- Phase 2: flame flicker (holtburger waveform on warm point lights) ---
        public float Flicker = 1f;        // flicker: 0/1
        public float FlickerAmp = 0.16f;  // flickeramp: 0..0.6

        // --- Phase 2: ambient fixes ---
        public float AmbientFix = 1f;       // ambientfix: 1 = fix the retail red-bias bug (only .r scaled)
        public float DungeonAmbient = -1f;  // dungeonambient: -1 = retail (0.2), else 0..1 level
        public uint DungeonAmbientColor = 0xFFFFFF; // dungeonambientcolor: hex RGB (retail white)

        // --- P5 bloom (luminance post-process) ---
        // Default OFF: opt-in via lights.cfg until the D3D9 path is live-validated (a per-frame
        // device call on a wrong vtable slot would crash the client). Flip to 1 in cfg to enable.
        public float Bloom = 0f;            // bloom: 0/1 master
        public float BloomThreshold = 0.80f;// bloomthreshold: luminance knee center (0..2)
        public float BloomKnee = 0.30f;     // bloomknee: soft-knee half-width
        public float BloomIntensity = 1.0f; // bloomintensity: additive scale (0..4)
        public float BloomRadius = 2f;      // bloomradius: separable blur H/V passes (1..4)

        // --- diagnostics / capture ---
        public float LogLights = 1f;      // loglights: 0/1 throttled enumeration log
        public float Dump = 0f;           // dump: 1 = write framedump-N.bmp (backbuffer) 1/sec (EndScene readback)
        // Gate the experimental per-frame detours (SceneTool::EndFrame for bloom, RenderDeviceD3D::
        // EndScene for capture). The two P0-P2 hooks (UpdateLightsInternal, SetWorldAmbientLight) are
        // proven stable (19k frames); these extra ones are under bring-up. 0 = don't install them
        // (safe default), 1 = EndScene only (capture), 2 = EndScene + EndFrame (bloom).
        public float ExtraHooks = 0f;     // extrahooks: 0 none | 1 endscene | 2 endscene+endframe

        private static readonly string[] CandidatePaths = BuildCandidatePaths();
        public string? LoadedFrom;

        private static string[] BuildCandidatePaths() {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return new[] {
                Environment.GetEnvironmentVariable("ACMELIGHTS_CONFIG") ?? "",
                @"C:\Temp\acdt\lights.cfg",
                Path.Combine(home, ".acdt", "lights.cfg"),
            };
        }

        /// <summary>Re-read the config file over current values. Never throws.</summary>
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
                        Apply(s.Substring(0, eq).Trim().ToLowerInvariant(), s.Substring(eq + 1).Trim());
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
                case "maxstatic": if (F(val, out var ms)) MaxStatic = Math.Clamp(ms, 0f, 60f); break;
                case "maxdynamic": if (F(val, out var md)) MaxDynamic = Math.Clamp(md, 0f, 10f); break;
                case "rangeadjust": if (F(val, out var ra)) RangeAdjust = Math.Clamp(ra, 0f, 10f); break;
                case "ambientboost": if (F(val, out var ab)) AmbientBoost = Math.Clamp(ab, 0f, 10f); break;
                case "headlamp": if (F(val, out var hl)) Headlamp = Math.Clamp(hl, 0f, 100f); break;
                case "headlampfalloff": if (F(val, out var hf)) HeadlampFalloff = Math.Clamp(hf, 0f, 100f); break;
                case "headlampcolor": if (Hex(val, out var hc)) HeadlampColor = hc; break;
                case "flicker": if (F(val, out var fl)) Flicker = Math.Clamp(fl, 0f, 1f); break;
                case "flickeramp": if (F(val, out var fa)) FlickerAmp = Math.Clamp(fa, 0f, 0.6f); break;
                case "ambientfix": if (F(val, out var af)) AmbientFix = Math.Clamp(af, 0f, 1f); break;
                case "dungeonambient": if (F(val, out var da)) DungeonAmbient = Math.Clamp(da, -1f, 1f); break;
                case "dungeonambientcolor": if (Hex(val, out var dc)) DungeonAmbientColor = dc; break;
                case "bloom": if (F(val, out var bl)) Bloom = Math.Clamp(bl, 0f, 1f); break;
                case "bloomthreshold": if (F(val, out var bt)) BloomThreshold = Math.Clamp(bt, 0f, 2f); break;
                case "bloomknee": if (F(val, out var bk)) BloomKnee = Math.Clamp(bk, 0.001f, 1f); break;
                case "bloomintensity": if (F(val, out var bi)) BloomIntensity = Math.Clamp(bi, 0f, 4f); break;
                case "bloomradius": if (F(val, out var br)) BloomRadius = Math.Clamp(br, 1f, 4f); break;
                case "loglights": if (F(val, out var ll)) LogLights = Math.Clamp(ll, 0f, 1f); break;
                case "dump": if (F(val, out var du)) Dump = Math.Clamp(du, 0f, 1f); break;
                case "extrahooks": if (F(val, out var eh)) ExtraHooks = Math.Clamp(eh, 0f, 2f); break;
            }
        }

        private static bool F(string s, out float v) =>
            float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v);
        private static bool Hex(string s, out uint v) =>
            uint.TryParse(s.TrimStart('#'), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v);
    }
}
