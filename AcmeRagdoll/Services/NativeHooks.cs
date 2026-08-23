using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using ACBindings.Internal;
using AcmeRagdoll.Lib;
using Microsoft.Extensions.Logging;
using Reloaded.Hooks;
using Reloaded.Hooks.Definitions;
using Reloaded.Hooks.Definitions.X86;

namespace AcmeRagdoll.Services {
    /// <summary>
    /// Installs the inline trampoline detours on the retail client, using Reloaded.Hooks 4.3.3 -
    /// the same engine and the same pattern as Chorizite's own bootstrapper
    /// (external/chorizite/.../Hooks/ACClientHooks.cs, HookBase.cs):
    ///   [Function(MicrosoftThiscall)] delegate + [UnmanagedCallersOnly(CallConvMemberFunction)] impl,
    ///   OriginalFunction(...) to chain through.
    ///
    ///   * CPhysicsObj::MotionDone  - ALWAYS active (cheap; a per-object death signal). Filters
    ///     motion == MotionCommand.Dead and arms a ragdoll via <see cref="RagdollRegistry"/>.
    ///   * CPhysicsObj::DoInterpretedMotion - ALWAYS active (death-START signal, the universal
    ///     motion-initiation choke point). Filters motion == MotionCommand.Dead and, when
    ///     RagdollSettings.ArmOnDeathStart is true, arms the SAME registry path so creatures
    ///     ragdoll from the instant of the death hit rather than after the death animation.
    ///     MotionDone stays installed as a harmless fallback (registry dedupe prevents double-arm).
    ///     It ALSO feeds <see cref="LiveMotionRegistry.OnMotion"/> - the live layer needs to know
    ///     when a body it is shaking starts an attack, and this is the one detour that sees every
    ///     motion start; the feed is gated on the live layer having work, so a client with no hit
    ///     reactions in flight pays a null check and an int read.
    ///   * CPartArray::UpdateParts  - the per-part pose writer, HOT. Created disabled and armed only
    ///     while at least one ragdoll is live (registry drives <see cref="SetUpdatePartsEnabled"/>).
    ///     Post-detour: forward the original, then overwrite the owned parts.
    ///
    /// UnmanagedCallersOnly detours cannot capture instance state, so the registry is reached through
    /// a static field, bound in <see cref="Install"/>. Every detour body is wrapped so an exception
    /// can never unwind into C++ client code.
    ///
    /// UNLOAD.  All hooks are Disable()d in <see cref="Dispose"/>. As with AcmeRedline's device
    /// hooks, a collectible-ALC hot-unload while a trampoline still points at our stub is inherently
    /// unsafe; the safe operational model is to unload only when idle, and to restart the client
    /// rather than hot-reload this plugin. See README "Unload safety".
    /// </summary>
    internal sealed unsafe class NativeHooks : IDisposable {
        // The hook delegates deliberately use `nint` for every pointer parameter instead of the
        // ACBindings.Internal struct pointers (CPartArray*, Frame*, CPhysicsObj*).  Reloaded builds a
        // REVERSE WRAPPER for each delegate and, to do so, reflects the delegate's Invoke signature
        // (Utilities.GetNumberofParameters -> Type.GetMethod("Invoke").GetParameters()).  Resolving a
        // pointer parameter forces the CLR to load the pointed-to type's full metadata; the big
        // generated ACBindings structs (IDisposable, nested vtbl structs, fixed buffers) fail to load
        // in the plugin ALC, so GetParameters() throws inside Signature.GetSignature and the hook
        // never installs.  `nint` is ABI-identical (a 4-byte pointer in ECX for a member function)
        // and always reflects - exactly what Chorizite's own working hooks do for their `this`
        // pointers (ACClientHooks.Client_Cleanup(IntPtr), DirectXHooks.RenderDeviceD3D_EndScene(IntPtr)).
        // The struct pointers are recovered by a cast inside the detour bodies below.
        [Function(CallingConventions.MicrosoftThiscall)]
        private delegate void UpdatePartsFn(nint self, nint frame);

