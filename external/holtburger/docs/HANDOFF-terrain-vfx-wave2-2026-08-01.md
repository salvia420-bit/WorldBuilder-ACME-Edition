# HANDOFF — terrain-VFX Wave 2 landed: SNOW/ICE + VOLCANO (2026-08-01)

Continuation of `HANDOFF-terrain-vfx-wave1-2026-07-31.md`. Two Opus agents ran
in parallel worktrees per plan §7 (2A SNOW/ICE, 2B VOLCANO); the orchestrator
merged 2A first and 2B on top per the wave-1 handoff's sequencing note. All new
flags are SHIP-OFF strict `=== "on"` opt-ins; DEFAULT-ON flag count is still 14
(test-asserted). **No live/browser/1070 testing was run** (owner instruction
2026-07-31) — all validation is node suites; the owner eye-test queue is §4.
Program tracker: `TRACK-terrain-vfx-2026-08-01.md`.

## 1. What landed

- `4ff7494d..23dea459` — **2A SNOW/ICE** (`scene3d/terrain_snow.js`; suites
  snow 186/0 + ice 85/0). Spindrift = slope-biased camera-scoped scatter-pool
  ribbon field (higher-frequency than sand, intensifies while snowing via the
  weather env; per-code density in `SNOWICE_VARIANTS` — ice sheds ~1/6 of
  powder). Sparkle = terrain fragment, glint.js maths with world-space hash,
  lobe exponent 420, no grazing gate, multiplied by cloud/CSM shadow. Prints =
  shared trail map read as POM-registered dent + darkening (mid = darkening
  only); needs `?terrainTrail=on&terrainTrailFade=300`. Ice material codes
  2/27 only: one `uIceGloss` drives Blinn lobe + env mip, outside the
  `uPbrEnabled` block (the water-sheen Gouraud trap). Also landed the two
  wave-1 scatter-pool rough edges (`opts.uniforms`, per-pool rand salt;
  scatter suite 103→117).
  **§8-risk-7 DECISION: NO second high-res trail RT** — the terrain shader is
  at 15/16 guaranteed samplers, `?terrainTrailRes/Radius` already reach the
  sharp-print regime (512/32 = 0.125 m/texel), and 300 s fade is
  pixel-identical to ∞ because the map extent scrolls a print off in ~24 s.
  Full rationale in the `terrain_snow.js` header; direct visual check is
  eye-test N6.
  Flags: `terrainSnow`, `terrainSnowSpindrift`, `terrainSnowSparkle`,
  `terrainSnowPrints`, `terrainIce` (separate master), `terrainIceRefraction`
  + numerics `terrainSnowSpindriftCount`/`terrainSnowRadius`/`terrainSnowSlope`
  (URL-only). Tiers per plan §3.4.
- `732cf73d..32371ae8` — **2B VOLCANO** (`scene3d/terrain_volcano.js`,
  `vfx/heat_haze_effect.js`, `vfx/components/terrainVolcanoEmbers.js`; suites
  volcano 147/0 + volcano-shader 103/0). Heat haze = pure-`mainUv` pmndrs
  Effect in the EXISTING EffectPass (first, before aerialPerspective; null when
  off so pass count is unchanged); masking = CPU-projected screen disc of the
  nearest resident volcanic LB, `uHeatRadius → 0` when none resident (evict AND
  park asserted); log depth decoded from the RAW depthBuffer texel because
  pmndrs `readDepth()` already log-decodes under three r184 (see §3 finding on
  HorizonDissolveEffect). Embers = brazierEmbers' own builders re-anchored,
  owner key `staticOwnerKeyForLb(lb) + ":volcano"` (the wave-1B rebake trap),
  ≤ tier count vents per LB on distinct FAM_VOLCANO vertices. Crack glow +
  obsidian (code 6 only) = one terrain-fragment block, one flag, breathing via
  a registered 0.07 Hz oscillator PUSHED per-frame by `loop.js` (terrain_batch
  clones uniforms — by-reference would freeze on the batched path).
  **Ash fall SKIPPED** (plan §8 risk 9): parameterising `SnowSystem` means a
  seeded-PRNG rewrite (10 `Math.random` sites) + weather-manager ownership
  refactor — deferred per owner; no flag, no preset key, rationale recorded in
  `vfx_flags.js` + `quality-presets.md`.
  Flags: `terrainVolcano`, `terrainHaze` (**the shared name** — a later sand
  arm composes `terrainSand && terrainHaze` without renaming), `terrainEmbers`,
  `terrainCrackGlow` + numerics `terrainVolcanoEmberCount`,
  `terrainHazeStrength`, `terrainVolcanoRadius`. Tiers per plan §3.6 minus ash.
