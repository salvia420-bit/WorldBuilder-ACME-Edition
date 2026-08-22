using System;
using System.Diagnostics;
using ACBindings.Internal;
using AcmeLights.Lib;
using Microsoft.Extensions.Logging;

namespace AcmeLights.Services {
    /// <summary>
    /// The per-frame lighting work, called from the <see cref="NativeHooks"/> UpdateLightsInternal
    /// post-detour (which runs once per viewpoint, before any draw's per-object slot selection).
    ///
    /// Phases implemented here (grounded in docs/lights-port/research-*.md):
    ///   P0  enumerate the live FF pools (throttled diagnostic log).
    ///   P1  assert raised pool caps + the viewer headlamp each frame (cheap; robust against the
    ///       client re-stomping them via SetDegradeLevelInternal / set_viewer).
    ///   P2  flame flicker: multiply each warm POINT light's live D3D Diffuse by the holtburger
    ///       flicker waveform. Recomputed from LIGHTINFO.color*intensity each frame (never
    ///       compounds); requires lightCacheing=0 or enable_active_lights would skip the re-upload
    ///       -- we force that global off while flicker is on.
    ///
    /// ALL reads/writes go through ACBindings statics whose addresses are map-build-correct for the
    /// shipped client (verified: Render.world_lights @0x008682B0, max_static_lights @0x0081FCA4,
    /// SmartBox.s_fViewerLightIntensity @0x0083DC10, etc.). Never throws (the detour guards anyway).
    /// </summary>
    internal sealed unsafe class LightManager {
        private readonly ILogger _log;
        private readonly LightsConfig _cfg;
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private long _lastCfgReloadTicks = -Stopwatch.Frequency;
        private long _lastLogTicks = -Stopwatch.Frequency;
        private long _frame;
        private bool _headlampCleared;

        // NOTE on lightCacheing (Render global, build-A 0x0081EFD8, map addr unverified so we do NOT
        // poke it): with caching on, enable_active_lights skips SetLight for a slot whose
        // (class,index) matched last frame. STATIC torches that stay selected are thus frozen against
        // our per-frame Diffuse edits. DYNAMIC lights are wiped+refilled every set_viewer, so their
        // slots re-upload every frame and DO flicker. Held torches, forge glows and the P3 spell/
        // portal lights are all dynamic -> flicker works where it matters now; static wall-torch
        // flicker is picked up in P4 when we own the minimize_object_lighting slot selection.
        // rangeAdjust / ambientBoostFactor: not surfaced by ACBindings, map VAs unverified -> no-ops.

        public LightManager(ILogger log, LightsConfig cfg) {
            _log = log;
            _cfg = cfg;
        }

        private const uint FlameFlickerSeedA = 73856093u, FlameFlickerSeedB = 19349663u, FlameFlickerSeedC = 83492791u;

        /// <summary>Called every viewpoint from the UpdateLightsInternal post-detour.</summary>
        public void OnUpdateLights() {
            ReloadThrottled();
            AssertPoolCaps();
            AssertHeadlamp();
            if (_cfg.Flicker > 0.5f) ApplyFlicker();
            LogThrottled();
            _frame++;
        }

        private void ReloadThrottled() {
            long now = _clock.ElapsedTicks;
            if (now - _lastCfgReloadTicks < Stopwatch.Frequency) return;
            _lastCfgReloadTicks = now;
            _cfg.Reload();
        }

        // ---- P1: pool caps ----
        private void AssertPoolCaps() {
            if (_cfg.MaxStatic > 0f) {
                int v = (int)_cfg.MaxStatic;
                if (*Render.max_static_lights != v && v is >= 1 and <= 60) *Render.max_static_lights = v;
            }
            if (_cfg.MaxDynamic > 0f) {
                int v = (int)_cfg.MaxDynamic;
                if (*Render.max_dynamic_lights != v && v is >= 1 and <= 10) *Render.max_dynamic_lights = v;
            }
        }

        // ---- P1: viewer headlamp (retail's own dormant viewer_light) ----
        private void AssertHeadlamp() {
            if (_cfg.Headlamp > 0f) {
                *SmartBox.s_fViewerLightIntensity = _cfg.Headlamp;
                *SmartBox.s_fViewerLightFalloff = _cfg.HeadlampFalloff;
                _headlampCleared = false;
            } else if (!_headlampCleared) {
                *SmartBox.s_fViewerLightIntensity = 0f;
                *SmartBox.s_fViewerLightFalloff = 0f;
                _headlampCleared = true;
            }
        }

