using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using AcmeRedline.Lib;
using AcmeRedline.Model;
using Chorizite.Core.Backend;
using Chorizite.Core.Backend.Client;
using Chorizite.Core.Dats;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Types;
using Microsoft.Extensions.Logging;

namespace AcmeRedline.Services {

    /// <summary>What a click means, given the modifier keys held.</summary>
    [Flags]
    public enum PickModifiers {
        None = 0,
        /// <summary>Shift-click: add this texture to the current multi-selection instead of replacing it.</summary>
        Add = 1,
        /// <summary>Ctrl-click: remove this target from the selection.</summary>
        Remove = 2,
    }

    /// <summary>One picked object, with everything the pipeline needs to find it again.</summary>
    public sealed class PickedObject {
        public uint ObjectId;
        public uint SetupId;
        public uint GfxObjId;
        public ClientMemory.ObjectPose Pose;
    }

    /// <summary>One picked render surface, plus where on it the complaint lands.</summary>
    public sealed class PickedSurface {
        public uint RenderSurfaceId;
        public uint SurfaceId;
        public uint SurfaceTextureId;
        public List<(float U, float V)> UvHints = [];
    }

    /// <summary>The live, mutable selection the panel and the overlay both read.</summary>
    public sealed class SelectionSet {
        public string Kind = SelectionKind.Object;
        public readonly Dictionary<uint, PickedObject> Objects = [];
        /// <summary>Keyed by RenderSurface id so shift-click accumulates without duplicating.</summary>
        public readonly Dictionary<uint, PickedSurface> Surfaces = [];
        /// <summary>GfxObj the triangle selection belongs to. Triangle selection is single-mesh by construction.</summary>
        public uint TriangleGfxObjId;
        /// <summary>
        /// The picked SOURCE-POLYGON keys (DatReaderWriter <c>Polygons</c> keys, == positional
        /// record index on retail data). NOT the wire triangle-stream indices — those are derived
        /// at emit time by <see cref="SelectionService.BuildTrianglePayload"/>, which fan-expands
        /// each picked polygon into its triangles per the frozen schema convention.
        /// </summary>
        public readonly SortedSet<int> PickedPolygonKeys = [];
        public readonly List<(float X, float Y)> LassoPoints = [];
        public int LassoViewportW, LassoViewportH;

        public bool IsEmpty => Objects.Count == 0 && Surfaces.Count == 0 && PickedPolygonKeys.Count == 0;

        public void Clear() {
            Kind = SelectionKind.Object;
            Objects.Clear();
            Surfaces.Clear();
            TriangleGfxObjId = 0;
            PickedPolygonKeys.Clear();
            LassoPoints.Clear();
            LassoViewportW = LassoViewportH = 0;
        }
    }

    /// <summary>
    /// Turns "the user clicked / dragged over there" into a schema-v1 <see cref="Selection"/>.
    ///
    /// PICKING STRATEGY (see README "Picking strategy" for the long form):
    ///
    ///  1. OBJECT pick rides the client's OWN targeting/hover machinery rather than
    ///     re-implementing it. Two sources, both real:
    ///       - IClientBackend.SelectedObjectId + IClientBackend.OnObjectSelected
    ///         (external/chorizite/Chorizite/Chorizite.Core/Backend/Client/IClientBackend.cs)
    ///         for the click-selected object;
    ///       - Render::set_selection_cursor / GetMouseSelectionObjectID / GetMouseSelectionPartIndex
    ///         (external/chorizite/ACBindings/Generated/Rendering/Render.cs) for hover AND for the
    ///         object id + PART index. The client does NOT expose a polygon index — verified in the
    ///         decomp (ac-headers/acclient.c:379997 Render::GfxObjUnderSelectionRay stores only the
    ///         object id + part index on a hit), so the polygon must come from step 2.
    ///
    ///  2. TRIANGLE pick loads the part's GfxObj out of the dats through
    ///     IDatReaderInterface (external/chorizite/Chorizite/Chorizite.Core/Dats/IDatReaderInterface.cs)
    ///     and ray-casts in OBJECT space: the camera ray from Render::pick_ray is transformed
    ///     into the part's local frame with the inverse of the part quaternion, then tested
    ///     against every polygon with Moller-Trumbore. This runs entirely on managed data, so it
    ///     is testable offline, and it yields the barycentric coordinates the texture step needs.
    ///     It is the ONLY source of the picked polygon (the client provides none). The wire
    ///     triangle indices are then the fan-triangulated stream indices of the picked polygon(s)
    ///     over the whole record — see BuildFanStream / BuildTrianglePayload.
    ///
    ///  3. TEXTURE pick is the chain
    ///       polygon -> Polygon.PosSurface (index into GfxObj.Surfaces)
    ///               -> Surface       0x08
    ///               -> Surface.OrigTextureId  -> SurfaceTexture 0x05
    ///               -> SurfaceTexture.Textures[0] -> RenderSurface 0x06
    ///     plus the UV of the hit point, interpolated from the polygon's per-corner UVs with the
    ///     barycentric weights from step 2. The pipeline repaints RenderSurfaces, so rsId is the
    ///     load-bearing id; surfaceId/surfaceTextureId are carried so it can tell which of several
    ///     Surfaces routed to the same pixels.
    /// </summary>
    public sealed class SelectionService {
        private readonly IDatReaderInterface _dat;
        private readonly IClientBackend _client;
        private readonly IChoriziteBackend _backend;
        private readonly ILogger _log;

