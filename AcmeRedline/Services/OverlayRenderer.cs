using System;
using System.Collections.Generic;
using AcmeRedline.Lib;
using AcmeRedline.Model;
using Chorizite.Core.Backend;
using Chorizite.Core.Render;
using Chorizite.Core.Render.Vertex;
using Microsoft.Extensions.Logging;

namespace AcmeRedline.Services {
    /// <summary>
    /// Draws the redline overlay: what is hovered, what is selected, and (in status mode)
    /// how previously-annotated targets are doing in the pipeline.
    ///
    /// RENDER HOOKS - verified, not assumed. IRenderer
    /// (external/chorizite/Chorizite/Chorizite.Core/Render/IRenderer.cs) publishes exactly six
    /// events: OnBeforeRender3D, OnRender3D, OnAfterRender3D, OnBeforeRenderUI, OnRenderUI,
    /// OnAfterRenderUI - all <c>EventHandler&lt;EventArgs&gt;</c>, all parameterless. This class
    /// subscribes to OnAfterRender3D (to read back the client's selection probe once the frame's
    /// geometry pass is done) and OnRenderUI (to draw). The renderer is reached from
    /// IChoriziteBackend.Renderer (Chorizite.Core/Backend/IChoriziteBackend.cs).
    ///
    /// DIVISION OF LABOUR. Chorizite's only plugin-facing draw surface is IRenderer.DrawList, an
    /// <see cref="IDrawList"/> (Chorizite.Core/Render/IDrawList.cs) whose entire vocabulary is
    /// PushClipRect / PopClipRect / Flush / DrawRect / DrawRectFilled / DrawTexture / DrawText /
    /// DrawRing — a 2D screen-space list with no line, no triangle and no depth-tested path.
    /// (IGraphicsDevice.DrawElements exists at IGraphicsDevice.cs:130 but needs a vertex array,
    /// index buffer and shader the plugin would have to author, and IRenderer.GraphicsDevice
    /// throws NotImplementedException in the client backend anyway —
    /// Chorizite.NativeClientBootstrapper/Render/DX9RenderInterface.cs:95.)
    ///
    /// So this class owns only what genuinely belongs in screen space: the HUD, the lasso trail
    /// and the status legend. The WORLD-SPACE highlight is <see cref="DeviceHooks"/>'s job — it
    /// hooks the client's own IDirect3DDevice9 vtable and re-issues the matching draw as a tinted
    /// pass (the SkunkVision RenderHook method), which is depth-correct and pixel-aligned because
    /// it is the real geometry. This class drives that: it publishes the per-frame
    /// <see cref="HighlightState"/> snapshot in OnBeforeRender3D and arms/drops the hooks.
    /// </summary>
    public sealed class OverlayRenderer : IDisposable {
        private readonly IChoriziteBackend _backend;
        private readonly Chorizite.Core.Dats.IDatReaderInterface _dat;
        private readonly SelectionService _selection;
        private readonly StatusReader _status;
        private readonly QueueWriter _queue;
        private readonly TextureRegistry _textures;
        private readonly DeviceHooks? _hooks;
        private readonly RedlineSettings _settings;
        private readonly ILogger _log;
        private readonly System.Diagnostics.Stopwatch _clock = System.Diagnostics.Stopwatch.StartNew();

        private IRenderer? _renderer;
        private bool _subscribed;
        private IFont? _hudFont;
        private bool _hudFontResolved;

        // Palette. Alpha is premultiplied nowhere in Chorizite's draw list, so plain RGBA.
        private static readonly ColorVec ColHover = new(1.00f, 0.85f, 0.20f, 0.55f);
        private static readonly ColorVec ColSelected = new(1.00f, 0.25f, 0.25f, 0.65f);
        private static readonly ColorVec ColLasso = new(0.35f, 0.85f, 1.00f, 0.85f);
        private static readonly ColorVec ColPanelBg = new(0.05f, 0.05f, 0.07f, 0.72f);
        private static readonly ColorVec ColText = new(0.92f, 0.92f, 0.95f, 1.00f);

        // Status palette per the owner's spec: queued = yellow, in-progress = blue, fixed = green.
        private static readonly ColorVec ColQueued = new(1.00f, 0.85f, 0.15f, 0.80f);   // yellow
        private static readonly ColorVec ColInProgress = new(0.25f, 0.55f, 1.00f, 0.80f); // blue
        private static readonly ColorVec ColFixed = new(0.30f, 0.85f, 0.40f, 0.80f);     // green

