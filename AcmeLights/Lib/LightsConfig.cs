using System;
using System.Globalization;
using System.IO;

namespace AcmeLights.Lib {
    /// <summary>
    /// Live tuning knobs, re-read once per second from a plain-text file (same mechanism as
    /// AcmeSky's sky.cfg — the injected acclient does not inherit launcher env vars).
    ///
    /// File: first existing of  C:\Temp\acdt\lights.cfg  ·  %USERPROFILE%\.acdt\lights.cfg.
    /// Format `key = value`, '#'/';' comments. Keys are documented next to their fields.
    /// </summary>
    internal sealed class LightsConfig {
        // --- Phase 1: pool caps + global knobs (0 = leave the retail value alone) ---
        public float MaxStatic = 60f;     // maxstatic: 40..60 (hard array bound 60; retail default 40)
        public float MaxDynamic = 10f;    // maxdynamic: 7..10 (hard array bound 10; retail default 7)
        public float RangeAdjust = 0f;    // rangeadjust: light reach multiplier (retail 1.5; 0 = leave)
        public float AmbientBoost = 0f;   // ambientboost: global ambient multiplier (retail 1.0; 0 = leave)

        // --- Phase 1: viewer headlamp (retail's own dormant viewer_light) ---
        public float Headlamp = 0f;         // headlamp: intensity (holtburger parity 2.25; 0 = off)
        public float HeadlampFalloff = 10f; // headlampfalloff: metres (retail source constant 10.0)
        public uint HeadlampColor = 0xFFFFFF; // headlampcolor: hex RGB

        // --- Phase 2: flame flicker (holtburger waveform on warm point lights) ---
        public float Flicker = 1f;        // flicker: 0/1
        public float FlickerAmp = 0.16f;  // flickeramp: 0..0.6

        // --- Phase 2: ambient fixes ---
        public float AmbientFix = 1f;       // ambientfix: 1 = fix the retail red-bias bug (only .r scaled)
        public float DungeonAmbient = -1f;  // dungeonambient: -1 = retail (0.2), else 0..1 level
        public uint DungeonAmbientColor = 0xFFFFFF; // dungeonambientcolor: hex RGB (retail white)

        // --- P3 quick win: light DAT objects that ship with setup lights but LIGHTS_ON unset ---
        // Default ON since 2026-08-23: live-validated on the 1070 (lantern wcid 42227 lit, entered
        // the dynamic pool). cfg `torchlights=0` is the escape hatch.
        public float TorchLights = 1f;      // torchlights: 0 off | 1 light unlit setup-light objects
                                            //   | 2 DIAGNOSTIC: extinguish lit ones (proves the path)

        // --- P5 bloom (luminance post-process, via the SmartBox::m_renderingCallback slot) ---
        // Default ON since 2026-08-23 (owner verdict): the zero-detour callback-slot design is
        // live-validated (dungeon torch bloom + Holtburg portal glow, UI unbloomed, teleport-stable),
        // and the knob defaults below are the owner-proven night values. cfg `bloom=0` is the escape
        // hatch and live-toggles (the heartbeat installs/clears the callback slot on the next frame).
        // Daytime-outdoor tuning is still owed; adjust via cfg, not here, until eye-verified.
        public float Bloom = 1f;            // bloom: 0/1 master
        public float BloomThreshold = 0.55f;// bloomthreshold: luminance knee center (0..2)  ** NIGHT **
        public float BloomKnee = 0.30f;     // bloomknee: soft-knee half-width (shared day+night)
        public float BloomIntensity = 2.0f; // bloomintensity: additive scale (0..4)          ** NIGHT **
        public float BloomRadius = 3f;      // bloomradius: separable blur H/V passes (1..4)  ** NIGHT **

