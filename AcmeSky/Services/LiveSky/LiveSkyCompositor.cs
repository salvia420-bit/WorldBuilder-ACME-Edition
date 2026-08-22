using System;
using System.Diagnostics;
using System.IO;
using System.Numerics;
using System.Runtime.InteropServices;
using AcmeSky.Lib;
using Microsoft.Extensions.Logging;

using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.D3DCompiler;

namespace AcmeSky.Services.LiveSky {
    /// <summary>
    /// LIVE in-process sky compositor.
    ///
    /// MILESTONE 0 (plumbing, unchanged): our OWN Direct3D 11 device renders a fullscreen pass into a
    /// B8G8R8A8_UNORM offscreen RT, copies it to a staging texture, reads it back, uploads to a
    /// D3DUSAGE_DYNAMIC A8R8G8B8 texture on the client's D3D9 device, and draws it as an XYZRHW|TEX1
    /// fullscreen quad wrapped in a <see cref="RenderStateGuard"/>. That path (device, RT/staging,
    /// readback, D3D9 upload + quad) is UNTOUCHED here.
    ///
    /// MILESTONE 1 (this file): the D3D11 side now renders the REAL Bruneton precomputed-scattering
    /// atmosphere (physically-lit sky gradient + sun/moon disc), world-anchored via a per-pixel camera
    /// ray, cycling with time of day -- instead of the M0 test pattern. Everything the shader needs
    /// (inverse projection/view, camera position, sun/moon direction, the AC->shader axis mapping, the
    /// exposure/tonemap knobs) is packed into <see cref="SkyCb"/>; the three baked LUTs
    /// (transmittance 2D, scattering 3D, irradiance 2D) are loaded once as R16G16B16A16_FLOAT textures.
    ///
    /// The M0 test pattern is kept reachable: ACMESKY_TESTPATTERN=1 forces it. If the atmosphere shader
    /// fails to compile or the LUTs fail to load, we log and fall back to the test pattern rather than
    /// crash. <see cref="Frame"/> NEVER lets an exception escape (it is called from the native detour).
    ///
    /// ENV KNOBS (read once): ACMESKY_TESTPATTERN=1 (force M0 pattern); ACMESKY_SKY_EXPOSURE (default 5);
    /// ACMESKY_SKY_AXIS (AC->shader spec, default "x,z,-y"); ACMESKY_SKY_OUTPUT (0 AgX+sRGB [default],
    /// 1 AgX linear, 2 raw exposure, 3 exposure+sRGB no AgX); ACMESKY_SKY_LUTFLIPV (0/1); ACMESKY_SKY_SUNANG
    /// (0.03); ACMESKY_SKY_MOONANG (0.025); ACMESKY_SKY_LUNAR (moon disc scale, default 1).
    /// </summary>
    public sealed class LiveSkyCompositor {
        private readonly ILogger _log;
        private readonly string _atmoDir;
        private readonly Stopwatch _clock = Stopwatch.StartNew();

        // --- our private D3D11 side ---
        private ID3D11Device? _dev;
        private ID3D11DeviceContext? _ctx;
        private ID3D11VertexShader? _vs;
        private ID3D11PixelShader? _psTest;    // M0 test pattern
        private ID3D11PixelShader? _psAtmo;    // M1 atmosphere
        private ID3D11VertexShader? _vsStars;  // M3 stars (PointList)
        private ID3D11PixelShader? _psStars;
        private ID3D11Buffer? _starBuf;        // StructuredBuffer<StarVert>, immutable
        private ID3D11ShaderResourceView? _starSrv;
        private int _starCount;
        // --- M2 clouds ---
        private ID3D11PixelShader? _psClouds;         // raymarch into the half-res cloud RT
        private ID3D11PixelShader? _psCloudComposite; // premultiplied-over composite onto the sky
        private SkyLut? _texWeather, _texShape, _texShapeDetail, _texStbn, _texTurbulence;
        private ID3D11SamplerState? _samplerWrap;
        private ID3D11BlendState? _blendPremul;
        private ID3D11Texture2D? _cloudRt;
        private ID3D11RenderTargetView? _cloudRtv;
        private ID3D11ShaderResourceView? _cloudSrv;
        private int _cloudW, _cloudH;
        // --- M2.2 temporal resolve: velocity MRT + resolved/history ping-pong ---
        private ID3D11PixelShader? _psCloudResolve;
        private ID3D11Texture2D? _cloudVelRt;
        private ID3D11RenderTargetView? _cloudVelRtv;
        private ID3D11ShaderResourceView? _cloudVelSrv;
        private readonly ID3D11Texture2D?[] _cloudResolveRt = new ID3D11Texture2D?[2];
        private readonly ID3D11RenderTargetView?[] _cloudResolveRtv = new ID3D11RenderTargetView?[2];
        private readonly ID3D11ShaderResourceView?[] _cloudResolveSrv = new ID3D11ShaderResourceView?[2];
        private int _cloudResolveIdx;
        private bool _cloudHistValid;
        private Matrix4x4 _prevWorldToClip = Matrix4x4.Identity;
        private bool _prevWorldToClipValid;
        private Vector3 _prevLbOffset;
        private bool _prevLbOffsetValid;
        private uint _lastCellId;
        private Vector3 _lastGlobalCam;
        private bool _cloudsUsable;
        private long _cloudFrameIndex;
        private Vector2 _weatherOfs;                  // wind-accumulated local weather offset
        private double _lastWindSeconds = -1;
        private ID3D11Buffer? _cb;
        private ID3D11SamplerState? _sampler;
        private SkyLut? _lutTransmittance, _lutScattering, _lutIrradiance;
        private ID3D11Texture2D? _rt;
        private ID3D11RenderTargetView? _rtv;
        private ID3D11Texture2D? _staging;
        private bool _d3d11Failed;   // creation permanently failed -> live compositor disabled
        private bool _atmoUsable;    // atmosphere PS + LUTs ready
        private int _w, _h;          // current D3D11 target size

        // --- the client D3D9 upload texture ---
        private IntPtr _d3d9tex;     // IDirect3DTexture9*
        private IntPtr _d3d9dev;     // device pointer the above was created on
        private int _texW, _texH;

        // --- knobs: seeded from defaults+env, then live-reloaded from the sky.cfg FILE each second
        //     (the client process does not reliably inherit env vars, so the file is the real knob). ---
        private readonly bool _forceTest;
        private readonly SkyConfig _cfg;
        private Matrix4x4 _acToShader;
        private string _acToShaderAxis = "";
        // ⚠ throttle timestamps must NOT be long.MinValue: `now - long.MinValue` overflows
        // NEGATIVE (x - MinValue == x + MinValue unchecked), so `< Frequency` is always true and
        // the throttled action never fires — this silently disabled BOTH the per-frame log and
        // the sky.cfg live reload in the 2026-08-21 build. -Frequency fires immediately, no wrap.
        private long _lastCfgReloadTicks = -Stopwatch.Frequency;

        // --- diagnostics ---
        private bool _firstCompositeLogged;
        private long _lastFrameLogTicks = -Stopwatch.Frequency;   // see _lastCfgReloadTicks note
        private long _lastErrTicks = -Stopwatch.Frequency;
        private long _frameCount;
        private float _lastSunPitchDeg;
        private float _lastTimeOfDay = -1f;   // resolved 0..1 used for the sun (post-fallback/ofs)
        private bool _lastStorm;              // client weather flag as of the last frame
        // last-read sample pixels (post-tonemap BGRA), for the throttled diagnostic line.
        private uint _sampZenith, _sampMid, _sampHorizon;
        // sparse bright-pixel count (every 8th px of every 8th row, any channel > 96):
        // by day it counts the whole sky (huge); at night it counts STARS — the eyes-free
        // live check that the M3 star pass actually drew (stars=0 -> ~0).
        private int _sampBright;

