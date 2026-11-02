# Far forests — design (flight experience Phase 2, 2026-11-01)

**Status: built, DEFAULT ON** (`?farForest`, implied by the default-ON `?flightView`; `=off` escapes). Code: `scene3d/far_forest.js`. Data:
`dist/farforest/` from `bench/bake_far_forest.py`. Test: `tests/far_forest.test.mjs`. Survey behind it (lane B):
`/tmp/claude-1000/-home-wbterminal/a13d3330-b93b-41a5-87e7-15c954971b7f/scratchpad/lane-b-far-forests.md` (facts
with file:line; copy kept with the session notes).

## The problem

Trees exist only inside the object window (`?objRadius` 4 → ~0.8-1 km). From an aircraft the eye sees kilometres, so
the world looked bare past the window: the 1070 tours measured tree coverage of 1-2 % at 1-3 km even after the
object-window fix (`?objWindowRig`, which took 0-1 km from 13 % to 77 %). Retail never drew scenery past its 3x3
(`LScape`), and retail's own LOD data cannot help: 98.9 % of the tall placements degrade to NOTHING at ~200 m
(lane B §1.3). So a far tier is beyond-retail by design — "retail = correctness oracle, renderer = modern GPU":
WHAT is placed is exactly retail's placement; HOW it is drawn is modern.

## Decisions

| # | Decision | Why |
|---|---|---|
| F1 | **Placements = the shipped retail scenery bake**, repacked offline (`bake_far_forest.py`): 20-byte records (x, y, z, scale, model, yaw) per 8x8-landblock region, 1,687,322 placements of the 84 far-visible models (mean height ≥ 4 m, plus the swaying-tree setups 0x02000493/94 whose census AABB is empty), 714 regions, 34 MB on disk, ~25-50 KB per region | Identical to what the near tier draws (the same JSONL); no runtime port of the bake; region files stream like terrain |
| F2 | **Impostors baked at runtime in the browser**, through the near tier's own decode (`fetchBuildingPlacement`, the material cache's textures), **UNLIT** (a basic material over each surface's map), 8 azimuths per model into one atlas (16 cells per row, 128 px cells) | The look comes from the real model; unlit capture compiles no lit program variants (FXC is 0.5-1.7 s per program on the 1070) and lighting is applied live — the far ring's "bake albedo, light live" rule |
| F3 | **One instanced draw** of camera-facing cards (cylindrical: trunks stay vertical), the view picked per instance from the camera's azimuth in the tree's own frame, alpha-tested, depth-writing, the shared range fog | ~100k instances is one draw; no per-instance JS per frame (the 1070 is main-thread bound) |
| F4 | **Handover = the exact complement of the near trees** on the presence field (`lb_presence.js` R) on the same 4x4 Bayer dither, plus the object window's DEFERRED hide while far forests are on | A pixel at the window edge is drawn by one tier; a near tree never blinks out before its impostor has faded in |
| F5 | **Range by altitude** (`altitude_policy.js farForestRangeM`): 4.5 km low, 8 km by 2.5 km up, a dithered fade over the last 18 % | Trees past 8 km are below a pixel; the fog / aerial perspective carries the rest |
| F6 | Undriven presence cells read objects ABSENT (R 0) | Lane B's review: cells beyond the driven 12 LB must not hide impostors |
| F7 | From altitude, forests also read through the **world tier's canopy tint** (per-landblock tall-tree density) | Below a pixel per tree, density is the signal |

## Budgets (measured / to measure on the 1070)

- Draws: +1. Instances: up to 180k (49 regions × ~2k, worst windows ~100k at 3 km per lane B).
- Atlas: 2048 × 4096 RGBA8 with mips ≈ 43 MiB (64 models × 8 views × 128 px). Placements in memory: 20 B × instances.
- Bake: one model at a time off the critical path (fetch → build → 8 renders); the impostors appear model by model in
  the first seconds of a flight.
- Fragment cost and frame time: measured in the arm-E tour (HANDOFF.md).

## Measured and fixed after the first tours (1070, arms E-H)

- **Instance-list churn**: arm E rebuilt the instance list 1,144 times in 160 s, once for every region crossing the
  disc edge, with up to 4 MB per upload. Now regions enter the list with an 800 m margin; the vertex shader still
  culls by the exact range. The list rebuilds only when the set of LOADED regions changes, at most every 1.5 s.
  Arm F: 80 rebuilds in 160 s. Arm G, 37 km with altitude changes: 251.
- **A 1.7 s frame at take-off**: the impostor bake drew its first model with MeshBasicMaterial, a synchronous program
  link (FXC). Also, disposing each model's materials dropped three's last reference to the program, so it could link
  again for the next model. Now:
  - both bake variants (map / no map) are linked off the frame with `compileAsync`, with the atlas target current so
    the program keys match;
  - two dummy materials keep the programs referenced for the session;
  - the card program itself is linked off the frame, and the mesh stays hidden until it is ready.
- **Coverage, read properly**: the residency log's tree coverage now counts only landblocks the retail census has trees
  in (`world_trees.u8`). Arm G read 0 % at 1–3 km over the southern desert, and the denominator was the problem, not
  the forest.
- **Instances at the cap at altitude**: 178k of `MAX_INSTANCES` 180k at an 8 km range. The list is nearest-first, so
  the cap trims the farthest regions (beyond ~5 km), where the canopy tint carries the forest.

## Open / next

- Normals: the impostor is lit with a mostly-up normal; a normal-map view atlas would match the near trees' side
  lighting better at the handover (~1 km).
- ~~Two-view blending~~ DONE (2026-11-02): the vertex stage passes the two nearest azimuth views and the fraction
  between them, and the fragment stage fetches both and picks per pixel on an ordered dither, offset from the presence
  dither so the patterns don't correlate. A banked turn or an orbit no longer flips a card 45° at once. The cost is
  two atlas fetches per card fragment.
- BC7 pack of the atlas in the dist (from the same baker) if the runtime bake shows up in boot time.
- The near-tree side of the crossfade (`?objFade`) needs statics-only material objects (see url-flags `objFade`).

## Fixed 2026-11-02: grey impostor cards (the film shoot found it)

An atlas dump on the 1070 after a login in the desert (scratchpad `dump-atlas.mjs`: the atlas render target read
back through a quad) showed 60 of the 64 models baked as flat grey silhouettes; only models whose surfaces the near
tier had already decoded (the cacti there) were textured. `_buildModelGroup` passed the `surfacePixelsFetcher`
FACTORY (bake_worker_client.js) to `MaterialCache.get`, so every cache miss "fetched" a function and got the grey
fallback material. The forests around Holtburg looked right only because a Holtburg login had already loaded those
tree surfaces. Now the bake takes the fetcher instance (`surfacePixelsFetcher(wasm)`), and a part whose surface still
falls back is left out of the bake (`window.__farForest().fallbackParts` counts them) instead of becoming a grey
card. `tests/far_forest.test.mjs` FF-SRC pins both. To verify on the 1070: log in away from Holtburg (the desert),
wait ~45 s for the idle prefetch, dump the atlas.
