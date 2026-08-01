# Quality preset system

**Phase X.1** of the visual-fidelity push plan. Source of truth for the
flag bag consumed by every later phase (POM, SSAO, CSM, terrain
subdivision, hero assets, etc.).

Implementation: `apps/holtburger-web/scene3d/quality.js`.
Consumed at init by: `apps/holtburger-web/scene3d/index.js` (stored on
`liveScene3d.quality` and `window.__quality`).

## URL grammar

```
?quality=<preset>[&<flag>=<value>]...
```

- `<preset>` — one of `low`, `mid`, `high`, `ultra`. Default is `mid`
  (or `low` on mobile UAs, see below). Unknown values fall through to
  the default.
- Per-feature override — any flag listed in the preset table can be
  passed as a URL param to flip it on top of the preset. Boolean flags
  accept `on|off|true|false|1|0|yes|no`. Integer flags accept any
  parseable integer.

### Examples

| URL | Resolved |
|---|---|
| `?renderer=3d` | `mid` (desktop default) |
| `?renderer=3d&quality=low` | `low` |
| `?renderer=3d&quality=ultra` | `ultra` |
| `?renderer=3d&quality=mid&pom=on` | `mid` with POM overridden on |
| `?renderer=3d&quality=high&csm=off&subdivLevel=2` | `high` with CSM off + subdiv lowered to 2 |
| `?renderer=3d` (mobile UA) | `low` (mobile-default downgrade) |
| `?renderer=3d&quality=high` (mobile UA) | `high` (user opt-in overrides mobile default) |

## Mobile auto-detection

If `navigator.userAgent` matches the mobile UA regex
(`/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i`),
the default tier downgrades from `mid` to `low`. Passing `?quality=...`
explicitly always wins — mobile users can opt into `high`/`ultra` if
they accept the perf cost.

## Preset table

| Flag | low | mid | high | ultra | Source phase |
|---|---|---|---|---|---|
| `antialias` | off | on | on | on | A1 (FPS plan) |
| `shadows` | off | on | on | on | 0.1 |
| `normalMaps` | on | on | on | on | 1.1 |
| `detailFlag` | off | on | on | on | 0.2 |
| `terrainDetailNormal` | off | on | on | on | 1.2 |
| `triplanar` | off | on | on | on | 1.3 |
| `subdivLevel` | 1 | 2 | 4 | 8 | 2.1 |
| `hero` | off | off | on | on | 2.3 |
| `pom` | off | off | on | on | 3.1 |
| `ssao` | off | off | on | on | 3.2 |
| `csm` | off | off | on | on | 3.3 |
| `terrainGrass` | off | off | off | off | Terrain VFX Wave 1A |
| `terrainGrassBlades` | 0 | 24336 | 60025 | 119716 | Terrain VFX Wave 1A |
| `terrainGrassRadius` | 32 | 32 | 48 | 64 | Terrain VFX Wave 1A |
| `terrainGrassStomp` | off | off | on | on | Terrain VFX Wave 1A |
| `terrainSand` | off | off | off | off | Terrain VFX Wave 1B |
| `terrainSandStreamerCount` | 0 | 800 | 2000 | 3000 | Terrain VFX Wave 1B |
| `terrainSandDevilCount` | 0 | 0 | 1 | 2 | Terrain VFX Wave 1B |
| `terrainSandSparkle` | off | on | on | on | Terrain VFX Wave 1B |
| `terrainSandRadius` | 32 | 48 | 64 | 80 | Terrain VFX Wave 1B |
| `terrainSnow` | off | off | off | off | Terrain VFX Wave 2A |
| `terrainSnowSpindriftCount` | 0 | 0 | 1200 | 2500 | Terrain VFX Wave 2A |
| `terrainSnowSparkle` | off | on | on | on | Terrain VFX Wave 2A |
| `terrainSnowPrints` | off | off | on | on | Terrain VFX Wave 2A |
| `terrainSnowRadius` | 32 | 48 | 64 | 80 | Terrain VFX Wave 2A |
| `terrainIce` | off | off | off | off | Terrain VFX Wave 2A |
| `terrainIceRefraction` | off | off | off | on | Terrain VFX Wave 2A |
| `terrainVolcano` | off | off | off | off | Terrain VFX Wave 2B |
| `terrainHaze` | off | off | on | on | Terrain VFX Wave 2B |
| `terrainCrackGlow` | off | on | on | on | Terrain VFX Wave 2B |
| `terrainVolcanoEmberCount` | 0 | 0 | 1 | 3 | Terrain VFX Wave 2B |
| `terrainHazeStrength` | 0 | 0 | 1 | 1.25 | Terrain VFX Wave 2B |
| `terrainVolcanoRadius` | 0 | 0 | 160 | 220 | Terrain VFX Wave 2B |
| `terrainDirt` | off | off | off | off | Terrain VFX Wave 3B |
| `terrainFootfall` | off | on | on | on | Terrain VFX Wave 3B |
| `terrainMudPrints` | off | off | on | on | Terrain VFX Wave 3B |
| `terrainMudWetness` | off | off | off | on | Terrain VFX Wave 3B |
| `terrainDirtDustCount` | 0 | 0 | 800 | 2000 | Terrain VFX Wave 3B |
| `terrainDirtRadius` | 32 | 40 | 56 | 72 | Terrain VFX Wave 3B |
| `terrainSwamp` | off | off | off | off | Terrain VFX Wave 3A |
| `terrainGroundFogCount` | 0 | 8 | 16 | 24 | Terrain VFX Wave 3A |
| `terrainGroundFogRadius` | 32 | 40 | 56 | 72 | Terrain VFX Wave 3A |
| `terrainMarshGasCount` | 0 | 0 | 2 | 3 | Terrain VFX Wave 3A |
| `terrainMarshWisps` | off | off | off | on | Terrain VFX Wave 3A |
| `terrainSwampFireflies` | off | on | on | on | Terrain VFX Wave 3A |
| `terrainSwampMidges` | off | on | on | on | Terrain VFX Wave 3A |
| `terrainRock` | off | off | off | off | Terrain VFX Wave 4A |
| `terrainRockPebbleCount` | 0 | 3000 | 9000 | 18000 | Terrain VFX Wave 4A |
| `terrainRockGritCount` | 0 | 160 | 400 | 600 | Terrain VFX Wave 4A |
| `terrainRockRadius` | 32 | 40 | 56 | 72 | Terrain VFX Wave 4A |
| `terrainTrail` | off | off | off | off | Terrain VFX Wave 0B |
| `terrainTrailRes` | 128 | 128 | 256 | 512 | Terrain VFX Wave 0B |
| `terrainTrailRadius` | 32 | 48 | 48 | 64 | Terrain VFX Wave 0B |
| `terrainTrailFade` | 4 | 4 | 4 | 4 | Terrain VFX Wave 0B |