        /// <summary>The current selection. Mutated in place; listen to <see cref="OnChanged"/>.</summary>
        public SelectionSet Current { get; } = new();

        /// <summary>Object currently under the cursor, 0 when nothing is. Drives the hover highlight.</summary>
        public uint HoveredObjectId { get; private set; }

        /// <summary>Raised whenever <see cref="Current"/> or <see cref="HoveredObjectId"/> changed.</summary>
        public event EventHandler? OnChanged;

        // A pick is a two-step dance: arm the client's selection cursor this frame,
        // read what it resolved to on a later frame. See CompletePendingPick.
        private bool _pickPending;
        private int _pickX, _pickY;
        private PickModifiers _pickMods;
        private bool _lassoActive;

        // Lasso resolution is deferred to the render tick (needs the client's live MVP, captured by
        // DeviceHooks during the target object's draw). See ResolveLassoWithMvp.
        private bool _lassoResolvePending;
        private uint _lassoTargetGfx;

        /// <summary>True while a finished lasso still needs its triangles resolved on the render thread.</summary>
        public bool LassoResolvePending => _lassoResolvePending;

        /// <summary>Set (non-zero) when the user asked to select all in-view instances of an RS id.</summary>
        public uint PendingTextureInViewRs { get; private set; }

        /// <summary>Instances found by the last "all instances in view" collection, for HUD/panel.</summary>
        public int LastTextureInViewCount { get; private set; }

        public SelectionService(IDatReaderInterface dat, IClientBackend client, IChoriziteBackend backend, ILogger log) {
            _dat = dat;
            _client = client;
            _backend = backend;
            _log = log;
        }

        // ------------------------------------------------------------------
        // Entry points the UI / input layer calls
        // ------------------------------------------------------------------

        /// <summary>
        /// Begin a pick at a screen pixel. Arms the client's polygon-accurate selection cursor;
        /// the answer is read back by <see cref="CompletePendingPick"/> on a later render tick.
        /// </summary>
        public void PickAt(int screenX, int screenY, PickModifiers mods) {
            _pickX = screenX;
            _pickY = screenY;
            _pickMods = mods;
            _pickPending = true;
            _backend.Invoke(() => ClientMemory.ArmSelectionCursor(screenX, screenY, polyAccurate: true));
        }

        /// <summary>
        /// Read back an armed pick. Call from the render tick, on the game thread.
        /// No-op when nothing is pending.
        /// </summary>
        public void CompletePendingPick() {
            if (!_pickPending) return;
            _pickPending = false;

            var probe = ClientMemory.ReadSelectionProbe();
            if (!probe.IsHit) {
                if (_pickMods == PickModifiers.None) {
                    Current.Clear();
                    Raise();
                }
                return;
            }

            ApplyProbe(probe, _pickX, _pickY, _pickMods);
        }

        /// <summary>
        /// Update the hover highlight. Cheap enough to call on mouse-move; it only reads
        /// the client's already-resolved selection state, it does not arm a new probe.
        /// Game thread.
        /// </summary>
        public void RefreshHover() {
            uint id = ClientMemory.ReadSelectionProbe().ObjectId;
            if (id != HoveredObjectId) {
                HoveredObjectId = id;
                Raise();
            }
        }

        /// <summary>Adopt whatever the client itself has selected (IClientBackend.SelectedObjectId).</summary>
        public void AdoptClientSelection() {
            uint id = _client.SelectedObjectId;
            if (id == 0) return;
            var ident = ClientMemory.TryGetPartIdentity(id, 0);
            Current.Kind = SelectionKind.Object;
            Current.Objects[id] = new PickedObject {
                ObjectId = id,
                SetupId = ident?.SetupId ?? 0,
                GfxObjId = ident?.GfxObjId ?? 0,
                Pose = ident?.Pose ?? default,
            };
            Raise();
        }

        /// <summary>Start a screen-space lasso at a pixel. Subsequent moves append points.</summary>
        public void BeginLasso(int x, int y) {
            var (w, h) = ClientMemory.GetViewport();
            Current.LassoPoints.Clear();
            Current.LassoPoints.Add((x, y));
            Current.LassoViewportW = w;
            Current.LassoViewportH = h;
            _lassoActive = true;
            Raise();
        }

        /// <summary>Append a lasso point. Ignored when no lasso is active.</summary>
        public void AddLassoPoint(int x, int y) {
            if (!_lassoActive) return;
            var last = Current.LassoPoints[^1];
            // Cheap decimation: skip sub-pixel-ish moves so the polyline stays small in JSON.
            if (Math.Abs(last.X - x) < 2 && Math.Abs(last.Y - y) < 2) return;
            Current.LassoPoints.Add((x, y));
            Raise();
        }

        /// <summary>
        /// Close the lasso. The screen polygon is kept; its conversion to triangles is DEFERRED to
        /// the render tick (<see cref="ResolveLassoWithMvp"/>), which needs the client's live
        /// model·view·clip matrix — captured by DeviceHooks during the target object's own draw
        /// (Projection.ReadGState off <c>*render_device</c>-&gt;m_GState, verified feeds D3D as
        /// VIEW/PROJECTION; RenderDevice.cs:55-57 + ac-headers/acclient.c SetViewToClipMatrix).
        /// The lasso points + viewport are always emitted in <c>selection.screenLasso</c> too, so
        /// the gesture is never lost even if resolution finds no triangles.
        /// </summary>
        public void EndLasso() {
            _lassoActive = false;
            if (Current.LassoPoints.Count >= 3) {
                Current.Kind = SelectionKind.Triangles;
                _lassoResolvePending = true;
                _lassoTargetGfx = 0;   // resolved on the render thread by PrepareLassoTarget
            }
            Raise();
        }