        // --- P5b bloom DAY/NIGHT scaling (2026-08-23, owner live-GPU feedback: "bloom outdoors by
        // day is much too weak — could be much higher outdoors") ---------------------------------
        // The three knobs above are the owner-PROVEN NIGHT values and must not move. Outdoors by day
        // the same settings read weak for two compounding reasons: (a) a daylit AC scene sits mostly
        // just BELOW luma 0.55, so the bright pass keeps almost nothing, and (b) what it does keep is
        // added over an already-bright frame, where a fixed additive delta is far less visible
        // (Weber). So by day we lower the threshold (let more of the scene bloom) AND raise the
        // additive scale and the blur width.
        //
        // The blend factor is SkyState.Day, derived from the ambient funnel the plugin already
        // detours — see Lib/SkyState.cs for the decomp chain. It is 0 in a dungeon and at outdoor
        // midnight (both floored at LSCAPE_LIGHT_MINIMUM 0.2), so NIGHT AND INDOOR BEHAVIOUR IS
        // BIT-FOR-BIT WHAT THE OWNER SIGNED OFF; only a brightening sky moves it.
        //   effective = lerp(night, day, SkyState.Day)
        // `bloomday=0` disables the whole path (night values everywhere) — the A/B escape hatch.
        public float BloomDay = 1f;             // bloomday: 0/1 master for day/night bloom scaling
        public float BloomDayThreshold = 0.38f; // bloomdaythreshold: luminance knee center by day
        public float BloomDayIntensity = 3.2f;  // bloomdayintensity: additive scale by day (0..4)
        public float BloomDayRadius = 4f;       // bloomdayradius: blur passes by day (1..4)
        // The two ends of the ambient->day mapping. 0.2 is the client's hard floor (dungeon AND
        // outdoor midnight); the noon value is REGION DATA, not a code constant, so 0.62 is a
        // starting estimate — the heartbeat log prints the live `amb=` so the owner can read their
        // region's real noon number and set bloomdayamb to it.
        public float BloomNightAmb = 0.20f;     // bloomnightamb: ambient intensity mapping to day=0
        public float BloomDayAmb = 0.62f;       // bloomdayamb:   ambient intensity mapping to day=1

        // ─── P3 glow dynamic lights (Services/GlowLights.cs) ────────────────────────────────
        // Portals, war-spell projectiles in flight, their impact flashes and glowing creatures get
        // real FF dynamic lights, injected from the SmartBox::set_viewer post-hook. Ships DEFAULT
        // ON (house rule: validated gates ship default-on); `glowlights=0` is the escape hatch and
        // makes the detour forward immediately — no LIGHTINFO built, no add_dynamic_light call,
        // frame bit-identical to stock. Intensity/falloff defaults are deliberately MODEST and are
        // the owner's eye-pass to tune; every knob live-reloads at 1 Hz.
        // Colour/intensity/falloff come from the DAT (CSetup::lights) wherever the setup authors a
        // light — so the defaults below are MULTIPLIERS of 1.0 and the out-of-the-box look is
        // retail-authored, not invented (portal 0x020001B3 => RGB(200,0,200) i100 f6).
        public float GlowLights = 1f;         // glowlights: 0 off | 1 on (master)
        public float GlowPortals = 1f;        // glowportals: 0/1 — ITEM_TYPE TYPE_PORTAL objects
        public float GlowProjectiles = 1f;    // glowprojectiles: 0/1 — PhysicsState MISSILE_PS 0x40
        public float GlowCreatures = 1f;      // glowcreatures: 0 off | 1 luminous creatures
                                              //   | 2 ALSO luminous props (fragments, gems, braziers)
        public float GlowLifestones = 1f;     // glowlifestones: 0/1 — ITEM_TYPE TYPE_LIFESTONE (0x10000000).
                                              //   Self-evident like portals: the blue crystal glows by
                                              //   definition and cannot pass the luminosity test
                                              //   (setup 0x020002EE is 1 lit surface of 7 at 0.75).
        public float GlowStatics = 0f;        // glowstatics: 0/1 — also re-donate STATIC_PS world props
                                              //   whose light the outdoor path drops (lampposts). Off by
                                              //   default: a town has many and they'd crowd the pool.
        public float GlowIntensity = 1f;      // glowintensity: MULTIPLIER on the emitted intensity
        public float GlowFalloffScale = 1f;   // glowfalloffscale: MULTIPLIER on the emitted falloff

