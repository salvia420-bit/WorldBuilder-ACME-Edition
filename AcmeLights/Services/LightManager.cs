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
        private LightSelection? _sel;   // P4; set once in Initialize, read-only afterwards
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private long _lastLogTicks = -Stopwatch.Frequency;
        private long _frame;
        private bool _headlampCleared;
        private long _lastSelDraws;   // P4: previous LightSelection.Draws, for a per-interval delta
        private long _lastSelRebuilds;// P4: ditto Rebuilds — the snapshot-thrash tell (see LogThrottled)

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

        /// <summary>P4: hand the manager the selection engine so the per-viewpoint heartbeat can
        /// invalidate its snapshot (this detour runs immediately after retail recomputes every
        /// LIGHTINFO.viewerspace_location — acclient.c:453398 — so the snapshot is stale by
        /// definition) and drive the one-shot device-caps query off the hot path.</summary>
        public void AttachSelection(LightSelection sel) => _sel = sel;

        /// <summary>Called every viewpoint from the UpdateLightsInternal post-detour.</summary>
        public void OnUpdateLights() {
            _cfg.MaybeReload();     // 1 Hz stat; a read+parse only when lights.cfg actually changed
            AssertPoolCaps();
            AssertHeadlamp();
            if (_cfg.Flicker > 0.5f) ApplyFlicker();
            var sel = _sel;
            if (sel != null) {
                sel.QueryDeviceBudgetOnce();   // no-ops after the first success; never per draw
                sel.Invalidate();
            }
            LogThrottled();
            _frame++;
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
            // FINDING 3: clamp each call to the ACTUAL array length, never a shared 60. The pools
            // are fixed-size arrays — static_lights[60], dynamic_lights[10] (acclient.h:46634) — so
            // a num_*_lights that transiently over-reports (mid-recompute during set_viewer, a
            // raised-cap regression, or corruption) must not let FlickerPool write past the end.
            FlickerPool(wl->static_lights, wl->num_static_lights, StaticLightsCapacity, t);
            FlickerPool(wl->dynamic_lights, wl->num_dynamic_lights, DynamicLightsCapacity, t);
        }

        // Fixed capacities of the LightParms light arrays (acclient.h:46634).
        private const int StaticLightsCapacity = 60;
        private const int DynamicLightsCapacity = 10;

        private void FlickerPool(RenderLight* pool, int n, int maxCap, float t) {
            if (pool == null || n <= 0) return;
            n = Math.Clamp(n, 0, maxCap);
            for (int i = 0; i < n; i++) {
                RenderLight* rl = pool + i;
                // POINT only, warm gate on the AUTHORED color (r>=0.30, r>=0.92g, r>1.25b),
                // matching holtburger flameFlicker.isFlameLight so portals/ice never flicker.
                // The predicate lives in LightSelection so P4's carryOver-clear (which decides which
                // slots get re-uploaded to D3D) can never select a different set than we flicker.
                if (!LightSelection.IsFlameLight(rl)) continue;
                float cr = rl->info.color.r, cg = rl->info.color.g, cb = rl->info.color.b;

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
        // PACING (2026-08-23): every ILogger call is a synchronous Console.Write + Directory.Exists
        // + File open/append/close on THIS (render) thread, so a 1 Hz heartbeat put a file write in
        // one frame out of every ~60-100 — i.e. it WAS the 1% low. Two changes: the default cadence
        // drops to 5 s (`loglights=2` restores 1 Hz for live triage), and the line goes to the async
        // sink so even at 1 Hz it costs a string plus a list append.
        private void LogThrottled() {
            if (_cfg.LogLights < 0.5f) return;
            long now = _clock.ElapsedTicks;
            long period = _cfg.LogLights >= 1.5f ? Stopwatch.Frequency : Stopwatch.Frequency * 5;
            if (now - _lastLogTicks < period) return;
            _lastLogTicks = now;
            LightParms* wl = Render.world_lights;
            // world_lights null is a genuine "something is wrong" breadcrumb and happens at most
            // once per heartbeat, so it keeps the synchronous logger (in-game console + log.txt).
            if (wl == null) { _log.LogWarning("acmelights: world_lights null"); return; }
            var amb = wl->ambient_color;
            var sel = _sel;
            // P4 counters. `sel draws` is per-DRAW work since the last line (indoors only --
            // RenderDeviceD3D::DrawMeshInternal calls minimize_object_lighting only when
            // !Render::useSunlight, acclient.c:456975), so a 0 outdoors is expected and correct.
            long selDraws = 0, selBail = 0, selRebuilds = 0;
            int selCand = 0, selPick = 0, selBudget = 0;
            if (sel != null) {
                selDraws = sel.Draws - _lastSelDraws; _lastSelDraws = sel.Draws;
                selBail = sel.Bailouts;
                // PACING DIAGNOSTIC: rebuilds-per-interval. Rebuild() re-gathers all 70 candidates
                // out of the client's RenderLight structs; it is supposed to run ONCE PER VIEWPOINT.
                // If this number ever approaches `seldraws` the snapshot is thrashing per draw and
                // that is a real per-frame cost — this line is how the next live test says so.
                selRebuilds = sel.Rebuilds - _lastSelRebuilds; _lastSelRebuilds = sel.Rebuilds;
                selCand = sel.LastCandidates; selPick = sel.LastPicked; selBudget = sel.LastBudget;
            }
            // amb = the raw SetWorldAmbientLight intensity (0.2 in a dungeon and at outdoor
            // midnight; the region's SkyTimeOfDay curve by day). READ THIS AT NOON to set
            // `bloomdayamb` — the noon value is region DATA, not a constant we can derive.
            // day = the smoothed 0..1 factor the bloom pass blends its knobs with.
            AsyncLog.Post(
                "acmelights: frame#" + _frame.ToString() +
                " static=" + wl->num_static_lights.ToString() + "/" + (*Render.max_static_lights).ToString() +
                " dynamic=" + wl->num_dynamic_lights.ToString() + "/" + (*Render.max_dynamic_lights).ToString() +
                " ambient=(" + amb.r.ToString("F2") + "," + amb.g.ToString("F2") + "," + amb.b.ToString("F2") + ")" +
                " headlamp=" + (*SmartBox.s_fViewerLightIntensity).ToString("F2") +
                " flicker=" + (_cfg.Flicker > 0.5f ? "1" : "0") +
                " indoorSun=" + (*Render.useSunlight).ToString() +
                " sel=" + (_cfg.Selection > 0.5f ? "1" : "0") +
                " seldraws=" + selDraws.ToString() +
                " selcand=" + selCand.ToString() +
                " selpick=" + selPick.ToString() + "/" + selBudget.ToString() +
                " selrebuilds=" + selRebuilds.ToString() +
                " selbail=" + selBail.ToString() +
                " amb=" + SkyState.Ambient.ToString("F2") +
                " day=" + SkyState.Day.ToString("F2"));
        }
    }
}