        /// <summary>
        /// Resolve the GfxObj the lasso should cut triangles from. Render thread (does client
        /// calls). Preference: an existing triangle target, else the single selected object, else
        /// the object under the cursor. Idempotent; caches the answer.
        /// </summary>
        public uint PrepareLassoTarget() {
            if (_lassoTargetGfx != 0) return _lassoTargetGfx;

            if (Current.TriangleGfxObjId != 0) return _lassoTargetGfx = Current.TriangleGfxObjId;

            if (Current.Objects.Count == 1) {
                var only = Current.Objects.Values.First();
                if (only.GfxObjId != 0) return _lassoTargetGfx = only.GfxObjId;
            }
            if (HoveredObjectId != 0) {
                var id = ClientMemory.TryGetPartIdentity(HoveredObjectId, 0);
                if (id?.GfxObjId is uint g && g != 0) return _lassoTargetGfx = g;
            }
            return 0;
        }

        /// <summary>Abandon a pending lasso resolution (no target could be found).</summary>
        public void CancelLasso() {
            _lassoResolvePending = false;
            _lassoTargetGfx = 0;
            Raise();
        }

        /// <summary>
        /// Convert the finished lasso to a triangle selection using the client's captured
        /// model·view·clip matrix. A draw-triangle is selected when its model-local centroid, run
        /// through <paramref name="mvp"/> and the viewport, lands inside the lasso polygon; the
        /// triangle's SOURCE polygon key is added, so the emitted indices are the same
        /// fan-triangle-all-polys stream the click path and the pipeline use
        /// (<see cref="BuildFanStreamStatic"/>).
        ///
        /// The MVP already carries the target's own ModelToWorld (captured during its draw), so the
        /// dat's raw model-space vertices project correctly with no cell/landblock reconstruction.
        /// Render thread.
        /// </summary>
        public void ResolveLassoWithMvp(Matrix4x4 mvp, int vpW, int vpH, uint targetGfx) {
            _lassoResolvePending = false;
            _lassoTargetGfx = 0;

            if (targetGfx == 0 || vpW <= 0 || vpH <= 0 || Current.LassoPoints.Count < 3) { Raise(); return; }
            if (!_dat.TryGet<GfxObj>(targetGfx, out var gfx) || gfx is null) { Raise(); return; }

            var stream = BuildFanStreamStatic(gfx, out var keyToPos, _log);
            var posToKey = new Dictionary<int, ushort>(keyToPos.Count);
            foreach (var kv in keyToPos) posToKey[kv.Value] = kv.Key;

            var lasso = Current.LassoPoints;
            var pickedKeys = new HashSet<int>();

            foreach (var st in stream) {
                if (!TryVertex(gfx, st.V0, out var a) ||
                    !TryVertex(gfx, st.V1, out var b) ||
                    !TryVertex(gfx, st.V2, out var c)) {
                    continue;
                }
                Vector3 local = (a.Origin + b.Origin + c.Origin) / 3f;
                var clip = Vector4.Transform(new Vector4(local, 1f), mvp);
                if (clip.W <= 1e-5f) continue;               // behind the eye
                float sx = (clip.X / clip.W * 0.5f + 0.5f) * vpW;
                float sy = (0.5f - clip.Y / clip.W * 0.5f) * vpH;
                if (PointInPolygon(lasso, sx, sy) && posToKey.TryGetValue(st.PolyPos, out var key)) {
                    pickedKeys.Add(key);
                }
            }

            if (pickedKeys.Count > 0) {
                Current.TriangleGfxObjId = targetGfx;
                foreach (var k in pickedKeys) Current.PickedPolygonKeys.Add(k);
                Current.Kind = SelectionKind.Triangles;
                _log.LogDebug("redline: lasso -> {N} source polygons on 0x{Gfx:X8}", pickedKeys.Count, targetGfx);
            }
            else {
                _log.LogDebug("redline: lasso hit no triangles on 0x{Gfx:X8}", targetGfx);
            }
            Raise();
        }

        /// <summary>Even-odd point-in-polygon test in screen pixels.</summary>
        private static bool PointInPolygon(IReadOnlyList<(float X, float Y)> poly, float px, float py) {
            bool inside = false;
            int n = poly.Count;
            for (int i = 0, j = n - 1; i < n; j = i++) {
                var pi = poly[i];
                var pj = poly[j];
                if (((pi.Y > py) != (pj.Y > py)) &&
                    (px < (pj.X - pi.X) * (py - pi.Y) / (pj.Y - pi.Y) + pi.X)) {
                    inside = !inside;
                }
            }
            return inside;
        }

