using System;
using System.Diagnostics;
using AcmeLights.Lib;
using Microsoft.Extensions.Logging;

namespace AcmeLights.Services {
    /// <summary>
    /// Backbuffer capture for eyes-free / taildrop validation. Runs from a RenderDeviceD3D::EndScene
    /// POST detour — at that point the scene is CLOSED (EndScene ran) and the backbuffer holds the
    /// finished world + UI but Present has not happened, so GetRenderTargetData(backbuffer -> a
    /// SYSTEMMEM surface) is legal (unlike StretchRect inside the open scene, which faults the bloom
    /// pass). Writes a rotating 32bpp BMP to C:\Temp\acdt\framedump-N.bmp, throttled to 1/sec, only
    /// when lights.cfg dump=1. Never throws.
    /// </summary>
    internal sealed unsafe class DumpService {
        private readonly ILogger _log;
        private readonly LightsConfig _cfg;
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private long _lastTicks = -Stopwatch.Frequency;
        private int _index;
        private IntPtr _dev, _dst;   // cached sysmem dest surface
        private int _w, _h; private uint _fmt;
        private long _lastErr = -Stopwatch.Frequency;

        public DumpService(ILogger log, LightsConfig cfg) { _log = log; _cfg = cfg; }

        public void OnEndScene(IntPtr devPtr) {
            if (_cfg.Dump < 0.5f || devPtr == IntPtr.Zero) return;
            long now = _clock.ElapsedTicks;
            if (now - _lastTicks < Stopwatch.Frequency) return;
            _lastTicks = now;
            try { Capture(new Device(devPtr), devPtr); }
            catch (Exception ex) { LogErr(ex); }
        }

        private void Capture(Device dev, IntPtr devPtr) {
            IntPtr rt = dev.GetRenderTarget(0);
            if (rt == IntPtr.Zero) { LogNote("rt null"); return; }
            try {
                var desc = new Surface9(rt).GetDesc();
                int w = (int)desc.Width, h = (int)desc.Height;
                if (w <= 0 || h <= 0) { LogNote($"bad desc w={w} h={h} fmt={desc.Format} mst={desc.MultiSampleType}"); return; }
                if (devPtr != _dev || w != _w || h != _h || desc.Format != _fmt) {
                    if (_dst != IntPtr.Zero) { D3D9.ReleaseCom(_dst); _dst = IntPtr.Zero; }
                    _dst = dev.CreateOffscreenPlainSurface((uint)w, (uint)h, (int)desc.Format, D3D9.Pool.SystemMem);
                    _dev = devPtr; _w = w; _h = h; _fmt = desc.Format;
                    if (_dst == IntPtr.Zero) { LogErr(new InvalidOperationException($"CreateOffscreenPlainSurface null (fmt={desc.Format})")); return; }
                    LogNote($"dst ready {w}x{h} fmt={desc.Format} mst={desc.MultiSampleType}");
                }
                int grd = dev.GetRenderTargetData(rt, _dst);
                if (grd < 0) { LogNote($"GetRenderTargetData hr={grd} (mst={desc.MultiSampleType})"); return; }
                var dst = new Surface9(_dst);
                if (!dst.LockRect(out var lr, 0)) { LogNote("LockRect fail"); return; }
                try { WriteBmp($@"C:\Temp\acdt\framedump-{_index++ % 8}.bmp", (byte*)lr.pBits, lr.Pitch, w, h); }
                finally { dst.UnlockRect(); }
            }
            finally { D3D9.ReleaseCom(rt); }
        }

        /// <summary>Write a 32bpp bottom-up BMP from a locked BGRA/BGRX surface.</summary>
        private void WriteBmp(string path, byte* src, int pitch, int w, int h) {
            int rowBytes = w * 4;
            var file = new byte[54 + rowBytes * h];
            file[0] = (byte)'B'; file[1] = (byte)'M';
            BitConverter.GetBytes(file.Length).CopyTo(file, 2);
            BitConverter.GetBytes(54).CopyTo(file, 10);
            BitConverter.GetBytes(40).CopyTo(file, 14);
            BitConverter.GetBytes(w).CopyTo(file, 18);
            BitConverter.GetBytes(h).CopyTo(file, 22);         // positive = bottom-up
            BitConverter.GetBytes((short)1).CopyTo(file, 26);
            BitConverter.GetBytes((short)32).CopyTo(file, 28);
            BitConverter.GetBytes(rowBytes * h).CopyTo(file, 34);
            fixed (byte* dst = file) {
                for (int y = 0; y < h; y++)
                    Buffer.MemoryCopy(src + (long)y * pitch, dst + 54 + (long)(h - 1 - y) * rowBytes, rowBytes, rowBytes);
            }
            System.IO.File.WriteAllBytes(path, file);
            _log.LogInformation("acmelights: frame dumped -> {Path}", path);
        }

        public void Dispose() {
            if (_dst != IntPtr.Zero) { D3D9.ReleaseCom(_dst); _dst = IntPtr.Zero; }
        }

        private void LogErr(Exception ex) {
            long now = _clock.ElapsedTicks;
            if (now - _lastErr < Stopwatch.Frequency) return;
            _lastErr = now;
            _log.LogWarning(ex, "acmelights: frame dump failed");
        }
        private long _lastNote = -Stopwatch.Frequency * 3;
        private void LogNote(string s) {
            long now = _clock.ElapsedTicks;
            if (now - _lastNote < Stopwatch.Frequency * 3) return;
            _lastNote = now;
            _log.LogInformation("acmelights: dump note: {S}", s);
        }
    }
}