        private readonly Func<string?> _authorProvider;

        public OverlayRenderer(IChoriziteBackend backend, Chorizite.Core.Dats.IDatReaderInterface dat,
                               SelectionService selection, StatusReader status, QueueWriter queue,
                               TextureRegistry textures, DeviceHooks? hooks,
                               RedlineSettings settings, Func<string?> authorProvider, ILogger log) {
            _backend = backend;
            _dat = dat;
            _selection = selection;
            _status = status;
            _queue = queue;
            _textures = textures;
            _hooks = hooks;
            _settings = settings;
            _authorProvider = authorProvider;
            _log = log;
        }

        /// <summary>
        /// Resolve a font for the HUD text.
        ///
        /// IFontManager.GetFont(string name, int size) is NOT usable: Chorizite.Core's
        /// FontManager returns null from it unconditionally
        /// (external/chorizite/Chorizite/Chorizite.Core/Render/FontManager.cs:57-60). The working
        /// overload is GetFont(uint datFontId), which wraps an ACFont over a 0x40...... Font
        /// record (Render/ACFont.cs). Rather than hardcode a magic id, take the first Font record
        /// the portal dat actually contains, via
        /// DatDatabase.GetAllIdsOfType&lt;Font&gt;() (external/DatReaderWriter/DatReaderWriter/DatDatabase.cs:112).
        /// Settings can pin a specific id. Null means "skip the text", never "crash".
        /// </summary>
        private IFont? HudFont() {
            if (_hudFontResolved) return _hudFont;
            _hudFontResolved = true;
            try {
                uint did = _settings.HudFontDid;
                if (did == 0) {
                    foreach (var id in _dat.Portal.GetAllIdsOfType<DatReaderWriter.DBObjs.Font>()) {
                        did = id;
                        break;
                    }
                }
                if (did != 0) _hudFont = _renderer?.FontManager?.GetFont(did);
            }
            catch (Exception ex) {
                _log.LogDebug(ex, "redline: could not resolve a HUD font; overlay text disabled");
            }
            return _hudFont;
        }

        /// <summary>
        /// True while the frame callbacks are subscribed. Lets the plugin's master switch skip a
        /// teardown that has nothing to tear down — which matters at startup, where a persisted
        /// "disabled" would otherwise marshal a no-op onto the render thread before there is one.
        /// </summary>
        public bool IsAttached => _subscribed;

        /// <summary>Attach to the renderer's frame callbacks.</summary>
        public void Attach() {
            if (_subscribed) return;
            _renderer = _backend.Renderer;
            if (_renderer is null) {
                _log.LogWarning("redline: no IRenderer on the backend; overlay disabled");
                return;
            }
            // OnBeforeRender3D is our PreBeginScene analogue: the last managed moment before the
            // client submits geometry, so it is where the world-highlight hooks get armed and the
            // frame's highlight state gets published. See SkunkVision SVRenderHook.cpp
            // CSVRenderHook::PreBeginScene.
            _renderer.OnBeforeRender3D += HandleBeforeRender3D;
            _renderer.OnAfterRender3D += HandleAfterRender3D;
            _renderer.OnRenderUI += HandleRenderUI;
            // NOTE: device-reset notification does NOT come from the framework here.
            // OnGraphicsPreReset/OnGraphicsPostReset live on IGraphicsDevice
            // (Chorizite.Core/Render/IGraphicsDevice.cs:58,63), and IRenderer.GraphicsDevice
            // throws NotImplementedException in the client backend
            // (Chorizite.NativeClientBootstrapper/Render/DX9RenderInterface.cs:95), so there is
            // no reachable event. DeviceHooks hooks IDirect3DDevice9::Reset (slot 16) itself and
            // exposes it via ConsumeDeviceResetFlag() — the authoritative signal anyway.
            _subscribed = true;
        }

        /// <summary>Detach. Safe to call twice.</summary>
        public void Detach() {
            if (!_subscribed || _renderer is null) return;
            _renderer.OnBeforeRender3D -= HandleBeforeRender3D;
            _renderer.OnAfterRender3D -= HandleAfterRender3D;
            _renderer.OnRenderUI -= HandleRenderUI;
            _subscribed = false;
        }