        /// <summary>
        /// Record the instances found by an "all instances in view" collection (raw GfxObj ids that
        /// bound the target RS this frame window). We don't add them as schema <c>objects</c> —
        /// those require a runtime object GUID the collector doesn't have — the texture selection is
        /// already expressed by the RS id, which the pipeline fixes once for every instance. This
        /// just surfaces the count and keeps the RS selected so the tint covers them all.
        /// </summary>
        public void ApplyTextureInView(uint targetRs, uint[] instanceGfxObjIds) {
            LastTextureInViewCount = instanceGfxObjIds.Length;
            if (targetRs != 0 && !Current.Surfaces.ContainsKey(targetRs)) {
                // Keep whatever surface/texture ids the seed pick already resolved, if present.
                Current.Surfaces[targetRs] = new PickedSurface { RenderSurfaceId = targetRs };
            }
            Current.Kind = SelectionKind.Texture;
            _log.LogInformation("redline: texture 0x{Rs:X8} appears on {N} GfxObj(s) in view",
                targetRs, instanceGfxObjIds.Length);
            Raise();
        }

        /// <summary>Clear a satisfied texture-in-view request.</summary>
        public void ClearTextureInViewRequest() => PendingTextureInViewRs = 0;

        /// <summary>
        /// "Select all instances of this texture in view."
        ///
        /// This does NOT try to walk the client's loaded-object table (CObjectMaint.object_table is
        /// a LongHash with no managed iterator — ACBindings/Generated/CObjectMaint.cs:66). Instead
        /// it rides the frame we are already rendering: the RS id is selected immediately, so the
        /// DeviceHooks tint pass lights up EVERY draw that binds it this frame (across all
        /// instances, automatically), and a request is raised for the OverlayRenderer to arm the
        /// DeviceHooks frame-collector, which records the distinct GfxObjs carrying the texture for
        /// the panel's instance count. The map from a bound texture back to the RS id is the same
        /// one the tint uses: Render::curr_surface -&gt; ImgTex::GetSurfaceDID (DeviceHooks
        /// CurrentRenderSurfaceId), not a texture-cache walk.
        /// </summary>
        public void SelectAllInstancesOfTexture(uint renderSurfaceId) {
            if (renderSurfaceId == 0) return;
            Current.Kind = SelectionKind.Texture;
            if (!Current.Surfaces.ContainsKey(renderSurfaceId)) {
                Current.Surfaces[renderSurfaceId] = new PickedSurface { RenderSurfaceId = renderSurfaceId };
            }
            PendingTextureInViewRs = renderSurfaceId;   // OverlayRenderer arms the collector
            Raise();
        }

        /// <summary>Drop everything.</summary>
        public void Clear() {
            Current.Clear();
            _lassoActive = false;
            _lassoResolvePending = false;
            _lassoTargetGfx = 0;
            PendingTextureInViewRs = 0;
            LastTextureInViewCount = 0;
            Raise();
        }

        // ------------------------------------------------------------------
        // Probe -> selection
        // ------------------------------------------------------------------

        private void ApplyProbe(ClientMemory.SelectionProbe probe, int screenX, int screenY, PickModifiers mods) {
            var ident = ClientMemory.TryGetPartIdentity(probe.ObjectId, probe.PartIndex);
            if (ident is null) {
                _log.LogDebug("redline: hit object 0x{Id:X8} but could not resolve its dat identity", probe.ObjectId);
                return;
            }
            var id = ident.Value;

            if (mods == PickModifiers.None) {
                Current.Clear();
            }

            Current.Objects[probe.ObjectId] = new PickedObject {
                ObjectId = probe.ObjectId,
                SetupId = id.SetupId,
                GfxObjId = id.GfxObjId,
                Pose = id.Pose,
            };

            // Resolve the polygon. The client does NOT expose which polygon was hit
            // (probe.FoundPolygon is a precision flag only — see ClientMemory.SelectionProbe), so
            // the polygon comes solely from our own object-space raycast. When that fails we keep
            // the object-level selection and simply have no triangle/texture detail this pick.
            int polyIndex = -1;
            (float U, float V)? uv = null;

            var hit = RaycastObjectSpace(id, screenX, screenY);
            if (hit is not null) {
                polyIndex = hit.Value.PolygonIndex;
                uv = (hit.Value.U, hit.Value.V);
            }

            if (polyIndex >= 0) {
                Current.TriangleGfxObjId = id.GfxObjId;
                if ((mods & PickModifiers.Remove) != 0) {
                    Current.PickedPolygonKeys.Remove(polyIndex);
                }
                else {
                    Current.PickedPolygonKeys.Add(polyIndex);
                }

                var chain = ResolveSurfaceChain(id.GfxObjId, polyIndex);
                if (chain is not null) {
                    var c = chain.Value;
                    if ((mods & PickModifiers.Remove) != 0) {
                        Current.Surfaces.Remove(c.RenderSurfaceId);
                    }
                    else {
                        if (!Current.Surfaces.TryGetValue(c.RenderSurfaceId, out var ps)) {
                            ps = new PickedSurface {
                                RenderSurfaceId = c.RenderSurfaceId,
                                SurfaceId = c.SurfaceId,
                                SurfaceTextureId = c.SurfaceTextureId,
                            };
                            Current.Surfaces[c.RenderSurfaceId] = ps;
                        }
                        if (uv is not null) ps.UvHints.Add(uv.Value);
                    }
                }
            }

            // Kind follows what the user actually accumulated. Shift-clicking textures gives
            // "texture"; a lasso or a bare polygon pick gives "triangles"; neither gives "object".
            Current.Kind =
                Current.Surfaces.Count > 0 && Current.PickedPolygonKeys.Count <= 1 ? SelectionKind.Texture
                : Current.PickedPolygonKeys.Count > 0 ? SelectionKind.Triangles
                : SelectionKind.Object;

            Raise();
        }

