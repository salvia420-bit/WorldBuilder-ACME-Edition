# Handoff — particle effects, tier 1 shipped + tier 2 designed (2026-10-10)

Owner, after the 2026-10-09 per-emitter pass (`117d2456`): "the change wasn't
huge … we are aiming for visual superiority". This doc covers both tiers of the
follow-up plan:

- **Tier 1 (five items) is implemented and tested.** Effects light the world
  (including the terrain), particle glow is separated from particle colour, GPU
  child particles, screen-space distortion, and smoke that reads as volume.
- **Tier 2 (five items + showcase compositions) is designed here**, against
  the code as it now stands, ready to pick up.

Read `HANDOFF-particle-fx-2026-10-09.md` first for the per-emitter catalog, the
profile table and the display calibration this builds on.

## Why the 2026-10-09 pass looked small

- **Same cards.** It re-shaded the retail sprites per pixel. The textures are
  the same (about two-thirds are 64×64 or smaller), the counts are the same
  (half the emitters cap at 15 particles or fewer) and the motion is the same.
  In most of the 164 before/after plates the two halves are hard to tell apart.
- **Calibration pulled toward retail.** The display calibration (alpha ×1/5,
  additive ×K/5) deliberately brought brightness back to retail. One channel
  had to carry both "the right colour" and "the glow", so every emitter's gain
  had to stay low to keep from flooding the scene bloom (threshold 1.1, tuned
  against the low sun).
- **The world never reacted.** Nothing lit the ground, nothing bent the air,
  and smoke never took sun or shadow.

Tier 1 changes what reaches the screen *around* the sprites, each emitter by
its own numbers.

## Tier 1 — what shipped

Six quality-preset switches (`scene3d/vfx/fx_tier1.js`, mirrored into
`scene3d/quality.js` PRESETS + BOOL_FLAGS, so `?flag=on|off`, the saved
Graphics settings and the preset all work):

| switch | low | mid | high / ultra | what |
|---|---|---|---|---|
| `fxLights` | off | **on** | **on** | FX light sources: emitter lights + PlayEffect flashes |
| `terrainLights` | off | **on** | **on** | the terrain takes the light pool's point lights |
| `fxKids` | off | **on** | **on** | GPU child particles |
| `fxSmoke` | off | **on** | **on** | smoke shading (sun, shadow, noise, flow, rim) |
| `fxDistort` | off | **on** | **on** | screen-space distortion |
| `fxGlow` | off | off | **on** | the particle glow buffer |

The laptop probes to `low`, so a bare boot there shows none of this. Every A/B
below works per page load with `?flag=off|on`. Rows of the URL-flag table:
`docs/url-flags.md` (after `particleAddCal`).

### Per-emitter data: rows grow from 6 to 10 texels

`tools/particle-fx/tier1.py` turns every catalog emitter into tier-1 terms. It
combines the family recipe (what the sprite is), the behaviour (standing,
plume, burst, trail…), the measured DAT numbers (sprite size, lifespan, live
count, texture colour, blend) and context tags (portal, hearth, buff, debuff,
spell projectile). The result goes to `data/particle-fx-tier1.json`.
`scripts/gen-particle-fx-profiles.mjs` merges it into
`scene3d/particles/particle_fx_profiles.js`. Each row now holds 40 floats:

```
[gain, core, sat, tintCurve | tint0.rgb, fadeIn | tint1.rgb, fadeOut | erode, flicker, flickerHz, twinkle |
 spin, wobble, soft, nearFade | lit, pulse, pulseHz, edgeSoft |
 glow, kids, kidKind, kidSize | kidLife, kidSpread, kidGain, rim | sunLit, noise, flow, shadow |
 light, lightRange, distort, distortKind]
```

`FX_ROW_EXTRA[row]` holds the CPU-only `[lightColor.rgb, distortRadius]`.
`particle_fx.js::particleFxTier1(row)` is the accessor.

**Coverage.** 1,970 retail emitters and 13 synthesized profiles carry tier-1
terms:

