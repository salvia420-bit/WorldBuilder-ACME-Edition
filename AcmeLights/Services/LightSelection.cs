using System;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using ACBindings.Internal;
using AcmeLights.Lib;
using Microsoft.Extensions.Logging;

namespace AcmeLights.Services {
    /// <summary>
    /// P4 — importance-ranked per-draw light selection. A full replacement for
    /// <c>Render::minimize_object_lighting</c> @0x0054E090 (clean <c>void __cdecl()</c>; map RVA
    /// 0x0014D090 + 0x401000, and ACBindings Render.cs agrees).
    ///
    /// ======================= WHAT RETAIL DOES (acclient.c:380659) =======================
    /// <code>
    /// void __cdecl Render::minimize_object_lighting() {
    ///   int used = 0;
    ///   Render::reset_active_lights_state();                       // 0x0054CA10
    ///   for (i = 0; i &lt; world_lights.num_dynamic_lights; ++i)
    ///     if (used &gt;= 8 || remove_object_light(&amp;sorted_dynamic_lights[i]-&gt;info))
    ///          dynamic_light_used[i] = 0;
    ///     else { dynamic_light_used[i] = 1; add_active_light(i, 2); ++used; }   // 0x0054CBC0
    ///   for (j = 0; j &lt; world_lights.num_static_lights; ++j)
    ///     if (used &lt; 8 &amp;&amp; (sorted_static_lights[j]-&gt;info.type || &lt;sphere overlap&gt;))
    ///          { static_light_used[j] = 1; add_active_light(j, 1); ++used; }
    ///     else static_light_used[j] = 0;
    ///   Render::enable_active_lights();                            // 0x0054CC90
    /// }
    /// </code>
    /// i.e. **first-8-overlap, dynamics first**. Two consequences we fix:
    ///   * a fully-lit corridor starves — the first 8 *pool-order* lights win, and pool order is
    ///     `Render::insert_light`'s insertion sort by squared distance **from the viewer**
    ///     (acclient.c:380524), which has nothing to do with how much a light lights THIS draw;
    ///   * dynamics unconditionally pre-empt statics (a held torch can blank every wall torch).
    ///
    /// ======================= WHAT WE DO INSTEAD =======================
    /// Same three native primitives, same output contract (`*_light_used[]`, the 8-entry
    /// `Render::curLightUsage` table, `enable_active_lights`) — only the *choice* changes:
    ///
    ///  1. **Eligibility is retail's, bit for bit.** A candidate is eligible iff
    ///     `info.type != 0 || |L - objCenter|² &lt; (falloff + objRadius)²` — exactly
    ///     `Render::remove_object_light` (acclient.c:379681) inlined. We never light an object
    ///     with a source retail would have rejected, so no new out-of-range artefacts are possible.
    ///  2. **Ranking is by attenuated contribution AT THE LIT OBJECT**, using retail's own point
    ///     attenuation (`calc_point_light`, acclient.c:454579; the term-for-term port lives in
    ///     holtburger `apps/holtburger-web/src/vertex_bake.rs:71-104`):
    ///       range = falloff * rangeAdjust      (acclient.c:45742 rangeAdjust = 1.5, the same
    ///                                           multiplier config_hardware_light puts in
    ///                                           D3DLIGHT9.Range at acclient.c:453178 — so a
    ///                                           zero score is exactly a light D3D would clip)
    ///       d     = max(0, |L - objCenter| - objRadius)     // nearest point of the object sphere
    ///       atten = d² &lt;= 1 ? 1 : 1/d²                      // retail's wrap/d vs wrap/(d²·d)
    ///                                                       // with the best-case half-Lambert
    ///                                                       // (N·L̂ = 1 ⇒ wrap = d)
    ///       k     = min(1, atten * (1 - d/range) * intensity)   // (1-d/range) = the linear
    ///                                                       // window; min(1,·) = retail's
    ///                                                       // per-channel clamp to the light's
    ///                                                       // own colour (acclient.c:454616)
    ///       score = k * luminance(color)                    // Rec.601 0.299/0.587/0.114
    ///     A strong distant lamp therefore beats a weak near one whenever the attenuated
    ///     contribution says so — which is the whole ask.
    ///  3. **No occlusion, ever.** There is not a single ray cast or geometry test here: a bench
    ///     in front of a torch does not dim the torch, and stepping behind a pillar changes
    ///     nothing. (See the STABILITY note below for why that is also *free* stability.)
    ///  4. **Scope = current cell + PVS-visible cells, for free.** `Render::world_lights` is
    ///     already filled during the client's own portal/PVS cell walk
    ///     (`CObjCell::add_static_to_global_lights` → `Render::add_static_light`), so the
    ///     candidate pool IS the holtburger `getRenderSet(1)` scope. A torch in the next visible
    ///     room is in the pool; a torch in an unseen room is not. We deliberately add NO extra
    ///     cell filter — filtering further could only remove lights retail was showing.
    ///  5. **Reference point is the PLAYER, never the camera.** Two independent reasons this
    ///     holds structurally: (a) the pool's own membership/cull is viewer-*position* based
    ///     (`insert_light` distancesq vs `stru_81EF50.m_fOrigin`) with no orientation term; and
    ///     (b) our score is a light-to-OBJECT distance. Both `info.viewerspace_location` and
    ///     `Render::local_object_center` live in the same viewer-local frame (`stru_81EF08`), and
    ///     a rigid change of frame preserves distances — so the score is *invariant* under all
    ///     player and camera motion. No camera vector appears anywhere in this file.
    ///
    /// **STABILITY (why there is almost nothing left to pop).** Because the score depends only on
    /// the light-to-object geometry, walking, strafing and turning cannot reorder the set at all —
    /// which is strictly better than retail, whose first-8 is keyed on viewer distance and DOES
    /// reshuffle as you walk. The only residual churn sources are (a) pool membership changing as
    /// cells enter/leave the PVS, and (b) genuinely moving dynamic lights. For those we apply
    /// holtburger's Path-B mechanism (`lighting.js:1775-1792`): an incumbent — a light selected
    /// anywhere in the previous frame — has its score multiplied by `selhysteresis` (default 1.15),
    /// so a challenger must beat it by that margin to take the slot. Flicker is deliberately NOT
    /// in the score (we rank on `info.color * info.intensity`, never the flickered
    /// `d3dLight.Diffuse`), so the flame waveform can never make a slot oscillate.
    ///
    /// **BUDGET.** 8, and 8 is structural, not a guess: `Render::curLightUsage` is an in-place
    /// 8-entry × 12-byte table, proven twice over against the shipped map — the class column runs
    /// 0x84706C..0x8470CC where `Render::ymin` begins, the index column 0x847070..0x8470D0 where
    /// `Render::xmax` begins, and both `add_active_light` and `enable_active_lights` walk to those
    /// exact bounds. A 9th slot would corrupt Render::ymin. We still read D3DCAPS9.MaxActiveLights
    /// once at runtime (per the brief) and clamp DOWN to it if a driver reports fewer.
    ///
    /// **TRACKED SET.** 60 static + 10 dynamic, and that too is a ceiling rather than a choice:
    /// `LightParms` is `RenderLight static_lights[60]; RenderLight *sorted_static_lights[60]; int
    /// num_dynamic_lights; RenderLight dynamic_lights[10]; ...` (acclient.h:46623) — a 61st static
    /// would write over `sorted_static_lights`. P1 already raised the caps to exactly that bound
    /// (retail ships 40/7, `SetDegradeLevelInternal` reaches 60/10 at deg_mul 1). So the job really
    /// is best-8-of-70, which is what this file does.
    ///
    /// **COST.** The per-draw path is: one snapshot-validity check (5 loads), then a flat scan of a
    /// packed 48-byte-per-candidate array (~3.3 KB, L1-resident) with an early `key &lt;= worst`
    /// reject, then ≤ 8 native `add_active_light` calls — the same calls retail makes. No
    /// allocation, no LINQ, no dictionary, no managed array bounds checks (all buffers are
    /// `NativeMemory`), no logging. The expensive part — gathering colour/intensity/falloff out of
    /// the 220-byte `RenderLight` structs behind the `sorted_*` pointer arrays — is hoisted into a
    /// per-viewpoint snapshot rebuilt only when the light set or the viewer transform actually
    /// changed (mirroring holtburger's "rebuild on cell-set change only").
    ///
    /// **STATIC WALL-TORCH FLICKER.** Owning the selection is what finally lands it. `enable_active_lights`
    /// (acclient.c:379594) skips the `SetLight` upload entirely when `lightCacheing` is set and the
    /// slot's `carryOver` byte is 1, and `add_active_light` sets `carryOver = 1` whenever the same
    /// (class,index) held the same slot on the previous draw — which is the steady state for a wall
    /// torch, so P2's per-frame `d3dLight.Diffuse` edits never reached the device. We now clear
    /// `carryOver` on exactly the slots holding a flame light (cfg `selflicker`, default on),
    /// forcing the re-upload for those and only those. That sidesteps the unverified `lightCacheing`
    /// global entirely — we never poke it.
    ///
    /// **NEVER THROWS.** Every entry point is guarded by the caller's try/catch, and a `false`
    /// return from <see cref="Run"/> makes the detour chain to the original — so any surprise
    /// degrades to stock retail behaviour for that draw rather than to a fault.
    /// </summary>
    internal sealed unsafe class LightSelection : IDisposable {
        // ---- structural constants, all verified above ----
        public const int StaticCapacity = 60;        // acclient.h:46631 RenderLight static_lights[60]
        public const int DynamicCapacity = 10;       // acclient.h:46634 RenderLight dynamic_lights[10]
        public const int CandidateCapacity = StaticCapacity + DynamicCapacity;
        public const int HwSlots = 8;                // Render::curLightUsage is 8 x 12 bytes. Hard.
        private const int UsageStride = 12;          // HWLightUsage { byte carryOver; int lightClass; int index; }
        private const int UsageClassOffset = 4;
        private const int UsageIndexOffset = 8;
        private const int ClassStatic = 1;           // add_active_light lightClass for the static pool
        private const int ClassDynamic = 2;          // ... and the dynamic pool

