# HANDOFF — holtburger-web 1070 look pass (2026-10-07/08): what shipped, and every idea still on the table

The owner ran a live graphics session on the GTX 1070 (on-screen Chrome, quality=ultra, 1920×1080,
Holtburg, the river, the coast). The goal was "autonomously improve the graphics while ensuring it stays
performant". The session closed with the owner's **"finally satisfied"**. Nothing below is in flight.
The tree was clean at `b7837994`, and the full JS gate passed 443/443 (capped) on that commit.

Every change ships default-on, has a `?flag=off` escape, and has a `docs/url-flags.md` row.
Everything in §3 is optional follow-up work. None of it is a known regression.

---

## 1. What shipped (nine commits, all pushed to `origin/master`)

| Commit | What the player sees | Flags (default) |
|---|---|---|
| `d65ae01e` | Clouds and aerial perspective reach the screen again. CSM casts real shadows (a `sampler2DShadow` compare). Swaying trees cast swaying shadows. The tone curve is now Neutral, followed by a grade. Glowing surfaces dim at night. Lush grass at high and ultra. | `swayShadow`, `adaptiveResBootGrace`, `tone` (neutral), `grade`, `lumNight`; grass promoted (`TERRAIN_VFX_PROMOTED.grass`) |
| `8496e1c4` | SAO ambient occlusion grounds the town (about 1 ms on the 1070; grass blades are marked so they get only 25 % of it). Bloom no longer washes out a low sun. | `ssao` (on at high/ultra); bloom 0.55 / 1.1 |
| `155a4395` | Tree crowns shade as soft volumes. Far hills keep their colour (`horizonFogNear` 0.62). The grass fade is wider, and each blade is lit with the ground normal it was planted on. | `canopySoften` (0.65) |
| `88896ebf` | Shaded walls keep retail's ambient fill. No grass grows inside buildings. Rivers ripple in the ground plane instead of streaking. | `retailFill` (4.5), `grassIndoorCull`, `waterReflect` (0.35); the swell stays on (`waterWave`, the owner's call) |
| `2a0d4db0` | Sunsets no longer white out: the fog probe stays 45° off the sun. The water glint stops at night and in shadow. The IBL renders from the viewer, so the moons reflect where they really are, in their own colours. Clouds are composited into the water's reflection cube. | `farFogSunAvoid` (45), `waterClouds` |
| `6753fd11` | The far ring is on by default, so hills keep their shape out to 1632 m. Three noise fields now sample the AC ground plane `(x, −z)` instead of `vWorldPos.xy`. Far ground-type borders blend toward the average of their corner types. | `farRing` (on), `farHarmonize` (1.0) |
| `b3742f01` | Distant slopes take warm light and cool shade. Farther ridges sink into a layered blue haze, a post pass over all geometry. | `paintLight` (1.3), `layerHaze` (0.4) |
| `ad50c924` | Grass is already there when you run up to it. The lines a scroll exposes are re-scattered first (edge-first), there is no hole under the player, the field is placed as a square with a round fade, and an interior cull re-checks only the region that changed. | (no new flag; pool options `edgeBudget`, `shape`/`fadeShape`) |
| `b7837994` | Seagulls, butterflies and birds fly their circles: retail's SetOmega hook (22) now rotates the whole object. Rabbits and chickens stop scurrying, because server movers animate at framerate × speed. | `animSceneryOmega` (on), `animSceneryOmegaHz` (15), `creatureGait` (on) |

Each commit message records the owner's quotes, the measurements, and which tests pin the change. The pinned checks
are L10–L18 in `tests/look_pass.test.mjs`, plus `tests/animated_scenery_omega.test.mjs` and
`tests/creature_gait_retail.test.mjs`.

**The wasm build is required.** `pkg/` is gitignored, so every checkout needs a release wasm build before the critters orbit; without it they
fall back to the old hover, silently. Build it with
`env PATH="/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build wasm-pack build --target web --out-dir pkg --release`
(about 5 min; kill rust-analyzer first; follow the ~/CLAUDE.md heavy-job rules).

## 2. Measured on the 1070 (ultra, 1080p)

- 46–51 fps outdoors after `d65ae01e` (shadows, grass and clouds on), and about 44.5 fps once AO was added.
- About 33 fps in Holtburg town (938 draws). The town is the frame-time floor to watch.
- About 65–70 fps at the coast at the end of the session.
- Far ring visible vs hidden: 51.4 / 54.4 vs 53.4 / 53.8 fps, i.e. noise (+10 draws, `policyOk`).
- Every later effect (fill, haze, paint light, harmonize, cloud cube at 1 Hz, edge-first grass) measured within noise.
  These were live A/Bs, not a multi-rep bench.

---

## 3. Remaining ideas (deferred, untried or declined)

Each entry gives the evidence and a suggested first step. Line numbers drift, so anchor by symbol.

### A. Lighting and post

