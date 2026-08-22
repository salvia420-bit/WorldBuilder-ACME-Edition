using System;
using ACBindings.Internal;

namespace AcmeLights.Lib {
    /// <summary>
    /// Live reads out of the running client for the bloom pass: the D3D9 device pointer and the
    /// current 3D viewport rect + open-scene flag, straight off the render-device singleton.
    ///
    /// SOURCES (map-build-correct; see docs/lights-port/research-bloom-hook-point.md §3-4):
    ///   RenderDevice::render_device = (RenderDevice**)0x00870340  (ACBindings RenderDevice.cs)
    ///   RenderDeviceD3D::m_pDirect3DDevice at byte offset 1128 of the render device
    ///   m_viewportX/Y/Width/Height at offsets 140/144/148/152; m_bOpenScene at 172
    ///   m_pFrameBufferSurface at 180 (the client's own backbuffer RenderSurface wrapper)
    /// (The ACBindings RenderDevice struct exposes m_viewportWidth/Height + m_bOpenScene by name;
    /// we read them through it so the offsets stay correct with the binding.)
    /// </summary>
    public static unsafe class ClientState {
        public const int DevicePointerOffset = 1128;

        public static IntPtr GetDevicePointer() {
            try {
                RenderDevice** pp = RenderDevice.render_device;
                if (pp == null || *pp == null) return IntPtr.Zero;
                return *(IntPtr*)((byte*)(*pp) + DevicePointerOffset);
            }
            catch { return IntPtr.Zero; }
        }

        public readonly struct Viewport {
            public readonly int X, Y, W, H;
            public readonly bool OpenScene, Valid;
            public Viewport(int x, int y, int w, int h, bool open, bool valid) {
                X = x; Y = y; W = w; H = h; OpenScene = open; Valid = valid;
            }
        }

        public static Viewport GetViewport() {
            try {
                RenderDevice** pp = RenderDevice.render_device;
                if (pp == null || *pp == null) return default;
                RenderDevice* rd = *pp;
                int w = (int)rd->m_viewportWidth, h = (int)rd->m_viewportHeight;
                int x = (int)rd->m_viewportX, y = (int)rd->m_viewportY;
                bool open = rd->m_bOpenScene != 0;
                if (w <= 0 || h <= 0) return default;
                return new Viewport(x, y, w, h, open, true);
            }
            catch { return default; }
        }
    }
}