### Flag glossary

- **`antialias`** — FPS plan A1 (2026-05-18). Passed to
  `WebGLRenderer({ antialias })` at construction. Off at `low`
  saves ~25 % frametime on weaker GPUs (MSAA 4× cost). Toggling
  this flag requires a page reload — the renderer's antialias state
  is fixed at construction.
- **`shadows`** — Phase 0.1. Enable three.js shadow maps (sun-cast
  building shadows). Free win, costs ~3–5 ms / frame.
- **`normalMaps`** — Phase 1.1. Procedural normal maps derived from
  diffuse luminance. Already on by default at every tier (cheap).
- **`detailFlag`** — Phase 0.2. Honour the surface `Detail (0x20000)`
  flag bit when wiring detail-map sampling.
- **`terrainDetailNormal`** — Phase 1.2. Detail normal-map layer on
  the terrain shader (sub-meter rock/dirt detail).
- **`triplanar`** — Phase 1.3. Triplanar texture projection on
  terrain slopes (kills UV stretching on cliffs).
- **`subdivLevel`** — Phase 2.1. Terrain mesh subdivision factor.
  1 = 9×9 (raw heightfield); 2 = 17×17; 4 = 33×33; 8 = 65×65.
  Bicubic interpolation + clamped procedural noise between control
  points. Collision math stays on the 9×9 grid per §4 constraints.
- **`hero`** — Phase 2.3. Authored normal/roughness/AO maps for
  hero surfaces (forge, lifestone, hero buildings).
- **`pom`** — Phase 3.1. Parallax occlusion mapping on stone
  surfaces.
- **`ssao`** — Phase 3.2. Screen-space ambient occlusion post pass.
- **`csm`** — Phase 3.3. Cascaded shadow maps.
- **`terrainGrass`** — Terrain VFX Wave 1A
  (`apps/holtburger-web/docs/2026-07-31-terrain-vfx-plan.md` §3.1). The GRASS
  family (`scene3d/terrain_grass.js`): one camera-scoped instanced blade field
  over terrain codes 1/3/9/21/28/29, wind-bent off the tree-wind gust function
  and crushed flat by the trail map. **OFF on every tier today** (§5.9 ship-OFF;
  the promotion target is `high`/`ultra` on). ⚠ Deliberately **NOT** in
  `BOOL_FLAGS`, for the `gfxRelief`/`terrainTrail` reason: `parseBool` would
  widen the exact-`on` opt-in its decisive reader
  (`scene3d/vfx_flags.js::terrainGrassEnabled`) requires. URL override
  `?terrainGrass=on` / `=off`; anything else warns and does not enable.
