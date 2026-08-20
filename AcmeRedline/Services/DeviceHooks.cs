using System;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading;
using ACBindings.Internal;
using AcmeRedline.Lib;
using Chorizite.Core.Backend;
using Microsoft.Extensions.Logging;

namespace AcmeRedline.Services {
    /// <summary>
    /// World-space highlight by hooking the client's own IDirect3DDevice9 vtable.
    ///
    /// ===================================================================================
    /// PROVENANCE
    /// ===================================================================================
    /// The technique is **SkunkVision RenderHook** by Gregory Kusnick (SkunkWorks), later ported
    /// by Virindi. MIT licensed; adapted here with attribution. Sources read:
    ///   SVRenderHook.cpp  - the whole method: lazy vtable hooks armed in PreBeginScene behind an
    ///                       FNeedHook() gate, unhooked in PostEndScene when idle; a once-per-frame
    ///                       copy of plugin state into plain statics; HookVTable/UnhookVTable
    ///                       ("Ripped from Decal's Direct3D9Hook.h").
    ///   HookAll.cpp       - a full-vtable trace build, which names every slot index and is
    ///                       therefore the primary source for the slot numbers in
    ///                       <see cref="D3D9.Slot"/>.
    ///
    /// The core insight kept intact: **never draw your own overlay — mutate the client's own draw
    /// calls in flight.** The highlight is then depth-correct, lit and pixel-aligned for free,
    /// because it *is* the real geometry.
    ///
    /// ===================================================================================
    /// WHAT CHANGED FOR OUR TARGET, AND WHY
    /// ===================================================================================
    /// SkunkVision tints TERRAIN, which AC submits through DrawPrimitiveUP - a user-pointer path,
    /// so it can walk the caller's vertex array and blend a colour into each vertex's diffuse
    /// before forwarding. Object geometry is a different pipeline and that trick does not carry:
    ///
    ///  1. OBJECTS ARE BUFFER-BASED, NOT USER-POINTER. A CPhysicsPart draw goes
    ///       CPhysicsPart::Draw -> RenderDeviceD3D::DrawMeshInternal (0x005A0470)
    ///       -> D3DPolyRender::DrawMesh (0x0059E8A0) -> RenderMeshSubset (0x0059DA60)
    ///       -> ID3DXMesh::DrawSubset
    ///     The mesh is built by D3DXCreateMeshFVF in D3DPolyRender::ConstructMesh (0x0059F0B0),
    ///     so the actual DrawIndexedPrimitive is issued from inside d3dx9, not from acclient.
    ///     It still travels through the device vtable we own, so slot 82 sees it - but there is
    ///     no caller-owned vertex array to mutate.
    ///
    ///  2. EVEN IF WE COULD WRITE THE VERTICES, IT WOULDN'T TINT. The object FVFs do carry a
    ///     per-vertex diffuse (FVF 0x152 stride 36, or 0x252 stride 44 with detail UVs; diffuse at
    ///     byte 24 - matching ACBindings/Generated/Rendering/D3D/CUSTOM_D3D_VERTEX.cs and
    ///     CUSTOM_D3D_VERTEX2.cs). But the fixed-function pipeline only *consumes* it as emissive
    ///     when MeshBuffer::burnedInStaticLights &lt; 0; otherwise colour comes from the material
    ///     (RenderDeviceD3D::SetFFDiffuseColorSource / SetFFAmbientColorSource). Writing vertex
    ///     diffuse would therefore tint some objects and silently no-op on others.
    ///
    ///  So for objects we RE-ISSUE THE DRAW as a second, tinted pass: texture stages switched to
    ///  D3DTA_TFACTOR, the tint in D3DRS_TEXTUREFACTOR, alpha blending on, depth test on but depth
    ///  writes off, and a slight negative depth bias so the tint wins the z-fight against the
    ///  surface it is painting. Same geometry, same transform, same visibility - a true overlay.
    ///
    /// ===================================================================================
    /// COEXISTENCE WITH CHORIZITE'S OWN HOOKS  (the footgun the brief warns about)
    /// ===================================================================================
    /// Two independent vtable swaps on one slot is a crash. Verified that this cannot happen:
    ///
    ///   Chorizite does NOT hook the IDirect3DDevice9 vtable at all. Its D3D touchpoints are
    ///   INLINE DETOURS ON CLIENT FUNCTIONS, installed with Reloaded.Hooks 4.3.3:
    ///     external/chorizite/Chorizite/Chorizite.NativeClientBootstrapper/Hooks/DirectXHooks.cs
    ///       - RenderDeviceD3D::EndScene                (signature scan, drives Render2D)
    ///       - RenderDeviceD3D::OnDeviceDisplayModeChange (device create/reset)
    ///       - the Win32 WndProc (GetWindowLong/SetWindowLong)
    ///     external/chorizite/.../Hooks/HookBase.cs - ReloadedHooks.Instance.CreateHook(...)
    ///   Chorizite DOES have vtable-patching machinery (class VHook in
    ///   .../AcClient/_Hook.cs - PatchVCall + Marshal.GetFunctionPointerForDelegate), but it is
    ///   aimed at CLIENT C++ vtables, never at the D3D device.
    ///
    /// So our slots (16/65/82) are disjoint from everything Chorizite installs. We additionally
    /// keep SkunkVision's two defensive invariants, which make us safe even if that changes:
    ///   * HookVTable is a no-op when the slot already holds our detour (idempotent arming);
    ///   * UnhookVTable restores ONLY if the slot still holds our detour. If a third party hooked
    ///     over us, their saved "original" is our detour - restoring would uninstall them AND
    ///     point them at memory we are about to free. We refuse, and mark ourselves pinned.
    ///
    /// One consequence worth stating: our detours also see Chorizite's own 2D draws, because
    /// DX9RenderInterface renders inside the EndScene detour on the same device. They are
    /// harmless - <see cref="HighlightState"/> only matches draws whose current CPhysicsPart
    /// resolves to a selected GfxObj, and Chorizite's UI draws have no CPhysicsPart at all.
    ///
    /// ===================================================================================
    /// UNLOAD SAFETY  (.NET collectible-ALC semantics)
    /// ===================================================================================
    /// Chorizite loads plugins into a collectible AssemblyLoadContext
    /// (external/chorizite/.../Plugins/AssemblyLoader/AssemblyPluginLoadContext.cs). Our detours
    /// are [UnmanagedCallersOnly] stubs living in THIS assembly, so their addresses die with the
    /// ALC. A vtable slot still pointing at one after unload is a guaranteed crash on the next
    /// frame.
    ///
    /// CHOSEN ANSWER: **refuse hot-unload while armed.** <see cref="Dispose"/> marshals the
    /// disarm onto the render thread (IChoriziteBackend.Invoke - the same thread that owns the
    /// device) and BLOCKS until it is confirmed, so by the time Dispose returns the vtable is
    /// clean. If the disarm cannot be confirmed - no render thread, or a third party hooked over
    /// our slot - we set <see cref="Pinned"/>, take a process-lifetime GCHandle so nothing we own
    /// is collected, log an error telling the user to restart the client rather than reload the
    /// plugin, and leave the detours installed but INERT (HighlightState.Active is false, so each
    /// one immediately tail-calls the original).
    ///
    /// The alternative - a small VirtualAlloc'd native thunk that the vtable points at, whose
    /// jump target we rewrite to the saved original on unload - is genuinely unload-safe and is
    /// the right answer if this ever needs to survive plugin reloads. It is not done here because
    /// it means hand-assembled machine code that cannot be validated without a live 32-bit client,
    /// and a wrong thunk is a silent memory-corruption bug rather than a loud failure. Documented
    /// rather than guessed. See the TODO on <see cref="AllocateNativeThunks"/>.
    /// </summary>
    public sealed unsafe class DeviceHooks : IDisposable {