        /// <summary>Render::enable_active_lights — acclient.map RVA 0x0014BC90 + image base 0x00401000.
        /// Not surfaced by ACBindings (its two map neighbours are: add_active_light 0x0014BBC0 →
        /// 0x0054CBC0 and minimize_envcell_lighting 0x0014BD80 → 0x0054CD80, both of which ACBindings
        /// emits at exactly those VAs), so the RVA arithmetic is cross-checked on both sides.</summary>
        public const nint EnableActiveLights_VA = 0x0054CC90;

        /// <summary>Render::minimize_object_lighting — acclient.map RVA 0x0014D090 + 0x00401000,
        /// and ACBindings Render.cs emits `minimize_object_lighting() @0x0054E090`.</summary>
        public const nint MinimizeObjectLighting_VA = 0x0054E090;

        /// <summary>IDirect3DDevice9::GetDeviceCaps vtable slot (standard d3d9.h order) and the
        /// D3DCAPS9 byte offset of MaxActiveLights (40 DWORD/float fields precede it).</summary>
        private const int GetDeviceCapsSlot = 7;
        private const int MaxActiveLightsOffset = 160;
        private const int CapsBufferBytes = 512;     // D3DCAPS9 is 304 bytes; headroom.

        /// <summary>Packed per-candidate record. 48 bytes; 70 of them is ~3.3 KB, L1-resident.
        /// Deliberately a flat struct rather than a walk of the 220-byte RenderLight records
        /// scattered behind `sorted_*_lights[]`.</summary>
        [StructLayout(LayoutKind.Sequential)]
        private struct Cand {
            public float X, Y, Z;      // LIGHTINFO.viewerspace_location (viewer-local frame)
            public float Falloff;      // LIGHTINFO.falloff  (retail's eligibility radius)
            public float Range;        // Falloff * selrange (the scoring / D3D Range cutoff)
            public float Intensity;    // LIGHTINFO.intensity
            public float Lum;          // Rec.601 luminance of LIGHTINFO.color
            public int Type;           // LIGHTINFO.type: 0 POINT, 1 DISTANT, 2 SPOT
            public int Index;          // index into sorted_static_lights / sorted_dynamic_lights
            public int Class;          // ClassStatic | ClassDynamic
            public int Flame;          // 1 when LightManager flickers this light
            public int Pad;
        }