        // ---- P2: flame flicker ----
        private void ApplyFlicker() {
            LightParms* wl = Render.world_lights;
            if (wl == null) return;
            float t = (float)_clock.Elapsed.TotalSeconds;
            FlickerPool(wl->static_lights, wl->num_static_lights, t);
            FlickerPool(wl->dynamic_lights, wl->num_dynamic_lights, t);
        }

        private void FlickerPool(RenderLight* pool, int n, float t) {
            if (pool == null || n <= 0) return;
            n = Math.Clamp(n, 0, 60);
            for (int i = 0; i < n; i++) {
                RenderLight* rl = pool + i;
                // POINT only, warm gate on the AUTHORED color (r>=0.30, r>=0.92g, r>1.25b),
                // matching holtburger flameFlicker.isFlameLight so portals/ice never flicker.
                if (rl->d3dLight.Type != _D3DLIGHTTYPE.D3DLIGHT_POINT) continue;
                float cr = rl->info.color.r, cg = rl->info.color.g, cb = rl->info.color.b;
                if (!(cr >= 0.30f && cr >= cg * 0.92f && cr > cb * 1.25f)) continue;

                float mul = FlickerMul(t, FlickerPhase(rl));
                float inten = rl->info.intensity;
                // Recompute from base so it never compounds; d3dLight.Diffuse = color*intensity*mul.
                rl->d3dLight.Diffuse.r = cr * inten * mul;
                rl->d3dLight.Diffuse.g = cg * inten * mul;
                rl->d3dLight.Diffuse.b = cb * inten * mul;
            }
        }

        /// <summary>holtburger flameFlickerMul (flameFlicker.js:79-87): amp 0.16, floor 0.74,
        /// 7.3/2.13/2.7 Hz. FlickerAmp cfg overrides the amplitude.</summary>
        private float FlickerMul(float t, float phase01) {
            float a = phase01 * MathF.PI * 2f;
            float s1 = MathF.Sin(t * 7.3f + a);
            float s2 = MathF.Sin(t * 2.13f + a * 1.7f + 1.3f);
            float noise = SmoothNoise1(t * 2.7f + phase01 * 17f) * 2f - 1f;
            float w = 0.5f * s1 + 0.28f * s2 + 0.5f * noise;
            float f = 1f + _cfg.FlickerAmp * w;
            return MathF.Max(f, 0.74f);
        }

        /// <summary>Deterministic per-light phase from the light's world position, quantised to a
        /// 0.25 m grid and prime-hashed (holtburger flameSourcePhase). No Math.Random.</summary>
        private static float FlickerPhase(RenderLight* rl) {
            // Use the light's world origin (info.offset.m_fOrigin; AC1Legacy.Vector3 wraps x/y/z).
            float* o = &rl->info.offset.m_fOrigin.BaseClass_Vector3.x;
            int qx = (int)MathF.Floor(o[0] / 0.25f);
            int qy = (int)MathF.Floor(o[1] / 0.25f);
            int qz = (int)MathF.Floor(o[2] / 0.25f);
            uint h = (uint)qx * FlameFlickerSeedA ^ (uint)qy * FlameFlickerSeedB ^ (uint)qz * FlameFlickerSeedC;
            return (h & 0xFFFFFF) / (float)0x1000000;
        }

        // value-noise: smooth interpolation of a hashed integer lattice.
        private static float SmoothNoise1(float x) {
            int i = (int)MathF.Floor(x);
            float f = x - i;
            float u = f * f * (3f - 2f * f);
            return Hash01(i) * (1f - u) + Hash01(i + 1) * u;
        }
        private static float Hash01(int n) {
            uint h = (uint)n * 2654435761u;
            h ^= h >> 15; h *= 2246822519u; h ^= h >> 13;
            return (h & 0xFFFFFF) / (float)0x1000000;
        }

        // ---- P0: enumeration log ----
        private void LogThrottled() {
            if (_cfg.LogLights < 0.5f) return;
            long now = _clock.ElapsedTicks;
            if (now - _lastLogTicks < Stopwatch.Frequency) return;
            _lastLogTicks = now;
            LightParms* wl = Render.world_lights;
            if (wl == null) { _log.LogInformation("acmelights: world_lights null"); return; }
            var amb = wl->ambient_color;
            _log.LogInformation(
                "acmelights: frame#{F} static={S}/{MS} dynamic={D}/{MD} ambient=({R:F2},{G:F2},{B:F2}) " +
                "headlamp={HL:F2} flicker={FK} indoorSun={SUN}",
                _frame, wl->num_static_lights, *Render.max_static_lights,
                wl->num_dynamic_lights, *Render.max_dynamic_lights,
                amb.r, amb.g, amb.b, *SmartBox.s_fViewerLightIntensity,
                _cfg.Flicker > 0.5f ? 1 : 0, *Render.useSunlight);
        }
    }
}
