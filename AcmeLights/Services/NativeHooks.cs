using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using ACBindings.Internal;
using AcmeLights.Lib;
using Microsoft.Extensions.Logging;
using Reloaded.Hooks;
using Reloaded.Hooks.Definitions;
using Reloaded.Hooks.Definitions.X86;

namespace AcmeLights.Services {
    /// <summary>
    /// Inline trampoline detours for AcmeLights, same engine/pattern as AcmeRagdoll:
    ///   [Function(MicrosoftThiscall)] delegate with nint params + [UnmanagedCallersOnly(
    ///   CallConvMemberFunction)] impl + OriginalFunction chaining.
    ///
    ///   * PrimD3DRender::UpdateLightsInternal @0x0059BEE0 -- per-viewpoint heartbeat. Post-detour:
    ///     forward original (which finalizes the FF pool + view-space positions), THEN run
    ///     LightManager.OnUpdateLights (enumerate/caps/headlamp/flicker).
    ///   * SmartBox::SetWorldAmbientLight @0x004530E0 -- the ambient funnel. Post-detour: fix the
    ///     retail red-bias bug (only .r scaled by intensity) by recomputing world_lights.ambient_color
    ///     across all channels, and optionally override the hardcoded dungeon ambient.
    ///
    /// Detours never let an exception unwind into C++ client code. Registry reached via static fields
    /// (UnmanagedCallersOnly cannot capture). Disable()d in Dispose; unload only when idle.
    /// </summary>
    internal sealed unsafe class NativeHooks : IDisposable {
        [Function(CallingConventions.MicrosoftThiscall)]
        private delegate void UpdateLightsFn(nint self);

        // void __thiscall SmartBox::SetWorldAmbientLight(SmartBox* this, float intensity, uint color)
        [Function(CallingConventions.MicrosoftThiscall)]
        private delegate void SetAmbientFn(nint self, float intensity, uint color);

        // void __cdecl SceneTool::EndFrame(bool bDrawUI) -- post-3D / pre-UI boundary for bloom.
        [Function(CallingConventions.Cdecl)]
        private delegate void EndFrameFn(byte bDrawUI);

        // void __thiscall RenderDeviceD3D::EndScene(RenderDeviceD3D* this) -- scene-closed dump point.
        [Function(CallingConventions.MicrosoftThiscall)]
        private delegate void EndSceneFn(nint self);

        private static IHook<UpdateLightsFn>? _updateLights;
        private static IHook<SetAmbientFn>? _setAmbient;
        private static IHook<EndFrameFn>? _endFrame;
        private static IHook<EndSceneFn>? _endScene;
        private static LightManager? _mgr;
        private static BloomCompositor? _bloom;
        private static DumpService? _dump;
        private static LightsConfig? _cfg;
        private static ILogger? _log;

        private readonly ILogger _ilog;
        private bool _installed, _disposed;

        public NativeHooks(ILogger log) { _ilog = log; _log = log; }
        public bool Installed => _installed;

