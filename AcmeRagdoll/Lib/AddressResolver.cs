using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace AcmeRagdoll.Lib {
    /// <summary>
    /// Resolves the runtime address of a hooked client function.
    ///
    /// TWO SOURCES, in order:
    ///
    /// 1. A SELF-CONTAINED MANAGED SIGNATURE SCAN over acclient.exe's .text image.  The brief asks
    ///    for sig-scanning because "decomp != shipped-exe build".  Chorizite's own sig-scanner
    ///    (external/chorizite/.../Lib/SigScanner.cs) P/Invokes a native SigScan.dll that is not on a
    ///    plugin's load path, so this reimplements the same idea in pure managed code: read the main
    ///    module's bytes and find the first match of a "AB ?? CD" pattern (?? = wildcard byte).
    ///
    /// 2. A HARD-CODED VA FALLBACK.  Unlike the decomp line numbers, the addresses in
    ///    Chorizite.ACBindings are extracted FROM the shipped acclient.exe (every ACBindings thiscall
    ///    thunk is a literal call through such a VA, and AcmeRedline reads client globals at literal
    ///    VAs like 0x008EE3D8 successfully).  Chorizite's ACClientHooks.cs likewise hooks by literal
    ///    VA (0x004118D0, ...).  So the ACBindings VA is the *proven* address for the client build
    ///    this kit ships; the sig-scan exists as a belt-and-braces guard for a differently-built exe.
    ///
    /// IMPORTANT (honest status): the sig patterns here are PLACEHOLDERS pending a live client to
    /// derive real prologue bytes from - see <see cref="ClientFunctions"/>.  Until then the resolver
    /// uses the VA directly.  Passing an empty/placeholder pattern makes <see cref="Resolve"/> skip
    /// the scan and return the VA.
    /// </summary>
    internal static class AddressResolver {
        /// <summary>
        /// Resolve <paramref name="name"/> to a runtime address.  If <paramref name="pattern"/> is a
        /// usable IDA-style byte pattern it is scanned first; on any miss (or a placeholder pattern)
        /// the proven <paramref name="vaFallback"/> is returned.
        /// </summary>
        public static nint Resolve(string name, string? pattern, nint vaFallback) {
            if (!string.IsNullOrWhiteSpace(pattern) && !pattern!.StartsWith("PLACEHOLDER")) {
                try {
                    nint hit = Scan(pattern);
                    if (hit != 0) return hit;
                }
                catch { /* fall through to the VA */ }
            }
            return vaFallback;
        }

        /// <summary>
        /// Scan the main module for the first match of an IDA-style pattern, e.g.
        /// <c>"55 8B EC ?? 83 EC"</c> where <c>??</c> is a wildcard byte.  Returns the absolute
        /// address of the match, or 0 if not found.
        /// </summary>
        public static nint Scan(string pattern) {
            (byte[] bytes, bool[] mask) = ParsePattern(pattern);
            if (bytes.Length == 0) return 0;

            ProcessModule main = Process.GetCurrentProcess().MainModule
                                 ?? throw new InvalidOperationException("no main module");
            nint baseAddr = main.BaseAddress;
            int size = main.ModuleMemorySize;

            // Read the whole image into managed memory once, then scan there (no per-byte marshalling).
            byte[] image = new byte[size];
            Marshal.Copy(baseAddr, image, 0, size);

            int last = size - bytes.Length;
            for (int i = 0; i <= last; i++) {
                bool ok = true;
                for (int j = 0; j < bytes.Length; j++) {
                    if (mask[j] && image[i + j] != bytes[j]) { ok = false; break; }
                }
                if (ok) return baseAddr + i;
            }
            return 0;
        }

        private static (byte[], bool[]) ParsePattern(string pattern) {
            string[] tokens = pattern.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            var bytes = new byte[tokens.Length];
            var mask = new bool[tokens.Length];
            for (int i = 0; i < tokens.Length; i++) {
                string tk = tokens[i];
                if (tk == "??" || tk == "?") { bytes[i] = 0; mask[i] = false; }
                else { bytes[i] = Convert.ToByte(tk, 16); mask[i] = true; }
            }
            return (bytes, mask);
        }
    }

    /// <summary>
    /// The two client functions AcmeRagdoll detours, with their proven shipped-exe VAs (from
    /// Chorizite.ACBindings) and a place to drop a verified sig-scan pattern once one is captured on
    /// a live client.  Cross-referenced to the decomp for provenance (acclient.c line numbers are the
    /// decomp's, NOT shipped-exe offsets - only the VAs are shipped-exe truth).
    /// </summary>
    internal static class ClientFunctions {
        // void __thiscall CPartArray::UpdateParts(CPartArray* this, const Frame* frame)
        //   ACBindings CPartArray.cs Offset: 0x00519C20 ; decomp acclient.c:326601 (VA 0x00519C20).
        //   The LAST writer of every creature part's pose each tick - our post-detour overwrite site.
        public const nint UpdateParts_VA = 0x00519C20;
        public const string? UpdateParts_Sig = "PLACEHOLDER: capture prologue bytes at 0x00519C20 on the 1070";

        // void __thiscall CPhysicsObj::MotionDone(CPhysicsObj* this, unsigned int motion, int success)
        //   ACBindings CPhysicsObj.cs Offset: 0x00510880 ; decomp acclient.c:317097.
        //   Death signal: filter motion == MotionCommand.Dead (0x40000011) to arm a ragdoll.
        public const nint MotionDone_VA = 0x00510880;
        public const string? MotionDone_Sig = "PLACEHOLDER: capture prologue bytes at 0x00510880 on the 1070";
    }
}