        [Function(CallingConventions.MicrosoftThiscall)]
        private delegate void MotionDoneFn(nint self, uint motion, int success);

        // int __thiscall CPhysicsObj::DoInterpretedMotion(CPhysicsObj* this, unsigned int motion,
        //                                                 MovementParameters* params)
        [Function(CallingConventions.MicrosoftThiscall)]
        private delegate int DoInterpretedMotionFn(nint self, uint motion, nint mparams);

        private static IHook<UpdatePartsFn>? _updateParts;
        private static IHook<MotionDoneFn>? _motionDone;
        private static IHook<DoInterpretedMotionFn>? _doInterp;
        private static RagdollRegistry? _registry;
        /// <summary>The live-motion (hit-reaction) registry, or NULL when RagdollSettings.LiveMotion is
        /// false. Null is the whole of the "disabled => bit-identical" guarantee on the hot path: the
        /// UpdateParts post-detour dispatches to the death registry and nothing else, and the live
        /// layer never votes to arm the detour, so with no ragdoll live the detour is not even
        /// installed-and-enabled.</summary>
        private static LiveMotionRegistry? _liveMotion;
        private static ILogger? _log;

        // Death-start arming toggle (RagdollSettings.ArmOnDeathStart), bound in Install the same way
        // _registry is: UnmanagedCallersOnly detours cannot capture instance state, so the static
        // bool is the simplest correct way to reach the setting from the native detour thread.
        private static bool _armOnDeathStart;

        /// <summary>MotionCommand.Dead (Chorizite.Common/Enums/MotionCommand.cs:24) - the same value
        /// RagdollRegistry.OnMotionDone filters.</summary>
        private const uint DeadMotion = 0x40000011;

        private readonly ILogger _ilog;
        private bool _installed;
        private bool _disposed;

        public NativeHooks(ILogger log) { _ilog = log; _log = log; }

        public bool Installed => _installed;