1. **Shaded stone reads blue-teal.** The hemisphere fill is `HEMI_SKY = 0xb0c8ff` / `HEMI_GROUND`
   (`scene3d/lighting.js`). `retail_fill.js` now drives it to gain 4.5, so its cool sky colour dominates shade.
   Retail's ambient is near neutral (`uAcAmbColor` on the terrain).
   *Idea:* in `tickRetailFill`, tint the hemisphere's sky and ground colours from the retail ambient colour.
   It is one colour write per sky tick and adds no light.
   *Check:* the shaded wall vs the terrain beside it at noon and at dusk.
2. **The image is soft for about 5 minutes after login in town.** Adaptive render scale latches at 0.88. The console shows
   `[adaptive-res] oscillation latch #1 — raise to 1 failed`, from `scene3d/adaptive_render_scale.js`.
   `BOOT_GRACE_MS = 30_000` after `ready` is too short while town still streams.
   *Idea:* gate the grace on streaming having settled (no pending bakes or landblock loads for N s) rather than
   wall time, or don't arm the latch on a failure inside the boot window.
3. **Storm sky at low sun.** The takram clouds and light shafts show long diagonal streaks and comb-like cloud bases.
   This was seen near dusk (t ≈ 0.89) and at noon, in storm weather (`wxMap=nasa`). Left untouched.
   *Start:* A/B the clouds' shadow and shaft settings (shaft steps, shadow cascades, coverage) at that time of day and weather.
4. **Pre-dawn crimson sky.** Optional; the owner rated twilight "good as is".

### B. Moons and water

5. **takram's own moon (Earth's, from its astronomy) is drawn in Dereth's sky** beside the two AC moons
   (`scene3d/ac_moons.js`). A sky-only probe pre-dawn (takram moon at az −69°, el 36°) read max luminance
   0.00132 with the moon on vs 0.00031 with it off: faint but present.
   *Idea:* turn it off on the SkyMaterial (`atmosphere_sky.js`), or point it at an AC moon.
6. **The moon reflection on a clear night was never eye-tested.** Only a storm night was checked.
   The cube now renders from the viewer with the AC moon billboards in it.
7. **Water ideas:**
   - Per-pixel screen-space cloud reflection inside the terrain shader. Today the clouds are composited into the
     128 px cube at 1 Hz. This needs a sampler, and the terrain fragment shader is at 15 of 16.
     Merging the three CSM cascades into one `sampler2DArrayShadow` frees two.
   - Shoreline foam and treatment.
   - The swell (`waterWave`) also lifts the banks and ground under the water. The owner keeps the swell, so a fix must keep
     the motion and mask the vertical displacement off non-water or shallow vertices.
   - Tune the moon's glitter path.
8. **Snow, ice, sand, obsidian and mud speculars still catch the retail sun at night.** They multiply `uAcSunColor` but
   not `uSunGlint` (`terrain.js`: `uSnowSparkleStrength`, `iceSpec`, `sandSparkle`, `obsSpec`, `mudSpec`).
   Retail's sun sits at about 0.9° all night, which is the same cause as the water glint fixed in `2a0d4db0`.
   *Fix:* multiply each by `uSunGlint`, which is already pushed every light tick (`sunGlintMul` in `loop.js`).
   Not eye-tested at night.

### C. Distant hills

9. **Mountains past about 1.5 km still turn into flat pale fog silhouettes at the far-ring edge.** The drawn edge is
   1632 m and the fog band runs about 1012 → 1550 m.
   *Ideas:* height-aware edge fog (high ridges fog less, valleys more), a larger far radius (costs bake time and
   draws), or a cheap horizon skirt or impostor ring.
10. **Hard ground-type borders.** These are the 24 m retail TexMerge masks: a type exists only in the cells its vertices touch.
    - *Failed:* fractal border perturbation. At useful amplitude it breaks into rectangular blocks.
    - *Untried:*
      - "soft distant blend": past about 100 m, cross-fade to a fractal-modulated bilinear blend of the four corner types;
      - "cover borders with life": ground clutter scattered along type borders;
      - "blurred regional colour": far-ring-style low-res bakes, which cost the last sampler.
    - `farHarmonize` already softens the colour step from 120 m to 500 m.
11. **Declined. Recorded so nobody retries them blind:**
    - Far paint (patches and shrub clumps): the owner said OFF.
    - Kuwahara and anisotropic-Kuwahara post filters: about 2/255 of change on the already-smooth far terrain, so they were dropped.
12. **Trees and foliage:** crown look beyond `canopySoften`, and tree density on hills. These were on the owner's priority
    list and never started.

### D. Grass and critters

13. **Grass costs were never measured on the 1070.**
    - Edge-first re-scatters up to `edgeBudget` slots per frame while running: 1,536 at ultra (3 × slice 512). This is CPU work.
    - Square placement keeps about 27 % more blades live in the window's corners. They are faded but still vertex work on the GPU.
    - *Check:* fps and frame p95 during a straight run at ultra, with `edgeBudget` and the shape A/B'd.
14. **`creatureGait` also changes NPCs and wasps.** Humanoid NPC walks go from 1.2× to 1.0×, and wasps get faster.
    This was not eye-tested separately on the 1070.

### E. Build, infrastructure and docs

