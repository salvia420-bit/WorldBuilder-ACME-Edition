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
        private LightSelection? _selection;   // P4 importance-ranked per-draw selection

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

            // PACING (2026-08-23): stand up the off-render-thread log sink BEFORE anything that logs
            // from a detour. Chorizite's ILogger does Console.Write + Directory.Exists + a full
            // File open/append/close PER LINE, synchronously, on the calling thread — from inside a
            // detour that is the render thread, and it was the dominant frame-time spike in the 1070
            // session (9 MB of log in an hour). Everything periodic now goes through AsyncLog; the
            // one-shot lifecycle lines below deliberately keep the synchronous logger so they also
            // reach the in-game console and are on disk before the next line is even queued.
            AsyncLog.Start(_log);

            _cfg = new LightsConfig();
            _cfg.Reload();
            _mgr = new LightManager(_log, _cfg);
            _bloom = new BloomCompositor(_log, _cfg);
            // Compile bloom shaders NOW on the managed thread — loading Vortice.D3DCompiler from the
            // native render thread throws 0x80131509 (ALC-load fault). The render-thread callback only
            // creates the device pixel-shader objects from this cached bytecode.
            _bloom.PrecompileShaders();
            RenderCallback.Configure(_bloom, _cfg, _log);
            // P3 glow lights: allocate the unmanaged LIGHTINFO/Frame scratch, resolve
            // CObjectMaint::GetObjectA + CEnvCell::GetVisible, and pre-JIT EVERY GlowLights method
            // here on the managed thread — the set_viewer detour calls straight into them on the
            // native render thread, where a lazy JIT/assembly load throws 0x80131509.
            GlowLights.Warmup(_cfg, _log);
            _dump = new DumpService(_log, _cfg);
            // P4: build + warm the selection engine on THIS (managed) thread before any detour can
            // reach it. Warmup() dry-runs the hot ranking loop and pre-JITs every method the native
            // detour touches, including the UnmanagedCallersOnly body -- the 0x80131509 discipline.
            _selection = new LightSelection(_log, _cfg);
            _selection.Warmup();
            _mgr.AttachSelection(_selection);
            _hooks = new NativeHooks(_log);
            _hooks.Install(_mgr, _dump, _cfg);
            _hooks.InstallSelection(_selection, _cfg);

            if (_hooks.Installed)
                _log.LogInformation("acmelights: initialized (cfg='{Cfg}' maxStatic={MS} maxDynamic={MD} " +
                    "headlamp={HL} flicker={FK} selection={SEL} selbudget={SB} selhyst={SH} " +
                    "asynclog={AL} glowlog={GL} loglights={LL})",
                    _cfg.LoadedFrom ?? "(defaults)",
                    _cfg.MaxStatic, _cfg.MaxDynamic, _cfg.Headlamp, _cfg.Flicker,
                    _cfg.Selection, _cfg.SelBudget, _cfg.SelHysteresis,
                    AsyncLog.Ready ? 1 : 0, _cfg.GlowLog, _cfg.LogLights);
            else
                _log.LogWarning("acmelights: no hooks installed");
        }

        /// <summary>Force ACBindings to load + JIT the detour hot path off the native thread.</summary>
        private void WarmupAcBindings() {
            try {
                unsafe { _ = Render.world_lights; _ = SmartBox.s_fViewerLightIntensity; }
                RuntimeHelpers.PrepareMethod(
                    typeof(LightManager).GetMethod("OnUpdateLights")!.MethodHandle);
                // P3: the set_viewer detour builds a LIGHTINFO/Frame and calls Render.add_dynamic_light,
                // so realise those ACBindings types here, off the native thread. (GlowLights.Warmup
                // then PrepareMethods every GlowLights method, which JITs the call sites themselves.)
                unsafe { _ = sizeof(LIGHTINFO); _ = sizeof(Frame); }
            }
            catch (Exception ex) { _log.LogWarning(ex, "acmelights: ACBindings warmup incomplete"); }
        }

        protected override void Dispose() {
            RenderCallback.Uninstall();   // clear the SmartBox slot before the compositor goes away
            _hooks?.Dispose();            // detours off BEFORE P4/P3 free their unmanaged scratch
            GlowLights.Dispose();
            _hooks = null;
            _selection?.Dispose();        // P4: frees the NativeMemory candidate block
            _selection = null;
            _bloom?.Dispose();
            _bloom = null;
            _dump?.Dispose();
            _dump = null;
            AsyncLog.Stop();              // flush whatever the sink still holds, then stop the writer
            Instance = null;
        }
    }
}
