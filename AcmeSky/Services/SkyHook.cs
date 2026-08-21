using System;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using AcmeSky.Lib;
using Microsoft.Extensions.Logging;
using Reloaded.Hooks;
using Reloaded.Hooks.Definitions;
using Reloaded.Hooks.Definitions.X86;

namespace AcmeSky.Services {
    /// <summary>
    /// Installs the single inline detour that makes AcmeSky work: a Reloaded.Hooks hook on
    /// <c>GameSky::Draw</c> (the C++ member that draws the retail sky).
    ///
    /// THE MECHANISM (verified this session):
    ///   * <c>void __thiscall GameSky::Draw(GameSky* this, int after)</c> -- decomp acclient.c:308475,
    ///     ACBindings GameSky.cs Offset 0x00507A50. It sets zfar*4 + DEPTHTEST_ALWAYS and draws the
    ///     DAT-driven sky objects as a backdrop.
    ///   * <c>LScape::draw</c> calls it TWICE: Draw(sky,0) BEFORE the world (behind everything) and
    ///     Draw(sky,1) AFTER the world (weather in front).
    ///   * Our detour RETURNS EARLY -- it never calls the original -- which suppresses the entire
    ///     retail sky (both phases) in one cut. Inside the detour, in that exact frame slot, we call
    ///     <see cref="SkyRenderer.Render"/> for the matching phase, so our sky occupies the same
    ///     backdrop position and gets the same free terrain occlusion.
    ///
    /// ENGINE: Reloaded.Hooks 4.3.3 -- the same inline-detour engine the Chorizite native
    /// bootstrapper already loads into acclient (external/chorizite/.../Hooks/HookBase.cs,
    /// DirectXHooks.cs, ACClientHooks.cs). We reference it ExcludeAssets="runtime" and bind to the
    /// copy resident in the process, so there is exactly one hooking engine. The detour is a
    /// [UnmanagedCallersOnly] thiscall stub, exactly like Chorizite's Client_Cleanup_Impl.
    ///
    /// ADDRESS RESOLUTION: prefer a signature scan of the main module (SigScan), fall back to the
    /// ACBindings/decomp VA 0x00507A50. See <see cref="Signature"/> -- the default pattern is a
    /// PLACEHOLDER to be captured from the shipping client binary during the in-client (1070)
    /// session; until then resolution uses the known VA.
    /// </summary>
    public sealed class SkyHook : IDisposable {
        /// <summary>ACBindings/decomp VA of GameSky::Draw. Build-specific; the sig-scan supersedes it.</summary>
        public const long GameSkyDrawVa = 0x00507A50;

        /// <summary>
        /// Byte signature for GameSky::Draw's prologue. UNVERIFIED PLACEHOLDER -- we have no copy of
        /// the shipping acclient.exe here to extract real prologue bytes, so this is left null and
        /// resolution falls back to <see cref="GameSkyDrawVa"/>. Fill this in from the client binary
        /// (the bytes at 0x00507A50) during the 1070 session to make resolution build-independent.
        /// </summary>
        public static string? Signature = null;

        [Function(CallingConventions.MicrosoftThiscall)]
        public delegate void GameSky_Draw(IntPtr gameSky, int after);

        private static IHook<GameSky_Draw>? _hook;
        private static SkyRenderer? _renderer;
        private static ILogger? _log;

        // Throttled proof-of-life for the detour: log the first few fires and then once/second, so we
        // can confirm GameSky::Draw is actually being intercepted without spamming the client log.
        private static readonly System.Diagnostics.Stopwatch _fireClock = System.Diagnostics.Stopwatch.StartNew();
        private static long _fireCount;
        private static long _lastFireLogTicks = long.MinValue;

        /// <summary>
        /// When true (default) the detour suppresses the retail sky by not calling the original.
        /// Set false to A/B the retail sky against ours (calls original, then draws over -- debug only).
        /// </summary>
        public static bool Suppress = true;

        public bool Installed => _hook is not null;

        public SkyHook(SkyRenderer renderer, ILogger log) {
            _renderer = renderer;
            _log = log;
        }

