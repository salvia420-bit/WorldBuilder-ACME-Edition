using System;
using System.Collections.Generic;
using AcmeRedline.Model;

namespace AcmeRedline.Services {
    /// <summary>
    /// The one-way handoff between the managed selection world and the D3D detours.
    ///
    /// DISCIPLINE (SkunkVision's, kept deliberately). In <c>SVRenderHook.cpp</c>
    /// <c>PreBeginScene</c> the plugin copies its COM properties into plain statics
    /// (<c>s_fSlope = m_fSlope; s_argbWater = m_argbWater; ...</c>) exactly once per frame, and the
    /// vtable hooks read only those statics. Nothing else. That is what keeps the detour bodies
    /// allocation-free, lock-free and re-entrancy-safe while the client is inside its draw loop.
    ///
    /// This class is the same idea with types: <see cref="Publish"/> is called once per frame from
    /// the render tick, on the render thread, and the detours read only the published snapshot.
    /// The detours never touch <see cref="SelectionService"/>, never allocate, and never take a
    /// lock — a lock inside DrawIndexedPrimitive would deadlock against the very thread that owns
    /// the device.
    ///
    /// All fields are plain statics rather than an object graph so a detour never dereferences a
    /// reference that could be mid-swap.
    /// </summary>
    public static class HighlightState {

        /// <summary>Master gate. When false every detour forwards immediately, doing nothing.</summary>
        public static volatile bool Active;

        /// <summary>Tint colour for the confirmed selection, packed ARGB.</summary>
        public static volatile uint SelectedArgb = 0xA0FF4040;

        /// <summary>Tint colour for the hover target, packed ARGB. Alpha is replaced by the pulse.</summary>
        public static volatile uint HoveredArgb = 0x80FFD933;

        /// <summary>
        /// Per-frame pulse factor in [0,1], recomputed in <see cref="Publish"/>. Used to modulate
        /// the hover alpha so the hovered target breathes and is distinguishable from the
        /// solid-tinted selection without needing a second colour.
        /// </summary>
        public static volatile float HoverPulse = 1f;

        // --- Correlation keys the detours match against -------------------------------------
        // Plain arrays, swapped wholesale in Publish. A detour reads the array reference once
        // into a local, so a concurrent Publish can never tear it mid-scan.

        /// <summary>GfxObj dat ids (0x01......) whose draws should get the SELECTED tint.</summary>
        public static uint[] SelectedGfxObjIds = [];

        /// <summary>GfxObj dat ids whose draws should get the HOVER tint.</summary>
        public static uint[] HoveredGfxObjIds = [];

        /// <summary>RenderSurface dat ids (0x06......) whose draws should get the SELECTED tint.</summary>
        public static uint[] SelectedRenderSurfaceIds = [];

        /// <summary>
        /// Native IDirect3DTexture9 pointers currently known to correspond to
        /// <see cref="SelectedRenderSurfaceIds"/>. Resolved by <see cref="TextureRegistry"/>;
        /// this is the array the SetTexture detour actually compares against, because comparing
        /// raw pointers is the only thing cheap enough for the hot path.
        /// </summary>
        public static IntPtr[] SelectedTexturePtrs = [];

        /// <summary>
        /// Status-overlay tints: parallel arrays of GfxObj id -> ARGB, from redline-status.jsonl.
        /// Parallel arrays rather than a Dictionary because a detour must not risk hashing into a
        /// collection that managed code might be rehashing.
        /// </summary>
        public static uint[] StatusGfxObjIds = [];

        /// <summary>ARGB per entry of <see cref="StatusGfxObjIds"/>.</summary>
        public static uint[] StatusArgb = [];

        /// <summary>
        /// Status-overlay tints keyed by RenderSurface id (for texture-kind annotations), so a
        /// reported texture glows by status on every draw that binds it. Parallel to
        /// <see cref="StatusRsArgb"/>.
        /// </summary>
        public static uint[] StatusRenderSurfaceIds = [];

