# HANDOFF — terrain-VFX Wave 1 landed: GRASS + SAND (+ scatter pool) (2026-07-31)

Continuation of `HANDOFF-terrain-vfx-wave0-2026-07-31.md`. Three Opus agents ran
per plan §7: a sequential pre-agent landed the shared scatter pool, then 1A GRASS
and 1B SAND ran in parallel worktrees and were merged. Everything is on
`origin/master`. All new effect flags are SHIP-OFF strict `=== "on"` opt-ins;
bare-default boot is byte-identical (verified live — no globals, zero errors,
DEFAULT-ON flag count still 14).

**Owner instruction (2026-07-31, end of session): STOP agent-driven interactive
eye-testing** — the laptop cannot carry live client sessions ("too heavy for
dell") and the remote-driven screenshot loop is not a wanted workflow. Look
validation moves to an owner-run batched 1070 session; the queued checklist is
§5. Functional validation stays in the node suites.

## 1. What landed (all pushed to origin/master)

- `ae44388b` — `scene3d/terrain_scatter.js` + `test_terrain_scatter.mjs` (103/0).
  Effect-agnostic instanced scatter pool. NOT a naive ring buffer: a
  world-anchored fixed-slot torus grid (`wrapSlotToCell`), so placement is
  hash-stable per world cell — teleport away/back reproduces the field
  byte-for-byte. `count` rounds UP to a perfect square (`pool.count` is
  authoritative). `oracle` accepts an object OR getter fn (use getter form with
  the spine's live `ctx.oracle`). Pool writes `aOffset`/`aNormal`/`aScale` +
  instance matrix; consumer owns geometry/material/other attributes via
  `fill(ctx)`. `SCATTER_FADE_GLSL` provides `hbScatterFade(vec2)`; pool installs
  nothing into any shader. Full API doc in the module header.
- `c2d05290..484b2d92` (4 commits) — **1A GRASS** (`scene3d/terrain_grass.js`,
  834 L; tests grass-scatter 91/0 real-three + grass-shader 58/0 pure-ESM).
  Camera-scoped blade field (5-vertex / 3-tri blades), wind = `windSwayGpu`
  gust fn verbatim (trees+grass gust together), stomp via wave-0 `trail_map.js`.
  Key decisions: family selection is a **hash-dithered draw over the four cell
  corner codes with the shader's own bilinear weights** (feathers boundaries —
  plan §8 risk 2), NOT a hard pool-level family gate; own `uTime` written from
  `frameCtx.tSec` (phase-locked to `tickVfxOscillators`, no materials.js import
  so the shader test stays pure-ESM); stomp needs `?terrainTrail=on` AND
  `?terrainGrassStomp=on` (absent map ⇒ `uTrailEnabled=0`, no lazy-ensure);
  only the player stamps (no cheap creature ground-pos accessor today);
  `?terrainGrass=on` at a zero-blade tier warns once and registers nothing.
  Flags: `terrainGrass`, `terrainGrassStomp`, `terrainGrassBlades` (INT),
  `terrainGrassRadius` (FLOAT), `terrainGrassDensity` (URL-only, no preset key).
  Tiers: low null · mid 24336/32 m/no-stomp · high 60025/48/stomp ·
  ultra 119716/64/stomp.
- `8b614029..08bd05ba` (5 commits) — **1B SAND** (`scene3d/terrain_sand.js` +
  `scene3d/vfx/components/terrainDustDevil.js`; tests sand 107/0 +
  sand-sparkle 62/0). Streamers = camera-scoped scatter-pool quad field (2025
  slots at high), additive, advected on the shared wind. Devils =
  landblock-scoped, ≤ tier count per sand LB, hash-stable per lbKey, owner key
  `staticOwnerKeyForLb(lb) + ":sand"` — deliberately NOT the bare static key,
  because the spine delivers a terrain LOD **rebake as gone-then-ready** and
  `destroyAllForOwner("static:N")` there would permanently reap the LB's
  brazier/foliage emitters. Sparkle = terrain fragment term gated on FAM_SAND
  reading `uVertexTypes` (trap T3 honoured: **no new geometry attribute**, the
  `terrain_batch.js` whitelist is untouched and its anchors are test-asserted);
  placed after the POM `cellUv` offset, honouring `cellTouchesWater`.
  `test_terrain_water.mjs` 73/0 re-run after every shader edit. Heat shimmer
  deliberately not implemented (wave 2B owns `terrainHaze`). Flags:
  `terrainSand` (family master), `terrainSandStreamers`, `terrainSandDevils`,
  `terrainSandSparkle` + numerics `terrainSandStreamerCount`,
  `terrainSandDevilCount`, `terrainSandRadius`. Tiers: low null ·
  mid 800/0/sparkle · high 2000/1/sparkle · ultra 3000/2/sparkle.
- `ded6beb6` — merge of 1B over 1A (conflicts in `vfx_flags.js` + `index.js`
  were both-sides-additive; resolved keep-both). `e700767c` — sand rows +
  glossary in `external/holtburger/docs/quality-presets.md` (1B missed the file
  because it lives here, not in the app `docs/` — flag for wave 4B: quality.js:8
  references it by the app-relative path).

## 2. Verification state of the merged tree

Node suites, all green on the merge: scatter 103 · grass-scatter 91 ·
grass-shader 58 · sand 107 · sand-sparkle 62 · oracle 76 · families 49 ·
vfx_lifecycle 88 · trail_map 61 · vfx_flags 51 · texmerge 33 · **water 73** ·
legacy_safety 18 · lru_park_storm 36 — 0 failed. `lint-url-flags` exit 0
(447 documented; the 8 `--strict` undocumented readers are pre-existing).
Pre-existing failures unchanged: quality_preset 30/2 (`pom` pair), visual_z,
rust `corner_ring`.

Live (laptop, before the no-more-tests instruction):
- **Bare default** (`?nosw=1&nullRender=1`, in-world): zero console errors, no
  `window.__terrainGrass`/`__terrainSand`, spine present. ✓
- **Flagged-on** (`?terrainGrass=on&terrainSand=on&quality=high`, in-world at
  Holtburg spawn): all three providers registered `{enabled:true, errors:0}`,
  pools built and ticking (frames advancing, amortised slices ≤512), grass
  trail binding + stamp counting verified in the one full-render session
  (`stamps:4`, `trailBound:true`), teleport counters correct. **NOT verified
  live: blade revive** — `pool.nullSamples` kept climbing (oracle returning
  null; terrain bake vs pool-scan race not settled before sessions were cut),
  `live` stayed 0. The oracle path itself is proven by wave-0's live
  `oracleSelfTest()` and the 91-test scatter suite covers revive logic, but a
  live in-world `visibleBlades > 0` reading is still owed. Devils never
  spawned (Holtburg has no sand LBs — expected; needs a desert visit).

## 3. Real-GPU results (GTX-1070, muted `--mute-audio` + off-screen, before stop)

- Renderer asserted: `ANGLE (NVIDIA GeForce GTX 1070 ... Direct3D11)`.
- **Water scroll is ALIVE on real GPU at shipped defaults**: two frames seconds
  apart over open ocean (`@teleloc 0x01AE0001 100 100 6`, daylight, storm
  cleared via `__setWeather({is_storm:false})`) differ in **62.6 %** of water
  pixels (mean |Δ| 15.6 grey levels). The 07-02→07-31 world-wide freeze is
  dead in the wild, not just in the GPU harness.
- **Sheen ring (owed check a): NOT adjudicated.** The daylight shot shows two
  long bright streaks radiating toward the horizon
  (`/mnt/wbterminal2/holtburger-eyetest-2026-07-31/water_A.png`) — visually
  similar to the pre-fix "sheen with no distance fade" symptom, but plausibly
  sky/cloud light shafts. A `?waterEnv=off` A/B was booted but the session was
  stopped before a comparable daylight frame (the `=off` shot caught dusk —
  `water_noenv.png`). **Owner judgement needed** (§5, item W1).
- **Code 22 vs WaterRunning (owed check b): not done** (no known code-22 site
  was visited; numerically 22 already scrolls at the same rate as 16 in the
  GPU harness — faux22_scroll 44.10/33.36 %).
- Grass/sand real-GPU look: not attempted.
- Screenshots preserved in `/mnt/wbterminal2/holtburger-eyetest-2026-07-31/`.

## 4. Traps hit this session (so nobody re-pays them)

- **The laptop cannot host live client sessions.** A `quality=high` full-render
  SwiftShader session wedged Chrome's **shared GPU process**; after that, every
  tab's first GL call (even a 256² trail-map pass under `?nullRender=1`) blocked
  forever at 0 % CPU, and `Runtime.evaluate` timed out browser-wide until chrome
  was killed. Node suites + the 1070 are the only sanctioned test surfaces.
  (Owner, same session: "too heavy for dell", "no more tests".)
- **Account both-boot**: ACE "booting currently connected account in favor of
  new connection" reliably killed BOTH sessions when a reload re-logged within
  ~30 s. Navigate to `about:blank`, wait 30 s, then load the new URL — and
  confirm the `[LOGOUT]` line in `ACE_Log.txt` if it matters.
- **`@teleloc` sent at `__bootState==='ready'`+0 s can be silently swallowed**
  — the first teleport of a session did nothing; the same command 30 s later
  worked. Re-send once if the minimap LB hasn't changed.
- **Weather**: `__setWeatherProfile('sunny')` did NOT clear a running storm;
  `__setWeather({is_storm:false, ...})` (partial-state override with per-field
  lock) did, in ~10 s. `?skytime=accel` = full AC day in ~5 min — good for
  reaching daylight, but it also races *out* of daylight between A/B reboots.
- The wave-0 handoff's "stray CDP tab on an error page" no longer exists; the
  1070 was left with NO test chrome, no 9333/9224 listeners, tunnels closed,
  `WBGRASS` schtask deleted. `C:\Temp\launch-wls.bat` already carries
  `--mute-audio` (sound can never reach the box's user; never OS-mute the box).

## 5. Queued owner-run 1070 eye-test batch (one session, all of it)

All on the `:8767` BC7 arm with `&texBc7=on&terrainBc7=on&nosw=1`:
- **W1 water sheen**: open ocean `@teleloc 0x01AE0001 100 100 6`, daylight,
  storm cleared — does the 30→160 m sheen band read as a ring, and are the
  horizon-length bright streaks in `water_A.png` sheen (bug) or sky light
  shafts (fine)? Quick bisect: same view with `&waterEnv=off`.
- **W2 code 22**: any FauxWaterRunning site next to real WaterRunning — do they
  flow alike (22 must scroll, not bob)?
- **G1 grass** (`&terrainGrass=on&terrainTrail=on&terrainGrassStomp=on&quality=high`):
  `@telepoi` to a Lush/Grassland region — field gusts WITH the trees; stomp
  scar tracks the walk and springs back in ~4 s; terrain-boundary feathering
  reads as an edge, not 24 m squares; `__terrainGrass.stats().visibleBlades>0`,
  triangle delta ≈ visibleBlades×3, +1 draw call, light count unchanged
  (`renderer.info.autoReset=false`, diff cumulative).
- **S1 sand** (`&terrainSand=on&quality=high`): a desert — streamers slide
  *along* the wind and dissolve in sheets (not blink); sparkle doesn't slide
  against POM relief when strafing, vanishes looking straight down, absent on
  the water side of a shoreline, goes out under cloud shadow;
  `__terrainSand.stats()` devils live on sand LBs, `counters.noManager===0`.
  Also `quality=mid` (POM off) coherence + one `terrainSand=off` boot.

## 6. Resume here (Wave 2, per plan §7)

- **2A SNOW/ICE** (depends 1A ✓): spindrift via `terrain_scatter.js`, sparkle
  (terrain fragment, `glint.js` maths), persistent prints via `trail_map.js`
  (decide §8-risk-7 second hi-res RT), ice material.
- **2B VOLCANO** (depends wave 0 ✓): heat-haze `Effect` in the existing
  `EffectPass`, embers from `brazierEmbers.js`, crack glow (terrain fragment),
  obsidian material — owns `terrainHaze` (shared with sand later).
- **Both touch the terrain fragment shader — sequence it**: 2A sparkle first,
  then 2B crack glow rebased on it. 2B should study 1B's sparkle injection
  (`terrain_sand.js` + `test_terrain_sand_sparkle.mjs`) — same seam, same
  water-suite regression duty (`test_terrain_water.mjs` after every edit).
- Sand's two scatter-pool rough edges, for whoever touches the pool next: an
  `opts.uniforms` in-parameter (avoid the placeholder-then-repoint dance when
  building the material before the pool), and a per-pool seed salt for
  `ctx.rand(channel)` if two pools ever share a world cell.

## 7. Session housekeeping

serve.py :8765 and the :8767 BC7 serve left running; ACE alive. smoketest1 is
accessLevel 5 (can `@teleloc`/`@telepoi`). Laptop MCP chrome was killed
(GPU-process wedge) — a fresh one auto-launches on next use. The four wave-1
worktrees under `.claude/worktrees/` are merged and can be pruned.