- **`terrainGrassBlades`** — Terrain VFX Wave 1A. Instances in the blade pool,
  and **THE degrade lever for this effect**: grass is VERTEX-bound, so 25 %
  render scale buys it nothing and `adaptive_render_scale.js` must never drive
  it (plan §3.1) — the tier does. `low` is **0 = disabled**, the §5.8 contract
  that every effect in this plan is null on `low`. Counts are perfect squares
  (156² / 245² / 346²) because the scatter pool's slot grid is square; any
  other count is rounded up. `?terrainGrassBlades=N`; cannot enable the feature
  on its own. The `high` budget (≤ 3.5 ms on an R9 290) is the plan's
  hypothesis, not a measurement — §8 risk 6 says measure before fixing it.
- **`terrainGrassRadius`** — Terrain VFX Wave 1A. HALF-extent of the blade
  field in metres; it covers twice this, centred on the player, and blades fade
  to zero scale over the last 20 %. Raising it at a fixed blade count thins the
  field. `?terrainGrassRadius=N`. (`?terrainGrassDensity=0..2` scales the count
  itself and is URL-only — there is deliberately no preset key for it.)
- **`terrainGrassStomp`** — Terrain VFX Wave 1A. Whether the blades read the
  trail map and bend/splay where something walked. A SEPARATE key from the
  master so the trail render target can be bisected independently. Also not in
  `BOOL_FLAGS` (same exact-`on` rule). It needs the map to exist: that is
  `terrainTrail` above, so the full live URL is
  `?terrainGrass=on&terrainTrail=on&terrainGrassStomp=on`.
- **`terrainSand`** — Terrain VFX Wave 1B
  (`apps/holtburger-web/docs/2026-07-31-terrain-vfx-plan.md` §3.2). The
  SAND/DESERT family master (`scene3d/terrain_sand.js`) over terrain codes
  10/11/12: camera-scoped wind-advected streamer field, landblock-scoped dust
  devils (existing particle system, `staticOwnerKeyForLb(lb) + ":sand"`
  owners), and a grazing-angle grain sparkle term in the terrain fragment
  shader (reads `uVertexTypes`; no new geometry attribute). **OFF on every
  tier today** (§5.9 ship-OFF; promotion target `mid`+ on). Not in
  `BOOL_FLAGS` (same exact-`on` rule as `terrainGrass`). URL override
  `?terrainSand=on` / `=off`; the three sub-effects gate further via
  `?terrainSandStreamers` / `?terrainSandDevils` / `?terrainSandSparkle`.
- **`terrainSandStreamerCount`** — Terrain VFX Wave 1B. Instances in the
  streamer quad pool. Additive fill-bound quads, so unlike grass this DOES
  get cheaper at reduced render scale; the tier count is still the primary
  lever. `low` is 0 = disabled (§5.8). `?terrainSandStreamerCount=N`.
- **`terrainSandDevilCount`** — Terrain VFX Wave 1B. Max dust devils per sand
  landblock (hash-stable positions per lbKey). `?terrainSandDevilCount=N`.
- **`terrainSandSparkle`** — Terrain VFX Wave 1B. The terrain-shader grain
  sparkle term (glint.js maths, FAM_SAND gate). Not in `BOOL_FLAGS`
  (exact-`on` rule). `?terrainSandSparkle=on` / `=off`.
- **`terrainSandRadius`** — Terrain VFX Wave 1B. Half-extent of the streamer
  field in metres, fading over the last 25 %. `?terrainSandRadius=N`.
- **`terrainSnow`** — Terrain VFX Wave 2A
  (`apps/holtburger-web/docs/2026-07-31-terrain-vfx-plan.md` §3.4). The SNOW
  family master (`scene3d/terrain_snow.js`) over terrain codes 2/15/27
  (`FAM_SNOWICE`): slope-biased spindrift ribbons, the terrain-shader crystal
  sparkle, and persistent footprints. **OFF on every tier today** (§5.9
  ship-OFF; the promotion target is `high`/`ultra` on). Deliberately NOT in
  `BOOL_FLAGS`, for the `gfxRelief`/`terrainTrail` reason: `parseBool` would
  widen the exact-`on` opt-in its decisive reader
  (`scene3d/vfx_flags.js::terrainSnowEnabled`) requires. URL override
  `?terrainSnow=on` / `=off`; the sub-effects gate further via
  `?terrainSnowSpindrift` / `?terrainSnowSparkle` / `?terrainSnowPrints`.
  It does **not** gate `terrainIce` — see that key.
