using System;
using System.Runtime.InteropServices;
using AcmeLights.Lib;
using Microsoft.Extensions.Logging;

namespace AcmeLights.Services {
    /// <summary>
    /// Residency governor for crash family B (32-bit address-space exhaustion under the r9 dense
    /// dats — HANDOFF-2026-08-23-crash-investigation.md, design in
    /// RESEARCH-2026-08-23-residency-governor.md).
    ///
    /// The client already has per-DB_TYPE DBOCache residency with refcounts and a bounded LRU
    /// freelist of DEAD (refcount-0) objects kept for reuse — what it lacks is any memory-pressure
    /// feedback: the freelist budgets are fixed 2005-era COUNTS (RENDERSURFACE/SURFACETEXTURE keep
    /// up to 400 dead textures EACH), so r9-sized assets pin hundreds of MB of dead memory and the
    /// portal-in double-residency spike blows the heap. Three tiers, all on retail's own primitives:
    ///
    ///  1. BUDGET RIGHTSIZING (always-on): write smaller nIdealSize/nMaxSize into each fat cache's
    ///     m_freelistDef. DBOCache::FreelistAdd self-enforces nMaxSize (overflow destroys the
    ///     oldest — read-verified in acclient.c), so the caps keep working during portal loading
    ///     even while this callback isn't firing. This is the load-bearing tier.
    ///  2. WATERMARK TRIM (1 Hz, in-world): when this process's free virtual address space drops
    ///     below memlowmb, DBCache::FlushFreeObjects(0) empties every freelist NOW. Structurally
    ///     safe: the flush walks only refcount-0 freelist members. Hysteresis + cooldown.
    ///  3. EMERGENCY (below memcritmb): KeepFreeObjects(false,0) — retail's own shutdown call, every
    ///     future free becomes an immediate destroy — plus UnloadCellData(), held until recovery.
    ///
    /// Cache maintenance, sim and render share ONE thread (CLCache::UseTime runs inside
    /// Client::UseTime with the draw calls — proven by the usetime-disable-frame-draw exe patch),
    /// so calling the statics from the rendering callback races nothing.
    ///
    /// Fail-safe: a one-time layout probe (GetDBOCache(6) non-null AND its m_dbtype field @120
    /// reads 6) must pass before ANY native is called or budget written; on failure the governor
    /// logs loudly and permanently disables itself. `memgov=0` at boot = never touches anything;
    /// live 1→0 restores the saved retail budgets and re-enables freelisting.
    /// </summary>
    internal static unsafe class MemoryGovernor {
        // DBOCache field offsets (PDB fieldlist 0x4e44, read-verified 2026-08-23):
        //   @120 m_dbtype  @244 m_freelistDef{ @248 nIdealSize @252 nMaxSize }
        //   @264 m_nFree   @268 m_nTotalCount
        private const int OffDbType = 120;
        private const int OffIdealSize = 248;
        private const int OffMaxSize = 252;
        private const int OffNFree = 264;
        private const int OffNTotal = 268;

        // Governed cache groups: cfg knob → DB_TYPE values (numbers from the MasterDBMap
        // registration in acclient.c; 11/12 are the r9 texture bulk).
        private static readonly uint[] TypesTex = { 11, 12 };       // SURFACETEXTURE, RENDERSURFACE
        private static readonly uint[] TypesGfx = { 6 };            // GFXOBJ
        private static readonly uint[] TypesSurf = { 13 };          // SURFACE
        private static readonly uint[] TypesLand = { 1, 2, 3 };     // LAND_BLOCK, LBI, CELL
        private static readonly uint[] TypesScene = { 27 };         // SCENE
        // Telemetry set (memlog heartbeat): the caches worth watching, in print order.
        private static readonly uint[] TypesTelemetry = { 1, 2, 3, 6, 7, 8, 10, 11, 12, 13, 16, 27 };
        private static readonly string[] TelemetryNames =
            { "lb", "lbi", "cell", "gfx", "setup", "anim", "pal", "stex", "rsurf", "surf", "env", "scene" };

        private static delegate* unmanaged[Cdecl]<uint, nint> _getCache;        // DBCache::GetDBOCache
        private static delegate* unmanaged[Stdcall]<uint, void> _flushFree;     // DBCache::FlushFreeObjects
        private static delegate* unmanaged[Stdcall]<byte, uint, byte> _keepFree;// DBCache::KeepFreeObjects
        private static delegate* unmanaged[Cdecl]<byte> _unloadCell;            // DBCache::UnloadCellData