        private readonly ILogger _log;
        private readonly LightsConfig _cfg;

        // One unmanaged block, carved once in the ctor, freed in Dispose. Nothing on the hot path
        // allocates, and nothing on the hot path is a managed array (no bounds checks, no write
        // barriers, no interaction with a GC that may be running on another thread).
        private byte* _block;
        private Cand* _cand;
        private float* _pickKey;       // HwSlots, descending
        private int* _pickCand;        // HwSlots, index into _cand
        private byte* _prevSelStatic;  // StaticCapacity  — selected anywhere in the previous frame
        private byte* _prevSelDynamic; // DynamicCapacity
        private byte* _nowSelStatic;   // StaticCapacity  — selected anywhere in this frame
        private byte* _nowSelDynamic;  // DynamicCapacity
        private byte* _flameStatic;    // StaticCapacity  — LightManager flickers this light
        private byte* _flameDynamic;   // DynamicCapacity

        // Snapshot validity. Rebuilt when the pool counts change, when the explicit invalidate from
        // the UpdateLightsInternal heartbeat fires (that is where retail recomputes every
        // viewerspace_location — acclient.c:453398), or when the sentinel light's viewer-space
        // position moved (the belt-and-braces path, because UpdateLightsInternal has been observed
        // to stall when the scene's light set is static).
        private bool _snapValid;
        private int _snapStatic, _snapDynamic, _candCount;
        private RenderLight* _sentinel;
        private float _sentX, _sentY, _sentZ;

