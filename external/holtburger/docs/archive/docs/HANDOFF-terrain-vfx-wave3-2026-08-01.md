# HANDOFF — terrain-VFX Wave 3 landed: DIRT/MUD + SWAMP (2026-08-01)

Continuation of `HANDOFF-terrain-vfx-wave2-2026-08-01.md` (same session). Two
Opus agents in parallel worktrees per plan §7 (3A SWAMP, 3B DIRT/MUD); 3B
merged first (fast-forward — it held the only terrain-fragment work), 3A
resolved on top (both-sides-additive; 3A never touches `terrain.js`). All
flags SHIP-OFF strict `=== "on"`; DEFAULT-ON count still 14 (asserted). No
live/browser/1070 testing (owner instruction) — eye-test queue §4. Tracker:
`TRACK-terrain-vfx-2026-08-01.md`.

## 1. What landed

- `ee436e06..0be231e4` — **3B DIRT/MUD** (`scene3d/terrain_dirt.js`; suites
  dirt 242/0 + dirt-shader 134/0). Footfall dust puffs fired from the existing
  footstep-audio hook (`entities.js::_fireHook`, ~12 lines: fires before the
  SoundTable guards so muted sessions still puff; calls
  `scene3d.onTerrainFootfall` which only this family defines) — **any entity
  puffs, prints stay player-only**. Puffs are a fixed-capacity alpha-blended
  ring buffer, deliberately NOT the async particle manager and NOT additive
  (additive dust glows at night). Mud prints ride the SAME shared trail map
  and the SAME sampler as snow (`uSnowTrailMap` is a name, not a resource;
  still exactly 15 samplers, asserted); **rain-dependence rides stamp
  AMPLITUDE, not fade** — wet stamps are deeper/wider and the shader scales
  dent+darkening by wetness, so the global `?terrainTrailFade` (mud wants
  ~30 s; warns once in both directions) never needed a second constant or RT.
  Wet-mud gloss runs off a constant base roughness 0.86, NOT the nra B channel
  (dead under default-ON retail Gouraud — the water-sheen/ice precedent).
  Flags: `terrainDirt`, `terrainFootfall`, `terrainMudPrints`,
  `terrainMudWetness` (4th flag, ultra-only, the `terrainIceRefraction`-shape
  deviation), `terrainDustHaze` + numerics `terrainDirtDustCount`,
  `terrainDirtRadius`, URL-only `terrainDirtDustDensity`/`terrainFootfallPuffs`.
- `0076e4da..68a5ed4a` — **3A SWAMP** (`scene3d/terrain_swamp.js`,
  **shared `scene3d/ground_fog.js`**, `vfx/components/terrainSwampAmbient.js`;
  suites swamp 204/0 + ground_fog 65/0 + foliage 75→89). Fireflies + midges are
  RE-ANCHORS of `foliageFireflies`/`foliagePollen` (byte-parity of the emitter
  spec asserted modulo anchor/tint) with a 12 s re-gate loop so night onset
  works without re-streaming the LB. Marsh gas = landblock-scoped hash-stable
  vents (owner key `staticOwnerKeyForLb(lb) + ":swamp"`), rare ~140 s wisp
  ignition, no light. Ground fog = effect-agnostic camera-scoped card ring
  (rides `terrain_scatter.js`; count rounds up to a square, 24⇒25;
  cylindrical billboards reconcile "horizontal" with "faces camera");
  **the soft-particle depth read ships INERT** — GLSL complete
  (log-decode + NEAREST + sentinel per OPTICAL_EFFECTS_HANDOFF.md) but the
  scene depth texture is the composer's LIVE depth attachment during the world
  pass ⇒ feedback-loop risk, so it arms only via URL-only
  `?terrainGroundFogSoftness` + a manual console wire (eye-test P6 adjudicates
  the three outcomes). Code 23 (SeaSlime) joins FAM_SWAMP only under
  `?strictWaterCodes`, purely by derivation; no water mask touched.
  Flags: `terrainSwamp`, `terrainGroundFog` (SHARED name — snow/volcano
  compose it later), `terrainMarshGas`, `terrainMarshWisps`,
  `terrainSwampFireflies`, `terrainSwampMidges` + numerics
  `terrainGroundFogCount/Radius`, `terrainMarshGasCount`, URL-only
  `terrainGroundFogSoftness`.
- `68ded1a6` — the merge (3A over 3B; vfx_flags/quality/index/docs additive).

## 2. Verification state of the merged tree

25 suites, 0 failed: the wave-2 twenty (water 73 · sand 107 · sparkle 62 ·
scatter 117 · grass 91/58 · oracle 76 · families 49 · lifecycle 88 · trail 61
· vfx_flags 86 · texmerge 33 · legacy 18 · park-storm 36 · brazier 27 · glint
27 · snow 186 · ice 85 · volcano 147 · volcano-shader 103) + **foliage 89 ·
dirt 242 · dirt-shader 134 · swamp 204 · ground_fog 65**. `lint-url-flags`
exit 0 (487 documented; same 8 pre-existing undocumented readers).
Pre-existing failures unchanged (quality_preset 30/2 pom pair, visual_z, rust
corner_ring). Nothing GPU-compiled or rendered.

