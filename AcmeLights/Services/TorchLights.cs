using System;
using System.Diagnostics;
using AcmeLights.Lib;
using Microsoft.Extensions.Logging;

namespace AcmeLights.Services {
    /// <summary>
    /// P3 quick win: light every visible DAT object that ships with setup lights but LIGHTS_ON
    /// unset. A wall torch is a CPhysicsObj whose CSetup has num_lights &gt; 0 plus PhysicsState bit
    /// 0x800; retail servers set the bit via set_state / SetLightHook, but many ACE statics arrive
    /// unlit. Each post-world-render pass (the m_renderingCallback slot, after the frame's draws)
    /// we walk SmartBox's visible-object list and call CPhysicsObj::set_lights(obj, 1, 0) on the
    /// unlit ones — InitLights + AddLightsToCell run once per object (the 0x800 gate stops repeats),
    /// and the light lands in the global pool next frame.
    ///
    /// Enumeration source: CObjectMaint::object_table — the intrusive LongHash of every live
    /// CPhysicsObj (SmartBox::num_objects/objects is VESTIGIAL: only ever zeroed in Reset, never
    /// appended; a walk of it sees 0 forever). CPhysicsObj derives LongHashData {vfptr@0,
    /// hash_next@4, id@8}, so the node IS the object and chains via +4.
    ///
    /// Byte offsets PDB-verified against acclient.txt (fieldlists: SmartBox 0x5eb3, CObjectMaint
    /// 0x5aa2, HashBase&lt;ulong&gt; 0x9537, CPhysicsObj 0x11a19, CPartArray 0x120f1, CSetup 0x15827).
    /// NOTE the CPartArray research-doc sketch was wrong (lights at +0x2C); the PDB has sequence
    /// inline at +8..79, setup @84, lights @112.
    /// Caveat: if the server later clears 0x800 (an extinguish), we re-light it on the next scan.
    /// </summary>
    internal static unsafe class TorchLights {
        private const int SbObjMaint = 172;      // SmartBox::m_pObjMaint
        private const int OmObjectTable = 132;   // CObjectMaint::object_table (LongHash<CPhysicsObj>)
        private const int HtBuckets = 12;        // HashBase<ulong>::buckets
        private const int HtTableSize = 16;      // HashBase<ulong>::table_size
        private const int NodeHashNext = 4;      // LongHashData::hash_next
        private const int ObjPartArray = 16;     // CPhysicsObj::part_array
        private const int ObjState = 168;        // CPhysicsObj::state (PhysicsState)
        private const int PaSetup = 84;          // CPartArray::setup
        private const int SetupNumLights = 144;  // CSetup::num_lights
        private const uint StateLightsOn = 0x800;
        // CPhysicsObj::set_lights(int lights_on, int send_event) — map-build VA, same as the
        // ACBindings Generated/Physics/CPhysicsObj.cs binding.
        private const nint SetLightsVA = 0x005107C0;

        private static readonly Stopwatch _clock = Stopwatch.StartNew();
        private static long _lastLog = -Stopwatch.Frequency * 5;
        private static long _lastScan = -Stopwatch.Frequency;
        private static int _litTotal;

        /// <summary>Called from the rendering-callback slot (render thread — the client is
        /// single-threaded, so the object table is quiescent here). Scans at 4 Hz. Never throws.</summary>
        public static void OnPostWorldRender(LightsConfig cfg, ILogger? log) {
            if (cfg.TorchLights <= 0.5f) return;
            long now = _clock.ElapsedTicks;
            if (now - _lastScan < Stopwatch.Frequency / 4) return;
            _lastScan = now;
            try {
                ACBindings.Internal.SmartBox** pp = ACBindings.Internal.SmartBox.smartbox;
                if (pp == null || *pp == null) return;
                byte* maint = *(byte**)((byte*)(*pp) + SbObjMaint);
                if (maint == null) return;
                byte** buckets = *(byte***)(maint + OmObjectTable + HtBuckets);
                uint tableSize = *(uint*)(maint + OmObjectTable + HtTableSize);
                if (buckets == null || tableSize == 0 || tableSize > 1_000_000) return;
                bool extinguish = cfg.TorchLights >= 1.5f;   // diagnostic: prove the path visibly
                int seen = 0, lit = 0, withLights = 0;
                for (uint b = 0; b < tableSize; b++) {
                    for (byte* o = buckets[b]; o != null && seen < 100_000; o = *(byte**)(o + NodeHashNext)) {
                        seen++;
                        byte* pa = *(byte**)(o + ObjPartArray);
                        if (pa == null) continue;
                        byte* setup = *(byte**)(pa + PaSetup);
                        if (setup == null) continue;
                        if (*(uint*)(setup + SetupNumLights) == 0) continue;
                        withLights++;
                        bool on = (*(uint*)(o + ObjState) & StateLightsOn) != 0;
                        if (on == !extinguish) continue;
                        ((delegate* unmanaged[Thiscall]<byte*, int, int, void>)SetLightsVA)(o, extinguish ? 0 : 1, 0);
                        lit++;
                    }
                }
                _litTotal += lit;
                // Log immediately when something new lit; otherwise a 10s heartbeat proves the walk
                // runs and shows the candidate counts (offset sanity: withLights>0 near any torch).
                if ((lit > 0 && now - _lastLog >= Stopwatch.Frequency) ||
                    now - _lastLog >= Stopwatch.Frequency * 10) {
                    _lastLog = now;
                    log?.LogInformation("acmelights: torch-on scan {N} objs, {W} with setup lights, lit {L} now ({T} total)",
                        seen, withLights, lit, _litTotal);
                }
            }
            catch { /* never unwind into the client */ }
        }
    }
}
