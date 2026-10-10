# Handoff — every particle effect, individually upgraded (2026-10-09)

> **Follow-up (2026-10-10):** tier 1 — effects light the world (and the
> terrain), a particle glow buffer, GPU child particles, screen-space
> distortion, volumetric smoke shading — plus the tier-2 design:
> `docs/HANDOFF-particle-fx-tier1-2026-10-10.md`. It also fixes the display
> calibration below on the default boot (it only ran inside the late pass).

Owner goal: "upgrade all particle effects in holtburger-web in an individualized
way … the particle effect should be well understood … whatever is done will have
to appear well" — with no GPU box for eye tests. This doc is what shipped, how it
works, how it was verified without a GPU, and the look checks queued for the
next 1070 session.

## What "all particle effects" covers

| set | count | upgrade |
|---|---|---|
| Retail ParticleEmitters (0x32) in client_portal.dat — static default scripts (fires, smoke, fountains, portals, lifestones…), entity/item scripts, PlayEffect real VFX (spells, buffs, splatter, level-up…), projectiles | **2,051** (every one in the DAT) | own profile row each; note on what it is in game |
| Synthesized emitters (Visual-Behavior Suite + terrain VFX) | **14 kinds** | own hand-authored profile each |
| PlayEffect placeholder bursts (instant cue for every PlayEffect; only cue for targets without a PhysicsScriptTable) | **170 PlayScripts → 45 looks** | energy-form shader per shape, look per family |
| Sky chain (moon nebula sheets, storm box) | 15 emitters | deliberately untouched (takram sky stays as authored) |

## How each effect was understood

1. **DAT extraction** (`tools/particle-fx/datcat.py`): walks client_portal.dat,
   parses all 2,051 emitters, 4,248 PhysicsScripts (which emitters each creates,
   CallPES chains), 164 PhysicsScriptTables (PlayScript → script), 5,935 Setups
   (default scripts, placement hooks), and resolves each emitter's
   GfxObj → Surface → texture (257 distinct particle textures, decoded).
2. **Context** (`enrich.py`): PlayScript names, LSD weenie names for setups /
   tables / default scripts, CallPES parents — e.g. "PlayScript BreatheFlame on
   [Flaming Club]", "default script of setup 0x02000a7b [Eye of the Quiddity]".
3. **Looking at every texture**: 9 labelled contact sheets (additive on black,
   alpha over grey), every one of the 257 surfaces filed into one of 44 visual
   families by eye (`families.py`) — fire puff, flame tongue, dark/light/additive
   smoke, magic mist, star flares, glow orbs, faint halos, lightning, tendril
   bursts, vortex rings, swirl stripes, runes/sigils, snow, bubbles, blood,
   insects, leaves, solid sprites, misc pictures (faces, moons, signs)…
4. **Measurements** per emitter: sprite size in metres, lifespan, expected live
   count and crowding, retail start/final translucency, motion class
   (standing/plume/stream/trail/burst/implode/swarm/fountain/flash/puff/drift),
   texture radial symmetry + edge energy (spin safety), brightness, hue, UVs.
5. **Generator** (`gen_profiles.py`): family recipe × behaviour × measurements ×
   context → params, with a note.
6. **Review**: eight reviewers (one per family group) read every emitter's data,
   context and texture, wrote a specific note for every emitter (what it is in
   game, which part of which effect, what the upgrade does) and corrected params;
   a consistency critic then aligned effects whose parts span groups (a spell's
   core orb + sparkles + swirl column + smoke). See `tools/particle-fx/overrides/`.
7. **Safety net** (`build_catalog.py`): ranges clamped, spin only on full-UV
   4-vertex quads, no double fades where retail already fades, misc/none/sky
   neutral → `data/particle-fx-catalog.json` → `particle_fx_profiles.js`.

