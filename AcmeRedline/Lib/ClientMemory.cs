using System;
using ACBindings.Internal;

namespace AcmeRedline.Lib {
    /// <summary>
    /// The one place this plugin touches raw client memory.
    ///
    /// Everything here is a thin, checked read over the generated bindings in
    /// external/chorizite/ACBindings/Generated/. Those are hardcoded absolute addresses in
    /// the retail acclient.exe image, so:
    ///   * every entry point null-checks the owning global before dereferencing;
    ///   * anything that CALLS client code (as opposed to reading a global) must be
    ///     marshalled onto the game thread via IChoriziteBackend.Invoke - see
    ///     external/chorizite/Chorizite/Chorizite.Core/Backend/IChoriziteBackend.cs
    ///     ("Invoke an action on the main game thread").
    ///   * none of this is meaningful outside ChoriziteEnvironment.Client.
    ///
    /// Nothing here has been executed against a live client in this repo; the reads are
    /// transcribed from the bindings, not verified in-process. Treat a null return as
    /// "not available" rather than "not present in the world".
    /// </summary>
    public static unsafe class ClientMemory {

        /// <summary>A frame of camera state, already converted out of client structs.</summary>
        public readonly struct CameraPose {
            /// <summary>Cell/landblock id the camera frame is expressed in.</summary>
            public readonly uint CellId;
            /// <summary>Camera origin, cell-local.</summary>
            public readonly float X, Y, Z;
            /// <summary>Camera orientation quaternion, w-first.</summary>
            public readonly float Qw, Qx, Qy, Qz;
            /// <summary>Vertical field of view, degrees.</summary>
            public readonly float FovDeg;

            public CameraPose(uint cellId, float x, float y, float z,
                              float qw, float qx, float qy, float qz, float fovDeg) {
                CellId = cellId; X = x; Y = y; Z = z;
                Qw = qw; Qx = qx; Qy = qy; Qz = qz; FovDeg = fovDeg;
            }

            public float[] PosArray() => [X, Y, Z];
            public float[] QuatArray() => [Qw, Qx, Qy, Qz];

            /// <summary>
            /// Unit forward vector, derived from the quaternion (AC frames are right-handed,
            /// +x east / +y north / +z up, and the camera looks down local +y).
            /// </summary>
            public float[] ForwardArray() {
                // Rotate (0,1,0) by the quaternion.
                float w = Qw, x = Qx, y = Qy, z = Qz;
                float fx = 2f * (x * y - w * z);
                float fy = 1f - 2f * (x * x + z * z);
                float fz = 2f * (y * z + w * x);
                return [fx, fy, fz];
            }
        }

        /// <summary>A world frame for a physics object, already converted out of client structs.</summary>
        public readonly struct ObjectPose {
            public readonly uint CellId;
            public readonly float X, Y, Z;
            public readonly float Qw, Qx, Qy, Qz;
            /// <summary>Per-axis object scale (CPhysicsPart.gfxobj_scale). Defaults to 1 when unread.</summary>
            public readonly float Sx, Sy, Sz;

            public ObjectPose(uint cellId, float x, float y, float z,
                              float qw, float qx, float qy, float qz,
                              float sx = 1f, float sy = 1f, float sz = 1f) {
                CellId = cellId; X = x; Y = y; Z = z;
                Qw = qw; Qx = qx; Qy = qy; Qz = qz;
                Sx = sx; Sy = sy; Sz = sz;
            }

            public float[] PosArray() => [X, Y, Z];
            public float[] QuatArray() => [Qw, Qx, Qy, Qz];
            /// <summary>Object scale as a vector, for building model->world (not part of the schema).</summary>
            public System.Numerics.Vector3 ScaleVec() => new(Sx, Sy, Sz);

            /// <summary>Heading in degrees, 0 = north, derived from the yaw of the quaternion.</summary>
            public float HeadingDeg() {
                double yaw = Math.Atan2(2.0 * (Qw * Qz + Qx * Qy),
                                        1.0 - 2.0 * (Qy * Qy + Qz * Qz));
                double deg = yaw * 180.0 / Math.PI;
                if (deg < 0) deg += 360.0;
                return (float)deg;
            }
        }