## 3. Findings / gaps

- 3B: creature mud tracks are a contained follow-up (footfall event already
  carries the position). Bare-default residue ~17 inert uniforms (zero new
  samplers/draws/lights; `fragColor` byte-identity asserted).
- 3A: fireflies/midges are one emitter per swamp LB (may read sparse);
  re-anchors inherit canopy degrade radii (150/90 m — maybe short for ground
  ambience); all sprite/colour/opacity choices untuned; wisp handle set is 4.
- The ~15-line flat-quad builder now exists in sand, snow AND dirt — a
  wave-5/cleanup candidate, deferred per owner's no-refactor rule.
- `lint-url-flags` "292 distinct JS readers" hasn't moved across +26 readers
  over two waves — its reader counter dedupes wrong; worth a look someday.

## 4. Queued owner-run 1070 eye-test batch

Carried: W1 W2 (water) · G1 (grass) · S1 (sand) · N1–N10 (snow/ice) · V1–V7
(volcano) — see wave-1/2 handoffs. Wave 3 adds:
- **D1–D9 DIRT/MUD** (3B report, full text): puffs at the foot on the footfall
  incl. the night additive-blend tell; puff colour per ground code + zero
  off-family; dry print heals ~30 s, no POM swim; rain print deeper/wider/
  darker (the amplitude-decision adjudication); wet-mud sheen agrees with
  puddled statics; clay redder/slicker with feathered seam; dust haze dies in
  rain; mid = puffs only + darkening-only prints; off boots.
- **P1–P10 SWAMP** (3A report, full text): ground fireflies green/low vs
  canopy, 12 s onset; no double-ecosystem fight; stable gas vents; wisp reads
  as glow with zero light delta, rare not metronomic; fog hugs hollows, no
  card shear; **P6 = the fog depth-read adjudication** (soften / feedback-loop
  error / no change ⇒ wire it / kill it / drop it); mid coherence; midges by
  day; nothing on water + `strictWaterCodes` flips code 23; off boots.

## 5. Resume here (Wave 4)

- **4A ROCK/BARREN** (plan §3.3, codes 0/13/14/30): pebble/rubble scatter,
  grit streamers, olthoi variant. Flags `terrainRock`, `terrainRockDensity`.
  Lowest visual delta, goes last. LAUNCHED this session — check the tracker.
- **4B promotion pass — OWNER-GATED**: the batched 1070 eye-test of everything
  above, per-tier perf capture, flip validated defaults ON, update every
  Default/Reader cell, verify `?terrainVfx=off` kills all, consider
  `visualBudget()` as first real cost governor. Also fix quality.js:8's
  app-relative reference to quality-presets.md (wave-1 note).

## 6. Session housekeeping

Wave-2 and wave-3 worktrees (agent-a6144…, a832…, a20b…, aab3…) merged — can
be pruned with the wave-1 four. serve.py/ACE untouched this session.

## 7. ADDENDUM (same session) — Wave 4A ROCK/BARREN landed

`354c619e..07649dbc` (ff merge) — `scene3d/terrain_rock.js`: pebble/cobble/
shale/shard scatter (ONE octahedron geometry, three hash-chosen proportion
profiles + tilt — not three pools, see the report's deviation 1), grit
streamers (sand maths at 1/5 density, copied not imported — the sand field
hardcodes FAM_SAND), olthoi variant (code 30: shards + breathing chitin glow,
no light). First LIT scatter field: sun/ambient from the cached sky state,
quantised to the retail 15 s tick so pebbles step WITH the ground.
`terrain.js` byte-untouched. Flags `terrainRock`/`terrainRockPebbles`/
`terrainRockGrit` + counts/radius/URL-only density; tiers §3.3 verbatim
(pebbles 0/3000/9000/18000). Suites: rock 237/0; full 26-suite battery 0
failed; lint 494 flags; DEFAULT-ON still 14. Rock footfall puffs deliberately
NOT built — they are a FAM_ROCK branch in dirt's ring buffer (wave-4B
follow-up). Eye-test queue R1–R9 in the 4A report + tracker.

**ALL SEVEN FAMILIES (grass, sand, snow/ice, volcano, swamp, dirt/mud, rock)
ARE NOW CODE-COMPLETE AND ON MASTER.** What remains is 4B — the owner-gated
promotion pass: the batched 1070 eye-test of the whole queue (W/G/S · N1–N10 ·
V1–V7 · P1–P10 · D1–D9 · R1–R9), tuning the untuned constants each report
lists, per-tier perf capture, then flipping validated defaults ON.