        public void Dispose() {
            Detach();
            HighlightState.Deactivate();
        }

        // ------------------------------------------------------------------

        /// <summary>
        /// Start of the frame. Publishes the highlight snapshot the D3D detours will read, then
        /// arms or drops the vtable hooks to match demand.
        ///
        /// This is deliberately the ONLY place per frame that touches
        /// <see cref="HighlightState"/> — SkunkVision's once-per-frame static handoff, kept
        /// because it is what makes the detour bodies lock-free and allocation-free.
        /// </summary>
        private void HandleBeforeRender3D(object? sender, EventArgs e) {
            if (_hooks is null) return;

            try {
                if (_hooks.ConsumeDeviceResetFlag()) {
                    // A reset destroys default-pool textures and can rebuild device state, so
                    // every learned pointer is stale. Drop the map and the hooks; both
                    // re-establish on the next frame that wants them.
                    _textures.Clear();
                    _hooks.Disarm("device reset");
                    // The saved vtable entries belong to the pre-reset device; re-resolve rather
                    // than write stale function pointers back into a rebuilt vtable.
                    _hooks.InvalidateDevice();
                }
                _hooks.DrainLearnedBinding();

                // A pending lasso resolve or an open texture-collection needs the draw detour to
                // run this frame (they piggyback on it), so keep the pipeline active + hooked even
                // if there is nothing to tint yet.
                if (_selection.PendingTextureInViewRs != 0) {
                    _hooks.ArmTextureCollect(_selection.PendingTextureInViewRs, frames: 3);
                    _selection.ClearTextureInViewRequest();
                }
                if (_selection.LassoResolvePending) {
                    uint tgt = _selection.PrepareLassoTarget();
                    if (tgt != 0) _hooks.ArmLassoCapture(tgt);
                    else _selection.CancelLasso();
                }

                bool overlayWant = _settings.OverlayEnabled && _settings.WorldHighlightEnabled;
                bool pipelineWork = _selection.LassoResolvePending || _hooks.IsCollectingTexture;

                if (overlayWant || pipelineWork) {
                    _status.Refresh();
                    Dictionary<uint, uint>? statusGfx = null, statusRs = null;
                    if (overlayWant && _settings.StatusOverlayEnabled) BuildStatusTints(out statusGfx, out statusRs);
                    HighlightState.Publish(
                        active: true,
                        selection: _selection.Current,
                        hoveredGfxObjId: overlayWant ? HoveredGfxObjId() : 0,
                        textures: _textures,
                        statusTints: statusGfx,
                        statusRsTints: statusRs,
                        nowSeconds: _clock.Elapsed.TotalSeconds);
                }
                else {
                    HighlightState.Deactivate();
                }

                // FNeedHook(): stay hooked while there's something to tint OR pipeline work pending.
                _hooks.SyncArmState((overlayWant && !HighlightState.Idle) || pipelineWork);
            }
            catch (Exception ex) {
                _log.LogDebug(ex, "redline: overlay pre-3D tick failed");
                HighlightState.Deactivate();
            }
        }

        /// <summary>The GfxObj id of the hovered object, resolved through the client's part table.</summary>
        private uint HoveredGfxObjId() {
            uint objectId = _selection.HoveredObjectId;
            if (objectId == 0) return 0;
            var ident = ClientMemory.TryGetPartIdentity(objectId, 0);
            return ident?.GfxObjId ?? 0;
        }