**Review statistics.** 8 family reviewers, all 2,051 emitters covered, each with
its own note; 1,699 tuned beyond the generator, 190 re-filed to a better family
(e.g. the Splatter "solid balls" are blood droplets, the SparkLow "lightning"
sprites are radial spark stars, the LevelUp smoke texture is pure-black motes).
The consistency critic then aligned 67 emitters whose parts span groups
(Lightning Bolt tiers, 29 war-bolt bodies' end fades, stacked wisp heads) and
caught `build_catalog.py` silently neutralising re-filed misc rows. A visual-QA
round (4 reviewers on the offline preview sheets, 50 findings) fixed 32 emitters,
13 placeholder looks, the pollen tint, and the three synthesized emitters below.

## The runtime (`?particleFx`, default ON)

`scene3d/particles/particle_fx.js`. Instanced buckets (the default draw path for
every visible particle) carry `(opacity, age, row + seed)` in the instance
colour; the vertex stage `texelFetch`es the emitter's 6-texel row from a float
DataTexture and folds everything constant per particle into four varyings; the
fragment stage does the per-pixel part. Terms:

| term | what it does on screen |
|---|---|
| `gain`, `core` | HDR lift; past luminance 1.1 the existing bloom gives the glow; `core` boosts only the brightest texels (white-hot centres, soft halos stay soft) |
| `tint0 → tint1`, `tintCurve`, `sat` | colour over life — fire cools white-gold → orange-red, smoke greys/lightens, magic deepens into its own hue |
| `fadeIn`, `fadeOut` | no pop-in/pop-out (retail kills a particle at its lifespan whatever its opacity: 759 of the 2,051 emitters end ≥10% opaque, 536 more than half; 1,462 are born ≥70% opaque) |
| `erode` | dissolve over life from the dim edges inward (wisping smoke/fire instead of fading cards) |
| `flicker`, `twinkle`, `pulse` | hearth flicker, electric crackle, star glints, firefly blink, aura/portal/lifestone breathing — per-particle phase |
| `spin` | texture roll over life with random direction/rate per particle (radial sprites only) — breaks the "same card" look, turns vortices, tumbles snow/leaves/debris |
| `wobble` | UV turbulence — licking flames, water shimmer |
| `soft` | soft particles: fades where a quad meets terrain/walls (late pass copies the log depth to linear depth first — `registerLateFxHooks`) |
| `nearFade` | no screen-filling quads when the camera is inside smoke / breath |
| `lit` | non-emissive matter (smoke, dust, water, leaves, insects, blood, snow) follows day → moonlit night → indoor light |

Cost: no extra draw calls, two programs (`hbParticleFxAdd1`, `hbParticleFxAlpha1`),
one full-screen R16F depth copy per frame in the late pass (skipped on the `low`
preset), a modest ALU increase per particle fragment.

Synthesized emitters reach their rows by synth id (0xF0E000xx) or an
`fxProfile` name (gem sparkle, brazier/volcano ember + smoke).

## Display calibration — the finding that changed the plan

The composer multiplies the whole HDR frame by `toneMappingExposure = 5` (the
takram calibration) before the Neutral curve. Lit surfaces are calibrated for
that; **unlit particles never were**. Measured through three r184's Neutral
curve (and then seen in the offline preview renders):

- **Alpha (normal-blended) sprites drew far too bright**: a 0.40 texel showed as
  0.81, 0.55 as 0.97. The "dark soot" smoke beside every flaming weapon and
  brazier rendered as **white puffs**; blood droplets went pink; dust tan-white.
  `?particleAlphaCal` (default on): colour × 1/exposure → retail LDR colours.
- **Additive sprites** are close to retail by day (retail added in gamma space)
  but saturated colours bleach toward white, and the per-emitter HDR gains made
  dense bursts **flood the frame with bloom** (a 16-sprite purple tendril burst
  tinted the whole view). `?particleAddCal` scales additive colour by K/exposure
  with **K following scene brightness: 4 by day, 2 at night and indoors** —
  retail's gamma-space addition was about stock-bright over a bright daytime
  background and about half that over a dark one. A single K = 2 (the first try)
  removed the floods but left emissive effects ~0.5× stock by day (visual QA).
- Erosion now thresholds **perceptual** energy (√linear) — the first version
  thresholded linear texels and ate small flame/smoke puffs to fragments.

## Synthesized emitters that drew black

`breathFog`, `terrain.sandDevils` and `terrain.marshGas` bubbles used the
`smokePuff` sprite (0x010016BE), whose DAT texture 0x08000326 is **pure black**
(rgb 0, alpha ≤ 0.62): the "frosty breath", "warm sand dust" and "sickly green
bubbles" all drew as dark smudges, with or without the upgrade (no tint can
recolour black). They now use `softGlowDot` (same 0.294 m quad, soft radial),
greyed and tinted by their profiles (frosty white / warm sand / yellow-green),
dimming at night.