        // ------------------------------------------------------------------
        // Static state. Detours are [UnmanagedCallersOnly] so they cannot capture an instance;
        // everything they touch has to be static, plain and non-allocating.
        // ------------------------------------------------------------------

        private static IntPtr _device;
        private static IntPtr _origDrawIndexedPrimitive;
        private static IntPtr _origSetTexture;
        private static IntPtr _origReset;

        /// <summary>Guards against our second pass re-entering our own detour.</summary>
        [ThreadStatic] private static bool _inTintPass;

        /// <summary>Set when we could not safely restore a slot. The plugin must not be unloaded.</summary>
        public static bool Pinned { get; private set; }

        private static GCHandle _pin;
        private static ILogger? _slog;
        private static TextureRegistry? _textures;

        // ------------------------------------------------------------------

        private readonly IChoriziteBackend _backend;
        private readonly ILogger _log;
        private bool _armed;
        private bool _disposed;

        /// <summary>True while our detours are installed in the device vtable.</summary>
        public bool IsArmed => _armed;

        /// <summary>The resolved IDirect3DDevice9*, or Zero when it could not be found.</summary>
        public IntPtr Device => _device;

        public DeviceHooks(IChoriziteBackend backend, TextureRegistry textures, ILogger log) {
            _backend = backend;
            _log = log;
            _slog = log;
            _textures = textures;
        }

        // ==================================================================
        // Device resolution
        // ==================================================================

        /// <summary>
        /// Find the client's IDirect3DDevice9*.
        ///
        /// TWO PATHS, both verified, preferred order:
        ///
        /// 1. ASK CHORIZITE. In the client environment IChoriziteBackend.Renderer is a
        ///    <c>DX9RenderInterface</c>, a public class with
        ///    <c>public IntPtr NativeDevice =&gt; D3Ddevice?.NativePointer ?? IntPtr.Zero</c>
        ///    (external/chorizite/.../Render/DX9RenderInterface.cs:92). That is the pointer
        ///    Chorizite itself captured at device-creation time and has been using since, so it is
        ///    the most trustworthy value in the process.
        ///    It is reached by REFLECTION rather than a cast because
        ///    Chorizite.NativeClientBootstrapper is not a package a plugin can reference, and
        ///    IRenderer does not declare NativeDevice - IRenderer.GraphicsDevice, which would have
        ///    exposed IGraphicsDevice.NativeDevice, throws NotImplementedException in this backend
        ///    (DX9RenderInterface.cs:95). That dead end is the reason this method exists at all.
        ///
        /// 2. READ IT OUT OF THE CLIENT. RenderDeviceD3D::m_pDirect3DDevice sits at byte offset
        ///    **1128** of the render device (PDB acclient.txt, RenderDeviceD3D member list:
        ///    "LF_MEMBER, offset = 1128, member name = 'm_pDirect3DDevice'"; declared in
        ///    ACBindings/Generated/Rendering/D3D/RenderDeviceD3D.cs as
        ///    <c>public System.IntPtr m_pDirect3DDevice;</c>). The instance is the singleton
        ///    <c>RenderDevice::render_device</c> = (RenderDevice**)0x00870340
        ///    (ACBindings/Generated/Rendering/RenderDevice.cs).
        ///    Independent cross-check: Chorizite hardcodes the same 1128 in
        ///    DirectXHooks.cs - <c>_unmanagedD3DPtr = *(int*)(a + 1128)</c>.
        /// </summary>
        public IntPtr ResolveDevice() {
            // Path 1: reflection over the concrete renderer.
            try {
                var renderer = _backend.Renderer;
                if (renderer is not null) {
                    var prop = renderer.GetType().GetProperty("NativeDevice",
                        BindingFlags.Public | BindingFlags.Instance);
                    if (prop is not null && prop.PropertyType == typeof(IntPtr)) {
                        var value = (IntPtr)(prop.GetValue(renderer) ?? IntPtr.Zero);
                        if (value != IntPtr.Zero) {
                            _log.LogDebug("redline: D3D device {Ptr:X8} via {Type}.NativeDevice",
                                value.ToInt64(), renderer.GetType().Name);
                            return value;
                        }
                    }
                }
            }
            catch (Exception ex) {
                _log.LogDebug(ex, "redline: reflective device lookup failed; falling back to memory read");
            }

            // Path 2: read RenderDeviceD3D::m_pDirect3DDevice out of the singleton.
            try {
                RenderDevice** ppDev = RenderDevice.render_device;
                if (ppDev is not null && *ppDev is not null) {
                    IntPtr value = *(IntPtr*)((byte*)(*ppDev) + RenderDeviceD3DDevicePointerOffset);
                    if (value != IntPtr.Zero) {
                        _log.LogDebug("redline: D3D device {Ptr:X8} via RenderDeviceD3D+{Off}",
                            value.ToInt64(), RenderDeviceD3DDevicePointerOffset);
                        return value;
                    }
                }
            }
            catch (Exception ex) {
                _log.LogWarning(ex, "redline: could not read the D3D device pointer from client memory");
            }

            return IntPtr.Zero;
        }

