using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using AcmeLights.Lib;
using Microsoft.Extensions.Logging;
using Vortice.D3DCompiler;

namespace AcmeLights.Services {
    /// <summary>
    /// MILESTONE P5 (AcmeBloom) — the luminance/bloom post-process, run on the CLIENT'S OWN
    /// IDirect3DDevice9 from the zero-detour <c>SmartBox::m_renderingCallback</c> slot (see
    /// RenderCallback.cs) at the tail of RenderNormalMode — after the full 3D world, before the 2D
    /// UI; BeginScene open, backbuffer bound, pure fixed-function state. (The original
    /// SceneTool::EndFrame detour is gone: its cdecl trampoline destabilized the client.)
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
        private long _lastErrTicks = -Stopwatch.Frequency;   // NOT long.MinValue (overflow mutes the throttle)
        private bool _firstOk;

        // device-owned resources (all D3DPOOL_DEFAULT / shaders)
        private IntPtr _dev;
        private IntPtr _psBright, _psBlur, _psComposite;
        private IntPtr _sceneTex, _sceneSurf;
        private IntPtr _brightTex, _brightSurf;
        private IntPtr _blurTex, _blurSurf;
        private int _fullW, _fullH, _halfW, _halfH;
        private bool _resourcesFailed;

        // Shader BYTECODE precompiled on the MANAGED plugin thread (Initialize), never on the native
        // EndFrame detour thread: the plugin ALC throws 0x80131509 "operation is not legal in the
        // current state" when Vortice.D3DCompiler is first loaded from the native thread (the same
        // trap WarmupAcBindings avoids for ACBindings). The detour only calls CreatePixelShader(bytes).
        private byte[]? _bcBright, _bcBlur, _bcComposite;
        public bool ShadersPrecompiled => _bcBright != null && _bcBlur != null && _bcComposite != null;

        [StructLayout(LayoutKind.Sequential)]
        private struct QuadVert { public float X, Y, Z, Rhw, U, V; }

        // Crash-surviving stage trace: a native access violation loses the buffered Chorizite log,
        // so during bring-up we append+flush each stage to its own file. First few frames only.
        private int _traceFrames;
        private static void Trace(string s) {
            try { System.IO.File.AppendAllText(@"C:\Temp\acdt\bloomtrace.txt",
                DateTime.UtcNow.ToString("HH:mm:ss.fff") + " " + s + "\r\n"); } catch { }
        }

        public BloomCompositor(ILogger log, LightsConfig cfg) { _log = log; _cfg = cfg; }

        /// <summary>Compile the three pixel shaders to bytecode on the MANAGED thread (call from the
        /// plugin's Initialize). This loads + JITs Vortice.D3DCompiler here, so the native EndFrame
        /// detour never triggers the 0x80131509 ALC-load fault. Safe to call before any device exists
        /// (D3DCompile is device-independent). Never throws.</summary>
        public void PrecompileShaders() {
            try {
                _bcBright = CompileBytecode(BloomShaders.PsBrightPass, "PsBrightPass");
                _bcBlur = CompileBytecode(BloomShaders.PsBlur, "PsBlur");
                _bcComposite = CompileBytecode(BloomShaders.PsComposite, "PsComposite");
                _log.LogInformation("acmelights: bloom shaders precompiled (bright={B} blur={L} composite={C} bytes)",
                    _bcBright?.Length ?? -1, _bcBlur?.Length ?? -1, _bcComposite?.Length ?? -1);
            }
            catch (Exception ex) {
                _log.LogError(ex, "acmelights: bloom shader precompile FAILED; bloom disabled");
                _bcBright = _bcBlur = _bcComposite = null;
            }
        }

        private static byte[] CompileBytecode(string hlsl, string entry) {
            var blob = Compiler.Compile(hlsl, "main", entry + ".hlsl", "ps_2_0",
                ShaderFlags.OptimizationLevel3, EffectFlags.None);
            return blob.Span.ToArray();
        }