        // ── SYSTEM-WIDE GLOW GAIN (2026-08-23, owner live-GPU feedback: "lifestone not that
        // noticeable … you should do it system wide") ─────────────────────────────────────────────
        // WHICH LEVER, AND WHY. PrimD3DRender::config_hardware_light (acclient.c:453119) is the whole
        // mapping from a LIGHTINFO to D3D:
        //     D3DLIGHT9.Diffuse = color * intensity          (colour is 0..1, intensity ~100)
        //     D3DLIGHT9.Range   = falloff * rangeAdjust      (rangeAdjust = 1.5)
        //     Attenuation0 = 0, Attenuation1 = 1, Attenuation2 = 0   =>  atten = 1/d
        // So a light contributes `color*intensity/d * N·L` up to `falloff*1.5` metres and EXACTLY
        // ZERO beyond that — a hard clip, not a tail. At the shipped lifestone values (i=100 f=4)
        // the reach is 6.0 m: the owner standing 5.4 m away was at the very edge of the light, and
        // one step further it vanished. Meanwhile the near field is already past saturation
        // (100/5.4 = 18x colour, clamped at 1.0 by the rasteriser), so INTENSITY ALONE BUYS ALMOST
        // NOTHING — it only lifts grazing-angle surfaces where N·L is small.
        //   => RANGE is the primary lever (glowrangegain), intensity the secondary one (glowgain).
        // Both are pure multipliers on values the DAT/synth path already produced: no new lights,
        // no change to which objects are classed, containment untouched.
        public float GlowGain = 1.6f;         // glowgain: GLOBAL intensity multiplier over every glow
                                              //   class (on top of glowintensity). Helps oblique and
                                              //   far surfaces; the near field is already saturated.
        public float GlowRangeGain = 1.6f;    // glowrangegain: GLOBAL falloff multiplier (on top of
                                              //   glowfalloffscale). THE lever that makes a glow
                                              //   "tint its surroundings" — D3D Range = falloff*1.5.
        // Per-class trims, multiplied by the two globals. Colours are NOT touched by any of these.
        public float GlowLifestoneBoost = 1.25f; // glowlifestoneboost: lifestone intensity trim.
                                                 //   (Was silently sharing glowportalboost; it now has
                                                 //   its own knob — set both if you tuned via that.)
        public float GlowLifestoneRange = 1.4f;  // glowlifestonerange: lifestone falloff trim. With the
                                                 //   defaults: 4 * 1.6 * 1.4 = 8.96 => 13.4 m of reach,
                                                 //   so it reads as a blue pool at conversational range
                                                 //   instead of dying at 6 m.
        public float GlowPortalRange = 1.25f;    // glowportalrange: portal falloff trim (authored f6
                                                 //   => 12.0 => 18 m; portals are town landmarks)
        public float GlowCreatureRange = 1.2f;   // glowcreaturerange: wisp/glowing-creature falloff trim
        public float GlowCreatureBoost = 1f;     // glowcreatureboost: ditto intensity trim
        public float GlowProjectileRange = 1.15f;// glowprojectilerange: war-spell projectile falloff trim
        public float GlowSynthIntensity = 100f; // glowsynthintensity: absolute intensity for a luminous
                                              //   object with NO authored light (DAT idiom: i100 f4)
        public float GlowSynthFalloff = 4f;   // glowsynthfalloff: ditto falloff (D3D Range = this*1.5)
        public float GlowLift = 0.6f;         // glowlift: local +Z offset for a SYNTHESISED light only
                                              //   (authored lights carry their own DAT offset)
        public float GlowPulse = 0.10f;       // glowpulse: portal/creature breathing amplitude (0 = steady)
        public float GlowLum = 0.90f;         // glowlum: peak surface luminosity required with no authored
                                              //   light. 0.9 + glowlumfrac 0.25 fires on 5.9% of creature
                                              //   setups and none of ten mundane controls; a bare >0 fires
                                              //   on 19% (glowing eyes and gems). See the P3 doc §3.
        public float GlowLumFrac = 0.25f;     // glowlumfrac: min luminous fraction of the object's surfaces
        public float GlowMax = 6f;            // glowmax: max glow lights injected per frame (pool is 10)
        public float GlowRange = 0f;          // glowrange: metres from the player worth tracking.
                                              //   DEFAULT 0 = UNCAPPED. 45 hid the Holtburg town portal
                                              //   (86.3 m) until you walked up to it — a light popping in
                                              //   as you approach is exactly the artefact to avoid. The
                                              //   bounded nearest-24 list + nearest-6 injection already do
                                              //   the rationing, and the range test never saved the object
                                              //   walk anyway. Set a value only for perf triage.
        public float GlowScanHz = 4f;         // glowscanhz: classify/track scan rate
        public float GlowContain = 1f;        // glowcontain: 1 = NO THROUGH-WALL BLEED (retail's own PVS
                                              //   rule: indoor emitter must be in CEnvCell::visible_cell_table).
                                              //   0 = off — the A/B that makes the difference visible.
        // ── P3b THE OUTDOOR ENABLE (Services/GlowLights.OnLandscapeDraw) ─────────────────────────
        // Outdoors the client leaves the active hardware-light set at exactly {the sun}:
        // DrawMeshInternal only calls the per-draw chooser when !Render::useSunlight
        // (acclient.c:456974) and RenderNormalMode's outdoor branch runs useSunlightSet(1) first
        // (:144905), which disables slots 1..7 (:380646). So P3 injected outdoor glow lights that
        // were then never switched on. A pre-detour on LScape::draw @0x00506D90 re-adds them with
        // retail's own add_active_light/enable_active_lights — the same pair
        // Render::minimize_envcell_lighting drives for every EnvCell the client draws.
        //
        // DEFAULT ON, and `glowoutdoor=0` is a REAL escape hatch: read at startup it means the
        // detour is never installed at all (zero footprint, exactly like `selection=0`); read live
        // it makes the installed detour's body return before touching anything.
        public float GlowOutdoor = 1f;        // glowoutdoor: 0 off | 1 enable glow dynamics outdoors
        public float GlowOutdoorBudget = 6f;  // glowoutdoorbudget: hardware slots the outdoor pass may
                                              //   take, 1..7 (slot 0 of the 8-entry curLightUsage
                                              //   table is the sun and is never touched)
        public float GlowPortalBoost = 1f;    // glowportalboost: intensity multiplier for portals
        public uint GlowPortalColor = 0u;     // glowportalcolor: hex RGB override (0 = the DAT's authored
                                              //   colour, which is per-portal: purple/red/green/blue/…).
                                              //   Set 8060FF for the owner's reference violet.
        public float GlowProjectileBoost = 1f;// glowprojectileboost
        public float GlowSchool = 1f;         // glowschool: 0/1 — recolour war-spell projectiles whose
                                              //   authored light is a featureless white, per the DAT-grounded
                                              //   school table (fire orange, frost pale blue, …).
        public float GlowImpactMs = 400f;     // glowimpactms: impact-flash duration (0 = no impact flashes)
        public float GlowImpactBoost = 2f;    // glowimpactboost: peak multiplier of the projectile's intensity
        public float GlowImpactFalloff = 10f; // glowimpactfalloff
        public float GlowLog = 0f;            // glowlog: 0 = the 30 s breadcrumb only (DEFAULT since
                                              //   2026-08-23 pacing pass: at glowlog=1 the scan block
                                              //   was ~16 lines/s and the log hit 9 MB in an hour)
                                              //   | 1 = the full per-emitter + per-reason REJECT block
                                              //   at 1 Hz. Both go through the async sink now, so the
                                              //   cost is buffer writes, not render-thread file I/O.