        /// <summary>
        /// GfxObj id -> status tint, for the "tint previously-annotated targets by status" mode.
        /// Reads the entries this install wrote and folds in whatever redline-status.jsonl says.
        /// </summary>
        /// <summary>
        /// Reconcile this account's stored annotations back to live draws for the in-world status
        /// tint. Reads the local queue + `redline-status.jsonl` (last-event-wins via StatusReader)
        /// and produces two id -> ARGB maps the DeviceHooks tint pass matches against, using the
        /// same correlation the highlight uses (current-physics-part GfxObj, curr_surface RS id):
        ///   * <paramref name="byGfxObj"/> — object annotations (and triangle annotations, tinted
        ///     at whole-GfxObj granularity — see the note) keyed by GfxObj id;
        ///   * <paramref name="byRenderSurface"/> — texture annotations keyed by RenderSurface id.
        /// Later entries win over earlier ones for the same target, so the freshest status shows.
        ///
        /// NOTE triangle annotations are tinted per whole GfxObj, not per triangle: the draw detour
        /// correlates a draw to its part/GfxObj, but re-issuing only the reported triangles would
        /// need per-fan index slicing in the hot path. Whole-object is the honest approximation and
        /// is documented as such.
        /// </summary>
        private void BuildStatusTints(out Dictionary<uint, uint> byGfxObj,
                                      out Dictionary<uint, uint> byRenderSurface) {
            byGfxObj = new Dictionary<uint, uint>();
            byRenderSurface = new Dictionary<uint, uint>();
            string? me = _authorProvider();

            foreach (var entry in _queue.ReadOwnEntries(max: 200)) {
                // "my reports" only — don't tint other accounts' annotations.
                if (me is not null && !string.Equals(entry.Author, me, StringComparison.Ordinal)) continue;

                var sel = entry.Selection;
                if (sel is null) continue;
                uint argb = HighlightState.ArgbForState(_status.StateFor(entry.Id));

                if (sel.Objects is not null)
                    foreach (var o in sel.Objects) {
                        uint gfx = Hex.Parse(o.GfxObjId);
                        if (gfx != 0) byGfxObj[gfx] = argb;
                    }

                uint triGfx = Hex.Parse(sel.Triangles?.GfxObjId);
                if (triGfx != 0) byGfxObj[triGfx] = argb;

                if (sel.RenderSurfaces is not null)
                    foreach (var rs in sel.RenderSurfaces) {
                        uint rsId = Hex.Parse(rs.RsId);
                        if (rsId != 0) byRenderSurface[rsId] = argb;
                    }
            }
        }

        /// <summary>
        /// End of the 3D pass: the client's selection cursor has resolved for this frame, so this
        /// is the correct moment to read a pending pick and to refresh the hover target.
        /// Signature is <c>EventHandler&lt;EventArgs&gt;</c> per IRenderer.OnAfterRender3D.
        /// </summary>
        private void HandleAfterRender3D(object? sender, EventArgs e) {
            try {
                _selection.CompletePendingPick();
                if (_settings.OverlayEnabled) _selection.RefreshHover();

                // Lasso: the draw detour captured the target's MVP this frame; resolve now.
                if (_hooks is not null && _selection.LassoResolvePending) {
                    uint tgt = _selection.PrepareLassoTarget();
                    if (tgt != 0 && _hooks.ConsumeLassoMvp(out var mvp, out int w, out int h)) {
                        _selection.ResolveLassoWithMvp(mvp, w, h, tgt);
                    }
                }

                // Texture-in-view collection window: tick it; fold the instances in when it closes.
                if (_hooks is not null) {
                    var collected = _hooks.TickTextureCollect(out uint collectedRs);
                    if (collected is not null) {
                        _selection.ApplyTextureInView(collectedRs, collected);
                    }
                }
            }
            catch (Exception ex) {
                _log.LogDebug(ex, "redline: overlay 3D tick failed");
            }
        }

        /// <summary>
        /// UI pass. Signature is <c>EventHandler&lt;EventArgs&gt;</c> per IRenderer.OnRenderUI.
        /// Everything drawn here goes onto <see cref="IRenderer.DrawList"/> in window pixels.
        /// </summary>
        private void HandleRenderUI(object? sender, EventArgs e) {
            if (!_settings.OverlayEnabled) return;
            var dl = _renderer?.DrawList;
            if (dl is null) return;

            try {
                DrawSelectionHighlight(dl);
                DrawLasso(dl);
                DrawHud(dl);
                if (_settings.StatusOverlayEnabled) DrawStatusChips(dl);
            }
            catch (Exception ex) {
                _log.LogDebug(ex, "redline: overlay UI tick failed");
            }
        }

        // ------------------------------------------------------------------

        /// <summary>
        /// Highlight the selected/hovered triangles and texture surfaces in the world.
        ///
        /// SUPERSEDED — the world-space highlight is NOT drawn here any more. It is done by
        /// <see cref="DeviceHooks"/>, which hooks the client's own IDirect3DDevice9 vtable and
        /// re-issues the matching draw as a tinted pass (the SkunkVision RenderHook method). That
        /// gives a depth-correct, lit, pixel-aligned highlight that the 2D
        /// <see cref="IDrawList"/> could never produce — it has no line, triangle or depth
        /// primitive at all (Chorizite.Core/Render/IDrawList.cs).
        ///
        /// What remains here is the 2D chrome that genuinely belongs in screen space: the HUD,
        /// the lasso trail and the status legend.
        /// </summary>
        private void DrawSelectionHighlight(IDrawList drawList) {
            // Intentionally empty: see DeviceHooks for the world-space highlight.
            _ = drawList;
        }

