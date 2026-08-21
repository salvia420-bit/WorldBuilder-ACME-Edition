using System;
using System.Numerics;
using ACBindings.Internal;
// ACBindings.Internal also defines Vector2/3/4; all projection maths here is System.Numerics.
using Vector3 = System.Numerics.Vector3;
using Matrix4x4 = System.Numerics.Matrix4x4;

namespace AcmeSky.Lib {
    /// <summary>
    /// Live reads out of the running client: the D3D9 device pointer, the frame's camera matrices
    /// and viewport, the current time-of-day, and the weather flag. Everything here is a plain
    /// memory read of a client global -- safe to call from inside the GameSky::Draw detour on the
    /// render thread, which is exactly where SkyRenderer uses it.
    ///
    /// SOURCES (all verified against ACBindings/Generated, cross-referenced to the decomp):
    ///   RenderDevice::render_device      = (RenderDevice**)0x00870340   (RenderDevice.cs:9)
    ///     m_GState.WorldToViewMatrix / ViewToClipMatrix / ModelToWorldMatrix  (RenderDevice.cs:55-57)
    ///     m_viewportWidth / m_viewportHeight                                   (RenderDevice.cs:101-102)
    ///   RenderDeviceD3D::m_pDirect3DDevice at byte offset 1128 of the render device
    ///     (AcmeRedline DeviceHooks; Chorizite DirectXHooks hardcodes the same 1128).
    ///   GameTime::current_game_time      = (GameTime**)0x008EE9C8         (GameTime.cs:9)
    ///     present_time_in_day_unit (float, 0..1 day fraction; decomp acclient.c:463274 sets it as
    ///     (t-begin)/(day_length-begin))                                    (GameTime.cs:24)
    ///   GameSky::s_weatherEnabled        = (byte*)0x0081DD3C              (GameSky.cs)
    ///
    /// The matrices are AC's fixed-function D3D transforms: row-major, row-vector multiply
    /// (clip = worldPt . WorldToView . ViewToClip), identical layout to Matrix4x4. This mirrors
    /// AcmeRedline/Lib/Projection.cs, which documents the same wiring.
    /// </summary>
    public static unsafe class ClientState {

        /// <summary>Byte offset of RenderDeviceD3D::m_pDirect3DDevice (PDB offset = 1128).</summary>
        public const int DevicePointerOffset = 1128;

        /// <summary>Read the live IDirect3DDevice9* out of the render-device singleton, or Zero.</summary>
        public static IntPtr GetDevicePointer() {
            try {
                RenderDevice** pp = RenderDevice.render_device;
                if (pp == null || *pp == null) return IntPtr.Zero;
                return *(IntPtr*)((byte*)(*pp) + DevicePointerOffset);
            }
            catch (Exception) { return IntPtr.Zero; }
        }

        /// <summary>A self-consistent snapshot of the camera for one frame.</summary>
        public readonly struct Camera {
            public readonly Matrix4x4 WorldToView;
            public readonly Matrix4x4 ViewToClip;
            public readonly Vector3 WorldPos;
            public readonly int ViewportW, ViewportH;
            public readonly bool Valid;
            public Camera(Matrix4x4 wv, Matrix4x4 vc, Vector3 pos, int w, int h, bool valid) {
                WorldToView = wv; ViewToClip = vc; WorldPos = pos; ViewportW = w; ViewportH = h; Valid = valid;
            }
        }

        /// <summary>Read the frame's camera matrices, viewport, and derived camera world position.</summary>
        public static Camera GetCamera() {
            try {
                RenderDevice** pp = RenderDevice.render_device;
                if (pp == null || *pp == null) return default;
                RenderDevice* rd = *pp;
                int w = (int)rd->m_viewportWidth;
                int h = (int)rd->m_viewportHeight;
                if (w <= 0 || h <= 0) return default;

                Matrix4x4 wv = ToNumerics(&rd->m_GState.WorldToViewMatrix);
                Matrix4x4 vc = ToNumerics(&rd->m_GState.ViewToClipMatrix);

                // Camera world position = translation of the inverse view matrix (view-origin -> world).
                Vector3 camPos = Vector3.Zero;
                if (Matrix4x4.Invert(wv, out var viewToWorld)) camPos = viewToWorld.Translation;

                return new Camera(wv, vc, camPos, w, h, valid: true);
            }
            catch (Exception) { return default; }
        }

        /// <summary>Current time of day as a 0..1 fraction (0/1 = deep night, ~0.5 = noon), or -1.</summary>
        public static float GetTimeOfDay() {
            try {
                GameTime** pp = GameTime.current_game_time;
                if (pp == null || *pp == null) return -1f;
                float t = (*pp)->present_time_in_day_unit;
                if (float.IsNaN(t) || float.IsInfinity(t)) return -1f;
                // Guard against odd values; wrap into [0,1).
                t %= 1f;
                if (t < 0f) t += 1f;
                return t;
            }
            catch (Exception) { return -1f; }
        }

        /// <summary>True when the client's weather system is active (GameSky::s_weatherEnabled).</summary>
        public static bool IsWeatherEnabled() {
            try {
                byte* p = GameSky.s_weatherEnabled;
                return p != null && *p != 0;
            }
            catch (Exception) { return false; }
        }

        private static Matrix4x4 ToNumerics(Matrix4* m) => new(
            m->_11, m->_12, m->_13, m->_14,
            m->_21, m->_22, m->_23, m->_24,
            m->_31, m->_32, m->_33, m->_34,
            m->_41, m->_42, m->_43, m->_44);
    }
}