        // ------------------------------------------------------------------
        // Object-space raycast
        // ------------------------------------------------------------------

        /// <summary>A polygon hit, with the interpolated texture coordinate at the hit point.</summary>
        public readonly struct MeshHit {
            public readonly int PolygonIndex;
            public readonly float U, V;
            public readonly Vector3 LocalPoint;
            public MeshHit(int polygonIndex, float u, float v, Vector3 localPoint) {
                PolygonIndex = polygonIndex; U = u; V = v; LocalPoint = localPoint;
            }
        }

        /// <summary>
        /// Cast the camera ray for a screen pixel against the part's GfxObj, in the part's local
        /// frame. Returns the nearest polygon hit, or null.
        /// </summary>
        private MeshHit? RaycastObjectSpace(ClientMemory.PartIdentity id, int screenX, int screenY) {
            if (id.GfxObjId == 0) return null;

            var cam = ClientMemory.TryGetCameraPose();
            var dir = ClientMemory.PickRay(screenX, screenY);
            if (cam is null || dir is null) return null;

            if (!_dat.TryGet<GfxObj>(id.GfxObjId, out var gfx) || gfx is null) return null;

            // World -> part-local: subtract the part origin, then rotate by the conjugate
            // of the part quaternion. Part frames in AC carry no scale, so no inverse-scale term.
            var q = new Quaternion(id.Pose.Qx, id.Pose.Qy, id.Pose.Qz, id.Pose.Qw);
            var qInv = Quaternion.Conjugate(q);

            var camWorld = new Vector3(cam.Value.X, cam.Value.Y, cam.Value.Z);
            var partWorld = new Vector3(id.Pose.X, id.Pose.Y, id.Pose.Z);

            // NOTE: camera and part frames are only directly comparable when they share a cell.
            // TODO(acme-redline): cross-cell picking needs Position::determine_quadrant /
            // Frame::localtoglobal (ACBindings/Generated/Frame.cs:83) to rebase the camera into the
            // part's cell. Guarded here rather than silently producing garbage geometry.
            if (cam.Value.CellId != id.Pose.CellId && id.Pose.CellId != 0) return null;

            var origin = Vector3.Transform(camWorld - partWorld, qInv);
            var direction = Vector3.Normalize(Vector3.Transform(new Vector3(dir[0], dir[1], dir[2]), qInv));

            return RaycastGfxObj(gfx, origin, direction);
        }

        /// <summary>
        /// Pure-managed ray/mesh test against a GfxObj's render polygons. Object-local space.
        /// Public and side-effect free so it can be unit-tested against a real portal.dat.
        /// </summary>
        public static MeshHit? RaycastGfxObj(GfxObj gfx, Vector3 origin, Vector3 direction) {
            if (gfx.VertexArray?.Vertices is null) return null;

            float bestT = float.MaxValue;
            MeshHit? best = null;

            foreach (var kv in gfx.Polygons) {
                var poly = kv.Value;
                var ids = poly.VertexIds;
                if (ids is null || ids.Count < 3) continue;

                // Fan-triangulate the n-gon, matching how the client draws it.
                for (int t = 1; t + 1 < ids.Count; t++) {
                    if (!TryVertex(gfx, ids[0], out var v0)) break;
                    if (!TryVertex(gfx, ids[t], out var v1)) continue;
                    if (!TryVertex(gfx, ids[t + 1], out var v2)) continue;

                    if (!RayTriangle(origin, direction, v0.Origin, v1.Origin, v2.Origin,
                                     out float dist, out float bu, out float bv)) continue;
                    if (dist >= bestT) continue;

                    bestT = dist;
                    var uv = InterpolateUv(gfx, poly, 0, t, t + 1, bu, bv);
                    best = new MeshHit(kv.Key, uv.U, uv.V, origin + direction * dist);
                }
            }

            return best;
        }

        private static bool TryVertex(GfxObj gfx, short id, out SWVertex vertex) {
            vertex = null!;
            if (id < 0) return false;
            return gfx.VertexArray.Vertices.TryGetValue((ushort)id, out vertex!) && vertex is not null;
        }

        /// <summary>
        /// Moller-Trumbore. <paramref name="bu"/>/<paramref name="bv"/> are the barycentric weights
        /// of v1 and v2 (v0's weight is 1-bu-bv).
        /// </summary>
        public static bool RayTriangle(Vector3 origin, Vector3 dir,
                                       Vector3 v0, Vector3 v1, Vector3 v2,
                                       out float t, out float bu, out float bv) {
            const float Eps = 1e-6f;
            t = bu = bv = 0f;

            var e1 = v1 - v0;
            var e2 = v2 - v0;
            var p = Vector3.Cross(dir, e2);
            float det = Vector3.Dot(e1, p);
            if (det > -Eps && det < Eps) return false;

            float invDet = 1f / det;
            var tv = origin - v0;
            bu = Vector3.Dot(tv, p) * invDet;
            if (bu < 0f || bu > 1f) return false;

            var qv = Vector3.Cross(tv, e1);
            bv = Vector3.Dot(dir, qv) * invDet;
            if (bv < 0f || bu + bv > 1f) return false;

            t = Vector3.Dot(e2, qv) * invDet;
            return t > Eps;
        }

