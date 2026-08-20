using System;
using System.Collections.Generic;
using Microsoft.Extensions.Logging;

namespace AcmeRedline.Services {
    /// <summary>
    /// Maps a live <c>IDirect3DTexture9*</c> (what a SetTexture call carries) back to the dat
    /// RenderSurface id (0x06......) the pipeline cares about.
    ///
    /// WHY THIS IS NEEDED. The texture highlight and the "select all instances of this texture in
    /// view" mode both need to answer, inside a hot D3D detour, "is the texture currently bound
    /// one of the ones the user picked?". The picked thing is a dat id; the bound thing is a COM
    /// pointer. Something has to bridge them, and it has to be a pointer compare by the time the
    /// detour runs.
    ///
    /// STRATEGY: LEARN IT, DON'T DERIVE IT.
    ///
    /// The chosen strategy is *observational*: while the user's picked object is being drawn, the
    /// SetTexture detour records the pointer that was bound, and the managed side already knows —
    /// from <see cref="SelectionService"/>'s dat-side chain
    /// (polygon → Surface 0x08 → SurfaceTexture 0x05 → RenderSurface 0x06) — which RenderSurface
    /// that draw *should* be using. Correlating the two produces a pointer↔id pair that is then
    /// valid for every other object in the scene that shares the texture.
    ///
    /// This is deliberately preferred over walking the client's texture cache, for three reasons:
    ///  1. it needs no unverified struct offsets, so it cannot silently read the wrong field;
    ///  2. it survives the client re-creating a texture (device reset, detail-level change) —
    ///     a stale pointer simply stops matching and gets re-learned;
    ///  3. it is falsifiable at runtime: <see cref="Count"/> and <see cref="LearnedFor"/> make it
    ///     obvious in the HUD whether the mapping was actually established.
    ///
    /// Its cost is latency: a texture is only known after the picked object has been drawn at
    /// least once, so "all instances in view" lights up on the frame *after* the pick. That is an
    /// acceptable trade for not guessing at memory layout.
    ///
    /// TODO(acme-redline): the direct chain is the better long-term answer if it can be verified.
    /// The client side of it is <c>CSurface</c>
    /// (external/chorizite/ACBindings/Generated/Dats/DBObjs/CSurface.cs) which holds
    /// <c>base1map</c> (an <c>ImgTex*</c>) alongside <c>orig_texture_id</c>, and
    /// <c>D3DPolyRender::SetSurface(CSurface*)</c> is the function that turns a CSurface into
    /// bound D3D state (ac-headers/acclient.c). What is NOT yet verified is which member of
    /// <c>ImgTex</c> holds the <c>IDirect3DTexture9*</c> and whether it is the same object D3D
    /// sees at SetTexture time (the client may bind a merged atlas — see
    /// ACBindings/Generated/TexMerge.cs / TextureMergeInfo). Until that is confirmed against a
    /// live client, learning is the honest mechanism. Searched: ACBindings/Generated/Dats/DBObjs/,
    /// ACBindings/Generated/Rendering/{RenderSurface*.cs,TexMerge.cs,D3D/}, and the decomp for
    /// D3DPolyRender::SetSurface.
    /// </summary>
    public sealed class TextureRegistry {
        private readonly ILogger _log;

        // rsId -> the native texture pointers seen for it. A RenderSurface can legitimately map
        // to more than one live texture (mip variants, a re-created texture after device reset),
        // so this is one-to-many.
        private readonly Dictionary<uint, List<IntPtr>> _byRsId = [];

        // Reverse map, for attributing an observed bind.
        private readonly Dictionary<IntPtr, uint> _byPointer = [];

        private static readonly IntPtr[] Empty = [];

        public TextureRegistry(ILogger log) {
            _log = log;
        }

        /// <summary>How many pointer↔id pairs are currently known. Surfaced in the HUD.</summary>
        public int Count => _byPointer.Count;

        /// <summary>True when at least one live texture pointer is known for this RenderSurface.</summary>
        public bool LearnedFor(uint rsId) => _byRsId.TryGetValue(rsId, out var l) && l.Count > 0;

        /// <summary>
        /// Native texture pointers known for a RenderSurface id. Never null; empty means
        /// "not learned yet", which the caller should treat as "cannot tint this one this frame".
        /// </summary>
        public IReadOnlyList<IntPtr> NativePointersFor(uint rsId) =>
            _byRsId.TryGetValue(rsId, out var list) ? list : (IReadOnlyList<IntPtr>)Empty;

        /// <summary>The RenderSurface id a bound pointer belongs to, or 0 if unknown.</summary>
        public uint RsIdFor(IntPtr texture) =>
            texture != IntPtr.Zero && _byPointer.TryGetValue(texture, out var id) ? id : 0u;

        /// <summary>
        /// Record an observed association. Called from managed code on the render thread after a
        /// learning frame, never from inside a detour.
        /// </summary>
        public void Learn(uint rsId, IntPtr texture) {
            if (rsId == 0 || texture == IntPtr.Zero) return;

            if (_byPointer.TryGetValue(texture, out var existing)) {
                if (existing == rsId) return;
                // A pointer that used to mean something else: the client recycled the object.
                Forget(texture);
            }

            if (!_byRsId.TryGetValue(rsId, out var list)) {
                list = [];
                _byRsId[rsId] = list;
            }
            if (!list.Contains(texture)) list.Add(texture);
            _byPointer[texture] = rsId;

            _log.LogDebug("redline: learned texture {Ptr:X8} -> RS 0x{Rs:X8}", texture.ToInt64(), rsId);
        }

        /// <summary>Drop one pointer (it was recycled or the device was reset).</summary>
        public void Forget(IntPtr texture) {
            if (!_byPointer.Remove(texture, out var rsId)) return;
            if (_byRsId.TryGetValue(rsId, out var list)) {
                list.Remove(texture);
                if (list.Count == 0) _byRsId.Remove(rsId);
            }
        }

        /// <summary>
        /// Drop everything. MUST be called on device reset: IDirect3DTexture9 objects in the
        /// default pool are destroyed and re-created, so every pointer we hold becomes a
        /// dangling comparison that could alias a freshly-allocated unrelated texture.
        /// Wired to IRenderer.OnGraphicsPreReset
        /// (external/chorizite/Chorizite/Chorizite.Core/Render/IGraphicsDevice.cs:58, surfaced by
        /// DX9RenderInterface's OnGraphicsPreReset).
        /// </summary>
        public void Clear() {
            if (_byPointer.Count > 0) {
                _log.LogInformation("redline: dropping {N} learned texture mappings (device reset)", _byPointer.Count);
            }
            _byPointer.Clear();
            _byRsId.Clear();
        }
    }
}