- **`terrainSnowSpindriftCount`** — Terrain VFX Wave 2A. Instances in the
  spindrift ribbon pool, THE degrade lever for the ribbons (the pool rounds any
  count up to a perfect square; 2500 = 50² already is one). `low` and `mid` are
  0 = disabled, the §5.8 contract for every effect in this plan, and turning
  the sub-flag on at those tiers warns once rather than doing nothing silently.
  `?terrainSnowSpindriftCount=N`; cannot enable the feature on its own.
- **`terrainSnowSparkle`** — Terrain VFX Wave 2A. The terrain-shader crystal
  sparkle (`glint.js` maths, `FAM_SNOWICE` gate, a WORLD-SPACE hash, a lobe
  exponent of 420 so the twinkle tracks CAMERA motion). It is the WHOLE `mid`
  tier for this family. Not in `BOOL_FLAGS` (exact-`on` rule).
  `?terrainSnowSparkle=on` / `=off`.
- **`terrainSnowPrints`** — Terrain VFX Wave 2A. Persistent footprints: the
  shared trail map read in the terrain fragment shader as a small parallax dent
  plus a darkening. `low`/`mid` off because the dent needs POM, which is
  `high`/`ultra` only — at `mid` the print would degrade to darkening-only,
  which is coherent but not worth the render target. Needs `terrainTrail`
  as well, so the full live URL is
  `?terrainSnow=on&terrainSnowPrints=on&terrainTrail=on&terrainTrailFade=300`
  (the long fade is snow's "recovery = infinity"; the map's fade is global and
  defaults to 4 s grass springback). Wave 2A decided AGAINST a second high-res
  trail RT — rationale in the `scene3d/terrain_snow.js` header.
- **`terrainSnowRadius`** — Terrain VFX Wave 2A. Half-extent of the spindrift
  field in metres, fading over the last 25 %. `?terrainSnowRadius=N`.
  (`?terrainSnowSlope=0..1` biases placement toward crest faces and is
  URL-only, like `?terrainGrassDensity`.)
- **`terrainIce`** — Terrain VFX Wave 2A. The ICE MATERIAL TREATMENT on codes
  2 (`Ice`) and 27 (`BlueIce`) ONLY — never 15 (`Snow`), which stays matte:
  roughness down, sharper specular, an env term off the `?ibl` cube.
  A SEPARATE master from `terrainSnow` on purpose (plan §3.4): one is
  particles+shader, the other a material change, and bisecting them separately
  matters. Explicitly NOT `MeshTransmissionMaterial`, and it changes no light
  count (it is a fragment term). **OFF on every tier today** (§5.9). Not in
  `BOOL_FLAGS` (exact-`on` rule). `?terrainIce=on` / `=off`.
- **`terrainIceRefraction`** — Terrain VFX Wave 2A. The fake refraction inside
  the ice treatment: ONE extra atlas tap at a view-offset UV, applied after the
  POM march at a third of `uPomScale`. **ULTRA ONLY** — it is the only part of
  the ice treatment with a texture cost. Requires `terrainIce`. Not in
  `BOOL_FLAGS` (exact-`on` rule). `?terrainIceRefraction=on` / `=off`.
- **`terrainVolcano`** — Terrain VFX Wave 2B
  (`apps/holtburger-web/docs/2026-07-31-terrain-vfx-plan.md` §3.6). The
  VOLCANO/OBSIDIAN family master (`scene3d/terrain_volcano.js`) over terrain
  codes 6/25/26: a heat-shimmer pmndrs `Effect` inserted into the EXISTING
  `EffectPass`, landblock-scoped ember vents re-anchored from
  `vfx/components/brazierEmbers.js` (owners
  `staticOwnerKeyForLb(lb) + ":volcano"`), and a crack-glow + obsidian-specular
  term in the terrain fragment shader (reads `uVertexTypes`; no new geometry
  attribute). **OFF on every tier today** (§5.9 ship-OFF; promotion target
  `high`/`ultra` on). Not in `BOOL_FLAGS` (same exact-`on` rule as
  `terrainGrass`). URL override `?terrainVolcano=on` / `=off`; the three
  sub-effects gate further via `?terrainHaze` / `?terrainEmbers` /
  `?terrainCrackGlow`.