        /// <summary>Draw the in-progress lasso as a chain of small squares (no line primitive exists).</summary>
        private void DrawLasso(IDrawList drawList) {
            var pts = _selection.Current.LassoPoints;
            if (pts.Count < 2) return;
            for (int i = 0; i < pts.Count; i++) {
                var p = pts[i];
                drawList.DrawRectFilled(new Rectangle((int)p.X - 1, (int)p.Y - 1, 3, 3), ColLasso);
            }
        }

        /// <summary>Corner HUD summarising the live selection, so the user knows what submit will send.</summary>
        private void DrawHud(IDrawList drawList) {
            var sel = _selection.Current;
            if (sel.IsEmpty && _selection.HoveredObjectId == 0) return;

            var (vw, _) = ClientMemory.GetViewport();
            if (vw <= 0) vw = 1024;

            const int W = 260, H = 76, Pad = 8;
            int x = vw - W - 12, y = 12;

            drawList.DrawRectFilled(new Rectangle(x, y, W, H), ColPanelBg);
            drawList.DrawRect(new Rectangle(x, y, W, H), 1,
                sel.IsEmpty ? ColHover : ColSelected);

            var font = HudFont();
            if (font is null) return;

            string l1 = $"redline [{sel.Kind}]";
            string l2 = $"obj {sel.Objects.Count}  tex {sel.Surfaces.Count}  poly {sel.PickedPolygonKeys.Count}";
            string l3 = _selection.HoveredObjectId != 0
                ? $"hover {Hex.U32(_selection.HoveredObjectId)}"
                : "hover -";

            drawList.DrawText(font, l1, new Rectangle(x + Pad, y + Pad, W - Pad * 2, 18), ColText);
            drawList.DrawText(font, l2, new Rectangle(x + Pad, y + Pad + 20, W - Pad * 2, 18), ColText);
            drawList.DrawText(font, l3, new Rectangle(x + Pad, y + Pad + 40, W - Pad * 2, 18), ColText);
        }

        /// <summary>
        /// Status-tint mode: a legend of how many of the reporter's entries sit in each state.
        ///
        /// Tinting the annotated targets THEMSELVES is handled in the world by
        /// <see cref="DeviceHooks"/> — <see cref="BuildStatusTints"/> publishes a
        /// GfxObj-id -> ARGB map into <see cref="HighlightState"/> each frame, and the
        /// DrawIndexedPrimitive detour applies it. This legend is the screen-space companion,
        /// so the user can read the counts without hunting for tinted objects.
        /// </summary>
        private void DrawStatusChips(IDrawList drawList) {
            var counts = _status.CountsByState();
            if (counts.Count == 0) return;

            var font = HudFont();
            if (font is null) return;

            int x = 12, y = 12;
            foreach (var kv in counts) {
                var col = ColorForState(kv.Key);
                drawList.DrawRectFilled(new Rectangle(x, y, 10, 10), col);
                drawList.DrawText(font, $"{kv.Key} {kv.Value}", new Rectangle(x + 16, y - 3, 200, 16), ColText);
                y += 16;
            }
        }

        /// <summary>Map a pipeline status string to the overlay tint. Public so the UI can match it.</summary>
        public static ColorVec ColorForState(string? state) {
            if (string.IsNullOrEmpty(state)) return ColQueued;
            if (state == RedlineStatus.Fixed) return ColFixed;
            if (state == RedlineStatus.InProgress) return ColInProgress;
            return ColQueued;
        }

        /// <summary>Hex colour for the RmlUi panel, so HUD and panel agree.</summary>
        public static string CssForState(string? state) {
            var c = ColorForState(state);
            return $"#{(int)(c.R * 255):X2}{(int)(c.G * 255):X2}{(int)(c.B * 255):X2}";
        }

        /// <summary>Exposed for the panel's legend.</summary>
        public static IReadOnlyList<string> KnownStates =>
            [RedlineStatus.Queued, RedlineStatus.InProgress, RedlineStatus.Fixed];
    }
}