        private readonly string _cloudDir;

        public LiveSkyCompositor(ILogger log, string skyAssetDir) {
            _log = log;
            _atmoDir = Path.Combine(skyAssetDir, "atmosphere");
            _cloudDir = Path.Combine(skyAssetDir, "clouds");

            _forceTest = string.Equals(Environment.GetEnvironmentVariable("ACMESKY_TESTPATTERN"), "1", StringComparison.Ordinal);
            _cfg = SkyConfig.FromDefaultsAndEnv();
            _cfg.Reload();                                   // pick up C:\Temp\acdt\sky.cfg if present
            RebuildAxisIfChanged();
        }

        /// <summary>The D3D11 side is alive (device created, at minimum the M0 shaders compiled).</summary>
        public bool Usable => _dev is not null && !_d3d11Failed;

        /// <summary>
        /// Eagerly create the D3D11 device, compile ALL shaders, and load the LUT/cloud/star assets.
        /// MUST be called on the MANAGED plugin thread (Initialize), never from the native detour:
        /// loading Vortice assemblies / running D3DCompile on a native detour thread throws
        /// 0x80131509 "operation is not legal in the current state" (the plugin-ALC-load-on-native-
        /// thread fault AcmeLights hit with the same compiler and fixed the same way). The detour
        /// then only does per-frame work against already-created objects. D3D11 is free-threaded, so
        /// creating OUR device off the render thread is legal; only the D3D9 side must stay on the
        /// client's render thread (it stays lazy in Frame).
        /// </summary>
        public bool Warmup() {
            EnsureD3D11();
            return Usable;
        }

        /// <summary>Rebuild the AC->shader matrix only when the axis spec string actually changes.</summary>
        private void RebuildAxisIfChanged() {
            if (_cfg.Axis == _acToShaderAxis) return;
            _acToShaderAxis = _cfg.Axis;
            _acToShader = SkySunModel.BuildAcToShader(_cfg.Axis);
        }

        /// <summary>Re-read the sky.cfg file at most once per second (live in-game tuning).</summary>
        private void ReloadConfigThrottled() {
            long now = _clock.ElapsedTicks;
            if (now - _lastCfgReloadTicks < Stopwatch.Frequency) return;
            _lastCfgReloadTicks = now;
            if (_cfg.Reload()) RebuildAxisIfChanged();
        }

        // cbuffer payload -- MUST match cbuffer SkyParams in AtmosphereShader.Hlsl EXACTLY (288 bytes).
        [StructLayout(LayoutKind.Sequential)]
        private struct SkyCb {
            public Matrix4x4 InvProj;      // 64  inverse(ViewToClip)
            public Matrix4x4 InvView;      // 64  inverse(WorldToView)
            public Matrix4x4 AcToShader;   // 64  AC(E,N,U) -> shader y-up
            public Vector3 CameraPosAC; public float Pad0;   // 16
            public Vector3 SunDirAC;    public float Pad1;   // 16
            public Vector3 MoonDirAC;   public float Pad2;   // 16
            public Vector2 Resolution;  public float Time; public float Exposure;              // 16
            public float BottomRadiusM; public float MeterToUnit; public float SunAngRadius; public float SunAngRadiusPhys; // 16
            public float MoonAngRadius; public float LunarScale; public float LutFlipV; public float OutputMode;            // 16
            public float RayMode; public float WorldSwizzle; public float Pad4; public float Pad5;                          // 16
            // --- M3 stars ---
            public Matrix4x4 WorldToClip;   // 64  forward render-world -> clip (WV * VC)
            public Matrix4x4 EciToShader;   // 64  sidereal star rotation
            public float StarIntensity; public float StarMagMin; public float StarMagMax; public float Pad7;               // 16
            // --- M2 clouds ---
            public Vector2 CloudWeatherOfs; public float CloudCoverage; public float CloudFrame;                            // 16
            public Vector2 CloudRes; public float CloudIters; public float Pad9;                                            // 16
            public float CloudMinStep; public float CloudSunSteps; public float CloudGroundSteps; public float CloudAccurate; // 16
            public float CloudTurb; public float CloudStorm; public float CloudHazeDensity; public float PadA;                // 16
            // --- M2.2 temporal resolve ---
            public Matrix4x4 PrevWorldToClip;  // 64  LAST frame's sky-camera AC-world -> clip
            public Matrix4x4 ShaderToAc;       // 64  inverse(AcToShader)
            public float CloudTaa; public float CloudTaaGamma; public float CloudTaaAlpha; public float CloudHistValid;       // 16
            public Vector3 CameraLbOffsetAC; public float PadB;      // 16  local AC -> global AC translation
            public Vector3 PrevCameraLbOffsetAC; public float PadC;  // 16  last frame's offset
        }

        /// <summary>Screen-space textured quad vertex: D3DFVF_XYZRHW | D3DFVF_TEX1 (stride 24).</summary>
        [StructLayout(LayoutKind.Sequential)]
        private struct QuadVert { public float X, Y, Z, Rhw, U, V; }

        // ==================================================================
        // Frame entry (render thread; called from the detour)
        // ==================================================================

        /// <summary>
        /// Render the sky (atmosphere, or the M0 test pattern on fallback / ACMESKY_TESTPATTERN=1) on our
        /// D3D11 device, read it back, upload to the D3D9 dynamic texture, and composite it fullscreen on
        /// the client's D3D9 device. Never throws.
        /// </summary>
        public void Frame(Device d9, IntPtr devPtr, in ClientState.Camera cam) {
            try {
                int w = cam.ViewportW, h = cam.ViewportH;
                if (w <= 0 || h <= 0) return;

                EnsureD3D11();
                if (_dev is null || _ctx is null || _vs is null || _psTest is null || _cb is null) return;

                EnsureTargets(w, h);
                if (_rt is null || _rtv is null || _staging is null) return;

                if (devPtr != _d3d9dev) {
                    _d3d9tex = IntPtr.Zero;
                    _d3d9dev = devPtr;
                    _texW = _texH = 0;
                }
                EnsureD3D9Texture(d9, w, h);
                if (_d3d9tex == IntPtr.Zero) return;

                ReloadConfigThrottled();
                bool atmo = _atmoUsable && !_forceTest;
                RenderAndUpload(w, h, atmo, in cam);
                DrawFullscreen(d9, w, h);

                LogFrameThrottled(w, h, atmo);
            }
            catch (Exception ex) {
                LogErrThrottled(ex, "frame");
            }
        }

        // ==================================================================
        // D3D11 lazy init
        // ==================================================================