## Offline preview (what the frames actually look like, no GPU box)

`tools/particle-fx/preview.{html,cjs}` renders real emitters (DAT texture +
motion through the real ParticleManager + FX shader) into an HDR buffer with the
late particle pass + soft-depth hook, then pmndrs Bloom (0.55 / 1.1 / mip blur)
and Neutral tone mapping at exposure 5 — the client's chain — over a calibrated
day / night backdrop. Stock vs upgraded use the same random seed. Heavy job:
`PFX_WORK=<work> capped-build node tools/particle-fx/preview.cjs <out> [--k=N]
[--only=family,…] [--skip=bursts,synth] [--addks=5,2.5,1.75]`. Limits: no takram
sky/fog, no world lighting on the backdrop, clip-map sprite transparency
approximated (the shockwave ring renders as a dark disc there, not in game),
one emitter per frame (no cross-effect overlap). Its fixed camera/timing also
misses some effects entirely: of the 185 sampled, 21 came out blank in both
stock and upgraded (sub-pixel three-vertex sprites such as blood/debris/leaf
motes, bursts that end between sim steps, fast launch trails leaving frame) —
a preview limit, not a runtime one; their textures and rows are fine.

Before/after gallery of the final renders (164 plates, 1280×960 per side, day +
night, blank plates left out): https://claude.ai/artifact/WVew1BL5AA2eU5dsGMxXWX
(private to the owner until shared). Built by the session-scratch
`make_gallery.py` from the preview manifest.

## Placeholder bursts (`?burstFx`, default ON)

`scene3d/play_effect_burst_fx.js`: sphere = energy shell (fresnel rim,
translucent heart), ring = luminous filament, cube = crystal edges; noise streaks
rising or sinking, HDR gain, flicker, end-of-life tint, fade curve. 45 looks;
all 170 gameplay PlayScripts map to one (`_burstLookFor` in play_effect_vfx.js).
One program per shape; looks are uniforms on the pooled materials.

## Verification (no GPU box)

- `node test_particle_fx.mjs` — 69 checks: catalog covers all 2,051 emitters + all
  synthesized kinds, every emitter has a note, generated module not stale,
  row lookup, shader anchors (real three r184 chunks), instance packing + seed
  respawn, manager integration (FX buckets, sky chain and `=off` stay stock),
  late-pass hooks, light targets, safe ranges, no spin on directional families.
- `node test_play_effect_burst_fx.mjs` — 17 checks incl. "every gameplay
  PlayScript maps to a family look".
- `capped-build node test_particle_fx_gpu.cjs` — headless Chromium (SwiftShader
  WebGL2, logarithmic depth like the client, 64×64 canvas, no world): both FX
  programs compile; **neutral row = stock shader to 1.5e-8**; every family's row
  draws finite pixels and changes the picture; exactly two FX programs; the depth
  copy decodes a wall at 10 m as w = 10.000; soft particles fade a quad 0.1 m from
  the wall to nothing and leave one 5 m away untouched; display calibration (alpha
  ×1/exposure = 0.2, additive ×K/exposure = 0.4 at K 2, both lifted by the live
  A/B); all 45 burst looks × 3 shapes compile, draw and are visible on 4 shared
  programs; no GL errors — 19/19 checks.
