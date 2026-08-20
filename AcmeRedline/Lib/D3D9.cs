using System;
using System.Runtime.InteropServices;

namespace AcmeRedline.Lib {
    /// <summary>
    /// The Direct3D 9 surface this plugin needs: vtable slot indices, method signatures, the
    /// render/texture-stage state constants used by the tint pass, and the raw vtable swap.
    ///
    /// PROVENANCE. The vtable-swap technique and its discipline come from **SkunkVision
    /// RenderHook** by Gregory Kusnick (SkunkWorks), later ported by Virindi — MIT licensed,
    /// adapted here with attribution. See <c>SVRenderHook.cpp</c> (`HookVTable` / `UnhookVTable`,
    /// "Ripped from Decal's Direct3D9Hook.h") and its lazy `FNeedHook` arm/disarm gate.
    ///
    /// SLOT INDICES ARE VERIFIED, NOT GUESSED. Every index in <see cref="Slot"/> was extracted
    /// from SkunkVision's <c>HookAll.cpp</c>, which hooks the *entire* IDirect3DDevice9 vtable and
    /// therefore names each slot explicitly. SkunkVision's shipping hook set (44 SetTransform,
    /// 51 SetLight, 83 DrawPrimitiveUP, 89 SetFVF in <c>SVRenderHook.cpp</c> HookMethods) matches
    /// that table on all four, which is an independent cross-check of the numbering.
    /// </summary>
    public static class D3D9 {

        /// <summary>
        /// IDirect3DDevice9 vtable slot indices.
        /// Source: SkunkVision <c>HookAll.cpp</c> — one `HookVTable(pD3DD9, N, &amp;XxxOrig, XxxHook)`
        /// per slot, so the index→name mapping is stated by the source rather than inferred.
        /// </summary>
        public static class Slot {
            /// <summary>IDirect3DDevice9::Reset — device loss; all hooks must be re-validated after.</summary>
            public const int Reset = 16;
            public const int BeginScene = 41;
            public const int EndScene = 42;
            public const int Clear = 43;
            /// <summary>SkunkVision hooks this one (SVRenderHook.cpp HookMethods).</summary>
            public const int SetTransform = 44;
            /// <summary>SkunkVision hooks this one.</summary>
            public const int SetLight = 51;
            public const int SetRenderState = 57;
            public const int GetRenderState = 58;
            public const int GetTexture = 64;
            /// <summary>Texture-highlight hook point.</summary>
            public const int SetTexture = 65;
            public const int GetTextureStageState = 66;
            public const int SetTextureStageState = 67;
            public const int DrawPrimitive = 81;
            /// <summary>Object-highlight hook point: the buffer-based path AC uses for models.</summary>
            public const int DrawIndexedPrimitive = 82;
            /// <summary>SkunkVision hooks this one — AC's terrain path.</summary>
            public const int DrawPrimitiveUP = 83;
            public const int DrawIndexedPrimitiveUP = 84;
            /// <summary>SkunkVision hooks this one.</summary>
            public const int SetFVF = 89;
            public const int SetStreamSource = 100;
            public const int SetIndices = 104;
        }

        /// <summary>
        /// D3DRENDERSTATETYPE values used by the tint pass. Values are from the public
        /// <c>d3d9types.h</c> header (documented Microsoft ABI), not reverse-engineered.
        /// </summary>
        public static class Rs {
            public const int ZEnable = 7;
            public const int ZWriteEnable = 14;
            public const int AlphaTestEnable = 15;
            public const int SrcBlend = 19;
            public const int DestBlend = 20;
            public const int CullMode = 22;
            public const int ZFunc = 23;
            public const int AlphaBlendEnable = 27;
            public const int FogEnable = 28;
            public const int TextureFactor = 60;
            public const int Lighting = 137;
            public const int ColorWriteEnable = 168;
            public const int SlopeScaleDepthBias = 175;
            public const int DepthBias = 195;
        }

