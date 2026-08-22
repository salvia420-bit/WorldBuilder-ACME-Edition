using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Numerics;
using AcmeSky.Lib;
using AcmeSky.Model;
using AcmeSky.Services.LiveSky;
using Microsoft.Extensions.Logging;

namespace AcmeSky.Services {
    /// <summary>
    /// Draws AcmeSky's replacement sky on the client's own fixed-function D3D9 device, in the exact
    /// frame slot vacated by the suppressed GameSky::Draw. Owns the atmosphere dome, the star dome,
    /// and the ordered cloud layers, plus their baked textures.
    ///
    /// DRAW ORDER &amp; OCCLUSION. <see cref="Render"/> is called from the GameSky::Draw detour
    /// (SkyHook). The client calls that twice per frame: after=0 BEFORE the world (the backdrop the
    /// world then overdraws), after=1 AFTER the world (retail weather-in-front). We draw the whole
    /// sky in the after=0 slot with depth-writes OFF and ZFunc=ALWAYS, in painter's order
    /// atmosphere -> stars -> clouds(far..near). Because this happens before the world renders, the
    /// terrain/buildings that draw afterwards pass their own depth test against the cleared buffer
    /// and overwrite our sky wherever geometry is nearer -- so clouds are correctly occluded by
    /// terrain for free, identically to how retail's own DEPTHTEST_ALWAYS backdrop works. The
    /// after=1 slot is reserved for future front-facing precipitation and is a no-op today (its
    /// retail weather is still suppressed by the hook).
    ///
    /// The domes follow the camera POSITION (World = Scale(radius) * Translate(cameraPos)) but keep
    /// the client's own WorldToView/ViewToClip for VIEW/PROJ, so they are world-fixed in ORIENTATION
    /// -- turning the view pans across the sky (a skybox), it is not glued to the heading.
    ///
    /// All device state is snapshotted and restored around every frame's draws by
    /// <see cref="RenderStateGuard"/> -- see the invariant documented there.
    /// </summary>
    public sealed class SkyRenderer {
        private readonly ILogger _log;
        private readonly string _assetDir;
        private readonly TextureLoader _tex;
        private readonly SkyPalette _palette;
        private readonly Stopwatch _clock = Stopwatch.StartNew();

        // Geometry (built once).
        private DomeMesh? _sphere;    // full sphere: atmosphere + stars
        private DomeMesh? _cloudDome; // upper dome (-15..90): clouds
        private VertexPC[]? _atmoVerts;

        // Textures / layers.
        private readonly List<SkyLayer> _cloudLayers = new();
        private IntPtr _starTexture;
        private bool _assetsLoaded;

        // Device tracking: a changed pointer means the device was re-created and our textures died.
        private IntPtr _device;

        /// <summary>Master enable. When false, the hook still suppresses the retail sky but we draw nothing.</summary>
        public bool Enabled { get; set; } = true;

        /// <summary>Weather class name selecting the palette + cloud look. Defaults to clear.</summary>
        public string WeatherClass { get; set; } = SkyPalette.DefaultClass;

        /// <summary>Brightness multiplier on the atmosphere gradient (palette LUTs are linear/dim).</summary>
        public float AtmosphereBoost { get; set; } = 1.35f;

        // ==================================================================
        // Diagnostics / first-pass debug controls
        //
        // We are blind on the injected client (no console), so these make the render path OBSERVABLE
        // and let us prove the hook+draw path visibly works before we trust the palette.
        //   * ACMESKY_TESTGRADIENT=0 disables the bright known-good gradient (defaults ON for the
        //     first diagnostic inject: draws unmistakable bright bands so we can confirm the detour
        //     actually reaches the screen even if the palette/time reads are wrong). TODO: once the
        //     path is confirmed on the 1070, set ACMESKY_TESTGRADIENT=0 to render the real palette.
        //   * ACMESKY_DIAG=0 silences the throttled per-second frame log (first-frame log always fires).
        // Env is the only knob available inside an injected client (there is no URL-flag surface).
        // ==================================================================