        private void EnsureD3D11() {
            if (_dev is not null || _d3d11Failed) return;
            try {
                var levels = new[] { FeatureLevel.Level_11_0 };
                var res = D3D11.D3D11CreateDevice(
                    IntPtr.Zero, DriverType.Hardware,
                    DeviceCreationFlags.BgraSupport, levels,
                    out _dev, out var fl, out _ctx);
                res.CheckError();
                if (_dev is null || _ctx is null) throw new InvalidOperationException("D3D11 device/context null");

                string adapterName = "?";
                try {
                    using var dxgiDev = _dev.QueryInterface<IDXGIDevice>();
                    using var adapter = dxgiDev.GetAdapter();
                    adapterName = adapter.Description.Description;
                }
                catch (Exception ex) { LogErrThrottled(ex, "adapter-desc"); }

                // VS + test-pattern PS MUST compile (M0 fallback depends on them).
                var vsBytes = Compiler.Compile(AtmosphereShader.Hlsl, "VSMain", "acmesky_sky.hlsl", "vs_5_0",
                    ShaderFlags.OptimizationLevel3, EffectFlags.None);
                _vs = _dev.CreateVertexShader(vsBytes.Span, null);
                var psTestBytes = Compiler.Compile(AtmosphereShader.Hlsl, "PSTest", "acmesky_sky.hlsl", "ps_5_0",
                    ShaderFlags.OptimizationLevel3, EffectFlags.None);
                _psTest = _dev.CreatePixelShader(psTestBytes.Span, null);

                var cbDesc = new BufferDescription {
                    ByteWidth = (uint)Marshal.SizeOf<SkyCb>(),
                    BindFlags = BindFlags.ConstantBuffer,
                    Usage = ResourceUsage.Dynamic,
                    CPUAccessFlags = CpuAccessFlags.Write,
                    MiscFlags = ResourceOptionFlags.None,
                    StructureByteStride = 0,
                };
                _cb = _dev.CreateBuffer(in cbDesc, (SubresourceData?)null);

                var sampDesc = new SamplerDescription {
                    Filter = Filter.MinMagMipLinear,
                    AddressU = TextureAddressMode.Clamp,
                    AddressV = TextureAddressMode.Clamp,
                    AddressW = TextureAddressMode.Clamp,
                    ComparisonFunc = ComparisonFunction.Never,
                    MinLOD = 0f,
                    MaxLOD = float.MaxValue,
                    MipLODBias = 0f,
                    MaxAnisotropy = 1,
                };
                _sampler = _dev.CreateSamplerState(sampDesc);

                var wrapDesc = sampDesc;
                wrapDesc.AddressU = TextureAddressMode.Wrap;
                wrapDesc.AddressV = TextureAddressMode.Wrap;
                wrapDesc.AddressW = TextureAddressMode.Wrap;
                _samplerWrap = _dev.CreateSamplerState(wrapDesc);

                _log.LogInformation(
                    "acmesky: LIVE D3D11 device created (adapter='{Adapter}', featureLevel={FL}, bgra=1); " +
                    "VS+testPS+cbuffer({CB}B)+sampler ready", adapterName, fl, Marshal.SizeOf<SkyCb>());

                TryInitAtmosphere();
            }
            catch (Exception ex) {
                _d3d11Failed = true;
                _log.LogError(ex, "acmesky: LIVE D3D11 init failed; live compositor disabled (baked path unaffected)");
                DisposeD3D11();
            }
        }

        /// <summary>Compile the atmosphere PS and load the 3 baked LUTs. On any failure the atmosphere is
        /// disabled and the M0 test pattern remains the render (never fatal).</summary>
        private void TryInitAtmosphere() {
            if (_forceTest) {
                _log.LogInformation("acmesky: ACMESKY_TESTPATTERN=1 -> atmosphere skipped, rendering M0 test pattern");
                return;
            }
            try {
                var psBytes = Compiler.Compile(AtmosphereShader.Hlsl, "PSAtmosphere", "acmesky_sky.hlsl", "ps_5_0",
                    ShaderFlags.OptimizationLevel3, EffectFlags.None);
                _psAtmo = _dev!.CreatePixelShader(psBytes.Span, null);

                _lutTransmittance = SkyLut.Load(_dev, Path.Combine(_atmoDir, "transmittance.bin"));
                _lutScattering = SkyLut.Load(_dev, Path.Combine(_atmoDir, "scattering.bin"));
                _lutIrradiance = SkyLut.Load(_dev, Path.Combine(_atmoDir, "irradiance.bin"));

                TryInitStars();   // never fatal: atmosphere works without stars
                TryInitClouds();  // never fatal: atmosphere works without clouds

                _atmoUsable = _psAtmo is not null &&
                              _lutTransmittance?.Srv is not null &&
                              _lutScattering?.Srv is not null &&
                              _lutIrradiance?.Srv is not null;

                if (_atmoUsable) {
                    _log.LogInformation(
                        "acmesky: LIVE atmosphere ready -- LUTs: transmittance {TW}x{TH} R16G16B16A16F 2D, " +
                        "scattering {SW}x{SH}x{SD} 3D, irradiance {IW}x{IH} 2D; dir='{Dir}' cfg='{Cfg}' " +
                        "rayMode={Ray} output={Out} exposure={Exp} axis='{Axis}' time={Time} sunAng={Sun} moonAng={Moon} lunar={Lun} lutFlipV={Flip}",
                        _lutTransmittance!.Width, _lutTransmittance.Height,
                        _lutScattering!.Width, _lutScattering.Height, _lutScattering.Depth,
                        _lutIrradiance!.Width, _lutIrradiance.Height, _atmoDir, _cfg.LoadedFrom ?? "(defaults)",
                        _cfg.RayMode, _cfg.Output, _cfg.Exposure, _cfg.Axis, _cfg.ForcedTime,
                        _cfg.SunAng, _cfg.MoonAng, _cfg.Lunar, _cfg.LutFlipV);
                }
            }
            catch (Exception ex) {
                _atmoUsable = false;
                _log.LogError(ex, "acmesky: LIVE atmosphere init failed (dir={Dir}); falling back to M0 test pattern", _atmoDir);
                _psAtmo?.Dispose(); _psAtmo = null;
                _lutTransmittance?.Dispose(); _lutTransmittance = null;
                _lutScattering?.Dispose(); _lutScattering = null;
                _lutIrradiance?.Dispose(); _lutIrradiance = null;
            }
        }

