# HANDOFF — GPU grass placement (`?terrainGrassGpu`), 2026-10-23

Status: **built, reviewed, fixed, smoke-PASSED on SwiftShader. Flag ships OFF.**
The default flip waits on the owner's 1070 session (queue
`docs/reengineering/queue-1070/batch-GG-grass-gpu-2026-10-23.json`).

Design contract: `docs/2026-10-23-grass-gpu-placement.md`. Flag row:
`docs/url-flags.md` → `terrainGrassGpu`.

## What it is

The question was whether to switch grass to "batched scans per landblock".
The answer here: keep the camera-scoped GRASS LOD rings, keep per-landblock
DATA, and move PLACEMENT into the vertex shader.

- `scene3d/terrain_field_gpu.js` — per-landblock terrain textures
  (144×144 RGBA32F, 16×16 toroidal landblock slots, window radius 7), and a JS
  mirror (`sampleMirror`).
- `scene3d/grass_interior_mask.js` — the EnvCell interior mask on the GPU.
  12 m buckets of up to 48 ids, 64×64 slots, 2048 box rows. The write is CENTRED
  on the player (`setGpuCenter` before `sync`), so there is no fold, and it is
  ordered GROUND FIRST (the provider passes the terrain oracle), then nearest
  first. CPU mode (the default with no THREE) allocates nothing.
- `scene3d/grass_gpu_place.js` — the placement GLSL
  (`hbGrassCell` → `hbGrassPlaceCell` / `hbGrassDead`), a bit-exact JS mirror,
  and the 8×8 tile cull with live blade-reach margins.
- `scene3d/terrain_grass.js` — the GPU build. Each ring is one plain Mesh over
  an `InstancedBufferGeometry` with no instanced attributes, and all rings share
  one program. There is a view early-out (fade / dissolve == 0 → never placed),
  and dead blades skip the look. With the flag OFF the CPU path is byte-identical
  (391-comparison old-vs-new farm, 0 diffs).
- `scene3d/vfx_flags.js::terrainGrassGpuEnabled` — STRICT `=== "on"`, default
  false.

## Evidence (laptop; no live client sessions)

- Browser readback smoke (`capped-build node harness/glsl_smoke/grass_gpu_smoke.mjs`,
  ANGLE SwiftShader), run on the FIXED tree, PASSED:
  - 12 readbacks: worst run 0.11 %, worst ring 0.23 % (3 flips in 3175 live
    blades at 0x4993).
  - Interior arm: GPU kills equal the mirror's within 2 blades, and bucket ids
    17–48 are exercised (181 kills).
  - Frame compare: 0.18 % of pixels.
  - All 6 programs linked; 0 console or GL errors.
  - It wrote `harness/glsl_smoke/grass_gpu_smoke.stamp.json`.
- GLSL lock: `test_terrain_grass_gpu.mjs` G7 fails if the shipped GLSL's sha256
  (`harness/glsl_smoke/grass_gpu_fingerprint.mjs`) differs from the stamp. **Any
  GLSL edit (including the shared CPU grass snippets) needs the smoke re-run.**
  The JS texel layout is not hashed (header of the fingerprint module), so
  re-run the smoke after layout edits too.
- Node tests: test_terrain_field_gpu 118, test_grass_interior_mask_gpu 147,
  test_grass_gpu_place 167, test_terrain_grass_gpu 144, all 0 failed (tier 5
  of `harness/run-js-headless.mjs`).
- Node bench (`harness/bench_grass_cpu_vs_gpu.mjs`): the grass main-thread cost
  while running is ~0.07 ms/frame (GPU) vs 0.37–0.57 ms (CPU), and a teleport
  costs a 4.6–11.5 ms GPU build vs a 195–294 ms CPU first fill. The vertex-shader
  cost is NOT measured; only the 1070 can.

## Review → fixes (adversarial, 2 rounds)

All 13 round-1 findings were confirmed and fixed:

- MAJOR: the mask was not player-centred. A fold every 768 m and Map-order slot
  races lost 11–100 % of indoor ground on real walks. Now it is centred, with
  0 collisions by construction.
- 1024 rows → 2048, and 16 ids per bucket → 48.
- The ~45 % of instances that fade or dissolve to zero no longer run placement.
- The cull margins were a fixed 2 m and too small under `setLod` / wind ≥ 2.
  They now track the live look.
- Per-ring smoke gates, a dense-housing spot and an interior arm were added,
  plus the GLSL lock.

Round 2 (fix verification) found one more major issue: GROUND FIRST was not
wired. From the 0xF830 valley, distance-only order dropped 80 of 250 indoor
ground points of the 0xF92F hilltop bucket at the DEFAULT reach. It is now wired
(`terrain_grass.js`, the same oracle getter as the field), with test 8b(f).

## Known limits (documented, not fixed)

- If URL flags push the outer ring past 344 m (e.g.
  `?terrainGrassRadius=48&terrainGrassReach=8`), the far band is not
  interior-culled on the GPU, and the mask rewrites every 16 m.
- With the flag off, `stats().indoorCull` carries zero-valued `gpu*` keys and
  `config.gpu` / `mode` are new. No consumer reads them.

## Separate finding (CPU path, independent of the flag)

Hypothesis from the node bench: running east/west, the CPU grass path
re-uploads WHOLE instance buffers every frame, ~6.7 MB/frame at ultra. An
x-scroll touches more than `maxUpdateRuns = 4` runs and falls back to a full
upload. GG-BENCH's `off` arm can confirm this in the trace. If confirmed, raise
the run cap or upload per row band. This matters as long as the CPU path is
the default.

## Next

1. The owner's 1070 session: GG-BOOT → GG-BENCH (3 reps, rotated) → GG-EYE.
   The decision rule is in the queue file and was written before the run.
2. If it passes: flip the default in `vfx_flags.js::terrainGrassGpuEnabled`
   (keep `=off` as the escape), and update the url-flags row and this doc.
3. Driver for the runs: `scripts/perf-worker/grass-gpu-run.eval.js`
   (stand + AutoRun south from Holtburg; never run yet).
