using System;
using System.Runtime.InteropServices;

namespace AcmeLauncher {
    /// <summary>
    /// Wine detection, done the standard way: Wine's ntdll exports <c>wine_get_version</c>,
    /// real Windows' ntdll does not. Probed once, cached. On real Windows the probe is a
    /// GetProcAddress miss — no load, no side effect, no false positive.
    ///
    /// The Fix/Install tabs use this to swap the powershell-based actions (Wine's
    /// powershell.exe is a stub) for the native-Linux commands the install guide documents,
    /// and to surface the Wine-only fixes (INSTALL-LINUX-WINE.md).
    ///
    /// TEST OVERRIDE: set <c>ZZPATCHER_FAKE_WINE=1</c> to force the Wine UI on real Windows
    /// (used by the fleet UI tests; harmless in production — players don't set it).
    /// </summary>
    internal static class Platform {
        public static bool IsWine { get; }
        /// <summary>Wine's version string ("8.0", …), or "" when not Wine.</summary>
        public static string WineVersion { get; } = "";

        static Platform() {
            try {
                if (Environment.GetEnvironmentVariable("ZZPATCHER_FAKE_WINE") == "1") {
                    IsWine = true; WineVersion = "(faked: ZZPATCHER_FAKE_WINE=1)"; return;
                }
                IntPtr ntdll = GetModuleHandleW("ntdll.dll");
                if (ntdll == IntPtr.Zero) return;
                IntPtr fn = GetProcAddress(ntdll, "wine_get_version");
                if (fn == IntPtr.Zero) return;      // real Windows
                IsWine = true;
                var get = Marshal.GetDelegateForFunctionPointer<WineGetVersion>(fn);
                WineVersion = Marshal.PtrToStringAnsi(get()) ?? "";
            }
            catch { /* any loader oddity = treat as real Windows */ }
        }

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr WineGetVersion();

        [DllImport("kernel32", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern IntPtr GetModuleHandleW(string name);
        [DllImport("kernel32", CharSet = CharSet.Ansi, ExactSpelling = true, BestFitMapping = false)]
        private static extern IntPtr GetProcAddress(IntPtr module, string name);
    }
}