        /// <summary>D3DTEXTURESTAGESTATETYPE values (d3d9types.h).</summary>
        public static class Tss {
            public const int ColorOp = 1;
            public const int ColorArg1 = 2;
            public const int ColorArg2 = 3;
            public const int AlphaOp = 4;
            public const int AlphaArg1 = 5;
            public const int AlphaArg2 = 6;
        }

        /// <summary>D3DTEXTUREOP values (d3d9types.h).</summary>
        public static class Top {
            public const int Disable = 1;
            public const int SelectArg1 = 2;
            public const int SelectArg2 = 3;
            public const int Modulate = 4;
        }

        /// <summary>D3DTA_* texture argument selectors (d3d9types.h).</summary>
        public static class Ta {
            public const int Diffuse = 0;
            public const int Current = 1;
            public const int Texture = 2;
            /// <summary>The constant colour set by D3DRS_TEXTUREFACTOR — how the tint gets in.</summary>
            public const int TFactor = 3;
        }

        /// <summary>D3DBLEND values (d3d9types.h).</summary>
        public static class Blend {
            public const int Zero = 1;
            public const int One = 2;
            public const int SrcAlpha = 5;
            public const int InvSrcAlpha = 6;
        }

        /// <summary>D3DCMPFUNC values (d3d9types.h).</summary>
        public static class Cmp {
            public const int Less = 2;
            public const int Equal = 3;
            public const int LessEqual = 4;
        }

        /// <summary>D3DCULL values (d3d9types.h).</summary>
        public static class Cull {
            public const int None = 1;
            public const int Cw = 2;
            public const int Ccw = 3;
        }

        /// <summary>D3DPRIMITIVETYPE values (d3d9types.h).</summary>
        public static class Prim {
            public const int PointList = 1;
            public const int LineList = 2;
            public const int LineStrip = 3;
            public const int TriangleList = 4;
            public const int TriangleStrip = 5;
            public const int TriangleFan = 6;
        }

        // ------------------------------------------------------------------
        // Method signatures, for reference. Every IDirect3DDevice9 method is __stdcall with the
        // interface pointer as the implicit first argument, so the C# shape of a detour is
        // `delegate* unmanaged[Stdcall]<IntPtr /*this*/, ...args..., int /*HRESULT*/>`.
        // These are written out at each use site in DeviceHooks rather than aliased here, because
        // a function-pointer type alias cannot live in a static class and a managed delegate would
        // put a marshalling stub in the hot path.
        //
        //   Reset                (IntPtr this, D3DPRESENT_PARAMETERS* pp)                                      -> HRESULT
        //   SetTransform         (IntPtr this, D3DTRANSFORMSTATETYPE state, const D3DMATRIX* m)                 -> HRESULT
        //   SetRenderState       (IntPtr this, D3DRENDERSTATETYPE state, DWORD value)                           -> HRESULT
        //   GetRenderState       (IntPtr this, D3DRENDERSTATETYPE state, DWORD* out)                            -> HRESULT
        //   SetTexture           (IntPtr this, DWORD stage, IDirect3DBaseTexture9* tex)                         -> HRESULT
        //   SetTextureStageState (IntPtr this, DWORD stage, D3DTEXTURESTAGESTATETYPE type, DWORD value)         -> HRESULT
        //   GetTextureStageState (IntPtr this, DWORD stage, D3DTEXTURESTAGESTATETYPE type, DWORD* out)          -> HRESULT
        //   DrawIndexedPrimitive (IntPtr this, D3DPRIMITIVETYPE type, INT baseVertexIndex,
        //                         UINT minVertexIndex, UINT numVertices,
        //                         UINT startIndex, UINT primitiveCount)                                         -> HRESULT
        //   DrawPrimitiveUP      (IntPtr this, D3DPRIMITIVETYPE type, UINT primCount,
        //                         const void* vertexData, UINT stride)                                          -> HRESULT
        // ------------------------------------------------------------------

        // ------------------------------------------------------------------
        // Vtable surgery. Transcribed from SkunkVision SVRenderHook.cpp
        // ("Ripped from Decal's Direct3D9Hook.h"), MIT, Gregory Kusnick / SkunkWorks.
        // ------------------------------------------------------------------

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool VirtualProtect(IntPtr lpAddress, UIntPtr dwSize,
                                                  uint flNewProtect, out uint lpflOldProtect);

