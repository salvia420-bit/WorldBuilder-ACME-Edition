# Handoff — particle effects, tier 2 shipped (2026-10-10)

Owner, after tier 1 (`9b883bac`): "implement tier 2 to completion. no 1070 is
available so i will vistest later". This doc covers what shipped against the
tier-2 design in `HANDOFF-particle-fx-tier1-2026-10-10.md` (§ "Tier 2"), how
each piece works, where the build departs from the design and why, how it was
verified without a GPU, and the look checks queued for the 1070.

Read the tier-1 handoff first: the profile table, the display calibration, the
glow buffer, the light pool and the late particle pass are all built on here.

## The switches

Six quality-preset switches (`scene3d/vfx/fx_tier2.js`, mirrored into
`scene3d/quality.js` PRESETS + BOOL_FLAGS, so `?flag=on|off`, the saved Graphics
settings and the preset all work the usual way):

| switch | low | mid | high / ultra | what |
|---|---|---|---|---|
| `fxMotion` | off | **on** | **on** | velocity stretch, projectile ribbons, elemental swing trails, spark bounce |
| `fxShapes` | off | **on** | **on** | analytic star / orb / ring sprites |
| `fxDecals` | off | **on** | **on** | ground marks: scorch, frost, acid, the light rings |
| `fxClamp` | off | **on** | **on** | sub-pixel clamp |
| `fxShowcase` | off | **on** | **on** | portal / lifestone / level-up set pieces |
| `fxFields` | off | off | **on** | ambient GPU fields (terrain-VFX ladder) |

`fxFields` takes its per-tier value from the terrain-VFX ladder like grass:
`quality.js` `TERRAIN_VFX_PROMOTED.fields` (now **true**, under the owner's
"new behaviour ships on" policy and the "to completion" directive) ×
`TERRAIN_VFX_TIERS` (high / ultra). `?terrainVfx=off` and `?wireframe=1` also
kill it. Flip `TERRAIN_VFX_PROMOTED.fields` to `false` to ship it opt-in.

The laptop probes to `low`, so a bare boot there shows none of this. The
owner's look-pass URL (`quality=ultra&clouds=on`) has all six on.

`?fxMotion`, `?fxShapes` and `?fxClamp` compile into the FX bucket programs and
are latched once per session with the tier-1 smoke variant: keys gain `m`, `a`,
`p` (all on at mid+: `hbParticleFxAdd1scmap`). With all three off the keys are
the tier-1 keys exactly.

## Per-emitter data: rows grow from 10 to 12 texels

`tools/particle-fx/tier2.py` → `data/particle-fx-tier2.json`, merged by
`scripts/gen-particle-fx-profiles.mjs`:

```
… tier 1 (40 floats) | stretch, shape, spikes, bounce | sprite.rgb, halo
```

- **stretch** (315 emitters): hit sparks (stars thrown by bursts / flashes /
  fountains / streams / trails), specks, blood droplets, debris, solid shards
  and balls, water spray and streaks. Standing / swarming emitters carry none,
  so buff swirls stay round.
- **shape** (738): 296 stars, 426 orbs, 16 rings. The `star`, `glow_orb` and
  `glow_point` buff-swirl workhorses, plus the portal rim layers (`vortex` +
  "portal rim layer" / "rim swirl" in the catalog note). Additive full-UV
  4-vertex quads only. A star that is thrown (stretch > 0) becomes an orb: a
  streaking cross smears, a streaking dot reads as a spark.
- **spikes**: 6 on cool or white stars (hue 170–280° or chroma < 0.1), 4 on
  the warm ones.
- **sprite + halo — energy-matched.** The analytic sprite's colour is the
  retail texture's mean LINEAR rgb·a over the quad (from the decoded DAT
  thumbnail) divided by the analytic profile's mean. Hue, total light, size
  and timing stay retail; only the shape gets crisp. `halo` comes from the
  texture's measured cover (a tight star gets a tight halo). The profiles in
  `tier2.py` mirror `particle_fx.js` `hbFxAnalytic`; the node test checks the
  constants agree.
- **bounce** (85): restitution 0.35 on every row whose GPU children are sparks.