        /// <summary>
        /// Interpolate the polygon's per-corner UVs at a barycentric point.
        /// Polygon.PosUVIndices selects, per corner, which of that vertex's UV pairs applies
        /// (a vertex shared between differently-mapped polygons carries several).
        /// </summary>
        private static (float U, float V) InterpolateUv(GfxObj gfx, Polygon poly,
                                                        int c0, int c1, int c2,
                                                        float bu, float bv) {
            var a = CornerUv(gfx, poly, c0);
            var b = CornerUv(gfx, poly, c1);
            var c = CornerUv(gfx, poly, c2);
            float w0 = 1f - bu - bv;
            return (w0 * a.U + bu * b.U + bv * c.U,
                    w0 * a.V + bu * b.V + bv * c.V);
        }

        private static (float U, float V) CornerUv(GfxObj gfx, Polygon poly, int corner) {
            if (poly.VertexIds is null || corner >= poly.VertexIds.Count) return (0f, 0f);
            if (!TryVertex(gfx, poly.VertexIds[corner], out var v)) return (0f, 0f);
            if (v.UVs is null || v.UVs.Count == 0) return (0f, 0f);

            int uvIdx = 0;
            if (poly.PosUVIndices is not null && corner < poly.PosUVIndices.Count) {
                uvIdx = poly.PosUVIndices[corner];
            }
            if (uvIdx < 0 || uvIdx >= v.UVs.Count) uvIdx = 0;
            return (v.UVs[uvIdx].U, v.UVs[uvIdx].V);
        }

        // ------------------------------------------------------------------
        // Texture chain: polygon -> Surface 0x08 -> SurfaceTexture 0x05 -> RenderSurface 0x06
        // ------------------------------------------------------------------

        /// <summary>One resolved texture chain.</summary>
        public readonly struct SurfaceChain {
            public readonly uint SurfaceId, SurfaceTextureId, RenderSurfaceId;
            public SurfaceChain(uint surfaceId, uint surfaceTextureId, uint renderSurfaceId) {
                SurfaceId = surfaceId; SurfaceTextureId = surfaceTextureId; RenderSurfaceId = renderSurfaceId;
            }
        }

        /// <summary>Resolve the texture chain for one polygon of one GfxObj.</summary>
        public SurfaceChain? ResolveSurfaceChain(uint gfxObjId, int polygonIndex) {
            if (!_dat.TryGet<GfxObj>(gfxObjId, out var gfx) || gfx is null) return null;
            if (polygonIndex < 0 || polygonIndex > ushort.MaxValue) return null;
            if (!gfx.Polygons.TryGetValue((ushort)polygonIndex, out var poly)) return null;

            int surfIdx = poly.PosSurface;
            if (surfIdx < 0 || surfIdx >= gfx.Surfaces.Count) return null;

            return ResolveFromSurfaceId(gfx.Surfaces[surfIdx]);
        }

        /// <summary>Every texture chain a GfxObj can reach. Used by "select all instances".</summary>
        public IEnumerable<SurfaceChain> EnumerateSurfaceChains(uint gfxObjId) {
            if (!_dat.TryGet<GfxObj>(gfxObjId, out var gfx) || gfx is null) yield break;
            foreach (var sref in gfx.Surfaces) {
                var chain = ResolveFromSurfaceId(sref);
                if (chain is not null) yield return chain.Value;
            }
        }

        private SurfaceChain? ResolveFromSurfaceId(uint surfaceId) {
            if (surfaceId == 0) return null;
            if (!_dat.TryGet<Surface>(surfaceId, out var surface) || surface is null) return null;

            uint stId = surface.OrigTextureId;
            if (stId == 0) {
                // A colour-only Surface (SurfaceType with no texture). Still worth reporting -
                // the pipeline can act on ColorValue - so emit the chain with a null texture leg.
                return new SurfaceChain(surfaceId, 0, 0);
            }

            if (!_dat.TryGet<SurfaceTexture>(stId, out var st) || st is null) {
                return new SurfaceChain(surfaceId, stId, 0);
            }

            // SurfaceTexture.Textures is the mip/variant list; index 0 is the one the client
            // uses at full detail (DatReaderWriter Generated/DBObjs/SurfaceTexture.generated.cs).
            uint rsId = st.Textures.Count > 0 ? st.Textures[0] : 0;
            return new SurfaceChain(surfaceId, stId, rsId);
        }

        // ------------------------------------------------------------------
        // Payload
        // ------------------------------------------------------------------