        /// <summary>M3: compile the star shaders and upload stars.bin (9,096 × 10 B records:
        /// int16[3] ECI dir (normalized /32767), u8 magnitude, u8[3] rgb) as a
        /// StructuredBuffer&lt;float4 posMag; float4 rgb&gt;. Failure just disables stars.</summary>
        private void TryInitStars() {
            try {
                string path = Path.Combine(_atmoDir, "stars.bin");
                if (!File.Exists(path)) {
                    _log.LogInformation("acmesky: LIVE stars.bin not found ({Path}); stars disabled", path);
                    return;
                }
                byte[] raw = File.ReadAllBytes(path);
                int n = raw.Length / 10;
                var verts = new float[n * 8];
                for (int i = 0; i < n; i++) {
                    int o = i * 10, v = i * 8;
                    verts[v + 0] = BitConverter.ToInt16(raw, o + 0) / 32767f;
                    verts[v + 1] = BitConverter.ToInt16(raw, o + 2) / 32767f;
                    verts[v + 2] = BitConverter.ToInt16(raw, o + 4) / 32767f;
                    verts[v + 3] = raw[o + 6] / 255f;                 // magnitude 0..1
                    verts[v + 4] = raw[o + 7] / 255f;                 // r
                    verts[v + 5] = raw[o + 8] / 255f;                 // g
                    verts[v + 6] = raw[o + 9] / 255f;                 // b
                    verts[v + 7] = 0f;
                }

                var vsb = Compiler.Compile(AtmosphereShader.Hlsl, "VSStars", "acmesky_sky.hlsl", "vs_5_0",
                    ShaderFlags.OptimizationLevel3, EffectFlags.None);
                _vsStars = _dev!.CreateVertexShader(vsb.Span, null);
                var psb = Compiler.Compile(AtmosphereShader.Hlsl, "PSStars", "acmesky_sky.hlsl", "ps_5_0",
                    ShaderFlags.OptimizationLevel3, EffectFlags.None);
                _psStars = _dev.CreatePixelShader(psb.Span, null);

                var desc = new BufferDescription {
                    ByteWidth = (uint)(verts.Length * sizeof(float)),
                    BindFlags = BindFlags.ShaderResource,
                    Usage = ResourceUsage.Immutable,
                    CPUAccessFlags = CpuAccessFlags.None,
                    MiscFlags = ResourceOptionFlags.BufferStructured,
                    StructureByteStride = 32,
                };
                unsafe {
                    fixed (float* p = verts) {
                        var init = new SubresourceData((IntPtr)p);
                        _starBuf = _dev.CreateBuffer(in desc, init);
                    }
                }
                var srvDesc = new ShaderResourceViewDescription {
                    Format = Format.Unknown,
                    ViewDimension = Vortice.Direct3D.ShaderResourceViewDimension.Buffer,
                };
                srvDesc.Buffer.FirstElement = 0;
                srvDesc.Buffer.NumElements = (uint)n;
                _starSrv = _dev.CreateShaderResourceView(_starBuf, srvDesc);
                _starCount = n;
                _log.LogInformation("acmesky: LIVE stars ready — {N} stars from {Path}", n, path);
            }
            catch (Exception ex) {
                _log.LogWarning(ex, "acmesky: LIVE stars init failed; stars disabled");
                _vsStars?.Dispose(); _vsStars = null;
                _psStars?.Dispose(); _psStars = null;
                _starSrv?.Dispose(); _starSrv = null;
                _starBuf?.Dispose(); _starBuf = null;
                _starCount = 0;
            }
        }

        /// <summary>M2: compile the cloud raymarch + composite shaders and load the four cloud
        /// assets (local_weather RGBA8+mips, shape 128^3 R8, shape_detail 32^3 R8, STBN
        /// 128x128x64 R8). Failure just disables clouds.</summary>
        private void TryInitClouds() {
            try {
                var psb = Compiler.Compile(CloudShader.Hlsl, "PSClouds", "acmesky_clouds.hlsl", "ps_5_0",
                    ShaderFlags.OptimizationLevel3, EffectFlags.None);
                _psClouds = _dev!.CreatePixelShader(psb.Span, null);
                var pcb = Compiler.Compile(CloudShader.Hlsl, "PSCloudComposite", "acmesky_clouds.hlsl", "ps_5_0",
                    ShaderFlags.OptimizationLevel3, EffectFlags.None);
                _psCloudComposite = _dev.CreatePixelShader(pcb.Span, null);
                var prb = Compiler.Compile(CloudShader.Hlsl, "PSCloudResolve", "acmesky_clouds.hlsl", "ps_5_0",
                    ShaderFlags.OptimizationLevel3, EffectFlags.None);
                _psCloudResolve = _dev.CreatePixelShader(prb.Span, null);

                // Weather map source (sky.cfg `wxmap`, init-time): nasa = NASA Blue Marble crop
                // (A = real storm cores — the owner's holtburger rig), dereth = biome-anchored.
                string wxFile = _cfg.WxMap switch {
                    "nasa" => "local_weather_nasa.bin",
                    "dereth" => "local_weather_dereth.bin",
                    _ => "local_weather.bin",
                };
                string wxPath = Path.Combine(_cloudDir, wxFile);
                if (!File.Exists(wxPath)) wxPath = Path.Combine(_cloudDir, "local_weather.bin");
                _texWeather = SkyLut.Load(_dev, wxPath);
                _texShape = SkyLut.Load(_dev, Path.Combine(_cloudDir, "shape.bin"));
                _texShapeDetail = SkyLut.Load(_dev, Path.Combine(_cloudDir, "shape_detail.bin"));
                _texStbn = SkyLut.Load(_dev, Path.Combine(_cloudDir, "stbn.bin"));
                _texTurbulence = SkyLut.Load(_dev, Path.Combine(_cloudDir, "turbulence.bin"));

                var blendDesc = new BlendDescription();
                blendDesc.RenderTarget[0] = new RenderTargetBlendDescription {
                    BlendEnable = true,
                    SourceBlend = Blend.One,                    // premultiplied over
                    DestinationBlend = Blend.InverseSourceAlpha,
                    BlendOperation = BlendOperation.Add,
                    SourceBlendAlpha = Blend.One,
                    DestinationBlendAlpha = Blend.InverseSourceAlpha,
                    BlendOperationAlpha = BlendOperation.Add,
                    RenderTargetWriteMask = ColorWriteEnable.All,
                };
                _blendPremul = _dev.CreateBlendState(blendDesc);

                _cloudsUsable = true;
                _log.LogInformation(
                    "acmesky: LIVE clouds ready — wx='{Wx}' ({WW}x{WH}, mips), shape {S}^3, detail {D}^3, " +
                    "stbn {BW}x{BH}x{BD}, turbulence {TW}x{TH}",
                    _texWeather.Name, _texWeather.Width, _texWeather.Height, _texShape.Width,
                    _texShapeDetail.Width, _texStbn.Width, _texStbn.Height, _texStbn.Depth,
                    _texTurbulence.Width, _texTurbulence.Height);
            }
            catch (Exception ex) {
                _cloudsUsable = false;
                _log.LogWarning(ex, "acmesky: LIVE clouds init failed; clouds disabled");
                _psClouds?.Dispose(); _psClouds = null;
                _psCloudComposite?.Dispose(); _psCloudComposite = null;
                _psCloudResolve?.Dispose(); _psCloudResolve = null;
                _texWeather?.Dispose(); _texWeather = null;
                _texShape?.Dispose(); _texShape = null;
                _texShapeDetail?.Dispose(); _texShapeDetail = null;
                _texStbn?.Dispose(); _texStbn = null;
                _texTurbulence?.Dispose(); _texTurbulence = null;
                _blendPremul?.Dispose(); _blendPremul = null;
            }
        }

        // ==================================================================
        // Target (re)creation on size change
        // ==================================================================

        private void EnsureTargets(int w, int h) {
            if (_rt is not null && w == _w && h == _h) return;
            DisposeTargets();
            _w = w; _h = h;

            var rtDesc = new Texture2DDescription {
                Width = (uint)w, Height = (uint)h, MipLevels = 1, ArraySize = 1,
                Format = Format.B8G8R8A8_UNorm,
                SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Default,
                BindFlags = BindFlags.RenderTarget,
                CPUAccessFlags = CpuAccessFlags.None,
                MiscFlags = ResourceOptionFlags.None,
            };
            _rt = _dev!.CreateTexture2D(in rtDesc);
            _rtv = _dev.CreateRenderTargetView(_rt, null);

            var stDesc = new Texture2DDescription {
                Width = (uint)w, Height = (uint)h, MipLevels = 1, ArraySize = 1,
                Format = Format.B8G8R8A8_UNorm,
                SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Staging,
                BindFlags = BindFlags.None,
                CPUAccessFlags = CpuAccessFlags.Read,
                MiscFlags = ResourceOptionFlags.None,
            };
            _staging = _dev.CreateTexture2D(in stDesc);
        }

