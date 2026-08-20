using System;
using System.Numerics;
using ACBindings.Internal;
// ACBindings.Internal also defines Vector2/3/4; the projection maths is all System.Numerics.
using Vector2 = System.Numerics.Vector2;
using Vector3 = System.Numerics.Vector3;
using Vector4 = System.Numerics.Vector4;
using Quaternion = System.Numerics.Quaternion;
using Matrix4x4 = System.Numerics.Matrix4x4;

namespace AcmeRedline.Lib {
    /// <summary>
    /// World-space -> screen-pixel projection, read from the client's live view/projection state.
    ///
    /// SOURCE (verified, not assumed). The client keeps its transforms in
    /// <c>RenderDevice::m_GState</c> (a <c>GraphicsStatesType</c> at RenderDevice.cs:116 of
    /// external/chorizite/ACBindings/Generated/Rendering/RenderDevice.cs), whose members are:
    ///   ModelToWorldMatrix, WorldToViewMatrix, ViewToClipMatrix  (RenderDevice.cs:55-57).
    /// These ARE the matrices D3D renders with: <c>RenderDeviceD3D::SetViewToClipMatrix</c>
    /// (ac-headers/acclient.c) does <c>qmemcpy(&amp;this->m_GState.ViewToClipMatrix, _m)</c> and
    /// then calls the device's SetTransform with state <c>3</c> (D3DTS_PROJECTION); the sibling
    /// setters push WorldToView as D3DTS_VIEW(2) and ModelToWorld as D3DTS_WORLD(256). So a point
    /// transformed by these lands exactly where the player sees it. The singleton is
    /// <c>RenderDevice::render_device = (RenderDevice**)0x00870340</c>; the viewport is
    /// <c>m_viewportWidth/Height</c> on the same struct (RenderDevice.cs:101-102).
    ///
    /// CONVENTION. AC is fixed-function D3D9: row-major matrices, row-vector multiply
    /// (clip = [x y z 1] · WorldToView · ViewToClip), left-handed clip with NDC z in [0,1] and
    /// y-down screen. <c>Matrix4</c> stores _11.._44 row-major, which maps 1:1 onto
    /// System.Numerics.Matrix4x4 (also row-major, also row-vector for <c>Vector4.Transform</c>).
    ///
    /// WHAT IS NOT LIVE-VALIDATED. The matrices, their D3D wiring, the row-major layout and the
    /// viewport source are all cited above. The remaining pieces — the screen y-flip and the NDC
    /// half-range mapping — are the fixed D3D9 conventions the client feeds unchanged into D3D, so
    /// they are implemented to that standard; they have not been eyeballed against a running client
    /// (this repo cannot run one). <see cref="TrySelfCheck"/> exists to sanity-check at runtime.
    /// </summary>
    public static unsafe class Projection {

        /// <summary>A captured, self-consistent snapshot of the projection for one frame.</summary>
        public readonly struct Frame {
            /// <summary>WorldToView · ViewToClip, ready for a row-vector world point.</summary>
            public readonly Matrix4x4 ViewProj;
            public readonly int ViewportW, ViewportH;
            public readonly bool Valid;

            public Frame(Matrix4x4 viewProj, int w, int h, bool valid) {
                ViewProj = viewProj; ViewportW = w; ViewportH = h; Valid = valid;
            }

            /// <summary>
            /// Project a world point to screen pixels. Returns false when the point is behind the
            /// camera (clip w &lt;= 0) or the snapshot is invalid.
            /// </summary>
            public bool TryWorldToScreen(Vector3 world, out Vector2 screen) {
                screen = default;
                if (!Valid) return false;
                var clip = Vector4.Transform(new Vector4(world, 1f), ViewProj);
                if (clip.W <= 1e-5f) return false;                    // behind the eye / on the plane
                float ndcX = clip.X / clip.W;
                float ndcY = clip.Y / clip.W;
                screen = new Vector2(
                    (ndcX * 0.5f + 0.5f) * ViewportW,
                    (0.5f - ndcY * 0.5f) * ViewportH);               // D3D screen is y-down
                return true;
            }
        }

        /// <summary>
        /// Read the live view/projection + viewport from <c>*render_device</c>. Game thread.
        /// Returns an invalid <see cref="Frame"/> when the device is not up.
        /// </summary>
        public static Frame Capture() {
            try {
                RenderDevice** pp = RenderDevice.render_device;
                if (pp == null || *pp == null) return default;
                RenderDevice* rd = *pp;

                int w = (int)rd->m_viewportWidth;
                int h = (int)rd->m_viewportHeight;
                if (w <= 0 || h <= 0) return default;

                Matrix4x4 wv = ToNumerics(&rd->m_GState.WorldToViewMatrix);
                Matrix4x4 vc = ToNumerics(&rd->m_GState.ViewToClipMatrix);

                // Row-vector: v · WorldToView · ViewToClip == v · (WorldToView * ViewToClip).
                return new Frame(wv * vc, w, h, valid: true);
            }
            catch (Exception) {
                return default;
            }
        }