        /// <summary>When true, the atmosphere dome is drawn with a fixed BRIGHT gradient instead of the
        /// palette sample -- a known-good "is anything reaching the screen?" probe. Default ON for the
        /// first diagnostic inject; clear ACMESKY_TESTGRADIENT to 0 to render the real palette.</summary>
        public static bool TestGradient =
            !string.Equals(Environment.GetEnvironmentVariable("ACMESKY_TESTGRADIENT"), "0", StringComparison.Ordinal);

        /// <summary>Throttled per-second frame diagnostics. On by default; ACMESKY_DIAG=0 to silence.</summary>
        public static bool DiagFrameLog =
            !string.Equals(Environment.GetEnvironmentVariable("ACMESKY_DIAG"), "0", StringComparison.Ordinal);

        /// <summary>
        /// MILESTONE 0 live compositor switch. OFF by default; set ACMESKY_LIVE=1 to route the
        /// after==0 backdrop slot through <see cref="LiveSkyCompositor"/> (our own D3D11 device renders
        /// a trivial animated test pattern that is read back and composited on the client's D3D9 device)
        /// instead of the baked dome draws. The retail sky stays suppressed either way (the hook does
        /// that). When OFF the baked path is byte-for-byte unchanged.
        /// </summary>
        public static bool Live =
            string.Equals(Environment.GetEnvironmentVariable("ACMESKY_LIVE"), "1", StringComparison.Ordinal);

        /// <summary>
        /// Forced time-of-day (0..1) for the BAKED path, from ACMESKY_SKY_TIME (the same env the LIVE
        /// path's SkyConfig honors). &lt;0 = use the client clock. This exists because the client's
        /// present_time_of_day read comes back pinned at 0.0 in some sessions (the known stuck-clock
        /// quirk) — which rendered a dead-BLACK midnight sky over a daylit world (indoorSun=1). The
        /// baked renderer used to ignore this override entirely (only the live compositor read it), so
        /// a baked-path user had no way to escape the black sky. Now: if set, it wins; and a raw clock
        /// read of exactly 0.0 is treated as "not ready" and falls back to midday, mirroring the
        /// live path's treatment of a 0 read.
        /// </summary>
        public static float ForcedTime = ParseForcedTime();
        private static float ParseForcedTime() {
            var s = Environment.GetEnvironmentVariable("ACMESKY_SKY_TIME");
            return !string.IsNullOrEmpty(s) &&
                   float.TryParse(s, System.Globalization.NumberStyles.Float,
                                  System.Globalization.CultureInfo.InvariantCulture, out var v)
                   ? v : -1f;
        }

        /// <summary>Lazily created live compositor (Milestone 0). Null until the first Live frame.</summary>
        private LiveSkyCompositor? _live;

        private bool _firstFrameLogged;
        private long _lastFrameLogTicks;
        private long _lastErrTicks;

        public SkyRenderer(string assetDir, TextureLoader tex, SkyPalette palette, ILogger log) {
            _assetDir = assetDir; _tex = tex; _palette = palette; _log = log;
            BuildDefaultLayers();
            _log.LogInformation(
                "acmesky: SkyRenderer built (assetDir={Dir}, palettesLoaded={PL}, classes={Cls}, testGradient={TG}, diag={DG}, live={LV})",
                _assetDir, _palette.Loaded, string.Join(",", _palette.Classes), TestGradient, DiagFrameLog, Live);

            // Live compositor is created + warmed HERE, on the managed Initialize thread — NOT lazily
            // in Render (the native detour thread), where the Vortice assembly load / D3DCompile
            // throws 0x80131509 and the silent SkyHook catch turned that into a permanently BLACK sky
            // (retail suppressed, nothing drawn, nothing logged). If warmup fails, Render falls back
            // to the baked dome path so the sky is never black.
            if (Live) {
                try {
                    _live = new LiveSkyCompositor(_log, _assetDir);
                    bool ok = _live.Warmup();
                    _log.LogInformation("acmesky: live compositor warmup on managed thread -> {S}",
                        ok ? "READY" : "FAILED (will fall back to baked domes)");
                }
                catch (Exception ex) {
                    _log.LogError(ex, "acmesky: live compositor warmup threw; falling back to baked domes");
                    _live = null;
                }
            }
        }