        [DllImport("kernel32.dll")]
        private static extern bool FlushInstructionCache(IntPtr hProcess, IntPtr lpBaseAddress, UIntPtr dwSize);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        private const uint PAGE_EXECUTE_READWRITE = 0x40;

        /// <summary>Read a vtable slot: <c>(*(void***)obj)[index]</c>.</summary>
        public static unsafe IntPtr GetVTableEntry(IntPtr comObject, int index) {
            if (comObject == IntPtr.Zero) return IntPtr.Zero;
            IntPtr* vtable = *(IntPtr**)comObject;
            if (vtable == null) return IntPtr.Zero;
            return vtable[index];
        }

        /// <summary>
        /// Swap one vtable slot to <paramref name="detour"/> and return the previous entry.
        ///
        /// Mirrors SkunkVision's <c>HookVTable</c> exactly, including the idempotence guard
        /// ("if the slot is already our detour, do nothing") — which is what makes it safe to call
        /// unconditionally from a per-frame arm check.
        ///
        /// Returns <see cref="IntPtr.Zero"/> if the slot could not be made writable.
        /// </summary>
        public static unsafe IntPtr HookVTable(IntPtr comObject, int index, IntPtr detour) {
            if (comObject == IntPtr.Zero || detour == IntPtr.Zero) return IntPtr.Zero;

            IntPtr* vtable = *(IntPtr**)comObject;
            if (vtable == null) return IntPtr.Zero;

            IntPtr* slot = &vtable[index];
            if (*slot == detour) return *slot;   // already hooked by us

            if (!VirtualProtect((IntPtr)slot, (UIntPtr)(uint)IntPtr.Size,
                                PAGE_EXECUTE_READWRITE, out uint oldProtect)) {
                return IntPtr.Zero;
            }

            IntPtr original = *slot;
            *slot = detour;

            VirtualProtect((IntPtr)slot, (UIntPtr)(uint)IntPtr.Size, oldProtect, out _);
            FlushInstructionCache(GetCurrentProcess(), (IntPtr)slot, (UIntPtr)(uint)IntPtr.Size);

            return original;
        }

        /// <summary>
        /// Restore a vtable slot — but ONLY if it still holds <paramref name="detour"/>.
        ///
        /// This conditional is the single most important line in the whole technique, and it is
        /// SkunkVision's (<c>UnhookVTable</c>: <c>if (lpHooked == lpDetour)</c>). If some other
        /// tool hooked the same slot *after* us, its detour is what is installed and its saved
        /// "original" is *our* detour. Blindly writing our saved original would (a) silently
        /// uninstall their hook and (b) leave them calling into an address we are about to free.
        /// Refusing to restore is the only correct move; the caller must then treat itself as
        /// permanently armed (see <see cref="AcmeRedline.Services.DeviceHooks"/>).
        /// </summary>
        /// <returns>true if the slot was restored, false if someone else owns it now.</returns>
        public static unsafe bool UnhookVTable(IntPtr comObject, int index, IntPtr detour, IntPtr original) {
            if (comObject == IntPtr.Zero) return false;

            IntPtr* vtable = *(IntPtr**)comObject;
            if (vtable == null) return false;

            IntPtr* slot = &vtable[index];
            if (*slot != detour) return false;   // someone hooked over us — do NOT touch it

            if (!VirtualProtect((IntPtr)slot, (UIntPtr)(uint)IntPtr.Size,
                                PAGE_EXECUTE_READWRITE, out uint oldProtect)) {
                return false;
            }

            *slot = original;

            VirtualProtect((IntPtr)slot, (UIntPtr)(uint)IntPtr.Size, oldProtect, out _);
            FlushInstructionCache(GetCurrentProcess(), (IntPtr)slot, (UIntPtr)(uint)IntPtr.Size);

            return true;
        }
    }
}
