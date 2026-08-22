# PLAN — AcmeLights: holtburger-tier lighting + luminance for the retail client (2026-08-22)

Chorizite plugin(s) that bring the retail acclient's lighting to (and past) holtburger-web
tier. Grounded in two Explore-agent research passes (read them first):
- `research-holtburger-lighting.md` — what holtburger actually does (pool, selection,
  retail attenuation port, EnvCell vertex bake, flame flicker, night ramp; and the finding
  that portals/spells/creature glows are **emissive+bloom, NOT lights**).
- `research-retail-light-machinery.md` — the retail FF pipeline (LightParms pools
  40 static / 7 dynamic → 8 HW slots/draw), struct layouts, every hook point with
  map-build VAs, and the global knobs.

## Architecture decision (final)

**Two subsystems in one plugin (`AcmeLights/`):**

1. **Native FF light augmentation** — work *inside* the client's own D3D9 fixed-function
   light pipeline via the researched hook points. This is where holtburger's actual light
   system lives (it copied retail's), so parity means driving the same machinery, better:
   flame flicker, new dynamic lights for spells/portals/projectiles (which even holtburger
   lacks), raised pool caps, importance-ranked slot selection, ambient fixes.
2. **Luminance post-process ("the bloom")** — holtburger's glow look (portals, war spells,
   luminous fragments, torch coronas) is emissive surfaces + pmndrs bloom (threshold 0.85,
   mipmap blur). The retail client already renders the emissive channel (luminosity →
   D3D Emissive) but has no post-processing. We add a **D3D9 SM3 bloom chain on the
   client's OWN device** — the device supports shaders even though the client never uses
   them; the plugin creates ps_3_0 shaders (compiled at runtime via D3DCompiler with the
   ps_3_0 profile) and runs threshold → downsample blur chain → additive resolve.
   NOTE on the D3D11→D3D9 bridge: proven by AcmeSky, but wrong tool here — bloom needs
   the client-rendered backbuffer, and same-device D3D9 shaders are zero-copy. The bridge
   stays reserved for content we render ourselves.

Design rules carried over from AcmeSky/AcmeRagdoll (docs/dat-patch HANDOFF §3):
ship ACBindings+FASM with the plugin, MemberFunction detours with nint params, install
hooks in Initialize(), live-reload config file (`C:\Temp\acdt\lights.cfg`), never throw
from a detour, throttled diagnostics logs, eyes-free validation before owner eye passes.

## Phases

### Phase 0 — scaffold + passive enumeration (PoC gate)
Plugin skeleton cloned from AcmeRagdoll infra. Address resolver: code VAs from the map
table in the research doc; DATA addresses derived at runtime by reading the operands of
`Render::add_static_light`/`add_dynamic_light`/`enable_active_lights` (the research doc
§7 documents the exact recipe — never hardcode build-A data addresses). Pure reads of
`Render::world_lights`: throttled log of `statics=N dynamics=M ambient=(r,g,b) sun=…`
plus the per-draw slot table. PoC gate: counts move sensibly walking Holtburg (torch
lamps enter/leave the static pool), zero crashes over a 10-min session.

