using System;
using System.Text.Json.Serialization.Metadata;
using AcmeRagdoll.Lib;
using AcmeRagdoll.Services;
using Chorizite.Core;
using Chorizite.Core.Backend;
using Chorizite.Core.Plugins;
using Chorizite.Core.Plugins.AssemblyLoader;
using Microsoft.Extensions.Logging;

namespace AcmeRagdoll {
    /// <summary>
    /// Entry point for the ACME Ragdoll plugin - runtime physics ragdoll deaths for every creature
    /// in the retail client, driven by inline detours on the client's own per-part pose pipeline.
    ///
    /// PLUGIN CONTRACT (identical to AcmeRedline, verified against the framework):
    ///   * a directory with manifest.json under IPluginManager.PluginDirectory;
    ///   * the entry type derives from the abstract class IPluginCore with a protected constructor
    ///     taking an AssemblyPluginManifest plus injected services;
    ///   * real work happens in Initialize()/Dispose(), not the constructor;
    ///   * settings round-trip through ISerializeSettings&lt;T&gt; with a source-generated
    ///     JsonTypeInfo&lt;T&gt;.
    ///
    /// This plugin needs FAR fewer services than AcmeRedline: no RmlUi panel, no AC account, no dat
    /// reader - just IChoriziteBackend (to check we are in the Client environment) and an ILogger.
    /// Everything else is done by reading/writing client memory through Chorizite.ACBindings and by
    /// detouring client functions through Reloaded.Hooks.
    /// </summary>
    public class AcmeRagdollPlugin : IPluginCore, ISerializeSettings<RagdollSettings> {
        internal static AcmeRagdollPlugin? Instance;

        private readonly IChoriziteBackend _backend;
        private readonly ILogger _log;

        private RagdollSettings _settings = new();
        private NativeHooks? _hooks;
        private RagdollRegistry? _registry;

        JsonTypeInfo<RagdollSettings> ISerializeSettings<RagdollSettings>.TypeInfo =>
            RagdollJsonContext.Default.RagdollSettings;

        protected AcmeRagdollPlugin(AssemblyPluginManifest manifest,
                                    IChoriziteBackend choriziteBackend,
                                    ILogger log) : base(manifest) {
            Instance = this;
            _backend = choriziteBackend;
            _log = log;
        }

        /// <inheritdoc/>
        protected override void Initialize() {
            if (!_settings.Enabled) {
                _log.LogInformation("ragdoll: disabled by settings; no hooks installed");
                return;
            }

            // The detours read client globals and hook acclient functions that exist nowhere else, so
            // they are meaningful only in the client process. ChoriziteEnvironment is [Flags].
            if (!_backend.Environment.HasFlag(ChoriziteEnvironment.Client)) {
                _log.LogInformation("ragdoll: not the client environment; ragdolls disabled");
                return;
            }

            // Eagerly load Chorizite.ACBindings NOW, on the managed plugin thread where assembly
            // loading is legal. NativeHooks uses `nint` at the ABI boundary (never touching an
            // ACBindings type), so nothing else forces the assembly to load until RagdollRegistry
            // first dereferences a CPhysicsObj* -- and that first touch happens INSIDE the native
            // MotionDone detour, where a lazy assembly load throws FileLoadException "operation is
            // not legal in the current state" (0x80131509) and the ragdoll never arms. Referencing
            // the types here loads the assembly ahead of the detour; PrepareMethod additionally JITs
            // the hot path now so no JIT-time metadata load happens on the native thread either.
            // (The sibling AcmeSky doesn't need this: constructing SkyRenderer at init already pulls
            // ACBindings in via ClientState.)
            WarmupAcBindings();

            _hooks = new NativeHooks(_log);
            _registry = new RagdollRegistry(_hooks.SetUpdatePartsEnabled, _log);
            _hooks.Install(_registry, _settings.ArmOnDeathStart);

            if (_hooks.Installed)
                _log.LogInformation("ragdoll: ready. Creatures will ragdoll on death.");
            else
                _log.LogWarning("ragdoll: hooks did not install; ragdolls unavailable this session.");
        }

