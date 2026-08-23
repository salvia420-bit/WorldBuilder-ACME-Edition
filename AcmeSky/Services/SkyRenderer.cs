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
        /// <summary>Cloud-plane vertex buffers, keyed by tile scale (uvScale*1000, rounded).</summary>
        private readonly Dictionary<int, VertexPCT[]> _cloudVerts = new();

        /// <summary>
        /// Elevation below which the cloud-plane projection stops diverging, and over which the deck
        /// fades out.
        ///
        /// RETAIL DERIVATION (gfxobj 0x01004C36, the Dereth cloud canopy). Retail's clouds are a
        /// 9-vertex / 12-triangle drooping "umbrella": apex (0,0,+780) with uv (2.5,2.5), an inner
        /// ring at (+/-5044.63, +/-5044.63, +487.5) and an outer rim at (+/-10087.7, +/-10087.7,
        /// -400), uv running 0.482..4.518 -- i.e. a 256px plate tiled ~4x over a 20175-unit span, so
        /// one tile is ~5000 units and the plane sits 780 above the eye. In this renderer's
        /// projection form that is <c>uvScale = 780/5000 = 0.156</c> (see <see cref="RetailUvScale"/>).
        /// The rim reaches elevation atan(-400/14266) = -1.6 degrees, and because it is a real mesh
        /// edge the UV density is BOUNDED there -- which is exactly what capping the projection at
        /// |uv-centre| = 2.018 does: <c>zMin = 0.156/2.018</c> =&gt; 4.4 degrees. Hence the 4.4/-2/6
        /// numbers below: cap where retail's rim caps, and fade over the last couple of degrees
        /// where retail simply runs out of mesh.
        /// </summary>
        private const float HorizonCapDeg = 4.4f;
        private const float HorizonFadeStartDeg = -2f;    // alpha 0 at or below (retail rim = -1.6)
        private const float HorizonFadeEndDeg = 6f;       // full alpha at or above

        /// <summary>Retail's cloud-plane tile scale: plane height 780 / tile size 5000 (gfxobj
        /// 0x01004C36). Layers scale around this.</summary>
        private const float RetailUvScale = 0.156f;

        /// <summary>
        /// Reference amb_bright used to turn the palette's LIGHTING brightness into a display scale
        /// for the sky gradient: the brightest keyframe of the brightest class (clear noon, 0.228).
        /// The renderer used to ignore amb_bright/dir_bright ENTIRELY and paint raw amb_color /
        /// fog_color, which is why midnight rendered as a bright mid-blue day sky: at t=0 the clear
        /// palette's amb_color is still (0.30,0.40,0.68) and only amb_bright (0.038) says "night".
        /// Normalising against a GLOBAL reference (not each class's own max) also preserves the
        /// weather darkening baked into the palettes -- storm noon peaks at 0.087, i.e. 38% of clear.
        /// </summary>
        private const float PaletteAmbBrightRef = 0.228f;

        // Textures / layers. Textures are cached BY FILE NAME (several weather stacks reuse the
        // same plate), and the layer stack itself is rebuilt whenever the weather class changes.
        private readonly List<SkyLayer> _cloudLayers = new();
        private readonly Dictionary<string, IntPtr> _texCache = new(StringComparer.Ordinal);
        private string _layerClass = "";
        private IntPtr _starTexture;
        private bool _assetsLoaded;

        // Device tracking: a changed pointer means the device was re-created and our textures died.
        private IntPtr _device;

        /// <summary>Master enable. When false, the hook still suppresses the retail sky but we draw nothing.</summary>
        public bool Enabled { get; set; } = true;

        /// <summary>Weather class name selecting the palette + cloud look. Empty/"auto" = resolve from
        /// the client's own weather flag each frame (see <see cref="SkyConfig.ResolveWeatherClass"/>);
        /// set from sky.cfg `skyweatheroverride` to pin one palette for screenshots.</summary>
        public string WeatherClass { get; set; } = "";

        /// <summary>Brightness multiplier on the atmosphere gradient (palette LUTs are linear/dim).</summary>
        public float AtmosphereBoost { get; set; } = 1.35f;

        // ==================================================================
        // Path select + diagnostics -- FILE-driven, hot-reloaded
        //
        // These used to be `static readonly`-style ENVIRONMENT reads (ACMESKY_LIVE / ACMESKY_TESTGRADIENT
        // / ACMESKY_DIAG / ACMESKY_SKY_TIME). That was the bug behind "the clouds don't look like retail":
        // the injected acclient does NOT inherit the launcher .bat's env (SkyConfig's own remarks say so
        // -- it exists for exactly that reason), so every deployed build booted with the env defaults
        //     testGradient=True  diag=True  live=False
        // i.e. the takram volumetric compositor was OFF and the primitive baked fallback drew a
        // HARDCODED orange/blue diagnostic band instead of the palette. Nobody could turn either off
        // without a rebuild, because sky.cfg had no key for them.
        //
        // Now every one of them is a sky.cfg key (C:\Temp\acdt\sky.cfg), re-read once per second, with
        // shipping defaults: live=1, testgradient=0, diag=1. Env still overrides the defaults on the
        // dev box; the file overrides everything.
        // ==================================================================

        /// <summary>Path/diag/screenshot knobs, shared with <see cref="LiveSkyCompositor"/> so both
        /// halves of the plugin always agree on time/weather/mode. Reloaded once per second.</summary>
        private readonly SkyConfig _cfg;
        private long _lastCfgReloadTicks = -Stopwatch.Frequency;
        private string _lastCfgSignature = "";
        private bool _cfgSignatureLogged;   // see ReloadConfigThrottled: the first pass always logs

        /// <summary>Baked path: draw a fixed BRIGHT gradient instead of the palette sample (a
        /// known-good "is anything reaching the screen?" probe). sky.cfg `testgradient = 1`.</summary>
        public bool TestGradient => _cfg.TestGradient > 0.5f;

        /// <summary>Throttled per-second frame diagnostics. sky.cfg `diag = 0` to silence.</summary>
        public bool DiagFrameLog => _cfg.Diag > 0.5f;

        /// <summary>
        /// Route the after==0 backdrop slot through <see cref="LiveSkyCompositor"/> -- the takram
        /// volumetric cloud + Bruneton atmosphere renderer on our own D3D11 device, read back and
        /// composited on the client's D3D9 device. THIS is the real sky; the baked domes are only a
        /// fallback for when the compositor cannot start. sky.cfg `live = 0` forces the fallback.
        /// The retail sky stays suppressed either way (the hook does that).
        /// </summary>
        public bool Live => _cfg.LiveMode > 0.5f;

        /// <summary>
        /// Forced time-of-day (0..1), sky.cfg `skytimeoverride` (alias `time`). &lt;0 = use the client
        /// clock. The in-game clock comes from the vanilla ACE server and cannot be set, so this is
        /// the ONLY way to screenshot a specific noon/dusk/night sky. It is hot-reloaded, so the
        /// override can be swept live without a relaunch. It also rescues the known stuck-clock quirk
        /// (present_time_of_day pinned at 0.0 = a dead-black midnight sky over a daylit world).
        /// </summary>
        public float ForcedTime => _cfg.ForcedTime;

        /// <summary>The live compositor, constructed + warmed on the managed thread in the ctor
        /// whenever <c>live</c> was on at boot. Null when it could not start (=&gt; baked fallback).</summary>
        private LiveSkyCompositor? _live;

        private bool _firstFrameLogged;
        private long _lastFrameLogTicks;
        private long _lastErrTicks;

        public SkyRenderer(string assetDir, TextureLoader tex, SkyPalette palette, ILogger log) {
            _assetDir = assetDir; _tex = tex; _palette = palette; _log = log;

            // Resolve the path/diag/screenshot knobs BEFORE anything else: defaults -> env (dev box)
            // -> sky.cfg file (the only knob the injected client actually sees).
            _cfg = SkyConfig.FromDefaultsAndEnv();
            bool cfgFound = _cfg.Reload();

            EnsureLayersFor(SkyConfig.IsWeatherClass(_cfg.WeatherClass) ? _cfg.WeatherClass : "clear");
            _log.LogInformation(
                "acmesky: SkyRenderer built (assetDir={Dir}, palettesLoaded={PL}, classes={Cls}, " +
                "cfg={Cfg}, testGradient={TG}, diag={DG}, live={LV}, skyTimeOverride={ST}, skyWeatherOverride={SW})",
                _assetDir, _palette.Loaded, string.Join(",", _palette.Classes),
                cfgFound ? _cfg.LoadedFrom : "(defaults)",
                TestGradient, DiagFrameLog, Live,
                ForcedTime < 0f ? "live-clock" : ForcedTime.ToString("F3"),
                string.IsNullOrEmpty(_cfg.WeatherClass) ? "auto" : _cfg.WeatherClass);

            // Live compositor is created + warmed HERE, on the managed Initialize thread — NOT lazily
            // in Render (the native detour thread), where the Vortice assembly load / D3DCompile
            // throws 0x80131509 and the silent SkyHook catch turned that into a permanently BLACK sky
            // (retail suppressed, nothing drawn, nothing logged). If warmup fails, Render falls back
            // to the baked dome path so the sky is never black.
            // Crash-loop guard: if the previous run died inside the live path (native AV in the
            // readback/upload, uncatchable), boot into the baked fallback rather than crashing again.
            bool liveCrashedLastRun = false;
            try { liveCrashedLastRun = File.Exists(SkyConfig.LiveProbePath()); } catch { }
            if (Live && liveCrashedLastRun) {
                _log.LogWarning(
                    "acmesky: the previous session died inside the LIVE sky path ({Flag} present); " +
                    "using the baked domes this run. Delete that file to re-arm the live compositor.",
                    SkyConfig.LiveProbePath());
                _cfg.LiveMode = 0f;
            }

            if (Live) {
                try {
                    _live = new LiveSkyCompositor(_log, _assetDir, _cfg);
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
        /// The cloud stack for one weather class.
        ///
        /// This used to be ONE hardcoded stack -- a broken cumulus deck at 0.85 alpha plus cirrus --
        /// drawn for every weather class, which is why the client showed a heavy overcast while the
        /// palette said "clear". Retail keys its cloud objects off the DayGroup the region's SkyDesc
        /// selects (SkyDesc::CalcPresentDayGroup hashes the calendar date; Dereth has 20 groups named
        /// Sunny x6 / Clear x3 / Cloudy x3 / Rainy x8, each with its own cloud GfxObj and tex
        /// velocity). We do the same with the two baked plates we have, varying which plate is drawn,
        /// how opaque it is, its tile scale and how dark the deck reads.
        ///
        /// SCROLL SPEEDS are retail's own SkyObject.tex_velocity values (uv/sec, applied by
        /// CPhysics::UpdateTexVelocity as uv += vel*dt wrapped at 1.0, pushed to D3D as a
        /// D3DTS_TEXTURE0 translation in D3DPolyRender::RenderMeshSubset -- translation only, retail
        /// never rotates cloud UVs): (-0.013,+0.013) is Dereth DayGroup 0's cloud object,
        /// (+0.005,-0.0073) another group's. At ~0.018 uv/s a tile crosses in under a minute, which
        /// is why retail clouds visibly drift.
        ///
        /// Layers are drawn far-to-near, so the high cirrus veil is listed with the larger radius.
        /// </summary>
        private static List<SkyLayer> LayersFor(string weatherClass) {
            SkyLayer Cirrus(float alpha, float uvScale) => new() {
                TextureFile = "cloud_cirrus_clear.askytex",
                Radius = 1100f,
                ScrollVel = new Vector2(0.0050f, -0.0073f),  // retail tex_velocity (a slower group)
                ParallaxFactor = 2e-5f,
                BaseAlpha = alpha,
                UvScale = uvScale,
                TintScale = 1f,
            };
            SkyLayer Deck(float alpha, float uvScale, float tint) => new() {
                TextureFile = "cloud_low_broken.askytex",
                Radius = 700f,
                ScrollVel = new Vector2(-0.0130f, 0.0130f),  // retail Dereth DayGroup 0 cloud object
                ParallaxFactor = 6e-5f,
                BaseAlpha = alpha,
                UvScale = uvScale,
                TintScale = tint,
            };

            return weatherClass switch {
                // sparse high veil only -- mostly open sky. Larger tiles = higher, slower clouds.
                "clear" => new List<SkyLayer> { Cirrus(0.30f, RetailUvScale * 0.70f) },
                // a veil plus a thin, widely spaced cumulus deck
                "scattered" => new List<SkyLayer> { Cirrus(0.40f, RetailUvScale * 0.75f),
                                                   Deck(0.34f, RetailUvScale * 0.90f, 1.00f) },
                // the classic broken deck at retail's own tile scale (what the plate was baked for)
                "broken" => new List<SkyLayer> { Cirrus(0.34f, RetailUvScale * 0.80f),
                                                Deck(0.72f, RetailUvScale, 0.97f) },
                // solid lid: tighter tiles, near-opaque, progressively shaded underside
                "overcast" => new List<SkyLayer> { Deck(0.94f, RetailUvScale * 1.25f, 0.80f) },
                "rain" => new List<SkyLayer> { Deck(0.97f, RetailUvScale * 1.40f, 0.70f) },
                "storm" => new List<SkyLayer> { Deck(1.00f, RetailUvScale * 1.60f, 0.58f) },
                _ => new List<SkyLayer> { Cirrus(0.34f, RetailUvScale * 0.80f),
                                          Deck(0.72f, RetailUvScale, 0.97f) },
            };
        }

        /// <summary>Swap the live layer stack when the resolved weather class changes.</summary>
        private void EnsureLayersFor(string weatherClass) {
            if (string.Equals(_layerClass, weatherClass, StringComparison.Ordinal) && _cloudLayers.Count > 0)
                return;
            _layerClass = weatherClass;
            _cloudLayers.Clear();
            _cloudLayers.AddRange(LayersFor(weatherClass));
            _cloudLayers.Sort((a, b) => b.Radius.CompareTo(a.Radius));   // painter's order: far -> near
            _assetsLoaded = false;   // fresh SkyLayer objects carry no texture handle yet
        }

        // ==================================================================
        // Lazy GPU init / device-loss handling
        // ==================================================================

        private void EnsureGeometry() {
            _sphere ??= DomeMesh.Build(slices: 48, stacks: 24, minElevationDeg: -90f, maxElevationDeg: 90f);
            // 64 slices x 24 stacks: the cloud-plane projection compresses the texture hard toward
            // the horizon, so the deck needs more rings there than the old 48x18 to avoid faceting.
            _cloudDome ??= DomeMesh.Build(slices: 64, stacks: 24, minElevationDeg: -15f, maxElevationDeg: 90f);
            if (_atmoVerts is null && _sphere is not null) {
                _atmoVerts = new VertexPC[_sphere.Textured.Length];
                for (int i = 0; i < _atmoVerts.Length; i++) {
                    var p = _sphere.Textured[i];
                    _atmoVerts[i] = new VertexPC { X = p.X, Y = p.Y, Z = p.Z, Color = 0xFFFFFFFF };
                }
            }
        }

        /// <summary>Cloud-plane vertices for one layer's tile scale, built once per distinct scale.
        /// Colour is rewritten per frame (tint + horizon fade), so one buffer per scale is enough.</summary>
        private VertexPCT[] CloudVertsFor(float uvScale) {
            int key = (int)MathF.Round(uvScale * 1000f);
            if (!_cloudVerts.TryGetValue(key, out var v)) {
                v = _cloudDome!.BuildCloudPlane(uvScale, HorizonCapDeg);
                _cloudVerts[key] = v;
            }
            return v;
        }

        private void EnsureTextures(Device d) {
            if (_assetsLoaded) return;
            foreach (var layer in _cloudLayers) layer.Texture = GetTexture(d, layer.TextureFile);
            if (_starTexture == IntPtr.Zero) _starTexture = GetTexture(d, "stars_equirect.askytex");
            _assetsLoaded = true;
        }

        /// <summary>Upload a plate once and share it across every weather stack that names it.</summary>
        private IntPtr GetTexture(Device d, string file) {
            if (_texCache.TryGetValue(file, out var t) && t != IntPtr.Zero) return t;
            t = _tex.Upload(d, _tex.ReadFile(Path.Combine(_assetDir, file)));
            _texCache[file] = t;
            return t;
        }

        /// <summary>
        /// Handle a device pointer that changed since last frame: the old device (and every texture
        /// on it) is gone, so we drop the handles WITHOUT releasing them (releasing would call into
        /// freed memory) and reload against the new device.
        /// </summary>
        private void OnDeviceChanged(IntPtr newDev) {
            foreach (var layer in _cloudLayers) layer.Texture = IntPtr.Zero;
            _texCache.Clear();
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
            // Outer guard: the pre-draw section (device/camera/geometry/palette) used to be protected
            // only by SkyHook's SILENT catch, so any throw there produced a black sky with no clue.
            // Log it (throttled) so a broken frame is diagnosable instead of invisible.
            try { RenderInner(after); }
            catch (Exception ex) { LogErrThrottled(ex, "render-outer"); }
        }

        /// <summary>Re-read sky.cfg at most once per second so `live`, `testgradient`,
        /// `skytimeoverride` and `skyweatheroverride` are hot-tunable in-game. (The live compositor
        /// reloads the SAME instance on its own throttle; a double read is harmless.)</summary>
        private void ReloadConfigThrottled() {
            long now = _clock.ElapsedTicks;
            if (now - _lastCfgReloadTicks < Stopwatch.Frequency) return;
            _lastCfgReloadTicks = now;

            // PACING (2026-08-23): mtime-gated (SkyConfig.ReloadIfChanged) — this runs on the render
            // thread, and a full read+parse plus the HotSignature() string every second is exactly
            // the kind of once-a-second cost that lands in the 1% lows. When nothing was re-read the
            // signature cannot have changed either, so both are skipped. The FIRST call still falls
            // through (no signature yet) so the startup line still prints.
            bool changed = _cfg.ReloadIfChanged();
            if (!changed && _cfgSignatureLogged) return;
            _cfgSignatureLogged = true;
            bool found = _cfg.LoadedFrom != null;
            // Log ONLY when an edit actually landed. Without this a mis-parsed sky.cfg is invisible
            // -- which is exactly how the inline-comment bug (see SkyConfig.StripInlineComment) hid
            // for so long: the file was being read, every key was being thrown away, and nothing
            // said so. Now an edit that takes effect prints, and an edit that prints nothing means
            // the plugin did not see it.
            string sig = _cfg.HotSignature();
            if (!string.Equals(sig, _lastCfgSignature, StringComparison.Ordinal)) {
                _lastCfgSignature = sig;
                _log.LogInformation("acmesky: sky.cfg [{Src}] -> {Sig}",
                    found ? _cfg.LoadedFrom : "(no file; defaults)", sig);
            }
        }

        private void RenderInner(int after) {
            ReloadConfigThrottled();

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

            // WEATHER -> PALETTE. Previously WeatherClass was a property nothing ever wrote, so the
            // baked path drew the "clear" palette forever regardless of the client's weather. Now the
            // class is resolved every frame: sky.cfg `skyweatheroverride` wins (screenshot sweeps),
            // else the client's own GameSky::s_weatherEnabled flag picks storm vs clear.
            string cls = SkyConfig.IsWeatherClass(WeatherClass)
                ? WeatherClass
                : _cfg.ResolveWeatherClass(weatherOn);
            var sample = _palette.Sample(cls, time);
            // Palette missing (the assets/ dir failed to ship or was unreadable -- it has happened:
            // "palettesLoaded=False -> black sky" under wine) leaves an all-zero Sample, which would
            // paint a black sky over a lit world. Substitute a neutral daylight palette instead.
            if (!_palette.Loaded || (sample.AmbColor == Vector3.Zero && sample.FogColor == Vector3.Zero)) {
                sample = new SkyPaletteData.Sample(
                    dir: new Vector3(1f, 0.98f, 0.94f), dirB: 1f,
                    amb: new Vector3(0.19f, 0.46f, 1f), ambB: PaletteAmbBrightRef,
                    fog: new Vector3(0.32f, 0.45f, 0.72f), sunEl: 45f);
            }
            EnsureLayersFor(cls);

            float sunEl = sample.SunElevationDeg;
            float dayness = Math.Clamp((sunEl + 6f) / 12f, 0f, 1f);
            float starFade = Math.Clamp(-(sunEl + 4f) / 8f, 0f, 1f);

            // Day/night + weather DISPLAY scale from the palette's own lighting brightness
            // (see PaletteAmbBrightRef). ^0.8 keeps night dark without crushing it to black.
            float skyScale = MathF.Pow(
                Math.Clamp(sample.AmbBright / PaletteAmbBrightRef, 0.02f, 1f), 0.8f);

            // Atmosphere endpoints. TestGradient forces a known-bright band so we can confirm the draw
            // path visibly reaches the screen regardless of palette/time correctness.
            Vector3 horizon, zenith;
            if (TestGradient) {
                horizon = new Vector3(1.0f, 0.55f, 0.15f);   // warm bright horizon
                zenith  = new Vector3(0.15f, 0.45f, 1.0f);   // bright blue zenith
            }
            else {
                horizon = sample.FogColor * (AtmosphereBoost * skyScale);
                zenith  = sample.AmbColor * (AtmosphereBoost * skyScale);
            }

            // CLOUD LIGHTING. The plates are baked with their own internal shading, so all we apply
            // is the palette's light: the sun term (dir_color * dir_bright, zero at night) plus a
            // share of the ambient sky. This replaces the old flat grey `0.25 + 0.75*dayness`
            // TEXTUREFACTOR, which multiplied an already grey-blue plate down to ~(47,48,51) at
            // night -- the "dark navy silhouettes" the client was showing.
            Vector3 cloudLit = sample.DirColor * (sample.DirBright * 0.80f)
                             + sample.AmbColor * (skyScale * 0.55f);
            cloudLit = Vector3.Clamp(cloudLit, Vector3.Zero, Vector3.One);

            // CLOUD NIGHT FADE -- retail behaviour, not an invention. Dereth's DayGroup 0 gives its
            // cloud SkyObject `transparent = 100` at the midnight SkyTimeOfDay and `transparent = 0`
            // at midday, lerped between the bracketing records (SkyDesc::GetSky), and
            // CPhysicsPart::SetTranslucency special-cases translucency == 1.0 by setting
            // draw_state |= 1, which makes CPhysicsPart::Draw SKIP the part entirely. So retail draws
            // NO clouds at night -- just the dimmed sky box and the stars. We fade the same way.
            float cloudFade = dayness * dayness * (3f - 2f * dayness);   // smoothstep on dayness

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
                    haveClock, time, weatherOn, cls,
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
                        "skyScale={SS:F2} zenith=({ZR:F2},{ZG:F2},{ZB:F2}) " +
                        "cloudLit=({CR:F2},{CG:F2},{CB:F2}) cloudFade={CF:F2} layers={NL} path=baked",
                        after, time, cls, sunEl, dayness, skyScale,
                        zenith.X, zenith.Y, zenith.Z,
                        cloudLit.X, cloudLit.Y, cloudLit.Z, cloudFade, _cloudLayers.Count);
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
                    try { if (cloudFade > 0.004f) DrawClouds(device, cam, cloudLit, cloudFade); }
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

        /// <summary>
        /// Draw the weather class's cloud stack, far layer first.
        ///
        /// Three things changed from the version that produced "enormous opaque dark-navy blobs":
        ///  1. GEOMETRY/UV -- the deck now uses <c>DomeMesh.BuildCloudPlane</c> (a horizontal cloud
        ///     plane the view ray is projected onto), not the equirect star mapping that smeared a
        ///     512px plate into a handful of continent-sized wedges around the zenith.
        ///  2. LIGHTING -- per-vertex diffuse carries the palette-derived <paramref name="cloudLit"/>
        ///     colour instead of a flat grey TEXTUREFACTOR that crushed the plate to near-black
        ///     whenever dayness was 0.
        ///  3. HORIZON FADE -- the same per-vertex alpha ramps the deck out below ~9 degrees of
        ///     elevation, where the plane projection compresses to infinite frequency. Retail hides
        ///     the same problem behind its fog band; we fade instead.
        /// Blending stays straight alpha (SrcAlpha/InvSrcAlpha): the plates are STRAIGHT-alpha
        /// (verified -- opaque texels read ~(205,194,188) BGRA, not premultiplied).
        /// </summary>
        private unsafe void DrawClouds(Device d, in ClientState.Camera cam, Vector3 cloudLit, float cloudFade) {
            float t = (float)_clock.Elapsed.TotalSeconds;
            var el = _cloudDome!.Elevation;
            float fadeLo = HorizonFadeStartDeg * MathF.PI / 180f;
            float fadeHi = HorizonFadeEndDeg * MathF.PI / 180f;

            d.SetFVF(D3D9.Fvf.XyzDiffuseTex1);
            d.SetSamplerState(0, D3D9.Samp.AddressU, (uint)D3D9.Address.Wrap);
            d.SetSamplerState(0, D3D9.Samp.AddressV, (uint)D3D9.Address.Wrap);
            d.SetTextureStageState(0, D3D9.Tss.TextureTransformFlags, (uint)D3D9.Ttff.Count2);
            d.SetRenderState(D3D9.Rs.ColorVertex, 1);

            foreach (var layer in _cloudLayers) {   // already sorted far -> near by EnsureLayersFor
                if (layer.Texture == IntPtr.Zero) continue;

                var verts = CloudVertsFor(layer.UvScale);
                Vector3 tint = cloudLit * layer.TintScale;
                for (int i = 0; i < verts.Length; i++) {
                    float f = Math.Clamp((el[i] - fadeLo) / MathF.Max(1e-4f, fadeHi - fadeLo), 0f, 1f);
                    f = f * f * (3f - 2f * f);                       // smoothstep into the horizon
                    verts[i].Color = D3D9.Argb(layer.BaseAlpha * cloudFade * f, tint.X, tint.Y, tint.Z);
                }

                // Scroll + per-layer parallax offset, now in CLOUD-PLANE uv (real horizontal drift).
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

                // colour = texture.rgb * diffuse.rgb (palette light); alpha = texture.a * diffuse.a
                // (coverage * horizon fade).
                d.SetTextureStageState(0, D3D9.Tss.ColorOp, (uint)D3D9.Top.Modulate);
                d.SetTextureStageState(0, D3D9.Tss.ColorArg1, (uint)D3D9.Ta.Texture);
                d.SetTextureStageState(0, D3D9.Tss.ColorArg2, (uint)D3D9.Ta.Diffuse);
                d.SetTextureStageState(0, D3D9.Tss.AlphaOp, (uint)D3D9.Top.Modulate);
                d.SetTextureStageState(0, D3D9.Tss.AlphaArg1, (uint)D3D9.Ta.Texture);
                d.SetTextureStageState(0, D3D9.Tss.AlphaArg2, (uint)D3D9.Ta.Diffuse);

                fixed (VertexPCT* p = verts)
                    d.DrawPrimitiveUP(D3D9.Prim.TriangleList, (uint)_cloudDome.TriangleCount, p, 24);
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

            // Textures are owned by _texCache (shared across weather stacks), so release from THERE
            // exactly once -- releasing per-layer would double-Release a plate used by two layers.
            bool deviceGone = ClientState.GetDevicePointer() != _device;
            foreach (var l in _cloudLayers) l.Texture = IntPtr.Zero;
            if (!deviceGone) {
                foreach (var t in _texCache.Values) _tex.ReleaseTexture(t);
            }
            _texCache.Clear();
            _starTexture = IntPtr.Zero;   // the star plate lives in _texCache too
            _assetsLoaded = false;
        }
    }
}