        /// <summary>Result of one polygon-accurate selection probe.</summary>
        public readonly struct SelectionProbe {
            /// <summary>Runtime object guid under the cursor, 0 when nothing was hit.</summary>
            public readonly uint ObjectId;
            /// <summary>Part index within the object's CPartArray, from Render::GetMouseSelectionPartIndex.</summary>
            public readonly int PartIndex;
            /// <summary>
            /// True when the hit came from a polygon-accurate test rather than only the bounding sphere.
            ///
            /// IMPORTANT: this flag is precision, NOT a polygon id. The client does NOT record WHICH
            /// polygon was hit. Verified in the decomp: Render::GfxObjUnderSelectionRay
            /// (ac-headers/acclient.c:379997) walks mesh->polygons[] but, on a hit, stores only
            /// <c>get_physobj_id</c> (the OBJECT id) into MouseSelectData.PolygonID and
            /// <c>physobj_index</c> (the PART index) into MouseSelectData.PolygonIndex — the field
            /// names are misleading, they are object+part identifiers. So a polygon must come from
            /// our own object-space raycast; the client gives none.
            /// </summary>
            public readonly bool FoundPolygon;

            public SelectionProbe(uint objectId, int partIndex, bool foundPolygon) {
                ObjectId = objectId; PartIndex = partIndex; FoundPolygon = foundPolygon;
            }

            public bool IsHit => ObjectId != 0;
        }

        // ------------------------------------------------------------------
        // Camera
        // ------------------------------------------------------------------

        /// <summary>
        /// Read the live camera pose.
        /// Backing globals (ACBindings/Generated/Rendering/Render.cs):
        ///   Render.viewer_pos = (Position*)0x0081FF10   -> cell id + Frame (quat + origin)
        ///   Render.fov        = (float*)0x0081FC88      -> set by Render::SetFOVRad, so radians
        /// Position/Frame layout: ACBindings/Generated/Net/Types/Position.cs (objcell_id, frame)
        /// and ACBindings/Generated/Frame.cs (qw,qx,qy,qz, m_fl2gv[9], m_fOrigin).
        /// </summary>
        public static CameraPose? TryGetCameraPose() {
            try {
                Position* vp = Render.viewer_pos;
                if (vp == null) return null;

                float fovRad = Render.fov != null ? *Render.fov : 0f;
                float fovDeg = (float)(fovRad * 180.0 / Math.PI);

                Frame f = vp->frame;
                return new CameraPose(
                    vp->objcell_id,
                    f.m_fOrigin.BaseClass_Vector3.x,
                    f.m_fOrigin.BaseClass_Vector3.y,
                    f.m_fOrigin.BaseClass_Vector3.z,
                    f.qw, f.qx, f.qy, f.qz,
                    fovDeg);
            }
            catch (Exception) {
                // A bad address in a non-client process throws AccessViolation-adjacent
                // failures that are not always catchable; the try/catch is a best effort.
                return null;
            }
        }

        /// <summary>
        /// Read the player pose. Render.player_pos = (Position*)0x0081FF58
        /// (ACBindings/Generated/Rendering/Render.cs).
        /// </summary>
        public static ObjectPose? TryGetPlayerPose() {
            try {
                Position* pp = Render.player_pos;
                if (pp == null) return null;
                Frame f = pp->frame;
                return new ObjectPose(
                    pp->objcell_id,
                    f.m_fOrigin.BaseClass_Vector3.x,
                    f.m_fOrigin.BaseClass_Vector3.y,
                    f.m_fOrigin.BaseClass_Vector3.z,
                    f.qw, f.qx, f.qy, f.qz);
            }
            catch (Exception) {
                return null;
            }
        }

        /// <summary>
        /// Viewport size in pixels.
        /// RenderDevice.render_device = (RenderDevice**)0x00870340, then m_viewportWidth /
        /// m_viewportHeight (ACBindings/Generated/Rendering/RenderDevice.cs).
        /// Falls back to (0,0) when the device is not up yet.
        /// </summary>
        public static (int Width, int Height) GetViewport() {
            try {
                RenderDevice** ppDev = RenderDevice.render_device;
                if (ppDev == null || *ppDev == null) return (0, 0);
                RenderDevice* dev = *ppDev;
                return ((int)dev->m_viewportWidth, (int)dev->m_viewportHeight);
            }
            catch (Exception) {
                return (0, 0);
            }
        }

        // ------------------------------------------------------------------
        // Picking
        // ------------------------------------------------------------------

        /// <summary>
        /// Arm the client's own selection cursor at a screen pixel.
        /// Render::set_selection_cursor(int x, int y, bool fPolyAccurate) @0x0054C360
        /// (ACBindings/Generated/Rendering/Render.cs).
        ///
        /// MUST be called on the game thread (IChoriziteBackend.Invoke). The result is not
        /// available until the client has rendered a frame with the cursor armed - read it
        /// with <see cref="ReadSelectionProbe"/> from a later OnRender3D tick, not inline.
        /// </summary>
        public static void ArmSelectionCursor(int x, int y, bool polyAccurate = true) {
            Render.set_selection_cursor(x, y, polyAccurate ? (byte)1 : (byte)0);
        }

