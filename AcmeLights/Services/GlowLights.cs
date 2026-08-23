using System;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using ACBindings.Internal;
using AcmeLights.Lib;
using Microsoft.Extensions.Logging;

namespace AcmeLights.Services {
    /// <summary>
    /// P3 — GLOW DYNAMIC LIGHTS. Makes the things that only *look* bright actually cast light:
    /// portals, war-spell projectiles in flight, their impact flashes, and glowing creatures
    /// (wisps, elementals, spectral undead).
    ///
    /// ── WHAT THE GAP ACTUALLY IS ─────────────────────────────────────────────────────────────
    /// The obvious story ("retail never lights these") is only half true, and the half that is
    /// false is the interesting one. A retail portal weenie ships PhysicsState 0xC0C — which
    /// includes LIGHTING_ON (0x800) — on a CSetup that carries an authored `lights` block
    /// (setup 0x020001B3: RGB(200,0,200), intensity 100, falloff 6). War-spell projectiles ship
    /// 0x28B48, LIGHTING_ON included, on setups with authored lights too. So
    /// CPartArray::InitLights (acclient.c:326321) really does build their LIGHTLIST and
    /// CPartArray::AddLightsToCell really does hang it on the CObjCell.
    ///
    /// It then goes nowhere, because the per-frame refill only asks EnvCells:
    ///   SmartBox::set_viewer → CObjCell::add_dynamic_lights (a 5-byte tailcall,
    ///   acclient_2013 pseudo-C @0052ad80) → CEnvCell::add_dynamic_lights (acclient.c:349094),
    ///   which iterates ONLY `CEnvCell::visible_cell_table`. Outdoors that table holds building
    ///   interiors — never the CLandCell you and the portal are standing in
    ///   (CLandCell::grab_visible_cells → LScape::grab_visible_cells, acclient.c:354904/306571).
    /// So OUTDOORS every object dynamic light in the world is silently dropped: the Holtburg town
    /// portal, a Flame Bolt crossing a field, a wisp in the open all cast exactly nothing.
    /// Indoors the client delivers them properly, and we must not double-light.
    ///
    /// This class therefore (a) re-donates the authored light for objects whose cell the client
    /// will never ask, and (b) synthesises one for the visibly-luminous objects that were never
    /// authored a light at all (the classic wisps: setup 0x0200059A etc., one part, one surface,
    /// Luminosity 1.0, no `lights` block).
    ///
    /// ── CLASSIFICATION (data-driven; no wcid tables) ─────────────────────────────────────────
    /// Verdict is memoised per CSetup DID — the surface walk runs ONCE per setup, never per frame.
    ///   1. AUTHORED: CSetup::num_lights (+144) > 0 → take colour / intensity / falloff / local
    ///      offset straight out of CSetup::lights[0] (+148, LIGHTINFO[104]). Retail-faithful by
    ///      construction, and per-portal-correct (the coloured dungeon-portal family
    ///      0x020005D2..D6 authors blue/green/orange/red/yellow lights individually).
    ///   2. LUMINOUS: peak surface Luminosity >= `glowlum` (0.9) AND the luminous fraction of the
    ///      object's surfaces >= `glowlumfrac` (0.25). The fraction test is what makes this safe:
    ///      over all 693 creature setups in the LSD dump, bare `luminosity > 0` fires on 19% —
    ///      mostly a single glowing eye or gem on an ordinary body (Olthoi Worker: 1 lit surface
    ///      of 28) — while lum>=0.9 AND frac>=0.25 fires on 5.9% and hits none of ten mundane
    ///      controls (human NPC, Drudge, Rat, Tusker, Gromnie, Skeleton, Shadow, Zombie, Virindi,
    ///      Olthoi). Colour is then derived from the luminous surfaces: `color_value` for a
    ///      BASE1_SOLID surface, else a brightness-weighted average of its palette.
    /// A "glowing" verdict is required for EVERY class — so a destroyed portal (setup 0x020019E4,
    /// no authored light, no luminous surface) correctly stays dark.
    ///
    /// ── MECHANISM ────────────────────────────────────────────────────────────────────────────
    ///   • CLASSIFY + TRACK, 4 Hz, from the rendering-callback slot (RenderCallback.cs). Walks
    ///     CObjectMaint::object_table — the same walk TorchLights proved — and resolves each hit
    ///     to a finished (colour, intensity, falloff, local offset) tuple in a bounded, distance-
    ///     sorted tracked list. (The UpdateLightsInternal heartbeat STALLS when the scene's light
    ///     set is static; this callback fires every in-world frame.)
    ///   • INJECT, every frame, from the SmartBox::set_viewer @0x00452C80 POST-detour, which runs
    ///     after `num_dynamic_lights = 0`, after the viewer light, and after the EnvCell refill
    ///     (acclient.c:143995-144033). One-frame lifetime, no leak, correct distance sort, free
    ///     re-add next frame. Per-frame cost is proportional to TRACKED objects (usually under
    ///     10), not to all objects: one CObjectMaint::GetObjectA @0x00508890 liveness lookup, one
    ///     CEnvCell::GetVisible @0x0052E870 containment probe and one add_dynamic_light each.
    ///     Zero allocation, no logging, no exception may escape.
    ///
    /// ── THE NO-THROUGH-WALL PROOF (docs/lights-port/P3-GLOWLIGHTS-2026-08-23.md §2) ───────────
    /// The `cellId` argument of Render::add_dynamic_light does NOT contain a light. Proven:
    ///   Render::insert_light (acclient.c:380524) uses cellId for exactly two things —
    ///   LandDefs::get_block_offset(cell_from, cellId) to rebase the origin for the distance sort
    ///   (acclient.c:123110: it reads ONLY the high 16 bits = the landblock, and returns the ZERO
    ///   vector for two cells of the same landblock, i.e. any two rooms of one dungeon), and a
    ///   verbatim store into RenderLight::cellID which PrimD3DRender::config_hardware_light then
    ///   ignores. Render::minimize_object_lighting (:380659) / remove_object_light (:379672) are a
    ///   pure viewer-space sphere-overlap test; Render::minimize_envcell_lighting (:379652) enables
    ///   *every* dynamic light on *every* EnvCell drawn. An out-of-PVS light lights the wall.
    ///
    /// Retail's containment lives one level up, in WHO IS ASKED TO DONATE — the
    /// `visible_cell_table` walk above, rebuilt per cell change by CEnvCell::grab_visible_cells
    /// (acclient.c:350172) as { own cell } ∪ { stab_list[] }, the EnvCell DAT's authored
    /// VisibleCells (PVS). So this class applies retail's own rule with retail's own membership
    /// test: an indoor emitter must satisfy CEnvCell::GetVisible(cellId) != null. A glow in a room
    /// you cannot see never enters the pool, exactly as a wall torch in that room never would.
    /// cellId == 0 is rejected outright — get_block_offset's cell_to==0 path yields ~1e10 offsets.
    /// </summary>
    internal static unsafe class GlowLights {
        // ─── PDB byte offsets (acclient.txt fieldlists; PDB WINS over the research-doc sketches) ───
        // SmartBox 0x5eb3
        private const int SbViewerCellId = 12;   // SmartBox::viewer(@8).objcell_id(+4)
        private const int SbObjMaint = 172;      // SmartBox::m_pObjMaint
        private const int SbPlayer = 248;        // SmartBox::player (CPhysicsObj*)
        // CObjectMaint 0x5aa2 + HashBase<ulong> 0x9537
        private const int OmObjectTable = 132;   // CObjectMaint::object_table (LongHash<CPhysicsObj>)
        private const int HtBuckets = 12;
        private const int HtTableSize = 16;
        // CPhysicsObj 0x11a19 (LongHashData base: vfptr@0, hash_next@4, id@8)
        private const int ObjHashNext = 4;
        private const int ObjId = 8;
        private const int ObjPartArray = 16;
        private const int ObjPosCellId = 76;     // m_position(@72).objcell_id(+4)
        private const int ObjPosFrame = 80;      // m_position(@72).frame(+8)
        private const int ObjOrigin = 132;       // m_position.frame.m_fOrigin (+52 of Frame)
        private const int ObjCell = 144;         // CObjCell*
        private const int ObjState = 168;        // PhysicsState
        private const int ObjWeenie = 300;       // CWeenieObject* (concrete: ACCWeenieObject)
        // CObjCell 0x11f97
        private const int CellSeenOutside = 232;
        // CPartArray 0x120f1
        private const int PaSetup = 84;
        private const int PaNumParts = 88;
        private const int PaParts = 92;          // CPhysicsPart**
        // CSetup 0x15827 (DBObj base: m_DID@40)
        private const int SetupDid = 40;
        private const int SetupNumLights = 144;
        private const int SetupLights = 148;     // LIGHTINFO[] (stride 104)
        // LIGHTINFO (acclient.h:31688 / 0x72b4): type@0, offset Frame@4 (m_fOrigin +52 => @56),
        // viewerspace_location@68, color@80, intensity@92, falloff@96, cone_angle@100
        private const int LiStride = 104;
        private const int LiOffsetOrigin = 56;
        private const int LiColor = 80;
        private const int LiIntensity = 92;
        private const int LiFalloff = 96;
        // CPhysicsPart 0x12003
        private const int PtGfxObj = 32;         // CGfxObj** (deref twice)
        private const int PtSurfaces = 196;      // CSurface**  (count comes from CGfxObj)
        // CGfxObj 0x11fbf
        private const int GoNumSurfaces = 52;
        // CSurface 0x10ff1
        private const int SfType = 88;
        private const int SfColorValue = 96;
        private const int SfBase1Pal = 112;
        private const int SfLuminosity = 120;
        // Palette 0x14dbf
        private const int PalNumColors = 56;
        private const int PalArgb = 64;
        // ACCWeenieObject 0x13834 + PublicWeenieDesc 0x1364d (pwd@152: _wcid+12, _type+56)
        private const int WoPhysObj = 148;       // ACCWeenieObject::_phys_obj (back-pointer; our guard)
        private const int WoWcid = 164;
        private const int WoType = 208;