        private static bool _probed;            // init probe attempted
        private static bool _dead;              // probe failed or a call faulted — never touch natives again
        private static bool _wasOn;             // memgov was >0.5 last tick (for live-off restore)
        private static bool _critHold;          // tier 3 active (freelisting disabled process-wide)
        private static long _lastTick;          // 1 Hz throttle (Environment.TickCount64)
        private static long _lastTrimMs;        // tier-2 cooldown stamp
        private static bool _trimArmed = true;  // tier-2 hysteresis
        private static long _lastTelemetryMs;

        // Saved retail budgets (per governed type) for live-off restore. Index = dbtype.
        private static readonly System.Collections.Generic.Dictionary<uint, (uint ideal, uint max)> _saved = new();
        // Last cap applied per group, to detect cfg changes without rewriting every tick.
        private static float _apTex = -1f, _apGfx = -1f, _apSurf = -1f, _apLand = -1f, _apScene = -1f;

        // ── Measurement (retargeted 2026-08-23 per ANALYSIS-2026-08-23-familyB-yaraq-dump.md):
        // the Yaraq dump proved family B is FRAGMENTATION, not exhaustion — priv=1363MB died while
        // a fresh session survived priv=2344MB, and ullAvailVirtual said "1.35GB free" while the
        // largest contiguous free block was 1.11MB. So the triggers read the two resources that
        // actually die: committed-private bytes (heap growth pressure) and the LOW-2GB largest
        // contiguous free block (the canary that degraded from 73MB to 1.11MB over the session).
        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_MEMORY_COUNTERS_EX {
            public uint cb, PageFaultCount;
            public nuint PeakWorkingSetSize, WorkingSetSize,
                         QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage,
                         QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage,
                         PagefileUsage, PeakPagefileUsage, PrivateUsage;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool K32GetProcessMemoryInfo(nint hProcess,
            ref PROCESS_MEMORY_COUNTERS_EX counters, uint size);
        [DllImport("kernel32.dll")]
        private static extern nint GetCurrentProcess();

        [StructLayout(LayoutKind.Sequential)]
        private struct MEMORY_BASIC_INFORMATION {
            public nint BaseAddress, AllocationBase;
            public uint AllocationProtect;
            public nuint RegionSize;
            public uint State, Protect, Type;
        }
        [DllImport("kernel32.dll")]
        private static extern nuint VirtualQuery(nint lpAddress,
            out MEMORY_BASIC_INFORMATION lpBuffer, nuint dwLength);

        private const uint MEM_FREE = 0x10000;
        private static long _lastWalkMs;
        private static uint _lastFreeLowMb = uint.MaxValue;   // sticky between walks

        private static uint PrivMb() {
            var c = new PROCESS_MEMORY_COUNTERS_EX { cb = (uint)sizeof(PROCESS_MEMORY_COUNTERS_EX) };
            return K32GetProcessMemoryInfo(GetCurrentProcess(), ref c, c.cb)
                ? (uint)((ulong)c.PrivateUsage >> 20) : 0u;
        }

        /// <summary>Largest contiguous free region below 2 GB, in MB. ~1-2ms VirtualQuery walk,
        /// so callers gate the cadence (5 s calm / 1 s under pressure).</summary>
        private static uint WalkLargestFreeLowMb() {
            nuint largest = 0;
            nint addr = 0x10000;
            while ((nuint)addr < 0x7FFE0000u) {
                if (VirtualQuery(addr, out var mbi, (nuint)sizeof(MEMORY_BASIC_INFORMATION)) == 0) break;
                if (mbi.State == MEM_FREE && mbi.RegionSize > largest) largest = mbi.RegionSize;
                nint next = (nint)((nuint)mbi.BaseAddress + mbi.RegionSize);
                if (next <= addr) break;               // overflow / stuck guard
                addr = next;
            }
            return (uint)(largest >> 20);
        }

        /// <summary>Per-frame entry (rendering callback, render thread). Self-throttles to 1 Hz.
        /// Never throws.</summary>
        public static void OnPostWorldRender(LightsConfig cfg, ILogger? log) {
            try {
                long now = Environment.TickCount64;
                if (now - _lastTick < 1000) return;
                _lastTick = now;

                bool on = cfg.MemGov > 0.5f;
                if (!on) {
                    if (_wasOn) LiveOff(log);
                    return;
                }
                _wasOn = true;

                if (!_probed) Probe(log);
                if (_dead) return;

                ApplyBudgets(cfg, log);

                uint privMb = PrivMb();
                // Walk the low-2GB free map at 5 s when calm, 1 s once priv is in the attention
                // zone (the walk is 1-2ms of VirtualQuery syscalls — cheap enough near danger,
                // not worth paying every second at a calm 1.5GB).
                bool attention = privMb >= cfg.MemHighMb;
                if (now - _lastWalkMs >= (attention ? 1000 : 5000) || _lastFreeLowMb == uint.MaxValue) {
                    _lastWalkMs = now;
                    _lastFreeLowMb = WalkLargestFreeLowMb();
                }
                uint freeLowMb = _lastFreeLowMb;
                bool healthy = privMb < cfg.MemHighMb && freeLowMb > 2f * cfg.MemFragMb;

                // Tier 3 — emergency: disable freelisting process-wide (every free = immediate
                // destroy; the false transition itself flushes) + drop the cell caches.
                if ((privMb > cfg.MemCritMb || freeLowMb < cfg.MemCritFragMb) && !_critHold) {
                    _critHold = true;
                    _keepFree(0, 0);
                    _unloadCell();
                    log?.LogWarning("acmelights: memgov CRITICAL priv={P}MB lfree={F}MB (crit {C}MB/{CF}MB) — freelisting OFF + cells unloaded",
                        privMb, freeLowMb, (uint)cfg.MemCritMb, (uint)cfg.MemCritFragMb);
                }
                else if (_critHold && healthy) {
                    _critHold = false;
                    _keepFree(1, 0);
                    log?.LogInformation("acmelights: memgov recovered priv={P}MB lfree={F}MB — freelisting back ON",
                        privMb, freeLowMb);
                }

                // Tier 2 — watermark trim with hysteresis + cooldown. Freeing the dead residency
                // buffers (15.8MB direct allocations) returns big contiguous regions, so the trim
                // genuinely repairs the largest-free-block metric, not just the byte count.
                if (healthy) _trimArmed = true;
                if ((privMb > cfg.MemLowMb || freeLowMb < cfg.MemFragMb) && !_critHold
                    && (_trimArmed || now - _lastTrimMs > (long)(cfg.MemTrimCooldown * 1000f))) {
                    _trimArmed = false;
                    _lastTrimMs = now;
                    _flushFree(0);
                    uint privAfter = PrivMb();
                    _lastFreeLowMb = WalkLargestFreeLowMb();
                    _lastWalkMs = now;
                    log?.LogInformation("acmelights: memgov trim priv {A}->{B}MB lfree {F}->{G}MB (low={L}MB frag={FR}MB)",
                        privMb, privAfter, freeLowMb, _lastFreeLowMb, (uint)cfg.MemLowMb, (uint)cfg.MemFragMb);
                }

                if (cfg.MemLog > 0.5f && now - _lastTelemetryMs >= 5000) {
                    _lastTelemetryMs = now;
                    Telemetry(privMb, freeLowMb, log);
                }
            }
            catch (Exception ex) {
                // One strike: a fault anywhere near the natives means wrong build/layout — stop.
                _dead = true;
                try { var l = log; l?.LogError("acmelights: memgov FAULT — self-disabled ({M})", ex.Message); }
                catch { }
            }
        }

        /// <summary>Plugin unload: restore retail budgets + freelisting. Safe if never active.</summary>
        public static void Shutdown(ILogger? log) {
            try { if (_wasOn && !_dead && _probed) LiveOff(log); } catch { }
        }

        private static void Probe(ILogger? log) {
            _probed = true;
            _getCache = (delegate* unmanaged[Cdecl]<uint, nint>)ClientFunctions.DBCacheGetDBOCache_VA;
            _flushFree = (delegate* unmanaged[Stdcall]<uint, void>)ClientFunctions.DBCacheFlushFreeObjects_VA;
            _keepFree = (delegate* unmanaged[Stdcall]<byte, uint, byte>)ClientFunctions.DBCacheKeepFreeObjects_VA;
            _unloadCell = (delegate* unmanaged[Cdecl]<byte>)ClientFunctions.DBCacheUnloadCellData_VA;
            nint c = _getCache(6);
            if (c == 0 || *(int*)(c + OffDbType) != 6) {
                _dead = true;
                log?.LogError("acmelights: memgov layout probe FAILED (cache6=0x{P:X}, dbtype={T}) — governor disabled",
                    c, c != 0 ? *(int*)(c + OffDbType) : -1);
                return;
            }
            log?.LogInformation("acmelights: memgov probe OK (gfxobj cache @0x{P:X} free={F} total={T})",
                c, *(int*)(c + OffNFree), *(int*)(c + OffNTotal));
        }

        private static void ApplyBudgets(LightsConfig cfg, ILogger? log) {
            if (cfg.MemCapTex != _apTex) { _apTex = cfg.MemCapTex; CapGroup(TypesTex, cfg.MemCapTex, log); }
            if (cfg.MemCapGfx != _apGfx) { _apGfx = cfg.MemCapGfx; CapGroup(TypesGfx, cfg.MemCapGfx, log); }
            if (cfg.MemCapSurf != _apSurf) { _apSurf = cfg.MemCapSurf; CapGroup(TypesSurf, cfg.MemCapSurf, log); }
            if (cfg.MemCapLand != _apLand) { _apLand = cfg.MemCapLand; CapGroup(TypesLand, cfg.MemCapLand, log); }
            if (cfg.MemCapScene != _apScene) { _apScene = cfg.MemCapScene; CapGroup(TypesScene, cfg.MemCapScene, log); }
        }

        /// <summary>cap > 0: write nMaxSize=cap, nIdealSize=cap/2 (min 1). cap == 0: restore the
        /// retail budget saved at first write. FreelistAdd's own overflow check converges the cache
        /// to a smaller cap organically; no flush needed.</summary>
        private static void CapGroup(uint[] types, float cap, ILogger? log) {
            foreach (uint t in types) {
                nint p = _getCache(t);
                if (p == 0 || *(int*)(p + OffDbType) != (int)t) continue;   // never write a mismatched layout
                uint* ideal = (uint*)(p + OffIdealSize);
                uint* max = (uint*)(p + OffMaxSize);
                if (!_saved.ContainsKey(t)) _saved[t] = (*ideal, *max);
                uint newMax, newIdeal;
                if (cap > 0.5f) { newMax = (uint)cap; newIdeal = Math.Max(1u, (uint)cap / 2u); }
                else { (newIdeal, newMax) = _saved[t]; }
                if (*max != newMax || *ideal != newIdeal) {
                    log?.LogInformation("acmelights: memgov budget type{T}: ideal {OI}->{NI} max {OM}->{NM}",
                        t, *ideal, newIdeal, *max, newMax);
                    *ideal = newIdeal;
                    *max = newMax;
                }
            }
        }

        private static void LiveOff(ILogger? log) {
            _wasOn = false;
            if (_dead || !_probed) return;
            foreach (var kv in _saved) {
                nint p = _getCache(kv.Key);
                if (p == 0 || *(int*)(p + OffDbType) != (int)kv.Key) continue;
                *(uint*)(p + OffIdealSize) = kv.Value.ideal;
                *(uint*)(p + OffMaxSize) = kv.Value.max;
            }
            if (_critHold) { _critHold = false; _keepFree(1, 0); }
            _apTex = _apGfx = _apSurf = _apLand = _apScene = -1f;
            log?.LogInformation("acmelights: memgov OFF — retail budgets restored");
        }

        private static void Telemetry(uint privMb, uint freeLowMb, ILogger? log) {
            var sb = new System.Text.StringBuilder(160);
            sb.Append("acmelights: memgov priv=").Append(privMb).Append("MB lfree=").Append(freeLowMb).Append("MB");
            if (_critHold) sb.Append(" CRIT");
            for (int i = 0; i < TypesTelemetry.Length; i++) {
                nint p = _getCache(TypesTelemetry[i]);
                if (p == 0) continue;
                sb.Append(' ').Append(TelemetryNames[i]).Append(':')
                  .Append(*(int*)(p + OffNFree)).Append('/').Append(*(int*)(p + OffNTotal));
            }
            log?.LogInformation("{Line}", sb.ToString());
        }
    }
}
