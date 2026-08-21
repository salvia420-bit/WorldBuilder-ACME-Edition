using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace AcmeSky.Lib {
    /// <summary>
    /// A dependency-free, in-process byte-pattern scanner over the acclient.exe main module.
    ///
    /// WHY OUR OWN: Chorizite's SigScanner (Chorizite.NativeClientBootstrapper/Lib/SigScanner.cs)
    /// P/Invokes a native SigScan.dll that is not on a plugin's dependency path. Since we are already
    /// inside the target process, a pattern scan is just reading our own mapped image, so we do it in
    /// pure managed code and take no new native dependency.
    ///
    /// Pattern syntax: space-separated hex bytes, "??" (or "?") for a wildcard, e.g.
    ///   "55 8B EC 83 EC ?? 56 8B F1".
    /// Returns the absolute virtual address of the first match, or 0 if not found.
    /// </summary>
    public static class SigScan {
        public static IntPtr FindInMainModule(string pattern) {
            try {
                ProcessModule main = Process.GetCurrentProcess().MainModule!;
                return Find(main.BaseAddress, main.ModuleMemorySize, pattern);
            }
            catch (Exception) { return IntPtr.Zero; }
        }

        public static unsafe IntPtr Find(IntPtr baseAddr, int size, string pattern) {
            if (!ParsePattern(pattern, out byte[] bytes, out bool[] mask) || bytes.Length == 0)
                return IntPtr.Zero;

            // Copy the module image into managed memory once, then scan (avoids millions of
            // Marshal.ReadByte P/Invokes and any torn reads mid-scan).
            var image = new byte[size];
            Marshal.Copy(baseAddr, image, 0, size);

            int n = bytes.Length;
            int last = size - n;
            for (int i = 0; i <= last; i++) {
                bool ok = true;
                for (int j = 0; j < n; j++) {
                    if (mask[j]) continue;
                    if (image[i + j] != bytes[j]) { ok = false; break; }
                }
                if (ok) return baseAddr + i;
            }
            return IntPtr.Zero;
        }

        private static bool ParsePattern(string pattern, out byte[] bytes, out bool[] mask) {
            bytes = Array.Empty<byte>(); mask = Array.Empty<bool>();
            if (string.IsNullOrWhiteSpace(pattern)) return false;
            string[] toks = pattern.Replace("##", "").Trim()
                .Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var b = new byte[toks.Length];
            var m = new bool[toks.Length];
            for (int i = 0; i < toks.Length; i++) {
                string tk = toks[i];
                if (tk is "??" or "?" or "*") { m[i] = true; b[i] = 0; continue; }
                if (!byte.TryParse(tk, System.Globalization.NumberStyles.HexNumber, null, out b[i]))
                    return false;
            }
            bytes = b; mask = m;
            return true;
        }
    }
}