- 1,315 lit;
- 1,529 glowing;
- 1,297 with children;
- 228 distorting;
- 328 sun-shaded, 693 noise-eroded, 437 shadow-receiving.

The sky chain, misc and none rows stay at zero. There are 1,620 distinct rows.

**Regenerating:**

```sh
cd tools/particle-fx
PFX_WORK=<work dir with emitters_ctx.json + surface_features.json> python3 tier1.py
cd ../.. && node scripts/gen-particle-fx-profiles.mjs
```

The work dir comes from `datcat.py` + `enrich.py` + `features.py` (README
there). Per-DID corrections go in `tools/particle-fx/tier1_overrides.json`
(`{"emitters": {"0x320002CD": {"light": 40}}}`; `null` removes a term). No
overrides file is committed yet.

### 1. Effects light the world (`fxLights`, `terrainLights`) — `scene3d/vfx/fx_lights.js`

**Emitter lights.** Each lit emitter gets one source carrier in
`scene3d.activeLights` (`ParticleManager._bindTier1`). It is the same duck
type as the viewer light: `getWorldPosition`, `color`, `intensity`,
`distance`, `decay`.

- **Colour:** the texture's alpha-weighted mean × mid-life tint, normalised.
- **Intensity:** in DAT LightInfo units (setup torches author 20–100), scaled
  by sprite size. Portals get ×1.3, buff swarms ×0.6, hearths ×0.85.
- **Modulation:** flickers and breathes with the row's own `flicker` and
  `pulse`, and fades as the emitter runs dry.
- **Finite emitters (bursts):** follow their live particle count against its
  peak, and carry `__dynamicPriority` (they outrank torches within 48 m, like
  projectile lights).

**Flashes.** Every PlayEffect cue fires one through
`play_effect_vfx.js::_fireTier1Cue` → `vfx/fx_cues.js`:

- a light flash at chest height (attack / hold / quadratic decay, optional
  flicker);
- for the forceful cues (explode, collision, dispel, death, create, portal,
  level-up, augmentation, aetheria, the three smites), a shockwave ring.

`FX_CUES` covers every placeholder look except the matter and darkness ones
(blood splatter, dirty fighting, specialStateBlack). Concurrent flashes are
capped at 10.

**Pool discipline.** Nothing is added to the scene and the per-type light
count never changes (the relink-freeze rule). The pool picks the nearest
sources into its constant 16 point slots.

**Dedupe and scoping**, re-checked twice a second:

- An emitter light within 1.5 m of a NON-FX source (a setup LightInfo lamp)
  is suppressed, so a brazier keeps its retail lamp and does not double up.
- An emitter light within 1.2 m of a stronger FX light is suppressed: a
  portal's swirl, rim and motes become one light.
- Only lights within 48 m of the player are registered at all.
- Lights from outdoor static chains (render layer 0) carry `__lbKey`, so in a
  sealed dungeon the pool's cell scoping drops them, exactly like the setup
  lamps.

**Terrain.** `feedTerrainFxLights` (loop.js, after the pool feed and the flame
flicker) copies the nearest 8 LIT pool slots into shared uniforms. The player's
viewer lantern is excluded: it is an object light, and lighting the ground
round the player all day looked wrong. Those uniforms are bound by identity on
every terrain material:

- `uFxLightPos[8]`
- `uFxLightCol[8]`
- `uFxLightGain` = (gain, knee)

The terrain fragment captures the UNLIT albedo (`hbFxAlbedo`, before the
retail Gouraud term) and adds `albedo · gain · E / (1 + knee · E)`. E is the
statics' retail light law: linear falloff to the range, half-Lambert wrap,
1/π. The light is fogged with the terrain.

- **Knee 0.6.** A 20–100-intensity torch makes a pool of light rather than a
  white disc.
- **Gain 0.18 by day, 0.75 at night and indoors**, so a torch barely shows at
  noon and paints its pool at night.