        /// <summary>Called from the m_renderingCallback slot. dev = client device; vp = current 3D viewport.</summary>
        public void Frame(IntPtr devPtr, in ClientState.Viewport vp) {
            if (_cfg.Bloom <= 0.5f) return;
            if (devPtr == IntPtr.Zero || !vp.Valid || !vp.OpenScene) return;
            bool trace = _traceFrames < 4;
            if (trace) { _traceFrames++; Trace($"--- frame {_traceFrames} enter dev=0x{devPtr:X} vp={vp.W}x{vp.H} open={vp.OpenScene}"); }
            try {
                var dev = new Device(devPtr);
                if (!EnsureResources(dev, devPtr, vp.W, vp.H, trace)) { if (trace) Trace("ensure returned false"); return; }
                if (trace) Trace("ensure ok -> RenderBloom");
                RenderBloom(dev, in vp, trace);
                if (trace) Trace("RenderBloom returned ok");
            }
            catch (Exception ex) { if (trace) Trace("EXC frame: " + ex); LogErr(ex, "frame"); }
        }

        // ---- resource lifecycle ----
        private bool EnsureResources(Device dev, IntPtr devPtr, int w, int h, bool trace = false) {
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
                if (!ShadersPrecompiled) { if (trace) Trace("shaders not precompiled -> disable"); _resourcesFailed = true; return false; }
                if (trace) Trace("create pixel shaders from cached bytecode");
                if (_psBright == IntPtr.Zero) _psBright = dev.CreatePixelShader(_bcBright!);
                if (_psBlur == IntPtr.Zero) _psBlur = dev.CreatePixelShader(_bcBlur!);
                if (_psComposite == IntPtr.Zero) _psComposite = dev.CreatePixelShader(_bcComposite!);
                if (trace) Trace($"PS bright=0x{_psBright:X} blur=0x{_psBlur:X} composite=0x{_psComposite:X}; create RTs");

                _sceneTex = dev.CreateTexture((uint)w, (uint)h, 1, D3D9.Usage.RenderTarget, D3D9.Fmt.A8R8G8B8, D3D9.Pool.Default);
                _brightTex = dev.CreateTexture((uint)_halfW, (uint)_halfH, 1, D3D9.Usage.RenderTarget, D3D9.Fmt.A8R8G8B8, D3D9.Pool.Default);
                _blurTex = dev.CreateTexture((uint)_halfW, (uint)_halfH, 1, D3D9.Usage.RenderTarget, D3D9.Fmt.A8R8G8B8, D3D9.Pool.Default);
                if (_sceneTex == IntPtr.Zero || _brightTex == IntPtr.Zero || _blurTex == IntPtr.Zero ||
                    _psBright == IntPtr.Zero || _psBlur == IntPtr.Zero || _psComposite == IntPtr.Zero)
                    throw new InvalidOperationException("bloom resource creation returned null");

                if (trace) Trace($"RTs scene=0x{_sceneTex:X} bright=0x{_brightTex:X} blur=0x{_blurTex:X}; get surfaces");
                _sceneSurf = new Texture9(_sceneTex).GetSurfaceLevel(0);
                _brightSurf = new Texture9(_brightTex).GetSurfaceLevel(0);
                _blurSurf = new Texture9(_blurTex).GetSurfaceLevel(0);
                if (trace) Trace($"surfaces scene=0x{_sceneSurf:X} bright=0x{_brightSurf:X} blur=0x{_blurSurf:X}");
                if (_sceneSurf == IntPtr.Zero || _brightSurf == IntPtr.Zero || _blurSurf == IntPtr.Zero)
                    throw new InvalidOperationException("bloom GetSurfaceLevel returned null");

                _log.LogInformation("acmelights: bloom resources ready {W}x{H} (half {HW}x{HH})", w, h, _halfW, _halfH);
                return true;
            }
            catch (Exception ex) {
                if (trace) Trace("EXC ensure: " + ex.GetType().Name + ": " + ex.Message +
                                 (ex.InnerException != null ? " | inner: " + ex.InnerException.Message : ""));
                LogErr(ex, "ensure");
                _resourcesFailed = true;
                ReleaseResources();
                return false;
            }
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
        private void RenderBloom(Device dev, in ClientState.Viewport vp, bool trace = false) {
            // Capture ALL device state up-front (D3DSBT_ALL) and Apply() it on the way out — the
            // robust restore the client depends on (it never re-sets RT/shader/FVF itself, and a
            // single mis-restored state crashes its subsequent UI draw). Same pattern as Chorizite's
            // own overlay. StateBlock does NOT cover render targets, so RT/DS/viewport are restored
            // manually too. If CreateStateBlock is disallowed here, skip bloom (safe).
            if (trace) Trace("CreateStateBlock(ALL)");
            IntPtr sb = dev.CreateStateBlock(1 /*D3DSBT_ALL*/);
            if (sb == IntPtr.Zero) { if (trace) Trace("CreateStateBlock null -> skip"); return; }
            IntPtr origRt = dev.GetRenderTarget(0);
            IntPtr origDs = dev.GetDepthStencilSurface();
            D3DViewport9 origVp = dev.GetViewport();

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
                if (origRt == IntPtr.Zero) { if (trace) Trace("origRt null"); return; }

                // Unbind the backbuffer as RT0 BEFORE using it as a StretchRect SOURCE — several
                // drivers fault when StretchRect's source is the currently-bound render target.
                if (trace) Trace("bind brightSurf then StretchRect");
                dev.SetRenderTarget(0, _brightSurf);
                SetViewport(dev, _halfW, _halfH);

                Rect src = new Rect { Left = vp.X, Top = vp.Y, Right = vp.X + vp.W, Bottom = vp.Y + vp.H };
                Rect dst = new Rect { Left = 0, Top = 0, Right = _fullW, Bottom = _fullH };
                int srHr = dev.StretchRect(origRt, &src, _sceneSurf, &dst, D3D9.Filter.Linear);
                if (trace) Trace($"StretchRect hr={srHr}");
                if (srHr < 0) return;

                // DAY/NIGHT BLEND (2026-08-23). SkyState.Day is 0 in a dungeon and at outdoor
                // midnight — both are pinned to the client's LSCAPE_LIGHT_MINIMUM 0.2 ambient — so
                // at night and indoors these three resolve EXACTLY to the owner-proven night knobs
                // and the frame is unchanged. Only a brightening sky moves them (see Lib/SkyState).
                float bThreshold = SkyState.Blend(_cfg.BloomThreshold, _cfg.BloomDayThreshold);
                float bIntensity = SkyState.Blend(_cfg.BloomIntensity, _cfg.BloomDayIntensity);
                float bRadius = SkyState.Blend(_cfg.BloomRadius, _cfg.BloomDayRadius);

                // (1) bright-pass: sceneTex -> brightTex (half-res) -- RT already bound above.
                if (trace) Trace("bright pass");
                dev.SetRenderState(D3D9.Rs.AlphaBlendEnable, 0);
                dev.SetPixelShader(_psBright);
                float knee = Math.Max(1e-4f, _cfg.BloomKnee);
                SetPsConst(dev, 0, bThreshold, knee, 1.0f, 0f);
                SetPsConst(dev, 1, 1f / _fullW, 1f / _fullH, 0f, 0f);
                dev.SetTexture(0, _sceneTex);
                DrawQuad(dev, 0, 0, _halfW, _halfH);

                // (2..) separable blur, ping-pong bright<->blur, radiusPasses times.
                // Pass count is discrete, so round the blend rather than truncating it (truncation
                // would sit on the night value for most of the ramp).
                int passes = Math.Clamp((int)MathF.Round(bRadius), 1, 4);
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
                if (trace) Trace("composite");
                dev.SetRenderTarget(0, origRt);
                dev.SetViewport(origVp);
                dev.SetRenderState(D3D9.Rs.AlphaBlendEnable, 1);
                dev.SetRenderState(D3D9.Rs.SrcBlend, (uint)D3D9.Blend.One);
                dev.SetRenderState(D3D9.Rs.DestBlend, (uint)D3D9.Blend.One);
                dev.SetPixelShader(_psComposite);
                SetPsConst(dev, 0, bIntensity, 0f, 0f, 0f);
                dev.SetTexture(0, _brightTex);
                DrawQuad(dev, vp.X, vp.Y, vp.X + vp.W, vp.Y + vp.H);

                if (!_firstOk) { _firstOk = true; _log.LogInformation("acmelights: bloom first composite ok"); }
            }
            finally {
                // Apply the captured state block (restores render/sampler/texture-stage/shader/FVF/
                // viewport), then restore render targets manually (not covered by a state block).
                Device.StateBlockApply(sb);
                dev.SetRenderTarget(0, origRt);
                dev.SetDepthStencilSurface(origDs);
                dev.SetViewport(origVp);
                D3D9.ReleaseCom(sb);
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
