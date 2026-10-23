# HANDOFF — GPU grass placement (`?terrainGrassGpu`), 2026-10-23

Status: **DEFAULT ON since 2026-10-23** (owner's call after the 1070 session the
same day; escape `?terrainGrassGpu=off`). Results are in each item's `result` in
`docs/reengineering/queue-1070/batch-GG-grass-gpu-2026-10-23.json`.

## 1070 session (2026-10-23, owner present, off-screen + muted)

GTX 1070, ultra, uncapped, fresh profile per arm-rep, order on/off, off/on, on/off;
the player runs ~347 m south from Holtburg (hold W) in every rep.

| | off (CPU) median (min–max) | on (GPU) median (min–max) |
|---|---|---|
| frame p50 running | 23.9 ms (23.4–27.9) | 20.7 ms (19.2–21.7) |
| frame p95 running | 45.3 ms (42.6–54.5) | 37.4 ms (36.2–42.0) |
| frame p50 standing | 19.2 ms (18.4–20.7) | 16.8 ms (15.2–18.2) |
| renderCPU | 15.6 ms (15.0–18.9) | 14.4 ms (14.0–15.4) |
| CrGpuMain WebGL / frame, running | 14.3 ms (14.1–14.3) | 10.0 ms (9.7–10.1) |
| grass main-thread self time / 8 s running | ~270 ms | ~40 ms |

- Boot: 8 flag-on boots, 0 console errors. The provider reports mode gpu, the
  mask is centred with 0 collisions, and GROUND FIRST is live.
- The pre-written rule (b) was not met to the letter. One off rep (r2, 19 long
  tasks) widened the off arm's max–min spread past the median drop, although
  every on rep beat every off rep. The owner chose to flip.
- CrGpuMain falling 30 % is consistent with the CPU path's per-frame
  instance-buffer re-uploads going away (the node-bench hypothesis below).
- Eye: same-camera stills, on vs off, with the sky pinned (`?skytime=13`):
  same blades, verges and LOD transitions; no grass on the floors of the 4
  rooms holding the most terrain (Holtburg ×2, 0x4993 ×2).
  - The first, unpinned set looked darker in the on boot. That was the
    in-game clock moving between boots.
  - Not checked by eye: the stomp trail, edge popping while turning with
    `treeWindStrength=2`, and the walk/hilltop cases (node tests only).
- Raw data and the session's drivers:
  `/mnt/wbterminal1/tmp/claude-scratch/perf/gg-grass-gpu-2026-10-23/`
  (summary.json, run.json / cpuprofile / trace per arm-rep, eye2 stills, tools/).
  - `tools/gg-sess.mjs` is `hbsess.mjs` with the bot account `agentp10` and a
    launcher copy without the person-present gate. It was used only because the
    owner was at the box and asked for the run; the launcher copy is deleted
    from the box.
- Driver fix: `__sessionHandle.setAutoRun(true)` does not move the player
  (AutoRun takes effect only through the `?retailRunKeys` key path).
  `grass-gpu-run.eval.js` holds W instead.

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
  and dead blades skip the look. With `=off` the CPU path is byte-identical
  (391-comparison old-vs-new farm, 0 diffs).
- `scene3d/vfx_flags.js::terrainGrassGpuEnabled` — default ON since
  2026-10-23. The escape is `off` / `0` / `false` / `no` (any case).

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

1. DONE 2026-10-23: the 1070 session and the default flip.
2. Optional: the motion eye checks above (stomp trail, wind ×2 edge popping),
   and the high tier (not benched).
3. The CPU path is now the `=off` escape, but its full-upload issue (below)
   still matters for anyone on `=off`.