Regenerate: `PFX_WORK=<work> python3 tier2.py && node scripts/gen-particle-fx-profiles.mjs`
(the work dir is the one tier 1 used; `tools/particle-fx/README.md`). A copy of
that work dir (emitters_ctx.json, surface_features.json, thumbs/ …) now lives
on the scratch drive: `PFX_WORK=/mnt/wbterminal2/particle-fx-work` — with it
`tier1.py` reproduces the committed tier-1 data byte-for-byte.
Per-DID corrections: `tools/particle-fx/tier2_overrides.json`.

## 6. Motion — `?fxMotion`

### Velocity stretch (`HB_FX_MOTION`, `scene3d/particles/particle_fx.js`)

- **Where the velocity rides.** `particle_manager.js::_appendInstances` writes
  each stretch row's particle velocity into the instance matrix's unused
  bottom row (elements 3, 7, 11). The velocity comes from the slot's position
  history (`particleFxSlotVelocity`): `_scene`-local m/s, lightly smoothed.
  A respawn (new seed) restarts it at rest. A jump over 60 m/s is a teleport,
  not a velocity. A second call in the same tick reuses the last value. Rows
  without stretch keep the row zero.
- **Stripping.** The vertex prologue copies the matrix, reads the row, zeroes
  it and `#define instanceMatrix hbFxIm`, so every later chunk
  (`project_vertex`, `worldpos_vertex`, the depth stage) multiplies by an
  affine matrix again.
- **The stretch.** In the depth stage, the vertex's offset from the particle
  centre (view space) is scaled along the screen-plane velocity:
  `L = |v| × uFxStretchT (0.04 s) × stretch` (capped at 14 radii). The head
  stays at the particle and the tail extends behind it. Opacity is divided by
  `mix(1, s, 0.5)`, so light is roughly conserved (GPU-checked at ×1.3).
- **The glow twin.** It shares the matrices, so the glow material carries the
  same variant.

**Why not a second instanced attribute (`instancePrev`)?** The design asked for
one. But a bucket's geometry is the shared `_instGeomCache` clone per gfxobj, so
a per-bucket attribute would need per-bucket geometries. Disposing one of those
deletes the GPU buffers of the attributes it shares, and the attribute would
have to be carried by hand through bucket growth, the back-to-front sort, the
shared alpha buckets and the glow twin. The matrix row needs no new buffer and
rides all of those for free.

**Why velocity, not the previous position?** The streak length then does not
depend on the frame rate.