        /// <summary>
        /// Byte offset of RenderDeviceD3D::m_pDirect3DDevice. PDB-confirmed (offset = 1128) and
        /// cross-checked against Chorizite's DirectXHooks.cs.
        /// </summary>
        public const int RenderDeviceD3DDevicePointerOffset = 1128;

        // ==================================================================
        // Arm / disarm  (SkunkVision's FNeedHook gate)
        // ==================================================================

        /// <summary>
        /// Install or drop hooks to match demand. Call once per frame from the render tick, on the
        /// render thread — the analogue of SkunkVision arming in PreBeginScene and dropping in
        /// PostEndScene when <c>FNeedHook()</c> has gone false.
        /// </summary>
        public void SyncArmState(bool wanted) {
            if (_disposed || Pinned) return;

            if (wanted && !_armed) Arm();
            else if (!wanted && _armed) Disarm("idle");
        }

        /// <summary>Install the detours. Render thread only.</summary>
        public void Arm() {
            if (_armed || _disposed || Pinned) return;

            if (_device == IntPtr.Zero) _device = ResolveDevice();
            if (_device == IntPtr.Zero) {
                _log.LogWarning("redline: cannot arm the world highlight — no D3D device pointer");
                return;
            }

            IntPtr dipDetour = (IntPtr)(delegate* unmanaged[Stdcall]
                <IntPtr, int, int, uint, uint, uint, uint, int>)&DrawIndexedPrimitiveH;
            IntPtr setTexDetour = (IntPtr)(delegate* unmanaged[Stdcall]
                <IntPtr, uint, IntPtr, int>)&SetTextureH;
            IntPtr resetDetour = (IntPtr)(delegate* unmanaged[Stdcall]
                <IntPtr, IntPtr, int>)&ResetH;

            var origDip = D3D9.HookVTable(_device, D3D9.Slot.DrawIndexedPrimitive, dipDetour);
            var origTex = D3D9.HookVTable(_device, D3D9.Slot.SetTexture, setTexDetour);
            var origRst = D3D9.HookVTable(_device, D3D9.Slot.Reset, resetDetour);

            if (origDip == IntPtr.Zero) {
                _log.LogError("redline: failed to hook DrawIndexedPrimitive; world highlight unavailable");
                // Roll back whatever did take, so we never sit half-armed.
                if (origTex != IntPtr.Zero) D3D9.UnhookVTable(_device, D3D9.Slot.SetTexture, setTexDetour, origTex);
                if (origRst != IntPtr.Zero) D3D9.UnhookVTable(_device, D3D9.Slot.Reset, resetDetour, origRst);
                return;
            }

            // Only overwrite the saved originals on a real (non-idempotent) install, so a
            // re-arm can never record our own detour as "the original".
            if (origDip != dipDetour) _origDrawIndexedPrimitive = origDip;
            if (origTex != setTexDetour && origTex != IntPtr.Zero) _origSetTexture = origTex;
            if (origRst != resetDetour && origRst != IntPtr.Zero) _origReset = origRst;

            _armed = true;
            _log.LogInformation("redline: world highlight armed on device {Dev:X8}", _device.ToInt64());
        }

        /// <summary>Remove the detours. Render thread only. Returns true if the vtable is clean.</summary>
        public bool Disarm(string reason) {
            if (!_armed) return true;

            IntPtr dipDetour = (IntPtr)(delegate* unmanaged[Stdcall]
                <IntPtr, int, int, uint, uint, uint, uint, int>)&DrawIndexedPrimitiveH;
            IntPtr setTexDetour = (IntPtr)(delegate* unmanaged[Stdcall]
                <IntPtr, uint, IntPtr, int>)&SetTextureH;
            IntPtr resetDetour = (IntPtr)(delegate* unmanaged[Stdcall]
                <IntPtr, IntPtr, int>)&ResetH;

            bool ok = true;
            ok &= RestoreSlot(D3D9.Slot.DrawIndexedPrimitive, dipDetour, _origDrawIndexedPrimitive);
            ok &= RestoreSlot(D3D9.Slot.SetTexture, setTexDetour, _origSetTexture);
            ok &= RestoreSlot(D3D9.Slot.Reset, resetDetour, _origReset);

            _armed = false;
            HighlightState.Deactivate();

            if (ok) {
                _log.LogInformation("redline: world highlight disarmed ({Reason})", reason);
            }
            else {
                _log.LogError("redline: could NOT restore the D3D vtable ({Reason}). Another tool " +
                              "hooked the same slot after us; uninstalling our detour would break it. " +
                              "Staying pinned and inert — RESTART THE CLIENT rather than reloading this plugin.", reason);
                Pin();
            }
            return ok;
        }

