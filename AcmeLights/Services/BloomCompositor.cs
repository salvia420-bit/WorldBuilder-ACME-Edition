using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using AcmeLights.Lib;
using Microsoft.Extensions.Logging;
using Vortice.D3DCompiler;

namespace AcmeLights.Services {
    /// <summary>
    /// MILESTONE P5 (AcmeBloom) — the luminance/bloom post-process, run on the CLIENT'S OWN
    /// IDirect3DDevice9 from the <c>SceneTool::EndFrame</c> entry detour (after the full 3D world,
    /// before the 2D UI; BeginScene open, backbuffer bound, pure fixed-function state).
    ///
    /// Pipeline each frame (all fullscreen XYZRHW+TEX1 quads, our own ps_2_0 shaders):
    ///   StretchRect backbuffer(viewport rect) -> sceneTex (full-res)
    ///   bright-pass  sceneTex -> brightTex (half-res, 2x2 downsample + soft-knee threshold)
    ///   blur H       brightTex -> blurTex
    ///   blur V       blurTex   -> brightTex        (repeat H/V `radiusPasses` times)
    ///   composite    brightTex -> backbuffer, ADDITIVE, over the 3D viewport rect
    ///
    /// Then it restores every piece of device state it touched (RT0, depth-stencil, viewport, the
    /// render/sampler/stage states, stage-0 texture, FVF, and — critically, since the client never
    /// calls SetPixelShader — the pixel shader is nulled). NEVER throws (the detour guards too); any
    /// D3D failure disables bloom for the frame and forces a resource rebuild next frame (covers a
    /// device Reset without needing the Chorizite reset events).
    /// </summary>
    internal sealed unsafe class BloomCompositor {
        private readonly ILogger _log;
        private readonly LightsConfig _cfg;
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private long _lastErrTicks = long.MinValue;
        private bool _firstOk;

        // device-owned resources (all D3DPOOL_DEFAULT / shaders)
        private IntPtr _dev;
        private IntPtr _psBright, _psBlur, _psComposite;
        private IntPtr _sceneTex, _sceneSurf;
        private IntPtr _brightTex, _brightSurf;
        private IntPtr _blurTex, _blurSurf;
        private int _fullW, _fullH, _halfW, _halfH;
        private bool _resourcesFailed;

        [StructLayout(LayoutKind.Sequential)]
        private struct QuadVert { public float X, Y, Z, Rhw, U, V; }

        public BloomCompositor(ILogger log, LightsConfig cfg) { _log = log; _cfg = cfg; }

        /// <summary>Called from the EndFrame detour. dev = client device; vp = current 3D viewport.</summary>
        public void Frame(IntPtr devPtr, in ClientState.Viewport vp) {
            if (_cfg.Bloom <= 0.5f) return;
            if (devPtr == IntPtr.Zero || !vp.Valid || !vp.OpenScene) return;
            try {
                var dev = new Device(devPtr);
                if (!EnsureResources(dev, devPtr, vp.W, vp.H)) return;
                RenderBloom(dev, in vp);
            }
            catch (Exception ex) { LogErr(ex, "frame"); }
        }