        /// <summary>
        /// Read the full model/view/clip triple + viewport from <c>*render_device</c>.
        ///
        /// This is meant to be called from INSIDE the DeviceHooks draw detour, during the target
        /// object's own DrawIndexedPrimitive — at that instant m_GState.ModelToWorldMatrix is the
        /// client's own model->world for that exact draw, in the client's own render space, so an
        /// MVP built from all three is unambiguous (no landblock/cell reconstruction needed). Game
        /// thread only. Returns false when the device is not up.
        /// </summary>
        public static bool ReadGState(out Matrix4x4 modelToWorld, out Matrix4x4 worldToView,
                                      out Matrix4x4 viewToClip, out int vpW, out int vpH) {
            modelToWorld = worldToView = viewToClip = Matrix4x4.Identity;
            vpW = vpH = 0;
            try {
                RenderDevice** pp = RenderDevice.render_device;
                if (pp == null || *pp == null) return false;
                RenderDevice* rd = *pp;
                vpW = (int)rd->m_viewportWidth;
                vpH = (int)rd->m_viewportHeight;
                if (vpW <= 0 || vpH <= 0) return false;
                modelToWorld = ToNumerics(&rd->m_GState.ModelToWorldMatrix);
                worldToView = ToNumerics(&rd->m_GState.WorldToViewMatrix);
                viewToClip = ToNumerics(&rd->m_GState.ViewToClipMatrix);
                return true;
            }
            catch (Exception) {
                return false;
            }
        }

        /// <summary>Copy a client <c>Matrix4</c> (row-major _11.._44) into a System.Numerics matrix.</summary>
        private static Matrix4x4 ToNumerics(Matrix4* m) => new(
            m->_11, m->_12, m->_13, m->_14,
            m->_21, m->_22, m->_23, m->_24,
            m->_31, m->_32, m->_33, m->_34,
            m->_41, m->_42, m->_43, m->_44);

        /// <summary>
        /// Build the model->world transform for an object placed at <paramref name="origin"/> with
        /// rotation quaternion <paramref name="quatWxyz"/> (AC stores w first) and per-axis
        /// <paramref name="scale"/>. Row-vector: worldPt = localPt · (Scale · Rot · Translate).
        ///
        /// This reconstructs what the client itself loads into m_GState.ModelToWorldMatrix for the
        /// draw (Frame::cache_local2global builds the same S·R·T from the part's Position). Reading
        /// m_GState.ModelToWorldMatrix directly would only be correct DURING that part's draw; a
        /// managed post-frame lasso rebuilds it from the part pose instead.
        /// </summary>
        public static Matrix4x4 ModelToWorld(Vector3 origin, Vector4 quatWxyz, Vector3 scale) {
            var q = new Quaternion(quatWxyz.Y, quatWxyz.Z, quatWxyz.W, quatWxyz.X); // (x,y,z,w)
            return Matrix4x4.CreateScale(scale)
                 * Matrix4x4.CreateFromQuaternion(q)
                 * Matrix4x4.CreateTranslation(origin);
        }

        /// <summary>
        /// Cheap runtime sanity check: the player's own world position should project near the
        /// centre-ish of the screen and in front of the camera. Returns true when a capture is
        /// valid and the player projects on-screen. Purely diagnostic; the HUD can surface it.
        /// </summary>
        public static bool TrySelfCheck(out string detail) {
            detail = "no device";
            var f = Capture();
            if (!f.Valid) return false;
            var p = ClientMemory.TryGetPlayerPose();
            if (p is null) { detail = "no player pose"; return false; }
            var pose = p.Value;
            // A point a little above the player's feet.
            var world = new Vector3(pose.X, pose.Y, pose.Z + 1.0f);
            if (!f.TryWorldToScreen(world, out var s)) { detail = "player behind camera"; return false; }
            bool onScreen = s.X >= 0 && s.X < f.ViewportW && s.Y >= 0 && s.Y < f.ViewportH;
            detail = $"player -> ({s.X:F0},{s.Y:F0}) vp {f.ViewportW}x{f.ViewportH} onScreen={onScreen}";
            return onScreen;
        }
    }
}