        /// <summary>
        /// Restore one slot, distinguishing "was never ours" from "someone hooked over us".
        ///
        /// Both make <see cref="D3D9.UnhookVTable"/> return false, but they mean opposite things:
        ///   * we never installed here (saved original is Zero)  -> nothing to undo, that is FINE;
        ///   * we DID install and the slot now holds someone else -> they saved OUR detour as their
        ///     original, so our stub must outlive us. NOT fine; the caller must pin.
        /// Collapsing those two into one boolean is exactly the bug that would let a dangling
        /// detour survive an unload, so they are separated here deliberately.
        /// </summary>
        /// <returns>true when the vtable is safe with respect to this slot.</returns>
        private bool RestoreSlot(int slot, IntPtr detour, IntPtr original) {
            IntPtr current = D3D9.GetVTableEntry(_device, slot);

            if (current != detour) {
                // Not our detour sitting there. Safe only if we never installed one.
                bool neverInstalled = original == IntPtr.Zero;
                if (!neverInstalled) {
                    _log.LogError("redline: vtable slot {Slot} was hooked over by another tool; " +
                                  "refusing to restore it", slot);
                }
                return neverInstalled;
            }

            if (original == IntPtr.Zero) {
                // Our detour is installed but we have no original to put back. Should be
                // unreachable; treat as unsafe rather than writing a null into the vtable.
                _log.LogError("redline: vtable slot {Slot} holds our detour but no saved original", slot);
                return false;
            }

            return D3D9.UnhookVTable(_device, slot, detour, original);
        }

        /// <summary>
        /// Forget the cached device pointer and the saved originals.
        ///
        /// Call after a device reset: the saved vtable entries belong to the pre-reset device and
        /// writing them back into a rebuilt vtable would install stale function pointers. Must be
        /// called only while disarmed.
        /// </summary>
        public void InvalidateDevice() {
            if (_armed) {
                _log.LogWarning("redline: InvalidateDevice called while armed; disarming first");
                Disarm("device invalidated");
            }
            _device = IntPtr.Zero;
            _origDrawIndexedPrimitive = IntPtr.Zero;
            _origSetTexture = IntPtr.Zero;
            _origReset = IntPtr.Zero;
        }

        private void Pin() {
            if (Pinned) return;
            Pinned = true;
            // Keep every object the detours could touch alive for the life of the process.
            if (!_pin.IsAllocated) _pin = GCHandle.Alloc(this, GCHandleType.Normal);
        }

        /// <summary>
        /// TODO(acme-redline): unload-safe native thunks.
        ///
        /// Allocate a tiny RWX stub per hooked slot with VirtualAlloc, point the vtable at the
        /// stub, and have the stub jump through a writable pointer cell. On unload, rewrite the
        /// cell to the saved original instead of touching the vtable — the vtable keeps pointing
        /// at memory that outlives the ALC, so a reload/unload can never dangle. That is the only
        /// way to make hot-unload genuinely safe while armed.
        ///
        /// Not implemented here because it requires hand-assembled x86 (a 6-byte
        /// <c>jmp dword ptr [cell]</c> per slot) that cannot be validated without a live 32-bit
        /// client, and a wrong thunk corrupts memory silently instead of failing loudly. The
        /// synchronous-disarm-and-refuse-unload path above is loud, testable, and correct for the
        /// normal case. Searched for an existing managed helper first:
        /// Reloaded.Hooks (used by Chorizite's bootstrapper) does provide trampolines, but it is
        /// referenced only by Chorizite.NativeClientBootstrapper.csproj and is not on a plugin's
        /// dependency path; pulling it in as a plugin package would put a second hooking engine in
        /// the process, which is the exact class of footgun this whole section is avoiding.
        /// </summary>
        private static void AllocateNativeThunks() {
            throw new NotImplementedException("see the TODO on this method");
        }

        /// <summary>
        /// Tear down. Marshals the disarm onto the render thread and blocks until confirmed, so
        /// the vtable is clean before the ALC can unload us.
        /// </summary>
        public void Dispose() {
            if (_disposed) return;
            _disposed = true;

            HighlightState.Deactivate();
            if (!_armed) return;

            using var done = new ManualResetEventSlim(false);
            bool clean = false;

            try {
                _backend.Invoke(() => {
                    try { clean = Disarm("plugin dispose"); }
                    finally { done.Set(); }
                });

                // Bounded wait: if the render thread is gone we must not hang the unload.
                if (!done.Wait(TimeSpan.FromSeconds(5))) {
                    _log.LogError("redline: disarm did not complete within 5s — pinning. " +
                                  "RESTART THE CLIENT rather than reloading this plugin.");
                    Pin();
                    return;
                }
            }
            catch (Exception ex) {
                _log.LogError(ex, "redline: disarm could not be scheduled — pinning.");
                Pin();
                return;
            }

            if (!clean) Pin();
        }

        // ==================================================================
        // Draw-call -> part correlation
        // ==================================================================