        /// <summary>
        /// Build the schema-v1 <see cref="Selection"/> block for the current selection.
        /// Never returns null; a selection with nothing in it still produces a well-formed
        /// "object"-kind block so the queue line stays parseable.
        ///
        /// Every emitted sub-object is filtered to what schema_v1.json actually accepts
        /// (<c>additionalProperties:false</c> throughout): an object needs a real 0x01 gfxObjId,
        /// a renderSurface needs a real 0x06 rsId, and the triangles block is only attached when it
        /// has a gfxObjId AND non-empty indices. Anything that would fail validation is dropped
        /// rather than emitted as a null the pipeline would reject.
        /// </summary>
        public Selection BuildSelectionPayload() {
            var sel = new Selection { Kind = Current.Kind };

            foreach (var o in Current.Objects.Values) {
                // schema: objects[] require objectId (0x..) AND gfxObjId (0x01..). No gfx id -> drop.
                if (o.ObjectId == 0 || o.GfxObjId == 0) continue;
                sel.Objects.Add(new SelectedObject {
                    ObjectId = Hex.U32(o.ObjectId),
                    SetupId = o.SetupId == 0 ? null : Hex.U32(o.SetupId),
                    GfxObjId = Hex.U32(o.GfxObjId),
                    WorldFrame = new WorldFrame {
                        Pos = o.Pose.PosArray(),
                        Quat = o.Pose.QuatArray(),
                    },
                });
            }

            foreach (var s in Current.Surfaces.Values) {
                // schema: renderSurfaces[] require rsId (0x06..). No rs id -> drop.
                if (s.RenderSurfaceId == 0) continue;
                sel.RenderSurfaces.Add(new SelectedRenderSurface {
                    RsId = Hex.U32(s.RenderSurfaceId),
                    SurfaceId = s.SurfaceId == 0 ? null : Hex.U32(s.SurfaceId),
                    SurfaceTextureId = s.SurfaceTextureId == 0 ? null : Hex.U32(s.SurfaceTextureId),
                    UvHints = s.UvHints.Select(uv => new[] { uv.U, uv.V }).ToList(),
                });
            }

            if (Current.PickedPolygonKeys.Count > 0 && Current.TriangleGfxObjId != 0) {
                var tri = BuildTrianglePayload();
                // schema: triangles requires gfxObjId + indices. Only attach a usable block.
                if (tri.GfxObjId is not null && tri.Indices.Count > 0) sel.Triangles = tri;
            }

            if (Current.LassoPoints.Count > 0) {
                sel.ScreenLasso = new ScreenLasso {
                    Points = Current.LassoPoints.Select(p => new[] { p.X, p.Y }).ToList(),
                    Viewport = [Current.LassoViewportW, Current.LassoViewportH],
                };
            }

            return sel;
        }

        /// <summary>
        /// One triangle of the fan-triangulated draw stream: its source polygon's positional
        /// record index, and the three vertex ids <c>(v[0], v[k], v[k+1])</c>.
        /// </summary>
        private readonly struct StreamTri {
            public readonly int PolyPos;
            public readonly short V0, V1, V2;
            public StreamTri(int polyPos, short v0, short v1, short v2) {
                PolyPos = polyPos; V0 = v0; V1 = v1; V2 = v2;
            }
        }

        /// <summary>
        /// Build the record's fan-triangulated draw-triangle stream, THE contract the pipeline
        /// resolves indices against (docs/redline/SCHEMA.md §2, tools/dat-patch/redline/queue_worker.py
        /// <c>_tri_stream</c>). Rules, all verified — see README "SCHEMA — triangle index convention":
        ///
        ///  * over EVERY polygon in the record, in record (positional) order — NOT drawn-only.
        ///    Stippled / NoPos-filler polygons (<c>Stippling &amp; 0x4</c>) stay IN the stream so an
        ///    index is a stable address into the record.
        ///  * polygon <c>pi</c> contributes <c>len(v) - 2</c> triangles, emitted as
        ///    <c>(v[0], v[k], v[k+1])</c> for <c>k = 1 … n-2</c>.
        ///
        /// Record order: the client stores polygons as a positional array
        /// (<c>CGfxObj::polygons[0..num_polygons-1]</c> — ac-headers/acclient.c
        /// Render::GfxObjUnderSelectionRay iterates exactly that array), and DatReaderWriter
        /// exposes them as dense contiguous <c>Polygons</c> keys <c>0..n-1</c> that enumerate in
        /// that same order (verified empirically on 0x01000827 / 0x0100004B / 0x01000001). This
        /// method enumerates in DatReaderWriter's natural order and uses the enumeration POSITION
        /// as <c>pi</c>, which is byte-faithful whether or not the keys happen to be dense; the
        /// returned key→pos map lets the caller translate a picked polygon key.
        /// </summary>
        private static List<StreamTri> BuildFanStreamStatic(GfxObj gfx, out Dictionary<ushort, int> keyToPos, ILogger? log) {
            var stream = new List<StreamTri>();
            keyToPos = new Dictionary<ushort, int>(gfx.Polygons.Count);

            int pos = 0;
            bool nonDense = false;
            foreach (var kv in gfx.Polygons) {   // insertion order == record byte order (verified)
                keyToPos[kv.Key] = pos;
                if (kv.Key != pos) nonDense = true;

                var ids = kv.Value.VertexIds;
                if (ids is not null && ids.Count >= 3) {
                    for (int k = 1; k + 1 < ids.Count; k++) {
                        stream.Add(new StreamTri(pos, ids[0], ids[k], ids[k + 1]));
                    }
                }
                pos++;
            }

            if (nonDense) {
                // Never observed on retail portal.dat. If it ever happens, positional order (used
                // above) is still the byte-faithful match to the pipeline; the key≠pos gap only
                // affects how a picked polygon KEY maps in, which keyToPos handles. Logged so a
                // real occurrence is visible rather than silent.
                log?.LogWarning("redline: GfxObj 0x{Id:X8} has non-dense polygon keys; " +
                                "triangle-stream indices use positional record order", gfx.Id);
            }
            return stream;
        }