### Phase 1 — zero/low-risk quick wins (cfg-driven pokes)
- Pool caps: `max_static_lights` 40→60, `max_dynamic_lights` 7→10 (+ post-hook
  `SetDegradeLevelInternal` so the quality slider can't stomp them).
- `rangeAdjust`, `ambientBoostFactor` as cfg knobs.
- Viewer headlamp (retail's own `viewer_light`): write `s_fViewerLightIntensity/Falloff`
  (holtburger parity values 2.25 / 10.0), cfg-gated, default off (holtburger default).
- Diagnostics: light-count + ambient in the frame log.

### Phase 2 — flame flicker + the ambient fixes
- Flicker: holtburger's exact waveform (amp .16, floor .74, 7.3/2.13/2.7 Hz, deterministic
  position-hashed phase) applied to warm point lights (same warm-color gate) by mutating
  `RenderLight.d3dLight.Diffuse` post-`UpdateLightsInternal`; set `lightCacheing = 0`
  while enabled (else edits never reach D3D — research §7c).
- Detour `SmartBox::SetWorldAmbientLight`: fix the retail red-bias bug (only `.r` is
  scaled by intensity), and make the hardcoded dungeon ambient (0.2f, white) a cfg pair
  (default: retail-faithful; knobs for darker/warmer dungeons).
- Skip the double 8-bit ambient quantization via the `UpdateLightsInternal` post-hook.

### Phase 3 — NEW dynamic lights: spells, portals, projectiles, glowing creatures
The gap neither retail nor holtburger fills (both leave these to emissive/sprites).
Post-hook `SmartBox::set_viewer` (runs after the per-frame dynamic wipe+refill) and
append plugin-owned `LIGHTINFO`s (`Frame::cache` mandatory) via `Render::add_dynamic_light`:
- **Portals**: track CPhysicsObjs whose setup is a portal (setup id table; purple
  0x8060FF-ish, falloff ~8, gentle pulse).
- **War-spell projectiles in flight**: objects created with projectile physics
  (`missile`/spell-projectile setups); color by school via a setup-id→color table
  (seed from the classic war orb setups; heuristic fallback white-blue).
- **Spell impacts / cast flashes**: brief (300–500 ms) decaying light on
  PlayScript/impact events (hook candidates researched in-phase; fallback: projectile
  disappearance = impact flash at last position).
- **Glowing creatures** (wisps, Virindi, Shadow fragments): per-setup table, soft light.
- Budget discipline: plugin dynamics ranked into the raised 10-slot dynamic pool;
  flicker/pulse reuses the Phase-2 path.

### Phase 4 — selection quality (per-draw)
Replace `Render::minimize_object_lighting` (clean void() cdecl) with importance-ranked
selection: score = attenuated intensity at object center (linear falloff model), true
top-8 instead of first-8-overlap; dynamics no longer unconditionally starve statics.
Optional (same hook, cfg): per-light specular enable + spot penumbra via
`config_hardware_light` post-hook. Tier-2 (>8 HW slots) documented but DEFERRED —
most D3D9 HW T&L caps at 8; ROI is in better selection, not more slots.

### Phase 5 — AcmeBloom: the luminance post-process
- Find the post-world/pre-UI hook point (candidates: end of `PView::DrawCells` /
  `D3DPolyRender::FlushAlphaList` final call / the 2D-UI transition; researched in-phase.
  Chorizite's own EndScene-era hooks are the fallback = bloom over UI, unacceptable,
  so the pre-UI point is a phase gate).
- Chain: StretchRect backbuffer → A8R8G8B8 scene tex → ps_3_0 bright-pass (threshold
  ~0.85 luminance, holtburger parity) → 4-level half-res blur chain → additive resolve
  quad (RenderStateGuard'd, like AcmeSky's composite).
- Knobs: threshold, intensity, radius, on/off (lights.cfg).
- This is what makes portals/war spells/fragment glow read as "great lighting".

### Phase 6 — validation + ship
- Eyes-free: BMP dump of the post-bloom frame (same rotate-8 dump trick as AcmeSky);
  brightness histograms near a wall torch (flicker variance measurable frame-to-frame);
  dungeon capture via chat-rig `@teleloc`; before/after pairs.
- Taildrop capture set to the owner (fair day torch, dungeon torches, portal, war spell
  if attainable via chat-rig casting, night + headlamp).
- Commit, handoff doc, owner eye-pass queued (look-tuning only).

## TASK LIST (execution order)

1. [x] Explore research: holtburger lighting system (report in repo).
2. [x] Explore research: retail FF light machinery + hook points (report in repo).
3. [x] Architecture decision + this plan.
4. [ ] P0: AcmeLights scaffold (csproj, manifest, AddressResolver, LightsConfig w/ live reload).
5. [ ] P0: LightParms reader + throttled enumeration log; deploy to 1070, 10-min soak, verify counts.
6. [ ] P1: pool-cap raise + SetDegradeLevelInternal guard + rangeAdjust/ambientBoost knobs.
7. [ ] P1: viewer headlamp knob; live-validate via enumeration log (dynamic count +1, slot 0).
8. [ ] P2: flame flicker (holtburger waveform, warm gate, lightCacheing=0); validate via
       frame-to-frame Diffuse variance in the reader.
9. [ ] P2: SetWorldAmbientLight detour (red-bias fix + dungeon ambient knobs).
10. [ ] P3: object tracker (portal/projectile/glow taxonomy tables) + set_viewer post-hook
        injection of plugin dynamics; impact flash decay.
11. [ ] P4: minimize_object_lighting replacement (importance top-8) + optional specular/penumbra.
12. [ ] P5: pre-UI hook point research + bloom chain (bright-pass, blur, resolve) + knobs.
13. [ ] P6: frame-dump validation harness + captures + taildrop set + handoff/commit.
14. [ ] Mission wrap-up (non-lights, from the /loop directive): AcmeRagdoll death-variety
        pass; icon probe (designed, unrun); remaining EOD-handoff DAT-line items that are
        autonomously completable; BSM/light-shafts noted as the last sky gap.
15. [ ] **Check envgeo** — 4.P3 variant-build completion → `variant_release.sh` + orientation
        audit + gates → report (the background monitor may fire this earlier; the check
        stays last on this list per the owner's instruction).

## Risks / honesty
- FF lights are Gouraud VERTEX lights: a torch on a low-poly wall lights per-vertex, not
  per-pixel. That IS the retail/holtburger-parity look for world geometry. Per-pixel would
  need the full deferred route (depth access) — out of scope; bloom covers the perceptual
  gap where it matters (bright emitters).
- The per-draw HW cap stays 8 (parity with retail AND holtburger's 16-pool ≈ same ballpark
  of simultaneous influence per object).
- Bloom hook point is the one genuine unknown (Phase 5 gate); everything else has proven
  hook patterns from AcmeSky/AcmeRagdoll.
