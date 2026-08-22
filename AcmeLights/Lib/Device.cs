using System;

namespace AcmeLights.Lib {
    /// <summary>
    /// Thin typed wrapper over the client's live IDirect3DDevice9*, calling methods through the COM
    /// vtable with unmanaged function pointers (same technique as AcmeSky/Lib/Device.cs). Function
    /// pointers are resolved per call so the wrapper stays correct across a device Reset. Only the
    /// methods AcmeLights' bloom pass needs are exposed.
    /// </summary>
    public readonly unsafe struct Device {
        public readonly IntPtr Ptr;
        public Device(IntPtr ptr) { Ptr = ptr; }
        public bool IsValid => Ptr != IntPtr.Zero;

        private IntPtr V(int slot) => D3D9.GetVTableEntry(Ptr, slot);

        public void SetRenderState(int state, uint value) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, int, uint, int>)V(D3D9.Slot.SetRenderState);
            if (fn != null) fn(Ptr, state, value);
        }
        public uint GetRenderState(int state) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, int, uint*, int>)V(D3D9.Slot.GetRenderState);
            uint v = 0; if (fn != null) fn(Ptr, state, &v); return v;
        }
        public void SetSamplerState(uint stage, int type, uint value) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, uint, int>)V(D3D9.Slot.SetSamplerState);
            if (fn != null) fn(Ptr, stage, type, value);
        }
        public void SetTextureStageState(uint stage, int type, uint value) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, uint, int>)V(D3D9.Slot.SetTextureStageState);
            if (fn != null) fn(Ptr, stage, type, value);
        }
        public void SetTexture(uint stage, IntPtr texture) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr, int>)V(D3D9.Slot.SetTexture);
            if (fn != null) fn(Ptr, stage, texture);
        }
        public void SetFVF(uint fvf) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int>)V(D3D9.Slot.SetFVF);
            if (fn != null) fn(Ptr, fvf);
        }
        public int DrawPrimitiveUP(int primType, uint primCount, void* vertexData, uint stride) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, int, uint, void*, uint, int>)V(D3D9.Slot.DrawPrimitiveUP);
            return fn == null ? -1 : fn(Ptr, primType, primCount, vertexData, stride);
        }

        // ---- render targets / surfaces ----
        public IntPtr GetRenderTarget(uint index) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr*, int>)V(D3D9.Slot.GetRenderTarget);
            IntPtr s = IntPtr.Zero; if (fn != null) fn(Ptr, index, &s); return s;
        }
        public int SetRenderTarget(uint index, IntPtr surface) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr, int>)V(D3D9.Slot.SetRenderTarget);
            return fn == null ? -1 : fn(Ptr, index, surface);
        }
        public IntPtr GetDepthStencilSurface() {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, IntPtr*, int>)V(D3D9.Slot.GetDepthStencilSurface);
            IntPtr s = IntPtr.Zero; if (fn != null) fn(Ptr, &s); return s;
        }
        public int SetDepthStencilSurface(IntPtr surface) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)V(D3D9.Slot.SetDepthStencilSurface);
            return fn == null ? -1 : fn(Ptr, surface);
        }
        public int StretchRect(IntPtr src, Rect* srcRect, IntPtr dst, Rect* dstRect, int filter) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, IntPtr, Rect*, IntPtr, Rect*, int, int>)V(D3D9.Slot.StretchRect);
            return fn == null ? -1 : fn(Ptr, src, srcRect, dst, dstRect, filter);
        }
        /// <summary>Copy a render-target surface to a SYSTEMMEM surface (legal outside a scene).</summary>
        public int GetRenderTargetData(IntPtr srcRt, IntPtr dstSysmem) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, IntPtr, IntPtr, int>)V(D3D9.Slot.GetRenderTargetData);
            return fn == null ? -1 : fn(Ptr, srcRt, dstSysmem);
        }
        public IntPtr CreateOffscreenPlainSurface(uint w, uint h, int format, int pool) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, uint, int, int, IntPtr*, IntPtr*, int>)
                V(D3D9.Slot.CreateOffscreenPlainSurface);
            if (fn == null) return IntPtr.Zero;
            IntPtr s = IntPtr.Zero;
            return fn(Ptr, w, h, format, pool, &s, null) >= 0 ? s : IntPtr.Zero;
        }

        // ---- viewport ----
        public D3DViewport9 GetViewport() {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, D3DViewport9*, int>)V(D3D9.Slot.GetViewport);
            D3DViewport9 vp = default; if (fn != null) fn(Ptr, &vp); return vp;
        }
        public void SetViewport(in D3DViewport9 vp) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, D3DViewport9*, int>)V(D3D9.Slot.SetViewport);
            if (fn != null) fixed (D3DViewport9* p = &vp) fn(Ptr, p);
        }

        // ---- state block (D3DSBT_ALL=1 captures current state at creation) ----
        public IntPtr CreateStateBlock(int type) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, int, IntPtr*, int>)V(D3D9.Slot.CreateStateBlock);
            if (fn == null) return IntPtr.Zero;
            IntPtr sb = IntPtr.Zero;
            return fn(Ptr, type, &sb) >= 0 ? sb : IntPtr.Zero;
        }
        /// <summary>IDirect3DStateBlock9::Apply (vtable slot 5).</summary>
        public static void StateBlockApply(IntPtr sb) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, int>)D3D9.GetVTableEntry(sb, 5);
            if (fn != null) fn(sb);
        }

        // ---- resource creation ----
        public IntPtr CreateTexture(uint w, uint h, uint levels, uint usage, int format, int pool) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, uint, uint, uint, int, int, IntPtr*, IntPtr*, int>)
                V(D3D9.Slot.CreateTexture);
            if (fn == null) return IntPtr.Zero;
            IntPtr tex = IntPtr.Zero;
            return fn(Ptr, w, h, levels, usage, format, pool, &tex, null) >= 0 ? tex : IntPtr.Zero;
        }
        public IntPtr CreateOffscreenSystemMemTexture(uint w, uint h, int format) =>
            CreateTexture(w, h, 1u, D3D9.Usage.None, format, D3D9.Pool.SystemMem);

        // ---- shaders ----
        public IntPtr CreatePixelShader(byte[] byteCode) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, byte*, IntPtr*, int>)V(D3D9.Slot.CreatePixelShader);
            if (fn == null) return IntPtr.Zero;
            IntPtr sh = IntPtr.Zero;
            fixed (byte* p = byteCode) { if (fn(Ptr, p, &sh) < 0) return IntPtr.Zero; }
            return sh;
        }
        public void SetPixelShader(IntPtr shader) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)V(D3D9.Slot.SetPixelShader);
            if (fn != null) fn(Ptr, shader);
        }
        public void SetPixelShaderConstantF(uint startReg, float* data, uint vec4Count) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, float*, uint, int>)V(D3D9.Slot.SetPixelShaderConstantF);
            if (fn != null) fn(Ptr, startReg, data, vec4Count);
        }
        public void SetVertexShader(IntPtr shader) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)V(D3D9.Slot.SetVertexShader);
            if (fn != null) fn(Ptr, shader);
        }
        public void SetVertexDeclaration(IntPtr decl) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)V(D3D9.Slot.SetVertexDeclaration);
            if (fn != null) fn(Ptr, decl);
        }
    }

    /// <summary>IDirect3DTexture9 wrapper (GetSurfaceLevel + Release + LockRect for the dump path).</summary>
    public readonly unsafe struct Texture9 {
        public readonly IntPtr Ptr;
        public Texture9(IntPtr ptr) { Ptr = ptr; }
        public bool IsValid => Ptr != IntPtr.Zero;
        public IntPtr GetSurfaceLevel(uint level) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr*, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.TexSlot.GetSurfaceLevel);
            IntPtr s = IntPtr.Zero; if (fn != null) fn(Ptr, level, &s); return s;
        }
        public bool LockRect(uint level, out D3DLockedRect locked, uint flags) {
            locked = default;
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, D3DLockedRect*, void*, uint, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.TexSlot.LockRect);
            if (fn == null) return false;
            D3DLockedRect lr; if (fn(Ptr, level, &lr, null, flags) < 0) return false;
            locked = lr; return true;
        }
        public void UnlockRect(uint level) {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.TexSlot.UnlockRect);
            if (fn != null) fn(Ptr, level);
        }
        public uint Release() => D3D9.ReleaseCom(Ptr);
    }

    public unsafe struct D3DLockedRect { public int Pitch; public void* pBits; }

    /// <summary>D3DSURFACE_DESC: Format, Type, Usage, Pool, MSType, MSQuality, Width, Height (8 DWORDs).</summary>
    public struct D3DSurfaceDesc {
        public uint Format, Type, Usage, Pool, MultiSampleType, MultiSampleQuality, Width, Height;
    }

    /// <summary>IDirect3DSurface9 wrapper (GetDesc/LockRect/UnlockRect/Release).</summary>
    public readonly unsafe struct Surface9 {
        public readonly IntPtr Ptr;
        public Surface9(IntPtr ptr) { Ptr = ptr; }
        public bool IsValid => Ptr != IntPtr.Zero;
        public D3DSurfaceDesc GetDesc() {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, D3DSurfaceDesc*, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.SurfSlot.GetDesc);
            D3DSurfaceDesc d = default; if (fn != null) fn(Ptr, &d); return d;
        }
        public bool LockRect(out D3DLockedRect locked, uint flags) {
            locked = default;
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, D3DLockedRect*, void*, uint, int>)
                D3D9.GetVTableEntry(Ptr, D3D9.SurfSlot.LockRect);
            if (fn == null) return false;
            D3DLockedRect lr; if (fn(Ptr, &lr, null, flags) < 0) return false;
            locked = lr; return true;
        }
        public void UnlockRect() {
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, int>)D3D9.GetVTableEntry(Ptr, D3D9.SurfSlot.UnlockRect);
            if (fn != null) fn(Ptr);
        }
        public uint Release() => D3D9.ReleaseCom(Ptr);
    }
}
