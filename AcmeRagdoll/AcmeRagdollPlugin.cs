using System;
using System.Text.Json.Serialization.Metadata;
using AcmeRagdoll.Lib;
using AcmeRagdoll.Services;
using Chorizite.Core;
using Chorizite.Core.Backend;
using Chorizite.Core.Net;
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
        private readonly NetworkParser _net;
        private readonly ILogger _log;

        private RagdollSettings _settings = new();
        private NativeHooks? _hooks;
        private RagdollRegistry? _registry;
        private LiveMotionRegistry? _liveMotion;
        private bool _netSubscribed;

        JsonTypeInfo<RagdollSettings> ISerializeSettings<RagdollSettings>.TypeInfo =>
            RagdollJsonContext.Default.RagdollSettings;

        /// <param name="manifest">Plugin manifest (framework-supplied).</param>
        /// <param name="choriziteBackend">Used only to check we are in the Client environment.</param>
        /// <param name="net">The host's single <see cref="NetworkParser"/>, source of the typed S2C
        /// events the live-motion layer subscribes to. It is registered into the plugin lifetime scope
        /// by <c>Chorizite.cs:146</c> as <c>RegisterInstance(new NetworkParser(clientBackend, ...))</c> -
        /// Autofac AsSelf, so it resolves by its concrete type through the plugin activator's
        /// fall-through <c>_serviceProvider.Resolve(parameterType)</c>. It is a CONTAINER SERVICE, not
        /// a plugin, so manifest.json's "dependencies" stays empty and AcmeRagdoll remains
        /// dependency-free.</param>
        /// <param name="log">Plugin logger.</param>
        protected AcmeRagdollPlugin(AssemblyPluginManifest manifest,
                                    IChoriziteBackend choriziteBackend,
                                    NetworkParser net,
                                    ILogger log) : base(manifest) {
            Instance = this;
            _backend = choriziteBackend;
            _net = net;
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

            // PACING (2026-08-23): stand up the off-render-thread log sink before anything that can
            // log from a detour. Chorizite's ILogger does Console.Write + Directory.Exists + a full
            // File open/append/close PER LINE, synchronously — and this plugin's noisiest lines
            // (`livemotion HIT` per landed hit, the per-death ARM/handoff/YIELD block) fire from
            // inside the render-thread detours, on exactly the frames that are already busiest.
            // One-shot lifecycle lines keep the synchronous logger (in-game console + immediate
            // durability); everything per-frame/per-event goes through AsyncLog.
            AsyncLog.Start(_log);

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
            // Per-body ragdoll profiles (Setup DataID -> RagdollParams). File IO + JSON parsing are
            // legal HERE and nowhere near the detour thread; after this the table is a read-only
            // Dictionary that the seed path looks up without allocating or loading anything.
            RagdollProfiles.Load(_log, AssemblyDirectory);

            WarmupAcBindings();

            _hooks = new NativeHooks(_log);
            _registry = new RagdollRegistry(_hooks.SetUpdatePartsEnabled, _log);

            // LIVE-MOTION LAYER (hit reactions on living creatures). Constructed and subscribed only
            // when the master toggle is on: with it off nothing is built, nothing is subscribed, and
            // NativeHooks receives a null registry so the UpdateParts post-detour dispatches to the
            // death registry alone -> bit-identical client behaviour (runbook C1 invariant).
            // Realise the death registry's single-writer gate HERE, on the managed thread: the first
            // caller is otherwise a native-originated stack (the UpdateParts detour or a net callback).
            _ = _registry.IsDeathOwned(0u);

            if (_settings.LiveMotion) {
                _liveMotion = new LiveMotionRegistry(_hooks.SetUpdatePartsEnabledLive, _log);
                // SINGLE-WRITER OWNERSHIP: the live (hit-reaction) layer animates LIVING bodies only.
                // Binding the death registry's lock-free owned-id check here is what makes that contract
                // enforced rather than merely documented - the live layer refuses to arm, and retires
                // what it holds, for any body the death ragdoll owns. The method group allocates its
                // delegate on THIS thread, which is also the 0x80131509 discipline.
                _liveMotion.BindDeathOwnership(_registry.IsDeathOwned);
                // C3: read ragdoll.cfg once, HERE, on the managed thread - so the first hit already
                // runs on the file's values and so the file/parse path is JITed where assembly loading
                // is legal. After this the layer re-reads it at most once a second, from its own hot
                // paths (see LiveMotionRegistry.PollConfig).
                _liveMotion.PrimeConfig();
                SubscribeNet();
            }
            else {
                _log.LogInformation("livemotion: disabled by settings (liveMotion=false); no subscriptions, no registry");
            }

            _hooks.Install(_registry, _settings.ArmOnDeathStart, _liveMotion);

            if (_hooks.Installed)
                _log.LogInformation("ragdoll: ready. Creatures will ragdoll on death. (liveMotion={L})",
                    _liveMotion != null);
            else
                _log.LogWarning("ragdoll: hooks did not install; ragdolls unavailable this session.");
        }

        /// <summary>
        /// Wire the two S2C hit signals the C0 report selected. Subscribing HERE, on the managed
        /// Initialize() thread, is load-bearing twice over:
        ///   * the <c>+=</c> is what realises the generic <c>WeakEvent&lt;T&gt;</c> /
        ///     <c>EventHandler&lt;T&gt;</c> instantiations, and doing that lazily on the first packet -
        ///     which arrives on a stack that originates in an <c>[UnmanagedCallersOnly]</c> recvfrom
        ///     hook - risks the same 0x80131509 "operation is not legal in the current state" failure
        ///     the native detours have to be warmed up against;
        ///   * Chorizite's <c>WeakEvent</c> keeps a handler alive only through <c>handler.Target</c>,
        ///     so both handlers are INSTANCE methods on the field-held, plugin-lifetime
        ///     <see cref="LiveMotionRegistry"/>. A static handler would be held by a bare
        ///     WeakReference and its subscription could be silently collected.
        /// </summary>
        private void SubscribeNet() {
            try {
                _net.S2C.OnEffects_PlayScriptType += _liveMotion!.OnPlayScriptType;
                _net.S2C.OnCombat_HandleAttackerNotificationEvent += _liveMotion!.OnAttackerNotification;
                _netSubscribed = true;
                _log.LogInformation("livemotion: subscribed S2C Effects_PlayScriptType (0xF755) + " +
                                    "Combat_HandleAttackerNotificationEvent (GameEvent 0x01B1)");
            }
            catch (Exception ex) {
                _log.LogError(ex, "livemotion: S2C subscription failed; hit reactions unavailable this session");
                _netSubscribed = false;
            }
        }

        private void UnsubscribeNet() {
            if (!_netSubscribed || _liveMotion == null) return;
            _netSubscribed = false;
            try {
                _net.S2C.OnEffects_PlayScriptType -= _liveMotion.OnPlayScriptType;
                _net.S2C.OnCombat_HandleAttackerNotificationEvent -= _liveMotion.OnAttackerNotification;
            }
            catch (Exception ex) { _log.LogError(ex, "livemotion: S2C unsubscribe failed"); }
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

                // Per-body parameterization: the seed path reads a profile out of RagdollProfiles.
                // Both types are ours (no assembly load), but their static state and the
                // Dictionary<uint,RagdollParams> generic instantiation must be realized HERE.
                System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(
                    typeof(AcmeRagdoll.Sim.RagdollParams).TypeHandle);
                System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(
                    typeof(AcmeRagdoll.Lib.RagdollProfiles).TypeHandle);
                // The per-death variety sampler + its baked PCA model are reached from Seed on the native
                // detour thread; build their static arrays here and run one real Perturb (with Enabled
                // forced on so the whole math path - InvNorm, the basis loop, FromVarietyVector - JITs
                // now, not lazily on the native thread).
                System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(
                    typeof(AcmeRagdoll.Sim.DeathVarietyModel).TypeHandle);
                System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(
                    typeof(AcmeRagdoll.Sim.DeathVariety).TypeHandle);
                {
                    bool wasOn = AcmeRagdoll.Sim.DeathVariety.Enabled;
                    AcmeRagdoll.Sim.DeathVariety.Enabled = true;
                    float dir = 0f;
                    var _wp = AcmeRagdoll.Sim.DeathVariety.Perturb(
                        AcmeRagdoll.Sim.RagdollParams.Default, 1u, ref dir, out float _commit);
                    AcmeRagdoll.Sim.DeathVariety.Enabled = wasOn;
                    // Build and step a throwaway 4-part ragdoll HERE so the whole seed path - the
                    // RagdollSim constructor (including the ORIENTATION COMMIT block's Log/Exp/Sqrt),
                    // the constraint/brace builders, StepFrame and DeriveQuats - is JITted on the
                    // managed thread. PrepareMethod does not prepare callees, and Seed's call to the
                    // ctor is exactly such a callee, so this real construction is what covers it.
                    {
                        var wParent = new uint[] { 0xFFFFFFFF, 0u, 1u, 1u };
                        var wPos = new float[] { 0f, 0f, 0f,  0f, 0.05f, 0.4f,  0.1f, 0.12f, 0.75f,  -0.1f, 0.12f, 0.75f };
                        var wQ = new AcmeRagdoll.Sim.Quat[4];
                        for (int wi = 0; wi < wQ.Length; wi++) wQ[wi] = new AcmeRagdoll.Sim.Quat(1f, 0f, 0f, 0f);
                        var wSim = new AcmeRagdoll.Sim.RagdollSim(
                            wParent, wPos, wQ, 1u, dir, 0f, _wp,
                            _commit > 0f ? _commit : 1f);
                        wSim.StepFrame();
                        wSim.DeriveQuats(new AcmeRagdoll.Sim.Quat[4]);
                        wSim.ExportState(new float[12], new float[12], out float _wt);
                        wSim.RestoreState(new float[12], new float[12], _wt);
                    }
                }
                // A real lookup on this thread JITs Dictionary.TryGetValue for that instantiation too
                // (PrepareMethod does not prepare callees). Setup DataID 0 is never a real body.
                _ = AcmeRagdoll.Lib.RagdollProfiles.For(0u);
                // Same for the live-motion role seam: the second Dictionary<uint,float[]> lookup is
                // reached from the UpdateParts detour (LiveMotionRegistry.ResolveLooseness).
                _ = AcmeRagdoll.Lib.RagdollProfiles.PartWeights(0u);
                // ...and for the C4 idle seam: a THIRD Dictionary<uint, T> instantiation
                // (uint -> BodyRoles), reached from the UpdateParts detour (LiveMotionRegistry.ResolveIdle).
                _ = AcmeRagdoll.Lib.RagdollProfiles.RolesFor(0u);

                // Pre-JIT the registry methods that resolve those types, so the JIT's metadata work
                // is done here rather than on the native detour thread. Includes the corpse-handoff
                // methods the detours reach (any NEW registry method a detour can reach must be added
                // here, or it risks the 0x80131509 lazy-load failure on the native thread).
                // The registry's own class constructor builds the revive-motion lookup table used by the
                // (rescoped) FINDING-1 eviction, which is reached from the MotionDone detour - so run it
                // here, on the managed thread, exactly like the live layer's range tables.
                System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(
                    typeof(RagdollRegistry).TypeHandle);
                PreJit(typeof(RagdollRegistry), new[] {
                    "OnMotionDone", "OnUpdateParts", "Seed", "WriteParts",
                    "ResolveWorldFall", "TryGetTerrainZ",
                    "ArmCorpseHandoff", "ResolvePending", "GiveUpPending",
                    "CreateRecord", "UpdateRecord", "TryMatchRecord",
                    "SweepStale", "MaybeSweepStale",
                    "HashParents", "SetupDidOf", "ReadPos", "PosValid",
                    // Single-writer ownership + the frozen composition basis + the revive rescope: every
                    // one of these is reached from a native detour (MotionDone / DoInterpretedMotion /
                    // UpdateParts) or, for IsDeathOwned, from the live layer's net callback.
                    "IsDeathOwned", "OwnPublish", "OwnRelease", "AddLive",
                    "IsReviveMotion", "ResolveBasis", "BlockOffset", "Remove",
                });
                // The profile lookups the seed path (For) and the live-motion looseness resolver
                // (PartWeights) call, on their own type.
                PreJit(typeof(AcmeRagdoll.Lib.RagdollProfiles), new[] { "For", "PartWeights", "RolesFor" });

                // ---- LIVE-MOTION LAYER ----
                // Skipped entirely when the layer is off, so a disabled layer does not even pull the
                // Chorizite.ACProtocol message types into this ALC (runbook C1 invariant).
                if (_settings.LiveMotion) {
                    // Own try/catch so a live-motion warmup failure is attributable to the live layer
                    // and does not cost the (already-complete) death-ragdoll warmup its success log.
                    try { WarmupLiveMotionTypes(); }
                    catch (Exception ex) { _log.LogError(ex, "livemotion: warmup failed; hit reactions may not arm"); }
                }

                _log.LogInformation("ragdoll: ACBindings warmed up (assembly + hot path pre-JITed), {N} profiles active",
                    AcmeRagdoll.Lib.RagdollProfiles.Count);
            }
            catch (Exception ex) {
                _log.LogError(ex, "ragdoll: ACBindings warmup failed; deaths may not arm");
            }
        }

        /// <summary>
        /// Live-motion half of <see cref="WarmupAcBindings"/>, split out so a disabled layer touches
        /// none of it. Same hazard, different entry point: the two S2C handlers are invoked from
        /// WeakEvent.Invoke on a managed stack that ORIGINATES in the [UnmanagedCallersOnly] recvfrom
        /// hook - i.e. the very same "entered from native" thread state that makes a lazy load throw
        /// 0x80131509 inside the detours. Being a C# event does not make loading legal. So: realise the
        /// message types (the Chorizite.ACProtocol assembly is host-loaded, but these TYPES and the
        /// generic instantiations over them are not realised until first use), run the registry's class
        /// constructor, and pre-JIT every method a detour or a net callback can reach.
        /// </summary>
        private void WarmupLiveMotionTypes() {
            _ = typeof(Chorizite.ACProtocol.Messages.S2C.Effects_PlayScriptType).TypeHandle;
            _ = typeof(Chorizite.ACProtocol.Messages.S2C.Events.Combat_HandleAttackerNotificationEvent).TypeHandle;
            // The player-exclusion walk dereferences these two ACBindings types; nothing else in
            // the plugin touches them, so without this the FIRST hit-reaction arm would be the
            // trigger for their metadata load - on the native detour thread.
            _ = typeof(global::ACBindings.Internal.ACCWeenieObject).TypeHandle;
            _ = typeof(global::ACBindings.Internal.PublicWeenieDesc).TypeHandle;
            _ = typeof(global::ACBindings.Internal.CWeenieObject).TypeHandle;
            System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(
                typeof(LiveMotionRegistry).TypeHandle);
            // C3 live tuning: the cfg poll is reached from BOTH the UpdateParts detour tail and the two
            // net callbacks, i.e. from native-originated stacks - so the reader's type, its static
            // defaults and its whole parse path must be realised here like everything else on those
            // paths. RunClassConstructor gets LiveMotionTuning.Defaults built; the real file read
            // happens in WarmupLiveMotion below (and again, for the live registry, in PrimeConfig).
            System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(
                typeof(AcmeRagdoll.Lib.LiveMotionTuning).TypeHandle);
            System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(
                typeof(AcmeRagdoll.Lib.LiveMotionConfig).TypeHandle);
            PreJit(typeof(AcmeRagdoll.Lib.LiveMotionConfig), new[] {
                "Poll", "Prime", "ReloadCore", "Parse", "Apply",
                "SetF", "SetMs", "SetB", "LogBadOnce", "LogIoFailOnce",
            });
            PreJit(typeof(AcmeRagdoll.Lib.LiveMotionTuning), new[] { "Copy" });
            // Every LiveMotionRegistry method reachable from a net callback (OnPlayScriptType,
            // OnAttackerNotification and everything they call) or from the UpdateParts detour
            // (OnUpdateParts and everything it calls). ANY new method either path can reach must be
            // added here, or it risks the 0x80131509 lazy-JIT failure on the native thread.
            PreJit(typeof(LiveMotionRegistry), new[] {
                // C1: signals, correlation, entry lifetime, player exclusion
                "OnPlayScriptType", "OnAttackerNotification", "OnUpdateParts",
                "TryClaimDamage", "TryEnrichSplat", "RecordSplat", "RecordDamage",
                "Push", "Remove", "MaybeSweep", "ArmUpdateParts", "WarmupJit",
                "IsPlayerObject", "DecodeSplatter", "ObjIdOf",
                "LogThreadIdOnce", "LogSafe",
                // C2: the hit-reaction physics, all reachable from the UpdateParts detour, plus
                // OnMotion / IsAttackMotion which are reached from the DoInterpretedMotion detour.
                "DecayPool", "DrainImpulses", "HeightBandCenter", "Integrate", "VisualGain",
                "WriteOffsets", "PoolGain", "IsAtRest", "ComputeBodyMetrics", "ResolveLooseness",
                "OnMotion", "IsAttackMotion", "BuildRangeTable", "IsFinite", "SetupDidOf",
                // C3: the 1/s cfg poll and the runtime enable/disable transition, both reached from
                // the UpdateParts detour tail and from the two net callbacks.
                "PrimeConfig", "PollConfig", "ApplyEnabledTransition", "ClampFor",
                // C4: the idle micro-motion path, all of it reached from the UpdateParts detour, plus
                // IsIdleMotion which is reached from the DoInterpretedMotion detour.
                "IdleActive", "ComputeIdle", "ResolveIdle", "IsIdleMotion",
                // C5: the procedural-gait path, all of it reached from the UpdateParts detour, plus
                // IsLocomotionMotion which is reached from the DoInterpretedMotion detour.
                "GaitActive", "ComputeGait", "ResolveGait", "UpdateGaitSpeed", "IsLocomotionMotion",
                // Single-writer gate: DeathOwns is reached from the net handler (OnPlayScriptType) AND
                // from the UpdateParts detour; RetireForDeath from the detour.
                "BindDeathOwnership", "DeathOwns", "RetireForDeath",
            });
            // C4's math lives in a pure static of its own; the detour calls straight into it, so it
            // gets its class constructor and its methods realised here like everything else.
            System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(
                typeof(AcmeRagdoll.Sim.IdleMotion).TypeHandle);
            PreJit(typeof(AcmeRagdoll.Sim.IdleMotion), new[] {
                "Produces", "Build", "RoleBreathWeight", "Accumulate", "Combine",
                "AdvancePhase", "PhaseFor", "Lingering", "ParseArchetype", "ParseRole", "Clamp01",
            });
            // C5's math is a pure static of its own too, with static readonly tables that its class
            // constructor builds - run it here, not on the detour thread.
            System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(
                typeof(AcmeRagdoll.Sim.GaitMotion).TypeHandle);
            PreJit(typeof(AcmeRagdoll.Sim.GaitMotion), new[] {
                "Applies", "Accumulate", "CadenceHz", "UpdateSpeed",
            });
            // The dispatcher/arbiter half that the detour and the registries call.
            PreJit(typeof(NativeHooks), new[] {
                "SetUpdatePartsEnabled", "SetUpdatePartsEnabledLive", "ApplyUpdatePartsVotes",
            });
            // Realise the Dictionary<uint, LiveEntry> and the message types' read paths the same
            // way the RagdollProfiles lookup above does - by actually RUNNING them once here.
            // PrepareMethod does not prepare callees, so only a real call JITs Dictionary
            // TryGetValue/insert for this instantiation and the ring/struct copies around it.
            WarmupLiveMotion(_log);
            _log.LogInformation("livemotion: types realised + handlers pre-JITed");
        }

        /// <summary>
        /// Drive a THROWAWAY <see cref="LiveMotionRegistry"/> through both net handlers and the
        /// UpdateParts entry point once, on this (managed, load-legal) thread. This is the live-motion
        /// twin of the <c>RagdollProfiles.For(0u)</c> line above: PrepareMethod does not prepare
        /// callees, so the only way to JIT <c>Dictionary&lt;uint, LiveEntry&gt;</c>'s insert/lookup, the
        /// generated message classes' field access and the ring-buffer struct copies is to execute
        /// them. The instance is never subscribed and is dropped immediately, so it cannot arm
        /// anything: its hook-vote delegate is a no-op and its object id 1 belongs to no real body.
        /// </summary>
        private static unsafe void WarmupLiveMotion(ILogger log) {
            var warm = new LiveMotionRegistry(_ => { }, log);
            try {
                // Bind the single-writer gate on the throwaway too, so WarmupJit's DeathOwns(1u) call
                // actually goes THROUGH a Func<uint, bool> and JITs that instantiation's Invoke stub on
                // this thread. The lambda answers "never owned", so the harness drives the C4 path.
                warm.BindDeathOwnership(static _ => false);
                // C3: read the cfg for real (file IO, stat, parse, snapshot publish) on THIS thread,
                // then drive the correlation/entry internals with the tuning forced to defaults - see
                // LiveMotionRegistry.WarmupJit for why the handler calls below are not sufficient once
                // the layer has a runtime off switch.
                warm.PrimeConfig();
                warm.WarmupJit();
                warm.OnUpdateParts(null, null);   // pointer-signature entry point: JIT it for real
                warm.OnMotion(null, 0x1000005Au); // the DoInterpretedMotion feed + the attack table
                warm.OnMotion(null, 0x45000005u); // WalkForward: the C5 locomotion latch branch
                warm.OnPlayScriptType(null, new Chorizite.ACProtocol.Messages.S2C.Effects_PlayScriptType {
                    ObjectId = 1u, ScriptType = 0x5B, Speed = 1f,
                });
                warm.OnAttackerNotification(null,
                    new Chorizite.ACProtocol.Messages.S2C.Events.Combat_HandleAttackerNotificationEvent {
                        DefenderName = string.Empty, DamagePercent = 0.5, Damage = 1u, Critical = false,
                    });
            }
            finally { warm.Shutdown(); }
        }

        /// <summary>Force the named methods of <paramref name="type"/> to JIT on this (managed,
        /// load-legal) thread. Best-effort per method: PrepareMethod on an unsafe-pointer signature
        /// can fail to reflect, and that is not fatal.</summary>
        private static void PreJit(Type type, string[] names) {
            foreach (var name in names) {
                var mi = type.GetMethod(name,
                    System.Reflection.BindingFlags.Instance |
                    System.Reflection.BindingFlags.Static |
                    System.Reflection.BindingFlags.Public |
                    System.Reflection.BindingFlags.NonPublic);
                if (mi == null) continue;
                try { System.Runtime.CompilerServices.RuntimeHelpers.PrepareMethod(mi.MethodHandle); }
                catch { /* pointer-signature PrepareMethod is best-effort */ }
            }
        }

        /// <inheritdoc/>
        protected override void Dispose() {
            // Order: drop the network subscriptions first so no new hit can arm anything, then disable
            // the detours so nothing runs OnUpdateParts/OnMotionDone, then mark the registries down and
            // drop them. (See NativeHooks "Unload safety".)
            UnsubscribeNet();

            _hooks?.Dispose();
            _hooks = null;

            _registry?.Shutdown();
            _registry = null;

            _liveMotion?.Shutdown();
            _liveMotion = null;

            AsyncLog.Stop();        // flush whatever the sink still holds, then stop the writer
            Instance = null;
        }

        RagdollSettings ISerializeSettings<RagdollSettings>.SerializeBeforeUnload() => _settings;

        void ISerializeSettings<RagdollSettings>.DeserializeAfterLoad(RagdollSettings? settings) =>
            _settings = settings ?? new RagdollSettings();
    }
}