        // ---- resource lifecycle ----
        private bool EnsureResources(Device dev, IntPtr devPtr, int w, int h) {
            if (devPtr == _dev && w == _fullW && h == _fullH && _sceneTex != IntPtr.Zero && !_resourcesFailed)
                return true;
            if (devPtr != _dev || w != _fullW || h != _fullH) {
                ReleaseResources();           // device changed (Reset) or size changed
                _resourcesFailed = false;
            }
            if (_resourcesFailed) return false;

            _dev = devPtr; _fullW = w; _fullH = h;
            _halfW = Math.Max(1, w / 2); _halfH = Math.Max(1, h / 2);

            try {
                if (_psBright == IntPtr.Zero) _psBright = CompilePs(BloomShaders.PsBrightPass, "PsBrightPass");
                if (_psBlur == IntPtr.Zero) _psBlur = CompilePs(BloomShaders.PsBlur, "PsBlur");
                if (_psComposite == IntPtr.Zero) _psComposite = CompilePs(BloomShaders.PsComposite, "PsComposite");

                _sceneTex = dev.CreateTexture((uint)w, (uint)h, 1, D3D9.Usage.RenderTarget, D3D9.Fmt.A8R8G8B8, D3D9.Pool.Default);
                _brightTex = dev.CreateTexture((uint)_halfW, (uint)_halfH, 1, D3D9.Usage.RenderTarget, D3D9.Fmt.A8R8G8B8, D3D9.Pool.Default);
                _blurTex = dev.CreateTexture((uint)_halfW, (uint)_halfH, 1, D3D9.Usage.RenderTarget, D3D9.Fmt.A8R8G8B8, D3D9.Pool.Default);
                if (_sceneTex == IntPtr.Zero || _brightTex == IntPtr.Zero || _blurTex == IntPtr.Zero ||
                    _psBright == IntPtr.Zero || _psBlur == IntPtr.Zero || _psComposite == IntPtr.Zero)
                    throw new InvalidOperationException("bloom resource creation returned null");

                _sceneSurf = new Texture9(_sceneTex).GetSurfaceLevel(0);
                _brightSurf = new Texture9(_brightTex).GetSurfaceLevel(0);
                _blurSurf = new Texture9(_blurTex).GetSurfaceLevel(0);
                if (_sceneSurf == IntPtr.Zero || _brightSurf == IntPtr.Zero || _blurSurf == IntPtr.Zero)
                    throw new InvalidOperationException("bloom GetSurfaceLevel returned null");

                _log.LogInformation("acmelights: bloom resources ready {W}x{H} (half {HW}x{HH})", w, h, _halfW, _halfH);
                return true;
            }
            catch (Exception ex) {
                LogErr(ex, "ensure");
                _resourcesFailed = true;
                ReleaseResources();
                return false;
            }
        }

        private IntPtr CompilePs(string hlsl, string entry) {
            var blob = Compiler.Compile(hlsl, "main", entry + ".hlsl", "ps_2_0",
                ShaderFlags.OptimizationLevel3, EffectFlags.None);
            var bytes = blob.Span.ToArray();
            return new Device(_dev).CreatePixelShader(bytes);
        }

        private void ReleaseResources() {
            // surfaces first (they AddRef'd the textures), then textures, then shaders.
            if (_sceneSurf != IntPtr.Zero) { D3D9.ReleaseCom(_sceneSurf); _sceneSurf = IntPtr.Zero; }
            if (_brightSurf != IntPtr.Zero) { D3D9.ReleaseCom(_brightSurf); _brightSurf = IntPtr.Zero; }
            if (_blurSurf != IntPtr.Zero) { D3D9.ReleaseCom(_blurSurf); _blurSurf = IntPtr.Zero; }
            if (_sceneTex != IntPtr.Zero) { D3D9.ReleaseCom(_sceneTex); _sceneTex = IntPtr.Zero; }
            if (_brightTex != IntPtr.Zero) { D3D9.ReleaseCom(_brightTex); _brightTex = IntPtr.Zero; }
            if (_blurTex != IntPtr.Zero) { D3D9.ReleaseCom(_blurTex); _blurTex = IntPtr.Zero; }
            // Shaders survive a device Reset in D3D9 (not pool-bound), so keep them unless the device
            // pointer itself changed. Cheap to keep; only freed on full dispose.
            _fullW = _fullH = 0;
        }

        /// <summary>Release everything including shaders (plugin unload).</summary>
        public void Dispose() {
            ReleaseResources();
            if (_psBright != IntPtr.Zero) { D3D9.ReleaseCom(_psBright); _psBright = IntPtr.Zero; }
            if (_psBlur != IntPtr.Zero) { D3D9.ReleaseCom(_psBlur); _psBlur = IntPtr.Zero; }
            if (_psComposite != IntPtr.Zero) { D3D9.ReleaseCom(_psComposite); _psComposite = IntPtr.Zero; }
            _dev = IntPtr.Zero;
        }