- **`terrainHaze`** — Terrain VFX Wave 2B. The heat-shimmer `Effect`.
  ⚠ **The flag name is SHARED with the sand family by design** (plan §3.2 item
  3 — sand's wave deferred the shimmer to wave 2B); it is deliberately NOT
  `terrainVolcanoHaze`. On `high`/`ultra` because it is a fullscreen fill cost
  (and therefore DOES get cheaper at reduced render scale). Not in
  `BOOL_FLAGS` (exact-`on` rule). `?terrainHaze=on` / `=off`.
- **`terrainCrackGlow`** — Terrain VFX Wave 2B. The terrain-shader crack-glow
  vein term AND the code-6-only obsidian specular (one key: one fragment edit,
  one eye-test). On from `mid` up — it is a handful of fragment ALU with no
  POM dependency, so it degrades coherently where POM is off. Not in
  `BOOL_FLAGS` (exact-`on` rule). `?terrainCrackGlow=on` / `=off`.
- **`terrainVolcanoEmberCount`** — Terrain VFX Wave 2B. Max ember vents per
  volcanic landblock (hash-stable positions per lbKey, one distinct
  `FAM_VOLCANO` vertex each). `?terrainVolcanoEmberCount=N`.
- **`terrainHazeStrength`** — Terrain VFX Wave 2B. Multiplier on the shimmer's
  UV-warp amplitude; the 1070 tuning lever, mirrored live on
  `window.__heatHaze.strength`. `?terrainHazeStrength=N`.
- **`terrainVolcanoRadius`** — Terrain VFX Wave 2B. Heat-source radius in AC
  metres around the nearest RESIDENT volcanic landblock centre. Forced to 0
  when no volcanic LB is resident, so the shimmer does not follow the player
  out of the region. `?terrainVolcanoRadius=N`.
- **`terrainDirt`** — Terrain VFX Wave 3B
  (`apps/holtburger-web/docs/2026-07-31-terrain-vfx-plan.md` §3.7). THE family
  master for DIRT/MUD: terrain codes 5 `MudRichDirt`, 7 `PackedDirt`,
  8 `PatchyDirt`, 24 `Argila` and 31 `DesolateLands` (`FAM_DIRT`, derived from
  `scene3d/terrain_families.js`). Ships **off on every tier** (plan §5.9);
  promotion target is `high`/`ultra` true after the 1070 eye-test. Deliberately
  NOT in `BOOL_FLAGS`, so `?terrainDirt=1` does not enable it — the reader
  (`scene3d/vfx_flags.js::terrainDirtEnabled`) requires an exact `=== "on"`, the
  `gfxRelief` rule. URL override `?terrainDirt=on` / `=off`; the four
  sub-effects gate further via `?terrainFootfall` / `?terrainMudPrints` /
  `?terrainMudWetness` / `?terrainDustHaze`.
- **`terrainFootfall`** — Terrain VFX Wave 3B. The dust burst thrown where a
  foot lands on dry dirt, hung off the EXISTING footstep-audio trigger (the
  `Sound.Footstep1/2` animation hook in `scene3d/entities.js`) rather than a
  velocity-derived contact test. On from `mid` because it is a handful of
  alpha quads with no fill cost worth naming — it is the whole `mid` tier for
  this family. Out of `BOOL_FLAGS` (exact-`on` rule).
  `?terrainFootfall=on` / `=off`; `?terrainFootfallPuffs=N` sizes the ring.
- **`terrainMudPrints`** — Terrain VFX Wave 3B. Deforming mud prints: the SHARED
  trail map read in the terrain fragment shader as a dent plus a darkening.
  `high`/`ultra` because the dent needs POM, which is `high`/`ultra` only; at
  `mid` it would be darkening-only, which is the DEGRADE path, not the shipped
  look. **Needs the map to exist**, so the live URL is
  `?terrainDirt=on&terrainMudPrints=on&terrainTrail=on&terrainTrailFade=30` —
  `terrainTrailFade` is GLOBAL and mud asks for 30 s where grass asks for 4 s
  and snow for 300 s; the module warns once in either direction. The
  rain-dependent persistence rides stamp/shader AMPLITUDE, not a second fade,
  and there is still **no second trail render target** (wave 2A's sampler-budget
  ruling). Out of `BOOL_FLAGS`. `?terrainMudPrints=on` / `=off`.
- **`terrainMudWetness`** — Terrain VFX Wave 3B. Wet mud: a darkening plus a
  specular/env sheen on `FAM_DIRT` ground, with clay (24) redder and slicker.
  **`ultra` only**, exactly as plan §3.7's tier table has it — it is a second
  fragment branch over every dirt fragment in view on top of the print's. It
  REUSES the response curve of `scene3d/vfx/components/wetness.js` (same
  up-facing weight, same 0.62 darken, same 0.25 roughness drop) so puddled
  statics and puddled ground agree, and reads the already-smoothed
  `VFX_GLOBALS.uWetness` — the lag is `vfx/weather_inputs.js`'s `WET_TAU` and
  this family adds none. Out of `BOOL_FLAGS`. `?terrainMudWetness=on` / `=off`.
- **`terrainDirtDustCount`** — Terrain VFX Wave 3B. Instances in the dry-dust
  haze pool — plan §3.7's `dustHaze` tier numbers verbatim, and the degrade
  lever for the veil. `low`/`mid` are 0 = disabled (§5.8), and
  `?terrainDustHaze=on` at those tiers warns once rather than silently doing
  nothing. `?terrainDirtDustCount=N`; `?terrainDirtDustDensity=0..2` is the
  URL-only continuous multiplier for the 1070 sweep. Cannot enable the feature.
- **`terrainDirtRadius`** — Terrain VFX Wave 3B. Half-extent of the dry-dust
  haze field in metres, fading over the last 30 %. `?terrainDirtRadius=N`.
  (`?terrainDustHaze` is the on/off; this only sizes the window.)
- **ash fall — DEFERRED, no key.** Plan §3.6 item 4 lists an ultra-only ash
  drifter; plan §8 risk 9 says to parameterise `scene3d/weather/snow.js`
  `SnowSystem` rather than write a third falling-particle system, and to note
  it and move on if that proves invasive. It does: `SnowSystem` seeds and
  re-seeds every particle through ten `Math.random()` calls (against the §5.5
  determinism invariant every terrain-VFX effect is held to), is constructed
  and disposed by `weather/manager.js` keyed on the weather profile's
  `temperature_C` rather than on terrain, and has no notion of a terrain gate
  anywhere in `scene3d/weather/`. Wave 2B therefore ships NO ash: no flag, no
  preset key (a documented flag with no reader fails the url-flags lint, and a
  preset key with no consumer is dead config).
- **`terrainSwamp`** — Terrain VFX Wave 3A
  (`apps/holtburger-web/docs/2026-07-31-terrain-vfx-plan.md` §3.5). FAMILY
  MASTER for SWAMP/MARSH: the shared ground fog, marsh-gas vents + their wisp
  ignition, and the GROUND anchor sources for the existing firefly and pollen
  components. Terrain code 4 (`MarshSparseSwamp`) = `FAM_SWAMP`, derived from
  `scene3d/terrain_families.js`. ⚠ Code 23 (`SeaSlime`) is WATER by default
  (plan §3.8.3) and joins this family ONLY under `?strictWaterCodes` — nothing
  in the swamp code lists it. Ships **off on every tier** (§5.9) exactly like
  `terrainGrass`/`terrainSand`/`terrainSnow`/`terrainVolcano`; `low` is `null`
  in the plan's tier table, so every knob below is 0/false at `low` and even
  `?terrainSwamp=on` there renders nothing. Nothing in this family touches the
  terrain fragment shader. URL override `?terrainSwamp=on` / `=off`; the five
  sub-effects gate further via `?terrainGroundFog` / `?terrainMarshGas` /
  `?terrainMarshWisps` / `?terrainSwampFireflies` / `?terrainSwampMidges`.
- **`terrainGroundFogCount`** — Terrain VFX Wave 3A. Cards in the camera-centred
  fog ring (`scene3d/ground_fog.js`) — plan §3.5's tier table verbatim
  (mid 8 / high 16 / ultra 24). ⚠ The shared scatter pool rounds the request UP
  to a perfect square (8 ⇒ 9, 24 ⇒ 25); `__terrainSwamp.stats().fog.count` is
  authoritative. Fill-bound, so it gets cheaper at 25 % render scale
  automatically. `low` is 0 = disabled (§5.8). `?terrainGroundFogCount=N`.
  ⚠ The flag NAME is deliberately `terrainGroundFog`, not `terrainSwampFog`:
  the module is effect-agnostic and SNOW/VOLCANO compose it later with their
  own palette and family set (plan §3.5 item 3).
- **`terrainGroundFogRadius`** — Terrain VFX Wave 3A. Half-extent of the fog
  ring in metres; it covers 2× this, fading over the last 35 %.
  `?terrainGroundFogRadius=N`.
- **`terrainMarshGasCount`** — Terrain VFX Wave 3A. Max bubble vents per swamp
  landblock (hash-stable positions per lbKey, one distinct `FAM_SWAMP` vertex
  each, owner key `staticOwnerKeyForLb(lb) + ":swamp"`).
  `?terrainMarshGasCount=N`.
- **`terrainMarshWisps`** — Terrain VFX Wave 3A. The rare ~2 s will-o'-the-wisp
  ignition over a vent, on a 140 s timer. **ULTRA ONLY** per plan §3.5, and
  composed with the gas (a wisp is an ignition OF the gas, so it is forced off
  when `terrainMarshGasCount` is 0). A FINITE additive-sprite emitter that
  self-expires — never a `PointLight` (§5.2). Strict exact-`on` URL override.
- **`terrainSwampFireflies`** — Terrain VFX Wave 3A. Enables the GROUND anchor
  source for the EXISTING `particle.foliageFireflies` component over swamp
  landblocks (marsh-green additive sprite, lower drift). **Not a second firefly
  system** (plan §3.5 item 1): the descriptor calls `foliageFireflies.emit()`
  and reuses `firefliesGate` by identity, and `?foliageFireflies` still
  independently owns the canopy anchors. On from `mid` because one synthesized
  emitter per swamp landblock is the cheapest thing in this plan.
  Strict exact-`on` URL override.
- **`terrainSwampMidges`** — Terrain VFX Wave 3A. The same re-anchor contract
  for `particle.foliagePollen`: a dark alpha midge column with a tighter orbit
  (delivered through the ANCHOR RADIUS — `foliageAmbient.js` floors the sprite
  scale to pollen's authored value and that clamp is not ours to move). A DAY
  effect, since it reuses `pollenGate`. Strict exact-`on` URL override.
- **`terrainGroundFogSoftness` — URL-ONLY, no preset key on any tier.** The fog
  card's soft-particle fade against the scene depth buffer. The path is fully
  implemented and tested (`test_ground_fog.mjs`): log-depth decode (plan trap
  T4), NEAREST filtering forced on the supplied texture, and a sentinel-aware
  threshold whose 0 default means "never sample" (`OPTICAL_EFFECTS_HANDOFF.md`,
  the R9 290 HalfFloat/LINEAR regression). What is deliberately NOT wired is
  the texture: `atmosphere_pipeline.js`'s `sceneDepthTexture` is attached to
  BOTH composer ping-pong targets, i.e. it is the LIVE depth attachment while
  the world pass these cards draw in is running, so sampling it from that pass
  is a framebuffer feedback loop ANGLE may reject. No tier may arm it; the 1070
  adjudication is `&terrainGroundFogSoftness=2` plus
  `window.__terrainSwamp.setFogSceneDepthTexture(...)`. Without it the card
  still fades analytically (height within the card, ring distance, near plane).
- **`terrainRock`** — Terrain VFX Wave 4A
  (`apps/holtburger-web/docs/2026-07-31-terrain-vfx-plan.md` §3.3). THE family
  master for ROCK/BARREN — terrain codes 0 `BarrenRock`, 13 `SedimentaryRock`,
  14 `SemiBarrenRock`, 30 `olthoi`, derived from `terrain_families.js` and never
  hardcoded. **OFF on every tier** (§5.9 ship-OFF); the promotion target is
  `high`/`ultra` on. It composes with both sub-effects, so `?terrainRock=on`
  lights the tier's intended set. `low` is `null` for the whole family: both
  counts are 0, so `?terrainRock=on` there renders nothing and warns once.
  Nothing in this family touches the terrain fragment shader, and plan §3.3's
  third item (footfall dust puffs) is the wave-3B DIRT mechanism — it is not
  re-implemented here and does not yet fire on rock. ⚠ Deliberately NOT in
  `BOOL_FLAGS`, the `gfxRelief` rule. URL override `?terrainRock=on` / `=off`;
  the two effect flags are `?terrainRockPebbles` / `?terrainRockGrit`.
- **`terrainRockPebbleCount`** — Terrain VFX Wave 4A. Instances in the
  pebble/rubble field, plan §3.3's tier table verbatim (`low: null` ⇒ 0, mid
  3000, high 9000, ultra 18000). **THE degrade lever for this family**: pebbles
  are the one OPAQUE, LIT scatter field in the programme, so they are
  vertex+fragment bound and buy nothing from the 25 % render scale — count is
  the only knob that moves them. The shared scatter pool rounds the request UP
  to a perfect square (3000 ⇒ 3025, 18000 ⇒ 18225);
  `__terrainRock.stats().pebbleField.pool.count` is authoritative.
  `?terrainRockPebbleCount=N`.
- **`terrainRockGritCount`** — Terrain VFX Wave 4A. Instances in the grit
  streamer field. §3.3's own tier table names pebbles only, so this ladder is
  §3.2's streamer ladder (800/2000/3000) at the **1/5 density** §3.3 item 2
  asks for. Additive and fill-bound, so it DOES get cheaper at 25 % render
  scale. Same square-rounding. `?terrainRockGritCount=N`.
- **`terrainRockRadius`** — Terrain VFX Wave 4A. Half-extent in metres of BOTH
  rock windows; each field covers 2× this. Tighter than the sand/snow ladder on
  purpose — an opaque lit field wants a smaller window than an additive veil.
  Pebbles fade over the outer 22 % by SHRINKING to zero scale (an alpha ramp
  would drag the whole field into the transparent pass); grit fades over the
  outer 25 %. `?terrainRockRadius=N`.
- **`terrainRockDensity` — URL-ONLY, no preset key on any tier.** A 0..2
  multiplier on BOTH rock counts, default 1.0, because plan §3.3 gives the
  family one density knob and the per-effect levers are the two `*Count` keys.
  Same contract as `terrainGrassDensity` / `terrainDirtDustDensity`: the tier
  owns the shipped counts and this is the continuous A/B knob for the 1070 perf
  sweep. `0` disables the family's geometry; out-of-range falls back to 1.0.
- **`terrainTrail`** — Terrain VFX Wave 0B
  (`apps/holtburger-web/docs/2026-07-31-terrain-vfx-plan.md` §2.2/§3.1). The
  shared stomp / footprint render-target trail map (`scene3d/trail_map.js`):
  grass reads it to flatten blades where the player walks, snow to dent
  drifts, mud to keep a print. **OFF on every tier today** — plan §5.9 ships
  each terrain effect off and promotes it deliberately after the §6 bar; the
  promotion target for this key is `high`/`ultra` on, `low`/`mid` off (it is a
  render-target pass plus a fullscreen quad, so it is fill-bound and gets
  cheaper at 25 % render scale, but `low` exists to not pay).
  ⚠ Deliberately **NOT** in `BOOL_FLAGS`: `parseBool` also accepts
  `1`/`true`/`yes`, which would widen the exact-`on` opt-in that its decisive
  reader (`scene3d/vfx_flags.js::terrainTrailEnabled`) requires — the same
  rule `gfxRelief` follows, for the same reason. The URL override is
  `?terrainTrail=on` / `=off`; anything else warns and does not enable.
- **`terrainTrailRes`** — Terrain VFX Wave 0B. Trail-map texels per side.
  At the default 96 m extent, 256 squared is 0.375 m/texel — deliberately
  coarse (plan §8 risk 7 flags it as too coarse for a single snow footprint;
  Wave 2A decides whether snow gets a second, smaller, higher-res map rather
  than re-purposing this one). `?terrainTrailRes=N`; cannot enable the
  feature on its own.
- **`terrainTrailRadius`** — Terrain VFX Wave 0B. Trail-map HALF-extent in
  metres; the map covers twice this. Raising it trades texel density for
  reach at a fixed `terrainTrailRes`. `?terrainTrailRadius=N`.
- **`terrainTrailFade`** — Terrain VFX Wave 0B. Seconds for a full stomp to
  recover to zero. 4 s is grass springback (plan §3.1); mud wants ~30 s
  (§3.7) and snow effectively never (§3.4), so a family overrides per effect
  rather than moving this global. `?terrainTrailFade=N`.

## Devtools inspection

```js
> window.__quality
{
  preset: "mid",
  flags: { shadows: true, normalMaps: true, ..., subdivLevel: 2, ... },
  source: "default"
}
```

`source` is `"url"` (preset explicitly requested), `"localstorage"`
(set from the Graphics tab in the bar), `"mobile-default"`
(downgraded from mid), or `"default"` (desktop default).

## Graphics settings tab

The bar's gear icon (⚙) now has a **Graphics** tab that persists a
`holtburger_graphics_v1` localStorage payload:

```js
{
  preset: "mid",                 // optional explicit preset
  flags: { antialias: false },   // per-flag overrides (sanitized at read)
  extras: { renderScale: 1.0 }   // UI controls not yet consumed by quality.flags
}
```

`getQuality()` merges in this order (highest wins): URL params →
localStorage overrides → mobile-UA default → desktop default. Most
flag changes take effect on reload because consumers cache flag
values at init.

## How later phases consume this

Each phase that gates on quality reads `liveScene3d.quality.flags.<flag>`
at the appropriate init / gate point. Example shape (illustrative,
each phase will add its own gate):

```js
// scene3d/terrain.js, Phase 1.3 triplanar gate
if (scene3d.quality?.flags?.triplanar) {
    material.defines.USE_TRIPLANAR = "";
}
```

Per the plan-doc §4 constraint 6, new features default **off** at every
tier and graduate to mid/low only after live-ACE perf validation. The
preset table above is the current as-built state; phases that haven't
shipped yet have their flag pinned to `off` across the board until
their phase lands.

## Non-goals (deferred)

- **`?quality=auto`** — self-tuning preset that boots, measures FPS,
  then picks dynamically. Deferred per the plan-doc.
- **Per-quality LOD bias** — fold into `subdivLevel` for now;
  separate LOD flag if/when it earns its keep.
- **Backwards-compat shims** — `?quality=` is a fresh knob. No
  legacy params to honour.