        /// <summary>
        /// The default 2-layer cloud stack. Extend by adding SkyLayer entries (different radii /
        /// scroll / parallax / texture) -- the renderer draws however many are configured.
        /// </summary>
        private void BuildDefaultLayers() {
            _cloudLayers.Add(new SkyLayer {   // low broken deck, nearer, faster, alpha-blended
                TextureFile = "cloud_low_broken.askytex",
                Radius = 700f,
                ScrollVel = new Vector2(0.006f, 0.002f),
                ParallaxFactor = 6e-5f,
                BaseAlpha = 0.85f,
                Additive = false,
            });
            _cloudLayers.Add(new SkyLayer {   // high cirrus, farther, slower, fainter
                TextureFile = "cloud_cirrus_clear.askytex",
                Radius = 1100f,
                ScrollVel = new Vector2(0.0025f, 0.0009f),
                ParallaxFactor = 2e-5f,
                BaseAlpha = 0.6f,
                Additive = false,
            });
        }

        // ==================================================================
        // Lazy GPU init / device-loss handling
        // ==================================================================

        private void EnsureGeometry() {
            _sphere ??= DomeMesh.Build(slices: 48, stacks: 24, minElevationDeg: -90f, maxElevationDeg: 90f);
            _cloudDome ??= DomeMesh.Build(slices: 48, stacks: 18, minElevationDeg: -15f, maxElevationDeg: 90f);
            if (_atmoVerts is null && _sphere is not null) {
                _atmoVerts = new VertexPC[_sphere.Textured.Length];
                for (int i = 0; i < _atmoVerts.Length; i++) {
                    var p = _sphere.Textured[i];
                    _atmoVerts[i] = new VertexPC { X = p.X, Y = p.Y, Z = p.Z, Color = 0xFFFFFFFF };
                }
            }
        }

        private void EnsureTextures(Device d) {
            if (_assetsLoaded) return;
            foreach (var layer in _cloudLayers) {
                var raw = _tex.ReadFile(Path.Combine(_assetDir, layer.TextureFile));
                layer.Texture = _tex.Upload(d, raw);
            }
            var starRaw = _tex.ReadFile(Path.Combine(_assetDir, "stars_equirect.askytex"));
            _starTexture = _tex.Upload(d, starRaw);
            _assetsLoaded = true;
        }

        /// <summary>
        /// Handle a device pointer that changed since last frame: the old device (and every texture
        /// on it) is gone, so we drop the handles WITHOUT releasing them (releasing would call into
        /// freed memory) and reload against the new device.
        /// </summary>
        private void OnDeviceChanged(IntPtr newDev) {
            foreach (var layer in _cloudLayers) layer.Texture = IntPtr.Zero;
            _starTexture = IntPtr.Zero;
            _assetsLoaded = false;
            _device = newDev;
            _log.LogInformation("acmesky: device pointer -> {Dev:X8}; textures will reload", newDev.ToInt64());
        }

        // ==================================================================
        // Frame entry
        // ==================================================================