        // Cached per-rebuild config (so the hot loop reads locals, not config fields).
        private float _hysteresis = 1.15f;
        private float _rangeFactor = 1.5f;
        private bool _flickerUploads = true;
        private int _budget = HwSlots;

        private int _capsMaxActive = -1;   // -1 = not yet queried; 0 = driver says "no limit"
        private bool _capsQueried;

        private static delegate* unmanaged[Cdecl]<void> _enableActiveLights;

        // Diagnostics (plain ints; LightManager folds them into its existing 1/s line).
        public long Draws;
        public int LastCandidates;
        public int LastPicked;
        public int LastBudget = HwSlots;
        public long Rebuilds;
        public long Bailouts;

        public LightSelection(ILogger log, LightsConfig cfg) {
            _log = log;
            _cfg = cfg;

            nuint bytes =
                (nuint)(sizeof(Cand) * CandidateCapacity) +
                (nuint)(sizeof(float) * HwSlots) +
                (nuint)(sizeof(int) * HwSlots) +
                (nuint)(StaticCapacity * 3 + DynamicCapacity * 3) +
                64;
            _block = (byte*)NativeMemory.AllocZeroed(bytes);
            byte* p = _block;
            _cand = (Cand*)p; p += sizeof(Cand) * CandidateCapacity;
            _pickKey = (float*)p; p += sizeof(float) * HwSlots;
            _pickCand = (int*)p; p += sizeof(int) * HwSlots;
            _prevSelStatic = p; p += StaticCapacity;
            _nowSelStatic = p; p += StaticCapacity;
            _flameStatic = p; p += StaticCapacity;
            _prevSelDynamic = p; p += DynamicCapacity;
            _nowSelDynamic = p; p += DynamicCapacity;
            _flameDynamic = p;

            nint addr = AddressResolver.Resolve("Render::enable_active_lights", null, EnableActiveLights_VA);
            _enableActiveLights = (delegate* unmanaged[Cdecl]<void>)addr;
        }

        /// <summary>Master gate. `selection = 0` makes the detour chain straight to the original,
        /// which is bit-identical retail behaviour (and with `selection = 0` in the cfg at startup
        /// the hook is never installed at all — zero footprint).</summary>
        public bool Enabled => _cfg.Selection > 0.5f;

        /// <summary>Called from the UpdateLightsInternal heartbeat: retail has just recomputed every
        /// `info.viewerspace_location`, so the snapshot is stale by definition.</summary>
        public void Invalidate() => _snapValid = false;

        // ------------------------------------------------------------------ the per-draw path ---

        /// <summary>Replacement body for <c>Render::minimize_object_lighting</c>. Returns false when
        /// it declined to act, in which case the detour must chain to the original (always safe:
        /// the original does a full reset + rebuild + enable of its own).</summary>
        public bool Run() {
            LightParms* wl = Render.world_lights;
            if (wl == null) { Bailouts++; return false; }

            int ns = wl->num_static_lights;
            int nd = wl->num_dynamic_lights;
            // Defensive: a transiently over-reported count must never index past the fixed arrays.
            if ((uint)ns > StaticCapacity || (uint)nd > DynamicCapacity) { Bailouts++; return false; }
            if (ns + nd == 0) return false;   // nothing to rank — let retail do its trivial reset

            if (!_snapValid || ns != _snapStatic || nd != _snapDynamic || !SentinelOk(wl))
                Rebuild(wl, ns, nd);

            int n = _candCount;
            if (n == 0) return false;

            float* oc = (float*)Render.local_object_center;
            float* orr = Render.local_object_radius;
            if (oc == null || orr == null) { Bailouts++; return false; }
            float r = *orr;
            if (!(r >= 0f)) r = 0f;   // NaN-safe

            int picked = Select(oc[0], oc[1], oc[2], r, n, _budget, _hysteresis);
            Commit(picked, ns, nd);

            Draws++;
            LastCandidates = n;
            LastPicked = picked;
            return true;
        }