        /// <summary>
        /// Resolve the address and install the detour. Render/client thread. Returns true on success.
        /// </summary>
        public bool Install() {
            if (_hook is not null) return true;
            try {
                long addr = Resolve();
                if (addr == 0) {
                    _log?.LogError("acmesky: could not resolve GameSky::Draw; sky hook not installed");
                    return false;
                }
                _hook = CreateHook<GameSky_Draw>(typeof(SkyHook), nameof(GameSky_DrawImpl), addr);
                _log?.LogInformation("acmesky: GameSky::Draw hook installed at 0x{Addr:X8}", addr);
                return true;
            }
            catch (Exception ex) {
                _log?.LogError(ex, "acmesky: failed to install GameSky::Draw hook");
                return false;
            }
        }

        private long Resolve() {
            if (!string.IsNullOrWhiteSpace(Signature)) {
                IntPtr hit = SigScan.FindInMainModule(Signature!);
                if (hit != IntPtr.Zero) {
                    _log?.LogInformation("acmesky: GameSky::Draw resolved by signature -> 0x{Addr:X8}",
                        hit.ToInt64());
                    return hit.ToInt64();
                }
                _log?.LogWarning("acmesky: GameSky::Draw signature did not match; using known VA");
            }
            return GameSkyDrawVa;
        }

        /// <summary>Mirror of Chorizite's HookBase.CreateHook: build + Activate a Reloaded hook by method name.</summary>
        private static IHook<TFunction> CreateHook<[DynamicallyAccessedMembers(
                DynamicallyAccessedMemberTypes.PublicParameterlessConstructor |
                DynamicallyAccessedMemberTypes.PublicMethods |
                DynamicallyAccessedMemberTypes.NonPublicMethods |
                DynamicallyAccessedMemberTypes.PublicFields |
                DynamicallyAccessedMemberTypes.PublicNestedTypes)] TFunction>(
                Type type, string methodName, long address) {
            return ReloadedHooks.Instance.CreateHook<TFunction>(type, methodName, address).Activate();
        }

        /// <summary>
        /// The detour. Suppresses the retail sky (does not call the original when Suppress) and draws
        /// AcmeSky's sky for this phase. Must never let a managed exception escape into C++ client code.
        /// </summary>
        // CallConvMemberFunction (NOT CallConvThiscall): this is the x86 UnmanagedCallersOnly
        // convention Reloaded's reverse wrapper expects for a __thiscall member, and the ONLY one
        // that lays out `this` + the stack args correctly. The sibling AcmeRagdoll detours
        // (NativeHooks.MotionDoneImpl/UpdatePartsImpl) use exactly this and read their args cleanly;
        // an earlier CallConvThiscall here delivered a GARBAGE `after` (e.g. 10926744 instead of
        // 0/1) and crashed the client when Render() ran with the bad phase.
        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvMemberFunction) })]
        private static void GameSky_DrawImpl(IntPtr gameSky, int after) {
            try {
                // Throttled proof-of-life: first 3 fires, then once/second, tagged with the phase.
                long n = ++_fireCount;
                long now = _fireClock.ElapsedTicks;
                if (n <= 3 || now - _lastFireLogTicks > System.Diagnostics.Stopwatch.Frequency) {
                    _lastFireLogTicks = now;
                    _log?.LogInformation("acmesky: GameSky::Draw detour fired (after={After}, suppress={S}, fireCount={N})",
                        after, Suppress, n);
                }

                // Phase guard: the retail call only ever passes 0 (backdrop) or 1 (weather). Anything
                // else means the ABI is off - never feed a bad phase to the renderer (an out-of-range
                // phase indexing device state is how a fixed-function draw AVs the client).
                if (after != 0 && after != 1) {
                    if (!Suppress) _hook!.OriginalFunction.Invoke(gameSky, after);
                    return;
                }

                if (!Suppress) {
                    // Debug A/B path: keep the retail sky and draw ours on top of the same phase.
                    _hook!.OriginalFunction.Invoke(gameSky, after);
                }
                _renderer?.Render(after);
            }
            catch {
                // Swallow: a detour returning into native code must not throw.
            }
            // Suppress==true => original is intentionally NOT called: retail sky is fully replaced.
        }

        public void Dispose() {
            try {
                _hook?.Disable();   // stop routing through our detour; original path restored
            }
            catch (Exception ex) {
                _log?.LogWarning(ex, "acmesky: error disabling GameSky::Draw hook");
            }
            _renderer = null;
            _log = null;
            // NB: Reloaded.Hooks has no full uninstall; Disable() routes calls straight to the
            // original. See README "Unload safety".
        }
    }
}