        /// <summary>
        /// Draw the sky for the given GameSky::Draw phase. Render thread only (called from the detour).
        /// </summary>
        public void Render(int after) {
            if (!Enabled) return;
            if (after != 0) return; // after=1 (front weather) reserved; suppressed but not drawn yet

            IntPtr devPtr = ClientState.GetDevicePointer();
            if (devPtr == IntPtr.Zero) { FirstFrameOnce("device pointer is NULL - render aborted"); return; }
            if (devPtr != _device) OnDeviceChanged(devPtr);
            var device = new Device(devPtr);

            var cam = ClientState.GetCamera();
            if (!cam.Valid) { FirstFrameOnce($"camera invalid (dev={devPtr.ToInt64():X8}) - render aborted"); return; }

            // When ACMESKY_LIVE=1 and the (Initialize-warmed) live compositor is healthy, the after==0
            // backdrop slot is drawn by it (own D3D11 device -> readback -> D3D9 dynamic texture ->
            // fullscreen quad) and we RETURN. If it is missing/dead, FALL THROUGH to the baked dome
            // path — the sky must never be black just because the live path died. Never construct or
            // warm the compositor here: this is the native detour thread (see ctor note, 0x80131509).
            if (Live && _live is not null && _live.Usable) {
                try {
                    _live.Frame(device, devPtr, in cam);
                    return;
                }
                catch (Exception ex) {
                    LogErrThrottled(ex, "live-frame");   // fall through to baked this frame
                }
            }

            EnsureGeometry();
            if (_sphere is null || _cloudDome is null || _atmoVerts is null) {
                FirstFrameOnce("geometry build failed - render aborted");
                return;
            }

            // --- Resolve time / weather / palette (guarded; must never blank the sky) -------------
            // Priority: ACMESKY_SKY_TIME override -> client clock -> midday fallback. A raw clock read
            // of exactly 0.0 is the known stuck-clock value (present_time_of_day never advanced); we
            // treat it as "not ready" and use midday, so the baked sky is never a black midnight over
            // a daylit world. Set ACMESKY_SKY_TIME to force any time (e.g. 0.5 = noon, 0.0 = true night).
            float time;
            bool haveClock;
            if (ForcedTime >= 0f) { time = ForcedTime % 1f; haveClock = true; }
            else {
                time = ClientState.GetTimeOfDay();
                haveClock = time > 0.00001f;                       // <0 (no clock) or ==0 (stuck) -> fallback
                if (!haveClock) time = 0.5f;                       // assume midday
            }
            bool weatherOn = ClientState.IsWeatherEnabled();
            var sample = _palette.Sample(WeatherClass, time);

            float sunEl = sample.SunElevationDeg;
            float dayness = Math.Clamp((sunEl + 6f) / 12f, 0f, 1f);
            float starFade = Math.Clamp(-(sunEl + 4f) / 8f, 0f, 1f);

            // Atmosphere endpoints. TestGradient forces a known-bright band so we can confirm the draw
            // path visibly reaches the screen regardless of palette/time correctness.
            Vector3 horizon, zenith;
            if (TestGradient) {
                horizon = new Vector3(1.0f, 0.55f, 0.15f);   // warm bright horizon
                zenith  = new Vector3(0.15f, 0.45f, 1.0f);   // bright blue zenith
            }
            else {
                horizon = sample.FogColor * AtmosphereBoost;
                zenith  = sample.AmbColor * AtmosphereBoost;
            }

            // --- One-time and throttled diagnostics -----------------------------------------------
            if (!_firstFrameLogged) {
                _firstFrameLogged = true;
                _log.LogInformation(
                    "acmesky: FIRST FRAME dev={Dev:X8} vp={W}x{H} camPos=({X:F1},{Y:F1},{Z:F1}) " +
                    "clock={Clk} time={T:F3} weatherOn={WX} class={Cls} " +
                    "sample[fog=({FR:F2},{FG:F2},{FB:F2}) amb=({AR:F2},{AG:F2},{AB:F2}) sunEl={Sun:F1}] " +
                    "-> horizon=({HR:F2},{HG:F2},{HB:F2}) zenith=({ZR:F2},{ZG:F2},{ZB:F2}) testGradient={TG}",
                    devPtr.ToInt64(), cam.ViewportW, cam.ViewportH,
                    cam.WorldPos.X, cam.WorldPos.Y, cam.WorldPos.Z,
                    haveClock, time, weatherOn, WeatherClass,
                    sample.FogColor.X, sample.FogColor.Y, sample.FogColor.Z,
                    sample.AmbColor.X, sample.AmbColor.Y, sample.AmbColor.Z, sunEl,
                    horizon.X, horizon.Y, horizon.Z, zenith.X, zenith.Y, zenith.Z, TestGradient);
            }
            if (DiagFrameLog) {
                long now = _clock.ElapsedTicks;
                if (now - _lastFrameLogTicks > Stopwatch.Frequency) {
                    _lastFrameLogTicks = now;
                    _log.LogInformation(
                        "acmesky: frame after={A} time={T:F3} class={Cls} sunEl={Sun:F1} dayness={D:F2} " +
                        "zenith=({ZR:F2},{ZG:F2},{ZB:F2}) atmoDrawn=1",
                        after, time, WeatherClass, sunEl, dayness, zenith.X, zenith.Y, zenith.Z);
                }
            }

            // --- Draw. Each stage is independently guarded so one failing stage cannot blank the
            //     atmosphere (the dark-sky bug: EnsureTextures used to throw OUTSIDE the guard, which
            //     aborted the whole frame -> nothing drawn -> dark). Atmosphere needs no textures, so
            //     it is drawn first and unconditionally. ---------------------------------------------
            var guard = new RenderStateGuard();
            guard.Capture(device);
            try {
                CommonState(device, cam);

                try { DrawAtmosphere(device, cam, horizon, zenith); }
                catch (Exception ex) { LogErrThrottled(ex, "atmosphere"); }

                // Textures are lazy and non-fatal: if upload fails, the atmosphere still shows.
                bool texReady = false;
                try { EnsureTextures(device); texReady = true; }
                catch (Exception ex) { LogErrThrottled(ex, "textures"); }

                if (texReady) {
                    if (starFade > 0.01f && _starTexture != IntPtr.Zero) {
                        try { DrawStars(device, cam, starFade); }
                        catch (Exception ex) { LogErrThrottled(ex, "stars"); }
                    }
                    try { DrawClouds(device, cam, dayness); }
                    catch (Exception ex) { LogErrThrottled(ex, "clouds"); }
                }
            }
            catch (Exception ex) {
                LogErrThrottled(ex, "common-state");
            }
            finally {
                guard.Restore();
            }
        }