        /// <summary>
        /// Force Chorizite.ACBindings to load and the ragdoll hot path to JIT on this (managed,
        /// load-legal) thread, so neither happens lazily inside the native MotionDone/UpdateParts
        /// detour (where it fails with 0x80131509). Best-effort: touching the types is the load-
        /// bearing part; PrepareMethod is extra insurance and is allowed to no-op if reflection on
        /// the unsafe-pointer signatures is unavailable.
        /// </summary>
        private void WarmupAcBindings() {
            try {
                // Touch the exact ACBindings types RagdollRegistry dereferences -> loads the assembly.
                System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(
                    typeof(global::ACBindings.Internal.CPhysicsObj).TypeHandle);
                _ = typeof(global::ACBindings.Internal.CPartArray).TypeHandle;
                _ = typeof(global::ACBindings.Internal.CSetup).TypeHandle;
                _ = typeof(global::ACBindings.Internal.CPhysicsPart).TypeHandle;
                _ = typeof(global::ACBindings.Internal.Frame).TypeHandle;
                // Corpse-handoff correlation additionally reads the object's placement (Position) and the
                // setup's DAT DataID (SerializeUsingPackDBObj -> DBObj -> IDClass); touch those too so no
                // ACBindings assembly/type load is triggered lazily on the native detour thread.
                _ = typeof(global::ACBindings.Internal.Position).TypeHandle;
                _ = typeof(global::ACBindings.Internal.SerializeUsingPackDBObj).TypeHandle;
                _ = typeof(global::ACBindings.Internal.DBObj).TypeHandle;
                _ = typeof(global::ACBindings.Internal.IDClass____tagDataID).TypeHandle;
                // The airborne-death world-fall additionally reads the terrain under the corpse via the
                // client's own CLandCell::find_terrain_poly (returning a CPolygon whose Plane gives Z),
                // reached from the object's CObjCell*. Touch those types so no ACBindings assembly/type
                // load is triggered lazily on the native detour thread.
                _ = typeof(global::ACBindings.Internal.CObjCell).TypeHandle;
                _ = typeof(global::ACBindings.Internal.CLandCell).TypeHandle;
                _ = typeof(global::ACBindings.Internal.CPolygon).TypeHandle;
                _ = typeof(global::ACBindings.Internal.Plane).TypeHandle;
                _ = typeof(global::ACBindings.Internal.AC1Legacy.Vector3).TypeHandle;

                // Pre-JIT the registry methods that resolve those types, so the JIT's metadata work
                // is done here rather than on the native detour thread. Includes the corpse-handoff
                // methods the detours reach (any NEW registry method a detour can reach must be added
                // here, or it risks the 0x80131509 lazy-load failure on the native thread).
                foreach (var name in new[] {
                    "OnMotionDone", "OnUpdateParts", "Seed", "WriteParts",
                    "ResolveWorldFall", "TryGetTerrainZ",
                    "ArmCorpseHandoff", "ResolvePending", "GiveUpPending",
                    "CreateRecord", "UpdateRecord", "TryMatchRecord",
                    "SweepStale", "HashParents", "SetupDidOf", "ReadPos", "PosValid",
                }) {
                    var mi = typeof(RagdollRegistry).GetMethod(name,
                        System.Reflection.BindingFlags.Instance |
                        System.Reflection.BindingFlags.Static |
                        System.Reflection.BindingFlags.Public |
                        System.Reflection.BindingFlags.NonPublic);
                    if (mi != null) {
                        try { System.Runtime.CompilerServices.RuntimeHelpers.PrepareMethod(mi.MethodHandle); }
                        catch { /* pointer-signature PrepareMethod is best-effort */ }
                    }
                }
                _log.LogInformation("ragdoll: ACBindings warmed up (assembly + hot path pre-JITed)");
            }
            catch (Exception ex) {
                _log.LogError(ex, "ragdoll: ACBindings warmup failed; deaths may not arm");
            }
        }

        /// <inheritdoc/>
        protected override void Dispose() {
            // Order: disable the detours first so nothing runs OnUpdateParts/OnMotionDone, then mark
            // the registry down and drop it. (See NativeHooks "Unload safety".)
            _hooks?.Dispose();
            _hooks = null;

            _registry?.Shutdown();
            _registry = null;

            Instance = null;
        }

        RagdollSettings ISerializeSettings<RagdollSettings>.SerializeBeforeUnload() => _settings;

        void ISerializeSettings<RagdollSettings>.DeserializeAfterLoad(RagdollSettings? settings) =>
            _settings = settings ?? new RagdollSettings();
    }
}