        // --- diagnostics / capture ---
        public float LogLights = 1f;      // loglights: 0 off | 1 the pool/selection heartbeat every 5 s
                                          //   (DEFAULT) | 2 the same line at 1 Hz (live triage)
        public float Dump = 0f;           // dump: 1 = write framedump-N.bmp (backbuffer) 1/sec (EndScene readback)
        // Gate the RenderDeviceD3D::EndScene capture detour. The two P0-P2 hooks (UpdateLightsInternal,
        // SetWorldAmbientLight) are proven stable (19k frames); EndScene is proven too but stays gated
        // as capture is a diagnostic. 0 = don't install (safe default), >=1 = EndScene (capture).
        // (2 used to also add the SceneTool::EndFrame bloom detour — REMOVED 2026-08-22, its cdecl
        // trampoline destabilized the client; bloom now uses the m_renderingCallback slot instead.)
        public float ExtraHooks = 0f;     // extrahooks: 0 none | >=1 endscene (capture)

        // --- P4: importance-ranked per-draw light selection (Services/LightSelection.cs) ---
        // Default ON per the house rule (validated gates ship default-on). `selection=0` restores
        // retail bit-for-bit: read at startup it means "never install the detour" (zero footprint),
        // and read live it makes the installed detour chain straight to the original.
        public float Selection = 1f;        // selection: 0 retail first-8-overlap | 1 importance-ranked
        public float SelBudget = 8f;        // selbudget: HW lights per draw, 1..8 (8 is structural:
                                            //   Render::curLightUsage is an 8 x 12-byte table)
        public float SelHysteresis = 1.15f; // selhysteresis: incumbent score margin, 1.0..2.0
                                            //   (1.0 = none; holtburger's equivalent is 0.8x distance)
        public float SelRange = 1.5f;       // selrange: scoring range = falloff * this. 1.5 = retail
                                            //   `rangeAdjust` (acclient.c:45742), the same multiplier
                                            //   config_hardware_light writes into D3DLIGHT9.Range,
                                            //   so score 0 == a light the device would clip.
        public float SelFlicker = 1f;       // selflicker: 1 = clear the curLightUsage carryOver byte on
                                            //   flame slots so P2's per-frame Diffuse edits reach D3D
                                            //   (this is what makes STATIC wall torches flicker).
        public float SelCaps = 1f;          // selcaps: 1 = read D3DCAPS9.MaxActiveLights once and clamp
                                            //   the budget down to it if the driver reports fewer.

