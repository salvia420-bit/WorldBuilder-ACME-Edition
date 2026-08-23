using System;

namespace AcmeSky.Lib {
    /// <summary>
    /// The fixed-function Direct3D 9 surface AcmeSky needs: IDirect3DDevice9 vtable slot indices,
    /// IDirect3DTexture9 vtable slot indices, and the render-state / texture-stage / sampler /
    /// transform / FVF / format / pool constants used to draw textured sky domes.
    ///
    /// The retail AC client is pure fixed-function D3D9 (verified: zero CreatePixelShader /
    /// CreateVertexShader in acclient.c; Direct3DCreate9, not 9Ex). So every sky surface is drawn
    /// the fixed-function way: SetTransform WORLD/VIEW/PROJ, SetTexture, SetRenderState,
    /// SetTextureStageState, SetFVF, DrawPrimitiveUP of a generated textured dome.
    ///
    /// PROVENANCE of the numeric values:
    ///   * Device vtable slot indices: transcribed from AcmeRedline/Lib/D3D9.cs, which took them
    ///     from SkunkVision HookAll.cpp (a full-vtable trace naming every slot). CreateTexture(23)
    ///     is the standard IDirect3DDevice9 vtable order and is cross-checked below.
    ///   * Texture vtable slot indices: standard IDirect3DTexture9 ABI order (d3d9.h) --
    ///     IDirect3DTexture9 : IDirect3DBaseTexture9 : IDirect3DResource9 : IUnknown.
    ///   * D3DRS_/D3DTSS_/D3DTOP_/D3DTA_/D3DSAMP_/D3DTS_/D3DFVF_/D3DFMT_/D3DPOOL_ values: the public
    ///     d3d9types.h / d3d9.h ABI, not reverse-engineered.
    /// </summary>
    public static class D3D9 {

        /// <summary>IDirect3DDevice9 vtable slot indices. Source: AcmeRedline/SkunkVision HookAll.cpp.</summary>
        public static class Slot {
            public const int Release = 2;
            public const int Reset = 16;
            public const int BeginScene = 41;
            public const int EndScene = 42;
            public const int Clear = 43;
            public const int SetTransform = 44;
            public const int GetTransform = 45;
            public const int SetRenderState = 57;
            public const int GetRenderState = 58;
            // Standard IDirect3DDevice9 vtable order (d3d9.h): ...16 Reset,17 Present,...,23 CreateTexture.
            public const int CreateTexture = 23;
            public const int SetTexture = 65;
            public const int GetTexture = 64;
            public const int GetTextureStageState = 66;
            public const int SetTextureStageState = 67;
            public const int GetSamplerState = 68;
            public const int SetSamplerState = 69;
            public const int DrawPrimitive = 81;
            public const int DrawIndexedPrimitive = 82;
            /// <summary>User-pointer triangle path -- how we submit the generated dome vertices.</summary>
            public const int DrawPrimitiveUP = 83;
            public const int DrawIndexedPrimitiveUP = 84;
            public const int SetFVF = 89;
            public const int GetFVF = 90;
            public const int SetStreamSource = 100;
        }

        /// <summary>
        /// IDirect3DTexture9 vtable slot indices (d3d9.h ABI order). Derives through
        /// IDirect3DBaseTexture9 : IDirect3DResource9 : IUnknown; LockRect/UnlockRect are the last
        /// two texture-specific methods.
        /// </summary>
        public static class TexSlot {
            public const int Release = 2;
            public const int LockRect = 19;
            public const int UnlockRect = 20;
        }

        /// <summary>D3DRENDERSTATETYPE values (d3d9types.h).</summary>
        public static class Rs {
            public const int ZEnable = 7;
            public const int FillMode = 8;
            public const int ZWriteEnable = 14;
            public const int AlphaTestEnable = 15;
            public const int SrcBlend = 19;
            public const int DestBlend = 20;
            public const int CullMode = 22;
            public const int ZFunc = 23;
            public const int AlphaRef = 24;
            public const int AlphaFunc = 25;
            public const int AlphaBlendEnable = 27;
            public const int FogEnable = 28;
            public const int SpecularEnable = 29;
            public const int TextureFactor = 60;
            public const int Clipping = 136;
            public const int Lighting = 137;
            public const int Ambient = 139;
            public const int ColorVertex = 141;
            public const int ColorWriteEnable = 168;
        }

        /// <summary>D3DTEXTURESTAGESTATETYPE values (d3d9types.h).</summary>
        public static class Tss {
            public const int ColorOp = 1;
            public const int ColorArg1 = 2;
            public const int ColorArg2 = 3;
            public const int AlphaOp = 4;
            public const int AlphaArg1 = 5;
            public const int AlphaArg2 = 6;
            public const int TexCoordIndex = 11;
            public const int TextureTransformFlags = 24;
        }

        /// <summary>D3DSAMPLERSTATETYPE values (d3d9types.h).</summary>
        public static class Samp {
            public const int AddressU = 1;
            public const int AddressV = 2;
            public const int MagFilter = 5;
            public const int MinFilter = 6;
            public const int MipFilter = 7;
        }

        /// <summary>D3DTEXTUREADDRESS values.</summary>
        public static class Address {
            public const int Wrap = 1;
            public const int Mirror = 2;
            public const int Clamp = 3;
        }