        // PhysicsState bits (ACBindings PhysicsState.cs)
        private const uint StStatic = 0x1, StNoDraw = 0x20, StMissile = 0x40,
                           StLightsOn = 0x800, StHidden = 0x4000, StCloaked = 0x100000;
        // SurfaceType bits (acclient.h:5820)
        private const uint SfBase1Solid = 0x1, SfLuminous = 0x40, SfAdditive = 0x10000;
        // ITEM_TYPE (acclient.h:3300)
        private const uint TypeCreature = 0x10, TypePortal = 0x10000;

        private const byte KPortal = 1, KProjectile = 2, KCreature = 3;

        private const int MaxTracked = 24;
        private const int MaxImpacts = 8;
        private const int VCap = 512;            // setup-verdict slots (power of two)
        private const int VProbe = 12;

        /// <summary>A tracked emitter, resolved at scan time to finished light parameters so the
        /// per-frame injection path does no lookups and no classification at all.</summary>
        private struct Tracked {
            public uint Id;          // CPhysicsObj id (0 = free slot)
            public uint Wcid;        // audit only (ACCWeenieObject pwd._wcid)
            public byte Kind;
            public uint Color;       // 0xRRGGBB
            public float Inten;
            public float Fall;
            public float Ox, Oy, Oz; // local offset of the light within the object's frame
            public float Phase;      // deterministic pulse phase 0..1
            public float DistSq;     // to the player, at last scan (ordering only)
            public uint LastCell;    // for the impact flash
            public float Lx, Ly, Lz;
        }

        private struct Impact {
            public uint Cell;
            public float X, Y, Z;
            public uint Color;
            public float Inten;
            public long StartTicks;
            public long DurTicks;
        }

        /// <summary>Memoised per-CSetup verdict. `Authored` is the retail-authored CSetup::lights[0];
        /// `Lum`/`Frac`/`DColor` are the surface-luminosity fallback.</summary>
        private struct Verdict {
            public uint Key;         // setup DID (0 = empty slot)
            public byte Authored;    // 1 = CSetup::num_lights > 0
            public uint AColor;
            public float AInten, AFall, AX, AY, AZ;
            public float Lum;        // peak authored surface luminosity
            public float Frac;       // luminous surfaces / total surfaces
            public uint DColor;      // colour derived from the luminous surfaces (0 = none)
        }

        private static readonly Tracked[] _tracked = new Tracked[MaxTracked];
        private static int _nTracked;
        private static readonly Impact[] _impacts = new Impact[MaxImpacts];
        private static int _nImpacts;
        private static readonly Verdict[] _v = new Verdict[VCap];

        /// <summary>Diagnostic ring for classifier misses — the 2026-08-23 live session had to
        /// bisect a silent range defect from a tracked-only log, which was expensive.</summary>
        private struct Reject {
            public byte Why; public uint Id, Wcid, Did; public float Lum, Frac, Dist;
        }
        private const int MaxRejects = 8;
        private static readonly Reject[] _rejects = new Reject[MaxRejects];
        private static int _nRejects;

