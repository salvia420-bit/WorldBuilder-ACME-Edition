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

            _hooks = new NativeHooks(_log);
            _registry = new RagdollRegistry(_hooks.SetUpdatePartsEnabled, _log);
            _hooks.Install(_registry);

            if (_hooks.Installed)
                _log.LogInformation("ragdoll: ready. Creatures will ragdoll on death.");
            else
                _log.LogWarning("ragdoll: hooks did not install; ragdolls unavailable this session.");
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