        /// <summary>ARGB per entry of <see cref="StatusRenderSurfaceIds"/>.</summary>
        public static uint[] StatusRsArgb = [];

        // --- Diagnostics --------------------------------------------------------------------

        /// <summary>Draw calls the current frame's detours matched. Reset each Publish.</summary>
        public static int MatchedDrawsThisFrame;

        /// <summary>Total tinted passes issued since arming. Cheap health signal for the HUD.</summary>
        public static long TotalTintedPasses;

        /// <summary>
        /// Publish a frame's worth of state. Call ONCE per frame, on the render thread, before
        /// the client's geometry pass — the analogue of SkunkVision's PreBeginScene block.
        /// </summary>
        /// <param name="active">Master gate.</param>
        /// <param name="selection">Current selection set.</param>
        /// <param name="hoveredGfxObjId">GfxObj under the cursor, 0 for none.</param>
        /// <param name="textures">Registry supplying native texture pointers for RS ids.</param>
        /// <param name="statusTints">GfxObj id -> ARGB from the status overlay, may be null.</param>
        /// <param name="statusRsTints">RenderSurface id -> ARGB from the status overlay, may be null.</param>
        /// <param name="nowSeconds">Monotonic seconds, drives the hover pulse.</param>
        public static void Publish(bool active,
                                   SelectionSet selection,
                                   uint hoveredGfxObjId,
                                   TextureRegistry textures,
                                   IReadOnlyDictionary<uint, uint>? statusTints,
                                   IReadOnlyDictionary<uint, uint>? statusRsTints,
                                   double nowSeconds) {
            MatchedDrawsThisFrame = 0;

            if (!active || selection is null) {
                Active = false;
                SelectedGfxObjIds = [];
                HoveredGfxObjIds = [];
                SelectedRenderSurfaceIds = [];
                SelectedTexturePtrs = [];
                StatusGfxObjIds = [];
                StatusArgb = [];
                StatusRenderSurfaceIds = [];
                StatusRsArgb = [];
                return;
            }

            // Hover pulse: 0.45..1.0 at ~1.1 Hz. Keeps the hover legible without strobing.
            HoverPulse = 0.725f + 0.275f * (float)Math.Sin(nowSeconds * 7.0);

            // --- selected geometry
            var gfxIds = new List<uint>(selection.Objects.Count);
            foreach (var o in selection.Objects.Values) {
                if (o.GfxObjId != 0) gfxIds.Add(o.GfxObjId);
            }
            if (selection.TriangleGfxObjId != 0 && !gfxIds.Contains(selection.TriangleGfxObjId)) {
                gfxIds.Add(selection.TriangleGfxObjId);
            }
            SelectedGfxObjIds = gfxIds.ToArray();

            HoveredGfxObjIds = hoveredGfxObjId == 0 ? [] : [hoveredGfxObjId];

            // --- selected textures
            var rsIds = new List<uint>(selection.Surfaces.Count);
            var texPtrs = new List<IntPtr>(selection.Surfaces.Count);
            foreach (var rsId in selection.Surfaces.Keys) {
                if (rsId == 0) continue;
                rsIds.Add(rsId);
                foreach (var ptr in textures.NativePointersFor(rsId)) {
                    if (ptr != IntPtr.Zero) texPtrs.Add(ptr);
                }
            }
            SelectedRenderSurfaceIds = rsIds.ToArray();
            SelectedTexturePtrs = texPtrs.ToArray();

            // --- status tints (by GfxObj — object/triangle annotations)
            (StatusGfxObjIds, StatusArgb) = Flatten(statusTints);
            // --- status tints (by RenderSurface — texture annotations)
            (StatusRenderSurfaceIds, StatusRsArgb) = Flatten(statusRsTints);

            // Published last: everything the detours read is in place before the gate opens.
            Active = true;
        }

