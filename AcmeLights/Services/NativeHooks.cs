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

        // NOTE (2026-08-22): there is deliberately NO SceneTool::EndFrame detour. The cdecl(byte)
        // trampoline on it destabilized the client (faulted ~1s in even with the detour body doing
        // nothing beyond the pipeline that ran frame 1 clean). Bloom instead runs from the zero-detour
        // SmartBox::m_renderingCallback slot -- see RenderCallback.cs.

        // void __thiscall RenderDeviceD3D::EndScene(RenderDeviceD3D* this) -- scene-closed dump point.
        [Function(CallingConventions.MicrosoftThiscall)]
        private delegate void EndSceneFn(nint self);

        // ===================== P4 LIGHT SELECTION — BEGIN (LightSelection.cs) =====================
        // void __cdecl Render::minimize_object_lighting() -- the per-draw slot chooser. NO arguments
        // and no return, so the trampoline has nothing to marshal; this is NOT the cdecl(byte)
        // shape that destabilized the client on SceneTool::EndFrame. Full replacement detour: the
        // impl reproduces retail's eligibility test exactly and drives the same three native
        // primitives, only ranking the candidates by attenuated contribution at the lit object.
        [Function(CallingConventions.Cdecl)]
        private delegate void MinimizeObjectLightingFn();

        private static IHook<MinimizeObjectLightingFn>? _minObjLight;
        private static LightSelection? _sel;
        // ====================== P4 LIGHT SELECTION — END =========================================

        // ─── P3 glowlights: BEGIN (Services/GlowLights.cs owns the body) ─────────────────────
        // void __thiscall SmartBox::set_viewer(SmartBox*, const Position*, int) @0x00452C80.
        // The per-frame dynamic-light wipe+refill (acclient.c:143995). POST-detour appends the
        // plugin's glow lights, so they live exactly one frame and re-add cleanly next frame.
        [Function(CallingConventions.MicrosoftThiscall)]
        private delegate void SetViewerFn(nint self, nint newViewer, int setSoughtPosition);
        // ─── P3 glowlights: END ──────────────────────────────────────────────────────────────

        private static IHook<UpdateLightsFn>? _updateLights;
        private static IHook<SetAmbientFn>? _setAmbient;
        private static IHook<EndSceneFn>? _endScene;
        private static IHook<SetViewerFn>? _setViewer;   // P3 glowlights
        private static LightManager? _mgr;
        private static DumpService? _dump;
        private static LightsConfig? _cfg;
        private static ILogger? _log;

        private readonly ILogger _ilog;
        private bool _installed, _disposed;

        public NativeHooks(ILogger log) { _ilog = log; _log = log; }
        public bool Installed => _installed;

        public void Install(LightManager mgr, DumpService dump, LightsConfig cfg) {
            if (_installed || _disposed) return;
            _mgr = mgr; _dump = dump; _cfg = cfg;

            nint updAddr = AddressResolver.Resolve("PrimD3DRender::UpdateLightsInternal",
                ClientFunctions.UpdateLightsInternal_Sig, ClientFunctions.UpdateLightsInternal_VA);
            nint ambAddr = AddressResolver.Resolve("SmartBox::SetWorldAmbientLight",
                ClientFunctions.SetWorldAmbientLight_Sig, ClientFunctions.SetWorldAmbientLight_VA);
            float extra = cfg.ExtraHooks;   // 0 none | >=1 endscene (capture)

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

            // ─── P3 glowlights: BEGIN ────────────────────────────────────────────────────────
            // Installed unconditionally so `glowlights` live-toggles like bloom/torchlights; the
            // detour body returns immediately when the master knob is 0, so a disabled build is
            // frame-identical to stock. Same thiscall shape as the proven SetWorldAmbientLight
            // trampoline (NOT the cdecl(byte) EndFrame shape that destabilized the client).
            nint svAddr = AddressResolver.Resolve("SmartBox::set_viewer",
                ClientFunctions.SetViewer_Sig, ClientFunctions.SetViewer_VA);
            try {
                _setViewer = ReloadedHooks.Instance
                    .CreateHook<SetViewerFn>(typeof(NativeHooks), nameof(SetViewerImpl), (long)svAddr)
                    .Activate();
                _ilog.LogInformation("acmelights: hook installed  SmartBox::set_viewer @ {A:X8}", (long)svAddr);
            }
            catch (Exception ex) {
                _ilog.LogError(ex, "acmelights: hook FAILED  SmartBox::set_viewer @ {A:X8}", (long)svAddr);
            }
            // ─── P3 glowlights: END ──────────────────────────────────────────────────────────

            _installed = _updateLights != null || _setAmbient != null || _endScene != null
                         || _setViewer != null;
        }

        // ===================== P4 LIGHT SELECTION — BEGIN (LightSelection.cs) =====================

        /// <summary>Install the importance-ranked per-draw selection detour. Separate from
        /// <see cref="Install"/> so P4 stays a self-contained block. With `selection = 0` in the cfg
        /// at startup NOTHING is installed at all — the client keeps retail's own
        /// minimize_object_lighting, bit for bit. Once installed, a live `selection = 0` still gives
        /// bit-identical retail behaviour by chaining straight to OriginalFunction.</summary>
        public void InstallSelection(LightSelection sel, LightsConfig cfg) {
            if (_disposed || _minObjLight != null) return;
            _sel = sel;
            if (cfg.Selection < 0.5f) {
                _ilog.LogInformation("acmelights: P4 selection disabled by cfg (selection=0); minimize_object_lighting left untouched");
                return;
            }
            nint addr = AddressResolver.Resolve("Render::minimize_object_lighting",
                null, LightSelection.MinimizeObjectLighting_VA);
            try {
                _minObjLight = ReloadedHooks.Instance
                    .CreateHook<MinimizeObjectLightingFn>(typeof(NativeHooks), nameof(MinimizeObjectLightingImpl), (long)addr)
                    .Activate();
                _installed = true;
                _ilog.LogInformation("acmelights: hook installed  Render::minimize_object_lighting @ {A:X8} (P4 selection)", (long)addr);
            }
            catch (Exception ex) {
                _ilog.LogError(ex, "acmelights: hook FAILED  minimize_object_lighting @ {A:X8}", (long)addr);
            }
        }

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
        private static void MinimizeObjectLightingImpl() {
            LightSelection? sel = _sel;
            if (sel != null && sel.Enabled) {
                try {
                    // Run() returns false when it declined (null pools, impossible counts, no
                    // candidates); either way falling through to the original is always safe --
                    // retail's body is a complete reset + rebuild + enable of its own.
                    if (sel.Run()) return;
                }
                catch (Exception ex) { LogSafe(ex, "MinimizeObjectLighting"); }
            }
            _minObjLight!.OriginalFunction();
        }

        // ====================== P4 LIGHT SELECTION — END =========================================

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvMemberFunction) })]
        private static void UpdateLightsImpl(nint self) {
            _updateLights!.OriginalFunction(self);
            try { _mgr?.OnUpdateLights(); }
            catch (Exception ex) { LogSafe(ex, "UpdateLights"); }
            // Re-assert the bloom rendering-callback slot every frame: SmartBox::Reset zeroes it on
            // teleport/relog. This heartbeat runs during the 3D pass, before the slot fires at the
            // tail of RenderNormalMode, on the same thread.
            RenderCallback.EnsureInstalled();
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

        // ─── P3 glowlights: BEGIN ────────────────────────────────────────────────────────────
        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvMemberFunction) })]
        private static void SetViewerImpl(nint self, nint newViewer, int setSoughtPosition) {
            // Let the client wipe (num_dynamic_lights = 0), re-add viewer_light and refill from
            // CObjCell::add_dynamic_lights() FIRST — then append ours to the same pool.
            _setViewer!.OriginalFunction(self, newViewer, setSoughtPosition);
            try { GlowLights.OnSetViewer(); }
            catch (Exception ex) { LogSafe(ex, "SetViewer"); }
        }
        // ─── P3 glowlights: END ──────────────────────────────────────────────────────────────

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvMemberFunction) })]
        private static void EndSceneImpl(nint self) {
            _endScene!.OriginalFunction(self);   // let the client close the scene first
            try { _dump?.OnEndScene(AcmeLights.Lib.ClientState.GetDevicePointer()); }
            catch (Exception ex) { LogSafe(ex, "EndScene"); }
        }

        // -1_000_000, NOT long.MinValue: `now - long.MinValue` overflows negative and the throttle
        // suppresses every log forever (the DumpService/AcmeSky bug).
        private static long _lastErr = -1_000_000;
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
            try { _endScene?.Disable(); } catch { }
            try { _minObjLight?.Disable(); } catch { }   // P4 selection
            try { _setViewer?.Disable(); } catch { }   // P3 glowlights
            _installed = false;
        }
    }
}