        /// <summary>The hot loop: rank <paramref name="n"/> candidates against the object sphere and
        /// fill <see cref="_pickKey"/>/<see cref="_pickCand"/> with the best <paramref name="budget"/>
        /// in descending order. Pure arithmetic over the packed snapshot — no client memory, no
        /// native calls — which is also what makes it dry-runnable at warm-up time.</summary>
        private int Select(float cx, float cy, float cz, float r, int n, int budget, float hyst) {
            Cand* cand = _cand;
            float* key = _pickKey;
            int* who = _pickCand;
            int picked = 0;

            for (int i = 0; i < n; i++) {
                Cand* c = cand + i;
                float dx = c->X - cx, dy = c->Y - cy, dz = c->Z - cz;
                float dc2 = dx * dx + dy * dy + dz * dz;

                // --- retail's eligibility gate, inlined (Render::remove_object_light) ---
                if (c->Type == 0) {
                    float reach = c->Falloff + r;
                    if (!(dc2 < reach * reach)) continue;   // NaN-safe: !(< ) rejects
                }

                float score = ScoreOf(c, dc2, r);

                // Incumbency margin. Applied on whichever ordering branch is live, always in the
                // "better" direction (a positive score scales up; the negative distance tiebreak
                // scales toward zero).
                float k;
                bool incumbent = hyst > 1f && WasSelected(c->Class, c->Index) != 0;
                if (score > 0f) k = incumbent ? score * hyst : score;
                else k = incumbent ? (-dc2) / hyst : -dc2;   // eligible but out of scoring range:
                                                             // rank by nearest, always below any
                                                             // light that actually contributes.

                if (picked == budget) {
                    if (k <= key[budget - 1]) continue;      // the common early reject
                    picked = budget - 1;                     // drop the worst, insert below
                }
                int p = picked;
                while (p > 0 && key[p - 1] < k) { key[p] = key[p - 1]; who[p] = who[p - 1]; p--; }
                key[p] = k;
                who[p] = i;
                picked++;
            }
            return picked;
        }

        /// <summary>Retail's point attenuation (`calc_point_light`, acclient.c:454579) evaluated at
        /// the nearest point of the object sphere with the best-case half-Lambert term. Returns 0
        /// for a light outside its own D3D Range — exactly the lights the device would clip.</summary>
        private static float ScoreOf(Cand* c, float dc2, float r) {
            if (c->Type != 0) {
                // DISTANT (1) has no distance terms at all (acclient.c:454990) and SPOT (2) is
                // unconditionally eligible in retail. Both keep a strong, distance-free score so we
                // reproduce retail's "never drop a non-point light" behaviour.
                float ki = c->Intensity;
                if (ki > 1f) ki = 1f;
                if (!(ki > 0f)) return 0f;
                return ki * c->Lum;
            }
            float range = c->Range;
            if (!(range > 0f)) return 0f;
            float d = MathF.Sqrt(dc2) - r;
            if (d < 0f) d = 0f;
            if (!(d < range)) return 0f;

            float d2 = d * d;
            float atten = d2 <= 1f ? 1f : 1f / d2;   // retail: wrap/d inside 1 m, wrap/(d²·d) outside
            float k = atten * (1f - d / range) * c->Intensity;
            if (k > 1f) k = 1f;                      // retail's per-channel clamp to the light colour
            if (!(k > 0f)) return 0f;
            return k * c->Lum;
        }

        /// <summary>Drive the client's own slot machinery with the ranked picks: same three native
        /// calls, same `*_light_used[]` contract, plus the carryOver clear that lets flame flicker
        /// reach the device.</summary>
        private void Commit(int picked, int ns, int nd) {
            int* usedS = (int*)Render.static_light_used;
            int* usedD = (int*)Render.dynamic_light_used;
            if (usedS != null) for (int i = 0; i < ns; i++) usedS[i] = 0;
            if (usedD != null) for (int i = 0; i < nd; i++) usedD[i] = 0;

            Render.reset_active_lights_state();

            Cand* cand = _cand;
            int* who = _pickCand;
            bool anyFlame = false;
            for (int p = 0; p < picked; p++) {
                Cand* c = cand + who[p];
                if (c->Class == ClassStatic) {
                    if (usedS != null && (uint)c->Index < (uint)ns) usedS[c->Index] = 1;
                    _nowSelStatic[c->Index] = 1;
                }
                else {
                    if (usedD != null && (uint)c->Index < (uint)nd) usedD[c->Index] = 1;
                    _nowSelDynamic[c->Index] = 1;
                }
                if (c->Flame != 0) anyFlame = true;
                // Descending score order, so if the 8 slots ever ran short the best lights are in.
                Render.add_active_light(c->Index, c->Class);
            }

            if (anyFlame && _flickerUploads) ClearCarryOverOnFlames();

            var fn = _enableActiveLights;
            if (fn != null) fn();
        }