        /// <summary>Per-school colour for war-spell projectile setups whose AUTHORED light is a
        /// featureless white — the DAT only bothered to colour Acid and Lightning. Every value is
        /// grounded in the DATs (see docs/lights-port/P3-GLOWLIGHTS-2026-08-23.md §4). The generic
        /// missile setup 0x0200040D is deliberately ABSENT: it is shared by Flame Bolt I-VII and
        /// by ordinary arrows, so tinting it fire-orange would tint arrows too.</summary>
        private static readonly uint[] SchoolSetups = {
            0x02000883, 0x020003F4,             // Cold  — Frost Bolt (tier 3, base)
            0x02000881, 0x02000E18,             // Fire  — Flame Bolt (tier 3, variant)
            0x02000887, 0x020003F3,             // Pierce— Force Bolt
            0x02000885, 0x020003FA,             // Bludgn— Shock Wave
            0x02000882, 0x020003F6,             // Acid  — Acid Stream
            0x02000884, 0x02000880, 0x020003F0, // Electric — Lightning Bolt
            0x02001A27, 0x02001A28, 0x02001A29, // Nether — Nether Ring/Arc/Bolt/Streak
        };
        private static readonly uint[] SchoolColors = {
            0xD5FCFF, 0xD5FCFF,                 // frost pale blue (elemental 0x02000BEF light;
                                                //   corroborated by texture 0x050012ED palette)
            0xFF6C00, 0xFF6C00,                 // fire orange (fire-elemental line 0x020006A3)
            0xFFFBA4, 0xFFFBA4,                 // force pale yellow-white (surface 0x08000D2D colorValue)
            0xF0E8D8, 0xF0E8D8,                 // shockwave warm white (texture 0x05001300 palette)
            0x009600, 0x009600,                 // acid green (authored on 0x020003F6)
            0xC800FF, 0xC800FF, 0xC800FF,       // lightning violet (authored on 0x020003F0)
            0xC800FF, 0xC800FF, 0xC800FF,       // nether violet (authored)
        };

        private static readonly Stopwatch _clock = Stopwatch.StartNew();
        private static long _lastScan = -Stopwatch.Frequency;
        private static long _lastLog = -Stopwatch.Frequency * 5;

        private static LightsConfig? _cfg;
        private static ILogger? _log;

        // Resolved client entry points (managed-thread resolution; VA fallback like the hooks).
        private static nint _pGetObjectA;   // CObjectMaint::GetObjectA(uint) -> CPhysicsObj*  (thiscall)
        private static nint _pGetVisible;   // CEnvCell::GetVisible(uint) -> CEnvCell*         (cdecl)
        private static nint _pToPlayerSpace;// SmartBox::convert_to_player_space(obj, &vec)->int (thiscall)

        // Unmanaged scratch: the LIGHTINFO handed to add_dynamic_light (Render::insert_light COPIES
        // it — Frame::combine + field copies — so one reused buffer is correct), plus a Frame used
        // as the world anchor for impact flashes (live objects donate their own m_position.frame).
        private static LIGHTINFO* _li;
        private static Frame* _impFrame;
        private static float* _vec3;        // out-param scratch for convert_to_player_space

        private static int _litFrames, _lastInjected;

        /// <summary>Managed-thread init: allocate the unmanaged scratch, resolve addresses, commit
        /// the cache arrays and pre-JIT every method reachable from the detours. MUST be called
        /// from AcmeLightsPlugin.Initialize (0x80131509 discipline).</summary>
        public static void Warmup(LightsConfig cfg, ILogger log) {
            _cfg = cfg;
            _log = log;

            if (_li == null) {
                _li = (LIGHTINFO*)NativeMemory.AllocZeroed((nuint)sizeof(LIGHTINFO));
                _li->type = (int)LIGHTINFO.LightType.POINT_LIGHT;
                _li->offset.qw = 1f; _li->offset.qx = 0f; _li->offset.qy = 0f; _li->offset.qz = 0f;
                _li->offset.cache();          // MANDATORY (CreatureMode::AddLight is the reference).
                                              // Frame::cache (acclient.c:356984) reads ONLY the
                                              // quaternion, so m_fOrigin stays free to rewrite.
                _li->cone_angle = 360f;
            }
            if (_impFrame == null) {
                _impFrame = (Frame*)NativeMemory.AllocZeroed((nuint)sizeof(Frame));
                _impFrame->qw = 1f;
                _impFrame->cache();           // identity rotation; origin written per impact
            }

            _pGetObjectA = AddressResolver.Resolve("CObjectMaint::GetObjectA",
                ClientFunctions.GetObjectA_Sig, ClientFunctions.GetObjectA_VA);
            _pGetVisible = AddressResolver.Resolve("CEnvCell::GetVisible",
                ClientFunctions.GetVisible_Sig, ClientFunctions.GetVisible_VA);
            _pToPlayerSpace = AddressResolver.Resolve("SmartBox::convert_to_player_space",
                ClientFunctions.ConvertToPlayerSpace_Sig, ClientFunctions.ConvertToPlayerSpace_VA);
            if (_vec3 == null) _vec3 = (float*)NativeMemory.AllocZeroed(12);

            // Touch the arrays so their storage is committed before any detour runs.
            for (int i = 0; i < VCap; i++) _v[i] = default;
            for (int i = 0; i < MaxTracked; i++) _tracked[i] = default;
            for (int i = 0; i < MaxImpacts; i++) _impacts[i] = default;
            for (int i = 0; i < MaxRejects; i++) _rejects[i] = default;

            foreach (var m in typeof(GlowLights).GetMethods(
                         System.Reflection.BindingFlags.Static |
                         System.Reflection.BindingFlags.Public |
                         System.Reflection.BindingFlags.NonPublic)) {
                if (m.IsAbstract || m.ContainsGenericParameters) continue;
                try { RuntimeHelpers.PrepareMethod(m.MethodHandle); } catch { }
            }
            // The ACBindings thunk the injection path calls: JIT it here, not on the render thread.
            // (Frame::cache is already JITed above by the _li->offset.cache() call.)
            try {
                var adl = typeof(Render).GetMethod("add_dynamic_light");
                if (adl != null) RuntimeHelpers.PrepareMethod(adl.MethodHandle);
            }
            catch { }

            log.LogInformation(
                "acmelights: glowlights warm (GetObjectA=0x{A:X8} GetVisible=0x{B:X8} toPlayerSpace=0x{C:X8})",
                (long)_pGetObjectA, (long)_pGetVisible, (long)_pToPlayerSpace);
        }

        public static void Dispose() {
            _nTracked = 0; _nImpacts = 0;
            if (_li != null) { NativeMemory.Free(_li); _li = null; }
            if (_impFrame != null) { NativeMemory.Free(_impFrame); _impFrame = null; }
            if (_vec3 != null) { NativeMemory.Free(_vec3); _vec3 = null; }
            _cfg = null;
        }

        // ══════════════════════════════════════════════════════════════════════════════════════
        //  INJECTION — per frame, from the SmartBox::set_viewer POST-detour.
        // ══════════════════════════════════════════════════════════════════════════════════════

        public static void OnSetViewer() {
            LightsConfig? cfg = _cfg;
            if (cfg == null || cfg.GlowLights < 0.5f) return;   // glowlights=0: bit-identical frame
            if (_li == null || _pGetObjectA == 0) return;
            if (_nTracked == 0 && _nImpacts == 0) return;
            try { InjectInternal(cfg); }
            catch { /* never unwind into the client */ }
        }