        // ---- the pass ----
        private void RenderBloom(Device dev, in ClientState.Viewport vp) {
            // --- save state we touch ---
            IntPtr origRt = dev.GetRenderTarget(0);
            IntPtr origDs = dev.GetDepthStencilSurface();
            D3DViewport9 origVp = dev.GetViewport();
            uint sZ = dev.GetRenderState(D3D9.Rs.ZEnable);
            uint sZW = dev.GetRenderState(D3D9.Rs.ZWriteEnable);
            uint sAB = dev.GetRenderState(D3D9.Rs.AlphaBlendEnable);
            uint sSB = dev.GetRenderState(D3D9.Rs.SrcBlend);
            uint sDB = dev.GetRenderState(D3D9.Rs.DestBlend);
            uint sAT = dev.GetRenderState(D3D9.Rs.AlphaTestEnable);
            uint sCull = dev.GetRenderState(D3D9.Rs.CullMode);
            uint sLit = dev.GetRenderState(D3D9.Rs.Lighting);
            uint sFog = dev.GetRenderState(D3D9.Rs.FogEnable);
            uint sCW = dev.GetRenderState(D3D9.Rs.ColorWriteEnable);
            uint sSrgb = dev.GetRenderState(D3D9.Rs.SrgbWriteEnable);

            try {
                // Common state for all our fullscreen passes.
                dev.SetRenderState(D3D9.Rs.ZEnable, 0);
                dev.SetRenderState(D3D9.Rs.ZWriteEnable, 0);
                dev.SetRenderState(D3D9.Rs.AlphaTestEnable, 0);
                dev.SetRenderState(D3D9.Rs.CullMode, (uint)D3D9.Cull.None);
                dev.SetRenderState(D3D9.Rs.Lighting, 0);
                dev.SetRenderState(D3D9.Rs.FogEnable, 0);
                dev.SetRenderState(D3D9.Rs.ColorWriteEnable, 0xF);
                dev.SetRenderState(D3D9.Rs.SrgbWriteEnable, 0);
                dev.SetDepthStencilSurface(IntPtr.Zero);
                dev.SetFVF(D3D9.Fvf.XyzRhwTex1);
                dev.SetSamplerState(0, D3D9.Samp.AddressU, (uint)D3D9.Address.Clamp);
                dev.SetSamplerState(0, D3D9.Samp.AddressV, (uint)D3D9.Address.Clamp);
                dev.SetSamplerState(0, D3D9.Samp.MagFilter, (uint)D3D9.Filter.Linear);
                dev.SetSamplerState(0, D3D9.Samp.MinFilter, (uint)D3D9.Filter.Linear);
                dev.SetSamplerState(0, D3D9.Samp.MipFilter, (uint)D3D9.Filter.None);
                dev.SetSamplerState(0, D3D9.Samp.SrgbTexture, 0);

                // (0) copy the 3D viewport region of the backbuffer into sceneTex (full-res 0..W).
                if (origRt == IntPtr.Zero) return;
                Rect src = new Rect { Left = vp.X, Top = vp.Y, Right = vp.X + vp.W, Bottom = vp.Y + vp.H };
                Rect dst = new Rect { Left = 0, Top = 0, Right = _fullW, Bottom = _fullH };
                if (dev.StretchRect(origRt, &src, _sceneSurf, &dst, D3D9.Filter.Linear) < 0) return;

                // (1) bright-pass: sceneTex -> brightTex (half-res)
                dev.SetRenderTarget(0, _brightSurf);
                SetViewport(dev, _halfW, _halfH);
                dev.SetRenderState(D3D9.Rs.AlphaBlendEnable, 0);
                dev.SetPixelShader(_psBright);
                float knee = Math.Max(1e-4f, _cfg.BloomKnee);
                SetPsConst(dev, 0, _cfg.BloomThreshold, knee, 1.0f, 0f);
                SetPsConst(dev, 1, 1f / _fullW, 1f / _fullH, 0f, 0f);
                dev.SetTexture(0, _sceneTex);
                DrawQuad(dev, 0, 0, _halfW, _halfH);

                // (2..) separable blur, ping-pong bright<->blur, radiusPasses times.
                int passes = Math.Clamp((int)_cfg.BloomRadius, 1, 4);
                for (int p = 0; p < passes; p++) {
                    // H: brightTex -> blurTex
                    dev.SetRenderTarget(0, _blurSurf);
                    SetViewport(dev, _halfW, _halfH);
                    dev.SetPixelShader(_psBlur);
                    SetPsConst(dev, 0, 1f / _halfW, 0f, 0f, 0f);
                    dev.SetTexture(0, _brightTex);
                    DrawQuad(dev, 0, 0, _halfW, _halfH);
                    // V: blurTex -> brightTex
                    dev.SetRenderTarget(0, _brightSurf);
                    SetViewport(dev, _halfW, _halfH);
                    SetPsConst(dev, 0, 0f, 1f / _halfH, 0f, 0f);
                    dev.SetTexture(0, _blurTex);
                    DrawQuad(dev, 0, 0, _halfW, _halfH);
                }

                // (3) composite ADDITIVELY over the backbuffer, in the 3D viewport rect.
                dev.SetRenderTarget(0, origRt);
                dev.SetViewport(origVp);
                dev.SetRenderState(D3D9.Rs.AlphaBlendEnable, 1);
                dev.SetRenderState(D3D9.Rs.SrcBlend, (uint)D3D9.Blend.One);
                dev.SetRenderState(D3D9.Rs.DestBlend, (uint)D3D9.Blend.One);
                dev.SetPixelShader(_psComposite);
                SetPsConst(dev, 0, _cfg.BloomIntensity, 0f, 0f, 0f);
                dev.SetTexture(0, _brightTex);
                DrawQuad(dev, vp.X, vp.Y, vp.X + vp.W, vp.Y + vp.H);

                if (!_firstOk) { _firstOk = true; _log.LogInformation("acmelights: bloom first composite ok"); }
            }
            finally {
                // --- restore everything we touched ---
                dev.SetPixelShader(IntPtr.Zero);   // client never nulls PS itself -> mandatory
                dev.SetTexture(0, IntPtr.Zero);
                dev.SetRenderTarget(0, origRt);
                dev.SetDepthStencilSurface(origDs);
                dev.SetViewport(origVp);
                dev.SetRenderState(D3D9.Rs.ZEnable, sZ);
                dev.SetRenderState(D3D9.Rs.ZWriteEnable, sZW);
                dev.SetRenderState(D3D9.Rs.AlphaBlendEnable, sAB);
                dev.SetRenderState(D3D9.Rs.SrcBlend, sSB);
                dev.SetRenderState(D3D9.Rs.DestBlend, sDB);
                dev.SetRenderState(D3D9.Rs.AlphaTestEnable, sAT);
                dev.SetRenderState(D3D9.Rs.CullMode, sCull);
                dev.SetRenderState(D3D9.Rs.Lighting, sLit);
                dev.SetRenderState(D3D9.Rs.FogEnable, sFog);
                dev.SetRenderState(D3D9.Rs.ColorWriteEnable, sCW);
                dev.SetRenderState(D3D9.Rs.SrgbWriteEnable, sSrgb);
                if (origRt != IntPtr.Zero) D3D9.ReleaseCom(origRt);   // GetRenderTarget AddRef'd it
                if (origDs != IntPtr.Zero) D3D9.ReleaseCom(origDs);
            }
        }