        /// <summary>
        /// The GfxObj dat id (0x01......) of the part the client is drawing RIGHT NOW, or 0.
        ///
        /// THIS IS THE CORRELATION, AND IT IS VERIFIED, NOT INFERRED.
        /// <c>RenderDeviceD3D::s_current_physics_part</c> is a real client global:
        ///   ACBindings/Generated/Rendering/D3D/RenderDeviceD3D.cs:20
        ///     <c>public static CPhysicsPart** s_current_physics_part = (CPhysicsPart**)0x008EE3D8;</c>
        ///   PDB: acclient.txt — <c>?s_current_physics_part@RenderDeviceD3D@@1PAVCPhysicsPart@@A</c>
        /// <c>CPhysicsPart::Draw</c> sets it immediately before calling DrawMesh and zeroes it
        /// straight after, so it is non-null for exactly the duration of one part's mesh draw —
        /// including inside RenderMeshSubset and the D3DX DrawSubset that issues our hooked
        /// DrawIndexedPrimitive. No stream-source fingerprinting, no heuristics.
        ///
        /// From the part: <c>gfxobj[deg_level]</c> -> CGfxObj -> <c>BaseClass_DBObj.m_DID</c>
        /// (ACBindings/Generated/Physics/CPhysicsPart.cs, Dats/DBObjs/CGfxObj.cs, Dats/DBObjs/DBObj.cs).
        ///
        /// KNOWN GAP (verified, not a guess): the global is NULL during the deferred alpha pass.
        /// Translucent meshes are queued by <c>D3DPolyRender::AddMeshToAlphaList</c> (0x0059D240)
        /// as AlphaListEntry{MeshBuffer*, surfaceNum, CSurface*, CMaterial*, worldMatrix, ...}
        /// (ACBindings/Generated/Rendering/AlphaListEntry.cs) and flushed later by FlushAlphaList
        /// (0x0059E3F0), by which time the CPhysicsPart is long gone. So a translucent object gets
        /// no OBJECT-kind tint. It still gets the TEXTURE-kind tint, because AlphaListEntry keeps
        /// the CSurface* — which is what <see cref="CurrentSurfaceId"/> reads.
        /// </summary>
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static uint CurrentGfxObjId() {
            try {
                CPhysicsPart** ppPart = RenderDeviceD3D.s_current_physics_part;
                if (ppPart is null) return 0;
                CPhysicsPart* part = *ppPart;
                if (part is null) return 0;
                if (part->gfxobj is null) return 0;

                CGfxObj* gfx = part->gfxobj[part->deg_level];
                if (gfx is null) return 0;

                return gfx->BaseClass_DBObj.m_DID.BaseClass_uint;
            }
            catch (Exception) {
                return 0;
            }
        }

        /// <summary>
        /// The Surface dat id (0x08......) the client currently has bound, or 0.
        ///
        /// <c>Render::curr_surface</c> = (CSurface**)0x00867380
        /// (ACBindings/Generated/Rendering/Render.cs:87) is assigned on every
        /// <c>D3DPolyRender::SetSurface</c> (0x0059D520), which is the single funnel every
        /// textured draw passes through. CSurface derives from DBObj, so its
        /// <c>BaseClass_DBObj.m_DID</c> is the 0x08 Surface id
        /// (ACBindings/Generated/Dats/DBObjs/CSurface.cs).
        ///
        /// This is why the texture highlight does NOT need to fingerprint IDirect3DTexture9
        /// pointers in the general case: the client tells us which dat Surface it is drawing.
        /// </summary>
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static uint CurrentSurfaceId() {
            try {
                CSurface** ppSurf = Render.curr_surface;
                if (ppSurf is null) return 0;
                CSurface* surf = *ppSurf;
                if (surf is null) return 0;
                return surf->BaseClass_DBObj.m_DID.BaseClass_uint;
            }
            catch (Exception) {
                return 0;
            }
        }

        /// <summary>
        /// The RenderSurface dat id (0x06......) behind the currently bound Surface, or 0.
        ///
        /// Chain, all offsets PDB-confirmed:
        ///   Render::curr_surface -> CSurface
        ///   CSurface::base1map (offset 108) -> ImgTex*        [ACBindings .../Dats/DBObjs/CSurface.cs]
        ///   ImgTex::m_SourceLevels (offset 88) -> SmartArray&lt;DataID&gt;, element 0 is the RS id
        ///   and the client's own accessor for exactly that is
        ///   <c>ImgTex::GetSurfaceDID(IDClass*)</c> @0x0053FE40
        ///   (ACBindings/Generated/Dats/DBObjs/ImgTex.cs:200), which additionally honours
        ///   Render::ShouldDropHighDetail() by returning element [1] at reduced detail.
        ///
        /// The user picks RenderSurfaces (rsId is the id the dat-patch pipeline repaints), and
        /// several different Surfaces can route to the same RenderSurface — so "all instances of
        /// this texture in view" has to match here, not on the 0x08 id.
        ///
        /// NOTE this calls into client code from inside a D3D detour. GetSurfaceDID is a leaf
        /// accessor, but it is still a call; it runs only when the user has an RS-kind selection
        /// armed, never on the general draw path.
        /// </summary>
        private static uint CurrentRenderSurfaceId() {
            try {
                CSurface** ppSurf = Render.curr_surface;
                if (ppSurf is null) return 0;
                CSurface* surf = *ppSurf;
                if (surf is null || surf->base1map is null) return 0;

                IDClass____tagDataID result = default;
                var p = surf->base1map->GetSurfaceDID(&result);
                return p is null ? 0u : p->BaseClass_uint;
            }
            catch (Exception) {
                return 0;
            }
        }

        // ==================================================================
        // Detours
        // ==================================================================