        private static void InjectInternal(LightsConfig cfg) {
            SmartBox** pp = SmartBox.smartbox;
            if (pp == null || *pp == null) return;
            byte* sb = (byte*)(*pp);
            uint viewerCell = *(uint*)(sb + SbViewerCellId);
            if (viewerCell == 0) return;
            byte* maint = *(byte**)(sb + SbObjMaint);
            if (maint == null) return;

            bool landscapeVisible = LandscapeVisible(sb, viewerCell);
            float t = (float)_clock.Elapsed.TotalSeconds;
            float gi = cfg.GlowIntensity, gf = cfg.GlowFalloffScale;
            int cap = (int)cfg.GlowMax;
            if (cap < 1) cap = 1; else if (cap > MaxTracked) cap = MaxTracked;
            int injected = 0;
            bool compact = false;

            for (int i = 0; i < _nTracked; i++) {
                uint id = _tracked[i].Id;
                if (id == 0) { compact = true; continue; }

                // Liveness + fresh pointer in one O(1) native hash lookup — we never keep a
                // CPhysicsObj* across frames, so a freed object can never be dereferenced.
                byte* o = (byte*)((delegate* unmanaged[Thiscall]<nint, uint, nint>)_pGetObjectA)((nint)maint, id);
                if (o == null) {
                    if (_tracked[i].Kind == KProjectile && cfg.GlowImpactMs > 1f)
                        PushImpact(cfg, i);
                    _tracked[i].Id = 0; compact = true;
                    continue;
                }

                uint cell = *(uint*)(o + ObjPosCellId);
                float* org = (float*)(o + ObjOrigin);
                _tracked[i].LastCell = cell;
                _tracked[i].Lx = org[0]; _tracked[i].Ly = org[1]; _tracked[i].Lz = org[2];

                if (injected >= cap) continue;
                if (!CellAllowed(cfg, cell, landscapeVisible)) continue;

                byte kind = _tracked[i].Kind;
                float inten = _tracked[i].Inten * gi * KindBoost(cfg, kind);
                if (cfg.GlowPulse > 0.001f && kind != KProjectile) {
                    // Gentle, deterministic breathing so a portal reads as alive, not as a lamp.
                    float a = (_tracked[i].Phase + t * 0.55f) * MathF.PI * 2f;
                    inten *= 1f + cfg.GlowPulse * MathF.Sin(a);
                }

                Emit(_tracked[i].Color, inten, _tracked[i].Fall * gf,
                     _tracked[i].Ox, _tracked[i].Oy, _tracked[i].Oz,
                     cell, (Frame*)(o + ObjPosFrame));
                injected++;
            }

            if (compact) CompactTracked();

            // Impact flashes: short, smoothly decaying, anchored at the projectile's last position.
            long now = _clock.ElapsedTicks;
            bool compactImp = false;
            for (int i = 0; i < _nImpacts; i++) {
                long dur = _impacts[i].DurTicks;
                if (dur <= 0) { compactImp = true; continue; }
                long age = now - _impacts[i].StartTicks;
                if (age >= dur) { _impacts[i].DurTicks = 0; compactImp = true; continue; }
                if (injected >= cap) continue;
                if (!CellAllowed(cfg, _impacts[i].Cell, landscapeVisible)) continue;
                float k = 1f - (float)age / dur;
                k *= k;                                   // quadratic ease-out: no pop-off
                _impFrame->m_fOrigin.BaseClass_Vector3.x = _impacts[i].X;
                _impFrame->m_fOrigin.BaseClass_Vector3.y = _impacts[i].Y;
                _impFrame->m_fOrigin.BaseClass_Vector3.z = _impacts[i].Z;
                Emit(_impacts[i].Color, _impacts[i].Inten * gi * cfg.GlowImpactBoost * k,
                     cfg.GlowImpactFalloff * gf, 0f, 0f, 0f, _impacts[i].Cell, _impFrame);
                injected++;
            }
            if (compactImp) CompactImpacts();

            _lastInjected = injected;
            if (injected > 0) _litFrames++;
        }

        /// <summary>Fill the reusable LIGHTINFO and append it to the frame's dynamic pool.
        /// `frame` is the emitter's world anchor (its own m_position.frame for a live object);
        /// Render::insert_light does Frame::combine(dest, frame, li.offset), so the local offset
        /// rides in li.offset.m_fOrigin — exactly how retail places the viewer light at {0,0,2}
        /// and how CSetup::lights[i].offset places an authored object light.</summary>
        private static void Emit(uint rgb, float intensity, float falloff,
                                 float ox, float oy, float oz, uint cellId, Frame* frame) {
            if (cellId == 0) return;              // get_block_offset(cell_to=0) => ~1e10 garbage
            if (intensity <= 0.0001f || falloff <= 0.01f) return;
            _li->color.r = ((rgb >> 16) & 0xFF) / 255f;
            _li->color.g = ((rgb >> 8) & 0xFF) / 255f;
            _li->color.b = (rgb & 0xFF) / 255f;
            _li->intensity = intensity;
            _li->falloff = falloff;
            _li->offset.m_fOrigin.BaseClass_Vector3.x = ox;
            _li->offset.m_fOrigin.BaseClass_Vector3.y = oy;
            _li->offset.m_fOrigin.BaseClass_Vector3.z = oz;
            Render.add_dynamic_light(_li, cellId, frame);
        }

        /// <summary>THE CONTAINMENT GATE. Mirrors retail's own donation rule (see the class
        /// remarks): an indoor cell contributes only when it is in CEnvCell::visible_cell_table,
        /// the dungeon PVS rebuilt per cell change from the EnvCell DAT's VisibleCells/stab list.
        /// `glowcontain=0` disables it — the A/B that makes the through-wall difference visible.</summary>
        private static bool CellAllowed(LightsConfig cfg, uint cellId, bool landscapeVisible) {
            if (cellId == 0) return false;
            if (cfg.GlowContain < 0.5f) return true;
            if ((cellId & 0xFFFF) >= 0x100) {
                if (_pGetVisible == 0) return false;
                return ((delegate* unmanaged[Cdecl]<uint, nint>)_pGetVisible)(cellId) != 0;
            }
            // Outdoor cell: never in visible_cell_table (only CEnvCells are). Open air — bleed is
            // a non-issue — but don't leak daylight objects into a sealed dungeon.
            return landscapeVisible;
        }

        /// <summary>Is the landscape drawn from where we stand? Mirrors SmartBox::RenderNormalMode
        /// (acclient.c:144886): outdoor viewer cell, or an indoor cell flagged seen_outside.
        /// NOTE we read the PLAYER's cell, not SmartBox::viewer_cell — set_viewer zeroes
        /// viewer_cell (acclient.c:144009) and the caller restores it only after we return.</summary>
        private static bool LandscapeVisible(byte* sb, uint viewerCell) {
            if ((viewerCell & 0xFFFF) < 0x100) return true;
            byte* player = *(byte**)(sb + SbPlayer);
            if (player == null) return false;
            byte* cell = *(byte**)(player + ObjCell);
            if (cell == null) return false;
            return *(int*)(cell + CellSeenOutside) != 0;
        }