        /// <summary>Emit a one-shot first-frame note when Render bails before drawing (device/camera not
        /// ready). Fires only once so it can never spam the client log.</summary>
        private void FirstFrameOnce(string why) {
            if (_firstFrameLogged) return;
            _firstFrameLogged = true;
            _log.LogWarning("acmesky: FIRST FRAME {Why}", why);
        }

        /// <summary>Log a render-stage exception at most once per second (per renderer), naming the stage.
        /// Previously a stage throw was swallowed silently -> invisible dark sky with no clue why.</summary>
        private void LogErrThrottled(Exception ex, string stage) {
            long now = _clock.ElapsedTicks;
            if (now - _lastErrTicks < Stopwatch.Frequency) return;
            _lastErrTicks = now;
            _log.LogWarning(ex, "acmesky: render stage '{Stage}' threw", stage);
        }

        // ==================================================================
        // Shared pipeline setup
        // ==================================================================

        private static void CommonState(Device d, in ClientState.Camera cam) {
            // Use the client's own camera for VIEW/PROJ so orientation is world-fixed.
            d.SetTransform(D3D9.Ts.View, cam.WorldToView);
            d.SetTransform(D3D9.Ts.Projection, cam.ViewToClip);

            // Backdrop depth behaviour: never occlude ourselves, never write depth. The world drawn
            // afterwards overwrites us where it is nearer -> correct terrain occlusion.
            d.SetRenderState(D3D9.Rs.ZEnable, 0);
            d.SetRenderState(D3D9.Rs.ZWriteEnable, 0);
            d.SetRenderState(D3D9.Rs.ZFunc, (uint)D3D9.Cmp.Always);
            d.SetRenderState(D3D9.Rs.Lighting, 0);
            d.SetRenderState(D3D9.Rs.FogEnable, 0);
            d.SetRenderState(D3D9.Rs.AlphaTestEnable, 0);
            d.SetRenderState(D3D9.Rs.SpecularEnable, 0);
            d.SetRenderState(D3D9.Rs.CullMode, (uint)D3D9.Cull.None); // dome viewed from inside
            d.SetRenderState(D3D9.Rs.ColorWriteEnable, 0xF);

            d.SetSamplerState(0, D3D9.Samp.MagFilter, (uint)D3D9.Filter.Linear);
            d.SetSamplerState(0, D3D9.Samp.MinFilter, (uint)D3D9.Filter.Linear);
            d.SetSamplerState(0, D3D9.Samp.MipFilter, (uint)D3D9.Filter.None);
        }

        private static Matrix4x4 DomeWorld(in ClientState.Camera cam, float radius) =>
            Matrix4x4.CreateScale(radius) * Matrix4x4.CreateTranslation(cam.WorldPos);

        // ==================================================================
        // Atmosphere: per-vertex gradient dome (no texture)
        // ==================================================================

