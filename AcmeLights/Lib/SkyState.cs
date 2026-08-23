using System;
using System.Diagnostics;
using System.Runtime.CompilerServices;

namespace AcmeLights.Lib {
    /// <summary>
    /// THE DAY/NIGHT SIGNAL — derived from the ambient funnel the plugin already owns, with no
    /// cross-plugin dependency on AcmeSky and no new detour.
    ///
    /// ── WHY THE AMBIENT FUNNEL IS THE RIGHT SOURCE ───────────────────────────────────────────
    /// `SmartBox::SetWorldAmbientLight(float intensity, uint color)` (acclient.c:144222,
    /// @0x004530E0 — <see cref="Services.NativeHooks"/> already post-detours it for the red-bias
    /// fix) is the ONE place the client funnels every ambient decision. Its callers:
    ///
    ///   * `LScape::set_landscape_lighting` (acclient.c:307003) — the OUTDOOR day/night driver,
    ///     re-run on every landscape light tick (`sky_info->light_tick_size`, ~3 s):
    ///         intensity = |LScape::sunlight| * 0.2 + LScape::ambient_level
    ///     Both terms come from `CRegionDesc::GetLighting(GameTime::present_time_of_day, …)` →
    ///     `SkyDesc::GetLighting` (acclient.c:301485), which linearly interpolates the region's
    ///     authored `SkyTimeOfDay` keyframes (`dir_bright`, `amb_bright`) by the fractional time of
    ///     day. So this argument IS the retail day/night curve, already fused sun + ambient.
    ///   * `CellManager::ChangePosition` (acclient.c:146742) — the DUNGEON/enclosed case: a flat,
    ///     time-independent `(0.2, 0xFFFFFFFF)`, the `LSCAPE_LIGHT_MINIMUM` (acclient.c:40344).
    ///   * the same function's outdoor cell-change path (:146735) and `SmartBox::SetNormalMode`
    ///     (:144248, a cached re-flush) — neither introduces a different scale.
    ///
    /// Outdoor NIGHT is floored at the same 0.2 minimum (`LScape::min_ambient`, acclient.c:307024),
    /// so a single scalar cannot tell "outdoor midnight" from "dungeon" — and that is exactly the
    /// behaviour we want: both should use the owner-proven NIGHT bloom values. Hence ONE scalar
    /// answers the whole question and no indoor/outdoor test is needed on this path.
    ///
    /// ── SMOOTHING ────────────────────────────────────────────────────────────────────────────
    /// The funnel fires on cell change and on the ~3 s light tick, so the raw value STEPS. The day
    /// factor is therefore exponentially smoothed (τ = <see cref="BlendTau"/> s) from the render
    /// callback, which fires every in-world frame — walking out of a house ramps the bloom over a
    /// second or so instead of popping. A stall longer than 1 s snaps (teleport/loading screen:
    /// there is nothing to cross-fade).
    ///
    /// ── 0x80131509 DISCIPLINE ────────────────────────────────────────────────────────────────
    /// Every method here runs on the native render thread. <see cref="Warmup"/> pre-JITs the lot on
    /// the managed thread (called from AcmeLightsPlugin.Initialize). Nothing allocates or throws.
    /// </summary>
    internal static class SkyState {
        /// <summary>Exponential blend time constant, seconds. Not a cfg knob on purpose: it is a
        /// smoothing detail, not a look decision, and the two ends are already tunable.</summary>
        private const float BlendTau = 1.25f;

        private static readonly Stopwatch _clock = Stopwatch.StartNew();
        private static long _lastTick;

        /// <summary>Last ambient intensity the CLIENT asked for — captured before AcmeLights' own
        /// `dungeonambient` override rewrites it, so the signal stays the client's own truth.
        /// Initialised to the dungeon/night floor: until the funnel has fired even once we report
        /// "night", i.e. the owner-proven bloom values.</summary>
        private static float _amb = 0.2f;

        private static float _day;      // smoothed 0 (night/indoor) .. 1 (full day outdoors)

        /// <summary>Raw ambient intensity last seen at the funnel (diagnostic + tuning: the owner
        /// reads the real noon/midnight numbers for their region straight off the heartbeat log and
        /// sets `bloomdayamb` from them).</summary>
        public static float Ambient => _amb;

        /// <summary>Smoothed day factor, 0 = night/dungeon (night bloom values verbatim),
        /// 1 = full daylight outdoors (the `bloomday*` values).</summary>
        public static float Day => _day;

        /// <summary>Called from the SetWorldAmbientLight post-detour with the CLIENT'S arguments.</summary>
        public static void NoteAmbient(float intensity) {
            if (float.IsNaN(intensity) || float.IsInfinity(intensity)) return;
            _amb = intensity < 0f ? 0f : (intensity > 8f ? 8f : intensity);
        }

        /// <summary>Where the ambient level sits between the two configured ends, 0..1.</summary>
        public static float TargetDay(LightsConfig cfg) {
            if (cfg.BloomDay < 0.5f) return 0f;              // day scaling off => night values only
            float lo = cfg.BloomNightAmb, hi = cfg.BloomDayAmb;
            if (hi - lo < 1e-3f) return _amb >= hi ? 1f : 0f;
            float t = (_amb - lo) / (hi - lo);
            return t <= 0f ? 0f : (t >= 1f ? 1f : t);
        }

        /// <summary>Advance the smoothed day factor. Called once per in-world frame from the
        /// rendering-callback slot. No allocation, never throws.</summary>
        public static void Tick(LightsConfig cfg) {
            float target = TargetDay(cfg);
            long now = _clock.ElapsedTicks;
            long prev = _lastTick;
            _lastTick = now;
            if (prev == 0) { _day = target; return; }
            float dt = (float)(now - prev) / Stopwatch.Frequency;
            if (dt <= 0f || dt > 1f) { _day = target; return; }   // first frame, stall, teleport: snap
            _day += (target - _day) * (1f - MathF.Exp(-dt / BlendTau));
        }

        /// <summary>Linear blend of a night value and a day value by the smoothed day factor.</summary>
        public static float Blend(float night, float day) {
            float t = _day;
            return night + (day - night) * t;
        }

        /// <summary>Managed-thread pre-JIT (0x80131509 discipline) — every method here is reached
        /// from a native detour or the rendering-callback slot.</summary>
        public static void Warmup(LightsConfig cfg) {
            foreach (var m in typeof(SkyState).GetMethods(
                         System.Reflection.BindingFlags.Static |
                         System.Reflection.BindingFlags.Public |
                         System.Reflection.BindingFlags.NonPublic)) {
                if (m.IsAbstract || m.ContainsGenericParameters) continue;
                try { RuntimeHelpers.PrepareMethod(m.MethodHandle); } catch { }
            }
            _lastTick = 0;
            Tick(cfg);
        }
    }
}