        private static void PushImpact(LightsConfig cfg, int ti) {
            if (_nImpacts >= MaxImpacts) return;
            long dur = (long)(Stopwatch.Frequency * (cfg.GlowImpactMs / 1000f));
            if (dur <= 0) return;
            _impacts[_nImpacts].Cell = _tracked[ti].LastCell;
            _impacts[_nImpacts].X = _tracked[ti].Lx;
            _impacts[_nImpacts].Y = _tracked[ti].Ly;
            _impacts[_nImpacts].Z = _tracked[ti].Lz;
            _impacts[_nImpacts].Color = _tracked[ti].Color;
            _impacts[_nImpacts].Inten = _tracked[ti].Inten;
            _impacts[_nImpacts].StartTicks = _clock.ElapsedTicks;
            _impacts[_nImpacts].DurTicks = dur;
            _nImpacts++;
        }

        private static void CompactTracked() {
            int w = 0;
            for (int r = 0; r < _nTracked; r++)
                if (_tracked[r].Id != 0) { if (w != r) _tracked[w] = _tracked[r]; w++; }
            for (int i = w; i < _nTracked; i++) _tracked[i] = default;
            _nTracked = w;
        }

        private static void CompactImpacts() {
            int w = 0;
            for (int r = 0; r < _nImpacts; r++)
                if (_impacts[r].DurTicks > 0) { if (w != r) _impacts[w] = _impacts[r]; w++; }
            for (int i = w; i < _nImpacts; i++) _impacts[i] = default;
            _nImpacts = w;
        }

        private static float KindBoost(LightsConfig cfg, byte kind) => kind switch {
            KPortal => cfg.GlowPortalBoost,
            KProjectile => cfg.GlowProjectileBoost,
            _ => 1f,
        };

        // ══════════════════════════════════════════════════════════════════════════════════════
        //  CLASSIFY + TRACK — 4 Hz, from the rendering-callback slot.
        // ══════════════════════════════════════════════════════════════════════════════════════

        public static void OnPostWorldRender(LightsConfig cfg, ILogger? log) {
            if (cfg.GlowLights < 0.5f) {
                if (_nTracked != 0 || _nImpacts != 0) { _nTracked = 0; _nImpacts = 0; }
                return;
            }
            long now = _clock.ElapsedTicks;
            long period = (long)(Stopwatch.Frequency / Math.Clamp(cfg.GlowScanHz, 0.25f, 30f));
            if (now - _lastScan < period) return;
            _lastScan = now;
            try { Scan(cfg, log, now); }
            catch { /* never unwind into the client */ }
        }

        private static void Scan(LightsConfig cfg, ILogger? log, long now) {
            SmartBox** pp = SmartBox.smartbox;
            if (pp == null || *pp == null) { _nTracked = 0; return; }
            byte* sb = (byte*)(*pp);
            byte* maint = *(byte**)(sb + SbObjMaint);
            if (maint == null) { _nTracked = 0; return; }
            byte** buckets = *(byte***)(maint + OmObjectTable + HtBuckets);
            uint tableSize = *(uint*)(maint + OmObjectTable + HtTableSize);
            if (buckets == null || tableSize == 0 || tableSize > 1_000_000) return;

            byte* player = *(byte**)(sb + SbPlayer);
            uint playerId = player != null ? *(uint*)(player + ObjId) : 0u;
            uint playerCell = player != null ? *(uint*)(player + ObjPosCellId) : 0u;
            float* playerOrg = player != null ? (float*)(player + ObjOrigin) : null;
            float maxDistSq = cfg.GlowRange * cfg.GlowRange;

            bool wantPortals = cfg.GlowPortals > 0.5f;
            bool wantProjectiles = cfg.GlowProjectiles > 0.5f;
            bool wantCreatures = cfg.GlowCreatures > 0.5f;
            bool wantProps = cfg.GlowCreatures >= 1.5f;
            bool wantStatics = cfg.GlowStatics > 0.5f;

            int prevCount = _nTracked;
            _nTracked = 0;
            int seen = 0, cand = 0, classed = 0, verdictFail = 0, rangeFail = 0;
            // Gather reject diagnostics only when a log burst could plausibly follow — the emit
            // condition below is stricter, and an unused gather costs 8 struct writes.
            bool gather = cfg.GlowLog > 0.5f && now - _lastLog >= Stopwatch.Frequency;
            _nRejects = 0;

            for (uint b = 0; b < tableSize; b++) {
                for (byte* o = buckets[b]; o != null && seen < 100_000; o = *(byte**)(o + ObjHashNext)) {
                    seen++;
                    uint id = *(uint*)(o + ObjId);
                    if (id == 0 || id == playerId) continue;

                    uint state = *(uint*)(o + ObjState);
                    if ((state & (StNoDraw | StHidden | StCloaked)) != 0) continue;
                    // (STATIC_PS is NOT fast-rejected here: the class gate below decides, so a
                    // hypothetical static portal or missile is still classified on its own terms.)

                    uint cell = *(uint*)(o + ObjPosCellId);
                    if (cell == 0) continue;

                    byte* pa = *(byte**)(o + ObjPartArray);
                    if (pa == null) continue;
                    byte* setup = *(byte**)(pa + PaSetup);
                    if (setup == null) continue;

                    // DON'T DOUBLE-LIGHT. When the object has an authored setup light AND the
                    // LIGHTING_ON bit AND sits in an EnvCell, the client's own path
                    // (CPartArray::InitLights -> CObjCell::light_list ->
                    // CObjCell::add_dynamic_to_global_lights) already donates it this frame. In an
                    // outdoor CLandCell that path silently delivers NOTHING (CLandCells are never
                    // in visible_cell_table) — that is precisely the gap we exist to fill.
                    bool setupLit = *(uint*)(setup + SetupNumLights) != 0;
                    if (setupLit && (state & StLightsOn) != 0 && (cell & 0xFFFF) >= 0x100) continue;

                    bool isMissile = (state & StMissile) != 0;
                    bool isStatic = (state & StStatic) != 0;
                    uint itemType = InqItemType(o);
                    bool isPortal = itemType == TypePortal;
                    bool isCreature = itemType == TypeCreature;

                    // 2026-08-23 FIXUP: statics get their own branch. `glowstatics=1` used to be
                    // necessary-but-not-sufficient — a lamppost is TYPE_MISC, so it also needed
                    // glowcreatures=2, which is why glowstatics=1 alone changed nothing live.
                    byte kind;
                    if (isMissile) { if (!wantProjectiles) continue; kind = KProjectile; }
                    else if (isPortal) { if (!wantPortals) continue; kind = KPortal; }
                    else if (isStatic) { if (!wantStatics) continue; kind = KCreature; }
                    else if (isCreature) { if (!wantCreatures) continue; kind = KCreature; }
                    else { if (!wantCreatures || !wantProps) continue; kind = KCreature; }

                    uint did = *(uint*)(setup + SetupDid);
                    if (did == 0) continue;
                    int slot = VerdictFor(did, setup, pa);
                    if (slot < 0) continue;
                    classed++;

                    uint color; float inten, fall, ox, oy, oz;
                    if (_v[slot].Authored != 0) {
                        color = _v[slot].AColor;
                        inten = _v[slot].AInten;
                        fall = _v[slot].AFall;
                        ox = _v[slot].AX; oy = _v[slot].AY; oz = _v[slot].AZ;
                    }
                    else {
                        // No authored light: only a genuinely luminous BODY qualifies (peak AND
                        // area fraction — see the classification note in the class remarks).
                        if (_v[slot].Lum < cfg.GlowLum || _v[slot].Frac < cfg.GlowLumFrac) {
                            verdictFail++;
                            if (gather) PushReject(RjLum, id, InqWcid(o), did, _v[slot].Lum, _v[slot].Frac, 0f);
                            continue;
                        }
                        color = _v[slot].DColor;
                        inten = cfg.GlowSynthIntensity;
                        fall = cfg.GlowSynthFalloff;
                        ox = 0f; oy = 0f; oz = cfg.GlowLift;
                    }
                    color = ResolveColor(cfg, kind, did, color);
                    if (inten <= 0f || fall <= 0f) continue;

                    cand++;
                    float distSq = DistSqToPlayer(sb, o, playerCell, playerOrg, cell,
                                                  (float*)(o + ObjOrigin));
                    if (maxDistSq > 0f && distSq > maxDistSq) {
                        rangeFail++;
                        if (gather) PushReject(RjRange, id, InqWcid(o), did,
                                               _v[slot].Lum, _v[slot].Frac, MathF.Sqrt(distSq));
                        continue;
                    }

                    Insert(id, InqWcid(o), kind, color, inten, fall, ox, oy, oz,
                           distSq, cell, (float*)(o + ObjOrigin));
                }
            }

            if (cfg.GlowLog > 0.5f && (now - _lastLog >= Stopwatch.Frequency * 10 ||
                                       (_nTracked != prevCount && now - _lastLog >= Stopwatch.Frequency))) {
                _lastLog = now;
                // The player origin is in the heartbeat because the 2026-08-23 range defect was a
                // bad distance REFERENCE POINT, and the tracked-only log made that expensive to
                // localize: if playerOrg reads (0,0,0) here, distances are from the block corner.
                log?.LogInformation(
                    "acmelights: glowlights scan {S} objs -> {CL} classed, {VF} lum/frac-reject, {RF} range-reject, {C} candidates, tracking {T} " +
                    "(inject {I}/frame, {F} lit frames, impacts {M}) player cell=0x{PC:X8} org=({PX:F1},{PY:F1},{PZ:F1})",
                    seen, classed, verdictFail, rangeFail, cand, _nTracked, _lastInjected, _litFrames, _nImpacts,
                    playerCell,
                    playerOrg != null ? playerOrg[0] : float.NaN,
                    playerOrg != null ? playerOrg[1] : float.NaN,
                    playerOrg != null ? playerOrg[2] : float.NaN);
                for (int i = 0; i < _nTracked && i < 6; i++)
                    log?.LogInformation(
                        "acmelights: glowlights id=0x{Id:X8} wcid={W} class={K} color=0x{C:X6} i={I:F0} f={F:F1} dist={D:F1}",
                        _tracked[i].Id, _tracked[i].Wcid, KindName(_tracked[i].Kind), _tracked[i].Color,
                        _tracked[i].Inten, _tracked[i].Fall, MathF.Sqrt(_tracked[i].DistSq));
                for (int i = 0; i < _nRejects; i++)
                    log?.LogInformation(
                        "acmelights: glowlights REJECT {R} id=0x{Id:X8} wcid={W} setup=0x{S:X8} lum={L:F2} frac={FR:F2} dist={D:F1}",
                        _rejects[i].Why == RjLum ? "lum/frac" : "range",
                        _rejects[i].Id, _rejects[i].Wcid, _rejects[i].Did,
                        _rejects[i].Lum, _rejects[i].Frac, _rejects[i].Dist);
            }
        }