        private static readonly string[] CandidatePaths = BuildCandidatePaths();
        public string? LoadedFrom;

        // ── PACING (2026-08-23): reload throttle + change detection ──────────────────────────
        // Reload() is 3x File.Exists + File.ReadAllLines + ~60 Trim/Substring/ToLowerInvariant
        // allocations, and it used to run on the RENDER THREAD twice a second (the
        // UpdateLightsInternal heartbeat AND the rendering-callback both drove their own 1 Hz
        // throttle). Live tuning still has to feel instant, so the cadence stays 1 Hz — but a
        // second now costs ONE stat syscall unless the file actually changed.
        private readonly System.Diagnostics.Stopwatch _cfgClock = System.Diagnostics.Stopwatch.StartNew();
        private long _lastCheckTicks = long.MinValue / 2;
        private string? _activePath;
        private DateTime _activeStamp;

        /// <summary>Render-thread entry point: at most one stat per second, a full read+parse only
        /// when the file's mtime moved. Both the UpdateLightsInternal heartbeat and the
        /// rendering-callback call this, so the work happens once no matter how many callers there
        /// are. Returns true when values were actually re-applied. Never throws.</summary>
        public bool MaybeReload() {
            long now = _cfgClock.ElapsedTicks;
            if (now - _lastCheckTicks < System.Diagnostics.Stopwatch.Frequency) return false;
            _lastCheckTicks = now;
            string? p = _activePath;
            if (p != null) {
                DateTime t;
                try { t = File.GetLastWriteTimeUtc(p); }
                catch { t = default; }
                if (t == _activeStamp) return false;    // unchanged — no read, no parse, no alloc
            }
            return Reload();
        }

        private static string[] BuildCandidatePaths() {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return new[] {
                Environment.GetEnvironmentVariable("ACMELIGHTS_CONFIG") ?? "",
                @"C:\Temp\acdt\lights.cfg",
                Path.Combine(home, ".acdt", "lights.cfg"),
            };
        }

        /// <summary>Re-read the config file over current values. Never throws.</summary>
        public bool Reload() {
            foreach (var path in CandidatePaths) {
                if (string.IsNullOrEmpty(path)) continue;
                try {
                    if (!File.Exists(path)) continue;
                    foreach (var line in File.ReadAllLines(path)) {
                        var s = line.Trim();
                        if (s.Length == 0 || s[0] == '#' || s[0] == ';') continue;
                        int eq = s.IndexOf('=');
                        if (eq <= 0) continue;
                        Apply(s.Substring(0, eq).Trim().ToLowerInvariant(), s.Substring(eq + 1).Trim());
                    }
                    LoadedFrom = path;
                    _activePath = path;
                    try { _activeStamp = File.GetLastWriteTimeUtc(path); } catch { _activeStamp = default; }
                    return true;
                }
                catch { /* keep current values */ }
            }
            _activePath = null;
            return false;
        }

