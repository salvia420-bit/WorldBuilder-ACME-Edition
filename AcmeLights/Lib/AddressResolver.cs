using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace AcmeLights.Lib {
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
    /// The client functions AcmeRagdoll detours, with their proven shipped-exe VAs (from
    /// Chorizite.ACBindings / acclient.map) and a place to drop a verified sig-scan pattern once one is captured on
    /// a live client.  Cross-referenced to the decomp for provenance (acclient.c line numbers are the
    /// decomp's, NOT shipped-exe offsets - only the VAs are shipped-exe truth).
    /// </summary>
    internal static class ClientFunctions {
        // Map-build runtime VAs (Chorizite target = the shipped client). These are the exact
        // addresses ACBindings/Generated already uses for the same symbols, so they are the
        // proven addresses for this build; the sig-scan is a belt-and-braces guard only.

        // PrimD3DRender::UpdateLightsInternal (thiscall) -- per-viewpoint heartbeat + where the
        // FF light pool is finalized. ACBindings PrimD3DRender.cs 'n() @0x0059BEE0'.
        public const nint UpdateLightsInternal_VA = 0x0059BEE0;
        public const string? UpdateLightsInternal_Sig = "PLACEHOLDER: prologue at 0x0059BEE0";

        // SmartBox::SetWorldAmbientLight(float intensity, uint color) (thiscall) -- the single
        // ambient funnel. ACBindings SmartBox.cs 'n(float,uint) @0x004530E0'.
        public const nint SetWorldAmbientLight_VA = 0x004530E0;
        public const string? SetWorldAmbientLight_Sig = "PLACEHOLDER: prologue at 0x004530E0";

        // SceneTool::EndFrame(bool bDrawUI) (CDECL) -- the post-3D / pre-UI boundary, where the
        // bloom composite runs (BeginScene open, backbuffer bound). ACBindings SceneTool.cs
        // 'EndFrame(byte) @0x0043FCD0'. (research-bloom-hook-point.md)
        public const nint EndFrame_VA = 0x0043FCD0;
        public const string? EndFrame_Sig = "PLACEHOLDER: prologue at 0x0043FCD0";

        // RenderDeviceD3D::EndScene(this) (thiscall) -- scene-closed capture point (pre-Present).
        // ACBindings RenderDeviceD3D.cs EndScene @0x005A0E10.
        public const nint EndScene_VA = 0x005A0E10;
        public const string? EndScene_Sig = "PLACEHOLDER: prologue at 0x005A0E10";

        // ─── P3 glow dynamic lights (Services/GlowLights.cs) ───────────────────────────────
        // SmartBox::set_viewer(const Position&, int) (thiscall) -- the per-frame dynamic-light
        // wipe+refill (acclient.c:143995: num_dynamic_lights = 0; add viewer_light;
        // CObjCell::add_dynamic_lights()). POST-detour here appends the plugin's glow lights with
        // exactly-one-frame lifetime. acclient.map RVA 0x00051C80 + 0x401000; ACBindings
        // Game/SmartBox/SmartBox.cs 'set_viewer(Position*,int) @0x00452C80'.
        public const nint SetViewer_VA = 0x00452C80;
        public const string? SetViewer_Sig = "PLACEHOLDER: prologue at 0x00452C80";

        // CObjectMaint::GetObjectA(unsigned int) -> CPhysicsObj* (thiscall) -- O(1) validated
        // lookup in the live object hash; the per-frame liveness check that lets GlowLights track
        // objects by ID instead of holding a pointer across frames. ACBindings CObjectMaint.cs.
        public const nint GetObjectA_VA = 0x00508890;
        public const string? GetObjectA_Sig = "PLACEHOLDER: prologue at 0x00508890";

        // CEnvCell::GetVisible(unsigned int) -> CEnvCell* (CDECL) -- pure hash membership test on
        // CEnvCell::visible_cell_table, the dungeon PVS. Side-effect free (unlike
        // CEnvCell::add_visible_cell, which loads a cell, and CObjCell::GetVisible, which can
        // allocate for outdoor ids). THE no-through-wall gate. acclient.map RVA 0x0012D870;
        // ACBindings Dats/DBObjs/CEnvCell.cs 'GetVisible(uint) @0x0052E870'.
        public const nint GetVisible_VA = 0x0052E870;
        public const string? GetVisible_Sig = "PLACEHOLDER: prologue at 0x0052E870";

        // SmartBox::convert_to_player_space(CPhysicsObj*, AC1Legacy::Vector3&) -> int (thiscall)
        // The client's OWN player-relative vector: guards player/object/object->cell, then
        // Position::localtolocal(&player->m_position, &result, &object->m_position, {0,0,0})
        // (acclient.c:143995 region, body at :144045). Handles cross-cell and cross-landblock
        // correctly, so GlowLights does not hand-roll the rebase. acclient.map RVA 0x00051DE0;
        // ACBindings Game/SmartBox/SmartBox.cs 'convert_to_player_space @0x00452DE0'.
        public const nint ConvertToPlayerSpace_VA = 0x00452DE0;
        public const string? ConvertToPlayerSpace_Sig = "PLACEHOLDER: prologue at 0x00452DE0";
    }
}