**Why scale along the velocity, not rotate the quad?** Scaling the offset
along the screen velocity is continuous with det > 0, so no winding flip and no
lost quads (the kids' det −1 bug). A radial sprite reads the same as the
rotated version, and an oriented retail quad keeps its retail orientation.

### Ribbons (`scene3d/vfx/fx_ribbons.js`)

- **Draw.** One shared dynamic geometry: 32 ribbons × 16 points × 2 vertices.
  One draw call, additive, a noise-scrolled program (energy flows back down
  the strip), on the entities' layer 1, drawn in the late particle pass.
- **Bolts.** Every ballistic projectile (`_isProjectile`, `_ballistic`) leaves
  a camera-facing strip through its last ~0.22 s of world positions. Width and
  alpha fall along the length. On impact, NoDraw or despawn it stops growing
  and fades over 0.25 s.
- **Element** (`fxEntityElement`):
  - First the projectile's name (`objectName`): fire, frost, acid, lightning,
    nether, force, blade, or missile (arrows / quarrels: a faint white streak).
    An element word beats a missile word, so "Fire Arrow" burns.
  - Else the colour of its own Setup LightInfo light (PROJ-VIS attaches it).
  - Colours: flame orange, frost cyan, acid green, lightning white-blue.
    Lightning jags: each point re-randomises its sideways offset every ~50 ms.
- **Swing trails.**
  - `entities.js setMotion` notes a melee ATTACK command (`fxNoteSwing`): not
    the missile shots or the jump pair.
  - For 0.9 s each held weapon of that wielder whose name carries an element
    (fire / frost / acid / lightning / nether, shields excluded) sweeps a strip
    from mid-blade to tip over the last ~0.16 s.
  - The blade is the weapon rig's own mesh bounds in its root space: the long
    axis, the tip at the end farthest from the grip.
- **Ticked** from `loop.js` right after the particle-manager phase.
- **Departure from the design:** the colour comes from the projectile's element
  rather than "the cue family" (a bolt in flight has no cue). The tip comes from
  the held weapon's own rig (a separate entity mounted at the hand), not
  `partFrames`.

### Spark bounce (`HB_FX_BOUNCE`, `scene3d/particles/particle_fx_kids.js`)

- **Scope.** A spark child of a row with `bounce`, in the late particle pass
  (where `particleFxBeforeLate` has made the linear depth copy `uFxSceneW`).
- **How.** It marches its arc in 4 steps, bisects (5 steps) where it first
  passes behind the scene surface, and bounces off a level floor with that
  restitution, then rests on it.
- **Contact only.** It bounces only on CONTACT: at the crossing the surface
  must lie within 0.6 m of the spark. Passing behind a creature in front of it
  is no floor.
- **When it shows.** It matters for ground-level impacts, where the sparks
  used to sink straight in. Sparks born at chest height rarely reach the
  ground within their life.

## 7. Analytic sprites — `?fxShapes` (`HB_FX_SHAPES`)

In the map stage, a row with a `shape` computes its sprite instead of sampling
the texture. The condition is constant per particle, and there is no texture
fetch on those rows.

- **star:** a crisp anti-aliased core (`fwidth` on the radius), an exponential
  halo, and 4 or 6 diffraction spikes. The spikes turn slowly with the seed
  and the spin direction, with a slight chromatic split (widths × 1.08 / 1 /
  0.9 in r / g / b).
- **orb:** a crisp core in a gaussian halo.
- **ring** (the portal rim, "analytic rim (7)" in the design): a crisp
  glowing ring at 0.74 of the quad with swirling arms and a faint inner fill.
  The retail roll rotates it, and the retail contraction (4.3 → 1.45 m) shrinks
  it onto the portal's edge.

Spin, wobble, erosion, edge-soften, the core boost, the tint ramp, fades and
calibration all still apply. Additive output is `sprite × I` at alpha 1. The
glow variant uses the same shape.

## 8. Ground marks — `?fxDecals`

### Registry (`scene3d/vfx/fx_decals.js`)

- **Kinds:**
  - scorch: 22 s, a hot rim and cooling embers;
  - frost: 14 s, a whitening rime, six-fold crystal spokes, glints;
  - acid: 16 s, a green stain, bubbling sheen;
  - ring: persistent, an emissive light ring for the showcase.
- **Caps.** Transient marks fade in over 120 ms and out over their last 40 %.
  At most 32 are drawn, nearest first; the oldest transient is evicted first.
  Persistent rings are capped separately (8), so a fight never evicts a
  portal's ring.

### Effect (`scene3d/vfx/fx_decal_effect.js`)

- **Draw.** Each mark is a world-space box. The effect draws the boxes' back
  faces: one instanced draw per pass, two passes, into two frame-size targets.
  - MUL (multiply-blended): the surface's tint. A multiply keeps the surface's
    own lighting, so a scorch at night is a darker night ground, not a black
    disc.
  - ADD (additive): what the mark emits.
- **Per fragment:** reconstruct the world position from the composer's scene
  depth (sampled, never attached; projection terms passed as a uniform). Keep
  up-facing points (from the depth derivatives) inside the box. Paint the
  procedural mark, faded by the scene fog.
- **Composite:** `scene × MUL + ADD`.
- **Placement.** In the atmosphere EffectPass after the AO composite and
  before the clouds / aerial perspective (its DEPTH attribute keeps that slot
  through pmndrs' attribute sort). It runs on BOTH chains.

### What marks what

`vfx/fx_cues.js` gives a cue a `decal`; `play_effect_vfx.js::_tier2CueOpts`
places it.

- **Placement:**
  - on the session's terrain height under the target when that is within 3 m
    of its root;
  - else at the root (a creature's feet);
  - else 1 m under a projectile's impact point;
  - the breaths 3 m ahead of the breather.
- **Kinds:**
  - explosions scorch with an orange rim;
  - an impact takes its projectile's element (`fxProjectileElement`): flame
    scorches, frost rimes, acid stains, lightning and nether scorch with their
    own rim colour, force leaves nothing;
  - flame / frost / acid / lightning breath mark ahead;
  - the three smites scorch big.
- **Blood** stays with `?blood` (`blood_decals.js` already stamps every
  splatter).

### Departure from the design

The design put the boxes in the late particle pass and read `uFxSceneW`. That
pass only exists with `?clouds=on`, so the default chain would have had no
marks. The effect decodes the composer's depth itself instead and works on
both chains.

On the single chain, particles drawn over a fresh scorch would be darkened by
it, so the char grows in over 0.8 s while the burst clears. On the split chain
the particles draw after the marks.

## 9. Ambient GPU fields — `?fxFields` (`scene3d/vfx/fx_fields.js`)

A `scope: "camera"` terrain-VFX provider (registered from `index.js` beside the
grass).

- **Draw.** Seven fields, each ONE instanced draw and all on ONE program (the
  kind is a uniform).
- **Placement** is entirely in the vertex stage: `fract((seed + wind·t) / box)
  · box`, re-centred on the switcher's active camera. Instances fade at the
  box faces and next to the camera. Ground-hugging fields ride the terrain
  through a 9 × 9 height grid from the oracle.
- **Clamp.** The fields get the same 1.5 px sub-pixel clamp as the particles.

| field | where / when | look |
|---|---|---|
| fireflies | night, outdoors, over grass / marsh / shore | warm blink; also a glow extra (`?fxGlow`) |
| dust | indoors | slow motes lit ONLY inside the pool lights' reach (the terrain FX light feed) |
| pollen | day, over grass | sunlit specks on the wind |
| leaves | forest floor / moss codes (21, 28, 29), a few over grass | tumbling, falling, turning edge-on |
| snow | snow / ice codes | a light flurry |
| ash | volcanic codes | grey flakes drifting down |
| embers | volcanic codes | rising, flickering (+ glow extra) |

- **Coverage.** From the terrain codes of the 9 × 9 grid, re-sampled every
  0.5 s or 2 m.
- **Wind.** From `?treeWindDir` / `?treeWindStrength`, the trees' and the
  grass's.
- **Density** eases in over ~1.5 s. Instances past the density collapse, and a
  field at zero is not drawn.

**Glow extras** (`particles_over_clouds.js::registerFxGlowExtras`). These are
new: non-bucket objects (fireflies, embers, the level-up flare) are drawn into
the tier-1 glow buffer with their own depth-occluded variant.

**Departures from the design.** "Near trees" is the forest-floor / moss terrain
codes: there is no cheap tree index. The dust needs `terrainLights` (mid+),
because that is the feed it reads.

## 10. Sub-pixel clamp — `?fxClamp` (`HB_FX_CLAMP`)

- **Rule.** In the depth stage: projected radius = the vertex's distance from
  the particle centre × P[1][1] / w × height / 2, in the drawing buffer's (or
  the late target's) pixels. Below `uFxMinPx` (1.5 px radius) the quad is
  scaled up to it and its opacity cut by the area ratio, so the light is
  conserved.
- **Measured** (SwiftShader): a 0.1 px particle swept across a pixel keeps its
  energy within ±15 % with the clamp; the stock path draws nothing.
- **Also in** the GPU children and the ambient fields.

## Showcase set pieces — `?fxShowcase` (`scene3d/vfx/fx_showcase.js`)

One instanced billboard draws every disc, shaft, column and flare: one draw,
one program, plus the flare's glow variant. A 2 Hz scan finds the pieces:

- **Portal** (ObjectDescriptionFlags 0x40000 within 60 m):
  - Already shipped: the swirl distortion, the inflow motes, the light, the
    glow.
  - Tier 2: the analytic rim (the ring shape above); a ground light ring
    (`fxDecals`) in the portal's colour; and a faint portal-space disc. The
    disc is a slowly swirling nebula with twinkling stars, camera-facing, at
    the swirl's centre.
  - The centre and radius come from the portal's swirl distortion source
    (`fx_distort.js::fxDistortSwirlNear`), the colour from the swirl's FX
    light. Without them: 1.6 m up, 1.5 m radius, violet.
- **Lifestone** (0x4000): a vertical light shaft. It turns round the vertical
  to face the camera, its noise mask scrolls up and glitter rises in it. Plus
  a ground ring, in the lifestone's FX light colour (default pale blue).
- **Level-up** (the cue): a gold light column that rises (its top grows in
  over 0.45 s), holds and fades over ~3 s, plus a short lens flare on the core
  (hot core, anamorphic streak, ghost ring). The flare goes into the glow
  buffer when a glow pass is actually running (`?fxGlow` and `window.__fxGlow`);
  otherwise it draws in the scene.
- **War-spell impact:** the parts above. Stretched sparks, the spark children
  bouncing off the ground, the element's mark.

## Verification (no GPU box)

- **`node test_particle_fx_tier2.mjs`** — 84 checks, registered in the JS gate:
  - switches, presets, ladder and URL;
  - the data (stretch / shape / spikes / bounce coverage, ranges, sky stays
    zero, the analytic constants match the shader);
  - shader anchors (the prologue strips before `project_vertex`, clamp before
    stretch before the view depth, the analytic branch, keys `m`/`a`/`p`, the
    glow twin);
  - the manager writing velocity only on stretch rows and only with the
    variant;
  - the velocity helper;
  - the children's defines and bisection;
  - ribbons: elements, growth, impact fade, swing trails elemental only,
    `=off`;
  - marks: spawn, fade, cap, persistent rings, the effect's blend state, the
    cues' marks;
  - fields: densities, coverage, provider, late source, glow extra;
  - showcase: portal / lifestone / level-up, glow-pass detection, `=off`;
  - the wiring in pipeline, loop, index, entities and play-effect.
- **`capped-build node test_particle_fx_tier2_gpu.cjs`** — headless SwiftShader
  WebGL2, log depth, 30/30:
  - a neutral row WITH a velocity draws the stock pixels (stripping works);
  - a stretch row at rest equals tier 1;
  - a fast one stretches toward its tail with its head fixed and its light
    ×1.3;
  - a shape-less row equals the texture path exactly;
  - star / orb / ring rows draw finite, different pixels; the orb is
    symmetric; the ring's band outshines its centre ×24;
  - the clamp gives a steady energy where stock pops;
  - the glow twin draws through the tier-2 program;
  - with a floor's depth copy the sparks bounce (6/6 frames differ, sparks sit
    higher);
  - a scorch darkens the floor under it and nothing outside its box; a ring
    adds its colour;
  - ribbons, fields (+ glow) and showcase (+ flare glow) draw;
  - end to end in a composer, the glow pass draws the level-up flare as a
    glow extra (the scene copy stands down);
  - no GL errors.
- **Bugs the GPU smoke caught, all fixed:**
  - the decal fragment used `projectionMatrix`, which three declares only in
    the vertex stage (no mark ever compiled);
  - fields at real distances were sub-pixel (they now clamp);
  - the bounce's contact window rejected every spark that had already sunk
    deep, so none bounced (it now marches the arc for the crossing).
- **Existing suites whose pins moved with this change** (each keeps its
  intent):
  - `test_particle_fx` 69/69 (12 texels, 11 texel fetches);
  - `test_particle_fx_tier1` 66/66 and both earlier GPU pages 19/19 + 15/15
    (they latch tier 2 OFF to keep testing their own contract);
  - `tests/particles_over_clouds` 82/82 (accepts the decal slot, + P9 for it);
  - `tests/look_pass`, `tests/clouds_main_pass`, `test_terrain_volcano` (the
    effect lists carry `fxDecals`);
  - `test_terrain_vfx_promotion` (36 → 40 `terrainMaster(` calls: the
    `fxFields` key);
  - `harness/test_build_shell` (preloads 361 → 367: six new boot modules).
- `node scripts/gen-modulepreload.mjs --check` (383 modules) and
  `node ../../scripts/lint-url-flags.mjs` (6 new rows) pass.

**Not eye-tested on a real GPU.** Everything below is queued for the 1070.

## Queued 1070 look checks (owner-run, off-screen, muted, `?nosw=1&quality=ultra&clouds=on`)

Run one A/B per page load with `?fxMotion=off`, `?fxShapes=off`, etc.

1. **Combat:**
   - fire, frost, acid and lightning bolts leave their coloured ribbons, and
     lightning jags;
   - impact sparks streak, skitter and settle on the ground instead of
     sinking;
   - the impact leaves a scorch, rime or stain that fades over 15–20 s;
   - at night a fresh scorch's rim glows for a second or two;
   - a flaming or frost weapon swing draws an elemental arc; a plain one draws
     nothing.
2. **Buffs:**
   - sparkles and orbs are crisp up close and steady far away;
   - stars glint with slowly turning spikes (6-point cool, 4-point warm);
   - nothing whiter or brighter than before (the colours are energy-matched).
3. **Holtburg portal:**
   - the rim reads as crisp swirling rings contracting onto the edge;
   - a ring of its own colour lies on the ground;
   - a faint nebula with a few stars shows inside, at the swirl's centre and
     size.
4. **Lifestone:** a pale blue column of light with glitter rising in it, and a
   ring on the ground.
5. **Level-up:** a gold column rises out of the player and a short flare
   flashes on the core.
6. **Distant glints:** steady at distance, no popping (`?fxClamp=off` to
   compare).
7. **Ambient:**
   - night grassland: fireflies (with a halo at ultra);
   - a dungeon: dust motes only in the torchlight;
   - forest floor: falling leaves;
   - a volcano: ash and rising embers;
   - snow: a flurry.
8. **Perf:**
   - Holtburg town fps with all six on vs all six off (tier-1 baseline ~33 fps
     / 938 draws on the 1070);
   - `__fxRibbons.stats()`, `__fxDecals.stats()`, `__fxFields.stats()`,
     `__fxShowcase.stats()`.

**Tuning handles if something reads wrong** (live, no reload):

- `__fxTier2.stretchT` (0.04 s) and `__fxTier2.minPx` (1.5);
- `__fxRibbons.gain`;
- `__fxDecals.addGain`;
- `__fxFields.gain`;
- `__fxShowcase.gain`;
- per-emitter terms in `tools/particle-fx/tier2_overrides.json`.

## Known limits

- **Velocity is `_scene`-local.** A stretch row riding a moving creature
  stretches with the creature's motion. Only sparks, droplets and debris carry
  stretch, so buff swarms are not affected.
- **Centred quads assumed.** The stretch and the clamp take a vertex's
  distance from the particle origin as the quad's half-size. An off-centre
  retail quad would skew slightly when clamped or stretched.
- **Alpha-tested matter.** A clamped speck whose area ratio pushes it under
  the alpha buckets' 0.1 alpha test drops out. It does so at a steady
  distance, not by flickering.
- **Spark bounce** works only in the late pass (`?clouds=on` split chain), off
  a level floor.
- **Marks** go on up-facing surfaces only. Derivative normals can misjudge a
  depth silhouette pixel.
- **Swing trails** read the weapon's name. An elemental weapon whose name
  carries no element word trails nothing.
- **Fields.** Leaves follow terrain codes, not actual trees. The snow flurry
  ignores the weather.
- **Showcase** keys off ObjectDescriptionFlags. A static, non-weenie portal
  decoration gets only the analytic rim.
- **The lens flare** is a sprite on the core, not a screen-space ghost chain.

## Files

- **New:**
  - `scene3d/vfx/fx_tier2.js` (switches);
  - `scene3d/vfx/fx_ribbons.js`;
  - `scene3d/vfx/fx_decals.js`;
  - `scene3d/vfx/fx_decal_effect.js`;
  - `scene3d/vfx/fx_fields.js`;
  - `scene3d/vfx/fx_showcase.js`;
  - `tools/particle-fx/tier2.py`;
  - `data/particle-fx-tier2.json`;
  - `test_particle_fx_tier2.mjs`;
  - `test_particle_fx_tier2_gpu.{html,cjs}`;
  - this doc.
- **Edited:**
  - `scene3d/particles/particle_fx.js` (12-texel layout, `particleFxTier2`,
    the m / a / p variants, stretch + clamp + analytic GLSL, slot velocity,
    `__fxTier2`);
  - `scene3d/particles/particle_fx_profiles.js` (regenerated);
  - `scripts/gen-particle-fx-profiles.mjs`;
  - `scene3d/particles/particle_manager.js` (velocity into the matrix row);
  - `scene3d/particles/particle_fx_kids.js` (bounce + clamp);
  - `scene3d/vfx/fx_cues.js` (marks);
  - `scene3d/vfx/fx_glow_effect.js` (glow extras);
  - `scene3d/vfx/fx_lights.js` (`fxEmitterLightNear`);
  - `scene3d/vfx/fx_distort.js` (`fxDistortSwirlNear`);
  - `scene3d/particles_over_clouds.js` (`registerFxGlowExtras`);
  - `scene3d/atmosphere_pipeline.js` (the decal effect on both chains);
  - `scene3d/loop.js` (ribbon + showcase ticks);
  - `scene3d/play_effect_vfx.js` (mark placement, showcase cue);
  - `scene3d/entities.js` (swing note);
  - `scene3d/index.js` (fields init);
  - `scene3d/quality.js` (presets, BOOL_FLAGS, `TERRAIN_VFX_PROMOTED.fields`);
  - `index.html` (modulepreload);
  - `harness/run-js-headless.mjs`;
  - `harness/test_build_shell.mjs`;
  - `docs/url-flags.md`;
  - `../../docs/quality-presets.md`;
  - `tools/particle-fx/README.md`;
  - the pinned tests listed above.