        /// <summary>Resolve addresses, create the detours, bind the registry. MotionDone and
        /// DoInterpretedMotion armed, UpdateParts created-then-disabled.</summary>
        /// <param name="registry">The ragdoll registry the detours arm/drive.</param>
        /// <param name="armOnDeathStart">When true, the DoInterpretedMotion detour arms a ragdoll at
        /// death-motion START; when false it no-ops (MotionDone-only behavior).</param>
        /// <param name="liveMotion">The live-motion registry, or null when the layer is disabled by
        /// settings. Null means the UpdateParts post-detour dispatches to the death registry ONLY.</param>
        public void Install(RagdollRegistry registry, bool armOnDeathStart, LiveMotionRegistry? liveMotion) {
            if (_installed || _disposed) return;
            _registry = registry;
            _liveMotion = liveMotion;
            _armOnDeathStart = armOnDeathStart;

            nint updatePartsAddr = AddressResolver.Resolve(
                "CPartArray::UpdateParts", ClientFunctions.UpdateParts_Sig, ClientFunctions.UpdateParts_VA);
            nint motionDoneAddr = AddressResolver.Resolve(
                "CPhysicsObj::MotionDone", ClientFunctions.MotionDone_Sig, ClientFunctions.MotionDone_VA);
            nint doInterpAddr = AddressResolver.Resolve(
                "CPhysicsObj::DoInterpretedMotion", ClientFunctions.DoInterpretedMotion_Sig, ClientFunctions.DoInterpretedMotion_VA);

            // Install each hook in its OWN try/catch so one failure is attributable by name and the
            // other hook still has a chance to install (mirrors the per-hook clarity of ACClientHooks).
            try {
                _motionDone = ReloadedHooks.Instance
                    .CreateHook<MotionDoneFn>(typeof(NativeHooks), nameof(MotionDoneImpl), (long)motionDoneAddr)
                    .Activate();
                _ilog.LogInformation("ragdoll: hook installed  CPhysicsObj::MotionDone @ {M:X8}", (long)motionDoneAddr);
            }
            catch (Exception ex) {
                _ilog.LogError(ex, "ragdoll: hook FAILED to install  CPhysicsObj::MotionDone @ {M:X8}", (long)motionDoneAddr);
            }

            // Death-START signal: the universal motion-initiation choke point. Always-active like
            // MotionDone (Dead is rare, so the motion == DeadMotion filter keeps it cheap); the
            // ArmOnDeathStart toggle gates only the arming inside the impl.
            try {
                _doInterp = ReloadedHooks.Instance
                    .CreateHook<DoInterpretedMotionFn>(typeof(NativeHooks), nameof(DoInterpretedMotionImpl), (long)doInterpAddr)
                    .Activate();
                _ilog.LogInformation("ragdoll: hook installed CPhysicsObj::DoInterpretedMotion @ {D:X8}", (long)doInterpAddr);
            }
            catch (Exception ex) {
                _ilog.LogError(ex, "ragdoll: hook FAILED to install  CPhysicsObj::DoInterpretedMotion @ {D:X8}", (long)doInterpAddr);
            }

            try {
                _updateParts = ReloadedHooks.Instance
                    .CreateHook<UpdatePartsFn>(typeof(NativeHooks), nameof(UpdatePartsImpl), (long)updatePartsAddr)
                    .Activate();
                _updateParts.Disable();   // hot detour stays cold until a ragdoll arms it
                _ilog.LogInformation("ragdoll: hook installed  CPartArray::UpdateParts @ {U:X8} (armed cold)", (long)updatePartsAddr);
            }
            catch (Exception ex) {
                _ilog.LogError(ex, "ragdoll: hook FAILED to install  CPartArray::UpdateParts @ {U:X8}", (long)updatePartsAddr);
            }

            // MotionDone is the load-bearing hook (the death signal). Treat the plugin as installed
            // only if it is live; UpdateParts is armed on demand and its absence merely disables the
            // pose-overwrite half.
            if (_motionDone != null) {
                _installed = true;
                _ilog.LogInformation("ragdoll: hooks install complete (MotionDone={M}, DoInterpretedMotion={D}, UpdateParts={U}, armOnDeathStart={A})",
                    _motionDone != null, _doInterp != null, _updateParts != null, _armOnDeathStart);
            }
            else {
                _ilog.LogWarning("ragdoll: hooks did not install (MotionDone missing); ragdolls disabled");
                SafeDisable();
                _installed = false;
            }
        }

        // ------------------------------------------------------------------ UpdateParts arm arbitration
        //
        // TWO registries now share the one hot detour, and each one only knows its OWN live count. The
        // detour must be enabled while EITHER has work and disabled only when BOTH are idle, so each
        // registry VOTES here (keeping the existing Action<bool> "enabled = my live count > 0"
        // contract, unchanged from the death registry's point of view) and the OR of the votes drives
        // the single Enable/Disable. Reloaded's Enable/Disable are not counted, so calling Enable on an
        // already-enabled hook - which the OR would otherwise do constantly - is avoided by tracking
        // the applied state.
        private bool _voteDeath;
        private bool _voteLive;
        private bool _updatePartsOn;

        /// <summary>Death-registry vote (the original <see cref="RagdollRegistry"/> contract).</summary>
        public void SetUpdatePartsEnabled(bool enabled) {
            _voteDeath = enabled;
            ApplyUpdatePartsVotes();
        }

        /// <summary>Live-motion-registry vote.</summary>
        public void SetUpdatePartsEnabledLive(bool enabled) {
            _voteLive = enabled;
            ApplyUpdatePartsVotes();
        }

        private void ApplyUpdatePartsVotes() {
            var h = _updateParts;
            if (h == null) return;
            bool want = _voteDeath || _voteLive;
            if (want == _updatePartsOn) return;
            _updatePartsOn = want;
            if (want) h.Enable(); else h.Disable();
        }

