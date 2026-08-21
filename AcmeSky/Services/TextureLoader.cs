using System;
using System.IO;
using AcmeSky.Lib;
using Microsoft.Extensions.Logging;

namespace AcmeSky.Services {
    /// <summary>
    /// Uploads a baked .askytex (raw BGRA container -- see tools/make_askytex.py) into a fresh
    /// IDirect3DTexture9 on the client's own device, via CreateTexture + LockRect + memcpy + UnlockRect.
    ///
    /// WHY RAW, NOT PNG: AcmeSky is injected into the locked-down retail acclient process. Pre-decoding
    /// the plates offline means zero managed image-decoder dependency (no ImageSharp / System.Drawing)
    /// inside that process -- the upload path is a straight byte copy.
    ///
    /// Textures are created in D3DPOOL_MANAGED so a plain device Reset restores them automatically;
    /// SkyRenderer additionally detects a *changed* device pointer (full re-create) and reloads.
    /// </summary>
    public sealed class TextureLoader {
        private readonly ILogger _log;
        public TextureLoader(ILogger log) { _log = log; }

        /// <summary>Decoded header + payload of an .askytex file.</summary>
        public readonly struct Raw {
            public readonly int Width, Height;
            public readonly byte[] Bgra;
            public Raw(int w, int h, byte[] bgra) { Width = w; Height = h; Bgra = bgra; }
            public bool Valid => Bgra is { Length: > 0 } && Width > 0 && Height > 0;
        }

        /// <summary>Read and validate an .askytex file. Returns an invalid Raw on any problem.</summary>
        public Raw ReadFile(string path) {
            try {
                byte[] all = File.ReadAllBytes(path);
                if (all.Length < 20) { _log.LogWarning("acmesky: {Path} too small for .askytex", path); return default; }
                // magic "ASKYTEX1"
                ReadOnlySpan<byte> magic = "ASKYTEX1"u8;
                for (int i = 0; i < 8; i++) {
                    if (all[i] != magic[i]) { _log.LogWarning("acmesky: {Path} bad magic", path); return default; }
                }
                int w = BitConverter.ToInt32(all, 8);
                int h = BitConverter.ToInt32(all, 12);
                int fmt = BitConverter.ToInt32(all, 16);
                if (fmt != 1) { _log.LogWarning("acmesky: {Path} unsupported format {Fmt}", path, fmt); return default; }
                long need = 20L + (long)w * h * 4;
                if (w <= 0 || h <= 0 || all.Length < need) {
                    _log.LogWarning("acmesky: {Path} truncated ({Len} < {Need})", path, all.Length, need);
                    return default;
                }
                var bgra = new byte[w * h * 4];
                Buffer.BlockCopy(all, 20, bgra, 0, bgra.Length);
                return new Raw(w, h, bgra);
            }
            catch (Exception ex) {
                _log.LogWarning(ex, "acmesky: failed to read {Path}", path);
                return default;
            }
        }

        /// <summary>
        /// Create a managed-pool A8R8G8B8 texture and copy the BGRA payload in, honouring the
        /// locked pitch. Returns the IDirect3DTexture9* or Zero. Render thread only.
        /// </summary>
        public unsafe IntPtr Upload(Device device, in Raw raw) {
            if (!device.IsValid || !raw.Valid) return IntPtr.Zero;

            IntPtr tex = device.CreateTexture((uint)raw.Width, (uint)raw.Height,
                                              D3D9.Fmt.A8R8G8B8, D3D9.Pool.Managed);
            if (tex == IntPtr.Zero) {
                _log.LogWarning("acmesky: CreateTexture failed ({W}x{H})", raw.Width, raw.Height);
                return IntPtr.Zero;
            }

            var lockFn = (delegate* unmanaged[Stdcall]<IntPtr, uint, D3DLockedRect*, void*, uint, int>)
                D3D9.GetVTableEntry(tex, D3D9.TexSlot.LockRect);
            var unlockFn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int>)
                D3D9.GetVTableEntry(tex, D3D9.TexSlot.UnlockRect);
            if (lockFn == null || unlockFn == null) { ReleaseTexture(tex); return IntPtr.Zero; }

            D3DLockedRect lr;
            int hr = lockFn(tex, 0, &lr, null, 0);
            if (hr < 0 || lr.pBits == null) { ReleaseTexture(tex); return IntPtr.Zero; }

            int rowBytes = raw.Width * 4;
            fixed (byte* src = raw.Bgra) {
                byte* dst = (byte*)lr.pBits;
                if (lr.Pitch == rowBytes) {
                    Buffer.MemoryCopy(src, dst, (long)lr.Pitch * raw.Height, (long)rowBytes * raw.Height);
                }
                else {
                    for (int y = 0; y < raw.Height; y++)
                        Buffer.MemoryCopy(src + y * rowBytes, dst + (long)y * lr.Pitch, rowBytes, rowBytes);
                }
            }
            unlockFn(tex, 0);
            _log.LogInformation("acmesky: uploaded texture {W}x{H} -> {Tex:X8}", raw.Width, raw.Height, tex.ToInt64());
            return tex;
        }

        /// <summary>IDirect3DTexture9::Release (vtable slot 2).</summary>
        public unsafe void ReleaseTexture(IntPtr tex) {
            if (tex == IntPtr.Zero) return;
            var rel = (delegate* unmanaged[Stdcall]<IntPtr, uint>)
                D3D9.GetVTableEntry(tex, D3D9.TexSlot.Release);
            if (rel != null) rel(tex);
        }
    }
}
