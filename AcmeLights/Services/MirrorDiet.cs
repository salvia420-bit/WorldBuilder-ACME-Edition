using System;
using AcmeLights.Lib;
using Microsoft.Extensions.Logging;

namespace AcmeLights.Services {
    /// <summary>
    /// THE RGBA-MIRROR DIET (HANDOFF-2026-08-24-mirror-diet-design.md). The client keeps a
    /// permanent CPU mirror per texture — `ImgTex::m_pSystemMemTexture`, a D3DPOOL_SYSTEMMEM
    /// texture the D3D runtime allocates in NT heap — purely so `GetD3DTexture` can refill the
    /// DEFAULT-pool `m_pRenderTexture` via UpdateTexture after a device loss. The Yaraq dump put
    /// that population at ~556 MiB in towns (page-truth split in
    /// RESEARCH-2026-08-24-rgba-split-dump.md), all regenerable from DAT / re-merge / re-Combine.
    /// This service frees those mirrors once the GPU copy exists, changing zero pixels.
    ///
    /// TWO pieces:
    ///  1. A thiscall detour on `ImgTex::GetD3DTexture` (0x0053F310, ACBindings-verified) adding
    ///     the fast path retail lacks: mirror NULL + healthy render texture → return the render
    ///     texture. WITHOUT this, retail's own body treats a NULL mirror as "tear down": it
    ///     RELEASES the healthy DEFAULT texture and returns NULL (acclient.c :365416 LABEL_20,
    ///     read-verified) — the reason a naive free breaks rendering. The fast path is NOT gated
    ///     on the knob: once any mirror is freed it must stay active, and it is unreachable in
    ///     stock state (mirror and render texture are only ever null TOGETHER there).
    ///  2. A 1 Hz sweep (rendering callback, render thread — same thread as all of retail's own
    ///     texture create/release traffic, so nothing races) over `GraphicsResource::s_Resources`
    ///     (0x008398C4, SmartArray of GraphicsResource* subobject pointers). ImgTex entries are
    ///     recognized by their GraphicsResource-subobject vfptr, CALIBRATED AT RUNTIME from a
    ///     known ImgTex out of `ImgTex::custom_texture_table` (0x0081FA80) — no hardcoded vtable
    ///     constants. Frees use retail's own teardown call, `DBObj::Release` (0x00415400): the
    ///     runtime-created mirror has no maintainer, so Release refcounts down and virtually
    ///     destroys — byte-identical to what GetD3DTexture's LABEL_20 does.
    ///
    /// `diet` knob: 0 = off (sweep only; the fast path stays). 1 = PROBE — inventory log only,
    /// frees nothing. 2 = free mirrors of DAT-id textures (m_DID != 0 — the safest class:
    /// ImgTex::RestoreResource rebuilds them from the DAT on loss). 3 = also runtime-generated
    /// textures (m_DID == 0: TexMerge merges + palette-combined outputs — regenerable via
    /// CSurface::RestoreLostSurface / re-Combine on a device reset).
    ///
    /// Skips (per-entry): already dieted, no render texture yet (mirror is the SOLE copy),
    /// either object lost, ImgTex locked. CPU-only palettized sources (PFID 41/101/243/244)
    /// never have a mirror, so the exemption is structural. Known caveat (documented, accepted
    /// for the default-OFF experiment): if VRAM pressure ever discards a dieted texture's
    /// DEFAULT copy outside a device reset, that texture renders null until relog — on the 8 GB
    /// 1070 the discard path (D3DERR_OUTOFVIDEOMEMORY retry) should never fire.
    ///
    /// Fail-safe: a one-time probe must validate the layout (a calibration ImgTex's
    /// m_ListIndex must round-trip through s_Resources) before anything is freed; any fault
    /// permanently disables the sweep. The detour body never throws and never unwinds into the
    /// client.
    /// </summary>
    internal static unsafe class MirrorDiet {
        // ── deployed-exe addresses (ACBindings-verified; map cross-checked at +0x401000) ──
        private const nint GetD3DTexture_VA = 0x0053F310;     // ImgTex::GetD3DTexture (thiscall)
        private const nint Get2DTextureD3D_VA = 0x006968D0;   // RenderTextureD3D::Get2DTextureD3D
        private const nint DBObjRelease_VA = 0x00415400;      // DBObj::Release (thiscall)
        private const nint SResources_VA = 0x008398C4;        // SmartArray<GraphicsResource*>
        private const nint CustomTexTable_VA = 0x0081FA80;    // HashSet<ImgTex*>
        private const nint TimerLocalTime_VA = 0x008379B0;    // double Timer::local_time