        private unsafe void DrawAtmosphere(Device d, in ClientState.Camera cam, Vector3 horizon, Vector3 zenith) {
            var verts = _atmoVerts!;
            var el = _sphere!.Elevation;
            const float halfPi = MathF.PI / 2f;
            for (int i = 0; i < verts.Length; i++) {
                float t = Math.Clamp(el[i] / halfPi, 0f, 1f);
                t = t * t * (3f - 2f * t); // smoothstep
                Vector3 c = Vector3.Lerp(horizon, zenith, t);
                verts[i].Color = D3D9.Argb(1f, c.X, c.Y, c.Z);
            }

            d.SetTransform(D3D9.Ts.World, DomeWorld(cam, 1500f));
            d.SetFVF(D3D9.Fvf.XyzDiffuse);
            d.SetTexture(0, IntPtr.Zero);
            d.SetRenderState(D3D9.Rs.AlphaBlendEnable, 0);
            d.SetRenderState(D3D9.Rs.ColorVertex, 1);
            d.SetTextureStageState(0, D3D9.Tss.ColorOp, (uint)D3D9.Top.SelectArg1);
            d.SetTextureStageState(0, D3D9.Tss.ColorArg1, (uint)D3D9.Ta.Diffuse);
            d.SetTextureStageState(0, D3D9.Tss.AlphaOp, (uint)D3D9.Top.SelectArg1);
            d.SetTextureStageState(0, D3D9.Tss.AlphaArg1, (uint)D3D9.Ta.Diffuse);
            d.SetTextureStageState(0, D3D9.Tss.TextureTransformFlags, (uint)D3D9.Ttff.Disable);

            fixed (VertexPC* p = verts)
                d.DrawPrimitiveUP(D3D9.Prim.TriangleList, (uint)_sphere.TriangleCount, p, 16);
        }

        // ==================================================================
        // Stars: textured full sphere, additive, faded in at night
        // ==================================================================

        private unsafe void DrawStars(Device d, in ClientState.Camera cam, float fade) {
            d.SetTransform(D3D9.Ts.World, DomeWorld(cam, 1400f));
            d.SetTransform(D3D9.Ts.Texture0, Matrix4x4.Identity);
            d.SetFVF(D3D9.Fvf.XyzTex1);
            d.SetTexture(0, _starTexture);
            d.SetSamplerState(0, D3D9.Samp.AddressU, (uint)D3D9.Address.Wrap);
            d.SetSamplerState(0, D3D9.Samp.AddressV, (uint)D3D9.Address.Clamp);

            d.SetRenderState(D3D9.Rs.AlphaBlendEnable, 1);
            d.SetRenderState(D3D9.Rs.SrcBlend, (uint)D3D9.Blend.One);     // additive: stars add over sky
            d.SetRenderState(D3D9.Rs.DestBlend, (uint)D3D9.Blend.One);
            d.SetRenderState(D3D9.Rs.TextureFactor, D3D9.Argb(1f, fade, fade, fade));

            d.SetTextureStageState(0, D3D9.Tss.TextureTransformFlags, (uint)D3D9.Ttff.Disable);
            d.SetTextureStageState(0, D3D9.Tss.ColorOp, (uint)D3D9.Top.Modulate);
            d.SetTextureStageState(0, D3D9.Tss.ColorArg1, (uint)D3D9.Ta.Texture);
            d.SetTextureStageState(0, D3D9.Tss.ColorArg2, (uint)D3D9.Ta.TFactor);
            d.SetTextureStageState(0, D3D9.Tss.AlphaOp, (uint)D3D9.Top.SelectArg1);
            d.SetTextureStageState(0, D3D9.Tss.AlphaArg1, (uint)D3D9.Ta.Texture);

            fixed (VertexPT* p = _sphere!.Textured)
                d.DrawPrimitiveUP(D3D9.Prim.TriangleList, (uint)_sphere.TriangleCount, p, 20);
        }

        // ==================================================================
        // Clouds: N textured domes, painter's order far -> near
        // ==================================================================