        private const byte RjLum = 1, RjRange = 2;

        private static void PushReject(byte why, uint id, uint wcid, uint did,
                                       float lum, float frac, float dist) {
            if (_nRejects >= MaxRejects) return;
            _rejects[_nRejects].Why = why;
            _rejects[_nRejects].Id = id;
            _rejects[_nRejects].Wcid = wcid;
            _rejects[_nRejects].Did = did;
            _rejects[_nRejects].Lum = lum;
            _rejects[_nRejects].Frac = frac;
            _rejects[_nRejects].Dist = dist;
            _nRejects++;
        }

        private static string KindName(byte k) =>
            k == KPortal ? "portal" : k == KProjectile ? "projectile" : "glow";

        /// <summary>Distance-ordered bounded insert; the nearest MaxTracked win, and the per-frame
        /// GlowMax cap then takes the nearest of those.</summary>
        private static void Insert(uint id, uint wcid, byte kind, uint color, float inten, float fall,
                                   float ox, float oy, float oz, float distSq, uint cell, float* org) {
            int at = _nTracked;
            if (at >= MaxTracked) {
                if (distSq >= _tracked[MaxTracked - 1].DistSq) return;
                at = MaxTracked - 1;
            } else {
                _nTracked++;
            }
            while (at > 0 && _tracked[at - 1].DistSq > distSq) { _tracked[at] = _tracked[at - 1]; at--; }
            _tracked[at].Id = id;
            _tracked[at].Wcid = wcid;
            _tracked[at].Kind = kind;
            _tracked[at].Color = color;
            _tracked[at].Inten = inten;
            _tracked[at].Fall = fall;
            _tracked[at].Ox = ox; _tracked[at].Oy = oy; _tracked[at].Oz = oz;
            _tracked[at].DistSq = distSq;
            _tracked[at].LastCell = cell;
            _tracked[at].Lx = org[0]; _tracked[at].Ly = org[1]; _tracked[at].Lz = org[2];
            _tracked[at].Phase = Phase01(id);
        }

        private static float Phase01(uint id) {
            uint h = id * 2654435761u; h ^= h >> 15; h *= 2246822519u; h ^= h >> 13;
            return (h & 0xFFFFFF) / (float)0x1000000;
        }