        private static void SetViewport(Device dev, int w, int h) =>
            dev.SetViewport(new D3DViewport9 { X = 0, Y = 0, Width = (uint)w, Height = (uint)h, MinZ = 0f, MaxZ = 1f });

        private static void SetPsConst(Device dev, uint reg, float x, float y, float z, float w) {
            float* v = stackalloc float[4] { x, y, z, w };
            dev.SetPixelShaderConstantF(reg, v, 1);
        }

        /// <summary>Fullscreen quad covering screen rect [x0,x1)x[y0,y1) with uv 0..1 (half-texel).</summary>
        private static void DrawQuad(Device dev, int x0, int y0, int x1, int y1) {
            float fx0 = x0 - 0.5f, fy0 = y0 - 0.5f, fx1 = x1 - 0.5f, fy1 = y1 - 0.5f;
            QuadVert* q = stackalloc QuadVert[6];
            q[0] = V(fx0, fy0, 0, 0); q[1] = V(fx1, fy0, 1, 0); q[2] = V(fx0, fy1, 0, 1);
            q[3] = V(fx1, fy0, 1, 0); q[4] = V(fx1, fy1, 1, 1); q[5] = V(fx0, fy1, 0, 1);
            dev.DrawPrimitiveUP(D3D9.Prim.TriangleList, 2, q, (uint)sizeof(QuadVert));
        }
        private static QuadVert V(float x, float y, float u, float v) =>
            new QuadVert { X = x, Y = y, Z = 0f, Rhw = 1f, U = u, V = v };

        private void LogErr(Exception ex, string stage) {
            long now = _clock.ElapsedTicks;
            if (now - _lastErrTicks < Stopwatch.Frequency) return;
            _lastErrTicks = now;
            _log.LogWarning(ex, "acmelights: bloom '{Stage}' failed", stage);
        }
    }
}