        // ── layout (PDB fieldlists 0x4e11 DBObj / 0x78df GraphicsResource / 0x7972 ImgTex;
        //    DBObj = 48 bytes, GraphicsResource subobject at +48) ──
        private const int OffDid = 40;            // DBObj.m_DID.id
        private const int OffGr = 48;             // GraphicsResource subobject (vfptr at +0)
        private const int OffIsLost = 48 + 8;     // GR.m_bIsLost (byte)
        private const int OffTimeUsed = 48 + 16;  // GR.m_TimeUsed (double)
        private const int OffListIndex = 48 + 36; // GR.m_ListIndex (int)
        private const int OffResourceSize = 48 + 32; // GR.m_nResourceSize (uint)
        private const int OffRenderTex = 124;     // ImgTex.m_pRenderTexture
        private const int OffSysMemTex = 128;     // ImgTex.m_pSystemMemTexture
        private const int OffIsLocked = 132;      // ImgTex.m_IsLocked (bool)
        // HashSet<ImgTex*>: intrusive table at +4; buckets ptr +100, numBuckets +108.
        private const int OffHsBuckets = 100;
        private const int OffHsNumBuckets = 108;

        private static delegate* unmanaged[Thiscall]<nint, nint> _get2D;
        private static delegate* unmanaged[Thiscall]<nint, int> _release;

        private static bool _probed, _dead;
        private static nint _imgTexGrVfptr;       // runtime-calibrated ImgTex GR-subobject vtable
        private static long _lastTick, _lastLogMs;
        private static long _freedCount, _freedBytes;   // cumulative

        // ── the detour fast path (installed by NativeHooks.InstallDiet; body in NativeHooks
        //    calls TryFastPath then chains). Returns 0 when the original must run. ──
        public static nint TryFastPath(nint self) {
            // Unreachable in stock state: mirror==NULL with a live healthy render texture only
            // exists after this service freed the mirror. Everything else falls through.
            if (*(nint*)(self + OffSysMemTex) != 0 || *(byte*)(self + OffIsLost) != 0)
                return 0;
            nint rt = *(nint*)(self + OffRenderTex);
            if (rt == 0 || *(byte*)(rt + OffIsLost) != 0)
                return 0;
            *(double*)(self + OffTimeUsed) = *(double*)TimerLocalTime_VA;   // retail's use-stamp
            var f = _get2D;
            if (f == null) return 0;
            nint tex = f(rt);
            // NULL here would mean the wrapper lost its D3D object without m_bIsLost — let the
            // original run its full logic rather than returning null ourselves.
            return tex;
        }