        /// <summary>Render::clear_selection_cursor @0x0054C3A0. Game thread only.</summary>
        public static void ClearSelectionCursor() {
            Render.clear_selection_cursor();
        }

        /// <summary>
        /// Read back whatever the armed selection cursor resolved to.
        ///   Render::GetMouseSelectionObjectID  @0x0054D560
        ///   Render::GetMouseSelectionPartIndex @0x0054D590
        ///   Render.m_MouseSelectData = (Render.MouseSelectData*)0x0086C1A0
        ///     -> bFoundPolygon flag only (its PolygonID/PolygonIndex fields are object+part ids,
        ///        not polygon ids — see SelectionProbe.FoundPolygon).
        /// Game thread only.
        /// </summary>
        public static SelectionProbe ReadSelectionProbe() {
            try {
                uint objectId = Render.GetMouseSelectionObjectID();
                int partIndex = Render.GetMouseSelectionPartIndex();

                bool foundPoly = false;
                Render.MouseSelectData* msd = Render.m_MouseSelectData;
                if (msd != null) {
                    foundPoly = msd->bFoundPolygon != 0;
                }

                return new SelectionProbe(objectId, partIndex, foundPoly);
            }
            catch (Exception) {
                return default;
            }
        }

        /// <summary>
        /// Screen pixel -> world-space ray direction.
        /// Render::pick_ray(Vector3* result, int x, int y) @0x0054C220
        /// (ACBindings/Generated/Rendering/Render.cs). Game thread only.
        /// The ray origin is the camera origin, i.e. <see cref="TryGetCameraPose"/>.
        /// </summary>
        public static float[]? PickRay(int x, int y) {
            try {
                ACBindings.Internal.AC1Legacy.Vector3 v = default;
                ACBindings.Internal.AC1Legacy.Vector3* r = Render.pick_ray(&v, x, y);
                if (r == null) return null;
                return [r->BaseClass_Vector3.x, r->BaseClass_Vector3.y, r->BaseClass_Vector3.z];
            }
            catch (Exception) {
                return null;
            }
        }

        // ------------------------------------------------------------------
        // Object -> dat identity
        // ------------------------------------------------------------------

        /// <summary>The dat identity of one rendered part of one runtime object.</summary>
        public readonly struct PartIdentity {
            /// <summary>Setup dat id (0x02......), or 0 when the object has no setup.</summary>
            public readonly uint SetupId;
            /// <summary>GfxObj dat id (0x01......) of the part actually being drawn at its current degrade level.</summary>
            public readonly uint GfxObjId;
            /// <summary>Surface (0x08......) dat ids referenced by that GfxObj, in polygon-surface-index order.</summary>
            public readonly uint[] SurfaceIds;
            /// <summary>Part's world frame.</summary>
            public readonly ObjectPose Pose;

            public PartIdentity(uint setupId, uint gfxObjId, uint[] surfaceIds, ObjectPose pose) {
                SetupId = setupId; GfxObjId = gfxObjId; SurfaceIds = surfaceIds; Pose = pose;
            }
        }