        /// <summary>Distance² from the player to an object, via the CLIENT'S OWN
        /// SmartBox::convert_to_player_space @0x00452DE0 → Position::localtolocal. It guards
        /// player/object/object->cell itself and handles cross-cell and cross-landblock correctly.
        ///
        /// 2026-08-23 FIXUP: this used to be hand-rolled arithmetic over m_position.frame.m_fOrigin
        /// plus a landblock rebase. Live at Holtburg it reported dist=86.3 for a portal ~10-15 m
        /// away — 86.3 ≈ |player in-block coords (84.5, 12)| — i.e. one of the two origins was
        /// reading zero, so every distance was measured from the landblock corner and the default
        /// glowrange=45 rejected every candidate (tracking 0, inject 0).
        ///
        /// The offsets are NOT the bug as far as the PDB can tell: Position{BCLASS@0, objcell_id@4,
        /// frame@8} (fieldlist 0x647d) and Frame{qw@0..qz@12, m_fl2gv@16, m_fOrigin@52} (0x6168)
        /// give m_fOrigin = obj + 72 + 8 + 52 = obj + 132, exactly what ObjOrigin says — and the
        /// SAME chain at ObjPosFrame (obj+80) is what Emit hands add_dynamic_light, which demonstrably
        /// places the light correctly (550+ lit frames live). The remaining suspect is therefore the
        /// *player pointer*, SmartBox::player @+248.
        ///
        /// So the fix routes around it entirely: convert_to_player_space takes the SmartBox and
        /// resolves `this->player` ITSELF, so it does not depend on our SbPlayer offset at all. The
        /// arithmetic survives only as a fallback for when the native call declines (no player, or
        /// object->cell null), and the scan heartbeat now prints the player cell+origin so one live
        /// line says whether SbPlayer reads sane values.
        ///
        /// Ordering/range only; never used for containment.</summary>
        private static float DistSqToPlayer(byte* sb, byte* o, uint playerCell, float* playerOrg,
                                            uint cell, float* org) {
            if (_pToPlayerSpace != 0 && _vec3 != null) {
                _vec3[0] = 0f; _vec3[1] = 0f; _vec3[2] = 0f;
                int ok = ((delegate* unmanaged[Thiscall]<nint, nint, float*, int>)_pToPlayerSpace)
                             ((nint)sb, (nint)o, _vec3);
                if (ok != 0) {
                    float x = _vec3[0], y = _vec3[1], z = _vec3[2];
                    if (IsFinite(x) && IsFinite(y) && IsFinite(z)) return x * x + y * y + z * z;
                }
            }
            return DistSqFallback(playerCell, playerOrg, cell, org);
        }

        /// <summary>Geometric fallback: LandDefs::get_block_offset semantics (zero within a
        /// landblock, 192 units per block step — acclient.c:123110).</summary>
        private static float DistSqFallback(uint cellA, float* a, uint cellB, float* b) {
            if (a == null || b == null || cellA == 0 || cellB == 0) return 0f;
            float ox = 0f, oy = 0f;
            if ((cellA >> 16) != (cellB >> 16)) {
                int ax = (int)((cellA >> 24) & 0xFF), ay = (int)((cellA >> 16) & 0xFF);
                int bx = (int)((cellB >> 24) & 0xFF), by = (int)((cellB >> 16) & 0xFF);
                ox = (bx - ax) * 192f; oy = (by - ay) * 192f;
            }
            float dx = b[0] + ox - a[0], dy = b[1] + oy - a[1], dz = b[2] - a[2];
            return dx * dx + dy * dy + dz * dz;
        }

        /// <summary>ITEM_TYPE off the concrete ACCWeenieObject (pwd._type). Guarded by the
        /// _phys_obj back-pointer so a non-ACC weenie can never be misread.</summary>
        private static uint InqItemType(byte* o) {
            byte* w = *(byte**)(o + ObjWeenie);
            if (w == null) return 0;
            if (*(byte**)(w + WoPhysObj) != o) return 0;
            return *(uint*)(w + WoType);
        }

        private static uint InqWcid(byte* o) {
            byte* w = *(byte**)(o + ObjWeenie);
            if (w == null) return 0;
            if (*(byte**)(w + WoPhysObj) != o) return 0;
            return *(uint*)(w + WoWcid);
        }

        private static uint ResolveColor(LightsConfig cfg, byte kind, uint setupDid, uint colour) {
            if (kind == KPortal && cfg.GlowPortalColor != 0) return cfg.GlowPortalColor;
            if (kind == KProjectile && cfg.GlowSchool > 0.5f) {
                for (int i = 0; i < SchoolSetups.Length; i++)
                    if (SchoolSetups[i] == setupDid) return SchoolColors[i];
            }
            if (colour != 0) return colour;
            return kind switch {
                KPortal => 0xC800C8u,       // the swirling-purple gateway (setup 0x020001B3's own light)
                KProjectile => 0xC8D8FFu,   // neutral white-blue when nothing else is readable
                _ => 0xD0E0FFu,
            };
        }

        // ── Setup-verdict cache ───────────────────────────────────────────────────────────────
        // Open-addressed uint->slot. Surface inspection runs ONCE per CSetup DID, never per frame.

        private static int VerdictFor(uint did, byte* setup, byte* pa) {
            uint h = did * 2654435761u;
            int idx = (int)(h & (VCap - 1));
            int free = -1;
            for (int p = 0; p < VProbe; p++) {
                int i = (idx + p) & (VCap - 1);
                if (_v[i].Key == did) return i;
                if (_v[i].Key == 0) { free = i; break; }
            }
            // Table crowded: reclaim the home slot rather than growing (no allocation on this path).
            if (free < 0) free = idx;
            // A verdict is only CACHED when the object's graphics were actually resident. A
            // just-spawned object can have null gfxobj/surfaces for a frame or two; caching "not
            // glowing" from that would blacklist the setup permanently, so we return -1 and let the
            // next 4 Hz scan retry.
            if (!ClassifySetup(setup, pa, ref _v[free])) { _v[free] = default; return -1; }
            _v[free].Key = did;
            return free;
        }

