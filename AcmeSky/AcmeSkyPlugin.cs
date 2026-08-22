using System;
using System.IO;
using System.Runtime.CompilerServices;
using ACBindings.Internal;
using AcmeSky.Lib;
using AcmeSky.Services;
using Chorizite.Core;
using Chorizite.Core.Backend;
using Chorizite.Core.Plugins;
using Chorizite.Core.Plugins.AssemblyLoader;
using Microsoft.Extensions.Logging;

namespace AcmeSky {
    /// <summary>
    /// Entry point for AcmeSky -- replaces the retail sky with a baked NASA/takram sky rendered on
    /// the client's own fixed-function D3D9 device.
    ///
    /// PLUGIN CONTRACT (mirrors the shipped AcmeRedline plugin, verified against the framework):
    ///   * A plugin is a directory under IPluginManager.PluginDirectory with a manifest.json.
    ///   * The entry type derives from IPluginCore (an abstract class), with a protected constructor
    ///     taking an AssemblyPluginManifest plus injected services, and overrides Initialize()/Dispose().
    ///   * Real work goes in Initialize(), never the constructor.
    ///
    /// AcmeSky's dependency surface is deliberately tiny -- only IChoriziteBackend (for the client
    /// environment flag + the render-thread marshaller) and ILogger. Everything else it needs (the
    /// D3D device, camera matrices, time-of-day, weather flag) it reads straight out of client memory
    /// via ACBindings globals (see Lib/ClientState.cs); it does not depend on the AC or RmlUi plugins.
    /// </summary>
    public class AcmeSkyPlugin : IPluginCore {
        internal static AcmeSkyPlugin? Instance;

        private readonly IChoriziteBackend _backend;
        private readonly ILogger _log;

        private SkyPalette? _palette;
        private TextureLoader? _texLoader;
        private SkyRenderer? _renderer;
        private SkyHook? _hook;

        protected AcmeSkyPlugin(AssemblyPluginManifest manifest,
                                IChoriziteBackend choriziteBackend,
                                ILogger log) : base(manifest) {
            Instance = this;
            _backend = choriziteBackend;
            _log = log;
        }

        protected override void Initialize() {
            // Client environment only: the hook and renderer read client globals that exist nowhere
            // else, and only the client process has an acclient sky to replace. ChoriziteEnvironment
            // is [Flags], so test the bit.
            if (!_backend.Environment.HasFlag(ChoriziteEnvironment.Client)) {
                _log.LogInformation("acmesky: not in the client environment; sky replacement disabled");
                return;
            }

            // Eager-load Chorizite.ACBindings on the MANAGED thread before any native detour touches
            // it. ClientState (device ptr, camera matrices, time-of-day) dereferences ACBindings
            // statics from inside the GameSky::Draw detour on the client's render thread, where a LAZY
            // assembly/ALC load throws 0x80131509 "operation is not legal in the current state" — which
            // SkyHook's catch swallowed, so SkyRenderer.Render bailed every frame and the sky was BLACK
            // (retail suppressed, nothing drawn). This was invisible on Windows because another plugin
            // had already loaded ACBindings; under wine AcmeSky's detour was first to touch it. Same
            // fix AcmeLights/AcmeRagdoll already apply (WarmupAcBindings).
            WarmupAcBindings();

            string skyDir = Path.Combine(AssemblyDirectory, "assets", "sky");

            _palette = new SkyPalette(_log);
            _palette.Load(skyDir);

            _texLoader = new TextureLoader(_log);
            _renderer = new SkyRenderer(skyDir, _texLoader, _palette, _log);
            _hook = new SkyHook(_renderer, _log);

            // Install the GameSky::Draw detour DIRECTLY here, exactly like the sibling AcmeRagdoll
            // installs its native detours in Initialize(). Installing an inline trampoline detour is
            // just a memory patch and is thread-agnostic; the device work runs INSIDE the detour,
            // which the client only ever calls from its own render thread, so correctness is by
            // construction. The earlier _backend.Invoke(...) route enqueued the install onto the
            // client backend's _invokeQueue, which is not drained in the injected client -- the
            // callback never ran, so the hook was never installed and the retail sky stayed. (Both
            // AcmeRagdoll and AcmeRedline install their hooks synchronously in Initialize.)
            try {
                if (_hook.Install())
                    _log.LogInformation("acmesky: ready -- retail sky suppressed, baked sky armed");
                else
                    _log.LogError("acmesky: hook install failed; retail sky remains");
            }
            catch (Exception ex) {
                _log.LogError(ex, "acmesky: hook install threw; retail sky remains");
            }
        }

        /// <summary>Force Chorizite.ACBindings to load + JIT the detour hot path off the native thread.
        /// Touches the exact statics ClientState reads and pre-JITs its methods. Never throws.</summary>
        private void WarmupAcBindings() {
            try {
                unsafe {
                    _ = RenderDevice.render_device;
                    _ = GameTime.current_game_time;
                }
                RuntimeHelpers.PrepareMethod(typeof(ClientState).GetMethod("GetDevicePointer")!.MethodHandle);
                RuntimeHelpers.PrepareMethod(typeof(ClientState).GetMethod("GetCamera")!.MethodHandle);
                RuntimeHelpers.PrepareMethod(typeof(ClientState).GetMethod("GetTimeOfDay")!.MethodHandle);
            }
            catch (Exception ex) { _log.LogWarning(ex, "acmesky: ACBindings warmup incomplete"); }
        }

        protected override void Dispose() {
            // Tear down SYNCHRONOUSLY, exactly as Install() runs synchronously in Initialize.
            // The old _backend.Invoke(...) route enqueued teardown onto the client backend's
            // _invokeQueue, which is NOT drained in the injected client (the same reason Install
            // was moved off it) — so the callback never ran: the GameSky::Draw inline trampoline
            // stayed patched while this plugin's AssemblyLoadContext unloaded, and the next
            // GameSky::Draw jumped into the collected managed stub -> native acclient crash (and
            // every GPU resource leaked). SkyHook.Dispose()->Disable() restores the original call
            // path immediately; do it FIRST so no frame can re-enter the renderer, then free GPU.
            try {
                _hook?.Dispose();
            }
            catch (Exception ex) {
                _log.LogWarning(ex, "acmesky: error disabling the GameSky::Draw hook on unload");
            }
            try {
                _renderer?.ReleaseGpu();
            }
            catch (Exception ex) {
                _log.LogWarning(ex, "acmesky: error releasing GPU resources on unload");
            }

            _hook = null;
            _renderer = null;
            _texLoader = null;
            _palette = null;
            Instance = null;
        }
    }
}