        // ------------------------------------------------------------------ detours

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvMemberFunction) })]
        private static void MotionDoneImpl(nint self, uint motion, int success) {
            _motionDone!.OriginalFunction(self, motion, success);
            try { _registry?.OnMotionDone((CPhysicsObj*)self, motion); }
            catch (Exception ex) { LogSafe(ex, "MotionDone"); }
        }

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvMemberFunction) })]
        private static int DoInterpretedMotionImpl(nint self, uint motion, nint mparams) {
            // Call the ORIGINAL FIRST so the client actually starts the Dead motion sequence, then
            // arm - the registry seeds from the (still ~standing) live pose on the next UpdateParts
            // and the sim drives the fall from the death hit. Reuses the SAME arming method as the
            // MotionDone hook; its ContainsKey dedupe means the later MotionDone cannot double-arm.
            int r = _doInterp!.OriginalFunction(self, motion, mparams);
            try {
                if (_armOnDeathStart && motion == DeadMotion)
                    _registry?.OnMotionDone((CPhysicsObj*)self, motion);
            }
            catch (Exception ex) { LogSafe(ex, "DoInterpretedMotion"); }
            // LIVE-MOTION current-motion feed. This detour is the universal motion-initiation choke
            // point, so it is also the cheapest place to learn that a body the hit layer is shaking
            // has begun an attack (-> attenuate, keep the telegraph readable). Gated on the layer
            // having ANY live entry so the common case - which is every motion of every object in the
            // world - is one null check plus one volatile int read, with no dereference of `self`.
            try {
                var lm = _liveMotion;
                if (lm != null && lm.LiveCount > 0) lm.OnMotion((CPhysicsObj*)self, motion);
            }
            catch (Exception ex) { LogSafe(ex, "DoInterpretedMotion/live"); }
            return r;
        }

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvMemberFunction) })]
        private static void UpdatePartsImpl(nint self, nint frame) {
            // Forward the real per-part pose update FIRST, then overwrite the parts we own.
            _updateParts!.OriginalFunction(self, frame);
            // Death layer first: a body it owns is a corpse whose pose it fully replaces. The live
            // layer (hit reactions on LIVING bodies) runs second and, from C2, adds its offsets on
            // top of the freshly animated pose. When the layer is off _liveMotion is null and this is
            // one predictable null check - no allocation, no call, no client-visible difference.
            try { _registry?.OnUpdateParts((CPartArray*)self, (Frame*)frame); }
            catch (Exception ex) { LogSafe(ex, "UpdateParts"); }
            try { _liveMotion?.OnUpdateParts((CPartArray*)self, (Frame*)frame); }
            catch (Exception ex) { LogSafe(ex, "UpdateParts/live"); }
        }

        // PACING (2026-08-23): UpdateParts runs per part-array PER FRAME, so a recurring detour
        // exception used to mean a synchronous Console.Write + file open/append/close for every
        // rendered object of every frame — a hitch source that only shows up when something is
        // already wrong. One line per second is enough to tell that story.
        // -1_000_000, NOT long.MinValue: `now - long.MinValue` overflows negative and would suppress
        // every line forever (the same trap AcmeLights' NativeHooks documents).
        private static long _lastLogSafe = -1_000_000;

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void LogSafe(Exception ex, string where) {
            long now = Environment.TickCount64;
            if (now - _lastLogSafe < 1000) return;
            _lastLogSafe = now;
            try { _log?.LogError(ex, "ragdoll: {Where} detour threw (swallowed)", where); }
            catch { /* never let logging unwind into native code */ }
        }

        // ------------------------------------------------------------------ teardown

        private void SafeDisable() {
            _voteDeath = _voteLive = false;
            _updatePartsOn = false;
            try { _updateParts?.Disable(); } catch { }
            try { _motionDone?.Disable(); } catch { }
            try { _doInterp?.Disable(); } catch { }
        }

        public void Dispose() {
            if (_disposed) return;
            _disposed = true;
            SafeDisable();
            _installed = false;
            // Leave the registry reference intact for any in-flight detour to no-op through _down,
            // then drop it; the plugin calls RagdollRegistry.Shutdown() before this.
            _registry = null;
            _liveMotion = null;
        }
    }
}