Grass (a Lambert material) already took pool lights; now the ground under it
agrees. **This is beyond retail:** `ACRender::landPolyDraw` drew the landscape
with fixed-function lighting off (acclient.c:719994), so torches never lit the
ground there.

**Tuning:**

- `?terrainLightGain=N` or `__fxLights.terrainGain`.
- Day / night gains: `TERRAIN_FX_LIGHT_DAY_GAIN` / `TERRAIN_FX_LIGHT_NIGHT_GAIN`.
- Knee: `TERRAIN_FX_LIGHT_KNEE`.

**Diagnostics:** `__fxLights.stats()` (flashes, emitter lights, registered,
suppressed, terrain feed).

### 2. Glow separated from colour (`fxGlow`) — `scene3d/vfx/fx_glow_effect.js`

**The effect.** A pmndrs Effect sits in the post half of the chain, after
the atmosphere and before lens flare, bloom, vignette and tone mapping. On the
single chain it goes after horizonDissolve.

**Each frame:**

1. Draws every additive FX bucket a second time through a "twin"
   InstancedMesh. The twin shares the bucket's geometry and instance buffers
   (no re-upload) and uses the glow-variant material:
   `particle_fx.js::makeParticleFxGlowMaterial`, define `HB_FX_GLOW`, one
   constant program `hbParticleFxGlow1`. The target is a half-res HDR buffer.
2. Mip-blurs it (pmndrs MipmapBlurPass, 5 levels, radius 0.8).
3. Adds the result to the scene.

**Shader terms.**

- The glow variant writes `glow` × the particle's calibrated colour.
- It drops glow-less rows in the vertex stage.
- It occludes by hand against the composer's scene depth (0.5 m soft edge).
  The glow buffer has no depth attachment, so sampling the depth there is not
  a feedback loop.
- `tier1.py` damps dense emitters and tapers big sprites, because a halo
  sprite already IS a halo.

**Chunk boundary.** The composer never imports the particles chunk. The
buckets, their glow materials and the per-frame uniforms come through a
provider that `particle_manager.js` registers in
`particles_over_clouds.js::registerFxGlowProvider`.

**Live tuning:** `__fxGlow.intensity`, `.strength` (× every row's `glow`),
`.radius`, `.stats()`.

### 3. GPU child particles (`fxKids`) — `scene3d/particles/particle_fx_kids.js`

Up to 8 children per retail particle. They are computed entirely in the vertex
shader from the parent's position, velocity (from the per-slot position
history), age, opacity, row and seed, plus the FX clock. They are stateless,
with no per-child JS:

- **ember:** born along the parent's recent path, rising and drifting,
  cooling from white-gold to red.
- **glitter:** orbiting four-point glints.
- **spark:** ballistic under gravity, stretched along its velocity.
- **drip:** falls off the parent.
- **inflow:** spirals into the centre.
- **crackle:** flecks hopping round a lightning arc.

**Draw structure.**

- ONE instanced draw per (manager, render layer). Per-parent attributes use
  `meshPerAttribute = 8`; the child index is `gl_InstanceID % 8`, and children
  past the row's count collapse off-screen.
- Records ride the bucket walk (`_appendInstances`).
- The mesh joins the late particle pass with its parents.
- One program (`particle-fx-kids`).

**Bug found and fixed on the GPU smoke.** The velocity-stretch basis was a
reflection (det −1), which flipped every quad's winding and front-face
culling dropped all of them. The basis is now a rotation; the shader comment
says why.

### 4. Screen-space distortion (`fxDistort`) — `scene3d/vfx/fx_distort.js` + `fx_distort_effect.js`

This generalises the volcano heat haze to every source:

- heat columns over fires;
- a slow vortex twist, plus a faint inward pull, over portals and dark
  vortices;
- an expanding shockwave ring on bursts and on impact / level-up / create /
  death / smite cues;
- soft ripples over runes.