        /// <summary>`enable_active_lights` skips the SetLight upload for any slot whose carryOver
        /// byte is 1 while `lightCacheing` is on (acclient.c:379609) — which freezes P2's per-frame
        /// Diffuse edits on a statically-pooled wall torch that keeps its slot. Clearing the byte on
        /// exactly the flame slots forces the re-upload for those and only those, and needs no poke
        /// at the unverified `lightCacheing` global.</summary>
        private void ClearCarryOverOnFlames() {
            byte* usage = (byte*)Render.curLightUsage;
            if (usage == null) return;
            for (int s = 0; s < HwSlots; s++) {
                byte* e = usage + s * UsageStride;
                int cls = *(int*)(e + UsageClassOffset);
                int idx = *(int*)(e + UsageIndexOffset);
                if (cls == ClassStatic) {
                    if ((uint)idx < StaticCapacity && _flameStatic[idx] != 0) *e = 0;
                }
                else if (cls == ClassDynamic) {
                    if ((uint)idx < DynamicCapacity && _flameDynamic[idx] != 0) *e = 0;
                }
            }
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private byte WasSelected(int cls, int idx) =>
            cls == ClassStatic
                ? ((uint)idx < StaticCapacity ? _prevSelStatic[idx] : (byte)0)
                : ((uint)idx < DynamicCapacity ? _prevSelDynamic[idx] : (byte)0);

        // ------------------------------------------------------------ per-viewpoint snapshot ---

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private bool SentinelOk(LightParms* wl) {
            RenderLight* s = _sentinel;
            if (s == null) return false;
            RenderLight* live = _snapStatic > 0 ? wl->sorted_static_lights[0]
                              : _snapDynamic > 0 ? wl->sorted_dynamic_lights[0] : null;
            if (live != s) return false;
            float* v = (float*)&s->info.viewerspace_location;
            return v[0] == _sentX && v[1] == _sentY && v[2] == _sentZ;
        }

        /// <summary>Gather the packed candidate array out of the pools, and roll the hysteresis
        /// incumbency (this-frame → previous-frame). Runs once per viewpoint, not per draw.</summary>
        private void Rebuild(LightParms* wl, int ns, int nd) {
            // Roll incumbency: "selected by any draw of the frame just ended" becomes the margin
            // holders for the frame beginning now (holtburger lighting.js:1775-1792 semantics).
            for (int i = 0; i < StaticCapacity; i++) { _prevSelStatic[i] = _nowSelStatic[i]; _nowSelStatic[i] = 0; }
            for (int i = 0; i < DynamicCapacity; i++) { _prevSelDynamic[i] = _nowSelDynamic[i]; _nowSelDynamic[i] = 0; }
            for (int i = 0; i < StaticCapacity; i++) _flameStatic[i] = 0;
            for (int i = 0; i < DynamicCapacity; i++) _flameDynamic[i] = 0;

            // Pick up live tuning once per viewpoint so the hot loop reads locals only.
            float hy = _cfg.SelHysteresis; _hysteresis = hy >= 1f ? hy : 1f;
            float rf = _cfg.SelRange; _rangeFactor = rf > 0f ? rf : 1.5f;
            _flickerUploads = _cfg.SelFlicker > 0.5f && _cfg.Flicker > 0.5f;
            int b = (int)_cfg.SelBudget;
            if (b < 1) b = 1;
            if (b > HwSlots) b = HwSlots;
            if (_capsMaxActive > 0 && b > _capsMaxActive) b = _capsMaxActive;
            _budget = b;
            LastBudget = b;

            int n = 0;
            n = Gather(wl->sorted_dynamic_lights, nd, ClassDynamic, _flameDynamic, n);
            n = Gather(wl->sorted_static_lights, ns, ClassStatic, _flameStatic, n);
            _candCount = n;

            _snapStatic = ns;
            _snapDynamic = nd;
            RenderLight* sent = ns > 0 ? wl->sorted_static_lights[0]
                              : nd > 0 ? wl->sorted_dynamic_lights[0] : null;
            _sentinel = sent;
            if (sent != null) {
                float* v = (float*)&sent->info.viewerspace_location;
                _sentX = v[0]; _sentY = v[1]; _sentZ = v[2];
            }
            _snapValid = true;
            Rebuilds++;
        }

        private int Gather(RenderLight** sorted, int count, int cls, byte* flameFlags, int n) {
            if (sorted == null) return n;
            float rf = _rangeFactor;
            for (int i = 0; i < count && n < CandidateCapacity; i++) {
                RenderLight* rl = sorted[i];
                if (rl == null) continue;
                float* v = (float*)&rl->info.viewerspace_location;
                Cand* c = _cand + n;
                c->X = v[0]; c->Y = v[1]; c->Z = v[2];
                float fo = rl->info.falloff;
                c->Falloff = fo;
                c->Range = fo * rf;
                c->Intensity = rl->info.intensity;
                float cr = rl->info.color.r, cg = rl->info.color.g, cb = rl->info.color.b;
                c->Lum = 0.299f * cr + 0.587f * cg + 0.114f * cb;
                c->Type = rl->info.type;
                c->Index = i;
                c->Class = cls;
                int flame = IsFlameLight(rl) ? 1 : 0;
                c->Flame = flame;
                c->Pad = 0;
                flameFlags[i] = (byte)flame;
                n++;
            }
            return n;
        }

        /// <summary>The single source of truth for "does the flame-flicker waveform apply to this
        /// light" — holtburger `flameFlicker.isFlameLight`: a POINT light whose AUTHORED colour is
        /// warm (r ≥ 0.30, r ≥ 0.92·g, r &gt; 1.25·b), so portals and ice never flicker.
        /// <see cref="LightManager"/> calls this too, so the flicker set and the carryOver-clear set
        /// cannot drift apart.</summary>
        public static bool IsFlameLight(RenderLight* rl) {
            if (rl == null) return false;
            if (rl->d3dLight.Type != _D3DLIGHTTYPE.D3DLIGHT_POINT) return false;
            float cr = rl->info.color.r, cg = rl->info.color.g, cb = rl->info.color.b;
            return cr >= 0.30f && cr >= cg * 0.92f && cr > cb * 1.25f;
        }

        // ------------------------------------------------------------------- device caps (once) ---

        /// <summary>Read D3DCAPS9.MaxActiveLights once, per the brief ("rather than hardcoding 8").
        /// It can only ever clamp the budget DOWN: the client's own 8-entry `Render::curLightUsage`
        /// table is the real ceiling regardless of what the driver reports. A 0 means "no limit" in
        /// the D3D9 contract and is treated as "no clamp". Called from the LightManager heartbeat,
        /// never from the per-draw path. cfg `selcaps = 0` skips the query entirely.</summary>
        public void QueryDeviceBudgetOnce() {
            if (_capsQueried) return;
            _capsQueried = true;
            if (_cfg.SelCaps < 0.5f) {
                _log.LogInformation("acmelights: P4 device-caps query disabled (selcaps=0); budget capped at {N}", HwSlots);
                return;
            }
            try {
                nint dev = ClientState.GetDevicePointer();
                if (dev == 0) { _capsQueried = false; return; }   // pre-device; retry next heartbeat
                byte* caps = stackalloc byte[CapsBufferBytes];
                for (int i = 0; i < CapsBufferBytes; i++) caps[i] = 0;
                void** vt = *(void***)dev;
                var fn = (delegate* unmanaged[Stdcall]<nint, byte*, int>)vt[GetDeviceCapsSlot];
                int hr = fn(dev, caps);
                if (hr >= 0) {
                    int max = *(int*)(caps + MaxActiveLightsOffset);
                    _capsMaxActive = max;
                    _snapValid = false;   // re-derive the budget on the next rebuild
                    _log.LogInformation(
                        "acmelights: P4 D3DCAPS9.MaxActiveLights={Max} (0 = unlimited); the client's own " +
                        "Render::curLightUsage table is {Slots} x 12 bytes, so the per-draw budget is " +
                        "min(selbudget, slots, caps)",
                        max, HwSlots);
                }
                else {
                    _log.LogWarning("acmelights: P4 GetDeviceCaps hr=0x{HR:X8}; budget stays {N}", hr, HwSlots);
                }
            }
            catch (Exception ex) {
                _log.LogWarning(ex, "acmelights: P4 device-caps query failed; budget stays {N}", HwSlots);
            }
        }

        // ------------------------------------------------------------------------------ warm-up ---

        /// <summary>
        /// 0x80131509 discipline. Everything reachable from the native detour is JITed and every
        /// type it touches is realised HERE, on the managed thread, before a single detour fires.
        /// Two mechanisms, deliberately both:
        ///   * a real DRY RUN of <see cref="Select"/> over synthetic candidates in the already
        ///     allocated buffers — that is the hot loop, actually executed, so the JIT emits it for
        ///     real (a `PrepareMethod` alone would not exercise the `MathF.Sqrt` intrinsic path);
        ///   * <c>RuntimeHelpers.PrepareMethod</c> on every method that touches client memory or
        ///     makes a native call and therefore cannot be dry-run, plus on the ACBindings statics
        ///     they call through and on the UnmanagedCallersOnly detour body itself.
        /// Never throws — a warm-up miss is logged, not propagated.
        /// </summary>
        public void Warmup() {
            try {
                // 1. Realise the ACBindings types + statics the detour dereferences.
                _ = Render.world_lights;
                _ = Render.local_object_center;
                _ = Render.local_object_radius;
                _ = Render.static_light_used;
                _ = Render.dynamic_light_used;
                _ = Render.curLightUsage;
                _ = sizeof(RenderLight);
                _ = sizeof(LIGHTINFO);
                _ = sizeof(LightParms);
                _ = sizeof(HWLightUsage);
                _ = sizeof(Cand);

                // 2. Dry-run the ranking loop over synthetic candidates. Touches only our own
                //    NativeMemory buffers — no client state, no native calls.
                for (int i = 0; i < CandidateCapacity; i++) {
                    Cand* c = _cand + i;
                    c->X = i * 0.5f; c->Y = i * 0.25f; c->Z = 1f;
                    c->Falloff = 6f; c->Range = 9f; c->Intensity = 1f + (i & 3);
                    c->Lum = 0.8f;
                    c->Type = i % 7 == 0 ? 1 : 0;
                    c->Index = i < StaticCapacity ? i : i - StaticCapacity;
                    c->Class = i < StaticCapacity ? ClassStatic : ClassDynamic;
                    c->Flame = i & 1; c->Pad = 0;
                }
                for (int i = 0; i < StaticCapacity; i++) _prevSelStatic[i] = (byte)(i & 1);
                for (int i = 0; i < DynamicCapacity; i++) _prevSelDynamic[i] = (byte)(i & 1);
                int warmPicked = 0;
                for (int pass = 0; pass < 4; pass++)
                    warmPicked = Select(1f, 2f, 3f, 0.75f, CandidateCapacity, HwSlots, 1.15f);
                // Leave nothing behind: the first real Run() must rebuild from live pools.
                for (int i = 0; i < CandidateCapacity; i++) _cand[i] = default;
                for (int i = 0; i < StaticCapacity; i++) { _prevSelStatic[i] = 0; _nowSelStatic[i] = 0; _flameStatic[i] = 0; }
                for (int i = 0; i < DynamicCapacity; i++) { _prevSelDynamic[i] = 0; _nowSelDynamic[i] = 0; _flameDynamic[i] = 0; }
                _candCount = 0;
                _snapValid = false;
                _sentinel = null;
                Draws = 0; Rebuilds = 0; Bailouts = 0; LastPicked = 0; LastCandidates = 0;

                // 3. Pre-JIT everything that cannot be dry-run.
                Prepare(typeof(LightSelection), "Run");
                Prepare(typeof(LightSelection), "Commit");
                Prepare(typeof(LightSelection), "Rebuild");
                Prepare(typeof(LightSelection), "Gather");
                Prepare(typeof(LightSelection), "SentinelOk");
                Prepare(typeof(LightSelection), "ClearCarryOverOnFlames");
                Prepare(typeof(LightSelection), "WasSelected");
                Prepare(typeof(LightSelection), "ScoreOf");
                Prepare(typeof(LightSelection), "Select");
                Prepare(typeof(LightSelection), "IsFlameLight");
                Prepare(typeof(LightSelection), "get_Enabled");
                Prepare(typeof(LightSelection), "Invalidate");
                // Reached from the LightManager heartbeat, which is ALSO a native detour thread --
                // its stackalloc, its D3D9 vtable call and its logger path all have to be JITed here.
                Prepare(typeof(LightSelection), "QueryDeviceBudgetOnce");
                Prepare(typeof(ClientState), "GetDevicePointer");
                // The native primitives we call through (ACBindings emits each as a managed
                // wrapper around an unmanaged function-pointer call).
                Prepare(typeof(Render), "reset_active_lights_state");
                Prepare(typeof(Render), "add_active_light");
                // The detour body itself, its error path, and the heartbeat that drives us.
                Prepare(typeof(NativeHooks), "MinimizeObjectLightingImpl");
                Prepare(typeof(NativeHooks), "LogSafe");
                Prepare(typeof(LightManager), "OnUpdateLights");
                Prepare(typeof(LightManager), "AttachSelection");

                _log.LogInformation(
                    "acmelights: P4 warmup ok (dry-run picked {P} of {C}, slots={S}, enable_active_lights@{A:X8})",
                    warmPicked, CandidateCapacity, HwSlots, (long)(nint)_enableActiveLights);
            }
            catch (Exception ex) {
                _log.LogWarning(ex, "acmelights: P4 warmup incomplete");
            }
        }

        private static void Prepare(Type t, string name) {
            try {
                MethodInfo? m = t.GetMethod(name,
                    BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                if (m != null && !m.ContainsGenericParameters) RuntimeHelpers.PrepareMethod(m.MethodHandle);
            }
            catch { /* a missed pre-JIT is a diagnostic, never a failure */ }
        }

        public void Dispose() {
            byte* b = _block;
            _block = null;
            _cand = null; _pickKey = null; _pickCand = null;
            _prevSelStatic = _prevSelDynamic = _nowSelStatic = _nowSelDynamic = null;
            _flameStatic = _flameDynamic = null;
            _snapValid = false;
            if (b != null) NativeMemory.Free(b);
        }
    }
}
