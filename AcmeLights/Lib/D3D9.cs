using System;

namespace AcmeLights.Lib {
    /// <summary>
    /// IDirect3DDevice9 / IDirect3DTexture9 / IDirect3DSurface9 vtable slot indices and the D3D9
    /// enum constants AcmeLights' bloom post-process needs. Same provenance as AcmeSky/Lib/D3D9.cs
    /// (standard d3d9.h ABI order; device slots cross-checked against AcmeRedline/SkunkVision).
    /// The retail client is pure fixed-function, so binding our own pixel shaders is safe as long
    /// as we null them on restore (see BloomCompositor).
    /// </summary>
    public static class D3D9 {
        /// <summary>IDirect3DDevice9 vtable slots (0-indexed, standard d3d9.h order).</summary>
        public static class Slot {
            public const int Release = 2;
            public const int GetSwapChain = 14;
            public const int Reset = 16;
            public const int GetBackBuffer = 18;
            public const int CreateTexture = 23;
            public const int CreateRenderTarget = 28;
            public const int StretchRect = 34;
            public const int SetRenderTarget = 37;
            public const int GetRenderTarget = 38;
            public const int SetDepthStencilSurface = 39;
            public const int GetDepthStencilSurface = 40;
            public const int BeginScene = 41;
            public const int EndScene = 42;
            public const int Clear = 43;
            public const int SetTransform = 44;
            public const int SetViewport = 47;
            public const int GetViewport = 48;
            public const int SetRenderState = 57;
            public const int GetRenderState = 58;
            public const int CreateStateBlock = 59;   // HRESULT(D3DSTATEBLOCKTYPE, IDirect3DStateBlock9**)
            public const int GetTexture = 64;
            public const int SetTexture = 65;
            public const int SetTextureStageState = 67;
            public const int SetSamplerState = 69;
            public const int DrawPrimitiveUP = 83;
            public const int CreateVertexShader = 91;
            public const int SetVertexShader = 92;
            public const int SetVertexDeclaration = 87;
            public const int SetFVF = 89;
            // (100 SetStreamSource,101 Get,102 SetFreq,103 GetFreq,104 SetIndices,105 GetIndices,
            //  106 CreatePixelShader,107 SetPixelShader,108 GetPixelShader,109 SetPixelShaderConstantF)
            public const int CreatePixelShader = 106;
            public const int SetPixelShader = 107;
            public const int SetPixelShaderConstantF = 109;
        }

        /// <summary>IDirect3DTexture9 vtable slots.</summary>
        public static class TexSlot {
            public const int Release = 2;
            public const int GetSurfaceLevel = 18;
            public const int LockRect = 19;
            public const int UnlockRect = 20;
        }

        /// <summary>IDirect3DSurface9 / IDirect3DPixelShader9 / IDirect3DVertexShader9 Release.</summary>
        public const int IUnknownRelease = 2;

        public static class Rs {
            public const int ZEnable = 7;
            public const int ZWriteEnable = 14;
            public const int AlphaTestEnable = 15;
            public const int SrcBlend = 19;
            public const int DestBlend = 20;
            public const int CullMode = 22;
            public const int AlphaBlendEnable = 27;
            public const int FogEnable = 28;
            public const int Lighting = 137;
            public const int ColorWriteEnable = 168;
            public const int SrgbWriteEnable = 194;
        }
        public static class Tss {
            public const int ColorOp = 1;
            public const int AlphaOp = 4;
        }
        public static class Samp {
            public const int AddressU = 1;
            public const int AddressV = 2;
            public const int MagFilter = 5;
            public const int MinFilter = 6;
            public const int MipFilter = 7;
            public const int SrgbTexture = 11;
        }
        public static class Address { public const int Clamp = 3; }
        public static class Filter { public const int None = 0; public const int Point = 1; public const int Linear = 2; }
        public static class Top { public const int Disable = 1; public const int SelectArg1 = 2; }
        public static class Blend { public const int Zero = 1; public const int One = 2; }
        public static class Cull { public const int None = 1; }
        public static class Prim { public const int TriangleList = 4; }
        public static class Fvf {
            public const uint XyzRhw = 0x004;
            public const uint Tex1 = 0x100;
            public const uint XyzRhwTex1 = XyzRhw | Tex1;   // 0x104, stride 24
        }
        public static class Fmt {
            public const int A8R8G8B8 = 21;
            public const int X8R8G8B8 = 22;
            public const int A16B16G16R16F = 113;   // half-float RGBA (HDR bloom RTs if desired)
        }
        public static class Usage {
            public const uint None = 0;
            public const uint RenderTarget = 0x00000001;
        }
        public static class Pool {
            public const int Default = 0;
            public const int SystemMem = 2;
        }

        /// <summary>Read a COM vtable slot: <c>(*(void***)obj)[index]</c>.</summary>
        public static unsafe IntPtr GetVTableEntry(IntPtr comObject, int index) {
            if (comObject == IntPtr.Zero) return IntPtr.Zero;
            IntPtr* vtable = *(IntPtr**)comObject;
            if (vtable == null) return IntPtr.Zero;
            return vtable[index];
        }

        /// <summary>Release any IUnknown-derived COM object (surface/shader/texture).</summary>
        public static unsafe uint ReleaseCom(IntPtr obj) {
            if (obj == IntPtr.Zero) return 0;
            var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint>)GetVTableEntry(obj, IUnknownRelease);
            return fn == null ? 0u : fn(obj);
        }
    }

    /// <summary>D3DVIEWPORT9 (6 DWORDs).</summary>
    public struct D3DViewport9 {
        public uint X, Y, Width, Height;
        public float MinZ, MaxZ;
    }

    /// <summary>Win32 RECT (left, top, right, bottom).</summary>
    public struct Rect { public int Left, Top, Right, Bottom; }
}