        private static (uint[] ids, uint[] cols) Flatten(IReadOnlyDictionary<uint, uint>? map) {
            if (map is not { Count: > 0 }) return ([], []);
            var ids = new uint[map.Count];
            var cols = new uint[map.Count];
            int i = 0;
            foreach (var kv in map) { ids[i] = kv.Key; cols[i] = kv.Value; i++; }
            return (ids, cols);
        }

        /// <summary>ARGB status tint for a RenderSurface id, or 0 if none. Hot path.</summary>
        public static uint StatusTintForRenderSurface(uint rsId) {
            if (rsId == 0) return 0;
            var ids = StatusRenderSurfaceIds;
            var cols = StatusRsArgb;
            int n = ids.Length < cols.Length ? ids.Length : cols.Length;
            for (int i = 0; i < n; i++) if (ids[i] == rsId) return cols[i];
            return 0;
        }

        /// <summary>Close the gate immediately. Safe from any thread.</summary>
        public static void Deactivate() {
            Active = false;
        }

        /// <summary>
        /// True when there is nothing to tint, so <see cref="DeviceHooks"/> can drop its hooks
        /// entirely. The analogue of SkunkVision's <c>FNeedHook()</c>
        /// (<c>m_fEnabled &amp;&amp; (m_fSlope || m_fWater || m_fLight)</c>).
        /// </summary>
        public static bool Idle =>
            SelectedGfxObjIds.Length == 0 &&
            HoveredGfxObjIds.Length == 0 &&
            SelectedRenderSurfaceIds.Length == 0 &&
            SelectedTexturePtrs.Length == 0 &&
            StatusGfxObjIds.Length == 0 &&
            StatusRenderSurfaceIds.Length == 0;

        /// <summary>
        /// Which tint, if any, a draw of <paramref name="gfxObjId"/> should get.
        /// Allocation-free and branch-cheap: this runs inside DrawIndexedPrimitive.
        /// Returns 0 for "no tint".
        /// </summary>
        public static uint TintForGfxObj(uint gfxObjId) {
            if (gfxObjId == 0) return 0;

            var selected = SelectedGfxObjIds;
            for (int i = 0; i < selected.Length; i++) {
                if (selected[i] == gfxObjId) return SelectedArgb;
            }

            var hovered = HoveredGfxObjIds;
            for (int i = 0; i < hovered.Length; i++) {
                if (hovered[i] == gfxObjId) return ApplyPulse(HoveredArgb, HoverPulse);
            }

            var statusIds = StatusGfxObjIds;
            var statusCols = StatusArgb;
            int n = statusIds.Length < statusCols.Length ? statusIds.Length : statusCols.Length;
            for (int i = 0; i < n; i++) {
                if (statusIds[i] == gfxObjId) return statusCols[i];
            }

            return 0;
        }

        /// <summary>Whether a bound native texture pointer is one of the selected textures.</summary>
        public static bool IsSelectedTexture(IntPtr texture) {
            if (texture == IntPtr.Zero) return false;
            var ptrs = SelectedTexturePtrs;
            for (int i = 0; i < ptrs.Length; i++) {
                if (ptrs[i] == texture) return true;
            }
            return false;
        }

        /// <summary>Scale an ARGB's alpha channel by a factor in [0,1].</summary>
        public static uint ApplyPulse(uint argb, float factor) {
            uint a = (argb >> 24) & 0xFF;
            uint scaled = (uint)(a * (factor < 0f ? 0f : factor > 1f ? 1f : factor));
            return (scaled << 24) | (argb & 0x00FFFFFF);
        }

        /// <summary>Pack a status string into a tint colour, matching the 2D overlay's palette.</summary>
        public static uint ArgbForState(string? state, byte alpha = 0x90) {
            var c = OverlayRenderer.ColorForState(state);
            uint r = (uint)(Math.Clamp(c.R, 0f, 1f) * 255f);
            uint g = (uint)(Math.Clamp(c.G, 0f, 1f) * 255f);
            uint b = (uint)(Math.Clamp(c.B, 0f, 1f) * 255f);
            return ((uint)alpha << 24) | (r << 16) | (g << 8) | b;
        }
    }
}