**The effect.** A `mainUv` + DEPTH effect (no colour work) in the atmosphere
pass, right after the heat haze. Each source bends only what lies at or
behind it. It uses the raw log-depth decode, avoiding the heat_haze T4 trap.
At most 16 sources a frame, strongest on screen first, fading past 60 m.

**Split chain.** With `particlesOverClouds` the late particles draw after
this pass, so the flames stay sharp and the air behind them bends.

**Sources.** Emitter-bound (`ParticleManager._bindTier1`) or one-shot
(`spawnFxShockwave`). The registry has no postprocessing import.

**Live tuning:** `__fxDistort.amplitude`.

### 5. Smoke that reads as volume (`fxSmoke`) — `scene3d/particles/particle_fx.js`

**Compilation.** Compiled into the FX bucket programs as `HB_FX_SMOKE`. The
variant is latched once, at the first FX material, so a session never grows a
second program family. Keys become `hbParticleFxAdd1s` / `hbParticleFxAlpha1s`,
plus `c` when the cascades are live.

**Terms:**

- **Sun shading.** A pseudo-normal from the screen gradient of the sprite's
  own alpha, normalised per sprite-UV unit, with a half-Lambert wrap against
  the sun (`uFxSunWorld`, from the same heading/pitch the terrain uses; fades
  at night and indoors).
- **Sun shadow.** ONE CSM tap per particle, in the vertex stage, using a
  `sampler2DShadow` on the cascades' shared uniforms bound by identity. Smoke
  in a roof's shadow goes dark.
- **Noise breakup + age erosion.** A procedural 128² tileable noise texture
  (deterministic). Puffs dissolve into wisps instead of shrinking as blobs.
- **Curl-noise UV flow.** Licking flames, roiling smoke.
- **Back-lit rim.** Forward scatter when looking toward the sun.

**Neutral rows** reproduce the old program's pixels exactly (GPU-checked).
`?fxSmoke=off` keeps the 2026-10-09 program keys byte-identical.

### Also fixed: the display calibration on the default boot

The 2026-10-09 calibration (alpha ×1/exposure, additive ×K/exposure) was only
applied inside the late particle pass. That pass exists only with
`?clouds=on`, which is opt-in. On the default boot the single post chain
applies the same ×5 exposure, so alpha smoke drew near-white there.

`particleFxFrame` now follows `liveScene3d.renderer.toneMappingExposure` on
every path, through its light tick. The renderer only carries exposure 5 when
the atmosphere composer is up; without it the factor stays 1.

**This is a visible change on default boots:** soot is dark again, as the
2026-10-09 review intended.

## Verification (no GPU box)

- **`node test_particle_fx_tier1.mjs`** — 66 checks:
  - the switches and presets;
  - the data (portal / flame / smoke / buff rows, ranges, sky stays zero);
  - the flash envelope;
  - activeLights sync and priority;
  - dedupe against setup lamps and between FX lights;
  - the 48 m radius;
  - dungeon scoping;
  - release;
  - `writePoolSlot` accepting the carrier;
  - the terrain feed (nearest first, viewer skipped, day / night gain, off ⇒
    parked) and the assembled terrain GLSL order;
  - distortion projection, ring expiry, the 16-source cap, flag off;
  - cue coverage;
  - children through `ParticleManager` (8 instances per record, row / seed,
    velocity, late pass, `fxKids=off`);
  - light / distortion bind + release;
  - the glow provider and material, both effects;
  - the smoke + CSM variant;
  - the noise;
  - calibration without the late pass.

  It is registered in the JS gate.
- **`capped-build node test_particle_fx_tier1_gpu.cjs`** — headless SwiftShader
  WebGL2, log depth, 15/15 checks:
  - the smoke + CSM program compiles, with the neutral row equal to the plain
    FX program exactly (difference 0) and a smoke row shading differently;
  - the glow draws in front of the scene, is occluded by a wall in front of
    it, and draws nothing for a glow-less row;
  - a flame record draws its embers and a row without children draws nothing;
  - the terrain loop lights the ground under a light and not beyond its
    range, stays warm and soft-kneed, and draws nothing at gain 0;
  - the distortion effect compiles in a pmndrs composer and a shockwave moves
    pixels;
  - the glow effect compiles in a composer and adds light round the particle;
  - no GL errors.