        private unsafe void DrawClouds(Device d, in ClientState.Camera cam, float dayness) {
            float t = (float)_clock.Elapsed.TotalSeconds;
            float lit = 0.25f + 0.75f * dayness; // clouds darken at night

            d.SetFVF(D3D9.Fvf.XyzTex1);
            d.SetSamplerState(0, D3D9.Samp.AddressU, (uint)D3D9.Address.Wrap);
            d.SetSamplerState(0, D3D9.Samp.AddressV, (uint)D3D9.Address.Wrap);
            d.SetTextureStageState(0, D3D9.Tss.TextureTransformFlags, (uint)D3D9.Ttff.Count2);

            // Draw farthest (largest radius) first.
            var ordered = new List<SkyLayer>(_cloudLayers);
            ordered.Sort((a, b) => b.Radius.CompareTo(a.Radius));

            foreach (var layer in ordered) {
                if (layer.Texture == IntPtr.Zero) continue;

                // Scroll + per-layer parallax offset (UV space).
                float offU = t * layer.ScrollVel.X + cam.WorldPos.X * layer.ParallaxFactor;
                float offV = t * layer.ScrollVel.Y + cam.WorldPos.Y * layer.ParallaxFactor;
                var texM = Matrix4x4.Identity;
                texM.M31 = offU; texM.M32 = offV;   // 2D translate for D3DTTFF_COUNT2
                d.SetTransform(D3D9.Ts.Texture0, texM);

                d.SetTransform(D3D9.Ts.World, DomeWorld(cam, layer.Radius));
                d.SetTexture(0, layer.Texture);

                d.SetRenderState(D3D9.Rs.AlphaBlendEnable, 1);
                if (layer.Additive) {
                    d.SetRenderState(D3D9.Rs.SrcBlend, (uint)D3D9.Blend.One);
                    d.SetRenderState(D3D9.Rs.DestBlend, (uint)D3D9.Blend.One);
                }
                else {
                    d.SetRenderState(D3D9.Rs.SrcBlend, (uint)D3D9.Blend.SrcAlpha);
                    d.SetRenderState(D3D9.Rs.DestBlend, (uint)D3D9.Blend.InvSrcAlpha);
                }
                d.SetRenderState(D3D9.Rs.TextureFactor, D3D9.Argb(layer.BaseAlpha, lit, lit, lit));

                // colour = texture.rgb * tfactor.rgb (daylight tint); alpha = texture.a * tfactor.a
                d.SetTextureStageState(0, D3D9.Tss.ColorOp, (uint)D3D9.Top.Modulate);
                d.SetTextureStageState(0, D3D9.Tss.ColorArg1, (uint)D3D9.Ta.Texture);
                d.SetTextureStageState(0, D3D9.Tss.ColorArg2, (uint)D3D9.Ta.TFactor);
                d.SetTextureStageState(0, D3D9.Tss.AlphaOp, (uint)D3D9.Top.Modulate);
                d.SetTextureStageState(0, D3D9.Tss.AlphaArg1, (uint)D3D9.Ta.Texture);
                d.SetTextureStageState(0, D3D9.Tss.AlphaArg2, (uint)D3D9.Ta.TFactor);

                fixed (VertexPT* p = _cloudDome!.Textured)
                    d.DrawPrimitiveUP(D3D9.Prim.TriangleList, (uint)_cloudDome.TriangleCount, p, 20);
            }
        }

        // ==================================================================
        // Teardown
        // ==================================================================

        /// <summary>
        /// Release textures on the CURRENT device. Render thread only. Safe only while the device
        /// pointer is still the one the textures were created on.
        /// </summary>
        public void ReleaseGpu() {
            // Tear down the live compositor's D3D11 objects + D3D9 upload texture. It tracks its own
            // client-device pointer and only Release()s the D3D9 texture if it still belongs to the
            // live device (otherwise the device is gone and the texture died with it).
            _live?.ReleaseGpu(ClientState.GetDevicePointer());

            if (ClientState.GetDevicePointer() != _device) {
                // Device already gone; textures died with it. Just drop handles.
                foreach (var l in _cloudLayers) l.Texture = IntPtr.Zero;
                _starTexture = IntPtr.Zero;
                _assetsLoaded = false;
                return;
            }
            foreach (var l in _cloudLayers) { _tex.ReleaseTexture(l.Texture); l.Texture = IntPtr.Zero; }
            _tex.ReleaseTexture(_starTexture); _starTexture = IntPtr.Zero;
            _assetsLoaded = false;
        }
    }
}