        /// <summary>
        /// IDirect3DDevice9::DrawIndexedPrimitive — slot 82 (HookAll.cpp).
        ///
        /// Forwards the real draw first so the object always renders normally, then — if this draw
        /// belongs to something the user selected or is hovering — re-issues the same geometry as a
        /// tinted pass. Order matters: tinting after means the tint blends over the finished
        /// surface rather than being overwritten by it.
        /// </summary>
        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvStdcall) })]
        private static int DrawIndexedPrimitiveH(IntPtr device, int primitiveType, int baseVertexIndex,
                                                 uint minVertexIndex, uint numVertices,
                                                 uint startIndex, uint primitiveCount) {
            var original = (delegate* unmanaged[Stdcall]<IntPtr, int, int, uint, uint, uint, uint, int>)
                _origDrawIndexedPrimitive;
            if (original == null) return 0;

            int hr = original(device, primitiveType, baseVertexIndex, minVertexIndex,
                              numVertices, startIndex, primitiveCount);

            // Fast bail: gate closed, or we are already inside our own second pass.
            if (!HighlightState.Active || _inTintPass) return hr;

            // Lasso MVP capture + texture-in-view collection ride on the draw path but are
            // independent of the tint. Both are cheap and armed only on user request.
            CaptureLassoMvpIfWanted();
            CollectTextureInViewIfWanted();

            uint tint = ResolveTintForCurrentDraw();
            if (tint == 0) return hr;

            _inTintPass = true;
            try {
                HighlightState.MatchedDrawsThisFrame++;
                HighlightState.TotalTintedPasses++;

                if (BeginTintState(device, tint)) {
                    original(device, primitiveType, baseVertexIndex, minVertexIndex,
                             numVertices, startIndex, primitiveCount);
                    EndTintState(device);
                }
            }
            catch (Exception) {
                // A detour must never let an exception escape into C++ client code.
            }
            finally {
                _inTintPass = false;
            }

            return hr;
        }

        /// <summary>
        /// IDirect3DDevice9::SetTexture — slot 65 (HookAll.cpp).
        ///
        /// Observational only: it records which native texture the client bound while a known
        /// Surface was current, which is how <see cref="TextureRegistry"/> learns its pointer↔id
        /// pairs without a struct-offset walk. It never alters the call.
        ///
        /// The client reaches this through <c>RenderDeviceD3D::SetStageTexture</c>, which also
        /// caches the binding in <c>m_State.Stages[n].pTexture</c>
        /// (ACBindings/Generated/Rendering/RenderStateCacheType.cs) — so this hook is a
        /// convenience, not a necessity, and is the first one to drop if it ever costs measurable
        /// frame time.
        /// </summary>
        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvStdcall) })]
        private static int SetTextureH(IntPtr device, uint stage, IntPtr texture) {
            if (HighlightState.Active && stage == 0 && texture != IntPtr.Zero && !_inTintPass) {
                try {
                    uint rsId = CurrentRenderSurfaceId();
                    if (rsId != 0) _pendingLearnRsId = rsId;
                    _pendingLearnTexture = texture;
                }
                catch (Exception) { }
            }

            var original = (delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr, int>)_origSetTexture;
            return original == null ? 0 : original(device, stage, texture);
        }

        // Single-slot handoff drained by DrainLearnedBinding on the managed side. Deliberately
        // not a queue: a detour must not allocate, and one sample per frame is plenty to build
        // the mapping over a few frames.
        private static uint _pendingLearnRsId;
        private static IntPtr _pendingLearnTexture;

        /// <summary>
        /// Fold whatever the SetTexture detour observed into the registry. Called from the managed
        /// render tick, never from inside a detour (the registry allocates).
        /// </summary>
        public void DrainLearnedBinding() {
            uint rsId = _pendingLearnRsId;
            IntPtr tex = _pendingLearnTexture;
            _pendingLearnRsId = 0;
            _pendingLearnTexture = IntPtr.Zero;
            if (rsId != 0 && tex != IntPtr.Zero) _textures?.Learn(rsId, tex);
        }

        // ==================================================================
        // Lasso: capture the target object's own MVP during its draw
        // ==================================================================
        //
        // The lasso needs to project a GfxObj's model-local triangle centroids to screen. Rather
        // than reconstruct model->world from the part pose (which would need the landblock/cell
        // global offset the client bakes in), we grab the client's OWN m_GState.ModelToWorldMatrix
        // at the instant it draws the target object — together with WorldToView/ViewToClip and the
        // viewport captured in the same frame. Everything is then in one consistent render space.

        private static volatile uint _lassoWantGfx;         // target GfxObj id, 0 = idle
        private static volatile bool _lassoCaptured;
        private static System.Numerics.Matrix4x4 _capM2W, _capW2V, _capV2C;
        private static int _capVpW, _capVpH;

        /// <summary>
        /// Ask the draw detour to snapshot the MVP the next time it draws <paramref name="gfxObjId"/>.
        /// Idempotent while armed for the same id. Managed side, render thread.
        /// </summary>
        public void ArmLassoCapture(uint gfxObjId) {
            if (gfxObjId == 0) return;
            if (_lassoWantGfx == gfxObjId) return;
            _lassoWantGfx = gfxObjId;
            _lassoCaptured = false;
        }

        /// <summary>Cancel a pending lasso capture.</summary>
        public void CancelLassoCapture() { _lassoWantGfx = 0; _lassoCaptured = false; }

        /// <summary>
        /// If the draw detour has captured the target's MVP, hand back the combined
        /// model·view·clip matrix and viewport, and disarm. Returns false until captured.
        /// </summary>
        public bool ConsumeLassoMvp(out System.Numerics.Matrix4x4 mvp, out int vpW, out int vpH) {
            mvp = System.Numerics.Matrix4x4.Identity; vpW = vpH = 0;
            if (!_lassoCaptured) return false;
            // row-vector: local · M2W · W2V · V2C
            mvp = _capM2W * _capW2V * _capV2C;
            vpW = _capVpW; vpH = _capVpH;
            _lassoWantGfx = 0;
            _lassoCaptured = false;
            return true;
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static void CaptureLassoMvpIfWanted() {
            uint want = _lassoWantGfx;
            if (want == 0 || _lassoCaptured) return;
            if (CurrentGfxObjId() != want) return;
            if (Projection.ReadGState(out _capM2W, out _capW2V, out _capV2C, out _capVpW, out _capVpH)) {
                _lassoCaptured = true;
            }
        }

        // ==================================================================
        // "All instances of this texture in view": frame-accumulation collector
        // ==================================================================
        //
        // LIFECYCLE (managed side drives it, render thread):
        //   ArmTextureCollect(rsId, frames)  -> collect for `frames` frames
        //   each frame: HandleBeforeRender3D decrements; the draw detour, while armed, records the
        //     GfxObj id of every draw whose current surface resolves to `rsId` (via curr_surface ->
        //     ImgTex::GetSurfaceDID, the same map the texture tint uses)
        //   DrainCollectedGfx() folds the unique ids into the selection; at 0 frames it disarms.
        // A few frames (default 3) covers occlusion/animation flicker without a visible stall.

        private const int MaxCollected = 256;
        private static volatile uint _collectRs;            // target RS id, 0 = idle
        private static volatile int _collectFramesLeft;
        private static readonly uint[] _collected = new uint[MaxCollected];
        private static int _collectedCount;

        /// <summary>Begin collecting GfxObj ids that bind <paramref name="rsId"/>, for N frames.</summary>
        public void ArmTextureCollect(uint rsId, int frames) {
            if (rsId == 0) return;
            _collectRs = rsId;
            _collectFramesLeft = Math.Max(1, frames);
            _collectedCount = 0;
        }

        /// <summary>True while a collection window is open.</summary>
        public bool IsCollectingTexture => _collectRs != 0 && _collectFramesLeft > 0;

        /// <summary>
        /// Tick the collection window one frame; returns the collected GfxObj ids and disarms when
        /// the window closes. Returns null while still collecting. Render thread.
        /// </summary>
        public uint[]? TickTextureCollect(out uint rsId) {
            rsId = _collectRs;
            if (_collectRs == 0) return null;
            if (--_collectFramesLeft > 0) return null;

            var result = new uint[_collectedCount];
            Array.Copy(_collected, result, _collectedCount);
            _collectRs = 0;
            _collectedCount = 0;
            return result;
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static void CollectTextureInViewIfWanted() {
            uint target = _collectRs;
            if (target == 0 || _collectFramesLeft <= 0) return;
            if (_collectedCount >= MaxCollected) return;
            if (CurrentRenderSurfaceId() != target) return;

            uint gfx = CurrentGfxObjId();
            if (gfx == 0) return;
            // de-dup within the buffer (small N, linear scan is fine on the render thread)
            for (int i = 0; i < _collectedCount; i++) if (_collected[i] == gfx) return;
            _collected[_collectedCount++] = gfx;
        }

        /// <summary>
        /// IDirect3DDevice9::Reset — slot 16 (HookAll.cpp).
        ///
        /// A reset destroys and re-creates default-pool resources, so every native texture pointer
        /// we learned becomes a dangling comparison that could alias an unrelated new texture.
        /// Flag it here; the managed side clears the registry on the next tick.
        /// </summary>
        [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvStdcall) })]
        private static int ResetH(IntPtr device, IntPtr presentParams) {
            _deviceWasReset = true;
            HighlightState.Deactivate();

            var original = (delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)_origReset;
            return original == null ? 0 : original(device, presentParams);
        }

        private static bool _deviceWasReset;

        /// <summary>True (once) if the device was reset since the last check.</summary>
        public bool ConsumeDeviceResetFlag() {
            if (!_deviceWasReset) return false;
            _deviceWasReset = false;
            return true;
        }

        // ==================================================================
        // Tint pass
        // ==================================================================

        /// <summary>Which tint the draw in flight should get, or 0 for none. Hot path.</summary>
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static uint ResolveTintForCurrentDraw() {
            // Object-kind first: it is a single pointer chase plus a tiny array scan.
            uint gfxObjId = CurrentGfxObjId();
            if (gfxObjId != 0) {
                uint tint = HighlightState.TintForGfxObj(gfxObjId);
                if (tint != 0) return tint;
            }

            // Texture-kind: only resolve the (slightly costlier) RS id when something wants it —
            // a live texture selection OR the status overlay tinting reported textures.
            var rsIds = HighlightState.SelectedRenderSurfaceIds;
            bool wantRs = rsIds.Length > 0 || HighlightState.StatusRenderSurfaceIds.Length > 0;
            if (wantRs) {
                uint rsId = CurrentRenderSurfaceId();
                if (rsId != 0) {
                    for (int i = 0; i < rsIds.Length; i++) {
                        if (rsIds[i] == rsId) return HighlightState.SelectedArgb;
                    }
                    uint st = HighlightState.StatusTintForRenderSurface(rsId);
                    if (st != 0) return st;
                }
            }

            return 0;
        }

        // Saved fixed-function state, restored by EndTintState.
        private static uint _sAlphaBlend, _sSrcBlend, _sDstBlend, _sZWrite, _sZFunc,
                            _sTexFactor, _sLighting, _sFog, _sDepthBias, _sAlphaTest,
                            _sColorOp, _sColorArg1, _sAlphaOp, _sAlphaArg1;

        /// <summary>
        /// Switch the fixed-function pipeline to "paint this geometry in a flat, blended,
        /// depth-correct colour".
        ///
        /// The tint arrives through D3DRS_TEXTUREFACTOR and stage 0 selecting D3DTA_TFACTOR for
        /// both colour and alpha, which sidesteps the whole question of whether the mesh's
        /// per-vertex diffuse is being consumed (it usually is not — see the class remarks).
        /// Depth test stays ON so the highlight is occluded correctly; depth WRITES go off and a
        /// small negative bias goes on so the tint reliably wins against the surface it is
        /// covering without poking through the geometry in front of it.
        ///
        /// All D3DRS_/D3DTSS_/D3DTOP_/D3DTA_ values are from the public d3d9types.h ABI, mirrored
        /// in <see cref="D3D9"/>.
        /// </summary>
        private static bool BeginTintState(IntPtr device, uint argb) {
            var get = (delegate* unmanaged[Stdcall]<IntPtr, int, uint*, int>)
                D3D9.GetVTableEntry(device, D3D9.Slot.GetRenderState);
            var set = (delegate* unmanaged[Stdcall]<IntPtr, int, uint, int>)
                D3D9.GetVTableEntry(device, D3D9.Slot.SetRenderState);
            var getTss = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, uint*, int>)
                D3D9.GetVTableEntry(device, D3D9.Slot.GetTextureStageState);
            var setTss = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, uint, int>)
                D3D9.GetVTableEntry(device, D3D9.Slot.SetTextureStageState);

            if (get == null || set == null || getTss == null || setTss == null) return false;

            fixed (uint* pAb = &_sAlphaBlend) get(device, D3D9.Rs.AlphaBlendEnable, pAb);
            fixed (uint* p = &_sSrcBlend) get(device, D3D9.Rs.SrcBlend, p);
            fixed (uint* p = &_sDstBlend) get(device, D3D9.Rs.DestBlend, p);
            fixed (uint* p = &_sZWrite) get(device, D3D9.Rs.ZWriteEnable, p);
            fixed (uint* p = &_sZFunc) get(device, D3D9.Rs.ZFunc, p);
            fixed (uint* p = &_sTexFactor) get(device, D3D9.Rs.TextureFactor, p);
            fixed (uint* p = &_sLighting) get(device, D3D9.Rs.Lighting, p);
            fixed (uint* p = &_sFog) get(device, D3D9.Rs.FogEnable, p);
            fixed (uint* p = &_sDepthBias) get(device, D3D9.Rs.DepthBias, p);
            fixed (uint* p = &_sAlphaTest) get(device, D3D9.Rs.AlphaTestEnable, p);
            fixed (uint* p = &_sColorOp) getTss(device, 0, D3D9.Tss.ColorOp, p);
            fixed (uint* p = &_sColorArg1) getTss(device, 0, D3D9.Tss.ColorArg1, p);
            fixed (uint* p = &_sAlphaOp) getTss(device, 0, D3D9.Tss.AlphaOp, p);
            fixed (uint* p = &_sAlphaArg1) getTss(device, 0, D3D9.Tss.AlphaArg1, p);

            set(device, D3D9.Rs.TextureFactor, argb);
            set(device, D3D9.Rs.AlphaBlendEnable, 1);
            set(device, D3D9.Rs.SrcBlend, D3D9.Blend.SrcAlpha);
            set(device, D3D9.Rs.DestBlend, D3D9.Blend.InvSrcAlpha);
            set(device, D3D9.Rs.AlphaTestEnable, 0);
            set(device, D3D9.Rs.ZEnable, 1);
            set(device, D3D9.Rs.ZWriteEnable, 0);
            set(device, D3D9.Rs.ZFunc, D3D9.Cmp.LessEqual);
            set(device, D3D9.Rs.Lighting, 0);
            set(device, D3D9.Rs.FogEnable, 0);
            set(device, D3D9.Rs.DepthBias, NegativeDepthBiasBits);

            setTss(device, 0, D3D9.Tss.ColorOp, D3D9.Top.SelectArg1);
            setTss(device, 0, D3D9.Tss.ColorArg1, D3D9.Ta.TFactor);
            setTss(device, 0, D3D9.Tss.AlphaOp, D3D9.Top.SelectArg1);
            setTss(device, 0, D3D9.Tss.AlphaArg1, D3D9.Ta.TFactor);

            return true;
        }

        /// <summary>
        /// D3DRS_DEPTHBIAS is a float reinterpreted as DWORD. A small negative bias pulls the tint
        /// toward the viewer just enough to beat coplanar z-fighting.
        /// </summary>
        private static readonly uint NegativeDepthBiasBits =
            (uint)BitConverter.SingleToInt32Bits(-1.0e-5f);

        /// <summary>Put back everything <see cref="BeginTintState"/> changed.</summary>
        private static void EndTintState(IntPtr device) {
            var set = (delegate* unmanaged[Stdcall]<IntPtr, int, uint, int>)
                D3D9.GetVTableEntry(device, D3D9.Slot.SetRenderState);
            var setTss = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, uint, int>)
                D3D9.GetVTableEntry(device, D3D9.Slot.SetTextureStageState);
            if (set == null || setTss == null) return;

            set(device, D3D9.Rs.AlphaBlendEnable, _sAlphaBlend);
            set(device, D3D9.Rs.SrcBlend, _sSrcBlend);
            set(device, D3D9.Rs.DestBlend, _sDstBlend);
            set(device, D3D9.Rs.ZWriteEnable, _sZWrite);
            set(device, D3D9.Rs.ZFunc, _sZFunc);
            set(device, D3D9.Rs.TextureFactor, _sTexFactor);
            set(device, D3D9.Rs.Lighting, _sLighting);
            set(device, D3D9.Rs.FogEnable, _sFog);
            set(device, D3D9.Rs.DepthBias, _sDepthBias);
            set(device, D3D9.Rs.AlphaTestEnable, _sAlphaTest);

            setTss(device, 0, D3D9.Tss.ColorOp, _sColorOp);
            setTss(device, 0, D3D9.Tss.ColorArg1, _sColorArg1);
            setTss(device, 0, D3D9.Tss.AlphaOp, _sAlphaOp);
            setTss(device, 0, D3D9.Tss.AlphaArg1, _sAlphaArg1);
        }
    }
}
