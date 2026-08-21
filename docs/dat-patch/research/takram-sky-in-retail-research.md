# Takram sky (holtburger-web) in the retail AC client — feasibility (2026-08-21)

Question: can we replace the retail client's sky with holtburger-web's takram
volumetric clouds + NASA-map atmosphere, via the ACME kit — "a dll and a bit of
monkeywrenching"? Two Opus agents (injection angle + data/out-of-process angle);
key claims re-verified in the decomp/WBT by hand.

## The one hard wall (verified)
**The retail client has ZERO programmable shaders** — pure fixed-function
Direct3D 9 (`rg -ca 'CreatePixelShader|CreateVertexShader|SetPixelShader|
SetVertexShader' acclient.c` = 0). Takram's clouds are raymarched volumetrics
needing texture arrays (cascaded Beer shadow maps), sampler3D, integer shader
ops, fp16 MRT, and cross-frame TAAU — **none expressible in this client**, by
DLL or by data. A live, faithful takram cloud volume inside acclient is
**impossible**. The atmosphere (Bruneton scattering) is a fullscreen quad and
only its *palette* is portable. So "takram sky" splits into what can be baked
(atmosphere color, distant cloud look, stars, day-cycle) vs what cannot
(parallax, view-dependent volume, self/ground shadows).

## The lever (verified): retail sky is 100% DAT-data-driven
Region `0x13000000` → `SkyDesc` → `DayGroup[]` → `SkyObject[]` + `SkyTimeOfDay[]`
keyframes (acclient.h:53237/53183/…; parser holtburger crates/holtburger-dat/
src/file_type/region.rs). `GameSky::Draw` (acclient.c:308475) instantiates each
SkyObject as an ordinary CPhysicsObj billboard and draws them at **zfar*4 with
`DEPTHTEST_ALWAYS`** (acclient.c:308496-308498) as a backdrop the world then
overdraws opaque. Called twice from `LScape::draw`: `(sky,0)` behind world,
`(sky,1)` after (weather). No CSkyObject/cloud-plane/star-count/texture-size cap
in code (texture cap = GPU MaxTextureWidth, res-4k-unlock already ships).
Bakeable: SkyObject gfx/pes DataIDs, tex_velocity scroll, time/angle windows,
SkyObjectReplace opacity/luminosity keyframes, and the whole SkyTimeOfDay
day/night light+fog gradient. **Tooling already exists** in WorldBuilder.Terminal:
region-skybox-snapshot, region-day-night-curve, region-export-json /
**region-import-json** (write), region-diff, import-render-surface /
surface-texture-collapse / import-texture.

## The routes, ranked

**A. DATA-ONLY — ships to EVERY kit user, no DLL, one modified client_portal.dat. GREEN.**
- 1a recolor the SkyTimeOfDay day/night gradient (dir/amb/fog color+brightness)
  to takram's Bruneton output sampled per time-of-day (region-import-json).
- 1b bake tileable takram cloud renders into the cloud-band SurfaceTextures
  (import-render-surface) + tune tex_velocity scroll / SkyObjectReplace opacity.
- 1c NASA/Yale equirect star texture on a night sky-shell; better sun/moon discs.
- 4c fold DistanceFog into 1a for aerial-perspective haze.
- **Fidelity ceiling: takram's PALETTE and distant cloud LOOK, but flat
  scrolling billboards — no parallax, no volume, no cloud shadows.** A
  genuinely much-better sky for everyone, buildable today with existing tools.

**B. DLL INJECTION (Chorizite plugin, plugin-users only). Strategy 3, GREEN; real-shaders, RED.**
- One Reloaded.Hooks detour on `GameSky::Draw` (sig-scan; ACBindings VA
  0x00507A50 — decomp VAs differ by build, so scan) SUPPRESSES the retail sky
  (both phases) and INJECTS a baked NASA-equirect skybox + offline-baked takram
  cloud flipbook on the client's own IDirect3DDevice9 (AcmeRedline device-access
  + state save/restore precedent; camera from m_GState). Fidelity ≈ the
  data-only ceiling (baked, not live) but more flexible + storm-swappable.
- "Full port of takram shaders onto the client device" = RED (no shaders, no
  texture arrays). "In-process D3D11 compositor rendering the REAL takram" =
  highest fidelity but very high effort + needs the client to be D3D9Ex
  (UNVERIFIED) for a shared surface; treat as a separate large project.

**C. OUT-OF-PROCESS COMPANION — near-real takram, no DLL, no in-client render. YELLOW.**
- Route 2b: a separate app window-captures the client, **chroma-keys the sky
  pixels** (occlusion is FREE — the world already drew opaque over the
  DEPTHTEST_ALWAYS sky backdrop), renders the REAL takram stack aligned to the
  client camera behind it. Keyed off the 1a recolor (pure data — recolor the
  retail sky to a unique key color; no exe patch needed). Optionally a
  `GameSky::Draw` NOP patch (3a) paints a clean key instead.
