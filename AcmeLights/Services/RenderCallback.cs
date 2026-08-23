using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using AcmeLights.Lib;
using Microsoft.Extensions.Logging;

namespace AcmeLights.Services {
    /// <summary>
    /// ZERO-DETOUR bloom hook: the client keeps a `void (__cdecl*)()` slot at SmartBox+276
    /// (m_renderingCallback, PDB fieldlist 0x5eb3) and invokes it at the tail of
    /// SmartBox::RenderNormalMode — immediately after the final D3DPolyRender::FlushAlphaList, before
    /// SceneTool::EndFrame draws any UI. That is the exact post-3D/pre-UI boundary the bloom pass
    /// needs (BeginScene still open, backbuffer bound, 3D viewport current), WITHOUT the
    /// SceneTool::EndFrame cdecl(byte) trampoline that destabilized the client (2026-08-22: EndScene
    /// thiscall detour stable indefinitely; adding the EndFrame detour faulted ~1s after frame 1).
    ///
    /// Nothing in the shipped client or Chorizite ever sets this slot (only SmartBox::Reset zeroes
    /// it on teleport/relog), so we re-assert the pointer once per frame from the
    /// UpdateLightsInternal heartbeat — a single idempotent pointer poke on the render thread, the
    /// same thread that invokes the callback (no cross-thread race). Any foreign pointer found in
    /// the slot is chained after our pass. Only fires in-world (player + viewer_cell non-null),
    /// which is the only place bloom matters.
    /// </summary>
    internal static unsafe class RenderCallback {
        /// <summary>SmartBox::m_renderingCallback byte offset (PDB: @272 'objects', @276 'm_renderingCallback').
        /// NOT readable via the ACBindings struct — its generator mis-emits function-pointer members
        /// as `static`, so the managed layout is wrong past target_object_id.</summary>
        private const int SlotOffset = 276;

        private static BloomCompositor? _bloom;
        private static LightsConfig? _cfg;
        private static ILogger? _log;
        private static nint _prev;          // foreign callback found in the slot (chained; usually 0)
        private static bool _loggedInstall;
        private static readonly System.Diagnostics.Stopwatch _clock = System.Diagnostics.Stopwatch.StartNew();
        private static long _lastReload = -System.Diagnostics.Stopwatch.Frequency;

        public static void Configure(BloomCompositor bloom, LightsConfig cfg, ILogger log) {
            _bloom = bloom; _cfg = cfg; _log = log;
        }

        private static nint OurPtr => (nint)(delegate* unmanaged[Cdecl]<void>)&RenderingCallbackImpl;

        private static nint* Slot {
            get {
                ACBindings.Internal.SmartBox** pp = ACBindings.Internal.SmartBox.smartbox;
                if (pp == null || *pp == null) return null;
                return (nint*)((byte*)(*pp) + SlotOffset);
            }
        }

        /// <summary>Called once per frame from the UpdateLightsInternal detour (render thread).
        /// Installs/reasserts the slot while any consumer (bloom, torch-on) is enabled, clears it
        /// when all are disabled. Never throws.</summary>
        public static void EnsureInstalled() {
            try {
                var cfg = _cfg;
                if (cfg == null) return;
                nint* slot = Slot;
                if (slot == null) return;
                nint ours = OurPtr;
                bool want = cfg.Bloom > 0.5f || cfg.TorchLights > 0.5f || cfg.GlowLights > 0.5f;
                if (!want) {                             // live-toggle off: put back what we found
                    if (*slot == ours) *slot = _prev;
                    return;
                }
                nint cur = *slot;
                if (cur == ours) return;
                _prev = cur;                              // 0 after SmartBox::Reset; chain anything else
                *slot = ours;
                if (!_loggedInstall) {
                    _loggedInstall = true;
                    _log?.LogInformation("acmelights: rendering-callback installed @ SmartBox+{Off} (prev=0x{Prev:X})",
                        SlotOffset, _prev);
                }
            }
            catch { /* never unwind into the client */ }
        }

        /// <summary>Restore the slot (plugin unload). Safe if never installed.</summary>
        public static void Uninstall() {
            try {
                nint* slot = Slot;
                if (slot != null && *slot == OurPtr) *slot = _prev;
            }
            catch { }
            _bloom = null;
        }

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
        private static void RenderingCallbackImpl() {
            try {
                var cfg = _cfg;
                // Own 1/s cfg reload: the UpdateLightsInternal heartbeat (which also reloads) STALLS
                // when the scene's light set is static (observed in a near-lightless dungeon cell),
                // and this callback fires every in-world frame regardless — so knobs stay live here.
                if (cfg != null) {
                    long now = _clock.ElapsedTicks;
                    if (now - _lastReload >= System.Diagnostics.Stopwatch.Frequency) {
                        _lastReload = now;
                        cfg.Reload();
                    }
                    TorchLights.OnPostWorldRender(cfg, _log);
                    GlowLights.OnPostWorldRender(cfg, _log);   // P3: classify/track scan (4 Hz)
                }
                var bloom = _bloom;
                if (bloom != null) {
                    var vp = ClientState.GetViewport();
                    if (vp.Valid && vp.OpenScene)
                        bloom.Frame(ClientState.GetDevicePointer(), in vp);
                }
            }
            catch { /* never unwind into the client */ }
            nint prev = _prev;
            if (prev != 0) ((delegate* unmanaged[Cdecl]<void>)prev)();
        }
    }
}