        /// <summary>
        /// Triangle block. <c>indices</c> are into the fan-triangulated draw-triangle stream over
        /// EVERY polygon in record order (see <see cref="BuildFanStreamStatic"/> and the README) — NOT
        /// polygon indices. The MANDATORY footprint is per-selected-TRIANGLE (centroid + unit
        /// normal, model-local): raw indices go stale when the pipeline reships a rebuilt mesh, so
        /// the worker relocates by nearest current triangle centroid (SCHEMA.md §2).
        ///
        /// NOTE the schema's <c>triangles</c> object is <c>additionalProperties:false</c> and
        /// permits only {gfxObjId, indices, footprint, baseRecordSha256}. The convention is
        /// therefore carried by MATCHING it exactly, not by an in-entry <c>indexBasis</c> field
        /// (which would fail validation) — the worker independently reports triCountAll /
        /// triCountDrawn and flags any off-by-N drift. See the report / README for this decision.
        /// </summary>
        private TriangleSelection BuildTrianglePayload() {
            var tri = new TriangleSelection {
                GfxObjId = Current.TriangleGfxObjId == 0 ? null : Hex.U32(Current.TriangleGfxObjId),
                Indices = [],
                BaseRecordSha256 = ComputeRecordSha(Current.TriangleGfxObjId),
                Footprint = null,
            };

            if (Current.TriangleGfxObjId == 0) return tri;
            if (!_dat.TryGet<GfxObj>(Current.TriangleGfxObjId, out var gfx) || gfx is null) return tri;

            var (indices, fp) = BuildFanTrianglePayload(gfx, Current.PickedPolygonKeys, _log);
            if (indices.Count == 0) return tri;

            tri.Indices = indices;
            tri.Footprint = fp;
            return tri;
        }

        /// <summary>
        /// The pure, dat-only core of the triangle payload: given a parsed GfxObj and the picked
        /// source-polygon keys, return the fan-triangulated draw-stream indices (schema convention,
        /// see <see cref="BuildFanStreamStatic"/>) plus the per-selected-triangle footprint.
        ///
        /// Public and static so a self-test harness exercises the SAME code the plugin ships
        /// (AcmeRedline/samples), and so it can be unit-tested against a real portal.dat. It does
        /// NOT compute <c>baseRecordSha256</c> — that needs the raw record bytes, which the caller
        /// has (via DatDatabase.TryGetFileBytes).
        /// </summary>
        public static (List<int> Indices, TriangleFootprint Footprint) BuildFanTrianglePayload(
                GfxObj gfx, IEnumerable<int> pickedPolygonKeys, ILogger? log = null) {
            var stream = BuildFanStreamStatic(gfx, out var keyToPos, log);

            var pickedPos = new HashSet<int>();
            foreach (int key in pickedPolygonKeys) {
                if (key >= 0 && key <= ushort.MaxValue && keyToPos.TryGetValue((ushort)key, out int p)) {
                    pickedPos.Add(p);
                }
            }

            var fp = new TriangleFootprint();
            var indices = new List<int>();
            if (pickedPos.Count == 0) return (indices, fp);

            float area = 0f;
            for (int t = 0; t < stream.Count; t++) {
                var st = stream[t];
                if (!pickedPos.Contains(st.PolyPos)) continue;
                if (!TryVertex(gfx, st.V0, out var a) ||
                    !TryVertex(gfx, st.V1, out var b) ||
                    !TryVertex(gfx, st.V2, out var c)) {
                    continue;
                }

                indices.Add(t);

                Vector3 pa = a.Origin, pb = b.Origin, pc = c.Origin;
                fp.Centroids.Add(ToArray((pa + pb + pc) / 3f));

                Vector3 n = Vector3.Cross(pb - pa, pc - pa);
                float len = n.Length();
                area += len * 0.5f;                        // |cross| / 2 is exactly the triangle area
                fp.Normals.Add(len > 1e-9f ? ToArray(n / len) : [0f, 0f, 0f]);
            }

            indices.Sort();
            fp.AreaM2 = area;
            return (indices, fp);
        }

        /// <summary>
        /// SHA-256 of the raw dat record bytes for a GfxObj, so the pipeline can tell whether the
        /// mesh it is holding is the mesh the reporter was looking at.
        /// Uses DatDatabase.TryGetFileBytes (external/DatReaderWriter/DatReaderWriter/DatDatabase.cs:141),
        /// reached through IDatReaderInterface.Portal.
        /// </summary>
        private string? ComputeRecordSha(uint gfxObjId) {
            if (gfxObjId == 0) return null;
            try {
                if (!_dat.Portal.TryGetFileBytes(gfxObjId, out var bytes) || bytes is null) return null;
                return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            }
            catch (Exception ex) {
                _log.LogDebug(ex, "redline: could not hash GfxObj 0x{Id:X8} record bytes", gfxObjId);
                return null;
            }
        }

        private static float[] ToArray(Vector3 v) => [v.X, v.Y, v.Z];

        private void Raise() => OnChanged?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>Hex id formatting, matching the "0x........" convention the schema uses.</summary>
    public static class Hex {
        public static string U32(uint value) => "0x" + value.ToString("X8");

        /// <summary>Parse "0x0600ABCD" / "0600ABCD". Returns 0 on anything unparseable.</summary>
        public static uint Parse(string? s) {
            if (string.IsNullOrWhiteSpace(s)) return 0;
            var t = s.Trim();
            if (t.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) t = t[2..];
            return uint.TryParse(t, System.Globalization.NumberStyles.HexNumber,
                                 System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : 0u;
        }
    }
}
