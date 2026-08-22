using System;
using System.IO;
using System.Runtime.InteropServices;
using Vortice.Direct3D11;
using Vortice.DXGI;

namespace AcmeSky.Services.LiveSky {
    /// <summary>
    /// MILESTONE 1 -- loads a baked Bruneton LUT (.bin, produced by Tools/bake_atmosphere_luts.py)
    /// into a D3D11 <see cref="ID3D11Texture2D"/> (transmittance / irradiance) or
    /// <see cref="ID3D11Texture3D"/> (scattering), plus its shader-resource view. The runtime does
    /// NO EXR parsing -- the .bin is a 32-byte header followed by raw RGBA16F half data in exactly
    /// the layout D3D11 expects (row-major; 3D is z-major slices), byte-identical to what
    /// holtburger-web samples via @takram PrecomputedTexturesLoader's binary path.
    ///
    /// Header (little-endian): magic "ASKYLUT1"(8), u32 width, height, depth, channels(4),
    /// bytesPerChannel(2), reserved(0).  depth==1 => 2D texture.
    /// </summary>
    internal sealed class SkyLut : IDisposable {
        public ID3D11Texture2D? Tex2D;
        public ID3D11Texture3D? Tex3D;
        public ID3D11ShaderResourceView? Srv;
        public int Width, Height, Depth;
        public string Name = "";

        private static readonly byte[] Magic = System.Text.Encoding.ASCII.GetBytes("ASKYLUT1");

        /// <summary>Load a .bin LUT and build its texture + SRV. Throws on any error (caller guards).</summary>
        public static SkyLut Load(ID3D11Device dev, string path) {
            byte[] raw = File.ReadAllBytes(path);
            if (raw.Length < 32) throw new InvalidDataException($"{path}: too small ({raw.Length}B)");
            for (int k = 0; k < 8; k++)
                if (raw[k] != Magic[k]) throw new InvalidDataException($"{path}: bad magic");

            int width = BitConverter.ToInt32(raw, 8);
            int height = BitConverter.ToInt32(raw, 12);
            int depth = BitConverter.ToInt32(raw, 16);
            int channels = BitConverter.ToInt32(raw, 20);
            int bpc = BitConverter.ToInt32(raw, 24);
            int mipCount = Math.Max(1, BitConverter.ToInt32(raw, 28));   // reserved field = mips (2D only)

            // Format from (channels, bytesPerChannel): RGBA16F LUTs, R8 noise volumes,
            // RGBA8 weather map (M2 cloud assets share this container).
            Format fmt = (channels, bpc) switch {
                (4, 2) => Format.R16G16B16A16_Float,
                (4, 1) => Format.R8G8B8A8_UNorm,
                (1, 1) => Format.R8_UNorm,
                _ => throw new InvalidDataException($"{path}: unsupported ch={channels}, bpc={bpc}"),
            };

            const int headerBytes = 32;
            long rowPitch = (long)width * channels * bpc;
            long slicePitch = rowPitch * height;

            var lut = new SkyLut {
                Width = width, Height = height, Depth = depth,
                Name = Path.GetFileNameWithoutExtension(path),
            };

            var handle = GCHandle.Alloc(raw, GCHandleType.Pinned);
            try {
                IntPtr dataPtr = handle.AddrOfPinnedObject() + headerBytes;
                if (depth <= 1) {
                    var desc = new Texture2DDescription {
                        Width = (uint)width, Height = (uint)height, MipLevels = (uint)mipCount, ArraySize = 1,
                        Format = fmt,
                        SampleDescription = new SampleDescription(1, 0),
                        Usage = ResourceUsage.Immutable,
                        BindFlags = BindFlags.ShaderResource,
                        CPUAccessFlags = CpuAccessFlags.None,
                        MiscFlags = ResourceOptionFlags.None,
                    };
                    // Mip levels are appended sequentially in the payload (each halves w/h).
                    var subs = new SubresourceData[mipCount];
                    long ofs = 0; int mw = width, mh = height;
                    for (int m = 0; m < mipCount; m++) {
                        long mPitch = (long)mw * channels * bpc;
                        subs[m] = new SubresourceData(dataPtr + (nint)ofs, (uint)mPitch, (uint)(mPitch * mh));
                        ofs += mPitch * mh;
                        mw = Math.Max(1, mw / 2); mh = Math.Max(1, mh / 2);
                    }
                    if (raw.Length < headerBytes + ofs)
                        throw new InvalidDataException($"{path}: truncated (have {raw.Length}, need {headerBytes + ofs})");
                    lut.Tex2D = dev.CreateTexture2D(in desc, subs);
                    lut.Srv = dev.CreateShaderResourceView(lut.Tex2D);
                } else {
                    long need = headerBytes + slicePitch * depth;
                    if (raw.Length < need)
                        throw new InvalidDataException($"{path}: truncated (have {raw.Length}, need {need})");
                    var desc = new Texture3DDescription {
                        Width = (uint)width, Height = (uint)height, Depth = (uint)depth, MipLevels = 1,
                        Format = fmt,
                        Usage = ResourceUsage.Immutable,
                        BindFlags = BindFlags.ShaderResource,
                        CPUAccessFlags = CpuAccessFlags.None,
                        MiscFlags = ResourceOptionFlags.None,
                    };
                    var sub = new SubresourceData(dataPtr, (uint)rowPitch, (uint)slicePitch);
                    lut.Tex3D = dev.CreateTexture3D(in desc, new[] { sub });
                    lut.Srv = dev.CreateShaderResourceView(lut.Tex3D);
                }
            } finally {
                handle.Free();
            }
            return lut;
        }

        public void Dispose() {
            Srv?.Dispose(); Srv = null;
            Tex2D?.Dispose(); Tex2D = null;
            Tex3D?.Dispose(); Tex3D = null;
        }
    }
}
