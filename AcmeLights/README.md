# AcmeLights

holtburger-tier lighting for the retail AC client, as a Chorizite plugin. Drives the
client's OWN fixed-function D3D9 light pipeline (the same machinery holtburger-web
re-implemented) via two inline detours, plus later a luminance bloom post-process.

Research + plan: `../docs/lights-port/` (PLAN + two Explore reports).

## Phases (see PLAN)
- P0 enumerate FF pools (log)  · P1 raised pools + viewer headlamp
- P2 flame flicker + ambient fixes  · P3 dynamic spell/portal/glow lights
- P4 importance slot selection  · P5 AcmeBloom luminance post-process

## Live config: `C:\Temp\acdt\lights.cfg` (re-read 1/s; keys in Lib/LightsConfig.cs)

## Hooks (map-build VAs, via ACBindings statics)
- PrimD3DRender::UpdateLightsInternal @0x0059BEE0 — per-viewpoint heartbeat
- SmartBox::SetWorldAmbientLight @0x004530E0 — ambient red-bias + dungeon fix
- RenderDeviceD3D::EndScene @0x005A0E10 — POST-detour backbuffer dump (extrahooks>=1, dump=1)
- SmartBox::m_renderingCallback (SmartBox+276, ZERO-detour pointer slot) — bloom passes at the
  post-3D/pre-UI boundary; re-asserted per frame from the heartbeat (SmartBox::Reset zeroes it).
  Replaces the SceneTool::EndFrame detour, whose cdecl trampoline destabilized the client.

Build: `DOTNET_ROLL_FORWARD=LatestMajor dotnet build AcmeLights/AcmeLights.csproj -c Release`.
Deploy: scp AcmeLights.dll + deps.json + ACBindings/FASM/manifest to the 1070 plugins dir.

## P4 — importance-ranked per-draw light selection (`Services/LightSelection.cs`)

Full detour on `Render::minimize_object_lighting` @0x0054E090 (clean `void __cdecl()`), replacing
retail's **first-8-overlap, dynamics-first** chooser with a true best-of-70 ranking. Design,
decomp citations and the live-validation script: `../docs/lights-port/P4-SELECTION-2026-08-23.md`.

- **Eligibility is retail's, bit for bit** (`remove_object_light` inlined), so we can only
  re-order retail's own candidate set, never add a light it rejected.
- **Score = attenuated contribution AT THE LIT OBJECT**, using retail's own `calc_point_light`
  attenuation evaluated at the nearest point of the object sphere:
  `min(1, atten·(1 − d/range)·intensity) · luminance(color)`, `range = falloff × selrange`.
- **Scope is the PVS**: `Render::world_lights` is already filled by the client's own portal/cell
  walk, so "the torch in the next visible room counts" is free. **No occlusion test exists** — a
  bench in front of a torch does not dim it.
- **Reference point is the PLAYER, never the camera**: the score is a light-to-object distance in
  a viewer-local frame, so it is *invariant* under all player and camera motion — strafing behind
  a pillar cannot reorder the set. Hysteresis (`selhysteresis`, holtburger's mechanism) damps the
  only residual churn: PVS membership changes and moving dynamics.
- **Budget 8 and pools 60/10 are structural ceilings**, not choices: `Render::curLightUsage` is an
  8 × 12-byte table (bounded by `Render::ymin`/`xmax` in the shipped map) and `LightParms` holds
  `static_lights[60]`/`dynamic_lights[10]`. `D3DCAPS9.MaxActiveLights` is read once and can only
  clamp down.
- **Static wall-torch FLICKER lands here**: we clear the `carryOver` byte on exactly the flame
  slots so `enable_active_lights` re-uploads them, which is what finally lets P2's per-frame
  `Diffuse` edits reach D3D — without poking the unverified `lightCacheing` global.
- Hot path is allocation-free (`NativeMemory` buffers, no LINQ/dictionaries/logging); the struct
  gather is hoisted into a per-viewpoint snapshot.

cfg keys: `selection` (1), `selbudget` (8), `selhysteresis` (1.15), `selrange` (1.5),
`selflicker` (1), `selcaps` (1). **`selection=0` restores retail exactly** — at startup the detour
is never installed; live it chains straight to `OriginalFunction`.
## P3 — glow dynamic lights (`Services/GlowLights.cs`, default ON)

Portals, war-spell projectiles in flight, their impact flashes and glowing creatures cast real
FF dynamic lights. Full design + the cell-scoping proof + the live-validation script:
`../docs/lights-port/P3-GLOWLIGHTS-2026-08-23.md`.

- **The gap** is not "retail never lights these" — portals and projectiles ship `LIGHTING_ON`
  (0x800) on setups with an authored `lights` block. It is that the per-frame refill
  (`CObjCell::add_dynamic_lights` → `CEnvCell::add_dynamic_lights`, acclient.c:349094) walks
  `CEnvCell::visible_cell_table`, which holds **EnvCells only** — so **outdoors every object
  dynamic light in the world is silently dropped**. P3 re-donates those, and synthesises one for
  luminous objects that were never authored a light (the classic wisps).
- **Classification** is memoised per `CSetup` DID: authored `CSetup::lights[0]` (colour/intensity/
  falloff/offset straight from the DAT) first; else peak surface `Luminosity >= glowlum` (0.9)
  **and** luminous-surface fraction `>= glowlumfrac` (0.25). The fraction test is load-bearing —
  a bare `>0` fires on 19% of creature setups (glowing eyes), the pair on 5.9% and on none of ten
  mundane controls.
- **No through-wall bleed**: `add_dynamic_light`'s `cellId` provides ZERO containment (it only
  feeds `LandDefs::get_block_offset` for the distance sort, and that reads only the landblock).
  Retail's containment is the PVS donor set, so GlowLights applies the same rule with retail's own
  test — indoor emitters must satisfy `CEnvCell::GetVisible(cellId) != 0`. `glowcontain=0` is the
  A/B that reproduces the bleed on demand.
- New hook: **SmartBox::set_viewer @0x00452C80 POST-detour** (`NativeHooks`, its own delimited
  block) — runs after the client's dynamic wipe+refill, so injected lights live exactly one frame.
  Per-frame cost is proportional to tracked emitters (usually under 10), not to all objects; the
  4 Hz classify scan rides the existing `m_renderingCallback` slot.
- **Self-evident classes**: portals and lifestones are trusted on ITEM_TYPE and need no luminosity
  evidence — 26 of 47 portal setups author no light and have no luminous surface (the Red Spire
  portal is one), and the lifestone is 1 lit surface of 7 at 0.75, the same shape as the
  glowing-eye false positives the fraction test exists to reject. Missiles stay evidence-based
  (arrows are `MISSILE_PS` too).
- Knobs: `glowlights` (master, 0 = frame bit-identical) · `glowportals` `glowprojectiles`
  `glowcreatures` `glowlifestones` `glowstatics` · `glowintensity` `glowfalloffscale` `glowsynthintensity`
  `glowsynthfalloff` `glowlift` `glowpulse` · `glowlum` `glowlumfrac` · `glowmax` `glowrange`
  `glowscanhz` · **`glowcontain`** · `glowportalboost` `glowportalcolor` `glowprojectileboost`
  `glowschool` · `glowimpactms` `glowimpactboost` `glowimpactfalloff` · `glowlog`.
