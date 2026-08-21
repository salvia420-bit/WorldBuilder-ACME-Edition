using System;
using System.Numerics;

namespace AcmeSky.Lib {
    /// <summary>
    /// A thin typed wrapper over a raw IDirect3DDevice9* that calls fixed-function methods through
    /// the COM vtable with unmanaged function pointers -- the same technique AcmeRedline's tint pass
    /// uses (Services/DeviceHooks.BeginTintState), no SharpDX marshalling on the hot path.
    ///
    /// Function pointers are resolved per call from the live vtable rather than cached, so the
    /// wrapper stays correct across a device Reset (the vtable is rebuilt but the device pointer
    /// often survives; when it does not, SkyRenderer re-reads the pointer -- see its Reset notes).
    /// The per-call cost is two pointer dereferences, negligible for the few dozen sky draws a frame.
    ///
    /// A D3DMATRIX is a row-major 4x4 of floats with the identical memory layout to
    /// System.Numerics.Matrix4x4 (M11..M44 row-major), so a Matrix4x4* is passed straight through
    /// as a const D3DMATRIX*.
    /// </summary>
    public readonly unsafe struct Device {
        public readonly IntPtr Ptr;
        public Device(IntPtr ptr) { Ptr = ptr; }
        public bool IsValid => Ptr != IntPtr.Zero;

        // ---- transforms ----
        public void SetTransform(int state, in Matrix4x4 m) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, int, void*, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.SetTransform);
            if (fn == null) return;
            fixed (Matrix4x4* pm = &m) fn(Ptr, state, pm);
        }

        public Matrix4x4 GetTransform(int state) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, int, void*, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.GetTransform);
            Matrix4x4 m = Matrix4x4.Identity;
            if (fn != null) fn(Ptr, state, &m);
            return m;
        }

        // ---- render state ----
        public void SetRenderState(int state, uint value) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, int, uint, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.SetRenderState);
            if (fn != null) fn(Ptr, state, value);
        }

        public uint GetRenderState(int state) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, int, uint*, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.GetRenderState);
            uint v = 0;
            if (fn != null) fn(Ptr, state, &v);
            return v;
        }

        // ---- texture-stage state ----
        public void SetTextureStageState(uint stage, int type, uint value) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, uint, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.SetTextureStageState);
            if (fn != null) fn(Ptr, stage, type, value);
        }

        public uint GetTextureStageState(uint stage, int type) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, uint*, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.GetTextureStageState);
            uint v = 0;
            if (fn != null) fn(Ptr, stage, type, &v);
            return v;
        }

        // ---- sampler state ----
        public void SetSamplerState(uint stage, int type, uint value) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, uint, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.SetSamplerState);
            if (fn != null) fn(Ptr, stage, type, value);
        }

        public uint GetSamplerState(uint stage, int type) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, uint*, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.GetSamplerState);
            uint v = 0;
            if (fn != null) fn(Ptr, stage, type, &v);
            return v;
        }

        // ---- textures ----
        public void SetTexture(uint stage, IntPtr texture) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.SetTexture);
            if (fn != null) fn(Ptr, stage, texture);
        }

        public IntPtr GetTexture(uint stage) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr*, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.GetTexture);
            IntPtr t = IntPtr.Zero;
            if (fn != null) fn(Ptr, stage, &t);
            return t;
        }

        // ---- FVF ----
        public void SetFVF(uint fvf) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.SetFVF);
            if (fn != null) fn(Ptr, fvf);
        }

        public uint GetFVF() {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint*, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.GetFVF);
            uint v = 0;
            if (fn != null) fn(Ptr, &v);
            return v;
        }

        // ---- draw ----
        public int DrawPrimitiveUP(int primType, uint primCount, void* vertexData, uint stride) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, int, uint, void*, uint, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.DrawPrimitiveUP);
            return fn == null ? -1 : fn(Ptr, primType, primCount, vertexData, stride);
        }

        // ---- resource creation ----
        /// <summary>
        /// IDirect3DDevice9::CreateTexture (vtable slot 23):
        ///   HRESULT CreateTexture(UINT Width, UINT Height, UINT Levels, DWORD Usage,
        ///                         D3DFORMAT Format, D3DPOOL Pool,
        ///                         IDirect3DTexture9** ppTexture, HANDLE* pSharedHandle);
        /// Returns the new IDirect3DTexture9* or Zero on failure. Levels=1, Usage=0.
        /// </summary>
        public IntPtr CreateTexture(uint width, uint height, int format, int pool) {
            var fn = (delegate* unmanaged[Stdcall]
                <IntPtr, uint, uint, uint, uint, int, int, IntPtr*, IntPtr*, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.CreateTexture);
            if (fn == null) return IntPtr.Zero;
            IntPtr tex = IntPtr.Zero;
            int hr = fn(Ptr, width, height, 1u, 0u, format, pool, &tex, null);
            return hr >= 0 ? tex : IntPtr.Zero;
        }

        /// <summary>
        /// IDirect3DDevice9::CreateTexture (vtable slot 23) with explicit Levels + Usage -- used for
        /// the LIVE compositor's D3DUSAGE_DYNAMIC upload texture (Levels=1, Usage=D3DUSAGE_DYNAMIC,
        /// Format=D3DFMT_A8R8G8B8, Pool=D3DPOOL_DEFAULT). Returns the new IDirect3DTexture9* or Zero.
        /// </summary>
        public IntPtr CreateTexture(uint width, uint height, uint levels, uint usage, int format, int pool) {
            var fn = (delegate* unmanaged[Stdcall]
                <IntPtr, uint, uint, uint, uint, int, int, IntPtr*, IntPtr*, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.Slot.CreateTexture);
            if (fn == null) return IntPtr.Zero;
            IntPtr tex = IntPtr.Zero;
            int hr = fn(Ptr, width, height, levels, usage, format, pool, &tex, null);
            return hr >= 0 ? tex : IntPtr.Zero;
        }
    }

    /// <summary>
    /// A thin typed wrapper over a raw IDirect3DTexture9*, calling LockRect/UnlockRect/Release through
    /// the COM vtable exactly like <see cref="Device"/> does for the device. Used by the LIVE
    /// compositor to stream the D3D11 readback pixels into a D3DUSAGE_DYNAMIC texture each frame.
    ///
    /// VTABLE SLOTS (see <see cref="D3D9.TexSlot"/>), derived from the d3d9.h inheritance chain
    /// IDirect3DTexture9 : IDirect3DBaseTexture9 : IDirect3DResource9 : IUnknown:
    ///   IUnknown            : QueryInterface(0) AddRef(1) Release(2)
    ///   IDirect3DResource9  : GetDevice(3) SetPrivateData(4) GetPrivateData(5) FreePrivateData(6)
    ///                         SetPriority(7) GetPriority(8) PreLoad(9) GetType(10)
    ///   IDirect3DBaseTexture9: SetLOD(11) GetLOD(12) GetLevelCount(13) SetAutoGenFilterType(14)
    ///                         GetAutoGenFilterType(15) GenerateMipSubLevels(16)
    ///   IDirect3DTexture9   : GetLevelDesc(17) GetSurfaceLevel(18) LockRect(19) UnlockRect(20)
    ///                         AddDirtyRect(21)
    /// => Release=2, LockRect=19, UnlockRect=20.
    /// </summary>
    public readonly unsafe struct Texture9 {
        public readonly IntPtr Ptr;
        public Texture9(IntPtr ptr) { Ptr = ptr; }
        public bool IsValid => Ptr != IntPtr.Zero;

        /// <summary>
        /// IDirect3DTexture9::LockRect(UINT Level, D3DLOCKED_RECT* pLockedRect, const RECT* pRect,
        /// DWORD Flags). Locks the whole level (pRect=null). Returns false on failure.
        /// </summary>
        public bool LockRect(uint level, out D3DLockedRect locked, uint flags) {
            locked = default;
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, D3DLockedRect*, void*, uint, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.TexSlot.LockRect);
            if (fn == null) return false;
            D3DLockedRect lr;
            int hr = fn(Ptr, level, &lr, null, flags);
            if (hr < 0) return false;
            locked = lr;
            return true;
        }

        /// <summary>IDirect3DTexture9::UnlockRect(UINT Level).</summary>
        public void UnlockRect(uint level) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.TexSlot.UnlockRect);
            if (fn != null) fn(Ptr, level);
        }

        /// <summary>IUnknown::Release. Returns the new refcount.</summary>
        public uint Release() {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint>)
                D3D9.GetVTableEntry(Ptr, D3D9.TexSlot.Release);
            return fn == null ? 0u : fn(Ptr);
        }
    }

    /// <summary>D3DLOCKED_RECT { INT Pitch; void* pBits; }.</summary>
    public unsafe struct D3DLockedRect {
        public int Pitch;
        public void* pBits;
    }
}