        private void Apply(string key, string val) {
            switch (key) {
                case "maxstatic": if (F(val, out var ms)) MaxStatic = Math.Clamp(ms, 0f, 60f); break;
                case "maxdynamic": if (F(val, out var md)) MaxDynamic = Math.Clamp(md, 0f, 10f); break;
                case "rangeadjust": if (F(val, out var ra)) RangeAdjust = Math.Clamp(ra, 0f, 10f); break;
                case "ambientboost": if (F(val, out var ab)) AmbientBoost = Math.Clamp(ab, 0f, 10f); break;
                case "headlamp": if (F(val, out var hl)) Headlamp = Math.Clamp(hl, 0f, 100f); break;
                case "headlampfalloff": if (F(val, out var hf)) HeadlampFalloff = Math.Clamp(hf, 0f, 100f); break;
                case "headlampcolor": if (Hex(val, out var hc)) HeadlampColor = hc; break;
                case "flicker": if (F(val, out var fl)) Flicker = Math.Clamp(fl, 0f, 1f); break;
                case "flickeramp": if (F(val, out var fa)) FlickerAmp = Math.Clamp(fa, 0f, 0.6f); break;
                case "ambientfix": if (F(val, out var af)) AmbientFix = Math.Clamp(af, 0f, 1f); break;
                case "dungeonambient": if (F(val, out var da)) DungeonAmbient = Math.Clamp(da, -1f, 1f); break;
                case "dungeonambientcolor": if (Hex(val, out var dc)) DungeonAmbientColor = dc; break;
                case "torchlights": if (F(val, out var tl)) TorchLights = Math.Clamp(tl, 0f, 2f); break;
                case "bloom": if (F(val, out var bl)) Bloom = Math.Clamp(bl, 0f, 1f); break;
                case "bloomthreshold": if (F(val, out var bt)) BloomThreshold = Math.Clamp(bt, 0f, 2f); break;
                case "bloomknee": if (F(val, out var bk)) BloomKnee = Math.Clamp(bk, 0.001f, 1f); break;
                case "bloomintensity": if (F(val, out var bi)) BloomIntensity = Math.Clamp(bi, 0f, 4f); break;
                case "bloomradius": if (F(val, out var br)) BloomRadius = Math.Clamp(br, 1f, 4f); break;
                case "bloomday": if (F(val, out var bd)) BloomDay = Math.Clamp(bd, 0f, 1f); break;
                case "bloomdaythreshold": if (F(val, out var bdt)) BloomDayThreshold = Math.Clamp(bdt, 0f, 2f); break;
                case "bloomdayintensity": if (F(val, out var bdi)) BloomDayIntensity = Math.Clamp(bdi, 0f, 4f); break;
                case "bloomdayradius": if (F(val, out var bdr)) BloomDayRadius = Math.Clamp(bdr, 1f, 4f); break;
                case "bloomnightamb": if (F(val, out var bna)) BloomNightAmb = Math.Clamp(bna, 0f, 4f); break;
                case "bloomdayamb": if (F(val, out var bda)) BloomDayAmb = Math.Clamp(bda, 0f, 4f); break;
                case "loglights": if (F(val, out var ll)) LogLights = Math.Clamp(ll, 0f, 2f); break;
                case "dump": if (F(val, out var du)) Dump = Math.Clamp(du, 0f, 1f); break;
                case "extrahooks": if (F(val, out var eh)) ExtraHooks = Math.Clamp(eh, 0f, 2f); break;
                // --- P4 selection ---
                case "selection": if (F(val, out var sn)) Selection = Math.Clamp(sn, 0f, 1f); break;
                case "selbudget": if (F(val, out var sb)) SelBudget = Math.Clamp(sb, 1f, 8f); break;
                case "selhysteresis": if (F(val, out var sh)) SelHysteresis = Math.Clamp(sh, 1f, 2f); break;
                case "selrange": if (F(val, out var sr)) SelRange = Math.Clamp(sr, 0.5f, 4f); break;
                case "selflicker": if (F(val, out var sf)) SelFlicker = Math.Clamp(sf, 0f, 1f); break;
                case "selcaps": if (F(val, out var sc)) SelCaps = Math.Clamp(sc, 0f, 1f); break;
                // --- P3 glow dynamic lights ---
                case "glowlights": if (F(val, out var gl)) GlowLights = Math.Clamp(gl, 0f, 1f); break;
                case "glowportals": if (F(val, out var gp)) GlowPortals = Math.Clamp(gp, 0f, 1f); break;
                case "glowprojectiles": if (F(val, out var gj)) GlowProjectiles = Math.Clamp(gj, 0f, 1f); break;
                case "glowcreatures": if (F(val, out var gc)) GlowCreatures = Math.Clamp(gc, 0f, 2f); break;
                case "glowlifestones": if (F(val, out var gt)) GlowLifestones = Math.Clamp(gt, 0f, 1f); break;
                case "glowstatics": if (F(val, out var gs)) GlowStatics = Math.Clamp(gs, 0f, 1f); break;
                case "glowintensity": if (F(val, out var gi)) GlowIntensity = Math.Clamp(gi, 0f, 20f); break;
                case "glowfalloffscale": if (F(val, out var gf)) GlowFalloffScale = Math.Clamp(gf, 0.05f, 10f); break;
                case "glowgain": if (F(val, out var gg2)) GlowGain = Math.Clamp(gg2, 0f, 20f); break;
                case "glowrangegain": if (F(val, out var grg)) GlowRangeGain = Math.Clamp(grg, 0.05f, 10f); break;
                case "glowlifestoneboost": if (F(val, out var lsb)) GlowLifestoneBoost = Math.Clamp(lsb, 0f, 20f); break;
                case "glowlifestonerange": if (F(val, out var lsr)) GlowLifestoneRange = Math.Clamp(lsr, 0.05f, 10f); break;
                case "glowportalrange": if (F(val, out var por)) GlowPortalRange = Math.Clamp(por, 0.05f, 10f); break;
                case "glowcreaturerange": if (F(val, out var ccr)) GlowCreatureRange = Math.Clamp(ccr, 0.05f, 10f); break;
                case "glowcreatureboost": if (F(val, out var ccb)) GlowCreatureBoost = Math.Clamp(ccb, 0f, 20f); break;
                case "glowprojectilerange": if (F(val, out var pjr)) GlowProjectileRange = Math.Clamp(pjr, 0.05f, 10f); break;
                case "glowsynthintensity": if (F(val, out var gy)) GlowSynthIntensity = Math.Clamp(gy, 0f, 1000f); break;
                case "glowsynthfalloff": if (F(val, out var gz)) GlowSynthFalloff = Math.Clamp(gz, 0f, 60f); break;
                case "glowlift": if (F(val, out var gv)) GlowLift = Math.Clamp(gv, -4f, 8f); break;
                case "glowpulse": if (F(val, out var gu)) GlowPulse = Math.Clamp(gu, 0f, 0.8f); break;
                case "glowlum": if (F(val, out var gm)) GlowLum = Math.Clamp(gm, 0f, 4f); break;
                case "glowlumfrac": if (F(val, out var gq)) GlowLumFrac = Math.Clamp(gq, 0f, 1f); break;
                case "glowmax": if (F(val, out var gx)) GlowMax = Math.Clamp(gx, 1f, 24f); break;
                case "glowrange": if (F(val, out var gr)) GlowRange = Math.Clamp(gr, 0f, 300f); break;
                case "glowscanhz": if (F(val, out var gh)) GlowScanHz = Math.Clamp(gh, 0.25f, 30f); break;
                case "glowcontain": if (F(val, out var gn)) GlowContain = Math.Clamp(gn, 0f, 1f); break;
                case "glowoutdoor": if (F(val, out var go)) GlowOutdoor = Math.Clamp(go, 0f, 1f); break;
                case "glowoutdoorbudget": if (F(val, out var gob)) GlowOutdoorBudget = Math.Clamp(gob, 1f, 7f); break;
                case "glowportalboost": if (F(val, out var pb)) GlowPortalBoost = Math.Clamp(pb, 0f, 20f); break;
                case "glowportalcolor": if (Hex(val, out var pc)) GlowPortalColor = pc & 0xFFFFFF; break;
                case "glowprojectileboost": if (F(val, out var jb)) GlowProjectileBoost = Math.Clamp(jb, 0f, 20f); break;
                case "glowschool": if (F(val, out var gw)) GlowSchool = Math.Clamp(gw, 0f, 1f); break;
                case "glowimpactms": if (F(val, out var im)) GlowImpactMs = Math.Clamp(im, 0f, 5000f); break;
                case "glowimpactboost": if (F(val, out var ib)) GlowImpactBoost = Math.Clamp(ib, 0f, 20f); break;
                case "glowimpactfalloff": if (F(val, out var if_)) GlowImpactFalloff = Math.Clamp(if_, 0f, 60f); break;
                case "glowlog": if (F(val, out var gg)) GlowLog = Math.Clamp(gg, 0f, 1f); break;
            }
        }

        private static bool F(string s, out float v) =>
            float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v);
        private static bool Hex(string s, out uint v) =>
            uint.TryParse(s.TrimStart('#'), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v);
    }
}