        /// <summary>(Re)create the half-float cloud RT at the requested reduced resolution.</summary>
        private void EnsureCloudTarget(int w, int h) {
            if (_cloudRt is not null && w == _cloudW && h == _cloudH) return;
            _cloudSrv?.Dispose(); _cloudSrv = null;
            _cloudRtv?.Dispose(); _cloudRtv = null;
            _cloudRt?.Dispose(); _cloudRt = null;
            _cloudW = w; _cloudH = h;
            var desc = new Texture2DDescription {
                Width = (uint)w, Height = (uint)h, MipLevels = 1, ArraySize = 1,
                Format = Format.R16G16B16A16_Float,
                SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Default,
                BindFlags = BindFlags.RenderTarget | BindFlags.ShaderResource,
                CPUAccessFlags = CpuAccessFlags.None,
                MiscFlags = ResourceOptionFlags.None,
            };
            _cloudRt = _dev!.CreateTexture2D(in desc);
            _cloudRtv = _dev.CreateRenderTargetView(_cloudRt, null);
            _cloudSrv = _dev.CreateShaderResourceView(_cloudRt);

            // M2.2: velocity MRT + resolved/history ping-pong, same size/format as the cloud RT.
            _cloudVelSrv?.Dispose(); _cloudVelSrv = null;
            _cloudVelRtv?.Dispose(); _cloudVelRtv = null;
            _cloudVelRt?.Dispose(); _cloudVelRt = null;
            _cloudVelRt = _dev.CreateTexture2D(in desc);
            _cloudVelRtv = _dev.CreateRenderTargetView(_cloudVelRt, null);
            _cloudVelSrv = _dev.CreateShaderResourceView(_cloudVelRt);
            for (int k = 0; k < 2; k++) {
                _cloudResolveSrv[k]?.Dispose(); _cloudResolveSrv[k] = null;
                _cloudResolveRtv[k]?.Dispose(); _cloudResolveRtv[k] = null;
                _cloudResolveRt[k]?.Dispose(); _cloudResolveRt[k] = null;
                _cloudResolveRt[k] = _dev.CreateTexture2D(in desc);
                _cloudResolveRtv[k] = _dev.CreateRenderTargetView(_cloudResolveRt[k], null);
                _cloudResolveSrv[k] = _dev.CreateShaderResourceView(_cloudResolveRt[k]);
            }
            _cloudHistValid = false;   // resize/first-use -> resolve passes current through
        }

        // ==================================================================
        // D3D9 dynamic upload texture (re)creation
        // ==================================================================

        private void EnsureD3D9Texture(Device d9, int w, int h) {
            if (_d3d9tex != IntPtr.Zero && w == _texW && h == _texH) return;
            if (_d3d9tex != IntPtr.Zero) {
                new Texture9(_d3d9tex).Release();
                _d3d9tex = IntPtr.Zero;
            }
            // D3DPOOL_MANAGED (like the baked path / TextureLoader), NOT DYNAMIC+DEFAULT.
            // A DEFAULT-pool resource held across frames makes the client's next
            // IDirect3DDevice9::Reset fail with D3DERR_INVALIDCALL (fullscreen toggle / resize),
            // and this plugin has no Reset hook — only a device-POINTER change is detected, which
            // a Reset does not trip — so the client could never recover. MANAGED survives Reset
            // (the runtime re-uploads from its sysmem copy). Trade: a per-frame full-res upload to
            // MANAGED is costlier than to a DYNAMIC surface, but the LIVE path is experimental
            // (default off) and correctness beats speed here.
            _d3d9tex = d9.CreateTexture((uint)w, (uint)h, D3D9.Fmt.A8R8G8B8, D3D9.Pool.Managed);
            _texW = w; _texH = h;
            if (_d3d9tex == IntPtr.Zero)
                LogErrThrottled(new InvalidOperationException("CreateTexture returned null"), "d3d9-tex-create");
        }

        // ==================================================================
        // Build cbuffer -> render sky -> readback -> upload
        // ==================================================================