        public void Install(LightManager mgr, BloomCompositor bloom, DumpService dump, LightsConfig cfg) {
            if (_installed || _disposed) return;
            _mgr = mgr; _bloom = bloom; _dump = dump; _cfg = cfg;

            nint updAddr = AddressResolver.Resolve("PrimD3DRender::UpdateLightsInternal",
                ClientFunctions.UpdateLightsInternal_Sig, ClientFunctions.UpdateLightsInternal_VA);
            nint ambAddr = AddressResolver.Resolve("SmartBox::SetWorldAmbientLight",
                ClientFunctions.SetWorldAmbientLight_Sig, ClientFunctions.SetWorldAmbientLight_VA);
            float extra = cfg.ExtraHooks;   // 0 none | 1 endscene | 2 endscene+endframe

            try {
                _updateLights = ReloadedHooks.Instance
                    .CreateHook<UpdateLightsFn>(typeof(NativeHooks), nameof(UpdateLightsImpl), (long)updAddr)
                    .Activate();
                _ilog.LogInformation("acmelights: hook installed  PrimD3DRender::UpdateLightsInternal @ {A:X8}", (long)updAddr);
            }
            catch (Exception ex) {
                _ilog.LogError(ex, "acmelights: hook FAILED  UpdateLightsInternal @ {A:X8}", (long)updAddr);
            }

            try {
                _setAmbient = ReloadedHooks.Instance
                    .CreateHook<SetAmbientFn>(typeof(NativeHooks), nameof(SetAmbientImpl), (long)ambAddr)
                    .Activate();
                _ilog.LogInformation("acmelights: hook installed  SmartBox::SetWorldAmbientLight @ {A:X8}", (long)ambAddr);
            }
            catch (Exception ex) {
                _ilog.LogError(ex, "acmelights: hook FAILED  SetWorldAmbientLight @ {A:X8}", (long)ambAddr);
            }

            if (extra >= 1f) {
                nint esAddr = AddressResolver.Resolve("RenderDeviceD3D::EndScene",
                    ClientFunctions.EndScene_Sig, ClientFunctions.EndScene_VA);
                try {
                    _endScene = ReloadedHooks.Instance
                        .CreateHook<EndSceneFn>(typeof(NativeHooks), nameof(EndSceneImpl), (long)esAddr)
                        .Activate();
                    _ilog.LogInformation("acmelights: hook installed  RenderDeviceD3D::EndScene @ {A:X8}", (long)esAddr);
                }
                catch (Exception ex) {
                    _ilog.LogError(ex, "acmelights: hook FAILED  RenderDeviceD3D::EndScene @ {A:X8}", (long)esAddr);
                }
            }

            if (extra >= 2f) {
                nint efAddr = AddressResolver.Resolve("SceneTool::EndFrame",
                    ClientFunctions.EndFrame_Sig, ClientFunctions.EndFrame_VA);
                try {
                    _endFrame = ReloadedHooks.Instance
                        .CreateHook<EndFrameFn>(typeof(NativeHooks), nameof(EndFrameImpl), (long)efAddr)
                        .Activate();
                    _ilog.LogInformation("acmelights: hook installed  SceneTool::EndFrame @ {A:X8}", (long)efAddr);
                }
                catch (Exception ex) {
                    _ilog.LogError(ex, "acmelights: hook FAILED  SceneTool::EndFrame @ {A:X8}", (long)efAddr);
                }
            }

            _installed = _updateLights != null || _setAmbient != null || _endFrame != null || _endScene != null;
        }

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvMemberFunction) })]
        private static void UpdateLightsImpl(nint self) {
            _updateLights!.OriginalFunction(self);
            try { _mgr?.OnUpdateLights(); }
            catch (Exception ex) { LogSafe(ex, "UpdateLights"); }
        }

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvMemberFunction) })]
        private static void SetAmbientImpl(nint self, float intensity, uint color) {
            // Optional dungeon-ambient override: the client calls this with (0.2, 0xFFFFFFFF) for
            // enclosed cells. Swap in the cfg values before the original runs so downstream state
            // (game_ambient_level/color) is consistent too.
            var cfg = _cfg;
            if (cfg != null && cfg.DungeonAmbient >= 0f &&
                MathF.Abs(intensity - 0.2f) < 1e-4f && color == 0xFFFFFFFF) {
                intensity = cfg.DungeonAmbient;
                color = 0xFF000000u | (cfg.DungeonAmbientColor & 0xFFFFFF);
            }
            _setAmbient!.OriginalFunction(self, intensity, color);
            try {
                // Retail bug (SSetWorldAmbientLight): ambient_color.r *= intensity but .g/.b left raw.
                // Recompute all three from the 8-bit color so colored ambient stays neutral in hue.
                if (cfg != null && cfg.AmbientFix > 0.5f) {
                    LightParms* wl = Render.world_lights;
                    if (wl != null) {
                        float r = ((color >> 16) & 0xFF) / 255f;
                        float g = ((color >> 8) & 0xFF) / 255f;
                        float b = (color & 0xFF) / 255f;
                        wl->ambient_color.r = r * intensity;
                        wl->ambient_color.g = g * intensity;
                        wl->ambient_color.b = b * intensity;
                    }
                }
            }
            catch (Exception ex) { LogSafe(ex, "SetAmbient"); }
        }

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
        private static void EndFrameImpl(byte bDrawUI) {
            // Run bloom BEFORE the UI is drawn (this function draws the 2D UI then EndScene/Flip).
            try {
                if (_bloom != null) {
                    var vp = AcmeLights.Lib.ClientState.GetViewport();
                    if (vp.Valid && vp.OpenScene)
                        _bloom.Frame(AcmeLights.Lib.ClientState.GetDevicePointer(), in vp);
                }
            }
            catch (Exception ex) { LogSafe(ex, "EndFrame"); }
            _endFrame!.OriginalFunction(bDrawUI);
        }

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvMemberFunction) })]
        private static void EndSceneImpl(nint self) {
            _endScene!.OriginalFunction(self);   // let the client close the scene first
            try { _dump?.OnEndScene(AcmeLights.Lib.ClientState.GetDevicePointer()); }
            catch (Exception ex) { LogSafe(ex, "EndScene"); }
        }

        private static long _lastErr = long.MinValue;
        private static void LogSafe(Exception ex, string stage) {
            long now = Environment.TickCount64;
            if (now - _lastErr < 1000) return;
            _lastErr = now;
            try { _log?.LogWarning(ex, "acmelights: detour '{Stage}' failed", stage); } catch { }
        }

        public void Dispose() {
            if (_disposed) return;
            _disposed = true;
            try { _updateLights?.Disable(); } catch { }
            try { _setAmbient?.Disable(); } catch { }
            try { _endFrame?.Disable(); } catch { }
            try { _endScene?.Disable(); } catch { }
            _installed = false;
        }
    }
}