        /// <summary>D3DTEXTUREFILTERTYPE values.</summary>
        public static class Filter {
            public const int None = 0;
            public const int Point = 1;
            public const int Linear = 2;
        }

        /// <summary>D3DTEXTUREOP values (d3d9types.h).</summary>
        public static class Top {
            public const int Disable = 1;
            public const int SelectArg1 = 2;
            public const int SelectArg2 = 3;
            public const int Modulate = 4;
            public const int Modulate2X = 5;
            public const int Add = 7;
        }

        /// <summary>D3DTA_* texture-argument selectors (d3d9types.h).</summary>
        public static class Ta {
            public const int Diffuse = 0;
            public const int Current = 1;
            public const int Texture = 2;
            public const int TFactor = 3;
        }

        /// <summary>D3DBLEND values (d3d9types.h).</summary>
        public static class Blend {
            public const int Zero = 1;
            public const int One = 2;
            public const int SrcColor = 3;
            public const int InvSrcColor = 4;
            public const int SrcAlpha = 5;
            public const int InvSrcAlpha = 6;
            public const int DestAlpha = 7;
        }

        /// <summary>D3DCMPFUNC values (d3d9types.h).</summary>
        public static class Cmp {
            public const int Never = 1;
            public const int Less = 2;
            public const int Equal = 3;
            public const int LessEqual = 4;
            public const int Greater = 5;
            public const int Always = 8;
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

        /// <summary>D3DTRANSFORMSTATETYPE values (d3d9types.h).</summary>
        public static class Ts {
            public const int View = 2;
            public const int Projection = 3;
            public const int World = 256;   // D3DTS_WORLD == D3DTS_WORLDMATRIX(0)
            public const int Texture0 = 16;
        }

        /// <summary>D3DTEXTURETRANSFORMFLAGS values.</summary>
        public static class Ttff {
            public const int Disable = 0;
            public const int Count2 = 2;
        }

        /// <summary>Fixed-function FVF flags (d3d9types.h).</summary>
        public static class Fvf {
            public const uint Xyz = 0x002;
            public const uint Normal = 0x010;
            public const uint Diffuse = 0x040;
            public const uint Tex1 = 0x100;
            /// <summary>Position + diffuse colour (atmosphere gradient dome). Stride 16.</summary>
            public const uint XyzDiffuse = Xyz | Diffuse;      // 0x042
            /// <summary>Position + one 2D texcoord set (textured cloud / star dome). Stride 20.</summary>
            public const uint XyzTex1 = Xyz | Tex1;            // 0x102
            /// <summary>Position + diffuse + one 2D texcoord set (cloud deck: per-vertex tint and
            /// horizon fade modulated onto the plate). Stride 24. D3DFVF_XYZ|DIFFUSE|TEX1.</summary>
            public const uint XyzDiffuseTex1 = Xyz | Diffuse | Tex1;   // 0x142
            /// <summary>Pre-transformed (screen-space) position + rhw. D3DFVF_XYZRHW.</summary>
            public const uint XyzRhw = 0x004;
            /// <summary>Screen-space quad + one 2D texcoord set (fullscreen composite). Stride 24.
            /// D3DFVF_XYZRHW | D3DFVF_TEX1 == 0x104.</summary>
            public const uint XyzRhwTex1 = XyzRhw | Tex1;      // 0x104
        }

        /// <summary>D3DFORMAT values we use.</summary>
        public static class Fmt {
            /// <summary>D3DFMT_A8R8G8B8 -- 32bpp BGRA in memory, matches the .askytex payload.</summary>
            public const int A8R8G8B8 = 21;
        }

        /// <summary>D3DUSAGE_* flags (d3d9.h) passed to CreateTexture's Usage argument.</summary>
        public static class Usage {
            public const uint None = 0;
            /// <summary>D3DUSAGE_DYNAMIC -- CPU-writable each frame; must live in D3DPOOL_DEFAULT.</summary>
            public const uint Dynamic = 0x00000200;
        }

        /// <summary>D3DPOOL values.</summary>
        public static class Pool {
            /// <summary>D3DPOOL_DEFAULT -- lost on device Reset.</summary>
            public const int Default = 0;
            /// <summary>D3DPOOL_MANAGED -- automatically restored across a device Reset.</summary>
            public const int Managed = 1;
            public const int SystemMem = 2;
        }

        /// <summary>D3DLOCK flags.</summary>
        public static class Lock {
            public const uint Discard = 0x00002000;
            public const uint NoSysLock = 0x00000800;
        }

        /// <summary>Read a COM vtable slot: <c>(*(void***)obj)[index]</c>.</summary>
        public static unsafe IntPtr GetVTableEntry(IntPtr comObject, int index) {
            if (comObject == IntPtr.Zero) return IntPtr.Zero;
            IntPtr* vtable = *(IntPtr**)comObject;
            if (vtable == null) return IntPtr.Zero;
            return vtable[index];
        }

        /// <summary>Pack a colour to D3D ARGB (0xAARRGGBB) from 0..1 components.</summary>
        public static uint Argb(float a, float r, float g, float b) {
            static uint C(float v) {
                int i = (int)MathF.Round(Math.Clamp(v, 0f, 1f) * 255f);
                return (uint)Math.Clamp(i, 0, 255);
            }
            return (C(a) << 24) | (C(r) << 16) | (C(g) << 8) | C(b);
        }
    }
}