- Existing suites rerun green: test_particles (98), additive_fog (112, incl. new
  fog×FX composition checks), particles_over_clouds, single-pass, inst-alpha,
  shared-alpha, billboard, owner, rp6, gemSparkle, brazier, foliage,
  legacy-safety, play-effect resolver, terrain swamp/volcano/sand/lifecycle, …
- `node scripts/lint-url-flags.mjs`, `node scripts/gen-modulepreload.mjs --check`.

## A/B levers

- `?particleFx=off` — stock particle buckets (byte-identical to before).
- `window.__particleFx(false)` — live: every particle on the neutral row (no
  reload; compare a scene in one page load). `__particleFx()` = state + soft stats.
- `?burstFx=off` — flat placeholder bursts.
- `?particleAlphaCal=off` — alpha sprites at the old (over-bright) level.
- `?particleAddCal=off` / `=K` — additive calibration off / one fixed K (default: 4 by day → 2 at night / indoors).
- Edit one effect: `tools/particle-fx/overrides/*.json` → rerun the pipeline
  (README there), or edit `data/particle-fx-catalog.json` and run
  `node scripts/gen-particle-fx-profiles.mjs`.

## Queued look checks (next 1070 session — owner-run or owner-requested only)

Off-screen, muted, `?nosw=1`, one A/B per page load with `__particleFx(false/true)`.

1. Holtburg square, midday then night (`@telepoi Holtburg`): chimney smoke greys
   and dissolves, no hard line where puffs meet roofs; at night smoke darkens to
   moonlit blue-grey (not glowing grey); braziers/torches flicker and their
   flames cool to red at the tips; fountain mist soft against the basin.
   Expect: no blown-out white blobs; bloom halos only on flame cores.
2. Holtburg lifestone + town portal: lifestone glow breathes slowly; portal
   swirl turns and breathes; no square corners visible on any rotating sprite.
3. Cast a buff and a debuff (e.g. self-buff, then get debuffed by a monster):
   enchant column swirls deepen to their hue; sparkles glint; nothing pops in or
   out; Enchant/Regen/Skill Up vs Down read different (Down dimmer).
4. Melee a creature: splatter droplets tumble and darken; with no
   PhysicsScriptTable the placeholder is a soft red blood-mist shell, not a disc.
5. A projectile spell (flame/frost/lightning bolt): trail dissolves instead of
   popping; impact flash hits instantly (no fade-in on bursts).
6. Level-up / Create / Death placeholders: gold shimmering shell, inward-swirling
   materialize, hollow void implosion.
7. Dungeon (indoor light): smoke/dust dimmed to torchlight level; additive
   magic unchanged.
8. Perf: `__particlesOverClouds.stats()` drawMs and fps at Holtburg orbit,
   `__particleFx(false)` vs `true` in one page load — expect ≤ ~0.5 ms GPU.

## Files

- `scene3d/particles/particle_fx.js` (engine), `particle_fx_profiles.js` (generated)
- `data/particle-fx-catalog.json` (source of truth: family, behaviour, note, params)
- `scene3d/play_effect_burst_fx.js` (placeholder looks)
- edits: `particle_manager.js`, `particle_emitter_info.js` (`fxProfile`),
  `particles_over_clouds.js` (late-pass hooks), `atmosphere_pipeline.js` (hook
  calls), `play_effect_vfx.js` (looks), `vfx/particle_attach.js`,
  `vfx/components/{brazierEmbers,gemSparkle,terrainVolcanoEmbers}.js`
- tools: `tools/particle-fx/*`, `scripts/gen-particle-fx-profiles.mjs`
- tests: `test_particle_fx.mjs`, `test_play_effect_burst_fx.mjs`,
  `test_particle_fx_gpu.{html,cjs}`; `test_particles.mjs` (FX stub),
  `tests/additive_fog.test.mjs` (FX composition)
- docs: `docs/url-flags.md` rows `particleFx`, `burstFx`