- `77a23ac6` — the merge. Conflicts were both-sides-additive; terrain.js
  fragment seam resolved crack-glow-after-snow, the shared `fragColor` line
  byte-unchanged (every wave-2 term rides `iblSpec`).
  `test_terrain_volcano_shader`'s sandW↔volcW proximity threshold widened
  1200→2400 (snowW/iceW now sit between; same corner gather).

## 2. Verification state of the merged tree

20 suites, 0 failed: water 73 · sand 107 · sand-sparkle 62 · scatter 117 ·
grass-scatter 91 · grass-shader 58 · oracle 76 · families 49 · lifecycle 88 ·
trail_map 61 · vfx_flags 86 · texmerge 33 · legacy-safety 18 · lru-park-storm
36 · brazier 27 · glint 27 · **snow 186 · ice 85 · volcano 147 ·
volcano-shader 103**. `lint-url-flags` exit 0 (468 documented; the 8
undocumented readers are pre-existing). Pre-existing failures unchanged:
quality_preset 30/2 (`pom` pair), visual_z, rust `corner_ring`.
`test_terrain_water.mjs` was re-run after every terrain-fragment edit by both
agents and post-merge. **Nothing was GPU-compiled or rendered.**

## 3. Findings / gaps (not acted on — noted for the owner)

- **`HorizonDissolveEffect` likely double-decodes log depth** (it exp2-decodes
  the already-decoded `readDepth()` argument) — would put its dissolve band at
  a wildly wrong distance; plausibly why it is recorded as GPU-unvalidated.
- Bare-default residue from 2A: one null sampler binding + ~25 inert uniforms
  per terrain material (no draw/light/pixel change).
- Ember vents carry no `degradeDistanceMeters` (keeps the brazier spec
  byte-identical) → manager-default RP6 cull; revisit if vents vanish from
  ridgelines.
- Heat-haze v1 single-centre mask reads wrong where volcanic/non-volcanic LBs
  interleave (plan §8 risk 5, accepted).
- Prints/stomp are player-only (no cheap creature ground-pos accessor).
- Spindrift duplicates sand's ~15-line flat-quad builder (left; mid-wave
  cross-edit avoided).
- `lint-url-flags` "292 distinct JS readers" did not move across ±16 readers —
  its reader counter may dedupe oddly.

## 4. Queued owner-run 1070 eye-test batch

Carried forward from wave 1 §5: **W1 W2 G1 S1**. Wave 2 adds (all on :8767
with `&texBc7=on&terrainBc7=on&nosw=1`):
- **N1–N10 SNOW/ICE** — full list in the tracker/2A report: sparkle twinkle in
  motion + POM registration + mid degrade; spindrift slope clustering + weather
  response + vs-sand frequency read; prints scallop-vs-smear (THE no-second-RT
  adjudication; fallback `&terrainTrailRes=512&terrainTrailRadius=32`); ice
  hard/wet vs matte snow; refraction ghosting check; off-path boots.
  Untuned: `SNOW_SPARKLE_STRENGTH 1.35/DENSITY 42/SHARPNESS 420`,
  `ICE_GLOSS 0.88/SPEC 0.55/ENV 0.65`.
- **V1–V7 VOLCANO** — haze reads as rising heat, foreground/sky never warp
  (`__heatHaze` live-tune, record values); shimmer exactly zero off-region and
  returns; crack-glow ~14 s breathing, veins read as fissures, no POM slide,
  glow in shadow; embers stable per-LB, light count unchanged; obsidian glass
  vs matte 25/26; mid-tier coherence; bare-default + family-master-off boots.

## 5. Resume here (Wave 3, per plan §7)

- **3A SWAMP** (dep wave 0): firefly/pollen RE-ANCHOR (never a second system),
  marsh-gas emitters, shared `scene3d/ground_fog.js` (2A deliberately did not
  build it). Code 23 stays water; implement code 4, gate 23 behind
  `?strictWaterCodes`. Flags `terrainSwamp`, `terrainGroundFog`,
  `terrainMarshGas`.
- **3B DIRT/MUD** (dep 1A): footfall puffs, mud prints + wetness via
  trail_map + wetness.js, dry dust haze via terrain_scatter. Flags
  `terrainDirt`, `terrainFootfall`, `terrainMudPrints`. If 3B touches the
  terrain fragment shader (wetness darkening), same water-suite duty; expect a
  merge-seam with the wave-2 blocks and keep the `fragColor` line untouched
  (ride `iblSpec` / the established seams).
- No terrain-fragment overlap between 3A and 3B is expected per plan, so they
  can run truly parallel; merge order then doesn't matter (pick 3B first if
  both touch terrain.js after all).

## 6. Session housekeeping

Wave-2 worktrees under `.claude/worktrees/` (agent-a6144…, agent-a832…) are
merged and can be pruned along with the wave-1 four. Each carries an untracked
`node_modules` symlink into the main checkout (gitignored). serve.py :8765/:8767
and ACE assumed still up (untouched this session).
