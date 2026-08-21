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
    /// Installs the two inline trampoline detours on the retail client, using Reloaded.Hooks 4.3.3 -
    /// the same engine and the same pattern as Chorizite's own bootstrapper
    /// (external/chorizite/.../Hooks/ACClientHooks.cs, HookBase.cs):
    ///   [Function(MicrosoftThiscall)] delegate + [UnmanagedCallersOnly(CallConvMemberFunction)] impl,
    ///   OriginalFunction(...) to chain through.
    ///
    ///   * CPhysicsObj::MotionDone  - ALWAYS active (cheap; a per-object death signal). Filters
    ///     motion == MotionCommand.Dead and arms a ragdoll via <see cref="RagdollRegistry"/>.
    ///   * CPartArray::UpdateParts  - the per-part pose writer, HOT. Created disabled and armed only
    ///     while at least one ragdoll is live (registry drives <see cref="SetUpdatePartsEnabled"/>).
    ///     Post-detour: forward the original, then overwrite the owned parts.
    ///
    /// UnmanagedCallersOnly detours cannot capture instance state, so the registry is reached through
    /// a static field, bound in <see cref="Install"/>. Every detour body is wrapped so an exception
    /// can never unwind into C++ client code.
    ///
    /// UNLOAD.  Both hooks are Disable()d in <see cref="Dispose"/>. As with AcmeRedline's device
    /// hooks, a collectible-ALC hot-unload while a trampoline still points at our stub is inherently
    /// unsafe; the safe operational model is to unload only when idle, and to restart the client
    /// rather than hot-reload this plugin. See README "Unload safety".
    /// </summary>
    internal sealed unsafe class NativeHooks : IDisposable {
        [Function(CallingConventions.MicrosoftThiscall)]
        private delegate void UpdatePartsFn(CPartArray* self, Frame* frame);

        [Function(CallingConventions.MicrosoftThiscall)]
        private delegate void MotionDoneFn(CPhysicsObj* self, uint motion, int success);

        private static IHook<UpdatePartsFn>? _updateParts;
        private static IHook<MotionDoneFn>? _motionDone;
        private static RagdollRegistry? _registry;
        private static ILogger? _log;

        private readonly ILogger _ilog;
        private bool _installed;
        private bool _disposed;

        public NativeHooks(ILogger log) { _ilog = log; _log = log; }

        public bool Installed => _installed;

        /// <summary>Resolve addresses, create both detours, bind the registry. MotionDone armed,
        /// UpdateParts created-then-disabled.</summary>
        public void Install(RagdollRegistry registry) {
            if (_installed || _disposed) return;
            _registry = registry;

            nint updatePartsAddr = AddressResolver.Resolve(
                "CPartArray::UpdateParts", ClientFunctions.UpdateParts_Sig, ClientFunctions.UpdateParts_VA);
            nint motionDoneAddr = AddressResolver.Resolve(
                "CPhysicsObj::MotionDone", ClientFunctions.MotionDone_Sig, ClientFunctions.MotionDone_VA);

            try {
                _motionDone = ReloadedHooks.Instance
                    .CreateHook<MotionDoneFn>(typeof(NativeHooks), nameof(MotionDoneImpl), (long)motionDoneAddr)
                    .Activate();

                _updateParts = ReloadedHooks.Instance
                    .CreateHook<UpdatePartsFn>(typeof(NativeHooks), nameof(UpdatePartsImpl), (long)updatePartsAddr)
                    .Activate();
                _updateParts.Disable();   // hot detour stays cold until a ragdoll arms it

                _installed = true;
                _ilog.LogInformation("ragdoll: hooks installed (MotionDone {M:X8}, UpdateParts {U:X8})",
                    (long)motionDoneAddr, (long)updatePartsAddr);
            }
            catch (Exception ex) {
                _ilog.LogError(ex, "ragdoll: failed to install native hooks; ragdolls disabled");
                SafeDisable();
                _installed = false;
            }
        }

        /// <summary>Registry callback: arm/disarm the hot UpdateParts detour with the live count.</summary>
        public void SetUpdatePartsEnabled(bool enabled) {
            var h = _updateParts;
            if (h == null) return;
            if (enabled) h.Enable(); else h.Disable();
        }

        // ------------------------------------------------------------------ detours

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvMemberFunction) })]
        private static void MotionDoneImpl(CPhysicsObj* self, uint motion, int success) {
            _motionDone!.OriginalFunction(self, motion, success);
            try { _registry?.OnMotionDone(self, motion); }
            catch (Exception ex) { LogSafe(ex, "MotionDone"); }
        }

        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvMemberFunction) })]
        private static void UpdatePartsImpl(CPartArray* self, Frame* frame) {
            // Forward the real per-part pose update FIRST, then overwrite the parts we own.
            _updateParts!.OriginalFunction(self, frame);
            try { _registry?.OnUpdateParts(self, frame); }
            catch (Exception ex) { LogSafe(ex, "UpdateParts"); }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void LogSafe(Exception ex, string where) {
            try { _log?.LogError(ex, "ragdoll: {Where} detour threw (swallowed)", where); }
            catch { /* never let logging unwind into native code */ }
        }

        // ------------------------------------------------------------------ teardown

        private void SafeDisable() {
            try { _updateParts?.Disable(); } catch { }
            try { _motionDone?.Disable(); } catch { }
        }

        public void Dispose() {
            if (_disposed) return;
            _disposed = true;
            SafeDisable();
            _installed = false;
            // Leave the registry reference intact for any in-flight detour to no-op through _down,
            // then drop it; the plugin calls RagdollRegistry.Shutdown() before this.
            _registry = null;
        }
    }
}