- **The only route to actual volumetric takram clouds.** Risks: whole-game
  capture latency, camera-sync lag on fast turns, AA key-edge bleed; the camera
  feed (external memory read of heading/pitch/fov, or the Chorizite bus) is the
  main unsolved piece. UNVERIFIED: client camera memory offset, capture latency.
- Dead ends (RED): overlay-in-front without capture (draws over buildings, no
  occlusion); ReShade-style post (can't insert geometry behind the world);
  server-driven sky (no sky/weather net-message exists — sky is a client-side
  DAT DayGroup LCG).

## Multiple cloud LAYERS (as takram bands its altitudes) — verified 2026-08-21

**YES, data-only, no count cap** — but it's painter's-order stacking of
camera-locked meshes, not true parallax layers.
- `DayGroup` holds a variable-length `_numSkyObjects: uint` + `SkyObject[]`
  (dats.xml:2817-2818; region.rs DayGroup::unpack), mirrored at runtime into
  growable SmartArrays (`GameSky.sky_obj` acclient.h:35423, `sky_objects`
  53162) — no hard max in loader or renderer; retail Dereth already ships ~10+
  per DayGroup. Only fill-rate limits you (each = one CPhysicsObj drawn/frame).
- Per-layer knobs: `default_gfx_object` (the mesh — **altitude/size lives in
  the GfxObj geometry: author each cloud plane/dome at a different z/radius/
  density; there is NO scale field on SkyObject**), per-object `tex_velocity`
  (independent scroll → differential drift, MakeObject acclient.c:308441),
  `properties` (0x1=after-world weather cell, 0x2=hide under fog, 0x4=camera-
  follow), and `SkyObjectReplace` keyframes for per-time-of-day opacity/tint
  (transparent/luminosity/max_bright, interpolated across SkyTimeOfDay).
  ⚠ `begin/end_angle` is a world-y arc rotation (sun/moon sweep,
  Frame::grotate acclient.c:308459/357422), NOT an elevation slider — bands
  belong in the mesh, not this param.
- Compositing: `LScape::draw` calls `GameSky::Draw(0)` before the world and
  `Draw(1)` after (weather only); Draw loops the array in order with
  `DEPTHTEST_ALWAYS` + z-write OFF (acclient.c:308496-308521) → pure painter's
  order, overlapping translucent clouds read as stacked bands.
- Recipe (all via WBT region-import-json): append N cloud SkyObjects to the
  Region 0x13000000 DayGroups, each a cloud GfxObj at a distinct dome
  height/curvature, always-on (begin_time==end_time), distinct tex_velocity
  (slow cirrus → fast low band), properties 0x02, + SkyObjectReplace dawn/dusk
  opacity keyframes.
- **Ceiling:** convincing multi-band sky in stills and slow drift. IMPORTANT
  clarification (GameSky::UpdatePosition acclient.c:308367, verified): each sky
  object follows the camera's ORIGIN (position) only — its m_fOrigin is
  rewritten, its **orientation is left at the object's own world-fixed frame,
  NOT slaved to camera heading**. So the sky does NOT turn with the player:
  the sun/moon/clouds are world-anchored (sun rises east / sets west; turning
  the view pans across them correctly), exactly like retail already behaves and
  like any skybox. Following position (so you can't walk to the horizon) is
  correct/normal. The ONLY missing cue vs takram is **inter-layer parallax** —
  the bands don't shift relative to EACH OTHER as you move (all on one effective
  dome); negligible for a footpace ground game, invisible without fast/close 3D
  motion. No volume, no cloud shadows. Sky is **global per Region** (can't vary
  per landblock). (Earlier "rigid dome / camera-locked" phrasing was misleading:
  it meant no parallax BETWEEN layers, not that the dome rotates with the view.)
- **DLL route: multi-layer with REAL depth/parallax is trivially free** — a
  hooked GameSky::Draw replacement owns the pass and can draw any number of
  domes at real world radii with per-layer camera-parallax offsets.

## Recommendation
The elegant part: **route 1a (data recolor) is the shared foundation.** Alone it
+1b+1c is the improved data-only sky for all users. It ALSO doubles as the
chroma-key that lets the out-of-process companion composite the real takram sky
with correct occlusion. So: ship the data-only sky (A) for everyone as a kit
lane; offer the capture-companion (C) as an enthusiast add-on for near-real
takram; the DLL route (B, Strategy 3) is a middle option if we want baked
in-client sky without a companion. A live volumetric takram sky *inside* the
retail renderer is not possible — the client has no shaders.