        /// <summary>
        /// Resolve a runtime object guid + part index to its dat identity.
        ///
        /// Chain, all from ACBindings/Generated:
        ///   CPhysicsObj.obj_maint = (CObjectMaint**)0x00844D64      Physics/CPhysicsObj.cs
        ///   CObjectMaint::GetObjectA(uint) @0x00508890              CObjectMaint.cs
        ///   CPhysicsObj.part_array                                  Physics/CPhysicsObj.cs
        ///   CPartArray::GetDataID(uint*) @0x005195F0  -> setup did  CPartArray.cs
        ///   CPartArray.parts[i] -> CPhysicsPart                     Physics/CPhysicsPart.cs
        ///   CPhysicsPart.gfxobj[deg_level] -> CGfxObj               Physics/CPhysicsPart.cs
        ///   CGfxObj.BaseClass_DBObj.m_DID.BaseClass_uint -> 0x01... Dats/DBObjs/CGfxObj.cs, Dats/DBObjs/DBObj.cs
        ///   CGfxObj.m_rgSurfaces[i] -> CSurface, its m_DID -> 0x08  Dats/DBObjs/CSurface.cs
        ///
        /// Game thread only (GetObjectA and GetDataID are real client calls).
        /// </summary>
        /// <param name="objectId">Runtime object guid.</param>
        /// <param name="partIndex">Part index, as returned by Render::GetMouseSelectionPartIndex.</param>
        public static PartIdentity? TryGetPartIdentity(uint objectId, int partIndex) {
            try {
                CObjectMaint** ppMaint = CPhysicsObj.obj_maint;
                if (ppMaint == null || *ppMaint == null) return null;

                CPhysicsObj* obj = (*ppMaint)->GetObjectA(objectId);
                if (obj == null) return null;

                CPartArray* pa = obj->part_array;
                if (pa == null) return null;

                uint setupId = 0;
                pa->GetDataID(&setupId);

                if (partIndex < 0 || (uint)partIndex >= pa->num_parts || pa->parts == null) {
                    return new PartIdentity(setupId, 0, [], default);
                }

                CPhysicsPart* part = pa->parts[partIndex];
                if (part == null) return new PartIdentity(setupId, 0, [], default);

                uint gfxObjId = 0;
                uint[] surfaceIds = [];

                if (part->gfxobj != null) {
                    CGfxObj* gfx = part->gfxobj[part->deg_level];
                    if (gfx != null) {
                        gfxObjId = gfx->BaseClass_DBObj.m_DID.BaseClass_uint;

                        uint n = gfx->num_surfaces;
                        if (gfx->m_rgSurfaces != null && n > 0 && n < 4096) {
                            surfaceIds = new uint[n];
                            for (uint i = 0; i < n; i++) {
                                CSurface* s = gfx->m_rgSurfaces[i];
                                surfaceIds[i] = s == null ? 0u : s->BaseClass_DBObj.m_DID.BaseClass_uint;
                            }
                        }
                    }
                }

                Frame f = part->pos.frame;
                // gfxobj_scale (CPhysicsPart.cs:30) is the per-axis object scale the client applies
                // when building model->world; needed for a faithful managed reprojection.
                var sc = part->gfxobj_scale;
                var pose = new ObjectPose(
                    part->pos.objcell_id,
                    f.m_fOrigin.BaseClass_Vector3.x,
                    f.m_fOrigin.BaseClass_Vector3.y,
                    f.m_fOrigin.BaseClass_Vector3.z,
                    f.qw, f.qx, f.qy, f.qz,
                    sc.BaseClass_Vector3.x, sc.BaseClass_Vector3.y, sc.BaseClass_Vector3.z);

                return new PartIdentity(setupId, gfxObjId, surfaceIds, pose);
            }
            catch (Exception) {
                return null;
            }
        }

        // ------------------------------------------------------------------
        // Screenshot
        // ------------------------------------------------------------------

        /// <summary>
        /// Ask the client to write a screenshot of the current frame.
        ///
        /// Device::SaveScreenshot @0x0043A780 - ACBindings/Generated/Input/Device.cs:218,
        /// declared there as <c>SaveScreenshot(int*)</c>. The real signature is
        /// <c>char __cdecl Device::SaveScreenshot(PStringBase&lt;char&gt;* o_strFileName)</c>
        /// (ac-headers/acclient.c, Device::SaveScreenshot). It grabs
        /// Device::GetScreenshotSurface(), writes
        /// <c>&lt;user-preferences-dir&gt;ScreenShot%05d.jpg</c> via RenderSurface::SaveJPG picking
        /// the first free index, and returns that path in the out PStringBase.
        ///
        /// TODO(acme-redline): marshal the out PStringBase. PStringBase&lt;char&gt; is a single
        /// refcounted char* (PSRefBufferCharData header sits at [ptr-4]); constructing one
        /// that the client will refcount correctly means calling into the client's own
        /// PStringBase machinery rather than handing it a bare buffer, and getting that wrong
        /// corrupts the client's heap. Until that is done this method is deliberately not
        /// wired up: <see cref="AcmeRedline.Services.CaptureService"/> calls it only through
        /// its guarded path and treats a null return as "no screenshot this time".
        /// Searched for a safe alternative in:
        ///   external/chorizite/Chorizite/Chorizite.Core/Render/{IRenderer,ITexture,IFramebuffer,IGraphicsDevice}.cs
        ///     - no pixel readback of any kind (no GetData/ReadPixels/Save)
        ///   external/chorizite/Chorizite/Chorizite.NativeClientBootstrapper/Render/DX9RenderInterface.cs
        ///   external/chorizite/Chorizite/Chorizite.NativeClientBootstrapper/Hooks/DirectXHooks.cs
        ///     - no screenshot surface exposed to managed code
        ///   external/chorizite/ACBindings/Generated (grep "Screenshot")
        ///     - only Device.GetScreenshotSurface / Device.SaveScreenshot, both raw.
        /// </summary>
        /// <returns>The path the client wrote, or null when the capture could not be made.</returns>
        public static string? TrySaveClientScreenshot() {
            // TODO(acme-redline): implement via Device.SaveScreenshot once PStringBase
            // marshalling is safe. See the remarks above for exactly what is missing.
            return null;
        }
    }
}