        private unsafe void RenderAndUpload(int w, int h, bool atmo, in ClientState.Camera cam) {
            // --- build + upload the cbuffer ---
            var p = BuildCb(w, h, atmo, in cam);
            var mappedCb = _ctx!.Map(_cb!, 0, MapMode.WriteDiscard, Vortice.Direct3D11.MapFlags.None);
            *(SkyCb*)mappedCb.DataPointer = p;
            _ctx.Unmap(_cb!, 0);

            // --- draw the fullscreen triangle into our offscreen RT ---
            _ctx.RSSetViewport(0f, 0f, w, h, 0f, 1f);
            _ctx.OMSetRenderTargets(_rtv!, null);
            _ctx.IASetInputLayout(null);
            _ctx.IASetPrimitiveTopology(PrimitiveTopology.TriangleList);
            _ctx.VSSetShader(_vs);
            _ctx.PSSetConstantBuffer(0, _cb);
            if (atmo) {
                _ctx.PSSetShader(_psAtmo);
                _ctx.PSSetSampler(0, _sampler);
                _ctx.PSSetShaderResources(0, new[] {
                    _lutTransmittance!.Srv!, _lutScattering!.Srv!, _lutIrradiance!.Srv!,
                });
            } else {
                _ctx.PSSetShader(_psTest);
            }
            _ctx.Draw(3, 0);

            // M3 stars: 1px PointList over the finished sky, same RT, no blending — each
            // star pixel recomputes sky radiance + transmittance*starColor (takram BACKGROUND
            // path). Skipped in debug outputs and when fully faded by daylight.
            if (atmo && _vsStars is not null && _psStars is not null && _starSrv is not null &&
                p.StarIntensity > 0f && p.OutputMode < 3.5f) {
                _ctx.IASetPrimitiveTopology(PrimitiveTopology.PointList);
                _ctx.VSSetShader(_vsStars);
                _ctx.VSSetConstantBuffer(0, _cb);
                _ctx.VSSetShaderResource(3, _starSrv);
                _ctx.PSSetShader(_psStars);
                _ctx.Draw((uint)_starCount, 0);
                _ctx.IASetPrimitiveTopology(PrimitiveTopology.TriangleList);
                _ctx.VSSetShader(_vs);
            }

            // M2 clouds: raymarch into the reduced-res HDR cloud RT, then composite
            // premultiplied-over onto the sky (tonemapped in the composite PS). Runs in the
            // real-sky outputs (0-3) and in the clouds-only debug view (output=6).
            if (atmo && _cloudsUsable && p.CloudIters > 0f &&
                (p.OutputMode < 3.5f || p.OutputMode > 5.5f)) {
                EnsureCloudTarget(Math.Max(64, (int)p.CloudRes.X), Math.Max(36, (int)p.CloudRes.Y));

                // pass A: raymarch at reduced res (MRT: color + frontDepth/velocity)
                _ctx.RSSetViewport(0f, 0f, _cloudW, _cloudH, 0f, 1f);
                _ctx.OMSetRenderTargets(new[] { _cloudRtv!, _cloudVelRtv! }, null);
                _ctx.PSSetShader(_psClouds);
                _ctx.PSSetSampler(1, _samplerWrap);
                _ctx.PSSetShaderResources(4, new[] {
                    _texWeather!.Srv!, _texShape!.Srv!, _texShapeDetail!.Srv!, _texStbn!.Srv!,
                });
                _ctx.PSSetShaderResource(9, _texTurbulence!.Srv!);
                _ctx.Draw(3, 0);

                // pass R (M2.2): temporal resolve into the ping-pong target; the other half
                // is this frame's history. cfg cloudtaa=0 falls back to the raw march RT.
                bool taa = _cfg.CloudTaa > 0.5f && _psCloudResolve is not null;
                ID3D11ShaderResourceView compositeSrc = _cloudSrv!;
                if (taa) {
                    int cur = _cloudResolveIdx, prev = 1 - _cloudResolveIdx;
                    _ctx.OMSetRenderTargets(_cloudResolveRtv[cur]!, null);
                    _ctx.PSSetShader(_psCloudResolve);
                    _ctx.PSSetShaderResource(8, _cloudSrv!);
                    _ctx.PSSetShaderResource(10, _cloudVelSrv!);
                    _ctx.PSSetShaderResource(11, _cloudResolveSrv[prev]!);
                    _ctx.Draw(3, 0);
                    _ctx.PSSetShaderResources(10, new ID3D11ShaderResourceView[] { null!, null! }); // t10,t11
                    compositeSrc = _cloudResolveSrv[cur]!;
                    _cloudResolveIdx = prev;
                    _cloudHistValid = true;
                }

                // pass B: composite over the main sky RT
                _ctx.RSSetViewport(0f, 0f, w, h, 0f, 1f);
                _ctx.OMSetRenderTargets(_rtv!, null);
                _ctx.OMSetBlendState(_blendPremul, null, uint.MaxValue);
                _ctx.PSSetShader(_psCloudComposite);
                _ctx.PSSetShaderResource(8, compositeSrc);
                _ctx.Draw(3, 0);
                _ctx.OMSetBlendState(null, null, uint.MaxValue);
                _ctx.PSSetShaderResources(8, new ID3D11ShaderResourceView[] { null! });   // unbind: RT is written again next frame
            }

            // --- copy RT -> staging and read back to CPU ---
            _ctx.CopyResource(_staging!, _rt!);
            var map = _ctx.Map(_staging!, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
            try {
                int srcPitch = (int)map.RowPitch;
                byte* s = (byte*)map.DataPointer;

                // Sample three pixels (post-tonemap BGRA) for the diagnostic line.
                _sampZenith = SamplePixel(s, srcPitch, w / 2, h / 8);
                _sampMid = SamplePixel(s, srcPitch, w / 2, h / 2);
                _sampHorizon = SamplePixel(s, srcPitch, w / 2, (7 * h) / 8);
                // Every 8th row at FULL x resolution so 1px stars are countable; threshold 24
                // sits above the night-sky background (<10) and below most star pixels.
                int bright = 0;
                for (int y = 0; y < h; y += 8) {
                    byte* row = s + (long)y * srcPitch;
                    for (int x = 0; x < w; x++) {
                        byte* px = row + (long)x * 4;
                        if (px[0] > 24 || px[1] > 24 || px[2] > 24) bright++;
                    }
                }
                _sampBright = bright;

                // sky.cfg `dump=1`: write the EXACT composited backdrop (this readback) as a
                // BMP once per second — ground-truth 1070-rendered frames through the live
                // game camera, immune to the stale-GDI screenshot problem.
                MaybeDumpFrame(s, srcPitch, w, h);

                var tex = new Texture9(_d3d9tex);
                if (tex.LockRect(0, out var locked, 0u)) {   // 0, not DISCARD: DISCARD requires DYNAMIC; this pool is MANAGED
                    int bytesPerRow = w * 4; // BGRA8 both sides
                    byte* d = (byte*)locked.pBits;
                    for (int y = 0; y < h; y++) {
                        Buffer.MemoryCopy(s + (long)y * srcPitch, d + (long)y * locked.Pitch,
                                          bytesPerRow, bytesPerRow);
                    }
                    tex.UnlockRect(0);

                    if (!_firstCompositeLogged) {
                        _firstCompositeLogged = true;
                        _log.LogInformation(
                            "acmesky: LIVE first composite -- vp={W}x{H} mode={Mode} d3d11Fmt=B8G8R8A8_UNORM " +
                            "d3d9Fmt=A8R8G8B8(21) stagingRowPitch={SP} d3d9Pitch={DP}",
                            w, h, atmo ? "atmosphere" : "testpattern", srcPitch, locked.Pitch);
                    }
                }
                else {
                    LogErrThrottled(new InvalidOperationException("LockRect failed"), "d3d9-lock");
                }
            }
            finally {
                _ctx.Unmap(_staging!, 0);
            }
        }

        private long _lastDumpTicks = -Stopwatch.Frequency;
        private int _dumpIndex;

        /// <summary>Write the readback buffer as a 32bpp BMP (rotating skydump-0..7.bmp).</summary>
        private unsafe void MaybeDumpFrame(byte* s, int pitch, int w, int h) {
            if (_cfg.Dump <= 0f) return;
            long now = _clock.ElapsedTicks;
            if (now - _lastDumpTicks < Stopwatch.Frequency) return;
            _lastDumpTicks = now;
            string path = $@"C:\Temp\acdt\skydump-{_dumpIndex++ % 8}.bmp";
            try {
                int rowBytes = w * 4;
                var file = new byte[14 + 40 + rowBytes * h];
                int size = file.Length;
                file[0] = (byte)'B'; file[1] = (byte)'M';
                BitConverter.GetBytes(size).CopyTo(file, 2);
                BitConverter.GetBytes(54).CopyTo(file, 10);          // pixel data offset
                BitConverter.GetBytes(40).CopyTo(file, 14);          // BITMAPINFOHEADER
                BitConverter.GetBytes(w).CopyTo(file, 18);
                BitConverter.GetBytes(h).CopyTo(file, 22);           // positive = bottom-up
                BitConverter.GetBytes((short)1).CopyTo(file, 26);
                BitConverter.GetBytes((short)32).CopyTo(file, 28);
                BitConverter.GetBytes(rowBytes * h).CopyTo(file, 34);
                fixed (byte* dst = file) {
                    for (int y = 0; y < h; y++) {
                        Buffer.MemoryCopy(s + (long)y * pitch,
                                          dst + 54 + (long)(h - 1 - y) * rowBytes,
                                          rowBytes, rowBytes);
                    }
                }
                File.WriteAllBytes(path, file);
                _log.LogInformation("acmesky: frame dumped -> {Path}", path);
            }
            catch (Exception ex) { LogErrThrottled(ex, "dump"); }
        }

        private static unsafe uint SamplePixel(byte* s, int pitch, int x, int y) {
            byte* px = s + (long)y * pitch + (long)x * 4;
            return (uint)(px[0] | (px[1] << 8) | (px[2] << 16) | (px[3] << 24)); // BGRA packed
        }

        /// <summary>Assemble the per-frame constant buffer.</summary>
        private SkyCb BuildCb(int w, int h, bool atmo, in ClientState.Camera cam) {
            var cb = new SkyCb {
                Resolution = new Vector2(w, h),
                Time = (float)_clock.Elapsed.TotalSeconds,
                Exposure = _cfg.Exposure,
                AcToShader = _acToShader,
                BottomRadiusM = 6_360_000f,
                MeterToUnit = 0.001f,               // metres -> kilometres
                SunAngRadius = _cfg.SunAng,
                SunAngRadiusPhys = 0.004675f,        // physical solar radius (radiance magnitude)
                MoonAngRadius = _cfg.MoonAng,
                LunarScale = _cfg.Lunar,
                LutFlipV = _cfg.LutFlipV,
                OutputMode = _cfg.Output,
                RayMode = _cfg.RayMode,
                WorldSwizzle = _cfg.WorldSwizzle,
            };
            if (!atmo) return cb;

            // Inverse projection/view (row-vector: world = clip * invProj * invView).
            // sky.cfg `campitch` (deg) pitches the SKY camera up — a capture aid for headless
            // shots (the game camera itself ignores injected keys); everything (atmosphere,
            // stars, clouds) stays consistent because it edits the one view matrix they share.
            Matrix4x4 wv = cam.WorldToView;
            if (_cfg.CamPitch != 0f)
                wv = wv * Matrix4x4.CreateRotationX(_cfg.CamPitch * MathF.PI / 180f);
            if (!Matrix4x4.Invert(cam.ViewToClip, out cb.InvProj)) cb.InvProj = Matrix4x4.Identity;
            if (!Matrix4x4.Invert(wv, out cb.InvView)) cb.InvView = Matrix4x4.Identity;
            cb.CameraPosAC = cam.WorldPos;
            cb.WorldToClip = wv * cam.ViewToClip;   // forward, for the star points
            cb.EciToShader = SkySunModel.EciToShader();
            cb.StarMagMin = -2f; cb.StarMagMax = 8f;

            // M2 clouds: wind-accumulated weather offset (holtburger: localWeatherVelocity =
            // SPEED*(0.8,0.6), SPEED = 7.7e-5 weather-tiles/s ≈ 25 km/h at repeat 100).
            double nowS = _clock.Elapsed.TotalSeconds;
            if (_lastWindSeconds >= 0) {
                float dt = (float)Math.Clamp(nowS - _lastWindSeconds, 0.0, 1.0);
                const float windSpeed = 7.7e-5f;
                _weatherOfs += new Vector2(windSpeed * 0.8f, windSpeed * 0.6f) * dt;
            }
            _lastWindSeconds = nowS;
            cb.CloudWeatherOfs = _weatherOfs;
            // STORM-reactive look: the client's own weather flag (GameSky::s_weatherEnabled)
            // is the retail analog of holtburger's DayGroup is_storm signal. sky.cfg `storm`
            // overrides for testing (-1 = auto).
            bool storm = _cfg.Storm < -0.5f ? ClientState.IsWeatherEnabled() : _cfg.Storm > 0.5f;
            _lastStorm = storm;
            cb.CloudStorm = storm ? 1f : 0f;
            cb.CloudCoverage = storm ? _cfg.CloudCoverStorm : _cfg.CloudCover;
            cb.CloudFrame = (++_cloudFrameIndex) % 64;
            float scale = Math.Clamp(_cfg.CloudRes, 0.1f, 1f);
            cb.CloudRes = new Vector2(MathF.Max(64f, w * scale), MathF.Max(36f, h * scale));
            cb.CloudIters = _cfg.Clouds > 0f ? _cfg.CloudIters : 0f;
            cb.CloudMinStep = _cfg.CloudMinStep;
            cb.CloudSunSteps = _cfg.CloudSunSteps;
            cb.CloudGroundSteps = _cfg.CloudGroundSteps;
            cb.CloudAccurate = _cfg.CloudAccurate;
            cb.CloudTurb = _cfg.CloudTurb;
            cb.CloudHazeDensity = _cfg.CloudHaze > 0f ? (storm ? 3e-4f : 3e-5f) : 0f;
            // M2.2 temporal resolve inputs: last frame's sky-camera VP for reprojection
            // velocity, the shader->AC rotation, and the TAA knobs.
            cb.ShaderToAc = Matrix4x4.Invert(_acToShader, out var s2a) ? s2a : Matrix4x4.Transpose(_acToShader);
            cb.PrevWorldToClip = _prevWorldToClipValid ? _prevWorldToClip : cb.WorldToClip;
            _prevWorldToClip = cb.WorldToClip;
            _prevWorldToClipValid = true;
            cb.CloudTaa = _cfg.CloudTaa;
            cb.CloudTaaGamma = _cfg.CloudTaaGamma;
            cb.CloudTaaAlpha = _cfg.CloudTaaAlpha;
            cb.CloudHistValid = _cloudHistValid ? 1f : 0f;
            // Landblock-local camera fix: the client view matrix is local to the viewer's
            // landblock (Render::update_viewpoint does Frame::globaltolocal), so the cloud
            // ECEF/weather math needs the global translation ((lbx,lby)*192, z is already
            // global). CellId 0 (no viewer yet) degrades to the old pole-locked behavior.
            uint cell = cam.CellId;
            cb.CameraLbOffsetAC = new Vector3(
                ((cell >> 24) & 0xFF) * 192f, ((cell >> 16) & 0xFF) * 192f, 0f);
            cb.PrevCameraLbOffsetAC = _prevLbOffsetValid ? _prevLbOffset : cb.CameraLbOffsetAC;
            _prevLbOffset = cb.CameraLbOffsetAC;
            _prevLbOffsetValid = true;
            _lastCellId = cell;
            _lastGlobalCam = new Vector3(cam.WorldPos.X, cam.WorldPos.Z, cam.WorldPos.Y) + cb.CameraLbOffsetAC;

            // Time-driven sun/moon. sky.cfg `time=` (0..1) overrides the client clock -- used to force a
            // time of day for evaluation/tuning (and as a fallback while the client's
            // present_time_in_day_unit read returns 0, pinning the real clock at midnight). <0 = use the
            // client clock.
            float t = _cfg.ForcedTime;
            if (t < 0f) {
                t = ClientState.GetTimeOfDay();   // present_time_of_day: true 0..1 day fraction
                if (t < 0f) t = 0.5f;             // no GameTime object yet -> midday
                else {
                    t = (t + _cfg.TimeOfs) % 1f;  // optional phase calibration (sky.cfg timeofs)
                    if (t < 0f) t += 1f;
                }
            }
            _lastTimeOfDay = t;
            SkySunModel.SunHeadingPitch(t, out float headDeg, out float pitchDeg);
            _lastSunPitchDeg = pitchDeg;
            cb.SunDirAC = SkySunModel.DirAc(headDeg, pitchDeg);
            cb.MoonDirAC = SkySunModel.DirAc(headDeg + 180f, -pitchDeg);
            cb.StarIntensity = _cfg.Stars * SkySunModel.NightFraction(pitchDeg);
            return cb;
        }

        // ==================================================================
        // Fullscreen D3D9 composite (guarded exactly like the baked renderer)
        // ==================================================================

        private unsafe void DrawFullscreen(Device d9, int w, int h) {
            var guard = new RenderStateGuard();
            guard.Capture(d9);
            try {
                d9.SetRenderState(D3D9.Rs.ZEnable, 0);
                d9.SetRenderState(D3D9.Rs.ZWriteEnable, 0);
                d9.SetRenderState(D3D9.Rs.AlphaBlendEnable, 0);
                d9.SetRenderState(D3D9.Rs.AlphaTestEnable, 0);
                d9.SetRenderState(D3D9.Rs.Lighting, 0);
                d9.SetRenderState(D3D9.Rs.FogEnable, 0);
                d9.SetRenderState(D3D9.Rs.SpecularEnable, 0);
                d9.SetRenderState(D3D9.Rs.CullMode, (uint)D3D9.Cull.None);
                d9.SetRenderState(D3D9.Rs.ColorWriteEnable, 0xF);

                d9.SetSamplerState(0, D3D9.Samp.MagFilter, (uint)D3D9.Filter.Linear);
                d9.SetSamplerState(0, D3D9.Samp.MinFilter, (uint)D3D9.Filter.Linear);
                d9.SetSamplerState(0, D3D9.Samp.MipFilter, (uint)D3D9.Filter.None);
                d9.SetSamplerState(0, D3D9.Samp.AddressU, (uint)D3D9.Address.Clamp);
                d9.SetSamplerState(0, D3D9.Samp.AddressV, (uint)D3D9.Address.Clamp);

                d9.SetTexture(0, _d3d9tex);
                d9.SetTextureStageState(0, D3D9.Tss.ColorOp, (uint)D3D9.Top.SelectArg1);
                d9.SetTextureStageState(0, D3D9.Tss.ColorArg1, (uint)D3D9.Ta.Texture);
                d9.SetTextureStageState(0, D3D9.Tss.AlphaOp, (uint)D3D9.Top.SelectArg1);
                d9.SetTextureStageState(0, D3D9.Tss.AlphaArg1, (uint)D3D9.Ta.Texture);
                d9.SetTextureStageState(0, D3D9.Tss.TextureTransformFlags, (uint)D3D9.Ttff.Disable);

                d9.SetFVF(D3D9.Fvf.XyzRhwTex1);

                float x0 = -0.5f, y0 = -0.5f, x1 = w - 0.5f, y1 = h - 0.5f;
                QuadVert* q = stackalloc QuadVert[6];
                q[0] = V(x0, y0, 0f, 0f); // TL
                q[1] = V(x1, y0, 1f, 0f); // TR
                q[2] = V(x0, y1, 0f, 1f); // BL
                q[3] = V(x1, y0, 1f, 0f); // TR
                q[4] = V(x1, y1, 1f, 1f); // BR
                q[5] = V(x0, y1, 0f, 1f); // BL
                d9.DrawPrimitiveUP(D3D9.Prim.TriangleList, 2, q, (uint)sizeof(QuadVert));
            }
            finally {
                guard.Restore();
            }
        }

        private static QuadVert V(float x, float y, float u, float v) =>
            new QuadVert { X = x, Y = y, Z = 0f, Rhw = 1f, U = u, V = v };

        // ==================================================================
        // Diagnostics
        // ==================================================================

        private void LogFrameThrottled(int w, int h, bool atmo) {
            long n = ++_frameCount;
            long now = _clock.ElapsedTicks;
            if (now - _lastFrameLogTicks < Stopwatch.Frequency) return;
            _lastFrameLogTicks = now;
            if (atmo) {
                _log.LogInformation(
                    "acmesky: LIVE frame #{N} vp={W}x{H} atmosphere rayMode={Ray} swz={Swz} output={Out} axis='{Axis}' " +
                    "t={T:F4} (clock={Clock:F4}) sunPitch={Pitch:F1}deg stars={Stars} clouds={Clouds} storm={Storm} " +
                    "samples[zenith=0x{Z:X8} mid=0x{M:X8} horizon=0x{H2:X8} (BGRA) bright={B}] " +
                    "cell=0x{Cell:X8} gcam=({GX:F0},{GY:F0},{GZ:F0})",
                    n, w, h, _cfg.RayMode, _cfg.WorldSwizzle, _cfg.Output, _cfg.Axis,
                    _lastTimeOfDay, ClientState.GetTimeOfDay(), _lastSunPitchDeg,
                    _starCount > 0 ? _cfg.Stars : -1f,
                    _cloudsUsable ? _cfg.Clouds : -1f, _lastStorm ? 1 : 0,
                    _sampZenith, _sampMid, _sampHorizon, _sampBright,
                    _lastCellId, _lastGlobalCam.X, _lastGlobalCam.Y, _lastGlobalCam.Z);
            } else {
                _log.LogInformation(
                    "acmesky: LIVE frame #{N} vp={W}x{H} test pattern composited", n, w, h);
            }
        }

        private void LogErrThrottled(Exception ex, string stage) {
            long now = _clock.ElapsedTicks;
            if (now - _lastErrTicks < Stopwatch.Frequency) return;
            _lastErrTicks = now;
            _log.LogWarning(ex, "acmesky: LIVE stage '{Stage}' failed", stage);
        }

        // ==================================================================
        // Teardown
        // ==================================================================

        /// <summary>
        /// Release everything. <paramref name="currentDevPtr"/> is the client's live D3D9 device pointer;
        /// the D3D9 upload texture is Release()d only if it still belongs to that device.
        /// </summary>
        public void ReleaseGpu(IntPtr currentDevPtr) {
            if (_d3d9tex != IntPtr.Zero) {
                bool alive = _d3d9dev != IntPtr.Zero && currentDevPtr == _d3d9dev;
                if (alive) new Texture9(_d3d9tex).Release();
                _d3d9tex = IntPtr.Zero;
            }
            _texW = _texH = 0;
            _d3d9dev = IntPtr.Zero;
            DisposeD3D11();
            _d3d11Failed = false;
            _firstCompositeLogged = false;
        }

        private void DisposeTargets() {
            _rtv?.Dispose(); _rtv = null;
            _rt?.Dispose(); _rt = null;
            _staging?.Dispose(); _staging = null;
        }

        private void DisposeD3D11() {
            DisposeTargets();
            _lutTransmittance?.Dispose(); _lutTransmittance = null;
            _lutScattering?.Dispose(); _lutScattering = null;
            _lutIrradiance?.Dispose(); _lutIrradiance = null;
            _sampler?.Dispose(); _sampler = null;
            _cb?.Dispose(); _cb = null;
            _starSrv?.Dispose(); _starSrv = null;
            _starBuf?.Dispose(); _starBuf = null;
            _vsStars?.Dispose(); _vsStars = null;
            _psStars?.Dispose(); _psStars = null;
            _starCount = 0;
            _cloudSrv?.Dispose(); _cloudSrv = null;
            _cloudRtv?.Dispose(); _cloudRtv = null;
            _cloudRt?.Dispose(); _cloudRt = null;
            _cloudVelSrv?.Dispose(); _cloudVelSrv = null;
            _cloudVelRtv?.Dispose(); _cloudVelRtv = null;
            _cloudVelRt?.Dispose(); _cloudVelRt = null;
            for (int k = 0; k < 2; k++) {
                _cloudResolveSrv[k]?.Dispose(); _cloudResolveSrv[k] = null;
                _cloudResolveRtv[k]?.Dispose(); _cloudResolveRtv[k] = null;
                _cloudResolveRt[k]?.Dispose(); _cloudResolveRt[k] = null;
            }
            _cloudHistValid = false;
            _prevWorldToClipValid = false;
            _prevLbOffsetValid = false;
            _cloudW = _cloudH = 0;
            _psClouds?.Dispose(); _psClouds = null;
            _psCloudComposite?.Dispose(); _psCloudComposite = null;
            _psCloudResolve?.Dispose(); _psCloudResolve = null;
            _texWeather?.Dispose(); _texWeather = null;
            _texShape?.Dispose(); _texShape = null;
            _texShapeDetail?.Dispose(); _texShapeDetail = null;
            _texStbn?.Dispose(); _texStbn = null;
            _texTurbulence?.Dispose(); _texTurbulence = null;
            _blendPremul?.Dispose(); _blendPremul = null;
            _samplerWrap?.Dispose(); _samplerWrap = null;
            _cloudsUsable = false;
            _psAtmo?.Dispose(); _psAtmo = null;
            _psTest?.Dispose(); _psTest = null;
            _vs?.Dispose(); _vs = null;
            _ctx?.Dispose(); _ctx = null;
            _dev?.Dispose(); _dev = null;
            _atmoUsable = false;
            _w = _h = 0;
        }
    }
}