        /// <summary>1 Hz sweep entry (rendering callback). Never throws.</summary>
        public static void OnPostWorldRender(LightsConfig cfg, ILogger? log) {
            try {
                int mode = (int)cfg.Diet;
                if (mode <= 0 || _dead) return;
                long now = Environment.TickCount64;
                if (now - _lastTick < 1000) return;
                _lastTick = now;

                if (!_probed && !Probe(log)) return;   // retries until a calibration ImgTex exists

                var arr = (nint*)SResources_VA;
                nint data = arr[0];
                int num = *(int*)(SResources_VA + 8);
                if (data == 0 || num <= 0) return;

                int imgs = 0, withMirror = 0, didZero = 0, freed = 0;
                long mirrorBytes = 0, freedBytes = 0;
                for (int i = 0; i < num; i++) {
                    nint gr = ((nint*)data)[i];
                    if (gr == 0 || *(nint*)gr != _imgTexGrVfptr) continue;
                    nint img = gr - OffGr;
                    imgs++;
                    nint mirror = *(nint*)(img + OffSysMemTex);
                    if (mirror == 0) continue;
                    withMirror++;
                    uint did = *(uint*)(img + OffDid);
                    if (did == 0) didZero++;
                    mirrorBytes += *(uint*)(mirror + OffResourceSize);
                    if (mode == 1) continue;                          // probe: inventory only
                    if (did == 0 && mode < 3) continue;               // runtime-generated: mode 3
                    nint rt = *(nint*)(img + OffRenderTex);
                    if (rt == 0) continue;                            // mirror is the sole copy
                    if (*(byte*)(img + OffIsLost) != 0 || *(byte*)(rt + OffIsLost) != 0) continue;
                    if (*(byte*)(img + OffIsLocked) != 0) continue;
                    uint bytes = *(uint*)(mirror + OffResourceSize);
                    *(nint*)(img + OffSysMemTex) = 0;                 // detach BEFORE release
                    _release(mirror);
                    freed++;
                    freedBytes += bytes;
                }
                _freedCount += freed;
                _freedBytes += freedBytes;

                if (now - _lastLogMs >= 5000) {
                    _lastLogMs = now;
                    AsyncLog.Post("acmelights: diet mode=" + mode + " imgtex=" + imgs
                        + " mirrors=" + withMirror + " (" + (mirrorBytes >> 20) + "MB, did0="
                        + didZero + ") freed+" + freed + " (" + (freedBytes >> 20)
                        + "MB) cum=" + _freedCount + "/" + (_freedBytes >> 20) + "MB");
                }
            }
            catch (Exception ex) {
                _dead = true;
                try { log?.LogError("acmelights: diet sweep FAULT — self-disabled ({M})", ex.Message); }
                catch { }
            }
        }

        /// <summary>Calibrate the ImgTex GR vfptr from custom_texture_table and validate the
        /// layout by round-tripping m_ListIndex through s_Resources. False = try again later
        /// (table empty); _dead = layout mismatch, never touch anything.</summary>
        private static bool Probe(ILogger? log) {
            _get2D = (delegate* unmanaged[Thiscall]<nint, nint>)Get2DTextureD3D_VA;
            _release = (delegate* unmanaged[Thiscall]<nint, int>)DBObjRelease_VA;

            nint buckets = *(nint*)(CustomTexTable_VA + OffHsBuckets);
            int numBuckets = *(int*)(CustomTexTable_VA + OffHsNumBuckets);
            nint img = 0;
            if (buckets != 0 && numBuckets > 0 && numBuckets < (1 << 20)) {
                for (int i = 0; i < numBuckets && img == 0; i++) {
                    nint node = ((nint*)buckets)[i];
                    if (node != 0) img = *(nint*)node;    // IntrusiveHashData.m_hashKey = ImgTex*
                }
            }
            if (img == 0) return false;                    // nothing merged yet — retry later

            nint grVf = *(nint*)(img + OffGr);
            int listIdx = *(int*)(img + OffListIndex);
            nint data = *(nint*)SResources_VA;
            int num = *(int*)(SResources_VA + 8);
            bool ok = grVf != 0 && data != 0 && listIdx >= 0 && listIdx < num
                      && ((nint*)data)[listIdx] == img + OffGr;
            if (!ok) {
                _dead = true;
                log?.LogError("acmelights: diet layout probe FAILED (img=0x{I:X} listIdx={L} num={N}) — diet disabled",
                    img, listIdx, num);
                return false;
            }
            _probed = true;
            _imgTexGrVfptr = grVf;
            log?.LogInformation("acmelights: diet probe OK (ImgTex GR-vfptr=0x{V:X}, s_Resources n={N})",
                grVf, num);
            return true;
        }
    }
}