- **Existing suites:**
  - `test_particle_fx.mjs` 69/69, updated for the 10-texel layout and the
    program-key helper;
  - `capped-build node test_particle_fx_gpu.cjs` 19/19, with the smoke variant
    now compiled in: neutral rows are still equal to stock to 1.5e-8;
  - the full JS gate under `capped-build`: 512 passed / 0 failed
    (`test_particle_fx_tier1` registered);
  - `lint-url-flags` and `gen-modulepreload --check` (six new boot modules
    preloaded).
- **Existing tests whose pins moved with this change** (each update keeps the
  test's intent):
  - `tests/look_pass`, `tests/clouds_main_pass` and `test_terrain_volcano`
    pin the effect lists, which now carry `fxDistort` (right behind the heat
    haze) and `fxGlow` (ahead of lens flare / bloom);
  - `tests/particles_over_clouds` accepts the optional tier-1 effect in each
    half and gains a section P8: both slots when on, and the exact pre-tier-1
    lists (split and single chain) when off;
  - `tests/additive_fog` compares against `particleFxProgramKey` (the session's
    smoke / CSM suffix);
  - `test_particles` stubs the new imports OFF, like its `particle_fx` stub;
  - `harness/test_build_shell` moves the preload count from 355 to 361 (six
    new boot modules).

  Two real bugs these runs caught, both fixed:
  - `fx_lights.js` built `THREE.Vector4` uniforms at module load, which broke
    the suites that run `play_effect_vfx.js` on the minimal three stub. The
    uniforms are flat typed arrays now.
  - A nested template literal in the terrain fragment source broke the
    terrain suites' "backtick-free GLSL" scan. The call site is a plain string
    now.

**Not eye-tested on a real GPU.** The laptop is SwiftShader. Everything below
is queued for the 1070.

## Queued 1070 look checks (owner-run, off-screen, muted, `?nosw=1`, `?quality=high`)

Run one A/B per page load, flipping one switch at a time (`?fxGlow=off`
etc.).

1. **Holtburg at night** (`@telepoi Holtburg`, sky time ~01:00):
   - braziers and lamps paint warm pools on the ground that fade with
     distance (`terrainLights`);
   - no white discs; by day the pools are faint;
   - embers rise off the braziers and drift;
   - heat shimmer above the flames, with the wall behind it bending, not the
     flame itself (with `?clouds=on`);
   - chimney smoke is darker on its shadow side, catches the light on the
     sun side, frays into wisps, and turns dark where it crosses a roof's
     shadow.
2. **The Holtburg portal:**
   - a violet pool of light on the ground and walls;
   - the world behind it twists slowly;
   - motes spiral into it;
   - a soft halo at high quality (`fxGlow`).
3. **Combat:**
   - cast a war spell at a creature at night: the launch flashes blue, the
     impact flashes orange and lights the ground and the creature, and a
     shockwave ring bends the scene;
   - buff yourself: a soft gold wash on you and the ground;
   - level up: a gold flash and a ring.
4. **Dungeon:** surface braziers above must not light the crypt; torches
   inside still do.
5. **Perf:**
   - Holtburg town fps with all six on vs `?fxGlow=off&fxDistort=off&fxKids=off`
     (baseline: ~33 fps / 938 draws on the 1070);
   - `__fxGlow.stats()` (`drawn` = extra draws);
   - `__fxLights.stats()`;
   - `__particlesOverClouds.stats()`.

**First tuning targets if something reads wrong:**

- `__fxLights.terrainGain`;
- `__fxGlow.intensity` / `.strength`;
- `__fxDistort.amplitude`;
- per-emitter terms in `tier1_overrides.json`.

## Known limits

- **Pool slots are shared.** FX lights compete with setup lamps for the 16
  pool slots, nearest first; flashes win within 48 m. In a torch-dense street
  a busy fight can take slots from distant torches for a moment, as
  projectile lights already do.
- **Children on the indoor layer.** Children follow their emitter's render
  layer (one mesh per layer). Per-mesh-path emitters (`?particleInstancing=off`)
  get no children.
- **Glow source.** Glow comes from the instanced additive buckets only: not
  alpha smoke, not the children, not the placeholder bursts (those already
  carry HDR gain into the scene bloom).
- **Distortion on the single chain** (no `?clouds=on`) also bends the flame
  sprites themselves, because particles draw in the world pass there.
- **Ground response is a calibration guess.** Terrain light gains and knee are
  derived from the retail light law and the terrain's light scale, not from an
  eye test. They are tunable live.

## Tier 2 — designed, not built

Each item fits the structures tier 1 put in place. None changes the light
count or adds per-instance program keys.

### 6. Motion: velocity-stretched sparks and droplets, ribbon trails

**Stretch.** The bucket shader has the per-slot previous position the
children already keep (`emitter._kidPrev`). Add it as a second instanced
attribute (`instancePrev`, vec3, written in `_appendInstances` next to the
matrix). In `VERT_BODY`, for rows with a new `stretch` term, rotate the quad's
long axis onto the screen-space velocity and lengthen it by `|v|·dt·k`. The
children's spark kind already does this in its own shader, so copy that basis
(det +1!).

**Profile rows.** `stretch` belongs to the star (hit sparks), specks, water
spray / streaks, blood (droplets) and debris families, through tier1.py.

**Ribbons.** One shared dynamic BufferGeometry holds every live ribbon,
drawn in one draw call with an additive noise-scrolled shader.

- **Driver:** the projectile entities (`entities.js` PROJ-VIS path).
- **Data:** a ring buffer of the last ~16 world positions per missile.
- **Shape:** camera-facing strips with width and alpha falling along the
  length.
- **Colour:** from the cue family (flame orange, frost cyan, acid green,
  lightning white-blue with jagged re-randomised offsets every ~50 ms).

**Elemental swing trails.** Sample the weapon tip during attack motions (the
weapon part's world matrix through the same rig accessors `partFrames` uses).

### 7. Analytic sprites for the magic families

`star`, `glow_point` and `glow_orb` are the buff-swirl workhorses: 744
emitters, mostly 32–64 px blobs.

- **Profile.** Add a `shape` term: 1 = analytic star, 2 = analytic orb.
- **Shader.** In `FRAG_MAP`, when `shape > 0`, compute the sprite in the
  shader instead of sampling the texture:
  - a crisp anti-aliased core (`fwidth` on the radius);
  - an exponential halo;
  - four- or six-point diffraction spikes that rotate slowly with the seed,
    with a slight chromatic split on the spikes.
- **Colour** comes from the texture's mean colour (`FX_ROW_EXTRA` already has
  a light colour; extend it to the sprite colour), so retail hue, size and
  timing stay.
- **Cost.** One program, no texture fetch. Sharp at any size.

### 8. Ground marks (scorch, frost, acid, blood)

**Draw.** One instanced draw of unit boxes (deferred-decal style) in the late
pass. Each fragment reconstructs the world position from the linear-depth
copy the late pass already makes (`particleFxBeforeLate` →
`FX_UNIFORMS.uFxSceneW`), transforms it into the decal's box, discards
outside, and blends a procedural mark (scorch = multiply darkening with a hot
fading rim; frost = additive blue-white crystals; acid = green wet sheen;
blood = dark red splash).

**Spawning.** From `fx_cues.js`: explode / collision → scorch,
breatheFrost → frost, breatheAcid → acid, splatter → blood, at the target's
feet (ground height from the terrain oracle or a downward depth probe).

**Lifetime.** Fade over 10–30 s, cap 32.

**Fog.** Late-pass draws are after the fog, so apply the terrain fog factor
by distance in the decal shader.

### 9. Ambient GPU fields

One InstancedMesh per field, wrapped around the camera:

- **Position:** `fract((seed + wind·t) / box) · box + camSnap`, one draw,
  zero CPU.
- **Fades:** soft-fade near the box faces and the camera.

**Fields:**

- fireflies at night near water and grass (warm blink, glow buffer);
- dust motes in dungeon light (only inside lit pool ranges: sample the
  terrain FX light uniforms or the pool positions);
- drifting leaves and pollen near trees (wind from `treeWindDir`);
- snow over snow terrain codes;
- ash and embers near volcanoes (the existing terrain VFX).

Gate them through the terrain-VFX tier system (`TERRAIN_VFX_PROMOTED` /
`TERRAIN_VFX_TIERS`) like grass.

### 10. Sub-pixel clamp

In `VERT_DEPTH`, measure the particle's projected size: the instance scale
times the quad radius over `gl_Position.w` and the viewport height. Below
~1.5 px, scale the quad up to 1.5 px and multiply its opacity by the area
ratio, so energy is conserved. Distant glints and 2–3 cm specks then shimmer
steadily instead of popping in and out. The same clamp belongs in the
children shader. Cost: a few ALU per vertex.

### Showcase compositions (each assembled from the pieces above)

- **Portal.** Swirl distortion and inflow motes are shipped, plus the light
  pool and glow. Add an analytic rim (7), a ground light ring decal (8) and a
  faint "portal-space" interior disc (a swirling nebula shader on a
  camera-facing disc at the setup's centre).
- **Lifestone.** Breathing light and glow are shipped. Add a vertical light
  shaft (an additive camera-facing column with a scrolling noise mask), rising
  glitter and a ground ring.
- **War-spell impact.** Flash light, shockwave and sparks are shipped. Add
  stretched sparks with depth bounce (6; a vertex-stage test against
  `uFxSceneW`) and a scorch (8).
- **Level-up.** Flash, ring and glitter are shipped. Add a column of light (as
  for the lifestone) and a short camera-side lens flare on the core (the
  takram LensFlareEffect is opt-in; a sprite flare on the glow buffer is the
  cheaper route).

## Files

- **New:**
  - `scene3d/vfx/fx_tier1.js` (switches);
  - `scene3d/vfx/fx_lights.js` (sources, flashes, terrain feed + GLSL);
  - `scene3d/vfx/fx_cues.js` (PlayEffect cue table);
  - `scene3d/vfx/fx_distort.js` (source registry);
  - `scene3d/vfx/fx_distort_effect.js`;
  - `scene3d/vfx/fx_glow_effect.js`;
  - `scene3d/particles/particle_fx_kids.js`;
  - `tools/particle-fx/tier1.py`;
  - `data/particle-fx-tier1.json`;
  - `test_particle_fx_tier1.mjs`;
  - `test_particle_fx_tier1_gpu.{html,cjs}`.
- **Edited:**
  - `scene3d/particles/particle_fx.js` (10-texel layout, `particleFxTier1`,
    smoke / CSM / glow variants, noise, calibration on every path);
  - `scene3d/particles/particle_fx_profiles.js` (regenerated);
  - `scripts/gen-particle-fx-profiles.mjs`;
  - `scene3d/particles/particle_manager.js` (`_bindTier1` / `_releaseTier1`,
    children in the bucket walk, glow provider);
  - `scene3d/particles_over_clouds.js` (`registerFxGlowProvider`);
  - `scene3d/terrain.js` (light loop + shared uniforms);
  - `scene3d/loop.js` (`tickFxLights`, `feedTerrainFxLights`);
  - `scene3d/play_effect_vfx.js` (`_fireTier1Cue`);
  - `scene3d/atmosphere_pipeline.js` (effects in both chains + handles);
  - `scene3d/quality.js` (presets + BOOL_FLAGS);
  - `harness/run-js-headless.mjs`;
  - `test_particle_fx.mjs`;
  - `docs/url-flags.md`;
  - `index.html` (modulepreload).