15. **`scripts/gen-modulepreload.mjs` misses `loop.js` and its subtree.** The exact cause is known.
    - In `scene3d/index.js`, the texCensus line `console.log("… from module import");` sits just above
      `import { tickPerFrame, … } from "./loop.js";`.
    - `STATIC_RE = /(?:\bfrom|\bimport)\s*["']([^"']+)["']/g` reads `import"` as an import, and its capture runs across the
      lines to the opening quote of `"./loop.js"`. That swallows the real import.
    - Not preloaded as a result: `loop.js`, `retail_fill.js`, `death_hold.js`, `ghost_rigs.js`, `client_event_dispatch.js`,
      `daygroup_weather.js`, plus anything only they import.
    - *Fix:* strip comments and strings before matching (or anchor `import` at a statement start), regenerate, and bump
      `NON_APP_PRELOADS` in `harness/test_build_shell.mjs`.
    - Expected gain: one fewer import-discovery round trip at cold boot, which matters on a slow link.
    - A second mis-tokenised span, inside a comment near "ticking but not … birthing", is harmless today.
16. **The `docs/url-flags.md` `terrainGrass` row is stale.** It still says "off on every quality tier", but
    `TERRAIN_VFX_PROMOTED.grass = true` (`scene3d/quality.js`) since `d65ae01e`. Fix the row.
17. **Fragment sampler budget.** ANGLE D3D11 on the 1070 reports `MAX_TEXTURE_IMAGE_UNITS = 16`, and the terrain uses 15.
    `--use-angle=vulkan` or `gl` may expose more, but players can't rely on that. Merging the CSM cascades is the
    realistic way to free slots (see 7).
18. **Far ring FARCRIT-3 checks (c) `@teleloc` crawl (mips + aniso) and (f) the ice-vista condition** were not separately
    scored when `farRing` flipped on (`docs/url-flags.md` §0 note).
19. **Wall Hook white plaques:** closed as retail- and ACE-faithful. Listed only so nobody reopens them by accident.

---

## 4. How this session drove the owner's screen (reuse it)

**Launching Chrome**
- The owner was at the box, so this used **on-screen** Chrome. That is only acceptable when the owner asks in the current
  conversation; otherwise stay off-screen or headless.
- Chrome was started inside the owner's interactive session by `schtasks /create … /it` + `/run`, pointing at a .bat on the box
  (`D:\Temp\hbgfx\launch-gfx.bat`).
- Flags: `--remote-debugging-port=9334 --remote-allow-origins=* --use-angle=d3d11 --ignore-gpu-blocklist
  --no-first-run --no-default-browser-check --disable-features=CalculateNativeWinOcclusion
  --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows
  --mute-audio --user-data-dir=C:\Temp\hbplay --start-fullscreen`.
- Kill it only by matching that `--user-data-dir`, never by image name.

**Connecting and logging in**
- From the laptop, CDP is at `127.0.0.1:9334` through the standing tunnel.
- Page URL: `nosw=1&renderer=3d&quality=ultra&clouds=on&wxMap=nasa&autoLogin=1&autoSpawn=first&camDebug=on`, plus the
  account params used by the existing `harness/*-1070.mjs` scripts. Credentials are deliberately not repeated here.

**Tools**

The tools are kept, credential-free, in `docs/2026-10-08-1070-look-pass-tools/`. They load playwright-core from
an npx-cache path hard-coded at the top of each file; change it if that cache is gone.

| Tool | What it does |
|---|---|
| `g.mjs` | `status` · `x '<js>'` · `eval file.js` · `snap out.jpg` · `fps N` · `console N`. It never closes the browser. `page.screenshot` returns black, so `snap` reads the canvas inside `renderer.render` on the default target. `fps` sets `renderer.info.autoReset = false` for honest draw counts. |
| `reload.mjs` | Edits URL params (`param` removes one, `param=value` sets one). It waits for ACE's `[LOGOUT]` line before re-navigating, otherwise the auto-login collides with the old session. |
| `ab2.mjs` | Captures two frames about 2 frames apart with a toggle between them, for a clean A/B. |
| `panel.js` | The temporary on-screen "Graphics lab" panel (time-of-day buttons and A/B toggles). Run it through `g.mjs eval` and remove it when done. |

**Handy live handles**
- Time of day: `__sessionHandle.setSkyTimeOverride(t)`. Dawn 0.21, Morning 0.33, Noon 0.5, Dusk 0.89, Night 0. It resets on reload.
  In art pitch, sunrise is at t ≈ 0.203 and sunset at t ≈ 0.907.
- Lighting and haze: `__retailFill.state()` / `.setGain(n)` · `__layerHaze` (`.strength`, `.params`, `.stats()`).
- Terrain and grass: `__terrainGrass.stats()` · `__farTerrainState()` · `__nightRampState()`.
- Critters: `__animSceneryOmegaHz(v)`.

## 5. Rules that still apply

- ~/CLAUDE.md: one heavy job at a time, everything inside `capped-build`, check `free -m` (≥ 2.5 GB available) first.
  Parallel agents run targeted tests only.
- On the 1070: `--mute-audio` always, never touch the owner's own Chrome, and drive the screen only when asked.
- Commit and push only when the owner asks.