        /// <summary>Decide, once, whether this setup emits light and in what colour.
        ///
        /// (1) AUTHORED — CSetup::num_lights (+144) / CSetup::lights (+148, LIGHTINFO stride 104).
        /// We copy colour/intensity/falloff and the light's LOCAL offset origin, but build our own
        /// identity-quaternion Frame rather than reusing the DAT's, so nothing depends on how the
        /// DAT-loaded Frame was cached.
        ///
        /// (2) LUMINOUS — walk the LIVE part/surface graph (already resident, no DAT load):
        /// CPartArray+88 num_parts / +92 parts[]; part+32 -> CGfxObj** (deref twice) for
        /// num_surfaces (+52); part+196 -> CSurface**; surface+88 type, +96 color_value,
        /// +112 base1pal, +120 luminosity. LUMINOUS is SurfaceType 0x40, ADDITIVE 0x10000
        /// (acclient.h:5820); D3DPolyRender::SetSurface (acclient.c:454385) reads `luminosity`
        /// straight into Render::luminosity, so it is exactly what bloom already brightens.
        /// We record BOTH the peak and the luminous-surface fraction — the fraction is what
        /// separates a wisp (1 of 1) from an Olthoi's glowing eye (1 of 28).
        ///
        /// Returns false when neither signal could be evaluated (the object's graphics are not
        /// resident yet) — the caller must NOT cache that.</summary>
        private static bool ClassifySetup(byte* setup, byte* pa, ref Verdict v) {
            v = default;

            uint nLights = *(uint*)(setup + SetupNumLights);
            byte* lights = *(byte**)(setup + SetupLights);
            if (nLights != 0 && nLights <= 64 && lights != null) {
                byte* li = lights;                 // CSetup::lights[0]
                float r = *(float*)(li + LiColor);
                float g = *(float*)(li + LiColor + 4);
                float b = *(float*)(li + LiColor + 8);
                float inten = *(float*)(li + LiIntensity);
                float fall = *(float*)(li + LiFalloff);
                if (inten > 0f && fall > 0f && IsFinite(inten) && IsFinite(fall)) {
                    v.Authored = 1;
                    v.AColor = PackUnit(r, g, b);
                    v.AInten = inten;
                    v.AFall = fall;
                    v.AX = *(float*)(li + LiOffsetOrigin);
                    v.AY = *(float*)(li + LiOffsetOrigin + 4);
                    v.AZ = *(float*)(li + LiOffsetOrigin + 8);
                    if (!IsFinite(v.AX) || !IsFinite(v.AY) || !IsFinite(v.AZ)) { v.AX = v.AY = v.AZ = 0f; }
                }
            }

            float wr = 0f, wg = 0f, wb = 0f, wsum = 0f;
            int lit = 0, total = 0;
            uint nParts = *(uint*)(pa + PaNumParts);
            if (nParts == 0 || nParts > 256) return v.Authored != 0;
            byte** parts = *(byte***)(pa + PaParts);
            if (parts == null) return v.Authored != 0;

            for (uint i = 0; i < nParts; i++) {
                byte* part = parts[i];
                if (part == null) continue;
                byte** gpp = *(byte***)(part + PtGfxObj);
                if (gpp == null) continue;
                byte* gfx = *gpp;                          // degrade level 0 — CPhysicsPart::surfaces
                if (gfx == null) continue;                 // is sized from (*gfxobj)->num_surfaces
                uint nSurf = *(uint*)(gfx + GoNumSurfaces);
                if (nSurf == 0 || nSurf > 256) continue;
                byte** surfs = *(byte***)(part + PtSurfaces);
                if (surfs == null) continue;

                for (uint s = 0; s < nSurf; s++) {
                    byte* sf = surfs[s];
                    if (sf == null) continue;
                    total++;
                    uint type = *(uint*)(sf + SfType);
                    float lum = *(float*)(sf + SfLuminosity);
                    // 2026-08-23 FIXUP: `luminosity > 0` ALONE is the test. This used to also
                    // require SurfaceType LUMINOUS(0x40)|ADDITIVE(0x10000), which was wrong twice
                    // over: (a) D3DPolyRender::SetSurface (acclient.c:454452) reads
                    // `surface->luminosity` into Render::luminosity UNCONDITIONALLY, with no type
                    // test, and CSurface::InitEnd (:358128) never ORs those bits in — the runtime
                    // `type` is verbatim the DAT value; (b) the false-positive statistics this
                    // classifier is tuned against were measured from luminosity values alone, so
                    // the extra gate was never accounted for. It rejected the Ethereal Wisp
                    // (wcid 1535 → setup 0x0200059A → GfxObj 0x0100193F → Surface 0x080003E4:
                    // type = Base1ClipMap (0x4) ONLY, luminosity 1.0) and every other clipmap glow.
                    if (!(lum > 0f)) continue;
                    lit++;
                    if (lum > v.Lum) v.Lum = lum;
                    uint rgb = SurfaceColor(sf, type);
                    if (rgb == 0) continue;
                    float w = lum;
                    wr += ((rgb >> 16) & 0xFF) * w;
                    wg += ((rgb >> 8) & 0xFF) * w;
                    wb += (rgb & 0xFF) * w;
                    wsum += w;
                }
            }

            if (total == 0) return v.Authored != 0;  // graphics not resident — don't cache a "no"
            v.Frac = (float)lit / total;
            if (wsum <= 0f) return true;
            float ar = wr / wsum, ag = wg / wsum, ab = wb / wsum;
            float m = MathF.Max(ar, MathF.Max(ag, ab));
            if (m < 1f) return true;                // essentially black — no usable hue
            // Normalise to full-range hue; brightness is the cfg's job, not the texture's.
            float k = 255f / m;
            v.DColor = ((uint)MathF.Min(255f, ar * k) << 16)
                     | ((uint)MathF.Min(255f, ag * k) << 8)
                     | (uint)MathF.Min(255f, ab * k);
            return true;
        }

        private static bool IsFinite(float f) => !float.IsNaN(f) && !float.IsInfinity(f);

        /// <summary>RGBColor floats (0..1, as RGBColor::UnPack produces from the DAT's 0..255
        /// ColorARGB) to packed 0xRRGGBB.</summary>
        private static uint PackUnit(float r, float g, float b) {
            if (!IsFinite(r) || !IsFinite(g) || !IsFinite(b)) return 0;
            uint cr = (uint)Math.Clamp(r * 255f, 0f, 255f);
            uint cg = (uint)Math.Clamp(g * 255f, 0f, 255f);
            uint cb = (uint)Math.Clamp(b * 255f, 0f, 255f);
            uint c = (cr << 16) | (cg << 8) | cb;
            return c == 0 ? 0xFFFFFFu : c;          // an authored pure-black light means "white"
        }

        /// <summary>Colour of one surface. A BASE1_SOLID surface carries it in `color_value` (which
        /// is exactly what SetSurface feeds SetSolidColorTextureColor when there is no texture). A
        /// textured surface has none, so fall back to a brightness-weighted average of its palette
        /// — bright entries dominate, which is what a glow texture actually reads as.</summary>
        private static uint SurfaceColor(byte* sf, uint type) {
            if ((type & SfBase1Solid) != 0) {
                uint cv = *(uint*)(sf + SfColorValue) & 0xFFFFFF;
                if (cv != 0) return cv;
            }
            byte* pal = *(byte**)(sf + SfBase1Pal);
            if (pal == null) return 0;
            uint n = *(uint*)(pal + PalNumColors);
            uint* argb = *(uint**)(pal + PalArgb);
            if (argb == null || n == 0 || n > 4096) return 0;
            uint step = n > 256 ? n / 256 : 1;
            float ar = 0f, ag = 0f, ab = 0f, aw = 0f;
            for (uint i = 0; i < n; i += step) {
                uint c = argb[i];
                if ((c >> 24) == 0) continue;
                float r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF;
                float w = r + g + b;
                if (w < 48f) continue;                 // ignore the dark half of the ramp
                ar += r * w; ag += g * w; ab += b * w; aw += w;
            }
            if (aw <= 0f) return 0;
            return ((uint)MathF.Min(255f, ar / aw) << 16)
                 | ((uint)MathF.Min(255f, ag / aw) << 8)
                 | (uint)MathF.Min(255f, ab / aw);
        }
    }
}
