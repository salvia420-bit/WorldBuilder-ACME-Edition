using System;
using System.Runtime.CompilerServices;
using System.Text.Json.Serialization.Metadata;
using ACBindings.Internal;
using AcmeLights.Lib;
using AcmeLights.Services;
using Chorizite.Core;
using Chorizite.Core.Backend;
using Chorizite.Core.Plugins;
using Chorizite.Core.Plugins.AssemblyLoader;
using Microsoft.Extensions.Logging;

namespace AcmeLights {
    /// <summary>
    /// ACME Lights — holtburger-tier lighting for the retail client. Phase 0-2: drives the client's
    /// own fixed-function light pipeline (enumeration, raised pools, viewer headlamp, flame flicker,
    /// ambient red-bias + dungeon fixes) via two inline detours. Later phases add dynamic spell/
    /// portal lights, importance-ranked slot selection, and a luminance bloom post-process.
    ///
    /// Contract identical to AcmeRagdoll/AcmeSky: IPluginCore subclass, work in Initialize()/Dispose(),
    /// ISerializeSettings round-trip, ACBindings eager-loaded before any native detour touches it.
    /// </summary>
    public class AcmeLightsPlugin : IPluginCore, ISerializeSettings<LightsSettings> {
        internal static AcmeLightsPlugin? Instance;

        private readonly IChoriziteBackend _backend;
        private readonly ILogger _log;

        private LightsSettings _settings = new();
        private LightsConfig? _cfg;
        private NativeHooks? _hooks;
        private LightManager? _mgr;
        private BloomCompositor? _bloom;
        private DumpService? _dump;

        JsonTypeInfo<LightsSettings> ISerializeSettings<LightsSettings>.TypeInfo =>
            LightsJsonContext.Default.LightsSettings;

        LightsSettings ISerializeSettings<LightsSettings>.SerializeBeforeUnload() => _settings;

        void ISerializeSettings<LightsSettings>.DeserializeAfterLoad(LightsSettings? settings) =>
            _settings = settings ?? new LightsSettings();

        protected AcmeLightsPlugin(AssemblyPluginManifest manifest,
                                   IChoriziteBackend choriziteBackend,
                                   ILogger log) : base(manifest) {
            Instance = this;
            _backend = choriziteBackend;
            _log = log;
        }

        protected override void Initialize() {
            if (!_settings.Enabled) {
                _log.LogInformation("acmelights: disabled by settings; no hooks installed");
                return;
            }
            if (!_backend.Environment.HasFlag(ChoriziteEnvironment.Client)) {
                _log.LogInformation("acmelights: not the client environment; disabled");
                return;
            }

            // Eager-load ACBindings on the managed thread (see AcmeRagdoll rationale): the detours
            // dereference LightParms*/RenderLight* on the native render thread where a lazy assembly
            // load throws 0x80131509. Touch a type + JIT the hot path now.
            WarmupAcBindings();

            _cfg = new LightsConfig();
            _cfg.Reload();
            _mgr = new LightManager(_log, _cfg);
            _bloom = new BloomCompositor(_log, _cfg);
            // Compile bloom shaders NOW on the managed thread — loading Vortice.D3DCompiler from the
            // native EndFrame detour throws 0x80131509 (ALC-load fault). The detour only creates the
            // device pixel-shader objects from this cached bytecode.
            _bloom.PrecompileShaders();
            _dump = new DumpService(_log, _cfg);
            _hooks = new NativeHooks(_log);
            _hooks.Install(_mgr, _bloom, _dump, _cfg);

            if (_hooks.Installed)
                _log.LogInformation("acmelights: initialized (cfg='{Cfg}' maxStatic={MS} maxDynamic={MD} " +
                    "headlamp={HL} flicker={FK})", _cfg.LoadedFrom ?? "(defaults)",
                    _cfg.MaxStatic, _cfg.MaxDynamic, _cfg.Headlamp, _cfg.Flicker);
            else
                _log.LogWarning("acmelights: no hooks installed");
        }

        /// <summary>Force ACBindings to load + JIT the detour hot path off the native thread.</summary>
        private void WarmupAcBindings() {
            try {
                unsafe { _ = Render.world_lights; _ = SmartBox.s_fViewerLightIntensity; }
                RuntimeHelpers.PrepareMethod(
                    typeof(LightManager).GetMethod("OnUpdateLights")!.MethodHandle);
            }
            catch (Exception ex) { _log.LogWarning(ex, "acmelights: ACBindings warmup incomplete"); }
        }

        protected override void Dispose() {
            _hooks?.Dispose();
            _hooks = null;
            _bloom?.Dispose();
            _bloom = null;
            _dump?.Dispose();
            _dump = null;
            Instance = null;
        }
    }
}
